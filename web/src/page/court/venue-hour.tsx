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
  ResourceView,
  SelectInput,
  TextInput,
} from '../../component/ui.tsx'
import { formatDateTime, formatTime, toDateInput } from '../../format.ts'
import { useAction, useResource } from '../../hook.ts'
import { WEEKDAY, addDay } from './court-time.ts'
import type { Closure, Court, OperatingHour, RegenerateResult, TabProp, VenueOverview } from './court-type.ts'

type Data = { operating_hour: OperatingHour[]; closure: Closure[]; court: Court[]; overview: VenueOverview }

export function HourTab({ is_manager, onChange, onGo }: TabProp) {
  const resource = useResource(async (): Promise<Data> => {
    const [hour, closure, court, overview] = await Promise.all([
      operatorFetch<{ operating_hour: OperatingHour[] }>('/api/v1/court/operating-hour'),
      operatorFetch<{ closure: Closure[] }>('/api/v1/court/closure'),
      operatorFetch<{ court: Court[] }>('/api/v1/court/court'),
      operatorFetch<VenueOverview>('/api/v1/court/venue'),
    ])
    return { operating_hour: hour.operating_hour, closure: closure.closure, court: court.court, overview }
  }, [])
  const [notice, setNotice] = useState<string>()
  const done = (message: string) => {
    setNotice(message)
    resource.reload()
    onChange()
  }

  return (
    <ResourceView resource={resource}>
      {(data) =>
        !data.overview.site ? (
          <EmptyState
            title="Name the venue first"
            description="Opening hours use the venue's time zone."
            action={<Button onClick={() => onGo('venue')}>Set up venue details</Button>}
          />
        ) : (
          <div className="stack">
            {notice && <Alert severity="success" title={notice} onDismiss={() => setNotice(undefined)} />}
            <HourForm key={JSON.stringify(data.operating_hour)} hour={data.operating_hour} is_manager={is_manager} has_schedule={data.overview.schedule_count > 0} onDone={done} />
            <ClosureList closure={data.closure} time_zone={data.overview.site.time_zone} is_manager={is_manager} onDone={done} />
            {is_manager && <AddClosure court={data.court} time_zone={data.overview.site.time_zone} onDone={done} />}
          </div>
        )
      }
    </ResourceView>
  )
}

type DayDraft = { weekday_number: number; is_open: boolean; opens_local: string; closes_local: string }

function HourForm({ hour, is_manager, has_schedule, onDone }: { hour: OperatingHour[]; is_manager: boolean; has_schedule: boolean; onDone: (message: string) => void }) {
  const [day, setDay] = useState<DayDraft[]>(() =>
    WEEKDAY.map((one) => {
      const found = hour.find((each) => each.weekday_number === one.weekday_number)
      return {
        weekday_number: one.weekday_number,
        is_open: hour.length === 0 || Boolean(found),
        opens_local: found?.opens_local ?? '06:00',
        closes_local: found?.closes_local ?? '23:00',
      }
    }),
  )
  const save = useAction(() =>
    operatorFetch<{ operating_hour: OperatingHour[]; result: RegenerateResult }>(
      '/api/v1/court/operating-hour',
      jsonBody(
        {
          operating_hour: day
            .filter((one) => one.is_open)
            .map(({ weekday_number, opens_local, closes_local }) => ({ weekday_number, opens_local, closes_local })),
        },
        'PUT',
      ),
    ),
  )
  const update = (index: number, patch: Partial<DayDraft>) => setDay(day.map((one, each) => (each === index ? { ...one, ...patch } : one)))
  const copyMonday = () => setDay(day.map((one) => ({ ...one, is_open: day[0]!.is_open, opens_local: day[0]!.opens_local, closes_local: day[0]!.closes_local })))

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const answer = await save.run()
    if (!answer) return
    onDone(
      has_schedule
        ? `Opening hours saved. The schedule now sells ${answer.result.template_count} slots a week.`
        : 'Opening hours saved. Next, create a schedule so these hours sell slots.',
    )
  }

  return (
    <Card
      title="Weekly opening hours"
      description="Slots are only sold inside these hours. Saving rebuilds unbooked future slots; existing bookings are never moved."
      action={
        is_manager && (
          <Button tone="quiet" size="sm" onClick={copyMonday}>
            Copy Monday to every day
          </Button>
        )
      }
    >
      <form className="form" onSubmit={submit}>
        <ErrorAlert error={save.error} onDismiss={save.clearError} />
        <fieldset className="court-fieldset court-hour" disabled={!is_manager}>
          <legend className="visually-hidden">Opening hours by weekday</legend>
          {day.map((one, index) => {
            const label = WEEKDAY[index]!.label
            return (
              <div key={one.weekday_number} className="court-hour__row">
                <div className="court-hour__day">
                  <Checkbox label={label} checked={one.is_open} onChange={(event) => update(index, { is_open: event.target.checked })} />
                </div>
                {one.is_open ? (
                  <>
                    <TextInput label={`${label} opens`} type="time" required value={one.opens_local} onChange={(event) => update(index, { opens_local: event.target.value })} />
                    <TextInput
                      label={`${label} closes`}
                      type="time"
                      required
                      hint="Use 00:00 for midnight"
                      value={one.closes_local === '24:00' ? '00:00' : one.closes_local}
                      onChange={(event) => update(index, { closes_local: event.target.value === '00:00' ? '24:00' : event.target.value })}
                    />
                  </>
                ) : (
                  <span className="muted">Closed all day</span>
                )}
              </div>
            )
          })}
        </fieldset>
        {is_manager && (
          <div className="form__action">
            <Button type="submit" disabled={save.is_pending}>
              {save.is_pending ? 'Saving and rebuilding slots…' : 'Save opening hours'}
            </Button>
          </div>
        )}
      </form>
    </Card>
  )
}

function ClosureList({ closure, time_zone, is_manager, onDone }: { closure: Closure[]; time_zone: string; is_manager: boolean; onDone: (message: string) => void }) {
  const [removing, setRemoving] = useState<Closure>()
  const remove = useAction((one: Closure) => operatorFetch(`/api/v1/court/closure/${one.closure_id}`, { method: 'DELETE' }))
  const confirm = async () => {
    if (!removing) return
    const answer = await remove.run(removing)
    if (answer) {
      setRemoving(undefined)
      onDone('Closure removed. Those slots are on sale again.')
    }
  }
  return (
    <Card title="Upcoming closures" description="Holidays, typhoons, and maintenance. Only slots inside a closure stop selling.">
      {closure.length === 0 ? (
        <EmptyState title="No closures planned" description="The venue is open every scheduled hour." />
      ) : (
        <div className="table-wrap" tabIndex={0}>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Where</th>
                <th scope="col">Reason</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {closure.map((one) => (
                <tr key={one.closure_id}>
                  <td>
                    {formatDateTime(one.starts_at, time_zone)} – {formatTime(one.ends_at, time_zone)}
                  </td>
                  <td>{one.is_site_wide ? <Badge tone="caution">Whole venue</Badge> : <Badge>{one.court_display_name ?? 'Court'}</Badge>}</td>
                  <td>{one.reason}</td>
                  <td>
                    {is_manager && (
                      <div className="court-row-action">
                        <Button tone="danger" size="sm" onClick={() => setRemoving(one)}>
                          Remove
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {removing && (
        <Dialog
          open
          title="Remove this closure?"
          onClose={() => setRemoving(undefined)}
          footer={
            <>
              <Button tone="secondary" onClick={() => setRemoving(undefined)}>
                Keep closure
              </Button>
              <Button tone="danger" onClick={confirm} disabled={remove.is_pending}>
                Remove closure
              </Button>
            </>
          }
        >
          <ErrorAlert error={remove.error} onDismiss={remove.clearError} />
          <p>
            “{removing.reason}” on {formatDateTime(removing.starts_at, time_zone)} will be lifted and its slots go back on sale.
          </p>
        </Dialog>
      )}
    </Card>
  )
}

function AddClosure({ court, time_zone, onDone }: { court: Court[]; time_zone: string; onDone: (message: string) => void }) {
  const tomorrow = addDay(toDateInput(new Date(), time_zone), 1)
  const [draft, setDraft] = useState({ date: tomorrow, end_date: '', is_all_day: true, starts_local: '06:00', ends_local: '12:00', resource_id: '', reason: '' })
  const add = useAction(() =>
    operatorFetch<{ closure: Closure }>(
      '/api/v1/court/closure',
      jsonBody({
        date: draft.date,
        end_date: draft.end_date || undefined,
        starts_local: draft.is_all_day ? undefined : draft.starts_local,
        ends_local: draft.is_all_day ? undefined : draft.ends_local,
        resource_id: draft.resource_id || null,
        reason: draft.reason,
      }),
    ),
  )
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const answer = await add.run()
    if (!answer) return
    onDone(`Closure added for ${answer.closure.court_display_name ?? 'the whole venue'}. Slots inside it are no longer sold.`)
    setDraft({ ...draft, reason: '' })
  }
  return (
    <Card title="Add a closure">
      <form className="form" onSubmit={submit}>
        <ErrorAlert error={add.error} onDismiss={add.clearError} />
        <div className="form__row">
          <TextInput label="First day" type="date" required value={draft.date} onChange={(event) => setDraft({ ...draft, date: event.target.value })} />
          <TextInput label="Last day" hint="Leave empty for a single day" type="date" min={draft.date} value={draft.end_date} onChange={(event) => setDraft({ ...draft, end_date: event.target.value })} />
          <SelectInput
            label="Where"
            value={draft.resource_id}
            option={[{ value: '', label: 'Whole venue' }, ...court.map((one) => ({ value: one.resource_id, label: one.display_name }))]}
            onChange={(event) => setDraft({ ...draft, resource_id: event.target.value })}
          />
        </div>
        <Checkbox label="All day" checked={draft.is_all_day} onChange={(event) => setDraft({ ...draft, is_all_day: event.target.checked })} />
        {!draft.is_all_day && (
          <div className="form__row">
            <TextInput label="From" type="time" required value={draft.starts_local} onChange={(event) => setDraft({ ...draft, starts_local: event.target.value })} />
            <TextInput label="Until" type="time" required value={draft.ends_local} onChange={(event) => setDraft({ ...draft, ends_local: event.target.value })} />
          </div>
        )}
        <TextInput label="Reason" required maxLength={160} placeholder="Typhoon signal no. 2" value={draft.reason} onChange={(event) => setDraft({ ...draft, reason: event.target.value })} />
        <div className="form__action">
          <Button type="submit" disabled={add.is_pending}>
            {add.is_pending ? 'Adding…' : 'Add closure'}
          </Button>
        </div>
      </form>
    </Card>
  )
}
