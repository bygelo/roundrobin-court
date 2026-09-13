// Member — membership plans with a court price rule, passes, and the pricing /
// entitlement port a booking consults (contract.ts).
//
// Writes go through the membership pack where it has a service (createPlan,
// issueMembership, freezeMembership, issuePass, consumePass). Unfreeze and
// cancel have no pack service and update the tenant's own membership row.

import { randomBytes } from 'node:crypto'
import { DomainError, listEnabledModuleCode, recordAuditEvent, type TenantContext, type Uuid } from '@bygelo/roundrobin-kernel'
import { consumePass, createPlan, freezeMembership, issueMembership, issuePass } from '@bygelo/roundrobin-membership'
import { displayPeso, fromCentavo, toCentavo } from '../shop/money.ts'
import {
  DEFAULT_TIME_ZONE,
  addDay,
  applyPriceRule,
  isDate,
  localDate,
  memberStatus,
  periodEnd,
  ruleSentence,
  startOfLocalDay,
  type BillingPeriodCode,
  type MemberStatusCode,
  type PlanKindCode,
  type PriceRuleCode,
} from './rule.ts'

export class MemberError extends DomainError {
  constructor(message: string, http_status = 400) {
    super(message, http_status)
  }
}

export type MemberPlan = {
  member_plan_id: Uuid
  membership_plan_id: Uuid
  plan_code: string
  display_name: string
  plan_kind_code: PlanKindCode
  price_amount: string
  billing_period_code: BillingPeriodCode | null
  price_rule_code: PriceRuleCode
  percent_off: string | null
  fixed_price_amount: string | null
  is_member_session_access: boolean
  session_count: number | null
  valid_day_count: number | null
  rule_sentence: string
  holder_count: number
}

export type MemberPass = {
  pass_id: Uuid
  plan_name: string
  status: string
  use_limit: number | null
  use_count: number
  remaining_count: number | null
  valid_until: string
}

export type Member = {
  party_id: Uuid
  display_name: string
  email_address: string | null
  phone_number: string | null
  membership_id: Uuid | null
  plan_name: string | null
  starts_at: string | null
  ends_at: string | null
  frozen_until: string | null
  status_code: MemberStatusCode
  pass_remaining_count: number
  pass: MemberPass[]
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new MemberError(`${label} is required`)
  return value.trim()
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function positiveCount(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) throw new MemberError(`${label} must be a whole number above zero`)
  return value
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
}

/** The venue's zone: a site's own time_zone, else the organization's, else Manila. */
export async function venueTimeZone(tenant: TenantContext): Promise<string> {
  const [row] = await tenant.query<{ time_zone: string | null }[]>`
    SELECT coalesce(
      (SELECT time_zone FROM site
        WHERE organization_id = ${tenant.organization_id}::uuid AND deleted_at IS NULL AND time_zone IS NOT NULL
        ORDER BY created_at LIMIT 1),
      (SELECT time_zone FROM organization WHERE organization_id = ${tenant.organization_id}::uuid)
    ) AS time_zone`
  return row?.time_zone ?? DEFAULT_TIME_ZONE
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

type PlanRow = Omit<MemberPlan, 'rule_sentence' | 'holder_count'> & { holder_count: number }

async function readPlan(tenant: TenantContext, filter: { member_plan_id?: Uuid } = {}): Promise<MemberPlan[]> {
  const row = await tenant.query<PlanRow[]>`
    SELECT p.member_plan_id, p.membership_plan_id, mp.plan_code, mp.display_name, p.plan_kind_code,
           p.price_amount::text AS price_amount, p.billing_period_code, p.price_rule_code,
           p.percent_off::text AS percent_off, p.fixed_price_amount::text AS fixed_price_amount,
           p.is_member_session_access, p.session_count, p.valid_day_count,
           CASE WHEN p.plan_kind_code = 'membership'
             THEN (SELECT count(*)::int FROM membership m
                   WHERE m.organization_id = p.organization_id AND m.membership_plan_id = p.membership_plan_id
                     AND m.deleted_at IS NULL AND m.status IN ('active', 'frozen')
                     AND (m.ends_at IS NULL OR m.ends_at > now()))
             ELSE (SELECT count(*)::int FROM member_pass x JOIN pass ps ON ps.pass_id = x.pass_id
                   WHERE x.organization_id = p.organization_id AND x.member_plan_id = p.member_plan_id
                     AND ps.status = 'active' AND ps.valid_until > now())
           END AS holder_count
    FROM member_plan p
    JOIN membership_plan mp ON mp.membership_plan_id = p.membership_plan_id AND mp.organization_id = p.organization_id
    WHERE p.organization_id = ${tenant.organization_id}::uuid AND p.deleted_at IS NULL AND mp.deleted_at IS NULL
      ${filter.member_plan_id ? tenant.query`AND p.member_plan_id = ${filter.member_plan_id}::uuid` : tenant.query``}
    ORDER BY p.plan_kind_code, p.price_amount, mp.display_name`
  return row.map((one) => {
    const plan = {
      member_plan_id: String(one.member_plan_id),
      membership_plan_id: String(one.membership_plan_id),
      plan_code: one.plan_code,
      display_name: one.display_name,
      plan_kind_code: one.plan_kind_code,
      price_amount: fromCentavo(toCentavo(one.price_amount)),
      billing_period_code: one.billing_period_code,
      price_rule_code: one.price_rule_code,
      percent_off: one.percent_off === null ? null : String(Number(one.percent_off)),
      fixed_price_amount: one.fixed_price_amount === null ? null : fromCentavo(toCentavo(one.fixed_price_amount)),
      is_member_session_access: Boolean(one.is_member_session_access),
      session_count: one.session_count === null ? null : Number(one.session_count),
      valid_day_count: one.valid_day_count === null ? null : Number(one.valid_day_count),
      holder_count: Number(one.holder_count),
    }
    return { ...plan, rule_sentence: ruleSentence(plan) }
  })
}

export async function listMemberPlan(tenant: TenantContext): Promise<MemberPlan[]> {
  return readPlan(tenant)
}

export async function findMemberPlan(tenant: TenantContext, member_plan_id: Uuid): Promise<MemberPlan> {
  const [plan] = await readPlan(tenant, { member_plan_id })
  if (!plan) throw new MemberError('plan not found', 404)
  return plan
}

export async function createMemberPlan(tenant: TenantContext, input: Record<string, unknown>): Promise<MemberPlan> {
  const display_name = requireText(input['display_name'], 'display_name')
  const plan_kind_code = input['plan_kind_code']
  if (plan_kind_code !== 'membership' && plan_kind_code !== 'pass') throw new MemberError('plan_kind_code must be membership or pass')
  const price_amount = fromCentavo(toCentavo(input['price_amount'], 'price_amount'))

  let billing_period_code: BillingPeriodCode | null = null
  let price_rule_code: PriceRuleCode = 'none'
  let percent_off: string | null = null
  let fixed_price_amount: string | null = null
  let is_member_session_access = false
  let session_count: number | null = null
  let valid_day_count: number | null = null

  if (plan_kind_code === 'membership') {
    const period = input['billing_period_code']
    if (period !== 'monthly' && period !== 'annual') throw new MemberError('billing_period_code must be monthly or annual')
    billing_period_code = period
    const rule = input['price_rule_code'] ?? 'none'
    if (rule !== 'none' && rule !== 'percent_off' && rule !== 'fixed_price') {
      throw new MemberError('price_rule_code must be none, percent_off, or fixed_price')
    }
    price_rule_code = rule
    if (rule === 'percent_off') {
      const hundredth = toCentavo(input['percent_off'], 'percent_off')
      if (hundredth <= 0 || hundredth > 10000) throw new MemberError('percent_off must be above 0 and at most 100')
      percent_off = fromCentavo(hundredth)
    }
    if (rule === 'fixed_price') fixed_price_amount = fromCentavo(toCentavo(input['fixed_price_amount'], 'fixed_price_amount'))
    is_member_session_access = input['is_member_session_access'] === true
  } else {
    session_count = positiveCount(input['session_count'], 'session_count')
    valid_day_count = positiveCount(input['valid_day_count'], 'valid_day_count')
  }

  const plan_code = optionalText(input['plan_code']) ?? `${slug(display_name) || 'plan'}-${randomBytes(3).toString('hex')}`
  const pack_plan = await createPlan(tenant, { plan_code, display_name })
  const [row] = await tenant.query<{ member_plan_id: Uuid }[]>`
    INSERT INTO member_plan (
      organization_id, membership_plan_id, plan_kind_code, price_amount, billing_period_code,
      price_rule_code, percent_off, fixed_price_amount, is_member_session_access, session_count, valid_day_count
    ) VALUES (
      ${tenant.organization_id}::uuid, ${pack_plan.membership_plan_id}::uuid, ${plan_kind_code}, ${price_amount}::numeric,
      ${billing_period_code}, ${price_rule_code}, ${percent_off}::numeric, ${fixed_price_amount}::numeric,
      ${is_member_session_access}, ${session_count}, ${valid_day_count}
    ) RETURNING member_plan_id`
  return findMemberPlan(tenant, String(row!.member_plan_id))
}

// ---------------------------------------------------------------------------
// party
// ---------------------------------------------------------------------------

/** Find the tenant's party by email (case-insensitive), or create one. Serialized per email. */
export async function findOrCreateParty(
  tenant: TenantContext,
  input: { display_name: unknown; email: unknown; phone?: unknown },
): Promise<Uuid> {
  const email = requireText(input.email, 'email').toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new MemberError('email does not look like an email address')
  await tenant.query`SELECT pg_advisory_xact_lock(hashtext(${`member.party:${tenant.organization_id}:${email}`}))`
  const [existing] = await tenant.query<{ party_id: Uuid; phone_number: string | null }[]>`
    SELECT party_id, phone_number FROM party
    WHERE organization_id = ${tenant.organization_id}::uuid AND deleted_at IS NULL
      AND lower(email_address) = ${email}
    ORDER BY created_at LIMIT 1`
  const phone = optionalText(input.phone)
  if (existing) {
    if (phone && !existing.phone_number) {
      await tenant.query`UPDATE party SET phone_number = ${phone} WHERE party_id = ${existing.party_id}::uuid`
    }
    return String(existing.party_id)
  }
  const display_name = requireText(input.display_name, 'display_name')
  const [created] = await tenant.query<{ party_id: Uuid }[]>`
    INSERT INTO party (organization_id, display_name, email_address, phone_number)
    VALUES (${tenant.organization_id}::uuid, ${display_name}, ${email}, ${phone})
    RETURNING party_id`
  return String(created!.party_id)
}

// ---------------------------------------------------------------------------
// member
// ---------------------------------------------------------------------------

export async function listMember(
  tenant: TenantContext,
  filter: { status?: string | undefined; search?: string | undefined; party_id?: Uuid } = {},
): Promise<Member[]> {
  const search = filter.search?.trim() ? `%${filter.search.trim().toLowerCase()}%` : null
  const row = await tenant.query<
    {
      party_id: Uuid
      display_name: string
      email_address: string | null
      phone_number: string | null
      membership_id: Uuid | null
      plan_name: string | null
      status: string | null
      starts_at: Date | null
      ends_at: Date | null
      frozen_until: Date | null
    }[]
  >`
    WITH holder AS (
      SELECT party_id FROM membership
      WHERE organization_id = ${tenant.organization_id}::uuid AND deleted_at IS NULL
      UNION
      SELECT ps.party_id FROM member_pass x JOIN pass ps ON ps.pass_id = x.pass_id AND ps.organization_id = x.organization_id
      WHERE x.organization_id = ${tenant.organization_id}::uuid AND ps.party_id IS NOT NULL
    ), latest AS (
      SELECT DISTINCT ON (m.party_id) m.party_id, m.membership_id, m.status::text AS status, m.starts_at, m.ends_at,
             m.frozen_until, mp.display_name AS plan_name
      FROM membership m
      JOIN membership_plan mp ON mp.membership_plan_id = m.membership_plan_id AND mp.organization_id = m.organization_id
      WHERE m.organization_id = ${tenant.organization_id}::uuid AND m.deleted_at IS NULL
      ORDER BY m.party_id, (m.status IN ('active', 'frozen')) DESC, m.starts_at DESC
    )
    SELECT p.party_id, p.display_name, p.email_address, p.phone_number,
           l.membership_id, l.plan_name, l.status, l.starts_at, l.ends_at, l.frozen_until
    FROM holder h
    JOIN party p ON p.party_id = h.party_id AND p.organization_id = ${tenant.organization_id}::uuid AND p.deleted_at IS NULL
    LEFT JOIN latest l ON l.party_id = h.party_id
    WHERE true
      ${filter.party_id ? tenant.query`AND p.party_id = ${filter.party_id}::uuid` : tenant.query``}
      ${
        search
          ? tenant.query`AND (lower(p.display_name) LIKE ${search} OR lower(coalesce(p.email_address, '')) LIKE ${search}
                              OR coalesce(p.phone_number, '') LIKE ${search})`
          : tenant.query``
      }
    ORDER BY p.display_name
    LIMIT 500`

  const pass_by_party = await readPass(tenant, row.map((one) => String(one.party_id)))
  const now = new Date()
  const member = row.map((one): Member => {
    const pass = pass_by_party.get(String(one.party_id)) ?? []
    return {
      party_id: String(one.party_id),
      display_name: one.display_name,
      email_address: one.email_address,
      phone_number: one.phone_number,
      membership_id: one.membership_id === null ? null : String(one.membership_id),
      plan_name: one.plan_name,
      starts_at: one.starts_at ? new Date(one.starts_at).toISOString() : null,
      ends_at: one.ends_at ? new Date(one.ends_at).toISOString() : null,
      frozen_until: one.frozen_until ? new Date(one.frozen_until).toISOString() : null,
      status_code: memberStatus({ status: one.status, ends_at: one.ends_at ? new Date(one.ends_at) : null, now }),
      pass_remaining_count: pass
        .filter((each) => each.status === 'active' && new Date(each.valid_until) > now)
        .reduce((sum, each) => sum + (each.remaining_count ?? 0), 0),
      pass,
    }
  })
  return filter.status ? member.filter((one) => one.status_code === filter.status) : member
}

async function readPass(tenant: TenantContext, party_id: Uuid[]): Promise<Map<string, MemberPass[]>> {
  const result = new Map<string, MemberPass[]>()
  if (party_id.length === 0) return result
  const row = await tenant.query<
    { party_id: Uuid; pass_id: Uuid; plan_name: string; status: string; use_limit: number | null; use_count: number; valid_until: Date }[]
  >`
    SELECT ps.party_id, ps.pass_id, mp.display_name AS plan_name, ps.status::text AS status, ps.use_limit, ps.use_count, ps.valid_until
    FROM member_pass x
    JOIN pass ps ON ps.pass_id = x.pass_id AND ps.organization_id = x.organization_id
    JOIN member_plan p ON p.member_plan_id = x.member_plan_id
    JOIN membership_plan mp ON mp.membership_plan_id = p.membership_plan_id
    WHERE x.organization_id = ${tenant.organization_id}::uuid AND ps.deleted_at IS NULL
      AND ps.party_id IN ${tenant.query(party_id)}
    ORDER BY ps.valid_until DESC`
  for (const one of row) {
    const list = result.get(String(one.party_id)) ?? []
    const use_limit = one.use_limit === null ? null : Number(one.use_limit)
    list.push({
      pass_id: String(one.pass_id),
      plan_name: one.plan_name,
      status: one.status,
      use_limit,
      use_count: Number(one.use_count),
      remaining_count: use_limit === null ? null : Math.max(use_limit - Number(one.use_count), 0),
      valid_until: new Date(one.valid_until).toISOString(),
    })
    result.set(String(one.party_id), list)
  }
  return result
}

async function findMember(tenant: TenantContext, party_id: Uuid): Promise<Member> {
  const [member] = await listMember(tenant, { party_id })
  if (!member) throw new MemberError('member not found', 404)
  return member
}

export async function enrolMember(tenant: TenantContext, input: Record<string, unknown>): Promise<Member> {
  const plan = await findMemberPlan(tenant, requireText(input['plan_id'], 'plan_id'))
  if (plan.plan_kind_code !== 'membership') throw new MemberError(`${plan.display_name} is a pass — issue it as a pass`)
  const time_zone = await venueTimeZone(tenant)
  const starts_on = input['starts_on'] === undefined || input['starts_on'] === '' ? localDate(new Date(), time_zone) : input['starts_on']
  if (!isDate(starts_on)) throw new MemberError('starts_on must be a date like 2026-09-13')

  const party_id = await findOrCreateParty(tenant, {
    display_name: input['display_name'],
    email: input['email'],
    phone: input['phone'],
  })
  await tenant.query`SELECT party_id FROM party WHERE party_id = ${party_id}::uuid FOR UPDATE`
  const [current] = await tenant.query<{ plan_name: string; ends_at: Date | null }[]>`
    SELECT mp.display_name AS plan_name, m.ends_at
    FROM membership m JOIN membership_plan mp ON mp.membership_plan_id = m.membership_plan_id
    WHERE m.organization_id = ${tenant.organization_id}::uuid AND m.party_id = ${party_id}::uuid
      AND m.deleted_at IS NULL AND m.status IN ('active', 'frozen')
      AND (m.ends_at IS NULL OR m.ends_at > ${startOfLocalDay(starts_on, time_zone)})
    LIMIT 1`
  if (current) {
    throw new MemberError(
      `This player already holds ${current.plan_name}${current.ends_at ? ` until ${localDate(new Date(current.ends_at), time_zone)}` : ''}`,
      409,
    )
  }

  await issueMembership(tenant, {
    membership_plan_id: plan.membership_plan_id,
    party_id,
    starts_at: startOfLocalDay(starts_on, time_zone),
    ends_at: startOfLocalDay(periodEnd(starts_on, plan.billing_period_code ?? 'monthly'), time_zone),
  })
  return findMember(tenant, party_id)
}

async function membershipParty(tenant: TenantContext, membership_id: Uuid): Promise<{ party_id: Uuid; status: string }> {
  const [row] = await tenant.query<{ party_id: Uuid; status: string }[]>`
    SELECT party_id, status::text AS status FROM membership
    WHERE organization_id = ${tenant.organization_id}::uuid AND membership_id = ${membership_id}::uuid AND deleted_at IS NULL`
  if (!row) throw new MemberError('membership not found', 404)
  return { party_id: String(row.party_id), status: row.status }
}

export async function changeMembership(
  tenant: TenantContext,
  membership_id: Uuid,
  action: 'freeze' | 'unfreeze' | 'cancel',
  input: Record<string, unknown>,
  actor_id: Uuid,
): Promise<Member> {
  const { party_id, status } = await membershipParty(tenant, membership_id)
  const time_zone = await venueTimeZone(tenant)
  let detail: Record<string, unknown> = {}

  if (action === 'freeze') {
    if (status !== 'active') throw new MemberError(`Only an active membership can be frozen (this one is ${status})`, 409)
    const until_on = input['frozen_until_on'] === undefined || input['frozen_until_on'] === ''
      ? addDay(localDate(new Date(), time_zone), 30)
      : input['frozen_until_on']
    if (!isDate(until_on)) throw new MemberError('frozen_until_on must be a date like 2026-10-13')
    const frozen_until = startOfLocalDay(until_on, time_zone)
    if (frozen_until <= new Date()) throw new MemberError('frozen_until_on must be in the future')
    await freezeMembership(tenant, membership_id, frozen_until)
    detail = { frozen_until_on: until_on }
  } else if (action === 'unfreeze') {
    const updated = await tenant.query`
      UPDATE membership SET status = 'active', frozen_until = NULL
      WHERE organization_id = ${tenant.organization_id}::uuid AND membership_id = ${membership_id}::uuid AND status = 'frozen'
      RETURNING membership_id`
    if (updated.length === 0) throw new MemberError('This membership is not frozen', 409)
  } else {
    const updated = await tenant.query`
      UPDATE membership SET status = 'cancelled', frozen_until = NULL
      WHERE organization_id = ${tenant.organization_id}::uuid AND membership_id = ${membership_id}::uuid
        AND status IN ('active', 'frozen', 'past_due')
      RETURNING membership_id`
    if (updated.length === 0) throw new MemberError(`This membership is already ${status}`, 409)
  }

  await recordAuditEvent(tenant, {
    organization_id: tenant.organization_id,
    actor_label: actor_id,
    event_code: `member.membership.${action}`,
    subject_table: 'membership',
    subject_id: membership_id,
    reason: optionalText(input['reason']) ?? action,
    detail,
  })
  return findMember(tenant, party_id)
}

export async function issueMemberPass(tenant: TenantContext, input: Record<string, unknown>): Promise<Member> {
  const plan = await findMemberPlan(tenant, requireText(input['plan_id'], 'plan_id'))
  if (plan.plan_kind_code !== 'pass') throw new MemberError(`${plan.display_name} is a membership — enrol the player instead`)
  const party_id = optionalText(input['party_id'])
    ? await (async () => {
        const [row] = await tenant.query<{ party_id: Uuid }[]>`
          SELECT party_id FROM party
          WHERE organization_id = ${tenant.organization_id}::uuid AND party_id = ${String(input['party_id'])}::uuid AND deleted_at IS NULL`
        if (!row) throw new MemberError('player not found', 404)
        return String(row.party_id)
      })()
    : await findOrCreateParty(tenant, { display_name: input['display_name'], email: input['email'], phone: input['phone'] })

  const time_zone = await venueTimeZone(tenant)
  const today = localDate(new Date(), time_zone)
  // Valid through the end of the last local day: "60 days" means 60 whole days.
  const valid_until = new Date(startOfLocalDay(addDay(today, (plan.valid_day_count ?? 1) + 1), time_zone).getTime() - 1)
  const pass = await issuePass(tenant, {
    party_id,
    valid_until,
    use_limit: plan.session_count ?? 1,
    ...(optionalText(input['pass_code']) ? { pass_code: String(input['pass_code']) } : {}),
  })
  await tenant.query`
    INSERT INTO member_pass (organization_id, pass_id, member_plan_id)
    VALUES (${tenant.organization_id}::uuid, ${pass.pass_id}::uuid, ${plan.member_plan_id}::uuid)`
  return findMember(tenant, party_id)
}

export async function readEntitlement(tenant: TenantContext, party_id: Uuid) {
  const [party] = await tenant.query<{ party_id: Uuid; display_name: string; email_address: string | null }[]>`
    SELECT party_id, display_name, email_address FROM party
    WHERE organization_id = ${tenant.organization_id}::uuid AND party_id = ${party_id}::uuid AND deleted_at IS NULL`
  if (!party) throw new MemberError('player not found', 404)
  const membership = await tenant.query<
    { membership_id: Uuid; plan_name: string; status: string; starts_at: Date; ends_at: Date | null; member_plan_id: Uuid | null }[]
  >`
    SELECT m.membership_id, mp.display_name AS plan_name, m.status::text AS status, m.starts_at, m.ends_at, p.member_plan_id
    FROM membership m
    JOIN membership_plan mp ON mp.membership_plan_id = m.membership_plan_id
    LEFT JOIN member_plan p ON p.membership_plan_id = m.membership_plan_id AND p.organization_id = m.organization_id
    WHERE m.organization_id = ${tenant.organization_id}::uuid AND m.party_id = ${party_id}::uuid AND m.deleted_at IS NULL
    ORDER BY m.starts_at DESC`
  const plan = await readPlan(tenant)
  const now = new Date()
  const pass = (await readPass(tenant, [party_id])).get(party_id) ?? []
  const membership_view = membership.map((one) => {
    const rule = plan.find((each) => each.member_plan_id === (one.member_plan_id === null ? null : String(one.member_plan_id)))
    return {
      membership_id: String(one.membership_id),
      plan_name: one.plan_name,
      status_code: memberStatus({ status: one.status, ends_at: one.ends_at ? new Date(one.ends_at) : null, now }),
      starts_at: new Date(one.starts_at).toISOString(),
      ends_at: one.ends_at ? new Date(one.ends_at).toISOString() : null,
      rule_sentence: rule?.rule_sentence ?? null,
      is_member_session_access: rule?.is_member_session_access ?? false,
    }
  })
  return {
    party: { party_id: String(party.party_id), display_name: party.display_name, email_address: party.email_address },
    membership: membership_view,
    pass,
    is_member_session_access: membership_view.some(
      (one) => (one.status_code === 'active' || one.status_code === 'expiring') && one.is_member_session_access,
    ),
  }
}

export async function setSessionRule(tenant: TenantContext, session_id: Uuid, is_member_only: unknown) {
  if (typeof is_member_only !== 'boolean') throw new MemberError('is_member_only must be true or false')
  const [session] = await tenant.query<{ session_id: Uuid }[]>`
    SELECT session_id FROM session
    WHERE organization_id = ${tenant.organization_id}::uuid AND session_id = ${session_id}::uuid AND deleted_at IS NULL`
  if (!session) throw new MemberError('session not found', 404)
  await tenant.query`
    INSERT INTO member_session_rule (organization_id, session_id, is_member_only)
    VALUES (${tenant.organization_id}::uuid, ${session_id}::uuid, ${is_member_only})
    ON CONFLICT (organization_id, session_id) DO UPDATE SET is_member_only = EXCLUDED.is_member_only`
  return { session_id, is_member_only }
}

// ---------------------------------------------------------------------------
// pricing + entitlement port
// ---------------------------------------------------------------------------

export type Quote = {
  price_amount: string
  base_amount: string
  entitlement_code: string | null
  is_eligible: boolean
  reason: string | null
}

export const ENTITLEMENT_MEMBERSHIP = 'membership'
export const ENTITLEMENT_SESSION_PASS = 'session_pass'

async function isMemberEnabled(tenant: TenantContext): Promise<boolean> {
  return (await listEnabledModuleCode(tenant)).includes('member')
}

export async function quote(
  tenant: TenantContext,
  input: { party_id: string | null; session_id: string; base_amount: string },
): Promise<Quote> {
  const base_centavo = toCentavo(input.base_amount, 'base_amount')
  const base_amount = fromCentavo(base_centavo)
  const plain: Quote = { price_amount: base_amount, base_amount, entitlement_code: null, is_eligible: true, reason: null }
  if (!(await isMemberEnabled(tenant))) return plain

  const [session] = await tenant.query<{ starts_at: Date; time_zone: string; is_member_only: boolean }[]>`
    SELECT s.starts_at,
           coalesce(site.time_zone, o.time_zone, ${DEFAULT_TIME_ZONE}) AS time_zone,
           coalesce(r.is_member_only, false) AS is_member_only
    FROM session s
    LEFT JOIN site ON site.site_id = s.site_id
    LEFT JOIN organization o ON o.organization_id = s.organization_id
    LEFT JOIN member_session_rule r ON r.session_id = s.session_id AND r.organization_id = s.organization_id
    WHERE s.organization_id = ${tenant.organization_id}::uuid AND s.session_id = ${input.session_id}::uuid`
  if (!session) return plain

  type Covering = {
    display_name: string
    price_rule_code: PriceRuleCode
    percent_off: string | null
    fixed_price_amount: string | null
    is_member_session_access: boolean
  }
  // Covered when the session's LOCAL date falls inside the membership's local
  // days: on or after the start day, and before the day it ends. Comparing
  // venue-local dates, not UTC dates, is what keeps an 7am Manila booking on
  // the day after expiry from reading as the last covered day.
  const membership = input.party_id
    ? await tenant.query<Covering[]>`
        SELECT mp.display_name, p.price_rule_code, p.percent_off::text AS percent_off,
               p.fixed_price_amount::text AS fixed_price_amount, p.is_member_session_access
        FROM membership m
        JOIN member_plan p ON p.membership_plan_id = m.membership_plan_id AND p.organization_id = m.organization_id
        JOIN membership_plan mp ON mp.membership_plan_id = m.membership_plan_id AND mp.organization_id = m.organization_id
        WHERE m.organization_id = ${tenant.organization_id}::uuid
          AND m.party_id = ${input.party_id}::uuid
          AND m.status = 'active' AND m.deleted_at IS NULL AND p.deleted_at IS NULL
          AND (m.starts_at AT TIME ZONE ${session.time_zone})::date <= (${session.starts_at}::timestamptz AT TIME ZONE ${session.time_zone})::date
          AND (m.ends_at IS NULL
               OR (${session.starts_at}::timestamptz AT TIME ZONE ${session.time_zone})::date < (m.ends_at AT TIME ZONE ${session.time_zone})::date)`
    : []

  const pass = input.party_id
    ? await tenant.query<{ display_name: string; remaining_count: number }[]>`
        SELECT mp.display_name, (ps.use_limit - ps.use_count)::int AS remaining_count
        FROM pass ps
        JOIN member_pass x ON x.pass_id = ps.pass_id AND x.organization_id = ps.organization_id
        JOIN member_plan p ON p.member_plan_id = x.member_plan_id
        JOIN membership_plan mp ON mp.membership_plan_id = p.membership_plan_id
        WHERE ps.organization_id = ${tenant.organization_id}::uuid AND ps.party_id = ${input.party_id}::uuid
          AND ps.status = 'active' AND ps.deleted_at IS NULL
          AND ps.valid_until > now() AND ps.valid_until >= ${session.starts_at}::timestamptz
          AND ps.use_limit IS NOT NULL AND ps.use_count < ps.use_limit
        ORDER BY ps.valid_until LIMIT 1`
    : []

  if (session.is_member_only && !membership.some((one) => one.is_member_session_access)) {
    return {
      ...plain,
      is_eligible: false,
      reason:
        'This session is for members only. Book with the email on your membership, or ask the front desk about joining.',
    }
  }

  let best: Quote = plain
  for (const one of membership) {
    const price = applyPriceRule(base_centavo, one)
    if (price < toCentavo(best.price_amount)) {
      const saved = base_centavo - price
      best = {
        price_amount: fromCentavo(price),
        base_amount,
        entitlement_code: ENTITLEMENT_MEMBERSHIP,
        is_eligible: true,
        reason: `Member price with your ${one.display_name}: you save ${displayPeso(saved)}.`,
      }
    }
  }
  const [first_pass] = pass
  if (first_pass && base_centavo > 0 && toCentavo(best.price_amount) > 0) {
    const left = first_pass.remaining_count - 1
    best = {
      price_amount: fromCentavo(0),
      base_amount,
      entitlement_code: ENTITLEMENT_SESSION_PASS,
      is_eligible: true,
      reason: `Covered by your ${first_pass.display_name} — ${left === 1 ? '1 session' : `${left} sessions`} left after this booking.`,
    }
  }
  return best
}

export async function consume(
  tenant: TenantContext,
  input: { party_id: string; entitlement_code: string; subject_code: string },
): Promise<void> {
  if (!(await isMemberEnabled(tenant))) return
  const subject_code = requireText(input.subject_code, 'subject_code')

  const alreadyUsed = async () => {
    const [row] = await tenant.query`
      SELECT 1 FROM member_entitlement_use
      WHERE organization_id = ${tenant.organization_id}::uuid
        AND entitlement_code = ${input.entitlement_code} AND subject_code = ${subject_code}`
    return Boolean(row)
  }

  if (input.entitlement_code === ENTITLEMENT_MEMBERSHIP) {
    // Membership pricing is unlimited: record the use for traceability, spend nothing.
    await tenant.query`
      INSERT INTO member_entitlement_use (organization_id, party_id, entitlement_code, subject_code)
      SELECT ${tenant.organization_id}::uuid, ${input.party_id}::uuid, ${ENTITLEMENT_MEMBERSHIP}, ${subject_code}
      WHERE EXISTS (
        SELECT 1 FROM membership
        WHERE organization_id = ${tenant.organization_id}::uuid AND party_id = ${input.party_id}::uuid
          AND status = 'active' AND deleted_at IS NULL)
      ON CONFLICT (organization_id, entitlement_code, subject_code) DO NOTHING`
    return
  }
  if (input.entitlement_code !== ENTITLEMENT_SESSION_PASS) {
    throw new MemberError(`unknown entitlement "${input.entitlement_code}"`)
  }

  if (await alreadyUsed()) return

  // Lock the pass that will be spent. A concurrent consume for the same pass
  // waits here; PostgreSQL re-checks the row after the wait, so a pass the
  // other transaction just exhausted is skipped rather than overdrawn.
  const [pass] = await tenant.query<{ pass_id: Uuid }[]>`
    SELECT ps.pass_id
    FROM pass ps
    JOIN member_pass x ON x.pass_id = ps.pass_id AND x.organization_id = ps.organization_id
    WHERE ps.organization_id = ${tenant.organization_id}::uuid AND ps.party_id = ${input.party_id}::uuid
      AND ps.status = 'active' AND ps.deleted_at IS NULL
      -- clock_timestamp(), not now(): now() is frozen at transaction start, so a
      -- pass issued earlier in the same transaction would read as not yet valid.
      AND ps.valid_from <= clock_timestamp() AND ps.valid_until > clock_timestamp()
      AND ps.use_limit IS NOT NULL AND ps.use_count < ps.use_limit
    ORDER BY ps.valid_until
    LIMIT 1
    FOR UPDATE OF ps`

  // Re-read after the lock: a concurrent replay of this same subject may have
  // committed while this transaction waited.
  if (await alreadyUsed()) return
  if (!pass) throw new MemberError('No sessions left on a pass for this player.', 409)

  const result = await consumePass(tenant, String(pass.pass_id))
  if (!result.is_ok) throw new MemberError('No sessions left on a pass for this player.', 409)

  await tenant.query`
    INSERT INTO member_entitlement_use (organization_id, party_id, pass_id, entitlement_code, subject_code)
    VALUES (${tenant.organization_id}::uuid, ${input.party_id}::uuid, ${pass.pass_id}::uuid, ${ENTITLEMENT_SESSION_PASS}, ${subject_code})`
}
