// The scorer — a pure state machine. No I/O, no clock, no randomness, so the
// same operation sequence always yields the same score (R12: deterministic
// across runs), and the browser can run the identical code while offline.
//
// State is never stored. The database keeps the append-only operation log and
// every read is `replay(profile, operation)`.
//
// Three rule families cover the nine scoring rules the venue lane accepts:
//
//   side_out — traditional pickleball. Only the serving team scores. Doubles:
//              server 1 → server 2 → side out, and each game opens at 0-0-2
//              (the first-serve exception). Singles: any lost rally is a side
//              out. Game to 11/15/21, win by 2.
//   rally    — every rally scores and the rally winner serves. 11/15/21 win by
//              2; badminton 21 win by 2, capped at 30.
//   set      — tennis and padel. Points 0/15/30/40, deuce and advantage; games
//              to 6 win by 2; a tiebreak to 7 (win by 2) at 6-6.
//
// A game (or set) that reaches its winning score is *decided* but not *ended*:
// the scorer confirms with `end_game`, which gives a mis-tap one more chance to
// be undone before ends change. Undo steps back across that boundary exactly.

export const SCORING_RULE_CODE = [
  'side_out_11',
  'side_out_15',
  'side_out_21',
  'rally_11',
  'rally_15',
  'rally_21',
  'badminton_rally_21',
  'tennis_set',
  'padel_set',
] as const

export type ScoringRuleCode = (typeof SCORING_RULE_CODE)[number]
export type TeamNumber = 1 | 2
export type ServerNumber = 1 | 2

export type ScoringProfile = {
  scoring_rule_code: string
  /** Games (or sets) in the match: 1, 3, or 5. */
  best_of_count: number
  /** Players per team. 1 is singles; side-out singles has no server number. */
  team_size_count: number
}

export type ScoreOperation =
  | { kind: 'rally_won'; team_number: TeamNumber }
  | { kind: 'undo' }
  | { kind: 'set_server'; team_number: TeamNumber; server_number?: ServerNumber | null }
  | { kind: 'end_game' }
  | { kind: 'forfeit'; team_number: TeamNumber }

export type ScoreOperationKind = ScoreOperation['kind']

export const SCORE_OPERATION_KIND: readonly ScoreOperationKind[] = [
  'rally_won',
  'undo',
  'set_server',
  'end_game',
  'forfeit',
]

export type GameRecord = {
  game_number: number
  /** Side-out and rally: points. Set family: games in the set. Index 0 is team 1. */
  point: [number, number]
  /** Set family only: the tiebreak points when the set went to 7-6. */
  tiebreak_point: [number, number] | null
  winner_team_number: TeamNumber
}

export type ScoreState = {
  readonly game_number: number
  /** Points in the current game (set family: in the current tennis game or tiebreak). */
  readonly point: readonly [number, number]
  /** Set family: games in the current set. Always [0, 0] otherwise. */
  readonly game_count: readonly [number, number]
  readonly is_tiebreak: boolean
  readonly tiebreak_first_serving_team_number: TeamNumber | null
  /** Who served first in this game — decides who serves first in the next. */
  readonly first_serving_team_number: TeamNumber
  readonly serving_team_number: TeamNumber
  readonly server_number: ServerNumber | null
  readonly is_game_decided: boolean
  readonly game_winner_team_number: TeamNumber | null
  readonly game_history: readonly GameRecord[]
  readonly game_won_count: readonly [number, number]
  readonly winner_team_number: TeamNumber | null
  readonly forfeit_team_number: TeamNumber | null
  readonly is_complete: boolean
  /** Operations in effect (undo removes one). */
  readonly operation_count: number
  /** The state before the last effective operation — what undo returns to. */
  readonly previous: ScoreState | null
}

export type ApplyResult = { is_ok: true; state: ScoreState } | { is_ok: false; reason: string }

/** A profile or a sequence the scorer cannot accept. */
export class ScoreRuleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScoreRuleError'
  }
}

type RuleFamily = 'side_out' | 'rally' | 'set'

type Rule = {
  family: RuleFamily
  /** Points to win a game (side_out, rally). Games to win a set (set). */
  target_count: number
  /** Hard cap: the first to reach it wins regardless of margin. */
  cap_count: number | null
}

const RULE: Record<ScoringRuleCode, Rule> = {
  side_out_11: { family: 'side_out', target_count: 11, cap_count: null },
  side_out_15: { family: 'side_out', target_count: 15, cap_count: null },
  side_out_21: { family: 'side_out', target_count: 21, cap_count: null },
  rally_11: { family: 'rally', target_count: 11, cap_count: null },
  rally_15: { family: 'rally', target_count: 15, cap_count: null },
  rally_21: { family: 'rally', target_count: 21, cap_count: null },
  badminton_rally_21: { family: 'rally', target_count: 21, cap_count: 30 },
  tennis_set: { family: 'set', target_count: 6, cap_count: null },
  padel_set: { family: 'set', target_count: 6, cap_count: null },
}

export function isScoringRuleCode(value: unknown): value is ScoringRuleCode {
  return typeof value === 'string' && Object.hasOwn(RULE, value)
}

/** 'game' for side-out and rally scoring, 'set' for tennis and padel. */
export function unitLabel(profile: ScoringProfile): 'game' | 'set' {
  return readRule(profile).family === 'set' ? 'set' : 'game'
}

/** One-line description a scorer can read: "Side-out scoring to 11, win by 2". */
export function describeRule(profile: ScoringProfile): string {
  const rule = readRule(profile)
  const match = profile.best_of_count === 1 ? 'one ' + unitLabel(profile) : `best of ${profile.best_of_count}`
  if (rule.family === 'side_out') return `Side-out scoring to ${rule.target_count}, win by 2 · ${match}`
  if (rule.family === 'rally') {
    const cap = rule.cap_count ? `, capped at ${rule.cap_count}` : ''
    return `Rally scoring to ${rule.target_count}, win by 2${cap} · ${match}`
  }
  return `Sets to 6 with a tiebreak at 6-6 · ${match}`
}

function readRule(profile: ScoringProfile): Rule {
  if (!isScoringRuleCode(profile.scoring_rule_code)) {
    throw new ScoreRuleError(`the scorer does not know scoring rule "${profile.scoring_rule_code}"`)
  }
  return RULE[profile.scoring_rule_code]
}

export function validateProfile(profile: ScoringProfile): void {
  readRule(profile)
  if (![1, 3, 5].includes(profile.best_of_count)) {
    throw new ScoreRuleError('best_of_count must be 1, 3, or 5')
  }
  if (!Number.isInteger(profile.team_size_count) || profile.team_size_count < 1) {
    throw new ScoreRuleError('team_size_count must be a positive integer')
  }
}

function isDoublesSideOut(profile: ScoringProfile): boolean {
  return readRule(profile).family === 'side_out' && profile.team_size_count >= 2
}

function other(team_number: TeamNumber): TeamNumber {
  return team_number === 1 ? 2 : 1
}

function index(team_number: TeamNumber): 0 | 1 {
  return team_number === 1 ? 0 : 1
}

function bump(pair: readonly [number, number], team_number: TeamNumber): [number, number] {
  return team_number === 1 ? [pair[0] + 1, pair[1]] : [pair[0], pair[1] + 1]
}

function isTeamNumber(value: unknown): value is TeamNumber {
  return value === 1 || value === 2
}

export function createInitialState(profile: ScoringProfile): ScoreState {
  validateProfile(profile)
  return {
    game_number: 1,
    point: [0, 0],
    game_count: [0, 0],
    is_tiebreak: false,
    tiebreak_first_serving_team_number: null,
    first_serving_team_number: 1,
    serving_team_number: 1,
    // The first-serve exception: a doubles side-out game opens at 0-0-2.
    server_number: isDoublesSideOut(profile) ? 2 : null,
    is_game_decided: false,
    game_winner_team_number: null,
    game_history: [],
    game_won_count: [0, 0],
    winner_team_number: null,
    forfeit_team_number: null,
    is_complete: false,
    operation_count: 0,
    previous: null,
  }
}

function winningGame(rule: Rule, point: readonly [number, number]): TeamNumber | null {
  const [one, two] = point
  const high = Math.max(one, two)
  const low = Math.min(one, two)
  const is_won = (high >= rule.target_count && high - low >= 2) || (rule.cap_count !== null && high >= rule.cap_count)
  if (!is_won) return null
  return one > two ? 1 : 2
}

function gamesToWin(profile: ScoringProfile): number {
  return Math.floor(profile.best_of_count / 2) + 1
}

function refuse(reason: string): ApplyResult {
  return { is_ok: false, reason }
}

function accept(before: ScoreState, after: Omit<ScoreState, 'previous' | 'operation_count'>): ApplyResult {
  return { is_ok: true, state: { ...after, operation_count: before.operation_count + 1, previous: before } }
}

function titleUnit(profile: ScoringProfile): string {
  return unitLabel(profile) === 'set' ? 'Set' : 'Game'
}

function decidedScore(state: ScoreState, profile: ScoringProfile): [number, number] {
  return readRule(profile).family === 'set' ? [state.game_count[0], state.game_count[1]] : [state.point[0], state.point[1]]
}

/**
 * Apply one operation. Never throws for a rule violation: an operation the
 * rules refuse comes back as `{ is_ok: false, reason }` in words a scorer reads.
 */
export function applyOperation(state: ScoreState, operation: ScoreOperation, profile: ScoringProfile): ApplyResult {
  const rule = readRule(profile)
  const kind = (operation as { kind?: unknown }).kind

  if (kind === 'undo') {
    if (!state.previous) return refuse('Nothing to undo.')
    return { is_ok: true, state: state.previous }
  }

  if (state.is_complete) return refuse('The match is over.')

  switch (kind) {
    case 'rally_won': {
      const team_number = (operation as { team_number?: unknown }).team_number
      if (!isTeamNumber(team_number)) return refuse('team_number must be 1 or 2.')
      if (state.is_game_decided) {
        const [one, two] = decidedScore(state, profile)
        const unit = unitLabel(profile)
        return refuse(`${titleUnit(profile)} ${state.game_number} is over at ${one}-${two}. End the ${unit} first.`)
      }
      if (rule.family === 'side_out') return rallySideOut(state, team_number, profile, rule)
      if (rule.family === 'rally') return rallyRally(state, team_number, rule)
      return rallySet(state, team_number)
    }

    case 'end_game': {
      if (!state.is_game_decided || state.game_winner_team_number === null) {
        const unit = unitLabel(profile)
        if (rule.family === 'set') {
          return refuse(
            `Set ${state.game_number} is not over — games are ${state.game_count[0]}-${state.game_count[1]}; a set is won at 6 by 2, or 7-6 in a tiebreak.`,
          )
        }
        const cap = rule.cap_count ? ` (or first to ${rule.cap_count})` : ''
        return refuse(
          `${titleUnit(profile)} ${state.game_number} is not over — ${state.point[0]}-${state.point[1]}; a ${unit} is won at ${rule.target_count} by 2${cap}.`,
        )
      }
      return endGame(state, profile, rule)
    }

    case 'set_server': {
      const team_number = (operation as { team_number?: unknown }).team_number
      const server_number = (operation as { server_number?: unknown }).server_number ?? null
      if (!isTeamNumber(team_number)) return refuse('team_number must be 1 or 2.')
      if (state.is_game_decided) return refuse(`${titleUnit(profile)} ${state.game_number} is over. End it first.`)
      if (isDoublesSideOut(profile)) {
        if (server_number !== 1 && server_number !== 2) return refuse('Side-out doubles needs server_number 1 or 2.')
      } else if (server_number !== null) {
        return refuse('Server number applies only to side-out doubles.')
      }
      const next_server = server_number as ServerNumber | null
      if (state.serving_team_number === team_number && state.server_number === next_server) {
        return refuse(`Team ${team_number} is already serving${next_server ? ` from server ${next_server}` : ''}.`)
      }
      const is_opening = state.point[0] === 0 && state.point[1] === 0 && state.game_count[0] === 0 && state.game_count[1] === 0
      return accept(state, {
        ...state,
        serving_team_number: team_number,
        server_number: next_server,
        first_serving_team_number: is_opening ? team_number : state.first_serving_team_number,
        tiebreak_first_serving_team_number:
          state.is_tiebreak && state.point[0] === 0 && state.point[1] === 0 ? team_number : state.tiebreak_first_serving_team_number,
      })
    }

    case 'forfeit': {
      const team_number = (operation as { team_number?: unknown }).team_number
      if (!isTeamNumber(team_number)) return refuse('team_number must be 1 or 2.')
      return accept(state, {
        ...state,
        is_game_decided: false,
        game_winner_team_number: null,
        forfeit_team_number: team_number,
        winner_team_number: other(team_number),
        is_complete: true,
      })
    }

    default:
      return refuse(`"${String(kind)}" is not a scoring operation.`)
  }
}

function rallySideOut(state: ScoreState, team_number: TeamNumber, profile: ScoringProfile, rule: Rule): ApplyResult {
  if (team_number === state.serving_team_number) {
    const point = bump(state.point, team_number)
    const winner = winningGame(rule, point)
    return accept(state, { ...state, point, is_game_decided: winner !== null, game_winner_team_number: winner })
  }
  // The receiving team won the rally: no point, the serve moves.
  if (isDoublesSideOut(profile) && state.server_number === 1) {
    return accept(state, { ...state, server_number: 2 })
  }
  return accept(state, {
    ...state,
    serving_team_number: team_number,
    server_number: isDoublesSideOut(profile) ? 1 : null,
  })
}

function rallyRally(state: ScoreState, team_number: TeamNumber, rule: Rule): ApplyResult {
  const point = bump(state.point, team_number)
  const winner = winningGame(rule, point)
  return accept(state, {
    ...state,
    point,
    serving_team_number: team_number,
    is_game_decided: winner !== null,
    game_winner_team_number: winner,
  })
}

function rallySet(state: ScoreState, team_number: TeamNumber): ApplyResult {
  const point = bump(state.point, team_number)
  const mine = point[index(team_number)]
  const theirs = point[index(other(team_number))]

  if (state.is_tiebreak) {
    const first = state.tiebreak_first_serving_team_number ?? state.serving_team_number
    if (mine >= 7 && mine - theirs >= 2) {
      // Tiebreak won: the set is 7-6. Points stay visible until end_game.
      return accept(state, {
        ...state,
        point,
        game_count: bump(state.game_count, team_number),
        is_game_decided: true,
        game_winner_team_number: team_number,
      })
    }
    // Point 1 is served by `first`, then the serve alternates every two points.
    const next_point_number = point[0] + point[1] + 1
    const serving = Math.floor(next_point_number / 2) % 2 === 1 ? other(first) : first
    return accept(state, { ...state, point, serving_team_number: serving })
  }

  if (!(mine >= 4 && mine - theirs >= 2)) {
    return accept(state, { ...state, point })
  }

  // Game won. The serve alternates every game.
  const game_count = bump(state.game_count, team_number)
  const game_mine = game_count[index(team_number)]
  const game_theirs = game_count[index(other(team_number))]
  const serving = other(state.serving_team_number)
  if (game_mine >= 6 && game_mine - game_theirs >= 2) {
    return accept(state, {
      ...state,
      point: [0, 0],
      game_count,
      serving_team_number: serving,
      is_game_decided: true,
      game_winner_team_number: team_number,
    })
  }
  if (game_count[0] === 6 && game_count[1] === 6) {
    return accept(state, {
      ...state,
      point: [0, 0],
      game_count,
      serving_team_number: serving,
      is_tiebreak: true,
      tiebreak_first_serving_team_number: serving,
    })
  }
  return accept(state, { ...state, point: [0, 0], game_count, serving_team_number: serving })
}

function endGame(state: ScoreState, profile: ScoringProfile, rule: Rule): ApplyResult {
  const winner = state.game_winner_team_number!
  const record: GameRecord = {
    game_number: state.game_number,
    point: decidedScore(state, profile),
    tiebreak_point: rule.family === 'set' && state.is_tiebreak ? [state.point[0], state.point[1]] : null,
    winner_team_number: winner,
  }
  const game_history = [...state.game_history, record]
  const game_won_count = bump(state.game_won_count, winner)

  if (game_won_count[index(winner)] >= gamesToWin(profile)) {
    return accept(state, {
      ...state,
      game_history,
      game_won_count,
      is_game_decided: false,
      game_winner_team_number: null,
      winner_team_number: winner,
      is_complete: true,
    })
  }

  let first_serving: TeamNumber
  if (rule.family === 'side_out') {
    // Teams alternate who opens each game.
    first_serving = other(state.first_serving_team_number)
  } else if (rule.family === 'rally') {
    // The winner of the previous game serves first.
    first_serving = winner
  } else if (state.is_tiebreak) {
    // After a tiebreak, whoever received first in it serves the next set.
    first_serving = other(state.tiebreak_first_serving_team_number ?? state.serving_team_number)
  } else {
    // The per-game alternation already moved the serve on.
    first_serving = state.serving_team_number
  }

  return accept(state, {
    ...state,
    game_number: state.game_number + 1,
    point: [0, 0],
    game_count: [0, 0],
    is_tiebreak: false,
    tiebreak_first_serving_team_number: null,
    first_serving_team_number: first_serving,
    serving_team_number: first_serving,
    server_number: isDoublesSideOut(profile) ? 2 : null,
    is_game_decided: false,
    game_winner_team_number: null,
    game_history,
    game_won_count,
  })
}

/** Replay a stored operation log. Throws ScoreRuleError naming the first refused operation. */
export function replay(profile: ScoringProfile, operation: readonly ScoreOperation[]): ScoreState {
  let state = createInitialState(profile)
  operation.forEach((one, position) => {
    const result = applyOperation(state, one, profile)
    if (!result.is_ok) {
      throw new ScoreRuleError(`operation ${position + 1} (${String((one as { kind?: unknown }).kind)}): ${result.reason}`)
    }
    state = result.state
  })
  return state
}

// ---------------------------------------------------------------------------
// reading a state
// ---------------------------------------------------------------------------

const TENNIS_POINT = ['Love', '15', '30', '40'] as const

function tennisCall(serving: number, receiving: number): string {
  if (serving >= 3 && receiving >= 3) {
    if (serving === receiving) return 'Deuce'
    return serving > receiving ? 'Ad-in' : 'Ad-out'
  }
  const left = TENNIS_POINT[Math.min(serving, 3)]!
  const right = TENNIS_POINT[Math.min(receiving, 3)]!
  return serving === receiving ? `${left}-all` : `${left}-${right}`
}

function tennisLabel(mine: number, theirs: number): string {
  if (mine >= 3 && theirs >= 3) return mine > theirs ? 'Ad' : '40'
  return mine === 0 ? '0' : TENNIS_POINT[Math.min(mine, 3)]!
}

export type TeamView = {
  team_number: TeamNumber
  point_count: number
  /** What a board shows: "30", "Ad", "7". */
  point_label: string
  /** Set family: games in the current set. */
  game_count: number
  game_won_count: number
}

export type StateView = {
  /** What the scorer calls before serving: "4-2-1", "30-15", "Deuce". */
  call_out: string
  headline: string
  unit_label: 'game' | 'set'
  game_number: number
  serving_team_number: TeamNumber
  server_number: ServerNumber | null
  is_tiebreak: boolean
  is_game_decided: boolean
  game_winner_team_number: TeamNumber | null
  is_complete: boolean
  is_forfeit: boolean
  winner_team_number: TeamNumber | null
  can_undo: boolean
  team: [TeamView, TeamView]
  game_history: GameRecord[]
}

export function callOut(state: ScoreState, profile: ScoringProfile): string {
  const rule = readRule(profile)
  const serving = state.point[index(state.serving_team_number)]
  const receiving = state.point[index(other(state.serving_team_number))]
  if (rule.family === 'set' && !state.is_tiebreak) return tennisCall(serving, receiving)
  if (isDoublesSideOut(profile) && state.server_number !== null) return `${serving}-${receiving}-${state.server_number}`
  return `${serving}-${receiving}`
}

export function describeState(state: ScoreState, profile: ScoringProfile): StateView {
  const rule = readRule(profile)
  const unit = unitLabel(profile)
  const title = titleUnit(profile)

  const team = ([1, 2] as const).map((team_number): TeamView => {
    const mine = state.point[index(team_number)]
    const theirs = state.point[index(other(team_number))]
    return {
      team_number,
      point_count: mine,
      point_label: rule.family === 'set' && !state.is_tiebreak ? tennisLabel(mine, theirs) : String(mine),
      game_count: state.game_count[index(team_number)],
      game_won_count: state.game_won_count[index(team_number)],
    }
  }) as [TeamView, TeamView]

  let headline: string
  if (state.is_complete && state.winner_team_number !== null) {
    const winner = state.winner_team_number
    headline =
      state.forfeit_team_number !== null
        ? `Team ${winner} wins by forfeit`
        : `Team ${winner} wins ${state.game_won_count[index(winner)]}-${state.game_won_count[index(other(winner))]}`
  } else if (state.is_game_decided && state.game_winner_team_number !== null) {
    const [one, two] = decidedScore(state, profile)
    headline = `${title} ${state.game_number} to Team ${state.game_winner_team_number}, ${one}-${two}`
  } else if (state.is_tiebreak) {
    headline = `Set ${state.game_number} · Tiebreak`
  } else if (rule.family === 'set') {
    headline = `Set ${state.game_number} · Games ${state.game_count[0]}-${state.game_count[1]}`
  } else {
    headline = profile.best_of_count === 1 ? `${title} to ${rule.target_count}` : `${title} ${state.game_number} of ${profile.best_of_count}`
  }

  return {
    call_out: callOut(state, profile),
    headline,
    unit_label: unit,
    game_number: state.game_number,
    serving_team_number: state.serving_team_number,
    server_number: state.server_number,
    is_tiebreak: state.is_tiebreak,
    is_game_decided: state.is_game_decided,
    game_winner_team_number: state.game_winner_team_number,
    is_complete: state.is_complete,
    is_forfeit: state.forfeit_team_number !== null,
    winner_team_number: state.winner_team_number,
    can_undo: state.previous !== null,
    team,
    game_history: state.game_history.map((one) => ({
      ...one,
      point: [one.point[0], one.point[1]],
      tiebreak_point: one.tiebreak_point ? [one.tiebreak_point[0], one.tiebreak_point[1]] : null,
    })),
  }
}

// ---------------------------------------------------------------------------
// building a sequence from a final score (corrections, seed data)
// ---------------------------------------------------------------------------

export type GameScore = {
  /** Side-out and rally: points. Set family: games. Index 0 is team 1. */
  point: [number, number]
  /** Set family, 7-6 sets only. Defaults to 7-5 for the set winner. */
  tiebreak_point?: [number, number] | null
}

function mustApply(state: ScoreState, operation: ScoreOperation, profile: ScoringProfile, into: ScoreOperation[], context: string): ScoreState {
  const result = applyOperation(state, operation, profile)
  if (!result.is_ok) throw new ScoreRuleError(`${context}: ${result.reason}`)
  into.push(operation)
  return result.state
}

/**
 * The operations that award one point (set family: one tennis point) to a
 * team. Under side-out scoring a team may have to win the serve back first.
 */
export function operationForPoint(state: ScoreState, team_number: TeamNumber, profile: ScoringProfile): { operation: ScoreOperation[]; state: ScoreState } {
  const operation: ScoreOperation[] = []
  let current = state
  const before = current.point[0] + current.point[1] + current.game_count[0] + current.game_count[1]
  for (let attempt = 0; attempt < 4; attempt += 1) {
    current = mustApply(current, { kind: 'rally_won', team_number }, profile, operation, `Team ${team_number} point`)
    const after = current.point[0] + current.point[1] + current.game_count[0] + current.game_count[1]
    if (after !== before || current.is_game_decided) return { operation, state: current }
  }
  throw new ScoreRuleError(`could not award a point to team ${team_number}`)
}

/** Alternate winners until the loser's total, then the rest to the winner. */
function scoringOrder(point: [number, number]): TeamNumber[] {
  const winner: TeamNumber = point[0] > point[1] ? 1 : 2
  const loser = other(winner)
  const winner_total = point[index(winner)]
  const loser_total = point[index(loser)]
  const order: TeamNumber[] = []
  for (let one = 0; one < loser_total; one += 1) order.push(winner, loser)
  for (let one = loser_total; one < winner_total; one += 1) order.push(winner)
  return order
}

function assertScore(point: unknown, label: string): asserts point is [number, number] {
  if (
    !Array.isArray(point) ||
    point.length !== 2 ||
    !point.every((one) => Number.isInteger(one) && (one as number) >= 0) ||
    point[0] === point[1]
  ) {
    throw new ScoreRuleError(`${label} needs two different whole-number scores`)
  }
}

/**
 * A full, valid operation sequence that produces the given final game (or
 * set) scores and completes the match. Refuses a score the rules could not
 * produce, e.g. 12-3 in a game to 11.
 */
export function buildOperationForScore(profile: ScoringProfile, game_score: readonly GameScore[]): ScoreOperation[] {
  const rule = readRule(profile)
  if (game_score.length === 0) throw new ScoreRuleError('at least one game score is required')
  let state = createInitialState(profile)
  const operation: ScoreOperation[] = []

  game_score.forEach((one, position) => {
    const label = `${titleUnit(profile)} ${position + 1}`
    assertScore(one.point, label)
    if (state.is_complete) throw new ScoreRuleError(`${label}: the match was already decided`)

    if (rule.family === 'set') {
      const set_winner: TeamNumber = one.point[0] > one.point[1] ? 1 : 2
      const is_tiebreak_set = Math.max(...one.point) === 7 && Math.min(...one.point) === 6
      // A 7-6 set is 6-6 in games, then the tiebreak.
      const game_order = is_tiebreak_set ? scoringOrder([6, 7]).slice(0, 12) : scoringOrder(one.point)
      for (const game_winner of game_order) {
        if (state.is_game_decided || state.is_tiebreak) throw new ScoreRuleError(`${label}: ${one.point[0]}-${one.point[1]} is not a possible set score`)
        for (let tennis_point = 0; tennis_point < 4; tennis_point += 1) {
          const step = operationForPoint(state, game_winner, profile)
          operation.push(...step.operation)
          state = step.state
        }
      }
      if (is_tiebreak_set) {
        if (!state.is_tiebreak) throw new ScoreRuleError(`${label}: ${one.point[0]}-${one.point[1]} is not a possible set score`)
        const tiebreak = one.tiebreak_point ?? (set_winner === 1 ? [7, 5] : [5, 7])
        assertScore(tiebreak, `${label} tiebreak`)
        if ((tiebreak[0] > tiebreak[1] ? 1 : 2) !== set_winner) {
          throw new ScoreRuleError(`${label}: the tiebreak winner must win the set`)
        }
        for (const point_winner of scoringOrder(tiebreak)) {
          if (state.is_game_decided) throw new ScoreRuleError(`${label}: tiebreak ${tiebreak[0]}-${tiebreak[1]} is not possible`)
          state = mustApply(state, { kind: 'rally_won', team_number: point_winner }, profile, operation, label)
        }
      }
    } else {
      for (const point_winner of scoringOrder(one.point)) {
        if (state.is_game_decided) throw new ScoreRuleError(`${label}: ${one.point[0]}-${one.point[1]} is not a possible final score`)
        const step = operationForPoint(state, point_winner, profile)
        operation.push(...step.operation)
        state = step.state
      }
    }

    if (!state.is_game_decided) {
      throw new ScoreRuleError(`${label}: ${one.point[0]}-${one.point[1]} does not finish the ${unitLabel(profile)}`)
    }
    state = mustApply(state, { kind: 'end_game' }, profile, operation, label)
  })

  if (!state.is_complete) {
    throw new ScoreRuleError(
      `those scores do not finish the match — best of ${profile.best_of_count} needs ${gamesToWin(profile)} ${unitLabel(profile)}s to one team`,
    )
  }
  return operation
}
