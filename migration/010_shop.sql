-- court 010 — shop: R14 commerce and inventory surface.
--
-- The commerce pack already owns catalog, variant, inventory, sales_order,
-- line, fulfilment and the inventory_movement ledger (which records every stock
-- adjustment with its actor and note). Billing owns payment and refund.
--
-- What neither pack models, and a venue counter needs, lives here:
--   shop_product — the shelf category and the low-stock threshold of a catalog;
--   shop_sale    — how a counter sale was paid (method, tendered, change) and
--                  whether the customer has collected it;
--   shop_refund  — which billing refund belongs to which order, why, and
--                  whether the stock went back on the shelf.

-- ---------------------------------------------------------------------------
-- shop_product
-- ---------------------------------------------------------------------------

CREATE TABLE shop_product (
  shop_product_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           uuid        NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  catalog_id                uuid        NOT NULL,
  category_name             text        NOT NULL DEFAULT 'Other',
  low_stock_threshold_count integer     NOT NULL DEFAULT 0,
  sort_order                integer     NOT NULL DEFAULT 0,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  deleted_at                timestamptz,
  CONSTRAINT shop_product_catalog_key UNIQUE (organization_id, catalog_id),
  CONSTRAINT shop_product_threshold_nonneg CHECK (low_stock_threshold_count >= 0),
  CONSTRAINT shop_product_category_present CHECK (btrim(category_name) <> '')
);

COMMENT ON TABLE shop_product IS
  'Venue shelf facts the commerce catalog does not carry: which category a product sits under on the public catalog and counter, and the stock level at which the desk is warned to reorder.';

COMMENT ON COLUMN shop_product.low_stock_threshold_count IS
  'A variant at or below this many units reads as Low stock. 0 means only Out of stock is flagged.';

ALTER TABLE shop_product
  ADD CONSTRAINT shop_product_catalog_same_tenant
  FOREIGN KEY (organization_id, catalog_id)
  REFERENCES catalog(organization_id, catalog_id)
  ON DELETE CASCADE;

CREATE INDEX idx_shop_product_organization ON shop_product(organization_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_shop_product_catalog_id ON shop_product(catalog_id);

CREATE TRIGGER shop_product_updated_at BEFORE UPDATE ON shop_product
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE shop_product ENABLE ROW LEVEL SECURITY;
CREATE POLICY shop_product_tenant_isolation ON shop_product
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());

-- ---------------------------------------------------------------------------
-- shop_sale
-- ---------------------------------------------------------------------------

CREATE TABLE shop_sale (
  shop_sale_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid          NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  sales_order_id        uuid          NOT NULL,
  payment_id            uuid          NOT NULL,
  actor_id              uuid          REFERENCES actor(actor_id) ON DELETE SET NULL,
  payment_method_code   text          NOT NULL,
  payment_reference     text,
  paid_amount           numeric(12,2) NOT NULL,
  tendered_amount       numeric(12,2),
  change_amount         numeric(12,2) NOT NULL DEFAULT 0,
  pickup_status_code    text          NOT NULL DEFAULT 'picked_up',
  ready_at              timestamptz,
  picked_up_at          timestamptz,
  created_at            timestamptz   NOT NULL DEFAULT now(),
  updated_at            timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT shop_sale_order_key UNIQUE (organization_id, sales_order_id),
  CONSTRAINT shop_sale_method_known CHECK (payment_method_code IN ('cash', 'gcash', 'card_terminal')),
  CONSTRAINT shop_sale_paid_positive CHECK (paid_amount >= 0),
  CONSTRAINT shop_sale_change_nonneg CHECK (change_amount >= 0),
  -- Cash carries what was handed over and the change is exactly the difference;
  -- other methods never hand change back.
  CONSTRAINT shop_sale_cash_tendered CHECK (
    (payment_method_code = 'cash' AND tendered_amount IS NOT NULL
       AND tendered_amount >= paid_amount AND change_amount = tendered_amount - paid_amount)
    OR (payment_method_code <> 'cash' AND tendered_amount IS NULL AND change_amount = 0)
  ),
  CONSTRAINT shop_sale_pickup_known CHECK (pickup_status_code IN ('waiting', 'ready', 'picked_up')),
  CONSTRAINT shop_sale_picked_up_at CHECK ((pickup_status_code = 'picked_up') = (picked_up_at IS NOT NULL))
);

COMMENT ON TABLE shop_sale IS
  'One counter sale: the commerce order it placed, the billing payment that paid it, the change handed back, and whether the customer has collected the goods. Billing and commerce each hold half of a sale; this row is the receipt that joins them.';

COMMENT ON COLUMN shop_sale.pickup_status_code IS
  'waiting = paid, set aside; ready = at the counter for collection; picked_up = in the customer''s hands. A walk-up sale is picked_up at once.';

ALTER TABLE shop_sale
  ADD CONSTRAINT shop_sale_order_same_tenant
  FOREIGN KEY (organization_id, sales_order_id)
  REFERENCES sales_order(organization_id, sales_order_id)
  ON DELETE CASCADE;

ALTER TABLE shop_sale
  ADD CONSTRAINT shop_sale_payment_same_tenant
  FOREIGN KEY (organization_id, payment_id)
  REFERENCES payment(organization_id, payment_id)
  ON DELETE RESTRICT;

CREATE INDEX idx_shop_sale_organization ON shop_sale(organization_id, created_at DESC);
CREATE INDEX idx_shop_sale_sales_order_id ON shop_sale(sales_order_id);
CREATE INDEX idx_shop_sale_payment_id ON shop_sale(payment_id);
CREATE INDEX idx_shop_sale_actor_id ON shop_sale(actor_id);

CREATE TRIGGER shop_sale_updated_at BEFORE UPDATE ON shop_sale
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE shop_sale ENABLE ROW LEVEL SECURITY;
CREATE POLICY shop_sale_tenant_isolation ON shop_sale
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());

-- ---------------------------------------------------------------------------
-- shop_refund
-- ---------------------------------------------------------------------------

CREATE TABLE shop_refund (
  shop_refund_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid          NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  shop_sale_id     uuid          NOT NULL REFERENCES shop_sale(shop_sale_id) ON DELETE CASCADE,
  refund_id        uuid          NOT NULL,
  actor_id         uuid          REFERENCES actor(actor_id) ON DELETE SET NULL,
  refund_amount    numeric(12,2) NOT NULL,
  reason           text          NOT NULL,
  is_restock       boolean       NOT NULL DEFAULT false,
  created_at       timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT shop_refund_refund_key UNIQUE (organization_id, refund_id),
  CONSTRAINT shop_refund_amount_positive CHECK (refund_amount > 0),
  CONSTRAINT shop_refund_reason_present CHECK (btrim(reason) <> '')
);

COMMENT ON TABLE shop_refund IS
  'Why money went back on a counter sale and whether the goods returned to stock. The money itself is a billing refund (which refuses more than was paid); the stock return is a commerce refund movement traceable to the order.';

ALTER TABLE shop_refund
  ADD CONSTRAINT shop_refund_refund_same_tenant
  FOREIGN KEY (organization_id, refund_id)
  REFERENCES refund(organization_id, refund_id)
  ON DELETE RESTRICT;

-- At most one restock per sale: commerce restores every line once.
CREATE UNIQUE INDEX shop_refund_one_restock ON shop_refund (organization_id, shop_sale_id) WHERE is_restock;

CREATE INDEX idx_shop_refund_shop_sale_id ON shop_refund(shop_sale_id);
CREATE INDEX idx_shop_refund_refund_id ON shop_refund(refund_id);
CREATE INDEX idx_shop_refund_actor_id ON shop_refund(actor_id);
CREATE INDEX idx_shop_refund_organization ON shop_refund(organization_id);

ALTER TABLE shop_refund ENABLE ROW LEVEL SECURITY;
CREATE POLICY shop_refund_tenant_isolation ON shop_refund
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());
