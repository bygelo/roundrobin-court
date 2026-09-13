-- court 009 — studio: R18 a branded public portal in one version.
--
-- Three tables, one rule: a public visitor only ever sees a published version,
-- and moving from one version to another is a single transaction.
--
--   studio_draft        the one editable document per venue (never public)
--   studio_version      immutable published snapshots, numbered 1, 2, 3 …
--   studio_publication  the per-venue pointer to the version that is live
--
-- Publish = validate the draft, INSERT a version, move the pointer — one
-- transaction. Rollback = INSERT a new version copying an older document and
-- move the pointer; history is never rewritten.

-- ---- studio_draft ------------------------------------------------------------

CREATE TABLE studio_draft (
  studio_draft_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid        NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  -- Validated by src/module/studio/schema.ts before every write: template,
  -- brand tokens, content slots, nav order, court order. Never raw HTML or CSS.
  document             jsonb       NOT NULL,
  updated_by_actor_id  uuid        REFERENCES actor(actor_id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT studio_draft_one_per_organization UNIQUE (organization_id),
  CONSTRAINT studio_draft_document_object CHECK (jsonb_typeof(document) = 'object')
);

COMMENT ON TABLE studio_draft IS
  'The venue''s work-in-progress public site. One row per organization, edited freely by staff, and never read by a public route — only a published studio_version reaches a visitor. No deleted_at: a draft is reset, not deleted.';

CREATE INDEX idx_studio_draft_updated_by_actor ON studio_draft(updated_by_actor_id);

CREATE TRIGGER studio_draft_updated_at BEFORE UPDATE ON studio_draft
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE studio_draft ENABLE ROW LEVEL SECURITY;
CREATE POLICY studio_draft_tenant_isolation ON studio_draft
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());

-- ---- studio_version ----------------------------------------------------------

CREATE TABLE studio_version (
  studio_version_id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id                 uuid        NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  version_number                  integer     NOT NULL,
  document                        jsonb       NOT NULL,
  -- 'publish' copies the draft; 'rollback' copies an older version's document.
  source_code                     text        NOT NULL,
  rolled_back_from_version_number integer,
  -- NO ACTION, not SET NULL: a version is immutable, so the database may not
  -- rewrite it when an actor goes. Actors are soft-deleted in practice.
  published_by_actor_id           uuid        REFERENCES actor(actor_id) ON DELETE NO ACTION,
  published_at                    timestamptz NOT NULL DEFAULT now(),
  created_at                      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT studio_version_number_unique UNIQUE (organization_id, version_number),
  CONSTRAINT studio_version_tenant_key UNIQUE (organization_id, studio_version_id),
  CONSTRAINT studio_version_number_positive CHECK (version_number > 0),
  CONSTRAINT studio_version_document_object CHECK (jsonb_typeof(document) = 'object'),
  CONSTRAINT studio_version_source_code CHECK (source_code IN ('publish', 'rollback')),
  CONSTRAINT studio_version_rollback_source CHECK (
    (source_code = 'rollback') = (rolled_back_from_version_number IS NOT NULL)
  ),
  CONSTRAINT studio_version_rollback_earlier CHECK (
    rolled_back_from_version_number IS NULL
    OR (rolled_back_from_version_number > 0 AND rolled_back_from_version_number < version_number)
  )
);

COMMENT ON TABLE studio_version IS
  'Immutable, append-only snapshots of the public site, numbered per organization without gaps. A rollback appends a new version copying an older document, so the history of what visitors saw is never rewritten. UPDATE is refused by trigger; DELETE only happens by cascade when the organization itself is removed. No deleted_at or updated_at by design.';

CREATE INDEX idx_studio_version_published_by_actor ON studio_version(published_by_actor_id);

-- Gapless numbering, enforced by the database rather than trusted to the
-- service: the next version is always max + 1. Two racing publishes compute the
-- same number and the unique constraint refuses one of them.
CREATE OR REPLACE FUNCTION studio_version_assert_next_number()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected integer;
BEGIN
  SELECT coalesce(max(version_number), 0) + 1 INTO expected
  FROM studio_version WHERE organization_id = NEW.organization_id;
  IF NEW.version_number <> expected THEN
    RAISE EXCEPTION 'studio_version % must be numbered %, got %', NEW.organization_id, expected, NEW.version_number
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER studio_version_next_number BEFORE INSERT ON studio_version
  FOR EACH ROW EXECUTE FUNCTION studio_version_assert_next_number();

-- Immutable at the database, for every role including a superuser. The single
-- exception is a DELETE fired from inside another trigger — the ON DELETE
-- CASCADE of removing the whole organization — which pg_trigger_depth() > 1
-- identifies. A direct UPDATE or DELETE by any role is refused.
CREATE OR REPLACE FUNCTION studio_version_refuse_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'append-only table studio_version refuses %', TG_OP
    USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER studio_version_refuse_change BEFORE UPDATE OR DELETE ON studio_version
  FOR EACH ROW EXECUTE FUNCTION studio_version_refuse_change();

ALTER TABLE studio_version ENABLE ROW LEVEL SECURITY;
CREATE POLICY studio_version_tenant_isolation ON studio_version
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());

-- ---- studio_publication ------------------------------------------------------

CREATE TABLE studio_publication (
  studio_publication_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        uuid        NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  studio_version_id      uuid        NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT studio_publication_one_per_organization UNIQUE (organization_id),
  -- Composite key: the pointer can only reference a version of its own tenant.
  CONSTRAINT studio_publication_version_fkey FOREIGN KEY (organization_id, studio_version_id)
    REFERENCES studio_version(organization_id, studio_version_id) ON DELETE CASCADE
);

COMMENT ON TABLE studio_publication IS
  'Which studio_version the public portal and every display read right now. One row per organization; publish and rollback move it in the same transaction that appends the version, so a visitor never sees a half-published site. No deleted_at: unpublishing is not a feature.';

CREATE INDEX idx_studio_publication_version ON studio_publication(organization_id, studio_version_id);

CREATE TRIGGER studio_publication_updated_at BEFORE UPDATE ON studio_publication
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE studio_publication ENABLE ROW LEVEL SECURITY;
CREATE POLICY studio_publication_tenant_isolation ON studio_publication
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());
