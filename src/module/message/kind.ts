// The message catalogue and template rules — pure, no database.
//
// Ten transactional kinds, each with a customer-facing label, whether it is
// essential (always sends) or optional (needs the player's opt-in), the
// placeholders its wording may use, sample values for previews, and default
// copy for both channels.

import { DomainError } from '@bygelo/roundrobin-kernel'
import type { MessageKind } from './contract.ts'

export class MessageInputError extends DomainError {
  constructor(message: string) {
    super(message, 400)
  }
}

export class MessageNotFoundError extends DomainError {
  constructor(message: string) {
    super(message, 404)
  }
}

export class MessageConflictError extends DomainError {
  constructor(message: string) {
    super(message, 409)
  }
}

export type MessageChannel = 'email' | 'sms'

export const MESSAGE_CHANNEL: MessageChannel[] = ['email', 'sms']

export const BODY_LIMIT: Record<MessageChannel, number> = { email: 1000, sms: 320 }
export const SUBJECT_LIMIT = 120

export type KindMeta = {
  message_kind: MessageKind
  label: string
  description: string
  is_essential: boolean
  placeholder: string[]
  sample: Record<string, string>
  default_subject: string
  default_email: string
  default_sms: string
}

const SAMPLE_BASE = {
  player_name: 'Andrea Santos',
  venue_name: 'Sideout Pickleball Club',
  court_name: 'Court 3',
  date: 'Sat, Sep 20',
  time: '6:00 PM',
  booking_code: 'BK-7Q4M2',
  recovery_link: 'https://sideout.example/v/sideout/booking/BK-7Q4M2',
}

export const MESSAGE_KIND: KindMeta[] = [
  {
    message_kind: 'booking_confirmed',
    label: 'Booking confirmed',
    description: 'Sent the moment a court is secured.',
    is_essential: true,
    placeholder: ['player_name', 'venue_name', 'court_name', 'date', 'time', 'booking_code', 'recovery_link'],
    sample: { ...SAMPLE_BASE },
    default_subject: 'You are booked: {{court_name}} on {{date}}',
    default_email:
      'Hi {{player_name}},\n\nYour court is confirmed at {{venue_name}}: {{court_name}}, {{date}} at {{time}}.\nBooking code: {{booking_code}}\n\nView or change your booking: {{recovery_link}}\n\nSee you on the court!',
    default_sms: '{{venue_name}}: {{court_name}} booked for {{date}} {{time}}. Code {{booking_code}}. Manage: {{recovery_link}}',
  },
  {
    message_kind: 'booking_receipt',
    label: 'Payment receipt',
    description: 'Sent when a payment for a booking is recorded.',
    is_essential: true,
    placeholder: ['player_name', 'venue_name', 'court_name', 'date', 'time', 'booking_code', 'amount', 'recovery_link'],
    sample: { ...SAMPLE_BASE, amount: '₱800.00' },
    default_subject: 'Receipt for booking {{booking_code}}',
    default_email:
      'Hi {{player_name}},\n\nWe received {{amount}} for {{court_name}} on {{date}} at {{time}}.\nBooking code: {{booking_code}}\n\nYour booking: {{recovery_link}}\n\nThank you for playing at {{venue_name}}.',
    default_sms: '{{venue_name}}: received {{amount}} for booking {{booking_code}} ({{date}} {{time}}). Thank you!',
  },
  {
    message_kind: 'booking_cancelled',
    label: 'Booking cancelled',
    description: 'Sent after a booking is cancelled by the player or the venue.',
    is_essential: true,
    placeholder: ['player_name', 'venue_name', 'court_name', 'date', 'time', 'booking_code', 'recovery_link'],
    sample: { ...SAMPLE_BASE },
    default_subject: 'Booking {{booking_code}} cancelled',
    default_email:
      'Hi {{player_name}},\n\nYour booking for {{court_name}} on {{date}} at {{time}} has been cancelled.\nBooking code: {{booking_code}}\n\nDetails: {{recovery_link}}\n\nWe hope to see you soon at {{venue_name}}.',
    default_sms: '{{venue_name}}: booking {{booking_code}} for {{date}} {{time}} is cancelled. Details: {{recovery_link}}',
  },
  {
    message_kind: 'court_changed',
    label: 'Court changed',
    description: 'Sent when the venue moves a booking to a different court.',
    is_essential: true,
    placeholder: ['player_name', 'venue_name', 'previous_court_name', 'court_name', 'date', 'time', 'booking_code'],
    sample: { ...SAMPLE_BASE, previous_court_name: 'Court 1' },
    default_subject: 'Your court moved to {{court_name}}',
    default_email:
      'Hi {{player_name}},\n\nYour booking {{booking_code}} on {{date}} at {{time}} has moved from {{previous_court_name}} to {{court_name}}.\n\nSorry for the change — see you at {{venue_name}}.',
    default_sms: '{{venue_name}}: your {{date}} {{time}} booking moved from {{previous_court_name}} to {{court_name}}.',
  },
  {
    message_kind: 'closure',
    label: 'Venue closure',
    description: 'Sent when the venue closes during a player’s booking.',
    is_essential: true,
    placeholder: ['player_name', 'venue_name', 'date', 'time', 'reason', 'booking_code'],
    sample: { ...SAMPLE_BASE, reason: 'heavy rain flooding the outdoor courts' },
    default_subject: '{{venue_name}} is closed on {{date}}',
    default_email:
      'Hi {{player_name}},\n\n{{venue_name}} is closed on {{date}} from {{time}} because of {{reason}}.\nYour booking {{booking_code}} is affected — we will help you rebook or refund.',
    default_sms: '{{venue_name}} is closed {{date}} {{time}} ({{reason}}). Booking {{booking_code}} is affected; we will help you rebook.',
  },
  {
    message_kind: 'booking_reminder',
    label: 'Booking reminder',
    description: 'Sent the day before a booking starts.',
    is_essential: false,
    placeholder: ['player_name', 'venue_name', 'court_name', 'date', 'time', 'booking_code', 'recovery_link'],
    sample: { ...SAMPLE_BASE },
    default_subject: 'Reminder: {{court_name}} {{date}} at {{time}}',
    default_email:
      'Hi {{player_name}},\n\nA reminder that you are playing at {{venue_name}} on {{date}} at {{time}}, {{court_name}}.\nBooking code: {{booking_code}}\n\nNeed to change? {{recovery_link}}',
    default_sms: 'Reminder from {{venue_name}}: {{court_name}} {{date}} {{time}}. Code {{booking_code}}.',
  },
  {
    message_kind: 'waitlist_opened',
    label: 'Waitlist spot open',
    description: 'Sent when a spot a player waited for opens up.',
    is_essential: false,
    placeholder: ['player_name', 'venue_name', 'court_name', 'date', 'time', 'claim_link', 'claim_deadline'],
    sample: { ...SAMPLE_BASE, claim_link: 'https://sideout.example/v/sideout', claim_deadline: '5:30 PM today' },
    default_subject: 'A spot opened: {{date}} at {{time}}',
    default_email:
      'Hi {{player_name}},\n\nA spot you were waiting for opened at {{venue_name}}: {{court_name}}, {{date}} at {{time}}.\nClaim it by {{claim_deadline}}: {{claim_link}}',
    default_sms: '{{venue_name}}: a spot opened {{date}} {{time}}. Claim by {{claim_deadline}}: {{claim_link}}',
  },
  {
    message_kind: 'program_registered',
    label: 'Program registration',
    description: 'Sent when a player registers for a clinic, league, or program.',
    is_essential: false,
    placeholder: ['player_name', 'venue_name', 'program_name', 'date', 'time', 'registration_code'],
    sample: { ...SAMPLE_BASE, program_name: 'Beginner Pickleball Clinic', registration_code: 'PR-3KD9' },
    default_subject: 'You are registered: {{program_name}}',
    default_email:
      'Hi {{player_name}},\n\nYou are registered for {{program_name}} at {{venue_name}}, starting {{date}} at {{time}}.\nRegistration code: {{registration_code}}',
    default_sms: '{{venue_name}}: registered for {{program_name}}, starts {{date}} {{time}}. Code {{registration_code}}.',
  },
  {
    message_kind: 'pickup_ready',
    label: 'Order ready for pickup',
    description: 'Sent when a shop order is ready at the front desk.',
    is_essential: false,
    placeholder: ['player_name', 'venue_name', 'order_code', 'pickup_note'],
    sample: { ...SAMPLE_BASE, order_code: 'OR-58TX', pickup_note: 'Pick up at the front desk before 9 PM.' },
    default_subject: 'Order {{order_code}} is ready',
    default_email:
      'Hi {{player_name}},\n\nYour order {{order_code}} is ready at {{venue_name}}.\n{{pickup_note}}',
    default_sms: '{{venue_name}}: order {{order_code}} is ready. {{pickup_note}}',
  },
  {
    message_kind: 'waiver_prompt',
    label: 'Waiver reminder',
    description: 'Sent when a player still needs to sign the venue waiver before playing.',
    is_essential: false,
    placeholder: ['player_name', 'venue_name', 'date', 'waiver_link'],
    sample: { ...SAMPLE_BASE, waiver_link: 'https://sideout.example/v/sideout/waiver' },
    default_subject: 'Please sign the {{venue_name}} waiver',
    default_email:
      'Hi {{player_name}},\n\nBefore you play on {{date}}, please sign the {{venue_name}} waiver. It takes a minute: {{waiver_link}}',
    default_sms: '{{venue_name}}: please sign the waiver before you play {{date}}: {{waiver_link}}',
  },
]

export const ESSENTIAL_KIND: MessageKind[] = MESSAGE_KIND.filter((one) => one.is_essential).map((one) => one.message_kind)
export const OPTIONAL_KIND: MessageKind[] = MESSAGE_KIND.filter((one) => !one.is_essential).map((one) => one.message_kind)
export const ALL_KIND: MessageKind[] = MESSAGE_KIND.map((one) => one.message_kind)

export function findKind(message_kind: string): KindMeta | undefined {
  return MESSAGE_KIND.find((one) => one.message_kind === message_kind)
}

export function requireKind(message_kind: string): KindMeta {
  const meta = findKind(message_kind)
  if (!meta) throw new MessageNotFoundError(`There is no message kind called “${message_kind}”.`)
  return meta
}

export function requireChannel(channel: string): MessageChannel {
  if (channel !== 'email' && channel !== 'sms') {
    throw new MessageNotFoundError(`Messages go by email or sms, not “${channel}”.`)
  }
  return channel
}

export function defaultTemplate(meta: KindMeta, channel: MessageChannel): { subject: string | null; body: string } {
  return channel === 'email'
    ? { subject: meta.default_subject, body: meta.default_email }
    : { subject: null, body: meta.default_sms }
}

const TOKEN = /\{\{\s*([^{}]*?)\s*\}\}/g

/** Every placeholder name written in `text`, in order, including unknown ones. */
export function listPlaceholder(text: string): string[] {
  return [...text.matchAll(TOKEN)].map((match) => match[1] ?? '')
}

/**
 * Check a template against its kind's rules. Returns the cleaned values or
 * throws one sentence naming the first problem.
 */
export function validateTemplate(
  meta: KindMeta,
  channel: MessageChannel,
  input: { subject?: unknown; body?: unknown },
): { subject: string | null; body: string } {
  if (typeof input.body !== 'string' || input.body.trim() === '') {
    throw new MessageInputError('The message text cannot be empty.')
  }
  const body = input.body.trim()
  if (body.length > BODY_LIMIT[channel]) {
    throw new MessageInputError(
      `${channel === 'sms' ? 'An SMS' : 'An email'} can be at most ${BODY_LIMIT[channel]} characters; this one is ${body.length}.`,
    )
  }

  let subject: string | null = null
  if (channel === 'email') {
    if (typeof input.subject !== 'string' || input.subject.trim() === '') {
      throw new MessageInputError('An email needs a subject line.')
    }
    subject = input.subject.trim()
    if (subject.length > SUBJECT_LIMIT) {
      throw new MessageInputError(`The subject line can be at most ${SUBJECT_LIMIT} characters; this one is ${subject.length}.`)
    }
  } else if (typeof input.subject === 'string' && input.subject.trim() !== '') {
    throw new MessageInputError('An SMS has no subject line — put everything in the message text.')
  }

  for (const text of [subject ?? '', body]) {
    const unknown = listPlaceholder(text).find((name) => !meta.placeholder.includes(name))
    if (unknown !== undefined) {
      throw new MessageInputError(
        `“{{${unknown}}}” is not available in ${meta.label} messages. Use one of: ${meta.placeholder.map((one) => `{{${one}}}`).join(', ')}.`,
      )
    }
    const stripped = text.replace(TOKEN, '')
    if (stripped.includes('{{') || stripped.includes('}}')) {
      throw new MessageInputError('A placeholder is not closed. Write placeholders like {{player_name}}.')
    }
  }
  return { subject, body }
}

/** Fill placeholders. A value the producer did not supply renders as nothing. */
export function renderText(text: string, detail: Record<string, string>): string {
  return text
    .replace(TOKEN, (_whole, name: string) => detail[name] ?? '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/**
 * Producers name things their own way (portal passes `player`, `court`,
 * `starts_at`). Fold the common aliases into the documented placeholders so a
 * template still reads well; explicit placeholder values always win.
 */
export function normalizeDetail(detail: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  const alias: Record<string, string> = {
    player: 'player_name',
    court: 'court_name',
    venue: 'venue_name',
    total_amount: 'amount',
    paid_amount: 'amount',
    previous_court: 'previous_court_name',
    program: 'program_name',
  }
  for (const [key, value] of Object.entries(detail)) {
    if (typeof value !== 'string') continue
    const target = alias[key]
    if (target && detail[target] === undefined && out[target] === undefined) out[target] = value
    out[key] = value
  }
  if (out['date'] === undefined && out['starts_at'] !== undefined) {
    out['date'] = out['starts_at']
    if (out['time'] === undefined) out['time'] = ''
  }
  return out
}

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const PHONE_PATTERN = /\+?\d[\d\s-]{6,}\d/g

/** Turn a stored provider error into a sentence with no contact detail in it. */
export function errorSentence(last_error: string | null): string | null {
  if (!last_error) return null
  const scrubbed = last_error
    .replace(EMAIL_PATTERN, (email) => `${email.slice(0, 1)}•••@${email.split('@')[1] ?? '•••'}`)
    .replace(PHONE_PATTERN, (phone) => `••••${phone.replace(/\D/g, '').slice(-4)}`)
    .trim()
  const sentence = scrubbed.charAt(0).toUpperCase() + scrubbed.slice(1)
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`
}

export type OutboxStatus = 'queued' | 'held' | 'sending' | 'sent' | 'failed' | 'suppressed'

/** The pack's delivery status as an operator reads it. Queued with no provider is held. */
export function outboxStatus(status: string, is_provider_configured: boolean): OutboxStatus {
  if (status === 'queued') return is_provider_configured ? 'queued' : 'held'
  if (status === 'claimed') return 'sending'
  if (status === 'delivered') return 'sent'
  if (status === 'failed') return 'failed'
  return 'suppressed'
}

/** Normalise a phone for lookup: the last ten digits, which survives +63 / 0 prefixes. */
export function phoneKey(phone: string): string {
  return phone.replace(/\D/g, '').slice(-10)
}

export function isEmail(contact: string): boolean {
  return contact.includes('@')
}
