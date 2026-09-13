// Court board: one venue day, court by court. Desktop shows a timeline (courts
// as rows, hours across); a phone gets a per-court list. Every block is a
// button, so the whole board is keyboard operable — no drag anywhere.

import { CaretLeft, CaretRight, Wrench } from '@phosphor-icons/react'
import { useEffect, useState, type FormEvent } from 'react'
import { jsonBody, operatorFetch } from '../../api.ts'
import {
  Alert,
  Badge,
  Button,
  ButtonLink,
  Card,
  Checkbox,
  Dialog,
  EmptyState,
  ErrorAlert,
  PageHeader,
  ResourceView,
  SelectInput,
  TextInput,
} from '../../component/ui.tsx'
import { formatMoney, formatTime, formatTimeRange, toDateInput } from '../../format.ts'
import { useAction, useInterval, useResource } from '../../hook.ts'
import type { PageProp } from '../../registry.ts'
import { useQuery } from '../../route.tsx'
import { useOperator } from '../../session.tsx'
import { addDay, formatHourLabel, formatLongDate, minuteFromDayStart, timeMinute, zonedIso } from './court-time.ts'
import type { Board, BoardBooking, BoardCourt, BoardSession, Closure } from './court-type.ts'
import './court.css'

type DialogState =
  | { kind: 'booking'; court: BoardCourt; booking: BoardBooking }
  | { kind: 'walk_in'; court: BoardCourt; session: BoardSession }
  | { kind: 'closure'; closure: Closure }
  | { kind: 'maintenance'; resource_id?: string }

const REFRESH_MILLISECOND = 30_000

export default function Page(_prop: PageProp) {
  const { can } = useOperator()
  const is_manager = can('court.manage')
  const query = useQuery()
  const [date, setDate] = useState<string | undefined>(query.get('date') ?? undefined)
  const board = useResource(() => operatorFetch<Board>(`/api/v1/court/board${date ? `?date=${date}` : ''}`), [date])
  const [updated_at, setUpdatedAt] = useState<Date>()
  const [dialog, setDialog] = useState<DialogState>()
  const [notice, setNotice] = useState<string>()

  useEffect(() => {
    if (board.data) setUpdatedAt(new Date())
  }, [board.data])
  useInterval(board.reload, dialog ? undefined : REFRESH_MILLISECOND)

  const go = (next: string) => {
    setDate(next)
    setNotice(undefined)
    window.history.replaceState(null, '', `/operator/board?date=${next}`)
  }
  const done = (message: string) => {
    setDialog(undefined)
    setNotice(message)
    board.reload()
  }

  const data = board.data
  const time_zone = data?.time_zone ?? 'Asia/Manila'
  const today = toDateInput(new Date(), time_zone)

  return (
    <>
      <PageHeader
        eyebrow={data?.site_display_name ?? 'Today'}
        title="Court board"
        description={data ? `${formatLongDate(data.date)}${data.date === today ? ' · today' : ''}` : undefined}
        action={
          is_manager &&
          data &&
          data.court.length > 0 && (
            <Button tone="secondary" icon={<Wrench size={18} aria-hidden />} onClick={() => setDialog({ kind: 'maintenance' })}>
              Block for maintenance
            </Button>
          )
        }
      />

      {data && (
        <div className="court-board__toolbar">
          <Button tone="quiet" size="sm" icon={<CaretLeft size={16} aria-hidden />} aria-label="Previous day" onClick={() => go(addDay(data.date, -1))}>
            <span className="visually-hidden">Previous day</span>
          </Button>
          <div className="court-board__date">
            <TextInput label="Day" type="date" value={data.date} onChange={(event) => event.target.value && go(event.target.value)} />
          </div>
          <Button tone="quiet" size="sm" icon={<CaretRight size={16} aria-hidden />} aria-label="Next day" onClick={() => go(addDay(data.date, 1))}>
            <span className="visually-hidden">Next day</span>
          </Button>
          {data.date !== today && (
            <Button tone="secondary" size="sm" onClick={() => go(today)}>
              Today
            </Button>
          )}
          <span className="court-board__updated" aria-live="polite">
            {board.is_loading ? 'Refreshing…' : updated_at ? `Updated ${formatTime(updated_at, time_zone)} · refreshes every 30 seconds` : ''}
          </span>
        </div>
      )}

      {notice && (
        <div className="court-page-alert">
          <Alert severity="success" title={notice} onDismiss={() => setNotice(undefined)} />
        </div>
      )}
      {board.error && board.data && (
        <div className="court-page-alert">
          <Alert severity="caution" title="Could not refresh the board">
            Showing what was last loaded. {board.error.message}
          </Alert>
        </div>
      )}

      <ResourceView resource={board}>
        {(loaded) =>
          loaded.court.length === 0 ? (
            <EmptyState
              title="No courts yet"
              description="Add courts and a schedule in Venue setup, and the day's bookings will show here."
              action={<ButtonLink to="/operator/venue?tab=court">Set up courts</ButtonLink>}
            />
          ) : (
            <BoardView board={loaded} is_manager={is_manager} onOpen={setDialog} />
          )
        }
      </ResourceView>

      {data && dialog?.kind === 'booking' && (
        <BookingDialog board={data} court={dialog.court} booking={dialog.booking} is_manager={is_manager} onClose={() => setDialog(undefined)} onDone={done} />
      )}
      {data && dialog?.kind === 'walk_in' && <WalkInDialog board={data} court={dialog.court} session={dialog.session} onClose={() => setDialog(undefined)} onDone={done} />}
      {data && dialog?.kind === 'closure' && <ClosureDialog board={data} closure={dialog.closure} is_manager={is_manager} onClose={() => setDialog(undefined)} onDone={done} />}
      {data && dialog?.kind === 'maintenance' && (
        <MaintenanceDialog board={data} {...(dialog.resource_id ? { resource_id: dialog.resource_id } : {})} onClose={() => setDialog(undefined)} onDone={done} />
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// the day
// ---------------------------------------------------------------------------

function statusLabel(booking: BoardBooking): string {
  return booking.status === 'hold' ? 'On hold' : 'Confirmed'
}

function paidLabel(booking: BoardBooking): string | undefined {
  if (booking.paid_state === 'paid') return 'Paid'
  if (booking.paid_state === 'partial') return 'Part paid'
  if (booking.paid_state === 'unpaid') return 'Unpaid'
  return undefined
}

function BoardView({ board, is_manager, onOpen }: { board: Board; is_manager: boolean; onOpen: (state: DialogState) => void }) {
  const tz = board.time_zone
  const now = Date.now()

  // Window: opening hours, widened to anything actually on the board that day.
  const edge: number[] = []
  for (const court of board.court) {
    for (const one of [...court.session, ...court.booking, ...court.closure]) {
      edge.push(minuteFromDayStart(one.starts_at, board.date, tz), minuteFromDayStart(one.ends_at, board.date, tz))
    }
  }
  const opens = board.opens_local ? timeMinute(board.opens_local) : edge.length > 0 ? Math.min(...edge) : 6 * 60
  const closes = board.closes_local ? timeMinute(board.closes_local) : edge.length > 0 ? Math.max(...edge) : 23 * 60
  const start = Math.max(0, Math.floor(Math.min(opens, ...edge) / 60) * 60)
  const end = Math.min(1440, Math.max(start + 60, Math.ceil(Math.max(closes, ...edge) / 60) * 60))
  const span = end - start
  const hour_count = span / 60
  const position = (starts_at: string, ends_at: string) => {
    const left = Math.max(minuteFromDayStart(starts_at, board.date, tz), start)
    const right = Math.min(minuteFromDayStart(ends_at, board.date, tz), end)
    return { left: `calc(${((left - start) / span) * 100}% + 2px)`, width: `calc(${(Math.max(right - left, 0) / span) * 100}% - 4px)` }
  }
  const now_minute = minuteFromDayStart(new Date(now).toISOString(), board.date, tz)
  const is_now_visible = now_minute > start && now_minute < end

  const has_sale = board.court.some((one) => one.session.length > 0 || one.booking.length > 0)
  const closureFor = (court: BoardCourt) => [...board.closure, ...court.closure]
  const openSlot = (court: BoardCourt) => court.session.filter((one) => one.is_bookable && Date.parse(one.ends_at) > now)

  return (
    <div className="stack">
      {!has_sale && (
        <Alert severity="info" title="Nothing on sale this day">
          <p>The venue may be closed, or the schedule has not reached this date yet.</p>
          <ButtonLink to="/operator/venue?tab=schedule" tone="secondary" size="sm">
            Check schedule and hours
          </ButtonLink>
        </Alert>
      )}
      {board.closure.map((one) => (
        <Alert key={one.closure_id} severity="caution" title={`Venue closed ${formatTimeRange(one.starts_at, one.ends_at, tz)}`}>
          {one.reason}
        </Alert>
      ))}

      <ul className="court-legend" aria-label="Legend">
        <li className="court-legend__item">
          <span className="court-swatch court-swatch--confirmed" aria-hidden /> Confirmed
        </li>
        <li className="court-legend__item">
          <span className="court-swatch court-swatch--hold" aria-hidden /> On hold, awaiting payment
        </li>
        <li className="court-legend__item">
          <span className="court-swatch court-swatch--closure" aria-hidden /> Closed or maintenance
        </li>
        <li className="court-legend__item">
          <span className="court-swatch court-swatch--open" aria-hidden /> Open slot{is_manager ? ' — select to book a walk-in' : ''}
        </li>
      </ul>

      {/* desktop: timeline */}
      <div className="court-timeline" style={{ ['--court-hour-count' as string]: hour_count }}>
        <div className="court-timeline__grid">
          <div className="court-timeline__head" aria-hidden>
            <div className="court-timeline__name">Court</div>
            <div className="court-timeline__hours">
              {Array.from({ length: hour_count }, (_value, index) => (
                <span key={index} className="court-timeline__hour-label" style={{ left: `${(index / hour_count) * 100}%` }}>
                  {formatHourLabel(start + index * 60)}
                </span>
              ))}
              &nbsp;
            </div>
          </div>
          {board.court.map((court) => (
            <div key={court.resource_id} className="court-timeline__row">
              <div className="court-timeline__name">
                <strong>{court.display_name}</strong>
                {court.sport_display_name && <span className="muted">{court.sport_display_name}</span>}
              </div>
              <div className="court-timeline__lane" role="group" aria-label={`${court.display_name} timeline`}>
                {Array.from({ length: hour_count }, (_value, index) => (
                  <span key={index} className="court-timeline__tick" style={{ left: `${(index / hour_count) * 100}%` }} aria-hidden />
                ))}
                {is_now_visible && <span className="court-timeline__now" style={{ left: `${((now_minute - start) / span) * 100}%` }} aria-hidden />}
                {openSlot(court).map((one) => (
                  <button
                    key={one.session_id}
                    type="button"
                    className="court-block court-block--open"
                    style={position(one.starts_at, one.ends_at)}
                    disabled={!is_manager}
                    aria-label={`Open slot on ${court.display_name}, ${formatTimeRange(one.starts_at, one.ends_at, tz)}, ${formatMoney(one.price_amount)}${is_manager ? '. Book a walk-in' : ''}`}
                    onClick={() => onOpen({ kind: 'walk_in', court, session: one })}
                  >
                    <span className="court-block__title">{formatTime(one.starts_at, tz)}</span>
                    <span className="court-block__meta">{formatMoney(one.price_amount)}</span>
                  </button>
                ))}
                {closureFor(court).map((one) => (
                  <button
                    key={`${court.resource_id}.${one.closure_id}`}
                    type="button"
                    className="court-block court-block--closure"
                    style={position(one.starts_at, one.ends_at)}
                    aria-label={`${court.display_name} closed ${formatTimeRange(one.starts_at, one.ends_at, tz)}: ${one.reason}`}
                    onClick={() => onOpen({ kind: 'closure', closure: one })}
                  >
                    <span className="court-block__title">{one.reason}</span>
                    <span className="court-block__meta">{formatTimeRange(one.starts_at, one.ends_at, tz)}</span>
                  </button>
                ))}
                {court.booking.map((one) => (
                  <button
                    key={one.booking_id}
                    type="button"
                    className={`court-block court-block--${one.status === 'hold' ? 'hold' : 'confirmed'}`}
                    style={position(one.starts_at, one.ends_at)}
                    aria-label={`${one.party_display_name ?? 'Booking'} on ${court.display_name}, ${formatTimeRange(one.starts_at, one.ends_at, tz)}, ${statusLabel(one)}${paidLabel(one) ? `, ${paidLabel(one)}` : ''}`}
                    onClick={() => onOpen({ kind: 'booking', court, booking: one })}
                  >
                    <span className="court-block__title">{one.party_display_name ?? 'Booking'}</span>
                    <span className="court-block__meta">
                      {formatTimeRange(one.starts_at, one.ends_at, tz)}
                      {paidLabel(one) ? ` · ${paidLabel(one)}` : ''}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* phone: per-court list */}
      <div className="court-list">
        {board.court.map((court) => {
          const entry = [
            ...court.booking.map((one) => ({ key: one.booking_id, starts_at: one.starts_at, kind: 'booking' as const, one })),
            ...closureFor(court).map((one) => ({ key: `c.${one.closure_id}`, starts_at: one.starts_at, kind: 'closure' as const, one })),
            ...openSlot(court).map((one) => ({ key: `s.${one.session_id}`, starts_at: one.starts_at, kind: 'open' as const, one })),
          ].sort((left, right) => Date.parse(left.starts_at) - Date.parse(right.starts_at))
          return (
            <Card key={court.resource_id} title={court.display_name} description={court.sport_display_name ?? undefined}>
              {entry.length === 0 ? (
                <p className="muted">Nothing on this court today.</p>
              ) : (
                <div className="court-list__entries">
                  {entry.map((item) =>
                    item.kind === 'booking' ? (
                      <button
                        key={item.key}
                        type="button"
                        className={`court-list__item court-block--${item.one.status === 'hold' ? 'hold' : 'confirmed'}`}
                        onClick={() => onOpen({ kind: 'booking', court, booking: item.one })}
                      >
                        <span className="court-list__time">{formatTime(item.one.starts_at, tz)}</span>
                        <span className="court-list__body">
                          <strong>{item.one.party_display_name ?? 'Booking'}</strong>
                          <span>
                            {statusLabel(item.one)}
                            {paidLabel(item.one) ? ` · ${paidLabel(item.one)}` : ''}
                          </span>
                        </span>
                      </button>
                    ) : item.kind === 'closure' ? (
                      <button key={item.key} type="button" className="court-list__item court-block--closure" onClick={() => onOpen({ kind: 'closure', closure: item.one })}>
                        <span className="court-list__time">{formatTime(item.one.starts_at, tz)}</span>
                        <span className="court-list__body">
                          <strong>Closed</strong>
                          <span>{item.one.reason}</span>
                        </span>
                      </button>
                    ) : (
                      <button
                        key={item.key}
                        type="button"
                        className="court-list__item court-block--open"
                        disabled={!is_manager}
                        onClick={() => onOpen({ kind: 'walk_in', court, session: item.one })}
                      >
                        <span className="court-list__time">{formatTime(item.one.starts_at, tz)}</span>
                        <span className="court-list__body">
                          <strong>Open</strong>
                          <span>{formatMoney(item.one.price_amount)}</span>
                        </span>
                        {is_manager && <span aria-hidden>Book</span>}
                      </button>
                    ),
                  )}
                </div>
              )}
            </Card>
          )
        })}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// dialogs
// ---------------------------------------------------------------------------

function BookingDialog({
  board,
  court,
  booking,
  is_manager,
  onClose,
  onDone,
}: {
  board: Board
  court: BoardCourt
  booking: BoardBooking
  is_manager: boolean
  onClose: () => void
  onDone: (message: string) => void
}) {
  const tz = board.time_zone
  const other = board.court.filter((one) => one.resource_id !== court.resource_id)
  const [target, setTarget] = useState(other[0]?.resource_id ?? '')
  const [is_confirming_cancel, setConfirmingCancel] = useState(false)
  const move = useAction(() => operatorFetch<{ booking: BoardBooking }>(`/api/v1/court/board/booking/${booking.booking_id}/move`, jsonBody({ resource_id: target })))
  const cancel = useAction(() => operatorFetch(`/api/v1/court/board/booking/${booking.booking_id}/cancel`, jsonBody({})))
  const name = booking.party_display_name ?? 'This booking'
  const time = formatTimeRange(booking.starts_at, booking.ends_at, tz)
  const is_past = Date.parse(booking.ends_at) <= Date.now()

  return (
    <Dialog open title={`${name} · ${court.display_name}`} onClose={onClose}>
      <dl className="court-detail">
        <dt>Time</dt>
        <dd>{time}</dd>
        <dt>Status</dt>
        <dd className="row">
          <Badge tone={booking.status === 'hold' ? 'caution' : 'success'}>{statusLabel(booking)}</Badge>
          {paidLabel(booking) && <Badge tone={booking.paid_state === 'paid' ? 'success' : 'caution'}>{paidLabel(booking)}</Badge>}
          {booking.channel_code === 'walk_in' && <Badge>Walk-in</Badge>}
        </dd>
        <dt>Players</dt>
        <dd>{booking.participant_count}</dd>
        {booking.party_phone_number && (
          <>
            <dt>Phone</dt>
            <dd>
              <a href={`tel:${booking.party_phone_number}`}>{booking.party_phone_number}</a>
            </dd>
          </>
        )}
        <dt>Price</dt>
        <dd>{formatMoney(booking.price_amount)}</dd>
        <dt>Booking code</dt>
        <dd className="mono">{booking.booking_code}</dd>
        {booking.hold_expire_at && (
          <>
            <dt>Hold ends</dt>
            <dd>{formatTime(booking.hold_expire_at, tz)}</dd>
          </>
        )}
      </dl>

      {is_manager && !is_past && (
        <>
          {other.length > 0 && (
            <form
              className="form"
              onSubmit={async (event: FormEvent) => {
                event.preventDefault()
                const answer = await move.run()
                if (answer) onDone(`${name} moved to ${other.find((one) => one.resource_id === target)?.display_name ?? 'the new court'}, ${time}.`)
              }}
            >
              <ErrorAlert error={move.error} onDismiss={move.clearError} />
              <div className="form__row">
                <SelectInput
                  label="Move to another court, same time"
                  value={target}
                  onChange={(event) => setTarget(event.target.value)}
                  option={other.map((one) => ({ value: one.resource_id, label: one.sport_display_name ? `${one.display_name} (${one.sport_display_name})` : one.display_name }))}
                />
              </div>
              <div className="form__action">
                <Button type="submit" tone="secondary" disabled={move.is_pending || !target}>
                  {move.is_pending ? 'Moving…' : 'Move booking'}
                </Button>
              </div>
            </form>
          )}
          <ErrorAlert error={cancel.error} onDismiss={cancel.clearError} />
          {is_confirming_cancel ? (
            <Alert severity="danger" title={`Cancel ${name}'s booking?`}>
              <p>The court is released at once and the next player on the waitlist, if any, is offered it. This cannot be undone.</p>
              <div className="row">
                <Button
                  tone="danger"
                  size="sm"
                  disabled={cancel.is_pending}
                  onClick={async () => {
                    const answer = await cancel.run()
                    if (answer) onDone(`${name}'s booking on ${court.display_name}, ${time}, was cancelled.`)
                  }}
                >
                  {cancel.is_pending ? 'Cancelling…' : 'Yes, cancel booking'}
                </Button>
                <Button tone="secondary" size="sm" onClick={() => setConfirmingCancel(false)}>
                  Keep booking
                </Button>
              </div>
            </Alert>
          ) : (
            <div className="row">
              <Button tone="danger" onClick={() => setConfirmingCancel(true)}>
                Cancel booking
              </Button>
            </div>
          )}
        </>
      )}
    </Dialog>
  )
}

function WalkInDialog({
  board,
  court,
  session,
  onClose,
  onDone,
}: {
  board: Board
  court: BoardCourt
  session: BoardSession
  onClose: () => void
  onDone: (message: string) => void
}) {
  const tz = board.time_zone
  const [draft, setDraft] = useState({ party_display_name: '', phone_number: '', participant_count: String(court.capacity_count ?? 4), is_paid: false })
  const book = useAction(() =>
    operatorFetch<{ booking: BoardBooking }>(
      '/api/v1/court/board/walk-in',
      jsonBody({
        session_id: session.session_id,
        resource_id: court.resource_id,
        party_display_name: draft.party_display_name,
        phone_number: draft.phone_number || null,
        participant_count: Number(draft.participant_count),
        is_paid: draft.is_paid,
      }),
    ),
  )
  const time = formatTimeRange(session.starts_at, session.ends_at, tz)
  return (
    <Dialog
      open
      title={`Walk-in on ${court.display_name}`}
      onClose={onClose}
      footer={
        <>
          <Button tone="secondary" onClick={onClose}>
            Close
          </Button>
          <Button type="submit" form="court-walk-in-form" disabled={book.is_pending}>
            {book.is_pending ? 'Booking…' : 'Book walk-in'}
          </Button>
        </>
      }
    >
      <p>
        <strong>{time}</strong> · {formatMoney(session.price_amount)}
      </p>
      <form
        id="court-walk-in-form"
        className="form"
        onSubmit={async (event: FormEvent) => {
          event.preventDefault()
          const answer = await book.run()
          if (answer) onDone(`Walk-in booked: ${draft.party_display_name} on ${court.display_name}, ${time}.`)
        }}
      >
        <ErrorAlert error={book.error} onDismiss={book.clearError} />
        <TextInput label="Player name" required autoFocus maxLength={120} value={draft.party_display_name} onChange={(event) => setDraft({ ...draft, party_display_name: event.target.value })} />
        <div className="form__row">
          <TextInput label="Phone (optional)" type="tel" maxLength={40} value={draft.phone_number} onChange={(event) => setDraft({ ...draft, phone_number: event.target.value })} />
          <TextInput label="Players" type="number" min={1} max={40} required value={draft.participant_count} onChange={(event) => setDraft({ ...draft, participant_count: event.target.value })} />
        </div>
        <Checkbox label="Paid at the counter" checked={draft.is_paid} onChange={(event) => setDraft({ ...draft, is_paid: event.target.checked })} />
      </form>
    </Dialog>
  )
}

function ClosureDialog({ board, closure, is_manager, onClose, onDone }: { board: Board; closure: Closure; is_manager: boolean; onClose: () => void; onDone: (message: string) => void }) {
  const remove = useAction(() => operatorFetch(`/api/v1/court/closure/${closure.closure_id}`, { method: 'DELETE' }))
  const where = closure.is_site_wide ? 'the whole venue' : (closure.court_display_name ?? 'this court')
  return (
    <Dialog
      open
      title={closure.reason}
      onClose={onClose}
      footer={
        <>
          <Button tone="secondary" onClick={onClose}>
            Close
          </Button>
          {is_manager && (
            <Button
              tone="danger"
              disabled={remove.is_pending}
              onClick={async () => {
                const answer = await remove.run()
                if (answer) onDone(`Block on ${where} removed. Its slots are on sale again.`)
              }}
            >
              {remove.is_pending ? 'Removing…' : 'Remove block'}
            </Button>
          )}
        </>
      }
    >
      <ErrorAlert error={remove.error} onDismiss={remove.clearError} />
      <p>
        {closure.is_site_wide ? 'The whole venue' : closure.court_display_name} is closed {formatTimeRange(closure.starts_at, closure.ends_at, board.time_zone)}. No slot inside this window is sold.
      </p>
    </Dialog>
  )
}

function MaintenanceDialog({ board, resource_id, onClose, onDone }: { board: Board; resource_id?: string; onClose: () => void; onDone: (message: string) => void }) {
  const tz = board.time_zone
  const now_hour = Math.min(22, Math.max(Math.floor(minuteFromDayStart(new Date().toISOString(), board.date, tz) / 60) + 1, 6))
  const pad = (hour: number) => `${String(hour).padStart(2, '0')}:00`
  const [draft, setDraft] = useState({
    resource_id: resource_id ?? board.court[0]?.resource_id ?? '',
    starts_local: pad(now_hour),
    ends_local: pad(now_hour + 1),
    reason: 'Maintenance',
  })
  const block = useAction(() =>
    operatorFetch<{ closure: Closure }>(
      '/api/v1/court/board/maintenance',
      jsonBody({
        resource_id: draft.resource_id,
        starts_at: zonedIso(board.date, draft.starts_local, tz),
        ends_at: zonedIso(draft.ends_local === '00:00' ? addDay(board.date, 1) : board.date, draft.ends_local, tz),
        reason: draft.reason,
      }),
    ),
  )
  const court = board.court.find((one) => one.resource_id === draft.resource_id)
  return (
    <Dialog
      open
      title="Block a court for maintenance"
      onClose={onClose}
      footer={
        <>
          <Button tone="secondary" onClick={onClose}>
            Close
          </Button>
          <Button type="submit" form="court-maintenance-form" disabled={block.is_pending}>
            {block.is_pending ? 'Blocking…' : 'Block court'}
          </Button>
        </>
      }
    >
      <form
        id="court-maintenance-form"
        className="form"
        onSubmit={async (event: FormEvent) => {
          event.preventDefault()
          const answer = await block.run()
          if (answer) onDone(`${court?.display_name ?? 'Court'} blocked ${formatTimeRange(answer.closure.starts_at, answer.closure.ends_at, tz)}: ${answer.closure.reason}.`)
        }}
      >
        <p className="muted">{formatLongDate(board.date)}. A block cannot cover an existing booking — move or cancel it first.</p>
        <ErrorAlert error={block.error} onDismiss={block.clearError} />
        <SelectInput
          label="Court"
          value={draft.resource_id}
          onChange={(event) => setDraft({ ...draft, resource_id: event.target.value })}
          option={board.court.map((one) => ({ value: one.resource_id, label: one.display_name }))}
        />
        <div className="form__row">
          <TextInput label="From" type="time" required value={draft.starts_local} onChange={(event) => setDraft({ ...draft, starts_local: event.target.value })} />
          <TextInput label="Until" type="time" required value={draft.ends_local} onChange={(event) => setDraft({ ...draft, ends_local: event.target.value })} />
        </div>
        <TextInput label="Reason" required maxLength={160} value={draft.reason} onChange={(event) => setDraft({ ...draft, reason: event.target.value })} />
      </form>
    </Dialog>
  )
}
