/**
 * The committed synthetic dataset as a one-call load: twelve months of
 * one person's banking in Sydney across an everyday account, a savings
 * account and a credit card. Each file goes through the same import path as
 * a real bank export, then the configured backend categorises and internal
 * transfers are matched. `pnpm seed` and `POST /api/sample` both call this;
 * the only difference is what they do with the progress.
 *
 * The load refuses a ledger that already holds accounts or transactions, so
 * the sample never mixes with a person's own data. The CLI's `--force` is
 * `clearLedger` followed by `loadSampleData`.
 */

import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from '../db/client.js';
import type { LlmBackend } from '../llm/backend.js';
import { categorise, type CategoriseProgress, type CategoriseResult } from './categorise.js';
import { importFile } from './files/import.js';
import { matchInternalTransfers, type TransferMatchResult } from './transfers.js';

/** The committed synthetic dataset: twelve months, three accounts, AUD, Sydney merchants. */
const SAMPLES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'samples');
export const SAMPLE_FILES = {
  everyday: join(SAMPLES_DIR, 'sample-everyday.csv'),
  savings: join(SAMPLES_DIR, 'sample-savings.csv'),
  credit: join(SAMPLES_DIR, 'sample-credit.csv'),
  everydayOfx: join(SAMPLES_DIR, 'sample-everyday.ofx'),
} as const;

export const SAMPLE_ACCOUNTS = [
  { file: SAMPLE_FILES.everyday, name: 'Everyday', type: 'transaction' },
  { file: SAMPLE_FILES.savings, name: 'Savings', type: 'savings' },
  { file: SAMPLE_FILES.credit, name: 'Credit card', type: 'credit_card' },
] as const;

export type SampleProgress =
  | { stage: 'import'; account: string; file: string; inserted: number; skipped: number }
  | ({ stage: 'categorise' } & CategoriseProgress);

export interface SampleLoadOptions {
  /** Labels the imported rows when set; without one the rows stay uncategorised. */
  backend?: LlmBackend;
  onProgress?: (progress: SampleProgress) => void;
}

export interface SampleLoadResult {
  accounts: { name: string; file: string; inserted: number; skipped: number }[];
  /** Absent when no backend was given. */
  categorise?: CategoriseResult;
  transfers?: TransferMatchResult;
}

export class LedgerNotEmptyError extends Error {
  constructor(
    readonly accounts: number,
    readonly transactions: number,
  ) {
    super(
      `The ledger already holds ${String(accounts)} accounts and ${String(transactions)} transactions.`,
    );
    this.name = 'LedgerNotEmptyError';
  }
}

export function ledgerCounts(db: Db): { accounts: number; transactions: number } {
  return db
    .prepare<[], { accounts: number; transactions: number }>(
      'SELECT (SELECT count(*) FROM accounts) accounts, (SELECT count(*) FROM transactions) transactions',
    )
    .get()!;
}

export const ledgerIsEmpty = (db: Db): boolean => {
  const counts = ledgerCounts(db);
  return counts.accounts === 0 && counts.transactions === 0;
};

/** Removes every account with its transactions, balances, corrections and import runs. */
export function clearLedger(db: Db): void {
  db.transaction(() => {
    db.prepare('DELETE FROM accounts').run();
    db.prepare('DELETE FROM import_runs').run();
    db.prepare('DELETE FROM description_category_rules').run();
  })();
}

export async function loadSampleData(
  db: Db,
  options: SampleLoadOptions = {},
): Promise<SampleLoadResult> {
  const counts = ledgerCounts(db);
  if (counts.accounts || counts.transactions)
    throw new LedgerNotEmptyError(counts.accounts, counts.transactions);
  const result: SampleLoadResult = { accounts: [] };
  for (const account of SAMPLE_ACCOUNTS) {
    const file = basename(account.file);
    const imported = await importFile(db, {
      fileName: file,
      content: readFileSync(account.file, 'utf8'),
      account: { create: { name: account.name, type: account.type, currency: 'AUD' } },
    });
    if (imported.status !== 'ok')
      throw new Error(`${account.name}: ${imported.error ?? 'import failed'}`);
    const { inserted, skipped } = imported;
    result.accounts.push({ name: account.name, file, inserted, skipped });
    options.onProgress?.({ stage: 'import', account: account.name, file, inserted, skipped });
  }
  if (!options.backend) return result;
  result.categorise = await categorise(db, options.backend, {
    onProgress: (progress) => options.onProgress?.({ stage: 'categorise', ...progress }),
  });
  result.transfers = matchInternalTransfers(db);
  return result;
}
