// The public surface: routes a guest reaches with no session.
//
// A player booking a court, a phone opening an open-play link, a lounge TV —
// none of them hold a bearer token, so their routes live outside /api/* where
// neither the kernel's bearer middleware nor its module gate runs.
//
// This helper does the two things those middlewares would have done, and
// nothing else:
//
//   1. find the tenant from the organization code in the URL, using the same
//      pre-tenant lookup the kernel's own sign-in route uses; then
//   2. refuse, as 404, when that tenant does not run the module — the kernel's
//      rule that a disabled module is indistinguishable from one never installed.
//
// Every read and write then runs inside withTenant, so row-level security still
// applies to a guest exactly as it does to staff.

import {
  TenantSuspendedError,
  listEnabledModuleCode,
  withOwner,
  withTenant,
  type Store,
  type TenantContext,
  type Uuid,
} from '@bygelo/roundrobin-kernel'

/** Thrown inside a public handler to answer 404 without leaking why. */
export class PublicNotFoundError extends Error {
  constructor() {
    super('not found')
  }
}

export async function resolveOrganizationId(store: Store, organization_code: string): Promise<Uuid | undefined> {
  return withOwner(store, 'resolve session', async (owner) => {
    const [row] = await owner.query<{ organization_id: Uuid | null }[]>`
      SELECT resolve_organization_by_code(${organization_code}) AS organization_id`
    return row?.organization_id ?? undefined
  })
}

/**
 * Run `work` inside the tenant named by `organization_code`, only if every
 * module in `module_code` is enabled there. Resolves `undefined` for an unknown,
 * suspended, or module-less tenant, so the caller answers one 404 for all three.
 */
export async function withPublicTenant<T>(
  store: Store,
  organization_code: string,
  module_code: string | string[],
  work: (tenant: TenantContext) => Promise<T>,
): Promise<T | undefined> {
  const required = Array.isArray(module_code) ? module_code : [module_code]
  const organization_id = await resolveOrganizationId(store, organization_code)
  if (!organization_id) return undefined
  try {
    return await withTenant(store, organization_id, async (tenant) => {
      const enabled = await listEnabledModuleCode(tenant)
      if (!required.every((one) => enabled.includes(one))) return undefined
      try {
        return await work(tenant)
      } catch (error) {
        if (error instanceof PublicNotFoundError) return undefined
        throw error
      }
    })
  } catch (error) {
    if (error instanceof TenantSuspendedError) return undefined
    throw error
  }
}
