// program — R10 program and event.
//
// STUB written by the foundation checkpoint. The program lane owns every file
// under src/module/program/, migration/005_program.sql, script/seed/program.ts,
// test/program*.test.ts, and web/src/page/program/.

import type { ModuleDeclaration, RouteContributor, Store } from '@bygelo/roundrobin-kernel'

export const PROGRAM_MODULE: ModuleDeclaration = {
  module_code: 'program',
  package_code: 'court',
  display_name: 'Programs',
  schema_version: 1,
  is_removable: true,
  depend_on: ['court', 'booking'],
  capability: [
    { capability_code: 'program.read', description: 'See programs' },
    { capability_code: 'program.manage', description: 'Change programs' },
  ],
  route_prefix: ['/api/v1/program'],
}

export function createProgramRoute(_store: Store): RouteContributor {
  return () => {}
}
