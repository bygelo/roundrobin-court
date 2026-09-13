# Changelog

Append-only. Newest first.

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
