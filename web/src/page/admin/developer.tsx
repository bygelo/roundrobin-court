// /operator/developer — the public API explained, and API keys (R19).
// Keys are created, listed, and revoked through the kernel's own routes.

import { ArrowSquareOut, Plus } from '@phosphor-icons/react'
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
  PageHeader,
  ResourceView,
  SelectInput,
  TextInput,
} from '../../component/ui.tsx'
import { formatDate, formatDateTime } from '../../format.ts'
import { useAction, useResource } from '../../hook.ts'
import type { PageProp } from '../../registry.ts'
import { useOperator } from '../../session.tsx'
import { ConfirmDialog, SecretReveal } from './shared.tsx'

type ApiKey = {
  api_key_id: string
  display_name: string
  key_prefix: string
  capability: string[]
  rate_limit_per_minute: number
  expire_at: string | null
  revoked_at: string | null
  created_at: string
  last_used_at: string | null
}

type CatalogModule = {
  module_code: string
  display_name: string
  capability: { capability_code: string; description: string; is_held: boolean }[]
}

const EXPIRY_OPTION = [
  { value: '90', label: 'In 90 days' },
  { value: '30', label: 'In 30 days' },
  { value: '365', label: 'In 1 year' },
  { value: 'never', label: 'Never' },
]

function keyStatus(one: ApiKey): { label: string; tone: 'success' | 'caution' | 'neutral' } {
  if (one.revoked_at) return { label: 'Revoked', tone: 'neutral' }
  if (one.expire_at && new Date(one.expire_at).getTime() <= Date.now()) return { label: 'Expired', tone: 'caution' }
  return { label: 'Active', tone: 'success' }
}

export default function Page(_prop: PageProp) {
  const operator = useOperator()
  const can_manage_key = operator.can('kernel.api_key.manage')
  const key = useResource(
    () => (can_manage_key ? operatorFetch<{ api_key: ApiKey[] }>('/api/v1/api-key') : Promise.resolve({ api_key: [] })),
    [can_manage_key],
  )
  const [is_create_open, setCreateOpen] = useState(false)
  const [revoke, setRevoke] = useState<ApiKey>()
  const [created, setCreated] = useState<{ api_key: ApiKey; token: string }>()
  const [notice, setNotice] = useState<string>()
  const revokeAction = useAction((one: ApiKey) =>
    operatorFetch<{ is_revoked: boolean }>(`/api/v1/api-key/${one.api_key_id}`, { method: 'DELETE' }),
  )
  const origin = typeof window === 'undefined' ? '' : window.location.origin

  return (
    <div className="stack stack--lg">
      <PageHeader
        eyebrow="Admin"
        title="API and keys"
        description="Connect your own tools, such as a club website, a league spreadsheet, or a scheduling system, to this venue."
        action={
          can_manage_key && (
            <Button icon={<Plus size={18} aria-hidden />} onClick={() => setCreateOpen(true)}>
              Create key
            </Button>
          )
        }
      />

      {notice && (
        <Alert severity="success" onDismiss={() => setNotice(undefined)}>
          {notice}
        </Alert>
      )}

      <Card title="How the API works" description="A REST API over HTTPS, answering JSON.">
        <ol className="admin-step">
          <li>
            <strong>Create a key</strong> with only the permissions the tool needs. A key can never do more than the
            person who made it.
          </li>
          <li>
            <strong>Send it as a bearer token</strong> on every request:
            <pre className="admin-code">
              <code>{`curl -H "Authorization: Bearer rrk_…" \\\n  ${origin}/api/v1/capability`}</code>
            </pre>
          </li>
          <li>
            <strong>Ask what is on.</strong> <span className="mono">GET /api/v1/capability</span> lists the modules
            enabled right now and the routes they serve. When you turn a module off, its routes leave that list and
            answer 404.
          </li>
          <li>
            <strong>Read the reference.</strong> Every route is described in OpenAPI at{' '}
            <a href="/docs" target="_blank" rel="noreferrer">
              /docs <ArrowSquareOut size={14} aria-label="opens in a new tab" />
            </a>
            .
          </li>
        </ol>
        <p className="muted">
          Each key has a per-minute limit. Past it, requests get status 429 with a Retry-After header saying how many
          seconds to wait.
        </p>
      </Card>

      {!can_manage_key ? (
        <Alert severity="info" title="Keys are owner-only">
          Only an owner can see, create, or revoke API keys.
        </Alert>
      ) : (
        <ResourceView resource={key}>
          {(data) =>
            data.api_key.length === 0 ? (
              <EmptyState
                title="No API keys yet"
                description="Create one when a tool needs to read or change venue data."
                action={<Button onClick={() => setCreateOpen(true)}>Create key</Button>}
              />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Name</th>
                      <th scope="col">Starts with</th>
                      <th scope="col">Permissions</th>
                      <th scope="col">Expires</th>
                      <th scope="col">Last used</th>
                      <th scope="col">Status</th>
                      <th scope="col">
                        <span className="visually-hidden">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.api_key.map((one) => {
                      const status = keyStatus(one)
                      return (
                        <tr key={one.api_key_id}>
                          <td>
                            <strong>{one.display_name}</strong>
                            <span className="admin-cell-note">
                              Created {formatDate(one.created_at)} · {one.rate_limit_per_minute} requests a minute
                            </span>
                          </td>
                          <td className="mono">{one.key_prefix}…</td>
                          <td title={one.capability.join(', ')}>{one.capability.length}</td>
                          <td>{one.expire_at ? formatDate(one.expire_at) : 'Never'}</td>
                          <td>{one.last_used_at ? formatDateTime(one.last_used_at) : <span className="muted">Never</span>}</td>
                          <td>
                            <Badge tone={status.tone}>{status.label}</Badge>
                          </td>
                          <td>
                            {!one.revoked_at && (
                              <Button tone="quiet" size="sm" onClick={() => setRevoke(one)}>
                                Revoke
                              </Button>
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
      )}

      {is_create_open && (
        <CreateKeyDialog
          onClose={() => setCreateOpen(false)}
          onCreated={(result) => {
            setCreateOpen(false)
            setCreated(result)
            setNotice(`Created key "${result.api_key.display_name}".`)
            key.reload()
          }}
        />
      )}

      <ConfirmDialog
        open={revoke !== undefined}
        title={`Revoke "${revoke?.display_name ?? ''}"?`}
        confirm_label="Revoke key"
        tone="danger"
        is_pending={revokeAction.is_pending}
        error={revokeAction.error}
        onClose={() => {
          revokeAction.clearError()
          setRevoke(undefined)
        }}
        onConfirm={async () => {
          if (!revoke) return
          const result = await revokeAction.run(revoke)
          if (result) {
            setNotice(`Revoked "${revoke.display_name}". Its next request is refused.`)
            setRevoke(undefined)
            key.reload()
          }
        }}
      >
        <p>Any tool using this key stops working on its next request. This cannot be undone; create a new key instead.</p>
      </ConfirmDialog>

      {created && (
        <Dialog open title="Your new API key" onClose={() => setCreated(undefined)} footer={<Button onClick={() => setCreated(undefined)}>I have saved it</Button>}>
          <SecretReveal
            label={`API key ${created.api_key.display_name}`}
            value={created.token}
            warning="Copy it into your tool now. Only its first characters are kept, so it cannot be shown again."
          />
        </Dialog>
      )}
    </div>
  )
}

function CreateKeyDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (result: { api_key: ApiKey; token: string }) => void
}) {
  const catalog = useResource(() => operatorFetch<{ module: CatalogModule[] }>('/api/v1/admin/capability-catalog'), [])
  const [display_name, setDisplayName] = useState('')
  const [expiry, setExpiry] = useState('90')
  const [rate, setRate] = useState('60')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const create = useAction((body: unknown) => operatorFetch<{ api_key: ApiKey; token: string }>('/api/v1/api-key', jsonBody(body)))

  const toggle = (code: string[], is_on: boolean) =>
    setSelected((current) => {
      const next = new Set(current)
      for (const one of code) {
        if (is_on) next.add(one)
        else next.delete(one)
      }
      return next
    })

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const body: Record<string, unknown> = {
      display_name: display_name.trim(),
      capability: [...selected].sort(),
      rate_limit_per_minute: Number(rate),
    }
    if (expiry !== 'never') body['expire_at'] = new Date(Date.now() + Number(expiry) * 86_400_000).toISOString()
    const result = await create.run(body)
    if (result) onCreated(result)
  }

  return (
    <Dialog open title="Create API key" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <ErrorAlert error={create.error} onDismiss={create.clearError} />
        <TextInput
          label="Name"
          hint="Say what uses it, like “League spreadsheet”."
          value={display_name}
          onChange={(event) => setDisplayName(event.target.value)}
          required
          autoFocus
        />
        <div className="form__row">
          <SelectInput label="Expires" option={EXPIRY_OPTION} value={expiry} onChange={(event) => setExpiry(event.target.value)} />
          <TextInput
            label="Requests a minute"
            type="number"
            min={1}
            max={6000}
            value={rate}
            onChange={(event) => setRate(event.target.value)}
            required
          />
        </div>
        <ResourceView resource={catalog}>
          {(data) => (
            <div className="admin-checklist" role="group" aria-label="Permissions">
              {data.module.map((group) => {
                const held = group.capability.filter((one) => one.is_held).map((one) => one.capability_code)
                const is_all = held.length > 0 && held.every((one) => selected.has(one))
                return (
                  <fieldset key={group.module_code}>
                    <legend>{group.display_name}</legend>
                    {held.length > 1 && (
                      <Checkbox
                        label={`Select all ${group.display_name} permissions`}
                        checked={is_all}
                        onChange={(event) => toggle(held, event.target.checked)}
                      />
                    )}
                    {group.capability.map((one) => (
                      <div key={one.capability_code} className="admin-checklist__item">
                        <Checkbox
                          label={
                            <>
                              <span className="mono">{one.capability_code}</span>
                              <small>{one.is_held ? one.description : `${one.description} (you do not hold this)`}</small>
                            </>
                          }
                          checked={selected.has(one.capability_code)}
                          disabled={!one.is_held}
                          onChange={(event) => toggle([one.capability_code], event.target.checked)}
                        />
                      </div>
                    ))}
                  </fieldset>
                )
              })}
            </div>
          )}
        </ResourceView>
        <p className="muted">{selected.size === 0 ? 'Choose at least one permission.' : `${selected.size} permission selected.`}</p>
        <div className="form__action">
          <Button tone="secondary" onClick={onClose} disabled={create.is_pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={create.is_pending || selected.size === 0}>
            {create.is_pending ? 'Creating…' : 'Create and show key'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
