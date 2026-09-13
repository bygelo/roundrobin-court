// webhook service — subscription, CloudEvents envelope, signed delivery with
// backoff and dead letter (R21).
//
// Delivery is at-least-once. The claim (FOR UPDATE SKIP LOCKED) and the result
// write happen in the same transaction as the HTTP POST, so a process that dies
// mid-delivery rolls its claim back and the next run tries again. A subscriber
// dedupes on `x-court-event-id`, which never changes across retries or replays.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { openSecret, sealSecret } from '@bygelo/roundrobin-connector'
import { DomainError, listEnabledModuleCode, type TenantContext, type Uuid } from '@bygelo/roundrobin-kernel'
import {
  ADDRESS_REFUSED_PREFIX,
  WebhookAddressError,
  assertWebhookTarget,
  type AddressOption,
  type LookupFunction,
} from './address.ts'
import type { EmitWebhookInput, WebhookEventCode } from './contract.ts'

export class WebhookError extends DomainError {}

/** Every business event a subscriber may choose. Mirrors the contract's union. */
export const WEBHOOK_EVENT_CODE = [
  'booking.held',
  'booking.confirmed',
  'booking.cancelled',
  'payment.recorded',
  'arrival.checked_in',
  'program.registered',
  'match.confirmed',
] as const satisfies readonly WebhookEventCode[]

/** Internal-only event used by "Send test". Never subscribable. */
export const PING_EVENT_CODE = 'webhook.ping'

export const MAX_ATTEMPT_COUNT = 6
const BACKOFF_BASE_MS = 60_000
const BACKOFF_CAP_MS = 60 * 60_000
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_LIMIT_COUNT = 25

export type DeliveryStatus = 'pending' | 'delivered' | 'failed' | 'dead'

/** Wait after the n-th failed attempt: 1m, 2m, 4m, 8m, 16m … capped at one hour. */
export function backoffMs(attempt_count: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempt_count - 1), BACKOFF_CAP_MS)
}

// ---------------------------------------------------------------------------
// signing key and signature
// ---------------------------------------------------------------------------

const DEV_KEY_PHRASE = 'roundrobin-court-webhook-dev-signing-key'

/**
 * The 32-byte key that seals subscriber secrets at rest.
 *
 * WEBHOOK_SIGNING_KEY: 64 hex chars or 32 bytes base64. Development fallback:
 * a well-known key derived from a fixed phrase, so a fresh checkout works
 * without setup. Production (NODE_ENV=production) refuses the fallback.
 */
export function resolveWebhookKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env['WEBHOOK_SIGNING_KEY']
  if (raw) {
    if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex')
    const decoded = Buffer.from(raw, 'base64')
    if (decoded.length === 32) return decoded
    throw new WebhookError('WEBHOOK_SIGNING_KEY must be 32 bytes (base64) or 64 hex characters', 500)
  }
  if (env['NODE_ENV'] === 'production') {
    throw new WebhookError('WEBHOOK_SIGNING_KEY is not set; refusing the development key in production', 500)
  }
  return createHash('sha256').update(DEV_KEY_PHRASE, 'utf8').digest()
}

/** `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>` — the Stripe shape. */
export function signWebhook(secret: string, timestamp_second: number, body: string): string {
  const digest = createHmac('sha256', secret).update(`${timestamp_second}.${body}`, 'utf8').digest('hex')
  return `t=${timestamp_second},v1=${digest}`
}

/** What a subscriber runs. Exported so the docs snippet and the tests use the same rule. */
export function verifyWebhookSignature(
  secret: string,
  header: string | null | undefined,
  body: string,
  option: { now?: Date; tolerance_second?: number } = {},
): boolean {
  if (!header) return false
  const part = Object.fromEntries(
    header.split(',').map((one) => {
      const index = one.indexOf('=')
      return [one.slice(0, index).trim(), one.slice(index + 1).trim()]
    }),
  )
  const timestamp_second = Number(part['t'])
  const provided = part['v1']
  if (!Number.isInteger(timestamp_second) || !provided || !/^[0-9a-f]{64}$/.test(provided)) return false
  const tolerance_second = option.tolerance_second ?? 300
  const now_second = Math.floor((option.now ?? new Date()).getTime() / 1000)
  if (Math.abs(now_second - timestamp_second) > tolerance_second) return false
  const expected = createHmac('sha256', secret).update(`${timestamp_second}.${body}`, 'utf8').digest()
  return timingSafeEqual(expected, Buffer.from(provided, 'hex'))
}

function generateSecret(): { secret: string; secret_prefix: string } {
  const secret = `whsec_${randomBytes(32).toString('base64url')}`
  return { secret, secret_prefix: secret.slice(0, 12) }
}

// ---------------------------------------------------------------------------
// subscription
// ---------------------------------------------------------------------------

export type WebhookSubscription = {
  webhook_subscription_id: Uuid
  url: string
  description: string | null
  event_code: string[]
  secret_prefix: string
  is_active: boolean
  rotated_at: Date | null
  created_at: Date
  updated_at: Date
  pending_count: number
  dead_count: number
  last_delivered_at: Date | null
  /** 'address_not_allowed' when delivery found the address private and paused the subscription. */
  paused_reason: 'address_not_allowed' | null
}

/** Shape, port, and private-network check (resolves DNS). See ./address.ts. */
export function assertWebhookUrl(url: unknown, option: AddressOption = {}): Promise<string> {
  return assertWebhookTarget(url, option)
}

export function assertEventCode(value: unknown): WebhookEventCode[] {
  if (!Array.isArray(value) || value.length === 0) throw new WebhookError('Choose at least one event to send.')
  const known = new Set<string>(WEBHOOK_EVENT_CODE)
  const unknown = value.filter((one) => typeof one !== 'string' || !known.has(one))
  if (unknown.length > 0) throw new WebhookError(`Unknown event: ${unknown.map(String).join(', ')}.`)
  return [...new Set(value as WebhookEventCode[])]
}

async function selectSubscription(tenant: TenantContext, webhook_subscription_id: Uuid | null) {
  return tenant.query<WebhookSubscription[]>`
    SELECT s.webhook_subscription_id, s.url, s.description, s.event_code, s.secret_prefix, s.is_active,
           s.rotated_at, s.created_at, s.updated_at,
           (SELECT count(*)::int FROM webhook_delivery d
             WHERE d.webhook_subscription_id = s.webhook_subscription_id AND d.status IN ('pending', 'failed')) AS pending_count,
           (SELECT count(*)::int FROM webhook_delivery d
             WHERE d.webhook_subscription_id = s.webhook_subscription_id AND d.status = 'dead') AS dead_count,
           (SELECT max(d.delivered_at) FROM webhook_delivery d
             WHERE d.webhook_subscription_id = s.webhook_subscription_id) AS last_delivered_at,
           CASE WHEN NOT s.is_active AND (
             SELECT d.last_error FROM webhook_delivery d
             WHERE d.webhook_subscription_id = s.webhook_subscription_id AND d.last_attempted_at IS NOT NULL
             ORDER BY d.last_attempted_at DESC, d.webhook_delivery_id DESC LIMIT 1
           ) LIKE ${`${ADDRESS_REFUSED_PREFIX}%`} THEN 'address_not_allowed' END AS paused_reason
    FROM webhook_subscription s
    WHERE s.organization_id = ${tenant.organization_id}
      AND s.deleted_at IS NULL
      AND (${webhook_subscription_id}::uuid IS NULL OR s.webhook_subscription_id = ${webhook_subscription_id}::uuid)
    ORDER BY s.created_at DESC`
}

export function listSubscription(tenant: TenantContext): Promise<WebhookSubscription[]> {
  return selectSubscription(tenant, null)
}

async function findSubscription(tenant: TenantContext, webhook_subscription_id: Uuid): Promise<WebhookSubscription> {
  const [row] = await selectSubscription(tenant, webhook_subscription_id)
  if (!row) throw new WebhookError('That webhook subscription does not exist.', 404)
  return row
}

export async function createSubscription(
  tenant: TenantContext,
  input: { url: unknown; event_code: unknown; description?: unknown; is_active?: unknown },
  option: AddressOption = {},
): Promise<{ subscription: WebhookSubscription; secret: string }> {
  const event_code = assertEventCode(input.event_code)
  const url = await assertWebhookUrl(input.url, option)
  const description = typeof input.description === 'string' && input.description.trim() ? input.description.trim() : null
  const is_active = input.is_active === undefined ? true : input.is_active === true
  const { secret, secret_prefix } = generateSecret()
  const secret_envelope = sealSecret(secret, resolveWebhookKey(option.env))
  const [row] = await tenant.query<{ webhook_subscription_id: Uuid }[]>`
    INSERT INTO webhook_subscription (organization_id, url, description, event_code, secret_envelope, secret_prefix, is_active)
    VALUES (${tenant.organization_id}, ${url}, ${description}, ${event_code}::text[], ${secret_envelope}, ${secret_prefix}, ${is_active})
    RETURNING webhook_subscription_id`
  return { subscription: await findSubscription(tenant, row!.webhook_subscription_id), secret }
}

export async function updateSubscription(
  tenant: TenantContext,
  webhook_subscription_id: Uuid,
  input: { url?: unknown; event_code?: unknown; description?: unknown; is_active?: unknown },
  option: AddressOption = {},
): Promise<WebhookSubscription> {
  const current = await findSubscription(tenant, webhook_subscription_id)
  const event_code = input.event_code === undefined ? current.event_code : assertEventCode(input.event_code)
  const is_active_next = input.is_active === undefined ? current.is_active : input.is_active === true
  // A new URL is always checked; an unchanged one is re-checked when the
  // subscription would be (or stay) active, so "Resume" cannot re-arm a
  // now-private address. Pausing never needs the check.
  const url =
    input.url !== undefined
      ? await assertWebhookUrl(input.url, option)
      : is_active_next
        ? await assertWebhookUrl(current.url, option)
        : current.url
  const description =
    input.description === undefined
      ? current.description
      : typeof input.description === 'string' && input.description.trim()
        ? input.description.trim()
        : null
  const is_active = is_active_next
  await tenant.query`
    UPDATE webhook_subscription
    SET url = ${url}, event_code = ${event_code}::text[], description = ${description}, is_active = ${is_active}
    WHERE organization_id = ${tenant.organization_id} AND webhook_subscription_id = ${webhook_subscription_id}
      AND deleted_at IS NULL`
  return findSubscription(tenant, webhook_subscription_id)
}

export async function rotateSubscriptionSecret(
  tenant: TenantContext,
  webhook_subscription_id: Uuid,
  option: { env?: NodeJS.ProcessEnv } = {},
): Promise<{ subscription: WebhookSubscription; secret: string }> {
  await findSubscription(tenant, webhook_subscription_id)
  const { secret, secret_prefix } = generateSecret()
  const secret_envelope = sealSecret(secret, resolveWebhookKey(option.env))
  await tenant.query`
    UPDATE webhook_subscription
    SET secret_envelope = ${secret_envelope}, secret_prefix = ${secret_prefix}, rotated_at = now()
    WHERE organization_id = ${tenant.organization_id} AND webhook_subscription_id = ${webhook_subscription_id}`
  return { subscription: await findSubscription(tenant, webhook_subscription_id), secret }
}

export async function deleteSubscription(tenant: TenantContext, webhook_subscription_id: Uuid): Promise<void> {
  await findSubscription(tenant, webhook_subscription_id)
  await tenant.query`
    UPDATE webhook_subscription SET deleted_at = now(), is_active = false
    WHERE organization_id = ${tenant.organization_id} AND webhook_subscription_id = ${webhook_subscription_id}`
}

// ---------------------------------------------------------------------------
// event
// ---------------------------------------------------------------------------

async function readSource(tenant: TenantContext): Promise<string> {
  const [row] = await tenant.query<{ organization_code: string }[]>`
    SELECT organization_code FROM organization WHERE organization_id = ${tenant.organization_id}`
  return `/court/${row?.organization_code ?? tenant.organization_id}`
}

export type RecordEventResult = { webhook_event_id: Uuid | null; delivery_count: number; is_duplicate: boolean }

/**
 * Insert the envelope and one delivery per active subscriber. A second call
 * with the same (event_code, subject_code) changes nothing.
 */
export async function recordWebhookEvent(
  tenant: TenantContext,
  input: { event_code: WebhookEventCode | typeof PING_EVENT_CODE; subject_code: string; payload: Record<string, unknown> },
  option: { now?: Date; webhook_subscription_id?: Uuid } = {},
): Promise<RecordEventResult> {
  const subject_code = String(input.subject_code ?? '').trim()
  if (!subject_code) throw new WebhookError('subject_code is required')
  const now = option.now ?? new Date()
  const source = await readSource(tenant)
  const [event] = await tenant.query<{ webhook_event_id: Uuid }[]>`
    INSERT INTO webhook_event (organization_id, event_code, subject_code, source, data, occurred_at)
    VALUES (${tenant.organization_id}, ${input.event_code}, ${subject_code}, ${source},
            ${tenant.query.json((input.payload ?? {}) as never)}, ${now})
    ON CONFLICT (organization_id, event_code, subject_code) DO NOTHING
    RETURNING webhook_event_id`
  if (!event) return { webhook_event_id: null, delivery_count: 0, is_duplicate: true }

  const is_ping = input.event_code === PING_EVENT_CODE
  const delivery = await tenant.query<{ webhook_delivery_id: Uuid }[]>`
    INSERT INTO webhook_delivery (organization_id, webhook_event_id, webhook_subscription_id, next_attempt_at)
    SELECT organization_id, ${event.webhook_event_id}, webhook_subscription_id, ${now}
    FROM webhook_subscription
    WHERE organization_id = ${tenant.organization_id}
      AND deleted_at IS NULL
      AND (${is_ping} OR (is_active AND ${input.event_code} = ANY(event_code)))
      AND (${option.webhook_subscription_id ?? null}::uuid IS NULL
           OR webhook_subscription_id = ${option.webhook_subscription_id ?? null}::uuid)
    ON CONFLICT (webhook_event_id, webhook_subscription_id) DO NOTHING
    RETURNING webhook_delivery_id`
  return { webhook_event_id: event.webhook_event_id, delivery_count: delivery.length, is_duplicate: false }
}

/** The contract body. Never throws: a webhook problem must not fail a booking. */
export async function emitWebhookSafely(tenant: TenantContext, input: EmitWebhookInput): Promise<void> {
  try {
    const enabled = await listEnabledModuleCode(tenant)
    if (!enabled.includes('webhook')) return
    // A savepoint, so a failed insert cannot abort the caller's transaction.
    await tenant.query.savepoint((sql) =>
      recordWebhookEvent({ ...tenant, query: sql } as unknown as TenantContext, input),
    )
  } catch (error) {
    console.error('webhook emit skipped:', error instanceof Error ? error.message : String(error))
  }
}

// ---------------------------------------------------------------------------
// delivery
// ---------------------------------------------------------------------------

export type WebhookDelivery = {
  webhook_delivery_id: Uuid
  webhook_event_id: Uuid
  webhook_subscription_id: Uuid
  url: string
  event_code: string
  subject_code: string
  status: DeliveryStatus
  attempt_count: number
  replay_count: number
  next_attempt_at: Date
  last_attempted_at: Date | null
  last_status_code: number | null
  last_error: string | null
  delivered_at: Date | null
  dead_at: Date | null
  created_at: Date
}

export async function listDelivery(
  tenant: TenantContext,
  filter: { status?: string | undefined; webhook_delivery_id?: Uuid } = {},
): Promise<WebhookDelivery[]> {
  const status = filter.status && ['pending', 'delivered', 'failed', 'dead'].includes(filter.status) ? filter.status : null
  return tenant.query<WebhookDelivery[]>`
    SELECT d.webhook_delivery_id, d.webhook_event_id, d.webhook_subscription_id, s.url,
           e.event_code, e.subject_code, d.status, d.attempt_count, d.replay_count, d.next_attempt_at,
           d.last_attempted_at, d.last_status_code, d.last_error, d.delivered_at, d.dead_at, d.created_at
    FROM webhook_delivery d
    JOIN webhook_event e ON e.webhook_event_id = d.webhook_event_id
    JOIN webhook_subscription s ON s.webhook_subscription_id = d.webhook_subscription_id
    WHERE d.organization_id = ${tenant.organization_id}
      AND (${status}::text IS NULL OR d.status = ${status})
      AND (${filter.webhook_delivery_id ?? null}::uuid IS NULL OR d.webhook_delivery_id = ${filter.webhook_delivery_id ?? null}::uuid)
    ORDER BY d.created_at DESC, d.webhook_delivery_id
    LIMIT 200`
}

export async function replayDelivery(tenant: TenantContext, webhook_delivery_id: Uuid): Promise<WebhookDelivery> {
  const [existing] = await listDelivery(tenant, { webhook_delivery_id })
  if (!existing) throw new WebhookError('That delivery does not exist.', 404)
  if (existing.status !== 'dead' && existing.status !== 'failed') {
    throw new WebhookError(
      existing.status === 'delivered'
        ? 'That delivery already succeeded; there is nothing to replay.'
        : 'That delivery is already queued.',
      409,
    )
  }
  await tenant.query`
    UPDATE webhook_delivery
    SET status = 'pending', attempt_count = 0, replay_count = replay_count + 1,
        next_attempt_at = now(), dead_at = NULL
    WHERE organization_id = ${tenant.organization_id} AND webhook_delivery_id = ${webhook_delivery_id}`
  const [row] = await listDelivery(tenant, { webhook_delivery_id })
  return row!
}

export type ProcessOption = {
  fetchImpl?: typeof fetch
  now?: Date
  limit_count?: number
  timeout_ms?: number
  webhook_delivery_id?: Uuid
  env?: NodeJS.ProcessEnv
  /** DNS lookup used for the delivery-time address check; tests inject one. */
  lookup?: LookupFunction
}

export type ProcessResult = {
  claimed_count: number
  delivered_count: number
  failed_count: number
  dead_count: number
}

type ClaimRow = {
  webhook_delivery_id: Uuid
  webhook_subscription_id: Uuid
  attempt_count: number
  replay_count: number
  url: string
  secret_envelope: string
  webhook_event_id: Uuid
  event_code: string
  subject_code: string
  spec_version: string
  source: string
  data: Record<string, unknown>
  occurred_at: Date
}

/** The exact bytes a subscriber receives. */
export function buildEnvelope(row: {
  webhook_event_id: string
  event_code: string
  subject_code: string
  spec_version: string
  source: string
  data: Record<string, unknown>
  occurred_at: Date
}): string {
  return JSON.stringify({
    specversion: row.spec_version,
    id: row.webhook_event_id,
    type: row.event_code,
    source: row.source,
    subject: row.subject_code,
    time: new Date(row.occurred_at).toISOString(),
    datacontenttype: 'application/json',
    data: row.data,
  })
}

export async function processWebhookDelivery(tenant: TenantContext, option: ProcessOption = {}): Promise<ProcessResult> {
  const now = option.now ?? new Date()
  const fetchImpl = option.fetchImpl ?? fetch
  const limit_count = Math.max(1, Math.min(option.limit_count ?? DEFAULT_LIMIT_COUNT, 200))
  const timeout_ms = option.timeout_ms ?? DEFAULT_TIMEOUT_MS
  const key = resolveWebhookKey(option.env)

  const claim = await tenant.query<ClaimRow[]>`
    SELECT d.webhook_delivery_id, d.webhook_subscription_id, d.attempt_count, d.replay_count, s.url, s.secret_envelope,
           e.webhook_event_id, e.event_code, e.subject_code, e.spec_version, e.source, e.data, e.occurred_at
    FROM webhook_delivery d
    JOIN webhook_subscription s ON s.webhook_subscription_id = d.webhook_subscription_id
    JOIN webhook_event e ON e.webhook_event_id = d.webhook_event_id
    WHERE d.organization_id = ${tenant.organization_id}
      AND d.status IN ('pending', 'failed')
      AND d.next_attempt_at <= ${now}
      AND s.deleted_at IS NULL
      AND (s.is_active OR e.event_code = ${PING_EVENT_CODE})
      AND (${option.webhook_delivery_id ?? null}::uuid IS NULL
           OR d.webhook_delivery_id = ${option.webhook_delivery_id ?? null}::uuid)
    ORDER BY d.next_attempt_at, d.created_at, d.webhook_delivery_id
    LIMIT ${limit_count}
    FOR UPDATE OF d SKIP LOCKED`

  const result: ProcessResult = { claimed_count: claim.length, delivered_count: 0, failed_count: 0, dead_count: 0 }

  // One verdict per URL per run: DNS is asked once, and every claimed delivery
  // to a refused address is marked the same way.
  const verdict = new Map<string, Promise<WebhookAddressError | null>>()
  const checkAddress = (url: string) => {
    if (!verdict.has(url)) {
      verdict.set(
        url,
        assertWebhookTarget(url, { ...(option.env ? { env: option.env } : {}), ...(option.lookup ? { lookup: option.lookup } : {}) })
          .then(() => null)
          .catch((error: unknown) => {
            if (error instanceof WebhookAddressError) return error
            throw error
          }),
      )
    }
    return verdict.get(url)!
  }
  const paused = new Set<Uuid>()

  for (const row of claim) {
    const attempt_count = row.attempt_count + 1
    const body = buildEnvelope(row)
    let status_code: number | null = null
    let error_text: string | null = null

    const refused = await checkAddress(row.url)
    if (refused && !refused.is_retryable) {
      // Not sent, and trying again will not help: record a clear reason, keep
      // the delivery queued (status failed, due now) so it flows once the
      // address is fixed and the subscription resumed, and pause the subscription.
      await tenant.query`
        UPDATE webhook_delivery
        SET status = 'failed', attempt_count = ${attempt_count}, last_attempted_at = ${now},
            last_status_code = NULL, delivered_at = NULL, dead_at = NULL, next_attempt_at = ${now},
            last_error = ${`${ADDRESS_REFUSED_PREFIX} ${refused.message} The subscription was paused.`.slice(0, 500)}
        WHERE webhook_delivery_id = ${row.webhook_delivery_id}`
      if (!paused.has(row.webhook_subscription_id)) {
        paused.add(row.webhook_subscription_id)
        await tenant.query`
          UPDATE webhook_subscription SET is_active = false
          WHERE organization_id = ${tenant.organization_id} AND webhook_subscription_id = ${row.webhook_subscription_id}`
      }
      result.failed_count += 1
      continue
    }

    try {
      if (refused) throw refused
      const secret = openSecret(row.secret_envelope, key)
      const timestamp_second = Math.floor(now.getTime() / 1000)
      const response = await fetchImpl(row.url, {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(timeout_ms),
        headers: {
          'content-type': 'application/json',
          'user-agent': 'roundrobin-court-webhook/1',
          'x-court-event-id': row.webhook_event_id,
          'x-court-event-type': row.event_code,
          'x-court-delivery-id': row.webhook_delivery_id,
          'x-court-delivery-attempt': String(attempt_count),
          'x-court-signature': signWebhook(secret, timestamp_second, body),
        },
        body,
      })
      status_code = response.status
      await response.arrayBuffer().catch(() => undefined)
      if (status_code >= 300 && status_code < 400) {
        error_text = `Subscriber answered HTTP ${status_code} (a redirect); redirects are not followed, so update the URL`
      } else if (status_code < 200 || status_code >= 300) {
        error_text = `Subscriber answered HTTP ${status_code}`
      }
    } catch (error) {
      const name = error instanceof Error ? error.name : ''
      error_text =
        name === 'TimeoutError' || name === 'AbortError'
          ? `No answer within ${Math.round(timeout_ms / 1000)} s`
          : `Could not reach subscriber: ${error instanceof Error ? error.message : String(error)}`
    }

    const is_delivered = error_text === null
    const status: DeliveryStatus = is_delivered ? 'delivered' : attempt_count >= MAX_ATTEMPT_COUNT ? 'dead' : 'failed'
    const next_attempt_at = status === 'failed' ? new Date(now.getTime() + backoffMs(attempt_count)) : now
    await tenant.query`
      UPDATE webhook_delivery
      SET status = ${status},
          attempt_count = ${attempt_count},
          last_attempted_at = ${now},
          last_status_code = ${status_code},
          last_error = ${error_text?.slice(0, 500) ?? null},
          delivered_at = ${is_delivered ? now : null},
          dead_at = ${status === 'dead' ? now : null},
          next_attempt_at = ${next_attempt_at}
      WHERE webhook_delivery_id = ${row.webhook_delivery_id}`
    if (status === 'delivered') result.delivered_count += 1
    else if (status === 'dead') result.dead_count += 1
    else result.failed_count += 1
  }
  return result
}

/** "Send test": a ping event to one subscription, delivered now. */
export async function sendTestPing(
  tenant: TenantContext,
  webhook_subscription_id: Uuid,
  option: ProcessOption = {},
): Promise<WebhookDelivery> {
  await findSubscription(tenant, webhook_subscription_id)
  const now = option.now ?? new Date()
  const recorded = await recordWebhookEvent(
    tenant,
    {
      event_code: PING_EVENT_CODE,
      subject_code: `ping-${randomBytes(8).toString('hex')}`,
      payload: { message: 'Test event from your venue. Verify the signature, then answer 2xx.' },
    },
    { now, webhook_subscription_id },
  )
  const [delivery] = await tenant.query<{ webhook_delivery_id: Uuid }[]>`
    SELECT webhook_delivery_id FROM webhook_delivery
    WHERE webhook_event_id = ${recorded.webhook_event_id} AND webhook_subscription_id = ${webhook_subscription_id}`
  await processWebhookDelivery(tenant, { ...option, now, webhook_delivery_id: delivery!.webhook_delivery_id })
  const [row] = await listDelivery(tenant, { webhook_delivery_id: delivery!.webhook_delivery_id })
  return row!
}
