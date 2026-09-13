// Seed step for the admin module: the five preset roles and two demo staff.
//
//   desk   / correct-horse — Front desk
//   scorer / correct-horse — Scorer
//
// Idempotent: roles are upserted and synced; an existing staff code is left alone.

import { createActor, type Uuid } from '@bygelo/roundrobin-kernel'
import { ensureRolePreset } from '../../src/module/admin/role.ts'
import type { SeedContext } from './context.ts'

const DEMO_STAFF = [
  { actor_code: 'desk', display_name: 'Maria Santos', role_code: 'front_desk' },
  { actor_code: 'scorer', display_name: 'Jun Reyes', role_code: 'scorer' },
] as const

export async function seedAdmin({ tenant, organization_id }: SeedContext): Promise<void> {
  await ensureRolePreset(tenant)
  for (const one of DEMO_STAFF) {
    const [existing] = await tenant.query<{ actor_id: Uuid }[]>`
      SELECT actor_id FROM actor WHERE organization_id = ${organization_id} AND actor_code = ${one.actor_code}`
    if (existing) continue
    await createActor(tenant, { ...one, secret: 'correct-horse' })
  }
}
