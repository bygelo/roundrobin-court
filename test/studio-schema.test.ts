// studio — the document validator and PublicSite projection. No database.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  StudioValidationError,
  contrastWithWhite,
  defaultDocument,
  defaultPublicSite,
  toPublicSite,
  validateStudioDocument,
  type StudioDocument,
} from '../src/module/studio/schema.ts'
import { orderCourt } from '../src/module/studio/service.ts'

function valid(): StudioDocument {
  return {
    ...defaultDocument('Sideout Pickleball Club'),
    tagline: 'Pickleball courts in Quezon City',
    court_order: [],
  }
}

function refusedField(input: unknown): string {
  try {
    validateStudioDocument(input)
  } catch (error) {
    assert.ok(error instanceof StudioValidationError, `expected StudioValidationError, got ${String(error)}`)
    assert.ok(error.message.endsWith('.'), 'refusal is a sentence')
    return error.field
  }
  assert.fail('expected a refusal')
}

describe('studio document validator', () => {
  it('accepts the default document and normalises it', () => {
    const document = valid()
    document.token.accent = '#123FBD'
    document.content.address = '   '
    const result = validateStudioDocument(document)
    assert.equal(result.token.accent, '#123fbd')
    assert.equal(result.content.address, null)
  })

  it('computes WCAG contrast against white', () => {
    assert.equal(contrastWithWhite('#000000').toFixed(0), '21')
    assert.equal(contrastWithWhite('#ffffff').toFixed(0), '1')
    assert.ok(contrastWithWhite('#d32522') >= 4.5, 'seed action colour passes')
    assert.ok(contrastWithWhite('#123fbd') >= 4.5, 'seed accent colour passes')
    assert.ok(contrastWithWhite('#f32624') < 4.5, 'defaultSite action colour is below AA')
  })

  it('refuses a malformed hex colour', () => {
    const document = valid()
    document.token.accent = '#12g'
    assert.equal(refusedField(document), 'token.accent')
    const named = valid() as unknown as { token: Record<string, unknown> }
    named.token['action'] = 'red'
    assert.equal(refusedField(named), 'token.action')
  })

  it('refuses a colour white text cannot be read on', () => {
    const document = valid()
    document.token.action = '#ffcc00'
    assert.equal(refusedField(document), 'token.action')
  })

  it('refuses an overlong field', () => {
    const document = valid()
    document.content.hero_title = 'x'.repeat(71)
    assert.equal(refusedField(document), 'content.hero_title')
    const name = valid()
    name.display_name = 'x'.repeat(61)
    assert.equal(refusedField(name), 'display_name')
    const label = valid()
    label.nav[0]!.label = 'x'.repeat(21)
    assert.equal(refusedField(label), 'nav.0.label')
  })

  it('refuses HTML, CSS urls, and script urls in text', () => {
    for (const text of ['<b>hi</b>', 'background:url(evil.png)', 'javascript:alert(1)', 'JavaScript :x']) {
      const document = valid()
      document.content.hero_body = text
      assert.equal(refusedField(document), 'content.hero_body', text)
    }
    const tagline = valid()
    tagline.tagline = '<script>'
    assert.equal(refusedField(tagline), 'tagline')
  })

  it('refuses a duplicate nav entry and unknown nav codes', () => {
    const document = valid()
    document.nav = [
      { nav_code: 'book', label: 'Book', is_included: true },
      { nav_code: 'book', label: 'Book again', is_included: true },
    ]
    assert.equal(refusedField(document), 'nav.1.nav_code')
    const unknown = valid() as unknown as { nav: unknown[] }
    unknown.nav = [{ nav_code: 'visit', label: 'Visit', is_included: true }]
    assert.equal(refusedField(unknown), 'nav.0.nav_code')
  })

  it('refuses fields Studio does not own, such as raw css', () => {
    assert.equal(refusedField({ ...valid(), css: 'body{}' }), 'css')
    assert.equal(refusedField({ ...valid(), token: { ...valid().token, font_url: 'x' } }), 'token.font_url')
    assert.equal(refusedField({ ...valid(), template_code: 'custom' }), 'template_code')
  })

  it('refuses a duplicate court in court order', () => {
    const id = '0b7f1c7e-8a3a-4b1e-9d5c-1e2f3a4b5c6d'
    assert.equal(refusedField({ ...valid(), court_order: [id, id] }), 'court_order')
    assert.equal(refusedField({ ...valid(), court_order: ['court-1'] }), 'court_order')
  })

  it('projects nav in saved order, dropping excluded entries and disabled modules', () => {
    const document = valid()
    document.nav = [
      { nav_code: 'shop', label: 'Gear', is_included: true },
      { nav_code: 'book', label: 'Book', is_included: true },
      { nav_code: 'play', label: 'Open play', is_included: false },
      { nav_code: 'program', label: 'Programs', is_included: true },
    ]
    const site = toPublicSite(document, 'sideout', ['portal', 'shop', 'play'], 3)
    assert.deepEqual(site.nav, [
      { nav_code: 'shop', label: 'Gear' },
      { nav_code: 'book', label: 'Book' },
    ])
    assert.equal(site.version_number, 3)
  })

  it('default public site is version 0 named after the venue', () => {
    const site = defaultPublicSite('sideout', 'Sideout Pickleball Club', ['portal'])
    assert.equal(site.version_number, 0)
    assert.equal(site.display_name, 'Sideout Pickleball Club')
    assert.deepEqual(site.nav, [{ nav_code: 'book', label: 'Book' }])
    assert.deepEqual(defaultPublicSite('sideout', 'x', []).nav, [])
  })

  it('orders courts by saved order, new courts after', () => {
    const court = [{ resource_id: 'a' }, { resource_id: 'b' }, { resource_id: 'c' }, { resource_id: 'd' }]
    assert.deepEqual(
      orderCourt(court, ['c', 'a']).map((one) => one.resource_id),
      ['c', 'a', 'b', 'd'],
    )
  })
})
