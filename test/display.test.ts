// R13 over HTTP: screens minted by the venue, pulled by credential, each
// seeing exactly its own view — and nothing once revoked.

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { disableModule, type Uuid } from '@bygelo/roundrobin-kernel'
import { COURT_DECLARATION } from '../src/app.ts'
import type { CounterProjection, CourtProjection, LoungeProjection, ScreenView } from '../src/module/display/service.ts'
import type { MatchView } from '../src/module/score/service.ts'
import { TEST_DATABASE_URL, createTestVenue, type TestVenue } from './helper.ts'

const CUSTOMER_EMAIL = 'maria.booker@example.com'
const CUSTOMER_PHONE = '+639171234567'
const CUSTOMER_NAME = 'Maria Booker'

/** A zone where it is about 06:00 now, so "later today" always has room. */
function morningTimeZone(): string {
  const offset = ((6 - new Date().getUTCHours() + 36) % 24) - 12
  if (offset === 0) return 'Etc/GMT'
  return offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`
}

type Setup = { court_1: Uuid; court_2: Uuid }

async function setupVenue(venue: TestVenue): Promise<Setup> {
  return venue.asTenant(async (tenant) => {
    const organization_id = venue.organization_id
    await tenant.query`
      INSERT INTO sport_profile (organization_id, sport_profile_code, display_name, team_size_count, scoring_rule_code)
      VALUES (${organization_id}, 'pickleball', 'Pickleball', 2, 'side_out_11')`
    const [category] = await tenant.query<{ resource_category_id: Uuid }[]>`
      INSERT INTO resource_category (organization_id, resource_category_code, display_name)
      VALUES (${organization_id}, 'pickleball', 'Pickleball') RETURNING resource_category_id`
    const [site] = await tenant.query<{ site_id: Uuid }[]>`
      INSERT INTO site (organization_id, site_code, display_name, time_zone)
      VALUES (${organization_id}, 'main', 'Main', ${morningTimeZone()}) RETURNING site_id`
    const court: Uuid[] = []
    for (const number of [1, 2]) {
      const [row] = await tenant.query<{ resource_id: Uuid }[]>`
        INSERT INTO resource (organization_id, site_id, resource_code, display_name, sort_order)
        VALUES (${organization_id}, ${site!.site_id}, ${`court-${number}`}, ${`Court ${number}`}, ${number}) RETURNING resource_id`
      await tenant.query`
        INSERT INTO resource_category_link (organization_id, resource_id, resource_category_id)
        VALUES (${organization_id}, ${row!.resource_id}, ${category!.resource_category_id})`
      court.push(row!.resource_id)
    }

    // A session running now on both courts, booked on Court 1 by a customer with contact details.
    const [now_session] = await tenant.query<{ session_id: Uuid }[]>`
      INSERT INTO session (organization_id, site_id, session_code, starts_at, ends_at, capacity_count, price_amount, is_published)
      VALUES (${organization_id}, ${site!.site_id}, 'now', now() - interval '10 minutes', now() + interval '50 minutes', 4, 400, true)
      RETURNING session_id`
    const [later_session] = await tenant.query<{ session_id: Uuid }[]>`
      INSERT INTO session (organization_id, site_id, session_code, starts_at, ends_at, capacity_count, price_amount, is_published)
      VALUES (${organization_id}, ${site!.site_id}, 'later', now() + interval '1 hour', now() + interval '2 hours', 4, 450, true)
      RETURNING session_id`
    for (const session_id of [now_session!.session_id, later_session!.session_id]) {
      for (const resource_id of court) {
        await tenant.query`
          INSERT INTO session_resource (organization_id, session_id, resource_id) VALUES (${organization_id}, ${session_id}, ${resource_id})`
      }
    }
    const [party] = await tenant.query<{ party_id: Uuid }[]>`
      INSERT INTO party (organization_id, display_name, email_address, phone_number)
      VALUES (${organization_id}, ${CUSTOMER_NAME}, ${CUSTOMER_EMAIL}, ${CUSTOMER_PHONE}) RETURNING party_id`
    await tenant.query`
      INSERT INTO booking (organization_id, session_id, resource_id, party_id, booking_code, status, participant_count,
                           price_amount, starts_at, ends_at)
      SELECT ${organization_id}, session_id, ${court[0]!}, ${party!.party_id}, ${`B-${Date.now()}`}, 'confirmed', 4, 400, starts_at, ends_at
      FROM session WHERE session_id = ${now_session!.session_id}`
    return { court_1: court[0]!, court_2: court[1]! }
  })
}

describe('display screens', { skip: !TEST_DATABASE_URL }, () => {
  let venue: TestVenue
  let other: TestVenue
  let setup: Setup
  const credential: Record<'court' | 'lounge' | 'counter', string> = { court: '', lounge: '', counter: '' }
  const screen_id: Record<'court' | 'lounge' | 'counter', string> = { court: '', lounge: '', counter: '' }

  before(async () => {
    venue = await createTestVenue('display')
    other = await createTestVenue('display-other')
    setup = await setupVenue(venue)
    await setupVenue(other)

    // A live match on each court.
    for (const [resource_id, name] of [
      [setup.court_1, ['Ana Cruz', 'Ben Tan']],
      [setup.court_2, ['Zed Second', 'Yul Second']],
    ] as const) {
      const created = await venue.request('/api/v1/score/match', {
        method: 'POST',
        body: JSON.stringify({ sport_profile_code: 'pickleball', resource_id, team: [{ player_display_name: name }, { player_display_name: ['Opp One', 'Opp Two'] }] }),
      })
      const { match } = (await created.json()) as { match: MatchView }
      for (const [position, team_number] of [1, 1, 1].entries()) {
        await venue.request(`/api/v1/score/match/${match.score_match_id}/operation`, {
          method: 'POST',
          body: JSON.stringify({ client_operation_id: `seed-${position}`, kind: 'rally_won', team_number }),
        })
      }
    }
  })

  after(async () => {
    await venue?.close()
    await other?.close()
  })

  const post = (target: TestVenue, path: string, value: unknown) => target.request(path, { method: 'POST', body: JSON.stringify(value) })
  const pull = (value: string) => venue.publicRequest('/public/display/state', { method: 'POST', body: JSON.stringify({ credential: value }) })

  it('refuses a screen without a kind, a name, or (for a court screen) a court', async () => {
    assert.equal((await post(venue, '/api/v1/display/screen', { kind: 'kiosk', display_name: 'X' })).status, 400)
    assert.equal((await post(venue, '/api/v1/display/screen', { kind: 'lounge', display_name: '  ' })).status, 400)
    assert.equal((await post(venue, '/api/v1/display/screen', { kind: 'court', display_name: 'Court TV' })).status, 400)
  })

  it('mints court, lounge, and counter screens with a one-time enrolment link', async () => {
    for (const [kind, body] of [
      ['court', { kind: 'court', display_name: 'Court 1 TV', resource_id: setup.court_1 }],
      ['lounge', { kind: 'lounge', display_name: 'Lounge TV' }],
      ['counter', { kind: 'counter', display_name: 'Front counter' }],
    ] as const) {
      const response = await post(venue, '/api/v1/display/screen', body)
      assert.equal(response.status, 201, await response.clone().text())
      const created = (await response.json()) as { screen: ScreenView; credential: string; enrolment_path: string }
      assert.match(created.credential, /^rro_/)
      assert.equal(created.enrolment_path, `/display?credential=${encodeURIComponent(created.credential)}`)
      assert.equal(created.screen.status, 'offline')
      credential[kind] = created.credential
      screen_id[kind] = created.screen.display_screen_id
    }
    const list = await venue.request('/api/v1/display/screen')
    const text = await list.text()
    for (const one of Object.values(credential)) assert.equal(text.includes(one), false, 'the list never re-emits a credential')
    assert.equal(((JSON.parse(text) as { screen: ScreenView[] }).screen).length, 3)
  })

  it('shows a court screen only its own court, with no customer details', async () => {
    const response = await pull(credential.court)
    assert.equal(response.status, 200)
    const text = await response.text()
    const body = JSON.parse(text) as { kind: string; display_name: string; venue_name: string; stale_after_second: number; generated_at: string; projection: CourtProjection }
    assert.equal(body.kind, 'court')
    assert.equal(body.venue_name, 'Test Pickleball Club')
    assert.equal(body.stale_after_second, 30)
    assert.equal(body.projection.court.display_name, 'Court 1')
    assert.equal(body.projection.court.sport_display_name, 'Pickleball')
    assert.equal(body.projection.live_match?.team[0]?.display_name, 'Ana Cruz & Ben Tan')
    assert.equal(body.projection.live_match?.call_out, '3-0-2')
    assert.ok(body.projection.current_booking, 'Court 1 is booked now')
    assert.ok(body.projection.next_booking === null)
    for (const forbidden of ['Court 2', 'Zed Second', CUSTOMER_EMAIL, CUSTOMER_PHONE, CUSTOMER_NAME, 'party_id', 'booking_code', 'score_match_id']) {
      assert.equal(text.includes(forbidden), false, `court screen must not show ${forbidden}`)
    }
  })

  it('records the pull as a heartbeat: the screen turns online', async () => {
    const list = (await (await venue.request('/api/v1/display/screen')).json()) as { screen: ScreenView[] }
    const court = list.screen.find((one) => one.display_screen_id === screen_id.court)
    assert.equal(court?.status, 'online')
    assert.ok(court?.last_seen_at)
    assert.equal(list.screen.find((one) => one.display_screen_id === screen_id.lounge)?.status, 'offline')
  })

  it('shows the lounge every court and its live score, still without customer details', async () => {
    const response = await pull(credential.lounge)
    const text = await response.text()
    const body = JSON.parse(text) as { kind: string; projection: LoungeProjection }
    assert.equal(body.kind, 'lounge')
    assert.deepEqual(body.projection.court.map((one) => one.display_name), ['Court 1', 'Court 2'])
    assert.equal(body.projection.court[1]?.live_match?.team[0]?.display_name, 'Zed Second & Yul Second')
    assert.equal(body.projection.court[1]?.current_booking, null)
    assert.ok(Array.isArray(body.projection.open_play))
    for (const forbidden of [CUSTOMER_EMAIL, CUSTOMER_PHONE, CUSTOMER_NAME, 'party_id']) assert.equal(text.includes(forbidden), false)
  })

  it('shows the counter open slots and arrivals, and no players or scores', async () => {
    const response = await pull(credential.counter)
    const text = await response.text()
    const body = JSON.parse(text) as { kind: string; projection: CounterProjection }
    assert.equal(body.kind, 'counter')
    // Court 1 and 2 are free in the later session; the running session has started.
    assert.deepEqual(body.projection.next_available.map((one) => one.court_display_name), ['Court 1', 'Court 2'])
    assert.equal(body.projection.next_available[0]?.price_amount, '450.00')
    assert.equal(body.projection.booking_today_count, 1)
    assert.equal(body.projection.player_expected_count, 4)
    assert.equal(body.projection.court_count, 2)
    assert.equal(body.projection.court_in_use_count, 2)
    for (const forbidden of ['Ana Cruz', 'Zed Second', 'call_out', CUSTOMER_EMAIL, CUSTOMER_NAME]) assert.equal(text.includes(forbidden), false)
  })

  it('refuses a missing or unknown credential', async () => {
    assert.equal((await venue.publicRequest('/public/display/state', { method: 'POST', body: '{}' })).status, 400)
    assert.equal((await pull('rro_not-a-real-credential')).status, 401)
  })

  it('keeps one venue out of another venue\'s screens', async () => {
    assert.equal((await post(other, `/api/v1/display/screen/${screen_id.lounge}/revoke`, {})).status, 404)
    const list = (await (await other.request('/api/v1/display/screen')).json()) as { screen: ScreenView[] }
    assert.equal(list.screen.length, 0)
    assert.equal((await pull(credential.lounge)).status, 200)
  })

  it('revokes one screen: its next pull is 401 and the others keep working', async () => {
    const response = await post(venue, `/api/v1/display/screen/${screen_id.court}/revoke`, {})
    assert.equal(response.status, 200)
    assert.equal(((await response.json()) as { screen: ScreenView }).screen.status, 'revoked')
    assert.equal((await pull(credential.court)).status, 401)
    assert.equal((await pull(credential.lounge)).status, 200)
    assert.equal((await post(venue, `/api/v1/display/screen/${screen_id.court}/revoke`, {})).status, 409)
  })

  it('answers 404 to staff and 401 to the screen when the display module is disabled', async () => {
    await venue.asTenant((tenant) => disableModule(tenant, 'display', COURT_DECLARATION))
    assert.equal((await venue.request('/api/v1/display/screen')).status, 404)
    assert.equal((await pull(credential.lounge)).status, 401)
  })
})
