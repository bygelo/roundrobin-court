-- court 005 — program: R10 program and event.
--
-- One model for every scheduled thing a venue sells seats to: a clinic, a
-- lesson, a social, a league or tournament shell, a private event. A program is
-- the product; its schedule is the recurrence rule stored explicitly; an
-- occurrence is one dated instance; a registration is one person's seat or
-- place in line.
--
-- The capacity guarantee lives here, not in the service: a registration that
-- would take an occupied seat is refused by a trigger that locks the occurrence
-- row first, so two concurrent registrations for the last seat serialize and the
-- second one sees the first.

CREATE TABLE program (
  program_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid          NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  kind_code            text          NOT NULL,
  title                text          NOT NULL,
  description          text,
  host_name            text,
  price_amount         numeric(12,2) NOT NULL DEFAULT 0,
  capacity_count       integer       NOT NULL,
  is_member_only       boolean       NOT NULL DEFAULT false,
  min_rating           numeric(5,3),
  rating_provider_code text,
  -- Optional court the program occupies. When set, each occurrence blocks the
  -- court through the booking pack so nobody books over a clinic.
  resource_id          uuid          REFERENCES resource(resource_id) ON DELETE SET NULL,
  is_published         boolean       NOT NULL DEFAULT false,
  created_at           timestamptz   NOT NULL DEFAULT now(),
  updated_at           timestamptz   NOT NULL DEFAULT now(),
  deleted_at           timestamptz,
  CONSTRAINT program_kind_known CHECK (kind_code IN ('clinic', 'lesson', 'social', 'league', 'tournament', 'private_event')),
  CONSTRAINT program_title_present CHECK (length(btrim(title)) > 0),
  CONSTRAINT program_price_not_negative CHECK (price_amount >= 0),
  CONSTRAINT program_capacity_positive CHECK (capacity_count > 0),
  CONSTRAINT program_rating_has_provider CHECK (min_rating IS NULL OR rating_provider_code IS NOT NULL),
  CONSTRAINT program_rating_positive CHECK (min_rating IS NULL OR min_rating > 0)
);

COMMENT ON TABLE program IS
  'A clinic, lesson, social, league shell, tournament shell, or private event. One model so a venue learns one screen; kind_code changes the badge, never the rules.';
COMMENT ON COLUMN program.min_rating IS
  'Eligibility floor on the rating named by rating_provider_code (e.g. dupr). NULL means open to every level.';

CREATE INDEX idx_program_organization ON program(organization_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_program_resource ON program(resource_id);

CREATE TRIGGER program_updated_at BEFORE UPDATE ON program
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE program ENABLE ROW LEVEL SECURITY;
CREATE POLICY program_tenant_isolation ON program
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());


CREATE TABLE program_schedule (
  program_schedule_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid        NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  program_id          uuid        NOT NULL REFERENCES program(program_id) ON DELETE CASCADE,
  schedule_code       text        NOT NULL,
  -- ISO weekday numbers, 1 Monday .. 7 Sunday. Empty for a one-off.
  weekday_number      smallint[]  NOT NULL DEFAULT '{}',
  first_date          date        NOT NULL,
  until_date          date,
  starts_local        time        NOT NULL,
  ends_local          time        NOT NULL,
  skipped_date        date[]      NOT NULL DEFAULT '{}',
  time_zone           text        NOT NULL DEFAULT 'Asia/Manila',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (program_id),
  CONSTRAINT program_schedule_code_known CHECK (schedule_code IN ('once', 'weekly')),
  CONSTRAINT program_schedule_time_ordered CHECK (ends_local > starts_local),
  CONSTRAINT program_schedule_weekly_has_day CHECK (schedule_code <> 'weekly' OR cardinality(weekday_number) > 0),
  CONSTRAINT program_schedule_weekly_has_until CHECK (schedule_code <> 'weekly' OR until_date IS NOT NULL),
  CONSTRAINT program_schedule_until_ordered CHECK (until_date IS NULL OR until_date >= first_date),
  CONSTRAINT program_schedule_weekday_iso CHECK (weekday_number <@ ARRAY[1,2,3,4,5,6,7]::smallint[])
);

COMMENT ON TABLE program_schedule IS
  'The recurrence rule, stored explicitly rather than implied by whichever occurrences happen to exist: weekdays, first and until dates, and the dates skipped. Occurrences are materialized from it idempotently.';

CREATE INDEX idx_program_schedule_organization ON program_schedule(organization_id);

CREATE TRIGGER program_schedule_updated_at BEFORE UPDATE ON program_schedule
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE program_schedule ENABLE ROW LEVEL SECURITY;
CREATE POLICY program_schedule_tenant_isolation ON program_schedule
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());


CREATE TABLE program_occurrence (
  program_occurrence_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid        NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  program_id            uuid        NOT NULL REFERENCES program(program_id) ON DELETE CASCADE,
  occurrence_date       date        NOT NULL,
  starts_at             timestamptz NOT NULL,
  ends_at               timestamptz NOT NULL,
  capacity_count        integer     NOT NULL,
  status_code           text        NOT NULL DEFAULT 'scheduled',
  -- The booking-pack session and booking that hold the court, when the program has one.
  session_id            uuid        REFERENCES session(session_id) ON DELETE SET NULL,
  booking_id            uuid        REFERENCES booking(booking_id) ON DELETE SET NULL,
  cancelled_at          timestamptz,
  cancel_reason         text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (program_id, occurrence_date),
  CONSTRAINT program_occurrence_time_ordered CHECK (ends_at > starts_at),
  CONSTRAINT program_occurrence_capacity_positive CHECK (capacity_count > 0),
  CONSTRAINT program_occurrence_status_known CHECK (status_code IN ('scheduled', 'cancelled')),
  CONSTRAINT program_occurrence_cancel_stamped CHECK ((status_code = 'cancelled') = (cancelled_at IS NOT NULL))
);

COMMENT ON TABLE program_occurrence IS
  'One dated instance of a program. UNIQUE (program_id, occurrence_date) makes materialization idempotent; capacity_count is copied from the program so a later capacity change is an explicit act.';

CREATE INDEX idx_program_occurrence_organization ON program_occurrence(organization_id);
CREATE INDEX idx_program_occurrence_starts ON program_occurrence(organization_id, starts_at);
CREATE INDEX idx_program_occurrence_session ON program_occurrence(session_id);
CREATE INDEX idx_program_occurrence_booking ON program_occurrence(booking_id);

CREATE TRIGGER program_occurrence_updated_at BEFORE UPDATE ON program_occurrence
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE program_occurrence ENABLE ROW LEVEL SECURITY;
CREATE POLICY program_occurrence_tenant_isolation ON program_occurrence
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());


CREATE TABLE program_registration (
  program_registration_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid        NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  program_occurrence_id   uuid        NOT NULL REFERENCES program_occurrence(program_occurrence_id) ON DELETE CASCADE,
  party_id                uuid        REFERENCES party(party_id) ON DELETE SET NULL,
  display_name            text        NOT NULL,
  email_address           text,
  phone_number            text,
  status_code             text        NOT NULL DEFAULT 'registered',
  waitlist_position       integer,
  -- sha256 of the private action credential shown to the player exactly once.
  credential_hash         text        NOT NULL,
  scan_code_id            uuid,
  paid_at                 timestamptz,
  promoted_at             timestamptz,
  cancelled_at            timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (credential_hash),
  CONSTRAINT program_registration_status_known CHECK (status_code IN ('registered', 'waitlisted', 'cancelled', 'no_show', 'attended')),
  CONSTRAINT program_registration_waitlist_positioned CHECK ((status_code = 'waitlisted') = (waitlist_position IS NOT NULL)),
  CONSTRAINT program_registration_name_present CHECK (length(btrim(display_name)) > 0),
  CONSTRAINT program_registration_contact_present CHECK (email_address IS NOT NULL OR phone_number IS NOT NULL)
);

COMMENT ON TABLE program_registration IS
  'One person''s seat, or place in line, for one occurrence. Contact fields are operator-only and never leave on a public route; the credential is stored only as a hash.';

CREATE INDEX idx_program_registration_organization ON program_registration(organization_id);
CREATE INDEX idx_program_registration_occurrence ON program_registration(program_occurrence_id, status_code);
CREATE INDEX idx_program_registration_party ON program_registration(party_id);

-- One active registration per party per occurrence.
CREATE UNIQUE INDEX program_registration_one_active_party
  ON program_registration(program_occurrence_id, party_id)
  WHERE party_id IS NOT NULL AND status_code IN ('registered', 'waitlisted', 'attended');

-- A place in line is held by exactly one registration.
CREATE UNIQUE INDEX program_registration_one_waitlist_position
  ON program_registration(program_occurrence_id, waitlist_position)
  WHERE status_code = 'waitlisted';

CREATE TRIGGER program_registration_updated_at BEFORE UPDATE ON program_registration
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION program_registration_enforce_capacity() RETURNS trigger AS $$
DECLARE
  seat_limit integer;
  seat_taken integer;
BEGIN
  IF NEW.status_code NOT IN ('registered', 'attended') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status_code IN ('registered', 'attended') THEN
    RETURN NEW;
  END IF;

  -- The lock is the guarantee: every seat-taking write for this occurrence
  -- queues here, so the count below cannot be stale.
  SELECT capacity_count INTO seat_limit
  FROM program_occurrence
  WHERE program_occurrence_id = NEW.program_occurrence_id
  FOR UPDATE;

  SELECT count(*) INTO seat_taken
  FROM program_registration
  WHERE program_occurrence_id = NEW.program_occurrence_id
    AND status_code IN ('registered', 'attended')
    AND program_registration_id <> NEW.program_registration_id;

  IF seat_taken >= seat_limit THEN
    RAISE EXCEPTION 'occurrence % is full', NEW.program_occurrence_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION program_registration_enforce_capacity() IS
  'Refuses a seat beyond capacity_count. Locks the occurrence row so concurrent registrations serialize — no over-registration regardless of caller.';

CREATE TRIGGER program_registration_capacity_check
  BEFORE INSERT OR UPDATE OF status_code ON program_registration
  FOR EACH ROW EXECUTE FUNCTION program_registration_enforce_capacity();

ALTER TABLE program_registration ENABLE ROW LEVEL SECURITY;
CREATE POLICY program_registration_tenant_isolation ON program_registration
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());
