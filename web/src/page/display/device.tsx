// /display?credential=… — the TV itself. Full screen, dark, huge type.
//
// It pulls a fresh server-built projection every 5 s. When a pull fails it
// keeps the last picture but says so, loudly: a frozen score on a lounge TV
// that looks live is worse than no score.

import { CloudSlash, Television } from '@phosphor-icons/react'
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { ApiError, jsonBody, publicFetch } from '../../api.ts'
import { formatMoney, formatTime, formatTimeRange } from '../../format.ts'
import { useInterval } from '../../hook.ts'
import type { PageProp } from '../../registry.ts'
import { useQuery } from '../../route.tsx'
import './display.css'

type TimeRange = { starts_at: string; ends_at: string }

type LiveScore = {
  status: 'live' | 'complete' | 'confirmed'
  sport_display_name: string
  rule_description: string
  headline: string
  call_out: string
  unit_label: 'game' | 'set'
  serving_team_number: 1 | 2 | null
  server_number: 1 | 2 | null
  winner_team_number: 1 | 2 | null
  team: { team_number: 1 | 2; display_name: string; point_label: string; game_count: number; game_won_count: number }[]
  game_history: { point: [number, number]; winner_team_number: 1 | 2 }[]
}

type CourtProjection = {
  court: { display_name: string; sport_display_name: string | null }
  live_match: LiveScore | null
  current_booking: TimeRange | null
  next_booking: TimeRange | null
}

type LoungeProjection = {
  court: { display_name: string; sport_display_name: string | null; live_match: LiveScore | null; current_booking: TimeRange | null; next_booking: TimeRange | null }[]
  open_play: { display_name: string; starts_at: string; ends_at: string; court: { display_name: string; player: string[] }[]; up_next: string[]; waiting_count: number }[]
}

type CounterProjection = {
  next_available: { court_display_name: string; sport_display_name: string | null; starts_at: string; ends_at: string; price_amount: string }[]
  court_count: number
  court_in_use_count: number
  booking_today_count: number
  player_expected_count: number
  open_play_now_count: number
}

type KioskProjection = {
  court: { display_name: string; sport_display_name: string | null; open_slot: { starts_at: string; ends_at: string; price_amount: string }[] }[]
  open_play: { display_name: string; starts_at: string; ends_at: string; is_now: boolean; court_count: number; waiting_count: number }[]
  program: { title: string; kind_code: string; starts_at: string; ends_at: string; seat_open_count: number; price_amount: string }[]
  booking: { path: string; url: string; qr_svg: string } | null
}

type Brand = { display_name: string; accent: string; action: string; heading_font: string }

type Snapshot = {
  display_name: string
  venue_name: string
  time_zone: string
  generated_at: string
  stale_after_second: number
  refresh_after_second: number
  config_version: number
  /** The venue's published Studio version; 0 is the unbranded default. */
  site_version_number: number
  brand: Brand
} & (
  | { kind: 'court'; projection: CourtProjection }
  | { kind: 'lounge'; projection: LoungeProjection }
  | { kind: 'counter'; projection: CounterProjection }
  | { kind: 'kiosk'; projection: KioskProjection }
)

const KIND_LABEL = { court: 'Court', lounge: 'Lounge', counter: 'Front counter', kiosk: 'Welcome' } as const

const HEX = /^#[0-9a-f]{6}$/i
const HEADING_FONT = ['Space Grotesk', 'Inter']

/** Studio brand tokens as CSS variables on the display root. Only validated values get through. */
function brandStyle(brand: Brand | undefined): CSSProperties | undefined {
  if (!brand) return undefined
  const style: Record<string, string> = {}
  if (HEX.test(brand.accent)) {
    style['--accent'] = brand.accent
    style['--brand-accent'] = brand.accent
  }
  if (HEX.test(brand.action)) {
    style['--action'] = brand.action
    style['--brand-action'] = brand.action
  }
  if (HEADING_FONT.includes(brand.heading_font)) style['--font-heading'] = `'${brand.heading_font}', 'Inter', sans-serif`
  return style as CSSProperties
}

export default function Page(_prop: PageProp) {
  const credential = useQuery().get('credential')?.trim() ?? ''
  useEffect(() => {
    document.title = 'Display'
  }, [])
  if (!credential) return <EnrolPrompt />
  return <Screen credential={credential} />
}

function EnrolPrompt() {
  return (
    <main className="tv public--court-dark tv--message">
      <Television size={72} aria-hidden />
      <h1>This screen is not set up yet</h1>
      <p>
        At the front desk, open <strong>Operator → Displays</strong>, choose <strong>Add screen</strong>, and open the link it gives you on this TV.
      </p>
    </main>
  )
}

function Screen({ credential }: { credential: string }) {
  const [snapshot, setSnapshot] = useState<Snapshot>()
  const [last_success_at, setLastSuccess] = useState<Date>()
  const [failure, setFailure] = useState<'network' | 'removed'>()
  const [now, setNow] = useState(() => new Date())
  const config_version = useRef<number | undefined>(undefined)
  // The Studio version actually on screen, reported back on the next pull.
  const rendered_site_version = useRef<number | undefined>(undefined)
  const is_pulling = useRef(false)

  useEffect(() => {
    if (snapshot) rendered_site_version.current = snapshot.site_version_number
  }, [snapshot])

  const pull = useCallback(async () => {
    if (is_pulling.current) return
    is_pulling.current = true
    try {
      const body = await publicFetch<Snapshot>(
        '/public/display/state',
        jsonBody({
          credential,
          config_version: config_version.current,
          site_version_number: rendered_site_version.current,
          // A kiosk's booking QR opens this same web origin on a phone.
          origin: window.location.origin,
        }),
      )
      config_version.current = body.config_version
      setSnapshot(body)
      setLastSuccess(new Date())
      setFailure(undefined)
    } catch (error) {
      setFailure(error instanceof ApiError && error.status === 401 ? 'removed' : 'network')
    } finally {
      is_pulling.current = false
    }
  }, [credential])

  useEffect(() => {
    void pull()
  }, [pull])
  useInterval(() => void pull(), failure === 'removed' ? 30_000 : 5_000)
  useInterval(() => setNow(new Date()), 1_000)

  const time_zone = snapshot?.time_zone
  if (failure === 'removed') {
    return (
      <main className="tv public--court-dark tv--message">
        <Television size={72} aria-hidden />
        <h1>This screen was removed by the venue</h1>
        <p>Ask the front desk for a new display link to show venue information here again.</p>
      </main>
    )
  }

  if (!snapshot) {
    return (
      <main className="tv public--court-dark tv--message">
        {failure === 'network' ? (
          <>
            <CloudSlash size={72} aria-hidden />
            <h1>Can’t reach the venue</h1>
            <p>Check this TV’s internet connection. Trying again every few seconds.</p>
          </>
        ) : (
          <>
            <Television size={72} aria-hidden />
            <h1>Connecting…</h1>
          </>
        )}
      </main>
    )
  }

  const age_second = last_success_at ? (now.getTime() - last_success_at.getTime()) / 1000 : Infinity
  const is_stale = failure === 'network' || age_second > snapshot.stale_after_second

  return (
    <main
      className={`tv tv--${snapshot.kind} public--court-dark${is_stale ? ' is-stale' : ''}`}
      style={brandStyle(snapshot.brand)}
      data-site-version={snapshot.site_version_number}
    >
      <header className="tv__header">
        {/* Views without their own level-one heading (the lounge, a court mid-match) get a hidden one. */}
        {(snapshot.kind === 'lounge' || (snapshot.kind === 'court' && snapshot.projection.live_match)) && (
          <h1 className="visually-hidden">
            {snapshot.venue_name} · {snapshot.kind === 'court' ? snapshot.projection.court.display_name : KIND_LABEL[snapshot.kind]}
          </h1>
        )}
        <div>
          <p className="tv__venue">
            <span className="tv__brand-mark" aria-hidden />
            {snapshot.venue_name}
          </p>
          <p className="tv__label">
            {snapshot.kind === 'court' ? snapshot.projection.court.display_name : KIND_LABEL[snapshot.kind]}
          </p>
        </div>
        <p className="tv__clock" aria-label="Current time">
          {formatTime(now, time_zone)}
        </p>
      </header>

      {is_stale && (
        <div className="tv__offline" role="status">
          <CloudSlash size={36} weight="bold" aria-hidden />
          <span>Offline — last updated {last_success_at ? formatTime(last_success_at, time_zone) : 'never'}</span>
        </div>
      )}

      <div className="tv__body">
        {snapshot.kind === 'court' && <CourtView projection={snapshot.projection} time_zone={time_zone} />}
        {snapshot.kind === 'lounge' && <LoungeView projection={snapshot.projection} time_zone={time_zone} />}
        {snapshot.kind === 'counter' && <CounterView projection={snapshot.projection} time_zone={time_zone} />}
        {snapshot.kind === 'kiosk' && <KioskView projection={snapshot.projection} time_zone={time_zone} />}
      </div>

      <footer className="tv__footer">
        <span>{snapshot.display_name}</span>
        <span>
          {snapshot.site_version_number > 0 ? `Site v${snapshot.site_version_number}` : 'Default look'} · Updated{' '}
          {last_success_at ? formatTime(last_success_at, time_zone) : '—'}
        </span>
      </footer>
    </main>
  )
}

function Scoreline({ score, is_large }: { score: LiveScore; is_large: boolean }) {
  return (
    <div className={`tv-score${is_large ? ' tv-score--large' : ''}`}>
      {score.team.map((team) => {
        const is_serving = score.serving_team_number === team.team_number
        return (
          <div key={team.team_number} className={`tv-score__team${is_serving ? ' is-serving' : ''}${score.winner_team_number === team.team_number ? ' is-winner' : ''}`}>
            <span className="tv-score__name">{team.display_name}</span>
            <span className="tv-score__games">
              {score.unit_label === 'set' ? `Sets ${team.game_won_count} · Games ${team.game_count}` : `Games ${team.game_won_count}`}
            </span>
            <span className="tv-score__point">{team.point_label}</span>
            {is_serving && <span className="tv-score__serve">Serving{score.server_number ? ` · ${score.server_number}` : ''}</span>}
          </div>
        )
      })}
    </div>
  )
}

function bookingLine(current: TimeRange | null, next: TimeRange | null, time_zone: string | undefined): string {
  if (current) return `Booked until ${formatTime(current.ends_at, time_zone)}`
  if (next) return `Open now · next booking ${formatTime(next.starts_at, time_zone)}`
  return 'Open for the rest of today'
}

function CourtView({ projection, time_zone }: { projection: CourtProjection; time_zone: string | undefined }) {
  const score = projection.live_match
  return (
    <section className="tv-court">
      {score ? (
        <>
          <p className="tv-court__headline">
            {score.status === 'live' ? `${score.headline} · Call ${score.call_out}` : score.headline}
          </p>
          <Scoreline score={score} is_large />
          {score.game_history.length > 0 && (
            <p className="tv-court__history">
              {score.unit_label === 'set' ? 'Sets' : 'Games'}: {score.game_history.map((one) => `${one.point[0]}-${one.point[1]}`).join('  ·  ')}
            </p>
          )}
        </>
      ) : (
        <div className="tv-court__idle">
          <h1>{projection.current_booking ? 'Court in use' : 'Court open'}</h1>
          <p>{projection.court.sport_display_name ?? 'Court'}</p>
        </div>
      )}
      <p className="tv-court__booking">{bookingLine(projection.current_booking, projection.next_booking, time_zone)}</p>
    </section>
  )
}

function LoungeView({ projection, time_zone }: { projection: LoungeProjection; time_zone: string | undefined }) {
  return (
    <div className="tv-lounge">
      <section className="tv-lounge__court" aria-label="Courts">
        {projection.court.length === 0 && <p className="tv__empty">No courts are set up yet.</p>}
        {projection.court.map((court) => (
          <article key={court.display_name} className={`tv-tile${court.live_match ? ' is-live' : ''}`}>
            <header className="tv-tile__header">
              <h2>{court.display_name}</h2>
              <span>{court.live_match ? (court.live_match.status === 'live' ? 'Live' : 'Final') : court.current_booking ? 'In use' : 'Open'}</span>
            </header>
            {court.live_match ? <Scoreline score={court.live_match} is_large={false} /> : <p className="tv-tile__idle">{court.sport_display_name ?? 'Court'}</p>}
            <p className="tv-tile__booking">{bookingLine(court.current_booking, court.next_booking, time_zone)}</p>
          </article>
        ))}
      </section>
      <section className="tv-lounge__play" aria-label="Open play">
        <h2>Open play</h2>
        {projection.open_play.length === 0 ? (
          <p className="tv__empty">No open play right now. Ask at the counter to join the next session.</p>
        ) : (
          projection.open_play.map((play) => (
            <article key={`${play.display_name}-${play.starts_at}`} className="tv-play">
              <h3>{play.display_name}</h3>
              <p className="tv-play__time">{formatTimeRange(play.starts_at, play.ends_at, time_zone)}</p>
              {play.court.map((court) => (
                <p key={court.display_name} className="tv-play__court">
                  <strong>{court.display_name}</strong> {court.player.join(', ') || 'Waiting for players'}
                </p>
              ))}
              <div className="tv-play__next">
                <strong>Up next</strong>
                <span>{play.up_next.length > 0 ? play.up_next.join(', ') : 'Nobody waiting'}</span>
                {play.waiting_count > play.up_next.length && <span>+{play.waiting_count - play.up_next.length} more in line</span>}
              </div>
            </article>
          ))
        )}
      </section>
    </div>
  )
}

function CounterView({ projection, time_zone }: { projection: CounterProjection; time_zone: string | undefined }) {
  return (
    <div className="tv-counter">
      <section className="tv-counter__slot">
        <h1>Next open courts today</h1>
        {projection.next_available.length === 0 ? (
          <p className="tv__empty">Fully booked for the rest of today. Ask about the waitlist or open play.</p>
        ) : (
          <ul>
            {projection.next_available.map((one) => (
              <li key={`${one.court_display_name}-${one.starts_at}`}>
                <span className="tv-counter__time">{formatTimeRange(one.starts_at, one.ends_at, time_zone)}</span>
                <span className="tv-counter__court">
                  {one.court_display_name}
                  {one.sport_display_name && <small>{one.sport_display_name}</small>}
                </span>
                <span className="tv-counter__price">{formatMoney(one.price_amount)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="tv-counter__stat" aria-label="Today">
        <div>
          <strong>
            {projection.court_in_use_count}/{projection.court_count}
          </strong>
          <span>Courts in use</span>
        </div>
        <div>
          <strong>{projection.player_expected_count}</strong>
          <span>Players expected today</span>
        </div>
        <div>
          <strong>{projection.booking_today_count}</strong>
          <span>Bookings today</span>
        </div>
        <div>
          <strong>{projection.open_play_now_count}</strong>
          <span>Open play now</span>
        </div>
      </section>
    </div>
  )
}

function KioskView({ projection, time_zone }: { projection: KioskProjection; time_zone: string | undefined }) {
  const open_court = projection.court.filter((one) => one.open_slot.length > 0)
  return (
    <div className="tv-kiosk">
      <div className="tv-kiosk__main">
        <section className="tv-kiosk__section" aria-label="Open courts">
          <h1>Open courts in the next few hours</h1>
          {open_court.length === 0 ? (
            <p className="tv__empty">No open courts in the next few hours. Try open play or ask at the counter.</p>
          ) : (
            <div className="tv-kiosk__court">
              {open_court.map((court) => (
                <article key={court.display_name} className="tv-kiosk__tile">
                  <h2>
                    {court.display_name}
                    {court.sport_display_name && <small>{court.sport_display_name}</small>}
                  </h2>
                  <ul className="tv-kiosk__slot">
                    {court.open_slot.map((slot) => (
                      <li key={slot.starts_at}>
                        <strong>{formatTime(slot.starts_at, time_zone)}</strong>
                        <span>{formatMoney(slot.price_amount)}</span>
                      </li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="tv-kiosk__section" aria-label="Open play">
          <h2>Open play</h2>
          {projection.open_play.length === 0 ? (
            <p className="tv__empty">No open play right now.</p>
          ) : (
            <ul className="tv-kiosk__list">
              {projection.open_play.map((play) => (
                <li key={`${play.display_name}-${play.starts_at}`}>
                  <span className={`tv-kiosk__tag${play.is_now ? ' is-now' : ''}`}>{play.is_now ? 'Now' : 'Up next'}</span>
                  <strong>{play.display_name}</strong>
                  <span>
                    {formatTimeRange(play.starts_at, play.ends_at, time_zone)} · {play.court_count} {play.court_count === 1 ? 'court' : 'courts'} ·{' '}
                    {play.waiting_count} waiting
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {projection.program.length > 0 && (
          <section className="tv-kiosk__section" aria-label="Programs today">
            <h2>Later today</h2>
            <ul className="tv-kiosk__list">
              {projection.program.map((one) => (
                <li key={`${one.title}-${one.starts_at}`}>
                  <span className="tv-kiosk__tag">{one.kind_code.replace('_', ' ')}</span>
                  <strong>{one.title}</strong>
                  <span>
                    {formatTimeRange(one.starts_at, one.ends_at, time_zone)} ·{' '}
                    {one.seat_open_count > 0 ? `${one.seat_open_count} ${one.seat_open_count === 1 ? 'spot' : 'spots'} left` : 'Full'} ·{' '}
                    {formatMoney(one.price_amount)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      {projection.booking && (
        <aside className="tv-kiosk__cta" aria-label="Book on your phone">
          <div className="tv-kiosk__cta-text">
            <h2>Book on your phone</h2>
            <p>Scan the code with your camera to pick a court and time.</p>
          </div>
          {/* Server-rendered by the scan pack from the venue booking URL only. */}
          <div className="tv-kiosk__qr" dangerouslySetInnerHTML={{ __html: projection.booking.qr_svg }} />
          <p className="tv-kiosk__url">{projection.booking.url.replace(/^https?:\/\//, '')}</p>
        </aside>
      )}
    </div>
  )
}
