// Your account: any signed-in staff member reads who they are, changes their
// own password, and signs out their other devices.
//
// Authority here is "this is my own session", not a capability. The admin
// module's route gating only asks whether admin is enabled for the tenant, so
// a scorer reaches these routes; the handler then refuses an API key (it acts
// for a person but is not that person at a desk) and acts only on
// session.actor_id, never on an id from the body.

import {
  DomainError,
  ForbiddenError,
  hashSecret,
  revokeSession,
  verifySecret,
  type Session,
  type TenantContext,
  type Uuid,
} from '@bygelo/roundrobin-kernel'
import { findStaff } from './staff.ts'

export const MIN_SECRET_LENGTH = 10
const MAX_SECRET_LENGTH = 200

export const WRONG_SECRET_SENTENCE = 'That is not your current password.'
export const API_KEY_REFUSAL_SENTENCE = 'Sign in as yourself to manage your account; an API key cannot.'

/** Audit events that hand a person a password somebody else knows. */
const TEMPORARY_EVENT_CODE = ['staff.created', 'staff.enabled', 'staff.secret_reset'] as const
export const PASSWORD_CHANGED_EVENT_CODE = 'account.password_changed'

// ---------------------------------------------------------------------------
// wrong-attempt limit (in memory, per actor)
// ---------------------------------------------------------------------------

export const WRONG_ATTEMPT_LIMIT = 5
export const WRONG_ATTEMPT_WINDOW_MS = 10 * 60_000

const wrong_attempt = new Map<string, number[]>()

function attemptKey(session: Session): string {
  return `${session.organization_id}:${session.actor_id}`
}

function liveAttempt(key: string, now: number): number[] {
  const kept = (wrong_attempt.get(key) ?? []).filter((at) => now - at < WRONG_ATTEMPT_WINDOW_MS)
  if (kept.length === 0) wrong_attempt.delete(key)
  else wrong_attempt.set(key, kept)
  return kept
}

/** Seconds until another attempt is allowed, or 0 when one is allowed now. */
export function readRetryAfterSecond(session: Session, now = Date.now()): number {
  const kept = liveAttempt(attemptKey(session), now)
  if (kept.length < WRONG_ATTEMPT_LIMIT) return 0
  return Math.max(1, Math.ceil((kept[0]! + WRONG_ATTEMPT_WINDOW_MS - now) / 1000))
}

function recordWrongAttempt(session: Session, now = Date.now()): void {
  const key = attemptKey(session)
  wrong_attempt.set(key, [...liveAttempt(key, now), now])
}

function clearWrongAttempt(session: Session): void {
  wrong_attempt.delete(attemptKey(session))
}

export class RateLimitError extends DomainError {
  readonly retry_after_second: number
  constructor(retry_after_second: number) {
    super('Too many wrong passwords. Wait a few minutes, then try again.', 429)
    this.retry_after_second = retry_after_second
  }
}

// ---------------------------------------------------------------------------
// rules
// ---------------------------------------------------------------------------

export function assertOwnSession(session: Session, is_api_key: boolean): void {
  if (is_api_key) throw new ForbiddenError(API_KEY_REFUSAL_SENTENCE)
  if (!session.actor_id) throw new ForbiddenError(API_KEY_REFUSAL_SENTENCE)
}

/** Shape rules for a new password. Pure; runs before anything is verified or written. */
export function validateNewSecret(input: { current_secret: unknown; new_secret: unknown; actor_code: string }): {
  current_secret: string
  new_secret: string
} {
  if (typeof input.current_secret !== 'string' || input.current_secret.length === 0) {
    throw new DomainError('Enter your current password.', 400)
  }
  if (typeof input.new_secret !== 'string' || input.new_secret.length === 0) {
    throw new DomainError('Enter a new password.', 400)
  }
  const new_secret = input.new_secret
  if (new_secret.length < MIN_SECRET_LENGTH) {
    throw new DomainError(`Your new password must be at least ${MIN_SECRET_LENGTH} characters.`, 400)
  }
  if (new_secret.length > MAX_SECRET_LENGTH) {
    throw new DomainError(`Your new password must be ${MAX_SECRET_LENGTH} characters at most.`, 400)
  }
  if (new_secret === input.current_secret) {
    throw new DomainError('Choose a new password that is different from your current one.', 400)
  }
  if (new_secret.trim().toLowerCase() === input.actor_code.trim().toLowerCase()) {
    throw new DomainError('Your password cannot be your staff code.', 400)
  }
  return { current_secret: input.current_secret, new_secret }
}

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

export type AccountView = {
  actor_id: Uuid
  actor_code: string
  display_name: string
  role_code: string | null
  role_display_name: string | null
  /** When this session signed in. */
  session_started_at: Date | null
  /** The sign-in before this one, or null when this is the first. */
  last_sign_in_at: Date | null
  active_session_count: number
  /** true when the password was last set by someone else (added, enabled, or reset by an owner). */
  is_secret_temporary: boolean
}

export async function readAccount(tenant: TenantContext, session: Session): Promise<AccountView> {
  const staff = await findStaff(tenant, session.actor_id)
  const [row] = await tenant.query<
    { session_started_at: Date | null; last_sign_in_at: Date | null; active_session_count: number; last_secret_event: string | null }[]
  >`
    SELECT
      (SELECT created_at FROM auth_session
        WHERE organization_id = ${tenant.organization_id} AND auth_session_id = ${session.auth_session_id}) AS session_started_at,
      (SELECT max(created_at) FROM auth_session
        WHERE organization_id = ${tenant.organization_id} AND actor_id = ${session.actor_id}
          AND auth_session_id <> ${session.auth_session_id}) AS last_sign_in_at,
      (SELECT count(*)::int FROM auth_session
        WHERE organization_id = ${tenant.organization_id} AND actor_id = ${session.actor_id}
          AND revoked_at IS NULL AND expire_at > now()) AS active_session_count,
      (SELECT event_code FROM audit_event
        WHERE organization_id = ${tenant.organization_id}
          AND subject_table = 'actor' AND subject_id = ${session.actor_id}
          AND event_code = ANY(${[...TEMPORARY_EVENT_CODE, PASSWORD_CHANGED_EVENT_CODE]}::text[])
        ORDER BY created_at DESC, audit_event_id DESC
        LIMIT 1) AS last_secret_event`
  return {
    actor_id: staff.actor_id,
    actor_code: staff.actor_code,
    display_name: staff.display_name,
    role_code: staff.role_code,
    role_display_name: staff.role_display_name,
    session_started_at: row?.session_started_at ?? null,
    last_sign_in_at: row?.last_sign_in_at ?? null,
    active_session_count: row?.active_session_count ?? 0,
    is_secret_temporary:
      staff.is_secret_pending ||
      (row?.last_secret_event != null && (TEMPORARY_EVENT_CODE as readonly string[]).includes(row.last_secret_event)),
  }
}

// ---------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------

async function revokeOtherSession(tenant: TenantContext, session: Session): Promise<number> {
  const live = await tenant.query<{ auth_session_id: Uuid }[]>`
    SELECT auth_session_id FROM auth_session
    WHERE organization_id = ${tenant.organization_id} AND actor_id = ${session.actor_id}
      AND auth_session_id <> ${session.auth_session_id}
      AND revoked_at IS NULL AND expire_at > now()`
  for (const one of live) await revokeSession(tenant, one.auth_session_id)
  return live.length
}

/**
 * Verify, then rotate. Order matters: every refusal (limit, shape, wrong
 * current) happens before the first write, so a refused request changes nothing.
 */
export async function changeOwnSecret(
  tenant: TenantContext,
  session: Session,
  input: { current_secret: unknown; new_secret: unknown },
  now = Date.now(),
): Promise<{ revoked_session_count: number }> {
  const retry_after_second = readRetryAfterSecond(session, now)
  if (retry_after_second > 0) throw new RateLimitError(retry_after_second)

  const [actor] = await tenant.query<{ actor_code: string; secret_hash: string; is_active: boolean }[]>`
    SELECT actor_code, secret_hash, is_active FROM actor
    WHERE organization_id = ${tenant.organization_id} AND actor_id = ${session.actor_id} AND deleted_at IS NULL`
  if (!actor || !actor.is_active) throw new ForbiddenError(API_KEY_REFUSAL_SENTENCE)

  const { current_secret, new_secret } = validateNewSecret({ ...input, actor_code: actor.actor_code })
  if (!(await verifySecret(current_secret, actor.secret_hash))) {
    recordWrongAttempt(session, now)
    throw new ForbiddenError(WRONG_SECRET_SENTENCE)
  }
  clearWrongAttempt(session)

  const secret_hash = await hashSecret(new_secret)
  await tenant.query`
    UPDATE actor SET secret_hash = ${secret_hash}
    WHERE organization_id = ${tenant.organization_id} AND actor_id = ${session.actor_id}`
  return { revoked_session_count: await revokeOtherSession(tenant, session) }
}

export async function signOutOtherDevice(tenant: TenantContext, session: Session): Promise<{ revoked_session_count: number }> {
  return { revoked_session_count: await revokeOtherSession(tenant, session) }
}
