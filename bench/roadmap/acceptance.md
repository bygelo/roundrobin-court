# roundrobbin roadmap acceptance criteria

Every [ROADMAP.md](../../ROADMAP.md) row links here. A row without a falsifiable pass condition is a wish, not a roadmap item.

**Tier meaning.** **Tier 3** — a written falsifiable acceptance test: a metric, a pass/fail condition, and one command or observation that decides it. This is the default. **Tier 2** — a live-provider or live-model procedure: exact steps, one deciding observation, expected result; manual and non-idempotent by nature. **Tier 1** — a runnable idempotent benchmark (fixture + mechanical scorer + committed baseline). Tier 1 must be *earned* by a named regression risk, and every Tier-1 benchmark for unbuilt work is **red by definition**.

**Quarantine rule.** Every Tier-1 benchmark here lives under `bench/roadmap/` and is excluded from the live gate by the `bench/roadmap/**` glob. `npm test` must stay green while this file is full of failing specs. An item is done when its benchmark **moves into the live gate and goes green** — that promotion is the `/gate` red→green moment.

**Nothing below has been executed.** There is no runner yet; R02 builds it. Every entry is spec-only.

---

## R01 — Sideout archive

**Tier 3.** Surface: `git -C C:\Users\maran\Codex\sideout` + a bundle file.

PASS iff all three hold: (a) `git -C ../../Codex/sideout status --porcelain` prints nothing; (b) `git bundle verify` succeeds on an archive stored outside the sideout working tree; (c) `git -C ../../Codex/sideout log --oneline | wc -l` is greater than 1. Currently fails — 1 commit, ~90% of the tree untracked.

## R02 — Schema and migration

**Tier 1.** Escalation: Sideout shipped a migration numbered `010` that does not exist and nobody noticed for a month; the `tstzrange` exclusion constraint is a data-integrity invariant. Surface: `npm run db:migrate`, `npm run lint:naming`.

Fixture: `bench/roadmap/input/schema/` — a migration set with a deliberate numbering gap, a plural identifier, and a colliding booking range.

PASS iff the scorer confirms every check: migration applies from empty to head and is idempotent on re-run; a gap in the numbering sequence exits non-zero naming the missing number; a plural identifier (`courts`, `bookings`) exits non-zero naming the file and line; two overlapping bookings on one resource are rejected by the database, not by application code (drop the constraint and the check must go red); every table carries `created_at`, and every mutable table an `updated_at` trigger.

Baseline: none — nothing exists to capture. Red→green is the acceptance.

## R03 — Module registry

**Tier 1.** Escalation: cross-module store isolation is the load-bearing architectural invariant of the whole product; Sideout's equivalent was never fully enforced and the JSON-snapshot debt followed directly from that. Surface: `POST /api/v1/organization/:code/module/:module_code/enable`, Operator → Modules.

PASS iff: enabling a module with an unmet dependency is rejected and names the dependency; a dependency cycle is rejected at registration, not at enable time; disabling a module removes its routes from `GET /api/v1/capability` and returns 404 on them while leaving its data intact; re-enabling restores the data unchanged; **a static check proves no module source file imports another module's store or table** (add such an import and the check must go red); a core module cannot be disabled.

## R04 — Identity and tenant isolation

**Tier 1.** Escalation: a cross-tenant read is unrecoverable once it happens. Surface: `POST /api/v1/auth/session`, Operator → Staff.

PASS iff: every role in the matrix (owner, manager, front desk, scorer, display, public) gets exactly its allowed routes and is refused every other one, checked exhaustively rather than by sample; a session scoped to tenant A returns 404 — not 403 — for every tenant B resource, across every route, including by direct UUID; a revoked session is refused on the next request; every mutating request writes an audit row naming the acting session.

## R05 — Booking core

**Tier 1.** Escalation: concurrency correctness under load is exactly the property a written test cannot prove. Surface: `GET /availability`, `POST /booking`, public booking page.

PASS iff: 50 concurrent requests for one slot produce exactly 1 confirmed booking and 49 explicit conflict responses, with zero 500s; an expired hold releases the slot back into availability without operator action; a cancelled booking frees the slot; availability never shows a slot that a booking already holds; price and time are server-owned — a client that posts its own price is rejected; the run is deterministic across 10 repetitions.

## R06 — Venue setup

**Tier 3.** Surface: Operator → Venue setup.

PASS iff, starting from an empty tenant with no seed SQL, an operator can create a facility, add four courts, set weekly operating hours, add a dated closure, define a recurring sellable slot at 60/90/120 minutes with a peak price band, and see the resulting slots appear in public availability — then edit a court name and retire a court, with both reflected immediately and no orphaned booking. Measured by walking the screen; currently fails — no screen exists.

## R07 — Payment port

**Tier 2** — live provider sandbox.

Steps: configure the chosen PH provider's sandbox credentials; book a slot and pay online; refund half; take a second booking as a manual counter payment; restart the API. PASS iff: the booking shows `paid` after restart; the refund shows a partial amount and the booking stays confirmed; the manual payment is distinguishable from the online one in the record; **no card number appears anywhere in the roundrobbin database or logs**; replaying the provider's webhook twice produces exactly one payment record. Non-idempotent by nature — provider sandbox state must be reset between runs.

## R08 — Sport profile

**Tier 1.** Escalation: this is the invariant the entire multi-sport bet rests on. Without it, a regression silently re-hardcodes pickleball across the codebase and multi-sport becomes a claim. Surface: `sport_profile` config, Operator → Sport.

Fixture: four profiles — pickleball, tennis, badminton, padel.

PASS iff: a static check finds **zero occurrences of a sport name in any service, domain, or store file** (add `if (sport === 'pickleball')` anywhere outside a profile definition and the check goes red); each profile declares team size, scoring rule, session default, and rating provider — including the "no rating provider" state; creating a tennis venue and a padel venue from profiles alone produces working availability, booking, and session behavior with no code change; a fifth profile can be added as data only.

## R09 — Rotation engine

**Tier 1.** Escalation: fairness is a mathematical property, not an impression. Only a fixture over a full scene can prove it, and this is the product's namesake — a fairness regression here is an existential bug. Surface: Operator → Play, public `/play/:token`.

Fixture: a 13-player, 4-court, 2-hour open-play scene with three late arrivals and two early departures, replayed deterministically.

PASS iff, against a stated and documented fairness rule: no player's games-played count differs from another's by more than 1 at any checkpoint; no player sits out twice consecutively while any other player has played twice; a late arrival is integrated within one rotation; a departure does not strand a court mid-rotation; the same fixture produces byte-identical assignments across 10 runs; the up-next projection matches what the engine actually assigns.

## R10 — Program and event

**Tier 3.** Surface: Operator → Program, public program page.

PASS iff an operator can publish a weekly clinic with a capacity of 8, a player can register from the public page and receive a private action credential once, a ninth registrant lands on the waitlist and is promoted automatically on a cancellation, a staff member can mark a no-show, and the public roster shows no customer identity, payment, or membership state. Currently fails — nothing exists.

## R11 — Arrival

**Tier 3.** Surface: Operator → Arrival, player self check-in.

PASS iff: a player with a current waiver can self check in only within the server-owned window (T−60 to session end) and is refused outside it; a player without a current waiver is prompted for the current version and the acceptance is stored with evidence; a staff member can override with the override recorded against their session; the arrival survives an API restart.

## R12 — Score

**Tier 1.** Escalation: scoring state machines are pure functions with brutal edge cases, and undo across a game boundary is precisely where they break. Surface: court scoring screen, Operator → Score.

Fixture: one recorded point sequence per sport profile from R08, including deuce, side-out, a game boundary, and a full match.

PASS iff: replaying each sequence yields the documented final score for that sport; undo across a game boundary restores the exact prior state including server and side; a disconnect and reconnect mid-match restores identical state; a confirmed result cannot be silently edited — a correction writes an audit row; the scorer is deterministic across 10 runs.

## R13 — Display

**Tier 3.** Surface: `/display?credential=…`.

PASS iff a browser can be enrolled as court, lounge, counter, or kiosk; each mode shows the state its role should see and nothing more; killing the API makes every display show a visible stale or offline indicator within 30 seconds rather than showing silently frozen data; a published Studio version reaches every enrolled display without re-enrolment.

## R14 — Commerce

**Tier 1.** Escalation: overselling is a money bug, and Sideout already had to defend against duplicate split-line orders. Surface: Operator → Shop, public catalog.

PASS iff: 20 concurrent checkouts against 5 units of stock produce exactly 5 fulfilled orders and 15 explicit out-of-stock responses; an order with the same product on two lines consolidates before the stock check; the same idempotency key replayed produces one order; a refund restores stock and is traceable to the original line; disabling the Commerce module removes the public catalog entirely rather than showing an empty one.

## R15 — Membership

**Tier 3.** Surface: Operator → Membership, member portal.

PASS iff an operator can define a pass with an entitlement and a usage limit, a member sees a member price at booking, the entitlement decrements on use and refuses use past the limit with a clear reason, and disabling the Membership module leaves every existing booking valid at its recorded price.

## R16 — Insight and accounting export

**Tier 3.** Surface: Operator → Insight, `GET /export/accounting`.

PASS iff: occupancy, revenue by source, rotation fill, cancellation/no-show, and repeat-player figures each reconcile to the underlying records when checked by hand for one venue-day; revenue nets partial and full refunds; **the exported file imports into at least one real accounting package without manual repair** — this is the row's actual bar, not the numbers rendering on screen.

## R17 — Staff roster

**Tier 3.** Surface: Operator → Staff roster. Demand-gated.

PASS iff an operator can assign a staff member to a shift, the roster is visible to the front desk, and permission continues to come from R04's role — the roster grants presence, never authority.

## R18 — Studio

**Tier 3.** Surface: `/studio`, public venue URL.

PASS iff: an operator can pick a template, set brand tokens, reorder modules and courts, preview, and publish; **the public portal and every enrolled display move to the new version in one transaction — a partial publish must be impossible**; rollback returns every surface to the prior version; a draft never leaks to a public visitor. Sideout's equivalent stalled exactly at the one-transaction requirement; that is the acceptance bar here.

## R19 — Public API

**Tier 1.** Escalation: a published API contract is a promise to strangers, and breaking it silently is the worst failure mode on this board. Surface: `GET /api/v1/capability`, `/docs`, Operator → API key.

PASS iff: `GET /api/v1/capability` lists exactly the enabled modules and their routes, and changes when a module is toggled; a committed OpenAPI spec matches the live routes — **add a route without updating the spec and the check goes red**; an API key is scoped to one tenant and one permission set, and a request outside that scope is refused; a key can be revoked and the next request fails; a recorded v1 request/response corpus replays identically against the current build, so a breaking change cannot ship unnoticed; rate limiting returns a documented status with a retry hint.

## R20 — DUPR connector

**Tier 2** — live provider, requires an approved DUPR club (3–5 business days).

Steps: complete the DUPR club application; obtain partner credentials; link a test player's DUPR identity from the player-facing flow; read that player's rating to gate an eligibility-restricted session; play a match through R12; submit the confirmed result with explicit player consent recorded; then submit the same result again.

PASS iff: the rating read gates eligibility correctly; **submission is refused with an actionable message when any participant lacks a DUPR ID** (the provider requires all participants to hold one); the duplicate submission produces exactly one DUPR record; consent is recorded per player and a player who declines is excluded without blocking the others; a provider outage leaves the venue result intact and the submission queued, never lost; disconnecting DUPR preserves every local result.

## R21 — Webhook egress

**Tier 1.** Escalation: at-least-once delivery with idempotency is precisely the property a written test cannot assert. Surface: Operator → Webhook, `POST` to subscriber.

PASS iff: every event carries a versioned envelope, a stable idempotency key, and a signature the subscriber can verify; a subscriber returning 500 five times triggers backoff and lands in a dead-letter queue rather than retrying forever; a replayed delivery is detectably duplicate; no event is lost across an API restart mid-delivery; the fixture is deterministic across 10 runs with a pinned clock.

## R22 — Notification

**Tier 3.** Surface: Operator → Message, player inbox/SMS.

PASS iff each of the nine producer events (confirmation, receipt, reminder, waiver prompt, waitlist opening, court change, closure, pickup, cancellation) writes an outbox row **independently of provider success**; a player who has opted out receives none of them; the outbox survives a restart and is claimed exactly once by the worker; contact details are masked in logs. Sideout shipped only 2 of 9 producers — count them.

## R23 — Calendar export

**Tier 3.** Surface: signed `.ics` feed URL.

PASS iff a signed feed URL renders a venue's sessions in a real calendar client, revoking the signature breaks the feed, and **changing the calendar never changes roundrobbin** — the feed is a projection, never a source of truth.

## R24 — Data portability

**Tier 3.** Surface: Operator → Venue data, public `/privacy`.

PASS iff: a configuration export re-imports into an empty tenant and produces a byte-identical configuration export on the round trip — transactionally, so a failed import leaves nothing behind; the export carries record counts and checksums; **no credential, key, or secret appears in any export**; a player can request a copy or an erasure from `/privacy` with a booking-scoped token and see its status. Sideout disabled the import path because it was not transactional; that is the bar.

## R25–R29 — Demand-gated

Governance only. No surface, no runtime, no benchmark until the trigger in the [ROADMAP](../../ROADMAP.md#p4--promote-only-after-repeated-demand) fires. Each is recorded here so it cannot be quietly promoted without the evidence.

- **R25 — gear desk**: a venue asks twice for custody tracking separate from sellable stock.
- **R26 — access and device**: hardware installed and a request to bind it to a reservation window.
- **R27 — multi-location**: two active venues under one operator.
- **R28 — competition**: five operator interviews and a measured failure rate of existing specialists.
- **R29 — native app**: web install demonstrably insufficient for court-side check-in or scoring.

## R30 — Accessible interaction

**Tier 3**, applied to every user-visible row rather than owned as its own.

PASS iff, for booking, payment, check-in, score, Studio reordering, and each display mode: an automated WCAG 2.2 AA pass reports no violation; every flow completes keyboard-only; every drag interaction has a non-drag alternative; the page reflows at 200% zoom without horizontal scrolling; and authentication does not require a cognitive function test. Sideout carried this as a single unowned row and it stayed unverified to the end — that is why it is a condition here, not a row.
