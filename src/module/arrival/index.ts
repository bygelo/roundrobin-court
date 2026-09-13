// arrival — R11 arrival, waiver, and check-in.
//
// Operator routes under /api/v1/arrival and the anonymous player routes under
// /public/:organization_code/arrival (current waiver, accept, self check-in).

import { DomainError, authorize, type KernelApp, type ModuleDeclaration, type RouteContributor, type Store } from '@bygelo/roundrobin-kernel'
import type { Context } from 'hono'
import { withPublicTenant } from '../../public.ts'
import { notFound, readBody, readEvidence } from '../program/http.ts'
import { isDate, localDate } from '../program/schedule.ts'
import {
  ArrivalRefusal,
  acceptWaiverAtDesk,
  acceptWaiverPublic,
  createWaiverDraft,
  findCurrentWaiver,
  listArrivalDay,
  listWaiver,
  publishWaiver,
  resolveArrivalCode,
  selfCheckIn,
  staffCheckIn,
  updateWaiverDraft,
  venueTimeZone,
} from './service.ts'

export const ARRIVAL_MODULE: ModuleDeclaration = {
  module_code: 'arrival',
  package_code: 'court',
  display_name: 'Arrival',
  schema_version: 1,
  is_removable: true,
  depend_on: ['court', 'scan'],
  capability: [
    { capability_code: 'arrival.read', description: 'See arrival' },
    { capability_code: 'arrival.manage', description: 'Change arrival' },
  ],
  route_prefix: ['/api/v1/arrival'],
}

/** Run a public arrival action; a refusal with a reason code answers 409 with that code. */
async function publicArrival<T>(context: Context, store: Store, work: Parameters<typeof withPublicTenant<T>>[3]) {
  try {
    const result = await withPublicTenant(store, context.req.param('organization_code') ?? '', 'arrival', work)
    return result === undefined ? notFound(context) : context.json(result as object)
  } catch (error) {
    if (error instanceof ArrivalRefusal) {
      return context.json({ error: error.message, reason_code: error.reason_code, ...error.extra }, 409)
    }
    throw error
  }
}

export function createArrivalRoute(store: Store): RouteContributor {
  return (app: KernelApp) => {
    app.get('/api/v1/arrival/today', async (context) => {
      authorize(context.get('session'), 'arrival.read')
      const tenant = context.get('tenant')
      const requested = context.req.query('date')
      if (requested && !isDate(requested)) throw new DomainError('date must be YYYY-MM-DD', 400)
      const date = requested ?? localDate(new Date(), await venueTimeZone(tenant))
      return context.json(await listArrivalDay(tenant, date))
    })

    app.post('/api/v1/arrival/check-in', async (context) => {
      authorize(context.get('session'), 'arrival.manage')
      const result = await staffCheckIn(context.get('tenant'), context.get('session'), await readBody(context))
      return context.json(result, result.is_replay ? 200 : 201)
    })

    app.post('/api/v1/arrival/code/resolve', async (context) => {
      authorize(context.get('session'), 'arrival.read')
      return context.json(await resolveArrivalCode(context.get('tenant'), context.get('session'), await readBody(context)))
    })

    app.get('/api/v1/arrival/waiver', async (context) => {
      authorize(context.get('session'), 'arrival.read')
      return context.json({ waiver: await listWaiver(context.get('tenant')) })
    })

    app.post('/api/v1/arrival/waiver', async (context) => {
      authorize(context.get('session'), 'arrival.manage')
      return context.json({ waiver: await createWaiverDraft(context.get('tenant'), await readBody(context)) }, 201)
    })

    app.post('/api/v1/arrival/waiver/accept', async (context) => {
      authorize(context.get('session'), 'arrival.manage')
      const arrival = await acceptWaiverAtDesk(context.get('tenant'), await readBody(context), readEvidence(context))
      return context.json({ arrival })
    })

    app.put('/api/v1/arrival/waiver/:arrival_waiver_version_id', async (context) => {
      authorize(context.get('session'), 'arrival.manage')
      const waiver = await updateWaiverDraft(context.get('tenant'), context.req.param('arrival_waiver_version_id'), await readBody(context))
      return context.json({ waiver })
    })

    app.post('/api/v1/arrival/waiver/:arrival_waiver_version_id/publish', async (context) => {
      authorize(context.get('session'), 'arrival.manage')
      return context.json({ waiver: await publishWaiver(context.get('tenant'), context.req.param('arrival_waiver_version_id')) })
    })

    // ---- public -------------------------------------------------------------
    app.get('/public/:organization_code/arrival/waiver', (context) =>
      publicArrival(context, store, async (tenant) => {
        const waiver = await findCurrentWaiver(tenant)
        return {
          waiver: waiver
            ? {
                arrival_waiver_version_id: waiver.arrival_waiver_version_id,
                version_number: waiver.version_number,
                title: waiver.title,
                body: waiver.body,
                published_at: waiver.published_at,
              }
            : null,
        }
      }),
    )

    app.post('/public/:organization_code/arrival/waiver/accept', async (context) => {
      const body = await readBody(context)
      const evidence = readEvidence(context)
      return publicArrival(context, store, (tenant) => acceptWaiverPublic(tenant, body, evidence))
    })

    app.post('/public/:organization_code/arrival/check-in', async (context) => {
      const body = await readBody(context)
      return publicArrival(context, store, async (tenant) => {
        const result = await selfCheckIn(tenant, body)
        // A guest sees their own arrival, not the desk's paid or eligibility read.
        return {
          is_replay: result.is_replay,
          check_in: result.arrival.check_in,
          label: result.arrival.label,
          starts_at: result.arrival.starts_at,
          ends_at: result.arrival.ends_at,
        }
      })
    })
  }
}
