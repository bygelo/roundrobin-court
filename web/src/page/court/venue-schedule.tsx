import { Plus, Trash } from '@phosphor-icons/react'
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
  ResourceView,
  SelectInput,
  Stat,
  TextInput,
} from '../../component/ui.tsx'
import { formatMoney } from '../../format.ts'
import { useAction, useResource } from '../../hook.ts'
import { WEEKDAY, weekdayLabel } from './court-time.ts'
import type { Court, OperatingHour, PeakWindow, RegenerateResult, Schedule, SportCatalog, TabProp } from './court-type.ts'

type Data = { schedule: Schedule[]; sport: SportCatalog['sport']; operating_hour: OperatingHour[]; court: Court[] }

function describeResult(result: RegenerateResult): string {
  const part = [`${result.template_count} slots a week`, `${result.created_session_count} new sessions on sale`]
  if (result.retired_session_count > 0) part.push(`${result.retired_session_count} unbooked old slots removed`)
  if (result.kept_booked_session_count > 0) part.push(`${result.kept_booked_session_count} booked slots kept as they were`)
  return part.join(', ')
}

export function ScheduleTab({ is_manager, onChange, onGo }: TabProp) {
  const resource = useResource(async (): Promise<Data> => {
    const [schedule, sport, hour, court] = await Promise.all([
      operatorFetch<{ schedule: Schedule[] }>('/api/v1/court/schedule'),
      operatorFetch<SportCatalog>('/api/v1/court/sport'),
      operatorFetch<{ operating_hour: OperatingHour[] }>('/api/v1/court/operating-hour'),
      operatorFetch<{ court: Court[] }>('/api/v1/court/court'),
    ])
    return { schedule: schedule.schedule, sport: sport.sport, operating_hour: hour.operating_hour, court: court.court }
  }, [])
  const [notice, setNotice] = useState<string>()
  const [editing, setEditing] = useState<string>()
  const materialize = useAction(() => operatorFetch<{ created_session_count: number }>('/api/v1/court/schedule/materialize', jsonBody({})))

  const done = (message: string) => {
    setNotice(message)
    setEditing(undefined)
    resource.reload()
    onChange()
  }

  return (
    <ResourceView resource={resource}>
      {(data) => {
        const unscheduled = data.sport.filter((one) => !data.schedule.some((each) => each.sport_code === one.sport_profile_code))
        return (
          <div className="stack">
            {notice && <Alert severity="success" title={notice} onDismiss={() => setNotice(undefined)} />}
            <ErrorAlert error={materialize.error} onDismiss={materialize.clearError} />
            {data.operating_hour.length === 0 && (
              <Alert severity="caution" title="No opening hours yet">
                <p>Slots are generated inside opening hours, so a schedule sells nothing until they are set.</p>
                <Button tone="secondary" size="sm" onClick={() => onGo('hour')}>
                  Set opening hours
                </Button>
              </Alert>
            )}
            {data.sport.length === 0 && (
              <EmptyState title="Add a sport first" description="A schedule sells the courts of one sport." action={<Button onClick={() => onGo('sport')}>Add a sport</Button>} />
            )}
            {data.schedule.map((one) =>
              editing === one.court_schedule_id ? (
                <ScheduleForm key={one.court_schedule_id} schedule={one} sport_display_name={one.sport_display_name} onCancel={() => setEditing(undefined)} onDone={done} />
              ) : (
                <ScheduleSummary key={one.court_schedule_id} schedule={one} is_manager={is_manager} onEdit={() => setEditing(one.court_schedule_id)} onDone={done} onGo={onGo} />
              ),
            )}
            {is_manager &&
              unscheduled.map((one) =>
                editing === one.sport_profile_code ? (
                  <ScheduleForm
                    key={one.sport_profile_code}
                    sport_code={one.sport_profile_code}
                    sport_display_name={one.display_name}
                    slot_minute_count={one.session_minute_count}
                    onCancel={() => setEditing(undefined)}
                    onDone={done}
                  />
                ) : (
                  <Card
                    key={one.sport_profile_code}
                    title={`${one.display_name} is not on sale`}
                    description={
                      one.court_count === 0
                        ? `No ${one.display_name} courts yet. You can still prepare its schedule.`
                        : `${one.court_count} court${one.court_count === 1 ? '' : 's'} waiting for a schedule.`
                    }
                    action={
                      <Button icon={<Plus size={18} aria-hidden />} onClick={() => setEditing(one.sport_profile_code)}>
                        Create schedule
                      </Button>
                    }
                  />
                ),
              )}
            {is_manager && data.schedule.length > 0 && (
              <div className="row">
                <Button
                  tone="secondary"
                  disabled={materialize.is_pending}
                  onClick={async () => {
                    const answer = await materialize.run()
                    if (answer)
                      done(
                        answer.created_session_count === 0
                          ? 'Every schedule is already on sale for its full window.'
                          : `${answer.created_session_count} more sessions put on sale.`,
                      )
                  }}
                >
                  {materialize.is_pending ? 'Extending…' : 'Extend sales window to today'}
                </Button>
                <span className="muted">The court board also does this automatically each day it is opened.</span>
              </div>
            )}
          </div>
        )
      }}
    </ResourceView>
  )
}

function ScheduleSummary({
  schedule,
  is_manager,
  onEdit,
  onDone,
  onGo,
}: {
  schedule: Schedule
  is_manager: boolean
  onEdit: () => void
  onDone: (message: string) => void
  onGo: TabProp['onGo']
}) {
  const [is_confirming, setConfirming] = useState(false)
  const remove = useAction(() => operatorFetch<{ result: RegenerateResult }>(`/api/v1/court/schedule/${schedule.court_schedule_id}`, { method: 'DELETE' }))
  return (
    <Card
      title={`${schedule.sport_display_name} · ${schedule.display_name}`}
      description={`Sold ${schedule.horizon_day_count} days ahead · ${schedule.capacity_count} players per slot`}
      action={
        is_manager && (
          <>
            <Button tone="secondary" size="sm" onClick={onEdit}>
              Edit schedule
            </Button>
            <Button tone="danger" size="sm" onClick={() => setConfirming(true)}>
              Stop selling
            </Button>
          </>
        )
      }
    >
      <div className="court-stat-row">
        <Stat label="Slot length" value={`${schedule.slot_minute_count} min`} />
        <Stat label="Off-peak" value={formatMoney(schedule.off_peak_price_amount)} />
        <Stat label="Peak" value={formatMoney(schedule.peak_price_amount)} />
        <Stat label="Slots per week" value={schedule.template_count} hint={`${schedule.court_count} court${schedule.court_count === 1 ? '' : 's'}`} />
        <Stat label="Upcoming sessions" value={schedule.upcoming_session_count} />
      </div>
      {schedule.court_count === 0 && (
        <Alert severity="caution" title="No courts for this sport">
          <Button tone="secondary" size="sm" onClick={() => onGo('court')}>
            Add a court
          </Button>
        </Alert>
      )}
      <p className="field__label">Peak windows</p>
      {schedule.peak.length === 0 ? (
        <p className="muted">No peak windows — every slot sells at the off-peak price.</p>
      ) : (
        <div className="court-chip-list">
          {schedule.peak.map((one) => (
            <Badge key={`${one.weekday_number}.${one.starts_local}`} tone="caution">
              {weekdayLabel(one.weekday_number).slice(0, 3)} {one.starts_local === '00:00' && one.ends_local === '24:00' ? 'all day' : `${one.starts_local}–${one.ends_local}`}
            </Badge>
          ))}
        </div>
      )}
      {is_confirming && (
        <Dialog
          open
          title={`Stop selling ${schedule.sport_display_name}?`}
          onClose={() => setConfirming(false)}
          footer={
            <>
              <Button tone="secondary" onClick={() => setConfirming(false)}>
                Keep selling
              </Button>
              <Button
                tone="danger"
                disabled={remove.is_pending}
                onClick={async () => {
                  const answer = await remove.run()
                  if (answer) {
                    setConfirming(false)
                    onDone(`${schedule.sport_display_name} slots are no longer sold. ${answer.result.kept_booked_session_count} booked slots were kept.`)
                  }
                }}
              >
                Stop selling
              </Button>
            </>
          }
        >
          <ErrorAlert error={remove.error} onDismiss={remove.clearError} />
          <p>Unbooked future slots are removed from the booking site. Existing bookings keep their court, time, and price.</p>
        </Dialog>
      )}
    </Card>
  )
}

const TYPICAL_PEAK: PeakWindow[] = [
  ...[1, 2, 3, 4, 5].map((weekday_number) => ({ weekday_number, starts_local: '17:00', ends_local: '22:00' })),
  ...[6, 7].map((weekday_number) => ({ weekday_number, starts_local: '00:00', ends_local: '24:00' })),
]

function ScheduleForm({
  schedule,
  sport_code,
  sport_display_name,
  slot_minute_count,
  onCancel,
  onDone,
}: {
  schedule?: Schedule
  sport_code?: string
  sport_display_name: string
  slot_minute_count?: number
  onCancel: () => void
  onDone: (message: string) => void
}) {
  const [draft, setDraft] = useState({
    display_name: schedule?.display_name ?? 'Court rental',
    slot_minute_count: String(schedule?.slot_minute_count ?? slot_minute_count ?? 60),
    capacity_count: String(schedule?.capacity_count ?? 4),
    off_peak_price_amount: schedule ? String(Number(schedule.off_peak_price_amount)) : '400',
    peak_price_amount: schedule ? String(Number(schedule.peak_price_amount)) : '600',
    horizon_day_count: String(schedule?.horizon_day_count ?? 14),
  })
  const [peak, setPeak] = useState<PeakWindow[]>(schedule?.peak ?? TYPICAL_PEAK)
  const save = useAction(() => {
    const body = {
      ...(sport_code ? { sport_code } : {}),
      display_name: draft.display_name,
      slot_minute_count: Number(draft.slot_minute_count),
      capacity_count: Number(draft.capacity_count),
      off_peak_price_amount: draft.off_peak_price_amount,
      peak_price_amount: draft.peak_price_amount,
      horizon_day_count: Number(draft.horizon_day_count),
      peak: peak.map((one) => ({ ...one, ends_local: one.ends_local === '00:00' ? '24:00' : one.ends_local })),
    }
    return schedule
      ? operatorFetch<{ schedule: Schedule; result: RegenerateResult }>(`/api/v1/court/schedule/${schedule.court_schedule_id}`, jsonBody(body, 'PATCH'))
      : operatorFetch<{ schedule: Schedule; result: RegenerateResult }>('/api/v1/court/schedule', jsonBody(body))
  })
  const set = (key: keyof typeof draft) => (event: { target: { value: string } }) => setDraft({ ...draft, [key]: event.target.value })
  const updatePeak = (index: number, patch: Partial<PeakWindow>) => setPeak(peak.map((one, each) => (each === index ? { ...one, ...patch } : one)))

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const answer = await save.run()
    if (answer) onDone(`${sport_display_name} schedule saved: ${describeResult(answer.result)}.`)
  }

  return (
    <Card title={schedule ? `Edit ${sport_display_name} schedule` : `New ${sport_display_name} schedule`}>
      <form className="form" onSubmit={submit}>
        <Alert severity="info">Saving rebuilds unbooked future slots from your opening hours. Existing bookings keep their court, time, and price.</Alert>
        <ErrorAlert error={save.error} onDismiss={save.clearError} />
        <div className="form__row">
          <TextInput label="Name on receipts" required maxLength={80} value={draft.display_name} onChange={set('display_name')} />
          <SelectInput
            label="Slot length"
            value={draft.slot_minute_count}
            onChange={set('slot_minute_count')}
            option={[
              { value: '60', label: '60 minutes' },
              { value: '90', label: '90 minutes' },
              { value: '120', label: '2 hours' },
            ]}
          />
          <TextInput label="Players per slot" type="number" min={1} max={40} required value={draft.capacity_count} onChange={set('capacity_count')} />
        </div>
        <div className="form__row">
          <TextInput label="Off-peak price (₱)" inputMode="decimal" required pattern="\d+(\.\d{1,2})?" value={draft.off_peak_price_amount} onChange={set('off_peak_price_amount')} />
          <TextInput label="Peak price (₱)" inputMode="decimal" required pattern="\d+(\.\d{1,2})?" value={draft.peak_price_amount} onChange={set('peak_price_amount')} />
          <TextInput label="Days sold ahead" type="number" min={1} max={90} required value={draft.horizon_day_count} onChange={set('horizon_day_count')} />
        </div>

        <fieldset className="court-fieldset court-peak">
          <legend className="field__label">Peak windows</legend>
          <p className="field__hint">A slot that starts inside a window sells at the peak price. Use 00:00 to 00:00 for all day.</p>
          {peak.length === 0 && <p className="muted">No peak windows — every slot sells at the off-peak price.</p>}
          {peak.map((one, index) => (
            <div key={index} className="court-peak__row">
              <SelectInput
                label="Day"
                value={String(one.weekday_number)}
                onChange={(event) => updatePeak(index, { weekday_number: Number(event.target.value) })}
                option={WEEKDAY.map((day) => ({ value: String(day.weekday_number), label: day.label }))}
              />
              <TextInput label="From" type="time" required value={one.starts_local} onChange={(event) => updatePeak(index, { starts_local: event.target.value })} />
              <TextInput
                label="Until"
                type="time"
                required
                value={one.ends_local === '24:00' ? '00:00' : one.ends_local}
                onChange={(event) => updatePeak(index, { ends_local: event.target.value === '00:00' ? '24:00' : event.target.value })}
              />
              <button type="button" className="court-icon-button" aria-label={`Remove ${weekdayLabel(one.weekday_number)} peak window`} onClick={() => setPeak(peak.filter((_one, each) => each !== index))}>
                <Trash size={16} aria-hidden />
              </button>
            </div>
          ))}
          <div className="row">
            <Button tone="quiet" size="sm" icon={<Plus size={16} aria-hidden />} onClick={() => setPeak([...peak, { weekday_number: 1, starts_local: '17:00', ends_local: '22:00' }])}>
              Add peak window
            </Button>
            <Button tone="quiet" size="sm" onClick={() => setPeak(TYPICAL_PEAK)}>
              Use weekday evenings and weekends
            </Button>
          </div>
        </fieldset>

        <div className="form__action">
          <Button type="submit" disabled={save.is_pending}>
            {save.is_pending ? 'Saving and rebuilding slots…' : schedule ? 'Save schedule' : 'Create schedule'}
          </Button>
          <Button tone="secondary" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  )
}
