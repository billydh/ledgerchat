import { expect, it } from 'vitest';
import {
  asksForDirectBalance,
  asksForDirectCashFlow,
  renderBalances,
  renderCashFlow,
  requestedCashFlowWindow,
} from '../../src/chat/verified-answers.js';

const now = new Date('2026-09-23T12:00:00Z');
const accounts = [
  { id: 1, name: 'Everyday' },
  { id: 2, name: 'Savings' },
];
const amount = (cents: number) => ({ cents, decimal: (cents / 100).toFixed(2) });
const balances = JSON.stringify({
  account_count: 2,
  accounts: [
    {
      id: 1,
      name: 'Everyday',
      currency: 'AUD',
      balance: {
        current: amount(74777),
        available: amount(80295),
        currency: 'AUD',
        as_of: '2026-09-11T05:00:00.000Z',
      },
    },
    {
      id: 2,
      name: 'Savings',
      currency: 'AUD',
      balance: {
        current: amount(510000),
        available: null,
        currency: 'AUD',
        as_of: '2026-09-10T05:00:00.000Z',
      },
    },
  ],
});
const august = { from: '2026-08-01', to: '2026-08-31' };
function flow(): {
  date_range: { from: string; to: string };
  coverage: { overlap: { from: string; to: string } | null };
  filters: { account_id: number | null; include_transfers: boolean };
  pending_row_count: number;
  totals: {
    currency: string;
    incoming_credits: ReturnType<typeof amount>;
    outgoing_debits: ReturnType<typeof amount>;
    net_flow: ReturnType<typeof amount>;
  }[];
} {
  return {
    date_range: august,
    coverage: { overlap: august },
    filters: { account_id: null, include_transfers: false },
    pending_row_count: 0,
    totals: [
      {
        currency: 'AUD',
        incoming_credits: amount(20000),
        outgoing_debits: amount(10000),
        net_flow: amount(10000),
      },
    ],
  };
}

it('renders balances with the account and imported as-of date attached', () => {
  expect(asksForDirectBalance('What is my bank balance?')).toBe(true);
  const answer = renderBalances('What is my Everyday card balance?', balances)!;
  expect(answer).toContain('Everyday: current **AUD 747.77** as of 11 Sept 2026');
  expect(answer).not.toContain('Savings:');
  expect(answer).not.toContain('AUD 5,100.00');
  expect(renderBalances('What is my balance on Everyday?', balances)).not.toContain('Savings:');
  expect(renderBalances('What is my available balance?', balances)).toContain('AUD 802.95');
  expect(renderBalances('Why did my balance change?', balances)).toBeNull();
  expect(renderBalances('What is my unknown card balance?', balances)).toBeNull();
  expect(renderBalances('What is my balance without Savings?', balances)).toBeNull();
  expect(asksForDirectBalance('What are my account balances and types?')).toBe(false);
});

it('renders cash-flow metrics only for the requested period and account', () => {
  const question = 'What actually came in and went out last month?';
  expect(asksForDirectCashFlow(question)).toBe(true);
  const answer = renderCashFlow(question, JSON.stringify(flow()), { now, accounts })!;
  expect(answer).toContain('Cash flow, 1 Aug 2026 to 31 Aug 2026');
  expect(answer).toContain('incoming credits: **AUD 200.00**');
  expect(answer).toContain('outgoing debits: **AUD 100.00**');
  expect(answer).toContain('net flow: **AUD 100.00**');
  expect(asksForDirectCashFlow('Show the largest incoming payment and next page.')).toBe(false);
  expect(asksForDirectCashFlow('What was my cash flow and which merchants drove it?')).toBe(false);
  const wrongWindow = flow();
  wrongWindow.date_range = { from: '2026-07-01', to: '2026-07-31' };
  expect(renderCashFlow(question, JSON.stringify(wrongWindow), { now, accounts })).toBeNull();
  const wrongAccount = flow();
  wrongAccount.filters.account_id = 1;
  expect(renderCashFlow(question, JSON.stringify(wrongAccount), { now, accounts })).toBeNull();
  expect(
    renderCashFlow(
      'What was the cash flow on my Everyday card last month?',
      JSON.stringify(flow()),
      { now, accounts },
    ),
  ).toBeNull();
  const wrongNet = flow();
  wrongNet.totals[0]!.net_flow.cents = 20000;
  expect(renderCashFlow(question, JSON.stringify(wrongNet), { now, accounts })).toBeNull();
});

it('reports missing coverage without claiming zero cash flow', () => {
  const data = flow();
  data.coverage.overlap = null;
  const answer = renderCashFlow('What was my cash flow last month?', JSON.stringify(data), {
    now,
    accounts,
  })!;
  expect(answer).toContain('cash flow is unavailable');
  expect(answer).not.toContain('AUD 200.00');
});

it('resolves cash-flow windows without silently combining periods', () => {
  expect(requestedCashFlowWindow('Cash flow for August 2026?', now)).toEqual(august);
  expect(requestedCashFlowWindow('Cash flow for last month and July 2026?', now)).toBeNull();
  expect(requestedCashFlowWindow('Cash flow this month versus last month?', now)).toBeNull();
});
