import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Db } from '../db/client.js';
import type { ToolDef } from '../llm/types.js';
import type { TransactionRow } from '../db/repo.js';
import {
  categoryOf,
  parentCategorySchema,
  subcategoriesOf,
  subcategorySchema,
  type ParentCategory,
} from '../ingest/taxonomy.js';
import {
  dateSchema,
  day,
  flatWindow,
  nextMonth,
  refineWindows,
  resolveOpenWindow,
  resolveWindow,
  windowFields,
  windowForms,
  type DateWindow,
} from './period.js';
const money = (cents: number) => ({ cents, decimal: (cents / 100).toFixed(2) });
const filterShape = {
  query: z.string().max(500).optional(),
  category: parentCategorySchema.optional(),
  subcategory: subcategorySchema.optional(),
  account_id: z.number().int().positive().optional(),
};
// windows are flat fields (period, or from and to), never a union; the
// exactly-one rule is `refineWindows`. compare_to is the comparison window's
// end date, no longer the comparison period itself.
const primaryWindow = windowFields('');
const compareWindow = windowFields('compare_');
// search takes the same preset as the summaries, since both models kept
// sending one here and losing a turn to the rejection. Its window stays
// optional and may bound one side only.
const searchWindowRule = { required: false, openEnded: true } as const;
const searchSchema = z
  .strictObject({
    ...filterShape,
    period: primaryWindow.period,
    from: primaryWindow.from,
    to: primaryWindow.to,
    direction: z.enum(['all', 'debit', 'credit']).default('all'),
    min_amount_cents: z.number().int().nonnegative().safe().optional(),
    max_amount_cents: z.number().int().nonnegative().safe().optional(),
    currency: z.string().min(1).max(20).optional(),
    sort: z.enum(['newest', 'oldest', 'largest', 'smallest']).default('newest'),
    cursor: z.string().min(1).max(4096).optional(),
    limit: z.number().int().min(1).max(100).default(20),
    include_transfers: z.boolean().default(false),
  })
  .superRefine((input, ctx) => refineWindows(input, ctx, [''], searchWindowRule));
const summarySchema = z
  .strictObject({
    ...filterShape,
    period: primaryWindow.period,
    from: primaryWindow.from,
    to: primaryWindow.to,
    compare_period: compareWindow.period,
    compare_from: compareWindow.from,
    compare_to: compareWindow.to,
    group_by: z.enum(['category', 'subcategory', 'month', 'account', 'merchant']),
    include_transfers: z.boolean().default(false),
  })
  .superRefine((input, ctx) => refineWindows(input, ctx, ['', 'compare_']));
const cashFlowSchema = z
  .strictObject({
    period: primaryWindow.period,
    from: primaryWindow.from,
    to: primaryWindow.to,
    account_id: filterShape.account_id,
    group_by: z.enum(['month', 'account']).optional(),
    include_transfers: z.boolean().default(false),
  })
  .superRefine((input, ctx) => refineWindows(input, ctx));
const recurringSchema = z.strictObject({
  min_occurrences: z.number().int().min(3).max(100).default(3),
});
const upcomingSchema = z.strictObject({ days: z.number().int().min(1).max(366).default(30) });
/**
 * SQL for "this row rolls up to this parent". `uncategorised` is the complement
 * of every other parent's leaves rather than a list of its own, so it matches an
 * unlabelled row and any label outside the taxonomy exactly as `categoryOf`
 * does, and never matches `cash_movement`.
 */
function parentClause(parent: ParentCategory, params: (string | number)[]): string {
  if (parent === 'uncategorised') {
    const classified = Object.entries(subcategoriesOf)
      .filter(([name]) => name !== 'uncategorised')
      .flatMap(([, leaves]) => leaves);
    params.push(...classified);
    return `(subcategory IS NULL OR subcategory NOT IN (${classified.map(() => '?').join(',')}))`;
  }
  const leaves = subcategoriesOf[parent];
  params.push(...leaves);
  return `subcategory IN (${leaves.map(() => '?').join(',')})`;
}
/**
 * Debit, credit and net totals of a set of rows, kept separate by currency.
 * Debits are positive spending, matching `get_spending_summary`; net keeps the
 * signed direction the rows themselves carry.
 */
function currencyTotals(rows: TransactionRow[]) {
  const totals = new Map<string, { debit: number; credit: number }>();
  for (const r of rows) {
    const t = totals.get(r.currency) ?? { debit: 0, credit: 0 };
    if (r.amount_cents < 0) t.debit -= r.amount_cents;
    else t.credit += r.amount_cents;
    totals.set(r.currency, t);
  }
  return [...totals]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, t]) => ({
      currency,
      debit_total: money(t.debit),
      credit_total: money(t.credit),
      net_total: money(t.credit - t.debit),
    }));
}
function coverage(db: Db, accountId?: number) {
  return db
    .prepare<number[], { from: string | null; to: string | null }>(
      `SELECT min(substr(posted_at,1,10)) AS "from", max(substr(posted_at,1,10)) AS "to" FROM transactions ${accountId ? 'WHERE account_id = ?' : ''}`,
    )
    .get(...(accountId ? [accountId] : []))!;
}
/**
 * Matching rows split by status. Sums use `rows` (posted only), the rule the
 * Overview's `planningReport` applies, so a pending row can never make the
 * chat and the Overview disagree on a total; `pending` is reported alongside
 * so the model can still mention what has not settled.
 */
function select(db: Db, clauses: string[], params: (string | number)[], include: boolean) {
  const where = clauses.length ? clauses.join(' AND ') : '1=1';
  const excluded = db
    .prepare<(string | number)[], { n: number }>(
      `SELECT count(*) n FROM transactions WHERE ${where} AND is_internal_transfer = 1`,
    )
    .get(...params)!.n;
  const all = db
    .prepare<(string | number)[], TransactionRow>(
      `SELECT * FROM transactions WHERE ${where} ${include ? '' : 'AND is_internal_transfer = 0'} ORDER BY posted_at DESC, id DESC`,
    )
    .all(...params);
  return {
    rows: all.filter((r) => r.status === 'posted'),
    pending: all.filter((r) => r.status === 'pending'),
    excluded_transfer_count: include ? 0 : excluded,
  };
}
// Shared literal substring, category intersection and account predicates.
function addFilters(
  input: {
    query?: string | undefined;
    category?: ParentCategory | undefined;
    subcategory?: z.infer<typeof subcategorySchema> | undefined;
    account_id?: number | undefined;
  },
  clauses: string[],
  params: (string | number)[],
) {
  if (input.query !== undefined) {
    clauses.push("description_norm LIKE ? ESCAPE '\\'");
    params.push(`%${input.query.replace(/[\\%_]/g, '\\$&')}%`);
  }
  if (input.category) clauses.push(parentClause(input.category, params));
  if (input.subcategory) {
    clauses.push('subcategory = ?');
    params.push(input.subcategory);
  }
  if (input.account_id) {
    clauses.push('account_id = ?');
    params.push(input.account_id);
  }
}
const cursorSchema = z.strictObject({
  version: z.literal(1),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  range: z.strictObject({ from: dateSchema.nullable(), to: dateSchema.nullable() }),
  key: z.union([z.string(), z.number().int().nonnegative().safe()]),
  id: z.number().int().positive().safe(),
});
function decodeCursor(value: string) {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw new Error();
    return cursorSchema.parse(JSON.parse(bytes.toString('utf8')));
  } catch {
    throw new Error('Malformed search cursor');
  }
}
export function search(db: Db, input: z.infer<typeof searchSchema>, now = new Date()) {
  // One page and its aggregates share a read snapshot; subsequent calls do not.
  return db.transaction(() => searchPage(db, input, now))();
}
function searchPage(db: Db, input: z.infer<typeof searchSchema>, now: Date) {
  if (
    input.min_amount_cents !== undefined &&
    input.max_amount_cents !== undefined &&
    input.min_amount_cents > input.max_amount_cents
  )
    throw new Error('min_amount_cents must be on or below max_amount_cents');
  const cursor = input.cursor ? decodeCursor(input.cursor) : null;
  const bounds = coverage(db);
  // A preset resolves against now once; the cursor then carries the resolved
  // bounds so later pages keep them when the day rolls over or an import
  // extends stored history.
  const window = resolveOpenWindow(flatWindow(input, ''), now);
  const range = cursor?.range ?? { from: window.from ?? bounds.from, to: window.to ?? bounds.to };
  if (range.from && range.to && range.from > range.to)
    throw new Error('from must be on or before to');
  const filters = {
    period: input.period ?? null,
    from: input.from ?? null,
    to: input.to ?? null,
    query: input.query ?? null,
    category: input.category ?? null,
    subcategory: input.subcategory ?? null,
    account_id: input.account_id ?? null,
    direction: input.direction,
    min_amount_cents: input.min_amount_cents ?? null,
    max_amount_cents: input.max_amount_cents ?? null,
    currency: input.currency ?? null,
    include_transfers: input.include_transfers,
    sort: input.sort,
  };
  const fingerprint = createHash('sha256').update(JSON.stringify({ filters, range })).digest('hex');
  const amountSort = input.sort === 'largest' || input.sort === 'smallest';
  if (
    cursor &&
    (cursor.fingerprint !== fingerprint || typeof cursor.key !== (amountSort ? 'number' : 'string'))
  )
    throw new Error('Cursor is incompatible with these filters or sort');
  const clauses: string[] = [],
    params: (string | number)[] = [];
  if (range.from) {
    clauses.push('substr(posted_at,1,10) >= ?');
    params.push(range.from);
  }
  if (range.to) {
    clauses.push('substr(posted_at,1,10) <= ?');
    params.push(range.to);
  }
  addFilters(input, clauses, params);
  if (input.direction !== 'all')
    clauses.push(input.direction === 'debit' ? 'amount_cents < 0' : 'amount_cents > 0');
  if (input.min_amount_cents !== undefined) {
    clauses.push('abs(amount_cents) >= ?');
    params.push(input.min_amount_cents);
  }
  if (input.max_amount_cents !== undefined) {
    clauses.push('abs(amount_cents) <= ?');
    params.push(input.max_amount_cents);
  }
  if (input.currency !== undefined) {
    clauses.push('currency = ?');
    params.push(input.currency);
  }
  const baseWhere = clauses.length ? clauses.join(' AND ') : '1=1';
  const excluded_transfer_count = input.include_transfers
    ? 0
    : db
        .prepare<(string | number)[], { n: number }>(
          `SELECT count(*) n FROM transactions WHERE ${baseWhere} AND is_internal_transfer = 1`,
        )
        .get(...params)!.n;
  const where = baseWhere + (input.include_transfers ? '' : ' AND is_internal_transfer = 0');
  const aggregates = db
    .prepare<
      (string | number)[],
      { currency: string; n: number; debit: number; credit: number; net: number }
    >(
      `SELECT currency, count(*) n,
      sum(CASE WHEN amount_cents < 0 THEN -amount_cents ELSE 0 END) debit,
      sum(CASE WHEN amount_cents > 0 THEN amount_cents ELSE 0 END) credit,
      sum(amount_cents) net
      FROM transactions WHERE ${where} GROUP BY currency ORDER BY currency`,
    )
    .all(...params);
  const pending_matched_count = db
    .prepare<(string | number)[], { n: number }>(
      `SELECT count(*) n FROM transactions WHERE ${where} AND status = 'pending'`,
    )
    .get(...params)!.n;
  const column = amountSort ? 'abs(amount_cents)' : 'posted_at';
  const ascending = input.sort === 'oldest' || input.sort === 'smallest';
  const order = ascending ? 'ASC' : 'DESC',
    operator = ascending ? '>' : '<';
  const pageParams = [...params];
  let after = '';
  if (cursor) {
    after = ` AND (${column} ${operator} ? OR (${column} = ? AND id ${operator} ?))`;
    pageParams.push(cursor.key, cursor.key, cursor.id);
  }
  const page = db
    .prepare<(string | number)[], TransactionRow>(
      `SELECT * FROM transactions WHERE ${where}${after} ORDER BY ${column} ${order}, id ${order} LIMIT ?`,
    )
    .all(...pageParams, input.limit + 1);
  const has_more = page.length > input.limit;
  const returned = page.slice(0, input.limit),
    last = returned.at(-1);
  const next_cursor =
    has_more && last
      ? Buffer.from(
          JSON.stringify({
            version: 1,
            fingerprint,
            range,
            key: amountSort ? Math.abs(last.amount_cents) : last.posted_at,
            id: last.id,
          }),
        ).toString('base64url')
      : null;
  return {
    date_range: range,
    data_coverage: bounds,
    filters,
    pagination_consistency: 'current_stored_data_with_fixed_date_bounds',
    total_matched_count: aggregates.reduce((sum, row) => sum + row.n, 0),
    pending_matched_count,
    row_count: returned.length,
    returned_rows_totals: currencyTotals(returned),
    matched_rows_totals: aggregates.map((row) => ({
      currency: row.currency,
      debit_total: money(row.debit),
      credit_total: money(row.credit),
      net_total: money(row.net),
    })),
    next_cursor,
    has_more,
    excluded_transfer_count,
    rows: returned.map((r) => ({
      id: r.id,
      account_id: r.account_id,
      posted_at: r.posted_at,
      status: r.status,
      description: r.description_norm,
      category: categoryOf(r.subcategory),
      subcategory: r.subcategory,
      is_subscription: r.is_subscription === null ? null : !!r.is_subscription,
      currency: r.currency,
      amount: money(r.amount_cents),
      is_internal_transfer: !!r.is_internal_transfer,
    })),
  };
}
function spendingWindow(db: Db, input: z.infer<typeof summarySchema>, range: DateWindow) {
  const clauses = [
    'substr(posted_at,1,10) >= ?',
    'substr(posted_at,1,10) <= ?',
    'amount_cents < 0',
  ];
  const params: (string | number)[] = [range.from, range.to];
  addFilters(input, clauses, params);
  const { rows, pending, excluded_transfer_count } = select(
    db,
    clauses,
    params,
    input.include_transfers,
  );
  // Coverage is transaction extent, never a guarantee of complete bank history.
  const bounds = coverage(db, input.account_id);
  const observed = observedCoverage(bounds, range);
  const groups = new Map<
      string,
      { group: string; currency: string; cents: number; row_count: number }
    >(),
    totals = new Map<string, number>();
  for (const r of rows) {
    const group =
      input.group_by === 'category'
        ? categoryOf(r.subcategory)
        : input.group_by === 'subcategory'
          ? (r.subcategory ?? 'uncategorised')
          : input.group_by === 'month'
            ? r.posted_at.slice(0, 7)
            : input.group_by === 'account'
              ? String(r.account_id)
              : r.description_norm;
    const key = JSON.stringify([group, r.currency]);
    const g = groups.get(key) ?? { group, currency: r.currency, cents: 0, row_count: 0 };
    g.cents -= r.amount_cents;
    g.row_count++;
    groups.set(key, g);
    totals.set(r.currency, (totals.get(r.currency) ?? 0) - r.amount_cents);
  }
  return {
    date_range: range,
    data_coverage: coverage(db),
    day_count: inclusiveDays(range),
    coverage: observed,
    basis: 'posted_debits',
    row_count: rows.length,
    excluded_transfer_count,
    pending_row_count: pending.length,
    pending_totals: currencyTotals(pending).map((t) => ({
      currency: t.currency,
      total: t.debit_total,
    })),
    groups: [...groups.values()]
      .sort((a, b) => a.group.localeCompare(b.group) || a.currency.localeCompare(b.currency))
      .map(({ cents, ...g }) => ({ ...g, total: money(cents) })),
    totals: [...totals].sort().map(([currency, cents]) => ({ currency, total: money(cents) })),
  };
}
function observedCoverage(
  bounds: { from: string | null; to: string | null },
  range: { from: string; to: string },
) {
  const overlapFrom = bounds.from && (bounds.from > range.from ? bounds.from : range.from);
  const overlapTo = bounds.to && (bounds.to < range.to ? bounds.to : range.to);
  const overlap =
    overlapFrom && overlapTo && overlapFrom <= overlapTo
      ? { from: overlapFrom, to: overlapTo }
      : null;
  return {
    basis: 'stored_transaction_extent',
    complete_history_verified: false,
    data_coverage: bounds,
    overlap,
    overlap_day_count: overlap ? inclusiveDays(overlap) : 0,
  };
}
export function cashFlow(db: Db, input: z.infer<typeof cashFlowSchema>, now: Date) {
  const range = resolveWindow(flatWindow(input, ''), now);
  const clauses = ['substr(posted_at,1,10) >= ?', 'substr(posted_at,1,10) <= ?'];
  const params: (string | number)[] = [range.from, range.to];
  addFilters(input, clauses, params);
  const { rows, pending, excluded_transfer_count } = select(
    db,
    clauses,
    params,
    input.include_transfers,
  );
  const bounds = coverage(db, input.account_id);
  const totals = (items: TransactionRow[]) =>
    currencyTotals(items).map((total) => ({
      currency: total.currency,
      incoming_credits: total.credit_total,
      outgoing_debits: total.debit_total,
      net_flow: total.net_total,
      row_count: items.filter((r) => r.currency === total.currency).length,
      credit_count: items.filter((r) => r.currency === total.currency && r.amount_cents > 0).length,
      debit_count: items.filter((r) => r.currency === total.currency && r.amount_cents < 0).length,
      zero_count: items.filter((r) => r.currency === total.currency && r.amount_cents === 0).length,
    }));
  const groups = new Map<string, TransactionRow[]>();
  if (input.group_by)
    for (const row of rows) {
      const key = input.group_by === 'month' ? row.posted_at.slice(0, 7) : String(row.account_id);
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }
  return {
    date_range: range,
    data_coverage: bounds,
    coverage: observedCoverage(bounds, range),
    day_count: inclusiveDays(range),
    filters: { account_id: input.account_id ?? null, include_transfers: input.include_transfers },
    basis: 'posted_rows',
    row_count: rows.length,
    excluded_transfer_count,
    pending_row_count: pending.length,
    pending_totals: totals(pending),
    totals: totals(rows),
    groups: [...groups]
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([group, items]) => totals(items).map((total) => ({ group, ...total }))),
  };
}
function inclusiveDays(range: { from: string; to: string }) {
  return (Date.parse(range.to) - Date.parse(range.from)) / 86400000 + 1;
}
function difference(primary: number, comparison: number) {
  return {
    primary_total: money(primary),
    comparison_total: money(comparison),
    change: money(primary - comparison),
    percentage_change:
      comparison === 0 ? null : Math.round(((primary - comparison) / comparison) * 10000) / 100,
    percentage_change_reason: comparison === 0 ? 'comparison_total_zero' : null,
  };
}
export function summary(db: Db, input: z.infer<typeof summarySchema>, now: Date) {
  const primary = spendingWindow(db, input, resolveWindow(flatWindow(input, ''), now));
  const compareFields = flatWindow(input, 'compare_');
  const comparison =
    compareFields.period === undefined && compareFields.from === undefined
      ? null
      : spendingWindow(db, input, resolveWindow(compareFields, now, 'compare_'));
  const compareRows = <T extends { currency: string; total: { cents: number } }>(
    current: T[],
    previous: T[],
    key: (row: T) => string,
  ) => {
    const left = new Map(current.map((row) => [key(row), row]));
    const right = new Map(previous.map((row) => [key(row), row]));
    return [...new Set([...left.keys(), ...right.keys()])].sort().map((k) => {
      const a = left.get(k),
        b = right.get(k);
      const row = (a ?? b)!;
      return {
        currency: row.currency,
        ...('group' in row ? { group: row.group } : {}),
        ...difference(a?.total.cents ?? 0, b?.total.cents ?? 0),
      };
    });
  };
  return {
    ...primary,
    filters: {
      query: input.query ?? null,
      category: input.category ?? null,
      subcategory: input.subcategory ?? null,
      account_id: input.account_id ?? null,
      include_transfers: input.include_transfers,
    },
    ...(comparison
      ? {
          comparison: {
            ...comparison,
            totals: compareRows(primary.totals, comparison.totals, (row) => row.currency),
            groups: compareRows(primary.groups, comparison.groups, (row) =>
              JSON.stringify([row.group, row.currency]),
            ),
          },
        }
      : {}),
  };
}
export function recurring(db: Db, input: z.infer<typeof recurringSchema>) {
  // A pending charge is still evidence of its series (and the Overview shares
  // this detector), so both statuses take part here.
  const selected = select(db, ['amount_cents < 0'], [], false);
  const rows = [...selected.rows, ...selected.pending];
  const { excluded_transfer_count } = selected;
  const groups = new Map<string, TransactionRow[]>();
  for (const r of rows) {
    const key = JSON.stringify([r.description_norm, r.account_id, r.currency]);
    const group = groups.get(key) ?? [];
    group.push(r);
    groups.set(key, group);
  }
  const charges = [];
  for (const group of groups.values()) {
    if (group.length < input.min_occurrences) continue;
    group.sort((a, b) => a.posted_at.localeCompare(b.posted_at));
    const first = group[0]!,
      last = group.at(-1)!;
    const dates = group.map((r) => r.posted_at.slice(0, 10));
    const cadence = (['weekly', 'fortnightly', 'monthly'] as const).find((c) =>
      dates.slice(1).every((date, i) => {
        const previous = dates[i]!;
        const expected =
          c === 'monthly'
            ? Date.parse(nextMonth(previous))
            : Date.parse(previous) + (c === 'weekly' ? 7 : 14) * 86400000;
        return Math.abs(Date.parse(date) - expected) <= 2 * 86400000;
      }),
    );
    if (!cadence) continue;
    charges.push({
      description: last.description_norm,
      account_id: last.account_id,
      currency: last.currency,
      cadence,
      count: group.length,
      first_seen: dates[0]!,
      last_date: dates.at(-1)!,
      last_amount: money(-last.amount_cents),
      mean_amount: money(
        Math.round(group.reduce((sum, r) => sum - r.amount_cents, 0) / group.length),
      ),
      amount_drift: money(first.amount_cents - last.amount_cents),
    });
  }
  return {
    date_range: coverage(db),
    row_count: rows.length,
    excluded_transfer_count,
    charges: charges.sort(
      (a, b) => a.description.localeCompare(b.description) || a.account_id - b.account_id,
    ),
  };
}
export function upcoming(db: Db, input: z.infer<typeof upcomingSchema>, now: Date) {
  const result = recurring(db, { min_occurrences: 3 });
  const from = day(now),
    to = day(new Date(Date.parse(from) + input.days * 86400000));
  const payments = result.charges
    .flatMap((charge) => {
      const next =
        charge.cadence === 'monthly'
          ? nextMonth(charge.last_date)
          : day(
              new Date(
                Date.parse(charge.last_date) + (charge.cadence === 'weekly' ? 7 : 14) * 86400000,
              ),
            );
      return next >= from && next <= to ? [{ ...charge, next_date: next, estimated: true }] : [];
    })
    .sort(
      (a, b) =>
        a.next_date.localeCompare(b.next_date) || a.description.localeCompare(b.description),
    );
  return {
    date_range: { from, to },
    data_coverage: result.date_range,
    row_count: payments.length,
    source_row_count: result.row_count,
    excluded_transfer_count: result.excluded_transfer_count,
    payments,
  };
}
function tool<S extends z.ZodObject>(
  name: string,
  description: string,
  schema: S,
  execute: (db: Db, input: z.output<S>, now: Date) => unknown,
) {
  return {
    name,
    description,
    schema,
    execute: (db: Db, raw: unknown, now: Date) => execute(db, schema.parse(raw), now),
  };
}
const units =
  ' Dates are inclusive UTC YYYY-MM-DD. Money has cents and decimal strings, with currency. Internal transfers are excluded by default.';
export const registry = [
  tool(
    'list_accounts',
    'List every account stored in ledgerchat, including accounts with no transactions. Returns account_count and accounts with id, name, type, institution, currency and balance. Use for account lists, counts, names and balances, not transaction search.' +
      " balance is the latest figure carried by an imported file, with current, available (null when the file gave none), currency and as_of. CSV uses the latest balance row's statement date with an end-of-day UTC convention because its exact time is unknown; OFX uses its reported timestamp. It is not a live balance. balance null means no balance has been stored, not zero." +
      ' Balance sign is as the bank reports it: a loan or mortgage carries a negative current balance, so read it with the account type. Stored accounts are what has been imported, never a live view of the bank.',
    z.strictObject({}),
    (db) => {
      const accounts = db
        .prepare<
          [],
          {
            id: number;
            name: string;
            type: string | null;
            institution: string | null;
            currency: string;
            balance_as_of: string | null;
            balance_current_cents: number | null;
            balance_available_cents: number | null;
            balance_currency: string | null;
          }
        >(
          `SELECT a.id, a.name, a.type, a.institution, a.currency,
                  b.as_of AS balance_as_of,
                  b.current_cents AS balance_current_cents,
                  b.available_cents AS balance_available_cents,
                  b.currency AS balance_currency
           FROM accounts a
           LEFT JOIN account_balances b ON b.id = (
             SELECT id FROM account_balances
             WHERE account_id = a.id
             ORDER BY as_of DESC, id DESC LIMIT 1
           )
           ORDER BY a.id`,
        )
        .all()
        .map(
          ({
            balance_as_of,
            balance_current_cents,
            balance_available_cents,
            balance_currency,
            ...account
          }) => ({
            ...account,
            balance:
              balance_as_of === null || balance_current_cents === null || balance_currency === null
                ? null
                : {
                    current: money(balance_current_cents),
                    available:
                      balance_available_cents === null ? null : money(balance_available_cents),
                    // Stored as the source sent it, even if it differs from the
                    // account's own currency; the model sees both.
                    currency: balance_currency,
                    as_of: balance_as_of,
                  },
          }),
        );
      return { account_count: accounts.length, accounts };
    },
  ),
  tool(
    'search_transactions',
    'Search descriptions literally, AND all filters; newest first, limit 1-100. Returns signed amounts and full match count.' +
      ' The window is optional, given as ' +
      windowForms('') +
      '; never both, and never a period object or JSON string. Presets use today in UTC. Unlike the summaries, from or to may be sent alone (through today is to alone) and no window means the whole stored history.' +
      ' category filters by parent category and includes every subcategory under it; subcategory filters one exact leaf. Supplying both applies both, so an incompatible pair matches nothing.' +
      ' Each row returns its leaf as subcategory, its parent as category, is_subscription (null when unknown) and status (posted or pending). Pending rows are listed and counted in both totals here, with pending_matched_count saying how many; the summaries and the Overview count posted rows only.' +
      ' returned_rows_totals gives the debit, credit and net total of the returned rows only, per currency, with debits positive. Quote it rather than adding the rows up yourself, and only ever as the total of the rows shown.' +
      ' matched_rows_totals separately aggregates every match with the returned filters, date_range and total_matched_count, independent of the page. Never label it as the sum of displayed rows.' +
      ' direction all includes zeros; debit is strictly negative and credit strictly positive. min_amount_cents and max_amount_cents are inclusive nonnegative integer bounds on absolute magnitude; inverted bounds are invalid. currency is an exact currency filter. sort is newest (default), oldest, largest or smallest absolute amount, with a stable ID tie-breaker. Default limit 20, maximum 100.' +
      ' For another page repeat the same filters and sort with next_cursor; limit may change. has_more false and next_cursor null mean no next page. Cursors reject malformed or incompatible inputs. Each call observes current stored data, not a frozen snapshot across imports: original resolved date bounds stay fixed, inserts after the cursor can appear, earlier inserts are skipped, deletes disappear, and edits moving a row across the cursor can cause repeats or omissions. Match counts and totals refresh each call.' +
      units,
    searchSchema,
    search,
  ),
  tool(
    'get_cash_flow',
    'Actual incoming credits, positive outgoing debits and signed net flow (credits minus debits) from stored transactions over one required window, given as ' +
      windowForms('') +
      '; never both, and never a period object or JSON string. Presets use today in UTC. Optional account_id and month/account group_by; groups reconcile by currency. Zero amounts count as rows but neither credits nor debits. Empty totals mean zero matching rows, with no inferred currency. Credits include refunds and third-party transfers, not automatically salary or earned income. Outgoing money includes savings, investments, tax, loan repayments and cash withdrawals. Coverage is observed transaction extent, never verified complete history. Totals count posted rows only, the same rule as the Overview; pending rows are reported separately as pending_row_count and pending_totals. This is not a bank balance (list_accounts), an income estimate, a savings rate or disposable income. Never derive opening or closing balances from net flow.' +
      units,
    cashFlowSchema,
    cashFlow,
  ),
  tool(
    'get_spending_summary',
    'Sum debits as positive spending by category, subcategory, month, account or merchant over one required window, given as ' +
      windowForms('') +
      '; never both, and never a period object or JSON string. Presets use today in UTC. group_by category rolls subcategories up to their parent; group_by subcategory keeps each leaf separate. Totals stay separate by currency; empty totals mean zero.' +
      ' Optional query is a literal substring of the normalised description (not merchant identity); category, subcategory and account_id filters intersect, exactly as search. For a comparison add a second window in the same flat form: ' +
      windowForms('compare_') +
      '. compare_to is the end date of the comparison window, not the comparison period itself. A comparison returns comparison totals and groups with primary_total, comparison_total, signed change and percentage_change rounded to two decimals; a zero comparison total gives null with a reason. One-sided groups contribute zero in the other window. Windows are inclusive UTC dates with day counts and transaction-extent coverage, not verified complete history. Unequal windows are not normalised. Month groups retain their calendar YYYY-MM keys.' +
      ' Totals are outgoing money, not consumption: savings, investments, tax, loan repayments and cash withdrawals are included.' +
      ' Totals and groups count posted rows only, the same rule as the Overview; pending rows are left out and reported separately as pending_row_count and pending_totals (debits, per currency), so mention them when they exist.' +
      ' Unlabelled rows and other group as uncategorised; cash withdrawals group as cash.' +
      units,
    summarySchema,
    summary,
  ),
  tool(
    'get_recurring_charges',
    'Find debit series per merchant, account and currency with at least 3 occurrences. Every interval must be within 2 days of weekly, fortnightly or calendar monthly. Drift is last minus first charge.' +
      units,
    recurringSchema,
    recurring,
  ),
  tool(
    'get_upcoming_payments',
    'Estimate the next payment of each recurring series within today through today + days, inclusive. Overdue series are omitted, not rolled forward. Calendar monthly dates clamp to month end.' +
      units,
    upcomingSchema,
    upcoming,
  ),
];
export function toolDefs(): ToolDef[] {
  return registry.map(({ name, description, schema }) => ({
    name,
    description,
    jsonSchema: z.toJSONSchema(schema),
  }));
}
export function executeTool(
  db: Db,
  name: string,
  rawInput: unknown,
  options: { now?: Date } = {},
): { isError: boolean; content: string } {
  try {
    const found = registry.find((t) => t.name === name);
    if (!found)
      throw new Error(
        `Unknown tool ${name}. Valid tools: ${toolDefs()
          .map((t) => t.name)
          .join(', ')}`,
      );
    return {
      isError: false,
      content: JSON.stringify(found.execute(db, rawInput, options.now ?? new Date())),
    };
  } catch (error) {
    return {
      isError: true,
      content: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
    };
  }
}
