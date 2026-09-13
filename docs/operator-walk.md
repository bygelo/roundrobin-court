# One open-play night with a real front desk

The roadmap's P1 exit condition is not a test: *one venue runs a full evening — discovery, booking, payment, waiver, check-in, fair rotation, court assignment, live score, lounge display — with no spreadsheet and no duplicate entry.* Automated tests and headless screenshots cannot pass it. This is the script for the person who can.

**Who:** one front-desk staff member who has never seen the app, one owner watching (not helping), 8–16 players.
**Setup (owner, the day before):** sign in at `/sign-in`; confirm courts, hours, and prices at `/operator/venue`; publish the site at `/operator/studio`; create tonight's open-play session at `/operator/play`; enrol the lounge TV at `/operator/display` and open its link on the TV; give the desk person the `desk` staff account.

Write down every moment the desk person hesitates, asks a question, or reaches for paper. Those are the findings.

| # | The desk person does | Where | Pass when |
|---|---|---|---|
| 1 | A player books tonight's 8 PM court on their own phone | `/v/<venue>` | Booking confirmed without staff help; recovery link saved |
| 2 | That player pays at the counter | `/operator/booking` → Record payment | Board shows *Paid*; no second entry anywhere |
| 3 | A walk-in asks for a court now | `/operator/board` → empty slot | Walk-in booked in under a minute |
| 4 | Players arrive | `/operator/arrival` | Each checked in once; a missing waiver is signed at the desk; an override asks for a reason |
| 5 | Open play starts | `/operator/play` → check players in → **Fill free courts** | Nobody plays twice in a row while someone waits; the desk can explain who is next and why |
| 6 | Players follow along | `/play/<token>` on phones, lounge TV | Up-next matches what the desk sees |
| 7 | A court finishes; a match is scored | `/operator/score` on a tablet | Score on the TV matches the tablet; confirm locks it |
| 8 | Someone buys water and a grip | `/operator/shop` → Counter | Stock drops; receipt shown |
| 9 | End of night | `/operator/insight` → Today | Revenue matches the cash drawer and the bookings list |

**Record afterwards:** date, venue, player count, every hesitation with the screen it happened on, and whether any paper, spreadsheet, or group chat was used. If none was used and step 9 reconciles, mark the P1 exit condition observed in ROADMAP.md with the date.
