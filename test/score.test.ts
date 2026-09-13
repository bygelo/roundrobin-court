// R12 over HTTP: idempotent operations, convergence, confirmation lock, and
// the audited correction — against a real database.

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { disableModule, type Uuid } from '@bygelo/roundrobin-kernel'
import { COURT_DECLARATION } from '../src/app.ts'
import { findMatchResult, listLiveMatch } from '../src/module/score/contract.ts'
import { buildOperationForScore, describeState, replay, type ScoreOperation } from '../src/module/score/engine.ts'
import type { MatchView } from '../src/module/score/service.ts'
import { TEST_DATABASE_URL, createTestVenue, type TestVenue } from './helper.ts'

async function setupVenue(venue: TestVenue): Promise<{ court_id: Uuid }> {
  return venue.asTenant(async (tenant) => {
    const organization_id = venue.organization_id
    await tenant.query`
      INSERT INTO sport_profile (organization_id, sport_profile_code, display_name, team_size_count, scoring_rule_code, rating_provider_code)
      VALUES (${organization_id}, 'pickleball', 'Pickleball', 2, 'side_out_11', 'dupr'),
             (${organization_id}, 'tennis', 'Tennis', 2, 'tennis_set', null)`
    const [site] = await tenant.query<{ site_id: Uuid }[]>`
      INSERT INTO site (organization_id, site_code, display_name) VALUES (${organization_id}, 'main', 'Main') RETURNING site_id`
    const [court] = await tenant.query<{ resource_id: Uuid }[]>`
      INSERT INTO resource (organization_id, site_id, resource_code, display_name, sort_order)
      VALUES (${organization_id}, ${site!.site_id}, 'court-1', 'Court 1', 1) RETURNING resource_id`
    return { court_id: court!.resource_id }
  })
}

const DOUBLES_TEAM = [{ player_display_name: ['Ana', 'Ben'] }, { player_display_name: ['Cy', 'Dee'] }]

describe('score over HTTP', { skip: !TEST_DATABASE_URL }, () => {
  let venue: TestVenue
  let other: TestVenue
  let court_id: Uuid

  before(async () => {
    venue = await createTestVenue('score')
    other = await createTestVenue('score-other')
    ;({ court_id } = await setupVenue(venue))
    await setupVenue(other)
  })

  after(async () => {
    await venue?.close()
    await other?.close()
  })

  const json = (value: unknown, method = 'POST'): RequestInit => ({ method, body: JSON.stringify(value) })

  async function createMatch(body: Record<string, unknown> = {}): Promise<MatchView> {
    const response = await venue.request(
      '/api/v1/score/match',
      json({ sport_profile_code: 'pickleball', resource_id: court_id, team: DOUBLES_TEAM, best_of_count: 1, ...body }),
    )
    assert.equal(response.status, 201, await response.clone().text())
    return ((await response.json()) as { match: MatchView }).match
  }

  let op_sequence = 0
  async function send(score_match_id: string, operation: ScoreOperation, client_operation_id = `op-${++op_sequence}`) {
    return venue.request(`/api/v1/score/match/${score_match_id}/operation`, json({ client_operation_id, ...operation }))
  }

  async function read(score_match_id: string): Promise<MatchView> {
    const response = await venue.request(`/api/v1/score/match/${score_match_id}`)
    assert.equal(response.status, 200)
    return ((await response.json()) as { match: MatchView }).match
  }

  it('creates a match on a court that opens at 0-0-2', async () => {
    const match = await createMatch()
    assert.equal(match.status, 'live')
    assert.equal(match.court_display_name, 'Court 1')
    assert.equal(match.state.call_out, '0-0-2')
    assert.deepEqual(match.team[0].player_display_name, ['Ana', 'Ben'])
    assert.equal(match.rule_description, 'Side-out scoring to 11, win by 2 · one game')
  })

  it('refuses an unknown sport, an even best-of, and a malformed team', async () => {
    const unknown = await venue.request('/api/v1/score/match', json({ sport_profile_code: 'curling', team: DOUBLES_TEAM }))
    assert.equal(unknown.status, 422)
    const one_team = await venue.request('/api/v1/score/match', json({ sport_profile_code: 'pickleball', team: [DOUBLES_TEAM[0]] }))
    assert.equal(one_team.status, 400)
    const even = await venue.request('/api/v1/score/match', json({ sport_profile_code: 'pickleball', team: DOUBLES_TEAM, best_of_count: 2 }))
    assert.equal(even.status, 422)
  })

  it('applies a duplicate client_operation_id exactly once, even when the retries race', async () => {
    const match = await createMatch()
    const first = await send(match.score_match_id, { kind: 'rally_won', team_number: 1 }, 'tap-1')
    assert.equal(first.status, 201)
    const again = await send(match.score_match_id, { kind: 'rally_won', team_number: 1 }, 'tap-1')
    assert.equal(again.status, 200)
    const replayed = (await again.json()) as { match: MatchView; is_replay: boolean }
    assert.equal(replayed.is_replay, true)
    assert.equal(replayed.match.operation_count, 1)

    const racing = await Promise.all(Array.from({ length: 6 }, () => send(match.score_match_id, { kind: 'rally_won', team_number: 1 }, 'tap-2')))
    assert.deepEqual(racing.map((one) => one.status).sort(), [200, 200, 200, 200, 200, 201])
    const state = await read(match.score_match_id)
    assert.equal(state.operation_count, 2)
    assert.equal(state.state.call_out, '2-0-2')
  })

  it('converges when two tablets interleave taps on one match', async () => {
    const match = await createMatch()
    const tablet_a: ScoreOperation[] = Array.from({ length: 8 }, () => ({ kind: 'rally_won', team_number: 1 }))
    const tablet_b: ScoreOperation[] = Array.from({ length: 8 }, () => ({ kind: 'rally_won', team_number: 2 }))
    await Promise.all([
      (async () => {
        for (const [position, one] of tablet_a.entries()) await send(match.score_match_id, one, `a-${position}`)
      })(),
      (async () => {
        for (const [position, one] of tablet_b.entries()) await send(match.score_match_id, one, `b-${position}`)
      })(),
    ])
    const seen_by_a = await read(match.score_match_id)
    const seen_by_b = await read(match.score_match_id)
    assert.equal(seen_by_a.operation_count, 16)
    assert.deepEqual(seen_by_a.state, seen_by_b.state)
    // The sequence numbers are gapless and the server state is the replay of them.
    assert.deepEqual(
      seen_by_a.operation.map((one) => one.sequence_number),
      Array.from({ length: 16 }, (_, position) => position + 1),
    )
    const profile = { scoring_rule_code: seen_by_a.scoring_rule_code, best_of_count: seen_by_a.best_of_count, team_size_count: seen_by_a.team_size_count }
    assert.deepEqual(describeState(replay(profile, seen_by_a.operation.map((one) => one.operation)), profile), seen_by_a.state)
  })

  it('restores identical state after a disconnect: the log a tablet reloads replays to the server state', async () => {
    const match = await createMatch()
    for (const team_number of [1, 1, 2, 2, 2, 1, 1, 1] as const) await send(match.score_match_id, { kind: 'rally_won', team_number })
    const before_disconnect = await read(match.score_match_id)
    const after_reconnect = await read(match.score_match_id)
    assert.deepEqual(after_reconnect.state, before_disconnect.state)
    const profile = { scoring_rule_code: 'side_out_11', best_of_count: 1, team_size_count: 2 }
    const offline = describeState(replay(profile, after_reconnect.operation.map((one) => one.operation)), profile)
    assert.deepEqual(offline, after_reconnect.state)
  })

  it('refuses an operation the profile does not allow, with the reason', async () => {
    const match = await createMatch({ team: [{ player_display_name: ['Solo'] }, { player_display_name: ['Rival'] }] })
    assert.equal(match.team_size_count, 1)
    const server_number = await send(match.score_match_id, { kind: 'set_server', team_number: 2, server_number: 1 })
    assert.equal(server_number.status, 422)
    assert.match(((await server_number.json()) as { error: string }).error, /only to side-out doubles/)
    const early_end = await send(match.score_match_id, { kind: 'end_game' })
    assert.equal(early_end.status, 422)
    assert.match(((await early_end.json()) as { error: string }).error, /Game 1 is not over/)
    const nonsense = await venue.request(`/api/v1/score/match/${match.score_match_id}/operation`, json({ client_operation_id: 'x', kind: 'teleport' }))
    assert.equal(nonsense.status, 400)
    const no_id = await venue.request(`/api/v1/score/match/${match.score_match_id}/operation`, json({ kind: 'undo' }))
    assert.equal(no_id.status, 400)
    assert.equal((await read(match.score_match_id)).operation_count, 0)
  })

  let confirmed_id = ''

  it('confirms only a finished match, then locks it against further operations', async () => {
    const match = await createMatch({ best_of_count: 3 })
    const early = await venue.request(`/api/v1/score/match/${match.score_match_id}/confirm`, { method: 'POST' })
    assert.equal(early.status, 409)

    const operation = buildOperationForScore(
      { scoring_rule_code: 'side_out_11', best_of_count: 3, team_size_count: 2 },
      [{ point: [11, 7] }, { point: [11, 9] }],
    )
    for (const one of operation) assert.ok([201].includes((await send(match.score_match_id, one)).status))
    const complete = await read(match.score_match_id)
    assert.equal(complete.status, 'complete')
    assert.equal(complete.state.headline, 'Team 1 wins 2-0')

    const live = await venue.asTenant((tenant) => listLiveMatch(tenant))
    assert.ok(live.some((one) => one.score_match_id === match.score_match_id && one.status === 'complete'))
    assert.equal(await venue.asTenant((tenant) => findMatchResult(tenant, match.score_match_id)), undefined)

    const confirm = await venue.request(`/api/v1/score/match/${match.score_match_id}/confirm`, { method: 'POST' })
    assert.equal(confirm.status, 200)
    const confirmed = ((await confirm.json()) as { match: MatchView }).match
    assert.equal(confirmed.status, 'confirmed')
    assert.equal(confirmed.confirmed_by_display_name, 'Front Desk')

    const locked = await send(match.score_match_id, { kind: 'undo' })
    assert.equal(locked.status, 409)
    const discard = await venue.request(`/api/v1/score/match/${match.score_match_id}/discard`, { method: 'POST' })
    assert.equal(discard.status, 409)
    const twice = await venue.request(`/api/v1/score/match/${match.score_match_id}/confirm`, { method: 'POST' })
    assert.equal(((await twice.json()) as { is_replay: boolean }).is_replay, true)

    const result = await venue.asTenant((tenant) => findMatchResult(tenant, match.score_match_id))
    assert.deepEqual(result?.team.map((one) => one.game_point), [
      [11, 11],
      [7, 9],
    ])
    confirmed_id = match.score_match_id
  })

  it('refuses a silent edit in the database itself', async () => {
    await assert.rejects(
      venue.asTenant((tenant) => tenant.query`UPDATE score_operation SET payload = '{"team_number": 2}' WHERE score_match_id = ${confirmed_id}`),
      /append-only/,
    )
    await assert.rejects(
      venue.asTenant((tenant) => tenant.query`UPDATE score_match SET best_of_count = 5 WHERE score_match_id = ${confirmed_id}`),
      /immutable/,
    )
  })

  it('changes a confirmed result only through an audited correction', async () => {
    const no_reason = await venue.request(`/api/v1/score/match/${confirmed_id}/correct`, json({ game_point: [{ point: [11, 7] }, { point: [9, 11] }, { point: [11, 5] }] }))
    assert.equal(no_reason.status, 400)
    const impossible = await venue.request(`/api/v1/score/match/${confirmed_id}/correct`, json({ reason: 'typo', game_point: [{ point: [15, 3] }] }))
    assert.equal(impossible.status, 422)
    const same = await venue.request(`/api/v1/score/match/${confirmed_id}/correct`, json({ reason: 'typo', game_point: [{ point: [11, 7] }, { point: [11, 9] }] }))
    assert.equal(same.status, 422)

    const response = await venue.request(
      `/api/v1/score/match/${confirmed_id}/correct`,
      json({ reason: 'Game 2 was entered on the wrong side', game_point: [{ point: [11, 7] }, { point: [9, 11] }, { point: [11, 5] }] }),
    )
    assert.equal(response.status, 201, await response.clone().text())
    const body = (await response.json()) as { match: MatchView }
    assert.equal(body.match.status, 'confirmed')
    assert.equal(body.match.operation_set_version, 2)
    assert.deepEqual(
      body.match.state.game_history.map((one) => one.point),
      [
        [11, 7],
        [9, 11],
        [11, 5],
      ],
    )
    assert.equal(body.match.correction.length, 1)
    assert.equal(body.match.correction[0]?.reason, 'Game 2 was entered on the wrong side')
    assert.equal(body.match.correction[0]?.actor_display_name, 'Front Desk')
    assert.deepEqual(body.match.correction[0]?.previous_game_point, [
      [11, 7],
      [11, 9],
    ])

    // The played operations were not touched — both sets are still in the log.
    const version = await venue.asTenant((tenant) =>
      tenant.query<{ operation_set_version: number; count: number }[]>`
        SELECT operation_set_version, count(*)::int AS count FROM score_operation
        WHERE score_match_id = ${confirmed_id} GROUP BY operation_set_version ORDER BY operation_set_version`,
    )
    assert.equal(version.length, 2)

    const live_match = await createMatch()
    const not_confirmed = await venue.request(`/api/v1/score/match/${live_match.score_match_id}/correct`, json({ reason: 'x', game_point: [{ point: [11, 2] }] }))
    assert.equal(not_confirmed.status, 409)
  })

  it('lists live matches and recent results', async () => {
    const live = (await (await venue.request('/api/v1/score/match?view=live')).json()) as { match: MatchView[] }
    assert.ok(live.match.length > 0)
    assert.ok(live.match.every((one) => one.status !== 'confirmed'))
    const recent = (await (await venue.request('/api/v1/score/match?view=recent')).json()) as { match: MatchView[] }
    assert.ok(recent.match.some((one) => one.score_match_id === confirmed_id))
    const option = (await (await venue.request('/api/v1/score/option')).json()) as { court: unknown[]; sport_profile: { sport_profile_code: string; is_supported: boolean }[] }
    assert.equal(option.court.length, 1)
    assert.equal(option.sport_profile.find((one) => one.sport_profile_code === 'tennis')?.is_supported, true)
  })

  it('discards a live match scored by mistake', async () => {
    const match = await createMatch()
    const response = await venue.request(`/api/v1/score/match/${match.score_match_id}/discard`, { method: 'POST' })
    assert.equal(response.status, 200)
    assert.equal((await venue.request(`/api/v1/score/match/${match.score_match_id}`)).status, 404)
  })

  it('keeps one venue out of another venue\'s matches', async () => {
    const match = await createMatch()
    assert.equal((await other.request(`/api/v1/score/match/${match.score_match_id}`)).status, 404)
    const tap = await other.request(`/api/v1/score/match/${match.score_match_id}/operation`, json({ client_operation_id: 'intruder', kind: 'rally_won', team_number: 1 }))
    assert.equal(tap.status, 404)
    const list = (await (await other.request('/api/v1/score/match?view=live')).json()) as { match: MatchView[] }
    assert.ok(list.match.every((one) => one.score_match_id !== match.score_match_id))
    assert.equal((await read(match.score_match_id)).operation_count, 0)
  })

  it('answers 404 when the score module is disabled', async () => {
    await other.asTenant(async (tenant) => {
      await disableModule(tenant, 'dupr', COURT_DECLARATION)
      await disableModule(tenant, 'score', COURT_DECLARATION)
    })
    assert.equal((await other.request('/api/v1/score/match')).status, 404)
    assert.equal((await other.request('/api/v1/score/option')).status, 404)
  })
})
