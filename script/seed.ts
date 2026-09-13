// Seed the demo venue: one tenant, every module on, one owner, then each
// module's own seed step.
//
// Runs as the migration (owner) role. Idempotent by organization code.

import {
  createActor,
  createStore,
  enableModule,
  registerModule,
  withOwner,
  withTenant,
  type Uuid,
} from '@bygelo/roundrobin-kernel'
import { COURT_DECLARATION } from '../src/app.ts'
import { SEED_STEP } from './seed/index.ts'

export const ORGANIZATION_CODE = process.env['SEED_ORGANIZATION_CODE'] ?? 'sideout'
export const ACTOR_CODE = process.env['SEED_ACTOR_CODE'] ?? 'operator'
export const ACTOR_SECRET = process.env['SEED_ACTOR_SECRET'] ?? 'correct-horse'

const database_url = process.env['DATABASE_URL']
if (!database_url) {
  console.error('DATABASE_URL is not set. Refusing to guess a database.')
  process.exit(1)
}

const store = createStore(database_url)

try {
  await withOwner(store, 'module catalog', (owner) => registerModule(owner, COURT_DECLARATION))

  const organization_id = await withOwner(store, 'create tenant', async (owner) => {
    const [existing] = await owner.query<{ organization_id: Uuid }[]>`
      SELECT organization_id FROM organization WHERE organization_code = ${ORGANIZATION_CODE}`
    if (existing) return existing.organization_id
    const [row] = await owner.query<{ organization_id: Uuid }[]>`
      INSERT INTO organization (organization_code, display_name)
      VALUES (${ORGANIZATION_CODE}, 'Sideout Pickleball Club') RETURNING organization_id`
    return row!.organization_id
  })

  await withTenant(store, organization_id, async (tenant) => {
    // Enable in dependency order without hardcoding it: keep passing over the
    // catalog until a pass enables nothing new.
    const pending = new Set(COURT_DECLARATION.map((one) => one.module_code))
    let is_progress = true
    while (pending.size > 0 && is_progress) {
      is_progress = false
      for (const module_code of [...pending]) {
        try {
          await enableModule(tenant, module_code, COURT_DECLARATION)
          pending.delete(module_code)
          is_progress = true
        } catch {
          // A dependency is not on yet; the next pass retries.
        }
      }
    }
    if (pending.size > 0) throw new Error(`could not enable: ${[...pending].join(', ')}`)

    const [role] = await tenant.query<{ role_id: Uuid }[]>`
      INSERT INTO role (organization_id, role_code, display_name, is_system)
      VALUES (${organization_id}, 'owner', 'Owner', true)
      ON CONFLICT (organization_id, role_code) DO UPDATE SET display_name = EXCLUDED.display_name
      RETURNING role_id`
    await tenant.query`
      INSERT INTO role_capability (organization_id, role_id, capability_code)
      SELECT ${organization_id}, ${role!.role_id}, capability_code FROM capability
      ON CONFLICT DO NOTHING`

    const [actor] = await tenant.query<{ actor_id: Uuid }[]>`
      SELECT actor_id FROM actor WHERE organization_id = ${organization_id} AND actor_code = ${ACTOR_CODE}`
    if (!actor) {
      await createActor(tenant, {
        actor_code: ACTOR_CODE,
        display_name: 'Front Desk',
        secret: ACTOR_SECRET,
        role_code: 'owner',
      })
    }

    for (const one of SEED_STEP) {
      await one.run({ tenant, organization_id, organization_code: ORGANIZATION_CODE })
      console.log(`  seeded ${one.step_code}`)
    }
  })

  console.log(`seeded venue "${ORGANIZATION_CODE}" — sign in as ${ACTOR_CODE} / ${ACTOR_SECRET}`)
} finally {
  await store.close()
}
