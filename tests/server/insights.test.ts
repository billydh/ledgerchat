import { afterEach, beforeEach, expect, it } from 'vitest';
import { openMemoryDb, type Db } from '../../src/db/client.js';
import { upsertAccount, upsertTransactions } from '../../src/db/repo.js';
import { createApp } from '../../src/server/app.js';
import { constantTenant } from '../../src/server/tenancy.js';
let db: Db;
beforeEach(() => (db = openMemoryDb()));
afterEach(() => db.close());
const app = () =>
  createApp({
    tenant: constantTenant(db),
    resolveBackend: () => Promise.reject(new Error('unused')),
    backendStatus: () => Promise.resolve([]),
  }).app;
const row = (externalId: string, postedAt: string, amountCents: number, description: string) => ({
  source: 'test',
  externalId,
  accountExternalId: 'a',
  postedAt,
  amountCents,
  currency: 'AUD',
  descriptionRaw: description,
  descriptionNorm: description,
  status: 'posted' as const,
  raw: {},
});
function seed() {
  upsertAccount(db, {
    source: 'test',
    externalId: 'a',
    name: 'Everyday',
    currency: 'AUD',
    raw: {},
  });
  upsertTransactions(db, [
    row('1', '2026-01-03', -1299, 'SPOTIFY'),
    row('2', '2026-02-03', -1299, 'SPOTIFY'),
    row('3', '2026-03-03', -1299, 'SPOTIFY'),
    row('4', '2026-03-15', -4500, 'WOOLWORTHS'),
  ]);
  // Labelled rows count as spending; unlabelled ones are "not yet classified".
  db.exec("UPDATE transactions SET subcategory = 'groceries'");
}
it('serves the Overview report for a window with validation', async () => {
  seed();
  db.exec(
    `INSERT INTO account_balances(account_id, as_of, current_cents, currency, raw_json)
     VALUES (1, '2026-03-01', 10000, 'AUD', '{}'), (1, '2026-03-31', 5500, 'AUD', '{}')`,
  );
  upsertTransactions(db, [row('8', '2026-03-20', 2000, 'UNKNOWN CREDIT')]);
  const report = (await (
    await app().request('/api/insights/report?from=2026-03-01&to=2026-03-31')
  ).json()) as {
    from: string;
    to: string;
    totals: {
      currency: string;
      consumption_cents: number;
      posted_outgoing_cents: number;
      posted_incoming_cents: number;
      categories: { category: string; consumption_cents: number }[];
    }[];
    unresolved_transaction_ids: number[];
    reconciliation: { status: string; unexplained_cents?: number }[];
    coverage: { transactions: number };
  };
  expect(report).toMatchObject({ from: '2026-03-01', to: '2026-03-31' });
  expect(report.totals[0]).toMatchObject({
    currency: 'AUD',
    consumption_cents: 5799,
    posted_outgoing_cents: 5799,
    posted_incoming_cents: 2000,
    categories: [
      { category: 'food_drink', consumption_cents: 5799 },
      { category: 'uncategorised', consumption_cents: 0 },
    ],
  });
  // An unlabelled credit is not income and not spending: it is listed for a look.
  expect(report.unresolved_transaction_ids).toHaveLength(1);
  // 10000 - 5799 + 2000 = 6201 expected against a stated 5500.
  expect(report.reconciliation[0]).toMatchObject({
    status: 'unexplained',
    unexplained_cents: -701,
  });
  expect(report.coverage.transactions).toBe(5);
  const scoped = (await (
    await app().request('/api/insights/report?from=2026-03-01&to=2026-03-31&account_id=2')
  ).json()) as { totals: unknown[] };
  expect(scoped.totals).toEqual([]);
  expect((await app().request('/api/insights/report?from=2026-03-31&to=2026-03-01')).status).toBe(
    400,
  );
  expect((await app().request('/api/insights/report?from=2026-03-01')).status).toBe(400);
  expect((await app().request('/api/insights/report?from=x&to=y')).status).toBe(400);
});
it('serves the monthly trend with validation', async () => {
  seed();
  const trend = (await (await app().request('/api/insights/trend?to=2026-03&months=2')).json()) as {
    months: { month: string; totals: { consumption_cents: number }[] }[];
  };
  expect(trend.months.map((m) => m.month)).toEqual(['2026-02', '2026-03']);
  expect(trend.months[1]!.totals[0]).toMatchObject({ consumption_cents: 5799 });
  expect((await app().request('/api/insights/trend?to=2026-3')).status).toBe(400);
  expect((await app().request('/api/insights/trend?to=2026-03&months=99')).status).toBe(400);
  expect((await app().request('/api/insights/trend')).status).toBe(400);
});
it('serves recurring charges sorted by mean amount and upcoming payments', async () => {
  seed();
  upsertTransactions(db, [
    row('5', '2026-01-10', -9900, 'GYM'),
    row('6', '2026-02-10', -9900, 'GYM'),
    row('7', '2026-03-10', -9900, 'GYM'),
  ]);
  db.exec("UPDATE transactions SET subcategory = 'groceries'");
  const recurring = (await (await app().request('/api/insights/recurring')).json()) as {
    charges: { description: string; cadence: string }[];
  };
  expect(recurring.charges.map((c) => c.description)).toEqual(['GYM', 'SPOTIFY']);
  expect(recurring.charges[0]!.cadence).toBe('monthly');
  const upcoming = (await (await app().request('/api/insights/upcoming?days=30')).json()) as {
    payments: unknown[];
    date_range: { from: string };
  };
  expect(Array.isArray(upcoming.payments)).toBe(true);
  expect(upcoming.date_range.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect((await app().request('/api/insights/upcoming?days=0')).status).toBe(400);
  expect((await app().request('/api/insights/upcoming?days=91')).status).toBe(400);
});
it('serves an empty trend for an empty database', async () => {
  const trend = (await (await app().request('/api/insights/trend?to=2026-03')).json()) as {
    months: { totals: unknown[] }[];
  };
  expect(trend.months).toHaveLength(6);
  expect(trend.months[0]!.totals).toEqual([]);
});
it('includes the latest statement balance per account in status', async () => {
  seed();
  db.exec(
    `INSERT INTO account_balances(account_id, as_of, current_cents, currency, raw_json)
     VALUES (1, '2026-03-01', 100, 'AUD', '{}'), (1, '2026-03-20', 250, 'AUD', '{}')`,
  );
  const status = (await (await app().request('/api/status')).json()) as {
    coverage: { accounts: { balance: unknown }[] };
  };
  expect(status.coverage.accounts[0]!.balance).toEqual({
    current_cents: 250,
    currency: 'AUD',
    as_of: '2026-03-20',
  });
});
it('serves fonts from the installed packages only', async () => {
  const ok = await app().request('/fonts/fraunces.woff2');
  expect(ok.status).toBe(200);
  expect(ok.headers.get('content-type')).toBe('font/woff2');
  expect((await app().request('/fonts/../package.json')).status).toBe(404);
  expect((await app().request('/fonts/other.woff2')).status).toBe(404);
});
