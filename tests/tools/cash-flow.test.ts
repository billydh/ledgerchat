import { afterEach, beforeEach, expect, it } from 'vitest';
import { openMemoryDb, type Db } from '../../src/db/client.js';
import { upsertAccount, upsertTransactions } from '../../src/db/repo.js';
import { executeTool, type cashFlow } from '../../src/tools/registry.js';
let db: Db;
beforeEach(() => {
  db = openMemoryDb();
  for (const externalId of ['a', 'b'])
    upsertAccount(db, { source: 'test', externalId, name: externalId, currency: 'AUD', raw: {} });
});
afterEach(() => db.close());
function row(id: string, amount: number, date = '2026-01-15', currency = 'AUD', account = 'a') {
  upsertTransactions(db, [
    {
      source: 'test',
      externalId: id,
      accountExternalId: account,
      postedAt: date + 'T00:00:00Z',
      amountCents: amount,
      currency,
      descriptionRaw: id,
      descriptionNorm: id,
      status: 'posted',
      raw: {},
    },
  ]);
}
function flow(args: Record<string, unknown> = {}) {
  // Explicit dates replace the preset rather than joining it.
  const input = 'from' in args ? args : { period: 'last_month', ...args };
  const result = executeTool(db, 'get_cash_flow', input, { now: new Date('2026-02-15') });
  expect(result.isError).toBe(false);
  return JSON.parse(result.content) as ReturnType<typeof cashFlow>;
}
it('counts credits including refunds, positive debits, signed net and zeros by currency', () => {
  row('salary', 90000);
  row('refund', 10000);
  row('expense', -65000);
  row('zero', 0);
  row('usd', -400, '2026-01-31', 'USD');
  db.prepare(
    "UPDATE transactions SET subcategory = 'groceries' WHERE description_norm = 'refund'",
  ).run();
  const result = flow();
  expect(result.row_count).toBe(5);
  expect(result.totals).toMatchObject([
    {
      currency: 'AUD',
      incoming_credits: { cents: 100000 },
      outgoing_debits: { cents: 65000 },
      net_flow: { cents: 35000 },
      credit_count: 2,
      debit_count: 1,
      zero_count: 1,
    },
    { currency: 'USD', incoming_credits: { cents: 0 }, net_flow: { cents: -400 } },
  ]);
});
it('excludes both own-account transfer legs, even when only one account is selected', () => {
  row('out', -50000);
  row('in', 50000, '2026-01-15', 'AUD', 'b');
  db.prepare('UPDATE transactions SET is_internal_transfer = 1').run();
  expect(flow()).toMatchObject({ row_count: 0, totals: [], excluded_transfer_count: 2 });
  expect(flow({ account_id: 1 })).toMatchObject({ row_count: 0, excluded_transfer_count: 1 });
  const included = flow({ include_transfers: true, group_by: 'account' });
  expect(included).toMatchObject({
    row_count: 2,
    excluded_transfer_count: 0,
    totals: [{ net_flow: { cents: 0 } }],
  });
  expect(included.groups.map((g) => g.net_flow.cents)).toEqual([-50000, 50000]);
  expect(flow({ account_id: 2, include_transfers: true }).totals[0]!.net_flow.cents).toBe(50000);
});
it('resolves month boundaries, reconciles groups and reports observed coverage and empty ranges', () => {
  row('jan', -100, '2026-01-31');
  row('feb', 200, '2026-02-01');
  expect(flow().row_count).toBe(1);
  const result = flow({ from: '2026-01-01', to: '2026-02-28', group_by: 'month' });
  expect(result.groups.map((g) => [g.group, g.net_flow.cents])).toEqual([
    ['2026-01', -100],
    ['2026-02', 200],
  ]);
  expect(result.groups.reduce((sum, g) => sum + g.net_flow.cents, 0)).toBe(
    result.totals[0]!.net_flow.cents,
  );
  expect(result.coverage).toMatchObject({
    complete_history_verified: false,
    overlap: { from: '2026-01-31', to: '2026-02-01' },
    overlap_day_count: 2,
  });
  expect(flow({ from: '2025-01-01', to: '2025-01-31' })).toMatchObject({
    row_count: 0,
    totals: [],
    coverage: { overlap: null },
  });
  expect(flow({ account_id: 2 })).toMatchObject({
    totals: [],
    data_coverage: { from: null, to: null },
  });
  expect(executeTool(db, 'get_cash_flow', {}).isError).toBe(true);
});
