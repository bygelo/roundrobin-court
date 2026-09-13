// Venue setup: the site, its courts, weekly hours, and dated closures (R06).
//
// Courts are booking-pack resources; a court's sport is its resource category.
// Nothing here names a sport.

import type { TenantContext, Uuid } from '@bygelo/roundrobin-kernel'
import {
  CourtConflictError,
  CourtInputError,
  CourtNotFoundError,
  formatLocalDateTime,
  has,
  isUuid,
  plural,
  readInstant,
  readInteger,
  readOptionalText,
  readText,
  type Body,
} from './input.ts'
import { ensureSportCategory } from './sport.ts'
import {
  DEFAULT_TIME_ZONE,
  addDay,
  formatTimeMinute,
  isDateKey,
  isTimeLocal,
  isTimeZone,
  parseTimeMinute,
  zonedToInstant,
  type OperatingHour,
} from './time.ts'

// ---------------------------------------------------------------------------
// site
// ---------------------------------------------------------------------------

export type Site = {
  site_id: Uuid
  site_code: string
  display_name: string
  address_line: string | null
  time_zone: string
  contact_phone_number: string | null
  contact_email_address: string | null
}

export async function findSite(tenant: TenantContext): Promise<Site | undefined> {
  const [row] = await tenant.query<(Omit<Site, 'time_zone'> & { time_zone: string | null })[]>`
    SELECT s.site_id, s.site_code, s.display_name, s.address_line, s.time_zone,
           d.contact_phone_number, d.contact_email_address
    FROM site s
    LEFT JOIN court_site_detail d ON d.site_id = s.site_id
    WHERE s.organization_id = ${tenant.organization_id} AND s.deleted_at IS NULL
    ORDER BY s.created_at, s.site_code
    LIMIT 1`
  if (!row) return undefined
  return { ...row, time_zone: row.time_zone ?? DEFAULT_TIME_ZONE }
}

export async function requireSite(tenant: TenantContext): Promise<Site> {
  const site = await findSite(tenant)
  if (!site) throw new CourtConflictError('Set up the venue name and time zone first.')
  return site
}

export async function saveSite(tenant: TenantContext, body: Body): Promise<{ site: Site; is_time_zone_changed: boolean }> {
  const display_name = readText(body, 'display_name', 'Venue name', { max: 120 })
  const time_zone = typeof body['time_zone'] === 'string' && body['time_zone'] ? body['time_zone'] : DEFAULT_TIME_ZONE
  if (!isTimeZone(time_zone)) throw new CourtInputError(`"${time_zone}" is not a time zone this server recognises.`)
  const address_line = readOptionalText(body, 'address_line', 'Address', { max: 240 })
  const contact_phone_number = readOptionalText(body, 'contact_phone_number', 'Contact phone', { max: 40 })
  const contact_email_address = readOptionalText(body, 'contact_email_address', 'Contact email', { max: 160 })
  if (contact_email_address && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact_email_address)) {
    throw new CourtInputError('Contact email must look like name@example.com.')
  }

  const prior = await findSite(tenant)
  let site_id: Uuid
  if (prior) {
    site_id = prior.site_id
    await tenant.query`
      UPDATE site SET display_name = ${display_name}, address_line = ${address_line}, time_zone = ${time_zone}
      WHERE organization_id = ${tenant.organization_id} AND site_id = ${site_id}`
  } else {
    const [row] = await tenant.query<{ site_id: Uuid }[]>`
      INSERT INTO site (organization_id, site_code, display_name, address_line, time_zone)
      VALUES (${tenant.organization_id}, 'main', ${display_name}, ${address_line}, ${time_zone})
      RETURNING site_id`
    site_id = row!.site_id
  }
  await tenant.query`
    INSERT INTO court_site_detail (organization_id, site_id, contact_phone_number, contact_email_address)
    VALUES (${tenant.organization_id}, ${site_id}, ${contact_phone_number}, ${contact_email_address})
    ON CONFLICT (site_id) DO UPDATE SET
      contact_phone_number = EXCLUDED.contact_phone_number,
      contact_email_address = EXCLUDED.contact_email_address`
  const site = (await findSite(tenant))!
  return { site, is_time_zone_changed: prior !== undefined && prior.time_zone !== time_zone }
}

// ---------------------------------------------------------------------------
// court
// ---------------------------------------------------------------------------

export type Court = {
  resource_id: Uuid
  resource_code: string
  display_name: string
  sort_order: number
  capacity_count: number | null
  resource_category_id: Uuid | null
  sport_code: string | null
  sport_display_name: string | null
  is_retired: boolean
  upcoming_booking_count: number
}

export async function listCourt(tenant: TenantContext, option: { is_retired_included?: boolean } = {}): Promise<Court[]> {
  const is_retired_included = option.is_retired_included ?? false
  const row = await tenant.query<Court[]>`
    SELECT r.resource_id, r.resource_code, r.display_name, r.sort_order, r.capacity_count,
           category.resource_category_id,
           category.resource_category_code AS sport_code,
           COALESCE(sp.display_name, category.display_name) AS sport_display_name,
           (r.deleted_at IS NOT NULL) AS is_retired,
           (SELECT count(*)::int FROM booking b
             WHERE b.organization_id = r.organization_id AND b.resource_id = r.resource_id
               AND b.status IN ('hold', 'confirmed') AND b.ends_at > now()) AS upcoming_booking_count
    FROM resource r
    JOIN site s ON s.site_id = r.site_id AND s.deleted_at IS NULL
    LEFT JOIN LATERAL (
      SELECT rc.resource_category_id, rc.resource_category_code, rc.display_name
      FROM resource_category_link rcl
      JOIN resource_category rc ON rc.resource_category_id = rcl.resource_category_id
      WHERE rcl.resource_id = r.resource_id
      ORDER BY rcl.created_at
      LIMIT 1
    ) category ON true
    LEFT JOIN sport_profile sp
      ON sp.organization_id = r.organization_id AND sp.sport_profile_code = category.resource_category_code
    WHERE r.organization_id = ${tenant.organization_id}
      AND (${is_retired_included} OR r.deleted_at IS NULL)
    ORDER BY (r.deleted_at IS NOT NULL), r.sort_order, r.resource_code`
  return [...row]
}

export async function findCourt(tenant: TenantContext, resource_id: Uuid): Promise<Court> {
  const court = (await listCourt(tenant, { is_retired_included: true })).find((one) => one.resource_id === resource_id)
  if (!court) throw new CourtNotFoundError('That court does not exist.')
  return court
}

async function resolveSportCategory(tenant: TenantContext, body: Body): Promise<Uuid> {
  const sport_code = body['sport_code']
  if (typeof sport_code !== 'string' || sport_code === '') throw new CourtInputError('Choose the sport this court is for.')
  const [profile] = await tenant.query<{ display_name: string }[]>`
    SELECT display_name FROM sport_profile
    WHERE organization_id = ${tenant.organization_id} AND sport_profile_code = ${sport_code}`
  if (!profile) throw new CourtInputError('Add that sport under Sports before assigning a court to it.')
  return ensureSportCategory(tenant, sport_code, profile.display_name)
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'court'
  )
}

export async function createCourt(tenant: TenantContext, body: Body): Promise<Court> {
  const site = await requireSite(tenant)
  const display_name = readText(body, 'display_name', 'Court name', { max: 60 })
  const capacity_count = has(body, 'capacity_count') ? readInteger(body, 'capacity_count', 'Player capacity', 1, 40) : 4
  const resource_category_id = await resolveSportCategory(tenant, body)

  await assertCourtNameFree(tenant, site.site_id, display_name)

  const base = slugify(display_name)
  const taken = await tenant.query<{ resource_code: string }[]>`
    SELECT resource_code FROM resource
    WHERE organization_id = ${tenant.organization_id} AND site_id = ${site.site_id}
      AND (resource_code = ${base} OR resource_code LIKE ${`${base}-%`})`
  const taken_code = new Set(taken.map((one) => one.resource_code))
  let resource_code = base
  for (let suffix = 2; taken_code.has(resource_code); suffix += 1) resource_code = `${base}-${suffix}`

  const [row] = await tenant.query<{ resource_id: Uuid }[]>`
    INSERT INTO resource (organization_id, site_id, resource_code, display_name, sort_order, capacity_count)
    VALUES (${tenant.organization_id}, ${site.site_id}, ${resource_code}, ${display_name},
            COALESCE((SELECT max(sort_order) + 1 FROM resource
                       WHERE organization_id = ${tenant.organization_id} AND site_id = ${site.site_id}
                         AND deleted_at IS NULL), 1),
            ${capacity_count})
    RETURNING resource_id`
  await tenant.query`
    INSERT INTO resource_category_link (organization_id, resource_id, resource_category_id)
    VALUES (${tenant.organization_id}, ${row!.resource_id}, ${resource_category_id})`
  return findCourt(tenant, row!.resource_id)
}

async function assertCourtNameFree(tenant: TenantContext, site_id: Uuid, display_name: string, except?: Uuid) {
  const [clash] = await tenant.query<{ resource_id: Uuid }[]>`
    SELECT resource_id FROM resource
    WHERE organization_id = ${tenant.organization_id} AND site_id = ${site_id} AND deleted_at IS NULL
      AND lower(display_name) = lower(${display_name})
      AND resource_id <> ${except ?? '00000000-0000-0000-0000-000000000000'}`
  if (clash) throw new CourtConflictError(`Another court is already called "${display_name}".`)
}

/** Returns whether the sport changed, so the caller can relink the schedule. */
export async function updateCourt(
  tenant: TenantContext,
  resource_id: Uuid,
  body: Body,
): Promise<{ court: Court; is_sport_changed: boolean }> {
  const prior = await findCourt(tenant, resource_id)
  if (prior.is_retired) throw new CourtConflictError(`${prior.display_name} is retired and can no longer be edited.`)
  const site = await requireSite(tenant)

  const display_name = has(body, 'display_name') ? readText(body, 'display_name', 'Court name', { max: 60 }) : prior.display_name
  if (display_name !== prior.display_name) await assertCourtNameFree(tenant, site.site_id, display_name, resource_id)
  const capacity_count = has(body, 'capacity_count')
    ? readInteger(body, 'capacity_count', 'Player capacity', 1, 40)
    : prior.capacity_count

  let is_sport_changed = false
  if (has(body, 'sport_code') && body['sport_code'] !== prior.sport_code) {
    if (prior.upcoming_booking_count > 0) {
      throw new CourtConflictError(
        `${prior.display_name} has ${plural(prior.upcoming_booking_count, 'upcoming booking')}. Move or cancel them before changing its sport.`,
      )
    }
    const resource_category_id = await resolveSportCategory(tenant, body)
    await tenant.query`
      DELETE FROM resource_category_link
      WHERE organization_id = ${tenant.organization_id} AND resource_id = ${resource_id}`
    await tenant.query`
      INSERT INTO resource_category_link (organization_id, resource_id, resource_category_id)
      VALUES (${tenant.organization_id}, ${resource_id}, ${resource_category_id})`
    is_sport_changed = true
  }

  await tenant.query`
    UPDATE resource SET display_name = ${display_name}, capacity_count = ${capacity_count}
    WHERE organization_id = ${tenant.organization_id} AND resource_id = ${resource_id}`
  return { court: await findCourt(tenant, resource_id), is_sport_changed }
}

export async function orderCourt(tenant: TenantContext, body: Body): Promise<Court[]> {
  const order = body['resource_id']
  if (!Array.isArray(order) || !order.every(isUuid)) {
    throw new CourtInputError('Send resource_id as the list of courts in their new order.')
  }
  const active = await listCourt(tenant)
  const active_id = new Set(active.map((one) => one.resource_id))
  if (order.length !== active.length || new Set(order).size !== order.length || !order.every((one) => active_id.has(one))) {
    throw new CourtInputError('The new order must list every active court exactly once.')
  }
  for (const [index, resource_id] of order.entries()) {
    await tenant.query`
      UPDATE resource SET sort_order = ${index + 1}
      WHERE organization_id = ${tenant.organization_id} AND resource_id = ${resource_id}`
  }
  return listCourt(tenant)
}

export async function retireCourt(tenant: TenantContext, resource_id: Uuid): Promise<Court> {
  const court = await findCourt(tenant, resource_id)
  if (court.is_retired) return court
  // Lock the resource row so a concurrent booking cannot slip in between the
  // count and the retire. A hold inserted after this commits is refused by
  // listAvailable (deleted_at) and by the detached session_resource link.
  await tenant.query`
    SELECT resource_id FROM resource
    WHERE organization_id = ${tenant.organization_id} AND resource_id = ${resource_id} FOR UPDATE`
  const [count] = await tenant.query<{ upcoming_booking_count: number }[]>`
    SELECT count(*)::int AS upcoming_booking_count FROM booking
    WHERE organization_id = ${tenant.organization_id} AND resource_id = ${resource_id}
      AND status IN ('hold', 'confirmed') AND ends_at > now()`
  const upcoming = count?.upcoming_booking_count ?? 0
  if (upcoming > 0) {
    throw new CourtConflictError(
      `${court.display_name} has ${plural(upcoming, 'upcoming booking')}. Move or cancel ${upcoming === 1 ? 'it' : 'them'} before retiring the court.`,
    )
  }
  await tenant.query`
    UPDATE resource SET deleted_at = now(), is_bookable = false
    WHERE organization_id = ${tenant.organization_id} AND resource_id = ${resource_id}`
  return findCourt(tenant, resource_id)
}

// ---------------------------------------------------------------------------
// operating hour
// ---------------------------------------------------------------------------

export async function listOperatingHour(tenant: TenantContext): Promise<OperatingHour[]> {
  const site = await findSite(tenant)
  if (!site) return []
  const row = await tenant.query<{ weekday_number: number; opens_local: string; closes_local: string }[]>`
    SELECT weekday_number, opens_local::text AS opens_local, closes_local::text AS closes_local
    FROM court_operating_hour
    WHERE organization_id = ${tenant.organization_id} AND site_id = ${site.site_id}
    ORDER BY weekday_number`
  return row.map((one) => ({
    weekday_number: Number(one.weekday_number),
    opens_local: one.opens_local.slice(0, 5),
    closes_local: one.closes_local.slice(0, 5),
  }))
}

/** Replace the weekly hours. A weekday absent from the list is closed. */
export async function saveOperatingHour(tenant: TenantContext, body: Body): Promise<OperatingHour[]> {
  const site = await requireSite(tenant)
  const input = body['operating_hour']
  if (!Array.isArray(input)) throw new CourtInputError('Send operating_hour as a list of weekday hours.')
  const seen = new Set<number>()
  const hour: OperatingHour[] = []
  for (const one of input as Body[]) {
    const weekday_number = readInteger(one ?? {}, 'weekday_number', 'Weekday', 1, 7)
    if (seen.has(weekday_number)) throw new CourtInputError('Each weekday can appear only once.')
    seen.add(weekday_number)
    if (!isTimeLocal(one['opens_local']) || !isTimeLocal(one['closes_local'])) {
      throw new CourtInputError('Opening and closing times must look like 06:00.')
    }
    const opens = parseTimeMinute(one['opens_local'])
    const closes = parseTimeMinute(one['closes_local'])
    if (closes <= opens) throw new CourtInputError('Closing time must be after opening time on the same day.')
    hour.push({ weekday_number, opens_local: formatTimeMinute(opens), closes_local: formatTimeMinute(closes) })
  }
  await tenant.query`
    DELETE FROM court_operating_hour WHERE organization_id = ${tenant.organization_id} AND site_id = ${site.site_id}`
  for (const one of hour) {
    await tenant.query`
      INSERT INTO court_operating_hour (organization_id, site_id, weekday_number, opens_local, closes_local)
      VALUES (${tenant.organization_id}, ${site.site_id}, ${one.weekday_number},
              ${one.opens_local}::time, ${one.closes_local === '24:00' ? '24:00:00' : one.closes_local}::time)`
  }
  return listOperatingHour(tenant)
}

// ---------------------------------------------------------------------------
// closure
// ---------------------------------------------------------------------------

export type Closure = {
  closure_id: Uuid
  resource_id: Uuid | null
  court_display_name: string | null
  reason: string
  starts_at: Date
  ends_at: Date
  is_site_wide: boolean
}

export async function listClosure(tenant: TenantContext, option: { from?: Date; to?: Date } = {}): Promise<Closure[]> {
  const from = option.from ?? new Date()
  const to = option.to ?? new Date('9999-12-31T00:00:00Z')
  const row = await tenant.query<Closure[]>`
    SELECT c.closure_id, c.resource_id, r.display_name AS court_display_name, c.reason,
           c.starts_at, c.ends_at, (c.resource_id IS NULL) AS is_site_wide
    FROM closure c
    LEFT JOIN resource r ON r.resource_id = c.resource_id
    WHERE c.organization_id = ${tenant.organization_id}
      AND c.ends_at > ${from} AND c.starts_at < ${to}
    ORDER BY c.starts_at, r.sort_order NULLS FIRST`
  return [...row]
}

/**
 * Close the whole venue or one court for a window.
 *
 * Accepts either explicit instants (starts_at/ends_at — the board's maintenance
 * block) or a local date with optional times (the venue's dated closure; no
 * times means the whole day). Refuses when an active booking falls inside, so a
 * closure never silently strands a player.
 */
export async function createClosure(tenant: TenantContext, body: Body): Promise<Closure> {
  const site = await requireSite(tenant)
  const reason = readText(body, 'reason', 'Reason', { max: 160 })

  let starts_at: Date
  let ends_at: Date
  if (has(body, 'starts_at') || has(body, 'ends_at')) {
    starts_at = readInstant(body, 'starts_at', 'Start')
    ends_at = readInstant(body, 'ends_at', 'End')
  } else {
    const date = body['date']
    if (typeof date !== 'string' || !isDateKey(date)) throw new CourtInputError('Choose the date of the closure.')
    const end_date = typeof body['end_date'] === 'string' && body['end_date'] ? body['end_date'] : date
    if (!isDateKey(end_date) || end_date < date) throw new CourtInputError('The last day must be on or after the first day.')
    const starts_local = typeof body['starts_local'] === 'string' && body['starts_local'] ? body['starts_local'] : '00:00'
    const ends_local = typeof body['ends_local'] === 'string' && body['ends_local'] ? body['ends_local'] : '24:00'
    if (!isTimeLocal(starts_local) || !isTimeLocal(ends_local)) throw new CourtInputError('Times must look like 06:00.')
    starts_at = zonedToInstant(date, starts_local, site.time_zone)
    ends_at =
      ends_local === '24:00' || ends_local === '24:00:00'
        ? zonedToInstant(addDay(end_date, 1), '00:00', site.time_zone)
        : zonedToInstant(end_date, ends_local, site.time_zone)
  }
  if (ends_at <= starts_at) throw new CourtInputError('The closure must end after it starts.')

  let resource_id: Uuid | null = null
  let target = 'the venue'
  if (body['resource_id'] !== undefined && body['resource_id'] !== null && body['resource_id'] !== '') {
    if (!isUuid(body['resource_id'])) throw new CourtInputError('Choose a court, or leave it empty to close the whole venue.')
    const court = await findCourt(tenant, body['resource_id'])
    if (court.is_retired) throw new CourtConflictError(`${court.display_name} is retired.`)
    resource_id = court.resource_id
    target = court.display_name
  }

  const conflict = await tenant.query<{ display_name: string; starts_at: Date }[]>`
    SELECT r.display_name, b.starts_at
    FROM booking b
    JOIN resource r ON r.resource_id = b.resource_id
    WHERE b.organization_id = ${tenant.organization_id}
      AND b.status IN ('hold', 'confirmed')
      AND b.starts_at < ${ends_at} AND b.ends_at > ${starts_at}
      AND r.site_id = ${site.site_id}
      AND (${resource_id}::uuid IS NULL OR b.resource_id = ${resource_id})
    ORDER BY b.starts_at, r.sort_order
    LIMIT 3`
  if (conflict.length > 0) {
    const first = conflict[0]!
    throw new CourtConflictError(
      `${conflict.length >= 3 ? 'Several bookings' : plural(conflict.length, 'booking')} fall inside this closure of ${target} (first: ${first.display_name}, ${formatLocalDateTime(first.starts_at, site.time_zone)}). Move or cancel them first.`,
    )
  }

  const [row] = await tenant.query<{ closure_id: Uuid }[]>`
    INSERT INTO closure (organization_id, site_id, resource_id, reason, starts_at, ends_at)
    VALUES (${tenant.organization_id}, ${resource_id ? null : site.site_id}, ${resource_id}, ${reason}, ${starts_at}, ${ends_at})
    RETURNING closure_id`
  const [closure] = (await listClosure(tenant, { from: new Date(0) })).filter((one) => one.closure_id === row!.closure_id)
  return closure!
}

export async function deleteClosure(tenant: TenantContext, closure_id: Uuid): Promise<void> {
  const row = await tenant.query<{ closure_id: Uuid }[]>`
    DELETE FROM closure WHERE organization_id = ${tenant.organization_id} AND closure_id = ${closure_id}
    RETURNING closure_id`
  if (row.length === 0) throw new CourtNotFoundError('That closure does not exist.')
}
