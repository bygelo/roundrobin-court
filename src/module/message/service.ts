// message — the service behind notifyPlayer and the operator surface.
//
// Writes to the outbox go through the notification pack (enqueueNotification,
// setPreference). Sending is routed here, per channel, through transport.ts:
// email through EMAIL_PROVIDER, SMS through NOTIFICATION_SMS_*. A channel with
// no provider stays held. The raw recipient never leaves this file: every
// value returned or logged is a mask.

import { randomUUID } from 'node:crypto'
import { listEnabledModuleCode, type TenantContext, type Uuid } from '@bygelo/roundrobin-kernel'
import {
  enqueueNotification,
  maskRecipient,
  setPreference,
  type NotificationProvider,
} from '@bygelo/roundrobin-notification'
import type { MessageKind, NotifyPlayerInput } from './contract.ts'
import {
  ALL_KIND,
  BODY_LIMIT,
  MESSAGE_CHANNEL,
  MESSAGE_KIND,
  MessageConflictError,
  MessageInputError,
  MessageNotFoundError,
  OPTIONAL_KIND,
  defaultTemplate,
  errorSentence,
  findKind,
  isEmail,
  normalizeDetail,
  outboxStatus,
  phoneKey,
  renderText,
  validateTemplate,
  type KindMeta,
  type MessageChannel,
  type OutboxStatus,
} from './kind.ts'
import {
  EMAIL_ENV,
  SMS_ENV,
  readEmailConfig,
  readSmsProvider,
  wrapProvider,
  type Transport,
  type TransportResult,
} from './transport.ts'

// ---------------------------------------------------------------------------
// provider — honest, per channel: no provider configured means nothing is sent
// ---------------------------------------------------------------------------

export const PROVIDER_ENV = [...SMS_ENV, ...EMAIL_ENV]

const CHANNEL_ENV: Record<MessageChannel, readonly { env_name: string; is_required: boolean; description: string }[]> = {
  email: EMAIL_ENV,
  sms: SMS_ENV,
}

const EMAIL_PROVIDER_LABEL: Record<string, string> = { resend: 'Resend', postmark: 'Postmark', http: 'HTTP relay' }

let provider_override: NotificationProvider | undefined

/** Install a provider for BOTH channels in this process (tests). Pass nothing to clear. */
export function setMessageProvider(provider?: NotificationProvider): void {
  provider_override = provider
}

/**
 * The SMS provider, or undefined when none is configured.
 *
 * Deliberately NOT the pack's getNotificationProvider(): with no endpoint set,
 * the pack falls back to an in-process recording double that marks rows
 * "delivered" without sending anything. A venue must never see Sent for a
 * message no player received.
 */
export function resolveProvider(): NotificationProvider | undefined {
  return provider_override ?? readSmsProvider()
}

/** The transport a channel sends through, or undefined when that channel is held. */
export function resolveTransport(channel: MessageChannel): Transport | undefined {
  if (provider_override) return wrapProvider(provider_override, channel)
  if (channel === 'sms') {
    const provider = readSmsProvider()
    return provider ? wrapProvider(provider, 'sms') : undefined
  }
  const config = readEmailConfig()
  return config.is_configured ? config.transport : undefined
}

function configuredChannel(): MessageChannel[] {
  return MESSAGE_CHANNEL.filter((channel) => resolveTransport(channel) !== undefined)
}

type EnvLine = { env_name: string; is_required: boolean; is_set: boolean; description: string }

function envLine(list: readonly { env_name: string; is_required: boolean; description: string }[]): EnvLine[] {
  return list.map((one) => ({
    env_name: one.env_name,
    is_required: one.is_required,
    is_set: Boolean(process.env[one.env_name]?.trim()),
    description: one.description,
  }))
}

export type ChannelStatus = {
  delivery_channel: MessageChannel
  is_configured: boolean
  provider_code: string | null
  status_label: string
  explanation: string
  held_count: number
  env: EnvLine[]
}

export type ProviderStatus = {
  is_configured: boolean
  provider_code: string | null
  held_count: number
  channel: ChannelStatus[]
  env: EnvLine[]
}

function describeChannel(channel: MessageChannel): Omit<ChannelStatus, 'held_count'> {
  const env = envLine(CHANNEL_ENV[channel])
  if (provider_override) {
    return { delivery_channel: channel, is_configured: true, provider_code: provider_override.provider_code, status_label: `Configured — ${provider_override.provider_code}`, explanation: 'A provider installed by this process sends every channel.', env }
  }
  if (channel === 'sms') {
    const provider = readSmsProvider()
    return provider
      ? { delivery_channel: channel, is_configured: true, provider_code: provider.provider_code, status_label: `Configured — ${provider.provider_code}`, explanation: 'Text messages are posted to the configured SMS endpoint.', env }
      : { delivery_channel: channel, is_configured: false, provider_code: null, status_label: 'Held — no SMS provider configured', explanation: 'Text messages wait in the outbox until NOTIFICATION_SMS_URL is set.', env }
  }
  const config = readEmailConfig()
  if (config.is_configured) {
    const label = EMAIL_PROVIDER_LABEL[config.provider_code] ?? config.provider_code
    return { delivery_channel: channel, is_configured: true, provider_code: config.provider_code, status_label: `Configured — ${label}`, explanation: `Email is sent through ${label}.`, env }
  }
  return {
    delivery_channel: channel,
    is_configured: false,
    provider_code: config.provider_code,
    status_label: config.provider_code ? 'Held — email provider is not fully configured' : 'Held — no email provider configured',
    explanation: `${config.reason} Email waits in the outbox until then.`,
    env,
  }
}

async function countHeld(tenant: TenantContext, configured: MessageChannel[]): Promise<Record<MessageChannel, number>> {
  const row = await tenant.query<{ delivery_channel: string; queued_count: number }[]>`
    SELECT delivery_channel::text AS delivery_channel, count(*)::int AS queued_count FROM notification_delivery
    WHERE organization_id = ${tenant.organization_id} AND status = 'queued'
      AND delivery_kind = ANY(${ALL_KIND}::text[])
    GROUP BY delivery_channel`
  const held: Record<MessageChannel, number> = { email: 0, sms: 0 }
  for (const one of row) {
    const channel = one.delivery_channel as MessageChannel
    if (channel in held && !configured.includes(channel)) held[channel] = one.queued_count
  }
  return held
}

export async function readProviderStatus(tenant: TenantContext): Promise<ProviderStatus> {
  const channel = MESSAGE_CHANNEL.map(describeChannel)
  const configured = channel.filter((one) => one.is_configured).map((one) => one.delivery_channel)
  const held = await countHeld(tenant, configured)
  return {
    is_configured: configured.length > 0,
    provider_code: channel.find((one) => one.is_configured)?.provider_code ?? null,
    held_count: held.email + held.sms,
    channel: channel.map((one) => ({ ...one, held_count: held[one.delivery_channel] })),
    env: envLine(PROVIDER_ENV),
  }
}

// ---------------------------------------------------------------------------
// venue and player lookup
// ---------------------------------------------------------------------------

type Venue = { display_name: string; organization_code: string; time_zone: string }

async function readVenue(tenant: TenantContext): Promise<Venue> {
  const [row] = await tenant.query<Venue[]>`
    SELECT display_name, organization_code, time_zone FROM organization
    WHERE organization_id = ${tenant.organization_id}`
  return row ?? { display_name: 'your venue', organization_code: '', time_zone: 'Asia/Manila' }
}

type PartyRow = { party_id: Uuid; display_name: string; email_address: string | null; phone_number: string | null }

async function findPartyById(tenant: TenantContext, party_id: string): Promise<PartyRow | undefined> {
  if (!/^[0-9a-f-]{36}$/i.test(party_id)) return undefined
  const [row] = await tenant.query<PartyRow[]>`
    SELECT party_id, display_name, email_address, phone_number FROM party
    WHERE organization_id = ${tenant.organization_id} AND party_id = ${party_id} AND deleted_at IS NULL`
  return row
}

export async function findPartyByContact(tenant: TenantContext, contact: string): Promise<PartyRow | undefined> {
  const text = contact.trim()
  if (isEmail(text)) {
    const [row] = await tenant.query<PartyRow[]>`
      SELECT party_id, display_name, email_address, phone_number FROM party
      WHERE organization_id = ${tenant.organization_id} AND deleted_at IS NULL
        AND lower(email_address) = lower(${text})
      ORDER BY created_at LIMIT 1`
    return row
  }
  const key = phoneKey(text)
  if (key.length < 7) return undefined
  const [row] = await tenant.query<PartyRow[]>`
    SELECT party_id, display_name, email_address, phone_number FROM party
    WHERE organization_id = ${tenant.organization_id} AND deleted_at IS NULL
      AND right(regexp_replace(coalesce(phone_number, ''), '[^0-9]', '', 'g'), 10) = ${key}
    ORDER BY created_at LIMIT 1`
  return row
}

// ---------------------------------------------------------------------------
// template
// ---------------------------------------------------------------------------

export type TemplateRow = {
  message_kind: MessageKind
  delivery_channel: MessageChannel
  subject: string | null
  body: string
  is_active: boolean
  updated_at: Date
}

/** Create default copy for every kind and channel the venue has not written yet. */
export async function ensureTemplate(tenant: TenantContext): Promise<void> {
  const [count] = await tenant.query<{ template_count: number }[]>`
    SELECT count(*)::int AS template_count FROM message_template WHERE organization_id = ${tenant.organization_id}`
  if ((count?.template_count ?? 0) >= MESSAGE_KIND.length * MESSAGE_CHANNEL.length) return
  for (const meta of MESSAGE_KIND) {
    for (const channel of MESSAGE_CHANNEL) {
      const copy = defaultTemplate(meta, channel)
      await tenant.query`
        INSERT INTO message_template (organization_id, message_kind, delivery_channel, subject, body)
        VALUES (${tenant.organization_id}, ${meta.message_kind}, ${channel}, ${copy.subject}, ${copy.body})
        ON CONFLICT (organization_id, message_kind, delivery_channel) DO NOTHING`
    }
  }
}

async function loadTemplate(tenant: TenantContext, meta: KindMeta, channel: MessageChannel): Promise<TemplateRow> {
  const [row] = await tenant.query<TemplateRow[]>`
    SELECT message_kind, delivery_channel, subject, body, is_active, updated_at FROM message_template
    WHERE organization_id = ${tenant.organization_id} AND message_kind = ${meta.message_kind} AND delivery_channel = ${channel}`
  if (row) return row
  const copy = defaultTemplate(meta, channel)
  await tenant.query`
    INSERT INTO message_template (organization_id, message_kind, delivery_channel, subject, body)
    VALUES (${tenant.organization_id}, ${meta.message_kind}, ${channel}, ${copy.subject}, ${copy.body})
    ON CONFLICT (organization_id, message_kind, delivery_channel) DO NOTHING`
  return { message_kind: meta.message_kind, delivery_channel: channel, ...copy, is_active: true, updated_at: new Date() }
}

export async function listTemplate(tenant: TenantContext) {
  await ensureTemplate(tenant)
  const venue = await readVenue(tenant)
  const row = await tenant.query<TemplateRow[]>`
    SELECT message_kind, delivery_channel, subject, body, is_active, updated_at FROM message_template
    WHERE organization_id = ${tenant.organization_id}`
  return {
    kind: MESSAGE_KIND.map((meta) => ({
      message_kind: meta.message_kind,
      label: meta.label,
      description: meta.description,
      is_essential: meta.is_essential,
      placeholder: meta.placeholder,
      sample: { ...meta.sample, venue_name: venue.display_name },
    })),
    template: MESSAGE_KIND.flatMap((meta) =>
      MESSAGE_CHANNEL.map((channel) => {
        const found = row.find((one) => one.message_kind === meta.message_kind && one.delivery_channel === channel)
        return found ?? { message_kind: meta.message_kind, delivery_channel: channel, ...defaultTemplate(meta, channel), is_active: true, updated_at: new Date() }
      }),
    ),
    body_limit: BODY_LIMIT,
  }
}

export async function saveTemplate(
  tenant: TenantContext,
  meta: KindMeta,
  channel: MessageChannel,
  input: { subject?: unknown; body?: unknown; is_active?: unknown },
): Promise<TemplateRow> {
  const clean = validateTemplate(meta, channel, input)
  if (input.is_active !== undefined && typeof input.is_active !== 'boolean') {
    throw new MessageInputError('Active must be true or false.')
  }
  const is_active = input.is_active === undefined ? true : input.is_active
  const [row] = await tenant.query<TemplateRow[]>`
    INSERT INTO message_template (organization_id, message_kind, delivery_channel, subject, body, is_active)
    VALUES (${tenant.organization_id}, ${meta.message_kind}, ${channel}, ${clean.subject}, ${clean.body}, ${is_active})
    ON CONFLICT (organization_id, message_kind, delivery_channel)
    DO UPDATE SET subject = EXCLUDED.subject, body = EXCLUDED.body, is_active = EXCLUDED.is_active
    RETURNING message_kind, delivery_channel, subject, body, is_active, updated_at`
  return row!
}

export async function previewTemplate(
  tenant: TenantContext,
  meta: KindMeta,
  channel: MessageChannel,
  input: { subject?: unknown; body?: unknown; detail?: unknown },
): Promise<{ subject: string | null; body: string; character_count: number; body_limit: number }> {
  const source = input.body !== undefined ? validateTemplate(meta, channel, input) : await loadTemplate(tenant, meta, channel)
  const venue = await readVenue(tenant)
  const detail: Record<string, string> = { ...meta.sample, venue_name: venue.display_name }
  if (input.detail && typeof input.detail === 'object' && !Array.isArray(input.detail)) {
    for (const [key, value] of Object.entries(input.detail as Record<string, unknown>)) {
      if (typeof value === 'string') detail[key] = value
    }
  }
  const body = renderText(source.body, detail)
  return {
    subject: source.subject === null ? null : renderText(source.subject, detail),
    body,
    character_count: body.length,
    body_limit: BODY_LIMIT[channel],
  }
}

// ---------------------------------------------------------------------------
// dispatch — notifyPlayer's body
// ---------------------------------------------------------------------------

export type DispatchOutcome = 'queued' | 'duplicate' | 'suppressed' | 'inactive' | 'not_queued'

export type DispatchResult = {
  outcome: 'queued' | 'duplicate' | 'not_opted_in' | 'no_recipient' | 'disabled' | 'suppressed' | 'inactive' | 'not_queued'
  channel: { delivery_channel: MessageChannel; outcome: DispatchOutcome }[]
}

export async function isMessageEnabled(tenant: TenantContext): Promise<boolean> {
  const enabled = await listEnabledModuleCode(tenant)
  return enabled.includes('message') && enabled.includes('notification')
}

async function isOptedIn(tenant: TenantContext, party_id: string, message_kind: MessageKind): Promise<boolean> {
  const [row] = await tenant.query<{ is_opted_in: boolean }[]>`
    SELECT is_opted_in FROM message_preference
    WHERE organization_id = ${tenant.organization_id} AND party_id = ${party_id} AND message_kind = ${message_kind}`
  return row?.is_opted_in === true
}

/**
 * Queue one transactional message on every channel the player can be reached on.
 * Never throws: a refusal is an outcome, and an unexpected outbox error is
 * contained in a savepoint so the producer's own transaction survives.
 */
export async function dispatchMessage(
  tenant: TenantContext,
  input: NotifyPlayerInput,
  option: { venue?: Venue } = {},
): Promise<DispatchResult> {
  if (!(await isMessageEnabled(tenant))) return { outcome: 'disabled', channel: [] }
  const meta = findKind(input.message_kind)
  const subject_code = typeof input.subject_code === 'string' ? input.subject_code.trim() : ''
  if (!meta || subject_code === '' || subject_code.length > 200) return { outcome: 'not_queued', channel: [] }

  let party: PartyRow | undefined
  if (input.party_id) party = await findPartyById(tenant, input.party_id)
  if (!party && input.recipient_email) party = await findPartyByContact(tenant, input.recipient_email)
  if (!party && input.recipient_phone) party = await findPartyByContact(tenant, input.recipient_phone)

  const recipient: Record<MessageChannel, string | undefined> = {
    email: input.recipient_email?.trim() || party?.email_address?.trim() || undefined,
    sms: input.recipient_phone?.trim() || party?.phone_number?.trim() || undefined,
  }
  const reachable = MESSAGE_CHANNEL.filter((channel) => recipient[channel])
  if (reachable.length === 0) return { outcome: 'no_recipient', channel: [] }

  if (!meta.is_essential) {
    if (!party || !(await isOptedIn(tenant, party.party_id, meta.message_kind))) {
      return { outcome: 'not_opted_in', channel: [] }
    }
  }

  const venue = option.venue ?? (await readVenue(tenant))
  const detail: Record<string, string> = { venue_name: venue.display_name, ...normalizeDetail(input.detail ?? {}) }
  if (!detail['player_name'] && party) detail['player_name'] = party.display_name
  if (!detail['player_name']) detail['player_name'] = 'there'

  const result: DispatchResult['channel'] = []
  for (const channel of reachable) {
    const template = await loadTemplate(tenant, meta, channel)
    if (!template.is_active) {
      result.push({ delivery_channel: channel, outcome: 'inactive' })
      continue
    }
    const [existing] = await tenant.query<{ message_dispatch_id: Uuid }[]>`
      SELECT message_dispatch_id FROM message_dispatch
      WHERE organization_id = ${tenant.organization_id} AND message_kind = ${meta.message_kind}
        AND subject_code = ${subject_code} AND delivery_channel = ${channel}`
    if (existing) {
      result.push({ delivery_channel: channel, outcome: 'duplicate' })
      continue
    }
    try {
      const status = await tenant.query.savepoint(async () => {
        const delivery = await enqueueNotification(tenant, {
          delivery_kind: meta.message_kind,
          delivery_channel: channel,
          recipient: recipient[channel]!,
          body: renderText(template.body, detail),
          ...(template.subject !== null ? { subject: renderText(template.subject, detail) } : {}),
          ...(party ? { party_id: party.party_id } : {}),
          is_essential: meta.is_essential,
          idempotency_key: `message:${meta.message_kind}:${subject_code}`,
        })
        await tenant.query`
          INSERT INTO message_dispatch (organization_id, message_kind, subject_code, delivery_channel, party_id, notification_delivery_id)
          VALUES (${tenant.organization_id}, ${meta.message_kind}, ${subject_code}, ${channel},
                  ${party?.party_id ?? null}, ${delivery.notification_delivery_id})`
        return delivery.status
      })
      result.push({ delivery_channel: channel, outcome: status === 'suppressed' ? 'suppressed' : 'queued' })
    } catch (error) {
      // A concurrent producer won the unique key (or the outbox refused). The
      // savepoint rolled back only this attempt. Log the kind and subject —
      // never the recipient.
      const code = typeof error === 'object' && error && 'code' in error ? String((error as { code: unknown }).code) : ''
      if (code === '23505') {
        result.push({ delivery_channel: channel, outcome: 'duplicate' })
      } else {
        console.warn(`message: could not queue ${meta.message_kind} for ${subject_code} by ${channel}: ${error instanceof Error ? error.message : 'unknown error'}`)
        result.push({ delivery_channel: channel, outcome: 'not_queued' })
      }
    }
  }

  const order: DispatchResult['outcome'][] = ['queued', 'duplicate', 'suppressed', 'inactive', 'not_queued']
  const outcome = order.find((one) => result.some((each) => each.outcome === one)) ?? 'not_queued'
  return { outcome, channel: result }
}

// ---------------------------------------------------------------------------
// outbox
// ---------------------------------------------------------------------------

export type OutboxLine = {
  notification_delivery_id: Uuid
  message_kind: string
  kind_label: string
  is_essential: boolean
  delivery_channel: string
  recipient_mask: string
  player_name: string | null
  subject_code: string | null
  status: OutboxStatus
  attempt_count: number
  last_error: string | null
  created_at: Date
  updated_at: Date
}

type RawLine = {
  notification_delivery_id: Uuid
  delivery_kind: string
  delivery_channel: string
  recipient_mask: string
  player_name: string | null
  subject_code: string | null
  status: string
  attempt_count: number
  last_error: string | null
  created_at: Date
  updated_at: Date
}

const STATUS_FILTER: Record<OutboxStatus, string> = {
  queued: 'queued',
  held: 'queued',
  sending: 'claimed',
  sent: 'delivered',
  failed: 'failed',
  suppressed: 'suppressed',
}

function toLine(row: RawLine, configured: MessageChannel[]): OutboxLine {
  const meta = findKind(row.delivery_kind)
  return {
    notification_delivery_id: String(row.notification_delivery_id),
    message_kind: row.delivery_kind,
    kind_label: meta?.label ?? row.delivery_kind,
    is_essential: meta?.is_essential ?? true,
    delivery_channel: row.delivery_channel,
    recipient_mask: row.recipient_mask,
    player_name: row.player_name,
    subject_code: row.subject_code,
    status: outboxStatus(row.status, configured.includes(row.delivery_channel as MessageChannel)),
    attempt_count: Number(row.attempt_count),
    last_error: errorSentence(row.last_error),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export async function listOutbox(tenant: TenantContext, filter: { status?: string; notification_delivery_id?: string } = {}) {
  let status: OutboxStatus | undefined
  if (filter.status) {
    if (!(filter.status in STATUS_FILTER)) {
      throw new MessageInputError('Filter by queued, held, sending, sent, failed, or suppressed.')
    }
    status = filter.status as OutboxStatus
  }
  const configured = configuredChannel()
  const row = await tenant.query<RawLine[]>`
    SELECT d.notification_delivery_id, d.delivery_kind, d.delivery_channel::text AS delivery_channel,
           d.recipient_mask, p.display_name AS player_name, md.subject_code,
           d.status::text AS status, d.attempt_count, d.last_error, d.created_at, d.updated_at
    FROM notification_delivery d
    LEFT JOIN message_dispatch md
      ON md.organization_id = d.organization_id AND md.notification_delivery_id = d.notification_delivery_id
    LEFT JOIN party p ON p.party_id = d.party_id
    WHERE d.organization_id = ${tenant.organization_id}
      AND d.delivery_kind = ANY(${ALL_KIND}::text[])
      ${status ? tenant.query`AND d.status = ${STATUS_FILTER[status]}::notification_delivery_status` : tenant.query``}
      ${status === 'held' ? tenant.query`AND NOT (d.delivery_channel::text = ANY(${configured}::text[]))` : tenant.query``}
      ${status === 'queued' ? tenant.query`AND d.delivery_channel::text = ANY(${configured}::text[])` : tenant.query``}
      ${filter.notification_delivery_id ? tenant.query`AND d.notification_delivery_id = ${filter.notification_delivery_id}` : tenant.query``}
    ORDER BY d.created_at DESC
    LIMIT 200`
  const count = await tenant.query<{ status: string; line_count: number }[]>`
    SELECT status::text AS status, count(*)::int AS line_count FROM notification_delivery
    WHERE organization_id = ${tenant.organization_id} AND delivery_kind = ANY(${ALL_KIND}::text[])
    GROUP BY status`
  const countOf = (one: string) => count.find((each) => each.status === one)?.line_count ?? 0
  const held = await countHeld(tenant, configured)
  return {
    is_provider_configured: configured.length > 0,
    configured_channel: configured,
    summary: {
      queued_count: countOf('queued') + countOf('claimed'),
      held_count: held.email + held.sms,
      sent_count: countOf('delivered'),
      failed_count: countOf('failed'),
      suppressed_count: countOf('suppressed'),
    },
    outbox: row.map((one) => toLine(one, configured)),
  }
}

// ---------------------------------------------------------------------------
// send — claim per configured channel, send through its transport, record
// ---------------------------------------------------------------------------

/** Attempts before a retryable refusal becomes a failure the operator retries. */
export const MAX_ATTEMPT = 5

/** Wait before the next automatic try: 1, 2, 4, 8 minutes, capped at an hour. */
function backoffSecond(attempt_count: number): number {
  return Math.min(60 * 2 ** Math.max(attempt_count - 1, 0), 3600)
}

type ClaimedRow = {
  notification_delivery_id: Uuid
  delivery_kind: string
  delivery_channel: string
  recipient: string
  recipient_mask: string
  subject: string | null
  body: string
  attempt_count: number
  claim_token: string
}

async function claimNext(tenant: TenantContext, configured: MessageChannel[]): Promise<ClaimedRow | undefined> {
  const token = `claim_${randomUUID()}`
  const [row] = await tenant.query<ClaimedRow[]>`
    UPDATE notification_delivery
    SET status = 'claimed', claim_token = ${token}, claimed_at = now()
    WHERE organization_id = ${tenant.organization_id}
      AND notification_delivery_id = (
        SELECT notification_delivery_id FROM notification_delivery
        WHERE organization_id = ${tenant.organization_id}
          AND status = 'queued' AND available_at <= now()
          AND delivery_channel::text = ANY(${configured}::text[])
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
    RETURNING notification_delivery_id, delivery_kind, delivery_channel::text AS delivery_channel, recipient,
              recipient_mask, subject, body, attempt_count, claim_token`
  return row
}

async function claimById(tenant: TenantContext, notification_delivery_id: string): Promise<ClaimedRow | undefined> {
  const token = `claim_${randomUUID()}`
  const [row] = await tenant.query<ClaimedRow[]>`
    UPDATE notification_delivery
    SET status = 'claimed', claim_token = ${token}, claimed_at = now()
    WHERE organization_id = ${tenant.organization_id}
      AND notification_delivery_id = ${notification_delivery_id} AND status = 'queued'
    RETURNING notification_delivery_id, delivery_kind, delivery_channel::text AS delivery_channel, recipient,
              recipient_mask, subject, body, attempt_count, claim_token`
  return row
}

type SendOutcome = 'sent' | 'retry' | 'failed'

async function sendClaimed(tenant: TenantContext, row: ClaimedRow, transport: Transport): Promise<SendOutcome> {
  let result: TransportResult
  try {
    result = await transport.send({
      channel: row.delivery_channel as MessageChannel,
      recipient: row.recipient,
      subject: row.subject,
      body: row.body,
      idempotency_key: String(row.notification_delivery_id),
    })
  } catch (error) {
    // A transport never throws by contract; if one does, nothing was confirmed sent.
    result = { is_sent: false, is_retryable: true, reason: `${transport.provider_code} failed: ${error instanceof Error ? error.message : 'unknown error'}`, response_code: 'error' }
  }
  const attempt_count = Number(row.attempt_count) + 1

  await tenant.query`
    INSERT INTO notification_delivery_attempt (
      organization_id, notification_delivery_id, response_code, provider_message_id, is_success, error_message, provider_code
    ) VALUES (
      ${tenant.organization_id}, ${row.notification_delivery_id}, ${result.response_code},
      ${result.is_sent ? result.provider_message_id : null}, ${result.is_sent},
      ${result.is_sent ? null : errorSentence(result.reason)}, ${transport.provider_code}
    )`

  if (result.is_sent) {
    await tenant.query`
      UPDATE notification_delivery
      SET status = 'delivered', provider_message_id = ${result.provider_message_id}, attempt_count = ${attempt_count},
          last_error = NULL, claim_token = NULL
      WHERE organization_id = ${tenant.organization_id} AND notification_delivery_id = ${row.notification_delivery_id}
        AND claim_token = ${row.claim_token}`
    return 'sent'
  }

  const reason = errorSentence(result.reason) ?? 'The provider refused.'
  if (result.is_retryable && attempt_count < MAX_ATTEMPT) {
    const wait_second = backoffSecond(attempt_count)
    await tenant.query`
      UPDATE notification_delivery
      SET status = 'queued', available_at = now() + ${wait_second} * interval '1 second', attempt_count = ${attempt_count},
          last_error = ${reason}, claim_token = NULL, claimed_at = NULL
      WHERE organization_id = ${tenant.organization_id} AND notification_delivery_id = ${row.notification_delivery_id}
        AND claim_token = ${row.claim_token}`
    console.warn(`message: ${row.delivery_kind} by ${row.delivery_channel} to ${row.recipient_mask} will retry in ${wait_second}s: ${reason}`)
    return 'retry'
  }

  const final_reason = result.is_retryable ? `Gave up after ${attempt_count} attempts. ${reason}` : reason
  await tenant.query`
    UPDATE notification_delivery
    SET status = 'failed', attempt_count = ${attempt_count}, last_error = ${final_reason}, claim_token = NULL
    WHERE organization_id = ${tenant.organization_id} AND notification_delivery_id = ${row.notification_delivery_id}
      AND claim_token = ${row.claim_token}`
  console.warn(`message: ${row.delivery_kind} by ${row.delivery_channel} to ${row.recipient_mask} failed: ${final_reason}`)
  return 'failed'
}

export async function processOutbox(tenant: TenantContext) {
  const route: Record<MessageChannel, Transport | undefined> = { email: resolveTransport('email'), sms: resolveTransport('sms') }
  const configured = MESSAGE_CHANNEL.filter((channel) => route[channel] !== undefined)
  const held = await countHeld(tenant, configured)
  const held_count = held.email + held.sms
  if (configured.length === 0) {
    return { is_provider_configured: false, sent_count: 0, failed_count: 0, retry_count: 0, held_count }
  }
  let sent_count = 0
  let failed_count = 0
  let retry_count = 0
  for (let index = 0; index < 50; index += 1) {
    const row = await claimNext(tenant, configured)
    if (!row) break
    const outcome = await sendClaimed(tenant, row, route[row.delivery_channel as MessageChannel]!)
    if (outcome === 'sent') sent_count += 1
    else if (outcome === 'failed') failed_count += 1
    else retry_count += 1
  }
  const [count] = await tenant.query<{ queued_count: number }[]>`
    SELECT count(*)::int AS queued_count FROM notification_delivery
    WHERE organization_id = ${tenant.organization_id} AND status = 'queued' AND available_at <= now()
      AND delivery_channel::text = ANY(${configured}::text[])`
  return { is_provider_configured: true, sent_count, failed_count, retry_count, held_count, remaining_count: count?.queued_count ?? 0 }
}

export async function retryDelivery(tenant: TenantContext, notification_delivery_id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(notification_delivery_id)) throw new MessageNotFoundError('That message is not in the outbox.')
  const [row] = await tenant.query<{ status: string; delivery_kind: string; delivery_channel: string }[]>`
    SELECT status::text AS status, delivery_kind, delivery_channel::text AS delivery_channel FROM notification_delivery
    WHERE organization_id = ${tenant.organization_id} AND notification_delivery_id = ${notification_delivery_id}`
  if (!row || !findKind(row.delivery_kind)) throw new MessageNotFoundError('That message is not in the outbox.')
  const channel = row.delivery_channel as MessageChannel
  const transport = MESSAGE_CHANNEL.includes(channel) ? resolveTransport(channel) : undefined
  if (row.status !== 'failed') {
    throw new MessageConflictError(`Only a failed message can be retried; this one is ${outboxStatus(row.status, transport !== undefined)}.`)
  }
  // failed → queued, available now, lease cleared. Attempts and the attempt log stay.
  await tenant.query`
    UPDATE notification_delivery
    SET status = 'queued', available_at = now(), claim_token = NULL, claimed_at = NULL
    WHERE organization_id = ${tenant.organization_id} AND notification_delivery_id = ${notification_delivery_id} AND status = 'failed'`
  if (transport) {
    const claimed = await claimById(tenant, notification_delivery_id)
    if (claimed) await sendClaimed(tenant, claimed, transport)
  }
  const view = await listOutbox(tenant, { notification_delivery_id })
  return { line: view.outbox[0]!, is_provider_configured: view.is_provider_configured }
}

// ---------------------------------------------------------------------------
// test email — one message straight to an address the owner types
// ---------------------------------------------------------------------------

export type TestEmailResult = {
  status: 'sent' | 'held' | 'failed'
  provider_code: string | null
  provider_message_id: string | null
  recipient_mask: string
  is_retryable: boolean
  reason: string | null
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

export async function sendTestEmail(tenant: TenantContext, input: { recipient_email?: unknown }): Promise<TestEmailResult> {
  const recipient = typeof input.recipient_email === 'string' ? input.recipient_email.trim() : ''
  if (recipient.length > 254 || !EMAIL_SHAPE.test(recipient)) {
    throw new MessageInputError('Enter the email address to send the test to, like you@example.com.')
  }
  const recipient_mask = maskRecipient(recipient, 'email')
  const transport = resolveTransport('email')
  if (!transport) {
    const config = readEmailConfig()
    return {
      status: 'held',
      provider_code: config.provider_code,
      provider_message_id: null,
      recipient_mask,
      is_retryable: false,
      reason: config.is_configured ? null : config.reason,
    }
  }
  const venue = await readVenue(tenant)
  const result = await transport.send({
    channel: 'email',
    recipient,
    subject: `Test email from ${venue.display_name}`,
    body: `This is a test email from ${venue.display_name}. If you are reading it, player messages by email are working.`,
    idempotency_key: `test-email-${randomUUID()}`,
  })
  if (result.is_sent) {
    return { status: 'sent', provider_code: transport.provider_code, provider_message_id: result.provider_message_id, recipient_mask, is_retryable: false, reason: null }
  }
  const reason = errorSentence(result.reason) ?? 'The provider refused.'
  console.warn(`message: test email to ${recipient_mask} through ${transport.provider_code} failed: ${reason}`)
  return { status: 'failed', provider_code: transport.provider_code, provider_message_id: null, recipient_mask, is_retryable: result.is_retryable, reason }
}

// ---------------------------------------------------------------------------
// preference
// ---------------------------------------------------------------------------

export async function readPreference(tenant: TenantContext, contact: string) {
  if (typeof contact !== 'string' || contact.trim() === '') {
    throw new MessageInputError('Enter the player’s email address or phone number.')
  }
  if (!isEmail(contact) && phoneKey(contact).length < 7) {
    throw new MessageInputError('Enter an email address, or a phone number with at least 7 digits.')
  }
  const party = await findPartyByContact(tenant, contact)
  if (!party) throw new MessageNotFoundError('No player at this venue uses that email or phone number.')
  const opt = await tenant.query<{ message_kind: string; is_opted_in: boolean }[]>`
    SELECT message_kind, is_opted_in FROM message_preference
    WHERE organization_id = ${tenant.organization_id} AND party_id = ${party.party_id}`
  const channel = await tenant.query<{ is_contact_allowed: boolean }[]>`
    SELECT is_contact_allowed FROM notification_preference
    WHERE organization_id = ${tenant.organization_id} AND party_id = ${party.party_id}`
  return {
    player: {
      display_name: party.display_name,
      email_mask: party.email_address ? maskRecipient(party.email_address, 'email') : null,
      phone_mask: party.phone_number ? maskRecipient(party.phone_number, 'sms') : null,
    },
    is_contact_allowed: channel.every((one) => one.is_contact_allowed),
    preference: MESSAGE_KIND.map((meta) => ({
      message_kind: meta.message_kind,
      label: meta.label,
      description: meta.description,
      is_essential: meta.is_essential,
      is_opted_in: meta.is_essential ? true : opt.some((one) => one.message_kind === meta.message_kind && one.is_opted_in),
    })),
  }
}

export async function savePreference(
  tenant: TenantContext,
  input: { contact?: unknown; message_kind?: unknown; is_opted_in?: unknown; is_contact_allowed?: unknown },
) {
  if (typeof input.contact !== 'string') throw new MessageInputError('Enter the player’s email address or phone number.')
  const contact = input.contact
  const kind_list = input.message_kind === undefined ? [] : input.message_kind
  if (!Array.isArray(kind_list) || kind_list.some((one) => typeof one !== 'string')) {
    throw new MessageInputError('Message kinds must be a list of message kind codes.')
  }
  if (input.is_contact_allowed !== undefined && typeof input.is_contact_allowed !== 'boolean') {
    throw new MessageInputError('“Allow contact” must be true or false.')
  }
  if (kind_list.length > 0 && typeof input.is_opted_in !== 'boolean') {
    throw new MessageInputError('Say whether the player is opting in (true) or out (false).')
  }
  if (kind_list.length === 0 && input.is_contact_allowed === undefined) {
    throw new MessageInputError('Choose at least one optional message to change.')
  }
  for (const one of kind_list as string[]) {
    const meta = findKind(one)
    if (!meta) throw new MessageInputError(`There is no message kind called “${one}”.`)
    if (meta.is_essential) {
      throw new MessageInputError(`${meta.label} is essential and always sends; only optional messages can be turned on or off.`)
    }
  }

  // Validates the contact and resolves the player (404 when unknown).
  await readPreference(tenant, contact)
  const party = (await findPartyByContact(tenant, contact))!

  for (const one of kind_list as MessageKind[]) {
    await tenant.query`
      INSERT INTO message_preference (organization_id, party_id, message_kind, is_opted_in)
      VALUES (${tenant.organization_id}, ${party.party_id}, ${one}, ${input.is_opted_in as boolean})
      ON CONFLICT (organization_id, party_id, message_kind) DO UPDATE SET is_opted_in = EXCLUDED.is_opted_in`
  }

  // Keep the pack's per-channel consent in step, so the outbox agrees with the
  // per-kind choice and a direct pack enqueue is refused the same way.
  const [any] = await tenant.query<{ is_any_opted_in: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM message_preference
      WHERE organization_id = ${tenant.organization_id} AND party_id = ${party.party_id}
        AND is_opted_in AND message_kind = ANY(${OPTIONAL_KIND}::text[])
    ) AS is_any_opted_in`
  for (const channel of MESSAGE_CHANNEL) {
    const [current] = await tenant.query<{
      is_contact_allowed: boolean
      quiet_hour_start: string | null
      quiet_hour_end: string | null
      quiet_hour_zone: string | null
    }[]>`
      SELECT is_contact_allowed, quiet_hour_start::text AS quiet_hour_start, quiet_hour_end::text AS quiet_hour_end, quiet_hour_zone
      FROM notification_preference
      WHERE organization_id = ${tenant.organization_id} AND party_id = ${party.party_id} AND delivery_channel = ${channel}::notification_channel`
    await setPreference(tenant, {
      party_id: party.party_id,
      delivery_channel: channel,
      is_contact_allowed: (input.is_contact_allowed as boolean | undefined) ?? current?.is_contact_allowed ?? true,
      is_nonessential_allowed: any?.is_any_opted_in ?? false,
      // setPreference clears a window that is omitted, so carry an existing one.
      ...(current?.quiet_hour_start && current.quiet_hour_end && current.quiet_hour_zone
        ? {
            quiet_hour_start: current.quiet_hour_start.slice(0, 5),
            quiet_hour_end: current.quiet_hour_end.slice(0, 5),
            quiet_hour_zone: current.quiet_hour_zone,
          }
        : {}),
    })
  }
  return readPreference(tenant, contact)
}

// ---------------------------------------------------------------------------
// reminder sweep
// ---------------------------------------------------------------------------

function formatVenueDate(at: Date, time_zone: string): string {
  return new Intl.DateTimeFormat('en-PH', { weekday: 'short', month: 'short', day: 'numeric', timeZone: time_zone }).format(at)
}

function formatVenueTime(at: Date, time_zone: string): string {
  return new Intl.DateTimeFormat('en-PH', { hour: 'numeric', minute: '2-digit', timeZone: time_zone }).format(at)
}

/**
 * Queue booking_reminder for every confirmed booking starting in the next 24
 * hours. Safe to run as often as you like: message_dispatch makes a second run
 * queue nothing.
 */
export async function runReminder(tenant: TenantContext) {
  const venue = await readVenue(tenant)
  const booking = await tenant.query<{
    booking_code: string
    party_id: Uuid | null
    starts_at: Date
    court_name: string
    time_zone: string | null
  }[]>`
    SELECT b.booking_code, b.party_id, b.starts_at, r.display_name AS court_name, s.time_zone
    FROM booking b
    JOIN resource r ON r.resource_id = b.resource_id
    JOIN site s ON s.site_id = r.site_id
    WHERE b.organization_id = ${tenant.organization_id}
      AND b.status = 'confirmed'
      AND b.starts_at > now()
      AND b.starts_at <= now() + interval '24 hours'
    ORDER BY b.starts_at
    LIMIT 500`

  const origin = process.env['COURT_PUBLIC_ORIGIN']?.replace(/\/$/, '') ?? ''
  const tally = { candidate_count: booking.length, queued_count: 0, already_reminded_count: 0, not_opted_in_count: 0, no_contact_count: 0, other_count: 0 }
  for (const one of booking) {
    if (!one.party_id) {
      tally.no_contact_count += 1
      continue
    }
    const time_zone = one.time_zone ?? venue.time_zone
    const result = await dispatchMessage(
      tenant,
      {
        message_kind: 'booking_reminder',
        party_id: one.party_id,
        subject_code: one.booking_code,
        detail: {
          court_name: one.court_name,
          date: formatVenueDate(one.starts_at, time_zone),
          time: formatVenueTime(one.starts_at, time_zone),
          booking_code: one.booking_code,
          recovery_link: `${origin}/v/${venue.organization_code}/booking/${one.booking_code}`,
        },
      },
      { venue },
    )
    if (result.outcome === 'queued') tally.queued_count += 1
    else if (result.outcome === 'duplicate') tally.already_reminded_count += 1
    else if (result.outcome === 'not_opted_in') tally.not_opted_in_count += 1
    else if (result.outcome === 'no_recipient') tally.no_contact_count += 1
    else tally.other_count += 1
  }
  return tally
}
