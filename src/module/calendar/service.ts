// calendar service — feed tokens and the read-only projection (R23).
//
// The feed is computed from booking and program tables on every request. There
// is no inbound path: nothing a calendar client does can change venue data.
// Bookings render as anonymous "Court booked" busy blocks — never a name,
// email, phone, note, or price.

import { createHash, randomBytes } from 'node:crypto'
import { DomainError, type TenantContext, type Uuid } from '@bygelo/roundrobin-kernel'
import { renderCalendar, type IcsEvent, type IcsStatus } from './ics.ts'

export class CalendarError extends DomainError {}

export type CalendarScope = 'venue' | 'court' | 'program'

export type CalendarFeed = {
  calendar_feed_id: Uuid
  scope_code: CalendarScope
  scope_id: Uuid | null
  display_name: string
  token_prefix: string
  is_active: boolean
  rotated_at: Date | null
  revoked_at: Date | null
  created_at: Date
}

const PAST_WINDOW_DAY = 30
const FUTURE_WINDOW_DAY = 365

export function hashFeedToken(feed_token: string): string {
  return createHash('sha256').update(feed_token, 'utf8').digest('hex')
}

function generateToken(): { feed_token: string; feed_token_hash: string; token_prefix: string } {
  const feed_token = randomBytes(16).toString('base64url') // 128 bits
  return { feed_token, feed_token_hash: hashFeedToken(feed_token), token_prefix: feed_token.slice(0, 6) }
}

export function isFeedTokenShape(value: string): boolean {
  return /^[A-Za-z0-9_-]{20,64}$/.test(value)
}

async function readOrganization(tenant: TenantContext): Promise<{ organization_code: string; display_name: string }> {
  const [row] = await tenant.query<{ organization_code: string; display_name: string }[]>`
    SELECT organization_code, display_name FROM organization WHERE organization_id = ${tenant.organization_id}`
  if (!row) throw new CalendarError('organization not found', 404)
  return row
}

export function feedPath(organization_code: string, feed_token: string): string {
  return `/public/${encodeURIComponent(organization_code)}/calendar/${feed_token}.ics`
}

export async function listFeed(tenant: TenantContext): Promise<CalendarFeed[]> {
  return tenant.query<CalendarFeed[]>`
    SELECT calendar_feed_id, scope_code, scope_id, display_name, token_prefix, is_active, rotated_at, revoked_at, created_at
    FROM calendar_feed
    WHERE organization_id = ${tenant.organization_id} AND deleted_at IS NULL
    ORDER BY is_active DESC, created_at DESC`
}

async function findFeed(tenant: TenantContext, calendar_feed_id: Uuid): Promise<CalendarFeed> {
  const [row] = await tenant.query<CalendarFeed[]>`
    SELECT calendar_feed_id, scope_code, scope_id, display_name, token_prefix, is_active, rotated_at, revoked_at, created_at
    FROM calendar_feed
    WHERE organization_id = ${tenant.organization_id} AND calendar_feed_id = ${calendar_feed_id} AND deleted_at IS NULL`
  if (!row) throw new CalendarError('That calendar feed does not exist.', 404)
  return row
}

async function hasTable(tenant: TenantContext, table_name: string): Promise<boolean> {
  const [row] = await tenant.query<{ is_present: boolean }[]>`
    SELECT to_regclass(${`public.${table_name}`}) IS NOT NULL AS is_present`
  return row?.is_present === true
}

export type CreatedFeed = { feed: CalendarFeed; feed_token: string; feed_path: string }

export async function createFeed(
  tenant: TenantContext,
  input: { scope_code?: unknown; scope_id?: unknown; display_name?: unknown },
): Promise<CreatedFeed> {
  const scope_code = (input.scope_code ?? 'venue') as CalendarScope
  if (!['venue', 'court', 'program'].includes(scope_code)) throw new CalendarError('Choose venue, court, or program.')
  const scope_id = scope_code === 'venue' ? null : typeof input.scope_id === 'string' && input.scope_id ? input.scope_id : null
  if (scope_code !== 'venue' && !scope_id) {
    throw new CalendarError(scope_code === 'court' ? 'Choose the court for this feed.' : 'Choose the program for this feed.')
  }
  const organization = await readOrganization(tenant)
  let default_name = `${organization.display_name} — all courts`
  if (scope_code === 'court') {
    const [court] = await tenant.query<{ display_name: string }[]>`
      SELECT r.display_name FROM resource r JOIN site s ON s.site_id = r.site_id
      WHERE s.organization_id = ${tenant.organization_id} AND r.resource_id = ${scope_id} AND r.deleted_at IS NULL`
    if (!court) throw new CalendarError('That court does not exist.', 404)
    default_name = court.display_name
  }
  if (scope_code === 'program') {
    if (!(await hasTable(tenant, 'program'))) throw new CalendarError('Programs are not available at this venue.', 404)
    const [program] = await tenant.query<{ title: string }[]>`
      SELECT title FROM program WHERE organization_id = ${tenant.organization_id} AND program_id = ${scope_id} AND deleted_at IS NULL`
    if (!program) throw new CalendarError('That program does not exist.', 404)
    default_name = program.title
  }
  const display_name =
    typeof input.display_name === 'string' && input.display_name.trim() ? input.display_name.trim() : default_name
  const token = generateToken()
  const [row] = await tenant.query<{ calendar_feed_id: Uuid }[]>`
    INSERT INTO calendar_feed (organization_id, scope_code, scope_id, display_name, feed_token_hash, token_prefix)
    VALUES (${tenant.organization_id}, ${scope_code}, ${scope_id}, ${display_name}, ${token.feed_token_hash}, ${token.token_prefix})
    RETURNING calendar_feed_id`
  return {
    feed: await findFeed(tenant, row!.calendar_feed_id),
    feed_token: token.feed_token,
    feed_path: feedPath(organization.organization_code, token.feed_token),
  }
}

export async function rotateFeed(tenant: TenantContext, calendar_feed_id: Uuid): Promise<CreatedFeed> {
  const feed = await findFeed(tenant, calendar_feed_id)
  if (feed.revoked_at) throw new CalendarError('A revoked feed cannot be brought back. Create a new feed instead.', 409)
  const organization = await readOrganization(tenant)
  const token = generateToken()
  await tenant.query`
    UPDATE calendar_feed
    SET feed_token_hash = ${token.feed_token_hash}, token_prefix = ${token.token_prefix}, rotated_at = now(), is_active = true
    WHERE organization_id = ${tenant.organization_id} AND calendar_feed_id = ${calendar_feed_id}`
  return {
    feed: await findFeed(tenant, calendar_feed_id),
    feed_token: token.feed_token,
    feed_path: feedPath(organization.organization_code, token.feed_token),
  }
}

export async function revokeFeed(tenant: TenantContext, calendar_feed_id: Uuid): Promise<CalendarFeed> {
  const feed = await findFeed(tenant, calendar_feed_id)
  if (feed.revoked_at) return feed
  await tenant.query`
    UPDATE calendar_feed SET is_active = false, revoked_at = now()
    WHERE organization_id = ${tenant.organization_id} AND calendar_feed_id = ${calendar_feed_id}`
  return findFeed(tenant, calendar_feed_id)
}

// ---------------------------------------------------------------------------
// projection
// ---------------------------------------------------------------------------

type BookingRow = {
  booking_id: Uuid
  status: 'hold' | 'confirmed' | 'cancelled' | 'expired'
  starts_at: Date
  ends_at: Date
  created_at: Date
  updated_at: Date
  court_name: string
  site_name: string
}

type OccurrenceRow = {
  program_occurrence_id: Uuid
  booking_id: Uuid | null
  status_code: string
  starts_at: Date
  ends_at: Date
  created_at: Date
  updated_at: Date
  title: string
  kind_code: string
  court_name: string | null
  is_program_live: boolean
}

function sequenceOf(created_at: Date, updated_at: Date): number {
  return Math.max(0, Math.floor((new Date(updated_at).getTime() - new Date(created_at).getTime()) / 1000))
}

const BOOKING_STATUS: Record<BookingRow['status'], IcsStatus> = {
  hold: 'TENTATIVE',
  confirmed: 'CONFIRMED',
  cancelled: 'CANCELLED',
  expired: 'CANCELLED',
}

/** Render the feed for a presented token, or undefined for unknown / revoked. */
export async function renderFeed(tenant: TenantContext, feed_token: string, option: { now?: Date } = {}): Promise<string | undefined> {
  if (!isFeedTokenShape(feed_token)) return undefined
  const [feed] = await tenant.query<CalendarFeed[]>`
    SELECT calendar_feed_id, scope_code, scope_id, display_name, token_prefix, is_active, rotated_at, revoked_at, created_at
    FROM calendar_feed
    WHERE organization_id = ${tenant.organization_id} AND feed_token_hash = ${hashFeedToken(feed_token)}
      AND is_active AND revoked_at IS NULL AND deleted_at IS NULL`
  if (!feed) return undefined

  const organization = await readOrganization(tenant)
  const now = option.now ?? new Date()
  const from = new Date(now.getTime() - PAST_WINDOW_DAY * 86_400_000)
  const until = new Date(now.getTime() + FUTURE_WINDOW_DAY * 86_400_000)
  const uid = (id: string) => `${id}@${organization.organization_code}.court`
  const event: IcsEvent[] = []

  let occurrence: OccurrenceRow[] = []
  {
    if (await hasTable(tenant, 'program_occurrence')) {
      // Another module's schema: a changed column must not take the feed down.
      occurrence = await tenant.query
        .savepoint((sql) => sql<OccurrenceRow[]>`
          SELECT o.program_occurrence_id, o.booking_id, o.status_code, o.starts_at, o.ends_at, o.created_at, o.updated_at,
                 p.title, p.kind_code, r.display_name AS court_name,
                 (p.is_published AND p.deleted_at IS NULL) AS is_program_live
          FROM program_occurrence o
          JOIN program p ON p.program_id = o.program_id
          LEFT JOIN resource r ON r.resource_id = p.resource_id
          WHERE o.organization_id = ${tenant.organization_id}
            AND o.starts_at < ${until} AND o.ends_at > ${from}
            AND (p.is_published OR o.status_code = 'cancelled')
            AND (${feed.scope_code} = 'venue'
                 OR (${feed.scope_code} = 'court' AND p.resource_id = ${feed.scope_id}::uuid)
                 OR (${feed.scope_code} = 'program' AND p.program_id = ${feed.scope_id}::uuid))
          ORDER BY o.starts_at, o.program_occurrence_id`)
        .then((row) => [...row] as OccurrenceRow[])
        .catch(() => [])
    }
  }

  for (const one of occurrence) {
    const is_cancelled = one.status_code === 'cancelled' || !one.is_program_live
    event.push({
      uid: uid(one.program_occurrence_id),
      sequence: sequenceOf(one.created_at, one.updated_at),
      starts_at: one.starts_at,
      ends_at: one.ends_at,
      last_modified: one.updated_at,
      summary: one.title,
      location: one.court_name,
      description: one.kind_code.replaceAll('_', ' '),
      status: is_cancelled ? 'CANCELLED' : 'CONFIRMED',
      is_busy: true,
    })
  }

  if (feed.scope_code !== 'program') {
    const program_booking = new Set(occurrence.map((one) => one.booking_id).filter(Boolean))
    const booking = await tenant.query<BookingRow[]>`
      SELECT b.booking_id, b.status::text AS status, b.starts_at, b.ends_at, b.created_at, b.updated_at,
             r.display_name AS court_name, st.display_name AS site_name
      FROM booking b
      JOIN session s ON s.session_id = b.session_id
      JOIN resource r ON r.resource_id = b.resource_id
      JOIN site st ON st.site_id = s.site_id
      WHERE b.organization_id = ${tenant.organization_id}
        AND s.is_published AND s.deleted_at IS NULL
        AND b.starts_at < ${until} AND b.ends_at > ${from}
        AND (${feed.scope_code} = 'venue' OR b.resource_id = ${feed.scope_id}::uuid)
      ORDER BY b.starts_at, b.booking_id`
    for (const one of booking) {
      if (program_booking.has(one.booking_id)) continue
      event.push({
        uid: uid(one.booking_id),
        sequence: sequenceOf(one.created_at, one.updated_at),
        starts_at: one.starts_at,
        ends_at: one.ends_at,
        last_modified: one.updated_at,
        summary: `Court booked · ${one.court_name}`,
        location: `${one.court_name}, ${one.site_name}`,
        status: BOOKING_STATUS[one.status] ?? 'CONFIRMED',
        is_busy: true,
      })
    }
  }

  event.sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime() || a.uid.localeCompare(b.uid))
  return renderCalendar({ calendar_name: `${organization.display_name} — ${feed.display_name}`, event })
}
