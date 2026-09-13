// Pure range and formatting rules for insight. No database, so they are unit
// tested without one.

import { DomainError } from '@bygelo/roundrobin-kernel'

export const DEFAULT_TIME_ZONE = 'Asia/Manila'
export const MAX_RANGE_DAY_COUNT = 366

export class InsightRangeError extends DomainError {
  constructor(message: string) {
    super(message, 400)
  }
}

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/

/** True when value is a real calendar date written YYYY-MM-DD. */
export function isDateKey(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_KEY.test(value)) return false
  const [year, month, day] = value.split('-').map(Number) as [number, number, number]
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

export function addDay(date_key: string, day_count: number): string {
  const [year, month, day] = date_key.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(year, month - 1, day + day_count)).toISOString().slice(0, 10)
}

/** Inclusive number of calendar days from from to to. */
export function dayCount(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number]
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number]
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000) + 1
}

export function isTimeZone(time_zone: unknown): time_zone is string {
  if (typeof time_zone !== 'string' || time_zone.length === 0) return false
  try {
    new Intl.DateTimeFormat('en', { timeZone: time_zone }).format(new Date(0))
    return true
  } catch {
    return false
  }
}

export function localDateKey(instant: Date, time_zone: string): string {
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: time_zone }).format(instant)
}

/**
 * The inclusive local-date range a request asks for.
 *
 * Neither given → the last 7 days ending today. One given → that single day.
 * Refuses a malformed date, to before from, and anything longer than 366 days.
 */
export function resolveRangeInput(
  input: { from?: string | undefined; to?: string | undefined },
  today: string,
): { from: string; to: string; day_count: number } {
  const raw_from = input.from?.trim() || undefined
  const raw_to = input.to?.trim() || undefined
  if (raw_from !== undefined && !isDateKey(raw_from)) throw new InsightRangeError('from must be a date written YYYY-MM-DD')
  if (raw_to !== undefined && !isDateKey(raw_to)) throw new InsightRangeError('to must be a date written YYYY-MM-DD')

  const to = raw_to ?? raw_from ?? today
  const from = raw_from ?? (raw_to ? raw_to : addDay(today, -6))
  if (to < from) throw new InsightRangeError('to must be on or after from')
  const day_count = dayCount(from, to)
  if (day_count > MAX_RANGE_DAY_COUNT) {
    throw new InsightRangeError(`a range may cover at most ${MAX_RANGE_DAY_COUNT} days; this one covers ${day_count}`)
  }
  return { from, to, day_count }
}

/**
 * A ratio as a 4-decimal string ("0.7143"), or null when there is nothing to
 * divide by. Counts only — money never passes through here.
 */
export function rateText(numerator: number, denominator: number): string | null {
  if (!(denominator > 0)) return null
  const scaled = Math.round((numerator * 10_000) / denominator)
  const whole = Math.floor(scaled / 10_000)
  const fraction = String(scaled % 10_000).padStart(4, '0')
  return `${whole}.${fraction}`
}
