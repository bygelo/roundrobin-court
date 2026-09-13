// webhook — R21 webhook egress.
//
// STUB written by the foundation checkpoint. The webhook lane owns every file
// under src/module/webhook/, migration/014_webhook.sql, script/seed/webhook.ts,
// test/webhook*.test.ts, and web/src/page/webhook/.

import type { ModuleDeclaration, RouteContributor, Store } from '@bygelo/roundrobin-kernel'

export const WEBHOOK_MODULE: ModuleDeclaration = {
  module_code: 'webhook',
  package_code: 'court',
  display_name: 'Webhooks',
  schema_version: 1,
  is_removable: true,
  depend_on: ['connector'],
  capability: [
    { capability_code: 'webhook.read', description: 'See webhooks' },
    { capability_code: 'webhook.manage', description: 'Change webhooks' },
  ],
  route_prefix: ['/api/v1/webhook'],
}

export function createWebhookRoute(_store: Store): RouteContributor {
  return () => {}
}
