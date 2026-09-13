// CONTRACT — owned by the shop-member lane; the portal imports only this file.
//
// Membership changes a booking ONLY through this pricing/eligibility port. When
// the member module is disabled, or the party holds no entitlement, it returns
// the base price and is_eligible: true.

import type { TenantContext } from '@bygelo/roundrobin-kernel'

export type MemberQuote = {
  price_amount: string
  base_amount: string
  entitlement_code: string | null
  is_eligible: boolean
  /** A sentence for the player when not eligible, or when a member price applied. */
  reason: string | null
}

export async function quoteMemberPrice(
  _tenant: TenantContext,
  input: { party_id: string | null; session_id: string; base_amount: string },
): Promise<MemberQuote> {
  return {
    price_amount: input.base_amount,
    base_amount: input.base_amount,
    entitlement_code: null,
    is_eligible: true,
    reason: null,
  }
}

/** Record one use of an entitlement after a booking confirms. Atomic; no-op without one. */
export async function consumeEntitlement(
  _tenant: TenantContext,
  _input: { party_id: string; entitlement_code: string; subject_code: string },
): Promise<void> {}
