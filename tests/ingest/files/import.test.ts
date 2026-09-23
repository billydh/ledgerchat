import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { openMemoryDb, type Db } from '../../../src/db/client.js';
import {
  getImportRun,
  upsertAccount,
  upsertDescriptionCategories,
  upsertTransactions,
} from '../../../src/db/repo.js';
import { matchInternalTransfers } from '../../../src/ingest/transfers.js';
import {
  AccountError,
  createAccount,
  findAccountByName,
  listAccounts,
  slugForAccount,
} from '../../../src/ingest/files/account.js';
import { importFile, previewImport } from '../../../src/ingest/files/import.js';
import { csvExternalId, detectFormat, FileImportError } from '../../../src/ingest/files/source.js';

const fixture = (name: string) =>
  readFileSync(new URL(`../../../fixtures/files/${name}`, import.meta.url), 'utf8');
const NEW_ACCOUNT = { create: { name: 'Everyday', type: 'transaction' as const, currency: 'AUD' } };
const file = (name: string, extra: Record<string, unknown> = {}) => ({
  fileName: name,
  content: fixture(name),
  ...(name.endsWith('.csv') ? { account: NEW_ACCOUNT } : {}),
  ...extra,
});

const count = (db: Db, table: string) =>
  db.prepare<[], { n: number }>(`SELECT count(*) n FROM ${table}`).get()!.n;

describe('detectFormat', () => {
  it('uses the extension, then the content', () => {
    expect(detectFormat('x.QFX', '')).toBe('ofx');
    expect(detectFormat('x.csv', '<OFX>')).toBe('csv');
    expect(detectFormat('export.txt', 'OFXHEADER:100\n<OFX>')).toBe('ofx');
    expect(detectFormat('export.txt', 'Date,Amount')).toBe('csv');
  });
});

describe('previewImport', () => {
  it('returns the mapping, the first rows, counts and a balance for a CSV', () => {
    const db = openMemoryDb();
    const preview = previewImport(db, file('signed-header.csv'));
    expect(preview).toMatchObject({
      format: 'csv',
      file_name: 'signed-header.csv',
      row_count: 7,
      existing_count: 0,
      error_count: 0,
      errors: [],
    });
    expect(preview.accounts).toEqual([
      { id: null, name: 'Everyday', type: 'transaction', currency: 'AUD', external_id: 'everyday' },
    ]);
    expect(preview.mapping).toMatchObject({
      columns: ['Date', 'Description', 'Amount', 'Balance'],
      delimiter: ',',
      has_header: true,
      date_format: 'YYYY-MM-DD',
      ambiguous_date: false,
      sign: 'spend_negative',
      amount_kind: 'signed',
    });
    expect(preview.mapping!.roles.map((r) => [r.role, r.columns])).toEqual([
      ['date', [0]],
      ['amount', [2]],
      ['sign', []],
      ['description', [1]],
      ['balance', [3]],
    ]);
    expect(preview.rows[0]).toEqual({
      line: 2,
      date: '2026-08-01',
      amount_cents: -8420,
      currency: 'AUD',
      description: 'WOOLWORTHS 3120 RICHMOND',
      status: 'posted',
      exists: false,
    });
    expect(preview.balances).toEqual([
      { account_external_id: 'everyday', current_cents: 415806, as_of: '2026-08-31T23:59:59.999Z' },
    ]);
    // A preview creates nothing.
    expect(count(db, 'accounts')).toBe(0);
    expect(count(db, 'import_runs')).toBe(0);
  });

  it('lists parse errors by line and counts rows already imported', async () => {
    const db = openMemoryDb();
    await importFile(db, file('signed-header.csv'));
    const content = `${fixture('signed-header.csv')}bad,ROW,x,1\n`;
    const preview = previewImport(db, { fileName: 'again.csv', content, account: { id: 1 } });
    expect(preview).toMatchObject({ row_count: 7, existing_count: 7, error_count: 1 });
    expect(preview.errors).toEqual([{ line: 9, message: 'Date: "bad" is not a YYYY-MM-DD date' }]);
    expect(preview.rows.every((r) => r.exists)).toBe(true);
    expect(preview.accounts[0]).toMatchObject({ id: 1, name: 'Everyday' });
  });

  it('describes an OFX file from its own account identity', () => {
    const db = openMemoryDb();
    const preview = previewImport(db, file('sample-2x.ofx'));
    expect(preview.format).toBe('ofx');
    expect(preview.mapping).toBeNull();
    expect(preview.accounts).toEqual([
      {
        id: null,
        name: 'Example Cards credit card 1111',
        type: 'credit_card',
        currency: 'AUD',
        external_id: '4111XXXXXXXX1111',
      },
    ]);
    expect(preview).toMatchObject({ row_count: 2, error_count: 1 });
    expect(preview.balances[0]).toMatchObject({
      current_cents: -121055,
      as_of: '2026-08-31T00:00:00.000Z',
    });
  });

  it('applies mapping overrides to the preview', () => {
    const db = openMemoryDb();
    const preview = previewImport(
      db,
      file('ambiguous.csv', { mapping: { dateFormat: 'MM/DD/YYYY' } }),
    );
    expect(preview.mapping!.ambiguous_date).toBe(false);
    expect(preview.rows.map((r) => r.date)).toEqual(['2026-01-02', '2026-03-04', '2026-05-06']);
  });

  it('refuses a CSV with no account and an unknown account id', () => {
    const db = openMemoryDb();
    expect(() =>
      previewImport(db, { fileName: 'x.csv', content: fixture('ambiguous.csv') }),
    ).toThrow(FileImportError);
    expect(() => previewImport(db, file('ambiguous.csv', { account: { id: 9 } }))).toThrow(
      AccountError,
    );
  });
});

describe('importFile', () => {
  it('creates the account, writes the rows and the balance, and records the run', async () => {
    const db = openMemoryDb();
    const result = await importFile(db, file('signed-header.csv'), {
      now: () => Date.parse('2026-09-01T00:00:00.000Z'),
    });
    expect(result).toMatchObject({
      status: 'ok',
      inserted: 7,
      updated: 0,
      skipped: 0,
      balancesSeen: 1,
    });
    expect(result.run).toMatchObject({
      source: 'csv',
      file_name: 'signed-header.csv',
      account_id: 1,
      rows_inserted: 7,
      status: 'ok',
    });
    expect(listAccounts(db)).toHaveLength(1);
    expect(listAccounts(db)[0]).toMatchObject({
      source: 'manual',
      external_id: 'everyday',
      name: 'Everyday',
      type: 'transaction',
      currency: 'AUD',
    });
    expect(db.prepare('SELECT as_of, current_cents FROM account_balances').all()).toEqual([
      { as_of: '2026-08-31T23:59:59.999Z', current_cents: 415806 },
    ]);
    await importFile(db, file('signed-header.csv', { account: { id: 1 } }), {
      now: () => Date.parse('2026-10-01T00:00:00.000Z'),
    });
    expect(count(db, 'account_balances')).toBe(1);
    const rows = db
      .prepare<
        [],
        { posted_at: string; amount_cents: number; description_norm: string; raw_json: string }
      >('SELECT posted_at, amount_cents, description_norm, raw_json FROM transactions ORDER BY id')
      .all();
    expect(rows[0]).toMatchObject({
      posted_at: '2026-08-01T00:00:00.000Z',
      amount_cents: -8420,
      description_norm: 'WOOLWORTHS 3120 RICHMOND',
    });
    expect(JSON.parse(rows[0]!.raw_json)).toMatchObject({ line: 2, Balance: '1523.45' });
  });

  it('keeps identical rows within one file and dedupes across re-imports', async () => {
    const db = openMemoryDb();
    await importFile(db, file('signed-header.csv'));
    expect(count(db, 'transactions')).toBe(7);
    const coffees = db
      .prepare<[], { n: number }>(
        "SELECT count(*) n FROM transactions WHERE description_raw = 'COFFEE SUPREME MELBOURNE'",
      )
      .get()!.n;
    expect(coffees).toBe(2);

    // The same export plus one new row, into the existing account.
    const content = `${fixture('signed-header.csv')}2026-09-01,NEW ROW,-1.00,4157.06\n`;
    const second = await importFile(db, { fileName: 'later.csv', content, account: { id: 1 } });
    expect(second).toMatchObject({ inserted: 1, updated: 0, unchanged: 7, skipped: 0 });
    expect(count(db, 'transactions')).toBe(8);
    expect(count(db, 'accounts')).toBe(1);
  });

  it('hashes the account source, external id, day, amount, description and ordinal', () => {
    const a = csvExternalId('manual', 'everyday', '2026-08-01', -550, 'COFFEE', 0);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(csvExternalId('manual', 'everyday', '2026-08-01', -550, 'COFFEE', 1)).not.toBe(a);
    expect(csvExternalId('manual', 'savings', '2026-08-01', -550, 'COFFEE', 0)).not.toBe(a);
    expect(csvExternalId('ofx', 'everyday', '2026-08-01', -550, 'COFFEE', 0)).not.toBe(a);
    expect(csvExternalId('manual', 'everyday', '2026-08-01', -550, 'COFFEE', 0)).toBe(a);
  });

  it('keeps CSV rows in separate accounts when account external ids overlap', async () => {
    const db = openMemoryDb();
    const manual = createAccount(db, { name: 'Everyday', type: 'transaction', currency: 'AUD' });
    const ofx = upsertAccount(db, {
      source: 'ofx',
      externalId: 'everyday',
      name: 'Other bank',
      type: 'transaction',
      currency: 'AUD',
      raw: {},
    });
    const content = fixture('signed-header.csv');
    const first = { fileName: 'first.csv', content, account: { id: manual.id } };
    const second = { fileName: 'second.csv', content, account: { id: ofx } };
    expect((await importFile(db, first)).inserted).toBe(7);
    expect(previewImport(db, second).existing_count).toBe(0);
    expect(await importFile(db, second)).toMatchObject({ inserted: 7, updated: 0 });
    expect(await importFile(db, first)).toMatchObject({ inserted: 0, updated: 0, unchanged: 7 });
    expect(await importFile(db, second)).toMatchObject({ inserted: 0, updated: 0, unchanged: 7 });
    expect(
      db
        .prepare(
          'SELECT account_id, count(*) AS n FROM transactions GROUP BY account_id ORDER BY account_id',
        )
        .all(),
    ).toEqual([
      { account_id: manual.id, n: 7 },
      { account_id: ofx, n: 7 },
    ]);
  });

  it('recognises CSV rows imported under the original hash without duplicating them', async () => {
    const db = openMemoryDb();
    const account = createAccount(db, { name: 'Everyday', type: 'transaction', currency: 'AUD' });
    const legacyId = createHash('sha256')
      .update(['everyday', '2026-08-01', '-8420', 'WOOLWORTHS 3120 RICHMOND', '0'].join('|'))
      .digest('hex');
    upsertTransactions(db, [
      {
        source: 'csv',
        externalId: legacyId,
        accountExternalId: account.external_id,
        accountId: account.id,
        postedAt: '2026-08-01T00:00:00.000Z',
        amountCents: -8420,
        currency: 'AUD',
        descriptionRaw: 'WOOLWORTHS 3120 RICHMOND',
        descriptionNorm: 'WOOLWORTHS 3120 RICHMOND',
        status: 'posted',
        raw: {},
      },
    ]);
    const input = {
      fileName: 'again.csv',
      content: fixture('signed-header.csv'),
      account: { id: account.id },
    };
    expect(previewImport(db, input).existing_count).toBe(1);
    expect(await importFile(db, input)).toMatchObject({ inserted: 6, updated: 0, unchanged: 1 });
    expect(count(db, 'transactions')).toBe(7);
  });

  it('restores a row displaced by an earlier cross-source CSV collision on re-import', async () => {
    const db = openMemoryDb();
    const manual = createAccount(db, { name: 'Everyday', type: 'transaction', currency: 'AUD' });
    const ofx = upsertAccount(db, {
      source: 'ofx',
      externalId: manual.external_id,
      name: 'Other bank',
      type: 'transaction',
      currency: 'AUD',
      raw: {},
    });
    const legacyId = createHash('sha256')
      .update(['everyday', '2026-08-01', '-8420', 'WOOLWORTHS 3120 RICHMOND', '0'].join('|'))
      .digest('hex');
    // This is the state after the old upsert moved the row from manual to OFX.
    upsertTransactions(db, [
      {
        source: 'csv',
        externalId: legacyId,
        accountExternalId: manual.external_id,
        accountId: ofx,
        postedAt: '2026-08-01T00:00:00.000Z',
        amountCents: -8420,
        currency: 'AUD',
        descriptionRaw: 'WOOLWORTHS 3120 RICHMOND',
        descriptionNorm: 'WOOLWORTHS 3120 RICHMOND',
        status: 'posted',
        raw: {},
      },
    ]);
    const content = fixture('signed-header.csv');
    expect(
      await importFile(db, { fileName: 'manual.csv', content, account: { id: manual.id } }),
    ).toMatchObject({ inserted: 7, updated: 0 });
    expect(
      await importFile(db, { fileName: 'ofx.csv', content, account: { id: ofx } }),
    ).toMatchObject({ inserted: 6, updated: 0, unchanged: 1 });
    expect(
      db
        .prepare(
          'SELECT account_id, count(*) AS n FROM transactions GROUP BY account_id ORDER BY account_id',
        )
        .all(),
    ).toEqual([
      { account_id: manual.id, n: 7 },
      { account_id: ofx, n: 7 },
    ]);
  });

  it('counts unmappable rows as skipped and still succeeds', async () => {
    const db = openMemoryDb();
    const content = `${fixture('signed-header.csv')}bad,ROW,x,1\n`;
    const result = await importFile(db, { fileName: 'x.csv', content, account: NEW_ACCOUNT });
    expect(result).toMatchObject({ status: 'ok', inserted: 7, skipped: 1 });
    expect(getImportRun(db, result.runId)?.rows_skipped).toBe(1);
  });

  it('imports an OFX file into the account it names and keeps the balance time', async () => {
    const db = openMemoryDb();
    const result = await importFile(db, file('sample-1x.ofx'));
    expect(result).toMatchObject({ status: 'ok', inserted: 3, balancesSeen: 1 });
    const account = listAccounts(db)[0]!;
    expect(account).toMatchObject({
      source: 'ofx',
      external_id: '062000:12345678',
      type: 'transaction',
      institution: 'Example Bank',
    });
    expect(
      db.prepare('SELECT as_of, current_cents, available_cents FROM account_balances').all(),
    ).toEqual([
      { as_of: '2026-08-31T23:59:59.000Z', current_cents: 418946, available_cents: 410000 },
    ]);
    const again = await importFile(db, file('sample-1x.ofx'));
    expect(again).toMatchObject({ inserted: 0, updated: 0, unchanged: 3, duplicates: 0 });
    expect(count(db, 'account_balances')).toBe(1);
  });

  it('lets an OFX file name its account once and keeps that name afterwards', async () => {
    const db = openMemoryDb();
    await importFile(db, file('sample-1x.ofx', { accountName: 'Main' }));
    expect(listAccounts(db)[0]!.name).toBe('Main');
    await importFile(db, file('sample-1x.ofx'));
    expect(listAccounts(db)[0]!.name).toBe('Main');
  });

  it('can import an OFX file into a chosen account and a CSV into an OFX-created one', async () => {
    const db = openMemoryDb();
    const everyday = createAccount(db, { name: 'Everyday', type: 'transaction', currency: 'AUD' });
    await importFile(db, file('sample-1x.ofx', { account: { id: everyday.id } }));
    expect(count(db, 'accounts')).toBe(1);
    await importFile(db, file('signed-header.csv', { account: { id: everyday.id } }));
    expect(count(db, 'transactions')).toBe(10);
    expect(db.prepare('SELECT DISTINCT account_id FROM transactions').all()).toEqual([
      { account_id: everyday.id },
    ]);
  });

  it('keeps a pending row separate and matches a transfer after both descriptions are hinted', async () => {
    const db = openMemoryDb();
    const everyday =
      'Date,Description,Amount,Status\n2026-08-04,TRANSFER TO SAVINGS,-500.00,Posted\n2026-08-05,CARD PURCHASE,-3.00,Pending\n';
    const savings = 'Date,Description,Amount\n2026-08-05,TRANSFER FROM EVERYDAY,500.00\n';
    await importFile(db, { fileName: 'e.csv', content: everyday, account: NEW_ACCOUNT });
    await importFile(db, {
      fileName: 's.csv',
      content: savings,
      account: { create: { name: 'Savings', type: 'savings', currency: 'AUD' } },
    });
    const rows = db
      .prepare<[], { status: string; is_internal_transfer: number }>(
        'SELECT status, is_internal_transfer FROM transactions ORDER BY id',
      )
      .all();
    expect(rows).toEqual([
      { status: 'posted', is_internal_transfer: 0 },
      { status: 'pending', is_internal_transfer: 0 },
      { status: 'posted', is_internal_transfer: 0 },
    ]);
    upsertDescriptionCategories(db, [
      { descriptionNorm: 'TRANSFER TO SAVINGS', subcategory: 'savings', transferHint: true },
      { descriptionNorm: 'TRANSFER FROM EVERYDAY', subcategory: 'savings', transferHint: true },
    ]);
    expect(matchInternalTransfers(db).pairsCreated).toBe(1);
    expect(db.prepare('SELECT is_internal_transfer FROM transactions ORDER BY id').all()).toEqual([
      { is_internal_transfer: 1 },
      { is_internal_transfer: 0 },
      { is_internal_transfer: 1 },
    ]);
  });
});

describe('accounts', () => {
  it('slugs names and avoids collisions', () => {
    const db = openMemoryDb();
    expect(slugForAccount(db, 'manual', 'My Everyday Account!')).toBe('my-everyday-account');
    createAccount(db, { name: 'Everyday', type: 'transaction', currency: 'AUD' });
    expect(slugForAccount(db, 'manual', 'everyday')).toBe('everyday-2');
    expect(findAccountByName(db, 'EVERYDAY')?.id).toBe(1);
    expect(findAccountByName(db, 'nope')).toBeUndefined();
  });
});
