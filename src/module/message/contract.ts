// CONTRACT — owned by the message lane; other modules import only this file.
//
// notifyPlayer queues one transactional message through the notification pack.
// It must be a silent no-op ({ is_queued: false }) when the message or
// notification module is disabled, so a producer never has to check.
// The signature is fixed; the message lane replaces the body.

import type { TenantContext } from '@bygelo/roundrobin-kernel'

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
  _tenant: TenantContext,
  _input: NotifyPlayerInput,
): Promise<{ is_queued: boolean }> {
  return { is_queued: false }
}
