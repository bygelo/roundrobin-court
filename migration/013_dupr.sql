-- court 013 — dupr: R20 DUPR identity, rating, and consented result submission.
--
-- Layered on the connector pack: the credential lives in connector_account as a
-- reference (env var name), never in a court table. These tables carry only
-- what is DUPR-specific: an honest connection status, the consented link from a
-- player to a DUPR ID with a rating snapshot, and one submission per match.

CREATE TABLE dupr_connection (
  dupr_connection_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid        NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  connector_account_id uuid        REFERENCES connector_account(connector_account_id) ON DELETE SET NULL,
  mode_code            text,
  status_code          text        NOT NULL DEFAULT 'not_configured',
  last_validated_at    timestamptz,
  last_error           text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dupr_connection_one_per_organization UNIQUE (organization_id),
  CONSTRAINT dupr_connection_mode_known CHECK (mode_code IS NULL OR mode_code IN ('sandbox', 'live')),
  CONSTRAINT dupr_connection_status_known CHECK (status_code IN ('not_configured', 'sandbox', 'connected', 'error')),
  CONSTRAINT dupr_connection_live_has_account CHECK (status_code NOT IN ('sandbox', 'connected') OR connector_account_id IS NOT NULL)
);

COMMENT ON TABLE dupr_connection IS
  'Whether this venue can talk to DUPR right now, stated honestly. connected is only ever written after real partner credentials validated; sandbox is a deterministic adapter and says so.';

CREATE INDEX idx_dupr_connection_account ON dupr_connection(connector_account_id);

CREATE TRIGGER dupr_connection_updated_at BEFORE UPDATE ON dupr_connection
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE dupr_connection ENABLE ROW LEVEL SECURITY;
CREATE POLICY dupr_connection_tenant_isolation ON dupr_connection
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());


CREATE TABLE dupr_player_link (
  dupr_player_link_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid          NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  party_id            uuid          REFERENCES party(party_id) ON DELETE SET NULL,
  display_name        text          NOT NULL,
  dupr_id             text          NOT NULL,
  consent_at          timestamptz   NOT NULL,
  -- Who recorded the consent and how, e.g. {"actor_id": ..., "method_code": "operator_attested"}.
  consent_evidence    jsonb         NOT NULL,
  doubles_rating      numeric(5,3),
  singles_rating      numeric(5,3),
  rating_source_code  text,
  rating_fetched_at   timestamptz,
  created_at          timestamptz   NOT NULL DEFAULT now(),
  updated_at          timestamptz   NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  CONSTRAINT dupr_player_link_name_present CHECK (length(btrim(display_name)) > 0),
  CONSTRAINT dupr_player_link_id_present CHECK (length(btrim(dupr_id)) > 0),
  CONSTRAINT dupr_player_link_rating_sourced CHECK (
    (doubles_rating IS NULL AND singles_rating IS NULL) OR (rating_source_code IS NOT NULL AND rating_fetched_at IS NOT NULL)
  )
);

COMMENT ON TABLE dupr_player_link IS
  'A player''s DUPR identity, linked only with recorded consent. The rating is a dated snapshot from DUPR with its source; the venue never computes a rating of its own.';

CREATE UNIQUE INDEX uq_dupr_player_link_dupr_id ON dupr_player_link(organization_id, dupr_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_dupr_player_link_party ON dupr_player_link(organization_id, party_id)
  WHERE deleted_at IS NULL AND party_id IS NOT NULL;
CREATE INDEX idx_dupr_player_link_organization ON dupr_player_link(organization_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_dupr_player_link_party ON dupr_player_link(party_id);

CREATE TRIGGER dupr_player_link_updated_at BEFORE UPDATE ON dupr_player_link
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE dupr_player_link ENABLE ROW LEVEL SECURITY;
CREATE POLICY dupr_player_link_tenant_isolation ON dupr_player_link
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());


CREATE TABLE dupr_submission (
  dupr_submission_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid        NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  -- The score module's match. No foreign key: the score schema is owned by
  -- another module and may be disabled; the local result is never touched here.
  score_match_id     uuid        NOT NULL,
  match_label        text        NOT NULL,
  status_code        text        NOT NULL DEFAULT 'pending',
  payload            jsonb       NOT NULL,
  receipt_code       text,
  rejection_code     text,
  rejection_message  text,
  last_error         text,
  attempt_count      integer     NOT NULL DEFAULT 0,
  last_attempted_at  timestamptz,
  submitted_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dupr_submission_once UNIQUE (organization_id, score_match_id),
  CONSTRAINT dupr_submission_status_known CHECK (status_code IN ('pending', 'submitted', 'rejected')),
  CONSTRAINT dupr_submission_receipt_when_submitted CHECK ((status_code = 'submitted') = (receipt_code IS NOT NULL)),
  CONSTRAINT dupr_submission_reason_when_rejected CHECK (status_code <> 'rejected' OR (rejection_code IS NOT NULL AND rejection_message IS NOT NULL)),
  CONSTRAINT dupr_submission_attempt_not_negative CHECK (attempt_count >= 0)
);

COMMENT ON TABLE dupr_submission IS
  'One DUPR submission per confirmed match. UNIQUE (organization_id, score_match_id) makes a second submit return the first receipt; a provider outage leaves the row pending, never lost.';

CREATE INDEX idx_dupr_submission_organization ON dupr_submission(organization_id, created_at DESC);

CREATE TRIGGER dupr_submission_updated_at BEFORE UPDATE ON dupr_submission
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE dupr_submission ENABLE ROW LEVEL SECURITY;
CREATE POLICY dupr_submission_tenant_isolation ON dupr_submission
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());
