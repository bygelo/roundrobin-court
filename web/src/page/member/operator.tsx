// Operator → Membership: who holds a membership or pass, and the plans on sale.
// Member prices themselves are applied by the booking flow through the member
// contract; this screen is where the desk enrols, freezes, and cancels.

import { Plus } from '@phosphor-icons/react'
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

type MemberPlan = {
  member_plan_id: string
  display_name: string
  plan_kind_code: PlanKindCode
  price_amount: string
  billing_period_code: 'monthly' | 'annual' | null
  price_rule_code: PriceRuleCode
  percent_off: string | null
  fixed_price_amount: string | null
  is_member_session_access: boolean
  session_count: number | null
  valid_day_count: number | null
  rule_sentence: string
  holder_count: number
}

type MemberStatusCode = 'active' | 'expiring' | 'expired' | 'frozen' | 'cancelled' | 'pass_only'

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
}

const STATUS_BADGE: Record<MemberStatusCode, { tone: BadgeTone; label: string }> = {
  active: { tone: 'success', label: 'Active' },
  expiring: { tone: 'caution', label: 'Expiring soon' },
  expired: { tone: 'neutral', label: 'Expired' },
  frozen: { tone: 'info', label: 'Frozen' },
  cancelled: { tone: 'danger', label: 'Cancelled' },
  pass_only: { tone: 'info', label: 'Pass holder' },
}

function loadPlan() {
  return operatorFetch<{ plan: MemberPlan[] }>('/api/v1/member/plan').then((result) => result.plan)
}

/** The last day a membership covers: ends_at is the start of the first uncovered day. */
function lastCoveredDay(ends_at: string): string {
  return formatDate(new Date(new Date(ends_at).getTime() - 1))
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
        pass session — nobody at the desk has to apply it.
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
  const [notice, setNotice] = useState<string>()

  const unfreeze = useAction(async (one: Member) => {
    await operatorFetch(`/api/v1/member/member/${one.membership_id}/unfreeze`, { method: 'POST' })
    setNotice(`${one.display_name}'s membership is active again.`)
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
            { value: 'frozen', label: 'Frozen' },
            { value: 'expired', label: 'Expired' },
            { value: 'cancelled', label: 'Cancelled' },
            { value: 'pass_only', label: 'Pass holders' },
          ]}
        />
        {can_manage && (
          <Button icon={<Plus size={16} aria-hidden />} disabled={!has_plan} onClick={() => setEnrolling(true)}>
            Enrol member
          </Button>
        )}
      </Toolbar>
      {notice && (
        <Alert severity="success" onDismiss={() => setNotice(undefined)}>
          {notice}
        </Alert>
      )}
      <ErrorAlert error={unfreeze.error} onDismiss={unfreeze.clearError} />
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
                    <th>Covered until</th>
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
                    return (
                      <tr key={one.party_id}>
                        <td>
                          <strong>{one.display_name}</strong>
                          <div className="member-contact">{[one.email_address, one.phone_number].filter(Boolean).join(' · ')}</div>
                        </td>
                        <td>{one.plan_name ?? (one.pass[0]?.plan_name ?? '—')}</td>
                        <td>
                          <Badge tone={badge.tone}>{badge.label}</Badge>
                          {one.status_code === 'frozen' && one.frozen_until && <div className="muted">until {formatDate(one.frozen_until)}</div>}
                        </td>
                        <td>{one.ends_at ? lastCoveredDay(one.ends_at) : '—'}</td>
                        <td className="number member-pass-count">{one.pass.length > 0 ? one.pass_remaining_count : '—'}</td>
                        <td>
                          {can_manage && one.membership_id && (
                            <div className="row">
                              {is_live && (
                                <Button tone="secondary" size="sm" onClick={() => setFreezing(one)}>
                                  Freeze
                                </Button>
                              )}
                              {one.status_code === 'frozen' && (
                                <Button tone="secondary" size="sm" disabled={unfreeze.is_pending} onClick={() => void unfreeze.run(one)}>
                                  Unfreeze
                                </Button>
                              )}
                              {(is_live || one.status_code === 'frozen') && (
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
    </div>
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

  const enrol = useAction(async () => {
    await operatorFetch(
      is_pass ? '/api/v1/member/pass' : '/api/v1/member/member',
      jsonBody({ plan_id, display_name, email, phone, ...(is_pass ? {} : { starts_on }) }),
    )
    onDone(is_pass ? `${display_name} now holds a ${chosen?.display_name}.` : `${display_name} is enrolled on ${chosen?.display_name}.`)
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
            label: `${one.display_name} — ${formatMoney(one.price_amount)}${one.plan_kind_code === 'pass' ? ' pass' : one.billing_period_code === 'annual' ? ' / year' : ' / month'}`,
          }))}
        />
        {chosen && <p className="muted">{chosen.rule_sentence}</p>}
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
      <p>While frozen, {member.display_name} books at the regular price. Unfreeze any time.</p>
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
        Member prices stop immediately. Bookings already made keep the price they were booked at. Pass sessions are not affected.
      </Alert>
      <ErrorAlert error={cancel.error} onDismiss={cancel.clearError} />
    </Dialog>
  )
}

// ---- plans ----------------------------------------------------------------

function PlanTab({ plan, can_manage }: { plan: ReturnType<typeof useResource<MemberPlan[]>>; can_manage: boolean }) {
  const [is_creating, setCreating] = useState(false)
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
                      {one.plan_kind_code === 'pass' ? 'one-time' : one.billing_period_code === 'annual' ? 'per year' : 'per month'}
                    </span>
                  </p>
                  <p className="member-plan__rule">{one.rule_sentence}</p>
                  <p className="muted">
                    {one.holder_count === 1 ? '1 current holder' : `${one.holder_count} current holders`}
                  </p>
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
    </div>
  )
}

function PlanDialog({ onClose, onDone }: { onClose: () => void; onDone: (name: string) => void }) {
  const [kind, setKind] = useState<PlanKindCode>('membership')
  const [display_name, setName] = useState('')
  const [price_amount, setPrice] = useState('')
  const [period, setPeriod] = useState<'monthly' | 'annual'>('monthly')
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
              label="Billed"
              value={period}
              onChange={(event) => setPeriod(event.target.value as 'monthly' | 'annual')}
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
