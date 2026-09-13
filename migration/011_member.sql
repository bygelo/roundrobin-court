-- court 011 — member: R15 membership and entitlement.
--
-- The membership pack owns membership_plan, membership (party on a plan for a
-- window, with freeze), and pass (a use-limited ticket). It deliberately holds
-- no price: "pricing lives in billing/commerce". A venue's member price is a
-- rule about court bookings, so it lives here, in the app:
--   member_plan            — what a plan costs and what it does to a booking;
--   member_pass            — which plan a pack pass was issued from;
--   member_session_rule    — which booking sessions are for members only;
--   member_entitlement_use — one row per consumed use, unique per subject, so a
--                            retried booking confirmation never spends twice.

-- ---------------------------------------------------------------------------
-- member_plan
-- ---------------------------------------------------------------------------

CREATE TABLE member_plan (
  member_plan_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           uuid          NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  membership_plan_id        uuid          NOT NULL,
  plan_kind_code            text          NOT NULL,
  price_amount              numeric(12,2) NOT NULL,
  billing_period_code       text,
  price_rule_code           text          NOT NULL DEFAULT 'none',
  percent_off               numeric(5,2),
  fixed_price_amount        numeric(12,2),
  is_member_session_access  boolean       NOT NULL DEFAULT false,
  session_count             integer,
  valid_day_count           integer,
  created_at                timestamptz   NOT NULL DEFAULT now(),
  updated_at                timestamptz   NOT NULL DEFAULT now(),
  deleted_at                timestamptz,
  CONSTRAINT member_plan_membership_plan_key UNIQUE (organization_id, membership_plan_id),
  CONSTRAINT member_plan_kind_known CHECK (plan_kind_code IN ('membership', 'pass')),
  CONSTRAINT member_plan_price_nonneg CHECK (price_amount >= 0),
  CONSTRAINT member_plan_rule_known CHECK (price_rule_code IN ('none', 'percent_off', 'fixed_price')),
  CONSTRAINT member_plan_rule_value CHECK (
    (price_rule_code = 'none' AND percent_off IS NULL AND fixed_price_amount IS NULL)
    OR (price_rule_code = 'percent_off' AND percent_off > 0 AND percent_off <= 100 AND fixed_price_amount IS NULL)
    OR (price_rule_code = 'fixed_price' AND fixed_price_amount >= 0 AND percent_off IS NULL)
  ),
  -- A membership is a period with a price rule; a pass is N sessions valid for
  -- D days that covers the booking outright.
  CONSTRAINT member_plan_kind_shape CHECK (
    (plan_kind_code = 'membership' AND billing_period_code IN ('monthly', 'annual')
       AND session_count IS NULL AND valid_day_count IS NULL)
    OR (plan_kind_code = 'pass' AND billing_period_code IS NULL AND price_rule_code = 'none'
       AND is_member_session_access = false AND session_count > 0 AND valid_day_count > 0)
  )
);

COMMENT ON TABLE member_plan IS
  'The venue half of a membership plan: its price, its period or session count, and the rule it applies to court bookings. The pack plan row is the entitlement shape; this row is what a member pays and saves.';

COMMENT ON COLUMN member_plan.is_member_session_access IS
  'When true, holders may book sessions flagged members-only in member_session_rule.';

ALTER TABLE member_plan
  ADD CONSTRAINT member_plan_membership_plan_same_tenant
  FOREIGN KEY (organization_id, membership_plan_id)
  REFERENCES membership_plan(organization_id, membership_plan_id)
  ON DELETE CASCADE;

ALTER TABLE member_plan ADD CONSTRAINT member_plan_tenant_key UNIQUE (organization_id, member_plan_id);

CREATE INDEX idx_member_plan_organization ON member_plan(organization_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_member_plan_membership_plan_id ON member_plan(membership_plan_id);

CREATE TRIGGER member_plan_updated_at BEFORE UPDATE ON member_plan
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE member_plan ENABLE ROW LEVEL SECURITY;
CREATE POLICY member_plan_tenant_isolation ON member_plan
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());

-- ---------------------------------------------------------------------------
-- member_pass
-- ---------------------------------------------------------------------------

CREATE TABLE member_pass (
  member_pass_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid        NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  pass_id          uuid        NOT NULL,
  member_plan_id   uuid        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT member_pass_pass_key UNIQUE (organization_id, pass_id)
);

COMMENT ON TABLE member_pass IS
  'Which plan a pack pass was sold from, so a front desk reads "10-Session Pass, 7 left" instead of a pass code.';

ALTER TABLE member_pass
  ADD CONSTRAINT member_pass_pass_same_tenant
  FOREIGN KEY (organization_id, pass_id)
  REFERENCES pass(organization_id, pass_id)
  ON DELETE CASCADE;

ALTER TABLE member_pass
  ADD CONSTRAINT member_pass_plan_same_tenant
  FOREIGN KEY (organization_id, member_plan_id)
  REFERENCES member_plan(organization_id, member_plan_id)
  ON DELETE RESTRICT;

CREATE INDEX idx_member_pass_pass_id ON member_pass(pass_id);
CREATE INDEX idx_member_pass_member_plan_id ON member_pass(member_plan_id);

ALTER TABLE member_pass ENABLE ROW LEVEL SECURITY;
CREATE POLICY member_pass_tenant_isolation ON member_pass
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());

-- ---------------------------------------------------------------------------
-- member_session_rule
-- ---------------------------------------------------------------------------

CREATE TABLE member_session_rule (
  member_session_rule_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        uuid        NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  session_id             uuid        NOT NULL REFERENCES session(session_id) ON DELETE CASCADE,
  is_member_only         boolean     NOT NULL DEFAULT true,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT member_session_rule_session_key UNIQUE (organization_id, session_id)
);

COMMENT ON TABLE member_session_rule IS
  'How a booking session is flagged members-only. Keyed by session because a session is what a player books; a missing row means open to everyone.';

CREATE INDEX idx_member_session_rule_session_id ON member_session_rule(session_id);

CREATE TRIGGER member_session_rule_updated_at BEFORE UPDATE ON member_session_rule
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE member_session_rule ENABLE ROW LEVEL SECURITY;
CREATE POLICY member_session_rule_tenant_isolation ON member_session_rule
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());

-- ---------------------------------------------------------------------------
-- member_entitlement_use
-- ---------------------------------------------------------------------------

CREATE TABLE member_entitlement_use (
  member_entitlement_use_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           uuid        NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  party_id                  uuid        NOT NULL,
  pass_id                   uuid,
  entitlement_code          text        NOT NULL,
  subject_code              text        NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT member_entitlement_use_subject_key UNIQUE (organization_id, entitlement_code, subject_code),
  CONSTRAINT member_entitlement_use_subject_present CHECK (btrim(subject_code) <> '')
);

COMMENT ON TABLE member_entitlement_use IS
  'One consumed use of an entitlement, e.g. a pass session spent on a booking. Unique per (entitlement, subject) so replaying a confirmation spends nothing twice. Append-only.';

ALTER TABLE member_entitlement_use
  ADD CONSTRAINT member_entitlement_use_party_same_tenant
  FOREIGN KEY (organization_id, party_id)
  REFERENCES party(organization_id, party_id)
  ON DELETE CASCADE;

ALTER TABLE member_entitlement_use
  ADD CONSTRAINT member_entitlement_use_pass_same_tenant
  FOREIGN KEY (organization_id, pass_id)
  REFERENCES pass(organization_id, pass_id)
  ON DELETE SET NULL (pass_id);

CREATE INDEX idx_member_entitlement_use_party_id ON member_entitlement_use(party_id);
CREATE INDEX idx_member_entitlement_use_pass_id ON member_entitlement_use(pass_id);

ALTER TABLE member_entitlement_use ENABLE ROW LEVEL SECURITY;
CREATE POLICY member_entitlement_use_tenant_isolation ON member_entitlement_use
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());
