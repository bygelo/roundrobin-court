// The published venue site: what GET /public/:organization_code/site returns.
//
// Contract shared by the studio lane (which serves it) and every public screen
// (which reads it). When Studio is disabled or nothing is published, the public
// shell falls back to DEFAULT_SITE with the organization code as the name.

import { publicFetch } from './api.ts'
import { titleCase } from './format.ts'

export type SiteTemplateCode = 'club' | 'court-dark' | 'minimal'

export type PublicSite = {
  organization_code: string
  display_name: string
  tagline: string | null
  template_code: SiteTemplateCode
  /** Constrained brand tokens — never raw CSS. */
  token: {
    accent: string
    action: string
    heading_font: 'Space Grotesk' | 'Inter'
    radius: 'square' | 'soft' | 'round'
  }
  /** Public content slots in display order; Studio owns which exist. */
  content: {
    hero_title: string
    hero_body: string
    address: string | null
    contact: string | null
  }
  /** Public navigation, already filtered to enabled modules. */
  nav: { nav_code: 'book' | 'program' | 'play' | 'shop'; label: string }[]
  /** Published version number; 0 when nothing has been published. */
  version_number: number
}

export function defaultSite(organization_code: string): PublicSite {
  return {
    organization_code,
    display_name: titleCase(organization_code),
    tagline: null,
    template_code: 'club',
    token: { accent: '#123fbd', action: '#f32624', heading_font: 'Space Grotesk', radius: 'round' },
    content: {
      hero_title: 'Book a court',
      hero_body: 'Pick a time, hold your court, and pay at the counter or online.',
      address: null,
      contact: null,
    },
    nav: [{ nav_code: 'book', label: 'Book' }],
    version_number: 0,
  }
}

export async function loadSite(organization_code: string): Promise<PublicSite> {
  try {
    const result = await publicFetch<{ site: PublicSite }>(`/public/${encodeURIComponent(organization_code)}/site`)
    return result.site
  } catch {
    return defaultSite(organization_code)
  }
}
