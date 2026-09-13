// CSV writing and the journal account mapping. Pure — unit tested without a
// database.

/**
 * RFC 4180: CRLF line endings, a field is quoted when it holds a comma, a
 * double quote, CR or LF, and a quote inside a quoted field is doubled.
 *
 * Text cells (never amounts) that begin with = + - @ are prefixed with an
 * apostrophe so a spreadsheet does not run them as a formula. Amount columns
 * are passed as `number_column` and left exactly as the database wrote them,
 * so an importer reads "-250.00" as a number.
 */
export function toCsv(header: string[], row: (string | number | null | undefined)[][], number_column: string[] = []): string {
  const numeric = new Set(number_column.map((name) => header.indexOf(name)).filter((index) => index >= 0))
  const line = [header.map((one) => csvCell(one, false))]
  for (const one of row) line.push(one.map((value, index) => csvCell(value, !numeric.has(index))))
  return `${line.map((one) => one.join(',')).join('\r\n')}\r\n`
}

export function csvCell(value: string | number | null | undefined, is_text = true): string {
  let text = value === null || value === undefined ? '' : String(value)
  if (is_text && /^[=+\-@]/.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export type SourceCode = 'court_booking' | 'program' | 'shop' | 'membership' | 'other'

export const REVENUE_SOURCE: { source_code: SourceCode; display_name: string; account_code: string }[] = [
  { source_code: 'court_booking', display_name: 'Court booking', account_code: '4000' },
  { source_code: 'program', display_name: 'Program', account_code: '4100' },
  { source_code: 'shop', display_name: 'Shop', account_code: '4200' },
  { source_code: 'membership', display_name: 'Membership and pass', account_code: '4300' },
  { source_code: 'other', display_name: 'Other', account_code: '4800' },
]

export function isSourceCode(value: unknown): value is SourceCode {
  return REVENUE_SOURCE.some((one) => one.source_code === value)
}

export function sourceName(source_code: string | null): string {
  return REVENUE_SOURCE.find((one) => one.source_code === source_code)?.display_name ?? 'Other'
}

/**
 * The chart the journal export posts to. An accountant maps these codes onto
 * their own chart once, at import.
 *
 *   Cash / clearing (debited when money arrives, credited when it goes back),
 *   chosen by payment method:
 *     1000 Cash on Hand            method cash, or collection mode cash_pos
 *     1010 E-wallet Clearing       method gcash / maya
 *     1020 Card Clearing           method card / card_terminal
 *     1030 Online Payment Clearing method online, or collection mode processor_auto
 *     1040 Bank and Other Clearing bank transfer, proof review, manual record, payment centre
 *     1090 Shop Register Clearing  a shop order with no billing payment behind it
 *   Revenue (credited when money arrives), chosen by source:
 *     4000 Court Rental Revenue · 4100 Program Revenue · 4200 Merchandise Sales
 *     4300 Membership Revenue · 4800 Other Revenue
 *   4900 Refunds (contra-revenue, debited when money goes back)
 */
export const JOURNAL_ACCOUNT: { account_code: string; account_name: string; account_kind: 'asset' | 'revenue' | 'contra_revenue'; rule: string }[] = [
  { account_code: '1000', account_name: 'Cash on Hand', account_kind: 'asset', rule: 'Cash taken at the desk' },
  { account_code: '1010', account_name: 'E-wallet Clearing', account_kind: 'asset', rule: 'GCash and Maya' },
  { account_code: '1020', account_name: 'Card Clearing', account_kind: 'asset', rule: 'Card terminal and card payments' },
  { account_code: '1030', account_name: 'Online Payment Clearing', account_kind: 'asset', rule: 'Online checkout and payment processor' },
  { account_code: '1040', account_name: 'Bank and Other Clearing', account_kind: 'asset', rule: 'Bank transfer, proof of payment, manual record, payment centre' },
  { account_code: '1090', account_name: 'Shop Register Clearing', account_kind: 'asset', rule: 'Shop orders with no recorded payment' },
  { account_code: '4000', account_name: 'Court Rental Revenue', account_kind: 'revenue', rule: 'Court booking payments' },
  { account_code: '4100', account_name: 'Program Revenue', account_kind: 'revenue', rule: 'Clinics, leagues, and other programs' },
  { account_code: '4200', account_name: 'Merchandise Sales', account_kind: 'revenue', rule: 'Shop sales' },
  { account_code: '4300', account_name: 'Membership Revenue', account_kind: 'revenue', rule: 'Memberships and passes' },
  { account_code: '4800', account_name: 'Other Revenue', account_kind: 'revenue', rule: 'Payments not linked to a booking, program, sale, or membership' },
  { account_code: '4900', account_name: 'Refunds', account_kind: 'contra_revenue', rule: 'Every refund and cancelled shop order' },
]

export function accountName(account_code: string): string {
  return JOURNAL_ACCOUNT.find((one) => one.account_code === account_code)?.account_name ?? account_code
}

const EVENT_LABEL: Record<string, string> = {
  payment: 'payment',
  refund: 'refund',
  order: 'shop order',
  order_cancel: 'shop order cancelled',
}

export function journalMemo(input: { event_kind: string; source_code: string | null; party_name: string | null; reference: string }): string {
  const what = input.source_code ? `${sourceName(input.source_code)} ${EVENT_LABEL[input.event_kind] ?? input.event_kind}` : titleFirst(EVENT_LABEL[input.event_kind] ?? input.event_kind)
  return [what.charAt(0).toUpperCase() + what.slice(1), input.party_name].filter(Boolean).join(' — ')
}

function titleFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** Amount string "1234.50" / "-12.00" → integer centavos, without floating point. */
export function toCentavo(amount: string): bigint {
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(amount.trim())
  if (!match) throw new Error(`not an amount: ${amount}`)
  const value = BigInt(match[2]!) * 100n + BigInt((match[3] ?? '').padEnd(2, '0'))
  return match[1] ? -value : value
}

export function fromCentavo(value: bigint): string {
  const sign = value < 0n ? '-' : ''
  const absolute = value < 0n ? -value : value
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`
}
