# DUPR club application — what to file, and what to do when approval lands

R20's live half is blocked on one external step only DUPR can complete. Everything on the court side is built and tested against the sandbox adapter; this page is the handoff.

## 1. File the application (owner, ~15 minutes, then 3–5 business days)

Apply as a club at [dupr.com/clubs](https://www.dupr.com/clubs) and request API partner access through [DUPR API partner integrations](https://dupr.zendesk.com/hc/en-us/categories/32142598126740-API-Partner-Integrations).

Have ready:

| Field | Value for the demo venue — replace with the real operator's |
|---|---|
| Club / venue name | Sideout Pickleball Club |
| Address | Katipunan Ave, Quezon City, Philippines |
| Contact | hello@sideout.ph · +63 917 555 0142 |
| Courts | 4 pickleball courts (indoor) |
| Integration purpose | Link consenting players' DUPR IDs, read ratings to gate rated sessions, submit confirmed match results |
| Result source | Staff-confirmed matches scored on a tablet (side-out scoring to 11, best of 3), each with a correction audit trail |
| Consent | Every player on both teams links their DUPR ID and consents before any result is sent; unconsented matches are never submitted |
| Technical contact | the developer who will hold the credentials |

Ask DUPR explicitly for: the partner-tier **write scope** (match submission), **rate limits**, the **token, player, and match endpoint paths**, and the **consent wording** they require. Those four answers are the unverified parts of R20.

## 2. When credentials arrive

```powershell
$env:DUPR_CLIENT_ID     = '<issued client id>'
$env:DUPR_CLIENT_SECRET = '<issued secret>'
$env:DUPR_BASE_URL      = '<partner API base URL>'
# Only if DUPR's paths differ from the adapter's defaults:
$env:DUPR_TOKEN_PATH  = '...'
$env:DUPR_PLAYER_PATH = '...'
$env:DUPR_MATCH_PATH  = '...'
```

Credentials live in the server environment only — the connector stores a reference to the variable name, never the value.

Then, at `/operator/connect` → DUPR:

1. **Connect DUPR** (live). The status badge must turn *Connected* with a "last checked" time. If it shows *Error*, the message names what DUPR refused.
2. **Link a player** — your own DUPR ID first, with consent ticked. The rating appears with "as of" time.
3. Score one real match at `/operator/score`, confirm it, and submit it. A receipt code must appear under Submissions; the same match submitted twice must show the same receipt.
4. Check the result on dupr.com. That observation is the R20 Tier 2 pass condition — record the date and receipt in ROADMAP.md's R20 status.

## 3. If DUPR rejects a submission

The Submissions table stores DUPR's rejection code and a suggested fix (usually an unlinked or unconsented player). Fix the link, then **Retry** — a retry reuses the same submission, it never creates a second result.
