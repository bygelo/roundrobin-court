// message — R22 transactional notification.
//
// STUB written by the foundation checkpoint. The message lane owns every file
// under src/module/message/, migration/016_message.sql, script/seed/message.ts,
// test/message*.test.ts, and web/src/page/message/.

import type { ModuleDeclaration, RouteContributor, Store } from '@bygelo/roundrobin-kernel'

export const MESSAGE_MODULE: ModuleDeclaration = {
  module_code: 'message',
  package_code: 'court',
  display_name: 'Player messages',
  schema_version: 1,
  is_removable: true,
  depend_on: ['notification'],
  capability: [
    { capability_code: 'message.read', description: 'See player messages' },
    { capability_code: 'message.manage', description: 'Change player messages' },
  ],
  route_prefix: ['/api/v1/message'],
}

export function createMessageRoute(_store: Store): RouteContributor {
  return () => {}
}
