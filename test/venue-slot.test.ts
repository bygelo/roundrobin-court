// DB-free checks for the venue lane: slot generation, zone arithmetic, and the
// R08 static rule that no court service file names a sport.

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  addDay,
  generateSlot,
  isDateKey,
  isoWeekday,
  localDateKey,
  parseTimeMinute,
  readMoney,
  zonedToInstant,
} from '../src/module/court/time.ts'

const DAILY = [1, 2, 3, 4, 5, 6, 7].map((weekday_number) => ({ weekday_number, opens_local: '06:00', closes_local: '23:00' }))
const PEAK = [
  ...[1, 2, 3, 4, 5].map((weekday_number) => ({ weekday_number, starts_local: '17:00', ends_local: '22:00' })),
  ...[6, 7].map((weekday_number) => ({ weekday_number, starts_local: '00:00', ends_local: '24:00' })),
]

describe('slot generation', () => {
  it('fits 60, 90, and 120-minute slots inside opening hours and never past closing', () => {
    const count = (slot_minute_count: number) =>
      generateSlot({ operating_hour: DAILY, peak: [], slot_minute_count, off_peak_price_amount: '400.00', peak_price_amount: '600.00' })
    // 06:00–23:00 is 17 hours.
    assert.equal(count(60).length, 17 * 7)
    assert.equal(count(90).length, 11 * 7) // 11 × 90 = 990 min ≤ 1020
    assert.equal(count(120).length, 8 * 7) // 8 × 120 = 960 min ≤ 1020
    const last = count(90).filter((one) => one.weekday_number === 1).at(-1)!
    assert.equal(last.starts_local, '21:00')
    assert.equal(last.ends_local, '22:30')
    assert.equal(last.end_day_offset, 0)
  })

  it('expresses a slot that ends at midnight as 00:00 on the next day', () => {
    const slot = generateSlot({
      operating_hour: [{ weekday_number: 5, opens_local: '06:00', closes_local: '24:00' }],
      peak: [],
      slot_minute_count: 90,
      off_peak_price_amount: '400.00',
      peak_price_amount: '600.00',
    })
    assert.equal(slot.length, 12)
    const last = slot.at(-1)!
    assert.equal(last.starts_local, '22:30')
    assert.equal(last.ends_local, '00:00')
    assert.equal(last.end_day_offset, 1)
  })

  it('prices a slot by where it starts: weekday evenings and weekends are peak', () => {
    const slot = generateSlot({ operating_hour: DAILY, peak: PEAK, slot_minute_count: 60, off_peak_price_amount: '400.00', peak_price_amount: '600.00' })
    const at = (weekday_number: number, starts_local: string) =>
      slot.find((one) => one.weekday_number === weekday_number && one.starts_local === starts_local)!
    assert.equal(at(1, '16:00').price_amount, '400.00')
    assert.equal(at(1, '17:00').price_amount, '600.00')
    assert.equal(at(1, '21:00').price_amount, '600.00')
    assert.equal(at(1, '22:00').price_amount, '400.00')
    assert.equal(at(6, '06:00').price_amount, '600.00')
    assert.equal(at(7, '22:00').is_peak, true)
  })

  it('sells nothing on a weekday with no hours', () => {
    const slot = generateSlot({
      operating_hour: [{ weekday_number: 2, opens_local: '08:00', closes_local: '10:00' }],
      peak: [],
      slot_minute_count: 60,
      off_peak_price_amount: '1.00',
      peak_price_amount: '1.00',
    })
    assert.deepEqual([...new Set(slot.map((one) => one.weekday_number))], [2])
    assert.equal(slot.length, 2)
  })
})

describe('venue time zone arithmetic', () => {
  it('turns Manila wall time into the right instant', () => {
    assert.equal(zonedToInstant('2026-09-14', '06:00', 'Asia/Manila').toISOString(), '2026-09-13T22:00:00.000Z')
    assert.equal(localDateKey(new Date('2026-09-13T22:00:00Z'), 'Asia/Manila'), '2026-09-14')
  })

  it('reads dates, weekdays, times, and money strictly', () => {
    assert.equal(isoWeekday('2026-09-13'), 7)
    assert.equal(isoWeekday('2026-09-14'), 1)
    assert.equal(addDay('2026-12-31', 1), '2027-01-01')
    assert.equal(isDateKey('2026-02-30'), false)
    assert.equal(parseTimeMinute('24:00'), 1440)
    assert.equal(readMoney('400'), '400.00')
    assert.equal(readMoney('-1'), undefined)
    assert.equal(readMoney('4e2'), undefined)
  })
})

describe('R08 — a sport is data, never a branch', () => {
  it('no court service file names a sport outside the profile definition', () => {
    const directory = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'module', 'court')
    const offender: string[] = []
    for (const file of readdirSync(directory)) {
      if (!file.endsWith('.ts') || file === 'sport.ts') continue
      const text = readFileSync(join(directory, file), 'utf8')
      for (const [index, line] of text.split('\n').entries()) {
        if (/pickleball|tennis|badminton|padel/i.test(line)) offender.push(`${file}:${index + 1}: ${line.trim()}`)
      }
    }
    assert.deepEqual(offender, [])
  })
})
