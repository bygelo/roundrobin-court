// /v/:organization_code/privacy — a player asks for a copy of their data or
// to have it deleted, then checks the status with a private link (R24).

import { ShieldCheck } from '@phosphor-icons/react'
import { useState, type FormEvent } from 'react'
import { ApiError, jsonBody, publicFetch } from '../../api.ts'
import { Alert, Badge, Button, ButtonLink, Card, ErrorAlert, Loading, TextInput } from '../../component/ui.tsx'
import { formatDate } from '../../format.ts'
import { useAction, useResource } from '../../hook.ts'
import { usePublicSite } from '../../layout/public-shell.tsx'
import type { PageProp } from '../../registry.ts'
import { navigate, useQuery } from '../../route.tsx'
import { CopyButton } from './shared.tsx'

type RequestKind = 'access' | 'erasure'

type PrivacyStatus = {
  request_kind: RequestKind
  status: 'received' | 'completed' | 'closed'
  status_sentence: string
  created_at: string
  completed_at: string | null
}

const STATUS_LABEL = {
  received: { label: 'Received', tone: 'info' },
  completed: { label: 'Complete', tone: 'success' },
  closed: { label: 'Closed', tone: 'neutral' },
} as const

export default function Page({ param }: PageProp) {
  const organization_code = param['organization_code'] ?? ''
  const query = useQuery()
  const token = query.get('token')
  return (
    <div className="admin-privacy">
      {token ? (
        <StatusView organization_code={organization_code} token={token} is_just_sent={query.get('sent') === '1'} />
      ) : (
        <RequestForm organization_code={organization_code} />
      )}
    </div>
  )
}

function RequestForm({ organization_code }: { organization_code: string }) {
  const site = usePublicSite()
  const [request_kind, setKind] = useState<RequestKind>('access')
  const [email, setEmail] = useState('')
  const [booking_code, setBookingCode] = useState('')
  const send = useAction((body: unknown) =>
    publicFetch<{ status_token: string }>(`/public/${encodeURIComponent(organization_code)}/admin/privacy-request`, jsonBody(body)),
  )

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const result = await send.run({ request_kind, email: email.trim(), booking_code: booking_code.trim() })
    if (result) {
      navigate(`/v/${encodeURIComponent(organization_code)}/privacy?token=${encodeURIComponent(result.status_token)}&sent=1`)
    }
  }

  return (
    <>
      <header className="stack">
        <p className="eyebrow">
          <ShieldCheck size={16} weight="fill" aria-hidden /> Privacy
        </p>
        <h1>Your data at {site.display_name}</h1>
        <p>
          When you book a court, join open play, or sign up for a clinic, we keep your name, email, phone number, and a
          record of your bookings and payments. You can ask for a copy of it, or ask us to delete it.
        </p>
      </header>

      <Card>
        <form className="form" onSubmit={submit}>
          <ErrorAlert error={send.error} onDismiss={send.clearError} />
          <fieldset className="admin-choice">
            <legend>What would you like?</legend>
            <label className="admin-choice__option">
              <input
                type="radio"
                name="request_kind"
                value="access"
                checked={request_kind === 'access'}
                onChange={() => setKind('access')}
              />
              <span>
                <strong>Send me a copy of my data</strong>
                <small>Your profile, bookings, registrations, orders, and messages in one file.</small>
              </span>
            </label>
            <label className="admin-choice__option">
              <input
                type="radio"
                name="request_kind"
                value="erasure"
                checked={request_kind === 'erasure'}
                onChange={() => setKind('erasure')}
              />
              <span>
                <strong>Delete my data</strong>
                <small>
                  We remove your name, email, and phone number. Payment records stay without them, because we must keep
                  financial records.
                </small>
              </span>
            </label>
          </fieldset>
          <TextInput
            label="Email address"
            hint="The one you used when you booked."
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
          <TextInput
            label="Booking code"
            hint="It is on your booking confirmation. We use it to make sure the request is really yours."
            autoCapitalize="characters"
            value={booking_code}
            onChange={(event) => setBookingCode(event.target.value)}
            required
          />
          <div className="form__action">
            <Button type="submit" size="lg" disabled={send.is_pending}>
              {send.is_pending ? 'Sending…' : 'Send request'}
            </Button>
          </div>
        </form>
      </Card>

      <p className="muted">
        A person at the venue reviews every request and replies within 30 days. We never share your data with other
        players.
      </p>
    </>
  )
}

function StatusView({
  organization_code,
  token,
  is_just_sent,
}: {
  organization_code: string
  token: string
  is_just_sent: boolean
}) {
  const site = usePublicSite()
  const status = useResource(
    () =>
      publicFetch<{ privacy_request: PrivacyStatus }>(
        `/public/${encodeURIComponent(organization_code)}/admin/privacy-request/${encodeURIComponent(token)}`,
      ),
    [organization_code, token],
  )
  const status_link = `${window.location.origin}/v/${encodeURIComponent(organization_code)}/privacy?token=${encodeURIComponent(token)}`
  const form_link = `/v/${encodeURIComponent(organization_code)}/privacy`

  if (status.error && !status.data) {
    const is_missing = status.error instanceof ApiError && status.error.status === 404
    return (
      <Alert severity="danger" title={is_missing ? 'We could not find this request' : 'Could not load this request'}>
        <p>{is_missing ? 'Check that you opened the full link, or make a new request.' : status.error.message}</p>
        <ButtonLink to={form_link} tone="secondary" size="sm">
          Make a request
        </ButtonLink>
      </Alert>
    )
  }
  if (!status.data) return <Loading label="Checking your request…" />
  const data = status.data.privacy_request
  const label = STATUS_LABEL[data.status]

  return (
    <>
      <header className="stack">
        <p className="eyebrow">
          <ShieldCheck size={16} weight="fill" aria-hidden /> Privacy
        </p>
        <h1>Your request to {site.display_name}</h1>
      </header>

      {is_just_sent && (
        <Alert severity="success" title="Request sent">
          <p>Save this private link. It is the only way to check your request, and it shows no personal details.</p>
          <div className="admin-secret">
            <code className="mono admin-secret__value">{status_link}</code>
            <CopyButton value={status_link} label="Copy link" />
          </div>
        </Alert>
      )}

      <Card
        title={data.request_kind === 'access' ? 'A copy of my data' : 'Delete my data'}
        action={<Badge tone={label.tone}>{label.label}</Badge>}
      >
        <div className="stack">
          <p>{data.status_sentence}</p>
          <dl className="admin-fact">
            <div>
              <dt>Sent</dt>
              <dd>{formatDate(data.created_at)}</dd>
            </div>
            {data.completed_at && (
              <div>
                <dt>Finished</dt>
                <dd>{formatDate(data.completed_at)}</dd>
              </div>
            )}
          </dl>
          <div className="row">
            <Button tone="secondary" size="sm" onClick={status.reload}>
              Check again
            </Button>
            <ButtonLink to={form_link} tone="quiet" size="sm">
              Make another request
            </ButtonLink>
          </div>
        </div>
      </Card>
    </>
  )
}
