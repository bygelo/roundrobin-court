// studio — the document a venue edits and publishes, and its strict validator.
//
// Pure logic, no database. Everything Studio accepts is a constrained choice or
// a bounded plain-text slot: no raw HTML, CSS, script, or URL ever gets in, so
// the public portal can render the document without sanitising it.

import { DomainError } from '@bygelo/roundrobin-kernel'

export const TEMPLATE_CODE = ['club', 'court-dark', 'minimal'] as const
export const HEADING_FONT = ['Space Grotesk', 'Inter'] as const
export const RADIUS = ['square', 'soft', 'round'] as const
export const NAV_CODE = ['book', 'program', 'play', 'shop'] as const

export type TemplateCode = (typeof TEMPLATE_CODE)[number]
export type HeadingFont = (typeof HEADING_FONT)[number]
export type Radius = (typeof RADIUS)[number]
export type NavCode = (typeof NAV_CODE)[number]

/** The module a nav entry needs; the entry disappears when that module is off. */
export const NAV_MODULE: Record<NavCode, string> = {
  book: 'portal',
  program: 'program',
  play: 'play',
  shop: 'shop',
}

export const TEXT_LIMIT = {
  display_name: 60,
  tagline: 90,
  hero_title: 70,
  hero_body: 240,
  address: 140,
  contact: 120,
  nav_label: 20,
} as const

/** WCAG AA for normal-size text. */
export const MINIMUM_CONTRAST = 4.5

const COURT_ORDER_LIMIT = 200

export type StudioNav = { nav_code: NavCode; label: string; is_included: boolean }

export type StudioDocument = {
  template_code: TemplateCode
  display_name: string
  tagline: string | null
  token: { accent: string; action: string; heading_font: HeadingFont; radius: Radius }
  content: { hero_title: string; hero_body: string; address: string | null; contact: string | null }
  nav: StudioNav[]
  /** resource_id values in display order. */
  court_order: string[]
}

/** Mirror of web/src/public-site.ts PublicSite — the public contract. */
export type PublicSite = {
  organization_code: string
  display_name: string
  tagline: string | null
  template_code: TemplateCode
  token: { accent: string; action: string; heading_font: HeadingFont; radius: Radius }
  content: { hero_title: string; hero_body: string; address: string | null; contact: string | null }
  nav: { nav_code: NavCode; label: string }[]
  version_number: number
}

export class StudioValidationError extends DomainError {
  readonly field: string
  constructor(field: string, message: string) {
    super(message, 400)
    this.field = field
  }
}

// ---- colour -----------------------------------------------------------------

const HEX = /^#[0-9a-f]{6}$/i

function channel(value: number): number {
  const scaled = value / 255
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
}

/** WCAG relative luminance of a `#rrggbb` colour. */
export function relativeLuminance(hex: string): number {
  const red = channel(Number.parseInt(hex.slice(1, 3), 16))
  const green = channel(Number.parseInt(hex.slice(3, 5), 16))
  const blue = channel(Number.parseInt(hex.slice(5, 7), 16))
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

/** Contrast ratio of white text on `hex`, 1–21. */
export function contrastWithWhite(hex: string): number {
  return 1.05 / (relativeLuminance(hex) + 0.05)
}

// ---- defaults ---------------------------------------------------------------

export const DEFAULT_NAV_LABEL: Record<NavCode, string> = {
  book: 'Book',
  program: 'Programs',
  play: 'Open play',
  shop: 'Shop',
}

/**
 * The first draft of a venue that has never published. Same look as the web
 * client's defaultSite, except the action colour: defaultSite's #f32624 is only
 * 4.1:1 against white, so a draft starts on #d32522 (5.2:1) and saves cleanly.
 */
export function defaultDocument(display_name: string): StudioDocument {
  return {
    template_code: 'club',
    display_name: display_name.slice(0, TEXT_LIMIT.display_name),
    tagline: null,
    token: { accent: '#123fbd', action: '#d32522', heading_font: 'Space Grotesk', radius: 'round' },
    content: {
      hero_title: 'Book a court',
      hero_body: 'Pick a time, hold your court, and pay at the counter or online.',
      address: null,
      contact: null,
    },
    nav: NAV_CODE.map((nav_code) => ({ nav_code, label: DEFAULT_NAV_LABEL[nav_code], is_included: true })),
    court_order: [],
  }
}

/** What the public route answers when nothing is published: the web defaultSite, named after the venue. */
export function defaultPublicSite(
  organization_code: string,
  display_name: string,
  enabled_module_code: readonly string[],
): PublicSite {
  return {
    organization_code,
    display_name,
    tagline: null,
    template_code: 'club',
    token: { accent: '#123fbd', action: '#f32624', heading_font: 'Space Grotesk', radius: 'round' },
    content: {
      hero_title: 'Book a court',
      hero_body: 'Pick a time, hold your court, and pay at the counter or online.',
      address: null,
      contact: null,
    },
    nav: enabled_module_code.includes(NAV_MODULE.book) ? [{ nav_code: 'book', label: 'Book' }] : [],
    version_number: 0,
  }
}

export function toPublicSite(
  document: StudioDocument,
  organization_code: string,
  enabled_module_code: readonly string[],
  version_number: number,
): PublicSite {
  return {
    organization_code,
    display_name: document.display_name,
    tagline: document.tagline,
    template_code: document.template_code,
    token: { ...document.token },
    content: { ...document.content },
    nav: document.nav
      .filter((one) => one.is_included && enabled_module_code.includes(NAV_MODULE[one.nav_code]))
      .map((one) => ({ nav_code: one.nav_code, label: one.label })),
    version_number,
  }
}

// ---- validation -------------------------------------------------------------

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertObject(value: unknown, field: string, allowed: readonly string[], label: string): Json {
  if (!isObject(value)) throw new StudioValidationError(field, `${label} is missing or is not a set of fields.`)
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new StudioValidationError(`${field ? `${field}.` : ''}${key}`, `"${key}" is not something Studio can edit.`)
    }
  }
  return value
}

function assertChoice<T extends string>(value: unknown, field: string, choice: readonly T[], label: string): T {
  if (typeof value !== 'string' || !(choice as readonly string[]).includes(value)) {
    throw new StudioValidationError(field, `${label} must be one of: ${choice.join(', ')}.`)
  }
  return value as T
}

// Anything that could become markup, a stylesheet URL, or a script URL.
const FORBIDDEN_TEXT: { pattern: RegExp; reason: string }[] = [
  { pattern: /</, reason: 'cannot contain "<" — Studio takes plain text, not HTML' },
  { pattern: /url\s*\(/i, reason: 'cannot contain url( — Studio takes plain text, not CSS' },
  { pattern: /expression\s*\(/i, reason: 'cannot contain expression( — Studio takes plain text, not CSS' },
  { pattern: /javascript\s*:/i, reason: 'cannot contain javascript: — Studio takes plain text, not script' },
  { pattern: /vbscript\s*:|data\s*:\s*text\/html/i, reason: 'cannot contain a script URL' },
]

// Control characters other than tab, line feed, and carriage return.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const LINE_BREAK = /[\n\r\t]/

function assertText(
  value: unknown,
  field: string,
  label: string,
  limit: number,
  option: { is_required: boolean; is_multiline?: boolean },
): string | null {
  if (value === null || value === undefined) {
    if (option.is_required) throw new StudioValidationError(field, `${label} is required.`)
    return null
  }
  if (typeof value !== 'string') throw new StudioValidationError(field, `${label} must be text.`)
  const text = value.trim()
  if (text === '') {
    if (option.is_required) throw new StudioValidationError(field, `${label} is required.`)
    return null
  }
  const length = [...text].length
  if (length > limit) {
    throw new StudioValidationError(field, `${label} must be ${limit} characters or fewer (it is ${length}).`)
  }
  if (CONTROL.test(text) || (!option.is_multiline && LINE_BREAK.test(text))) {
    throw new StudioValidationError(field, `${label} cannot contain control characters${option.is_multiline ? '' : ' or line breaks'}.`)
  }
  for (const one of FORBIDDEN_TEXT) {
    if (one.pattern.test(text)) throw new StudioValidationError(field, `${label} ${one.reason}.`)
  }
  return text
}

function assertColour(value: unknown, field: string, label: string): string {
  if (typeof value !== 'string' || !HEX.test(value)) {
    throw new StudioValidationError(field, `${label} must be a hex colour like #123fbd.`)
  }
  const hex = value.toLowerCase()
  const ratio = contrastWithWhite(hex)
  if (ratio < MINIMUM_CONTRAST) {
    throw new StudioValidationError(
      field,
      `${label} ${hex} gives white text a contrast of ${ratio.toFixed(1)}:1; pick a darker colour that reaches ${MINIMUM_CONTRAST}:1.`,
    )
  }
  return hex
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Accept exactly a StudioDocument, normalised (trimmed text, lowercase hex,
 * empty optional text as null) — or throw StudioValidationError naming the
 * field and saying why in a sentence.
 */
export function validateStudioDocument(input: unknown): StudioDocument {
  const root = assertObject(
    input,
    '',
    ['template_code', 'display_name', 'tagline', 'token', 'content', 'nav', 'court_order'],
    'The site document',
  )

  const template_code = assertChoice(root['template_code'], 'template_code', TEMPLATE_CODE, 'Template')
  const display_name = assertText(root['display_name'], 'display_name', 'Venue name', TEXT_LIMIT.display_name, {
    is_required: true,
  })!
  const tagline = assertText(root['tagline'], 'tagline', 'Tagline', TEXT_LIMIT.tagline, { is_required: false })

  const token_input = assertObject(root['token'], 'token', ['accent', 'action', 'heading_font', 'radius'], 'Brand')
  const token = {
    accent: assertColour(token_input['accent'], 'token.accent', 'Accent colour'),
    action: assertColour(token_input['action'], 'token.action', 'Action colour'),
    heading_font: assertChoice(token_input['heading_font'], 'token.heading_font', HEADING_FONT, 'Heading font'),
    radius: assertChoice(token_input['radius'], 'token.radius', RADIUS, 'Corner style'),
  }

  const content_input = assertObject(
    root['content'],
    'content',
    ['hero_title', 'hero_body', 'address', 'contact'],
    'Content',
  )
  const content = {
    hero_title: assertText(content_input['hero_title'], 'content.hero_title', 'Headline', TEXT_LIMIT.hero_title, {
      is_required: true,
    })!,
    hero_body: assertText(content_input['hero_body'], 'content.hero_body', 'Intro', TEXT_LIMIT.hero_body, {
      is_required: true,
      is_multiline: true,
    })!,
    address: assertText(content_input['address'], 'content.address', 'Address', TEXT_LIMIT.address, {
      is_required: false,
    }),
    contact: assertText(content_input['contact'], 'content.contact', 'Contact', TEXT_LIMIT.contact, {
      is_required: false,
    }),
  }

  const nav_input = root['nav']
  if (!Array.isArray(nav_input)) throw new StudioValidationError('nav', 'Navigation must be a list.')
  if (nav_input.length > NAV_CODE.length) {
    throw new StudioValidationError('nav', `Navigation can hold at most ${NAV_CODE.length} entries.`)
  }
  const seen_nav = new Set<string>()
  const nav: StudioNav[] = nav_input.map((one, index) => {
    const field = `nav.${index}`
    const entry = assertObject(one, field, ['nav_code', 'label', 'is_included'], 'A navigation entry')
    const nav_code = assertChoice(entry['nav_code'], `${field}.nav_code`, NAV_CODE, 'Navigation entry')
    if (seen_nav.has(nav_code)) {
      throw new StudioValidationError(`${field}.nav_code`, `Navigation lists "${nav_code}" twice; each page can appear once.`)
    }
    seen_nav.add(nav_code)
    const label = assertText(entry['label'], `${field}.label`, `The ${DEFAULT_NAV_LABEL[nav_code]} label`, TEXT_LIMIT.nav_label, {
      is_required: true,
    })!
    const is_included = entry['is_included'] ?? true
    if (typeof is_included !== 'boolean') {
      throw new StudioValidationError(`${field}.is_included`, 'Whether a navigation entry is shown must be true or false.')
    }
    return { nav_code, label, is_included }
  })

  const court_input = root['court_order'] ?? []
  if (!Array.isArray(court_input)) throw new StudioValidationError('court_order', 'Court order must be a list of courts.')
  if (court_input.length > COURT_ORDER_LIMIT) {
    throw new StudioValidationError('court_order', `Court order can hold at most ${COURT_ORDER_LIMIT} courts.`)
  }
  const seen_court = new Set<string>()
  const court_order = court_input.map((one) => {
    if (typeof one !== 'string' || !UUID.test(one)) {
      throw new StudioValidationError('court_order', 'Court order contains something that is not a court.')
    }
    const resource_id = one.toLowerCase()
    if (seen_court.has(resource_id)) {
      throw new StudioValidationError('court_order', 'Court order lists the same court twice.')
    }
    seen_court.add(resource_id)
    return resource_id
  })

  return { template_code, display_name, tagline, token, content, nav, court_order }
}

/**
 * Read a stored document leniently: anything invalid in the database (an older
 * shape, a hand edit) falls back to the default rather than breaking the portal.
 */
export function readStoredDocument(value: unknown, fallback_display_name: string): StudioDocument {
  try {
    return validateStudioDocument(value)
  } catch {
    return defaultDocument(fallback_display_name)
  }
}
