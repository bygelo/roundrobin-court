-- court 014 — webhook: R21 signed, versioned, at-least-once event egress.
--
-- Three tables, one guarantee each:
--   webhook_subscription — where to send and which events; the signing secret
--                           is sealed (AES-256-GCM), never stored or returned raw
--                           after the response that created it.
--   webhook_event        — one CloudEvents 1.0 envelope per (event_code,
--                           subject_code). A duplicate emit hits the UNIQUE and
--                           is a no-op, so a producer can emit freely.
--   webhook_delivery     — one row per event x subscription, claimed with
--                           FOR UPDATE SKIP LOCKED inside the delivering
--                           transaction: a crash mid-delivery rolls the claim
--                           back, so the delivery is retried, never lost.

CREATE TABLE webhook_subscription (
  webhook_subscription_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid        NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  url                     text        NOT NULL,
  description             text,
  event_code              text[]      NOT NULL,
  -- sealSecret() output: v1:<iv>:<tag>:<cipher> under WEBHOOK_SIGNING_KEY.
  secret_envelope         text        NOT NULL,
  -- First characters of the secret so an operator can tell two secrets apart.
  secret_prefix           text        NOT NULL,
  is_active               boolean     NOT NULL DEFAULT true,
  rotated_at              timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  deleted_at              timestamptz,
  CONSTRAINT webhook_subscription_url_secure CHECK (
    url ~ '^https://[^\s/]+'
    OR url ~ '^http://(localhost|127\.0\.0\.1)(:[0-9]+)?(/|$)'
  ),
  CONSTRAINT webhook_subscription_event_present CHECK (cardinality(event_code) > 0),
  CONSTRAINT webhook_subscription_envelope_shape CHECK (secret_envelope LIKE 'v1:%')
);

COMMENT ON TABLE webhook_subscription IS
  'A third party that wants booking, payment, arrival, program, and result events pushed instead of polling. https only (plain http allowed for localhost development). The signing secret is sealed and shown to the operator exactly once.';
COMMENT ON COLUMN webhook_subscription.secret_envelope IS
  'AES-256-GCM envelope of the HMAC signing secret. Delivery must sign with the raw secret, so it is encrypted (not hashed) under WEBHOOK_SIGNING_KEY; the API never returns it after create or rotate.';

CREATE INDEX idx_webhook_subscription_organization ON webhook_subscription(organization_id) WHERE deleted_at IS NULL;

CREATE TRIGGER webhook_subscription_updated_at BEFORE UPDATE ON webhook_subscription
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE webhook_subscription ENABLE ROW LEVEL SECURITY;
CREATE POLICY webhook_subscription_tenant_isolation ON webhook_subscription
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());


CREATE TABLE webhook_event (
  -- Doubles as the CloudEvents id and the subscriber's idempotency key.
  webhook_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid        NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  event_code       text        NOT NULL,
  subject_code     text        NOT NULL,
  spec_version     text        NOT NULL DEFAULT '1.0',
  source           text        NOT NULL,
  data             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT webhook_event_code_known CHECK (event_code IN (
    'booking.held', 'booking.confirmed', 'booking.cancelled', 'payment.recorded',
    'arrival.checked_in', 'program.registered', 'match.confirmed', 'webhook.ping'
  )),
  CONSTRAINT webhook_event_subject_present CHECK (length(btrim(subject_code)) > 0),
  CONSTRAINT webhook_event_once UNIQUE (organization_id, event_code, subject_code)
);

COMMENT ON TABLE webhook_event IS
  'An immutable CloudEvents 1.0 envelope. UNIQUE (organization_id, event_code, subject_code) turns a duplicate emit into a no-op, so every subscriber sees one event id per business fact.';

CREATE INDEX idx_webhook_event_organization ON webhook_event(organization_id, occurred_at DESC);

ALTER TABLE webhook_event ENABLE ROW LEVEL SECURITY;
CREATE POLICY webhook_event_tenant_isolation ON webhook_event
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());


CREATE TABLE webhook_delivery (
  webhook_delivery_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid        NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  webhook_event_id        uuid        NOT NULL REFERENCES webhook_event(webhook_event_id) ON DELETE CASCADE,
  webhook_subscription_id uuid        NOT NULL REFERENCES webhook_subscription(webhook_subscription_id) ON DELETE CASCADE,
  -- pending: never tried or replayed. failed: tried, will retry at next_attempt_at.
  -- delivered: a 2xx was received. dead: attempts exhausted, waits for a replay.
  status                  text        NOT NULL DEFAULT 'pending',
  attempt_count           integer     NOT NULL DEFAULT 0,
  replay_count            integer     NOT NULL DEFAULT 0,
  next_attempt_at         timestamptz NOT NULL DEFAULT now(),
  last_attempted_at       timestamptz,
  last_status_code        integer,
  last_error              text,
  delivered_at            timestamptz,
  dead_at                 timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT webhook_delivery_status_known CHECK (status IN ('pending', 'delivered', 'failed', 'dead')),
  CONSTRAINT webhook_delivery_attempt_not_negative CHECK (attempt_count >= 0 AND replay_count >= 0),
  CONSTRAINT webhook_delivery_delivered_stamped CHECK ((status = 'delivered') = (delivered_at IS NOT NULL)),
  CONSTRAINT webhook_delivery_once UNIQUE (webhook_event_id, webhook_subscription_id)
);

COMMENT ON TABLE webhook_delivery IS
  'One event owed to one subscriber. Retries back off 1m x 2^n (capped at one hour) and stop at six attempts in the dead state, from which only an operator replay revives it.';

CREATE INDEX idx_webhook_delivery_organization ON webhook_delivery(organization_id, created_at DESC);
CREATE INDEX idx_webhook_delivery_due ON webhook_delivery(organization_id, next_attempt_at)
  WHERE status IN ('pending', 'failed');
CREATE INDEX idx_webhook_delivery_subscription ON webhook_delivery(webhook_subscription_id);
CREATE INDEX idx_webhook_delivery_event ON webhook_delivery(webhook_event_id);

CREATE TRIGGER webhook_delivery_updated_at BEFORE UPDATE ON webhook_delivery
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE webhook_delivery ENABLE ROW LEVEL SECURITY;
CREATE POLICY webhook_delivery_tenant_isolation ON webhook_delivery
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());
