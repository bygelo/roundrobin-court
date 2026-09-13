// score — R12 live score under a sport scoring profile.
//
// STUB written by the foundation checkpoint. The score lane owns every file
// under src/module/score/, migration/007_score.sql, script/seed/score.ts,
// test/score*.test.ts, and web/src/page/score/.

import type { ModuleDeclaration, RouteContributor, Store } from '@bygelo/roundrobin-kernel'

export const SCORE_MODULE: ModuleDeclaration = {
  module_code: 'score',
  package_code: 'court',
  display_name: 'Live score',
  schema_version: 1,
  is_removable: true,
  depend_on: ['court'],
  capability: [
    { capability_code: 'score.read', description: 'See live score' },
    { capability_code: 'score.manage', description: 'Change live score' },
  ],
  route_prefix: ['/api/v1/score'],
}

export function createScoreRoute(_store: Store): RouteContributor {
  return () => {}
}
