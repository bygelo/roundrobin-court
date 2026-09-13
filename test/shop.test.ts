// R14 — the shop surface: counter sale under concurrency, refund, stock audit,
// public catalog, module gate, and tenant isolation.

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { disableModule, enableModule, type Uuid } from '@bygelo/roundrobin-kernel'
import { COURT_DECLARATION } from '../src/app.ts'
import { TEST_DATABASE_URL, createTestVenue, type TestVenue } from './helper.ts'

type Product = {
  catalog_id: Uuid
  name: string
  is_low_stock: boolean
  variant: { variant_id: Uuid; name: string; stock_on_hand_count: number | null; stock_status_code: string }[]
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

describe('shop (R14)', { skip: !TEST_DATABASE_URL }, () => {
  let venue: TestVenue
  let other: TestVenue

  before(async () => {
    venue = await createTestVenue('shop')
    other = await createTestVenue('shop-other')
  })

  after(async () => {
    await venue?.close()
    await other?.close()
  })

  async function product(
    target: TestVenue,
    input: { name: string; stock: number; price?: string; category?: string; threshold?: number },
  ): Promise<Product> {
    const response = await target.request('/api/v1/shop/product', {
      method: 'POST',
      body: JSON.stringify({
        name: input.name,
        category: input.category ?? 'Test',
        low_stock_threshold_count: input.threshold ?? 0,
        variant: [{ name: 'Standard', sku: `SKU-${input.name}`, price_amount: input.price ?? '40.00', opening_stock_count: input.stock }],
      }),
    })
    assert.equal(response.status, 201, await response.clone().text())
    return (await json<{ product: Product }>(response)).product
  }

  function sale(target: TestVenue, body: Record<string, unknown>) {
    return target.request('/api/v1/shop/counter-sale', { method: 'POST', body: JSON.stringify(body) })
  }

  async function onHand(variant_id: Uuid): Promise<number> {
    return venue.asTenant(async (tenant) => {
      const [row] = await tenant.query<{ quantity_on_hand: number }[]>`
        SELECT quantity_on_hand FROM inventory WHERE variant_id = ${variant_id}::uuid`
      return Number(row!.quantity_on_hand)
    })
  }

  async function ledgerSum(variant_id: Uuid): Promise<number> {
    return venue.asTenant(async (tenant) => {
      const [row] = await tenant.query<{ total: number }[]>`
        SELECT coalesce(sum(delta), 0)::int AS total FROM inventory_movement WHERE variant_id = ${variant_id}::uuid`
      return Number(row!.total)
    })
  }

  it('creates a product with variants and opening stock in one call, and lists stock badges', async () => {
    const created = await product(venue, { name: 'Water 500ml', stock: 3, threshold: 5 })
    assert.equal(created.variant[0]!.stock_on_hand_count, 3)
    assert.equal(created.variant[0]!.stock_status_code, 'low')
    assert.equal(created.is_low_stock, true)
    const list = await json<{ product: Product[] }>(await venue.request('/api/v1/shop/product'))
    assert.ok(list.product.some((one) => one.catalog_id === created.catalog_id))
  })

  it('sells the last unit exactly once under concurrent checkout, and stock never goes negative', async () => {
    const last = await product(venue, { name: 'Last paddle', stock: 1, price: '9500.00' })
    const variant_id = last.variant[0]!.variant_id
    const response = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        sale(venue, {
          idempotency_key: `last-${index}`,
          line: [{ variant_id, quantity_count: 1 }],
          payment: { method: 'card_terminal' },
        }),
      ),
    )
    const status = response.map((one) => one.status).sort()
    assert.deepEqual(status, [201, 409, 409, 409, 409, 409, 409, 409])
    const refusal = await json<{ error: string }>(response.find((one) => one.status === 409)!)
    assert.match(refusal.error, /Last paddle is sold out/)
    assert.equal(await onHand(variant_id), 0)
    assert.equal(await ledgerSum(variant_id), 0, 'ledger reconciles to on-hand')
    const [orphan] = await venue.asTenant((tenant) => tenant.query<{ orphan_count: number }[]>`
      SELECT count(*)::int AS orphan_count FROM sales_order o
      WHERE o.organization_id = ${venue.organization_id}::uuid
        AND NOT EXISTS (SELECT 1 FROM line l WHERE l.sales_order_id = o.sales_order_id)`)
    assert.equal(Number(orphan!.orphan_count), 0, 'a refused checkout leaves no placed order behind')
  })

  it('20 concurrent checkouts against 5 units: 5 orders, 15 explicit out-of-stock', async () => {
    const five = await product(venue, { name: 'Franklin X-40', stock: 5, price: '650.00' })
    const variant_id = five.variant[0]!.variant_id
    const response = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        sale(venue, { idempotency_key: `five-${index}`, line: [{ variant_id, quantity_count: 1 }], payment: { method: 'gcash', reference: `R${index}` } }),
      ),
    )
    assert.equal(response.filter((one) => one.status === 201).length, 5)
    assert.equal(response.filter((one) => one.status === 409).length, 15)
    assert.equal(await onHand(variant_id), 0)
  })

  it('consolidates duplicate lines before the stock check, and computes exact change', async () => {
    const water = await product(venue, { name: 'Consolidate water', stock: 3, price: '40.10' })
    const variant_id = water.variant[0]!.variant_id
    const response = await sale(venue, {
      idempotency_key: 'consolidate-1',
      line: [
        { variant_id, quantity_count: 2 },
        { variant_id, quantity_count: 1 },
      ],
      payment: { method: 'cash', tendered_amount: '200' },
    })
    assert.equal(response.status, 201, await response.clone().text())
    const { receipt } = await json<{ receipt: { line: { quantity_count: number }[]; total_amount: string; change_amount: string } }>(response)
    assert.equal(receipt.line.length, 1)
    assert.equal(receipt.line[0]!.quantity_count, 3)
    assert.equal(receipt.total_amount, '120.30')
    assert.equal(receipt.change_amount, '79.70')
  })

  it('refuses a short cash tender without taking stock', async () => {
    const grip = await product(venue, { name: 'Short tender grip', stock: 2, price: '180.00' })
    const variant_id = grip.variant[0]!.variant_id
    const response = await sale(venue, {
      idempotency_key: 'short-1',
      line: [{ variant_id, quantity_count: 2 }],
      payment: { method: 'cash', tendered_amount: '300.00' },
    })
    assert.equal(response.status, 400)
    assert.match((await json<{ error: string }>(response)).error, /does not cover the ₱360.00 total/)
    assert.equal(await onHand(variant_id), 2)
  })

  it('replays the same idempotency key as one order, even concurrently', async () => {
    const ball = await product(venue, { name: 'Replay ball', stock: 10 })
    const variant_id = ball.variant[0]!.variant_id
    const body = { idempotency_key: 'replay-1', line: [{ variant_id, quantity_count: 2 }], payment: { method: 'gcash' } }
    const response = await Promise.all([sale(venue, body), sale(venue, body), sale(venue, body)])
    const code = new Set<string>()
    for (const one of response) {
      assert.ok(one.status === 201 || one.status === 409, `unexpected ${one.status}`)
      if (one.status === 201) code.add((await json<{ receipt: { order_code: string } }>(one)).receipt.order_code)
    }
    const again = await sale(venue, body)
    assert.equal(again.status, 201)
    code.add((await json<{ receipt: { order_code: string } }>(again)).receipt.order_code)
    assert.equal(code.size, 1)
    assert.equal(await onHand(variant_id), 8)
  })

  it('refunds at most what was paid, restocks once, and the stock ledger balances', async () => {
    const paddle = await product(venue, { name: 'Refund paddle', stock: 4, price: '1000.00' })
    const variant_id = paddle.variant[0]!.variant_id
    const placed = await sale(venue, { idempotency_key: 'refund-1', line: [{ variant_id, quantity_count: 2 }], payment: { method: 'card_terminal' } })
    const { receipt } = await json<{ receipt: { sales_order_id: Uuid } }>(placed)
    assert.equal(await onHand(variant_id), 2)

    const refund = (body: Record<string, unknown>) =>
      venue.request(`/api/v1/shop/order/${receipt.sales_order_id}/refund`, { method: 'POST', body: JSON.stringify(body) })

    const too_much = await refund({ amount: '2000.01', reason: 'Wrong item', is_restock: false })
    assert.equal(too_much.status, 400)
    assert.match((await json<{ error: string }>(too_much)).error, /at most ₱2,000.00/)

    const partial = await refund({ amount: '500.00', reason: 'Scuffed edge guard', is_restock: false })
    assert.equal(partial.status, 200, await partial.clone().text())
    assert.equal(await onHand(variant_id), 2, 'a money-only refund leaves stock alone')

    const rest = await refund({ amount: '1500.00', reason: 'Returned both paddles', is_restock: true })
    assert.equal(rest.status, 200, await rest.clone().text())
    const { order } = await json<{ order: { status_code: string; refunded_amount: string; is_restocked: boolean } }>(rest)
    assert.equal(order.status_code, 'refunded')
    assert.equal(order.refunded_amount, '2000.00')
    assert.equal(order.is_restocked, true)
    assert.equal(await onHand(variant_id), 4)
    assert.equal(await ledgerSum(variant_id), 4, 'opening + sale + refund movements equal on-hand')

    const beyond = await refund({ amount: '0.01', reason: 'again', is_restock: false })
    assert.equal(beyond.status, 400)

    const trail = await venue.asTenant((tenant) => tenant.query<{ reason: string; delta: number }[]>`
      SELECT reason::text AS reason, delta FROM inventory_movement
      WHERE sales_order_id = ${receipt.sales_order_id}::uuid ORDER BY occurred_at, created_at`)
    assert.deepEqual(trail.map((one) => [one.reason, Number(one.delta)]), [['sale', -2], ['refund', 2]])
  })

  it('adjusts stock with a reason, audited, and never below zero', async () => {
    const grip = await product(venue, { name: 'Adjust grip', stock: 3 })
    const variant_id = grip.variant[0]!.variant_id
    const adjust = (body: Record<string, unknown>) =>
      venue.request(`/api/v1/shop/variant/${variant_id}/stock`, { method: 'POST', body: JSON.stringify(body) })

    const below = await adjust({ delta_count: -4, reason: 'Count' })
    assert.equal(below.status, 409)
    assert.equal((await adjust({ delta_count: 2 })).status, 400, 'reason is required')
    const ok = await adjust({ delta_count: -1, reason: 'Damaged in storage' })
    assert.equal(ok.status, 200)
    assert.equal((await json<{ stock: { stock_on_hand_count: number } }>(ok)).stock.stock_on_hand_count, 2)
    const [movement] = await venue.asTenant((tenant) => tenant.query<{ note: string; delta: number }[]>`
      SELECT note, delta FROM inventory_movement WHERE variant_id = ${variant_id}::uuid AND reason = 'adjust'`)
    assert.equal(movement!.note, 'Damaged in storage')
    assert.equal(Number(movement!.delta), -1)
    const [audit] = await venue.asTenant((tenant) => tenant.query`
      SELECT 1 FROM audit_event WHERE event_code = 'shop.stock.adjust' AND subject_id = ${variant_id}::uuid`)
    assert.ok(audit)
  })

  it('walks a set-aside sale through ready and picked up', async () => {
    const paddle = await product(venue, { name: 'Pickup paddle', stock: 1 })
    const placed = await sale(venue, {
      idempotency_key: 'pickup-1',
      is_pickup_later: true,
      line: [{ variant_id: paddle.variant[0]!.variant_id, quantity_count: 1 }],
      payment: { method: 'gcash' },
    })
    const { receipt } = await json<{ receipt: { sales_order_id: Uuid; pickup_status_code: string } }>(placed)
    assert.equal(receipt.pickup_status_code, 'waiting')
    const open = await json<{ order: { sales_order_id: Uuid }[] }>(await venue.request('/api/v1/shop/order?status=open'))
    assert.ok(open.order.some((one) => one.sales_order_id === receipt.sales_order_id))

    const ready = await venue.request(`/api/v1/shop/order/${receipt.sales_order_id}/ready`, { method: 'POST' })
    assert.equal((await json<{ order: { status_code: string } }>(ready)).order.status_code, 'ready')
    const picked = await venue.request(`/api/v1/shop/order/${receipt.sales_order_id}/picked-up`, { method: 'POST' })
    assert.equal((await json<{ order: { status_code: string } }>(picked)).order.status_code, 'picked_up')
    assert.equal((await venue.request(`/api/v1/shop/order/${receipt.sales_order_id}/ready`, { method: 'POST' })).status, 409)
  })

  it('serves a public catalog with prices and in-stock only — no counts, SKUs, or ids', async () => {
    const response = await venue.publicRequest(`/public/${venue.organization_code}/shop/catalog`)
    assert.equal(response.status, 200)
    const text = await response.text()
    for (const secret of ['quantity', 'stock_on_hand', 'sku', 'SKU-', '_id', 'cost', 'threshold']) {
      assert.ok(!text.includes(secret), `public catalog leaks "${secret}"`)
    }
    const catalog = JSON.parse(text) as {
      category: { category_name: string; product: { name: string; is_in_stock: boolean; price_min_amount: string }[] }[]
    }
    const all = catalog.category.flatMap((one) => one.product)
    assert.equal(all.find((one) => one.name === 'Last paddle')?.is_in_stock, false)
    assert.equal(all.find((one) => one.name === 'Water 500ml')?.is_in_stock, true)
    assert.equal(all.find((one) => one.name === 'Water 500ml')?.price_min_amount, '40.00')
  })

  it('keeps tenants apart: another venue sees none of these products and cannot sell them', async () => {
    const mine = await json<{ product: Product[] }>(await venue.request('/api/v1/shop/product'))
    const theirs = await json<{ product: Product[] }>(await other.request('/api/v1/shop/product'))
    assert.ok(mine.product.length > 0)
    assert.equal(theirs.product.length, 0)
    const foreign = await sale(other, {
      idempotency_key: 'foreign-1',
      line: [{ variant_id: mine.product[0]!.variant[0]!.variant_id, quantity_count: 1 }],
      payment: { method: 'gcash' },
    })
    assert.equal(foreign.status, 404)
    const orders = await json<{ order: unknown[] }>(await other.request('/api/v1/shop/order'))
    assert.equal(orders.order.length, 0)
    const catalog = await json<{ category: unknown[] }>(await other.publicRequest(`/public/${other.organization_code}/shop/catalog`))
    assert.equal(catalog.category.length, 0)
  })

  it('disabling shop removes the public catalog entirely and leaves reservation data untouched', async () => {
    const booking_id = await venue.asTenant(async (tenant) => {
      const [site] = await tenant.query<{ site_id: Uuid }[]>`
        INSERT INTO site (organization_id, site_code, display_name)
        VALUES (${venue.organization_id}, 'shop-main', 'Main') RETURNING site_id`
      const [resource] = await tenant.query<{ resource_id: Uuid }[]>`
        INSERT INTO resource (organization_id, site_id, resource_code, display_name, sort_order)
        VALUES (${venue.organization_id}, ${site!.site_id}, 'court-1', 'Court 1', 1) RETURNING resource_id`
      const [session] = await tenant.query<{ session_id: Uuid }[]>`
        INSERT INTO session (organization_id, site_id, session_code, starts_at, ends_at, capacity_count, price_amount, is_published)
        VALUES (${venue.organization_id}, ${site!.site_id}, 'shop-evening', '2027-05-01T10:00:00Z', '2027-05-01T11:00:00Z', 4, 500, true)
        RETURNING session_id`
      await tenant.query`
        INSERT INTO session_resource (organization_id, session_id, resource_id)
        VALUES (${venue.organization_id}, ${session!.session_id}, ${resource!.resource_id})`
      return { session_id: session!.session_id, resource_id: resource!.resource_id }
    })
    const booked = await venue.request('/api/v1/booking', { method: 'POST', body: JSON.stringify(booking_id) })
    assert.equal(booked.status, 201, await booked.clone().text())
    const snapshot = () =>
      venue.asTenant(
        (tenant) => tenant.query`
          SELECT booking_id, status, price_amount::text, starts_at FROM booking
          WHERE organization_id = ${venue.organization_id} ORDER BY booking_id`,
      )
    const before_disable = await snapshot()

    await venue.asTenant((tenant) => disableModule(tenant, 'shop', COURT_DECLARATION))
    try {
      assert.equal((await venue.publicRequest(`/public/${venue.organization_code}/shop/catalog`)).status, 404)
      assert.equal((await venue.request('/api/v1/shop/product')).status, 404)
      assert.deepEqual(await snapshot(), before_disable)
      assert.equal((await venue.publicRequest('/public/no-such-venue/shop/catalog')).status, 404)
    } finally {
      await venue.asTenant((tenant) => enableModule(tenant, 'shop', COURT_DECLARATION))
    }
    assert.equal((await venue.publicRequest(`/public/${venue.organization_code}/shop/catalog`)).status, 200)
  })
})
