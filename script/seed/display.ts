// Seed step for the display module: a lounge board, a lobby kiosk, and a Court 1 scoreboard.
//
// A credential is shown once, at creation, so the enrolment link is printed on
// the run that creates the screen. A later run finds the screen by name and
// creates nothing — remove it in Operator → Displays to get a fresh link.

import { createScreen } from '../../src/module/display/service.ts'
import type { SeedContext } from './context.ts'

const WEB_ORIGIN = process.env['COURT_WEB_ORIGIN'] ?? 'http://localhost:8797'

export async function seedDisplay(context: SeedContext): Promise<void> {
  const { tenant, organization_id } = context
  const [court] = await tenant.query<{ resource_id: string }[]>`
    SELECT resource_id FROM resource
    WHERE organization_id = ${organization_id} AND display_name = 'Court 1' AND deleted_at IS NULL
    ORDER BY sort_order LIMIT 1`

  const wanted: { kind: 'lounge' | 'court' | 'kiosk'; display_name: string; resource_id?: string }[] = [
    { kind: 'lounge', display_name: 'Lounge TV' },
    { kind: 'kiosk', display_name: 'Lobby kiosk' },
  ]
  if (court) wanted.push({ kind: 'court', display_name: 'Court 1 TV', resource_id: court.resource_id })
  else console.log('  display: no "Court 1" yet — Court 1 TV skipped')

  for (const one of wanted) {
    const [existing] = await tenant.query`
      SELECT 1 FROM display_screen s
      JOIN display_device d ON d.organization_id = s.organization_id AND d.display_device_id = s.display_device_id
      WHERE s.organization_id = ${organization_id} AND s.display_name = ${one.display_name}
        AND s.deleted_at IS NULL AND d.revoked_at IS NULL`
    if (existing) {
      console.log(`  display: "${one.display_name}" is already enrolled (its link was printed when it was created)`)
      continue
    }
    const created = await createScreen(tenant, { kind: one.kind, display_name: one.display_name, resource_id: one.resource_id })
    console.log(`  display: ${one.display_name} → ${WEB_ORIGIN}${created.enrolment_path}`)
  }
}
