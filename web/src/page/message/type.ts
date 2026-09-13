// Shapes of the /api/v1/message responses, as the screens read them.

export type MessageChannel = 'email' | 'sms'

export type OutboxStatus = 'queued' | 'held' | 'sending' | 'sent' | 'failed' | 'suppressed'

export type ProviderStatus = {
  is_configured: boolean
  provider_code: string | null
  held_count: number
  channel: { delivery_channel: MessageChannel; is_configured: boolean; status_label: string; explanation: string }[]
  env: { env_name: string; is_required: boolean; is_set: boolean; description: string }[]
}

export type OutboxLine = {
  notification_delivery_id: string
  message_kind: string
  kind_label: string
  is_essential: boolean
  delivery_channel: MessageChannel
  recipient_mask: string
  player_name: string | null
  subject_code: string | null
  status: OutboxStatus
  attempt_count: number
  last_error: string | null
  created_at: string
  updated_at: string
}

export type OutboxView = {
  is_provider_configured: boolean
  summary: { queued_count: number; sent_count: number; failed_count: number; suppressed_count: number }
  outbox: OutboxLine[]
}

export type ProcessResult = {
  is_provider_configured: boolean
  sent_count: number
  failed_count: number
  held_count: number
  remaining_count?: number
}

export type ReminderResult = {
  candidate_count: number
  queued_count: number
  already_reminded_count: number
  not_opted_in_count: number
  no_contact_count: number
  other_count: number
}

export type KindMeta = {
  message_kind: string
  label: string
  description: string
  is_essential: boolean
  placeholder: string[]
  sample: Record<string, string>
}

export type Template = {
  message_kind: string
  delivery_channel: MessageChannel
  subject: string | null
  body: string
  is_active: boolean
  updated_at: string
}

export type TemplateView = {
  kind: KindMeta[]
  template: Template[]
  body_limit: Record<MessageChannel, number>
}

export type Preview = { subject: string | null; body: string; character_count: number; body_limit: number }

export type PreferenceView = {
  player: { display_name: string; email_mask: string | null; phone_mask: string | null }
  is_contact_allowed: boolean
  preference: { message_kind: string; label: string; description: string; is_essential: boolean; is_opted_in: boolean }[]
}

export const CHANNEL_LABEL: Record<MessageChannel, string> = { email: 'Email', sms: 'SMS' }

export function countLabel(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}
