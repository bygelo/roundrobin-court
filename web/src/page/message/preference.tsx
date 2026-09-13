// Preferences tab: look a player up and set which optional messages they get.

import { MagnifyingGlass } from '@phosphor-icons/react'
import { useState, type FormEvent } from 'react'
import { ApiError, jsonBody, operatorFetch } from '../../api.ts'
import { Alert, Badge, Button, Card, Checkbox, Dialog, ErrorAlert, TextInput } from '../../component/ui.tsx'
import { useAction } from '../../hook.ts'
import type { PreferenceView } from './type.ts'

export function PreferenceTab({ can_manage }: { can_manage: boolean }) {
  const [contact, setContact] = useState('')
  const [looked_up, setLookedUp] = useState('')
  const [view, setView] = useState<PreferenceView>()
  const [not_found, setNotFound] = useState(false)
  const [saved, setSaved] = useState<string>()
  const [confirm_block, setConfirmBlock] = useState(false)

  const lookup = useAction(async (value: string) => {
    setSaved(undefined)
    setNotFound(false)
    try {
      const result = await operatorFetch<PreferenceView>(`/api/v1/message/preference?contact=${encodeURIComponent(value)}`)
      setView(result)
      setLookedUp(value)
    } catch (error) {
      setView(undefined)
      if (error instanceof ApiError && error.status === 404) {
        setNotFound(true)
        return
      }
      throw error
    }
  })

  const save = useAction(async (change: { message_kind?: string[]; is_opted_in?: boolean; is_contact_allowed?: boolean }, sentence: string) => {
    const result = await operatorFetch<PreferenceView>('/api/v1/message/preference', jsonBody({ contact: looked_up, ...change }, 'PUT'))
    setView(result)
    setSaved(sentence)
  })

  function submit(event: FormEvent) {
    event.preventDefault()
    if (contact.trim()) void lookup.run(contact.trim())
  }

  const optional = view?.preference.filter((one) => !one.is_essential) ?? []
  const essential = view?.preference.filter((one) => one.is_essential) ?? []

  return (
    <div className="stack">
      <form className="message-lookup" onSubmit={submit}>
        <TextInput
          label="Player email or phone"
          placeholder="andrea@example.com or 0917 555 1234"
          value={contact}
          autoComplete="off"
          onChange={(event) => setContact(event.target.value)}
        />
        <Button type="submit" tone="secondary" icon={<MagnifyingGlass size={18} aria-hidden />} disabled={lookup.is_pending || !contact.trim()}>
          {lookup.is_pending ? 'Looking up…' : 'Look up'}
        </Button>
      </form>

      <ErrorAlert error={lookup.error} onDismiss={lookup.clearError} />
      {not_found && (
        <Alert severity="info" title="No player found">
          No player at this venue uses that email or phone number. Players appear here once they have booked or joined with that contact.
        </Alert>
      )}

      {!view && !not_found && !lookup.error && (
        <p className="muted">
          Look up a player to choose which optional messages they receive. Essential messages about their own bookings always send.
        </p>
      )}

      {view && (
        <Card
          title={view.player.display_name}
          description={[view.player.email_mask, view.player.phone_mask].filter(Boolean).join(' · ') || 'No email or phone on file'}
        >
          <div className="stack">
            {saved && (
              <Alert severity="success" onDismiss={() => setSaved(undefined)}>
                {saved}
              </Alert>
            )}
            <ErrorAlert error={save.error} onDismiss={save.clearError} />

            {!view.is_contact_allowed && (
              <Alert severity="caution" title="Contact is blocked for this player">
                Nothing is sent to {view.player.display_name}, not even essential messages. Messages stay in the outbox as “Not sent”.
              </Alert>
            )}

            <section className="stack">
              <div>
                <h3 className="message-subheading">Optional messages</h3>
                <p className="muted">Sent only when the player has said yes.</p>
              </div>
              <div className="message-toggle-list">
                {optional.map((one) => (
                  <div key={one.message_kind} className="message-toggle">
                    <Checkbox
                      label={one.label}
                      checked={one.is_opted_in}
                      disabled={!can_manage || save.is_pending}
                      onChange={(event) =>
                        void save.run(
                          { message_kind: [one.message_kind], is_opted_in: event.target.checked },
                          `${one.label} turned ${event.target.checked ? 'on' : 'off'} for ${view.player.display_name}.`,
                        )
                      }
                    />
                    <p className="muted message-toggle__hint">{one.description}</p>
                  </div>
                ))}
              </div>
            </section>

            <section className="stack">
              <div>
                <h3 className="message-subheading">Essential messages</h3>
                <p className="muted">These always send, because they are about a booking the player made.</p>
              </div>
              <div className="row">
                {essential.map((one) => (
                  <Badge key={one.message_kind} tone="info">
                    {one.label}
                  </Badge>
                ))}
              </div>
            </section>

            {can_manage && (
              <div className="form__action">
                {view.is_contact_allowed ? (
                  <Button tone="danger" size="sm" onClick={() => setConfirmBlock(true)} disabled={save.is_pending}>
                    Block all messages to this player
                  </Button>
                ) : (
                  <Button
                    tone="secondary"
                    size="sm"
                    disabled={save.is_pending}
                    onClick={() => void save.run({ is_contact_allowed: true }, `${view.player.display_name} can receive messages again.`)}
                  >
                    Allow messages again
                  </Button>
                )}
              </div>
            )}
          </div>
        </Card>
      )}

      {view && confirm_block && (
        <Dialog
          open
          title="Block all messages?"
          onClose={() => setConfirmBlock(false)}
          footer={
            <>
              <Button tone="quiet" onClick={() => setConfirmBlock(false)}>
                Keep sending
              </Button>
              <Button
                tone="danger"
                onClick={() => {
                  setConfirmBlock(false)
                  void save.run({ is_contact_allowed: false }, `All messages to ${view.player.display_name} are blocked.`)
                }}
              >
                Block messages
              </Button>
            </>
          }
        >
          <p>
            {view.player.display_name} will receive nothing from the venue — including booking confirmations, receipts, cancellations,
            and closure notices. Use this only when the player asked not to be contacted or the contact details are wrong.
          </p>
        </Dialog>
      )}
    </div>
  )
}
