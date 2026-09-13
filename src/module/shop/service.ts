// Shop — conveniences a venue counter needs over the commerce and billing packs.
//
// Writes go through pack services: createCatalog/createVariant/setInventory for
// products and stock, placeOrder (conditional stock UPDATE, K19) for sales,
// recordPayment/refundPayment for money, refundOrder for restock. The shop_*
// tables hold only what the packs do not model (category, threshold, receipt,
// pickup, refund reason).

import { randomBytes } from 'node:crypto'
import { DomainError, recordAuditEvent, type TenantContext, type Uuid } from '@bygelo/roundrobin-kernel'
import { listRefund, recordPayment, refundPayment } from '@bygelo/roundrobin-billing'
import {
  OutOfStockError,
  createCatalog,
  createVariant,
  placeOrder,
  refundOrder,
  setInventory,
  updateVariantPrice,
} from '@bygelo/roundrobin-commerce'
import { changeDue, displayPeso, fromCentavo, stockStatus, toCentavo } from './money.ts'

export class ShopError extends DomainError {
  constructor(message: string, http_status = 400) {
    super(message, http_status)
  }
}

export type PaymentMethodCode = 'cash' | 'gcash' | 'card_terminal'
export const PAYMENT_METHOD: PaymentMethodCode[] = ['cash', 'gcash', 'card_terminal']

export type StockStatusCode = 'in_stock' | 'low' | 'out' | 'untracked'

export type ShopVariant = {
  variant_id: Uuid
  variant_code: string
  name: string
  sku: string | null
  price_amount: string
  stock_on_hand_count: number | null
  stock_status_code: StockStatusCode
}

export type ShopProduct = {
  catalog_id: Uuid
  catalog_code: string
  name: string
  description: string | null
  category_name: string
  low_stock_threshold_count: number
  is_active: boolean
  is_track_inventory: boolean
  is_low_stock: boolean
  variant: ShopVariant[]
}

export type ReceiptLine = { description: string; quantity_count: number; unit_amount: string; line_amount: string }

export type Receipt = {
  sales_order_id: Uuid
  order_code: string
  placed_at: string
  line: ReceiptLine[]
  total_amount: string
  payment_method_code: PaymentMethodCode
  payment_reference: string | null
  tendered_amount: string | null
  change_amount: string
  pickup_status_code: PickupStatusCode
}

export type PickupStatusCode = 'waiting' | 'ready' | 'picked_up'

export type ShopOrder = {
  sales_order_id: Uuid
  order_code: string
  placed_at: string
  channel: string
  status_code: 'waiting' | 'ready' | 'picked_up' | 'refunded' | 'partly_refunded' | 'cancelled' | 'placed'
  total_amount: string
  paid_amount: string
  refunded_amount: string
  refundable_amount: string
  payment_method_code: PaymentMethodCode | null
  payment_reference: string | null
  pickup_status_code: PickupStatusCode | null
  is_restocked: boolean
  is_counter_sale: boolean
  line: ReceiptLine[]
}

function code(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString('hex')}`
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new ShopError(`${label} is required`)
  return value.trim()
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function requireCount(value: unknown, label: string, { allow_zero = true, allow_negative = false } = {}): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new ShopError(`${label} must be a whole number`)
  if (!allow_negative && value < 0) throw new ShopError(`${label} must not be negative`)
  if (!allow_zero && value === 0) throw new ShopError(`${label} must not be zero`)
  return value
}

// ---------------------------------------------------------------------------
// product
// ---------------------------------------------------------------------------

type ProductRow = {
  catalog_id: Uuid
  catalog_code: string
  catalog_name: string
  description: string | null
  status: string
  is_track_inventory: boolean
  category_name: string | null
  low_stock_threshold_count: number | null
  sort_order: number | null
  variant_id: Uuid | null
  variant_code: string | null
  variant_name: string | null
  sku: string | null
  price_amount: string | null
  quantity_on_hand: number | null
}

async function readProductRow(tenant: TenantContext, filter: { catalog_id?: Uuid; is_active_only?: boolean }) {
  return tenant.query<ProductRow[]>`
    SELECT c.catalog_id, c.catalog_code, c.name AS catalog_name, c.description, c.status::text AS status,
           c.is_track_inventory, sp.category_name, sp.low_stock_threshold_count, sp.sort_order,
           v.variant_id, v.variant_code, v.name AS variant_name, v.sku, v.price_amount::text AS price_amount,
           i.quantity_on_hand
    FROM catalog c
    LEFT JOIN shop_product sp
      ON sp.catalog_id = c.catalog_id AND sp.organization_id = c.organization_id AND sp.deleted_at IS NULL
    LEFT JOIN variant v
      ON v.catalog_id = c.catalog_id AND v.organization_id = c.organization_id AND v.deleted_at IS NULL
    LEFT JOIN inventory i
      ON i.variant_id = v.variant_id AND i.organization_id = v.organization_id
     AND i.scope_id IS NOT DISTINCT FROM ${tenant.scope_id}::uuid
    WHERE c.organization_id = ${tenant.organization_id}::uuid
      AND c.deleted_at IS NULL
      ${filter.catalog_id ? tenant.query`AND c.catalog_id = ${filter.catalog_id}::uuid` : tenant.query``}
      ${filter.is_active_only ? tenant.query`AND c.status = 'active'` : tenant.query``}
    ORDER BY coalesce(sp.category_name, 'Other'), coalesce(sp.sort_order, 0), c.name, v.is_default DESC, v.price_amount, v.name`
}

function groupProduct(row: ProductRow[]): ShopProduct[] {
  const by_catalog = new Map<string, ShopProduct>()
  for (const one of row) {
    const catalog_id = String(one.catalog_id)
    let product = by_catalog.get(catalog_id)
    if (!product) {
      product = {
        catalog_id,
        catalog_code: one.catalog_code,
        name: one.catalog_name,
        description: one.description,
        category_name: one.category_name ?? 'Other',
        low_stock_threshold_count: Number(one.low_stock_threshold_count ?? 0),
        is_active: one.status === 'active',
        is_track_inventory: Boolean(one.is_track_inventory),
        is_low_stock: false,
        variant: [],
      }
      by_catalog.set(catalog_id, product)
    }
    if (one.variant_id) {
      const on_hand = one.quantity_on_hand == null ? null : Number(one.quantity_on_hand)
      const status = stockStatus(on_hand, product.low_stock_threshold_count, product.is_track_inventory)
      product.variant.push({
        variant_id: String(one.variant_id),
        variant_code: one.variant_code ?? '',
        name: one.variant_name ?? '',
        sku: one.sku,
        price_amount: fromCentavo(toCentavo(one.price_amount ?? '0')),
        stock_on_hand_count: product.is_track_inventory ? (on_hand ?? 0) : null,
        stock_status_code: status,
      })
      if (status === 'low' || status === 'out') product.is_low_stock = true
    }
  }
  return [...by_catalog.values()]
}

export async function listProduct(tenant: TenantContext): Promise<ShopProduct[]> {
  return groupProduct(await readProductRow(tenant, {}))
}

export async function findProduct(tenant: TenantContext, catalog_id: Uuid): Promise<ShopProduct> {
  const [product] = groupProduct(await readProductRow(tenant, { catalog_id }))
  if (!product) throw new ShopError('product not found', 404)
  return product
}

export type CreateProductInput = {
  name: unknown
  category?: unknown
  description?: unknown
  catalog_code?: unknown
  is_track_inventory?: unknown
  low_stock_threshold_count?: unknown
  variant?: unknown
}

export async function createProduct(
  tenant: TenantContext,
  input: CreateProductInput,
  actor_id?: Uuid,
): Promise<ShopProduct> {
  const name = requireText(input.name, 'name')
  const category_name = optionalText(input.category) ?? 'Other'
  const description = optionalText(input.description)
  const is_track_inventory = input.is_track_inventory === undefined ? true : input.is_track_inventory === true
  const low_stock_threshold_count =
    input.low_stock_threshold_count === undefined || input.low_stock_threshold_count === null
      ? 0
      : requireCount(input.low_stock_threshold_count, 'low_stock_threshold_count')
  if (!Array.isArray(input.variant) || input.variant.length === 0) {
    throw new ShopError('at least one variant is required')
  }

  const is_single = input.variant.length === 1
  const variant = input.variant.map((raw, index) => {
    const one = (raw ?? {}) as Record<string, unknown>
    return {
      name: is_single ? (optionalText(one['name']) ?? 'Standard') : requireText(one['name'], `variant ${index + 1} name`),
      sku: optionalText(one['sku']),
      price_centavo: toCentavo(one['price_amount'], `variant ${index + 1} price`),
      opening_stock_count:
        one['opening_stock_count'] === undefined ? 0 : requireCount(one['opening_stock_count'], `variant ${index + 1} opening stock`),
    }
  })

  const catalog_code = optionalText(input.catalog_code) ?? `${slug(name) || 'product'}-${randomBytes(3).toString('hex')}`
  const catalog = await createCatalog(tenant, {
    name,
    catalog_code,
    ...(description ? { description } : {}),
    kind: is_track_inventory ? 'good' : 'rental',
    is_track_inventory,
  })

  for (const [index, one] of variant.entries()) {
    const created = await createVariant(tenant, {
      catalog_id: catalog.catalog_id,
      name: one.name,
      price_amount: one.price_centavo / 100,
      variant_code: `${catalog_code}-${index + 1}`,
      ...(one.sku ? { sku: one.sku } : {}),
      is_default: index === 0,
    })
    if (is_track_inventory) {
      await setInventory(tenant, {
        variant_id: created.variant_id,
        quantity_on_hand: one.opening_stock_count,
        ...(actor_id ? { actor_id } : {}),
        note: 'opening stock',
      })
    }
  }

  await tenant.query`
    INSERT INTO shop_product (organization_id, catalog_id, category_name, low_stock_threshold_count)
    VALUES (${tenant.organization_id}::uuid, ${catalog.catalog_id}::uuid, ${category_name}, ${low_stock_threshold_count})`

  return findProduct(tenant, catalog.catalog_id)
}

export async function updateProduct(
  tenant: TenantContext,
  catalog_id: Uuid,
  input: {
    name?: unknown
    description?: unknown
    category?: unknown
    low_stock_threshold_count?: unknown
    is_active?: unknown
    variant?: unknown
  },
): Promise<ShopProduct> {
  const current = await findProduct(tenant, catalog_id)

  const name = input.name === undefined ? current.name : requireText(input.name, 'name')
  const description = input.description === undefined ? current.description : optionalText(input.description)
  const is_active = input.is_active === undefined ? current.is_active : input.is_active === true
  // The commerce pack exposes no catalog-edit service; name, description and
  // archive status are updated in place on the tenant's own row.
  await tenant.query`
    UPDATE catalog
    SET name = ${name}, description = ${description},
        status = ${is_active ? 'active' : 'archived'}::catalog_status
    WHERE organization_id = ${tenant.organization_id}::uuid AND catalog_id = ${catalog_id}::uuid`

  const category_name = input.category === undefined ? current.category_name : optionalText(input.category) ?? 'Other'
  const threshold =
    input.low_stock_threshold_count === undefined
      ? current.low_stock_threshold_count
      : requireCount(input.low_stock_threshold_count, 'low_stock_threshold_count')
  await tenant.query`
    INSERT INTO shop_product (organization_id, catalog_id, category_name, low_stock_threshold_count)
    VALUES (${tenant.organization_id}::uuid, ${catalog_id}::uuid, ${category_name}, ${threshold})
    ON CONFLICT (organization_id, catalog_id)
    DO UPDATE SET category_name = EXCLUDED.category_name,
                  low_stock_threshold_count = EXCLUDED.low_stock_threshold_count,
                  deleted_at = NULL`

  if (Array.isArray(input.variant)) {
    for (const raw of input.variant) {
      const one = (raw ?? {}) as Record<string, unknown>
      const variant_id = requireText(one['variant_id'], 'variant_id')
      if (!current.variant.some((each) => each.variant_id === variant_id)) {
        throw new ShopError('variant does not belong to this product', 404)
      }
      if (one['price_amount'] !== undefined) {
        await updateVariantPrice(tenant, variant_id, toCentavo(one['price_amount'], 'price_amount') / 100)
      }
    }
  }

  return findProduct(tenant, catalog_id)
}

export async function adjustStock(
  tenant: TenantContext,
  variant_id: Uuid,
  input: { delta_count?: unknown; reason?: unknown },
  actor_id: Uuid,
): Promise<{ variant_id: Uuid; stock_on_hand_count: number; delta_count: number; reason: string }> {
  const delta_count = requireCount(input.delta_count, 'delta_count', { allow_zero: false, allow_negative: true })
  const reason = requireText(input.reason, 'reason')

  const [variant] = await tenant.query<{ is_track_inventory: boolean; name: string }[]>`
    SELECT c.is_track_inventory, c.name || ' — ' || v.name AS name
    FROM variant v
    JOIN catalog c ON c.catalog_id = v.catalog_id AND c.organization_id = v.organization_id
    WHERE v.organization_id = ${tenant.organization_id}::uuid
      AND v.variant_id = ${variant_id}::uuid AND v.deleted_at IS NULL`
  if (!variant) throw new ShopError('variant not found', 404)
  if (!variant.is_track_inventory) throw new ShopError(`${variant.name} does not track stock`)

  // Lock the counter row so a concurrent sale or adjustment waits: the absolute
  // value written below is computed from what this transaction just read.
  const [inventory] = await tenant.query<{ quantity_on_hand: number }[]>`
    SELECT quantity_on_hand FROM inventory
    WHERE organization_id = ${tenant.organization_id}::uuid
      AND variant_id = ${variant_id}::uuid
      AND scope_id IS NOT DISTINCT FROM ${tenant.scope_id}::uuid
    FOR UPDATE`
  const on_hand = Number(inventory?.quantity_on_hand ?? 0)
  const next = on_hand + delta_count
  if (next < 0) {
    throw new ShopError(`Only ${on_hand} of ${variant.name} on hand — cannot remove ${-delta_count}`, 409)
  }

  await setInventory(tenant, { variant_id, quantity_on_hand: next, actor_id, note: reason })
  await recordAuditEvent(tenant, {
    organization_id: tenant.organization_id,
    actor_label: actor_id,
    event_code: 'shop.stock.adjust',
    subject_table: 'variant',
    subject_id: variant_id,
    reason,
    detail: { delta_count, stock_on_hand_count: next },
  })
  return { variant_id, stock_on_hand_count: next, delta_count, reason }
}

// ---------------------------------------------------------------------------
// counter sale
// ---------------------------------------------------------------------------

/**
 * The party a walk-up sale is paid by. Billing needs a payer on every payment;
 * a counter customer is anonymous, so the tenant has exactly one walk-in party,
 * created under an advisory lock so two first-ever sales cannot create two.
 */
export async function ensureWalkInParty(tenant: TenantContext): Promise<Uuid> {
  await tenant.query`SELECT pg_advisory_xact_lock(hashtext(${`shop.walk_in:${tenant.organization_id}`}))`
  const [existing] = await tenant.query<{ party_id: Uuid }[]>`
    SELECT party_id FROM party
    WHERE organization_id = ${tenant.organization_id}::uuid
      AND deleted_at IS NULL AND detail->>'shop_role' = 'walk_in'
    ORDER BY created_at LIMIT 1`
  if (existing) return String(existing.party_id)
  const [created] = await tenant.query<{ party_id: Uuid }[]>`
    INSERT INTO party (organization_id, display_name, detail)
    VALUES (${tenant.organization_id}::uuid, 'Walk-in customer', ${tenant.query.json({ shop_role: 'walk_in' } as never)})
    RETURNING party_id`
  return String(created!.party_id)
}

export type CounterSaleInput = {
  line?: unknown
  payment?: unknown
  idempotency_key?: unknown
  is_pickup_later?: unknown
}

export async function counterSale(tenant: TenantContext, input: CounterSaleInput, actor_id?: Uuid): Promise<Receipt> {
  if (!Array.isArray(input.line) || input.line.length === 0) throw new ShopError('add at least one item to the sale')
  const line = input.line.map((raw) => {
    const one = (raw ?? {}) as Record<string, unknown>
    return {
      variant_id: requireText(one['variant_id'], 'variant_id'),
      quantity: requireCount(one['quantity_count'], 'quantity_count', { allow_zero: false }),
    }
  })
  const payment = (input.payment ?? {}) as Record<string, unknown>
  const method = payment['method']
  if (typeof method !== 'string' || !PAYMENT_METHOD.includes(method as PaymentMethodCode)) {
    throw new ShopError('payment method must be cash, gcash, or card_terminal')
  }
  const payment_method_code = method as PaymentMethodCode
  const payment_reference = optionalText(payment['reference'])
  const tendered_centavo =
    payment_method_code === 'cash'
      ? payment['tendered_amount'] === undefined || payment['tendered_amount'] === null || payment['tendered_amount'] === ''
        ? undefined
        : toCentavo(payment['tendered_amount'], 'tendered amount')
      : undefined
  const key = optionalText(input.idempotency_key) ?? code('sale')

  const replay = await findReceiptByKey(tenant, key)
  if (replay) return replay

  // Friendly names for refusal sentences — never show a variant uuid to a cashier.
  const label = await tenant.query<{ variant_id: Uuid; label: string }[]>`
    SELECT v.variant_id, CASE WHEN count(*) OVER (PARTITION BY v.catalog_id) > 1 OR v.name NOT IN ('Standard', c.name)
                              THEN c.name || ' (' || v.name || ')' ELSE c.name END AS label
    FROM variant v JOIN catalog c ON c.catalog_id = v.catalog_id AND c.organization_id = v.organization_id
    WHERE v.organization_id = ${tenant.organization_id}::uuid
      AND v.catalog_id IN (
        SELECT catalog_id FROM variant
        WHERE organization_id = ${tenant.organization_id}::uuid
          AND variant_id IN ${tenant.query(line.map((one) => one.variant_id))})`
  const name_by_variant = new Map(label.map((one) => [String(one.variant_id), one.label]))
  for (const one of line) {
    if (!name_by_variant.has(one.variant_id)) throw new ShopError('an item in this sale is no longer in the catalog', 404)
  }

  let placed
  try {
    placed = await placeOrder(tenant, {
      idempotency_key: `shop:${key}`,
      line,
      channel: 'pos',
      ...(actor_id ? { actor_id } : {}),
      is_receivable: false,
    })
  } catch (error) {
    if (error instanceof OutOfStockError) {
      const match = /variant "([^"]+)"(?: \(need (\d+), have (\d+)\))?/.exec(error.message)
      const name = (match?.[1] && name_by_variant.get(match[1])) || 'An item'
      const have = match?.[3]
      throw new ShopError(
        have === undefined || have === '0' ? `${name} is sold out` : `${name} has only ${have} left`,
        409,
      )
    }
    throw error
  }

  const again = await findReceiptByKey(tenant, key)
  if (again) return again

  const total_centavo = toCentavo(placed.order.total_amount)
  if (total_centavo <= 0) throw new ShopError('nothing to charge — every item in this sale is free')

  let change_centavo = 0
  if (payment_method_code === 'cash') {
    if (tendered_centavo === undefined) throw new ShopError('enter the cash tendered')
    change_centavo = changeDue(total_centavo, tendered_centavo)
  }

  const party_id = await ensureWalkInParty(tenant)
  const recorded = await recordPayment(tenant, {
    party_id,
    amount: total_centavo / 100,
    collection_mode: payment_method_code === 'cash' ? 'cash_pos' : 'manual_record',
    idempotency_key: `shop:${key}`,
    method_code: payment_method_code,
    ...(payment_reference ? { external_ref: payment_reference } : {}),
    note: `Counter sale ${placed.order.order_code}`,
    post_now: true,
  })

  const is_pickup_later = input.is_pickup_later === true
  await tenant.query`
    INSERT INTO shop_sale (
      organization_id, sales_order_id, payment_id, actor_id, payment_method_code, payment_reference,
      paid_amount, tendered_amount, change_amount, pickup_status_code, picked_up_at
    ) VALUES (
      ${tenant.organization_id}::uuid, ${placed.order.sales_order_id}::uuid, ${recorded.payment_id}::uuid,
      ${actor_id ?? null}::uuid, ${payment_method_code}, ${payment_reference},
      ${fromCentavo(total_centavo)}::numeric,
      ${tendered_centavo === undefined ? null : fromCentavo(tendered_centavo)}::numeric,
      ${fromCentavo(change_centavo)}::numeric,
      ${is_pickup_later ? 'waiting' : 'picked_up'},
      ${is_pickup_later ? null : new Date()}
    )
    ON CONFLICT (organization_id, sales_order_id) DO NOTHING`

  const receipt = await findReceiptByKey(tenant, key)
  if (!receipt) throw new ShopError('sale was placed but its receipt could not be read', 500)
  return receipt
}

async function findReceiptByKey(tenant: TenantContext, key: string): Promise<Receipt | null> {
  const [row] = await tenant.query<
    {
      sales_order_id: Uuid
      order_code: string
      placed_at: Date
      total_amount: string
      payment_method_code: PaymentMethodCode
      payment_reference: string | null
      tendered_amount: string | null
      change_amount: string
      pickup_status_code: PickupStatusCode
    }[]
  >`
    SELECT o.sales_order_id, o.order_code, o.placed_at, o.total_amount::text AS total_amount,
           s.payment_method_code, s.payment_reference, s.tendered_amount::text AS tendered_amount,
           s.change_amount::text AS change_amount, s.pickup_status_code
    FROM sales_order o
    JOIN shop_sale s ON s.sales_order_id = o.sales_order_id AND s.organization_id = o.organization_id
    WHERE o.organization_id = ${tenant.organization_id}::uuid
      AND o.idempotency_key = ${`shop:${key}`}`
  if (!row) return null
  const line = await readLine(tenant, [String(row.sales_order_id)])
  return {
    sales_order_id: String(row.sales_order_id),
    order_code: row.order_code,
    placed_at: new Date(row.placed_at).toISOString(),
    line: line.get(String(row.sales_order_id)) ?? [],
    total_amount: fromCentavo(toCentavo(row.total_amount)),
    payment_method_code: row.payment_method_code,
    payment_reference: row.payment_reference,
    tendered_amount: row.tendered_amount === null ? null : fromCentavo(toCentavo(row.tendered_amount)),
    change_amount: fromCentavo(toCentavo(row.change_amount)),
    pickup_status_code: row.pickup_status_code,
  }
}

async function readLine(tenant: TenantContext, sales_order_id: Uuid[]): Promise<Map<string, ReceiptLine[]>> {
  const result = new Map<string, ReceiptLine[]>()
  if (sales_order_id.length === 0) return result
  const row = await tenant.query<
    { sales_order_id: Uuid; description: string; quantity: number; unit_amount: string; line_amount: string }[]
  >`
    SELECT sales_order_id, description, quantity, unit_amount::text AS unit_amount, line_amount::text AS line_amount
    FROM line
    WHERE organization_id = ${tenant.organization_id}::uuid
      AND sales_order_id IN ${tenant.query(sales_order_id)}
    ORDER BY sort_order, created_at`
  for (const one of row) {
    const id = String(one.sales_order_id)
    const list = result.get(id) ?? []
    list.push({
      description: one.description,
      quantity_count: Number(one.quantity),
      unit_amount: fromCentavo(toCentavo(one.unit_amount)),
      line_amount: fromCentavo(toCentavo(one.line_amount)),
    })
    result.set(id, list)
  }
  return result
}

// ---------------------------------------------------------------------------
// order
// ---------------------------------------------------------------------------

const ORDER_STATUS = ['waiting', 'ready', 'picked_up', 'refunded', 'partly_refunded', 'cancelled', 'placed'] as const

export async function listShopOrder(
  tenant: TenantContext,
  filter: { status?: string | undefined; sales_order_id?: Uuid; limit_count?: number } = {},
): Promise<ShopOrder[]> {
  if (filter.status && filter.status !== 'open' && !ORDER_STATUS.includes(filter.status as (typeof ORDER_STATUS)[number])) {
    throw new ShopError(`unknown order status "${filter.status}"`)
  }
  const limit_count = Math.min(Math.max(filter.limit_count ?? 100, 1), 200)
  const row = await tenant.query<
    {
      sales_order_id: Uuid
      order_code: string
      placed_at: Date
      channel: string
      order_status: string
      total_amount: string
      paid_amount: string | null
      refunded_amount: string
      payment_method_code: PaymentMethodCode | null
      payment_reference: string | null
      pickup_status_code: PickupStatusCode | null
      is_restocked: boolean
      is_counter_sale: boolean
      status_code: ShopOrder['status_code']
    }[]
  >`
    WITH view AS (
      SELECT o.sales_order_id, o.order_code, o.placed_at, o.channel::text AS channel, o.status::text AS order_status,
             o.total_amount, s.paid_amount, s.payment_method_code, s.payment_reference, s.pickup_status_code,
             s.shop_sale_id IS NOT NULL AS is_counter_sale,
             coalesce(r.refunded_amount, 0) AS refunded_amount,
             coalesce(r.is_restocked, false) AS is_restocked
      FROM sales_order o
      LEFT JOIN shop_sale s ON s.sales_order_id = o.sales_order_id AND s.organization_id = o.organization_id
      LEFT JOIN LATERAL (
        SELECT sum(refund_amount) AS refunded_amount, bool_or(is_restock) AS is_restocked
        FROM shop_refund WHERE shop_sale_id = s.shop_sale_id AND organization_id = o.organization_id
      ) r ON true
      WHERE o.organization_id = ${tenant.organization_id}::uuid
        AND o.deleted_at IS NULL AND o.status <> 'draft'
        ${filter.sales_order_id ? tenant.query`AND o.sales_order_id = ${filter.sales_order_id}::uuid` : tenant.query``}
    ), derived AS (
      SELECT view.*,
             CASE
               WHEN paid_amount > 0 AND refunded_amount >= paid_amount THEN 'refunded'
               WHEN refunded_amount > 0 THEN 'partly_refunded'
               WHEN pickup_status_code IS NOT NULL THEN pickup_status_code
               WHEN order_status = 'cancelled' THEN 'cancelled'
               ELSE 'placed'
             END AS status_code
      FROM view
    )
    SELECT sales_order_id, order_code, placed_at, channel, order_status, total_amount::text AS total_amount,
           paid_amount::text AS paid_amount, refunded_amount::text AS refunded_amount, payment_method_code,
           payment_reference, pickup_status_code, is_restocked, is_counter_sale, status_code
    FROM derived
    WHERE true
      ${
        filter.status === 'open'
          ? tenant.query`AND status_code IN ('waiting', 'ready')`
          : filter.status
            ? tenant.query`AND status_code = ${filter.status}`
            : tenant.query``
      }
    ORDER BY placed_at DESC
    LIMIT ${limit_count}`

  const line = await readLine(
    tenant,
    row.map((one) => String(one.sales_order_id)),
  )
  return row.map((one) => {
    const paid = toCentavo(one.paid_amount ?? '0')
    const refunded = toCentavo(one.refunded_amount)
    return {
      sales_order_id: String(one.sales_order_id),
      order_code: one.order_code,
      placed_at: new Date(one.placed_at).toISOString(),
      channel: one.channel,
      status_code: one.status_code,
      total_amount: fromCentavo(toCentavo(one.total_amount)),
      paid_amount: fromCentavo(paid),
      refunded_amount: fromCentavo(refunded),
      refundable_amount: fromCentavo(Math.max(paid - refunded, 0)),
      payment_method_code: one.payment_method_code,
      payment_reference: one.payment_reference,
      pickup_status_code: one.pickup_status_code,
      is_restocked: Boolean(one.is_restocked),
      is_counter_sale: Boolean(one.is_counter_sale),
      line: line.get(String(one.sales_order_id)) ?? [],
    }
  })
}

export async function findShopOrder(tenant: TenantContext, sales_order_id: Uuid): Promise<ShopOrder> {
  const [order] = await listShopOrder(tenant, { sales_order_id })
  if (!order) throw new ShopError('order not found', 404)
  return order
}

export async function setPickupStatus(
  tenant: TenantContext,
  sales_order_id: Uuid,
  next: 'ready' | 'picked_up',
): Promise<ShopOrder> {
  const updated =
    next === 'ready'
      ? await tenant.query`
          UPDATE shop_sale SET pickup_status_code = 'ready', ready_at = now()
          WHERE organization_id = ${tenant.organization_id}::uuid
            AND sales_order_id = ${sales_order_id}::uuid AND pickup_status_code = 'waiting'
          RETURNING shop_sale_id`
      : await tenant.query`
          UPDATE shop_sale SET pickup_status_code = 'picked_up', picked_up_at = now()
          WHERE organization_id = ${tenant.organization_id}::uuid
            AND sales_order_id = ${sales_order_id}::uuid AND pickup_status_code IN ('waiting', 'ready')
          RETURNING shop_sale_id`
  if (updated.length === 0) {
    const order = await findShopOrder(tenant, sales_order_id)
    if (!order.is_counter_sale) throw new ShopError('only counter sales have a pickup state', 409)
    throw new ShopError(
      order.pickup_status_code === 'picked_up' ? 'This order has already been picked up' : 'This order is already ready for pickup',
      409,
    )
  }
  return findShopOrder(tenant, sales_order_id)
}

export async function refundShopOrder(
  tenant: TenantContext,
  sales_order_id: Uuid,
  input: { amount?: unknown; reason?: unknown; is_restock?: unknown; idempotency_key?: unknown },
  actor_id: Uuid,
): Promise<{ order: ShopOrder; refund_amount: string; is_restock: boolean }> {
  const amount_centavo = toCentavo(input.amount, 'refund amount')
  if (amount_centavo <= 0) throw new ShopError('refund amount must be more than zero')
  const reason = requireText(input.reason, 'reason')
  const is_restock = input.is_restock === true
  const key = optionalText(input.idempotency_key)

  // Serialize refunds on one sale: the remaining-amount read and the restock
  // check below are only true while this lock is held.
  const [sale] = await tenant.query<{ shop_sale_id: Uuid; payment_id: Uuid; paid_amount: string }[]>`
    SELECT shop_sale_id, payment_id, paid_amount::text AS paid_amount
    FROM shop_sale
    WHERE organization_id = ${tenant.organization_id}::uuid AND sales_order_id = ${sales_order_id}::uuid
    FOR UPDATE`
  if (!sale) throw new ShopError('only counter sales can be refunded here', 404)

  if (key) {
    const prior = await listRefund(tenant, String(sale.payment_id))
    const replay = prior.find((one) => one.idempotency_key === `shop-refund:${key}`)
    if (replay) {
      const [recorded] = await tenant.query<{ is_restock: boolean }[]>`
        SELECT is_restock FROM shop_refund
        WHERE organization_id = ${tenant.organization_id}::uuid AND refund_id = ${replay.refund_id}::uuid`
      return {
        order: await findShopOrder(tenant, sales_order_id),
        refund_amount: fromCentavo(toCentavo(replay.amount)),
        is_restock: Boolean(recorded?.is_restock),
      }
    }
  }

  const [total] = await tenant.query<{ refunded_amount: string; refund_count: number; is_restocked: boolean }[]>`
    SELECT coalesce(sum(refund_amount), 0)::text AS refunded_amount, count(*)::int AS refund_count,
           coalesce(bool_or(is_restock), false) AS is_restocked
    FROM shop_refund
    WHERE organization_id = ${tenant.organization_id}::uuid AND shop_sale_id = ${sale.shop_sale_id}::uuid`
  const paid = toCentavo(sale.paid_amount)
  const already = toCentavo(total?.refunded_amount ?? '0')
  const remaining = paid - already
  if (amount_centavo > remaining) {
    throw new ShopError(
      remaining <= 0
        ? 'This sale has already been fully refunded'
        : `You can refund at most ${displayPeso(remaining)} — ${displayPeso(paid)} paid, ${displayPeso(already)} already refunded`,
    )
  }
  if (is_restock && total?.is_restocked) throw new ShopError('The stock for this sale has already been returned', 409)

  const refund = await refundPayment(tenant, {
    payment_id: String(sale.payment_id),
    amount: amount_centavo / 100,
    reason_code: 'shop_refund',
    idempotency_key: key ? `shop-refund:${key}` : `shop-refund:${sale.shop_sale_id}:${Number(total?.refund_count ?? 0) + 1}`,
    note: reason,
  })

  if (is_restock) {
    await refundOrder(tenant, { sales_order_id, actor_id, note: reason })
  }

  await tenant.query`
    INSERT INTO shop_refund (organization_id, shop_sale_id, refund_id, actor_id, refund_amount, reason, is_restock)
    VALUES (${tenant.organization_id}::uuid, ${sale.shop_sale_id}::uuid, ${refund.refund_id}::uuid, ${actor_id}::uuid,
            ${fromCentavo(amount_centavo)}::numeric, ${reason}, ${is_restock})`

  await recordAuditEvent(tenant, {
    organization_id: tenant.organization_id,
    actor_label: actor_id,
    event_code: 'shop.order.refund',
    subject_table: 'sales_order',
    subject_id: sales_order_id,
    reason,
    detail: { refund_amount: fromCentavo(amount_centavo), is_restock },
  })

  return { order: await findShopOrder(tenant, sales_order_id), refund_amount: fromCentavo(amount_centavo), is_restock }
}

// ---------------------------------------------------------------------------
// public catalog
// ---------------------------------------------------------------------------

export type PublicCatalog = {
  category: {
    category_name: string
    product: {
      catalog_code: string
      name: string
      description: string | null
      price_min_amount: string
      price_max_amount: string
      is_in_stock: boolean
      variant: { variant_code: string; name: string; price_amount: string; is_in_stock: boolean }[]
    }[]
  }[]
}

/** What a player may see: names, prices, and in-stock — never counts, SKUs, or ids. */
export async function readPublicCatalog(tenant: TenantContext): Promise<PublicCatalog> {
  const product = groupProduct(await readProductRow(tenant, { is_active_only: true })).filter((one) => one.variant.length > 0)
  const by_category = new Map<string, PublicCatalog['category'][number]>()
  for (const one of product) {
    const price = one.variant.map((each) => toCentavo(each.price_amount))
    const variant = one.variant.map((each) => ({
      variant_code: each.variant_code,
      name: each.name,
      price_amount: each.price_amount,
      is_in_stock: each.stock_status_code !== 'out',
    }))
    const category = by_category.get(one.category_name) ?? { category_name: one.category_name, product: [] }
    category.product.push({
      catalog_code: one.catalog_code,
      name: one.name,
      description: one.description,
      price_min_amount: fromCentavo(Math.min(...price)),
      price_max_amount: fromCentavo(Math.max(...price)),
      is_in_stock: variant.some((each) => each.is_in_stock),
      variant,
    })
    by_category.set(one.category_name, category)
  }
  return { category: [...by_category.values()] }
}
