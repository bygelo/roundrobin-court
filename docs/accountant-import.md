# Importing the journal into accounting software

R16 passes only when *an accountant imports the export into their software without manual repair.* roundrobin reports and exports; it does not keep the books. This page is what to hand the accountant.

## Get the file

`/operator/insight` → pick the month → **Accountant journal (CSV)**. The same file is `GET /api/v1/insight/journal.csv?from=YYYY-MM-DD&to=YYYY-MM-DD` with an API key holding `insight.read`.

## What is in it

One row per journal line; lines sharing an `entry_number` form one balanced entry (total debit = total credit).

| Column | Meaning |
|---|---|
| `entry_date` | Venue-local date the money moved (payment posted, refund issued) |
| `entry_number` | Groups the lines of one entry |
| `account_code`, `account_name` | The account the line posts to (mapping below) |
| `debit_amount`, `credit_amount` | Exactly one is non-zero; two decimals; pesos |
| `reference` | Payment, invoice, order, or refund code — searchable in the app |
| `memo` | Human description, e.g. "Court 1 booking, Sep 14 8:00 PM" |

The account mapping is shown in the app under Insight → *How the journal maps accounts*. Cash-like accounts are split by method (cash, GCash, card terminal, online), revenue by source (court rental, programs, merchandise, membership), and refunds post to their own account.

## Import

- **Xero:** Accounting → Manual journals → Import; map `entry_date`→Date, `entry_number`→Narration group, `account_code`→Account code, debit/credit columns directly. Create the account codes from the mapping table first.
- **QuickBooks Online:** use a journal-entry import tool (or Accountant Toolbox → Import journal entries); map the same columns.
- **Any other package:** it needs a *journal entry* CSV import with debit and credit columns.

## Record the result

After the accountant imports one full month, write in ROADMAP.md's R16 status: the software and version, the month, and either "imported without edits" (R16 passes) or exactly what had to be changed (that becomes the next fix to the export).
