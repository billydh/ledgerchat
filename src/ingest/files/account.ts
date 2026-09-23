/**
 * Which account a file goes into. An OFX file names its own account; a CSV
 * needs the caller to pick an existing account or describe a new one. Both
 * the CLI and the web routes resolve the same shape, so the rules live here.
 */

import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { getAccountIdByExternalId, upsertAccount, type AccountRow } from '../../db/repo.js';
import { accountType, currencyCode, type NormalisedAccount } from '../normalise.js';

export const newAccountSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  type: accountType,
  currency: currencyCode,
  institution: z.string().trim().min(1).max(100).optional(),
});
export type NewAccount = z.infer<typeof newAccountSchema>;

/** An existing account by id, or one to create for this import. */
export const accountTargetSchema = z.union([
  z.strictObject({ id: z.number().int().positive() }),
  z.strictObject({ create: newAccountSchema }),
]);
export type AccountTarget = z.infer<typeof accountTargetSchema>;

export class AccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountError';
  }
}

export function getAccount(db: Db, id: number): AccountRow | undefined {
  return db.prepare<[number], AccountRow>('SELECT * FROM accounts WHERE id = ?').get(id);
}

export function listAccounts(db: Db): AccountRow[] {
  return db.prepare<[], AccountRow>('SELECT * FROM accounts ORDER BY id').all();
}

/** Case-insensitive name match; undefined when there is no such account or several. */
export function findAccountByName(db: Db, name: string): AccountRow | undefined {
  const rows = db
    .prepare<[string], AccountRow>('SELECT * FROM accounts WHERE lower(name) = lower(?)')
    .all(name.trim());
  return rows.length === 1 ? rows[0] : undefined;
}

/**
 * A readable, stable external id for an account the user names: `everyday`,
 * `everyday-2` when taken. Stable matters because CSV row ids hash it, so a
 * re-import into the same account must see the same id.
 */
export function slugForAccount(db: Db, source: string, name: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'account';
  let slug = base;
  for (let n = 2; getAccountIdByExternalId(db, source, slug) !== undefined; n++)
    slug = `${base}-${String(n)}`;
  return slug;
}

/** The normalised account the source will report for an existing row. */
export function toNormalisedAccount(row: AccountRow): NormalisedAccount {
  const type = accountType.safeParse(row.type);
  return {
    source: row.source as NormalisedAccount['source'],
    externalId: row.external_id,
    name: row.name,
    ...(type.success ? { type: type.data } : {}),
    ...(row.institution === null ? {} : { institution: row.institution }),
    currency: row.currency,
    raw: JSON.parse(row.raw_json) as unknown,
  };
}

/** Creates an account by hand (the `manual` source) and returns its row. */
export function createAccount(db: Db, input: NewAccount): AccountRow {
  const externalId = slugForAccount(db, 'manual', input.name);
  const id = upsertAccount(db, {
    source: 'manual',
    externalId,
    name: input.name,
    type: input.type,
    institution: input.institution ?? null,
    currency: input.currency,
    raw: { created: 'manual' },
  });
  return getAccount(db, id)!;
}

/**
 * Deletes an account with everything imported into or saved against it.
 * Transactions, balances, holdings and context entries naming the account
 * (goals, protected accounts) cascade; import runs keep their history with
 * the account unset. A transfer counterpart in another account is unpaired first so it is
 * not left pointing at a row that no longer exists; the next categorise run's
 * heuristic pass may flag it again on its own. False when there is no such
 * account.
 */
export function deleteAccount(db: Db, id: number): boolean {
  return db.transaction(() => {
    if (!getAccount(db, id)) return false;
    db.prepare<[number]>(
      `UPDATE transactions
       SET is_internal_transfer = 0, transfer_source = NULL, transfer_pair_id = NULL
       WHERE transfer_pair_id IN (SELECT id FROM transactions WHERE account_id = ?)`,
    ).run(id);
    db.prepare<[number]>('DELETE FROM accounts WHERE id = ?').run(id);
    return true;
  })();
}

/**
 * Resolves a target to the normalised account the source will list, without
 * writing anything: a new account is described here and only created by the
 * pipeline's account upsert, so a preview never leaves a row behind.
 */
export function resolveTarget(db: Db, target: AccountTarget): NormalisedAccount {
  if ('id' in target) {
    const row = getAccount(db, target.id);
    if (!row) throw new AccountError(`No account with id ${String(target.id)}.`);
    return toNormalisedAccount(row);
  }
  const { create } = target;
  return {
    source: 'manual',
    externalId: slugForAccount(db, 'manual', create.name),
    name: create.name,
    type: create.type,
    ...(create.institution === undefined ? {} : { institution: create.institution }),
    currency: create.currency,
    raw: { created: 'import' },
  };
}
