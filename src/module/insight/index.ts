// insight — R16 owner insight and accounting export.
//
// STUB written by the foundation checkpoint. The insight lane owns every file
// under src/module/insight/, migration/012_insight.sql, script/seed/insight.ts,
// test/insight*.test.ts, and web/src/page/insight/.

import type { ModuleDeclaration, RouteContributor, Store } from '@bygelo/roundrobin-kernel'

export const INSIGHT_MODULE: ModuleDeclaration = {
  module_code: 'insight',
  package_code: 'court',
  display_name: 'Insight',
  schema_version: 1,
  is_removable: true,
  depend_on: ['court', 'booking'],
  capability: [
    { capability_code: 'insight.read', description: 'See insight' },
    { capability_code: 'insight.manage', description: 'Change insight' },
  ],
  route_prefix: ['/api/v1/insight'],
}

export function createInsightRoute(_store: Store): RouteContributor {
  return () => {}
}
