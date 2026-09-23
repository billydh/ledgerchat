import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { requestId, type RequestIdVariables } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import { streamSSE } from 'hono/streaming';
import { serve } from '@hono/node-server';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  modelSettings,
  settingsSchema,
  localModelsSchema,
  SettingsValidationError,
  type ModelSettings,
} from './settings.js';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import * as chats from '../db/repo.js';
import { statusSummary } from './status.js';
import type { ChatMessage } from '../llm/types.js';
import { config } from '../config.js';
import { isLoopbackHost } from '../loopback.js';
import { checkLocalPassword, localPassword } from './auth.js';
import { openDb, type Db } from '../db/client.js';
import { constantTenant, type Tenant } from './tenancy.js';
import { gracefulShutdown } from './shutdown.js';
import type { LlmBackend } from '../llm/backend.js';
import { runConversation, type TerminationReason } from '../chat/orchestrator.js';
import type { BackendStatus } from './backends.js';
import { importRoutes } from './import.js';
import { monthlyTotals, overviewReport, reportSchema } from '../insights/report.js';
import { recurring, search, upcoming } from '../tools/registry.js';
import {
  CorrectionError,
  correctionScopeSchema,
  getTransactionLabel,
  removeCorrection,
  setCorrection,
  setTransferDecision,
} from '../ingest/corrections.js';
import {
  parentCategories,
  parentCategoryLabels,
  parentCategorySchema,
  subcategoriesOf,
  subcategoryGlosses,
  subcategorySchema,
} from '../ingest/taxonomy.js';
import { dateSchema } from '../tools/period.js';
declare module 'hono' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface ContextVariableMap extends RequestIdVariables {}
}
const chatSchema = z.strictObject({
  conversationId: z.uuid().optional(),
  text: z.string().max(50000).trim().min(1),
  requestId: z.uuid(),
  backend: z.string().min(1).max(300).optional(),
});
const cursorSchema = z.strictObject({ updatedAt: z.iso.datetime(), id: z.uuid() });
// The editor's lookup is the model's search with the same validation, minus
// the page-size ceiling change: query-string values arrive as strings.
const positiveInt = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().positive());
const transactionQuerySchema = z.strictObject({
  query: z.string().max(500).optional(),
  category: parentCategorySchema.optional(),
  subcategory: subcategorySchema.optional(),
  account_id: positiveInt.optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  direction: z.enum(['all', 'debit', 'credit']).optional(),
  sort: z.enum(['newest', 'oldest', 'largest', 'smallest']).optional(),
  cursor: z.string().min(1).max(4096).optional(),
  limit: positiveInt.pipe(z.number().max(100)).optional(),
  include_transfers: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});
const correctionSchema = z.strictObject({
  subcategory: z.string().min(1).max(100),
  scope: correctionScopeSchema,
});
const transferDecisionSchema = z.strictObject({ is_internal_transfer: z.boolean() });
// Termination reasons whose orchestrator text is a safe, specific explanation
// written by ledgerchat (never model or provider output), so it is shown as is.
const explained = new Set<TerminationReason>([
  'turn_limit',
  'tool_error_limit',
  'repeated_call',
  'no_tool_call',
  'unverified_answer',
]);
const transactionIdSchema = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.number().int().positive().safe());
/**
 * Whether the request was addressed to this machine. The server only listens
 * on loopback, but a page can still reach it through a hostname an attacker
 * controls and rebinds to 127.0.0.1 (DNS rebinding); such a request carries
 * that hostname as `Host`, which the node server puts in the request URL.
 * Refusing anything but a loopback host closes that route for every method,
 * including the reads `sameOrigin` leaves open.
 */
export function localHost(c: { req: { url: string } }): boolean {
  try {
    return isLoopbackHost(new URL(c.req.url).hostname);
  } catch {
    return false;
  }
}
/**
 * Browsers send Origin (and Sec-Fetch-Site) on every cross-site state-changing
 * request, so a page on another origin cannot drive the API through the
 * user's browser. Requests without either header (curl, tests, same-origin
 * navigations) pass: the server listens on loopback only and `localHost`
 * has already checked the request's own host.
 */
export function sameOrigin(c: {
  req: { header: (name: string) => string | undefined; url: string };
}) {
  const site = c.req.header('Sec-Fetch-Site');
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false;
  const origin = c.req.header('Origin');
  if (origin === undefined || origin === 'null') return origin === undefined;
  try {
    return new URL(origin).host === new URL(c.req.url).host;
  } catch {
    return false;
  }
}
export interface AppOptions {
  /** The database and request state for this request. */
  tenant: (c: Context) => Tenant;
  resolveBackend: (spec: string) => Promise<LlmBackend>;
  backendStatus: () => Promise<BackendStatus[]>;
  defaultBackend?: () => string;
  settings?: ModelSettings;
  /** Omitted only for in-process tests; startServer always supplies it. */
  localPassword?: string;
  log?: (entry: Record<string, unknown>) => void;
}
/**
 * The response headers every page and API answer carries. The policy matches
 * what the page needs and nothing more: same-origin scripts, styles, fonts
 * and requests, data: images for the CSS icons, and no framing.
 */
export function responseHeaders(): MiddlewareHandler {
  return secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      fontSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
      baseUri: ["'self'"],
      objectSrc: ["'none'"],
    },
    strictTransportSecurity: false,
    // Not no-referrer: that policy makes browsers send `Origin: null` on
    // same-origin form posts, which `sameOrigin` would refuse. `same-origin`
    // still sends nothing to another site.
    referrerPolicy: 'same-origin',
    xFrameOptions: 'DENY',
    permissionsPolicy: { camera: [], microphone: [], geolocation: [], payment: [] },
  });
}
export function createApp(options: AppOptions) {
  const { tenant } = options,
    app = new Hono();
  const log = options.log ?? (() => {});
  // Request ids are minted here, never taken from the client, so a log line
  // always names a request this process saw.
  app.use('*', requestId({ headerName: '' }));
  app.use('*', async (c, next) => {
    const start = performance.now();
    await next();
    const id = c.get('requestId');
    c.res.headers.set('X-Request-Id', id);
    log({
      requestId: id,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      latencyMs: Math.round(performance.now() - start),
    });
  });
  app.use('*', responseHeaders());
  // Before any route, static file or error handler: a request that names
  // another host gets nothing but this refusal.
  app.use('*', async (c, next) => {
    if (!localHost(c)) return c.json({ error: 'This server only answers to localhost.' }, 421);
    await next();
  });
  if (options.localPassword)
    app.use('*', async (c, next) => {
      if (!checkLocalPassword(c.req.header('Authorization'), options.localPassword!))
        return c.json({ error: 'Local access password required.' }, 401, {
          'WWW-Authenticate': 'Basic realm="ledgerchat", charset="UTF-8"',
          'Cache-Control': 'no-store',
        });
      await next();
    });
  // The client gets a generic message; the real error goes to the server log
  // so a failing route is diagnosable without attaching a debugger.
  app.onError((error, c) => {
    console.error(`${c.req.method} ${c.req.path} failed:`, error);
    return c.json({ error: 'The request failed. Check server configuration and try again.' }, 500);
  });
  app.notFound((c) => c.json({ error: 'Not found' }, 404));
  // Set after the handler so it covers every answer, including streams and
  // refusals: nothing under /api is cacheable.
  app.use('/api/*', async (c, next) => {
    await next();
    c.res.headers.set('Cache-Control', 'no-store');
  });
  app.use('/api/*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && !sameOrigin(c))
      return c.json({ error: 'Cross-origin requests are not allowed.' }, 403);
    await next();
  });
  app.get('/api/settings', (c) => {
    return options.settings
      ? c.json(options.settings.read())
      : c.json({ error: 'Settings unavailable.' }, 503);
  });
  app.put('/api/settings', async (c) => {
    if (!options.settings) return c.json({ error: 'Settings unavailable.' }, 503);
    const parsed = settingsSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: 'Check the model, API key, endpoint and thinking fields.' }, 400);
    try {
      return c.json(await options.settings.save(parsed.data));
    } catch (error) {
      if (error instanceof SettingsValidationError) return c.json({ error: error.message }, 400);
      return c.json(
        {
          error:
            'Could not save settings. Check the model ID, endpoint and settings file permissions.',
        },
        400,
      );
    }
  });
  app.post('/api/settings/models', async (c) => {
    if (!options.settings) return c.json({ error: 'Settings unavailable.' }, 503);
    const parsed = localModelsSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Check the local server URL and API key.' }, 400);
    try {
      return c.json({ models: await options.settings.localModels(parsed.data) });
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof SettingsValidationError ? error.message : 'Could not load models.',
        },
        400,
      );
    }
  });
  app.get('/', (c) =>
    c.body(readFileSync(new URL('./public/index.html', import.meta.url), 'utf8'), 200, {
      'Content-Type': 'text/html; charset=utf-8',
    }),
  );
  app.route(
    '/api',
    importRoutes({
      tenant,
      resolveBackend: options.resolveBackend,
      backendStatus: options.backendStatus,
      ...(options.defaultBackend === undefined ? {} : { defaultBackend: options.defaultBackend }),
    }),
  );
  // Static assets are an allowlist, not a directory listing: only these names are served.
  const staticFiles: Record<string, string> = {
    'theme.css': 'text/css',
    'app.css': 'text/css',
    'fonts.css': 'text/css',
    'overview.css': 'text/css',
    'favicon.svg': 'image/svg+xml',
    'app.js': 'text/javascript',
    'pages.js': 'text/javascript',
    'money.js': 'text/javascript',
    'results.js': 'text/javascript',
    'terms.js': 'text/javascript',
    'overview.js': 'text/javascript',
    'settings.js': 'text/javascript',
  };
  for (const [name, type] of Object.entries(staticFiles))
    app.get(`/${name}`, (c) =>
      c.body(readFileSync(new URL(`./public/${name}`, import.meta.url), 'utf8'), 200, {
        'Content-Type': type,
      }),
    );
  // Fonts come from the installed @fontsource packages so nothing is fetched from the
  // network; the page's fonts.css names these files.
  const fontFiles: Record<string, [string, string]> = {
    'fraunces.woff2': ['@fontsource-variable/fraunces', 'fraunces-latin-full-normal.woff2'],
    'fraunces-italic.woff2': ['@fontsource-variable/fraunces', 'fraunces-latin-full-italic.woff2'],
    'atkinson.woff2': [
      '@fontsource-variable/atkinson-hyperlegible-next',
      'atkinson-hyperlegible-next-latin-wght-normal.woff2',
    ],
    'atkinson-italic.woff2': [
      '@fontsource-variable/atkinson-hyperlegible-next',
      'atkinson-hyperlegible-next-latin-wght-italic.woff2',
    ],
    'dm-mono-400.woff2': ['@fontsource/dm-mono', 'dm-mono-latin-400-normal.woff2'],
    'dm-mono-500.woff2': ['@fontsource/dm-mono', 'dm-mono-latin-500-normal.woff2'],
  };
  const fontCache = new Map<string, Buffer>();
  app.get('/fonts/:file', (c) => {
    const entry = fontFiles[c.req.param('file')];
    if (!entry) return c.json({ error: 'Not found' }, 404);
    const [pkg, file] = entry;
    let bytes = fontCache.get(file);
    if (!bytes) {
      const root = dirname(createRequire(import.meta.url).resolve(`${pkg}/package.json`));
      bytes = readFileSync(join(root, 'files', file));
      fontCache.set(file, bytes);
    }
    return c.body(new Uint8Array(bytes), 200, {
      'Content-Type': 'font/woff2',
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
  });
  const insightMonths = z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(24));
  const trendQuerySchema = z.strictObject({
    to: z.string().regex(/^\d{4}-\d{2}$/),
    months: insightMonths.optional(),
  });
  // Read-only insight endpoints for the Overview: the report and trend share
  // one set of reporting classes; regular and upcoming charges reuse the chat
  // tools' detectors.
  app.get('/api/insights/report', (c) => {
    const query = c.req.query();
    const parsed = reportSchema.safeParse({
      from: query.from,
      to: query.to,
      ...(query.account_id === undefined ? {} : { account_id: Number(query.account_id) }),
    });
    if (!parsed.success) return c.json({ error: 'Invalid report parameters.' }, 400);
    return c.json(overviewReport(tenant(c).db, parsed.data));
  });
  app.get('/api/insights/trend', (c) => {
    const parsed = trendQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: 'Invalid trend parameters.' }, 400);
    const { db } = tenant(c);
    return c.json(monthlyTotals(db, { to: parsed.data.to, months: parsed.data.months ?? 6 }));
  });
  app.get('/api/insights/recurring', (c) => {
    const report = recurring(tenant(c).db, { min_occurrences: 3 });
    return c.json({
      ...report,
      charges: [...report.charges].sort((a, b) => b.mean_amount.cents - a.mean_amount.cents),
    });
  });
  const upcomingQuerySchema = z.strictObject({
    days: z
      .string()
      .regex(/^\d+$/)
      .transform(Number)
      .pipe(z.number().int().min(1).max(90))
      .optional(),
  });
  app.get('/api/insights/upcoming', (c) => {
    const parsed = upcomingQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: 'Invalid upcoming parameters.' }, 400);
    return c.json(upcoming(tenant(c).db, { days: parsed.data.days ?? 30 }, new Date()));
  });
  app.get('/api/status', async (c) =>
    c.json({ ...statusSummary(tenant(c).db), backends: await options.backendStatus() }),
  );
  app.get('/api/conversations', (c) => {
    const rawLimit = c.req.query('limit') ?? '50';
    if (!/^\d+$/.test(rawLimit) || !Number.isSafeInteger(Number(rawLimit)) || Number(rawLimit) < 1)
      return c.json({ error: 'Invalid page size.' }, 400);
    let before: chats.ConversationCursor | undefined;
    try {
      const cursor = c.req.query('before');
      if (cursor !== undefined) {
        if (cursor.length > 500) throw new Error('Invalid cursor');
        before = cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString()));
      }
    } catch {
      return c.json({ error: 'Invalid history cursor.' }, 400);
    }
    return c.json(chats.listConversations(tenant(c).db, Math.min(Number(rawLimit), 100), before));
  });
  app.get('/api/conversations/:id', (c) => {
    const id = c.req.param('id');
    if (!z.uuid().safeParse(id).success) return c.json({ error: 'Invalid conversation ID.' }, 400);
    const { db, state } = tenant(c);
    const saved = chats.loadConversation(db, id);
    return saved
      ? c.json({
          ...saved,
          active: state.reservations.has(id) || saved.messages.some((m) => m.status === 'pending'),
        })
      : c.json({ error: 'Conversation not found.' }, 404);
  });
  app.delete('/api/conversations/:id', (c) => {
    const id = c.req.param('id');
    if (!z.uuid().safeParse(id).success) return c.json({ error: 'Invalid conversation ID.' }, 400);
    const { db, state } = tenant(c);
    if (
      state.reservations.has(id) ||
      chats.loadConversation(db, id)?.messages.some((m) => m.status === 'pending')
    )
      return c.json({ error: 'This conversation is generating. Refresh when it finishes.' }, 409);
    return chats.deleteConversation(db, id)
      ? c.body(null, 204)
      : c.json({ error: 'Conversation not found.' }, 404);
  });
  // Category editor: lookup through the shared search, then explicit
  // set/remove operations. Nothing here is exposed to the model.
  app.get('/api/categories', (c) =>
    c.json({
      categories: parentCategories.map((parent) => ({
        id: parent,
        label: parentCategoryLabels[parent],
        subcategories: subcategoriesOf[parent].map((leaf) => ({
          id: leaf,
          gloss: subcategoryGlosses[leaf],
        })),
      })),
    }),
  );
  app.get('/api/transactions', (c) => {
    let input: z.infer<typeof transactionQuerySchema>;
    try {
      input = transactionQuerySchema.parse(c.req.query());
    } catch {
      return c.json({ error: 'Invalid transaction search parameters.' }, 400);
    }
    const { db } = tenant(c);
    try {
      const page = search(db, {
        ...input,
        direction: input.direction ?? 'all',
        sort: input.sort ?? 'newest',
        limit: input.limit ?? 20,
        include_transfers: input.include_transfers ?? true,
      });
      const accounts = new Map(
        db
          .prepare<[], { id: number; name: string }>('SELECT id, name FROM accounts')
          .all()
          .map((row) => [row.id, row.name]),
      );
      return c.json({
        ...page,
        rows: page.rows.map((row) => {
          const label = getTransactionLabel(db, row.id);
          return {
            ...row,
            account_name: accounts.get(row.account_id) ?? null,
            category_origin: label.category_origin,
            origin_label: label.origin_label,
            machine_subcategory: label.machine_subcategory,
          };
        }),
      });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Search failed.' }, 400);
    }
  });
  const withTransaction = (c: Context, run: (id: number, db: Db) => unknown) => {
    const id = transactionIdSchema.safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: 'Invalid transaction ID.' }, 400);
    try {
      return c.json(run(id.data, tenant(c).db));
    } catch (error) {
      if (error instanceof CorrectionError) return c.json({ error: error.message }, error.status);
      throw error;
    }
  };
  app.get('/api/transactions/:id/category', (c) =>
    withTransaction(c, (id, db) => getTransactionLabel(db, id)),
  );
  app.put('/api/transactions/:id/transfer', async (c) => {
    const parsed = transferDecisionSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: 'Expected is_internal_transfer as a boolean.' }, 400);
    return withTransaction(c, (id, db) =>
      setTransferDecision(db, id, parsed.data.is_internal_transfer),
    );
  });
  app.put('/api/transactions/:id/category', async (c) => {
    let body: z.infer<typeof correctionSchema>;
    try {
      body = correctionSchema.parse(await c.req.json());
    } catch {
      return c.json({ error: 'Expected subcategory and scope (transaction or description).' }, 400);
    }
    if (!subcategorySchema.safeParse(body.subcategory).success)
      return c.json(
        {
          error: `Unknown subcategory ${JSON.stringify(body.subcategory)}; choose a taxonomy leaf`,
        },
        400,
      );
    return withTransaction(c, (id, db) => setCorrection(db, id, body.scope, body.subcategory));
  });
  app.delete('/api/transactions/:id/category', (c) => {
    const scope = correctionScopeSchema.safeParse(c.req.query('scope'));
    if (!scope.success)
      return c.json({ error: 'Expected scope=transaction or scope=description.' }, 400);
    return withTransaction(c, (id, db) => removeCorrection(db, id, scope.data));
  });
  app.post('/api/chat', async (c) => {
    let body: z.infer<typeof chatSchema>;
    try {
      body = chatSchema.parse(await c.req.json());
    } catch {
      return c.json(
        { error: 'Expected text, a UUID requestId, and optional conversationId and backend.' },
        400,
      );
    }
    const { db, state } = tenant(c);
    const { reservations } = state;
    const duplicate = () => chats.findChatRequest(db, body.requestId);
    const existingRequest = duplicate();
    if (existingRequest)
      return c.json(
        { error: 'This request was already saved. Reload the conversation.', ...existingRequest },
        409,
      );
    const id = body.conversationId ?? randomUUID();
    if (reservations.has(id))
      return c.json({ error: 'This conversation is already generating.' }, 409);
    reservations.add(id);
    let streaming = false;
    try {
      const saved = body.conversationId ? chats.loadConversation(db, id) : undefined;
      if (body.conversationId && !saved) return c.json({ error: 'Conversation not found.' }, 404);
      if (saved?.messages.some((m) => m.status === 'pending'))
        return c.json(
          { error: 'This conversation has a pending answer. Refresh before continuing.' },
          409,
        );
      const messages: ChatMessage[] = [];
      for (const m of saved?.messages ?? []) {
        if (m.role !== 'assistant' || m.status !== 'completed') continue;
        const user = saved!.messages.find(
          (u) => u.request_id === m.request_id && u.role === 'user' && u.status === 'completed',
        );
        if (user)
          messages.push(
            { role: 'user', text: user.text },
            { role: 'assistant', text: m.text, toolCalls: [] },
          );
      }
      if (messages.length >= 98)
        return c.json({ error: 'This conversation is full. Start a New chat.' }, 409);
      const spec =
        body.backend ?? saved?.conversation.backend_spec ?? options.defaultBackend?.() ?? '';
      let backend: LlmBackend;
      try {
        const available = await options.backendStatus();
        if (
          !available.some(
            (item) => item.spec === spec && item.configured && item.reachable !== false,
          )
        )
          throw new Error('Unavailable backend');
        backend = await options.resolveBackend(spec);
      } catch {
        return c.json(
          { error: 'Invalid or unconfigured backend spec. Choose an available backend.' },
          400,
        );
      }
      // A first-message retry may have finished backend resolution in another request.
      const repeated = duplicate();
      if (repeated)
        return c.json(
          { error: 'This request was already saved. Reload the conversation.', ...repeated },
          409,
        );
      const ids = chats.startChatExchange(db, {
        conversationId: id,
        requestId: body.requestId,
        text: body.text,
        backend: spec,
        create: !saved,
      });
      messages.push({ role: 'user', text: body.text });
      const controller = new AbortController();
      let disconnected = false;
      const abort = () => {
        disconnected = true;
        controller.abort();
      };
      c.req.raw.signal.addEventListener('abort', abort, { once: true });
      if (c.req.raw.signal.aborted) abort();
      streaming = true;
      return streamSSE(c, async (stream) => {
        stream.onAbort(abort);
        let writes = Promise.resolve();
        const emit = (event: unknown) => {
          writes = writes
            .then(async () => {
              if (!disconnected) await stream.writeSSE({ data: JSON.stringify(event) });
            })
            .catch(abort);
        };
        try {
          emit({ type: 'conversation', ...ids });
          const result = await runConversation({
            db,
            backend,
            messages,
            signal: controller.signal,
            onEvent: (event) => {
              if (event.type === 'done' || event.type === 'error') return;
              emit(event);
            },
          });
          // Settle queued writes so a disconnect cannot be mistaken for success.
          await writes;
          const interrupted = controller.signal.aborted || result.reason === 'cancelled';
          const status = interrupted
            ? 'interrupted'
            : result.failed || !result.text.trim()
              ? 'failed'
              : 'completed';
          const error = interrupted
            ? 'The request was interrupted. You can ask again.'
            : status === 'failed'
              ? explained.has(result.reason)
                ? result.text
                : 'The model did not complete an answer. Try again or choose another backend.'
              : null;
          // Only the checked answer is saved. A cancelled or failed draft may
          // contain unsupported figures, so it is never checkpointed.
          const text = status === 'completed' ? result.text : '';
          chats.finalizeChatMessage(db, {
            id: ids.assistantMessageId,
            text,
            status,
            reason: interrupted
              ? 'cancelled'
              : !result.text.trim()
                ? 'empty_answer'
                : result.reason,
            error,
            backend: spec,
          });
          if (error) emit({ type: 'error', error });
          // Do not forward provider failure details into the web response.
          emit({
            type: 'done',
            ...ids,
            text,
            status,
            failed: status !== 'completed',
            trace: { backendLabel: result.trace.backendLabel, turns: result.trace.turns },
          });
          await writes;
        } catch {
          // Saving failed: leave the pending row for startup recovery.
          if (!disconnected) {
            try {
              await stream.writeSSE({
                data: JSON.stringify({
                  type: 'error',
                  error: 'Could not save the answer. Refresh saved history before trying again.',
                }),
              });
            } catch {
              abort();
            }
          }
        } finally {
          reservations.delete(id);
          c.req.raw.signal.removeEventListener('abort', abort);
        }
      });
    } finally {
      if (!streaming) reservations.delete(id);
    }
  });
  return { app };
}
export function startServer() {
  const log = (entry: Record<string, unknown>) => console.log(JSON.stringify(entry));
  const accessPassword = localPassword(join(dirname(config.db.path), 'server-password'));
  const db = openDb(),
    backends = modelSettings(join(dirname(config.db.path), 'model-settings.json'));
  const context = createApp({
    tenant: constantTenant(db),
    resolveBackend: backends.resolve,
    backendStatus: backends.status,
    defaultBackend: backends.defaultBackend,
    settings: backends,
    localPassword: accessPassword,
    log,
  });
  // Loopback only: the app is for the person at this machine.
  const server = serve({
    fetch: context.app.fetch,
    hostname: '127.0.0.1',
    port: config.server.port,
  });
  console.log(
    `Open http://127.0.0.1:${String(config.server.port)} and run pnpm auth:show for its login.`,
  );
  const shutdown = gracefulShutdown(server, { onClosed: () => db.close(), log });
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startServer();
