import { afterEach, beforeEach, expect, it } from 'vitest';
import { openMemoryDb, type Db } from '../../src/db/client.js';
import { upsertAccount, upsertTransactions } from '../../src/db/repo.js';
import { executeTool, type search } from '../../src/tools/registry.js';
let db: Db;
beforeEach(() => {
  db = openMemoryDb();
  for (const externalId of ['a', 'b'])
    upsertAccount(db, { source: 'test', externalId, name: externalId, currency: 'AUD', raw: {} });
});
afterEach(() => db.close());
function seed(n: number) {
  upsertTransactions(
    db,
    Array.from({ length: n }, (_, i) => ({
      source: 'test',
      externalId: String(i),
      accountExternalId: i % 2 ? 'b' : 'a',
      postedAt: '2026-01-' + String(1 + (i % 10)).padStart(2, '0') + 'T00:00:00Z',
      amountCents: ((i % 7) - 3) * 100,
      currency: i % 3 ? 'AUD' : 'USD',
      descriptionRaw: 'shop',
      descriptionNorm: i % 2 ? 'shop' : 'shop 10%_\\',
      status: 'posted',
      raw: {},
    })),
  );
}
function page(args: Record<string, unknown> = {}) {
  const result = executeTool(db, 'search_transactions', args);
  expect(result.isError, result.content).toBe(false);
  return JSON.parse(result.content) as ReturnType<typeof search>;
}
it.each(['newest', 'oldest', 'largest', 'smallest'])(
  'traverses over 100 rows exactly once with tied keys: %s',
  (sort) => {
    seed(237);
    const first = page({ sort, limit: 17 });
    let current = first;
    const ids: number[] = [];
    do {
      expect(current.total_matched_count).toBe(237);
      expect(current.matched_rows_totals).toEqual(first.matched_rows_totals);
      for (const total of current.returned_rows_totals) {
        const amounts = current.rows
          .filter((r) => r.currency === total.currency)
          .map((r) => r.amount.cents);
        expect(total.net_total.cents).toBe(amounts.reduce((sum, v) => sum + v, 0));
        expect(total.debit_total.cents).toBe(amounts.reduce((sum, v) => sum + Math.max(0, -v), 0));
        expect(total.credit_total.cents).toBe(amounts.reduce((sum, v) => sum + Math.max(0, v), 0));
      }
      ids.push(...current.rows.map((r) => r.id));
      if (!current.has_more) break;
      current = page({ sort, limit: 31, cursor: current.next_cursor });
    } while (ids.length < 300);
    expect(ids).toHaveLength(237);
    expect(new Set(ids).size).toBe(237);
    expect(current.next_cursor).toBeNull();
    const column = sort === 'largest' || sort === 'smallest' ? 'abs(amount_cents)' : 'posted_at';
    const order = sort === 'oldest' || sort === 'smallest' ? 'ASC' : 'DESC';
    expect(ids).toEqual(
      db
        .prepare<[], { id: number }>(
          `SELECT id FROM transactions ORDER BY ${column} ${order}, id ${order}`,
        )
        .all()
        .map((r) => r.id),
    );
  },
);
it('combines literal text, category, account, date, currency, direction and inclusive magnitude bounds', () => {
  seed(80);
  db.prepare("UPDATE transactions SET subcategory = 'groceries'").run();
  db.prepare('UPDATE transactions SET is_internal_transfer = 1 WHERE id = 5').run();
  const args = {
    query: '10%_\\',
    category: 'food_drink',
    subcategory: 'groceries',
    account_id: 1,
    from: '2026-01-01',
    to: '2026-01-10',
    direction: 'credit',
    min_amount_cents: 100,
    max_amount_cents: 200,
    currency: 'AUD',
    sort: 'smallest',
    limit: 100,
  };
  const result = page(args);
  expect(result.rows.length).toBeGreaterThan(0);
  expect(result.excluded_transfer_count).toBe(1);
  expect(
    result.rows.every(
      (r) =>
        r.account_id === 1 &&
        r.currency === 'AUD' &&
        r.description === 'shop 10%_\\' &&
        r.amount.cents >= 100 &&
        r.amount.cents <= 200,
    ),
  ).toBe(true);
  expect(result.returned_rows_totals).toEqual(result.matched_rows_totals);
  expect(page({ ...args, include_transfers: true }).row_count).toBe(result.row_count + 1);
  expect(page({ ...args, category: 'transport' }).matched_rows_totals).toEqual([]);
});
it('defines zeros, debit and credit direction and validates bounds and cursors', () => {
  seed(30);
  expect(
    page({ min_amount_cents: 0, max_amount_cents: 0 }).rows.every((r) => r.amount.cents === 0),
  ).toBe(true);
  for (const direction of ['debit', 'credit']) {
    expect(page({ direction, max_amount_cents: 0 })).toMatchObject({
      row_count: 0,
      matched_rows_totals: [],
    });
    expect(
      page({ direction }).rows.every((r) =>
        direction === 'debit' ? r.amount.cents < 0 : r.amount.cents > 0,
      ),
    ).toBe(true);
  }
  const cursor = page({ limit: 1 }).next_cursor!;
  for (const args of [
    { min_amount_cents: -1 },
    { min_amount_cents: 1.2 },
    { min_amount_cents: 10, max_amount_cents: 5 },
    { cursor: 'bad!' },
    { cursor: Buffer.from('{}').toString('base64url') },
    { cursor: cursor + '=' },
    { cursor, sort: 'oldest' },
    { cursor, query: 'shop' },
    { cursor, direction: 'credit' },
    { cursor, from: '2026-01-01' },
    { cursor, include_transfers: true },
  ])
    expect(executeTool(db, 'search_transactions', args).isError).toBe(true);
});
it('uses limited SQL pages and aggregate SQL without loading all matches', () => {
  seed(150);
  const statements: string[] = [];
  const original = db.prepare.bind(db);
  db.prepare = (sql: string) => {
    statements.push(sql);
    return original(sql);
  };
  expect(page().row_count).toBe(20);
  const selects = statements.filter((sql) => sql.includes('SELECT * FROM transactions'));
  expect(selects).toHaveLength(1);
  expect(selects[0]).toContain('LIMIT ?');
  expect(statements.some((sql) => sql.includes('GROUP BY currency'))).toBe(true);
});
it('observes inserts and deletes after a cursor while fixing resolved date bounds', () => {
  seed(20);
  const first = page({ sort: 'oldest', limit: 1 });
  const lastId = first.rows[0]!.id;
  db.prepare("UPDATE transactions SET posted_at = '2026-02-01T00:00:00Z' WHERE id = 20").run();
  // New row lies after the cursor and within the original resolved dates.
  upsertTransactions(db, [
    {
      source: 'test',
      externalId: 'new',
      accountExternalId: 'a',
      postedAt: '2026-01-01T00:00:00Z',
      amountCents: 500,
      currency: 'AUD',
      descriptionRaw: 'new',
      descriptionNorm: 'new',
      status: 'posted',
      raw: {},
    },
  ]);
  const next = page({ sort: 'oldest', limit: 100, cursor: first.next_cursor });
  expect(next.date_range).toEqual(first.date_range);
  expect(next.data_coverage.to).toBe('2026-02-01');
  expect(next.rows.some((r) => r.description === 'new')).toBe(true);
  expect(next.rows.some((r) => r.id === lastId)).toBe(false);
  expect(next.matched_rows_totals).not.toEqual(first.matched_rows_totals);
  db.prepare('DELETE FROM transactions WHERE id != ?').run(lastId);
  expect(page({ sort: 'oldest', cursor: first.next_cursor })).toMatchObject({
    row_count: 0,
    total_matched_count: 1,
    has_more: false,
    next_cursor: null,
    returned_rows_totals: [],
  });
});
it('allows repeats when a sync moves an already-seen row beyond the cursor, without snapshot claims', () => {
  seed(20);
  const first = page({ sort: 'oldest', limit: 1 });
  db.prepare("UPDATE transactions SET posted_at = '2026-01-09T00:00:00Z' WHERE id = ?").run(
    first.rows[0]!.id,
  );
  const next = page({ sort: 'oldest', limit: 100, cursor: first.next_cursor });
  expect(next.rows.some((r) => r.id === first.rows[0]!.id)).toBe(true);
  expect(next.pagination_consistency).toBe('current_stored_data_with_fixed_date_bounds');
});
