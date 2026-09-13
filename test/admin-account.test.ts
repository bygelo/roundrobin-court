// Your account: any staff member changes their own password, whatever their
// role; wrong current is 403, weak is 400, other sessions die, the current one
// lives, nobody changes someone else's, wrong attempts are limited, tenants
// stay apart.

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { Uuid } from '@bygelo/roundrobin-kernel'
import { validateNewSecret, WRONG_ATTEMPT_LIMIT, WRONG_SECRET_SENTENCE } from '../src/module/admin/account.ts'
import { TEST_DATABASE_URL, createTestVenue, type TestVenue } from './helper.ts'

type Json = Record<string, any>

async function json(response: Response): Promise<Json> {
  const text = await response.text()
  return text ? (JSON.parse(text) as Json) : {}
}

describe('account: new password rules', () => {
  const rule = (new_secret: unknown, current_secret: unknown = 'current-pass-1') =>
    () => validateNewSecret({ current_secret, new_secret, actor_code: 'desk.anna.lopez' })

  it('needs 10 characters, a change, and not the staff code', () => {
    assert.throws(rule('short'), /at least 10/)
    assert.throws(rule('current-pass-1'), /different/)
    assert.throws(rule('DESK.ANNA.LOPEZ'), /staff code/)
    assert.throws(rule('x'.repeat(201)), /at most/)
    assert.throws(rule('long-enough-1', ''), /current password/)
    assert.deepEqual(rule('long-enough-1')(), { current_secret: 'current-pass-1', new_secret: 'long-enough-1' })
  })
})

describe('account: change your own password', { skip: !TEST_DATABASE_URL }, () => {
  let venue: TestVenue
  let other: TestVenue

  const signIn = (target: TestVenue, actor_code: string, secret: string) =>
    target.publicRequest('/api/v1/session', {
      method: 'POST',
      body: JSON.stringify({ organization_code: target.organization_code, actor_code, secret }),
    })

  const tokenOf = async (target: TestVenue, actor_code: string, secret: string) => {
    const response = await signIn(target, actor_code, secret)
    assert.equal(response.status, 200)
    return (await json(response))['token'] as string
  }

  const as = (target: TestVenue, token: string, path: string, init: RequestInit = {}) =>
    target.publicRequest(path, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } })

  const post = (body: unknown = {}): RequestInit => ({ method: 'POST', body: JSON.stringify(body) })

  const change = (target: TestVenue, token: string, current_secret: string, new_secret: string, extra: Json = {}) =>
    as(target, token, '/api/v1/admin/account/password', post({ current_secret, new_secret, ...extra }))

  const addStaff = async (actor_code: string, role_code: string) => {
    const response = await venue.request('/api/v1/admin/staff', post({ actor_code, display_name: `Staff ${actor_code}`, role_code }))
    assert.equal(response.status, 201)
    const body = await json(response)
    return {
      actor_id: body['staff'].actor_id as Uuid,
      secret: body['temporary_secret'] as string,
      token: await tokenOf(venue, actor_code, body['temporary_secret']),
    }
  }

  before(async () => {
    venue = await createTestVenue('account')
    other = await createTestVenue('account-other')
  })

  after(async () => {
    await venue?.close()
    await other?.close()
  })

  it('owner changes their password: other sessions are revoked, the current one keeps working', async () => {
    const second = await tokenOf(venue, 'operator', 'correct-horse')
    const before_body = await json(await venue.request('/api/v1/admin/account'))
    assert.equal(before_body['account'].actor_code, 'operator')
    assert.equal(before_body['account'].role_code, 'owner')
    assert.equal(before_body['account'].active_session_count, 2)
    assert.equal(before_body['account'].is_secret_temporary, false)

    const response = await venue.request('/api/v1/admin/account/password', post({ current_secret: 'correct-horse', new_secret: 'owner-new-pass-1' }))
    assert.equal(response.status, 200)
    const body = await json(response)
    assert.equal(body['revoked_session_count'], 1)
    assert.equal(body['account'].active_session_count, 1)

    assert.equal((await as(venue, second, '/api/v1/admin/account')).status, 401, 'other device signed out')
    assert.equal((await venue.request('/api/v1/admin/account')).status, 200, 'this device still signed in')
    assert.equal((await signIn(venue, 'operator', 'correct-horse')).status, 401)
    assert.equal((await signIn(venue, 'operator', 'owner-new-pass-1')).status, 200)
  })

  it('front desk changes their own password without any admin capability, clearing the temporary flag', async () => {
    const desk = await addStaff('desk', 'front_desk')
    assert.equal((await as(venue, desk.token, '/api/v1/admin/staff')).status, 403, 'still no admin access')
    const account = (await json(await as(venue, desk.token, '/api/v1/admin/account')))['account']
    assert.equal(account.role_code, 'front_desk')
    assert.equal(account.is_secret_temporary, true, 'an owner-issued password asks to be replaced')

    const response = await change(venue, desk.token, desk.secret, 'desk-own-pass-1')
    assert.equal(response.status, 200)
    assert.equal((await json(await as(venue, desk.token, '/api/v1/admin/account')))['account'].is_secret_temporary, false)
    assert.equal((await signIn(venue, 'desk', 'desk-own-pass-1')).status, 200)

    const audit = (await json(await venue.request('/api/v1/admin/audit?limit_count=100')))['audit_event'] as Json[]
    const row = audit.find((one) => one.event_code === 'account.password_changed' && one.actor_display_name === 'Staff desk')
    assert.ok(row, 'audit names the person')
    assert.doesNotMatch(JSON.stringify(audit), /desk-own-pass-1/)
  })

  it('scorer changes their own password; wrong current is 403 with no hint, weak is 400', async () => {
    const scorer = await addStaff('scorer', 'scorer')
    const wrong = await change(venue, scorer.token, 'not-my-password', 'scorer-new-pass-1')
    assert.equal(wrong.status, 403)
    assert.deepEqual(await json(wrong), { error: WRONG_SECRET_SENTENCE })
    assert.equal((await change(venue, scorer.token, scorer.secret, 'short')).status, 400)
    assert.equal((await change(venue, scorer.token, scorer.secret, scorer.secret)).status, 400)
    assert.equal((await signIn(venue, 'scorer', scorer.secret)).status, 200, 'a refusal changes nothing')

    assert.equal((await change(venue, scorer.token, scorer.secret, 'scorer-new-pass-1')).status, 200)
    assert.equal((await signIn(venue, 'scorer', 'scorer-new-pass-1')).status, 200)
  })

  it('cannot change someone else’s password, and an API key cannot use the account routes', async () => {
    const one = await addStaff('desk-one', 'front_desk')
    const two = await addStaff('desk-two', 'front_desk')
    // An actor id in the body is ignored: the route acts on the session only.
    const response = await change(venue, one.token, two.secret, 'hijack-pass-12', { actor_id: two.actor_id })
    assert.equal(response.status, 403)
    assert.equal((await signIn(venue, 'desk-two', two.secret)).status, 200)
    assert.equal((await signIn(venue, 'desk-two', 'hijack-pass-12')).status, 401)

    const created = await json(await venue.request('/api/v1/api-key', post({ display_name: 'Robot', capability: ['booking.read'] })))
    const key = created['token'] as string
    assert.equal((await as(venue, key, '/api/v1/admin/account')).status, 403)
    assert.equal((await as(venue, key, '/api/v1/admin/account/password', post({ current_secret: 'owner-new-pass-1', new_secret: 'robot-pass-123' }))).status, 403)
  })

  it('limits wrong attempts per person: the sixth try in ten minutes is 429 even with the right password', async () => {
    const limited = await addStaff('limited', 'viewer')
    const bystander = await addStaff('bystander', 'viewer')
    for (let attempt = 0; attempt < WRONG_ATTEMPT_LIMIT; attempt += 1) {
      assert.equal((await change(venue, limited.token, `wrong-guess-${attempt}`, 'limited-new-pass')).status, 403)
    }
    const blocked = await change(venue, limited.token, limited.secret, 'limited-new-pass')
    assert.equal(blocked.status, 429)
    assert.ok(Number(blocked.headers.get('retry-after')) > 0)
    assert.equal((await signIn(venue, 'limited', limited.secret)).status, 200, 'blocked attempt changed nothing')
    assert.equal((await change(venue, bystander.token, bystander.secret, 'bystander-pass-1')).status, 200, 'the limit is per person')
  })

  it('signs out other devices on request', async () => {
    const extra = await tokenOf(venue, 'desk', 'desk-own-pass-1')
    const desk_token = await tokenOf(venue, 'desk', 'desk-own-pass-1')
    const response = await as(venue, desk_token, '/api/v1/admin/account/sign-out-other', post())
    assert.equal(response.status, 200)
    const body = await json(response)
    assert.ok(body['revoked_session_count'] >= 1)
    assert.equal(body['account'].active_session_count, 1)
    assert.equal((await as(venue, extra, '/api/v1/admin/account')).status, 401)
    assert.equal((await as(venue, desk_token, '/api/v1/admin/account')).status, 200)
  })

  it('keeps tenants apart: the same staff code in another venue is a different person', async () => {
    const mine = (await json(await venue.request('/api/v1/admin/account')))['account']
    const theirs = (await json(await other.request('/api/v1/admin/account')))['account']
    assert.equal(theirs.actor_code, 'operator')
    assert.notEqual(theirs.actor_id, mine.actor_id)

    assert.equal((await other.request('/api/v1/admin/account/password', post({ current_secret: 'correct-horse', new_secret: 'other-venue-pass' }))).status, 200)
    assert.equal((await signIn(other, 'operator', 'other-venue-pass')).status, 200)
    assert.equal((await signIn(venue, 'operator', 'other-venue-pass')).status, 401)
    assert.equal((await signIn(venue, 'operator', 'owner-new-pass-1')).status, 200, 'this venue’s owner is untouched')
  })
})
