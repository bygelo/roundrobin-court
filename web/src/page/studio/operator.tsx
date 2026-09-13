// Studio — the owner's workspace for the branded public site (R18).
//
// Compact icon rail on the left, a dominant live preview in the middle, and a
// restrained inspector on the right. Edits stay in a draft that no visitor can
// see; one Publish action makes the draft the live version in one transaction.

import {
  ArrowDown,
  ArrowSquareOut,
  ArrowUp,
  ClockCounterClockwise,
  Desktop,
  DeviceMobile,
  ListBullets,
  PaintBrush,
  Rows,
  SquaresFour,
  TextT,
} from '@phosphor-icons/react'
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { ApiError, jsonBody, operatorFetch } from '../../api.ts'
import {
  Alert,
  Badge,
  Button,
  ButtonLink,
  Checkbox,
  Dialog,
  EmptyState,
  ErrorAlert,
  ResourceView,
  TextArea,
  TextInput,
} from '../../component/ui.tsx'
import { formatDateTime } from '../../format.ts'
import { useAction, useResource } from '../../hook.ts'
import type { PublicSite, SiteTemplateCode } from '../../public-site.ts'
import type { PageProp } from '../../registry.ts'
import { useOperator } from '../../session.tsx'
import './studio.css'

// ---- contract with /api/v1/studio ------------------------------------------

type NavCode = PublicSite['nav'][number]['nav_code']

type StudioDocument = {
  template_code: SiteTemplateCode
  display_name: string
  tagline: string | null
  token: PublicSite['token']
  content: PublicSite['content']
  nav: { nav_code: NavCode; label: string; is_included: boolean }[]
  court_order: string[]
}

type StudioCourt = { resource_id: string; display_name: string }

type DraftView = {
  draft: { document: StudioDocument; updated_at: string }
  court: StudioCourt[]
  nav_module: { nav_code: NavCode; module_code: string; is_enabled: boolean }[]
  publication: { version_number: number; published_at: string } | null
  is_live: boolean
}

type VersionView = {
  version_number: number
  source_code: 'publish' | 'rollback'
  rolled_back_from_version_number: number | null
  published_at: string
  published_by_display_name: string | null
  template_code: string | null
  display_name: string | null
  is_current: boolean
}

// ---- constants --------------------------------------------------------------

type Section = 'template' | 'brand' | 'content' | 'navigation' | 'court' | 'history'

const SECTION: { value: Section; label: string; icon: ReactNode }[] = [
  { value: 'template', label: 'Template', icon: <SquaresFour size={22} aria-hidden /> },
  { value: 'brand', label: 'Brand', icon: <PaintBrush size={22} aria-hidden /> },
  { value: 'content', label: 'Content', icon: <TextT size={22} aria-hidden /> },
  { value: 'navigation', label: 'Navigation', icon: <ListBullets size={22} aria-hidden /> },
  { value: 'court', label: 'Courts', icon: <Rows size={22} aria-hidden /> },
  { value: 'history', label: 'History', icon: <ClockCounterClockwise size={22} aria-hidden /> },
]

const TEMPLATE: { value: SiteTemplateCode; label: string; description: string }[] = [
  { value: 'club', label: 'Club', description: 'Warm white, bold headline, booking first.' },
  { value: 'court-dark', label: 'Court dark', description: 'High-contrast night look for evening play.' },
  { value: 'minimal', label: 'Minimal', description: 'Quiet and content-first with lighter headings.' },
]

const RADIUS: Record<PublicSite['token']['radius'], string> = { square: '4px', soft: '12px', round: '999px' }

const LIMIT = { display_name: 60, tagline: 90, hero_title: 70, hero_body: 240, address: 140, contact: 120, nav_label: 20 }

const NAV_NAME: Record<NavCode, { page: string; module: string }> = {
  book: { page: 'Court booking', module: 'Portal' },
  program: { page: 'Programs', module: 'Programs' },
  play: { page: 'Open play', module: 'Open play' },
  shop: { page: 'Shop', module: 'Shop' },
}

const NAV_ORDER: NavCode[] = ['book', 'program', 'play', 'shop']
const MINIMUM_CONTRAST = 4.5
const HEX = /^#[0-9a-f]{6}$/i

// ---- pure helpers -----------------------------------------------------------

function channel(value: number): number {
  const scaled = value / 255
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
}

/** WCAG contrast of white text on a #rrggbb colour — same formula the server enforces. */
function contrastWithWhite(hex: string): number {
  const luminance =
    0.2126 * channel(Number.parseInt(hex.slice(1, 3), 16)) +
    0.7152 * channel(Number.parseInt(hex.slice(3, 5), 16)) +
    0.0722 * channel(Number.parseInt(hex.slice(5, 7), 16))
  return 1.05 / (luminance + 0.05)
}

/** Every nav code present exactly once, keeping the saved order. */
function normalizeDocument(document: StudioDocument): StudioDocument {
  const present = new Set(document.nav.map((one) => one.nav_code))
  const missing = NAV_ORDER.filter((code) => !present.has(code)).map((nav_code) => ({
    nav_code,
    label: NAV_NAME[nav_code].page,
    is_included: false,
  }))
  return { ...document, nav: [...document.nav, ...missing] }
}

function orderCourt(court: StudioCourt[], court_order: string[]): StudioCourt[] {
  const position = new Map(court_order.map((id, index) => [id, index]))
  return court
    .map((one, index) => ({ one, rank: position.get(one.resource_id) ?? court_order.length + index }))
    .sort((left, right) => left.rank - right.rank)
    .map((entry) => entry.one)
}

function move<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length) return list
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item!)
  return next
}

function readRefusal(error: Error | undefined): { field: string; message: string } | undefined {
  if (!(error instanceof ApiError)) return undefined
  const body = error.body
  if (body && typeof body === 'object' && 'field' in body && typeof (body as { field: unknown }).field === 'string') {
    return { field: (body as { field: string }).field, message: error.message }
  }
  return undefined
}

function sectionOf(field: string): Section {
  if (field.startsWith('template')) return 'template'
  if (field.startsWith('token')) return 'brand'
  if (field.startsWith('nav')) return 'navigation'
  if (field.startsWith('court')) return 'court'
  return 'content'
}

// ---- page -------------------------------------------------------------------

export default function Page(_prop: PageProp) {
  const { session, can } = useOperator()
  const draft = useResource(() => operatorFetch<DraftView>('/api/v1/studio/draft'), [])
  return (
    <ResourceView resource={draft}>
      {(data) => (
        <Studio initial={data} organization_code={session.organization_code} can_manage={can('studio.manage')} />
      )}
    </ResourceView>
  )
}

type Notice = { severity: 'success' | 'info'; title: string; body?: ReactNode }

function Studio({
  initial,
  organization_code,
  can_manage,
}: {
  initial: DraftView
  organization_code: string
  can_manage: boolean
}) {
  const [view, setView] = useState(initial)
  const [document, setDocument] = useState(() => normalizeDocument(initial.draft.document))
  const [saved_key, setSavedKey] = useState(() => JSON.stringify(normalizeDocument(initial.draft.document)))
  const [section, setSection] = useState<Section>('template')
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop')
  const [notice, setNotice] = useState<Notice>()
  const [history_key, setHistoryKey] = useState(0)
  const [rollback_target, setRollbackTarget] = useState<VersionView>()
  const version = useResource(
    () => operatorFetch<{ version: VersionView[] }>('/api/v1/studio/version'),
    [history_key],
  )

  const is_dirty = JSON.stringify(document) !== saved_key
  const site_path = `/v/${encodeURIComponent(organization_code)}`

  const applyView = (next: DraftView) => {
    const normalized = normalizeDocument(next.draft.document)
    setView(next)
    setDocument(normalized)
    setSavedKey(JSON.stringify(normalized))
  }

  const save = useAction(async () => {
    const next = await operatorFetch<DraftView>('/api/v1/studio/draft', jsonBody({ document }, 'PUT'))
    applyView(next)
    setNotice({ severity: 'success', title: 'Draft saved', body: 'Only staff can see it until you publish.' })
  })

  const publish = useAction(async () => {
    const result = await operatorFetch<{ version_number: number }>(
      '/api/v1/studio/publish',
      jsonBody(is_dirty ? { document } : {}),
    )
    applyView(await operatorFetch<DraftView>('/api/v1/studio/draft'))
    setHistoryKey((value) => value + 1)
    setNotice({
      severity: 'success',
      title: `Published version ${result.version_number} — your public site now shows it`,
      body: (
        <a href={site_path} target="_blank" rel="noreferrer">
          Open your public site
        </a>
      ),
    })
  })

  const rollback = useAction(async (target: VersionView) => {
    const result = await operatorFetch<{ version_number: number }>(
      `/api/v1/studio/version/${target.version_number}/rollback`,
      { method: 'POST' },
    )
    applyView(await operatorFetch<DraftView>('/api/v1/studio/draft'))
    setHistoryKey((value) => value + 1)
    setRollbackTarget(undefined)
    setNotice({
      severity: 'success',
      title: `Rolled back — version ${result.version_number} is live with version ${target.version_number}'s design`,
      body: (
        <a href={site_path} target="_blank" rel="noreferrer">
          Open your public site
        </a>
      ),
    })
  })

  const refusal = readRefusal(save.error) ?? readRefusal(publish.error)
  const action_error = save.error ?? publish.error
  const errorFor = (field: string) => (refusal?.field === field ? refusal.message : undefined)

  // Jump to the part of the inspector the server refused.
  useEffect(() => {
    if (refusal) setSection(sectionOf(refusal.field))
  }, [refusal?.field, refusal?.message])

  // Never lose edits on navigation without a confirm.
  useEffect(() => {
    if (!is_dirty) return
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    const click = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!anchor || anchor.target === '_blank' || event.defaultPrevented) return
      const url = new URL(anchor.href, window.location.href)
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return
      if (!window.confirm('You have unsaved Studio changes. Leave without saving them?')) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    window.addEventListener('beforeunload', beforeUnload)
    window.document.addEventListener('click', click, true)
    return () => {
      window.removeEventListener('beforeunload', beforeUnload)
      window.document.removeEventListener('click', click, true)
    }
  }, [is_dirty])

  const update = (change: (current: StudioDocument) => StudioDocument) => {
    setDocument((current) => change(current))
    setNotice(undefined)
    if (save.error) save.clearError()
    if (publish.error) publish.clearError()
  }

  const court = orderCourt(view.court, document.court_order)
  const is_busy = save.is_pending || publish.is_pending || rollback.is_pending

  let status: ReactNode
  if (is_dirty) status = <Badge tone="caution">Unsaved changes</Badge>
  else if (view.publication && view.is_live) status = <Badge tone="success">Published v{view.publication.version_number}</Badge>
  else if (view.publication)
    status = (
      <>
        <Badge tone="info">Draft saved</Badge>
        <Badge tone="neutral">Live: v{view.publication.version_number}</Badge>
      </>
    )
  else
    status = (
      <>
        <Badge tone="info">Draft saved</Badge>
        <Badge tone="neutral">Not published yet</Badge>
      </>
    )

  return (
    <div className="studio">
      <header className="studio__bar">
        <div className="studio__title">
          <p className="eyebrow">Venue</p>
          <h1>Studio</h1>
        </div>
        <div className="studio__status" aria-live="polite">
          {status}
        </div>
        <div className="studio__action">
          <a className="button button--quiet button--md" href={site_path} target="_blank" rel="noreferrer">
            <ArrowSquareOut size={18} aria-hidden /> View site
          </a>
          {can_manage && (
            <>
              <Button tone="secondary" disabled={!is_dirty || is_busy} onClick={() => void save.run()}>
                {save.is_pending ? 'Saving…' : 'Save draft'}
              </Button>
              <Button disabled={is_busy} onClick={() => void publish.run()}>
                {publish.is_pending ? 'Publishing…' : 'Publish'}
              </Button>
            </>
          )}
        </div>
      </header>

      <div className="studio__message">
        {!can_manage && (
          <Alert severity="info" title="You can look, not change">
            Publishing the venue site needs the Studio manage permission. Ask an owner under Admin → Staff.
          </Alert>
        )}
        {notice && (
          <Alert severity={notice.severity} title={notice.title} onDismiss={() => setNotice(undefined)}>
            {notice.body}
          </Alert>
        )}
        {action_error && refusal ? (
          <Alert
            severity="danger"
            title={`Not saved — check ${SECTION.find((one) => one.value === sectionOf(refusal.field))?.label ?? 'the highlighted field'}`}
            onDismiss={() => {
              save.clearError()
              publish.clearError()
            }}
          >
            The field that needs a change is marked in the panel on the right.
          </Alert>
        ) : (
          action_error && (
            <ErrorAlert
              error={action_error}
              onDismiss={() => {
                save.clearError()
                publish.clearError()
              }}
            />
          )
        )}
      </div>

      <div className="studio__body">
        <nav className="studio__rail" aria-label="Studio sections">
          {SECTION.map((one) => (
            <button
              key={one.value}
              type="button"
              className={`studio__rail-item ${section === one.value ? 'is-active' : ''}`}
              aria-current={section === one.value ? 'true' : undefined}
              onClick={() => setSection(one.value)}
            >
              {one.icon}
              <span>{one.label}</span>
            </button>
          ))}
        </nav>

        <section className="studio__preview" aria-label="Live preview">
          <div className="studio__preview-bar">
            <p className="studio__preview-label">
              Preview <span className="muted">· {is_dirty ? 'unsaved edits' : 'draft'}, not public</span>
            </p>
            <div className="studio-segment" role="radiogroup" aria-label="Preview size">
              <button type="button" role="radio" aria-checked={device === 'desktop'} onClick={() => setDevice('desktop')}>
                <Desktop size={16} aria-hidden /> Desktop
              </button>
              <button type="button" role="radio" aria-checked={device === 'mobile'} onClick={() => setDevice('mobile')}>
                <DeviceMobile size={16} aria-hidden /> Mobile
              </button>
            </div>
          </div>
          <SitePreview document={document} view={view} court={court} device={device} />
        </section>

        <aside className="studio__inspector" aria-label={`${SECTION.find((one) => one.value === section)?.label} settings`}>
          <fieldset className="studio__fieldset" disabled={!can_manage || is_busy}>
            {section === 'template' && (
              <InspectorSection title="Template" description="Pick a premade look. Your words, colours, and order carry over.">
                <div className="studio-template">
                  {TEMPLATE.map((one) => (
                    <button
                      key={one.value}
                      type="button"
                      className={`studio-template__choice ${document.template_code === one.value ? 'is-selected' : ''}`}
                      aria-pressed={document.template_code === one.value}
                      onClick={() => update((current) => ({ ...current, template_code: one.value }))}
                    >
                      <TemplateThumb template_code={one.value} token={document.token} />
                      <span className="studio-template__text">
                        <strong>{one.label}</strong>
                        <span className="muted">{one.description}</span>
                      </span>
                      {document.template_code === one.value && <Badge tone="info">Selected</Badge>}
                    </button>
                  ))}
                </div>
                {errorFor('template_code') && <p className="field__error">{errorFor('template_code')}</p>}
              </InspectorSection>
            )}

            {section === 'brand' && (
              <InspectorSection title="Brand" description="Two colours, a heading font, and a corner style. Buttons use white text, so both colours must stay readable.">
                <ColourField
                  label="Accent colour"
                  hint="Links, highlights, and the active page."
                  value={document.token.accent}
                  error={errorFor('token.accent')}
                  onChange={(accent) => update((current) => ({ ...current, token: { ...current.token, accent } }))}
                />
                <ColourField
                  label="Action colour"
                  hint="The Book a court button."
                  value={document.token.action}
                  error={errorFor('token.action')}
                  onChange={(action) => update((current) => ({ ...current, token: { ...current.token, action } }))}
                />
                <Segmented
                  label="Heading font"
                  value={document.token.heading_font}
                  option={[
                    { value: 'Space Grotesk', label: 'Space Grotesk' },
                    { value: 'Inter', label: 'Inter' },
                  ]}
                  onChange={(heading_font) =>
                    update((current) => ({ ...current, token: { ...current.token, heading_font } }))
                  }
                />
                <Segmented
                  label="Corner style"
                  value={document.token.radius}
                  option={[
                    { value: 'square', label: 'Square' },
                    { value: 'soft', label: 'Soft' },
                    { value: 'round', label: 'Round' },
                  ]}
                  onChange={(radius) => update((current) => ({ ...current, token: { ...current.token, radius } }))}
                />
              </InspectorSection>
            )}

            {section === 'content' && (
              <InspectorSection title="Content" description="Plain text only — what players read first.">
                <CountedInput
                  label="Venue name"
                  value={document.display_name}
                  limit={LIMIT.display_name}
                  error={errorFor('display_name')}
                  onChange={(display_name) => update((current) => ({ ...current, display_name }))}
                />
                <CountedInput
                  label="Tagline"
                  optional
                  value={document.tagline ?? ''}
                  limit={LIMIT.tagline}
                  error={errorFor('tagline')}
                  onChange={(tagline) => update((current) => ({ ...current, tagline }))}
                />
                <CountedInput
                  label="Headline"
                  value={document.content.hero_title}
                  limit={LIMIT.hero_title}
                  error={errorFor('content.hero_title')}
                  onChange={(hero_title) =>
                    update((current) => ({ ...current, content: { ...current.content, hero_title } }))
                  }
                />
                <div className={errorFor('content.hero_body') ? 'field--invalid' : undefined}>
                  <TextArea
                    label="Intro"
                    rows={4}
                    maxLength={LIMIT.hero_body}
                    value={document.content.hero_body}
                    hint={<Counter length={document.content.hero_body.length} limit={LIMIT.hero_body} />}
                    onChange={(event) => {
                      const hero_body = event.target.value
                      update((current) => ({ ...current, content: { ...current.content, hero_body } }))
                    }}
                  />
                  {errorFor('content.hero_body') && <p className="field__error">{errorFor('content.hero_body')}</p>}
                </div>
                <CountedInput
                  label="Address"
                  optional
                  value={document.content.address ?? ''}
                  limit={LIMIT.address}
                  error={errorFor('content.address')}
                  onChange={(address) => update((current) => ({ ...current, content: { ...current.content, address } }))}
                />
                <CountedInput
                  label="Contact"
                  optional
                  value={document.content.contact ?? ''}
                  limit={LIMIT.contact}
                  error={errorFor('content.contact')}
                  onChange={(contact) => update((current) => ({ ...current, content: { ...current.content, contact } }))}
                />
              </InspectorSection>
            )}

            {section === 'navigation' && (
              <InspectorSection title="Navigation" description="Rename, reorder, or hide the links in your site header.">
                <OrderList
                  item={document.nav.map((one) => ({ key: one.nav_code, label: one.label || NAV_NAME[one.nav_code].page }))}
                  onMove={(from, to) => update((current) => ({ ...current, nav: move(current.nav, from, to) }))}
                  render={(index) => {
                    const one = document.nav[index]!
                    const module = view.nav_module.find((entry) => entry.nav_code === one.nav_code)
                    const field = `nav.${index}`
                    return (
                      <div className="stack studio-nav">
                        <Checkbox
                          label={`Show ${NAV_NAME[one.nav_code].page}`}
                          checked={one.is_included}
                          onChange={(event) => {
                            const is_included = event.target.checked
                            update((current) => ({
                              ...current,
                              nav: current.nav.map((entry, position) => (position === index ? { ...entry, is_included } : entry)),
                            }))
                          }}
                        />
                        <CountedInput
                          label="Label"
                          value={one.label}
                          limit={LIMIT.nav_label}
                          error={errorFor(`${field}.label`) ?? errorFor(`${field}.nav_code`)}
                          onChange={(label) =>
                            update((current) => ({
                              ...current,
                              nav: current.nav.map((entry, position) => (position === index ? { ...entry, label } : entry)),
                            }))
                          }
                        />
                        {module && !module.is_enabled && (
                          <p className="studio-nav__off">
                            <Badge tone="caution">Module off</Badge>
                            <span className="muted">
                              Hidden on your site until {NAV_NAME[one.nav_code].module} is turned on under Admin → Modules.
                            </span>
                          </p>
                        )}
                      </div>
                    )
                  }}
                />
              </InspectorSection>
            )}

            {section === 'court' && (
              <InspectorSection title="Court order" description="The order players see courts in when they book.">
                {court.length === 0 ? (
                  <EmptyState
                    title="No courts yet"
                    description="Add your courts in venue setup, then come back to set their order."
                    action={<ButtonLink to="/operator/venue" tone="secondary" size="sm">Open venue setup</ButtonLink>}
                  />
                ) : (
                  <OrderList
                    item={court.map((one) => ({ key: one.resource_id, label: one.display_name }))}
                    onMove={(from, to) =>
                      update((current) => ({
                        ...current,
                        court_order: move(orderCourt(view.court, current.court_order), from, to).map((one) => one.resource_id),
                      }))
                    }
                    render={(index) => <span className="studio-order__name">{court[index]!.display_name}</span>}
                  />
                )}
                {errorFor('court_order') && <p className="field__error">{errorFor('court_order')}</p>}
              </InspectorSection>
            )}
          </fieldset>

          {section === 'history' && (
            <InspectorSection title="History" description="Every published version. Rolling back publishes a new version with the older design.">
              <ResourceView resource={version}>
                {(data) =>
                  data.version.length === 0 ? (
                    <EmptyState
                      title="Nothing published yet"
                      description="Publish once and each version appears here, so you can always return to it."
                    />
                  ) : (
                    <ol className="studio-history">
                      {data.version.map((one) => (
                        <li key={one.version_number} className="studio-history__item">
                          <div className="row">
                            <strong>Version {one.version_number}</strong>
                            {one.is_current && <Badge tone="success">Live</Badge>}
                            {one.source_code === 'rollback' && (
                              <Badge tone="info">Rollback to v{one.rolled_back_from_version_number}</Badge>
                            )}
                          </div>
                          <p className="muted">
                            {formatDateTime(one.published_at)} · {one.published_by_display_name ?? 'Setup'}
                            {one.template_code && ` · ${TEMPLATE.find((entry) => entry.value === one.template_code)?.label ?? one.template_code}`}
                          </p>
                          {!one.is_current && can_manage && (
                            <Button tone="secondary" size="sm" disabled={is_busy} onClick={() => setRollbackTarget(one)}>
                              Roll back to this
                            </Button>
                          )}
                        </li>
                      ))}
                    </ol>
                  )
                }
              </ResourceView>
            </InspectorSection>
          )}
        </aside>
      </div>

      <Dialog
        open={rollback_target !== undefined}
        title={`Roll back to version ${rollback_target?.version_number ?? ''}?`}
        onClose={() => {
          setRollbackTarget(undefined)
          rollback.clearError()
        }}
        footer={
          <>
            <Button tone="quiet" onClick={() => setRollbackTarget(undefined)}>
              Cancel
            </Button>
            <Button
              disabled={rollback.is_pending}
              onClick={() => {
                if (rollback_target) void rollback.run(rollback_target)
              }}
            >
              {rollback.is_pending ? 'Rolling back…' : 'Roll back and publish'}
            </Button>
          </>
        }
      >
        <p>
          Your public site will immediately show version {rollback_target?.version_number}'s design. It is published as a
          new version, so the current one stays in history and you can return to it.
        </p>
        {is_dirty && (
          <Alert severity="caution" title="Your unsaved changes will be replaced">
            The draft is reset to the rolled-back design.
          </Alert>
        )}
        <ErrorAlert error={rollback.error} />
      </Dialog>
    </div>
  )
}

// ---- inspector parts ----------------------------------------------------------

function InspectorSection({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <div className="studio-section">
      <header className="studio-section__header">
        <h2>{title}</h2>
        <p className="muted">{description}</p>
      </header>
      <div className="stack">{children}</div>
    </div>
  )
}

function Counter({ length, limit }: { length: number; limit: number }) {
  return (
    <span className={length >= limit ? 'studio-counter is-full' : 'studio-counter'}>
      {length} / {limit}
    </span>
  )
}

function CountedInput({
  label,
  value,
  limit,
  error,
  optional,
  onChange,
}: {
  label: string
  value: string
  limit: number
  error: string | undefined
  optional?: boolean
  onChange: (value: string) => void
}) {
  return (
    <TextInput
      label={optional ? `${label} (optional)` : label}
      value={value}
      maxLength={limit}
      error={error}
      hint={<Counter length={[...value].length} limit={limit} />}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

function ColourField({
  label,
  hint,
  value,
  error,
  onChange,
}: {
  label: string
  hint: string
  value: string
  error: string | undefined
  onChange: (value: string) => void
}) {
  const id = useId()
  const is_hex = HEX.test(value)
  const ratio = is_hex ? contrastWithWhite(value) : undefined
  return (
    <div className={`field ${error ? 'field--invalid' : ''}`}>
      <label htmlFor={id} className="field__label">
        {label}
      </label>
      <div className="studio-colour">
        <input
          type="color"
          className="studio-colour__picker"
          aria-label={`${label} picker`}
          value={is_hex ? value.toLowerCase() : '#000000'}
          onChange={(event) => onChange(event.target.value)}
        />
        <input
          id={id}
          className="input mono"
          value={value}
          maxLength={7}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={error || (ratio !== undefined && ratio < MINIMUM_CONTRAST) ? true : undefined}
          onChange={(event) => onChange(event.target.value.trim())}
        />
        <span className="studio-colour__sample" style={is_hex ? { background: value } : undefined} aria-hidden>
          Aa
        </span>
      </div>
      <p className="studio-colour__contrast">
        {ratio === undefined ? (
          <Badge tone="danger">Not a colour</Badge>
        ) : ratio >= MINIMUM_CONTRAST ? (
          <Badge tone="success">Pass {ratio.toFixed(1)}:1</Badge>
        ) : (
          <Badge tone="danger">Fail {ratio.toFixed(1)}:1</Badge>
        )}
        <span className="muted">{hint} White text needs 4.5:1.</span>
      </p>
      {error && <p className="field__error">{error}</p>}
    </div>
  )
}

function Segmented<T extends string>({
  label,
  value,
  option,
  onChange,
}: {
  label: string
  value: T
  option: { value: T; label: string }[]
  onChange: (value: T) => void
}) {
  const id = useId()
  return (
    <div className="field">
      <span className="field__label" id={id}>
        {label}
      </span>
      <div className="studio-segment" role="radiogroup" aria-labelledby={id}>
        {option.map((one) => (
          <button key={one.value} type="button" role="radio" aria-checked={one.value === value} onClick={() => onChange(one.value)}>
            {one.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/** A reorderable list with up/down buttons — keyboard operable, no drag needed. Focus follows the moved row. */
function OrderList({
  item,
  onMove,
  render,
}: {
  item: { key: string; label: string }[]
  onMove: (from: number, to: number) => void
  render: (index: number) => ReactNode
}) {
  const list_ref = useRef<HTMLOListElement>(null)
  const pending_focus = useRef<{ key: string; direction: 'up' | 'down' }>(undefined)

  useEffect(() => {
    const focus = pending_focus.current
    if (!focus || !list_ref.current) return
    pending_focus.current = undefined
    const preferred = list_ref.current.querySelector<HTMLButtonElement>(`[data-move="${focus.key}-${focus.direction}"]`)
    const fallback = list_ref.current.querySelector<HTMLButtonElement>(
      `[data-move="${focus.key}-${focus.direction === 'up' ? 'down' : 'up'}"]`,
    )
    ;(preferred && !preferred.disabled ? preferred : fallback)?.focus()
  })

  return (
    <ol className="studio-order" ref={list_ref}>
      {item.map((one, index) => (
        <li key={one.key} className="studio-order__item">
          <span className="studio-order__index" aria-hidden>
            {index + 1}
          </span>
          <div className="studio-order__body">{render(index)}</div>
          <span className="studio-order__move">
            <button
              type="button"
              data-move={`${one.key}-up`}
              aria-label={`Move ${one.label} up`}
              disabled={index === 0}
              onClick={() => {
                pending_focus.current = { key: one.key, direction: 'up' }
                onMove(index, index - 1)
              }}
            >
              <ArrowUp size={16} aria-hidden />
            </button>
            <button
              type="button"
              data-move={`${one.key}-down`}
              aria-label={`Move ${one.label} down`}
              disabled={index === item.length - 1}
              onClick={() => {
                pending_focus.current = { key: one.key, direction: 'down' }
                onMove(index, index + 1)
              }}
            >
              <ArrowDown size={16} aria-hidden />
            </button>
          </span>
        </li>
      ))}
    </ol>
  )
}

// ---- preview ------------------------------------------------------------------

function TemplateThumb({ template_code, token }: { template_code: SiteTemplateCode; token: PublicSite['token'] }) {
  const style = { '--thumb-accent': HEX.test(token.accent) ? token.accent : undefined, '--thumb-action': HEX.test(token.action) ? token.action : undefined } as CSSProperties
  return (
    <span className={`studio-thumb studio-thumb--${template_code}`} style={style} aria-hidden>
      <span className="studio-thumb__bar">
        <span className="studio-thumb__mark" />
        <span className="studio-thumb__link" />
        <span className="studio-thumb__link" />
      </span>
      <span className="studio-thumb__hero">
        <span className="studio-thumb__copy">
          <span className="studio-thumb__title" />
          <span className="studio-thumb__title studio-thumb__title--short" />
          <span className="studio-thumb__button" />
        </span>
        <span className="studio-thumb__art" />
      </span>
    </span>
  )
}

function SitePreview({
  document,
  view,
  court,
  device,
}: {
  document: StudioDocument
  view: DraftView
  court: StudioCourt[]
  device: 'desktop' | 'mobile'
}) {
  const enabled = new Set(view.nav_module.filter((one) => one.is_enabled).map((one) => one.nav_code))
  const nav = document.nav.filter((one) => one.is_included && enabled.has(one.nav_code))
  const style = {
    '--brand-accent': HEX.test(document.token.accent) ? document.token.accent : undefined,
    '--brand-action': HEX.test(document.token.action) ? document.token.action : undefined,
    '--brand-heading': `"${document.token.heading_font}"`,
    '--brand-radius': RADIUS[document.token.radius],
  } as CSSProperties

  return (
    <div className="studio-preview__stage">
      <div className={`studio-preview__frame studio-preview__frame--${device}`}>
        <div className={`public public--${document.template_code} studio-mini`} style={style} inert>
          <header className="public__header studio-mini__header">
            <span className="public__wordmark">{document.display_name || 'Your venue'}</span>
            <span className="studio-mini__menu">Menu</span>
            <span className="studio-mini__nav">
              {nav.map((one, index) => (
                <span key={one.nav_code} className={index === 0 ? 'is-current' : undefined}>
                  {one.label}
                </span>
              ))}
            </span>
          </header>
          <div className="studio-mini__main">
            <section className="studio-mini__hero">
              <div className="studio-mini__copy">
                {document.tagline && <p className="eyebrow">{document.tagline}</p>}
                <h1>{document.content.hero_title || 'Your headline'}</h1>
                <p>{document.content.hero_body}</p>
                <span className="button button--primary button--md">Book a court</span>
              </div>
              <div className="studio-mini__art" aria-hidden>
                <span className="studio-mini__kitchen" />
                <span className="studio-mini__net" />
                <span className="studio-mini__kitchen studio-mini__kitchen--far" />
              </div>
            </section>
            <section className="studio-mini__strip">
              <div className="row row--between">
                <h2>Courts tonight</h2>
                <span className="muted">Preview · times come from your schedule</span>
              </div>
              {court.length === 0 ? (
                <p className="muted">Your courts appear here, in the order you set, once they are added in venue setup.</p>
              ) : (
                <ul className="studio-mini__court">
                  {court.slice(0, 6).map((one) => (
                    <li key={one.resource_id}>
                      <strong>{one.display_name}</strong>
                      <span className="muted">See times</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
          <footer className="public__footer studio-mini__footer">
            <div>
              <strong>{document.display_name}</strong>
              {document.content.address && <p>{document.content.address}</p>}
              {document.content.contact && <p>{document.content.contact}</p>}
            </div>
          </footer>
        </div>
      </div>
    </div>
  )
}
