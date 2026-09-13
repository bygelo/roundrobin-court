// R11 — arrival, waiver, and check-in, against a real database.

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { createStore, disableModule, withTenant, type Uuid } from '@bygelo/roundrobin-kernel'
import { COURT_DECLARATION, createCourtApp } from '../src/app.ts'
import { addDay, localDate } from '../src/module/program/schedule.ts'
import { TEST_DATABASE_URL, createTestVenue, type TestVenue } from './helper.ts'

type Json = Record<string, any>
const json = async (response: Response): Promise<Json> => {
  const text = await response.text()
  return text ? (JSON.parse(text) as Json) : {}
}
const today = () => localDate(new Date(), 'Asia/Manila')
const MINUTE = 60000

describe('arrival, waiver, and check-in (R11)', { skip: !TEST_DATABASE_URL }, () => {
  let venue: TestVenue
  let occurrence_id: Uuid
  let waiver_v1: string

  /** A registration whose occurrence runs from now+start_minute to now+end_minute. */
  async function registration(index: number, start_minute: number, end_minute: number, price = '350') {
    const created = await json(
      await venue.request('/api/v1/program', {
        method: 'POST',
        body: JSON.stringify({
          kind_code: 'clinic',
          title: `Clinic ${index}`,
          host_name: 'Coach Mia',
          price_amount: price,
          capacity_count: 12,
          is_published: true,
          schedule: { schedule_code: 'once', first_date: addDay(today(), 2), starts_local: '18:00', ends_local: '19:30' },
        }),
      }),
    )
    const [occurrence] = await venue.asTenant((tenant) =>
      tenant.query<{ program_occurrence_id: Uuid }[]>`
        SELECT program_occurrence_id FROM program_occurrence WHERE program_id = ${created.program.program_id}`,
    )
    occurrence_id = occurrence!.program_occurrence_id
    // Register while the session is still upcoming, then move it to the time under test.
    const response = await venue.publicRequest(`/public/${venue.organization_code}/program/occurrence/${occurrence_id}/registration`, {
      method: 'POST',
      body: JSON.stringify({ display_name: `Arrival ${index}`, email: `arrival${index}@example.com` }),
    })
    assert.equal(response.status, 201)
    await venue.asTenant((tenant) =>
      tenant.query`
        UPDATE program_occurrence
        SET starts_at = ${new Date(Date.now() + start_minute * MINUTE)}, ends_at = ${new Date(Date.now() + end_minute * MINUTE)}
        WHERE program_occurrence_id = ${occurrence_id}`,
    )
    return json(response)
  }

  const selfCheckIn = (body: Json) =>
    venue.publicRequest(`/public/${venue.organization_code}/arrival/check-in`, { method: 'POST', body: JSON.stringify(body) })

  before(async () => {
    venue = await createTestVenue('arrival')
    const draft = await json(
      await venue.request('/api/v1/arrival/waiver', {
        method: 'POST',
        body: JSON.stringify({ title: 'Player waiver', body: 'I play at my own risk.' }),
      }),
    )
    waiver_v1 = draft.waiver.arrival_waiver_version_id
    assert.equal((await venue.request(`/api/v1/arrival/waiver/${waiver_v1}/publish`, { method: 'POST' })).status, 200)
  })
  after(() => venue.close())

  it('self check-in: refused early, prompts for the waiver, stores evidence, then admits once', async () => {
    const early = await registration(1, 120, 210)
    const too_early = await selfCheckIn({ credential: early.credential })
    assert.equal(too_early.status, 409)
    assert.equal((await json(too_early)).reason_code, 'too_early')

    const player = await registration(2, 30, 120)
    const prompt = await selfCheckIn({ credential: player.credential })
    assert.equal(prompt.status, 409)
    const prompt_body = await json(prompt)
    assert.equal(prompt_body.reason_code, 'waiver_required')
    assert.equal(prompt_body.waiver.arrival_waiver_version_id, waiver_v1)

    const accept = await venue.publicRequest(`/public/${venue.organization_code}/arrival/waiver/accept`, {
      method: 'POST',
      headers: { 'user-agent': 'PhoneBrowser/1.0', 'x-forwarded-for': '203.0.113.7' },
      body: JSON.stringify({ credential: player.credential, arrival_waiver_version_id: waiver_v1 }),
    })
    assert.equal(accept.status, 200)
    const [evidence] = await venue.asTenant((tenant) =>
      tenant.query<{ user_agent: string; ip_hash: string; channel_code: string }[]>`
        SELECT a.user_agent, a.ip_hash, a.channel_code FROM arrival_waiver_acceptance a
        JOIN program_registration r ON r.party_id = a.party_id
        WHERE r.program_registration_id = ${player.registration.program_registration_id}`,
    )
    assert.equal(evidence?.user_agent, 'PhoneBrowser/1.0')
    assert.ok(evidence?.ip_hash && !evidence.ip_hash.includes('203.0.113.7'))

    const admitted = await selfCheckIn({ code: player.check_in_token })
    assert.equal(admitted.status, 200)
    const admitted_body = await json(admitted)
    assert.equal(admitted_body.is_replay, false)
    assert.equal(admitted_body.check_in.method_code, 'self')
    assert.equal(admitted_body.paid_state, undefined, 'the guest never sees the desk view')

    const replay = await json(await selfCheckIn({ credential: player.credential }))
    assert.equal(replay.is_replay, true)

    const ended = await registration(3, -120, -1)
    const late = await selfCheckIn({ credential: ended.credential })
    assert.equal((await json(late)).reason_code, 'ended')
  })

  it('a new waiver version makes older acceptances outdated, and published text is frozen', async () => {
    const player = await registration(4, 30, 120)
    await venue.publicRequest(`/public/${venue.organization_code}/arrival/waiver/accept`, {
      method: 'POST',
      body: JSON.stringify({ credential: player.credential, arrival_waiver_version_id: waiver_v1 }),
    })
    const edit = await venue.request(`/api/v1/arrival/waiver/${waiver_v1}`, {
      method: 'PUT',
      body: JSON.stringify({ title: 'Changed', body: 'Changed text' }),
    })
    assert.equal(edit.status, 409)

    const read = async () => {
      const day = await json(await venue.request(`/api/v1/arrival/today?date=${localDate(new Date(Date.now() + 30 * MINUTE), 'Asia/Manila')}`))
      return day.arrival.find((one: Json) => one.subject_id === player.registration.program_registration_id)
    }
    assert.equal((await read()).waiver_state, 'current')

    const draft = await json(
      await venue.request('/api/v1/arrival/waiver', { method: 'POST', body: JSON.stringify({ title: 'Player waiver', body: 'v2 text' }) }),
    )
    assert.equal(draft.waiver.version_number, 2)
    await venue.request(`/api/v1/arrival/waiver/${draft.waiver.arrival_waiver_version_id}/publish`, { method: 'POST' })
    assert.equal((await read()).waiver_state, 'outdated')

    const stale = await venue.publicRequest(`/public/${venue.organization_code}/arrival/waiver/accept`, {
      method: 'POST',
      body: JSON.stringify({ credential: player.credential, arrival_waiver_version_id: waiver_v1 }),
    })
    assert.equal(stale.status, 409, 'accepting a superseded version is refused')
    waiver_v1 = draft.waiver.arrival_waiver_version_id
  })

  it('staff check-in: unpaid needs an override, override needs a reason and is audited; duplicates are idempotent', async () => {
    const player = await registration(5, 30, 120)
    const subject = { subject_kind: 'registration', subject_id: player.registration.program_registration_id }

    const refused = await venue.request('/api/v1/arrival/check-in', { method: 'POST', body: JSON.stringify(subject) })
    assert.equal(refused.status, 409)
    assert.match((await json(refused)).error, /Override needed: .*has not paid/)

    const no_reason = await venue.request('/api/v1/arrival/check-in', {
      method: 'POST',
      body: JSON.stringify({ ...subject, method_code: 'staff_override', reason: '   ' }),
    })
    assert.equal(no_reason.status, 400)

    const override = await venue.request('/api/v1/arrival/check-in', {
      method: 'POST',
      body: JSON.stringify({ ...subject, method_code: 'staff_override', reason: 'Paying cash after the clinic' }),
    })
    assert.equal(override.status, 201)
    const duplicate = await venue.request('/api/v1/arrival/check-in', {
      method: 'POST',
      body: JSON.stringify({ ...subject, method_code: 'staff_override', reason: 'again' }),
    })
    assert.equal(duplicate.status, 200)
    assert.equal((await json(duplicate)).is_replay, true)

    const row = await venue.asTenant(async (tenant) => {
      const check_in = await tenant.query<{ auth_session_id: Uuid | null; reason: string }[]>`
        SELECT auth_session_id, reason FROM arrival_check_in WHERE subject_id = ${subject.subject_id}`
      const audit = await tenant.query<{ detail: Json }[]>`
        SELECT detail FROM audit_event
        WHERE organization_id = ${venue.organization_id} AND event_code = 'arrival.check_in_override'`
      return { check_in, audit }
    })
    assert.equal(row.check_in.length, 1, 'one arrival per subject')
    assert.ok(row.check_in[0]!.auth_session_id, 'the override is recorded against the staff session')
    assert.equal(row.check_in[0]!.reason, 'Paying cash after the clinic')
    assert.equal(row.audit.length, 1)
    assert.equal(row.audit[0]!.detail['reason'], 'Paying cash after the clinic')
  })

  it('merges booking holders and registrations for the day, resolves codes, and survives a restart', async () => {
    const booking = await venue.asTenant(async (tenant) => {
      const [site] = await tenant.query<{ site_id: Uuid }[]>`
        INSERT INTO site (organization_id, site_code, display_name) VALUES (${venue.organization_id}, 'main', 'Main') RETURNING site_id`
      const [resource] = await tenant.query<{ resource_id: Uuid }[]>`
        INSERT INTO resource (organization_id, site_id, resource_code, display_name, sort_order)
        VALUES (${venue.organization_id}, ${site!.site_id}, 'court-2', 'Court 2', 2) RETURNING resource_id`
      const starts_at = new Date(Date.now() + 20 * MINUTE)
      const ends_at = new Date(Date.now() + 80 * MINUTE)
      const [session] = await tenant.query<{ session_id: Uuid }[]>`
        INSERT INTO session (organization_id, site_id, session_code, starts_at, ends_at, capacity_count, price_amount, is_published)
        VALUES (${venue.organization_id}, ${site!.site_id}, 'arrival-test', ${starts_at}, ${ends_at}, 4, 0, true) RETURNING session_id`
      await tenant.query`
        INSERT INTO session_resource (organization_id, session_id, resource_id)
        VALUES (${venue.organization_id}, ${session!.session_id}, ${resource!.resource_id})`
      const [party] = await tenant.query<{ party_id: Uuid }[]>`
        INSERT INTO party (organization_id, display_name, email_address)
        VALUES (${venue.organization_id}, 'Booking Holder', 'holder@example.com') RETURNING party_id`
      const [row] = await tenant.query<{ booking_id: Uuid; booking_code: string }[]>`
        INSERT INTO booking (organization_id, session_id, resource_id, party_id, booking_code, status, price_amount, starts_at, ends_at)
        VALUES (${venue.organization_id}, ${session!.session_id}, ${resource!.resource_id}, ${party!.party_id},
                ${`arrival-${Date.now()}`}, 'confirmed', 0, ${starts_at}, ${ends_at})
        RETURNING booking_id, booking_code`
      return row!
    })

    const date = localDate(new Date(Date.now() + 20 * MINUTE), 'Asia/Manila')
    const day = await json(await venue.request(`/api/v1/arrival/today?date=${date}`))
    const holder = day.arrival.find((one: Json) => one.subject_id === booking.booking_id)
    assert.equal(holder.subject_kind, 'booking')
    assert.equal(holder.label, 'Court 2')
    assert.equal(holder.paid_state, 'free')
    assert.equal(holder.waiver_state, 'missing')
    assert.ok(day.arrival.some((one: Json) => one.subject_kind === 'registration'))
    assert.equal(day.expected_count, day.arrival.length)

    const resolved = await venue.request('/api/v1/arrival/code/resolve', {
      method: 'POST',
      body: JSON.stringify({ code: booking.booking_code }),
    })
    assert.equal(resolved.status, 200)
    assert.equal((await json(resolved)).arrival.subject_id, booking.booking_id)

    const player = await registration(6, 30, 120)
    const scanned = await json(
      await venue.request('/api/v1/arrival/code/resolve', { method: 'POST', body: JSON.stringify({ code: player.check_in_token }) }),
    )
    assert.equal(scanned.arrival.subject_id, player.registration.program_registration_id)
    assert.equal((await venue.request('/api/v1/arrival/code/resolve', { method: 'POST', body: JSON.stringify({ code: 'nope' }) })).status, 404)

    // Waiver signed at the desk, then a one-tap check-in for the free booking.
    await venue.request('/api/v1/arrival/waiver/accept', {
      method: 'POST',
      body: JSON.stringify({ subject_kind: 'booking', subject_id: booking.booking_id }),
    })
    const tap = await venue.request('/api/v1/arrival/check-in', {
      method: 'POST',
      body: JSON.stringify({ subject_kind: 'booking', subject_id: booking.booking_id }),
    })
    assert.equal(tap.status, 201)

    // A fresh store and a fresh app — as after an API restart — still see the arrival.
    const store = createStore(TEST_DATABASE_URL!)
    try {
      const app = createCourtApp(store)
      const response = await app.request(`http://local/api/v1/arrival/today?date=${date}`, {
        headers: { authorization: `Bearer ${venue.token}` },
      })
      const fresh = (await response.json()) as Json
      const row = fresh.arrival.find((one: Json) => one.subject_id === booking.booking_id)
      assert.ok(row.check_in, 'the arrival survived the restart')
      assert.equal(fresh.arrived_count >= 1, true)
      await withTenant(store, venue.organization_id, async (tenant) => {
        const [count] = await tenant.query<{ n: number }[]>`SELECT count(*)::int AS n FROM arrival_check_in WHERE subject_id = ${booking.booking_id}`
        assert.equal(count!.n, 1)
      })
    } finally {
      await store.close()
    }
  })

  it('keeps venues apart and disappears when the module is off', async () => {
    const other = await createTestVenue('arrival-other')
    try {
      const player = await registration(7, 30, 120)
      const foreign = await other.publicRequest(`/public/${other.organization_code}/arrival/check-in`, {
        method: 'POST',
        body: JSON.stringify({ credential: player.credential }),
      })
      assert.equal(foreign.status, 404)
      const cross = await other.request('/api/v1/arrival/check-in', {
        method: 'POST',
        body: JSON.stringify({ subject_kind: 'registration', subject_id: player.registration.program_registration_id, method_code: 'staff_override', reason: 'x' }),
      })
      assert.equal(cross.status, 404)

      await other.asTenant((tenant) => disableModule(tenant, 'arrival', COURT_DECLARATION))
      assert.equal((await other.request('/api/v1/arrival/today')).status, 404)
      assert.equal((await other.publicRequest(`/public/${other.organization_code}/arrival/waiver`)).status, 404)
    } finally {
      await other.close()
    }
  })
})
