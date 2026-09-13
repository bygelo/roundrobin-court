// CONTRACT — owned by the score-display lane; the dupr module imports only this file.

import type { TenantContext } from '@bygelo/roundrobin-kernel'
import { findMatch, listMatch, toMatchResult } from './service.ts'

export type LiveMatch = {
  score_match_id: string
  resource_id: string | null
  court_display_name: string | null
  scoring_rule_code: string
  status: 'live' | 'complete' | 'confirmed'
  serving_team_number: 1 | 2 | null
  server_number: 1 | 2 | null
  team: {
    team_number: 1 | 2
    player_display_name: string[]
    point_count: number
    game_won_count: number
  }[]
  updated_at: string
}

export type MatchResult = {
  score_match_id: string
  status: 'confirmed'
  played_at: string
  sport_profile_code: string
  team: {
    team_number: 1 | 2
    party_id: (string | null)[]
    player_display_name: string[]
    /** Points per game, in game order. */
    game_point: number[]
  }[]
}

/** Matches being scored now (or finished and awaiting confirmation), most recently touched first. */
export async function listLiveMatch(tenant: TenantContext): Promise<LiveMatch[]> {
  const match = await listMatch(tenant, { view: 'live' })
  return match.map((one) => ({
    score_match_id: one.score_match_id,
    resource_id: one.resource_id,
    court_display_name: one.court_display_name,
    scoring_rule_code: one.scoring_rule_code,
    status: one.status,
    serving_team_number: one.state.is_complete ? null : one.state.serving_team_number,
    server_number: one.state.is_complete ? null : one.state.server_number,
    team: one.team.map((team) => {
      const score = one.state.team[team.team_number - 1]!
      return {
        team_number: team.team_number,
        player_display_name: team.player_display_name,
        point_count: score.point_count,
        game_won_count: score.game_won_count,
      }
    }),
    updated_at: one.updated_at,
  }))
}

/** A confirmed, immutable result — undefined when missing or not yet confirmed. */
export async function findMatchResult(tenant: TenantContext, score_match_id: string): Promise<MatchResult | undefined> {
  const match = await findMatch(tenant, score_match_id)
  if (!match || match.status !== 'confirmed') return undefined
  return toMatchResult(match)
}
