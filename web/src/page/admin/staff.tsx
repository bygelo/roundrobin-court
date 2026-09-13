// /operator/staff — people who sign in, their role, and recent activity (R04).

import { Plus } from '@phosphor-icons/react'
import { useState, type FormEvent } from 'react'
import { jsonBody, operatorFetch } from '../../api.ts'
import {
  Alert,
  Badge,
  Button,
  Card,
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
import { useAction, useResource } from '../../hook.ts'
import type { PageProp } from '../../registry.ts'
import { useOperator } from '../../session.tsx'
import { ConfirmDialog, SecretReveal } from './shared.tsx'

type Staff = {
  actor_id: string
  actor_code: string
  display_name: string
  role_code: string | null
  role_display_name: string | null
  status: 'active' | 'disabled'
  is_secret_pending: boolean
  last_sign_in_at: string | null
  created_at: string
  is_self: boolean
}

type Role = { role_code: string; display_name: string; description: string; capability_count: number }

type AuditEvent = { audit_event_id: string; event_code: string; summary: string; actor_display_name: string; created_at: string }

type SecretResult = { staff: Staff; temporary_secret: string }

type Modal =
  | { kind: 'add' }
  | { kind: 'role'; staff: Staff }
  | { kind: 'reset'; staff: Staff }
  | { kind: 'disable'; staff: Staff }
  | { kind: 'enable'; staff: Staff }
  | { kind: 'secret'; title: string; staff: Staff; secret: string }

const ROLE_TONE: Record<string, BadgeTone> = { owner: 'info', manager: 'info' }

export default function Page(_prop: PageProp) {
  const operator = useOperator()
  const can_manage = operator.can('admin.manage')
  const roster = useResource(() => operatorFetch<{ staff: Staff[]; role: Role[] }>('/api/v1/admin/staff'), [])
  const activity = useResource(
    () => operatorFetch<{ audit_event: AuditEvent[] }>('/api/v1/admin/audit?limit_count=25'),
    [],
  )
  const [modal, setModal] = useState<Modal>()
  const [notice, setNotice] = useState<string>()

  const refresh = () => {
    roster.reload()
    activity.reload()
  }
  const close = () => setModal(undefined)

  const add = useAction((input: { actor_code: string; display_name: string; role_code: string }) =>
    operatorFetch<SecretResult>('/api/v1/admin/staff', jsonBody(input)),
  )
  const changeRole = useAction((staff: Staff, role_code: string) =>
    operatorFetch<{ staff: Staff }>(`/api/v1/admin/staff/${staff.actor_id}`, jsonBody({ role_code }, 'PATCH')),
  )
  const lifecycle = useAction((staff: Staff, verb: 'disable' | 'enable' | 'reset-secret') =>
    operatorFetch<Partial<SecretResult> & { staff: Staff; revoked_session_count?: number }>(
      `/api/v1/admin/staff/${staff.actor_id}/${verb}`,
      jsonBody({}),
    ),
  )

  const role_option = (roster.data?.role ?? []).map((one) => ({ value: one.role_code, label: one.display_name }))
  const describeRole = (role_code: string) => roster.data?.role.find((one) => one.role_code === role_code)?.description

  return (
    <div className="stack stack--lg">
      <PageHeader
        eyebrow="Admin"
        title="Staff"
        description="Everyone who signs in to the console, what their role lets them do, and what changed recently."
        action={
          can_manage && (
            <Button icon={<Plus size={18} aria-hidden />} onClick={() => setModal({ kind: 'add' })}>
              Add staff
            </Button>
          )
        }
      />

      {notice && (
        <Alert severity="success" onDismiss={() => setNotice(undefined)}>
          {notice}
        </Alert>
      )}

      <ResourceView resource={roster}>
        {(data) =>
          data.staff.length === 0 ? (
            <EmptyState
              title="No staff yet"
              description="Add the people who run your desk and score matches."
              action={can_manage && <Button onClick={() => setModal({ kind: 'add' })}>Add staff</Button>}
            />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Role</th>
                    <th scope="col">Status</th>
                    <th scope="col">Last sign-in</th>
                    {can_manage && <th scope="col">Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {data.staff.map((one) => (
                    <tr key={one.actor_id}>
                      <td>
                        <strong>{one.display_name}</strong> {one.is_self && <Badge tone="info">You</Badge>}
                        <span className="admin-cell-note mono">{one.actor_code}</span>
                      </td>
                      <td>
                        <Badge tone={ROLE_TONE[one.role_code ?? ''] ?? 'neutral'}>{one.role_display_name ?? 'No role'}</Badge>
                      </td>
                      <td>
                        {one.status === 'active' ? (
                          one.is_secret_pending ? (
                            <Badge tone="caution">Needs a password</Badge>
                          ) : (
                            <Badge tone="success">Active</Badge>
                          )
                        ) : (
                          <Badge tone="danger">Disabled</Badge>
                        )}
                      </td>
                      <td>{one.last_sign_in_at ? formatDateTime(one.last_sign_in_at) : <span className="muted">Never</span>}</td>
                      {can_manage && (
                        <td>
                          <div className="admin-action">
                            <Button tone="quiet" size="sm" onClick={() => setModal({ kind: 'role', staff: one })}>
                              Change role
                            </Button>
                            {!one.is_self && one.status === 'active' && (
                              <>
                                <Button tone="quiet" size="sm" onClick={() => setModal({ kind: 'reset', staff: one })}>
                                  Reset password
                                </Button>
                                <Button tone="quiet" size="sm" onClick={() => setModal({ kind: 'disable', staff: one })}>
                                  Disable
                                </Button>
                              </>
                            )}
                            {!one.is_self && one.status === 'disabled' && (
                              <Button tone="quiet" size="sm" onClick={() => setModal({ kind: 'enable', staff: one })}>
                                Enable
                              </Button>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </ResourceView>

      <Card title="Recent activity" description="Staff, module, and privacy changes, newest first.">
        <ResourceView resource={activity}>
          {(data) =>
            data.audit_event.length === 0 ? (
              <EmptyState title="Nothing yet" description="Changes to staff and modules will show up here." />
            ) : (
              <ol className="admin-activity">
                {data.audit_event.map((one) => (
                  <li key={one.audit_event_id}>
                    <span>{one.summary}</span>
                    <small>
                      {one.actor_display_name} · {formatDateTime(one.created_at)}
                    </small>
                  </li>
                ))}
              </ol>
            )
          }
        </ResourceView>
      </Card>

      {modal?.kind === 'add' && (
        <AddStaffDialog
          role_option={role_option}
          describeRole={describeRole}
          is_pending={add.is_pending}
          error={add.error}
          onClose={() => {
            add.clearError()
            close()
          }}
          onSubmit={async (input) => {
            const result = await add.run(input)
            if (result) {
              refresh()
              setNotice(`Added ${result.staff.display_name} as ${result.staff.role_display_name}.`)
              setModal({ kind: 'secret', title: 'Temporary password', staff: result.staff, secret: result.temporary_secret })
            }
          }}
        />
      )}

      {modal?.kind === 'role' && (
        <RoleDialog
          staff={modal.staff}
          role_option={role_option}
          describeRole={describeRole}
          is_pending={changeRole.is_pending}
          error={changeRole.error}
          onClose={() => {
            changeRole.clearError()
            close()
          }}
          onSubmit={async (role_code) => {
            const result = await changeRole.run(modal.staff, role_code)
            if (result) {
              refresh()
              setNotice(`${result.staff.display_name} is now ${result.staff.role_display_name}. It applies from their next click.`)
              close()
            }
          }}
        />
      )}

      {(modal?.kind === 'reset' || modal?.kind === 'disable' || modal?.kind === 'enable') && (
        <ConfirmDialog
          open
          title={
            modal.kind === 'reset'
              ? `Reset the password for ${modal.staff.display_name}?`
              : modal.kind === 'disable'
                ? `Disable ${modal.staff.display_name}?`
                : `Enable ${modal.staff.display_name}?`
          }
          confirm_label={modal.kind === 'reset' ? 'Reset password' : modal.kind === 'disable' ? 'Disable' : 'Enable'}
          tone={modal.kind === 'disable' ? 'danger' : 'primary'}
          is_pending={lifecycle.is_pending}
          error={lifecycle.error}
          onClose={() => {
            lifecycle.clearError()
            close()
          }}
          onConfirm={async () => {
            const staff = modal.staff
            const verb = modal.kind === 'reset' ? 'reset-secret' : modal.kind
            const result = await lifecycle.run(staff, verb)
            if (!result) return
            refresh()
            if (result.temporary_secret) {
              setNotice(
                verb === 'enable'
                  ? `${staff.display_name} can sign in again with the new password.`
                  : `${staff.display_name} was signed out everywhere and has a new password.`,
              )
              setModal({ kind: 'secret', title: 'New temporary password', staff: result.staff, secret: result.temporary_secret })
            } else {
              setNotice(`${staff.display_name} is disabled and was signed out of every device.`)
              close()
            }
          }}
        >
          {modal.kind === 'reset' && (
            <p>They are signed out of every device right away and get a new temporary password to give them in person.</p>
          )}
          {modal.kind === 'disable' && (
            <p>
              They are signed out of every device on their next click, cannot sign in, and any API keys they created stop
              working. Their past bookings and activity stay.
            </p>
          )}
          {modal.kind === 'enable' && <p>They get a new temporary password. Their old password does not come back.</p>}
        </ConfirmDialog>
      )}

      {modal?.kind === 'secret' && (
        <Dialog
          open
          title={modal.title}
          onClose={close}
          footer={
            <Button onClick={close}>I have saved it</Button>
          }
        >
          <div className="stack">
            <p>
              Give this to <strong>{modal.staff.display_name}</strong>. They sign in with staff code{' '}
              <span className="mono">{modal.staff.actor_code}</span>.
            </p>
            <SecretReveal
              label={`Temporary password for ${modal.staff.display_name}`}
              value={modal.secret}
              warning="Copy it now. It is not stored anywhere readable, so if it is lost you will need to reset it."
            />
          </div>
        </Dialog>
      )}
    </div>
  )
}

function AddStaffDialog({
  role_option,
  describeRole,
  is_pending,
  error,
  onClose,
  onSubmit,
}: {
  role_option: { value: string; label: string }[]
  describeRole: (role_code: string) => string | undefined
  is_pending: boolean
  error: Error | undefined
  onClose: () => void
  onSubmit: (input: { actor_code: string; display_name: string; role_code: string }) => void
}) {
  const [display_name, setDisplayName] = useState('')
  const [actor_code, setActorCode] = useState('')
  const [role_code, setRoleCode] = useState('front_desk')

  const submit = (event: FormEvent) => {
    event.preventDefault()
    onSubmit({ display_name: display_name.trim(), actor_code: actor_code.trim().toLowerCase(), role_code })
  }

  return (
    <Dialog open title="Add staff" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <ErrorAlert error={error} />
        <TextInput label="Name" value={display_name} onChange={(event) => setDisplayName(event.target.value)} required autoFocus />
        <TextInput
          label="Staff code"
          hint="They sign in with this. Lowercase letters, numbers, dots, or dashes."
          value={actor_code}
          onChange={(event) => setActorCode(event.target.value)}
          pattern="[a-zA-Z0-9][a-zA-Z0-9._\-]{1,39}"
          autoCapitalize="none"
          required
        />
        <SelectInput
          label="Role"
          hint={describeRole(role_code)}
          option={role_option}
          value={role_code}
          onChange={(event) => setRoleCode(event.target.value)}
        />
        <div className="form__action">
          <Button tone="secondary" onClick={onClose} disabled={is_pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={is_pending}>
            {is_pending ? 'Adding…' : 'Add and show password'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

function RoleDialog({
  staff,
  role_option,
  describeRole,
  is_pending,
  error,
  onClose,
  onSubmit,
}: {
  staff: Staff
  role_option: { value: string; label: string }[]
  describeRole: (role_code: string) => string | undefined
  is_pending: boolean
  error: Error | undefined
  onClose: () => void
  onSubmit: (role_code: string) => void
}) {
  const [role_code, setRoleCode] = useState(staff.role_code ?? 'viewer')
  return (
    <Dialog open title={`Change role for ${staff.display_name}`} onClose={onClose}>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault()
          onSubmit(role_code)
        }}
      >
        <ErrorAlert error={error} />
        <SelectInput
          label="Role"
          hint={describeRole(role_code)}
          option={role_option}
          value={role_code}
          onChange={(event) => setRoleCode(event.target.value)}
        />
        <div className="form__action">
          <Button tone="secondary" onClick={onClose} disabled={is_pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={is_pending || role_code === staff.role_code}>
            {is_pending ? 'Saving…' : 'Save role'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
