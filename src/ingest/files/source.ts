/**
 * A `DataSource` over one parsed file. The pipeline sees the same interface
 * it always has; this is the one module that knows a CSV row from an OFX
 * `<STMTTRN>`. Everything is materialised up front (a bank export is small),
 * which is also what lets a preview show counts before anything is written.
 */

import { createHash } from 'node:crypto';
import type { Db } from '../../db/client.js';
import type {
  NormalisedAccount,
  NormalisedBalance,
  NormalisedTransaction,
  SourceId,
} from '../normalise.js';
import type { DataSource, ListBalancesOptions, MappingSkip, SkipReporting } from '../source.js';
import { getAccount, resolveTarget, toNormalisedAccount, type AccountTarget } from './account.js';
import { getAccountIdByExternalId } from '../../db/repo.js';
import { readCsv, type CsvTable, type Delimiter } from './csv.js';
import {
  applyOverrides,
  detectMapping,
  mapRows,
  type DetectedMapping,
  type MappingOverrides,
  type RowError,
} from './detect.js';
import {
  accountTypeFromOfx,
  looksLikeOfx,
  ofxDescription,
  parseOfx,
  type OfxDocument,
} from './ofx.js';

export type FileFormat = SourceId;

export interface FileImportInput {
  fileName: string;
  content: string;
  /** Detected from the file name and content when absent. */
  format?: FileFormat;
  /** Required for CSV. Optional for OFX, where it overrides the file's own account. */
  account?: AccountTarget;
  /** CSV only: pins over the detected mapping. */
  mapping?: MappingOverrides;
  /** CSV only: pins over the detected delimiter and header. */
  delimiter?: Delimiter;
  hasHeader?: boolean;
  /** OFX only: a name for the account the file identifies; default is built from the file. */
  accountName?: string;
}

export class FileImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileImportError';
  }
}

/** Everything a preview or an import needs to know about the file, format-independent. */
export interface PreparedFile {
  format: FileFormat;
  source: FileSource;
  /** Present for CSV: what was detected and the columns to show. */
  csv?: { table: CsvTable; detected: DetectedMapping };
  ofx?: OfxDocument;
}

export function detectFormat(fileName: string, content: string): FileFormat {
  if (/\.(ofx|qfx)$/i.test(fileName)) return 'ofx';
  if (/\.csv$/i.test(fileName)) return 'csv';
  return looksLikeOfx(content.slice(0, 4096)) ? 'ofx' : 'csv';
}

/**
 * Stable id for a CSV row, since a CSV carries none of its own:
 * account source | account external id | date | amount | raw description |
 * ordinal among identical rows in this file. Account external ids are unique
 * only within their source, so both parts are required. Two coffees on the
 * same day at the same price are rows 0 and 1 and both survive.
 */
export function csvExternalId(
  accountSource: string,
  accountExternalId: string,
  date: string,
  amountCents: number,
  description: string,
  ordinal: number,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'v2',
        accountSource,
        accountExternalId,
        date,
        amountCents,
        description,
        ordinal,
      ]),
    )
    .digest('hex');
}

/** The original hash is retained only for rows already stored under it. */
function legacyCsvExternalId(
  accountExternalId: string,
  date: string,
  amountCents: number,
  description: string,
  ordinal: number,
): string {
  return createHash('sha256')
    .update([accountExternalId, date, String(amountCents), description, String(ordinal)].join('|'))
    .digest('hex');
}

/** A balance whose observation time may be left for the pipeline to stamp. */
export type FileBalance = Omit<NormalisedBalance, 'asOf'> & { asOf?: string };

export class FileSource implements DataSource, SkipReporting {
  readonly skips: MappingSkip[];
  constructor(
    readonly id: FileFormat,
    readonly accounts: NormalisedAccount[],
    readonly transactions: NormalisedTransaction[],
    readonly balances: FileBalance[],
    readonly errors: RowError[],
  ) {
    this.skips = errors.map((e) => ({ externalId: `line ${String(e.line)}`, reason: e.message }));
  }
  get skipped(): number {
    return this.skips.length;
  }
  listAccounts(): Promise<NormalisedAccount[]> {
    return Promise.resolve(this.accounts);
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async *fetchTransactions(): AsyncIterable<NormalisedTransaction[]> {
    for (let i = 0; i < this.transactions.length; i += 500)
      yield this.transactions.slice(i, i + 500);
  }
  listBalances({ observedAt }: ListBalancesOptions): Promise<NormalisedBalance[]> {
    return Promise.resolve(
      this.balances.map(({ asOf, ...balance }) => ({ ...balance, asOf: asOf ?? observedAt })),
    );
  }
}

/** Parses the file and resolves its account without writing anything. */
export function prepareFile(db: Db, input: FileImportInput): PreparedFile {
  const format = input.format ?? detectFormat(input.fileName, input.content);
  return format === 'csv' ? prepareCsv(db, input) : prepareOfx(db, input);
}

function prepareCsv(db: Db, input: FileImportInput): PreparedFile {
  if (!input.account) throw new FileImportError('A CSV import needs an account to import into.');
  const account = resolveTarget(db, input.account);
  const table = readCsv(input.content, {
    ...(input.delimiter === undefined ? {} : { delimiter: input.delimiter }),
    ...(input.hasHeader === undefined ? {} : { hasHeader: input.hasHeader }),
  });
  const detected = applyOverrides(detectMapping(table), input.mapping ?? {}, table);
  const { rows, errors } = mapRows(table, detected.mapping);

  const seen = new Map<string, number>();
  const accountId = getAccountIdByExternalId(db, account.source, account.externalId);
  const legacyOwner = db.prepare<[string], { account_id: number }>(
    "SELECT account_id FROM transactions WHERE source = 'csv' AND external_id = ?",
  );
  const transactions: NormalisedTransaction[] = rows.map((row) => {
    const key = `${row.date}|${String(row.amountCents)}|${row.description}`;
    const ordinal = seen.get(key) ?? 0;
    seen.set(key, ordinal + 1);
    const legacyId = legacyCsvExternalId(
      account.externalId,
      row.date,
      row.amountCents,
      row.description,
      ordinal,
    );
    // Keep existing rows on their original ids. A legacy id belonging to a
    // different account is the old collision: give this row its own v2 id.
    const externalId =
      accountId !== undefined && legacyOwner.get(legacyId)?.account_id === accountId
        ? legacyId
        : csvExternalId(
            account.source,
            account.externalId,
            row.date,
            row.amountCents,
            row.description,
            ordinal,
          );
    return {
      source: 'csv',
      externalId,
      accountExternalId: account.externalId,
      postedAt: `${row.date}T00:00:00.000Z`,
      amountCents: row.amountCents,
      currency: account.currency,
      descriptionRaw: row.description,
      status: row.pending ? 'pending' : 'posted',
      raw: { line: row.line, ...row.raw },
    };
  });

  // The balance after the latest-dated row is dated to that statement day,
  // not the day this file happens to be imported. CSV gives no time of day;
  // use the end of its calendar day so reconciliation includes that day's rows.
  // Files run either way; the row nearest the file's "latest" end wins.
  const balances: FileBalance[] = [];
  const withBalance = rows.filter((r) => r.balanceCents !== undefined);
  if (withBalance.length) {
    const descending = rows.length > 1 && rows[0]!.date > rows[rows.length - 1]!.date;
    const latest = withBalance.reduce((best, row) =>
      row.date > best.date || (row.date === best.date && !descending) ? row : best,
    );
    balances.push({
      source: 'csv',
      accountExternalId: account.externalId,
      currentCents: latest.balanceCents!,
      currency: account.currency,
      asOf: `${latest.date}T23:59:59.999Z`,
      raw: { line: latest.line, date: latest.date },
    });
  }

  return {
    format: 'csv',
    source: new FileSource('csv', [account], transactions, balances, errors),
    csv: { table, detected },
  };
}

function prepareOfx(db: Db, input: FileImportInput): PreparedFile {
  const document = parseOfx(input.content);
  const override = input.account ? resolveTarget(db, input.account) : undefined;
  if (override && document.accounts.length > 1)
    throw new FileImportError(
      'This file holds several accounts; it can only be imported into the accounts it names.',
    );
  const accounts: NormalisedAccount[] = [];
  const transactions: NormalisedTransaction[] = [];
  const balances: FileBalance[] = [];
  for (const statement of document.accounts) {
    // An account this file identified on an earlier import keeps its stored
    // name and type; only an explicit name replaces them.
    const existing = getAccountIdByExternalId(db, 'ofx', statement.externalId);
    const stored =
      existing === undefined ? undefined : toNormalisedAccount(getAccount(db, existing)!);
    const account: NormalisedAccount = override ??
      (stored && !input.accountName?.trim() ? stored : undefined) ?? {
        source: 'ofx',
        externalId: statement.externalId,
        name:
          input.accountName?.trim() ||
          `${statement.institution ? `${statement.institution} ` : ''}${accountTypeFromOfx(statement.accountType).replace('_', ' ')} ${statement.accountId.slice(-4)}`,
        type: accountTypeFromOfx(statement.accountType),
        ...(statement.institution === undefined ? {} : { institution: statement.institution }),
        currency: statement.currency,
        raw: {
          accountId: statement.accountId,
          ...(statement.bankId === undefined ? {} : { bankId: statement.bankId }),
          accountType: statement.accountType,
        },
      };
    accounts.push(account);
    for (const trn of statement.transactions) {
      transactions.push({
        source: 'ofx',
        externalId: `${account.externalId}|${trn.fitId}`,
        accountExternalId: account.externalId,
        postedAt: trn.postedAt,
        ...(trn.userDate === undefined ? {} : { executedAt: trn.userDate }),
        amountCents: trn.amountCents,
        currency: statement.currency,
        descriptionRaw: ofxDescription(trn),
        status: 'posted',
        raw: trn.raw,
      });
    }
    if (statement.balance) {
      balances.push({
        source: 'ofx',
        accountExternalId: account.externalId,
        currentCents: statement.balance.currentCents,
        ...(statement.balance.availableCents === undefined
          ? {}
          : { availableCents: statement.balance.availableCents }),
        currency: statement.currency,
        ...(statement.balance.asOf === undefined ? {} : { asOf: statement.balance.asOf }),
        raw: statement.balance,
      });
    }
  }
  const errors: RowError[] = document.errors.map((e, i) => ({
    line: i + 1,
    message: `${e.fitId}: ${e.message}`,
  }));
  return {
    format: 'ofx',
    source: new FileSource('ofx', accounts, transactions, balances, errors),
    ofx: document,
  };
}
