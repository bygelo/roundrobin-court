// Operator → Player messages (R22). Provider status per channel, a test
// email, the outbox, templates, and player preferences for transactional
// messages.

import { useState } from 'react'
import { operatorFetch } from '../../api.ts'
import { PageHeader, Tabs } from '../../component/ui.tsx'
import { useResource } from '../../hook.ts'
import type { PageProp } from '../../registry.ts'
import { useOperator } from '../../session.tsx'
import './message.css'
import { OutboxTab } from './outbox.tsx'
import { PreferenceTab } from './preference.tsx'
import { ProviderAlert, TestEmailForm } from './provider.tsx'
import { TemplateTab } from './template.tsx'
import type { ProviderStatus } from './type.ts'

type TabCode = 'outbox' | 'template' | 'preference'

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
        {can_manage && <TestEmailForm />}
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
