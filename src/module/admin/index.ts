// admin — R03 modules, R04 staff, R19 API keys, R24 data portability.
//
// STUB written by the foundation checkpoint. The admin lane owns every file
// under src/module/admin/, migration/017_admin.sql, script/seed/admin.ts,
// test/admin*.test.ts, and web/src/page/admin/.

import type { ModuleDeclaration, RouteContributor, Store } from '@bygelo/roundrobin-kernel'

export const ADMIN_MODULE: ModuleDeclaration = {
  module_code: 'admin',
  package_code: 'court',
  display_name: 'Administration',
  schema_version: 1,
  is_removable: false,
  depend_on: [],
  capability: [
    { capability_code: 'admin.read', description: 'See administration' },
    { capability_code: 'admin.manage', description: 'Change administration' },
  ],
  route_prefix: ['/api/v1/admin'],
}

export function createAdminRoute(_store: Store): RouteContributor {
  return () => {}
}
