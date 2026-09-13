// Seed step for the member module: a monthly BILLED plan, a session pass, three
// members each with a paid current period (one due for renewal in two days, so
// the renewal job raises its next invoice), and a pass with a few sessions used.
// Idempotent — plans keyed by plan_code, members by email, payments by
// idempotency key, invoices by the UNIQUE period, pass uses by subject_code.

import { recordPayment } from '@bygelo/roundrobin-billing'
import { settleMembershipBilling } from '../../src/module/member/billing.ts'
import { runMembershipRenewal } from '../../src/module/member/renewal.ts'
import { consume, createMemberPlan, enrolMember, issueMemberPass, updateMemberPlan, venueTimeZone } from '../../src/module/member/service.ts'
import { addDay, addMonth, localDate } from '../../src/module/member/rule.ts'
import type { SeedContext } from './context.ts'

export async function seedMember({ tenant, organization_id }: SeedContext): Promise<void> {
  const plan_id = new Map<string, string>()
  const plan = [
    {
      plan_code: 'monthly-member',
      display_name: 'Monthly Member',
      plan_kind_code: 'membership',
      price_amount: '1500.00',
      billing_period_code: 'monthly',
      billing_interval_code: 'monthly',
      price_rule_code: 'percent_off',
      percent_off: '20',
      is_member_session_access: true,
    },
    {
      plan_code: 'ten-session-pass',
      display_name: '10-Session Pass',
      plan_kind_code: 'pass',
      price_amount: '3600.00',
      session_count: 10,
      valid_day_count: 60,
    },
  ]
  for (const one of plan) {
    const [existing] = await tenant.query<{ member_plan_id: string; billing_interval_code: string }[]>`
      SELECT p.member_plan_id, p.billing_interval_code FROM member_plan p
      JOIN membership_plan mp ON mp.membership_plan_id = p.membership_plan_id
      WHERE p.organization_id = ${organization_id}::uuid AND mp.plan_code = ${one.plan_code}`
    let id: string
    if (existing) {
      id = String(existing.member_plan_id)
      // A database seeded before billing existed: turn invoicing on for the plan.
      if (one.billing_interval_code && existing.billing_interval_code !== one.billing_interval_code) {
        await updateMemberPlan(tenant, id, { billing_interval_code: one.billing_interval_code })
      }
    } else {
      id = (await createMemberPlan(tenant, one)).member_plan_id
    }
    plan_id.set(one.plan_code, id)
  }

  const time_zone = await venueTimeZone(tenant)
  const today = localDate(new Date(), time_zone)
  const member = [
    { display_name: 'Andrea Santos', email: 'andrea.santos@example.ph', phone: '+63 917 555 0142', starts_on: addDay(today, -10) },
    // Period ends two days from today: started one month before that.
    { display_name: 'Miguel Reyes', email: 'miguel.reyes@example.ph', phone: '+63 918 555 0199', starts_on: addMonth(addDay(today, 2), -1) },
    { display_name: 'Bea Cruz', email: 'bea.cruz@example.ph', phone: '+63 927 555 0110', starts_on: addDay(today, -3) },
  ]
  for (const one of member) {
    const [existing] = await tenant.query`
      SELECT 1 FROM membership m JOIN party p ON p.party_id = m.party_id
      WHERE m.organization_id = ${organization_id}::uuid AND lower(p.email_address) = ${one.email}`
    if (!existing) await enrolMember(tenant, { ...one, plan_id: plan_id.get('monthly-member') })

    // Pay the first period at the desk, so every demo member is active.
    const unpaid = await tenant.query<{ party_id: string; invoice_code: string; balance_amount: string }[]>`
      SELECT b.party_id, i.invoice_code, i.balance_amount::text AS balance_amount
      FROM member_billing_period bp
      JOIN member_billing b ON b.member_billing_id = bp.member_billing_id AND b.organization_id = bp.organization_id
      JOIN invoice i ON i.invoice_id = bp.invoice_id AND i.organization_id = bp.organization_id
      JOIN party p ON p.party_id = b.party_id AND p.organization_id = b.organization_id
      WHERE bp.organization_id = ${organization_id}::uuid AND bp.period_index = 0
        AND lower(p.email_address) = ${one.email} AND i.status IN ('open', 'partial')`
    for (const invoice of unpaid) {
      await recordPayment(tenant, {
        party_id: String(invoice.party_id),
        amount: Number(invoice.balance_amount),
        collection_mode: 'manual_record',
        idempotency_key: `seed-member-${invoice.invoice_code}`,
        method_code: 'cash',
        note: `Membership paid at the desk (${invoice.invoice_code})`,
        post_now: true,
      })
    }
  }
  await settleMembershipBilling(tenant)
  // Raises Miguel's next-period invoice (his period ends within three days).
  await runMembershipRenewal(tenant)

  const pass_holder = { display_name: 'Carlo Mendoza', email: 'carlo.mendoza@example.ph', phone: '+63 945 555 0177' }
  const [holder] = await tenant.query<{ party_id: string }[]>`
    SELECT p.party_id FROM party p
    WHERE p.organization_id = ${organization_id}::uuid AND lower(p.email_address) = ${pass_holder.email}
      AND EXISTS (SELECT 1 FROM pass ps JOIN member_pass x ON x.pass_id = ps.pass_id WHERE ps.party_id = p.party_id)`
  const party_id = holder
    ? String(holder.party_id)
    : (await issueMemberPass(tenant, { ...pass_holder, plan_id: plan_id.get('ten-session-pass') })).party_id
  for (const visit of [1, 2, 3]) {
    await consume(tenant, { party_id, entitlement_code: 'session_pass', subject_code: `seed-visit-${visit}` })
  }
}
