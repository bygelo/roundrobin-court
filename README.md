# roundrobbin court

A multi-sport venue booking product — pickleball, tennis, badminton, and padel. The first app built on [roundrobbin OS](https://github.com/bygelo/roundrobbin).

Every booking system has a calendar. Almost none has a defensible **fair-rotation engine** — the thing that decides who plays next, on which court, with whom, and does it fairly. Venues run that on whiteboards and group chats today. That is this product's wedge, and it is why it is called round robin.

## Relationship to the OS

This repo owns pickleball. The OS owns booking.

| Concern | Lives in |
|---|---|
| tenant, scope, party, actor, role, module registry, audit, events | `@bygelo/roundrobbin-kernel` |
| site, resource, session, closure, booking, the no-double-booking guarantee | `@bygelo/roundrobbin-booking` |
| sport profile, rotation engine, score, DUPR, display, venue vocabulary | **here** |

The OS knows about a `resource` with a `resource_category`. It has never heard of a court. This repo supplies "pickleball court" as data and owns every rule that is genuinely sport-specific — which, after analysis, is essentially just **scoring**. That is what R08 exists to prove.

A kernel or pack change made *because of this app* is a finding, not a feature. It goes through `docs/kernel-evidence.md` in the OS repo before it goes into the kernel.

## Status

Not started. [ROADMAP.md](ROADMAP.md) carries 30 validated items across P0–P4, each with a named surface and a tiered falsifiable benchmark, inherited unchanged from the 2026-08-08 validation pass.

Two items in that roadmap are now the OS's job and are marked accordingly — the durable store and the module kernel. The rest is this repo's work.

## The three findings that shaped this roadmap

1. **DUPR is buildable.** It runs a documented partner API with an OpenAPI spec, bearer auth, a public read-only tier at `api.dupr.gg/docs`, and an established partner roster. Club approval takes 3–5 business days. **File that application before writing code** — it gates R20 and blocks nothing else.
2. **ReClub has no integration surface.** No public or partner API; it is a consumer community app that is itself a DUPR partner. The only workable interop is **DUPR as shared substrate** — both systems write results to DUPR, so a player's rating converges regardless of which app hosted the session. Tracked in Triage, not built.
3. **Rezerv, the closest reference product, publishes no public API.** That makes an open, documented API a differentiator rather than table stakes.

## Prior art

This product descends from **Sideout**, a pickleball venue prototype archived at `Codex/sideout` (2 commits, `31e9ec0`, plus a verified bundle). Sideout's domain model, its 29 benchmarks, and its rejection log are the spec this roadmap inherits. Its code is not reused; its two-month validation pass is.

Sideout's largest debt — whole-tenant JSON snapshots in `organization_module_state` instead of normalized module tables — is the specific mistake this rewrite exists to avoid. The OS's boundary linter makes repeating it fail the gate.
