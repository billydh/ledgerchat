import { z } from 'zod';
import type { Db } from '../db/client.js';
import {
  countRuleMatches,
  deleteDescriptionRule,
  deleteTransactionOverride,
  getDescriptionRule,
  getTransactionById,
  getTransactionOverride,
  upsertDescriptionRule,
  upsertTransactionOverride,
  type CategoryOrigin,
  type TransactionRow,
} from '../db/repo.js';
import { categoryOf, subcategorySchema, type Subcategory } from './taxonomy.js';

/**
 * User corrections to the model's own label. Two scopes:
 *
 * - `transaction`: an override on one stored row.
 * - `description`: a rule for one source and one exact normalised description,
 *   applied to every stored and future row of that source that matches.
 *
 * Precedence is override, then rule, then machine label. The repo materialises
 * the winner into `transactions.subcategory`, so tools, evals and status counts
 * need no knowledge of this module. Corrections change the label only; the
 * subscription hint and transfer flags stay whatever enrichment set them to.
 *
 * Nothing here is reachable by the model: these are local API operations.
 */

export const correctionScopes = ['transaction', 'description'] as const;
export type CorrectionScope = (typeof correctionScopes)[number];
export const correctionScopeSchema = z.enum(correctionScopes);

export class CorrectionError extends Error {
  constructor(
    readonly status: 400 | 404,
    message: string,
  ) {
    super(message);
    this.name = 'CorrectionError';
  }
}

export const originLabels: Record<CategoryOrigin, string> = {
  llm: 'Machine label',
  transaction_override: 'Corrected for this transaction',
  description_rule: 'Corrected by a description rule',
};

export interface TransactionLabel {
  transaction_id: number;
  source: string;
  account_id: number;
  posted_at: string;
  amount_cents: number;
  currency: string;
  description: string;
  /** Effective leaf, or null when nothing has labelled the row. */
  subcategory: string | null;
  category: string;
  category_origin: CategoryOrigin | null;
  origin_label: string;
  machine_subcategory: string | null;
  is_subscription: boolean | null;
  is_internal_transfer: boolean;
  transfer_override: boolean | null;
  transfer_source: 'pair' | 'heuristic' | null;
  override: { subcategory: string; updated_at: string } | null;
  rule: { id: number; subcategory: string; updated_at: string } | null;
  /** What a description rule from this row would cover. */
  rule_scope: { source: string; description: string; match_count: number };
}

function requireTransaction(db: Db, id: number): TransactionRow {
  const row = getTransactionById(db, id);
  if (!row) throw new CorrectionError(404, `No transaction with id ${String(id)}`);
  return row;
}

function requireLeaf(value: unknown): Subcategory {
  const parsed = subcategorySchema.safeParse(value);
  if (!parsed.success)
    throw new CorrectionError(
      400,
      `Unknown subcategory ${JSON.stringify(value)}; choose a taxonomy leaf`,
    );
  return parsed.data;
}

export function getTransactionLabel(db: Db, id: number): TransactionLabel {
  return labelOf(db, requireTransaction(db, id));
}

function labelOf(db: Db, row: TransactionRow): TransactionLabel {
  const override = getTransactionOverride(db, row.id);
  const rule = getDescriptionRule(db, row.source, row.description_norm);
  return {
    transaction_id: row.id,
    source: row.source,
    account_id: row.account_id,
    posted_at: row.posted_at,
    amount_cents: row.amount_cents,
    currency: row.currency,
    description: row.description_norm,
    subcategory: row.subcategory,
    category: categoryOf(row.subcategory),
    category_origin: row.category_origin,
    origin_label: row.category_origin === null ? 'Unlabelled' : originLabels[row.category_origin],
    machine_subcategory: row.machine_subcategory,
    is_subscription: row.is_subscription === null ? null : row.is_subscription === 1,
    is_internal_transfer: row.is_internal_transfer === 1,
    transfer_override: row.transfer_override === null ? null : row.transfer_override === 1,
    transfer_source: row.transfer_source,
    override: override
      ? { subcategory: override.subcategory, updated_at: override.updated_at }
      : null,
    rule: rule ? { id: rule.id, subcategory: rule.subcategory, updated_at: rule.updated_at } : null,
    rule_scope: {
      source: row.source,
      description: row.description_norm,
      match_count: countRuleMatches(db, row.source, row.description_norm),
    },
  };
}

/** A user's transfer decision wins over future matching and survives re-imports. */
export function setTransferDecision(db: Db, transactionId: number, isTransfer: boolean) {
  return db.transaction(() => {
    const row = requireTransaction(db, transactionId);
    const affectedIds =
      row.transfer_pair_id === null
        ? [transactionId]
        : db
            .prepare<[number], { id: number }>(
              'SELECT id FROM transactions WHERE transfer_pair_id = ? ORDER BY id',
            )
            .all(row.transfer_pair_id)
            .map((item) => item.id);
    const update = db.prepare<[number, number, number]>(
      'UPDATE transactions SET transfer_override = ?, is_internal_transfer = ?, transfer_source = NULL WHERE id = ?',
    );
    for (const id of affectedIds) update.run(isTransfer ? 1 : 0, isTransfer ? 1 : 0, id);
    return { label: getTransactionLabel(db, transactionId), affected_ids: affectedIds };
  })();
}

/** Sets a correction for the row (transaction scope) or its description (description scope). */
export function setCorrection(
  db: Db,
  transactionId: number,
  scope: CorrectionScope,
  subcategory: unknown,
): TransactionLabel {
  const leaf = requireLeaf(subcategory);
  return db.transaction(() => {
    const row = requireTransaction(db, transactionId);
    if (scope === 'transaction') upsertTransactionOverride(db, row.id, leaf);
    else upsertDescriptionRule(db, row.source, row.description_norm, leaf);
    return getTransactionLabel(db, row.id);
  })();
}

/**
 * Removes the correction at the given scope. Returns the row's label afterwards
 * and whether anything was removed; a missing correction is not an error, so a
 * repeated removal is idempotent.
 */
export function removeCorrection(
  db: Db,
  transactionId: number,
  scope: CorrectionScope,
): { removed: boolean; label: TransactionLabel } {
  return db.transaction(() => {
    const row = requireTransaction(db, transactionId);
    const removed =
      scope === 'transaction'
        ? deleteTransactionOverride(db, row.id)
        : deleteDescriptionRule(db, row.source, row.description_norm);
    return { removed, label: getTransactionLabel(db, row.id) };
  })();
}
