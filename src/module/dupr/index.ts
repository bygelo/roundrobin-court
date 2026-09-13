// dupr — R20 DUPR connector.
//
// Operator surface under /api/v1/dupr. Logic lives in ./service.ts; the
// provider boundary in ./adapter.ts.

import {
  authorize,
  type KernelApp,
  type ModuleDeclaration,
  type RouteContributor,
  type Store,
} from '@bygelo/roundrobin-kernel'
import {
  connectDupr,
  createPlayerLink,
  deletePlayerLink,
  disconnectDupr,
  listPlayerLink,
  listSubmission,
  readDuprStatus,
  readEligibility,
  retrySubmission,
  submitDuprMatch,
} from './service.ts'

export const DUPR_MODULE: ModuleDeclaration = {
  module_code: 'dupr',
  package_code: 'court',
  display_name: 'DUPR',
  schema_version: 1,
  is_removable: true,
  depend_on: ['connector', 'score'],
  capability: [
    { capability_code: 'dupr.read', description: 'See DUPR status, player links, and submissions' },
    { capability_code: 'dupr.manage', description: 'Connect DUPR, link players, and submit results' },
  ],
  route_prefix: ['/api/v1/dupr'],
}

async function readBody(request: { json: () => Promise<unknown> }): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => ({}))
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
}

export function createDuprRoute(_store: Store): RouteContributor {
  return (app: KernelApp) => {
    app.get('/api/v1/dupr/status', async (context) => {
      authorize(context.get('session'), 'dupr.read')
      return context.json({ status: await readDuprStatus(context.get('tenant')) })
    })

    app.post('/api/v1/dupr/connection', async (context) => {
      authorize(context.get('session'), 'dupr.manage')
      const body = await readBody(context.req)
      const { status, refusal } = await connectDupr(context.get('tenant'), body['mode_code'] ?? body['mode'])
      // A refusal is answered, not thrown: the recorded status must commit.
      if (refusal) return context.json({ error: refusal.message, refusal_code: refusal.refusal_code, status }, 409)
      return context.json({ status })
    })

    app.post('/api/v1/dupr/disconnect', async (context) => {
      authorize(context.get('session'), 'dupr.manage')
      return context.json({ status: await disconnectDupr(context.get('tenant')) })
    })

    app.get('/api/v1/dupr/player-link', async (context) => {
      authorize(context.get('session'), 'dupr.read')
      return context.json({ player_link: await listPlayerLink(context.get('tenant')) })
    })

    app.post('/api/v1/dupr/player-link', async (context) => {
      authorize(context.get('session'), 'dupr.manage')
      const body = await readBody(context.req)
      const player_link = await createPlayerLink(context.get('tenant'), context.get('session'), body)
      return context.json({ player_link }, 201)
    })

    app.delete('/api/v1/dupr/player-link/:dupr_player_link_id', async (context) => {
      authorize(context.get('session'), 'dupr.manage')
      await deletePlayerLink(context.get('tenant'), context.req.param('dupr_player_link_id'))
      return context.json({ is_deleted: true })
    })

    app.get('/api/v1/dupr/eligibility', async (context) => {
      authorize(context.get('session'), 'dupr.read')
      const eligibility = await readEligibility(context.get('tenant'), {
        party_id: context.req.query('party_id'),
        dupr_player_link_id: context.req.query('dupr_player_link_id'),
        min_rating: context.req.query('min_rating'),
      })
      return context.json({ eligibility })
    })

    app.get('/api/v1/dupr/submission', async (context) => {
      authorize(context.get('session'), 'dupr.read')
      return context.json({ submission: await listSubmission(context.get('tenant')) })
    })

    app.post('/api/v1/dupr/submission', async (context) => {
      authorize(context.get('session'), 'dupr.manage')
      const body = await readBody(context.req)
      const { submission, is_duplicate } = await submitDuprMatch(context.get('tenant'), body['score_match_id'])
      return context.json({ submission, is_duplicate }, is_duplicate ? 200 : 201)
    })

    app.post('/api/v1/dupr/submission/:dupr_submission_id/retry', async (context) => {
      authorize(context.get('session'), 'dupr.manage')
      const { submission, is_duplicate } = await retrySubmission(
        context.get('tenant'),
        context.req.param('dupr_submission_id'),
      )
      return context.json({ submission, is_duplicate })
    })
  }
}
