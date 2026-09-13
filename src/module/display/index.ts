// display — R13 display surfaces.
//
// STUB written by the foundation checkpoint. The display lane owns every file
// under src/module/display/, migration/008_display.sql, script/seed/display.ts,
// test/display*.test.ts, and web/src/page/display/.

import type { ModuleDeclaration, RouteContributor, Store } from '@bygelo/roundrobin-kernel'

export const DISPLAY_MODULE: ModuleDeclaration = {
  module_code: 'display',
  package_code: 'court',
  display_name: 'Displays',
  schema_version: 1,
  is_removable: true,
  depend_on: ['court', 'output'],
  capability: [
    { capability_code: 'display.read', description: 'See displays' },
    { capability_code: 'display.manage', description: 'Change displays' },
  ],
  route_prefix: ['/api/v1/display'],
}

export function createDisplayRoute(_store: Store): RouteContributor {
  return () => {}
}
