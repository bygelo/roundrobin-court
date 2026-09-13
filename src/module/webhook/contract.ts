// CONTRACT — owned by the connect lane (webhook); other modules import only this file.
//
// emitWebhook records one versioned business event for delivery to every
// active subscriber of `event_code`. Silent no-op when the webhook module is
// disabled. Must never throw for a delivery failure — delivery is async.

import type { TenantContext } from '@bygelo/roundrobin-kernel'
import { emitWebhookSafely } from './service.ts'

export type WebhookEventCode =
  | 'booking.held'
  | 'booking.confirmed'
  | 'booking.cancelled'
  | 'payment.recorded'
  | 'arrival.checked_in'
  | 'program.registered'
  | 'match.confirmed'

export type EmitWebhookInput = {
  event_code: WebhookEventCode
  /** Stable id of the subject, e.g. booking_code. Forms the idempotency key with event_code. */
  subject_code: string
  payload: Record<string, unknown>
}

export async function emitWebhook(tenant: TenantContext, input: EmitWebhookInput): Promise<void> {
  await emitWebhookSafely(tenant, input)
}
