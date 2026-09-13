// Background work the request path cannot be trusted to trigger.
//
// Every job is idempotent and tenant-scoped: the worker finds the tenants that
// run a module, then does that module's work inside withTenant, so row-level
// security applies exactly as it does to a request. A failure in one tenant is
// logged and never stops another.
//
//   every minute      webhook delivery (retry/backoff lives in the webhook service)
//                     message outbox   (sends only when a provider is configured)
//   every 15 minutes  release lapsed booking holds; queue tomorrow's reminders
//   every 6 hours     keep the sellable schedule materialized ahead
//
// Disable with COURT_WORKER=off (tests and one-off scripts never start it).

import { sweepExpiredHold } from '@bygelo/roundrobin-booking'
import { listEnabledModuleCode, withOwner, withTenant, type Store, type TenantContext, type Uuid } from '@bygelo/roundrobin-kernel'
import { materializeAllSchedule } from './module/court/schedule.ts'
import { processOutbox, runReminder } from './module/message/service.ts'
import { processWebhookDelivery } from './module/webhook/index.ts'

type Job = {
  job_code: string
  module_code: string[]
  interval_ms: number
  run: (tenant: TenantContext) => Promise<unknown>
}

const MINUTE = 60_000

export const WORKER_JOB: Job[] = [
  { job_code: 'webhook.deliver', module_code: ['webhook'], interval_ms: MINUTE, run: (tenant) => processWebhookDelivery(tenant) },
  { job_code: 'message.outbox', module_code: ['message', 'notification'], interval_ms: MINUTE, run: (tenant) => processOutbox(tenant) },
  { job_code: 'booking.sweep', module_code: ['booking'], interval_ms: 15 * MINUTE, run: (tenant) => sweepExpiredHold(tenant) },
  { job_code: 'message.reminder', module_code: ['message', 'notification'], interval_ms: 15 * MINUTE, run: (tenant) => runReminder(tenant) },
  { job_code: 'court.schedule', module_code: ['court'], interval_ms: 6 * 60 * MINUTE, run: (tenant) => materializeAllSchedule(tenant) },
]

async function listActiveOrganization(store: Store): Promise<Uuid[]> {
  // A pre-tenant read of one column, the same class of lookup as the kernel's
  // retention job: which tenants exist. Everything after it is tenant-bound.
  return withOwner(store, 'retention', async (owner) => {
    const row = await owner.query<{ organization_id: Uuid }[]>`
      SELECT organization_id FROM organization WHERE deleted_at IS NULL ORDER BY created_at`
    return row.map((one) => one.organization_id)
  })
}

export async function runJobOnce(store: Store, job: Job): Promise<{ tenant_count: number; failure_count: number }> {
  let tenant_count = 0
  let failure_count = 0
  for (const organization_id of await listActiveOrganization(store)) {
    try {
      await withTenant(store, organization_id, async (tenant) => {
        const enabled = await listEnabledModuleCode(tenant)
        if (!job.module_code.every((one) => enabled.includes(one))) return
        tenant_count += 1
        await job.run(tenant)
      })
    } catch (error) {
      failure_count += 1
      console.warn(`worker ${job.job_code} failed for one tenant: ${error instanceof Error ? error.message : 'unknown error'}`)
    }
  }
  return { tenant_count, failure_count }
}

export function startWorker(store: Store): () => void {
  const handle: ReturnType<typeof setInterval>[] = []
  const running = new Set<string>()
  for (const job of WORKER_JOB) {
    const tick = async () => {
      // Never overlap a job with itself; a slow provider must not pile up runs.
      if (running.has(job.job_code)) return
      running.add(job.job_code)
      try {
        await runJobOnce(store, job)
      } catch (error) {
        console.warn(`worker ${job.job_code} skipped: ${error instanceof Error ? error.message : 'unknown error'}`)
      } finally {
        running.delete(job.job_code)
      }
    }
    handle.push(setInterval(tick, job.interval_ms))
    setTimeout(tick, 5_000)
  }
  return () => handle.forEach((one) => clearInterval(one))
}
