// Display screens: minting, listing, revoking — and the scoped projection a
// screen pulls. The device lifecycle is the output pack's; this file only
// decides what a court venue's screen shows.

import { DomainError, listEnabledModuleCode, type TenantContext, type Uuid } from '@bygelo/roundrobin-kernel'
import { createConfiguration, mintDevice, revokeDevice } from '@bygelo/roundrobin-output'
import { renderQrSvg } from '@bygelo/roundrobin-scan'
import { listLivePlay } from '../play/contract.ts'
import { isUuid, listMatch, type MatchView } from '../score/service.ts'
import { defaultPublicSite, readStoredDocument, type HeadingFont } from '../studio/schema.ts'

export class DisplayError extends DomainError {}

export const DISPLAY_KIND = ['court', 'lounge', 'counter', 'kiosk'] as const
export type DisplayKind = (typeof DISPLAY_KIND)[number]

export type ScreenStatus = 'online' | 'stale' | 'offline' | 'revoked'

/** A screen refreshes every 5 s; silence past this is visibly stale. */
export const STALE_AFTER_SECOND = 30
/** Silence past this is offline rather than merely late. */
export const OFFLINE_AFTER_SECOND = 300

export function isDisplayKind(value: unknown): value is DisplayKind {
  return typeof value === 'string' && (DISPLAY_KIND as readonly string[]).includes(value)
}

export type ScreenView = {
  display_screen_id: string
  kind: DisplayKind
  display_name: string
  resource_id: string | null
  court_display_name: string | null
  status: ScreenStatus
  credential_prefix: string
  enrolled_at: string | null
  last_seen_at: string | null
  config_version: number
  reported_config_version: number | null
  is_config_behind: boolean
  /** The Studio version the venue has published now (0 = unbranded default). */
  site_version_number: number
  /** The Studio version this screen last said it rendered; null until it reports. */
  reported_site_version_number: number | null
  site_version_reported_at: string | null
  is_site_behind: boolean
  created_at: string
  revoked_at: string | null
}

type ScreenRow = {
  display_screen_id: Uuid
  kind: DisplayKind
  display_name: string
  resource_id: Uuid | null
  court_display_name: string | null
  status: ScreenStatus
  credential_prefix: string
  enrolled_at: Date | null
  last_seen_at: Date | null
  config_version: number
  reported_config_version: number | null
  reported_site_version_number: number | null
  site_version_reported_at: Date | null
  created_at: Date
  revoked_at: Date | null
}

function iso(value: Date | null): string | null {
  return value === null ? null : new Date(value).toISOString()
}

async function selectScreen(tenant: TenantContext, display_screen_id: string | null): Promise<ScreenView[]> {
  const { site_version_number } = await readSiteBrand(tenant)
  // Status is derived on the store clock, like the output pack's own health_status.
  const row = await tenant.query<ScreenRow[]>`
    SELECT s.display_screen_id, s.kind, s.display_name, s.resource_id, r.display_name AS court_display_name,
           d.credential_prefix, d.enrolled_at, d.last_seen_at, d.reported_config_version, d.revoked_at,
           c.config_version, s.created_at, s.reported_site_version_number, s.site_version_reported_at,
           CASE
             WHEN d.revoked_at IS NOT NULL OR NOT d.is_active THEN 'revoked'
             WHEN d.last_seen_at IS NULL THEN 'offline'
             WHEN d.last_seen_at >= now() - make_interval(secs => c.stale_after_second) THEN 'online'
             WHEN d.last_seen_at >= now() - make_interval(secs => ${OFFLINE_AFTER_SECOND}) THEN 'stale'
             ELSE 'offline'
           END AS status
    FROM display_screen s
    JOIN display_device d ON d.organization_id = s.organization_id AND d.display_device_id = s.display_device_id
    JOIN display_configuration c ON c.organization_id = s.organization_id AND c.display_configuration_id = s.display_configuration_id
    LEFT JOIN resource r ON r.organization_id = s.organization_id AND r.resource_id = s.resource_id
    WHERE s.organization_id = ${tenant.organization_id}
      AND s.deleted_at IS NULL
      AND (${display_screen_id}::uuid IS NULL OR s.display_screen_id = ${display_screen_id}::uuid)
    ORDER BY (d.revoked_at IS NOT NULL), s.kind, r.sort_order NULLS FIRST, s.display_name`
  return row.map((one) => {
    const reported = one.reported_config_version === null ? null : Number(one.reported_config_version)
    const reported_site = one.reported_site_version_number === null ? null : Number(one.reported_site_version_number)
    return {
      display_screen_id: one.display_screen_id,
      kind: one.kind,
      display_name: one.display_name,
      resource_id: one.resource_id,
      court_display_name: one.court_display_name,
      status: one.status,
      credential_prefix: one.credential_prefix,
      enrolled_at: iso(one.enrolled_at),
      last_seen_at: iso(one.last_seen_at),
      config_version: Number(one.config_version),
      reported_config_version: reported,
      is_config_behind: reported !== null && reported !== Number(one.config_version),
      site_version_number,
      reported_site_version_number: reported_site,
      site_version_reported_at: iso(one.site_version_reported_at),
      // A rollback appends a new, higher version, so any difference means behind.
      is_site_behind: reported_site !== null && reported_site !== site_version_number,
      created_at: iso(one.created_at)!,
      revoked_at: iso(one.revoked_at),
    }
  })
}

export function listScreen(tenant: TenantContext): Promise<ScreenView[]> {
  return selectScreen(tenant, null)
}

export function enrolmentPath(credential: string): string {
  return `/display?credential=${encodeURIComponent(credential)}`
}

export async function createScreen(
  tenant: TenantContext,
  input: { kind: unknown; display_name: unknown; resource_id?: unknown; actor_id?: string | null },
): Promise<{ screen: ScreenView; credential: string; enrolment_path: string }> {
  if (!isDisplayKind(input.kind)) throw new DisplayError('kind must be court, lounge, counter, or kiosk', 400)
  const kind = input.kind
  const display_name = typeof input.display_name === 'string' ? input.display_name.trim() : ''
  if (!display_name) throw new DisplayError('Give the screen a name, like "Lounge TV"', 400)
  if (display_name.length > 80) throw new DisplayError('The screen name is too long (80 characters at most)', 400)

  let resource_id: string | null = null
  let court_display_name: string | null = null
  if (kind === 'court') {
    if (!isUuid(input.resource_id)) throw new DisplayError('Choose the court this screen shows', 400)
    const [court] = await tenant.query<{ display_name: string }[]>`
      SELECT display_name FROM resource
      WHERE organization_id = ${tenant.organization_id} AND resource_id = ${input.resource_id} AND deleted_at IS NULL`
    if (!court) throw new DisplayError('That court does not exist', 422)
    resource_id = input.resource_id
    court_display_name = court.display_name
  }

  // One configuration per view (the lounge, the counter, each court), shared by
  // every screen showing it — so a published change reaches all of them.
  const configuration_code = kind === 'court' ? `court-display.court.${resource_id}` : `court-display.${kind}`
  const [existing] = await tenant.query<{ display_configuration_id: Uuid }[]>`
    SELECT display_configuration_id FROM display_configuration
    WHERE organization_id = ${tenant.organization_id} AND configuration_code = ${configuration_code}
      AND deleted_at IS NULL AND is_active`
  const display_configuration_id =
    existing?.display_configuration_id ??
    (
      await createConfiguration(tenant, {
        configuration_code,
        display_name:
          kind === 'court' ? `${court_display_name} scoreboard` : kind === 'lounge' ? 'Lounge board' : kind === 'kiosk' ? 'Lobby kiosk' : 'Counter',
        payload: { kind, resource_id },
        stale_after_second: STALE_AFTER_SECOND,
      })
    ).display_configuration_id

  const minted = await mintDevice(tenant, { display_configuration_id, display_name })

  const [row] = await tenant.query<{ display_screen_id: Uuid }[]>`
    INSERT INTO display_screen (organization_id, display_device_id, display_configuration_id, kind,
                                display_name, resource_id, created_by_actor_id)
    VALUES (${tenant.organization_id}, ${minted.device.display_device_id}, ${display_configuration_id}, ${kind},
            ${display_name}, ${resource_id}, ${input.actor_id ?? null})
    RETURNING display_screen_id`
  const [screen] = await selectScreen(tenant, row!.display_screen_id)
  return { screen: screen!, credential: minted.credential, enrolment_path: enrolmentPath(minted.credential) }
}

export async function revokeScreen(tenant: TenantContext, display_screen_id: string): Promise<ScreenView> {
  if (!isUuid(display_screen_id)) throw new DisplayError('screen not found', 404)
  const [row] = await tenant.query<{ display_device_id: Uuid; revoked_at: Date | null; is_active: boolean }[]>`
    SELECT d.display_device_id, d.revoked_at, d.is_active
    FROM display_screen s
    JOIN display_device d ON d.organization_id = s.organization_id AND d.display_device_id = s.display_device_id
    WHERE s.organization_id = ${tenant.organization_id} AND s.display_screen_id = ${display_screen_id}
      AND s.deleted_at IS NULL
    FOR UPDATE OF s`
  if (!row) throw new DisplayError('screen not found', 404)
  if (row.revoked_at !== null || !row.is_active) throw new DisplayError('This screen was already removed', 409)
  await revokeDevice(tenant, row.display_device_id)
  const [screen] = await selectScreen(tenant, display_screen_id)
  return screen!
}

export async function listDisplayCourt(tenant: TenantContext): Promise<{ resource_id: string; display_name: string }[]> {
  return tenant.query<{ resource_id: Uuid; display_name: string }[]>`
    SELECT resource_id, display_name FROM resource
    WHERE organization_id = ${tenant.organization_id} AND deleted_at IS NULL
    ORDER BY sort_order, display_name`
}

// ---------------------------------------------------------------------------
// projection — what a screen is allowed to see
// ---------------------------------------------------------------------------

export type ScreenIdentity = {
  display_screen_id: string
  kind: DisplayKind
  display_name: string
  resource_id: string | null
}

export type LiveScore = {
  status: 'live' | 'complete' | 'confirmed'
  sport_display_name: string
  rule_description: string
  headline: string
  call_out: string
  unit_label: 'game' | 'set'
  serving_team_number: 1 | 2 | null
  server_number: 1 | 2 | null
  winner_team_number: 1 | 2 | null
  team: {
    team_number: 1 | 2
    display_name: string
    point_label: string
    game_count: number
    game_won_count: number
  }[]
  game_history: { point: [number, number]; winner_team_number: 1 | 2 }[]
  updated_at: string
}

export type TimeRange = { starts_at: string; ends_at: string }

export type CourtProjection = {
  court: { display_name: string; sport_display_name: string | null }
  live_match: LiveScore | null
  current_booking: TimeRange | null
  next_booking: TimeRange | null
}

export type LoungeProjection = {
  court: {
    display_name: string
    sport_display_name: string | null
    live_match: LiveScore | null
    current_booking: TimeRange | null
    next_booking: TimeRange | null
  }[]
  open_play: {
    display_name: string
    starts_at: string
    ends_at: string
    court: { display_name: string; player: string[] }[]
    up_next: string[]
    waiting_count: number
  }[]
}

export type CounterProjection = {
  next_available: {
    court_display_name: string
    sport_display_name: string | null
    starts_at: string
    ends_at: string
    price_amount: string
  }[]
  court_count: number
  court_in_use_count: number
  booking_today_count: number
  player_expected_count: number
  open_play_now_count: number
}

function toLiveScore(match: MatchView): LiveScore {
  return {
    status: match.status,
    sport_display_name: match.sport_display_name,
    rule_description: match.rule_description,
    headline: match.state.headline,
    call_out: match.state.call_out,
    unit_label: match.state.unit_label,
    serving_team_number: match.state.is_complete ? null : match.state.serving_team_number,
    server_number: match.state.is_complete ? null : match.state.server_number,
    winner_team_number: match.state.winner_team_number,
    team: match.team.map((team) => {
      const score = match.state.team[team.team_number - 1]!
      return {
        team_number: team.team_number,
        // Names as the scorer typed them — never a party's contact details.
        display_name: team.display_name,
        point_label: score.point_label,
        game_count: score.game_count,
        game_won_count: score.game_won_count,
      }
    }),
    game_history: match.state.game_history.map((one) => ({ point: one.point, winner_team_number: one.winner_team_number })),
    updated_at: match.updated_at,
  }
}

type CourtRow = { resource_id: Uuid; display_name: string; sport_display_name: string | null }

export async function readVenueTimeZone(tenant: TenantContext): Promise<string> {
  const [site] = await tenant.query<{ time_zone: string | null }[]>`
    SELECT time_zone FROM site
    WHERE organization_id = ${tenant.organization_id} AND deleted_at IS NULL
    ORDER BY created_at LIMIT 1`
  return site?.time_zone || 'Asia/Manila'
}

async function readCourt(tenant: TenantContext, resource_id: string | null): Promise<CourtRow[]> {
  return tenant.query<CourtRow[]>`
    SELECT r.resource_id, r.display_name,
           (SELECT rc.display_name FROM resource_category_link l
              JOIN resource_category rc ON rc.resource_category_id = l.resource_category_id
             WHERE l.resource_id = r.resource_id ORDER BY rc.display_name LIMIT 1) AS sport_display_name
    FROM resource r
    WHERE r.organization_id = ${tenant.organization_id} AND r.deleted_at IS NULL
      AND (${resource_id}::uuid IS NULL OR r.resource_id = ${resource_id}::uuid)
    ORDER BY r.sort_order, r.display_name`
}

/** Current and next (today) occupancy per court. Times only — never who booked. */
async function readOccupancy(
  tenant: TenantContext,
  time_zone: string,
  resource_id: string | null,
): Promise<Map<string, { current_booking: TimeRange | null; next_booking: TimeRange | null }>> {
  const row = await tenant.query<{ resource_id: Uuid; starts_at: Date; ends_at: Date; is_current: boolean }[]>`
    WITH day AS (
      SELECT (date_trunc('day', now() AT TIME ZONE ${time_zone}) + interval '1 day') AT TIME ZONE ${time_zone} AS ends_at
    )
    SELECT b.resource_id, b.starts_at, b.ends_at, (b.starts_at <= now()) AS is_current
    FROM booking b, day
    WHERE b.organization_id = ${tenant.organization_id}
      AND b.status IN ('hold', 'confirmed')
      AND b.ends_at > now()
      AND b.starts_at < day.ends_at
      AND (${resource_id}::uuid IS NULL OR b.resource_id = ${resource_id}::uuid)
    ORDER BY b.resource_id, b.starts_at`
  const occupancy = new Map<string, { current_booking: TimeRange | null; next_booking: TimeRange | null }>()
  for (const one of row) {
    const slot = occupancy.get(one.resource_id) ?? { current_booking: null, next_booking: null }
    const range = { starts_at: iso(one.starts_at)!, ends_at: iso(one.ends_at)! }
    if (one.is_current && !slot.current_booking) slot.current_booking = range
    else if (!one.is_current && !slot.next_booking) slot.next_booking = range
    occupancy.set(one.resource_id, slot)
  }
  return occupancy
}

async function readLiveScore(tenant: TenantContext, enabled: string[], resource_id: string | null): Promise<Map<string, LiveScore>> {
  const live = new Map<string, LiveScore>()
  if (!enabled.includes('score')) return live
  // Most recently touched first; a court shows its latest open match.
  const match = await listMatch(tenant, { view: 'live', resource_id, limit_count: 50 })
  for (const one of match) {
    if (one.resource_id && !live.has(one.resource_id)) live.set(one.resource_id, toLiveScore(one))
  }
  return live
}

async function buildCourtProjection(tenant: TenantContext, screen: ScreenIdentity, enabled: string[]): Promise<CourtProjection> {
  const time_zone = await readVenueTimeZone(tenant)
  const [court] = await readCourt(tenant, screen.resource_id)
  if (!court) {
    return { court: { display_name: screen.display_name, sport_display_name: null }, live_match: null, current_booking: null, next_booking: null }
  }
  const occupancy = (await readOccupancy(tenant, time_zone, court.resource_id)).get(court.resource_id)
  const live = await readLiveScore(tenant, enabled, court.resource_id)
  return {
    court: { display_name: court.display_name, sport_display_name: court.sport_display_name },
    live_match: live.get(court.resource_id) ?? null,
    current_booking: occupancy?.current_booking ?? null,
    next_booking: occupancy?.next_booking ?? null,
  }
}

async function buildLoungeProjection(tenant: TenantContext, enabled: string[]): Promise<LoungeProjection> {
  const time_zone = await readVenueTimeZone(tenant)
  const court = await readCourt(tenant, null)
  const occupancy = await readOccupancy(tenant, time_zone, null)
  const live = await readLiveScore(tenant, enabled, null)
  const play = enabled.includes('play') ? await listLivePlay(tenant) : []
  return {
    court: court.map((one) => ({
      display_name: one.display_name,
      sport_display_name: one.sport_display_name,
      live_match: live.get(one.resource_id) ?? null,
      current_booking: occupancy.get(one.resource_id)?.current_booking ?? null,
      next_booking: occupancy.get(one.resource_id)?.next_booking ?? null,
    })),
    open_play: play.map((one) => ({
      display_name: one.display_name,
      starts_at: one.starts_at,
      ends_at: one.ends_at,
      court: one.court.map((each) => ({ display_name: each.display_name, player: each.player.map((player) => player.display_name) })),
      up_next: one.up_next.map((each) => each.display_name),
      waiting_count: one.waiting_count,
    })),
  }
}

async function buildCounterProjection(tenant: TenantContext, enabled: string[]): Promise<CounterProjection> {
  const time_zone = await readVenueTimeZone(tenant)
  const next_available = await tenant.query<{
    court_display_name: string
    sport_display_name: string | null
    starts_at: Date
    ends_at: Date
    price_amount: string
  }[]>`
    WITH day AS (
      SELECT (date_trunc('day', now() AT TIME ZONE ${time_zone}) + interval '1 day') AT TIME ZONE ${time_zone} AS ends_at
    )
    SELECT r.display_name AS court_display_name,
           (SELECT rc.display_name FROM resource_category_link l
              JOIN resource_category rc ON rc.resource_category_id = l.resource_category_id
             WHERE l.resource_id = r.resource_id ORDER BY rc.display_name LIMIT 1) AS sport_display_name,
           s.starts_at, s.ends_at, s.price_amount
    FROM session s
    CROSS JOIN day
    JOIN session_resource sr ON sr.session_id = s.session_id
    JOIN resource r ON r.resource_id = sr.resource_id AND r.organization_id = s.organization_id
    WHERE s.organization_id = ${tenant.organization_id}
      AND s.deleted_at IS NULL AND s.is_published
      AND r.deleted_at IS NULL AND r.is_bookable
      AND s.starts_at > now() AND s.starts_at < day.ends_at
      AND NOT EXISTS (
        SELECT 1 FROM booking b
        WHERE b.organization_id = s.organization_id AND b.resource_id = r.resource_id
          AND b.status IN ('hold', 'confirmed')
          AND tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(s.starts_at, s.ends_at, '[)'))
      AND NOT EXISTS (
        SELECT 1 FROM closure c
        WHERE c.organization_id = s.organization_id
          AND (c.resource_id = r.resource_id OR (c.resource_id IS NULL AND (c.site_id IS NULL OR c.site_id = s.site_id)))
          AND tstzrange(c.starts_at, c.ends_at, '[)') && tstzrange(s.starts_at, s.ends_at, '[)'))
    ORDER BY s.starts_at, r.sort_order, r.display_name
    LIMIT 8`

  const [today] = await tenant.query<{ booking_today_count: number; player_expected_count: number }[]>`
    WITH day AS (
      SELECT date_trunc('day', now() AT TIME ZONE ${time_zone}) AT TIME ZONE ${time_zone} AS starts_at,
             (date_trunc('day', now() AT TIME ZONE ${time_zone}) + interval '1 day') AT TIME ZONE ${time_zone} AS ends_at
    )
    SELECT count(*)::int AS booking_today_count, COALESCE(sum(b.participant_count), 0)::int AS player_expected_count
    FROM booking b, day
    WHERE b.organization_id = ${tenant.organization_id}
      AND b.status = 'confirmed'
      AND b.starts_at >= day.starts_at AND b.starts_at < day.ends_at`

  const court = await readCourt(tenant, null)
  const occupancy = await readOccupancy(tenant, time_zone, null)
  const live = await readLiveScore(tenant, enabled, null)
  const in_use = court.filter((one) => occupancy.get(one.resource_id)?.current_booking || live.has(one.resource_id))
  const play = enabled.includes('play') ? await listLivePlay(tenant) : []

  return {
    next_available: next_available.map((one) => ({
      court_display_name: one.court_display_name,
      sport_display_name: one.sport_display_name,
      starts_at: iso(one.starts_at)!,
      ends_at: iso(one.ends_at)!,
      price_amount: String(one.price_amount),
    })),
    court_count: court.length,
    court_in_use_count: in_use.length,
    booking_today_count: Number(today?.booking_today_count ?? 0),
    player_expected_count: Number(today?.player_expected_count ?? 0),
    open_play_now_count: play.length,
  }
}

/** How far ahead the kiosk looks for open court slots (capped at the end of today). */
export const KIOSK_HORIZON_HOUR = 4
/** Open slots listed per court on the kiosk. */
export const KIOSK_SLOT_PER_COURT = 4

export type KioskProjection = {
  court: {
    display_name: string
    sport_display_name: string | null
    open_slot: { starts_at: string; ends_at: string; price_amount: string }[]
  }[]
  /** Open play running now or starting within the hour. Counts only — never who is playing or waiting. */
  open_play: {
    display_name: string
    starts_at: string
    ends_at: string
    is_now: boolean
    court_count: number
    waiting_count: number
  }[]
  /** Programs starting later today. Seat counts only — never who registered. */
  program: {
    title: string
    kind_code: string
    starts_at: string
    ends_at: string
    seat_open_count: number
    price_amount: string
  }[]
  /** Null when the booking portal is off: there is nothing to book on a phone. */
  booking: { path: string; url: string; qr_svg: string } | null
}

export type ScreenProjection = CourtProjection | LoungeProjection | CounterProjection | KioskProjection

/** Where a phone should open the booking page: an absolute http(s) origin, or undefined. */
export function normaliseOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 200) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined
  } catch {
    return undefined
  }
}

async function buildKioskProjection(tenant: TenantContext, enabled: string[], origin: string | undefined): Promise<KioskProjection> {
  const time_zone = await readVenueTimeZone(tenant)
  const slot = await tenant.query<{
    resource_id: Uuid
    starts_at: Date
    ends_at: Date
    price_amount: string
  }[]>`
    WITH day AS (
      SELECT (date_trunc('day', now() AT TIME ZONE ${time_zone}) + interval '1 day') AT TIME ZONE ${time_zone} AS ends_at
    )
    SELECT r.resource_id, s.starts_at, s.ends_at, s.price_amount
    FROM session s
    CROSS JOIN day
    JOIN session_resource sr ON sr.session_id = s.session_id
    JOIN resource r ON r.resource_id = sr.resource_id AND r.organization_id = s.organization_id
    WHERE s.organization_id = ${tenant.organization_id}
      AND s.deleted_at IS NULL AND s.is_published
      AND r.deleted_at IS NULL AND r.is_bookable
      AND s.starts_at > now()
      AND s.starts_at < LEAST(day.ends_at, now() + make_interval(hours => ${KIOSK_HORIZON_HOUR}))
      AND NOT EXISTS (
        SELECT 1 FROM booking b
        WHERE b.organization_id = s.organization_id AND b.resource_id = r.resource_id
          AND b.status IN ('hold', 'confirmed')
          AND tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(s.starts_at, s.ends_at, '[)'))
      AND NOT EXISTS (
        SELECT 1 FROM closure c
        WHERE c.organization_id = s.organization_id
          AND (c.resource_id = r.resource_id OR (c.resource_id IS NULL AND (c.site_id IS NULL OR c.site_id = s.site_id)))
          AND tstzrange(c.starts_at, c.ends_at, '[)') && tstzrange(s.starts_at, s.ends_at, '[)'))
    ORDER BY r.resource_id, s.starts_at`
  const by_court = new Map<string, KioskProjection['court'][number]['open_slot']>()
  for (const one of slot) {
    const list = by_court.get(one.resource_id) ?? []
    if (list.length < KIOSK_SLOT_PER_COURT) {
      list.push({ starts_at: iso(one.starts_at)!, ends_at: iso(one.ends_at)!, price_amount: String(one.price_amount) })
    }
    by_court.set(one.resource_id, list)
  }
  const court = (await readCourt(tenant, null)).map((one) => ({
    display_name: one.display_name,
    sport_display_name: one.sport_display_name,
    open_slot: by_court.get(one.resource_id) ?? [],
  }))

  const now = Date.now()
  const play = enabled.includes('play') ? await listLivePlay(tenant) : []
  const open_play = play.map((one) => ({
    display_name: one.display_name,
    starts_at: one.starts_at,
    ends_at: one.ends_at,
    is_now: new Date(one.starts_at).getTime() <= now,
    court_count: one.court.length,
    waiting_count: one.waiting_count,
  }))

  let program: KioskProjection['program'] = []
  const [table] = await tenant.query<{ is_present: boolean }[]>`
    SELECT to_regclass('public.program_occurrence') IS NOT NULL
       AND to_regclass('public.program_registration') IS NOT NULL AS is_present`
  if (enabled.includes('program') && table?.is_present) {
    const row = await tenant.query<{
      title: string
      kind_code: string
      starts_at: Date
      ends_at: Date
      capacity_count: number
      taken_count: number
      price_amount: string
    }[]>`
      WITH day AS (
        SELECT (date_trunc('day', now() AT TIME ZONE ${time_zone}) + interval '1 day') AT TIME ZONE ${time_zone} AS ends_at
      )
      SELECT p.title, p.kind_code, o.starts_at, o.ends_at, o.capacity_count, p.price_amount,
             (SELECT count(*)::int FROM program_registration g
               WHERE g.organization_id = o.organization_id AND g.program_occurrence_id = o.program_occurrence_id
                 AND g.status_code IN ('registered', 'attended')) AS taken_count
      FROM program_occurrence o
      CROSS JOIN day
      JOIN program p ON p.organization_id = o.organization_id AND p.program_id = o.program_id
      WHERE o.organization_id = ${tenant.organization_id}
        AND o.status_code = 'scheduled'
        AND p.deleted_at IS NULL AND p.is_published AND NOT p.is_member_only
        AND p.kind_code <> 'private_event'
        AND o.ends_at > now() AND o.starts_at < day.ends_at
      ORDER BY o.starts_at, p.title
      LIMIT 6`
    program = row.map((one) => ({
      title: one.title,
      kind_code: one.kind_code,
      starts_at: iso(one.starts_at)!,
      ends_at: iso(one.ends_at)!,
      seat_open_count: Math.max(0, Number(one.capacity_count) - Number(one.taken_count)),
      price_amount: String(one.price_amount),
    }))
  }

  let booking: KioskProjection['booking'] = null
  if (enabled.includes('portal')) {
    const [organization] = await tenant.query<{ organization_code: string }[]>`
      SELECT organization_code FROM organization WHERE organization_id = ${tenant.organization_id}`
    if (organization) {
      const path = `/v/${encodeURIComponent(organization.organization_code)}`
      const url = `${origin ?? ''}${path}`
      booking = { path, url, qr_svg: renderQrSvg(url, { level: 'M', quiet_zone: 4, title: 'Scan to book a court on your phone' }) }
    }
  }

  return { court, open_play, program, booking }
}

export async function buildProjection(
  tenant: TenantContext,
  screen: ScreenIdentity,
  option: { origin?: string | undefined } = {},
): Promise<ScreenProjection> {
  const enabled = await listEnabledModuleCode(tenant)
  if (screen.kind === 'court') return buildCourtProjection(tenant, screen, enabled)
  if (screen.kind === 'lounge') return buildLoungeProjection(tenant, enabled)
  if (screen.kind === 'kiosk') return buildKioskProjection(tenant, enabled, option.origin)
  return buildCounterProjection(tenant, enabled)
}

// ---------------------------------------------------------------------------
// Studio brand — what every screen is dressed in
// ---------------------------------------------------------------------------

export type SiteBrand = {
  /** The published studio_version.version_number, or 0 for the unbranded default. */
  site_version_number: number
  display_name: string
  accent: string
  action: string
  heading_font: HeadingFont
}

/**
 * The venue's published Studio version and brand tokens, read-only. Falls back
 * to the default site (version 0) when Studio is off or nothing is published —
 * the same rule the public portal follows.
 */
export async function readSiteBrand(tenant: TenantContext): Promise<SiteBrand> {
  const enabled = await listEnabledModuleCode(tenant)
  const [organization] = await tenant.query<{ organization_code: string; display_name: string }[]>`
    SELECT organization_code, display_name FROM organization WHERE organization_id = ${tenant.organization_id}`
  const venue_name = organization?.display_name ?? ''
  const [publication] = enabled.includes('studio')
    ? await tenant.query<{ version_number: number; document: unknown }[]>`
        SELECT v.version_number, v.document
        FROM studio_publication p
        JOIN studio_version v ON v.organization_id = p.organization_id AND v.studio_version_id = p.studio_version_id
        WHERE p.organization_id = ${tenant.organization_id}`
    : []
  if (!publication) {
    const site = defaultPublicSite(organization?.organization_code ?? '', venue_name, enabled)
    return { site_version_number: 0, display_name: site.display_name, ...pickToken(site.token) }
  }
  const raw = typeof publication.document === 'string' ? (JSON.parse(publication.document) as unknown) : publication.document
  const document = readStoredDocument(raw, venue_name)
  return { site_version_number: Number(publication.version_number), display_name: document.display_name, ...pickToken(document.token) }
}

function pickToken(token: { accent: string; action: string; heading_font: HeadingFont }): Pick<SiteBrand, 'accent' | 'action' | 'heading_font'> {
  return { accent: token.accent, action: token.action, heading_font: token.heading_font }
}

/** Record the Studio version a screen says it last rendered. */
export async function recordSiteVersion(tenant: TenantContext, display_screen_id: string, site_version_number: number): Promise<void> {
  await tenant.query`
    UPDATE display_screen
    SET reported_site_version_number = ${site_version_number}, site_version_reported_at = now()
    WHERE organization_id = ${tenant.organization_id} AND display_screen_id = ${display_screen_id}`
}
