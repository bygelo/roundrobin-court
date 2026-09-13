// R13's two open conditions over HTTP: a kiosk screen that shows today's open
// slots, open play, and programs with a booking QR — and never a customer —
// and a Studio publish that reaches every screen, visible per screen to staff.

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { disableModule, type Uuid } from '@bygelo/roundrobin-kernel'
import { COURT_DECLARATION } from '../src/app.ts'
import type { KioskProjection, ScreenView } from '../src/module/display/service.ts'
import type { StudioDocument } from '../src/module/studio/schema.ts'
import { TEST_DATABASE_URL, createTestVenue, type TestVenue } from './helper.ts'

const CUSTOMER_NAME = 'Maria Booker'
const CUSTOMER_EMAIL = 'maria.booker@example.com'
const CUSTOMER_PHONE = '+639171234567'
const REGISTRANT_NAME = 'Rita Registrant'
const REGISTRANT_EMAIL = 'rita.registrant@example.com'
const PLAYER_NAME = 'Quincella Waitingham'
const TABLET_ORIGIN = 'https://club.example.test'

/** A zone where it is about 06:00 now, so "later today" always has room. */
function morningTimeZone(): string {
  const offset = ((6 - new Date().getUTCHours() + 36) % 24) - 12
  if (offset === 0) return 'Etc/GMT'
  return offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`
}

type Setup = { court: Uuid[]; slot: Record<'later' | 'later_two' | 'far' | 'tomorrow', string> }

async function setupVenue(venue: TestVenue): Promise<Setup> {
  const setup = await venue.asTenant(async (tenant) => {
    const organization_id = venue.organization_id
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

    // later (+1h), later_two (+2h): inside the kiosk horizon. far (+5h): later
    // today but past the horizon. tomorrow (+26h): not today at all.
    const hour: Record<keyof Setup['slot'], number> = { later: 1, later_two: 2, far: 5, tomorrow: 26 }
    const session_id: Partial<Record<keyof Setup['slot'], Uuid>> = {}
    const slot: Partial<Record<keyof Setup['slot'], string>> = {}
    for (const [code, offset] of Object.entries(hour) as [keyof Setup['slot'], number][]) {
      const [row] = await tenant.query<{ session_id: Uuid; starts_at: Date }[]>`
        INSERT INTO session (organization_id, site_id, session_code, starts_at, ends_at, capacity_count, price_amount, is_published)
        VALUES (${organization_id}, ${site!.site_id}, ${code}, now() + make_interval(hours => ${offset}),
                now() + make_interval(hours => ${offset + 1}), 4, 450, true)
        RETURNING session_id, starts_at`
      session_id[code] = row!.session_id
      slot[code] = new Date(row!.starts_at).toISOString()
      for (const resource_id of court) {
        await tenant.query`
          INSERT INTO session_resource (organization_id, session_id, resource_id) VALUES (${organization_id}, ${row!.session_id}, ${resource_id})`
      }
    }

    // Court 1 is booked in the "later" slot by a customer with contact details.
    const [party] = await tenant.query<{ party_id: Uuid }[]>`
      INSERT INTO party (organization_id, display_name, email_address, phone_number)
      VALUES (${organization_id}, ${CUSTOMER_NAME}, ${CUSTOMER_EMAIL}, ${CUSTOMER_PHONE}) RETURNING party_id`
    await tenant.query`
      INSERT INTO booking (organization_id, session_id, resource_id, party_id, booking_code, status, participant_count,
                           price_amount, starts_at, ends_at)
      SELECT ${organization_id}, session_id, ${court[0]!}, ${party!.party_id}, ${`B-${Date.now()}`}, 'confirmed', 4, 450, starts_at, ends_at
      FROM session WHERE session_id = ${session_id.later!}`

    // A clinic later today with one registrant, and one tomorrow.
    for (const [title, offset] of [['Morning Clinic', 3], ['Tomorrow Social', 27]] as const) {
      const [program] = await tenant.query<{ program_id: Uuid }[]>`
        INSERT INTO program (organization_id, kind_code, title, price_amount, capacity_count, is_published)
        VALUES (${organization_id}, 'clinic', ${title}, 600, 10, true) RETURNING program_id`
      const [occurrence] = await tenant.query<{ program_occurrence_id: Uuid }[]>`
        INSERT INTO program_occurrence (organization_id, program_id, occurrence_date, starts_at, ends_at, capacity_count)
        VALUES (${organization_id}, ${program!.program_id}, (now() + make_interval(hours => ${offset}))::date,
                now() + make_interval(hours => ${offset}), now() + make_interval(hours => ${offset + 1}), 10)
        RETURNING program_occurrence_id`
      await tenant.query`
        INSERT INTO program_registration (organization_id, program_occurrence_id, display_name, email_address, credential_hash)
        VALUES (${organization_id}, ${occurrence!.program_occurrence_id}, ${REGISTRANT_NAME}, ${REGISTRANT_EMAIL},
                ${`hash-${organization_id}-${title}`})`
    }
    return { court, slot: slot as Setup['slot'] }
  })

  // Open play running now with a player waiting.
  const created = await venue.request('/api/v1/play/session', {
    method: 'POST',
    body: JSON.stringify({
      display_name: 'Lunch Open Play',
      starts_at: new Date(Date.now() - 30 * 60_000).toISOString(),
      ends_at: new Date(Date.now() + 2 * 3600_000).toISOString(),
      format_code: 'doubles',
      capacity_count: 8,
      resource_id: setup.court,
    }),
  })
  assert.equal(created.status, 201, await created.clone().text())
  const { play_session } = (await created.json()) as { play_session: { play_session_id: Uuid } }
  const entry = await venue.request(`/api/v1/play/session/${play_session.play_session_id}/entry`, {
    method: 'POST',
    body: JSON.stringify({ display_name: PLAYER_NAME }),
  })
  assert.equal(entry.status, 201, await entry.clone().text())
  return setup
}

type Pull = {
  kind: string
  venue_name: string
  site_version_number: number
  brand: { display_name: string; accent: string; action: string; heading_font: string }
  projection: KioskProjection
}

describe('display kiosk and Studio version convergence', { skip: !TEST_DATABASE_URL }, () => {
  let venue: TestVenue
  let other: TestVenue
  let setup: Setup
  let credential = ''
  let screen_id = ''
  let other_credential = ''
  let lounge_credential = ''

  before(async () => {
    venue = await createTestVenue('kiosk')
    other = await createTestVenue('kiosk-other')
    setup = await setupVenue(venue)
    await setupVenue(other)
  })

  after(async () => {
    await venue?.close()
    await other?.close()
  })

  const post = (target: TestVenue, path: string, value: unknown) => target.request(path, { method: 'POST', body: JSON.stringify(value) })
  const pull = async (target: TestVenue, value: string, extra: Record<string, unknown> = {}) => {
    const response = await target.publicRequest('/public/display/state', {
      method: 'POST',
      body: JSON.stringify({ credential: value, origin: TABLET_ORIGIN, ...extra }),
    })
    const text = await response.text()
    assert.equal(response.status, 200, text)
    return { text, body: JSON.parse(text) as Pull }
  }
  const listScreen = async (target: TestVenue) => ((await (await target.request('/api/v1/display/screen')).json()) as { screen: ScreenView[] }).screen

  async function mint(target: TestVenue, kind: string, display_name: string): Promise<{ credential: string; screen: ScreenView }> {
    const response = await post(target, '/api/v1/display/screen', { kind, display_name })
    assert.equal(response.status, 201, await response.clone().text())
    return (await response.json()) as { credential: string; screen: ScreenView }
  }

  async function publish(target: TestVenue, accent: string, display_name: string): Promise<number> {
    const draft = (await (await target.request('/api/v1/studio/draft')).json()) as { draft: { document: StudioDocument } }
    const document: StudioDocument = {
      ...draft.draft.document,
      display_name,
      token: { ...draft.draft.document.token, accent, heading_font: 'Inter' },
    }
    const response = await post(target, '/api/v1/studio/publish', { document })
    assert.equal(response.status, 201, await response.clone().text())
    return ((await response.json()) as { version_number: number }).version_number
  }

  it('enrols a kiosk screen like the other kinds', async () => {
    const created = await mint(venue, 'kiosk', 'Lobby kiosk')
    assert.equal(created.screen.kind, 'kiosk')
    assert.equal(created.screen.status, 'offline')
    assert.equal(created.screen.reported_site_version_number, null)
    credential = created.credential
    screen_id = created.screen.display_screen_id
    lounge_credential = (await mint(venue, 'lounge', 'Lounge TV')).credential
    other_credential = (await mint(other, 'kiosk', 'Other kiosk')).credential
  })

  it('shows only today\'s open slots inside the horizon, per court', async () => {
    const { body } = await pull(venue, credential)
    assert.equal(body.kind, 'kiosk')
    const [court_1, court_2] = body.projection.court
    assert.equal(court_1?.display_name, 'Court 1')
    // Court 1 is booked in the first slot; far is past the horizon; tomorrow is not today.
    assert.deepEqual(court_1?.open_slot.map((one) => one.starts_at), [setup.slot.later_two])
    assert.deepEqual(court_2?.open_slot.map((one) => one.starts_at), [setup.slot.later, setup.slot.later_two])
    assert.equal(court_2?.open_slot[0]?.price_amount, '450.00')
    for (const one of body.projection.court.flatMap((each) => each.open_slot)) {
      assert.notEqual(one.starts_at, setup.slot.far)
      assert.notEqual(one.starts_at, setup.slot.tomorrow)
    }
  })

  it('shows open play and today\'s programs as counts, with a booking QR', async () => {
    const { body } = await pull(venue, credential)
    assert.equal(body.projection.open_play.length, 1)
    assert.equal(body.projection.open_play[0]?.display_name, 'Lunch Open Play')
    assert.equal(body.projection.open_play[0]?.is_now, true)
    assert.equal(body.projection.open_play[0]?.court_count, 2)
    assert.equal(body.projection.open_play[0]?.waiting_count, 1)
    assert.deepEqual(body.projection.program.map((one) => one.title), ['Morning Clinic'])
    assert.equal(body.projection.program[0]?.seat_open_count, 9)
    assert.equal(body.projection.booking?.path, `/v/${venue.organization_code}`)
    assert.equal(body.projection.booking?.url, `${TABLET_ORIGIN}/v/${venue.organization_code}`)
    assert.match(body.projection.booking?.qr_svg ?? '', /^<svg[\s\S]*<\/svg>$/)
  })

  it('never carries a customer, registrant, or player name, email, or phone', async () => {
    const { text } = await pull(venue, credential)
    for (const forbidden of [
      CUSTOMER_NAME, CUSTOMER_EMAIL, CUSTOMER_PHONE, REGISTRANT_NAME, REGISTRANT_EMAIL, 'Quincella', 'Waitingham',
      'party_id', 'booking_code', 'email_address', 'phone_number', 'up_next', 'player',
    ]) {
      assert.equal(text.includes(forbidden), false, `kiosk must not show ${forbidden}`)
    }
  })

  it('carries the default brand at version 0 before anything is published', async () => {
    const { body } = await pull(venue, credential)
    assert.equal(body.site_version_number, 0)
    assert.equal(body.brand.display_name, 'Test Pickleball Club')
    assert.equal(body.venue_name, 'Test Pickleball Club')
    assert.match(body.brand.accent, /^#[0-9a-f]{6}$/)
  })

  it('converges every screen on the published Studio version and flags one still behind', async () => {
    assert.equal(await publish(venue, '#0b5d3b', 'Kiosk Club One'), 1)
    let answer = await pull(venue, credential, { site_version_number: 0 })
    assert.equal(answer.body.site_version_number, 1)
    assert.equal(answer.body.brand.accent, '#0b5d3b')
    assert.equal(answer.body.brand.heading_font, 'Inter')
    assert.equal(answer.body.venue_name, 'Kiosk Club One')
    // The lounge TV gets it too, without re-enrolment.
    assert.equal((await pull(venue, lounge_credential, { site_version_number: 0 })).body.site_version_number, 1)

    // The kiosk renders v1 and reports it.
    await pull(venue, credential, { site_version_number: 1 })
    let row = (await listScreen(venue)).find((one) => one.display_screen_id === screen_id)
    assert.equal(row?.site_version_number, 1)
    assert.equal(row?.reported_site_version_number, 1)
    assert.equal(row?.is_site_behind, false)

    assert.equal(await publish(venue, '#5b1a8f', 'Kiosk Club Two'), 2)
    // Its next pull still reports the v1 it has on screen, and receives v2.
    answer = await pull(venue, credential, { site_version_number: 1 })
    assert.equal(answer.body.site_version_number, 2)
    assert.equal(answer.body.brand.accent, '#5b1a8f')
    assert.equal(answer.body.venue_name, 'Kiosk Club Two')

    const list = await listScreen(venue)
    row = list.find((one) => one.display_screen_id === screen_id)
    assert.equal(row?.site_version_number, 2)
    assert.equal(row?.reported_site_version_number, 1)
    assert.equal(row?.is_site_behind, true, 'a screen still reporting v1 is behind')
    // The lounge reported v0 and is behind too.
    assert.equal(list.find((one) => one.kind === 'lounge')?.is_site_behind, true)

    await pull(venue, credential, { site_version_number: 2 })
    row = (await listScreen(venue)).find((one) => one.display_screen_id === screen_id)
    assert.equal(row?.reported_site_version_number, 2)
    assert.equal(row?.is_site_behind, false)
  })

  it('ignores a malformed reported version', async () => {
    for (const bad of [-1, 1.5, '2', 2 ** 40]) await pull(venue, credential, { site_version_number: bad })
    assert.equal((await listScreen(venue)).find((one) => one.display_screen_id === screen_id)?.reported_site_version_number, 2)
  })

  it('keeps each venue to its own kiosk, slots, brand, and screens', async () => {
    const { body, text } = await pull(other, other_credential)
    assert.equal(body.projection.booking?.path, `/v/${other.organization_code}`)
    assert.equal(body.site_version_number, 0, 'another venue\'s publish does not reach this venue')
    assert.equal(text.includes(venue.organization_code), false)
    assert.equal(text.includes('Kiosk Club'), false)
    const list = await listScreen(other)
    assert.deepEqual(list.map((one) => one.display_name), ['Other kiosk'])
    assert.equal((await post(other, `/api/v1/display/screen/${screen_id}/revoke`, {})).status, 404)
    assert.equal((await pull(venue, credential)).body.projection.booking?.path, `/v/${venue.organization_code}`)
  })

  it('falls back to the default brand when Studio is disabled', async () => {
    await venue.asTenant((tenant) => disableModule(tenant, 'studio', COURT_DECLARATION))
    const { body } = await pull(venue, credential, { site_version_number: 2 })
    assert.equal(body.site_version_number, 0)
    assert.equal(body.brand.display_name, 'Test Pickleball Club')
    const row = (await listScreen(venue)).find((one) => one.display_screen_id === screen_id)
    assert.equal(row?.site_version_number, 0)
    assert.equal(row?.is_site_behind, true)
  })

  it('answers 404 to staff and 401 to the kiosk when the display module is disabled', async () => {
    await venue.asTenant((tenant) => disableModule(tenant, 'display', COURT_DECLARATION))
    assert.equal((await venue.request('/api/v1/display/screen')).status, 404)
    assert.equal((await post(venue, '/api/v1/display/screen', { kind: 'kiosk', display_name: 'Another' })).status, 404)
    const refused = await venue.publicRequest('/public/display/state', { method: 'POST', body: JSON.stringify({ credential }) })
    assert.equal(refused.status, 401)
    // The other venue's kiosk is untouched.
    assert.equal((await pull(other, other_credential)).body.kind, 'kiosk')
  })
})
