// RFC 5545 rendering — pure, no database. CRLF line endings, 75-octet folding,
// UTC instants, escaped TEXT values.

export type IcsStatus = 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED'

export type IcsEvent = {
  uid: string
  sequence: number
  starts_at: Date
  ends_at: Date
  last_modified: Date
  summary: string
  location?: string | null
  description?: string | null
  status: IcsStatus
  is_busy: boolean
}

export type IcsCalendar = {
  calendar_name: string
  event: IcsEvent[]
}

export const PRODID = '-//roundrobin//Court Venue Calendar//EN'

export function escapeText(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll(';', '\\;')
    .replaceAll(',', '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
}

export function formatUtc(value: Date): string {
  return new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

/** Fold to at most 75 octets per physical line, never splitting a UTF-8 character. */
export function foldLine(line: string): string {
  const encoder = new TextEncoder()
  if (encoder.encode(line).length <= 75) return line
  const out: string[] = []
  let current = ''
  let current_octet = 0
  let limit = 75
  for (const character of line) {
    const octet = encoder.encode(character).length
    if (current_octet + octet > limit) {
      out.push(current)
      current = ''
      current_octet = 0
      limit = 74 // continuation lines start with one space
    }
    current += character
    current_octet += octet
  }
  if (current) out.push(current)
  return out.join('\r\n ')
}

export function renderCalendar(calendar: IcsCalendar): string {
  const line: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calendar.calendar_name)}`,
    'X-PUBLISHED-TTL:PT15M',
    'REFRESH-INTERVAL;VALUE=DURATION:PT15M',
  ]
  for (const one of calendar.event) {
    line.push(
      'BEGIN:VEVENT',
      `UID:${one.uid}`,
      `DTSTAMP:${formatUtc(one.last_modified)}`,
      `LAST-MODIFIED:${formatUtc(one.last_modified)}`,
      `DTSTART:${formatUtc(one.starts_at)}`,
      `DTEND:${formatUtc(one.ends_at)}`,
      `SEQUENCE:${Math.max(0, Math.floor(one.sequence))}`,
      `STATUS:${one.status}`,
      `TRANSP:${one.is_busy && one.status !== 'CANCELLED' ? 'OPAQUE' : 'TRANSPARENT'}`,
      `SUMMARY:${escapeText(one.summary)}`,
    )
    if (one.location) line.push(`LOCATION:${escapeText(one.location)}`)
    if (one.description) line.push(`DESCRIPTION:${escapeText(one.description)}`)
    line.push('END:VEVENT')
  }
  line.push('END:VCALENDAR')
  return line.map(foldLine).join('\r\n') + '\r\n'
}
