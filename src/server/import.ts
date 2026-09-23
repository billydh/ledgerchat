/**
 * File import over HTTP: preview, commit, accounts, and a categorise
 * run streamed as SSE. The file arrives as multipart form data and is held in
 * memory for the request only; nothing is written to disk. Every parse or
 * mapping problem the file layer raises is a 400 with its own message, since
 * those messages are written for the user; anything else stays a 500.
 */

import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { categorise } from '../ingest/categorise.js';
import {
  AccountError,
  accountTargetSchema,
  createAccount,
  deleteAccount,
  listAccounts,
  newAccountSchema,
} from '../ingest/files/account.js';
import { CsvParseError } from '../ingest/files/csv.js';
import { MappingError } from '../ingest/files/detect.js';
import { importFile, previewImport } from '../ingest/files/import.js';
import { OfxParseError } from '../ingest/files/ofx.js';
import { FileImportError, type FileImportInput } from '../ingest/files/source.js';
import { LedgerNotEmptyError, loadSampleData } from '../ingest/sample.js';
import { DATE_FORMATS } from '../ingest/files/values.js';
import { matchInternalTransfers } from '../ingest/transfers.js';
import type { LlmBackend } from '../llm/backend.js';
import type { BackendStatus } from './backends.js';
import type { Tenant } from './tenancy.js';

export const MAX_FILE_BYTES = 20 * 1024 * 1024;

const column = z.number().int().min(0).max(1000);
const optionsSchema = z.strictObject({
  account: accountTargetSchema.optional(),
  accountName: z.string().trim().min(1).max(100).optional(),
  format: z.enum(['csv', 'ofx']).optional(),
  delimiter: z.enum([',', ';', '\t']).optional(),
  hasHeader: z.boolean().optional(),
  mapping: z
    .strictObject({
      date: column.optional(),
      dateFormat: z.enum(DATE_FORMATS).optional(),
      amount: column.optional(),
      debit: column.optional(),
      credit: column.optional(),
      sign: z.enum(['spend_negative', 'spend_positive']).optional(),
      description: column.optional(),
      memo: column.nullable().optional(),
      balance: column.nullable().optional(),
      status: column.nullable().optional(),
    })
    .optional(),
});

const categoriseSchema = z.strictObject({ backend: z.string().min(1).max(300).optional() });
const sampleSchema = z.strictObject({
  backend: z.string().min(1).max(300).optional(),
  /** Load the rows without labelling them, even when a backend is available. */
  categorise: z.boolean().optional(),
});

export interface ImportRouteOptions {
  tenant: (c: Context) => Tenant;
  resolveBackend: (spec: string) => Promise<LlmBackend>;
  backendStatus: () => Promise<BackendStatus[]>;
  defaultBackend?: () => string;
}

type Parsed =
  { ok: true; input: FileImportInput } | { ok: false; error: string; status: 400 | 413 };

/** Reads the multipart body into a `FileImportInput`, enforcing the size cap. */
async function readUpload(c: {
  req: {
    header: (n: string) => string | undefined;
    parseBody: () => Promise<Record<string, unknown>>;
  };
}): Promise<Parsed> {
  const declared = Number(c.req.header('content-length') ?? '0');
  if (declared > MAX_FILE_BYTES + 64 * 1024) return { ok: false, error: tooLarge(), status: 413 };
  let body: Record<string, unknown>;
  try {
    body = await c.req.parseBody();
  } catch {
    return { ok: false, error: 'Expected a multipart form with a file field.', status: 400 };
  }
  const file = body.file;
  if (!(file instanceof File))
    return { ok: false, error: 'Attach the export as the file field.', status: 400 };
  if (file.size > MAX_FILE_BYTES) return { ok: false, error: tooLarge(), status: 413 };
  if (file.size === 0) return { ok: false, error: 'The file is empty.', status: 400 };
  let options: z.infer<typeof optionsSchema> = {};
  if (typeof body.options === 'string' && body.options.trim() !== '') {
    const parsed = optionsSchema.safeParse(safeJson(body.options));
    if (!parsed.success) return { ok: false, error: 'Invalid import options.', status: 400 };
    options = parsed.data;
  }
  const content = await file.text();
  const input: FileImportInput = {
    fileName: file.name || 'upload',
    content,
    ...(options.format === undefined ? {} : { format: options.format }),
    ...(options.account === undefined ? {} : { account: options.account }),
    ...(options.accountName === undefined ? {} : { accountName: options.accountName }),
    ...(options.delimiter === undefined ? {} : { delimiter: options.delimiter }),
    ...(options.hasHeader === undefined ? {} : { hasHeader: options.hasHeader }),
    ...(options.mapping === undefined ? {} : { mapping: compact(options.mapping) }),
  };
  return { ok: true, input };
}

/** Zod infers optional keys as `T | undefined`; the file layer's inputs never carry undefined. */
function compact<T extends object>(value: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };
}

const tooLarge = () =>
  `The file is larger than ${String(MAX_FILE_BYTES / 1024 / 1024)} MB. Export a shorter date range and try again.`;

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Problems the file layer explains in the user's terms. */
function userFacing(error: unknown): string | undefined {
  if (
    error instanceof FileImportError ||
    error instanceof MappingError ||
    error instanceof CsvParseError ||
    error instanceof OfxParseError ||
    error instanceof AccountError
  )
    return error.message;
  return undefined;
}

export function importRoutes(options: ImportRouteOptions) {
  const { tenant } = options;
  const app = new Hono();

  app.get('/accounts', (c) =>
    c.json({
      accounts: listAccounts(tenant(c).db).map((row) => ({
        id: row.id,
        name: row.name,
        type: row.type,
        institution: row.institution,
        currency: row.currency,
        source: row.source,
      })),
    }),
  );

  app.post('/accounts', async (c) => {
    const parsed = newAccountSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success)
      return c.json(
        {
          error:
            'Expected name, type (transaction, savings, credit_card, loan, other) and a currency code.',
        },
        400,
      );
    const row = createAccount(tenant(c).db, parsed.data);
    return c.json(
      {
        id: row.id,
        name: row.name,
        type: row.type,
        institution: row.institution,
        currency: row.currency,
        source: row.source,
      },
      201,
    );
  });

  app.delete('/accounts/:id', (c) => {
    const id = z.coerce.number().int().positive().safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: 'Invalid account id.' }, 400);
    return deleteAccount(tenant(c).db, id.data)
      ? c.body(null, 204)
      : c.json({ error: 'No such account.' }, 404);
  });

  app.post('/import/preview', async (c) => {
    const upload = await readUpload(c);
    if (!upload.ok) return c.json({ error: upload.error }, upload.status);
    try {
      return c.json(previewImport(tenant(c).db, upload.input));
    } catch (error) {
      const message = userFacing(error);
      if (message) return c.json({ error: message }, 400);
      throw error;
    }
  });

  app.post('/import', async (c) => {
    const upload = await readUpload(c);
    if (!upload.ok) return c.json({ error: upload.error }, upload.status);
    const { db } = tenant(c);
    try {
      const result = await importFile(db, upload.input);
      const { run, ...rest } = result;
      return c.json({ run, result: rest }, result.status === 'ok' ? 200 : 500);
    } catch (error) {
      const message = userFacing(error);
      if (message) return c.json({ error: message }, 400);
      throw error;
    }
  });

  // Categorise everything unlabelled, streaming a progress line per batch.
  // One run per tenant at a time: two would fight over the same description cache.
  app.post('/categorise', async (c) => {
    const { db, state } = tenant(c);
    const parsed = categoriseSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'Expected an optional backend spec.' }, 400);
    const spec = parsed.data.backend ?? options.defaultBackend?.() ?? '';
    let backend: LlmBackend;
    try {
      const available = await options.backendStatus();
      if (!available.some((b) => b.spec === spec && b.configured && b.reachable !== false))
        throw new Error('Unavailable backend');
      backend = await options.resolveBackend(spec);
    } catch {
      return c.json(
        { error: 'Invalid or unconfigured backend spec. Choose an available backend.' },
        400,
      );
    }
    if (state.categorising)
      return c.json({ error: 'A categorise run is already in progress.' }, 409);
    state.categorising = true;
    return streamSSE(
      c,
      async (stream) => {
        const emit = (event: unknown) => stream.writeSSE({ data: JSON.stringify(event) });
        try {
          const result = await categorise(db, backend, {
            onProgress: (progress) => void emit({ type: 'progress', ...progress }),
          });
          const transfers = matchInternalTransfers(db);
          await emit({
            type: 'done',
            backend: result.backend,
            new_descriptions: result.newDescriptions,
            categorised: result.categorisedDescriptions,
            batches: result.batches,
            failures: result.failures.length,
            transactions_updated: result.transactionsUpdated,
            transfers,
          });
        } catch {
          await emit({
            type: 'error',
            error: 'Categorisation failed. Check the backend and try again.',
          });
        } finally {
          state.categorising = false;
        }
      },
      // Hono only calls this for errors thrown before the handler's own try.
      () => {
        state.categorising = false;
        return Promise.resolve();
      },
    );
  });

  // The committed sample dataset: three accounts imported through the
  // ordinary file path, then one categorise run, all streamed as SSE. Only an
  // empty ledger takes it, so the sample never mixes with a person's own
  // rows. Loading without a usable backend is allowed; the rows stay unlabelled until a later categorise run, as after an import.
  app.post('/sample', async (c) => {
    const { db, state } = tenant(c);
    const parsed = sampleSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'Expected an optional backend spec.' }, 400);
    let backend: LlmBackend | undefined;
    if (parsed.data.categorise !== false) {
      const spec = parsed.data.backend ?? options.defaultBackend?.() ?? '';
      const available = await options.backendStatus().catch(() => []);
      if (available.some((b) => b.spec === spec && b.configured && b.reachable !== false))
        backend = await options.resolveBackend(spec).catch(() => undefined);
      if (!backend && parsed.data.backend)
        return c.json(
          { error: 'Invalid or unconfigured backend spec. Choose an available backend.' },
          400,
        );
    }
    // Everything from here to the flag is synchronous, so two loads cannot
    // both find the ledger empty.
    if (state.categorising)
      return c.json({ error: 'A categorise run is already in progress.' }, 409);
    const rows = db.prepare<[], { n: number }>('SELECT count(*) n FROM transactions').get()!.n;
    const accounts = db.prepare<[], { n: number }>('SELECT count(*) n FROM accounts').get()!.n;
    if (rows || accounts)
      return c.json(
        {
          error: 'Sample data can only be loaded into an empty ledger. Delete your accounts first.',
        },
        409,
      );
    state.categorising = true;
    return streamSSE(
      c,
      async (stream) => {
        const emit = (event: unknown) => stream.writeSSE({ data: JSON.stringify(event) });
        try {
          const result = await loadSampleData(db, {
            ...(backend ? { backend } : {}),
            onProgress: (progress) =>
              void emit(
                progress.stage === 'import'
                  ? { type: 'import', ...progress }
                  : { type: 'progress', ...progress },
              ),
          });
          await emit({
            type: 'done',
            accounts: result.accounts,
            transactions: result.accounts.reduce((n, a) => n + a.inserted, 0),
            ...(result.categorise
              ? {
                  backend: result.categorise.backend,
                  new_descriptions: result.categorise.newDescriptions,
                  categorised: result.categorise.categorisedDescriptions,
                  failures: result.categorise.failures.length,
                  transfers: result.transfers,
                }
              : { categorised: 0 }),
          });
        } catch (error) {
          await emit({
            type: 'error',
            error:
              error instanceof LedgerNotEmptyError
                ? 'Sample data can only be loaded into an empty ledger.'
                : 'Loading the sample data failed. Try again.',
          });
        } finally {
          state.categorising = false;
        }
      },
      () => {
        state.categorising = false;
        return Promise.resolve();
      },
    );
  });

  return app;
}
