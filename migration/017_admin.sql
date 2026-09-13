-- court 017 — admin: the player-facing intake for privacy requests (R24).
--
-- Modules (R03), staff (R04), and API keys (R19) need no table of their own:
-- they are screens and routes over the kernel's module, actor, role, and
-- api_key tables.
--
-- The consent pack records a data-subject request only at the moment it is
-- executed (requestAccess / requestErasure complete in one call). A player who
-- asks from the public site is not yet verified and must not trigger an
-- erasure by themselves, so the request waits here until staff fulfil it; the
-- fulfilment then writes the consent pack's auditable row and links it back.

CREATE TABLE admin_privacy_request (
  admin_privacy_request_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid        NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  request_kind             text        NOT NULL,
  status                   text        NOT NULL DEFAULT 'received',
  -- sha256 of the status token shown to the player once. The token is never stored.
  status_token_hash        text        NOT NULL,
  booking_code             text        NOT NULL,
  -- Log-safe form of the address the player typed (p•••@example.com). The raw
  -- address is never stored: a verified request reaches the party instead.
  email_mask               text        NOT NULL,
  -- true when the email matched the party on that booking. An unverified row
  -- is kept so the public response is identical either way.
  is_verified              boolean     NOT NULL DEFAULT false,
  party_id                 uuid,
  data_subject_request_id  uuid,
  fulfilled_by_actor_id    uuid,
  -- For access: the player's record bundle, downloadable by staff. Cleared
  -- when the request is closed; see the retention note on the table.
  access_bundle            jsonb,
  -- Plain sentence stating what was done and what was retained, and why.
  resolution_note          text,
  completed_at             timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  deleted_at               timestamptz,
  CONSTRAINT admin_privacy_request_kind_known CHECK (request_kind IN ('access', 'erasure')),
  CONSTRAINT admin_privacy_request_status_known CHECK (status IN ('received', 'completed', 'closed')),
  CONSTRAINT admin_privacy_request_token_hash_shape CHECK (status_token_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT admin_privacy_request_booking_code_present CHECK (length(btrim(booking_code)) > 0),
  -- A party is attached only through a verified match.
  CONSTRAINT admin_privacy_request_party_needs_verified CHECK (party_id IS NULL OR is_verified),
  -- Only a verified request can be fulfilled; a finished request has a time and a sentence.
  CONSTRAINT admin_privacy_request_completed_is_verified CHECK (status <> 'completed' OR is_verified),
  CONSTRAINT admin_privacy_request_finished_has_time CHECK ((status = 'received') = (completed_at IS NULL)),
  CONSTRAINT admin_privacy_request_finished_has_note CHECK (status = 'received' OR resolution_note IS NOT NULL),
  CONSTRAINT admin_privacy_request_bundle_is_access CHECK (access_bundle IS NULL OR request_kind = 'access'),
  CONSTRAINT admin_privacy_request_token_unique UNIQUE (status_token_hash),
  CONSTRAINT admin_privacy_request_party_same_tenant
    FOREIGN KEY (organization_id, party_id)
    REFERENCES party(organization_id, party_id) ON DELETE SET NULL (party_id),
  CONSTRAINT admin_privacy_request_subject_request_same_tenant
    FOREIGN KEY (organization_id, data_subject_request_id)
    REFERENCES data_subject_request(organization_id, data_subject_request_id) ON DELETE SET NULL (data_subject_request_id),
  CONSTRAINT admin_privacy_request_actor_same_tenant
    FOREIGN KEY (organization_id, fulfilled_by_actor_id)
    REFERENCES actor(organization_id, actor_id) ON DELETE SET NULL (fulfilled_by_actor_id)
);

COMMENT ON TABLE admin_privacy_request IS
  'A player''s access or erasure request from the public privacy page, held until staff fulfil it through the consent pack. Exists because the consent pack only records a request at execution time, and an unverified public request must never execute by itself. RETENTION: access_bundle is personal data and is cleared when the request is closed or 30 day after completion by the admin retention step; the row itself is kept as the demand trail.';

COMMENT ON COLUMN admin_privacy_request.status_token_hash IS
  'sha256 of the random status token the player holds. Only the hash is stored; the status route reveals status and a sentence, never personal data.';

CREATE INDEX idx_admin_privacy_request_organization
  ON admin_privacy_request(organization_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_admin_privacy_request_party ON admin_privacy_request(organization_id, party_id);
CREATE INDEX idx_admin_privacy_request_subject_request ON admin_privacy_request(organization_id, data_subject_request_id);
CREATE INDEX idx_admin_privacy_request_actor ON admin_privacy_request(organization_id, fulfilled_by_actor_id);

CREATE TRIGGER admin_privacy_request_updated_at BEFORE UPDATE ON admin_privacy_request
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE admin_privacy_request ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_privacy_request_tenant_isolation ON admin_privacy_request
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());
