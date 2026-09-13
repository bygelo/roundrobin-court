// /operator/module — turn venue modules on and off (R03).

import { useState } from 'react'
import { ApiError, jsonBody, operatorFetch } from '../../api.ts'
import { Alert, Badge, Button, Card, PageHeader, ResourceView } from '../../component/ui.tsx'
import { useResource } from '../../hook.ts'
import type { PageProp } from '../../registry.ts'
import { useOperator } from '../../session.tsx'
import { ConfirmDialog, errorMessage, joinName } from './shared.tsx'

type ModuleName = { module_code: string; display_name: string }

type ModuleView = ModuleName & {
  family: string
  description: string
  is_enabled: boolean
  is_removable: boolean
  depend_on: ModuleName[]
  required_by_enabled: ModuleName[]
}

const FAMILY: { family: string; description: string }[] = [
  { family: 'Core', description: 'Booking, payments, courts, and the tools to run the venue.' },
  { family: 'Play', description: 'Open play, programs, check-in, scoring, and court screens.' },
  { family: 'Business', description: 'Shop, memberships, and reports.' },
  { family: 'Studio', description: 'Your public venue site.' },
  { family: 'Connect', description: 'Messages, integrations, and privacy.' },
]

type Notice = {
  severity: 'success' | 'danger'
  title: string
  body: string
  /** When an enable was refused for missing dependencies, offer to turn them on together. */
  chain?: { target: ModuleView; missing: ModuleName[] }
}

function dependencySentence(one: ModuleView): string {
  const part: string[] = []
  if (one.depend_on.length > 0) part.push(`Needs ${joinName(one.depend_on.map((each) => each.display_name))}`)
  if (one.required_by_enabled.length > 0) {
    part.push(`Used by ${one.required_by_enabled.map((each) => each.display_name).join(', ')}`)
  }
  return part.length > 0 ? part.join(' · ') : 'Works on its own'
}

export default function Page(_prop: PageProp) {
  const operator = useOperator()
  const list = useResource(() => operatorFetch<{ module: ModuleView[] }>('/api/v1/admin/module'), [])
  const [notice, setNotice] = useState<Notice>()
  const [confirm, setConfirm] = useState<ModuleView>()
  const [pending_code, setPendingCode] = useState<string>()
  const can_manage = operator.can('admin.manage')

  const change = async (target: ModuleView, mode: 'enable' | 'disable', with_dependency = false) => {
    setPendingCode(target.module_code)
    setNotice(undefined)
    try {
      const result = await operatorFetch<{ message: string }>(
        `/api/v1/admin/module/${encodeURIComponent(target.module_code)}/${mode}`,
        jsonBody(mode === 'enable' ? { with_dependency } : {}),
      )
      setNotice({
        severity: 'success',
        title: mode === 'enable' ? `${target.display_name} is on` : `${target.display_name} is off`,
        body: result.message,
      })
      list.reload()
      operator.refreshCapability()
    } catch (error) {
      const body = error instanceof ApiError ? (error.body as { missing_dependency?: ModuleName[] } | undefined) : undefined
      const next: Notice = {
        severity: 'danger',
        title: mode === 'enable' ? `Could not turn on ${target.display_name}` : `Could not turn off ${target.display_name}`,
        body: errorMessage(error),
      }
      if (body?.missing_dependency && body.missing_dependency.length > 0) {
        next.chain = { target, missing: body.missing_dependency }
      }
      setNotice(next)
    } finally {
      setPendingCode(undefined)
      setConfirm(undefined)
    }
  }

  return (
    <div className="stack stack--lg">
      <PageHeader
        eyebrow="Admin"
        title="Modules"
        description="Turn features on when your venue needs them. Turning one off hides its screens and API routes; its data stays."
      />

      {!can_manage && (
        <Alert severity="info" title="View only">
          Only an owner can turn modules on or off.
        </Alert>
      )}

      {notice && (
        <Alert severity={notice.severity} title={notice.title} onDismiss={() => setNotice(undefined)}>
          <p>{notice.body}</p>
          {notice.chain && can_manage && (
            <Button
              size="sm"
              disabled={pending_code !== undefined}
              onClick={() => change(notice.chain!.target, 'enable', true)}
            >
              Turn on {joinName([...notice.chain.missing.map((one) => one.display_name), notice.chain.target.display_name])}
            </Button>
          )}
        </Alert>
      )}

      <ResourceView resource={list}>
        {(data) => (
          <>
            {FAMILY.map(({ family, description }) => {
              const member = data.module.filter((one) => one.family === family)
              if (member.length === 0) return null
              const on_count = member.filter((one) => one.is_enabled).length
              return (
                <section key={family} className="admin-family" aria-labelledby={`family-${family}`}>
                  <header className="admin-family__header">
                    <h2 id={`family-${family}`}>{family}</h2>
                    <p className="muted">
                      {description} {on_count} of {member.length} on.
                    </p>
                  </header>
                  <div className="admin-module-grid">
                    {member.map((one) => (
                      <Card
                        key={one.module_code}
                        className="admin-module"
                        title={one.display_name}
                        action={<Badge tone={one.is_enabled ? 'success' : 'neutral'}>{one.is_enabled ? 'Enabled' : 'Off'}</Badge>}
                      >
                        <p>{one.description}</p>
                        <p className="muted admin-module__dependency">{dependencySentence(one)}</p>
                        <div className="admin-module__action">
                          {!one.is_removable ? (
                            <Badge tone="info">Always on</Badge>
                          ) : can_manage ? (
                            one.is_enabled ? (
                              <Button
                                tone="secondary"
                                size="sm"
                                disabled={pending_code !== undefined}
                                onClick={() => setConfirm(one)}
                              >
                                Turn off
                              </Button>
                            ) : (
                              <Button size="sm" disabled={pending_code !== undefined} onClick={() => change(one, 'enable')}>
                                {pending_code === one.module_code ? 'Turning on…' : 'Turn on'}
                              </Button>
                            )
                          ) : null}
                        </div>
                      </Card>
                    ))}
                  </div>
                </section>
              )
            })}
          </>
        )}
      </ResourceView>

      <ConfirmDialog
        open={confirm !== undefined}
        title={`Turn off ${confirm?.display_name ?? ''}?`}
        confirm_label="Turn off"
        tone="danger"
        is_pending={pending_code !== undefined}
        onClose={() => setConfirm(undefined)}
        onConfirm={() => confirm && change(confirm, 'disable')}
      >
        <p>
          Its screens disappear for every staff member and its API routes stop answering. Staff roles keep their
          settings but grant nothing for this module while it is off.
        </p>
        <Alert severity="info" title="Nothing is deleted">
          Every record stays exactly as it is and comes back when you turn {confirm?.display_name ?? 'it'} on again.
        </Alert>
      </ConfirmDialog>
    </div>
  )
}
