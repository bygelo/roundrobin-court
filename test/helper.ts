// Shared test fixture: a fresh tenant with every module enabled, an owner who
// holds every capability, and request helpers for the operator and public
// surfaces. Every lane's test uses this instead of re-deriving tenant setup.
//
// Requires TEST_DATABASE_URL pointing at a database migrated with
// `npm run db:migrate`. Tests should `describe(..., { skip: !TEST_DATABASE_URL })`.

import {
  createActor,
  createStore,
  enableModule,
  registerModule,
  signIn,
  withOwner,
  withTenant,
  type Store,
  type TenantContext,
  type Uuid,
} from '@bygelo/roundrobin-kernel'
import { COURT_DECLARATION, createCourtApp } from '../src/app.ts'

export const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL']

export type TestVenue = {
  store: Store
  organization_id: Uuid
  organization_code: string
  token: string
  /** Authenticated operator request against the full app. */
  request: (path: string, init?: RequestInit) => Promise<Response>
  /** Anonymous request — the public portal, a phone, a display. */
  publicRequest: (path: string, init?: RequestInit) => Promise<Response>
  /** Run SQL or services as the tenant. */
  asTenant: <T>(work: (tenant: TenantContext) => Promise<T>) => Promise<T>
  close: () => Promise<void>
}

let sequence = 0

export async function createTestVenue(prefix = 'venue'): Promise<TestVenue> {
  const store = createStore(TEST_DATABASE_URL!)
  await withOwner(store, 'module catalog', (owner) => registerModule(owner, COURT_DECLARATION))

  sequence += 1
  const organization_code = `${prefix}-${process.pid}-${Date.now()}-${sequence}`
  const organization_id = await withOwner(store, 'create tenant', async (owner) => {
    const [row] = await owner.query<{ organization_id: Uuid }[]>`
      INSERT INTO organization (organization_code, display_name)
      VALUES (${organization_code}, 'Test Pickleball Club') RETURNING organization_id`
    return row!.organization_id
  })

  const token = await withTenant(store, organization_id, async (tenant) => {
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
          // dependency not enabled yet
        }
      }
    }
    if (pending.size > 0) throw new Error(`could not enable: ${[...pending].join(', ')}`)

    const [role] = await tenant.query<{ role_id: Uuid }[]>`
      INSERT INTO role (organization_id, role_code, display_name, is_system)
      VALUES (${organization_id}, 'owner', 'Owner', true) RETURNING role_id`
    await tenant.query`
      INSERT INTO role_capability (organization_id, role_id, capability_code)
      SELECT ${organization_id}, ${role!.role_id}, capability_code FROM capability`
    await createActor(tenant, {
      actor_code: 'operator',
      display_name: 'Front Desk',
      secret: 'correct-horse',
      role_code: 'owner',
    })
    return signIn(tenant, { actor_code: 'operator', secret: 'correct-horse' })
  })

  const app = createCourtApp(store)

  return {
    store,
    organization_id,
    organization_code,
    token,
    request: (path, init = {}) =>
      Promise.resolve(
        app.request(`http://local${path}`, {
          ...init,
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            ...(init.headers ?? {}),
          },
        }),
      ),
    publicRequest: (path, init = {}) =>
      Promise.resolve(
        app.request(`http://local${path}`, {
          ...init,
          headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
        }),
      ),
    asTenant: (work) => withTenant(store, organization_id, work),
    close: async () => {
      await withOwner(store, 'create tenant', async (owner) => {
        await owner.query`DELETE FROM organization WHERE organization_id = ${organization_id}`
      })
      await store.close()
    },
  }
}
