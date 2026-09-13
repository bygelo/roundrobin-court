// Pure portal rules — no database, no clock unless passed in. Unit-tested in
// test/portal-rule.test.ts.

import { createHash, randomBytes } from 'node:crypto'

export const DEFAULT_TIME_ZONE = 'Asia/Manila'

/** Integer centavo from a money string or number. Money never does float arithmetic here. */
export function toCent(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0
  return Math.round(Number(value) * 100)
}

export function fromCent(cent: number): string {
  return (cent / 100).toFixed(2)
}

/** 128 random bits, url-safe. Returned to the guest once. */
export function createRecoveryToken(): string {
  return randomBytes(16).toString('base64url')
}

export function hashRecoveryToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export function isDateText(value: string | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [y, m, d] = value.split('-').map(Number) as [number, number, number]
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
}

function zoneOffsetAt(instant: number, time_zone: string): number {
  const part = new Intl.DateTimeFormat('en-US', {
    timeZone: time_zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant))
  const read = (type: Intl.DateTimeFormatPartTypes): number => Number(part.find((one) => one.type === type)?.value ?? 0)
  return Date.UTC(read('year'), read('month') - 1, read('day'), read('hour'), read('minute'), read('second')) - instant
}

/** Local midnight of `date` in `time_zone`, as an instant. */
export function localMidnight(date: string, time_zone: string): Date {
  const naive = Date.parse(`${date}T00:00:00Z`)
  let instant = naive - zoneOffsetAt(naive, time_zone)
  instant = naive - zoneOffsetAt(instant, time_zone)
  return new Date(instant)
}

/** The half-open instant window a calendar date covers at the venue. */
export function dayWindow(date: string, time_zone: string): { starts_at: Date; ends_at: Date } {
  const next = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
  return { starts_at: localMidnight(date, time_zone), ends_at: localMidnight(next, time_zone) }
}

/** YYYY-MM-DD of an instant at the venue. */
export function localDate(instant: Date, time_zone: string): string {
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: time_zone }).format(instant)
}

export function addDay(date: string, day_count: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + day_count * 86_400_000).toISOString().slice(0, 10)
}

/** First and last bookable calendar date: today through today + advance window. */
export function bookingWindow(now: Date, advance_window_day_count: number, time_zone: string): { first_date: string; last_date: string } {
  const first_date = localDate(now, time_zone)
  return { first_date, last_date: addDay(first_date, Math.max(0, advance_window_day_count)) }
}

/** Latest instant a session may start and still be bookable. */
export function windowEndAt(now: Date, advance_window_day_count: number, time_zone: string): Date {
  const { last_date } = bookingWindow(now, advance_window_day_count, time_zone)
  return dayWindow(last_date, time_zone).ends_at
}

export function cancellationCutoffAt(starts_at: Date, cancellation_cutoff_hour_count: number): Date {
  return new Date(starts_at.getTime() - Math.max(0, cancellation_cutoff_hour_count) * 3_600_000)
}

export function formatVenueDateTime(instant: Date, time_zone: string): string {
  return new Intl.DateTimeFormat('en-PH', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: time_zone,
  }).format(instant)
}

export type Contact = { display_name: string; email: string; phone: string }

/** Field → sentence. Empty object means the contact is usable. */
export function validateContact(input: unknown): { contact?: Contact; problem: Record<string, string> } {
  const problem: Record<string, string> = {}
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const display_name = typeof raw['display_name'] === 'string' ? raw['display_name'].trim() : ''
  const email = typeof raw['email'] === 'string' ? raw['email'].trim().toLowerCase() : ''
  const phone = typeof raw['phone'] === 'string' ? raw['phone'].trim() : ''
  if (display_name.length < 2) problem['display_name'] = 'Enter the name the booking is under.'
  else if (display_name.length > 120) problem['display_name'] = 'Keep the name under 120 characters.'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) problem['email'] = 'Enter an email address like name@example.com.'
  const digit = phone.replace(/\D/g, '')
  if (digit.length < 7 || digit.length > 15 || !/^[+\d\s().-]+$/.test(phone)) problem['phone'] = 'Enter a mobile number, for example 0917 123 4567.'
  if (Object.keys(problem).length > 0) return { problem }
  return { contact: { display_name, email, phone }, problem }
}

/** Fields a guest may never set: price and time are server-owned. */
export const SERVER_OWNED_FIELD = ['price_amount', 'total_amount', 'base_amount', 'starts_at', 'ends_at', 'status', 'hold_expires_at'] as const

export function findServerOwnedField(body: Record<string, unknown>): string | undefined {
  return SERVER_OWNED_FIELD.find((field) => Object.hasOwn(body, field))
}

export type PaymentState =
  | 'not_required'
  | 'unpaid'
  | 'pending'
  | 'partial'
  | 'paid'
  | 'partially_refunded'
  | 'refunded'

export type PaymentFigure = {
  total_amount: string
  posted_amount: string
  pending_amount: string
  refunded_amount: string
}

/** One word for where the money on a booking stands. */
export function paymentState(figure: PaymentFigure): PaymentState {
  const total = toCent(figure.total_amount)
  const posted = toCent(figure.posted_amount)
  const refunded = toCent(figure.refunded_amount)
  const net = posted - refunded
  if (refunded > 0) return net <= 0 ? 'refunded' : 'partially_refunded'
  if (total === 0) return 'not_required'
  if (net >= total) return 'paid'
  if (net > 0) return 'partial'
  if (toCent(figure.pending_amount) > 0) return 'pending'
  return 'unpaid'
}

export function paidAmount(figure: PaymentFigure): string {
  return fromCent(Math.max(0, toCent(figure.posted_amount) - toCent(figure.refunded_amount)))
}

export function balanceAmount(figure: PaymentFigure): string {
  return fromCent(Math.max(0, toCent(figure.total_amount) - (toCent(figure.posted_amount) - toCent(figure.refunded_amount))))
}

/** Parse a money amount typed by staff. Undefined when it is not a positive two-decimal number. */
export function parseAmount(value: unknown): number | undefined {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : ''
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(text)) return undefined
  const amount = Number(text)
  return amount > 0 ? amount : undefined
}

export type CancelDecision = { is_cancellable: true } | { is_cancellable: false; reason: string }

/**
 * Whether a guest may cancel online now. A hold can always be released; a
 * confirmed booking only until its cutoff.
 */
export function decideGuestCancel(input: {
  status: string
  cancellation_cutoff_at: Date
  now: Date
  time_zone: string
}): CancelDecision {
  if (input.status === 'cancelled') return { is_cancellable: false, reason: 'This booking is already cancelled.' }
  if (input.status === 'expired') return { is_cancellable: false, reason: 'This hold already expired, so there is nothing to cancel.' }
  if (input.status === 'hold') return { is_cancellable: true }
  if (input.now.getTime() > input.cancellation_cutoff_at.getTime()) {
    return {
      is_cancellable: false,
      reason: `Online cancellation closed at ${formatVenueDateTime(input.cancellation_cutoff_at, input.time_zone)}. Please contact the venue.`,
    }
  }
  return { is_cancellable: true }
}
