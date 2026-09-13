-- court 016 — message: R22 transactional notification.
--
-- The notification pack owns the outbox (notification_delivery), the provider
-- adapters, and per-channel consent (notification_preference). This module adds
-- the three things a venue needs on top and the pack deliberately does not know:
--
--   message_template   — the venue's own wording per message kind and channel;
--   message_dispatch   — "this kind about this subject already went out on this
--                        channel", so a producer can call notifyPlayer twice;
--   message_preference — per-kind opt-in for the optional kinds, because the
--                        pack's consent is per channel, not per kind.
--
-- Campaigns and broadcasts are intentionally absent: every row here is about one
-- player and one business record.

-- ---------------------------------------------------------------------------
-- message_template
-- ---------------------------------------------------------------------------

CREATE TABLE message_template (
  message_template_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid        NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  message_kind        text        NOT NULL,
  delivery_channel    text        NOT NULL,
  subject             text,
  body                text        NOT NULL,
  is_active           boolean     NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT message_template_kind_known CHECK (message_kind IN (
    'booking_confirmed', 'booking_receipt', 'booking_cancelled', 'booking_reminder',
    'program_registered', 'waitlist_opened', 'court_changed', 'closure',
    'pickup_ready', 'waiver_prompt')),
  CONSTRAINT message_template_channel_known CHECK (delivery_channel IN ('email', 'sms')),
  -- An email has a subject line of at most 120 characters; an SMS has none.
  CONSTRAINT message_template_subject_by_channel CHECK (
    (delivery_channel = 'email' AND subject IS NOT NULL AND char_length(subject) BETWEEN 1 AND 120)
    OR (delivery_channel = 'sms' AND subject IS NULL)),
  -- 320 characters is two SMS segments; an email body stays readable at 1000.
  CONSTRAINT message_template_body_length CHECK (
    char_length(body) BETWEEN 1 AND CASE delivery_channel WHEN 'email' THEN 1000 ELSE 320 END),
  CONSTRAINT message_template_kind_channel_key UNIQUE (organization_id, message_kind, delivery_channel)
);

COMMENT ON TABLE message_template IS
  'A venue''s wording for one transactional message kind on one channel. Created lazily with default copy on first read, so a venue that never edits one still sends sensible text. Never deleted — deactivate with is_active instead, which keeps the kind/channel pair unique and auditable.';

COMMENT ON COLUMN message_template.body IS
  'Text with {{placeholder}} tokens. The allowed placeholders are a per-kind whitelist enforced by the message module when saving.';

CREATE TRIGGER message_template_updated_at BEFORE UPDATE ON message_template
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE message_template ENABLE ROW LEVEL SECURITY;
CREATE POLICY message_template_tenant_isolation ON message_template
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());

-- ---------------------------------------------------------------------------
-- message_dispatch
-- ---------------------------------------------------------------------------

CREATE TABLE message_dispatch (
  message_dispatch_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid        NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  message_kind             text        NOT NULL,
  subject_code             text        NOT NULL,
  delivery_channel         text        NOT NULL,
  party_id                 uuid,
  notification_delivery_id uuid,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT message_dispatch_channel_known CHECK (delivery_channel IN ('email', 'sms')),
  CONSTRAINT message_dispatch_subject_present CHECK (char_length(subject_code) BETWEEN 1 AND 200),
  -- THE idempotency invariant: one message of a kind about one subject per channel.
  CONSTRAINT message_dispatch_once_key UNIQUE (organization_id, message_kind, subject_code, delivery_channel),
  CONSTRAINT message_dispatch_party_same_tenant
    FOREIGN KEY (organization_id, party_id)
    REFERENCES party(organization_id, party_id) ON DELETE SET NULL (party_id),
  CONSTRAINT message_dispatch_delivery_same_tenant
    FOREIGN KEY (organization_id, notification_delivery_id)
    REFERENCES notification_delivery(organization_id, notification_delivery_id) ON DELETE SET NULL (notification_delivery_id)
);

COMMENT ON TABLE message_dispatch IS
  'Append-only record that a transactional message was handed to the notification outbox. The unique key makes notifyPlayer idempotent per kind, subject, and channel, so a retried producer or a re-run reminder sweep never double-sends. Immutable: written once in the same transaction as the outbox row.';

CREATE INDEX idx_message_dispatch_party_id ON message_dispatch(party_id);
CREATE INDEX idx_message_dispatch_delivery_id ON message_dispatch(notification_delivery_id);
CREATE INDEX idx_message_dispatch_organization_party ON message_dispatch(organization_id, party_id);
CREATE INDEX idx_message_dispatch_organization_delivery ON message_dispatch(organization_id, notification_delivery_id);

ALTER TABLE message_dispatch ENABLE ROW LEVEL SECURITY;
CREATE POLICY message_dispatch_tenant_isolation ON message_dispatch
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());

-- ---------------------------------------------------------------------------
-- message_preference
-- ---------------------------------------------------------------------------

CREATE TABLE message_preference (
  message_preference_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid        NOT NULL REFERENCES organization(organization_id) ON DELETE CASCADE,
  party_id              uuid        NOT NULL,
  message_kind          text        NOT NULL,
  is_opted_in           boolean     NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  -- Only optional kinds carry an opt-in. Essential kinds always send.
  CONSTRAINT message_preference_kind_optional CHECK (message_kind IN (
    'booking_reminder', 'waitlist_opened', 'program_registered', 'pickup_ready', 'waiver_prompt')),
  CONSTRAINT message_preference_party_kind_key UNIQUE (organization_id, party_id, message_kind),
  CONSTRAINT message_preference_party_same_tenant
    FOREIGN KEY (organization_id, party_id)
    REFERENCES party(organization_id, party_id) ON DELETE CASCADE
);

COMMENT ON TABLE message_preference IS
  'A player''s opt-in to one optional message kind (reminder, waitlist opening, program, pickup, waiver). No row means not opted in. The notification pack''s per-channel is_nonessential_allowed is kept in step so the outbox agrees; essential kinds never read this table.';

CREATE INDEX idx_message_preference_party_id ON message_preference(party_id);

CREATE TRIGGER message_preference_updated_at BEFORE UPDATE ON message_preference
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE message_preference ENABLE ROW LEVEL SECURITY;
CREATE POLICY message_preference_tenant_isolation ON message_preference
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());
