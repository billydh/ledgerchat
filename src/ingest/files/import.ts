/**
 * The two operations the CLI and the web routes share: preview a file without
 * writing, or import it. Both go through `prepareFile`, so what the preview
 * shows is exactly what the import would write.
 */

import type { Db } from '../../db/client.js';
import type { ImportRunRow } from '../../db/repo.js';
import { getImportRun } from '../../db/repo.js';
import type { LlmBackend } from '../../llm/backend.js';
import { runImport, type ImportResult } from '../pipeline.js';
import type { DateFormat } from './values.js';
import type { MappingRole, SignConvention } from './detect.js';
import { prepareFile, type FileFormat, type FileImportInput } from './source.js';

export const PREVIEW_ROWS = 20;

export interface PreviewRow {
  /** Line in a CSV file; record number in an OFX file. */
  line: number;
  date: string;
  amount_cents: number;
  currency: string;
  description: string;
  status: 'pending' | 'posted';
  /** True when a row with this external id is already stored. */
  exists: boolean;
}

export interface PreviewAccount {
  /** Internal id when the account already exists; null when the import creates it. */
  id: number | null;
  name: string;
  type: string | null;
  currency: string;
  external_id: string;
}

/** One role of the CSV mapping as the UI presents it. */
export interface PreviewMappingRole {
  role: MappingRole | 'memo' | 'status';
  /** 0-based column indexes; a debit/credit amount lists two. */
  columns: number[];
  confidence: number;
}

export interface PreviewMapping {
  columns: string[];
  delimiter: string;
  has_header: boolean;
  roles: PreviewMappingRole[];
  date_format: DateFormat;
  /** The file cannot tell DD/MM from MM/DD; the format above is a default. */
  ambiguous_date: boolean;
  sign: SignConvention;
  amount_kind: 'signed' | 'split';
}

/** The contract both the CLI (`--dry-run`) and the web import view render. */
export interface ImportPreview {
  format: FileFormat;
  file_name: string;
  accounts: PreviewAccount[];
  /** Rows that parsed and would be written. */
  row_count: number;
  /** Of those, how many already exist by external id. */
  existing_count: number;
  error_count: number;
  errors: { line: number; message: string }[];
  rows: PreviewRow[];
  /** A balance the file carries, per account external id. */
  balances: { account_external_id: string; current_cents: number; as_of: string | null }[];
  mapping: PreviewMapping | null;
}

export function previewImport(db: Db, input: FileImportInput): ImportPreview {
  const prepared = prepareFile(db, input);
  const { source } = prepared;
  const exists = db.prepare<[string, string], { n: number }>(
    'SELECT count(*) n FROM transactions WHERE source = ? AND external_id = ?',
  );
  const stored = (t: { source: string; externalId: string }) =>
    exists.get(t.source, t.externalId)!.n > 0;
  const existing = source.transactions.filter(stored).length;
  const accounts: PreviewAccount[] = source.accounts.map((account) => ({
    id:
      db
        .prepare<[string, string], { id: number }>(
          'SELECT id FROM accounts WHERE source = ? AND external_id = ?',
        )
        .get(account.source, account.externalId)?.id ?? null,
    name: account.name,
    type: account.type ?? null,
    currency: account.currency,
    external_id: account.externalId,
  }));
  const rows: PreviewRow[] = source.transactions.slice(0, PREVIEW_ROWS).map((t) => ({
    line:
      typeof (t.raw as { line?: unknown }).line === 'number' ? (t.raw as { line: number }).line : 0,
    date: t.postedAt.slice(0, 10),
    amount_cents: t.amountCents,
    currency: t.currency,
    description: t.descriptionRaw,
    status: t.status,
    exists: stored(t),
  }));
  let mapping: PreviewMapping | null = null;
  if (prepared.csv) {
    const { table, detected } = prepared.csv;
    const m = detected.mapping;
    const roles: PreviewMappingRole[] = [
      { role: 'date', columns: [m.date], confidence: detected.confidence.date },
      {
        role: 'amount',
        columns: m.amount.kind === 'signed' ? [m.amount.column] : [m.amount.debit, m.amount.credit],
        confidence: detected.confidence.amount,
      },
      { role: 'sign', columns: [], confidence: detected.confidence.sign },
      {
        role: 'description',
        columns: [m.description],
        confidence: detected.confidence.description,
      },
    ];
    if (m.memo !== undefined) roles.push({ role: 'memo', columns: [m.memo], confidence: 1 });
    roles.push({
      role: 'balance',
      columns: m.balance === undefined ? [] : [m.balance],
      confidence: detected.confidence.balance,
    });
    if (m.status !== undefined) roles.push({ role: 'status', columns: [m.status], confidence: 1 });
    mapping = {
      columns: table.columns,
      delimiter: table.delimiter,
      has_header: table.hasHeader,
      roles,
      date_format: m.dateFormat,
      ambiguous_date: detected.ambiguousDate,
      sign: m.sign,
      amount_kind: m.amount.kind,
    };
  }
  return {
    format: prepared.format,
    file_name: input.fileName,
    accounts,
    row_count: source.transactions.length,
    existing_count: existing,
    error_count: source.errors.length,
    errors: source.errors,
    rows,
    balances: source.balances.map((b) => ({
      account_external_id: b.accountExternalId,
      current_cents: b.currentCents,
      as_of: b.asOf ?? null,
    })),
    mapping,
  };
}

export interface ImportFileOptions {
  /** Categorise as part of the import. Off by default: the result is visible before the LLM runs. */
  backend?: LlmBackend;
  now?: () => number;
}

export interface ImportFileResult extends ImportResult {
  run: ImportRunRow;
}

/** Parses, upserts, matches transfers and records the run. Categorisation is a separate step. */
export async function importFile(
  db: Db,
  input: FileImportInput,
  options: ImportFileOptions = {},
): Promise<ImportFileResult> {
  const prepared = prepareFile(db, input);
  const result = await runImport(db, prepared.source, {
    fileName: input.fileName,
    ...(options.backend === undefined ? {} : { backend: options.backend }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { ...result, run: getImportRun(db, result.runId)! };
}
