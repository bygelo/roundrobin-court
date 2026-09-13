// The membership renewal job — safe to run every 15 minutes, per tenant.
//
//   1. paid periods not yet applied → activate / extend the membership (once);
//   2. renewals unpaid more than RENEWAL_GRACE_DAY_COUNT days after the period
//      ended → lapsed (member price stops through quoteMemberPrice);
//   3. auto-renewing memberships ending within RENEWAL_LEAD_DAY_COUNT days with
//      no next-period invoice → exactly one invoice (UNIQUE per period).
//
// Dates are venue-local (site.time_zone, default Asia/Manila). Periods are
// counted from the membership's anchor, so month ends never drift.

import { listEnabledModuleCode, type TenantContext } from '@bygelo/roundrobin-kernel'
import { applyPaidPeriod, invoiceDuePeriod, lapseUnpaid, lockRenewal } from './billing.ts'
import { localDate } from './rule.ts'
import { venueTimeZone } from './service.ts'

export type MembershipRenewalResult = { invoiced_count: number; activated_count: number; lapsed_count: number }

export async function runMembershipRenewal(
  tenant: TenantContext,
  option: { now?: Date } = {},
): Promise<MembershipRenewalResult> {
  if (!(await listEnabledModuleCode(tenant)).includes('member')) return { invoiced_count: 0, activated_count: 0, lapsed_count: 0 }
  const now = option.now ?? new Date()
  const time_zone = await venueTimeZone(tenant)
  const today = localDate(now, time_zone)
  // Concurrent runs for one tenant queue here rather than race.
  await lockRenewal(tenant)
  const activated_count = await applyPaidPeriod(tenant, time_zone)
  const lapsed_count = await lapseUnpaid(tenant, today)
  const invoiced_count = await invoiceDuePeriod(tenant, today, time_zone)
  return { invoiced_count, activated_count, lapsed_count }
}
