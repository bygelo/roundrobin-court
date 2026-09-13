// Exact money for the counter. Every amount crosses the API as a '1500.00'
// string and every calculation happens in integer centavo, so a change-due is
// never off by a floating-point cent.

import { DomainError } from '@bygelo/roundrobin-kernel'

export class MoneyError extends DomainError {
  constructor(message: string) {
    super(message, 400)
  }
}

const MONEY_PATTERN = /^\d{1,10}(\.\d{1,2})?$/

/** '9500' | '9500.5' | 9500.5 → 950050. Refuses negatives, junk, and sub-centavo precision. */
export function toCentavo(value: unknown, label = 'amount'): number {
  const text = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : typeof value === 'string' ? value.trim() : ''
  if (!MONEY_PATTERN.test(text)) {
    throw new MoneyError(`${label} must be a non-negative amount with at most two decimal places`)
  }
  const [whole = '0', fraction = ''] = text.split('.')
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
}

/** 950050 → '9500.50'. */
export function fromCentavo(centavo: number): string {
  const sign = centavo < 0 ? '-' : ''
  const absolute = Math.abs(Math.round(centavo))
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`
}

/** '₱9,500.00' for sentences a person reads (errors, receipts). */
export function displayPeso(centavo: number): string {
  const [whole = '0', fraction = '00'] = fromCentavo(centavo).split('.')
  return `₱${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction}`
}

/**
 * Change due for a cash sale. Refuses a tender that does not cover the total,
 * because a counter that "owes" the customer negative change has mis-keyed.
 */
export function changeDue(total_centavo: number, tendered_centavo: number): number {
  if (tendered_centavo < total_centavo) {
    throw new MoneyError(`Tendered ${displayPeso(tendered_centavo)} does not cover the ${displayPeso(total_centavo)} total`)
  }
  return tendered_centavo - total_centavo
}

/** Stock label for a variant: untracked goods never run out. */
export function stockStatus(
  stock_on_hand_count: number | null,
  low_stock_threshold_count: number,
  is_track_inventory: boolean,
): 'in_stock' | 'low' | 'out' | 'untracked' {
  if (!is_track_inventory) return 'untracked'
  const on_hand = stock_on_hand_count ?? 0
  if (on_hand <= 0) return 'out'
  if (on_hand <= low_stock_threshold_count) return 'low'
  return 'in_stock'
}
