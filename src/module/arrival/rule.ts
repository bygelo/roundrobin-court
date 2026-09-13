// Pure arrival rules: the self check-in window, waiver state, and the
// eligibility sentence the desk reads. No database, no clock of its own.

import { createHash, randomBytes } from 'node:crypto'

/** Self check-in opens this long before the start. Server-owned, never from the client. */
export const CHECK_IN_LEAD_MINUTE_COUNT = 60

export type WindowStatus = 'early' | 'open' | 'ended'

export function checkInWindow(
  starts_at: Date,
  ends_at: Date,
  now: Date,
): { window_status: WindowStatus; opens_at: Date; closes_at: Date } {
  const opens_at = new Date(starts_at.getTime() - CHECK_IN_LEAD_MINUTE_COUNT * 60000)
  const closes_at = ends_at
  const window_status: WindowStatus =
    now.getTime() < opens_at.getTime() ? 'early' : now.getTime() >= closes_at.getTime() ? 'ended' : 'open'
  return { window_status, opens_at, closes_at }
}

export type WaiverState = 'current' | 'outdated' | 'missing' | 'not_required'

/**
 * current_version_number: the highest published version, or null when the venue
 * has no waiver. accepted_version_number: the highest version this party accepted.
 */
export function waiverState(current_version_number: number | null, accepted_version_number: number | null): WaiverState {
  if (current_version_number === null) return 'not_required'
  if (accepted_version_number === null) return 'missing'
  return accepted_version_number >= current_version_number ? 'current' : 'outdated'
}

export type PaidState = 'paid' | 'unpaid' | 'free'

export type EligibilityInput = {
  paid_state: PaidState
  waiver_state: WaiverState
  is_member_only: boolean
  is_member: boolean
  min_rating: string | null
  rating_provider_code: string | null
}

export type Eligibility = {
  is_eligible: boolean
  /** Short codes for what blocks a one-tap check-in. */
  blocker: ('unpaid' | 'waiver_missing' | 'waiver_outdated' | 'member_only')[]
  /** One sentence a person at the desk can read aloud. */
  sentence: string
}

export function describeEligibility(input: EligibilityInput): Eligibility {
  const blocker: Eligibility['blocker'] = []
  const part: string[] = []
  if (input.paid_state === 'unpaid') {
    blocker.push('unpaid')
    part.push('has not paid')
  }
  if (input.waiver_state === 'missing') {
    blocker.push('waiver_missing')
    part.push('has not signed the waiver')
  }
  if (input.waiver_state === 'outdated') {
    blocker.push('waiver_outdated')
    part.push('signed an older waiver')
  }
  if (input.is_member_only && !input.is_member) {
    blocker.push('member_only')
    part.push('is not an active member')
  }
  const rating_note =
    input.min_rating !== null
      ? ` Check ${(input.rating_provider_code ?? 'rating').toUpperCase()} ${Number(input.min_rating).toFixed(1)}+ at the desk.`
      : ''
  if (blocker.length === 0) {
    return { is_eligible: true, blocker, sentence: `Ready to check in.${rating_note}` }
  }
  const joined = part.length === 1 ? part[0]! : `${part.slice(0, -1).join(', ')} and ${part[part.length - 1]!}`
  return {
    is_eligible: false,
    blocker,
    sentence: `This player ${joined}. Collect it first or override with a reason.${rating_note}`,
  }
}

/** A private action credential: shown once, stored only as its hash. */
export function mintCredential(): string {
  return randomBytes(18).toString('base64url')
}

export function hashCredential(credential: string): string {
  return createHash('sha256').update(credential).digest('hex')
}

/** Waiver evidence: a salted hash of the caller's IP, never the IP itself. */
export function hashAddress(organization_id: string, address: string): string {
  return createHash('sha256').update(`${organization_id}:${address}`).digest('hex')
}
