// program — R10 program and event.
//
// Operator routes under /api/v1/program (bearer + module gate from the kernel)
// and the anonymous public routes under /public/:organization_code/program.

import { authorize, listEnabledModuleCode, type KernelApp, type ModuleDeclaration, type RouteContributor, type Store } from '@bygelo/roundrobin-kernel'
import { withPublicTenant } from '../../public.ts'
import { findCurrentWaiver, isUuid, readWaiverState } from '../arrival/service.ts'
import { hashCredential } from '../arrival/rule.ts'
import { checkInWindow } from '../arrival/rule.ts'
import { notFound, readBody, readEvidence } from './http.ts'
import {
  archiveProgram,
  cancelOccurrence,
  cancelRegistration,
  cancelWithCredential,
  createProgram,
  findOccurrence,
  findProgram,
  listOccurrence,
  listProgram,
  listPublicOccurrence,
  markNoShow,
  materializeProgram,
  parseProgram,
  parseRegistration,
  promoteWaitlist,
  readText,
  register,
  setPaid,
  skipDate,
  updateProgram,
} from './service.ts'

export const PROGRAM_MODULE: ModuleDeclaration = {
  module_code: 'program',
  package_code: 'court',
  display_name: 'Programs',
  schema_version: 1,
  is_removable: true,
  depend_on: ['court', 'booking'],
  capability: [
    { capability_code: 'program.read', description: 'See programs' },
    { capability_code: 'program.manage', description: 'Change programs' },
  ],
  route_prefix: ['/api/v1/program'],
}

const DAY = 86400000

export function createProgramRoute(store: Store): RouteContributor {
  return (app: KernelApp) => {
    // ---- operator: literal paths first ------------------------------------
    app.get('/api/v1/program', async (context) => {
      authorize(context.get('session'), 'program.read')
      const tenant = context.get('tenant')
      const from_query = context.req.query('from')
      const from = from_query && !Number.isNaN(Date.parse(from_query)) ? new Date(from_query) : new Date(Date.now() - DAY)
      const day_count = Math.min(Math.max(Number(context.req.query('day_count') ?? 35) || 35, 1), 120)
      const program = await listProgram(tenant)
      const occurrence = await listOccurrence(tenant, { from, to: new Date(from.getTime() + day_count * DAY) })
      const court = await tenant.query`
        SELECT resource_id, display_name FROM resource
        WHERE organization_id = ${tenant.organization_id} AND deleted_at IS NULL
        ORDER BY sort_order, display_name`
      return context.json({ program, occurrence, court })
    })

    app.post('/api/v1/program', async (context) => {
      authorize(context.get('session'), 'program.manage')
      const result = await createProgram(context.get('tenant'), parseProgram(await readBody(context)))
      return context.json(result, 201)
    })

    app.get('/api/v1/program/occurrence/:program_occurrence_id', async (context) => {
      authorize(context.get('session'), 'program.read')
      return context.json(await findOccurrence(context.get('tenant'), context.req.param('program_occurrence_id')))
    })

    app.post('/api/v1/program/occurrence/:program_occurrence_id/cancel', async (context) => {
      authorize(context.get('session'), 'program.manage')
      const body = await readBody(context)
      return context.json(
        await cancelOccurrence(context.get('tenant'), context.req.param('program_occurrence_id'), readText(body['reason'], 500)),
      )
    })

    app.post('/api/v1/program/occurrence/:program_occurrence_id/promote', async (context) => {
      authorize(context.get('session'), 'program.manage')
      return context.json({ promoted: await promoteWaitlist(context.get('tenant'), context.req.param('program_occurrence_id')) })
    })

    app.post('/api/v1/program/occurrence/:program_occurrence_id/registration', async (context) => {
      authorize(context.get('session'), 'program.manage')
      const body = await readBody(context)
      const result = await register(context.get('tenant'), context.req.param('program_occurrence_id'), parseRegistration(body), {
        is_public: false,
        evidence: readEvidence(context),
      })
      return context.json(result, 201)
    })

    app.post('/api/v1/program/registration/:program_registration_id/no-show', async (context) => {
      authorize(context.get('session'), 'program.manage')
      return context.json(await markNoShow(context.get('tenant'), context.req.param('program_registration_id')))
    })

    app.post('/api/v1/program/registration/:program_registration_id/cancel', async (context) => {
      authorize(context.get('session'), 'program.manage')
      return context.json(await cancelRegistration(context.get('tenant'), context.req.param('program_registration_id')))
    })

    app.post('/api/v1/program/registration/:program_registration_id/payment', async (context) => {
      authorize(context.get('session'), 'program.manage')
      const body = await readBody(context)
      return context.json(await setPaid(context.get('tenant'), context.req.param('program_registration_id'), body['is_paid'] !== false))
    })

    app.get('/api/v1/program/:program_id', async (context) => {
      authorize(context.get('session'), 'program.read')
      return context.json({ program: await findProgram(context.get('tenant'), context.req.param('program_id')) })
    })

    app.put('/api/v1/program/:program_id', async (context) => {
      authorize(context.get('session'), 'program.manage')
      const input = parseProgram(await readBody(context))
      return context.json(await updateProgram(context.get('tenant'), context.req.param('program_id'), input))
    })

    app.delete('/api/v1/program/:program_id', async (context) => {
      authorize(context.get('session'), 'program.manage')
      return context.json(await archiveProgram(context.get('tenant'), context.req.param('program_id')))
    })

    app.post('/api/v1/program/:program_id/generate', async (context) => {
      authorize(context.get('session'), 'program.manage')
      const tenant = context.get('tenant')
      const program = await findProgram(tenant, context.req.param('program_id'))
      return context.json({ materialize: await materializeProgram(tenant, program.program_id) })
    })

    app.post('/api/v1/program/:program_id/skip', async (context) => {
      authorize(context.get('session'), 'program.manage')
      const body = await readBody(context)
      return context.json(await skipDate(context.get('tenant'), context.req.param('program_id'), String(body['occurrence_date'] ?? '')))
    })

    // ---- public -------------------------------------------------------------
    app.get('/public/:organization_code/program', async (context) => {
      const result = await withPublicTenant(store, context.req.param('organization_code'), 'program', async (tenant) => {
        const enabled = await listEnabledModuleCode(tenant)
        const waiver = enabled.includes('arrival') ? await findCurrentWaiver(tenant) : undefined
        return {
          occurrence: await listPublicOccurrence(tenant),
          waiver: waiver
            ? { arrival_waiver_version_id: waiver.arrival_waiver_version_id, version_number: waiver.version_number, title: waiver.title, body: waiver.body }
            : null,
          is_self_check_in: enabled.includes('arrival'),
        }
      })
      return result ? context.json(result) : notFound(context)
    })

    app.post('/public/:organization_code/program/occurrence/:program_occurrence_id/registration', async (context) => {
      const body = await readBody(context)
      const evidence = readEvidence(context)
      const result = await withPublicTenant(store, context.req.param('organization_code'), 'program', (tenant) =>
        register(tenant, context.req.param('program_occurrence_id'), parseRegistration(body), { is_public: true, evidence }),
      )
      return result ? context.json(result, 201) : notFound(context)
    })

    /** A player looking up their own spot with the credential they were shown. */
    app.post('/public/:organization_code/program/registration/lookup', async (context) => {
      const body = await readBody(context)
      const credential = typeof body['credential'] === 'string' ? body['credential'].trim() : ''
      if (!credential) return context.json({ error: 'enter the code from your confirmation' }, 400)
      const result = await withPublicTenant(store, context.req.param('organization_code'), 'program', async (tenant) => {
        const [row] = await tenant.query<
          {
            program_registration_id: string
            party_id: string | null
            display_name: string
            status_code: string
            waitlist_position: number | null
            program_occurrence_id: string
            title: string
            kind_code: string
            host_name: string | null
            starts_at: Date
            ends_at: Date
            occurrence_status_code: string
            checked_in_at: Date | null
          }[]
        >`
          SELECT r.program_registration_id, r.party_id, r.display_name, r.status_code, r.waitlist_position,
                 o.program_occurrence_id, p.title, p.kind_code, p.host_name, o.starts_at, o.ends_at,
                 o.status_code AS occurrence_status_code, ci.checked_in_at
          FROM program_registration r
          JOIN program_occurrence o ON o.program_occurrence_id = r.program_occurrence_id
          JOIN program p ON p.program_id = o.program_id
          LEFT JOIN arrival_check_in ci ON ci.organization_id = r.organization_id AND ci.subject_kind = 'registration'
            AND ci.subject_id = r.program_registration_id
          WHERE r.organization_id = ${tenant.organization_id} AND r.credential_hash = ${hashCredential(credential)}`
        if (!row) return null
        const enabled = await listEnabledModuleCode(tenant)
        const waiver_state = enabled.includes('arrival')
          ? ((await readWaiverState(tenant, [row.party_id as never])).get(row.party_id) ?? 'not_required')
          : 'not_required'
        const window = checkInWindow(new Date(row.starts_at), new Date(row.ends_at), new Date())
        const { party_id: _party_id, ...visible } = row
        return { registration: { ...visible, waiver_state, check_in_window: window } }
      })
      if (result === undefined) return notFound(context)
      if (result === null) return context.json({ error: 'we could not find a registration for that code' }, 404)
      return context.json(result)
    })

    app.post('/public/:organization_code/program/registration/:program_registration_id/cancel', async (context) => {
      const body = await readBody(context)
      const registration_id = context.req.param('program_registration_id')
      if (!isUuid(registration_id)) return notFound(context)
      const result = await withPublicTenant(store, context.req.param('organization_code'), 'program', async (tenant) => {
        const outcome = await cancelWithCredential(tenant, registration_id, body['credential'])
        // The player learns their own spot is released, never who got it.
        return { status_code: outcome.status_code, is_replay: outcome.is_replay, is_seat_passed_on: outcome.promoted !== null }
      })
      return result ? context.json(result) : notFound(context)
    })
  }
}
