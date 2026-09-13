// Calendar tab: subscribable .ics feeds, link shown once, rotate and revoke.

import { CalendarPlus, Plus } from '@phosphor-icons/react'
import { useState, type FormEvent } from 'react'
import { jsonBody, operatorFetch } from '../../api.ts'
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorAlert,
  ResourceView,
  SelectInput,
  TextInput,
} from '../../component/ui.tsx'
import { formatDate } from '../../format.ts'
import { useAction, useResource } from '../../hook.ts'
import { useOperator } from '../../session.tsx'
import { ConfirmDialog, CopyField } from './shared.tsx'

type Feed = {
  calendar_feed_id: string
  scope_code: 'venue' | 'court' | 'program'
  scope_id: string | null
  display_name: string
  token_prefix: string
  is_active: boolean
  rotated_at: string | null
  revoked_at: string | null
  created_at: string
}

type Court = { resource_id: string; display_name: string }

type Created = { feed: Feed; feed_path: string }

export default function CalendarTab() {
  const { can } = useOperator()
  const can_manage = can('calendar.manage')
  const feed = useResource(() => operatorFetch<{ feed: Feed[] }>('/api/v1/calendar/feed').then((one) => one.feed))
  const court = useResource(() =>
    operatorFetch<{ court: Court[] }>('/api/v1/court/board')
      .then((one) => one.court)
      .catch(() => [] as Court[]),
  )
  const [revealed, setRevealed] = useState<{ display_name: string; url: string; is_rotated: boolean }>()
  const [notice, setNotice] = useState<string>()
  const [is_create_open, setCreateOpen] = useState(false)
  const [rotating, setRotating] = useState<Feed>()
  const [revoking, setRevoking] = useState<Feed>()

  const reveal = (created: Created, is_rotated: boolean) =>
    setRevealed({ display_name: created.feed.display_name, url: `${window.location.origin}${created.feed_path}`, is_rotated })

  const rotate = useAction(async (one: Feed) => {
    const created = await operatorFetch<Created>(`/api/v1/calendar/feed/${one.calendar_feed_id}/rotate`, { method: 'POST' })
    setRotating(undefined)
    setNotice(undefined)
    reveal(created, true)
    feed.reload()
  })
  const revoke = useAction(async (one: Feed) => {
    await operatorFetch(`/api/v1/calendar/feed/${one.calendar_feed_id}/revoke`, { method: 'POST' })
    setRevoking(undefined)
    setRevealed(undefined)
    setNotice(`${one.display_name} is revoked. Calendars subscribed to it stop updating.`)
    feed.reload()
  })

  const scopeLabel = (one: Feed) => {
    if (one.scope_code === 'venue') return 'Whole venue'
    if (one.scope_code === 'court') return court.data?.find((each) => each.resource_id === one.scope_id)?.display_name ?? 'One court'
    return 'Program'
  }

  return (
    <div className="stack--lg">
      {notice && (
        <Alert severity="success" onDismiss={() => setNotice(undefined)}>
          {notice}
        </Alert>
      )}

      <Card
        title="Calendar feeds"
        description="Subscribe in Google Calendar or Apple Calendar. Changes here update there; edits there never change your venue."
        action={
          can_manage ? (
            <Button size="sm" icon={<Plus size={16} aria-hidden />} onClick={() => setCreateOpen(true)}>
              New feed
            </Button>
          ) : undefined
        }
      >
        <div className="stack">
          <div className="connect-explainer">
            <p>
              A feed shows bookings as "Court booked" blocks and scheduled programs, with no player names or contact details.
              Calendar apps refresh subscribed feeds on their own schedule, often every few hours.
            </p>
          </div>

          {revealed && (
            <div className="stack">
              <Alert severity="success" title={revealed.is_rotated ? 'New link ready' : 'Feed ready'}>
                Copy the link for {revealed.display_name} now. It is shown only once
                {revealed.is_rotated ? '. The previous link has stopped working.' : '.'}
              </Alert>
              <CopyField label="Feed link" value={revealed.url} />
              <div className="row">
                <a
                  className="button button--secondary button--sm"
                  href={`https://calendar.google.com/calendar/r?cid=${encodeURIComponent(revealed.url.replace(/^https?:/, 'webcal:'))}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <CalendarPlus size={16} aria-hidden /> Add to Google Calendar
                </a>
                <a className="button button--secondary button--sm" href={revealed.url.replace(/^https?:/, 'webcal:')}>
                  <CalendarPlus size={16} aria-hidden /> Open in Apple Calendar
                </a>
                <Button tone="quiet" size="sm" onClick={() => setRevealed(undefined)}>
                  Done
                </Button>
              </div>
            </div>
          )}

          <ErrorAlert error={rotate.error ?? revoke.error} />

          <ResourceView resource={feed}>
            {(row) =>
              row.length === 0 ? (
                <EmptyState
                  title="No calendar feeds yet"
                  description="Create a feed for the whole venue or one court, then paste its link into your calendar app."
                  action={
                    can_manage ? (
                      <Button size="sm" onClick={() => setCreateOpen(true)}>
                        New feed
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Feed</th>
                        <th scope="col">Covers</th>
                        <th scope="col">Created</th>
                        <th scope="col">Status</th>
                        <th scope="col">
                          <span className="visually-hidden">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {row.map((one) => (
                        <tr key={one.calendar_feed_id}>
                          <td>
                            <div>{one.display_name}</div>
                            <div className="muted mono">…/calendar/{one.token_prefix}…</div>
                          </td>
                          <td>
                            <Badge>{scopeLabel(one)}</Badge>
                          </td>
                          <td>
                            {formatDate(one.created_at)}
                            {one.rotated_at && <div className="muted">new link {formatDate(one.rotated_at)}</div>}
                          </td>
                          <td>{one.is_active ? <Badge tone="success">Active</Badge> : <Badge tone="danger">Revoked</Badge>}</td>
                          <td>
                            {can_manage && one.is_active && (
                              <div className="connect-cell-action">
                                <Button tone="secondary" size="sm" onClick={() => setRotating(one)}>
                                  New link
                                </Button>
                                <Button tone="danger" size="sm" onClick={() => setRevoking(one)}>
                                  Revoke
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
        </div>
      </Card>

      <CreateFeedDialog
        open={is_create_open}
        court={court.data ?? []}
        onClose={() => setCreateOpen(false)}
        onCreated={(created) => {
          setCreateOpen(false)
          setNotice(undefined)
          reveal(created, false)
          feed.reload()
        }}
      />

      <ConfirmDialog
        open={rotating !== undefined}
        title="Replace this feed's link?"
        confirm_label="Get new link"
        tone="primary"
        is_pending={rotate.is_pending}
        onConfirm={() => rotating && rotate.run(rotating)}
        onClose={() => setRotating(undefined)}
      >
        <p>
          The current link for {rotating?.display_name} stops working immediately. Everyone subscribed must add the new link.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={revoking !== undefined}
        title="Revoke this feed?"
        confirm_label="Revoke feed"
        is_pending={revoke.is_pending}
        onConfirm={() => revoking && revoke.run(revoking)}
        onClose={() => setRevoking(undefined)}
      >
        <p>
          {revoking?.display_name} stops working for everyone and cannot be turned back on. Create a new feed if you need one
          later.
        </p>
      </ConfirmDialog>
    </div>
  )
}

function CreateFeedDialog({
  open,
  court,
  onClose,
  onCreated,
}: {
  open: boolean
  court: Court[]
  onClose: () => void
  onCreated: (created: Created) => void
}) {
  const [scope_code, setScope] = useState<'venue' | 'court'>('venue')
  const [scope_id, setScopeId] = useState('')
  const [display_name, setName] = useState('')
  const save = useAction(async () => {
    const created = await operatorFetch<Created>(
      '/api/v1/calendar/feed',
      jsonBody({ scope_code, scope_id: scope_code === 'court' ? scope_id : null, display_name }),
    )
    setScope('venue')
    setScopeId('')
    setName('')
    onCreated(created)
  })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    void save.run()
  }

  return (
    <Dialog open={open} title="New calendar feed" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <SelectInput
          label="Covers"
          value={scope_code}
          onChange={(event) => {
            setScope(event.target.value as 'venue' | 'court')
            setScopeId(court[0]?.resource_id ?? '')
          }}
          option={[
            { value: 'venue', label: 'Whole venue' },
            ...(court.length > 0 ? [{ value: 'court', label: 'One court' }] : []),
          ]}
        />
        {scope_code === 'court' && (
          <SelectInput
            label="Court"
            value={scope_id}
            onChange={(event) => setScopeId(event.target.value)}
            option={court.map((one) => ({ value: one.resource_id, label: one.display_name }))}
          />
        )}
        <TextInput
          label="Name (optional)"
          hint="Shown as the calendar's name in the subscriber's app."
          value={display_name}
          onChange={(event) => setName(event.target.value)}
        />
        <ErrorAlert error={save.error} onDismiss={save.clearError} />
        <div className="form__action">
          <Button type="submit" disabled={save.is_pending || (scope_code === 'court' && !scope_id)}>
            {save.is_pending ? 'Creating…' : 'Create feed'}
          </Button>
          <Button tone="quiet" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
