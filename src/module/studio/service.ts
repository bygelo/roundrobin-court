// studio — reads and writes against the three studio tables.
//
// Every function runs inside the caller's tenant transaction (the kernel opens
// one per request), so publish and rollback are atomic by construction: a
// refusal anywhere rolls the version, the pointer, and the draft back together.

import { DomainError, listEnabledModuleCode, type TenantContext, type Uuid } from '@bygelo/roundrobin-kernel'
import {
  NAV_CODE,
  NAV_MODULE,
  StudioValidationError,
  defaultDocument,
  defaultPublicSite,
  readStoredDocument,
  toPublicSite,
  validateStudioDocument,
  type NavCode,
  type PublicSite,
  type StudioDocument,
} from './schema.ts'

export class StudioNotFoundError extends DomainError {
  constructor(message: string) {
    super(message, 404)
  }
}

export class StudioConflictError extends DomainError {
  constructor(message: string) {
    super(message, 409)
  }
}

export type StudioCourt = { resource_id: Uuid; display_name: string }

export type StudioPublication = { version_number: number; published_at: Date }

export type StudioDraftView = {
  draft: { document: StudioDocument; updated_at: Date }
  court: StudioCourt[]
  nav_module: { nav_code: NavCode; module_code: string; is_enabled: boolean }[]
  publication: StudioPublication | null
  /** True when the draft is exactly what the public site shows. */
  is_live: boolean
}

export type StudioVersionView = {
  version_number: number
  source_code: 'publish' | 'rollback'
  rolled_back_from_version_number: number | null
  published_at: Date
  published_by_display_name: string | null
  template_code: string | null
  display_name: string | null
  is_current: boolean
}

/**
 * A jsonb parameter. Pass the object itself: a JSON.stringify'd string reaches
 * PostgreSQL as a jsonb *string* ("{...}"), not a jsonb object.
 */
function asJsonb(document: StudioDocument): never {
  return document as never
}

function parseJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value
}

async function readDisplayName(tenant: TenantContext): Promise<string> {
  const [row] = await tenant.query<{ display_name: string }[]>`
    SELECT display_name FROM organization WHERE organization_id = ${tenant.organization_id}`
  return row?.display_name ?? 'Your venue'
}

async function listCourt(tenant: TenantContext): Promise<(StudioCourt & { sort_order: number })[]> {
  return tenant.query<(StudioCourt & { sort_order: number })[]>`
    SELECT r.resource_id, r.display_name, r.sort_order
    FROM resource r
    JOIN site s ON s.site_id = r.site_id
    WHERE s.organization_id = ${tenant.organization_id}
      AND r.deleted_at IS NULL
    ORDER BY r.sort_order, r.display_name`
}

/** Courts in the saved order; courts added since the order was saved follow in venue order. */
export function orderCourt<T extends { resource_id: string }>(court: T[], court_order: string[]): T[] {
  const position = new Map(court_order.map((resource_id, index) => [resource_id, index]))
  return court
    .map((one, index) => ({ one, index }))
    .sort((left, right) => {
      const left_position = position.get(left.one.resource_id) ?? court_order.length + left.index
      const right_position = position.get(right.one.resource_id) ?? court_order.length + right.index
      return left_position - right_position
    })
    .map((entry) => entry.one)
}

async function readPublication(
  tenant: TenantContext,
): Promise<(StudioPublication & { document: unknown; studio_version_id: Uuid }) | undefined> {
  const [row] = await tenant.query<
    { version_number: number; published_at: Date; document: unknown; studio_version_id: Uuid }[]
  >`
    SELECT v.version_number, v.published_at, v.document, v.studio_version_id
    FROM studio_publication p
    JOIN studio_version v ON v.organization_id = p.organization_id AND v.studio_version_id = p.studio_version_id
    WHERE p.organization_id = ${tenant.organization_id}`
  return row ? { ...row, document: parseJson(row.document) } : undefined
}

/** The draft row, created from the published version (or the default) on first read. */
async function ensureDraft(
  tenant: TenantContext,
  option: { is_locked?: boolean } = {},
): Promise<{ document: unknown; updated_at: Date }> {
  const select = async () => {
    const [row] = option.is_locked
      ? await tenant.query<{ document: unknown; updated_at: Date }[]>`
          SELECT document, updated_at FROM studio_draft
          WHERE organization_id = ${tenant.organization_id} FOR UPDATE`
      : await tenant.query<{ document: unknown; updated_at: Date }[]>`
          SELECT document, updated_at FROM studio_draft
          WHERE organization_id = ${tenant.organization_id}`
    return row ? { ...row, document: parseJson(row.document) } : undefined
  }
  const existing = await select()
  if (existing) return existing

  const display_name = await readDisplayName(tenant)
  const publication = await readPublication(tenant)
  const document = publication ? readStoredDocument(publication.document, display_name) : defaultDocument(display_name)
  await tenant.query`
    INSERT INTO studio_draft (organization_id, document)
    VALUES (${tenant.organization_id}, ${asJsonb(document)}::jsonb)
    ON CONFLICT (organization_id) DO NOTHING`
  const created = await select()
  if (!created) throw new Error('studio draft could not be created')
  return created
}

export async function readDraftView(tenant: TenantContext): Promise<StudioDraftView> {
  const display_name = await readDisplayName(tenant)
  const draft = await ensureDraft(tenant)
  const document = readStoredDocument(draft.document, display_name)
  const [court, enabled, publication] = [
    await listCourt(tenant),
    await listEnabledModuleCode(tenant),
    await readPublication(tenant),
  ]
  const [same] = publication
    ? await tenant.query<{ is_same: boolean }[]>`
        SELECT (d.document = v.document) AS is_same
        FROM studio_draft d
        JOIN studio_version v ON v.organization_id = d.organization_id AND v.studio_version_id = ${publication.studio_version_id}
        WHERE d.organization_id = ${tenant.organization_id}`
    : []
  return {
    draft: { document, updated_at: draft.updated_at },
    court: orderCourt(court, document.court_order).map(({ resource_id, display_name: name }) => ({
      resource_id,
      display_name: name,
    })),
    nav_module: NAV_CODE.map((nav_code) => ({
      nav_code,
      module_code: NAV_MODULE[nav_code],
      is_enabled: enabled.includes(NAV_MODULE[nav_code]),
    })),
    publication: publication ? { version_number: publication.version_number, published_at: publication.published_at } : null,
    is_live: same?.is_same ?? false,
  }
}

/** Validate and store the draft. Throws StudioValidationError with the offending field. */
export async function saveDraft(tenant: TenantContext, input: unknown, actor_id: Uuid | null): Promise<StudioDocument> {
  const document = validateStudioDocument(input)
  if (document.court_order.length > 0) {
    const known = new Set((await listCourt(tenant)).map((one) => one.resource_id))
    if (document.court_order.some((resource_id) => !known.has(resource_id))) {
      throw new StudioValidationError('court_order', 'Court order includes a court this venue does not have.')
    }
  }
  await ensureDraft(tenant)
  await tenant.query`
    UPDATE studio_draft
    SET document = ${asJsonb(document)}::jsonb, updated_by_actor_id = ${actor_id}
    WHERE organization_id = ${tenant.organization_id}`
  return document
}

async function appendVersion(
  tenant: TenantContext,
  input: {
    document: StudioDocument
    source_code: 'publish' | 'rollback'
    rolled_back_from_version_number: number | null
    actor_id: Uuid | null
  },
): Promise<StudioPublication> {
  const [next] = await tenant.query<{ version_number: number }[]>`
    SELECT coalesce(max(version_number), 0) + 1 AS version_number
    FROM studio_version WHERE organization_id = ${tenant.organization_id}`
  const [version] = await tenant.query<{ studio_version_id: Uuid; version_number: number; published_at: Date }[]>`
    INSERT INTO studio_version (organization_id, version_number, document, source_code,
                                rolled_back_from_version_number, published_by_actor_id)
    VALUES (${tenant.organization_id}, ${next!.version_number}, ${asJsonb(input.document)}::jsonb,
            ${input.source_code}, ${input.rolled_back_from_version_number}, ${input.actor_id})
    RETURNING studio_version_id, version_number, published_at`
  await tenant.query`
    INSERT INTO studio_publication (organization_id, studio_version_id)
    VALUES (${tenant.organization_id}, ${version!.studio_version_id})
    ON CONFLICT (organization_id) DO UPDATE SET studio_version_id = EXCLUDED.studio_version_id`
  return { version_number: version!.version_number, published_at: version!.published_at }
}

/**
 * Publish the draft: validate → append version → move pointer, in the caller's
 * transaction. When `document` is given it is saved first, in the same
 * transaction, so "save and publish" can never half-happen.
 */
export async function publishDraft(
  tenant: TenantContext,
  actor_id: Uuid | null,
  document?: unknown,
): Promise<StudioPublication> {
  // Lock the draft row first: concurrent publishes for one venue queue here
  // instead of racing for the same version number.
  await ensureDraft(tenant, { is_locked: true })
  if (document !== undefined) await saveDraft(tenant, document, actor_id)
  const draft = await ensureDraft(tenant, { is_locked: true })
  const valid = validateStudioDocument(draft.document)
  return appendVersion(tenant, {
    document: valid,
    source_code: 'publish',
    rolled_back_from_version_number: null,
    actor_id,
  })
}

/** Append a new version copying an older one's document, make it live, and reset the draft to it. */
export async function rollbackVersion(
  tenant: TenantContext,
  actor_id: Uuid | null,
  version_number: number,
): Promise<StudioPublication> {
  await ensureDraft(tenant, { is_locked: true })
  const [target] = await tenant.query<{ document: unknown; studio_version_id: Uuid }[]>`
    SELECT document, studio_version_id FROM studio_version
    WHERE organization_id = ${tenant.organization_id} AND version_number = ${version_number}`
  if (!target) throw new StudioNotFoundError(`There is no version ${version_number} to roll back to.`)
  const publication = await readPublication(tenant)
  if (publication?.studio_version_id === target.studio_version_id) {
    throw new StudioConflictError(`Version ${version_number} is already live.`)
  }
  const document = readStoredDocument(parseJson(target.document), await readDisplayName(tenant))
  const result = await appendVersion(tenant, {
    document,
    source_code: 'rollback',
    rolled_back_from_version_number: version_number,
    actor_id,
  })
  await tenant.query`
    UPDATE studio_draft
    SET document = ${asJsonb(document)}::jsonb, updated_by_actor_id = ${actor_id}
    WHERE organization_id = ${tenant.organization_id}`
  return result
}

export async function listVersion(tenant: TenantContext): Promise<StudioVersionView[]> {
  return tenant.query<StudioVersionView[]>`
    SELECT v.version_number, v.source_code, v.rolled_back_from_version_number, v.published_at,
           a.display_name AS published_by_display_name,
           v.document->>'template_code' AS template_code,
           v.document->>'display_name' AS display_name,
           coalesce(p.studio_version_id = v.studio_version_id, false) AS is_current
    FROM studio_version v
    LEFT JOIN actor a ON a.actor_id = v.published_by_actor_id
    LEFT JOIN studio_publication p ON p.organization_id = v.organization_id
    WHERE v.organization_id = ${tenant.organization_id}
    ORDER BY v.version_number DESC`
}

/** The PublicSite a visitor sees: the published version, or the default when Studio is off or unpublished. */
export async function readPublicSite(tenant: TenantContext, organization_code: string): Promise<PublicSite> {
  const enabled = await listEnabledModuleCode(tenant)
  const display_name = await readDisplayName(tenant)
  const publication = enabled.includes('studio') ? await readPublication(tenant) : undefined
  if (!publication) return defaultPublicSite(organization_code, display_name, enabled)
  return toPublicSite(
    readStoredDocument(publication.document, display_name),
    organization_code,
    enabled,
    publication.version_number,
  )
}

/** The draft rendered as a PublicSite, for the operator's preview. Never served publicly. */
export async function readPreviewSite(tenant: TenantContext, organization_code: string): Promise<PublicSite> {
  const display_name = await readDisplayName(tenant)
  const draft = await ensureDraft(tenant)
  const enabled = await listEnabledModuleCode(tenant)
  const publication = await readPublication(tenant)
  return toPublicSite(
    readStoredDocument(draft.document, display_name),
    organization_code,
    enabled,
    publication?.version_number ?? 0,
  )
}

/** Courts in the published order — venue order when Studio is off or unpublished. */
export async function readPublicCourtOrder(tenant: TenantContext): Promise<StudioCourt[]> {
  const enabled = await listEnabledModuleCode(tenant)
  const publication = enabled.includes('studio') ? await readPublication(tenant) : undefined
  const court_order = publication ? readStoredDocument(publication.document, '').court_order : []
  return orderCourt(await listCourt(tenant), court_order).map(({ resource_id, display_name }) => ({
    resource_id,
    display_name,
  }))
}
