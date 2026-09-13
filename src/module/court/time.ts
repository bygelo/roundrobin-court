// Wall-clock arithmetic in a venue's time zone, and slot generation.
//
// Pure functions only — no database, no clock unless passed in — so the rules
// that decide which slots exist and what they cost have fast unit tests.

export const DEFAULT_TIME_ZONE = 'Asia/Manila'

export const SLOT_MINUTE_OPTION = [60, 90, 120] as const

/** True when `time_zone` is an IANA zone Node's Intl database knows. */
export function isTimeZone(time_zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: time_zone })
    return true
  } catch {
    return false
  }
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

/** "YYYY-MM-DD" + "HH:MM[:SS]" read on a clock in `time_zone` → the instant it names. */
export function zonedToInstant(date_key: string, time_local: string, time_zone: string): Date {
  const minute = parseTimeMinute(time_local)
  const base = Date.parse(`${date_key}T00:00:00Z`)
  if (Number.isNaN(base)) throw new RangeError(`not a date: ${date_key}`)
  const naive = base + minute * 60_000
  let instant = naive - zoneOffsetAt(naive, time_zone)
  instant = naive - zoneOffsetAt(instant, time_zone)
  return new Date(instant)
}

/** The calendar date an instant falls on in `time_zone`, as YYYY-MM-DD. */
export function localDateKey(instant: Date, time_zone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: time_zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant)
}

/** Minutes since local midnight for an instant in `time_zone`. */
export function localMinuteOfDay(instant: Date, time_zone: string): number {
  const offset = zoneOffsetAt(instant.getTime(), time_zone)
  const local = instant.getTime() + offset
  return Math.floor((((local % 86_400_000) + 86_400_000) % 86_400_000) / 60_000)
}

export function isDateKey(value: string | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

export function addDay(date_key: string, day_count: number): string {
  const date = new Date(`${date_key}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + day_count)
  return date.toISOString().slice(0, 10)
}

/** ISO weekday of a date key: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date_key: string): number {
  const day = new Date(`${date_key}T00:00:00Z`).getUTCDay()
  return day === 0 ? 7 : day
}

export function isTimeLocal(value: unknown): value is string {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$|^24:00(:00)?$/.test(value)
}

/** "06:30" or "06:30:00" → 390. "24:00" → 1440. */
export function parseTimeMinute(value: string): number {
  if (!isTimeLocal(value)) throw new RangeError(`not a local time: ${value}`)
  const [hour, minute] = value.split(':').map(Number) as [number, number]
  return hour * 60 + minute
}

/** 390 → "06:30". 1440 → "24:00". */
export function formatTimeMinute(minute: number): string {
  const hour = Math.floor(minute / 60)
  return `${String(hour).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
}

export type OperatingHour = { weekday_number: number; opens_local: string; closes_local: string }
export type PeakWindow = { weekday_number: number; starts_local: string; ends_local: string }

export type GeneratedSlot = {
  weekday_number: number
  starts_local: string
  ends_local: string
  /** 1 when the slot ends exactly at midnight, so the pack can express it. */
  end_day_offset: number
  is_peak: boolean
  price_amount: string
}

/**
 * Every sellable slot of one schedule, per weekday.
 *
 * Slots start at opening time and step by the slot length; a slot that would run
 * past closing is not sold. A slot is peak when it STARTS inside a peak window
 * for its weekday.
 */
export function generateSlot(input: {
  operating_hour: OperatingHour[]
  peak: PeakWindow[]
  slot_minute_count: number
  off_peak_price_amount: string
  peak_price_amount: string
}): GeneratedSlot[] {
  const slot: GeneratedSlot[] = []
  const hour = [...input.operating_hour].sort((left, right) => left.weekday_number - right.weekday_number)
  for (const one of hour) {
    const opens = parseTimeMinute(one.opens_local)
    const closes = parseTimeMinute(one.closes_local)
    const window = input.peak.filter((peak) => peak.weekday_number === one.weekday_number)
    for (let start = opens; start + input.slot_minute_count <= closes; start += input.slot_minute_count) {
      const end = start + input.slot_minute_count
      const is_peak = window.some(
        (peak) => start >= parseTimeMinute(peak.starts_local) && start < parseTimeMinute(peak.ends_local),
      )
      slot.push({
        weekday_number: one.weekday_number,
        starts_local: formatTimeMinute(start),
        ends_local: end === 1440 ? '00:00' : formatTimeMinute(end),
        end_day_offset: end === 1440 ? 1 : 0,
        is_peak,
        price_amount: is_peak ? input.peak_price_amount : input.off_peak_price_amount,
      })
    }
  }
  return slot
}

/** Normalise a money input to a 2-decimal string, or undefined when it is not one. */
export function readMoney(value: unknown): string | undefined {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : ''
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(text)) return undefined
  return Number(text).toFixed(2)
}
