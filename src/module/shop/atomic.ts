// Run a unit of work inside a savepoint so a refusal rolls back its own writes.
//
// Why this exists: the kernel binds one transaction per request and maps a
// thrown DomainError to a response in app.onError. Hono's compose catches the
// throw, so the request middleware's `await next()` resolves normally and the
// transaction COMMITS — including writes made before the refusal (e.g. a
// placed sales_order whose stock decrement then failed). A savepoint makes the
// refusal atomic regardless of how the outer transaction ends.

import type { TenantContext } from '@bygelo/roundrobin-kernel'

export async function atomic<T>(tenant: TenantContext, work: (tenant: TenantContext) => Promise<T>): Promise<T> {
  return tenant.query.savepoint((query) => work({ ...tenant, query } as TenantContext)) as Promise<T>
}
