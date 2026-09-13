// Program service: the one model for clinic, lesson, social, league shell,
// tournament shell, and private event — schedule, occurrence, registration,
// waitlist.
//
// Every seat-changing write locks the occurrence row first. The database trigger
// in migration 005 refuses an over-capacity seat regardless; the lock is what
// makes the service's "registered or waitlisted?" decision correct under
// concurrency instead of merely safe.

import { DomainError, listEnabledModuleCode, type TenantContext, type Uuid } from '@bygelo/roundrobin-kernel'
import { cancel as cancelBooking, confirm, hold } from '@bygelo/roundrobin-booking'
import { mintCode, renderQrSvg } from '@bygelo/roundrobin-scan'
import { notifyPlayer } from '../message/contract.ts'
import { emitWebhook } from '../webhook/contract.ts'
import {
  acceptWaiver,
  ensureCheckInTarget,
  findCurrentWaiver,
  findOrCreateParty,
  isActiveMember,
  isUuid,
  readWaiverState,
  type WaiverEvidence,
} from '../arrival/service.ts'
import { hashCredential, mintCredential } from '../arrival/rule.ts'
import { addDay, describeRuleProblem, localDate, planOccurrence, type ScheduleRule } from './schedule.ts'

export const PROGRAM_KIND = ['clinic', 'lesson', 'social', 'league', 'tournament', 'private_event'] as const
export type ProgramKind = (typeof PROGRAM_KIND)[number]

export const DEFAULT_TIME_ZONE = 'Asia/Manila'
export const PUBLIC_HORIZON_DAY_COUNT = 30

export class ProgramNotFoundError extends DomainError {
  constructor(what: string) {
    super(`${what} not found`, 404)
  }
}

// ---------------------------------------------------------------------------
// input
// ---------------------------------------------------------------------------

export type ProgramInput = {
  kind_code: ProgramKind
  title: string
  description: string | null
  host_name: string | null
  price_amount: string
  capacity_count: number
  is_member_only: boolean
  min_rating: string | null
  rating_provider_code: string | null
  resource_id: Uuid | null
  is_published: boolean
  schedule: ScheduleRule
}

export function readText(value: unknown, max = 500): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, max) : null
}

function refuse(message: string): never {
  throw new DomainError(message, 400)
}

function uniqueSorted<T extends string | number>(value: T[]): T[] {
  return [...new Set(value)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

/** Validate a whole program as posted by the operator screen. */
export function parseProgram(body: Record<string, unknown>): ProgramInput {
  const kind_code = body['kind_code']
  if (typeof kind_code !== 'string' || !PROGRAM_KIND.includes(kind_code as ProgramKind)) refuse('choose a program kind')
  const title = readText(body['title'], 120)
  if (!title) refuse('a program needs a title')

  const price_amount = String(body['price_amount'] ?? '0').trim() || '0'
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(price_amount)) refuse('price must be an amount like 350 or 350.00')

  const capacity_count = Number(body['capacity_count'])
  if (!Number.isInteger(capacity_count) || capacity_count < 1 || capacity_count > 1000) {
    refuse('capacity must be a whole number from 1 to 1000')
  }

  const raw_rating = body['min_rating']
  let min_rating: string | null = null
  if (raw_rating !== null && raw_rating !== undefined && String(raw_rating).trim() !== '') {
    min_rating = String(raw_rating).trim()
    if (!/^\d{1,2}(\.\d{1,3})?$/.test(min_rating) || Number(min_rating) <= 0) refuse('minimum rating must be a number like 3.5')
  }
  const rating_provider_code = min_rating ? (readText(body['rating_provider_code'], 40)?.toLowerCase() ?? 'dupr') : null

  const resource_id = readText(body['resource_id'], 64)
  if (resource_id && !isUuid(resource_id)) refuse('choose a court from the list')

  const raw_schedule = (typeof body['schedule'] === 'object' && body['schedule'] !== null ? body['schedule'] : {}) as Record<
    string,
    unknown
  >
  const schedule_code = raw_schedule['schedule_code'] === 'weekly' ? 'weekly' : raw_schedule['schedule_code'] === 'once' ? 'once' : undefined
  if (!schedule_code) refuse('schedule must be one-off or weekly')
  const schedule: ScheduleRule = {
    schedule_code,
    weekday_number:
      schedule_code === 'weekly' && Array.isArray(raw_schedule['weekday_number'])
        ? uniqueSorted((raw_schedule['weekday_number'] as unknown[]).map(Number))
        : [],
    first_date: String(raw_schedule['first_date'] ?? ''),
    until_date: schedule_code === 'weekly' ? readText(raw_schedule['until_date'], 10) : null,
    starts_local: String(raw_schedule['starts_local'] ?? '').slice(0, 5),
    ends_local: String(raw_schedule['ends_local'] ?? '').slice(0, 5),
    skipped_date: Array.isArray(raw_schedule['skipped_date'])
      ? uniqueSorted((raw_schedule['skipped_date'] as unknown[]).map((one) => String(one).trim()).filter(Boolean))
      : [],
    time_zone: readText(raw_schedule['time_zone'], 64) ?? DEFAULT_TIME_ZONE,
  }
  const problem = describeRuleProblem(schedule)
  if (problem) refuse(problem)

  return {
    kind_code: kind_code as ProgramKind,
    title: title!,
    description: readText(body['description'], 2000),
    host_name: readText(body['host_name'], 120),
    price_amount,
    capacity_count,
    is_member_only: body['is_member_only'] === true,
    min_rating,
    rating_provider_code,
    resource_id: resource_id as Uuid | null,
    is_published: body['is_published'] === true,
    schedule,
  }
}

const arrayLiteral = (value: (string | number)[]): string => `{${value.join(',')}}`

// ---------------------------------------------------------------------------
// program
// ---------------------------------------------------------------------------

export type ProgramView = Omit<ProgramInput, 'schedule'> & {
  program_id: Uuid
  court_name: string | null
  created_at: Date
  schedule: ScheduleRule
}

type ProgramRow = Omit<ProgramView, 'schedule'> &
  Omit<ScheduleRule, never> & { deleted_at: Date | null }

function toView(row: ProgramRow): ProgramView {
  return {
    program_id: row.program_id,
    kind_code: row.kind_code,
    title: row.title,
    description: row.description,
    host_name: row.host_name,
    price_amount: row.price_amount,
    capacity_count: row.capacity_count,
    is_member_only: row.is_member_only,
    min_rating: row.min_rating,
    rating_provider_code: row.rating_provider_code,
    resource_id: row.resource_id,
    court_name: row.court_name,
    is_published: row.is_published,
    created_at: row.created_at,
    schedule: {
      schedule_code: row.schedule_code,
      weekday_number: (row.weekday_number ?? []).map(Number),
      first_date: row.first_date,
      until_date: row.until_date,
      starts_local: row.starts_local,
      ends_local: row.ends_local,
      skipped_date: row.skipped_date ?? [],
      time_zone: row.time_zone,
    },
  }
}

async function selectProgram(tenant: TenantContext, program_id: Uuid | null): Promise<ProgramView[]> {
  const row = await tenant.query<ProgramRow[]>`
    SELECT p.program_id, p.kind_code, p.title, p.description, p.host_name, p.price_amount,
           p.capacity_count, p.is_member_only, p.min_rating::text AS min_rating, p.rating_provider_code,
           p.resource_id, res.display_name AS court_name, p.is_published, p.created_at, p.deleted_at,
           s.schedule_code, s.weekday_number, s.first_date::text AS first_date, s.until_date::text AS until_date,
           to_char(s.starts_local, 'HH24:MI') AS starts_local, to_char(s.ends_local, 'HH24:MI') AS ends_local,
           s.skipped_date::text[] AS skipped_date, s.time_zone
    FROM program p
    JOIN program_schedule s ON s.program_id = p.program_id
    LEFT JOIN resource res ON res.resource_id = p.resource_id
    WHERE p.organization_id = ${tenant.organization_id}
      AND p.deleted_at IS NULL
      AND (${program_id}::uuid IS NULL OR p.program_id = ${program_id}::uuid)
    ORDER BY p.title`
  return row.map(toView)
}

export function listProgram(tenant: TenantContext): Promise<ProgramView[]> {
  return selectProgram(tenant, null)
}

export async function findProgram(tenant: TenantContext, program_id: string): Promise<ProgramView> {
  if (!isUuid(program_id)) throw new ProgramNotFoundError('program')
  const [one] = await selectProgram(tenant, program_id as Uuid)
  if (!one) throw new ProgramNotFoundError('program')
  return one
}

async function assertResource(tenant: TenantContext, resource_id: Uuid | null): Promise<void> {
  if (!resource_id) return
  const [row] = await tenant.query<{ resource_id: Uuid }[]>`
    SELECT resource_id FROM resource
    WHERE organization_id = ${tenant.organization_id} AND resource_id = ${resource_id} AND deleted_at IS NULL`
  if (!row) refuse('that court does not exist at this venue')
}

export type MaterializeOutcome = {
  created_count: number
  removed_count: number
  /** Dates whose court was already taken; the occurrence exists without a court hold. */
  court_conflict_date: string[]
  /** Off-rule dates kept because people are registered; cancel them explicitly. */
  kept_date: string[]
}

export async function createProgram(
  tenant: TenantContext,
  input: ProgramInput,
  now = new Date(),
): Promise<{ program: ProgramView; materialize: MaterializeOutcome }> {
  await assertResource(tenant, input.resource_id)
  const [row] = await tenant.query<{ program_id: Uuid }[]>`
    INSERT INTO program (organization_id, kind_code, title, description, host_name, price_amount, capacity_count,
                         is_member_only, min_rating, rating_provider_code, resource_id, is_published)
    VALUES (${tenant.organization_id}, ${input.kind_code}, ${input.title}, ${input.description}, ${input.host_name},
            ${input.price_amount}, ${input.capacity_count}, ${input.is_member_only}, ${input.min_rating},
            ${input.rating_provider_code}, ${input.resource_id}, ${input.is_published})
    RETURNING program_id`
  const s = input.schedule
  await tenant.query`
    INSERT INTO program_schedule (organization_id, program_id, schedule_code, weekday_number, first_date, until_date,
                                  starts_local, ends_local, skipped_date, time_zone)
    VALUES (${tenant.organization_id}, ${row!.program_id}, ${s.schedule_code}, ${arrayLiteral(s.weekday_number)}::smallint[],
            ${s.first_date}::date, ${s.until_date}::date, ${s.starts_local}::time, ${s.ends_local}::time,
            ${arrayLiteral(s.skipped_date)}::date[], ${s.time_zone})`
  const materialize = await materializeProgram(tenant, row!.program_id, now)
  return { program: await findProgram(tenant, row!.program_id), materialize }
}

export async function updateProgram(
  tenant: TenantContext,
  program_id: string,
  input: ProgramInput,
  now = new Date(),
): Promise<{ program: ProgramView; materialize: MaterializeOutcome }> {
  const existing = await findProgram(tenant, program_id)
  await assertResource(tenant, input.resource_id)
  await tenant.query`
    UPDATE program SET kind_code = ${input.kind_code}, title = ${input.title}, description = ${input.description},
           host_name = ${input.host_name}, price_amount = ${input.price_amount}, capacity_count = ${input.capacity_count},
           is_member_only = ${input.is_member_only}, min_rating = ${input.min_rating},
           rating_provider_code = ${input.rating_provider_code}, resource_id = ${input.resource_id},
           is_published = ${input.is_published}
    WHERE organization_id = ${tenant.organization_id} AND program_id = ${existing.program_id}`
  const s = input.schedule
  await tenant.query`
    UPDATE program_schedule SET schedule_code = ${s.schedule_code}, weekday_number = ${arrayLiteral(s.weekday_number)}::smallint[],
           first_date = ${s.first_date}::date, until_date = ${s.until_date}::date, starts_local = ${s.starts_local}::time,
           ends_local = ${s.ends_local}::time, skipped_date = ${arrayLiteral(s.skipped_date)}::date[], time_zone = ${s.time_zone}
    WHERE organization_id = ${tenant.organization_id} AND program_id = ${existing.program_id}`
  // A capacity change applies to upcoming occurrences, never below seats already taken.
  await tenant.query`
    UPDATE program_occurrence o
    SET capacity_count = GREATEST(${input.capacity_count}::int, (
      SELECT count(*)::int FROM program_registration r
      WHERE r.program_occurrence_id = o.program_occurrence_id AND r.status_code IN ('registered', 'attended')))
    WHERE o.organization_id = ${tenant.organization_id} AND o.program_id = ${existing.program_id}
      AND o.status_code = 'scheduled' AND o.ends_at > ${now}`
  const materialize = await materializeProgram(tenant, existing.program_id, now)
  return { program: await findProgram(tenant, existing.program_id), materialize }
}

/** Withdraw a program: unpublish, and cancel every upcoming occurrence (registrants are told). */
export async function archiveProgram(tenant: TenantContext, program_id: string, now = new Date()): Promise<{ cancelled_count: number }> {
  const program = await findProgram(tenant, program_id)
  const upcoming = await tenant.query<{ program_occurrence_id: Uuid }[]>`
    SELECT program_occurrence_id FROM program_occurrence
    WHERE organization_id = ${tenant.organization_id} AND program_id = ${program.program_id}
      AND status_code = 'scheduled' AND ends_at > ${now}`
  for (const one of upcoming) {
    await cancelOccurrence(tenant, one.program_occurrence_id, 'This program was withdrawn by the venue.')
  }
  await tenant.query`
    UPDATE program SET deleted_at = now(), is_published = false
    WHERE organization_id = ${tenant.organization_id} AND program_id = ${program.program_id}`
  return { cancelled_count: upcoming.length }
}

// ---------------------------------------------------------------------------
// occurrence materialization + court hold
// ---------------------------------------------------------------------------

type OccurrenceCore = {
  program_occurrence_id: Uuid
  occurrence_date: string
  starts_at: Date
  ends_at: Date
  booking_id: Uuid | null
  session_id: Uuid | null
}

async function releaseCourt(tenant: TenantContext, occurrence: OccurrenceCore): Promise<void> {
  if (occurrence.booking_id) {
    const [booking] = await tenant.query<{ booking_code: string; status: string }[]>`
      SELECT booking_code, status::text AS status FROM booking
      WHERE organization_id = ${tenant.organization_id} AND booking_id = ${occurrence.booking_id}`
    if (booking && (booking.status === 'hold' || booking.status === 'confirmed')) {
      await cancelBooking(tenant, booking.booking_code)
    }
  }
  if (occurrence.session_id) {
    await tenant.query`
      UPDATE session SET deleted_at = now()
      WHERE organization_id = ${tenant.organization_id} AND session_id = ${occurrence.session_id}`
  }
  if (occurrence.booking_id || occurrence.session_id) {
    await tenant.query`
      UPDATE program_occurrence SET booking_id = NULL, session_id = NULL
      WHERE organization_id = ${tenant.organization_id} AND program_occurrence_id = ${occurrence.program_occurrence_id}`
  }
}

/** Hold the program's court for one occurrence through the booking pack. False when the court is taken. */
async function blockCourt(tenant: TenantContext, occurrence: OccurrenceCore, program: ProgramView): Promise<boolean> {
  if (!program.resource_id) return true
  const [resource] = await tenant.query<{ site_id: Uuid }[]>`
    SELECT site_id FROM resource
    WHERE organization_id = ${tenant.organization_id} AND resource_id = ${program.resource_id} AND deleted_at IS NULL`
  if (!resource) return false
  const [taken] = await tenant.query<{ booking_id: Uuid }[]>`
    SELECT booking_id FROM booking
    WHERE organization_id = ${tenant.organization_id} AND resource_id = ${program.resource_id}
      AND status IN ('hold', 'confirmed')
      AND reserved_range && tstzrange(${occurrence.starts_at}::timestamptz, ${occurrence.ends_at}::timestamptz, '[)')
    LIMIT 1`
  if (taken) return false

  const [session] = await tenant.query<{ session_id: Uuid }[]>`
    INSERT INTO session (organization_id, site_id, session_code, display_name, starts_at, ends_at, capacity_count,
                         price_amount, is_published, session_type)
    VALUES (${tenant.organization_id}, ${resource.site_id},
            ${`program-${occurrence.program_occurrence_id}-${Date.now().toString(36)}`}, ${program.title},
            ${occurrence.starts_at}, ${occurrence.ends_at}, ${program.capacity_count}, ${program.price_amount}, false, 'class')
    RETURNING session_id`
  await tenant.query`
    INSERT INTO session_resource (organization_id, session_id, resource_id)
    VALUES (${tenant.organization_id}, ${session!.session_id}, ${program.resource_id})`
  const booking = await hold(tenant, { session_id: session!.session_id, resource_id: program.resource_id, session_type: 'class' })
  await confirm(tenant, booking.booking_code)
  await tenant.query`
    UPDATE program_occurrence SET session_id = ${session!.session_id}, booking_id = ${booking.booking_id}
    WHERE organization_id = ${tenant.organization_id} AND program_occurrence_id = ${occurrence.program_occurrence_id}`
  return true
}

/**
 * Bring upcoming occurrences in line with the stored rule. Idempotent: running
 * it twice creates nothing the second time. Past occurrences are never touched.
 */
export async function materializeProgram(tenant: TenantContext, program_id: Uuid, now = new Date()): Promise<MaterializeOutcome> {
  const program = await findProgram(tenant, program_id)
  const rule = program.schedule
  const today = localDate(now, rule.time_zone)
  const to_date = rule.schedule_code === 'once' ? rule.first_date : (rule.until_date ?? addDay(today, 56))
  const planned = planOccurrence(rule, { from_date: today, to_date })
  const planned_by_date = new Map(planned.map((one) => [one.occurrence_date, one]))

  const outcome: MaterializeOutcome = { created_count: 0, removed_count: 0, court_conflict_date: [], kept_date: [] }

  const existing = await tenant.query<(OccurrenceCore & { status_code: string; active_count: number })[]>`
    SELECT o.program_occurrence_id, o.occurrence_date::text AS occurrence_date, o.starts_at, o.ends_at,
           o.booking_id, o.session_id, o.status_code,
           (SELECT count(*)::int FROM program_registration r
            WHERE r.program_occurrence_id = o.program_occurrence_id
              AND r.status_code IN ('registered', 'waitlisted', 'attended')) AS active_count
    FROM program_occurrence o
    WHERE o.organization_id = ${tenant.organization_id} AND o.program_id = ${program.program_id}
      AND o.occurrence_date >= ${today}::date`
  const existing_by_date = new Map(existing.map((one) => [one.occurrence_date, one]))

  for (const one of existing) {
    if (one.status_code !== 'scheduled' || planned_by_date.has(one.occurrence_date)) continue
    if (one.active_count > 0) {
      outcome.kept_date.push(one.occurrence_date)
      continue
    }
    await releaseCourt(tenant, one)
    await tenant.query`
      DELETE FROM program_occurrence
      WHERE organization_id = ${tenant.organization_id} AND program_occurrence_id = ${one.program_occurrence_id}`
    outcome.removed_count += 1
  }

  for (const plan of planned) {
    let occurrence: OccurrenceCore | undefined = existing_by_date.get(plan.occurrence_date)
    const status_code = existing_by_date.get(plan.occurrence_date)?.status_code
    if (status_code === 'cancelled') continue
    let needs_court = false
    if (!occurrence) {
      const [row] = await tenant.query<OccurrenceCore[]>`
        INSERT INTO program_occurrence (organization_id, program_id, occurrence_date, starts_at, ends_at, capacity_count)
        VALUES (${tenant.organization_id}, ${program.program_id}, ${plan.occurrence_date}::date, ${plan.starts_at},
                ${plan.ends_at}, ${program.capacity_count})
        ON CONFLICT (program_id, occurrence_date) DO NOTHING
        RETURNING program_occurrence_id, occurrence_date::text AS occurrence_date, starts_at, ends_at, booking_id, session_id`
      if (!row) continue
      occurrence = row
      outcome.created_count += 1
      needs_court = true
    } else if (
      new Date(occurrence.starts_at).getTime() !== plan.starts_at.getTime() ||
      new Date(occurrence.ends_at).getTime() !== plan.ends_at.getTime()
    ) {
      await releaseCourt(tenant, occurrence)
      await tenant.query`
        UPDATE program_occurrence SET starts_at = ${plan.starts_at}, ends_at = ${plan.ends_at}
        WHERE organization_id = ${tenant.organization_id} AND program_occurrence_id = ${occurrence.program_occurrence_id}`
      occurrence = { ...occurrence, starts_at: plan.starts_at, ends_at: plan.ends_at, booking_id: null, session_id: null }
      needs_court = true
    } else {
      const [court] = await tenant.query<{ resource_id: Uuid | null; status: string | null }[]>`
        SELECT b.resource_id, b.status::text AS status FROM booking b
        WHERE b.organization_id = ${tenant.organization_id} AND b.booking_id = ${occurrence.booking_id}::uuid`
      const is_held = court && court.resource_id === program.resource_id && (court.status === 'confirmed' || court.status === 'hold')
      if (program.resource_id ? !is_held : occurrence.booking_id !== null) {
        await releaseCourt(tenant, occurrence)
        occurrence = { ...occurrence, booking_id: null, session_id: null }
        needs_court = true
      }
    }
    if (needs_court && program.resource_id && !(await blockCourt(tenant, occurrence, program))) {
      outcome.court_conflict_date.push(plan.occurrence_date)
    }
  }
  return outcome
}

/** Add a date to the rule's exceptions and take that occurrence off the calendar. */
export async function skipDate(
  tenant: TenantContext,
  program_id: string,
  occurrence_date: string,
): Promise<{ skipped_date: string[]; cancelled_registration_count: number }> {
  const program = await findProgram(tenant, program_id)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(occurrence_date)) refuse('choose a date to skip')
  const [row] = await tenant.query<{ skipped_date: string[] }[]>`
    UPDATE program_schedule
    SET skipped_date = (SELECT array_agg(DISTINCT one ORDER BY one) FROM unnest(skipped_date || ${occurrence_date}::date) AS one)
    WHERE organization_id = ${tenant.organization_id} AND program_id = ${program.program_id}
    RETURNING skipped_date::text[] AS skipped_date`
  const [occurrence] = await tenant.query<(OccurrenceCore & { status_code: string; active_count: number })[]>`
    SELECT o.program_occurrence_id, o.occurrence_date::text AS occurrence_date, o.starts_at, o.ends_at, o.booking_id,
           o.session_id, o.status_code,
           (SELECT count(*)::int FROM program_registration r WHERE r.program_occurrence_id = o.program_occurrence_id
              AND r.status_code IN ('registered', 'waitlisted', 'attended')) AS active_count
    FROM program_occurrence o
    WHERE o.organization_id = ${tenant.organization_id} AND o.program_id = ${program.program_id}
      AND o.occurrence_date = ${occurrence_date}::date`
  let cancelled_registration_count = 0
  if (occurrence && occurrence.status_code === 'scheduled') {
    if (occurrence.active_count === 0) {
      await releaseCourt(tenant, occurrence)
      await tenant.query`
        DELETE FROM program_occurrence
        WHERE organization_id = ${tenant.organization_id} AND program_occurrence_id = ${occurrence.program_occurrence_id}`
    } else {
      const result = await cancelOccurrence(tenant, occurrence.program_occurrence_id, 'The venue is not running this session.')
      cancelled_registration_count = result.cancelled_registration_count
    }
  }
  return { skipped_date: row?.skipped_date ?? [], cancelled_registration_count }
}

// ---------------------------------------------------------------------------
// occurrence read
// ---------------------------------------------------------------------------

export type OccurrenceSummary = {
  program_occurrence_id: Uuid
  program_id: Uuid
  kind_code: ProgramKind
  title: string
  host_name: string | null
  court_name: string | null
  occurrence_date: string
  starts_at: Date
  ends_at: Date
  price_amount: string
  capacity_count: number
  registered_count: number
  waitlist_count: number
  status_code: 'scheduled' | 'cancelled'
  is_published: boolean
  is_member_only: boolean
  min_rating: string | null
  rating_provider_code: string | null
  has_court_conflict: boolean
}

async function selectOccurrence(
  tenant: TenantContext,
  filter: { from: Date | null; to: Date | null; program_occurrence_id: Uuid | null; is_public: boolean },
): Promise<(OccurrenceSummary & { description: string | null; cancel_reason: string | null })[]> {
  return tenant.query`
    SELECT o.program_occurrence_id, o.program_id, p.kind_code, p.title, p.description, p.host_name,
           res.display_name AS court_name, o.occurrence_date::text AS occurrence_date, o.starts_at, o.ends_at,
           p.price_amount, o.capacity_count, o.status_code, o.cancel_reason, p.is_published, p.is_member_only,
           p.min_rating::text AS min_rating, p.rating_provider_code,
           (p.resource_id IS NOT NULL AND o.booking_id IS NULL AND o.status_code = 'scheduled') AS has_court_conflict,
           (SELECT count(*)::int FROM program_registration r WHERE r.program_occurrence_id = o.program_occurrence_id
              AND r.status_code IN ('registered', 'attended')) AS registered_count,
           (SELECT count(*)::int FROM program_registration r WHERE r.program_occurrence_id = o.program_occurrence_id
              AND r.status_code = 'waitlisted') AS waitlist_count
    FROM program_occurrence o
    JOIN program p ON p.program_id = o.program_id
    LEFT JOIN resource res ON res.resource_id = p.resource_id
    WHERE o.organization_id = ${tenant.organization_id}
      AND p.deleted_at IS NULL
      AND (${filter.program_occurrence_id}::uuid IS NULL OR o.program_occurrence_id = ${filter.program_occurrence_id}::uuid)
      AND (${filter.from}::timestamptz IS NULL OR o.ends_at > ${filter.from}::timestamptz)
      AND (${filter.to}::timestamptz IS NULL OR o.starts_at < ${filter.to}::timestamptz)
      AND (NOT ${filter.is_public} OR (p.is_published AND o.status_code = 'scheduled'))
    ORDER BY o.starts_at, p.title`
}

export async function listOccurrence(tenant: TenantContext, window: { from: Date; to: Date }): Promise<OccurrenceSummary[]> {
  return selectOccurrence(tenant, { from: window.from, to: window.to, program_occurrence_id: null, is_public: false })
}

export type RegistrationView = {
  program_registration_id: Uuid
  display_name: string
  email_address: string | null
  phone_number: string | null
  status_code: 'registered' | 'waitlisted' | 'cancelled' | 'no_show' | 'attended'
  waitlist_position: number | null
  waitlist_rank: number | null
  paid_at: Date | null
  promoted_at: Date | null
  cancelled_at: Date | null
  created_at: Date
  checked_in_at: Date | null
  check_in_method_code: string | null
}

export async function findOccurrence(tenant: TenantContext, program_occurrence_id: string) {
  if (!isUuid(program_occurrence_id)) throw new ProgramNotFoundError('session')
  const [occurrence] = await selectOccurrence(tenant, {
    from: null,
    to: null,
    program_occurrence_id: program_occurrence_id as Uuid,
    is_public: false,
  })
  if (!occurrence) throw new ProgramNotFoundError('session')
  const registration = await tenant.query<RegistrationView[]>`
    SELECT r.program_registration_id, r.display_name, r.email_address, r.phone_number, r.status_code,
           r.waitlist_position,
           CASE WHEN r.status_code = 'waitlisted'
                THEN row_number() OVER (PARTITION BY r.status_code = 'waitlisted' ORDER BY r.waitlist_position)::int
           END AS waitlist_rank,
           r.paid_at, r.promoted_at, r.cancelled_at, r.created_at,
           ci.checked_in_at, ci.method_code AS check_in_method_code
    FROM program_registration r
    LEFT JOIN arrival_check_in ci
      ON ci.organization_id = r.organization_id AND ci.subject_kind = 'registration' AND ci.subject_id = r.program_registration_id
    WHERE r.organization_id = ${tenant.organization_id} AND r.program_occurrence_id = ${occurrence.program_occurrence_id}
    ORDER BY CASE r.status_code WHEN 'attended' THEN 0 WHEN 'registered' THEN 0 WHEN 'no_show' THEN 1
                                WHEN 'waitlisted' THEN 2 ELSE 3 END,
             r.waitlist_position NULLS FIRST, r.created_at`
  return { occurrence, registration }
}

export type PublicOccurrence = {
  program_occurrence_id: Uuid
  program_id: Uuid
  kind_code: ProgramKind
  title: string
  description: string | null
  host_name: string | null
  court_name: string | null
  starts_at: Date
  ends_at: Date
  price_amount: string
  capacity_count: number
  spot_left_count: number
  is_waitlist: boolean
  is_member_only: boolean
  min_rating: string | null
  rating_provider_code: string | null
}

/** What a guest may see: no names, no contacts, no payment or membership state of anyone. */
export async function listPublicOccurrence(tenant: TenantContext, now = new Date()): Promise<PublicOccurrence[]> {
  const row = await selectOccurrence(tenant, {
    from: now,
    to: new Date(now.getTime() + PUBLIC_HORIZON_DAY_COUNT * 86400000),
    program_occurrence_id: null,
    is_public: true,
  })
  return row.map(toPublicOccurrence)
}

function toPublicOccurrence(one: OccurrenceSummary & { description: string | null }): PublicOccurrence {
  const spot_left_count = Math.max(0, one.capacity_count - one.registered_count)
  return {
    program_occurrence_id: one.program_occurrence_id,
    program_id: one.program_id,
    kind_code: one.kind_code,
    title: one.title,
    description: one.description,
    host_name: one.host_name,
    court_name: one.court_name,
    starts_at: one.starts_at,
    ends_at: one.ends_at,
    price_amount: one.price_amount,
    capacity_count: one.capacity_count,
    spot_left_count,
    is_waitlist: spot_left_count === 0,
    is_member_only: one.is_member_only,
    min_rating: one.min_rating,
    rating_provider_code: one.rating_provider_code,
  }
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

type LockedOccurrence = {
  program_occurrence_id: Uuid
  program_id: Uuid
  title: string
  kind_code: ProgramKind
  starts_at: Date
  ends_at: Date
  capacity_count: number
  status_code: string
  is_published: boolean
  is_member_only: boolean
  price_amount: string
  deleted_at: Date | null
}

async function lockOccurrence(tenant: TenantContext, program_occurrence_id: Uuid): Promise<LockedOccurrence | undefined> {
  const [row] = await tenant.query<LockedOccurrence[]>`
    SELECT o.program_occurrence_id, o.program_id, p.title, p.kind_code, o.starts_at, o.ends_at, o.capacity_count,
           o.status_code, p.is_published, p.is_member_only, p.price_amount, p.deleted_at
    FROM program_occurrence o
    JOIN program p ON p.program_id = o.program_id
    WHERE o.organization_id = ${tenant.organization_id} AND o.program_occurrence_id = ${program_occurrence_id}
    FOR UPDATE OF o`
  return row
}

async function countSeat(tenant: TenantContext, program_occurrence_id: Uuid): Promise<number> {
  const [row] = await tenant.query<{ taken_count: number }[]>`
    SELECT count(*)::int AS taken_count FROM program_registration
    WHERE organization_id = ${tenant.organization_id} AND program_occurrence_id = ${program_occurrence_id}
      AND status_code IN ('registered', 'attended')`
  return row?.taken_count ?? 0
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type RegisterInput = {
  display_name: string
  email_address: string | null
  phone_number: string | null
  arrival_waiver_version_id: string | null
}

export function parseRegistration(body: Record<string, unknown>): RegisterInput {
  const display_name = readText(body['display_name'], 120)
  if (!display_name) refuse('tell us your name')
  const email_address = readText(body['email'] ?? body['email_address'], 200)?.toLowerCase() ?? null
  const phone_number = readText(body['phone'] ?? body['phone_number'], 40)
  if (!email_address && !phone_number) refuse('add an email or a mobile number so the venue can reach you')
  if (email_address && !EMAIL_PATTERN.test(email_address)) refuse('that email address does not look right')
  if (phone_number && !/^[+\d][\d\s-]{6,}$/.test(phone_number)) refuse('that mobile number does not look right')
  return {
    display_name: display_name!,
    email_address,
    phone_number,
    arrival_waiver_version_id: readText(body['waiver_version_id'] ?? body['arrival_waiver_version_id'], 64),
  }
}

export type RegisterResult = {
  registration: {
    program_registration_id: Uuid
    display_name: string
    status_code: 'registered' | 'waitlisted'
    waitlist_position: number | null
  }
  /** Shown exactly once. Needed to cancel, accept the waiver, or self check in. */
  credential: string
  /** Scan token for the QR pass, when the scan module is enabled. */
  check_in_token: string | null
  /** The same token rendered as an SVG QR code, ready to show on the confirmation. */
  check_in_qr_svg: string | null
  occurrence: { program_occurrence_id: Uuid; title: string; kind_code: ProgramKind; starts_at: Date; ends_at: Date; price_amount: string }
  waiver_state: 'current' | 'outdated' | 'missing' | 'not_required'
}

export async function register(
  tenant: TenantContext,
  program_occurrence_id: string,
  input: RegisterInput,
  option: { is_public: boolean; now?: Date; evidence?: WaiverEvidence },
): Promise<RegisterResult> {
  const now = option.now ?? new Date()
  if (!isUuid(program_occurrence_id)) throw new ProgramNotFoundError('session')
  const occurrence = await lockOccurrence(tenant, program_occurrence_id as Uuid)
  if (!occurrence || occurrence.deleted_at || (option.is_public && !occurrence.is_published)) {
    throw new ProgramNotFoundError('session')
  }
  if (occurrence.status_code !== 'scheduled') throw new DomainError('this session was cancelled', 409)
  if (new Date(occurrence.ends_at).getTime() <= now.getTime()) throw new DomainError('registration closed when this session ended', 409)

  const party_id = await findOrCreateParty(tenant, input)
  if (occurrence.is_member_only && !(await isActiveMember(tenant, party_id))) {
    throw new DomainError('this program is for members only — ask the front desk about membership', 409)
  }

  const [existing] = await tenant.query<{ status_code: string }[]>`
    SELECT status_code FROM program_registration
    WHERE organization_id = ${tenant.organization_id} AND program_occurrence_id = ${occurrence.program_occurrence_id}
      AND party_id = ${party_id} AND status_code IN ('registered', 'waitlisted', 'attended')`
  if (existing) {
    throw new DomainError(
      existing.status_code === 'waitlisted'
        ? 'you are already on the waitlist for this session'
        : 'you are already registered for this session',
      409,
    )
  }

  const taken_count = await countSeat(tenant, occurrence.program_occurrence_id)
  const status_code = taken_count < occurrence.capacity_count ? 'registered' : 'waitlisted'
  const credential = mintCredential()
  let waitlist_position: number | null = null
  if (status_code === 'waitlisted') {
    const [last] = await tenant.query<{ next_position: number }[]>`
      SELECT (coalesce(max(waitlist_position), 0) + 1)::int AS next_position FROM program_registration
      WHERE organization_id = ${tenant.organization_id} AND program_occurrence_id = ${occurrence.program_occurrence_id}
        AND status_code = 'waitlisted'`
    waitlist_position = last?.next_position ?? 1
  }

  const [registration] = await tenant.query<RegisterResult['registration'][]>`
    INSERT INTO program_registration (organization_id, program_occurrence_id, party_id, display_name, email_address,
                                      phone_number, status_code, waitlist_position, credential_hash)
    VALUES (${tenant.organization_id}, ${occurrence.program_occurrence_id}, ${party_id}, ${input.display_name},
            ${input.email_address}, ${input.phone_number}, ${status_code}, ${waitlist_position},
            ${hashCredential(credential)})
    RETURNING program_registration_id, display_name, status_code, waitlist_position`

  const enabled = await listEnabledModuleCode(tenant)

  let check_in_token: string | null = null
  let check_in_qr_svg: string | null = null
  if (enabled.includes('scan')) {
    const target = await ensureCheckInTarget(tenant)
    const code = await mintCode(tenant, {
      scan_target_id: target,
      label: 'Program check-in',
      subject_id: registration!.program_registration_id,
      valid_until: new Date(new Date(occurrence.ends_at).getTime() + 6 * 3600000),
    })
    check_in_token = code.token
    check_in_qr_svg = renderQrSvg(code.token, { title: 'Check-in QR code', scale: 6 })
    await tenant.query`
      UPDATE program_registration SET scan_code_id = ${code.scan_code_id}
      WHERE organization_id = ${tenant.organization_id} AND program_registration_id = ${registration!.program_registration_id}`
  }

  let waiver_state: RegisterResult['waiver_state'] = 'not_required'
  if (enabled.includes('arrival')) {
    if (input.arrival_waiver_version_id) {
      await acceptWaiver(tenant, {
        party_id,
        arrival_waiver_version_id: input.arrival_waiver_version_id,
        channel_code: 'registration',
        evidence: option.evidence ?? { user_agent: null, address: null },
      })
    }
    waiver_state = (await readWaiverState(tenant, [party_id])).get(party_id) ?? 'not_required'
  }

  const detail = {
    title: occurrence.title,
    starts_at: new Date(occurrence.starts_at).toISOString(),
    status: status_code === 'registered' ? 'You have a spot' : `You are #${registration!.waitlist_position} on the waitlist`,
  }
  const contact: { recipient_email?: string; recipient_phone?: string } = {}
  if (input.email_address) contact.recipient_email = input.email_address
  if (input.phone_number) contact.recipient_phone = input.phone_number
  await notifyPlayer(tenant, {
    message_kind: 'program_registered',
    party_id,
    ...contact,
    subject_code: registration!.program_registration_id,
    detail,
  })
  if (waiver_state === 'missing' || waiver_state === 'outdated') {
    const waiver = await findCurrentWaiver(tenant)
    await notifyPlayer(tenant, {
      message_kind: 'waiver_prompt',
      party_id,
      ...contact,
      subject_code: `${registration!.program_registration_id}:waiver:${waiver?.version_number ?? 0}`,
      detail: { title: occurrence.title, waiver_title: waiver?.title ?? 'Venue waiver' },
    })
  }
  await emitWebhook(tenant, {
    event_code: 'program.registered',
    subject_code: registration!.program_registration_id,
    payload: {
      program_registration_id: registration!.program_registration_id,
      program_occurrence_id: occurrence.program_occurrence_id,
      program_id: occurrence.program_id,
      status_code,
      starts_at: new Date(occurrence.starts_at).toISOString(),
    },
  })

  return {
    registration: registration!,
    credential,
    check_in_token,
    check_in_qr_svg,
    occurrence: {
      program_occurrence_id: occurrence.program_occurrence_id,
      title: occurrence.title,
      kind_code: occurrence.kind_code,
      starts_at: occurrence.starts_at,
      ends_at: occurrence.ends_at,
      price_amount: occurrence.price_amount,
    },
    waiver_state,
  }
}

type PromotedRegistration = { program_registration_id: Uuid; display_name: string }

/**
 * Promote exactly one waitlisted registration into a free seat, if both exist.
 * The occurrence lock makes "exactly one" hold under concurrent cancellations.
 */
export async function promoteOne(tenant: TenantContext, program_occurrence_id: Uuid): Promise<PromotedRegistration | null> {
  const occurrence = await lockOccurrence(tenant, program_occurrence_id)
  if (!occurrence || occurrence.status_code !== 'scheduled') return null
  if ((await countSeat(tenant, program_occurrence_id)) >= occurrence.capacity_count) return null
  const [promoted] = await tenant.query<(PromotedRegistration & { party_id: Uuid | null; email_address: string | null; phone_number: string | null })[]>`
    UPDATE program_registration SET status_code = 'registered', waitlist_position = NULL, promoted_at = now()
    WHERE program_registration_id = (
      SELECT program_registration_id FROM program_registration
      WHERE organization_id = ${tenant.organization_id} AND program_occurrence_id = ${program_occurrence_id}
        AND status_code = 'waitlisted'
      ORDER BY waitlist_position LIMIT 1)
    RETURNING program_registration_id, display_name, party_id, email_address, phone_number`
  if (!promoted) return null
  const input: Parameters<typeof notifyPlayer>[1] = {
    message_kind: 'waitlist_opened',
    subject_code: promoted.program_registration_id,
    detail: { title: occurrence.title, starts_at: new Date(occurrence.starts_at).toISOString() },
  }
  if (promoted.party_id) input.party_id = promoted.party_id
  if (promoted.email_address) input.recipient_email = promoted.email_address
  if (promoted.phone_number) input.recipient_phone = promoted.phone_number
  await notifyPlayer(tenant, input)
  return { program_registration_id: promoted.program_registration_id, display_name: promoted.display_name }
}

type RegistrationCore = { program_registration_id: Uuid; program_occurrence_id: Uuid; status_code: string }

async function findRegistrationCore(tenant: TenantContext, program_registration_id: string): Promise<RegistrationCore> {
  if (!isUuid(program_registration_id)) throw new ProgramNotFoundError('registration')
  const [row] = await tenant.query<RegistrationCore[]>`
    SELECT program_registration_id, program_occurrence_id, status_code FROM program_registration
    WHERE organization_id = ${tenant.organization_id} AND program_registration_id = ${program_registration_id}`
  if (!row) throw new ProgramNotFoundError('registration')
  return row
}

async function isCheckedIn(tenant: TenantContext, program_registration_id: Uuid): Promise<boolean> {
  const [row] = await tenant.query`
    SELECT 1 FROM arrival_check_in
    WHERE organization_id = ${tenant.organization_id} AND subject_kind = 'registration' AND subject_id = ${program_registration_id}`
  return Boolean(row)
}

export async function cancelRegistration(
  tenant: TenantContext,
  program_registration_id: string,
): Promise<{ status_code: 'cancelled'; promoted: PromotedRegistration | null; is_replay: boolean }> {
  const core = await findRegistrationCore(tenant, program_registration_id)
  await lockOccurrence(tenant, core.program_occurrence_id)
  const [current] = await tenant.query<{ status_code: string }[]>`
    SELECT status_code FROM program_registration WHERE program_registration_id = ${core.program_registration_id}`
  if (current?.status_code === 'cancelled') return { status_code: 'cancelled', promoted: null, is_replay: true }
  if (await isCheckedIn(tenant, core.program_registration_id)) {
    throw new DomainError('this player has already checked in, so the registration cannot be cancelled', 409)
  }
  await tenant.query`
    UPDATE program_registration SET status_code = 'cancelled', waitlist_position = NULL, cancelled_at = now()
    WHERE program_registration_id = ${core.program_registration_id}`
  const promoted = current?.status_code === 'registered' ? await promoteOne(tenant, core.program_occurrence_id) : null
  return { status_code: 'cancelled', promoted, is_replay: false }
}

/** A player cancelling with the credential they were shown once. */
export async function cancelWithCredential(tenant: TenantContext, program_registration_id: string, credential: unknown) {
  if (typeof credential !== 'string' || !credential || !isUuid(program_registration_id)) {
    throw new ProgramNotFoundError('registration')
  }
  const [row] = await tenant.query`
    SELECT 1 FROM program_registration
    WHERE organization_id = ${tenant.organization_id} AND program_registration_id = ${program_registration_id}
      AND credential_hash = ${hashCredential(credential)}`
  // Same answer for a wrong credential and an unknown registration.
  if (!row) throw new ProgramNotFoundError('registration')
  return cancelRegistration(tenant, program_registration_id)
}

export async function markNoShow(tenant: TenantContext, program_registration_id: string): Promise<{ status_code: 'no_show' }> {
  const core = await findRegistrationCore(tenant, program_registration_id)
  if (core.status_code === 'no_show') return { status_code: 'no_show' }
  if (core.status_code !== 'registered') throw new DomainError('only a registered player can be marked as a no-show', 409)
  if (await isCheckedIn(tenant, core.program_registration_id)) throw new DomainError('this player already checked in', 409)
  await tenant.query`
    UPDATE program_registration SET status_code = 'no_show' WHERE program_registration_id = ${core.program_registration_id}`
  return { status_code: 'no_show' }
}

export async function setPaid(tenant: TenantContext, program_registration_id: string, is_paid: boolean): Promise<{ paid_at: Date | null }> {
  const core = await findRegistrationCore(tenant, program_registration_id)
  const [row] = await tenant.query<{ paid_at: Date | null }[]>`
    UPDATE program_registration SET paid_at = CASE WHEN ${is_paid} THEN coalesce(paid_at, now()) ELSE NULL END
    WHERE program_registration_id = ${core.program_registration_id}
    RETURNING paid_at`
  return { paid_at: row?.paid_at ?? null }
}

export async function promoteWaitlist(tenant: TenantContext, program_occurrence_id: string): Promise<PromotedRegistration> {
  if (!isUuid(program_occurrence_id)) throw new ProgramNotFoundError('session')
  const promoted = await promoteOne(tenant, program_occurrence_id as Uuid)
  if (!promoted) throw new DomainError('nobody can be promoted: the session is full or the waitlist is empty', 409)
  return promoted
}

export async function cancelOccurrence(
  tenant: TenantContext,
  program_occurrence_id: string,
  reason: string | null,
): Promise<{ cancelled_registration_count: number; is_replay: boolean }> {
  if (!isUuid(program_occurrence_id)) throw new ProgramNotFoundError('session')
  const occurrence = await lockOccurrence(tenant, program_occurrence_id as Uuid)
  if (!occurrence) throw new ProgramNotFoundError('session')
  if (occurrence.status_code === 'cancelled') return { cancelled_registration_count: 0, is_replay: true }

  const [core] = await tenant.query<OccurrenceCore[]>`
    UPDATE program_occurrence SET status_code = 'cancelled', cancelled_at = now(), cancel_reason = ${reason}
    WHERE program_occurrence_id = ${occurrence.program_occurrence_id}
    RETURNING program_occurrence_id, occurrence_date::text AS occurrence_date, starts_at, ends_at, booking_id, session_id`
  await releaseCourt(tenant, core!)

  const affected = await tenant.query<
    { program_registration_id: Uuid; party_id: Uuid | null; email_address: string | null; phone_number: string | null }[]
  >`
    UPDATE program_registration SET status_code = 'cancelled', waitlist_position = NULL, cancelled_at = now()
    WHERE organization_id = ${tenant.organization_id} AND program_occurrence_id = ${occurrence.program_occurrence_id}
      AND status_code IN ('registered', 'waitlisted')
    RETURNING program_registration_id, party_id, email_address, phone_number`
  for (const one of affected) {
    const input: Parameters<typeof notifyPlayer>[1] = {
      message_kind: 'closure',
      subject_code: `${one.program_registration_id}:cancelled`,
      detail: {
        title: occurrence.title,
        starts_at: new Date(occurrence.starts_at).toISOString(),
        reason: reason ?? 'The venue cancelled this session.',
      },
    }
    if (one.party_id) input.party_id = one.party_id
    if (one.email_address) input.recipient_email = one.email_address
    if (one.phone_number) input.recipient_phone = one.phone_number
    await notifyPlayer(tenant, input)
  }
  return { cancelled_registration_count: affected.length, is_replay: false }
}
