// A refused request must not commit what it wrote before refusing.
//
// Court depends on this kernel behaviour in every module that writes and then
// validates: the shop lane found a placed order surviving a 409 when the stock
// decrement refused, and the portal and message lanes found side effects that
// outlived a failed request. The kernel fix (fix/rollback-on-handled-error in
// roundrobin) rethrows context.error after next() so withTenant rolls back.
//
// This pins both halves against the kernel build court actually runs: a refusal
// leaves no row, and a success still commits.

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import {
  DomainError,
  createActor,
  createApp,
  createStore,
  enableModule,
  registerModule,
  signIn,
  withOwner,
  withTenant,
  type KernelApp,
  type ModuleDeclaration,
  type Store,
  type Uuid,
} from '@bygelo/roundrobin-kernel'

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL']

const PROBE_MODULE: ModuleDeclaration = {
  module_code: 'rollback_probe',
  package_code: 'court',
  display_name: 'Rollback probe',
  schema_version: 1,
  is_removable: true,
  depend_on: [],
  capability: [],
  route_prefix: ['/api/v1/rollback-probe'],
}

const DECLARATION = [PROBE_MODULE]

describe('a handled error rolls the request back', { skip: !TEST_DATABASE_URL }, () => {
  let store: Store
  let organization_id: Uuid
  let token: string
  let app: KernelApp

  before(async () => {
    store = createStore(TEST_DATABASE_URL!)
    await withOwner(store, 'module catalog', (owner) => registerModule(owner, DECLARATION))
    organization_id = await withOwner(store, 'create tenant', async (owner) => {
      const [row] = await owner.query<{ organization_id: Uuid }[]>`
        INSERT INTO organization (organization_code, display_name)
        VALUES (${`rollback-${process.pid}-${Date.now()}`}, 'Rollback Venue') RETURNING organization_id`
      return row!.organization_id
    })
    token = await withTenant(store, organization_id, async (tenant) => {
      await enableModule(tenant, 'rollback_probe', DECLARATION)
      await tenant.query`
        INSERT INTO role (organization_id, role_code, display_name, is_system)
        VALUES (${organization_id}, 'owner', 'Owner', true)`
      await createActor(tenant, {
        actor_code: 'operator',
        display_name: 'Operator',
        secret: 'correct-horse',
        role_code: 'owner',
      })
      return signIn(tenant, { actor_code: 'operator', secret: 'correct-horse' })
    })

    app = createApp({ store, declaration: DECLARATION }, [
      (kernel) => {
        kernel.post('/api/v1/rollback-probe/refuse', async (context) => {
          const tenant = context.get('tenant')
          await tenant.query`
            INSERT INTO role (organization_id, role_code, display_name, is_system)
            VALUES (${tenant.organization_id}, 'written_then_refused', 'Should not survive', false)`
          throw new DomainError('refused after writing', 409)
        })
        kernel.post('/api/v1/rollback-probe/accept', async (context) => {
          const tenant = context.get('tenant')
          await tenant.query`
            INSERT INTO role (organization_id, role_code, display_name, is_system)
            VALUES (${tenant.organization_id}, 'written_and_kept', 'Should survive', false)`
          return context.json({ is_written: true }, 201)
        })
      },
    ])
  })

  after(async () => {
    await withOwner(store, 'create tenant', async (owner) => {
      await owner.query`DELETE FROM organization WHERE organization_id = ${organization_id}`
    })
    // The probe module is test-only; leave the shared catalog as it was found.
    // module_dependency and organization_module both cascade from module.
    await withOwner(store, 'module catalog', async (owner) => {
      await owner.query`DELETE FROM module WHERE module_code = 'rollback_probe'`
    })
    await store.close()
  })

  const post = (path: string) =>
    app.request(`http://local${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })

  const roleExists = (role_code: string) =>
    withTenant(store, organization_id, async (tenant) => {
      const row = await tenant.query`
        SELECT 1 FROM role WHERE organization_id = ${organization_id} AND role_code = ${role_code}`
      return row.length > 0
    })

  it('keeps the refusal status and message', async () => {
    const response = await post('/api/v1/rollback-probe/refuse')
    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), { error: 'refused after writing' })
  })

  it('leaves no row from a request that refused after writing', async () => {
    assert.equal(await roleExists('written_then_refused'), false)
  })

  it('still commits a request that succeeds', async () => {
    const response = await post('/api/v1/rollback-probe/accept')
    assert.equal(response.status, 201)
    assert.equal(await roleExists('written_and_kept'), true)
  })
})
