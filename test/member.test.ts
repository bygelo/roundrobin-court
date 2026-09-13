// R15 — membership: plans with a court price rule, the quote port
// (timezone-correct), entitlement consumption under concurrency, operator
// lifecycle, module gate, and tenant isolation.

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { disableModule, enableModule, type Uuid } from '@bygelo/roundrobin-kernel'
import { COURT_DECLARATION } from '../src/app.ts'
import { consumeEntitlement, quoteMemberPrice } from '../src/module/member/contract.ts'
import { TEST_DATABASE_URL, createTestVenue, type TestVenue } from './helper.ts'

type Member = {
  party_id: Uuid
  membership_id: Uuid | null
  status_code: string
  pass_remaining_count: number
  pass: { pass_id: Uuid; remaining_count: number }[]
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

describe('member (R15)', { skip: !TEST_DATABASE_URL }, () => {
  let venue: TestVenue
  let other: TestVenue
  let monthly_id: Uuid
  let pass_plan_id: Uuid
  let site_id: Uuid
  let sequence = 0

  before(async () => {
    venue = await createTestVenue('member')
    other = await createTestVenue('member-other')
    site_id = await venue.asTenant(async (tenant) => {
      const [site] = await tenant.query<{ site_id: Uuid }[]>`
        INSERT INTO site (organization_id, site_code, display_name)
        VALUES (${venue.organization_id}, 'main', 'Main') RETURNING site_id`
      return site!.site_id
    })

    const monthly = await venue.request('/api/v1/member/plan', {
      method: 'POST',
      body: JSON.stringify({
        display_name: 'Monthly Member',
        plan_kind_code: 'membership',
        price_amount: '1500',
        billing_period_code: 'monthly',
        price_rule_code: 'percent_off',
        percent_off: '20',
        is_member_session_access: true,
      }),
    })
    assert.equal(monthly.status, 201, await monthly.clone().text())
    const monthly_plan = (await json<{ plan: { member_plan_id: Uuid; rule_sentence: string } }>(monthly)).plan
    monthly_id = monthly_plan.member_plan_id
    assert.equal(monthly_plan.rule_sentence, '20% off every court booking · can book members-only sessions')

    const pass = await venue.request('/api/v1/member/plan', {
      method: 'POST',
      body: JSON.stringify({ display_name: '3-Session Pass', plan_kind_code: 'pass', price_amount: '1080', session_count: 3, valid_day_count: 60 }),
    })
    assert.equal(pass.status, 201, await pass.clone().text())
    pass_plan_id = (await json<{ plan: { member_plan_id: Uuid } }>(pass)).plan.member_plan_id
  })

  after(async () => {
    await venue?.close()
    await other?.close()
  })

  async function session(starts_at: string, price = 500): Promise<Uuid> {
    sequence += 1
    return venue.asTenant(async (tenant) => {
      const ends_at = new Date(new Date(starts_at).getTime() + 3600_000).toISOString()
      const [row] = await tenant.query<{ session_id: Uuid }[]>`
        INSERT INTO session (organization_id, site_id, session_code, starts_at, ends_at, capacity_count, price_amount, is_published)
        VALUES (${venue.organization_id}, ${site_id}, ${`s-${sequence}`}, ${starts_at}, ${ends_at}, 4, ${price}, true)
        RETURNING session_id`
      return row!.session_id
    })
  }

  async function enrol(email: string, starts_on: string, target = venue, plan_id = monthly_id): Promise<Member> {
    const response = await target.request('/api/v1/member/member', {
      method: 'POST',
      body: JSON.stringify({ display_name: email.split('@')[0], email, phone: '+63 917 000 0000', plan_id, starts_on }),
    })
    assert.equal(response.status, 201, await response.clone().text())
    return (await json<{ member: Member }>(response)).member
  }

  async function issuePass(email: string): Promise<Member> {
    const response = await venue.request('/api/v1/member/pass', {
      method: 'POST',
      body: JSON.stringify({ display_name: email.split('@')[0], email, plan_id: pass_plan_id }),
    })
    assert.equal(response.status, 201, await response.clone().text())
    return (await json<{ member: Member }>(response)).member
  }

  function today(offset_day = 0): string {
    return new Date(Date.now() + offset_day * 86_400_000 + 8 * 3600_000).toISOString().slice(0, 10)
  }

  it('gives an active member the percent-off price with a sentence reason', async () => {
    const member = await enrol('andrea@example.ph', today(-1))
    const session_id = await session(new Date(Date.now() + 2 * 86_400_000).toISOString())
    const quote = await venue.asTenant((tenant) => quoteMemberPrice(tenant, { party_id: member.party_id, session_id, base_amount: '500.00' }))
    assert.deepEqual(
      { price_amount: quote.price_amount, base_amount: quote.base_amount, entitlement_code: quote.entitlement_code, is_eligible: quote.is_eligible },
      { price_amount: '400.00', base_amount: '500.00', entitlement_code: 'membership', is_eligible: true },
    )
    assert.match(quote.reason ?? '', /Monthly Member.*save ₱100.00/)

    const stranger = await venue.asTenant((tenant) => quoteMemberPrice(tenant, { party_id: null, session_id, base_amount: '500.00' }))
    assert.deepEqual(stranger, { price_amount: '500.00', base_amount: '500.00', entitlement_code: null, is_eligible: true, reason: null })

    const preview = await json<{ quote: { price_amount: string } }>(
      await venue.request(`/api/v1/member/quote?party_id=${member.party_id}&session_id=${session_id}&base_amount=500`),
    )
    assert.equal(preview.quote.price_amount, '400.00')
  })

  it('is timezone-correct at the expiry boundary (Asia/Manila, not UTC)', async () => {
    // Monthly from 2027-03-01 covers Manila dates 2027-03-01 .. 2027-03-31.
    const member = await enrol('boundary@example.ph', '2027-03-01')
    const quote = async (starts_at: string) => {
      const session_id = await session(starts_at)
      return venue.asTenant((tenant) => quoteMemberPrice(tenant, { party_id: member.party_id, session_id, base_amount: '500.00' }))
    }
    // 23:30 Manila on March 31 — last covered day.
    assert.equal((await quote('2027-03-31T15:30:00Z')).price_amount, '400.00')
    // 07:00 Manila on April 1 — still March 31 in UTC, but no longer covered.
    assert.equal((await quote('2027-03-31T23:00:00Z')).price_amount, '500.00')
    // 07:00 Manila on March 1 — still Feb 28 in UTC, but the first covered day.
    assert.equal((await quote('2027-02-28T23:00:00Z')).price_amount, '400.00')
    // 23:00 Manila on Feb 28 — before it starts.
    assert.equal((await quote('2027-02-28T15:00:00Z')).price_amount, '500.00')
  })

  it('refuses a members-only session to a non-member, with a reason, and admits a member', async () => {
    const member = await enrol('only@example.ph', today(-2))
    const session_id = await session(new Date(Date.now() + 3 * 86_400_000).toISOString())
    const flag = await venue.request(`/api/v1/member/session/${session_id}/rule`, {
      method: 'POST',
      body: JSON.stringify({ is_member_only: true }),
    })
    assert.equal(flag.status, 200)
    const guest = await venue.asTenant((tenant) => quoteMemberPrice(tenant, { party_id: null, session_id, base_amount: '500.00' }))
    assert.equal(guest.is_eligible, false)
    assert.match(guest.reason ?? '', /members only/)
    const admitted = await venue.asTenant((tenant) => quoteMemberPrice(tenant, { party_id: member.party_id, session_id, base_amount: '500.00' }))
    assert.equal(admitted.is_eligible, true)
    assert.equal(admitted.price_amount, '400.00')
  })

  it('covers a booking with a pass, consumes idempotently per subject, and refuses at zero', async () => {
    const holder = await issuePass('pass@example.ph')
    assert.equal(holder.pass_remaining_count, 3)
    const session_id = await session(new Date(Date.now() + 86_400_000).toISOString())
    const quote = await venue.asTenant((tenant) => quoteMemberPrice(tenant, { party_id: holder.party_id, session_id, base_amount: '500.00' }))
    assert.equal(quote.price_amount, '0.00')
    assert.equal(quote.entitlement_code, 'session_pass')
    assert.match(quote.reason ?? '', /2 sessions left/)

    const use = (subject_code: string) =>
      venue.asTenant((tenant) => consumeEntitlement(tenant, { party_id: holder.party_id, entitlement_code: 'session_pass', subject_code }))
    await use('booking-a')
    await use('booking-a')
    const remaining = async () => {
      const [row] = await venue.asTenant((tenant) => tenant.query<{ use_count: number }[]>`
        SELECT use_count FROM pass WHERE party_id = ${holder.party_id}::uuid`)
      return Number(row!.use_count)
    }
    assert.equal(await remaining(), 1, 'a replayed subject spends nothing')
    await use('booking-b')
    await use('booking-c')
    await assert.rejects(use('booking-d'), /No sessions left/)
    assert.equal(await remaining(), 3)
  })

  it('consumes atomically under concurrency: 8 bookings race for 3 uses, exactly 3 win', async () => {
    const holder = await issuePass('race@example.ph')
    const result = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        venue.asTenant((tenant) =>
          consumeEntitlement(tenant, { party_id: holder.party_id, entitlement_code: 'session_pass', subject_code: `race-${index}` }),
        ),
      ),
    )
    assert.equal(result.filter((one) => one.status === 'fulfilled').length, 3)
    assert.equal(result.filter((one) => one.status === 'rejected').length, 5)

    const replay = await issuePass('replay-race@example.ph')
    await Promise.all(
      Array.from({ length: 6 }, () =>
        venue.asTenant((tenant) =>
          consumeEntitlement(tenant, { party_id: replay.party_id, entitlement_code: 'session_pass', subject_code: 'same-booking' }),
        ),
      ),
    )
    const [row] = await venue.asTenant((tenant) => tenant.query<{ use_count: number; use_row: number }[]>`
      SELECT p.use_count, (SELECT count(*)::int FROM member_entitlement_use WHERE party_id = ${replay.party_id}::uuid) AS use_row
      FROM pass p WHERE p.party_id = ${replay.party_id}::uuid`)
    assert.equal(Number(row!.use_count), 1)
    assert.equal(Number(row!.use_row), 1)
  })

  it('lists members with expiring status, freezes, unfreezes, and cancels', async () => {
    // Starts one month before five days from now → ends in ~5 days.
    const five = new Date(Date.now() + 5 * 86_400_000 + 8 * 3600_000)
    const start = new Date(Date.UTC(five.getUTCFullYear(), five.getUTCMonth() - 1, Math.min(five.getUTCDate(), 28)))
    const expiring = await enrol('expiring@example.ph', start.toISOString().slice(0, 10))
    assert.ok(['expiring', 'active'].includes(expiring.status_code))
    const listed = await json<{ member: Member[] }>(await venue.request('/api/v1/member/member?status=expiring'))
    if (five.getUTCDate() <= 28) assert.ok(listed.member.some((one) => one.party_id === expiring.party_id))

    const again = await venue.request('/api/v1/member/member', {
      method: 'POST',
      body: JSON.stringify({ display_name: 'dup', email: 'EXPIRING@example.ph', plan_id: monthly_id, starts_on: today() }),
    })
    assert.equal(again.status, 409, 'find-or-create by email refuses a second active membership')

    const action = (name: string, body: Record<string, unknown> = {}) =>
      venue.request(`/api/v1/member/member/${expiring.membership_id}/${name}`, { method: 'POST', body: JSON.stringify(body) })
    const frozen = await action('freeze', { frozen_until_on: today(14) })
    assert.equal(frozen.status, 200, await frozen.clone().text())
    assert.equal((await json<{ member: Member }>(frozen)).member.status_code, 'frozen')
    assert.equal((await action('freeze')).status, 409)
    assert.notEqual((await json<{ member: Member }>(await action('unfreeze'))).member.status_code, 'frozen')
    assert.equal((await json<{ member: Member }>(await action('cancel'))).member.status_code, 'cancelled')
    assert.equal((await action('cancel')).status, 409)

    const entitlement = await json<{ entitlement: { membership: { status_code: string }[] } }>(
      await venue.request(`/api/v1/member/party/${expiring.party_id}/entitlement`),
    )
    assert.equal(entitlement.entitlement.membership[0]!.status_code, 'cancelled')
  })

  it('disabling member returns base prices and leaves recorded booking prices untouched', async () => {
    const member = await enrol('disabled@example.ph', today(-1))
    const session_id = await session(new Date(Date.now() + 4 * 86_400_000).toISOString())
    const booked = await venue.asTenant(async (tenant) => {
      const [resource] = await tenant.query<{ resource_id: Uuid }[]>`
        INSERT INTO resource (organization_id, site_id, resource_code, display_name, sort_order)
        VALUES (${venue.organization_id}, ${site_id}, ${`court-${sequence}`}, 'Court', 1) RETURNING resource_id`
      await tenant.query`
        INSERT INTO session_resource (organization_id, session_id, resource_id)
        VALUES (${venue.organization_id}, ${session_id}, ${resource!.resource_id})`
      return resource!.resource_id
    })
    const created = await venue.request('/api/v1/booking', { method: 'POST', body: JSON.stringify({ session_id, resource_id: booked }) })
    assert.equal(created.status, 201, await created.clone().text())
    const snapshot = () => venue.asTenant((tenant) => tenant.query`SELECT booking_id, status, price_amount::text FROM booking ORDER BY booking_id`)
    const before_disable = await snapshot()

    await venue.asTenant((tenant) => disableModule(tenant, 'member', COURT_DECLARATION))
    try {
      const quote = await venue.asTenant((tenant) => quoteMemberPrice(tenant, { party_id: member.party_id, session_id, base_amount: '500.00' }))
      assert.equal(quote.price_amount, '500.00')
      assert.equal(quote.entitlement_code, null)
      assert.equal((await venue.request('/api/v1/member/member')).status, 404)
      assert.deepEqual(await snapshot(), before_disable)
    } finally {
      await venue.asTenant((tenant) => enableModule(tenant, 'member', COURT_DECLARATION))
    }
  })

  it('keeps tenants apart', async () => {
    const mine = await json<{ member: Member[] }>(await venue.request('/api/v1/member/member'))
    assert.ok(mine.member.length > 0)
    const theirs = await json<{ member: Member[] }>(await other.request('/api/v1/member/member'))
    assert.equal(theirs.member.length, 0)
    const plan = await json<{ plan: unknown[] }>(await other.request('/api/v1/member/plan'))
    assert.equal(plan.plan.length, 0)
    const foreign = await other.request('/api/v1/member/member', {
      method: 'POST',
      body: JSON.stringify({ display_name: 'x', email: 'x@example.ph', plan_id: monthly_id }),
    })
    assert.equal(foreign.status, 404)
    const peek = await other.request(`/api/v1/member/party/${mine.member[0]!.party_id}/entitlement`)
    assert.equal(peek.status, 404)
  })
})
