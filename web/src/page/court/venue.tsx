// Venue setup (R06, R08): the operator configures the whole venue from here —
// no SQL, no seed edit. Tabs keep each concern on its own screen; a first-run
// checklist appears until the venue can actually sell a slot.

import { useState } from 'react'
import { operatorFetch } from '../../api.ts'
import { Alert, Badge, Button, Card, PageHeader, ResourceView, Tabs } from '../../component/ui.tsx'
import { useResource } from '../../hook.ts'
import type { PageProp } from '../../registry.ts'
import { navigate, useQuery } from '../../route.tsx'
import { useOperator } from '../../session.tsx'
import type { VenueOverview, VenueTabCode } from './court-type.ts'
import { CourtTab } from './venue-court.tsx'
import { HourTab } from './venue-hour.tsx'
import { PolicyTab } from './venue-policy.tsx'
import { ScheduleTab } from './venue-schedule.tsx'
import { SiteTab } from './venue-site.tsx'
import { SportTab } from './venue-sport.tsx'
import './court.css'

const TAB: { value: VenueTabCode; label: string }[] = [
  { value: 'venue', label: 'Venue' },
  { value: 'court', label: 'Courts' },
  { value: 'hour', label: 'Hours & closures' },
  { value: 'schedule', label: 'Schedule & pricing' },
  { value: 'sport', label: 'Sports' },
  { value: 'policy', label: 'Booking policy' },
]

export default function Page(_prop: PageProp) {
  const { can } = useOperator()
  const query = useQuery()
  const requested = query.get('tab')
  const [tab, setTab] = useState<VenueTabCode>(TAB.find((one) => one.value === requested)?.value ?? 'venue')
  const overview = useResource(() => operatorFetch<VenueOverview>('/api/v1/court/venue'), [])
  const is_manager = can('court.manage')

  const go = (next: VenueTabCode) => {
    setTab(next)
    window.history.replaceState(null, '', `/operator/venue?tab=${next}`)
  }
  const prop = { is_manager, onChange: overview.reload, onGo: go }

  return (
    <>
      <PageHeader
        eyebrow={overview.data?.site?.display_name ?? 'Venue'}
        title="Venue setup"
        description="Your venue, its courts, when they are open, and what each slot costs. Changes reach the booking site straight away."
        action={
          <Button tone="secondary" onClick={() => navigate('/operator/board')}>
            Open court board
          </Button>
        }
      />
      {!is_manager && (
        <div className="court-page-alert">
          <Alert severity="info" title="View only">
            You can see the venue setup. Changing it needs the court.manage permission.
          </Alert>
        </div>
      )}
      <ResourceView resource={overview}>{(data) => <Checklist overview={data} onGo={go} />}</ResourceView>
      <Tabs label="Venue setup sections" value={tab} option={TAB} onChange={go} />
      {tab === 'venue' && <SiteTab {...prop} />}
      {tab === 'court' && <CourtTab {...prop} />}
      {tab === 'hour' && <HourTab {...prop} />}
      {tab === 'schedule' && <ScheduleTab {...prop} />}
      {tab === 'sport' && <SportTab {...prop} />}
      {tab === 'policy' && <PolicyTab {...prop} />}
    </>
  )
}

function Checklist({ overview, onGo }: { overview: VenueOverview; onGo: (tab: VenueTabCode) => void }) {
  const step: { label: string; is_done: boolean; tab: VenueTabCode }[] = [
    { label: 'Name the venue and set its time zone', is_done: overview.checklist.has_site, tab: 'venue' },
    { label: 'Add the sports you offer', is_done: overview.checklist.has_sport, tab: 'sport' },
    { label: 'Add your courts', is_done: overview.checklist.has_court, tab: 'court' },
    { label: 'Set weekly opening hours', is_done: overview.checklist.has_operating_hour, tab: 'hour' },
    { label: 'Create a schedule with slot length and prices', is_done: overview.checklist.has_schedule, tab: 'schedule' },
  ]
  if (step.every((one) => one.is_done)) return null
  const next = step.find((one) => !one.is_done)!
  return (
    <div className="court-page-alert">
      <Card
        title="Get your venue ready to take bookings"
        description={`${step.filter((one) => one.is_done).length} of ${step.length} done. Players can book once every step is complete.`}
        action={<Button onClick={() => onGo(next.tab)}>Continue: {next.label.toLowerCase()}</Button>}
      >
        <ol className="court-checklist">
          {step.map((one) => (
            <li key={one.label} className={`court-checklist__item${one.is_done ? ' is-done' : ''}`}>
              <span className="court-checklist__label">{one.label}</span>
              <Badge tone={one.is_done ? 'success' : 'neutral'}>{one.is_done ? 'Done' : 'To do'}</Badge>
              <Button tone="quiet" size="sm" onClick={() => onGo(one.tab)}>
                Open
              </Button>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  )
}
