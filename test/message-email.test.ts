// message — the email transport (resend, postmark, http relay) against local
// HTTP receivers and a real database. Nothing leaves the machine.

import assert from 'node:assert/strict'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, afterEach, before, beforeEach, describe, it } from 'node:test'
import { createActor, signIn, type TenantContext } from '@bygelo/roundrobin-kernel'
import { notifyPlayer } from '../src/module/message/contract.ts'
import { TEST_DATABASE_URL, createTestVenue, type TestVenue } from './helper.ts'

const ENV_NAME = [
  'EMAIL_PROVIDER',
  'EMAIL_API_KEY',
  'EMAIL_FROM',
  'EMAIL_API_URL',
  'EMAIL_API_BASE_URL',
  'NOTIFICATION_SMS_PROVIDER',
  'NOTIFICATION_SMS_URL',
  'NOTIFICATION_SMS_API_KEY',
  'NOTIFICATION_SMS_SENDER',
]

function clearEnv() {
  for (const name of ENV_NAME) delete process.env[name]
}

type Received = { method: string; path: string; header: IncomingHttpHeaders; text: string; body: Record<string, unknown> }
type Reply = { status: number; body?: unknown }

type Receiver = {
  origin: string
  received: Received[]
  reply: (one: Received) => Reply
  close: () => Promise<void>
}

async function startReceiver(): Promise<Receiver> {
  const receiver: Receiver = {
    origin: '',
    received: [],
    reply: () => ({ status: 200, body: {} }),
    close: async () => {},
  }
  const server: Server = createServer((request, response) => {
    const chunk: Buffer[] = []
    request.on('data', (one: Buffer) => chunk.push(one))
    request.on('end', () => {
      const text = Buffer.concat(chunk).toString('utf8')
      let body: Record<string, unknown> = {}
      try {
        body = text ? (JSON.parse(text) as Record<string, unknown>) : {}
      } catch {
        body = {}
      }
      const one: Received = { method: request.method ?? '', path: request.url ?? '', header: request.headers, text, body }
      receiver.received.push(one)
      const reply = receiver.reply(one)
      response.writeHead(reply.status, { 'content-type': 'application/json' })
      response.end(reply.body === undefined ? '' : JSON.stringify(reply.body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  receiver.origin = `http://127.0.0.1:${port}`
  receiver.close = () => new Promise<void>((resolve) => server.close(() => resolve()))
  return receiver
}

async function readJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T
}

type DeliveryRow = {
  notification_delivery_id: string
  delivery_channel: string
  status: string
  attempt_count: number
  provider_message_id: string | null
  last_error: string | null
  is_later: boolean
}

async function readDelivery(tenant: TenantContext, subject_code: string): Promise<DeliveryRow[]> {
  return tenant.query<DeliveryRow[]>`
    SELECT notification_delivery_id::text AS notification_delivery_id, delivery_channel::text AS delivery_channel,
           status::text AS status, attempt_count, provider_message_id, last_error, available_at > now() AS is_later
    FROM notification_delivery
    WHERE organization_id = ${tenant.organization_id} AND idempotency_key LIKE ${`message:%:${subject_code}`}
    ORDER BY delivery_channel`
}

function captureLog() {
  const line: string[] = []
  const original = { log: console.log, warn: console.warn, error: console.error, info: console.info }
  for (const key of Object.keys(original) as (keyof typeof original)[]) {
    console[key] = (...part: unknown[]) => {
      line.push(part.map((one) => (typeof one === 'string' ? one : JSON.stringify(one))).join(' '))
    }
  }
  return {
    line,
    restore: () => Object.assign(console, original),
  }
}

describe('message — email transport', { skip: !TEST_DATABASE_URL }, () => {
  let receiver: Receiver
  let venue: TestVenue

  before(async () => {
    receiver = await startReceiver()
  })

  after(async () => {
    clearEnv()
    await receiver?.close()
  })

  beforeEach(async () => {
    clearEnv()
    receiver.received.length = 0
    receiver.reply = () => ({ status: 200, body: {} })
    venue = await createTestVenue('message-email')
  })

  afterEach(async () => {
    await venue?.close()
  })

  function useResend() {
    process.env['EMAIL_PROVIDER'] = 'resend'
    process.env['EMAIL_API_KEY'] = 're_test_secret_key'
    process.env['EMAIL_FROM'] = 'Sideout Club <hello@sideout.example>'
    process.env['EMAIL_API_BASE_URL'] = receiver.origin
  }

  async function confirmByEmail(subject_code: string, recipient_email: string, recipient_phone?: string) {
    const result = await venue.asTenant((tenant) =>
      notifyPlayer(tenant, {
        message_kind: 'booking_confirmed',
        recipient_email,
        ...(recipient_phone ? { recipient_phone } : {}),
        subject_code,
        detail: { player_name: 'Andrea', court_name: 'Court 2', date: 'Sat, Sep 20', time: '6:00 PM', booking_code: subject_code },
      }),
    )
    assert.deepEqual(result, { is_queued: true })
  }

  async function processNow() {
    const response = await venue.request('/api/v1/message/outbox/process', { method: 'POST' })
    assert.equal(response.status, 200)
    return readJson<{ result: { sent_count: number; failed_count: number; retry_count: number; held_count: number } }>(response)
  }

  it('holds email honestly when EMAIL_PROVIDER is unset, sends SMS through its own URL, and never posts email to the SMS URL', async () => {
    process.env['NOTIFICATION_SMS_URL'] = `${receiver.origin}/sms`
    process.env['NOTIFICATION_SMS_PROVIDER'] = 'semaphore'
    process.env['EMAIL_API_KEY'] = 're_value_that_must_not_leak'
    receiver.reply = () => ({ status: 200, body: { message_id: 'sms-1' } })

    await confirmByEmail('BK-HELD-1', 'held.player@example.com', '+63 917 555 0101')
    const { result } = await processNow()
    assert.equal(result.sent_count, 1)
    assert.equal(result.held_count, 1)

    assert.equal(receiver.received.length, 1, 'only the SMS went out')
    assert.equal(receiver.received[0]!.path, '/sms')
    assert.equal(receiver.received[0]!.body['delivery_channel'], 'sms')
    assert.ok(!receiver.received.some((one) => one.text.includes('held.player@example.com')))

    const row = await venue.asTenant((tenant) => readDelivery(tenant, 'BK-HELD-1'))
    assert.equal(row.find((one) => one.delivery_channel === 'email')!.status, 'queued')
    assert.equal(row.find((one) => one.delivery_channel === 'email')!.attempt_count, 0)
    assert.equal(row.find((one) => one.delivery_channel === 'sms')!.status, 'delivered')

    const provider_text = await (await venue.request('/api/v1/message/provider')).text()
    assert.ok(!provider_text.includes('re_value_that_must_not_leak'), 'env values are never returned')
    const { provider } = JSON.parse(provider_text) as {
      provider: { channel: { delivery_channel: string; is_configured: boolean; provider_code: string | null; status_label: string; env: { env_name: string; is_set: boolean }[] }[] }
    }
    const email = provider.channel.find((one) => one.delivery_channel === 'email')!
    const sms = provider.channel.find((one) => one.delivery_channel === 'sms')!
    assert.equal(email.is_configured, false)
    assert.equal(email.status_label, 'Held — no email provider configured')
    assert.deepEqual(email.env.map((one) => one.env_name).sort(), ['EMAIL_API_BASE_URL', 'EMAIL_API_KEY', 'EMAIL_API_URL', 'EMAIL_FROM', 'EMAIL_PROVIDER'])
    assert.equal(email.env.find((one) => one.env_name === 'EMAIL_API_KEY')!.is_set, true)
    assert.equal(sms.is_configured, true)
    assert.equal(sms.provider_code, 'semaphore')

    const outbox = await readJson<{ outbox: { delivery_channel: string; status: string; subject_code: string }[] }>(
      await venue.request('/api/v1/message/outbox?status=held'))
    assert.ok(outbox.outbox.length > 0)
    assert.ok(outbox.outbox.every((one) => one.delivery_channel === 'email' && one.status === 'held'))
  })

  it('sends through Resend with bearer key, from, subject, text body, and an idempotency key, then marks sent with the provider id', async () => {
    useResend()
    receiver.reply = () => ({ status: 200, body: { id: 're_msg_123' } })
    await confirmByEmail('BK-RESEND-1', 'resend.player@example.com')

    const { result } = await processNow()
    assert.equal(result.sent_count, 1)

    assert.equal(receiver.received.length, 1)
    const one = receiver.received[0]!
    assert.equal(one.method, 'POST')
    assert.equal(one.path, '/emails')
    assert.equal(one.header['authorization'], 'Bearer re_test_secret_key')
    assert.match(String(one.header['content-type']), /application\/json/)
    assert.ok(typeof one.header['idempotency-key'] === 'string' && one.header['idempotency-key'].length > 0)
    assert.equal(one.body['from'], 'Sideout Club <hello@sideout.example>')
    assert.deepEqual(one.body['to'], ['resend.player@example.com'])
    assert.equal(typeof one.body['subject'], 'string')
    assert.ok((one.body['subject'] as string).length > 0)
    assert.match(String(one.body['text']), /Court 2/)

    const [row] = await venue.asTenant((tenant) => readDelivery(tenant, 'BK-RESEND-1'))
    assert.equal(row!.status, 'delivered')
    assert.equal(row!.provider_message_id, 're_msg_123')
    assert.equal(row!.attempt_count, 1)
    assert.ok(String(one.header['idempotency-key']).includes(row!.notification_delivery_id), 'the key is stable per delivery')

    const provider = await readJson<{ provider: { channel: { delivery_channel: string; is_configured: boolean; provider_code: string; status_label: string }[] } }>(
      await venue.request('/api/v1/message/provider'))
    const email = provider.provider.channel.find((each) => each.delivery_channel === 'email')!
    assert.equal(email.is_configured, true)
    assert.equal(email.provider_code, 'resend')
  })

  it('sends through Postmark with the server token header and the idempotency key in metadata', async () => {
    process.env['EMAIL_PROVIDER'] = 'postmark'
    process.env['EMAIL_API_KEY'] = 'pm-server-token'
    process.env['EMAIL_FROM'] = 'hello@sideout.example'
    process.env['EMAIL_API_BASE_URL'] = `${receiver.origin}/`
    receiver.reply = () => ({ status: 200, body: { MessageID: 'pm-abc-1', ErrorCode: 0, Message: 'OK' } })
    await confirmByEmail('BK-POSTMARK-1', 'postmark.player@example.com')

    await processNow()
    assert.equal(receiver.received.length, 1)
    const one = receiver.received[0]!
    assert.equal(one.path, '/email')
    assert.equal(one.header['x-postmark-server-token'], 'pm-server-token')
    assert.equal(one.header['authorization'], undefined)
    assert.match(String(one.header['accept']), /application\/json/)
    assert.equal(one.body['From'], 'hello@sideout.example')
    assert.equal(one.body['To'], 'postmark.player@example.com')
    assert.ok(String(one.body['Subject']).length > 0)
    assert.match(String(one.body['TextBody']), /Court 2/)
    const metadata = one.body['Metadata'] as Record<string, string>
    assert.ok(metadata['idempotency_key'] && metadata['idempotency_key'].length > 0)

    const [row] = await venue.asTenant((tenant) => readDelivery(tenant, 'BK-POSTMARK-1'))
    assert.equal(row!.status, 'delivered')
    assert.equal(row!.provider_message_id, 'pm-abc-1')
  })

  it('posts to an http relay with a documented JSON body and bearer key', async () => {
    process.env['EMAIL_PROVIDER'] = 'http'
    process.env['EMAIL_API_URL'] = `${receiver.origin}/relay/send`
    process.env['EMAIL_API_KEY'] = 'relay-key'
    process.env['EMAIL_FROM'] = 'hello@sideout.example'
    receiver.reply = () => ({ status: 202, body: { provider_message_id: 'relay-9' } })
    await confirmByEmail('BK-RELAY-1', 'relay.player@example.com')

    await processNow()
    assert.equal(receiver.received.length, 1)
    const one = receiver.received[0]!
    assert.equal(one.path, '/relay/send')
    assert.equal(one.header['authorization'], 'Bearer relay-key')
    assert.ok(String(one.header['idempotency-key']).length > 0)
    assert.equal(one.body['channel'], 'email')
    assert.equal(one.body['from'], 'hello@sideout.example')
    assert.equal(one.body['to'], 'relay.player@example.com')
    assert.equal(one.body['idempotency_key'], one.header['idempotency-key'])
    assert.ok(String(one.body['subject']).length > 0)
    assert.match(String(one.body['text']), /Court 2/)

    const [row] = await venue.asTenant((tenant) => readDelivery(tenant, 'BK-RELAY-1'))
    assert.equal(row!.status, 'delivered')
    assert.equal(row!.provider_message_id, 'relay-9')
  })

  it('retries a 500 later with the same idempotency key, and fails a 422 without retrying', async () => {
    useResend()
    receiver.reply = () => ({ status: 500, body: { message: 'internal error' } })
    await confirmByEmail('BK-RETRY-500', 'retry.player@example.com')

    const first = await processNow()
    assert.equal(first.result.sent_count, 0)
    assert.equal(first.result.retry_count, 1)
    let [row] = await venue.asTenant((tenant) => readDelivery(tenant, 'BK-RETRY-500'))
    assert.equal(row!.status, 'queued', 'a 500 goes back in the queue')
    assert.equal(row!.attempt_count, 1)
    assert.equal(row!.is_later, true, 'and waits before the next try')
    assert.match(row!.last_error!, /500/)

    const line = await readJson<{ outbox: { subject_code: string; status: string; last_error: string | null }[] }>(
      await venue.request('/api/v1/message/outbox'))
    const retrying = line.outbox.find((one) => one.subject_code === 'BK-RETRY-500')!
    assert.equal(retrying.status, 'queued')
    assert.match(retrying.last_error!, /500/)

    const again = await processNow()
    assert.equal(receiver.received.length, 1, 'not retried before it is due')
    assert.equal(again.result.sent_count, 0)

    await venue.asTenant((tenant) => tenant.query`
      UPDATE notification_delivery SET available_at = now()
      WHERE organization_id = ${tenant.organization_id} AND notification_delivery_id = ${row!.notification_delivery_id}`)
    receiver.reply = () => ({ status: 200, body: { id: 're_after_retry' } })
    await processNow()
    assert.equal(receiver.received.length, 2)
    assert.equal(receiver.received[0]!.header['idempotency-key'], receiver.received[1]!.header['idempotency-key'])
    ;[row] = await venue.asTenant((tenant) => readDelivery(tenant, 'BK-RETRY-500'))
    assert.equal(row!.status, 'delivered')
    assert.equal(row!.attempt_count, 2)
    assert.equal(row!.provider_message_id, 're_after_retry')

    receiver.received.length = 0
    receiver.reply = () => ({ status: 422, body: { name: 'validation_error', message: 'Invalid `to` field: bad.player@example.com' } })
    await confirmByEmail('BK-FAIL-422', 'bad.player@example.com')
    const refused = await processNow()
    assert.equal(refused.result.failed_count, 1)
    const [failed] = await venue.asTenant((tenant) => readDelivery(tenant, 'BK-FAIL-422'))
    assert.equal(failed!.status, 'failed')
    assert.equal(failed!.is_later, false)
    assert.equal(failed!.attempt_count, 1)
    assert.match(failed!.last_error!, /422/)
    assert.ok(!failed!.last_error!.includes('bad.player@example.com'), 'the stored reason is masked')

    await processNow()
    assert.equal(receiver.received.length, 1, 'a 422 is never retried automatically')
  })

  it('treats 429 as retryable and gives up after the attempt limit', async () => {
    useResend()
    receiver.reply = () => ({ status: 429, body: { message: 'rate limited' } })
    await confirmByEmail('BK-429', 'limit.player@example.com')
    await processNow()
    let [row] = await venue.asTenant((tenant) => readDelivery(tenant, 'BK-429'))
    assert.equal(row!.status, 'queued')

    await venue.asTenant((tenant) => tenant.query`
      UPDATE notification_delivery SET available_at = now(), attempt_count = 4
      WHERE organization_id = ${tenant.organization_id} AND notification_delivery_id = ${row!.notification_delivery_id}`)
    receiver.reply = () => ({ status: 503 })
    await processNow()
    ;[row] = await venue.asTenant((tenant) => readDelivery(tenant, 'BK-429'))
    assert.equal(row!.status, 'failed')
    assert.equal(row!.attempt_count, 5)
  })

  it('holds email when EMAIL_PROVIDER is set but incomplete, naming the missing variable and sending nothing', async () => {
    process.env['EMAIL_PROVIDER'] = 'resend'
    process.env['EMAIL_API_BASE_URL'] = receiver.origin
    await confirmByEmail('BK-MISCONFIG', 'mis.player@example.com')
    const { result } = await processNow()
    assert.equal(result.sent_count, 0)
    assert.equal(receiver.received.length, 0)
    const provider = await readJson<{ provider: { channel: { delivery_channel: string; is_configured: boolean; status_label: string; explanation: string }[] } }>(
      await venue.request('/api/v1/message/provider'))
    const email = provider.provider.channel.find((one) => one.delivery_channel === 'email')!
    assert.equal(email.is_configured, false)
    assert.match(email.status_label, /^Held/)
    assert.match(email.explanation, /EMAIL_API_KEY/)
    assert.match(email.explanation, /EMAIL_FROM/)
  })

  it('never puts a raw email address in a response or a log line', async () => {
    useResend()
    receiver.reply = () => ({ status: 422, body: { message: 'Invalid to: secret.player@example.com' } })
    const capture = captureLog()
    let text = ''
    try {
      await confirmByEmail('BK-PRIVATE', 'secret.player@example.com')
      text += await (await venue.request('/api/v1/message/outbox/process', { method: 'POST' })).text()
      text += await (await venue.request('/api/v1/message/outbox')).text()
      text += await (await venue.request('/api/v1/message/outbox?status=failed')).text()
      text += await (await venue.request('/api/v1/message/provider')).text()
      const [row] = await venue.asTenant((tenant) => readDelivery(tenant, 'BK-PRIVATE'))
      receiver.reply = () => ({ status: 500, body: { message: 'down for secret.player@example.com' } })
      text += await (await venue.request(`/api/v1/message/outbox/${row!.notification_delivery_id}/retry`, { method: 'POST' })).text()
      text += await (await venue.request('/api/v1/message/test-email', {
        method: 'POST',
        body: JSON.stringify({ recipient_email: 'secret.player@example.com' }),
      })).text()
    } finally {
      capture.restore()
    }
    assert.ok(receiver.received.length >= 2, 'the provider was actually called')
    assert.ok(text.includes('s•••@example.com'), 'masks are what is shown')
    assert.ok(!text.includes('secret.player@example.com'), 'no raw email in any response')
    assert.ok(capture.line.length > 0, 'failures are logged')
    assert.ok(capture.line.every((one) => !one.includes('secret.player@example.com')), 'no raw email in any log line')
  })

  it('sends a test email only for message.manage, and reports held, sent, and refused honestly', async () => {
    const desk_token = await venue.asTenant(async (tenant) => {
      const [role] = await tenant.query<{ role_id: string }[]>`
        INSERT INTO role (organization_id, role_code, display_name) VALUES (${tenant.organization_id}, 'desk', 'Desk') RETURNING role_id`
      await tenant.query`
        INSERT INTO role_capability (organization_id, role_id, capability_code) VALUES (${tenant.organization_id}, ${role!.role_id}, 'message.read')`
      await createActor(tenant, { actor_code: 'desk', display_name: 'Desk', secret: 'desk-secret-1', role_code: 'desk' })
      return signIn(tenant, { actor_code: 'desk', secret: 'desk-secret-1' })
    })
    const body = JSON.stringify({ recipient_email: 'owner.inbox@example.com' })

    useResend()
    const forbidden = await venue.request('/api/v1/message/test-email', { method: 'POST', body, headers: { authorization: `Bearer ${desk_token}` } })
    assert.equal(forbidden.status, 403)
    assert.equal(receiver.received.length, 0)
    const desk_read = await venue.request('/api/v1/message/provider', { headers: { authorization: `Bearer ${desk_token}` } })
    assert.equal(desk_read.status, 200)

    const invalid = await venue.request('/api/v1/message/test-email', { method: 'POST', body: JSON.stringify({ recipient_email: 'not-an-email' }) })
    assert.equal(invalid.status, 400)
    assert.equal(receiver.received.length, 0)

    receiver.reply = () => ({ status: 200, body: { id: 're_test_email_1' } })
    const sent = await readJson<{ result: { status: string; provider_code: string; provider_message_id: string; recipient_mask: string } }>(
      await venue.request('/api/v1/message/test-email', { method: 'POST', body }))
    assert.equal(sent.result.status, 'sent')
    assert.equal(sent.result.provider_code, 'resend')
    assert.equal(sent.result.provider_message_id, 're_test_email_1')
    assert.equal(sent.result.recipient_mask, 'o•••@example.com')
    assert.equal(receiver.received.length, 1)
    assert.deepEqual(receiver.received[0]!.body['to'], ['owner.inbox@example.com'])
    assert.match(String(receiver.received[0]!.body['subject']), /test/i)

    receiver.reply = () => ({ status: 403, body: { message: 'domain not verified' } })
    const refused = await readJson<{ result: { status: string; reason: string; is_retryable: boolean } }>(
      await venue.request('/api/v1/message/test-email', { method: 'POST', body }))
    assert.equal(refused.result.status, 'failed')
    assert.equal(refused.result.is_retryable, false)
    assert.match(refused.result.reason, /domain not verified/)

    clearEnv()
    receiver.received.length = 0
    const held = await readJson<{ result: { status: string; reason: string } }>(
      await venue.request('/api/v1/message/test-email', { method: 'POST', body }))
    assert.equal(held.result.status, 'held')
    assert.match(held.result.reason, /EMAIL_PROVIDER/)
    assert.equal(receiver.received.length, 0, 'nothing is sent without a provider')
  })
})
