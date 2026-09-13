// Webhooks tab: subscriptions, one-time secret, delivery log, replay.

import { ArrowClockwise, PaperPlaneTilt, Plus } from '@phosphor-icons/react'
import { useState, type FormEvent } from 'react'
import { jsonBody, operatorFetch } from '../../api.ts'
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Dialog,
  EmptyState,
  ErrorAlert,
  ResourceView,
  SelectInput,
  TextInput,
  Toolbar,
  type BadgeTone,
} from '../../component/ui.tsx'
import { formatDateTime } from '../../format.ts'
import { useAction, useResource } from '../../hook.ts'
import { useOperator } from '../../session.tsx'
import { ConfirmDialog, CopyField } from './shared.tsx'

type Subscription = {
  webhook_subscription_id: string
  url: string
  description: string | null
  event_code: string[]
  secret_prefix: string
  is_active: boolean
  rotated_at: string | null
  created_at: string
  pending_count: number
  dead_count: number
  last_delivered_at: string | null
  paused_reason: 'address_not_allowed' | null
}

type Delivery = {
  webhook_delivery_id: string
  url: string
  event_code: string
  subject_code: string
  status: 'pending' | 'delivered' | 'failed' | 'dead'
  attempt_count: number
  replay_count: number
  next_attempt_at: string
  last_attempted_at: string | null
  last_status_code: number | null
  last_error: string | null
  delivered_at: string | null
  created_at: string
}

const EVENT_LABEL: Record<string, string> = {
  'booking.held': 'Booking held',
  'booking.confirmed': 'Booking confirmed',
  'booking.cancelled': 'Booking cancelled',
  'payment.recorded': 'Payment recorded',
  'arrival.checked_in': 'Player checked in',
  'program.registered': 'Program registration',
  'match.confirmed': 'Match result confirmed',
  'webhook.ping': 'Test event',
}

const DELIVERY_BADGE: Record<Delivery['status'], { tone: BadgeTone; label: string }> = {
  pending: { tone: 'info', label: 'Queued' },
  delivered: { tone: 'success', label: 'Delivered' },
  failed: { tone: 'caution', label: 'Retrying' },
  dead: { tone: 'danger', label: 'Dead' },
}

const SNIPPET_HEADER = `POST https://your-system.example/hook
content-type: application/json
x-court-event-id: 6f1c2a4e-…        same on every retry and replay: skip ids you have seen
x-court-delivery-attempt: 1
x-court-signature: t=1767225600,v1=5257a869e7…

{"specversion":"1.0","id":"6f1c2a4e-…","type":"booking.confirmed",
 "source":"/court/your-venue","subject":"BK-1001",
 "time":"2026-01-01T00:00:00.000Z","datacontenttype":"application/json","data":{…}}`

const SNIPPET_VERIFY = `import { createHmac, timingSafeEqual } from 'node:crypto'

// rawBody: the exact request body string, before JSON.parse.
export function verifyCourtSignature(secret, header, rawBody) {
  const part = Object.fromEntries(header.split(',').map((one) => one.split('=')))
  if (Math.abs(Date.now() / 1000 - Number(part.t)) > 300) return false // replayed or clock skew
  const expected = createHmac('sha256', secret).update(\`\${part.t}.\${rawBody}\`).digest()
  const given = Buffer.from(part.v1 ?? '', 'hex')
  return given.length === expected.length && timingSafeEqual(expected, given)
}`

export default function WebhookTab() {
  const { can } = useOperator()
  const can_manage = can('webhook.manage')
  const subscription = useResource(() =>
    operatorFetch<{ subscription: Subscription[]; event_code: string[] }>('/api/v1/webhook/subscription'),
  )
  const [status_filter, setStatusFilter] = useState('')
  const delivery = useResource(
    () =>
      operatorFetch<{ delivery: Delivery[] }>(
        `/api/v1/webhook/delivery${status_filter ? `?status=${status_filter}` : ''}`,
      ).then((one) => one.delivery),
    [status_filter],
  )
  const [notice, setNotice] = useState<{ severity: 'success' | 'caution'; text: string }>()
  const [revealed, setRevealed] = useState<{ url: string; secret: string }>()
  const [is_create_open, setCreateOpen] = useState(false)
  const [rotating, setRotating] = useState<Subscription>()
  const [deleting, setDeleting] = useState<Subscription>()

  const reloadAll = () => {
    subscription.reload()
    delivery.reload()
  }

  const process = useAction(async () => {
    const { result } = await operatorFetch<{
      result: { claimed_count: number; delivered_count: number; failed_count: number; dead_count: number }
    }>('/api/v1/webhook/process', { method: 'POST' })
    setNotice(
      result.claimed_count === 0
        ? { severity: 'success', text: 'Nothing was due. Queued deliveries wait for their next retry time.' }
        : {
            severity: result.failed_count + result.dead_count > 0 ? 'caution' : 'success',
            text: `Sent ${result.claimed_count}: ${result.delivered_count} delivered, ${result.failed_count} will retry, ${result.dead_count} dead.`,
          },
    )
    reloadAll()
  })
  const ping = useAction(async (one: Subscription) => {
    const { delivery: sent } = await operatorFetch<{ delivery: Delivery }>(
      '/api/v1/webhook/test',
      jsonBody({ webhook_subscription_id: one.webhook_subscription_id }),
    )
    setNotice(
      sent.status === 'delivered'
        ? { severity: 'success', text: `Test event delivered to ${one.url} (HTTP ${sent.last_status_code}).` }
        : { severity: 'caution', text: `Test event not delivered: ${sent.last_error ?? 'no answer'}. It will retry.` },
    )
    reloadAll()
  })
  const toggle = useAction(async (one: Subscription) => {
    await operatorFetch(
      `/api/v1/webhook/subscription/${one.webhook_subscription_id}`,
      jsonBody({ is_active: !one.is_active }, 'PATCH'),
    )
    setNotice({ severity: 'success', text: one.is_active ? `Paused ${one.url}.` : `Resumed ${one.url}.` })
    subscription.reload()
  })
  const rotate = useAction(async (one: Subscription) => {
    const result = await operatorFetch<{ secret: string }>(
      `/api/v1/webhook/subscription/${one.webhook_subscription_id}/rotate-secret`,
      { method: 'POST' },
    )
    setRotating(undefined)
    setRevealed({ url: one.url, secret: result.secret })
    subscription.reload()
  })
  const remove = useAction(async (one: Subscription) => {
    await operatorFetch(`/api/v1/webhook/subscription/${one.webhook_subscription_id}`, { method: 'DELETE' })
    setDeleting(undefined)
    setNotice({ severity: 'success', text: `Deleted the subscription for ${one.url}.` })
    reloadAll()
  })
  const replay = useAction(async (one: Delivery) => {
    await operatorFetch(`/api/v1/webhook/delivery/${one.webhook_delivery_id}/replay`, { method: 'POST' })
    setNotice({ severity: 'success', text: `${EVENT_LABEL[one.event_code] ?? one.event_code} is queued again. Press Process now to send it.` })
    reloadAll()
  })
  const action_error = ping.error ?? toggle.error ?? replay.error ?? process.error

  return (
    <div className="stack--lg">
      {notice && (
        <Alert severity={notice.severity} onDismiss={() => setNotice(undefined)}>
          {notice.text}
        </Alert>
      )}
      {action_error && (
        <ErrorAlert
          error={action_error}
          onDismiss={() => {
            ping.clearError()
            toggle.clearError()
            replay.clearError()
            process.clearError()
          }}
        />
      )}
      {revealed && (
        <Card title="Copy the signing secret now">
          <div className="stack">
            <Alert severity="caution" title="This secret will not be shown again">
              Store it in the system at {revealed.url}. If it is lost, rotate the secret to get a new one.
            </Alert>
            <CopyField label="Signing secret" value={revealed.secret} />
            <div>
              <Button tone="secondary" size="sm" onClick={() => setRevealed(undefined)}>
                I stored it
              </Button>
            </div>
          </div>
        </Card>
      )}

      <Card
        title="Subscriptions"
        description="Systems that receive venue events as signed HTTPS POSTs."
        action={
          can_manage ? (
            <Button size="sm" icon={<Plus size={16} aria-hidden />} onClick={() => setCreateOpen(true)}>
              Add subscription
            </Button>
          ) : undefined
        }
      >
        <ResourceView resource={subscription}>
          {(data) =>
            data.subscription.length === 0 ? (
              <EmptyState
                title="No subscriptions yet"
                description="Add the URL of your accounting, CRM, or chat system to receive booking, payment, and result events."
                action={
                  can_manage ? (
                    <Button size="sm" onClick={() => setCreateOpen(true)}>
                      Add subscription
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <div className="table-wrap" tabIndex={0}>
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Destination</th>
                      <th scope="col">Events</th>
                      <th scope="col">Status</th>
                      <th scope="col">
                        <span className="visually-hidden">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.subscription.map((one) => (
                      <tr key={one.webhook_subscription_id}>
                        <td>
                          <div className="mono connect-url">{one.url}</div>
                          {one.description && <div className="muted">{one.description}</div>}
                          <div className="muted">
                            Secret {one.secret_prefix}…{one.rotated_at ? ` · rotated ${formatDateTime(one.rotated_at)}` : ''}
                          </div>
                        </td>
                        <td>
                          <div className="connect-badge-list">
                            {one.event_code.map((code) => (
                              <Badge key={code}>{EVENT_LABEL[code] ?? code}</Badge>
                            ))}
                          </div>
                        </td>
                        <td>
                          <div className="connect-badge-list">
                            {one.is_active ? (
                              <Badge tone="success">Active</Badge>
                            ) : one.paused_reason === 'address_not_allowed' ? (
                              <Badge tone="danger">Paused — address not allowed</Badge>
                            ) : (
                              <Badge>Paused</Badge>
                            )}
                            {one.pending_count > 0 && <Badge tone="info">{one.pending_count} queued</Badge>}
                            {one.dead_count > 0 && <Badge tone="danger">{one.dead_count} dead</Badge>}
                          </div>
                        </td>
                        <td>
                          {can_manage && (
                            <div className="connect-cell-action">
                              <Button
                                tone="secondary"
                                size="sm"
                                icon={<PaperPlaneTilt size={16} aria-hidden />}
                                disabled={ping.is_pending}
                                onClick={() => ping.run(one)}
                              >
                                Send test
                              </Button>
                              <Button tone="quiet" size="sm" disabled={toggle.is_pending} onClick={() => toggle.run(one)}>
                                {one.is_active ? 'Pause' : 'Resume'}
                              </Button>
                              <Button tone="quiet" size="sm" onClick={() => setRotating(one)}>
                                Rotate secret
                              </Button>
                              <Button tone="danger" size="sm" onClick={() => setDeleting(one)}>
                                Delete
                              </Button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          }
        </ResourceView>
      </Card>

      <Card
        title="Delivery log"
        description="Each event is retried with growing waits (1, 2, 4, 8, 16 minutes). After 6 failed attempts it is marked dead until you replay it."
        action={
          can_manage ? (
            <Button
              tone="secondary"
              size="sm"
              icon={<ArrowClockwise size={16} aria-hidden />}
              disabled={process.is_pending}
              onClick={() => process.run()}
            >
              {process.is_pending ? 'Sending…' : 'Process now'}
            </Button>
          ) : undefined
        }
      >
        <Toolbar>
          <SelectInput
            label="Show"
            value={status_filter}
            onChange={(event) => setStatusFilter(event.target.value)}
            option={[
              { value: '', label: 'All deliveries' },
              { value: 'pending', label: 'Queued' },
              { value: 'failed', label: 'Retrying' },
              { value: 'dead', label: 'Dead' },
              { value: 'delivered', label: 'Delivered' },
            ]}
          />
        </Toolbar>
        <ResourceView resource={delivery}>
          {(row) =>
            row.length === 0 ? (
              <EmptyState
                title={status_filter ? 'No deliveries with this status' : 'No deliveries yet'}
                description="Deliveries appear when a subscribed event happens, or when you send a test event."
              />
            ) : (
              <div className="table-wrap" tabIndex={0}>
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Event</th>
                      <th scope="col">Destination</th>
                      <th scope="col">Status</th>
                      <th scope="col">Attempts</th>
                      <th scope="col">Last result</th>
                      <th scope="col">
                        <span className="visually-hidden">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {row.map((one) => {
                      const badge = DELIVERY_BADGE[one.status]
                      return (
                        <tr key={one.webhook_delivery_id}>
                          <td>
                            <div>{EVENT_LABEL[one.event_code] ?? one.event_code}</div>
                            <div className="muted mono">{one.subject_code}</div>
                          </td>
                          <td className="mono connect-url">{one.url}</td>
                          <td>
                            <div className="connect-badge-list">
                              <Badge tone={badge.tone}>{badge.label}</Badge>
                              {one.replay_count > 0 && <Badge>Replayed</Badge>}
                            </div>
                          </td>
                          <td>{one.attempt_count} of 6</td>
                          <td className="connect-detail">
                            {one.status === 'delivered' && one.delivered_at && (
                              <span>
                                HTTP {one.last_status_code} · {formatDateTime(one.delivered_at)}
                              </span>
                            )}
                            {one.status !== 'delivered' && (
                              <span>
                                {one.last_error ?? 'Not tried yet'}
                                {one.status === 'failed' && (
                                  <span className="muted"> · next try {formatDateTime(one.next_attempt_at)}</span>
                                )}
                              </span>
                            )}
                          </td>
                          <td>
                            {can_manage && (one.status === 'dead' || one.status === 'failed') && (
                              <div className="connect-cell-action">
                                <Button tone="secondary" size="sm" disabled={replay.is_pending} onClick={() => replay.run(one)}>
                                  Replay
                                </Button>
                              </div>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )
          }
        </ResourceView>
      </Card>

      <Card title="Verifying a delivery" description="What your system receives, and how to check it came from this venue.">
        <div className="stack">
          <pre className="connect-code" tabIndex={0} aria-label="Example request">
            {SNIPPET_HEADER}
          </pre>
          <pre className="connect-code" tabIndex={0} aria-label="Signature verification in Node.js">
            {SNIPPET_VERIFY}
          </pre>
          <p className="muted">
            Answer with any 2xx within 10 seconds. Delivery is at least once, so use x-court-event-id to ignore repeats.
          </p>
        </div>
      </Card>

      <ResourceView resource={subscription}>
        {(data) => (
          <CreateDialog
            open={is_create_open}
            event_code={data.event_code}
            onClose={() => setCreateOpen(false)}
            onCreated={(url, secret) => {
              setCreateOpen(false)
              setRevealed({ url, secret })
              setNotice({ severity: 'success', text: `Subscription added for ${url}.` })
              subscription.reload()
            }}
          />
        )}
      </ResourceView>

      <ConfirmDialog
        open={rotating !== undefined}
        title="Rotate the signing secret?"
        confirm_label="Rotate secret"
        is_pending={rotate.is_pending}
        onConfirm={() => rotating && rotate.run(rotating)}
        onClose={() => setRotating(undefined)}
      >
        <div className="stack">
          <p>
            Deliveries to {rotating?.url} will be signed with a new secret immediately. The old secret stops working, so update
            the receiving system right away.
          </p>
          <ErrorAlert error={rotate.error} />
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={deleting !== undefined}
        title="Delete this subscription?"
        confirm_label="Delete"
        is_pending={remove.is_pending}
        onConfirm={() => deleting && remove.run(deleting)}
        onClose={() => setDeleting(undefined)}
      >
        <div className="stack">
          <p>{deleting?.url} will stop receiving events, including any still queued.</p>
          <ErrorAlert error={remove.error} />
        </div>
      </ConfirmDialog>
    </div>
  )
}

function CreateDialog({
  open,
  event_code,
  onClose,
  onCreated,
}: {
  open: boolean
  event_code: string[]
  onClose: () => void
  onCreated: (url: string, secret: string) => void
}) {
  const [url, setUrl] = useState('')
  const [description, setDescription] = useState('')
  const [chosen, setChosen] = useState<string[]>([])
  const save = useAction(async () => {
    const result = await operatorFetch<{ subscription: Subscription; secret: string }>(
      '/api/v1/webhook/subscription',
      jsonBody({ url, description, event_code: chosen }),
    )
    setUrl('')
    setDescription('')
    setChosen([])
    onCreated(result.subscription.url, result.secret)
  })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    void save.run()
  }

  return (
    <Dialog open={open} title="Add a webhook subscription" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <TextInput
          label="Destination URL"
          hint="Must start with https:// and be reachable on the public internet (no private or internal addresses)."
          type="url"
          inputMode="url"
          placeholder="https://"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          required
          autoFocus
        />
        <TextInput label="Label (optional)" value={description} onChange={(event) => setDescription(event.target.value)} />
        <fieldset className="connect-fieldset">
          <legend>Events to send</legend>
          <div className="connect-checkbox-grid">
            {event_code.map((code) => (
              <Checkbox
                key={code}
                label={EVENT_LABEL[code] ?? code}
                checked={chosen.includes(code)}
                onChange={(event) =>
                  setChosen((value) => (event.target.checked ? [...value, code] : value.filter((one) => one !== code)))
                }
              />
            ))}
          </div>
        </fieldset>
        <ErrorAlert error={save.error} onDismiss={save.clearError} />
        <div className="form__action">
          <Button type="submit" disabled={!url.trim() || chosen.length === 0 || save.is_pending}>
            {save.is_pending ? 'Adding…' : 'Add subscription'}
          </Button>
          <Button tone="quiet" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
