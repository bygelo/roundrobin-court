// The rotation engine — who plays next, on which court, with whom.
//
// Pure and deterministic: no database, no clock, no randomness. The same input
// produces byte-identical output, which is what lets a test replay a whole
// open-play night and what lets the console's "up next" projection be the exact
// group the next rotation will call.
//
// THE FAIRNESS RULE (also served verbatim as `fairness_rule` and shown in the UI)
//
//   1. Fewest games first. A player's count is the games they have finished,
//      plus any credit given on a late arrival: someone who checks in after play
//      has started is credited with the fewest games anyone present has played,
//      so they join the front tier without jumping the whole night.
//   2. Then longest waiting: time since their last game finished, or since
//      check-in if they have not played yet.
//   3. Then earliest check-in.
//   4. Then entry id — never reached by real timestamps; it only makes the
//      order total, so the result is identical on every run.
//
// Free courts fill in court order, taking the next full group from the front
// of that order (four for doubles, two for singles). Who plays is decided by
// the order alone. Within a court's group, teams are split so nobody partners
// the same player as in their previous game when another split allows it —
// and, among equally good splits, with the fewest repeated opponents. In
// doubles a split with no repeated partner always exists, because each player
// had exactly one previous partner.

export type PlayFormat = 'doubles' | 'singles'

export const SEAT_COUNT: Record<PlayFormat, number> = { doubles: 4, singles: 2 }

export const FAIRNESS_RULE =
  'Players are called in a fixed order: fewest games played first (a late arrival is credited with the fewest games anyone present has played), then whoever has waited longest since their last game ended or since check-in, then earliest check-in. Free courts fill in court order with the next full group. Within a court, teams are split so nobody partners the same player as their last game whenever another split allows it.'

export type EngineEntry = {
  play_entry_id: string
  display_name: string
  /** ISO timestamp. */
  checked_in_at: string
  game_count: number
  credit_count: number
  /** ISO timestamp of the end of their last finished game, or null. */
  last_finished_at: string | null
  /** Partner(s) in their most recent finished game. */
  recent_partner_id: string[]
  /** Opponent(s) in their most recent finished game. */
  recent_opponent_id: string[]
}

export type EngineCourt = {
  resource_id: string
  position: number
}

export type EngineInput = {
  format_code: PlayFormat
  /** Courts with no unfinished game. */
  free_court: EngineCourt[]
  /** Players checked in and waiting — not playing, not waitlisted, not gone. */
  entry: EngineEntry[]
}

export type EngineAssignment = {
  resource_id: string
  /** Every player on the court, in fairness order. */
  play_entry_id: string[]
  /** Two teams; each is a list of entry ids. */
  team: [string[], string[]]
}

export type EngineOutput = {
  assignment: EngineAssignment[]
  /** The group the next free court would call, if nobody else came back first. */
  up_next: string[]
  /** Everyone still waiting after this rotation, in fairness order. */
  queue: string[]
}

function time(iso: string): number {
  return Date.parse(iso)
}

/** Rotation count: games finished plus late-arrival credit. */
export function rotationCount(entry: EngineEntry): number {
  return entry.game_count + entry.credit_count
}

/** When this player started waiting. */
export function waitingSince(entry: EngineEntry): string {
  return entry.last_finished_at ?? entry.checked_in_at
}

/** The total order of the fairness rule. Negative when `left` plays first. */
export function compareEntry(left: EngineEntry, right: EngineEntry): number {
  return (
    rotationCount(left) - rotationCount(right) ||
    time(waitingSince(left)) - time(waitingSince(right)) ||
    time(left.checked_in_at) - time(right.checked_in_at) ||
    (left.play_entry_id < right.play_entry_id ? -1 : left.play_entry_id > right.play_entry_id ? 1 : 0)
  )
}

export function orderQueue(entry: EngineEntry[]): EngineEntry[] {
  return [...entry].sort(compareEntry)
}

// The three ways to split four players into two pairs, in preference order.
const DOUBLES_SPLIT: [[number, number], [number, number]][] = [
  [[0, 1], [2, 3]],
  [[0, 2], [1, 3]],
  [[0, 3], [1, 2]],
]

/** Split a group into two teams, avoiding repeated partners, then opponents. */
export function splitTeam(group: EngineEntry[], format_code: PlayFormat): [string[], string[]] {
  if (format_code === 'singles' || group.length !== 4) {
    const half = Math.ceil(group.length / 2)
    return [group.slice(0, half).map((one) => one.play_entry_id), group.slice(half).map((one) => one.play_entry_id)]
  }
  const was = (a: EngineEntry, b: EngineEntry, key: 'recent_partner_id' | 'recent_opponent_id') =>
    a[key].includes(b.play_entry_id) || b[key].includes(a.play_entry_id)

  let best: { split: [[number, number], [number, number]]; partner: number; opponent: number } | undefined
  for (const split of DOUBLES_SPLIT) {
    const [one, two] = split
    const at = (index: number) => group[index]!
    let partner = 0
    for (const pair of [one, two]) if (was(at(pair[0]), at(pair[1]), 'recent_partner_id')) partner += 1
    let opponent = 0
    for (const a of one) for (const b of two) if (was(at(a), at(b), 'recent_opponent_id')) opponent += 1
    if (!best || partner < best.partner || (partner === best.partner && opponent < best.opponent)) {
      best = { split, partner, opponent }
    }
  }
  const [one, two] = best!.split
  return [one.map((index) => group[index]!.play_entry_id), two.map((index) => group[index]!.play_entry_id)]
}

/** Fill every free court from the fairness order. */
export function planRotation(input: EngineInput): EngineOutput {
  const seat = SEAT_COUNT[input.format_code]
  const queue = orderQueue(input.entry)
  const court = [...input.free_court].sort(
    (left, right) => left.position - right.position || (left.resource_id < right.resource_id ? -1 : 1),
  )

  const assignment: EngineAssignment[] = []
  let cursor = 0
  for (const one of court) {
    if (queue.length - cursor < seat) break
    const group = queue.slice(cursor, cursor + seat)
    cursor += seat
    assignment.push({
      resource_id: one.resource_id,
      play_entry_id: group.map((each) => each.play_entry_id),
      team: splitTeam(group, input.format_code),
    })
  }

  const rest = queue.slice(cursor)
  return {
    assignment,
    up_next: rest.slice(0, seat).map((one) => one.play_entry_id),
    queue: rest.map((one) => one.play_entry_id),
  }
}

/**
 * Credit for a player joining a session already under way: the fewest games
 * (rotation count) anyone currently present has, or 0 when nobody is.
 */
export function lateArrivalCredit(present: Pick<EngineEntry, 'game_count' | 'credit_count'>[]): number {
  if (present.length === 0) return 0
  return Math.min(...present.map((one) => one.game_count + one.credit_count))
}

/** "Maria Santos Cruz" → "Maria C." — what a public screen may show. */
export function publicName(display_name: string): string {
  const part = display_name.trim().split(/\s+/).filter(Boolean)
  if (part.length === 0) return 'Player'
  if (part.length === 1) return part[0]!
  return `${part[0]} ${part[part.length - 1]!.charAt(0).toUpperCase()}.`
}
