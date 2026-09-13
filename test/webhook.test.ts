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
import { TEST_DATABASE_URL, createTestVenue, type TestVenue } from './helper.ts'

type Received = { path: string; header: IncomingHttpHeaders; body: string }

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
        response.statusCode = request.url === '/fail' ? fail_status : 204
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
      tenant.query<{ secret_envelope: string }[]>`SELECT secret_envelope FROM webhook_subscription`,
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
    await venue.asTenant((tenant) => tenant.query`UPDATE webhook_delivery SET next_attempt_at = ${pinned} WHERE status = 'pending'`)

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
      tenant.query<{ event_count: number }[]>`SELECT count(*)::int AS event_count FROM webhook_event WHERE subject_code = 'BK-3003'`,
    )
    assert.equal(row!.event_count, 0)
    const response = await venue.request('/api/v1/webhook/subscription')
    assert.equal(response.status, 404)
  })
})
