import { beforeEach, describe, expect, it } from 'vitest';
import { migrate, openMemoryDb, type Db } from '../../src/db/client.js';
import {
  applyCategoriesToTransactions,
  finishImportRun,
  getImportRun,
  getLastImportRun,
  getLastSuccessfulImportRun,
  getSetting,
  getUncategorisedDescriptions,
  insertBalances,
  setSetting,
  startImportRun,
  UnknownAccountError,
  upsertAccount,
  upsertDescriptionCategories,
  upsertTransactionOverride,
  upsertTransactions,
  type TransactionInput,
  type TransactionRow,
} from '../../src/db/repo.js';

let db: Db;

beforeEach(() => {
  db = openMemoryDb();
});

const account = {
  source: 'csv',
  externalId: 'acc-1',
  name: 'Everyday',
  type: 'transaction',
  institution: 'Test Bank',
  currency: 'AUD',
  raw: { id: 'acc-1' },
};

function tx(overrides: Partial<TransactionInput> = {}): TransactionInput {
  return {
    source: 'csv',
    externalId: 'tx-1',
    accountExternalId: 'acc-1',
    postedAt: '2026-08-01T00:00:00.000Z',
    amountCents: -1250,
    currency: 'AUD',
    descriptionRaw: 'WOOLWORTHS 1234',
    descriptionNorm: 'WOOLWORTHS',
    status: 'posted',
    raw: { id: 'tx-1' },
    ...overrides,
  };
}

function getTx(externalId: string): TransactionRow {
  const row = db
    .prepare<[string], TransactionRow>('SELECT * FROM transactions WHERE external_id = ?')
    .get(externalId);
  if (!row) throw new Error(`no transaction ${externalId}`);
  return row;
}

describe('schema', () => {
  it('creates every table and index', () => {
    const names = db
      .prepare<[], { name: string; type: string }>('SELECT name, type FROM sqlite_master')
      .all();
    const tables = names.filter((r) => r.type === 'table').map((r) => r.name);
    for (const table of [
      'accounts',
      'account_balances',
      'transactions',
      'description_categories',
      'import_runs',
      'settings',
      'conversations',
      'conversation_messages',
      'transaction_category_overrides',
      'description_category_rules',
      'schema_migrations',
    ]) {
      expect(tables).toContain(table);
    }
    for (const gone of ['sync_runs', 'webhook_events', 'direct_debits', 'identities']) {
      expect(tables).not.toContain(gone);
    }
    const indexes = names.filter((r) => r.type === 'index').map((r) => r.name);
    for (const index of [
      'idx_transactions_posted_at',
      'idx_transactions_account_posted_at',
      'idx_transactions_subcategory',
      'idx_transactions_description_norm',
      'idx_import_runs_account',
    ]) {
      expect(indexes).toContain(index);
    }
  });

  it('applies the released schema and records it', () => {
    expect(
      db
        .prepare<[], { name: string }>('SELECT name FROM schema_migrations ORDER BY name')
        .all()
        .map((r) => r.name),
    ).toEqual(['001_init.sql', '002_csv_balance_dates.sql', '003_transfer_override.sql']);
  });

  it('repairs old CSV balance dates without moving OFX observations', () => {
    const accountId = upsertAccount(db, account);
    db.prepare("DELETE FROM schema_migrations WHERE name = '002_csv_balance_dates.sql'").run();
    const csv = {
      accountId,
      currentCents: 415806,
      currency: 'AUD',
      raw: { line: 8, date: '2026-08-31' },
    };
    insertBalances(db, [
      { ...csv, asOf: '2026-09-01T00:00:00.000Z' },
      { ...csv, currentCents: 415900, asOf: '2026-09-02T00:00:00.000Z' },
      {
        accountId,
        asOf: '2026-08-30T12:00:00.000Z',
        currentCents: 420000,
        currency: 'AUD',
        raw: { asOf: '2026-08-30T12:00:00.000Z' },
      },
    ]);
    migrate(db);
    expect(
      db.prepare('SELECT as_of, current_cents FROM account_balances ORDER BY as_of').all(),
    ).toEqual([
      { as_of: '2026-08-30T12:00:00.000Z', current_cents: 420000 },
      { as_of: '2026-08-31T23:59:59.999Z', current_cents: 415900 },
    ]);
    expect(() => migrate(db)).not.toThrow();
  });

  it('keeps an already dated balance when a legacy CSV copy has the same statement day', () => {
    const accountId = upsertAccount(db, account);
    db.prepare("DELETE FROM schema_migrations WHERE name = '002_csv_balance_dates.sql'").run();
    const raw = { line: 8, date: '2026-08-31' };
    insertBalances(db, [
      { accountId, asOf: '2026-08-31T23:59:59.999Z', currentCents: 415806, currency: 'AUD', raw },
      { accountId, asOf: '2026-09-22T00:00:00.000Z', currentCents: 410000, currency: 'AUD', raw },
    ]);
    migrate(db);
    expect(db.prepare('SELECT as_of, current_cents FROM account_balances').all()).toEqual([
      { as_of: '2026-08-31T23:59:59.999Z', current_cents: 415806 },
    ]);
  });

  it('enables foreign keys', () => {
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('re-running migrations is a no-op', () => {
    const before = db
      .prepare<[], { name: string }>('SELECT name FROM schema_migrations')
      .all()
      .map((r) => r.name);
    expect(() => migrate(db)).not.toThrow();
    const after = db
      .prepare<[], { name: string }>('SELECT name FROM schema_migrations')
      .all()
      .map((r) => r.name);
    expect(after).toEqual(before);
    expect(after.length).toBeGreaterThan(0);
  });
});

describe('accounts and transactions', () => {
  it('upserts an account idempotently, updating mutable fields', () => {
    const id = upsertAccount(db, account);
    const again = upsertAccount(db, { ...account, name: 'Everyday Renamed' });
    expect(again).toBe(id);
    const row = db
      .prepare<[], { name: string; count: number }>(
        'SELECT name, (SELECT count(*) FROM accounts) AS count FROM accounts',
      )
      .get();
    expect(row).toEqual({ name: 'Everyday Renamed', count: 1 });
  });

  it('rejects a transaction whose account has not been upserted', () => {
    expect(() => upsertTransactions(db, [tx({ accountExternalId: 'missing' })])).toThrow(
      UnknownAccountError,
    );
  });

  it('re-upserting preserves label and transfer enrichment', () => {
    upsertAccount(db, account);
    upsertTransactions(db, [tx()]);
    db.prepare(
      `UPDATE transactions SET machine_subcategory = 'dining',
         is_subscription = 1, is_internal_transfer = 1, transfer_source = 'pair',
         transfer_pair_id = 99`,
    ).run();
    upsertTransactionOverride(db, getTx('tx-1').id, 'groceries');

    upsertTransactions(db, [tx({ amountCents: -9999, status: 'pending' })]);

    const row = getTx('tx-1');
    expect(row.amount_cents).toBe(-9999);
    expect(row.status).toBe('pending');
    expect(row.subcategory).toBe('groceries');
    expect(row.category_source).toBe('manual');
    expect(row.category_origin).toBe('transaction_override');
    expect(row.machine_subcategory).toBe('dining');
    expect(row.is_subscription).toBe(1);
    expect(row.is_internal_transfer).toBe(1);
    expect(row.transfer_source).toBe('pair');
    expect(row.transfer_pair_id).toBe(99);
  });

  it('upserting the same batch twice does not duplicate rows', () => {
    upsertAccount(db, account);
    const batch = [tx(), tx({ externalId: 'tx-2', amountCents: 5000 })];
    expect(upsertTransactions(db, batch)).toEqual({ inserted: 2, updated: 0, unchanged: 0 });
    // The same facts again are unchanged; a changed amount or status is one update each.
    expect(
      upsertTransactions(db, [
        tx(),
        tx({ externalId: 'tx-2', amountCents: 5001 }),
        tx({ externalId: 'tx-3' }),
      ]),
    ).toEqual({ inserted: 1, updated: 1, unchanged: 1 });
    expect(upsertTransactions(db, [tx({ status: 'pending' })])).toEqual({
      inserted: 0,
      updated: 1,
      unchanged: 0,
    });
    const { count } = db
      .prepare<[], { count: number }>('SELECT count(*) AS count FROM transactions')
      .get() ?? { count: -1 };
    expect(count).toBe(3);
  });

  it('an empty batch writes nothing', () => {
    expect(upsertTransactions(db, [])).toEqual({ inserted: 0, updated: 0, unchanged: 0 });
  });
});

describe('settings', () => {
  it('round-trips and overwrites', () => {
    expect(getSetting(db, 'ui.theme')).toBeUndefined();
    setSetting(db, 'ui.theme', 'light');
    expect(getSetting(db, 'ui.theme')).toBe('light');
    setSetting(db, 'ui.theme', 'dark');
    expect(getSetting(db, 'ui.theme')).toBe('dark');
  });
});

describe('balances', () => {
  it('inserts a batch and drops a repeated observation without updating it', () => {
    const accountId = upsertAccount(db, account);
    const observation = {
      accountId,
      asOf: '2026-09-11T05:00:00.000Z',
      currentCents: 74777,
      availableCents: 80295,
      currency: 'AUD',
      raw: { current_balance: '747.77' },
    };

    expect(insertBalances(db, [observation])).toBe(1);
    expect(insertBalances(db, [{ ...observation, currentCents: 0 }])).toBe(0);
    expect(insertBalances(db, [{ ...observation, asOf: '2026-09-12T05:00:00.000Z' }])).toBe(1);

    const rows = db
      .prepare<[], { as_of: string; current_cents: number; available_cents: number | null }>(
        'SELECT as_of, current_cents, available_cents FROM account_balances ORDER BY id',
      )
      .all();
    expect(rows).toEqual([
      { as_of: '2026-09-11T05:00:00.000Z', current_cents: 74777, available_cents: 80295 },
      { as_of: '2026-09-12T05:00:00.000Z', current_cents: 74777, available_cents: 80295 },
    ]);
  });

  it('rejects a balance for an account that does not exist and cascades on delete', () => {
    const accountId = upsertAccount(db, account);
    const balance = { asOf: '2026-09-11T05:00:00.000Z', currentCents: 1, currency: 'AUD', raw: {} };
    expect(() => insertBalances(db, [{ ...balance, accountId: accountId + 1 }])).toThrow(
      /FOREIGN KEY/,
    );
    insertBalances(db, [{ ...balance, accountId }]);
    db.prepare('DELETE FROM accounts').run();
    expect(db.prepare('SELECT count(*) AS n FROM account_balances').get()).toEqual({ n: 0 });
  });
});

describe('import runs', () => {
  it('writes both timestamps, the file, the account and the counts', () => {
    const accountId = upsertAccount(db, account);
    const id = startImportRun(db, { source: 'csv', fileName: 'everyday.csv', accountId });
    expect(getImportRun(db, id)).toMatchObject({
      source: 'csv',
      file_name: 'everyday.csv',
      account_id: accountId,
      status: 'running',
      finished_at: null,
    });
    finishImportRun(db, id, { inserted: 40, updated: 2, skipped: 1, status: 'ok' });

    const row = getLastSuccessfulImportRun(db);
    expect(row).toBeDefined();
    expect(row?.started_at).toBeTruthy();
    expect(row?.finished_at).toBeTruthy();
    expect(row).toMatchObject({
      rows_inserted: 40,
      rows_updated: 2,
      rows_unchanged: null,
      rows_duplicate: null,
      rows_skipped: 1,
      status: 'ok',
      error: null,
    });
    finishImportRun(db, id, {
      inserted: 0,
      updated: 0,
      unchanged: 42,
      duplicates: 1,
      skipped: 0,
      status: 'ok',
    });
    expect(getLastSuccessfulImportRun(db)).toMatchObject({ rows_unchanged: 42, rows_duplicate: 1 });
  });

  it('lets the account be attached at finish and keeps an earlier attribution', () => {
    const accountId = upsertAccount(db, account);
    const id = startImportRun(db, { source: 'ofx', fileName: 'export.ofx' });
    expect(getImportRun(db, id)?.account_id).toBeNull();
    finishImportRun(db, id, { accountId, inserted: 1, updated: 0, skipped: 0, status: 'ok' });
    expect(getImportRun(db, id)?.account_id).toBe(accountId);
    // A null at finish never clears what start recorded.
    const second = startImportRun(db, { source: 'ofx', fileName: 'export.ofx', accountId });
    finishImportRun(db, second, {
      accountId: null,
      inserted: 0,
      updated: 0,
      skipped: 0,
      status: 'ok',
    });
    expect(getImportRun(db, second)?.account_id).toBe(accountId);
  });

  it('records an error run and excludes it from the last successful run', () => {
    const accountId = upsertAccount(db, account);
    const ok = startImportRun(db, { source: 'csv', fileName: 'a.csv', accountId });
    finishImportRun(db, ok, { inserted: 1, updated: 0, skipped: 0, status: 'ok' });
    const failed = startImportRun(db, { source: 'csv', fileName: 'b.csv', accountId });
    finishImportRun(db, failed, {
      inserted: 0,
      updated: 0,
      skipped: 0,
      status: 'error',
      error: 'boom',
    });

    expect(getLastImportRun(db)?.id).toBe(failed);
    expect(getLastSuccessfulImportRun(db)?.id).toBe(ok);
    expect(getLastSuccessfulImportRun(db, accountId)?.id).toBe(ok);
    expect(getLastSuccessfulImportRun(db, accountId + 1)).toBeUndefined();
    expect(getImportRun(db, failed)).toMatchObject({ status: 'error', error: 'boom' });
  });

  it('rejects an unknown account and survives the account being deleted', () => {
    expect(() => startImportRun(db, { source: 'csv', fileName: 'x.csv', accountId: 99 })).toThrow(
      /FOREIGN KEY/,
    );
    const accountId = upsertAccount(db, account);
    const id = startImportRun(db, { source: 'csv', fileName: 'x.csv', accountId });
    db.prepare('DELETE FROM accounts').run();
    expect(getImportRun(db, id)?.account_id).toBeNull();
  });
});

describe('categorisation cache', () => {
  beforeEach(() => {
    upsertAccount(db, account);
    upsertTransactions(db, [
      tx(),
      tx({ externalId: 'tx-2', descriptionNorm: 'WOOLWORTHS' }),
      tx({ externalId: 'tx-3', descriptionNorm: 'OPAL TOP UP' }),
    ]);
  });

  it('returns each uncategorised description once', () => {
    expect(getUncategorisedDescriptions(db, 10)).toEqual(['OPAL TOP UP', 'WOOLWORTHS']);
  });

  it('applies cached labels and stops returning them as uncategorised', () => {
    upsertDescriptionCategories(db, [
      {
        descriptionNorm: 'WOOLWORTHS',
        subcategory: 'groceries',
        confidence: 0.9,
        isSubscription: false,
        model: 'test',
      },
      { descriptionNorm: 'OPAL TOP UP', subcategory: 'public_transport', transferHint: true },
    ]);

    expect(applyCategoriesToTransactions(db)).toBe(3);
    expect(getUncategorisedDescriptions(db, 10)).toEqual([]);
    expect(getTx('tx-1').subcategory).toBe('groceries');
    expect(getTx('tx-1').category_source).toBe('llm');
    expect(getTx('tx-1').is_subscription).toBe(0);
    expect(getTx('tx-3').subcategory).toBe('public_transport');
    // An omitted hint stays unknown rather than becoming false.
    expect(getTx('tx-3').is_subscription).toBeNull();
    expect(applyCategoriesToTransactions(db)).toBe(0);
  });

  it('carries a subscription hint onto transactions and updates it in place', () => {
    upsertDescriptionCategories(db, [
      { descriptionNorm: 'WOOLWORTHS', subcategory: 'groceries', isSubscription: null },
    ]);
    applyCategoriesToTransactions(db);
    expect(getTx('tx-1').is_subscription).toBeNull();

    upsertDescriptionCategories(db, [
      { descriptionNorm: 'WOOLWORTHS', subcategory: 'groceries', isSubscription: true },
    ]);
    expect(applyCategoriesToTransactions(db)).toBe(2);
    expect(getTx('tx-1').is_subscription).toBe(1);
  });

  it('never overwrites a correction, but still records the machine label under it', () => {
    upsertTransactionOverride(db, getTx('tx-1').id, 'dining');
    upsertDescriptionCategories(db, [
      { descriptionNorm: 'WOOLWORTHS', subcategory: 'groceries', isSubscription: false },
    ]);
    applyCategoriesToTransactions(db);

    expect(getTx('tx-1')).toMatchObject({
      subcategory: 'dining',
      machine_subcategory: 'groceries',
      category_origin: 'transaction_override',
      category_source: 'manual',
      is_subscription: 0,
    });
    expect(getTx('tx-2')).toMatchObject({
      subcategory: 'groceries',
      category_origin: 'llm',
      category_source: 'llm',
    });
  });
});
