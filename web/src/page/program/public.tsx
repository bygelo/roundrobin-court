// Public → Programs. Upcoming clinics, socials, and lessons for the next 30
// days; register or join the waitlist; save the one-time code; and manage the
// spot later with that code (self check-in, waiver, cancel).

import { CalendarPlus, Copy, UsersThree } from '@phosphor-icons/react'
import { useMemo, useState, type FormEvent } from 'react'
import { ApiError, jsonBody, publicFetch } from '../../api.ts'
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
  ResourceView,
  Tabs,
  TextInput,
} from '../../component/ui.tsx'
import { formatDate, formatMoney, formatTime, formatTimeRange } from '../../format.ts'
import { useAction, useResource } from '../../hook.ts'
import { usePublicSite } from '../../layout/public-shell.tsx'
import type { PageProp } from '../../registry.ts'
import { KIND_LABEL, KIND_TONE, type ProgramKind } from './kind.ts'
import './program.css'

type PublicOccurrence = {
  program_occurrence_id: string
  kind_code: ProgramKind
  title: string
  description: string | null
  host_name: string | null
  court_name: string | null
  starts_at: string
  ends_at: string
  price_amount: string
  capacity_count: number
  spot_left_count: number
  is_waitlist: boolean
  is_member_only: boolean
  min_rating: string | null
  rating_provider_code: string | null
}

type Waiver = { arrival_waiver_version_id: string; version_number: number; title: string; body: string }

type ProgramPage = { occurrence: PublicOccurrence[]; waiver: Waiver | null; is_self_check_in: boolean }

type RegisterResult = {
  registration: { program_registration_id: string; display_name: string; status_code: 'registered' | 'waitlisted'; waitlist_position: number | null }
  credential: string
  check_in_token: string | null
  check_in_qr_svg: string | null
  occurrence: { title: string; starts_at: string; ends_at: string }
}

type MySpot = {
  program_registration_id: string
  display_name: string
  status_code: 'registered' | 'waitlisted' | 'cancelled' | 'no_show' | 'attended'
  waitlist_position: number | null
  title: string
  kind_code: ProgramKind
  host_name: string | null
  starts_at: string
  ends_at: string
  occurrence_status_code: 'scheduled' | 'cancelled'
  checked_in_at: string | null
  waiver_state: 'current' | 'outdated' | 'missing' | 'not_required'
  check_in_window: { window_status: 'early' | 'open' | 'ended'; opens_at: string; closes_at: string }
}

function spotBadge(one: PublicOccurrence) {
  if (one.is_waitlist) return <Badge tone="caution">Full · waitlist open</Badge>
  if (one.spot_left_count <= 3) return <Badge tone="caution">{one.spot_left_count === 1 ? '1 spot left' : `${one.spot_left_count} spots left`}</Badge>
  return <Badge tone="success">{one.spot_left_count} spots left</Badge>
}

function downloadCalendar(title: string, starts_at: string, ends_at: string, location: string) {
  const stamp = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const escape = (value: string) => value.replace(/[,;\\]/g, (match) => `\\${match}`)
  const text = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Court//Program//EN',
    'BEGIN:VEVENT',
    `UID:${stamp(starts_at)}-${Math.random().toString(36).slice(2)}@court`,
    `DTSTAMP:${stamp(new Date().toISOString())}`,
    `DTSTART:${stamp(starts_at)}`,
    `DTEND:${stamp(ends_at)}`,
    `SUMMARY:${escape(title)}`,
    `LOCATION:${escape(location)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')
  const url = URL.createObjectURL(new Blob([text], { type: 'text/calendar' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.ics`
  link.click()
  URL.revokeObjectURL(url)
}

function CopyButton({ value }: { value: string }) {
  const [is_copied, setCopied] = useState(false)
  return (
    <Button
      size="sm"
      tone="secondary"
      icon={<Copy size={16} aria-hidden />}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => setCopied(true))
      }}
    >
      {is_copied ? 'Copied' : 'Copy code'}
    </Button>
  )
}

function WaiverAccept({ waiver, checked, onChange }: { waiver: Waiver; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <div className="stack" style={{ gap: 'var(--space-2)' }}>
      <strong>{waiver.title}</strong>
      <div className="waiver-text" tabIndex={0} aria-label="Waiver text">
        {waiver.body}
      </div>
      <Checkbox label="I have read and accept this waiver" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </div>
  )
}

function RegisterDialog({
  organization_code,
  venue_name,
  occurrence,
  waiver,
  onClose,
  onDone,
}: {
  organization_code: string
  venue_name: string
  occurrence: PublicOccurrence
  waiver: Waiver | null
  onClose: () => void
  onDone: () => void
}) {
  const [form, setForm] = useState({ display_name: '', email: '', phone: '' })
  const [is_accepted, setAccepted] = useState(false)
  const [result, setResult] = useState<RegisterResult>()
  const [waiver_error, setWaiverError] = useState<string>()

  const submit = useAction(async () => {
    const created = await publicFetch<RegisterResult>(
      `/public/${encodeURIComponent(organization_code)}/program/occurrence/${occurrence.program_occurrence_id}/registration`,
      jsonBody({ ...form, waiver_version_id: waiver && is_accepted ? waiver.arrival_waiver_version_id : null }),
    )
    setResult(created)
    onDone()
  })

  const handle = (event: FormEvent) => {
    event.preventDefault()
    if (waiver && !is_accepted) {
      setWaiverError('Please read and accept the waiver to sign up.')
      return
    }
    setWaiverError(undefined)
    void submit.run()
  }

  if (result) {
    const is_waitlist = result.registration.status_code === 'waitlisted'
    return (
      <Dialog
        open
        title={is_waitlist ? 'You are on the waitlist' : 'You are in!'}
        onClose={onClose}
        footer={<Button onClick={onClose}>Done</Button>}
      >
        {is_waitlist ? (
          <Alert severity="caution" title={`You are #${result.registration.waitlist_position} on the waitlist`}>
            If a spot opens up you move in automatically and we will let you know.
          </Alert>
        ) : (
          <Alert severity="success" title={`See you on ${formatDate(result.occurrence.starts_at)}`}>
            {result.occurrence.title} · {formatTimeRange(result.occurrence.starts_at, result.occurrence.ends_at)}
          </Alert>
        )}
        <div className="stack" style={{ gap: 'var(--space-2)' }}>
          <strong>Your private code</strong>
          <div className="credential-box">
            <code>{result.credential}</code>
            <CopyButton value={result.credential} />
          </div>
          <p className="muted">
            Save it now — we only show it once. You need it to check in on your phone, accept the waiver, or cancel your spot.
          </p>
        </div>
        {result.check_in_qr_svg && !is_waitlist && (
          <figure className="stack" style={{ gap: 'var(--space-2)' }}>
            <div className="check-in-qr" dangerouslySetInnerHTML={{ __html: result.check_in_qr_svg }} />
            <figcaption className="muted" style={{ textAlign: 'center' }}>
              Show this QR at the front desk. Take a screenshot so you have it offline.
            </figcaption>
          </figure>
        )}
        <Button
          tone="secondary"
          icon={<CalendarPlus size={18} aria-hidden />}
          onClick={() => downloadCalendar(result.occurrence.title, result.occurrence.starts_at, result.occurrence.ends_at, venue_name)}
        >
          Add to calendar
        </Button>
      </Dialog>
    )
  }

  return (
    <Dialog
      open
      title={occurrence.is_waitlist ? `Join the waitlist — ${occurrence.title}` : `Sign up — ${occurrence.title}`}
      onClose={onClose}
      footer={
        <>
          <Button tone="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="register-form" disabled={submit.is_pending}>
            {submit.is_pending ? 'Saving your spot…' : occurrence.is_waitlist ? 'Join waitlist' : `Sign up${Number(occurrence.price_amount) > 0 ? ` · ${formatMoney(occurrence.price_amount)}` : ''}`}
          </Button>
        </>
      }
    >
      <p className="muted">
        {formatDate(occurrence.starts_at)} · {formatTimeRange(occurrence.starts_at, occurrence.ends_at)}
        {occurrence.host_name ? ` · with ${occurrence.host_name}` : ''}
        {Number(occurrence.price_amount) > 0 ? ' · pay at the front desk' : ''}
      </p>
      <form id="register-form" className="form" onSubmit={handle}>
        <TextInput label="Your name" required autoComplete="name" value={form.display_name} onChange={(event) => setForm({ ...form, display_name: event.target.value })} />
        <div className="form__row">
          <TextInput label="Email" type="email" autoComplete="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
          <TextInput label="Mobile" type="tel" autoComplete="tel" placeholder="+63 917 555 0100" value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} />
        </div>
        <p className="muted">We use your email or mobile only to tell you about this session.</p>
        {waiver && <WaiverAccept waiver={waiver} checked={is_accepted} onChange={setAccepted} />}
        {waiver_error && <Alert severity="caution">{waiver_error}</Alert>}
        <ErrorAlert error={submit.error} onDismiss={submit.clearError} />
      </form>
    </Dialog>
  )
}

function ManageSpot({ organization_code, waiver, is_self_check_in }: { organization_code: string; waiver: Waiver | null; is_self_check_in: boolean }) {
  const [credential, setCredential] = useState('')
  const [spot, setSpot] = useState<MySpot>()
  const [notice, setNotice] = useState<string>()
  const [waiver_prompt, setWaiverPrompt] = useState<Waiver>()
  const [is_accepted, setAccepted] = useState(false)
  const [is_confirming_cancel, setConfirmingCancel] = useState(false)
  const base = `/public/${encodeURIComponent(organization_code)}`

  const lookup = useAction(async () => {
    const result = await publicFetch<{ registration: MySpot }>(`${base}/program/registration/lookup`, jsonBody({ credential }))
    setSpot(result.registration)
    setNotice(undefined)
  })

  const checkIn = useAction(async () => {
    try {
      if (waiver_prompt && is_accepted) {
        await publicFetch(`${base}/arrival/waiver/accept`, jsonBody({ credential, arrival_waiver_version_id: waiver_prompt.arrival_waiver_version_id }))
      }
      await publicFetch(`${base}/arrival/check-in`, jsonBody({ credential }))
      setWaiverPrompt(undefined)
      setNotice('You are checked in. Have a great session!')
      await lookup.run()
    } catch (error) {
      const body = error instanceof ApiError ? (error.body as { reason_code?: string; waiver?: Waiver } | undefined) : undefined
      if (body?.reason_code === 'waiver_required' && body.waiver) {
        setWaiverPrompt(body.waiver)
        setAccepted(false)
        return
      }
      throw error
    }
  })

  const cancel = useAction(async () => {
    if (!spot) return
    const result = await publicFetch<{ is_seat_passed_on: boolean }>(
      `${base}/program/registration/${spot.program_registration_id}/cancel`,
      jsonBody({ credential }),
    )
    setConfirmingCancel(false)
    setNotice(result.is_seat_passed_on ? 'Your spot is cancelled and has gone to the next player on the waitlist.' : 'Your spot is cancelled.')
    await lookup.run()
  })

  const can_check_in =
    is_self_check_in &&
    spot &&
    !spot.checked_in_at &&
    spot.occurrence_status_code === 'scheduled' &&
    (spot.status_code === 'registered' || spot.status_code === 'attended')
  const can_cancel =
    spot && !spot.checked_in_at && spot.occurrence_status_code === 'scheduled' && (spot.status_code === 'registered' || spot.status_code === 'waitlisted')

  return (
    <Card title="Already signed up?" description="Enter the private code from your confirmation to check in, accept the waiver, or cancel.">
      <form
        className="row"
        onSubmit={(event) => {
          event.preventDefault()
          void lookup.run()
        }}
      >
        <div style={{ flex: '1 1 240px' }}>
          <TextInput label="Your private code" autoComplete="off" spellCheck={false} value={credential} onChange={(event) => setCredential(event.target.value.trim())} />
        </div>
        <Button type="submit" tone="secondary" disabled={!credential || lookup.is_pending} style={{ alignSelf: 'flex-end' }}>
          {lookup.is_pending ? 'Looking…' : 'Find my spot'}
        </Button>
      </form>
      <div className="stack" style={{ marginTop: 'var(--space-4)' }}>
        <ErrorAlert error={lookup.error} onDismiss={lookup.clearError} />
        {notice && (
          <Alert severity="success" onDismiss={() => setNotice(undefined)}>
            {notice}
          </Alert>
        )}
        {spot && (
          <div className="stack">
            <div className="row">
              <strong>{spot.title}</strong>
              <Badge tone={KIND_TONE[spot.kind_code]}>{KIND_LABEL[spot.kind_code]}</Badge>
              {spot.occurrence_status_code === 'cancelled' ? (
                <Badge tone="danger">Session cancelled</Badge>
              ) : spot.checked_in_at ? (
                <Badge tone="success">Checked in {formatTime(spot.checked_in_at)}</Badge>
              ) : spot.status_code === 'waitlisted' ? (
                <Badge tone="caution">Waitlist #{spot.waitlist_position}</Badge>
              ) : spot.status_code === 'registered' ? (
                <Badge tone="info">You have a spot</Badge>
              ) : (
                <Badge>{spot.status_code === 'no_show' ? 'Marked no-show' : 'Cancelled'}</Badge>
              )}
            </div>
            <p className="muted">
              {formatDate(spot.starts_at)} · {formatTimeRange(spot.starts_at, spot.ends_at)}
              {spot.host_name ? ` · with ${spot.host_name}` : ''}
            </p>
            {can_check_in && spot.check_in_window.window_status === 'early' && (
              <p className="muted">Phone check-in opens at {formatTime(spot.check_in_window.opens_at)}, one hour before the start.</p>
            )}
            {waiver_prompt && (
              <Alert severity="caution" title="One more step">
                Accept the current waiver to check in.
              </Alert>
            )}
            {waiver_prompt && <WaiverAccept waiver={waiver_prompt} checked={is_accepted} onChange={setAccepted} />}
            <ErrorAlert error={checkIn.error} onDismiss={checkIn.clearError} />
            <ErrorAlert error={cancel.error} onDismiss={cancel.clearError} />
            <div className="row">
              {can_check_in && spot.check_in_window.window_status === 'open' && (
                <Button onClick={() => void checkIn.run()} disabled={checkIn.is_pending || (waiver_prompt !== undefined && !is_accepted)}>
                  {checkIn.is_pending ? 'Checking in…' : waiver_prompt ? 'Accept and check in' : 'Check in now'}
                </Button>
              )}
              {can_cancel && (
                <Button tone="danger" onClick={() => setConfirmingCancel(true)}>
                  Cancel my spot
                </Button>
              )}
            </div>
            {!waiver_prompt && waiver && (spot.waiver_state === 'missing' || spot.waiver_state === 'outdated') && spot.status_code !== 'cancelled' && (
              <p className="muted">
                {spot.waiver_state === 'outdated' ? 'The venue waiver has changed since you signed.' : 'You have not signed the venue waiver yet.'} You can accept it when you check in.
              </p>
            )}
          </div>
        )}
      </div>
      <Dialog
        open={is_confirming_cancel}
        title="Cancel your spot?"
        onClose={() => setConfirmingCancel(false)}
        footer={
          <>
            <Button tone="quiet" onClick={() => setConfirmingCancel(false)}>
              Keep my spot
            </Button>
            <Button tone="danger" onClick={() => void cancel.run()} disabled={cancel.is_pending}>
              {cancel.is_pending ? 'Cancelling…' : 'Cancel my spot'}
            </Button>
          </>
        }
      >
        <p>Your spot goes to the next player on the waitlist. You would need to sign up again to get it back.</p>
      </Dialog>
    </Card>
  )
}

export default function Page({ param }: PageProp) {
  const organization_code = param['organization_code'] ?? ''
  const site = usePublicSite()
  const page = useResource(() => publicFetch<ProgramPage>(`/public/${encodeURIComponent(organization_code)}/program`), [organization_code])
  const [kind, setKind] = useState<'all' | ProgramKind>('all')
  const [chosen, setChosen] = useState<PublicOccurrence>()

  const kind_option = useMemo(() => {
    const present = [...new Set((page.data?.occurrence ?? []).map((one) => one.kind_code))]
    return [{ value: 'all' as const, label: 'Everything' }, ...present.map((one) => ({ value: one, label: `${KIND_LABEL[one]}s` }))]
  }, [page.data])

  return (
    <div className="stack--lg">
      <header className="program-hero">
        <p className="eyebrow">{site.display_name}</p>
        <h1>Clinics, socials &amp; lessons</h1>
        <p className="muted">Level up your dinks, meet new partners, and play with a coach. Sign up in a minute — pay at the front desk.</p>
      </header>
      <ResourceView resource={page}>
        {(data) => {
          const shown = data.occurrence.filter((one) => kind === 'all' || one.kind_code === kind)
          return (
            <>
              {data.occurrence.length === 0 ? (
                <EmptyState
                  title="Nothing on the calendar for the next 30 days"
                  description="New clinics and socials are added often. In the meantime, grab a court with friends."
                  action={<ButtonLink to={`/v/${organization_code}`}>Book a court</ButtonLink>}
                />
              ) : (
                <>
                  {kind_option.length > 2 && <Tabs label="Program kind" value={kind} onChange={setKind} option={kind_option} />}
                  <div className="grid">
                    {shown.map((one) => (
                      <Card key={one.program_occurrence_id} className="program-card">
                        <div className="stack" style={{ gap: 'var(--space-2)' }}>
                          <span className="program-card__date">
                            {formatDate(one.starts_at)} · {formatTimeRange(one.starts_at, one.ends_at)}
                          </span>
                          <h2 className="program-card__title">{one.title}</h2>
                          <div className="row" style={{ gap: 'var(--space-2)' }}>
                            <Badge tone={KIND_TONE[one.kind_code]}>{KIND_LABEL[one.kind_code]}</Badge>
                            {spotBadge(one)}
                            {one.is_member_only && <Badge tone="info">Members only</Badge>}
                            {one.min_rating && (
                              <Badge>
                                {(one.rating_provider_code ?? 'DUPR').toUpperCase()} {Number(one.min_rating).toFixed(1)}+
                              </Badge>
                            )}
                          </div>
                        </div>
                        <div className="stack" style={{ gap: 'var(--space-1)' }}>
                          {one.host_name && <p>with {one.host_name}</p>}
                          {one.description && <p className="muted">{one.description}</p>}
                          {one.court_name && <p className="muted">{one.court_name}</p>}
                        </div>
                        <div className="program-card__foot">
                          <span className="program-card__price">{Number(one.price_amount) > 0 ? formatMoney(one.price_amount) : 'Free'}</span>
                          <Button tone={one.is_waitlist ? 'secondary' : 'primary'} icon={<UsersThree size={18} aria-hidden />} onClick={() => setChosen(one)}>
                            {one.is_waitlist ? 'Join waitlist' : 'Sign up'}
                          </Button>
                        </div>
                      </Card>
                    ))}
                  </div>
                </>
              )}
              <ManageSpot organization_code={organization_code} waiver={data.waiver} is_self_check_in={data.is_self_check_in} />
              {chosen && (
                <RegisterDialog
                  organization_code={organization_code}
                  venue_name={site.display_name}
                  occurrence={chosen}
                  waiver={data.waiver}
                  onClose={() => setChosen(undefined)}
                  onDone={page.reload}
                />
              )}
            </>
          )
        }}
      </ResourceView>
    </div>
  )
}
