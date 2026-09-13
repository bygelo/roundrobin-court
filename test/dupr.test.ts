// R20 — DUPR connector against the deterministic sandbox adapter.

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { TenantContext } from '@bygelo/roundrobin-kernel'
import { createSandboxAdapter, isRefusal } from '../src/module/dupr/adapter.ts'
import { joinName, retrySubmission, submitDuprMatch } from '../src/module/dupr/service.ts'
import type { MatchResult } from '../src/module/score/contract.ts'
import { TEST_DATABASE_URL, createTestVenue, type TestVenue } from './helper.ts'

process.env['DUPR_MODE'] = 'sandbox'
delete process.env['DUPR_CLIENT_ID']
delete process.env['DUPR_CLIENT_SECRET']
delete process.env['DUPR_BASE_URL']

describe('dupr sandbox adapter', () => {
  it('is deterministic and refuses ids that are not DUPR ids', async () => {
    const adapter = createSandboxAdapter({ DUPR_MODE: 'sandbox' })
    const first = await adapter.validatePlayer('dupr-ana01')
    const second = await adapter.validatePlayer('DUPR-ANA01')
    assert.ok(!isRefusal(first) && !isRefusal(second))
    assert.equal(first.doubles_rating, second.doubles_rating)
    assert.ok(isRefusal(await adapter.validatePlayer('12345')))
  })

  it('is off unless asked for', async () => {
    const result = await createSandboxAdapter({}).validateConnection()
    assert.ok(isRefusal(result) && result.refusal_code === 'not_configured')
  })

  it('names missing players in plain English', () => {
    assert.equal(joinName(['Ana']), 'Ana')
    assert.equal(joinName(['Ana', 'Ben']), 'Ana and Ben')
    assert.equal(joinName(['Ana', 'Ben', 'Cy']), 'Ana, Ben, and Cy')
  })
})

describe('dupr connector', { skip: !TEST_DATABASE_URL }, () => {
  let venue: TestVenue
  const json = async <T>(response: Response) => (await response.json()) as T
  const post = (path: string, body: unknown) => venue.request(path, { method: 'POST', body: JSON.stringify(body) })

  before(async () => {
    venue = await createTestVenue('dupr')
  })
  after(() => venue.close())

  const result = (score_match_id: string, name: [string, string, string, string]): MatchResult => ({
    score_match_id,
    status: 'confirmed',
    played_at: '2027-03-01T10:00:00.000Z',
    sport_profile_code: 'pickleball',
    team: [
      { team_number: 1, party_id: [null, null], player_display_name: [name[0], name[1]], game_point: [11, 9, 11] },
      { team_number: 2, party_id: [null, null], player_display_name: [name[2], name[3]], game_point: [7, 11, 5] },
    ],
  })
  const finder = (value: MatchResult | undefined) => async (_tenant: TenantContext, _id: string) => value

  it('says "not configured" honestly for live mode without credentials', async () => {
    const response = await post('/api/v1/dupr/connection', { mode_code: 'live' })
    assert.equal(response.status, 409)
    const body = await json<{ error: string; status: { status_code: string } }>(response)
    assert.match(body.error, /not configured/)
    assert.equal(body.status.status_code, 'not_configured')
    const status = await json<{ status: { status_code: string; is_live_configured: boolean } }>(
      await venue.request('/api/v1/dupr/status'),
    )
    assert.equal(status.status.status_code, 'not_configured')
    assert.equal(status.status.is_live_configured, false)
  })

  it('will not link a player before DUPR is connected', async () => {
    const response = await post('/api/v1/dupr/player-link', { display_name: 'Ana Cruz', dupr_id: 'DUPR-ANA01', has_consent: true })
    assert.equal(response.status, 409)
  })

  it('connects the sandbox through a connector account holding only a reference', async () => {
    const response = await post('/api/v1/dupr/connection', { mode_code: 'sandbox' })
    assert.equal(response.status, 200)
    assert.equal((await json<{ status: { status_code: string } }>(response)).status.status_code, 'sandbox')
    const [account] = await venue.asTenant((tenant) =>
      tenant.query<{ secret_kind: string; secret_ref: string; validation_status: string }[]>`
        SELECT secret_kind, secret_ref, validation_status FROM connector_account WHERE provider_code = 'dupr' AND status = 'connected'`,
    )
    assert.deepEqual(account, { secret_kind: 'reference', secret_ref: 'env:DUPR_MODE', validation_status: 'valid' })
  })

  it('requires consent, refuses an unknown DUPR ID, and links a valid one with a dated rating', async () => {
    const no_consent = await post('/api/v1/dupr/player-link', { display_name: 'Ana Cruz', dupr_id: 'DUPR-ANA01', has_consent: false })
    assert.equal(no_consent.status, 400)
    assert.match((await json<{ error: string }>(no_consent)).error, /consent/)

    const invalid = await post('/api/v1/dupr/player-link', { display_name: 'Ana Cruz', dupr_id: '998877', has_consent: true })
    assert.equal(invalid.status, 422)

    const created = await post('/api/v1/dupr/player-link', { display_name: 'Ana Cruz', dupr_id: 'dupr-ana01', has_consent: true })
    assert.equal(created.status, 201)
    const { player_link } = await json<{
      player_link: { dupr_id: string; doubles_rating: string; rating_source_code: string; rating_fetched_at: string; is_stale: boolean }
    }>(created)
    assert.equal(player_link.dupr_id, 'DUPR-ANA01')
    assert.match(player_link.doubles_rating, /^\d\.\d{3}$/)
    assert.equal(player_link.rating_source_code, 'dupr_sandbox')
    assert.equal(player_link.is_stale, false)

    const duplicate = await post('/api/v1/dupr/player-link', { display_name: 'Someone Else', dupr_id: 'DUPR-ANA01', has_consent: true })
    assert.equal(duplicate.status, 409)
  })

  it('gates eligibility on the rating, with source, time, and stale label', async () => {
    const [party] = await venue.asTenant((tenant) =>
      tenant.query<{ party_id: string }[]>`
        INSERT INTO party (organization_id, display_name) VALUES (${venue.organization_id}, 'Ben Reyes') RETURNING party_id`,
    )
    const created = await post('/api/v1/dupr/player-link', { party_id: party!.party_id, dupr_id: 'DUPR-BEN02', has_consent: true })
    const { player_link } = await json<{ player_link: { display_name: string; doubles_rating: string } }>(created)
    assert.equal(player_link.display_name, 'Ben Reyes')
    const rating = Number(player_link.doubles_rating)

    const pass = await json<{ eligibility: { is_eligible: boolean; rating_source_code: string; rating_fetched_at: string } }>(
      await venue.request(`/api/v1/dupr/eligibility?party_id=${party!.party_id}&min_rating=${(rating - 0.001).toFixed(3)}`),
    )
    assert.equal(pass.eligibility.is_eligible, true)
    assert.equal(pass.eligibility.rating_source_code, 'dupr_sandbox')
    assert.ok(pass.eligibility.rating_fetched_at)
    const fail = await json<{ eligibility: { is_eligible: boolean; reason: string } }>(
      await venue.request(`/api/v1/dupr/eligibility?party_id=${party!.party_id}&min_rating=${(rating + 0.001).toFixed(3)}`),
    )
    assert.equal(fail.eligibility.is_eligible, false)
    assert.match(fail.eligibility.reason, /below/)

    await venue.asTenant((tenant) => tenant.query`
      UPDATE dupr_player_link SET rating_fetched_at = now() - interval '8 days' WHERE party_id = ${party!.party_id}`)
    const list = await json<{ player_link: { display_name: string; is_stale: boolean }[] }>(await venue.request('/api/v1/dupr/player-link'))
    assert.equal(list.player_link.find((one) => one.display_name === 'Ben Reyes')!.is_stale, true)
    const refreshed = await json<{ eligibility: { is_stale: boolean } }>(
      await venue.request(`/api/v1/dupr/eligibility?party_id=${party!.party_id}&min_rating=2`),
    )
    assert.equal(refreshed.eligibility.is_stale, false, 'a reachable DUPR refreshes a stale snapshot')
  })

  it('blocks submission until the result is confirmed and every player is linked', async () => {
    const unconfirmed = await post('/api/v1/dupr/submission', { score_match_id: crypto.randomUUID() })
    assert.equal(unconfirmed.status, 409)
    assert.match((await json<{ error: string }>(unconfirmed)).error, /confirmed/)

    const id = crypto.randomUUID()
    const match = result(id, ['Ana Cruz', 'Ben Reyes', 'Carla Diaz', 'Dan Lim'])
    await assert.rejects(
      venue.asTenant((tenant) => submitDuprMatch(tenant, id, { findResult: finder(match) })),
      (error: Error & { http_status?: number }) => {
        assert.equal(error.http_status, 409)
        assert.match(error.message, /Carla Diaz and Dan Lim have no linked DUPR ID/)
        return true
      },
    )
    const [count] = await venue.asTenant((tenant) =>
      tenant.query<{ submission_count: number }[]>`SELECT count(*)::int AS submission_count FROM dupr_submission`,
    )
    assert.equal(count!.submission_count, 0, 'a refused submission writes nothing')
  })

  it('submits once: a duplicate — even a concurrent one — returns the same receipt', async () => {
    for (const [name, dupr_id] of [['Carla Diaz', 'DUPR-CARLA3'], ['Dan Lim', 'DUPR-DAN04']]) {
      assert.equal((await post('/api/v1/dupr/player-link', { display_name: name, dupr_id, has_consent: true })).status, 201)
    }
    const id = crypto.randomUUID()
    const match = result(id, ['Ana Cruz', 'Ben Reyes', 'Carla Diaz', 'Dan Lim'])
    const [first, second] = await Promise.all([
      venue.asTenant((tenant) => submitDuprMatch(tenant, id, { findResult: finder(match) })),
      venue.asTenant((tenant) => submitDuprMatch(tenant, id, { findResult: finder(match) })),
    ])
    assert.equal(first.submission.status_code, 'submitted')
    assert.match(first.submission.receipt_code!, /^SBX-/)
    assert.equal(second.submission.receipt_code, first.submission.receipt_code)
    assert.equal([first.is_duplicate, second.is_duplicate].filter(Boolean).length, 1)

    const third = await venue.asTenant((tenant) => submitDuprMatch(tenant, id, { findResult: finder(match) }))
    assert.equal(third.is_duplicate, true)
    assert.equal(third.submission.attempt_count, 1, 'DUPR was called once')
    const list = await json<{ submission: { score_match_id: string; match_label: string }[] }>(await venue.request('/api/v1/dupr/submission'))
    assert.equal(list.submission.filter((one) => one.score_match_id === id).length, 1)
    assert.equal(list.submission[0]!.match_label, 'Ana Cruz & Ben Reyes vs Carla Diaz & Dan Lim')
  })

  it('stores a rejection with an actionable message, and a retry after the fix submits', async () => {
    const created = await post('/api/v1/dupr/player-link', { display_name: 'Eve Tan', dupr_id: 'DUPR-REJECT-EVE', has_consent: true })
    const { player_link } = await json<{ player_link: { dupr_player_link_id: string } }>(created)
    const id = crypto.randomUUID()
    const match = result(id, ['Ana Cruz', 'Eve Tan', 'Carla Diaz', 'Dan Lim'])
    const rejected = await venue.asTenant((tenant) => submitDuprMatch(tenant, id, { findResult: finder(match) }))
    assert.equal(rejected.submission.status_code, 'rejected')
    assert.equal(rejected.submission.rejection_code, 'player_not_verified')
    assert.match(rejected.submission.rejection_message!, /Eve Tan .* verify their account/)

    const again = await venue.asTenant((tenant) => submitDuprMatch(tenant, id, { findResult: finder(match) }))
    assert.equal(again.submission.attempt_count, 1, 'a plain resubmit does not hammer DUPR with a known rejection')

    assert.equal((await venue.request(`/api/v1/dupr/player-link/${player_link.dupr_player_link_id}`, { method: 'DELETE' })).status, 200)
    await post('/api/v1/dupr/player-link', { display_name: 'Eve Tan', dupr_id: 'DUPR-EVE05', has_consent: true })
    const retried = await venue.asTenant((tenant) =>
      retrySubmission(tenant, rejected.submission.dupr_submission_id, { findResult: finder(match) }),
    )
    assert.equal(retried.submission.status_code, 'submitted')
    assert.equal(retried.submission.attempt_count, 2)
  })

  it('keeps a submission queued, never lost, through a DUPR outage', async () => {
    await post('/api/v1/dupr/player-link', { display_name: 'Finn Go', dupr_id: 'DUPR-OUTAGE-FINN', has_consent: true })
    const id = crypto.randomUUID()
    const match = result(id, ['Ana Cruz', 'Finn Go', 'Carla Diaz', 'Dan Lim'])
    const outcome = await venue.asTenant((tenant) => submitDuprMatch(tenant, id, { findResult: finder(match) }))
    assert.equal(outcome.submission.status_code, 'pending')
    assert.match(outcome.submission.last_error!, /saved here and queued/)
  })

  it('disconnects without touching local links or results', async () => {
    const before_link = await json<{ player_link: unknown[] }>(await venue.request('/api/v1/dupr/player-link'))
    const before_submission = await json<{ submission: unknown[] }>(await venue.request('/api/v1/dupr/submission'))
    const response = await post('/api/v1/dupr/disconnect', {})
    assert.equal(response.status, 200)
    assert.equal((await json<{ status: { status_code: string } }>(response)).status.status_code, 'not_configured')

    const after_link = await json<{ player_link: unknown[] }>(await venue.request('/api/v1/dupr/player-link'))
    const after_submission = await json<{ submission: unknown[] }>(await venue.request('/api/v1/dupr/submission'))
    assert.equal(after_link.player_link.length, before_link.player_link.length)
    assert.equal(after_submission.submission.length, before_submission.submission.length)
    const [account] = await venue.asTenant((tenant) =>
      tenant.query<{ connected_count: number }[]>`
        SELECT count(*)::int AS connected_count FROM connector_account WHERE provider_code = 'dupr' AND status = 'connected'`,
    )
    assert.equal(account!.connected_count, 0)
    const blocked = await post('/api/v1/dupr/submission', { score_match_id: crypto.randomUUID() })
    assert.equal(blocked.status, 409)
    assert.match((await json<{ error: string }>(blocked)).error, /not connected/)
  })
})
