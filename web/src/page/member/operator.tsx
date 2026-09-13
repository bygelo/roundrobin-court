// Operator → Membership: who holds a membership or pass, and the plans on sale.
// Member prices themselves are applied by the booking flow through the member
// contract; this screen is where the desk enrols, freezes, cancels, and follows
// recurring billing (renewal badges, billing history, auto-renew).

import { ArrowsClockwise, Plus } from '@phosphor-icons/react'
import { useState } from 'react'
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
  PageHeader,
  ResourceView,
  SelectInput,
  Tabs,
  TextInput,
  Toolbar,
  type BadgeTone,
} from '../../component/ui.tsx'
import { formatDate, formatMoney, toDateInput } from '../../format.ts'
import { useAction, useResource } from '../../hook.ts'
import type { PageProp } from '../../registry.ts'
import { useOperator } from '../../session.tsx'
import './member.css'

type PlanKindCode = 'membership' | 'pass'
type PriceRuleCode = 'none' | 'percent_off' | 'fixed_price'
type BillingPeriodCode = 'monthly' | 'annual'
type BillingIntervalCode = 'none' | BillingPeriodCode

type MemberPlan = {
  member_plan_id: string
  display_name: string
  plan_kind_code: PlanKindCode
  price_amount: string
  billing_period_code: BillingPeriodCode | null
  billing_interval_code: BillingIntervalCode
  price_rule_code: PriceRuleCode
  percent_off: string | null
  fixed_price_amount: string | null
  is_member_session_access: boolean
  session_count: number | null
  valid_day_count: number | null
  rule_sentence: string
  holder_count: number
}

type MemberStatusCode = 'active' | 'expiring' | 'expired' | 'frozen' | 'cancelled' | 'pass_only' | 'pending_payment' | 'lapsed'
type BillingBadgeCode = 'paid_through' | 'due' | 'overdue' | 'lapsed'

type BillingSummary = {
  is_auto_renew: boolean
  renewal_state_code: 'pending_payment' | 'active' | 'lapsed'
  current_period_start_on: string
  current_period_end_on: string
  next_renewal_on: string | null
  badge_code: BillingBadgeCode
  badge_on: string | null
}

type Member = {
  party_id: string
  display_name: string
  email_address: string | null
  phone_number: string | null
  membership_id: string | null
  plan_name: string | null
  starts_at: string | null
  ends_at: string | null
  frozen_until: string | null
  status_code: MemberStatusCode
  pass_remaining_count: number
  pass: { pass_id: string; plan_name: string; status: string; remaining_count: number | null; valid_until: string }[]
  billing: BillingSummary | null
}

type BillingPeriod = {
  period_index: number
  period_start_on: string
  period_end_on: string
  last_day_on: string
  due_on: string
  invoice_code: string | null
  total_amount: string
  balance_amount: string
  status_code: 'paid' | 'unpaid' | 'overdue'
}

type MemberBilling = Omit<BillingSummary, 'renewal_state_code' | 'current_period_start_on' | 'current_period_end_on' | 'badge_code'> & {
  membership_id: string
  is_billed: boolean
  renewal_state_code: BillingSummary['renewal_state_code'] | null
  current_period_start_on: string | null
  current_period_end_on: string | null
  badge_code: BillingBadgeCode | null
  period: BillingPeriod[]
}

type RenewalResult = { invoiced_count: number; activated_count: number; lapsed_count: number }

const STATUS_BADGE: Record<MemberStatusCode, { tone: BadgeTone; label: string }> = {
  active: { tone: 'success', label: 'Active' },
  expiring: { tone: 'caution', label: 'Expiring soon' },
  expired: { tone: 'neutral', label: 'Expired' },
  frozen: { tone: 'info', label: 'Frozen' },
  cancelled: { tone: 'danger', label: 'Cancelled' },
  pass_only: { tone: 'info', label: 'Pass holder' },
  pending_payment: { tone: 'caution', label: 'Awaiting payment' },
  lapsed: { tone: 'danger', label: 'Lapsed' },
}

const PERIOD_BADGE: Record<BillingPeriod['status_code'], { tone: BadgeTone; label: string }> = {
  paid: { tone: 'success', label: 'Paid' },
  unpaid: { tone: 'caution', label: 'Unpaid' },
  overdue: { tone: 'danger', label: 'Overdue' },
}

function loadPlan() {
  return operatorFetch<{ plan: MemberPlan[] }>('/api/v1/member/plan').then((result) => result.plan)
}

/** The last day a membership covers: ends_at is the start of the first uncovered day. */
function lastCoveredDay(ends_at: string): string {
  return formatDate(new Date(new Date(ends_at).getTime() - 1))
}

/** A venue-local date (YYYY-MM-DD) as the desk reads it. Noon avoids any day shift. */
function formatDay(date: string): string {
  return formatDate(`${date}T12:00:00+08:00`)
}

function renewalBadge(billing: BillingSummary): { tone: BadgeTone; label: string } {
  if (billing.badge_code === 'lapsed') return { tone: 'danger', label: 'Lapsed' }
  if (billing.badge_code === 'overdue') return { tone: 'danger', label: 'Overdue' }
  if (billing.badge_code === 'due') return { tone: 'caution', label: billing.badge_on ? `Due ${formatDay(billing.badge_on)}` : 'Due' }
  return { tone: 'success', label: billing.badge_on ? `Paid through ${formatDay(billing.badge_on)}` : 'Paid' }
}

function periodWord(code: BillingPeriodCode | null): string {
  return code === 'annual' ? 'year' : 'month'
}

type Tab = 'member' | 'plan'

export default function Page(_prop: PageProp) {
  const { can } = useOperator()
  const can_manage = can('member.manage')
  const [tab, setTab] = useState<Tab>('member')
  const plan = useResource(loadPlan, [])

  return (
    <>
      <PageHeader
        eyebrow="Business"
        title="Membership"
        description="Monthly members and session passes for your regulars."
      />
      <Alert severity="info" title="Member prices apply automatically">
        When a member books a court with the same email that is on their membership, the booking shows their member price or uses a
        pass session — nobody at the desk has to apply it. A member on an invoiced plan gets the member price only while their
        membership is paid.
      </Alert>
      <div style={{ height: 'var(--space-5)' }} />
      <Tabs<Tab>
        label="Membership sections"
        value={tab}
        onChange={setTab}
        option={[
          { value: 'member', label: 'Members' },
          { value: 'plan', label: 'Plans' },
        ]}
      />
      {tab === 'member' ? (
        <MemberTab plan={plan} can_manage={can_manage} onGoPlan={() => setTab('plan')} />
      ) : (
        <PlanTab plan={plan} can_manage={can_manage} />
      )}
    </>
  )
}

// ---- members --------------------------------------------------------------

function MemberTab({
  plan,
  can_manage,
  onGoPlan,
}: {
  plan: ReturnType<typeof useResource<MemberPlan[]>>
  can_manage: boolean
  onGoPlan: () => void
}) {
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<'' | MemberStatusCode>('')
  const member = useResource(() => {
    const query = new URLSearchParams()
    if (status) query.set('status', status)
    if (search.trim()) query.set('search', search.trim())
    const text = query.toString()
    return operatorFetch<{ member: Member[] }>(`/api/v1/member/member${text ? `?${text}` : ''}`).then((result) => result.member)
  }, [status, search])
  const [is_enrolling, setEnrolling] = useState(false)
  const [freezing, setFreezing] = useState<Member>()
  const [cancelling, setCancelling] = useState<Member>()
  const [viewing, setViewing] = useState<Member>()
  const [notice, setNotice] = useState<string>()
  const [renewal, setRenewal] = useState<RenewalResult>()

  const unfreeze = useAction(async (one: Member) => {
    await operatorFetch(`/api/v1/member/member/${one.membership_id}/unfreeze`, { method: 'POST' })
    setNotice(`${one.display_name}'s membership is active again.`)
    member.reload()
  })

  const runRenewal = useAction(async () => {
    const response = await operatorFetch<{ result: RenewalResult }>('/api/v1/member/renewal/run', { method: 'POST' })
    setRenewal(response.result)
    member.reload()
  })

  const done = (message: string) => {
    setNotice(message)
    member.reload()
    plan.reload()
  }

  const has_plan = (plan.data ?? []).length > 0

  return (
    <div className="stack">
      <Toolbar>
        <TextInput label="Search" type="search" placeholder="Name, email, or phone" value={search} onChange={(event) => setSearch(event.target.value)} />
        <SelectInput
          label="Status"
          value={status}
          onChange={(event) => setStatus(event.target.value as '' | MemberStatusCode)}
          option={[
            { value: '', label: 'Everyone' },
            { value: 'active', label: 'Active' },
            { value: 'expiring', label: 'Expiring within 7 days' },
            { value: 'pending_payment', label: 'Awaiting payment' },
            { value: 'lapsed', label: 'Lapsed' },
            { value: 'frozen', label: 'Frozen' },
            { value: 'expired', label: 'Expired' },
            { value: 'cancelled', label: 'Cancelled' },
            { value: 'pass_only', label: 'Pass holders' },
          ]}
        />
        {can_manage && (
          <Button
            tone="secondary"
            icon={<ArrowsClockwise size={16} aria-hidden />}
            disabled={runRenewal.is_pending}
            onClick={() => void runRenewal.run()}
          >
            {runRenewal.is_pending ? 'Running…' : 'Run renewals now'}
          </Button>
        )}
        {can_manage && (
          <Button icon={<Plus size={16} aria-hidden />} disabled={!has_plan} onClick={() => setEnrolling(true)}>
            Enrol member
          </Button>
        )}
      </Toolbar>
      {renewal && (
        <Alert severity="info" title="Renewals checked" onDismiss={() => setRenewal(undefined)}>
          {renewal.invoiced_count} renewal {renewal.invoiced_count === 1 ? 'invoice' : 'invoices'} raised ·{' '}
          {renewal.activated_count} {renewal.activated_count === 1 ? 'membership' : 'memberships'} activated or extended ·{' '}
          {renewal.lapsed_count} lapsed. This also runs on its own every 15 minutes.
        </Alert>
      )}
      {notice && (
        <Alert severity="success" onDismiss={() => setNotice(undefined)}>
          {notice}
        </Alert>
      )}
      <ErrorAlert error={unfreeze.error} onDismiss={unfreeze.clearError} />
      <ErrorAlert error={runRenewal.error} onDismiss={runRenewal.clearError} />
      <ResourceView resource={member}>
        {(list) =>
          list.length === 0 ? (
            search || status ? (
              <EmptyState title="No one matches" description="Clear the search or pick Everyone." />
            ) : !has_plan ? (
              <EmptyState
                title="Create a plan first"
                description="Set up a monthly membership or a session pass, then enrol your regulars."
                action={<Button onClick={onGoPlan}>Go to plans</Button>}
              />
            ) : (
              <EmptyState
                title="No members yet"
                description="Enrol a regular with their email — their member price applies the next time they book."
                action={can_manage ? <Button onClick={() => setEnrolling(true)}>Enrol member</Button> : undefined}
              />
            )
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Member</th>
                    <th>Plan</th>
                    <th>Status</th>
                    <th>Renewal</th>
                    <th className="number">Pass sessions left</th>
                    <th>
                      <span className="visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((one) => {
                    const badge = STATUS_BADGE[one.status_code]
                    const is_live = one.status_code === 'active' || one.status_code === 'expiring'
                    const renewal_badge = one.billing ? renewalBadge(one.billing) : undefined
                    return (
                      <tr key={one.party_id}>
                        <td>
                          {one.membership_id ? (
                            <button type="button" className="member-name" onClick={() => setViewing(one)}>
                              {one.display_name}
                            </button>
                          ) : (
                            <strong>{one.display_name}</strong>
                          )}
                          <div className="member-contact">{[one.email_address, one.phone_number].filter(Boolean).join(' · ')}</div>
                        </td>
                        <td>{one.plan_name ?? (one.pass[0]?.plan_name ?? '—')}</td>
                        <td>
                          <Badge tone={badge.tone}>{badge.label}</Badge>
                          {one.status_code === 'frozen' && one.frozen_until && <div className="muted">until {formatDate(one.frozen_until)}</div>}
                        </td>
                        <td>
                          {one.billing && renewal_badge ? (
                            <>
                              <Badge tone={renewal_badge.tone}>{renewal_badge.label}</Badge>
                              <div className="member-renewal">
                                {one.billing.next_renewal_on
                                  ? `Renews ${formatDay(one.billing.next_renewal_on)}`
                                  : one.billing.renewal_state_code === 'lapsed'
                                    ? 'Renewal unpaid'
                                    : 'Auto-renew off'}
                              </div>
                            </>
                          ) : one.ends_at ? (
                            <span className="member-renewal">Covered until {lastCoveredDay(one.ends_at)}</span>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="number member-pass-count">{one.pass.length > 0 ? one.pass_remaining_count : '—'}</td>
                        <td>
                          {one.membership_id && (
                            <div className="row">
                              <Button tone="quiet" size="sm" onClick={() => setViewing(one)}>
                                Billing
                              </Button>
                              {can_manage && is_live && (
                                <Button tone="secondary" size="sm" onClick={() => setFreezing(one)}>
                                  Freeze
                                </Button>
                              )}
                              {can_manage && one.status_code === 'frozen' && (
                                <Button tone="secondary" size="sm" disabled={unfreeze.is_pending} onClick={() => void unfreeze.run(one)}>
                                  Unfreeze
                                </Button>
                              )}
                              {can_manage && (is_live || one.status_code === 'frozen' || one.status_code === 'pending_payment' || one.status_code === 'lapsed') && (
                                <Button tone="quiet" size="sm" onClick={() => setCancelling(one)}>
                                  Cancel
                                </Button>
                              )}
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

      {is_enrolling && plan.data && (
        <EnrolDialog
          plan={plan.data}
          onClose={() => setEnrolling(false)}
          onDone={(message) => {
            setEnrolling(false)
            done(message)
          }}
        />
      )}
      {freezing && (
        <FreezeDialog
          member={freezing}
          onClose={() => setFreezing(undefined)}
          onDone={(message) => {
            setFreezing(undefined)
            done(message)
          }}
        />
      )}
      {cancelling && (
        <CancelDialog
          member={cancelling}
          onClose={() => setCancelling(undefined)}
          onDone={(message) => {
            setCancelling(undefined)
            done(message)
          }}
        />
      )}
      {viewing && (
        <MemberDialog
          member={viewing}
          can_manage={can_manage}
          onClose={() => {
            setViewing(undefined)
            member.reload()
          }}
        />
      )}
    </div>
  )
}

function MemberDialog({ member, can_manage, onClose }: { member: Member; can_manage: boolean; onClose: () => void }) {
  const billing = useResource(
    () =>
      operatorFetch<{ billing: MemberBilling }>(`/api/v1/member/member/${member.membership_id}/billing`).then((result) => result.billing),
    [member.membership_id],
  )
  const toggle = useAction(async (is_auto_renew: boolean) => {
    await operatorFetch(`/api/v1/member/member/${member.membership_id}/auto-renew`, jsonBody({ is_auto_renew }))
    billing.reload()
  })

  return (
    <Dialog
      open
      title={member.display_name}
      onClose={onClose}
      footer={
        <Button tone="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <p className="muted">
        {member.plan_name ?? 'Membership'} · {STATUS_BADGE[member.status_code].label}
      </p>
      <ResourceView resource={billing}>
        {(view) =>
          !view.is_billed ? (
            <Alert severity="info" title="Not invoiced">
              This plan is collected at the desk, so there is no billing history or automatic renewal.
            </Alert>
          ) : (
            <div className="stack">
              <div className="member-billing-summary">
                {view.current_period_start_on && view.current_period_end_on && (
                  <p>
                    Current period {formatDay(view.current_period_start_on)} – {formatDay(view.current_period_end_on)} (ends before the
                    last date)
                  </p>
                )}
                {view.renewal_state_code === 'pending_payment' && (
                  <Alert severity="caution">The first invoice is unpaid. Member prices start once it is paid.</Alert>
                )}
                {view.renewal_state_code === 'lapsed' && (
                  <Alert severity="danger">
                    The renewal went unpaid past the 7-day grace. Member prices are off until the renewal invoice is paid.
                  </Alert>
                )}
              </div>
              <Checkbox
                label="Renew automatically — raise the next invoice 3 days before the period ends"
                checked={view.is_auto_renew}
                disabled={!can_manage || toggle.is_pending}
                onChange={(event) => void toggle.run(event.target.checked)}
              />
              <ErrorAlert error={toggle.error} onDismiss={toggle.clearError} />
              <div className="table-wrap">
                <table className="table member-billing-table">
                  <thead>
                    <tr>
                      <th>Period</th>
                      <th>Invoice</th>
                      <th className="number">Amount</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.period.map((one) => {
                      const badge = PERIOD_BADGE[one.status_code]
                      return (
                        <tr key={one.period_index}>
                          <td>
                            {formatDay(one.period_start_on)} – {formatDay(one.last_day_on)}
                          </td>
                          <td className="member-invoice-code">{one.invoice_code ?? '—'}</td>
                          <td className="number">
                            {formatMoney(one.total_amount)}
                            {one.status_code !== 'paid' && Number(one.balance_amount) < Number(one.total_amount) && (
                              <div className="muted">{formatMoney(one.balance_amount)} left</div>
                            )}
                          </td>
                          <td>
                            <Badge tone={badge.tone}>{badge.label}</Badge>
                            {one.status_code !== 'paid' && <div className="muted">due {formatDay(one.due_on)}</div>}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <p className="muted">Once an invoice is paid in billing, the membership activates or extends on the next renewal check.</p>
            </div>
          )
        }
      </ResourceView>
    </Dialog>
  )
}

function EnrolDialog({ plan, onClose, onDone }: { plan: MemberPlan[]; onClose: () => void; onDone: (message: string) => void }) {
  const [plan_id, setPlanId] = useState(plan[0]?.member_plan_id ?? '')
  const [display_name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [starts_on, setStartsOn] = useState(toDateInput(new Date()))
  const chosen = plan.find((one) => one.member_plan_id === plan_id)
  const is_pass = chosen?.plan_kind_code === 'pass'
  const is_billed = chosen !== undefined && chosen.billing_interval_code !== 'none'

  const enrol = useAction(async () => {
    await operatorFetch(
      is_pass ? '/api/v1/member/pass' : '/api/v1/member/member',
      jsonBody({ plan_id, display_name, email, phone, ...(is_pass ? {} : { starts_on }) }),
    )
    onDone(
      is_pass
        ? `${display_name} now holds a ${chosen?.display_name}.`
        : is_billed
          ? `${display_name} is enrolled on ${chosen?.display_name}. Their first invoice is open — member prices start once it is paid.`
          : `${display_name} is enrolled on ${chosen?.display_name}.`,
    )
  })

  return (
    <Dialog
      open
      title="Enrol member"
      onClose={onClose}
      footer={
        <>
          <Button tone="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={enrol.is_pending || !plan_id || !display_name.trim() || !email.trim()} onClick={() => void enrol.run()}>
            {enrol.is_pending ? 'Saving…' : is_pass ? 'Issue pass' : 'Enrol'}
          </Button>
        </>
      }
    >
      <form className="form" onSubmit={(event) => event.preventDefault()}>
        <SelectInput
          label="Plan"
          value={plan_id}
          onChange={(event) => setPlanId(event.target.value)}
          option={plan.map((one) => ({
            value: one.member_plan_id,
            label: `${one.display_name} — ${formatMoney(one.price_amount)}${one.plan_kind_code === 'pass' ? ' pass' : ` / ${periodWord(one.billing_period_code)}`}`,
          }))}
        />
        {chosen && <p className="muted">{chosen.rule_sentence}</p>}
        {is_billed && (
          <Alert severity="info">
            Enrolling raises an invoice for the first {periodWord(chosen.billing_period_code)} ({formatMoney(chosen.price_amount)}). It renews
            automatically.
          </Alert>
        )}
        <TextInput label="Full name" required value={display_name} onChange={(event) => setName(event.target.value)} />
        <TextInput
          label="Email"
          type="email"
          required
          hint="Use the email they book with — that is how member prices find them."
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <TextInput label="Mobile number" type="tel" value={phone} placeholder="+63 917 000 0000" onChange={(event) => setPhone(event.target.value)} />
        {!is_pass && <TextInput label="Starts on" type="date" value={starts_on} onChange={(event) => setStartsOn(event.target.value)} />}
        <ErrorAlert error={enrol.error} onDismiss={enrol.clearError} />
      </form>
    </Dialog>
  )
}

function FreezeDialog({ member, onClose, onDone }: { member: Member; onClose: () => void; onDone: (message: string) => void }) {
  const [until, setUntil] = useState(toDateInput(new Date(Date.now() + 30 * 86_400_000)))
  const freeze = useAction(async () => {
    await operatorFetch(`/api/v1/member/member/${member.membership_id}/freeze`, jsonBody({ frozen_until_on: until }))
    onDone(`${member.display_name}'s membership is frozen until ${formatDate(`${until}T12:00:00+08:00`)}.`)
  })
  return (
    <Dialog
      open
      title={`Freeze ${member.display_name}`}
      onClose={onClose}
      footer={
        <>
          <Button tone="secondary" onClick={onClose}>
            Keep active
          </Button>
          <Button disabled={freeze.is_pending || !until} onClick={() => void freeze.run()}>
            {freeze.is_pending ? 'Freezing…' : 'Freeze membership'}
          </Button>
        </>
      }
    >
      <p>While frozen, {member.display_name} books at the regular price and no renewal invoice is raised. Unfreeze any time.</p>
      <TextInput label="Frozen until" type="date" value={until} onChange={(event) => setUntil(event.target.value)} />
      <ErrorAlert error={freeze.error} onDismiss={freeze.clearError} />
    </Dialog>
  )
}

function CancelDialog({ member, onClose, onDone }: { member: Member; onClose: () => void; onDone: (message: string) => void }) {
  const cancel = useAction(async () => {
    await operatorFetch(`/api/v1/member/member/${member.membership_id}/cancel`, { method: 'POST' })
    onDone(`${member.display_name}'s ${member.plan_name ?? 'membership'} is cancelled.`)
  })
  return (
    <Dialog
      open
      title={`Cancel ${member.display_name}'s membership?`}
      onClose={onClose}
      footer={
        <>
          <Button tone="secondary" onClick={onClose}>
            Keep membership
          </Button>
          <Button tone="danger" disabled={cancel.is_pending} onClick={() => void cancel.run()}>
            {cancel.is_pending ? 'Cancelling…' : 'Cancel membership'}
          </Button>
        </>
      }
    >
      <Alert severity="caution" title="This cannot be undone">
        Member prices and renewals stop immediately. Bookings already made keep the price they were booked at. Pass sessions are not
        affected. An invoice already raised stays open in billing.
      </Alert>
      <ErrorAlert error={cancel.error} onDismiss={cancel.clearError} />
    </Dialog>
  )
}

// ---- plans ----------------------------------------------------------------

function PlanTab({ plan, can_manage }: { plan: ReturnType<typeof useResource<MemberPlan[]>>; can_manage: boolean }) {
  const [is_creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<MemberPlan>()
  const [notice, setNotice] = useState<string>()
  return (
    <div className="stack">
      <Toolbar>
        {can_manage && (
          <Button icon={<Plus size={16} aria-hidden />} onClick={() => setCreating(true)}>
            New plan
          </Button>
        )}
      </Toolbar>
      {notice && (
        <Alert severity="success" onDismiss={() => setNotice(undefined)}>
          {notice}
        </Alert>
      )}
      <ResourceView resource={plan}>
        {(list) =>
          list.length === 0 ? (
            <EmptyState
              title="No plans yet"
              description="A monthly membership with a court discount, or a pass of 10 sessions, is a good start."
              action={can_manage ? <Button onClick={() => setCreating(true)}>New plan</Button> : undefined}
            />
          ) : (
            <div className="grid">
              {list.map((one) => (
                <Card key={one.member_plan_id} className="member-plan" title={one.display_name} action={<Badge tone="info">{one.plan_kind_code === 'pass' ? 'Pass' : 'Membership'}</Badge>}>
                  <p className="member-plan__price">
                    {formatMoney(one.price_amount)}{' '}
                    <span className="member-plan__period">
                      {one.plan_kind_code === 'pass' ? 'one-time' : `per ${periodWord(one.billing_period_code)}`}
                    </span>
                  </p>
                  <p className="member-plan__rule">{one.rule_sentence}</p>
                  {one.plan_kind_code === 'membership' && (
                    <p className="member-plan__billing">
                      {one.billing_interval_code === 'none'
                        ? 'Collected at the desk — no invoice'
                        : `Invoiced ${one.billing_interval_code === 'annual' ? 'yearly' : 'monthly'} · renews automatically`}
                    </p>
                  )}
                  <p className="muted">
                    {one.holder_count === 1 ? '1 current holder' : `${one.holder_count} current holders`}
                  </p>
                  {can_manage && one.plan_kind_code === 'membership' && (
                    <div>
                      <Button tone="secondary" size="sm" onClick={() => setEditing(one)}>
                        Edit price and billing
                      </Button>
                    </div>
                  )}
                </Card>
              ))}
            </div>
          )
        }
      </ResourceView>
      {is_creating && (
        <PlanDialog
          onClose={() => setCreating(false)}
          onDone={(name) => {
            setCreating(false)
            setNotice(`${name} is ready to sell.`)
            plan.reload()
          }}
        />
      )}
      {editing && (
        <PlanEditDialog
          plan={editing}
          onClose={() => setEditing(undefined)}
          onDone={(name) => {
            setEditing(undefined)
            setNotice(`${name} is updated. New prices apply from the next invoice.`)
            plan.reload()
          }}
        />
      )}
    </div>
  )
}

function PlanEditDialog({ plan, onClose, onDone }: { plan: MemberPlan; onClose: () => void; onDone: (name: string) => void }) {
  const [price_amount, setPrice] = useState(plan.price_amount)
  const [is_invoiced, setInvoiced] = useState(plan.billing_interval_code !== 'none')
  const save = useAction(async () => {
    await operatorFetch(
      `/api/v1/member/plan/${plan.member_plan_id}`,
      jsonBody({ price_amount, billing_interval_code: is_invoiced ? plan.billing_period_code : 'none' }, 'PATCH'),
    )
    onDone(plan.display_name)
  })
  return (
    <Dialog
      open
      title={`Edit ${plan.display_name}`}
      onClose={onClose}
      footer={
        <>
          <Button tone="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={save.is_pending || !price_amount.trim()} onClick={() => void save.run()}>
            {save.is_pending ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <form className="form" onSubmit={(event) => event.preventDefault()}>
        <TextInput label={`Price per ${periodWord(plan.billing_period_code)} (₱)`} inputMode="decimal" value={price_amount} onChange={(event) => setPrice(event.target.value)} />
        <SelectInput
          label="Billing"
          value={is_invoiced ? 'invoice' : 'none'}
          onChange={(event) => setInvoiced(event.target.value === 'invoice')}
          option={[
            { value: 'none', label: 'Collected at the desk — no invoice' },
            { value: 'invoice', label: `Invoice every ${periodWord(plan.billing_period_code)}, renew automatically` },
          ]}
        />
        <p className="muted">Invoices already raised keep their amount. Turning invoicing on applies to members enrolled from now on.</p>
        <ErrorAlert error={save.error} onDismiss={save.clearError} />
      </form>
    </Dialog>
  )
}

function PlanDialog({ onClose, onDone }: { onClose: () => void; onDone: (name: string) => void }) {
  const [kind, setKind] = useState<PlanKindCode>('membership')
  const [display_name, setName] = useState('')
  const [price_amount, setPrice] = useState('')
  const [period, setPeriod] = useState<BillingPeriodCode>('monthly')
  const [is_invoiced, setInvoiced] = useState(true)
  const [rule, setRule] = useState<PriceRuleCode>('percent_off')
  const [percent_off, setPercent] = useState('20')
  const [fixed_price_amount, setFixed] = useState('')
  const [is_member_session_access, setAccess] = useState(false)
  const [session_count, setSessionCount] = useState('10')
  const [valid_day_count, setValidDay] = useState('60')

  const sentence =
    kind === 'pass'
      ? `${session_count || '?'} sessions, valid ${valid_day_count || '?'} days — each booking uses one`
      : [
          rule === 'percent_off'
            ? `${percent_off || '?'}% off every court booking`
            : rule === 'fixed_price'
              ? `Court bookings at ${fixed_price_amount ? formatMoney(fixed_price_amount) : '₱?'} each`
              : 'No booking discount',
          is_member_session_access ? 'can book members-only sessions' : '',
        ]
          .filter(Boolean)
          .join(' · ')

  const create = useAction(async () => {
    await operatorFetch(
      '/api/v1/member/plan',
      jsonBody(
        kind === 'pass'
          ? { display_name, plan_kind_code: 'pass', price_amount, session_count: Number(session_count), valid_day_count: Number(valid_day_count) }
          : {
              display_name,
              plan_kind_code: 'membership',
              price_amount,
              billing_period_code: period,
              billing_interval_code: is_invoiced ? period : 'none',
              price_rule_code: rule,
              ...(rule === 'percent_off' ? { percent_off } : {}),
              ...(rule === 'fixed_price' ? { fixed_price_amount } : {}),
              is_member_session_access,
            },
      ),
    )
    onDone(display_name)
  })

  return (
    <Dialog
      open
      title="New plan"
      onClose={onClose}
      footer={
        <>
          <Button tone="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={create.is_pending || !display_name.trim() || !price_amount.trim()} onClick={() => void create.run()}>
            {create.is_pending ? 'Creating…' : 'Create plan'}
          </Button>
        </>
      }
    >
      <form className="form" onSubmit={(event) => event.preventDefault()}>
        <SelectInput
          label="Kind"
          value={kind}
          onChange={(event) => setKind(event.target.value as PlanKindCode)}
          option={[
            { value: 'membership', label: 'Membership — a period with a member price' },
            { value: 'pass', label: 'Session pass — a number of sessions' },
          ]}
        />
        <TextInput label="Plan name" required value={display_name} placeholder={kind === 'pass' ? '10-Session Pass' : 'Monthly Member'} onChange={(event) => setName(event.target.value)} />
        <div className="form__row">
          <TextInput label="Price (₱)" inputMode="decimal" required value={price_amount} onChange={(event) => setPrice(event.target.value)} />
          {kind === 'membership' ? (
            <SelectInput
              label="Period"
              value={period}
              onChange={(event) => setPeriod(event.target.value as BillingPeriodCode)}
              option={[
                { value: 'monthly', label: 'Monthly' },
                { value: 'annual', label: 'Annually' },
              ]}
            />
          ) : (
            <TextInput label="Valid for (days)" type="number" min={1} value={valid_day_count} onChange={(event) => setValidDay(event.target.value)} />
          )}
        </div>
        {kind === 'membership' ? (
          <>
            <SelectInput
              label="Billing interval"
              hint="Invoiced plans raise each period's invoice and renew on their own; a member gets the member price while paid."
              value={is_invoiced ? period : 'none'}
              onChange={(event) => setInvoiced(event.target.value !== 'none')}
              option={[
                { value: period, label: period === 'annual' ? 'Invoice annually' : 'Invoice monthly' },
                { value: 'none', label: 'None — collect at the desk' },
              ]}
            />
            <div className="form__row">
              <SelectInput
                label="Member price on court bookings"
                value={rule}
                onChange={(event) => setRule(event.target.value as PriceRuleCode)}
                option={[
                  { value: 'percent_off', label: 'Percent off' },
                  { value: 'fixed_price', label: 'Fixed price per booking' },
                  { value: 'none', label: 'No discount' },
                ]}
              />
              {rule === 'percent_off' && (
                <TextInput label="Percent off" type="number" min={1} max={100} value={percent_off} onChange={(event) => setPercent(event.target.value)} />
              )}
              {rule === 'fixed_price' && (
                <TextInput label="Member price (₱)" inputMode="decimal" value={fixed_price_amount} onChange={(event) => setFixed(event.target.value)} />
              )}
            </div>
            <Checkbox label="Members may book members-only sessions" checked={is_member_session_access} onChange={(event) => setAccess(event.target.checked)} />
          </>
        ) : (
          <TextInput label="Sessions included" type="number" min={1} value={session_count} onChange={(event) => setSessionCount(event.target.value)} />
        )}
        <Alert severity="info">{sentence}</Alert>
        <ErrorAlert error={create.error} onDismiss={create.clearError} />
      </form>
    </Dialog>
  )
}
