// Public venue site → Shop: what the pro shop carries, what it costs, and
// whether it is on the shelf today. No online checkout — players pick it up
// and pay at the counter, and the page says so plainly.

import { Storefront } from '@phosphor-icons/react'
import { ApiError, publicFetch } from '../../api.ts'
import { Badge, Card, EmptyState, PageHeader, ResourceView } from '../../component/ui.tsx'
import { formatMoney } from '../../format.ts'
import { useResource } from '../../hook.ts'
import { usePublicSite } from '../../layout/public-shell.tsx'
import type { PageProp } from '../../registry.ts'
import './shop.css'

type PublicCatalog = {
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

export default function Page({ param }: PageProp) {
  const site = usePublicSite()
  const organization_code = param['organization_code'] ?? site.organization_code
  const catalog = useResource(
    () =>
      publicFetch<PublicCatalog>(`/public/${encodeURIComponent(organization_code)}/shop/catalog`).catch((error: unknown) => {
        // The shop being switched off is a normal state, not a failure.
        if (error instanceof ApiError && error.status === 404) return { category: [] } as PublicCatalog
        throw error
      }),
    [organization_code],
  )

  return (
    <div className="stack--lg">
      <PageHeader
        eyebrow={site.display_name}
        title="Pro shop"
        description="Paddles, balls, grips and cold drinks. Pick it up at the counter — pay by cash, GCash, or card when you arrive."
      />
      <ResourceView resource={catalog}>
        {(data) =>
          data.category.length === 0 ? (
            <EmptyState
              title="The shop shelf is empty right now"
              description="Ask at the front desk when you come in to play — we can tell you what’s arriving."
            />
          ) : (
            <>
              {/* One flowing grid, ordered by category, each card labelled with
                  its category: a venue shop has a handful of items per shelf,
                  and a section per shelf left one narrow card beside empty space. */}
              <ul className="grid shop-catalog__grid" aria-label="Products" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {data.category.flatMap((category) =>
                    category.product.map((product) => (
                      <li key={product.catalog_code}>
                      <Card className="shop-catalog__card">
                        <div className="stack" style={{ gap: 'var(--space-2)' }}>
                          <p className="eyebrow">{category.category_name}</p>
                          <h2 className="card__title">{product.name}</h2>
                          {product.description && <p className="muted">{product.description}</p>}
                        </div>
                        <p className="shop-catalog__price">
                          {product.price_min_amount === product.price_max_amount
                            ? formatMoney(product.price_min_amount)
                            : `${formatMoney(product.price_min_amount)} – ${formatMoney(product.price_max_amount)}`}
                        </p>
                        {product.variant.length > 1 && (
                          <ul className="shop-catalog__variant" aria-label={`${product.name} options`}>
                            {product.variant.map((variant) => (
                              <li key={variant.variant_code} className={variant.is_in_stock ? '' : 'is-sold-out'}>
                                <span>
                                  {variant.name}
                                  {!variant.is_in_stock && <span className="visually-hidden"> (sold out)</span>}
                                </span>
                                <span>{formatMoney(variant.price_amount)}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                        <div>
                          {product.is_in_stock ? (
                            <Badge tone="success">In stock at the counter</Badge>
                          ) : (
                            <Badge tone="neutral">Sold out</Badge>
                          )}
                        </div>
                      </Card>
                      </li>
                    )),
                )}
              </ul>
              <p className="row muted">
                <Storefront size={20} aria-hidden />
                No online checkout — pick it up at the counter and pay there.
              </p>
            </>
          )
        }
      </ResourceView>
    </div>
  )
}
