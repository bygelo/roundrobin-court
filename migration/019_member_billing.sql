-- court 019 — member billing: R15 recurring billing for membership.
--
-- A plan now says how it is invoiced (billing_interval_code). A membership on a
-- billed plan gets one member_billing row — its auto-renew switch, billing
-- anchor, current period, and renewal state — and one member_billing_period row
-- per period it was invoiced for. Money itself lives in the billing pack
-- (invoice, line, payment); these rows only point at it.
--
-- Idempotency is structural: a period is UNIQUE per membership and start date,
-- so a renewal job that runs twice, or twice at once, raises one invoice; and
-- is_applied flips false→true once, so a paid renewal extends the membership once.

-- ---------------------------------------------------------------------------
-- member_plan.billing_interval_code
-- ---------------------------------------------------------------------------

ALTER TABLE member_plan ADD COLUMN billing_interval_code text NOT NULL DEFAULT 'none';

ALTER TABLE member_plan ADD CONSTRAINT member_plan_billing_interval_known
  CHECK (billing_interval_code IN ('none', 'monthly', 'annual'));

-- A billed plan is a membership invoiced once per its own period, for a price.
ALTER TABLE member_plan ADD CONSTRAINT member_plan_billing_interval_shape CHECK (
  billing_interval_code = 'none'
  OR (plan_kind_code = 'membership' AND billing_interval_code = billing_period_code AND price_amount > 0)
);

COMMENT ON COLUMN member_plan.billing_interval_code IS
  'none = the desk collects by hand (no invoice); monthly | annual = each period is invoiced through the billing pack, and must equal billing_period_code.';

-- ---------------------------------------------------------------------------
-- member_billing
-- ---------------------------------------------------------------------------

CREATE TABLE member_billing (
  member_billing_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid        NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  membership_id            uuid        NOT NULL,
  member_plan_id           uuid        NOT NULL,
  party_id                 uuid        NOT NULL,
  is_auto_renew            boolean     NOT NULL DEFAULT true,
  anchor_on                date        NOT NULL,
  period_index             integer     NOT NULL DEFAULT 0,
  current_period_start_on  date        NOT NULL,
  current_period_end_on    date        NOT NULL,
  renewal_state_code       text        NOT NULL DEFAULT 'pending_payment',
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT member_billing_membership_key UNIQUE (organization_id, membership_id),
  CONSTRAINT member_billing_tenant_key UNIQUE (organization_id, member_billing_id),
  CONSTRAINT member_billing_state_known CHECK (renewal_state_code IN ('pending_payment', 'active', 'lapsed')),
  CONSTRAINT member_billing_period_ordered CHECK (current_period_end_on > current_period_start_on),
  CONSTRAINT member_billing_index_nonneg CHECK (period_index >= 0)
);

COMMENT ON TABLE member_billing IS
  'How a membership on a billed plan renews: auto-renew switch, the anchor date periods are counted from (month-end safe), the period it is in, and its renewal state (pending_payment until the first invoice is paid, active, lapsed after an unpaid renewal outlives the grace).';

COMMENT ON COLUMN member_billing.anchor_on IS
  'Venue-local date of the first period. Period N runs anchor + N intervals to anchor + N+1 intervals, clamped to month end.';

ALTER TABLE member_billing
  ADD CONSTRAINT member_billing_membership_same_tenant
  FOREIGN KEY (organization_id, membership_id)
  REFERENCES membership(organization_id, membership_id)
  ON DELETE CASCADE;

ALTER TABLE member_billing
  ADD CONSTRAINT member_billing_plan_same_tenant
  FOREIGN KEY (organization_id, member_plan_id)
  REFERENCES member_plan(organization_id, member_plan_id)
  ON DELETE RESTRICT;

ALTER TABLE member_billing
  ADD CONSTRAINT member_billing_party_same_tenant
  FOREIGN KEY (organization_id, party_id)
  REFERENCES party(organization_id, party_id)
  ON DELETE CASCADE;

CREATE INDEX idx_member_billing_organization ON member_billing(organization_id);
CREATE INDEX idx_member_billing_renewal ON member_billing(organization_id, renewal_state_code, current_period_end_on);
CREATE INDEX idx_member_billing_membership_id ON member_billing(membership_id);
CREATE INDEX idx_member_billing_member_plan_id ON member_billing(member_plan_id);
CREATE INDEX idx_member_billing_party_id ON member_billing(party_id);

CREATE TRIGGER member_billing_updated_at BEFORE UPDATE ON member_billing
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE member_billing ENABLE ROW LEVEL SECURITY;
CREATE POLICY member_billing_tenant_isolation ON member_billing
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());

-- ---------------------------------------------------------------------------
-- member_billing_period
-- ---------------------------------------------------------------------------

CREATE TABLE member_billing_period (
  member_billing_period_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid          NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  member_billing_id        uuid          NOT NULL,
  membership_id            uuid          NOT NULL,
  period_index             integer       NOT NULL,
  period_start_on          date          NOT NULL,
  period_end_on            date          NOT NULL,
  invoice_id               uuid,
  price_amount             numeric(12,2) NOT NULL,
  is_applied               boolean       NOT NULL DEFAULT false,
  applied_at               timestamptz,
  created_at               timestamptz   NOT NULL DEFAULT now(),
  updated_at               timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT member_billing_period_start_key UNIQUE (organization_id, membership_id, period_start_on),
  CONSTRAINT member_billing_period_index_key UNIQUE (organization_id, membership_id, period_index),
  CONSTRAINT member_billing_period_invoice_key UNIQUE (organization_id, invoice_id),
  CONSTRAINT member_billing_period_ordered CHECK (period_end_on > period_start_on),
  CONSTRAINT member_billing_period_price_positive CHECK (price_amount > 0),
  CONSTRAINT member_billing_period_applied_at CHECK (is_applied = (applied_at IS NOT NULL))
);

COMMENT ON TABLE member_billing_period IS
  'One invoiced period of a billed membership. UNIQUE per membership and start date, so a renewal job run twice or concurrently raises one invoice; is_applied flips once, so a paid period extends the membership once.';

ALTER TABLE member_billing_period
  ADD CONSTRAINT member_billing_period_billing_same_tenant
  FOREIGN KEY (organization_id, member_billing_id)
  REFERENCES member_billing(organization_id, member_billing_id)
  ON DELETE CASCADE;

ALTER TABLE member_billing_period
  ADD CONSTRAINT member_billing_period_membership_same_tenant
  FOREIGN KEY (organization_id, membership_id)
  REFERENCES membership(organization_id, membership_id)
  ON DELETE CASCADE;

ALTER TABLE member_billing_period
  ADD CONSTRAINT member_billing_period_invoice_same_tenant
  FOREIGN KEY (organization_id, invoice_id)
  REFERENCES invoice(organization_id, invoice_id)
  ON DELETE SET NULL (invoice_id);

CREATE INDEX idx_member_billing_period_organization ON member_billing_period(organization_id);
CREATE INDEX idx_member_billing_period_unapplied ON member_billing_period(organization_id) WHERE is_applied = false;
CREATE INDEX idx_member_billing_period_member_billing_id ON member_billing_period(member_billing_id);
CREATE INDEX idx_member_billing_period_membership_id ON member_billing_period(membership_id);
CREATE INDEX idx_member_billing_period_invoice_id ON member_billing_period(invoice_id);

CREATE TRIGGER member_billing_period_updated_at BEFORE UPDATE ON member_billing_period
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE member_billing_period ENABLE ROW LEVEL SECURITY;
CREATE POLICY member_billing_period_tenant_isolation ON member_billing_period
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());
