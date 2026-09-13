// portal — R05 public booking and R07 payment.
//
// STUB written by the foundation checkpoint. The portal lane owns every file
// under src/module/portal/, migration/003_portal.sql, script/seed/portal.ts,
// test/portal*.test.ts, and web/src/page/portal/.

import type { ModuleDeclaration, RouteContributor, Store } from '@bygelo/roundrobin-kernel'

export const PORTAL_MODULE: ModuleDeclaration = {
  module_code: 'portal',
  package_code: 'court',
  display_name: 'Reservation portal',
  schema_version: 1,
  is_removable: true,
  depend_on: ['court', 'booking', 'billing'],
  capability: [
    { capability_code: 'portal.read', description: 'See reservation portal' },
    { capability_code: 'portal.manage', description: 'Change reservation portal' },
  ],
  route_prefix: ['/api/v1/portal'],
}

export function createPortalRoute(_store: Store): RouteContributor {
  return () => {}
}
