// message — R22 transactional notification, against a real database.

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { disableModule, type TenantContext } from '@bygelo/roundrobin-kernel'
import { createFailingProvider, createRecordingProvider } from '@bygelo/roundrobin-notification'
import { COURT_DECLARATION } from '../src/app.ts'
import { notifyPlayer } from '../src/module/message/contract.ts'
import { setMessageProvider } from '../src/module/message/service.ts'
import { TEST_DATABASE_URL, createTestVenue, type TestVenue } from './helper.ts'

// The honest default: nothing configured. Set before any provider is resolved.
delete process.env['NOTIFICATION_SMS_URL']
delete process.env['NOTIFICATION_SMS_API_KEY']

let sequence = 0

async function createParty(tenant: TenantContext, name: string, option: { email?: string; phone?: string } = {}) {
  sequence += 1
  const email = option.email ?? `player${sequence}.${Date.now()}@example.com`
  const phone = option.phone ?? `+63 917 ${String(1000000 + sequence).slice(-7, -4)} ${String(1000 + sequence).slice(-4)}`
  const [row] = await tenant.query<{ party_id: string }[]>`
    INSERT INTO party (organization_id, display_name, email_address, phone_number)
    VALUES (${tenant.organization_id}, ${name}, ${email}, ${phone}) RETURNING party_id`
  return { party_id: row!.party_id, email, phone }
}

async function countDelivery(tenant: TenantContext, subject_code: string) {
  return tenant.query<{ delivery_channel: string; status: string; recipient: string }[]>`
    SELECT delivery_channel::text AS delivery_channel, status::text AS status, recipient FROM notification_delivery
    WHERE organization_id = ${tenant.organization_id} AND idempotency_key LIKE ${`message:%:${subject_code}`}`
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text()
  return JSON.parse(text) as T
}

describe('message — transactional notification', { skip: !TEST_DATABASE_URL }, () => {
  let venue: TestVenue
  let other: TestVenue

  before(async () => {
    venue = await createTestVenue('message')
    other = await createTestVenue('message-other')
  })

  after(async () => {
    setMessageProvider()
    await venue?.close()
    await other?.close()
  })

  it('queues an essential message on every channel without opt-in, once per kind + subject + channel', async () => {
    const player = await venue.asTenant((tenant) => createParty(tenant, 'Andrea Santos'))
    const input = {
      message_kind: 'booking_confirmed' as const,
      party_id: player.party_id,
      subject_code: 'BK-IDEM-1',
      detail: { court_name: 'Court 1', date: 'Sat, Sep 20', time: '6:00 PM', booking_code: 'BK-IDEM-1' },
    }
    const first = await venue.asTenant((tenant) => notifyPlayer(tenant, input))
    const second = await venue.asTenant((tenant) => notifyPlayer(tenant, input))
    assert.deepEqual(first, { is_queued: true })
    assert.deepEqual(second, { is_queued: true })

    const row = await venue.asTenant((tenant) => countDelivery(tenant, 'BK-IDEM-1'))
    assert.equal(row.length, 2, 'one email + one sms, never a duplicate')
    assert.deepEqual(row.map((one) => one.delivery_channel).sort(), ['email', 'sms'])
    assert.ok(row.every((one) => one.status === 'queued'))

    const body = await venue.asTenant((tenant) => tenant.query<{ body: string }[]>`
      SELECT body FROM notification_delivery WHERE organization_id = ${tenant.organization_id}
        AND idempotency_key = 'message:booking_confirmed:BK-IDEM-1' AND delivery_channel = 'sms'`)
    assert.match(body[0]!.body, /Court 1/)
    assert.match(body[0]!.body, /Test Pickleball Club/, 'venue_name is filled in automatically')
  })

  it('stays exactly-once when two producers race on the same subject', async () => {
    const player = await venue.asTenant((tenant) => createParty(tenant, 'Race Player'))
    const input = { message_kind: 'booking_cancelled' as const, party_id: player.party_id, subject_code: 'BK-RACE-1', detail: {} }
    const result = await Promise.all([
      venue.asTenant((tenant) => notifyPlayer(tenant, input)),
      venue.asTenant((tenant) => notifyPlayer(tenant, input)),
      venue.asTenant((tenant) => notifyPlayer(tenant, input)),
    ])
    assert.ok(result.every((one) => one.is_queued))
    const row = await venue.asTenant((tenant) => countDelivery(tenant, 'BK-RACE-1'))
    assert.equal(row.length, 2)
    const dispatch = await venue.asTenant((tenant) => tenant.query<{ n: number }[]>`
      SELECT count(*)::int AS n FROM message_dispatch WHERE organization_id = ${tenant.organization_id} AND subject_code = 'BK-RACE-1'`)
    assert.equal(dispatch[0]!.n, 2)
  })

  it('refuses an optional message without opt-in, then queues it after the player opts in', async () => {
    const player = await venue.asTenant((tenant) => createParty(tenant, 'Optional Player'))
    const input = { message_kind: 'waitlist_opened' as const, party_id: player.party_id, subject_code: 'WL-1', detail: {} }

    assert.deepEqual(await venue.asTenant((tenant) => notifyPlayer(tenant, input)), { is_queued: false })
    assert.equal((await venue.asTenant((tenant) => countDelivery(tenant, 'WL-1'))).length, 0)

    const refused = await venue.request('/api/v1/message/preference', {
      method: 'PUT',
      body: JSON.stringify({ contact: player.email, message_kind: ['booking_confirmed'], is_opted_in: false }),
    })
    assert.equal(refused.status, 400, 'an essential kind cannot be turned off')

    const saved = await venue.request('/api/v1/message/preference', {
      method: 'PUT',
      body: JSON.stringify({ contact: player.phone.replace('+63 ', '0'), message_kind: ['waitlist_opened'], is_opted_in: true }),
    })
    assert.equal(saved.status, 200)
    const view = await readJson<{ preference: { message_kind: string; is_opted_in: boolean }[] }>(saved)
    assert.equal(view.preference.find((one) => one.message_kind === 'waitlist_opened')?.is_opted_in, true)

    assert.deepEqual(await venue.asTenant((tenant) => notifyPlayer(tenant, input)), { is_queued: true })
    const row = await venue.asTenant((tenant) => countDelivery(tenant, 'WL-1'))
    assert.equal(row.length, 2)
    assert.ok(row.every((one) => one.status === 'queued'))
  })

  it('sends a blocked player nothing — every kind lands suppressed', async () => {
    const player = await venue.asTenant((tenant) => createParty(tenant, 'Blocked Player'))
    const block = await venue.request('/api/v1/message/preference', {
      method: 'PUT',
      body: JSON.stringify({ contact: player.email, is_contact_allowed: false }),
    })
    assert.equal(block.status, 200)
    const result = await venue.asTenant((tenant) =>
      notifyPlayer(tenant, { message_kind: 'closure', party_id: player.party_id, subject_code: 'CL-BLOCK', detail: { reason: 'typhoon' } }))
    assert.equal(result.is_queued, false)
    const row = await venue.asTenant((tenant) => countDelivery(tenant, 'CL-BLOCK'))
    assert.equal(row.length, 2, 'the intent stays in the outbox for audit')
    assert.ok(row.every((one) => one.status === 'suppressed'))
  })

  it('reports no provider honestly and holds the outbox until one exists', async () => {
    const response = await venue.request('/api/v1/message/provider')
    assert.equal(response.status, 200)
    const { provider } = await readJson<{
      provider: { is_configured: boolean; held_count: number; channel: { status_label: string }[]; env: { env_name: string; is_set: boolean }[] }
    }>(response)
    assert.equal(provider.is_configured, false)
    assert.ok(provider.held_count > 0)
    assert.ok(provider.channel.every((one) => one.status_label === 'Held — no provider configured'))
    assert.equal(provider.env.find((one) => one.env_name === 'NOTIFICATION_SMS_URL')?.is_set, false)

    const process = await venue.request('/api/v1/message/outbox/process', { method: 'POST' })
    const { result } = await readJson<{ result: { sent_count: number; held_count: number; is_provider_configured: boolean } }>(process)
    assert.equal(result.is_provider_configured, false)
    assert.equal(result.sent_count, 0)
    assert.ok(result.held_count > 0)

    const outbox = await readJson<{ outbox: { status: string }[] }>(await venue.request('/api/v1/message/outbox?status=held'))
    assert.ok(outbox.outbox.length > 0)
    assert.ok(outbox.outbox.every((one) => one.status === 'held'))
  })

  it('never returns a raw recipient from the outbox or preference lookup', async () => {
    const player = await venue.asTenant((tenant) => createParty(tenant, 'Private Player', { email: 'private.player@example.com', phone: '+63 918 777 4321' }))
    await venue.asTenant((tenant) =>
      notifyPlayer(tenant, { message_kind: 'booking_receipt', party_id: player.party_id, subject_code: 'BK-MASK', detail: { amount: '₱800.00' } }))

    const text = await (await venue.request('/api/v1/message/outbox')).text()
    assert.ok(text.includes('p•••@example.com'))
    assert.ok(text.includes('••••4321'))
    assert.ok(!text.includes('private.player@example.com'))
    assert.ok(!text.includes('918 777'))
    assert.ok(!text.includes('9187774321'))

    const lookup = await venue.request(`/api/v1/message/preference?contact=${encodeURIComponent('private.player@example.com')}`)
    assert.equal(lookup.status, 200)
    const lookup_text = await lookup.text()
    assert.ok(!lookup_text.includes('private.player@example.com'))
    assert.ok(!lookup_text.includes('918 777'))
    assert.ok(lookup_text.includes('Private Player'))
  })

  it('surfaces a provider failure in the outbox and retries it', async () => {
    const player = await venue.asTenant((tenant) => createParty(tenant, 'Retry Player'))
    await venue.asTenant((tenant) =>
      notifyPlayer(tenant, { message_kind: 'court_changed', party_id: player.party_id, subject_code: 'BK-RETRY', detail: {} }))

    setMessageProvider(createFailingProvider('fixture-fail'))
    const process = await readJson<{ result: { failed_count: number } }>(await venue.request('/api/v1/message/outbox/process', { method: 'POST' }))
    assert.ok(process.result.failed_count > 0)

    const failed = await readJson<{ outbox: { notification_delivery_id: string; subject_code: string; status: string; last_error: string; attempt_count: number }[] }>(
      await venue.request('/api/v1/message/outbox?status=failed'))
    const line = failed.outbox.find((one) => one.subject_code === 'BK-RETRY')!
    assert.equal(line.status, 'failed')
    assert.equal(line.attempt_count, 1)
    assert.match(line.last_error, /provider unavailable\./i)

    const not_failed = await readJson<{ outbox: { notification_delivery_id: string }[] }>(await venue.request('/api/v1/message/outbox?status=sent'))
    assert.equal(not_failed.outbox.length, 0)

    setMessageProvider(createRecordingProvider('fixture-record'))
    const retry = await venue.request(`/api/v1/message/outbox/${line.notification_delivery_id}/retry`, { method: 'POST' })
    assert.equal(retry.status, 200)
    const retried = await readJson<{ line: { status: string; attempt_count: number } }>(retry)
    assert.equal(retried.line.status, 'sent')
    assert.equal(retried.line.attempt_count, 2)

    const again = await venue.request(`/api/v1/message/outbox/${line.notification_delivery_id}/retry`, { method: 'POST' })
    assert.equal(again.status, 409, 'a sent message cannot be retried')
    setMessageProvider()
  })

  it('validates templates and previews them with sample data', async () => {
    const list = await readJson<{ template: { message_kind: string; delivery_channel: string }[]; kind: unknown[] }>(
      await venue.request('/api/v1/message/template'))
    assert.equal(list.template.length, 20)
    assert.equal(list.kind.length, 10)

    const unknown = await venue.request('/api/v1/message/template/booking_confirmed/sms', {
      method: 'PUT',
      body: JSON.stringify({ body: 'Hi {{player_name}}, bring {{shoe_size}}' }),
    })
    assert.equal(unknown.status, 400)
    assert.match((await readJson<{ error: string }>(unknown)).error, /\{\{shoe_size\}\}” is not available/)

    const long = await venue.request('/api/v1/message/template/booking_confirmed/sms', {
      method: 'PUT',
      body: JSON.stringify({ body: 'x'.repeat(321) }),
    })
    assert.equal(long.status, 400)

    const unknown_kind = await venue.request('/api/v1/message/template/marketing_blast/sms', { method: 'PUT', body: JSON.stringify({ body: 'Sale!' }) })
    assert.equal(unknown_kind.status, 404)

    const saved = await venue.request('/api/v1/message/template/booking_confirmed/sms', {
      method: 'PUT',
      body: JSON.stringify({ body: 'See you on {{court_name}}, {{player_name}}! Code {{booking_code}}' }),
    })
    assert.equal(saved.status, 200)

    const preview = await readJson<{ preview: { body: string; character_count: number } }>(
      await venue.request('/api/v1/message/template/booking_confirmed/sms/preview', { method: 'POST', body: '' }))
    assert.equal(preview.preview.body, 'See you on Court 3, Andrea Santos! Code BK-7Q4M2')
    assert.equal(preview.preview.character_count, preview.preview.body.length)

    const player = await venue.asTenant((tenant) => createParty(tenant, 'Template Player'))
    await venue.asTenant((tenant) =>
      notifyPlayer(tenant, { message_kind: 'booking_confirmed', party_id: player.party_id, subject_code: 'BK-TPL', detail: { court_name: 'Court 9', booking_code: 'BK-TPL' } }))
    const [sms] = await venue.asTenant((tenant) => tenant.query<{ body: string }[]>`
      SELECT body FROM notification_delivery WHERE organization_id = ${tenant.organization_id}
        AND idempotency_key = 'message:booking_confirmed:BK-TPL' AND delivery_channel = 'sms'`)
    assert.equal(sms!.body, 'See you on Court 9, Template Player! Code BK-TPL', 'the saved template is what goes out')
  })

  it('queues tomorrow’s reminders once, however often the sweep runs', async () => {
    const booking_code = await venue.asTenant(async (tenant) => {
      const player = await createParty(tenant, 'Reminder Player', { email: 'reminder.player@example.com' })
      const quiet = await createParty(tenant, 'Not Opted Player')
      await tenant.query`
        INSERT INTO message_preference (organization_id, party_id, message_kind, is_opted_in)
        VALUES (${tenant.organization_id}, ${player.party_id}, 'booking_reminder', true)`
      const [site] = await tenant.query<{ site_id: string }[]>`
        INSERT INTO site (organization_id, site_code, display_name) VALUES (${tenant.organization_id}, 'main', 'Main') RETURNING site_id`
      const [resource] = await tenant.query<{ resource_id: string }[]>`
        INSERT INTO resource (organization_id, site_id, resource_code, display_name) VALUES (${tenant.organization_id}, ${site!.site_id}, 'court-5', 'Court 5')
        RETURNING resource_id`
      const code: string[] = []
      for (const [index, party_id] of [player.party_id, quiet.party_id].entries()) {
        const [session] = await tenant.query<{ session_id: string; starts_at: Date; ends_at: Date }[]>`
          INSERT INTO session (organization_id, site_id, session_code, starts_at, ends_at, capacity_count)
          VALUES (${tenant.organization_id}, ${site!.site_id}, ${`s-${index}`},
                  date_trunc('second', now()) + interval '3 hours' + ${`${index} hours`}::interval,
                  date_trunc('second', now()) + interval '4 hours' + ${`${index} hours`}::interval, 4)
          RETURNING session_id, starts_at, ends_at`
        await tenant.query`
          INSERT INTO session_resource (organization_id, session_id, resource_id)
          VALUES (${tenant.organization_id}, ${session!.session_id}, ${resource!.resource_id})`
        await tenant.query`
          INSERT INTO booking (organization_id, session_id, resource_id, party_id, booking_code, status, price_amount, starts_at, ends_at)
          VALUES (${tenant.organization_id}, ${session!.session_id}, ${resource!.resource_id}, ${party_id}, ${`BK-REM-${index}`},
                  'confirmed', 500.00, ${session!.starts_at}, ${session!.ends_at})`
        code.push(`BK-REM-${index}`)
      }
      return code[0]!
    })

    const first = await readJson<{ result: { candidate_count: number; queued_count: number; not_opted_in_count: number } }>(
      await venue.request('/api/v1/message/reminder/run', { method: 'POST' }))
    assert.equal(first.result.candidate_count, 2)
    assert.equal(first.result.queued_count, 1)
    assert.equal(first.result.not_opted_in_count, 1)

    const second = await readJson<{ result: { queued_count: number; already_reminded_count: number } }>(
      await venue.request('/api/v1/message/reminder/run', { method: 'POST' }))
    assert.equal(second.result.queued_count, 0)
    assert.equal(second.result.already_reminded_count, 1)

    const row = await venue.asTenant((tenant) => countDelivery(tenant, booking_code))
    assert.equal(row.length, 2)
  })

  it('keeps one venue’s messages, templates, and players invisible to another', async () => {
    const mine = await readJson<{ outbox: unknown[] }>(await venue.request('/api/v1/message/outbox'))
    assert.ok(mine.outbox.length > 0)
    const theirs = await readJson<{ outbox: unknown[]; summary: { queued_count: number } }>(await other.request('/api/v1/message/outbox'))
    assert.equal(theirs.outbox.length, 0)
    assert.equal(theirs.summary.queued_count, 0)

    const template = await readJson<{ template: { message_kind: string; delivery_channel: string; body: string }[] }>(
      await other.request('/api/v1/message/template'))
    const sms = template.template.find((one) => one.message_kind === 'booking_confirmed' && one.delivery_channel === 'sms')!
    assert.ok(!sms.body.startsWith('See you on'), 'the other venue still has default copy')

    const lookup = await other.request(`/api/v1/message/preference?contact=${encodeURIComponent('private.player@example.com')}`)
    assert.equal(lookup.status, 404)

    const [delivery] = await venue.asTenant((tenant) => tenant.query<{ notification_delivery_id: string }[]>`
      SELECT notification_delivery_id FROM notification_delivery WHERE organization_id = ${tenant.organization_id} LIMIT 1`)
    const retry = await other.request(`/api/v1/message/outbox/${delivery!.notification_delivery_id}/retry`, { method: 'POST' })
    assert.equal(retry.status, 404)

    // A producer in the other venue cannot reach this venue's player by id.
    const [party] = await venue.asTenant((tenant) => tenant.query<{ party_id: string }[]>`
      SELECT party_id FROM party WHERE organization_id = ${tenant.organization_id} LIMIT 1`)
    const cross = await other.asTenant((tenant) =>
      notifyPlayer(tenant, { message_kind: 'booking_confirmed', party_id: party!.party_id, subject_code: 'BK-CROSS', detail: {} }))
    assert.deepEqual(cross, { is_queued: false })
  })

  it('is a silent no-op when the message module is disabled, and its routes 404', async () => {
    const off = await createTestVenue('message-off')
    try {
      const player = await off.asTenant((tenant) => createParty(tenant, 'Off Player'))
      await off.asTenant((tenant) => disableModule(tenant, 'message', COURT_DECLARATION))
      const result = await off.asTenant((tenant) =>
        notifyPlayer(tenant, { message_kind: 'booking_confirmed', party_id: player.party_id, subject_code: 'BK-OFF', detail: {} }))
      assert.deepEqual(result, { is_queued: false })
      const row = await off.asTenant((tenant) => countDelivery(tenant, 'BK-OFF'))
      assert.equal(row.length, 0)
      const dispatch = await off.asTenant((tenant) => tenant.query<{ n: number }[]>`
        SELECT count(*)::int AS n FROM message_dispatch WHERE organization_id = ${tenant.organization_id}`)
      assert.equal(dispatch[0]!.n, 0)
      assert.equal((await off.request('/api/v1/message/outbox')).status, 404)
      assert.equal((await off.request('/api/v1/message/provider')).status, 404)
    } finally {
      await off.close()
    }
  })
})
