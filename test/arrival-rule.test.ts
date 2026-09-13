// Pure arrival rules — no database.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { checkInWindow, describeEligibility, hashCredential, mintCredential, waiverState } from '../src/module/arrival/rule.ts'

describe('arrival rules', () => {
  const starts_at = new Date('2026-09-15T10:00:00Z')
  const ends_at = new Date('2026-09-15T11:30:00Z')

  it('opens self check-in exactly 60 minutes before start and closes at the end', () => {
    assert.equal(checkInWindow(starts_at, ends_at, new Date('2026-09-15T08:59:59Z')).window_status, 'early')
    assert.equal(checkInWindow(starts_at, ends_at, new Date('2026-09-15T09:00:00Z')).window_status, 'open')
    assert.equal(checkInWindow(starts_at, ends_at, new Date('2026-09-15T11:29:59Z')).window_status, 'open')
    assert.equal(checkInWindow(starts_at, ends_at, new Date('2026-09-15T11:30:00Z')).window_status, 'ended')
  })

  it('reads waiver state against the current version', () => {
    assert.equal(waiverState(null, null), 'not_required')
    assert.equal(waiverState(2, null), 'missing')
    assert.equal(waiverState(2, 1), 'outdated')
    assert.equal(waiverState(2, 2), 'current')
  })

  it('writes one sentence naming every blocker', () => {
    const ok = describeEligibility({
      paid_state: 'paid',
      waiver_state: 'current',
      is_member_only: false,
      is_member: false,
      min_rating: '3.5',
      rating_provider_code: 'dupr',
    })
    assert.equal(ok.is_eligible, true)
    assert.match(ok.sentence, /DUPR 3\.5\+/)

    const blocked = describeEligibility({
      paid_state: 'unpaid',
      waiver_state: 'outdated',
      is_member_only: true,
      is_member: false,
      min_rating: null,
      rating_provider_code: null,
    })
    assert.equal(blocked.is_eligible, false)
    assert.deepEqual(blocked.blocker, ['unpaid', 'waiver_outdated', 'member_only'])
    assert.match(blocked.sentence, /has not paid, signed an older waiver and is not an active member/)
  })

  it('mints unguessable credentials and stores only a hash', () => {
    const one = mintCredential()
    assert.notEqual(one, mintCredential())
    assert.ok(one.length >= 24)
    assert.equal(hashCredential(one), hashCredential(one))
    assert.notEqual(hashCredential(one), one)
  })
})
