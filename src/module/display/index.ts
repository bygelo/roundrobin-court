// display — R13 display surfaces.
//
// Operator routes mint, list, and revoke screens. The public device route
// POST /public/display/state takes the screen's credential, validates it
// through the output pack, records the heartbeat, and returns a projection
// built fresh for that screen's kind — nothing beyond what the screen shows.
// Kinds: court, lounge, counter, kiosk. Every pull also carries the venue's
// published Studio version and brand tokens, and records the Studio version
// the screen reports it last rendered (site_version_number).

import {
  TenantSuspendedError,
  authorize,
  listEnabledModuleCode,
  withOwner,
  withTenant,
  type KernelApp,
  type ModuleDeclaration,
  type RouteContributor,
  type Store,
  type Uuid,
} from '@bygelo/roundrobin-kernel'
import { hashCredential, pullState } from '@bygelo/roundrobin-output'
import {
  DisplayError,
  STALE_AFTER_SECOND,
  buildProjection,
  createScreen,
  listDisplayCourt,
  listScreen,
  normaliseOrigin,
  readSiteBrand,
  readVenueTimeZone,
  recordSiteVersion,
  revokeScreen,
  type DisplayKind,
} from './service.ts'

export const DISPLAY_MODULE: ModuleDeclaration = {
  module_code: 'display',
  package_code: 'court',
  display_name: 'Displays',
  schema_version: 1,
  is_removable: true,
  depend_on: ['court', 'output'],
  capability: [
    { capability_code: 'display.read', description: 'See displays' },
    { capability_code: 'display.manage', description: 'Change displays' },
  ],
  route_prefix: ['/api/v1/display'],
}

/** One refusal for unknown, revoked, suspended, and module-off: a screen learns nothing else. */
const REFUSAL = 'This screen is not enrolled at any venue'

export function createDisplayRoute(store: Store): RouteContributor {
  return (app: KernelApp) => {
    app.get('/api/v1/display/court', async (context) => {
      authorize(context.get('session'), 'display.read')
      return context.json({ court: await listDisplayCourt(context.get('tenant')) })
    })

    app.get('/api/v1/display/screen', async (context) => {
      authorize(context.get('session'), 'display.read')
      return context.json({ screen: await listScreen(context.get('tenant')) })
    })

    app.post('/api/v1/display/screen', async (context) => {
      const session = context.get('session')
      authorize(session, 'display.manage')
      const body = (await context.req.json().catch(() => null)) as Record<string, unknown> | null
      if (!body) throw new DisplayError('a JSON object body is required', 400)
      const created = await createScreen(context.get('tenant'), {
        kind: body['kind'],
        display_name: body['display_name'],
        resource_id: body['resource_id'],
        actor_id: session.actor_id,
      })
      // The credential is shown once, here, and never again.
      return context.json(created, 201)
    })

    app.post('/api/v1/display/screen/:display_screen_id/revoke', async (context) => {
      authorize(context.get('session'), 'display.manage')
      return context.json({ screen: await revokeScreen(context.get('tenant'), context.req.param('display_screen_id')) })
    })

    app.post('/public/display/state', async (context) => {
      const body = (await context.req.json().catch(() => null)) as {
        credential?: unknown
        config_version?: unknown
        site_version_number?: unknown
        origin?: unknown
      } | null
      const credential = typeof body?.credential === 'string' ? body.credential.trim() : ''
      if (!credential) return context.json({ error: 'credential is required' }, 400)
      const refuse = () => context.json({ error: REFUSAL }, 401)

      // Pre-tenant lookup by credential hash, through a SECURITY DEFINER
      // function (migration 008): display_device is RLS-forced, so a plain
      // SELECT under the application role would refuse every screen.
      const organization_id = await withOwner(store, 'resolve scan token', async (owner) => {
        const [row] = await owner.query<{ organization_id: Uuid | null }[]>`
          SELECT display_resolve_organization_by_credential(${hashCredential(credential)}) AS organization_id`
        return row?.organization_id ?? undefined
      })
      if (!organization_id) return refuse()

      try {
        const answer = await withTenant(store, organization_id, async (tenant) => {
          const enabled = await listEnabledModuleCode(tenant)
          if (!['display', 'output', 'court'].every((one) => enabled.includes(one))) return undefined

          const pull: { credential: string; reported_config_version?: number } = { credential }
          const reported = Number(body?.config_version)
          if (Number.isInteger(reported) && reported > 0) pull.reported_config_version = reported
          // Validates the credential, records the heartbeat (last_seen_at).
          const push = await pullState(tenant, pull)

          const [screen] = await tenant.query<{ display_screen_id: Uuid; kind: DisplayKind; display_name: string; resource_id: Uuid | null }[]>`
            SELECT display_screen_id, kind, display_name, resource_id FROM display_screen
            WHERE organization_id = ${tenant.organization_id} AND display_device_id = ${push.display_device_id}
              AND deleted_at IS NULL`
          if (!screen) return undefined

          // The screen reports the Studio version it last rendered; the answer
          // carries the one published now. Operator -> Displays compares them.
          const reported_site = body?.site_version_number
          if (typeof reported_site === 'number' && Number.isInteger(reported_site) && reported_site >= 0 && reported_site < 2 ** 31) {
            await recordSiteVersion(tenant, screen.display_screen_id, reported_site)
          }
          const brand = await readSiteBrand(tenant)

          // The kiosk's QR must open on a phone: the configured public origin,
          // else the page the tablet itself was loaded from, else this request.
          const origin =
            normaliseOrigin(process.env['COURT_PUBLIC_ORIGIN']) ?? normaliseOrigin(body?.origin) ?? normaliseOrigin(context.req.url)

          return {
            kind: screen.kind,
            display_name: screen.display_name,
            venue_name: brand.display_name,
            time_zone: await readVenueTimeZone(tenant),
            generated_at: new Date().toISOString(),
            stale_after_second: STALE_AFTER_SECOND,
            refresh_after_second: 5,
            config_version: push.config_version,
            site_version_number: brand.site_version_number,
            brand: { display_name: brand.display_name, accent: brand.accent, action: brand.action, heading_font: brand.heading_font },
            projection: await buildProjection(tenant, screen, { origin }),
          }
        })
        if (!answer) return refuse()
        return context.json(answer)
      } catch (error) {
        if (error instanceof TenantSuspendedError) return refuse()
        if (error instanceof Error && 'http_status' in error && (error as { http_status: number }).http_status === 401) return refuse()
        throw error
      }
    })
  }
}
