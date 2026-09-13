// member — R15 membership and entitlement.
//
// STUB written by the foundation checkpoint. The member lane owns every file
// under src/module/member/, migration/011_member.sql, script/seed/member.ts,
// test/member*.test.ts, and web/src/page/member/.

import type { ModuleDeclaration, RouteContributor, Store } from '@bygelo/roundrobin-kernel'

export const MEMBER_MODULE: ModuleDeclaration = {
  module_code: 'member',
  package_code: 'court',
  display_name: 'Membership',
  schema_version: 1,
  is_removable: true,
  depend_on: ['membership', 'booking'],
  capability: [
    { capability_code: 'member.read', description: 'See membership' },
    { capability_code: 'member.manage', description: 'Change membership' },
  ],
  route_prefix: ['/api/v1/member'],
}

export function createMemberRoute(_store: Store): RouteContributor {
  return () => {}
}
