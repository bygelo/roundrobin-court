// Operator → Displays. Add a TV for the lounge, the counter, or a court; open
// its private link on the TV once; see whether each screen is still showing.

import { Copy, Plus, Television } from '@phosphor-icons/react'
import { useState, type FormEvent } from 'react'
import { jsonBody, operatorFetch } from '../../api.ts'
import {
  Alert,
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorAlert,
  PageHeader,
  ResourceView,
  SelectInput,
  TextInput,
  type BadgeTone,
} from '../../component/ui.tsx'
import { formatDateTime } from '../../format.ts'
import { useAction, useInterval, useResource } from '../../hook.ts'
import type { PageProp } from '../../registry.ts'
import { useOperator } from '../../session.tsx'
import './display.css'

type DisplayKind = 'court' | 'lounge' | 'counter' | 'kiosk'
type ScreenStatus = 'online' | 'stale' | 'offline' | 'revoked'

type Screen = {
  display_screen_id: string
  kind: DisplayKind
  display_name: string
  resource_id: string | null
  court_display_name: string | null
  status: ScreenStatus
  enrolled_at: string | null
  last_seen_at: string | null
  config_version: number
  reported_config_version: number | null
  is_config_behind: boolean
  site_version_number: number
  reported_site_version_number: number | null
  site_version_reported_at: string | null
  is_site_behind: boolean
  created_at: string
  revoked_at: string | null
}

type Court = { resource_id: string; display_name: string }

const KIND_LABEL: Record<DisplayKind, string> = {
  lounge: 'Lounge board',
  court: 'Court scoreboard',
  counter: 'Counter',
  kiosk: 'Lobby kiosk',
}

const KIND_DESCRIPTION: Record<DisplayKind, string> = {
  lounge: 'Every court’s live score, open play now and up next, and the next bookings.',
  court: 'One court: who is playing, the live score, and when the court is booked.',
  counter: 'The next open courts today and how many players are expected.',
  kiosk: 'A self-service tablet: open courts in the next few hours, open play, today’s programs, and a QR code to book on a phone. No player names.',
}

const KIND_ORDER: DisplayKind[] = ['lounge', 'court', 'counter', 'kiosk']

const SUGGESTED_NAME: Record<Exclude<DisplayKind, 'court'>, string> = {
  lounge: 'Lounge TV',
  counter: 'Front counter',
  kiosk: 'Lobby kiosk',
}

function siteVersionLabel(version_number: number): string {
  return version_number === 0 ? 'default look' : `v${version_number}`
}

const STATUS: Record<ScreenStatus, { tone: BadgeTone; label: string }> = {
  online: { tone: 'success', label: 'Online' },
  stale: { tone: 'caution', label: 'Stale' },
  offline: { tone: 'neutral', label: 'Offline' },
  revoked: { tone: 'danger', label: 'Revoked' },
}

export default function Page(_prop: PageProp) {
  const { can } = useOperator()
  const can_manage = can('display.manage')
  const screen = useResource(async () => {
    const [list, court] = await Promise.all([
      operatorFetch<{ screen: Screen[] }>('/api/v1/display/screen'),
      operatorFetch<{ court: Court[] }>('/api/v1/display/court'),
    ])
    return { screen: list.screen, court: court.court }
  }, [])
  useInterval(screen.reload, 15_000)

  const [is_adding, setAdding] = useState(false)
  const [enrolment, setEnrolment] = useState<{ screen: Screen; url: string }>()
  const [revoking, setRevoking] = useState<Screen>()
  const [notice, setNotice] = useState<string>()

  const add_button = can_manage ? (
    <Button icon={<Plus size={18} aria-hidden />} onClick={() => setAdding(true)}>
      Add screen
    </Button>
  ) : undefined

  return (
    <>
      <PageHeader
        eyebrow="Play"
        title="Displays"
        description="TVs and lobby tablets that show live scores, open play, and open courts in your published Studio look. Each screen has its own private link and refreshes itself every few seconds."
        action={add_button}
      />
      {notice && <Alert severity="success" title={notice} onDismiss={() => setNotice(undefined)} />}
      <ResourceView resource={screen}>
        {({ screen: list, court }) =>
          list.length === 0 ? (
            <EmptyState
              title="No screens yet"
              description="Add a screen, then open its link on the TV in your lounge, at the counter, or beside a court."
              action={add_button}
            />
          ) : (
            <div className="table-wrap" tabIndex={0}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Screen</th>
                    <th>Status</th>
                    <th>Last seen</th>
                    <th>Site version</th>
                    <th>
                      <span className="visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((one) => (
                    <tr key={one.display_screen_id}>
                      <td>
                        <strong>{one.display_name}</strong>
                        <div className="muted">
                          {KIND_LABEL[one.kind]}
                          {one.court_display_name ? ` · ${one.court_display_name}` : ''}
                        </div>
                      </td>
                      <td>
                        <Badge tone={STATUS[one.status].tone}>{STATUS[one.status].label}</Badge>
                      </td>
                      <td>
                        {one.revoked_at
                          ? `Removed ${formatDateTime(one.revoked_at)}`
                          : one.last_seen_at
                            ? formatDateTime(one.last_seen_at)
                            : 'Never connected — open its link on the TV'}
                      </td>
                      <td>
                        <span className="row display-admin__version">
                          {one.reported_site_version_number === null
                            ? 'Not reported yet'
                            : `Showing ${siteVersionLabel(one.reported_site_version_number)}`}
                          {one.is_site_behind && one.status !== 'revoked' && (
                            <Badge tone="caution">Behind · published is {siteVersionLabel(one.site_version_number)}</Badge>
                          )}
                          {one.is_config_behind && one.status !== 'revoked' && <Badge tone="caution">Update pending</Badge>}
                        </span>
                      </td>
                      <td>
                        {can_manage && one.status !== 'revoked' && (
                          <Button tone="danger" size="sm" onClick={() => setRevoking(one)}>
                            Remove
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {court.length === 0 && <p className="muted display-admin__note">Add courts in Venue setup to create a court scoreboard.</p>}
            </div>
          )
        }
      </ResourceView>

      {is_adding && screen.data && (
        <AddScreenDialog
          court={screen.data.court}
          onClose={() => setAdding(false)}
          onCreated={(created) => {
            setAdding(false)
            setEnrolment({ screen: created.screen, url: `${window.location.origin}${created.enrolment_path}` })
            screen.reload()
          }}
        />
      )}
      {enrolment && <EnrolmentDialog screen={enrolment.screen} url={enrolment.url} onClose={() => setEnrolment(undefined)} />}
      {revoking && (
        <RevokeDialog
          screen={revoking}
          onClose={() => setRevoking(undefined)}
          onDone={() => {
            setNotice(`${revoking.display_name} was removed. It will stop showing venue information within a few seconds.`)
            setRevoking(undefined)
            screen.reload()
          }}
        />
      )}
    </>
  )
}

function AddScreenDialog({
  court,
  onClose,
  onCreated,
}: {
  court: Court[]
  onClose: () => void
  onCreated: (created: { screen: Screen; enrolment_path: string }) => void
}) {
  const [kind, setKind] = useState<DisplayKind>('lounge')
  const [resource_id, setCourt] = useState(court[0]?.resource_id ?? '')
  const [display_name, setName] = useState('Lounge TV')
  const [is_named, setNamed] = useState(false)
  const [is_submitted, setSubmitted] = useState(false)

  const suggest = (next_kind: DisplayKind, next_court: string) => {
    if (is_named) return
    const court_name = court.find((one) => one.resource_id === next_court)?.display_name
    setName(next_kind === 'court' ? `${court_name ?? 'Court'} TV` : SUGGESTED_NAME[next_kind])
  }

  const create = useAction(async () =>
    operatorFetch<{ screen: Screen; enrolment_path: string }>(
      '/api/v1/display/screen',
      jsonBody({ kind, display_name: display_name.trim(), resource_id: kind === 'court' ? resource_id : null }),
    ),
  )

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSubmitted(true)
    if (!display_name.trim() || (kind === 'court' && !resource_id)) return
    const created = await create.run()
    if (created) onCreated(created)
  }

  return (
    <Dialog
      open
      title="Add a screen"
      onClose={onClose}
      footer={
        <>
          <Button tone="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="add-screen" disabled={create.is_pending}>
            {create.is_pending ? 'Creating…' : 'Create screen link'}
          </Button>
        </>
      }
    >
      <form id="add-screen" className="form" onSubmit={submit} noValidate>
        <ErrorAlert error={create.error} onDismiss={create.clearError} />
        <SelectInput
          label="What it shows"
          value={kind}
          hint={KIND_DESCRIPTION[kind]}
          onChange={(event) => {
            const next = event.target.value as DisplayKind
            setKind(next)
            suggest(next, resource_id)
          }}
          option={KIND_ORDER.map((one) => ({ value: one, label: KIND_LABEL[one] }))}
        />
        {kind === 'court' &&
          (court.length === 0 ? (
            <Alert severity="caution" title="No courts yet">
              Add courts in Venue setup first.
            </Alert>
          ) : (
            <SelectInput
              label="Court"
              value={resource_id}
              onChange={(event) => {
                setCourt(event.target.value)
                suggest(kind, event.target.value)
              }}
              option={court.map((one) => ({ value: one.resource_id, label: one.display_name }))}
            />
          ))}
        <TextInput
          label="Screen name"
          hint="So staff can tell screens apart, like “Lounge TV”."
          value={display_name}
          maxLength={80}
          error={is_submitted && !display_name.trim() ? 'Give the screen a name' : undefined}
          onChange={(event) => {
            setNamed(true)
            setName(event.target.value)
          }}
        />
      </form>
    </Dialog>
  )
}

function EnrolmentDialog({ screen, url, onClose }: { screen: Screen; url: string; onClose: () => void }) {
  const [is_copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
    } catch {
      const field = document.getElementById('enrolment-link') as HTMLInputElement | null
      field?.select()
    }
  }
  return (
    <Dialog
      open
      title="Open this link on the TV"
      onClose={onClose}
      footer={
        <Button onClick={onClose} disabled={!is_copied && false}>
          Done
        </Button>
      }
    >
      <div className="display-enrol">
        <Television size={40} aria-hidden />
        <p>
          <strong>{screen.display_name}</strong> is ready. {KIND_DESCRIPTION[screen.kind]}
        </p>
      </div>
      <Alert severity="caution" title="This link is shown only once">
        Copy it now. Anyone with the link can see this screen. If it is lost, remove the screen and add it again.
      </Alert>
      <div className="display-enrol__link">
        <TextInput id="enrolment-link" label="Screen link" readOnly value={url} onFocus={(event) => event.target.select()} />
        <Button tone="secondary" icon={<Copy size={18} aria-hidden />} onClick={copy}>
          {is_copied ? 'Copied' : 'Copy link'}
        </Button>
      </div>
      {is_copied && <p className="muted" role="status">Link copied.</p>}
      <ol className="display-enrol__step">
        <li>On the TV, open the web browser.</li>
        <li>Paste or type the link above and open it.</li>
        <li>Make the browser full screen. The screen keeps itself up to date — nothing else to do.</li>
      </ol>
    </Dialog>
  )
}

function RevokeDialog({ screen, onClose, onDone }: { screen: Screen; onClose: () => void; onDone: () => void }) {
  const revoke = useAction(async () => operatorFetch(`/api/v1/display/screen/${screen.display_screen_id}/revoke`, { method: 'POST' }))
  return (
    <Dialog
      open
      title={`Remove ${screen.display_name}?`}
      onClose={onClose}
      footer={
        <>
          <Button tone="quiet" onClick={onClose}>
            Keep it
          </Button>
          <Button
            tone="danger"
            disabled={revoke.is_pending}
            onClick={async () => {
              if ((await revoke.run()) !== undefined) onDone()
            }}
          >
            {revoke.is_pending ? 'Removing…' : 'Remove screen'}
          </Button>
        </>
      }
    >
      <ErrorAlert error={revoke.error} onDismiss={revoke.clearError} />
      <p>The TV will stop showing venue information within a few seconds and say it was removed.</p>
      <p className="muted">This cannot be undone. To use the TV again, add a new screen and open its new link.</p>
    </Dialog>
  )
}
