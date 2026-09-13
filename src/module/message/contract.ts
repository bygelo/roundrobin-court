// CONTRACT — owned by the message lane; other modules import only this file.
//
// notifyPlayer queues one transactional message through the notification pack.
// It must be a silent no-op ({ is_queued: false }) when the message or
// notification module is disabled, so a producer never has to check.
// The signature is fixed; the message lane replaces the body.
//
// Behaviour:
//   - idempotent per (message_kind, subject_code, channel): calling twice queues
//     once, and the second call still answers is_queued: true;
//   - essential kinds (booking_confirmed, booking_receipt, booking_cancelled,
//     court_changed, closure) send whenever a recipient exists;
//   - optional kinds (booking_reminder, waitlist_opened, program_registered,
//     pickup_ready, waiver_prompt) send only to a player who opted in;
//   - one outbox row per channel with a recipient (email and/or phone). When
//     only party_id is given, the party's own email/phone are used;
//   - never throws for an outbox or provider problem; the provider runs later.
//
// Detail keys are the template placeholders. Common ones: player_name,
// court_name, date, time, booking_code, recovery_link, amount. Also accepted as
// aliases: player, court, total_amount / paid_amount (→ amount), starts_at
// (→ date). venue_name is filled in automatically.

import type { TenantContext } from '@bygelo/roundrobin-kernel'
import { dispatchMessage } from './service.ts'

export type MessageKind =
  | 'booking_confirmed'
  | 'booking_receipt'
  | 'booking_cancelled'
  | 'booking_reminder'
  | 'program_registered'
  | 'waitlist_opened'
  | 'court_changed'
  | 'closure'
  | 'pickup_ready'
  | 'waiver_prompt'

export type NotifyPlayerInput = {
  message_kind: MessageKind
  party_id?: string
  recipient_email?: string
  recipient_phone?: string
  /** The business record this is about, e.g. a booking_code. Used for idempotency. */
  subject_code: string
  /** Template values, already formatted for a person. */
  detail: Record<string, string>
}

export async function notifyPlayer(
  tenant: TenantContext,
  input: NotifyPlayerInput,
): Promise<{ is_queued: boolean }> {
  try {
    // The whole dispatch runs on a savepoint's query tag. postgres.js remembers
    // a failed statement and rethrows it when the enclosing scope ends, even if
    // it was caught — so a read that failed on the producer's own tag would
    // still turn the producer's booking into a 500. Scoping every statement to
    // the savepoint confines that failure to the message.
    const result = await tenant.query.savepoint((sp) =>
      dispatchMessage({ ...tenant, query: sp as unknown as TenantContext['query'] }, input),
    )
    return { is_queued: result.outcome === 'queued' || result.outcome === 'duplicate' }
  } catch (error) {
    // A producer's booking must not fail because a message could not be
    // queued. Log without any recipient.
    console.warn(`message: notifyPlayer ${input.message_kind} for ${input.subject_code} was not queued: ${error instanceof Error ? error.message : 'unknown error'}`)
    return { is_queued: false }
  }
}
