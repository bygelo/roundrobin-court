// studio — R18 branded public portal.
//
// STUB written by the foundation checkpoint. The studio lane owns every file
// under src/module/studio/, migration/009_studio.sql, script/seed/studio.ts,
// test/studio*.test.ts, and web/src/page/studio/.

import type { ModuleDeclaration, RouteContributor, Store } from '@bygelo/roundrobin-kernel'

export const STUDIO_MODULE: ModuleDeclaration = {
  module_code: 'studio',
  package_code: 'court',
  display_name: 'Studio',
  schema_version: 1,
  is_removable: true,
  depend_on: ['court'],
  capability: [
    { capability_code: 'studio.read', description: 'See studio' },
    { capability_code: 'studio.manage', description: 'Change studio' },
  ],
  route_prefix: ['/api/v1/studio'],
}

export function createStudioRoute(_store: Store): RouteContributor {
  return () => {}
}
