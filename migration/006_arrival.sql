-- court 006 — arrival: R11 arrival, waiver, and check-in.
--
-- Three facts a front desk needs to trust: which waiver text is current, who
-- accepted which version and with what evidence, and who has arrived. A check-in
-- is recorded once per subject, so a double tap or a replayed scan is a no-op
-- rather than a second arrival.

CREATE TABLE arrival_waiver_version (
  arrival_waiver_version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           uuid        NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  version_number            integer     NOT NULL,
  title                     text        NOT NULL,
  body                      text        NOT NULL,
  published_at              timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  deleted_at                timestamptz,
  UNIQUE (organization_id, version_number),
  CONSTRAINT arrival_waiver_version_positive CHECK (version_number > 0),
  CONSTRAINT arrival_waiver_body_present CHECK (length(btrim(body)) > 0)
);

COMMENT ON TABLE arrival_waiver_version IS
  'A numbered waiver text. The current waiver is the highest published version; publishing a newer one makes every acceptance of an older version outdated without rewriting it.';

CREATE INDEX idx_arrival_waiver_version_published
  ON arrival_waiver_version(organization_id, version_number DESC)
  WHERE published_at IS NOT NULL AND deleted_at IS NULL;

CREATE TRIGGER arrival_waiver_version_updated_at BEFORE UPDATE ON arrival_waiver_version
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION arrival_waiver_version_freeze() RETURNS trigger AS $$
BEGIN
  IF OLD.published_at IS NOT NULL
     AND (NEW.body IS DISTINCT FROM OLD.body OR NEW.title IS DISTINCT FROM OLD.title
          OR NEW.version_number IS DISTINCT FROM OLD.version_number
          OR NEW.published_at IS DISTINCT FROM OLD.published_at) THEN
    RAISE EXCEPTION 'a published waiver version cannot be changed; publish a new version'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION arrival_waiver_version_freeze() IS
  'The text a person accepted must be the text still on file. Published versions are immutable.';

CREATE TRIGGER arrival_waiver_version_freeze_check
  BEFORE UPDATE ON arrival_waiver_version
  FOR EACH ROW EXECUTE FUNCTION arrival_waiver_version_freeze();

ALTER TABLE arrival_waiver_version ENABLE ROW LEVEL SECURITY;
CREATE POLICY arrival_waiver_version_tenant_isolation ON arrival_waiver_version
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());


CREATE TABLE arrival_waiver_acceptance (
  arrival_waiver_acceptance_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id              uuid        NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  party_id                     uuid        NOT NULL REFERENCES party(party_id) ON DELETE CASCADE,
  arrival_waiver_version_id    uuid        NOT NULL REFERENCES arrival_waiver_version(arrival_waiver_version_id) ON DELETE RESTRICT,
  accepted_at                  timestamptz NOT NULL DEFAULT now(),
  user_agent                   text,
  -- sha256(organization_id || ip). Evidence that can be matched, never read back.
  ip_hash                      text,
  channel_code                 text        NOT NULL,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (party_id, arrival_waiver_version_id),
  CONSTRAINT arrival_waiver_acceptance_channel_known CHECK (channel_code IN ('registration', 'self', 'desk'))
);

COMMENT ON TABLE arrival_waiver_acceptance IS
  'Who accepted which waiver version, when, and the evidence (user agent, hashed IP, channel). Append-only; one row per party per version.';

CREATE INDEX idx_arrival_waiver_acceptance_organization ON arrival_waiver_acceptance(organization_id);
CREATE INDEX idx_arrival_waiver_acceptance_version ON arrival_waiver_acceptance(arrival_waiver_version_id);

ALTER TABLE arrival_waiver_acceptance ENABLE ROW LEVEL SECURITY;
CREATE POLICY arrival_waiver_acceptance_tenant_isolation ON arrival_waiver_acceptance
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());


CREATE TABLE arrival_check_in (
  arrival_check_in_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid        NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  subject_kind        text        NOT NULL,
  -- booking.booking_id or program_registration.program_registration_id.
  subject_id          uuid        NOT NULL,
  party_id            uuid        REFERENCES party(party_id) ON DELETE SET NULL,
  method_code         text        NOT NULL,
  actor_id            uuid        REFERENCES actor(actor_id) ON DELETE SET NULL,
  auth_session_id     uuid        REFERENCES auth_session(auth_session_id) ON DELETE SET NULL,
  reason              text,
  checked_in_at       timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, subject_kind, subject_id),
  CONSTRAINT arrival_check_in_subject_known CHECK (subject_kind IN ('booking', 'registration')),
  CONSTRAINT arrival_check_in_method_known CHECK (method_code IN ('code', 'desk', 'staff_override', 'self')),
  CONSTRAINT arrival_check_in_staff_has_actor CHECK (method_code = 'self' OR actor_id IS NOT NULL),
  CONSTRAINT arrival_check_in_override_has_reason CHECK (
    method_code <> 'staff_override' OR (actor_id IS NOT NULL AND reason IS NOT NULL AND length(btrim(reason)) > 0)
  )
);

COMMENT ON TABLE arrival_check_in IS
  'One arrival per booking or registration. UNIQUE per subject makes a duplicate check-in idempotent; a staff override must name its actor, session, and reason.';

CREATE INDEX idx_arrival_check_in_party ON arrival_check_in(party_id);
CREATE INDEX idx_arrival_check_in_actor ON arrival_check_in(actor_id);
CREATE INDEX idx_arrival_check_in_session ON arrival_check_in(auth_session_id);
CREATE INDEX idx_arrival_check_in_day ON arrival_check_in(organization_id, checked_in_at);

ALTER TABLE arrival_check_in ENABLE ROW LEVEL SECURITY;
CREATE POLICY arrival_check_in_tenant_isolation ON arrival_check_in
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());
