// DUPR adapter port — the only code that knows how DUPR is reached.
//
// Two implementations:
//   sandbox — deterministic, offline, and labelled as such everywhere. Enabled
//             only when DUPR_MODE=sandbox or under `node --test`.
//   http    — the partner API. Refuses with "not configured" until real
//             credentials are present; never pretends to be connected.
//
// Endpoint paths for the partner API follow DUPR's published partner docs and
// the community OpenAPI client; the write scope sits behind club approval and is
// unverified. Override with DUPR_TOKEN_PATH / DUPR_PLAYER_PATH / DUPR_MATCH_PATH
// once onboarding confirms them.

import { createHash } from 'node:crypto'

export type DuprMode = 'sandbox' | 'live'

export type DuprRefusal = {
  refusal_code: 'not_configured' | 'not_found' | 'invalid_credential' | 'unavailable'
  message: string
}

export type DuprPlayer = {
  dupr_id: string
  display_name: string
  doubles_rating: string | null
  singles_rating: string | null
  fetched_at: Date
}

export type DuprMatchPayload = {
  idempotency_key: string
  score_match_id: string
  played_at: string
  match_type_code: 'singles' | 'doubles'
  team: { team_number: 1 | 2; player: { dupr_id: string; display_name: string }[]; game_point: number[] }[]
}

export type DuprSubmitResult = { receipt_code: string } | { rejection_code: string; message: string }

/** Thrown for an outage: the caller keeps the submission pending, never loses it. */
export class DuprUnavailableError extends Error {}

export type DuprAdapter = {
  mode_code: DuprMode
  rating_source_code: string
  validateConnection: () => Promise<{ is_valid: true } | DuprRefusal>
  validatePlayer: (dupr_id: string) => Promise<DuprPlayer | DuprRefusal>
  submitMatch: (payload: DuprMatchPayload) => Promise<DuprSubmitResult>
}

export function isRefusal(value: unknown): value is DuprRefusal {
  return typeof value === 'object' && value !== null && 'refusal_code' in value
}

export function normalizeDuprId(value: string): string {
  return value.trim().toUpperCase()
}

export function isSandboxAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['DUPR_MODE'] === 'sandbox' || env['NODE_TEST_CONTEXT'] !== undefined
}

export function isLiveConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env['DUPR_CLIENT_ID'] && env['DUPR_CLIENT_SECRET'] && env['DUPR_BASE_URL'])
}

// ---------------------------------------------------------------------------
// sandbox
// ---------------------------------------------------------------------------

function hashNumber(value: string): number {
  return createHash('sha256').update(value, 'utf8').digest().readUInt32BE(0)
}

export function createSandboxAdapter(env: NodeJS.ProcessEnv = process.env): DuprAdapter {
  return {
    mode_code: 'sandbox',
    rating_source_code: 'dupr_sandbox',
    async validateConnection() {
      if (!isSandboxAllowed(env)) {
        return {
          refusal_code: 'not_configured',
          message:
            'The DUPR sandbox is turned off on this server. Set DUPR_MODE=sandbox to rehearse, or connect live once DUPR approves your club.',
        }
      }
      return { is_valid: true }
    },
    async validatePlayer(raw) {
      const dupr_id = normalizeDuprId(raw)
      if (!/^DUPR-[A-Z0-9][A-Z0-9-]*$/.test(dupr_id)) {
        return {
          refusal_code: 'not_found',
          message: `DUPR has no player with ID "${raw.trim()}". Check the ID on the player's DUPR app profile.`,
        }
      }
      const doubles = 2 + (hashNumber(dupr_id) % 5000) / 1000
      const singles = Math.max(2, doubles - 0.25)
      return {
        dupr_id,
        display_name: `Sandbox player ${dupr_id.slice(5)}`,
        doubles_rating: doubles.toFixed(3),
        singles_rating: singles.toFixed(3),
        fetched_at: new Date(),
      }
    },
    async submitMatch(payload) {
      const player = payload.team.flatMap((one) => one.player)
      const outage = player.find((one) => one.dupr_id.startsWith('DUPR-OUTAGE-'))
      if (outage) throw new DuprUnavailableError('DUPR sandbox simulated an outage')
      const rejected = player.find((one) => one.dupr_id.startsWith('DUPR-REJECT-'))
      if (rejected) {
        return {
          rejection_code: 'player_not_verified',
          message: `DUPR refused the result because ${rejected.display_name} (${rejected.dupr_id}) is not a verified DUPR account. Ask the player to verify their account in the DUPR app, then retry.`,
        }
      }
      const digest = createHash('sha256').update(payload.idempotency_key, 'utf8').digest('hex')
      return { receipt_code: `SBX-${digest.slice(0, 12).toUpperCase()}` }
    },
  }
}

// ---------------------------------------------------------------------------
// http (partner API)
// ---------------------------------------------------------------------------

const NOT_CONFIGURED: DuprRefusal = {
  refusal_code: 'not_configured',
  message:
    'DUPR partner credentials are not configured on this server (DUPR_CLIENT_ID, DUPR_CLIENT_SECRET, DUPR_BASE_URL). DUPR issues them after it approves your club, which takes 3–5 business days.',
}

export function createHttpAdapter(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): DuprAdapter {
  const base = (env['DUPR_BASE_URL'] ?? '').replace(/\/+$/, '')
  const token_path = env['DUPR_TOKEN_PATH'] ?? '/auth/v1.0/token'
  const player_path = env['DUPR_PLAYER_PATH'] ?? '/player/v1.0/{dupr_id}'
  const match_path = env['DUPR_MATCH_PATH'] ?? '/match/v1.0/create'

  async function token(): Promise<string | DuprRefusal> {
    if (!isLiveConfigured(env)) return NOT_CONFIGURED
    let response: Response
    try {
      response = await fetchImpl(`${base}${token_path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-authorization': Buffer.from(`${env['DUPR_CLIENT_ID']}:${env['DUPR_CLIENT_SECRET']}`).toString('base64'),
        },
        signal: AbortSignal.timeout(10_000),
      })
    } catch (error) {
      return { refusal_code: 'unavailable', message: `DUPR did not answer: ${error instanceof Error ? error.message : String(error)}` }
    }
    if (response.status === 401 || response.status === 403) {
      return { refusal_code: 'invalid_credential', message: 'DUPR rejected the partner credentials. Check DUPR_CLIENT_ID and DUPR_CLIENT_SECRET with your DUPR account manager.' }
    }
    if (!response.ok) return { refusal_code: 'unavailable', message: `DUPR answered HTTP ${response.status} while signing in.` }
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
    const result = (body['result'] ?? body) as Record<string, unknown>
    const value = result['token'] ?? result['access_token'] ?? result['accessToken']
    if (typeof value !== 'string' || !value) {
      return { refusal_code: 'unavailable', message: 'DUPR signed in but returned no token; the partner API contract may have changed.' }
    }
    return value
  }

  return {
    mode_code: 'live',
    rating_source_code: 'dupr',
    async validateConnection() {
      const value = await token()
      return typeof value === 'string' ? { is_valid: true } : value
    },
    async validatePlayer(raw) {
      const dupr_id = normalizeDuprId(raw)
      const value = await token()
      if (typeof value !== 'string') return value
      let response: Response
      try {
        response = await fetchImpl(`${base}${player_path.replace('{dupr_id}', encodeURIComponent(dupr_id))}`, {
          headers: { authorization: `Bearer ${value}` },
          signal: AbortSignal.timeout(10_000),
        })
      } catch (error) {
        return { refusal_code: 'unavailable', message: `DUPR did not answer: ${error instanceof Error ? error.message : String(error)}` }
      }
      if (response.status === 404) {
        return { refusal_code: 'not_found', message: `DUPR has no player with ID "${raw.trim()}". Check the ID on the player's DUPR app profile.` }
      }
      if (!response.ok) return { refusal_code: 'unavailable', message: `DUPR answered HTTP ${response.status} while reading the player.` }
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
      const result = (body['result'] ?? body) as Record<string, unknown>
      const rating = (result['ratings'] ?? result['rating'] ?? {}) as Record<string, unknown>
      const asRating = (one: unknown) => {
        const number = Number(one)
        return Number.isFinite(number) && number > 0 ? number.toFixed(3) : null
      }
      return {
        dupr_id,
        display_name: String(result['fullName'] ?? result['full_name'] ?? result['name'] ?? dupr_id),
        doubles_rating: asRating(rating['doubles']),
        singles_rating: asRating(rating['singles']),
        fetched_at: new Date(),
      }
    },
    async submitMatch(payload) {
      const value = await token()
      if (typeof value !== 'string') throw new DuprUnavailableError(value.message)
      let response: Response
      try {
        response = await fetchImpl(`${base}${match_path}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${value}`,
            'content-type': 'application/json',
            'idempotency-key': payload.idempotency_key,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10_000),
        })
      } catch (error) {
        throw new DuprUnavailableError(error instanceof Error ? error.message : String(error))
      }
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
      if (response.status >= 500 || response.status === 429) {
        throw new DuprUnavailableError(`DUPR answered HTTP ${response.status}`)
      }
      if (!response.ok) {
        return {
          rejection_code: String(body['code'] ?? body['errorCode'] ?? `http_${response.status}`),
          message: String(body['message'] ?? `DUPR refused the result (HTTP ${response.status}). Check every player's DUPR ID and the game scores, then retry.`),
        }
      }
      const result = (body['result'] ?? body) as Record<string, unknown>
      const receipt = result['matchId'] ?? result['id'] ?? result['receipt']
      if (receipt === undefined || receipt === null) throw new DuprUnavailableError('DUPR accepted the result but returned no match id')
      return { receipt_code: String(receipt) }
    },
  }
}

export function resolveDuprAdapter(
  mode_code: DuprMode,
  option: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): DuprAdapter {
  return mode_code === 'sandbox'
    ? createSandboxAdapter(option.env)
    : createHttpAdapter(option.env, option.fetchImpl)
}
