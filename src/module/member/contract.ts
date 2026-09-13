// CONTRACT — owned by the shop-member lane; the portal imports only this file.
//
// Membership changes a booking ONLY through this pricing/eligibility port. When
// the member module is disabled, or the party holds no entitlement, it returns
// the base price and is_eligible: true.
//
// Entitlement codes a quote can return, and consumeEntitlement accepts:
//   'membership'   — a member price from an active membership (unlimited; consuming
//                    records the use and spends nothing);
//   'session_pass' — the booking is covered by one use of a session pass
//                    (consuming spends one use, refuses at zero with a 409).
// A session is members-only when member_session_rule flags it
// (POST /api/v1/member/session/:session_id/rule).

import type { TenantContext } from '@bygelo/roundrobin-kernel'
import { atomic } from '../shop/atomic.ts'
import { consume, quote } from './service.ts'

export type MemberQuote = {
  price_amount: string
  base_amount: string
  entitlement_code: string | null
  is_eligible: boolean
  /** A sentence for the player when not eligible, or when a member price applied. */
  reason: string | null
}

export async function quoteMemberPrice(
  tenant: TenantContext,
  input: { party_id: string | null; session_id: string; base_amount: string },
): Promise<MemberQuote> {
  return quote(tenant, input)
}

/** Record one use of an entitlement after a booking confirms. Atomic; no-op without one. */
export async function consumeEntitlement(
  tenant: TenantContext,
  input: { party_id: string; entitlement_code: string; subject_code: string },
): Promise<void> {
  // Savepoint: a refusal (no sessions left) leaves the caller's transaction usable
  // and none of this call's writes behind, whether or not the caller catches it.
  return atomic(tenant, (bound) => consume(bound, input))
}
