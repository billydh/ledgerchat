import { describe, expect, it } from 'vitest';
import {
  classLabel,
  describeToolInput,
  reconciliationLabel,
  toolLabel,
} from '../../src/server/public/terms.js';
import { formatMoney } from '../../src/server/public/money.js';
import { describeWindow, presetWindow } from '../../src/server/public/results.js';
describe('plain-language terms', () => {
  it('names reporting classes and tools in user words', () => {
    expect(classLabel('consumption')).toBe('Spending');
    expect(classLabel('unresolved_movement')).toBe('Not yet classified');
    expect(classLabel('something_new')).toBe('something new');
    expect(toolLabel('get_spending_summary')).toBe('Summarised spending');
    expect(toolLabel('mystery_tool')).toBe('Ran mystery_tool');
  });
  it('describes reconciliation with the gap named in money', () => {
    expect(reconciliationLabel({ status: 'matched' })).toEqual({
      text: 'Matches your statement',
      tone: 'ok',
    });
    expect(
      reconciliationLabel({ status: 'unexplained', unexplained_cents: -1234 }, (c) =>
        formatMoney(c, 'AUD'),
      ),
    ).toEqual({ text: 'Gap of $12.34 vs statement', tone: 'warn' });
    expect(reconciliationLabel(undefined).tone).toBe('muted');
  });
  it('summarises tool arguments on one line', () => {
    expect(
      describeToolInput('get_spending_summary', {
        category: 'food_and_drink',
        period: 'last_month',
        compare_period: 'this_month',
        group_by: 'subcategory',
      }),
    ).toBe('food and drink · last month · vs this month · by subcategory');
    expect(describeToolInput('search_transactions', { query: 'uber', from: '2026-08-01' })).toBe(
      '"uber" · 2026-08-01 to …',
    );
    expect(describeToolInput('list_accounts', {})).toBe('');
  });
});
describe('money and date presentation', () => {
  it('formats signed money', () => {
    expect(formatMoney(-10667, 'AUD')).toBe('-$106.67');
    expect(formatMoney(80000, 'AUD', { sign: 'always' })).toBe('+$800.00');
    expect(formatMoney(-500, 'AUD', { sign: 'never' })).toBe('$5.00');
    expect(formatMoney(1250, 'EUR', { code: true })).toBe('€12.50 EUR');
    expect(formatMoney(null, 'AUD')).toBe('$0.00');
  });
  it('resolves preset windows like the chat tools', () => {
    expect(presetWindow('this_month', '2026-09-14')).toEqual({
      from: '2026-09-01',
      to: '2026-09-14',
    });
    expect(presetWindow('last_month', '2026-01-14')).toEqual({
      from: '2025-12-01',
      to: '2025-12-31',
    });
    expect(presetWindow('last_30_days', '2026-03-05')).toEqual({
      from: '2026-02-04',
      to: '2026-03-05',
    });
    expect(presetWindow('ytd', '2026-09-14')).toEqual({ from: '2026-01-01', to: '2026-09-14' });
    expect(presetWindow('all', '2026-09-14')).toBeNull();
  });
  it('describes windows in words', () => {
    expect(describeWindow('2026-09-01', '2026-09-14')).toBe('1 to 14 September 2026');
    expect(describeWindow('2026-08-28', '2026-09-03')).toBe('28 August to 3 September 2026');
    expect(describeWindow('2025-03-03', '2026-03-02')).toBe('3 March 2025 to 2 March 2026');
    expect(describeWindow(null, null)).toBe('All imported history');
  });
});
