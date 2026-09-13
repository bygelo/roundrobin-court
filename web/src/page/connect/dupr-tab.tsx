// DUPR tab: honest connection status, consented player links, submissions.

import { ArrowClockwise, LinkSimple, Plus, Trash } from '@phosphor-icons/react'
import { useState, type FormEvent } from 'react'
import { jsonBody, operatorFetch } from '../../api.ts'
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Dialog,
  EmptyState,
  ErrorAlert,
  ResourceView,
  TextInput,
  type BadgeTone,
} from '../../component/ui.tsx'
import { formatDate, formatDateTime } from '../../format.ts'
import { useAction, useResource } from '../../hook.ts'
import { useOperator } from '../../session.tsx'
import { ConfirmDialog } from './shared.tsx'

type StatusCode = 'not_configured' | 'sandbox' | 'connected' | 'error'

type DuprStatus = {
  status_code: StatusCode
  mode_code: 'sandbox' | 'live' | null
  last_validated_at: string | null
  last_error: string | null
  is_sandbox_allowed: boolean
  is_live_configured: boolean
  player_link_count: number
  submission_count: number
}

type PlayerLink = {
  dupr_player_link_id: string
  display_name: string
  dupr_id: string
  consent_at: string
  doubles_rating: string | null
  singles_rating: string | null
  rating_source_code: string | null
  rating_fetched_at: string | null
  is_stale: boolean
}

type Submission = {
  dupr_submission_id: string
  match_label: string
  status_code: 'pending' | 'submitted' | 'rejected'
  receipt_code: string | null
  rejection_code: string | null
  rejection_message: string | null
  last_error: string | null
  attempt_count: number
  last_attempted_at: string | null
  created_at: string
}

const STATUS_BADGE: Record<StatusCode, { tone: BadgeTone; label: string }> = {
  not_configured: { tone: 'neutral', label: 'Not configured' },
  sandbox: { tone: 'info', label: 'Sandbox' },
  connected: { tone: 'success', label: 'Connected' },
  error: { tone: 'danger', label: 'Error' },
}

const SUBMISSION_BADGE: Record<Submission['status_code'], { tone: BadgeTone; label: string }> = {
  pending: { tone: 'caution', label: 'Pending' },
  submitted: { tone: 'success', label: 'Submitted' },
  rejected: { tone: 'danger', label: 'Rejected' },
}

export default function DuprTab() {
  const { can } = useOperator()
  const can_manage = can('dupr.manage')
  const status = useResource(() => operatorFetch<{ status: DuprStatus }>('/api/v1/dupr/status').then((one) => one.status))
  const link = useResource(() =>
    operatorFetch<{ player_link: PlayerLink[] }>('/api/v1/dupr/player-link').then((one) => one.player_link),
  )
  const submission = useResource(() =>
    operatorFetch<{ submission: Submission[] }>('/api/v1/dupr/submission').then((one) => one.submission),
  )
  const [notice, setNotice] = useState<string>()
  const [is_disconnect_open, setDisconnectOpen] = useState(false)
  const [is_add_open, setAddOpen] = useState(false)
  const [removing, setRemoving] = useState<PlayerLink>()

  const connect = useAction(async (mode_code: 'sandbox' | 'live') => {
    setNotice(undefined)
    try {
      await operatorFetch<{ status: DuprStatus }>('/api/v1/dupr/connection', jsonBody({ mode_code }))
      setNotice(mode_code === 'sandbox' ? 'Sandbox connected. Nothing is sent to the real DUPR.' : 'DUPR is connected.')
    } finally {
      status.reload()
    }
  })
  const disconnect = useAction(async () => {
    await operatorFetch('/api/v1/dupr/disconnect', { method: 'POST' })
    setDisconnectOpen(false)
    setNotice('DUPR is disconnected. Player links and past submissions are kept.')
    status.reload()
  })
  const remove = useAction(async (one: PlayerLink) => {
    await operatorFetch(`/api/v1/dupr/player-link/${one.dupr_player_link_id}`, { method: 'DELETE' })
    setRemoving(undefined)
    setNotice(`Removed the DUPR link for ${one.display_name}.`)
    link.reload()
    status.reload()
  })
  const retry = useAction(async (one: Submission) => {
    const result = await operatorFetch<{ submission: Submission }>(
      `/api/v1/dupr/submission/${one.dupr_submission_id}/retry`,
      { method: 'POST' },
    )
    setNotice(
      result.submission.status_code === 'submitted'
        ? `${one.match_label} was accepted by DUPR.`
        : result.submission.status_code === 'rejected'
          ? `DUPR still refused ${one.match_label}. See the reason below.`
          : `DUPR did not answer. ${one.match_label} stays queued.`,
    )
    submission.reload()
  })

  return (
    <div className="stack--lg">
      {notice && (
        <Alert severity="success" onDismiss={() => setNotice(undefined)}>
          {notice}
        </Alert>
      )}

      <ResourceView resource={status}>
        {(data) => {
          const badge = STATUS_BADGE[data.status_code]
          const is_working = data.status_code === 'sandbox' || data.status_code === 'connected'
          return (
            <Card
              title={
                <span className="row">
                  DUPR <Badge tone={badge.tone}>{badge.label}</Badge>
                </span>
              }
              description={
                data.last_validated_at ? `Last checked ${formatDateTime(data.last_validated_at)}` : 'Never checked'
              }
              action={
                can_manage ? (
                  is_working ? (
                    <Button tone="danger" size="sm" onClick={() => setDisconnectOpen(true)}>
                      Disconnect
                    </Button>
                  ) : (
                    <>
                      <Button
                        tone="secondary"
                        size="sm"
                        disabled={connect.is_pending || !data.is_sandbox_allowed}
                        onClick={() => connect.run('sandbox')}
                      >
                        Try the sandbox
                      </Button>
                      <Button size="sm" icon={<LinkSimple size={16} aria-hidden />} disabled={connect.is_pending} onClick={() => connect.run('live')}>
                        {connect.is_pending ? 'Checking…' : 'Connect DUPR'}
                      </Button>
                    </>
                  )
                ) : undefined
              }
            >
              <div className="stack">
                <div className="connect-explainer">
                  <p>
                    Connecting DUPR lets this venue check a player's DUPR rating for rated sessions and send confirmed match
                    results to DUPR, so ratings update no matter which app hosted the game.
                  </p>
                  <ul>
                    <li>DUPR must approve your club first (usually 3–5 business days). It then issues partner credentials for this server.</li>
                    <li>Every player needs a DUPR ID and must agree before their results are shared.</li>
                    <li>Disconnecting stops sending. Your player links and match results stay here.</li>
                  </ul>
                  {data.status_code === 'sandbox' && (
                    <p className="muted">Sandbox mode uses test data only. Nothing reaches the real DUPR.</p>
                  )}
                  {!data.is_sandbox_allowed && !is_working && (
                    <p className="muted">The sandbox is off on this server (set DUPR_MODE=sandbox to rehearse).</p>
                  )}
                </div>
                {data.last_error && data.status_code !== 'sandbox' && data.status_code !== 'connected' && (
                  <Alert severity={data.status_code === 'error' ? 'danger' : 'caution'} title="Not connected">
                    {data.last_error}
                  </Alert>
                )}
                <ErrorAlert error={connect.error} onDismiss={connect.clearError} />
              </div>
            </Card>
          )
        }}
      </ResourceView>

      <Card
        title="Player links"
        description="Players whose DUPR ID is linked with their consent."
        action={
          can_manage ? (
            <Button size="sm" icon={<Plus size={16} aria-hidden />} onClick={() => setAddOpen(true)}>
              Link a player
            </Button>
          ) : undefined
        }
      >
        <ResourceView resource={link}>
          {(row) =>
            row.length === 0 ? (
              <EmptyState
                title="No players linked yet"
                description="Link a player's DUPR ID to check their rating and include their matches in DUPR submissions."
                action={
                  can_manage ? (
                    <Button size="sm" onClick={() => setAddOpen(true)}>
                      Link a player
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <div className="table-wrap" tabIndex={0}>
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Player</th>
                      <th scope="col">DUPR ID</th>
                      <th scope="col">Rating</th>
                      <th scope="col">Consent</th>
                      <th scope="col">
                        <span className="visually-hidden">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {row.map((one) => (
                      <tr key={one.dupr_player_link_id}>
                        <td>{one.display_name}</td>
                        <td className="mono">{one.dupr_id}</td>
                        <td>
                          <div className="stack" style={{ gap: 'var(--space-1)' }}>
                            <span>
                              {one.doubles_rating ? `Doubles ${one.doubles_rating}` : 'No doubles rating'}
                              {one.singles_rating ? ` · Singles ${one.singles_rating}` : ''}
                            </span>
                            <span className="row" style={{ gap: 'var(--space-2)' }}>
                              {one.rating_fetched_at && (
                                <span className="muted">
                                  as of {formatDate(one.rating_fetched_at)}
                                  {one.rating_source_code === 'dupr_sandbox' ? ' (sandbox)' : ''}
                                </span>
                              )}
                              {one.is_stale && <Badge tone="caution">Stale</Badge>}
                            </span>
                          </div>
                        </td>
                        <td>
                          <Badge tone="success">Consent {formatDate(one.consent_at)}</Badge>
                        </td>
                        <td>
                          {can_manage && (
                            <div className="connect-cell-action">
                              <Button
                                tone="quiet"
                                size="sm"
                                icon={<Trash size={16} aria-hidden />}
                                onClick={() => setRemoving(one)}
                                aria-label={`Remove DUPR link for ${one.display_name}`}
                              >
                                Remove
                              </Button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          }
        </ResourceView>
      </Card>

      <Card title="Submissions" description="Confirmed match results sent to DUPR. Submit a match from Scoring once its score is confirmed.">
        <div className="stack">
          <ErrorAlert error={retry.error} onDismiss={retry.clearError} />
          <ResourceView resource={submission}>
            {(row) =>
              row.length === 0 ? (
                <EmptyState
                  title="No results sent yet"
                  description="When a confirmed match is submitted, its DUPR receipt or the reason DUPR refused it appears here."
                />
              ) : (
                <div className="table-wrap" tabIndex={0}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Match</th>
                        <th scope="col">Status</th>
                        <th scope="col">Detail</th>
                        <th scope="col">Attempts</th>
                        <th scope="col">
                          <span className="visually-hidden">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {row.map((one) => {
                        const badge = SUBMISSION_BADGE[one.status_code]
                        return (
                          <tr key={one.dupr_submission_id}>
                            <td>
                              <div>{one.match_label}</div>
                              <div className="muted">{formatDateTime(one.created_at)}</div>
                            </td>
                            <td>
                              <Badge tone={badge.tone}>{badge.label}</Badge>
                            </td>
                            <td className="connect-detail">
                              {one.status_code === 'submitted' && (
                                <span>
                                  Receipt <span className="mono">{one.receipt_code}</span>
                                </span>
                              )}
                              {one.status_code === 'rejected' && <span>{one.rejection_message}</span>}
                              {one.status_code === 'pending' && <span>{one.last_error ?? 'Waiting to send.'}</span>}
                            </td>
                            <td>{one.attempt_count}</td>
                            <td>
                              {can_manage && one.status_code !== 'submitted' && (
                                <div className="connect-cell-action">
                                  <Button
                                    tone="secondary"
                                    size="sm"
                                    icon={<ArrowClockwise size={16} aria-hidden />}
                                    disabled={retry.is_pending}
                                    onClick={() => retry.run(one)}
                                  >
                                    Retry
                                  </Button>
                                </div>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )
            }
          </ResourceView>
        </div>
      </Card>

      <AddLinkDialog
        open={is_add_open}
        onClose={() => setAddOpen(false)}
        onLinked={(one) => {
          setAddOpen(false)
          setNotice(
            `Linked ${one.display_name} (${one.dupr_id})${one.doubles_rating ? ` — doubles ${one.doubles_rating}` : ''}.`,
          )
          link.reload()
          status.reload()
        }}
      />

      <ConfirmDialog
        open={is_disconnect_open}
        title="Disconnect DUPR?"
        confirm_label="Disconnect"
        is_pending={disconnect.is_pending}
        onConfirm={() => disconnect.run()}
        onClose={() => setDisconnectOpen(false)}
      >
        <div className="stack">
          <p>New results will no longer be sent to DUPR and ratings will stop refreshing. Player links and every past result stay here.</p>
          <ErrorAlert error={disconnect.error} />
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={removing !== undefined}
        title="Remove this DUPR link?"
        confirm_label="Remove link"
        is_pending={remove.is_pending}
        onConfirm={() => removing && remove.run(removing)}
        onClose={() => setRemoving(undefined)}
      >
        <div className="stack">
          <p>
            {removing?.display_name}'s matches can't be sent to DUPR until they are linked again. Results already sent are not
            affected.
          </p>
          <ErrorAlert error={remove.error} />
        </div>
      </ConfirmDialog>
    </div>
  )
}

function AddLinkDialog({
  open,
  onClose,
  onLinked,
}: {
  open: boolean
  onClose: () => void
  onLinked: (one: PlayerLink) => void
}) {
  const [display_name, setName] = useState('')
  const [dupr_id, setDuprId] = useState('')
  const [has_consent, setConsent] = useState(false)
  const save = useAction(async () => {
    const result = await operatorFetch<{ player_link: PlayerLink }>(
      '/api/v1/dupr/player-link',
      jsonBody({ display_name, dupr_id, has_consent }),
    )
    setName('')
    setDuprId('')
    setConsent(false)
    onLinked(result.player_link)
  })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    void save.run()
  }
  const is_ready = display_name.trim() !== '' && dupr_id.trim() !== '' && has_consent

  return (
    <Dialog open={open} title="Link a player's DUPR ID" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <TextInput label="Player name" value={display_name} onChange={(event) => setName(event.target.value)} required autoFocus />
        <TextInput
          label="DUPR ID"
          hint="Shown on the player's profile in the DUPR app."
          value={dupr_id}
          onChange={(event) => setDuprId(event.target.value)}
          required
          autoComplete="off"
        />
        <Checkbox
          label="The player agreed that this venue may read their DUPR rating and send their match results to DUPR."
          checked={has_consent}
          onChange={(event) => setConsent(event.target.checked)}
        />
        <ErrorAlert error={save.error} onDismiss={save.clearError} />
        <div className="form__action">
          <Button type="submit" disabled={!is_ready || save.is_pending}>
            {save.is_pending ? 'Checking with DUPR…' : 'Link player'}
          </Button>
          <Button tone="quiet" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
