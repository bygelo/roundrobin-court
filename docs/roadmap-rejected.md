# Rejection record

Ideas considered and killed, each with the reason and the trigger that would resurrect it. **Read this before any future `/roadmap` run** — it is the idempotency anchor that stops a killed idea from being re-discovered every quarter.

Inherited entries carry their Sideout origin. A rejection is not a judgment that the idea is bad; it is a record that it is not ours to build now.

| Idea | Reason | Resurrection trigger | Origin |
|---|---|---|---|
| General ledger, statutory accounting, tax filing | roundrobin knows revenue, not accounts. Keeping books means owning PH BIR compliance, audit trails, and a chart of accounts — a different product with a different buyer. R16 exports a journal-shaped file instead | No PH accounting package can consume R16's export without manual repair | roundrobin |
| Payroll and leave accrual | Same reason, worse liability. R17 covers who is on the desk; what they are paid is not ours | Three venues state that no payroll tool fits and the roster data is the blocker | roundrobin |
| CRM, campaign builder, funnel, nurture automation | Transactional messages serve the booking (R22). Segmentation and broadcast serve marketing, which is a separate discipline with separate deliverability obligations. Rezerv ships this; it is their bet | An operator demonstrates that transactional messaging alone loses them measurable repeat business | Sideout |
| BI or query builder | Fixed reports plus export (R16). An operator who needs a pivot table has a spreadsheet and knows it better than we do | Five operators request the same non-fixed report | Sideout |
| Procurement, supplier, warehouse, manufacturing, fleet | No venue has asked. These are the ERP modules that make ERPs unusable | A venue runs a genuine warehouse. It will not happen | roundrobin |
| Open app marketplace / third-party server code in-tenant | The public API (R19) plus signed webhooks (R21) is the extension story. Executing someone else's code inside the tenant boundary imports their security posture into ours | Never, on this architecture | Sideout |
| Microservice per module | The module boundary is enforced by the registry and a static import check (R03), not by a network hop. Distribution buys nothing at venue scale and costs everything in ops | A single tenant's load genuinely exceeds one process | Sideout |
| Freeform Wix-style page builder | Studio stays premade, constrained, previewable, versioned, and safe to publish atomically. A freeform builder makes R18's one-transaction cross-surface publish unprovable | Never — it contradicts R18's acceptance bar | Sideout |
| ReClub clone — social graph, feed, chat, kudos, discovery | ReClub already does this well and roundrobin's buyer is the venue operator, not the player community. Competing for the community layer splits focus and loses | Never. Interoperate through DUPR instead — see Triage 1 | Sideout |
| Proprietary rating authority | DUPR is the pickleball standard with an established partner roster. A second number helps nobody and would not be trusted | Never for pickleball. Other sports need a *provider decision*, not our own rating — see Triage 5 | Sideout |
| Full tournament-format engine | Bracket generation, seeding, and consolation formats are a deep specialist domain with existing products. R28 connects instead | Five operator interviews plus a measured failure rate of existing specialists | Sideout |
| First-party hardware — lock, camera, replay, terminal | Adapters only. Hardware is inventory, firmware, RMA, and a supply chain | Never | Sideout |
| `organization_module_state` JSON snapshot persistence | Sideout's largest architectural debt (its unclosed B25). Every module owns normalized tables from its first commit. A rewrite gets this for free exactly once | Never — this is the specific debt the rewrite exists to avoid | Sideout |
| Installable PWA | Not rejected on merit; deferred pending evidence that web install is insufficient. Tracked as R29 rather than killed | See R29 trigger | Sideout |
| Peak-time booking lottery | Assumes contested release windows that first-come booking handles badly. No venue has demonstrated the contention | A venue demonstrates measurable unfairness in a release window | Sideout |
| Participant split-payment engine | Adds liability allocation to the payment port for a dispute nobody has measured | Mixed member/guest payment disputes measured at a real venue | Sideout |
| Open-booking matchmaker / join-code court opening | Risks growing into a social feed, which is explicitly rejected above. R09's rotation engine already answers "who plays next" inside a session | Players demonstrably need cross-session matching that R09 cannot serve | Sideout |
| Generic hobby language in the customer-facing product | Backend neutrality (R08) is an architectural property. It must not leak into copy — a padel venue's page says padel, not "activity" | Never | Sideout |
| A dedicated accessibility roadmap row | Rejected as a *row*, not as work. Sideout's B29 was a row nobody owned and it stayed unverified to the end. R30 makes it an acceptance condition on every user-visible item instead | Never revert to a standalone row | roundrobin |
