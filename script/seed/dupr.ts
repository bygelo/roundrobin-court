// Seed step for the dupr module.
//
// The demo venue starts honestly NOT connected: DUPR issues partner credentials
// only after it approves a club. An operator can rehearse with the sandbox
// (DUPR_MODE=sandbox) from Connections → DUPR.

import type { SeedContext } from './context.ts'

export async function seedDupr({ tenant, organization_id }: SeedContext): Promise<void> {
  await tenant.query`
    INSERT INTO dupr_connection (organization_id, status_code)
    VALUES (${organization_id}, 'not_configured')
    ON CONFLICT (organization_id) DO NOTHING`
}
