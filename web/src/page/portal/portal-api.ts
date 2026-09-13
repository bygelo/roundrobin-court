// Portal lane client: response shapes, fetchers, and the on-device recovery list.

import type { BadgeTone } from '../../component/ui.tsx'
import { jsonBody, operatorFetch, publicFetch } from '../../api.ts'

export type Availability = {
  date: string
  time_zone: string
  first_date: string
  last_date: string
  is_inside_window: boolean
  sport: { sport_code: string; display_name: string }[]
  court: { resource_id: string; resource_code: string; display_name: string; sport_code: string | null }[]
  slot: { session_id: string; resource_id: string; starts_at: string; ends_at: string; price_amount: string; is_available: boolean }[]
  cancellation_cutoff_hour_count: number
  is_guest_booking_allowed: boolean
  is_counter_payment_allowed: boolean
  online_payment_label: string
}

export type Slot = Availability['slot'][number]

export type PaymentState = 'not_required' | 'unpaid' | 'pending' | 'partial' | 'paid' | 'partially_refunded' | 'refunded'

export type BookingView = {
  booking_code: string
  status: 'hold' | 'confirmed' | 'cancelled' | 'expired'
  court_name: string
  sport_code: string | null
  starts_at: string
  ends_at: string
  participant_count: number
  hold_expires_at: string | null
  total_amount: string
  paid_amount: string
  balance_amount: string
  refunded_amount: string
  payment_state: PaymentState
  payment_method: string[]
  cancellation_cutoff_at: string | null
  is_pay_at_counter: boolean
  is_portal_booking: boolean
  is_cancellable: boolean
  cancel_refusal: string | null
  is_payable_online: boolean
  checkout_url: string | null
  contact: { display_name: string; email: string | null; phone: string | null }
}

export type Created = {
  booking_code: string
  recovery_token: string
  status: string
  court_name: string
  starts_at: string
  ends_at: string
  hold_expires_at: string | null
  base_amount: string
  total_amount: string
  cancellation_cutoff_at: string
  price_note: string | null
}

export type PayResult = { booking: BookingView; is_replay: boolean; checkout_url: string | null; instruction: string | null }

export type PortalSetting = { is_counter_payment_allowed: boolean; counter_instruction: string }

const base = (organization_code: string) => `/public/${encodeURIComponent(organization_code)}/portal`

export function loadAvailability(organization_code: string, date: string | undefined, sport: string | undefined): Promise<Availability> {
  const query = new URLSearchParams()
  if (date) query.set('date', date)
  if (sport) query.set('sport', sport)
  return publicFetch<Availability>(`${base(organization_code)}/availability?${query.toString()}`)
}

export function createBooking(
  organization_code: string,
  input: { session_id: string; resource_id: string; participant_count: number; contact: { display_name: string; email: string; phone: string } },
): Promise<Created> {
  return publicFetch<Created>(`${base(organization_code)}/booking`, jsonBody(input))
}

export function payBooking(organization_code: string, booking_code: string, recovery_token: string, method: 'online' | 'counter'): Promise<PayResult> {
  return publicFetch<PayResult>(`${base(organization_code)}/booking/${encodeURIComponent(booking_code)}/pay`, jsonBody({ recovery_token, method }))
}

export function loadRecovery(organization_code: string, booking_code: string, token: string): Promise<{ booking: BookingView; counter_instruction: string }> {
  return publicFetch(`${base(organization_code)}/booking/${encodeURIComponent(booking_code)}?token=${encodeURIComponent(token)}`)
}

export function cancelBooking(organization_code: string, booking_code: string, recovery_token: string): Promise<{ booking: BookingView }> {
  return publicFetch(`${base(organization_code)}/booking/${encodeURIComponent(booking_code)}/cancel`, jsonBody({ recovery_token }))
}

// ---- operator -------------------------------------------------------------

export function loadOperatorBooking(date: string, status: string): Promise<{ date: string; time_zone: string; booking: BookingView[] }> {
  const query = new URLSearchParams({ date })
  if (status) query.set('status', status)
  return operatorFetch(`/api/v1/portal/booking?${query.toString()}`)
}

export function recordPayment(booking_code: string, input: { method: string; amount: string; reference: string }): Promise<{ booking: BookingView }> {
  return operatorFetch(`/api/v1/portal/booking/${encodeURIComponent(booking_code)}/payment`, jsonBody(input))
}

export function refundBooking(booking_code: string, input: { amount: string; reason: string; reference: string }): Promise<{ booking: BookingView }> {
  return operatorFetch(`/api/v1/portal/booking/${encodeURIComponent(booking_code)}/refund`, jsonBody(input))
}

export function cancelAsOperator(booking_code: string): Promise<{ booking: BookingView }> {
  return operatorFetch(`/api/v1/portal/booking/${encodeURIComponent(booking_code)}/cancel`, { method: 'POST' })
}

export function loadSetting(): Promise<{ setting: PortalSetting }> {
  return operatorFetch('/api/v1/portal/setting')
}

export function saveSetting(setting: PortalSetting): Promise<{ setting: PortalSetting }> {
  return operatorFetch('/api/v1/portal/setting', jsonBody(setting, 'PUT'))
}

// ---- labels ---------------------------------------------------------------

export const STATUS_LABEL: Record<BookingView['status'], { label: string; tone: BadgeTone }> = {
  hold: { label: 'Held', tone: 'caution' },
  confirmed: { label: 'Confirmed', tone: 'success' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  expired: { label: 'Expired', tone: 'neutral' },
}

export const PAYMENT_LABEL: Record<PaymentState, { label: string; tone: BadgeTone }> = {
  not_required: { label: 'Nothing due', tone: 'success' },
  unpaid: { label: 'Unpaid', tone: 'caution' },
  pending: { label: 'Checkout pending', tone: 'info' },
  partial: { label: 'Part paid', tone: 'caution' },
  paid: { label: 'Paid', tone: 'success' },
  partially_refunded: { label: 'Part refunded', tone: 'info' },
  refunded: { label: 'Refunded', tone: 'neutral' },
}

export const METHOD_LABEL: Record<string, string> = {
  online: 'Online',
  cash: 'Cash',
  gcash: 'GCash',
  card_terminal: 'Card terminal',
}

// ---- recovery links saved on this device ------------------------------------

export type SavedBooking = { organization_code: string; booking_code: string; recovery_token: string; court_name: string; starts_at: string }

const RECOVERY_KEY = 'court.portal.recovery'

export function readSavedBooking(): SavedBooking[] {
  try {
    const raw = window.localStorage.getItem(RECOVERY_KEY)
    const value: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(value) ? (value as SavedBooking[]) : []
  } catch {
    return []
  }
}

export function saveBooking(one: SavedBooking): void {
  const rest = readSavedBooking().filter((saved) => !(saved.organization_code === one.organization_code && saved.booking_code === one.booking_code))
  try {
    window.localStorage.setItem(RECOVERY_KEY, JSON.stringify([one, ...rest].slice(0, 20)))
  } catch {
    // Private browsing may refuse storage; the link on screen still works.
  }
}

export function findSavedToken(organization_code: string, booking_code: string): string | undefined {
  return readSavedBooking().find((one) => one.organization_code === organization_code && one.booking_code === booking_code)?.recovery_token
}

export function recoveryPath(one: { organization_code: string; booking_code: string; recovery_token: string }): string {
  return `/v/${encodeURIComponent(one.organization_code)}/booking/${encodeURIComponent(one.booking_code)}?token=${encodeURIComponent(one.recovery_token)}`
}
