// Booking policy — the venue's rules for when and how a player may book.
//
// One row per organization in court_booking_policy (migration/002_venue.sql).
// A venue that never saved a policy gets the defaults below, so every reader
// (the portal lane, the court board) can call this without a setup check.

import type { TenantContext } from '@bygelo/roundrobin-kernel'

export type BookingPolicy = {
  advance_window_day_count: number
  cancellation_cutoff_hour_count: number
  hold_minute_count: number
  is_guest_booking_allowed: boolean
}

export const DEFAULT_BOOKING_POLICY: BookingPolicy = {
  advance_window_day_count: 14,
  cancellation_cutoff_hour_count: 24,
  hold_minute_count: 10,
  is_guest_booking_allowed: true,
}

export async function readBookingPolicy(tenant: TenantContext): Promise<{
  advance_window_day_count: number
  cancellation_cutoff_hour_count: number
  hold_minute_count: number
  is_guest_booking_allowed: boolean
}> {
  const [row] = await tenant.query<BookingPolicy[]>`
    SELECT advance_window_day_count, cancellation_cutoff_hour_count,
           hold_minute_count, is_guest_booking_allowed
    FROM court_booking_policy
    WHERE organization_id = ${tenant.organization_id}`
  if (!row) return { ...DEFAULT_BOOKING_POLICY }
  return {
    advance_window_day_count: Number(row.advance_window_day_count),
    cancellation_cutoff_hour_count: Number(row.cancellation_cutoff_hour_count),
    hold_minute_count: Number(row.hold_minute_count),
    is_guest_booking_allowed: row.is_guest_booking_allowed,
  }
}

/** Replace the venue's policy. Every field is required so a save is never a partial surprise. */
export async function saveBookingPolicy(tenant: TenantContext, policy: BookingPolicy): Promise<BookingPolicy> {
  await tenant.query`
    INSERT INTO court_booking_policy (organization_id, advance_window_day_count, cancellation_cutoff_hour_count,
                                      hold_minute_count, is_guest_booking_allowed)
    VALUES (${tenant.organization_id}, ${policy.advance_window_day_count}, ${policy.cancellation_cutoff_hour_count},
            ${policy.hold_minute_count}, ${policy.is_guest_booking_allowed})
    ON CONFLICT (organization_id) DO UPDATE SET
      advance_window_day_count = EXCLUDED.advance_window_day_count,
      cancellation_cutoff_hour_count = EXCLUDED.cancellation_cutoff_hour_count,
      hold_minute_count = EXCLUDED.hold_minute_count,
      is_guest_booking_allowed = EXCLUDED.is_guest_booking_allowed`
  return readBookingPolicy(tenant)
}
