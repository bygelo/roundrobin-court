// Sport profile — the one file where a sport is named.
//
// R08: a sport is data. This file holds the profile vocabulary (the scoring
// rules the app knows how to score, the rating providers it knows) and the
// profile CRUD. No other court service file names a sport; the static check in
// test/venue-sport.test.ts turns red if one does.

import type { TenantContext, Uuid } from '@bygelo/roundrobin-kernel'
import {
  CourtConflictError,
  CourtInputError,
  CourtNotFoundError,
  has,
  plural,
  readInteger,
  readOptionalText,
  readText,
  type Body,
} from './input.ts'

/**
 * The venue's own vocabulary, supplied to the booking pack as data: a resource
 * category per sport. No service rule anywhere branches on which one.
 */
export const SPORT_CATEGORY = [
  { resource_category_code: 'pickleball', display_name: 'Pickleball court', team_size_count: 2 },
  { resource_category_code: 'tennis', display_name: 'Tennis court', team_size_count: 2 },
  { resource_category_code: 'badminton', display_name: 'Badminton court', team_size_count: 2 },
  { resource_category_code: 'padel', display_name: 'Padel court', team_size_count: 2 },
] as const

/** Scoring rules the scorer implements. Mirrors the CHECK in migration/002_venue.sql. */
export const SCORING_RULE = [
  { scoring_rule_code: 'side_out_11', display_name: 'Side-out scoring to 11' },
  { scoring_rule_code: 'side_out_15', display_name: 'Side-out scoring to 15' },
  { scoring_rule_code: 'side_out_21', display_name: 'Side-out scoring to 21' },
  { scoring_rule_code: 'rally_11', display_name: 'Rally scoring to 11' },
  { scoring_rule_code: 'rally_15', display_name: 'Rally scoring to 15' },
  { scoring_rule_code: 'rally_21', display_name: 'Rally scoring to 21' },
  { scoring_rule_code: 'badminton_rally_21', display_name: 'Badminton rally to 21' },
  { scoring_rule_code: 'tennis_set', display_name: 'Tennis games and sets' },
  { scoring_rule_code: 'padel_set', display_name: 'Padel games and sets' },
] as const

export const RATING_PROVIDER = [
  { rating_provider_code: 'dupr', display_name: 'DUPR' },
  { rating_provider_code: 'utr', display_name: 'UTR' },
] as const

const SCORING_RULE_CODE = new Set<string>(SCORING_RULE.map((one) => one.scoring_rule_code))
const RATING_PROVIDER_CODE = new Set<string>(RATING_PROVIDER.map((one) => one.rating_provider_code))

export type SportProfile = {
  sport_profile_id: Uuid
  sport_profile_code: string
  display_name: string
  team_size_count: number
  scoring_rule_code: string
  rating_provider_code: string | null
  session_minute_count: number
  court_count: number
}

export async function listSport(tenant: TenantContext): Promise<SportProfile[]> {
  const row = await tenant.query<SportProfile[]>`
    SELECT sp.sport_profile_id, sp.sport_profile_code, sp.display_name, sp.team_size_count,
           sp.scoring_rule_code, sp.rating_provider_code, sp.session_minute_count,
           (SELECT count(*)::int FROM resource_category rc
              JOIN resource_category_link rcl ON rcl.resource_category_id = rc.resource_category_id
              JOIN resource r ON r.resource_id = rcl.resource_id AND r.deleted_at IS NULL
             WHERE rc.organization_id = sp.organization_id
               AND rc.resource_category_code = sp.sport_profile_code) AS court_count
    FROM sport_profile sp
    WHERE sp.organization_id = ${tenant.organization_id}
    ORDER BY sp.display_name`
  return [...row]
}

function readScoringRule(body: Body): string {
  const value = body['scoring_rule_code']
  if (typeof value !== 'string' || !SCORING_RULE_CODE.has(value)) {
    throw new CourtInputError('Choose a scoring rule from the list.')
  }
  return value
}

function readRatingProvider(body: Body): string | null {
  const value = body['rating_provider_code']
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string' || !RATING_PROVIDER_CODE.has(value)) {
    throw new CourtInputError('Rating provider must be DUPR, UTR, or none.')
  }
  return value
}

function readSessionMinute(body: Body): number {
  const value = readInteger(body, 'session_minute_count', 'Default session length', 60, 120)
  if (![60, 90, 120].includes(value)) throw new CourtInputError('Default session length must be 60, 90, or 120 minutes.')
  return value
}

/** Keep the booking pack's resource_category in step with the profile. */
export async function ensureSportCategory(tenant: TenantContext, sport_code: string, display_name: string): Promise<Uuid> {
  const [row] = await tenant.query<{ resource_category_id: Uuid }[]>`
    INSERT INTO resource_category (organization_id, resource_category_code, display_name)
    VALUES (${tenant.organization_id}, ${sport_code}, ${display_name})
    ON CONFLICT (organization_id, resource_category_code)
      DO UPDATE SET display_name = EXCLUDED.display_name
    RETURNING resource_category_id`
  return row!.resource_category_id
}

export async function createSport(tenant: TenantContext, body: Body): Promise<SportProfile> {
  const display_name = readText(body, 'display_name', 'Sport name', { max: 60 })
  const raw_code = readOptionalText(body, 'sport_profile_code', 'Sport code', { max: 40 })
  const sport_profile_code = (raw_code ?? display_name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (!/^[a-z][a-z0-9_]{0,39}$/.test(sport_profile_code)) {
    throw new CourtInputError('Sport code must start with a letter and use only lowercase letters, digits, and underscores.')
  }
  const team_size_count = readInteger(body, 'team_size_count', 'Players per side', 1, 12)
  const scoring_rule_code = readScoringRule(body)
  const rating_provider_code = readRatingProvider(body)
  const session_minute_count = has(body, 'session_minute_count') ? readSessionMinute(body) : 60

  const [existing] = await tenant.query<{ sport_profile_id: Uuid }[]>`
    SELECT sport_profile_id FROM sport_profile
    WHERE organization_id = ${tenant.organization_id} AND sport_profile_code = ${sport_profile_code}`
  if (existing) throw new CourtConflictError(`A sport with the code "${sport_profile_code}" already exists.`)

  const [row] = await tenant.query<{ sport_profile_id: Uuid }[]>`
    INSERT INTO sport_profile (organization_id, sport_profile_code, display_name, team_size_count,
                               scoring_rule_code, rating_provider_code, session_minute_count)
    VALUES (${tenant.organization_id}, ${sport_profile_code}, ${display_name}, ${team_size_count},
            ${scoring_rule_code}, ${rating_provider_code}, ${session_minute_count})
    RETURNING sport_profile_id`
  await ensureSportCategory(tenant, sport_profile_code, display_name)
  return findSport(tenant, row!.sport_profile_id)
}

export async function findSport(tenant: TenantContext, sport_profile_id: Uuid): Promise<SportProfile> {
  const sport = (await listSport(tenant)).find((one) => one.sport_profile_id === sport_profile_id)
  if (!sport) throw new CourtNotFoundError('That sport does not exist.')
  return sport
}

export async function updateSport(tenant: TenantContext, sport_profile_id: Uuid, body: Body): Promise<SportProfile> {
  const prior = await findSport(tenant, sport_profile_id)
  const display_name = has(body, 'display_name') ? readText(body, 'display_name', 'Sport name', { max: 60 }) : prior.display_name
  const team_size_count = has(body, 'team_size_count')
    ? readInteger(body, 'team_size_count', 'Players per side', 1, 12)
    : prior.team_size_count
  const scoring_rule_code = has(body, 'scoring_rule_code') ? readScoringRule(body) : prior.scoring_rule_code
  const rating_provider_code = Object.prototype.hasOwnProperty.call(body, 'rating_provider_code')
    ? readRatingProvider(body)
    : prior.rating_provider_code
  const session_minute_count = has(body, 'session_minute_count') ? readSessionMinute(body) : prior.session_minute_count

  await tenant.query`
    UPDATE sport_profile
    SET display_name = ${display_name}, team_size_count = ${team_size_count},
        scoring_rule_code = ${scoring_rule_code}, rating_provider_code = ${rating_provider_code},
        session_minute_count = ${session_minute_count}
    WHERE organization_id = ${tenant.organization_id} AND sport_profile_id = ${sport_profile_id}`
  await ensureSportCategory(tenant, prior.sport_profile_code, display_name)
  return findSport(tenant, sport_profile_id)
}

export async function deleteSport(tenant: TenantContext, sport_profile_id: Uuid): Promise<void> {
  const sport = await findSport(tenant, sport_profile_id)
  if (sport.court_count > 0) {
    throw new CourtConflictError(
      `${plural(sport.court_count, 'court')} ${sport.court_count === 1 ? 'is' : 'are'} set up for ${sport.display_name}. Move them to another sport or retire them first.`,
    )
  }
  await tenant.query`
    DELETE FROM sport_profile
    WHERE organization_id = ${tenant.organization_id} AND sport_profile_id = ${sport_profile_id}`
  // The category goes too unless a retired court still carries it as history.
  await tenant.query`
    DELETE FROM resource_category rc
    WHERE rc.organization_id = ${tenant.organization_id}
      AND rc.resource_category_code = ${sport.sport_profile_code}
      AND NOT EXISTS (SELECT 1 FROM resource_category_link rcl WHERE rcl.resource_category_id = rc.resource_category_id)`
}
