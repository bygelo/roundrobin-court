// message — the transport port: one message out through one provider.
//
//   send({ channel, recipient, subject, body, idempotency_key })
//     → { is_sent: true, provider_message_id }            (a 2xx from the provider)
//     | { is_sent: false, is_retryable, reason }           (anything else)
//
// Nothing is ever reported sent without a 2xx. 429, 5xx, a timeout, or a
// network error are retryable; any other 4xx is not. A reason never carries a
// raw recipient: provider error text is masked before it is returned.
//
// Email providers, chosen by EMAIL_PROVIDER:
//   resend   POST {EMAIL_API_BASE_URL|https://api.resend.com}/emails
//            Authorization: Bearer EMAIL_API_KEY, Idempotency-Key
//            { from, to: [recipient], subject, text }                → { id }
//   postmark POST {EMAIL_API_BASE_URL|https://api.postmarkapp.com}/email
//            X-Postmark-Server-Token: EMAIL_API_KEY
//            { From, To, Subject, TextBody, MessageStream, Metadata: { idempotency_key } } → { MessageID }
//   http     POST EMAIL_API_URL  (an SMTP relay or in-house gateway)
//            Authorization: Bearer EMAIL_API_KEY (when set), Idempotency-Key
//            { channel: "email", idempotency_key, from, to, subject, text }
//            → 2xx, optionally { provider_message_id | message_id | id }
//
// SMS keeps the notification pack's HTTP SMS provider (NOTIFICATION_SMS_*),
// wrapped to the same port.

import type { NotificationProvider } from '@bygelo/roundrobin-notification'
import { createHttpSmsProvider, type HttpSmsProviderOption } from '@bygelo/roundrobin-notification'

export type TransportChannel = 'email' | 'sms'

export type TransportInput = {
  channel: TransportChannel
  recipient: string
  subject: string | null
  body: string
  idempotency_key: string
}

export type TransportSent = { is_sent: true; provider_message_id: string; response_code: string }
export type TransportRefusal = { is_sent: false; is_retryable: boolean; reason: string; response_code: string }
export type TransportResult = TransportSent | TransportRefusal

export type Transport = {
  channel: TransportChannel
  provider_code: string
  send(input: TransportInput): Promise<TransportResult>
}

export type EmailProviderCode = 'resend' | 'postmark' | 'http'

export const EMAIL_PROVIDER_CODE: EmailProviderCode[] = ['resend', 'postmark', 'http']

export const EMAIL_ENV = [
  { env_name: 'EMAIL_PROVIDER', is_required: true, description: 'Which email provider sends player email: resend, postmark, or http.' },
  { env_name: 'EMAIL_API_KEY', is_required: true, description: 'The provider API key (Resend key, Postmark server token, or the relay bearer key; optional for http).' },
  { env_name: 'EMAIL_FROM', is_required: true, description: 'The sender players see, e.g. Sideout Club <hello@yourvenue.ph>. Must be a verified sender.' },
  { env_name: 'EMAIL_API_URL', is_required: false, description: 'For EMAIL_PROVIDER=http: the full URL of the relay or gateway.' },
  { env_name: 'EMAIL_API_BASE_URL', is_required: false, description: 'Overrides the Resend or Postmark base URL (testing, or a regional endpoint).' },
] as const

export const SMS_ENV = [
  { env_name: 'NOTIFICATION_SMS_URL', is_required: true, description: 'The HTTPS endpoint the SMS adapter posts each text message to.' },
  { env_name: 'NOTIFICATION_SMS_API_KEY', is_required: false, description: 'The SMS provider API key, sent as a bearer token.' },
  { env_name: 'NOTIFICATION_SMS_SENDER', is_required: false, description: 'The sender name players see.' },
  { env_name: 'NOTIFICATION_SMS_PROVIDER', is_required: false, description: 'A short provider label for the attempt log, e.g. semaphore.' },
] as const

const DEFAULT_BASE: Record<'resend' | 'postmark', string> = {
  resend: 'https://api.resend.com',
  postmark: 'https://api.postmarkapp.com',
}

const TIMEOUT_MS = 15_000
const REASON_LIMIT = 300

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value ? value : undefined
}

// ---------------------------------------------------------------------------
// masking — a provider may echo the address back in its error text
// ---------------------------------------------------------------------------

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const PHONE_PATTERN = /\+?\d[\d\s-]{6,}\d/g

export function maskText(text: string): string {
  return text
    .replace(EMAIL_PATTERN, (email) => `${email.slice(0, 1)}•••@${email.split('@')[1] ?? '•••'}`)
    .replace(PHONE_PATTERN, (phone) => `••••${phone.replace(/\D/g, '').slice(-4)}`)
}

function cleanReason(text: string, recipient: string): string {
  const without = recipient ? text.split(recipient).join('•••') : text
  const masked = maskText(without).replace(/\s+/g, ' ').trim()
  return masked.length > REASON_LIMIT ? `${masked.slice(0, REASON_LIMIT - 1)}…` : masked
}

export function isRetryableStatus(status: number): boolean {
  if (status === 429) return true
  if (status >= 400 && status < 500) return false
  return true
}

// ---------------------------------------------------------------------------
// shared HTTP send
// ---------------------------------------------------------------------------

type HttpRequest = { url: string; header: Record<string, string>; body: unknown }

async function postJson(
  provider_code: string,
  request: HttpRequest,
  recipient: string,
  pickId: (parsed: Record<string, unknown>) => string | undefined,
  fallback_id: string,
): Promise<TransportResult> {
  let response: Response
  try {
    response = await fetch(request.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...request.header },
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (error) {
    const detail = error instanceof Error ? (error.name === 'TimeoutError' ? 'timed out' : error.message) : 'network error'
    return { is_sent: false, is_retryable: true, reason: cleanReason(`${provider_code} could not be reached: ${detail}`, recipient), response_code: 'network' }
  }
  const response_code = String(response.status)
  let text = ''
  try {
    text = await response.text()
  } catch {
    text = ''
  }
  let parsed: Record<string, unknown> = {}
  if (text) {
    try {
      const value = JSON.parse(text) as unknown
      if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>
    } catch {
      parsed = {}
    }
  }
  if (response.status >= 200 && response.status < 300) {
    return { is_sent: true, provider_message_id: pickId(parsed) ?? fallback_id, response_code }
  }
  const detail = [parsed['message'], parsed['Message'], parsed['error'], parsed['name']].find(
    (one): one is string => typeof one === 'string' && one.trim() !== '',
  )
  return {
    is_sent: false,
    is_retryable: isRetryableStatus(response.status),
    reason: cleanReason(`${provider_code} refused with HTTP ${response_code}${detail ? `: ${detail}` : ''}`, recipient),
    response_code,
  }
}

function pickString(parsed: Record<string, unknown>, key: string[]): string | undefined {
  for (const one of key) {
    const value = parsed[one]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number') return String(value)
  }
  return undefined
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path}`
}

// ---------------------------------------------------------------------------
// email
// ---------------------------------------------------------------------------

export type EmailConfig =
  | { is_configured: true; provider_code: EmailProviderCode; transport: Transport }
  | { is_configured: false; provider_code: EmailProviderCode | null; reason: string; missing_env: string[] }

/** Read the email configuration from the environment. Values are used, never returned. */
export function readEmailConfig(): EmailConfig {
  const raw = readEnv('EMAIL_PROVIDER')
  if (!raw) {
    return { is_configured: false, provider_code: null, reason: 'No email provider is configured: set EMAIL_PROVIDER, EMAIL_API_KEY, and EMAIL_FROM.', missing_env: ['EMAIL_PROVIDER'] }
  }
  const provider_code = raw.toLowerCase() as EmailProviderCode
  if (!EMAIL_PROVIDER_CODE.includes(provider_code)) {
    return { is_configured: false, provider_code: null, reason: 'EMAIL_PROVIDER must be resend, postmark, or http.', missing_env: ['EMAIL_PROVIDER'] }
  }
  const api_key = readEnv('EMAIL_API_KEY')
  const from = readEnv('EMAIL_FROM')
  const api_url = readEnv('EMAIL_API_URL')
  const missing_env: string[] = []
  if (provider_code !== 'http' && !api_key) missing_env.push('EMAIL_API_KEY')
  if (provider_code === 'http' && !api_url) missing_env.push('EMAIL_API_URL')
  if (!from) missing_env.push('EMAIL_FROM')
  if (missing_env.length > 0) {
    return { is_configured: false, provider_code, reason: `EMAIL_PROVIDER is ${provider_code}, but ${missing_env.join(' and ')} ${missing_env.length === 1 ? 'is' : 'are'} not set.`, missing_env }
  }
  const option = { api_key, from: from!, api_url, base_url: readEnv('EMAIL_API_BASE_URL') }
  return { is_configured: true, provider_code, transport: createEmailTransport(provider_code, option) }
}

export function createEmailTransport(
  provider_code: EmailProviderCode,
  option: { api_key?: string | undefined; from: string; api_url?: string | undefined; base_url?: string | undefined },
): Transport {
  return {
    channel: 'email',
    provider_code,
    async send(input) {
      const subject = input.subject?.trim() || 'A message from your venue'
      const fallback_id = `${provider_code}-${input.idempotency_key}`
      if (provider_code === 'resend') {
        return postJson(
          provider_code,
          {
            url: joinUrl(option.base_url ?? DEFAULT_BASE.resend, 'emails'),
            header: { authorization: `Bearer ${option.api_key ?? ''}`, 'idempotency-key': input.idempotency_key },
            body: { from: option.from, to: [input.recipient], subject, text: input.body },
          },
          input.recipient,
          (parsed) => pickString(parsed, ['id']),
          fallback_id,
        )
      }
      if (provider_code === 'postmark') {
        return postJson(
          provider_code,
          {
            url: joinUrl(option.base_url ?? DEFAULT_BASE.postmark, 'email'),
            header: { 'x-postmark-server-token': option.api_key ?? '' },
            body: {
              From: option.from,
              To: input.recipient,
              Subject: subject,
              TextBody: input.body,
              MessageStream: 'outbound',
              Metadata: { idempotency_key: input.idempotency_key },
            },
          },
          input.recipient,
          (parsed) => pickString(parsed, ['MessageID']),
          fallback_id,
        )
      }
      const header: Record<string, string> = { 'idempotency-key': input.idempotency_key }
      if (option.api_key) header['authorization'] = `Bearer ${option.api_key}`
      return postJson(
        provider_code,
        {
          url: option.api_url ?? '',
          header,
          body: { channel: 'email', idempotency_key: input.idempotency_key, from: option.from, to: input.recipient, subject, text: input.body },
        },
        input.recipient,
        (parsed) => pickString(parsed, ['provider_message_id', 'message_id', 'id']),
        fallback_id,
      )
    },
  }
}

// ---------------------------------------------------------------------------
// sms — the pack's HTTP SMS provider, unchanged, behind the same port
// ---------------------------------------------------------------------------

/** The configured SMS provider, or undefined when NOTIFICATION_SMS_URL is unset. */
export function readSmsProvider(): NotificationProvider | undefined {
  const endpoint_url = readEnv('NOTIFICATION_SMS_URL')
  if (!endpoint_url) return undefined
  const option: HttpSmsProviderOption = { endpoint_url, provider_code: readEnv('NOTIFICATION_SMS_PROVIDER') ?? 'http-sms' }
  const api_key = readEnv('NOTIFICATION_SMS_API_KEY')
  if (api_key) option.api_key = api_key
  const sender = readEnv('NOTIFICATION_SMS_SENDER')
  if (sender) option.sender = sender
  return createHttpSmsProvider(option)
}

/**
 * Wrap a pack NotificationProvider as a transport. The pack's adapter throws
 * without an HTTP status, so a refusal is not retried automatically — exactly
 * the behaviour SMS had before; the operator retries it from the outbox.
 */
export function wrapProvider(provider: NotificationProvider, channel: TransportChannel): Transport {
  return {
    channel,
    provider_code: provider.provider_code,
    async send(input) {
      try {
        const result = await provider.send({
          // The outbox uses the delivery id as the idempotency key.
          notification_delivery_id: input.idempotency_key,
          delivery_channel: input.channel,
          recipient: input.recipient,
          subject: input.subject,
          body: input.body,
          pay_url: null,
        })
        return { is_sent: true, provider_message_id: result.provider_message_id, response_code: result.response_code }
      } catch (error) {
        return {
          is_sent: false,
          is_retryable: false,
          reason: cleanReason(error instanceof Error ? error.message : 'provider error', input.recipient),
          response_code: 'error',
        }
      }
    },
  }
}
