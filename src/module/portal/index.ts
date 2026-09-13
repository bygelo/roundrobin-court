// portal — R05 public booking and R07 payment.
//
// Two surfaces:
//   public   /public/:organization_code/portal/...  — a guest with no account
//            books, pays, recovers, and cancels. Every call runs through
//            withPublicTenant, so an unknown venue, a suspended venue, and a
//            venue with the portal disabled are one indistinguishable 404.
//   operator /api/v1/portal/...                      — staff list the day,
//            take counter payments, refund, and cancel.

import { authorize, type KernelApp, type ModuleDeclaration, type RouteContributor, type Session, type Store } from '@bygelo/roundrobin-kernel'
import type { Context } from 'hono'
import { withPublicTenant } from '../../public.ts'
import {
  PortalInputError,
  PortalNotFound,
  TAKEN_SENTENCE,
  applyOnlineCallback,
  cancelByGuest,
  cancelByOperator,
  createPortalBooking,
  isSlotTaken,
  listOperatorBooking,
  payBooking,
  readAvailability,
  readRecovery,
  readSetting,
  recordCounterPayment,
  refundBooking,
  saveSetting,
} from './service.ts'

export const PORTAL_MODULE: ModuleDeclaration = {
  module_code: 'portal',
  package_code: 'court',
  display_name: 'Reservation portal',
  schema_version: 1,
  is_removable: true,
  depend_on: ['court', 'booking', 'billing'],
  capability: [
    { capability_code: 'portal.read', description: 'See reservation portal' },
    { capability_code: 'portal.manage', description: 'Change reservation portal' },
  ],
  route_prefix: ['/api/v1/portal'],
}

const NOT_FOUND = { error: 'not found' }

async function readBody(context: Context): Promise<Record<string, unknown>> {
  const body: unknown = await context.req.json().catch(() => ({}))
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
}

/**
 * Turn the portal's own refusals into responses; everything else goes to the
 * kernel's single error mapping. A guest never sees a SQL message.
 */
async function respond(context: Context, work: () => Promise<Response>): Promise<Response> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof PortalNotFound) return context.json(NOT_FOUND, 404)
    if (error instanceof PortalInputError) return context.json({ error: error.message, problem: error.problem }, 400)
    if (isSlotTaken(error)) return context.json({ error: TAKEN_SENTENCE }, 409)
    throw error
  }
}

export function createPortalRoute(store: Store): RouteContributor {
  return (app: KernelApp) => {
    // ---- public -----------------------------------------------------------

    app.get('/public/:organization_code/portal/availability', (context) =>
      respond(context, async () => {
        const result = await withPublicTenant(store, context.req.param('organization_code'), 'portal', (tenant) =>
          readAvailability(tenant, { date: context.req.query('date'), sport_code: context.req.query('sport') }),
        )
        return result === undefined ? context.json(NOT_FOUND, 404) : context.json(result)
      }),
    )

    app.post('/public/:organization_code/portal/booking', (context) =>
      respond(context, async () => {
        const body = await readBody(context)
        const result = await withPublicTenant(store, context.req.param('organization_code'), 'portal', (tenant) =>
          createPortalBooking(tenant, body),
        )
        return result === undefined ? context.json(NOT_FOUND, 404) : context.json(result, 201)
      }),
    )

    app.post('/public/:organization_code/portal/payment/callback', (context) =>
      respond(context, async () => {
        const raw_body = await context.req.text()
        const header = Object.fromEntries(Object.entries(context.req.header()).map(([key, value]) => [key.toLowerCase(), value]))
        const result = await withPublicTenant(store, context.req.param('organization_code'), 'portal', (tenant) =>
          applyOnlineCallback(tenant, { raw_body, header }),
        )
        return result === undefined ? context.json(NOT_FOUND, 404) : context.json(result)
      }),
    )

    app.get('/public/:organization_code/portal/booking/:booking_code', (context) =>
      respond(context, async () => {
        const result = await withPublicTenant(store, context.req.param('organization_code'), 'portal', (tenant) =>
          readRecovery(tenant, context.req.param('booking_code'), context.req.query('token')),
        )
        return result === undefined ? context.json(NOT_FOUND, 404) : context.json(result)
      }),
    )

    app.post('/public/:organization_code/portal/booking/:booking_code/pay', (context) =>
      respond(context, async () => {
        const organization_code = context.req.param('organization_code')
        const booking_code = context.req.param('booking_code')
        const body = await readBody(context)
        const origin = process.env['COURT_PUBLIC_ORIGIN'] ?? new URL(context.req.url).origin
        // The recovery token is deliberately NOT in the return URL: a provider
        // never holds the guest's credential. The page reads it from the device.
        const return_url = `${origin}/v/${encodeURIComponent(organization_code)}/booking/${encodeURIComponent(booking_code)}`
        const result = await withPublicTenant(store, organization_code, 'portal', (tenant) =>
          payBooking(tenant, booking_code, body, { return_url }),
        )
        return result === undefined ? context.json(NOT_FOUND, 404) : context.json(result)
      }),
    )

    app.post('/public/:organization_code/portal/booking/:booking_code/cancel', (context) =>
      respond(context, async () => {
        const body = await readBody(context)
        const result = await withPublicTenant(store, context.req.param('organization_code'), 'portal', (tenant) =>
          cancelByGuest(tenant, context.req.param('booking_code'), body),
        )
        return result === undefined ? context.json(NOT_FOUND, 404) : context.json(result)
      }),
    )

    // ---- operator ---------------------------------------------------------

    app.get('/api/v1/portal/booking', (context) =>
      respond(context, async () => {
        authorize(context.get('session') as Session, 'portal.read')
        const result = await listOperatorBooking(context.get('tenant'), {
          date: context.req.query('date'),
          status: context.req.query('status'),
        })
        return context.json(result)
      }),
    )

    app.post('/api/v1/portal/booking/:booking_code/payment', (context) =>
      respond(context, async () => {
        authorize(context.get('session') as Session, 'portal.manage')
        const result = await recordCounterPayment(context.get('tenant'), context.req.param('booking_code'), await readBody(context))
        return context.json(result, result.is_replay ? 200 : 201)
      }),
    )

    app.post('/api/v1/portal/booking/:booking_code/refund', (context) =>
      respond(context, async () => {
        authorize(context.get('session') as Session, 'portal.manage')
        const result = await refundBooking(context.get('tenant'), context.req.param('booking_code'), await readBody(context))
        return context.json(result, 201)
      }),
    )

    app.post('/api/v1/portal/booking/:booking_code/cancel', (context) =>
      respond(context, async () => {
        authorize(context.get('session') as Session, 'portal.manage')
        return context.json(await cancelByOperator(context.get('tenant'), context.req.param('booking_code')))
      }),
    )

    app.get('/api/v1/portal/setting', (context) =>
      respond(context, async () => {
        authorize(context.get('session') as Session, 'portal.read')
        return context.json({ setting: await readSetting(context.get('tenant')) })
      }),
    )

    app.put('/api/v1/portal/setting', (context) =>
      respond(context, async () => {
        authorize(context.get('session') as Session, 'portal.manage')
        return context.json({ setting: await saveSetting(context.get('tenant'), await readBody(context)) })
      }),
    )
  }
}
