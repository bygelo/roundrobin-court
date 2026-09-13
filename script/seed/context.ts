// What every seed step receives. The tenant is already bound, every module is
// enabled, and the owner actor exists.

import type { TenantContext, Uuid } from '@bygelo/roundrobin-kernel'

export type SeedContext = {
  tenant: TenantContext
  organization_id: Uuid
  organization_code: string
}
