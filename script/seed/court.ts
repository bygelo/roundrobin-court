// Seed step for the court module: the demo venue, set up the way an operator
// would through Venue setup — every write goes through the module's services.
//
// Idempotent: each piece is created only when missing, schedules are rolled
// forward (a no-op when already materialized), and the two demo walk-ins carry
// a seed key so a second run never books again.

import type { Uuid } from '@bygelo/roundrobin-kernel'
import { createWalkIn } from '../../src/module/court/board.ts'
import { readBookingPolicy, saveBookingPolicy } from '../../src/module/court/policy.ts'
import { createSchedule, listSchedule, materializeAllSchedule } from '../../src/module/court/schedule.ts'
import { createSport, listSport } from '../../src/module/court/sport.ts'
import { addDay, localDateKey, zonedToInstant } from '../../src/module/court/time.ts'
import { createCourt, findSite, listCourt, listOperatingHour, saveOperatingHour, saveSite } from '../../src/module/court/venue.ts'
import type { SeedContext } from './context.ts'

const SPORT = [
  { sport_profile_code: 'pickleball', display_name: 'Pickleball', team_size_count: 2, scoring_rule_code: 'side_out_11', rating_provider_code: 'dupr', session_minute_count: 60 },
  { sport_profile_code: 'tennis', display_name: 'Tennis', team_size_count: 2, scoring_rule_code: 'tennis_set', rating_provider_code: 'utr', session_minute_count: 60 },
  { sport_profile_code: 'badminton', display_name: 'Badminton', team_size_count: 2, scoring_rule_code: 'badminton_rally_21', rating_provider_code: null, session_minute_count: 60 },
  { sport_profile_code: 'padel', display_name: 'Padel', team_size_count: 2, scoring_rule_code: 'padel_set', rating_provider_code: null, session_minute_count: 60 },
]

const COURT = [
  { display_name: 'Court 1', sport_code: 'pickleball', capacity_count: 4 },
  { display_name: 'Court 2', sport_code: 'pickleball', capacity_count: 4 },
  { display_name: 'Court 3', sport_code: 'pickleball', capacity_count: 4 },
  { display_name: 'Court 4', sport_code: 'pickleball', capacity_count: 4 },
  { display_name: 'Padel Court', sport_code: 'padel', capacity_count: 4 },
]

// Peak: weekday evenings 17:00–22:00, weekends all day.
const PEAK = [
  ...[1, 2, 3, 4, 5].map((weekday_number) => ({ weekday_number, starts_local: '17:00', ends_local: '22:00' })),
  ...[6, 7].map((weekday_number) => ({ weekday_number, starts_local: '00:00', ends_local: '24:00' })),
]

const WALK_IN = [
  { seed_key: 'court-walk-in-1', court: 'Court 1', starts_local: '18:00', party_display_name: 'Miguel Santos', phone_number: '+63 917 555 0101', is_paid: true },
  { seed_key: 'court-walk-in-2', court: 'Court 2', starts_local: '19:00', party_display_name: 'Andrea Reyes', phone_number: '+63 918 555 0144', is_paid: false },
]

export async function seedCourt({ tenant, organization_id }: SeedContext): Promise<void> {
  const site =
    (await findSite(tenant)) ??
    (
      await saveSite(tenant, {
        display_name: 'Sideout Pickleball Club',
        time_zone: 'Asia/Manila',
        address_line: 'Katipunan Ave, Quezon City',
        contact_phone_number: '+63 917 555 0142',
        contact_email_address: 'hello@sideout.ph',
      })
    ).site

  const sport = await listSport(tenant)
  for (const one of SPORT) {
    if (!sport.some((each) => each.sport_profile_code === one.sport_profile_code)) await createSport(tenant, one)
  }

  const court = await listCourt(tenant, { is_retired_included: true })
  for (const one of COURT) {
    if (!court.some((each) => each.display_name === one.display_name)) await createCourt(tenant, one)
  }

  if ((await listOperatingHour(tenant)).length === 0) {
    await saveOperatingHour(tenant, {
      operating_hour: [1, 2, 3, 4, 5, 6, 7].map((weekday_number) => ({ weekday_number, opens_local: '06:00', closes_local: '23:00' })),
    })
  }

  const [policy] = await tenant.query<{ court_booking_policy_id: Uuid }[]>`
    SELECT court_booking_policy_id FROM court_booking_policy WHERE organization_id = ${organization_id}`
  if (!policy) await saveBookingPolicy(tenant, await readBookingPolicy(tenant))

  const schedule = await listSchedule(tenant)
  for (const sport_code of ['pickleball', 'padel']) {
    if (schedule.some((one) => one.sport_code === sport_code)) continue
    await createSchedule(tenant, {
      sport_code,
      display_name: 'Court rental',
      slot_minute_count: 60,
      capacity_count: 4,
      off_peak_price_amount: '400.00',
      peak_price_amount: '600.00',
      horizon_day_count: 14,
      peak: PEAK,
    })
  }
  await materializeAllSchedule(tenant)

  const active = await listCourt(tenant)
  for (const one of WALK_IN) {
    const [existing] = await tenant.query<{ booking_id: Uuid }[]>`
      SELECT booking_id FROM booking
      WHERE organization_id = ${organization_id} AND detail->>'seed_key' = ${one.seed_key}`
    if (existing) continue
    const target = active.find((each) => each.display_name === one.court)
    if (!target) continue

    // Today at the named hour, or tomorrow when that hour has already passed.
    let date = localDateKey(new Date(), site.time_zone)
    if (zonedToInstant(date, one.starts_local, site.time_zone) <= new Date()) date = addDay(date, 1)
    const starts_at = zonedToInstant(date, one.starts_local, site.time_zone)
    const [session] = await tenant.query<{ session_id: Uuid }[]>`
      SELECT s.session_id FROM session s
      JOIN session_resource sr ON sr.session_id = s.session_id AND sr.resource_id = ${target.resource_id}
      WHERE s.organization_id = ${organization_id} AND s.deleted_at IS NULL AND s.is_published
        AND s.starts_at = ${starts_at}
      LIMIT 1`
    if (!session) continue

    try {
      await tenant.query.savepoint(async () => {
        const booking = await createWalkIn(tenant, {
          session_id: session.session_id,
          resource_id: target.resource_id,
          party_display_name: one.party_display_name,
          phone_number: one.phone_number,
          participant_count: 4,
          is_paid: one.is_paid,
        })
        await tenant.query`
          UPDATE booking SET detail = detail || ${tenant.query.json({ seed_key: one.seed_key })}
          WHERE organization_id = ${organization_id} AND booking_id = ${booking.booking_id}`
      })
    } catch (error) {
      // The slot is taken by something seeded elsewhere; the demo board still has its other walk-in.
      console.warn(`court seed: skipped ${one.seed_key}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
