import { useState, type FormEvent } from 'react'
import { jsonBody, operatorFetch } from '../../api.ts'
import { Alert, Button, Card, Checkbox, ErrorAlert, ResourceView, TextInput } from '../../component/ui.tsx'
import { useAction, useResource } from '../../hook.ts'
import type { BookingPolicy, TabProp } from './court-type.ts'

export function PolicyTab(prop: TabProp) {
  const resource = useResource(() => operatorFetch<{ policy: BookingPolicy }>('/api/v1/court/policy'), [])
  return <ResourceView resource={resource}>{(data) => <PolicyForm policy={data.policy} {...prop} />}</ResourceView>
}

function PolicyForm({ policy, is_manager }: TabProp & { policy: BookingPolicy }) {
  const [draft, setDraft] = useState({
    advance_window_day_count: String(policy.advance_window_day_count),
    cancellation_cutoff_hour_count: String(policy.cancellation_cutoff_hour_count),
    hold_minute_count: String(policy.hold_minute_count),
    is_guest_booking_allowed: policy.is_guest_booking_allowed,
  })
  const [notice, setNotice] = useState<string>()
  const save = useAction(() =>
    operatorFetch<{ policy: BookingPolicy }>(
      '/api/v1/court/policy',
      jsonBody(
        {
          advance_window_day_count: Number(draft.advance_window_day_count),
          cancellation_cutoff_hour_count: Number(draft.cancellation_cutoff_hour_count),
          hold_minute_count: Number(draft.hold_minute_count),
          is_guest_booking_allowed: draft.is_guest_booking_allowed,
        },
        'PUT',
      ),
    ),
  )
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setNotice(undefined)
    const answer = await save.run()
    if (answer) setNotice('Booking policy saved. Players see the new rules on their next visit.')
  }
  const set = (key: 'advance_window_day_count' | 'cancellation_cutoff_hour_count' | 'hold_minute_count') => (event: { target: { value: string } }) =>
    setDraft({ ...draft, [key]: event.target.value })

  return (
    <Card title="Booking policy" description="The rules players book under on your booking site.">
      <form className="form" onSubmit={submit}>
        {notice && <Alert severity="success" title={notice} onDismiss={() => setNotice(undefined)} />}
        <ErrorAlert error={save.error} onDismiss={save.clearError} />
        <fieldset className="court-fieldset form" disabled={!is_manager}>
          <div className="form__row">
            <TextInput
              label="Advance booking window (days)"
              hint="How far ahead a player may book."
              type="number"
              min={1}
              max={365}
              required
              value={draft.advance_window_day_count}
              onChange={set('advance_window_day_count')}
            />
            <TextInput
              label="Free cancellation until (hours before)"
              hint="After this, a cancellation is late."
              type="number"
              min={0}
              max={720}
              required
              value={draft.cancellation_cutoff_hour_count}
              onChange={set('cancellation_cutoff_hour_count')}
            />
            <TextInput
              label="Unpaid hold (minutes)"
              hint="How long a slot waits for payment before it is released."
              type="number"
              min={1}
              max={120}
              required
              value={draft.hold_minute_count}
              onChange={set('hold_minute_count')}
            />
          </div>
          <Checkbox
            label="Guests can book without an account"
            checked={draft.is_guest_booking_allowed}
            onChange={(event) => setDraft({ ...draft, is_guest_booking_allowed: event.target.checked })}
          />
          {is_manager && (
            <div className="form__action">
              <Button type="submit" disabled={save.is_pending}>
                {save.is_pending ? 'Saving…' : 'Save booking policy'}
              </Button>
            </div>
          )}
        </fieldset>
      </form>
    </Card>
  )
}
