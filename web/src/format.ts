// Display formatting. Venues default to Manila time and pesos; a site's own
// time_zone should be passed whenever the caller has it.

export const DEFAULT_TIME_ZONE = 'Asia/Manila'

export function formatMoney(amount: string | number | null | undefined, currency = 'PHP'): string {
  if (amount === null || amount === undefined || amount === '') return '—'
  const value = typeof amount === 'number' ? amount : Number(amount)
  if (!Number.isFinite(value)) return String(amount)
  return new Intl.NumberFormat('en-PH', { style: 'currency', currency, minimumFractionDigits: 2 }).format(value)
}

export function formatTime(iso: string | Date, time_zone = DEFAULT_TIME_ZONE): string {
  return new Intl.DateTimeFormat('en-PH', { hour: 'numeric', minute: '2-digit', timeZone: time_zone }).format(new Date(iso))
}

export function formatDate(iso: string | Date, time_zone = DEFAULT_TIME_ZONE): string {
  return new Intl.DateTimeFormat('en-PH', { weekday: 'short', month: 'short', day: 'numeric', timeZone: time_zone }).format(
    new Date(iso),
  )
}

export function formatDateTime(iso: string | Date, time_zone = DEFAULT_TIME_ZONE): string {
  return `${formatDate(iso, time_zone)} · ${formatTime(iso, time_zone)}`
}

export function formatTimeRange(starts_at: string, ends_at: string, time_zone = DEFAULT_TIME_ZONE): string {
  return `${formatTime(starts_at, time_zone)} – ${formatTime(ends_at, time_zone)}`
}

/** YYYY-MM-DD for a Date in the venue time zone — the value a date input wants. */
export function toDateInput(date: Date, time_zone = DEFAULT_TIME_ZONE): string {
  const part = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: time_zone }).format(date)
  return part
}

export function titleCase(code: string): string {
  return code
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}
