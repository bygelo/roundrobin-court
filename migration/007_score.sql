-- court 007 — score: R12 live score under a sport scoring profile.
--
-- State is never stored. score_operation is an append-only log and every read
-- replays it through the pure scorer (src/module/score/engine.ts), so a
-- tablet that drops off the network and comes back sees exactly the state the
-- server holds, and two tablets on one court converge on one order.
--
-- A confirmed result is immutable: no UPDATE path touches its operations, and
-- the only way to change it is score_correction, which writes a new operation
-- set version next to the old one and records who, when, and why.

-- ---------------------------------------------------------------------------
-- score_match
-- ---------------------------------------------------------------------------

CREATE TABLE score_match (
  score_match_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid        NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  resource_id             uuid,
  sport_profile_code      text        NOT NULL,
  -- Snapshotted from sport_profile at creation: a venue re-configuring its
  -- pickleball profile must not rescore a match already played.
  scoring_rule_code       text        NOT NULL,
  team_size_count         smallint    NOT NULL,
  best_of_count           smallint    NOT NULL DEFAULT 1,
  status                  text        NOT NULL DEFAULT 'live',
  -- The operation set in effect. A correction appends a new set and bumps this.
  operation_set_version   integer     NOT NULL DEFAULT 1,
  played_at               timestamptz NOT NULL DEFAULT now(),
  confirmed_at            timestamptz,
  confirmed_by_actor_id   uuid        REFERENCES actor(actor_id) ON DELETE SET NULL,
  created_by_actor_id     uuid        REFERENCES actor(actor_id) ON DELETE SET NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  deleted_at              timestamptz,
  CONSTRAINT score_match_status_known CHECK (status IN ('live', 'complete', 'confirmed')),
  CONSTRAINT score_match_confirmed_has_time CHECK ((status = 'confirmed') = (confirmed_at IS NOT NULL)),
  CONSTRAINT score_match_best_of_odd CHECK (best_of_count IN (1, 3, 5)),
  CONSTRAINT score_match_team_size_positive CHECK (team_size_count > 0),
  CONSTRAINT score_match_operation_set_positive CHECK (operation_set_version > 0),
  CONSTRAINT score_match_confirmed_not_deleted CHECK (status <> 'confirmed' OR deleted_at IS NULL),
  CONSTRAINT score_match_scoring_rule_known CHECK (scoring_rule_code IN (
    'side_out_11', 'side_out_15', 'side_out_21',
    'rally_11', 'rally_15', 'rally_21',
    'badminton_rally_21', 'tennis_set', 'padel_set'
  )),
  CONSTRAINT score_match_tenant_key UNIQUE (organization_id, score_match_id),
  CONSTRAINT score_match_resource_same_tenant FOREIGN KEY (organization_id, resource_id)
    REFERENCES resource(organization_id, resource_id) ON DELETE SET NULL (resource_id),
  CONSTRAINT score_match_sport_profile_same_tenant FOREIGN KEY (organization_id, sport_profile_code)
    REFERENCES sport_profile(organization_id, sport_profile_code) ON DELETE RESTRICT
);

COMMENT ON TABLE score_match IS
  'One match scored at a court under a sport scoring profile. Holds no score: the score is the replay of its current operation set. Confirmed is terminal — only a score_correction changes the result, and never silently.';

COMMENT ON COLUMN score_match.operation_set_version IS
  'Which score_operation set is in effect. 1 as played; each audited correction appends a new set and bumps this.';

CREATE INDEX idx_score_match_organization ON score_match(organization_id);
CREATE INDEX idx_score_match_resource ON score_match(organization_id, resource_id);
CREATE INDEX idx_score_match_sport_profile ON score_match(organization_id, sport_profile_code);
CREATE INDEX idx_score_match_confirmed_by ON score_match(confirmed_by_actor_id);
CREATE INDEX idx_score_match_created_by ON score_match(created_by_actor_id);
CREATE INDEX idx_score_match_open ON score_match(organization_id, status, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE TRIGGER score_match_updated_at BEFORE UPDATE ON score_match
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A confirmed match cannot drift: its identity, rule, and confirmation are
-- frozen. The operation set may only move forward (a correction).
CREATE FUNCTION score_match_guard_confirmed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'confirmed' AND (
       NEW.status IS DISTINCT FROM OLD.status
    OR NEW.scoring_rule_code IS DISTINCT FROM OLD.scoring_rule_code
    OR NEW.sport_profile_code IS DISTINCT FROM OLD.sport_profile_code
    OR NEW.team_size_count IS DISTINCT FROM OLD.team_size_count
    OR NEW.best_of_count IS DISTINCT FROM OLD.best_of_count
    OR NEW.played_at IS DISTINCT FROM OLD.played_at
    OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
    OR NEW.confirmed_by_actor_id IS DISTINCT FROM OLD.confirmed_by_actor_id
    OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
    OR NEW.operation_set_version < OLD.operation_set_version
  ) THEN
    RAISE EXCEPTION 'a confirmed score_match is immutable; write a score_correction'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.operation_set_version <> OLD.operation_set_version AND OLD.status <> 'confirmed' THEN
    RAISE EXCEPTION 'only a confirmed score_match takes a correction'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER score_match_guard_confirmed BEFORE UPDATE ON score_match
  FOR EACH ROW EXECUTE FUNCTION score_match_guard_confirmed();

ALTER TABLE score_match ENABLE ROW LEVEL SECURITY;
CREATE POLICY score_match_tenant_isolation ON score_match
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());

-- ---------------------------------------------------------------------------
-- score_match_player
-- ---------------------------------------------------------------------------

CREATE TABLE score_match_player (
  score_match_player_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid        NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  score_match_id          uuid        NOT NULL,
  team_number             smallint    NOT NULL,
  slot_number             smallint    NOT NULL,
  display_name            text        NOT NULL,
  -- Optional: a walk-in partner has no party. DUPR submission needs one.
  party_id                uuid        REFERENCES party(party_id) ON DELETE SET NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT score_match_player_team_known CHECK (team_number IN (1, 2)),
  CONSTRAINT score_match_player_slot_positive CHECK (slot_number > 0),
  CONSTRAINT score_match_player_name_present CHECK (length(btrim(display_name)) > 0),
  CONSTRAINT score_match_player_slot_unique UNIQUE (score_match_id, team_number, slot_number),
  CONSTRAINT score_match_player_match_same_tenant FOREIGN KEY (organization_id, score_match_id)
    REFERENCES score_match(organization_id, score_match_id) ON DELETE CASCADE
);

COMMENT ON TABLE score_match_player IS
  'Who played on each team, by the name the scorer entered, optionally linked to a party. One row per player so a party link is a real foreign key rather than an unenforceable array.';

CREATE INDEX idx_score_match_player_organization ON score_match_player(organization_id);
CREATE INDEX idx_score_match_player_match ON score_match_player(organization_id, score_match_id);
CREATE INDEX idx_score_match_player_party ON score_match_player(party_id);

ALTER TABLE score_match_player ENABLE ROW LEVEL SECURITY;
CREATE POLICY score_match_player_tenant_isolation ON score_match_player
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());

-- ---------------------------------------------------------------------------
-- score_operation — append-only
-- ---------------------------------------------------------------------------

CREATE TABLE score_operation (
  score_operation_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid        NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  score_match_id          uuid        NOT NULL,
  operation_set_version   integer     NOT NULL DEFAULT 1,
  sequence_number         integer     NOT NULL,
  -- Minted by the tablet before it sends, so a retry after a dropped response
  -- is recognised and never applied twice.
  client_operation_id     text        NOT NULL,
  kind                    text        NOT NULL,
  payload                 jsonb       NOT NULL DEFAULT '{}'::jsonb,
  actor_id                uuid        REFERENCES actor(actor_id) ON DELETE SET NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT score_operation_kind_known CHECK (kind IN ('rally_won', 'undo', 'set_server', 'end_game', 'forfeit')),
  CONSTRAINT score_operation_sequence_positive CHECK (sequence_number > 0),
  CONSTRAINT score_operation_set_positive CHECK (operation_set_version > 0),
  CONSTRAINT score_operation_client_id_present CHECK (length(btrim(client_operation_id)) BETWEEN 1 AND 128),
  CONSTRAINT score_operation_client_unique UNIQUE (score_match_id, client_operation_id),
  CONSTRAINT score_operation_sequence_unique UNIQUE (score_match_id, operation_set_version, sequence_number),
  CONSTRAINT score_operation_match_same_tenant FOREIGN KEY (organization_id, score_match_id)
    REFERENCES score_match(organization_id, score_match_id) ON DELETE CASCADE
);

COMMENT ON TABLE score_operation IS
  'Every tap a scorer made, in order, never edited. The score is replay(profile, operations of the current set). client_operation_id makes a retried tap idempotent.';

CREATE INDEX idx_score_operation_organization ON score_operation(organization_id);
CREATE INDEX idx_score_operation_match ON score_operation(organization_id, score_match_id);
CREATE INDEX idx_score_operation_actor ON score_operation(actor_id);

CREATE FUNCTION score_reject_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER score_operation_append_only BEFORE UPDATE ON score_operation
  FOR EACH ROW EXECUTE FUNCTION score_reject_append_only();

ALTER TABLE score_operation ENABLE ROW LEVEL SECURITY;
CREATE POLICY score_operation_tenant_isolation ON score_operation
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());

-- ---------------------------------------------------------------------------
-- score_correction — the audit of a changed result
-- ---------------------------------------------------------------------------

CREATE TABLE score_correction (
  score_correction_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id                 uuid        NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  score_match_id                  uuid        NOT NULL,
  reason                          text        NOT NULL,
  actor_id                        uuid        REFERENCES actor(actor_id) ON DELETE SET NULL,
  previous_operation_set_version  integer     NOT NULL,
  operation_set_version           integer     NOT NULL,
  -- Game scores before and after, so the audit reads without a replay.
  previous_game_point             jsonb       NOT NULL,
  corrected_game_point            jsonb       NOT NULL,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT score_correction_reason_present CHECK (length(btrim(reason)) > 0),
  CONSTRAINT score_correction_version_forward CHECK (operation_set_version = previous_operation_set_version + 1),
  CONSTRAINT score_correction_version_unique UNIQUE (score_match_id, operation_set_version),
  CONSTRAINT score_correction_match_same_tenant FOREIGN KEY (organization_id, score_match_id)
    REFERENCES score_match(organization_id, score_match_id) ON DELETE CASCADE
);

COMMENT ON TABLE score_correction IS
  'Why a confirmed result changed, who changed it, and from what to what. Append-only: a correction of a correction is another row.';

CREATE INDEX idx_score_correction_organization ON score_correction(organization_id);
CREATE INDEX idx_score_correction_match ON score_correction(organization_id, score_match_id);
CREATE INDEX idx_score_correction_actor ON score_correction(actor_id);

CREATE TRIGGER score_correction_append_only BEFORE UPDATE ON score_correction
  FOR EACH ROW EXECUTE FUNCTION score_reject_append_only();

ALTER TABLE score_correction ENABLE ROW LEVEL SECURITY;
CREATE POLICY score_correction_tenant_isolation ON score_correction
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());
