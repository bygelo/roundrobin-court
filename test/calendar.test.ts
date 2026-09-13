// R23 — read-only iCalendar feed: stable UID, cancellation, no PII, revoke,
// rotate, tenant isolation, disabled module.

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { disableModule, type Uuid } from '@bygelo/roundrobin-kernel'
import { COURT_DECLARATION } from '../src/app.ts'
import { escapeText, foldLine, renderCalendar } from '../src/module/calendar/ics.ts'
import { TEST_DATABASE_URL, createTestVenue, type TestVenue } from './helper.ts'

describe('ics rendering', () => {
  it('escapes TEXT and folds at 75 octets without splitting a character', () => {
    assert.equal(escapeText('a,b;c\\d\ne'), 'a\\,b\\;c\\\\d\\ne')
    const long = `SUMMARY:${'Ñ'.repeat(80)}`
    const folded = foldLine(long)
    for (const line of folded.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75)
    assert.equal(folded.replaceAll('\r\n ', ''), long)
  })

  it('renders a well-formed calendar', () => {
    const text = renderCalendar({
      calendar_name: 'Club',
      event: [
        {
          uid: 'x@club.court',
          sequence: 0,
          starts_at: new Date('2027-04-01T10:00:00Z'),
          ends_at: new Date('2027-04-01T11:00:00Z'),
          last_modified: new Date('2027-03-01T00:00:00Z'),
          summary: 'Court booked',
          status: 'CONFIRMED',
          is_busy: true,
        },
      ],
    })
    assert.ok(text.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:'))
    assert.ok(text.endsWith('END:VCALENDAR\r\n'))
    assert.ok(text.includes('DTSTART:20270401T100000Z\r\n'))
    assert.ok(!/[^\r]\n/.test(text), 'CRLF only')
  })
})

describe('calendar feed', { skip: !TEST_DATABASE_URL }, () => {
  let venue: TestVenue
  let booking_id: Uuid
  let cancelled_booking_id: Uuid
  let feed_path = ''
  let feed_id = ''
  const json = async <T>(response: Response) => (await response.json()) as T

  before(async () => {
    venue = await createTestVenue('calendar')
    await venue.asTenant(async (tenant) => {
      const org = venue.organization_id
      const [site] = await tenant.query<{ site_id: Uuid }[]>`
        INSERT INTO site (organization_id, site_code, display_name) VALUES (${org}, 'main', 'Main Venue') RETURNING site_id`
      const [resource] = await tenant.query<{ resource_id: Uuid }[]>`
        INSERT INTO resource (organization_id, site_id, resource_code, display_name, sort_order)
        VALUES (${org}, ${site!.site_id}, 'court-1', 'Court 1', 1) RETURNING resource_id`
      const starts = new Date(Date.now() + 3 * 86_400_000)
      starts.setUTCHours(10, 0, 0, 0)
      const ends = new Date(starts.getTime() + 2 * 3_600_000)
      const [session] = await tenant.query<{ session_id: Uuid }[]>`
        INSERT INTO session (organization_id, site_id, session_code, starts_at, ends_at, capacity_count, price_amount, is_published)
        VALUES (${org}, ${site!.site_id}, 'evening', ${starts}, ${ends}, 4, 500.00, true) RETURNING session_id`
      await tenant.query`
        INSERT INTO session_resource (organization_id, session_id, resource_id)
        VALUES (${org}, ${session!.session_id}, ${resource!.resource_id})`
      const [party] = await tenant.query<{ party_id: Uuid }[]>`
        INSERT INTO party (organization_id, display_name, email_address, phone_number)
        VALUES (${org}, 'Zelda Secretname', 'zelda@example.com', '+639171234567') RETURNING party_id`
      const past = new Date(Date.now() - 3_600_000)
      const [one] = await tenant.query<{ booking_id: Uuid }[]>`
        INSERT INTO booking (organization_id, session_id, resource_id, party_id, booking_code, status, price_amount,
                             starts_at, ends_at, detail, created_at, updated_at)
        VALUES (${org}, ${session!.session_id}, ${resource!.resource_id}, ${party!.party_id}, ${`CAL-${Date.now()}-A`},
                'confirmed', 250.00, ${starts}, ${new Date(starts.getTime() + 3_600_000)},
                ${JSON.stringify({ note: 'Zelda Secretname birthday' })}::jsonb, ${past}, ${past})
        RETURNING booking_id`
      const [two] = await tenant.query<{ booking_id: Uuid }[]>`
        INSERT INTO booking (organization_id, session_id, resource_id, party_id, booking_code, status, price_amount,
                             starts_at, ends_at, created_at, updated_at)
        VALUES (${org}, ${session!.session_id}, ${resource!.resource_id}, ${party!.party_id}, ${`CAL-${Date.now()}-B`},
                'confirmed', 250.00, ${new Date(starts.getTime() + 3_600_000)}, ${ends}, ${past}, ${past})
        RETURNING booking_id`
      booking_id = one!.booking_id
      cancelled_booking_id = two!.booking_id
    })
  })
  after(() => venue.close())

  it('creates a feed and returns the full URL once', async () => {
    const response = await venue.request('/api/v1/calendar/feed', { method: 'POST', body: JSON.stringify({ scope_code: 'venue' }) })
    assert.equal(response.status, 201)
    const body = await json<{ feed: { calendar_feed_id: string; token_prefix: string }; feed_token: string; feed_path: string; feed_url: string }>(response)
    assert.match(body.feed_token, /^[A-Za-z0-9_-]{22}$/)
    assert.ok(body.feed_url.endsWith(body.feed_path))
    assert.equal(body.feed_path, `/public/${venue.organization_code}/calendar/${body.feed_token}.ics`)
    feed_path = body.feed_path
    feed_id = body.feed.calendar_feed_id

    const list = await venue.request('/api/v1/calendar/feed')
    const text = await list.text()
    assert.ok(!text.includes(body.feed_token), 'the list never shows the token')
  })

  it('renders an RFC 5545 feed with stable UIDs and no customer data', async () => {
    const first = await venue.publicRequest(feed_path)
    assert.equal(first.status, 200)
    assert.match(first.headers.get('content-type') ?? '', /^text\/calendar/)
    const text = await first.text()
    const unfolded = text.replaceAll('\r\n ', '')
    assert.ok(text.includes('PRODID:'), text)
    assert.ok(text.includes('X-WR-CALNAME:'), text)
    assert.ok(unfolded.includes(`UID:${booking_id}@${venue.organization_code}.court\r\n`), text)
    assert.match(text, /DTSTART:\d{8}T\d{6}Z\r\n/)
    assert.ok(unfolded.includes('SUMMARY:Court booked · Court 1'), text)
    for (const secret of ['Zelda', 'Secretname', 'zelda@example.com', 'example.com', '+639171234567', '9171234567', 'birthday', '250']) {
      assert.ok(!text.includes(secret), `feed must not contain "${secret}"`)
    }
    for (const line of text.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75)

    const second = await (await venue.publicRequest(feed_path)).text()
    assert.equal(second, text, 'a feed with no changes renders byte-identically')
  })

  it('marks a cancelled booking CANCELLED and bumps its SEQUENCE', async () => {
    const before_text = await (await venue.publicRequest(feed_path)).text()
    const block = (text: string) => text.split('BEGIN:VEVENT').find((one) => one.includes(cancelled_booking_id))!
    assert.match(block(before_text), /SEQUENCE:0\r\n/)
    await venue.asTenant((tenant) => tenant.query`
      UPDATE booking SET status = 'cancelled', cancelled_at = now() WHERE booking_id = ${cancelled_booking_id}`)
    const after_text = await (await venue.publicRequest(feed_path)).text()
    assert.match(block(after_text), /STATUS:CANCELLED\r\n/)
    assert.ok(Number(/SEQUENCE:(\d+)/.exec(block(after_text))![1]) > 0)
    assert.match(after_text.split('BEGIN:VEVENT').find((one) => one.includes(booking_id))!, /STATUS:CONFIRMED/)
  })

  it('answers 404 for an unknown token, a missing .ics, and another venue', async () => {
    assert.equal((await venue.publicRequest(`/public/${venue.organization_code}/calendar/AAAAAAAAAAAAAAAAAAAAAA.ics`)).status, 404)
    assert.equal((await venue.publicRequest(feed_path.replace(/\.ics$/, ''))).status, 404)
    const other = await createTestVenue('calendar-other')
    try {
      assert.equal((await other.publicRequest(feed_path.replace(venue.organization_code, other.organization_code))).status, 404)
      assert.equal((await other.publicRequest(feed_path)).status, 200, 'sanity: the real venue still serves it')
    } finally {
      await other.close()
    }
  })

  it('rotating breaks the old URL; revoking breaks the feed', async () => {
    const rotated = await json<{ feed_path: string }>(
      await venue.request(`/api/v1/calendar/feed/${feed_id}/rotate`, { method: 'POST' }),
    )
    assert.equal((await venue.publicRequest(feed_path)).status, 404)
    assert.equal((await venue.publicRequest(rotated.feed_path)).status, 200)

    const revoked = await venue.request(`/api/v1/calendar/feed/${feed_id}/revoke`, { method: 'POST' })
    assert.equal((await json<{ feed: { is_active: boolean } }>(revoked)).feed.is_active, false)
    assert.equal((await venue.publicRequest(rotated.feed_path)).status, 404)
    assert.equal((await venue.request(`/api/v1/calendar/feed/${feed_id}/rotate`, { method: 'POST' })).status, 409)
  })

  it('is a projection only: there is no write path from a calendar client', async () => {
    const created = await json<{ feed_path: string }>(
      await venue.request('/api/v1/calendar/feed', { method: 'POST', body: JSON.stringify({ scope_code: 'venue' }) }),
    )
    for (const method of ['PUT', 'POST', 'DELETE']) {
      const response = await venue.publicRequest(created.feed_path, { method, body: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n' })
      assert.ok(response.status === 404 || response.status === 405, `${method} must not be accepted`)
    }
    const [row] = await venue.asTenant((tenant) =>
      tenant.query<{ status: string }[]>`SELECT status::text AS status FROM booking WHERE booking_id = ${booking_id}`,
    )
    assert.equal(row!.status, 'confirmed')
  })

  it('404s the feed and the API when the calendar module is disabled', async () => {
    const created = await json<{ feed_path: string }>(
      await venue.request('/api/v1/calendar/feed', { method: 'POST', body: JSON.stringify({ scope_code: 'venue' }) }),
    )
    await venue.asTenant((tenant) => disableModule(tenant, 'calendar', COURT_DECLARATION))
    assert.equal((await venue.publicRequest(created.feed_path)).status, 404)
    assert.equal((await venue.request('/api/v1/calendar/feed')).status, 404)
  })
})
