// Seed step for the score module: a live pickleball match on Court 1 at 7-5 in
// game 1, and one confirmed best-of-3 result on Court 2.
//
// Idempotent: each match is recognised by the client_operation_id of its first
// operation, so a second run finds it and creates nothing.

import type { Uuid } from '@bygelo/roundrobin-kernel'
import {
  buildOperationForScore,
  createInitialState,
  operationForPoint,
  type ScoreOperation,
  type ScoringProfile,
  type TeamNumber,
} from '../../src/module/score/engine.ts'
import { confirmMatch, createMatch, recordOperation } from '../../src/module/score/service.ts'
import type { SeedContext } from './context.ts'

async function hasSeed(context: SeedContext, client_operation_id: string): Promise<boolean> {
  const [row] = await context.tenant.query`
    SELECT 1 FROM score_operation o
    JOIN score_match m ON m.score_match_id = o.score_match_id
    WHERE o.organization_id = ${context.organization_id} AND o.client_operation_id = ${client_operation_id}
      AND m.deleted_at IS NULL`
  return Boolean(row)
}

async function findCourt(context: SeedContext, display_name: string): Promise<Uuid | null> {
  const [row] = await context.tenant.query<{ resource_id: Uuid }[]>`
    SELECT resource_id FROM resource
    WHERE organization_id = ${context.organization_id} AND display_name = ${display_name} AND deleted_at IS NULL
    ORDER BY sort_order LIMIT 1`
  return row?.resource_id ?? null
}

/** Rallies that reach an in-game score by alternating points, then the rest to the leader. */
function rallyTo(profile: ScoringProfile, point: [number, number]): ScoreOperation[] {
  let state = createInitialState(profile)
  const operation: ScoreOperation[] = []
  const award = (team_number: TeamNumber) => {
    const step = operationForPoint(state, team_number, profile)
    operation.push(...step.operation)
    state = step.state
  }
  const shared = Math.min(point[0], point[1])
  for (let one = 0; one < shared; one += 1) {
    award(1)
    award(2)
  }
  for (let one = shared; one < point[0]; one += 1) award(1)
  for (let one = shared; one < point[1]; one += 1) award(2)
  return operation
}

export async function seedScore(context: SeedContext): Promise<void> {
  const { tenant, organization_id } = context
  const [profile] = await tenant.query<{ scoring_rule_code: string }[]>`
    SELECT scoring_rule_code FROM sport_profile
    WHERE organization_id = ${organization_id} AND sport_profile_code = 'pickleball'`
  if (!profile) {
    console.log('  score: no pickleball sport profile yet — skipped')
    return
  }

  if (!(await hasSeed(context, 'seed-live-1'))) {
    const match = await createMatch(tenant, {
      resource_id: await findCourt(context, 'Court 1'),
      sport_profile_code: 'pickleball',
      best_of_count: 3,
      team: [{ player_display_name: ['Mara Santos', 'Jun Reyes'] }, { player_display_name: ['Paolo Lim', 'Bea Cruz'] }],
    })
    const operation = rallyTo(
      { scoring_rule_code: profile.scoring_rule_code, best_of_count: 3, team_size_count: 2 },
      [7, 5],
    )
    for (const [position, one] of operation.entries()) {
      await recordOperation(tenant, match.score_match_id, { client_operation_id: `seed-live-${position + 1}`, operation: one })
    }
  }

  if (!(await hasSeed(context, 'seed-result-1'))) {
    const match = await createMatch(tenant, {
      resource_id: await findCourt(context, 'Court 2'),
      sport_profile_code: 'pickleball',
      best_of_count: 3,
      played_at: new Date(Date.now() - 2 * 60 * 60 * 1000),
      team: [{ player_display_name: ['Liza Tan', 'Rico Gomez'] }, { player_display_name: ['Nina Uy', 'Carlo Dizon'] }],
    })
    const operation = buildOperationForScore(
      { scoring_rule_code: profile.scoring_rule_code, best_of_count: 3, team_size_count: 2 },
      [{ point: [11, 6] }, { point: [8, 11] }, { point: [11, 9] }],
    )
    for (const [position, one] of operation.entries()) {
      await recordOperation(tenant, match.score_match_id, { client_operation_id: `seed-result-${position + 1}`, operation: one })
    }
    await confirmMatch(tenant, match.score_match_id, null)
  }
}
