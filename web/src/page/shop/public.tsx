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
              {data.category.map((category) => (
                <section key={category.category_name} className="shop-catalog__section" aria-labelledby={`shop-${category.category_name}`}>
                  <h2 id={`shop-${category.category_name}`}>{category.category_name}</h2>
                  <div className="grid">
                    {category.product.map((product) => (
                      <Card key={product.catalog_code} className="shop-catalog__card">
                        <div className="stack" style={{ gap: 'var(--space-2)' }}>
                          <h3>{product.name}</h3>
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
                    ))}
                  </div>
                </section>
              ))}
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
