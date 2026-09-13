// shop — R14 commerce and inventory surface.
//
// Operator conveniences over the commerce + billing packs under /api/v1/shop,
// and the public catalog the commerce pack does not serve (K110) under
// /public/:organization_code/shop/catalog.

import {
  authorize,
  type KernelApp,
  type ModuleDeclaration,
  type RouteContributor,
  type Store,
} from '@bygelo/roundrobin-kernel'
import { withPublicTenant } from '../../public.ts'
import { atomic } from './atomic.ts'
import {
  adjustStock,
  counterSale,
  createProduct,
  findShopOrder,
  listProduct,
  listShopOrder,
  readPublicCatalog,
  refundShopOrder,
  setPickupStatus,
  updateProduct,
} from './service.ts'

export const SHOP_MODULE: ModuleDeclaration = {
  module_code: 'shop',
  package_code: 'court',
  display_name: 'Shop',
  schema_version: 1,
  is_removable: true,
  depend_on: ['commerce'],
  capability: [
    { capability_code: 'shop.read', description: 'See shop' },
    { capability_code: 'shop.manage', description: 'Change shop' },
  ],
  route_prefix: ['/api/v1/shop'],
}

async function readBody(request: { json: () => Promise<unknown> }): Promise<Record<string, unknown>> {
  try {
    const body = await request.json()
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export function createShopRoute(store: Store): RouteContributor {
  return (app: KernelApp) => {
    // ---- public ------------------------------------------------------------
    app.get('/public/:organization_code/shop/catalog', async (context) => {
      const catalog = await withPublicTenant(store, context.req.param('organization_code'), ['shop', 'commerce'], (tenant) =>
        readPublicCatalog(tenant),
      )
      if (!catalog) return context.json({ error: 'not found' }, 404)
      return context.json(catalog)
    })

    // ---- operator: product ------------------------------------------------
    app.get('/api/v1/shop/product', async (context) => {
      authorize(context.get('session'), 'shop.read')
      return context.json({ product: await listProduct(context.get('tenant')) })
    })

    app.post('/api/v1/shop/product', async (context) => {
      const session = context.get('session')
      authorize(session, 'shop.manage')
      const body = await readBody(context.req)
      const product = await atomic(context.get('tenant'), (tenant) => createProduct(tenant, body as never, session.actor_id))
      return context.json({ product }, 201)
    })

    app.patch('/api/v1/shop/product/:catalog_id', async (context) => {
      authorize(context.get('session'), 'shop.manage')
      const body = await readBody(context.req)
      const product = await atomic(context.get('tenant'), (tenant) => updateProduct(tenant, context.req.param('catalog_id'), body))
      return context.json({ product })
    })

    app.post('/api/v1/shop/variant/:variant_id/stock', async (context) => {
      const session = context.get('session')
      authorize(session, 'shop.manage')
      const body = await readBody(context.req)
      const stock = await atomic(context.get('tenant'), (tenant) =>
        adjustStock(tenant, context.req.param('variant_id'), body, session.actor_id),
      )
      return context.json({ stock })
    })

    // ---- operator: sale + order -------------------------------------------
    app.post('/api/v1/shop/counter-sale', async (context) => {
      const session = context.get('session')
      authorize(session, 'shop.manage')
      const body = await readBody(context.req)
      // A refused sale (sold out, short tender) must leave no placed order behind.
      const receipt = await atomic(context.get('tenant'), (tenant) => counterSale(tenant, body, session.actor_id))
      return context.json({ receipt }, 201)
    })

    app.get('/api/v1/shop/order', async (context) => {
      authorize(context.get('session'), 'shop.read')
      const order = await listShopOrder(context.get('tenant'), { status: context.req.query('status') || undefined })
      return context.json({ order })
    })

    app.get('/api/v1/shop/order/:sales_order_id', async (context) => {
      authorize(context.get('session'), 'shop.read')
      return context.json({ order: await findShopOrder(context.get('tenant'), context.req.param('sales_order_id')) })
    })

    app.post('/api/v1/shop/order/:sales_order_id/ready', async (context) => {
      authorize(context.get('session'), 'shop.manage')
      const order = await atomic(context.get('tenant'), (tenant) =>
        setPickupStatus(tenant, context.req.param('sales_order_id'), 'ready'),
      )
      return context.json({ order })
    })

    app.post('/api/v1/shop/order/:sales_order_id/picked-up', async (context) => {
      authorize(context.get('session'), 'shop.manage')
      const order = await atomic(context.get('tenant'), (tenant) =>
        setPickupStatus(tenant, context.req.param('sales_order_id'), 'picked_up'),
      )
      return context.json({ order })
    })

    app.post('/api/v1/shop/order/:sales_order_id/refund', async (context) => {
      const session = context.get('session')
      authorize(session, 'shop.manage')
      const body = await readBody(context.req)
      const result = await atomic(context.get('tenant'), (tenant) =>
        refundShopOrder(tenant, context.req.param('sales_order_id'), body, session.actor_id),
      )
      return context.json(result)
    })
  }
}
