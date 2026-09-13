// Operator → Scoring. Two views on one route:
//   /operator/score            live matches, recent results, new match
//   /operator/score?match=<id> the court-side scorer, built for a tablet
//
// The scorer runs the same pure engine the server does. A tap is validated
// locally, queued in localStorage with its client_operation_id, and sent; the
// screen shows server log + queued taps replayed together, so scoring carries
// on while the network is down and the queue drains when it returns.

import { ArrowCounterClockwise, ArrowLeft, ArrowsLeftRight, Flag, PencilSimple, Plus, Trash, WifiSlash } from '@phosphor-icons/react'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  applyOperation,
  describeState,
  replay,
  type GameRecord,
  type ScoreOperation,
  type ScoreState,
  type ScoringProfile,
  type StateView,
  type TeamNumber,
} from '../../../../src/module/score/engine.ts'
import { ApiError, jsonBody, operatorFetch } from '../../api.ts'
import {
  Alert,
  Badge,
  Button,
  ButtonLink,
  Card,
  Dialog,
  EmptyState,
  ErrorAlert,
  Loading,
  PageHeader,
  ResourceView,
  SelectInput,
  TextArea,
  TextInput,
} from '../../component/ui.tsx'
import { formatDateTime } from '../../format.ts'
import { useAction, useInterval, useResource } from '../../hook.ts'
import type { PageProp } from '../../registry.ts'
import { navigate, useQuery } from '../../route.tsx'
import { useOperator } from '../../session.tsx'
import './score.css'

// ---- server shapes ---------------------------------------------------------

type MatchTeam = { team_number: TeamNumber; display_name: string; player_display_name: string[] }

type MatchView = {
  score_match_id: string
  resource_id: string | null
  court_display_name: string | null
  sport_profile_code: string
  sport_display_name: string
  scoring_rule_code: string
  rule_description: string
  team_size_count: number
  best_of_count: number
  status: 'live' | 'complete' | 'confirmed'
  operation_set_version: number
  operation_count: number
  played_at: string
  confirmed_at: string | null
  confirmed_by_display_name: string | null
  updated_at: string
  team: [MatchTeam, MatchTeam]
  state: StateView
  operation: { sequence_number: number; client_operation_id: string; operation: ScoreOperation }[]
  correction: {
    score_correction_id: string
    reason: string
    actor_display_name: string | null
    previous_game_point: [number, number][]
    corrected_game_point: [number, number][]
    created_at: string
  }[]
}

type ScoreOption = {
  court: { resource_id: string; display_name: string; sport_profile_code: string | null }[]
  sport_profile: { sport_profile_code: string; display_name: string; scoring_rule_code: string; team_size_count: number; is_supported: boolean }[]
}

type PendingOperation = { client_operation_id: string; operation: ScoreOperation; queued_at: string }

// ---- helpers ---------------------------------------------------------------

function profileOf(match: Pick<MatchView, 'scoring_rule_code' | 'best_of_count' | 'team_size_count'>): ScoringProfile {
  return { scoring_rule_code: match.scoring_rule_code, best_of_count: match.best_of_count, team_size_count: match.team_size_count }
}

function isSetRule(scoring_rule_code: string): boolean {
  return scoring_rule_code === 'tennis_set' || scoring_rule_code === 'padel_set'
}

function isDoublesSideOut(match: Pick<MatchView, 'scoring_rule_code' | 'team_size_count'>): boolean {
  return match.scoring_rule_code.startsWith('side_out') && match.team_size_count >= 2
}

/** "Team 1 wins 2-0" → "Mara Santos & Jun Reyes win 2-0". */
function withName(match: MatchView, text: string): string {
  return text.replace(/Team ([12]) wins/g, (_, n: string) => `${match.team[Number(n) - 1]!.display_name} win`).replace(/Team ([12])/g, (_, n: string) => match.team[Number(n) - 1]!.display_name)
}

function gameSummary(history: GameRecord[] | [number, number][]): string {
  if (history.length === 0) return '—'
  return history
    .map((one) => {
      if (Array.isArray(one)) return `${one[0]}-${one[1]}`
      const tiebreak = one.tiebreak_point ? ` (${one.tiebreak_point[0]}-${one.tiebreak_point[1]})` : ''
      return `${one.point[0]}-${one.point[1]}${tiebreak}`
    })
    .join(', ')
}

function mintClientId(): string {
  const random = globalThis.crypto?.randomUUID?.()
  return random ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

const QUEUE_KEY = (id: string) => `court.score.queue.${id}`
const CACHE_KEY = (id: string) => `court.score.match.${id}`

function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function writeStored(key: string, value: unknown) {
  try {
    if (value === undefined || (Array.isArray(value) && value.length === 0)) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage full or blocked: the tap still goes to the server when online.
  }
}

function StatusBadge({ match }: { match: MatchView }) {
  if (match.status === 'confirmed') return <Badge tone="success">{match.correction.length > 0 ? 'Confirmed · corrected' : 'Confirmed'}</Badge>
  if (match.status === 'complete') return <Badge tone="caution">Needs confirming</Badge>
  return <Badge tone="info">Live</Badge>
}

// ---- page ------------------------------------------------------------------

export default function Page(_prop: PageProp) {
  const query = useQuery()
  const score_match_id = query.get('match')
  return score_match_id ? <Scorer key={score_match_id} score_match_id={score_match_id} /> : <MatchBoard />
}

// ---- match board -----------------------------------------------------------

function MatchBoard() {
  const { can } = useOperator()
  const can_manage = can('score.manage')
  const board = useResource(async () => {
    const [live, recent, option] = await Promise.all([
      operatorFetch<{ match: MatchView[] }>('/api/v1/score/match?view=live'),
      operatorFetch<{ match: MatchView[] }>('/api/v1/score/match?view=recent'),
      operatorFetch<ScoreOption>('/api/v1/score/option'),
    ])
    return { live: live.match, recent: recent.match, option }
  }, [])
  useInterval(board.reload, 10_000)

  const [is_creating, setCreating] = useState(false)
  const [confirming, setConfirming] = useState<MatchView>()
  const [correcting, setCorrecting] = useState<MatchView>()
  const [discarding, setDiscarding] = useState<MatchView>()
  const [notice, setNotice] = useState<string>()

  const new_match_button = can_manage ? (
    <Button icon={<Plus size={18} aria-hidden />} onClick={() => setCreating(true)}>
      New match
    </Button>
  ) : undefined

  return (
    <>
      <PageHeader
        eyebrow="Play"
        title="Scoring"
        description="Keep score at the court on a tablet. Every tap is saved on the tablet first, so scoring carries on through a dropped connection."
        action={new_match_button}
      />
      {notice && (
        <Alert severity="success" title={notice} onDismiss={() => setNotice(undefined)} />
      )}
      <ResourceView resource={board}>
        {({ live, recent, option }) => (
          <div className="stack--lg">
            <section className="stack" aria-labelledby="score-live">
              <h2 id="score-live">On court now</h2>
              {live.length === 0 ? (
                <EmptyState
                  title="No match is being scored"
                  description="Start a match when players step on court, then hand the tablet to the scorer."
                  action={new_match_button}
                />
              ) : (
                <div className="grid">
                  {live.map((match) => (
                    <Card
                      key={match.score_match_id}
                      title={match.court_display_name ?? 'No court'}
                      description={`${match.sport_display_name} · ${match.rule_description}`}
                      action={<StatusBadge match={match} />}
                    >
                      <div className="stack">
                        <ul className="score-board__team">
                          {match.team.map((team) => (
                            <li key={team.team_number} className={match.state.serving_team_number === team.team_number && !match.state.is_complete ? 'is-serving' : undefined}>
                              <span>{team.display_name}</span>
                              <strong>{match.state.team[team.team_number - 1]!.point_label}</strong>
                            </li>
                          ))}
                        </ul>
                        <p className="muted">
                          {withName(match, match.state.headline)}
                          {!match.state.is_complete && <> · call <span className="mono">{match.state.call_out}</span></>}
                        </p>
                        <div className="row">
                          <Button tone="primary" size="sm" onClick={() => navigate(`/operator/score?match=${match.score_match_id}`)}>
                            {match.status === 'complete' ? 'Review and confirm' : 'Open scorer'}
                          </Button>
                          {can_manage && match.status !== 'complete' && (
                            <Button tone="quiet" size="sm" icon={<Trash size={16} aria-hidden />} onClick={() => setDiscarding(match)}>
                              Discard
                            </Button>
                          )}
                        </div>
                      </div>
                    </Card>
                  ))}
                </div>
              )}
            </section>

            <section className="stack" aria-labelledby="score-recent">
              <h2 id="score-recent">Recent results</h2>
              {recent.length === 0 ? (
                <EmptyState title="No finished matches yet" description="A match appears here when its last game ends. Confirm it to lock the result." />
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Played</th>
                        <th>Court</th>
                        <th>Teams</th>
                        <th>Score</th>
                        <th>Status</th>
                        <th>
                          <span className="visually-hidden">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {recent.map((match) => (
                        <tr key={match.score_match_id}>
                          <td>{formatDateTime(match.played_at)}</td>
                          <td>
                            {match.court_display_name ?? 'No court'}
                            <div className="muted">{match.sport_display_name}</div>
                          </td>
                          <td>
                            <span className={match.state.winner_team_number === 1 ? 'score-winner' : undefined}>{match.team[0].display_name}</span>
                            <span className="muted"> vs </span>
                            <span className={match.state.winner_team_number === 2 ? 'score-winner' : undefined}>{match.team[1].display_name}</span>
                          </td>
                          <td className="mono">{match.state.is_forfeit ? 'Forfeit' : gameSummary(match.state.game_history)}</td>
                          <td>
                            <StatusBadge match={match} />
                          </td>
                          <td>
                            <div className="row">
                              {can_manage && match.status === 'complete' && (
                                <Button size="sm" onClick={() => setConfirming(match)}>
                                  Confirm
                                </Button>
                              )}
                              {can_manage && match.status === 'confirmed' && (
                                <Button size="sm" tone="secondary" icon={<PencilSimple size={16} aria-hidden />} onClick={() => setCorrecting(match)}>
                                  Correct
                                </Button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {is_creating && (
              <NewMatchDialog
                option={option}
                onClose={() => setCreating(false)}
                onCreated={(match) => navigate(`/operator/score?match=${match.score_match_id}`)}
              />
            )}
          </div>
        )}
      </ResourceView>

      {confirming && (
        <ConfirmResultDialog
          match={confirming}
          onClose={() => setConfirming(undefined)}
          onDone={(match) => {
            setConfirming(undefined)
            setNotice(`Result confirmed: ${withName(match, match.state.headline)}`)
            board.reload()
          }}
        />
      )}
      {correcting && (
        <CorrectDialog
          match={correcting}
          onClose={() => setCorrecting(undefined)}
          onDone={(match) => {
            setCorrecting(undefined)
            setNotice(`Correction recorded. The result is now ${gameSummary(match.state.game_history)}.`)
            board.reload()
          }}
        />
      )}
      {discarding && (
        <DiscardDialog
          match={discarding}
          onClose={() => setDiscarding(undefined)}
          onDone={() => {
            setDiscarding(undefined)
            setNotice('Match discarded.')
            board.reload()
          }}
        />
      )}
    </>
  )
}

function NewMatchDialog({ option, onClose, onCreated }: { option: ScoreOption; onClose: () => void; onCreated: (match: MatchView) => void }) {
  const supported = option.sport_profile.filter((one) => one.is_supported)
  const initial = supported.find((one) => one.sport_profile_code === 'pickleball') ?? supported[0]
  const [sport_profile_code, setSport] = useState(initial?.sport_profile_code ?? '')
  const profile = supported.find((one) => one.sport_profile_code === sport_profile_code)
  const [team_size, setTeamSize] = useState(initial && initial.team_size_count < 2 ? '1' : '2')
  const [resource_id, setCourt] = useState('')
  const [best_of_count, setBestOf] = useState('1')
  const [first_serving, setFirstServing] = useState('1')
  const [name, setName] = useState<string[][]>([
    ['', ''],
    ['', ''],
  ])
  const [is_submitted, setSubmitted] = useState(false)

  const size = Number(team_size)
  const unit = isSetRule(profile?.scoring_rule_code ?? '') ? 'set' : 'game'
  const court = option.court.filter((one) => one.sport_profile_code === null || one.sport_profile_code === sport_profile_code)

  const create = useAction(async () => {
    const created = await operatorFetch<{ match: MatchView }>(
      '/api/v1/score/match',
      jsonBody({
        sport_profile_code,
        resource_id: resource_id || null,
        best_of_count: Number(best_of_count),
        team: name.map((team) => ({ player_display_name: team.slice(0, size).map((one) => one.trim()) })),
      }),
    )
    if (first_serving === '2') {
      await operatorFetch(
        `/api/v1/score/match/${created.match.score_match_id}/operation`,
        jsonBody({ client_operation_id: mintClientId(), kind: 'set_server', team_number: 2, server_number: isDoublesSideOut(created.match) ? 2 : null }),
      )
    }
    return created.match
  })

  const missing = (team: number, slot: number) => is_submitted && !name[team]![slot]!.trim()

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSubmitted(true)
    if (!sport_profile_code) return
    if (name.some((team) => team.slice(0, size).some((one) => !one.trim()))) return
    const match = await create.run()
    if (match) onCreated(match)
  }

  if (supported.length === 0) {
    return (
      <Dialog open title="New match" onClose={onClose}>
        <EmptyState title="No sport is set up for scoring" description="Add a sport with a scoring rule in Venue setup, then start a match here." />
      </Dialog>
    )
  }

  return (
    <Dialog
      open
      title="New match"
      onClose={onClose}
      footer={
        <>
          <Button tone="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="new-match" disabled={create.is_pending}>
            {create.is_pending ? 'Starting…' : 'Start scoring'}
          </Button>
        </>
      }
    >
      <form id="new-match" className="form" onSubmit={submit} noValidate>
        <ErrorAlert error={create.error} onDismiss={create.clearError} />
        <div className="form__row">
          <SelectInput
            label="Sport"
            value={sport_profile_code}
            onChange={(event) => {
              const next = supported.find((one) => one.sport_profile_code === event.target.value)
              setSport(event.target.value)
              setTeamSize(next && next.team_size_count < 2 ? '1' : '2')
              setCourt('')
            }}
            option={supported.map((one) => ({ value: one.sport_profile_code, label: one.display_name }))}
          />
          <SelectInput
            label="Court"
            value={resource_id}
            onChange={(event) => setCourt(event.target.value)}
            option={[{ value: '', label: 'No court' }, ...court.map((one) => ({ value: one.resource_id, label: one.display_name }))]}
          />
        </div>
        <div className="form__row">
          <SelectInput
            label="Format"
            value={team_size}
            onChange={(event) => setTeamSize(event.target.value)}
            option={[
              { value: '2', label: 'Doubles' },
              { value: '1', label: 'Singles' },
            ]}
          />
          <SelectInput
            label="Match length"
            value={best_of_count}
            onChange={(event) => setBestOf(event.target.value)}
            option={[
              { value: '1', label: `One ${unit}` },
              { value: '3', label: `Best of 3 ${unit}s` },
              { value: '5', label: `Best of 5 ${unit}s` },
            ]}
          />
        </div>
        {[0, 1].map((team) => (
          <fieldset key={team} className="score-fieldset">
            <legend>Team {team + 1}</legend>
            <div className="form__row">
              {Array.from({ length: size }, (_, slot) => (
                <TextInput
                  key={slot}
                  label={size === 1 ? 'Player' : `Player ${slot + 1}`}
                  value={name[team]![slot]!}
                  autoComplete="off"
                  maxLength={60}
                  error={missing(team, slot) ? 'Enter a name' : undefined}
                  onChange={(event) => {
                    const next = name.map((row) => [...row])
                    next[team]![slot] = event.target.value
                    setName(next)
                  }}
                />
              ))}
            </div>
          </fieldset>
        ))}
        <SelectInput
          label="Serving first"
          value={first_serving}
          onChange={(event) => setFirstServing(event.target.value)}
          option={[
            { value: '1', label: 'Team 1' },
            { value: '2', label: 'Team 2' },
          ]}
        />
      </form>
    </Dialog>
  )
}

function ConfirmResultDialog({ match, onClose, onDone }: { match: MatchView; onClose: () => void; onDone: (match: MatchView) => void }) {
  const confirm = useAction(async () => (await operatorFetch<{ match: MatchView }>(`/api/v1/score/match/${match.score_match_id}/confirm`, { method: 'POST' })).match)
  return (
    <Dialog
      open
      title="Confirm this result?"
      onClose={onClose}
      footer={
        <>
          <Button tone="quiet" onClick={onClose}>
            Not yet
          </Button>
          <Button
            disabled={confirm.is_pending}
            onClick={async () => {
              const done = await confirm.run()
              if (done) onDone(done)
            }}
          >
            {confirm.is_pending ? 'Confirming…' : 'Confirm result'}
          </Button>
        </>
      }
    >
      <ErrorAlert error={confirm.error} onDismiss={confirm.clearError} />
      <p>
        <strong>{withName(match, match.state.headline)}</strong>
        {!match.state.is_forfeit && <> ({gameSummary(match.state.game_history)})</>}
      </p>
      <p className="muted">After confirming, the score is locked. It can only be changed with a correction that records who changed it and why.</p>
    </Dialog>
  )
}

type CorrectionRow = { one: string; two: string; tiebreak_one: string; tiebreak_two: string }

function CorrectDialog({ match, onClose, onDone }: { match: MatchView; onClose: () => void; onDone: (match: MatchView) => void }) {
  const is_set = isSetRule(match.scoring_rule_code)
  const [reason, setReason] = useState('')
  const [row, setRow] = useState<CorrectionRow[]>(() =>
    match.state.game_history.length > 0
      ? match.state.game_history.map((game) => ({
          one: String(game.point[0]),
          two: String(game.point[1]),
          tiebreak_one: game.tiebreak_point ? String(game.tiebreak_point[0]) : '',
          tiebreak_two: game.tiebreak_point ? String(game.tiebreak_point[1]) : '',
        }))
      : [{ one: '', two: '', tiebreak_one: '', tiebreak_two: '' }],
  )
  const [is_submitted, setSubmitted] = useState(false)
  const unit = is_set ? 'Set' : 'Game'

  const correct = useAction(async () =>
    (
      await operatorFetch<{ match: MatchView }>(
        `/api/v1/score/match/${match.score_match_id}/correct`,
        jsonBody({
          reason: reason.trim(),
          game_point: row.map((one) => ({
            point: [Number(one.one), Number(one.two)],
            tiebreak_point: is_set && one.tiebreak_one !== '' && one.tiebreak_two !== '' ? [Number(one.tiebreak_one), Number(one.tiebreak_two)] : null,
          })),
        }),
      )
    ).match,
  )

  const update = (position: number, patch: Partial<CorrectionRow>) => setRow(row.map((one, index) => (index === position ? { ...one, ...patch } : one)))
  const is_tiebreak_row = (one: CorrectionRow) => is_set && [one.one, one.two].sort().join('-') === '6-7'

  return (
    <Dialog
      open
      title="Correct a confirmed result"
      onClose={onClose}
      footer={
        <>
          <Button tone="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="correct-result" disabled={correct.is_pending}>
            {correct.is_pending ? 'Saving…' : 'Record correction'}
          </Button>
        </>
      }
    >
      <form
        id="correct-result"
        className="form"
        noValidate
        onSubmit={async (event) => {
          event.preventDefault()
          setSubmitted(true)
          if (!reason.trim() || row.some((one) => one.one === '' || one.two === '')) return
          const done = await correct.run()
          if (done) onDone(done)
        }}
      >
        <ErrorAlert error={correct.error} onDismiss={correct.clearError} />
        <p className="muted">
          Recorded now: <span className="mono">{gameSummary(match.state.game_history)}</span>. The original score stays in the history next to your correction.
        </p>
        {row.map((one, position) => (
          <fieldset key={position} className="score-fieldset">
            <legend>
              {unit} {position + 1}
            </legend>
            <div className="form__row">
              <TextInput
                label={match.team[0].display_name}
                inputMode="numeric"
                value={one.one}
                error={is_submitted && one.one === '' ? 'Enter a score' : undefined}
                onChange={(event) => update(position, { one: event.target.value.replace(/\D/g, '') })}
              />
              <TextInput
                label={match.team[1].display_name}
                inputMode="numeric"
                value={one.two}
                error={is_submitted && one.two === '' ? 'Enter a score' : undefined}
                onChange={(event) => update(position, { two: event.target.value.replace(/\D/g, '') })}
              />
            </div>
            {is_tiebreak_row(one) && (
              <div className="form__row">
                <TextInput label="Tiebreak, team 1" inputMode="numeric" value={one.tiebreak_one} hint="Optional" onChange={(event) => update(position, { tiebreak_one: event.target.value.replace(/\D/g, '') })} />
                <TextInput label="Tiebreak, team 2" inputMode="numeric" value={one.tiebreak_two} hint="Optional" onChange={(event) => update(position, { tiebreak_two: event.target.value.replace(/\D/g, '') })} />
              </div>
            )}
          </fieldset>
        ))}
        <div className="row">
          {row.length < match.best_of_count && (
            <Button tone="secondary" size="sm" icon={<Plus size={16} aria-hidden />} onClick={() => setRow([...row, { one: '', two: '', tiebreak_one: '', tiebreak_two: '' }])}>
              Add {unit.toLowerCase()}
            </Button>
          )}
          {row.length > 1 && (
            <Button tone="quiet" size="sm" onClick={() => setRow(row.slice(0, -1))}>
              Remove last {unit.toLowerCase()}
            </Button>
          )}
        </div>
        <TextArea
          label="Reason"
          hint="Shown in the result's history, with your name."
          value={reason}
          maxLength={500}
          onChange={(event) => setReason(event.target.value)}
        />
        {is_submitted && !reason.trim() && <p className="field__error">A correction needs a reason.</p>}
        {match.correction.length > 0 && (
          <div className="stack">
            <h3>Earlier corrections</h3>
            <ul className="score-history">
              {match.correction.map((one) => (
                <li key={one.score_correction_id}>
                  <span className="mono">
                    {gameSummary(one.previous_game_point)} → {gameSummary(one.corrected_game_point)}
                  </span>{' '}
                  — {one.reason}
                  <div className="muted">
                    {one.actor_display_name ?? 'Staff'} · {formatDateTime(one.created_at)}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </form>
    </Dialog>
  )
}

function DiscardDialog({ match, onClose, onDone }: { match: MatchView; onClose: () => void; onDone: () => void }) {
  const discard = useAction(async () => operatorFetch(`/api/v1/score/match/${match.score_match_id}/discard`, { method: 'POST' }))
  return (
    <Dialog
      open
      title="Discard this match?"
      onClose={onClose}
      footer={
        <>
          <Button tone="quiet" onClick={onClose}>
            Keep it
          </Button>
          <Button
            tone="danger"
            disabled={discard.is_pending}
            onClick={async () => {
              if ((await discard.run()) !== undefined) onDone()
            }}
          >
            Discard match
          </Button>
        </>
      }
    >
      <ErrorAlert error={discard.error} onDismiss={discard.clearError} />
      <p>
        {match.team[0].display_name} vs {match.team[1].display_name}
        {match.court_display_name ? ` on ${match.court_display_name}` : ''} will be removed with its score. Use this for a match started by mistake.
      </p>
    </Dialog>
  )
}

// ---- the scorer --------------------------------------------------------------

function project(match: MatchView, queue: PendingOperation[]): { profile: ScoringProfile; state: ScoreState; view: StateView } {
  const profile = profileOf(match)
  let state = replay(
    profile,
    match.operation.map((one) => one.operation),
  )
  for (const one of queue) {
    const result = applyOperation(state, one.operation, profile)
    // A queued tap the rules no longer allow is skipped here; the server refuses it too.
    if (result.is_ok) state = result.state
  }
  return { profile, state, view: describeState(state, profile) }
}

function Scorer({ score_match_id }: { score_match_id: string }) {
  const { can } = useOperator()
  const can_manage = can('score.manage')
  const [match, setMatchState] = useState<MatchView | undefined>(() => readStored<MatchView | undefined>(CACHE_KEY(score_match_id), undefined))
  const [queue, setQueueState] = useState<PendingOperation[]>(() => readStored<PendingOperation[]>(QUEUE_KEY(score_match_id), []))
  const queue_ref = useRef(queue)
  const is_flushing = useRef(false)
  const [is_offline, setOffline] = useState(false)
  const [is_missing, setMissing] = useState(false)
  const [load_error, setLoadError] = useState<Error>()
  const [notice, setNotice] = useState<string>()
  const [dialog, setDialog] = useState<'server' | 'forfeit' | 'confirm'>()

  const setMatch = useCallback(
    (next: MatchView) => {
      writeStored(CACHE_KEY(score_match_id), next)
      setMatchState(next)
    },
    [score_match_id],
  )

  const setQueue = useCallback(
    (next: PendingOperation[]) => {
      queue_ref.current = next
      writeStored(QUEUE_KEY(score_match_id), next)
      setQueueState(next)
    },
    [score_match_id],
  )

  const refresh = useCallback(async () => {
    try {
      const body = await operatorFetch<{ match: MatchView }>(`/api/v1/score/match/${score_match_id}`)
      setMatch(body.match)
      setOffline(false)
      setLoadError(undefined)
    } catch (error) {
      if (!(error instanceof ApiError)) setOffline(true)
      else if (error.status === 404) setMissing(true)
      else if (error.status >= 500) setOffline(true)
      else setLoadError(error)
    }
  }, [score_match_id, setMatch])

  const flush = useCallback(async () => {
    if (is_flushing.current) return
    is_flushing.current = true
    try {
      while (queue_ref.current.length > 0) {
        const next = queue_ref.current[0]!
        try {
          const body = await operatorFetch<{ match: MatchView }>(
            `/api/v1/score/match/${score_match_id}/operation`,
            jsonBody({ client_operation_id: next.client_operation_id, ...next.operation }),
          )
          setMatch(body.match)
          setOffline(false)
          setQueue(queue_ref.current.filter((one) => one.client_operation_id !== next.client_operation_id))
        } catch (error) {
          if (!(error instanceof ApiError) || error.status >= 500) {
            // Unreachable: keep the tap and retry on the next tick.
            setOffline(true)
            return
          }
          if (error.status === 401 || error.status === 429) return
          // The server refused this tap for a reason; drop it and say so.
          setQueue(queue_ref.current.filter((one) => one.client_operation_id !== next.client_operation_id))
          setNotice(`A tap was not saved: ${error.message}`)
          if (error.status === 404) {
            setMissing(true)
            return
          }
        }
      }
    } finally {
      is_flushing.current = false
    }
  }, [score_match_id, setMatch, setQueue])

  useEffect(() => {
    void refresh().then(() => flush())
    const reconnect = () => {
      void flush().then(() => refresh())
    }
    window.addEventListener('online', reconnect)
    return () => window.removeEventListener('online', reconnect)
  }, [refresh, flush])

  useInterval(() => {
    if (queue_ref.current.length > 0) void flush()
    else void refresh()
  }, 4_000)

  const projected = useMemo(() => (match ? project(match, queue) : undefined), [match, queue])

  const confirm = useAction(async () => {
    const body = await operatorFetch<{ match: MatchView }>(`/api/v1/score/match/${score_match_id}/confirm`, { method: 'POST' })
    setMatch(body.match)
    return body.match
  })

  if (!match || !projected) {
    return (
      <>
        <ButtonLink to="/operator/score" tone="quiet" size="sm" icon={<ArrowLeft size={16} aria-hidden />}>
          All matches
        </ButtonLink>
        {is_missing ? (
          <EmptyState title="This match no longer exists" description="It may have been discarded on another device." action={<ButtonLink to="/operator/score">Back to scoring</ButtonLink>} />
        ) : load_error ? (
          <Alert severity="danger" title="Could not load this match">
            <p>{load_error.message}</p>
            <Button tone="secondary" size="sm" onClick={() => void refresh()}>
              Try again
            </Button>
          </Alert>
        ) : is_offline ? (
          <Alert severity="caution" title="Offline">
            This match has not been opened on this tablet before, so there is no saved score to show. It will load when the connection returns.
          </Alert>
        ) : (
          <Loading label="Loading the match…" />
        )}
      </>
    )
  }

  const { view } = projected
  const is_confirmed = match.status === 'confirmed'
  const can_tap = can_manage && !is_confirmed && !view.is_complete && !view.is_game_decided
  const pending_count = queue.length
  const ends_match =
    view.game_winner_team_number !== null &&
    view.team[view.game_winner_team_number - 1]!.game_won_count + 1 >= Math.floor(match.best_of_count / 2) + 1

  const enqueue = (operation: ScoreOperation) => {
    if (!can_manage || is_confirmed) return
    const result = applyOperation(projected.state, operation, projected.profile)
    if (!result.is_ok) {
      setNotice(result.reason)
      return
    }
    setNotice(undefined)
    setQueue([...queue_ref.current, { client_operation_id: mintClientId(), operation, queued_at: new Date().toISOString() }])
    void flush()
  }

  return (
    <div className="scorer">
      <div className="row row--between scorer__top">
        <ButtonLink to="/operator/score" tone="quiet" size="sm" icon={<ArrowLeft size={16} aria-hidden />}>
          All matches
        </ButtonLink>
        <div className="row">
          {pending_count > 0 && !is_offline && <Badge tone="info">Saving {pending_count}…</Badge>}
          <StatusBadge match={match} />
        </div>
      </div>

      <header className="scorer__header">
        <h1>{match.court_display_name ?? 'Match'}</h1>
        <p className="muted">
          {match.sport_display_name} · {match.rule_description}
        </p>
      </header>

      {is_offline && (
        <Alert severity="caution" title={pending_count > 0 ? `Offline — ${pending_count} ${pending_count === 1 ? 'point' : 'points'} waiting to sync` : 'Offline — showing the score saved on this tablet'}>
          <span className="row">
            <WifiSlash size={18} aria-hidden /> Keep scoring. Taps are saved on this tablet and sent in order when the connection returns.
          </span>
        </Alert>
      )}
      {notice && <Alert severity="caution" title={notice} onDismiss={() => setNotice(undefined)} />}

      <div className="scorer__call" aria-live="polite">
        <span className="scorer__call-label">{view.is_complete ? 'Final' : 'Call'}</span>
        <span className="scorer__call-value">{view.is_complete ? gameSummary(view.game_history) || 'Forfeit' : view.call_out}</span>
        <span className="scorer__call-headline">{withName(match, view.headline)}</span>
      </div>

      <div className="scorer__court">
        {([1, 2] as const).map((team_number) => {
          const team = match.team[team_number - 1]!
          const score = view.team[team_number - 1]!
          const is_serving = !view.is_complete && view.serving_team_number === team_number
          return (
            <button
              key={team_number}
              type="button"
              className={`scorer__team${is_serving ? ' is-serving' : ''}${view.winner_team_number === team_number ? ' is-winner' : ''}`}
              disabled={!can_tap}
              onClick={() => enqueue({ kind: 'rally_won', team_number })}
              aria-label={`Rally won by ${team.display_name}. ${score.point_label} points.`}
            >
              <span className="scorer__team-name">{team.display_name}</span>
              <span className="scorer__point">{score.point_label}</span>
              <span className="scorer__meta">
                {view.unit_label === 'set'
                  ? `Sets ${score.game_won_count} · Games ${score.game_count}`
                  : match.best_of_count > 1
                    ? `Games won ${score.game_won_count}`
                    : ' '}
              </span>
              <span className={`scorer__serve${is_serving ? '' : ' scorer__serve--idle'}`}>
                {view.is_complete ? (view.winner_team_number === team_number ? 'Winner' : ' ') : is_serving ? `Serving${view.server_number ? ` · Server ${view.server_number}` : ''}` : 'Receiving'}
              </span>
              {can_tap && <span className="scorer__hint">Tap when they win the rally</span>}
            </button>
          )
        })}
      </div>

      {view.game_history.length > 0 && (
        <ol className="scorer__history" aria-label="Finished games">
          {view.game_history.map((game) => (
            <li key={game.game_number}>
              {view.unit_label === 'set' ? 'Set' : 'Game'} {game.game_number}: <span className="mono">{gameSummary([game])}</span>
            </li>
          ))}
        </ol>
      )}

      {can_manage && !is_confirmed && view.is_game_decided && (
        <Alert severity="info" title={withName(match, view.headline)}>
          <div className="stack">
            <p>Check the score, then end the {view.unit_label}. A mis-tap can still be undone.</p>
            <div>
              <Button size="lg" onClick={() => enqueue({ kind: 'end_game' })}>
                {ends_match ? `End ${view.unit_label} and finish the match` : `End ${view.unit_label} ${view.game_number} and start the next`}
              </Button>
            </div>
          </div>
        </Alert>
      )}

      {can_manage && !is_confirmed && view.is_complete && (
        <Alert severity="success" title={`Match over — ${withName(match, view.headline)}`}>
          <div className="stack">
            <p>Confirm the result to lock it. After that it can only change through a recorded correction.</p>
            <ErrorAlert error={confirm.error} onDismiss={confirm.clearError} />
            <div className="row">
              <Button size="lg" disabled={pending_count > 0 || confirm.is_pending} onClick={() => setDialog('confirm')}>
                Confirm result
              </Button>
              {pending_count > 0 && <span className="muted">Waiting for the last taps to save…</span>}
            </div>
          </div>
        </Alert>
      )}

      {is_confirmed && (
        <Alert severity="success" title={`Result confirmed — ${withName(match, view.headline)}`}>
          Confirmed{match.confirmed_by_display_name ? ` by ${match.confirmed_by_display_name}` : ''}
          {match.confirmed_at ? ` · ${formatDateTime(match.confirmed_at)}` : ''}. Corrections are made from the results list.
        </Alert>
      )}

      {can_manage && !is_confirmed && (
        <div className="scorer__control">
          <Button tone="secondary" size="lg" icon={<ArrowCounterClockwise size={20} aria-hidden />} disabled={!view.can_undo} onClick={() => enqueue({ kind: 'undo' })}>
            Undo
          </Button>
          {!view.is_complete && !view.is_game_decided && (
            <>
              <Button tone="quiet" size="lg" icon={<ArrowsLeftRight size={20} aria-hidden />} onClick={() => setDialog('server')}>
                Change server
              </Button>
              <Button tone="quiet" size="lg" icon={<Flag size={20} aria-hidden />} onClick={() => setDialog('forfeit')}>
                Forfeit
              </Button>
            </>
          )}
        </div>
      )}

      {dialog === 'server' && (
        <ServerDialog
          match={match}
          view={view}
          onClose={() => setDialog(undefined)}
          onPick={(team_number, server_number) => {
            setDialog(undefined)
            enqueue({ kind: 'set_server', team_number, server_number })
          }}
        />
      )}
      {dialog === 'forfeit' && (
        <ForfeitDialog
          match={match}
          onClose={() => setDialog(undefined)}
          onPick={(team_number) => {
            setDialog(undefined)
            enqueue({ kind: 'forfeit', team_number })
          }}
        />
      )}
      {dialog === 'confirm' && (
        <Dialog
          open
          title="Confirm this result?"
          onClose={() => setDialog(undefined)}
          footer={
            <>
              <Button tone="quiet" onClick={() => setDialog(undefined)}>
                Not yet
              </Button>
              <Button
                disabled={confirm.is_pending}
                onClick={async () => {
                  setDialog(undefined)
                  await confirm.run()
                }}
              >
                Confirm result
              </Button>
            </>
          }
        >
          <p>
            <strong>{withName(match, view.headline)}</strong> ({gameSummary(view.game_history)})
          </p>
          <p className="muted">The score will be locked. Only a recorded correction can change it.</p>
        </Dialog>
      )}
    </div>
  )
}

function ServerDialog({
  match,
  view,
  onClose,
  onPick,
}: {
  match: MatchView
  view: StateView
  onClose: () => void
  onPick: (team_number: TeamNumber, server_number: 1 | 2 | null) => void
}) {
  const doubles = isDoublesSideOut(match)
  const [team, setTeam] = useState(String(view.serving_team_number))
  const [server, setServer] = useState(String(view.server_number ?? 1))
  return (
    <Dialog
      open
      title="Change server"
      onClose={onClose}
      footer={
        <>
          <Button tone="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => onPick(Number(team) as TeamNumber, doubles ? (Number(server) as 1 | 2) : null)}>Set server</Button>
        </>
      }
    >
      <p className="muted">Use this when the wrong team or player started serving. It is recorded like any tap and can be undone.</p>
      <div className="form__row">
        <SelectInput label="Serving team" value={team} onChange={(event) => setTeam(event.target.value)} option={match.team.map((one) => ({ value: String(one.team_number), label: one.display_name }))} />
        {doubles && (
          <SelectInput
            label="Server"
            value={server}
            onChange={(event) => setServer(event.target.value)}
            option={[
              { value: '1', label: 'Server 1' },
              { value: '2', label: 'Server 2' },
            ]}
          />
        )}
      </div>
    </Dialog>
  )
}

function ForfeitDialog({ match, onClose, onPick }: { match: MatchView; onClose: () => void; onPick: (team_number: TeamNumber) => void }) {
  const [team, setTeam] = useState('1')
  const winner = match.team[Number(team) === 1 ? 1 : 0].display_name
  return (
    <Dialog
      open
      title="Record a forfeit"
      onClose={onClose}
      footer={
        <>
          <Button tone="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button tone="danger" onClick={() => onPick(Number(team) as TeamNumber)}>
            Record forfeit
          </Button>
        </>
      }
    >
      <SelectInput label="Team that forfeits" value={team} onChange={(event) => setTeam(event.target.value)} option={match.team.map((one) => ({ value: String(one.team_number), label: one.display_name }))} />
      <p>
        The match ends now and <strong>{winner}</strong> win. You can still undo before confirming.
      </p>
    </Dialog>
  )
}
