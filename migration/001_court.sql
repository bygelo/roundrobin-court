-- court 001 — the app's own vocabulary
--
-- Everything genuinely sport-specific lives here, in the app, never in the OS.
-- That turned out to be a short list: a sport's team size, its scoring rule,
-- and which rating provider (if any) governs it.
--
-- The booking pack already knows about site, resource, session, and booking. It
-- has never heard of a court, and it does not need to.

CREATE TABLE sport_profile (
  sport_profile_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        uuid        NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  sport_profile_code     text        NOT NULL,
  display_name           text        NOT NULL,
  team_size_count        smallint    NOT NULL,
  -- The one place a sport genuinely differs in behaviour rather than in naming.
  -- 'side_out_11', 'tennis_set', 'rally_21'. A profile the app does not know
  -- how to score is rejected at configuration time, not mid-match.
  scoring_rule_code      text        NOT NULL,
  -- NULL is a first-class state: badminton and padel have no equivalent of
  -- DUPR, and pretending otherwise would force a fake provider into the model.
  rating_provider_code   text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, sport_profile_code),
  CONSTRAINT sport_profile_team_size_positive CHECK (team_size_count > 0)
);

COMMENT ON TABLE sport_profile IS
  'A sport as data, never as a branch. Adding a fifth sport is an INSERT; no service rule anywhere reads sport_profile_code to decide behaviour except the scorer.';

COMMENT ON COLUMN sport_profile.rating_provider_code IS
  'NULL when the sport has no rating authority. DUPR covers pickleball; tennis has UTR; badminton and padel have neither in this market.';

CREATE INDEX idx_sport_profile_organization ON sport_profile(organization_id);

CREATE TRIGGER sport_profile_updated_at BEFORE UPDATE ON sport_profile
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE sport_profile ENABLE ROW LEVEL SECURITY;
CREATE POLICY sport_profile_tenant_isolation ON sport_profile
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());
