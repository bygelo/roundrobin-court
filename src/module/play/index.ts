// play — R09 fair round-robin rotation and open play.
//
// Operator routes live under /api/v1/play and run inside the kernel's tenant
// transaction. Public routes live outside /api: a phone or a lounge TV opens
// /public/play/:public_token with no session, so the organization is found
// from the token first (a declared pre-tenant lookup, mirroring the scan pack),
// and the module gate is checked by hand — a disabled module answers 404.

import {
  authorize,
  listEnabledModuleCode,
  withOwner,
  withTenant,
  TenantSuspendedError,
  type KernelApp,
  type ModuleDeclaration,
  type RouteContributor,
  type Session,
  type Store,
  type TenantContext,
  type Uuid,
} from '@bygelo/roundrobin-kernel'
import { withPublicTenant } from '../../public.ts'
import {
  addEntry,
  assertUuid,
  checkInEntry,
  createSession,
  findSessionIdByToken,
  finishGame,
  listCourt,
  listPublicSession,
  listSession,
  markNoShow,
  publicState,
  readSessionState,
  removeEntry,
  rotateSession,
  selfCheckIn,
  setSessionStatus,
} from './service.ts'

export const PLAY_MODULE: ModuleDeclaration = {
  module_code: 'play',
  package_code: 'court',
  display_name: 'Open play',
  schema_version: 1,
  is_removable: true,
  depend_on: ['court'],
  capability: [
    { capability_code: 'play.read', description: 'See open play' },
    { capability_code: 'play.manage', description: 'Change open play' },
  ],
  route_prefix: ['/api/v1/play'],
}

const READ = 'play.read'
const MANAGE = 'play.manage'

// ---- wrong join code guard ---------------------------------------------------
//
// The join code is four digits, so it is only a credential because guessing is
// throttled: five wrong codes per link per ten minutes, then 429 until the
// window passes. Process-local like the scan pack's refusal guard.

export const JOIN_CODE_ATTEMPT_LIMIT = 5
const JOIN_CODE_WINDOW_MILLISECOND = 10 * 60 * 1000
const wrong_attempt = new Map<string, number[]>()

function recentWrong(public_token: string, now: number): number[] {
  const list = (wrong_attempt.get(public_token) ?? []).filter((at) => now - at < JOIN_CODE_WINDOW_MILLISECOND)
  if (list.length === 0) wrong_attempt.delete(public_token)
  else wrong_attempt.set(public_token, list)
  return list
}

/** Test hook: forget every recorded wrong join code. */
export function resetJoinCodeGuard() {
  wrong_attempt.clear()
}

async function readBody(context: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  const body = await context.req.json().catch(() => ({}))
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
}

/** Resolve a public token to its tenant, only when play is enabled there. */
async function withPlayToken<T>(
  store: Store,
  public_token: string,
  work: (tenant: TenantContext, play_session_id: Uuid) => Promise<T>,
): Promise<T | undefined> {
  if (!/^[A-Za-z0-9_-]{22,64}$/.test(public_token)) return undefined
  const organization_id = await withOwner(store, 'resolve scan token', async (owner) => {
    const [row] = await owner.query<{ organization_id: Uuid | null }[]>`
      SELECT resolve_play_session_organization(${public_token}) AS organization_id`
    return row?.organization_id ?? undefined
  })
  if (!organization_id) return undefined
  try {
    return await withTenant(store, organization_id, async (tenant) => {
      const enabled = await listEnabledModuleCode(tenant)
      if (!enabled.includes('play')) return undefined
      const play_session_id = await findSessionIdByToken(tenant, public_token)
      if (!play_session_id) return undefined
      return work(tenant, play_session_id)
    })
  } catch (error) {
    if (error instanceof TenantSuspendedError) return undefined
    throw error
  }
}

async function venueName(tenant: TenantContext): Promise<string> {
  const [row] = await tenant.query<{ display_name: string }[]>`
    SELECT display_name FROM organization WHERE organization_id = ${tenant.organization_id}`
  return row?.display_name ?? 'Open play'
}

export function createPlayRoute(store: Store): RouteContributor {
  return (app: KernelApp) => {
    // ---- public ---------------------------------------------------------------

    app.get('/public/play/:public_token', async (context) => {
      const view = await withPlayToken(store, context.req.param('public_token'), async (tenant, play_session_id) =>
        publicState(await readSessionState(tenant, play_session_id), await venueName(tenant)),
      )
      if (!view) return context.json({ error: 'not found' }, 404)
      context.header('cache-control', 'no-store')
      return context.json({ play: view })
    })

    app.post('/public/play/:public_token/check-in', async (context) => {
      const public_token = context.req.param('public_token')
      const now = Date.now()
      if (recentWrong(public_token, now).length >= JOIN_CODE_ATTEMPT_LIMIT) {
        const retry_after_second = Math.ceil(
          (JOIN_CODE_WINDOW_MILLISECOND - (now - recentWrong(public_token, now)[0]!)) / 1000,
        )
        context.header('Retry-After', String(retry_after_second))
        return context.json({ error: 'Too many wrong join codes. Ask the desk for the code and try again in a few minutes.', retry_after_second }, 429)
      }
      const body = await readBody(context)
      const display_name = typeof body['display_name'] === 'string' ? body['display_name'].trim().replace(/\s+/g, ' ') : ''
      const join_code = typeof body['join_code'] === 'string' ? body['join_code'].trim() : ''
      if (!display_name || display_name.length > 80) return context.json({ error: 'Enter your name (up to 80 characters).' }, 400)

      const outcome = await withPlayToken(store, public_token, async (tenant, play_session_id) => {
        const [session] = await tenant.query<{ join_code: string }[]>`
          SELECT join_code FROM play_session WHERE play_session_id = ${play_session_id}`
        if (session!.join_code !== join_code) return { is_wrong_code: true as const }
        const entry = await selfCheckIn(tenant, play_session_id, { display_name })
        return { is_wrong_code: false as const, entry }
      })
      if (!outcome) return context.json({ error: 'not found' }, 404)
      if (outcome.is_wrong_code) {
        const list = recentWrong(public_token, now)
        list.push(now)
        wrong_attempt.set(public_token, list)
        return context.json({ error: 'That join code is not right. Check the code posted at the desk.' }, 403)
      }
      const { entry } = outcome
      return context.json(
        {
          check_in: {
            display_name: entry.display_name,
            status_code: entry.status_code,
            waitlist_position: entry.waitlist_position,
            queue_position: entry.queue_position,
            is_replay: entry.is_replay,
          },
        },
        entry.is_replay ? 200 : 201,
      )
    })

    app.get('/public/:organization_code/play', async (context) => {
      const session = await withPublicTenant(store, context.req.param('organization_code'), 'play', (tenant) =>
        listPublicSession(tenant),
      )
      if (!session) return context.json({ error: 'not found' }, 404)
      return context.json({ play_session: session })
    })

    // ---- operator ---------------------------------------------------------------

    app.get('/api/v1/play/court', async (context) => {
      authorize(context.get('session') as Session, READ)
      return context.json({ court: await listCourt(context.get('tenant')) })
    })

    app.get('/api/v1/play/session', async (context) => {
      authorize(context.get('session') as Session, READ)
      return context.json({ play_session: await listSession(context.get('tenant')) })
    })

    app.post('/api/v1/play/session', async (context) => {
      authorize(context.get('session') as Session, MANAGE)
      const play_session = await createSession(context.get('tenant'), await readBody(context))
      return context.json({ play_session }, 201)
    })

    app.get('/api/v1/play/session/:play_session_id', async (context) => {
      authorize(context.get('session') as Session, READ)
      const id = assertUuid(context.req.param('play_session_id'), 'play_session_id')
      return context.json({ state: await readSessionState(context.get('tenant'), id) })
    })

    app.post('/api/v1/play/session/:play_session_id/entry', async (context) => {
      authorize(context.get('session') as Session, MANAGE)
      const id = assertUuid(context.req.param('play_session_id'), 'play_session_id')
      const entry = await addEntry(context.get('tenant'), id, await readBody(context))
      return context.json({ entry }, 201)
    })

    app.post('/api/v1/play/session/:play_session_id/rotate', async (context) => {
      authorize(context.get('session') as Session, MANAGE)
      const id = assertUuid(context.req.param('play_session_id'), 'play_session_id')
      return context.json(await rotateSession(context.get('tenant'), id))
    })

    app.post('/api/v1/play/session/:play_session_id/open', async (context) => {
      authorize(context.get('session') as Session, MANAGE)
      const id = assertUuid(context.req.param('play_session_id'), 'play_session_id')
      return context.json({ state: await setSessionStatus(context.get('tenant'), id, 'open') })
    })

    app.post('/api/v1/play/session/:play_session_id/close', async (context) => {
      authorize(context.get('session') as Session, MANAGE)
      const id = assertUuid(context.req.param('play_session_id'), 'play_session_id')
      return context.json({ state: await setSessionStatus(context.get('tenant'), id, 'closed') })
    })

    app.post('/api/v1/play/entry/:play_entry_id/check-in', async (context) => {
      authorize(context.get('session') as Session, MANAGE)
      const id = assertUuid(context.req.param('play_entry_id'), 'play_entry_id')
      return context.json(await checkInEntry(context.get('tenant'), id))
    })

    app.post('/api/v1/play/entry/:play_entry_id/no-show', async (context) => {
      authorize(context.get('session') as Session, MANAGE)
      const id = assertUuid(context.req.param('play_entry_id'), 'play_entry_id')
      return context.json(await markNoShow(context.get('tenant'), id))
    })

    app.post('/api/v1/play/entry/:play_entry_id/remove', async (context) => {
      authorize(context.get('session') as Session, MANAGE)
      const id = assertUuid(context.req.param('play_entry_id'), 'play_entry_id')
      return context.json(await removeEntry(context.get('tenant'), id))
    })

    app.post('/api/v1/play/game/:play_game_id/finish', async (context) => {
      authorize(context.get('session') as Session, MANAGE)
      const id = assertUuid(context.req.param('play_game_id'), 'play_game_id')
      return context.json(await finishGame(context.get('tenant'), id, await readBody(context)))
    })
  }
}
