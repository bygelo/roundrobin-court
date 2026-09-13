// Operator → Open play. A session list (today first) and, for the selected
// session, the live console: courts, one "Fill free courts" action, up next,
// roster with waitlist, add player, the fairness rule, and the share panel.

import { ArrowsClockwise, Copy, Flag, LinkSimple, Plus, Timer, UserPlus } from '@phosphor-icons/react'
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
  Stat,
  TextInput,
  type BadgeTone,
} from '../../component/ui.tsx'
import { formatDate, formatTime, formatTimeRange, toDateInput } from '../../format.ts'
import { useAction, useInterval, useResource } from '../../hook.ts'
import type { PageProp } from '../../registry.ts'
import { navigate, useQuery } from '../../route.tsx'
import { useOperator } from '../../session.tsx'
import './play.css'

// ---- API shapes ------------------------------------------------------------

type FormatCode = 'doubles' | 'singles'
type SessionStatus = 'draft' | 'open' | 'closed'
type EntryStatus = 'registered' | 'waiting' | 'playing' | 'waitlisted' | 'no_show' | 'left' | 'done'

type PlaySession = {
  play_session_id: string
  display_name: string
  starts_at: string
  ends_at: string
  format_code: FormatCode
  seat_count: number
  capacity_count: number
  public_token: string
  join_code: string
  status_code: SessionStatus
}

type SessionSummary = PlaySession & {
  court_count: number
  active_count: number
  playing_count: number
  waitlisted_count: number
  spot_count: number
  is_today: boolean
}

type Player = { play_entry_id: string; display_name: string }

type CourtState = {
  resource_id: string
  display_name: string
  position: number
  game: null | {
    play_game_id: string
    started_at: string
    elapsed_second: number
    team: { team_number: number; player: Player[] }[]
  }
}

type RosterEntry = Player & {
  status_code: EntryStatus
  checked_in_at: string | null
  game_count: number
  credit_count: number
  last_finished_at: string | null
  queue_position: number | null
}

type WaitlistEntry = Player & { waitlist_position: number; checked_in_at: string | null }

type SessionState = {
  play_session: PlaySession
  fairness_rule: string
  now: string
  court: CourtState[]
  up_next: Player[]
  queue: (Player & { position: number })[]
  roster: RosterEntry[]
  waitlist: WaitlistEntry[]
  active_count: number
  spot_count: number
  waiting_count: number
  free_court_count: number
  finished_game_count: number
  can_rotate: boolean
}

type EntryResult = { play_entry_id: string; display_name: string; status_code: EntryStatus; waitlist_position: number | null }

type Court = { resource_id: string; display_name: string; site_display_name: string }

// ---- small helpers ---------------------------------------------------------

const STATUS_BADGE: Record<EntryStatus, { tone: BadgeTone; label: string }> = {
  registered: { tone: 'neutral', label: 'Not arrived' },
  waiting: { tone: 'info', label: 'Waiting' },
  playing: { tone: 'success', label: 'On court' },
  waitlisted: { tone: 'caution', label: 'Waitlist' },
  no_show: { tone: 'danger', label: 'No-show' },
  left: { tone: 'neutral', label: 'Left' },
  done: { tone: 'neutral', label: 'Done' },
}

const SESSION_BADGE: Record<SessionStatus, { tone: BadgeTone; label: string }> = {
  draft: { tone: 'neutral', label: 'Draft' },
  open: { tone: 'success', label: 'Open' },
  closed: { tone: 'neutral', label: 'Closed' },
}

const ROSTER_ORDER: EntryStatus[] = ['playing', 'waiting', 'registered', 'no_show', 'left', 'done', 'waitlisted']

function formatElapsed(second: number): string {
  const safe = Math.max(0, Math.floor(second))
  const hour = Math.floor(safe / 3600)
  const minute = Math.floor((safe % 3600) / 60)
  const rest = String(safe % 60).padStart(2, '0')
  return hour > 0 ? `${hour}:${String(minute).padStart(2, '0')}:${rest}` : `${minute}:${rest}`
}

function teamLabel(team: { player: Player[] }): string {
  return team.player.map((one) => one.display_name).join(' & ')
}

function useClock(millisecond = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useInterval(() => setNow(Date.now()), millisecond)
  return now
}

// ---- page ------------------------------------------------------------------

export default function Page(_prop: PageProp) {
  const { can } = useOperator()
  const can_manage = can('play.manage')
  const query = useQuery()
  const selected_id = query.get('session') ?? undefined
  const session = useResource(() => operatorFetch<{ play_session: SessionSummary[] }>('/api/v1/play/session').then((body) => body.play_session), [])
  const [is_creating, setCreating] = useState(false)

  const select = (id: string | undefined) => navigate(id ? `/operator/play?session=${id}` : '/operator/play')

  return (
    <>
      <PageHeader
        eyebrow="Play"
        title="Open play"
        description="Check players in, fill courts fairly with one press, and share a live board players can follow on their phones or the lounge TV."
        action={
          can_manage && (
            <Button icon={<Plus size={18} aria-hidden />} onClick={() => setCreating(true)}>
              New session
            </Button>
          )
        }
      />
      <ResourceView resource={session}>
        {(list) =>
          list.length === 0 ? (
            <EmptyState
              title="No open-play sessions yet"
              description="Create tonight's session, choose the courts, and players can start checking in."
              action={
                can_manage && (
                  <Button icon={<Plus size={18} aria-hidden />} onClick={() => setCreating(true)}>
                    Create a session
                  </Button>
                )
              }
            />
          ) : (
            <div className="play-layout">
              <SessionList session={list} selected_id={selected_id} onSelect={select} />
              {selected_id ? (
                <Console key={selected_id} play_session_id={selected_id} can_manage={can_manage} onChanged={session.reload} />
              ) : (
                <EmptyState title="Choose a session" description="Pick a session to run its courts, roster, and live board." />
              )}
            </div>
          )
        }
      </ResourceView>
      {is_creating && (
        <CreateSessionDialog
          onClose={() => setCreating(false)}
          onCreated={(created) => {
            setCreating(false)
            session.reload()
            select(created.play_session_id)
          }}
        />
      )}
    </>
  )
}

function SessionList({
  session,
  selected_id,
  onSelect,
}: {
  session: SessionSummary[]
  selected_id: string | undefined
  onSelect: (id: string) => void
}) {
  const today = session.filter((one) => one.is_today)
  const other = session.filter((one) => !one.is_today)
  const item = (one: SessionSummary) => (
    <button
      key={one.play_session_id}
      type="button"
      className={`play-session-item ${one.play_session_id === selected_id ? 'is-active' : ''}`}
      aria-current={one.play_session_id === selected_id ? 'true' : undefined}
      onClick={() => onSelect(one.play_session_id)}
    >
      <span className="row row--between">
        <span className="play-session-item__name">{one.display_name}</span>
        <Badge tone={SESSION_BADGE[one.status_code].tone}>{SESSION_BADGE[one.status_code].label}</Badge>
      </span>
      <span className="play-session-item__meta">
        {formatDate(one.starts_at)} · {formatTimeRange(one.starts_at, one.ends_at)}
      </span>
      <span className="play-session-item__meta">
        {one.court_count} {one.court_count === 1 ? 'court' : 'courts'} · {one.active_count}/{one.capacity_count} players
        {one.waitlisted_count > 0 ? ` · ${one.waitlisted_count} waitlisted` : ''}
      </span>
    </button>
  )
  return (
    <nav className="play-session-list" aria-label="Open-play sessions">
      {today.length > 0 && <p className="play-session-list__group">Today</p>}
      {today.map(item)}
      {other.length > 0 && <p className="play-session-list__group">Other days</p>}
      {other.map(item)}
    </nav>
  )
}

// ---- create ----------------------------------------------------------------

function CreateSessionDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (session: PlaySession) => void }) {
  const court = useResource(() => operatorFetch<{ court: Court[] }>('/api/v1/play/court').then((body) => body.court), [])
  const [display_name, setName] = useState('Open Play')
  const [date, setDate] = useState(() => toDateInput(new Date()))
  const [start_time, setStart] = useState('18:00')
  const [end_time, setEnd] = useState('22:00')
  const [format_code, setFormat] = useState<FormatCode>('doubles')
  const [capacity_count, setCapacity] = useState('24')
  const [chosen, setChosen] = useState<string[] | undefined>()

  useEffect(() => {
    if (court.data && chosen === undefined) setChosen(court.data.map((one) => one.resource_id))
  }, [court.data, chosen])

  const create = useAction(async () => {
    // Venue time is Asia/Manila, which keeps +08:00 all year.
    const body = await operatorFetch<{ play_session: PlaySession }>(
      '/api/v1/play/session',
      jsonBody({
        display_name,
        starts_at: `${date}T${start_time}:00+08:00`,
        ends_at: `${date}T${end_time}:00+08:00`,
        format_code,
        capacity_count: Number(capacity_count),
        resource_id: chosen ?? [],
      }),
    )
    onCreated(body.play_session)
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    void create.run()
  }

  const seat = format_code === 'doubles' ? 4 : 2
  const selected_count = chosen?.length ?? 0

  return (
    <Dialog
      open
      title="New open-play session"
      onClose={onClose}
      footer={
        <>
          <Button tone="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="play-create" disabled={create.is_pending || selected_count === 0}>
            {create.is_pending ? 'Creating…' : 'Create session'}
          </Button>
        </>
      }
    >
      <form id="play-create" className="form" onSubmit={submit}>
        <ErrorAlert error={create.error} onDismiss={create.clearError} />
        <TextInput label="Session name" value={display_name} onChange={(event) => setName(event.target.value)} required maxLength={80} />
        <div className="form__row">
          <TextInput label="Date" type="date" value={date} onChange={(event) => setDate(event.target.value)} required />
          <TextInput label="Starts" type="time" value={start_time} onChange={(event) => setStart(event.target.value)} required />
          <TextInput label="Ends" type="time" value={end_time} onChange={(event) => setEnd(event.target.value)} required />
        </div>
        <div className="form__row">
          <SelectInput
            label="Format"
            value={format_code}
            onChange={(event) => setFormat(event.target.value as FormatCode)}
            option={[
              { value: 'doubles', label: 'Doubles — 4 a court' },
              { value: 'singles', label: 'Singles — 2 a court' },
            ]}
          />
          <TextInput
            label="Player limit"
            type="number"
            min={1}
            max={500}
            value={capacity_count}
            onChange={(event) => setCapacity(event.target.value)}
            hint={selected_count > 0 ? `${selected_count * seat} play at once on ${selected_count} ${selected_count === 1 ? 'court' : 'courts'}` : undefined}
            required
          />
        </div>
        <ResourceView resource={court}>
          {(list) =>
            list.length === 0 ? (
              <Alert severity="caution" title="No courts yet">
                Add your courts in Venue setup, then come back to create open play.
                <div>
                  <ButtonLink to="/operator/venue" tone="secondary" size="sm">
                    Go to Venue setup
                  </ButtonLink>
                </div>
              </Alert>
            ) : (
              <fieldset className="play-court-choice">
                <legend>Courts, in fill order</legend>
                {list.map((one) => (
                  <Checkbox
                    key={one.resource_id}
                    label={one.display_name}
                    checked={chosen?.includes(one.resource_id) ?? false}
                    onChange={(event) =>
                      setChosen((current = []) =>
                        event.target.checked ? [...current, one.resource_id] : current.filter((each) => each !== one.resource_id),
                      )
                    }
                  />
                ))}
              </fieldset>
            )
          }
        </ResourceView>
      </form>
    </Dialog>
  )
}

// ---- console ---------------------------------------------------------------

type Notice = { severity: 'success' | 'info' | 'caution'; title: string; body?: string }

function Console({ play_session_id, can_manage, onChanged }: { play_session_id: string; can_manage: boolean; onChanged: () => void }) {
  const state = useResource(
    () => operatorFetch<{ state: SessionState }>(`/api/v1/play/session/${play_session_id}`).then((body) => body.state),
    [play_session_id],
  )
  useInterval(state.reload, 10_000)
  const [notice, setNotice] = useState<Notice>()

  const after = (next: Notice | undefined) => {
    setNotice(next)
    state.reload()
    onChanged()
  }

  return (
    <div className="play-console">
      {notice && (
        <Alert severity={notice.severity} title={notice.title} onDismiss={() => setNotice(undefined)}>
          {notice.body}
        </Alert>
      )}
      <ResourceView resource={state}>
        {(data) => <ConsoleBody data={data} can_manage={can_manage} after={after} is_refresh_failing={Boolean(state.error)} />}
      </ResourceView>
    </div>
  )
}

function ConsoleBody({
  data,
  can_manage,
  after,
  is_refresh_failing,
}: {
  data: SessionState
  can_manage: boolean
  after: (notice: Notice | undefined) => void
  is_refresh_failing: boolean
}) {
  const session = data.play_session
  const is_open = session.status_code === 'open'
  const [confirm_close, setConfirmClose] = useState(false)
  const [finishing, setFinishing] = useState<CourtState>()
  const [removing, setRemoving] = useState<Player & { is_waitlisted: boolean }>()
  const now = useClock()
  // Server clock minus client clock, so every timer agrees with the server.
  const [offset] = useState(() => Date.parse(data.now) - Date.now())

  const rotate = useAction(async () => {
    const body = await operatorFetch<{ created_game: { resource_id: string }[]; state: SessionState }>(
      `/api/v1/play/session/${session.play_session_id}/rotate`,
      { method: 'POST' },
    )
    const name = body.created_game.map((one) => body.state.court.find((each) => each.resource_id === one.resource_id)?.display_name ?? 'a court')
    after(
      name.length > 0
        ? { severity: 'success', title: `Called ${name.length} ${name.length === 1 ? 'group' : 'groups'} to court`, body: name.join(', ') }
        : {
            severity: 'info',
            title: 'No court filled',
            body: `A court needs a free slot and ${session.seat_count} waiting players.`,
          },
    )
  })

  const setStatus = useAction(async (status: 'open' | 'closed') => {
    await operatorFetch(`/api/v1/play/session/${session.play_session_id}/${status === 'open' ? 'open' : 'close'}`, { method: 'POST' })
    setConfirmClose(false)
    after({ severity: 'success', title: status === 'open' ? 'Session open — players can check in' : 'Session closed' })
  })

  const entryAction = useAction(async (play_entry_id: string, action: 'check-in' | 'no-show' | 'remove', display_name: string) => {
    const body = await operatorFetch<{ promoted_entry?: EntryResult | null; is_replay?: boolean }>(`/api/v1/play/entry/${play_entry_id}/${action}`, {
      method: 'POST',
    })
    setRemoving(undefined)
    const promoted = body.promoted_entry
    const verb = action === 'check-in' ? 'checked in' : action === 'no-show' ? 'marked as a no-show' : 'removed'
    after({
      severity: 'success',
      title: `${display_name} ${verb}`,
      ...(promoted ? { body: `${promoted.display_name} moved off the waitlist${promoted.status_code === 'waiting' ? ' and into the queue' : ''}.` } : {}),
    })
  })

  const live_count = data.court.filter((one) => one.game).length
  const rotate_hint = !is_open
    ? 'Open the session to fill courts.'
    : data.free_court_count === 0
      ? 'Every court is busy. Finish a game to free one.'
      : data.waiting_count < session.seat_count
        ? `Waiting for ${session.seat_count - data.waiting_count} more ${session.seat_count - data.waiting_count === 1 ? 'player' : 'players'} to fill a court.`
        : `${data.free_court_count} free ${data.free_court_count === 1 ? 'court' : 'courts'} ready to fill.`

  const roster = [...data.roster].sort(
    (left, right) =>
      ROSTER_ORDER.indexOf(left.status_code) - ROSTER_ORDER.indexOf(right.status_code) ||
      (left.queue_position ?? 999) - (right.queue_position ?? 999) ||
      left.display_name.localeCompare(right.display_name),
  )

  return (
    <>
      <ErrorAlert error={rotate.error ?? setStatus.error ?? entryAction.error} onDismiss={() => { rotate.clearError(); setStatus.clearError(); entryAction.clearError() }} />
      {is_refresh_failing && <Alert severity="caution">Could not refresh just now. Showing the last known state; retrying every 10 seconds.</Alert>}

      <section className="play-console__head" aria-label="Session">
        <div className="play-console__title">
          <h2>{session.display_name}</h2>
          <div className="row">
            <Badge tone={SESSION_BADGE[session.status_code].tone}>{SESSION_BADGE[session.status_code].label}</Badge>
            <Badge tone="info">{session.format_code === 'doubles' ? 'Doubles' : 'Singles'}</Badge>
            <span className="muted">
              {formatDate(session.starts_at)} · {formatTimeRange(session.starts_at, session.ends_at)}
            </span>
          </div>
        </div>
        {can_manage && (
          <div className="play-console__action">
            {session.status_code === 'draft' && (
              <Button tone="secondary" onClick={() => void setStatus.run('open')} disabled={setStatus.is_pending}>
                Open session
              </Button>
            )}
            {is_open && (
              <Button tone="quiet" icon={<Flag size={18} aria-hidden />} onClick={() => setConfirmClose(true)}>
                Close session
              </Button>
            )}
            <Button
              size="lg"
              icon={<ArrowsClockwise size={20} aria-hidden />}
              onClick={() => void rotate.run()}
              disabled={!data.can_rotate || rotate.is_pending}
              aria-describedby="play-rotate-hint"
            >
              {rotate.is_pending ? 'Filling…' : 'Fill free courts'}
            </Button>
          </div>
        )}
      </section>
      <p id="play-rotate-hint" className="muted">
        {rotate_hint}
      </p>

      <div className="play-stat-row">
        <Stat label="On court" value={live_count} hint={`of ${data.court.length} ${data.court.length === 1 ? 'court' : 'courts'}`} />
        <Stat label="Waiting" value={data.waiting_count} />
        <Stat label="Spots left" value={data.spot_count} hint={`limit ${session.capacity_count}`} />
        <Stat label="Waitlist" value={data.waitlist.length} />
        <Stat label="Games played" value={data.finished_game_count} />
      </div>

      <section aria-labelledby="play-court-heading" className="stack">
        <h3 id="play-court-heading">Courts</h3>
        <div className="play-court-grid">
          {data.court.map((one) => (
            <CourtCard key={one.resource_id} court={one} now={now + offset} can_manage={can_manage && is_open} onFinish={() => setFinishing(one)} />
          ))}
        </div>
      </section>

      <div className="grid--2">
        <Card title="Up next" description="The exact group the next free court will call.">
          {data.queue.length === 0 ? (
            <EmptyState title="Nobody waiting" description="Check players in or add walk-ins below." />
          ) : (
            <ol className="play-queue">
              {data.queue.map((one) => (
                <li key={one.play_entry_id} className={one.position <= session.seat_count ? 'is-next' : ''}>
                  <span className="play-position" aria-hidden>
                    {one.position}
                  </span>
                  <span>{one.display_name}</span>
                  {one.position <= session.seat_count && <span className="visually-hidden">(up next)</span>}
                </li>
              ))}
            </ol>
          )}
        </Card>
        <div className="stack">
          {can_manage && is_open && <AddPlayer play_session_id={session.play_session_id} after={after} spot_count={data.spot_count} />}
          <SharePanel session={session} />
        </div>
      </div>

      <Card title="Roster" description={`${data.active_count} of ${session.capacity_count} spots taken`}>
        {roster.length === 0 ? (
          <EmptyState title="No players yet" description="Add players as they arrive, or share the link so they can check themselves in." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Player</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="number">Games</th>
                  <th scope="col">Checked in</th>
                  <th scope="col" className="number">Queue</th>
                  {can_manage && is_open && <th scope="col"><span className="visually-hidden">Actions</span></th>}
                </tr>
              </thead>
              <tbody>
                {roster.map((one) => (
                  <tr key={one.play_entry_id}>
                    <td>{one.display_name}</td>
                    <td>
                      <Badge tone={STATUS_BADGE[one.status_code].tone}>{STATUS_BADGE[one.status_code].label}</Badge>
                    </td>
                    <td className="number">
                      {one.game_count}
                      {one.credit_count > 0 && <span className="muted" title="Credited on late arrival"> +{one.credit_count}</span>}
                    </td>
                    <td>{one.checked_in_at ? formatTime(one.checked_in_at) : '—'}</td>
                    <td className="number">{one.queue_position ? `#${one.queue_position}` : '—'}</td>
                    {can_manage && is_open && (
                      <td>
                        <div className="play-row-action">
                          {one.status_code === 'registered' && (
                            <>
                              <Button size="sm" tone="secondary" onClick={() => void entryAction.run(one.play_entry_id, 'check-in', one.display_name)}>
                                Check in
                              </Button>
                              <Button size="sm" tone="quiet" onClick={() => void entryAction.run(one.play_entry_id, 'no-show', one.display_name)}>
                                No-show
                              </Button>
                            </>
                          )}
                          {(one.status_code === 'registered' || one.status_code === 'waiting' || one.status_code === 'playing') && (
                            <Button size="sm" tone="danger" onClick={() => setRemoving({ ...one, is_waitlisted: false })}>
                              Remove
                            </Button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Waitlist" description="When a spot opens, the first person here moves in automatically.">
        {data.waitlist.length === 0 ? (
          <p className="muted">Nobody on the waitlist.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col" className="number">#</th>
                  <th scope="col">Player</th>
                  <th scope="col">At the venue</th>
                  {can_manage && is_open && <th scope="col"><span className="visually-hidden">Actions</span></th>}
                </tr>
              </thead>
              <tbody>
                {data.waitlist.map((one) => (
                  <tr key={one.play_entry_id}>
                    <td className="number">{one.waitlist_position}</td>
                    <td>{one.display_name}</td>
                    <td>{one.checked_in_at ? <Badge tone="info">Here since {formatTime(one.checked_in_at)}</Badge> : <span className="muted">Not yet</span>}</td>
                    {can_manage && is_open && (
                      <td>
                        <div className="play-row-action">
                          {!one.checked_in_at && (
                            <Button size="sm" tone="secondary" onClick={() => void entryAction.run(one.play_entry_id, 'check-in', one.display_name)}>
                              Mark here
                            </Button>
                          )}
                          <Button size="sm" tone="danger" onClick={() => setRemoving({ ...one, is_waitlisted: true })}>
                            Remove
                          </Button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="How the order is decided">
        <p>{data.fairness_rule}</p>
      </Card>

      {finishing?.game && (
        <FinishDialog
          court={finishing}
          onClose={() => setFinishing(undefined)}
          onFinished={() => {
            setFinishing(undefined)
            after({ severity: 'success', title: `${finishing.display_name} is free`, body: 'Its players are back in the queue. Press Fill free courts to call the next group.' })
          }}
        />
      )}

      <Dialog
        open={Boolean(removing)}
        title={removing ? `Remove ${removing.display_name}?` : 'Remove player'}
        onClose={() => setRemoving(undefined)}
        footer={
          <>
            <Button tone="quiet" onClick={() => setRemoving(undefined)}>
              Keep
            </Button>
            <Button
              tone="danger"
              disabled={entryAction.is_pending}
              onClick={() => removing && void entryAction.run(removing.play_entry_id, 'remove', removing.display_name)}
            >
              Remove player
            </Button>
          </>
        }
      >
        <p>
          {removing?.is_waitlisted
            ? 'They come off the waitlist. Nobody else moves.'
            : 'They leave the session. If they are on court, the game carries on and they are not called again. The first person on the waitlist takes their spot.'}
        </p>
      </Dialog>

      <Dialog
        open={confirm_close}
        title={`Close ${session.display_name}?`}
        onClose={() => setConfirmClose(false)}
        footer={
          <>
            <Button tone="quiet" onClick={() => setConfirmClose(false)}>
              Keep open
            </Button>
            <Button tone="danger" disabled={setStatus.is_pending} onClick={() => void setStatus.run('closed')}>
              Close session
            </Button>
          </>
        }
      >
        <p>Games on court are ended, nobody else can check in, and the live board shows the session as finished. This cannot be undone.</p>
      </Dialog>
    </>
  )
}

function CourtCard({ court, now, can_manage, onFinish }: { court: CourtState; now: number; can_manage: boolean; onFinish: () => void }) {
  if (!court.game) {
    return (
      <article className="play-court play-court--free" aria-label={`${court.display_name}, free`}>
        <div className="play-court__head">
          <span className="play-court__name">{court.display_name}</span>
          <Badge>Free</Badge>
        </div>
        <p className="muted">Ready for the next group.</p>
      </article>
    )
  }
  const [one, two] = court.game.team
  return (
    <article className="play-court" aria-label={`${court.display_name}, playing`}>
      <div className="play-court__head">
        <span className="play-court__name">{court.display_name}</span>
        <span className="play-timer" title="Time on court">
          <Timer size={16} aria-hidden />
          <span className="visually-hidden">Playing for </span>
          {formatElapsed((now - Date.parse(court.game.started_at)) / 1000)}
        </span>
      </div>
      {one && <p className="play-team">{teamLabel(one)}</p>}
      <p className="play-versus">vs</p>
      {two && <p className="play-team">{teamLabel(two)}</p>}
      {can_manage && (
        <Button tone="secondary" size="sm" onClick={onFinish}>
          Finish game
        </Button>
      )}
    </article>
  )
}

function FinishDialog({ court, onClose, onFinished }: { court: CourtState; onClose: () => void; onFinished: () => void }) {
  const [score_text, setScore] = useState('')
  const finish = useAction(async () => {
    await operatorFetch(`/api/v1/play/game/${court.game!.play_game_id}/finish`, jsonBody({ score_text: score_text.trim() || null }))
    onFinished()
  })
  return (
    <Dialog
      open
      title={`Finish the game on ${court.display_name}`}
      onClose={onClose}
      footer={
        <>
          <Button tone="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="play-finish" disabled={finish.is_pending}>
            {finish.is_pending ? 'Finishing…' : 'Finish game'}
          </Button>
        </>
      }
    >
      <form
        id="play-finish"
        className="form"
        onSubmit={(event) => {
          event.preventDefault()
          void finish.run()
        }}
      >
        <ErrorAlert error={finish.error} onDismiss={finish.clearError} />
        {court.game?.team.map((team) => (
          <p key={team.team_number}>
            <strong>Team {team.team_number}:</strong> {teamLabel(team)}
          </p>
        ))}
        <TextInput label="Score (optional)" placeholder="11–7" value={score_text} maxLength={60} onChange={(event) => setScore(event.target.value)} />
      </form>
    </Dialog>
  )
}

function AddPlayer({ play_session_id, after, spot_count }: { play_session_id: string; after: (notice: Notice) => void; spot_count: number }) {
  const [display_name, setName] = useState('')
  const [is_checked_in, setCheckedIn] = useState(true)
  const add = useAction(async () => {
    const body = await operatorFetch<{ entry: EntryResult }>(
      `/api/v1/play/session/${play_session_id}/entry`,
      jsonBody({ display_name, is_checked_in }),
    )
    setName('')
    const entry = body.entry
    after(
      entry.status_code === 'waitlisted'
        ? { severity: 'caution', title: `${entry.display_name} is on the waitlist`, body: `Position ${entry.waitlist_position}. They move in when a spot opens.` }
        : { severity: 'success', title: `${entry.display_name} added`, body: entry.status_code === 'waiting' ? 'Checked in and in the queue.' : 'On the list, not arrived yet.' },
    )
  })
  return (
    <Card title="Add a player" description={spot_count > 0 ? `${spot_count} ${spot_count === 1 ? 'spot' : 'spots'} left` : 'Full — new players join the waitlist'}>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault()
          void add.run()
        }}
      >
        <ErrorAlert error={add.error} onDismiss={add.clearError} />
        <TextInput label="Player name" placeholder="First and last name" value={display_name} onChange={(event) => setName(event.target.value)} required maxLength={80} autoComplete="off" />
        <Checkbox label="Here now — put them in the queue" checked={is_checked_in} onChange={(event) => setCheckedIn(event.target.checked)} />
        <div className="form__action">
          <Button type="submit" tone="secondary" icon={<UserPlus size={18} aria-hidden />} disabled={add.is_pending || display_name.trim() === ''}>
            {add.is_pending ? 'Adding…' : 'Add player'}
          </Button>
        </div>
      </form>
    </Card>
  )
}

function SharePanel({ session }: { session: PlaySession }) {
  const link = `${window.location.origin}/play/${session.public_token}`
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2500)
    } catch {
      setCopied(false)
    }
  }
  return (
    <Card title="Share the live board" description="Players follow courts and up next on their phones; put it on the lounge TV too.">
      <div className="stack">
        {copied && <Alert severity="success">Link copied.</Alert>}
        <p className="play-share__link mono">{link}</p>
        <div className="row">
          <Button tone="secondary" size="sm" icon={<Copy size={16} aria-hidden />} onClick={() => void copy()}>
            Copy link
          </Button>
          <a className="button button--quiet button--sm" href={link} target="_blank" rel="noreferrer">
            <LinkSimple size={16} aria-hidden />
            Open board
          </a>
        </div>
        <div>
          <p className="eyebrow">Join code for self check-in</p>
          <p className="play-share__code" aria-label={`Join code ${session.join_code.split('').join(' ')}`}>
            {session.join_code}
          </p>
          <p className="muted">Post it at the desk. Players need it to check themselves in from the link.</p>
        </div>
      </div>
    </Card>
  )
}
