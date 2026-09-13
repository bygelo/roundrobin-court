// Admin against a real database: role matrix, staff lifecycle, module toggles,
// API key scope, export summary, public privacy requests, tenant isolation,
// and the disabled-module 404.

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { Uuid } from '@bygelo/roundrobin-kernel'
import { TEST_DATABASE_URL, createTestVenue, type TestVenue } from './helper.ts'

type Json = Record<string, any>

async function json(response: Response): Promise<Json> {
  const text = await response.text()
  return text ? (JSON.parse(text) as Json) : {}
}

describe('admin: modules, staff, keys, and data', { skip: !TEST_DATABASE_URL }, () => {
  let venue: TestVenue
  let other: TestVenue
  let session_id: Uuid
  let resource_id: Uuid
  let party_id: Uuid
  let booking_code: string

  const signIn = async (target: TestVenue, actor_code: string, secret: string) =>
    target.publicRequest('/api/v1/session', {
      method: 'POST',
      body: JSON.stringify({ organization_code: target.organization_code, actor_code, secret }),
    })

  const as = (target: TestVenue, token: string, path: string, init: RequestInit = {}) =>
    target.publicRequest(path, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } })

  const post = (body: unknown = {}): RequestInit => ({ method: 'POST', body: JSON.stringify(body) })

  const addStaff = async (actor_code: string, role_code: string) => {
    const response = await venue.request('/api/v1/admin/staff', post({ actor_code, display_name: `Staff ${actor_code}`, role_code }))
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
    const body = await json(response)
    const signed = await signIn(venue, actor_code, body['temporary_secret'])
    assert.equal(signed.status, 200)
    return { actor_id: body['staff'].actor_id as Uuid, secret: body['temporary_secret'] as string, token: (await json(signed))['token'] as string }
  }

  before(async () => {
    venue = await createTestVenue('admin')
    other = await createTestVenue('admin-other')

    await venue.asTenant(async (tenant) => {
      const [site] = await tenant.query<{ site_id: Uuid }[]>`
        INSERT INTO site (organization_id, site_code, display_name)
        VALUES (${venue.organization_id}, 'main', 'Main Venue') RETURNING site_id`
      const [resource] = await tenant.query<{ resource_id: Uuid }[]>`
        INSERT INTO resource (organization_id, site_id, resource_code, display_name, sort_order)
        VALUES (${venue.organization_id}, ${site!.site_id}, 'court-1', 'Court 1', 1) RETURNING resource_id`
      resource_id = resource!.resource_id
      const [session] = await tenant.query<{ session_id: Uuid }[]>`
        INSERT INTO session (organization_id, site_id, session_code, starts_at, ends_at, capacity_count, price_amount, is_published)
        VALUES (${venue.organization_id}, ${site!.site_id}, 'evening', '2027-04-01T10:00:00Z', '2027-04-01T11:00:00Z', 4, 500.00, true)
        RETURNING session_id`
      session_id = session!.session_id
      await tenant.query`
        INSERT INTO session_resource (organization_id, session_id, resource_id)
        VALUES (${venue.organization_id}, ${session_id}, ${resource_id})`
      const [party] = await tenant.query<{ party_id: Uuid }[]>`
        INSERT INTO party (organization_id, display_name, email_address, phone_number)
        VALUES (${venue.organization_id}, 'Ana Cruz', 'ana@example.com', '+639170000001') RETURNING party_id`
      party_id = party!.party_id
    })

    const booked = await venue.request('/api/v1/booking', post({ session_id, resource_id, party_id }))
    assert.equal(booked.status, 201)
    booking_code = (await json(booked))['booking'].booking_code
  })

  after(async () => {
    await venue?.close()
    await other?.close()
  })

  // ---- R03 -----------------------------------------------------------------

  it('lists every module with family, description, and dependency sentences', async () => {
    const body = await json(await venue.request('/api/v1/admin/module'))
    const booking = body['module'].find((one: Json) => one.module_code === 'booking')
    assert.equal(booking.family, 'Core')
    assert.equal(booking.is_enabled, true)
    assert.ok(booking.description.length > 10)
    assert.ok(booking.required_by_enabled.some((one: Json) => one.module_code === 'court'))
    assert.ok(body['module'].every((one: Json) => typeof one.is_removable === 'boolean'))
  })

  it('refuses to disable a core module and a module still in use, naming the blockers', async () => {
    const core = await venue.request('/api/v1/admin/module/admin/disable', post())
    assert.equal(core.status, 409)
    assert.match((await json(core))['error'], /cannot be turned off/)

    const modules = (await json(await venue.request('/api/v1/admin/module')))['module'] as Json[]
    const used = modules.find((one) => one.is_removable && one.required_by_enabled.length > 0)
    assert.ok(used, 'fixture needs a removable module that another enabled module uses')
    const refused = await venue.request(`/api/v1/admin/module/${used.module_code}/disable`, post())
    assert.equal(refused.status, 409)
    const body = await json(refused)
    assert.ok(body['required_by_enabled'].length > 0)
    assert.ok(body['error'].includes(body['required_by_enabled'][0].display_name))
  })

  it('round-trips a module off and on, 404s its routes while off, and keeps booking rows', async () => {
    const count = () =>
      venue.asTenant(
        async (tenant) =>
          (await tenant.query<{ n: number }[]>`
            SELECT count(*)::int AS n FROM booking WHERE organization_id = ${venue.organization_id}`)[0]!.n,
      )
    const before_count = await count()
    const modules = (await json(await venue.request('/api/v1/admin/module')))['module'] as Json[]
    // A removable leaf with nothing depending on it.
    const leaf = modules.find((one) => one.is_removable && one.is_enabled && one.required_by_enabled.length === 0 && one.module_code === 'consent')
      ?? modules.find((one) => one.is_removable && one.is_enabled && one.required_by_enabled.length === 0)
    assert.ok(leaf)

    const off = await venue.request(`/api/v1/admin/module/${leaf.module_code}/disable`, post())
    assert.equal(off.status, 200)
    const off_body = await json(off)
    assert.equal(off_body['is_data_deleted'], false)
    assert.match(off_body['message'], /Nothing is deleted/)

    const capability = await json(await venue.request('/api/v1/capability'))
    const state = capability['module'].find((one: Json) => one.module_code === leaf.module_code)
    assert.equal(state.is_enabled, false)
    assert.deepEqual(state.route_prefix, [])
    if (leaf.module_code === 'consent') {
      assert.equal((await venue.request('/api/v1/consent/purpose')).status, 404)
    }

    const on = await venue.request(`/api/v1/admin/module/${leaf.module_code}/enable`, post())
    assert.equal(on.status, 200)
    assert.equal(await count(), before_count)
    const again = (await json(await venue.request('/api/v1/admin/module')))['module'].find((one: Json) => one.module_code === leaf.module_code)
    assert.equal(again.is_enabled, true)
  })

  it('refuses an enable with a dependency off, then enables the chain on request', async () => {
    const modules = (await json(await venue.request('/api/v1/admin/module')))['module'] as Json[]
    const by_code = new Map(modules.map((one) => [one.module_code, one]))
    // A removable dependency D whose enabled dependents are all removable leaves.
    const pair = modules
      .filter((one) => one.is_removable && one.required_by_enabled.length > 0)
      .map((dependency) => ({ dependency, dependent: dependency.required_by_enabled.map((each: Json) => by_code.get(each.module_code)!) }))
      .find(({ dependent }) => dependent.every((each: Json) => each.is_removable && each.required_by_enabled.length === 0))
    if (!pair) return
    for (const each of pair.dependent) {
      assert.equal((await venue.request(`/api/v1/admin/module/${each.module_code}/disable`, post())).status, 200)
    }
    assert.equal((await venue.request(`/api/v1/admin/module/${pair.dependency.module_code}/disable`, post())).status, 200)

    const target = pair.dependent[0]
    const refused = await venue.request(`/api/v1/admin/module/${target.module_code}/enable`, post())
    assert.equal(refused.status, 409)
    const refused_body = await json(refused)
    assert.ok(refused_body['error'].includes(pair.dependency.display_name))
    assert.ok(refused_body['missing_dependency'].some((one: Json) => one.module_code === pair.dependency.module_code))

    const chained = await venue.request(`/api/v1/admin/module/${target.module_code}/enable`, post({ with_dependency: true }))
    assert.equal(chained.status, 200)
    assert.ok((await json(chained))['enabled_module_code'].includes(pair.dependency.module_code))
    for (const each of pair.dependent.slice(1)) {
      assert.equal((await venue.request(`/api/v1/admin/module/${each.module_code}/enable`, post())).status, 200)
    }
  })

  // ---- R04 -----------------------------------------------------------------

  it('front desk books but cannot reach admin, studio manage, or API keys', async () => {
    const desk = await addStaff('desk', 'front_desk')
    assert.equal((await as(venue, desk.token, '/api/v1/booking')).status, 200)
    assert.equal((await as(venue, desk.token, '/api/v1/admin/staff')).status, 403)
    assert.equal((await as(venue, desk.token, '/api/v1/admin/module/consent/disable', post())).status, 403)
    assert.equal((await as(venue, desk.token, '/api/v1/api-key')).status, 403)
    assert.equal((await as(venue, desk.token, '/api/v1/export')).status, 403)
    const capability = (await json(await as(venue, desk.token, '/api/v1/capability')))['capability'] as string[]
    assert.ok(capability.includes('booking.write'))
    assert.ok(!capability.includes('studio.manage'))
    assert.ok(!capability.some((one) => one.startsWith('admin.')))
  })

  it('scorer holds score capability but not portal payments or bookings', async () => {
    const scorer = await addStaff('scorer', 'scorer')
    const capability = (await json(await as(venue, scorer.token, '/api/v1/capability')))['capability'] as string[]
    assert.ok(capability.includes('score.manage'))
    assert.ok(!capability.some((one) => one.startsWith('portal.') || one.startsWith('billing.')))
    assert.equal((await as(venue, scorer.token, '/api/v1/booking')).status, 403)
    assert.equal((await as(venue, scorer.token, '/api/v1/admin/audit')).status, 403)
  })

  it('disable revokes the live session on the next request and blocks sign-in; enable issues a new password', async () => {
    const staff = await addStaff('temp-desk', 'front_desk')
    assert.equal((await as(venue, staff.token, '/api/v1/booking')).status, 200)

    const disabled = await venue.request(`/api/v1/admin/staff/${staff.actor_id}/disable`, post())
    assert.equal(disabled.status, 200)
    assert.equal((await json(disabled))['revoked_session_count'], 1)
    assert.equal((await as(venue, staff.token, '/api/v1/booking')).status, 401)
    assert.equal((await signIn(venue, 'temp-desk', staff.secret)).status, 401)

    const enabled = await json(await venue.request(`/api/v1/admin/staff/${staff.actor_id}/enable`, post()))
    assert.equal((await signIn(venue, 'temp-desk', staff.secret)).status, 401, 'old password stays dead')
    const signed = await signIn(venue, 'temp-desk', enabled['temporary_secret'])
    assert.equal(signed.status, 200)

    const reset = await json(await venue.request(`/api/v1/admin/staff/${staff.actor_id}/reset-secret`, post()))
    assert.equal(reset['revoked_session_count'], 1)
    assert.equal((await as(venue, (await json(signed))['token'], '/api/v1/booking')).status, 401)
    assert.equal((await signIn(venue, 'temp-desk', reset['temporary_secret'])).status, 200)
  })

  it('protects the last owner and the acting owner', async () => {
    const list = await json(await venue.request('/api/v1/admin/staff'))
    const self = list['staff'].find((one: Json) => one.is_self)
    assert.equal(self.role_code, 'owner')
    assert.equal(list['role'].length, 5)

    const disable_self = await venue.request(`/api/v1/admin/staff/${self.actor_id}/disable`, post())
    assert.equal(disable_self.status, 409)
    const demote = await venue.request(`/api/v1/admin/staff/${self.actor_id}`, { method: 'PATCH', body: JSON.stringify({ role_code: 'viewer' }) })
    assert.equal(demote.status, 409)
    assert.match((await json(demote))['error'], /only owner/)

    const second = await addStaff('owner-two', 'owner')
    const demote_ok = await venue.request(`/api/v1/admin/staff/${second.actor_id}`, { method: 'PATCH', body: JSON.stringify({ role_code: 'manager' }) })
    assert.equal(demote_ok.status, 200)
    assert.equal((await json(demote_ok))['staff'].role_code, 'manager')
    assert.equal((await as(venue, second.token, '/api/v1/admin/module/consent/disable', post())).status, 403, 'role change applies to the live session')
  })

  it('records an audit row naming the acting person for every admin action', async () => {
    const body = await json(await venue.request('/api/v1/admin/audit?limit_count=100'))
    const created = body['audit_event'].find((one: Json) => one.event_code === 'staff.created')
    assert.ok(created)
    assert.equal(created.actor_display_name, 'Front Desk')
    assert.ok(body['audit_event'].some((one: Json) => one.event_code === 'staff.disabled'))
    assert.ok(body['audit_event'].some((one: Json) => one.event_code === 'module.disabled'))
    const named = await venue.asTenant((tenant) =>
      tenant.query<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_event WHERE event_code = 'staff.created' AND auth_session_id IS NOT NULL`,
    )
    assert.ok(named[0]!.n > 0, 'audit row names the acting session')
  })

  // ---- R19 -----------------------------------------------------------------

  it('an API key is refused outside its grant and dies on revoke', async () => {
    const catalog = await json(await venue.request('/api/v1/admin/capability-catalog'))
    const booking_group = catalog['module'].find((one: Json) => one.module_code === 'booking')
    assert.ok(booking_group.capability.some((one: Json) => one.capability_code === 'booking.read' && one.is_held))

    const created = await venue.request('/api/v1/api-key', post({ display_name: 'Scheduler', capability: ['booking.read'], rate_limit_per_minute: 30 }))
    assert.equal(created.status, 201)
    const { token, api_key } = await json(created)
    assert.equal((await as(venue, token, '/api/v1/booking')).status, 200)
    assert.equal((await as(venue, token, '/api/v1/booking', post({ session_id, resource_id }))).status, 403)
    assert.equal((await as(venue, token, '/api/v1/admin/staff')).status, 403)
    assert.equal((await venue.request(`/api/v1/api-key/${api_key.api_key_id}`, { method: 'DELETE' })).status, 200)
    assert.equal((await as(venue, token, '/api/v1/booking')).status, 401)
  })

  // ---- R24 -----------------------------------------------------------------

  it('summarises the export with counts and the same checksum as the kernel export', async () => {
    const summary = await json(await venue.request('/api/v1/admin/export/summary'))
    const full = await json(await venue.request('/api/v1/export'))
    assert.equal(summary['checksum'], full['checksum'])
    assert.match(summary['checksum'], /^sha256:/)
    assert.equal(summary['count'].actor, full['payload'].actor.length)
    assert.ok(summary['table'].some((one: Json) => one.table_name === 'role' && one.record_count >= 5))
    assert.ok(summary['not_included'].some((one: Json) => one.label === 'Bookings' && one.record_count >= 1))
    assert.doesNotMatch(JSON.stringify(full), /secret_hash|token_hash/)
  })

  it('answers a public privacy request identically for a match and a non-match, then fulfils it', async () => {
    const ask = (body: Json) => venue.publicRequest(`/public/${venue.organization_code}/admin/privacy-request`, post(body))
    const match = await ask({ request_kind: 'access', email: 'ANA@example.com', booking_code })
    const miss = await ask({ request_kind: 'access', email: 'someone@else.com', booking_code })
    const nobooking = await ask({ request_kind: 'erasure', email: 'ana@example.com', booking_code: 'NO-SUCH' })
    assert.equal(match.status, 202)
    assert.equal(miss.status, 202)
    assert.equal(nobooking.status, 202)
    const [match_body, miss_body] = [await json(match), await json(miss)]
    assert.deepEqual(Object.keys(match_body).sort(), Object.keys(miss_body).sort())
    assert.equal(match_body['message'], miss_body['message'])
    assert.equal(match_body['status_token'].length, miss_body['status_token'].length)

    const status = async (token: string) => venue.publicRequest(`/public/${venue.organization_code}/admin/privacy-request/${token}`)
    const match_status = await json(await status(match_body['status_token']))
    const miss_status = await json(await status(miss_body['status_token']))
    assert.equal(match_status['privacy_request'].status, 'received')
    assert.deepEqual(match_status['privacy_request'].status_sentence, miss_status['privacy_request'].status_sentence)
    assert.doesNotMatch(JSON.stringify(match_status), /ana|example|Cruz/i)
    assert.equal((await status('x'.repeat(43))).status, 404)

    const list = (await json(await venue.request('/api/v1/admin/privacy-request')))['privacy_request'] as Json[]
    assert.equal(list.length, 3)
    const verified = list.filter((one) => one.is_verified)
    assert.equal(verified.length, 1)
    assert.equal(verified[0]!.party_display_name, 'Ana Cruz')
    assert.doesNotMatch(JSON.stringify(list), /ana@example\.com/)

    const unverified = list.find((one) => !one.is_verified && one.request_kind === 'access')!
    const refuse = await venue.request(`/api/v1/admin/privacy-request/${unverified.admin_privacy_request_id}/fulfil`, post())
    assert.equal(refuse.status, 409)
    assert.equal((await venue.request(`/api/v1/admin/privacy-request/${unverified.admin_privacy_request_id}/close`, post({}))).status, 200)
    assert.equal((await json(await status(miss_body['status_token'])))['privacy_request'].status, 'closed')

    const fulfilled = await json(await venue.request(`/api/v1/admin/privacy-request/${verified[0]!.admin_privacy_request_id}/fulfil`, post()))
    assert.equal(fulfilled['privacy_request'].status, 'completed')
    assert.equal(fulfilled['bundle'].profile.email_address, 'ana@example.com')
    assert.equal(fulfilled['bundle'].booking[0].booking_code, booking_code)
    const bundle = await venue.request(`/api/v1/admin/privacy-request/${verified[0]!.admin_privacy_request_id}/bundle`)
    assert.equal(bundle.status, 200)
    assert.equal((await venue.request(`/api/v1/admin/privacy-request/${verified[0]!.admin_privacy_request_id}/fulfil`, post())).status, 409)

    const subject = await venue.asTenant((tenant) =>
      tenant.query<{ n: number }[]>`SELECT count(*)::int AS n FROM data_subject_request WHERE party_id = ${party_id} AND request_kind = 'access'`,
    )
    assert.equal(subject[0]!.n, 1)
  })

  it('erases a verified player by pseudonymizing, keeping the booking, with no personal data on the status page', async () => {
    const response = await venue.publicRequest(
      `/public/${venue.organization_code}/admin/privacy-request`,
      post({ request_kind: 'erasure', email: 'ana@example.com', booking_code }),
    )
    const { status_token } = await json(response)
    const list = (await json(await venue.request('/api/v1/admin/privacy-request')))['privacy_request'] as Json[]
    const erasure = list.find((one) => one.request_kind === 'erasure' && one.is_verified && one.status === 'received')!
    const result = await json(await venue.request(`/api/v1/admin/privacy-request/${erasure.admin_privacy_request_id}/fulfil`, post()))
    assert.equal(result['privacy_request'].status, 'completed')
    assert.match(result['privacy_request'].resolution_note, /Kept without identity: 1 booking/)

    const [party] = await venue.asTenant((tenant) =>
      tenant.query<{ display_name: string; email_address: string | null }[]>`SELECT display_name, email_address FROM party WHERE party_id = ${party_id}`,
    )
    assert.equal(party!.display_name, '[redacted]')
    assert.equal(party!.email_address, null)
    const [kept] = await venue.asTenant((tenant) => tenant.query<{ n: number }[]>`SELECT count(*)::int AS n FROM booking WHERE party_id = ${party_id}`)
    assert.equal(kept!.n, 1)

    const status = await json(await venue.publicRequest(`/public/${venue.organization_code}/admin/privacy-request/${status_token}`))
    assert.equal(status['privacy_request'].status, 'completed')
    assert.doesNotMatch(JSON.stringify(status), /@|Cruz/)
  })

  // ---- isolation and gating --------------------------------------------------

  it('hides one venue from another: staff and privacy requests 404 across tenants', async () => {
    const mine = (await json(await venue.request('/api/v1/admin/staff')))['staff'] as Json[]
    const target = mine.find((one) => !one.is_self)!
    assert.equal((await other.request(`/api/v1/admin/staff/${target.actor_id}`)).status, 404)
    assert.equal((await other.request(`/api/v1/admin/staff/${target.actor_id}/disable`, post())).status, 404)
    assert.equal(
      (await other.request(`/api/v1/admin/staff/${target.actor_id}`, { method: 'PATCH', body: JSON.stringify({ role_code: 'viewer' }) })).status,
      404,
    )
    const request = ((await json(await venue.request('/api/v1/admin/privacy-request')))['privacy_request'] as Json[])[0]!
    assert.equal((await other.request(`/api/v1/admin/privacy-request/${request.admin_privacy_request_id}/fulfil`, post())).status, 404)
    assert.equal((await other.request(`/api/v1/admin/privacy-request/${request.admin_privacy_request_id}/bundle`)).status, 404)
    assert.equal(((await json(await other.request('/api/v1/admin/privacy-request')))['privacy_request'] as Json[]).length, 0)

    // Venue A's booking code submitted to venue B verifies nothing.
    await other.publicRequest(`/public/${other.organization_code}/admin/privacy-request`, post({ request_kind: 'access', email: 'ana@example.com', booking_code }))
    const other_list = (await json(await other.request('/api/v1/admin/privacy-request')))['privacy_request'] as Json[]
    assert.equal(other_list.length, 1)
    assert.equal(other_list[0]!.is_verified, false)
  })

  it('answers 404 on admin routes and the public privacy page when admin is off for a venue', async () => {
    // Scoped to this venue: tests connect as the owner role, which bypasses
    // row-level security, so an unfiltered UPDATE turns admin off for every
    // tenant in the database — including the demo venue.
    await other.asTenant(
      (tenant) => tenant.query`
        UPDATE organization_module SET is_enabled = false, disabled_at = now()
        WHERE organization_id = ${other.organization_id} AND module_code = 'admin'`,
    )
    assert.equal((await other.request('/api/v1/admin/module')).status, 404)
    const response = await other.publicRequest(
      `/public/${other.organization_code}/admin/privacy-request`,
      post({ request_kind: 'access', email: 'a@b.co', booking_code: 'X' }),
    )
    assert.equal(response.status, 404)
    assert.equal((await venue.publicRequest(`/public/no-such-venue/admin/privacy-request`, post({ request_kind: 'access', email: 'a@b.co', booking_code: 'X' }))).status, 404)
  })
})
