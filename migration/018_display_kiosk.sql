-- court 018 — display: R13's two open conditions.
--
-- 1. A kiosk screen. A self-service lobby tablet: today's open court slots,
--    open play now and up next, programs later today, and a "Book on your
--    phone" QR. Like the counter and the lounge it shows the venue, never one
--    court, and never a customer's name or contact.
--
-- 2. Studio publish reaches every screen. Each state pull carries the
--    venue's published Studio version and its brand tokens; the screen
--    reports back which version it last rendered. Those two columns are that
--    report, so Operator -> Displays can say "showing v3" and flag a screen
--    that is still on an older version. The output pack's
--    reported_config_version tracks the display configuration, a different
--    thing, so the Studio version gets columns of its own.

ALTER TABLE display_screen DROP CONSTRAINT display_screen_kind_known;
ALTER TABLE display_screen
  ADD CONSTRAINT display_screen_kind_known CHECK (kind IN ('court', 'lounge', 'counter', 'kiosk'));

COMMENT ON COLUMN display_screen.kind IS
  'court: one court''s booking and live score. lounge: every court''s live match plus open play. counter: next available slots and today''s arrivals. kiosk: a lobby tablet with today''s open slots, open play, programs later today, and a booking QR. The projection for each is read-only and scoped to exactly that view.';

ALTER TABLE display_screen
  ADD COLUMN reported_site_version_number integer,
  ADD COLUMN site_version_reported_at     timestamptz,
  ADD CONSTRAINT display_screen_site_version_not_negative
    CHECK (reported_site_version_number IS NULL OR reported_site_version_number >= 0),
  ADD CONSTRAINT display_screen_site_version_stamped
    CHECK ((reported_site_version_number IS NULL) = (site_version_reported_at IS NULL));

COMMENT ON COLUMN display_screen.reported_site_version_number IS
  'The Studio version (studio_version.version_number) this screen last said it rendered, sent with its state pull. 0 means the unbranded default (nothing published, or Studio off). NULL until the screen first reports. Compared with studio_publication to flag a screen that is behind.';
COMMENT ON COLUMN display_screen.site_version_reported_at IS
  'When reported_site_version_number was last written by a state pull.';
