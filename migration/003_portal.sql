-- court 003 — portal: R05 public booking and R07 payment.
--
-- The booking pack owns occupancy (booking + its EXCLUDE constraint) and the
-- billing pack owns money (invoice, payment, refund). What neither knows is the
-- guest who booked from the public page without an account: the contact they
-- typed, the recovery credential they were handed once, the cancellation cutoff
-- they were shown, and which billing payment belongs to which booking. That is
-- all this file adds. Nothing here duplicates a pack column.

-- ---------------------------------------------------------------------------
-- portal_setting — the venue's checkout choices
-- ---------------------------------------------------------------------------

CREATE TABLE portal_setting (
  portal_setting_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id             uuid        NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  is_counter_payment_allowed  boolean     NOT NULL DEFAULT true,
  counter_instruction         text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT portal_setting_one_per_organization UNIQUE (organization_id),
  CONSTRAINT portal_setting_instruction_length CHECK (counter_instruction IS NULL OR length(counter_instruction) <= 500)
);

COMMENT ON TABLE portal_setting IS
  'Whether a guest may reserve now and pay at the counter, and what they are told to do. One row per venue; a venue with no row gets the defaults (counter allowed, generic instruction).';

CREATE TRIGGER portal_setting_updated_at BEFORE UPDATE ON portal_setting
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE portal_setting ENABLE ROW LEVEL SECURITY;
CREATE POLICY portal_setting_tenant_isolation ON portal_setting
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());

-- ---------------------------------------------------------------------------
-- portal_booking — a guest booking made from the public page
-- ---------------------------------------------------------------------------

CREATE TABLE portal_booking (
  portal_booking_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid          NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  booking_id              uuid          NOT NULL REFERENCES booking(booking_id) ON DELETE CASCADE,
  party_id                uuid          NOT NULL REFERENCES party(party_id) ON DELETE CASCADE,
  invoice_id              uuid          REFERENCES invoice(invoice_id) ON DELETE SET NULL,
  -- sha256 of the recovery token. The token itself is returned once and never stored.
  recovery_token_hash     text          NOT NULL,
  contact_display_name    text          NOT NULL,
  contact_email           text          NOT NULL,
  contact_phone           text          NOT NULL,
  base_amount             numeric(12,2) NOT NULL,
  total_amount            numeric(12,2) NOT NULL,
  entitlement_code        text,
  cancellation_cutoff_at  timestamptz   NOT NULL,
  is_pay_at_counter       boolean       NOT NULL DEFAULT false,
  online_adapter_code     text,
  online_provider_ref     text,
  online_checkout_url     text,
  created_at              timestamptz   NOT NULL DEFAULT now(),
  updated_at              timestamptz   NOT NULL DEFAULT now(),
  deleted_at              timestamptz,
  CONSTRAINT portal_booking_one_per_booking UNIQUE (booking_id),
  CONSTRAINT portal_booking_recovery_token_unique UNIQUE (recovery_token_hash),
  CONSTRAINT portal_booking_amount_not_negative CHECK (base_amount >= 0 AND total_amount >= 0),
  CONSTRAINT portal_booking_token_hash_shape CHECK (recovery_token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT portal_booking_contact_present CHECK (
    length(btrim(contact_display_name)) > 0 AND length(btrim(contact_email)) > 0 AND length(btrim(contact_phone)) > 0
  )
);

COMMENT ON TABLE portal_booking IS
  'The guest side of a booking taken on the public page: who to contact, the hashed recovery credential that lets them return without an account, the price and cancellation cutoff they were shown, and the online checkout reference. Occupancy stays in booking; money stays in billing.';

COMMENT ON COLUMN portal_booking.recovery_token_hash IS
  'sha256 hex of a random 128-bit token returned exactly once at checkout. A database read never yields a usable credential.';

COMMENT ON COLUMN portal_booking.cancellation_cutoff_at IS
  'Snapshot of starts_at minus the policy cutoff at booking time, so a later policy change never moves a promise already made to a guest.';

CREATE INDEX idx_portal_booking_organization ON portal_booking(organization_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_portal_booking_party ON portal_booking(party_id);
CREATE INDEX idx_portal_booking_invoice ON portal_booking(invoice_id);
CREATE INDEX idx_portal_booking_provider_ref ON portal_booking(online_provider_ref) WHERE online_provider_ref IS NOT NULL;

CREATE TRIGGER portal_booking_updated_at BEFORE UPDATE ON portal_booking
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE portal_booking ENABLE ROW LEVEL SECURITY;
CREATE POLICY portal_booking_tenant_isolation ON portal_booking
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());

-- ---------------------------------------------------------------------------
-- portal_payment — which billing payment settles which booking
-- ---------------------------------------------------------------------------

CREATE TABLE portal_payment (
  portal_payment_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid        NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  portal_booking_id  uuid        NOT NULL REFERENCES portal_booking(portal_booking_id) ON DELETE CASCADE,
  payment_id         uuid        NOT NULL REFERENCES payment(payment_id) ON DELETE CASCADE,
  payment_kind_code  text        NOT NULL,
  method_code        text        NOT NULL,
  reference          text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT portal_payment_one_link UNIQUE (payment_id),
  CONSTRAINT portal_payment_kind CHECK (payment_kind_code IN ('online', 'counter')),
  CONSTRAINT portal_payment_method CHECK (method_code IN ('online', 'cash', 'gcash', 'card_terminal'))
);

COMMENT ON TABLE portal_payment IS
  'Links a billing payment to the booking it pays for. Billing allocates a party''s payments FIFO across that party''s invoices, so the booking''s own paid state is read from here, never inferred from invoice balances.';

-- The "never charge twice" guarantee: at most one online payment per booking.
CREATE UNIQUE INDEX portal_payment_one_online_per_booking
  ON portal_payment(portal_booking_id) WHERE payment_kind_code = 'online';

CREATE INDEX idx_portal_payment_organization ON portal_payment(organization_id);
CREATE INDEX idx_portal_payment_booking ON portal_payment(portal_booking_id);

ALTER TABLE portal_payment ENABLE ROW LEVEL SECURITY;
CREATE POLICY portal_payment_tenant_isolation ON portal_payment
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());
