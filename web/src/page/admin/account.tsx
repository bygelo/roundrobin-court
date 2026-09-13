// /operator/account — who you are, change your own password, sign out other
// devices. Any signed-in staff member, whatever their role.

import { Eye, EyeSlash, SignOut } from '@phosphor-icons/react'
import { useState, type FormEvent, type InputHTMLAttributes } from 'react'
import { jsonBody, operatorFetch } from '../../api.ts'
import { Alert, Badge, Button, Card, ErrorAlert, Field, PageHeader, ResourceView, type BadgeTone } from '../../component/ui.tsx'
import { formatDateTime } from '../../format.ts'
import { useAction, useResource } from '../../hook.ts'
import type { PageProp } from '../../registry.ts'
import { ConfirmDialog } from './shared.tsx'

type Account = {
  actor_id: string
  actor_code: string
  display_name: string
  role_code: string | null
  role_display_name: string | null
  session_started_at: string | null
  last_sign_in_at: string | null
  active_session_count: number
  is_secret_temporary: boolean
}

const MIN_LENGTH = 10
const ROLE_TONE: Record<string, BadgeTone> = { owner: 'info', manager: 'info' }

/** A plain-language strength hint. The server enforces only the length and reuse rules. */
export function describeStrength(secret: string, actor_code: string): { text: string; is_ok: boolean } {
  if (secret.length === 0) return { text: `At least ${MIN_LENGTH} characters. A few unrelated words work well.`, is_ok: false }
  if (secret.length < MIN_LENGTH) {
    const left = MIN_LENGTH - secret.length
    return { text: `${left} more character${left === 1 ? '' : 's'} needed.`, is_ok: false }
  }
  if (secret.trim().toLowerCase() === actor_code.toLowerCase()) return { text: 'Do not use your staff code.', is_ok: false }
  const kind = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((one) => one.test(secret)).length
  if (secret.length >= 16 || (secret.length >= 12 && kind >= 3)) return { text: 'Strong.', is_ok: true }
  if (kind >= 2) return { text: 'Good. Longer is stronger.', is_ok: true }
  return { text: 'Fair. Add another word or a mix of characters.', is_ok: true }
}

function PasswordInput({
  label,
  hint,
  error,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; error?: string | undefined }) {
  const [is_shown, setShown] = useState(false)
  return (
    <Field label={label} hint={hint} error={error}>
      {(id) => (
        <div className="admin-password">
          <input
            id={id}
            className="input"
            type={is_shown ? 'text' : 'password'}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-invalid={error ? true : undefined}
            {...rest}
          />
          <Button
            tone="quiet"
            size="sm"
            aria-controls={id}
            aria-pressed={is_shown}
            aria-label={`${is_shown ? 'Hide' : 'Show'} ${label.toLowerCase()}`}
            icon={is_shown ? <EyeSlash size={18} aria-hidden /> : <Eye size={18} aria-hidden />}
            onClick={() => setShown((value) => !value)}
          >
            {is_shown ? 'Hide' : 'Show'}
          </Button>
        </div>
      )}
    </Field>
  )
}

export default function Page(_prop: PageProp) {
  const account = useResource(() => operatorFetch<{ account: Account }>('/api/v1/admin/account').then((one) => one.account), [])
  const [notice, setNotice] = useState<string>()
  const [is_confirm_open, setConfirmOpen] = useState(false)

  const signOutOther = useAction(() =>
    operatorFetch<{ revoked_session_count: number }>('/api/v1/admin/account/sign-out-other', jsonBody({})),
  )

  return (
    <div className="stack stack--lg">
      <PageHeader eyebrow="Account" title="Your account" description="Who you are signed in as, and your password." />

      {notice && (
        <Alert severity="success" onDismiss={() => setNotice(undefined)}>
          {notice}
        </Alert>
      )}

      <ResourceView resource={account}>
        {(data) => (
          <>
            {data.is_secret_temporary && (
              <Alert severity="caution" title="Set your own password">
                Your password was given to you by an owner. Choose a new one that only you know.
              </Alert>
            )}

            <Card title="Who you are">
              <dl className="admin-fact">
                <div>
                  <dt>Name</dt>
                  <dd>
                    <strong>{data.display_name}</strong>
                  </dd>
                </div>
                <div>
                  <dt>Staff code</dt>
                  <dd className="mono">{data.actor_code}</dd>
                </div>
                <div>
                  <dt>Role</dt>
                  <dd>
                    <Badge tone={ROLE_TONE[data.role_code ?? ''] ?? 'neutral'}>{data.role_display_name ?? 'No role'}</Badge>
                  </dd>
                </div>
                <div>
                  <dt>Signed in on this device</dt>
                  <dd>{data.session_started_at ? formatDateTime(data.session_started_at) : '—'}</dd>
                </div>
                <div>
                  <dt>Sign-in before that</dt>
                  <dd>{data.last_sign_in_at ? formatDateTime(data.last_sign_in_at) : <span className="muted">None</span>}</dd>
                </div>
              </dl>
            </Card>

            <PasswordCard
              actor_code={data.actor_code}
              onChanged={(revoked_session_count) => {
                setNotice(
                  revoked_session_count > 0
                    ? 'Password changed — other devices were signed out.'
                    : 'Password changed — no other devices were signed in.',
                )
                account.reload()
              }}
            />

            <Card
              title="Devices"
              description={
                data.active_session_count <= 1
                  ? 'You are signed in on this device only.'
                  : `You are signed in on ${data.active_session_count} devices, including this one.`
              }
              action={
                <Button
                  tone="secondary"
                  size="sm"
                  icon={<SignOut size={16} aria-hidden />}
                  disabled={data.active_session_count <= 1}
                  onClick={() => setConfirmOpen(true)}
                >
                  Sign out other devices
                </Button>
              }
            />
          </>
        )}
      </ResourceView>

      <ConfirmDialog
        open={is_confirm_open}
        title="Sign out your other devices?"
        confirm_label="Sign out other devices"
        is_pending={signOutOther.is_pending}
        error={signOutOther.error}
        onClose={() => {
          signOutOther.clearError()
          setConfirmOpen(false)
        }}
        onConfirm={async () => {
          const result = await signOutOther.run()
          if (!result) return
          setConfirmOpen(false)
          setNotice(
            `Signed out ${result.revoked_session_count} other device${result.revoked_session_count === 1 ? '' : 's'}. This one stays signed in.`,
          )
          account.reload()
        }}
      >
        <p>Anyone using your account on another phone, tablet, or computer is signed out on their next click.</p>
      </ConfirmDialog>
    </div>
  )
}

function PasswordCard({ actor_code, onChanged }: { actor_code: string; onChanged: (revoked_session_count: number) => void }) {
  const [current_secret, setCurrent] = useState('')
  const [new_secret, setNew] = useState('')
  const [confirm_secret, setConfirm] = useState('')
  const [is_touched, setTouched] = useState(false)

  const save = useAction(() =>
    operatorFetch<{ revoked_session_count: number }>('/api/v1/admin/account/password', jsonBody({ current_secret, new_secret })),
  )

  const strength = describeStrength(new_secret, actor_code)
  const mismatch = is_touched && confirm_secret.length > 0 && confirm_secret !== new_secret ? 'The two new passwords do not match.' : undefined
  const is_ready = current_secret.length > 0 && strength.is_ok && confirm_secret === new_secret && new_secret !== current_secret

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setTouched(true)
    if (!is_ready) return
    const result = await save.run()
    if (!result) return
    setCurrent('')
    setNew('')
    setConfirm('')
    setTouched(false)
    onChanged(result.revoked_session_count)
  }

  return (
    <Card title="Change your password" description="Changing it signs you out everywhere except this device.">
      <form className="form" onSubmit={submit}>
        <ErrorAlert error={save.error} onDismiss={save.clearError} />
        <PasswordInput
          label="Current password"
          autoComplete="current-password"
          value={current_secret}
          onChange={(event) => setCurrent(event.target.value)}
          required
        />
        <PasswordInput
          label="New password"
          autoComplete="new-password"
          hint={strength.text}
          error={is_touched && !strength.is_ok && new_secret.length > 0 ? strength.text : undefined}
          value={new_secret}
          onChange={(event) => setNew(event.target.value)}
          minLength={MIN_LENGTH}
          required
        />
        <PasswordInput
          label="Confirm new password"
          autoComplete="new-password"
          error={mismatch}
          value={confirm_secret}
          onChange={(event) => {
            setConfirm(event.target.value)
            setTouched(true)
          }}
          required
        />
        {new_secret.length > 0 && new_secret === current_secret && (
          <p className="field__error">Choose a password that is different from your current one.</p>
        )}
        <div className="form__action">
          <Button type="submit" disabled={save.is_pending || !is_ready}>
            {save.is_pending ? 'Changing…' : 'Change password'}
          </Button>
        </div>
      </form>
    </Card>
  )
}
