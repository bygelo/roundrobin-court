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

**Running on the OS.** The app installs `@bygelo/roundrobbin-kernel` and `@bygelo/roundrobbin-booking` from GitHub Packages, applies six migrations in dependency order (kernel → booking → court), serves its own court-board route, books a court through the OS booking pack, and **gets a 409 on the second booking of the same slot** — a guarantee it inherited rather than wrote.

Gate: `typecheck 0 · test 3/3`.

Not one kernel or pack *behaviour* had to change to make this work. The OS needed exactly one edit, and it was packaging — exposing `./package.json` in the exports map so a consumer can resolve a package root to find its migrations. No kernel noun, table, or rule moved. That is the first real evidence the neutrality claim holds.

[ROADMAP.md](ROADMAP.md) carries 30 validated items across P0–P4. Several are now the OS's job and are marked accordingly.

## Run locally

Requires Node 24+ and PostgreSQL 16+. The packages are private, so npm needs a GitHub token with `read:packages`:

```powershell
"@bygelo:registry=https://npm.pkg.github.com" | Set-Content .npmrc
"//npm.pkg.github.com/:_authToken=$(gh auth token)" | Add-Content .npmrc
npm install
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -c "CREATE DATABASE roundrobbin_court;"
$env:DATABASE_URL = 'postgres://postgres@localhost:5432/roundrobbin_court'
npm run db:migrate
npm run dev
```

`.npmrc` is gitignored — it holds a token.

## Verify

```powershell
$env:TEST_DATABASE_URL = 'postgres://postgres@localhost:5432/roundrobbin_court'
npm run gate
```

## What lives here

- `src/app.ts` — the court module declaration and this app's routes
- `migration/001_court.sql` — `sport_profile`, the only genuinely sport-specific table
- `script/migrate.ts` — states the migration order: kernel, then packs, then this app

`sport_profile` is worth a look, because it is the whole of "multi-sport" at the data layer. A sport carries a team size, a scoring rule, and a rating provider that is **allowed to be NULL** — badminton and padel have no DUPR equivalent, and modelling that absence honestly was cheaper than pretending every sport has a rating authority.

## The three findings that shaped this roadmap

1. **DUPR is buildable.** It runs a documented partner API with an OpenAPI spec, bearer auth, a public read-only tier at `api.dupr.gg/docs`, and an established partner roster. Club approval takes 3–5 business days. **File that application before writing code** — it gates R20 and blocks nothing else.
2. **ReClub has no integration surface.** No public or partner API; it is a consumer community app that is itself a DUPR partner. The only workable interop is **DUPR as shared substrate** — both systems write results to DUPR, so a player's rating converges regardless of which app hosted the session. Tracked in Triage, not built.
3. **Rezerv, the closest reference product, publishes no public API.** That makes an open, documented API a differentiator rather than table stakes.

## Prior art

This product descends from **Sideout**, a pickleball venue prototype archived at `Codex/sideout` (2 commits, `31e9ec0`, plus a verified bundle). Sideout's domain model, its 29 benchmarks, and its rejection log are the spec this roadmap inherits. Its code is not reused; its two-month validation pass is.

Sideout's largest debt — whole-tenant JSON snapshots in `organization_module_state` instead of normalized module tables — is the specific mistake this rewrite exists to avoid. The OS's boundary linter makes repeating it fail the gate.
