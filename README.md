# roundrobin court

A multi-sport venue booking product — pickleball first, with tennis, badminton, and padel as configuration. Built on [roundrobin OS](https://github.com/bygelo/roundrobin).

Every booking system has a calendar. Almost none has a defensible **fair-rotation engine** — the thing that decides who plays next, on which court, with whom, and does it fairly. Venues run that on whiteboards and group chats today. That is this product's wedge, and it is why it is called round robin.

## Relationship to the OS

This repo owns pickleball. The OS owns booking, tenancy, identity, and the packs.

| Concern | Lives in |
|---|---|
| tenant, actor, role, module registry, audit, API keys, export | `@bygelo/roundrobin-kernel` |
| site, resource, session, booking, the no-double-booking guarantee | `@bygelo/roundrobin-booking` |
| invoices and payments · catalog and stock · plans and passes · outbox · connector substrate · consent · display devices · QR codes | billing · commerce · membership · notification · connector · consent · output · scan packs |
| sport profile, rotation engine, score, displays, Studio, DUPR, venue setup, portal | **here**, one module per folder in `src/module/` |

A kernel or pack change made *because of this app* is a finding, not a feature. It goes to the OS repo and its evidence log.

## Status

**Every P0–P3 roadmap row has a reachable surface** except R17 (demand-gated). Four rows are honestly partial — R07 (PayMongo unproven without sandbox credentials), R13 (no kiosk; Studio does not reach screens), R16 (journal import unverified in real accounting software), R20 (live DUPR needs club approval). Row-by-row status is in [ROADMAP.md](ROADMAP.md); what changed is in [CHANGELOG.md](CHANGELOG.md).

Gate on a freshly migrated database, 2026-09-13: typecheck server 0 · web 0 · build 0 · `node --test` **318/318**. A headless walk of all 26 screens at 375 and 1280 found no overflow, console error, or stub.

**Needs the OS branch `fix/rollback-on-handled-error`.** Without it a refused request commits what it wrote before refusing; `test/kernel-rollback.test.ts` fails on an unfixed kernel. Rebuild the kernel's `dist` after checking the branch out.

## Run locally

Requires Node 24+, PostgreSQL 16+, and a checkout of the OS beside this one (`../roundrobin`, with its packages built) — `package.json` links the packs with `file:`, so no registry token is needed.

```powershell
npm install
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -c "CREATE DATABASE roundrobin_court_dev;"

# migrations, seed, and the app role run as the owner
$env:DATABASE_URL = 'postgres://postgres@localhost:5432/roundrobin_court_dev'
npm run db:migrate
npm run seed
$env:APP_ROLE_PASSWORD = 'court-dev'; npm run db:role

# the server runs as a non-superuser, so row-level security applies
npm run build
$env:DATABASE_URL = 'postgres://court_app:court-dev@localhost:5432/roundrobin_court_dev'
npm run dev          # http://localhost:8787
```

For hot reload, run `npm run dev:web` (port 8797, proxies the API to 8787) beside `npm run dev`.

Sign in at `/sign-in` as venue `sideout`, staff `operator`, password `correct-horse`. The seed also creates `desk` (front desk) and `scorer`, same password, and prints the demo display and calendar links.

## Where things are

| Who | Path | What |
|---|---|---|
| Player | `/v/sideout` | Book a court, pay online (sandbox) or at the counter |
| Player | `/v/sideout/booking/:code?token=` | Recover, pay, or cancel a booking |
| Player | `/v/sideout/program` · `/v/sideout/shop` · `/v/sideout/privacy` | Programs and sign-up · pro shop · data request |
| Player / TV | `/play/:token` | Live open-play board and self check-in |
| TV | `/display?credential=` | Court, lounge, or counter screen |
| Staff | `/operator/board` · `/operator/booking` · `/operator/arrival` | The day: court board, bookings and payments, arrival desk |
| Staff | `/operator/play` · `/operator/program` · `/operator/score` · `/operator/display` | Open play rotation, programs, tablet scorer, screens |
| Staff | `/operator/shop` · `/operator/member` · `/operator/insight` | Counter sales, memberships, owner insight and exports |
| Owner | `/operator/venue` · `/operator/studio` | Venue setup and schedule, branded public site |
| Owner | `/operator/message` · `/operator/connect` | Player messages, DUPR / webhooks / calendar |
| Owner | `/operator/staff` · `/operator/module` · `/operator/developer` · `/operator/data` | Staff and roles, modules, API keys, venue data |
| Integrator | `GET /api/v1/capability` · `GET /docs` | Capability discovery and OpenAPI |

## Configuration

Every variable is listed with its purpose in [.env.example](.env.example). The ones that change behaviour:

| Variable | Effect when unset |
|---|---|
| `DATABASE_URL` | Every script and the server refuse to start |
| `TEST_DATABASE_URL` | Database tests skip — a green run without it proves little |
| `COURT_WORKER` | Worker runs; set `off` to disable webhook delivery, outbox sending, hold sweep, reminders, schedule horizon |
| `PAYMONGO_SECRET_KEY` | Online payment uses the deterministic sandbox adapter |
| `NOTIFICATION_SMS_URL` | Messages wait in the outbox; nothing is sent |
| `WEBHOOK_SIGNING_KEY` | A development key seals webhook secrets; refused in production |
| `DUPR_MODE`, `DUPR_CLIENT_*` | DUPR shows "not configured"; `DUPR_MODE=sandbox` enables the test adapter |

## Verify

```powershell
$env:DATABASE_URL = 'postgres://postgres@localhost:5432/roundrobin_court_dev'
$env:TEST_DATABASE_URL = $env:DATABASE_URL
npm run db:migrate
npm run gate          # typecheck (server + web) + build + test
```

Tests connect as the owner role, which bypasses row-level security. Any test query against a shared table must filter by its own `organization_id` — an unfiltered one reads or writes every tenant in the database.

## Layout

- `src/app.ts` — the composition: kernel, nine packs, and every court module
- `src/module/<code>/` — one folder per module: declaration, routes, services, and a `contract.ts` when other modules call it
- `src/public.ts` — guest routes outside `/api/*`: resolve the venue, 404 when the module is off
- `src/worker.ts` — background jobs, tenant by tenant
- `migration/` — `001_court.sql` … `017_admin.sql`, one per module, gapless
- `script/` — migrate, seed (one step per module under `script/seed/`), app role
- `web/src/` — the client: `registry.ts` routes every screen, `page/<module>/` holds each module's screens
- `test/` — `helper.ts` builds a fully enabled test venue; one or more test files per module

## The three findings that shaped the roadmap

1. **DUPR is buildable.** A documented partner API; club approval takes 3–5 business days and gates the live half of R20.
2. **ReClub has no integration surface.** DUPR is the shared substrate instead.
3. **Rezerv, the closest reference product, publishes no public API.** An open, documented API is a differentiator.

## Prior art

This product descends from **Sideout**, a pickleball venue prototype archived at `Code/sideout` (`31e9ec0`). Its domain model, 29 benchmarks, and rejection log are the spec this roadmap inherits; its code is not reused. Sideout's largest debt — whole-tenant JSON snapshots instead of normalized module tables — is the mistake this rewrite avoids: every module here owns normalized tables with row-level security from its first migration.
