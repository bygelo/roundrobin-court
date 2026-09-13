// Player privacy requests (R24).
//
// Intake is public and unauthenticated, so it is built not to leak: the same
// 202 and the same token shape whether or not the email matches the booking,
// only a masked email at rest, only a hash of the status token, and a status
// view with no personal data. Fulfilment is staff-only and goes through the
// consent pack, which writes the auditable data_subject_request row.

import { createHash, randomBytes } from 'node:crypto'
import { DomainError, type TenantContext, type Uuid } from '@bygelo/roundrobin-kernel'
import { listConsent, requestAccess, requestErasure } from '@bygelo/roundrobin-consent'

export type RequestKind = 'access' | 'erasure'
export type PrivacyStatus = 'received' | 'completed' | 'closed'

export const REDACTED_TEXT = '[redacted]'
export const REDACTED_EMAIL = 'redacted@invalid'

export function maskEmail(email: string): string {
  const [local, domain] = email.trim().toLowerCase().split('@')
  if (!local || !domain) return '•••'
  return `${local[0]}•••@${domain}`
}

export function hashStatusToken(token: string): string {
  return `sha256:${createHash('sha256').update(token).digest('hex')}`
}

export function statusSentence(request_kind: RequestKind, status: PrivacyStatus): string {
  if (status === 'received') {
    return request_kind === 'access'
      ? 'We have your request for a copy of your data. The venue reviews every request and replies within 30 days.'
      : 'We have your request to delete your data. The venue reviews every request and replies within 30 days.'
  }
  if (status === 'completed') {
    return request_kind === 'access'
      ? 'Your request is complete. The venue has prepared a copy of your data and will send it to the email address on your booking.'
      : 'Your request is complete. Your name, email, and phone number have been removed. Booking and payment records are kept without them, because the venue must keep financial records.'
  }
  return 'This request was closed without changes. If you still need help, contact the venue directly.'
}

async function hasTable(tenant: TenantContext, table_name: string): Promise<boolean> {
  const [row] = await tenant.query<{ is_present: boolean }[]>`
    SELECT to_regclass(${table_name}::text) IS NOT NULL AS is_present`
  return row?.is_present ?? false
}

async function hasColumn(tenant: TenantContext, table_name: string, column_name: string[]): Promise<boolean> {
  const [row] = await tenant.query<{ found_count: number }[]>`
    SELECT count(*)::int AS found_count FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = ${table_name}
      AND column_name = ANY(${column_name}::text[])`
  return (row?.found_count ?? 0) === column_name.length
}

// ---------------------------------------------------------------------------
// public intake
// ---------------------------------------------------------------------------

export function parseIntake(body: unknown): { request_kind: RequestKind; email: string; booking_code: string } {
  const value = (body ?? {}) as Record<string, unknown>
  const request_kind = value['request_kind']
  if (request_kind !== 'access' && request_kind !== 'erasure') {
    throw new DomainError('Choose whether you want a copy of your data or want it deleted.', 400)
  }
  const email = typeof value['email'] === 'string' ? value['email'].trim().toLowerCase() : ''
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new DomainError('Enter the email address you used when booking.', 400)
  }
  const booking_code = typeof value['booking_code'] === 'string' ? value['booking_code'].trim() : ''
  if (booking_code.length < 1 || booking_code.length > 64) {
    throw new DomainError('Enter the booking code from your confirmation.', 400)
  }
  return { request_kind, email, booking_code }
}

/** Always resolves a token; whether the email matched is never observable to the caller. */
export async function createPrivacyRequest(
  tenant: TenantContext,
  input: { request_kind: RequestKind; email: string; booking_code: string },
): Promise<{ status_token: string }> {
  const [booking] = await tenant.query<{ party_id: Uuid | null; email_address: string | null }[]>`
    SELECT p.party_id, p.email_address
    FROM booking b
    LEFT JOIN party p
      ON p.organization_id = b.organization_id AND p.party_id = b.party_id AND p.deleted_at IS NULL
    WHERE b.organization_id = ${tenant.organization_id} AND b.booking_code = ${input.booking_code}`

  let party_id: Uuid | null = null
  if (booking?.party_id && booking.email_address?.trim().toLowerCase() === input.email) {
    party_id = booking.party_id
  }
  // The portal keeps the contact the player typed at checkout; it counts too.
  if (await hasTable(tenant, 'portal_booking')) {
    const [portal] = await tenant.query<{ party_id: Uuid }[]>`
      SELECT pb.party_id
      FROM portal_booking pb
      JOIN booking b ON b.booking_id = pb.booking_id AND b.organization_id = pb.organization_id
      JOIN party p ON p.organization_id = pb.organization_id AND p.party_id = pb.party_id AND p.deleted_at IS NULL
      WHERE pb.organization_id = ${tenant.organization_id}
        AND b.booking_code = ${input.booking_code}
        AND pb.deleted_at IS NULL
        AND lower(btrim(pb.contact_email)) = ${input.email}`
    if (!party_id && portal) party_id = portal.party_id
  }

  const status_token = randomBytes(32).toString('base64url')
  await tenant.query`
    INSERT INTO admin_privacy_request (
      organization_id, request_kind, status_token_hash, booking_code, email_mask, is_verified, party_id
    ) VALUES (
      ${tenant.organization_id}, ${input.request_kind}, ${hashStatusToken(status_token)},
      ${input.booking_code}, ${maskEmail(input.email)}, ${party_id !== null}, ${party_id}
    )`
  return { status_token }
}

export type PublicPrivacyStatus = {
  request_kind: RequestKind
  status: PrivacyStatus
  status_sentence: string
  created_at: Date
  completed_at: Date | null
}

export async function readPrivacyStatus(
  tenant: TenantContext,
  status_token: string,
): Promise<PublicPrivacyStatus | undefined> {
  const [row] = await tenant.query<
    { request_kind: RequestKind; status: PrivacyStatus; created_at: Date; completed_at: Date | null }[]
  >`
    SELECT request_kind, status, created_at, completed_at
    FROM admin_privacy_request
    WHERE organization_id = ${tenant.organization_id}
      AND status_token_hash = ${hashStatusToken(status_token)}
      AND deleted_at IS NULL`
  if (!row) return undefined
  return { ...row, status_sentence: statusSentence(row.request_kind, row.status) }
}

// ---------------------------------------------------------------------------
// operator
// ---------------------------------------------------------------------------

export type PrivacyRequestView = {
  admin_privacy_request_id: Uuid
  request_kind: RequestKind
  status: PrivacyStatus
  booking_code: string
  email_mask: string
  is_verified: boolean
  party_display_name: string | null
  has_bundle: boolean
  resolution_note: string | null
  fulfilled_by_display_name: string | null
  created_at: Date
  completed_at: Date | null
}

async function selectRequest(tenant: TenantContext, id: Uuid | null): Promise<PrivacyRequestView[]> {
  return tenant.query<PrivacyRequestView[]>`
    SELECT r.admin_privacy_request_id, r.request_kind, r.status, r.booking_code, r.email_mask,
           r.is_verified, p.display_name AS party_display_name,
           r.access_bundle IS NOT NULL AS has_bundle, r.resolution_note,
           a.display_name AS fulfilled_by_display_name, r.created_at, r.completed_at
    FROM admin_privacy_request r
    LEFT JOIN party p ON p.organization_id = r.organization_id AND p.party_id = r.party_id
    LEFT JOIN actor a ON a.organization_id = r.organization_id AND a.actor_id = r.fulfilled_by_actor_id
    WHERE r.organization_id = ${tenant.organization_id}
      AND r.deleted_at IS NULL
      AND (${id}::uuid IS NULL OR r.admin_privacy_request_id = ${id}::uuid)
    ORDER BY (r.status = 'received') DESC, r.created_at DESC`
}

export async function listPrivacyRequest(tenant: TenantContext): Promise<PrivacyRequestView[]> {
  // Retention promised in the table comment: a prepared copy lives 30 day.
  await tenant.query`
    UPDATE admin_privacy_request SET access_bundle = NULL
    WHERE organization_id = ${tenant.organization_id}
      AND access_bundle IS NOT NULL AND completed_at < now() - interval '30 days'`
  return selectRequest(tenant, null)
}

async function lockRequest(
  tenant: TenantContext,
  id: string,
): Promise<{ request_kind: RequestKind; status: PrivacyStatus; is_verified: boolean; party_id: Uuid | null }> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new DomainError('privacy request not found', 404)
  const [row] = await tenant.query<
    { request_kind: RequestKind; status: PrivacyStatus; is_verified: boolean; party_id: Uuid | null }[]
  >`
    SELECT request_kind, status, is_verified, party_id
    FROM admin_privacy_request
    WHERE organization_id = ${tenant.organization_id} AND admin_privacy_request_id = ${id}::uuid
      AND deleted_at IS NULL
    FOR UPDATE`
  if (!row) throw new DomainError('privacy request not found', 404)
  if (row.status !== 'received') throw new DomainError(`This request is already ${row.status}.`, 409)
  return row
}

export async function buildAccessBundle(tenant: TenantContext, party_id: Uuid): Promise<Record<string, unknown>> {
  const [organization] = await tenant.query<{ display_name: string }[]>`
    SELECT display_name FROM organization WHERE organization_id = ${tenant.organization_id}`
  const [party] = await tenant.query`
    SELECT display_name, email_address, phone_number, created_at
    FROM party WHERE organization_id = ${tenant.organization_id} AND party_id = ${party_id}`
  const booking = await tenant.query`
    SELECT b.booking_code, b.status, b.starts_at, b.ends_at, b.participant_count, b.price_amount,
           r.display_name AS court_name, b.created_at, b.cancelled_at
    FROM booking b LEFT JOIN resource r ON r.resource_id = b.resource_id
    WHERE b.organization_id = ${tenant.organization_id} AND b.party_id = ${party_id}
    ORDER BY b.starts_at DESC`
  const bundle: Record<string, unknown> = {
    format_code: 'court.privacy-bundle.v1',
    generated_at: new Date().toISOString(),
    venue_name: organization?.display_name ?? null,
    profile: party ?? null,
    booking,
  }
  if (await hasTable(tenant, 'portal_booking')) {
    bundle['booking_contact'] = await tenant.query`
      SELECT b.booking_code, pb.contact_display_name, pb.contact_email, pb.contact_phone,
             pb.total_amount, pb.is_pay_at_counter, pb.created_at
      FROM portal_booking pb JOIN booking b ON b.booking_id = pb.booking_id
      WHERE pb.organization_id = ${tenant.organization_id} AND pb.party_id = ${party_id}
      ORDER BY pb.created_at DESC`
  }
  if (await hasTable(tenant, 'program_registration')) {
    bundle['program_registration'] = await tenant.query`
      SELECT display_name, email_address, phone_number, status_code, paid_at, cancelled_at, created_at
      FROM program_registration
      WHERE organization_id = ${tenant.organization_id} AND party_id = ${party_id}
      ORDER BY created_at DESC`
  }
  if (await hasTable(tenant, 'arrival_check_in')) {
    bundle['check_in'] = await tenant.query`
      SELECT subject_kind, method_code, checked_in_at
      FROM arrival_check_in
      WHERE organization_id = ${tenant.organization_id} AND party_id = ${party_id}
      ORDER BY checked_in_at DESC`
  }
  bundle['order'] = await tenant.query`
    SELECT order_code, status, total_amount, currency_code, placed_at
    FROM sales_order
    WHERE organization_id = ${tenant.organization_id} AND buyer_party_id = ${party_id} AND deleted_at IS NULL
    ORDER BY placed_at DESC`
  bundle['invoice'] = await tenant.query`
    SELECT invoice_code, status, total_amount, paid_amount, balance_amount, issued_at
    FROM invoice
    WHERE organization_id = ${tenant.organization_id} AND party_id = ${party_id} AND deleted_at IS NULL
    ORDER BY created_at DESC`
  // Messages: the masked address only, never the raw recipient.
  bundle['message'] = await tenant.query`
    SELECT delivery_kind, delivery_channel, recipient_mask, subject, status, created_at
    FROM notification_delivery
    WHERE organization_id = ${tenant.organization_id} AND party_id = ${party_id}
    ORDER BY created_at DESC`
  bundle['consent'] = (await listConsent(tenant, { party_id })).map((one) => ({
    purpose_code: one.purpose_code,
    purpose_version: one.purpose_version,
    status: one.status,
    granted_at: one.granted_at,
    withdrawn_at: one.withdrawn_at,
  }))
  return JSON.parse(JSON.stringify(bundle)) as Record<string, unknown>
}

function countOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}

export async function fulfilPrivacyRequest(
  tenant: TenantContext,
  id: string,
  acting: { actor_id: Uuid; actor_label: string },
): Promise<{ privacy_request: PrivacyRequestView; bundle: Record<string, unknown> | null }> {
  const request = await lockRequest(tenant, id)
  if (!request.is_verified || !request.party_id) {
    throw new DomainError(
      'This request did not match the booking, so there is no player record to act on. Close it instead.',
      409,
    )
  }
  const demanded_by_label = `player via privacy page; fulfilled by ${acting.actor_label}`

  if (request.request_kind === 'access') {
    const bundle = await buildAccessBundle(tenant, request.party_id)
    const subject = await requestAccess(tenant, {
      party_id: request.party_id,
      demanded_by_label,
      demanded_by_actor_id: acting.actor_id,
    })
    const note =
      `Copy prepared with ${countOf(bundle['booking'])} booking, ${countOf(bundle['order'])} order, ` +
      `${countOf(bundle['invoice'])} invoice, and ${countOf(bundle['message'])} message record (addresses masked). ` +
      'Send it to the player at the email address on their booking; it is kept here for 30 days.'
    await tenant.query`
      UPDATE admin_privacy_request
      SET status = 'completed', completed_at = now(), data_subject_request_id = ${subject.data_subject_request_id},
          fulfilled_by_actor_id = ${acting.actor_id}, resolution_note = ${note},
          access_bundle = ${tenant.query.json(bundle as never)}
      WHERE organization_id = ${tenant.organization_id} AND admin_privacy_request_id = ${id}::uuid`
    const [view] = await selectRequest(tenant, id)
    return { privacy_request: view!, bundle }
  }

  // Erasure: count what must be kept, pseudonymize contact copies, then let the
  // consent pack redact the party and withdraw consent in its auditable row.
  const party_id = request.party_id
  const [kept] = await tenant.query<{ booking_count: number; invoice_count: number; order_count: number }[]>`
    SELECT (SELECT count(*)::int FROM booking WHERE organization_id = ${tenant.organization_id} AND party_id = ${party_id}) AS booking_count,
           (SELECT count(*)::int FROM invoice WHERE organization_id = ${tenant.organization_id} AND party_id = ${party_id}) AS invoice_count,
           (SELECT count(*)::int FROM sales_order WHERE organization_id = ${tenant.organization_id} AND buyer_party_id = ${party_id}) AS order_count`

  let contact_copy_count = 0
  if (
    (await hasTable(tenant, 'portal_booking')) &&
    (await hasColumn(tenant, 'portal_booking', ['contact_display_name', 'contact_email', 'contact_phone']))
  ) {
    const row = await tenant.query`
      UPDATE portal_booking
      SET contact_display_name = ${REDACTED_TEXT}, contact_email = ${REDACTED_EMAIL}, contact_phone = ${REDACTED_TEXT}
      WHERE organization_id = ${tenant.organization_id} AND party_id = ${party_id}
      RETURNING portal_booking_id`
    contact_copy_count += row.length
  }
  if (
    (await hasTable(tenant, 'program_registration')) &&
    (await hasColumn(tenant, 'program_registration', ['display_name', 'email_address', 'phone_number']))
  ) {
    const row = await tenant.query`
      UPDATE program_registration
      SET display_name = ${REDACTED_TEXT}, email_address = ${REDACTED_EMAIL}, phone_number = NULL
      WHERE organization_id = ${tenant.organization_id} AND party_id = ${party_id}
      RETURNING program_registration_id`
    contact_copy_count += row.length
  }

  const lawful_basis = 'financial record kept for accounting and tax; linked only to the redacted player profile'
  const retained_record = [
    { record_kind: 'booking', record_ref: `${kept?.booking_count ?? 0} row`, identifying_column: [], lawful_basis },
    { record_kind: 'invoice', record_ref: `${kept?.invoice_count ?? 0} row`, identifying_column: [], lawful_basis },
    { record_kind: 'sales_order', record_ref: `${kept?.order_count ?? 0} row`, identifying_column: [], lawful_basis },
    {
      record_kind: 'notification_delivery',
      record_ref: 'message log',
      identifying_column: ['recipient'],
      lawful_basis: 'delivery log; the notification pack clears recipient address about 90 days after delivery',
    },
  ]
  const subject = await requestErasure(tenant, {
    party_id,
    demanded_by_label,
    demanded_by_actor_id: acting.actor_id,
    retained_record,
  })

  const note =
    `Name, email, and phone removed from the player profile` +
    (contact_copy_count > 0 ? ` and from ${contact_copy_count} booking or registration contact copy` : '') +
    `. Kept without identity: ${kept?.booking_count ?? 0} booking, ${kept?.invoice_count ?? 0} invoice, and ` +
    `${kept?.order_count ?? 0} order record, because the venue must keep financial records. ` +
    'Message delivery logs keep the address until their 90-day retention clears it.'
  await tenant.query`
    UPDATE admin_privacy_request
    SET status = 'completed', completed_at = now(), data_subject_request_id = ${subject.data_subject_request_id},
        fulfilled_by_actor_id = ${acting.actor_id}, resolution_note = ${note}
    WHERE organization_id = ${tenant.organization_id} AND admin_privacy_request_id = ${id}::uuid`
  const [view] = await selectRequest(tenant, id)
  return { privacy_request: view!, bundle: null }
}

export async function closePrivacyRequest(
  tenant: TenantContext,
  id: string,
  acting: { actor_id: Uuid },
  reason: unknown,
): Promise<PrivacyRequestView> {
  await lockRequest(tenant, id)
  const text = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 500) : 'Closed by staff without changes.'
  await tenant.query`
    UPDATE admin_privacy_request
    SET status = 'closed', completed_at = now(), fulfilled_by_actor_id = ${acting.actor_id},
        resolution_note = ${text}, access_bundle = NULL
    WHERE organization_id = ${tenant.organization_id} AND admin_privacy_request_id = ${id}::uuid`
  const [view] = await selectRequest(tenant, id)
  return view!
}

export async function readAccessBundle(tenant: TenantContext, id: string): Promise<Record<string, unknown>> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new DomainError('privacy request not found', 404)
  const [row] = await tenant.query<{ access_bundle: Record<string, unknown> | null }[]>`
    SELECT access_bundle FROM admin_privacy_request
    WHERE organization_id = ${tenant.organization_id} AND admin_privacy_request_id = ${id}::uuid
      AND deleted_at IS NULL`
  if (!row) throw new DomainError('privacy request not found', 404)
  if (!row.access_bundle) {
    throw new DomainError('No prepared copy is available for this request. Copies are kept for 30 days.', 404)
  }
  return row.access_bundle
}
