-- court 002 — venue setup, sellable schedule, and booking policy (R06, R08).
--
-- The booking pack already owns site, resource, session, session_template,
-- closure, and booking. This file adds only what a venue operator configures on
-- top of them and the pack has no noun for:
--
--   court_site_detail    how a player reaches the venue (contact line)
--   court_operating_hour when the doors are open, per weekday
--   court_schedule       the sellable slot plan for one sport: length, price band
--   court_schedule_peak  which local windows sell at the peak price
--   court_booking_policy advance window, cancellation cutoff, hold, guest rule
--
-- A schedule is turned into booking-pack session_template rows, and those into
-- session rows, by src/module/court/schedule.ts. Nothing here computes a price
-- at booking time; the settled price sits on the session, as the pack requires.

-- ---------------------------------------------------------------------------
-- sport_profile — close the vocabulary 001 left open
-- ---------------------------------------------------------------------------

ALTER TABLE sport_profile
  ADD COLUMN session_minute_count smallint NOT NULL DEFAULT 60;

COMMENT ON COLUMN sport_profile.session_minute_count IS
  'The default length of a booked session for this sport. A court schedule for the sport starts from it.';

ALTER TABLE sport_profile
  ADD CONSTRAINT sport_profile_session_minute_known
  CHECK (session_minute_count IN (60, 90, 120));

ALTER TABLE sport_profile
  ADD CONSTRAINT sport_profile_scoring_rule_known
  CHECK (scoring_rule_code IN (
    'side_out_11', 'side_out_15', 'side_out_21',
    'rally_11', 'rally_15', 'rally_21',
    'badminton_rally_21', 'tennis_set', 'padel_set'
  ));

ALTER TABLE sport_profile
  ADD CONSTRAINT sport_profile_rating_provider_known
  CHECK (rating_provider_code IS NULL OR rating_provider_code IN ('dupr', 'utr'));

ALTER TABLE sport_profile
  ADD CONSTRAINT sport_profile_code_shape
  CHECK (sport_profile_code ~ '^[a-z][a-z0-9_]{0,39}$');

-- ---------------------------------------------------------------------------
-- court_site_detail
-- ---------------------------------------------------------------------------

CREATE TABLE court_site_detail (
  court_site_detail_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid        NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  site_id              uuid        NOT NULL,
  contact_phone_number text,
  contact_email_address text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT court_site_detail_site_same_tenant
    FOREIGN KEY (organization_id, site_id) REFERENCES site(organization_id, site_id) ON DELETE CASCADE,
  CONSTRAINT court_site_detail_one_per_site UNIQUE (site_id)
);

COMMENT ON TABLE court_site_detail IS
  'How a player reaches the venue. The booking pack site carries name, address, and time zone; the public contact line is a venue concern, so it lives here rather than widening the pack.';

CREATE INDEX idx_court_site_detail_organization ON court_site_detail(organization_id);
CREATE INDEX idx_court_site_detail_tenant_site ON court_site_detail(organization_id, site_id);

CREATE TRIGGER court_site_detail_updated_at BEFORE UPDATE ON court_site_detail
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE court_site_detail ENABLE ROW LEVEL SECURITY;
ALTER TABLE court_site_detail FORCE  ROW LEVEL SECURITY;
CREATE POLICY court_site_detail_tenant_isolation ON court_site_detail
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());

-- ---------------------------------------------------------------------------
-- court_operating_hour
-- ---------------------------------------------------------------------------

CREATE TABLE court_operating_hour (
  court_operating_hour_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid        NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  site_id                 uuid        NOT NULL,
  -- ISO weekday: 1 = Monday … 7 = Sunday, matching session_template.
  weekday_number          smallint    NOT NULL,
  opens_local             time        NOT NULL,
  closes_local            time        NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT court_operating_hour_site_same_tenant
    FOREIGN KEY (organization_id, site_id) REFERENCES site(organization_id, site_id) ON DELETE CASCADE,
  CONSTRAINT court_operating_hour_one_per_weekday UNIQUE (site_id, weekday_number),
  CONSTRAINT court_operating_hour_weekday_iso CHECK (weekday_number BETWEEN 1 AND 7),
  -- '24:00' is a valid time and means midnight at the end of the day.
  CONSTRAINT court_operating_hour_ordered CHECK (closes_local > opens_local)
);

COMMENT ON TABLE court_operating_hour IS
  'When the venue is open, per weekday, in the site time zone. No row for a weekday means closed that day. The sellable schedule is generated inside these hours and nowhere else.';

CREATE INDEX idx_court_operating_hour_organization ON court_operating_hour(organization_id);
CREATE INDEX idx_court_operating_hour_tenant_site ON court_operating_hour(organization_id, site_id);

CREATE TRIGGER court_operating_hour_updated_at BEFORE UPDATE ON court_operating_hour
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE court_operating_hour ENABLE ROW LEVEL SECURITY;
ALTER TABLE court_operating_hour FORCE  ROW LEVEL SECURITY;
CREATE POLICY court_operating_hour_tenant_isolation ON court_operating_hour
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());

-- ---------------------------------------------------------------------------
-- court_schedule
-- ---------------------------------------------------------------------------

CREATE TABLE court_schedule (
  court_schedule_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid          NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  site_id                  uuid          NOT NULL,
  -- The sport this plan sells: every active court carrying this category.
  resource_category_id     uuid          NOT NULL,
  display_name             text          NOT NULL,
  slot_minute_count        smallint      NOT NULL,
  capacity_count           integer       NOT NULL DEFAULT 4,
  off_peak_price_amount    numeric(12,2) NOT NULL,
  peak_price_amount        numeric(12,2) NOT NULL,
  horizon_day_count        integer       NOT NULL DEFAULT 14,
  -- Bumped on every regeneration so template and materialization keys never
  -- collide with a superseded session that still carries a booking.
  revision_number          integer       NOT NULL DEFAULT 0,
  generated_at             timestamptz,
  created_at               timestamptz   NOT NULL DEFAULT now(),
  updated_at               timestamptz   NOT NULL DEFAULT now(),
  deleted_at               timestamptz,
  CONSTRAINT court_schedule_site_same_tenant
    FOREIGN KEY (organization_id, site_id) REFERENCES site(organization_id, site_id) ON DELETE CASCADE,
  CONSTRAINT court_schedule_category_same_tenant
    FOREIGN KEY (organization_id, resource_category_id)
    REFERENCES resource_category(organization_id, resource_category_id) ON DELETE CASCADE,
  CONSTRAINT court_schedule_tenant_key UNIQUE (organization_id, court_schedule_id),
  CONSTRAINT court_schedule_slot_minute_known CHECK (slot_minute_count IN (60, 90, 120)),
  CONSTRAINT court_schedule_capacity_positive CHECK (capacity_count > 0),
  CONSTRAINT court_schedule_price_not_negative CHECK (off_peak_price_amount >= 0 AND peak_price_amount >= 0),
  CONSTRAINT court_schedule_horizon_bounded CHECK (horizon_day_count BETWEEN 1 AND 90),
  CONSTRAINT court_schedule_revision_not_negative CHECK (revision_number >= 0)
);

COMMENT ON TABLE court_schedule IS
  'The sellable slot plan for one sport at one site: slot length, player capacity, off-peak and peak price, and how many days ahead sessions are materialized. Regenerated into booking-pack session templates; never read at booking time.';

COMMENT ON COLUMN court_schedule.revision_number IS
  'Incremented on each regeneration. Template codes embed it, so an edited plan materializes fresh sessions while superseded sessions that still hold a booking stay intact.';

-- One live plan per sport per site. Retired plans keep their history.
CREATE UNIQUE INDEX court_schedule_one_live_per_category
  ON court_schedule(site_id, resource_category_id) WHERE deleted_at IS NULL;

CREATE INDEX idx_court_schedule_organization ON court_schedule(organization_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_court_schedule_tenant_site ON court_schedule(organization_id, site_id);
CREATE INDEX idx_court_schedule_tenant_category ON court_schedule(organization_id, resource_category_id);

CREATE TRIGGER court_schedule_updated_at BEFORE UPDATE ON court_schedule
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE court_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE court_schedule FORCE  ROW LEVEL SECURITY;
CREATE POLICY court_schedule_tenant_isolation ON court_schedule
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());

-- ---------------------------------------------------------------------------
-- court_schedule_peak
-- ---------------------------------------------------------------------------

CREATE TABLE court_schedule_peak (
  court_schedule_peak_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        uuid        NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  court_schedule_id      uuid        NOT NULL,
  weekday_number         smallint    NOT NULL,
  starts_local           time        NOT NULL,
  ends_local             time        NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT court_schedule_peak_schedule_same_tenant
    FOREIGN KEY (organization_id, court_schedule_id)
    REFERENCES court_schedule(organization_id, court_schedule_id) ON DELETE CASCADE,
  CONSTRAINT court_schedule_peak_weekday_iso CHECK (weekday_number BETWEEN 1 AND 7),
  CONSTRAINT court_schedule_peak_ordered CHECK (ends_local > starts_local),
  CONSTRAINT court_schedule_peak_unique_start UNIQUE (court_schedule_id, weekday_number, starts_local)
);

COMMENT ON TABLE court_schedule_peak IS
  'A local time window on one weekday during which a slot starting inside it sells at the schedule peak price. Immutable rows: an edit replaces the set and regenerates the schedule.';

CREATE INDEX idx_court_schedule_peak_organization ON court_schedule_peak(organization_id);
CREATE INDEX idx_court_schedule_peak_tenant_schedule ON court_schedule_peak(organization_id, court_schedule_id);

ALTER TABLE court_schedule_peak ENABLE ROW LEVEL SECURITY;
ALTER TABLE court_schedule_peak FORCE  ROW LEVEL SECURITY;
CREATE POLICY court_schedule_peak_tenant_isolation ON court_schedule_peak
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());

-- ---------------------------------------------------------------------------
-- court_booking_policy
-- ---------------------------------------------------------------------------

CREATE TABLE court_booking_policy (
  court_booking_policy_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id                uuid        NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  advance_window_day_count       integer     NOT NULL DEFAULT 14,
  cancellation_cutoff_hour_count integer     NOT NULL DEFAULT 24,
  hold_minute_count              integer     NOT NULL DEFAULT 10,
  is_guest_booking_allowed       boolean     NOT NULL DEFAULT true,
  created_at                     timestamptz NOT NULL DEFAULT now(),
  updated_at                     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT court_booking_policy_one_per_organization UNIQUE (organization_id),
  CONSTRAINT court_booking_policy_window_bounded CHECK (advance_window_day_count BETWEEN 1 AND 365),
  CONSTRAINT court_booking_policy_cutoff_bounded CHECK (cancellation_cutoff_hour_count BETWEEN 0 AND 720),
  CONSTRAINT court_booking_policy_hold_bounded CHECK (hold_minute_count BETWEEN 1 AND 120)
);

COMMENT ON TABLE court_booking_policy IS
  'The venue rules a player books under: how far ahead, how late a cancellation is still free, how long an unpaid hold lasts, and whether a guest without an account may book. At most one row per organization; absent means the defaults in src/module/court/policy.ts.';

CREATE TRIGGER court_booking_policy_updated_at BEFORE UPDATE ON court_booking_policy
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE court_booking_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE court_booking_policy FORCE  ROW LEVEL SECURITY;
CREATE POLICY court_booking_policy_tenant_isolation ON court_booking_policy
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());
