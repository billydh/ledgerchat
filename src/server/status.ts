import type { Db } from '../db/client.js';
import type { ImportRunRow } from '../db/repo.js';
import { lastImportPerAccount, type AccountImport } from '../ingest/freshness.js';

/**
 * What `/api/status` says about stored data. Everything here is read from
 * SQLite. Two things are kept apart on purpose: when a file was last imported
 * (`import_runs`, per account and overall) and what date range the stored
 * transactions cover (observed, never verified complete). A failed latest
 * attempt is reported as such and never stands in for the last successful
 * import, which keeps its own row.
 */

export interface ImportRunSummary {
  id: number;
  source: string;
  file_name: string;
  account: { id: number; name: string } | null;
  started_at: string;
  finished_at: string | null;
  status: 'running' | 'ok' | 'error';
  /** Whether an error message is stored; the text stays in the database. */
  has_error: boolean;
  rows_inserted: number;
  rows_updated: number;
  /** null when the run predates the unchanged/duplicate counts (migration 010). */
  rows_unchanged: number | null;
  rows_duplicate: number | null;
  rows_skipped: number;
}

export interface AccountCoverage {
  id: number;
  name: string;
  type: string | null;
  institution: string | null;
  currency: string;
  transactions: number;
  /** Earliest and latest posted dates observed; null when nothing is imported. */
  from: string | null;
  to: string | null;
  /** The last successful import into this account; null when there has been none. */
  last_import: AccountImport | null;
  /** The latest dated statement balance; null when no balance has been imported. */
  balance: { current_cents: number; currency: string; as_of: string } | null;
}

export interface CoverageSummary {
  basis: 'observed_imported_transactions';
  complete_history_verified: false;
  transactions: number;
  from: string | null;
  to: string | null;
  accounts: AccountCoverage[];
}

export interface StatusSummary {
  accounts: number;
  transactions: number;
  transfers: number;
  uncategorised: number;
  /** The most recent attempt, whatever its outcome. */
  lastImport: ImportRunSummary | null;
  /** The most recent run that finished ok; same object as lastImport when that one did. */
  lastSuccessfulImport: ImportRunSummary | null;
  coverage: CoverageSummary;
}

function summariseRun(db: Db, run: ImportRunRow): ImportRunSummary {
  const account =
    run.account_id === null
      ? undefined
      : db
          .prepare<[number], { id: number; name: string }>(
            'SELECT id, name FROM accounts WHERE id = ?',
          )
          .get(run.account_id);
  return {
    id: run.id,
    source: run.source,
    file_name: run.file_name,
    account: account ?? null,
    started_at: run.started_at,
    finished_at: run.finished_at,
    status: run.status,
    has_error: run.error !== null,
    rows_inserted: run.rows_inserted,
    rows_updated: run.rows_updated,
    rows_unchanged: run.rows_unchanged,
    rows_duplicate: run.rows_duplicate,
    rows_skipped: run.rows_skipped,
  };
}

export function statusSummary(db: Db): StatusSummary {
  const counts = db
    .prepare<
      [],
      { accounts: number; transactions: number; transfers: number; uncategorised: number }
    >(
      `SELECT (SELECT count(*) FROM accounts) accounts, count(*) transactions,
              coalesce(sum(is_internal_transfer), 0) transfers,
              coalesce(sum(subcategory IS NULL), 0) uncategorised
       FROM transactions`,
    )
    .get()!;
  const lastRun = db
    .prepare<[], ImportRunRow>('SELECT * FROM import_runs ORDER BY id DESC LIMIT 1')
    .get();
  const lastOk =
    lastRun?.status === 'ok'
      ? lastRun
      : db
          .prepare<[], ImportRunRow>(
            "SELECT * FROM import_runs WHERE status = 'ok' ORDER BY id DESC LIMIT 1",
          )
          .get();
  const overall = db
    .prepare<[], { from: string | null; to: string | null }>(
      'SELECT min(substr(posted_at, 1, 10)) "from", max(substr(posted_at, 1, 10)) "to" FROM transactions',
    )
    .get()!;
  const imports = lastImportPerAccount(db);
  const balances = new Map(
    db
      .prepare<[], { account_id: number; current_cents: number; currency: string; as_of: string }>(
        `SELECT b.account_id, b.current_cents, b.currency, b.as_of
         FROM account_balances b
         WHERE b.id = (
           SELECT id FROM account_balances WHERE account_id = b.account_id
           ORDER BY as_of DESC, id DESC LIMIT 1
         )`,
      )
      .all()
      .map(({ account_id, ...balance }) => [account_id, balance]),
  );
  const accounts = db
    .prepare<[], Omit<AccountCoverage, 'last_import' | 'balance'>>(
      `SELECT a.id, a.name, a.type, a.institution, a.currency, count(t.id) transactions,
              min(substr(t.posted_at, 1, 10)) "from", max(substr(t.posted_at, 1, 10)) "to"
       FROM accounts a LEFT JOIN transactions t ON t.account_id = a.id
       GROUP BY a.id ORDER BY a.id`,
    )
    .all()
    .map((account) => ({
      ...account,
      last_import: imports.get(account.id) ?? null,
      balance: balances.get(account.id) ?? null,
    }));
  return {
    ...counts,
    lastImport: lastRun ? summariseRun(db, lastRun) : null,
    lastSuccessfulImport: lastOk ? summariseRun(db, lastOk) : null,
    coverage: {
      basis: 'observed_imported_transactions',
      complete_history_verified: false,
      transactions: counts.transactions,
      from: overall.from,
      to: overall.to,
      accounts,
    },
  };
}
