// Public booking recovery: the link a guest keeps. Status, hold countdown, pay,
// and cancel — with the reason when cancelling is no longer possible.

import { useEffect, useState } from 'react'
import { ApiError } from '../../api.ts'
import { Alert, Badge, Button, ButtonLink, Card, Dialog, EmptyState, ErrorAlert, Loading, PageHeader } from '../../component/ui.tsx'
import { formatDate, formatDateTime, formatMoney, formatTimeRange } from '../../format.ts'
import { useAction, useInterval, useResource } from '../../hook.ts'
import type { PageProp } from '../../registry.ts'
import { useQuery } from '../../route.tsx'
import {
  METHOD_LABEL,
  PAYMENT_LABEL,
  STATUS_LABEL,
  cancelBooking,
  findSavedToken,
  loadRecovery,
  payBooking,
  saveBooking,
  type BookingView,
} from './portal-api.ts'
import './portal.css'

function remainingText(until: string, now: number): string {
  const second = Math.max(0, Math.floor((Date.parse(until) - now) / 1000))
  return `${Math.floor(second / 60)}:${String(second % 60).padStart(2, '0')}`
}

/** A stable sentence that changes only at a milestone, so the live region is not chatty. */
function holdMilestone(until: string, now: number): string {
  const second = Math.max(0, Math.floor((Date.parse(until) - now) / 1000))
  if (second === 0) return 'The hold has ended.'
  if (second <= 60) return 'Less than 1 minute left to pay before the hold ends.'
  if (second <= 300) return 'Less than 5 minutes left to pay before the hold ends.'
  return ''
}

export default function Page({ param }: PageProp) {
  const organization_code = param['organization_code'] ?? ''
  const booking_code = param['booking_code'] ?? ''
  const query = useQuery()
  const token = query.get('token') ?? findSavedToken(organization_code, booking_code) ?? ''
  const resource = useResource(
    () => (token ? loadRecovery(organization_code, booking_code, token) : Promise.reject(new ApiError(404, 'missing token', null))),
    [organization_code, booking_code, token],
  )
  const [now, setNow] = useState(() => Date.now())
  const [success, setSuccess] = useState<string>()
  const [is_confirming_cancel, setConfirmingCancel] = useState(false)
  const booking = resource.data?.booking

  useEffect(() => {
    if (booking && token) {
      saveBooking({ organization_code, booking_code, recovery_token: token, court_name: booking.court_name, starts_at: booking.starts_at })
    }
  }, [booking, token, organization_code, booking_code])

  const is_counting = booking?.status === 'hold' && booking.hold_expires_at !== null
  useInterval(() => {
    setNow(Date.now())
    if (booking?.hold_expires_at && Date.parse(booking.hold_expires_at) <= Date.now()) resource.reload()
  }, is_counting ? 1000 : undefined)

  const pay = useAction(async (method: 'online' | 'counter') => {
    const result = await payBooking(organization_code, booking_code, token, method)
    if (result.checkout_url) {
      window.location.assign(result.checkout_url)
      return result
    }
    setSuccess(
      method === 'online'
        ? result.booking.payment_state === 'paid'
          ? `Paid ${formatMoney(result.booking.paid_amount)}. Your court is confirmed.`
          : 'Your payment is being checked.'
        : (result.instruction ?? 'Your court is reserved. Pay at the front desk when you arrive.'),
    )
    resource.reload()
    return result
  })

  const cancel = useAction(async () => {
    const result = await cancelBooking(organization_code, booking_code, token)
    setConfirmingCancel(false)
    setSuccess(
      Number(result.booking.paid_amount) > 0
        ? `Booking cancelled. The venue will refund your ${formatMoney(result.booking.paid_amount)} payment.`
        : 'Booking cancelled. The court is open for others again.',
    )
    resource.reload()
    return result
  })

  if (!token || (resource.error instanceof ApiError && resource.error.status === 404)) {
    return (
      <div className="recovery">
        <EmptyState
          title="We could not open this booking"
          description="Open the booking link from your confirmation on the device you booked with. The link carries the key that proves the booking is yours."
          action={<ButtonLink to={`/v/${encodeURIComponent(organization_code)}`}>Book a court</ButtonLink>}
        />
      </div>
    )
  }
  if (resource.error && !booking) {
    return (
      <div className="recovery">
        <Alert severity="danger" title="Could not load your booking">
          <p>{resource.error.message}</p>
          <Button tone="secondary" size="sm" onClick={resource.reload}>
            Try again
          </Button>
        </Alert>
      </div>
    )
  }
  if (!booking) return <Loading label="Opening your booking…" />

  const status = STATUS_LABEL[booking.status]
  const payment = PAYMENT_LABEL[booking.payment_state]
  const is_active = booking.status === 'hold' || booking.status === 'confirmed'

  return (
    <div className="recovery">
      <PageHeader
        eyebrow={`Booking ${booking.booking_code}`}
        title={booking.court_name}
        description={`${formatDate(booking.starts_at)} · ${formatTimeRange(booking.starts_at, booking.ends_at)}`}
      />
      <div className="row">
        <Badge tone={status.tone}>{status.label}</Badge>
        <Badge tone={payment.tone}>{payment.label}</Badge>
        {booking.is_pay_at_counter && booking.payment_state !== 'paid' && <Badge tone="info">Pay at counter</Badge>}
      </div>

      {success && (
        <Alert severity="success" title="Done" onDismiss={() => setSuccess(undefined)}>
          {success}
        </Alert>
      )}
      <ErrorAlert error={pay.error} onDismiss={pay.clearError} />

      {booking.status === 'hold' && booking.hold_expires_at && (
        <Card title="Your court is held" description="Finish payment before the hold ends, or the court opens for others.">
          <p className="countdown" aria-live="off">
            {remainingText(booking.hold_expires_at, now)}
          </p>
          {/* The clock ticks silently; this announces only at 5 minutes, 1 minute, and the end. */}
          <p className="visually-hidden" role="status">
            {holdMilestone(booking.hold_expires_at, now)}
          </p>
          <p className="muted">Hold ends at {formatDateTime(booking.hold_expires_at)}.</p>
        </Card>
      )}
      {booking.status === 'expired' && (
        <Alert severity="caution" title="This hold expired">
          Nothing was charged. The court may still be open — book it again.
        </Alert>
      )}

      <Card title="Details">
        <dl className="summary-list">
          <dt>Name</dt>
          <dd>{booking.contact.display_name}</dd>
          <dt>Players</dt>
          <dd>{booking.participant_count}</dd>
          <dt>Total</dt>
          <dd>{formatMoney(booking.total_amount)}</dd>
          <dt>Paid</dt>
          <dd>
            {formatMoney(booking.paid_amount)}
            {booking.payment_method.length > 0 && ` · ${booking.payment_method.map((one) => METHOD_LABEL[one] ?? one).join(', ')}`}
          </dd>
          {Number(booking.refunded_amount) > 0 && (
            <>
              <dt>Refunded</dt>
              <dd>{formatMoney(booking.refunded_amount)}</dd>
            </>
          )}
          {booking.cancellation_cutoff_at && (
            <>
              <dt>Free cancellation until</dt>
              <dd>{formatDateTime(booking.cancellation_cutoff_at)}</dd>
            </>
          )}
        </dl>
      </Card>

      {is_active && booking.is_pay_at_counter && booking.payment_state === 'unpaid' && resource.data?.counter_instruction && (
        <Alert severity="info" title="Paying at the counter">
          {resource.data.counter_instruction}
        </Alert>
      )}

      {is_active && (
        <div className="form__action">
          {booking.is_payable_online && (
            booking.checkout_url ? (
              <Button onClick={() => window.location.assign(booking.checkout_url!)}>Continue to checkout</Button>
            ) : (
              <Button disabled={pay.is_pending} onClick={() => void pay.run('online')}>
                {pay.is_pending ? 'Paying…' : `Pay ${formatMoney(booking.balance_amount)} now`}
              </Button>
            )
          )}
          {booking.status === 'hold' && !booking.is_pay_at_counter && (
            <Button tone="secondary" disabled={pay.is_pending} onClick={() => void pay.run('counter')}>
              Pay at the counter instead
            </Button>
          )}
          {booking.is_cancellable && (
            <Button tone="danger" onClick={() => setConfirmingCancel(true)}>
              {booking.status === 'hold' ? 'Release this court' : 'Cancel booking'}
            </Button>
          )}
        </div>
      )}
      {is_active && !booking.is_cancellable && booking.cancel_refusal && <p className="muted">{booking.cancel_refusal}</p>}

      <ButtonLink tone="quiet" to={`/v/${encodeURIComponent(organization_code)}`}>
        Book another court
      </ButtonLink>

      <CancelDialog
        open={is_confirming_cancel}
        booking={booking}
        is_pending={cancel.is_pending}
        error={cancel.error}
        onClose={() => {
          setConfirmingCancel(false)
          cancel.clearError()
        }}
        onConfirm={() => void cancel.run()}
      />
    </div>
  )
}

function CancelDialog({
  open,
  booking,
  is_pending,
  error,
  onClose,
  onConfirm,
}: {
  open: boolean
  booking: BookingView
  is_pending: boolean
  error: Error | undefined
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <Dialog
      open={open}
      title={booking.status === 'hold' ? 'Release this court?' : 'Cancel this booking?'}
      onClose={onClose}
      footer={
        <>
          <Button tone="quiet" onClick={onClose} disabled={is_pending}>
            Keep my booking
          </Button>
          <Button tone="danger" onClick={onConfirm} disabled={is_pending}>
            {is_pending ? 'Cancelling…' : 'Yes, cancel'}
          </Button>
        </>
      }
    >
      <p>
        {booking.court_name} on {formatDate(booking.starts_at)} at {formatTimeRange(booking.starts_at, booking.ends_at)} will open up for other players. This cannot be undone.
      </p>
      {Number(booking.paid_amount) > 0 && <p>The venue will refund the {formatMoney(booking.paid_amount)} you paid.</p>}
      <ErrorAlert error={error} />
    </Dialog>
  )
}
