// play — R09 fair rotation and open play.
//
// STUB written by the foundation checkpoint. The play lane owns every file
// under src/module/play/, migration/004_play.sql, script/seed/play.ts,
// test/play*.test.ts, and web/src/page/play/.

import type { ModuleDeclaration, RouteContributor, Store } from '@bygelo/roundrobin-kernel'

export const PLAY_MODULE: ModuleDeclaration = {
  module_code: 'play',
  package_code: 'court',
  display_name: 'Open play',
  schema_version: 1,
  is_removable: true,
  depend_on: ['court'],
  capability: [
    { capability_code: 'play.read', description: 'See open play' },
    { capability_code: 'play.manage', description: 'Change open play' },
  ],
  route_prefix: ['/api/v1/play'],
}

export function createPlayRoute(_store: Store): RouteContributor {
  return () => {}
}
