// R21 — webhook egress: idempotent emit, verifiable signature, backoff to dead
// letter, replay, https-only, disabled-module no-op.

import assert from 'node:assert/strict'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { disableModule } from '@bygelo/roundrobin-kernel'
import { COURT_DECLARATION } from '../src/app.ts'
import { emitWebhook } from '../src/module/webhook/contract.ts'
import {
  MAX_ATTEMPT_COUNT,
  backoffMs,
  processWebhookDelivery,
  verifyWebhookSignature,
} from '../src/module/webhook/service.ts'
import {
  ADDRESS_NOT_ALLOWED_SENTENCE,
  ADDRESS_REFUSED_PREFIX,
  WebhookAddressError,
  assertWebhookTarget,
  classifyAddress,
  isPrivateAllowed,
  type LookupFunction,
} from '../src/module/webhook/address.ts'
import { TEST_DATABASE_URL, createTestVenue, type TestVenue } from './helper.ts'

// The egress tests use a local receiver on 127.0.0.1, which the SSRF guard
// refuses unless the development allowance is on. Node's test runner gives
// each file its own process, so this does not leak into other files.
process.env['WEBHOOK_ALLOW_PRIVATE'] = 'true'

type Received = { path: string; header: IncomingHttpHeaders; body: string }

describe('webhook address guard (SSRF)', () => {
  const strict: NodeJS.ProcessEnv = {}
  const publicLookup: LookupFunction = async () => [{ address: '93.184.216.34', family: 4 }]
  const refusal = async (url: string, option: Parameters<typeof assertWebhookTarget>[1]) => {
    try {
      await assertWebhookTarget(url, option)
    } catch (error) {
      assert.ok(error instanceof WebhookAddressError, String(error))
      return error
    }
    assert.fail(`${url} should have been refused`)
  }

  it('classifies private, loopback, link-local, CGNAT, multicast, and IPv6 equivalents', () => {
    for (const address of [
      '127.0.0.1', '10.0.0.5', '172.16.4.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1',
      '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1%eth0', 'ff02::1',
      '::ffff:10.0.0.1', '::ffff:7f00:1', '64:ff9b::a9fe:a9fe', '2002:a00:1::1',
    ]) {
      assert.notEqual(classifyAddress(address), null, `${address} must not be public`)
    }
    for (const address of ['93.184.216.34', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '::ffff:8.8.8.8']) {
      assert.equal(classifyAddress(address), null, `${address} is public`)
    }
  })

  it('refuses 127.0.0.1, 10.0.0.5, 169.254.169.254, and [::1] with one plain sentence', async () => {
    for (const url of ['https://127.0.0.1/hook', 'https://10.0.0.5/hook', 'https://169.254.169.254/latest/meta-data', 'https://[::1]/hook', 'https://[::ffff:192.168.0.1]/']) {
      const error = await refusal(url, { env: strict, lookup: publicLookup })
      assert.equal(error.reason_code, 'private_address', url)
      assert.equal(error.message, ADDRESS_NOT_ALLOWED_SENTENCE)
    }
  })

  it('refuses a hostname that resolves to a private address, even when one answer is public', async () => {
    const privateLookup: LookupFunction = async () => [{ address: '10.1.2.3', family: 4 }]
    assert.equal((await refusal('https://hooks.internal.example/x', { env: strict, lookup: privateLookup })).reason_code, 'private_address')
    const mixed: LookupFunction = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: 'fd00::5', family: 6 },
    ]
    assert.equal((await refusal('https://hooks.example.com/x', { env: strict, lookup: mixed })).reason_code, 'private_address')
    const missing: LookupFunction = async () => {
      throw new Error('ENOTFOUND')
    }
    const unresolved = await refusal('https://nope.example/x', { env: strict, lookup: missing })
    assert.equal(unresolved.reason_code, 'unresolved')
    assert.equal(unresolved.is_retryable, true)
  })

  it('refuses a non-standard port such as 22, allows a public address on 443', async () => {
    assert.equal((await refusal('https://hooks.example.com:22/x', { env: strict, lookup: publicLookup })).reason_code, 'port')
    assert.equal(await assertWebhookTarget('https://hooks.example.com/x', { env: strict, lookup: publicLookup }), 'https://hooks.example.com/x')
    assert.equal(await assertWebhookTarget('https://hooks.example.com:443/x', { env: strict, lookup: publicLookup }), 'https://hooks.example.com/x')
  })

  it('the development allowance lets a local receiver through; production ignores it', async () => {
    const dev: NodeJS.ProcessEnv = { WEBHOOK_ALLOW_PRIVATE: 'true' }
    assert.equal(isPrivateAllowed(dev), true)
    assert.equal(await assertWebhookTarget('http://127.0.0.1:4567/ok', { env: dev }), 'http://127.0.0.1:4567/ok')

    const production: NodeJS.ProcessEnv = { WEBHOOK_ALLOW_PRIVATE: 'true', NODE_ENV: 'production' }
    assert.equal(isPrivateAllowed(production), false)
    assert.equal((await refusal('https://127.0.0.1/hook', { env: production })).reason_code, 'private_address')
    assert.equal((await refusal('http://127.0.0.1:4567/ok', { env: production })).reason_code, 'protocol')
  })
})

describe('webhook pure rules', () => {
  it('backs off 1m x 2^n and caps at one hour', () => {
    assert.deepEqual([1, 2, 3, 4, 5].map(backoffMs), [60_000, 120_000, 240_000, 480_000, 960_000])
    assert.equal(backoffMs(20), 3_600_000)
  })

  it('refuses a tampered body or an old timestamp', () => {
    const now = new Date('2027-01-01T00:00:00Z')
    const t = Math.floor(now.getTime() / 1000)
    const body = '{"a":1}'
    const { createHmac } = require_crypto()
    const header = `t=${t},v1=${createHmac('sha256', 'whsec_x').update(`${t}.${body}`).digest('hex')}`
    assert.equal(verifyWebhookSignature('whsec_x', header, body, { now }), true)
    assert.equal(verifyWebhookSignature('whsec_x', header, '{"a":2}', { now }), false)
    assert.equal(verifyWebhookSignature('whsec_x', header, body, { now: new Date(now.getTime() + 3_600_000) }), false)
  })
})

function require_crypto() {
  return process.getBuiltinModule('node:crypto')
}

describe('webhook egress', { skip: !TEST_DATABASE_URL }, () => {
  let venue: TestVenue
  let server: Server
  let base_url: string
  const received: Received[] = []
  let fail_status = 500

  before(async () => {
    venue = await createTestVenue('webhook')
    server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => (body += chunk))
      request.on('end', () => {
        received.push({ path: request.url ?? '', header: request.headers, body })
        if (request.url === '/redirect') {
          response.statusCode = 302
          response.setHeader('location', `${base_url}/redirected`)
        } else {
          response.statusCode = request.url === '/fail' ? fail_status : 204
        }
        response.end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base_url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  after(async () => {
    await new Promise((resolve) => server.close(resolve))
    await venue.close()
  })

  const json = async <T>(response: Response) => (await response.json()) as T

  let ok_secret = ''
  let ok_subscription_id = ''
  let fail_subscription_id = ''

  it('creates a subscription and shows the secret exactly once', async () => {
    const response = await venue.request('/api/v1/webhook/subscription', {
      method: 'POST',
      body: JSON.stringify({ url: `${base_url}/ok`, event_code: ['booking.confirmed'], description: 'Accounting' }),
    })
    assert.equal(response.status, 201)
    const body = await json<{ subscription: { webhook_subscription_id: string; secret_prefix: string }; secret: string }>(response)
    assert.match(body.secret, /^whsec_[A-Za-z0-9_-]{43}$/)
    assert.ok(body.secret.startsWith(body.subscription.secret_prefix))
    ok_secret = body.secret
    ok_subscription_id = body.subscription.webhook_subscription_id

    const list = await venue.request('/api/v1/webhook/subscription')
    const text = await list.text()
    assert.equal(list.status, 200)
    assert.ok(!text.includes(ok_secret), 'the list must never carry the secret')
    assert.ok(!text.includes('secret_envelope'))

    const stored = await venue.asTenant((tenant) =>
      tenant.query<{ secret_envelope: string }[]>`
        SELECT secret_envelope FROM webhook_subscription WHERE organization_id = ${venue.organization_id}`,
    )
    assert.ok(!stored[0]!.secret_envelope.includes(ok_secret.slice(6)), 'stored sealed, not raw')
  })

  it('refuses a plain-http URL that is not localhost', async () => {
    const response = await venue.request('/api/v1/webhook/subscription', {
      method: 'POST',
      body: JSON.stringify({ url: 'http://example.com/hook', event_code: ['booking.confirmed'] }),
    })
    assert.equal(response.status, 400)
    assert.match((await json<{ error: string }>(response)).error, /https/)

    const unknown = await venue.request('/api/v1/webhook/subscription', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://example.com/hook', event_code: ['booking.exploded'] }),
    })
    assert.equal(unknown.status, 400)
  })

  it('emits the same event twice and delivers it once, signed and verifiable', async () => {
    const input = { event_code: 'booking.confirmed' as const, subject_code: 'BK-1001', payload: { booking_code: 'BK-1001' } }
    await venue.asTenant((tenant) => emitWebhook(tenant, input))
    await venue.asTenant((tenant) => emitWebhook(tenant, input))

    const [count] = await venue.asTenant((tenant) =>
      tenant.query<{ event_count: number; delivery_count: number }[]>`
        SELECT (SELECT count(*)::int FROM webhook_event WHERE organization_id = ${venue.organization_id}) AS event_count,
               (SELECT count(*)::int FROM webhook_delivery WHERE organization_id = ${venue.organization_id}) AS delivery_count`,
    )
    assert.deepEqual(count, { event_count: 1, delivery_count: 1 })

    const now = new Date()
    const result = await venue.asTenant((tenant) => processWebhookDelivery(tenant, { now }))
    assert.equal(result.delivered_count, 1)
    const hit = received.filter((one) => one.path === '/ok')
    assert.equal(hit.length, 1)
    const [one] = hit
    assert.equal(one!.header['content-type'], 'application/json')
    assert.ok(verifyWebhookSignature(ok_secret, one!.header['x-court-signature'] as string, one!.body, { now }))
    const envelope = JSON.parse(one!.body) as Record<string, unknown>
    assert.equal(envelope['specversion'], '1.0')
    assert.equal(envelope['type'], 'booking.confirmed')
    assert.equal(envelope['subject'], 'BK-1001')
    assert.equal(envelope['id'], one!.header['x-court-event-id'])
    assert.equal(envelope['source'], `/court/${venue.organization_code}`)
    assert.deepEqual(envelope['data'], { booking_code: 'BK-1001' })

    const again = await venue.asTenant((tenant) => processWebhookDelivery(tenant, { now }))
    assert.equal(again.claimed_count, 0, 'a delivered event is not sent again')
  })

  it('retries a failing subscriber with backoff, then dead-letters after six attempts, then replays', async () => {
    const created = await venue.request('/api/v1/webhook/subscription', {
      method: 'POST',
      body: JSON.stringify({ url: `${base_url}/fail`, event_code: ['booking.cancelled'] }),
    })
    fail_subscription_id = (await json<{ subscription: { webhook_subscription_id: string } }>(created)).subscription
      .webhook_subscription_id
    const pinned = new Date('2030-01-01T00:00:00Z')
    await venue.asTenant((tenant) =>
      emitWebhook(tenant, { event_code: 'booking.cancelled', subject_code: 'BK-2002', payload: { booking_code: 'BK-2002' } }),
    )
    // Let the pinned clock own next_attempt_at from here on.
    await venue.asTenant((tenant) => tenant.query`
      UPDATE webhook_delivery SET next_attempt_at = ${pinned}
      WHERE organization_id = ${venue.organization_id} AND status = 'pending'`)

    let clock = pinned
    for (let attempt = 1; attempt <= MAX_ATTEMPT_COUNT; attempt += 1) {
      const result = await venue.asTenant((tenant) => processWebhookDelivery(tenant, { now: clock }))
      assert.equal(result.claimed_count, 1, `attempt ${attempt} claims the delivery`)
      if (attempt < MAX_ATTEMPT_COUNT) {
        const early = await venue.asTenant((tenant) =>
          processWebhookDelivery(tenant, { now: new Date(clock.getTime() + backoffMs(attempt) - 1000) }),
        )
        assert.equal(early.claimed_count, 0, 'backoff is honoured')
        clock = new Date(clock.getTime() + backoffMs(attempt))
      }
    }
    const failed = received.filter((one) => one.path === '/fail')
    assert.equal(failed.length, MAX_ATTEMPT_COUNT)
    assert.equal(new Set(failed.map((one) => one.header['x-court-event-id'])).size, 1, 'one event id across retries')
    assert.equal(new Set(failed.map((one) => one.body)).size, 1, 'same bytes every attempt (deterministic envelope)')
    assert.deepEqual(failed.map((one) => one.header['x-court-delivery-attempt']), ['1', '2', '3', '4', '5', '6'])

    const dead = await json<{ delivery: { webhook_delivery_id: string; attempt_count: number; last_status_code: number }[] }>(
      await venue.request('/api/v1/webhook/delivery?status=dead'),
    )
    assert.equal(dead.delivery.length, 1)
    assert.equal(dead.delivery[0]!.attempt_count, 6)
    assert.equal(dead.delivery[0]!.last_status_code, 500)
    const beyond = await venue.asTenant((tenant) => processWebhookDelivery(tenant, { now: new Date(clock.getTime() + 86_400_000) }))
    assert.equal(beyond.claimed_count, 0, 'dead never retries on its own')

    const replay = await venue.request(`/api/v1/webhook/delivery/${dead.delivery[0]!.webhook_delivery_id}/replay`, { method: 'POST' })
    assert.equal(replay.status, 200)
    assert.equal((await json<{ delivery: { status: string } }>(replay)).delivery.status, 'pending')
    const twice = await venue.request(`/api/v1/webhook/delivery/${dead.delivery[0]!.webhook_delivery_id}/replay`, { method: 'POST' })
    assert.equal(twice.status, 409)

    fail_status = 200
    const process = await venue.request('/api/v1/webhook/process', { method: 'POST' })
    assert.equal((await json<{ result: { delivered_count: number } }>(process)).result.delivered_count, 1)
    const last = received.filter((one) => one.path === '/fail').at(-1)!
    assert.equal(last.header['x-court-event-id'], failed[0]!.header['x-court-event-id'], 'a replay is detectably the same event')
  })

  it('rotates the secret and signs with the new one', async () => {
    const response = await venue.request(`/api/v1/webhook/subscription/${ok_subscription_id}/rotate-secret`, { method: 'POST' })
    const { secret } = await json<{ secret: string }>(response)
    assert.notEqual(secret, ok_secret)
    const ping = await venue.request('/api/v1/webhook/test', {
      method: 'POST',
      body: JSON.stringify({ webhook_subscription_id: ok_subscription_id }),
    })
    const { delivery } = await json<{ delivery: { status: string; last_status_code: number } }>(ping)
    assert.equal(delivery.status, 'delivered')
    const hit = received.filter((one) => one.path === '/ok').at(-1)!
    assert.equal(JSON.parse(hit.body).type, 'webhook.ping')
    assert.ok(verifyWebhookSignature(secret, hit.header['x-court-signature'] as string, hit.body))
    assert.ok(!verifyWebhookSignature(ok_secret, hit.header['x-court-signature'] as string, hit.body))
  })

  it('refuses a private address at create and update when the allowance is off', async () => {
    process.env['WEBHOOK_ALLOW_PRIVATE'] = 'false'
    try {
      const created = await venue.request('/api/v1/webhook/subscription', {
        method: 'POST',
        body: JSON.stringify({ url: 'https://169.254.169.254/latest/meta-data', event_code: ['booking.confirmed'] }),
      })
      assert.equal(created.status, 400)
      assert.equal((await json<{ error: string }>(created)).error, ADDRESS_NOT_ALLOWED_SENTENCE)

      const updated = await venue.request(`/api/v1/webhook/subscription/${ok_subscription_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ url: 'https://10.0.0.5/hook' }),
      })
      assert.equal(updated.status, 400)
      const [row] = await venue.asTenant((tenant) =>
        tenant.query<{ url: string }[]>`
          SELECT url FROM webhook_subscription
          WHERE organization_id = ${venue.organization_id} AND webhook_subscription_id = ${ok_subscription_id}`,
      )
      assert.ok(row!.url.startsWith(base_url), 'a refused update writes nothing')
    } finally {
      process.env['WEBHOOK_ALLOW_PRIVATE'] = 'true'
    }
  })

  it('does not follow a redirect: a 3xx is a failed attempt', async () => {
    await venue.request('/api/v1/webhook/subscription', {
      method: 'POST',
      body: JSON.stringify({ url: `${base_url}/redirect`, event_code: ['payment.recorded'] }),
    })
    await venue.asTenant((tenant) =>
      emitWebhook(tenant, { event_code: 'payment.recorded', subject_code: 'PAY-1', payload: {} }),
    )
    const result = await venue.asTenant((tenant) => processWebhookDelivery(tenant))
    assert.ok(result.failed_count >= 1)
    assert.equal(received.filter((one) => one.path === '/redirected').length, 0, 'the Location was never requested')
    const failed = await json<{ delivery: { event_code: string; last_status_code: number; last_error: string }[] }>(
      await venue.request('/api/v1/webhook/delivery?status=failed'),
    )
    const row = failed.delivery.find((one) => one.event_code === 'payment.recorded')!
    assert.equal(row.last_status_code, 302)
    assert.match(row.last_error, /redirect/)
  })

  it('at delivery, an address that is now private fails without sending and pauses the subscription', async () => {
    const created = await venue.request('/api/v1/webhook/subscription', {
      method: 'POST',
      body: JSON.stringify({ url: `${base_url}/now-private`, event_code: ['arrival.checked_in'] }),
    })
    const subscription_id = (await json<{ subscription: { webhook_subscription_id: string } }>(created)).subscription
      .webhook_subscription_id
    await venue.asTenant((tenant) =>
      emitWebhook(tenant, { event_code: 'arrival.checked_in', subject_code: 'ARR-1', payload: {} }),
    )
    // The allowance is gone at delivery time (as in production).
    const result = await venue.asTenant((tenant) => processWebhookDelivery(tenant, { env: {} }))
    assert.ok(result.failed_count >= 1)
    assert.equal(received.filter((one) => one.path === '/now-private').length, 0, 'nothing was sent')

    const list = await json<{ subscription: { webhook_subscription_id: string; is_active: boolean; paused_reason: string | null }[] }>(
      await venue.request('/api/v1/webhook/subscription'),
    )
    const paused = list.subscription.find((one) => one.webhook_subscription_id === subscription_id)!
    assert.equal(paused.is_active, false)
    assert.equal(paused.paused_reason, 'address_not_allowed')
    const [delivery] = await venue.asTenant((tenant) =>
      tenant.query<{ status: string; last_error: string }[]>`
        SELECT d.status, d.last_error FROM webhook_delivery d
        WHERE d.organization_id = ${venue.organization_id} AND d.webhook_subscription_id = ${subscription_id}`,
    )
    assert.equal(delivery!.status, 'failed')
    assert.ok(delivery!.last_error.startsWith(ADDRESS_REFUSED_PREFIX))

    const again = await venue.asTenant((tenant) => processWebhookDelivery(tenant, { env: {} }))
    assert.equal(again.claimed_count, 0, 'a paused subscription is not retried')

    process.env['WEBHOOK_ALLOW_PRIVATE'] = 'false'
    try {
      const resume = await venue.request(`/api/v1/webhook/subscription/${subscription_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_active: true }),
      })
      assert.equal(resume.status, 400, 'resuming re-checks the address')
    } finally {
      process.env['WEBHOOK_ALLOW_PRIVATE'] = 'true'
    }
    // Delete it so later tests that count claims are not affected.
    await venue.request(`/api/v1/webhook/subscription/${subscription_id}`, { method: 'DELETE' })
  })

  it('does not leak one venue’s subscriptions to another', async () => {
    const other = await createTestVenue('webhook-other')
    try {
      const list = await json<{ subscription: unknown[] }>(await other.request('/api/v1/webhook/subscription'))
      assert.equal(list.subscription.length, 0)
      const response = await other.request(`/api/v1/webhook/subscription/${fail_subscription_id}/rotate-secret`, { method: 'POST' })
      assert.equal(response.status, 404)
    } finally {
      await other.close()
    }
  })

  it('is a silent no-op when the webhook module is disabled, and its routes 404', async () => {
    await venue.asTenant((tenant) => disableModule(tenant, 'webhook', COURT_DECLARATION))
    await venue.asTenant((tenant) =>
      emitWebhook(tenant, { event_code: 'booking.confirmed', subject_code: 'BK-3003', payload: {} }),
    )
    const [row] = await venue.asTenant((tenant) =>
      tenant.query<{ event_count: number }[]>`
        SELECT count(*)::int AS event_count FROM webhook_event
        WHERE organization_id = ${venue.organization_id} AND subject_code = 'BK-3003'`,
    )
    assert.equal(row!.event_count, 0)
    const response = await venue.request('/api/v1/webhook/subscription')
    assert.equal(response.status, 404)
  })
})
