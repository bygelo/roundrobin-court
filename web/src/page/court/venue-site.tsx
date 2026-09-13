import { useState, type FormEvent } from 'react'
import { jsonBody, operatorFetch } from '../../api.ts'
import { Alert, Button, Card, ErrorAlert, ResourceView, SelectInput, TextInput } from '../../component/ui.tsx'
import { useAction, useResource } from '../../hook.ts'
import { TIME_ZONE_OPTION } from './court-time.ts'
import type { RegenerateResult, Site, TabProp, VenueOverview } from './court-type.ts'

export function SiteTab(prop: TabProp) {
  const resource = useResource(() => operatorFetch<VenueOverview>('/api/v1/court/venue'), [])
  return (
    <ResourceView resource={resource}>
      {(data) => <SiteForm key={data.site?.site_id ?? 'new'} site={data.site} {...prop} onChange={() => { resource.reload(); prop.onChange() }} />}
    </ResourceView>
  )
}

function SiteForm({ site, is_manager, onChange, onGo }: TabProp & { site: Site | null }) {
  const [draft, setDraft] = useState({
    display_name: site?.display_name ?? '',
    time_zone: site?.time_zone ?? 'Asia/Manila',
    address_line: site?.address_line ?? '',
    contact_phone_number: site?.contact_phone_number ?? '',
    contact_email_address: site?.contact_email_address ?? '',
  })
  const [notice, setNotice] = useState<string>()
  const save = useAction(() => operatorFetch<{ site: Site; result?: RegenerateResult }>('/api/v1/court/venue', jsonBody(draft, 'PUT')))
  const set = (key: keyof typeof draft) => (event: { target: { value: string } }) => setDraft({ ...draft, [key]: event.target.value })

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setNotice(undefined)
    const answer = await save.run()
    if (!answer) return
    setNotice(
      answer.result
        ? `Venue details saved. Unbooked future slots were rebuilt in ${answer.site.time_zone} time.`
        : site
          ? 'Venue details saved.'
          : 'Venue created. Next, add the sports you offer.',
    )
    onChange()
  }

  const zone = TIME_ZONE_OPTION.includes(draft.time_zone) ? TIME_ZONE_OPTION : [draft.time_zone, ...TIME_ZONE_OPTION]

  return (
    <Card title="Venue details" description="Players see these on your booking site.">
      <form className="form" onSubmit={submit}>
        {notice && (
          <Alert severity="success" title={notice} onDismiss={() => setNotice(undefined)}>
            {!site && (
              <Button tone="secondary" size="sm" onClick={() => onGo('sport')}>
                Add sports
              </Button>
            )}
          </Alert>
        )}
        <ErrorAlert error={save.error} onDismiss={save.clearError} />
        <fieldset className="court-fieldset form" disabled={!is_manager}>
          <div className="form__row">
            <TextInput label="Venue name" required maxLength={120} value={draft.display_name} onChange={set('display_name')} placeholder="Sideout Pickleball Club" />
            <SelectInput
              label="Time zone"
              hint="Opening hours, slots, and the board all use this clock."
              value={draft.time_zone}
              onChange={set('time_zone')}
              option={zone.map((one) => ({ value: one, label: one.replace('_', ' ') }))}
            />
          </div>
          <TextInput label="Address" maxLength={240} value={draft.address_line} onChange={set('address_line')} placeholder="Katipunan Ave, Quezon City" />
          <div className="form__row">
            <TextInput label="Contact phone" type="tel" maxLength={40} value={draft.contact_phone_number} onChange={set('contact_phone_number')} />
            <TextInput label="Contact email" type="email" maxLength={160} value={draft.contact_email_address} onChange={set('contact_email_address')} />
          </div>
          {is_manager && (
            <div className="form__action">
              <Button type="submit" disabled={save.is_pending}>
                {save.is_pending ? 'Saving…' : site ? 'Save venue details' : 'Create venue'}
              </Button>
            </div>
          )}
        </fieldset>
      </form>
    </Card>
  )
}
