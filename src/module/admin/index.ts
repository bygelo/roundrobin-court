// admin — R03 modules, R04 staff, R19 API keys, R24 data portability.
//
// Operator routes under /api/v1/admin, plus the public privacy intake under
// /public/:organization_code/admin. API key create/list/revoke and the tenant
// export/import are the kernel's own routes; admin adds only what those
// screens need around them (capability catalog, export summary).

import {
  DomainError,
  ModuleError,
  authorize,
  disableModule,
  enableModule,
  exportTenant,
  listModuleState,
  type KernelApp,
  type ModuleDeclaration,
  type RouteContributor,
  type Session,
  type Store,
  type TenantContext,
} from '@bygelo/roundrobin-kernel'
import { withPublicTenant } from '../../public.ts'
import { listAudit, recordAdminAudit } from './audit.ts'
import {
  DATA_KEPT_SENTENCE,
  FAMILY_ORDER,
  describeModule,
  familyOf,
  joinName,
  listMissingDependency,
  listRequiredBy,
  planEnable,
  refuseCoreSentence,
  refuseDisableSentence,
  refuseEnableSentence,
} from './catalog.ts'
import {
  closePrivacyRequest,
  createPrivacyRequest,
  fulfilPrivacyRequest,
  listPrivacyRequest,
  parseIntake,
  readAccessBundle,
  readPrivacyStatus,
} from './privacy.ts'
import { ROLE_PRESET, deriveRoleCapability } from './role.ts'
import { createStaff, disableStaff, enableStaff, findStaff, listStaff, resetStaffSecret, updateStaff } from './staff.ts'

export const ADMIN_MODULE: ModuleDeclaration = {
  module_code: 'admin',
  package_code: 'court',
  display_name: 'Administration',
  schema_version: 1,
  is_removable: false,
  depend_on: [],
  capability: [
    { capability_code: 'admin.read', description: 'See staff, roles, modules, recent activity, and privacy requests' },
    { capability_code: 'admin.manage', description: 'Add and change staff, turn modules on or off, and fulfil privacy requests' },
    // kernel.api_key.manage and kernel.export are declared by KERNEL_MODULE,
    // which src/app.ts composes.
  ],
  route_prefix: ['/api/v1/admin'],
}

const CAPABILITY = { read: 'admin.read', manage: 'admin.manage', export: 'kernel.export' } as const

/** The full declaration, read lazily: app.ts imports this file, so a static import would be a cycle. */
async function loadDeclaration(): Promise<ModuleDeclaration[]> {
  const { COURT_DECLARATION } = await import('../../app.ts')
  return COURT_DECLARATION
}

type ModuleView = {
  module_code: string
  display_name: string
  family: string
  description: string
  is_enabled: boolean
  is_removable: boolean
  depend_on: { module_code: string; display_name: string }[]
  required_by_enabled: { module_code: string; display_name: string }[]
}

function nameOf(one: ModuleDeclaration) {
  return { module_code: one.module_code, display_name: one.display_name }
}

async function listModuleView(tenant: TenantContext, declaration: ModuleDeclaration[]): Promise<ModuleView[]> {
  const state = await listModuleState(tenant)
  const enabled = new Set(state.filter((one) => one.is_enabled).map((one) => one.module_code))
  const by_code = new Map(declaration.map((one) => [one.module_code, one]))
  return declaration
    .map((one) => ({
      module_code: one.module_code,
      display_name: one.display_name,
      family: familyOf(one.module_code),
      description: describeModule(one),
      is_enabled: enabled.has(one.module_code),
      is_removable: one.is_removable,
      depend_on: one.depend_on.map((code) => by_code.get(code)).filter((each) => each !== undefined).map(nameOf),
      required_by_enabled: listRequiredBy(one.module_code, enabled, declaration).map(nameOf),
    }))
    .sort(
      (a, b) =>
        FAMILY_ORDER.indexOf(a.family as never) - FAMILY_ORDER.indexOf(b.family as never) ||
        a.display_name.localeCompare(b.display_name),
    )
}

async function readJson(context: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  const body = await context.req.json().catch(() => ({}))
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
}

async function actingLabel(tenant: TenantContext, session: Session): Promise<string> {
  const [row] = await tenant.query<{ display_name: string }[]>`
    SELECT display_name FROM actor WHERE organization_id = ${tenant.organization_id} AND actor_id = ${session.actor_id}`
  return row?.display_name ?? 'staff'
}

export function createAdminRoute(store: Store): RouteContributor {
  return (app: KernelApp) => {
    type AuditContext = { get: (key: 'api_key_id') => string | undefined }
    const audit = (
      context: unknown,
      tenant: TenantContext,
      session: Session,
      input: Parameters<typeof recordAdminAudit>[3],
    ) => recordAdminAudit(tenant, session, (context as AuditContext).get('api_key_id') !== undefined, input)

    // ---- modules (R03) ----------------------------------------------------

    app.get('/api/v1/admin/module', async (context) => {
      authorize(context.get('session'), CAPABILITY.read)
      const module = await listModuleView(context.get('tenant'), await loadDeclaration())
      return context.json({ module })
    })

    app.post('/api/v1/admin/module/:module_code/enable', async (context) => {
      const session = context.get('session')
      const tenant = context.get('tenant')
      authorize(session, CAPABILITY.manage)
      const declaration = await loadDeclaration()
      const module_code = context.req.param('module_code')
      const target = declaration.find((one) => one.module_code === module_code)
      if (!target) throw new DomainError('module not found', 404)
      const body = await readJson(context)

      const enabled = new Set(
        (await listModuleState(tenant)).filter((one) => one.is_enabled).map((one) => one.module_code),
      )
      const missing = listMissingDependency(module_code, enabled, declaration)
      if (missing.length > 0 && body['with_dependency'] !== true) {
        return context.json(
          { error: refuseEnableSentence(target, missing), missing_dependency: missing.map(nameOf) },
          409,
        )
      }

      const plan = planEnable(module_code, enabled, declaration)
      try {
        for (const code of plan) await enableModule(tenant, code, declaration)
      } catch (error) {
        if (error instanceof ModuleError) throw new DomainError(error.message, 409)
        throw error
      }
      const by_code = new Map(declaration.map((one) => [one.module_code, one]))
      const turned_on = plan.map((code) => by_code.get(code)!.display_name)
      if (plan.length > 0) {
        await audit(context, tenant, session, {
          event_code: 'module.enabled',
          subject_table: 'organization_module',
          summary: `Turned on ${joinName(turned_on)}`,
          detail: { module_code: plan },
        })
      }
      const view = (await listModuleView(tenant, declaration)).find((one) => one.module_code === module_code)
      return context.json({
        module: view,
        enabled_module_code: plan,
        message: plan.length === 0 ? `${target.display_name} is already on.` : `Turned on ${joinName(turned_on)}.`,
      })
    })

    app.post('/api/v1/admin/module/:module_code/disable', async (context) => {
      const session = context.get('session')
      const tenant = context.get('tenant')
      authorize(session, CAPABILITY.manage)
      const declaration = await loadDeclaration()
      const module_code = context.req.param('module_code')
      const target = declaration.find((one) => one.module_code === module_code)
      if (!target) throw new DomainError('module not found', 404)
      if (!target.is_removable) return context.json({ error: refuseCoreSentence(target) }, 409)

      const enabled = new Set(
        (await listModuleState(tenant)).filter((one) => one.is_enabled).map((one) => one.module_code),
      )
      const required_by = listRequiredBy(module_code, enabled, declaration)
      if (required_by.length > 0) {
        return context.json(
          { error: refuseDisableSentence(target, required_by), required_by_enabled: required_by.map(nameOf) },
          409,
        )
      }
      if (enabled.has(module_code)) {
        try {
          await disableModule(tenant, module_code, declaration)
        } catch (error) {
          if (error instanceof ModuleError) throw new DomainError(error.message, 409)
          throw error
        }
        await audit(context, tenant, session, {
          event_code: 'module.disabled',
          subject_table: 'organization_module',
          summary: `Turned off ${target.display_name}`,
          detail: { module_code },
        })
      }
      const view = (await listModuleView(tenant, declaration)).find((one) => one.module_code === module_code)
      return context.json({
        module: view,
        is_data_deleted: false,
        message: `Turned off ${target.display_name}. ${DATA_KEPT_SENTENCE}`,
      })
    })

    // ---- staff (R04) -------------------------------------------------------

    app.get('/api/v1/admin/staff', async (context) => {
      const session = context.get('session')
      const tenant = context.get('tenant')
      authorize(session, CAPABILITY.read)
      const staff = await listStaff(tenant)
      const catalog = (
        await tenant.query<{ capability_code: string }[]>`SELECT capability_code FROM capability`
      ).map((one) => one.capability_code)
      return context.json({
        staff: staff.map((one) => ({ ...one, is_self: one.actor_id === session.actor_id })),
        role: ROLE_PRESET.map((one) => ({
          role_code: one.role_code,
          display_name: one.display_name,
          description: one.description,
          capability_count: deriveRoleCapability(one.role_code, catalog).length,
        })),
      })
    })

    app.post('/api/v1/admin/staff', async (context) => {
      const session = context.get('session')
      const tenant = context.get('tenant')
      authorize(session, CAPABILITY.manage)
      const body = await readJson(context)
      const result = await createStaff(tenant, {
        actor_code: body['actor_code'],
        display_name: body['display_name'],
        role_code: body['role_code'],
      })
      await audit(context, tenant, session, {
        event_code: 'staff.created',
        subject_table: 'actor',
        subject_id: result.staff.actor_id,
        summary: `Added ${result.staff.display_name} as ${result.staff.role_display_name}`,
        detail: { role_code: result.staff.role_code },
      })
      // The temporary secret is returned once and never stored in plain text.
      return context.json(result, 201)
    })

    app.patch('/api/v1/admin/staff/:actor_id', async (context) => {
      const session = context.get('session')
      const tenant = context.get('tenant')
      authorize(session, CAPABILITY.manage)
      const body = await readJson(context)
      const { staff, before } = await updateStaff(tenant, context.req.param('actor_id'), {
        role_code: body['role_code'],
        display_name: body['display_name'],
      })
      const change: string[] = []
      if (before.role_code !== staff.role_code) change.push(`role ${before.role_display_name ?? 'none'} to ${staff.role_display_name}`)
      if (before.display_name !== staff.display_name) change.push(`name to ${staff.display_name}`)
      if (change.length > 0) {
        await audit(context, tenant, session, {
          event_code: 'staff.updated',
          subject_table: 'actor',
          subject_id: staff.actor_id,
          summary: `Changed ${before.display_name}: ${change.join(', ')}`,
          detail: { role_code_before: before.role_code, role_code_after: staff.role_code },
        })
      }
      return context.json({ staff })
    })

    app.post('/api/v1/admin/staff/:actor_id/disable', async (context) => {
      const session = context.get('session')
      const tenant = context.get('tenant')
      authorize(session, CAPABILITY.manage)
      const result = await disableStaff(tenant, context.req.param('actor_id'), session.actor_id)
      await audit(context, tenant, session, {
        event_code: 'staff.disabled',
        subject_table: 'actor',
        subject_id: result.staff.actor_id,
        summary: `Disabled ${result.staff.display_name} and signed them out everywhere`,
        detail: {
          revoked_session_count: result.revoked_session_count,
          revoked_api_key_count: result.revoked_api_key_count,
        },
      })
      return context.json(result)
    })

    app.post('/api/v1/admin/staff/:actor_id/enable', async (context) => {
      const session = context.get('session')
      const tenant = context.get('tenant')
      authorize(session, CAPABILITY.manage)
      const result = await enableStaff(tenant, context.req.param('actor_id'))
      await audit(context, tenant, session, {
        event_code: 'staff.enabled',
        subject_table: 'actor',
        subject_id: result.staff.actor_id,
        summary: `Enabled ${result.staff.display_name} with a new temporary password`,
      })
      return context.json(result)
    })

    app.post('/api/v1/admin/staff/:actor_id/reset-secret', async (context) => {
      const session = context.get('session')
      const tenant = context.get('tenant')
      authorize(session, CAPABILITY.manage)
      const result = await resetStaffSecret(tenant, context.req.param('actor_id'), session.actor_id)
      await audit(context, tenant, session, {
        event_code: 'staff.secret_reset',
        subject_table: 'actor',
        subject_id: result.staff.actor_id,
        summary: `Reset the password for ${result.staff.display_name}`,
        detail: { revoked_session_count: result.revoked_session_count },
      })
      return context.json(result)
    })

    app.get('/api/v1/admin/staff/:actor_id', async (context) => {
      authorize(context.get('session'), CAPABILITY.read)
      return context.json({ staff: await findStaff(context.get('tenant'), context.req.param('actor_id')) })
    })

    app.get('/api/v1/admin/audit', async (context) => {
      authorize(context.get('session'), CAPABILITY.read)
      const limit_count = Number(context.req.query('limit_count') ?? 50)
      return context.json({ audit_event: await listAudit(context.get('tenant'), limit_count) })
    })

    // ---- API keys (R19) ----------------------------------------------------

    app.get('/api/v1/admin/capability-catalog', async (context) => {
      const session = context.get('session')
      const tenant = context.get('tenant')
      authorize(session, CAPABILITY.read)
      const declaration = await loadDeclaration()
      const state = await listModuleState(tenant)
      const enabled = new Set(state.filter((one) => one.is_enabled).map((one) => one.module_code))
      const description = new Map(
        (await tenant.query<{ capability_code: string; description: string }[]>`
          SELECT capability_code, description FROM capability`).map((one) => [one.capability_code, one.description]),
      )
      const held = new Set(session.capability)
      const seen = new Set<string>()
      const module = declaration
        .filter((one) => enabled.has(one.module_code) && one.capability.length > 0)
        .map((one) => ({
          module_code: one.module_code,
          display_name: one.module_code === 'admin' ? 'Administration and platform' : one.display_name,
          family: familyOf(one.module_code),
          capability: one.capability
            .filter((each) => !seen.has(each.capability_code) && (seen.add(each.capability_code), true))
            .map((each) => ({
              capability_code: each.capability_code,
              description: description.get(each.capability_code) ?? each.description,
              is_held: held.has(each.capability_code),
            })),
        }))
        .sort((a, b) => a.display_name.localeCompare(b.display_name))
      return context.json({ module })
    })

    // ---- data (R24) --------------------------------------------------------

    app.get('/api/v1/admin/export/summary', async (context) => {
      authorize(context.get('session'), CAPABILITY.export)
      const tenant = context.get('tenant')
      const document = await exportTenant(tenant)
      const [operational] = await tenant.query<{ booking_count: number; resource_count: number; invoice_count: number }[]>`
        SELECT (SELECT count(*)::int FROM booking WHERE organization_id = ${tenant.organization_id}) AS booking_count,
               (SELECT count(*)::int FROM resource r JOIN site s ON s.site_id = r.site_id
                 WHERE s.organization_id = ${tenant.organization_id} AND r.deleted_at IS NULL) AS resource_count,
               (SELECT count(*)::int FROM invoice WHERE organization_id = ${tenant.organization_id}) AS invoice_count`
      return context.json({
        version: document.version,
        exported_at: document.exported_at,
        organization: document.organization,
        checksum: document.checksum,
        count: document.count,
        table: Object.entries(document.count).map(([table_name, record_count]) => ({ table_name, record_count })),
        not_included: [
          { label: 'Courts', record_count: operational?.resource_count ?? 0 },
          { label: 'Bookings', record_count: operational?.booking_count ?? 0 },
          { label: 'Invoices', record_count: operational?.invoice_count ?? 0 },
        ],
      })
    })

    app.get('/api/v1/admin/privacy-request', async (context) => {
      authorize(context.get('session'), CAPABILITY.read)
      return context.json({ privacy_request: await listPrivacyRequest(context.get('tenant')) })
    })

    app.get('/api/v1/admin/privacy-request/:admin_privacy_request_id/bundle', async (context) => {
      authorize(context.get('session'), CAPABILITY.manage)
      const bundle = await readAccessBundle(context.get('tenant'), context.req.param('admin_privacy_request_id'))
      context.header('content-disposition', 'attachment; filename="privacy-bundle.json"')
      return context.json(bundle)
    })

    app.post('/api/v1/admin/privacy-request/:admin_privacy_request_id/fulfil', async (context) => {
      const session = context.get('session')
      const tenant = context.get('tenant')
      authorize(session, CAPABILITY.manage)
      const actor_label = await actingLabel(tenant, session)
      const result = await fulfilPrivacyRequest(tenant, context.req.param('admin_privacy_request_id'), {
        actor_id: session.actor_id,
        actor_label,
      })
      await audit(context, tenant, session, {
        event_code: `privacy_request.${result.privacy_request.request_kind}.fulfilled`,
        subject_table: 'admin_privacy_request',
        subject_id: result.privacy_request.admin_privacy_request_id,
        summary:
          result.privacy_request.request_kind === 'access'
            ? `Prepared a data copy for booking ${result.privacy_request.booking_code}`
            : `Erased player details for booking ${result.privacy_request.booking_code}`,
      })
      return context.json(result)
    })

    app.post('/api/v1/admin/privacy-request/:admin_privacy_request_id/close', async (context) => {
      const session = context.get('session')
      const tenant = context.get('tenant')
      authorize(session, CAPABILITY.manage)
      const body = await readJson(context)
      const privacy_request = await closePrivacyRequest(
        tenant,
        context.req.param('admin_privacy_request_id'),
        { actor_id: session.actor_id },
        body['reason'],
      )
      await audit(context, tenant, session, {
        event_code: 'privacy_request.closed',
        subject_table: 'admin_privacy_request',
        subject_id: privacy_request.admin_privacy_request_id,
        summary: `Closed a privacy request for booking ${privacy_request.booking_code}`,
      })
      return context.json({ privacy_request })
    })

    // ---- public privacy intake (R24) -----------------------------------------

    app.post('/public/:organization_code/admin/privacy-request', async (context) => {
      const body = await context.req.json().catch(() => null)
      const input = parseIntake(body)
      const result = await withPublicTenant(store, context.req.param('organization_code'), 'admin', (tenant) =>
        createPrivacyRequest(tenant, input),
      )
      if (!result) return context.json({ error: 'not found' }, 404)
      // Identical for a match and a non-match: the caller learns nothing about the booking.
      return context.json(
        {
          status_token: result.status_token,
          message: 'We have your request. Keep this page link to check its status.',
        },
        202,
      )
    })

    app.get('/public/:organization_code/admin/privacy-request/:status_token', async (context) => {
      const status_token = context.req.param('status_token')
      if (!/^[A-Za-z0-9_-]{20,100}$/.test(status_token)) return context.json({ error: 'not found' }, 404)
      const result = await withPublicTenant(store, context.req.param('organization_code'), 'admin', (tenant) =>
        readPrivacyStatus(tenant, status_token),
      )
      if (!result) return context.json({ error: 'not found' }, 404)
      return context.json({ privacy_request: result })
    })
  }
}
