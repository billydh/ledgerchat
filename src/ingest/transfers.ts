/**
 * Flags money moving between the user's own accounts so that spending totals do
 * not count it twice: a $500 move from Everyday to Savings is one debit and one
 * credit, and summing debits without this pass reports $500 of "spending" that
 * never left the user.
 *
 * A pair needs two independently transfer-like descriptions as well as matching
 * amount, currency and date. An unpaired model hint is not proof that money
 * moved to another account the user owns. Automatic matches are recalculated
 * after imports because source facts can change. Explicit user decisions win
 * and survive re-imports.
 */

import type { Db } from '../db/client.js';

/**
 * Legs of the same transfer settle on different days: the debit posts when it
 * leaves, the credit when the receiving institution acknowledges it. Three days
 * covers a weekend; wider starts pairing genuinely unrelated equal amounts.
 */
export const TRANSFER_WINDOW_DAYS = 3;

export interface TransferMatchResult {
  /** Transfers linked by the pair pass; each counts one pair, not two rows. */
  pairsCreated: number;
  /** Kept for the existing progress contract; unpaired hints are no longer hidden. */
  heuristicFlagged: number;
}

interface CandidateRow {
  a_id: number;
  b_id: number;
}

/**
 * Every plausible pairing. A row must have exactly one candidate to be
 * matched automatically; date proximity cannot safely settle ambiguity.
 *
 * `b.amount_cents = -a.amount_cents` is the equal-magnitude-opposite-sign test
 * in one clause; the `<> 0` guard keeps zero-amount rows out, since 0 = -0
 * would otherwise make every one of them a candidate for every other.
 *
 * `b.id > a.id` yields each unordered pair once rather than twice.
 *
 * Currency equality is a departure from the ticket, which specifies only equal
 * magnitude - 100 AUD out and 100 USD in are not the two legs of one transfer.
 *
 * Manually reviewed rows and their counterparts are excluded from candidates.
 */
const SELECT_CANDIDATES = `
  SELECT a.id AS a_id,
         b.id AS b_id
  FROM transactions a
  JOIN transactions b
    ON b.id > a.id
   AND b.amount_cents = -a.amount_cents
   AND b.account_id <> a.account_id
   AND b.currency = a.currency
   AND abs(julianday(a.posted_at) - julianday(b.posted_at)) <= @window
  JOIN description_categories a_hint
    ON a_hint.description_norm = a.description_norm AND a_hint.transfer_hint = 1
  JOIN description_categories b_hint
    ON b_hint.description_norm = b.description_norm AND b_hint.transfer_hint = 1
  WHERE a.amount_cents <> 0
    AND a.status = 'posted' AND b.status = 'posted'
    AND a.transfer_pair_id IS NULL
    AND b.transfer_pair_id IS NULL
    AND a.transfer_override IS NULL AND b.transfer_override IS NULL
  ORDER BY a_id ASC, b_id ASC`;

const MARK_PAIRED = `
  UPDATE transactions
  SET is_internal_transfer = 1, transfer_source = 'pair', transfer_pair_id = @pair_id
  WHERE id = @id`;

/**
 * Rechecks automatic pairs in one transaction. A changed source amount, date,
 * currency or description can invalidate a former pair; manual decisions stay.
 */
export function matchInternalTransfers(db: Db): TransferMatchResult {
  return db.transaction(() => {
    const previous = new Map(
      db
        .prepare<[], { id: number; transfer_pair_id: number }>(
          "SELECT id, transfer_pair_id FROM transactions WHERE transfer_source = 'pair' AND transfer_override IS NULL",
        )
        .all()
        .map((row) => [row.id, row.transfer_pair_id]),
    );
    db.prepare(
      "UPDATE transactions SET is_internal_transfer = 0, transfer_source = NULL, transfer_pair_id = NULL WHERE transfer_override IS NULL AND transfer_source IN ('pair', 'heuristic')",
    ).run();
    const pairsCreated = matchPairs(db, previous);
    return { pairsCreated, heuristicFlagged: 0 };
  })();
}

/** Match only mutually unique candidates, leaving ambiguous rows visible. */
function matchPairs(db: Db, previous: ReadonlyMap<number, number>): number {
  const candidates = db
    .prepare<{ window: number }, CandidateRow>(SELECT_CANDIDATES)
    .all({ window: TRANSFER_WINDOW_DAYS });

  const markPaired = db.prepare<{ id: number; pair_id: number }>(MARK_PAIRED);
  const candidateCounts = new Map<number, number>();
  for (const candidate of candidates) {
    candidateCounts.set(candidate.a_id, (candidateCounts.get(candidate.a_id) ?? 0) + 1);
    candidateCounts.set(candidate.b_id, (candidateCounts.get(candidate.b_id) ?? 0) + 1);
  }
  let pairsCreated = 0;

  for (const candidate of candidates) {
    if (candidateCounts.get(candidate.a_id) !== 1 || candidateCounts.get(candidate.b_id) !== 1)
      continue;

    // The lower of the two transaction ids names the pair. A row belongs to at
    // most one pair, so no two pairs can pick the same id.
    const pairId = Math.min(candidate.a_id, candidate.b_id);
    markPaired.run({ id: candidate.a_id, pair_id: pairId });
    markPaired.run({ id: candidate.b_id, pair_id: pairId });
    if (previous.get(candidate.a_id) !== pairId || previous.get(candidate.b_id) !== pairId)
      pairsCreated++;
  }

  return pairsCreated;
}
