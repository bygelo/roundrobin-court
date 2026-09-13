// studio — R18: a branded public portal that moves in one version.

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { disableModule, enableModule, type Uuid } from '@bygelo/roundrobin-kernel'
import { COURT_DECLARATION } from '../src/app.ts'
import { defaultDocument, type PublicSite, type StudioDocument } from '../src/module/studio/schema.ts'
import { publishDraft } from '../src/module/studio/service.ts'
import { TEST_DATABASE_URL, createTestVenue, type TestVenue } from './helper.ts'

type DraftBody = {
  draft: { document: StudioDocument }
  court: { resource_id: string; display_name: string }[]
  publication: { version_number: number } | null
  is_live: boolean
}

async function addCourt(venue: TestVenue, count: number): Promise<Uuid[]> {
  return venue.asTenant(async (tenant) => {
    const [site] = await tenant.query<{ site_id: Uuid }[]>`
      INSERT INTO site (organization_id, site_code, display_name)
      VALUES (${venue.organization_id}, 'main', 'Main Venue') RETURNING site_id`
    const id: Uuid[] = []
    for (let index = 1; index <= count; index += 1) {
      const [resource] = await tenant.query<{ resource_id: Uuid }[]>`
        INSERT INTO resource (organization_id, site_id, resource_code, display_name, sort_order)
        VALUES (${venue.organization_id}, ${site!.site_id}, ${`court-${index}`}, ${`Court ${index}`}, ${index})
        RETURNING resource_id`
      id.push(resource!.resource_id)
    }
    return id
  })
}

async function json<T>(response: Response, status: number): Promise<T> {
  const text = await response.text()
  assert.equal(response.status, status, text)
  return JSON.parse(text) as T
}

function branded(document: StudioDocument, hero_title: string): StudioDocument {
  return {
    ...document,
    template_code: 'court-dark',
    display_name: 'Sideout Pickleball Club',
    token: { accent: '#123fbd', action: '#d32522', heading_font: 'Inter', radius: 'soft' },
    content: { ...document.content, hero_title },
  }
}

async function readSite(venue: TestVenue): Promise<PublicSite> {
  return (await json<{ site: PublicSite }>(await venue.publicRequest(`/public/${venue.organization_code}/site`), 200)).site
}

async function countVersion(venue: TestVenue): Promise<number> {
  return venue.asTenant(async (tenant) => {
    const [row] = await tenant.query<{ count: number }[]>`
      SELECT count(*)::int AS count FROM studio_version WHERE organization_id = ${venue.organization_id}`
    return row!.count
  })
}

describe('studio: branded public portal in one version', { skip: !TEST_DATABASE_URL }, () => {
  let venue: TestVenue
  let other: TestVenue
  let court: Uuid[]

  before(async () => {
    venue = await createTestVenue('studio')
    other = await createTestVenue('studio-other')
    court = await addCourt(venue, 3)
  })

  after(async () => {
    await venue?.close()
    await other?.close()
  })

  it('answers the default site, version 0, before anything is published', async () => {
    const site = await readSite(venue)
    assert.equal(site.version_number, 0)
    assert.equal(site.display_name, 'Test Pickleball Club')
    assert.equal(site.organization_code, venue.organization_code)
    assert.deepEqual(site.nav, [{ nav_code: 'book', label: 'Book' }])
  })

  it('creates a draft on first read with the venue courts listed', async () => {
    const body = await json<DraftBody>(await venue.request('/api/v1/studio/draft'), 200)
    assert.equal(body.publication, null)
    assert.equal(body.draft.document.display_name, 'Test Pickleball Club')
    assert.deepEqual(
      body.court.map((one) => one.display_name),
      ['Court 1', 'Court 2', 'Court 3'],
    )
  })

  it('refuses invalid drafts with the field and a sentence', async () => {
    const base = defaultDocument('Test Pickleball Club')
    const case_list: [string, unknown][] = [
      ['token.accent', { ...base, token: { ...base.token, accent: 'blue' } }],
      ['token.action', { ...base, token: { ...base.token, action: '#f5f5f5' } }],
      ['content.hero_body', { ...base, content: { ...base.content, hero_body: 'x'.repeat(241) } }],
      ['content.hero_title', { ...base, content: { ...base.content, hero_title: '<img src=x onerror=alert(1)>' } }],
      [
        'nav.1.nav_code',
        {
          ...base,
          nav: [
            { nav_code: 'shop', label: 'Shop', is_included: true },
            { nav_code: 'shop', label: 'Gear', is_included: true },
          ],
        },
      ],
      ['court_order', { ...base, court_order: ['7c1d8c3e-2b1a-4f7e-9a6b-000000000000'] }],
    ]
    for (const [field, document] of case_list) {
      const response = await venue.request('/api/v1/studio/draft', {
        method: 'PUT',
        body: JSON.stringify({ document }),
      })
      const body = await json<{ error: string; field: string }>(response, 400)
      assert.equal(body.field, field)
      assert.match(body.error, /\.$/)
    }
  })

  it('never shows an unpublished draft to a public visitor', async () => {
    const current = await json<DraftBody>(await venue.request('/api/v1/studio/draft'), 200)
    const document = branded(current.draft.document, 'Secret draft headline')
    await json(await venue.request('/api/v1/studio/draft', { method: 'PUT', body: JSON.stringify({ document }) }), 200)

    const site = await readSite(venue)
    assert.notEqual(site.content.hero_title, 'Secret draft headline')
    assert.equal(site.version_number, 0)

    const preview = await json<{ site: PublicSite }>(await venue.request('/api/v1/studio/preview'), 200)
    assert.equal(preview.site.content.hero_title, 'Secret draft headline')
  })

  it('publishes atomically and increments the version', async () => {
    const current = await json<DraftBody>(await venue.request('/api/v1/studio/draft'), 200)
    const document = { ...branded(current.draft.document, 'Book a pickleball court tonight'), court_order: [court[2]!, court[0]!] }

    const first = await json<{ version_number: number }>(
      await venue.request('/api/v1/studio/publish', { method: 'POST', body: JSON.stringify({ document }) }),
      201,
    )
    assert.equal(first.version_number, 1)
    let site = await readSite(venue)
    assert.equal(site.version_number, 1)
    assert.equal(site.template_code, 'court-dark')
    assert.equal(site.content.hero_title, 'Book a pickleball court tonight')

    const order = await json<{ court: { display_name: string }[] }>(
      await venue.publicRequest(`/public/${venue.organization_code}/studio/court-order`),
      200,
    )
    assert.deepEqual(
      order.court.map((one) => one.display_name),
      ['Court 3', 'Court 1', 'Court 2'],
    )

    const draft = await json<DraftBody>(await venue.request('/api/v1/studio/draft'), 200)
    assert.equal(draft.is_live, true)

    // An invalid document on publish changes nothing.
    const before_count = await countVersion(venue)
    const bad = { ...document, token: { ...document.token, accent: '#eeeeee' } }
    const refused = await json<{ field: string }>(
      await venue.request('/api/v1/studio/publish', { method: 'POST', body: JSON.stringify({ document: bad }) }),
      400,
    )
    assert.equal(refused.field, 'token.accent')
    assert.equal(await countVersion(venue), before_count)

    // A crash after the version row is written takes the version AND the pointer with it.
    await assert.rejects(
      venue.asTenant(async (tenant) => {
        await publishDraft(tenant, null)
        throw new Error('simulated crash mid-publish')
      }),
      /simulated crash/,
    )
    assert.equal(await countVersion(venue), before_count)
    site = await readSite(venue)
    assert.equal(site.version_number, 1)

    const second = await json<{ version_number: number }>(
      await venue.request('/api/v1/studio/publish', {
        method: 'POST',
        body: JSON.stringify({ document: branded(document, 'Second headline') }),
      }),
      201,
    )
    assert.equal(second.version_number, 2)
    assert.equal((await readSite(venue)).content.hero_title, 'Second headline')
  })

  it('serialises concurrent publishes into consecutive versions', async () => {
    const before_count = await countVersion(venue)
    const response = await Promise.all(
      Array.from({ length: 5 }, () => venue.request('/api/v1/studio/publish', { method: 'POST', body: '{}' })),
    )
    const number = []
    for (const one of response) number.push((await json<{ version_number: number }>(one, 201)).version_number)
    assert.deepEqual(
      number.sort((left, right) => left - right),
      [1, 2, 3, 4, 5].map((step) => before_count + step),
    )
    assert.equal((await readSite(venue)).version_number, before_count + 5)
  })

  it('rolls back by appending a new version with the old document', async () => {
    const history = await json<{ version: { version_number: number; is_current: boolean }[] }>(
      await venue.request('/api/v1/studio/version'),
      200,
    )
    const latest = history.version[0]!.version_number
    assert.equal(history.version[0]!.is_current, true)

    const rolled = await json<{ version_number: number }>(
      await venue.request('/api/v1/studio/version/1/rollback', { method: 'POST' }),
      201,
    )
    assert.equal(rolled.version_number, latest + 1)

    const site = await readSite(venue)
    assert.equal(site.version_number, latest + 1)
    assert.equal(site.content.hero_title, 'Book a pickleball court tonight')

    const after_history = await json<{
      version: { version_number: number; source_code: string; rolled_back_from_version_number: number | null }[]
    }>(await venue.request('/api/v1/studio/version'), 200)
    assert.equal(after_history.version.length, latest + 1)
    assert.equal(after_history.version[0]!.source_code, 'rollback')
    assert.equal(after_history.version[0]!.rolled_back_from_version_number, 1)

    const draft = await json<DraftBody>(await venue.request('/api/v1/studio/draft'), 200)
    assert.equal(draft.draft.document.content.hero_title, 'Book a pickleball court tonight')

    await json(await venue.request(`/api/v1/studio/version/${latest + 1}/rollback`, { method: 'POST' }), 409)
    await json(await venue.request('/api/v1/studio/version/999/rollback', { method: 'POST' }), 404)
  })

  it('refuses UPDATE and DELETE on a published version at the database', async () => {
    await assert.rejects(
      venue.asTenant((tenant) => tenant.query`
        UPDATE studio_version SET document = '{}'::jsonb WHERE organization_id = ${venue.organization_id}`),
      /append-only table studio_version refuses UPDATE/,
    )
    await assert.rejects(
      venue.asTenant((tenant) => tenant.query`
        DELETE FROM studio_version WHERE organization_id = ${venue.organization_id}`),
      /append-only table studio_version refuses DELETE/,
    )
  })

  it('drops a nav entry when its module is disabled, and restores it when enabled', async () => {
    const site = await readSite(venue)
    assert.ok(site.nav.some((one) => one.nav_code === 'shop'))
    await venue.asTenant((tenant) => disableModule(tenant, 'shop', COURT_DECLARATION))
    try {
      const without = await readSite(venue)
      assert.ok(!without.nav.some((one) => one.nav_code === 'shop'))
      assert.equal(without.nav.length, site.nav.length - 1)
      const draft = await json<{ nav_module: { nav_code: string; is_enabled: boolean }[] }>(
        await venue.request('/api/v1/studio/draft'),
        200,
      )
      assert.equal(draft.nav_module.find((one) => one.nav_code === 'shop')?.is_enabled, false)
    } finally {
      await venue.asTenant((tenant) => enableModule(tenant, 'shop', COURT_DECLARATION))
    }
    assert.ok((await readSite(venue)).nav.some((one) => one.nav_code === 'shop'))
  })

  it('still answers the default public site when studio is disabled, and 404s its API', async () => {
    await venue.asTenant((tenant) => disableModule(tenant, 'studio', COURT_DECLARATION))
    try {
      const site = await readSite(venue)
      assert.equal(site.version_number, 0)
      assert.equal(site.template_code, 'club')
      await json(await venue.request('/api/v1/studio/draft'), 404)
      const order = await json<{ court: { display_name: string }[] }>(
        await venue.publicRequest(`/public/${venue.organization_code}/studio/court-order`),
        200,
      )
      assert.deepEqual(
        order.court.map((one) => one.display_name),
        ['Court 1', 'Court 2', 'Court 3'],
      )
    } finally {
      await venue.asTenant((tenant) => enableModule(tenant, 'studio', COURT_DECLARATION))
    }
    assert.ok((await readSite(venue)).version_number > 0)
  })

  it('answers 404 for an unknown organization', async () => {
    await json(await venue.publicRequest('/public/no-such-venue-anywhere/site'), 404)
    await json(await venue.publicRequest('/public/no-such-venue-anywhere/studio/court-order'), 404)
  })

  it('keeps tenants isolated', async () => {
    const own = await readSite(venue)
    assert.ok(own.version_number > 0)

    const other_site = await readSite(other)
    assert.equal(other_site.version_number, 0)
    assert.equal(other_site.organization_code, other.organization_code)

    const other_history = await json<{ version: unknown[] }>(await other.request('/api/v1/studio/version'), 200)
    assert.equal(other_history.version.length, 0)
    await json(await other.request('/api/v1/studio/version/1/rollback', { method: 'POST' }), 404)

    // A venue cannot put another venue's court into its order.
    const draft = await json<DraftBody>(await other.request('/api/v1/studio/draft'), 200)
    const refused = await json<{ field: string }>(
      await other.request('/api/v1/studio/draft', {
        method: 'PUT',
        body: JSON.stringify({ document: { ...draft.draft.document, court_order: [court[0]!] } }),
      }),
      400,
    )
    assert.equal(refused.field, 'court_order')

    // Publishing in one venue never moves the other.
    await json(await other.request('/api/v1/studio/publish', { method: 'POST', body: '{}' }), 201)
    assert.equal((await readSite(other)).version_number, 1)
    assert.equal((await readSite(venue)).version_number, own.version_number)
  })
})
