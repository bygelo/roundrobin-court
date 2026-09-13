// Pure recurrence logic — no database.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  addDay,
  describeRuleProblem,
  isoWeekday,
  localDate,
  planOccurrence,
  zonedInstant,
  type ScheduleRule,
} from '../src/module/program/schedule.ts'

const clinic: ScheduleRule = {
  schedule_code: 'weekly',
  weekday_number: [2, 4],
  first_date: '2026-09-14',
  until_date: '2026-09-30',
  starts_local: '18:00',
  ends_local: '19:30',
  skipped_date: ['2026-09-17'],
  time_zone: 'Asia/Manila',
}

describe('program schedule', () => {
  it('converts venue wall-clock time to an instant', () => {
    assert.equal(zonedInstant('2026-09-15', '18:00', 'Asia/Manila').toISOString(), '2026-09-15T10:00:00.000Z')
    // A DST zone on both sides of its change.
    assert.equal(zonedInstant('2026-01-15', '09:00', 'America/New_York').toISOString(), '2026-01-15T14:00:00.000Z')
    assert.equal(zonedInstant('2026-07-15', '09:00', 'America/New_York').toISOString(), '2026-07-15T13:00:00.000Z')
    assert.equal(localDate(new Date('2026-09-14T17:30:00Z'), 'Asia/Manila'), '2026-09-15')
  })

  it('knows ISO weekdays and adds days across a month', () => {
    assert.equal(isoWeekday('2026-09-13'), 7)
    assert.equal(isoWeekday('2026-09-14'), 1)
    assert.equal(addDay('2026-09-30', 1), '2026-10-01')
  })

  it('materializes a weekly rule with an exception date', () => {
    const planned = planOccurrence(clinic, { from_date: '2026-09-01', to_date: '2026-12-31' })
    assert.deepEqual(
      planned.map((one) => one.occurrence_date),
      ['2026-09-15', '2026-09-22', '2026-09-24', '2026-09-29'],
      'Tue/Thu until the 30th, minus the skipped Thursday the 17th',
    )
    assert.equal(planned[0]!.ends_at.toISOString(), '2026-09-15T11:30:00.000Z')
  })

  it('clips to the requested window and plans a one-off once', () => {
    assert.equal(planOccurrence(clinic, { from_date: '2026-09-23', to_date: '2026-09-25' }).length, 1)
    const once: ScheduleRule = { ...clinic, schedule_code: 'once', weekday_number: [], until_date: null, skipped_date: [] }
    assert.deepEqual(planOccurrence(once, { from_date: '2026-09-01', to_date: '2026-09-30' }).map((one) => one.occurrence_date), ['2026-09-14'])
    assert.equal(planOccurrence(once, { from_date: '2026-09-15', to_date: '2026-09-30' }).length, 0)
  })

  it('refuses rules a person could mistype', () => {
    assert.equal(describeRuleProblem(clinic), undefined)
    assert.match(describeRuleProblem({ ...clinic, weekday_number: [] })!, /weekday/)
    assert.match(describeRuleProblem({ ...clinic, until_date: null })!, /until/)
    assert.match(describeRuleProblem({ ...clinic, ends_local: '17:00' })!, /after/)
    assert.match(describeRuleProblem({ ...clinic, first_date: '2026-02-30' })!, /start date/)
    assert.match(describeRuleProblem({ ...clinic, until_date: '2028-01-01' })!, /400 days/)
  })
})
