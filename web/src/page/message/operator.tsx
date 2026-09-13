// Operator → Player messages (R22). Provider status, the outbox, templates,
// and player preferences for transactional messages.

import { useState } from 'react'
import { operatorFetch } from '../../api.ts'
import { Alert, Badge, PageHeader, Tabs } from '../../component/ui.tsx'
import { useResource, type Resource } from '../../hook.ts'
import type { PageProp } from '../../registry.ts'
import { useOperator } from '../../session.tsx'
import './message.css'
import { OutboxTab } from './outbox.tsx'
import { PreferenceTab } from './preference.tsx'
import { TemplateTab } from './template.tsx'
import { CHANNEL_LABEL, countLabel, type ProviderStatus } from './type.ts'

type TabCode = 'outbox' | 'template' | 'preference'

function ProviderAlert({ resource }: { resource: Resource<{ provider: ProviderStatus }> }) {
  const provider = resource.data?.provider
  if (!provider) return null
  if (provider.is_configured) {
    return (
      <Alert severity="success" title={`Messages send through ${provider.provider_code ?? 'your provider'}`}>
        <div className="row">
          {provider.channel.map((one) => (
            <Badge key={one.delivery_channel} tone="success">
              {CHANNEL_LABEL[one.delivery_channel]} · {one.status_label}
            </Badge>
          ))}
        </div>
      </Alert>
    )
  }
  const required = provider.env.filter((one) => one.is_required)
  const optional = provider.env.filter((one) => !one.is_required)
  return (
    <Alert severity="caution" title="Messages are held — no provider is configured">
      <p>
        Every confirmation, receipt, and reminder is saved in the outbox and waits there until a provider is
        configured. Nothing reaches players yet
        {provider.held_count > 0 ? `; ${countLabel(provider.held_count, 'message')} waiting now` : ''}.
      </p>
      <p>
        To start sending, the venue owner sets <span className="mono">{required.map((one) => one.env_name).join(', ')}</span> on
        the server (optionally <span className="mono">{optional.map((one) => one.env_name).join(', ')}</span>), restarts it, then
        chooses <strong>Send queued now</strong>.
      </p>
    </Alert>
  )
}

export default function Page(_prop: PageProp) {
  const { can } = useOperator()
  const can_manage = can('message.manage')
  const [tab, setTab] = useState<TabCode>('outbox')
  const provider = useResource(() => operatorFetch<{ provider: ProviderStatus }>('/api/v1/message/provider'), [])

  return (
    <>
      <PageHeader
        eyebrow="Connect"
        title="Player messages"
        description="Confirmations, receipts, reminders, and updates about one player’s own booking, program, or order. Campaigns and broadcasts are intentionally not supported, so players only hear from you about something they did."
      />
      <div className="stack">
        <ProviderAlert resource={provider} />
        <div>
          <Tabs<TabCode>
            label="Player message sections"
            value={tab}
            onChange={setTab}
            option={[
              { value: 'outbox', label: 'Outbox' },
              { value: 'template', label: 'Templates' },
              { value: 'preference', label: 'Preferences' },
            ]}
          />
          {tab === 'outbox' && <OutboxTab can_manage={can_manage} onChange={provider.reload} />}
          {tab === 'template' && <TemplateTab can_manage={can_manage} />}
          {tab === 'preference' && <PreferenceTab can_manage={can_manage} />}
        </div>
      </div>
    </>
  )
}
