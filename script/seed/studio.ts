// Seed step for the studio module: publish version 1 of the demo venue's site.
//
// Idempotent — once the venue has a publication, re-running changes nothing and
// never appends another version.

import type { Uuid } from '@bygelo/roundrobin-kernel'
import { publishDraft } from '../../src/module/studio/service.ts'
import type { StudioDocument } from '../../src/module/studio/schema.ts'
import type { SeedContext } from './context.ts'

export async function seedStudio({ tenant, organization_id }: SeedContext): Promise<void> {
  const [existing] = await tenant.query<{ organization_id: Uuid }[]>`
    SELECT organization_id FROM studio_publication WHERE organization_id = ${organization_id}`
  if (existing) return

  const [actor] = await tenant.query<{ actor_id: Uuid }[]>`
    SELECT actor_id FROM actor WHERE organization_id = ${organization_id} AND actor_code = 'operator'`
  const court = await tenant.query<{ resource_id: Uuid }[]>`
    SELECT r.resource_id
    FROM resource r
    JOIN site s ON s.site_id = r.site_id
    WHERE s.organization_id = ${organization_id} AND r.deleted_at IS NULL
    ORDER BY r.sort_order, r.display_name`

  const document: StudioDocument = {
    template_code: 'club',
    display_name: 'Sideout Pickleball Club',
    tagline: 'Pickleball courts in Quezon City',
    // #d32522 on white is 5.2:1, above the 4.5:1 Studio requires.
    token: { accent: '#123fbd', action: '#d32522', heading_font: 'Space Grotesk', radius: 'round' },
    content: {
      hero_title: 'Book a pickleball court tonight',
      hero_body:
        'Four indoor courts, open play every evening, and paddles at the counter. Reserve in under a minute.',
      address: 'Katipunan Ave, Quezon City',
      contact: 'hello@sideout.ph · 0917 555 0142',
    },
    nav: [
      { nav_code: 'book', label: 'Book', is_included: true },
      { nav_code: 'program', label: 'Programs', is_included: true },
      { nav_code: 'play', label: 'Open play', is_included: true },
      { nav_code: 'shop', label: 'Shop', is_included: true },
    ],
    court_order: court.map((one) => one.resource_id),
  }

  await publishDraft(tenant, actor?.actor_id ?? null, document)
}
