// The scorer as a pure function. No database — these run on every `npm test`.
//
// R12 fixtures: one recorded point sequence per scoring rule, including deuce,
// side-out, a game boundary, and a full match, each replayed to its documented
// final score.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  SCORING_RULE_CODE,
  ScoreRuleError,
  applyOperation,
  buildOperationForScore,
  callOut,
  createInitialState,
  describeState,
  operationForPoint,
  replay,
  type ScoreOperation,
  type ScoreState,
  type ScoringProfile,
  type TeamNumber,
} from '../src/module/score/engine.ts'

const DOUBLES: ScoringProfile = { scoring_rule_code: 'side_out_11', best_of_count: 1, team_size_count: 2 }
const DOUBLES_BEST_OF_3: ScoringProfile = { ...DOUBLES, best_of_count: 3 }
const SINGLES: ScoringProfile = { scoring_rule_code: 'side_out_11', best_of_count: 1, team_size_count: 1 }
const RALLY: ScoringProfile = { scoring_rule_code: 'rally_11', best_of_count: 1, team_size_count: 2 }
const BADMINTON: ScoringProfile = { scoring_rule_code: 'badminton_rally_21', best_of_count: 1, team_size_count: 2 }
const TENNIS: ScoringProfile = { scoring_rule_code: 'tennis_set', best_of_count: 1, team_size_count: 1 }
const TENNIS_BEST_OF_3: ScoringProfile = { ...TENNIS, best_of_count: 3 }
const PADEL: ScoringProfile = { scoring_rule_code: 'padel_set', best_of_count: 1, team_size_count: 2 }

const win = (team_number: TeamNumber): ScoreOperation => ({ kind: 'rally_won', team_number })
const repeat = (team_number: TeamNumber, count: number): ScoreOperation[] => Array.from({ length: count }, () => win(team_number))

function apply(state: ScoreState, operation: ScoreOperation, profile: ScoringProfile): ScoreState {
  const result = applyOperation(state, operation, profile)
  if (!result.is_ok) assert.fail(result.reason)
  return result.state
}

function refusal(state: ScoreState, operation: ScoreOperation, profile: ScoringProfile): string {
  const result = applyOperation(state, operation, profile)
  assert.equal(result.is_ok, false, 'operation should be refused')
  return (result as { reason: string }).reason
}

/** A comparable snapshot: everything but the undo chain. */
function snapshot(state: ScoreState): Omit<ScoreState, 'previous'> {
  const { previous: _previous, ...rest } = state
  return JSON.parse(JSON.stringify(rest)) as Omit<ScoreState, 'previous'>
}

describe('side-out doubles (traditional pickleball)', () => {
  it('opens at 0-0-2 — the first-serve exception', () => {
    const state = createInitialState(DOUBLES)
    assert.equal(callOut(state, DOUBLES), '0-0-2')
    assert.equal(state.serving_team_number, 1)
    assert.equal(state.server_number, 2)
  })

  it('sides out straight away on the first lost rally, because the opening server is server 2', () => {
    const state = replay(DOUBLES, [win(2)])
    assert.equal(state.serving_team_number, 2)
    assert.equal(state.server_number, 1)
    assert.equal(callOut(state, DOUBLES), '0-0-1')
  })

  it('only the serving team scores; server 1 then server 2 then side out', () => {
    let state = replay(DOUBLES, [win(2)]) // team 2, server 1, 0-0-1
    state = apply(state, win(2), DOUBLES) // 1-0-1
    state = apply(state, win(1), DOUBLES) // receiving team wins: server 2, no point
    assert.equal(callOut(state, DOUBLES), '1-0-2')
    assert.deepEqual(state.point, [0, 1])
    state = apply(state, win(1), DOUBLES) // side out to team 1 server 1
    assert.equal(state.serving_team_number, 1)
    assert.equal(callOut(state, DOUBLES), '0-1-1')
  })

  it('calls "4-2-1" with the serving team first', () => {
    // Team 1 opens (server 2) and scores 2; side out; team 2 scores 2 on server 1,
    // loses a rally, and so on — landing on team 1 serving 4-2 from server 1.
    const state = replay(DOUBLES, [
      ...repeat(1, 2), // 2-0-2
      win(2), // side out → team 2 server 1: 0-2-1
      ...repeat(2, 2), // 2-2-1
      win(1), // 2-2-2
      win(1), // side out → team 1 server 1: 2-2-1
      ...repeat(1, 2), // 4-2-1
    ])
    assert.equal(callOut(state, DOUBLES), '4-2-1')
    assert.equal(describeState(state, DOUBLES).call_out, '4-2-1')
  })

  it('wins at 11 by 2, not at 11-10', () => {
    // Build 10-10 then team 1 scores twice while serving.
    const to_ten = buildPartial(DOUBLES, [10, 10])
    let state = to_ten
    state = serveTo(state, 1, DOUBLES)
    assert.deepEqual(state.point, [11, 10])
    assert.equal(state.is_game_decided, false)
    state = apply(state, win(1), DOUBLES)
    assert.deepEqual(state.point, [12, 10])
    assert.equal(state.is_game_decided, true)
    assert.equal(state.game_winner_team_number, 1)
  })

  it('refuses a rally after the game is decided, and end_game before it is', () => {
    const decided = buildPartial(DOUBLES, [11, 4])
    assert.equal(decided.is_game_decided, true)
    assert.match(refusal(decided, win(2), DOUBLES), /Game 1 is over at 11-4/)
    const live = buildPartial(DOUBLES, [9, 7])
    assert.match(refusal(live, { kind: 'end_game' }, DOUBLES), /Game 1 is not over — 9-7; a game is won at 11 by 2/)
  })

  it('undo across a game boundary restores the exact prior state, including server and side', () => {
    const before_winner = buildPartial(DOUBLES_BEST_OF_3, [10, 6])
    const decided = serveTo(before_winner, 1, DOUBLES_BEST_OF_3)
    assert.equal(decided.is_game_decided, true)
    const next_game = apply(decided, { kind: 'end_game' }, DOUBLES_BEST_OF_3)
    assert.equal(next_game.game_number, 2)
    assert.equal(callOut(next_game, DOUBLES_BEST_OF_3), '0-0-2')
    assert.equal(next_game.serving_team_number, 2, 'teams alternate who opens a game')

    const back_to_decided = apply(next_game, { kind: 'undo' }, DOUBLES_BEST_OF_3)
    assert.deepEqual(snapshot(back_to_decided), snapshot(decided))

    // Step back over the winning rally too, and forward again identically.
    const last_rally = decided.previous!
    const undone_twice = apply(back_to_decided, { kind: 'undo' }, DOUBLES_BEST_OF_3)
    assert.deepEqual(snapshot(undone_twice), snapshot(last_rally))
    assert.equal(undone_twice.serving_team_number, last_rally.serving_team_number)
    assert.equal(undone_twice.server_number, last_rally.server_number)
    assert.equal(undone_twice.is_game_decided, false)
  })

  it('undo through replay equals never having played the rally', () => {
    const base: ScoreOperation[] = [...repeat(1, 3), win(2), win(2), ...repeat(2, 2)]
    const with_undo = replay(DOUBLES, [...base, win(1), { kind: 'undo' }])
    assert.deepEqual(snapshot(with_undo), snapshot(replay(DOUBLES, base)))
  })

  it('refuses undo with nothing to undo', () => {
    assert.equal(refusal(createInitialState(DOUBLES), { kind: 'undo' }, DOUBLES), 'Nothing to undo.')
  })

  it('set_server needs a server number in doubles, and moves the opening serve at 0-0', () => {
    assert.match(refusal(createInitialState(DOUBLES), { kind: 'set_server', team_number: 2 }, DOUBLES), /server_number 1 or 2/)
    const state = apply(createInitialState(DOUBLES_BEST_OF_3), { kind: 'set_server', team_number: 2, server_number: 2 }, DOUBLES_BEST_OF_3)
    assert.equal(state.first_serving_team_number, 2)
    assert.equal(callOut(state, DOUBLES_BEST_OF_3), '0-0-2')
    assert.match(refusal(state, { kind: 'set_server', team_number: 2, server_number: 2 }, DOUBLES_BEST_OF_3), /already serving/)
  })

  it('plays a full best-of-3 match to completion and refuses play after it', () => {
    const operation = buildOperationForScore(DOUBLES_BEST_OF_3, [{ point: [11, 7] }, { point: [9, 11] }, { point: [13, 11] }])
    const state = replay(DOUBLES_BEST_OF_3, operation)
    assert.equal(state.is_complete, true)
    assert.equal(state.winner_team_number, 1)
    assert.deepEqual(
      state.game_history.map((one) => one.point),
      [
        [11, 7],
        [9, 11],
        [13, 11],
      ],
    )
    assert.deepEqual(state.game_won_count, [2, 1])
    assert.equal(describeState(state, DOUBLES_BEST_OF_3).headline, 'Team 1 wins 2-1')
    assert.equal(refusal(state, win(2), DOUBLES_BEST_OF_3), 'The match is over.')
    // Undo is still allowed before confirmation — a scorer's last mis-tap.
    const undone = apply(state, { kind: 'undo' }, DOUBLES_BEST_OF_3)
    assert.equal(undone.is_complete, false)
    assert.equal(undone.is_game_decided, true)
  })

  it('ends a match by forfeit', () => {
    const state = replay(DOUBLES, [...repeat(1, 3), { kind: 'forfeit', team_number: 1 }])
    assert.equal(state.is_complete, true)
    assert.equal(state.winner_team_number, 2)
    assert.equal(describeState(state, DOUBLES).headline, 'Team 2 wins by forfeit')
  })
})

describe('side-out singles', () => {
  it('has no server number: any lost rally is a side out', () => {
    let state = createInitialState(SINGLES)
    assert.equal(state.server_number, null)
    assert.equal(callOut(state, SINGLES), '0-0')
    state = apply(state, win(1), SINGLES)
    state = apply(state, win(2), SINGLES)
    assert.equal(state.serving_team_number, 2)
    assert.equal(callOut(state, SINGLES), '0-1')
    assert.match(refusal(state, { kind: 'set_server', team_number: 1, server_number: 1 }, SINGLES), /only to side-out doubles/)
  })
})

describe('rally scoring', () => {
  it('scores every rally and hands the serve to the rally winner', () => {
    const state = replay(RALLY, [win(1), win(2), win(2)])
    assert.deepEqual(state.point, [1, 2])
    assert.equal(state.serving_team_number, 2)
    assert.equal(callOut(state, RALLY), '2-1')
  })

  it('wins at 11 by 2 through deuce', () => {
    const state = replay(RALLY, buildOperationForScore(RALLY, [{ point: [14, 12] }]))
    assert.equal(state.is_complete, true)
    assert.deepEqual(state.game_history[0]?.point, [14, 12])
  })

  it('caps badminton at 30', () => {
    const at_29 = replay(BADMINTON, scoringAlternation(29, 29))
    assert.equal(at_29.is_game_decided, false)
    const capped = apply(at_29, win(2), BADMINTON)
    assert.deepEqual(capped.point, [29, 30])
    assert.equal(capped.is_game_decided, true)
    assert.equal(capped.game_winner_team_number, 2)
  })

  it('opens the next game with the previous game winner serving', () => {
    const profile: ScoringProfile = { ...RALLY, best_of_count: 3 }
    const state = replay(profile, [...buildGame(profile, [5, 11]), { kind: 'end_game' }])
    assert.equal(state.game_number, 2)
    assert.equal(state.serving_team_number, 2)
  })
})

describe('tennis and padel sets', () => {
  it('calls points server-first: 15-Love, 30-15, 40-all is deuce, advantage', () => {
    let state = createInitialState(TENNIS)
    state = apply(state, win(1), TENNIS)
    assert.equal(callOut(state, TENNIS), '15-Love')
    state = apply(state, win(1), TENNIS)
    state = apply(state, win(2), TENNIS)
    assert.equal(callOut(state, TENNIS), '30-15')
    state = apply(state, win(2), TENNIS)
    assert.equal(callOut(state, TENNIS), '30-all')
    state = apply(state, win(1), TENNIS)
    state = apply(state, win(2), TENNIS)
    assert.equal(callOut(state, TENNIS), 'Deuce')
    state = apply(state, win(2), TENNIS)
    assert.equal(callOut(state, TENNIS), 'Ad-out')
    assert.deepEqual(
      describeState(state, TENNIS).team.map((one) => one.point_label),
      ['40', 'Ad'],
    )
    state = apply(state, win(1), TENNIS)
    assert.equal(callOut(state, TENNIS), 'Deuce')
    state = apply(state, win(1), TENNIS)
    assert.equal(callOut(state, TENNIS), 'Ad-in')
    state = apply(state, win(1), TENNIS)
    assert.deepEqual(state.game_count, [1, 0])
    assert.deepEqual(state.point, [0, 0])
    assert.equal(state.serving_team_number, 2, 'serve alternates every game')
  })

  it('wins a set 6-4 and records it', () => {
    const state = replay(TENNIS, buildOperationForScore(TENNIS, [{ point: [6, 4] }]))
    assert.equal(state.is_complete, true)
    assert.deepEqual(state.game_history, [{ game_number: 1, point: [6, 4], tiebreak_point: null, winner_team_number: 1 }])
  })

  it('plays a tiebreak at 6-6 with the serve alternating every two points', () => {
    const at_six_all = replay(TENNIS, tennisGames([1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2]))
    assert.equal(at_six_all.is_tiebreak, true)
    const first = at_six_all.tiebreak_first_serving_team_number!
    assert.equal(at_six_all.serving_team_number, first)
    const serving: TeamNumber[] = []
    let state = at_six_all
    for (const point_winner of [1, 2, 1, 2, 1] as TeamNumber[]) {
      state = apply(state, win(point_winner), TENNIS)
      serving.push(state.serving_team_number)
    }
    const second = first === 1 ? 2 : 1
    assert.deepEqual(serving, [second, second, first, first, second])
    assert.equal(callOut(state, TENNIS).includes('-'), true)
  })

  it('records a 7-6 set with its tiebreak score, and the tiebreak receiver serves the next set', () => {
    const state = replay(TENNIS_BEST_OF_3, buildOperationForScore(TENNIS_BEST_OF_3, [{ point: [7, 6], tiebreak_point: [9, 7] }, { point: [3, 6] }, { point: [6, 2] }]))
    assert.equal(state.is_complete, true)
    assert.deepEqual(state.game_history[0], { game_number: 1, point: [7, 6], tiebreak_point: [9, 7], winner_team_number: 1 })
    assert.equal(describeState(state, TENNIS_BEST_OF_3).headline, 'Team 1 wins 2-1')

    const after_first_set = replay(TENNIS_BEST_OF_3, [...buildSet(TENNIS_BEST_OF_3, [7, 6], [7, 3]), { kind: 'end_game' }])
    const tiebreak_first = after_first_set.previous!.tiebreak_first_serving_team_number!
    assert.equal(after_first_set.serving_team_number, tiebreak_first === 1 ? 2 : 1)
  })

  it('refuses end_game mid-set with the reason', () => {
    const state = replay(TENNIS, tennisGames([1, 1, 2]))
    assert.match(refusal(state, { kind: 'end_game' }, TENNIS), /Set 1 is not over — games are 2-1/)
  })

  it('scores padel on the same set rules', () => {
    const state = replay(PADEL, buildOperationForScore(PADEL, [{ point: [4, 6] }]))
    assert.equal(state.winner_team_number, 2)
  })
})

describe('R12 fixture: one recorded sequence per scoring rule replays to its documented final score', () => {
  const FIXTURE: { scoring_rule_code: string; team_size_count: number; best_of_count: number; game: [number, number][]; winner: TeamNumber }[] = [
    { scoring_rule_code: 'side_out_11', team_size_count: 2, best_of_count: 3, game: [[11, 9], [10, 12], [11, 3]], winner: 1 },
    { scoring_rule_code: 'side_out_15', team_size_count: 2, best_of_count: 1, game: [[13, 15]], winner: 2 },
    { scoring_rule_code: 'side_out_21', team_size_count: 1, best_of_count: 1, game: [[23, 21]], winner: 1 },
    { scoring_rule_code: 'rally_11', team_size_count: 2, best_of_count: 3, game: [[11, 13], [11, 6], [4, 11]], winner: 2 },
    { scoring_rule_code: 'rally_15', team_size_count: 2, best_of_count: 1, game: [[15, 13]], winner: 1 },
    { scoring_rule_code: 'rally_21', team_size_count: 2, best_of_count: 1, game: [[21, 19]], winner: 1 },
    { scoring_rule_code: 'badminton_rally_21', team_size_count: 2, best_of_count: 3, game: [[30, 29], [21, 23], [21, 15]], winner: 1 },
    { scoring_rule_code: 'tennis_set', team_size_count: 1, best_of_count: 3, game: [[6, 4], [7, 6]], winner: 1 },
    { scoring_rule_code: 'padel_set', team_size_count: 2, best_of_count: 3, game: [[6, 7], [7, 5], [2, 6]], winner: 2 },
  ]

  it('covers every scoring rule the venue can configure', () => {
    assert.deepEqual([...new Set(FIXTURE.map((one) => one.scoring_rule_code))].sort(), [...SCORING_RULE_CODE].sort())
  })

  for (const one of FIXTURE) {
    it(`${one.scoring_rule_code}: ${one.game.map((game) => game.join('-')).join(', ')}`, () => {
      const profile: ScoringProfile = { scoring_rule_code: one.scoring_rule_code, best_of_count: one.best_of_count, team_size_count: one.team_size_count }
      const operation = buildOperationForScore(
        profile,
        one.game.map((point) => ({ point })),
      )
      const state = replay(profile, operation)
      assert.equal(state.is_complete, true)
      assert.equal(state.winner_team_number, one.winner)
      assert.deepEqual(
        state.game_history.map((game) => game.point),
        one.game,
      )
    })
  }

  it('is deterministic across 10 runs', () => {
    const profile = DOUBLES_BEST_OF_3
    const operation = seededSequence(profile, 20260913)
    const first = JSON.stringify(describeState(replay(profile, operation), profile))
    for (let run = 0; run < 10; run += 1) {
      assert.equal(JSON.stringify(describeState(replay(profile, operation), profile)), first)
    }
  })
})

describe('refusals', () => {
  it('replay names the first refused operation', () => {
    assert.throws(() => replay(DOUBLES, [{ kind: 'end_game' }]), (error: unknown) => error instanceof ScoreRuleError && /operation 1 \(end_game\)/.test(error.message))
  })

  it('refuses an unknown profile, an even best-of, and an unknown operation', () => {
    assert.throws(() => createInitialState({ scoring_rule_code: 'cricket', best_of_count: 1, team_size_count: 2 }), ScoreRuleError)
    assert.throws(() => createInitialState({ ...DOUBLES, best_of_count: 2 }), ScoreRuleError)
    const result = applyOperation(createInitialState(DOUBLES), { kind: 'teleport' } as unknown as ScoreOperation, DOUBLES)
    assert.equal(result.is_ok, false)
    const bad_team = applyOperation(createInitialState(DOUBLES), { kind: 'rally_won', team_number: 3 } as unknown as ScoreOperation, DOUBLES)
    assert.equal(bad_team.is_ok, false)
  })

  it('buildOperationForScore refuses a score the rules cannot produce', () => {
    assert.throws(() => buildOperationForScore(DOUBLES, [{ point: [12, 3] }]), /not a possible final score/)
    assert.throws(() => buildOperationForScore(DOUBLES, [{ point: [10, 8] }]), /does not finish/)
    assert.throws(() => buildOperationForScore(DOUBLES_BEST_OF_3, [{ point: [11, 8] }]), /do not finish the match/)
    assert.throws(() => buildOperationForScore(TENNIS, [{ point: [8, 6] }]), /not a possible set score/)
    assert.throws(() => buildOperationForScore(DOUBLES, [{ point: [5, 5] }]), /two different/)
  })
})

// ---- helpers ---------------------------------------------------------------

/** Rally-scoring alternation to exactly (a, b) without deciding the game. */
function scoringAlternation(a: number, b: number): ScoreOperation[] {
  const operation: ScoreOperation[] = []
  for (let one = 0; one < Math.max(a, b); one += 1) {
    if (one < a) operation.push(win(1))
    if (one < b) operation.push(win(2))
  }
  return operation
}

/** Reach a (possibly decided) in-game score by awarding points alternately. */
function buildPartial(profile: ScoringProfile, point: [number, number]): ScoreState {
  let state = createInitialState(profile)
  for (let one = 0; one < Math.max(...point); one += 1) {
    if (one < point[0]) state = operationForPoint(state, 1, profile).state
    if (one < point[1]) state = operationForPoint(state, 2, profile).state
  }
  return state
}

function serveTo(state: ScoreState, team_number: TeamNumber, profile: ScoringProfile): ScoreState {
  return operationForPoint(state, team_number, profile).state
}

function buildGame(profile: ScoringProfile, point: [number, number]): ScoreOperation[] {
  return buildOperationForScore({ ...profile, best_of_count: 1 }, [{ point }]).slice(0, -1)
}

function tennisGames(winner: TeamNumber[]): ScoreOperation[] {
  return winner.flatMap((team_number) => repeat(team_number, 4))
}

function buildSet(profile: ScoringProfile, point: [number, number], tiebreak_point: [number, number]): ScoreOperation[] {
  return buildOperationForScore({ ...profile, best_of_count: 1 }, [{ point, tiebreak_point }]).slice(0, -1)
}

/** A long pseudo-random but fixed sequence, including undo and refused taps skipped. */
function seededSequence(profile: ScoringProfile, seed: number): ScoreOperation[] {
  let value = seed
  const next = () => {
    value = (value * 1103515245 + 12345) % 2147483648
    return value / 2147483648
  }
  const operation: ScoreOperation[] = []
  let state = createInitialState(profile)
  while (!state.is_complete && operation.length < 2000) {
    const roll = next()
    const candidate: ScoreOperation = state.is_game_decided
      ? roll < 0.15 ? { kind: 'undo' } : { kind: 'end_game' }
      : roll < 0.08 ? { kind: 'undo' } : win(roll < 0.54 ? 1 : 2)
    const result = applyOperation(state, candidate, profile)
    if (!result.is_ok) continue
    operation.push(candidate)
    state = result.state
  }
  return operation
}
