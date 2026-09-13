// R09 through the real app: a 13-player, 4-court open-play night driven over
// HTTP, checked against the pure engine, plus the database's own refusal of a
// double assignment, the waitlist, the public link, and tenant isolation.

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { disableModule, enableModule, type Uuid } from '@bygelo/roundrobin-kernel'
import { COURT_DECLARATION } from '../src/app.ts'
import { listLivePlay, summarizePlayFill } from '../src/module/play/contract.ts'
import { planRotation, type EngineEntry } from '../src/module/play/engine.ts'
import { JOIN_CODE_ATTEMPT_LIMIT, resetJoinCodeGuard } from '../src/module/play/index.ts'
import type { PlaySessionState } from '../src/module/play/service.ts'
import { TEST_DATABASE_URL, createTestVenue, type TestVenue } from './helper.ts'

type Json = Record<string, unknown>

async function json<T = Json>(response: Response, status: number): Promise<T> {
  const body = await response.json()
  assert.equal(response.status, status, JSON.stringify(body))
  return body as T
}

async function createCourt(venue: TestVenue, count: number): Promise<Uuid[]> {
  return venue.asTenant(async (tenant) => {
    const [site] = await tenant.query<{ site_id: Uuid }[]>`
      INSERT INTO site (organization_id, site_code, display_name)
      VALUES (${venue.organization_id}, 'main', 'Main Venue') RETURNING site_id`
    const id: Uuid[] = []
    for (let index = 1; index <= count; index += 1) {
      const [row] = await tenant.query<{ resource_id: Uuid }[]>`
        INSERT INTO resource (organization_id, site_id, resource_code, display_name, sort_order)
        VALUES (${venue.organization_id}, ${site!.site_id}, ${`court-${index}`}, ${`Court ${index}`}, ${index})
        RETURNING resource_id`
      id.push(row!.resource_id)
    }
    return id
  })
}

const NAME = [
  'Ana Reyes', 'Ben Cruz', 'Carla Santos', 'Dan Lim', 'Ella Tan', 'Finn Garcia', 'Gia Ramos',
  'Hugo Dela Cruz', 'Ivy Mendoza', 'Jon Bautista', 'Kai Aquino', 'Lea Villanueva', 'Migs Torres',
]

describe('open play over HTTP', { skip: !TEST_DATABASE_URL }, () => {
  let venue: TestVenue
  let court: Uuid[]
  let play_session_id: Uuid
  let public_token: string
  let join_code: string
  const entry_id: Record<string, Uuid> = {}

  const state = async () =>
    (await json<{ state: PlaySessionState }>(await venue.request(`/api/v1/play/session/${play_session_id}`), 200)).state

  /** The engine's own answer for the current state — what rotate must do. */
  const expectRotation = (current: PlaySessionState, recent: Map<string, { partner: string[]; opponent: string[] }>) => {
    const entry: EngineEntry[] = current.roster
      .filter((one) => one.status_code === 'waiting')
      .map((one) => ({
        play_entry_id: one.play_entry_id,
        display_name: one.display_name,
        checked_in_at: one.checked_in_at!,
        game_count: one.game_count,
        credit_count: one.credit_count,
        last_finished_at: one.last_finished_at,
        recent_partner_id: recent.get(one.play_entry_id)?.partner ?? [],
        recent_opponent_id: recent.get(one.play_entry_id)?.opponent ?? [],
      }))
    const free_court = current.court.filter((one) => !one.game).map((one) => ({ resource_id: one.resource_id, position: one.position }))
    return planRotation({ format_code: current.play_session.format_code, free_court, entry })
  }

  before(async () => {
    venue = await createTestVenue('play')
    court = await createCourt(venue, 4)
    resetJoinCodeGuard()
  })

  after(() => venue.close())

  it('creates a session on four courts with a public token and join code', async () => {
    const body = await json<{ play_session: { play_session_id: Uuid; public_token: string; join_code: string; seat_count: number } }>(
      await venue.request('/api/v1/play/session', {
        method: 'POST',
        body: JSON.stringify({
          display_name: 'Open Play Night',
          starts_at: new Date(Date.now() - 30 * 60_000).toISOString(),
          ends_at: new Date(Date.now() + 3 * 3600_000).toISOString(),
          format_code: 'doubles',
          capacity_count: 14,
          resource_id: court,
        }),
      }),
      201,
    )
    play_session_id = body.play_session.play_session_id
    public_token = body.play_session.public_token
    join_code = body.play_session.join_code
    assert.equal(body.play_session.seat_count, 4)
    assert.match(public_token, /^[A-Za-z0-9_-]{22}$/)
    assert.match(join_code, /^\d{4}$/)

    const list = await json<{ play_session: { play_session_id: Uuid; is_today: boolean; court_count: number }[] }>(
      await venue.request('/api/v1/play/session'),
      200,
    )
    assert.equal(list.play_session[0]?.play_session_id, play_session_id)
    assert.equal(list.play_session[0]?.court_count, 4)
  })

  it('checks in 13 players and refuses a duplicate name', async () => {
    for (const display_name of NAME) {
      const body = await json<{ entry: { play_entry_id: Uuid; status_code: string } }>(
        await venue.request(`/api/v1/play/session/${play_session_id}/entry`, {
          method: 'POST',
          body: JSON.stringify({ display_name }),
        }),
        201,
      )
      assert.equal(body.entry.status_code, 'waiting')
      entry_id[display_name] = body.entry.play_entry_id
    }
    const duplicate = await venue.request(`/api/v1/play/session/${play_session_id}/entry`, {
      method: 'POST',
      body: JSON.stringify({ display_name: 'ana reyes' }),
    })
    assert.equal(duplicate.status, 409)
    const current = await state()
    assert.equal(current.waiting_count, 13)
    assert.equal(current.up_next.length, 4)
    assert.ok(current.fairness_rule.includes('fewest games'))
  })

  it('runs three rotations with finishes: exact engine order, projection honoured, nobody twice', async () => {
    const recent = new Map<string, { partner: string[]; opponent: string[] }>()
    const expected_round: string[][][] = [
      [NAME.slice(0, 4), NAME.slice(4, 8), NAME.slice(8, 12)],
      [[NAME[12]!, ...NAME.slice(0, 3)], NAME.slice(3, 7), NAME.slice(7, 11)],
      [[NAME[11]!, NAME[12]!, NAME[0]!, NAME[1]!], NAME.slice(2, 6), NAME.slice(6, 10)],
    ]

    for (let round = 0; round < 3; round += 1) {
      const before_state = await state()
      const expected = expectRotation(before_state, recent)
      const projected = before_state.up_next.map((one) => one.play_entry_id)
      assert.deepEqual(expected.assignment[0]?.play_entry_id, projected, 'up next is exactly the next group called')

      const rotated = await json<{ created_game: { resource_id: Uuid; team: string[][] }[]; state: PlaySessionState }>(
        await venue.request(`/api/v1/play/session/${play_session_id}/rotate`, { method: 'POST' }),
        200,
      )
      assert.deepEqual(
        rotated.created_game.map((one) => ({ resource_id: one.resource_id, team: one.team })),
        expected.assignment.map((one) => ({ resource_id: one.resource_id, team: one.team })),
      )
      const name_of = new Map(Object.entries(entry_id).map(([name, id]) => [id, name]))
      assert.deepEqual(
        rotated.state.court.filter((one) => one.game).map((one) => one.game!.team.flatMap((team) => team.player.map((each) => each.display_name)).sort()),
        expected_round[round]!.map((group) => [...group].sort()),
      )
      const on_court = rotated.state.court.flatMap((one) => one.game?.team.flatMap((team) => team.player.map((each) => each.play_entry_id)) ?? [])
      assert.equal(new Set(on_court).size, on_court.length, 'nobody on two courts')
      assert.deepEqual(rotated.state.up_next.map((one) => name_of.get(one.play_entry_id)), [NAME[[12, 11, 10][round]!]])

      // Rotate again with nothing freed: idempotent.
      const again = await json<{ created_game: unknown[] }>(
        await venue.request(`/api/v1/play/session/${play_session_id}/rotate`, { method: 'POST' }),
        200,
      )
      assert.equal(again.created_game.length, 0)

      // Finish every court, in court order.
      for (const one of rotated.state.court) {
        if (!one.game) continue
        for (const team of one.game.team) {
          const other = one.game.team.find((each) => each !== team)!
          for (const player of team.player) {
            recent.set(player.play_entry_id, {
              partner: team.player.filter((each) => each !== player).map((each) => each.play_entry_id),
              opponent: other.player.map((each) => each.play_entry_id),
            })
          }
        }
        const finished = await json<{ is_replay: boolean }>(
          await venue.request(`/api/v1/play/game/${one.game.play_game_id}/finish`, {
            method: 'POST',
            body: JSON.stringify({ score_text: '11-7' }),
          }),
          200,
        )
        assert.equal(finished.is_replay, false)
      }
    }

    const final = await state()
    const count = final.roster.filter((one) => one.status_code === 'waiting').map((one) => one.game_count)
    assert.equal(count.length, 13)
    assert.ok(Math.max(...count) - Math.min(...count) <= 1, `spread ${count.join(',')}`)
    assert.equal(final.finished_game_count, 9)
  })

  it('finishing a game twice is a replay, not a second game counted', async () => {
    const rotated = await json<{ state: PlaySessionState }>(
      await venue.request(`/api/v1/play/session/${play_session_id}/rotate`, { method: 'POST' }),
      200,
    )
    const game = rotated.state.court.find((one) => one.game)!.game!
    await json(await venue.request(`/api/v1/play/game/${game.play_game_id}/finish`, { method: 'POST', body: '{}' }), 200)
    const replay = await json<{ is_replay: boolean; state: PlaySessionState }>(
      await venue.request(`/api/v1/play/game/${game.play_game_id}/finish`, { method: 'POST', body: '{}' }),
      200,
    )
    assert.equal(replay.is_replay, true)
  })

  it('the database refuses a forced double assignment of a player and of a court', async () => {
    const current = await state()
    const live = current.court.find((one) => one.game)!
    const player = live.game!.team[0]!.player[0]!.play_entry_id
    const free = current.court.find((one) => !one.game)!

    await assert.rejects(
      venue.asTenant(async (tenant) => {
        const [game] = await tenant.query<{ play_game_id: Uuid }[]>`
          INSERT INTO play_game (organization_id, play_session_id, resource_id)
          VALUES (${venue.organization_id}, ${play_session_id}, ${free.resource_id}) RETURNING play_game_id`
        await tenant.query`
          INSERT INTO play_game_entry (organization_id, play_session_id, play_game_id, play_entry_id, team_number)
          VALUES (${venue.organization_id}, ${play_session_id}, ${game!.play_game_id}, ${player}, 1)`
      }),
      (error: { code?: string }) => error.code === '23505',
    )
    await assert.rejects(
      venue.asTenant((tenant) => tenant.query`
        INSERT INTO play_game (organization_id, play_session_id, resource_id)
        VALUES (${venue.organization_id}, ${play_session_id}, ${live.resource_id})`),
      (error: { code?: string }) => error.code === '23505',
    )
  })

  it('fills to capacity, waitlists the rest, and promotes exactly one per vacancy', async () => {
    // Capacity 14: one more fits, then two go on the waitlist.
    const add = async (display_name: string, is_checked_in = true) =>
      (await json<{ entry: { play_entry_id: Uuid; status_code: string; waitlist_position: number | null } }>(
        await venue.request(`/api/v1/play/session/${play_session_id}/entry`, {
          method: 'POST',
          body: JSON.stringify({ display_name, is_checked_in }),
        }),
        201,
      )).entry
    const registered = await add('Nina Flores', false)
    assert.equal(registered.status_code, 'registered')
    const first_wait = await add('Oscar Yu')
    const second_wait = await add('Pia Navarro')
    assert.equal(first_wait.status_code, 'waitlisted')
    assert.equal(first_wait.waitlist_position, 1)
    assert.equal(second_wait.waitlist_position, 2)

    const no_show = await json<{ promoted_entry: { play_entry_id: Uuid; status_code: string } | null }>(
      await venue.request(`/api/v1/play/entry/${registered.play_entry_id}/no-show`, { method: 'POST' }),
      200,
    )
    assert.equal(no_show.promoted_entry?.play_entry_id, first_wait.play_entry_id)
    assert.equal(no_show.promoted_entry?.status_code, 'waiting', 'already here, so straight into the queue')

    let current = await state()
    assert.deepEqual(current.waitlist.map((one) => one.play_entry_id), [second_wait.play_entry_id])
    assert.equal(current.spot_count, 0)

    // No-show again is a replay: no second promotion.
    const replay = await json<{ promoted_entry: unknown; is_replay: boolean }>(
      await venue.request(`/api/v1/play/entry/${registered.play_entry_id}/no-show`, { method: 'POST' }),
      200,
    )
    assert.equal(replay.is_replay, true)
    assert.equal(replay.promoted_entry, null)

    // A checked-in player cannot be a no-show.
    const refused = await venue.request(`/api/v1/play/entry/${entry_id['Ben Cruz']}/no-show`, { method: 'POST' })
    assert.equal(refused.status, 409)

    // A player leaving mid-game: the game stays on court, one promotion, they are not requeued.
    const on_court = current.court.find((one) => one.game)!.game!
    const leaver = on_court.team[0]!.player[0]!.play_entry_id
    const removed = await json<{ promoted_entry: { play_entry_id: Uuid } | null }>(
      await venue.request(`/api/v1/play/entry/${leaver}/remove`, { method: 'POST' }),
      200,
    )
    assert.equal(removed.promoted_entry?.play_entry_id, second_wait.play_entry_id)
    current = await state()
    assert.equal(current.waitlist.length, 0)
    assert.ok(current.court.some((one) => one.game?.play_game_id === on_court.play_game_id), 'court not stranded')
    await json(await venue.request(`/api/v1/play/game/${on_court.play_game_id}/finish`, { method: 'POST', body: '{}' }), 200)
    current = await state()
    assert.equal(current.roster.find((one) => one.play_entry_id === leaver)?.status_code, 'left')
    assert.equal(current.queue.some((one) => one.play_entry_id === leaver), false)

    // A promoted late arrival is credited, so the front tier is fair.
    const promoted = current.roster.find((one) => one.play_entry_id === first_wait.play_entry_id)!
    assert.ok(promoted.credit_count >= 3, `credit ${promoted.credit_count}`)
  })

  it('shows the public link with short names, up next, and no ids, party, or join code', async () => {
    const response = await venue.publicRequest(`/public/play/${public_token}`)
    const body = await json<{ play: Json }>(response, 200)
    const text = JSON.stringify(body)
    assert.ok(!text.includes(venue.organization_id))
    assert.ok(!text.includes(play_session_id))
    for (const id of Object.values(entry_id)) assert.ok(!text.includes(id), 'no entry id')
    assert.ok(!text.includes(join_code) || !text.includes(`"join_code"`))
    assert.ok(!/party|email|phone|public_token|join_code/.test(text))
    assert.ok(!text.includes('Dela Cruz'), 'last names are initials')
    const play = body.play as { court: { team: { player: { display_name: string }[] }[] }[]; up_next: { display_name: string }[]; waiting_count: number }
    assert.equal(play.court.length, 4)
    for (const one of play.court.flatMap((each) => each.team.flatMap((team) => team.player))) {
      assert.match(one.display_name, /^\S+( [A-Z]\.)?$/)
    }
    assert.ok(Array.isArray(play.up_next))
    assert.equal(typeof play.waiting_count, 'number')

    const missing = await venue.publicRequest('/public/play/AAAAAAAAAAAAAAAAAAAAAA')
    assert.equal(missing.status, 404)
  })

  it('self check-in: wrong join code refused and rate limited, right code joins, retry is a replay', async () => {
    const check_in = (display_name: string, code: string) =>
      venue.publicRequest(`/public/play/${public_token}/check-in`, {
        method: 'POST',
        body: JSON.stringify({ display_name, join_code: code }),
      })
    const wrong = code_other(join_code)
    assert.equal((await check_in('Quinn Ong', wrong)).status, 403)

    // Session is at capacity (14), so a new player is waitlisted.
    const joined = await json<{ check_in: { status_code: string; waitlist_position: number | null; is_replay: boolean } }>(
      await check_in('Quinn Ong', join_code),
      201,
    )
    assert.equal(joined.check_in.status_code, 'waitlisted')
    assert.equal(joined.check_in.waitlist_position, 1)
    const retry = await json<{ check_in: { is_replay: boolean } }>(await check_in('quinn ong', join_code), 200)
    assert.equal(retry.check_in.is_replay, true)
    assert.equal((await state()).waitlist.length, 1, 'no duplicate entry')

    for (let attempt = 1; attempt < JOIN_CODE_ATTEMPT_LIMIT; attempt += 1) {
      assert.equal((await check_in('Rae Sy', wrong)).status, 403)
    }
    const limited = await check_in('Rae Sy', join_code)
    assert.equal(limited.status, 429, 'even the right code waits out the lock')
    resetJoinCodeGuard()
  })

  it('lists today\'s open sessions publicly by organization code', async () => {
    const body = await json<{ play_session: { display_name: string; public_token: string; spot_count: number }[] }>(
      await venue.publicRequest(`/public/${venue.organization_code}/play`),
      200,
    )
    assert.equal(body.play_session.length, 1)
    assert.equal(body.play_session[0]?.public_token, public_token)
    assert.equal(body.play_session[0]?.spot_count, 0)
    assert.equal((await venue.publicRequest('/public/no-such-venue/play')).status, 404)
  })

  it('implements the display and insight contracts', async () => {
    const live = await venue.asTenant((tenant) => listLivePlay(tenant))
    assert.equal(live.length, 1)
    assert.equal(live[0]?.court.length, 4)
    assert.ok(live[0]!.court.every((one) => one.player.every((each) => /^\S+( [A-Z]\.)?$/.test(each.display_name))))
    const fill = await venue.asTenant((tenant) =>
      summarizePlayFill(tenant, { from: new Date(Date.now() - 86400_000), to: new Date(Date.now() + 86400_000) }),
    )
    // 13 original + 2 promoted checked in; Nina never arrived; capped at capacity 14.
    assert.deepEqual(fill, { session_count: 1, seat_count: 14, filled_count: 14 })
    const empty = await venue.asTenant((tenant) =>
      summarizePlayFill(tenant, { from: new Date(Date.now() + 86400_000), to: new Date(Date.now() + 2 * 86400_000) }),
    )
    assert.deepEqual(empty, { session_count: 0, seat_count: 0, filled_count: 0 })
  })

  it('keeps tenants apart', async () => {
    const other = await createTestVenue('play-other')
    try {
      assert.equal((await other.request(`/api/v1/play/session/${play_session_id}`)).status, 404)
      const list = await json<{ play_session: unknown[] }>(await other.request('/api/v1/play/session'), 200)
      assert.equal(list.play_session.length, 0)
      assert.equal((await other.request(`/api/v1/play/session/${play_session_id}/rotate`, { method: 'POST' })).status, 404)
      const foreign = await other.request('/api/v1/play/session', {
        method: 'POST',
        body: JSON.stringify({
          display_name: 'Poach',
          starts_at: new Date().toISOString(),
          ends_at: new Date(Date.now() + 3600_000).toISOString(),
          capacity_count: 8,
          resource_id: [court[0]],
        }),
      })
      assert.equal(foreign.status, 400, 'cannot use another venue\'s court')
    } finally {
      await other.close()
    }
  })

  it('closes the session: games finished, check-in refused', async () => {
    const closed = await json<{ state: PlaySessionState }>(
      await venue.request(`/api/v1/play/session/${play_session_id}/close`, { method: 'POST' }),
      200,
    )
    assert.equal(closed.state.play_session.status_code, 'closed')
    assert.ok(closed.state.court.every((one) => !one.game))
    const late = await venue.publicRequest(`/public/play/${public_token}/check-in`, {
      method: 'POST',
      body: JSON.stringify({ display_name: 'Sam Go', join_code }),
    })
    assert.equal(late.status, 409)
    assert.equal((await venue.request(`/api/v1/play/session/${play_session_id}/rotate`, { method: 'POST' })).status, 409)
  })

  it('answers 404 everywhere when play is disabled', async () => {
    await venue.asTenant((tenant) => disableModule(tenant, 'play', COURT_DECLARATION))
    try {
      assert.equal((await venue.request('/api/v1/play/session')).status, 404)
      assert.equal((await venue.publicRequest(`/public/play/${public_token}`)).status, 404)
      assert.equal((await venue.publicRequest(`/public/${venue.organization_code}/play`)).status, 404)
      const check_in = await venue.publicRequest(`/public/play/${public_token}/check-in`, {
        method: 'POST',
        body: JSON.stringify({ display_name: 'Tess Uy', join_code }),
      })
      assert.equal(check_in.status, 404)
    } finally {
      await venue.asTenant((tenant) => enableModule(tenant, 'play', COURT_DECLARATION))
    }
  })
})

function code_other(code: string): string {
  return String((Number(code) + 1) % 10_000).padStart(4, '0')
}
