import { afterEach, beforeEach, expect, it } from 'vitest';
import { openMemoryDb, type Db } from '../../src/db/client.js';
import {
  finishImportRun,
  startImportRun,
  upsertAccount,
  upsertTransactions,
  type ImportRunResult,
} from '../../src/db/repo.js';
import { statusSummary } from '../../src/server/status.js';

let db: Db;
beforeEach(() => (db = openMemoryDb()));
afterEach(() => db.close());

const run = (
  result: Partial<ImportRunResult> & { status: 'ok' | 'error' },
  accountId: number | null = 1,
  fileName = 'everyday.csv',
) => {
  const id = startImportRun(db, { source: 'csv', fileName, accountId });
  finishImportRun(db, id, { inserted: 0, updated: 0, skipped: 0, ...result });
  return id;
};
function seedAccounts() {
  upsertAccount(db, {
    source: 'csv',
    externalId: 'a',
    name: 'Everyday',
    currency: 'AUD',
    raw: {},
  });
  upsertAccount(db, { source: 'csv', externalId: 'b', name: 'Empty', currency: 'AUD', raw: {} });
  upsertTransactions(
    db,
    ['2026-03-05', '2026-08-27', '2026-06-01'].map((date, i) => ({
      source: 'csv',
      externalId: String(i),
      accountExternalId: 'a',
      postedAt: `${date}T10:00:00.000Z`,
      amountCents: -100,
      currency: 'AUD',
      descriptionRaw: 'X',
      descriptionNorm: 'X',
      status: 'posted' as const,
      raw: {},
    })),
  );
}

it('never imported: no runs, no coverage, explicit nulls', () => {
  expect(statusSummary(db)).toEqual({
    accounts: 0,
    transactions: 0,
    transfers: 0,
    uncategorised: 0,
    lastImport: null,
    lastSuccessfulImport: null,
    coverage: {
      basis: 'observed_imported_transactions',
      complete_history_verified: false,
      transactions: 0,
      from: null,
      to: null,
      accounts: [],
    },
  });
});

it('successful import: file, account, row counts, coverage overall and per account', () => {
  seedAccounts();
  const id = run({
    status: 'ok',
    inserted: 3,
    updated: 0,
    unchanged: 2,
    duplicates: 0,
    skipped: 6,
  });
  const status = statusSummary(db);
  expect(status.lastImport).toMatchObject({
    id,
    source: 'csv',
    file_name: 'everyday.csv',
    account: { id: 1, name: 'Everyday' },
    status: 'ok',
    has_error: false,
    rows_inserted: 3,
    rows_updated: 0,
    rows_unchanged: 2,
    rows_duplicate: 0,
    rows_skipped: 6,
  });
  // A run recorded before the unchanged count existed keeps null, never a made-up zero.
  run({ status: 'ok', inserted: 1 });
  expect(statusSummary(db).lastImport).toMatchObject({
    rows_unchanged: null,
    rows_duplicate: null,
  });
  expect(status.lastSuccessfulImport).toEqual(status.lastImport);
  expect(status.lastImport).not.toHaveProperty('error');
  expect(status.coverage).toMatchObject({
    basis: 'observed_imported_transactions',
    complete_history_verified: false,
    transactions: 3,
    from: '2026-03-05',
    to: '2026-08-27',
  });
  expect(status.coverage.accounts).toEqual([
    {
      id: 1,
      name: 'Everyday',
      type: null,
      institution: null,
      currency: 'AUD',
      transactions: 3,
      from: '2026-03-05',
      to: '2026-08-27',
      last_import: {
        run_id: id,
        source: 'csv',
        file_name: 'everyday.csv',
        imported_at: status.lastImport!.finished_at,
        rows_inserted: 3,
        rows_updated: 0,
        rows_skipped: 6,
      },
      balance: null,
    },
    {
      id: 2,
      name: 'Empty',
      type: null,
      institution: null,
      currency: 'AUD',
      transactions: 0,
      from: null,
      to: null,
      last_import: null,
      balance: null,
    },
  ]);
});

it('failed latest attempt keeps the older successful import separate and hides the error text', () => {
  seedAccounts();
  const good = run({ status: 'ok', skipped: 0 });
  const bad = run({ status: 'error', error: 'parser 503 with details', skipped: 2 }, 2, 'bad.csv');
  const status = statusSummary(db);
  expect(status.lastImport).toMatchObject({
    id: bad,
    status: 'error',
    has_error: true,
    rows_skipped: 2,
    account: { id: 2, name: 'Empty' },
  });
  expect(status.lastSuccessfulImport).toMatchObject({ id: good, status: 'ok', rows_skipped: 0 });
  // The failed attempt is not the account's last import.
  expect(status.coverage.accounts[1]!.last_import).toBeNull();
  expect(status.coverage.accounts[0]!.last_import?.run_id).toBe(good);
  expect(JSON.stringify(status)).not.toContain('parser 503');
});

it('a running attempt is reported as such without a successful import', () => {
  seedAccounts();
  startImportRun(db, { source: 'ofx', fileName: 'export.ofx', accountId: null });
  const status = statusSummary(db);
  expect(status.lastImport).toMatchObject({
    status: 'running',
    finished_at: null,
    account: null,
    source: 'ofx',
  });
  expect(status.lastSuccessfulImport).toBeNull();
});

it('a run whose account was deleted is reported without an account', () => {
  seedAccounts();
  run({ status: 'ok' }, 2);
  db.prepare('DELETE FROM accounts WHERE id = 2').run();
  expect(statusSummary(db).lastImport?.account).toBeNull();
});
