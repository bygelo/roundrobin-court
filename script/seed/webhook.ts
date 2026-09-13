// Seed step for the webhook module: one paused subscription pointing at a local
// receiver, so the Webhooks tab has something real to show. Its signing secret
// is discarded — rotate it from the UI to see one.
//
// A local receiver is a private address, which the SSRF guard refuses unless the
// development allowance is on. So the demo subscription is seeded only when
// WEBHOOK_ALLOW_PRIVATE=true (never in production); otherwise the step says why
// it skipped instead of failing the whole seed transaction.

import { isPrivateAllowed } from '../../src/module/webhook/address.ts'
import { createSubscription } from '../../src/module/webhook/service.ts'
import type { SeedContext } from './context.ts'

const DEMO_URL = 'http://localhost:8899/hook'

export async function seedWebhook({ tenant, organization_id }: SeedContext): Promise<void> {
  if (!isPrivateAllowed(process.env)) {
    console.log('  webhook: demo subscription skipped — set WEBHOOK_ALLOW_PRIVATE=true to seed a local receiver')
    return
  }
  const [existing] = await tenant.query<{ webhook_subscription_id: string }[]>`
    SELECT webhook_subscription_id FROM webhook_subscription
    WHERE organization_id = ${organization_id} AND url = ${DEMO_URL} AND deleted_at IS NULL`
  if (existing) return
  await createSubscription(tenant, {
    url: DEMO_URL,
    event_code: ['booking.confirmed'],
    description: 'Demo receiver on this machine (paused)',
    is_active: false,
  })
}
