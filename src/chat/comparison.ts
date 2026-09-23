import { z } from 'zod';
import { categoryOf } from '../ingest/taxonomy.js';
import { resolvePeriod } from '../tools/period.js';
import { accountScope, hasUnsupportedExclusion, type NamedAccount } from './account-scope.js';

const dateRange = z.strictObject({ from: z.iso.date(), to: z.iso.date() });
const coverage = z.object({ overlap: dateRange.nullable() });
const amount = z.strictObject({ cents: z.number().int().safe(), decimal: z.string() });
const currencyTotal = z.strictObject({ currency: z.string().regex(/^[A-Z]{3}$/), total: amount });
const comparedTotal = z.strictObject({
  currency: z.string().regex(/^[A-Z]{3}$/),
  primary_total: amount,
  comparison_total: amount,
  change: amount,
  percentage_change: z.number().nullable(),
  percentage_change_reason: z.string().nullable(),
});
const comparedGroup = comparedTotal.extend({ group: z.string() });
const resultSchema = z.object({
  basis: z.literal('posted_debits'),
  date_range: dateRange,
  coverage,
  totals: z.array(currencyTotal),
  filters: z.object({
    query: z.string().nullable(),
    category: z.string().nullable(),
    subcategory: z.string().nullable(),
    account_id: z.number().int().positive().nullable(),
    include_transfers: z.boolean(),
  }),
  pending_row_count: z.number().int().nonnegative(),
  comparison: z.object({
    date_range: dateRange,
    coverage,
    pending_row_count: z.number().int().nonnegative(),
    totals: z.array(comparedTotal),
    groups: z.array(comparedGroup).optional(),
  }),
});
const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const monthName =
  '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
type DateRange = z.infer<typeof dateRange>;
export interface ComparisonContext {
  descriptions: readonly string[];
  accounts: readonly NamedAccount[];
  now: Date;
  groupBy?: string;
}

/** Only straightforward spending comparisons use an application-rendered answer. */
export function asksForSpendingComparison(question: string): boolean {
  const topMerchants = asksForTopMerchants(question);
  const remaining = topMerchants
    ? question.replace(
        /\b(?:and|also|plus|then)\s+(?:list|show|name|rank)\s+(?:the\s+)?(?:top\s+)?(?:\d+\s+)?merchants?\b/gi,
        ' ',
      )
    : question;
  if (
    /\b(?:why|drove|drivers?|breakdown)\b|\bbreak\s+down\b|\bby\s+(?:category|subcategory|account)\b/i.test(
      question,
    )
  )
    return false;
  if (
    /\bby\s+merchant\b|(?:\b(?:and|also|plus|then)\b|;)\s+(?:list|show|tell|explain|identify|find|give|provide|name|rank|which|what|how|break\s+down)\b|\b(?:top|largest|biggest)\s+(?:\d+\s+)?(?:categories?|transactions?)\b/i.test(
      remaining,
    )
  )
    return false;
  return (
    /\b(?:spend|spends|spent|spending|expense|expenses|cost|costs|dining|grocer(?:y|ies)|shopping|food|fuel|transport|housing|rent|utilities|travel|entertainment|health)\b/i.test(
      question,
    ) &&
    /\b(?:compar(?:e|ed|ing|ison)|versus|vs\.?|between|chang(?:e|ed)|difference|more|less|increase|decrease|higher|lower)\b/i.test(
      question,
    )
  );
}

function asksForTopMerchants(question: string): boolean {
  return /\b(?:top|largest|biggest)\s+(?:\d+\s+)?merchants?\b|\b(?:list|show|name|rank)\s+(?:the\s+)?(?:top\s+)?merchants?\b/i.test(
    question,
  );
}

function label(range: z.infer<typeof dateRange>): string {
  const format = (day: string) =>
    new Intl.DateTimeFormat('en-AU', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(`${day}T00:00:00Z`));
  return `${format(range.from)} to ${format(range.to)}`;
}

function money(cents: number, currency: string): string {
  return `${currency} ${(cents / 100).toLocaleString('en-AU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function plainLabel(value: string): string {
  return value
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[\\`*_<>]/g, '\\$&')
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]');
}

function scope(filters: z.infer<typeof resultSchema>['filters']): string {
  const parts: string[] = [];
  const key = filters.subcategory ?? filters.category;
  const label = key
    ? key === 'food_drink'
      ? 'Food and drink'
      : key === 'health_wellbeing'
        ? 'Health and wellbeing'
        : key === 'savings_investments'
          ? 'Savings and investments'
          : `${key[0]!.toUpperCase()}${key.slice(1).replaceAll('_', ' ')}`
    : null;
  if (filters.category && filters.subcategory)
    parts.push(`category ${plainLabel(filters.category.replaceAll('_', ' '))}`);
  if (filters.query)
    parts.push(`description containing ${plainLabel(JSON.stringify(filters.query))}`);
  if (filters.account_id) parts.push(`account ${String(filters.account_id)}`);
  if (filters.include_transfers) parts.push('including internal transfers');
  const title = label ? `${plainLabel(label)} spending` : 'Spending';
  return parts.length ? `${title} (${parts.join('; ')})` : title;
}

function matchesNamedScope(question: string, filters: z.infer<typeof resultSchema>['filters']) {
  // Match longer taxonomy phrases first and remove them before matching their
  // constituent words (e.g. "public transport" and "health and wellbeing").
  const multiwordParents = [
    [/\bfood\s*(?:and|&)\s*drink\b/i, 'food_drink'],
    [/\bhealth\s*(?:and|&)\s*wellbeing\b/i, 'health_wellbeing'],
    [/\bfinancial\s+costs\b/i, 'financial_costs'],
    [/\bsavings\s*(?:and|&)\s*investments\b/i, 'savings_investments'],
  ] as const;
  const leaf = [
    [/\b(?:grocer(?:y|ies)|supermarkets?)\b/i, 'groceries'],
    [/\b(?:dining|restaurants?|cafes?|takeaway)\b/i, 'dining'],
    [/\bpublic\s+transport\b/i, 'public_transport'],
    [/\b(?:fuel|petrol)\b/i, 'fuel'],
    [/\bvehicle\s+(?:maintenance|repairs?)\b/i, 'vehicle_maintenance'],
    [/\brent\b/i, 'rent'],
    [/\bmortgage\b/i, 'mortgage'],
    [/\bhome\s+(?:maintenance|repairs?)\b/i, 'home_maintenance'],
    [/\b(?:utilities|electricity)\b/i, 'utilities'],
    [/\binsurance\s+premiums?\b/i, 'insurance_premiums'],
    [/\b(?:health|medical|dental|pharmacy)\b/i, 'health'],
    [/\b(?:fitness|gyms?)\b/i, 'fitness'],
    [/\bpersonal\s+care\b/i, 'personal_care'],
    [/\bentertainment\b/i, 'entertainment'],
    [/\bshopping\b/i, 'shopping'],
    [/\btravel\b/i, 'travel'],
    [/\b(?:tuition|courses?)\b/i, 'tuition_courses'],
    [/\bgifts?\b/i, 'gifts'],
    [/\bdonations?\b/i, 'donations'],
    [/\bbank\s+fees?\b/i, 'bank_fees'],
    [/\binterest\s+charged\b/i, 'interest_charged'],
    [/\btax\b/i, 'tax'],
    [/\bloan\s+repayments?\b/i, 'loan_repayment'],
    [/\bsavings?\b/i, 'savings'],
    [/\binvestments?\b/i, 'investments'],
    [/\bcash\s+(?:movement|withdrawals?)\b/i, 'cash_movement'],
  ] as const;
  const singlewordParents = [
    [/\bfood\b/i, 'food_drink'],
    [/\btransport\b/i, 'transport'],
    [/\bhousing\b/i, 'housing'],
    [/\binsurance\b/i, 'insurance'],
    [/\blifestyle\b/i, 'lifestyle'],
    [/\beducation\b/i, 'education'],
    [/\bgiving\b/i, 'giving'],
    [/\bincome\b/i, 'income'],
    [/\bcash\b/i, 'cash'],
    [/\buncategorised\b/i, 'uncategorised'],
  ] as const;
  let remaining = question;
  const parents: string[] = [];
  for (const [pattern, expected] of multiwordParents) {
    if (pattern.test(remaining)) {
      parents.push(expected);
      remaining = remaining.replace(pattern, ' ');
    }
  }
  const leaves: string[] = [];
  for (const [pattern, expected] of leaf) {
    if (pattern.test(remaining)) {
      leaves.push(expected);
      remaining = remaining.replace(pattern, ' ');
    }
  }
  for (const [pattern, expected] of singlewordParents)
    if (pattern.test(remaining)) parents.push(expected);
  if (leaves.length > 1 || parents.length > 1) return false;
  if (leaves.length && parents.length && categoryOf(leaves[0]) !== parents[0]) return false;
  if (leaves.length && filters.subcategory !== leaves[0]) return false;
  if (parents.length && filters.category !== parents[0]) return false;
  if (!leaves.length && filters.subcategory) return false;
  if (
    !parents.length &&
    filters.category &&
    (!leaves.length || categoryOf(leaves[0]) !== filters.category)
  )
    return false;
  return true;
}

const genericDescriptionWords = new Set([
  ...months,
  'january',
  'february',
  'march',
  'april',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
  'food',
  'drink',
  'dining',
  'grocery',
  'groceries',
  'shopping',
  'fuel',
  'petrol',
  'transport',
  'housing',
  'rent',
  'mortgage',
  'utilities',
  'travel',
  'entertainment',
  'health',
  'fitness',
  'insurance',
  'education',
  'savings',
  'investments',
  'cash',
  'spending',
  'spent',
  'compare',
  'expenses',
  'expense',
  'cost',
  'costs',
  'total',
  'overall',
  'monthly',
  'weekly',
  'annual',
  'yearly',
  'my',
  'the',
  'and',
  'other',
  'card',
  'eftpos',
  'online',
  'payment',
  'purchase',
  'debit',
  'credit',
  'transfer',
  'account',
  'accounts',
  'supermarket',
  'supermarkets',
  'restaurant',
  'restaurants',
  'cafe',
  'cafes',
  'takeaway',
  'public',
  'vehicle',
  'home',
  'electricity',
  'medical',
  'dental',
  'pharmacy',
  'gym',
  'gyms',
  'personal',
  'care',
  'tuition',
  'course',
  'courses',
  'gift',
  'gifts',
  'donation',
  'donations',
  'interest',
  'tax',
  'loan',
  'repayment',
  'repayments',
  'fees',
]);

function normaliseWords(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function withoutNamedAccount(question: string, accounts: readonly NamedAccount[]): string {
  const selection = accountScope(question, accounts);
  if (selection.ids.length !== 1) return question;
  const account = accounts.find((item) => item.id === selection.ids[0]);
  if (!account) return question;
  const name = account.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return question
    .replace(new RegExp(`\\b(?:on|in|from|for)\\s+(?:my\\s+)?${name}\\b`, 'gi'), ' ')
    .replace(new RegExp(`\\b${name}\\s+(?:account|card)\\b`, 'gi'), ' ')
    .replace(new RegExp(`\\bmy\\s+${name}(?=\\s+(?:spending|balance))`, 'gi'), ' ');
}

/** A named description must be present in the query filter, not just the tool's grouping. */
function matchesMerchantScope(
  question: string,
  filters: z.infer<typeof resultSchema>['filters'],
  descriptions: readonly string[],
): boolean {
  const words = ` ${normaliseWords(question)} `;
  const query = filters.query ? normaliseWords(filters.query) : '';
  if (query && !words.includes(` ${query} `)) return false;
  const mentioned = new Set<string>();
  for (const description of descriptions) {
    for (const word of normaliseWords(description).split(' '))
      if (word.length >= 4 && !genericDescriptionWords.has(word) && words.includes(` ${word} `))
        mentioned.add(word);
  }
  // Also cover a merchant that has no matching transactions yet.
  const possessive = /\bmy\s+([a-z][a-z0-9&' -]{1,50}?)\s+spending\b/i.exec(question);
  if (possessive) {
    const candidate = normaliseWords(possessive[1]!);
    if (
      candidate &&
      !candidate.endsWith(' account') &&
      candidate.split(' ').every((word) => !genericDescriptionWords.has(word))
    )
      mentioned.add(candidate);
  }
  const named = /\b([A-Z][A-Za-z0-9&'-]{3,})\s+spending\b/.exec(question)?.[1];
  if (named && !genericDescriptionWords.has(named.toLowerCase()))
    mentioned.add(normaliseWords(named));
  if (query && !mentioned.size) return false;
  return [...mentioned].every((name) => query.includes(name));
}

export function matchesAccountAndTransferScope(
  question: string,
  filters: { account_id: number | null; include_transfers: boolean },
  accounts: ComparisonContext['accounts'],
): boolean {
  if (hasUnsupportedExclusion(question)) return false;
  const selection = accountScope(question, accounts);
  if (selection.ambiguous || selection.ids.length > 1 || (selection.all && selection.ids.length))
    return false;
  if (filters.account_id !== (selection.ids[0] ?? null)) return false;

  const include =
    /\b(?:include|including|with|count)\s+(?:(?:internal|bank)\s+)?transfers?\b/i.test(question);
  const exclude =
    /\b(?:exclude|excluding|without|ignore)\s+(?:(?:internal|bank)\s+)?transfers?\b/i.test(
      question,
    );
  if (include && exclude) return false;
  if (/\btransfers?\b/i.test(question) && !include && !exclude) return false;
  return filters.include_transfers === include;
}

function matchesNamedMonths(
  question: string,
  primary: DateRange,
  comparison: DateRange,
  now: Date,
): boolean {
  const thisMonth = /\b(?:this|current)\s+month\b/i.test(question);
  const lastMonth = /\b(?:last|previous)\s+month\b/i.test(question);
  const monthPattern =
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b(?:\s+(20\d{2}))?/gi;
  const named = [...question.matchAll(monthPattern)];
  const monthWindow = (month: number, statedYear?: string): DateRange => {
    const currentMonth = now.getUTCMonth() + 1;
    const year = statedYear
      ? Number(statedYear)
      : now.getUTCFullYear() - (month > currentMonth ? 1 : 0);
    const prefix = `${String(year)}-${String(month).padStart(2, '0')}`;
    const lastDay = String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, '0');
    return {
      from: `${prefix}-01`,
      to:
        !statedYear && month === currentMonth
          ? now.toISOString().slice(0, 10)
          : `${prefix}-${lastDay}`,
    };
  };
  if (thisMonth && lastMonth && !/\b(?:so\s+far|same\s+(?:number\s+of\s+)?days?)\b/i.test(question))
    return sameRanges(
      [resolvePeriod('this_month', now), resolvePeriod('last_month', now)],
      [primary, comparison],
    );
  if ((thisMonth || lastMonth) && named.length === 1 && explicitDateRanges(question) === null) {
    const namedMonth = months.indexOf(named[0]![1]!.slice(0, 3).toLowerCase()) + 1;
    const fullMonth = monthWindow(namedMonth, named[0]![2]);
    return sameRanges(
      [resolvePeriod(thisMonth ? 'this_month' : 'last_month', now), fullMonth],
      [primary, comparison],
    );
  }
  if (
    /\b(?:this|current|last|previous)\s+(?:month|year|\d+\s+days?)\b|\b(?:year\s+to\s+date|ytd|today|yesterday)\b/i.test(
      question,
    )
  )
    return false;
  const exact = explicitDateRanges(question);
  if (exact === 'unparsed') return false;
  if (exact) return sameRanges(exact, [primary, comparison]);
  if (named.length > 2) return false;
  if (named.length < 2) return false;
  const years = [...question.matchAll(/\b20\d{2}\b/g)].map((match) => match[0]);
  const sharedYear = years.length === 1 ? years[0] : undefined;
  const expected = named.map((match) => {
    const month = months.indexOf(match[1]!.slice(0, 3).toLowerCase()) + 1;
    return rangeKey(monthWindow(month, match[2] ?? sharedYear));
  });
  return expected.sort().join('|') === [primary, comparison].map(rangeKey).sort().join('|');
}

function rangeKey(range: DateRange): string {
  return `${range.from}/${range.to}`;
}

function sameRanges(expected: DateRange[], actual: DateRange[]): boolean {
  return expected.map(rangeKey).sort().join('|') === actual.map(rangeKey).sort().join('|');
}

function date(year: string, month: string, day: string): string | null {
  const monthNumber = months.indexOf(month.slice(0, 3).toLowerCase()) + 1;
  const candidate = `${year}-${String(monthNumber).padStart(2, '0')}-${day.padStart(2, '0')}`;
  return z.iso.date().safeParse(candidate).success ? candidate : null;
}

function explicitDateRanges(question: string): DateRange[] | 'unparsed' | null {
  const years = [...question.matchAll(/\b20\d{2}\b/g)].map((match) => match[0]);
  const sharedYear = new Set(years).size === 1 ? years[0] : undefined;
  const iso = [...question.matchAll(/\b20\d{2}-\d{2}-\d{2}\b/g)].map((match) => match[0]);
  if (iso.length) {
    if (iso.length !== 4 || iso.some((value) => !z.iso.date().safeParse(value).success))
      return 'unparsed';
    return [
      { from: iso[0]!, to: iso[1]! },
      { from: iso[2]!, to: iso[3]! },
    ];
  }
  // Slash dates are locale-ambiguous, so never silently accept a tool window
  // that may have interpreted day and month in the opposite order.
  if (/\b\d{1,2}\/\d{1,2}\/20\d{2}\b/.test(question)) return 'unparsed';
  const spans = [
    ...question.matchAll(
      new RegExp(
        `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*[-–—]\\s*(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthName})\\b(?:\\s*,?\\s*(20\\d{2}))?`,
        'gi',
      ),
    ),
  ];
  if (spans.length) {
    if (spans.length !== 2) return 'unparsed';
    const ranges = spans.map((match) => {
      const year = match[4] ?? sharedYear;
      if (!year) return null;
      const from = date(year, match[3]!, match[1]!);
      const to = date(year, match[3]!, match[2]!);
      return from && to && from <= to ? { from, to } : null;
    });
    return ranges.every((range) => range !== null) ? ranges : 'unparsed';
  }
  const monthFirstSpans = [
    ...question.matchAll(
      new RegExp(
        `\\b(${monthName})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*[-–—]\\s*(\\d{1,2})(?:st|nd|rd|th)?\\b(?:\\s*,?\\s*(20\\d{2}))?`,
        'gi',
      ),
    ),
  ];
  if (monthFirstSpans.length) {
    if (monthFirstSpans.length !== 2) return 'unparsed';
    const ranges = monthFirstSpans.map((match) => {
      const year = match[4] ?? sharedYear;
      if (!year) return null;
      const from = date(year, match[1]!, match[2]!);
      const to = date(year, match[1]!, match[3]!);
      return from && to && from <= to ? { from, to } : null;
    });
    return ranges.every((range) => range !== null) ? ranges : 'unparsed';
  }
  const dayMonth = [
    ...question.matchAll(
      new RegExp(
        `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthName})\\b(?:\\s*,?\\s*(20\\d{2}))?`,
        'gi',
      ),
    ),
  ];
  const monthDay = [
    ...question.matchAll(
      new RegExp(
        `\\b(${monthName})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:\\s*,?\\s*(20\\d{2}))?`,
        'gi',
      ),
    ),
  ];
  const matches = dayMonth.length ? dayMonth : monthDay;
  if (!matches.length) return null;
  if (matches.length !== 4 || (dayMonth.length > 0 && monthDay.length > 0)) return 'unparsed';
  const ranges: DateRange[] = [];
  for (let i = 0; i < 4; i += 2) {
    const first = matches[i]!,
      second = matches[i + 1]!;
    const firstYear = first[3],
      secondYear = second[3];
    if (firstYear && secondYear && firstYear !== secondYear) return 'unparsed';
    const year = firstYear ?? secondYear ?? sharedYear;
    if (!year) return 'unparsed';
    const from = dayMonth.length
      ? date(year, first[2]!, first[1]!)
      : date(year, first[1]!, first[2]!);
    const to = dayMonth.length
      ? date(year, second[2]!, second[1]!)
      : date(year, second[1]!, second[2]!);
    if (!from || !to || from > to) return 'unparsed';
    ranges.push({ from, to });
  }
  return ranges;
}

/**
 * The model chooses the tool arguments. Every amount, period label and change
 * below comes from one successful comparison result, never its final prose.
 */
export function renderSpendingComparison(
  question: string,
  content: string,
  context: ComparisonContext,
): string | null {
  if (!asksForSpendingComparison(question)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(content) as unknown;
  } catch {
    return null;
  }
  const parsed = resultSchema.safeParse(raw);
  if (!parsed.success) return null;
  const data = parsed.data;
  const topMerchants = asksForTopMerchants(question);
  if (topMerchants && (context.groupBy !== 'merchant' || !data.comparison.groups)) return null;
  const primary = data.date_range;
  const comparison = data.comparison.date_range;
  if (primary.from > primary.to || comparison.from > comparison.to) return null;
  const scopedQuestion = withoutNamedAccount(question, context.accounts);
  if (!matchesNamedScope(scopedQuestion, data.filters)) return null;
  if (!matchesMerchantScope(scopedQuestion, data.filters, context.descriptions)) return null;
  if (!matchesAccountAndTransferScope(question, data.filters, context.accounts)) return null;
  if (!matchesNamedMonths(question, primary, comparison, context.now)) return null;
  // For separate windows, show change toward the later one regardless of the
  // model's primary/comparison order. For overlapping windows, retain the
  // tool's primary versus comparison orientation.
  const primaryBeforeComparison = primary.to < comparison.from;
  const baseline = primaryBeforeComparison ? primary : comparison;
  const target = primaryBeforeComparison ? comparison : primary;
  const baselineLabel = label(baseline);
  const targetLabel = label(target);
  const lines = [`**${scope(data.filters)} comparison**`];
  const unavailable = [
    ...(!data.coverage.overlap ? [label(primary)] : []),
    ...(!data.comparison.coverage.overlap ? [label(comparison)] : []),
  ];
  if (unavailable.length) {
    lines.push(
      `No imported transactions overlap ${unavailable.join(' or ')}. A spending comparison for these periods is unavailable.`,
    );
    return lines.join('\n');
  }
  if (!data.comparison.totals.length) {
    lines.push(
      `No matching posted debits were found in the imported data for ${targetLabel} or ${baselineLabel}.`,
    );
  } else {
    const primaryByCurrency = new Map(data.totals.map((row) => [row.currency, row.total.cents]));
    for (const row of data.comparison.totals) {
      if ((primaryByCurrency.get(row.currency) ?? 0) !== row.primary_total.cents) return null;
      if (row.primary_total.cents - row.comparison_total.cents !== row.change.cents) return null;
      const baselineCents = primaryBeforeComparison
        ? row.primary_total.cents
        : row.comparison_total.cents;
      const targetCents = primaryBeforeComparison
        ? row.comparison_total.cents
        : row.primary_total.cents;
      const delta = targetCents - baselineCents;
      lines.push(
        `- ${targetLabel}: **${money(targetCents, row.currency)}**`,
        `- ${baselineLabel}: **${money(baselineCents, row.currency)}**`,
        delta === 0
          ? '- Change: **no change**.'
          : `- Change: **${money(Math.abs(delta), row.currency)} ${delta > 0 ? 'more' : 'less'}** in ${targetLabel}.`,
      );
      if (/(?:%|\bpercent(?:age)?\b)/i.test(question)) {
        lines.push(
          baselineCents === 0
            ? '- Percentage change is unavailable because the comparison total was zero.'
            : `- Percentage change: **${(Math.abs(delta / baselineCents) * 100).toLocaleString('en-AU', { maximumFractionDigits: 2 })}% ${delta > 0 ? 'increase' : delta < 0 ? 'decrease' : 'change'}**.`,
        );
      }
    }
  }
  if (topMerchants) {
    const limit = Math.min(
      10,
      Math.max(1, Number(/\btop\s+(\d+)\s+merchants?\b/i.exec(question)?.[1] ?? 5)),
    );
    const grouped = new Map<string, { group: string; cents: number }[]>();
    const primarySums = new Map<string, number>();
    const comparisonSums = new Map<string, number>();
    for (const row of data.comparison.groups ?? []) {
      const primaryCents = row.primary_total.cents;
      const comparisonCents = row.comparison_total.cents;
      if (primaryCents - comparisonCents !== row.change.cents) return null;
      primarySums.set(row.currency, (primarySums.get(row.currency) ?? 0) + primaryCents);
      comparisonSums.set(row.currency, (comparisonSums.get(row.currency) ?? 0) + comparisonCents);
      const cents = primaryBeforeComparison ? comparisonCents : primaryCents;
      if (cents <= 0) continue;
      const entries = grouped.get(row.currency) ?? [];
      entries.push({ group: row.group, cents });
      grouped.set(row.currency, entries);
    }
    for (const row of data.comparison.totals)
      if (
        (primarySums.get(row.currency) ?? 0) !== row.primary_total.cents ||
        (comparisonSums.get(row.currency) ?? 0) !== row.comparison_total.cents
      )
        return null;
    for (const [currency, entries] of grouped) {
      lines.push(`Top merchant descriptions in ${targetLabel} (${currency}):`);
      for (const entry of entries.sort((a, b) => b.cents - a.cents).slice(0, limit))
        lines.push(`- ${plainLabel(entry.group)}: **${money(entry.cents, currency)}**`);
    }
    if (!grouped.size)
      lines.push(`No merchant descriptions had posted spending in ${targetLabel}.`);
  }
  lines.push(
    'Based on posted debits in the imported data; the stored transaction extent does not prove complete history.',
  );
  if (data.pending_row_count || data.comparison.pending_row_count)
    lines.push('Pending transactions are excluded from these totals.');
  return lines.join('\n');
}
