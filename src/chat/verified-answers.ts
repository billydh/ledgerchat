import { z } from 'zod';
import { resolvePeriod, type DateWindow } from '../tools/period.js';
import { accountScope, hasUnsupportedExclusion, type NamedAccount } from './account-scope.js';
import { matchesAccountAndTransferScope } from './comparison.js';

const amount = z.strictObject({ cents: z.number().int().safe(), decimal: z.string() });
const range = z.strictObject({ from: z.iso.date(), to: z.iso.date() });
const currency = z.string().regex(/^[A-Z]{3}$/);
const balanceResult = z.object({
  account_count: z.number().int().nonnegative(),
  accounts: z.array(
    z.object({
      id: z.number().int().positive(),
      name: z.string(),
      currency,
      balance: z
        .object({
          current: amount,
          available: amount.nullable(),
          currency,
          as_of: z.iso.datetime(),
        })
        .nullable(),
    }),
  ),
});
const cashFlowResult = z.object({
  date_range: range,
  coverage: z.object({ overlap: range.nullable() }),
  filters: z.object({
    account_id: z.number().int().positive().nullable(),
    include_transfers: z.boolean(),
  }),
  pending_row_count: z.number().int().nonnegative(),
  totals: z.array(
    z.object({
      currency,
      incoming_credits: amount,
      outgoing_debits: amount,
      net_flow: amount,
    }),
  ),
});

function parse(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return null;
  }
}

function money(cents: number, code: string): string {
  return `${code} ${(cents / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function date(value: string): string {
  return new Intl.DateTimeFormat('en-AU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${value.slice(0, 10)}T00:00:00Z`));
}

function label(window: DateWindow): string {
  return `${date(window.from)} to ${date(window.to)}`;
}

function plain(value: string): string {
  return value
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[\\`*_<>]/g, '\\$&')
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]');
}

export function asksForDirectBalance(question: string): boolean {
  const remaining = question.replace(
    /\b(?:current\s+and\s+available|available\s+and\s+current)\b/gi,
    ' ',
  );
  return (
    /\bbalances?\b/i.test(question) &&
    !/\b(?:why|explain|reason|compar(?:e|ed|ing|ison)|versus|vs\.?|difference|chang(?:e|ed)|history|trend|spend|spent|spending|expense|transactions?|cash\s*flow|recurring|upcoming)\b/i.test(
      question,
    ) &&
    !/\b(?:and|also|plus|then)\b|;/i.test(remaining)
  );
}

/** App-rendered account-to-amount mapping for direct balance questions. */
export function renderBalances(question: string, content: string): string | null {
  if (!asksForDirectBalance(question)) return null;
  if (hasUnsupportedExclusion(question)) return null;
  const parsed = balanceResult.safeParse(parse(content));
  if (!parsed.success) return null;
  const data = parsed.data;
  if (data.account_count !== data.accounts.length) return null;
  const selection = accountScope(question, data.accounts);
  if (selection.ambiguous || (selection.all && selection.ids.length)) return null;
  const accounts = selection.ids.length
    ? data.accounts.filter((account) => selection.ids.includes(account.id))
    : data.accounts;
  if (selection.ids.length && accounts.length !== selection.ids.length) return null;
  if (!accounts.length) return 'No accounts have been imported.';
  const available = /\bavailable\b/i.test(question);
  const current = !available || /\bcurrent\b/i.test(question);
  const lines = ['**Latest imported account balances**'];
  for (const account of accounts) {
    const name = plain(account.name);
    if (!account.balance) {
      lines.push(`- ${name}: no imported balance is available.`);
      continue;
    }
    const balance = account.balance;
    if (balance.currency !== account.currency) return null;
    const parts: string[] = [];
    if (current) parts.push(`current **${money(balance.current.cents, balance.currency)}**`);
    if (available)
      parts.push(
        balance.available
          ? `available **${money(balance.available.cents, balance.currency)}**`
          : 'available balance not supplied',
      );
    lines.push(`- ${name}: ${parts.join('; ')} as of ${date(balance.as_of)}.`);
  }
  lines.push('These balances come from imported files and are not live bank balances.');
  return lines.join('\n');
}

export function asksForDirectCashFlow(question: string): boolean {
  const incoming = /\b(?:came|coming)\s+in\b|\bincoming\b/i.test(question);
  const outgoing = /\bwent\s+out\b|\boutgoing\b/i.test(question);
  const remaining = question.replace(
    /\b(?:came|coming)\s+in\s+and\s+went\s+out\b|\bincoming(?:\s+credits?)?\s+and\s+outgoing(?:\s+debits?)?\b/gi,
    ' ',
  );
  return (
    (/\bcash\s*flow\b|\bnet\s+flow\b/i.test(question) || (incoming && outgoing)) &&
    !/\b(?:why|explain|compar(?:e|ed|ing|ison)|versus|vs\.?|difference|chang(?:e|ed)|breakdown|transactions?|merchants?|categories?|by\s+month|by\s+account)\b/i.test(
      question,
    ) &&
    !/\b(?:and|also|plus|then)\b|;/i.test(remaining)
  );
}

export function requestedCashFlowWindow(question: string, now: Date): DateWindow | null {
  const presets = [
    [/\b(?:last|previous)\s+month\b/i, 'last_month'],
    [/\b(?:this|current)\s+month\b/i, 'this_month'],
    [/\blast\s+30\s+days?\b/i, 'last_30_days'],
    [/\b(?:year\s+to\s+date|ytd)\b/i, 'ytd'],
  ] as const;
  const found = presets.filter(([pattern]) => pattern.test(question));
  const named = [
    ...question.matchAll(
      /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})\b/gi,
    ),
  ];
  const iso = [...question.matchAll(/\b20\d{2}-\d{2}-\d{2}\b/g)].map((match) => match[0]);
  if (named.length > 1 || (named.length > 0 && iso.length > 0)) return null;
  if (found.length === 1 && !named.length && !iso.length) return resolvePeriod(found[0]![1], now);
  if (found.length > 1) return null;
  if (found.length) return null;
  if (named.length === 1) {
    const month =
      [
        'january',
        'february',
        'march',
        'april',
        'may',
        'june',
        'july',
        'august',
        'september',
        'october',
        'november',
        'december',
      ].indexOf(named[0]![1]!.toLowerCase()) + 1;
    const year = Number(named[0]![2]);
    const prefix = `${year}-${String(month).padStart(2, '0')}`;
    return {
      from: `${prefix}-01`,
      to: `${prefix}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, '0')}`,
    };
  }
  if (
    iso.length === 2 &&
    z.iso.date().safeParse(iso[0]).success &&
    z.iso.date().safeParse(iso[1]).success &&
    iso[0]! <= iso[1]!
  )
    return { from: iso[0]!, to: iso[1]! };
  return null;
}

/** App-rendered metric-to-amount mapping for one validated cash-flow window. */
export function renderCashFlow(
  question: string,
  content: string,
  context: { now: Date; accounts: readonly NamedAccount[] },
): string | null {
  if (!asksForDirectCashFlow(question)) return null;
  const expected = requestedCashFlowWindow(question, context.now);
  if (!expected) return null;
  const parsed = cashFlowResult.safeParse(parse(content));
  if (!parsed.success) return null;
  const data = parsed.data;
  if (data.date_range.from !== expected.from || data.date_range.to !== expected.to) return null;
  if (!matchesAccountAndTransferScope(question, data.filters, context.accounts)) return null;
  const lines = [`**Cash flow, ${label(data.date_range)}**`];
  if (!data.coverage.overlap) {
    lines.push('No imported transactions overlap this period, so cash flow is unavailable.');
    return lines.join('\n');
  }
  if (!data.totals.length)
    lines.push('No posted transactions matched this period in the imported data.');
  for (const row of data.totals) {
    if (
      row.incoming_credits.cents < 0 ||
      row.outgoing_debits.cents < 0 ||
      row.incoming_credits.cents - row.outgoing_debits.cents !== row.net_flow.cents
    )
      return null;
    lines.push(
      `- ${row.currency} incoming credits: **${money(row.incoming_credits.cents, row.currency)}**`,
      `- ${row.currency} outgoing debits: **${money(row.outgoing_debits.cents, row.currency)}**`,
      `- ${row.currency} net flow: **${money(row.net_flow.cents, row.currency)}**`,
    );
  }
  if (data.pending_row_count) lines.push('Pending transactions are excluded from these totals.');
  lines.push('Based on posted transactions in imported files; complete history is not verified.');
  return lines.join('\n');
}
