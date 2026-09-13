# roundrobin court — product roadmap

**Moved 2026-08-08.** This roadmap was written for a repo named `roundrobin` that was then a sports product. That repo became [roundrobin OS](https://github.com/bygelo/roundrobin) — an application kernel and domain packs serving several apps. The sports product moved here with its 30 items unchanged.

Two rows below are now the OS's responsibility and should be read as delegated, not dropped:

- **R02 (typed schema and gapless migration runner)** — shipped in the OS as its package-scoped migration runner. Green.
- **R03 (module registry)** — shipped in the OS as `package/kernel`'s module tables plus a boundary linter that fails the gate on a cross-package table read. Its runtime is OS item K08.

Likewise the booking core (R05) now sits on `@bygelo/roundrobin-booking`, whose schema already enforces the no-double-booking guarantee with a PostgreSQL `EXCLUDE USING gist` constraint. R05's remaining work here is the runtime and the venue-facing surface, not the invariant.

Everything else — sport profile, the rotation engine, arrival, score, display, Studio, DUPR — is this repo's.

---

Validated 2026-08-08. Greenfield. This roadmap covers the whole product: the booking kernel, the module runtime, multi-sport play operation, the installable business/ERP layer, the branded public portal, the public API, and replaceable Connect adapters.

roundrobin is a clean rewrite migrating off [Sideout](../sideout) (`C:\Users\maran\Code\sideout`). It keeps Sideout's validated domain model and its 29-item benchmark history as **spec**, and keeps none of its code.

## Product law

roundrobin is a **booking OS**: one canonical venue truth, plus modules a venue operator installs and removes without corrupting that truth.

A feature belongs only when it measurably shortens time-to-book, time-to-play, or operator time; improves safe resource utilization; lets an operator express their brand; or is reachable through the public API. It must sit behind a stable core contract and remain removable without data loss.

Two laws inherited from Sideout, kept verbatim because both survived validation:

- **No service rule branches on a sport code.** `organization`, `facility`, `resource`, `session`, `booking`, `product`, `customer_order` stay neutral. Sport is configuration.
- **A module may call core ports or consume versioned events. It may never read another module's store.**

One law reversed on purpose. Sideout's law said "*without becoming a general ERP*" and rejected accounting/CRM/BI outright. roundrobin instead treats ERP breadth as **installable**: the core stays lean and boring, and finance, workforce, and analytics ship as opt-in Business modules a tenant enables. The rejection list did not disappear — it moved from "never" to "only as a module, only on demand, and never in core." See [What we are NOT going to do](#what-we-are-not-going-to-do).

### On the name

Round-robin is a fair-rotation scheduling algorithm. That is not a coincidence and it is the product's sharpest edge: **the queue engine that decides who plays next, on which court, with whom, fairly** is the thing venues currently run on whiteboards and group chats. Every booking system has a calendar. Almost none has a defensible rotation engine. R09 is the wedge; treat it as such.

## Discovery evidence

Bounded discovery: the Sideout tree (69 tables across 20 migrations, 15 API services, 16 test files), the reference product, the two named providers, and one web pass.

- **Rezerv (`rezerv.co`)** — the named reference — is a horizontal all-in-one OS for service businesses, registered in Singapore, spanning fitness, beauty/wellness, **sports facilities (padel, pickleball, tennis)**, arts, education, F&B, healthcare, and hospitality. Its module set is website builder, scheduling, payment, membership, marketing automation (email/SMS/WhatsApp), analytics, mobile app, staff management, loyalty, and smart-lock/lighting integration. **It publishes no public API.** That validates the "roundrobin OS" framing and the modular-ERP shape, and it locates the wedge: an open, documented API is a differentiator against the closest reference product, not table stakes. ([Rezerv](https://www.rezerv.co/))
- **DUPR has a real, documented API** — a tiered public/partner program with an OpenAPI spec, bearer-token auth against `backend.mydupr.com`, a public read-only tier at [`api.dupr.gg/docs`](https://api.dupr.gg/docs), and an established partner roster (Pickleball.com, Swish, Reclub, PB360, Pickleball Global, ScoreHolio, PickleHeads, PlaybyPoint). Club approval runs 3–5 business days and grants an account manager. Match submission requires every participant to hold a DUPR ID. ([DUPR API partner integrations](https://dupr.zendesk.com/hc/en-us/categories/32142598126740-API-Partner-Integrations), [DUPR clubs](https://www.dupr.com/clubs), [community OpenAPI client](https://github.com/offsetkeyz/dupr-api-client)) — **this overturns Sideout's triage, which recorded no verified provider access.** DUPR moves from research-only to buildable.
- **ReClub publishes no partner or public API.** It is a consumer community app — RSVP, kudos, internal leaderboards, host-run sessions — that is *itself* a DUPR API partner. Its club-facing pages document no booking, facility, or developer surface. ReClub is therefore an adjacent demand-side app, not an integration surface. See [Triage](#triage) for the only workable design. ([Reclub for clubs](https://reclub.co/platform/clubs), [DUPR × Reclub partnership](https://pickleball.reclub.co/news/official-partnership-announcement-dupr-and-reclub-join-forces))
- **The Sideout domain model is sound and worth carrying.** `organization → activity → facility → resource → session → booking` plus `product/inventory/customer_order`, with UUID PKs, `TIMESTAMPTZ`, and a `btree_gist` + `tstzrange` exclusion constraint that makes double-booking impossible at the database layer rather than in application code (`migration/001_create_platform.sql`).
- **Sideout's #1 architectural debt must not be inherited.** Core booking, Venue Setup, Studio, and Notification are normalized; Play, Arrival, Score, Display, Commerce, Connect/Rating/Membership, and Calendar persist whole-tenant JSON blobs in `organization_module_state` (`ROADMAP.md:100`, `api/durable-repository.js`). That split truth was item B25 and never closed. In a rewrite it costs nothing to avoid and everything to repeat.

## Product anatomy

| Layer | Owns | Rule |
|---|---|---|
| **Kernel** | Tenant, identity, permission, module registry, event bus, job runner, audit, API key | Always installed; no module name appears in a kernel contract |
| **Core** | Organization, sport, facility, resource, schedule, availability, price, customer, booking, check-in, payment reference | Always installed; no provider name appears in a core contract |
| **Play** | Round-robin queue, open play, program/event, arrival, score, display | Operator-enabled; disable without damaging core data |
| **Business** | Commerce, membership, insight, accounting export, staff roster | The installable ERP layer; each is independently removable |
| **Studio** | Premade layout, brand token, content slot, module order, draft, publish, rollback | Bounded customization; no raw HTML/CSS, no freeform page builder |
| **Connect** | Public API, webhook, DUPR, payment, notification, calendar, access hardware | Replaceable adapter with least privilege, health, retry, audit, and safe disconnect |

Every module declares a stable `module_code`, schema version, required core capability, owned route/table/job/UI block, permission, emitted and consumed event type, health check, and removal/retention behavior. Start as a modular monolith with ports and adapters — not a microservice per module.

## Stack decision

TypeScript end to end, strict mode, no `any` in a domain type. PostgreSQL with a typed query layer, not a lifestyle ORM — the exclusion constraint and the `tstzrange` logic must stay visible in SQL. Migrations forward-only and numbered without gaps (Sideout skipped `010` and nobody noticed for a month). One test runner, one lint config, one formatter, decided before the first feature and never revisited.

Naming is singular everywhere, including collections — `court: Court[]`, not `courts`. This is enforced mechanically (R02), not by review.

---

## P0 — The kernel and one durable truth

Nothing in P1 or later ships until every P0 row is green. Exit condition: with every optional module disabled, a new venue can configure four courts, take a paid reservation, check a player in, and show current availability at the counter — and the same actions work through the public API.

| Item | What it closes | Surface | Effort | Benchmark | Status |
|---|---|---|---:|---|---|
| Archive the Sideout tree before anything else | ~90% of Sideout is untracked on a one-commit branch. A single `git clean` destroys two months of validated domain work that this rewrite uses as its spec | `git -C ../../Codex/sideout` commit + a tagged archive bundle | S | [R01](bench/roadmap/acceptance.md#r01--sideout-archive) — Tier 3 | **Done 2026-08-08** — 114 file committed at `31e9ec0`; `sideout-archive-2026-08-08.bundle` verified complete |
| Typed schema and a gapless migration runner | Ports the neutral core schema with UUID PKs, `TIMESTAMPTZ`, and the `btree_gist` overlap constraint into a forward-only runner that refuses numbering gaps and non-singular identifier | `npm run db:migrate`, `npm run lint:naming` | M | [R02](bench/roadmap/acceptance.md#r02--schema-and-migration) — Tier 1 (escalated: a silent migration gap already shipped in Sideout; the overlap constraint is a data-integrity invariant) — **promoted into the live gate** at `test/r02-schema.test.ts` | **Done 2026-08-08** — 10/10 green against PostgreSQL 18, including a real overlapping insert refused by `23P01` |
| Module registry with install, enable, disable, and removal | Makes every non-core module independently installable and makes cross-module store access impossible rather than merely discouraged | `POST /api/v1/organization/:code/module/:module_code/enable`, Operator → Modules screen | L | [R03](bench/roadmap/acceptance.md#r03--module-registry) — Tier 1 (escalated: cross-module store isolation is the load-bearing architectural invariant of the entire product) — quarantined, promote-on-build | **Built 2026-09-13** — `/operator/module` and `/api/v1/admin/module`: enable refuses naming the missing dependency, disable refuses naming the modules that need it, data is kept, capability discovery and route 404s follow the toggle. Static no-cross-module-store check is not a gate yet |
| Tenant isolation, identity, and permission | Gives owner, manager, front desk, scorer, and read-only display exactly the access they need, and makes a cross-tenant read structurally impossible | `POST /api/v1/auth/session`, Operator → Staff screen | L | [R04](bench/roadmap/acceptance.md#r04--identity-and-tenant-isolation) — Tier 1 (escalated: authorization invariant; a cross-tenant leak is unrecoverable) — quarantined, promote-on-build | **Built 2026-09-13** — role presets owner, manager, front desk, scorer, viewer; `/operator/staff` adds staff with a one-time password; disabling revokes sessions and API keys at once; last owner protected; every admin action audited; every staff member changes their own password at `/operator/account` (other devices signed out, attempts rate-limited) and is prompted when an owner issued it. Display/public roles and an exhaustive route sweep remain |
| Book a court from availability without ever double-booking | The whole point of the product: live availability, a held slot that expires, a confirmed booking, cancellation, and a database-enforced guarantee that two concurrent requests cannot take the same resource | `GET /availability`, `POST /booking`, public booking page | L | [R05](bench/roadmap/acceptance.md#r05--booking-core) — Tier 1 (escalated: concurrency correctness under load is exactly what a written test cannot prove) — quarantined, promote-on-build | **Built 2026-09-13** — `/v/:organization_code` availability grid, hold, pay, recover, and cancel within policy; 50 simultaneous checkouts give one 201 and 49 409s; an expired hold releases once. Hold length is fixed at 10 minutes by the booking pack (OS gap) |
| Set up a venue without writing SQL | An operator creates facility, court, operating hour, closure, recurring sellable slot, price band, and capacity from a screen. Explicitly excludes workforce scheduling | Operator → Venue setup | L | [R06](bench/roadmap/acceptance.md#r06--venue-setup) — Tier 3 | **Built 2026-09-13** — `/operator/venue`: courts, hours, closures, 60/90/120-minute schedules with peak pricing, booking policy; edits never orphan a booking; `/operator/board` runs the day |
| Take a real payment through a swappable port | Online, manual, refund, fee, and payout reference without storing card data or coupling booking to a processor. PayMongo is the first Philippine candidate, not a foregone conclusion | `POST /payment`, checkout step in the booking flow | L | [R07](bench/roadmap/acceptance.md#r07--payment-port) — Tier 2 (live provider sandbox) | **Partial 2026-09-13** — payment port with a sandbox adapter, counter payments, refund records, no card data stored; PayMongo checkout and signed webhook are written but unproven without sandbox credentials |

## P1 — Multi-sport play and the rotation engine

Exit condition: one venue runs a full multi-sport evening — discovery, booking, payment, waiver, check-in, fair rotation, court assignment, live score, lounge display — with no spreadsheet and no duplicate entry, and a tennis club and a padel club can do the same without a code change.

| Item | What it closes | Surface | Effort | Benchmark | Status |
|---|---|---|---:|---|---|
| Sport profile — the thing that makes multi-sport real | Multi-sport is a slogan until the one genuinely sport-specific surface is abstracted. A declarative profile owns team size, court dimension vocabulary, scoring rule, rating provider, and session default for pickleball, tennis, badminton, and padel | `sport_profile` config + Operator → Sport screen | M | [R08](bench/roadmap/acceptance.md#r08--sport-profile) — Tier 1 (escalated: this is the invariant the whole multi-sport bet rests on; a regression here re-hardcodes pickleball everywhere) — quarantined, promote-on-build | **Built 2026-09-13** — sport profile per sport with team size, scoring rule, session length, and a rating provider that may be none; no court service branches on a sport. A real tennis or padel venue has not exercised it |
| Fair round-robin rotation and open play | Replaces the whiteboard: roster, waitlist, self check-in, a fair queue with a stated fairness rule, up-next, court assignment, and a public live view. **This is the product's namesake and its wedge** | Operator → Play, public `/play/:token` | L | [R09](bench/roadmap/acceptance.md#r09--rotation-engine) — Tier 1 (escalated: fairness is a mathematical property; only a fixture over a full 13-player/4-court scene can prove it) — quarantined, promote-on-build | **Built 2026-09-13** — pure fairness engine; the 13-player/4-court scene matches exactly across rounds; no player or court assigned twice (database-enforced); one waitlist promotion per vacancy; `/operator/play` and public `/play/:token` |
| Program and event from one session model | Clinic, lesson, social, league shell, and private event with recurrence, capacity, host, eligibility, registration, and waitlist | Operator → Program, public program page | L | [R10](bench/roadmap/acceptance.md#r10--program-and-event) — Tier 3 | **Built 2026-09-13** — one model for clinic, lesson, social, league and tournament shells, private event; weekly recurrence with skips; last seat race has one winner; `/operator/program`, public `/v/:organization_code/program`. League and tournament are labels, not brackets |
| Arrival, waiver, and check-in | Guest list, day/pass validation, versioned waiver with evidence, paid state, code check-in, and staff override | Operator → Arrival, player self check-in | M | [R11](bench/roadmap/acceptance.md#r11--arrival) — Tier 3 | **Built 2026-09-13** — `/operator/arrival` desk: versioned waiver with evidence, idempotent check-in, override requires a reason and is audited, self check-in from T−60 minutes |
| Live score under a per-sport scoring profile | Team, server, point, undo, game/match lifecycle, result confirmation, and reconnect-safe history — driven by R08's profile, so side-out-to-11, tennis games/sets, and badminton rally-to-21 are configuration | Court scoring screen, Operator → Score | L | [R12](bench/roadmap/acceptance.md#r12--score) — Tier 1 (escalated: scoring state machines are pure functions with brutal edge cases; undo across a game boundary is exactly where they break) — quarantined, promote-on-build | **Built 2026-09-13** — nine scoring rules as a pure engine; every tap idempotent by client id; two tablets converge; offline queue; confirm locks, correction is audited; `/operator/score` |
| Display surfaces | Enrolls a browser TV or tablet as court, lounge, counter, or kiosk; projects live state with heartbeat and a visible stale/offline state | `/display?credential=…` | M | [R13](bench/roadmap/acceptance.md#r13--display) — Tier 3 | **Built 2026-09-13** — court, lounge, counter, and kiosk screens enrol by link, see only their own projection (no customer names), heartbeat, revoke, and show a stale banner; every pull carries the published Studio version and brand, and `/operator/display` flags a screen still showing an older version; `/display`. Not yet observed on physical TVs |

## P2 — The installable ERP layer

This tier is where the modular-ERP decision is cashed in. Each row is a module a tenant may never install. None of them may become a core dependency.

Exit condition: a venue can run its money, membership, and reporting inside roundrobin, and hand its accountant a file their software accepts — without roundrobin owning a general ledger.

| Item | What it closes | Surface | Effort | Benchmark | Status |
|---|---|---|---:|---|---|
| Commerce and inventory | Paddle/ball/apparel/pass/add-on catalog, variant, stock, booking add-on, checkout, pickup, refund reference, and counter sale — with concurrent-stock protection | Operator → Shop, public catalog | L | [R14](bench/roadmap/acceptance.md#r14--commerce) — Tier 1 (escalated: oversell under concurrency is a money bug and Sideout already had to defend against split-line duplicates) — quarantined, promote-on-build | **Built 2026-09-13** — counter sale, stock ledger, pickup, refund with restock; concurrent last-unit checkout has one winner; public catalog at `/v/:organization_code/shop` (fills OS K110 for court) |
| Membership and entitlement | Pass, entitlement, member price, usage limit, and reservation eligibility. Recurring billing, freeze, family, and credit stay out until three venues need the same rule | Operator → Membership, member portal | L | [R15](bench/roadmap/acceptance.md#r15--membership) — Tier 3 | **Built 2026-09-13** — plans, passes, member price through the pricing port the portal calls, members-only sessions, timezone-correct expiry, and recurring billing: monthly/annual plans invoice through the billing pack, renewals invoice once per period, a paid renewal extends once, an unpaid one lapses after 7 days; `/operator/member`. Activation follows payment on the next renewal run, not instantly (billing emits no payment event) |
| Owner insight with an accounting export their accountant accepts | Occupancy, revenue by source, rotation fill, cancellation/no-show, repeat player, inventory alert, connector health — plus a journal-shaped export. **This is the ERP compromise: roundrobin reports and exports; it does not keep a ledger** | Operator → Insight, `GET /export/accounting` | M | [R16](bench/roadmap/acceptance.md#r16--insight-and-accounting-export) — Tier 3 | **Partial 2026-09-13** — `/operator/insight` with occupancy, revenue by source net of refunds, cancellation/no-show, repeat players, open-play fill, CSV exports, and a balanced journal. Import into real accounting software is unverified |
| Staff roster and shift, as a module | Who is on the desk, when, and what they may do — the operations half of HR. Payroll, leave accrual, and contracts stay out | Operator → Staff roster | M | [R17](bench/roadmap/acceptance.md#r17--staff-roster) — Tier 3 | Demand-gated — build after two venues ask |
| Studio — a branded public portal in one version | Premade template, brand token, content slot, module order, court order, preview, atomic publish, rollback, and one published version feeding every public and display surface | `/studio`, public venue URL | L | [R18](bench/roadmap/acceptance.md#r18--studio) — Tier 3 | **Built 2026-09-13** — three templates, brand tokens with an AA contrast check, draft, preview, atomic publish, append-only rollback; the public site reads only the published version; `/operator/studio` |

## P3 — Connect: the public API and real providers

Exit condition: a third party builds something real against roundrobin without asking for help, and a venue can disconnect any provider without losing booking, payment, customer, result, configuration, or order truth.

| Item | What it closes | Surface | Effort | Benchmark | Status |
|---|---|---|---:|---|---|
| Public REST API with keys, versioning, and capability discovery | The stated must-have and the differentiator against Rezerv, which ships none. **Modular ERP and a public API multiply: a tenant toggling a module changes the API surface.** A discovery endpoint declaring enabled modules and their routes is therefore not a nicety — it is the only thing keeping the API stable across module changes | `GET /api/v1/capability`, `/docs` OpenAPI, Operator → API key | L | [R19](bench/roadmap/acceptance.md#r19--public-api) — Tier 1 (escalated: a published API contract is a promise to strangers; breaking it silently is the worst failure mode on this board) — quarantined, promote-on-build | **Built 2026-09-13** — API keys over the kernel with a capability checklist, OpenAPI at `/docs`, capability discovery; `/operator/developer`. Committed OpenAPI diff check remains |
| DUPR connector — identity, eligibility, and consented result submission | Links external player identity, reads rating to gate eligibility, submits confirmed results with player consent, and preserves actionable rejection state. **Now buildable: the provider API is real and documented** | Operator → Connect → DUPR, player DUPR link step | M | [R20](bench/roadmap/acceptance.md#r20--dupr-connector) — Tier 2 (live provider sandbox; requires an approved DUPR club) | **Partial 2026-09-13** — sandbox adapter: consented player links, rating eligibility with staleness, confirmed-result submission with one receipt and actionable rejection. Live mode honestly refuses until DUPR approves the club |
| Webhook egress with replay protection | Lets a third party react to booking, payment, arrival, and result events without polling. Versioned envelope, idempotency key, retry with backoff, dead letter, and signature | Operator → Webhook, `POST` to subscriber | M | [R21](bench/roadmap/acceptance.md#r21--webhook-egress) — Tier 1 (escalated: at-least-once delivery with idempotency is precisely the property a written test cannot assert) — quarantined, promote-on-build | **Built 2026-09-13** — CloudEvents envelope, HMAC `x-court-signature`, idempotent emit, backoff to dead letter after six attempts, replay, background worker; subscriber addresses resolving to private, loopback, link-local, or metadata networks are refused at subscribe and delivery time, and redirects are not followed; `/operator/connect`. DNS rebinding between the check and the request is still possible |
| Transactional notification | Provider-neutral confirmation, receipt, reminder, waiver prompt, waitlist opening, court change, closure, pickup, and cancellation with retry, health, and consent. Explicitly excludes campaigns | Operator → Message, player inbox/SMS | M | [R22](bench/roadmap/acceptance.md#r22--notification) — Tier 3 | **Built 2026-09-13** — ten message kinds with editable templates, essential vs opt-in, idempotent outbox, reminders, background send; email through Resend, Postmark, or an HTTP relay and SMS through its own transport, each held honestly until configured; test-email action; `/operator/message`. Not yet sent through a real provider account |
| Calendar export | Publishes venue, resource, and session calendars without making a personal calendar authoritative | Signed `.ics` feed URL | S | [R23](bench/roadmap/acceptance.md#r23--calendar-export) — Tier 3 | **Built 2026-09-13** — signed venue/court `.ics` feeds with stable UIDs, cancellations, and no customer data; rotate and revoke |
| Operator and player data portability | Versioned machine-readable export with record counts and checksums, retention and erasure state, and a configuration re-import path that never leaks credential material | Operator → Venue data, public `/privacy` | M | [R24](bench/roadmap/acceptance.md#r24--data-portability) — Tier 3 | **Built 2026-09-13** — export summary with counts and checksum, access and erasure requests fulfilled by staff, public request and status page at `/v/:organization_code/privacy`. Export covers configuration only |

## P4 — Promote only after repeated demand

Each row carries an explicit trigger. Until the trigger fires, no runtime is scheduled and no benchmark is promoted.

| Item | Trigger | Effort | Benchmark |
|---|---|---:|---|
| Demo and rental gear desk | A venue asks twice for custody tracking separate from sellable stock | M | [R25](bench/roadmap/acceptance.md#r25--gear-desk) — governance only |
| Access and smart-lock connector | A venue has hardware installed and asks to bind it to a reservation window. Rezerv ships this, which is evidence of demand but not of *your* demand | L | [R26](bench/roadmap/acceptance.md#r26--access-and-device) — governance only |
| Multi-location operator view | Two active venues share one operator | L | [R27](bench/roadmap/acceptance.md#r27--multi-location) — governance only |
| Competition and bracket connector | Five operators interviewed and a measured count of how often an existing specialist fails the job | M | [R28](bench/roadmap/acceptance.md#r28--competition) — governance only |
| Native mobile app | Web install proves insufficient for check-in or scoring at the court. Rezerv ships apps; that is their bet, not yet yours | L | [R29](bench/roadmap/acceptance.md#r29--native-app) — governance only |

## Cross-cutting: accessibility

Every user-visible row above inherits one condition rather than getting its own row: booking, payment, check-in, score, Studio reordering, and display controls must be keyboard, touch, and screen-reader operable to [WCAG 2.2 AA](https://www.w3.org/TR/WCAG22/), including a non-drag alternative for every drag interaction and accessible authentication. This was Sideout's B29 and it stayed `REVIEW-OPEN` to the end precisely because it was a row nobody owned. Here it is an acceptance condition on every screen — see [R30](bench/roadmap/acceptance.md#r30--accessible-interaction).

## Execution order

**R01 archive → R02 schema → R03 module registry → R04 identity → R05 booking → R06 venue setup → R07 payment → R08 sport profile → R09 rotation engine → R19 public API → R20 DUPR → the rest by tier.**

Two notes on that order. **R19 sits earlier than its tier suggests** because retrofitting a public contract onto modules that were designed without one is how API surfaces get broken. **R20's DUPR club application should be filed on day one** — it is a 3–5 business-day external dependency that blocks nothing else, so starting it costs nothing and finishing it late costs a sprint.

## What we are NOT going to do

- **A general ledger, tax filing, payroll, or statutory accounting.** roundrobin reports revenue and exports a journal-shaped file (R16). The accountant's software keeps the books. Reversal trigger: a venue demonstrates that no PH accounting package can consume the export.
- **A CRM, campaign builder, funnel, or nurture automation.** Transactional venue messages are in scope (R22); segmentation and broadcast are not. Rezerv ships marketing automation; that is a different company's bet.
- **A BI or query builder.** Fixed reports plus CSV/journal export. If an operator needs a pivot table, they have a spreadsheet.
- **Procurement, supplier, warehouse, manufacturing, or fleet.** No venue has asked and none will.
- **An open app marketplace or arbitrary third-party server code.** The public API (R19) plus webhooks (R21) is the extension story. Running someone else's code inside the tenant boundary is not.
- **A freeform page builder.** Studio stays premade, constrained, previewable, and versioned.
- **A ReClub clone.** No global social graph, feed, chat, kudos, or community discovery. See Triage — ReClub is adjacent, not a feature to absorb.
- **A DUPR clone or a proprietary rating authority.** roundrobin submits to DUPR and reads from it. It never invents a competing number.
- **A full tournament-format engine** until repeated demand proves the connector inadequate (R28).
- **First-party hardware** — smart lock, camera, replay, terminal, or messaging. Adapters only.
- **Microservice per module.** Modular monolith with ports and adapters. Revisit at a scale you do not have.
- **Inheriting Sideout's `organization_module_state` JSON snapshot pattern.** Every module owns normalized tables from its first commit. This is the one Sideout debt that a rewrite gets for free and it must not be spent.

The detailed rejection record and each resurrection trigger live in [docs/roadmap-rejected.md](docs/roadmap-rejected.md).

## Triage

Items that could not be grounded well enough to earn a roadmap row. None is silently treated as committed scope.

1. **ReClub integration — no integration surface exists.** ReClub publishes no public or partner API, and its club-facing material documents no booking, facility, or developer capability. It is a consumer community app that is itself a DUPR partner. The only workable design without a business conversation is **DUPR as a shared substrate**: both systems write results to DUPR, so a player's rating converges regardless of which app hosted the session. That is real interoperability and it costs nothing beyond R20. A direct connector needs a partnership conversation first. **Decision needed: do you have a ReClub contact, or is DUPR-as-substrate enough?**
2. **Payment provider choice.** Validate PayMongo method coverage, fees, refund behavior, official-receipt and tax responsibility, and counter-terminal needs with the first real Philippine operator before fixing R07's adapter scope. Sideout never got past a deliberately fake adapter.
3. **DUPR partner tier.** The public read-only tier at `api.dupr.gg/docs` is confirmed; the write scope, rate limit, and consent obligations of the partner tier are behind an approval wall (the help centre returned 403 unauthenticated). Resolve during the club application.
4. **Which second sport is real.** Multi-sport-from-day-one is an architectural commitment (R08) that costs little now. But *which* sport gets a shipped, tested profile beyond pickleball should follow a real venue, not a guess. Tennis and padel are the likeliest given Rezerv's own vertical list.
5. **Rating for non-pickleball sports.** DUPR is pickleball-only. Tennis (UTR), badminton, and padel each have different rating authorities or none. R08's profile must model "this sport has no rating provider" as a first-class state, but which providers to actually integrate is undecided.
6. **Whether operators want the Business modules at all.** The modular-ERP decision is architecturally cheap and product-unvalidated. Ship P0/P1, then ask five operators what they currently do in a spreadsheet. Build the module that answers loudest.
7. **Hosting, backup, and secret management.** Sideout deferred production pooling, backup, migration delivery, and deployment secrets to the end and never reached them. Decide before R07 touches real money.

## Honest gaps in this sweep

- The DUPR partner help centre (`dupr.zendesk.com`) returned **403** unauthenticated, and the branded partner PDF did not extract to text. Partner-tier write capability, rate limits, and consent terms are therefore **unverified** — Triage 3, not a roadmap claim.
- The reference product was resolved as **Rezerv (`rezerv.co`)**, a Singapore service-business OS. If you meant a different "Reserv", the discovery evidence and R19's differentiator argument need re-running.
- Discovery was **bounded**: one web pass, three providers, and the Sideout tree. No GitHub sibling-repo mining was run, so "what mature booking repos do that we don't" is unsampled.
- ~~No benchmark below has been executed.~~ **Superseded 2026-09-13:** the P0–P3 rows were built and their falsifiable conditions promoted into `test/` — 318/318 on a freshly migrated database. Each row's Status says which conditions are met and which are not. Tier 2 rows (R07 live PayMongo, R20 live DUPR) remain unproven against real providers, and nothing has been observed with a real operator.
- ReClub's absence of an API is grounded in its public marketing and help material only. A private partner program that is simply undocumented cannot be ruled out from outside.
