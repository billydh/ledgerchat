import { afterEach, beforeEach, expect, it } from 'vitest';
import { openMemoryDb, type Db } from '../../src/db/client.js';
import {
  clearLedger,
  LedgerNotEmptyError,
  ledgerIsEmpty,
  loadSampleData,
  type SampleProgress,
} from '../../src/ingest/sample.js';

let db: Db;
beforeEach(() => (db = openMemoryDb()));
afterEach(() => db.close());

const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;

it('imports the three sample accounts through the file pipeline and reports each', async () => {
  expect(ledgerIsEmpty(db)).toBe(true);
  const progress: SampleProgress[] = [];
  const result = await loadSampleData(db, { onProgress: (p) => progress.push(p) });
  expect(result.accounts.map((a) => a.name)).toEqual(['Everyday', 'Savings', 'Credit card']);
  expect(result.categorise).toBeUndefined();
  expect(progress.map((p) => p.stage)).toEqual(['import', 'import', 'import']);
  expect(count('SELECT count(*) n FROM accounts')).toBe(3);
  expect(count('SELECT count(*) n FROM transactions')).toBe(
    result.accounts.reduce((n, a) => n + a.inserted, 0),
  );
  expect(count('SELECT count(*) n FROM import_runs')).toBe(3);
  expect(ledgerIsEmpty(db)).toBe(false);
});

it('refuses a ledger that already holds data, and clearLedger makes it empty again', async () => {
  await loadSampleData(db);
  await expect(loadSampleData(db)).rejects.toBeInstanceOf(LedgerNotEmptyError);
  clearLedger(db);
  expect(ledgerIsEmpty(db)).toBe(true);
  expect(count('SELECT count(*) n FROM import_runs')).toBe(0);
  expect((await loadSampleData(db)).accounts).toHaveLength(3);
});
