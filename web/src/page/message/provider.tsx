// Provider status, one Alert per channel, and the owner's "Send a test email".

import { EnvelopeSimple } from '@phosphor-icons/react'
import { useState, type FormEvent } from 'react'
import { jsonBody, operatorFetch } from '../../api.ts'
import { Alert, Button, Card, ErrorAlert, TextInput, type AlertSeverity } from '../../component/ui.tsx'
import { useAction, type Resource } from '../../hook.ts'
import { CHANNEL_LABEL, countLabel, type ChannelStatus, type ProviderStatus, type TestEmailResult } from './type.ts'

function ChannelAlert({ channel }: { channel: ChannelStatus }) {
  const label = CHANNEL_LABEL[channel.delivery_channel]
  if (channel.is_configured) {
    return (
      <Alert severity="success" title={`${label} · ${channel.status_label}`}>
        {channel.explanation}
      </Alert>
    )
  }
  const required = channel.env.filter((one) => one.is_required)
  const optional = channel.env.filter((one) => !one.is_required)
  return (
    <Alert severity="caution" title={`${label} · ${channel.status_label}`}>
      <p>
        {channel.explanation} Nothing reaches players by {label.toLowerCase()} yet
        {channel.held_count > 0 ? `; ${countLabel(channel.held_count, 'message')} waiting now` : ''}.
      </p>
      <p>
        To start sending, the venue owner sets <span className="mono">{required.map((one) => one.env_name).join(', ')}</span>
        {optional.length > 0 && (
          <>
            {' '}
            (optionally <span className="mono">{optional.map((one) => one.env_name).join(', ')}</span>)
          </>
        )}{' '}
        on the server, restarts it, then chooses <strong>Send queued now</strong>.
      </p>
    </Alert>
  )
}

export function ProviderAlert({ resource }: { resource: Resource<{ provider: ProviderStatus }> }) {
  const provider = resource.data?.provider
  if (!provider) return null
  return (
    <div className="stack message-provider">
      {provider.channel.map((one) => (
        <ChannelAlert key={one.delivery_channel} channel={one} />
      ))}
    </div>
  )
}

function describeTestEmail(result: TestEmailResult): { severity: AlertSeverity; title: string; text: string } {
  if (result.status === 'sent') {
    return {
      severity: 'success',
      title: `Test email sent to ${result.recipient_mask}`,
      text: `${result.provider_code ?? 'The provider'} accepted it${result.provider_message_id ? ` (message id ${result.provider_message_id})` : ''}. Check the inbox, including spam.`,
    }
  }
  if (result.status === 'held') {
    return { severity: 'caution', title: 'Nothing was sent — email is not configured', text: result.reason ?? 'No email provider is configured.' }
  }
  return {
    severity: 'danger',
    title: `${result.provider_code ?? 'The provider'} refused the test email`,
    text: `${result.reason ?? 'No reason was given.'}${result.is_retryable ? ' This looks temporary; try again in a minute.' : ' Fix the setting it names, then try again.'}`,
  }
}

export function TestEmailForm() {
  const [recipient_email, setRecipientEmail] = useState('')
  const [result, setResult] = useState<TestEmailResult>()

  const send = useAction(async (value: string) => {
    setResult(undefined)
    const response = await operatorFetch<{ result: TestEmailResult }>('/api/v1/message/test-email', jsonBody({ recipient_email: value }))
    setResult(response.result)
  })

  function submit(event: FormEvent) {
    event.preventDefault()
    if (recipient_email.trim()) void send.run(recipient_email.trim())
  }

  const notice = result ? describeTestEmail(result) : undefined

  return (
    <Card title="Send a test email" description="Sends one email to an address you type, so you can see player email arrive before a player does.">
      <div className="stack">
        <form className="message-lookup" onSubmit={submit}>
          <TextInput
            label="Send to"
            type="email"
            placeholder="you@yourvenue.ph"
            autoComplete="email"
            value={recipient_email}
            onChange={(event) => setRecipientEmail(event.target.value)}
          />
          <Button type="submit" tone="secondary" icon={<EnvelopeSimple size={18} aria-hidden />} disabled={send.is_pending || !recipient_email.trim()}>
            {send.is_pending ? 'Sending…' : 'Send a test email'}
          </Button>
        </form>
        <ErrorAlert error={send.error} onDismiss={send.clearError} />
        {notice && (
          <Alert severity={notice.severity} title={notice.title} onDismiss={() => setResult(undefined)}>
            {notice.text}
          </Alert>
        )}
      </div>
    </Card>
  )
}
