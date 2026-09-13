// Operator → Programs. Upcoming sessions grouped by week, a create/edit dialog
// for any program kind with a one-off or weekly schedule, and a session detail
// with its registrations, waitlist, no-show, and cancel.

import { CalendarPlus, PencilSimple, Plus, UserPlus, X } from '@phosphor-icons/react'
import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { jsonBody, operatorFetch } from '../../api.ts'
import { KIND_LABEL, KIND_TONE, type ProgramKind } from './kind.ts'
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Dialog,
  EmptyState,
  ErrorAlert,
  PageHeader,
  ResourceView,
  SelectInput,
  Stat,
  Tabs,
  TextArea,
  TextInput,
  type BadgeTone,
} from '../../component/ui.tsx'
import { formatDate, formatMoney, formatTimeRange, toDateInput } from '../../format.ts'
import { useAction, useResource } from '../../hook.ts'
import type { PageProp } from '../../registry.ts'
import { useOperator } from '../../session.tsx'
import './program.css'

type Schedule = {
  schedule_code: 'once' | 'weekly'
  weekday_number: number[]
  first_date: string
  until_date: string | null
  starts_local: string
  ends_local: string
  skipped_date: string[]
  time_zone: string
}

type Program = {
  program_id: string
  kind_code: ProgramKind
  title: string
  description: string | null
  host_name: string | null
  price_amount: string
  capacity_count: number
  is_member_only: boolean
  min_rating: string | null
  rating_provider_code: string | null
  resource_id: string | null
  court_name: string | null
  is_published: boolean
  schedule: Schedule
}

type Occurrence = {
  program_occurrence_id: string
  program_id: string
  kind_code: ProgramKind
  title: string
  host_name: string | null
  court_name: string | null
  occurrence_date: string
  starts_at: string
  ends_at: string
  price_amount: string
  capacity_count: number
  registered_count: number
  waitlist_count: number
  status_code: 'scheduled' | 'cancelled'
  is_published: boolean
  has_court_conflict: boolean
  cancel_reason?: string | null
}

type Registration = {
  program_registration_id: string
  display_name: string
  email_address: string | null
  phone_number: string | null
  status_code: 'registered' | 'waitlisted' | 'cancelled' | 'no_show' | 'attended'
  waitlist_rank: number | null
  paid_at: string | null
  checked_in_at: string | null
}

type ProgramList = { program: Program[]; occurrence: Occurrence[]; court: { resource_id: string; display_name: string }[] }
type Materialize = { created_count: number; removed_count: number; court_conflict_date: string[]; kept_date: string[] }

const WEEKDAY = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 7, label: 'Sun' },
]

const STATUS_BADGE: Record<Registration['status_code'], { tone: BadgeTone; label: string }> = {
  registered: { tone: 'info', label: 'Registered' },
  attended: { tone: 'success', label: 'Checked in' },
  waitlisted: { tone: 'caution', label: 'Waitlist' },
  no_show: { tone: 'danger', label: 'No-show' },
  cancelled: { tone: 'neutral', label: 'Cancelled' },
}

/** Monday of the week containing a YYYY-MM-DD date. */
function weekStart(date: string): string {
  const value = new Date(`${date}T00:00:00Z`)
  const weekday = value.getUTCDay() === 0 ? 7 : value.getUTCDay()
  value.setUTCDate(value.getUTCDate() - (weekday - 1))
  return value.toISOString().slice(0, 10)
}

const dateLabel = (date: string) => formatDate(`${date}T12:00:00+08:00`)

function describeSchedule(schedule: Schedule): string {
  const time = `${schedule.starts_local}–${schedule.ends_local}`
  if (schedule.schedule_code === 'once') return `${dateLabel(schedule.first_date)} · ${time}`
  const day = WEEKDAY.filter((one) => schedule.weekday_number.includes(one.value)).map((one) => one.label).join(', ')
  return `Every ${day} · ${time} · until ${schedule.until_date ? dateLabel(schedule.until_date) : '—'}`
}

function FillMeter({ taken, capacity, waitlist }: { taken: number; capacity: number; waitlist: number }) {
  const percent = Math.min(100, Math.round((taken / capacity) * 100))
  return (
    <div className="fill-meter">
      <div className="fill-meter__bar" role="img" aria-label={`${taken} of ${capacity} spots taken`}>
        <div className={`fill-meter__value ${taken >= capacity ? 'is-full' : ''}`} style={{ width: `${percent}%` }} />
      </div>
      <span className="fill-meter__label">
        {taken}/{capacity} spots{waitlist > 0 ? ` · ${waitlist} waiting` : ''}
      </span>
    </div>
  )
}

function ConfirmDialog({
  open,
  title,
  children,
  confirm_label,
  tone = 'danger',
  is_pending,
  error,
  onConfirm,
  onClose,
}: {
  open: boolean
  title: string
  children: ReactNode
  confirm_label: string
  tone?: 'danger' | 'primary'
  is_pending: boolean
  error: Error | undefined
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Dialog
      open={open}
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button tone="quiet" onClick={onClose}>
            Keep it
          </Button>
          <Button tone={tone} onClick={onConfirm} disabled={is_pending}>
            {is_pending ? 'Working…' : confirm_label}
          </Button>
        </>
      }
    >
      {children}
      <ErrorAlert error={error} />
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// program form
// ---------------------------------------------------------------------------

type Draft = {
  kind_code: ProgramKind
  title: string
  description: string
  host_name: string
  price_amount: string
  capacity_count: string
  is_member_only: boolean
  min_rating: string
  resource_id: string
  is_published: boolean
  schedule_code: 'once' | 'weekly'
  weekday_number: number[]
  first_date: string
  until_date: string
  starts_local: string
  ends_local: string
  skipped_date: string[]
}

function emptyDraft(): Draft {
  const today = toDateInput(new Date())
  const until = new Date()
  until.setDate(until.getDate() + 56)
  return {
    kind_code: 'clinic',
    title: '',
    description: '',
    host_name: '',
    price_amount: '0',
    capacity_count: '12',
    is_member_only: false,
    min_rating: '',
    resource_id: '',
    is_published: true,
    schedule_code: 'weekly',
    weekday_number: [],
    first_date: today,
    until_date: toDateInput(until),
    starts_local: '18:00',
    ends_local: '19:30',
    skipped_date: [],
  }
}

function draftFrom(program: Program): Draft {
  return {
    kind_code: program.kind_code,
    title: program.title,
    description: program.description ?? '',
    host_name: program.host_name ?? '',
    price_amount: program.price_amount,
    capacity_count: String(program.capacity_count),
    is_member_only: program.is_member_only,
    min_rating: program.min_rating ?? '',
    resource_id: program.resource_id ?? '',
    is_published: program.is_published,
    schedule_code: program.schedule.schedule_code,
    weekday_number: program.schedule.weekday_number,
    first_date: program.schedule.first_date,
    until_date: program.schedule.until_date ?? '',
    starts_local: program.schedule.starts_local,
    ends_local: program.schedule.ends_local,
    skipped_date: program.schedule.skipped_date,
  }
}

function ProgramDialog({
  program,
  court,
  onClose,
  onSaved,
}: {
  program: Program | null
  court: ProgramList['court']
  onClose: () => void
  onSaved: (title: string, materialize: Materialize) => void
}) {
  const [draft, setDraft] = useState<Draft>(() => (program ? draftFrom(program) : emptyDraft()))
  const [skip_input, setSkipInput] = useState('')
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }))

  const save = useAction(async () => {
    const body = {
      kind_code: draft.kind_code,
      title: draft.title,
      description: draft.description,
      host_name: draft.host_name,
      price_amount: draft.price_amount,
      capacity_count: Number(draft.capacity_count),
      is_member_only: draft.is_member_only,
      min_rating: draft.min_rating || null,
      rating_provider_code: draft.min_rating ? 'dupr' : null,
      resource_id: draft.resource_id || null,
      is_published: draft.is_published,
      schedule: {
        schedule_code: draft.schedule_code,
        weekday_number: draft.weekday_number,
        first_date: draft.first_date,
        until_date: draft.schedule_code === 'weekly' ? draft.until_date : null,
        starts_local: draft.starts_local,
        ends_local: draft.ends_local,
        skipped_date: draft.skipped_date,
      },
    }
    const result = program
      ? await operatorFetch<{ materialize: Materialize }>(`/api/v1/program/${program.program_id}`, jsonBody(body, 'PUT'))
      : await operatorFetch<{ materialize: Materialize }>('/api/v1/program', jsonBody(body))
    onSaved(draft.title, result.materialize)
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    void save.run()
  }

  return (
    <Dialog
      open
      title={program ? `Edit ${program.title}` : 'New program'}
      onClose={onClose}
      footer={
        <>
          <Button tone="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="program-form" disabled={save.is_pending}>
            {save.is_pending ? 'Saving…' : program ? 'Save changes' : 'Create program'}
          </Button>
        </>
      }
    >
      <form id="program-form" className="form" onSubmit={submit}>
        <div className="form__row">
          <SelectInput
            label="Kind"
            value={draft.kind_code}
            onChange={(event) => set('kind_code', event.target.value as ProgramKind)}
            option={Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label }))}
          />
          <TextInput label="Host" placeholder="Coach Mia" value={draft.host_name} onChange={(event) => set('host_name', event.target.value)} />
        </div>
        <TextInput label="Title" required placeholder="Beginner Clinic" value={draft.title} onChange={(event) => set('title', event.target.value)} />
        <TextArea label="Description" hint="Shown on the public program page." rows={3} value={draft.description} onChange={(event) => set('description', event.target.value)} />
        <div className="form__row">
          <TextInput label="Price (₱)" inputMode="decimal" value={draft.price_amount} onChange={(event) => set('price_amount', event.target.value)} />
          <TextInput label="Capacity" type="number" min={1} max={1000} value={draft.capacity_count} onChange={(event) => set('capacity_count', event.target.value)} />
        </div>
        <div className="form__row">
          <SelectInput
            label="Court"
            hint="Holds the court on the booking calendar."
            value={draft.resource_id}
            onChange={(event) => set('resource_id', event.target.value)}
            option={[{ value: '', label: 'No court held' }, ...court.map((one) => ({ value: one.resource_id, label: one.display_name }))]}
          />
          <TextInput label="Minimum DUPR" hint="Leave empty for every level." inputMode="decimal" placeholder="3.0" value={draft.min_rating} onChange={(event) => set('min_rating', event.target.value)} />
        </div>
        <div className="row">
          <Checkbox label="Members only" checked={draft.is_member_only} onChange={(event) => set('is_member_only', event.target.checked)} />
          <Checkbox label="Show on the public page" checked={draft.is_published} onChange={(event) => set('is_published', event.target.checked)} />
        </div>

        <fieldset className="fieldset">
          <legend>Schedule</legend>
          <SelectInput
            label="Repeats"
            value={draft.schedule_code}
            onChange={(event) => set('schedule_code', event.target.value as Draft['schedule_code'])}
            option={[
              { value: 'weekly', label: 'Weekly' },
              { value: 'once', label: 'One-off' },
            ]}
          />
          {draft.schedule_code === 'weekly' && (
            <div className="field">
              <span className="field__label" id="weekday-label">
                On
              </span>
              <div className="weekday-picker" role="group" aria-labelledby="weekday-label">
                {WEEKDAY.map((one) => (
                  <Checkbox
                    key={one.value}
                    label={one.label}
                    checked={draft.weekday_number.includes(one.value)}
                    onChange={(event) =>
                      set(
                        'weekday_number',
                        event.target.checked
                          ? [...draft.weekday_number, one.value].sort()
                          : draft.weekday_number.filter((day) => day !== one.value),
                      )
                    }
                  />
                ))}
              </div>
            </div>
          )}
          <div className="form__row">
            <TextInput label={draft.schedule_code === 'weekly' ? 'Starting' : 'Date'} type="date" required value={draft.first_date} onChange={(event) => set('first_date', event.target.value)} />
            {draft.schedule_code === 'weekly' && (
              <TextInput label="Until" type="date" required value={draft.until_date} onChange={(event) => set('until_date', event.target.value)} />
            )}
          </div>
          <div className="form__row">
            <TextInput label="Starts" type="time" required value={draft.starts_local} onChange={(event) => set('starts_local', event.target.value)} />
            <TextInput label="Ends" type="time" required value={draft.ends_local} onChange={(event) => set('ends_local', event.target.value)} />
          </div>
          {draft.schedule_code === 'weekly' && (
            <div className="stack">
              <div className="row">
                <TextInput label="Skip a date" type="date" value={skip_input} onChange={(event) => setSkipInput(event.target.value)} />
                <Button
                  tone="secondary"
                  size="sm"
                  disabled={!skip_input}
                  onClick={() => {
                    if (skip_input && !draft.skipped_date.includes(skip_input)) set('skipped_date', [...draft.skipped_date, skip_input].sort())
                    setSkipInput('')
                  }}
                >
                  Add skip date
                </Button>
              </div>
              {draft.skipped_date.length > 0 && (
                <ul className="chip-list" aria-label="Skipped dates">
                  {draft.skipped_date.map((one) => (
                    <li key={one} className="chip">
                      {dateLabel(one)}
                      <button type="button" aria-label={`Stop skipping ${dateLabel(one)}`} onClick={() => set('skipped_date', draft.skipped_date.filter((date) => date !== one))}>
                        <X size={14} aria-hidden />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </fieldset>
        <ErrorAlert error={save.error} onDismiss={save.clearError} />
      </form>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// occurrence detail
// ---------------------------------------------------------------------------

type PendingAction =
  | { kind: 'cancel_occurrence' }
  | { kind: 'skip' }
  | { kind: 'no_show'; registration: Registration }
  | { kind: 'cancel_registration'; registration: Registration }

function OccurrenceDetail({
  program_occurrence_id,
  program,
  can_manage,
  onChanged,
}: {
  program_occurrence_id: string
  program: Program | undefined
  can_manage: boolean
  onChanged: (message: string) => void
}) {
  const detail = useResource(
    () => operatorFetch<{ occurrence: Occurrence; registration: Registration[] }>(`/api/v1/program/occurrence/${program_occurrence_id}`),
    [program_occurrence_id],
  )
  const [pending, setPending] = useState<PendingAction>()
  const [reason, setReason] = useState('')
  const [is_adding, setAdding] = useState(false)
  const [walk_in, setWalkIn] = useState({ display_name: '', email: '', phone: '' })
  const [notice, setNotice] = useState<string>()

  const act = useAction(async (action: PendingAction) => {
    const occurrence = detail.data!.occurrence
    if (action.kind === 'cancel_occurrence') {
      const result = await operatorFetch<{ cancelled_registration_count: number }>(
        `/api/v1/program/occurrence/${program_occurrence_id}/cancel`,
        jsonBody({ reason: reason || null }),
      )
      onChanged(`${occurrence.title} on ${formatDate(occurrence.starts_at)} is cancelled. ${result.cancelled_registration_count} player(s) will be told.`)
    } else if (action.kind === 'skip') {
      await operatorFetch(`/api/v1/program/${occurrence.program_id}/skip`, jsonBody({ occurrence_date: occurrence.occurrence_date }))
      onChanged(`${formatDate(occurrence.starts_at)} is skipped for ${occurrence.title}; it will not be scheduled again.`)
    } else if (action.kind === 'no_show') {
      await operatorFetch(`/api/v1/program/registration/${action.registration.program_registration_id}/no-show`, { method: 'POST' })
      setNotice(`${action.registration.display_name} is marked as a no-show.`)
    } else {
      const result = await operatorFetch<{ promoted: { display_name: string } | null }>(
        `/api/v1/program/registration/${action.registration.program_registration_id}/cancel`,
        { method: 'POST' },
      )
      setNotice(
        `${action.registration.display_name}'s spot is cancelled.${result.promoted ? ` ${result.promoted.display_name} moved up from the waitlist.` : ''}`,
      )
    }
    setPending(undefined)
    setReason('')
    detail.reload()
  })

  const promote = useAction(async () => {
    const result = await operatorFetch<{ promoted: { display_name: string } }>(`/api/v1/program/occurrence/${program_occurrence_id}/promote`, {
      method: 'POST',
    })
    setNotice(`${result.promoted.display_name} moved up from the waitlist.`)
    detail.reload()
  })

  const add = useAction(async () => {
    const result = await operatorFetch<{ registration: { display_name: string; status_code: string; waitlist_position: number | null } }>(
      `/api/v1/program/occurrence/${program_occurrence_id}/registration`,
      jsonBody(walk_in),
    )
    setAdding(false)
    setWalkIn({ display_name: '', email: '', phone: '' })
    setNotice(
      result.registration.status_code === 'waitlisted'
        ? `${result.registration.display_name} is #${result.registration.waitlist_position} on the waitlist.`
        : `${result.registration.display_name} is registered.`,
    )
    detail.reload()
  })

  return (
    <ResourceView resource={detail}>
      {({ occurrence, registration }) => {
        const is_cancelled = occurrence.status_code === 'cancelled'
        const is_past = new Date(occurrence.ends_at).getTime() < Date.now()
        const has_seat = occurrence.registered_count < occurrence.capacity_count
        const active = registration.filter((one) => one.status_code !== 'cancelled')
        const cancelled = registration.filter((one) => one.status_code === 'cancelled')
        return (
          <Card
            className="program-detail"
            title={occurrence.title}
            description={`${formatDate(occurrence.starts_at)} · ${formatTimeRange(occurrence.starts_at, occurrence.ends_at)}${occurrence.court_name ? ` · ${occurrence.court_name}` : ''}`}
          >
            <div className="stack">
              <div className="row">
                <Badge tone={KIND_TONE[occurrence.kind_code]}>{KIND_LABEL[occurrence.kind_code]}</Badge>
                {is_cancelled && <Badge tone="danger">Cancelled</Badge>}
                {!occurrence.is_published && <Badge>Not public</Badge>}
                {occurrence.has_court_conflict && <Badge tone="caution">Court not held</Badge>}
              </div>
              {is_cancelled && occurrence.cancel_reason && <p className="muted">Reason: {occurrence.cancel_reason}</p>}
              <div className="grid">
                <Stat label="Registered" value={`${occurrence.registered_count}/${occurrence.capacity_count}`} />
                <Stat label="Waitlist" value={occurrence.waitlist_count} />
              </div>
              {notice && (
                <Alert severity="success" onDismiss={() => setNotice(undefined)}>
                  {notice}
                </Alert>
              )}
              <ErrorAlert error={promote.error} onDismiss={promote.clearError} />
              {can_manage && !is_cancelled && !is_past && (
                <div className="row">
                  <Button size="sm" tone="secondary" icon={<UserPlus size={16} aria-hidden />} onClick={() => setAdding(true)}>
                    Add player
                  </Button>
                  {occurrence.waitlist_count > 0 && has_seat && (
                    <Button size="sm" tone="secondary" onClick={() => void promote.run()} disabled={promote.is_pending}>
                      Promote next
                    </Button>
                  )}
                  {program?.schedule.schedule_code === 'weekly' && (
                    <Button size="sm" tone="quiet" onClick={() => setPending({ kind: 'skip' })}>
                      Skip this date
                    </Button>
                  )}
                  <Button size="sm" tone="danger" onClick={() => setPending({ kind: 'cancel_occurrence' })}>
                    Cancel session
                  </Button>
                </div>
              )}

              {active.length === 0 ? (
                <EmptyState
                  title="Nobody has registered yet"
                  description={occurrence.is_published ? 'Players can sign up from your public program page.' : 'Publish the program so players can sign up, or add a player here.'}
                />
              ) : (
                <div className="registration-list" aria-label="Registrations">
                  {active.map((one) => (
                    <div key={one.program_registration_id} className="registration-row">
                      <div>
                        <div className="row">
                          <span className="registration-row__name">
                            {one.waitlist_rank ? `#${one.waitlist_rank} ` : ''}
                            {one.display_name}
                          </span>
                          <Badge tone={STATUS_BADGE[one.status_code].tone}>{STATUS_BADGE[one.status_code].label}</Badge>
                          {Number(occurrence.price_amount) > 0 && one.status_code !== 'waitlisted' && (
                            <Badge tone={one.paid_at ? 'success' : 'neutral'}>{one.paid_at ? 'Paid' : 'Unpaid'}</Badge>
                          )}
                        </div>
                        <div className="registration-row__contact">{[one.email_address, one.phone_number].filter(Boolean).join(' · ')}</div>
                      </div>
                      {can_manage && !is_cancelled && (
                        <div className="row">
                          {one.status_code === 'registered' && (
                            <Button size="sm" tone="quiet" onClick={() => setPending({ kind: 'no_show', registration: one })}>
                              No-show
                            </Button>
                          )}
                          {(one.status_code === 'registered' || one.status_code === 'waitlisted') && !one.checked_in_at && (
                            <Button size="sm" tone="quiet" onClick={() => setPending({ kind: 'cancel_registration', registration: one })}>
                              Cancel
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {cancelled.length > 0 && <p className="muted">{cancelled.length} cancelled registration(s) not shown.</p>}
            </div>

            <ConfirmDialog
              open={pending?.kind === 'cancel_occurrence'}
              title="Cancel this session?"
              confirm_label="Cancel session"
              is_pending={act.is_pending}
              error={act.error}
              onClose={() => setPending(undefined)}
              onConfirm={() => pending && void act.run(pending)}
            >
              <p>
                Everyone registered or waiting ({occurrence.registered_count + occurrence.waitlist_count}) loses their spot and is told. This cannot be
                undone.
              </p>
              <TextArea label="Reason players will see" rows={2} placeholder="Court resurfacing" value={reason} onChange={(event) => setReason(event.target.value)} />
            </ConfirmDialog>
            <ConfirmDialog
              open={pending?.kind === 'skip'}
              title="Skip this date?"
              confirm_label="Skip date"
              is_pending={act.is_pending}
              error={act.error}
              onClose={() => setPending(undefined)}
              onConfirm={() => pending && void act.run(pending)}
            >
              <p>{formatDate(occurrence.starts_at)} is added to the schedule's skipped dates. Anyone registered is cancelled and told.</p>
            </ConfirmDialog>
            <ConfirmDialog
              open={pending?.kind === 'no_show' || pending?.kind === 'cancel_registration'}
              title={pending?.kind === 'no_show' ? 'Mark as no-show?' : 'Cancel this registration?'}
              confirm_label={pending?.kind === 'no_show' ? 'Mark no-show' : 'Cancel registration'}
              is_pending={act.is_pending}
              error={act.error}
              onClose={() => setPending(undefined)}
              onConfirm={() => pending && void act.run(pending)}
            >
              <p>
                {pending && 'registration' in pending ? pending.registration.display_name : ''}
                {pending?.kind === 'no_show'
                  ? ' keeps the spot on record as a no-show. The seat is not passed on.'
                  : ' loses the spot. The first player on the waitlist moves up automatically.'}
              </p>
            </ConfirmDialog>
            <Dialog
              open={is_adding}
              title="Add a player"
              onClose={() => setAdding(false)}
              footer={
                <>
                  <Button tone="quiet" onClick={() => setAdding(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" form="walk-in-form" disabled={add.is_pending}>
                    {add.is_pending ? 'Adding…' : 'Add player'}
                  </Button>
                </>
              }
            >
              <form
                id="walk-in-form"
                className="form"
                onSubmit={(event) => {
                  event.preventDefault()
                  void add.run()
                }}
              >
                <TextInput label="Name" required value={walk_in.display_name} onChange={(event) => setWalkIn({ ...walk_in, display_name: event.target.value })} />
                <TextInput label="Email" type="email" value={walk_in.email} onChange={(event) => setWalkIn({ ...walk_in, email: event.target.value })} />
                <TextInput label="Mobile" type="tel" value={walk_in.phone} onChange={(event) => setWalkIn({ ...walk_in, phone: event.target.value })} />
                <p className="muted">If the session is full the player joins the waitlist.</p>
                <ErrorAlert error={add.error} onDismiss={add.clearError} />
              </form>
            </Dialog>
          </Card>
        )
      }}
    </ResourceView>
  )
}

// ---------------------------------------------------------------------------
// page
// ---------------------------------------------------------------------------

export default function Page(_prop: PageProp) {
  const { can } = useOperator()
  const can_manage = can('program.manage')
  const list = useResource(() => operatorFetch<ProgramList>('/api/v1/program'), [])
  const [tab, setTab] = useState<'schedule' | 'program'>('schedule')
  const [selected, setSelected] = useState<string>()
  const [editing, setEditing] = useState<Program | null | undefined>(undefined)
  const [archiving, setArchiving] = useState<Program>()
  const [notice, setNotice] = useState<{ severity: 'success' | 'caution'; text: string }>()

  const archive = useAction(async (program: Program) => {
    const result = await operatorFetch<{ cancelled_count: number }>(`/api/v1/program/${program.program_id}`, { method: 'DELETE' })
    setArchiving(undefined)
    setNotice({ severity: 'success', text: `${program.title} is withdrawn. ${result.cancelled_count} upcoming session(s) cancelled.` })
    list.reload()
  })

  const week = useMemo(() => {
    const group = new Map<string, Occurrence[]>()
    for (const one of list.data?.occurrence ?? []) {
      const key = weekStart(one.occurrence_date)
      group.set(key, [...(group.get(key) ?? []), one])
    }
    return [...group.entries()]
  }, [list.data])

  const program_by_id = useMemo(() => new Map((list.data?.program ?? []).map((one) => [one.program_id, one])), [list.data])

  return (
    <>
      <PageHeader
        eyebrow="Play"
        title="Programs"
        description="Clinics, lessons, socials, leagues, and private events — each with its own schedule, capacity, and waitlist."
        action={
          can_manage && (
            <Button icon={<Plus size={18} aria-hidden />} onClick={() => setEditing(null)}>
              New program
            </Button>
          )
        }
      />
      {notice && (
        <div className="stack" style={{ marginBottom: 'var(--space-4)' }}>
          <Alert severity={notice.severity} onDismiss={() => setNotice(undefined)}>
            {notice.text}
          </Alert>
        </div>
      )}
      <Tabs
        label="Program view"
        value={tab}
        onChange={setTab}
        option={[
          { value: 'schedule', label: 'Upcoming sessions' },
          { value: 'program', label: 'All programs' },
        ]}
      />
      <ResourceView resource={list}>
        {(data) =>
          tab === 'schedule' ? (
            week.length === 0 ? (
              <EmptyState
                title="No sessions in the next five weeks"
                description="Create a clinic or social and its sessions appear here, grouped by week."
                action={
                  can_manage && (
                    <Button icon={<CalendarPlus size={18} aria-hidden />} onClick={() => setEditing(null)}>
                      Create a program
                    </Button>
                  )
                }
              />
            ) : (
              <div className="split">
                <div className="stack--lg">
                  {week.map(([start, occurrence]) => (
                    <section key={start} className="program-week" aria-label={`Week of ${dateLabel(start)}`}>
                      <h2 className="program-week__label">Week of {dateLabel(start)}</h2>
                      {occurrence.map((one) => (
                        <button
                          key={one.program_occurrence_id}
                          type="button"
                          className={`program-slot ${selected === one.program_occurrence_id ? 'is-selected' : ''} ${one.status_code === 'cancelled' ? 'is-cancelled' : ''}`}
                          aria-pressed={selected === one.program_occurrence_id}
                          onClick={() => setSelected(one.program_occurrence_id)}
                        >
                          <span className="program-slot__when">
                            <strong>{formatDate(one.starts_at)}</strong>
                            <span className="muted">{formatTimeRange(one.starts_at, one.ends_at)}</span>
                          </span>
                          <span className="stack" style={{ gap: 'var(--space-1)' }}>
                            <span className="row" style={{ gap: 'var(--space-2)' }}>
                              <span className="program-slot__title">{one.title}</span>
                              <Badge tone={KIND_TONE[one.kind_code]}>{KIND_LABEL[one.kind_code]}</Badge>
                              {one.status_code === 'cancelled' && <Badge tone="danger">Cancelled</Badge>}
                              {one.has_court_conflict && <Badge tone="caution">Court not held</Badge>}
                            </span>
                            <span className="program-slot__meta">
                              {[one.host_name, one.court_name, Number(one.price_amount) > 0 ? formatMoney(one.price_amount) : 'Free'].filter(Boolean).join(' · ')}
                            </span>
                          </span>
                          <FillMeter taken={one.registered_count} capacity={one.capacity_count} waitlist={one.waitlist_count} />
                        </button>
                      ))}
                    </section>
                  ))}
                </div>
                <div>
                  {selected ? (
                    <OccurrenceDetail
                      key={selected}
                      program_occurrence_id={selected}
                      program={program_by_id.get(data.occurrence.find((one) => one.program_occurrence_id === selected)?.program_id ?? '')}
                      can_manage={can_manage}
                      onChanged={(text) => {
                        setNotice({ severity: 'success', text })
                        setSelected(undefined)
                        list.reload()
                      }}
                    />
                  ) : (
                    <EmptyState title="Pick a session" description="See who is registered, who is waiting, and mark no-shows." />
                  )}
                </div>
              </div>
            )
          ) : data.program.length === 0 ? (
            <EmptyState
              title="No programs yet"
              description="A program is anything players sign up for: a clinic, a social, a league night."
              action={can_manage && <Button onClick={() => setEditing(null)}>Create a program</Button>}
            />
          ) : (
            <div className="grid--2">
              {data.program.map((one) => (
                <Card
                  key={one.program_id}
                  title={one.title}
                  description={describeSchedule(one.schedule)}
                  action={
                    can_manage && (
                      <>
                        <Button size="sm" tone="secondary" icon={<PencilSimple size={16} aria-hidden />} onClick={() => setEditing(one)}>
                          Edit
                        </Button>
                        <Button size="sm" tone="danger" onClick={() => setArchiving(one)}>
                          Withdraw
                        </Button>
                      </>
                    )
                  }
                >
                  <div className="row">
                    <Badge tone={KIND_TONE[one.kind_code]}>{KIND_LABEL[one.kind_code]}</Badge>
                    <Badge tone={one.is_published ? 'success' : 'neutral'}>{one.is_published ? 'Public' : 'Not public'}</Badge>
                    {one.is_member_only && <Badge tone="info">Members only</Badge>}
                    {one.min_rating && <Badge>DUPR {Number(one.min_rating).toFixed(1)}+</Badge>}
                  </div>
                  <p className="muted" style={{ marginTop: 'var(--space-3)' }}>
                    {[one.host_name, one.court_name, `${one.capacity_count} spots`, Number(one.price_amount) > 0 ? formatMoney(one.price_amount) : 'Free'].filter(Boolean).join(' · ')}
                  </p>
                  {one.schedule.skipped_date.length > 0 && (
                    <p className="muted">Skipping {one.schedule.skipped_date.map(dateLabel).join(', ')}</p>
                  )}
                </Card>
              ))}
            </div>
          )
        }
      </ResourceView>

      {editing !== undefined && list.data && (
        <ProgramDialog
          program={editing}
          court={list.data.court}
          onClose={() => setEditing(undefined)}
          onSaved={(title, materialize) => {
            setEditing(undefined)
            const part = [`${title} is saved.`]
            if (materialize.created_count > 0) part.push(`${materialize.created_count} session(s) added.`)
            if (materialize.removed_count > 0) part.push(`${materialize.removed_count} empty session(s) removed.`)
            if (materialize.kept_date.length > 0) part.push(`Kept ${materialize.kept_date.map(dateLabel).join(', ')} because players are registered — cancel those sessions if needed.`)
            if (materialize.court_conflict_date.length > 0) part.push(`The court was already booked on ${materialize.court_conflict_date.map(dateLabel).join(', ')}.`)
            const is_warning = materialize.court_conflict_date.length > 0 || materialize.kept_date.length > 0
            setNotice({ severity: is_warning ? 'caution' : 'success', text: part.join(' ') })
            list.reload()
          }}
        />
      )}
      <ConfirmDialog
        open={archiving !== undefined}
        title={`Withdraw ${archiving?.title ?? 'program'}?`}
        confirm_label="Withdraw program"
        is_pending={archive.is_pending}
        error={archive.error}
        onClose={() => setArchiving(undefined)}
        onConfirm={() => archiving && void archive.run(archiving)}
      >
        <p>It disappears from the public page and every upcoming session is cancelled. Registered players are told.</p>
      </ConfirmDialog>
    </>
  )
}
