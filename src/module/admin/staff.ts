// Staff (R04): actors, their preset role, and the lifecycle a venue needs —
// add, change role, disable, enable, reset password.
//
// The kernel has createActor and revokeSession but no update, disable, or
// secret rotation, so those are direct writes to actor/actor_role. Disable uses
// the kernel's own actor.is_active flag, which signIn already refuses.

import { randomInt } from 'node:crypto'
import {
  DomainError,
  createActor,
  hashSecret,
  revokeApiKey,
  revokeSession,
  type TenantContext,
  type Uuid,
} from '@bygelo/roundrobin-kernel'
import { ROLE_PRESET, ensureRolePreset, findRolePreset } from './role.ts'

export type StaffView = {
  actor_id: Uuid
  actor_code: string
  display_name: string
  role_code: string | null
  role_display_name: string | null
  status: 'active' | 'disabled'
  /** true for an actor imported without a password; they cannot sign in until reset. */
  is_secret_pending: boolean
  last_sign_in_at: Date | null
  created_at: Date
}

const SECRET_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

/** A readable one-time password: three groups of four, no look-alike characters. */
export function generateTemporarySecret(): string {
  const group: string[] = []
  for (let index = 0; index < 3; index += 1) {
    let part = ''
    for (let each = 0; each < 4; each += 1) part += SECRET_ALPHABET[randomInt(SECRET_ALPHABET.length)]
    group.push(part)
  }
  return group.join('-')
}

export function validateActorCode(actor_code: unknown): string {
  const value = typeof actor_code === 'string' ? actor_code.trim().toLowerCase() : ''
  if (!/^[a-z0-9][a-z0-9._-]{1,39}$/.test(value)) {
    throw new DomainError(
      'Staff code must be 2 to 40 characters: lowercase letters, numbers, dots, dashes, or underscores.',
      400,
    )
  }
  return value
}

export function validateDisplayName(display_name: unknown): string {
  const value = typeof display_name === 'string' ? display_name.trim() : ''
  if (value.length < 1 || value.length > 80) throw new DomainError('Name is required (80 characters at most).', 400)
  return value
}

export function validateRoleCode(role_code: unknown): string {
  if (typeof role_code !== 'string' || !findRolePreset(role_code)) {
    throw new DomainError(`Role must be one of: ${ROLE_PRESET.map((one) => one.role_code).join(', ')}.`, 400)
  }
  return role_code
}

type StaffRow = {
  actor_id: Uuid
  actor_code: string
  display_name: string
  is_active: boolean
  is_secret_pending: boolean
  role_code_list: string[]
  last_sign_in_at: Date | null
  created_at: Date
}

function toView(row: StaffRow): StaffView {
  const preset = ROLE_PRESET.find((one) => row.role_code_list.includes(one.role_code))
  const role_code = preset?.role_code ?? row.role_code_list[0] ?? null
  return {
    actor_id: row.actor_id,
    actor_code: row.actor_code,
    display_name: row.display_name,
    role_code,
    role_display_name: preset?.display_name ?? role_code,
    status: row.is_active ? 'active' : 'disabled',
    is_secret_pending: row.is_secret_pending,
    last_sign_in_at: row.last_sign_in_at,
    created_at: row.created_at,
  }
}

async function selectStaff(tenant: TenantContext, actor_id: Uuid | null): Promise<StaffView[]> {
  const row = await tenant.query<StaffRow[]>`
    SELECT a.actor_id, a.actor_code, a.display_name, a.is_active, a.created_at,
           a.secret_hash LIKE 'scrypt:import-placeholder:%' AS is_secret_pending,
           (SELECT max(s.created_at) FROM auth_session s
             WHERE s.organization_id = a.organization_id AND s.actor_id = a.actor_id) AS last_sign_in_at,
           COALESCE(array_agg(r.role_code ORDER BY r.role_code) FILTER (WHERE r.role_code IS NOT NULL),
                    '{}'::text[]) AS role_code_list
    FROM actor a
    LEFT JOIN actor_role ar
      ON ar.organization_id = a.organization_id AND ar.actor_id = a.actor_id
     AND (ar.expires_at IS NULL OR ar.expires_at > now())
    LEFT JOIN role r ON r.organization_id = ar.organization_id AND r.role_id = ar.role_id
    WHERE a.organization_id = ${tenant.organization_id}
      AND a.deleted_at IS NULL
      AND (${actor_id}::uuid IS NULL OR a.actor_id = ${actor_id}::uuid)
    GROUP BY a.actor_id
    ORDER BY a.is_active DESC, lower(a.display_name), a.actor_code`
  return row.map(toView)
}

export async function listStaff(tenant: TenantContext): Promise<StaffView[]> {
  await ensureRolePreset(tenant)
  return selectStaff(tenant, null)
}

/** 404 for an unknown id — including another tenant's, which RLS hides. */
export async function findStaff(tenant: TenantContext, actor_id: string): Promise<StaffView> {
  if (!/^[0-9a-f-]{36}$/i.test(actor_id)) throw new DomainError('staff member not found', 404)
  const [one] = await selectStaff(tenant, actor_id)
  if (!one) throw new DomainError('staff member not found', 404)
  return one
}

async function countOtherActiveOwner(tenant: TenantContext, actor_id: Uuid): Promise<number> {
  const [row] = await tenant.query<{ owner_count: number }[]>`
    SELECT count(DISTINCT a.actor_id)::int AS owner_count
    FROM actor a
    JOIN actor_role ar ON ar.organization_id = a.organization_id AND ar.actor_id = a.actor_id
    JOIN role r ON r.organization_id = ar.organization_id AND r.role_id = ar.role_id
    WHERE a.organization_id = ${tenant.organization_id}
      AND r.role_code = 'owner'
      AND ar.expires_at IS NULL
      AND a.is_active AND a.deleted_at IS NULL
      AND a.actor_id <> ${actor_id}`
  return row?.owner_count ?? 0
}

async function assertNotLastOwner(tenant: TenantContext, staff: StaffView): Promise<void> {
  if (staff.role_code !== 'owner' || staff.status !== 'active') return
  if ((await countOtherActiveOwner(tenant, staff.actor_id)) === 0) {
    throw new DomainError(`${staff.display_name} is the only owner. Make someone else an owner first.`, 409)
  }
}

async function setStandingRole(tenant: TenantContext, actor_id: Uuid, role_code: string): Promise<void> {
  const role_id = await ensureRolePreset(tenant)
  await tenant.query`
    DELETE FROM actor_role
    WHERE organization_id = ${tenant.organization_id} AND actor_id = ${actor_id} AND expires_at IS NULL`
  await tenant.query`
    INSERT INTO actor_role (organization_id, actor_id, role_id)
    VALUES (${tenant.organization_id}, ${actor_id}, ${role_id.get(role_code)!})
    ON CONFLICT (actor_id, role_id) DO UPDATE SET expires_at = NULL`
}

async function revokeEverySession(tenant: TenantContext, actor_id: Uuid): Promise<number> {
  const live = await tenant.query<{ auth_session_id: Uuid }[]>`
    SELECT auth_session_id FROM auth_session
    WHERE organization_id = ${tenant.organization_id} AND actor_id = ${actor_id}
      AND revoked_at IS NULL AND expire_at > now()`
  for (const one of live) await revokeSession(tenant, one.auth_session_id)
  return live.length
}

export async function createStaff(
  tenant: TenantContext,
  input: { actor_code: unknown; display_name: unknown; role_code: unknown },
): Promise<{ staff: StaffView; temporary_secret: string }> {
  const actor_code = validateActorCode(input.actor_code)
  const display_name = validateDisplayName(input.display_name)
  const role_code = validateRoleCode(input.role_code)
  await ensureRolePreset(tenant)

  const [taken] = await tenant.query<{ actor_id: Uuid }[]>`
    SELECT actor_id FROM actor WHERE organization_id = ${tenant.organization_id} AND actor_code = ${actor_code}`
  if (taken) throw new DomainError(`Staff code "${actor_code}" is already taken. Choose another.`, 409)

  const temporary_secret = generateTemporarySecret()
  const actor_id = await createActor(tenant, { actor_code, display_name, secret: temporary_secret, role_code })
  return { staff: await findStaff(tenant, actor_id), temporary_secret }
}

export async function updateStaff(
  tenant: TenantContext,
  actor_id: string,
  input: { role_code?: unknown; display_name?: unknown },
): Promise<{ staff: StaffView; before: StaffView }> {
  const before = await findStaff(tenant, actor_id)
  const display_name = input.display_name === undefined ? undefined : validateDisplayName(input.display_name)
  const role_code = input.role_code === undefined ? undefined : validateRoleCode(input.role_code)
  if (display_name === undefined && role_code === undefined) {
    throw new DomainError('Nothing to change: send role_code or display_name.', 400)
  }

  if (role_code !== undefined && role_code !== before.role_code) {
    if (role_code !== 'owner') await assertNotLastOwner(tenant, before)
    await setStandingRole(tenant, before.actor_id, role_code)
  }
  if (display_name !== undefined && display_name !== before.display_name) {
    await tenant.query`
      UPDATE actor SET display_name = ${display_name}
      WHERE organization_id = ${tenant.organization_id} AND actor_id = ${before.actor_id}`
  }
  return { staff: await findStaff(tenant, before.actor_id), before }
}

export async function disableStaff(
  tenant: TenantContext,
  actor_id: string,
  acting_actor_id: Uuid,
): Promise<{ staff: StaffView; revoked_session_count: number; revoked_api_key_count: number }> {
  const staff = await findStaff(tenant, actor_id)
  if (staff.actor_id === acting_actor_id) {
    throw new DomainError('You cannot disable your own account. Ask another owner.', 409)
  }
  await assertNotLastOwner(tenant, staff)

  await tenant.query`
    UPDATE actor SET is_active = false
    WHERE organization_id = ${tenant.organization_id} AND actor_id = ${staff.actor_id}`
  const revoked_session_count = await revokeEverySession(tenant, staff.actor_id)

  // An API key acts as the actor who made it. resolveApiKey does not look at
  // actor.is_active, so a disabled person's keys must go too.
  const key = await tenant.query<{ api_key_id: Uuid }[]>`
    SELECT api_key_id FROM api_key
    WHERE organization_id = ${tenant.organization_id} AND actor_id = ${staff.actor_id} AND revoked_at IS NULL`
  for (const one of key) await revokeApiKey(tenant, one.api_key_id)

  return {
    staff: await findStaff(tenant, staff.actor_id),
    revoked_session_count,
    revoked_api_key_count: key.length,
  }
}

async function rotateSecret(tenant: TenantContext, actor_id: Uuid): Promise<string> {
  const temporary_secret = generateTemporarySecret()
  const secret_hash = await hashSecret(temporary_secret)
  await tenant.query`
    UPDATE actor SET secret_hash = ${secret_hash}
    WHERE organization_id = ${tenant.organization_id} AND actor_id = ${actor_id}`
  return temporary_secret
}

export async function enableStaff(
  tenant: TenantContext,
  actor_id: string,
): Promise<{ staff: StaffView; temporary_secret: string }> {
  const staff = await findStaff(tenant, actor_id)
  if (staff.status === 'active') {
    throw new DomainError(`${staff.display_name} is already active. Reset their password instead.`, 409)
  }
  const temporary_secret = await rotateSecret(tenant, staff.actor_id)
  await tenant.query`
    UPDATE actor SET is_active = true
    WHERE organization_id = ${tenant.organization_id} AND actor_id = ${staff.actor_id}`
  return { staff: await findStaff(tenant, staff.actor_id), temporary_secret }
}

export async function resetStaffSecret(
  tenant: TenantContext,
  actor_id: string,
  acting_actor_id: Uuid,
): Promise<{ staff: StaffView; temporary_secret: string; revoked_session_count: number }> {
  const staff = await findStaff(tenant, actor_id)
  if (staff.actor_id === acting_actor_id) {
    throw new DomainError('You cannot reset your own password here. Ask another owner.', 409)
  }
  if (staff.status === 'disabled') {
    throw new DomainError(`${staff.display_name} is disabled. Enable them to issue a new password.`, 409)
  }
  const temporary_secret = await rotateSecret(tenant, staff.actor_id)
  const revoked_session_count = await revokeEverySession(tenant, staff.actor_id)
  return { staff: await findStaff(tenant, staff.actor_id), temporary_secret, revoked_session_count }
}
