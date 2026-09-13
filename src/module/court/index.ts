// court — the venue itself: sport profile, courts, venue setup, booking policy,
// and the court board (R06, R08). Lane: court (venue).
//
// It depends on booking and adds the sport-specific surface. Its schema lives
// in this repo's own migration/ directory, never in the OS.

import type { KernelApp, ModuleDeclaration, RouteContributor, Store } from '@bygelo/roundrobin-kernel'

export const COURT_MODULE: ModuleDeclaration = {
  module_code: 'court',
  package_code: 'court',
  display_name: 'Court',
  schema_version: 1,
  is_removable: false,
  depend_on: ['booking'],
  capability: [
    { capability_code: 'court.read', description: 'See the court board' },
    { capability_code: 'court.manage', description: 'Configure court, sport, and schedule' },
  ],
  route_prefix: ['/api/v1/court'],
}

/**
 * The venue's own vocabulary, supplied to the booking pack as data.
 *
 * This is the whole of "multi-sport" at the data layer: a resource category per
 * sport. No service rule anywhere branches on which one.
 */
export const SPORT_CATEGORY = [
  { resource_category_code: 'pickleball', display_name: 'Pickleball court', team_size_count: 2 },
  { resource_category_code: 'tennis', display_name: 'Tennis court', team_size_count: 2 },
  { resource_category_code: 'badminton', display_name: 'Badminton court', team_size_count: 2 },
  { resource_category_code: 'padel', display_name: 'Padel court', team_size_count: 2 },
] as const

export function createCourtRoute(_store: Store): RouteContributor {
  return (app: KernelApp) => {
    app.get('/api/v1/court/board', async (context) => {
      const tenant = context.get('tenant')
      const court = await tenant.query`
        SELECT r.resource_id, r.resource_code, r.display_name, r.sort_order,
               rc.resource_category_code AS sport_code
        FROM resource r
        JOIN site s ON s.site_id = r.site_id
        LEFT JOIN resource_category_link rcl ON rcl.resource_id = r.resource_id
        LEFT JOIN resource_category rc ON rc.resource_category_id = rcl.resource_category_id
        WHERE s.organization_id = ${tenant.organization_id}
          AND r.deleted_at IS NULL
        ORDER BY r.sort_order, r.resource_code`
      return context.json({ court })
    })
  }
}
