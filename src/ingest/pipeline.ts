/**
 * Fetch -> upsert -> enrich, over any `DataSource`. The only consumer of the
 * source interface; nothing here knows which file format produced the rows.
 *
 * Idempotence is the point: `UNIQUE (source, external_id)` plus upsert means
 * importing an export that overlaps an earlier one updates rows rather than
 * duplicating them, so a file is always processed whole.
 */

import type { Db } from '../db/client.js';
import {
  finishImportRun,
  insertBalances,
  startImportRun,
  upsertAccount,
  upsertTransactions,
  type AccountInput,
  type BalanceInput,
  type TransactionInput,
} from '../db/repo.js';
import { categorise } from './categorise.js';
import { applyCategoriesToTransactions } from '../db/repo.js';
import type { LlmBackend } from '../llm/backend.js';
import { normaliseDescription } from './normalise.js';
import type { NormalisedAccount, NormalisedBalance, NormalisedTransaction } from './normalise.js';
import { isSkipReporting, type DataSource } from './source.js';
import { matchInternalTransfers } from './transfers.js';

export interface ImportOptions {
  /** Recorded on the run so the status display can say which file it came from. */
  fileName: string;
  /** Optional LLM enrichment; ingestion works without provider configuration. */
  backend?: LlmBackend;
  /** Injectable for tests; defaults to `Date.now`. */
  now?: () => number;
}

export interface ImportResult {
  runId: number;
  accountsSeen: number;
  /** Balances the source returned for a listed account; not the rows inserted. */
  balancesSeen: number;
  /** Transactions that were new to the database. */
  inserted: number;
  /** Existing transactions (by source and external_id) whose source facts changed. */
  updated: number;
  /** Existing transactions the file repeated with identical source facts. */
  unchanged: number;
  /** Rows in the file that repeated an earlier row's id; only the first was written. */
  duplicates: number;
  /** Records the source could not map, plus any row with no known account. */
  skipped: number;
  status: 'ok' | 'error';
  error?: string;
  elapsedMs: number;
}

/**
 * One line of counts for a result or a stored run. Runs recorded before the
 * unchanged and duplicate counts existed say so instead of showing a zero.
 */
export function describeImportCounts(counts: {
  inserted: number;
  updated: number;
  unchanged: number | null;
  duplicates: number | null;
  skipped: number;
}): string {
  const parts = [
    `${String(counts.inserted)} new`,
    `${String(counts.updated)} updated`,
    counts.unchanged === null ? 'unchanged not recorded' : `${String(counts.unchanged)} unchanged`,
    ...(counts.duplicates ? [`${String(counts.duplicates)} duplicate in file`] : []),
    `${String(counts.skipped)} skipped`,
  ];
  return parts.join(', ');
}

/**
 * Runs one import and records it in `import_runs`. Throws only if the run row
 * itself cannot be opened: a failure mid-import closes the row with
 * `status='error'` and is returned, so a caller always has a result to print.
 */
async function runImportUnlocked(
  db: Db,
  source: DataSource,
  opts: ImportOptions,
): Promise<ImportResult> {
  const now = opts.now ?? Date.now;
  const startedMs = now();
  const runId = startImportRun(db, { source: source.id, fileName: opts.fileName });

  const counts = {
    accountsSeen: 0,
    balancesSeen: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    duplicates: 0,
  };
  let orphaned = 0;
  let accountId: number | null = null;

  const close = (status: 'ok' | 'error', error?: string): ImportResult => {
    const skipped = orphaned + skipCountOf(source);
    finishImportRun(db, runId, {
      accountId,
      inserted: counts.inserted,
      updated: counts.updated,
      unchanged: counts.unchanged,
      duplicates: counts.duplicates,
      skipped,
      status,
      error: error ?? null,
    });
    return {
      runId,
      ...counts,
      skipped,
      status,
      ...(error === undefined ? {} : { error }),
      elapsedMs: now() - startedMs,
    };
  };

  try {
    // Accounts first: transactions carry an account external id and the upsert
    // resolves it to a row id, so an unknown account would fail the batch.
    const accounts = await source.listAccounts();
    const knownAccountIds = new Map<string, number>();
    for (const account of accounts) {
      knownAccountIds.set(account.externalId, upsertAccount(db, toAccountInput(account)));
      counts.accountsSeen++;
    }
    // A file targets one account; the run records it so "last import per
    // account" can be read back. A multi-account file leaves it null.
    if (knownAccountIds.size === 1) accountId = [...knownAccountIds.values()][0] ?? null;

    /** Resolves a row's account, warning and counting the orphan when it is unknown. */
    function resolveAccount(what: string, externalId: string, accountExternalId: string) {
      const id = knownAccountIds.get(accountExternalId);
      if (id === undefined) {
        console.warn(`skipping ${what} ${externalId}: unknown account ${accountExternalId}`);
        orphaned++;
      }
      return id;
    }

    // Balances are optional on the source. The payload may carry no
    // timestamp, so the run's start is the observation time it is stamped with.
    if (source.listBalances) {
      const observedAt = new Date(startedMs).toISOString();
      const batch: BalanceInput[] = [];
      for (const balance of await source.listBalances({ observedAt })) {
        const id = resolveAccount('balance', 'for', balance.accountExternalId);
        if (id === undefined) continue;
        batch.push(toBalanceInput(balance, id));
        counts.balancesSeen++;
      }
      insertBalances(db, batch);
    }

    // A file that repeats an id (an OFX with a duplicated FITID) writes the first
    // occurrence only; the repeats are counted so they never read as updates.
    const seen = new Set<string>();
    for await (const page of source.fetchTransactions()) {
      const batch: TransactionInput[] = [];
      for (const transaction of page) {
        // An account the source did not list: skip rather than abort the run.
        const id = resolveAccount(
          'transaction',
          transaction.externalId,
          transaction.accountExternalId,
        );
        if (id === undefined) continue;
        const key = `${transaction.source}|${transaction.externalId}`;
        if (seen.has(key)) {
          counts.duplicates++;
          continue;
        }
        seen.add(key);
        batch.push(toTransactionInput(transaction, id));
      }
      const written = upsertTransactions(db, batch);
      counts.inserted += written.inserted;
      counts.updated += written.updated;
      counts.unchanged += written.unchanged;
    }

    await enrich(db, opts.backend);
    return close('ok');
  } catch (error) {
    return close('error', error instanceof Error ? error.message : String(error));
  }
}

/** Categorise first so transfer matching can use newly persisted hints. */
async function enrich(db: Db, backend?: LlmBackend): Promise<void> {
  if (backend) {
    const result = await categorise(db, backend);
    matchInternalTransfers(db);
    if (result.failures.length) {
      throw new Error(
        `Categorisation failed for ${String(result.failures.length)} batches; run pnpm categorise to resume`,
      );
    }
  } else {
    applyCategoriesToTransactions(db);
    matchInternalTransfers(db);
  }
}

/** The repo's inputs use `null` for absent; the normalised model omits the key. */
function toAccountInput(account: NormalisedAccount): AccountInput {
  return {
    source: account.source,
    externalId: account.externalId,
    name: account.name,
    type: account.type ?? null,
    institution: account.institution ?? null,
    currency: account.currency,
    raw: account.raw,
  };
}

function toBalanceInput(balance: NormalisedBalance, accountId: number): BalanceInput {
  return {
    accountId,
    asOf: balance.asOf,
    currentCents: balance.currentCents,
    availableCents: balance.availableCents ?? null,
    currency: balance.currency,
    raw: balance.raw,
  };
}

function toTransactionInput(
  transaction: NormalisedTransaction,
  accountId: number,
): TransactionInput {
  return {
    source: transaction.source,
    externalId: transaction.externalId,
    accountExternalId: transaction.accountExternalId,
    accountId,
    postedAt: transaction.postedAt,
    executedAt: transaction.executedAt ?? null,
    amountCents: transaction.amountCents,
    currency: transaction.currency,
    descriptionRaw: transaction.descriptionRaw,
    descriptionNorm: normaliseDescription(transaction.descriptionRaw),
    status: transaction.status,
    raw: transaction.raw,
  };
}

function skipCountOf(source: DataSource): number {
  return isSkipReporting(source) ? source.skipped : 0;
}

// Serialize imports on a connection so before/after review attribution cannot overlap.
const importing = new WeakSet<Db>();
export async function runImport(
  db: Db,
  source: DataSource,
  opts: ImportOptions,
): Promise<ImportResult> {
  if (importing.has(db)) throw new Error('An import is already running; retry after it completes');
  importing.add(db);
  try {
    return await runImportUnlocked(db, source, opts);
  } finally {
    importing.delete(db);
  }
}
