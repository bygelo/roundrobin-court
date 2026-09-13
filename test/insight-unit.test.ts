// Insight pure rules — no database.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { JOURNAL_ACCOUNT, REVENUE_SOURCE, csvCell, fromCentavo, journalMemo, toCentavo, toCsv } from '../src/module/insight/csv.ts'
import { InsightRangeError, addDay, dayCount, isDateKey, rateText, resolveRangeInput } from '../src/module/insight/range.ts'

describe('insight CSV', () => {
  it('writes RFC 4180: CRLF, quotes only when needed, doubled inner quotes', () => {
    const csv = toCsv(['name', 'note', 'amount'], [
      ['Court 1', 'plain', '100.00'],
      ['Ana, "Coach"', 'line\nbreak', '-25.50'],
    ], ['amount'])
    assert.equal(csv, 'name,note,amount\r\nCourt 1,plain,100.00\r\n"Ana, ""Coach""","line\nbreak",-25.50\r\n')
  })

  it('neutralises spreadsheet formulas in text but never in amount columns', () => {
    assert.equal(csvCell('=SUM(A1)'), "'=SUM(A1)")
    assert.equal(csvCell('@cmd'), "'@cmd")
    assert.equal(csvCell('-250.00', false), '-250.00')
    assert.equal(csvCell(null), '')
  })

  it('maps every revenue source to exactly one journal revenue account', () => {
    for (const one of REVENUE_SOURCE) {
      const account = JOURNAL_ACCOUNT.find((each) => each.account_code === one.account_code)
      assert.equal(account?.account_kind, 'revenue', one.source_code)
    }
    assert.ok(JOURNAL_ACCOUNT.some((one) => one.account_code === '4900' && one.account_kind === 'contra_revenue'))
    assert.equal(new Set(JOURNAL_ACCOUNT.map((one) => one.account_code)).size, JOURNAL_ACCOUNT.length)
  })

  it('converts amounts to centavos without floating point', () => {
    assert.equal(toCentavo('2900.25'), 290025n)
    assert.equal(toCentavo('-99.5'), -9950n)
    assert.equal(fromCentavo(toCentavo('0.10') + toCentavo('0.20')), '0.30')
    assert.throws(() => toCentavo('1e3'))
  })

  it('writes a readable memo', () => {
    assert.equal(journalMemo({ event_kind: 'refund', source_code: 'court_booking', party_name: 'Ana Cruz', reference: 'pay_1' }), 'Court booking refund — Ana Cruz')
    assert.equal(journalMemo({ event_kind: 'payment', source_code: null, party_name: null, reference: 'pay_1' }), 'Payment')
  })
})

describe('insight range', () => {
  const today = '2027-03-10'

  it('defaults to the last 7 days ending today', () => {
    assert.deepEqual(resolveRangeInput({}, today), { from: '2027-03-04', to: '2027-03-10', day_count: 7 })
  })

  it('treats one given date as a single day', () => {
    assert.deepEqual(resolveRangeInput({ from: '2027-02-01' }, today), { from: '2027-02-01', to: '2027-02-01', day_count: 1 })
    assert.deepEqual(resolveRangeInput({ to: '2027-02-01' }, today), { from: '2027-02-01', to: '2027-02-01', day_count: 1 })
  })

  it('refuses malformed dates, reversed ranges, and ranges over 366 days', () => {
    assert.throws(() => resolveRangeInput({ from: '2027-02-30', to: today }, today), InsightRangeError)
    assert.throws(() => resolveRangeInput({ from: '10/03/2027', to: today }, today), InsightRangeError)
    assert.throws(() => resolveRangeInput({ from: '2027-03-11', to: today }, today), /on or after/)
    assert.throws(() => resolveRangeInput({ from: '2026-01-01', to: '2027-01-02' }, today), /at most 366/)
    assert.equal(resolveRangeInput({ from: '2028-01-01', to: '2028-12-31' }, today).day_count, 366)
  })

  it('knows the calendar', () => {
    assert.equal(isDateKey('2028-02-29'), true)
    assert.equal(isDateKey('2027-02-29'), false)
    assert.equal(addDay('2027-12-31', 1), '2028-01-01')
    assert.equal(dayCount('2027-03-01', '2027-03-31'), 31)
  })

  it('writes rates as 4-decimal strings and refuses to divide by zero', () => {
    assert.equal(rateText(5, 7), '0.7143')
    assert.equal(rateText(1, 4), '0.2500')
    assert.equal(rateText(3, 3), '1.0000')
    assert.equal(rateText(0, 0), null)
  })
})
