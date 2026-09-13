// Pure membership rules: price arithmetic, sentences, and venue-local calendar
// math. No database.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  addDay,
  addMonth,
  applyPriceRule,
  isDate,
  localDate,
  memberStatus,
  periodEnd,
  ruleSentence,
  startOfLocalDay,
} from '../src/module/member/rule.ts'

describe('member price rule', () => {
  it('applies percent off in centavo, rounding the discount', () => {
    assert.equal(applyPriceRule(50000, { price_rule_code: 'percent_off', percent_off: '20', fixed_price_amount: null }), 40000)
    // ₱333.33 at 15% off: discount 49.9995 → 50.00
    assert.equal(applyPriceRule(33333, { price_rule_code: 'percent_off', percent_off: '15.00', fixed_price_amount: null }), 28333)
    assert.equal(applyPriceRule(50000, { price_rule_code: 'percent_off', percent_off: '100', fixed_price_amount: null }), 0)
  })

  it('never lets a fixed member price exceed the base price', () => {
    assert.equal(applyPriceRule(50000, { price_rule_code: 'fixed_price', percent_off: null, fixed_price_amount: '300.00' }), 30000)
    assert.equal(applyPriceRule(20000, { price_rule_code: 'fixed_price', percent_off: null, fixed_price_amount: '300.00' }), 20000)
    assert.equal(applyPriceRule(20000, { price_rule_code: 'none', percent_off: null, fixed_price_amount: null }), 20000)
  })

  it('reads a plan as a sentence', () => {
    const base = { percent_off: null, fixed_price_amount: null, is_member_session_access: false, session_count: null, valid_day_count: null }
    assert.equal(
      ruleSentence({ ...base, plan_kind_code: 'membership', price_rule_code: 'percent_off', percent_off: '20.00', is_member_session_access: true }),
      '20% off every court booking · can book members-only sessions',
    )
    assert.equal(
      ruleSentence({ ...base, plan_kind_code: 'membership', price_rule_code: 'fixed_price', fixed_price_amount: '300.00' }),
      'Court bookings at ₱300.00 each',
    )
    assert.equal(
      ruleSentence({ ...base, plan_kind_code: 'pass', price_rule_code: 'none', session_count: 10, valid_day_count: 60 }),
      '10 sessions, valid 60 days — each booking uses one',
    )
  })
})

describe('member calendar', () => {
  it('starts a local day at local midnight, not UTC midnight', () => {
    assert.equal(startOfLocalDay('2027-04-01', 'Asia/Manila').toISOString(), '2027-03-31T16:00:00.000Z')
    assert.equal(startOfLocalDay('2027-04-01', 'UTC').toISOString(), '2027-04-01T00:00:00.000Z')
    // Across a DST change: New York is UTC-4 on 2027-03-15.
    assert.equal(startOfLocalDay('2027-03-15', 'America/New_York').toISOString(), '2027-03-15T04:00:00.000Z')
  })

  it('reads the local date of an instant', () => {
    // 07:00 in Manila on April 1 is still March 31 in UTC.
    assert.equal(localDate(new Date('2027-03-31T23:00:00Z'), 'Asia/Manila'), '2027-04-01')
    assert.equal(localDate(new Date('2027-03-31T23:00:00Z'), 'UTC'), '2027-03-31')
  })

  it('adds days and clamped months', () => {
    assert.equal(addDay('2026-12-31', 1), '2027-01-01')
    assert.equal(addMonth('2027-01-31', 1), '2027-02-28')
    assert.equal(addMonth('2027-03-31', -1), '2027-02-28')
    assert.equal(periodEnd('2027-03-01', 'monthly'), '2027-04-01')
    assert.equal(periodEnd('2027-03-01', 'annual'), '2028-03-01')
    assert.equal(isDate('2027-02-30'), false)
    assert.equal(isDate('2027-02-28'), true)
  })

  it('derives expiring and expired from the clock', () => {
    const now = new Date('2027-03-01T00:00:00Z')
    assert.equal(memberStatus({ status: 'active', ends_at: new Date('2027-03-06T00:00:00Z'), now }), 'expiring')
    assert.equal(memberStatus({ status: 'active', ends_at: new Date('2027-03-20T00:00:00Z'), now }), 'active')
    assert.equal(memberStatus({ status: 'active', ends_at: new Date('2027-02-28T00:00:00Z'), now }), 'expired')
    assert.equal(memberStatus({ status: 'frozen', ends_at: null, now }), 'frozen')
    assert.equal(memberStatus({ status: null, ends_at: null, now }), 'pass_only')
  })
})
