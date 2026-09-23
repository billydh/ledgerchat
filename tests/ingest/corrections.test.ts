import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMemoryDb, type Db } from '../../src/db/client.js';
import {
  applyCategoriesToTransactions,
  resolveEffectiveCategories,
  upsertAccount,
  upsertDescriptionCategories,
  upsertTransactions,
  type TransactionRow,
} from '../../src/db/repo.js';
import {
  CorrectionError,
  getTransactionLabel,
  removeCorrection,
  setCorrection,
} from '../../src/ingest/corrections.js';
import { matchInternalTransfers } from '../../src/ingest/transfers.js';
import { executeTool } from '../../src/tools/registry.js';

let db: Db;
beforeEach(() => {
  db = openMemoryDb();
  upsertAccount(db, {
    source: 'csv',
    externalId: 'a',
    name: 'Everyday',
    currency: 'AUD',
    raw: {},
  });
  upsertAccount(db, {
    source: 'csv',
    externalId: 'b',
    name: 'Savings',
    currency: 'AUD',
    raw: {},
  });
  upsertAccount(db, {
    source: 'other',
    externalId: 'c',
    name: 'Other bank',
    currency: 'AUD',
    raw: {},
  });
  upsertTransactions(db, [
    row('1', 'a', 'WOOLWORTHS', -1000),
    row('2', 'a', 'WOOLWORTHS', -2000),
    row('3', 'b', 'WOOLWORTHS', -3000),
    row('4', 'a', 'NETFLIX', -1500),
  ]);
  upsertTransactions(db, [row('5', 'c', 'WOOLWORTHS', -4000, 'other')]);
  upsertDescriptionCategories(db, [
    { descriptionNorm: 'WOOLWORTHS', subcategory: 'groceries', isSubscription: false },
    { descriptionNorm: 'NETFLIX', subcategory: 'entertainment', isSubscription: true },
  ]);
  applyCategoriesToTransactions(db);
});
afterEach(() => db.close());

function row(id: string, account: string, description: string, cents: number, source = 'csv') {
  return {
    source,
    externalId: id,
    accountExternalId: account,
    postedAt: `2026-08-${id.padStart(2, '0')}T00:00:00.000Z`,
    amountCents: cents,
    currency: 'AUD',
    descriptionRaw: description,
    descriptionNorm: description,
    status: 'posted' as const,
    raw: {},
  };
}
const get = (externalId: string) =>
  db
    .prepare<[string], TransactionRow>('SELECT * FROM transactions WHERE external_id = ?')
    .get(externalId)!;
const labels = () =>
  db
    .prepare<
      [],
      { external_id: string; subcategory: string | null; category_origin: string | null }
    >('SELECT external_id, subcategory, category_origin FROM transactions ORDER BY id')
    .all()
    .map((r) => `${r.external_id}:${r.subcategory ?? '-'}:${r.category_origin ?? '-'}`);

describe('precedence', () => {
  it('starts from the machine label', () => {
    expect(labels()).toEqual([
      '1:groceries:llm',
      '2:groceries:llm',
      '3:groceries:llm',
      '4:entertainment:llm',
      '5:groceries:llm',
    ]);
  });

  it('override beats rule beats machine, and removal restores the next applicable label', () => {
    setCorrection(db, get('1').id, 'description', 'dining');
    expect(labels()).toEqual([
      '1:dining:description_rule',
      '2:dining:description_rule',
      '3:dining:description_rule',
      '4:entertainment:llm',
      '5:groceries:llm',
    ]);
    setCorrection(db, get('2').id, 'transaction', 'gifts');
    expect(labels()[1]).toBe('2:gifts:transaction_override');
    expect(get('2')).toMatchObject({ category_source: 'manual', machine_subcategory: 'groceries' });

    expect(removeCorrection(db, get('2').id, 'transaction')).toMatchObject({
      removed: true,
      label: { subcategory: 'dining', category_origin: 'description_rule' },
    });
    expect(removeCorrection(db, get('2').id, 'transaction').removed).toBe(false);
    expect(removeCorrection(db, get('2').id, 'description')).toMatchObject({
      removed: true,
      label: { subcategory: 'groceries', category_origin: 'llm', origin_label: 'Machine label' },
    });
    expect(labels()).toEqual([
      '1:groceries:llm',
      '2:groceries:llm',
      '3:groceries:llm',
      '4:entertainment:llm',
      '5:groceries:llm',
    ]);
  });

  it('scopes a rule to the source and exact normalised description across that source', () => {
    const label = setCorrection(db, get('3').id, 'description', 'dining');
    expect(label.rule_scope).toEqual({
      source: 'csv',
      description: 'WOOLWORTHS',
      match_count: 3,
    });
    // Both csv accounts, but not the other source's identical description.
    expect(get('1').subcategory).toBe('dining');
    expect(get('3').subcategory).toBe('dining');
    expect(get('5').subcategory).toBe('groceries');
    expect(getTransactionLabel(db, get('5').id).rule).toBeNull();
  });

  it('reveals the machine label under a correction and reports where it came from', () => {
    setCorrection(db, get('4').id, 'transaction', 'shopping');
    expect(getTransactionLabel(db, get('4').id)).toMatchObject({
      subcategory: 'shopping',
      category: 'lifestyle',
      machine_subcategory: 'entertainment',
      category_origin: 'transaction_override',
      origin_label: 'Corrected for this transaction',
      override: { subcategory: 'shopping' },
      rule: null,
    });
  });

  it('labels a row nothing has categorised as unlabelled', () => {
    upsertTransactions(db, [row('6', 'a', 'MYSTERY', -10)]);
    expect(getTransactionLabel(db, get('6').id)).toMatchObject({
      subcategory: null,
      category: 'uncategorised',
      category_origin: null,
      origin_label: 'Unlabelled',
      machine_subcategory: null,
    });
    setCorrection(db, get('6').id, 'transaction', 'other');
    expect(get('6')).toMatchObject({ subcategory: 'other', category_source: 'manual' });
  });
});

describe('durability', () => {
  it('survives a re-sync upsert, recategorisation and reapplying the cache', () => {
    setCorrection(db, get('1').id, 'transaction', 'gifts');
    setCorrection(db, get('4').id, 'description', 'lifestyle_other');
    upsertTransactions(db, [row('1', 'a', 'WOOLWORTHS', -999), row('4', 'a', 'NETFLIX', -1501)]);
    db.prepare('DELETE FROM description_categories').run();
    upsertDescriptionCategories(db, [
      { descriptionNorm: 'WOOLWORTHS', subcategory: 'food_drink_other' },
      { descriptionNorm: 'NETFLIX', subcategory: 'shopping', isSubscription: true },
    ]);
    applyCategoriesToTransactions(db);
    expect(get('1')).toMatchObject({
      amount_cents: -999,
      subcategory: 'gifts',
      machine_subcategory: 'food_drink_other',
      category_origin: 'transaction_override',
    });
    expect(get('2').subcategory).toBe('food_drink_other');
    expect(get('4')).toMatchObject({
      subcategory: 'lifestyle_other',
      machine_subcategory: 'shopping',
      category_origin: 'description_rule',
    });
  });

  it('applies a rule to rows that arrive later', () => {
    setCorrection(db, get('1').id, 'description', 'dining');
    upsertTransactions(db, [
      row('7', 'b', 'WOOLWORTHS', -70),
      row('8', 'c', 'WOOLWORTHS', -80, 'other'),
    ]);
    // The pipeline re-resolves after every upsert through applyCategoriesToTransactions.
    applyCategoriesToTransactions(db);
    expect(get('7')).toMatchObject({ subcategory: 'dining', category_origin: 'description_rule' });
    expect(get('8').subcategory).toBe('groceries');
    expect(getTransactionLabel(db, get('1').id).rule_scope.match_count).toBe(4);
  });

  it('leaves the subscription hint and transfer flags alone', () => {
    upsertTransactions(db, [
      row('9', 'a', 'TO SAVINGS', -5000),
      row('10', 'b', 'FROM EVERYDAY', 5000),
    ]);
    upsertDescriptionCategories(db, [
      { descriptionNorm: 'TO SAVINGS', subcategory: 'savings', transferHint: true },
      { descriptionNorm: 'FROM EVERYDAY', subcategory: 'savings', transferHint: true },
    ]);
    matchInternalTransfers(db);
    expect(get('9').is_internal_transfer).toBe(1);
    setCorrection(db, get('9').id, 'transaction', 'savings');
    setCorrection(db, get('4').id, 'description', 'shopping');
    setCorrection(db, get('1').id, 'transaction', 'entertainment');
    expect(get('9')).toMatchObject({ is_internal_transfer: 1, transfer_source: 'pair' });
    expect(get('4').is_subscription).toBe(1);
    expect(get('1').is_subscription).toBe(0);
    removeCorrection(db, get('9').id, 'transaction');
    expect(get('9').is_internal_transfer).toBe(1);
  });

  it('cascades an override when its transaction is deleted', () => {
    setCorrection(db, get('1').id, 'transaction', 'gifts');
    db.prepare('DELETE FROM transactions WHERE external_id = ?').run('1');
    expect(db.prepare('SELECT count(*) n FROM transaction_category_overrides').get()).toEqual({
      n: 0,
    });
  });
});

describe('validation', () => {
  it('rejects labels outside the taxonomy, including parent names', () => {
    for (const bad of ['food_drink', 'GROCERIES', '', 42, null, 'uncategorised'])
      expect(() => setCorrection(db, get('1').id, 'transaction', bad)).toThrow(CorrectionError);
    expect(() => setCorrection(db, get('1').id, 'description', 'housing')).toThrow(
      /Unknown subcategory/,
    );
    expect(labels()[0]).toBe('1:groceries:llm');
  });

  it('rejects a missing transaction with a 404 and writes nothing', () => {
    for (const run of [
      () => setCorrection(db, 999, 'transaction', 'gifts'),
      () => setCorrection(db, 999, 'description', 'gifts'),
      () => removeCorrection(db, 999, 'transaction'),
      () => getTransactionLabel(db, 999),
    ]) {
      try {
        run();
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(CorrectionError);
        expect((error as CorrectionError).status).toBe(404);
      }
    }
    expect(db.prepare('SELECT count(*) n FROM description_category_rules').get()).toEqual({ n: 0 });
  });
});

describe('consumers', () => {
  it('search and category summaries agree after adding and removing a correction', () => {
    const call = (name: string, args: unknown) => {
      const result = executeTool(db, name, args, { now: new Date('2026-09-01') });
      expect(result.isError).toBe(false);
      return JSON.parse(result.content) as {
        rows?: { id: number; subcategory: string; category: string }[];
        total_matched_count?: number;
        groups?: { group: string; total: { cents: number } }[];
      };
    };
    const summaryArgs = {
      from: '2026-08-01',
      to: '2026-08-31',
      group_by: 'subcategory',
    };
    expect(call('get_spending_summary', summaryArgs).groups).toEqual([
      {
        group: 'entertainment',
        currency: 'AUD',
        row_count: 1,
        total: { cents: 1500, decimal: '15.00' },
      },
      {
        group: 'groceries',
        currency: 'AUD',
        row_count: 4,
        total: { cents: 10000, decimal: '100.00' },
      },
    ]);

    setCorrection(db, get('1').id, 'description', 'dining');
    setCorrection(db, get('2').id, 'transaction', 'gifts');
    const search = call('search_transactions', { subcategory: 'dining' });
    expect(search.total_matched_count).toBe(2);
    expect(search.rows!.map((r) => r.category)).toEqual(['food_drink', 'food_drink']);
    expect(call('search_transactions', { category: 'giving' }).total_matched_count).toBe(1);
    expect(call('get_spending_summary', summaryArgs).groups).toMatchObject([
      { group: 'dining', row_count: 2, total: { cents: 4000 } },
      { group: 'entertainment', row_count: 1 },
      { group: 'gifts', row_count: 1, total: { cents: 2000 } },
      { group: 'groceries', row_count: 1, total: { cents: 4000 } },
    ]);

    removeCorrection(db, get('1').id, 'description');
    removeCorrection(db, get('2').id, 'transaction');
    expect(call('search_transactions', { subcategory: 'dining' }).total_matched_count).toBe(0);
    expect(call('get_spending_summary', summaryArgs).groups).toMatchObject([
      { group: 'entertainment', row_count: 1 },
      { group: 'groceries', row_count: 4, total: { cents: 10000 } },
    ]);
  });

  it('resolving everything is idempotent', () => {
    setCorrection(db, get('1').id, 'description', 'dining');
    expect(resolveEffectiveCategories(db)).toBe(0);
    db.prepare("UPDATE transactions SET subcategory = 'other' WHERE external_id = '3'").run();
    expect(resolveEffectiveCategories(db)).toBe(1);
    expect(get('3').subcategory).toBe('dining');
  });
});
