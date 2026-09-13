// dupr service — honest connection, consented player links, rating-gated
// eligibility, and idempotent result submission (R20).

import {
  connectAccount,
  disconnectAccount,
  findAccount,
  recordValidation,
} from '@bygelo/roundrobin-connector'
import { DomainError, type Session, type TenantContext, type Uuid } from '@bygelo/roundrobin-kernel'
import { findMatchResult, type MatchResult } from '../score/contract.ts'
import {
  DuprUnavailableError,
  isLiveConfigured,
  isRefusal,
  isSandboxAllowed,
  normalizeDuprId,
  resolveDuprAdapter,
  type DuprAdapter,
  type DuprMatchPayload,
  type DuprMode,
  type DuprRefusal,
} from './adapter.ts'

export class DuprError extends DomainError {}

export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000

export type DuprOption = {
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  /** Injected in tests; production reads the score module's contract. */
  findResult?: (tenant: TenantContext, score_match_id: string) => Promise<MatchResult | undefined>
  now?: Date
}

// ---------------------------------------------------------------------------
// connection
// ---------------------------------------------------------------------------

export type DuprStatusCode = 'not_configured' | 'sandbox' | 'connected' | 'error'

export type DuprStatus = {
  status_code: DuprStatusCode
  mode_code: DuprMode | null
  last_validated_at: Date | null
  last_error: string | null
  is_sandbox_allowed: boolean
  is_live_configured: boolean
  player_link_count: number
  submission_count: number
}

type ConnectionRow = {
  dupr_connection_id: Uuid
  connector_account_id: Uuid | null
  mode_code: DuprMode | null
  status_code: DuprStatusCode
  last_validated_at: Date | null
  last_error: string | null
}

async function readConnection(tenant: TenantContext): Promise<ConnectionRow | undefined> {
  const [row] = await tenant.query<ConnectionRow[]>`
    SELECT dupr_connection_id, connector_account_id, mode_code, status_code, last_validated_at, last_error
    FROM dupr_connection WHERE organization_id = ${tenant.organization_id}`
  return row
}

export async function readDuprStatus(tenant: TenantContext, option: DuprOption = {}): Promise<DuprStatus> {
  const connection = await readConnection(tenant)
  const [count] = await tenant.query<{ player_link_count: number; submission_count: number }[]>`
    SELECT
      (SELECT count(*)::int FROM dupr_player_link WHERE organization_id = ${tenant.organization_id} AND deleted_at IS NULL) AS player_link_count,
      (SELECT count(*)::int FROM dupr_submission WHERE organization_id = ${tenant.organization_id}) AS submission_count`
  return {
    status_code: connection?.status_code ?? 'not_configured',
    mode_code: connection?.mode_code ?? null,
    last_validated_at: connection?.last_validated_at ?? null,
    last_error: connection?.last_error ?? null,
    is_sandbox_allowed: isSandboxAllowed(option.env),
    is_live_configured: isLiveConfigured(option.env),
    player_link_count: count?.player_link_count ?? 0,
    submission_count: count?.submission_count ?? 0,
  }
}

async function writeConnection(
  tenant: TenantContext,
  input: {
    connector_account_id: Uuid | null
    mode_code: DuprMode | null
    status_code: DuprStatusCode
    last_error: string | null
    is_validated: boolean
  },
): Promise<void> {
  await tenant.query`
    INSERT INTO dupr_connection (organization_id, connector_account_id, mode_code, status_code, last_error, last_validated_at)
    VALUES (${tenant.organization_id}, ${input.connector_account_id}, ${input.mode_code}, ${input.status_code},
            ${input.last_error}, CASE WHEN ${input.is_validated}::boolean THEN now() ELSE NULL END)
    ON CONFLICT (organization_id) DO UPDATE SET
      connector_account_id = EXCLUDED.connector_account_id,
      mode_code = EXCLUDED.mode_code,
      status_code = EXCLUDED.status_code,
      last_error = EXCLUDED.last_error,
      last_validated_at = COALESCE(EXCLUDED.last_validated_at, dupr_connection.last_validated_at)`
}

/**
 * Validate and connect. A refusal is RETURNED (and recorded), not thrown, so the
 * honest status survives the request transaction.
 */
export async function connectDupr(
  tenant: TenantContext,
  mode_code: unknown,
  option: DuprOption = {},
): Promise<{ status: DuprStatus; refusal: DuprRefusal | null }> {
  if (mode_code !== 'sandbox' && mode_code !== 'live') throw new DuprError('Choose sandbox or live.')
  const adapter = resolveDuprAdapter(mode_code, option)
  const validation = await adapter.validateConnection()
  const previous = await readConnection(tenant)

  if (isRefusal(validation)) {
    // A failed attempt never downgrades a working connection of the other mode.
    const is_working = previous && (previous.status_code === 'sandbox' || previous.status_code === 'connected')
    if (!is_working || previous.mode_code === mode_code) {
      if (previous?.connector_account_id && is_working) {
        await disconnectIfConnected(tenant, previous.connector_account_id)
      }
      await writeConnection(tenant, {
        connector_account_id: previous?.connector_account_id ?? null,
        mode_code,
        status_code: validation.refusal_code === 'not_configured' ? 'not_configured' : 'error',
        last_error: validation.message,
        is_validated: true,
      })
    }
    return { status: await readDuprStatus(tenant, option), refusal: validation }
  }

  if (previous?.connector_account_id) await disconnectIfConnected(tenant, previous.connector_account_id)
  // The credential stays in the environment; the connector account holds only its reference.
  const account = await connectAccount(tenant, {
    provider_code: 'dupr',
    account_label: mode_code === 'sandbox' ? 'DUPR sandbox' : 'DUPR partner API',
    secret_ref: mode_code === 'sandbox' ? 'env:DUPR_MODE' : 'env:DUPR_CLIENT_SECRET',
  })
  await recordValidation(tenant, account.connector_account_id, { validation_status: 'valid' })
  await writeConnection(tenant, {
    connector_account_id: account.connector_account_id,
    mode_code,
    status_code: mode_code === 'sandbox' ? 'sandbox' : 'connected',
    last_error: null,
    is_validated: true,
  })
  return { status: await readDuprStatus(tenant, option), refusal: null }
}

async function disconnectIfConnected(tenant: TenantContext, connector_account_id: Uuid): Promise<void> {
  const account = await findAccount(tenant, connector_account_id)
  if (account?.status === 'connected') await disconnectAccount(tenant, connector_account_id)
}

/** Revoke the connector account. Player links and submissions stay untouched. */
export async function disconnectDupr(tenant: TenantContext, option: DuprOption = {}): Promise<DuprStatus> {
  const connection = await readConnection(tenant)
  if (!connection || connection.status_code === 'not_configured') {
    throw new DuprError('DUPR is not connected.', 409)
  }
  if (connection.connector_account_id) await disconnectIfConnected(tenant, connection.connector_account_id)
  await writeConnection(tenant, {
    connector_account_id: connection.connector_account_id,
    mode_code: null,
    status_code: 'not_configured',
    last_error: null,
    is_validated: false,
  })
  return readDuprStatus(tenant, option)
}

async function activeAdapter(tenant: TenantContext, option: DuprOption): Promise<DuprAdapter | undefined> {
  const connection = await readConnection(tenant)
  if (!connection || !connection.mode_code) return undefined
  if (connection.status_code !== 'sandbox' && connection.status_code !== 'connected') return undefined
  return resolveDuprAdapter(connection.mode_code, option)
}

// ---------------------------------------------------------------------------
// player link
// ---------------------------------------------------------------------------

export type DuprPlayerLink = {
  dupr_player_link_id: Uuid
  party_id: Uuid | null
  display_name: string
  dupr_id: string
  consent_at: Date
  doubles_rating: string | null
  singles_rating: string | null
  rating_source_code: string | null
  rating_fetched_at: Date | null
  is_stale: boolean
  created_at: Date
}

type LinkRow = Omit<DuprPlayerLink, 'is_stale'>

function withStale(row: LinkRow, now: Date): DuprPlayerLink {
  const is_stale = !row.rating_fetched_at || now.getTime() - new Date(row.rating_fetched_at).getTime() > STALE_AFTER_MS
  return { ...row, is_stale }
}

export async function listPlayerLink(tenant: TenantContext, option: DuprOption = {}): Promise<DuprPlayerLink[]> {
  const row = await tenant.query<LinkRow[]>`
    SELECT dupr_player_link_id, party_id, display_name, dupr_id, consent_at, doubles_rating, singles_rating,
           rating_source_code, rating_fetched_at, created_at
    FROM dupr_player_link
    WHERE organization_id = ${tenant.organization_id} AND deleted_at IS NULL
    ORDER BY lower(display_name), created_at`
  const now = option.now ?? new Date()
  return row.map((one) => withStale(one, now))
}

export async function createPlayerLink(
  tenant: TenantContext,
  session: Session,
  input: { display_name?: unknown; party_id?: unknown; dupr_id?: unknown; has_consent?: unknown },
  option: DuprOption = {},
): Promise<DuprPlayerLink> {
  if (input.has_consent !== true) {
    throw new DuprError(
      "Record the player's consent before linking their DUPR ID. Results are shared with DUPR only with the player's permission.",
    )
  }
  if (typeof input.dupr_id !== 'string' || !input.dupr_id.trim()) throw new DuprError("Enter the player's DUPR ID.")
  const party_id = typeof input.party_id === 'string' && input.party_id ? input.party_id : null
  let display_name = typeof input.display_name === 'string' ? input.display_name.trim() : ''
  if (party_id) {
    const [party] = await tenant.query<{ display_name: string }[]>`
      SELECT display_name FROM party WHERE organization_id = ${tenant.organization_id} AND party_id = ${party_id} AND deleted_at IS NULL`
    if (!party) throw new DuprError('That player does not exist.', 404)
    if (!display_name) display_name = party.display_name
  }
  if (!display_name) throw new DuprError("Enter the player's name.")

  const adapter = await activeAdapter(tenant, option)
  if (!adapter) {
    throw new DuprError('Connect DUPR before linking players, so the DUPR ID can be checked with DUPR.', 409)
  }
  const dupr_id = normalizeDuprId(input.dupr_id)
  const [taken] = await tenant.query<{ display_name: string }[]>`
    SELECT display_name FROM dupr_player_link
    WHERE organization_id = ${tenant.organization_id} AND dupr_id = ${dupr_id} AND deleted_at IS NULL`
  if (taken) throw new DuprError(`${dupr_id} is already linked to ${taken.display_name}.`, 409)
  if (party_id) {
    const [linked] = await tenant.query<{ dupr_id: string }[]>`
      SELECT dupr_id FROM dupr_player_link
      WHERE organization_id = ${tenant.organization_id} AND party_id = ${party_id} AND deleted_at IS NULL`
    if (linked) throw new DuprError(`${display_name} is already linked to ${linked.dupr_id}. Remove that link first.`, 409)
  }

  const player = await adapter.validatePlayer(dupr_id)
  if (isRefusal(player)) {
    throw new DuprError(player.message, player.refusal_code === 'unavailable' ? 503 : 422)
  }
  const evidence = {
    method_code: 'operator_attested',
    actor_id: session.actor_id,
    statement: 'Player agreed that this venue may read their DUPR rating and submit their match results to DUPR.',
  }
  const has_rating = player.doubles_rating !== null || player.singles_rating !== null
  const [row] = await tenant.query<{ dupr_player_link_id: Uuid }[]>`
    INSERT INTO dupr_player_link (organization_id, party_id, display_name, dupr_id, consent_at, consent_evidence,
                                  doubles_rating, singles_rating, rating_source_code, rating_fetched_at)
    VALUES (${tenant.organization_id}, ${party_id}, ${display_name}, ${player.dupr_id}, now(), ${tenant.query.json(evidence as never)},
            ${player.doubles_rating}, ${player.singles_rating},
            ${has_rating ? adapter.rating_source_code : null}, ${has_rating ? player.fetched_at : null})
    RETURNING dupr_player_link_id`
  const link = (await listPlayerLink(tenant, option)).find((one) => one.dupr_player_link_id === row!.dupr_player_link_id)
  return link!
}

export async function deletePlayerLink(tenant: TenantContext, dupr_player_link_id: Uuid): Promise<void> {
  const [row] = await tenant.query<{ dupr_player_link_id: Uuid }[]>`
    UPDATE dupr_player_link SET deleted_at = now()
    WHERE organization_id = ${tenant.organization_id} AND dupr_player_link_id = ${dupr_player_link_id} AND deleted_at IS NULL
    RETURNING dupr_player_link_id`
  if (!row) throw new DuprError('That player link does not exist.', 404)
}

// ---------------------------------------------------------------------------
// eligibility
// ---------------------------------------------------------------------------

export type DuprEligibility = {
  party_id: Uuid | null
  display_name: string | null
  dupr_id: string | null
  doubles_rating: string | null
  singles_rating: string | null
  rating_source_code: string | null
  rating_fetched_at: Date | null
  is_stale: boolean
  min_rating: string | null
  is_eligible: boolean
  reason: string
}

export async function readEligibility(
  tenant: TenantContext,
  input: { party_id?: string | undefined; dupr_player_link_id?: string | undefined; min_rating?: string | undefined },
  option: DuprOption = {},
): Promise<DuprEligibility> {
  if (!input.party_id && !input.dupr_player_link_id) throw new DuprError('Choose a player to check.')
  const min = input.min_rating === undefined || input.min_rating === '' ? null : Number(input.min_rating)
  if (min !== null && (!Number.isFinite(min) || min <= 0)) throw new DuprError('min_rating must be a positive number.')
  const min_rating = min === null ? null : min.toFixed(3)
  const now = option.now ?? new Date()

  const [found] = await tenant.query<LinkRow[]>`
    SELECT dupr_player_link_id, party_id, display_name, dupr_id, consent_at, doubles_rating, singles_rating,
           rating_source_code, rating_fetched_at, created_at
    FROM dupr_player_link
    WHERE organization_id = ${tenant.organization_id} AND deleted_at IS NULL
      AND (${input.party_id ?? null}::uuid IS NULL OR party_id = ${input.party_id ?? null}::uuid)
      AND (${input.dupr_player_link_id ?? null}::uuid IS NULL OR dupr_player_link_id = ${input.dupr_player_link_id ?? null}::uuid)
    LIMIT 1`
  if (!found) {
    return {
      party_id: input.party_id ?? null,
      display_name: null,
      dupr_id: null,
      doubles_rating: null,
      singles_rating: null,
      rating_source_code: null,
      rating_fetched_at: null,
      is_stale: false,
      min_rating,
      is_eligible: min_rating === null,
      reason: min_rating === null ? 'Open to every level.' : 'This player has no linked DUPR ID, so their rating cannot be checked.',
    }
  }

  let link = withStale(found, now)
  if (link.is_stale) {
    // Refresh a stale snapshot when DUPR is reachable; otherwise keep it, labelled.
    const adapter = await activeAdapter(tenant, option)
    if (adapter) {
      const player = await adapter.validatePlayer(link.dupr_id).catch(() => undefined)
      if (player && !isRefusal(player) && (player.doubles_rating !== null || player.singles_rating !== null)) {
        await tenant.query`
          UPDATE dupr_player_link
          SET doubles_rating = ${player.doubles_rating}, singles_rating = ${player.singles_rating},
              rating_source_code = ${adapter.rating_source_code}, rating_fetched_at = ${player.fetched_at}
          WHERE dupr_player_link_id = ${link.dupr_player_link_id}`
        link = {
          ...link,
          doubles_rating: player.doubles_rating,
          singles_rating: player.singles_rating,
          rating_source_code: adapter.rating_source_code,
          rating_fetched_at: player.fetched_at,
          is_stale: false,
        }
      }
    }
  }

  const rating = link.doubles_rating === null ? null : Number(link.doubles_rating)
  let is_eligible = true
  let reason = 'Open to every level.'
  if (min_rating !== null) {
    if (rating === null) {
      is_eligible = false
      reason = 'DUPR has no doubles rating for this player yet.'
    } else if (rating >= Number(min_rating)) {
      reason = `Doubles rating ${link.doubles_rating} meets the ${min_rating} minimum.`
    } else {
      is_eligible = false
      reason = `Doubles rating ${link.doubles_rating} is below the ${min_rating} minimum.`
    }
    if (link.is_stale && rating !== null) reason += ' The rating is more than 7 days old.'
  }
  return {
    party_id: link.party_id,
    display_name: link.display_name,
    dupr_id: link.dupr_id,
    doubles_rating: link.doubles_rating,
    singles_rating: link.singles_rating,
    rating_source_code: link.rating_source_code,
    rating_fetched_at: link.rating_fetched_at,
    is_stale: link.is_stale,
    min_rating,
    is_eligible,
    reason,
  }
}

// ---------------------------------------------------------------------------
// submission
// ---------------------------------------------------------------------------

export type DuprSubmission = {
  dupr_submission_id: Uuid
  score_match_id: Uuid
  match_label: string
  status_code: 'pending' | 'submitted' | 'rejected'
  receipt_code: string | null
  rejection_code: string | null
  rejection_message: string | null
  last_error: string | null
  attempt_count: number
  last_attempted_at: Date | null
  submitted_at: Date | null
  created_at: Date
}

async function selectSubmission(
  tenant: TenantContext,
  filter: { score_match_id?: Uuid; dupr_submission_id?: Uuid; is_locked?: boolean },
): Promise<DuprSubmission[]> {
  if (filter.is_locked) {
    return tenant.query<DuprSubmission[]>`
      SELECT dupr_submission_id, score_match_id, match_label, status_code, receipt_code, rejection_code,
             rejection_message, last_error, attempt_count, last_attempted_at, submitted_at, created_at
      FROM dupr_submission
      WHERE organization_id = ${tenant.organization_id} AND score_match_id = ${filter.score_match_id ?? null}::uuid
      FOR UPDATE`
  }
  return tenant.query<DuprSubmission[]>`
    SELECT dupr_submission_id, score_match_id, match_label, status_code, receipt_code, rejection_code,
           rejection_message, last_error, attempt_count, last_attempted_at, submitted_at, created_at
    FROM dupr_submission
    WHERE organization_id = ${tenant.organization_id}
      AND (${filter.score_match_id ?? null}::uuid IS NULL OR score_match_id = ${filter.score_match_id ?? null}::uuid)
      AND (${filter.dupr_submission_id ?? null}::uuid IS NULL OR dupr_submission_id = ${filter.dupr_submission_id ?? null}::uuid)
    ORDER BY created_at DESC
    LIMIT 200`
}

export function listSubmission(tenant: TenantContext): Promise<DuprSubmission[]> {
  return selectSubmission(tenant, {})
}

/** "Ana Cruz", "Ana Cruz and Ben Reyes", "Ana, Ben, and Carla". */
export function joinName(name: string[]): string {
  if (name.length <= 1) return name[0] ?? ''
  if (name.length === 2) return `${name[0]} and ${name[1]}`
  return `${name.slice(0, -1).join(', ')}, and ${name[name.length - 1]}`
}

export type SubmitOutcome = { submission: DuprSubmission; is_duplicate: boolean }

/**
 * Submit a confirmed match. Refuses (409, nothing written) until the result is
 * confirmed and every player holds a consented DUPR link. A second call for the
 * same match returns the first receipt without calling DUPR again.
 */
export async function submitDuprMatch(
  tenant: TenantContext,
  score_match_id: unknown,
  option: DuprOption & { is_retry?: boolean } = {},
): Promise<SubmitOutcome> {
  if (typeof score_match_id !== 'string' || !score_match_id) throw new DuprError('Choose the match to submit.')

  const [existing] = await selectSubmission(tenant, { score_match_id })
  if (existing?.status_code === 'submitted') return { submission: existing, is_duplicate: true }
  if (existing?.status_code === 'rejected' && !option.is_retry) return { submission: existing, is_duplicate: true }

  const adapter = await activeAdapter(tenant, option)
  if (!adapter) {
    throw new DuprError('DUPR is not connected. Connect DUPR under Connections before submitting results.', 409)
  }

  const result = await (option.findResult ?? findMatchResult)(tenant, score_match_id)
  if (!result || result.status !== 'confirmed') {
    throw new DuprError('This match has no confirmed result yet. Confirm the final score first, then submit it to DUPR.', 409)
  }

  const link = await listPlayerLink(tenant, option)
  const by_party = new Map(link.filter((one) => one.party_id).map((one) => [one.party_id!, one]))
  const by_name = new Map(link.map((one) => [one.display_name.trim().toLowerCase(), one]))
  const missing: string[] = []
  const team: DuprMatchPayload['team'] = result.team.map((one) => ({
    team_number: one.team_number,
    game_point: one.game_point,
    player: one.player_display_name.flatMap((name, index) => {
      const party_id = one.party_id[index] ?? null
      const found = (party_id ? by_party.get(party_id) : undefined) ?? by_name.get(name.trim().toLowerCase())
      if (!found) {
        missing.push(name)
        return []
      }
      return [{ dupr_id: found.dupr_id, display_name: found.display_name }]
    }),
  }))
  if (missing.length > 0) {
    const verb = missing.length === 1 ? 'has' : 'have'
    throw new DuprError(
      `Cannot submit to DUPR: ${joinName(missing)} ${verb} no linked DUPR ID with consent. DUPR requires every player to have one — link ${missing.length === 1 ? 'it' : 'them'} under Player links, then submit again.`,
      409,
    )
  }

  const match_label = result.team.map((one) => one.player_display_name.join(' & ')).join(' vs ')
  const payload: DuprMatchPayload = {
    idempotency_key: `${tenant.organization_id}:${score_match_id}`,
    score_match_id,
    played_at: result.played_at,
    match_type_code: team.every((one) => one.player.length <= 1) ? 'singles' : 'doubles',
    team,
  }

  // Serialize concurrent submits for the same match on the row lock.
  await tenant.query`
    INSERT INTO dupr_submission (organization_id, score_match_id, match_label, payload)
    VALUES (${tenant.organization_id}, ${score_match_id}, ${match_label}, ${tenant.query.json(payload as never)})
    ON CONFLICT (organization_id, score_match_id) DO NOTHING`
  const [locked] = await selectSubmission(tenant, { score_match_id, is_locked: true })
  if (!locked) throw new DuprError('Could not record the submission.', 500)
  if (locked.status_code === 'submitted') return { submission: locked, is_duplicate: true }
  if (locked.status_code === 'rejected' && !option.is_retry) return { submission: locked, is_duplicate: true }

  let outcome: { status_code: 'pending' | 'submitted' | 'rejected'; receipt_code: string | null; rejection_code: string | null; rejection_message: string | null; last_error: string | null }
  try {
    const response = await adapter.submitMatch(payload)
    outcome =
      'receipt_code' in response
        ? { status_code: 'submitted', receipt_code: response.receipt_code, rejection_code: null, rejection_message: null, last_error: null }
        : { status_code: 'rejected', receipt_code: null, rejection_code: response.rejection_code, rejection_message: response.message, last_error: null }
  } catch (error) {
    const detail = error instanceof DuprUnavailableError || error instanceof Error ? error.message : String(error)
    outcome = {
      status_code: 'pending',
      receipt_code: null,
      rejection_code: null,
      rejection_message: null,
      last_error: `DUPR did not accept the result right now (${detail}). The result is saved here and queued; retry when DUPR is back.`,
    }
  }

  await tenant.query`
    UPDATE dupr_submission
    SET status_code = ${outcome.status_code},
        receipt_code = ${outcome.receipt_code},
        rejection_code = ${outcome.rejection_code},
        rejection_message = ${outcome.rejection_message},
        last_error = ${outcome.last_error},
        match_label = ${match_label},
        payload = ${tenant.query.json(payload as never)},
        attempt_count = attempt_count + 1,
        last_attempted_at = now(),
        submitted_at = CASE WHEN ${outcome.status_code} = 'submitted' THEN now() ELSE NULL END
    WHERE dupr_submission_id = ${locked.dupr_submission_id}`
  const [row] = await selectSubmission(tenant, { dupr_submission_id: locked.dupr_submission_id })
  return { submission: row!, is_duplicate: false }
}

export async function retrySubmission(
  tenant: TenantContext,
  dupr_submission_id: Uuid,
  option: DuprOption = {},
): Promise<SubmitOutcome> {
  const [existing] = await selectSubmission(tenant, { dupr_submission_id })
  if (!existing) throw new DuprError('That submission does not exist.', 404)
  return submitDuprMatch(tenant, existing.score_match_id, { ...option, is_retry: true })
}
