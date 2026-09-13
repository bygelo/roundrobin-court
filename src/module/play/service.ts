// Open-play persistence: every read and write the routes and contracts use.
//
// Every mutation on a session starts by locking its play_session row, so two
// front-desk tablets pressing "Fill free courts" at once serialize instead of
// racing — and the partial unique indexes in migration 004 refuse a double
// assignment even if that lock were ever bypassed.

import { randomBytes, randomInt } from 'node:crypto'
import { DomainError, type TenantContext, type Uuid } from '@bygelo/roundrobin-kernel'
import {
  FAIRNESS_RULE,
  SEAT_COUNT,
  lateArrivalCredit,
  planRotation,
  publicName,
  type EngineEntry,
  type PlayFormat,
} from './engine.ts'

export class PlayNotFoundError extends DomainError {
  constructor(what = 'open-play session') {
    super(`${what} not found`, 404)
  }
}

export const ACTIVE_STATUS = ['registered', 'waiting', 'playing'] as const
export const SESSION_STATUS = ['draft', 'open', 'closed'] as const
export type SessionStatus = (typeof SESSION_STATUS)[number]
export type EntryStatus = 'registered' | 'waiting' | 'playing' | 'waitlisted' | 'no_show' | 'left' | 'done'

const DEFAULT_TIME_ZONE = 'Asia/Manila'

type SessionRow = {
  play_session_id: Uuid
  session_id: Uuid | null
  display_name: string
  starts_at: Date
  ends_at: Date
  format_code: PlayFormat
  capacity_count: number
  public_token: string
  join_code: string
  status_code: SessionStatus
  created_at: Date
}

type EntryRow = {
  play_entry_id: Uuid
  party_id: Uuid | null
  display_name: string
  status_code: EntryStatus
  checked_in_at: Date | null
  waitlist_position: number | null
  game_count: number
  credit_count: number
  last_finished_at: Date | null
  created_at: Date
}

type CourtRow = { resource_id: Uuid; display_name: string; position: number }

type GameRow = {
  play_game_id: Uuid
  resource_id: Uuid
  started_at: Date
  finished_at: Date | null
  score_text: string | null
}

type GameEntryRow = { play_game_id: Uuid; play_entry_id: Uuid; team_number: number }

const iso = (value: Date | string | null): string | null =>
  value === null ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString()

function sessionView(row: SessionRow) {
  return {
    play_session_id: row.play_session_id,
    session_id: row.session_id,
    display_name: row.display_name,
    starts_at: iso(row.starts_at)!,
    ends_at: iso(row.ends_at)!,
    format_code: row.format_code,
    seat_count: SEAT_COUNT[row.format_code],
    capacity_count: row.capacity_count,
    public_token: row.public_token,
    join_code: row.join_code,
    status_code: row.status_code,
  }
}

export type PlaySessionView = ReturnType<typeof sessionView>

// ---------------------------------------------------------------------------
// input checking
// ---------------------------------------------------------------------------

function text(value: unknown, field: string, max = 80): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new DomainError(`${field} is required`, 400)
  const trimmed = value.trim().replace(/\s+/g, ' ')
  if (trimmed.length > max) throw new DomainError(`${field} must be at most ${max} characters`, 400)
  return trimmed
}

function instant(value: unknown, field: string): Date {
  const date = typeof value === 'string' ? new Date(value) : undefined
  if (!date || Number.isNaN(date.getTime())) throw new DomainError(`${field} must be a date and time`, 400)
  return date
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function assertUuid(value: unknown, field: string): Uuid {
  if (typeof value !== 'string' || !UUID_SHAPE.test(value)) throw new DomainError(`${field} is not valid`, 400)
  return value as Uuid
}

// ---------------------------------------------------------------------------
// courts and sessions
// ---------------------------------------------------------------------------

export async function listCourt(tenant: TenantContext) {
  return tenant.query<{ resource_id: Uuid; display_name: string; site_display_name: string; sort_order: number }[]>`
    SELECT r.resource_id, r.display_name, s.display_name AS site_display_name, r.sort_order
    FROM resource r
    JOIN site s ON s.site_id = r.site_id
    WHERE r.organization_id = ${tenant.organization_id}
      AND r.deleted_at IS NULL AND s.deleted_at IS NULL
    ORDER BY s.display_name, r.sort_order, r.display_name`
}

export async function listSession(tenant: TenantContext) {
  const row = await tenant.query<
    (SessionRow & { court_count: number; active_count: number; waitlisted_count: number; playing_count: number; bucket: number })[]
  >`
    SELECT ps.play_session_id, ps.session_id, ps.display_name, ps.starts_at, ps.ends_at, ps.format_code,
           ps.capacity_count, ps.public_token, ps.join_code, ps.status_code, ps.created_at,
           (SELECT count(*)::int FROM play_session_resource psr WHERE psr.play_session_id = ps.play_session_id) AS court_count,
           (SELECT count(*)::int FROM play_entry pe WHERE pe.play_session_id = ps.play_session_id
              AND pe.status_code IN ('registered', 'waiting', 'playing')) AS active_count,
           (SELECT count(*)::int FROM play_entry pe WHERE pe.play_session_id = ps.play_session_id
              AND pe.status_code = 'waitlisted') AS waitlisted_count,
           (SELECT count(*)::int FROM play_entry pe WHERE pe.play_session_id = ps.play_session_id
              AND pe.status_code = 'playing') AS playing_count,
           CASE
             WHEN (ps.starts_at AT TIME ZONE ${DEFAULT_TIME_ZONE})::date = (now() AT TIME ZONE ${DEFAULT_TIME_ZONE})::date
               OR (ps.starts_at <= now() AND ps.ends_at > now()) THEN 0
             WHEN ps.starts_at > now() THEN 1
             ELSE 2
           END AS bucket
    FROM play_session ps
    WHERE ps.organization_id = ${tenant.organization_id}
      AND ps.deleted_at IS NULL
      AND ps.ends_at > now() - interval '30 days'
    ORDER BY bucket,
             CASE WHEN ps.starts_at > now() - interval '1 day' THEN ps.starts_at END ASC,
             ps.starts_at DESC
    LIMIT 200`
  return row.map((one) => ({
    ...sessionView(one),
    court_count: one.court_count,
    active_count: one.active_count,
    playing_count: one.playing_count,
    waitlisted_count: one.waitlisted_count,
    spot_count: Math.max(0, one.capacity_count - one.active_count),
    is_today: one.bucket === 0,
  }))
}

export type CreateSessionInput = {
  display_name?: unknown
  starts_at?: unknown
  ends_at?: unknown
  format_code?: unknown
  capacity_count?: unknown
  resource_id?: unknown
  session_id?: unknown
  status_code?: unknown
}

export function newPublicToken(): string {
  return randomBytes(16).toString('base64url')
}

export function newJoinCode(): string {
  return String(randomInt(0, 10_000)).padStart(4, '0')
}

export async function createSession(tenant: TenantContext, input: CreateSessionInput): Promise<PlaySessionView> {
  const display_name = text(input.display_name, 'display_name')
  const starts_at = instant(input.starts_at, 'starts_at')
  const ends_at = instant(input.ends_at, 'ends_at')
  if (ends_at <= starts_at) throw new DomainError('the session must end after it starts', 400)
  const format_code = (input.format_code ?? 'doubles') as PlayFormat
  if (!(format_code in SEAT_COUNT)) throw new DomainError('format_code must be doubles or singles', 400)
  const capacity_count = Number(input.capacity_count)
  if (!Number.isInteger(capacity_count) || capacity_count < 1 || capacity_count > 500) {
    throw new DomainError('capacity_count must be a whole number from 1 to 500', 400)
  }
  const status_code = (input.status_code ?? 'open') as SessionStatus
  if (status_code !== 'draft' && status_code !== 'open') throw new DomainError('status_code must be draft or open', 400)
  if (!Array.isArray(input.resource_id) || input.resource_id.length === 0) {
    throw new DomainError('choose at least one court', 400)
  }
  const resource_id = input.resource_id.map((one, index) => assertUuid(one, `resource_id[${index}]`))
  if (new Set(resource_id).size !== resource_id.length) throw new DomainError('a court is listed twice', 400)
  const session_id = input.session_id === undefined || input.session_id === null ? null : assertUuid(input.session_id, 'session_id')

  const known = await tenant.query<{ resource_id: Uuid }[]>`
    SELECT resource_id FROM resource
    WHERE organization_id = ${tenant.organization_id} AND deleted_at IS NULL
      AND resource_id = ANY(${resource_id}::uuid[])`
  if (known.length !== resource_id.length) throw new DomainError('a chosen court does not exist at this venue', 400)

  const [row] = await tenant.query<SessionRow[]>`
    INSERT INTO play_session (organization_id, session_id, display_name, starts_at, ends_at, format_code,
                              capacity_count, public_token, join_code, status_code)
    VALUES (${tenant.organization_id}, ${session_id}, ${display_name}, ${starts_at}, ${ends_at}, ${format_code},
            ${capacity_count}, ${newPublicToken()}, ${newJoinCode()}, ${status_code})
    RETURNING *`
  for (const [index, one] of resource_id.entries()) {
    await tenant.query`
      INSERT INTO play_session_resource (organization_id, play_session_id, resource_id, position)
      VALUES (${tenant.organization_id}, ${row!.play_session_id}, ${one}, ${index + 1})`
  }
  return sessionView(row!)
}

async function lockSession(tenant: TenantContext, play_session_id: Uuid): Promise<SessionRow> {
  const [row] = await tenant.query<SessionRow[]>`
    SELECT * FROM play_session
    WHERE organization_id = ${tenant.organization_id} AND play_session_id = ${play_session_id} AND deleted_at IS NULL
    FOR UPDATE`
  if (!row) throw new PlayNotFoundError()
  return row
}

function assertOpen(session: SessionRow) {
  if (session.status_code === 'closed') throw new DomainError('this session is closed', 409)
}

export async function setSessionStatus(tenant: TenantContext, play_session_id: Uuid, status_code: 'open' | 'closed') {
  const session = await lockSession(tenant, play_session_id)
  if (session.status_code === status_code) return readSessionState(tenant, play_session_id)
  if (status_code === 'open' && session.status_code === 'closed') {
    throw new DomainError('a closed session cannot be reopened; create a new one', 409)
  }
  if (status_code === 'closed') {
    // Finishing a game cascades is_finished to its players — nobody stays "on court".
    await tenant.query`
      UPDATE play_game SET finished_at = now()
      WHERE play_session_id = ${play_session_id} AND finished_at IS NULL`
    await tenant.query`
      UPDATE play_entry SET status_code = 'done', waitlist_position = NULL
      WHERE play_session_id = ${play_session_id}
        AND status_code IN ('registered', 'waiting', 'playing', 'waitlisted')`
  }
  await tenant.query`UPDATE play_session SET status_code = ${status_code} WHERE play_session_id = ${play_session_id}`
  return readSessionState(tenant, play_session_id)
}

// ---------------------------------------------------------------------------
// the state a console, a phone, and a TV all read
// ---------------------------------------------------------------------------

async function loadScene(tenant: TenantContext, play_session_id: Uuid) {
  const court = await tenant.query<CourtRow[]>`
    SELECT psr.resource_id, r.display_name, psr.position
    FROM play_session_resource psr
    JOIN resource r ON r.resource_id = psr.resource_id
    WHERE psr.play_session_id = ${play_session_id}
    ORDER BY psr.position`
  const entry = await tenant.query<EntryRow[]>`
    SELECT play_entry_id, party_id, display_name, status_code, checked_in_at, waitlist_position,
           game_count, credit_count, last_finished_at, created_at
    FROM play_entry WHERE play_session_id = ${play_session_id}
    ORDER BY created_at, play_entry_id`
  const game = await tenant.query<GameRow[]>`
    SELECT play_game_id, resource_id, started_at, finished_at, score_text
    FROM play_game WHERE play_session_id = ${play_session_id}
    ORDER BY started_at, play_game_id`
  const game_entry = await tenant.query<GameEntryRow[]>`
    SELECT play_game_id, play_entry_id, team_number
    FROM play_game_entry WHERE play_session_id = ${play_session_id}`
  return { court, entry, game, game_entry }
}

type Scene = Awaited<ReturnType<typeof loadScene>>

/** Engine input for everyone waiting, including last-game partners and opponents. */
function engineEntry(scene: Scene): EngineEntry[] {
  const finished = new Map(scene.game.filter((one) => one.finished_at).map((one) => [one.play_game_id, one]))
  const seat_of_game = new Map<Uuid, GameEntryRow[]>()
  for (const one of scene.game_entry) {
    const list = seat_of_game.get(one.play_game_id) ?? []
    list.push(one)
    seat_of_game.set(one.play_game_id, list)
  }
  const latest = new Map<Uuid, GameEntryRow>()
  for (const one of scene.game_entry) {
    const game = finished.get(one.play_game_id)
    if (!game) continue
    const previous = latest.get(one.play_entry_id)
    const previous_game = previous ? finished.get(previous.play_game_id) : undefined
    if (!previous_game || game.finished_at! > previous_game.finished_at!) latest.set(one.play_entry_id, one)
  }

  return scene.entry
    .filter((one) => one.status_code === 'waiting')
    .map((one) => {
      const seat = latest.get(one.play_entry_id)
      const other = seat ? (seat_of_game.get(seat.play_game_id) ?? []).filter((each) => each.play_entry_id !== one.play_entry_id) : []
      return {
        play_entry_id: one.play_entry_id,
        display_name: one.display_name,
        checked_in_at: iso(one.checked_in_at)!,
        game_count: one.game_count,
        credit_count: one.credit_count,
        last_finished_at: iso(one.last_finished_at),
        recent_partner_id: other.filter((each) => each.team_number === seat!.team_number).map((each) => each.play_entry_id),
        recent_opponent_id: other.filter((each) => each.team_number !== seat!.team_number).map((each) => each.play_entry_id),
      }
    })
}

function freeCourt(scene: Scene) {
  const busy = new Set(scene.game.filter((one) => !one.finished_at).map((one) => one.resource_id))
  return scene.court.filter((one) => !busy.has(one.resource_id)).map((one) => ({ resource_id: one.resource_id, position: one.position }))
}

export async function readSessionState(tenant: TenantContext, play_session_id: Uuid) {
  const [session] = await tenant.query<(SessionRow & { now: Date })[]>`
    SELECT *, now() AS now FROM play_session
    WHERE organization_id = ${tenant.organization_id} AND play_session_id = ${play_session_id} AND deleted_at IS NULL`
  if (!session) throw new PlayNotFoundError()
  const scene = await loadScene(tenant, play_session_id)
  return projectState(session, scene, session.now)
}

function projectState(session: SessionRow, scene: Scene, now: Date) {
  const name_of = new Map(scene.entry.map((one) => [one.play_entry_id, one.display_name]))
  const waiting = engineEntry(scene)
  // What a free court would call next: the projection is the engine itself,
  // run with no free court, so it can never disagree with a real rotation.
  const projection = planRotation({ format_code: session.format_code, free_court: [], entry: waiting })
  const queue_position = new Map(projection.queue.map((id, index) => [id, index + 1]))
  const live_game = scene.game.filter((one) => !one.finished_at)

  const court = scene.court.map((one) => {
    const game = live_game.find((each) => each.resource_id === one.resource_id)
    const seat = game ? scene.game_entry.filter((each) => each.play_game_id === game.play_game_id) : []
    return {
      resource_id: one.resource_id,
      display_name: one.display_name,
      position: one.position,
      game: game
        ? {
            play_game_id: game.play_game_id,
            started_at: iso(game.started_at)!,
            elapsed_second: Math.max(0, Math.floor((now.getTime() - game.started_at.getTime()) / 1000)),
            team: [1, 2].map((team_number) => ({
              team_number,
              player: seat
                .filter((each) => each.team_number === team_number)
                .map((each) => ({ play_entry_id: each.play_entry_id, display_name: name_of.get(each.play_entry_id) ?? 'Player' })),
            })),
          }
        : null,
    }
  })

  const active_count = scene.entry.filter((one) => (ACTIVE_STATUS as readonly string[]).includes(one.status_code)).length
  const finished_count = scene.game.filter((one) => one.finished_at).length

  return {
    play_session: sessionView(session),
    fairness_rule: FAIRNESS_RULE,
    now: now.toISOString(),
    court,
    up_next: projection.up_next.map((id) => ({ play_entry_id: id, display_name: name_of.get(id)! })),
    queue: projection.queue.map((id, index) => ({ play_entry_id: id, display_name: name_of.get(id)!, position: index + 1 })),
    roster: scene.entry
      .filter((one) => one.status_code !== 'waitlisted')
      .map((one) => ({
        play_entry_id: one.play_entry_id,
        display_name: one.display_name,
        party_id: one.party_id,
        status_code: one.status_code,
        checked_in_at: iso(one.checked_in_at),
        game_count: one.game_count,
        credit_count: one.credit_count,
        last_finished_at: iso(one.last_finished_at),
        queue_position: queue_position.get(one.play_entry_id) ?? null,
      })),
    waitlist: scene.entry
      .filter((one) => one.status_code === 'waitlisted')
      .sort((left, right) => left.waitlist_position! - right.waitlist_position!)
      .map((one) => ({
        play_entry_id: one.play_entry_id,
        display_name: one.display_name,
        party_id: one.party_id,
        waitlist_position: one.waitlist_position!,
        checked_in_at: iso(one.checked_in_at),
      })),
    active_count,
    spot_count: Math.max(0, session.capacity_count - active_count),
    waiting_count: waiting.length,
    free_court_count: freeCourt(scene).length,
    finished_game_count: finished_count,
    // True when pressing "Fill free courts" would put somebody on court.
    can_rotate: session.status_code === 'open' && planRotation({ format_code: session.format_code, free_court: freeCourt(scene), entry: waiting }).assignment.length > 0,
  }
}

export type PlaySessionState = ReturnType<typeof projectState>

// ---------------------------------------------------------------------------
// roster
// ---------------------------------------------------------------------------

async function presentCredit(tenant: TenantContext, play_session_id: Uuid, except?: Uuid): Promise<number> {
  const present = await tenant.query<{ game_count: number; credit_count: number }[]>`
    SELECT game_count, credit_count FROM play_entry
    WHERE play_session_id = ${play_session_id} AND status_code IN ('waiting', 'playing')
      AND (${except ?? null}::uuid IS NULL OR play_entry_id <> ${except ?? null}::uuid)`
  return lateArrivalCredit(present)
}

async function countActive(tenant: TenantContext, play_session_id: Uuid): Promise<number> {
  const [row] = await tenant.query<{ count: number }[]>`
    SELECT count(*)::int AS count FROM play_entry
    WHERE play_session_id = ${play_session_id} AND status_code IN ('registered', 'waiting', 'playing')`
  return row!.count
}

async function assertNameFree(tenant: TenantContext, play_session_id: Uuid, display_name: string) {
  const [taken] = await tenant.query`
    SELECT 1 FROM play_entry
    WHERE play_session_id = ${play_session_id}
      AND lower(btrim(display_name)) = lower(${display_name})
      AND status_code IN ('registered', 'waiting', 'playing', 'waitlisted')`
  if (taken) throw new DomainError(`${display_name} is already on this session's list — add a last initial to tell them apart`, 409)
}

export type EntryResult = { play_entry_id: Uuid; display_name: string; status_code: EntryStatus; waitlist_position: number | null }

async function insertEntry(
  tenant: TenantContext,
  session: SessionRow,
  input: { display_name: string; party_id: Uuid | null; is_checked_in: boolean },
): Promise<EntryResult> {
  const has_room = (await countActive(tenant, session.play_session_id)) < session.capacity_count
  const credit_count = input.is_checked_in && has_room ? await presentCredit(tenant, session.play_session_id) : 0
  const status_code: EntryStatus = !has_room ? 'waitlisted' : input.is_checked_in ? 'waiting' : 'registered'
  const [row] = await tenant.query<EntryResult[]>`
    INSERT INTO play_entry (organization_id, play_session_id, party_id, display_name, status_code, checked_in_at,
                            waitlist_position, credit_count)
    VALUES (${tenant.organization_id}, ${session.play_session_id}, ${input.party_id}, ${input.display_name}, ${status_code},
            CASE WHEN ${input.is_checked_in}::boolean THEN now() END,
            CASE WHEN ${has_room}::boolean THEN NULL
                 ELSE (SELECT coalesce(max(waitlist_position), 0) + 1 FROM play_entry
                       WHERE play_session_id = ${session.play_session_id}) END,
            ${credit_count})
    RETURNING play_entry_id, display_name, status_code, waitlist_position`
  return row!
}

export async function addEntry(
  tenant: TenantContext,
  play_session_id: Uuid,
  input: { display_name?: unknown; party_id?: unknown; is_checked_in?: unknown },
): Promise<EntryResult> {
  const display_name = text(input.display_name, 'display_name')
  const party_id = input.party_id === undefined || input.party_id === null || input.party_id === '' ? null : assertUuid(input.party_id, 'party_id')
  const session = await lockSession(tenant, play_session_id)
  assertOpen(session)
  await assertNameFree(tenant, play_session_id, display_name)
  if (party_id) {
    const [party] = await tenant.query`SELECT 1 FROM party WHERE party_id = ${party_id} AND deleted_at IS NULL`
    if (!party) throw new DomainError('that player record does not exist at this venue', 400)
  }
  return insertEntry(tenant, session, { display_name, party_id, is_checked_in: input.is_checked_in !== false })
}

async function lockEntry(tenant: TenantContext, play_entry_id: Uuid) {
  const [found] = await tenant.query<{ play_session_id: Uuid }[]>`
    SELECT play_session_id FROM play_entry WHERE play_entry_id = ${play_entry_id}`
  if (!found) throw new PlayNotFoundError('player')
  const session = await lockSession(tenant, found.play_session_id)
  const [entry] = await tenant.query<EntryRow[]>`SELECT * FROM play_entry WHERE play_entry_id = ${play_entry_id}`
  return { session, entry: entry! }
}

/** Fill one vacancy from the front of the waitlist. Returns the promoted entry, if any. */
async function promoteOne(tenant: TenantContext, session: SessionRow): Promise<EntryResult | null> {
  if ((await countActive(tenant, session.play_session_id)) >= session.capacity_count) return null
  const [next] = await tenant.query<EntryRow[]>`
    SELECT * FROM play_entry
    WHERE play_session_id = ${session.play_session_id} AND status_code = 'waitlisted'
    ORDER BY waitlist_position LIMIT 1`
  if (!next) return null
  const is_here = next.checked_in_at !== null
  const credit_count = is_here ? await presentCredit(tenant, session.play_session_id) : 0
  const [row] = await tenant.query<EntryResult[]>`
    UPDATE play_entry
    SET status_code = ${is_here ? 'waiting' : 'registered'}, waitlist_position = NULL, credit_count = ${credit_count}
    WHERE play_entry_id = ${next.play_entry_id}
    RETURNING play_entry_id, display_name, status_code, waitlist_position`
  return row!
}

export async function checkInEntry(tenant: TenantContext, play_entry_id: Uuid) {
  const { session, entry } = await lockEntry(tenant, play_entry_id)
  assertOpen(session)
  if (entry.status_code === 'waiting' || entry.status_code === 'playing') {
    return { entry: pick(entry), is_replay: true }
  }
  if (entry.status_code === 'waitlisted') {
    // Here, but still behind the capacity line: record arrival so promotion puts them straight in the queue.
    const [row] = await tenant.query<EntryRow[]>`
      UPDATE play_entry SET checked_in_at = coalesce(checked_in_at, now())
      WHERE play_entry_id = ${play_entry_id} RETURNING *`
    return { entry: pick(row!), is_replay: entry.checked_in_at !== null }
  }
  if (entry.status_code !== 'registered') {
    throw new DomainError(`${entry.display_name} is no longer on the list; add them again`, 409)
  }
  const credit_count = await presentCredit(tenant, session.play_session_id)
  const [row] = await tenant.query<EntryRow[]>`
    UPDATE play_entry SET status_code = 'waiting', checked_in_at = now(), credit_count = ${credit_count}
    WHERE play_entry_id = ${play_entry_id} RETURNING *`
  return { entry: pick(row!), is_replay: false }
}

export async function markNoShow(tenant: TenantContext, play_entry_id: Uuid) {
  const { session, entry } = await lockEntry(tenant, play_entry_id)
  assertOpen(session)
  if (entry.status_code === 'no_show') return { entry: pick(entry), promoted_entry: null, is_replay: true }
  if (entry.status_code !== 'registered' && entry.status_code !== 'waitlisted') {
    throw new DomainError(`${entry.display_name} has checked in, so they cannot be a no-show; remove them instead`, 409)
  }
  const [row] = await tenant.query<EntryRow[]>`
    UPDATE play_entry SET status_code = 'no_show', waitlist_position = NULL, left_at = now()
    WHERE play_entry_id = ${play_entry_id} RETURNING *`
  const promoted_entry = entry.status_code === 'registered' ? await promoteOne(tenant, session) : null
  return { entry: pick(row!), promoted_entry, is_replay: false }
}

export async function removeEntry(tenant: TenantContext, play_entry_id: Uuid) {
  const { session, entry } = await lockEntry(tenant, play_entry_id)
  assertOpen(session)
  if (entry.status_code === 'left' || entry.status_code === 'no_show' || entry.status_code === 'done') {
    return { entry: pick(entry), promoted_entry: null, is_replay: true }
  }
  // A player leaving mid-game stays in that game's record; the game finishes
  // normally and they are simply not returned to the queue. The court is never stranded.
  const [row] = await tenant.query<EntryRow[]>`
    UPDATE play_entry SET status_code = 'left', waitlist_position = NULL, left_at = now()
    WHERE play_entry_id = ${play_entry_id} RETURNING *`
  const promoted_entry = entry.status_code === 'waitlisted' ? null : await promoteOne(tenant, session)
  return { entry: pick(row!), promoted_entry, is_replay: false }
}

function pick(entry: EntryRow): EntryResult {
  return {
    play_entry_id: entry.play_entry_id,
    display_name: entry.display_name,
    status_code: entry.status_code,
    waitlist_position: entry.waitlist_position,
  }
}

// ---------------------------------------------------------------------------
// rotation and games
// ---------------------------------------------------------------------------

export async function rotateSession(tenant: TenantContext, play_session_id: Uuid) {
  const session = await lockSession(tenant, play_session_id)
  if (session.status_code !== 'open') throw new DomainError('open the session before filling courts', 409)
  const scene = await loadScene(tenant, play_session_id)
  const plan = planRotation({ format_code: session.format_code, free_court: freeCourt(scene), entry: engineEntry(scene) })

  const created_game: { play_game_id: Uuid; resource_id: Uuid; team: string[][] }[] = []
  for (const one of plan.assignment) {
    const [game] = await tenant.query<{ play_game_id: Uuid }[]>`
      INSERT INTO play_game (organization_id, play_session_id, resource_id)
      VALUES (${tenant.organization_id}, ${play_session_id}, ${one.resource_id})
      RETURNING play_game_id`
    for (const [team_index, team] of one.team.entries()) {
      for (const play_entry_id of team) {
        await tenant.query`
          INSERT INTO play_game_entry (organization_id, play_session_id, play_game_id, play_entry_id, team_number)
          VALUES (${tenant.organization_id}, ${play_session_id}, ${game!.play_game_id}, ${play_entry_id}, ${team_index + 1})`
      }
    }
    await tenant.query`
      UPDATE play_entry SET status_code = 'playing'
      WHERE play_session_id = ${play_session_id} AND play_entry_id = ANY(${one.play_entry_id}::uuid[]) AND status_code = 'waiting'`
    created_game.push({ play_game_id: game!.play_game_id, resource_id: one.resource_id as Uuid, team: one.team })
  }
  return { created_game, state: await readSessionState(tenant, play_session_id) }
}

export async function finishGame(tenant: TenantContext, play_game_id: Uuid, input: { score_text?: unknown }) {
  const score_text =
    input.score_text === undefined || input.score_text === null || input.score_text === ''
      ? null
      : text(input.score_text, 'score_text', 60)
  const [found] = await tenant.query<{ play_session_id: Uuid }[]>`
    SELECT play_session_id FROM play_game WHERE play_game_id = ${play_game_id}`
  if (!found) throw new PlayNotFoundError('game')
  await lockSession(tenant, found.play_session_id)
  const [game] = await tenant.query<GameRow[]>`SELECT * FROM play_game WHERE play_game_id = ${play_game_id}`
  if (game!.finished_at) {
    return { is_replay: true, state: await readSessionState(tenant, found.play_session_id) }
  }
  const [finished] = await tenant.query<{ finished_at: Date }[]>`
    UPDATE play_game SET finished_at = now(), score_text = ${score_text}
    WHERE play_game_id = ${play_game_id} RETURNING finished_at`
  await tenant.query`
    UPDATE play_entry pe
    SET game_count = pe.game_count + 1,
        last_finished_at = ${finished!.finished_at},
        status_code = CASE WHEN pe.status_code = 'playing' THEN 'waiting' ELSE pe.status_code END
    FROM play_game_entry ge
    WHERE ge.play_game_id = ${play_game_id} AND ge.play_entry_id = pe.play_entry_id`
  return { is_replay: false, state: await readSessionState(tenant, found.play_session_id) }
}

// ---------------------------------------------------------------------------
// public projections — names shortened, no ids, no party, no join code
// ---------------------------------------------------------------------------

export async function findSessionIdByToken(tenant: TenantContext, public_token: string): Promise<Uuid | undefined> {
  const [row] = await tenant.query<{ play_session_id: Uuid }[]>`
    SELECT play_session_id FROM play_session
    WHERE public_token = ${public_token} AND deleted_at IS NULL AND status_code <> 'draft'`
  return row?.play_session_id
}

export function publicState(state: PlaySessionState, venue_display_name: string) {
  return {
    venue_display_name,
    display_name: state.play_session.display_name,
    starts_at: state.play_session.starts_at,
    ends_at: state.play_session.ends_at,
    format_code: state.play_session.format_code,
    status_code: state.play_session.status_code,
    fairness_rule: state.fairness_rule,
    now: state.now,
    court: state.court.map((one) => ({
      display_name: one.display_name,
      started_at: one.game?.started_at ?? null,
      team: one.game ? one.game.team.map((team) => ({ player: team.player.map((each) => ({ display_name: publicName(each.display_name) })) })) : [],
    })),
    up_next: state.up_next.map((one) => ({ display_name: publicName(one.display_name) })),
    waiting_count: state.waiting_count,
    waitlisted_count: state.waitlist.length,
    spot_count: state.spot_count,
  }
}

export async function selfCheckIn(
  tenant: TenantContext,
  play_session_id: Uuid,
  input: { display_name: string },
): Promise<EntryResult & { is_replay: boolean; queue_position: number | null }> {
  const session = await lockSession(tenant, play_session_id)
  if (session.status_code !== 'open') throw new DomainError('check-in is closed for this session', 409)
  const [existing] = await tenant.query<EntryRow[]>`
    SELECT * FROM play_entry
    WHERE play_session_id = ${play_session_id}
      AND lower(btrim(display_name)) = lower(${input.display_name})
      AND status_code IN ('registered', 'waiting', 'playing', 'waitlisted')`
  let result: EntryResult
  let is_replay = false
  if (existing) {
    // The desk added them earlier, or their phone retried: arrive, never duplicate.
    const outcome = await checkInEntry(tenant, existing.play_entry_id)
    result = outcome.entry
    is_replay = outcome.is_replay
  } else {
    result = await insertEntry(tenant, session, { display_name: input.display_name, party_id: null, is_checked_in: true })
  }
  const state = await readSessionState(tenant, play_session_id)
  const queue_position = state.queue.find((one) => one.play_entry_id === result.play_entry_id)?.position ?? null
  return { ...result, is_replay, queue_position }
}

export async function listPublicSession(tenant: TenantContext) {
  const row = await tenant.query<(SessionRow & { active_count: number })[]>`
    SELECT ps.*,
           (SELECT count(*)::int FROM play_entry pe WHERE pe.play_session_id = ps.play_session_id
              AND pe.status_code IN ('registered', 'waiting', 'playing')) AS active_count
    FROM play_session ps
    WHERE ps.organization_id = ${tenant.organization_id}
      AND ps.deleted_at IS NULL
      AND ps.status_code = 'open'
      AND ps.ends_at > now()
      AND (ps.starts_at AT TIME ZONE ${DEFAULT_TIME_ZONE})::date <= (now() AT TIME ZONE ${DEFAULT_TIME_ZONE})::date
    ORDER BY ps.starts_at, ps.display_name`
  return row.map((one) => ({
    display_name: one.display_name,
    starts_at: iso(one.starts_at)!,
    ends_at: iso(one.ends_at)!,
    format_code: one.format_code,
    capacity_count: one.capacity_count,
    spot_count: Math.max(0, one.capacity_count - one.active_count),
    public_token: one.public_token,
  }))
}
