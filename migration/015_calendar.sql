-- court 015 — calendar: R23 read-only iCalendar feed.
--
-- A feed is a projection of venue truth, never a source of it: nothing here
-- accepts input from a calendar client. The token in the URL is the only
-- credential, so only its SHA-256 is stored; revoking or rotating replaces it
-- and the old URL answers 404.

CREATE TABLE calendar_feed (
  calendar_feed_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid        NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  scope_code       text        NOT NULL,
  -- resource_id for a court feed, program_id for a program feed, NULL for the venue.
  scope_id         uuid,
  display_name     text        NOT NULL,
  feed_token_hash  text        NOT NULL,
  token_prefix     text        NOT NULL,
  is_active        boolean     NOT NULL DEFAULT true,
  rotated_at       timestamptz,
  revoked_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  CONSTRAINT calendar_feed_scope_known CHECK (scope_code IN ('venue', 'court', 'program')),
  CONSTRAINT calendar_feed_scope_shape CHECK ((scope_code = 'venue') = (scope_id IS NULL)),
  CONSTRAINT calendar_feed_name_present CHECK (length(btrim(display_name)) > 0),
  CONSTRAINT calendar_feed_hash_shape CHECK (feed_token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT calendar_feed_revoked_inactive CHECK (revoked_at IS NULL OR is_active = false),
  CONSTRAINT calendar_feed_token_unique UNIQUE (feed_token_hash)
);

COMMENT ON TABLE calendar_feed IS
  'A subscribable .ics URL for the venue, one court, or one program. Stores only the token hash plus a short visible prefix; the full URL is shown once. Edits in Google or Apple Calendar never flow back.';

CREATE INDEX idx_calendar_feed_organization ON calendar_feed(organization_id) WHERE deleted_at IS NULL;

CREATE TRIGGER calendar_feed_updated_at BEFORE UPDATE ON calendar_feed
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE calendar_feed ENABLE ROW LEVEL SECURITY;
CREATE POLICY calendar_feed_tenant_isolation ON calendar_feed
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());
