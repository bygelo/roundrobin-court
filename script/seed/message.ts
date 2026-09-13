// Seed step for the message module.
//
// Writes the default template for every message kind and channel, then queues
// a booking confirmation for up to three existing demo bookings that have a
// player with an email or phone. With no provider configured those sit in the
// outbox as Held, which is exactly what a fresh venue should see. Idempotent:
// templates insert-if-missing and notifyPlayer is unique per kind, subject,
// and channel.

import { dispatchMessage, ensureTemplate, readProviderStatus } from '../../src/module/message/service.ts'
import type { SeedContext } from './context.ts'

export async function seedMessage(context: SeedContext): Promise<void> {
  const { tenant, organization_id } = context
  await ensureTemplate(tenant)

  const booking = await tenant.query<{
    booking_code: string
    party_id: string
    starts_at: Date
    court_name: string
    time_zone: string
  }[]>`
    SELECT b.booking_code, b.party_id, b.starts_at, r.display_name AS court_name,
           coalesce(s.time_zone, o.time_zone) AS time_zone
    FROM booking b
    JOIN party p ON p.party_id = b.party_id AND p.deleted_at IS NULL
    JOIN resource r ON r.resource_id = b.resource_id
    JOIN site s ON s.site_id = r.site_id
    JOIN organization o ON o.organization_id = b.organization_id
    WHERE b.organization_id = ${organization_id}
      AND b.status = 'confirmed'
      AND (p.email_address IS NOT NULL OR p.phone_number IS NOT NULL)
    ORDER BY b.starts_at
    LIMIT 3`

  if (booking.length === 0) {
    console.log('  message: templates ready; no demo booking with a player contact to message yet')
    return
  }

  let queued_count = 0
  for (const one of booking) {
    const result = await dispatchMessage(tenant, {
      message_kind: 'booking_confirmed',
      party_id: one.party_id,
      subject_code: one.booking_code,
      detail: {
        court_name: one.court_name,
        date: new Intl.DateTimeFormat('en-PH', { weekday: 'short', month: 'short', day: 'numeric', timeZone: one.time_zone }).format(one.starts_at),
        time: new Intl.DateTimeFormat('en-PH', { hour: 'numeric', minute: '2-digit', timeZone: one.time_zone }).format(one.starts_at),
        booking_code: one.booking_code,
        recovery_link: `/v/${context.organization_code}/booking/${one.booking_code}`,
      },
    })
    if (result.outcome === 'queued') queued_count += 1
  }
  console.log(`  message: templates ready; ${queued_count} sample confirmation queued`)
  const provider = await readProviderStatus(tenant)
  for (const one of provider.channel) {
    console.log(`  message: ${one.delivery_channel} — ${one.status_label}`)
  }
}
