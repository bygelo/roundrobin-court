// CONTRACT — owned by the score-display lane; the dupr module imports only this file.

import type { TenantContext } from '@bygelo/roundrobin-kernel'

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

export async function listLiveMatch(_tenant: TenantContext): Promise<LiveMatch[]> {
  return []
}

/** A confirmed, immutable result — undefined when missing or not yet confirmed. */
export async function findMatchResult(_tenant: TenantContext, _score_match_id: string): Promise<MatchResult | undefined> {
  return undefined
}
