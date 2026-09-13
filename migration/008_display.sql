-- court 008 — display: R13 display surfaces.
--
-- The output pack already owns what a screen IS: display_configuration,
-- display_device (credential hash, heartbeat, revoke), display_state. What it
-- cannot know is what a court venue puts on one. display_screen is that one
-- fact: this enrolled device is the lounge board, the counter, or Court 1's
-- scoreboard. The projection for it is built fresh on every pull, scoped to
-- exactly that kind — never a customer's contact details.

CREATE TABLE display_screen (
  display_screen_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           uuid        NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  display_device_id         uuid        NOT NULL,
  display_configuration_id  uuid        NOT NULL,
  kind                      text        NOT NULL,
  display_name              text        NOT NULL,
  -- The court a court screen shows. Lounge and counter screens show the venue.
  resource_id               uuid,
  created_by_actor_id       uuid        REFERENCES actor(actor_id) ON DELETE SET NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  deleted_at                timestamptz,
  CONSTRAINT display_screen_kind_known CHECK (kind IN ('court', 'lounge', 'counter')),
  CONSTRAINT display_screen_court_has_resource CHECK ((kind = 'court') = (resource_id IS NOT NULL)),
  CONSTRAINT display_screen_name_present CHECK (length(btrim(display_name)) BETWEEN 1 AND 80),
  CONSTRAINT display_screen_device_unique UNIQUE (display_device_id),
  CONSTRAINT display_screen_device_same_tenant FOREIGN KEY (organization_id, display_device_id)
    REFERENCES display_device(organization_id, display_device_id) ON DELETE CASCADE,
  CONSTRAINT display_screen_configuration_same_tenant FOREIGN KEY (organization_id, display_configuration_id)
    REFERENCES display_configuration(organization_id, display_configuration_id) ON DELETE CASCADE,
  CONSTRAINT display_screen_resource_same_tenant FOREIGN KEY (organization_id, resource_id)
    REFERENCES resource(organization_id, resource_id) ON DELETE CASCADE
);

COMMENT ON TABLE display_screen IS
  'Which court-venue view an output-pack device shows: one court''s scoreboard, the lounge board, or the counter. The device, its credential, heartbeat, and revocation stay in the output pack; this row only says what to project for it.';

COMMENT ON COLUMN display_screen.kind IS
  'court: one court''s booking and live score. lounge: every court''s live match plus open play. counter: next available slots and today''s arrivals. The projection for each is read-only and scoped to exactly that view.';

CREATE INDEX idx_display_screen_organization ON display_screen(organization_id);
CREATE INDEX idx_display_screen_configuration ON display_screen(organization_id, display_configuration_id);
CREATE INDEX idx_display_screen_resource ON display_screen(organization_id, resource_id);
CREATE INDEX idx_display_screen_created_by ON display_screen(created_by_actor_id);

CREATE TRIGGER display_screen_updated_at BEFORE UPDATE ON display_screen
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE display_screen ENABLE ROW LEVEL SECURITY;
CREATE POLICY display_screen_tenant_isolation ON display_screen
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());

-- ---------------------------------------------------------------------------
-- pre-tenant lookup: screen credential hash -> organization
-- ---------------------------------------------------------------------------
--
-- A TV presents only its credential, so which venue it belongs to is
-- necessarily found before a tenant is bound. display_device is RLS-forced, so
-- under the non-superuser application role a plain SELECT sees nothing and
-- every screen would be refused. The kernel solves the identical problem for
-- sign-in with resolve_organization_by_code(); this is the same shape: one
-- exact-hash match, one id out, nothing to enumerate.

CREATE FUNCTION display_resolve_organization_by_credential(lookup_credential_hash text)
  RETURNS uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT d.organization_id
  FROM display_device d
  JOIN display_screen s ON s.organization_id = d.organization_id AND s.display_device_id = d.display_device_id
  WHERE d.credential_hash = lookup_credential_hash
    AND d.is_active
    AND d.deleted_at IS NULL
    AND d.revoked_at IS NULL
    AND s.deleted_at IS NULL
$$;

COMMENT ON FUNCTION display_resolve_organization_by_credential(text) IS
  'Pre-tenant lookup for a court display screen. SECURITY DEFINER because display_device is RLS-forced and no tenant is bound yet. Exact credential-hash match on a live screen; returns an organization id or NULL and nothing else, so an unknown and a revoked credential are indistinguishable.';

-- Granted to the application role by name at deploy time (script/app-role.ts
-- grants EXECUTE on the schema's functions), never to PUBLIC.
REVOKE EXECUTE ON FUNCTION display_resolve_organization_by_credential(text) FROM PUBLIC;
