import { expect, it } from 'vitest';
import {
  asksForSpendingComparison,
  renderSpendingComparison as render,
} from '../../src/chat/comparison.js';

const context = {
  descriptions: ['woolworths', 'cafe', 'petrol'],
  accounts: [] as { id: number; name: string }[],
  now: new Date('2026-09-23T12:00:00Z'),
};
const renderSpendingComparison = (question: string, content: string) =>
  render(question, content, context);

function result(primaryFirst = false) {
  const july = { from: '2026-07-01', to: '2026-07-31' };
  const august = { from: '2026-08-01', to: '2026-08-31' };
  const primaryCents = primaryFirst ? 122632 : 186940;
  const comparisonCents = primaryFirst ? 186940 : 122632;
  const amount = (cents: number) => ({ cents, decimal: (cents / 100).toFixed(2) });
  return JSON.stringify({
    basis: 'posted_debits',
    date_range: primaryFirst ? july : august,
    coverage: { overlap: primaryFirst ? july : august },
    totals: [{ currency: 'AUD', total: amount(primaryCents) }],
    filters: {
      query: null,
      category: 'food_drink',
      subcategory: null,
      account_id: null,
      include_transfers: false,
    },
    pending_row_count: 0,
    comparison: {
      date_range: primaryFirst ? august : july,
      coverage: { overlap: primaryFirst ? august : july },
      pending_row_count: 0,
      totals: [
        {
          currency: 'AUD',
          primary_total: amount(primaryCents),
          comparison_total: amount(comparisonCents),
          change: amount(primaryCents - comparisonCents),
          percentage_change: primaryFirst ? -34.4 : 52.44,
          percentage_change_reason: null,
        },
      ],
    },
  });
}

it('renders dated totals and the right change when the model reverses tool windows', () => {
  const question = 'How did food and drink spending change between July and August 2026?';
  const answer = renderSpendingComparison(question, result(true))!;
  expect(answer).toContain('**Food and drink spending comparison**');
  expect(answer).toContain('1 Aug 2026 to 31 Aug 2026: **AUD 1,869.40**');
  expect(answer).toContain('1 July 2026 to 31 July 2026: **AUD 1,226.32**');
  expect(answer).toContain('**AUD 643.08 more**');
  expect(answer).not.toContain('34.4%');
  const narrow = JSON.parse(result(true)) as { filters: { category: string | null } };
  expect(
    renderSpendingComparison(
      'Compare July spending with August spending in 2026.',
      JSON.stringify(narrow),
    ),
  ).toBeNull();
  narrow.filters.category = null;
  expect(
    renderSpendingComparison(
      'Compare July spending with August spending in 2026.',
      JSON.stringify(narrow),
    ),
  ).not.toBeNull();
});

it('calculates a requested percentage using the earlier window as its baseline', () => {
  const data = JSON.parse(result(true)) as { filters: { category: string | null } };
  data.filters.category = null;
  const answer = renderSpendingComparison(
    'What percentage more did I spend in August than July?',
    JSON.stringify(data),
  )!;
  expect(answer).toContain('52.44% increase');
  expect(answer).not.toContain('34.4%');
});

it('reports a zero baseline as an unavailable percentage', () => {
  const data = JSON.parse(result()) as {
    comparison: {
      totals: {
        comparison_total: { cents: number; decimal: string };
        change: { cents: number; decimal: string };
        percentage_change: number | null;
      }[];
    };
  };
  const row = data.comparison.totals[0]!;
  row.comparison_total = { cents: 0, decimal: '0.00' };
  row.change = { cents: 186940, decimal: '1869.40' };
  row.percentage_change = null;
  const answer = renderSpendingComparison(
    'What percentage did food and drink spending increase from July to August 2026?',
    JSON.stringify(data),
  )!;
  expect(answer).toContain('Percentage change is unavailable');
  expect(answer).not.toContain('100%');
});

it('keeps currencies separate instead of combining totals', () => {
  const data = JSON.parse(result()) as {
    totals: { currency: string; total: { cents: number; decimal: string } }[];
    comparison: {
      totals: {
        currency: string;
        primary_total: { cents: number; decimal: string };
        comparison_total: { cents: number; decimal: string };
        change: { cents: number; decimal: string };
        percentage_change: number | null;
        percentage_change_reason: string | null;
      }[];
    };
  };
  data.totals.push({ currency: 'USD', total: { cents: 12000, decimal: '120.00' } });
  data.comparison.totals.push({
    currency: 'USD',
    primary_total: { cents: 12000, decimal: '120.00' },
    comparison_total: { cents: 10000, decimal: '100.00' },
    change: { cents: 2000, decimal: '20.00' },
    percentage_change: 20,
    percentage_change_reason: null,
  });
  const answer = renderSpendingComparison(
    'Compare food and drink spending between July and August 2026.',
    JSON.stringify(data),
  )!;
  expect(answer).toContain('AUD 643.08 more');
  expect(answer).toContain('USD 20.00 more');
  expect(answer).not.toContain('AUD 663.08');
});

it('refuses a malformed or internally inconsistent comparison', () => {
  const question = 'Compare food spending between July and August.';
  expect(renderSpendingComparison(question, '{')).toBeNull();
  const bad = JSON.parse(result()) as { comparison: { totals: { change: { cents: number } }[] } };
  bad.comparison.totals[0]!.change.cents = 186940;
  expect(renderSpendingComparison(question, JSON.stringify(bad))).toBeNull();
});

it('does not present a comparison with the wrong named category or months', () => {
  const wrongScope = JSON.parse(result()) as { filters: { category: string | null } };
  wrongScope.filters.category = null;
  expect(
    renderSpendingComparison(
      'Compare food and drink spending between July and August 2026.',
      JSON.stringify(wrongScope),
    ),
  ).toBeNull();
  expect(
    renderSpendingComparison(
      'Compare food and drink spending between July and September 2026.',
      result(),
    ),
  ).toBeNull();
  expect(
    renderSpendingComparison(
      'Compare grocery and dining spending between July and August 2026.',
      result(),
    ),
  ).toBeNull();
  expect(
    renderSpendingComparison('Compare transport spending between July and August 2026.', result()),
  ).toBeNull();
  expect(
    renderSpendingComparison('Compare rent spending between July and August 2026.', result()),
  ).toBeNull();
  expect(
    renderSpendingComparison('Compare food spending in June, July and August 2026.', result()),
  ).toBeNull();
  expect(
    renderSpendingComparison(
      'Compare food and rent spending between July and August 2026.',
      result(),
    ),
  ).toBeNull();
});

it('requires the requested health or petrol scope instead of accepting all spending', () => {
  const unfiltered = JSON.parse(result()) as {
    filters: { category: string | null; subcategory: string | null };
  };
  unfiltered.filters.category = null;
  expect(
    renderSpendingComparison(
      'Compare health spending between July and August 2026.',
      JSON.stringify(unfiltered),
    ),
  ).toBeNull();
  expect(
    renderSpendingComparison(
      'Compare petrol spending between July and August 2026.',
      JSON.stringify(unfiltered),
    ),
  ).toBeNull();
  unfiltered.filters.subcategory = 'health';
  expect(
    renderSpendingComparison(
      'Compare health spending between July and August 2026.',
      JSON.stringify(unfiltered),
    ),
  ).not.toBeNull();
  unfiltered.filters.subcategory = 'fuel';
  expect(
    renderSpendingComparison(
      'Compare petrol spending between July and August 2026.',
      JSON.stringify(unfiltered),
    ),
  ).not.toBeNull();
});

it('validates account and transfer filters against the question', () => {
  const data = JSON.parse(result()) as {
    filters: { account_id: number | null; include_transfers: boolean };
  };
  const withAccounts = { ...context, accounts: [{ id: 1, name: 'Everyday' }] };
  const question = 'Compare food and drink spending between July and August 2026.';
  data.filters.account_id = 1;
  expect(render(question, JSON.stringify(data), withAccounts)).toBeNull();
  const accountQuestion =
    'Compare food and drink spending on my Everyday account between July and August 2026.';
  expect(render(accountQuestion, JSON.stringify(data), withAccounts)).not.toBeNull();
  data.filters.account_id = null;
  expect(render(accountQuestion, JSON.stringify(data), withAccounts)).toBeNull();
  expect(
    render(
      'Compare food and drink spending on my Everyday card between July and August 2026.',
      JSON.stringify(data),
      withAccounts,
    ),
  ).toBeNull();
  data.filters.account_id = 1;
  expect(
    render(
      'Compare food and drink spending on my Everyday card between July and August 2026.',
      JSON.stringify(data),
      withAccounts,
    ),
  ).not.toBeNull();
  expect(
    render(
      'Compare food and drink spending on my Savings card between July and August 2026.',
      JSON.stringify(data),
      { ...context, accounts: [{ id: 1, name: 'Savings' }] },
    ),
  ).not.toBeNull();
  data.filters.account_id = null;
  expect(
    render(
      'Compare food spending across all accounts except Everyday between July and August 2026.',
      JSON.stringify(data),
      withAccounts,
    ),
  ).toBeNull();
  data.filters.include_transfers = true;
  expect(render(question, JSON.stringify(data), withAccounts)).toBeNull();
  expect(
    render(
      'Compare food and drink spending including transfers between July and August 2026.',
      JSON.stringify(data),
      withAccounts,
    ),
  ).not.toBeNull();
  data.filters.include_transfers = false;
  expect(
    render(
      'Compare food and drink spending without transfers between July and August 2026.',
      JSON.stringify(data),
      withAccounts,
    ),
  ).not.toBeNull();
  expect(
    render(
      'Compare food and drink spending including transfers between July and August 2026.',
      JSON.stringify(data),
      withAccounts,
    ),
  ).toBeNull();
});

it('resolves yearless named months against today and rejects a wrong year', () => {
  const question = 'Compare food and drink spending in July and August.';
  expect(renderSpendingComparison(question, result())).not.toBeNull();
  const wrongYear = JSON.parse(result()) as {
    date_range: { from: string; to: string };
    coverage: { overlap: { from: string; to: string } };
    comparison: {
      date_range: { from: string; to: string };
      coverage: { overlap: { from: string; to: string } };
    };
  };
  wrongYear.date_range = { from: '2025-08-01', to: '2025-08-31' };
  wrongYear.comparison.date_range = { from: '2025-07-01', to: '2025-07-31' };
  wrongYear.coverage.overlap = wrongYear.date_range;
  wrongYear.comparison.coverage.overlap = wrongYear.comparison.date_range;
  expect(renderSpendingComparison(question, JSON.stringify(wrongYear))).toBeNull();
});

it('resolves a yearless December–January pair across the year boundary', () => {
  const data = JSON.parse(result()) as {
    date_range: { from: string; to: string };
    coverage: { overlap: { from: string; to: string } };
    comparison: {
      date_range: { from: string; to: string };
      coverage: { overlap: { from: string; to: string } };
    };
  };
  data.date_range = { from: '2026-01-01', to: '2026-01-31' };
  data.comparison.date_range = { from: '2025-12-01', to: '2025-12-31' };
  data.coverage.overlap = data.date_range;
  data.comparison.coverage.overlap = data.comparison.date_range;
  const answer = render('Compare food spending in December and January.', JSON.stringify(data), {
    ...context,
    now: new Date('2026-02-15T12:00:00Z'),
  });
  expect(answer).toContain('1 Jan 2026 to 31 Jan 2026');
  expect(answer).toContain('1 Dec 2025 to 31 Dec 2025');
});

it('withholds a numeric comparison when imported data does not overlap a period', () => {
  const data = JSON.parse(result()) as {
    coverage: { overlap: null | { from: string; to: string } };
    comparison: { coverage: { overlap: null | { from: string; to: string } } };
  };
  data.comparison.coverage.overlap = null;
  const answer = renderSpendingComparison(
    'Compare food spending in July and August 2026.',
    JSON.stringify(data),
  )!;
  expect(answer).toContain('No imported transactions overlap');
  expect(answer).toContain('unavailable');
  expect(answer).not.toContain('AUD 643.08');
});

it('checks relative month windows against the application date', () => {
  const question = 'Compare food and drink spending this month with last month.';
  expect(renderSpendingComparison(question, result())).toBeNull();
  const data = JSON.parse(result()) as {
    date_range: { from: string; to: string };
    comparison: { date_range: { from: string; to: string } };
  };
  data.date_range = { from: '2026-09-01', to: '2026-09-23' };
  data.comparison.date_range = { from: '2026-08-01', to: '2026-08-31' };
  expect(renderSpendingComparison(question, JSON.stringify(data))).not.toBeNull();
  expect(
    renderSpendingComparison(
      'Compare food and drink spending over the last 30 days.',
      JSON.stringify(data),
    ),
  ).toBeNull();
});

it('renders a requested top merchant list only from a matching grouped comparison', () => {
  const question = 'Compare food spending in July and August 2026, and list top merchants.';
  const data = JSON.parse(result()) as {
    comparison: { groups?: unknown[] };
  };
  data.comparison.groups = [
    {
      group: 'woolworths',
      currency: 'AUD',
      primary_total: { cents: 150000, decimal: '1500.00' },
      comparison_total: { cents: 90000, decimal: '900.00' },
      change: { cents: 60000, decimal: '600.00' },
      percentage_change: 66.67,
      percentage_change_reason: null,
    },
    {
      group: 'cafe',
      currency: 'AUD',
      primary_total: { cents: 36940, decimal: '369.40' },
      comparison_total: { cents: 32632, decimal: '326.32' },
      change: { cents: 4308, decimal: '43.08' },
      percentage_change: 13.2,
      percentage_change_reason: null,
    },
  ];
  expect(render(question, JSON.stringify(data), context)).toBeNull();
  const answer = render(question, JSON.stringify(data), { ...context, groupBy: 'merchant' })!;
  expect(answer).toContain('AUD 643.08 more');
  expect(answer).toContain('woolworths: **AUD 1,500.00**');
  expect(answer).toContain('cafe: **AUD 369.40**');
  expect(answer.indexOf('woolworths')).toBeLessThan(answer.indexOf('cafe'));
  (data.comparison.groups[0] as { primary_total: { cents: number } }).primary_total.cents = 149999;
  expect(render(question, JSON.stringify(data), { ...context, groupBy: 'merchant' })).toBeNull();
});

it('requires a named merchant in the description filter, including an unseen merchant', () => {
  const question = 'How did my Woolworths spending change between July and August 2026?';
  expect(renderSpendingComparison(question, result())).toBeNull();
  expect(
    render(question, result(), { ...context, descriptions: ['POS Woolworths 1234'] }),
  ).toBeNull();
  expect(
    render('Did I spend more at woolworths in August than July 2026?', result(), {
      ...context,
      descriptions: ['POS Woolworths 1234'],
    }),
  ).toBeNull();
  const filtered = JSON.parse(result()) as {
    filters: { query: string | null; category: string | null };
  };
  filtered.filters.query = 'woolworths';
  filtered.filters.category = null;
  expect(renderSpendingComparison(question, JSON.stringify(filtered))).not.toBeNull();
  filtered.filters.query = 'cafe';
  expect(renderSpendingComparison(question, JSON.stringify(filtered))).toBeNull();
  filtered.filters.query = 'spending';
  expect(
    renderSpendingComparison(
      'Compare spending between July and August 2026.',
      JSON.stringify(filtered),
    ),
  ).toBeNull();
  filtered.filters.query = null;
  expect(
    render(
      'How did my Newshop spending change between July and August 2026?',
      JSON.stringify(filtered),
      { ...context, descriptions: [] },
    ),
  ).toBeNull();
});

it('requires exact partial date windows when days are named', () => {
  const question = 'How did food and drink spending change from 1–15 July to 1–15 August 2026?';
  expect(renderSpendingComparison(question, result())).toBeNull();
  const partial = JSON.parse(result()) as {
    date_range: { from: string; to: string };
    comparison: { date_range: { from: string; to: string } };
  };
  partial.date_range.to = '2026-08-15';
  partial.comparison.date_range.to = '2026-07-15';
  expect(renderSpendingComparison(question, JSON.stringify(partial))).not.toBeNull();
  expect(
    renderSpendingComparison(
      'Compare food and drink spending from 2026-07-01 to 2026-07-15 with 2026-08-01 to 2026-08-15.',
      JSON.stringify(partial),
    ),
  ).not.toBeNull();
  expect(
    renderSpendingComparison(
      'Compare food and drink spending from 1 July to 15 July 2026 with 1 August to 15 August 2026.',
      JSON.stringify(partial),
    ),
  ).not.toBeNull();
  expect(
    renderSpendingComparison(
      'Compare food and drink spending from July 1–15 to August 1–15, 2026.',
      JSON.stringify(partial),
    ),
  ).not.toBeNull();
  expect(
    renderSpendingComparison(
      'Compare food and drink spending from 1/7/2026 to 15/7/2026 with 1/8/2026 to 15/8/2026.',
      JSON.stringify(partial),
    ),
  ).toBeNull();
});

it('leaves unrelated questions to the ordinary chat flow', () => {
  expect(asksForSpendingComparison('Compare my expenses in July and August 2026.')).toBe(true);
  expect(asksForSpendingComparison('What are my recurring charges?')).toBe(false);
  expect(renderSpendingComparison('What are my recurring charges?', result())).toBeNull();
  expect(asksForSpendingComparison('What drove the increase in food spending?')).toBe(false);
  expect(
    asksForSpendingComparison(
      'Compare food spending in July and August 2026, and list top merchants.',
    ),
  ).toBe(true);
  expect(
    asksForSpendingComparison(
      'Compare food spending in July and August 2026, and list top merchants and show transactions.',
    ),
  ).toBe(false);
  expect(
    asksForSpendingComparison(
      'Compare food spending in July and August 2026, and list my latest transactions.',
    ),
  ).toBe(false);
  expect(
    asksForSpendingComparison(
      'Compare food spending in July and August 2026, and which merchants drove it?',
    ),
  ).toBe(false);
});
