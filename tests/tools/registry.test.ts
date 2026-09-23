import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMemoryDb, type Db } from '../../src/db/client.js';
import { insertBalances, upsertAccount, upsertTransactions } from '../../src/db/repo.js';
import {
  type search,
  type summary,
  type recurring,
  type upcoming,
  executeTool,
  toolDefs,
} from '../../src/tools/registry.js';
import { nextMonth, resolvePeriod } from '../../src/tools/period.js';
import { overviewReport } from '../../src/insights/report.js';
let db: Db;
beforeEach(() => {
  db = openMemoryDb();
  upsertAccount(db, { source: 'test', externalId: 'a', name: 'Account', currency: 'AUD', raw: {} });
});
afterEach(() => db.close());
function seed(dates: string[], description = 'subscription', amount = -1000) {
  upsertTransactions(
    db,
    dates.map((date, i) => ({
      source: 'test',
      externalId: `${description}-${i}`,
      accountExternalId: 'a',
      postedAt: `${date}T12:00:00Z`,
      amountCents: amount,
      currency: 'AUD',
      descriptionRaw: description,
      descriptionNorm: description,
      status: 'posted',
      raw: {},
    })),
  );
}
function label(description: string, subcategory: string | null, isSubscription?: boolean) {
  db.prepare<[string | null, number | null, string]>(
    "UPDATE transactions SET subcategory = ?, is_subscription = ?, category_source = 'llm' WHERE description_norm = ?",
  ).run(subcategory, isSubscription === undefined ? null : isSubscription ? 1 : 0, description);
}
function call(name: string, args: unknown, now = '2026-02-01') {
  const result = executeTool(db, name, args, { now: new Date(now) });
  expect(result.isError).toBe(false);
  return JSON.parse(result.content) as ReturnType<typeof search> &
    ReturnType<typeof summary> &
    ReturnType<typeof recurring> &
    ReturnType<typeof upcoming>;
}
describe('registry', () => {
  it('exports closed schemas and useful nonthrowing errors', () => {
    expect(toolDefs()).toHaveLength(6);
    for (const def of toolDefs()) expect(def.jsonSchema.additionalProperties).toBe(false);
    expect(executeTool(db, 'missing', {}).content).toContain('search_transactions');
    expect(executeTool(db, 'search_transactions', { limit: 101 }).isError).toBe(true);
    expect(executeTool(db, 'search_transactions', { from: '2026-02-30' }).isError).toBe(true);
    expect(
      executeTool(db, 'get_spending_summary', {
        from: '2026-02-02',
        to: '2026-01-01',
        group_by: 'month',
      }).isError,
    ).toBe(true);
  });
  it('lists account metadata including accounts without transactions', () => {
    seed(['2026-01-01']);
    upsertAccount(db, {
      source: 'test',
      externalId: 'b',
      name: 'Savings',
      type: 'savings',
      institution: 'Test Bank',
      currency: 'USD',
      raw: { private: 'not for the model' },
    });
    const result = executeTool(db, 'list_accounts', {});
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual({
      account_count: 2,
      accounts: [
        {
          id: 1,
          name: 'Account',
          type: null,
          institution: null,
          currency: 'AUD',
          balance: null,
        },
        {
          id: 2,
          name: 'Savings',
          type: 'savings',
          institution: 'Test Bank',
          currency: 'USD',
          balance: null,
        },
      ],
    });
    expect(executeTool(db, 'list_accounts', { account_id: 1 }).isError).toBe(true);
  });
  it('returns the latest balance per account, null when none, and the stored currency', () => {
    upsertAccount(db, { source: 'test', externalId: 'b', name: 'Loan', currency: 'AUD', raw: {} });
    upsertAccount(db, { source: 'test', externalId: 'c', name: 'Empty', currency: 'AUD', raw: {} });
    insertBalances(db, [
      {
        accountId: 1,
        asOf: '2026-09-10T05:00:00.000Z',
        currentCents: 100,
        currency: 'AUD',
        raw: {},
      },
      {
        accountId: 1,
        asOf: '2026-09-11T05:00:00.000Z',
        currentCents: 74777,
        availableCents: 80295,
        currency: 'AUD',
        raw: {},
      },
      {
        accountId: 2,
        asOf: '2026-09-11T05:00:00.000Z',
        currentCents: -59152791,
        currency: 'USD',
        raw: {},
      },
    ]);
    const { accounts } = JSON.parse(executeTool(db, 'list_accounts', {}).content) as {
      accounts: { balance: unknown }[];
    };
    expect(accounts.map((a) => a.balance)).toEqual([
      {
        current: { cents: 74777, decimal: '747.77' },
        available: { cents: 80295, decimal: '802.95' },
        currency: 'AUD',
        as_of: '2026-09-11T05:00:00.000Z',
      },
      {
        current: { cents: -59152791, decimal: '-591527.91' },
        available: null,
        currency: 'USD',
        as_of: '2026-09-11T05:00:00.000Z',
      },
      null,
    ]);
  });
  it('returns an explicit zero count when no accounts are stored', () => {
    db.prepare('DELETE FROM accounts').run();
    expect(JSON.parse(executeTool(db, 'list_accounts', {}).content)).toEqual({
      account_count: 0,
      accounts: [],
    });
  });
  it('resolves UTC periods at month/year boundaries', () => {
    const now = new Date('2026-01-01T01:00:00Z');
    expect(resolvePeriod('last_month', now)).toEqual({ from: '2025-12-01', to: '2025-12-31' });
    expect(resolvePeriod('last_30_days', now)).toEqual({ from: '2025-12-03', to: '2026-01-01' });
    expect(resolvePeriod('ytd', now)).toEqual({ from: '2026-01-01', to: '2026-01-01' });
    expect(resolvePeriod('this_month', now)).toEqual({ from: '2026-01-01', to: '2026-01-01' });
  });
  it('escapes LIKE metacharacters and reports total before limiting', () => {
    seed(['2026-01-01', '2026-01-02'], '50%_\\ discount');
    seed(['2026-01-03'], 'other');
    const r = call('search_transactions', { query: '%_\\', limit: 1 });
    expect(r.total_matched_count).toBe(2);
    expect(r.rows[0]!.posted_at).toContain('2026-01-02');
    expect(r.row_count).toBe(1);
  });
  it('totals only the rows it returns, keeping currencies and directions apart', () => {
    seed(['2026-01-01', '2026-01-02'], 'burger', -1000);
    seed(['2026-01-03'], 'burger refund', 250);
    db.prepare(
      "UPDATE transactions SET currency='USD' WHERE description_norm='burger refund'",
    ).run();
    const all = call('search_transactions', { query: 'burger' });
    expect(all.total_matched_count).toBe(3);
    expect(all.row_count).toBe(3);
    expect(all.returned_rows_totals).toEqual([
      {
        currency: 'AUD',
        debit_total: { cents: 2000, decimal: '20.00' },
        credit_total: { cents: 0, decimal: '0.00' },
        net_total: { cents: -2000, decimal: '-20.00' },
      },
      {
        currency: 'USD',
        debit_total: { cents: 0, decimal: '0.00' },
        credit_total: { cents: 250, decimal: '2.50' },
        net_total: { cents: 250, decimal: '2.50' },
      },
    ]);
    // The page total covers the returned rows, not every match: the oldest
    // debit is matched but not returned, so it is not in the total either.
    const page = call('search_transactions', { query: 'burger', limit: 2 });
    expect(page.total_matched_count).toBe(3);
    expect(page.row_count).toBe(2);
    expect(page.returned_rows_totals).toEqual([
      {
        currency: 'AUD',
        debit_total: { cents: 1000, decimal: '10.00' },
        credit_total: { cents: 0, decimal: '0.00' },
        net_total: { cents: -1000, decimal: '-10.00' },
      },
      {
        currency: 'USD',
        debit_total: { cents: 0, decimal: '0.00' },
        credit_total: { cents: 250, decimal: '2.50' },
        net_total: { cents: 250, decimal: '2.50' },
      },
    ]);
    expect(call('search_transactions', { query: 'nothing' }).returned_rows_totals).toEqual([]);
  });
  it('excludes transfers and credits from spending, includes requested transfers', () => {
    seed(['2026-01-01'], 'shop');
    seed(['2026-01-31'], 'transfer', -2000);
    seed(['2026-01-20'], 'salary', 9000);
    db.prepare(
      "UPDATE transactions SET is_internal_transfer=1 WHERE description_norm='transfer'",
    ).run();
    const r = call('get_spending_summary', { period: 'last_month', group_by: 'merchant' });
    expect(r.date_range).toEqual({ from: '2026-01-01', to: '2026-01-31' });
    expect(r.excluded_transfer_count).toBe(1);
    expect(r.row_count).toBe(1);
    expect(r.totals[0]!.total).toEqual({ cents: 1000, decimal: '10.00' });
    const all = call('get_spending_summary', {
      period: 'last_month',
      group_by: 'account',
      include_transfers: true,
    });
    expect(all.excluded_transfer_count).toBe(0);
    expect(all.totals[0]!.total.cents).toBe(3000);
    expect(call('search_transactions', {}).total_matched_count).toBe(2);
    expect(call('search_transactions', { include_transfers: true }).total_matched_count).toBe(3);
  });
  it('sums posted rows only, as the Overview does, and reports pending rows separately', () => {
    seed(['2026-01-05', '2026-01-20'], 'groceries', -3000);
    seed(['2026-01-31'], 'settling', -8425);
    db.prepare("UPDATE transactions SET status='pending' WHERE description_norm='settling'").run();
    label('groceries', 'groceries');
    label('settling', 'groceries');
    const window = { from: '2026-01-01', to: '2026-01-31' };
    const spending = call('get_spending_summary', { ...window, group_by: 'category' });
    expect(spending).toMatchObject({
      basis: 'posted_debits',
      row_count: 2,
      pending_row_count: 1,
      pending_totals: [{ currency: 'AUD', total: { cents: 8425, decimal: '84.25' } }],
      totals: [{ currency: 'AUD', total: { cents: 6000, decimal: '60.00' } }],
      groups: [{ group: 'food_drink', currency: 'AUD', row_count: 2, total: { cents: 6000 } }],
    });
    const flow = executeTool(db, 'get_cash_flow', window, { now: new Date('2026-02-01') });
    expect(JSON.parse(flow.content)).toMatchObject({
      basis: 'posted_rows',
      row_count: 2,
      pending_row_count: 1,
      totals: [{ currency: 'AUD', outgoing_debits: { cents: 6000 }, row_count: 2 }],
      pending_totals: [{ currency: 'AUD', outgoing_debits: { cents: 8425 }, row_count: 1 }],
    });
    // The Overview's report and the chat tool read the same figure for the window.
    const report = overviewReport(db, window);
    expect(report.totals[0]).toMatchObject({
      currency: 'AUD',
      posted_outgoing_cents: spending.totals[0]!.total.cents,
      pending_count: spending.pending_row_count,
      pending_net_cents: -spending.pending_totals[0]!.total.cents,
    });
    // Search still lists the pending row, marked, and counts it in its totals.
    const listed = call('search_transactions', window);
    expect(listed.total_matched_count).toBe(3);
    expect(listed.pending_matched_count).toBe(1);
    expect(listed.rows.map((r) => r.status)).toEqual(['pending', 'posted', 'posted']);
    expect(listed.matched_rows_totals[0]!.debit_total.cents).toBe(14425);
  });
  it('keeps currencies separate and ANDs search filters', () => {
    seed(['2026-01-01'], 'shop');
    seed(['2026-01-02'], 'foreign');
    db.prepare("UPDATE transactions SET currency='USD' WHERE description_norm='foreign'").run();
    expect(
      call('get_spending_summary', { period: 'last_month', group_by: 'category' }).totals,
    ).toHaveLength(2);
    expect(call('search_transactions', { query: 'shop', from: '2026-01-02' }).row_count).toBe(0);
  });
  it('returns empty data without errors', () => {
    expect(call('get_spending_summary', { period: 'last_month', group_by: 'month' })).toMatchObject(
      { row_count: 0, totals: [], excluded_transfer_count: 0 },
    );
    expect(call('search_transactions', {})).toMatchObject({
      rows: [],
      date_range: { from: null, to: null },
    });
  });
  it('recognises monthly jitter and rejects short or irregular series', () => {
    seed(['2025-11-30', '2025-12-31', '2026-01-31']);
    // A charge that has not settled is still evidence of its series.
    db.prepare("UPDATE transactions SET status='pending' WHERE posted_at LIKE '2026-01-31%'").run();
    seed(['2025-11-15', '2025-12-17', '2026-01-15'], 'jitter');
    seed(['2025-12-01', '2026-01-01'], 'short');
    seed(['2025-11-01', '2025-12-12', '2026-01-30'], 'irregular');
    const r = call('get_recurring_charges', {});
    expect(r.charges.map((c: { description: string }) => c.description)).toEqual([
      'jitter',
      'subscription',
    ]);
    expect(r.charges[1]).toMatchObject({
      cadence: 'monthly',
      count: 3,
      last_amount: { cents: 1000, decimal: '10.00' },
      amount_drift: { cents: 0, decimal: '0.00' },
    });
  });
  it('projects month ends without reviving stale subscriptions', () => {
    seed(['2025-11-30', '2025-12-31', '2026-01-31']);
    seed(['2025-05-01', '2025-06-01', '2025-07-01'], 'stale');
    expect(call('get_upcoming_payments', {}).payments).toHaveLength(1);
    expect(call('get_upcoming_payments', {}).payments[0]).toMatchObject({
      next_date: '2026-02-28',
      estimated: true,
    });
    expect(nextMonth('2024-01-31')).toBe('2024-02-29');
  });
  it('rolls subcategories up to parents and keeps leaves separate on request', () => {
    seed(['2026-01-05'], 'cafe', -2000);
    seed(['2026-01-06'], 'supermarket', -3000);
    seed(['2026-01-07'], 'bus', -1000);
    seed(['2026-01-08'], 'petrol', -4000);
    label('cafe', 'dining');
    label('supermarket', 'groceries');
    label('bus', 'public_transport');
    label('petrol', 'fuel');
    const byParent = call('get_spending_summary', { period: 'last_month', group_by: 'category' });
    expect(byParent.groups.map((g) => [g.group, g.total.cents])).toEqual([
      ['food_drink', 5000],
      ['transport', 5000],
    ]);
    const byLeaf = call('get_spending_summary', { period: 'last_month', group_by: 'subcategory' });
    expect(byLeaf.groups.map((g) => [g.group, g.total.cents])).toEqual([
      ['dining', 2000],
      ['fuel', 4000],
      ['groceries', 3000],
      ['public_transport', 1000],
    ]);
  });
  it('groups nulls and other as uncategorised, and cash_movement under cash', () => {
    seed(['2026-01-05'], 'unlabelled', -1000);
    seed(['2026-01-06'], 'unclear', -2000);
    seed(['2026-01-07'], 'atm', -4000);
    label('unclear', 'other');
    label('atm', 'cash_movement');
    for (const group_by of ['category', 'subcategory'] as const) {
      expect(
        call('get_spending_summary', { period: 'last_month', group_by }).groups.map((g) => [
          g.group,
          g.total.cents,
        ]),
      ).toEqual(
        group_by === 'category'
          ? [
              ['cash', 4000],
              ['uncategorised', 3000],
            ]
          : [
              ['cash_movement', 4000],
              ['other', 2000],
              ['uncategorised', 1000],
            ],
      );
    }
    expect(call('search_transactions', { category: 'uncategorised' }).total_matched_count).toBe(2);
    expect(
      call('search_transactions', { category: 'cash' }).rows.map((r) => r.description),
    ).toEqual(['atm']);
  });
  it('filters by parent, by leaf, and by both at once', () => {
    seed(['2026-01-05'], 'bus', -1000);
    seed(['2026-01-06'], 'petrol', -4000);
    seed(['2026-01-07'], 'cafe', -2000);
    label('bus', 'public_transport');
    label('petrol', 'fuel');
    label('cafe', 'dining');
    expect(
      call('search_transactions', { category: 'transport' })
        .rows.map((r) => r.subcategory)
        .sort(),
    ).toEqual(['fuel', 'public_transport']);
    expect(
      call('search_transactions', { subcategory: 'fuel' }).rows.map((r) => r.description),
    ).toEqual(['petrol']);
    // Both filters apply; an incompatible pair matches nothing rather than widening.
    expect(
      call('search_transactions', { category: 'transport', subcategory: 'fuel' })
        .total_matched_count,
    ).toBe(1);
    expect(
      call('search_transactions', { category: 'food_drink', subcategory: 'fuel' })
        .total_matched_count,
    ).toBe(0);
    expect(executeTool(db, 'search_transactions', { category: 'fuel' }).isError).toBe(true);
    expect(executeTool(db, 'search_transactions', { subcategory: 'transport' }).isError).toBe(true);
  });
  it('returns the leaf, its derived parent and an independent subscription hint', () => {
    seed(['2026-01-05'], 'netflix', -1800);
    seed(['2026-01-06'], 'gym', -3000);
    seed(['2026-01-07'], 'unlabelled', -1000);
    label('netflix', 'entertainment', true);
    label('gym', 'fitness', true);
    const rows = call('search_transactions', {}).rows;
    expect(rows.map((r) => [r.description, r.category, r.subcategory, r.is_subscription])).toEqual([
      ['unlabelled', 'uncategorised', null, null],
      ['gym', 'health_wellbeing', 'fitness', true],
      ['netflix', 'lifestyle', 'entertainment', true],
    ]);
  });
  it('excludes an internal transfer debit from both grouping modes by default', () => {
    seed(['2026-01-05'], 'cafe', -2000);
    seed(['2026-01-06'], 'to savings', -5000);
    label('cafe', 'dining');
    label('to savings', 'savings');
    db.prepare(
      "UPDATE transactions SET is_internal_transfer=1, transfer_source='pair' WHERE description_norm='to savings'",
    ).run();
    for (const group_by of ['category', 'subcategory'] as const) {
      const r = call('get_spending_summary', { period: 'last_month', group_by });
      expect(r.excluded_transfer_count).toBe(1);
      expect(r.totals[0]!.total.cents).toBe(2000);
    }
    const included = call('get_spending_summary', {
      period: 'last_month',
      group_by: 'subcategory',
      include_transfers: true,
    });
    expect(included.groups.map((g) => g.group)).toEqual(['dining', 'savings']);
  });
  it('detects weekly and fortnightly, excluding transfers', () => {
    seed(['2026-01-01', '2026-01-08', '2026-01-15'], 'weekly');
    seed(['2026-01-01', '2026-01-15', '2026-01-29'], 'fortnightly');
    seed(['2026-01-01', '2026-01-08', '2026-01-15'], 'transfers');
    db.prepare(
      "UPDATE transactions SET is_internal_transfer=1 WHERE description_norm='transfers'",
    ).run();
    expect(
      call('get_recurring_charges', {}).charges.map((c: { cadence: string }) => c.cadence),
    ).toEqual(['fortnightly', 'weekly']);
    expect(call('get_recurring_charges', {}).excluded_transfer_count).toBe(3);
  });
});

describe('filtered spending comparisons', () => {
  const args = { period: 'this_month', compare_period: 'last_month', group_by: 'merchant' };
  it('computes pinned totals and differences and reports unequal UTC windows and coverage', () => {
    seed(['2026-01-15'], 'woolworths previous', -10000);
    seed(['2026-02-01'], 'woolworths current', -15000);
    const r = call('get_spending_summary', { ...args, query: 'woolworths' }, '2026-02-10');
    expect(r.totals).toEqual([{ currency: 'AUD', total: { cents: 15000, decimal: '150.00' } }]);
    expect(r.comparison!.totals).toEqual([
      {
        currency: 'AUD',
        primary_total: { cents: 15000, decimal: '150.00' },
        comparison_total: { cents: 10000, decimal: '100.00' },
        change: { cents: 5000, decimal: '50.00' },
        percentage_change: 50,
        percentage_change_reason: null,
      },
    ]);
    expect(r.day_count).toBe(10);
    expect(r.date_range).toEqual({ from: '2026-02-01', to: '2026-02-10' });
    expect(r.comparison!.day_count).toBe(31);
    expect(r.comparison!.coverage.overlap).toEqual({ from: '2026-01-15', to: '2026-01-31' });
    expect(r.coverage.complete_history_verified).toBe(false);
    expect(r.comparison!.groups).toMatchObject([
      {
        group: 'woolworths current',
        comparison_total: { cents: 0 },
        percentage_change: null,
        percentage_change_reason: 'comparison_total_zero',
      },
      {
        group: 'woolworths previous',
        primary_total: { cents: 0 },
        change: { cents: -10000 },
        percentage_change: -100,
      },
    ]);
  });
  it('shares literal query and AND filters with search, including accounts and transfers', () => {
    upsertAccount(db, { source: 'test', externalId: 'b', name: 'Other', currency: 'AUD', raw: {} });
    seed(['2026-01-01', '2026-01-02', '2026-01-03'], '50%_\\ discount');
    seed(['2026-01-04'], '50xxx discount');
    label('50%_\\ discount', 'groceries');
    db.prepare('UPDATE transactions SET account_id = 2 WHERE id = 2').run();
    db.prepare('UPDATE transactions SET is_internal_transfer = 1 WHERE id = 3').run();
    const filters = {
      query: '%_\\',
      category: 'food_drink',
      subcategory: 'groceries',
      account_id: 1,
    };
    for (const include_transfers of [false, true]) {
      const r = call('get_spending_summary', {
        period: 'last_month',
        group_by: 'category',
        ...filters,
        include_transfers,
      });
      const searched = call('search_transactions', { ...filters, include_transfers });
      expect(r.row_count).toBe(include_transfers ? 2 : 1);
      expect(r.row_count).toBe(searched.total_matched_count);
      expect(r.totals[0]!.total).toEqual(searched.returned_rows_totals[0]!.debit_total);
      expect(r.excluded_transfer_count).toBe(include_transfers ? 0 : 1);
      expect(r.filters).toEqual({ ...filters, include_transfers });
    }
    expect(
      call('get_spending_summary', {
        period: 'last_month',
        group_by: 'category',
        ...filters,
        category: 'transport',
      }).totals,
    ).toEqual([]);
  });
  it('keeps currencies separate, rounds percentages and handles empty windows', () => {
    seed(['2026-01-01'], 'aud previous', -300);
    seed(['2026-02-01'], 'aud current', -400);
    seed(['2026-02-02'], 'usd only', -900);
    db.prepare(
      "UPDATE transactions SET currency = 'USD' WHERE description_norm = 'usd only'",
    ).run();
    const r = call('get_spending_summary', args, '2026-02-10');
    expect(r.comparison!.totals).toMatchObject([
      { currency: 'AUD', change: { cents: 100 }, percentage_change: 33.33 },
      { currency: 'USD', change: { cents: 900 }, percentage_change: null },
    ]);
    const empty = call('get_spending_summary', { ...args, query: 'absent' });
    expect(empty.totals).toEqual([]);
    expect(empty.comparison!.totals).toEqual([]);
    expect(empty.comparison!.groups).toEqual([]);
    const outside = call('get_spending_summary', {
      ...args,
      period: undefined,
      from: '2027-01-01',
      to: '2027-01-01',
    });
    expect(outside.coverage.overlap).toBeNull();
    expect(outside.coverage.overlap_day_count).toBe(0);
    expect(outside.comparison!.totals[0]).toMatchObject({ percentage_change: -100 });
    expect(
      executeTool(db, 'get_spending_summary', {
        ...args,
        compare_period: undefined,
        compare_from: '2026-02-02',
        compare_to: '2026-01-01',
      }).isError,
    ).toBe(true);
  });
});

describe('flat window arguments', () => {
  const error = (name: string, input: Record<string, unknown>) => {
    const result = executeTool(db, name, input, { now: new Date('2026-02-10T12:00:00Z') });
    expect(result.isError).toBe(true);
    return (JSON.parse(result.content) as { error: string }).error;
  };
  it('renders no anyOf anywhere in the summary and cash-flow schemas', () => {
    for (const name of ['get_spending_summary', 'get_cash_flow']) {
      const def = toolDefs().find((d) => d.name === name)!;
      const json = JSON.stringify(def.jsonSchema);
      expect(json).not.toContain('anyOf');
      expect(json).not.toContain('oneOf');
      const properties = def.jsonSchema.properties as Record<string, { type?: unknown }>;
      for (const field of ['period', 'from', 'to'])
        expect(properties[field]).toMatchObject({ type: 'string' });
      expect(def.description).toContain('never a period object or JSON string');
    }
    const summaryProps = toolDefs().find((d) => d.name === 'get_spending_summary')!.jsonSchema
      .properties as Record<string, { type?: unknown }>;
    for (const field of ['compare_period', 'compare_from', 'compare_to'])
      expect(summaryProps[field]).toMatchObject({ type: 'string' });
  });
  it('accepts each preset and an explicit window on both tools', () => {
    seed(['2026-01-15', '2026-02-01'], 'shop', -1000);
    const now = '2026-02-10';
    const expected = {
      last_month: { from: '2026-01-01', to: '2026-01-31' },
      this_month: { from: '2026-02-01', to: '2026-02-10' },
      last_30_days: { from: '2026-01-12', to: '2026-02-10' },
      ytd: { from: '2026-01-01', to: '2026-02-10' },
    };
    for (const [period, range] of Object.entries(expected)) {
      expect(
        call('get_spending_summary', { period, group_by: 'category' }, now).date_range,
      ).toEqual(range);
      expect(call('get_cash_flow', { period }, now).date_range).toEqual(range);
    }
    const explicit = { from: '2026-01-10', to: '2026-01-20' };
    const summary = call('get_spending_summary', { ...explicit, group_by: 'merchant' }, now);
    expect(summary.date_range).toEqual(explicit);
    expect(summary.totals).toEqual([{ currency: 'AUD', total: { cents: 1000, decimal: '10.00' } }]);
    expect(call('get_cash_flow', explicit, now).date_range).toEqual(explicit);
  });
  it.each([
    [
      'period plus dates',
      { period: 'last_month', from: '2026-01-01', to: '2026-01-31' },
      'not both',
    ],
    ['neither', {}, 'Missing window'],
    ['from without to', { from: '2026-01-01' }, 'must be sent together'],
    ['to without from', { to: '2026-01-31' }, 'must be sent together'],
    ['from after to', { from: '2026-02-02', to: '2026-01-01' }, 'on or before'],
  ])('rejects %s on both tools', (_, fields, fragment) => {
    expect(error('get_spending_summary', { ...fields, group_by: 'category' })).toContain(fragment);
    expect(error('get_cash_flow', fields)).toContain(fragment);
  });
  it('rejects the retired object form and its JSON string, naming the flat fields', () => {
    const object = { from: '2026-01-01', to: '2026-01-31' };
    for (const period of [object, JSON.stringify(object)]) {
      for (const name of ['get_spending_summary', 'get_cash_flow']) {
        const message = error(name, { period, group_by: 'category' });
        expect(message).toContain('omit period and send from and to');
        expect(message).toContain('last_month, this_month, last_30_days, ytd');
      }
      const compare = error('get_spending_summary', {
        period: 'this_month',
        compare_to: period,
        group_by: 'merchant',
      });
      expect(compare).toContain('compare_to must be a YYYY-MM-DD date');
      expect(compare).toContain('compare_from and compare_to');
    }
  });
  it('validates the comparison window under the same exactly-one rule', () => {
    const base = { period: 'this_month', group_by: 'merchant' };
    expect(
      error('get_spending_summary', {
        ...base,
        compare_period: 'last_month',
        compare_from: '2026-01-01',
        compare_to: '2026-01-31',
      }),
    ).toContain('not both');
    expect(error('get_spending_summary', { ...base, compare_from: '2026-01-01' })).toContain(
      'compare_from and compare_to must be sent together',
    );
    expect(
      error('get_spending_summary', {
        ...base,
        compare_from: '2026-02-02',
        compare_to: '2026-01-01',
      }),
    ).toContain('compare_from must be on or before compare_to');
    expect(call('get_spending_summary', base, '2026-02-10').comparison).toBeUndefined();
  });
  it('keeps the comparison figures under preset and date forms alike', () => {
    seed(['2026-01-15'], 'woolworths previous', -10000);
    seed(['2026-02-01'], 'woolworths current', -15000);
    const pinned = {
      primary_total: { cents: 15000, decimal: '150.00' },
      comparison_total: { cents: 10000, decimal: '100.00' },
      change: { cents: 5000, decimal: '50.00' },
      percentage_change: 50,
    };
    const forms = [
      { period: 'this_month', compare_period: 'last_month' },
      { from: '2026-02-01', to: '2026-02-10', compare_period: 'last_month' },
      { period: 'this_month', compare_from: '2026-01-01', compare_to: '2026-01-31' },
      {
        from: '2026-02-01',
        to: '2026-02-10',
        compare_from: '2026-01-01',
        compare_to: '2026-01-31',
      },
    ];
    for (const form of forms) {
      const r = call(
        'get_spending_summary',
        { ...form, query: 'woolworths', group_by: 'merchant' },
        '2026-02-10',
      );
      expect(r.comparison!.totals[0]).toMatchObject(pinned);
      expect(r.comparison!.date_range).toEqual({ from: '2026-01-01', to: '2026-01-31' });
    }
  });
});

describe('search window preset', () => {
  const error = (input: Record<string, unknown>) => {
    const result = executeTool(db, 'search_transactions', input, {
      now: new Date('2026-02-10T12:00:00Z'),
    });
    expect(result.isError).toBe(true);
    return (JSON.parse(result.content) as { error: string }).error;
  };
  it('exposes period as a flat string field and describes the optional window', () => {
    const def = toolDefs().find((d) => d.name === 'search_transactions')!;
    const json = JSON.stringify(def.jsonSchema);
    expect(json).not.toContain('anyOf');
    const properties = def.jsonSchema.properties as Record<string, { type?: unknown }>;
    for (const field of ['period', 'from', 'to'])
      expect(properties[field]).toMatchObject({ type: 'string' });
    expect(def.description).toContain('either period (one of last_month, this_month');
    expect(def.description).toContain('never a period object or JSON string');
  });
  it('resolves each preset against now and echoes it in filters', () => {
    seed(['2025-12-20', '2026-01-15', '2026-02-01', '2026-02-09'], 'shop', -1000);
    const now = '2026-02-10';
    const expected = {
      last_month: { range: { from: '2026-01-01', to: '2026-01-31' }, count: 1 },
      this_month: { range: { from: '2026-02-01', to: '2026-02-10' }, count: 2 },
      last_30_days: { range: { from: '2026-01-12', to: '2026-02-10' }, count: 3 },
      ytd: { range: { from: '2026-01-01', to: '2026-02-10' }, count: 3 },
    };
    for (const [period, { range, count }] of Object.entries(expected)) {
      const r = call('search_transactions', { period }, now);
      expect(r.date_range).toEqual(range);
      expect(r.total_matched_count).toBe(count);
      expect(r.filters).toMatchObject({ period, from: null, to: null });
    }
    const explicit = call('search_transactions', { from: '2026-01-01', to: '2026-01-31' }, now);
    expect(explicit.total_matched_count).toBe(1);
    expect(explicit.filters).toMatchObject({ period: null, from: '2026-01-01', to: '2026-01-31' });
  });
  it('keeps the open-ended forms: one side only, or no window at all', () => {
    seed(['2025-12-20', '2026-01-15', '2026-02-09'], 'shop', -1000);
    const now = '2026-02-10';
    expect(call('search_transactions', { to: '2026-01-31' }, now).total_matched_count).toBe(2);
    expect(call('search_transactions', { from: '2026-01-01' }, now).total_matched_count).toBe(2);
    expect(call('search_transactions', {}, now).total_matched_count).toBe(3);
  });
  it.each([
    [
      'period plus dates',
      { period: 'last_month', from: '2026-01-01', to: '2026-01-31' },
      'not both',
    ],
    ['period plus one date', { period: 'last_month', to: '2026-01-31' }, 'not both'],
    ['from after to', { from: '2026-02-02', to: '2026-01-01' }, 'on or before'],
    ['an unknown preset', { period: 'last_week' }, 'period must be one of'],
  ])('rejects %s with a message naming the flat forms', (_, fields, fragment) => {
    expect(error(fields)).toContain(fragment);
  });
  it('rejects the retired object form and its JSON string, naming the flat fields', () => {
    const object = { from: '2026-01-01', to: '2026-01-31' };
    for (const period of [object, JSON.stringify(object)]) {
      const message = error({ period });
      expect(message).toContain('omit period and send from and to');
    }
  });
  it('carries the resolved preset bounds through the cursor across a day change', () => {
    seed(['2026-02-01', '2026-02-05', '2026-02-09'], 'shop', -1000);
    const first = call('search_transactions', { period: 'this_month', limit: 2 }, '2026-02-10');
    expect(first.has_more).toBe(true);
    const second = call(
      'search_transactions',
      { period: 'this_month', limit: 2, cursor: first.next_cursor! },
      '2026-03-01',
    );
    expect(second.date_range).toEqual({ from: '2026-02-01', to: '2026-02-10' });
    expect(second.rows.map((r) => r.posted_at.slice(0, 10))).toEqual(['2026-02-01']);
    expect(second.has_more).toBe(false);
  });
});
