// The court app, running on roundrobin OS from the published packages.
//
// This is the test that answers the only question that matters about the OS:
// can an app that was NOT the one the kernel was written against actually run
// on it, without editing a kernel file?
//
// It installs @bygelo/roundrobin-kernel and @bygelo/roundrobin-booking from
// the registry, adds this app's own migration and module, and books a court.

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import {
  createActor,
  createStore,
  registerModule,
  signIn,
  withOwner,
  withTenant,
  type Store,
  type Uuid,
} from '@bygelo/roundrobin-kernel'
import { COURT_DECLARATION, SPORT_CATEGORY, createCourtApp } from '../src/app.ts'

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL']

describe('the court app on roundrobin OS', { skip: !TEST_DATABASE_URL }, () => {
  let store: Store
  let organization_id: Uuid
  let session_id: Uuid
  let resource_id: Uuid
  let token: string

  before(async () => {
    store = createStore(TEST_DATABASE_URL!)
    await withOwner(store, 'module catalog', (owner) => registerModule(owner, COURT_DECLARATION))

    organization_id = await withOwner(store, 'create tenant', async (owner) => {
      const [row] = await owner.query<{ organization_id: Uuid }[]>`
        INSERT INTO organization (organization_code, display_name)
        VALUES (${`court-${Date.now()}`}, 'Sideout Pickleball Center') RETURNING organization_id`
      return row!.organization_id
    })

    await withTenant(store, organization_id, async (tenant) => {
      // enableModule is exercised by the OS's own suite; here we assert the app
      // can turn its modules on in dependency order without special-casing.
      const { enableModule } = await import('@bygelo/roundrobin-kernel')
      await enableModule(tenant, 'booking', COURT_DECLARATION)
      await enableModule(tenant, 'court', COURT_DECLARATION)

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

      // Multi-sport, as data. Four sports, zero branches.
      for (const one of SPORT_CATEGORY) {
        await tenant.query`
          INSERT INTO sport_profile (organization_id, sport_profile_code, display_name,
                                     team_size_count, scoring_rule_code, rating_provider_code)
          VALUES (${organization_id}, ${one.resource_category_code}, ${one.display_name},
                  ${one.team_size_count},
                  ${one.resource_category_code === 'pickleball' ? 'side_out_11' : 'tennis_set'},
                  ${one.resource_category_code === 'pickleball' ? 'dupr' : null})`
        await tenant.query`
          INSERT INTO resource_category (organization_id, resource_category_code, display_name)
          VALUES (${organization_id}, ${one.resource_category_code}, ${one.display_name})`
      }

      const [site] = await tenant.query<{ site_id: Uuid }[]>`
        INSERT INTO site (organization_id, site_code, display_name)
        VALUES (${organization_id}, 'main', 'Main Venue') RETURNING site_id`

      const [resource] = await tenant.query<{ resource_id: Uuid }[]>`
        INSERT INTO resource (organization_id, site_id, resource_code, display_name, sort_order)
        VALUES (${organization_id}, ${site!.site_id}, 'court-1', 'Court 1', 1)
        RETURNING resource_id`
      resource_id = resource!.resource_id

      await tenant.query`
        INSERT INTO resource_category_link (organization_id, resource_id, resource_category_id)
        SELECT ${organization_id}, ${resource_id}, resource_category_id FROM resource_category
        WHERE organization_id = ${organization_id} AND resource_category_code = 'pickleball'`

      const [session] = await tenant.query<{ session_id: Uuid }[]>`
        INSERT INTO session (organization_id, site_id, session_code, starts_at, ends_at,
                             capacity_count, price_amount, is_published)
        VALUES (${organization_id}, ${site!.site_id}, 'evening',
                '2027-04-01T10:00:00Z', '2027-04-01T11:00:00Z', 4, 500.00, true)
        RETURNING session_id`
      session_id = session!.session_id

      await tenant.query`
        INSERT INTO session_resource (organization_id, session_id, resource_id)
        VALUES (${organization_id}, ${session_id}, ${resource_id})`

      token = await signIn(tenant, { actor_code: 'operator', secret: 'correct-horse' })
    })
  })

  after(async () => {
    await withOwner(store, 'create tenant', async (owner) => {
      await owner.query`DELETE FROM organization WHERE organization_id = ${organization_id}`
    })
    await store.close()
  })

  const request = (path: string, init: RequestInit = {}) =>
    createCourtApp(store).request(`http://local${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    })

  it('shows the court board, an app route the OS knows nothing about', async () => {
    const response = await request('/api/v1/court/board')
    assert.equal(response.status, 200)
    const body = (await response.json()) as { court: { resource_code: string; sport_code: string }[] }
    assert.equal(body.court[0]?.resource_code, 'court-1')
    assert.equal(body.court[0]?.sport_code, 'pickleball')
  })

  it('books a court through the OS booking pack, and refuses the double booking', async () => {
    const first = await request('/api/v1/booking', {
      method: 'POST',
      body: JSON.stringify({ session_id, resource_id }),
    })
    assert.equal(first.status, 201)

    const second = await request('/api/v1/booking', {
      method: 'POST',
      body: JSON.stringify({ session_id, resource_id }),
    })
    assert.equal(second.status, 409, 'the OS guarantee must hold for an app it never met')
  })

  it('carries four sports with no branch in the OS', async () => {
    await withTenant(store, organization_id, async (tenant) => {
      const profile = await tenant.query<{ sport_profile_code: string; rating_provider_code: string | null }[]>`
        SELECT sport_profile_code, rating_provider_code FROM sport_profile
        WHERE organization_id = ${organization_id} ORDER BY sport_profile_code`
      assert.equal(profile.length, 4)
      // A sport without a rating authority is a first-class state, not a gap.
      assert.equal(profile.find((one) => one.sport_profile_code === 'badminton')?.rating_provider_code, null)
      assert.equal(profile.find((one) => one.sport_profile_code === 'pickleball')?.rating_provider_code, 'dupr')
    })
  })
})
