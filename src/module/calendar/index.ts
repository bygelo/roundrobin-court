// calendar — R23 calendar export.
//
// STUB written by the foundation checkpoint. The calendar lane owns every file
// under src/module/calendar/, migration/015_calendar.sql, script/seed/calendar.ts,
// test/calendar*.test.ts, and web/src/page/calendar/.

import type { ModuleDeclaration, RouteContributor, Store } from '@bygelo/roundrobin-kernel'

export const CALENDAR_MODULE: ModuleDeclaration = {
  module_code: 'calendar',
  package_code: 'court',
  display_name: 'Calendar feed',
  schema_version: 1,
  is_removable: true,
  depend_on: ['court'],
  capability: [
    { capability_code: 'calendar.read', description: 'See calendar feed' },
    { capability_code: 'calendar.manage', description: 'Change calendar feed' },
  ],
  route_prefix: ['/api/v1/calendar'],
}

export function createCalendarRoute(_store: Store): RouteContributor {
  return () => {}
}
