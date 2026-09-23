/**
 * pnpm import:file <file> [--account <name|id>] [--create-account <name>] [--type <type>]
 *   [--currency AUD] [--institution <name>] [--date-format <format>] [--sign <convention>]
 *   [--map date=Col,amount=Col,debit=Col,credit=Col,description=Col,memo=Col,balance=Col]
 *   [--dry-run] [--yes]
 *
 * Without flags the file's columns are auto-detected and the preview is
 * printed before a confirmation prompt. `--dry-run` prints the preview only.
 * A column is named by its header or its 1-based position.
 */

import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { openDb, type Db } from '../db/client.js';
import { accountType, type AccountType } from '../ingest/normalise.js';
import { findAccountByName, getAccount, type AccountTarget } from '../ingest/files/account.js';
import type { MappingOverrides, SignConvention } from '../ingest/files/detect.js';
import { importFile, previewImport, type ImportPreview } from '../ingest/files/import.js';
import { describeImportCounts } from '../ingest/pipeline.js';
import { DATE_FORMATS, type DateFormat } from '../ingest/files/values.js';

const USAGE = `Usage: pnpm import:file <file> [options]
  --account <name|id>        import into an existing account
  --create-account <name>    create the account first (with --type, --currency, --institution)
  --type <type>              ${accountType.options.join(' | ')} (default transaction)
  --currency <code>          ISO 4217 code for a new account (default AUD)
  --institution <name>       institution for a new account
  --account-name <name>      OFX: name for the account the file identifies
  --date-format <format>     ${DATE_FORMATS.join(' | ')}
  --sign <convention>        spend_negative | spend_positive
  --map <role=Col,...>       date, amount, debit, credit, description, memo, balance;
                             Col is a header name or a 1-based column number
  --dry-run                  print the preview and stop
  --yes                      import without asking`;

interface Args {
  file: string;
  account?: string;
  createAccount?: string;
  type: AccountType;
  currency: string;
  institution?: string;
  accountName?: string;
  dateFormat?: DateFormat;
  sign?: SignConvention;
  map?: string;
  dryRun: boolean;
  yes: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { file: '', type: 'transaction', currency: 'AUD', dryRun: false, yes: false };
  const value = (i: number, flag: string) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value\n${USAGE}`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case '--account':
        args.account = value(i++, arg);
        break;
      case '--create-account':
        args.createAccount = value(i++, arg);
        break;
      case '--type': {
        const parsed = accountType.safeParse(value(i++, arg));
        if (!parsed.success)
          throw new Error(`--type must be one of ${accountType.options.join(', ')}`);
        args.type = parsed.data;
        break;
      }
      case '--currency':
        args.currency = value(i++, arg).toUpperCase();
        break;
      case '--institution':
        args.institution = value(i++, arg);
        break;
      case '--account-name':
        args.accountName = value(i++, arg);
        break;
      case '--date-format': {
        const format = value(i++, arg);
        if (!(DATE_FORMATS as readonly string[]).includes(format))
          throw new Error(`--date-format must be one of ${DATE_FORMATS.join(', ')}`);
        args.dateFormat = format as DateFormat;
        break;
      }
      case '--sign': {
        const sign = value(i++, arg);
        if (sign !== 'spend_negative' && sign !== 'spend_positive')
          throw new Error('--sign must be spend_negative or spend_positive');
        args.sign = sign;
        break;
      }
      case '--map':
        args.map = value(i++, arg);
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--yes':
      case '-y':
        args.yes = true;
        break;
      default:
        if (arg.startsWith('--') || args.file) throw new Error(USAGE);
        args.file = arg;
    }
  }
  if (!args.file) throw new Error(USAGE);
  if (args.account && args.createAccount)
    throw new Error('Give --account or --create-account, not both');
  return args;
}

/** `--map` names columns by header or 1-based number; the overrides want 0-based indexes. */
function parseMap(spec: string, columns: readonly string[]): MappingOverrides {
  const overrides: MappingOverrides = {};
  const roles = new Set(['date', 'amount', 'debit', 'credit', 'description', 'memo', 'balance']);
  for (const pair of spec.split(',')) {
    const [role, ...rest] = pair.split('=');
    const name = rest.join('=').trim();
    if (!role || !roles.has(role.trim()) || !name)
      throw new Error(`--map: expected role=Column, got "${pair}"`);
    let index = columns.findIndex((c) => c.toLowerCase() === name.toLowerCase());
    if (index === -1 && /^\d+$/.test(name)) index = Number(name) - 1;
    if (index < 0 || index >= columns.length)
      throw new Error(
        `--map: no column "${name}"; columns are ${columns.map((c, i) => `${String(i + 1)}:${c}`).join(', ')}`,
      );
    (overrides as Record<string, number>)[role.trim()] = index;
  }
  return overrides;
}

function resolveAccountFlag(db: Db, args: Args): AccountTarget | undefined {
  if (args.createAccount) {
    return {
      create: {
        name: args.createAccount,
        type: args.type,
        currency: args.currency,
        ...(args.institution === undefined ? {} : { institution: args.institution }),
      },
    };
  }
  if (args.account === undefined) return undefined;
  const byId = /^\d+$/.test(args.account) ? getAccount(db, Number(args.account)) : undefined;
  const row = byId ?? findAccountByName(db, args.account);
  if (!row)
    throw new Error(
      `No account "${args.account}". Use --create-account to make one, or pnpm import:file --help.`,
    );
  return { id: row.id };
}

const money = (cents: number, currency: string) =>
  `${cents < 0 ? '-' : ''}${currency} ${(Math.abs(cents) / 100).toFixed(2)}`;

export function formatPreview(preview: ImportPreview): string {
  const lines: string[] = [];
  lines.push(`${preview.file_name} (${preview.format.toUpperCase()})`);
  for (const account of preview.accounts)
    lines.push(
      `account: ${account.name} [${account.type ?? 'unknown'}, ${account.currency}]${account.id === null ? ' (will be created)' : ` (id ${String(account.id)})`}`,
    );
  if (preview.mapping) {
    const m = preview.mapping;
    lines.push(
      `columns: ${m.columns.map((c, i) => `${String(i + 1)}:${c}`).join(', ')} (delimiter ${JSON.stringify(m.delimiter)}, ${m.has_header ? 'header row' : 'no header'})`,
    );
    for (const role of m.roles) {
      const cols = role.columns.map((i) => m.columns[i] ?? String(i + 1)).join(' / ');
      const detail =
        role.role === 'date'
          ? `${cols}, ${m.date_format}${m.ambiguous_date ? ' (ambiguous: pass --date-format to confirm)' : ''}`
          : role.role === 'sign'
            ? m.amount_kind === 'split'
              ? 'debit/credit pair'
              : m.sign
            : cols || '(none)';
      lines.push(`  ${role.role.padEnd(12)} ${detail}  [${Math.round(role.confidence * 100)}%]`);
    }
  }
  for (const balance of preview.balances)
    lines.push(
      `balance: ${money(balance.current_cents, preview.accounts.find((a) => a.external_id === balance.account_external_id)?.currency ?? '')}${balance.as_of ? ` as of ${balance.as_of}` : ''}`,
    );
  lines.push(
    `${String(preview.row_count)} rows, ${String(preview.existing_count)} already stored (updated or unchanged once imported), ${String(preview.error_count)} errors`,
  );
  for (const error of preview.errors.slice(0, 10))
    lines.push(`  error line ${String(error.line)}: ${error.message}`);
  if (preview.errors.length > 10) lines.push(`  ... ${String(preview.errors.length - 10)} more`);
  if (preview.rows.length) {
    lines.push('');
    lines.push(`first ${String(preview.rows.length)} rows:`);
    for (const row of preview.rows)
      lines.push(
        `  ${row.date}  ${money(row.amount_cents, row.currency).padStart(16)}  ${row.description}${row.status === 'pending' ? '  (pending)' : ''}${row.exists ? '  (already stored)' : ''}`,
      );
  }
  return lines.join('\n');
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return;
  }
  const args = parseArgs(argv);
  const path = resolve(args.file);
  const content = readFileSync(path, 'utf8');
  const db = openDb();
  try {
    const account = resolveAccountFlag(db, args);
    const base = {
      fileName: basename(path),
      content,
      ...(account === undefined ? {} : { account }),
      ...(args.accountName === undefined ? {} : { accountName: args.accountName }),
    };
    // A first pass detects the columns so --map can name them by header.
    const first = previewImport(db, base);
    const overrides: MappingOverrides = {
      ...(args.map && first.mapping ? parseMap(args.map, first.mapping.columns) : {}),
      ...(args.dateFormat === undefined ? {} : { dateFormat: args.dateFormat }),
      ...(args.sign === undefined ? {} : { sign: args.sign }),
    };
    const input = { ...base, ...(Object.keys(overrides).length ? { mapping: overrides } : {}) };
    const preview = Object.keys(overrides).length ? previewImport(db, input) : first;
    console.log(formatPreview(preview));
    if (args.dryRun) return;
    if (preview.row_count === 0) throw new Error('Nothing to import.');
    if (!args.yes && !(await confirm(`Import ${String(preview.row_count)} rows?`))) {
      console.log('Cancelled.');
      return;
    }
    const result = await importFile(db, input);
    console.log(
      `run ${String(result.runId)}: ${result.status}; ${describeImportCounts(result)} in ${String(result.elapsedMs)} ms`,
    );
    if (result.status === 'error') throw new Error(result.error ?? 'Import failed');
    console.log('Run pnpm categorise to label the new transactions.');
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
