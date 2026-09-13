// R10 — program and event, against a real database.

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { disableModule, type Uuid } from '@bygelo/roundrobin-kernel'
import { COURT_DECLARATION } from '../src/app.ts'
import { addDay, isoWeekday, localDate } from '../src/module/program/schedule.ts'
import { TEST_DATABASE_URL, createTestVenue, type TestVenue } from './helper.ts'

const TIME_ZONE = 'Asia/Manila'
const today = () => localDate(new Date(), TIME_ZONE)

type Json = Record<string, any>

async function json(response: Response): Promise<Json> {
  const text = await response.text()
  return text ? (JSON.parse(text) as Json) : {}
}

function onceProgram(overrides: Json = {}, schedule: Json = {}): Json {
  return {
    kind_code: 'clinic',
    title: 'Beginner Clinic',
    host_name: 'Coach Mia',
    price_amount: '350',
    capacity_count: 8,
    is_published: true,
    ...overrides,
    schedule: {
      schedule_code: 'once',
      first_date: addDay(today(), 3),
      starts_local: '18:00',
      ends_local: '19:30',
      ...schedule,
    },
  }
}

async function createOccurrence(venue: TestVenue, body: Json): Promise<{ program_id: Uuid; program_occurrence_id: Uuid }> {
  const created = await venue.request('/api/v1/program', { method: 'POST', body: JSON.stringify(body) })
  assert.equal(created.status, 201, JSON.stringify(await created.clone().json()))
  const { program } = await json(created)
  const [row] = await venue.asTenant((tenant) =>
    tenant.query<{ program_occurrence_id: Uuid }[]>`
      SELECT program_occurrence_id FROM program_occurrence WHERE program_id = ${program.program_id} ORDER BY starts_at`,
  )
  return { program_id: program.program_id, program_occurrence_id: row!.program_occurrence_id }
}

function registerPublic(venue: TestVenue, occurrence_id: string, index: number, organization_code = venue.organization_code) {
  return venue.publicRequest(`/public/${organization_code}/program/occurrence/${occurrence_id}/registration`, {
    method: 'POST',
    body: JSON.stringify({ display_name: `Player ${index}`, email: `player${index}@example.com`, phone: '+63 917 555 0100' }),
  })
}

describe('program and event (R10)', { skip: !TEST_DATABASE_URL }, () => {
  let venue: TestVenue
  before(async () => {
    venue = await createTestVenue('program')
  })
  after(() => venue.close())

  it('publishes a weekly clinic, materializes it idempotently, and honours a skipped date', async () => {
    const first_date = addDay(today(), 1)
    // Find the first Tuesday on or after first_date, then skip it.
    let tuesday = first_date
    while (isoWeekday(tuesday) !== 2) tuesday = addDay(tuesday, 1)
    const created = await venue.request('/api/v1/program', {
      method: 'POST',
      body: JSON.stringify(
        onceProgram({ title: 'Weekly Clinic' }, {
          schedule_code: 'weekly',
          weekday_number: [2, 4],
          first_date,
          until_date: addDay(first_date, 27),
          skipped_date: [tuesday],
        }),
      ),
    })
    assert.equal(created.status, 201)
    const body = await json(created)
    const program_id = body.program.program_id as string
    // 4 weeks of Tue/Thu = 8, minus the skipped Tuesday.
    assert.equal(body.materialize.created_count, 7)

    const again = await json(await venue.request(`/api/v1/program/${program_id}/generate`, { method: 'POST' }))
    assert.equal(again.materialize.created_count, 0, 'a second materialization creates nothing')

    let thursday = first_date
    while (isoWeekday(thursday) !== 4) thursday = addDay(thursday, 1)
    const skipped = await json(
      await venue.request(`/api/v1/program/${program_id}/skip`, { method: 'POST', body: JSON.stringify({ occurrence_date: thursday }) }),
    )
    assert.ok(skipped.skipped_date.includes(thursday))
    const [count] = await venue.asTenant((tenant) =>
      tenant.query<{ n: number }[]>`SELECT count(*)::int AS n FROM program_occurrence WHERE program_id = ${program_id}`,
    )
    assert.equal(count!.n, 6)
    const regenerated = await json(await venue.request(`/api/v1/program/${program_id}/generate`, { method: 'POST' }))
    assert.equal(regenerated.materialize.created_count, 0, 'a skipped date never comes back')
  })

  it('seats eight, waitlists the ninth, shows the credential once, and the public list names nobody', async () => {
    const { program_occurrence_id } = await createOccurrence(venue, onceProgram({ title: 'Capacity Eight' }))
    const credential: string[] = []
    for (let index = 1; index <= 9; index += 1) {
      const response = await registerPublic(venue, program_occurrence_id, index)
      assert.equal(response.status, 201)
      const body = await json(response)
      assert.equal(body.registration.status_code, index <= 8 ? 'registered' : 'waitlisted')
      assert.ok(typeof body.credential === 'string' && body.credential.length >= 24)
      assert.ok(body.check_in_token, 'scan is enabled, so a QR token is issued')
      credential.push(body.credential)
    }

    const detail = await json(await venue.request(`/api/v1/program/occurrence/${program_occurrence_id}`))
    assert.equal(detail.registration.length, 9)
    assert.ok(!JSON.stringify(detail).includes(credential[0]!), 'the operator never sees a credential')
    assert.ok(!JSON.stringify(detail).includes('credential_hash'))

    const list = await venue.publicRequest(`/public/${venue.organization_code}/program`)
    assert.equal(list.status, 200)
    const text = await list.text()
    const one = (JSON.parse(text) as Json).occurrence.find((row: Json) => row.program_occurrence_id === program_occurrence_id)
    assert.equal(one.spot_left_count, 0)
    assert.equal(one.is_waitlist, true)
    for (const secret of ['player1@example.com', 'Player 1', '+63 917', 'party_id', 'paid_at', 'credential']) {
      assert.ok(!text.includes(secret), `public list leaked ${secret}`)
    }
  })

  it('gives the last seat to exactly one of many concurrent registrants', async () => {
    const { program_occurrence_id } = await createOccurrence(venue, onceProgram({ title: 'Last Seat', capacity_count: 3 }))
    for (let index = 1; index <= 2; index += 1) assert.equal((await registerPublic(venue, program_occurrence_id, 100 + index)).status, 201)

    const response = await Promise.all(Array.from({ length: 8 }, (_, index) => registerPublic(venue, program_occurrence_id, 200 + index)))
    const body = await Promise.all(response.map(json))
    assert.deepEqual(response.map((one) => one.status), Array(8).fill(201))
    assert.equal(body.filter((one) => one.registration.status_code === 'registered').length, 1)
    const position = body.filter((one) => one.registration.status_code === 'waitlisted').map((one) => one.registration.waitlist_position)
    assert.deepEqual([...position].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7])

    const [seat] = await venue.asTenant((tenant) =>
      tenant.query<{ n: number }[]>`
        SELECT count(*)::int AS n FROM program_registration
        WHERE program_occurrence_id = ${program_occurrence_id} AND status_code = 'registered'`,
    )
    assert.equal(seat!.n, 3)
  })

  it('refuses an over-capacity seat in the database itself', async () => {
    const { program_occurrence_id } = await createOccurrence(venue, onceProgram({ title: 'Trigger', capacity_count: 1 }))
    assert.equal((await registerPublic(venue, program_occurrence_id, 300)).status, 201)
    await assert.rejects(
      venue.asTenant((tenant) =>
        tenant.query`
          INSERT INTO program_registration (organization_id, program_occurrence_id, display_name, email_address, status_code, credential_hash)
          VALUES (${venue.organization_id}, ${program_occurrence_id}, 'Sneaky', 'sneaky@example.com', 'registered', 'x')`,
      ),
      (error: { code?: string }) => error.code === '23514',
    )
  })

  it('refuses a second active registration for the same player', async () => {
    const { program_occurrence_id } = await createOccurrence(venue, onceProgram({ title: 'Once Per Player' }))
    assert.equal((await registerPublic(venue, program_occurrence_id, 400)).status, 201)
    const again = await registerPublic(venue, program_occurrence_id, 400)
    assert.equal(again.status, 409)
    assert.match((await json(again)).error, /already registered/)
  })

  it('a player cancel with their credential promotes exactly one waitlisted player', async () => {
    const { program_occurrence_id } = await createOccurrence(venue, onceProgram({ title: 'Promote', capacity_count: 1 }))
    const holder = await json(await registerPublic(venue, program_occurrence_id, 500))
    await registerPublic(venue, program_occurrence_id, 501)
    await registerPublic(venue, program_occurrence_id, 502)
    const id = holder.registration.program_registration_id

    const wrong = await venue.publicRequest(`/public/${venue.organization_code}/program/registration/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ credential: 'not-the-credential' }),
    })
    assert.equal(wrong.status, 404)

    const lookup = await json(
      await venue.publicRequest(`/public/${venue.organization_code}/program/registration/lookup`, {
        method: 'POST',
        body: JSON.stringify({ credential: holder.credential }),
      }),
    )
    assert.equal(lookup.registration.program_registration_id, id)
    assert.equal(lookup.registration.credential, undefined)

    const cancel = await venue.publicRequest(`/public/${venue.organization_code}/program/registration/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ credential: holder.credential }),
    })
    assert.equal(cancel.status, 200)
    assert.equal((await json(cancel)).is_seat_passed_on, true)

    const detail = await json(await venue.request(`/api/v1/program/occurrence/${program_occurrence_id}`))
    const status = Object.fromEntries(detail.registration.map((one: Json) => [one.display_name, one.status_code]))
    assert.deepEqual(status, { 'Player 500': 'cancelled', 'Player 501': 'registered', 'Player 502': 'waitlisted' })
    const waiting = detail.registration.find((one: Json) => one.display_name === 'Player 502')
    assert.equal(waiting.waitlist_rank, 1)

    const replay = await venue.publicRequest(`/public/${venue.organization_code}/program/registration/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ credential: holder.credential }),
    })
    assert.equal((await json(replay)).is_replay, true)
    const after_replay = await json(await venue.request(`/api/v1/program/occurrence/${program_occurrence_id}`))
    assert.equal(after_replay.registration.filter((one: Json) => one.status_code === 'registered').length, 1)
  })

  it('lets staff mark a no-show and cancel an occurrence, notifying nobody twice', async () => {
    const { program_occurrence_id } = await createOccurrence(venue, onceProgram({ title: 'No Show' }))
    const one = await json(await registerPublic(venue, program_occurrence_id, 600))
    const id = one.registration.program_registration_id
    const marked = await venue.request(`/api/v1/program/registration/${id}/no-show`, { method: 'POST' })
    assert.equal(marked.status, 200)
    assert.equal((await json(marked)).status_code, 'no_show')

    await registerPublic(venue, program_occurrence_id, 601)
    const cancelled = await json(
      await venue.request(`/api/v1/program/occurrence/${program_occurrence_id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'Court resurfacing' }),
      }),
    )
    assert.equal(cancelled.cancelled_registration_count, 1)
    const again = await json(await venue.request(`/api/v1/program/occurrence/${program_occurrence_id}/cancel`, { method: 'POST' }))
    assert.equal(again.is_replay, true)
    const late = await registerPublic(venue, program_occurrence_id, 602)
    assert.equal(late.status, 409)
  })

  it('holds the program court through the booking pack and reports a clash', async () => {
    const resource_id = await venue.asTenant(async (tenant) => {
      const [site] = await tenant.query<{ site_id: Uuid }[]>`
        INSERT INTO site (organization_id, site_code, display_name) VALUES (${venue.organization_id}, 'main', 'Main') RETURNING site_id`
      const [resource] = await tenant.query<{ resource_id: Uuid }[]>`
        INSERT INTO resource (organization_id, site_id, resource_code, display_name, sort_order)
        VALUES (${venue.organization_id}, ${site!.site_id}, 'court-1', 'Court 1', 1) RETURNING resource_id`
      return resource!.resource_id
    })
    const first = await json(
      await venue.request('/api/v1/program', { method: 'POST', body: JSON.stringify(onceProgram({ title: 'On Court', resource_id })) }),
    )
    assert.deepEqual(first.materialize.court_conflict_date, [])
    const [held] = await venue.asTenant((tenant) =>
      tenant.query<{ status: string }[]>`
        SELECT b.status::text AS status FROM program_occurrence o JOIN booking b ON b.booking_id = o.booking_id
        WHERE o.program_id = ${first.program.program_id}`,
    )
    assert.equal(held?.status, 'confirmed')

    const second = await json(
      await venue.request('/api/v1/program', { method: 'POST', body: JSON.stringify(onceProgram({ title: 'Clash', resource_id })) }),
    )
    assert.equal(second.materialize.court_conflict_date.length, 1)
  })

  it('keeps one venue out of another venue’s programs', async () => {
    const other = await createTestVenue('program-other')
    try {
      const { program_occurrence_id } = await createOccurrence(venue, onceProgram({ title: 'Private To A' }))
      assert.equal((await other.request(`/api/v1/program/occurrence/${program_occurrence_id}`)).status, 404)
      assert.equal((await registerPublic(other, program_occurrence_id, 700, other.organization_code)).status, 404)
      const list = await json(await other.publicRequest(`/public/${other.organization_code}/program`))
      assert.equal(list.occurrence.length, 0)
    } finally {
      await other.close()
    }
  })

  it('answers 404 everywhere once the module is disabled', async () => {
    const off = await createTestVenue('program-off')
    try {
      await off.asTenant((tenant) => disableModule(tenant, 'program', COURT_DECLARATION))
      assert.equal((await off.request('/api/v1/program')).status, 404)
      assert.equal((await off.publicRequest(`/public/${off.organization_code}/program`)).status, 404)
    } finally {
      await off.close()
    }
  })
})
