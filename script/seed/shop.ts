// Seed step for the shop module: a pickleball pro-shop shelf and a couple of
// counter sales. Idempotent — products are keyed by catalog_code, sales by an
// idempotency key per day, and a sale is skipped when stock would not cover it.

import { localDate } from '../../src/module/member/rule.ts'
import { counterSale, createProduct } from '../../src/module/shop/service.ts'
import type { SeedContext } from './context.ts'

const PRODUCT = [
  {
    catalog_code: 'joola-ben-johns-hyperion-16',
    name: 'Joola Ben Johns Hyperion 16mm',
    category: 'Paddles',
    description: 'Carbon friction surface, 16mm core for control at the kitchen line.',
    low_stock_threshold_count: 2,
    variant: [
      { name: 'Standard shape', sku: 'JBJH16-STD', price_amount: '9500.00', opening_stock_count: 4 },
      { name: 'Swift (elongated)', sku: 'JBJH16-SWF', price_amount: '9500.00', opening_stock_count: 2 },
    ],
  },
  {
    catalog_code: 'franklin-x40-3-pack',
    name: 'Franklin X-40 balls 3-pack',
    category: 'Balls',
    description: 'USA Pickleball approved outdoor ball.',
    low_stock_threshold_count: 10,
    variant: [{ name: '3-pack', sku: 'FRX40-3', price_amount: '650.00', opening_stock_count: 36 }],
  },
  {
    catalog_code: 'overgrip',
    name: 'Overgrip',
    category: 'Accessories',
    description: 'Tacky overgrip, one wrap.',
    low_stock_threshold_count: 5,
    variant: [{ name: 'Standard', sku: 'OVG-1', price_amount: '180.00', opening_stock_count: 25 }],
  },
  {
    catalog_code: 'water-500ml',
    name: 'Water 500ml',
    category: 'Drinks',
    description: 'Cold from the counter fridge.',
    low_stock_threshold_count: 12,
    variant: [{ name: 'Standard', sku: 'H2O-500', price_amount: '40.00', opening_stock_count: 9 }],
  },
  {
    catalog_code: 'paddle-rental',
    name: 'Paddle rental',
    category: 'Rentals',
    description: 'A demo paddle for your session. Return it at the counter.',
    is_track_inventory: false,
    low_stock_threshold_count: 0,
    variant: [{ name: 'Per session', sku: 'RENT-PADDLE', price_amount: '150.00' }],
  },
] as const

export async function seedShop({ tenant, organization_id }: SeedContext): Promise<void> {
  const variant_by_sku = new Map<string, string>()

  for (const one of PRODUCT) {
    const [existing] = await tenant.query<{ catalog_id: string }[]>`
      SELECT catalog_id FROM catalog WHERE organization_id = ${organization_id}::uuid AND catalog_code = ${one.catalog_code}`
    if (!existing) await createProduct(tenant, { ...one, variant: one.variant.map((each) => ({ ...each })) })
  }

  const variant = await tenant.query<{ variant_id: string; sku: string; quantity_on_hand: number | null }[]>`
    SELECT v.variant_id, v.sku, i.quantity_on_hand
    FROM variant v LEFT JOIN inventory i ON i.variant_id = v.variant_id AND i.organization_id = v.organization_id
    WHERE v.organization_id = ${organization_id}::uuid AND v.sku IS NOT NULL`
  const stock_by_variant = new Map<string, number | null>()
  for (const one of variant) {
    variant_by_sku.set(one.sku, String(one.variant_id))
    stock_by_variant.set(String(one.variant_id), one.quantity_on_hand === null ? null : Number(one.quantity_on_hand))
  }

  const today = localDate(new Date())
  const sale = [
    {
      key: `seed-${today}-1`,
      line: [
        { sku: 'H2O-500', quantity_count: 3 },
        { sku: 'OVG-1', quantity_count: 1 },
      ],
      payment: { method: 'cash', tendered_amount: '500.00' },
    },
    {
      key: `seed-${today}-2`,
      line: [
        { sku: 'FRX40-3', quantity_count: 1 },
        { sku: 'RENT-PADDLE', quantity_count: 2 },
      ],
      payment: { method: 'gcash', reference: '1009 482 7731' },
    },
  ]

  for (const one of sale) {
    const line = one.line.map((each) => ({ variant_id: variant_by_sku.get(each.sku)!, quantity_count: each.quantity_count }))
    const [replay] = await tenant.query`
      SELECT 1 FROM sales_order WHERE organization_id = ${organization_id}::uuid AND idempotency_key = ${`shop:${one.key}`}`
    // Skip rather than fail when an earlier day's seed has emptied the shelf.
    const is_covered = line.every((each) => {
      const stock = stock_by_variant.get(each.variant_id)
      return stock === null || stock === undefined ? true : stock >= each.quantity_count
    })
    if (!replay && !is_covered) continue
    await counterSale(tenant, { idempotency_key: one.key, line, payment: one.payment })
    if (!replay) {
      for (const each of line) {
        const stock = stock_by_variant.get(each.variant_id)
        if (typeof stock === 'number') stock_by_variant.set(each.variant_id, stock - each.quantity_count)
      }
    }
  }
}
