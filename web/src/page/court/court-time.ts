// Venue-zone date arithmetic for the court screens. A booking desk in Manila
// must see Manila time whatever the laptop's clock says.

export const WEEKDAY = [
  { weekday_number: 1, label: 'Monday', short: 'Mon' },
  { weekday_number: 2, label: 'Tuesday', short: 'Tue' },
  { weekday_number: 3, label: 'Wednesday', short: 'Wed' },
  { weekday_number: 4, label: 'Thursday', short: 'Thu' },
  { weekday_number: 5, label: 'Friday', short: 'Fri' },
  { weekday_number: 6, label: 'Saturday', short: 'Sat' },
  { weekday_number: 7, label: 'Sunday', short: 'Sun' },
] as const

export function weekdayLabel(weekday_number: number): string {
  return WEEKDAY.find((one) => one.weekday_number === weekday_number)?.label ?? `Day ${weekday_number}`
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
  const read = (type: Intl.DateTimeFormatPartTypes) => Number(part.find((one) => one.type === type)?.value ?? 0)
  return Date.UTC(read('year'), read('month') - 1, read('day'), read('hour'), read('minute'), read('second')) - instant
}

export function timeMinute(value: string): number {
  const [hour, minute] = value.split(':').map(Number)
  return (hour ?? 0) * 60 + (minute ?? 0)
}

/** Local date + "HH:MM" in the venue zone → ISO instant. */
export function zonedIso(date_key: string, time_local: string, time_zone: string): string {
  const naive = Date.parse(`${date_key}T00:00:00Z`) + timeMinute(time_local) * 60_000
  let instant = naive - zoneOffsetAt(naive, time_zone)
  instant = naive - zoneOffsetAt(instant, time_zone)
  return new Date(instant).toISOString()
}

export function addDay(date_key: string, day_count: number): string {
  const date = new Date(`${date_key}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + day_count)
  return date.toISOString().slice(0, 10)
}

/** Minutes after local midnight of `date_key` at which `iso` falls (may exceed 1440 or be negative). */
export function minuteFromDayStart(iso: string, date_key: string, time_zone: string): number {
  return Math.round((Date.parse(iso) - Date.parse(zonedIso(date_key, '00:00', time_zone))) / 60_000)
}

export function formatHourLabel(minute: number): string {
  const hour = Math.floor(minute / 60) % 24
  const suffix = hour < 12 ? 'AM' : 'PM'
  const twelve = hour % 12 === 0 ? 12 : hour % 12
  return `${twelve} ${suffix}`
}

export function formatLongDate(date_key: string): string {
  return new Intl.DateTimeFormat('en-PH', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${date_key}T00:00:00Z`),
  )
}

export const TIME_ZONE_OPTION = [
  'Asia/Manila',
  'Asia/Singapore',
  'Asia/Kuala_Lumpur',
  'Asia/Jakarta',
  'Asia/Bangkok',
  'Asia/Ho_Chi_Minh',
  'Asia/Hong_Kong',
  'Asia/Tokyo',
  'Asia/Dubai',
  'Australia/Sydney',
  'Europe/London',
  'America/New_York',
  'America/Los_Angeles',
  'UTC',
]
