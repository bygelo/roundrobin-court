# Changelog

Append-only. Newest first.

## 2026-09-13 — closing the gaps the first build left

**Built.**
- **Displays (R13):** a lobby kiosk screen (open slots today, open play, programs, a booking QR, no customer names). Every screen now renders the published Studio brand and version, and the Displays screen flags one that is behind.
- **Membership (R15):** recurring billing — monthly and annual plans invoice through the billing pack, renew once per period, and lapse after a 7-day grace. The renewal job runs in the background worker.
- **Player messages (R22):** email through Resend, Postmark, or an HTTP relay, routed by channel so email never reaches the SMS URL; per-channel held status; a test-email action.
- **Staff (R04):** every staff member changes their own password at `/operator/account`, and the console prompts anyone still on an owner-issued password.
- **Webhooks (R21):** subscriber addresses that resolve to private, loopback, link-local, or metadata networks are refused, and redirects are not followed.
- **Handoff guides:** `docs/dupr-application.md`, `docs/operator-walk.md`, `docs/accountant-import.md`.

- **Accessibility (R30):**
  - Automated audit `script/a11y/audit.mjs` (axe-core, WCAG 2.2 A/AA): 0 critical, 0 serious, 0 moderate on every screen at 375 and 1280, and inside the six main dialogs.
  - Dialogs trap and return focus; tabs move with arrow keys; the closed mobile nav leaves the tab order; focus is never hidden under the sticky bars.
  - Scrolling tables are keyboard reachable; TV text stays readable whatever brand colour a venue picks.
  - A screen-reader pass by a person is still owed.

**Fixed.**
- The seed failed whole once the webhook guard landed: its demo local-receiver subscription is now seeded only with `WEBHOOK_ALLOW_PRIVATE=true`, and skipped with a note otherwise.

**OS.** Court now runs on roundrobin `fix/pack-gap` ([#3](https://github.com/bygelo/roundrobin/pull/3), stacked on the rollback fix [#1](https://github.com/bygelo/roundrobin/pull/1)):
- Public display and QR routes work under a non-superuser app role.
- Notifications with no provider stay held instead of reporting sent.
- Holds take `hold_minute_count`.
- jsonb is written as an object in consent, output, geo, connector, and scan.
- The Mac's uncommitted response projections are ported.

**Gate:** 365/365 on the fixed packs, 0 skipped; typecheck server 0 and web 0; build 0.

## 2026-09-13 — the roadmap, built on roundrobin OS

Branch `fanout/court-build`.

**Foundation.** Court moved from two OS packs to nine (booking, billing, membership, commerce, notification, connector, consent, output, scan) plus `KERNEL_MODULE`, on the local OS tree through `file:` links. The `store.end()` → `store.close()` break from kernel K83 and the one-b rename are fixed. Added a public-tenant helper for guest routes outside `/api/*`, an app-role script, a seed, a shared test fixture, a background worker, and a Vite/React web client with a capability-gated operator console and a Studio-branded public site.

**Built** (eleven parallel lanes, each owning normalized tables with row-level security): venue setup and court board (R06, R08); public booking and payment port (R05, R07); fair round-robin rotation and open play (R09); programs and arrival (R10, R11); live score and display screens (R12, R13); shop and membership (R14, R15); owner insight and accountant journal (R16); Studio (R18); modules, staff, API keys, data portability (R03, R04, R19, R24); DUPR sandbox, webhook egress, calendar feed (R20, R21, R23); transactional player messages (R22).

**Fixed during integration.**
- A refused request committed what it wrote first — a kernel bug found by two lanes. Fixed in roundrobin on `fix/rollback-on-handled-error`; `test/kernel-rollback.test.ts` was red before the rebuild and green after.
- `KERNEL_MODULE` was not declared, so no session could hold `kernel.api_key.manage` or `kernel.export`.
- A failed message could turn a booking into a 500; message dispatch now runs on a savepoint.
- Four tests read or wrote without an organization filter. Tests connect as the owner role, which bypasses row-level security, so one of them turned the admin module off for every venue in the database.
- The default action colour `#f32624` fails AA with white text (4.1:1); now `#d32522`.
- Court board opens at the current hour; bookings time no longer wraps; the public shop is one flowing grid.

**Gate** on a fresh database: migrate 0, seed twice 0, typecheck server 0 and web 0, build 0, `node --test` 318/318. A headless walk of all 26 screens at 375 and 1280 found no overflow, console error, or leftover stub.
