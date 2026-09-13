// Seed step for the play module: tonight's open-play night, already running.
//
// Runs inside withTenant for the demo venue, after the court step. Reads the
// venue's courts from the resource table and skips (with a note) when the venue
// has none yet. Idempotent: one "Open Play Night" per venue date.

import type { Uuid } from '@bygelo/roundrobin-kernel'
import { addEntry, createSession, rotateSession } from '../../src/module/play/service.ts'
import type { SeedContext } from './context.ts'

const SESSION_NAME = 'Open Play Night'
const TIME_ZONE = 'Asia/Manila'
// Manila keeps +08:00 all year, so a fixed offset is exact.
const OFFSET = '+08:00'

const PLAYER = [
  'Ana Reyes', 'Ben Cruz', 'Carla Santos', 'Dan Lim', 'Ella Tan', 'Finn Garcia', 'Gia Ramos',
  'Hugo Dela Cruz', 'Ivy Mendoza', 'Jon Bautista', 'Kai Aquino', 'Lea Villanueva', 'Migs Torres',
]

export async function seedPlay({ tenant, organization_id }: SeedContext): Promise<void> {
  const venue_date = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: TIME_ZONE }).format(new Date())
  const starts_at = `${venue_date}T18:00:00${OFFSET}`
  const ends_at = `${venue_date}T22:00:00${OFFSET}`

  const [existing] = await tenant.query`
    SELECT 1 FROM play_session
    WHERE organization_id = ${organization_id} AND display_name = ${SESSION_NAME}
      AND starts_at = ${starts_at}::timestamptz AND deleted_at IS NULL`
  if (existing) return

  const court = await tenant.query<{ resource_id: Uuid }[]>`
    SELECT r.resource_id FROM resource r
    JOIN site s ON s.site_id = r.site_id
    WHERE r.organization_id = ${organization_id} AND r.deleted_at IS NULL AND s.deleted_at IS NULL
    ORDER BY r.sort_order, r.display_name
    LIMIT 4`
  if (court.length === 0) {
    console.log('  play: no courts at this venue yet — skipped Open Play Night')
    return
  }

  const session = await createSession(tenant, {
    display_name: SESSION_NAME,
    starts_at,
    ends_at,
    format_code: 'doubles',
    capacity_count: 24,
    resource_id: court.map((one) => one.resource_id),
    status_code: 'open',
  })
  for (const display_name of PLAYER) {
    await addEntry(tenant, session.play_session_id, { display_name, is_checked_in: true })
  }
  await rotateSession(tenant, session.play_session_id)
}
