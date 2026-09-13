// Seed step for the member module: two plans, three members (one expiring in
// five days), and a session pass with a few sessions already used. Idempotent —
// plans keyed by plan_code, members by email, pass uses by subject_code.

import { consume, createMemberPlan, enrolMember, issueMemberPass, venueTimeZone } from '../../src/module/member/service.ts'
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
    const [existing] = await tenant.query<{ member_plan_id: string }[]>`
      SELECT p.member_plan_id FROM member_plan p
      JOIN membership_plan mp ON mp.membership_plan_id = p.membership_plan_id
      WHERE p.organization_id = ${organization_id}::uuid AND mp.plan_code = ${one.plan_code}`
    const id = existing ? String(existing.member_plan_id) : (await createMemberPlan(tenant, one)).member_plan_id
    plan_id.set(one.plan_code, id)
  }

  const time_zone = await venueTimeZone(tenant)
  const today = localDate(new Date(), time_zone)
  const member = [
    { display_name: 'Andrea Santos', email: 'andrea.santos@example.ph', phone: '+63 917 555 0142', starts_on: addDay(today, -10) },
    // Ends five days from today: started one month before that.
    { display_name: 'Miguel Reyes', email: 'miguel.reyes@example.ph', phone: '+63 918 555 0199', starts_on: addMonth(addDay(today, 5), -1) },
    { display_name: 'Bea Cruz', email: 'bea.cruz@example.ph', phone: '+63 927 555 0110', starts_on: addDay(today, -3) },
  ]
  for (const one of member) {
    const [existing] = await tenant.query`
      SELECT 1 FROM membership m JOIN party p ON p.party_id = m.party_id
      WHERE m.organization_id = ${organization_id}::uuid AND lower(p.email_address) = ${one.email}`
    if (!existing) await enrolMember(tenant, { ...one, plan_id: plan_id.get('monthly-member') })
  }

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
