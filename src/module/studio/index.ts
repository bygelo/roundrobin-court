// studio — R18 branded public portal.
//
// Operator surface (/api/v1/studio, studio.read / studio.manage):
//   GET  /api/v1/studio/draft                               draft + courts + nav modules + publication
//   PUT  /api/v1/studio/draft                               { document } → 400 { error, field } when refused
//   GET  /api/v1/studio/preview                             the draft as a PublicSite (never public)
//   POST /api/v1/studio/publish                             { document? } → { version_number, published_at }
//   GET  /api/v1/studio/version                             published history, newest first
//   POST /api/v1/studio/version/:version_number/rollback    → { version_number, published_at }
//
// Public surface (no session; answers even when studio is disabled):
//   GET  /public/:organization_code/site                    { site: PublicSite } — published version only
//   GET  /public/:organization_code/studio/court-order      { court: [{ resource_id, display_name }] }

import {
  authorize,
  type KernelApp,
  type ModuleDeclaration,
  type RouteContributor,
  type Session,
  type Store,
} from '@bygelo/roundrobin-kernel'
import type { Context } from 'hono'
import { withPublicTenant } from '../../public.ts'
import { StudioValidationError } from './schema.ts'
import {
  listVersion,
  publishDraft,
  readDraftView,
  readPreviewSite,
  readPublicCourtOrder,
  readPublicSite,
  rollbackVersion,
  saveDraft,
} from './service.ts'

export const STUDIO_MODULE: ModuleDeclaration = {
  module_code: 'studio',
  package_code: 'court',
  display_name: 'Studio',
  schema_version: 1,
  is_removable: true,
  depend_on: ['court'],
  capability: [
    { capability_code: 'studio.read', description: 'See the venue site draft, preview, and published history' },
    { capability_code: 'studio.manage', description: 'Edit, publish, and roll back the venue site' },
  ],
  route_prefix: ['/api/v1/studio'],
}

/** A refusal with the field that caused it, so the editor can point at it. */
function refuse(context: Context, error: unknown): Response {
  if (error instanceof StudioValidationError) {
    return context.json({ error: error.message, field: error.field }, 400)
  }
  throw error
}

async function readBody(context: Context): Promise<Record<string, unknown>> {
  const body: unknown = await context.req.json().catch(() => undefined)
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
}

export function createStudioRoute(store: Store): RouteContributor {
  return (app: KernelApp) => {
    app.get('/api/v1/studio/draft', async (context) => {
      authorize(context.get('session'), 'studio.read')
      return context.json(await readDraftView(context.get('tenant')))
    })

    app.put('/api/v1/studio/draft', async (context) => {
      const session: Session = context.get('session')
      authorize(session, 'studio.manage')
      const tenant = context.get('tenant')
      const body = await readBody(context)
      if (body['document'] === undefined) {
        return context.json({ error: 'Send the site document to save.', field: 'document' }, 400)
      }
      try {
        await saveDraft(tenant, body['document'], session.actor_id)
      } catch (error) {
        return refuse(context, error)
      }
      return context.json(await readDraftView(tenant))
    })

    app.get('/api/v1/studio/preview', async (context) => {
      authorize(context.get('session'), 'studio.read')
      const tenant = context.get('tenant')
      const [organization] = await tenant.query<{ organization_code: string }[]>`
        SELECT organization_code FROM organization WHERE organization_id = ${tenant.organization_id}`
      const view = await readDraftView(tenant)
      return context.json({
        site: await readPreviewSite(tenant, organization?.organization_code ?? ''),
        court: view.court,
      })
    })

    app.post('/api/v1/studio/publish', async (context) => {
      const session: Session = context.get('session')
      authorize(session, 'studio.manage')
      const body = await readBody(context)
      try {
        const result = await publishDraft(context.get('tenant'), session.actor_id, body['document'])
        return context.json(result, 201)
      } catch (error) {
        return refuse(context, error)
      }
    })

    app.get('/api/v1/studio/version', async (context) => {
      authorize(context.get('session'), 'studio.read')
      return context.json({ version: await listVersion(context.get('tenant')) })
    })

    app.post('/api/v1/studio/version/:version_number/rollback', async (context) => {
      const session: Session = context.get('session')
      authorize(session, 'studio.manage')
      const raw = context.req.param('version_number')
      const version_number = /^\d{1,9}$/.test(raw) ? Number(raw) : 0
      if (version_number < 1) return context.json({ error: `There is no version ${raw} to roll back to.` }, 404)
      const result = await rollbackVersion(context.get('tenant'), session.actor_id, version_number)
      return context.json(result, 201)
    })

    // ---- public ----------------------------------------------------------
    // Module list [] on purpose: the venue site must answer when Studio is off.

    app.get('/public/:organization_code/site', async (context) => {
      const organization_code = context.req.param('organization_code')
      const site = await withPublicTenant(store, organization_code, [], (tenant) =>
        readPublicSite(tenant, organization_code),
      )
      if (!site) return context.json({ error: 'not found' }, 404)
      context.header('cache-control', 'no-store')
      return context.json({ site })
    })

    app.get('/public/:organization_code/studio/court-order', async (context) => {
      const court = await withPublicTenant(store, context.req.param('organization_code'), [], (tenant) =>
        readPublicCourtOrder(tenant),
      )
      if (!court) return context.json({ error: 'not found' }, 404)
      context.header('cache-control', 'no-store')
      return context.json({ court })
    })
  }
}
