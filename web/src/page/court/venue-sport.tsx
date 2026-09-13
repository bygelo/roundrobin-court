import { useState, type FormEvent } from 'react'
import { jsonBody, operatorFetch } from '../../api.ts'
import { Alert, Badge, Button, Card, Dialog, EmptyState, ErrorAlert, ResourceView, SelectInput, TextInput } from '../../component/ui.tsx'
import { useAction, useResource } from '../../hook.ts'
import type { Sport, SportCatalog, TabProp } from './court-type.ts'

export function SportTab({ is_manager, onChange }: TabProp) {
  const resource = useResource(() => operatorFetch<SportCatalog>('/api/v1/court/sport'), [])
  const [notice, setNotice] = useState<string>()
  const [editing, setEditing] = useState<Sport>()
  const [removing, setRemoving] = useState<Sport>()
  const done = (message: string) => {
    setNotice(message)
    setEditing(undefined)
    setRemoving(undefined)
    resource.reload()
    onChange()
  }

  return (
    <ResourceView resource={resource}>
      {(catalog) => {
        const ruleLabel = (code: string) => catalog.scoring_rule.find((one) => one.scoring_rule_code === code)?.display_name ?? code
        const providerLabel = (code: string | null) => catalog.rating_provider.find((one) => one.rating_provider_code === code)?.display_name
        return (
          <div className="stack">
            {notice && <Alert severity="success" title={notice} onDismiss={() => setNotice(undefined)} />}
            <Card title="Sports" description="Each sport sets its team size, how a match is scored, its default session length, and which rating it reports to.">
              {catalog.sport.length === 0 ? (
                <EmptyState title="No sports yet" description="Add the sports your courts are for — pickleball is a good place to start." />
              ) : (
                <div className="table-wrap" tabIndex={0}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Sport</th>
                        <th scope="col">Scoring</th>
                        <th scope="col" className="number">Players per side</th>
                        <th scope="col">Rating</th>
                        <th scope="col" className="number">Default session</th>
                        <th scope="col" className="number">Courts</th>
                        <th scope="col">
                          <span className="visually-hidden">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {catalog.sport.map((one) => (
                        <tr key={one.sport_profile_id}>
                          <td>
                            <strong>{one.display_name}</strong>
                          </td>
                          <td>{ruleLabel(one.scoring_rule_code)}</td>
                          <td className="number">{one.team_size_count}</td>
                          <td>{one.rating_provider_code ? <Badge tone="info">{providerLabel(one.rating_provider_code)}</Badge> : <Badge>No rating provider</Badge>}</td>
                          <td className="number">{one.session_minute_count} min</td>
                          <td className="number">{one.court_count}</td>
                          <td>
                            {is_manager && (
                              <div className="court-row-action">
                                <Button tone="quiet" size="sm" onClick={() => setEditing(one)}>
                                  Edit
                                </Button>
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
            </Card>
            {is_manager && (
              <Card title="Add a sport">
                <SportForm catalog={catalog} onDone={(sport) => done(`${sport.display_name} added. You can now add courts for it.`)} />
              </Card>
            )}
            {editing && (
              <Dialog open title={`Edit ${editing.display_name}`} onClose={() => setEditing(undefined)}>
                <SportForm catalog={catalog} sport={editing} onCancel={() => setEditing(undefined)} onDone={(sport) => done(`${sport.display_name} saved.`)} />
              </Dialog>
            )}
            {removing && <RemoveSport sport={removing} onClose={() => setRemoving(undefined)} onDone={done} />}
          </div>
        )
      }}
    </ResourceView>
  )
}

function SportForm({ catalog, sport, onDone, onCancel }: { catalog: SportCatalog; sport?: Sport; onDone: (sport: Sport) => void; onCancel?: () => void }) {
  const blank = {
    display_name: '',
    team_size_count: '2',
    scoring_rule_code: catalog.scoring_rule[0]?.scoring_rule_code ?? '',
    rating_provider_code: '',
    session_minute_count: '60',
  }
  const [draft, setDraft] = useState(
    sport
      ? {
          display_name: sport.display_name,
          team_size_count: String(sport.team_size_count),
          scoring_rule_code: sport.scoring_rule_code,
          rating_provider_code: sport.rating_provider_code ?? '',
          session_minute_count: String(sport.session_minute_count),
        }
      : blank,
  )
  const save = useAction(() => {
    const body = {
      display_name: draft.display_name,
      team_size_count: Number(draft.team_size_count),
      scoring_rule_code: draft.scoring_rule_code,
      rating_provider_code: draft.rating_provider_code || null,
      session_minute_count: Number(draft.session_minute_count),
    }
    return sport
      ? operatorFetch<{ sport: Sport }>(`/api/v1/court/sport/${sport.sport_profile_id}`, jsonBody(body, 'PATCH'))
      : operatorFetch<{ sport: Sport }>('/api/v1/court/sport', jsonBody(body))
  })
  const set = (key: keyof typeof draft) => (event: { target: { value: string } }) => setDraft({ ...draft, [key]: event.target.value })
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const answer = await save.run()
    if (!answer) return
    if (!sport) setDraft(blank)
    onDone(answer.sport)
  }
  return (
    <form className="form" onSubmit={submit}>
      <ErrorAlert error={save.error} onDismiss={save.clearError} />
      <div className="form__row">
        <TextInput label="Sport name" required maxLength={60} placeholder="Pickleball" value={draft.display_name} onChange={set('display_name')} />
        <TextInput label="Players per side" type="number" min={1} max={12} required value={draft.team_size_count} onChange={set('team_size_count')} />
      </div>
      <div className="form__row">
        <SelectInput
          label="Scoring rule"
          value={draft.scoring_rule_code}
          onChange={set('scoring_rule_code')}
          option={catalog.scoring_rule.map((one) => ({ value: one.scoring_rule_code, label: one.display_name }))}
        />
        <SelectInput
          label="Rating provider"
          value={draft.rating_provider_code}
          onChange={set('rating_provider_code')}
          option={[{ value: '', label: 'No rating provider' }, ...catalog.rating_provider.map((one) => ({ value: one.rating_provider_code, label: one.display_name }))]}
        />
        <SelectInput
          label="Default session"
          value={draft.session_minute_count}
          onChange={set('session_minute_count')}
          option={[
            { value: '60', label: '60 minutes' },
            { value: '90', label: '90 minutes' },
            { value: '120', label: '2 hours' },
          ]}
        />
      </div>
      <div className="form__action">
        <Button type="submit" disabled={save.is_pending}>
          {save.is_pending ? 'Saving…' : sport ? 'Save sport' : 'Add sport'}
        </Button>
        {onCancel && (
          <Button tone="secondary" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  )
}

function RemoveSport({ sport, onClose, onDone }: { sport: Sport; onClose: () => void; onDone: (message: string) => void }) {
  const remove = useAction(() => operatorFetch(`/api/v1/court/sport/${sport.sport_profile_id}`, { method: 'DELETE' }))
  return (
    <Dialog
      open
      title={`Remove ${sport.display_name}?`}
      onClose={onClose}
      footer={
        <>
          <Button tone="secondary" onClick={onClose}>
            Keep sport
          </Button>
          <Button
            tone="danger"
            disabled={remove.is_pending}
            onClick={async () => {
              const answer = await remove.run()
              if (answer) onDone(`${sport.display_name} removed.`)
            }}
          >
            Remove sport
          </Button>
        </>
      }
    >
      <ErrorAlert error={remove.error} onDismiss={remove.clearError} />
      <p>{sport.court_count > 0 ? `${sport.display_name} still has ${sport.court_count} court${sport.court_count === 1 ? '' : 's'}; move or retire them first.` : `${sport.display_name} and its schedule will be removed.`}</p>
    </Dialog>
  )
}
