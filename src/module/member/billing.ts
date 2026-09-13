// Member billing — recurring invoices for memberships on a billed plan.
//
// Money goes through the billing pack (createInvoice + addLine + openInvoice);
// a payment is read back from the invoice's status. This module only records
// which invoice belongs to which membership period (member_billing_period) and
// what that means for the membership: pending_payment until the first invoice
// is paid, active while paid, lapsed when a renewal outlives the grace.
//
// A pending or lapsed membership sits in the pack's `past_due` status, which the
// quote port already refuses a member price to.

import { addLine, createInvoice, openInvoice } from '@bygelo/roundrobin-billing'
import { recordAuditEvent, type TenantContext, type Uuid } from '@bygelo/roundrobin-kernel'
import { fromCentavo, toCentavo } from '../shop/money.ts'
import {
  RENEWAL_GRACE_DAY_COUNT,
  RENEWAL_LEAD_DAY_COUNT,
  addDay,
  billingBadge,
  billingPeriod,
  localDate,
  periodDueOn,
  periodStatus,
  startOfLocalDay,
  type BillingBadgeCode,
  type BillingPeriodCode,
  type PeriodStatusCode,
  type RenewalStateCode,
} from './rule.ts'
import { MemberError, venueTimeZone } from './service.ts'
import { atomic } from '../shop/atomic.ts'

export type MemberBillingSummary = {
  is_auto_renew: boolean
  renewal_state_code: RenewalStateCode
  current_period_start_on: string
  current_period_end_on: string
  /** The day the next period starts, when auto-renew is on. */
  next_renewal_on: string | null
  badge_code: BillingBadgeCode
  badge_on: string | null
}

export type MemberBillingPeriod = {
  period_index: number
  period_start_on: string
  period_end_on: string
  last_day_on: string
  due_on: string
  invoice_code: string | null
  total_amount: string
  balance_amount: string
  status_code: PeriodStatusCode
  is_applied: boolean
}

export type MemberBilling = {
  membership_id: Uuid
  is_billed: boolean
  is_auto_renew: boolean
  renewal_state_code: RenewalStateCode | null
  current_period_start_on: string | null
  current_period_end_on: string | null
  next_renewal_on: string | null
  badge_code: BillingBadgeCode | null
  badge_on: string | null
  period: MemberBillingPeriod[]
}

function money(value: string | number | null): string {
  return fromCentavo(toCentavo(String(value ?? '0')))
}

/**
 * Serialize billing work per tenant for the rest of the transaction. The
 * UNIQUE period key already makes a duplicate invoice impossible; the lock
 * makes a concurrent run wait instead of failing on it.
 */
export async function lockRenewal(tenant: TenantContext): Promise<void> {
  await tenant.query`SELECT pg_advisory_xact_lock(hashtext(${`member.renewal:${tenant.organization_id}`}))`
}

// ---------------------------------------------------------------------------
// invoice a period
// ---------------------------------------------------------------------------

type PeriodInput = {
  member_billing_id: Uuid
  membership_id: Uuid
  membership_code: string
  party_id: Uuid
  plan_name: string
  price_amount: string
  period_index: number
  period_start_on: string
  period_end_on: string
  time_zone: string
}

/** Claim the period row, then raise its invoice. False when the period was already invoiced. */
async function invoicePeriod(tenant: TenantContext, input: PeriodInput): Promise<boolean> {
  const [row] = await tenant.query<{ member_billing_period_id: Uuid }[]>`
    INSERT INTO member_billing_period (
      organization_id, member_billing_id, membership_id, period_index, period_start_on, period_end_on, price_amount
    ) VALUES (
      ${tenant.organization_id}::uuid, ${input.member_billing_id}::uuid, ${input.membership_id}::uuid, ${input.period_index},
      ${input.period_start_on}::date, ${input.period_end_on}::date, ${input.price_amount}::numeric
    )
    ON CONFLICT DO NOTHING
    RETURNING member_billing_period_id`
  if (!row) return false

  const last_day_on = addDay(input.period_end_on, -1)
  const invoice = await createInvoice(tenant, {
    party_id: input.party_id,
    invoice_code: `mb-${input.membership_code}-${input.period_start_on.replaceAll('-', '')}`,
    due_at: startOfLocalDay(periodDueOn(input.period_index, input.period_start_on), input.time_zone),
    note: `${input.plan_name} membership, ${input.period_start_on} to ${last_day_on}`,
  })
  await addLine(tenant, {
    invoice_id: invoice.invoice_id,
    description: `${input.plan_name} — ${input.period_start_on} to ${last_day_on}`,
    unit_amount: toCentavo(input.price_amount) / 100,
  })
  await openInvoice(tenant, invoice.invoice_id)
  await tenant.query`
    UPDATE member_billing_period SET invoice_id = ${invoice.invoice_id}::uuid
    WHERE organization_id = ${tenant.organization_id}::uuid AND member_billing_period_id = ${row.member_billing_period_id}::uuid`
  return true
}

/** Put a just-issued membership on a billed plan: pending_payment with its first-period invoice. */
export async function startBilling(
  tenant: TenantContext,
  input: {
    membership_id: Uuid
    membership_code: string
    party_id: Uuid
    member_plan_id: Uuid
    plan_name: string
    price_amount: string
    billing_period_code: BillingPeriodCode
    starts_on: string
    time_zone: string
  },
): Promise<void> {
  const period = billingPeriod(input.starts_on, 0, input.billing_period_code)
  await tenant.query`
    UPDATE membership SET status = 'past_due'
    WHERE organization_id = ${tenant.organization_id}::uuid AND membership_id = ${input.membership_id}::uuid`
  const [row] = await tenant.query<{ member_billing_id: Uuid }[]>`
    INSERT INTO member_billing (
      organization_id, membership_id, member_plan_id, party_id, anchor_on, period_index,
      current_period_start_on, current_period_end_on, renewal_state_code
    ) VALUES (
      ${tenant.organization_id}::uuid, ${input.membership_id}::uuid, ${input.member_plan_id}::uuid, ${input.party_id}::uuid,
      ${input.starts_on}::date, 0, ${period.period_start_on}::date, ${period.period_end_on}::date, 'pending_payment'
    ) RETURNING member_billing_id`
  await invoicePeriod(tenant, {
    member_billing_id: String(row!.member_billing_id),
    membership_id: input.membership_id,
    membership_code: input.membership_code,
    party_id: input.party_id,
    plan_name: input.plan_name,
    price_amount: input.price_amount,
    period_index: 0,
    ...period,
    time_zone: input.time_zone,
  })
}

// ---------------------------------------------------------------------------
// the three renewal steps
// ---------------------------------------------------------------------------

async function eachMembership<T>(tenant: TenantContext, list: T[], work: (tenant: TenantContext, one: T) => Promise<boolean>): Promise<number> {
  let count = 0
  for (const one of list) {
    try {
      // One membership's failure rolls back only its own writes and does not
      // stop the rest of the venue from renewing.
      if (await atomic(tenant, (bound) => work(bound, one))) count += 1
    } catch (error) {
      console.warn(`member renewal skipped a membership: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return count
}

/** Paid, not-yet-applied periods: activate a pending membership, or extend to the paid period (once). */
export async function applyPaidPeriod(tenant: TenantContext, time_zone: string): Promise<number> {
  const row = await tenant.query<
    { member_billing_period_id: Uuid; member_billing_id: Uuid; membership_id: Uuid; period_index: number; period_start_on: string; period_end_on: string }[]
  >`
    SELECT bp.member_billing_period_id, bp.member_billing_id, bp.membership_id, bp.period_index,
           bp.period_start_on::text AS period_start_on, bp.period_end_on::text AS period_end_on
    FROM member_billing_period bp
    JOIN invoice i ON i.invoice_id = bp.invoice_id AND i.organization_id = bp.organization_id
    JOIN membership m ON m.membership_id = bp.membership_id AND m.organization_id = bp.organization_id
    WHERE bp.organization_id = ${tenant.organization_id}::uuid
      AND bp.is_applied = false AND i.status = 'paid'
      AND m.deleted_at IS NULL AND m.status <> 'cancelled'
    ORDER BY bp.membership_id, bp.period_index`
  return eachMembership(tenant, row, async (bound, one) => {
    const claimed = await bound.query`
      UPDATE member_billing_period SET is_applied = true, applied_at = now()
      WHERE organization_id = ${bound.organization_id}::uuid
        AND member_billing_period_id = ${one.member_billing_period_id}::uuid AND is_applied = false
      RETURNING member_billing_period_id`
    if (claimed.length === 0) return false
    const moved = await bound.query`
      UPDATE member_billing
      SET period_index = ${one.period_index}, current_period_start_on = ${one.period_start_on}::date,
          current_period_end_on = ${one.period_end_on}::date, renewal_state_code = 'active'
      WHERE organization_id = ${bound.organization_id}::uuid AND member_billing_id = ${one.member_billing_id}::uuid
        AND period_index <= ${one.period_index}
      RETURNING member_billing_id`
    if (moved.length === 0) return false
    const ends_at = startOfLocalDay(one.period_end_on, time_zone)
    await bound.query`
      UPDATE membership
      SET ends_at = greatest(coalesce(ends_at, ${ends_at}::timestamptz), ${ends_at}::timestamptz),
          status = CASE WHEN status = 'past_due' THEN 'active'::membership_status ELSE status END
      WHERE organization_id = ${bound.organization_id}::uuid AND membership_id = ${one.membership_id}::uuid`
    return true
  })
}

/** Active memberships whose period ended past the grace with the renewal invoice unpaid → lapsed. */
export async function lapseUnpaid(tenant: TenantContext, today: string): Promise<number> {
  const row = await tenant.query<{ member_billing_id: Uuid; membership_id: Uuid }[]>`
    SELECT b.member_billing_id, b.membership_id
    FROM member_billing b
    JOIN membership m ON m.membership_id = b.membership_id AND m.organization_id = b.organization_id
    JOIN member_billing_period bp
      ON bp.organization_id = b.organization_id AND bp.membership_id = b.membership_id AND bp.period_index = b.period_index + 1
    LEFT JOIN invoice i ON i.invoice_id = bp.invoice_id AND i.organization_id = bp.organization_id
    WHERE b.organization_id = ${tenant.organization_id}::uuid
      AND b.renewal_state_code = 'active' AND m.status = 'active' AND m.deleted_at IS NULL
      AND b.current_period_end_on <= ${addDay(today, -RENEWAL_GRACE_DAY_COUNT)}::date
      AND coalesce(i.status::text, 'open') <> 'paid'
    ORDER BY b.membership_id`
  return eachMembership(tenant, row, async (bound, one) => {
    const updated = await bound.query`
      UPDATE member_billing SET renewal_state_code = 'lapsed'
      WHERE organization_id = ${bound.organization_id}::uuid AND member_billing_id = ${one.member_billing_id}::uuid
        AND renewal_state_code = 'active'
      RETURNING member_billing_id`
    if (updated.length === 0) return false
    await bound.query`
      UPDATE membership SET status = 'past_due'
      WHERE organization_id = ${bound.organization_id}::uuid AND membership_id = ${one.membership_id}::uuid AND status = 'active'`
    return true
  })
}

/** Auto-renewing memberships ending within the lead window with no next-period invoice → one invoice. */
export async function invoiceDuePeriod(tenant: TenantContext, today: string, time_zone: string): Promise<number> {
  const row = await tenant.query<
    {
      member_billing_id: Uuid
      membership_id: Uuid
      membership_code: string
      party_id: Uuid
      anchor_on: string
      period_index: number
      price_amount: string
      billing_period_code: BillingPeriodCode
      plan_name: string
    }[]
  >`
    SELECT b.member_billing_id, b.membership_id, m.membership_code, b.party_id, b.anchor_on::text AS anchor_on, b.period_index,
           p.price_amount::text AS price_amount, p.billing_period_code, mp.display_name AS plan_name
    FROM member_billing b
    JOIN membership m ON m.membership_id = b.membership_id AND m.organization_id = b.organization_id
    JOIN member_plan p ON p.member_plan_id = b.member_plan_id AND p.organization_id = b.organization_id
    JOIN membership_plan mp ON mp.membership_plan_id = p.membership_plan_id AND mp.organization_id = p.organization_id
    WHERE b.organization_id = ${tenant.organization_id}::uuid
      AND b.is_auto_renew AND b.renewal_state_code = 'active'
      AND m.status = 'active' AND m.deleted_at IS NULL
      AND p.deleted_at IS NULL AND p.billing_interval_code <> 'none'
      AND b.current_period_end_on <= ${addDay(today, RENEWAL_LEAD_DAY_COUNT)}::date
      AND NOT EXISTS (
        SELECT 1 FROM member_billing_period bp
        WHERE bp.organization_id = b.organization_id AND bp.membership_id = b.membership_id
          AND bp.period_index = b.period_index + 1)
    ORDER BY b.membership_id`
  return eachMembership(tenant, row, (bound, one) =>
    invoicePeriod(bound, {
      member_billing_id: String(one.member_billing_id),
      membership_id: String(one.membership_id),
      membership_code: one.membership_code,
      party_id: String(one.party_id),
      plan_name: one.plan_name,
      price_amount: money(one.price_amount),
      period_index: Number(one.period_index) + 1,
      ...billingPeriod(one.anchor_on, Number(one.period_index) + 1, one.billing_period_code),
      time_zone,
    }),
  )
}

/** Apply payments now (the pack emits no payment event to react to). Used before an operator reads billing. */
export async function settleMembershipBilling(tenant: TenantContext): Promise<number> {
  await lockRenewal(tenant)
  return applyPaidPeriod(tenant, await venueTimeZone(tenant))
}

// ---------------------------------------------------------------------------
// read + auto-renew
// ---------------------------------------------------------------------------

type BillingRow = {
  membership_id: Uuid
  is_auto_renew: boolean
  renewal_state_code: RenewalStateCode
  current_period_start_on: string
  current_period_end_on: string
  next_invoice_status: string | null
}

function summarize(one: BillingRow, today: string): MemberBillingSummary {
  const badge = billingBadge({
    renewal_state_code: one.renewal_state_code,
    current_period_start_on: one.current_period_start_on,
    current_period_end_on: one.current_period_end_on,
    next_invoice_status: one.next_invoice_status,
    today,
  })
  return {
    is_auto_renew: Boolean(one.is_auto_renew),
    renewal_state_code: one.renewal_state_code,
    current_period_start_on: one.current_period_start_on,
    current_period_end_on: one.current_period_end_on,
    next_renewal_on: one.is_auto_renew && one.renewal_state_code !== 'lapsed' ? one.current_period_end_on : null,
    ...badge,
  }
}

async function readBillingRow(tenant: TenantContext, membership_id: Uuid[]): Promise<BillingRow[]> {
  if (membership_id.length === 0) return []
  return tenant.query<BillingRow[]>`
    SELECT b.membership_id, b.is_auto_renew, b.renewal_state_code,
           b.current_period_start_on::text AS current_period_start_on, b.current_period_end_on::text AS current_period_end_on,
           (SELECT i.status::text FROM member_billing_period bp
              JOIN invoice i ON i.invoice_id = bp.invoice_id AND i.organization_id = bp.organization_id
             WHERE bp.organization_id = b.organization_id AND bp.membership_id = b.membership_id
               AND bp.period_index = b.period_index + 1) AS next_invoice_status
    FROM member_billing b
    WHERE b.organization_id = ${tenant.organization_id}::uuid AND b.membership_id IN ${tenant.query(membership_id)}`
}

export async function readBillingSummary(
  tenant: TenantContext,
  membership_id: Uuid[],
  today: string,
): Promise<Map<string, MemberBillingSummary>> {
  const result = new Map<string, MemberBillingSummary>()
  for (const one of await readBillingRow(tenant, membership_id)) result.set(String(one.membership_id), summarize(one, today))
  return result
}

export async function readMemberBilling(tenant: TenantContext, membership_id: Uuid, now = new Date()): Promise<MemberBilling> {
  const [membership] = await tenant.query<{ membership_id: Uuid }[]>`
    SELECT membership_id FROM membership
    WHERE organization_id = ${tenant.organization_id}::uuid AND membership_id = ${membership_id}::uuid AND deleted_at IS NULL`
  if (!membership) throw new MemberError('membership not found', 404)
  const time_zone = await venueTimeZone(tenant)
  const today = localDate(now, time_zone)
  const [row] = await readBillingRow(tenant, [membership_id])
  if (!row) {
    return {
      membership_id,
      is_billed: false,
      is_auto_renew: false,
      renewal_state_code: null,
      current_period_start_on: null,
      current_period_end_on: null,
      next_renewal_on: null,
      badge_code: null,
      badge_on: null,
      period: [],
    }
  }
  const period = await tenant.query<
    {
      period_index: number
      period_start_on: string
      period_end_on: string
      invoice_code: string | null
      invoice_status: string | null
      total_amount: string | null
      balance_amount: string | null
      is_applied: boolean
    }[]
  >`
    SELECT bp.period_index, bp.period_start_on::text AS period_start_on, bp.period_end_on::text AS period_end_on,
           i.invoice_code, i.status::text AS invoice_status,
           coalesce(i.total_amount, bp.price_amount)::text AS total_amount,
           coalesce(i.balance_amount, bp.price_amount)::text AS balance_amount, bp.is_applied
    FROM member_billing_period bp
    LEFT JOIN invoice i ON i.invoice_id = bp.invoice_id AND i.organization_id = bp.organization_id
    WHERE bp.organization_id = ${tenant.organization_id}::uuid AND bp.membership_id = ${membership_id}::uuid
    ORDER BY bp.period_index DESC`
  return {
    membership_id,
    is_billed: true,
    ...summarize(row, today),
    period: period.map((one) => {
      const due_on = periodDueOn(Number(one.period_index), one.period_start_on)
      return {
        period_index: Number(one.period_index),
        period_start_on: one.period_start_on,
        period_end_on: one.period_end_on,
        last_day_on: addDay(one.period_end_on, -1),
        due_on,
        invoice_code: one.invoice_code,
        total_amount: money(one.total_amount),
        balance_amount: money(one.balance_amount),
        status_code: periodStatus({ invoice_status: one.invoice_status, due_on, today }),
        is_applied: Boolean(one.is_applied),
      }
    }),
  }
}

export async function setAutoRenew(tenant: TenantContext, membership_id: Uuid, is_auto_renew: unknown, actor_id: Uuid): Promise<MemberBilling> {
  if (typeof is_auto_renew !== 'boolean') throw new MemberError('is_auto_renew must be true or false')
  const [membership] = await tenant.query<{ membership_id: Uuid }[]>`
    SELECT membership_id FROM membership
    WHERE organization_id = ${tenant.organization_id}::uuid AND membership_id = ${membership_id}::uuid AND deleted_at IS NULL`
  if (!membership) throw new MemberError('membership not found', 404)
  const updated = await tenant.query`
    UPDATE member_billing SET is_auto_renew = ${is_auto_renew}
    WHERE organization_id = ${tenant.organization_id}::uuid AND membership_id = ${membership_id}::uuid
    RETURNING member_billing_id`
  if (updated.length === 0) throw new MemberError('This membership is not on a billed plan — there is nothing to renew', 409)
  await recordAuditEvent(tenant, {
    organization_id: tenant.organization_id,
    actor_label: actor_id,
    event_code: 'member.membership.auto_renew',
    subject_table: 'membership',
    subject_id: membership_id,
    reason: is_auto_renew ? 'auto-renew on' : 'auto-renew off',
    detail: { is_auto_renew },
  })
  return readMemberBilling(tenant, membership_id)
}
