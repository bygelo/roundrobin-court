// calendar — R23 calendar export.
//
// Operator surface under /api/v1/calendar (feed list/create/rotate/revoke) and
// one anonymous route: GET /public/:organization_code/calendar/:feed_token.ics.

import {
  authorize,
  type KernelApp,
  type ModuleDeclaration,
  type RouteContributor,
  type Store,
} from '@bygelo/roundrobin-kernel'
import { withPublicTenant } from '../../public.ts'
import { createFeed, listFeed, renderFeed, revokeFeed, rotateFeed, type CreatedFeed } from './service.ts'

export const CALENDAR_MODULE: ModuleDeclaration = {
  module_code: 'calendar',
  package_code: 'court',
  display_name: 'Calendar feed',
  schema_version: 1,
  is_removable: true,
  depend_on: ['court'],
  capability: [
    { capability_code: 'calendar.read', description: 'See calendar feeds' },
    { capability_code: 'calendar.manage', description: 'Create, rotate, and revoke calendar feeds' },
  ],
  route_prefix: ['/api/v1/calendar'],
}

async function readBody(request: { json: () => Promise<unknown> }): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => ({}))
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
}

function withUrl(created: CreatedFeed, request_url: string) {
  const origin = process.env['COURT_PUBLIC_ORIGIN'] ?? new URL(request_url).origin
  return { ...created, feed_url: `${origin.replace(/\/+$/, '')}${created.feed_path}` }
}

export function createCalendarRoute(store: Store): RouteContributor {
  return (app: KernelApp) => {
    app.get('/public/:organization_code/calendar/:feed_file', async (context) => {
      const feed_file = context.req.param('feed_file')
      const not_found = () => context.text('Calendar feed not found', 404)
      if (!feed_file.endsWith('.ics')) return not_found()
      const feed_token = feed_file.slice(0, -'.ics'.length)
      const body = await withPublicTenant(store, context.req.param('organization_code'), 'calendar', (tenant) =>
        renderFeed(tenant, feed_token),
      )
      if (body === undefined) return not_found()
      return context.body(body, 200, {
        'content-type': 'text/calendar; charset=utf-8',
        'content-disposition': 'inline; filename="court.ics"',
        'cache-control': 'private, max-age=300',
        'x-robots-tag': 'noindex',
      })
    })

    app.get('/api/v1/calendar/feed', async (context) => {
      authorize(context.get('session'), 'calendar.read')
      return context.json({ feed: await listFeed(context.get('tenant')) })
    })

    app.post('/api/v1/calendar/feed', async (context) => {
      authorize(context.get('session'), 'calendar.manage')
      const created = await createFeed(context.get('tenant'), await readBody(context.req))
      return context.json(withUrl(created, context.req.url), 201)
    })

    app.post('/api/v1/calendar/feed/:calendar_feed_id/rotate', async (context) => {
      authorize(context.get('session'), 'calendar.manage')
      const rotated = await rotateFeed(context.get('tenant'), context.req.param('calendar_feed_id'))
      return context.json(withUrl(rotated, context.req.url))
    })

    app.post('/api/v1/calendar/feed/:calendar_feed_id/revoke', async (context) => {
      authorize(context.get('session'), 'calendar.manage')
      return context.json({ feed: await revokeFeed(context.get('tenant'), context.req.param('calendar_feed_id')) })
    })
  }
}
