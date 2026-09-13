// R06 / R08 / B06 / B26 — venue setup from an empty organization through the
// API only, the sellable schedule, closures, the court board's desk actions,
// booking policy, tenant isolation, and the public venue read.

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { Uuid } from '@bygelo/roundrobin-kernel'
import { readBookingPolicy } from '../src/module/court/policy.ts'
import { addDay, isoWeekday, localDateKey, zonedToInstant } from '../src/module/court/time.ts'
import { TEST_DATABASE_URL, createTestVenue, type TestVenue } from './helper.ts'

const ZONE = 'Asia/Manila'

type Slot = { session_id: Uuid; resource_id: Uuid; display_name: string; starts_at: string; ends_at: string; price_amount: string }
type Court = { resource_id: Uuid; display_name: string; sort_order: number; sport_code: string; is_retired: boolean }

describe('venue setup, schedule, and court board', { skip: !TEST_DATABASE_URL }, () => {
  let venue: TestVenue
  let other: TestVenue
  const court: Court[] = []
  let schedule_id: Uuid
  const tomorrow = addDay(localDateKey(new Date(), ZONE), 1)
  const day_after = addDay(tomorrow, 1)
  const is_weekend = isoWeekday(tomorrow) >= 6

  const json = async <T>(response: Response, status: number): Promise<T> => {
    const text = await response.text()
    assert.equal(response.status, status, text)
    return JSON.parse(text) as T
  }
  const send = (target: TestVenue, path: string, method: string, body?: unknown) =>
    target.request(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

  const availability = async (date: string): Promise<Slot[]> => {
    const starts_at = zonedToInstant(date, '00:00', ZONE).toISOString()
    const ends_at = zonedToInstant(addDay(date, 1), '00:00', ZONE).toISOString()
    const body = await json<{ slot: Slot[] }>(
      await venue.request(`/api/v1/availability?starts_at=${encodeURIComponent(starts_at)}&ends_at=${encodeURIComponent(ends_at)}`),
      200,
    )
    return body.slot
  }
  const localStart = (slot: Slot) =>
    new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: ZONE }).format(new Date(slot.starts_at))
  const slotAt = async (date: string, court_name: string, time: string) => {
    const found = (await availability(date)).find((one) => one.display_name === court_name && localStart(one) === time)
    assert.ok(found, `expected a free ${court_name} slot at ${time} on ${date}`)
    return found
  }

  before(async () => {
    venue = await createTestVenue('venue')
    other = await createTestVenue('venue-other')
  })
  after(async () => {
    await venue?.close()
    await other?.close()
  })

  it('sets up a venue from an empty organization: site, sport, four ordered courts, hours', async () => {
    const empty = await json<{ checklist: Record<string, boolean> }>(await venue.request('/api/v1/court/venue'), 200)
    assert.equal(empty.checklist['has_site'], false)
    assert.equal((await venue.publicRequest(`/public/${venue.organization_code}/court/venue`)).status, 404)

    await json(await send(venue, '/api/v1/court/venue', 'PUT', { display_name: 'Test Club', time_zone: ZONE, address_line: 'Katipunan Ave' }), 200)
    await json(await send(venue, '/api/v1/court/venue', 'PUT', { display_name: 'Test Club', time_zone: 'Mars/Olympus' }), 400)

    await json(
      await send(venue, '/api/v1/court/sport', 'POST', { display_name: 'Rally Ball', team_size_count: 2, scoring_rule_code: 'not_a_rule' }),
      400,
    )
    const sport = await json<{ sport: { sport_profile_code: string; rating_provider_code: string | null } }>(
      await send(venue, '/api/v1/court/sport', 'POST', {
        sport_profile_code: 'rally_ball',
        display_name: 'Rally Ball',
        team_size_count: 2,
        scoring_rule_code: 'side_out_11',
        rating_provider_code: null,
      }),
      201,
    )
    assert.equal(sport.sport.rating_provider_code, null)

    for (const name of ['Court 1', 'Court 2', 'Court 3', 'Court 4']) {
      const created = await json<{ court: Court }>(
        await send(venue, '/api/v1/court/court', 'POST', { display_name: name, sport_code: 'rally_ball', capacity_count: 4 }),
        201,
      )
      court.push(created.court)
    }
    await json(await send(venue, '/api/v1/court/court', 'POST', { display_name: 'Court 1', sport_code: 'rally_ball' }), 409)
    assert.deepEqual(court.map((one) => one.sort_order), [1, 2, 3, 4])

    const reversed = [...court].reverse().map((one) => one.resource_id)
    const reordered = await json<{ court: Court[] }>(await send(venue, '/api/v1/court/court/order', 'POST', { resource_id: reversed }), 200)
    assert.deepEqual(reordered.court.map((one) => one.display_name), ['Court 4', 'Court 3', 'Court 2', 'Court 1'])
    await json(await send(venue, '/api/v1/court/court/order', 'POST', { resource_id: reversed.slice(1) }), 400)
    await json(await send(venue, '/api/v1/court/court/order', 'POST', { resource_id: court.map((one) => one.resource_id) }), 200)

    const hour = await json<{ operating_hour: unknown[] }>(
      await send(venue, '/api/v1/court/operating-hour', 'PUT', {
        operating_hour: [1, 2, 3, 4, 5, 6, 7].map((weekday_number) => ({ weekday_number, opens_local: '06:00', closes_local: '10:00' })),
      }),
      200,
    )
    assert.equal(hour.operating_hour.length, 7)
    await json(
      await send(venue, '/api/v1/court/operating-hour', 'PUT', { operating_hour: [{ weekday_number: 1, opens_local: '10:00', closes_local: '09:00' }] }),
      400,
    )
  })

  it('generates 60-minute slots with a peak band that appear in availability', async () => {
    const created = await json<{ schedule: { court_schedule_id: Uuid; template_count: number }; result: { created_session_count: number } }>(
      await send(venue, '/api/v1/court/schedule', 'POST', {
        sport_code: 'rally_ball',
        slot_minute_count: 60,
        off_peak_price_amount: '400',
        peak_price_amount: '600',
        horizon_day_count: 3,
        peak: [
          ...[1, 2, 3, 4, 5].map((weekday_number) => ({ weekday_number, starts_local: '08:00', ends_local: '10:00' })),
          ...[6, 7].map((weekday_number) => ({ weekday_number, starts_local: '00:00', ends_local: '24:00' })),
        ],
      }),
      201,
    )
    schedule_id = created.schedule.court_schedule_id
    assert.equal(created.schedule.template_count, 7 * 4)
    assert.ok(created.result.created_session_count >= 4 * 3)

    const slot = await availability(tomorrow)
    assert.equal(slot.length, 4 * 4, 'four hourly slots on each of four courts')
    const early = slot.find((one) => one.display_name === 'Court 1' && localStart(one) === '06:00')!
    const late = slot.find((one) => one.display_name === 'Court 1' && localStart(one) === '09:00')!
    assert.equal(early.price_amount, is_weekend ? '600.00' : '400.00')
    assert.equal(late.price_amount, '600.00')

    // Idempotent roll-forward.
    const again = await json<{ created_session_count: number }>(await send(venue, '/api/v1/court/schedule/materialize', 'POST', {}), 200)
    assert.equal(again.created_session_count, 0)
  })

  it('a dated closure removes only the slots it overlaps', async () => {
    const court_2 = court[1]!
    await json(
      await send(venue, '/api/v1/court/closure', 'POST', {
        resource_id: court_2.resource_id,
        date: tomorrow,
        starts_local: '07:00',
        ends_local: '08:00',
        reason: 'Net repair',
      }),
      201,
    )
    const slot = await availability(tomorrow)
    assert.equal(slot.length, 15)
    assert.equal(slot.some((one) => one.display_name === 'Court 2' && localStart(one) === '07:00'), false)
    assert.equal(slot.some((one) => one.display_name === 'Court 2' && localStart(one) === '06:00'), true)

    await json(await send(venue, '/api/v1/court/closure', 'POST', { date: day_after, reason: 'Typhoon signal no. 3' }), 201)
    assert.equal((await availability(day_after)).length, 0)
    assert.equal((await availability(tomorrow)).length, 15, 'the whole-day closure leaves other days alone')
  })

  it('regenerates at 90 and 120 minutes, matching the hours', async () => {
    const at90 = await json<{ schedule: { template_count: number } }>(
      await send(venue, `/api/v1/court/schedule/${schedule_id}`, 'PATCH', { slot_minute_count: 90 }),
      200,
    )
    assert.equal(at90.schedule.template_count, 7 * 2)
    let slot = await availability(tomorrow)
    assert.deepEqual([...new Set(slot.map(localStart))].sort(), ['06:00', '07:30'])
    assert.equal(slot.length, 6, 'both 90-minute slots on Court 2 overlap its 07:00 closure')

    const at120 = await json<{ schedule: { template_count: number } }>(
      await send(venue, `/api/v1/court/schedule/${schedule_id}`, 'PATCH', { slot_minute_count: 120 }),
      200,
    )
    assert.equal(at120.schedule.template_count, 7 * 2)
    slot = await availability(tomorrow)
    assert.deepEqual([...new Set(slot.map(localStart))].sort(), ['06:00', '08:00'])
    assert.equal(slot.length, 7)

    await json(await send(venue, `/api/v1/court/schedule/${schedule_id}`, 'PATCH', { slot_minute_count: 60 }), 200)
    assert.equal((await availability(tomorrow)).length, 15)
  })

  let walk_in_id: Uuid

  it('edits a court name at once, and refuses to retire or re-sport a court with a future booking', async () => {
    const court_3 = court[2]!
    const slot = await slotAt(tomorrow, 'Court 3', '09:00')
    const walk_in = await json<{ booking: { booking_id: Uuid; status: string; party_display_name: string; paid_state: string } }>(
      await send(venue, '/api/v1/court/board/walk-in', 'POST', {
        session_id: slot.session_id,
        resource_id: court_3.resource_id,
        party_display_name: 'Walk-in Wendy',
        is_paid: true,
      }),
      201,
    )
    walk_in_id = walk_in.booking.booking_id
    assert.equal(walk_in.booking.status, 'confirmed')
    assert.equal(walk_in.booking.paid_state, 'paid')

    await json(await send(venue, `/api/v1/court/court/${court_3.resource_id}`, 'PATCH', { display_name: 'Court Three' }), 200)
    const board = await json<{ court: { display_name: string; booking: { party_display_name: string }[] }[] }>(
      await venue.request(`/api/v1/court/board?date=${tomorrow}`),
      200,
    )
    const row = board.court.find((one) => one.display_name === 'Court Three')
    assert.ok(row)
    assert.equal(row.booking[0]?.party_display_name, 'Walk-in Wendy')

    const refused = await send(venue, `/api/v1/court/court/${court_3.resource_id}/retire`, 'POST', {})
    assert.equal(refused.status, 409)
    assert.match(((await refused.json()) as { error: string }).error, /Court Three has 1 upcoming booking/)

    await json(await send(venue, '/api/v1/court/sport', 'POST', { sport_profile_code: 'other_ball', display_name: 'Other Ball', team_size_count: 1, scoring_rule_code: 'rally_21' }), 201)
    await json(await send(venue, `/api/v1/court/court/${court_3.resource_id}`, 'PATCH', { sport_code: 'other_ball' }), 409)
  })

  it('a schedule edit never orphans or double-sells an existing booking', async () => {
    const result = await json<{ result: { kept_booked_session_count: number } }>(
      await send(venue, `/api/v1/court/schedule/${schedule_id}`, 'PATCH', { off_peak_price_amount: '450' }),
      200,
    )
    assert.ok(result.result.kept_booked_session_count >= 1)

    const orphan = await venue.asTenant(
      (tenant) => tenant.query<{ count: number }[]>`
        SELECT count(*)::int AS count FROM booking b JOIN session s ON s.session_id = b.session_id
        WHERE b.organization_id = ${venue.organization_id} AND b.status IN ('hold', 'confirmed') AND s.deleted_at IS NOT NULL`,
    )
    assert.equal(orphan[0]?.count, 0)

    const slot = await availability(tomorrow)
    assert.equal(slot.some((one) => one.display_name === 'Court Three' && localStart(one) === '09:00'), false)
    assert.equal(slot.some((one) => one.display_name === 'Court 1' && localStart(one) === '09:00'), true)
    if (!is_weekend) assert.equal(slot.find((one) => localStart(one) === '06:00')?.price_amount, '450.00')
  })

  it('moves a booking to a free court and refuses an overlap — including two concurrent moves', async () => {
    const court_1 = court[0]!
    const court_4 = court[3]!
    const court_2 = court[1]!
    const on_4 = await json<{ booking: { booking_id: Uuid } }>(
      await send(venue, '/api/v1/court/board/walk-in', 'POST', {
        session_id: (await slotAt(tomorrow, 'Court 4', '09:00')).session_id,
        resource_id: court_4.resource_id,
        party_display_name: 'Desk Dan',
      }),
      201,
    )

    const refused = await send(venue, `/api/v1/court/board/booking/${walk_in_id}/move`, 'POST', { resource_id: court_4.resource_id })
    assert.equal(refused.status, 409)
    assert.match(((await refused.json()) as { error: string }).error, /Court 4 is already booked/)

    const closed = await send(venue, `/api/v1/court/board/booking/${walk_in_id}/move`, 'POST', { resource_id: court_2.resource_id })
    assert.equal(closed.status, 200, 'Court 2 is open again at 09:00')

    // Two different bookings race onto the same free court and time.
    const [first, second] = await Promise.all([
      send(venue, `/api/v1/court/board/booking/${walk_in_id}/move`, 'POST', { resource_id: court_1.resource_id }),
      send(venue, `/api/v1/court/board/booking/${on_4.booking.booking_id}/move`, 'POST', { resource_id: court_1.resource_id }),
    ])
    assert.deepEqual([first.status, second.status].sort(), [200, 409])

    const occupancy = await venue.asTenant(
      (tenant) => tenant.query<{ count: number }[]>`
        SELECT count(*)::int AS count FROM booking
        WHERE organization_id = ${venue.organization_id} AND resource_id = ${court_1.resource_id}
          AND status IN ('hold', 'confirmed')`,
    )
    assert.equal(occupancy[0]?.count, 1)
  })

  it('blocks a court for maintenance only where no booking stands, and the board shows it', async () => {
    const court_4 = court[3]!
    const starts_at = zonedToInstant(tomorrow, '06:00', ZONE).toISOString()
    const ends_at = zonedToInstant(tomorrow, '07:00', ZONE).toISOString()
    await json(await send(venue, '/api/v1/court/board/maintenance', 'POST', { reason: 'Resurfacing', starts_at, ends_at }), 400)
    await json(await send(venue, '/api/v1/court/board/maintenance', 'POST', { resource_id: court_4.resource_id, reason: 'Resurfacing', starts_at, ends_at }), 201)

    const board = await json<{
      court: { resource_id: Uuid; closure: { reason: string }[]; session: { starts_at: string; is_bookable: boolean }[]; booking: unknown[] }[]
    }>(await venue.request(`/api/v1/court/board?date=${tomorrow}`), 200)
    const row = board.court.find((one) => one.resource_id === court_4.resource_id)!
    assert.equal(row.closure[0]?.reason, 'Resurfacing')
    assert.equal(row.session.find((one) => one.starts_at === starts_at)?.is_bookable, false)

    // Any court that holds a booking refuses a block over it.
    const busy = board.court.find((one) => one.booking.length > 0)!
    const busy_start = zonedToInstant(tomorrow, '09:00', ZONE).toISOString()
    const busy_end = zonedToInstant(tomorrow, '10:00', ZONE).toISOString()
    await json(await send(venue, '/api/v1/court/board/maintenance', 'POST', { resource_id: busy.resource_id, reason: 'Lights', starts_at: busy_start, ends_at: busy_end }), 409)
  })

  it('retires a court once its bookings are cancelled; its slots leave availability', async () => {
    const court_3 = court[2]!
    const board = await json<{ court: { booking: { booking_id: Uuid }[]; resource_id: Uuid }[] }>(
      await venue.request(`/api/v1/court/board?date=${tomorrow}`),
      200,
    )
    for (const row of board.court.filter((one) => one.resource_id === court_3.resource_id)) {
      for (const one of row.booking) await json(await send(venue, `/api/v1/court/board/booking/${one.booking_id}/cancel`, 'POST', {}), 200)
    }
    await json(await send(venue, `/api/v1/court/court/${court_3.resource_id}/retire`, 'POST', {}), 200)
    const active = await json<{ court: Court[] }>(await venue.request('/api/v1/court/court'), 200)
    assert.equal(active.court.length, 3)
    const all = await json<{ court: Court[] }>(await venue.request('/api/v1/court/court?is_retired_included=true'), 200)
    assert.equal(all.court.find((one) => one.resource_id === court_3.resource_id)?.is_retired, true)
    assert.equal((await availability(tomorrow)).some((one) => one.resource_id === court_3.resource_id), false)
  })

  it('saves booking policy with defaults and bounds, readable by the portal lane', async () => {
    const initial = await json<{ policy: Record<string, unknown> }>(await venue.request('/api/v1/court/policy'), 200)
    assert.deepEqual(initial.policy, {
      advance_window_day_count: 14,
      cancellation_cutoff_hour_count: 24,
      hold_minute_count: 10,
      is_guest_booking_allowed: true,
    })
    const next = { advance_window_day_count: 7, cancellation_cutoff_hour_count: 12, hold_minute_count: 15, is_guest_booking_allowed: false }
    await json(await send(venue, '/api/v1/court/policy', 'PUT', next), 200)
    assert.deepEqual(await venue.asTenant((tenant) => readBookingPolicy(tenant)), next)
    await json(await send(venue, '/api/v1/court/policy', 'PUT', { ...next, hold_minute_count: 0 }), 400)
  })

  it('publishes the venue to the portal without private data', async () => {
    const response = await venue.publicRequest(`/public/${venue.organization_code}/court/venue`)
    const body = await json<{
      site: Record<string, unknown>
      court: Record<string, unknown>[]
      operating_hour: unknown[]
      policy: { advance_window_day_count: number }
    }>(response, 200)
    assert.equal(body.site['display_name'], 'Test Club')
    assert.equal(body.court.length, 3)
    assert.deepEqual(Object.keys(body.court[0]!).sort(), ['display_name', 'resource_id', 'sort_order', 'sport_code', 'sport_display_name'])
    assert.equal(body.operating_hour.length, 7)
    assert.equal(body.policy.advance_window_day_count, 7)
    assert.doesNotMatch(JSON.stringify(body), /Walk-in Wendy|Desk Dan|organization_id/)
    assert.equal((await venue.publicRequest('/public/no-such-venue-anywhere/court/venue')).status, 404)
  })

  it('isolates tenants: a second venue cannot see or touch the first', async () => {
    const own = await json<{ court: Court[] }>(await other.request('/api/v1/court/court'), 200)
    assert.equal(own.court.length, 0)
    const board = await json<{ court: unknown[] }>(await other.request(`/api/v1/court/board?date=${tomorrow}`), 200)
    assert.equal(board.court.length, 0)

    await json(await send(other, `/api/v1/court/court/${court[0]!.resource_id}`, 'PATCH', { display_name: 'Stolen' }), 404)
    await json(await send(other, `/api/v1/court/board/booking/${walk_in_id}/cancel`, 'POST', {}), 404)
    await json(await send(other, `/api/v1/court/schedule/${schedule_id}`, 'PATCH', { peak_price_amount: '1' }), 404)
    const still = await json<{ court: Court[] }>(await venue.request('/api/v1/court/court'), 200)
    assert.equal(still.court[0]?.display_name, 'Court 1')
  })

  it('answers 404 on operator and public routes when the court module is off', async () => {
    await other.asTenant(
      (tenant) => tenant.query`
        UPDATE organization_module SET is_enabled = false, disabled_at = now()
        WHERE organization_id = ${other.organization_id} AND module_code = 'court'`,
    )
    assert.equal((await other.request('/api/v1/court/board')).status, 404)
    assert.equal((await other.publicRequest(`/public/${other.organization_code}/court/venue`)).status, 404)
  })
})
