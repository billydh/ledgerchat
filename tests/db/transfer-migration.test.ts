import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openDb } from '../../src/db/client.js';
import {
  upsertAccount,
  upsertDescriptionCategories,
  upsertTransactions,
} from '../../src/db/repo.js';

let directory: string | undefined;
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

it('removes old false transfer flags and rechecks only pairs with two hints', () => {
  directory = mkdtempSync(join(tmpdir(), 'ledgerchat-transfer-upgrade-'));
  const path = join(directory, 'ledgerchat.db');
  const legacy = new Database(path);
  legacy.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT)');
  for (const name of ['001_init.sql', '002_csv_balance_dates.sql']) {
    legacy.exec(readFileSync(new URL(`../../src/db/migrations/${name}`, import.meta.url), 'utf8'));
    legacy.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(name);
  }
  for (const id of ['everyday', 'savings'])
    upsertAccount(legacy, { source: 'csv', externalId: id, name: id, currency: 'AUD', raw: {} });
  const transaction = (id: string, account: string, amount: number, description: string) => ({
    source: 'csv',
    externalId: id,
    accountExternalId: account,
    postedAt: '2026-09-10T00:00:00.000Z',
    amountCents: amount,
    currency: 'AUD',
    descriptionRaw: description,
    descriptionNorm: description,
    status: 'posted' as const,
    raw: {},
  });
  upsertTransactions(legacy, [
    transaction('rent', 'everyday', -10_000, 'rent'),
    transaction('refund', 'savings', 10_000, 'refund'),
    transaction('transfer-out', 'everyday', -20_000, 'transfer to savings'),
    transaction('transfer-in', 'savings', 20_000, 'transfer from everyday'),
  ]);
  upsertDescriptionCategories(legacy, [
    { descriptionNorm: 'transfer to savings', subcategory: 'savings', transferHint: true },
    { descriptionNorm: 'transfer from everyday', subcategory: 'savings', transferHint: true },
  ]);
  legacy.exec(
    "UPDATE transactions SET is_internal_transfer = 1, transfer_source = 'pair', transfer_pair_id = CASE WHEN amount_cents IN (-10000, 10000) THEN 1 ELSE 3 END",
  );
  legacy.close();

  const upgraded = openDb(path);
  try {
    const rows = upgraded
      .prepare(
        'SELECT external_id, is_internal_transfer, transfer_override FROM transactions ORDER BY id',
      )
      .all();
    expect(rows).toEqual([
      { external_id: 'rent', is_internal_transfer: 0, transfer_override: null },
      { external_id: 'refund', is_internal_transfer: 0, transfer_override: null },
      { external_id: 'transfer-out', is_internal_transfer: 1, transfer_override: null },
      { external_id: 'transfer-in', is_internal_transfer: 1, transfer_override: null },
    ]);
  } finally {
    upgraded.close();
  }
});
