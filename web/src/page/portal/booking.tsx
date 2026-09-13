// Operator bookings: the day's reservations with contact, status, and money;
// record a counter payment, refund, cancel, and set checkout options.

import { ArrowClockwise } from '@phosphor-icons/react'
import { useEffect, useState, type FormEvent } from 'react'
import { Alert, Badge, Button, Card, Checkbox, Dialog, EmptyState, ErrorAlert, PageHeader, ResourceView, SelectInput, Stat, TextArea, TextInput, Toolbar } from '../../component/ui.tsx'
import { formatMoney, formatTimeRange, toDateInput } from '../../format.ts'
import { useAction, useResource } from '../../hook.ts'
import type { PageProp } from '../../registry.ts'
import { useOperator } from '../../session.tsx'
import {
  METHOD_LABEL,
  PAYMENT_LABEL,
  STATUS_LABEL,
  cancelAsOperator,
  loadOperatorBooking,
  loadSetting,
  recordPayment,
  refundBooking,
  saveSetting,
  type BookingView,
} from './portal-api.ts'
import './portal.css'

type Open = { kind: 'payment' | 'refund' | 'cancel'; booking: BookingView }

const STATUS_OPTION = [
  { value: '', label: 'All bookings' },
  { value: 'hold', label: 'Held' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'expired', label: 'Expired' },
]

function toCent(value: string): number {
  return Math.round(Number(value) * 100)
}

export default function Page(_prop: PageProp) {
  const operator = useOperator()
  const can_manage = operator.can('portal.manage')
  const [date, setDate] = useState(() => toDateInput(new Date()))
  const [status, setStatus] = useState('')
  const [open, setOpen] = useState<Open>()
  const [success, setSuccess] = useState<string>()
  const list = useResource(() => loadOperatorBooking(date, status), [date, status])

  const done = (message: string) => {
    setOpen(undefined)
    setSuccess(message)
    list.reload()
  }

  return (
    <>
      <PageHeader
        eyebrow="Today"
        title="Bookings"
        description="Every court reservation for the day, with who booked, how they are paying, and what is still due."
        action={
          <Button tone="secondary" icon={<ArrowClockwise size={18} aria-hidden />} onClick={list.reload} disabled={list.is_loading}>
            Refresh
          </Button>
        }
      />

      <Toolbar>
        <TextInput label="Date" type="date" value={date} onChange={(event) => event.target.value && setDate(event.target.value)} />
        <SelectInput label="Status" value={status} option={STATUS_OPTION} onChange={(event) => setStatus(event.target.value)} />
        <Button tone="quiet" onClick={() => setDate(toDateInput(new Date()))}>
          Today
        </Button>
      </Toolbar>

      {success && (
        <div style={{ marginBottom: 'var(--space-4)' }}>
          <Alert severity="success" title="Saved" onDismiss={() => setSuccess(undefined)}>
            {success}
          </Alert>
        </div>
      )}

      <ResourceView resource={list}>
        {(data) => {
          const active = data.booking.filter((one) => one.status === 'hold' || one.status === 'confirmed')
          const collected = data.booking.reduce((total, one) => total + toCent(one.paid_amount), 0)
          const due = active.reduce((total, one) => total + toCent(one.balance_amount), 0)
          return (
            <>
              <div className="booking-stat">
                <Stat label="Active bookings" value={active.length} />
                <Stat label="Held, not confirmed" value={active.filter((one) => one.status === 'hold').length} />
                <Stat label="Collected" value={formatMoney(collected / 100)} />
                <Stat label="Still due" value={formatMoney(due / 100)} />
              </div>
              {data.booking.length === 0 ? (
                <EmptyState
                  title={status ? `No ${STATUS_LABEL[status as BookingView['status']]?.label.toLowerCase() ?? ''} bookings on this day` : 'No bookings on this day'}
                  description="Bookings made on the public page and at the desk appear here as soon as a court is held."
                  action={
                    status ? (
                      <Button tone="secondary" onClick={() => setStatus('')}>
                        Show all bookings
                      </Button>
                    ) : (
                      <Button tone="secondary" onClick={() => window.open(`/v/${encodeURIComponent(operator.session.organization_code)}`, '_blank')}>
                        Open the booking page
                      </Button>
                    )
                  }
                />
              ) : (
                <div className="table-wrap">
                  <table className="table booking-table">
                    <caption className="visually-hidden">Bookings for {date}</caption>
                    <thead>
                      <tr>
                        <th scope="col">Time</th>
                        <th scope="col">Court</th>
                        <th scope="col">Name</th>
                        <th scope="col">Contact</th>
                        <th scope="col">Status</th>
                        <th scope="col">Payment</th>
                        <th scope="col" className="number">Amount</th>
                        <th scope="col"><span className="visually-hidden">Actions</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.booking.map((one) => (
                        <BookingRow key={one.booking_code} booking={one} time_zone={data.time_zone} can_manage={can_manage} onOpen={setOpen} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )
        }}
      </ResourceView>

      {can_manage && <SettingCard onSaved={(message) => setSuccess(message)} />}

      {open?.kind === 'payment' && <PaymentDialog booking={open.booking} onClose={() => setOpen(undefined)} onDone={done} />}
      {open?.kind === 'refund' && <RefundDialog booking={open.booking} onClose={() => setOpen(undefined)} onDone={done} />}
      {open?.kind === 'cancel' && <CancelDialog booking={open.booking} time_zone={list.data?.time_zone} onClose={() => setOpen(undefined)} onDone={done} />}
    </>
  )
}

function BookingRow({
  booking,
  time_zone,
  can_manage,
  onOpen,
}: {
  booking: BookingView
  time_zone: string
  can_manage: boolean
  onOpen: (open: Open) => void
}) {
  const is_active = booking.status === 'hold' || booking.status === 'confirmed'
  const status = STATUS_LABEL[booking.status]
  const payment = PAYMENT_LABEL[booking.payment_state]
  return (
    <tr>
      {/* Wide enough for "8:00 PM –" on one line, so the range breaks once, not three times. */}
      <td style={{ minWidth: '6.5rem' }}>{formatTimeRange(booking.starts_at, booking.ends_at, time_zone)}</td>
      <td>{booking.court_name}</td>
      <td>
        <strong>{booking.contact.display_name}</strong>
        <span className="muted mono">{booking.booking_code}</span>
      </td>
      <td>
        {booking.contact.phone ? <a href={`tel:${booking.contact.phone.replace(/[^\d+]/g, '')}`}>{booking.contact.phone}</a> : <span className="muted">—</span>}
        {booking.contact.email && <span className="muted">{booking.contact.email}</span>}
      </td>
      <td>
        <Badge tone={status.tone}>{status.label}</Badge>
      </td>
      <td>
        {booking.is_portal_booking ? <Badge tone={payment.tone}>{payment.label}</Badge> : <span className="muted">Desk booking</span>}
        {booking.payment_method.length > 0 && <span className="muted">{booking.payment_method.map((one) => METHOD_LABEL[one] ?? one).join(', ')}</span>}
        {booking.is_pay_at_counter && booking.payment_state === 'unpaid' && <span className="muted">Paying at counter</span>}
      </td>
      <td className="number">
        {formatMoney(booking.total_amount)}
        {booking.is_portal_booking && Number(booking.paid_amount) > 0 && <span className="muted">paid {formatMoney(booking.paid_amount)}</span>}
      </td>
      <td>
        {can_manage && (
          <div className="booking-table__action">
            {booking.is_portal_booking && is_active && Number(booking.balance_amount) > 0 && (
              <Button size="sm" onClick={() => onOpen({ kind: 'payment', booking })}>
                Record payment
              </Button>
            )}
            {booking.is_portal_booking && Number(booking.paid_amount) > 0 && (
              <Button size="sm" tone="secondary" onClick={() => onOpen({ kind: 'refund', booking })}>
                Refund
              </Button>
            )}
            {is_active && (
              <Button size="sm" tone="danger" onClick={() => onOpen({ kind: 'cancel', booking })}>
                Cancel
              </Button>
            )}
          </div>
        )}
      </td>
    </tr>
  )
}

function PaymentDialog({ booking, onClose, onDone }: { booking: BookingView; onClose: () => void; onDone: (message: string) => void }) {
  const [method, setMethod] = useState('cash')
  const [amount, setAmount] = useState(booking.balance_amount)
  const [reference, setReference] = useState('')
  const [problem, setProblem] = useState<{ amount?: string; reference?: string }>({})
  const action = useAction(() => recordPayment(booking.booking_code, { method, amount, reference }))

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const next: { amount?: string; reference?: string } = {}
    if (!/^\d+(\.\d{1,2})?$/.test(amount.trim()) || Number(amount) <= 0) next.amount = 'Enter the amount received, for example 500.'
    else if (toCent(amount) > toCent(booking.balance_amount)) next.amount = `Only ${formatMoney(booking.balance_amount)} is still due.`
    if (method !== 'cash' && !reference.trim()) next.reference = method === 'gcash' ? 'Enter the GCash reference number.' : 'Enter the approval code.'
    setProblem(next)
    if (Object.keys(next).length > 0) return
    const result = await action.run()
    if (result) onDone(`Recorded ${formatMoney(amount)} ${METHOD_LABEL[method]?.toLowerCase() ?? method} from ${booking.contact.display_name}.`)
  }

  return (
    <Dialog
      open
      title="Record a counter payment"
      onClose={onClose}
      footer={
        <>
          <Button tone="quiet" onClick={onClose}>
            Close
          </Button>
          <Button type="submit" form="portal-payment" disabled={action.is_pending}>
            {action.is_pending ? 'Recording…' : 'Record payment'}
          </Button>
        </>
      }
    >
      <p>
        {booking.contact.display_name} · {booking.court_name} · {formatMoney(booking.balance_amount)} due
      </p>
      <ErrorAlert error={action.error} onDismiss={action.clearError} />
      <form id="portal-payment" className="form" onSubmit={submit} noValidate>
        <SelectInput
          label="Method"
          value={method}
          onChange={(event) => setMethod(event.target.value)}
          option={[
            { value: 'cash', label: 'Cash' },
            { value: 'gcash', label: 'GCash' },
            { value: 'card_terminal', label: 'Card terminal' },
          ]}
        />
        <TextInput label="Amount received (PHP)" inputMode="decimal" value={amount} error={problem.amount} onChange={(event) => setAmount(event.target.value)} />
        <TextInput
          label={method === 'gcash' ? 'GCash reference number' : method === 'card_terminal' ? 'Approval code' : 'Receipt number (optional)'}
          value={reference}
          error={problem.reference}
          hint="The same reference twice is recorded once."
          onChange={(event) => setReference(event.target.value)}
        />
      </form>
    </Dialog>
  )
}

function RefundDialog({ booking, onClose, onDone }: { booking: BookingView; onClose: () => void; onDone: (message: string) => void }) {
  const [amount, setAmount] = useState(booking.paid_amount)
  const [reason, setReason] = useState(booking.status === 'cancelled' ? 'Cancelled booking' : '')
  const [reference, setReference] = useState('')
  const [problem, setProblem] = useState<{ amount?: string; reason?: string }>({})
  const action = useAction(() => refundBooking(booking.booking_code, { amount, reason, reference }))

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const next: { amount?: string; reason?: string } = {}
    if (!/^\d+(\.\d{1,2})?$/.test(amount.trim()) || Number(amount) <= 0) next.amount = 'Enter the amount to refund.'
    else if (toCent(amount) > toCent(booking.paid_amount)) next.amount = `You can refund at most ${formatMoney(booking.paid_amount)}.`
    if (!reason.trim()) next.reason = 'Say why the money is going back.'
    setProblem(next)
    if (Object.keys(next).length > 0) return
    const result = await action.run()
    if (result) onDone(`Refunded ${formatMoney(amount)} to ${booking.contact.display_name}. The booking stays ${STATUS_LABEL[result.booking.status].label.toLowerCase()}.`)
  }

  return (
    <Dialog
      open
      title="Refund a payment"
      onClose={onClose}
      footer={
        <>
          <Button tone="quiet" onClick={onClose}>
            Close
          </Button>
          <Button type="submit" tone="danger" form="portal-refund" disabled={action.is_pending}>
            {action.is_pending ? 'Refunding…' : `Refund ${/^\d+(\.\d{1,2})?$/.test(amount.trim()) ? formatMoney(amount) : ''}`}
          </Button>
        </>
      }
    >
      <p>
        {booking.contact.display_name} paid {formatMoney(booking.paid_amount)} for {booking.court_name}. Refunding does not cancel the booking.
      </p>
      <ErrorAlert error={action.error} onDismiss={action.clearError} />
      <form id="portal-refund" className="form" onSubmit={submit} noValidate>
        <TextInput label="Amount to refund (PHP)" inputMode="decimal" value={amount} error={problem.amount} onChange={(event) => setAmount(event.target.value)} />
        <TextInput label="Reason" value={reason} error={problem.reason} onChange={(event) => setReason(event.target.value)} />
        <TextInput label="Refund reference (optional)" value={reference} hint="GCash or bank transfer reference, if any." onChange={(event) => setReference(event.target.value)} />
      </form>
    </Dialog>
  )
}

function CancelDialog({
  booking,
  time_zone,
  onClose,
  onDone,
}: {
  booking: BookingView
  time_zone: string | undefined
  onClose: () => void
  onDone: (message: string) => void
}) {
  const action = useAction(() => cancelAsOperator(booking.booking_code))
  return (
    <Dialog
      open
      title="Cancel this booking?"
      onClose={onClose}
      footer={
        <>
          <Button tone="quiet" onClick={onClose}>
            Keep booking
          </Button>
          <Button
            tone="danger"
            disabled={action.is_pending}
            onClick={async () => {
              const result = await action.run()
              if (result) onDone(`Cancelled ${booking.contact.display_name}'s booking. ${booking.court_name} is open again.`)
            }}
          >
            {action.is_pending ? 'Cancelling…' : 'Cancel booking'}
          </Button>
        </>
      }
    >
      <p>
        {booking.contact.display_name} · {booking.court_name} · {formatTimeRange(booking.starts_at, booking.ends_at, time_zone)}. The court opens for other players and the guest is told.
      </p>
      {Number(booking.paid_amount) > 0 && (
        <Alert severity="caution" title="Money was paid">
          {formatMoney(booking.paid_amount)} stays recorded. Refund it separately from this list.
        </Alert>
      )}
      <ErrorAlert error={action.error} onDismiss={action.clearError} />
    </Dialog>
  )
}

function SettingCard({ onSaved }: { onSaved: (message: string) => void }) {
  const setting = useResource(() => loadSetting(), [])
  const [is_allowed, setAllowed] = useState(true)
  const [instruction, setInstruction] = useState('')
  useEffect(() => {
    if (setting.data) {
      setAllowed(setting.data.setting.is_counter_payment_allowed)
      setInstruction(setting.data.setting.counter_instruction)
    }
  }, [setting.data])
  const action = useAction(() => saveSetting({ is_counter_payment_allowed: is_allowed, counter_instruction: instruction }))

  return (
    <div style={{ marginTop: 'var(--space-6)' }}>
      <Card title="Checkout options" description="What guests can choose when they book online.">
        <ResourceView resource={setting}>
          {() => (
            <form
              className="form"
              onSubmit={async (event) => {
                event.preventDefault()
                const result = await action.run()
                if (result) onSaved(result.setting.is_counter_payment_allowed ? 'Guests can reserve now and pay at the counter.' : 'Guests must pay online to confirm a court.')
              }}
            >
              <ErrorAlert error={action.error} onDismiss={action.clearError} />
              <Checkbox label="Let guests reserve now and pay at the counter" checked={is_allowed} onChange={(event) => setAllowed(event.target.checked)} />
              <TextArea
                label="What to tell guests paying at the counter"
                value={instruction}
                maxLength={500}
                onChange={(event) => setInstruction(event.target.value)}
              />
              <div className="form__action">
                <Button type="submit" disabled={action.is_pending}>
                  {action.is_pending ? 'Saving…' : 'Save checkout options'}
                </Button>
              </div>
            </form>
          )}
        </ResourceView>
      </Card>
    </div>
  )
}
