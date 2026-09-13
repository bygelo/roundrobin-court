// Connections — DUPR, webhooks, and calendar feeds in one operator screen.

import { useState } from 'react'
import { EmptyState, PageHeader, Tabs } from '../../component/ui.tsx'
import type { PageProp } from '../../registry.ts'
import { useQuery } from '../../route.tsx'
import { useOperator } from '../../session.tsx'
import CalendarTab from './calendar-tab.tsx'
import DuprTab from './dupr-tab.tsx'
import WebhookTab from './webhook-tab.tsx'
import './connect.css'

type TabCode = 'dupr' | 'webhook' | 'calendar'

const TAB: { value: TabCode; label: string }[] = [
  { value: 'dupr', label: 'DUPR' },
  { value: 'webhook', label: 'Webhooks' },
  { value: 'calendar', label: 'Calendar' },
]

export default function Page(_prop: PageProp) {
  const { isEnabled } = useOperator()
  const query = useQuery()
  const option = TAB.filter((one) => isEnabled(one.value))
  const [tab, setTab] = useState<TabCode>((query.get('tab') as TabCode | null) ?? 'dupr')
  const active = option.find((one) => one.value === tab)?.value ?? option[0]?.value

  return (
    <>
      <PageHeader
        eyebrow="Connect"
        title="Connections"
        description="Share results with DUPR, push venue events to your other systems, and publish a court calendar."
      />
      {option.length === 0 || !active ? (
        <EmptyState
          title="No connections are turned on"
          description="Turn on DUPR, Webhooks, or Calendar feed under Admin → Modules."
        />
      ) : (
        <>
          <Tabs label="Connection type" value={active} option={option} onChange={setTab} />
          {active === 'dupr' && <DuprTab />}
          {active === 'webhook' && <WebhookTab />}
          {active === 'calendar' && <CalendarTab />}
        </>
      )}
    </>
  )
}
