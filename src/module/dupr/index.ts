// dupr — R20 DUPR connector.
//
// STUB written by the foundation checkpoint. The dupr lane owns every file
// under src/module/dupr/, migration/013_dupr.sql, script/seed/dupr.ts,
// test/dupr*.test.ts, and web/src/page/dupr/.

import type { ModuleDeclaration, RouteContributor, Store } from '@bygelo/roundrobin-kernel'

export const DUPR_MODULE: ModuleDeclaration = {
  module_code: 'dupr',
  package_code: 'court',
  display_name: 'DUPR',
  schema_version: 1,
  is_removable: true,
  depend_on: ['connector', 'score'],
  capability: [
    { capability_code: 'dupr.read', description: 'See dupr' },
    { capability_code: 'dupr.manage', description: 'Change dupr' },
  ],
  route_prefix: ['/api/v1/dupr'],
}

export function createDuprRoute(_store: Store): RouteContributor {
  return () => {}
}
