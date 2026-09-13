// court — the venue itself: sport profile, courts, venue setup, booking policy,
// and the court board (R06, R08). Lane: court (venue).
//
// It depends on booking and adds the sport-specific surface. Its schema lives
// in this repo's own migration/ directory, never in the OS.

import { authorize, type KernelApp, type ModuleDeclaration, type RouteContributor, type Store } from '@bygelo/roundrobin-kernel'
import { PublicNotFoundError, withPublicTenant } from '../../public.ts'
import { cancelBooking, createWalkIn, moveBooking, readBoard } from './board.ts'
import { CourtInputError, isUuid, readBody, readBoolean, readInteger, requireUuidParam } from './input.ts'
import { readBookingPolicy, saveBookingPolicy } from './policy.ts'
import {
  createSchedule,
  deleteSchedule,
  ensureHorizon,
  listSchedule,
  materializeAllSchedule,
  regenerateAllSchedule,
  syncCourtSchedule,
  updateSchedule,
} from './schedule.ts'
import { RATING_PROVIDER, SCORING_RULE, createSport, deleteSport, listSport, updateSport } from './sport.ts'
import {
  createClosure,
  createCourt,
  deleteClosure,
  findSite,
  listClosure,
  listCourt,
  listOperatingHour,
  orderCourt,
  retireCourt,
  saveOperatingHour,
  saveSite,
  updateCourt,
} from './venue.ts'

export { SPORT_CATEGORY } from './sport.ts'
export { readBookingPolicy } from './policy.ts'

export const COURT_MODULE: ModuleDeclaration = {
  module_code: 'court',
  package_code: 'court',
  display_name: 'Court',
  schema_version: 1,
  is_removable: false,
  depend_on: ['booking'],
  capability: [
    { capability_code: 'court.read', description: 'See the court board' },
    { capability_code: 'court.manage', description: 'Configure court, sport, and schedule' },
  ],
  route_prefix: ['/api/v1/court'],
}

const READ = 'court.read'
const MANAGE = 'court.manage'

export function createCourtRoute(store: Store): RouteContributor {
  return (app: KernelApp) => {
    // ---- venue ------------------------------------------------------------
    app.get('/api/v1/court/venue', async (context) => {
      authorize(context.get('session'), READ)
      const tenant = context.get('tenant')
      const site = await findSite(tenant)
      const court = await listCourt(tenant)
      const operating_hour = await listOperatingHour(tenant)
      const schedule = await listSchedule(tenant)
      const sport = await listSport(tenant)
      return context.json({
        site: site ?? null,
        checklist: {
          has_site: site !== undefined,
          has_sport: sport.length > 0,
          has_court: court.length > 0,
          has_operating_hour: operating_hour.length > 0,
          has_schedule: schedule.some((one) => one.template_count > 0),
        },
        court_count: court.length,
        schedule_count: schedule.length,
      })
    })

    app.put('/api/v1/court/venue', async (context) => {
      authorize(context.get('session'), MANAGE)
      const tenant = context.get('tenant')
      const { site, is_time_zone_changed } = await saveSite(tenant, await readBody(context.req))
      const result = is_time_zone_changed ? await regenerateAllSchedule(tenant) : undefined
      return context.json({ site, ...(result ? { result } : {}) })
    })

    // ---- court --------------------------------------------------------------
    app.get('/api/v1/court/court', async (context) => {
      authorize(context.get('session'), READ)
      const is_retired_included = context.req.query('is_retired_included') === 'true'
      return context.json({ court: await listCourt(context.get('tenant'), { is_retired_included }) })
    })

    app.post('/api/v1/court/court', async (context) => {
      authorize(context.get('session'), MANAGE)
      const tenant = context.get('tenant')
      const court = await createCourt(tenant, await readBody(context.req))
      await syncCourtSchedule(tenant, court.resource_id)
      return context.json({ court }, 201)
    })

    app.post('/api/v1/court/court/order', async (context) => {
      authorize(context.get('session'), MANAGE)
      return context.json({ court: await orderCourt(context.get('tenant'), await readBody(context.req)) })
    })

    app.patch('/api/v1/court/court/:resource_id', async (context) => {
      authorize(context.get('session'), MANAGE)
      const tenant = context.get('tenant')
      const resource_id = requireUuidParam(context.req.param('resource_id'), 'court')
      const { court, is_sport_changed } = await updateCourt(tenant, resource_id, await readBody(context.req))
      if (is_sport_changed) await syncCourtSchedule(tenant, resource_id)
      return context.json({ court })
    })

    app.post('/api/v1/court/court/:resource_id/retire', async (context) => {
      authorize(context.get('session'), MANAGE)
      const tenant = context.get('tenant')
      const court = await retireCourt(tenant, requireUuidParam(context.req.param('resource_id'), 'court'))
      await syncCourtSchedule(tenant, court.resource_id)
      return context.json({ court })
    })

    // ---- operating hour -----------------------------------------------------
    app.get('/api/v1/court/operating-hour', async (context) => {
      authorize(context.get('session'), READ)
      return context.json({ operating_hour: await listOperatingHour(context.get('tenant')) })
    })

    app.put('/api/v1/court/operating-hour', async (context) => {
      authorize(context.get('session'), MANAGE)
      const tenant = context.get('tenant')
      const operating_hour = await saveOperatingHour(tenant, await readBody(context.req))
      const result = await regenerateAllSchedule(tenant)
      return context.json({ operating_hour, result })
    })

    // ---- closure ------------------------------------------------------------
    app.get('/api/v1/court/closure', async (context) => {
      authorize(context.get('session'), READ)
      return context.json({ closure: await listClosure(context.get('tenant')) })
    })

    app.post('/api/v1/court/closure', async (context) => {
      authorize(context.get('session'), MANAGE)
      return context.json({ closure: await createClosure(context.get('tenant'), await readBody(context.req)) }, 201)
    })

    app.delete('/api/v1/court/closure/:closure_id', async (context) => {
      authorize(context.get('session'), MANAGE)
      await deleteClosure(context.get('tenant'), requireUuidParam(context.req.param('closure_id'), 'closure'))
      return context.json({ is_deleted: true })
    })

    // ---- schedule -----------------------------------------------------------
    app.get('/api/v1/court/schedule', async (context) => {
      authorize(context.get('session'), READ)
      return context.json({ schedule: await listSchedule(context.get('tenant')) })
    })

    app.post('/api/v1/court/schedule/materialize', async (context) => {
      authorize(context.get('session'), MANAGE)
      return context.json(await materializeAllSchedule(context.get('tenant')))
    })

    app.post('/api/v1/court/schedule', async (context) => {
      authorize(context.get('session'), MANAGE)
      return context.json(await createSchedule(context.get('tenant'), await readBody(context.req)), 201)
    })

    app.patch('/api/v1/court/schedule/:court_schedule_id', async (context) => {
      authorize(context.get('session'), MANAGE)
      const court_schedule_id = requireUuidParam(context.req.param('court_schedule_id'), 'schedule')
      return context.json(await updateSchedule(context.get('tenant'), court_schedule_id, await readBody(context.req)))
    })

    app.delete('/api/v1/court/schedule/:court_schedule_id', async (context) => {
      authorize(context.get('session'), MANAGE)
      const court_schedule_id = requireUuidParam(context.req.param('court_schedule_id'), 'schedule')
      return context.json({ result: await deleteSchedule(context.get('tenant'), court_schedule_id) })
    })

    // ---- sport profile ------------------------------------------------------
    app.get('/api/v1/court/sport', async (context) => {
      authorize(context.get('session'), READ)
      return context.json({
        sport: await listSport(context.get('tenant')),
        scoring_rule: SCORING_RULE,
        rating_provider: RATING_PROVIDER,
      })
    })

    app.post('/api/v1/court/sport', async (context) => {
      authorize(context.get('session'), MANAGE)
      return context.json({ sport: await createSport(context.get('tenant'), await readBody(context.req)) }, 201)
    })

    app.patch('/api/v1/court/sport/:sport_profile_id', async (context) => {
      authorize(context.get('session'), MANAGE)
      const sport_profile_id = requireUuidParam(context.req.param('sport_profile_id'), 'sport')
      return context.json({ sport: await updateSport(context.get('tenant'), sport_profile_id, await readBody(context.req)) })
    })

    app.delete('/api/v1/court/sport/:sport_profile_id', async (context) => {
      authorize(context.get('session'), MANAGE)
      await deleteSport(context.get('tenant'), requireUuidParam(context.req.param('sport_profile_id'), 'sport'))
      return context.json({ is_deleted: true })
    })

    // ---- booking policy -----------------------------------------------------
    app.get('/api/v1/court/policy', async (context) => {
      authorize(context.get('session'), READ)
      return context.json({ policy: await readBookingPolicy(context.get('tenant')) })
    })

    app.put('/api/v1/court/policy', async (context) => {
      authorize(context.get('session'), MANAGE)
      const body = await readBody(context.req)
      const policy = await saveBookingPolicy(context.get('tenant'), {
        advance_window_day_count: readInteger(body, 'advance_window_day_count', 'Advance booking window', 1, 365),
        cancellation_cutoff_hour_count: readInteger(body, 'cancellation_cutoff_hour_count', 'Cancellation cutoff', 0, 720),
        hold_minute_count: readInteger(body, 'hold_minute_count', 'Hold time', 1, 120),
        is_guest_booking_allowed: readBoolean(body, 'is_guest_booking_allowed', 'Guest booking'),
      })
      return context.json({ policy })
    })

    // ---- court board --------------------------------------------------------
    app.get('/api/v1/court/board', async (context) => {
      authorize(context.get('session'), READ)
      const tenant = context.get('tenant')
      if (await findSite(tenant)) await ensureHorizon(tenant)
      return context.json(await readBoard(tenant, context.req.query('date') || undefined))
    })

    app.post('/api/v1/court/board/walk-in', async (context) => {
      authorize(context.get('session'), MANAGE)
      return context.json({ booking: await createWalkIn(context.get('tenant'), await readBody(context.req)) }, 201)
    })

    app.post('/api/v1/court/board/maintenance', async (context) => {
      authorize(context.get('session'), MANAGE)
      const body = await readBody(context.req)
      if (!isUuid(body['resource_id'])) throw new CourtInputError('Choose the court to block for maintenance.')
      return context.json({ closure: await createClosure(context.get('tenant'), body) }, 201)
    })

    app.post('/api/v1/court/board/booking/:booking_id/move', async (context) => {
      authorize(context.get('session'), MANAGE)
      const booking_id = requireUuidParam(context.req.param('booking_id'), 'booking')
      return context.json({ booking: await moveBooking(context.get('tenant'), booking_id, await readBody(context.req)) })
    })

    app.post('/api/v1/court/board/booking/:booking_id/cancel', async (context) => {
      authorize(context.get('session'), MANAGE)
      const booking_id = requireUuidParam(context.req.param('booking_id'), 'booking')
      await cancelBooking(context.get('tenant'), booking_id)
      return context.json({ is_cancelled: true })
    })

    // ---- public venue (portal lane reads this) ------------------------------
    app.get('/public/:organization_code/court/venue', async (context) => {
      const answer = await withPublicTenant(store, context.req.param('organization_code'), 'court', async (tenant) => {
        const site = await findSite(tenant)
        if (!site) throw new PublicNotFoundError()
        const court = await listCourt(tenant)
        return {
          site: {
            display_name: site.display_name,
            time_zone: site.time_zone,
            address_line: site.address_line,
            contact_phone_number: site.contact_phone_number,
            contact_email_address: site.contact_email_address,
          },
          court: court.map((one) => ({
            resource_id: one.resource_id,
            display_name: one.display_name,
            sport_code: one.sport_code,
            sport_display_name: one.sport_display_name,
            sort_order: one.sort_order,
          })),
          operating_hour: await listOperatingHour(tenant),
          policy: await readBookingPolicy(tenant),
        }
      })
      if (!answer) return context.json({ error: 'not found' }, 404)
      return context.json(answer)
    })
  }
}
