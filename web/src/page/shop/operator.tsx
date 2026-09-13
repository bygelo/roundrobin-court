// Operator → Shop: the counter (ring up a sale), products (stock and new
// products), and orders (pickup and refunds). Every number comes from
// /api/v1/shop; the server is authoritative on stock and money.

import { Minus, Plus, Trash } from '@phosphor-icons/react'
import { useMemo, useState } from 'react'
import { jsonBody, operatorFetch } from '../../api.ts'
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Dialog,
  EmptyState,
  ErrorAlert,
  PageHeader,
  ResourceView,
  SelectInput,
  Tabs,
  TextArea,
  TextInput,
  Toolbar,
  type BadgeTone,
} from '../../component/ui.tsx'
import { formatDateTime, formatMoney } from '../../format.ts'
import { useAction, useResource } from '../../hook.ts'
import type { PageProp } from '../../registry.ts'
import { useOperator } from '../../session.tsx'
import './shop.css'

// ---- API shapes -----------------------------------------------------------

type StockStatusCode = 'in_stock' | 'low' | 'out' | 'untracked'
type PaymentMethodCode = 'cash' | 'gcash' | 'card_terminal'

type ShopVariant = {
  variant_id: string
  name: string
  sku: string | null
  price_amount: string
  stock_on_hand_count: number | null
  stock_status_code: StockStatusCode
}

type ShopProduct = {
  catalog_id: string
  name: string
  description: string | null
  category_name: string
  low_stock_threshold_count: number
  is_active: boolean
  is_track_inventory: boolean
  is_low_stock: boolean
  variant: ShopVariant[]
}

type ReceiptLine = { description: string; quantity_count: number; unit_amount: string; line_amount: string }

type Receipt = {
  order_code: string
  placed_at: string
  line: ReceiptLine[]
  total_amount: string
  payment_method_code: PaymentMethodCode
  tendered_amount: string | null
  change_amount: string
  pickup_status_code: 'waiting' | 'ready' | 'picked_up'
}

type OrderStatusCode = 'waiting' | 'ready' | 'picked_up' | 'refunded' | 'partly_refunded' | 'cancelled' | 'placed'

type ShopOrder = {
  sales_order_id: string
  order_code: string
  placed_at: string
  status_code: OrderStatusCode
  total_amount: string
  paid_amount: string
  refunded_amount: string
  refundable_amount: string
  payment_method_code: PaymentMethodCode | null
  payment_reference: string | null
  is_restocked: boolean
  is_counter_sale: boolean
  line: ReceiptLine[]
}

// ---- shared helpers -------------------------------------------------------

const METHOD_LABEL: Record<PaymentMethodCode, string> = { cash: 'Cash', gcash: 'GCash', card_terminal: 'Card terminal' }

const STOCK_BADGE: Record<StockStatusCode, { tone: BadgeTone; label: string }> = {
  in_stock: { tone: 'success', label: 'In stock' },
  low: { tone: 'caution', label: 'Low' },
  out: { tone: 'danger', label: 'Out' },
  untracked: { tone: 'neutral', label: 'Not tracked' },
}

const ORDER_BADGE: Record<OrderStatusCode, { tone: BadgeTone; label: string }> = {
  waiting: { tone: 'caution', label: 'Waiting for pickup' },
  ready: { tone: 'info', label: 'Ready at counter' },
  picked_up: { tone: 'success', label: 'Picked up' },
  refunded: { tone: 'neutral', label: 'Refunded' },
  partly_refunded: { tone: 'caution', label: 'Partly refunded' },
  cancelled: { tone: 'neutral', label: 'Cancelled' },
  placed: { tone: 'neutral', label: 'Placed' },
}

function toCentavo(value: string): number | undefined {
  const text = value.trim()
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(text)) return undefined
  const [whole = '0', fraction = ''] = text.split('.')
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
}

function fromCentavo(centavo: number): string {
  return `${Math.floor(centavo / 100)}.${String(centavo % 100).padStart(2, '0')}`
}

function variantLabel(product: ShopProduct, variant: ShopVariant): string {
  return product.variant.length > 1 || (variant.name !== 'Standard' && variant.name !== product.name)
    ? `${product.name} — ${variant.name}`
    : product.name
}

function newKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`
}

function loadProduct() {
  return operatorFetch<{ product: ShopProduct[] }>('/api/v1/shop/product').then((result) => result.product)
}

type Tab = 'counter' | 'product' | 'order'

export default function Page(_prop: PageProp) {
  const { can } = useOperator()
  const [tab, setTab] = useState<Tab>('counter')
  const product = useResource(loadProduct, [])
  const can_manage = can('shop.manage')

  return (
    <>
      <PageHeader
        eyebrow="Business"
        title="Shop"
        description="Ring up paddles, balls, drinks and rentals at the counter. Stock drops the moment a sale completes."
      />
      <Tabs<Tab>
        label="Shop sections"
        value={tab}
        onChange={setTab}
        option={[
          { value: 'counter', label: 'Counter' },
          { value: 'product', label: 'Products' },
          { value: 'order', label: 'Orders' },
        ]}
      />
      {tab === 'counter' && <Counter product={product} can_manage={can_manage} onGoProduct={() => setTab('product')} />}
      {tab === 'product' && <ProductTab product={product} can_manage={can_manage} />}
      {tab === 'order' && <OrderTab can_manage={can_manage} onSaleChange={product.reload} />}
    </>
  )
}

// ---- counter --------------------------------------------------------------

type CartLine = { variant_id: string; quantity_count: number }

function Counter({
  product,
  can_manage,
  onGoProduct,
}: {
  product: ReturnType<typeof useResource<ShopProduct[]>>
  can_manage: boolean
  onGoProduct: () => void
}) {
  return (
    <ResourceView resource={product}>
      {(list) => {
        const active = list.filter((one) => one.is_active && one.variant.length > 0)
        if (active.length === 0) {
          return (
            <EmptyState
              title="Nothing to sell yet"
              description="Add your first product — a paddle, a ball pack, or a drink — and it appears here as a tap-to-add tile."
              action={<Button onClick={onGoProduct}>Go to products</Button>}
            />
          )
        }
        return <CounterBody product={active} can_manage={can_manage} onSold={product.reload} />
      }}
    </ResourceView>
  )
}

function CounterBody({ product, can_manage, onSold }: { product: ShopProduct[]; can_manage: boolean; onSold: () => void }) {
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState<string>('')
  const [cart, setCart] = useState<CartLine[]>([])
  const [method, setMethod] = useState<PaymentMethodCode>('cash')
  const [tendered, setTendered] = useState('')
  const [reference, setReference] = useState('')
  const [is_pickup_later, setPickupLater] = useState(false)
  const [key, setKey] = useState(newKey)
  const [receipt, setReceipt] = useState<Receipt>()

  const category_list = useMemo(() => [...new Set(product.map((one) => one.category_name))], [product])

  const variant_index = useMemo(() => {
    const index = new Map<string, { product: ShopProduct; variant: ShopVariant }>()
    for (const one of product) for (const variant of one.variant) index.set(variant.variant_id, { product: one, variant })
    return index
  }, [product])

  const visible = product.filter((one) => {
    if (category && one.category_name !== category) return false
    const needle = search.trim().toLowerCase()
    if (!needle) return true
    return (
      one.name.toLowerCase().includes(needle) ||
      one.variant.some((variant) => variant.name.toLowerCase().includes(needle) || (variant.sku ?? '').toLowerCase().includes(needle))
    )
  })

  const inCart = (variant_id: string) => cart.find((one) => one.variant_id === variant_id)?.quantity_count ?? 0

  const maxFor = (variant: ShopVariant) => (variant.stock_on_hand_count === null ? Infinity : variant.stock_on_hand_count)

  function add(variant: ShopVariant) {
    setReceipt(undefined)
    setCart((current) => {
      const existing = current.find((one) => one.variant_id === variant.variant_id)
      if (existing) {
        if (existing.quantity_count >= maxFor(variant)) return current
        return current.map((one) => (one.variant_id === variant.variant_id ? { ...one, quantity_count: one.quantity_count + 1 } : one))
      }
      return [...current, { variant_id: variant.variant_id, quantity_count: 1 }]
    })
  }

  function step(variant_id: string, delta: number) {
    setCart((current) =>
      current
        .map((one) => {
          if (one.variant_id !== variant_id) return one
          const entry = variant_index.get(variant_id)
          const max = entry ? maxFor(entry.variant) : Infinity
          return { ...one, quantity_count: Math.min(one.quantity_count + delta, max) }
        })
        .filter((one) => one.quantity_count > 0),
    )
  }

  const total_centavo = cart.reduce((sum, one) => {
    const entry = variant_index.get(one.variant_id)
    return sum + (entry ? (toCentavo(entry.variant.price_amount) ?? 0) * one.quantity_count : 0)
  }, 0)
  const tendered_centavo = toCentavo(tendered)
  const change_centavo = tendered_centavo === undefined ? undefined : tendered_centavo - total_centavo
  const is_ready =
    cart.length > 0 && total_centavo > 0 && (method !== 'cash' || (change_centavo !== undefined && change_centavo >= 0))

  const sale = useAction(async () => {
    const result = await operatorFetch<{ receipt: Receipt }>(
      '/api/v1/shop/counter-sale',
      jsonBody({
        idempotency_key: key,
        line: cart,
        is_pickup_later,
        payment: {
          method,
          ...(method === 'cash' ? { tendered_amount: tendered } : {}),
          ...(method !== 'cash' && reference.trim() ? { reference: reference.trim() } : {}),
        },
      }),
    )
    setReceipt(result.receipt)
    setCart([])
    setTendered('')
    setReference('')
    setPickupLater(false)
    setKey(newKey())
    onSold()
    return result.receipt
  })

  return (
    <div className="split shop-counter">
      <section className="stack" aria-label="Products">
        <TextInput
          label="Find a product"
          type="search"
          placeholder="Paddle, balls, water…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <div className="shop-chip-row" role="group" aria-label="Category">
          <button type="button" className="shop-chip" aria-pressed={category === ''} onClick={() => setCategory('')}>
            All
          </button>
          {category_list.map((one) => (
            <button key={one} type="button" className="shop-chip" aria-pressed={category === one} onClick={() => setCategory(one)}>
              {one}
            </button>
          ))}
        </div>
        {visible.length === 0 ? (
          <EmptyState title="No product matches" description="Try another word or pick All." />
        ) : (
          <div className="shop-tile-grid">
            {visible.flatMap((one) =>
              one.variant.map((variant) => {
                const is_out = variant.stock_status_code === 'out'
                const is_capped = inCart(variant.variant_id) >= maxFor(variant)
                const badge = STOCK_BADGE[variant.stock_status_code]
                return (
                  <button
                    key={variant.variant_id}
                    type="button"
                    className="shop-tile"
                    disabled={!can_manage || is_out || is_capped}
                    onClick={() => add(variant)}
                    aria-label={`Add ${variantLabel(one, variant)}, ${formatMoney(variant.price_amount)}${is_out ? ', sold out' : ''}`}
                  >
                    <span className="shop-tile__name">{one.name}</span>
                    {one.variant.length > 1 && <span className="shop-tile__variant">{variant.name}</span>}
                    <span className="shop-tile__foot">
                      <span className="shop-tile__price">{formatMoney(variant.price_amount)}</span>
                      {variant.stock_status_code === 'untracked' ? null : (
                        <Badge tone={badge.tone}>
                          {is_out ? 'Sold out' : `${badge.label} · ${variant.stock_on_hand_count}`}
                        </Badge>
                      )}
                    </span>
                  </button>
                )
              }),
            )}
          </div>
        )}
      </section>

      <aside className="shop-cart" aria-label="Current sale">
        <Card title="Current sale">
          {receipt && (
            <Alert severity="success" title={`Sale complete · ${receipt.order_code}`} onDismiss={() => setReceipt(undefined)}>
              <ul className="shop-receipt">
                {receipt.line.map((one) => (
                  <li key={one.description}>
                    <span>
                      {one.quantity_count} × {one.description}
                    </span>
                    <span>{formatMoney(one.line_amount)}</span>
                  </li>
                ))}
                <li>
                  <strong>Total</strong>
                  <strong>{formatMoney(receipt.total_amount)}</strong>
                </li>
                <li>
                  <span>Paid by {METHOD_LABEL[receipt.payment_method_code]}</span>
                  <span>{receipt.tendered_amount ? formatMoney(receipt.tendered_amount) : ''}</span>
                </li>
                {receipt.payment_method_code === 'cash' && (
                  <li>
                    <strong>Change due</strong>
                    <strong>{formatMoney(receipt.change_amount)}</strong>
                  </li>
                )}
                {receipt.pickup_status_code === 'waiting' && <li>Set aside for pickup — see Orders.</li>}
              </ul>
            </Alert>
          )}

          {cart.length === 0 ? (
            <p className="muted">Tap a product to add it to the sale.</p>
          ) : (
            <ul className="shop-cart__list">
              {cart.map((one) => {
                const entry = variant_index.get(one.variant_id)
                if (!entry) return null
                const label = variantLabel(entry.product, entry.variant)
                const price = toCentavo(entry.variant.price_amount) ?? 0
                return (
                  <li key={one.variant_id} className="shop-cart__line">
                    <div>
                      <div>{label}</div>
                      <div className="muted">{formatMoney(entry.variant.price_amount)} each</div>
                    </div>
                    <div className="shop-cart__amount">{formatMoney(fromCentavo(price * one.quantity_count))}</div>
                    <div className="shop-stepper">
                      <Button tone="secondary" size="sm" aria-label={`One fewer ${label}`} onClick={() => step(one.variant_id, -1)} icon={<Minus size={14} aria-hidden />} />
                      <span className="shop-stepper__count" aria-live="polite">
                        {one.quantity_count}
                      </span>
                      <Button
                        tone="secondary"
                        size="sm"
                        aria-label={`One more ${label}`}
                        disabled={one.quantity_count >= maxFor(entry.variant)}
                        onClick={() => step(one.variant_id, 1)}
                        icon={<Plus size={14} aria-hidden />}
                      />
                    </div>
                    <Button tone="quiet" size="sm" aria-label={`Remove ${label}`} onClick={() => step(one.variant_id, -one.quantity_count)} icon={<Trash size={14} aria-hidden />}>
                      Remove
                    </Button>
                  </li>
                )
              })}
            </ul>
          )}

          <div className="shop-cart__total">
            <span>Total</span>
            <strong>{formatMoney(fromCentavo(total_centavo))}</strong>
          </div>

          <div className="stack">
            <div className="shop-segment" role="group" aria-label="Payment method">
              {(Object.keys(METHOD_LABEL) as PaymentMethodCode[]).map((one) => (
                <Button key={one} tone={method === one ? 'primary' : 'secondary'} size="sm" aria-pressed={method === one} onClick={() => setMethod(one)}>
                  {METHOD_LABEL[one]}
                </Button>
              ))}
            </div>
            {method === 'cash' ? (
              <>
                <TextInput
                  label="Cash tendered (₱)"
                  inputMode="decimal"
                  placeholder={fromCentavo(total_centavo)}
                  value={tendered}
                  onChange={(event) => setTendered(event.target.value)}
                />
                {change_centavo !== undefined && cart.length > 0 && (
                  <div className={`shop-change ${change_centavo < 0 ? 'shop-change--short' : ''}`} aria-live="polite">
                    <span>{change_centavo < 0 ? 'Still short' : 'Change due'}</span>
                    <span>{formatMoney(fromCentavo(Math.abs(change_centavo)))}</span>
                  </div>
                )}
              </>
            ) : (
              <TextInput
                label={method === 'gcash' ? 'GCash reference number' : 'Terminal approval code'}
                hint="Optional, but it makes refunds and end-of-day checks easier."
                value={reference}
                onChange={(event) => setReference(event.target.value)}
              />
            )}
            <Checkbox label="Customer will pick it up later" checked={is_pickup_later} onChange={(event) => setPickupLater(event.target.checked)} />
            <ErrorAlert error={sale.error} onDismiss={sale.clearError} />
            {!can_manage && <p className="muted">Your role can see the shop but not ring up sales.</p>}
            <Button size="lg" disabled={!can_manage || !is_ready || sale.is_pending} onClick={() => void sale.run()}>
              {sale.is_pending ? 'Completing…' : `Complete sale · ${formatMoney(fromCentavo(total_centavo))}`}
            </Button>
          </div>
        </Card>
      </aside>
    </div>
  )
}

// ---- products -------------------------------------------------------------

function ProductTab({ product, can_manage }: { product: ReturnType<typeof useResource<ShopProduct[]>>; can_manage: boolean }) {
  const [is_creating, setCreating] = useState(false)
  const [adjusting, setAdjusting] = useState<{ product: ShopProduct; variant: ShopVariant }>()
  const [notice, setNotice] = useState<string>()

  const toggle = useAction(async (one: ShopProduct) => {
    await operatorFetch(`/api/v1/shop/product/${one.catalog_id}`, jsonBody({ is_active: !one.is_active }, 'PATCH'))
    setNotice(one.is_active ? `${one.name} is hidden from the counter and the public catalog.` : `${one.name} is back on sale.`)
    product.reload()
  })

  return (
    <div className="stack">
      <Toolbar>
        {can_manage && (
          <Button icon={<Plus size={16} aria-hidden />} onClick={() => setCreating(true)}>
            New product
          </Button>
        )}
      </Toolbar>
      {notice && (
        <Alert severity="success" onDismiss={() => setNotice(undefined)}>
          {notice}
        </Alert>
      )}
      <ErrorAlert error={toggle.error} onDismiss={toggle.clearError} />
      <ResourceView resource={product}>
        {(list) =>
          list.length === 0 ? (
            <EmptyState
              title="No products yet"
              description="Add what you sell at the counter. Stock you enter here is what the counter and public catalog read."
              action={can_manage ? <Button onClick={() => setCreating(true)}>New product</Button> : undefined}
            />
          ) : (
            <div className="table-wrap" tabIndex={0}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Variant</th>
                    <th className="number">Price</th>
                    <th className="number">On hand</th>
                    <th>Stock</th>
                    <th>
                      <span className="visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.flatMap((one) =>
                    one.variant.map((variant, index) => {
                      const badge = STOCK_BADGE[variant.stock_status_code]
                      return (
                        <tr key={variant.variant_id}>
                          <td>
                            {index === 0 && (
                              <div className="stack" style={{ gap: 'var(--space-1)' }}>
                                <strong>{one.name}</strong>
                                <div className="row">
                                  <Badge>{one.category_name}</Badge>
                                  {!one.is_active && <Badge tone="neutral">Hidden</Badge>}
                                </div>
                              </div>
                            )}
                          </td>
                          <td>
                            {variant.name}
                            {variant.sku && <div className="muted mono">{variant.sku}</div>}
                          </td>
                          <td className="number">{formatMoney(variant.price_amount)}</td>
                          <td className="number">{variant.stock_on_hand_count ?? '—'}</td>
                          <td>
                            <Badge tone={badge.tone}>{badge.label}</Badge>
                          </td>
                          <td>
                            <div className="row">
                              {can_manage && one.is_track_inventory && (
                                <Button tone="secondary" size="sm" onClick={() => setAdjusting({ product: one, variant })}>
                                  Adjust stock
                                </Button>
                              )}
                              {can_manage && index === 0 && (
                                <Button tone="quiet" size="sm" disabled={toggle.is_pending} onClick={() => void toggle.run(one)}>
                                  {one.is_active ? 'Hide' : 'Put on sale'}
                                </Button>
                              )}
                            </div>
                          </td>
                        </tr>
                      )
                    }),
                  )}
                </tbody>
              </table>
            </div>
          )
        }
      </ResourceView>
      {is_creating && (
        <NewProductDialog
          onClose={() => setCreating(false)}
          onCreated={(name) => {
            setCreating(false)
            setNotice(`${name} added. It is on the counter now.`)
            product.reload()
          }}
        />
      )}
      {adjusting && (
        <AdjustStockDialog
          product={adjusting.product}
          variant={adjusting.variant}
          onClose={() => setAdjusting(undefined)}
          onDone={(message) => {
            setAdjusting(undefined)
            setNotice(message)
            product.reload()
          }}
        />
      )}
    </div>
  )
}

type VariantDraft = { name: string; sku: string; price_amount: string; opening_stock_count: string }

function NewProductDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (name: string) => void }) {
  const [name, setName] = useState('')
  const [category, setCategory] = useState('')
  const [description, setDescription] = useState('')
  const [threshold, setThreshold] = useState('3')
  const [is_track_inventory, setTrack] = useState(true)
  const [variant, setVariant] = useState<VariantDraft[]>([{ name: '', sku: '', price_amount: '', opening_stock_count: '0' }])

  const create = useAction(async () => {
    await operatorFetch(
      '/api/v1/shop/product',
      jsonBody({
        name,
        category,
        description,
        is_track_inventory,
        low_stock_threshold_count: Number(threshold || '0'),
        variant: variant.map((one) => ({
          name: one.name || undefined,
          sku: one.sku || undefined,
          price_amount: one.price_amount,
          opening_stock_count: is_track_inventory ? Number(one.opening_stock_count || '0') : undefined,
        })),
      }),
    )
    onCreated(name)
  })

  const update = (index: number, patch: Partial<VariantDraft>) =>
    setVariant((current) => current.map((one, each) => (each === index ? { ...one, ...patch } : one)))

  return (
    <Dialog
      open
      title="New product"
      onClose={onClose}
      footer={
        <>
          <Button tone="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={create.is_pending || !name.trim() || variant.some((one) => toCentavo(one.price_amount) === undefined)} onClick={() => void create.run()}>
            {create.is_pending ? 'Adding…' : 'Add product'}
          </Button>
        </>
      }
    >
      <form className="form" onSubmit={(event) => event.preventDefault()}>
        <TextInput label="Product name" required value={name} onChange={(event) => setName(event.target.value)} placeholder="Franklin X-40 balls 3-pack" />
        <div className="form__row">
          <TextInput label="Category" value={category} onChange={(event) => setCategory(event.target.value)} placeholder="Balls" />
          <TextInput
            label="Low stock at"
            hint="Warn when a variant is at or below this many."
            type="number"
            min={0}
            value={threshold}
            disabled={!is_track_inventory}
            onChange={(event) => setThreshold(event.target.value)}
          />
        </div>
        <TextArea label="Description (shown on the public catalog)" rows={2} value={description} onChange={(event) => setDescription(event.target.value)} />
        <Checkbox label="Track stock (turn off for rentals and services)" checked={is_track_inventory} onChange={(event) => setTrack(event.target.checked)} />
        <fieldset className="stack" style={{ border: 0, margin: 0, padding: 0 }}>
          <legend className="field__label">Variants</legend>
          {variant.map((one, index) => (
            <div key={index} className="shop-variant-row">
              <TextInput label={`Variant ${index + 1} name`} value={one.name} placeholder={variant.length === 1 ? 'Standard' : 'Blue'} onChange={(event) => update(index, { name: event.target.value })} />
              <TextInput label="SKU" value={one.sku} onChange={(event) => update(index, { sku: event.target.value })} />
              <TextInput label="Price (₱)" inputMode="decimal" required value={one.price_amount} onChange={(event) => update(index, { price_amount: event.target.value })} />
              {is_track_inventory && (
                <TextInput label="Opening stock" type="number" min={0} value={one.opening_stock_count} onChange={(event) => update(index, { opening_stock_count: event.target.value })} />
              )}
              {variant.length > 1 && (
                <Button tone="quiet" size="sm" onClick={() => setVariant((current) => current.filter((_, each) => each !== index))}>
                  Remove variant
                </Button>
              )}
            </div>
          ))}
          <div>
            <Button tone="secondary" size="sm" icon={<Plus size={14} aria-hidden />} onClick={() => setVariant((current) => [...current, { name: '', sku: '', price_amount: '', opening_stock_count: '0' }])}>
              Add a variant
            </Button>
          </div>
        </fieldset>
        <ErrorAlert error={create.error} onDismiss={create.clearError} />
      </form>
    </Dialog>
  )
}

const ADJUST_REASON = ['Delivery received', 'Stock count correction', 'Damaged or expired', 'Used for demo or staff', 'Other']

function AdjustStockDialog({
  product,
  variant,
  onClose,
  onDone,
}: {
  product: ShopProduct
  variant: ShopVariant
  onClose: () => void
  onDone: (message: string) => void
}) {
  const [direction, setDirection] = useState<'add' | 'remove'>('add')
  const [count, setCount] = useState('1')
  const [reason, setReason] = useState(ADJUST_REASON[0]!)
  const [note, setNote] = useState('')
  const label = variantLabel(product, variant)
  const amount = Number.parseInt(count, 10)
  const delta_count = Number.isFinite(amount) ? (direction === 'add' ? amount : -amount) : 0
  const on_hand = variant.stock_on_hand_count ?? 0

  const adjust = useAction(async () => {
    const full_reason = reason === 'Other' || note.trim() ? [reason === 'Other' ? '' : reason, note.trim()].filter(Boolean).join(' — ') : reason
    const result = await operatorFetch<{ stock: { stock_on_hand_count: number } }>(
      `/api/v1/shop/variant/${variant.variant_id}/stock`,
      jsonBody({ delta_count, reason: full_reason }),
    )
    onDone(`${label}: ${on_hand} → ${result.stock.stock_on_hand_count} on hand.`)
  })

  return (
    <Dialog
      open
      title={`Adjust stock · ${label}`}
      onClose={onClose}
      footer={
        <>
          <Button tone="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={adjust.is_pending || !(amount > 0) || on_hand + delta_count < 0 || (reason === 'Other' && !note.trim())}
            onClick={() => void adjust.run()}
          >
            {adjust.is_pending ? 'Saving…' : 'Save adjustment'}
          </Button>
        </>
      }
    >
      <p>
        {on_hand} on hand now. After this: <strong>{Math.max(on_hand + delta_count, 0)}</strong>
      </p>
      <div className="form__row">
        <SelectInput
          label="Change"
          value={direction}
          onChange={(event) => setDirection(event.target.value as 'add' | 'remove')}
          option={[
            { value: 'add', label: 'Add units' },
            { value: 'remove', label: 'Remove units' },
          ]}
        />
        <TextInput label="How many" type="number" min={1} value={count} onChange={(event) => setCount(event.target.value)} />
      </div>
      {on_hand + delta_count < 0 && <Alert severity="caution">You can remove at most {on_hand}.</Alert>}
      <SelectInput label="Reason" value={reason} onChange={(event) => setReason(event.target.value)} option={ADJUST_REASON.map((one) => ({ value: one, label: one }))} />
      <TextInput label={reason === 'Other' ? 'Describe the reason' : 'Note (optional)'} value={note} onChange={(event) => setNote(event.target.value)} />
      <ErrorAlert error={adjust.error} onDismiss={adjust.clearError} />
    </Dialog>
  )
}

// ---- orders ---------------------------------------------------------------

type OrderFilter = '' | 'open' | 'ready' | 'picked_up' | 'refunded'

function OrderTab({ can_manage, onSaleChange }: { can_manage: boolean; onSaleChange: () => void }) {
  const [filter, setFilter] = useState<OrderFilter>('')
  const order = useResource(
    () => operatorFetch<{ order: ShopOrder[] }>(`/api/v1/shop/order${filter ? `?status=${filter}` : ''}`).then((result) => result.order),
    [filter],
  )
  const [refunding, setRefunding] = useState<ShopOrder>()
  const [notice, setNotice] = useState<string>()

  const pickup = useAction(async (one: ShopOrder, next: 'ready' | 'picked-up') => {
    await operatorFetch(`/api/v1/shop/order/${one.sales_order_id}/${next}`, { method: 'POST' })
    setNotice(next === 'ready' ? `${one.order_code} is ready at the counter.` : `${one.order_code} has been picked up.`)
    order.reload()
  })

  return (
    <div className="stack">
      <Toolbar>
        <SelectInput
          label="Show"
          value={filter}
          onChange={(event) => setFilter(event.target.value as OrderFilter)}
          option={[
            { value: '', label: 'All orders' },
            { value: 'open', label: 'Waiting or ready for pickup' },
            { value: 'ready', label: 'Ready at counter' },
            { value: 'picked_up', label: 'Picked up' },
            { value: 'refunded', label: 'Refunded' },
          ]}
        />
      </Toolbar>
      {notice && (
        <Alert severity="success" onDismiss={() => setNotice(undefined)}>
          {notice}
        </Alert>
      )}
      <ErrorAlert error={pickup.error} onDismiss={pickup.clearError} />
      <ResourceView resource={order}>
        {(list) =>
          list.length === 0 ? (
            <EmptyState
              title={filter ? 'No orders in this view' : 'No sales yet'}
              description={filter ? 'Pick another filter to see more.' : 'Sales rung up on the Counter tab appear here with their payment and pickup state.'}
            />
          ) : (
            <div className="table-wrap" tabIndex={0}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Items</th>
                    <th className="number">Total</th>
                    <th>Payment</th>
                    <th>Status</th>
                    <th>
                      <span className="visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((one) => {
                    const badge = ORDER_BADGE[one.status_code]
                    return (
                      <tr key={one.sales_order_id}>
                        <td>
                          <strong className="mono">{one.order_code}</strong>
                          <div className="muted">{formatDateTime(one.placed_at)}</div>
                        </td>
                        <td>
                          {one.line.map((line) => (
                            <div key={line.description}>
                              {line.quantity_count} × {line.description}
                            </div>
                          ))}
                        </td>
                        <td className="number">
                          {formatMoney(one.total_amount)}
                          {one.refunded_amount !== '0.00' && <div className="muted">−{formatMoney(one.refunded_amount)} refunded</div>}
                        </td>
                        <td>
                          {one.payment_method_code ? METHOD_LABEL[one.payment_method_code] : '—'}
                          {one.payment_reference && <div className="muted mono">{one.payment_reference}</div>}
                        </td>
                        <td>
                          <div className="row">
                            <Badge tone={badge.tone}>{badge.label}</Badge>
                            {one.is_restocked && <Badge tone="info">Restocked</Badge>}
                          </div>
                        </td>
                        <td>
                          {can_manage && (
                            <div className="row">
                              {one.status_code === 'waiting' && (
                                <Button tone="secondary" size="sm" disabled={pickup.is_pending} onClick={() => void pickup.run(one, 'ready')}>
                                  Ready
                                </Button>
                              )}
                              {(one.status_code === 'waiting' || one.status_code === 'ready') && (
                                <Button size="sm" disabled={pickup.is_pending} onClick={() => void pickup.run(one, 'picked-up')}>
                                  Picked up
                                </Button>
                              )}
                              {one.is_counter_sale && one.refundable_amount !== '0.00' && (
                                <Button tone="quiet" size="sm" onClick={() => setRefunding(one)}>
                                  Refund
                                </Button>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )
        }
      </ResourceView>
      {refunding && (
        <RefundDialog
          order={refunding}
          onClose={() => setRefunding(undefined)}
          onDone={(message) => {
            setRefunding(undefined)
            setNotice(message)
            order.reload()
            onSaleChange()
          }}
        />
      )}
    </div>
  )
}

function RefundDialog({ order, onClose, onDone }: { order: ShopOrder; onClose: () => void; onDone: (message: string) => void }) {
  const [amount, setAmount] = useState(order.refundable_amount)
  const [reason, setReason] = useState('')
  const [is_restock, setRestock] = useState(!order.is_restocked)
  const [key] = useState(newKey)
  const amount_centavo = toCentavo(amount)
  const max_centavo = toCentavo(order.refundable_amount) ?? 0
  const is_valid = amount_centavo !== undefined && amount_centavo > 0 && amount_centavo <= max_centavo && reason.trim() !== ''

  const refund = useAction(async () => {
    await operatorFetch(
      `/api/v1/shop/order/${order.sales_order_id}/refund`,
      jsonBody({ amount, reason, is_restock: is_restock && !order.is_restocked, idempotency_key: key }),
    )
    onDone(
      `Refunded ${formatMoney(amount)} on ${order.order_code}${is_restock && !order.is_restocked ? ' and returned the items to stock' : ''}.`,
    )
  })

  return (
    <Dialog
      open
      title={`Refund ${order.order_code}`}
      onClose={onClose}
      footer={
        <>
          <Button tone="secondary" onClick={onClose}>
            Keep the sale
          </Button>
          <Button tone="danger" disabled={!is_valid || refund.is_pending} onClick={() => void refund.run()}>
            {refund.is_pending ? 'Refunding…' : `Refund ${amount_centavo !== undefined ? formatMoney(amount) : ''}`}
          </Button>
        </>
      }
    >
      <p>
        Paid {formatMoney(order.paid_amount)}
        {order.refunded_amount !== '0.00' && <>, already refunded {formatMoney(order.refunded_amount)}</>}. You can refund up to{' '}
        <strong>{formatMoney(order.refundable_amount)}</strong>
        {order.payment_method_code ? ` — hand it back by ${METHOD_LABEL[order.payment_method_code]}.` : '.'}
      </p>
      <TextInput
        label="Refund amount (₱)"
        inputMode="decimal"
        value={amount}
        onChange={(event) => setAmount(event.target.value)}
        error={amount_centavo !== undefined && amount_centavo > max_centavo ? `At most ${formatMoney(order.refundable_amount)}` : undefined}
      />
      <TextInput label="Reason" required value={reason} placeholder="Wrong grip size, returned unopened" onChange={(event) => setReason(event.target.value)} />
      <Checkbox
        label={order.is_restocked ? 'Items were already returned to stock' : 'Return the items to stock'}
        checked={is_restock && !order.is_restocked}
        disabled={order.is_restocked}
        onChange={(event) => setRestock(event.target.checked)}
      />
      <Alert severity="caution">A refund cannot be undone.</Alert>
      <ErrorAlert error={refund.error} onDismiss={refund.clearError} />
    </Dialog>
  )
}
