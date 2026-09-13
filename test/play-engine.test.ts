// The rotation engine, DB-free. R09: fairness is a property of a full scene,
// so most of these replay one — 13 players, 4 courts, doubles — round by round.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  compareEntry,
  lateArrivalCredit,
  planRotation,
  publicName,
  splitTeam,
  type EngineCourt,
  type EngineEntry,
  type EngineOutput,
} from '../src/module/play/engine.ts'

const COURT: EngineCourt[] = [1, 2, 3, 4].map((position) => ({ resource_id: `court-${position}`, position }))
const START = Date.parse('2026-09-13T10:00:00Z')
const at = (minute: number) => new Date(START + minute * 60_000).toISOString()

function player(index: number, checked_in_minute = 0): EngineEntry {
  const code = String(index).padStart(2, '0')
  return {
    play_entry_id: `p${code}`,
    display_name: `Player ${code}`,
    // One second apart, so check-in order is the tiebreak.
    checked_in_at: new Date(START + checked_in_minute * 60_000 + index * 1000).toISOString(),
    game_count: 0,
    credit_count: 0,
    last_finished_at: null,
    recent_partner_id: [],
    recent_opponent_id: [],
  }
}

/**
 * A deterministic open-play night. Each round: every court is free, rotate,
 * then courts finish in court order one minute apart. Arrivals and departures
 * happen between rounds.
 */
function replayScene(option: {
  round_count: number
  arrival?: Record<number, number[]>
  departure?: Record<number, string[]>
  onRound?: (round: number, pool: EngineEntry[], output: EngineOutput) => void
}) {
  let pool: EngineEntry[] = Array.from({ length: 13 }, (_, index) => player(index + 1))
  const transcript: string[] = []
  for (let round = 1; round <= option.round_count; round += 1) {
    for (const index of option.arrival?.[round] ?? []) {
      const late = player(index, round * 20 - 5)
      late.credit_count = lateArrivalCredit(pool)
      pool.push(late)
    }
    const gone = new Set(option.departure?.[round] ?? [])
    pool = pool.filter((one) => !gone.has(one.play_entry_id))

    const output = planRotation({ format_code: 'doubles', free_court: COURT, entry: pool })
    option.onRound?.(round, pool, output)
    transcript.push(JSON.stringify(output))

    output.assignment.forEach((game, court_index) => {
      const finished_at = at(round * 20 + court_index)
      for (const id of game.play_entry_id) {
        const one = pool.find((each) => each.play_entry_id === id)!
        const team = game.team.find((each) => each.includes(id))!
        const other = game.team.find((each) => !each.includes(id))!
        one.game_count += 1
        one.last_finished_at = finished_at
        one.recent_partner_id = team.filter((each) => each !== id)
        one.recent_opponent_id = [...other]
      }
    })
  }
  return { pool, transcript }
}

describe('rotation engine — fairness order', () => {
  it('orders by fewest games, then longest wait, then earliest check-in', () => {
    const a = { ...player(1), game_count: 1, last_finished_at: at(10) }
    const b = { ...player(2), game_count: 1, last_finished_at: at(5) }
    const c = { ...player(3), game_count: 0 }
    const d = { ...player(4), game_count: 1, last_finished_at: at(5) }
    const order = [a, b, c, d].sort(compareEntry).map((one) => one.play_entry_id)
    assert.deepEqual(order, ['p03', 'p02', 'p04', 'p01'])
  })

  it('counts late-arrival credit as games', () => {
    const veteran = { ...player(1), game_count: 2, last_finished_at: at(40) }
    const late = { ...player(2, 45), credit_count: 2 }
    assert.equal(lateArrivalCredit([veteran, { ...player(3), game_count: 3 }]), 2)
    assert.equal(lateArrivalCredit([]), 0)
    // Same rotation count; the late arrival has waited since 10:45, the veteran since 10:40.
    assert.deepEqual([late, veteran].sort(compareEntry).map((one) => one.play_entry_id), ['p01', 'p02'])
  })

  it('fills courts in court order and projects the next group', () => {
    const pool = Array.from({ length: 13 }, (_, index) => player(index + 1))
    const output = planRotation({ format_code: 'doubles', free_court: [...COURT].reverse(), entry: pool })
    assert.deepEqual(
      output.assignment.map((one) => [one.resource_id, ...one.play_entry_id]),
      [
        ['court-1', 'p01', 'p02', 'p03', 'p04'],
        ['court-2', 'p05', 'p06', 'p07', 'p08'],
        ['court-3', 'p09', 'p10', 'p11', 'p12'],
      ],
    )
    assert.deepEqual(output.up_next, ['p13'])
    assert.deepEqual(output.queue, ['p13'])
  })

  it('assigns nothing when nobody can make a full group (idempotent rotate)', () => {
    const output = planRotation({ format_code: 'doubles', free_court: COURT, entry: [player(1), player(2), player(3)] })
    assert.deepEqual(output.assignment, [])
    assert.deepEqual(output.up_next, ['p01', 'p02', 'p03'])
  })

  it('singles takes two a court', () => {
    const output = planRotation({ format_code: 'singles', free_court: COURT.slice(0, 2), entry: [1, 2, 3, 4, 5].map((i) => player(i)) })
    assert.deepEqual(output.assignment.map((one) => one.team), [[['p01'], ['p02']], [['p03'], ['p04']]])
    assert.deepEqual(output.up_next, ['p05'])
  })
})

describe('rotation engine — team split', () => {
  it('never repeats last game partners in doubles', () => {
    const [a, b, c, d] = [1, 2, 3, 4].map((i) => player(i)) as [EngineEntry, EngineEntry, EngineEntry, EngineEntry]
    a.recent_partner_id = ['p02']
    b.recent_partner_id = ['p01']
    c.recent_partner_id = ['p04']
    d.recent_partner_id = ['p03']
    a.recent_opponent_id = ['p03', 'p04']
    b.recent_opponent_id = ['p03', 'p04']
    const team = splitTeam([a, b, c, d], 'doubles')
    assert.deepEqual(team, [['p01', 'p03'], ['p02', 'p04']])
  })

  it('keeps the first split when there is no history', () => {
    const team = splitTeam([1, 2, 3, 4].map((i) => player(i)), 'doubles')
    assert.deepEqual(team, [['p01', 'p02'], ['p03', 'p04']])
  })
})

describe('rotation engine — the 13-player, 4-court scene', () => {
  it('produces the documented exact order across three rounds', () => {
    const court_of_round: string[][][] = []
    replayScene({
      round_count: 3,
      onRound: (_round, _pool, output) => court_of_round.push(output.assignment.map((one) => one.play_entry_id)),
    })
    assert.deepEqual(court_of_round, [
      [['p01', 'p02', 'p03', 'p04'], ['p05', 'p06', 'p07', 'p08'], ['p09', 'p10', 'p11', 'p12']],
      [['p13', 'p01', 'p02', 'p03'], ['p04', 'p05', 'p06', 'p07'], ['p08', 'p09', 'p10', 'p11']],
      [['p12', 'p13', 'p01', 'p02'], ['p03', 'p04', 'p05', 'p06'], ['p07', 'p08', 'p09', 'p10']],
    ])
  })

  it('never assigns a player or a court twice in one rotation', () => {
    replayScene({
      round_count: 12,
      onRound: (_round, _pool, output) => {
        const player_id = output.assignment.flatMap((one) => one.play_entry_id)
        assert.equal(new Set(player_id).size, player_id.length)
        const court_id = output.assignment.map((one) => one.resource_id)
        assert.equal(new Set(court_id).size, court_id.length)
        for (const one of output.assignment) {
          assert.deepEqual([...one.team[0], ...one.team[1]].sort(), [...one.play_entry_id].sort())
        }
      },
    })
  })

  it('keeps the games-played spread within 1 at every checkpoint, and nobody sits twice running while another plays twice', () => {
    const sat: Record<string, number> = {}
    replayScene({
      round_count: 12,
      onRound: (round, pool, output) => {
        const playing = new Set(output.assignment.flatMap((one) => one.play_entry_id))
        for (const one of pool) {
          if (playing.has(one.play_entry_id)) {
            sat[one.play_entry_id] = 0
          } else {
            sat[one.play_entry_id] = (sat[one.play_entry_id] ?? 0) + 1
            // Sat out two rounds in a row: that must mean nobody else played both.
            if (sat[one.play_entry_id]! >= 2) assert.fail(`round ${round}: ${one.play_entry_id} sat out twice in a row`)
          }
        }
        const count = pool.map((one) => one.game_count)
        assert.ok(Math.max(...count) - Math.min(...count) <= 1, `round ${round} spread ${count.join(',')}`)
      },
    })
  })

  it('never repeats a partner from the previous game', () => {
    replayScene({
      round_count: 12,
      onRound: (round, pool, output) => {
        for (const game of output.assignment) {
          for (const team of game.team) {
            const [x, y] = team
            const one = pool.find((each) => each.play_entry_id === x)!
            assert.ok(!one.recent_partner_id.includes(y!), `round ${round}: ${x} partnered ${y} twice running`)
          }
        }
      },
    })
  })

  it('integrates three late arrivals within one rotation and survives two departures', () => {
    const arrival = { 3: [14], 5: [15, 16] }
    const departure = { 4: ['p02'], 6: ['p07'] }
    replayScene({
      round_count: 10,
      arrival,
      departure,
      onRound: (round, pool, output) => {
        const playing = new Set(output.assignment.flatMap((one) => one.play_entry_id))
        for (const index of (arrival as Record<number, number[]>)[round] ?? []) {
          const id = `p${index}`
          // Called this rotation, or at the latest the next one.
          if (!playing.has(id)) assert.ok(output.up_next.includes(id), `round ${round}: late ${id} not integrated`)
        }
        // Every court with a full group available is used — no stranded court.
        assert.equal(output.assignment.length, Math.min(4, Math.floor(pool.length / 4)))
        // Spread among players who were there from the start.
        const count = pool.filter((one) => Number(one.play_entry_id.slice(1)) <= 13).map((one) => rotationOf(one))
        assert.ok(Math.max(...count) - Math.min(...count) <= 1, `round ${round} spread ${count.join(',')}`)
      },
    })
  })

  it('is byte-identical across 10 replays', () => {
    const first = replayScene({ round_count: 8, arrival: { 3: [14] }, departure: { 4: ['p05'] } }).transcript.join('\n')
    for (let run = 0; run < 9; run += 1) {
      assert.equal(replayScene({ round_count: 8, arrival: { 3: [14] }, departure: { 4: ['p05'] } }).transcript.join('\n'), first)
    }
  })

  it('up-next projection matches what the engine assigns next', () => {
    const pool = Array.from({ length: 13 }, (_, index) => player(index + 1))
    const first = planRotation({ format_code: 'doubles', free_court: COURT, entry: pool })
    // Court 1 finishes alone; its four rejoin behind the one who waited.
    const court_1 = first.assignment[0]!
    const waiting = pool.filter((one) => first.queue.includes(one.play_entry_id))
    const back = pool
      .filter((one) => court_1.play_entry_id.includes(one.play_entry_id))
      .map((one) => ({ ...one, game_count: 1, last_finished_at: at(15) }))
    const projected = planRotation({ format_code: 'doubles', free_court: [], entry: [...waiting, ...back] }).up_next
    const actual = planRotation({ format_code: 'doubles', free_court: [COURT[0]!], entry: [...waiting, ...back] })
    assert.deepEqual(actual.assignment[0]!.play_entry_id, projected)
  })
})

describe('public name', () => {
  it('shows first name and last initial only', () => {
    assert.equal(publicName('Maria Santos Cruz'), 'Maria C.')
    assert.equal(publicName('  Jo  '), 'Jo')
    assert.equal(publicName('ana reyes'), 'ana R.')
  })
})

function rotationOf(one: EngineEntry) {
  return one.game_count + one.credit_count
}
