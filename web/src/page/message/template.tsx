// Templates tab: the venue's own wording for each message, per channel.

import { EnvelopeSimple, ChatText } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import { ApiError, jsonBody, operatorFetch } from '../../api.ts'
import { Alert, Badge, Button, Card, Checkbox, Dialog, ErrorAlert, Field, ResourceView } from '../../component/ui.tsx'
import { useAction, useResource } from '../../hook.ts'
import { CHANNEL_LABEL, type KindMeta, type MessageChannel, type Preview, type Template, type TemplateView } from './type.ts'

const SUBJECT_LIMIT = 120

type Editing = { meta: KindMeta; channel: MessageChannel; template: Template; body_limit: number }

function TemplateEditor({
  editing,
  can_manage,
  onClose,
  onSaved,
}: {
  editing: Editing
  can_manage: boolean
  onClose: () => void
  onSaved: (label: string) => void
}) {
  const { meta, channel, template, body_limit } = editing
  const [subject, setSubject] = useState(template.subject ?? '')
  const [body, setBody] = useState(template.body)
  const [is_active, setActive] = useState(template.is_active)
  const [focus, setFocus] = useState<'subject' | 'body'>('body')
  const [preview, setPreview] = useState<Preview>()
  const [preview_error, setPreviewError] = useState<string>()
  const subject_ref = useRef<HTMLInputElement>(null)
  const body_ref = useRef<HTMLTextAreaElement>(null)
  const path = `/api/v1/message/template/${meta.message_kind}/${channel}`

  useEffect(() => {
    let is_current = true
    const handle = window.setTimeout(() => {
      operatorFetch<{ preview: Preview }>(
        `${path}/preview`,
        jsonBody(channel === 'email' ? { subject, body } : { body }),
      )
        .then((result) => {
          if (!is_current) return
          setPreview(result.preview)
          setPreviewError(undefined)
        })
        .catch((error: unknown) => {
          if (!is_current) return
          setPreviewError(error instanceof ApiError || error instanceof Error ? error.message : 'Could not preview this message.')
        })
    }, 300)
    return () => {
      is_current = false
      window.clearTimeout(handle)
    }
  }, [path, channel, subject, body])

  const save = useAction(async () => {
    await operatorFetch<{ template: Template }>(
      path,
      jsonBody(channel === 'email' ? { subject, body, is_active } : { body, is_active }, 'PUT'),
    )
    onSaved(`${meta.label} ${CHANNEL_LABEL[channel]}`)
  })

  function insert(token: string) {
    const is_subject = channel === 'email' && focus === 'subject'
    const target = is_subject ? subject_ref.current : body_ref.current
    const value = is_subject ? subject : body
    const start = target?.selectionStart ?? value.length
    const end = target?.selectionEnd ?? value.length
    const next = value.slice(0, start) + token + value.slice(end)
    if (is_subject) setSubject(next)
    else setBody(next)
    window.requestAnimationFrame(() => {
      target?.focus()
      target?.setSelectionRange(start + token.length, start + token.length)
    })
  }

  const is_over = body.trim().length > body_limit
  const is_subject_over = subject.trim().length > SUBJECT_LIMIT

  return (
    <Dialog
      open
      title={`${meta.label} · ${CHANNEL_LABEL[channel]}`}
      onClose={onClose}
      footer={
        <>
          <Button tone="quiet" onClick={onClose}>
            {can_manage ? 'Cancel' : 'Close'}
          </Button>
          {can_manage && (
            <Button onClick={() => void save.run()} disabled={save.is_pending || is_over || is_subject_over}>
              {save.is_pending ? 'Saving…' : 'Save template'}
            </Button>
          )}
        </>
      }
    >
      <p className="muted">
        {meta.description} {meta.is_essential ? 'This message is essential and always sends.' : 'Only players who opted in receive this message.'}
      </p>
      <ErrorAlert error={save.error} onDismiss={save.clearError} />

      {channel === 'email' && (
        <Field label="Subject line">
          {(id) => (
            <>
              <input
                id={id}
                ref={subject_ref}
                className="input"
                value={subject}
                maxLength={SUBJECT_LIMIT + 40}
                readOnly={!can_manage}
                onFocus={() => setFocus('subject')}
                onChange={(event) => setSubject(event.target.value)}
                aria-describedby={`${id}-count`}
              />
              <p id={`${id}-count`} className={`message-counter${is_subject_over ? ' is-over' : ''}`}>
                {subject.trim().length} / {SUBJECT_LIMIT}
              </p>
            </>
          )}
        </Field>
      )}

      <Field label="Message text">
        {(id) => (
          <>
            <textarea
              id={id}
              ref={body_ref}
              className="input input--area message-body-input"
              value={body}
              readOnly={!can_manage}
              rows={channel === 'email' ? 8 : 4}
              onFocus={() => setFocus('body')}
              onChange={(event) => setBody(event.target.value)}
              aria-describedby={`${id}-count`}
            />
            <p id={`${id}-count`} className={`message-counter${is_over ? ' is-over' : ''}`}>
              {body.trim().length} / {body_limit} characters{channel === 'sms' ? ' (two text segments)' : ''}
            </p>
          </>
        )}
      </Field>

      {can_manage && (
        <div className="stack message-chip-block">
          <p className="field__label" id="message-placeholder-label">
            Insert a detail {channel === 'email' ? `into the ${focus === 'subject' ? 'subject line' : 'message text'}` : 'at the cursor'}
          </p>
          <div className="message-chip-row" role="group" aria-labelledby="message-placeholder-label">
            {meta.placeholder.map((name) => (
              <button key={name} type="button" className="message-chip" onClick={() => insert(`{{${name}}}`)}>
                {`{{${name}}}`}
              </button>
            ))}
          </div>
        </div>
      )}

      {channel === 'sms' && (
        <Checkbox
          label="Send this message by SMS"
          checked={is_active}
          disabled={!can_manage}
          onChange={(event) => setActive(event.target.checked)}
        />
      )}
      {channel === 'email' && (
        <Checkbox
          label="Send this message by email"
          checked={is_active}
          disabled={!can_manage}
          onChange={(event) => setActive(event.target.checked)}
        />
      )}

      <section className="message-preview" aria-live="polite" aria-label="Preview with sample data">
        <p className="eyebrow">Preview with sample data</p>
        {preview_error ? (
          <Alert severity="caution">{preview_error}</Alert>
        ) : preview ? (
          <>
            {preview.subject !== null && <p className="message-preview__subject">{preview.subject}</p>}
            <p className="message-preview__body">{preview.body}</p>
          </>
        ) : (
          <p className="muted">Rendering…</p>
        )}
      </section>
    </Dialog>
  )
}

function KindGroup({
  title,
  description,
  view,
  essential,
  onEdit,
  can_manage,
}: {
  title: string
  description: string
  view: TemplateView
  essential: boolean
  onEdit: (editing: Editing) => void
  can_manage: boolean
}) {
  const kind = view.kind.filter((one) => one.is_essential === essential)
  return (
    <Card title={title} description={description}>
      <ul className="message-kind-list">
        {kind.map((meta) => (
          <li key={meta.message_kind} className="message-kind">
            <div className="message-cell">
              <strong>{meta.label}</strong>
              <span className="muted">{meta.description}</span>
            </div>
            <div className="row message-kind__action">
              {(['email', 'sms'] as MessageChannel[]).map((channel) => {
                const template = view.template.find((one) => one.message_kind === meta.message_kind && one.delivery_channel === channel)
                if (!template) return null
                return (
                  <div key={channel} className="row message-kind__channel">
                    <Badge tone={template.is_active ? 'success' : 'neutral'}>
                      {CHANNEL_LABEL[channel]} {template.is_active ? 'on' : 'off'}
                    </Badge>
                    <Button
                      size="sm"
                      tone="secondary"
                      icon={channel === 'email' ? <EnvelopeSimple size={16} aria-hidden /> : <ChatText size={16} aria-hidden />}
                      onClick={() => onEdit({ meta, channel, template, body_limit: view.body_limit[channel] })}
                      aria-label={`${can_manage ? 'Edit' : 'View'} ${meta.label} ${CHANNEL_LABEL[channel]}`}
                    >
                      {can_manage ? 'Edit' : 'View'}
                    </Button>
                  </div>
                )
              })}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  )
}

export function TemplateTab({ can_manage }: { can_manage: boolean }) {
  const template = useResource(() => operatorFetch<TemplateView>('/api/v1/message/template'), [])
  const [editing, setEditing] = useState<Editing>()
  const [saved, setSaved] = useState<string>()

  return (
    <div className="stack">
      {saved && (
        <Alert severity="success" title={`${saved} saved`} onDismiss={() => setSaved(undefined)}>
          Players receive the new wording from the next message on.
        </Alert>
      )}
      <ResourceView resource={template}>
        {(view) => (
          <div className="stack">
            <KindGroup
              title="Essential"
              description="Always sent when a player has an email or phone on file — they are about a booking the player made."
              view={view}
              essential
              onEdit={setEditing}
              can_manage={can_manage}
            />
            <KindGroup
              title="Optional"
              description="Sent only to players who opted in on the Preferences tab."
              view={view}
              essential={false}
              onEdit={setEditing}
              can_manage={can_manage}
            />
          </div>
        )}
      </ResourceView>
      {editing && (
        <TemplateEditor
          key={`${editing.meta.message_kind}-${editing.channel}`}
          editing={editing}
          can_manage={can_manage}
          onClose={() => setEditing(undefined)}
          onSaved={(label) => {
            setEditing(undefined)
            setSaved(label)
            template.reload()
          }}
        />
      )}
    </div>
  )
}
