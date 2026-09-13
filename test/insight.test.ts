// R16 — insight and accounting export, against a real database.
//
// FIXTURE (venue A, site time zone Asia/Manila; D = today in Manila)
//
//   Courts   Court 1, Court 2
//   Sessions D   08:00–10:00 Court 1, 10:00–12:00 Court 1, 08:00–10:00 Court 2
//            D+1 18:00–19:00 Court 1
//            D−3 08:00–09:00 Court 1, 08:00–09:00 Court 2        (outside the main range)
//   Bookings D   Court 1 08–10 Ana confirmed · Court 2 08–10 Ana confirmed
//                Court 1 10–12 Ben cancelled
//            D+1 Court 1 18–19 Ben confirmed
//            D−3 Court 1 Ben confirmed (no check-in) · Court 2 Cy confirmed (checked in)
//   Money    invoice A1 Ana 1,000.00 tagged court_booking, paid cash 1,000.00, refunded 250.00
//            invoice A2 Ben   600.00 tagged program,       paid GCash 600.00
//            Cy payment  50.25 cash, no invoice, untagged → other
//            Cy payment 1,200.00 GCash, payment tagged membership
//            shop order 2 × 150.00 = 300.00 (POS) · shop order 1 × 99.50 then refunded (cancelled)
//   Stock    balls 10 − 2 = 8 (no alert) · grips 3 − 1 + 1 = 3 (alert at the default threshold 3)
//
// EXPECTED for D..D+1
//   sellable 7.00 h, booked 5.00 h, occupancy 0.7143 (Court 1 3/5 = 0.6000, Court 2 2/2 = 1.0000)
//   cancellation 1 / 4 = 0.2500 · repeat players 1 (Ana) · new players 1 (Ben booked before)
//   revenue court 1,000.00 − 250.00 = 750.00 · program 600.00 · shop 399.50 − 99.50 = 300.00
//           membership 1,200.00 · other 50.25 · net 2,900.25
//
// Venue B: one court, one 1-hour confirmed booking on D, invoice 400.00 tagged court_booking paid cash.

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import {
  addLine,
  createInvoice,
  openInvoice,
  recordPayment,
  refundPayment,
} from '@bygelo/roundrobin-billing'
import { createCatalog, createVariant, placeOrder, refundOrder, setInventory } from '@bygelo/roundrobin-commerce'
import { disableModule, type TenantContext, type Uuid } from '@bygelo/roundrobin-kernel'
import { COURT_DECLARATION } from '../src/app.ts'
import { toCentavo } from '../src/module/insight/csv.ts'
import { addDay, localDateKey } from '../src/module/insight/range.ts'
import { createTestVenue, TEST_DATABASE_URL, type TestVenue } from './helper.ts'

const TIME_ZONE = 'Asia/Manila'
const D = localDateKey(new Date(), TIME_ZONE)
const D1 = addDay(D, 1)
const D3 = addDay(D, -3)
const RUN = `${process.pid}${Date.now()}`

type Summary = {
  range: { from: string; to: string; time_zone: string }
  is_empty: boolean
  occupancy: { sellable_hour: string; booked_hour: string; occupancy_rate: string | null; court: { display_name: string; sellable_hour: string; booked_hour: string; occupancy_rate: string | null }[] }
  revenue: { gross_amount: string; refund_amount: string; net_amount: string; source: { source_code: string; gross_amount: string; refund_amount: string; net_amount: string; share_rate: string | null }[] }
  booking: { booking_count: number; confirmed_count: number; cancelled_count: number; cancellation_rate: string | null; no_show: { is_available: boolean; eligible_count: number; no_show_count: number; no_show_rate: string | null } }
  player: { player_count: number; repeat_player_count: number; new_player_count: number }
  open_play: { is_available: boolean; fill_rate: string | null }
  inventory_alert: { product_name: string; variant_name: string; quantity_on_hand: number; threshold_count: number }[]
  health: { notification_failed_count: number; connector_dead_letter_count: number }
}

/** RFC 4180 reader for the assertions — quoted fields, doubled quotes, CRLF. */
function parseCsv(text: string): string[][] {
  const row: string[][] = []
  let field = ''
  let line: string[] = []
  let is_quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (is_quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index += 1 }
      else if (char === '"') is_quoted = false
      else field += char
    } else if (char === '"') is_quoted = true
    else if (char === ',') { line.push(field); field = '' }
    else if (char === '\r' && text[index + 1] === '\n') { line.push(field); row.push(line); line = []; field = ''; index += 1 }
    else field += char
  }
  if (field !== '' || line.length > 0) { line.push(field); row.push(line) }
  return row
}

function asRecord(csv: string): Record<string, string>[] {
  const [header, ...body] = parseCsv(csv)
  return body.map((one) => Object.fromEntries(header!.map((name, index) => [name, one[index] ?? ''])))
}

async function insertParty(tenant: TenantContext, name: string): Promise<Uuid> {
  const [row] = await tenant.query<{ party_id: Uuid }[]>`
    INSERT INTO party (organization_id, display_name) VALUES (${tenant.organization_id}::uuid, ${name}) RETURNING party_id`
  return row!.party_id
}

async function insertCourt(tenant: TenantContext, site_id: Uuid, code: string, name: string, sort_order: number): Promise<Uuid> {
  const [row] = await tenant.query<{ resource_id: Uuid }[]>`
    INSERT INTO resource (organization_id, site_id, resource_code, display_name, sort_order)
    VALUES (${tenant.organization_id}::uuid, ${site_id}::uuid, ${code}, ${name}, ${sort_order}) RETURNING resource_id`
  return row!.resource_id
}

async function insertSession(tenant: TenantContext, site_id: Uuid, resource_id: Uuid, date: string, start: string, end: string): Promise<Uuid> {
  const [row] = await tenant.query<{ session_id: Uuid }[]>`
    INSERT INTO session (organization_id, site_id, session_code, starts_at, ends_at, capacity_count, price_amount, is_published)
    VALUES (${tenant.organization_id}::uuid, ${site_id}::uuid, ${`s-${RUN}-${resource_id.slice(0, 8)}-${date}-${start}`},
            (${date}::date + ${start}::time) AT TIME ZONE ${TIME_ZONE}::text,
            (${date}::date + ${end}::time) AT TIME ZONE ${TIME_ZONE}::text, 4, 500.00, true)
    RETURNING session_id`
  await tenant.query`
    INSERT INTO session_resource (organization_id, session_id, resource_id)
    VALUES (${tenant.organization_id}::uuid, ${row!.session_id}::uuid, ${resource_id}::uuid)`
  return row!.session_id
}

async function insertBooking(tenant: TenantContext, session_id: Uuid, resource_id: Uuid, party_id: Uuid, status: 'confirmed' | 'cancelled'): Promise<Uuid> {
  const [row] = await tenant.query<{ booking_id: Uuid }[]>`
    INSERT INTO booking (organization_id, session_id, resource_id, party_id, booking_code, status, price_amount, starts_at, ends_at, cancelled_at)
    SELECT ${tenant.organization_id}::uuid, s.session_id, ${resource_id}::uuid, ${party_id}::uuid,
           ${`bk-${RUN}-${Math.random().toString(36).slice(2, 10)}`}, ${status}::booking_status, s.price_amount,
           s.starts_at, s.ends_at, ${status === 'cancelled' ? new Date() : null}
    FROM session s WHERE s.session_id = ${session_id}::uuid
    RETURNING booking_id`
  return row!.booking_id
}

async function invoiceFor(tenant: TenantContext, party_id: Uuid, description: string, amount: number): Promise<string> {
  const invoice = await createInvoice(tenant, { party_id })
  await addLine(tenant, { invoice_id: invoice.invoice_id, description, unit_amount: amount })
  await openInvoice(tenant, invoice.invoice_id)
  return invoice.invoice_code
}

async function buildVenueA(venue: TestVenue) {
  return venue.asTenant(async (tenant) => {
    const [site] = await tenant.query<{ site_id: Uuid }[]>`
      INSERT INTO site (organization_id, site_code, display_name, time_zone)
      VALUES (${tenant.organization_id}::uuid, 'main', 'Main Venue', ${TIME_ZONE}) RETURNING site_id`
    const site_id = site!.site_id
    const court_1 = await insertCourt(tenant, site_id, 'court-1', 'Court 1', 1)
    const court_2 = await insertCourt(tenant, site_id, 'court-2', 'Court 2', 2)
    const ana = await insertParty(tenant, 'Ana Cruz')
    const ben = await insertParty(tenant, 'Ben Reyes')
    const cy = await insertParty(tenant, 'Cy Santos')

    const s1 = await insertSession(tenant, site_id, court_1, D, '08:00', '10:00')
    const s2 = await insertSession(tenant, site_id, court_1, D, '10:00', '12:00')
    const s3 = await insertSession(tenant, site_id, court_2, D, '08:00', '10:00')
    const s4 = await insertSession(tenant, site_id, court_1, D1, '18:00', '19:00')
    const s5 = await insertSession(tenant, site_id, court_1, D3, '08:00', '09:00')
    const s6 = await insertSession(tenant, site_id, court_2, D3, '08:00', '09:00')

    await insertBooking(tenant, s1, court_1, ana, 'confirmed')
    await insertBooking(tenant, s3, court_2, ana, 'confirmed')
    await insertBooking(tenant, s2, court_1, ben, 'cancelled')
    await insertBooking(tenant, s4, court_1, ben, 'confirmed')
    await insertBooking(tenant, s5, court_1, ben, 'confirmed')
    const arrived = await insertBooking(tenant, s6, court_2, cy, 'confirmed')
    await tenant.query`
      INSERT INTO arrival_check_in (organization_id, subject_kind, subject_id, party_id, method_code)
      VALUES (${tenant.organization_id}::uuid, 'booking', ${arrived}::uuid, ${cy}::uuid, 'self')`

    const invoice_court = await invoiceFor(tenant, ana, 'Court 1 and Court 2, 08:00–10:00', 1000)
    const court_payment = await recordPayment(tenant, { party_id: ana, amount: 1000, collection_mode: 'manual_record', idempotency_key: `a-court-${RUN}`, method_code: 'cash', post_now: true })
    await refundPayment(tenant, { payment_id: court_payment.payment_id, amount: 250, reason_code: 'cancellation', idempotency_key: `a-refund-${RUN}` })

    const invoice_program = await invoiceFor(tenant, ben, 'Beginner clinic', 600)
    await recordPayment(tenant, { party_id: ben, amount: 600, collection_mode: 'manual_record', idempotency_key: `a-program-${RUN}`, method_code: 'gcash', post_now: true })

    await recordPayment(tenant, { party_id: cy, amount: 50.25, collection_mode: 'manual_record', idempotency_key: `a-other-${RUN}`, method_code: 'cash', post_now: true })
    const membership = await recordPayment(tenant, { party_id: cy, amount: 1200, collection_mode: 'manual_record', idempotency_key: `a-member-${RUN}`, method_code: 'gcash', post_now: true })

    const ball = await createCatalog(tenant, { name: 'Pickleballs', is_track_inventory: true })
    const ball_variant = await createVariant(tenant, { catalog_id: ball.catalog_id, name: 'Dura Fast 40 (3-pack)', price_amount: 150 })
    await setInventory(tenant, { variant_id: ball_variant.variant_id, quantity_on_hand: 10 })
    const grip = await createCatalog(tenant, { name: 'Overgrip', is_track_inventory: true })
    const grip_variant = await createVariant(tenant, { catalog_id: grip.catalog_id, name: 'Black', price_amount: 99.5 })
    await setInventory(tenant, { variant_id: grip_variant.variant_id, quantity_on_hand: 3 })

    await placeOrder(tenant, { idempotency_key: `a-order-1-${RUN}`, line: [{ variant_id: ball_variant.variant_id, quantity: 2 }], channel: 'pos' })
    const refunded = await placeOrder(tenant, { idempotency_key: `a-order-2-${RUN}`, line: [{ variant_id: grip_variant.variant_id, quantity: 1 }], channel: 'pos' })
    await refundOrder(tenant, { sales_order_id: refunded.order.sales_order_id })

    return { invoice_court, invoice_program, membership_payment_code: membership.payment_code, court_payment_code: court_payment.payment_code }
  })
}

async function buildVenueB(venue: TestVenue) {
  return venue.asTenant(async (tenant) => {
    const [site] = await tenant.query<{ site_id: Uuid }[]>`
      INSERT INTO site (organization_id, site_code, display_name, time_zone)
      VALUES (${tenant.organization_id}::uuid, 'main', 'Other Venue', ${TIME_ZONE}) RETURNING site_id`
    const court = await insertCourt(tenant, site!.site_id, 'court-1', 'Court 1', 1)
    const party = await insertParty(tenant, 'Dee Lim')
    const session = await insertSession(tenant, site!.site_id, court, D, '08:00', '09:00')
    await insertBooking(tenant, session, court, party, 'confirmed')
    const invoice_code = await invoiceFor(tenant, party, 'Court 1, 08:00–09:00', 400)
    const payment = await recordPayment(tenant, { party_id: party, amount: 400, collection_mode: 'manual_record', idempotency_key: `b-court-${RUN}`, method_code: 'cash', post_now: true })
    return { invoice_code, payment_code: payment.payment_code }
  })
}

describe('R16 insight and accounting export', { skip: !TEST_DATABASE_URL }, () => {
  let a: TestVenue
  let b: TestVenue
  let fixture_a: Awaited<ReturnType<typeof buildVenueA>>
  let fixture_b: Awaited<ReturnType<typeof buildVenueB>>
  const range = `from=${D}&to=${D1}`

  const tag = (venue: TestVenue, body: Record<string, string>) =>
    venue.request('/api/v1/insight/revenue-tag', { method: 'POST', body: JSON.stringify(body) })

  before(async () => {
    a = await createTestVenue('insight-a')
    b = await createTestVenue('insight-b')
    fixture_a = await buildVenueA(a)
    fixture_b = await buildVenueB(b)
    for (const [venue, body] of [
      [a, { invoice_code: fixture_a.invoice_court, source_code: 'court_booking' }],
      [a, { invoice_code: fixture_a.invoice_program, source_code: 'program' }],
      [a, { payment_code: fixture_a.membership_payment_code, source_code: 'membership' }],
      [b, { invoice_code: fixture_b.invoice_code, source_code: 'court_booking' }],
    ] as const) {
      const response = await tag(venue, body)
      assert.equal(response.status, 200, await response.text())
    }
  })

  after(async () => {
    await a?.close()
    await b?.close()
  })

  async function summary(venue: TestVenue, query: string): Promise<Summary> {
    const response = await venue.request(`/api/v1/insight/summary?${query}`)
    assert.equal(response.status, 200, await response.clone().text())
    return (await response.json()) as Summary
  }

  it('reports occupancy from sessions and confirmed bookings, overall and per court', async () => {
    const body = await summary(a, range)
    assert.equal(body.range.time_zone, TIME_ZONE)
    assert.equal(body.is_empty, false)
    assert.equal(body.occupancy.sellable_hour, '7.00')
    assert.equal(body.occupancy.booked_hour, '5.00')
    assert.equal(body.occupancy.occupancy_rate, '0.7143')
    assert.deepEqual(
      body.occupancy.court.map((one) => [one.display_name, one.sellable_hour, one.booked_hour, one.occupancy_rate]),
      [['Court 1', '5.00', '3.00', '0.6000'], ['Court 2', '2.00', '2.00', '1.0000']],
    )
  })

  it('reports revenue by source net of a partial refund and a cancelled shop order, as exact strings', async () => {
    const body = await summary(a, range)
    const by = Object.fromEntries(body.revenue.source.map((one) => [one.source_code, [one.gross_amount, one.refund_amount, one.net_amount]]))
    assert.deepEqual(by, {
      court_booking: ['1000.00', '250.00', '750.00'],
      program: ['600.00', '0.00', '600.00'],
      shop: ['399.50', '99.50', '300.00'],
      membership: ['1200.00', '0.00', '1200.00'],
      other: ['50.25', '0.00', '50.25'],
    })
    assert.equal(body.revenue.gross_amount, '3249.75')
    assert.equal(body.revenue.refund_amount, '349.50')
    assert.equal(body.revenue.net_amount, '2900.25')
    assert.equal(body.revenue.source.find((one) => one.source_code === 'court_booking')?.share_rate, '0.2586')
  })

  it('reports cancellation rate, repeat and new players, low stock, and health', async () => {
    const body = await summary(a, range)
    assert.equal(body.booking.confirmed_count, 3)
    assert.equal(body.booking.cancelled_count, 1)
    assert.equal(body.booking.cancellation_rate, '0.2500')
    assert.deepEqual(body.player, { player_count: 2, repeat_player_count: 1, new_player_count: 1 })
    assert.deepEqual(
      body.inventory_alert.map((one) => [one.product_name, one.variant_name, one.quantity_on_hand, one.threshold_count]),
      [['Overgrip', 'Black', 3, 3]],
    )
    assert.deepEqual(body.health, { notification_failed_count: 0, connector_dead_letter_count: 0 })
    assert.equal(body.open_play.is_available, true)
  })

  it('reports no-shows from arrival check-in once the venue uses it', async () => {
    const body = await summary(a, `from=${D3}&to=${D3}`)
    assert.equal(body.booking.no_show.is_available, true)
    assert.equal(body.booking.no_show.eligible_count, 2)
    assert.equal(body.booking.no_show.no_show_count, 1)
    assert.equal(body.booking.no_show.no_show_rate, '0.5000')
    assert.equal(body.revenue.net_amount, '0.00')
  })

  it('serves a per-day series that adds up to the summary', async () => {
    const response = await a.request(`/api/v1/insight/daily?${range}`)
    assert.equal(response.status, 200)
    const body = (await response.json()) as { day: { entry_date: string; booking_count: number; court_hour: string; revenue_amount: string }[] }
    assert.deepEqual(
      body.day.map((one) => [one.entry_date, one.booking_count, one.court_hour, one.revenue_amount]),
      [[D, 2, '4.00', '2900.25'], [D1, 1, '1.00', '0.00']],
    )
  })

  it('exports bookings, revenue, and occupancy as RFC 4180 CSV attachments whose rows match the records', async () => {
    const booking = await a.request(`/api/v1/insight/export.csv?${range}&kind=booking`)
    assert.equal(booking.status, 200)
    assert.match(booking.headers.get('content-type') ?? '', /^text\/csv/)
    assert.match(booking.headers.get('content-disposition') ?? '', new RegExp(`attachment; filename="insight-booking-${D}-to-${D1}\\.csv"`))
    const booking_text = await booking.text()
    assert.ok(booking_text.endsWith('\r\n'))
    const booking_row = asRecord(booking_text)
    assert.equal(booking_row.length, 4)
    assert.deepEqual(booking_row.map((one) => one['status']).sort(), ['cancelled', 'confirmed', 'confirmed', 'confirmed'])
    assert.ok(booking_row.every((one) => one['court'] === 'Court 1' || one['court'] === 'Court 2'))

    const revenue_row = asRecord(await (await a.request(`/api/v1/insight/export.csv?${range}&kind=revenue`)).text())
    assert.equal(revenue_row.length, 8)
    assert.equal(revenue_row.reduce((total, one) => total + toCentavo(one['amount']!), 0n), toCentavo('2900.25'))
    assert.ok(revenue_row.some((one) => one['kind'] === 'refund' && one['amount'] === '-250.00' && one['source'] === 'Court booking'))

    const occupancy_row = asRecord(await (await a.request(`/api/v1/insight/export.csv?${range}&kind=occupancy`)).text())
    assert.deepEqual(
      occupancy_row.map((one) => [one['date'], one['court'], one['sellable_hour'], one['booked_hour'], one['occupancy_percent']]),
      [
        [D, 'All courts', '6.00', '4.00', '66.67'],
        [D, 'Court 1', '4.00', '2.00', '50.00'],
        [D, 'Court 2', '2.00', '2.00', '100.00'],
        [D1, 'All courts', '1.00', '1.00', '100.00'],
        [D1, 'Court 1', '1.00', '1.00', '100.00'],
        [D1, 'Court 2', '0.00', '0.00', ''],
      ],
    )
  })

  it('exports a journal where every entry balances and revenue credits less refunds equal net revenue', async () => {
    const response = await a.request(`/api/v1/insight/journal.csv?${range}`)
    assert.equal(response.status, 200)
    const text = await response.text()
    assert.equal(text.split('\r\n')[0], 'entry_date,entry_number,account_code,account_name,debit_amount,credit_amount,reference,memo')
    const line = asRecord(text)

    const entry = new Map<string, { debit: bigint; credit: bigint }>()
    for (const one of line) {
      const total = entry.get(one['entry_number']!) ?? { debit: 0n, credit: 0n }
      total.debit += toCentavo(one['debit_amount']!)
      total.credit += toCentavo(one['credit_amount']!)
      entry.set(one['entry_number']!, total)
      assert.ok(one['debit_amount'] === '0.00' || one['credit_amount'] === '0.00', 'a line is a debit or a credit, not both')
    }
    assert.equal(entry.size, 8)
    for (const [entry_number, total] of entry) assert.equal(total.debit, total.credit, `entry ${entry_number} balances`)

    const revenue_credit = line.filter((one) => /^4[0-8]/.test(one['account_code']!)).reduce((sum, one) => sum + toCentavo(one['credit_amount']!), 0n)
    const refund_debit = line.filter((one) => one['account_code'] === '4900').reduce((sum, one) => sum + toCentavo(one['debit_amount']!), 0n)
    assert.equal(revenue_credit - refund_debit, toCentavo('2900.25'))

    const court_payment = line.filter((one) => one['entry_number'] === fixture_a.court_payment_code)
    assert.deepEqual(
      court_payment.map((one) => [one['account_code'], one['account_name'], one['debit_amount'], one['credit_amount']]),
      [['1000', 'Cash on Hand', '1000.00', '0.00'], ['4000', 'Court Rental Revenue', '0.00', '1000.00']],
    )
    assert.ok(line.some((one) => one['account_code'] === '1010' && one['debit_amount'] === '1200.00'), 'GCash lands in e-wallet clearing')
    assert.ok(line.some((one) => one['account_code'] === '4300' && one['credit_amount'] === '1200.00'))
  })

  it("keeps venue B's figures to venue B's own records", async () => {
    const body = await summary(b, range)
    assert.equal(body.occupancy.sellable_hour, '1.00')
    assert.equal(body.occupancy.occupancy_rate, '1.0000')
    assert.equal(body.revenue.net_amount, '400.00')
    assert.equal(body.revenue.source.find((one) => one.source_code === 'court_booking')?.net_amount, '400.00')
    assert.equal(body.booking.booking_count, 1)
    assert.deepEqual(body.inventory_alert, [])

    const journal = await (await b.request(`/api/v1/insight/journal.csv?${range}`)).text()
    assert.ok(!journal.includes(fixture_a.court_payment_code))
    assert.ok(!journal.includes('Ana Cruz'))
    assert.ok(journal.includes(fixture_b.payment_code))

    assert.equal((await summary(a, range)).revenue.net_amount, '2900.25', 'A is unchanged by B')

    // A's invoice code is invisible from B: tagging it is a 404, not a cross-tenant write.
    assert.equal((await tag(b, { invoice_code: fixture_a.invoice_court, source_code: 'other' })).status, 404)
  })

  it('re-tagging replaces a classification instead of duplicating it', async () => {
    assert.equal((await tag(a, { payment_code: fixture_a.membership_payment_code, source_code: 'membership' })).status, 200)
    const count = await a.asTenant(async (tenant) => {
      // Filtered explicitly: the test role may be the database owner, which RLS does not bind.
      const [row] = await tenant.query<{ tag_count: number }[]>`
        SELECT count(*)::int AS tag_count FROM insight_revenue_tag WHERE organization_id = ${tenant.organization_id}::uuid`
      return row!.tag_count
    })
    assert.equal(count, 3)
    assert.equal((await tag(a, { payment_code: fixture_a.membership_payment_code, source_code: 'membership_fee' })).status, 400)
    assert.equal((await tag(a, { source_code: 'shop' })).status, 400)
  })

  it('refuses a bad range with 400', async () => {
    for (const query of [`from=${D1}&to=${D}`, 'from=2026-01-01&to=2027-01-02', 'from=2027-02-30&to=2027-03-01', 'from=yesterday']) {
      const response = await a.request(`/api/v1/insight/summary?${query}`)
      assert.equal(response.status, 400, query)
    }
    assert.equal((await a.request(`/api/v1/insight/export.csv?${range}&kind=everything`)).status, 400)
    assert.equal((await a.request(`/api/v1/insight/journal.csv?from=${D1}&to=${D}`)).status, 400)
  })

  it('answers 404 once the insight module is disabled', async () => {
    await b.asTenant((tenant) => disableModule(tenant, 'insight', COURT_DECLARATION))
    assert.equal((await b.request(`/api/v1/insight/summary?${range}`)).status, 404)
    assert.equal((await b.request(`/api/v1/insight/journal.csv?${range}`)).status, 404)
  })
})
