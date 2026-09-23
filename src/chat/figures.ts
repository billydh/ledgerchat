/**
 * A narrow answer gate for monetary claims. Tool output gives money as
 * {cents, decimal} and comparisons as percentage_change. Only those typed
 * values count as evidence; arbitrary numbers in IDs, dates, descriptions,
 * user messages and earlier model answers do not.
 *
 * This checks the value and an explicit percentage direction, not whether the
 * model attached a figure to the right merchant, period or metric. Full
 * provenance needs structured fact references rendered by the application
 * rather than free-form model text.
 */
const MONEY_PREFIX =
  /(?<![\w])(?:A\$|US\$|NZ\$|C\$|[$£€¥]|\b(?:AUD|USD|GBP|EUR|NZD|CAD|JPY|SGD|CHF|INR|HKD|ZAR)\b)\s*([+-]?\d[\d,]*(?:\.\d+)?)/gi;
const MONEY_SUFFIX =
  /(?<![\w])([+-]?\d[\d,]*(?:\.\d+)?)\s*(?:AUD|USD|GBP|EUR|NZD|CAD|JPY|SGD|CHF|INR|HKD|ZAR|dollars?|cents?)\b/gi;
const PERCENT = /(?<![\w])([+-]?\d[\d,]*(?:\.\d+)?)\s*(?:%|percent(?:age)?(?: points?)?\b)/gi;
const CURRENCY_CODE = /\b(AUD|USD|GBP|EUR|NZD|CAD|JPY|SGD|CHF|INR|HKD|ZAR)\b/i;
const CODE_BEFORE = /\b(AUD|USD|GBP|EUR|NZD|CAD|JPY|SGD|CHF|INR|HKD|ZAR)\s*$/i;
const CODE_AFTER = /^\s*(AUD|USD|GBP|EUR|NZD|CAD|JPY|SGD|CHF|INR|HKD|ZAR)\b/i;
const DOLLAR_CURRENCIES = new Set(['AUD', 'USD', 'NZD', 'CAD', 'SGD', 'HKD']);
type MoneyEvidence = { value: number; currency?: string };

function toolFigures(results: readonly string[]) {
  const money: MoneyEvidence[] = [];
  const percentages: number[] = [];
  const visit = (value: unknown, inheritedCurrency?: string): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, inheritedCurrency);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    const fields = value as Record<string, unknown>;
    const currency =
      typeof fields.currency === 'string' ? fields.currency.toUpperCase() : inheritedCurrency;
    if (
      typeof fields.cents === 'number' &&
      typeof fields.decimal === 'string' &&
      /^-?\d+\.\d{2}$/.test(fields.decimal)
    ) {
      const figure: MoneyEvidence = { value: Math.abs(Number(fields.decimal)) };
      if (currency) figure.currency = currency;
      money.push(figure);
    }
    if (typeof fields.percentage_change === 'number' && Number.isFinite(fields.percentage_change))
      percentages.push(fields.percentage_change);
    for (const child of Object.values(fields)) visit(child, currency);
  };
  for (const content of results) {
    try {
      visit(JSON.parse(content) as unknown);
    } catch {
      // A malformed result cannot authorise a figure.
    }
  }
  return { money, percentages };
}

function statedCurrency(text: string): string | undefined {
  const code = CURRENCY_CODE.exec(text)?.[1];
  if (code) return code.toUpperCase();
  if (/A\$/i.test(text)) return 'AUD';
  if (/US\$/i.test(text)) return 'USD';
  if (/NZ\$/i.test(text)) return 'NZD';
  if (/C\$/i.test(text)) return 'CAD';
  if (text.includes('£')) return 'GBP';
  if (text.includes('€')) return 'EUR';
  if (text.includes('¥')) return 'JPY';
  return undefined;
}

function currencyNear(text: string, match: RegExpMatchArray): string | undefined {
  const direct = statedCurrency(match[0]);
  if (direct) return direct;
  const start = match.index ?? 0;
  const left = text.slice(Math.max(0, start - 8), start);
  const right = text.slice(start + match[0].length, start + match[0].length + 8);
  return (CODE_BEFORE.exec(left)?.[1] ?? CODE_AFTER.exec(right)?.[1])?.toUpperCase();
}

function matches(value: number, raw: string, candidates: readonly number[]): boolean {
  const decimals = raw.split('.')[1]?.length ?? 0;
  const tolerance = 0.5 * 10 ** -decimals + 1e-9;
  return candidates.some((candidate) => Math.abs(candidate - Math.abs(value)) < tolerance);
}

function percentageDirection(text: string, match: RegExpMatchArray): -1 | 1 | undefined {
  const raw = match[1]!;
  if (raw.startsWith('-')) return -1;
  if (raw.startsWith('+')) return 1;
  const start = match.index ?? 0;
  const before =
    text
      .slice(Math.max(0, start - 24), start)
      .split(/[.!?;\n]/)
      .at(-1) ?? '';
  const after =
    text.slice(start + match[0].length, start + match[0].length + 24).split(/[.!?;\n]/)[0] ?? '';
  const context = `${before} ${after}`;
  const up = /\b(?:increase|increased|rises?|rose|higher|more|up)\b/i.test(context);
  const down = /\b(?:decrease|decreased|falls?|fell|lower|less|down)\b/i.test(context);
  return up === down ? undefined : up ? 1 : -1;
}

/** Monetary and percentage claims unsupported by successful tool results in this request. */
export function unevidencedFigures(text: string, results: readonly string[]): string[] {
  const evidence = toolFigures(results);
  const missing = new Set<string>();
  for (const pattern of [MONEY_PREFIX, MONEY_SUFFIX]) {
    for (const match of text.matchAll(pattern)) {
      const raw = match[1]!;
      const value = Number(raw.replaceAll(',', ''));
      const currency = currencyNear(text, match);
      const dollarUnit = !currency && /[$]|\bdollars?\b/i.test(match[0]);
      const candidates = evidence.money
        .filter((item) =>
          currency
            ? item.currency === currency
            : !dollarUnit || (item.currency !== undefined && DOLLAR_CURRENCIES.has(item.currency)),
        )
        .map((item) => item.value);
      const inCents = /\bcents?\b/i.test(match[0]);
      if (!matches(value, raw, inCents ? candidates.map((amount) => amount * 100) : candidates))
        missing.add(match[0]);
    }
  }
  for (const match of text.matchAll(PERCENT)) {
    const raw = match[1]!;
    const value = Number(raw.replaceAll(',', ''));
    const direction = percentageDirection(text, match);
    const candidates = evidence.percentages
      .filter((candidate) => direction === undefined || Math.sign(candidate) === direction)
      .map(Math.abs);
    if (!matches(value, raw, candidates)) missing.add(match[0]);
  }
  return [...missing];
}
