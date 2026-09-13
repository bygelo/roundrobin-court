// Pure money and stock-label rules for the counter. No database.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { changeDue, displayPeso, fromCentavo, stockStatus, toCentavo } from '../src/module/shop/money.ts'

describe('shop money', () => {
  it('parses exact amounts to centavo and back', () => {
    assert.equal(toCentavo('9500'), 950000)
    assert.equal(toCentavo('0.1'), 10)
    assert.equal(toCentavo('40.05'), 4005)
    assert.equal(toCentavo(650.5), 65050)
    assert.equal(fromCentavo(950000), '9500.00')
    assert.equal(fromCentavo(5), '0.05')
    assert.equal(displayPeso(950000), '₱9,500.00')
  })

  it('refuses negative, junk, and sub-centavo amounts', () => {
    assert.throws(() => toCentavo('-1'))
    assert.throws(() => toCentavo('12.345'))
    assert.throws(() => toCentavo('abc'))
    assert.throws(() => toCentavo(undefined))
    assert.throws(() => toCentavo(Number.NaN))
  })

  it('computes change due exactly, where floats would drift', () => {
    // 0.1 + 0.2 style: ₱40.10 × 3 = ₱120.30, tendered ₱200
    assert.equal(fromCentavo(changeDue(toCentavo('40.10') * 3, toCentavo('200'))), '79.70')
    assert.equal(changeDue(30000, 30000), 0)
    assert.throws(() => changeDue(30000, 29999), /does not cover/)
  })

  it('labels stock against the low-stock threshold', () => {
    assert.equal(stockStatus(0, 5, true), 'out')
    assert.equal(stockStatus(null, 5, true), 'out')
    assert.equal(stockStatus(5, 5, true), 'low')
    assert.equal(stockStatus(6, 5, true), 'in_stock')
    assert.equal(stockStatus(0, 5, false), 'untracked')
  })
})
