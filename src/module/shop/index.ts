// shop — R14 commerce and inventory surface.
//
// STUB written by the foundation checkpoint. The shop lane owns every file
// under src/module/shop/, migration/010_shop.sql, script/seed/shop.ts,
// test/shop*.test.ts, and web/src/page/shop/.

import type { ModuleDeclaration, RouteContributor, Store } from '@bygelo/roundrobin-kernel'

export const SHOP_MODULE: ModuleDeclaration = {
  module_code: 'shop',
  package_code: 'court',
  display_name: 'Shop',
  schema_version: 1,
  is_removable: true,
  depend_on: ['commerce'],
  capability: [
    { capability_code: 'shop.read', description: 'See shop' },
    { capability_code: 'shop.manage', description: 'Change shop' },
  ],
  route_prefix: ['/api/v1/shop'],
}

export function createShopRoute(_store: Store): RouteContributor {
  return () => {}
}
