// /play/:token — the live open-play board. Bare surface: a phone at the court
// and the lounge TV open the same link. Refreshes every 5 seconds; players can
// check themselves in with the join code posted at the desk.

import { useEffect, useState, type FormEvent } from 'react'
import { ApiError, jsonBody, publicFetch } from '../../api.ts'
import { Alert, Badge, Button, EmptyState, ErrorAlert, Loading, TextInput } from '../../component/ui.tsx'
import { formatTimeRange } from '../../format.ts'
import { useAction, useInterval, useResource } from '../../hook.ts'
import type { PageProp } from '../../registry.ts'
import './play.css'

type LivePlayer = { display_name: string }

type PublicPlay = {
  venue_display_name: string
  display_name: string
  starts_at: string
  ends_at: string
  format_code: 'doubles' | 'singles'
  status_code: 'open' | 'closed'
  fairness_rule: string
  now: string
  court: { display_name: string; started_at: string | null; team: { player: LivePlayer[] }[] }[]
  up_next: LivePlayer[]
  waiting_count: number
  waitlisted_count: number
  spot_count: number
}

type CheckIn = {
  display_name: string
  status_code: 'registered' | 'waiting' | 'playing' | 'waitlisted'
  waitlist_position: number | null
  queue_position: number | null
  is_replay: boolean
}

/** Same shortening the server applies, so a player can find themselves on the board. */
function shortName(display_name: string): string {
  const part = display_name.trim().split(/\s+/).filter(Boolean)
  if (part.length <= 1) return part[0] ?? ''
  return `${part[0]} ${part[part.length - 1]!.charAt(0).toUpperCase()}.`
}

function minuteOnCourt(started_at: string, now: number): string {
  const minute = Math.max(0, Math.floor((now - Date.parse(started_at)) / 60_000))
  return minute === 0 ? 'just started' : `${minute} min`
}

export default function Page({ param }: PageProp) {
  const token = param['token'] ?? ''
  const storage_key = `court.play.${token}`
  const play = useResource(
    () => publicFetch<{ play: PublicPlay }>(`/public/play/${encodeURIComponent(token)}`).then((body) => body.play),
    [token],
  )
  useInterval(play.reload, 5000)
  const [clock, setClock] = useState(() => Date.now())
  useInterval(() => setClock(Date.now()), 15_000)
  const [me, setMe] = useState<string>(() => {
    try {
      return window.localStorage.getItem(storage_key) ?? ''
    } catch {
      return ''
    }
  })

  useEffect(() => {
    if (play.data) document.title = `${play.data.display_name} · ${play.data.venue_display_name}`
  }, [play.data])

  if (play.data === undefined) {
    if (play.error instanceof ApiError && play.error.status === 404) {
      return (
        <main className="play-live">
          <div className="play-live__inner">
            <EmptyState title="This open-play link isn't active" description="Ask the front desk for tonight's link or scan the code at the courts." />
          </div>
        </main>
      )
    }
    if (play.error) {
      return (
        <main className="play-live">
          <div className="play-live__inner">
            <Alert severity="danger" title="Could not load open play">
              <p>{play.error.message}</p>
              <Button tone="secondary" size="sm" onClick={play.reload}>
                Try again
              </Button>
            </Alert>
          </div>
        </main>
      )
    }
    return <Loading label="Loading the courts…" />
  }

  const data = play.data
  const offset = Date.parse(data.now) - Date.now()
  const now = clock + offset
  const my_name = me ? shortName(me) : ''
  const my_court = my_name ? data.court.find((one) => one.team.some((team) => team.player.some((each) => each.display_name === my_name))) : undefined
  const my_next = my_name ? data.up_next.findIndex((one) => one.display_name === my_name) : -1
  const is_open = data.status_code === 'open'

  return (
    <main className="play-live">
      <header className="play-live__band">
        <div className="play-live__band-inner">
          <p className="eyebrow">{data.venue_display_name}</p>
          <h1>{data.display_name}</h1>
          <div className="play-live__meta">
            <span>{formatTimeRange(data.starts_at, data.ends_at)}</span>
            <Badge tone={is_open ? 'success' : 'neutral'}>{is_open ? 'Open play on now' : 'Session ended'}</Badge>
            <span>{data.format_code === 'doubles' ? 'Doubles' : 'Singles'}</span>
          </div>
        </div>
      </header>

      <div className="play-live__inner stack--lg">
        {play.error && <Alert severity="caution">Reconnecting… the board will update when the connection is back.</Alert>}
        {!is_open && <Alert severity="info" title="This session has ended">Thanks for playing! Check the venue page for the next open play.</Alert>}
        {my_court && <Alert severity="success" title={`You're on ${my_court.display_name}`}>Have a great game.</Alert>}
        {!my_court && my_next >= 0 && <Alert severity="success" title="You're up next">Stay close — you'll be called to the next free court.</Alert>}

        <div className="play-live__split">
          <section aria-labelledby="play-now-heading">
            <h2 id="play-now-heading" className="play-live__heading">
              Now playing
            </h2>
            <div className="play-live__court-grid">
              {data.court.map((one) => (
                <article
                  key={one.display_name}
                  className={`play-live__court ${one.team.length === 0 ? 'play-live__court--free' : ''} ${my_court === one ? 'is-you' : ''}`}
                >
                  <div className="play-live__court-name">
                    <span>{one.display_name}</span>
                    {one.started_at ? <span className="muted">{minuteOnCourt(one.started_at, now)}</span> : <Badge>Free</Badge>}
                  </div>
                  {one.team.length === 0 ? (
                    <p className="muted">Next group coming up</p>
                  ) : (
                    one.team.map((team, index) => (
                      <div key={index}>
                        {index > 0 && <p className="play-versus">vs</p>}
                        <p className="play-live__player">{team.player.map((each) => each.display_name).join(' & ')}</p>
                      </div>
                    ))
                  )}
                </article>
              ))}
            </div>
          </section>

          <aside className="stack" aria-label="Queue">
            <section aria-labelledby="play-next-heading">
              <h2 id="play-next-heading" className="play-live__heading">
                Up next
              </h2>
              {data.up_next.length === 0 ? (
                <p className="muted">Nobody waiting — courts are yours.</p>
              ) : (
                <ol className="play-live__up-next">
                  {data.up_next.map((one, index) => (
                    <li key={`${one.display_name}-${index}`} className={index === my_next ? 'is-you' : ''}>
                      <span className="play-position" aria-hidden>
                        {index + 1}
                      </span>
                      {one.display_name}
                    </li>
                  ))}
                </ol>
              )}
            </section>
            <div className="row">
              <div>
                <p className="play-live__count">{data.waiting_count}</p>
                <p className="muted">waiting</p>
              </div>
              {data.waitlisted_count > 0 && (
                <div>
                  <p className="play-live__count">{data.waitlisted_count}</p>
                  <p className="muted">on the waitlist</p>
                </div>
              )}
            </div>
            {is_open && <SelfCheckIn token={token} onCheckedIn={(name) => {
              setMe(name)
              try {
                window.localStorage.setItem(storage_key, name)
              } catch {
                // private mode: the highlight just won't survive a refresh
              }
              play.reload()
            }} />}
          </aside>
        </div>

        <p className="play-live__foot">
          <strong>How the order is decided: </strong>
          {data.fairness_rule}
        </p>
      </div>
    </main>
  )
}

function SelfCheckIn({ token, onCheckedIn }: { token: string; onCheckedIn: (display_name: string) => void }) {
  const [display_name, setName] = useState('')
  const [join_code, setCode] = useState('')
  const [result, setResult] = useState<CheckIn>()
  const check_in = useAction(async () => {
    const body = await publicFetch<{ check_in: CheckIn }>(
      `/public/play/${encodeURIComponent(token)}/check-in`,
      jsonBody({ display_name, join_code }),
    )
    setResult(body.check_in)
    setCode('')
    onCheckedIn(body.check_in.display_name)
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    setResult(undefined)
    void check_in.run()
  }

  return (
    <section className="play-live__court" aria-labelledby="play-check-in-heading">
      <h2 id="play-check-in-heading" className="play-live__heading">
        Here to play? Check in
      </h2>
      {result &&
        (result.status_code === 'waitlisted' ? (
          <Alert severity="caution" title={`You're on the waitlist, ${shortName(result.display_name)}`} onDismiss={() => setResult(undefined)}>
            Tonight is full. You're number {result.waitlist_position} and will move in automatically when a spot opens.
          </Alert>
        ) : (
          <Alert severity="success" title={result.is_replay ? `You're already checked in, ${shortName(result.display_name)}` : `You're in, ${shortName(result.display_name)}!`} onDismiss={() => setResult(undefined)}>
            {result.status_code === 'playing'
              ? "You're on court now."
              : result.queue_position
                ? `You're number ${result.queue_position} in the queue. Watch this board for your court.`
                : 'Watch this board for your court.'}
          </Alert>
        ))}
      <form className="form" onSubmit={submit}>
        <ErrorAlert error={check_in.error} onDismiss={check_in.clearError} />
        <TextInput label="Your name" placeholder="First and last name" value={display_name} onChange={(event) => setName(event.target.value)} required maxLength={80} autoComplete="name" />
        <TextInput
          label="Join code"
          hint="The 4-digit code posted at the front desk"
          value={join_code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 4))}
          inputMode="numeric"
          pattern="[0-9]{4}"
          autoComplete="off"
          required
        />
        <div className="form__action">
          <Button type="submit" size="lg" disabled={check_in.is_pending || display_name.trim() === '' || join_code.length !== 4}>
            {check_in.is_pending ? 'Checking in…' : 'Check in'}
          </Button>
        </div>
      </form>
    </section>
  )
}
