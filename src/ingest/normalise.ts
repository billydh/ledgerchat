/**
 * Source-agnostic shapes. Everything downstream of ingest sees these and never
 * a file's own row layout, so a new file format needs no change past this file.
 *
 * Two invariants are enforced here rather than trusted:
 *   - money is an integer count of minor units, negative = money out;
 *   - timestamps are ISO-8601 in UTC, so string comparison is chronological.
 */

import { z } from 'zod';

/**
 * RFC3339 in UTC with an optional fractional part. A naive timestamp or a
 * numeric offset is rejected: mixed zones would break the ordering that every
 * date filter and `ORDER BY posted_at` in the tools relies on.
 */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

export const isoUtcDateTime = z
  .string()
  .regex(ISO_UTC, 'must be an ISO-8601 UTC timestamp ending in Z')
  .refine((value) => !Number.isNaN(Date.parse(value)), { error: 'is not a real date' });

export const currencyCode = z
  .string()
  .regex(/^[A-Z]{3}$/, 'must be an ISO-4217 alphabetic currency code');

/** Minor units. Negative is money out; a fractional value means a mapping bug. */
export const amountCents = z
  .number()
  .int('must be an integer number of minor units')
  .refine((value) => Number.isSafeInteger(value), { error: 'is outside the safe integer range' });

/** The file format a transaction came from. */
export const sourceId = z.enum(['csv', 'ofx']);
export type SourceId = z.infer<typeof sourceId>;

/**
 * Who named an account. An OFX file identifies its own account; a CSV cannot,
 * so its account is either created for the import or made by hand, and a
 * later file of either format may be imported into it.
 */
export const accountSource = z.enum(['csv', 'ofx', 'manual']);
export type AccountSource = z.infer<typeof accountSource>;

export const accountType = z.enum(['transaction', 'savings', 'credit_card', 'loan', 'other']);
export type AccountType = z.infer<typeof accountType>;

export const transactionStatus = z.enum(['pending', 'posted']);
export type TransactionStatus = z.infer<typeof transactionStatus>;

export const normalisedAccountSchema = z.object({
  source: accountSource,
  externalId: z.string().min(1),
  name: z.string().min(1),
  /** Product class, mapped onto the app's own set (OFX CHECKING is `transaction`). */
  type: accountType.optional(),
  institution: z.string().min(1).optional(),
  currency: currencyCode,
  /** The source record, untouched, so a mapping bug is recoverable from the DB. */
  raw: z.unknown(),
});

export type NormalisedAccount = z.infer<typeof normalisedAccountSchema>;

export const normalisedTransactionSchema = z.object({
  source: sourceId,
  externalId: z.string().min(1),
  /** Joins to `NormalisedAccount.externalId`, not to a database id. */
  accountExternalId: z.string().min(1),
  postedAt: isoUtcDateTime,
  executedAt: isoUtcDateTime.optional(),
  amountCents,
  currency: currencyCode,
  descriptionRaw: z.string().min(1),
  status: transactionStatus,
  raw: z.unknown(),
});

export type NormalisedTransaction = z.infer<typeof normalisedTransactionSchema>;

/**
 * A point-in-time observation of an account's balance, never a running total
 * derived from transactions. Sign follows the source: a liability such as a
 * mortgage arrives negative and is stored as sent, so the account's `type` is
 * what tells a reader whether a negative figure is money owed.
 */
export const normalisedBalanceSchema = z.object({
  source: sourceId,
  /** Joins to `NormalisedAccount.externalId`, not to a database id. */
  accountExternalId: z.string().min(1),
  currentCents: amountCents,
  availableCents: amountCents.optional(),
  currency: currencyCode,
  /** When the figure was observed. See the mapper for what the source supplies. */
  asOf: isoUtcDateTime,
  raw: z.unknown(),
});

export type NormalisedBalance = z.infer<typeof normalisedBalanceSchema>;

// --- description normalisation --------------------------------------------

/**
 * A full or masked card number. Handled before the generic token rule because
 * a real PAN arrives as four four-digit groups, each of which is too short to
 * look like a reference on its own.
 */
const CARD_NUMBER = /\b(?:[X*]{2,}[ -]?){1,4}\d{2,6}\b|\b(?:\d[ -]?){12,19}\b/g;

/** The label in front of a card number; the number itself falls to REFERENCE_TOKEN. */
const CARD_LABEL = /\bCARD\s*(?:NO\.?|NUM(?:BER)?)?\s*[:#]?\s*/g;

/** A labelled reference, receipt or authorisation number, label and value together. */
const LABELLED_REFERENCE =
  /\b(?:RECEIPT|RCPT|REFERENCE|REF|TRACE|AUTH|INVOICE|INV|TXN)\s*(?:NO\.?|NUM(?:BER)?)?\s*[:#]?\s*[A-Z0-9][A-Z0-9-]{2,}\b/g;

/**
 * An unlabelled identifier: a run of at least five alphanumerics carrying at
 * least three digits. That keeps store and suburb numbers such as
 * `WOOLWORTHS 3120` and drops terminal ids, BPAY references and CRNs such as
 * `950435` or `011P2475603410708A`.
 */
const REFERENCE_TOKEN = /\b[A-Z0-9]{5,}\b/g;
const MIN_DIGITS_FOR_REFERENCE = 3;

/** Separators left stranded once the identifiers around them are gone. */
const DANGLING_SEPARATORS = /\s*([,;:])(?=\s*[,;:])/g;
const EDGE_PUNCTUATION = /^[\s,;:.\-*/]+|[\s,;:.\-*/]+$/g;

/**
 * Collapses the per-transaction noise out of a description so that the same
 * merchant produces one string. This is what the categorisation cache is keyed
 * on and what the tools group by, so it must be pure and idempotent:
 * `f(f(x)) === f(x)` for every input.
 */
export function normaliseDescription(raw: string): string {
  let text = raw.toUpperCase();
  text = text.replace(CARD_NUMBER, ' ');
  text = text.replace(CARD_LABEL, ' ');
  text = text.replace(LABELLED_REFERENCE, ' ');
  text = text.replace(REFERENCE_TOKEN, (token) =>
    countDigits(token) >= MIN_DIGITS_FOR_REFERENCE ? ' ' : token,
  );
  text = text.replace(/\s+/g, ' ');
  text = text.replace(DANGLING_SEPARATORS, '');
  text = text.replace(/\s+([,;:])/g, '$1');
  return text.replace(EDGE_PUNCTUATION, '').replace(/\s+/g, ' ');
}

function countDigits(token: string): number {
  let digits = 0;
  for (const char of token) if (char >= '0' && char <= '9') digits++;
  return digits;
}
