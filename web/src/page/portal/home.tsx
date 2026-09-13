// Public venue home: book a court. Booking-first club look — a tight split hero,
// then the day's courts by time, then checkout in a dialog.

import { CalendarCheck, CheckCircle } from '@phosphor-icons/react'
import { useMemo, useState, type FormEvent } from 'react'
import { ApiError } from '../../api.ts'
import { Alert, Badge, Button, ButtonLink, Card, Dialog, EmptyState, ErrorAlert, Loading, SelectInput, Tabs, TextInput } from '../../component/ui.tsx'
import { formatDate, formatDateTime, formatMoney, formatTime, formatTimeRange } from '../../format.ts'
import { useResource } from '../../hook.ts'
import { usePublicSite } from '../../layout/public-shell.tsx'
import type { PageProp } from '../../registry.ts'
import { Link } from '../../route.tsx'
import {
  PAYMENT_LABEL,
  STATUS_LABEL,
  createBooking,
  loadAvailability,
  payBooking,
  readSavedBooking,
  recoveryPath,
  saveBooking,
  type Availability,
  type Created,
  type PayResult,
  type Slot,
} from './portal-api.ts'
import './portal.css'

type Selection = { slot: Slot; court_name: string }

function dateList(first_date: string, last_date: string): string[] {
  const out: string[] = []
  for (let at = Date.parse(`${first_date}T00:00:00Z`); at <= Date.parse(`${last_date}T00:00:00Z`) && out.length < 60; at += 86_400_000) {
    out.push(new Date(at).toISOString().slice(0, 10))
  }
  return out
}

/** A calendar date at noon UTC, which formats to the same day in every PH-adjacent zone. */
function dateLabel(date: string, time_zone: string) {
  const noon = new Date(`${date}T12:00:00Z`)
  return {
    weekday: new Intl.DateTimeFormat('en-PH', { weekday: 'short', timeZone: time_zone }).format(noon),
    day: new Intl.DateTimeFormat('en-PH', { day: 'numeric', timeZone: time_zone }).format(noon),
    month: new Intl.DateTimeFormat('en-PH', { month: 'short', timeZone: time_zone }).format(noon),
  }
}

export default function Page({ param }: PageProp) {
  const organization_code = param['organization_code'] ?? ''
  const site = usePublicSite()
  const [date, setDate] = useState<string>()
  const [sport, setSport] = useState('')
  const [selection, setSelection] = useState<Selection>()
  const [notice, setNotice] = useState<string>()
  const availability = useResource(() => loadAvailability(organization_code, date, sport || undefined), [organization_code, date, sport])
  const saved = useMemo(() => readSavedBooking().filter((one) => one.organization_code === organization_code && Date.parse(one.starts_at) > Date.now()), [organization_code, selection])

  const data = availability.data

  return (
    <div className="stack--lg">
      <section className="portal-hero">
        <div className="portal-hero__copy">
          <p className="eyebrow">{site.display_name}</p>
          <h1>{site.content.hero_title}</h1>
          <p>{site.content.hero_body}</p>
          <div className="row">
            <a className="button button--primary button--lg" href="#book">
              <CalendarCheck size={20} aria-hidden /> Book a court
            </a>
          </div>
        </div>
        <aside className="portal-hero__panel" aria-label="How booking works">
          <h2>Reserve in under a minute</h2>
          <div className="portal-hero__fact">
            <strong>Your court is held</strong>
            <span>while you finish checkout</span>
          </div>
          <div className="portal-hero__fact">
            <strong>{data ? `Free cancellation up to ${data.cancellation_cutoff_hour_count} hours before` : 'Free cancellation'}</strong>
            <span>right from your booking link</span>
          </div>
          <div className="portal-hero__fact">
            <strong>{data?.is_counter_payment_allowed === false ? 'Pay online' : 'Pay online or at the counter'}</strong>
            <span>no account needed</span>
          </div>
        </aside>
      </section>

      {saved.length > 0 && (
        <Card title="Your upcoming bookings" description="Saved on this device.">
          <div className="saved-list">
            {saved.map((one) => (
              <Link key={one.booking_code} to={recoveryPath(one)}>
                <span>
                  <strong>{one.court_name}</strong>
                  <span className="muted"> · {formatDateTime(one.starts_at, data?.time_zone)}</span>
                </span>
                <span aria-hidden>→</span>
              </Link>
            ))}
          </div>
        </Card>
      )}

      <section className="portal-book" id="book" aria-labelledby="book-title">
        <div className="portal-book__head">
          <div>
            <p className="eyebrow">Live availability</p>
            <h2 id="book-title">Pick a day and a court</h2>
          </div>
          {data && <p className="muted">Times shown in venue time.</p>}
        </div>

        {notice && (
          <Alert severity="caution" title="That slot is gone" onDismiss={() => setNotice(undefined)}>
            {notice}
          </Alert>
        )}

        {data && (
          <div className="date-strip" role="group" aria-label="Booking date">
            {dateList(data.first_date, data.last_date).map((one) => {
              const label = dateLabel(one, data.time_zone)
              return (
                <button
                  key={one}
                  type="button"
                  className="date-strip__day"
                  aria-pressed={one === data.date}
                  aria-label={`${label.weekday} ${label.month} ${label.day}`}
                  onClick={() => setDate(one)}
                >
                  <small>{one === data.first_date ? 'Today' : label.weekday}</small>
                  <strong>{label.day}</strong>
                  <small>{label.month}</small>
                </button>
              )
            })}
          </div>
        )}

        {data && data.sport.length > 1 && (
          <Tabs
            label="Sport"
            value={sport}
            onChange={setSport}
            option={[{ value: '', label: 'All sports' }, ...data.sport.map((one) => ({ value: one.sport_code, label: one.display_name }))]}
          />
        )}

        {availability.error && !data ? (
          <Alert severity="danger" title="Could not load courts">
            <p>{availability.error.message}</p>
            <Button tone="secondary" size="sm" onClick={availability.reload}>
              Try again
            </Button>
          </Alert>
        ) : !data ? (
          <Loading label="Checking courts…" />
        ) : (
          <SlotView data={data} is_loading={availability.is_loading} onPick={setSelection} onNextDay={() => {
            const list = dateList(data.first_date, data.last_date)
            const next = list[list.indexOf(data.date) + 1]
            if (next) setDate(next)
          }} />
        )}
      </section>

      {selection && data && (
        <Checkout
          organization_code={organization_code}
          availability={data}
          selection={selection}
          onClose={() => {
            setSelection(undefined)
            availability.reload()
          }}
          onTaken={(message) => {
            setSelection(undefined)
            setNotice(message)
            availability.reload()
          }}
        />
      )}
    </div>
  )
}

function SlotView({
  data,
  is_loading,
  onPick,
  onNextDay,
}: {
  data: Availability
  is_loading: boolean
  onPick: (selection: Selection) => void
  onNextDay: () => void
}) {
  if (!data.is_inside_window) {
    return (
      <EmptyState
        title="That day is not open for booking yet"
        description={`Courts can be booked up to ${formatDate(`${data.last_date}T12:00:00Z`, data.time_zone)}. Pick a day from the strip above.`}
      />
    )
  }
  if (data.slot.length === 0) {
    const is_last = data.date === data.last_date
    return (
      <EmptyState
        title="No courts are scheduled on this day"
        description="The venue has not opened any court times for this date."
        action={
          is_last ? undefined : (
            <Button tone="secondary" onClick={onNextDay}>
              Check the next day
            </Button>
          )
        }
      />
    )
  }

  const court_name = new Map(data.court.map((one) => [one.resource_id, one.display_name]))
  // A time that has already started is not "taken" — it is gone. Leave it off the grid.
  const now = Date.now()
  const upcoming = data.slot.filter((one) => Date.parse(one.starts_at) > now)
  if (upcoming.length === 0) {
    const is_last = data.date === data.last_date
    return (
      <EmptyState
        title="No more court times today"
        description="Every court time on this day has already started."
        action={
          is_last ? undefined : (
            <Button tone="secondary" onClick={onNextDay}>
              Check the next day
            </Button>
          )
        }
      />
    )
  }
  const time = [...new Set(upcoming.map((one) => one.starts_at))].sort()
  const byKey = new Map(upcoming.map((one) => [`${one.starts_at}|${one.resource_id}`, one]))
  const open_count = upcoming.filter((one) => one.is_available).length
  const pick = (slot: Slot) => onPick({ slot, court_name: court_name.get(slot.resource_id) ?? 'Court' })

  return (
    <div className="stack" aria-busy={is_loading}>
      <p className="muted" aria-live="polite">
        {open_count === 0 ? 'Every court is taken on this day.' : `${open_count} open ${open_count === 1 ? 'slot' : 'slots'} on ${formatDate(`${data.date}T12:00:00Z`, data.time_zone)}.`}
      </p>

      <div className="court-grid">
        <table>
          <caption className="visually-hidden">Courts by start time</caption>
          <thead>
            <tr>
              <th scope="col">Time</th>
              {data.court.map((one) => (
                <th key={one.resource_id} scope="col">
                  {one.display_name}
                  {one.sport_code && data.sport.length > 1 && <small>{data.sport.find((s) => s.sport_code === one.sport_code)?.display_name}</small>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {time.map((starts_at) => (
              <tr key={starts_at}>
                <td className="court-grid__time">{formatTime(starts_at, data.time_zone)}</td>
                {data.court.map((court) => {
                  const slot = byKey.get(`${starts_at}|${court.resource_id}`)
                  if (!slot) return <td key={court.resource_id}><span className="slot-cell--none">—</span></td>
                  return (
                    <td key={court.resource_id}>
                      <button
                        type="button"
                        className="slot-cell"
                        disabled={!slot.is_available}
                        onClick={() => pick(slot)}
                        aria-label={`${court.display_name}, ${formatTimeRange(slot.starts_at, slot.ends_at, data.time_zone)}, ${slot.is_available ? formatMoney(slot.price_amount) : 'taken'}`}
                      >
                        <span>{slot.is_available ? 'Book' : 'Taken'}</span>
                        {slot.is_available && <span>{formatMoney(slot.price_amount)}</span>}
                      </button>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="time-list">
        {time.map((starts_at) => {
          const at_time = data.slot.filter((one) => one.starts_at === starts_at)
          const first = at_time[0]!
          return (
            <section key={starts_at} className="time-list__row" aria-label={formatTime(starts_at, data.time_zone)}>
              <header>
                <strong>{formatTimeRange(first.starts_at, first.ends_at, data.time_zone)}</strong>
                <span className="muted">{formatMoney(first.price_amount)}</span>
              </header>
              <div className="chip-row">
                {at_time.map((slot) => (
                  <button
                    key={slot.resource_id}
                    type="button"
                    className="court-chip"
                    disabled={!slot.is_available}
                    onClick={() => pick(slot)}
                    aria-label={`${court_name.get(slot.resource_id)}, ${slot.is_available ? formatMoney(slot.price_amount) : 'taken'}`}
                  >
                    {court_name.get(slot.resource_id)}
                  </button>
                ))}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}

type ContactForm = { display_name: string; email: string; phone: string }

function checkContact(form: ContactForm): Partial<Record<keyof ContactForm, string>> {
  const problem: Partial<Record<keyof ContactForm, string>> = {}
  if (form.display_name.trim().length < 2) problem.display_name = 'Enter the name the booking is under.'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) problem.email = 'Enter an email address like name@example.com.'
  const digit = form.phone.replace(/\D/g, '')
  if (digit.length < 7 || digit.length > 15) problem.phone = 'Enter a mobile number, for example 0917 123 4567.'
  return problem
}

function Checkout({
  organization_code,
  availability,
  selection,
  onClose,
  onTaken,
}: {
  organization_code: string
  availability: Availability
  selection: Selection
  onClose: () => void
  onTaken: (message: string) => void
}) {
  const { slot, court_name } = selection
  const time_zone = availability.time_zone
  const [form, setForm] = useState<ContactForm>({ display_name: '', email: '', phone: '' })
  const [participant_count, setParticipantCount] = useState('4')
  const [method, setMethod] = useState<'online' | 'counter'>('online')
  const [problem, setProblem] = useState<Partial<Record<string, string>>>({})
  const [is_touched, setTouched] = useState(false)
  const [is_pending, setPending] = useState(false)
  const [error, setError] = useState<Error>()
  const [created, setCreated] = useState<Created>()
  const [paid, setPaid] = useState<PayResult>()

  const cutoff = new Date(Date.parse(slot.starts_at) - availability.cancellation_cutoff_hour_count * 3_600_000)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setTouched(true)
    const local = checkContact(form)
    setProblem(local)
    if (Object.keys(local).length > 0) return
    setPending(true)
    setError(undefined)
    let booking = created
    try {
      if (!booking) {
        booking = await createBooking(organization_code, {
          session_id: slot.session_id,
          resource_id: slot.resource_id,
          participant_count: Number(participant_count),
          contact: { display_name: form.display_name.trim(), email: form.email.trim(), phone: form.phone.trim() },
        })
        setCreated(booking)
        saveBooking({ organization_code, booking_code: booking.booking_code, recovery_token: booking.recovery_token, court_name: booking.court_name, starts_at: booking.starts_at })
      }
      const result = await payBooking(organization_code, booking.booking_code, booking.recovery_token, method)
      if (result.checkout_url) {
        window.location.assign(result.checkout_url)
        return
      }
      setPaid(result)
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409 && !booking) {
        onTaken(caught.message)
        return
      }
      if (caught instanceof ApiError && caught.status === 400 && caught.body && typeof caught.body === 'object' && 'problem' in caught.body) {
        setProblem((caught.body as { problem: Record<string, string> }).problem)
      }
      setError(caught instanceof Error ? caught : new Error(String(caught)))
    } finally {
      setPending(false)
    }
  }

  if (created && paid) {
    const view = paid.booking
    const path = recoveryPath({ organization_code, booking_code: created.booking_code, recovery_token: created.recovery_token })
    return (
      <Dialog open title="Court booked" onClose={onClose} footer={<><Button tone="quiet" onClick={onClose}>Book another</Button><ButtonLink to={path}>View my booking</ButtonLink></>}>
        <div className="confirmation">
          <CheckCircle size={48} weight="fill" aria-hidden />
          <p className="eyebrow">{view.status === 'confirmed' ? 'Your court is reserved' : 'Your court is held'}</p>
          <p className="confirmation__code" aria-label={`Booking code ${created.booking_code}`}>{created.booking_code}</p>
          <div className="row" style={{ justifyContent: 'center' }}>
            <Badge tone={STATUS_LABEL[view.status].tone}>{STATUS_LABEL[view.status].label}</Badge>
            <Badge tone={PAYMENT_LABEL[view.payment_state].tone}>{PAYMENT_LABEL[view.payment_state].label}</Badge>
          </div>
          <p>
            {view.court_name} · {formatDate(view.starts_at, time_zone)} · {formatTimeRange(view.starts_at, view.ends_at, time_zone)}
          </p>
        </div>
        {paid.instruction && <Alert severity="info" title="At the counter">{paid.instruction}</Alert>}
        <p className="muted">
          We saved your booking link on this device. Keep it to pay, check, or cancel later — anyone with the link can manage this booking.
        </p>
      </Dialog>
    )
  }

  const total = created?.total_amount ?? slot.price_amount
  return (
    <Dialog
      open
      title="Review your court"
      onClose={onClose}
      footer={
        <>
          <Button tone="quiet" onClick={onClose} disabled={is_pending}>
            Back to courts
          </Button>
          <Button type="submit" form="portal-checkout" disabled={is_pending}>
            {is_pending ? 'Reserving…' : method === 'online' ? `Reserve and pay ${formatMoney(total)}` : 'Reserve my court'}
          </Button>
        </>
      }
    >
      <section className="checkout-summary" aria-label="Booking summary">
        <span className="checkout-summary__court">{court_name}</span>
        <dl className="summary-list">
          <dt>Date</dt>
          <dd>{formatDate(slot.starts_at, time_zone)}</dd>
          <dt>Time</dt>
          <dd>{formatTimeRange(slot.starts_at, slot.ends_at, time_zone)}</dd>
          <dt>Free cancellation until</dt>
          <dd>{formatDateTime(created?.cancellation_cutoff_at ?? cutoff, time_zone)}</dd>
          <dt>Total</dt>
          <dd className="summary-list__total">{formatMoney(total)}</dd>
        </dl>
        {created?.price_note && <p className="muted">{created.price_note}</p>}
      </section>

      <ErrorAlert error={error} onDismiss={() => setError(undefined)} />
      {created && !paid && (
        <Alert severity="info" title="Your court is held">
          Booking {created.booking_code} is held{created.hold_expires_at ? ` until ${formatTime(created.hold_expires_at, time_zone)}` : ''}. Choose how to pay to finish.
        </Alert>
      )}

      <form id="portal-checkout" className="form" onSubmit={submit} noValidate>
        <TextInput
          label="Name"
          autoComplete="name"
          value={form.display_name}
          disabled={Boolean(created)}
          error={is_touched ? problem['display_name'] : undefined}
          onChange={(event) => setForm({ ...form, display_name: event.target.value })}
        />
        <div className="form__row">
          <TextInput
            label="Email"
            type="email"
            autoComplete="email"
            value={form.email}
            disabled={Boolean(created)}
            error={is_touched ? problem['email'] : undefined}
            onChange={(event) => setForm({ ...form, email: event.target.value })}
          />
          <TextInput
            label="Mobile number"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={form.phone}
            disabled={Boolean(created)}
            error={is_touched ? problem['phone'] : undefined}
            onChange={(event) => setForm({ ...form, phone: event.target.value })}
          />
        </div>
        <SelectInput
          label="Players"
          value={participant_count}
          disabled={Boolean(created)}
          onChange={(event) => setParticipantCount(event.target.value)}
          option={['1', '2', '3', '4'].map((one) => ({ value: one, label: one === '4' ? '4 players (doubles)' : one === '2' ? '2 players (singles)' : `${one} ${one === '1' ? 'player' : 'players'}` }))}
        />
        {problem['participant_count'] && <p className="field__error">{problem['participant_count']}</p>}

        <fieldset className="choice">
          <legend>Payment</legend>
          <label className="choice__option">
            <input type="radio" name="portal-method" checked={method === 'online'} onChange={() => setMethod('online')} />
            <span>
              <strong>Pay online now</strong>
              <small>{availability.online_payment_label}. Your court is confirmed right away.</small>
            </span>
          </label>
          {availability.is_counter_payment_allowed && (
            <label className="choice__option">
              <input type="radio" name="portal-method" checked={method === 'counter'} onChange={() => setMethod('counter')} />
              <span>
                <strong>Pay at the counter</strong>
                <small>Reserve now, pay the front desk when you arrive.</small>
              </span>
            </label>
          )}
        </fieldset>
      </form>
    </Dialog>
  )
}
