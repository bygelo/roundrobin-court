// CONTRACT — owned by the play lane; the display and insight modules import only this file.

import type { TenantContext } from '@bygelo/roundrobin-kernel'
import { publicName } from './engine.ts'
import { readSessionState } from './service.ts'

export type LivePlay = {
  play_session_id: string
  display_name: string
  starts_at: string
  ends_at: string
  court: {
    resource_id: string
    display_name: string
    player: { display_name: string }[]
    started_at: string | null
  }[]
  up_next: { display_name: string }[]
  waiting_count: number
}

/**
 * Open-play sessions running now (or starting within the hour), projected for a screen.
 * Player names are shortened to first name and last initial — a screen is public.
 */
export async function listLivePlay(tenant: TenantContext): Promise<LivePlay[]> {
  const session = await tenant.query<{ play_session_id: string }[]>`
    SELECT play_session_id FROM play_session
    WHERE organization_id = ${tenant.organization_id}
      AND deleted_at IS NULL
      AND status_code = 'open'
      AND starts_at <= now() + interval '1 hour'
      AND ends_at > now()
    ORDER BY starts_at, display_name`
  const live: LivePlay[] = []
  for (const one of session) {
    const state = await readSessionState(tenant, one.play_session_id)
    live.push({
      play_session_id: state.play_session.play_session_id,
      display_name: state.play_session.display_name,
      starts_at: state.play_session.starts_at,
      ends_at: state.play_session.ends_at,
      court: state.court.map((court) => ({
        resource_id: court.resource_id,
        display_name: court.display_name,
        player: (court.game?.team ?? []).flatMap((team) => team.player.map((each) => ({ display_name: publicName(each.display_name) }))),
        started_at: court.game?.started_at ?? null,
      })),
      up_next: state.up_next.map((each) => ({ display_name: publicName(each.display_name) })),
      waiting_count: state.waiting_count,
    })
  }
  return live
}

/**
 * Seat fill across open-play sessions that start inside [from, to).
 * A seat is filled by a player who checked in and held a place inside capacity
 * (waiting, playing, left after playing, or done). Waitlisted and no-show
 * players never filled a seat. Draft sessions are not counted.
 */
export async function summarizePlayFill(
  tenant: TenantContext,
  range: { from: Date; to: Date },
): Promise<{ session_count: number; seat_count: number; filled_count: number }> {
  const [row] = await tenant.query<{ session_count: number; seat_count: number; filled_count: number }[]>`
    SELECT count(*)::int AS session_count,
           coalesce(sum(ps.capacity_count), 0)::int AS seat_count,
           coalesce(sum(LEAST(ps.capacity_count, filled.filled_count)), 0)::int AS filled_count
    FROM play_session ps
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS filled_count FROM play_entry pe
      WHERE pe.play_session_id = ps.play_session_id
        AND pe.checked_in_at IS NOT NULL
        AND pe.status_code IN ('waiting', 'playing', 'left', 'done')
        AND pe.waitlist_position IS NULL
    ) filled
    WHERE ps.organization_id = ${tenant.organization_id}
      AND ps.deleted_at IS NULL
      AND ps.status_code <> 'draft'
      AND ps.starts_at >= ${range.from}
      AND ps.starts_at < ${range.to}`
  return row ?? { session_count: 0, seat_count: 0, filled_count: 0 }
}
