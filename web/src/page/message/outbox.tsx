// Outbox tab: what went to whom, whether it arrived, and what to do about it.

import { ArrowClockwise, BellRinging, PaperPlaneTilt } from '@phosphor-icons/react'
import { useState } from 'react'
import { jsonBody, operatorFetch } from '../../api.ts'
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  ErrorAlert,
  ResourceView,
  SelectInput,
  Stat,
  Toolbar,
  type AlertSeverity,
  type BadgeTone,
} from '../../component/ui.tsx'
import { formatDateTime } from '../../format.ts'
import { useAction, useResource } from '../../hook.ts'
import { CHANNEL_LABEL, countLabel, type OutboxLine, type OutboxStatus, type OutboxView, type ProcessResult, type ReminderResult } from './type.ts'

const STATUS_BADGE: Record<OutboxStatus, { tone: BadgeTone; label: string }> = {
  queued: { tone: 'info', label: 'Queued' },
  held: { tone: 'caution', label: 'Held' },
  sending: { tone: 'info', label: 'Sending' },
  sent: { tone: 'success', label: 'Sent' },
  failed: { tone: 'danger', label: 'Failed' },
  suppressed: { tone: 'neutral', label: 'Not sent — contact blocked' },
}

const STATUS_OPTION = [
  { value: '', label: 'All messages' },
  { value: 'held', label: 'Held (no provider)' },
  { value: 'queued', label: 'Queued' },
  { value: 'sent', label: 'Sent' },
  { value: 'failed', label: 'Failed' },
  { value: 'suppressed', label: 'Not sent — contact blocked' },
]

type Notice = { severity: AlertSeverity; title: string; text?: string }

function describeProcess(result: ProcessResult): Notice {
  if (!result.is_provider_configured) {
    return {
      severity: 'caution',
      title: 'Nothing was sent',
      text: `${countLabel(result.held_count, 'message')} will stay held in the outbox until a provider is configured.`,
    }
  }
  const held = result.held_count > 0 ? ` ${countLabel(result.held_count, 'message')} on a channel with no provider stay held.` : ''
  if (result.sent_count === 0 && result.failed_count === 0 && result.retry_count === 0) {
    return { severity: 'info', title: 'Nothing was waiting to send', text: `The configured channels are clear.${held}` }
  }
  const part = [
    result.failed_count > 0 ? `${countLabel(result.failed_count, 'message')} failed — each shows the provider’s reason and a Retry button.` : '',
    result.retry_count > 0 ? `${countLabel(result.retry_count, 'message')} hit a temporary problem and will try again automatically.` : '',
  ].filter(Boolean)
  return {
    severity: result.failed_count > 0 || result.retry_count > 0 ? 'caution' : 'success',
    title: `Sent ${countLabel(result.sent_count, 'message')}`,
    text: `${part.length > 0 ? part.join(' ') : 'Players will receive them shortly.'}${held}`,
  }
}

function describeReminder(result: ReminderResult): Notice {
  const part = [
    result.already_reminded_count > 0 ? `${result.already_reminded_count} already reminded` : '',
    result.not_opted_in_count > 0 ? `${result.not_opted_in_count} not opted in to reminders` : '',
    result.no_contact_count > 0 ? `${result.no_contact_count} with no email or phone` : '',
  ].filter(Boolean)
  if (result.candidate_count === 0) {
    return { severity: 'info', title: 'No bookings start in the next 24 hours', text: 'There is nobody to remind right now.' }
  }
  return {
    severity: result.queued_count > 0 ? 'success' : 'info',
    title: `Queued ${countLabel(result.queued_count, 'reminder')} for bookings in the next 24 hours`,
    ...(part.length > 0 ? { text: `${part.join(' · ')}.` } : {}),
  }
}

function describeRetry(line: OutboxLine): Notice {
  if (line.status === 'sent') return { severity: 'success', title: 'Message sent', text: `${line.kind_label} to ${line.recipient_mask}.` }
  if (line.status === 'held' || line.status === 'queued') {
    return { severity: 'caution', title: 'Queued again', text: 'It will send as soon as a provider is configured.' }
  }
  return { severity: 'danger', title: 'The provider refused again', text: line.last_error ?? 'No reason was given.' }
}

export function OutboxTab({ can_manage, onChange }: { can_manage: boolean; onChange: () => void }) {
  const [status, setStatus] = useState('')
  const [notice, setNotice] = useState<Notice>()
  const outbox = useResource(
    () => operatorFetch<OutboxView>(`/api/v1/message/outbox${status ? `?status=${encodeURIComponent(status)}` : ''}`),
    [status],
  )

  const refresh = () => {
    outbox.reload()
    onChange()
  }

  const process = useAction(async () => {
    const { result } = await operatorFetch<{ result: ProcessResult }>('/api/v1/message/outbox/process', jsonBody({}))
    setNotice(describeProcess(result))
    refresh()
  })

  const reminder = useAction(async () => {
    const { result } = await operatorFetch<{ result: ReminderResult }>('/api/v1/message/reminder/run', jsonBody({}))
    setNotice(describeReminder(result))
    refresh()
  })

  const [retrying, setRetrying] = useState<string>()
  const retry = useAction(async (line: OutboxLine) => {
    setRetrying(line.notification_delivery_id)
    try {
      const result = await operatorFetch<{ line: OutboxLine }>(
        `/api/v1/message/outbox/${line.notification_delivery_id}/retry`,
        jsonBody({}),
      )
      setNotice(describeRetry(result.line))
      refresh()
    } finally {
      setRetrying(undefined)
    }
  })

  const action_error = process.error ?? reminder.error ?? retry.error

  return (
    <div className="stack">
      <Toolbar>
        <SelectInput label="Show" value={status} option={STATUS_OPTION} onChange={(event) => setStatus(event.target.value)} />
        {can_manage && (
          <div className="row message-toolbar-action">
            <Button icon={<PaperPlaneTilt size={18} aria-hidden />} onClick={() => void process.run()} disabled={process.is_pending}>
              {process.is_pending ? 'Sending…' : 'Send queued now'}
            </Button>
            <Button
              tone="secondary"
              icon={<BellRinging size={18} aria-hidden />}
              onClick={() => void reminder.run()}
              disabled={reminder.is_pending}
            >
              {reminder.is_pending ? 'Queuing…' : 'Queue tomorrow’s reminders'}
            </Button>
          </div>
        )}
      </Toolbar>

      {notice && (
        <Alert severity={notice.severity} title={notice.title} onDismiss={() => setNotice(undefined)}>
          {notice.text}
        </Alert>
      )}
      <ErrorAlert
        error={action_error}
        onDismiss={() => {
          process.clearError()
          reminder.clearError()
          retry.clearError()
        }}
      />

      <ResourceView resource={outbox}>
        {(view) => (
          <>
            <div className="message-stat">
              <Stat
                label="Waiting"
                value={view.summary.queued_count}
                hint={view.summary.held_count > 0 ? `${view.summary.held_count} held — no provider for that channel` : 'Queued to send'}
              />
              <Stat label="Sent" value={view.summary.sent_count} />
              <Stat label="Failed" value={view.summary.failed_count} hint={view.summary.failed_count > 0 ? 'Needs a retry' : undefined} />
              <Stat label="Not sent" value={view.summary.suppressed_count} hint="Player blocked contact" />
            </div>

            {view.outbox.length === 0 ? (
              status ? (
                <EmptyState
                  title={`No ${STATUS_OPTION.find((one) => one.value === status)?.label.toLowerCase() ?? ''} messages`}
                  action={
                    <Button tone="secondary" onClick={() => setStatus('')}>
                      Show all messages
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  title="No player messages yet"
                  description="Messages appear here when a player books, pays, or cancels, and when you queue reminders for tomorrow’s bookings."
                  action={
                    can_manage ? (
                      <Button tone="secondary" onClick={() => void reminder.run()} disabled={reminder.is_pending}>
                        Queue tomorrow’s reminders
                      </Button>
                    ) : undefined
                  }
                />
              )
            ) : (
              <div className="table-wrap" tabIndex={0}>
                <table className="table message-table">
                  <thead>
                    <tr>
                      <th scope="col">Message</th>
                      <th scope="col">Channel</th>
                      <th scope="col">Recipient</th>
                      <th scope="col">Status</th>
                      <th scope="col" className="number">Attempts</th>
                      <th scope="col">Created</th>
                      {can_manage && <th scope="col"><span className="visually-hidden">Action</span></th>}
                    </tr>
                  </thead>
                  <tbody>
                    {view.outbox.map((line) => {
                      const badge = STATUS_BADGE[line.status]
                      return (
                        <tr key={line.notification_delivery_id}>
                          <td>
                            <div className="message-cell">
                              <strong>{line.kind_label}</strong>
                              <span className="muted">
                                {[line.player_name, line.subject_code].filter(Boolean).join(' · ') || (line.is_essential ? 'Essential' : 'Optional')}
                              </span>
                            </div>
                          </td>
                          <td>
                            <Badge>{CHANNEL_LABEL[line.delivery_channel] ?? line.delivery_channel}</Badge>
                          </td>
                          <td className="mono">{line.recipient_mask}</td>
                          <td>
                            <div className="message-cell">
                              <span>
                                <Badge tone={badge.tone}>{badge.label}</Badge>
                              </span>
                              {line.status === 'failed' && line.last_error && <span className="message-error">{line.last_error}</span>}
                              {line.status === 'queued' && line.attempt_count > 0 && line.last_error && (
                                <span className="muted">Will retry automatically — {line.last_error}</span>
                              )}
                            </div>
                          </td>
                          <td className="number">{line.attempt_count}</td>
                          <td className="message-nowrap">{formatDateTime(line.created_at)}</td>
                          {can_manage && (
                            <td>
                              {line.status === 'failed' && (
                                <Button
                                  size="sm"
                                  tone="secondary"
                                  icon={<ArrowClockwise size={16} aria-hidden />}
                                  onClick={() => void retry.run(line)}
                                  disabled={retrying === line.notification_delivery_id}
                                  aria-label={`Retry ${line.kind_label} to ${line.recipient_mask}`}
                                >
                                  {retrying === line.notification_delivery_id ? 'Retrying…' : 'Retry'}
                                </Button>
                              )}
                            </td>
                          )}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </ResourceView>
    </div>
  )
}
