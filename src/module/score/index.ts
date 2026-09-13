// score — R12 live score under a sport scoring profile.
//
// The court tablet taps rallies; each tap is an operation with a client-minted
// id, so a retry never applies twice. The score is a replay of the log through
// the pure scorer in engine.ts.

import { authorize, type KernelApp, type ModuleDeclaration, type RouteContributor, type Store } from '@bygelo/roundrobin-kernel'
import {
  ScoreError,
  confirmMatch,
  correctMatch,
  createMatch,
  discardMatch,
  findMatch,
  listMatch,
  listScoreOption,
  readOperation,
  recordOperation,
  type CreateMatchInput,
} from './service.ts'

export const SCORE_MODULE: ModuleDeclaration = {
  module_code: 'score',
  package_code: 'court',
  display_name: 'Live score',
  schema_version: 1,
  is_removable: true,
  depend_on: ['court'],
  capability: [
    { capability_code: 'score.read', description: 'See live score' },
    { capability_code: 'score.manage', description: 'Change live score' },
  ],
  route_prefix: ['/api/v1/score'],
}

async function readBody(request: { json: () => Promise<unknown> }): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ScoreError('a JSON object body is required', 400)
  return body as Record<string, unknown>
}

export function createScoreRoute(_store: Store): RouteContributor {
  return (app: KernelApp) => {
    app.get('/api/v1/score/option', async (context) => {
      authorize(context.get('session'), 'score.read')
      return context.json(await listScoreOption(context.get('tenant')))
    })

    app.get('/api/v1/score/match', async (context) => {
      authorize(context.get('session'), 'score.read')
      const view = context.req.query('view') === 'recent' ? 'recent' : 'live'
      const match = await listMatch(context.get('tenant'), {
        view,
        resource_id: context.req.query('resource_id') ?? null,
      })
      return context.json({ match })
    })

    app.post('/api/v1/score/match', async (context) => {
      const session = context.get('session')
      authorize(session, 'score.manage')
      const body = await readBody(context.req)
      const input: CreateMatchInput = {
        sport_profile_code: body['sport_profile_code'] as string,
        team: body['team'] as CreateMatchInput['team'],
        resource_id: (body['resource_id'] as string | null | undefined) ?? null,
        actor_id: session.actor_id,
      }
      if (body['best_of_count'] !== undefined) input.best_of_count = Number(body['best_of_count'])
      return context.json({ match: await createMatch(context.get('tenant'), input) }, 201)
    })

    app.get('/api/v1/score/match/:score_match_id', async (context) => {
      authorize(context.get('session'), 'score.read')
      const match = await findMatch(context.get('tenant'), context.req.param('score_match_id'))
      if (!match) throw new ScoreError('match not found', 404)
      return context.json({ match })
    })

    app.post('/api/v1/score/match/:score_match_id/operation', async (context) => {
      const session = context.get('session')
      authorize(session, 'score.manage')
      const body = await readBody(context.req)
      const result = await recordOperation(context.get('tenant'), context.req.param('score_match_id'), {
        client_operation_id: body['client_operation_id'],
        operation: readOperation(body),
        actor_id: session.actor_id,
      })
      return context.json(result, result.is_replay ? 200 : 201)
    })

    app.post('/api/v1/score/match/:score_match_id/confirm', async (context) => {
      const session = context.get('session')
      authorize(session, 'score.manage')
      const result = await confirmMatch(context.get('tenant'), context.req.param('score_match_id'), session.actor_id)
      return context.json(result)
    })

    app.post('/api/v1/score/match/:score_match_id/correct', async (context) => {
      const session = context.get('session')
      authorize(session, 'score.manage')
      const body = await readBody(context.req)
      const result = await correctMatch(context.get('tenant'), context.req.param('score_match_id'), {
        reason: body['reason'],
        operation: body['operation'],
        game_point: body['game_point'],
        actor_id: session.actor_id,
      })
      return context.json(result, 201)
    })

    app.post('/api/v1/score/match/:score_match_id/discard', async (context) => {
      authorize(context.get('session'), 'score.manage')
      await discardMatch(context.get('tenant'), context.req.param('score_match_id'))
      return context.json({ is_discarded: true })
    })
  }
}
