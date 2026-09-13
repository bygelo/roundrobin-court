// Pure recurrence logic: turn an explicit schedule rule into dated occurrences.
//
// No database, no clock. The venue's wall-clock time ("Tuesdays 18:00") is
// converted to an instant in the schedule's time zone, so a server running in
// UTC still materializes a 6 PM clinic at 6 PM Manila time.

export type ScheduleCode = 'once' | 'weekly'

export type ScheduleRule = {
  schedule_code: ScheduleCode
  /** ISO weekday numbers, 1 Monday .. 7 Sunday. Ignored for a one-off. */
  weekday_number: number[]
  /** YYYY-MM-DD */
  first_date: string
  /** YYYY-MM-DD, inclusive. Required for weekly. */
  until_date: string | null
  /** HH:MM or HH:MM:SS */
  starts_local: string
  ends_local: string
  skipped_date: string[]
  time_zone: string
}

export type PlannedOccurrence = {
  occurrence_date: string
  starts_at: Date
  ends_at: Date
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/

export function isDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

export function isTime(value: unknown): value is string {
  return typeof value === 'string' && TIME_PATTERN.test(value)
}

/** Add whole days to a YYYY-MM-DD date. */
export function addDay(date: string, day_count: number): string {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + day_count)
  return value.toISOString().slice(0, 10)
}

/** ISO weekday (1 Monday .. 7 Sunday) of a calendar date. */
export function isoWeekday(date: string): number {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay()
  return day === 0 ? 7 : day
}

/** The calendar date of an instant in a time zone, YYYY-MM-DD. */
export function localDate(instant: Date, time_zone: string): string {
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: time_zone }).format(
    instant,
  )
}

/** Offset of `time_zone` from UTC at `instant`, in minutes (Manila → +480). */
function offsetMinute(instant: Date, time_zone: string): number {
  const part = new Intl.DateTimeFormat('en-US', {
    timeZone: time_zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant)
  const read = (type: string) => Number(part.find((one) => one.type === type)?.value ?? 0)
  const as_utc = Date.UTC(read('year'), read('month') - 1, read('day'), read('hour'), read('minute'), read('second'))
  return Math.round((as_utc - instant.getTime()) / 60000)
}

/** The instant at which the wall clock in `time_zone` reads `date time`. */
export function zonedInstant(date: string, time: string, time_zone: string): Date {
  const [hour, minute, second] = time.split(':').map(Number)
  const [year, month, day] = date.split('-').map(Number)
  const naive = Date.UTC(year!, month! - 1, day!, hour!, minute!, second ?? 0)
  // Two passes settle the offset across a DST boundary.
  let guess = naive - offsetMinute(new Date(naive), time_zone) * 60000
  guess = naive - offsetMinute(new Date(guess), time_zone) * 60000
  return new Date(guess)
}

/** The longest horizon one materialization may cover, so a typo cannot create ten years of rows. */
export const MAX_HORIZON_DAY_COUNT = 400

/**
 * Every occurrence the rule produces between `from_date` and `to_date`
 * (inclusive), minus skipped dates, in date order.
 */
export function planOccurrence(rule: ScheduleRule, window: { from_date: string; to_date: string }): PlannedOccurrence[] {
  const skipped = new Set(rule.skipped_date)
  const make = (occurrence_date: string): PlannedOccurrence => ({
    occurrence_date,
    starts_at: zonedInstant(occurrence_date, rule.starts_local, rule.time_zone),
    ends_at: zonedInstant(occurrence_date, rule.ends_local, rule.time_zone),
  })

  if (rule.schedule_code === 'once') {
    const date = rule.first_date
    if (skipped.has(date) || date < window.from_date || date > window.to_date) return []
    return [make(date)]
  }

  const start = rule.first_date > window.from_date ? rule.first_date : window.from_date
  let end = rule.until_date && rule.until_date < window.to_date ? rule.until_date : window.to_date
  const cap = addDay(start, MAX_HORIZON_DAY_COUNT)
  if (end > cap) end = cap

  const weekday = new Set(rule.weekday_number)
  const planned: PlannedOccurrence[] = []
  for (let date = start; date <= end; date = addDay(date, 1)) {
    if (weekday.has(isoWeekday(date)) && !skipped.has(date)) planned.push(make(date))
  }
  return planned
}

/** Refusal sentence for a rule a person typed, or undefined when it is valid. */
export function describeRuleProblem(rule: ScheduleRule): string | undefined {
  if (rule.schedule_code !== 'once' && rule.schedule_code !== 'weekly') return 'schedule must be one-off or weekly'
  if (!isDate(rule.first_date)) return 'choose a start date'
  if (!isTime(rule.starts_local) || !isTime(rule.ends_local)) return 'start and end times must be like 18:00'
  if (rule.ends_local <= rule.starts_local) return 'the end time must be after the start time'
  if (rule.skipped_date.some((one) => !isDate(one))) return 'skipped dates must be real dates'
  if (rule.schedule_code === 'weekly') {
    if (rule.weekday_number.length === 0) return 'pick at least one weekday'
    if (rule.weekday_number.some((one) => !Number.isInteger(one) || one < 1 || one > 7)) return 'weekdays must be 1 to 7'
    if (!isDate(rule.until_date)) return 'a weekly program needs an until date'
    if (rule.until_date < rule.first_date) return 'the until date must be on or after the start date'
    if (addDay(rule.first_date, MAX_HORIZON_DAY_COUNT) < rule.until_date) return 'a weekly program can run for at most 400 days'
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: rule.time_zone })
  } catch {
    return 'unknown time zone'
  }
  return undefined
}
