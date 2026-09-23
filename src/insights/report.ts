import { z } from 'zod';
import type { Db } from '../db/client.js';
import type { TransactionRow } from '../db/repo.js';
import { categoryOf } from '../ingest/taxonomy.js';
import { statusSummary } from '../server/status.js';
import { dateSchema } from '../tools/period.js';

/**
 * The Overview's reporting basis. Every posted row is one of these classes,
 * derived from its label and direction, so "spent" on the Overview means
 * consumption: purchases, not money moved to savings, loan principal or cash.
 */
export const reportingClass = z.enum([
  'income',
  'consumption',
  'internal_transfer',
  'asset_movement',
  'liability_principal',
  'unresolved_movement',
]);
export type ReportingClass = z.infer<typeof reportingClass>;

interface DatedBalance {
  account_id: number;
  current_cents: number | null;
  currency: string | null;
  as_of: string | null;
  balance_id: number | null;
}

export function classify(row: TransactionRow): ReportingClass {
  if (row.is_internal_transfer) return 'internal_transfer';
  const leaf = row.subcategory;
  if (leaf === 'savings' || leaf === 'investments' || leaf === 'savings_investments_other')
    return 'asset_movement';
  if (
    leaf === 'mortgage' ||
    leaf === 'loan_repayment' ||
    leaf === 'cash_movement' ||
    !leaf ||
    leaf === 'other'
  )
    return 'unresolved_movement';
  if (categoryOf(leaf) === 'income' && row.amount_cents > 0) return 'income';
  if (row.amount_cents > 0) return 'unresolved_movement';
  return 'consumption';
}

/** Every transaction with its reporting class. */
export function classifiedRows(db: Db) {
  return db
    .prepare<[], TransactionRow>('SELECT * FROM transactions ORDER BY posted_at,id')
    .all()
    .map((row) => ({ ...row, reporting_class: classify(row) }));
}

export const reportSchema = z
  .strictObject({
    from: dateSchema,
    to: dateSchema,
    account_id: z.number().int().positive().optional(),
  })
  .refine((v) => v.from <= v.to, 'from must be before to');

export function overviewReport(db: Db, input: z.infer<typeof reportSchema>) {
  const rows = classifiedRows(db).filter(
    (r) =>
      r.posted_at.slice(0, 10) >= input.from &&
      r.posted_at.slice(0, 10) <= input.to &&
      (!input.account_id || input.account_id === r.account_id),
  );
  const totals = [...new Set(rows.map((r) => r.currency))].sort().map((currency) => {
    const all = rows.filter((r) => r.currency === currency),
      posted = all.filter((r) => r.status === 'posted');
    const sum = (rs: typeof rows) => rs.reduce((s, r) => s + r.amount_cents, 0);
    // Outgoing figures are reported as positive spend; `|| 0` avoids -0 for an empty selection.
    const spend = (rs: typeof rows) => -sum(rs) || 0;
    return {
      currency,
      posted_outgoing_cents: spend(posted.filter((r) => r.amount_cents < 0)),
      posted_incoming_cents: sum(posted.filter((r) => r.amount_cents > 0)),
      posted_net_cents: sum(posted),
      consumption_cents: spend(posted.filter((r) => r.reporting_class === 'consumption')),
      income_cents: sum(posted.filter((r) => r.reporting_class === 'income')),
      pending_net_cents: sum(all.filter((r) => r.status === 'pending')),
      pending_count: all.filter((r) => r.status === 'pending').length,
      classes: reportingClass.options.map((classification) => ({
        classification,
        net_cents: sum(posted.filter((r) => r.reporting_class === classification)),
      })),
      categories: [...new Set(posted.map((r) => categoryOf(r.subcategory)))]
        .sort()
        .map((category) => ({
          category,
          consumption_cents: spend(
            posted.filter(
              (r) => categoryOf(r.subcategory) === category && r.reporting_class === 'consumption',
            ),
          ),
        })),
    };
  });
  const status = statusSummary(db);
  const balances = db
    .prepare<[], DatedBalance>(
      `SELECT a.id account_id, b.current_cents, b.currency, b.as_of, b.id balance_id FROM accounts a LEFT JOIN account_balances b ON b.id=(SELECT id FROM account_balances WHERE account_id=a.id ORDER BY as_of DESC,id DESC LIMIT 1) ORDER BY a.id`,
    )
    .all();
  const reconcile = (b: DatedBalance) => {
    if (b.balance_id === null)
      return {
        account_id: b.account_id,
        status: 'no_balance' as const,
        reason: 'No imported balance.',
      };
    const previous = db
      .prepare<[number, string], DatedBalance>(
        'SELECT account_id, current_cents, currency, as_of, id balance_id FROM account_balances WHERE account_id=? AND as_of<? ORDER BY as_of DESC,id DESC LIMIT 1',
      )
      .get(b.account_id, b.as_of!);
    if (!previous || previous.currency !== b.currency)
      return {
        account_id: b.account_id,
        status: 'unverified' as const,
        reason: 'Only one dated balance; a starting balance cannot be inferred from movements.',
      };
    const movement = db
      .prepare<[number, string, string, string], { net: number }>(
        "SELECT coalesce(sum(amount_cents),0) net FROM transactions WHERE account_id=? AND currency=? AND status='posted' AND posted_at>? AND posted_at<=?",
      )
      .get(b.account_id, b.currency!, previous.as_of!, b.as_of!)!.net;
    const difference = b.current_cents! - previous.current_cents! - movement;
    return {
      account_id: b.account_id,
      status: difference === 0 ? ('matched' as const) : ('unexplained' as const),
      from_as_of: previous.as_of,
      to_as_of: b.as_of,
      balance_change_cents: b.current_cents! - previous.current_cents!,
      posted_movement_cents: movement,
      unexplained_cents: difference,
      reason:
        difference === 0
          ? 'Posted movements between the two balances explain the balance change.'
          : 'Movements between the two balances do not explain the change: missing rows, pending items or an incomplete file.',
    };
  };
  return {
    ...input,
    basis: 'posted_consumption_v1',
    date_basis: 'statement calendar dates; UTC day boundaries',
    inclusion_rules:
      'Consumption is signed purchases; excludes transfers, asset movements, principal and unresolved movements. Pending rows are separate, here and in get_spending_summary, which remains outgoing money over posted rows.',
    totals,
    unresolved_transaction_ids: [
      ...new Set(rows.filter((r) => r.reporting_class === 'unresolved_movement').map((r) => r.id)),
    ],
    coverage: status.coverage,
    last_import: status.lastSuccessfulImport,
    balances: balances.map((b) => ({
      account_id: b.account_id,
      current_cents: b.current_cents,
      currency: b.currency,
      as_of: b.as_of,
    })),
    reconciliation: balances.map(reconcile),
    reconciliation_basis:
      'A balance is checked against posted movements only between two dated balances on the same account. Observed extent does not verify complete history; missing balances are unknown, not zero. No inferred starting balance or principal/interest split.',
  };
}

export const trendSchema = z.strictObject({
  to: z.string().regex(/^\d{4}-\d{2}$/, 'to must be YYYY-MM'),
  months: z.number().int().min(1).max(24),
});

/** The month `delta` months after `month` (YYYY-MM), computed in UTC. */
export function shiftMonth(month: string, delta: number) {
  const d = new Date(`${month}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + delta);
  return d.toISOString().slice(0, 7);
}

/**
 * Spending and income per calendar month using the same reporting classes as
 * `overviewReport`, so the Overview trend and its headline figure agree. Every
 * month in the window is present, including ones with no posted rows, and
 * currencies are never combined.
 */
export function monthlyTotals(db: Db, input: z.infer<typeof trendSchema>) {
  const months = Array.from({ length: input.months }, (_, i) =>
    shiftMonth(input.to, i - input.months + 1),
  );
  const first = months[0]!;
  const rows = classifiedRows(db).filter(
    (r) =>
      r.status === 'posted' &&
      r.posted_at.slice(0, 7) >= first &&
      r.posted_at.slice(0, 7) <= input.to,
  );
  const currencies = [...new Set(rows.map((r) => r.currency))].sort();
  return {
    from: first,
    to: input.to,
    basis: 'posted_consumption_v1',
    months: months.map((month) => {
      const inMonth = rows.filter((r) => r.posted_at.slice(0, 7) === month);
      return {
        month,
        totals: currencies.map((currency) => {
          const mine = inMonth.filter((r) => r.currency === currency);
          const sum = (cls: ReportingClass) =>
            mine.filter((r) => r.reporting_class === cls).reduce((s, r) => s + r.amount_cents, 0);
          return {
            currency,
            consumption_cents: -sum('consumption') || 0,
            income_cents: sum('income'),
            row_count: mine.length,
          };
        }),
      };
    }),
  };
}
