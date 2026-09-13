// Arrival service: who is expected today, whether they have paid and signed the
// current waiver, and the one check-in each booking or registration gets.
//
// Reads the booking, billing, membership, and program tables inside the tenant
// transaction; writes only its own tables, plus the scan target it mints codes
// against and the kernel audit row an override leaves.

import {
  DomainError,
  listEnabledModuleCode,
  recordAuditEvent,
  type Session,
  type TenantContext,
  type Uuid,
} from '@bygelo/roundrobin-kernel'
import { findCodeByToken, resolveCode } from '@bygelo/roundrobin-scan'
import { emitWebhook } from '../webhook/contract.ts'
import { addDay, zonedInstant } from '../program/schedule.ts'
import {
  checkInWindow,
  describeEligibility,
  hashAddress,
  hashCredential,
  waiverState,
  type Eligibility,
  type PaidState,
  type WaiverState,
} from './rule.ts'

export const DEFAULT_TIME_ZONE = 'Asia/Manila'
export const CHECK_IN_TARGET_CODE = 'court-arrival-check-in'
export const CHECK_IN_COMMAND_CODE = 'arrival.check_in'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is Uuid {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

export type WaiverEvidence = { user_agent: string | null; address: string | null }

/** A refusal the public check-in answers with a reason code the page can act on. */
export class ArrivalRefusal extends DomainError {
  readonly reason_code: 'too_early' | 'ended' | 'waiver_required' | 'see_desk' | 'not_registered'
  readonly extra: Record<string, unknown>
  constructor(message: string, reason_code: ArrivalRefusal['reason_code'], extra: Record<string, unknown> = {}) {
    super(message, 409)
    this.reason_code = reason_code
    this.extra = extra
  }
}

// ---------------------------------------------------------------------------
// party + membership
// ---------------------------------------------------------------------------

/** Find the tenant's party by email (or phone when no email), or create one. */
export async function findOrCreateParty(
  tenant: TenantContext,
  input: { display_name: string; email_address: string | null; phone_number: string | null },
): Promise<Uuid> {
  const [found] = await tenant.query<{ party_id: Uuid }[]>`
    SELECT party_id FROM party
    WHERE organization_id = ${tenant.organization_id} AND deleted_at IS NULL AND merged_into_party_id IS NULL
      AND ((${input.email_address}::text IS NOT NULL AND lower(email_address) = lower(${input.email_address}::text))
        OR (${input.email_address}::text IS NULL AND ${input.phone_number}::text IS NOT NULL
            AND phone_number = ${input.phone_number}::text))
    ORDER BY created_at LIMIT 1`
  if (found) return found.party_id
  const [created] = await tenant.query<{ party_id: Uuid }[]>`
    INSERT INTO party (organization_id, display_name, email_address, phone_number)
    VALUES (${tenant.organization_id}, ${input.display_name}, ${input.email_address}, ${input.phone_number})
    RETURNING party_id`
  return created!.party_id
}

async function listActiveMember(tenant: TenantContext, party_id: Uuid[]): Promise<Set<string>> {
  if (party_id.length === 0) return new Set()
  const row = await tenant.query<{ party_id: Uuid }[]>`
    SELECT DISTINCT party_id FROM membership
    WHERE organization_id = ${tenant.organization_id} AND party_id = ANY(${`{${party_id.join(',')}}`}::uuid[])
      AND status = 'active' AND deleted_at IS NULL AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now())`
  return new Set(row.map((one) => one.party_id))
}

export async function isActiveMember(tenant: TenantContext, party_id: Uuid): Promise<boolean> {
  return (await listActiveMember(tenant, [party_id])).has(party_id)
}

// ---------------------------------------------------------------------------
// waiver
// ---------------------------------------------------------------------------

export type WaiverVersion = {
  arrival_waiver_version_id: Uuid
  version_number: number
  title: string
  body: string
  published_at: Date | null
  created_at: Date
}

export async function findCurrentWaiver(tenant: TenantContext): Promise<WaiverVersion | undefined> {
  const [row] = await tenant.query<WaiverVersion[]>`
    SELECT arrival_waiver_version_id, version_number, title, body, published_at, created_at
    FROM arrival_waiver_version
    WHERE organization_id = ${tenant.organization_id} AND published_at IS NOT NULL AND deleted_at IS NULL
    ORDER BY version_number DESC LIMIT 1`
  return row
}

export async function listWaiver(
  tenant: TenantContext,
): Promise<(WaiverVersion & { acceptance_count: number; is_current: boolean })[]> {
  const current = await findCurrentWaiver(tenant)
  const row = await tenant.query<(WaiverVersion & { acceptance_count: number })[]>`
    SELECT v.arrival_waiver_version_id, v.version_number, v.title, v.body, v.published_at, v.created_at,
           (SELECT count(*)::int FROM arrival_waiver_acceptance a
            WHERE a.arrival_waiver_version_id = v.arrival_waiver_version_id) AS acceptance_count
    FROM arrival_waiver_version v
    WHERE v.organization_id = ${tenant.organization_id} AND v.deleted_at IS NULL
    ORDER BY v.version_number DESC`
  return row.map((one) => ({ ...one, is_current: one.arrival_waiver_version_id === current?.arrival_waiver_version_id }))
}

function readWaiverInput(body: Record<string, unknown>): { title: string; body: string } {
  const title = typeof body['title'] === 'string' ? body['title'].trim().slice(0, 160) : ''
  const text = typeof body['body'] === 'string' ? body['body'].trim().slice(0, 20000) : ''
  if (!title) throw new DomainError('a waiver needs a title', 400)
  if (!text) throw new DomainError('a waiver needs its text', 400)
  return { title, body: text }
}

export async function createWaiverDraft(tenant: TenantContext, body: Record<string, unknown>): Promise<WaiverVersion> {
  const input = readWaiverInput(body)
  const [row] = await tenant.query<WaiverVersion[]>`
    INSERT INTO arrival_waiver_version (organization_id, version_number, title, body)
    VALUES (${tenant.organization_id},
            (SELECT coalesce(max(version_number), 0) + 1 FROM arrival_waiver_version
             WHERE organization_id = ${tenant.organization_id}),
            ${input.title}, ${input.body})
    RETURNING arrival_waiver_version_id, version_number, title, body, published_at, created_at`
  return row!
}

async function findWaiver(tenant: TenantContext, arrival_waiver_version_id: string): Promise<WaiverVersion> {
  if (!isUuid(arrival_waiver_version_id)) throw new DomainError('waiver version not found', 404)
  const [row] = await tenant.query<WaiverVersion[]>`
    SELECT arrival_waiver_version_id, version_number, title, body, published_at, created_at
    FROM arrival_waiver_version
    WHERE organization_id = ${tenant.organization_id} AND arrival_waiver_version_id = ${arrival_waiver_version_id}
      AND deleted_at IS NULL`
  if (!row) throw new DomainError('waiver version not found', 404)
  return row
}

export async function updateWaiverDraft(
  tenant: TenantContext,
  arrival_waiver_version_id: string,
  body: Record<string, unknown>,
): Promise<WaiverVersion> {
  const existing = await findWaiver(tenant, arrival_waiver_version_id)
  if (existing.published_at) {
    throw new DomainError('a published waiver cannot be edited — create a new version instead', 409)
  }
  const input = readWaiverInput(body)
  const [row] = await tenant.query<WaiverVersion[]>`
    UPDATE arrival_waiver_version SET title = ${input.title}, body = ${input.body}
    WHERE arrival_waiver_version_id = ${existing.arrival_waiver_version_id}
    RETURNING arrival_waiver_version_id, version_number, title, body, published_at, created_at`
  return row!
}

/** Publish a draft. Every acceptance of an older version becomes outdated from this moment. */
export async function publishWaiver(tenant: TenantContext, arrival_waiver_version_id: string): Promise<WaiverVersion> {
  const existing = await findWaiver(tenant, arrival_waiver_version_id)
  if (existing.published_at) return existing
  const current = await findCurrentWaiver(tenant)
  if (current && current.version_number > existing.version_number) {
    throw new DomainError(`version ${current.version_number} is already published; edit a newer draft instead`, 409)
  }
  const [row] = await tenant.query<WaiverVersion[]>`
    UPDATE arrival_waiver_version SET published_at = now()
    WHERE arrival_waiver_version_id = ${existing.arrival_waiver_version_id}
    RETURNING arrival_waiver_version_id, version_number, title, body, published_at, created_at`
  return row!
}

export async function acceptWaiver(
  tenant: TenantContext,
  input: {
    party_id: Uuid
    arrival_waiver_version_id: string
    channel_code: 'registration' | 'self' | 'desk'
    evidence: WaiverEvidence
  },
): Promise<{ version_number: number; accepted_at: Date }> {
  const current = await findCurrentWaiver(tenant)
  if (!current) throw new DomainError('this venue has no waiver to accept', 409)
  if (current.arrival_waiver_version_id !== input.arrival_waiver_version_id) {
    throw new DomainError('that waiver is no longer the current version — please read the latest one', 409)
  }
  await tenant.query`
    INSERT INTO arrival_waiver_acceptance (organization_id, party_id, arrival_waiver_version_id, user_agent, ip_hash, channel_code)
    VALUES (${tenant.organization_id}, ${input.party_id}, ${current.arrival_waiver_version_id}, ${input.evidence.user_agent},
            ${input.evidence.address ? hashAddress(tenant.organization_id, input.evidence.address) : null}, ${input.channel_code})
    ON CONFLICT (party_id, arrival_waiver_version_id) DO NOTHING`
  const [row] = await tenant.query<{ accepted_at: Date }[]>`
    SELECT accepted_at FROM arrival_waiver_acceptance
    WHERE party_id = ${input.party_id} AND arrival_waiver_version_id = ${current.arrival_waiver_version_id}`
  return { version_number: current.version_number, accepted_at: row!.accepted_at }
}

/** Waiver state per party. A party of null (a booking with no player on file) reads as missing. */
export async function readWaiverState(tenant: TenantContext, party_id: (Uuid | null)[]): Promise<Map<string | null, WaiverState>> {
  const current = await findCurrentWaiver(tenant)
  const state = new Map<string | null, WaiverState>()
  const known = [...new Set(party_id.filter((one): one is Uuid => one !== null))]
  if (!current) {
    for (const one of party_id) state.set(one, 'not_required')
    return state
  }
  const accepted = known.length
    ? await tenant.query<{ party_id: Uuid; version_number: number }[]>`
        SELECT a.party_id, max(v.version_number)::int AS version_number
        FROM arrival_waiver_acceptance a
        JOIN arrival_waiver_version v ON v.arrival_waiver_version_id = a.arrival_waiver_version_id
        WHERE a.organization_id = ${tenant.organization_id} AND a.party_id = ANY(${`{${known.join(',')}}`}::uuid[])
        GROUP BY a.party_id`
    : []
  const by_party = new Map(accepted.map((one) => [one.party_id, one.version_number]))
  for (const one of party_id) {
    state.set(one, one === null ? 'missing' : waiverState(current.version_number, by_party.get(one) ?? null))
  }
  return state
}

// ---------------------------------------------------------------------------
// scan target
// ---------------------------------------------------------------------------

/**
 * The one scan target every check-in code points at. Created with ON CONFLICT
 * rather than createTarget so two first-ever registrations racing cannot abort
 * each other's transaction on the unique code.
 */
export async function ensureCheckInTarget(tenant: TenantContext): Promise<Uuid> {
  await tenant.query`
    INSERT INTO scan_target (organization_id, scan_target_code, kind, display_name, command_code, required_capability)
    VALUES (${tenant.organization_id}, ${CHECK_IN_TARGET_CODE}, 'pass', 'Arrival check-in', ${CHECK_IN_COMMAND_CODE}, 'arrival.manage')
    ON CONFLICT (organization_id, scan_target_code) DO NOTHING`
  const [row] = await tenant.query<{ scan_target_id: Uuid }[]>`
    SELECT scan_target_id FROM scan_target
    WHERE organization_id = ${tenant.organization_id} AND scan_target_code = ${CHECK_IN_TARGET_CODE}`
  return row!.scan_target_id
}

// ---------------------------------------------------------------------------
// arrival list
// ---------------------------------------------------------------------------

export type SubjectKind = 'booking' | 'registration'

export type ArrivalRow = {
  subject_kind: SubjectKind
  subject_id: Uuid
  party_id: Uuid | null
  display_name: string
  /** What they are here for: a court, or a program title. */
  label: string
  /** A second line: "Clinic · Coach Mia · Court 2" or "Court booking". */
  detail_label: string
  kind_code: string | null
  starts_at: Date
  ends_at: Date
  price_amount: string
  paid_state: PaidState
  waiver_state: WaiverState
  eligibility: Eligibility
  status_code: string
  check_in: { checked_in_at: Date; method_code: string; reason: string | null } | null
}

type Filter = { from: Date | null; to: Date | null; subject_kind: SubjectKind | null; subject_id: Uuid | null }

type CheckInColumn = { checked_in_at: Date | null; method_code: string | null; reason: string | null }

const KIND_LABEL: Record<string, string> = {
  clinic: 'Clinic',
  lesson: 'Lesson',
  social: 'Social',
  league: 'League',
  tournament: 'Tournament',
  private_event: 'Private event',
}

async function loadArrival(tenant: TenantContext, filter: Filter): Promise<ArrivalRow[]> {
  const enabled = await listEnabledModuleCode(tenant)

  const booking =
    filter.subject_kind === 'registration'
      ? []
      : await tenant.query<
          ({
            subject_id: Uuid
            party_id: Uuid | null
            party_name: string | null
            starts_at: Date
            ends_at: Date
            price_amount: string
            status_code: string
            court_name: string
            session_type: string
            is_paid: boolean
          } & CheckInColumn)[]
        >`
          SELECT b.booking_id AS subject_id, b.party_id, p.display_name AS party_name, b.starts_at, b.ends_at,
                 b.price_amount, b.status::text AS status_code, r.display_name AS court_name,
                 s.session_type::text AS session_type,
                 (b.detail->>'is_paid' = 'true' OR EXISTS (
                    SELECT 1 FROM invoice i
                    WHERE i.organization_id = b.organization_id AND i.deleted_at IS NULL AND i.status <> 'void'
                      AND (i.invoice_code = b.booking_code OR i.invoice_id::text = b.detail->>'invoice_id')
                      AND (i.status = 'paid' OR (i.total_amount > 0 AND i.balance_amount = 0)))) AS is_paid,
                 ci.checked_in_at, ci.method_code, ci.reason
          FROM booking b
          JOIN resource r ON r.resource_id = b.resource_id
          JOIN session s ON s.session_id = b.session_id
          LEFT JOIN party p ON p.party_id = b.party_id
          LEFT JOIN arrival_check_in ci
            ON ci.organization_id = b.organization_id AND ci.subject_kind = 'booking' AND ci.subject_id = b.booking_id
          WHERE b.organization_id = ${tenant.organization_id}
            AND b.status IN ('hold', 'confirmed')
            AND NOT EXISTS (SELECT 1 FROM program_occurrence po WHERE po.booking_id = b.booking_id)
            AND (${filter.from}::timestamptz IS NULL OR b.starts_at >= ${filter.from}::timestamptz)
            AND (${filter.to}::timestamptz IS NULL OR b.starts_at < ${filter.to}::timestamptz)
            AND (${filter.subject_id}::uuid IS NULL OR b.booking_id = ${filter.subject_id}::uuid)`

  const registration =
    filter.subject_kind === 'booking' || !enabled.includes('program')
      ? []
      : await tenant.query<
          ({
            subject_id: Uuid
            party_id: Uuid | null
            display_name: string
            status_code: string
            paid_at: Date | null
            starts_at: Date
            ends_at: Date
            title: string
            kind_code: string
            host_name: string | null
            price_amount: string
            is_member_only: boolean
            min_rating: string | null
            rating_provider_code: string | null
            court_name: string | null
          } & CheckInColumn)[]
        >`
          SELECT rg.program_registration_id AS subject_id, rg.party_id, rg.display_name, rg.status_code, rg.paid_at,
                 o.starts_at, o.ends_at, p.title, p.kind_code, p.host_name, p.price_amount, p.is_member_only,
                 p.min_rating::text AS min_rating, p.rating_provider_code, res.display_name AS court_name,
                 ci.checked_in_at, ci.method_code, ci.reason
          FROM program_registration rg
          JOIN program_occurrence o ON o.program_occurrence_id = rg.program_occurrence_id
          JOIN program p ON p.program_id = o.program_id
          LEFT JOIN resource res ON res.resource_id = p.resource_id
          LEFT JOIN arrival_check_in ci
            ON ci.organization_id = rg.organization_id AND ci.subject_kind = 'registration'
           AND ci.subject_id = rg.program_registration_id
          WHERE rg.organization_id = ${tenant.organization_id}
            AND (${filter.subject_id}::uuid IS NOT NULL
                 OR (rg.status_code IN ('registered', 'attended', 'no_show') AND o.status_code = 'scheduled'))
            AND (${filter.from}::timestamptz IS NULL OR o.starts_at >= ${filter.from}::timestamptz)
            AND (${filter.to}::timestamptz IS NULL OR o.starts_at < ${filter.to}::timestamptz)
            AND (${filter.subject_id}::uuid IS NULL OR rg.program_registration_id = ${filter.subject_id}::uuid)`

  const party = [...booking.map((one) => one.party_id), ...registration.map((one) => one.party_id)]
  const waiver = enabled.includes('arrival') ? await readWaiverState(tenant, party) : new Map<string | null, WaiverState>()
  const member_party = registration.filter((one) => one.is_member_only && one.party_id).map((one) => one.party_id!)
  const member = await listActiveMember(tenant, member_party)

  const checkIn = (one: CheckInColumn): ArrivalRow['check_in'] =>
    one.checked_in_at ? { checked_in_at: one.checked_in_at, method_code: one.method_code!, reason: one.reason } : null

  const row: ArrivalRow[] = []
  for (const one of booking) {
    const paid_state: PaidState = Number(one.price_amount) === 0 ? 'free' : one.is_paid ? 'paid' : 'unpaid'
    const waiver_state = waiver.get(one.party_id) ?? 'not_required'
    row.push({
      subject_kind: 'booking',
      subject_id: one.subject_id,
      party_id: one.party_id,
      display_name: one.party_name ?? 'Guest (no name on file)',
      label: one.court_name,
      detail_label: one.session_type === 'open_play' ? 'Open play' : 'Court booking',
      kind_code: null,
      starts_at: one.starts_at,
      ends_at: one.ends_at,
      price_amount: one.price_amount,
      paid_state,
      waiver_state,
      eligibility: describeEligibility({
        paid_state,
        waiver_state,
        is_member_only: false,
        is_member: false,
        min_rating: null,
        rating_provider_code: null,
      }),
      status_code: one.status_code,
      check_in: checkIn(one),
    })
  }
  for (const one of registration) {
    const paid_state: PaidState = Number(one.price_amount) === 0 ? 'free' : one.paid_at ? 'paid' : 'unpaid'
    const waiver_state = waiver.get(one.party_id) ?? 'not_required'
    row.push({
      subject_kind: 'registration',
      subject_id: one.subject_id,
      party_id: one.party_id,
      display_name: one.display_name,
      label: one.title,
      detail_label: [KIND_LABEL[one.kind_code] ?? one.kind_code, one.host_name, one.court_name].filter(Boolean).join(' · '),
      kind_code: one.kind_code,
      starts_at: one.starts_at,
      ends_at: one.ends_at,
      price_amount: one.price_amount,
      paid_state,
      waiver_state,
      eligibility: describeEligibility({
        paid_state,
        waiver_state,
        is_member_only: one.is_member_only,
        is_member: one.party_id ? member.has(one.party_id) : false,
        min_rating: one.min_rating,
        rating_provider_code: one.rating_provider_code,
      }),
      status_code: one.status_code,
      check_in: checkIn(one),
    })
  }
  row.sort(
    (left, right) =>
      new Date(left.starts_at).getTime() - new Date(right.starts_at).getTime() || left.display_name.localeCompare(right.display_name),
  )
  return row
}

export async function venueTimeZone(tenant: TenantContext): Promise<string> {
  const [row] = await tenant.query<{ time_zone: string }[]>`
    SELECT time_zone FROM site
    WHERE organization_id = ${tenant.organization_id} AND time_zone IS NOT NULL AND deleted_at IS NULL
    ORDER BY created_at LIMIT 1`
  return row?.time_zone ?? DEFAULT_TIME_ZONE
}

export async function listArrivalDay(tenant: TenantContext, date: string) {
  const time_zone = await venueTimeZone(tenant)
  const arrival = await loadArrival(tenant, {
    from: zonedInstant(date, '00:00', time_zone),
    to: zonedInstant(addDay(date, 1), '00:00', time_zone),
    subject_kind: null,
    subject_id: null,
  })
  const waiver = await findCurrentWaiver(tenant)
  return {
    date,
    time_zone,
    expected_count: arrival.length,
    arrived_count: arrival.filter((one) => one.check_in).length,
    waiver: waiver ? { arrival_waiver_version_id: waiver.arrival_waiver_version_id, version_number: waiver.version_number, title: waiver.title } : null,
    arrival,
  }
}

export async function findArrival(tenant: TenantContext, subject_kind: SubjectKind, subject_id: Uuid): Promise<ArrivalRow | undefined> {
  const [row] = await loadArrival(tenant, { from: null, to: null, subject_kind, subject_id })
  return row
}

// ---------------------------------------------------------------------------
// check-in
// ---------------------------------------------------------------------------

export type CheckInResult = { arrival: ArrivalRow; is_replay: boolean }

const CHECKABLE_REGISTRATION = new Set(['registered', 'attended', 'no_show'])

function readSubject(subject_kind: unknown, subject_id: unknown): { subject_kind: SubjectKind; subject_id: Uuid } {
  if (subject_kind !== 'booking' && subject_kind !== 'registration') {
    throw new DomainError('subject_kind must be booking or registration', 400)
  }
  if (!isUuid(subject_id)) throw new DomainError('nothing to check in: that booking or registration was not found', 404)
  return { subject_kind, subject_id }
}

async function writeCheckIn(
  tenant: TenantContext,
  row: ArrivalRow,
  input: { method_code: 'code' | 'desk' | 'staff_override' | 'self'; reason: string | null; session: Session | null },
): Promise<CheckInResult> {
  const [inserted] = await tenant.query<{ arrival_check_in_id: Uuid; checked_in_at: Date }[]>`
    INSERT INTO arrival_check_in (organization_id, subject_kind, subject_id, party_id, method_code, actor_id,
                                  auth_session_id, reason)
    VALUES (${tenant.organization_id}, ${row.subject_kind}, ${row.subject_id}, ${row.party_id}, ${input.method_code},
            ${input.session?.actor_id ?? null}, ${input.session?.auth_session_id ?? null}, ${input.reason})
    ON CONFLICT (organization_id, subject_kind, subject_id) DO NOTHING
    RETURNING arrival_check_in_id, checked_in_at`
  if (!inserted) {
    return { arrival: (await findArrival(tenant, row.subject_kind, row.subject_id)) ?? row, is_replay: true }
  }
  if (row.subject_kind === 'registration') {
    await tenant.query`
      UPDATE program_registration SET status_code = 'attended'
      WHERE organization_id = ${tenant.organization_id} AND program_registration_id = ${row.subject_id}
        AND status_code = 'registered'`
  }
  if (input.method_code === 'staff_override' && input.session) {
    const [actor] = await tenant.query<{ actor_code: string }[]>`
      SELECT actor_code FROM actor WHERE organization_id = ${tenant.organization_id} AND actor_id = ${input.session.actor_id}`
    await recordAuditEvent(tenant, {
      organization_id: tenant.organization_id,
      actor_label: actor?.actor_code ?? String(input.session.actor_id),
      event_code: 'arrival.check_in_override',
      subject_table: 'arrival_check_in',
      subject_id: inserted.arrival_check_in_id,
      reason: input.reason ?? '',
      detail: {
        actor_id: input.session.actor_id,
        auth_session_id: input.session.auth_session_id,
        subject_kind: row.subject_kind,
        subject_id: row.subject_id,
        blocker: row.eligibility.blocker,
      },
    })
  }
  await emitWebhook(tenant, {
    event_code: 'arrival.checked_in',
    subject_code: `${row.subject_kind}:${row.subject_id}`,
    payload: {
      subject_kind: row.subject_kind,
      subject_id: row.subject_id,
      method_code: input.method_code,
      checked_in_at: new Date(inserted.checked_in_at).toISOString(),
    },
  })
  const arrival = await findArrival(tenant, row.subject_kind, row.subject_id)
  return { arrival: arrival!, is_replay: false }
}

/** Staff check-in from the arrival desk. An ineligible player needs an override with a reason. */
export async function staffCheckIn(
  tenant: TenantContext,
  session: Session,
  body: Record<string, unknown>,
): Promise<CheckInResult> {
  const subject = readSubject(body['subject_kind'], body['subject_id'])
  const method = body['method_code'] ?? body['method'] ?? 'desk'
  if (method !== 'desk' && method !== 'code' && method !== 'staff_override') {
    throw new DomainError('method must be desk, code, or staff_override', 400)
  }
  const reason = typeof body['reason'] === 'string' && body['reason'].trim() ? body['reason'].trim().slice(0, 500) : null
  if (method === 'staff_override' && !reason) throw new DomainError('an override needs a reason', 400)

  const row = await findArrival(tenant, subject.subject_kind, subject.subject_id)
  if (!row) throw new DomainError('nothing to check in: that booking or registration was not found', 404)
  if (row.check_in) return { arrival: row, is_replay: true }
  if (row.subject_kind === 'registration' && !CHECKABLE_REGISTRATION.has(row.status_code)) {
    throw new DomainError(`this registration is ${row.status_code.replace('_', ' ')}, so it cannot check in`, 409)
  }
  if (method !== 'staff_override' && !row.eligibility.is_eligible) {
    throw new DomainError(`Override needed: ${row.eligibility.sentence}`, 409)
  }
  return writeCheckIn(tenant, row, { method_code: method, reason, session })
}

type SecretSubject = { subject_kind: SubjectKind; subject_id: Uuid }

/** Find what a credential, scan token, or booking code refers to — without consuming anything. */
async function findSubjectBySecret(
  tenant: TenantContext,
  input: { credential: string | null; code: string | null },
  now: Date,
): Promise<SecretSubject | undefined> {
  if (input.credential) {
    const [row] = await tenant.query<{ program_registration_id: Uuid }[]>`
      SELECT program_registration_id FROM program_registration
      WHERE organization_id = ${tenant.organization_id} AND credential_hash = ${hashCredential(input.credential)}`
    if (row) return { subject_kind: 'registration', subject_id: row.program_registration_id }
  }
  if (input.code) {
    const scan = await findCodeByToken(tenant, input.code)
    if (scan && scan.subject_id && scan.is_active && !scan.revoked_at && (!scan.valid_until || new Date(scan.valid_until) > now)) {
      const subject = await subjectById(tenant, scan.subject_id)
      if (subject) return subject
    }
    const [booking] = await tenant.query<{ booking_id: Uuid }[]>`
      SELECT booking_id FROM booking WHERE organization_id = ${tenant.organization_id} AND booking_code = ${input.code}`
    if (booking) return { subject_kind: 'booking', subject_id: booking.booking_id }
  }
  return undefined
}

async function subjectById(tenant: TenantContext, subject_id: Uuid): Promise<SecretSubject | undefined> {
  const [registration] = await tenant.query`
    SELECT 1 FROM program_registration WHERE organization_id = ${tenant.organization_id} AND program_registration_id = ${subject_id}`
  if (registration) return { subject_kind: 'registration', subject_id }
  const [booking] = await tenant.query`
    SELECT 1 FROM booking WHERE organization_id = ${tenant.organization_id} AND booking_id = ${subject_id}`
  if (booking) return { subject_kind: 'booking', subject_id }
  return undefined
}

function readSecret(body: Record<string, unknown>): { credential: string | null; code: string | null } {
  const credential = typeof body['credential'] === 'string' && body['credential'].trim() ? body['credential'].trim().slice(0, 200) : null
  const code = typeof body['code'] === 'string' && body['code'].trim() ? body['code'].trim().slice(0, 200) : null
  return { credential, code }
}

/** A player checking themselves in with their credential, QR token, or booking code. */
export async function selfCheckIn(tenant: TenantContext, body: Record<string, unknown>, now = new Date()): Promise<CheckInResult> {
  const secret = readSecret(body)
  if (!secret.credential && !secret.code) throw new DomainError('enter the code from your confirmation', 400)
  const subject = await findSubjectBySecret(tenant, secret, now)
  if (!subject) throw new DomainError('we could not find a booking or registration for that code', 404)
  const row = (await findArrival(tenant, subject.subject_kind, subject.subject_id))!
  if (row.check_in) return { arrival: row, is_replay: true }
  if (row.subject_kind === 'registration' && !CHECKABLE_REGISTRATION.has(row.status_code)) {
    throw new ArrivalRefusal(
      row.status_code === 'waitlisted' ? 'you are still on the waitlist for this session' : 'this registration is no longer active',
      'not_registered',
    )
  }
  const window = checkInWindow(new Date(row.starts_at), new Date(row.ends_at), now)
  if (window.window_status === 'early') {
    throw new ArrivalRefusal('check-in opens one hour before your start time', 'too_early', { opens_at: window.opens_at })
  }
  if (window.window_status === 'ended') {
    throw new ArrivalRefusal('this session has already ended', 'ended', { closes_at: window.closes_at })
  }
  if (row.waiver_state === 'missing' || row.waiver_state === 'outdated') {
    const waiver = await findCurrentWaiver(tenant)
    throw new ArrivalRefusal(
      row.waiver_state === 'outdated' ? 'the waiver has changed — please read and accept the new version' : 'please accept the waiver first',
      'waiver_required',
      { waiver },
    )
  }
  if (row.eligibility.blocker.includes('member_only')) {
    throw new ArrivalRefusal('please see the front desk to check in', 'see_desk')
  }
  return writeCheckIn(tenant, row, { method_code: 'self', reason: null, session: null })
}

/** The public waiver acceptance: a registration credential, or a booking code plus the email on it. */
export async function acceptWaiverPublic(
  tenant: TenantContext,
  body: Record<string, unknown>,
  evidence: WaiverEvidence,
): Promise<{ version_number: number; accepted_at: Date; waiver_state: 'current' }> {
  const version_id = body['arrival_waiver_version_id'] ?? body['waiver_version_id']
  if (typeof version_id !== 'string' || !version_id) throw new DomainError('which waiver version are you accepting?', 400)
  const secret = readSecret(body)
  let party_id: Uuid | null = null
  if (secret.credential) {
    const [row] = await tenant.query<{ party_id: Uuid | null }[]>`
      SELECT party_id FROM program_registration
      WHERE organization_id = ${tenant.organization_id} AND credential_hash = ${hashCredential(secret.credential)}`
    if (!row) throw new DomainError('we could not find a registration for that code', 404)
    party_id = row.party_id
  } else {
    const booking_code = typeof body['booking_code'] === 'string' ? body['booking_code'].trim() : ''
    const email = typeof body['email'] === 'string' ? body['email'].trim().toLowerCase() : ''
    if (!booking_code || !email) throw new DomainError('enter your registration code, or your booking code and email', 400)
    const [row] = await tenant.query<{ party_id: Uuid }[]>`
      SELECT b.party_id FROM booking b JOIN party p ON p.party_id = b.party_id
      WHERE b.organization_id = ${tenant.organization_id} AND b.booking_code = ${booking_code}
        AND lower(p.email_address) = ${email}`
    // One answer for a wrong code and a wrong email.
    if (!row) throw new DomainError('we could not find a booking for that code and email', 404)
    party_id = row.party_id
  }
  if (!party_id) throw new DomainError('this booking has no player on file — please sign the waiver at the front desk', 409)
  const accepted = await acceptWaiver(tenant, { party_id, arrival_waiver_version_id: version_id, channel_code: 'self', evidence })
  return { ...accepted, waiver_state: 'current' }
}

/** Staff recording a waiver signed at the desk for a booking or registration holder. */
export async function acceptWaiverAtDesk(
  tenant: TenantContext,
  body: Record<string, unknown>,
  evidence: WaiverEvidence,
): Promise<ArrivalRow> {
  const subject = readSubject(body['subject_kind'], body['subject_id'])
  const row = await findArrival(tenant, subject.subject_kind, subject.subject_id)
  if (!row) throw new DomainError('that booking or registration was not found', 404)
  if (!row.party_id) throw new DomainError('this booking has no player on file to sign for', 409)
  const version_id = body['arrival_waiver_version_id']
  const current = await findCurrentWaiver(tenant)
  await acceptWaiver(tenant, {
    party_id: row.party_id,
    arrival_waiver_version_id: typeof version_id === 'string' ? version_id : (current?.arrival_waiver_version_id ?? ''),
    channel_code: 'desk',
    evidence,
  })
  return (await findArrival(tenant, row.subject_kind, row.subject_id))!
}

/** A code typed or scanned at the desk: scan token, booking code, or registration credential. */
export async function resolveArrivalCode(
  tenant: TenantContext,
  session: Session,
  body: Record<string, unknown>,
  now = new Date(),
): Promise<{ arrival: ArrivalRow; is_today: boolean }> {
  const code = typeof body['code'] === 'string' ? body['code'].trim().slice(0, 200) : ''
  if (!code) throw new DomainError('type or scan a code', 400)
  let subject: SecretSubject | undefined

  const scan = await findCodeByToken(tenant, code)
  if (scan) {
    // Through resolveCode so the desk scan is logged with its outcome and actor.
    const resolution = await resolveCode(tenant, {
      token: code,
      actor: { actor_id: session.actor_id, capability: session.capability },
      payload: { source: 'arrival_desk' },
    })
    if (resolution.outcome !== 'resolved') {
      throw new DomainError(resolution.detail ?? `this code cannot be used (${resolution.outcome.replaceAll('_', ' ')})`, 409)
    }
    if (resolution.target?.command_code === CHECK_IN_COMMAND_CODE && resolution.subject_id) {
      subject = await subjectById(tenant, resolution.subject_id)
    }
  }
  subject ??= await findSubjectBySecret(tenant, { credential: code, code }, now)
  if (!subject) throw new DomainError('no booking or registration matches that code', 404)
  const arrival = (await findArrival(tenant, subject.subject_kind, subject.subject_id))!
  const time_zone = await venueTimeZone(tenant)
  const format = (value: Date) =>
    new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: time_zone }).format(value)
  return { arrival, is_today: format(new Date(arrival.starts_at)) === format(now) }
}
