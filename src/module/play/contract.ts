// CONTRACT — owned by the play lane; the display and insight modules import only this file.

import type { TenantContext } from '@bygelo/roundrobin-kernel'

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

/** Open-play sessions running now (or starting within the hour), projected for a screen. */
export async function listLivePlay(_tenant: TenantContext): Promise<LivePlay[]> {
  return []
}

/** Seat fill across open-play sessions that start inside [from, to). */
export async function summarizePlayFill(
  _tenant: TenantContext,
  _range: { from: Date; to: Date },
): Promise<{ session_count: number; seat_count: number; filled_count: number }> {
  return { session_count: 0, seat_count: 0, filled_count: 0 }
}
