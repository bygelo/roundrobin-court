// Operator → Arrival. Today's desk: everyone expected (court bookings and
// program registrations), whether they paid and signed the current waiver, a
// code field that resolves a typed or scanned code, one-tap check-in, and an
// override that requires a reason. A second tab manages waiver versions.

import { CheckCircle, MagnifyingGlass, QrCode } from '@phosphor-icons/react'
import { useMemo, useState, type FormEvent } from 'react'
import { ApiError, jsonBody, operatorFetch } from '../../api.ts'
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorAlert,
  PageHeader,
  ResourceView,
  Stat,
  Tabs,
  TextArea,
  TextInput,
  Toolbar,
} from '../../component/ui.tsx'
import { formatDate, formatDateTime, formatTime, formatTimeRange, toDateInput } from '../../format.ts'
import { useAction, useInterval, useResource } from '../../hook.ts'
import type { PageProp } from '../../registry.ts'
import { useOperator } from '../../session.tsx'
import './arrival.css'

type ArrivalRow = {
  subject_kind: 'booking' | 'registration'
  subject_id: string
  party_id: string | null
  display_name: string
  label: string
  detail_label: string
  starts_at: string
  ends_at: string
  price_amount: string
  paid_state: 'paid' | 'unpaid' | 'free'
  waiver_state: 'current' | 'outdated' | 'missing' | 'not_required'
  eligibility: { is_eligible: boolean; blocker: string[]; sentence: string }
  status_code: string
  check_in: { checked_in_at: string; method_code: string; reason: string | null } | null
}

type ArrivalDay = {
  date: string
  expected_count: number
  arrived_count: number
  waiver: { version_number: number; title: string } | null
  arrival: ArrivalRow[]
}

type WaiverVersion = {
  arrival_waiver_version_id: string
  version_number: number
  title: string
  body: string
  published_at: string | null
  acceptance_count: number
  is_current: boolean
}

const rowKey = (row: ArrivalRow) => `${row.subject_kind}:${row.subject_id}`

function RowBadge({ row }: { row: ArrivalRow }) {
  return (
    <div className="arrival-row__badge">
      {row.paid_state === 'paid' && <Badge tone="success">Paid</Badge>}
      {row.paid_state === 'unpaid' && <Badge tone="danger">Unpaid</Badge>}
      {row.paid_state === 'free' && <Badge>Free</Badge>}
      {row.waiver_state === 'current' && <Badge tone="success">Waiver ok</Badge>}
      {row.waiver_state === 'outdated' && <Badge tone="caution">Waiver outdated</Badge>}
      {row.waiver_state === 'missing' && <Badge tone="danger">No waiver</Badge>}
      {row.status_code === 'hold' && <Badge tone="caution">Booking on hold</Badge>}
      {row.status_code === 'no_show' && !row.check_in && <Badge tone="caution">Marked no-show</Badge>}
      {row.check_in && (
        <Badge tone="success">
          Checked in {formatTime(row.check_in.checked_in_at)}
          {row.check_in.method_code === 'staff_override' ? ' · override' : row.check_in.method_code === 'self' ? ' · phone' : ''}
        </Badge>
      )}
    </div>
  )
}

function WaiverTab({ can_manage }: { can_manage: boolean }) {
  const list = useResource(() => operatorFetch<{ waiver: WaiverVersion[] }>('/api/v1/arrival/waiver'), [])
  const [editing, setEditing] = useState<{ version: WaiverVersion | null; title: string; body: string }>()
  const [publishing, setPublishing] = useState<WaiverVersion>()
  const [notice, setNotice] = useState<string>()

  const save = useAction(async () => {
    if (!editing) return
    const body = { title: editing.title, body: editing.body }
    if (editing.version) {
      await operatorFetch(`/api/v1/arrival/waiver/${editing.version.arrival_waiver_version_id}`, jsonBody(body, 'PUT'))
    } else {
      await operatorFetch('/api/v1/arrival/waiver', jsonBody(body))
    }
    setEditing(undefined)
    setNotice('Draft saved. Publish it when it is ready for players.')
    list.reload()
  })

  const publish = useAction(async () => {
    if (!publishing) return
    await operatorFetch(`/api/v1/arrival/waiver/${publishing.arrival_waiver_version_id}/publish`, { method: 'POST' })
    setNotice(`Version ${publishing.version_number} is now the current waiver. Players who signed an earlier version will be asked again.`)
    setPublishing(undefined)
    list.reload()
  })

  return (
    <ResourceView resource={list}>
      {({ waiver }) => {
        const current = waiver.find((one) => one.is_current)
        return (
          <div className="stack">
            {notice && (
              <Alert severity="success" onDismiss={() => setNotice(undefined)}>
                {notice}
              </Alert>
            )}
            {waiver.length === 0 ? (
              <EmptyState
                title="No waiver yet"
                description="Without a published waiver, nobody is asked to sign one at check-in."
                action={can_manage && <Button onClick={() => setEditing({ version: null, title: 'Player waiver', body: '' })}>Write the waiver</Button>}
              />
            ) : (
              <Card
                title="Waiver versions"
                description={current ? `Players must accept version ${current.version_number} before they play.` : 'No version is published yet.'}
                action={
                  can_manage && (
                    <Button
                      size="sm"
                      onClick={() => setEditing({ version: null, title: current?.title ?? 'Player waiver', body: current?.body ?? '' })}
                    >
                      New version
                    </Button>
                  )
                }
              >
                <div>
                  {waiver.map((one) => (
                    <div key={one.arrival_waiver_version_id} className="waiver-version">
                      <div className="row row--between">
                        <div className="row">
                          <strong>
                            Version {one.version_number} · {one.title}
                          </strong>
                          {one.is_current ? (
                            <Badge tone="success">Current</Badge>
                          ) : one.published_at ? (
                            <Badge>Superseded</Badge>
                          ) : (
                            <Badge tone="caution">Draft</Badge>
                          )}
                        </div>
                        {can_manage && !one.published_at && (
                          <div className="row">
                            <Button size="sm" tone="quiet" onClick={() => setEditing({ version: one, title: one.title, body: one.body })}>
                              Edit
                            </Button>
                            <Button size="sm" tone="secondary" onClick={() => setPublishing(one)}>
                              Publish
                            </Button>
                          </div>
                        )}
                      </div>
                      <p className="muted">
                        {one.published_at ? `Published ${formatDateTime(one.published_at)} · ` : ''}
                        {one.acceptance_count} player(s) accepted
                      </p>
                      <div className="waiver-preview">{one.body}</div>
                    </div>
                  ))}
                </div>
              </Card>
            )}
            <Dialog
              open={editing !== undefined}
              title={editing?.version ? `Edit draft version ${editing.version.version_number}` : 'New waiver version'}
              onClose={() => setEditing(undefined)}
              footer={
                <>
                  <Button tone="quiet" onClick={() => setEditing(undefined)}>
                    Cancel
                  </Button>
                  <Button type="submit" form="waiver-form" disabled={save.is_pending}>
                    {save.is_pending ? 'Saving…' : 'Save draft'}
                  </Button>
                </>
              }
            >
              {editing && (
                <form
                  id="waiver-form"
                  className="form"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void save.run()
                  }}
                >
                  <TextInput label="Title" required value={editing.title} onChange={(event) => setEditing({ ...editing, title: event.target.value })} />
                  <TextArea label="Waiver text" required rows={12} value={editing.body} onChange={(event) => setEditing({ ...editing, body: event.target.value })} />
                  <p className="muted">A published version can never change. Drafts stay private until you publish.</p>
                  <ErrorAlert error={save.error} onDismiss={save.clearError} />
                </form>
              )}
            </Dialog>
            <Dialog
              open={publishing !== undefined}
              title={`Publish version ${publishing?.version_number ?? ''}?`}
              onClose={() => setPublishing(undefined)}
              footer={
                <>
                  <Button tone="quiet" onClick={() => setPublishing(undefined)}>
                    Not yet
                  </Button>
                  <Button onClick={() => void publish.run()} disabled={publish.is_pending}>
                    {publish.is_pending ? 'Publishing…' : 'Publish'}
                  </Button>
                </>
              }
            >
              <p>Every player who accepted an earlier version will show as “Waiver outdated” and must accept this one before playing. The text cannot be edited after publishing.</p>
              <ErrorAlert error={publish.error} onDismiss={publish.clearError} />
            </Dialog>
          </div>
        )
      }}
    </ResourceView>
  )
}

export default function Page(_prop: PageProp) {
  const { can, isEnabled } = useOperator()
  const can_manage = can('arrival.manage')
  const can_mark_paid = isEnabled('program') && can('program.manage')
  const [tab, setTab] = useState<'desk' | 'waiver'>('desk')
  const [date, setDate] = useState(() => toDateInput(new Date()))
  const day = useResource(() => operatorFetch<ArrivalDay>(`/api/v1/arrival/today?date=${date}`), [date])
  useInterval(day.reload, tab === 'desk' ? 30000 : undefined)

  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'waiting' | 'arrived'>('waiting')
  const [code, setCode] = useState('')
  const [found, setFound] = useState<{ arrival: ArrivalRow; is_today: boolean }>()
  const [reviewing, setReviewing] = useState<ArrivalRow>()
  const [reason, setReason] = useState('')
  const [notice, setNotice] = useState<string>()

  const resolve = useAction(async (event?: FormEvent) => {
    event?.preventDefault()
    const result = await operatorFetch<{ arrival: ArrivalRow; is_today: boolean }>('/api/v1/arrival/code/resolve', jsonBody({ code }))
    setFound(result)
    setCode('')
  })

  const refreshRow = (row: ArrivalRow) => {
    setReviewing((current) => (current && rowKey(current) === rowKey(row) ? row : current))
    setFound((current) => (current && rowKey(current.arrival) === rowKey(row) ? { ...current, arrival: row } : current))
    day.reload()
  }

  const checkIn = useAction(async (row: ArrivalRow, method_code: 'desk' | 'code' | 'staff_override') => {
    try {
      const result = await operatorFetch<{ arrival: ArrivalRow; is_replay: boolean }>(
        '/api/v1/arrival/check-in',
        jsonBody({ subject_kind: row.subject_kind, subject_id: row.subject_id, method_code, reason: method_code === 'staff_override' ? reason : null }),
      )
      setNotice(result.is_replay ? `${row.display_name} was already checked in.` : `${row.display_name} is checked in for ${row.label}.`)
      setReviewing(undefined)
      setReason('')
      refreshRow(result.arrival)
    } catch (error) {
      // The server says an override is needed: open the review with its sentence.
      if (error instanceof ApiError && error.status === 409 && method_code !== 'staff_override') {
        setReviewing(row)
        return
      }
      throw error
    }
  })

  const markPaid = useAction(async (row: ArrivalRow) => {
    await operatorFetch(`/api/v1/program/registration/${row.subject_id}/payment`, jsonBody({ is_paid: true }))
    setNotice(`${row.display_name} is marked as paid.`)
    const next = await operatorFetch<ArrivalDay>(`/api/v1/arrival/today?date=${date}`)
    const updated = next.arrival.find((one) => rowKey(one) === rowKey(row))
    if (updated) refreshRow(updated)
    else {
      setReviewing(undefined)
      day.reload()
    }
  })

  const signWaiver = useAction(async (row: ArrivalRow) => {
    const result = await operatorFetch<{ arrival: ArrivalRow }>(
      '/api/v1/arrival/waiver/accept',
      jsonBody({ subject_kind: row.subject_kind, subject_id: row.subject_id }),
    )
    setNotice(`Waiver recorded for ${row.display_name}.`)
    refreshRow(result.arrival)
  })

  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return (day.data?.arrival ?? []).filter((one) => {
      if (filter === 'waiting' && one.check_in) return false
      if (filter === 'arrived' && !one.check_in) return false
      return !needle || `${one.display_name} ${one.label} ${one.detail_label}`.toLowerCase().includes(needle)
    })
  }, [day.data, search, filter])

  const renderAction = (row: ArrivalRow, method_code: 'desk' | 'code') => {
    if (row.check_in || !can_manage) return null
    return row.eligibility.is_eligible ? (
      <Button size="sm" icon={<CheckCircle size={16} aria-hidden />} onClick={() => void checkIn.run(row, method_code)} disabled={checkIn.is_pending}>
        Check in
      </Button>
    ) : (
      <Button size="sm" tone="secondary" onClick={() => setReviewing(row)}>
        Review…
      </Button>
    )
  }

  const renderRow = (row: ArrivalRow, option: { is_highlight?: boolean; method_code: 'desk' | 'code' }) => (
    <div key={rowKey(row)} className={`arrival-row ${row.check_in ? 'is-arrived' : ''} ${option.is_highlight ? 'is-highlight' : ''}`}>
      <div className="arrival-row__time">{formatTime(row.starts_at)}</div>
      <div>
        <div className="arrival-row__name">{row.display_name}</div>
        <div className="arrival-row__for">
          {row.label} · {formatTimeRange(row.starts_at, row.ends_at)}
        </div>
        <div className="arrival-row__for">{row.detail_label}</div>
      </div>
      <RowBadge row={row} />
      <div className="arrival-row__action">{renderAction(row, option.method_code)}</div>
      {!row.check_in && !row.eligibility.is_eligible && <p className="arrival-row__sentence">{row.eligibility.sentence}</p>}
    </div>
  )

  return (
    <>
      <PageHeader
        eyebrow="Today"
        title="Arrival desk"
        description="Everyone booked or registered for the day. Check players in, collect waivers, and record overrides."
      />
      <Tabs
        label="Arrival view"
        value={tab}
        onChange={setTab}
        option={[
          { value: 'desk', label: 'Desk' },
          { value: 'waiver', label: 'Waiver' },
        ]}
      />
      {tab === 'waiver' ? (
        <WaiverTab can_manage={can_manage} />
      ) : (
        <div className="stack">
          <Card>
            <form className="arrival-code" onSubmit={(event) => void resolve.run(event)}>
              <TextInput
                label="Scan or type a code"
                hint="QR from the player's phone, a booking code, or their private registration code."
                autoFocus
                autoComplete="off"
                spellCheck={false}
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
              <Button type="submit" icon={<QrCode size={18} aria-hidden />} disabled={!code.trim() || resolve.is_pending}>
                {resolve.is_pending ? 'Finding…' : 'Find'}
              </Button>
            </form>
            <div className="stack" style={{ marginTop: resolve.error || found ? 'var(--space-4)' : 0 }}>
              <ErrorAlert error={resolve.error} onDismiss={resolve.clearError} />
              {found && (
                <>
                  {!found.is_today && (
                    <Alert severity="caution" title="Not for today">
                      This is for {formatDate(found.arrival.starts_at)}. Check the date before letting them on court.
                    </Alert>
                  )}
                  {renderRow(found.arrival, { is_highlight: true, method_code: 'code' })}
                  <Button size="sm" tone="quiet" onClick={() => setFound(undefined)}>
                    Clear
                  </Button>
                </>
              )}
            </div>
          </Card>

          {notice && (
            <Alert severity="success" onDismiss={() => setNotice(undefined)}>
              {notice}
            </Alert>
          )}
          <ErrorAlert error={checkIn.error} onDismiss={checkIn.clearError} />

          <ResourceView resource={day}>
            {(data) => (
              <>
                <div className="arrival-stat">
                  <Stat label="Expected" value={data.expected_count} />
                  <Stat label="Arrived" value={data.arrived_count} />
                  <Stat label="Still to come" value={data.expected_count - data.arrived_count} />
                </div>
                {!data.waiver && (
                  <Alert severity="info" title="No waiver published">
                    Players are not asked to sign anything. Add one in the Waiver tab.
                  </Alert>
                )}
                <Toolbar>
                  <TextInput label="Search" placeholder="Name, court, or program" value={search} onChange={(event) => setSearch(event.target.value)} />
                  <TextInput label="Date" type="date" value={date} onChange={(event) => event.target.value && setDate(event.target.value)} />
                </Toolbar>
                <Tabs
                  label="Arrival filter"
                  value={filter}
                  onChange={setFilter}
                  option={[
                    { value: 'waiting', label: `Not arrived (${data.expected_count - data.arrived_count})` },
                    { value: 'arrived', label: `Arrived (${data.arrived_count})` },
                    { value: 'all', label: `Everyone (${data.expected_count})` },
                  ]}
                />
                {data.arrival.length === 0 ? (
                  <EmptyState
                    title={`Nobody is booked for ${formatDate(`${date}T12:00:00+08:00`)}`}
                    description="Court bookings and program sign-ups for this day show up here."
                  />
                ) : shown.length === 0 ? (
                  <EmptyState
                    title={search ? `No one matches “${search}”` : filter === 'waiting' ? 'Everyone has arrived' : 'Nobody has arrived yet'}
                    action={
                      <Button
                        tone="secondary"
                        icon={<MagnifyingGlass size={16} aria-hidden />}
                        onClick={() => {
                          setSearch('')
                          setFilter('all')
                        }}
                      >
                        Show everyone
                      </Button>
                    }
                  />
                ) : (
                  <div className="arrival-list" aria-live="polite">
                    {shown.map((one) => renderRow(one, { method_code: 'desk' }))}
                  </div>
                )}
              </>
            )}
          </ResourceView>
        </div>
      )}

      <Dialog
        open={reviewing !== undefined}
        title={reviewing ? `Check in ${reviewing.display_name}` : 'Check in'}
        onClose={() => {
          setReviewing(undefined)
          setReason('')
        }}
        footer={
          reviewing && (
            <>
              <Button tone="quiet" onClick={() => setReviewing(undefined)}>
                Not now
              </Button>
              {reviewing.eligibility.is_eligible ? (
                <Button onClick={() => void checkIn.run(reviewing, 'desk')} disabled={checkIn.is_pending}>
                  Check in
                </Button>
              ) : (
                <Button tone="danger" onClick={() => void checkIn.run(reviewing, 'staff_override')} disabled={!reason.trim() || checkIn.is_pending}>
                  {checkIn.is_pending ? 'Checking in…' : 'Override and check in'}
                </Button>
              )}
            </>
          )
        }
      >
        {reviewing && (
          <>
            <p>
              {reviewing.label} · {formatTimeRange(reviewing.starts_at, reviewing.ends_at)}
            </p>
            <RowBadge row={reviewing} />
            {reviewing.eligibility.is_eligible ? (
              <Alert severity="success">Everything is in order.</Alert>
            ) : (
              <Alert severity="caution" title="Needs attention">
                {reviewing.eligibility.sentence}
              </Alert>
            )}
            <div className="row">
              {reviewing.subject_kind === 'registration' && reviewing.paid_state === 'unpaid' && can_mark_paid && (
                <Button size="sm" tone="secondary" onClick={() => void markPaid.run(reviewing)} disabled={markPaid.is_pending}>
                  Mark as paid
                </Button>
              )}
              {(reviewing.waiver_state === 'missing' || reviewing.waiver_state === 'outdated') && reviewing.party_id && (
                <Button size="sm" tone="secondary" onClick={() => void signWaiver.run(reviewing)} disabled={signWaiver.is_pending}>
                  Waiver signed at desk
                </Button>
              )}
            </div>
            <ErrorAlert error={markPaid.error} onDismiss={markPaid.clearError} />
            <ErrorAlert error={signWaiver.error} onDismiss={signWaiver.clearError} />
            {!reviewing.eligibility.is_eligible && (
              <TextArea
                label="Reason for the override"
                hint="Saved with your name and session in the audit log."
                rows={2}
                placeholder="Paying cash after the session"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            )}
            <ErrorAlert error={checkIn.error} onDismiss={checkIn.clearError} />
          </>
        )}
      </Dialog>
    </>
  )
}
