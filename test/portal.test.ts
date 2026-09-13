// Portal (R05 book a court, R07 payment port) against a real database.
//
// Covers the falsifiable conditions: concurrent checkout of one slot, lazy hold
// expiry releasing once, online payment idempotency, cancel before and after
// the cutoff, refund bounded by what was paid, recovery credential, unknown
// venue, disabled module, and tenant isolation.

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { disableModule, type Uuid } from '@bygelo/roundrobin-kernel'
import { sweepExpiredHold } from '@bygelo/roundrobin-booking'
import { COURT_DECLARATION } from '../src/app.ts'
import { resetOnlinePayment, setOnlinePayment, createSandboxPayment } from '../src/module/portal/payment.ts'
import { localDate } from '../src/module/portal/rule.ts'
import { TEST_DATABASE_URL, createTestVenue, type TestVenue } from './helper.ts'

type Created = { booking_code: string; recovery_token: string; status: string; total_amount: string; cancellation_cutoff_at: string; hold_expires_at: string }
type View = { booking_code: string; status: string; payment_state: string; paid_amount: string; balance_amount: string; refunded_amount: string; payment_method: string[]; is_cancellable: boolean; contact: { display_name: string; email: string } }

const HOUR = 3_600_000

describe('portal: book a court and pay for it', { skip: !TEST_DATABASE_URL }, () => {
  let venue: TestVenue
  let site_id: Uuid
  let resource_id: Uuid
  let sequence = 0

  const contact = (name: string) => ({ display_name: name, email: `${name.toLowerCase().replace(/\s+/g, '.')}.${process.pid}@example.com`, phone: '0917 123 4567' })

  async function createSlot(starts_at: Date, price = '500.00'): Promise<Uuid> {
    sequence += 1
    return venue.asTenant(async (tenant) => {
      const [session] = await tenant.query<{ session_id: Uuid }[]>`
        INSERT INTO session (organization_id, site_id, session_code, starts_at, ends_at, capacity_count, price_amount, is_published)
        VALUES (${venue.organization_id}, ${site_id}, ${`slot-${sequence}`}, ${starts_at}, ${new Date(starts_at.getTime() + HOUR)}, 4, ${price}, true)
        RETURNING session_id`
      await tenant.query`
        INSERT INTO session_resource (organization_id, session_id, resource_id)
        VALUES (${venue.organization_id}, ${session!.session_id}, ${resource_id})`
      return session!.session_id
    })
  }

  /** A future slot at a whole hour, day_offset days out. */
  function futureAt(hour_offset: number): Date {
    const at = new Date(Date.now() + hour_offset * HOUR)
    at.setUTCMinutes(0, 0, 0)
    return at
  }

  async function book(session_id: Uuid, name: string): Promise<Response> {
    return venue.publicRequest(`/public/${venue.organization_code}/portal/booking`, {
      method: 'POST',
      body: JSON.stringify({ session_id, resource_id, contact: contact(name), participant_count: 4 }),
    })
  }

  async function bookOk(session_id: Uuid, name: string): Promise<Created> {
    const response = await book(session_id, name)
    assert.equal(response.status, 201, await response.clone().text())
    return (await response.json()) as Created
  }

  const pay = (created: Created, method: 'online' | 'counter') =>
    venue.publicRequest(`/public/${venue.organization_code}/portal/booking/${created.booking_code}/pay`, {
      method: 'POST',
      body: JSON.stringify({ recovery_token: created.recovery_token, method }),
    })

  before(async () => {
    delete process.env['PAYMONGO_SECRET_KEY']
    resetOnlinePayment()
    venue = await createTestVenue('portal')
    await venue.asTenant(async (tenant) => {
      const [category] = await tenant.query<{ resource_category_id: Uuid }[]>`
        INSERT INTO resource_category (organization_id, resource_category_code, display_name)
        VALUES (${venue.organization_id}, 'pickleball', 'Pickleball') RETURNING resource_category_id`
      const [site] = await tenant.query<{ site_id: Uuid }[]>`
        INSERT INTO site (organization_id, site_code, display_name, time_zone)
        VALUES (${venue.organization_id}, 'main', 'Main Venue', 'Asia/Manila') RETURNING site_id`
      site_id = site!.site_id
      const [resource] = await tenant.query<{ resource_id: Uuid }[]>`
        INSERT INTO resource (organization_id, site_id, resource_code, display_name, sort_order)
        VALUES (${venue.organization_id}, ${site_id}, 'court-1', 'Court 1', 1) RETURNING resource_id`
      resource_id = resource!.resource_id
      await tenant.query`
        INSERT INTO resource_category_link (organization_id, resource_id, resource_category_id)
        VALUES (${venue.organization_id}, ${resource_id}, ${category!.resource_category_id})`
    })
  })

  after(async () => {
    resetOnlinePayment()
    await venue.close()
  })

  it('answers 404 for an unknown venue', async () => {
    const response = await venue.publicRequest('/public/no-such-venue-anywhere/portal/availability')
    assert.equal(response.status, 404)
  })

  it('shows the day as named courts by slots, with a server-owned price', async () => {
    const starts_at = futureAt(50)
    const session_id = await createSlot(starts_at, '650.00')
    const response = await venue.publicRequest(
      `/public/${venue.organization_code}/portal/availability?date=${localDate(starts_at, 'Asia/Manila')}&sport=pickleball`,
    )
    assert.equal(response.status, 200)
    const body = (await response.json()) as { court: { display_name: string; sport_code: string }[]; slot: { session_id: string; price_amount: string; is_available: boolean }[]; sport: { sport_code: string }[] }
    assert.equal(body.court[0]?.display_name, 'Court 1')
    assert.equal(body.court[0]?.sport_code, 'pickleball')
    const slot = body.slot.find((one) => one.session_id === session_id)
    assert.ok(slot, 'the slot is listed')
    assert.equal(slot.price_amount, '650.00')
    assert.equal(slot.is_available, true)
  })

  it('rejects a client that posts its own price', async () => {
    const session_id = await createSlot(futureAt(51))
    const response = await venue.publicRequest(`/public/${venue.organization_code}/portal/booking`, {
      method: 'POST',
      body: JSON.stringify({ session_id, resource_id, contact: contact('Price Setter'), price_amount: '1.00' }),
    })
    assert.equal(response.status, 400)
  })

  it('refuses a contact that cannot be reached, field by field', async () => {
    const session_id = await createSlot(futureAt(52))
    const response = await venue.publicRequest(`/public/${venue.organization_code}/portal/booking`, {
      method: 'POST',
      body: JSON.stringify({ session_id, resource_id, contact: { display_name: 'A', email: 'nope', phone: '1' } }),
    })
    assert.equal(response.status, 400)
    const body = (await response.json()) as { problem: Record<string, string> }
    assert.ok(body.problem['email'] && body.problem['phone'] && body.problem['display_name'])
  })

  it('gives one slot to exactly one of many concurrent checkouts, with no 500', async () => {
    const session_id = await createSlot(futureAt(53))
    const response = await Promise.all(Array.from({ length: 50 }, (_, index) => book(session_id, `Racer ${index}`)))
    const status = response.map((one) => one.status)
    assert.equal(status.filter((one) => one === 201).length, 1, `status: ${status.join(',')}`)
    assert.equal(status.filter((one) => one === 409).length, 49, `status: ${status.join(',')}`)
    const refusal = (await response.find((one) => one.status === 409)!.json()) as { error: string }
    assert.match(refusal.error, /just booked/)
  })

  it('releases an expired hold back into availability exactly once', async () => {
    const starts_at = futureAt(54)
    const session_id = await createSlot(starts_at)
    const created = await bookOk(session_id, 'Lapsed Holder')
    await venue.asTenant((tenant) => tenant.query`
      UPDATE booking SET hold_expire_at = now() - interval '1 minute'
      WHERE organization_id = ${venue.organization_id} AND booking_code = ${created.booking_code}`)

    const released = await Promise.all([
      venue.asTenant((tenant) => sweepExpiredHold(tenant)),
      venue.asTenant((tenant) => sweepExpiredHold(tenant)),
      venue.asTenant((tenant) => sweepExpiredHold(tenant)),
    ])
    assert.equal(released.reduce((total, one) => total + one, 0), 1, `released: ${released.join(',')}`)

    const response = await venue.publicRequest(
      `/public/${venue.organization_code}/portal/availability?date=${localDate(starts_at, 'Asia/Manila')}`,
    )
    const body = (await response.json()) as { slot: { session_id: string; is_available: boolean }[] }
    assert.equal(body.slot.find((one) => one.session_id === session_id)?.is_available, true)

    const late = await pay(created, 'online')
    assert.equal(late.status, 409, 'an expired hold cannot be paid')
    await bookOk(session_id, 'Next Player')
  })

  it('charges online once no matter how often pay is pressed', async () => {
    let charge_count = 0
    const sandbox = createSandboxPayment()
    setOnlinePayment({ ...sandbox, charge: (input) => { charge_count += 1; return sandbox.charge(input) } })
    try {
      const session_id = await createSlot(futureAt(55))
      const created = await bookOk(session_id, 'Online Payer')
      const [first, second] = await Promise.all([pay(created, 'online'), pay(created, 'online')])
      assert.equal(first.status, 200)
      assert.equal(second.status, 200)
      const third = await pay(created, 'online')
      const body = (await third.json()) as { booking: View; is_replay: boolean }
      assert.equal(body.is_replay, true)
      assert.equal(body.booking.status, 'confirmed')
      assert.equal(body.booking.payment_state, 'paid')
      assert.equal(charge_count, 1)
      const [detail] = await venue.asTenant((tenant) => tenant.query<{ detail_type: string; paid_state: string | null; invoice_id: string | null; party_detail_type: string }[]>`
        SELECT jsonb_typeof(b.detail) AS detail_type, b.detail->>'paid_state' AS paid_state, b.detail->>'invoice_id' AS invoice_id,
               jsonb_typeof(pa.detail) AS party_detail_type
        FROM booking b JOIN party pa ON pa.party_id = b.party_id
        WHERE b.organization_id = ${venue.organization_id} AND b.booking_code = ${created.booking_code}`)
      assert.equal(detail?.detail_type, 'object', 'booking.detail is a jsonb object, not a string')
      assert.equal(detail?.party_detail_type, 'object', 'party.detail is a jsonb object, not a string')
      assert.equal(detail?.paid_state, 'Paid online', 'the court board reads the paid state')
      assert.ok(detail?.invoice_id, 'the court board reads the invoice')
      const [row] = await venue.asTenant((tenant) => tenant.query<{ payment_count: number }[]>`
        SELECT count(*)::int AS payment_count FROM payment
        WHERE organization_id = ${venue.organization_id} AND idempotency_key = ${`portal:${created.booking_code}:online`}`)
      assert.equal(row?.payment_count, 1)
    } finally {
      resetOnlinePayment()
    }
  })

  it('recovers a booking only with its own token', async () => {
    const session_id = await createSlot(futureAt(56))
    const created = await bookOk(session_id, 'Recovering Guest')
    const wrong = await venue.publicRequest(`/public/${venue.organization_code}/portal/booking/${created.booking_code}?token=AAAAAAAAAAAAAAAAAAAAAA`)
    assert.equal(wrong.status, 404)
    const right = await venue.publicRequest(`/public/${venue.organization_code}/portal/booking/${created.booking_code}?token=${created.recovery_token}`)
    assert.equal(right.status, 200)
    const body = (await right.json()) as { booking: View }
    assert.equal(body.booking.status, 'hold')
    assert.equal(body.booking.payment_state, 'unpaid')
    const [stored] = await venue.asTenant((tenant) => tenant.query<{ hit: number }[]>`
      SELECT count(*)::int AS hit FROM portal_booking WHERE recovery_token_hash = ${created.recovery_token}`)
    assert.equal(stored?.hit, 0, 'the raw token is never stored')
  })

  it('lets a guest cancel before the cutoff and frees the court', async () => {
    const starts_at = futureAt(72)
    const session_id = await createSlot(starts_at)
    const created = await bookOk(session_id, 'Early Canceller')
    const counter = await pay(created, 'counter')
    assert.equal(counter.status, 200)
    assert.equal(((await counter.json()) as { booking: View }).booking.status, 'confirmed')

    const response = await venue.publicRequest(`/public/${venue.organization_code}/portal/booking/${created.booking_code}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ recovery_token: created.recovery_token }),
    })
    assert.equal(response.status, 200)
    assert.equal(((await response.json()) as { booking: View }).booking.status, 'cancelled')
    await bookOk(session_id, 'Takes Freed Court')
  })

  it('refuses a guest cancel after the cutoff and names the cutoff', async () => {
    const session_id = await createSlot(futureAt(3))
    const created = await bookOk(session_id, 'Late Canceller')
    assert.equal((await pay(created, 'counter')).status, 200)
    const response = await venue.publicRequest(`/public/${venue.organization_code}/portal/booking/${created.booking_code}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ recovery_token: created.recovery_token }),
    })
    assert.equal(response.status, 409)
    assert.match(((await response.json()) as { error: string }).error, /closed at/)
  })

  it('refunds part of a payment, never more than was paid, and keeps the booking', async () => {
    const session_id = await createSlot(futureAt(57))
    const created = await bookOk(session_id, 'Refund Seeker')
    assert.equal((await pay(created, 'online')).status, 200)
    const refund = (body: object) =>
      venue.request(`/api/v1/portal/booking/${created.booking_code}/refund`, { method: 'POST', body: JSON.stringify(body) })

    assert.equal((await refund({ amount: '600', reason: 'rain-out', reference: 'R-1' })).status, 409)
    const half = await refund({ amount: '250', reason: 'rain-out', reference: 'R-2' })
    assert.equal(half.status, 201)
    const body = (await half.json()) as { booking: View }
    assert.equal(body.booking.payment_state, 'partially_refunded')
    assert.equal(body.booking.status, 'confirmed')
    assert.equal(body.booking.paid_amount, '250.00')
    const over = await refund({ amount: '300', reason: 'rain-out', reference: 'R-3' })
    assert.equal(over.status, 409)
    assert.match(((await over.json()) as { error: string }).error, /at most PHP 250\.00/)
  })

  it('records a counter payment once, confirms, and refuses paying past the total', async () => {
    const starts_at = futureAt(58)
    const session_id = await createSlot(starts_at)
    const created = await bookOk(session_id, 'Counter Payer')
    const payment = (body: object) =>
      venue.request(`/api/v1/portal/booking/${created.booking_code}/payment`, { method: 'POST', body: JSON.stringify(body) })

    assert.equal((await payment({ method: 'gcash', amount: '500' })).status, 400, 'gcash needs a reference')
    const first = await payment({ method: 'gcash', amount: '300', reference: 'GC-778' })
    assert.equal(first.status, 201)
    const replay = await payment({ method: 'gcash', amount: '300', reference: 'GC-778' })
    assert.equal(replay.status, 200, 'the same reference is the same payment')
    assert.equal((await payment({ method: 'cash', amount: '250' })).status, 409, 'only 200 is still due')
    const rest = await payment({ method: 'cash', amount: '200' })
    assert.equal(rest.status, 201)
    const body = (await rest.json()) as { booking: View }
    assert.equal(body.booking.status, 'confirmed')
    assert.equal(body.booking.payment_state, 'paid')
    assert.deepEqual([...body.booking.payment_method].sort(), ['cash', 'gcash'])

    const list = await venue.request(`/api/v1/portal/booking?date=${localDate(starts_at, 'Asia/Manila')}&status=confirmed`)
    assert.equal(list.status, 200)
    const listed = ((await list.json()) as { booking: View[] }).booking.find((one) => one.booking_code === created.booking_code)
    assert.equal(listed?.contact.display_name, 'Counter Payer')
    assert.equal(listed?.payment_state, 'paid')
  })

  it('lets staff cancel a confirmed booking even after the guest cutoff', async () => {
    const session_id = await createSlot(futureAt(4))
    const created = await bookOk(session_id, 'Staff Cancelled')
    assert.equal((await pay(created, 'counter')).status, 200)
    const response = await venue.request(`/api/v1/portal/booking/${created.booking_code}/cancel`, { method: 'POST' })
    assert.equal(response.status, 200)
    assert.equal(((await response.json()) as { booking: View }).booking.status, 'cancelled')
    assert.equal((await venue.request(`/api/v1/portal/booking/${created.booking_code}/cancel`, { method: 'POST' })).status, 409)
  })

  it('still books and confirms when a message or webhook side effect fails in SQL', async () => {
    // Regression: a failed statement inside emitWebhook/notifyPlayer used to
    // abort the booking transaction and answer 500. Force both to fail.
    const session_id = await createSlot(futureAt(61))
    const created = await bookOk(session_id, 'Side Effect Survivor')
    await venue.asTenant((tenant) => tenant.query`ALTER TABLE webhook_event RENAME TO webhook_event_hidden`)
    await venue.asTenant((tenant) => tenant.query`ALTER TABLE message_template RENAME TO message_template_hidden`)
    try {
      const response = await pay(created, 'online')
      assert.equal(response.status, 200, await response.clone().text())
      const body = (await response.json()) as { booking: View }
      assert.equal(body.booking.status, 'confirmed')
      assert.equal(body.booking.payment_state, 'paid')
    } finally {
      await venue.asTenant((tenant) => tenant.query`ALTER TABLE webhook_event_hidden RENAME TO webhook_event`)
      await venue.asTenant((tenant) => tenant.query`ALTER TABLE message_template_hidden RENAME TO message_template`)
    }
  })

  it('keeps one venue out of another venue\'s booking', async () => {
    const session_id = await createSlot(futureAt(59))
    const created = await bookOk(session_id, 'Private Guest')
    const other = await createTestVenue('portal-other')
    try {
      const recovery = await other.publicRequest(
        `/public/${other.organization_code}/portal/booking/${created.booking_code}?token=${created.recovery_token}`,
      )
      assert.equal(recovery.status, 404)
      const payment = await other.request(`/api/v1/portal/booking/${created.booking_code}/payment`, {
        method: 'POST',
        body: JSON.stringify({ method: 'cash', amount: '500' }),
      })
      assert.equal(payment.status, 404)
      const list = await other.request('/api/v1/portal/booking')
      const body = (await list.json()) as { booking: View[] }
      assert.equal(body.booking.some((one) => one.booking_code === created.booking_code), false)
    } finally {
      await other.close()
    }
  })

  it('answers 404 on every portal route once the module is disabled', async () => {
    const session_id = await createSlot(futureAt(60))
    const created = await bookOk(session_id, 'Before Disable')
    await venue.asTenant((tenant) => disableModule(tenant, 'portal', COURT_DECLARATION))
    assert.equal((await venue.publicRequest(`/public/${venue.organization_code}/portal/availability`)).status, 404)
    assert.equal((await book(session_id, 'After Disable')).status, 404)
    assert.equal(
      (await venue.publicRequest(`/public/${venue.organization_code}/portal/booking/${created.booking_code}?token=${created.recovery_token}`)).status,
      404,
    )
    assert.equal((await venue.request('/api/v1/portal/booking')).status, 404)
  })
})
