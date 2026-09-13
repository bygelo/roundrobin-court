// Pure membership rules: price arithmetic, the sentence an operator reads, and
// calendar math in the venue's time zone. No I/O — unit-tested without a database.

import { displayPeso, toCentavo } from '../shop/money.ts'

export const DEFAULT_TIME_ZONE = 'Asia/Manila'

export type PriceRuleCode = 'none' | 'percent_off' | 'fixed_price'
export type PlanKindCode = 'membership' | 'pass'
export type BillingPeriodCode = 'monthly' | 'annual'

export type PriceRule = {
  price_rule_code: PriceRuleCode
  percent_off: string | null
  fixed_price_amount: string | null
}

/** The member price for a booking, in centavo. Never above the base price. */
export function applyPriceRule(base_centavo: number, rule: PriceRule): number {
  if (rule.price_rule_code === 'percent_off' && rule.percent_off !== null) {
    const hundredth = toCentavo(rule.percent_off, 'percent_off') // '20.00' → 2000
    const discount = Math.round((base_centavo * hundredth) / 10000)
    return Math.max(base_centavo - discount, 0)
  }
  if (rule.price_rule_code === 'fixed_price' && rule.fixed_price_amount !== null) {
    return Math.min(base_centavo, toCentavo(rule.fixed_price_amount, 'fixed_price_amount'))
  }
  return base_centavo
}

function trimPercent(percent: string): string {
  return String(Number(percent))
}

export function ruleSentence(plan: {
  plan_kind_code: PlanKindCode
  price_rule_code: PriceRuleCode
  percent_off: string | null
  fixed_price_amount: string | null
  is_member_session_access: boolean
  session_count: number | null
  valid_day_count: number | null
}): string {
  if (plan.plan_kind_code === 'pass') {
    const session = plan.session_count === 1 ? '1 session' : `${plan.session_count} sessions`
    return `${session}, valid ${plan.valid_day_count} days — each booking uses one`
  }
  const part: string[] = []
  if (plan.price_rule_code === 'percent_off' && plan.percent_off) part.push(`${trimPercent(plan.percent_off)}% off every court booking`)
  else if (plan.price_rule_code === 'fixed_price' && plan.fixed_price_amount)
    part.push(`Court bookings at ${displayPeso(toCentavo(plan.fixed_price_amount))} each`)
  else part.push('No booking discount')
  if (plan.is_member_session_access) part.push('can book members-only sessions')
  return part.join(' · ')
}

// ---------------------------------------------------------------------------
// calendar
// ---------------------------------------------------------------------------

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

export function isDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = DATE_PATTERN.exec(value)
  if (!match) return false
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  return date.toISOString().slice(0, 10) === value
}

function part(date: string): [number, number, number] {
  const match = DATE_PATTERN.exec(date)
  if (!match) throw new Error(`not a date: ${date}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** Minutes the zone is ahead of UTC at `instant`. */
function zoneOffsetMinute(instant: number, time_zone: string): number {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: time_zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const value: Record<string, number> = {}
  for (const one of format.formatToParts(new Date(instant))) {
    if (one.type !== 'literal') value[one.type] = Number(one.value)
  }
  const as_utc = Date.UTC(value['year']!, value['month']! - 1, value['day']!, value['hour']!, value['minute']!, value['second']!)
  return Math.round((as_utc - Math.floor(instant / 1000) * 1000) / 60000)
}

/** The instant a local calendar day begins in `time_zone`. */
export function startOfLocalDay(date: string, time_zone: string = DEFAULT_TIME_ZONE): Date {
  const [year, month, day] = part(date)
  const guess = Date.UTC(year, month - 1, day)
  let instant = guess - zoneOffsetMinute(guess, time_zone) * 60000
  // A DST transition between the guess and the answer shifts the offset once.
  instant = guess - zoneOffsetMinute(instant, time_zone) * 60000
  return new Date(instant)
}

/** The local calendar date of an instant in `time_zone`. */
export function localDate(instant: Date, time_zone: string = DEFAULT_TIME_ZONE): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: time_zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant)
}

export function addDay(date: string, day_count: number): string {
  const [year, month, day] = part(date)
  return new Date(Date.UTC(year, month - 1, day + day_count)).toISOString().slice(0, 10)
}

/** Calendar months, clamped to the month's last day (Jan 31 + 1 month = Feb 28). */
export function addMonth(date: string, month_count: number): string {
  const [year, month, day] = part(date)
  const target = new Date(Date.UTC(year, month - 1 + month_count, 1))
  const last_day = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  target.setUTCDate(Math.min(day, last_day))
  return target.toISOString().slice(0, 10)
}

/** The first local day a membership starting on `starts_on` no longer covers. */
export function periodEnd(starts_on: string, billing_period_code: BillingPeriodCode): string {
  return addMonth(starts_on, billing_period_code === 'annual' ? 12 : 1)
}

export type MemberStatusCode = 'active' | 'expiring' | 'expired' | 'frozen' | 'cancelled' | 'pass_only'

export const EXPIRING_DAY_COUNT = 7

/** Operator-facing status: the pack's status, plus expiring/expired read from the clock. */
export function memberStatus(input: { status: string | null; ends_at: Date | null; now: Date }): MemberStatusCode {
  if (input.status === null) return 'pass_only'
  if (input.status === 'frozen') return 'frozen'
  if (input.status === 'cancelled') return 'cancelled'
  if (input.status === 'expired') return 'expired'
  if (input.ends_at && input.ends_at.getTime() <= input.now.getTime()) return 'expired'
  if (input.ends_at && input.ends_at.getTime() - input.now.getTime() <= EXPIRING_DAY_COUNT * 86_400_000) return 'expiring'
  return 'active'
}
