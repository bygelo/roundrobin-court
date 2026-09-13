// arrival — R11 arrival, waiver, and check-in.
//
// STUB written by the foundation checkpoint. The arrival lane owns every file
// under src/module/arrival/, migration/006_arrival.sql, script/seed/arrival.ts,
// test/arrival*.test.ts, and web/src/page/arrival/.

import type { ModuleDeclaration, RouteContributor, Store } from '@bygelo/roundrobin-kernel'

export const ARRIVAL_MODULE: ModuleDeclaration = {
  module_code: 'arrival',
  package_code: 'court',
  display_name: 'Arrival',
  schema_version: 1,
  is_removable: true,
  depend_on: ['court', 'scan'],
  capability: [
    { capability_code: 'arrival.read', description: 'See arrival' },
    { capability_code: 'arrival.manage', description: 'Change arrival' },
  ],
  route_prefix: ['/api/v1/arrival'],
}

export function createArrivalRoute(_store: Store): RouteContributor {
  return () => {}
}
