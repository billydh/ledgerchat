/**
 * Column auto-detection for a CSV export. Every bank lays its export out
 * differently, so nothing here trusts the header alone: each role is scored
 * from the header name and from what the values actually parse as, and the
 * result carries a confidence per role so the UI can ask when it is unsure.
 * Anything the caller knows better is applied on top as an override.
 */

import type { CsvTable } from './csv.js';
import { DATE_FORMATS, dateFormatsOf, parseAmount, parseDate, type DateFormat } from './values.js';

export type SignConvention = 'spend_negative' | 'spend_positive';

export type AmountColumns =
  { kind: 'signed'; column: number } | { kind: 'split'; debit: number; credit: number };

/** Column indexes are 0-based positions in `CsvTable.columns`. */
export interface ColumnMapping {
  date: number;
  dateFormat: DateFormat;
  amount: AmountColumns;
  /** How a signed amount column encodes money out. Ignored for a debit/credit pair. */
  sign: SignConvention;
  description: number;
  /** A second free-text column appended to the description, if any. */
  memo?: number;
  balance?: number;
  /** A column whose value marks a row pending, if any. */
  status?: number;
}

export type MappingRole = 'date' | 'amount' | 'sign' | 'description' | 'balance';

export interface DetectedMapping {
  mapping: ColumnMapping;
  /** 0 to 1 per role; a role that was not found scores 0. */
  confidence: Record<MappingRole, number>;
  /**
   * True when every date in the file parses as both DD/MM and MM/DD, so the
   * chosen format is a default rather than a finding and the UI should ask.
   */
  ambiguousDate: boolean;
}

export class MappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MappingError';
  }
}

const HEADER = {
  date: /\b(date|posted|when|day)\b/i,
  amount: /\b(amount|value|sum|total)\b/i,
  debit: /\b(debit|withdrawal|withdrawals|money out|out|spent|paid out|dr)\b/i,
  credit: /\b(credit|deposit|deposits|money in|in|received|paid in|cr)\b/i,
  balance: /\bbalance\b/i,
  description: /\b(description|narrative|details|transaction|particulars|payee|merchant|name)\b/i,
  memo: /\b(memo|reference|details|notes?|extra|particulars|category)\b/i,
  status: /\b(status|state)\b/i,
  spendPositive: /\b(spent|spend|debit amount|withdrawal)\b/i,
} as const;

/** Descriptions that are near-certainly purchases, used to read the sign convention. */
const PURCHASE =
  /\b(purchase|eftpos|visa|mastercard|card|pos|paypal|woolworths|coles|aldi|uber|amazon|kmart|bunnings|mcdonald|cafe|coffee|petrol|bp|shell|7-eleven|netflix|spotify|apple\.com|google)\b/i;

const PENDING = /\b(pending|uncleared|unposted|authori[sz]ed|processing)\b/i;

function cellsOf(table: CsvTable, column: number): string[] {
  return table.rows.map((row) => row.cells[column]?.trim() ?? '');
}

function nonEmpty(values: string[]): string[] {
  return values.filter((v) => v !== '');
}

function ratio(hits: number, total: number): number {
  return total === 0 ? 0 : hits / total;
}

interface ColumnProfile {
  index: number;
  name: string;
  values: string[];
  filled: number;
  /** Fraction of filled cells that parse as an amount. */
  amountRatio: number;
  /** Numeric enough to be an amount column: a couple of bad cells are tolerated. */
  numeric: boolean;
  /** Best date format and the fraction of filled cells it parses. */
  date: { format: DateFormat; ratio: number; ambiguous: boolean } | undefined;
  meanLength: number;
}

function profile(table: CsvTable, index: number): ColumnProfile {
  const values = cellsOf(table, index);
  const filled = nonEmpty(values);
  const amountHits = filled.filter((v) => parseAmount(v) !== undefined).length;
  const amountRatio = ratio(amountHits, filled.length);
  const numeric =
    amountHits > 0 && amountHits >= filled.length - Math.max(2, Math.floor(filled.length * 0.2));
  const meanLength = filled.reduce((sum, v) => sum + v.length, 0) / (filled.length || 1);
  return {
    index,
    name: table.columns[index] ?? `Column ${String(index + 1)}`,
    values,
    filled: filled.length,
    amountRatio,
    numeric,
    date: dateProfile(filled),
    meanLength,
  };
}

/**
 * The format that parses the most cells wins. When DD/MM and MM/DD tie on a
 * whole file, no cell had a day above 12 and the file cannot say which it is:
 * DD/MM/YYYY is chosen (the format most exports outside the US use) and the
 * ambiguity is reported.
 */
function dateProfile(filled: string[]) {
  if (!filled.length) return undefined;
  const hits = new Map<DateFormat, number>(DATE_FORMATS.map((f) => [f, 0]));
  for (const cell of filled) for (const f of dateFormatsOf(cell)) hits.set(f, hits.get(f)! + 1);
  let best: DateFormat = 'YYYY-MM-DD';
  for (const f of DATE_FORMATS) if (hits.get(f)! > hits.get(best)!) best = f;
  const bestHits = hits.get(best)!;
  if (bestHits === 0) return undefined;
  const ambiguous =
    (best === 'DD/MM/YYYY' || best === 'MM/DD/YYYY') &&
    hits.get('DD/MM/YYYY') === hits.get('MM/DD/YYYY');
  return {
    format: ambiguous ? ('DD/MM/YYYY' as const) : best,
    ratio: bestHits / filled.length,
    ambiguous,
  };
}

/**
 * Detects the mapping for a parsed table. Throws `MappingError` only when no
 * column at all could serve as the date, amount or description; a weak guess
 * is returned with a low confidence rather than refused.
 */
export function detectMapping(table: CsvTable): DetectedMapping {
  if (!table.rows.length) throw new MappingError('The file has no data rows.');
  const profiles = table.columns.map((_, i) => profile(table, i));
  const taken = new Set<number>();
  const confidence: Record<MappingRole, number> = {
    date: 0,
    amount: 0,
    sign: 0,
    description: 0,
    balance: 0,
  };

  // Date: the column where the most values parse as a date, header as a tiebreak.
  const dateCandidates = profiles
    .filter((p) => p.date && p.date.ratio >= 0.5)
    .sort(
      (a, b) =>
        b.date!.ratio - a.date!.ratio ||
        Number(HEADER.date.test(b.name)) - Number(HEADER.date.test(a.name)) ||
        a.index - b.index,
    );
  const dateColumn = dateCandidates[0];
  if (!dateColumn) throw new MappingError('No column contains recognisable dates.');
  taken.add(dateColumn.index);
  confidence.date = Math.min(
    1,
    dateColumn.date!.ratio * (HEADER.date.test(dateColumn.name) ? 1 : 0.85),
  );

  // Numeric columns, excluding the date and anything that reads as a date.
  const numeric = profiles.filter(
    (p) => !taken.has(p.index) && p.numeric && !(p.date && p.date.ratio > p.amountRatio),
  );

  // Balance: a numeric column named like one. Never guessed from values alone.
  const balanceColumn = numeric.find((p) => HEADER.balance.test(p.name));
  if (balanceColumn) {
    taken.add(balanceColumn.index);
    confidence.balance = balanceColumn.amountRatio;
  }
  const amountPool = numeric.filter((p) => !taken.has(p.index));

  const amount = detectAmount(amountPool, table.rows.length);
  if (!amount) throw new MappingError('No column contains recognisable amounts.');
  confidence.amount = amount.confidence;
  if (amount.columns.kind === 'signed') taken.add(amount.columns.column);
  else {
    taken.add(amount.columns.debit);
    taken.add(amount.columns.credit);
  }

  // Description: the longest free-text column; header hint as a tiebreak.
  const text = profiles.filter(
    (p) =>
      !taken.has(p.index) &&
      p.filled > 0 &&
      p.amountRatio < 0.5 &&
      !(p.date && p.date.ratio >= 0.5),
  );
  const status = text.find(
    (p) => HEADER.status.test(p.name) && p.values.some((v) => PENDING.test(v)),
  );
  if (status) taken.add(status.index);
  const textPool = text.filter((p) => !taken.has(p.index));
  const descriptionColumn = [...textPool].sort(
    (a, b) =>
      Number(HEADER.description.test(b.name)) - Number(HEADER.description.test(a.name)) ||
      b.meanLength - a.meanLength ||
      a.index - b.index,
  )[0];
  if (!descriptionColumn) throw new MappingError('No column contains descriptions.');
  taken.add(descriptionColumn.index);
  confidence.description = HEADER.description.test(descriptionColumn.name)
    ? 0.95
    : textPool.length === 1
      ? 0.8
      : 0.6;
  const memoColumn = textPool.find(
    (p) => !taken.has(p.index) && HEADER.memo.test(p.name) && p.filled > 0,
  );
  if (memoColumn) taken.add(memoColumn.index);

  const sign = detectSign(amount.columns, profiles, descriptionColumn);
  confidence.sign = amount.columns.kind === 'split' ? 1 : sign.confidence;

  const mapping: ColumnMapping = {
    date: dateColumn.index,
    dateFormat: dateColumn.date!.format,
    amount: amount.columns,
    sign: sign.convention,
    description: descriptionColumn.index,
    ...(memoColumn ? { memo: memoColumn.index } : {}),
    ...(balanceColumn ? { balance: balanceColumn.index } : {}),
    ...(status ? { status: status.index } : {}),
  };
  return { mapping, confidence, ambiguousDate: dateColumn.date!.ambiguous };
}

/**
 * One signed column, or a debit and credit pair. A pair is two numeric
 * columns that are never both filled on the same row; header names decide
 * which is which, and when they do not, the column with more negative values
 * or the leftmost one is the debit side.
 */
function detectAmount(
  pool: ColumnProfile[],
  rowCount: number,
): { columns: AmountColumns; confidence: number } | undefined {
  if (!pool.length) return undefined;
  const debitNamed = pool.filter((p) => HEADER.debit.test(p.name) && !HEADER.amount.test(p.name));
  const creditNamed = pool.filter((p) => HEADER.credit.test(p.name) && !HEADER.amount.test(p.name));
  const named =
    debitNamed[0] && creditNamed[0] && debitNamed[0] !== creditNamed[0]
      ? { debit: debitNamed[0], credit: creditNamed[0], byHeader: true }
      : undefined;
  const pair = named ?? findExclusivePair(pool);
  if (pair) {
    const exclusive = pair.debit.values.every(
      (v, i) => v === '' || (pair.credit.values[i] ?? '') === '',
    );
    const coverage = ratio(
      pair.debit.values.filter((v, i) => v !== '' || (pair.credit.values[i] ?? '') !== '').length,
      rowCount,
    );
    if (exclusive && (pair.byHeader || coverage >= 0.8)) {
      return {
        columns: { kind: 'split', debit: pair.debit.index, credit: pair.credit.index },
        confidence: pair.byHeader ? 0.95 : 0.7,
      };
    }
  }
  const signed = [...pool].sort(
    (a, b) =>
      Number(HEADER.amount.test(b.name)) - Number(HEADER.amount.test(a.name)) ||
      b.filled - a.filled ||
      a.index - b.index,
  )[0]!;
  const coverage = ratio(signed.filled, rowCount);
  return {
    columns: { kind: 'signed', column: signed.index },
    confidence: Math.min(1, coverage * (HEADER.amount.test(signed.name) ? 1 : 0.75)),
  };
}

function findExclusivePair(pool: ColumnProfile[]) {
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const a = pool[i]!,
        b = pool[j]!;
      const exclusive = a.values.every((v, k) => v === '' || (b.values[k] ?? '') === '');
      if (!exclusive || a.filled === 0 || b.filled === 0) continue;
      const negatives = (p: ColumnProfile) =>
        p.values.filter((v) => (parseAmount(v) ?? 0) < 0).length;
      const aDebitHint = HEADER.debit.test(a.name) || HEADER.credit.test(b.name);
      const bDebitHint = HEADER.debit.test(b.name) || HEADER.credit.test(a.name);
      let debit = a,
        credit = b;
      if (bDebitHint && !aDebitHint) [debit, credit] = [b, a];
      else if (!aDebitHint && !bDebitHint && negatives(b) > negatives(a)) [debit, credit] = [b, a];
      return { debit, credit, byHeader: false };
    }
  }
  return undefined;
}

/**
 * For a signed column: the sign of the majority of rows whose description
 * reads as a purchase says which way money out points. Without such rows the
 * majority sign of every row stands in, at low confidence, since most rows in
 * a personal account are money out.
 */
function detectSign(
  amount: AmountColumns,
  profiles: ColumnProfile[],
  description: ColumnProfile,
): { convention: SignConvention; confidence: number } {
  if (amount.kind === 'split') return { convention: 'spend_negative', confidence: 1 };
  const column = profiles[amount.column]!;
  if (HEADER.spendPositive.test(column.name))
    return { convention: 'spend_positive', confidence: 0.9 };
  const vote = (rows: number[]) => {
    let negative = 0,
      positive = 0;
    for (const i of rows) {
      const cents = parseAmount(column.values[i] ?? '');
      if (cents === undefined || cents === 0) continue;
      if (cents < 0) negative++;
      else positive++;
    }
    return { negative, positive };
  };
  const purchases = column.values
    .map((_, i) => i)
    .filter((i) => PURCHASE.test(description.values[i] ?? ''));
  const p = vote(purchases);
  const votes = p.negative + p.positive;
  if (votes >= 2 && p.negative !== p.positive) {
    const margin = Math.abs(p.negative - p.positive) / votes;
    return {
      convention: p.negative > p.positive ? 'spend_negative' : 'spend_positive',
      confidence: 0.5 + 0.5 * margin * Math.min(1, votes / 6),
    };
  }
  // No purchase-like rows to read: spend_negative is the convention nearly
  // every export uses, so it stands at low confidence rather than guessing
  // from the majority sign, which a savings account full of deposits would flip.
  return { convention: 'spend_negative', confidence: 0.3 };
}

// --- overrides ------------------------------------------------------------

/** What a caller may pin; every field is optional and wins over detection. */
export interface MappingOverrides {
  date?: number;
  dateFormat?: DateFormat;
  amount?: number;
  debit?: number;
  credit?: number;
  sign?: SignConvention;
  description?: number;
  memo?: number | null;
  balance?: number | null;
  status?: number | null;
}

/** Applies overrides to a detected mapping and validates the result against the table. */
export function applyOverrides(
  detected: DetectedMapping,
  overrides: MappingOverrides,
  table: CsvTable,
): DetectedMapping {
  const mapping: ColumnMapping = { ...detected.mapping };
  const confidence = { ...detected.confidence };
  let ambiguousDate = detected.ambiguousDate;
  const check = (role: string, column: number | undefined) => {
    if (column === undefined) return;
    if (!Number.isInteger(column) || column < 0 || column >= table.columns.length)
      throw new MappingError(`${role}: no column ${String(column + 1)} in the file`);
  };
  if (overrides.date !== undefined) {
    check('date', overrides.date);
    mapping.date = overrides.date;
    confidence.date = 1;
  }
  if (overrides.dateFormat !== undefined) {
    mapping.dateFormat = overrides.dateFormat;
    ambiguousDate = false;
    confidence.date = 1;
  }
  if (overrides.debit !== undefined || overrides.credit !== undefined) {
    if (overrides.debit === undefined || overrides.credit === undefined)
      throw new MappingError('debit and credit columns must be given together');
    check('debit', overrides.debit);
    check('credit', overrides.credit);
    mapping.amount = { kind: 'split', debit: overrides.debit, credit: overrides.credit };
    confidence.amount = 1;
    confidence.sign = 1;
  } else if (overrides.amount !== undefined) {
    check('amount', overrides.amount);
    mapping.amount = { kind: 'signed', column: overrides.amount };
    confidence.amount = 1;
  }
  if (overrides.sign !== undefined) {
    mapping.sign = overrides.sign;
    confidence.sign = 1;
  }
  if (overrides.description !== undefined) {
    check('description', overrides.description);
    mapping.description = overrides.description;
    confidence.description = 1;
  }
  for (const role of ['memo', 'balance', 'status'] as const) {
    const value = overrides[role];
    if (value === undefined) continue;
    if (value === null) delete mapping[role];
    else {
      check(role, value);
      mapping[role] = value;
      if (role === 'balance') confidence.balance = 1;
    }
  }
  const used = [
    mapping.date,
    mapping.description,
    ...(mapping.amount.kind === 'signed'
      ? [mapping.amount.column]
      : [mapping.amount.debit, mapping.amount.credit]),
  ];
  if (new Set(used).size !== used.length)
    throw new MappingError('date, amount and description must be different columns');
  return { mapping, confidence, ambiguousDate };
}

// --- row mapping ----------------------------------------------------------

export interface MappedRow {
  /** 1-based line in the file, for error messages and the preview. */
  line: number;
  date: string;
  amountCents: number;
  description: string;
  balanceCents?: number;
  pending: boolean;
  /** Every cell keyed by column name, kept for `raw_json`. */
  raw: Record<string, string>;
}

export interface RowError {
  line: number;
  message: string;
}

/** Applies the mapping to every row. Rows that fail are reported, never dropped silently. */
export function mapRows(
  table: CsvTable,
  mapping: ColumnMapping,
): { rows: MappedRow[]; errors: RowError[] } {
  const rows: MappedRow[] = [];
  const errors: RowError[] = [];
  const name = (i: number) => table.columns[i] ?? `Column ${String(i + 1)}`;
  for (const row of table.rows) {
    const cell = (i: number) => row.cells[i]?.trim() ?? '';
    const date = parseDate(cell(mapping.date), mapping.dateFormat);
    if (!date) {
      errors.push({
        line: row.line,
        message: `${name(mapping.date)}: "${cell(mapping.date)}" is not a ${mapping.dateFormat} date`,
      });
      continue;
    }
    let amountCents: number | undefined;
    if (mapping.amount.kind === 'signed') {
      const text = cell(mapping.amount.column);
      amountCents = parseAmount(text);
      if (amountCents === undefined) {
        errors.push({
          line: row.line,
          message: `${name(mapping.amount.column)}: "${text}" is not an amount`,
        });
        continue;
      }
      if (mapping.sign === 'spend_positive') amountCents = -amountCents;
    } else {
      const debitText = cell(mapping.amount.debit);
      const creditText = cell(mapping.amount.credit);
      const debit = debitText === '' ? 0 : parseAmount(debitText);
      const credit = creditText === '' ? 0 : parseAmount(creditText);
      if (debit === undefined || credit === undefined) {
        errors.push({
          line: row.line,
          message: `${debit === undefined ? name(mapping.amount.debit) : name(mapping.amount.credit)}: "${debit === undefined ? debitText : creditText}" is not an amount`,
        });
        continue;
      }
      if (debitText === '' && creditText === '') {
        errors.push({ line: row.line, message: 'neither debit nor credit is filled' });
        continue;
      }
      // A debit column may already carry the minus sign; either way it is money out.
      amountCents = -Math.abs(debit) + Math.abs(credit);
    }
    const description = [
      cell(mapping.description),
      mapping.memo === undefined ? '' : cell(mapping.memo),
    ]
      .filter((part) => part !== '')
      .join(' | ');
    if (!description) {
      errors.push({
        line: row.line,
        message: `${name(mapping.description)}: description is empty`,
      });
      continue;
    }
    let balanceCents: number | undefined;
    if (mapping.balance !== undefined && cell(mapping.balance) !== '') {
      balanceCents = parseAmount(cell(mapping.balance));
      if (balanceCents === undefined) {
        errors.push({
          line: row.line,
          message: `${name(mapping.balance)}: "${cell(mapping.balance)}" is not an amount`,
        });
        continue;
      }
    }
    const raw: Record<string, string> = {};
    row.cells.forEach((value, i) => {
      raw[name(i)] = value;
    });
    rows.push({
      line: row.line,
      date,
      // `-0` from negating a zero credit would serialise as 0 anyway; keep it plain.
      amountCents: amountCents === 0 ? 0 : amountCents,
      description,
      ...(balanceCents === undefined ? {} : { balanceCents }),
      pending: mapping.status !== undefined && PENDING.test(cell(mapping.status)),
      raw,
    });
  }
  return { rows, errors };
}
