# Importing files

ledgerchat reads bank exports in two formats: CSV and OFX (1.x SGML or 2.x
XML; QFX is OFX with extra headers). A file is read in memory, previewed, and
only written when you confirm. Nothing about the file is stored except the
rows it produced and an `import_runs` record (file name, account, rows new,
updated, unchanged, repeated in the file and skipped, timestamps).

Two entry points share one code path (`src/ingest/files/`):

- the web UI: **Import** in the header, or the view a fresh database opens on;
- the CLI: `pnpm import:file <file> [options]` (the name is not `pnpm import`
  because pnpm has a built-in command of that name).

Both produce the same preview: the first 20 normalised rows, the row count,
how many rows are already stored (an estimate before anything is compared:
each will be reported as updated or unchanged once imported), parse errors by
line, and for CSV the detected column mapping with a confidence per role.

## Accounts

A CSV cannot say which account it belongs to, so an import targets one
existing account or creates one with a name, a type (`transaction`,
`savings`, `credit_card`, `loan`, `other`) and a currency. An OFX file names
its own account (`BANKID:ACCTID`) and type, and is created on first import;
give it a friendlier name with `--account-name` (CLI) or rename later. A file
of either format can be imported into an account the other created.

CLI: `--account <name|id>` or `--create-account <name> [--type t] [--currency
AUD] [--institution name]`.

## CSV

The reader is RFC 4180: quoted fields, doubled quotes, embedded newlines, a
UTF-8 BOM, CRLF or CR line endings. The delimiter (comma, semicolon, tab) is
the one that splits the first lines most consistently; row one is a header
when none of its cells looks like a number or a date and row two has one.

Column detection scores every column by what its values parse as, with the
header name as a tiebreak, and reports a confidence per role:

| Role        | How it is found                                                                                                                                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| date        | The column where the most values parse as a date, in one of `YYYY-MM-DD`, `DD/MM/YYYY`, `MM/DD/YYYY`, `DD-MM-YYYY`, `DD MMM YYYY`. A trailing time is ignored. |
| amount      | One signed column, or a debit/credit pair: two numeric columns never both filled on a row, named by their headers when possible.                               |
| sign        | For a signed column: the sign of the majority of rows whose description looks like a purchase, or a header hint such as `Spent`. Default `spend_negative`.     |
| description | The longest free-text column, header names such as `Description` or `Narrative` first. A `Memo`, `Reference` or `Details` column is appended with `\|`.        |
| balance     | A numeric column named like `balance`, never guessed from values alone.                                                                                        |
| status      | A column named `Status` whose values include `Pending`; those rows are stored as pending.                                                                      |

When every date in the file fits both `DD/MM` and `MM/DD` (no day above 12),
the file cannot say which it is: `DD/MM/YYYY` is assumed and the preview says
so. Set it explicitly (`--date-format`, or the select in the UI). Anything the
detector gets wrong can be pinned: `--sign spend_positive` for a file whose
purchases are positive numbers, `--map date=Col,amount=Col,debit=Col,credit=Col,description=Col,memo=Col,balance=Col`
by header name or 1-based column number. The UI shows the same roles as
selects, and every change re-runs the preview.

Amounts accept `$`, `A$` and a currency code, thousands separators (`1,234.56`
or `1.234,56`), a leading or trailing minus, parentheses for negatives and a
trailing `CR` (credit) or `DR` (debit). Every unmapped column is kept in the
row's `raw_json`.

A row that fails to parse (a date that is not a date, an amount that is not a
number, an empty description) is listed by line number, counted as skipped in
the run, and never aborts the import.

If the file has a balance column, the balance on the latest-dated row is
recorded for that statement date, which is what `list_accounts` reports. CSV
does not carry an exact observation time, so ledgerchat stores the end of that
calendar day in UTC. The import time is recorded separately on the import run.

## OFX and QFX

The reader handles the SGML form (no closing tags on leaves) and the XML form
with one tokeniser. Bank (`STMTRS`) and credit card (`CCSTMTRS`) statements are
both read; a file with several statements creates several accounts. Per
transaction: `FITID` is the external id, `DTPOSTED` the date, `TRNAMT` the
amount, and `NAME` plus `MEMO` form the description (`TRNTYPE` is the fallback
and stays in `raw_json`). `LEDGERBAL` and `AVAILBAL` become the balance
observation with the file's `DTASOF`.

The zone offset in an OFX date is deliberately ignored: the calendar day the
bank printed is the day every date filter sees, the same as a CSV row.

## Deduplication and re-imports

Every transaction is unique by `(source, external_id)` and every write is an
upsert. OFX rows use `FITID`. CSV rows carry no id, so they get
`sha256(account source | account external id | date | amount in cents |
raw description | ordinal among identical rows in this file)`. The account
source distinguishes accounts whose external ids happen to match. Two coffees
on the same day at the same price are ordinals 0 and 1 and both survive;
re-importing the same export, or one that overlaps it, never inserts duplicates.
Rows stored under the earlier CSV hash retain their ids when re-imported into
the same account. An overlapping export that has since gained a row inserts
just that row.

A re-import refreshes the facts the file owns (date, amount, description,
status) and leaves enrichment alone: labels, corrections, subscription hints
and transfer flags survive.

## What the counts mean

Every run reports, in the import result, the Accounts & imports history, the
CLI and `/api/status`:

| Count                | Rule                                                                                                                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| new                  | no row with that `(source, external_id)` existed before the run                                                                                                                  |
| updated              | the row existed and at least one source fact differs from what was stored: account, dates, amount, currency, description or status (a pending row becoming posted is one update) |
| unchanged            | the row existed with identical source facts; the file repeated it                                                                                                                |
| repeated in the file | a later row in the same file carried an id an earlier row already used (an OFX with a duplicated `FITID`); only the first is written and the repeat is neither new nor an update |
| skipped              | rows that failed to parse, plus rows for an account the file did not list                                                                                                        |

Counts compare stored facts with the file, not how many statements ran, so
importing the same file twice reports every row unchanged and zero updated.
Your own category corrections are not source facts: they neither count as
changes nor are touched. Runs recorded before these counts existed show
"unchanged not recorded" rather than a zero that was never measured.

## After the import

Transfer matching runs at the end of every import: equal and opposite posted
amounts in different accounts within three days are paired only when both
descriptions have a transfer hint from categorisation and each leg has exactly
one plausible counterpart. Ambiguous matches and unpaired hints remain visible
in spending. You can correct a transfer decision in Transactions;
corrections survive re-imports. Categorisation is a separate step, so the
import result is visible before the model runs:
**Categorise now** in the UI, or `pnpm categorise`. See
[categories.md](categories.md).
