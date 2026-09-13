// The sellable schedule: court_schedule → booking-pack session templates →
// materialized sessions.
//
// Writes go through the booking pack (createSessionTemplate,
// attachTemplateResource, materializeTemplate). What this file adds is the
// edit rule: a regeneration never touches a session that still carries an
// active booking. It retires the unbooked future sessions of the old revision,
// unpublishes the booked ones (so they stop selling but keep their booking),
// and materializes a fresh revision beside them. The booking EXCLUDE
// constraint remains what stops a new slot double-selling a kept booking's court.

import {
  attachTemplateResource,
  createSessionTemplate,
  materializeTemplate,
} from '@bygelo/roundrobin-booking'
import type { TenantContext, Uuid } from '@bygelo/roundrobin-kernel'
import {
  CourtConflictError,
  CourtInputError,
  CourtNotFoundError,
  has,
  readInteger,
  readText,
  type Body,
} from './input.ts'
import { listOperatingHour, requireSite, type Site } from './venue.ts'
import {
  addDay,
  generateSlot,
  isTimeLocal,
  isoWeekday,
  localDateKey,
  parseTimeMinute,
  readMoney,
  zonedToInstant,
  type PeakWindow,
} from './time.ts'

export type Schedule = {
  court_schedule_id: Uuid
  resource_category_id: Uuid
  sport_code: string
  sport_display_name: string
  display_name: string
  slot_minute_count: number
  capacity_count: number
  off_peak_price_amount: string
  peak_price_amount: string
  horizon_day_count: number
  revision_number: number
  generated_at: Date | null
  peak: PeakWindow[]
  court_count: number
  template_count: number
  upcoming_session_count: number
}

export type RegenerateResult = {
  template_count: number
  created_session_count: number
  retired_session_count: number
  kept_booked_session_count: number
}

/** Session and template codes for one schedule share this prefix. */
function schedulePrefix(court_schedule_id: Uuid): string {
  return `cs.${court_schedule_id}.`
}

function revisionPrefix(court_schedule_id: Uuid, revision_number: number): string {
  return `cs.${court_schedule_id}.r${revision_number}.`
}

export async function listSchedule(tenant: TenantContext): Promise<Schedule[]> {
  const row = await tenant.query<(Omit<Schedule, 'peak'> & { peak: { weekday_number: number; starts_local: string; ends_local: string }[] | null })[]>`
    SELECT cs.court_schedule_id, cs.resource_category_id, rc.resource_category_code AS sport_code,
           COALESCE(sp.display_name, rc.display_name) AS sport_display_name,
           cs.display_name, cs.slot_minute_count, cs.capacity_count,
           cs.off_peak_price_amount, cs.peak_price_amount, cs.horizon_day_count,
           cs.revision_number, cs.generated_at,
           (SELECT json_agg(json_build_object('weekday_number', p.weekday_number,
                                              'starts_local', to_char(p.starts_local, 'HH24:MI'),
                                              'ends_local', to_char(p.ends_local, 'HH24:MI'))
                            ORDER BY p.weekday_number, p.starts_local)
              FROM court_schedule_peak p WHERE p.court_schedule_id = cs.court_schedule_id) AS peak,
           (SELECT count(*)::int FROM resource_category_link rcl
              JOIN resource r ON r.resource_id = rcl.resource_id AND r.deleted_at IS NULL AND r.site_id = cs.site_id
             WHERE rcl.resource_category_id = cs.resource_category_id) AS court_count,
           (SELECT count(*)::int FROM session_template st
             WHERE st.organization_id = cs.organization_id
               AND st.template_code LIKE ('cs.' || cs.court_schedule_id || '.r' || cs.revision_number || '.%')) AS template_count,
           (SELECT count(*)::int FROM session s
             WHERE s.organization_id = cs.organization_id AND s.deleted_at IS NULL AND s.is_published
               AND s.starts_at > now()
               AND s.materialization_key LIKE ('cs.' || cs.court_schedule_id || '.%')) AS upcoming_session_count
    FROM court_schedule cs
    JOIN resource_category rc ON rc.resource_category_id = cs.resource_category_id
    LEFT JOIN sport_profile sp ON sp.organization_id = cs.organization_id AND sp.sport_profile_code = rc.resource_category_code
    WHERE cs.organization_id = ${tenant.organization_id} AND cs.deleted_at IS NULL
    ORDER BY sport_display_name`
  return row.map((one) => ({
    ...one,
    slot_minute_count: Number(one.slot_minute_count),
    peak: (one.peak ?? []).map((peak) => ({
      weekday_number: Number(peak.weekday_number),
      starts_local: peak.starts_local,
      ends_local: peak.ends_local === '00:00' ? '24:00' : peak.ends_local,
    })),
  })) as Schedule[]
}

export async function findSchedule(tenant: TenantContext, court_schedule_id: Uuid): Promise<Schedule> {
  const schedule = (await listSchedule(tenant)).find((one) => one.court_schedule_id === court_schedule_id)
  if (!schedule) throw new CourtNotFoundError('That schedule does not exist.')
  return schedule
}

type ScheduleInput = {
  display_name: string
  slot_minute_count: number
  capacity_count: number
  off_peak_price_amount: string
  peak_price_amount: string
  horizon_day_count: number
  peak: PeakWindow[]
}

function readScheduleInput(body: Body, prior?: Schedule): ScheduleInput {
  const display_name = has(body, 'display_name')
    ? readText(body, 'display_name', 'Schedule name', { max: 80 })
    : (prior?.display_name ?? 'Court rental')
  const slot_minute_count = has(body, 'slot_minute_count')
    ? readInteger(body, 'slot_minute_count', 'Slot length', 60, 120)
    : (prior?.slot_minute_count ?? 60)
  if (![60, 90, 120].includes(slot_minute_count)) throw new CourtInputError('Slot length must be 60, 90, or 120 minutes.')
  const capacity_count = has(body, 'capacity_count')
    ? readInteger(body, 'capacity_count', 'Players per slot', 1, 40)
    : (prior?.capacity_count ?? 4)
  const horizon_day_count = has(body, 'horizon_day_count')
    ? readInteger(body, 'horizon_day_count', 'Days sold ahead', 1, 90)
    : (prior?.horizon_day_count ?? 14)

  const off_peak = has(body, 'off_peak_price_amount') ? readMoney(body['off_peak_price_amount']) : prior?.off_peak_price_amount
  if (off_peak === undefined) throw new CourtInputError('Off-peak price must be an amount like 400 or 400.00.')
  const peak_price = has(body, 'peak_price_amount') ? readMoney(body['peak_price_amount']) : (prior?.peak_price_amount ?? off_peak)
  if (peak_price === undefined) throw new CourtInputError('Peak price must be an amount like 600 or 600.00.')

  let peak: PeakWindow[] = prior?.peak ?? []
  if (has(body, 'peak')) {
    const raw = body['peak']
    if (!Array.isArray(raw)) throw new CourtInputError('Send peak as a list of weekday time windows.')
    peak = []
    const seen = new Set<string>()
    for (const one of raw as Body[]) {
      const weekday_number = readInteger(one ?? {}, 'weekday_number', 'Peak weekday', 1, 7)
      if (!isTimeLocal(one['starts_local']) || !isTimeLocal(one['ends_local'])) {
        throw new CourtInputError('Peak times must look like 17:00.')
      }
      if (parseTimeMinute(one['ends_local']) <= parseTimeMinute(one['starts_local'])) {
        throw new CourtInputError('A peak window must end after it starts.')
      }
      const starts_local = one['starts_local'].slice(0, 5)
      const key = `${weekday_number}.${starts_local}`
      if (seen.has(key)) throw new CourtInputError('Two peak windows start at the same time on the same day.')
      seen.add(key)
      peak.push({ weekday_number, starts_local, ends_local: one['ends_local'].slice(0, 5) })
    }
  }
  return {
    display_name,
    slot_minute_count,
    capacity_count,
    off_peak_price_amount: off_peak,
    peak_price_amount: peak_price,
    horizon_day_count,
    peak,
  }
}

async function replacePeak(tenant: TenantContext, court_schedule_id: Uuid, peak: PeakWindow[]) {
  await tenant.query`
    DELETE FROM court_schedule_peak
    WHERE organization_id = ${tenant.organization_id} AND court_schedule_id = ${court_schedule_id}`
  for (const one of peak) {
    await tenant.query`
      INSERT INTO court_schedule_peak (organization_id, court_schedule_id, weekday_number, starts_local, ends_local)
      VALUES (${tenant.organization_id}, ${court_schedule_id}, ${one.weekday_number},
              ${one.starts_local}::time, ${one.ends_local === '24:00' ? '24:00:00' : one.ends_local}::time)`
  }
}

export async function createSchedule(tenant: TenantContext, body: Body): Promise<{ schedule: Schedule; result: RegenerateResult }> {
  const site = await requireSite(tenant)
  const sport_code = body['sport_code']
  if (typeof sport_code !== 'string' || !sport_code) throw new CourtInputError('Choose the sport this schedule sells.')
  const [category] = await tenant.query<{ resource_category_id: Uuid }[]>`
    SELECT resource_category_id FROM resource_category
    WHERE organization_id = ${tenant.organization_id} AND resource_category_code = ${sport_code}`
  if (!category) throw new CourtInputError('Add that sport under Sports before giving it a schedule.')
  const [clash] = await tenant.query<{ court_schedule_id: Uuid }[]>`
    SELECT court_schedule_id FROM court_schedule
    WHERE organization_id = ${tenant.organization_id} AND site_id = ${site.site_id}
      AND resource_category_id = ${category.resource_category_id} AND deleted_at IS NULL`
  if (clash) throw new CourtConflictError('That sport already has a schedule. Edit it instead.')

  const input = readScheduleInput(body)
  const [row] = await tenant.query<{ court_schedule_id: Uuid }[]>`
    INSERT INTO court_schedule (organization_id, site_id, resource_category_id, display_name, slot_minute_count,
                                capacity_count, off_peak_price_amount, peak_price_amount, horizon_day_count)
    VALUES (${tenant.organization_id}, ${site.site_id}, ${category.resource_category_id}, ${input.display_name},
            ${input.slot_minute_count}, ${input.capacity_count}, ${input.off_peak_price_amount},
            ${input.peak_price_amount}, ${input.horizon_day_count})
    RETURNING court_schedule_id`
  await replacePeak(tenant, row!.court_schedule_id, input.peak)
  const result = await regenerateSchedule(tenant, row!.court_schedule_id)
  return { schedule: await findSchedule(tenant, row!.court_schedule_id), result }
}

export async function updateSchedule(
  tenant: TenantContext,
  court_schedule_id: Uuid,
  body: Body,
): Promise<{ schedule: Schedule; result: RegenerateResult }> {
  const prior = await findSchedule(tenant, court_schedule_id)
  const input = readScheduleInput(body, prior)
  await tenant.query`
    UPDATE court_schedule SET display_name = ${input.display_name}, slot_minute_count = ${input.slot_minute_count},
      capacity_count = ${input.capacity_count}, off_peak_price_amount = ${input.off_peak_price_amount},
      peak_price_amount = ${input.peak_price_amount}, horizon_day_count = ${input.horizon_day_count}
    WHERE organization_id = ${tenant.organization_id} AND court_schedule_id = ${court_schedule_id}`
  await replacePeak(tenant, court_schedule_id, input.peak)
  const result = await regenerateSchedule(tenant, court_schedule_id)
  return { schedule: await findSchedule(tenant, court_schedule_id), result }
}

export async function deleteSchedule(tenant: TenantContext, court_schedule_id: Uuid): Promise<RegenerateResult> {
  await findSchedule(tenant, court_schedule_id)
  const result = await retireRevision(tenant, court_schedule_id)
  await tenant.query`
    UPDATE court_schedule SET deleted_at = now()
    WHERE organization_id = ${tenant.organization_id} AND court_schedule_id = ${court_schedule_id}`
  return { template_count: 0, created_session_count: 0, ...result }
}

/** Drop every template of the schedule and stop selling its future sessions, keeping booked ones. */
async function retireRevision(
  tenant: TenantContext,
  court_schedule_id: Uuid,
): Promise<{ retired_session_count: number; kept_booked_session_count: number }> {
  const prefix = `${schedulePrefix(court_schedule_id)}%`
  await tenant.query`
    DELETE FROM session_template
    WHERE organization_id = ${tenant.organization_id} AND template_code LIKE ${prefix}`
  const retired = await tenant.query<{ session_id: Uuid }[]>`
    UPDATE session s SET deleted_at = now(), is_published = false
    WHERE s.organization_id = ${tenant.organization_id}
      AND s.materialization_key LIKE ${prefix}
      AND s.deleted_at IS NULL
      AND s.starts_at >= now()
      AND NOT EXISTS (SELECT 1 FROM booking b
                       WHERE b.session_id = s.session_id AND b.status IN ('hold', 'confirmed'))
    RETURNING s.session_id`
  const kept = await tenant.query<{ session_id: Uuid }[]>`
    UPDATE session s SET is_published = false
    WHERE s.organization_id = ${tenant.organization_id}
      AND s.materialization_key LIKE ${prefix}
      AND s.deleted_at IS NULL
      AND s.is_published
      AND s.starts_at >= now()
    RETURNING s.session_id`
  return { retired_session_count: retired.length, kept_booked_session_count: kept.length }
}

async function activeCourtId(tenant: TenantContext, site_id: Uuid, resource_category_id: Uuid): Promise<Uuid[]> {
  const row = await tenant.query<{ resource_id: Uuid }[]>`
    SELECT r.resource_id FROM resource r
    JOIN resource_category_link rcl ON rcl.resource_id = r.resource_id
    WHERE r.organization_id = ${tenant.organization_id} AND r.site_id = ${site_id} AND r.deleted_at IS NULL
      AND rcl.resource_category_id = ${resource_category_id}
    ORDER BY r.sort_order`
  return row.map((one) => one.resource_id)
}

/**
 * Rebuild one schedule from the current hours, peaks, prices, and courts, and
 * materialize it `horizon_day_count` days ahead from today in the venue's zone.
 */
export async function regenerateSchedule(tenant: TenantContext, court_schedule_id: Uuid): Promise<RegenerateResult> {
  const site = await requireSite(tenant)
  const schedule = await findSchedule(tenant, court_schedule_id)
  const retired = await retireRevision(tenant, court_schedule_id)

  const revision_number = schedule.revision_number + 1
  await tenant.query`
    UPDATE court_schedule SET revision_number = ${revision_number}, generated_at = now()
    WHERE organization_id = ${tenant.organization_id} AND court_schedule_id = ${court_schedule_id}`

  const court_id = await activeCourtId(tenant, site.site_id, schedule.resource_category_id)
  const slot = generateSlot({
    operating_hour: await listOperatingHour(tenant),
    peak: schedule.peak,
    slot_minute_count: schedule.slot_minute_count,
    off_peak_price_amount: schedule.off_peak_price_amount,
    peak_price_amount: schedule.peak_price_amount,
  })
  if (court_id.length === 0 || slot.length === 0) {
    return { template_count: 0, created_session_count: 0, ...retired }
  }

  const template_id: Uuid[] = []
  for (const one of slot) {
    const template = await createSessionTemplate(tenant, {
      site_id: site.site_id,
      template_code: `${revisionPrefix(court_schedule_id, revision_number)}${one.weekday_number}.${one.starts_local.replace(':', '')}`,
      display_name: `${schedule.sport_display_name} · ${schedule.slot_minute_count} min${one.is_peak ? ' · peak' : ''}`,
      session_type: 'private',
      weekday_number: one.weekday_number,
      starts_local: one.starts_local,
      ends_local: one.ends_local,
      end_day_offset: one.end_day_offset,
      capacity_count: schedule.capacity_count,
      price_amount: one.price_amount,
      is_published: true,
    })
    for (const resource_id of court_id) {
      await attachTemplateResource(tenant, { session_template_id: template.session_template_id, resource_id })
    }
    template_id.push(template.session_template_id)
  }

  const created_session_count = await materializeRange(tenant, site, template_id, slot.map((one) => one.weekday_number), schedule.horizon_day_count)
  return { template_count: template_id.length, created_session_count, ...retired }
}

async function materializeRange(
  tenant: TenantContext,
  site: Site,
  template_id: Uuid[],
  template_weekday: number[],
  horizon_day_count: number,
): Promise<number> {
  const from_date = localDateKey(new Date(), site.time_zone)
  const to_date = addDay(from_date, horizon_day_count)
  // Only call the pack for weekdays that actually fall inside the range.
  const weekday_in_range = new Set<number>()
  for (let offset = 0; offset <= Math.min(horizon_day_count, 6); offset += 1) weekday_in_range.add(isoWeekday(addDay(from_date, offset)))
  let created = 0
  for (const [index, session_template_id] of template_id.entries()) {
    if (!weekday_in_range.has(template_weekday[index]!)) continue
    const result = await materializeTemplate(tenant, { session_template_id, from_date, to_date })
    created += result.created_count
  }
  return created
}

export async function regenerateAllSchedule(tenant: TenantContext): Promise<RegenerateResult> {
  const total: RegenerateResult = { template_count: 0, created_session_count: 0, retired_session_count: 0, kept_booked_session_count: 0 }
  for (const one of await listSchedule(tenant)) {
    const result = await regenerateSchedule(tenant, one.court_schedule_id)
    total.template_count += result.template_count
    total.created_session_count += result.created_session_count
    total.retired_session_count += result.retired_session_count
    total.kept_booked_session_count += result.kept_booked_session_count
  }
  return total
}

/** Roll every schedule forward to its horizon. Idempotent: a re-run creates nothing. */
export async function materializeAllSchedule(tenant: TenantContext): Promise<{ created_session_count: number }> {
  const site = await requireSite(tenant)
  let created_session_count = 0
  for (const schedule of await listSchedule(tenant)) {
    const template = await tenant.query<{ session_template_id: Uuid; weekday_number: number }[]>`
      SELECT session_template_id, weekday_number FROM session_template
      WHERE organization_id = ${tenant.organization_id}
        AND template_code LIKE ${`${revisionPrefix(schedule.court_schedule_id, schedule.revision_number)}%`}`
    created_session_count += await materializeRange(
      tenant,
      site,
      template.map((one) => one.session_template_id),
      template.map((one) => Number(one.weekday_number)),
      schedule.horizon_day_count,
    )
  }
  return { created_session_count }
}

/**
 * Cheap guard the board runs: when the furthest open day inside a schedule's
 * horizon has no session yet, roll the schedule forward.
 */
export async function ensureHorizon(tenant: TenantContext): Promise<void> {
  const site = await requireSite(tenant)
  const hour = await listOperatingHour(tenant)
  if (hour.length === 0) return
  const open_weekday = new Set(hour.map((one) => one.weekday_number))
  const today = localDateKey(new Date(), site.time_zone)
  for (const schedule of await listSchedule(tenant)) {
    if (schedule.template_count === 0) continue
    let last = schedule.horizon_day_count
    while (last > 0 && !open_weekday.has(isoWeekday(addDay(today, last)))) last -= 1
    const boundary = zonedToInstant(addDay(today, last), '00:00', site.time_zone)
    const [row] = await tenant.query<{ is_present: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM session
                      WHERE organization_id = ${tenant.organization_id} AND deleted_at IS NULL
                        AND starts_at >= ${boundary}
                        AND materialization_key LIKE ${`${revisionPrefix(schedule.court_schedule_id, schedule.revision_number)}%`}) AS is_present`
    if (!row?.is_present) {
      await materializeAllSchedule(tenant)
      return
    }
  }
}

/**
 * Put a court on the right schedule after it is created, changes sport, or is
 * retired: unlink it from every schedule's templates and unbooked future
 * sessions, then (if still active) link it into its sport's current revision.
 */
export async function syncCourtSchedule(tenant: TenantContext, resource_id: Uuid): Promise<void> {
  await tenant.query`
    DELETE FROM session_template_resource str USING session_template st
    WHERE str.session_template_id = st.session_template_id
      AND str.organization_id = ${tenant.organization_id}
      AND str.resource_id = ${resource_id}
      AND st.template_code LIKE 'cs.%'`
  await tenant.query`
    DELETE FROM session_resource sr USING session s
    WHERE sr.session_id = s.session_id
      AND sr.organization_id = ${tenant.organization_id}
      AND sr.resource_id = ${resource_id}
      AND s.materialization_key LIKE 'cs.%'
      AND s.starts_at >= now()
      AND NOT EXISTS (SELECT 1 FROM booking b
                       WHERE b.session_id = s.session_id AND b.resource_id = ${resource_id}
                         AND b.status IN ('hold', 'confirmed'))`

  const [court] = await tenant.query<{ resource_category_id: Uuid; site_id: Uuid }[]>`
    SELECT rcl.resource_category_id, r.site_id FROM resource r
    JOIN resource_category_link rcl ON rcl.resource_id = r.resource_id
    WHERE r.organization_id = ${tenant.organization_id} AND r.resource_id = ${resource_id} AND r.deleted_at IS NULL
    LIMIT 1`
  if (!court) return
  const schedule = (await listSchedule(tenant)).find((one) => one.resource_category_id === court.resource_category_id)
  if (!schedule) return
  const prefix = `${revisionPrefix(schedule.court_schedule_id, schedule.revision_number)}%`
  const template = await tenant.query<{ session_template_id: Uuid }[]>`
    SELECT session_template_id FROM session_template
    WHERE organization_id = ${tenant.organization_id} AND template_code LIKE ${prefix}`
  for (const one of template) {
    await attachTemplateResource(tenant, { session_template_id: one.session_template_id, resource_id })
  }
  await tenant.query`
    INSERT INTO session_resource (organization_id, session_id, resource_id)
    SELECT ${tenant.organization_id}, s.session_id, ${resource_id}
    FROM session s
    WHERE s.organization_id = ${tenant.organization_id} AND s.deleted_at IS NULL
      AND s.starts_at >= now() AND s.materialization_key LIKE ${prefix}
    ON CONFLICT DO NOTHING`
}
