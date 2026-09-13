// Seed step for the portal module: three guest bookings on the demo venue's
// real sessions — one paid online, one reserved to pay at the counter, one
// cancelled. Idempotent by guest email; skips quietly when the venue has no
// open slot today or tomorrow.

import { createPortalBooking, cancelByOperator, payBooking, readAvailability, type AvailabilitySlot } from '../../src/module/portal/service.ts'
import { addDay } from '../../src/module/portal/rule.ts'
import type { SeedContext } from './context.ts'

const GUEST = [
  { display_name: 'Maria Santos', email: 'maria.santos@example.com', phone: '0917 555 0101', outcome: 'online' },
  { display_name: 'Paolo Reyes', email: 'paolo.reyes@example.com', phone: '0918 555 0202', outcome: 'counter' },
  { display_name: 'Jessa Cruz', email: 'jessa.cruz@example.com', phone: '0919 555 0303', outcome: 'cancelled' },
] as const

export async function seedPortal(context: SeedContext): Promise<void> {
  const { tenant, organization_id } = context
  const [existing] = await tenant.query<{ seeded_count: number }[]>`
    SELECT count(*)::int AS seeded_count FROM portal_booking
    WHERE organization_id = ${organization_id}
      AND contact_email IN ${tenant.query(GUEST.map((one) => one.email))}`
  if ((existing?.seeded_count ?? 0) > 0) return

  const today = await readAvailability(tenant, {})
  const tomorrow = await readAvailability(tenant, { date: addDay(today.date, 1) })
  // Spread the three bookings across different start times so the grid reads naturally.
  const open: AvailabilitySlot[] = [...today.slot, ...tomorrow.slot].filter((one) => one.is_available)
  const picked: AvailabilitySlot[] = []
  for (const one of open) {
    if (picked.length === GUEST.length) break
    if (picked.some((taken) => new Date(taken.starts_at).getTime() === new Date(one.starts_at).getTime())) continue
    picked.push(one)
  }
  for (const one of open) {
    if (picked.length === GUEST.length) break
    if (!picked.includes(one)) picked.push(one)
  }
  if (picked.length === 0) {
    console.log('  portal: no open court today or tomorrow — skipped demo bookings')
    return
  }

  for (const [index, slot] of picked.entries()) {
    const guest = GUEST[index]!
    const created = await createPortalBooking(tenant, {
      session_id: slot.session_id,
      resource_id: slot.resource_id,
      contact: { display_name: guest.display_name, email: guest.email, phone: guest.phone },
      participant_count: 1,
    })
    if (guest.outcome === 'cancelled') {
      await cancelByOperator(tenant, created.booking_code)
      continue
    }
    await payBooking(
      tenant,
      created.booking_code,
      { recovery_token: created.recovery_token, method: guest.outcome },
      { return_url: `http://localhost/v/${context.organization_code}/booking/${created.booking_code}` },
    )
  }
}
