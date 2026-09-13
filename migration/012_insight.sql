-- court 012 — insight: R16 owner insight and accounting export.
--
-- Insight is a report, not a ledger. Every figure it shows is derived at read
-- time from records other modules already own: booking (occupancy, status),
-- billing (payment, refund, allocation), commerce (sales_order, inventory),
-- notification and connector (health). Nothing here stores a total.
--
-- The one fact no pack records is WHICH LINE OF BUSINESS a billing invoice or
-- payment belongs to. Court bookings and shop sales are recognisable by their
-- own link tables (portal_payment, portal_booking, shop_sale, shop_refund); a
-- program fee or a membership sold at the desk is not. insight_revenue_tag is
-- that classification, written by a module that sells something or by an
-- operator re-classifying an "other" payment. Absent a tag, insight falls back
-- to the link tables and finally to 'other' — money is never dropped.

CREATE TABLE insight_revenue_tag (
  insight_revenue_tag_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        uuid        NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  invoice_id             uuid,
  payment_id             uuid,
  source_code            text        NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  deleted_at             timestamptz,
  CONSTRAINT insight_revenue_tag_source_known CHECK (
    source_code IN ('court_booking', 'program', 'shop', 'membership', 'other')
  ),
  CONSTRAINT insight_revenue_tag_one_subject CHECK (num_nonnulls(invoice_id, payment_id) = 1),
  -- One classification per invoice and per payment. NULLs are distinct, so an
  -- invoice tag and a payment tag never collide. These also cover the FKs below.
  CONSTRAINT insight_revenue_tag_invoice_key UNIQUE (organization_id, invoice_id),
  CONSTRAINT insight_revenue_tag_payment_key UNIQUE (organization_id, payment_id),
  CONSTRAINT insight_revenue_tag_invoice_same_tenant
    FOREIGN KEY (organization_id, invoice_id) REFERENCES invoice(organization_id, invoice_id) ON DELETE CASCADE,
  CONSTRAINT insight_revenue_tag_payment_same_tenant
    FOREIGN KEY (organization_id, payment_id) REFERENCES payment(organization_id, payment_id) ON DELETE CASCADE
);

COMMENT ON TABLE insight_revenue_tag IS
  'Which line of business (court booking, program, shop, membership, other) a billing invoice or payment belongs to, so revenue by source and the journal export credit the right revenue account. Billing records money but not its purpose; this is the only fact insight stores. A tag on the payment wins over a tag on the invoice it cleared.';

COMMENT ON COLUMN insight_revenue_tag.source_code IS
  'court_booking · program · shop · membership · other. Fixed because each maps to one revenue account in the journal export; a new source is a new account and a migration.';

CREATE INDEX idx_insight_revenue_tag_organization ON insight_revenue_tag(organization_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_insight_revenue_tag_invoice ON insight_revenue_tag(invoice_id);
CREATE INDEX idx_insight_revenue_tag_payment ON insight_revenue_tag(payment_id);

CREATE TRIGGER insight_revenue_tag_updated_at BEFORE UPDATE ON insight_revenue_tag
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE insight_revenue_tag ENABLE ROW LEVEL SECURITY;
CREATE POLICY insight_revenue_tag_tenant_isolation ON insight_revenue_tag
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());
