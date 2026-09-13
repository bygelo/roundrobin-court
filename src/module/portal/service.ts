// Portal domain: a guest books a court from the public page and pays for it;
// staff take counter payments, refund, and cancel.
//
// Writes go through the packs: occupancy through @bygelo/roundrobin-booking
// (hold, confirm, cancel, sweepExpiredHold) and money through
// @bygelo/roundrobin-billing (invoice, recordPayment, postPayment,
// refundPayment). Pack tables are only READ here, inside the tenant
// transaction. Two writes are direct because the pack has no call for them —
// see FINDINGS: a policy-length hold expiry, and the guest party row.

import { randomUUID } from 'node:crypto'
import { DomainError, type TenantContext, type Uuid } from '@bygelo/roundrobin-kernel'
import { BookingConflictError, cancel, confirm, hold, sweepExpiredHold } from '@bygelo/roundrobin-booking'
import { addLine, createInvoice, openInvoice, postPayment, recordPayment, refundPayment } from '@bygelo/roundrobin-billing'
import { DEFAULT_BOOKING_POLICY, readBookingPolicy, type BookingPolicy } from '../court/policy.ts'
import { consumeEntitlement, quoteMemberPrice } from '../member/contract.ts'
import { notifyPlayer as notifyPlayerContract, type NotifyPlayerInput } from '../message/contract.ts'
import { emitWebhook as emitWebhookContract, type EmitWebhookInput } from '../webhook/contract.ts'

// Messages and webhooks are best-effort by contract, but "never throws" is not
// "never aborts the transaction": a failed statement inside either one poisons
// the booking's transaction, and the guest gets a 500 for a court they held.
// A savepoint confines any such failure to the side effect itself.
//
// The side effect must run on the SAVEPOINT's query tag, not the outer one.
// postgres.js records the first failed query of a transaction scope and
// rethrows it when that scope ends — even if the caller caught it — so a
// contract that swallows its own SQL error on tenant.query still fails the
// whole request. Handing the contract a tenant whose query is the savepoint tag
// scopes that record to the savepoint, which then rolls back to itself.
async function isolateSideEffect(tenant: TenantContext, work: (scoped: TenantContext) => Promise<unknown>): Promise<void> {
  try {
    await tenant.query.savepoint((sp) => work({ ...tenant, query: sp as unknown as TenantContext['query'] }))
  } catch {
    // Rolled back to the savepoint; the booking proceeds without the side effect.
  }
}

async function notifyPlayer(tenant: TenantContext, input: NotifyPlayerInput): Promise<void> {
  await isolateSideEffect(tenant, (scoped) => notifyPlayerContract(scoped, input))
}

async function emitWebhook(tenant: TenantContext, input: EmitWebhookInput): Promise<void> {
  await isolateSideEffect(tenant, (scoped) => emitWebhookContract(scoped, input))
}
import { PaymentCallbackRefusedError, getOnlinePayment } from './payment.ts'
import {
  DEFAULT_TIME_ZONE,
  balanceAmount,
  bookingWindow,
  cancellationCutoffAt,
  createRecoveryToken,
  dayWindow,
  decideGuestCancel,
  findServerOwnedField,
  formatVenueDateTime,
  fromCent,
  hashRecoveryToken,
  isDateText,
  paidAmount,
  parseAmount,
  paymentState,
  toCent,
  validateContact,
  windowEndAt,
  type Contact,
  type PaymentState,
} from './rule.ts'

export class PortalError extends DomainError {}

/** A refusal about the guest's typed input, carrying a sentence per field. */
export class PortalInputError extends DomainError {
  readonly problem: Record<string, string>
  constructor(message: string, problem: Record<string, string>) {
    super(message, 400)
    this.problem = problem
  }
}

export const TAKEN_SENTENCE = 'That court was just booked by someone else. Pick another time.'

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const DEFAULT_COUNTER_INSTRUCTION =
  'Your court is reserved. Pay at the front desk when you arrive — cash, GCash, or card.'

const BOOKING_STATUS = new Set(['hold', 'confirmed', 'cancelled', 'expired'])

export const COUNTER_METHOD = ['cash', 'gcash', 'card_terminal'] as const
export type CounterMethod = (typeof COUNTER_METHOD)[number]

function sqlState(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined
}

export function isSlotTaken(error: unknown): boolean {
  return error instanceof BookingConflictError || sqlState(error) === '23P01'
}

// ---------------------------------------------------------------------------
// venue context
// ---------------------------------------------------------------------------

/**
 * The venue's booking policy. Falls back to the defaults only when the venue
 * lane's table is not migrated yet, inside a savepoint so the transaction
 * survives the missing-table error.
 */
export async function readPolicy(tenant: TenantContext): Promise<BookingPolicy> {
  try {
    return await tenant.query.savepoint(() => readBookingPolicy(tenant))
  } catch (error) {
    if (sqlState(error) === '42P01') return { ...DEFAULT_BOOKING_POLICY }
    throw error
  }
}

export async function readTimeZone(tenant: TenantContext): Promise<string> {
  const [row] = await tenant.query<{ time_zone: string }[]>`
    SELECT time_zone FROM site
    WHERE organization_id = ${tenant.organization_id} AND deleted_at IS NULL AND time_zone IS NOT NULL
    ORDER BY created_at LIMIT 1`
  if (!row) return DEFAULT_TIME_ZONE
  try {
    new Intl.DateTimeFormat('en-PH', { timeZone: row.time_zone })
    return row.time_zone
  } catch {
    return DEFAULT_TIME_ZONE
  }
}

export type PortalSetting = { is_counter_payment_allowed: boolean; counter_instruction: string }

export async function readSetting(tenant: TenantContext): Promise<PortalSetting> {
  const [row] = await tenant.query<{ is_counter_payment_allowed: boolean; counter_instruction: string | null }[]>`
    SELECT is_counter_payment_allowed, counter_instruction FROM portal_setting
    WHERE organization_id = ${tenant.organization_id}`
  return {
    is_counter_payment_allowed: row?.is_counter_payment_allowed ?? true,
    counter_instruction: row?.counter_instruction?.trim() || DEFAULT_COUNTER_INSTRUCTION,
  }
}

export async function saveSetting(tenant: TenantContext, body: Record<string, unknown>): Promise<PortalSetting> {
  const is_counter_payment_allowed = body['is_counter_payment_allowed']
  if (typeof is_counter_payment_allowed !== 'boolean') {
    throw new PortalError('Say whether guests may pay at the counter (is_counter_payment_allowed true or false).', 400)
  }
  const instruction = typeof body['counter_instruction'] === 'string' ? body['counter_instruction'].trim() : ''
  if (instruction.length > 500) throw new PortalError('Keep the counter instruction under 500 characters.', 400)
  await tenant.query`
    INSERT INTO portal_setting (organization_id, is_counter_payment_allowed, counter_instruction)
    VALUES (${tenant.organization_id}, ${is_counter_payment_allowed}, ${instruction || null})
    ON CONFLICT (organization_id) DO UPDATE
      SET is_counter_payment_allowed = EXCLUDED.is_counter_payment_allowed,
          counter_instruction = EXCLUDED.counter_instruction`
  return readSetting(tenant)
}

// ---------------------------------------------------------------------------
// availability
// ---------------------------------------------------------------------------

export type AvailabilitySlot = {
  session_id: Uuid
  resource_id: Uuid
  starts_at: Date
  ends_at: Date
  price_amount: string
  is_available: boolean
}

export type AvailabilityCourt = { resource_id: Uuid; resource_code: string; display_name: string; sport_code: string | null }

export type Availability = {
  date: string
  time_zone: string
  first_date: string
  last_date: string
  is_inside_window: boolean
  sport: { sport_code: string; display_name: string }[]
  court: AvailabilityCourt[]
  slot: AvailabilitySlot[]
  cancellation_cutoff_hour_count: number
  is_guest_booking_allowed: boolean
  is_counter_payment_allowed: boolean
  online_payment_label: string
}

export async function readAvailability(
  tenant: TenantContext,
  input: { date?: string | undefined; sport_code?: string | undefined },
): Promise<Availability> {
  // Lazily release lapsed holds before anyone reads the grid. The pack's UPDATE
  // is guarded on status = 'hold', so concurrent sweeps release each hold once.
  await sweepExpiredHold(tenant)

  const policy = await readPolicy(tenant)
  const time_zone = await readTimeZone(tenant)
  const setting = await readSetting(tenant)
  const now = new Date()
  const window = bookingWindow(now, policy.advance_window_day_count, time_zone)

  if (input.date !== undefined && input.date !== '' && !isDateText(input.date)) {
    throw new PortalError('Pick a date written as YYYY-MM-DD.', 400)
  }
  const date = input.date || window.first_date
  const is_inside_window = date >= window.first_date && date <= window.last_date
  const sport_code = input.sport_code?.trim() || undefined

  const sport = await tenant.query<{ sport_code: string; display_name: string }[]>`
    SELECT DISTINCT rc.resource_category_code AS sport_code, rc.display_name
    FROM resource_category rc
    JOIN resource_category_link rcl ON rcl.resource_category_id = rc.resource_category_id
    JOIN resource r ON r.resource_id = rcl.resource_id
    WHERE rc.organization_id = ${tenant.organization_id}
      AND r.organization_id = ${tenant.organization_id}
      AND r.deleted_at IS NULL AND r.is_bookable
    ORDER BY rc.display_name`

  let row: (AvailabilitySlot & { resource_code: string; display_name: string; sport_code: string | null })[] = []
  if (is_inside_window) {
    const day = dayWindow(date, time_zone)
    row = [
      ...(await tenant.query<(AvailabilitySlot & { resource_code: string; display_name: string; sport_code: string | null })[]>`
        SELECT s.session_id, r.resource_id, r.resource_code, r.display_name,
               s.starts_at, s.ends_at, s.price_amount::text AS price_amount,
               (SELECT rc.resource_category_code
                  FROM resource_category_link rcl
                  JOIN resource_category rc ON rc.resource_category_id = rcl.resource_category_id
                 WHERE rcl.resource_id = r.resource_id
                 ORDER BY rc.resource_category_code LIMIT 1) AS sport_code,
               (s.starts_at > now()
                AND NOT EXISTS (
                  SELECT 1 FROM booking b
                  WHERE b.organization_id = ${tenant.organization_id}
                    AND b.resource_id = r.resource_id
                    AND b.status IN ('hold', 'confirmed')
                    AND b.starts_at < s.ends_at AND b.ends_at > s.starts_at)
                AND NOT EXISTS (
                  SELECT 1 FROM closure c
                  WHERE c.organization_id = ${tenant.organization_id}
                    AND (c.resource_id = r.resource_id OR c.site_id = s.site_id)
                    AND c.starts_at < s.ends_at AND c.ends_at > s.starts_at)) AS is_available
        FROM session s
        JOIN session_resource sr ON sr.session_id = s.session_id
        JOIN resource r ON r.resource_id = sr.resource_id
        WHERE s.organization_id = ${tenant.organization_id}
          AND r.organization_id = ${tenant.organization_id}
          AND s.deleted_at IS NULL AND s.is_published AND s.session_type = 'private'
          AND r.deleted_at IS NULL AND r.is_bookable
          AND s.starts_at >= ${day.starts_at} AND s.starts_at < ${day.ends_at}
          ${
            sport_code
              ? tenant.query`AND EXISTS (
                  SELECT 1 FROM resource_category_link rcl
                  JOIN resource_category rc ON rc.resource_category_id = rcl.resource_category_id
                  WHERE rcl.resource_id = r.resource_id AND rc.resource_category_code = ${sport_code})`
              : tenant.query``
          }
        ORDER BY s.starts_at, r.sort_order, r.display_name`),
    ]
  }

  const court = new Map<string, AvailabilityCourt>()
  for (const one of row) {
    if (!court.has(one.resource_id)) {
      court.set(one.resource_id, {
        resource_id: one.resource_id,
        resource_code: one.resource_code,
        display_name: one.display_name,
        sport_code: one.sport_code,
      })
    }
  }

  return {
    date,
    time_zone,
    first_date: window.first_date,
    last_date: window.last_date,
    is_inside_window,
    sport: [...sport],
    court: [...court.values()],
    slot: row.map((one) => ({
      session_id: one.session_id,
      resource_id: one.resource_id,
      starts_at: one.starts_at,
      ends_at: one.ends_at,
      price_amount: one.price_amount,
      is_available: one.is_available,
    })),
    cancellation_cutoff_hour_count: policy.cancellation_cutoff_hour_count,
    is_guest_booking_allowed: policy.is_guest_booking_allowed,
    is_counter_payment_allowed: setting.is_counter_payment_allowed,
    online_payment_label: getOnlinePayment().label,
  }
}

// ---------------------------------------------------------------------------
// reading one booking
// ---------------------------------------------------------------------------

type BookingRow = {
  booking_id: Uuid
  booking_code: string
  status: string
  starts_at: Date
  ends_at: Date
  hold_expire_at: Date | null
  participant_count: number
  price_amount: string
  court_name: string
  sport_code: string | null
  booking_party_id: Uuid | null
  party_display_name: string | null
  portal_booking_id: Uuid | null
  portal_party_id: Uuid | null
  contact_display_name: string | null
  contact_email: string | null
  contact_phone: string | null
  total_amount: string | null
  entitlement_code: string | null
  cancellation_cutoff_at: Date | null
  is_pay_at_counter: boolean | null
  online_checkout_url: string | null
  posted_amount: string
  pending_amount: string
  refunded_amount: string
  payment_method: string | null
}

async function selectBooking(
  tenant: TenantContext,
  filter: { booking_code?: string; starts_from?: Date; starts_before?: Date; status?: string },
): Promise<BookingRow[]> {
  const q = tenant.query
  const row = await q<BookingRow[]>`
    SELECT b.booking_id, b.booking_code, b.status::text AS status, b.starts_at, b.ends_at, b.hold_expire_at,
           b.participant_count, b.price_amount::text AS price_amount,
           r.display_name AS court_name,
           (SELECT rc.resource_category_code
              FROM resource_category_link rcl
              JOIN resource_category rc ON rc.resource_category_id = rcl.resource_category_id
             WHERE rcl.resource_id = r.resource_id
             ORDER BY rc.resource_category_code LIMIT 1) AS sport_code,
           b.party_id AS booking_party_id, pa.display_name AS party_display_name,
           pb.portal_booking_id, pb.party_id AS portal_party_id,
           pb.contact_display_name, pb.contact_email, pb.contact_phone,
           pb.total_amount::text AS total_amount, pb.entitlement_code, pb.cancellation_cutoff_at,
           pb.is_pay_at_counter, pb.online_checkout_url,
           coalesce(pay.posted_amount, 0)::numeric(14,2)::text AS posted_amount,
           coalesce(pay.pending_amount, 0)::numeric(14,2)::text AS pending_amount,
           coalesce(ref.refunded_amount, 0)::numeric(14,2)::text AS refunded_amount,
           pay.payment_method
    FROM booking b
    JOIN resource r ON r.resource_id = b.resource_id
    LEFT JOIN party pa ON pa.party_id = b.party_id
    LEFT JOIN portal_booking pb ON pb.booking_id = b.booking_id AND pb.deleted_at IS NULL
    LEFT JOIN LATERAL (
      SELECT sum(p.amount) FILTER (WHERE p.status IN ('posted', 'refunded')) AS posted_amount,
             sum(p.amount) FILTER (WHERE p.status = 'pending') AS pending_amount,
             string_agg(DISTINCT pp.method_code, ',') FILTER (WHERE p.status IN ('posted', 'refunded')) AS payment_method
      FROM portal_payment pp
      JOIN payment p ON p.payment_id = pp.payment_id
      WHERE pp.portal_booking_id = pb.portal_booking_id
    ) pay ON true
    LEFT JOIN LATERAL (
      SELECT sum(rf.amount) AS refunded_amount
      FROM portal_payment pp
      JOIN refund rf ON rf.payment_id = pp.payment_id
      WHERE pp.portal_booking_id = pb.portal_booking_id
    ) ref ON true
    WHERE b.organization_id = ${tenant.organization_id}
      ${filter.booking_code !== undefined ? q`AND b.booking_code = ${filter.booking_code}` : q``}
      ${filter.starts_from ? q`AND b.starts_at >= ${filter.starts_from}` : q``}
      ${filter.starts_before ? q`AND b.starts_at < ${filter.starts_before}` : q``}
      ${filter.status ? q`AND b.status = ${filter.status}::booking_status` : q``}
    ORDER BY b.starts_at, r.sort_order, r.display_name
    LIMIT 500`
  return [...row]
}

export type BookingView = {
  booking_code: string
  status: string
  court_name: string
  sport_code: string | null
  starts_at: Date
  ends_at: Date
  participant_count: number
  hold_expires_at: Date | null
  total_amount: string
  paid_amount: string
  balance_amount: string
  refunded_amount: string
  payment_state: PaymentState
  payment_method: string[]
  cancellation_cutoff_at: Date | null
  is_pay_at_counter: boolean
  is_portal_booking: boolean
  is_cancellable: boolean
  cancel_refusal: string | null
  is_payable_online: boolean
  checkout_url: string | null
  contact: { display_name: string; email: string | null; phone: string | null }
}

function toView(row: BookingRow, time_zone: string, now: Date): BookingView {
  const figure = {
    total_amount: row.total_amount ?? row.price_amount,
    posted_amount: row.posted_amount,
    pending_amount: row.pending_amount,
    refunded_amount: row.refunded_amount,
  }
  const state = paymentState(figure)
  const is_active = row.status === 'hold' || row.status === 'confirmed'
  const decision = row.cancellation_cutoff_at
    ? decideGuestCancel({ status: row.status, cancellation_cutoff_at: row.cancellation_cutoff_at, now, time_zone })
    : ({ is_cancellable: false, reason: 'This booking was made at the venue. Please contact the front desk.' } as const)
  return {
    booking_code: row.booking_code,
    status: row.status,
    court_name: row.court_name,
    sport_code: row.sport_code,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    participant_count: Number(row.participant_count),
    hold_expires_at: row.status === 'hold' ? row.hold_expire_at : null,
    total_amount: figure.total_amount,
    paid_amount: paidAmount(figure),
    balance_amount: balanceAmount(figure),
    refunded_amount: row.refunded_amount,
    payment_state: state,
    payment_method: row.payment_method ? row.payment_method.split(',') : [],
    cancellation_cutoff_at: row.cancellation_cutoff_at,
    is_pay_at_counter: row.is_pay_at_counter ?? false,
    is_portal_booking: row.portal_booking_id !== null,
    is_cancellable: decision.is_cancellable,
    cancel_refusal: decision.is_cancellable ? null : decision.reason,
    is_payable_online: row.portal_booking_id !== null && is_active && (state === 'unpaid' || state === 'pending'),
    checkout_url: state === 'pending' ? row.online_checkout_url : null,
    contact: {
      display_name: row.contact_display_name ?? row.party_display_name ?? 'Walk-in guest',
      email: row.contact_email,
      phone: row.contact_phone,
    },
  }
}

async function viewByCode(tenant: TenantContext, booking_code: string): Promise<BookingView> {
  const [row] = await selectBooking(tenant, { booking_code })
  if (!row) throw new PortalError('That booking does not exist.', 404)
  return toView(row, await readTimeZone(tenant), new Date())
}

/** Lock the guest record for a booking so concurrent pay/cancel calls serialize. */
async function lockPortalBooking(
  tenant: TenantContext,
  booking_code: string,
  recovery_token?: string,
): Promise<{ portal_booking_id: Uuid; party_id: Uuid } | undefined> {
  const q = tenant.query
  const [row] = await q<{ portal_booking_id: Uuid; party_id: Uuid }[]>`
    SELECT pb.portal_booking_id, pb.party_id
    FROM portal_booking pb
    JOIN booking b ON b.booking_id = pb.booking_id
    WHERE pb.organization_id = ${tenant.organization_id}
      AND pb.deleted_at IS NULL
      AND b.booking_code = ${booking_code}
      ${recovery_token !== undefined ? q`AND pb.recovery_token_hash = ${hashRecoveryToken(recovery_token)}` : q``}
    FOR UPDATE OF pb`
  return row
}

function readToken(value: unknown): string {
  return typeof value === 'string' && value.length >= 16 && value.length <= 64 ? value : ''
}

// ---------------------------------------------------------------------------
// side effects shared by every path
// ---------------------------------------------------------------------------

function messageDetail(view: BookingView, time_zone: string): Record<string, string> {
  return {
    booking_code: view.booking_code,
    court: view.court_name,
    starts_at: formatVenueDateTime(new Date(view.starts_at), time_zone),
    total_amount: view.total_amount,
    player: view.contact.display_name,
  }
}

function recipient(view: BookingView): { recipient_email?: string; recipient_phone?: string } {
  const out: { recipient_email?: string; recipient_phone?: string } = {}
  if (view.contact.email) out.recipient_email = view.contact.email
  if (view.contact.phone) out.recipient_phone = view.contact.phone
  return out
}

async function afterConfirm(tenant: TenantContext, booking_code: string): Promise<void> {
  const [row] = await selectBooking(tenant, { booking_code })
  if (!row) return
  const time_zone = await readTimeZone(tenant)
  const view = toView(row, time_zone, new Date())
  if (row.entitlement_code && row.portal_party_id) {
    await consumeEntitlement(tenant, { party_id: row.portal_party_id, entitlement_code: row.entitlement_code, subject_code: booking_code })
  }
  await notifyPlayer(tenant, {
    message_kind: 'booking_confirmed',
    ...(row.portal_party_id ? { party_id: row.portal_party_id } : {}),
    ...recipient(view),
    subject_code: booking_code,
    detail: messageDetail(view, time_zone),
  })
  await emitWebhook(tenant, {
    event_code: 'booking.confirmed',
    subject_code: booking_code,
    payload: { booking_code, court_name: view.court_name, starts_at: view.starts_at, ends_at: view.ends_at, total_amount: view.total_amount },
  })
}

async function afterPayment(tenant: TenantContext, booking_code: string, payment: { payment_code: string; amount: string; method_code: string }): Promise<void> {
  const [row] = await selectBooking(tenant, { booking_code })
  if (!row) return
  const time_zone = await readTimeZone(tenant)
  const view = toView(row, time_zone, new Date())
  await notifyPlayer(tenant, {
    message_kind: 'booking_receipt',
    ...(row.portal_party_id ? { party_id: row.portal_party_id } : {}),
    ...recipient(view),
    subject_code: `${booking_code}:${payment.payment_code}`,
    detail: { ...messageDetail(view, time_zone), paid_amount: payment.amount, method: payment.method_code },
  })
  await emitWebhook(tenant, {
    event_code: 'payment.recorded',
    subject_code: payment.payment_code,
    payload: { booking_code, payment_code: payment.payment_code, amount: payment.amount, method_code: payment.method_code },
  })
}

async function afterCancel(tenant: TenantContext, booking_code: string, cancelled_by: 'guest' | 'venue'): Promise<void> {
  const [row] = await selectBooking(tenant, { booking_code })
  if (!row) return
  const time_zone = await readTimeZone(tenant)
  const view = toView(row, time_zone, new Date())
  await notifyPlayer(tenant, {
    message_kind: 'booking_cancelled',
    ...(row.portal_party_id ? { party_id: row.portal_party_id } : {}),
    ...recipient(view),
    subject_code: booking_code,
    detail: { ...messageDetail(view, time_zone), cancelled_by, paid_amount: view.paid_amount },
  })
  await emitWebhook(tenant, {
    event_code: 'booking.cancelled',
    subject_code: booking_code,
    payload: { booking_code, cancelled_by, paid_amount: view.paid_amount },
  })
}

async function confirmIfHeld(tenant: TenantContext, booking_code: string): Promise<boolean> {
  const [row] = await tenant.query<{ status: string }[]>`
    SELECT status::text AS status FROM booking
    WHERE organization_id = ${tenant.organization_id} AND booking_code = ${booking_code}`
  if (row?.status !== 'hold') return false
  await confirm(tenant, booking_code)
  await afterConfirm(tenant, booking_code)
  return true
}

/** The words the staff court board shows for a booking's money. */
export function paidStateLabel(view: Pick<BookingView, 'payment_state' | 'payment_method' | 'is_pay_at_counter'>): string {
  switch (view.payment_state) {
    case 'paid':
      return view.payment_method.length > 0 && view.payment_method.every((one) => one === 'online') ? 'Paid online' : 'Paid at the counter'
    case 'partial':
      return 'Part paid'
    case 'pending':
      return 'Checkout pending'
    case 'partially_refunded':
      return 'Part refunded'
    case 'refunded':
      return 'Refunded'
    case 'not_required':
      return 'Nothing due'
    default:
      return view.is_pay_at_counter ? 'Pay at the counter' : 'Unpaid'
  }
}

/**
 * Mirror the invoice and paid state onto booking.detail, which is where the
 * court board reads them. The object goes in through query.json(), so it is
 * stored as a jsonb object, never as a jsonb string.
 */
async function syncBookingDetail(tenant: TenantContext, booking_code: string): Promise<void> {
  const [row] = await selectBooking(tenant, { booking_code })
  if (!row?.portal_booking_id) return
  const view = toView(row, DEFAULT_TIME_ZONE, new Date())
  const [link] = await tenant.query<{ invoice_id: Uuid | null }[]>`
    SELECT invoice_id FROM portal_booking
    WHERE portal_booking_id = ${row.portal_booking_id} AND organization_id = ${tenant.organization_id}`
  const patch: Record<string, string> = { paid_state: paidStateLabel(view) }
  if (link?.invoice_id) patch['invoice_id'] = link.invoice_id
  await tenant.query`
    UPDATE booking SET detail = coalesce(detail, '{}'::jsonb) || ${tenant.query.json(patch)}::jsonb
    WHERE organization_id = ${tenant.organization_id} AND booking_code = ${booking_code}`
}

function statusRefusal(status: string): string {
  if (status === 'expired') return 'Your hold expired before payment, so nothing was charged. Pick the slot again.'
  if (status === 'cancelled') return 'This booking is cancelled, so there is nothing to pay.'
  return 'This booking cannot take a payment right now.'
}

// ---------------------------------------------------------------------------
// guest: book
// ---------------------------------------------------------------------------

export type CreatedBooking = {
  booking_code: string
  recovery_token: string
  status: string
  court_name: string
  starts_at: Date
  ends_at: Date
  hold_expires_at: Date | null
  base_amount: string
  total_amount: string
  cancellation_cutoff_at: Date
  price_note: string | null
}

export async function createPortalBooking(tenant: TenantContext, body: Record<string, unknown>): Promise<CreatedBooking> {
  const forbidden = findServerOwnedField(body)
  if (forbidden) throw new PortalError(`Price and time are set by the venue, so "${forbidden}" cannot be sent.`, 400)

  const session_id = typeof body['session_id'] === 'string' ? body['session_id'] : ''
  const resource_id = typeof body['resource_id'] === 'string' ? body['resource_id'] : ''
  if (!UUID_SHAPE.test(session_id) || !UUID_SHAPE.test(resource_id)) {
    throw new PortalError('Pick a court and a time first.', 400)
  }

  const { contact, problem } = validateContact(body['contact'])
  if (!contact) throw new PortalInputError(Object.values(problem)[0] ?? 'Check your contact details.', problem)

  const participant_raw = body['participant_count'] ?? 1
  const participant_count = typeof participant_raw === 'number' ? participant_raw : Number(participant_raw)
  if (!Number.isInteger(participant_count) || participant_count < 1) {
    throw new PortalInputError('Enter how many players are coming.', { participant_count: 'Enter how many players are coming.' })
  }

  const policy = await readPolicy(tenant)
  const time_zone = await readTimeZone(tenant)
  const now = new Date()

  const [session] = await tenant.query<
    { starts_at: Date; ends_at: Date; price_amount: string; capacity_count: number; court_name: string }[]
  >`
    SELECT s.starts_at, s.ends_at, s.price_amount::text AS price_amount, s.capacity_count, r.display_name AS court_name
    FROM session s
    JOIN session_resource sr ON sr.session_id = s.session_id AND sr.resource_id = ${resource_id}
    JOIN resource r ON r.resource_id = sr.resource_id
    WHERE s.organization_id = ${tenant.organization_id}
      AND r.organization_id = ${tenant.organization_id}
      AND s.session_id = ${session_id}
      AND s.deleted_at IS NULL AND s.is_published AND s.session_type = 'private'
      AND r.deleted_at IS NULL AND r.is_bookable`
  if (!session) throw new PortalError('That court and time is not offered. Pick another slot.', 404)
  if (session.starts_at.getTime() <= now.getTime()) {
    throw new PortalError('That time has already started. Pick a later slot.', 409)
  }
  if (session.starts_at.getTime() >= windowEndAt(now, policy.advance_window_day_count, time_zone).getTime()) {
    throw new PortalError(
      `Bookings open ${policy.advance_window_day_count} days ahead. Pick a date on or before ${bookingWindow(now, policy.advance_window_day_count, time_zone).last_date}.`,
      409,
    )
  }
  if (participant_count > Number(session.capacity_count)) {
    const sentence = `This court takes up to ${session.capacity_count} players.`
    throw new PortalInputError(sentence, { participant_count: sentence })
  }

  const party_id = await findOrCreateParty(tenant, contact, policy.is_guest_booking_allowed)

  const quote = await quoteMemberPrice(tenant, { party_id, session_id, base_amount: session.price_amount })
  if (!quote.is_eligible) {
    throw new PortalError(quote.reason ?? 'This slot is reserved for members with a matching plan.', 403)
  }
  const total_cent = toCent(quote.price_amount)
  const base_cent = toCent(session.price_amount)
  if (total_cent < 0) throw new PortalError('The quoted price is not valid.', 409)

  let booking
  try {
    booking = await hold(tenant, { session_id, resource_id, party_id, participant_count, session_type: 'private' })
  } catch (error) {
    if (isSlotTaken(error)) throw new PortalError(TAKEN_SENTENCE, 409)
    throw error
  }

  // The pack's hold() fixes a 10-minute expiry and accepts no duration, so the
  // policy's hold_minute_count is not applied here. Reported as an OS gap rather
  // than overwritten with SQL behind the pack's back.

  const cancellation_cutoff_at = cancellationCutoffAt(session.starts_at, policy.cancellation_cutoff_hour_count)
  const description = `${session.court_name} · ${formatVenueDateTime(session.starts_at, time_zone)}`

  let invoice_id: Uuid | null = null
  if (total_cent > 0) {
    const invoice = await createInvoice(tenant, {
      party_id,
      invoice_code: `bk-${booking.booking_code}`,
      due_at: session.starts_at,
      note: `Court booking ${booking.booking_code}`,
    })
    await addLine(tenant, { invoice_id: invoice.invoice_id, description, unit_amount: total_cent / 100 })
    await openInvoice(tenant, invoice.invoice_id)
    invoice_id = invoice.invoice_id
  }

  const recovery_token = createRecoveryToken()
  await tenant.query`
    INSERT INTO portal_booking (organization_id, booking_id, party_id, invoice_id, recovery_token_hash,
                                contact_display_name, contact_email, contact_phone,
                                base_amount, total_amount, entitlement_code, cancellation_cutoff_at)
    VALUES (${tenant.organization_id}, ${booking.booking_id}, ${party_id}, ${invoice_id}, ${hashRecoveryToken(recovery_token)},
            ${contact.display_name}, ${contact.email}, ${contact.phone},
            ${fromCent(base_cent)}, ${fromCent(total_cent)}, ${quote.entitlement_code}, ${cancellation_cutoff_at})`

  await emitWebhook(tenant, {
    event_code: 'booking.held',
    subject_code: booking.booking_code,
    payload: {
      booking_code: booking.booking_code,
      court_name: session.court_name,
      starts_at: session.starts_at,
      ends_at: session.ends_at,
      hold_expires_at: booking.hold_expire_at,
      total_amount: fromCent(total_cent),
    },
  })

  await syncBookingDetail(tenant, booking.booking_code)

  let status = 'hold'
  if (total_cent === 0) {
    // Nothing to collect (a member entitlement covered it): confirm now.
    await confirmIfHeld(tenant, booking.booking_code)
    status = 'confirmed'
  }

  return {
    booking_code: booking.booking_code,
    recovery_token,
    status,
    court_name: session.court_name,
    starts_at: session.starts_at,
    ends_at: session.ends_at,
    hold_expires_at: status === 'hold' ? booking.hold_expire_at : null,
    base_amount: fromCent(base_cent),
    total_amount: fromCent(total_cent),
    cancellation_cutoff_at,
    price_note: quote.reason,
  }
}

async function findOrCreateParty(tenant: TenantContext, contact: Contact, is_guest_booking_allowed: boolean): Promise<Uuid> {
  // Serialize per email so two checkouts by one guest do not mint two parties.
  await tenant.query`SELECT pg_advisory_xact_lock(hashtextextended(${`portal-party:${tenant.organization_id}:${contact.email}`}, 0))`
  const [existing] = await tenant.query<{ party_id: Uuid }[]>`
    SELECT party_id FROM party
    WHERE organization_id = ${tenant.organization_id}
      AND lower(email_address) = ${contact.email}
      AND deleted_at IS NULL AND merged_into_party_id IS NULL
    ORDER BY created_at LIMIT 1`
  if (existing) return existing.party_id
  if (!is_guest_booking_allowed) {
    throw new PortalError(
      'This venue takes online bookings from registered players only. Ask the front desk to add you, then book with the same email.',
      403,
    )
  }
  const [created] = await tenant.query<{ party_id: Uuid }[]>`
    INSERT INTO party (organization_id, display_name, email_address, phone_number, detail)
    VALUES (${tenant.organization_id}, ${contact.display_name}, ${contact.email}, ${contact.phone},
            ${tenant.query.json({ source: 'portal' })}::jsonb)
    RETURNING party_id`
  return created!.party_id
}

// ---------------------------------------------------------------------------
// guest: recover, pay, cancel
// ---------------------------------------------------------------------------

export async function readRecovery(tenant: TenantContext, booking_code: string, token: unknown): Promise<{ booking: BookingView; counter_instruction: string }> {
  const recovery_token = readToken(token)
  if (!recovery_token) throw new PortalNotFound()
  await sweepExpiredHold(tenant)
  const [row] = await tenant.query<{ portal_booking_id: Uuid }[]>`
    SELECT pb.portal_booking_id FROM portal_booking pb
    JOIN booking b ON b.booking_id = pb.booking_id
    WHERE pb.organization_id = ${tenant.organization_id} AND pb.deleted_at IS NULL
      AND b.booking_code = ${booking_code} AND pb.recovery_token_hash = ${hashRecoveryToken(recovery_token)}`
  if (!row) throw new PortalNotFound()
  return { booking: await viewByCode(tenant, booking_code), counter_instruction: (await readSetting(tenant)).counter_instruction }
}

/** Thrown when a guest names a booking they cannot prove they hold. The route answers 404. */
export class PortalNotFound extends Error {}

export type PayResult = {
  booking: BookingView
  is_replay: boolean
  checkout_url: string | null
  instruction: string | null
}

export async function payBooking(
  tenant: TenantContext,
  booking_code: string,
  body: Record<string, unknown>,
  option: { return_url: string },
): Promise<PayResult> {
  const recovery_token = readToken(body['recovery_token'])
  if (!recovery_token) throw new PortalNotFound()
  const method = body['method']
  if (method !== 'online' && method !== 'counter') {
    throw new PortalError('Choose "Pay online now" or "Pay at the counter".', 400)
  }

  await sweepExpiredHold(tenant)
  const locked = await lockPortalBooking(tenant, booking_code, recovery_token)
  if (!locked) throw new PortalNotFound()

  const [row] = await selectBooking(tenant, { booking_code })
  if (!row) throw new PortalNotFound()

  if (method === 'counter') {
    if (row.status !== 'hold' && row.status !== 'confirmed') throw new PortalError(statusRefusal(row.status), 409)
    const setting = await readSetting(tenant)
    const time_zone = await readTimeZone(tenant)
    if (row.status === 'hold' && !setting.is_counter_payment_allowed) {
      const until = row.hold_expire_at ? formatVenueDateTime(row.hold_expire_at, time_zone) : 'your hold ends'
      return {
        booking: await viewByCode(tenant, booking_code),
        is_replay: false,
        checkout_url: null,
        instruction: `This venue confirms a court only once it is paid. Your court stays held until ${until} — pay online, or pay at the front desk before then.`,
      }
    }
    await tenant.query`
      UPDATE portal_booking SET is_pay_at_counter = true
      WHERE portal_booking_id = ${locked.portal_booking_id} AND organization_id = ${tenant.organization_id}`
    await confirmIfHeld(tenant, booking_code)
    await syncBookingDetail(tenant, booking_code)
    return { booking: await viewByCode(tenant, booking_code), is_replay: false, checkout_url: null, instruction: setting.counter_instruction }
  }

  // ---- online ----
  const [prior] = await tenant.query<{ payment_id: Uuid; status: string }[]>`
    SELECT p.payment_id, p.status::text AS status
    FROM portal_payment pp JOIN payment p ON p.payment_id = pp.payment_id
    WHERE pp.portal_booking_id = ${locked.portal_booking_id} AND pp.payment_kind_code = 'online'`
  if (prior) {
    // A second click, a retry, or a replay: never a second charge.
    if (prior.status === 'posted') await confirmIfHeld(tenant, booking_code).catch(() => false)
    const view = await viewByCode(tenant, booking_code)
    return { booking: view, is_replay: true, checkout_url: view.checkout_url, instruction: null }
  }

  if (row.status !== 'hold' && row.status !== 'confirmed') throw new PortalError(statusRefusal(row.status), 409)
  const view = toView(row, await readTimeZone(tenant), new Date())
  const balance_cent = toCent(view.balance_amount)
  if (balance_cent <= 0) {
    await confirmIfHeld(tenant, booking_code)
    return { booking: await viewByCode(tenant, booking_code), is_replay: true, checkout_url: null, instruction: null }
  }

  const adapter = getOnlinePayment()
  const idempotency_key = `portal:${booking_code}:online`
  const charge = await adapter.charge({
    booking_code,
    amount: fromCent(balance_cent),
    currency_code: 'PHP',
    idempotency_key,
    description: `${row.court_name} court booking ${booking_code}`,
    contact: {
      display_name: row.contact_display_name ?? '',
      email: row.contact_email ?? '',
      phone: row.contact_phone ?? '',
    },
    return_url: option.return_url,
  })

  const payment = await recordPayment(tenant, {
    party_id: locked.party_id,
    amount: balance_cent / 100,
    collection_mode: 'manual_record',
    idempotency_key,
    method_code: 'online',
    external_ref: charge.provider_ref,
    note: `Online checkout (${charge.adapter_code}) for booking ${booking_code}`,
    post_now: charge.status === 'posted',
  })
  await tenant.query`
    INSERT INTO portal_payment (organization_id, portal_booking_id, payment_id, payment_kind_code, method_code, reference)
    VALUES (${tenant.organization_id}, ${locked.portal_booking_id}, ${payment.payment_id}, 'online', 'online', ${charge.provider_ref})
    ON CONFLICT (payment_id) DO NOTHING`
  await tenant.query`
    UPDATE portal_booking
    SET online_adapter_code = ${charge.adapter_code}, online_provider_ref = ${charge.provider_ref},
        online_checkout_url = ${charge.checkout_url}
    WHERE portal_booking_id = ${locked.portal_booking_id} AND organization_id = ${tenant.organization_id}`

  if (charge.status === 'posted') {
    await confirmIfHeld(tenant, booking_code)
    await afterPayment(tenant, booking_code, { payment_code: payment.payment_code, amount: payment.amount, method_code: 'online' })
  }
  await syncBookingDetail(tenant, booking_code)
  return {
    booking: await viewByCode(tenant, booking_code),
    is_replay: false,
    checkout_url: charge.status === 'pending' ? charge.checkout_url : null,
    instruction: null,
  }
}

/** A provider webhook. Replaying it changes nothing after the first application. */
export async function applyOnlineCallback(
  tenant: TenantContext,
  input: { raw_body: string; header: Record<string, string> },
): Promise<{ is_applied: boolean }> {
  let result
  try {
    result = await getOnlinePayment().readCallback(input)
  } catch (error) {
    if (error instanceof PaymentCallbackRefusedError) throw new PortalError(error.message, 401)
    throw new PortalError('The payment callback could not be read.', 400)
  }
  if (!result.is_paid) return { is_applied: false }

  const [link] = await tenant.query<{ portal_booking_id: Uuid; booking_code: string; payment_id: Uuid; payment_code: string; amount: string; status: string }[]>`
    SELECT pb.portal_booking_id, b.booking_code, p.payment_id, p.payment_code, p.amount::text AS amount, p.status::text AS status
    FROM portal_booking pb
    JOIN booking b ON b.booking_id = pb.booking_id
    JOIN portal_payment pp ON pp.portal_booking_id = pb.portal_booking_id AND pp.payment_kind_code = 'online'
    JOIN payment p ON p.payment_id = pp.payment_id
    WHERE pb.organization_id = ${tenant.organization_id} AND pb.online_provider_ref = ${result.provider_ref}
    FOR UPDATE OF pb`
  if (!link || link.status !== 'pending') return { is_applied: false }

  await postPayment(tenant, link.payment_id)
  try {
    await tenant.query.savepoint(() => confirmIfHeld(tenant, link.booking_code))
  } catch {
    // The hold lapsed while the guest was on the provider page. The money is
    // recorded against the booking; staff see "paid" on an expired booking and refund.
  }
  await afterPayment(tenant, link.booking_code, { payment_code: link.payment_code, amount: link.amount, method_code: 'online' })
  await syncBookingDetail(tenant, link.booking_code)
  return { is_applied: true }
}

export async function cancelByGuest(tenant: TenantContext, booking_code: string, body: Record<string, unknown>): Promise<{ booking: BookingView }> {
  const recovery_token = readToken(body['recovery_token'])
  if (!recovery_token) throw new PortalNotFound()
  await sweepExpiredHold(tenant)
  const locked = await lockPortalBooking(tenant, booking_code, recovery_token)
  if (!locked) throw new PortalNotFound()
  const view = await viewByCode(tenant, booking_code)
  if (!view.is_cancellable) throw new PortalError(view.cancel_refusal ?? 'This booking cannot be cancelled online.', 409)
  await cancel(tenant, booking_code)
  await afterCancel(tenant, booking_code, 'guest')
  return { booking: await viewByCode(tenant, booking_code) }
}

// ---------------------------------------------------------------------------
// operator
// ---------------------------------------------------------------------------

export async function listOperatorBooking(
  tenant: TenantContext,
  input: { date?: string | undefined; status?: string | undefined },
): Promise<{ date: string; time_zone: string; booking: BookingView[] }> {
  await sweepExpiredHold(tenant)
  const time_zone = await readTimeZone(tenant)
  const now = new Date()
  if (input.date && !isDateText(input.date)) throw new PortalError('Pick a date written as YYYY-MM-DD.', 400)
  if (input.status && !BOOKING_STATUS.has(input.status)) {
    throw new PortalError('Status must be one of hold, confirmed, cancelled, or expired.', 400)
  }
  const date = input.date || bookingWindow(now, 0, time_zone).first_date
  const day = dayWindow(date, time_zone)
  const filter: { starts_from: Date; starts_before: Date; status?: string } = { starts_from: day.starts_at, starts_before: day.ends_at }
  if (input.status) filter.status = input.status
  const row = await selectBooking(tenant, filter)
  return { date, time_zone, booking: row.map((one) => toView(one, time_zone, now)) }
}

async function lockForStaff(tenant: TenantContext, booking_code: string): Promise<{ portal_booking_id: Uuid; party_id: Uuid }> {
  const locked = await lockPortalBooking(tenant, booking_code)
  if (locked) return locked
  const [exist] = await tenant.query<{ booking_id: Uuid }[]>`
    SELECT booking_id FROM booking WHERE organization_id = ${tenant.organization_id} AND booking_code = ${booking_code}`
  if (!exist) throw new PortalError('That booking does not exist.', 404)
  throw new PortalError('This booking was made outside the reservation portal, so it has no guest bill here.', 409)
}

function readText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

export async function recordCounterPayment(tenant: TenantContext, booking_code: string, body: Record<string, unknown>): Promise<{ booking: BookingView; is_replay: boolean }> {
  const method = body['method']
  if (typeof method !== 'string' || !(COUNTER_METHOD as readonly string[]).includes(method)) {
    throw new PortalError('Choose how the guest paid: cash, GCash, or card terminal.', 400)
  }
  const amount = parseAmount(body['amount'])
  if (amount === undefined) throw new PortalError('Enter the amount received, for example 500 or 500.00.', 400)
  const reference = readText(body['reference'], 120)
  if (method !== 'cash' && !reference) {
    throw new PortalError(method === 'gcash' ? 'Enter the GCash reference number.' : 'Enter the card terminal approval code.', 400)
  }

  const locked = await lockForStaff(tenant, booking_code)
  const [row] = await selectBooking(tenant, { booking_code })
  if (!row) throw new PortalError('That booking does not exist.', 404)

  const idempotency_key = reference ? `portal:${booking_code}:counter:${method}:${reference}` : `portal:${booking_code}:counter:${randomUUID()}`
  const [replay] = await tenant.query<{ payment_id: Uuid }[]>`
    SELECT payment_id FROM payment WHERE organization_id = ${tenant.organization_id} AND idempotency_key = ${idempotency_key}`
  if (replay) return { booking: await viewByCode(tenant, booking_code), is_replay: true }

  if (row.status !== 'hold' && row.status !== 'confirmed') {
    throw new PortalError(`This booking is ${row.status}, so nothing is due.`, 409)
  }
  const view = toView(row, await readTimeZone(tenant), new Date())
  const balance_cent = toCent(view.balance_amount)
  const amount_cent = Math.round(amount * 100)
  if (balance_cent <= 0) throw new PortalError('This booking is already paid in full.', 409)
  if (amount_cent > balance_cent) {
    throw new PortalError(`That is more than the PHP ${fromCent(balance_cent)} still due on this booking.`, 409)
  }

  const input: Parameters<typeof recordPayment>[1] = {
    party_id: locked.party_id,
    amount: amount_cent / 100,
    collection_mode: 'manual_record',
    idempotency_key,
    method_code: method,
    note: `Counter payment for booking ${booking_code}`,
    post_now: true,
  }
  if (reference) input.external_ref = reference
  const payment = await recordPayment(tenant, input)
  await tenant.query`
    INSERT INTO portal_payment (organization_id, portal_booking_id, payment_id, payment_kind_code, method_code, reference)
    VALUES (${tenant.organization_id}, ${locked.portal_booking_id}, ${payment.payment_id}, 'counter', ${method}, ${reference || null})
    ON CONFLICT (payment_id) DO NOTHING`
  await tenant.query`
    UPDATE portal_booking SET is_pay_at_counter = true
    WHERE portal_booking_id = ${locked.portal_booking_id} AND organization_id = ${tenant.organization_id}`
  await confirmIfHeld(tenant, booking_code)
  await afterPayment(tenant, booking_code, { payment_code: payment.payment_code, amount: payment.amount, method_code: method })
  await syncBookingDetail(tenant, booking_code)
  return { booking: await viewByCode(tenant, booking_code), is_replay: false }
}

export async function refundBooking(tenant: TenantContext, booking_code: string, body: Record<string, unknown>): Promise<{ booking: BookingView }> {
  const amount = parseAmount(body['amount'])
  if (amount === undefined) throw new PortalError('Enter the amount to refund, for example 250 or 250.00.', 400)
  const reason = readText(body['reason'], 200)
  if (!reason) throw new PortalError('Say why the money is going back, for example "rain-out" or "overpaid".', 400)
  const reference = readText(body['reference'], 120)

  const locked = await lockForStaff(tenant, booking_code)
  const payment = await tenant.query<{ payment_id: Uuid; amount: string; refunded_amount: string }[]>`
    SELECT p.payment_id, p.amount::text AS amount,
           coalesce((SELECT sum(r.amount) FROM refund r WHERE r.payment_id = p.payment_id), 0)::numeric(14,2)::text AS refunded_amount
    FROM portal_payment pp
    JOIN payment p ON p.payment_id = pp.payment_id
    WHERE pp.portal_booking_id = ${locked.portal_booking_id}
      AND p.status IN ('posted', 'refunded')
    ORDER BY p.posted_at DESC NULLS LAST, p.created_at DESC`

  const refundable_cent = payment.reduce((total, one) => total + toCent(one.amount) - toCent(one.refunded_amount), 0)
  const amount_cent = Math.round(amount * 100)
  if (refundable_cent <= 0) throw new PortalError('This booking has no payment left to refund.', 409)
  if (amount_cent > refundable_cent) {
    throw new PortalError(`You can refund at most PHP ${fromCent(refundable_cent)} — that is what this booking has paid.`, 409)
  }

  const key_base = `portal:${booking_code}:refund:${reference || randomUUID()}`
  let remaining = amount_cent
  for (const one of payment) {
    if (remaining <= 0) break
    const available = toCent(one.amount) - toCent(one.refunded_amount)
    if (available <= 0) continue
    const part = Math.min(available, remaining)
    const input: Parameters<typeof refundPayment>[1] = {
      payment_id: one.payment_id,
      amount: part / 100,
      reason_code: reason,
      idempotency_key: `${key_base}:${one.payment_id}`,
    }
    if (reference) input.note = reference
    await refundPayment(tenant, input)
    remaining -= part
  }
  await syncBookingDetail(tenant, booking_code)
  return { booking: await viewByCode(tenant, booking_code) }
}

export async function cancelByOperator(tenant: TenantContext, booking_code: string): Promise<{ booking: BookingView }> {
  const [row] = await tenant.query<{ status: string }[]>`
    SELECT status::text AS status FROM booking
    WHERE organization_id = ${tenant.organization_id} AND booking_code = ${booking_code}
    FOR UPDATE`
  if (!row) throw new PortalError('That booking does not exist.', 404)
  if (row.status !== 'hold' && row.status !== 'confirmed') {
    throw new PortalError(`This booking is already ${row.status}.`, 409)
  }
  await cancel(tenant, booking_code)
  await afterCancel(tenant, booking_code, 'venue')
  return { booking: await viewByCode(tenant, booking_code) }
}
