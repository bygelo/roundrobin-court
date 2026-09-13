import { ArrowDown, ArrowUp, Plus } from '@phosphor-icons/react'
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
import { useAction, useResource } from '../../hook.ts'
import type { Court, SportCatalog, TabProp } from './court-type.ts'

type Data = { court: Court[]; sport: SportCatalog['sport'] }

export function CourtTab({ is_manager, onChange, onGo }: TabProp) {
  const [is_retired_included, setRetiredIncluded] = useState(false)
  const resource = useResource(async (): Promise<Data> => {
    const [court, sport] = await Promise.all([
      operatorFetch<{ court: Court[] }>(`/api/v1/court/court?is_retired_included=${is_retired_included}`),
      operatorFetch<SportCatalog>('/api/v1/court/sport'),
    ])
    return { court: court.court, sport: sport.sport }
  }, [is_retired_included])
  const [notice, setNotice] = useState<string>()
  const [editing, setEditing] = useState<Court>()
  const [retiring, setRetiring] = useState<Court>()

  const reorder = useAction((order: string[]) => operatorFetch<{ court: Court[] }>('/api/v1/court/court/order', jsonBody({ resource_id: order })))

  const refresh = (message: string) => {
    setNotice(message)
    resource.reload()
    onChange()
  }

  return (
    <ResourceView resource={resource}>
      {(data) => {
        const active = data.court.filter((one) => !one.is_retired)
        const move = async (index: number, direction: -1 | 1) => {
          const order = active.map((one) => one.resource_id)
          const target = index + direction
          if (target < 0 || target >= order.length) return
          ;[order[index], order[target]] = [order[target]!, order[index]!]
          const answer = await reorder.run(order)
          if (answer) refresh(`${active[index]!.display_name} moved ${direction < 0 ? 'up' : 'down'}. Court order saved.`)
        }

        return (
          <div className="stack">
            {notice && <Alert severity="success" title={notice} onDismiss={() => setNotice(undefined)} />}
            <ErrorAlert error={reorder.error} onDismiss={reorder.clearError} />
            {data.sport.length === 0 ? (
              <EmptyState
                title="Add a sport first"
                description="Every court is set up for a sport, so the booking site can show players the right courts."
                action={<Button onClick={() => onGo('sport')}>Add a sport</Button>}
              />
            ) : (
              <>
                <Card
                  title="Courts"
                  description="The order here is the order on the court board and the booking site."
                  action={<Checkbox label="Show retired courts" checked={is_retired_included} onChange={(event) => setRetiredIncluded(event.target.checked)} />}
                >
                  {data.court.length === 0 ? (
                    <EmptyState title="No courts yet" description="Add your first court below. Most venues start with Court 1." />
                  ) : (
                    <div className="table-wrap">
                      <table className="table">
                        <thead>
                          <tr>
                            <th scope="col">Order</th>
                            <th scope="col">Court</th>
                            <th scope="col">Sport</th>
                            <th scope="col" className="number">Players</th>
                            <th scope="col" className="number">Upcoming bookings</th>
                            <th scope="col">
                              <span className="visually-hidden">Actions</span>
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.court.map((one) => {
                            const index = active.findIndex((each) => each.resource_id === one.resource_id)
                            return (
                              <tr key={one.resource_id}>
                                <td>
                                  {one.is_retired ? (
                                    <Badge>Retired</Badge>
                                  ) : (
                                    <span className="court-order">
                                      <button
                                        type="button"
                                        className="court-icon-button"
                                        aria-label={`Move ${one.display_name} up`}
                                        disabled={!is_manager || index === 0 || reorder.is_pending}
                                        onClick={() => move(index, -1)}
                                      >
                                        <ArrowUp size={16} aria-hidden />
                                      </button>
                                      <button
                                        type="button"
                                        className="court-icon-button"
                                        aria-label={`Move ${one.display_name} down`}
                                        disabled={!is_manager || index === active.length - 1 || reorder.is_pending}
                                        onClick={() => move(index, 1)}
                                      >
                                        <ArrowDown size={16} aria-hidden />
                                      </button>
                                    </span>
                                  )}
                                </td>
                                <td>
                                  <strong>{one.display_name}</strong>
                                </td>
                                <td>{one.sport_display_name ? <Badge tone="info">{one.sport_display_name}</Badge> : <span className="muted">No sport</span>}</td>
                                <td className="number">{one.capacity_count ?? '—'}</td>
                                <td className="number">{one.is_retired ? '—' : one.upcoming_booking_count}</td>
                                <td>
                                  {is_manager && !one.is_retired && (
                                    <div className="court-row-action">
                                      <Button tone="quiet" size="sm" onClick={() => setEditing(one)}>
                                        Edit
                                      </Button>
                                      <Button tone="danger" size="sm" onClick={() => setRetiring(one)}>
                                        Retire
                                      </Button>
                                    </div>
                                  )}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Card>
                {is_manager && <AddCourt sport={data.sport} court_count={active.length} onDone={refresh} />}
              </>
            )}
            {editing && <EditCourt court={editing} sport={data.sport} onClose={() => setEditing(undefined)} onDone={(message) => { setEditing(undefined); refresh(message) }} />}
            {retiring && <RetireCourt court={retiring} onClose={() => setRetiring(undefined)} onDone={(message) => { setRetiring(undefined); refresh(message) }} />}
          </div>
        )
      }}
    </ResourceView>
  )
}

function sportOption(sport: SportCatalog['sport']) {
  return sport.map((one) => ({ value: one.sport_profile_code, label: one.display_name }))
}

function AddCourt({ sport, court_count, onDone }: { sport: SportCatalog['sport']; court_count: number; onDone: (message: string) => void }) {
  const [draft, setDraft] = useState({ display_name: `Court ${court_count + 1}`, sport_code: sport[0]?.sport_profile_code ?? '', capacity_count: '4' })
  const add = useAction(() =>
    operatorFetch<{ court: Court }>('/api/v1/court/court', jsonBody({ ...draft, capacity_count: Number(draft.capacity_count) })),
  )
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const answer = await add.run()
    if (!answer) return
    onDone(`${answer.court.display_name} added. It sells slots as soon as its sport has a schedule.`)
    setDraft({ ...draft, display_name: `Court ${court_count + 2}` })
  }
  return (
    <Card title="Add a court">
      <form className="form" onSubmit={submit}>
        <ErrorAlert error={add.error} onDismiss={add.clearError} />
        <div className="form__row">
          <TextInput label="Court name" required maxLength={60} value={draft.display_name} onChange={(event) => setDraft({ ...draft, display_name: event.target.value })} />
          <SelectInput label="Sport" value={draft.sport_code} option={sportOption(sport)} onChange={(event) => setDraft({ ...draft, sport_code: event.target.value })} />
          <TextInput
            label="Players on court"
            type="number"
            min={1}
            max={40}
            required
            value={draft.capacity_count}
            onChange={(event) => setDraft({ ...draft, capacity_count: event.target.value })}
          />
        </div>
        <div className="form__action">
          <Button type="submit" icon={<Plus size={18} aria-hidden />} disabled={add.is_pending}>
            {add.is_pending ? 'Adding…' : 'Add court'}
          </Button>
        </div>
      </form>
    </Card>
  )
}

function EditCourt({ court, sport, onClose, onDone }: { court: Court; sport: SportCatalog['sport']; onClose: () => void; onDone: (message: string) => void }) {
  const [draft, setDraft] = useState({
    display_name: court.display_name,
    sport_code: court.sport_code ?? sport[0]?.sport_profile_code ?? '',
    capacity_count: String(court.capacity_count ?? 4),
  })
  const save = useAction(() =>
    operatorFetch<{ court: Court }>(
      `/api/v1/court/court/${court.resource_id}`,
      jsonBody({ ...draft, capacity_count: Number(draft.capacity_count) }, 'PATCH'),
    ),
  )
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const answer = await save.run()
    if (answer) onDone(`${answer.court.display_name} saved.`)
  }
  return (
    <Dialog
      open
      title={`Edit ${court.display_name}`}
      onClose={onClose}
      footer={
        <>
          <Button tone="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="court-edit-form" disabled={save.is_pending}>
            {save.is_pending ? 'Saving…' : 'Save court'}
          </Button>
        </>
      }
    >
      <form id="court-edit-form" className="form" onSubmit={submit}>
        <ErrorAlert error={save.error} onDismiss={save.clearError} />
        <TextInput label="Court name" required maxLength={60} autoFocus value={draft.display_name} onChange={(event) => setDraft({ ...draft, display_name: event.target.value })} />
        <SelectInput
          label="Sport"
          hint={court.upcoming_booking_count > 0 ? 'The sport cannot change while the court has upcoming bookings.' : undefined}
          value={draft.sport_code}
          option={sportOption(sport)}
          onChange={(event) => setDraft({ ...draft, sport_code: event.target.value })}
        />
        <TextInput label="Players on court" type="number" min={1} max={40} required value={draft.capacity_count} onChange={(event) => setDraft({ ...draft, capacity_count: event.target.value })} />
      </form>
    </Dialog>
  )
}

function RetireCourt({ court, onClose, onDone }: { court: Court; onClose: () => void; onDone: (message: string) => void }) {
  const retire = useAction(() => operatorFetch<{ court: Court }>(`/api/v1/court/court/${court.resource_id}/retire`, jsonBody({})))
  const confirm = async () => {
    const answer = await retire.run()
    if (answer) onDone(`${court.display_name} retired. It no longer appears on the board or the booking site.`)
  }
  return (
    <Dialog
      open
      title={`Retire ${court.display_name}?`}
      onClose={onClose}
      footer={
        <>
          <Button tone="secondary" onClick={onClose}>
            Keep court
          </Button>
          <Button tone="danger" onClick={confirm} disabled={retire.is_pending}>
            {retire.is_pending ? 'Retiring…' : 'Retire court'}
          </Button>
        </>
      }
    >
      <ErrorAlert error={retire.error} onDismiss={retire.clearError} />
      <p>
        {court.display_name} stops selling slots and leaves the court board and the booking site. Past bookings stay in your records.
      </p>
      {court.upcoming_booking_count > 0 && (
        <Alert severity="caution" title={`${court.upcoming_booking_count} upcoming booking${court.upcoming_booking_count === 1 ? '' : 's'}`}>
          Move or cancel them on the court board first — a court with upcoming bookings cannot be retired.
        </Alert>
      )}
    </Dialog>
  )
}
