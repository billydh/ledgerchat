import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMemoryDb, type Db } from '../../src/db/client.js';
import { finishImportRun, startImportRun, upsertAccount } from '../../src/db/repo.js';
import { lastImportPerAccount } from '../../src/ingest/freshness.js';

let db: Db;
beforeEach(() => {
  db = openMemoryDb();
  upsertAccount(db, { source: 'csv', externalId: 'a', name: 'Everyday', currency: 'AUD', raw: {} });
  upsertAccount(db, { source: 'csv', externalId: 'b', name: 'Savings', currency: 'AUD', raw: {} });
});
afterEach(() => db.close());

function run(
  accountId: number | null,
  status: 'ok' | 'error' | 'running',
  fileName = 'export.csv',
) {
  const id = startImportRun(db, { source: 'csv', fileName, accountId });
  if (status !== 'running')
    finishImportRun(db, id, { inserted: 3, updated: 1, skipped: 0, status, error: null });
  return id;
}

describe('lastImportPerAccount', () => {
  it('is empty when nothing has been imported', () => {
    expect(lastImportPerAccount(db).size).toBe(0);
  });

  it('keeps the latest successful run per account and leaves untouched accounts absent', () => {
    run(1, 'ok', 'march.csv');
    const later = run(1, 'ok', 'april.csv');
    const status = lastImportPerAccount(db);
    expect([...status.keys()]).toEqual([1]);
    expect(status.get(1)).toMatchObject({
      run_id: later,
      source: 'csv',
      file_name: 'april.csv',
      rows_inserted: 3,
      rows_updated: 1,
      rows_skipped: 0,
    });
    expect(status.get(1)!.imported_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('ignores failed and running attempts and runs with no account', () => {
    const good = run(2, 'ok');
    run(2, 'error');
    run(2, 'running');
    run(null, 'ok');
    expect(lastImportPerAccount(db).get(2)?.run_id).toBe(good);
    expect(lastImportPerAccount(db).has(1)).toBe(false);
  });

  it('forgets the account when it is deleted, keeping the run itself', () => {
    run(1, 'ok');
    db.prepare('DELETE FROM accounts WHERE id = 1').run();
    expect(lastImportPerAccount(db).size).toBe(0);
    expect(db.prepare('SELECT account_id FROM import_runs').get()).toEqual({ account_id: null });
  });
});
