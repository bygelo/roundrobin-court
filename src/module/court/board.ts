// The court board: one venue day, court by court, and the desk's actions on it
// — walk-in, move, cancel, maintenance block.
//
// Occupancy is still the booking pack's: a walk-in is hold + confirm, a cancel
// is the pack's cancel, and a move is an UPDATE the booking EXCLUDE constraint
// arbitrates. This file adds the sentences and the day view.

import { cancel, confirm, hold } from '@bygelo/roundrobin-booking'
import type { TenantContext, Uuid } from '@bygelo/roundrobin-kernel'
import {
  CourtConflictError,
  CourtInputError,
  CourtNotFoundError,
  formatLocalTime,
  has,
  readInteger,
  readOptionalText,
  readText,
  readUuid,
  sqlState,
  type Body,
} from './input.ts'
import { findCourt, findSite, listCourt, listOperatingHour, type Closure } from './venue.ts'
import { DEFAULT_TIME_ZONE, addDay, isDateKey, isoWeekday, localDateKey, zonedToInstant } from './time.ts'

export type BoardBooking = {
  booking_id: Uuid
  booking_code: string
  status: string
  starts_at: Date
  ends_at: Date
  price_amount: string
  hold_expire_at: Date | null
  session_id: Uuid
  resource_id: Uuid
  session_type: string
  participant_count: number
  party_display_name: string | null
  party_phone_number: string | null
  paid_state: 'paid' | 'partial' | 'unpaid' | null
  channel_code: string | null
}

export type BoardSession = {
  session_id: Uuid
  display_name: string | null
  starts_at: Date
  ends_at: Date
  price_amount: string
  session_type: string
  is_bookable: boolean
}

export type BoardCourt = {
  resource_id: Uuid
  resource_code: string
  display_name: string
  sort_order: number
  capacity_count: number | null
  sport_code: string | null
  sport_display_name: string | null
  session: BoardSession[]
  booking: BoardBooking[]
  closure: Closure[]
}

export type Board = {
  date: string
  time_zone: string
  site_display_name: string | null
  day_starts_at: Date
  day_ends_at: Date
  opens_local: string | null
  closes_local: string | null
  court: BoardCourt[]
  closure: Closure[]
}

export async function readBoard(tenant: TenantContext, date_input: string | undefined): Promise<Board> {
  const site = await findSite(tenant)
  const time_zone = site?.time_zone ?? DEFAULT_TIME_ZONE
  if (date_input !== undefined && !isDateKey(date_input)) throw new CourtInputError('Date must look like 2026-09-13.')
  const date = date_input ?? localDateKey(new Date(), time_zone)
  const day_starts_at = zonedToInstant(date, '00:00', time_zone)
  const day_ends_at = zonedToInstant(addDay(date, 1), '00:00', time_zone)

  const court = await listCourt(tenant)
  const hour = (await listOperatingHour(tenant)).find((one) => one.weekday_number === isoWeekday(date))

  const session = await tenant.query<(BoardSession & { resource_id: Uuid })[]>`
    SELECT s.session_id, s.display_name, s.starts_at, s.ends_at, s.price_amount, s.session_type,
           sr.resource_id,
           (s.ends_at > now()
             AND NOT EXISTS (SELECT 1 FROM booking b
                              WHERE b.resource_id = sr.resource_id AND b.status IN ('hold', 'confirmed')
                                AND b.starts_at < s.ends_at AND b.ends_at > s.starts_at)
             AND NOT EXISTS (SELECT 1 FROM closure c
                              WHERE (c.resource_id = sr.resource_id OR c.site_id = s.site_id)
                                AND c.starts_at < s.ends_at AND c.ends_at > s.starts_at)) AS is_bookable
    FROM session s
    JOIN session_resource sr ON sr.session_id = s.session_id
    WHERE s.organization_id = ${tenant.organization_id}
      AND s.deleted_at IS NULL AND s.is_published
      AND s.starts_at < ${day_ends_at} AND s.ends_at > ${day_starts_at}
    ORDER BY s.starts_at`

  const booking = await tenant.query<BoardBooking[]>`
    SELECT b.booking_id, b.booking_code, b.status, b.starts_at, b.ends_at, b.price_amount, b.hold_expire_at,
           b.session_id, b.resource_id, s.session_type, b.participant_count,
           p.display_name AS party_display_name, p.phone_number AS party_phone_number,
           COALESCE(
             CASE i.status WHEN 'paid' THEN 'paid' WHEN 'partial' THEN 'partial'
                           WHEN 'open' THEN 'unpaid' WHEN 'draft' THEN 'unpaid' END,
             CASE b.detail->>'paid_state' WHEN 'paid' THEN 'paid' WHEN 'unpaid' THEN 'unpaid' END
           ) AS paid_state,
           b.detail->>'channel_code' AS channel_code
    FROM booking b
    JOIN session s ON s.session_id = b.session_id
    LEFT JOIN party p ON p.party_id = b.party_id
    LEFT JOIN invoice i ON i.organization_id = b.organization_id AND i.deleted_at IS NULL
                       AND i.invoice_id::text = b.detail->>'invoice_id'
    WHERE b.organization_id = ${tenant.organization_id}
      AND b.status IN ('hold', 'confirmed')
      AND b.starts_at < ${day_ends_at} AND b.ends_at > ${day_starts_at}
    ORDER BY b.starts_at`

  const closure = await tenant.query<Closure[]>`
    SELECT c.closure_id, c.resource_id, r.display_name AS court_display_name, c.reason,
           c.starts_at, c.ends_at, (c.resource_id IS NULL) AS is_site_wide
    FROM closure c
    LEFT JOIN resource r ON r.resource_id = c.resource_id
    WHERE c.organization_id = ${tenant.organization_id}
      AND c.starts_at < ${day_ends_at} AND c.ends_at > ${day_starts_at}
    ORDER BY c.starts_at`

  return {
    date,
    time_zone,
    site_display_name: site?.display_name ?? null,
    day_starts_at,
    day_ends_at,
    opens_local: hour?.opens_local ?? null,
    closes_local: hour?.closes_local ?? null,
    closure: closure.filter((one) => one.is_site_wide),
    court: court.map((one) => ({
      resource_id: one.resource_id,
      resource_code: one.resource_code,
      display_name: one.display_name,
      sort_order: one.sort_order,
      capacity_count: one.capacity_count,
      sport_code: one.sport_code,
      sport_display_name: one.sport_display_name,
      session: session
        .filter((each) => each.resource_id === one.resource_id)
        .map(({ resource_id: _resource_id, ...each }) => each),
      booking: booking.filter((each) => each.resource_id === one.resource_id).map((each) => ({
        ...each,
        participant_count: Number(each.participant_count),
      })),
      closure: closure.filter((each) => each.resource_id === one.resource_id),
    })),
  }
}

async function assertNoClosure(tenant: TenantContext, resource_id: Uuid, display_name: string, starts_at: Date, ends_at: Date) {
  const [closure] = await tenant.query<{ reason: string }[]>`
    SELECT c.reason FROM closure c
    JOIN resource r ON r.resource_id = ${resource_id}
    WHERE c.organization_id = ${tenant.organization_id}
      AND (c.resource_id = r.resource_id OR c.site_id = r.site_id)
      AND c.starts_at < ${ends_at} AND c.ends_at > ${starts_at}
    LIMIT 1`
  if (closure) throw new CourtConflictError(`${display_name} is closed at that time (${closure.reason}).`)
}

/** Walk-in: a named party, a hold, and an immediate confirm — the pack's own path. */
export async function createWalkIn(tenant: TenantContext, body: Body): Promise<BoardBooking> {
  const session_id = readUuid(body, 'session_id', 'Slot')
  const resource_id = readUuid(body, 'resource_id', 'Court')
  const party_display_name = readText(body, 'party_display_name', 'Player name', { max: 120 })
  const phone_number = readOptionalText(body, 'phone_number', 'Phone', { max: 40 })
  const participant_count = has(body, 'participant_count') ? readInteger(body, 'participant_count', 'Players', 1, 40) : 4
  const is_paid = body['is_paid'] === true

  const court = await findCourt(tenant, resource_id)
  if (court.is_retired) throw new CourtConflictError(`${court.display_name} is retired.`)
  const [session] = await tenant.query<{ starts_at: Date; ends_at: Date; is_claimed: boolean }[]>`
    SELECT s.starts_at, s.ends_at,
           EXISTS (SELECT 1 FROM session_resource sr WHERE sr.session_id = s.session_id AND sr.resource_id = ${resource_id}) AS is_claimed
    FROM session s
    WHERE s.organization_id = ${tenant.organization_id} AND s.session_id = ${session_id} AND s.deleted_at IS NULL`
  if (!session || !session.is_claimed) throw new CourtNotFoundError(`That slot is not sold on ${court.display_name}.`)
  if (session.ends_at <= new Date()) throw new CourtConflictError('That slot has already ended.')
  await assertNoClosure(tenant, resource_id, court.display_name, session.starts_at, session.ends_at)

  const [party] = await tenant.query<{ party_id: Uuid }[]>`
    INSERT INTO party (organization_id, display_name, phone_number, detail)
    VALUES (${tenant.organization_id}, ${party_display_name}, ${phone_number}, ${tenant.query.json({ source_code: 'walk_in' })})
    RETURNING party_id`
  const held = await hold(tenant, { session_id, resource_id, party_id: party!.party_id, participant_count })
  await confirm(tenant, held.booking_code)
  await tenant.query`
    UPDATE booking SET detail = detail || ${tenant.query.json({ channel_code: 'walk_in', paid_state: is_paid ? 'paid' : 'unpaid' })}
    WHERE organization_id = ${tenant.organization_id} AND booking_id = ${held.booking_id}`
  return findBoardBooking(tenant, held.booking_id)
}

async function findBoardBooking(tenant: TenantContext, booking_id: Uuid): Promise<BoardBooking> {
  const [row] = await tenant.query<{ starts_at: Date }[]>`
    SELECT starts_at FROM booking WHERE organization_id = ${tenant.organization_id} AND booking_id = ${booking_id}`
  if (!row) throw new CourtNotFoundError('That booking does not exist.')
  const site = await findSite(tenant)
  const board = await readBoard(tenant, localDateKey(row.starts_at, site?.time_zone ?? DEFAULT_TIME_ZONE))
  for (const court of board.court) {
    const found = court.booking.find((one) => one.booking_id === booking_id)
    if (found) return found
  }
  throw new CourtNotFoundError('That booking is no longer active.')
}

type ActiveBooking = {
  booking_id: Uuid
  booking_code: string
  status: string
  session_id: Uuid
  resource_id: Uuid
  starts_at: Date
  ends_at: Date
  court_display_name: string
}

async function findActiveBooking(tenant: TenantContext, booking_id: Uuid): Promise<ActiveBooking> {
  const [row] = await tenant.query<ActiveBooking[]>`
    SELECT b.booking_id, b.booking_code, b.status, b.session_id, b.resource_id, b.starts_at, b.ends_at,
           r.display_name AS court_display_name
    FROM booking b JOIN resource r ON r.resource_id = b.resource_id
    WHERE b.organization_id = ${tenant.organization_id} AND b.booking_id = ${booking_id}`
  if (!row) throw new CourtNotFoundError('That booking does not exist.')
  if (row.status !== 'hold' && row.status !== 'confirmed') {
    throw new CourtConflictError(`This booking is already ${row.status}.`)
  }
  return row
}

/**
 * Move a booking to another court for the same time.
 *
 * The overlap probe exists to produce a sentence; the booking EXCLUDE
 * constraint is still the arbiter, and a concurrent refusal inside the
 * savepoint becomes the same 409.
 */
export async function moveBooking(tenant: TenantContext, booking_id: Uuid, body: Body): Promise<BoardBooking> {
  const target_id = readUuid(body, 'resource_id', 'Court to move to')
  const booking = await findActiveBooking(tenant, booking_id)
  if (booking.resource_id === target_id) throw new CourtInputError(`This booking is already on ${booking.court_display_name}.`)
  const target = await findCourt(tenant, target_id)
  if (target.is_retired) throw new CourtConflictError(`${target.display_name} is retired.`)
  const site = await findSite(tenant)
  const time_zone = site?.time_zone ?? DEFAULT_TIME_ZONE

  await assertNoClosure(tenant, target_id, target.display_name, booking.starts_at, booking.ends_at)

  const [session] = await tenant.query<{ session_id: Uuid }[]>`
    SELECT s.session_id FROM session s
    JOIN session_resource sr ON sr.session_id = s.session_id AND sr.resource_id = ${target_id}
    WHERE s.organization_id = ${tenant.organization_id} AND s.deleted_at IS NULL
      AND s.starts_at <= ${booking.starts_at} AND s.ends_at >= ${booking.ends_at}
    ORDER BY (s.session_id = ${booking.session_id}) DESC, s.is_published DESC
    LIMIT 1`
  if (!session) {
    throw new CourtConflictError(`${target.display_name} is not sold at that time, so the booking cannot move there.`)
  }

  const taken = `${target.display_name} is already booked for ${formatLocalTime(booking.starts_at, time_zone)} – ${formatLocalTime(booking.ends_at, time_zone)}.`
  const [clash] = await tenant.query<{ booking_id: Uuid }[]>`
    SELECT booking_id FROM booking
    WHERE organization_id = ${tenant.organization_id} AND resource_id = ${target_id}
      AND status IN ('hold', 'confirmed') AND starts_at < ${booking.ends_at} AND ends_at > ${booking.starts_at}
    LIMIT 1`
  if (clash) throw new CourtConflictError(taken)

  try {
    await tenant.query.savepoint(async (sp) => {
      const query = sp as unknown as TenantContext['query']
      await query`
        UPDATE booking
        SET resource_id = ${target_id}, session_id = ${session.session_id},
            detail = detail || ${tenant.query.json({ moved_from_resource_id: booking.resource_id })}
        WHERE organization_id = ${tenant.organization_id} AND booking_id = ${booking_id}`
    })
  } catch (error) {
    if (sqlState(error) === '23P01') throw new CourtConflictError(taken)
    throw error
  }
  return findBoardBooking(tenant, booking_id)
}

export async function cancelBooking(tenant: TenantContext, booking_id: Uuid): Promise<void> {
  const booking = await findActiveBooking(tenant, booking_id)
  await cancel(tenant, booking.booking_code)
}
