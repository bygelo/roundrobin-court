// R15 — recurring billing for membership: a billed plan invoices each period
// through the billing pack; the membership is pending_payment until paid; the
// renewal job invoices once per period, extends once on payment, lapses after
// the grace, and stays month-end safe in the venue's zone.

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { disableModule, enableModule, type Uuid } from '@bygelo/roundrobin-kernel'
import { recordPayment } from '@bygelo/roundrobin-billing'
import { COURT_DECLARATION } from '../src/app.ts'
import { quoteMemberPrice } from '../src/module/member/contract.ts'
import { runMembershipRenewal } from '../src/module/member/renewal.ts'
import { startOfLocalDay } from '../src/module/member/rule.ts'
import { TEST_DATABASE_URL, createTestVenue, type TestVenue } from './helper.ts'

type Member = { party_id: Uuid; membership_id: Uuid; status_code: string }
type BillingPeriod = {
  period_index: number
  period_start_on: string
  period_end_on: string
  invoice_code: string | null
  total_amount: string
  balance_amount: string
  status_code: 'paid' | 'unpaid' | 'overdue'
}
type Billing = {
  is_billed: boolean
  is_auto_renew: boolean
  renewal_state_code: string
  current_period_start_on: string
  current_period_end_on: string
  period: BillingPeriod[]
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

describe('member billing (R15 recurring)', { skip: !TEST_DATABASE_URL }, () => {
  let venue: TestVenue
  let other: TestVenue
  let billed_id: Uuid
  let free_id: Uuid
  let site_id: Uuid
  let sequence = 0

  before(async () => {
    venue = await createTestVenue('member-billing')
    other = await createTestVenue('member-billing-other')
    site_id = await venue.asTenant(async (tenant) => {
      const [site] = await tenant.query<{ site_id: Uuid }[]>`
        INSERT INTO site (organization_id, site_code, display_name)
        VALUES (${venue.organization_id}, 'main', 'Main') RETURNING site_id`
      return site!.site_id
    })
    const billed = await venue.request('/api/v1/member/plan', {
      method: 'POST',
      body: JSON.stringify({
        display_name: 'Monthly Member',
        plan_kind_code: 'membership',
        price_amount: '1500',
        billing_period_code: 'monthly',
        billing_interval_code: 'monthly',
        price_rule_code: 'percent_off',
        percent_off: '20',
      }),
    })
    assert.equal(billed.status, 201, await billed.clone().text())
    const plan = (await json<{ plan: { member_plan_id: Uuid; billing_interval_code: string } }>(billed)).plan
    assert.equal(plan.billing_interval_code, 'monthly')
    billed_id = plan.member_plan_id

    const free = await venue.request('/api/v1/member/plan', {
      method: 'POST',
      body: JSON.stringify({ display_name: 'Desk Member', plan_kind_code: 'membership', price_amount: '1000', billing_period_code: 'monthly' }),
    })
    assert.equal(free.status, 201, await free.clone().text())
    free_id = (await json<{ plan: { member_plan_id: Uuid } }>(free)).plan.member_plan_id
  })

  after(async () => {
    await venue?.close()
    await other?.close()
  })

  async function enrol(email: string, starts_on: string, plan_id = billed_id): Promise<Member> {
    const response = await venue.request('/api/v1/member/member', {
      method: 'POST',
      body: JSON.stringify({ display_name: email.split('@')[0], email, plan_id, starts_on }),
    })
    assert.equal(response.status, 201, await response.clone().text())
    return (await json<{ member: Member }>(response)).member
  }

  async function billing(membership_id: Uuid, target = venue): Promise<Billing> {
    const response = await target.request(`/api/v1/member/member/${membership_id}/billing`)
    assert.equal(response.status, 200, await response.clone().text())
    return (await json<{ billing: Billing }>(response)).billing
  }

  async function pay(member: Member, period: BillingPeriod): Promise<void> {
    await venue.asTenant((tenant) =>
      recordPayment(tenant, {
        party_id: member.party_id,
        amount: Number(period.balance_amount),
        collection_mode: 'manual_record',
        idempotency_key: `pay-${period.invoice_code}`,
        post_now: true,
      }),
    )
  }

  const run = (now: string, target = venue) => target.asTenant((tenant) => runMembershipRenewal(tenant, { now: new Date(now) }))

  async function periodCount(membership_id: Uuid): Promise<number> {
    const [row] = await venue.asTenant((tenant) => tenant.query<{ count: number }[]>`
      SELECT count(*)::int AS count FROM member_billing_period
      WHERE organization_id = ${venue.organization_id}::uuid AND membership_id = ${membership_id}::uuid`)
    return Number(row!.count)
  }

  async function membershipRow(membership_id: Uuid) {
    const [row] = await venue.asTenant((tenant) => tenant.query<{ status: string; ends_at: Date }[]>`
      SELECT status::text AS status, ends_at FROM membership
      WHERE organization_id = ${venue.organization_id}::uuid AND membership_id = ${membership_id}::uuid`)
    return row!
  }

  async function session(starts_at: string): Promise<Uuid> {
    sequence += 1
    return venue.asTenant(async (tenant) => {
      const ends_at = new Date(new Date(starts_at).getTime() + 3600_000).toISOString()
      const [row] = await tenant.query<{ session_id: Uuid }[]>`
        INSERT INTO session (organization_id, site_id, session_code, starts_at, ends_at, capacity_count, price_amount, is_published)
        VALUES (${venue.organization_id}, ${site_id}, ${`bill-${sequence}`}, ${starts_at}, ${ends_at}, 4, 500, true)
        RETURNING session_id`
      return row!.session_id
    })
  }

  /** Enrol on the billed plan and pay the first period, so the member is active. */
  async function activeMember(email: string, starts_on: string): Promise<Member> {
    const member = await enrol(email, starts_on)
    await pay(member, (await billing(member.membership_id)).period[0]!)
    await run('2026-01-01T00:00:00Z')
    assert.equal((await billing(member.membership_id)).renewal_state_code, 'active')
    return member
  }

  it('enrols on a billed plan with an open first-period invoice and pending_payment, then activates on payment', async () => {
    const member = await enrol('first@example.ph', '2031-05-10')
    assert.equal(member.status_code, 'pending_payment')
    const first = await billing(member.membership_id)
    assert.equal(first.is_billed, true)
    assert.equal(first.is_auto_renew, true)
    assert.equal(first.renewal_state_code, 'pending_payment')
    assert.equal(first.period.length, 1)
    assert.deepEqual(
      { start: first.period[0]!.period_start_on, end: first.period[0]!.period_end_on, total: first.period[0]!.total_amount },
      { start: '2031-05-10', end: '2031-06-10', total: '1500.00' },
    )
    assert.notEqual(first.period[0]!.status_code, 'paid')
    const [invoice] = await venue.asTenant((tenant) => tenant.query<{ status: string }[]>`
      SELECT status::text AS status FROM invoice
      WHERE organization_id = ${venue.organization_id}::uuid AND invoice_code = ${first.period[0]!.invoice_code}`)
    assert.equal(invoice!.status, 'open')

    const session_id = await session('2031-05-20T02:00:00Z')
    const pending = await venue.asTenant((tenant) => quoteMemberPrice(tenant, { party_id: member.party_id, session_id, base_amount: '500.00' }))
    assert.equal(pending.price_amount, '500.00', 'no member price while pending_payment')

    await pay(member, first.period[0]!)
    const result = await run('2031-05-11T00:00:00Z')
    assert.equal(result.activated_count, 1)
    const paid = await billing(member.membership_id)
    assert.equal(paid.renewal_state_code, 'active')
    assert.equal(paid.period[0]!.status_code, 'paid')
    assert.equal((await membershipRow(member.membership_id)).status, 'active')
    const active = await venue.asTenant((tenant) => quoteMemberPrice(tenant, { party_id: member.party_id, session_id, base_amount: '500.00' }))
    assert.equal(active.price_amount, '400.00')
  })

  it('a free plan behaves as before: active, no invoice', async () => {
    const member = await enrol('free@example.ph', '2027-05-10', free_id)
    assert.notEqual(member.status_code, 'pending_payment')
    const view = await billing(member.membership_id)
    assert.equal(view.is_billed, false)
    assert.equal(view.period.length, 0)
    assert.equal(await periodCount(member.membership_id), 0)
  })

  it('raises one next-period invoice across repeated runs, and extends exactly once when paid', async () => {
    const member = await activeMember('renew@example.ph', '2030-05-10')
    const early = await run('2030-06-01T02:00:00Z')
    assert.equal(early.invoiced_count, 0, 'not within three days yet')

    const first = await run('2030-06-08T02:00:00Z')
    const second = await run('2030-06-08T03:00:00Z')
    assert.equal(first.invoiced_count, 1)
    assert.equal(second.invoiced_count, 0)
    assert.equal(await periodCount(member.membership_id), 2)
    const due = await billing(member.membership_id)
    const renewal = due.period.find((one) => one.period_index === 1)!
    assert.deepEqual([renewal.period_start_on, renewal.period_end_on], ['2030-06-10', '2030-07-10'])

    await pay(member, renewal)
    const applied = await run('2030-06-09T02:00:00Z')
    const replay = await run('2030-06-09T03:00:00Z')
    assert.equal(applied.activated_count, 1)
    assert.equal(replay.activated_count, 0)
    const extended = await billing(member.membership_id)
    assert.equal(extended.current_period_start_on, '2030-06-10')
    assert.equal(extended.current_period_end_on, '2030-07-10')
    assert.equal((await membershipRow(member.membership_id)).ends_at.toISOString(), startOfLocalDay('2030-07-10').toISOString())
    assert.equal(await periodCount(member.membership_id), 2)
  })

  it('does not invoice a membership with auto-renew off', async () => {
    const member = await activeMember('manual@example.ph', '2029-05-10')
    const off = await venue.request(`/api/v1/member/member/${member.membership_id}/auto-renew`, {
      method: 'POST',
      body: JSON.stringify({ is_auto_renew: false }),
    })
    assert.equal(off.status, 200, await off.clone().text())
    assert.equal((await json<{ billing: Billing }>(off)).billing.is_auto_renew, false)
    await run('2029-06-08T02:00:00Z')
    assert.equal(await periodCount(member.membership_id), 1)
  })

  it('lapses an unpaid renewal after the grace (base price), and a later payment reactivates', async () => {
    const member = await activeMember('lapse@example.ph', '2028-05-10')
    await run('2028-06-08T02:00:00Z')
    const session_id = await session('2028-05-20T02:00:00Z')
    const quote = () => venue.asTenant((tenant) => quoteMemberPrice(tenant, { party_id: member.party_id, session_id, base_amount: '500.00' }))
    assert.equal((await quote()).price_amount, '400.00')

    const in_grace = await run('2028-06-16T02:00:00Z')
    assert.equal(in_grace.lapsed_count, 0, 'still inside the seven-day grace')
    const lapsed = await run('2028-06-17T02:00:00Z')
    assert.equal(lapsed.lapsed_count, 1)
    assert.equal((await run('2028-06-18T02:00:00Z')).lapsed_count, 0)
    const view = await billing(member.membership_id)
    assert.equal(view.renewal_state_code, 'lapsed')
    // The read view grades paid/unpaid/overdue against the real clock, not this test's timeline.
    assert.notEqual(view.period.find((one) => one.period_index === 1)!.status_code, 'paid')
    assert.equal((await quote()).price_amount, '500.00', 'a lapsed member pays the base price')
    const listed = await json<{ member: Member[] }>(await venue.request('/api/v1/member/member?search=lapse@'))
    assert.equal(listed.member[0]!.status_code, 'lapsed')

    await pay(member, view.period.find((one) => one.period_index === 1)!)
    const back = await run('2028-06-18T03:00:00Z')
    assert.equal(back.activated_count, 1)
    assert.equal((await billing(member.membership_id)).renewal_state_code, 'active')
    assert.equal((await membershipRow(member.membership_id)).status, 'active')
    const later = await session('2028-07-01T02:00:00Z')
    const renewed = await venue.asTenant((tenant) => quoteMemberPrice(tenant, { party_id: member.party_id, session_id: later, base_amount: '500.00' }))
    assert.equal(renewed.price_amount, '400.00')
  })

  it('keeps month-end periods anchored: Jan 31 → Feb 28 → Mar 31 → Apr 30', async () => {
    const member = await activeMember('monthend@example.ph', '2027-01-31')
    assert.equal((await billing(member.membership_id)).current_period_end_on, '2027-02-28')
    await run('2027-02-26T02:00:00Z')
    let view = await billing(member.membership_id)
    const february = view.period.find((one) => one.period_index === 1)!
    assert.deepEqual([february.period_start_on, february.period_end_on], ['2027-02-28', '2027-03-31'])
    await pay(member, february)
    await run('2027-02-27T02:00:00Z')
    assert.equal((await membershipRow(member.membership_id)).ends_at.toISOString(), startOfLocalDay('2027-03-31', 'Asia/Manila').toISOString())
    await run('2027-03-29T02:00:00Z')
    view = await billing(member.membership_id)
    const march = view.period.find((one) => one.period_index === 2)!
    assert.deepEqual([march.period_start_on, march.period_end_on], ['2027-03-31', '2027-04-30'])
  })

  it('concurrent runs raise one invoice', async () => {
    const member = await activeMember('race@example.ph', '2026-05-10')
    const result = await Promise.all(Array.from({ length: 6 }, () => run('2026-06-08T02:00:00Z')))
    assert.equal(result.reduce((sum, one) => sum + one.invoiced_count, 0), 1)
    assert.equal(await periodCount(member.membership_id), 2)
    const [row] = await venue.asTenant((tenant) => tenant.query<{ count: number }[]>`
      SELECT count(*)::int AS count FROM invoice
      WHERE organization_id = ${venue.organization_id}::uuid AND party_id = ${member.party_id}::uuid`)
    assert.equal(Number(row!.count), 2)
  })

  it('runs renewals from the operator API and updates a plan interval and price', async () => {
    const response = await venue.request('/api/v1/member/renewal/run', { method: 'POST' })
    assert.equal(response.status, 200, await response.clone().text())
    const body = await json<{ result: { invoiced_count: number; activated_count: number; lapsed_count: number } }>(response)
    assert.equal(typeof body.result.invoiced_count, 'number')

    const updated = await venue.request(`/api/v1/member/plan/${free_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ billing_interval_code: 'monthly', price_amount: '1200' }),
    })
    assert.equal(updated.status, 200, await updated.clone().text())
    const plan = (await json<{ plan: { billing_interval_code: string; price_amount: string } }>(updated)).plan
    assert.deepEqual([plan.billing_interval_code, plan.price_amount], ['monthly', '1200.00'])
    const wrong = await venue.request(`/api/v1/member/plan/${free_id}`, { method: 'PATCH', body: JSON.stringify({ billing_interval_code: 'annual' }) })
    assert.equal(wrong.status, 400)
  })

  it('keeps tenants apart', async () => {
    const member = await enrol('mine@example.ph', '2027-05-10')
    assert.equal((await other.request(`/api/v1/member/member/${member.membership_id}/billing`)).status, 404)
    const toggle = await other.request(`/api/v1/member/member/${member.membership_id}/auto-renew`, {
      method: 'POST',
      body: JSON.stringify({ is_auto_renew: false }),
    })
    assert.equal(toggle.status, 404)
    const theirs = await run('2027-06-08T02:00:00Z', other)
    assert.deepEqual(theirs, { invoiced_count: 0, activated_count: 0, lapsed_count: 0 })
    assert.equal((await billing(member.membership_id)).is_auto_renew, true)
  })

  it('returns 404 when the member module is disabled, and the job does nothing', async () => {
    const member = await activeMember('disabled@example.ph', '2032-05-10')
    await venue.asTenant((tenant) => disableModule(tenant, 'member', COURT_DECLARATION))
    try {
      assert.equal((await venue.request('/api/v1/member/renewal/run', { method: 'POST' })).status, 404)
      assert.equal((await venue.request(`/api/v1/member/member/${member.membership_id}/billing`)).status, 404)
      assert.deepEqual(await run('2032-06-08T02:00:00Z'), { invoiced_count: 0, activated_count: 0, lapsed_count: 0 })
      assert.equal(await periodCount(member.membership_id), 1)
    } finally {
      await venue.asTenant((tenant) => enableModule(tenant, 'member', COURT_DECLARATION))
    }
  })
})
