// Score persistence. The database holds the operation log; the score is always
// replay(profile, log). Every write locks its score_match row first, so two
// tablets on one court are serialised into one order and converge.

import { DomainError, type TenantContext, type Uuid } from '@bygelo/roundrobin-kernel'
import { emitWebhook } from '../webhook/contract.ts'
import {
  SCORE_OPERATION_KIND,
  ScoreRuleError,
  applyOperation,
  buildOperationForScore,
  describeRule,
  describeState,
  isScoringRuleCode,
  replay,
  validateProfile,
  type GameRecord,
  type GameScore,
  type ScoreOperation,
  type ScoreOperationKind,
  type ScoreState,
  type ScoringProfile,
  type StateView,
  type TeamNumber,
} from './engine.ts'

export class ScoreError extends DomainError {}

export type MatchStatus = 'live' | 'complete' | 'confirmed'

export type MatchPlayer = { display_name: string; party_id: string | null }

export type MatchTeam = {
  team_number: TeamNumber
  /** "Ana & Ben" — what a board shows. */
  display_name: string
  player_display_name: string[]
  player: MatchPlayer[]
}

export type MatchOperation = {
  sequence_number: number
  client_operation_id: string
  operation: ScoreOperation
  created_at: string
}

export type MatchCorrection = {
  score_correction_id: string
  reason: string
  actor_display_name: string | null
  operation_set_version: number
  previous_game_point: [number, number][]
  corrected_game_point: [number, number][]
  created_at: string
}

export type MatchView = {
  score_match_id: string
  resource_id: string | null
  court_display_name: string | null
  sport_profile_code: string
  sport_display_name: string
  scoring_rule_code: string
  rule_description: string
  team_size_count: number
  best_of_count: number
  status: MatchStatus
  operation_set_version: number
  operation_count: number
  played_at: string
  confirmed_at: string | null
  confirmed_by_display_name: string | null
  updated_at: string
  team: [MatchTeam, MatchTeam]
  state: StateView
  /** The operation set in effect, in order — what a tablet replays offline. */
  operation: MatchOperation[]
  correction: MatchCorrection[]
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null
  return new Date(value).toISOString()
}

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

type MatchRow = {
  score_match_id: Uuid
  resource_id: Uuid | null
  court_display_name: string | null
  sport_profile_code: string
  sport_display_name: string | null
  scoring_rule_code: string
  team_size_count: number
  best_of_count: number
  status: MatchStatus
  operation_set_version: number
  played_at: Date
  confirmed_at: Date | null
  confirmed_by_display_name: string | null
  updated_at: Date
}

export function profileOf(row: { scoring_rule_code: string; best_of_count: number; team_size_count: number }): ScoringProfile {
  return {
    scoring_rule_code: row.scoring_rule_code,
    best_of_count: Number(row.best_of_count),
    team_size_count: Number(row.team_size_count),
  }
}

/** jsonb may come back as text depending on how it was bound; accept both. */
function asJson<T>(value: T | string): T {
  return typeof value === 'string' ? (JSON.parse(value) as T) : value
}

function toOperation(kind: string, payload: Record<string, unknown> | string): ScoreOperation {
  return { ...asJson(payload), kind } as ScoreOperation
}

function jsonParameter(tenant: TenantContext, value: unknown) {
  return tenant.query.json(value as Parameters<TenantContext['query']['json']>[0])
}

function toPayload(operation: ScoreOperation): Record<string, unknown> {
  const { kind: _kind, ...rest } = operation as ScoreOperation & Record<string, unknown>
  return rest
}

function gamePoint(history: readonly GameRecord[]): [number, number][] {
  return history.map((one) => [one.point[0], one.point[1]])
}

/** Load full views for a set of matches, in the order given. Missing ids are skipped. */
export async function loadMatchView(tenant: TenantContext, score_match_id: string[]): Promise<MatchView[]> {
  if (score_match_id.length === 0) return []
  const organization_id = tenant.organization_id

  const match = await tenant.query<MatchRow[]>`
    SELECT m.score_match_id, m.resource_id, r.display_name AS court_display_name,
           m.sport_profile_code, sp.display_name AS sport_display_name,
           m.scoring_rule_code, m.team_size_count, m.best_of_count, m.status,
           m.operation_set_version, m.played_at, m.confirmed_at,
           ca.display_name AS confirmed_by_display_name, m.updated_at
    FROM score_match m
    LEFT JOIN resource r ON r.organization_id = m.organization_id AND r.resource_id = m.resource_id
    LEFT JOIN sport_profile sp ON sp.organization_id = m.organization_id AND sp.sport_profile_code = m.sport_profile_code
    LEFT JOIN actor ca ON ca.actor_id = m.confirmed_by_actor_id
    WHERE m.organization_id = ${organization_id}
      AND m.score_match_id = ANY(${score_match_id}::uuid[])
      AND m.deleted_at IS NULL`

  const player = await tenant.query<{ score_match_id: Uuid; team_number: number; display_name: string; party_id: Uuid | null }[]>`
    SELECT score_match_id, team_number, display_name, party_id
    FROM score_match_player
    WHERE organization_id = ${organization_id} AND score_match_id = ANY(${score_match_id}::uuid[])
    ORDER BY score_match_id, team_number, slot_number`

  const operation = await tenant.query<{
    score_match_id: Uuid
    sequence_number: number
    client_operation_id: string
    kind: ScoreOperationKind
    payload: Record<string, unknown>
    created_at: Date
  }[]>`
    SELECT o.score_match_id, o.sequence_number, o.client_operation_id, o.kind, o.payload, o.created_at
    FROM score_operation o
    JOIN score_match m ON m.score_match_id = o.score_match_id
     AND m.operation_set_version = o.operation_set_version
    WHERE o.organization_id = ${organization_id} AND o.score_match_id = ANY(${score_match_id}::uuid[])
    ORDER BY o.score_match_id, o.sequence_number`

  const correction = await tenant.query<{
    score_match_id: Uuid
    score_correction_id: Uuid
    reason: string
    actor_display_name: string | null
    operation_set_version: number
    previous_game_point: [number, number][]
    corrected_game_point: [number, number][]
    created_at: Date
  }[]>`
    SELECT c.score_match_id, c.score_correction_id, c.reason, a.display_name AS actor_display_name,
           c.operation_set_version, c.previous_game_point, c.corrected_game_point, c.created_at
    FROM score_correction c
    LEFT JOIN actor a ON a.actor_id = c.actor_id
    WHERE c.organization_id = ${organization_id} AND c.score_match_id = ANY(${score_match_id}::uuid[])
    ORDER BY c.score_match_id, c.operation_set_version`

  const by_id = new Map(match.map((one) => [one.score_match_id, one]))
  const view: MatchView[] = []
  for (const id of score_match_id) {
    const row = by_id.get(id)
    if (!row) continue
    const profile = profileOf(row)
    const own_operation = operation.filter((one) => one.score_match_id === id)
    const state = replay(
      profile,
      own_operation.map((one) => toOperation(one.kind, one.payload)),
    )
    const team = ([1, 2] as const).map((team_number): MatchTeam => {
      const member = player.filter((one) => one.score_match_id === id && Number(one.team_number) === team_number)
      const name = member.map((one) => one.display_name)
      return {
        team_number,
        display_name: name.join(' & ') || `Team ${team_number}`,
        player_display_name: name,
        player: member.map((one) => ({ display_name: one.display_name, party_id: one.party_id })),
      }
    }) as [MatchTeam, MatchTeam]

    view.push({
      score_match_id: row.score_match_id,
      resource_id: row.resource_id,
      court_display_name: row.court_display_name,
      sport_profile_code: row.sport_profile_code,
      sport_display_name: row.sport_display_name ?? row.sport_profile_code,
      scoring_rule_code: row.scoring_rule_code,
      rule_description: describeRule(profile),
      team_size_count: Number(row.team_size_count),
      best_of_count: Number(row.best_of_count),
      status: row.status,
      operation_set_version: Number(row.operation_set_version),
      operation_count: own_operation.length,
      played_at: iso(row.played_at)!,
      confirmed_at: iso(row.confirmed_at),
      confirmed_by_display_name: row.confirmed_by_display_name,
      updated_at: iso(row.updated_at)!,
      team,
      state: describeState(state, profile),
      operation: own_operation.map((one) => ({
        sequence_number: Number(one.sequence_number),
        client_operation_id: one.client_operation_id,
        operation: toOperation(one.kind, one.payload),
        created_at: iso(one.created_at)!,
      })),
      correction: correction
        .filter((one) => one.score_match_id === id)
        .map((one) => ({
          score_correction_id: one.score_correction_id,
          reason: one.reason,
          actor_display_name: one.actor_display_name,
          operation_set_version: Number(one.operation_set_version),
          previous_game_point: asJson(one.previous_game_point),
          corrected_game_point: asJson(one.corrected_game_point),
          created_at: iso(one.created_at)!,
        })),
    })
  }
  return view
}

export async function findMatch(tenant: TenantContext, score_match_id: string): Promise<MatchView | undefined> {
  if (!isUuid(score_match_id)) return undefined
  const [view] = await loadMatchView(tenant, [score_match_id])
  return view
}

export type MatchListView = 'live' | 'recent'

export async function listMatch(
  tenant: TenantContext,
  filter: { view: MatchListView; resource_id?: string | null; limit_count?: number },
): Promise<MatchView[]> {
  const resource_id = filter.resource_id && isUuid(filter.resource_id) ? filter.resource_id : null
  const limit_count = Math.min(Math.max(filter.limit_count ?? 30, 1), 100)
  const status: MatchStatus[] = filter.view === 'live' ? ['live', 'complete'] : ['complete', 'confirmed']
  const row = await tenant.query<{ score_match_id: Uuid }[]>`
    SELECT score_match_id
    FROM score_match
    WHERE organization_id = ${tenant.organization_id}
      AND deleted_at IS NULL
      AND status = ANY(${status}::text[])
      AND (${resource_id}::uuid IS NULL OR resource_id = ${resource_id}::uuid)
    ORDER BY ${filter.view === 'live' ? tenant.query`updated_at` : tenant.query`played_at`} DESC
    LIMIT ${limit_count}`
  return loadMatchView(
    tenant,
    row.map((one) => one.score_match_id),
  )
}

// ---------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------

export type CreateMatchInput = {
  resource_id?: string | null
  sport_profile_code: string
  team: { player_display_name: string[]; party_id?: (string | null)[] }[]
  best_of_count?: number
  actor_id?: string | null
  played_at?: Date
}

function readTeam(team: unknown): { display_name: string; party_id: string | null }[][] {
  if (!Array.isArray(team) || team.length !== 2) throw new ScoreError('team must list exactly two teams', 400)
  return team.map((one, position) => {
    const name = (one as { player_display_name?: unknown })?.player_display_name
    const party = (one as { party_id?: unknown })?.party_id
    if (!Array.isArray(name) || name.length < 1 || name.length > 4) {
      throw new ScoreError(`Team ${position + 1} needs one to four player names`, 400)
    }
    if (party !== undefined && party !== null && (!Array.isArray(party) || party.length > name.length)) {
      throw new ScoreError(`Team ${position + 1}: party_id must line up with player_display_name`, 400)
    }
    return name.map((value, slot) => {
      const display_name = typeof value === 'string' ? value.trim() : ''
      if (!display_name) throw new ScoreError(`Team ${position + 1} has an empty player name`, 400)
      if (display_name.length > 60) throw new ScoreError(`Team ${position + 1}: a player name is too long`, 400)
      const party_id = Array.isArray(party) ? (party[slot] ?? null) : null
      if (party_id !== null && !isUuid(party_id)) throw new ScoreError(`Team ${position + 1}: party_id is not a valid id`, 400)
      return { display_name, party_id }
    })
  })
}

export async function createMatch(tenant: TenantContext, input: CreateMatchInput): Promise<MatchView> {
  const organization_id = tenant.organization_id
  if (typeof input.sport_profile_code !== 'string' || !input.sport_profile_code.trim()) {
    throw new ScoreError('sport_profile_code is required', 400)
  }
  const [profile_row] = await tenant.query<{ sport_profile_code: string; scoring_rule_code: string; display_name: string }[]>`
    SELECT sport_profile_code, scoring_rule_code, display_name FROM sport_profile
    WHERE organization_id = ${organization_id} AND sport_profile_code = ${input.sport_profile_code.trim()}`
  if (!profile_row) throw new ScoreError('That sport is not set up at this venue', 422)
  if (!isScoringRuleCode(profile_row.scoring_rule_code)) {
    throw new ScoreError(`${profile_row.display_name} uses scoring rule "${profile_row.scoring_rule_code}", which the scorer cannot keep`, 422)
  }

  const team = readTeam(input.team)
  const team_size_count = Math.max(team[0]!.length, team[1]!.length)
  const best_of_count = input.best_of_count ?? 1
  const profile: ScoringProfile = { scoring_rule_code: profile_row.scoring_rule_code, best_of_count, team_size_count }
  try {
    validateProfile(profile)
  } catch (error) {
    if (error instanceof ScoreRuleError) throw new ScoreError(error.message, 422)
    throw error
  }

  const resource_id = input.resource_id ?? null
  if (resource_id !== null) {
    if (!isUuid(resource_id)) throw new ScoreError('That court does not exist', 422)
    const [court] = await tenant.query`
      SELECT 1 FROM resource WHERE organization_id = ${organization_id} AND resource_id = ${resource_id} AND deleted_at IS NULL`
    if (!court) throw new ScoreError('That court does not exist', 422)
  }

  const party_id = team.flat().map((one) => one.party_id).filter((one): one is string => one !== null)
  if (party_id.length > 0) {
    const found = await tenant.query<{ party_id: Uuid }[]>`
      SELECT party_id FROM party WHERE organization_id = ${organization_id} AND party_id = ANY(${party_id}::uuid[])`
    if (found.length !== new Set(party_id).size) throw new ScoreError('A linked player is not a customer of this venue', 422)
  }

  const [match] = await tenant.query<{ score_match_id: Uuid }[]>`
    INSERT INTO score_match (organization_id, resource_id, sport_profile_code, scoring_rule_code,
                             team_size_count, best_of_count, created_by_actor_id, played_at)
    VALUES (${organization_id}, ${resource_id}, ${profile_row.sport_profile_code}, ${profile_row.scoring_rule_code},
            ${team_size_count}, ${best_of_count}, ${input.actor_id ?? null}, ${input.played_at ?? new Date()})
    RETURNING score_match_id`
  const score_match_id = match!.score_match_id

  for (const [position, member] of team.entries()) {
    for (const [slot, one] of member.entries()) {
      await tenant.query`
        INSERT INTO score_match_player (organization_id, score_match_id, team_number, slot_number, display_name, party_id)
        VALUES (${organization_id}, ${score_match_id}, ${position + 1}, ${slot + 1}, ${one.display_name}, ${one.party_id})`
    }
  }

  const view = await findMatch(tenant, score_match_id)
  return view!
}

/** Parse an operation from a request body. Shape errors are 400; rule refusals come later as 422. */
export function readOperation(body: unknown): ScoreOperation {
  const kind = (body as { kind?: unknown })?.kind
  if (typeof kind !== 'string' || !SCORE_OPERATION_KIND.includes(kind as ScoreOperationKind)) {
    throw new ScoreError(`kind must be one of ${SCORE_OPERATION_KIND.join(', ')}`, 400)
  }
  const raw_team = (body as { team_number?: unknown }).team_number
  const raw_server = (body as { server_number?: unknown }).server_number
  const team_number = raw_team === undefined || raw_team === null ? undefined : Number(raw_team)
  const needs_team = kind === 'rally_won' || kind === 'set_server' || kind === 'forfeit'
  if (needs_team && team_number !== 1 && team_number !== 2) throw new ScoreError('team_number must be 1 or 2', 400)
  switch (kind as ScoreOperationKind) {
    case 'rally_won':
      return { kind: 'rally_won', team_number: team_number as TeamNumber }
    case 'forfeit':
      return { kind: 'forfeit', team_number: team_number as TeamNumber }
    case 'set_server': {
      const server_number = raw_server === undefined || raw_server === null ? null : Number(raw_server)
      if (server_number !== null && server_number !== 1 && server_number !== 2) {
        throw new ScoreError('server_number must be 1 or 2', 400)
      }
      return { kind: 'set_server', team_number: team_number as TeamNumber, server_number: server_number as 1 | 2 | null }
    }
    case 'undo':
      return { kind: 'undo' }
    case 'end_game':
      return { kind: 'end_game' }
  }
}

type LockedMatch = {
  score_match_id: Uuid
  status: MatchStatus
  scoring_rule_code: string
  best_of_count: number
  team_size_count: number
  operation_set_version: number
}

async function lockMatch(tenant: TenantContext, score_match_id: string): Promise<LockedMatch> {
  if (!isUuid(score_match_id)) throw new ScoreError('match not found', 404)
  const [row] = await tenant.query<LockedMatch[]>`
    SELECT score_match_id, status, scoring_rule_code, best_of_count, team_size_count, operation_set_version
    FROM score_match
    WHERE organization_id = ${tenant.organization_id} AND score_match_id = ${score_match_id} AND deleted_at IS NULL
    FOR UPDATE`
  if (!row) throw new ScoreError('match not found', 404)
  return row
}

async function readCurrentState(tenant: TenantContext, locked: LockedMatch): Promise<{ state: ScoreState; sequence_count: number }> {
  const row = await tenant.query<{ kind: string; payload: Record<string, unknown> }[]>`
    SELECT kind, payload FROM score_operation
    WHERE organization_id = ${tenant.organization_id} AND score_match_id = ${locked.score_match_id}
      AND operation_set_version = ${locked.operation_set_version}
    ORDER BY sequence_number`
  return {
    state: replay(profileOf(locked), row.map((one) => toOperation(one.kind, one.payload))),
    sequence_count: row.length,
  }
}

const CONFIRMED_REFUSAL = 'This result is confirmed. Use a correction to change it.'

export async function recordOperation(
  tenant: TenantContext,
  score_match_id: string,
  input: { client_operation_id: unknown; operation: ScoreOperation; actor_id?: string | null },
): Promise<{ match: MatchView; is_replay: boolean }> {
  const client_operation_id = typeof input.client_operation_id === 'string' ? input.client_operation_id.trim() : ''
  if (!client_operation_id || client_operation_id.length > 128) {
    throw new ScoreError('client_operation_id is required (up to 128 characters)', 400)
  }

  const locked = await lockMatch(tenant, score_match_id)

  // A retry of a tap the server already has: answer with the current state and
  // apply nothing. Checked under the row lock, so a concurrent duplicate waits
  // for the first to commit and then lands here.
  const [existing] = await tenant.query`
    SELECT 1 FROM score_operation
    WHERE organization_id = ${tenant.organization_id} AND score_match_id = ${locked.score_match_id}
      AND client_operation_id = ${client_operation_id}`
  if (existing) {
    return { match: (await findMatch(tenant, locked.score_match_id))!, is_replay: true }
  }

  if (locked.status === 'confirmed') throw new ScoreError(CONFIRMED_REFUSAL, 409)

  const profile = profileOf(locked)
  const { state, sequence_count } = await readCurrentState(tenant, locked)
  const result = applyOperation(state, input.operation, profile)
  if (!result.is_ok) throw new ScoreError(result.reason, 422)

  await tenant.query`
    INSERT INTO score_operation (organization_id, score_match_id, operation_set_version, sequence_number,
                                 client_operation_id, kind, payload, actor_id)
    VALUES (${tenant.organization_id}, ${locked.score_match_id}, ${locked.operation_set_version}, ${sequence_count + 1},
            ${client_operation_id}, ${input.operation.kind}, ${jsonParameter(tenant, toPayload(input.operation))},
            ${input.actor_id ?? null})`

  const status: MatchStatus = result.state.is_complete ? 'complete' : 'live'
  await tenant.query`
    UPDATE score_match SET status = ${status}, updated_at = now()
    WHERE organization_id = ${tenant.organization_id} AND score_match_id = ${locked.score_match_id}`

  return { match: (await findMatch(tenant, locked.score_match_id))!, is_replay: false }
}

export function toMatchResult(view: MatchView) {
  return {
    score_match_id: view.score_match_id,
    status: 'confirmed' as const,
    played_at: view.played_at,
    sport_profile_code: view.sport_profile_code,
    team: view.team.map((one) => ({
      team_number: one.team_number,
      party_id: one.player.map((each) => each.party_id),
      player_display_name: one.player_display_name,
      game_point: view.state.game_history.map((game) => game.point[one.team_number - 1]!),
    })),
  }
}

export async function confirmMatch(
  tenant: TenantContext,
  score_match_id: string,
  actor_id: string | null,
): Promise<{ match: MatchView; is_replay: boolean }> {
  const locked = await lockMatch(tenant, score_match_id)
  if (locked.status === 'confirmed') {
    return { match: (await findMatch(tenant, locked.score_match_id))!, is_replay: true }
  }
  if (locked.status !== 'complete') {
    throw new ScoreError('The match is not finished. Confirm it after the last game ends.', 409)
  }
  await tenant.query`
    UPDATE score_match
    SET status = 'confirmed', confirmed_at = now(), confirmed_by_actor_id = ${actor_id}
    WHERE organization_id = ${tenant.organization_id} AND score_match_id = ${locked.score_match_id}`
  const match = (await findMatch(tenant, locked.score_match_id))!
  await emitWebhook(tenant, {
    event_code: 'match.confirmed',
    subject_code: match.score_match_id,
    payload: { ...toMatchResult(match), operation_set_version: match.operation_set_version },
  })
  return { match, is_replay: false }
}

function readGameScore(value: unknown): GameScore[] {
  if (!Array.isArray(value) || value.length === 0) throw new ScoreError('game_point must list each game score', 400)
  return value.map((one, position) => {
    const point = (one as { point?: unknown })?.point
    const tiebreak = (one as { tiebreak_point?: unknown })?.tiebreak_point
    const pair = (candidate: unknown, label: string): [number, number] => {
      if (!Array.isArray(candidate) || candidate.length !== 2 || !candidate.every((each) => Number.isInteger(Number(each)) && Number(each) >= 0)) {
        throw new ScoreError(`Game ${position + 1}: ${label} needs two whole numbers`, 400)
      }
      return [Number(candidate[0]), Number(candidate[1])]
    }
    return {
      point: pair(point, 'the score'),
      tiebreak_point: tiebreak === undefined || tiebreak === null ? null : pair(tiebreak, 'the tiebreak'),
    }
  })
}

export async function correctMatch(
  tenant: TenantContext,
  score_match_id: string,
  input: { reason: unknown; operation?: unknown; game_point?: unknown; actor_id: string | null },
): Promise<{ match: MatchView; correction: MatchCorrection }> {
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  if (!reason) throw new ScoreError('A correction needs a reason', 400)
  if (reason.length > 500) throw new ScoreError('The reason is too long (500 characters at most)', 400)

  const locked = await lockMatch(tenant, score_match_id)
  if (locked.status !== 'confirmed') {
    throw new ScoreError('Only a confirmed result takes a correction. While the match is open, use Undo.', 409)
  }
  const profile = profileOf(locked)

  let operation: ScoreOperation[]
  try {
    if (input.game_point !== undefined) {
      operation = buildOperationForScore(profile, readGameScore(input.game_point))
    } else if (Array.isArray(input.operation) && input.operation.length > 0) {
      operation = input.operation.map((one) => readOperation(one))
    } else {
      throw new ScoreError('A correction needs operation[] or game_point[]', 400)
    }
  } catch (error) {
    if (error instanceof ScoreRuleError) throw new ScoreError(error.message, 422)
    throw error
  }

  let corrected: ScoreState
  try {
    corrected = replay(profile, operation)
  } catch (error) {
    if (error instanceof ScoreRuleError) throw new ScoreError(error.message, 422)
    throw error
  }
  if (!corrected.is_complete) throw new ScoreError('The corrected sequence must finish the match', 422)

  const { state: previous } = await readCurrentState(tenant, locked)
  const previous_game_point = gamePoint(previous.game_history)
  const corrected_game_point = gamePoint(corrected.game_history)
  if (
    JSON.stringify(previous_game_point) === JSON.stringify(corrected_game_point) &&
    previous.winner_team_number === corrected.winner_team_number &&
    previous.forfeit_team_number === corrected.forfeit_team_number
  ) {
    throw new ScoreError('That is the result already recorded', 422)
  }

  const operation_set_version = Number(locked.operation_set_version) + 1
  for (const [position, one] of operation.entries()) {
    await tenant.query`
      INSERT INTO score_operation (organization_id, score_match_id, operation_set_version, sequence_number,
                                   client_operation_id, kind, payload, actor_id)
      VALUES (${tenant.organization_id}, ${locked.score_match_id}, ${operation_set_version}, ${position + 1},
              ${`correction:${operation_set_version}:${position + 1}`}, ${one.kind},
              ${jsonParameter(tenant, toPayload(one))}, ${input.actor_id})`
  }

  await tenant.query`
    INSERT INTO score_correction (organization_id, score_match_id, reason, actor_id,
                                  previous_operation_set_version, operation_set_version,
                                  previous_game_point, corrected_game_point)
    VALUES (${tenant.organization_id}, ${locked.score_match_id}, ${reason}, ${input.actor_id},
            ${locked.operation_set_version}, ${operation_set_version},
            ${jsonParameter(tenant, previous_game_point)}, ${jsonParameter(tenant, corrected_game_point)})`

  await tenant.query`
    UPDATE score_match SET operation_set_version = ${operation_set_version}
    WHERE organization_id = ${tenant.organization_id} AND score_match_id = ${locked.score_match_id}`

  const match = (await findMatch(tenant, locked.score_match_id))!
  await emitWebhook(tenant, {
    event_code: 'match.confirmed',
    subject_code: `${match.score_match_id}:${operation_set_version}`,
    payload: { ...toMatchResult(match), operation_set_version, correction_reason: reason },
  })
  return { match, correction: match.correction.at(-1)! }
}

/** Throw away a match scored by mistake. A confirmed result is never discarded. */
export async function discardMatch(tenant: TenantContext, score_match_id: string): Promise<void> {
  const locked = await lockMatch(tenant, score_match_id)
  if (locked.status === 'confirmed') throw new ScoreError('A confirmed result cannot be discarded. Use a correction.', 409)
  await tenant.query`
    UPDATE score_match SET deleted_at = now()
    WHERE organization_id = ${tenant.organization_id} AND score_match_id = ${locked.score_match_id}`
}

// ---------------------------------------------------------------------------
// pickers
// ---------------------------------------------------------------------------

export type ScoreOption = {
  court: { resource_id: string; display_name: string; sport_profile_code: string | null }[]
  sport_profile: {
    sport_profile_code: string
    display_name: string
    scoring_rule_code: string
    team_size_count: number
    is_supported: boolean
  }[]
}

export async function listScoreOption(tenant: TenantContext): Promise<ScoreOption> {
  const sport_profile = await tenant.query<{ sport_profile_code: string; display_name: string; scoring_rule_code: string; team_size_count: number }[]>`
    SELECT sport_profile_code, display_name, scoring_rule_code, team_size_count
    FROM sport_profile WHERE organization_id = ${tenant.organization_id}
    ORDER BY display_name`
  const court = await tenant.query<{ resource_id: Uuid; display_name: string; category_code: string | null }[]>`
    SELECT r.resource_id, r.display_name,
           (SELECT rc.resource_category_code FROM resource_category_link l
              JOIN resource_category rc ON rc.resource_category_id = l.resource_category_id
             WHERE l.resource_id = r.resource_id ORDER BY rc.resource_category_code LIMIT 1) AS category_code
    FROM resource r
    WHERE r.organization_id = ${tenant.organization_id} AND r.deleted_at IS NULL
    ORDER BY r.sort_order, r.display_name`
  const known = new Set(sport_profile.map((one) => one.sport_profile_code))
  return {
    court: court.map((one) => ({
      resource_id: one.resource_id,
      display_name: one.display_name,
      sport_profile_code: one.category_code && known.has(one.category_code) ? one.category_code : null,
    })),
    sport_profile: sport_profile.map((one) => ({
      ...one,
      team_size_count: Number(one.team_size_count),
      is_supported: isScoringRuleCode(one.scoring_rule_code),
    })),
  }
}
