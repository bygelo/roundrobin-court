-- court 004 — open play: fair round-robin rotation (R09).
--
-- The rotation decision itself is a pure function (src/module/play/engine.ts).
-- This schema holds what it decides over, and makes the two failures that
-- would embarrass a venue unrepresentable:
--
--   * a player called to two courts at once — a partial unique index on
--     play_game_entry over games that are not finished; and
--   * two groups sent to one court — a partial unique index on play_game over
--     unfinished games per court.
--
-- play_game_entry.is_finished mirrors play_game.is_finished through a composite
-- foreign key with ON UPDATE CASCADE, so finishing a game releases its players
-- in the same statement, with no trigger to forget.

-- ---------------------------------------------------------------------------
-- play_session — one open-play block
-- ---------------------------------------------------------------------------

CREATE TABLE play_session (
  play_session_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid        NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  -- Optional link to the booking pack's session holding the courts' time.
  session_id       uuid,
  display_name     text        NOT NULL,
  starts_at        timestamptz NOT NULL,
  ends_at          timestamptz NOT NULL,
  format_code      text        NOT NULL DEFAULT 'doubles',
  capacity_count   integer     NOT NULL,
  -- 128 random bits, base64url. The link a phone or lounge TV opens.
  public_token     text        NOT NULL,
  -- Four digits, said out loud or posted at the desk. Proves presence for self check-in.
  join_code        text        NOT NULL,
  status_code      text        NOT NULL DEFAULT 'open',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  CONSTRAINT play_session_tenant_key UNIQUE (organization_id, play_session_id),
  CONSTRAINT play_session_public_token_key UNIQUE (public_token),
  CONSTRAINT play_session_session_same_tenant FOREIGN KEY (organization_id, session_id)
    REFERENCES session(organization_id, session_id) ON DELETE SET NULL (session_id),
  CONSTRAINT play_session_time_ordered CHECK (ends_at > starts_at),
  CONSTRAINT play_session_capacity_positive CHECK (capacity_count > 0),
  CONSTRAINT play_session_format_known CHECK (format_code IN ('doubles', 'singles')),
  CONSTRAINT play_session_status_known CHECK (status_code IN ('draft', 'open', 'closed')),
  CONSTRAINT play_session_join_code_shape CHECK (join_code ~ '^[0-9]{4}$'),
  CONSTRAINT play_session_public_token_length CHECK (length(public_token) >= 22),
  CONSTRAINT play_session_name_present CHECK (length(btrim(display_name)) > 0)
);

COMMENT ON TABLE play_session IS
  'An open-play block: players check in, and the rotation engine fairly calls groups onto the session''s courts. Public by token, joinable by join code.';

CREATE INDEX idx_play_session_organization ON play_session(organization_id, starts_at) WHERE deleted_at IS NULL;
CREATE INDEX idx_play_session_session ON play_session(organization_id, session_id);

CREATE TRIGGER play_session_updated_at BEFORE UPDATE ON play_session
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE play_session ENABLE ROW LEVEL SECURITY;
CREATE POLICY play_session_tenant_isolation ON play_session
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());

-- ---------------------------------------------------------------------------
-- play_session_resource — which courts, in which order
-- ---------------------------------------------------------------------------

CREATE TABLE play_session_resource (
  play_session_resource_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid        NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  play_session_id          uuid        NOT NULL,
  resource_id              uuid        NOT NULL,
  position                 smallint    NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT play_session_resource_session_fkey FOREIGN KEY (organization_id, play_session_id)
    REFERENCES play_session(organization_id, play_session_id) ON DELETE CASCADE,
  CONSTRAINT play_session_resource_resource_fkey FOREIGN KEY (organization_id, resource_id)
    REFERENCES resource(organization_id, resource_id) ON DELETE RESTRICT,
  CONSTRAINT play_session_resource_once UNIQUE (play_session_id, resource_id),
  CONSTRAINT play_session_resource_position_once UNIQUE (play_session_id, position),
  CONSTRAINT play_session_resource_position_positive CHECK (position > 0)
);

COMMENT ON TABLE play_session_resource IS
  'The courts an open-play session rotates across. position is the fill order: free courts are filled lowest position first.';

CREATE INDEX idx_play_session_resource_session ON play_session_resource(organization_id, play_session_id);
CREATE INDEX idx_play_session_resource_resource ON play_session_resource(organization_id, resource_id);

ALTER TABLE play_session_resource ENABLE ROW LEVEL SECURITY;
CREATE POLICY play_session_resource_tenant_isolation ON play_session_resource
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());

-- ---------------------------------------------------------------------------
-- play_entry — one player on one session's list
-- ---------------------------------------------------------------------------

CREATE TABLE play_entry (
  play_entry_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid        NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  play_session_id   uuid        NOT NULL,
  party_id          uuid,
  display_name      text        NOT NULL,
  -- registered: on the list, not arrived. waiting: checked in, in the queue.
  -- playing: on court. waitlisted: over capacity. no_show / left / done: gone.
  status_code       text        NOT NULL,
  checked_in_at     timestamptz,
  waitlist_position integer,
  game_count        integer     NOT NULL DEFAULT 0,
  -- Games credited on a late arrival, so they join the front tier fairly.
  credit_count      integer     NOT NULL DEFAULT 0,
  last_finished_at  timestamptz,
  left_at           timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT play_entry_session_fkey FOREIGN KEY (organization_id, play_session_id)
    REFERENCES play_session(organization_id, play_session_id) ON DELETE CASCADE,
  CONSTRAINT play_entry_party_fkey FOREIGN KEY (organization_id, party_id)
    REFERENCES party(organization_id, party_id) ON DELETE SET NULL (party_id),
  CONSTRAINT play_entry_session_key UNIQUE (play_session_id, play_entry_id),
  CONSTRAINT play_entry_status_known CHECK
    (status_code IN ('registered', 'waiting', 'playing', 'waitlisted', 'no_show', 'left', 'done')),
  CONSTRAINT play_entry_queue_needs_check_in CHECK
    (status_code NOT IN ('waiting', 'playing') OR checked_in_at IS NOT NULL),
  CONSTRAINT play_entry_waitlist_positioned CHECK
    ((status_code = 'waitlisted') = (waitlist_position IS NOT NULL)),
  CONSTRAINT play_entry_count_not_negative CHECK (game_count >= 0 AND credit_count >= 0),
  CONSTRAINT play_entry_name_present CHECK (length(btrim(display_name)) BETWEEN 1 AND 80)
);

COMMENT ON TABLE play_entry IS
  'A player on an open-play list. Carries exactly what the fairness rule reads: check-in time, games finished, late-arrival credit, and when their last game ended.';

CREATE INDEX idx_play_entry_session ON play_entry(organization_id, play_session_id, status_code);
CREATE INDEX idx_play_entry_party ON play_entry(organization_id, party_id);

-- One live name per session, so a board never shows two indistinguishable "Ana R."s
-- and a phone retrying a self check-in cannot add the same player twice.
CREATE UNIQUE INDEX play_entry_active_name_once ON play_entry(play_session_id, lower(btrim(display_name)))
  WHERE status_code IN ('registered', 'waiting', 'playing', 'waitlisted');

CREATE UNIQUE INDEX play_entry_waitlist_position_once ON play_entry(play_session_id, waitlist_position)
  WHERE status_code = 'waitlisted';

CREATE TRIGGER play_entry_updated_at BEFORE UPDATE ON play_entry
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE play_entry ENABLE ROW LEVEL SECURITY;
CREATE POLICY play_entry_tenant_isolation ON play_entry
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());

-- ---------------------------------------------------------------------------
-- play_game — one group on one court
-- ---------------------------------------------------------------------------

CREATE TABLE play_game (
  play_game_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid        NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  play_session_id  uuid        NOT NULL,
  resource_id      uuid        NOT NULL,
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  is_finished      boolean     GENERATED ALWAYS AS (finished_at IS NOT NULL) STORED,
  score_text       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT play_game_session_fkey FOREIGN KEY (organization_id, play_session_id)
    REFERENCES play_session(organization_id, play_session_id) ON DELETE CASCADE,
  CONSTRAINT play_game_court_in_session FOREIGN KEY (play_session_id, resource_id)
    REFERENCES play_session_resource(play_session_id, resource_id) ON DELETE RESTRICT,
  CONSTRAINT play_game_finish_key UNIQUE (play_session_id, play_game_id, is_finished),
  CONSTRAINT play_game_time_ordered CHECK (finished_at IS NULL OR finished_at >= started_at),
  CONSTRAINT play_game_score_short CHECK (score_text IS NULL OR length(score_text) <= 60)
);

COMMENT ON TABLE play_game IS
  'A group called onto a court by a rotation. Unfinished while on court; finishing it returns its players to the queue.';

CREATE INDEX idx_play_game_session ON play_game(organization_id, play_session_id);
CREATE INDEX idx_play_game_court ON play_game(play_session_id, resource_id);

-- A court hosts at most one unfinished game per session.
CREATE UNIQUE INDEX play_game_one_live_per_court ON play_game(play_session_id, resource_id)
  WHERE finished_at IS NULL;

CREATE TRIGGER play_game_updated_at BEFORE UPDATE ON play_game
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE play_game ENABLE ROW LEVEL SECURITY;
CREATE POLICY play_game_tenant_isolation ON play_game
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());

-- ---------------------------------------------------------------------------
-- play_game_entry — who is in a game, on which team
-- ---------------------------------------------------------------------------

CREATE TABLE play_game_entry (
  play_game_entry_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid        NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  play_session_id    uuid        NOT NULL,
  play_game_id       uuid        NOT NULL,
  play_entry_id      uuid        NOT NULL,
  team_number        smallint    NOT NULL,
  -- Mirrors play_game.is_finished via the cascading foreign key below.
  is_finished        boolean     NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT play_game_entry_game_fkey FOREIGN KEY (play_session_id, play_game_id, is_finished)
    REFERENCES play_game(play_session_id, play_game_id, is_finished) ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT play_game_entry_entry_fkey FOREIGN KEY (play_session_id, play_entry_id)
    REFERENCES play_entry(play_session_id, play_entry_id) ON DELETE CASCADE,
  CONSTRAINT play_game_entry_session_fkey FOREIGN KEY (organization_id, play_session_id)
    REFERENCES play_session(organization_id, play_session_id) ON DELETE CASCADE,
  CONSTRAINT play_game_entry_once UNIQUE (play_game_id, play_entry_id),
  CONSTRAINT play_game_entry_team_known CHECK (team_number IN (1, 2))
);

COMMENT ON TABLE play_game_entry IS
  'A player''s seat in a game. The partial unique index over unfinished rows is the guarantee that nobody is ever on two courts at once.';

CREATE INDEX idx_play_game_entry_game ON play_game_entry(play_session_id, play_game_id, is_finished);
CREATE INDEX idx_play_game_entry_entry ON play_game_entry(play_session_id, play_entry_id);
CREATE INDEX idx_play_game_entry_organization ON play_game_entry(organization_id, play_session_id);

CREATE UNIQUE INDEX play_game_entry_one_live_game ON play_game_entry(play_entry_id)
  WHERE NOT is_finished;

ALTER TABLE play_game_entry ENABLE ROW LEVEL SECURITY;
CREATE POLICY play_game_entry_tenant_isolation ON play_game_entry
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());

-- ---------------------------------------------------------------------------
-- pre-tenant lookup: public token -> organization
-- ---------------------------------------------------------------------------
--
-- A phone opening /play/<token> has no session and no organization code. Like
-- resolve_organization_by_code, this runs before a tenant is bound and returns
-- an id and nothing else; every read after it happens inside withTenant.

CREATE OR REPLACE FUNCTION resolve_play_session_organization(lookup_token text)
  RETURNS uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT organization_id
  FROM play_session
  WHERE public_token = lookup_token
    AND deleted_at IS NULL
$$;

COMMENT ON FUNCTION resolve_play_session_organization(text) IS
  'Pre-tenant lookup for the public open-play link. SECURITY DEFINER because play_session is RLS-protected and no tenant is bound yet. Returns only an organization id.';

REVOKE EXECUTE ON FUNCTION resolve_play_session_organization(text) FROM PUBLIC;
