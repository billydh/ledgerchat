import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openMemoryDb, type Db } from '../../src/db/client.js';
import {
  applyCategoriesToTransactions,
  upsertAccount,
  upsertDescriptionCategories,
  upsertTransactions,
} from '../../src/db/repo.js';
import { createApp } from '../../src/server/app.js';
import { constantTenant } from '../../src/server/tenancy.js';
import { getCapabilities } from '../../src/llm/capabilities.js';
import type { LlmBackend } from '../../src/llm/backend.js';
import { finishImportRun, startImportRun } from '../../src/db/repo.js';
import { matchInternalTransfers } from '../../src/ingest/transfers.js';
let db: Db;
beforeEach(() => (db = openMemoryDb()));
afterEach(() => db.close());
const backend: LlmBackend = {
  label: 'fake',
  capabilities: getCapabilities(),
  complete: (req) => {
    req.onText?.('Hello');
    return Promise.resolve({
      text: 'Hello',
      toolCalls: [],
      stopReason: 'end',
      usage: { inputTokens: 1, outputTokens: 1 },
      latencyMs: 1,
    });
  },
};
function setup(overrides: Partial<Parameters<typeof createApp>[0]> = {}) {
  return createApp({
    tenant: constantTenant(db),
    resolveBackend: (spec) =>
      spec === 'local/test' ? Promise.resolve(backend) : Promise.reject(new Error('bad')),
    backendStatus: () =>
      Promise.resolve([{ spec: 'local/test', configured: true, reachable: true }]),
    ...overrides,
  }).app;
}
it('serves status, HTML, and JSON 404', async () => {
  upsertAccount(db, { source: 'test', externalId: 'a', name: 'A', currency: 'AUD', raw: {} });
  const app = setup();
  expect(await (await app.request('/api/status')).json()).toMatchObject({
    accounts: 1,
    transactions: 0,
    transfers: 0,
    uncategorised: 0,
    lastImport: null,
    backends: [{ spec: 'local/test' }],
  });
  expect((await app.request('/')).headers.get('content-type')).toContain('text/html');
  expect(await (await app.request('/missing')).json()).toEqual({ error: 'Not found' });
});
it('lets the user correct both legs of an automatic transfer match', async () => {
  for (const account of ['Everyday', 'Savings'])
    upsertAccount(db, {
      source: 'csv',
      externalId: account,
      name: account,
      currency: 'AUD',
      raw: {},
    });
  upsertTransactions(db, [
    {
      source: 'csv',
      externalId: 'out',
      accountExternalId: 'Everyday',
      postedAt: '2026-09-10T00:00:00.000Z',
      amountCents: -10000,
      currency: 'AUD',
      descriptionRaw: 'transfer to savings',
      descriptionNorm: 'transfer to savings',
      status: 'posted',
      raw: {},
    },
    {
      source: 'csv',
      externalId: 'in',
      accountExternalId: 'Savings',
      postedAt: '2026-09-11T00:00:00.000Z',
      amountCents: 10000,
      currency: 'AUD',
      descriptionRaw: 'transfer from everyday',
      descriptionNorm: 'transfer from everyday',
      status: 'posted',
      raw: {},
    },
  ]);
  upsertDescriptionCategories(db, [
    { descriptionNorm: 'transfer to savings', subcategory: 'savings', transferHint: true },
    { descriptionNorm: 'transfer from everyday', subcategory: 'savings', transferHint: true },
  ]);
  matchInternalTransfers(db);
  const app = setup();
  const response = await app.request('/api/transactions/1/transfer', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ is_internal_transfer: false }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    affected_ids: [1, 2],
    label: { transfer_override: false, is_internal_transfer: false },
  });
  expect(
    db
      .prepare('SELECT is_internal_transfer, transfer_override FROM transactions WHERE id = 2')
      .get(),
  ).toEqual({
    is_internal_transfer: 0,
    transfer_override: 0,
  });
  expect(
    (await app.request('/api/transactions/1/transfer', { method: 'PUT', body: '{}' })).status,
  ).toBe(400);
});
it('reports the last import with its file, account and row counts', async () => {
  upsertAccount(db, { source: 'csv', externalId: 'a', name: 'Everyday', currency: 'AUD', raw: {} });
  const run = startImportRun(db, { source: 'csv', fileName: 'everyday.csv', accountId: 1 });
  finishImportRun(db, run, { inserted: 6, updated: 2, skipped: 1, status: 'ok' });
  const status = (await (await setup().request('/api/status')).json()) as {
    lastImport: Record<string, unknown>;
    coverage: { accounts: { last_import: Record<string, unknown> | null }[] };
  };
  expect(status.lastImport).toMatchObject({
    id: run,
    status: 'ok',
    file_name: 'everyday.csv',
    account: { id: 1, name: 'Everyday' },
    rows_inserted: 6,
    rows_updated: 2,
    rows_skipped: 1,
  });
  expect(status.coverage.accounts[0]!.last_import).toMatchObject({ file_name: 'everyday.csv' });
  expect(status).not.toHaveProperty('syncing');
});
it('streams ordered events ending in done with trace', async () => {
  const response = await setup().request('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'hello', requestId: randomUUID(), backend: 'local/test' }),
  });
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const text = await response.text();
  expect(text.indexOf('"type":"text"')).toBeLessThan(text.indexOf('"type":"done"'));
  expect(text).toContain('"backendLabel":"fake"');
});
it('rejects invalid specs and malformed input before streaming', async () => {
  for (const body of [
    { text: 'hello', requestId: randomUUID(), backend: 'bad' },
    { messages: [] },
  ]) {
    const response = await setup().request('/api/chat', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/json');
  }
});
it('aborts an in-flight model request on disconnect', async () => {
  const controller = new AbortController(),
    started = deferred();
  const complete = vi.fn(
    (req: Parameters<LlmBackend['complete']>[0]) =>
      new Promise<Awaited<ReturnType<LlmBackend['complete']>>>((_resolve, reject) => {
        started.resolve();
        req.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
  );
  const response = setup({
    resolveBackend: () => Promise.resolve({ ...backend, complete }),
  }).request('/api/chat', {
    method: 'POST',
    body: JSON.stringify({ text: 'hello', requestId: randomUUID(), backend: 'local/test' }),
    signal: controller.signal,
  });
  await started.promise;
  controller.abort();
  await (await response).text();
  expect(complete).toHaveBeenCalledTimes(1);
  expect(complete.mock.calls[0]![0].signal?.aborted).toBe(true);
});
it('omits query secrets from logs and errors', async () => {
  const log = vi.fn();
  const app = setup({ log });
  const response = await app.request('/api/conversations/not-a-uuid?token=secret', {
    method: 'DELETE',
  });
  expect(response.status).toBe(400);
  expect(await response.text()).not.toContain('secret');
  expect(JSON.stringify(log.mock.calls)).not.toContain('secret');
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { resolve, promise };
}

function post(app: ReturnType<typeof setup>, input: Record<string, unknown> = {}) {
  return app.request('/api/chat', {
    method: 'POST',
    body: JSON.stringify({
      text: 'question',
      backend: 'local/test',
      requestId: randomUUID(),
      ...input,
    }),
  });
}
function events(text: string) {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice(5)) as { type: string; conversationId: string });
}
it('saves before terminal SSE, continues using saved context, rejects retries and reopens after restart', async () => {
  const complete = vi.fn((req: Parameters<LlmBackend['complete']>[0]) => backend.complete(req));
  let app = setup({ resolveBackend: () => Promise.resolve({ ...backend, complete }) });
  const requestId = randomUUID();
  const response = await post(app, { requestId });
  const reader = response.body!.getReader();
  let stream = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    stream += new TextDecoder().decode(chunk.value as Uint8Array);
    if (stream.includes('"type":"done"')) {
      expect(
        db.prepare("SELECT status FROM conversation_messages WHERE role = 'assistant'").get(),
      ).toEqual({ status: 'completed' });
    }
  }
  const initial = events(stream)[0]!;
  expect(initial.type).toBe('conversation');
  expect((await post(app, { requestId })).status).toBe(409);
  expect(complete).toHaveBeenCalledTimes(1);
  app = setup({ resolveBackend: () => Promise.resolve({ ...backend, complete }) });
  expect((await app.request(`/api/conversations/${initial.conversationId}`)).status).toBe(200);
  await (await post(app, { conversationId: initial.conversationId, text: 'follow up' })).text();
  expect(complete.mock.calls[1]![0].messages.slice(0, -1)).toEqual([
    { role: 'user', text: 'question' },
    { role: 'assistant', text: 'Hello', toolCalls: [] },
    { role: 'user', text: 'follow up' },
  ]);
});
it('validates IDs, pagination and old history input without creating rows', async () => {
  const app = setup();
  for (const input of [
    { conversationId: 'bad' },
    { requestId: 'bad' },
    { text: ' ' },
    { text: 'x'.repeat(50001) },
    { backend: 'bad' },
    { messages: [{ role: 'user', text: 'legacy' }] },
  ]) {
    expect((await post(app, input)).status).toBe(400);
  }
  expect((await post(app, { conversationId: randomUUID() })).status).toBe(404);
  for (const url of [
    '/api/conversations?limit=0',
    '/api/conversations?limit=nan',
    '/api/conversations?before=bad',
    '/api/conversations/bad',
  ])
    expect((await app.request(url)).status).toBe(400);
  expect(await (await app.request('/api/conversations')).json()).toEqual({
    conversations: [],
    nextCursor: null,
  });
});
it('locks existing chats before resolving backends and releases reservations on failure', async () => {
  const app = setup();
  const id = events(await (await post(app)).text())[0]!.conversationId;
  let release!: () => void;
  const started = deferred();
  const locked = setup({
    resolveBackend: async () => {
      started.resolve();
      await new Promise<void>((r) => {
        release = r;
      });
      throw new Error('bad');
    },
  });
  const pending = post(locked, { conversationId: id });
  await started.promise;
  expect((await post(locked, { conversationId: id })).status).toBe(409);
  expect((await locked.request(`/api/conversations/${id}`, { method: 'DELETE' })).status).toBe(409);
  release();
  expect((await pending).status).toBe(400);
  expect((await locked.request(`/api/conversations/${id}`, { method: 'DELETE' })).status).toBe(204);
  expect((await locked.request(`/api/conversations/${id}`)).status).toBe(404);
});
it('discards an unchecked partial answer on cancellation and excludes it from future context', async () => {
  const started = deferred();
  const controller = new AbortController();
  let calls = 0;
  const complete = vi.fn(async (req: Parameters<LlmBackend['complete']>[0]) => {
    if (calls++ > 0) return backend.complete(req);
    req.onText?.('partial');
    started.resolve();
    await new Promise<void>((_r, reject) =>
      req.signal?.addEventListener('abort', () => reject(new Error('abort')), { once: true }),
    );
    return backend.complete(req);
  });
  const app = setup({ resolveBackend: () => Promise.resolve({ ...backend, complete }) });
  const first = app.request('/api/chat', {
    method: 'POST',
    body: JSON.stringify({ text: 'cancel me', backend: 'local/test', requestId: randomUUID() }),
    signal: controller.signal,
  });
  await started.promise;
  const row = db.prepare<[], { id: string }>('SELECT id FROM conversations').get()!;
  expect((await post(app, { conversationId: row.id })).status).toBe(409);
  expect((await app.request(`/api/conversations/${row.id}`, { method: 'DELETE' })).status).toBe(
    409,
  );
  controller.abort();
  await (await first).text();
  const saved = (await (await app.request(`/api/conversations/${row.id}`)).json()) as {
    messages: unknown[];
  };
  expect(saved.messages[1]).toMatchObject({ text: '', status: 'interrupted' });
  await (await post(app, { conversationId: row.id, text: 'next' })).text();
  expect(complete.mock.calls[1]![0].messages.slice(0, -1)).toEqual([
    { role: 'user', text: 'next' },
  ]);
});
it.each(['empty', 'failure'])('persists %s answers as failed with safe errors', async (mode) => {
  const app = setup({
    resolveBackend: () =>
      Promise.resolve({
        ...backend,
        complete: async (req) => {
          if (mode === 'failure') {
            req.onText?.('partial');
            throw new Error('provider secret');
          }
          return { ...(await backend.complete({ ...req, onText: () => {} })), text: '' };
        },
      }),
  });
  const text = await (await post(app)).text();
  expect(text).not.toContain('provider secret');
  expect(events(text).at(-1)).toMatchObject({ type: 'done', status: 'failed', failed: true });
  expect(
    db.prepare("SELECT status,text FROM conversation_messages WHERE role='assistant'").get(),
  ).toEqual({ status: 'failed', text: '' });
});
it('enforces 49 successful exchanges and does not emit success when saving fails', async () => {
  const app = setup();
  const first = events(await (await post(app)).text())[0]!;
  for (let i = 1; i < 49; i++)
    await (await post(app, { conversationId: first.conversationId })).text();
  expect((await post(app, { conversationId: first.conversationId })).status).toBe(409);
  db.exec(
    "CREATE TRIGGER reject_final BEFORE UPDATE OF status ON conversation_messages BEGIN SELECT RAISE(ABORT, 'disk error'); END",
  );
  const text = await (await post(app)).text();
  expect(text).toContain('Could not save');
  expect(text).not.toContain('"type":"done"');
});

it('deduplicates simultaneous first-message retries after asynchronous resolution', async () => {
  const ready = deferred();
  let count = 0;
  const complete = vi.fn((req: Parameters<LlmBackend['complete']>[0]) => backend.complete(req));
  const app = setup({
    resolveBackend: async () => {
      if (++count === 2) ready.resolve();
      await ready.promise;
      return { ...backend, complete };
    },
  });
  const requestId = randomUUID();
  const responses = await Promise.all([post(app, { requestId }), post(app, { requestId })]);
  expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
  for (const response of responses) await response.text();
  expect(complete).toHaveBeenCalledTimes(1);
  expect(db.prepare('SELECT count(*) count FROM conversations').get()).toEqual({ count: 1 });
});
it('rejects unavailable backends before saving a question', async () => {
  const resolveBackend = vi.fn(() => Promise.resolve(backend));
  const app = setup({
    resolveBackend,
    backendStatus: () =>
      Promise.resolve([{ spec: 'local/test', configured: true, reachable: false }]),
  });
  expect((await post(app)).status).toBe(400);
  expect(resolveBackend).not.toHaveBeenCalled();
  expect(db.prepare('SELECT count(*) count FROM conversations').get()).toEqual({ count: 0 });
});
it('recovers a pending checkpoint at application startup', async () => {
  const id = randomUUID();
  db.prepare('INSERT INTO conversations VALUES (?,?,?,?,?)').run(
    id,
    'Interrupted',
    'local/test',
    new Date().toISOString(),
    new Date().toISOString(),
  );
  db.prepare(
    "INSERT INTO conversation_messages (conversation_id,request_id,role,text,status,created_at,updated_at) VALUES (?,?,'assistant','checkpoint','pending',?,?)",
  ).run(id, randomUUID(), new Date().toISOString(), new Date().toISOString());
  const saved = await (await setup().request(`/api/conversations/${id}`)).json();
  expect(saved).toMatchObject({
    active: false,
    messages: [{ status: 'interrupted', text: 'checkpoint', termination_reason: 'server_restart' }],
  });
});

it('does not checkpoint unchecked streamed drafts', async () => {
  let now = 0;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  db.exec(
    "CREATE TABLE checkpoints(text TEXT); CREATE TRIGGER record_checkpoint AFTER UPDATE OF text ON conversation_messages WHEN NEW.status = 'pending' BEGIN INSERT INTO checkpoints VALUES (NEW.text); END;",
  );
  try {
    const app = setup({
      resolveBackend: () =>
        Promise.resolve({
          ...backend,
          complete: async (req) => {
            for (const instant of [400, 900, 1000, 1100, 2000]) {
              now = instant;
              req.onText?.('part ');
            }
            return backend.complete({ ...req, onText: () => {} });
          },
        }),
    });
    const terminal = events(await (await post(app)).text()).at(-1);
    expect(terminal).toMatchObject({ status: 'completed', text: 'Hello' });
    expect(db.prepare('SELECT text FROM checkpoints').all()).toEqual([]);
  } finally {
    clock.mockRestore();
  }
});
it('does not attempt a pending-draft write before finalising a checked answer', async () => {
  let now = 0;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  db.exec(
    "CREATE TRIGGER reject_checkpoint BEFORE UPDATE OF text ON conversation_messages WHEN NEW.status = 'pending' BEGIN SELECT RAISE(ABORT, 'disk failure'); END;",
  );
  try {
    const app = setup({
      resolveBackend: () =>
        Promise.resolve({
          ...backend,
          complete: async (req) => {
            now = 1000;
            req.onText?.('partial');
            return backend.complete({ ...req, onText: () => {} });
          },
        }),
    });
    const text = await (await post(app)).text();
    expect(text).not.toContain('could not be checkpointed');
    expect(events(text).at(-1)).toMatchObject({
      status: 'completed',
      failed: false,
      text: 'Hello',
    });
  } finally {
    clock.mockRestore();
  }
});
function seedCorrections() {
  upsertAccount(db, {
    source: 'csv',
    externalId: 'a',
    name: 'Everyday',
    currency: 'AUD',
    raw: {},
  });
  upsertTransactions(
    db,
    [
      ['1', 'WOOLWORTHS <b>x</b>', -1000],
      ['2', 'WOOLWORTHS <b>x</b>', -2000],
      ['3', 'NETFLIX', -1500],
    ].map(([id, description, cents]) => ({
      source: 'csv',
      externalId: String(id),
      accountExternalId: 'a',
      postedAt: `2026-08-0${String(id)}T00:00:00.000Z`,
      amountCents: Number(cents),
      currency: 'AUD',
      descriptionRaw: String(description),
      descriptionNorm: String(description),
      status: 'posted' as const,
      raw: {},
    })),
  );
  upsertDescriptionCategories(db, [
    { descriptionNorm: 'WOOLWORTHS <b>x</b>', subcategory: 'groceries', isSubscription: false },
  ]);
  applyCategoriesToTransactions(db);
}
interface Loose {
  categories: { id: string }[];
  rows: { id: number }[];
  next_cursor: string | null;
  error: string;
}
const read = async (response: Response) => (await response.json()) as Loose;
const json = (method: string, body: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
it('serves the taxonomy and a transaction lookup with label origins through shared search', async () => {
  seedCorrections();
  const app = setup();
  const taxonomy = await read(await app.request('/api/categories'));
  expect(taxonomy.categories[0]).toMatchObject({
    id: 'food_drink',
    label: 'Food and drink',
    subcategories: [{ id: 'groceries' }, { id: 'dining' }, { id: 'food_drink_other' }],
  });
  const page = await read(await app.request('/api/transactions?query=WOOL&limit=1&sort=oldest'));
  expect(page).toMatchObject({
    total_matched_count: 2,
    has_more: true,
    rows: [
      {
        id: 1,
        account_name: 'Everyday',
        description: 'WOOLWORTHS <b>x</b>',
        subcategory: 'groceries',
        category: 'food_drink',
        category_origin: 'llm',
        origin_label: 'Machine label',
      },
    ],
  });
  const next = await read(
    await app.request(
      `/api/transactions?query=WOOL&limit=1&sort=oldest&cursor=${encodeURIComponent(String(page.next_cursor))}`,
    ),
  );
  expect(next.rows.map((r: { id: number }) => r.id)).toEqual([2]);
  expect((await app.request('/api/transactions?limit=0')).status).toBe(400);
  expect((await app.request('/api/transactions?category=groceries')).status).toBe(400);
  expect((await app.request('/api/transactions?cursor=nonsense')).status).toBe(400);
  const unlabelled = await read(await app.request('/api/transactions?query=NETFLIX'));
  expect(unlabelled.rows[0]).toMatchObject({
    subcategory: null,
    category: 'uncategorised',
    origin_label: 'Unlabelled',
  });
});
it('sets and removes corrections at both scopes with readable origins and match counts', async () => {
  seedCorrections();
  const app = setup();
  const before = await (await app.request('/api/transactions/1/category')).json();
  expect(before).toMatchObject({
    subcategory: 'groceries',
    category_origin: 'llm',
    rule_scope: { source: 'csv', description: 'WOOLWORTHS <b>x</b>', match_count: 2 },
  });
  const ruled = await app.request(
    '/api/transactions/1/category',
    json('PUT', { subcategory: 'dining', scope: 'description' }),
  );
  expect(ruled.status).toBe(200);
  expect(await ruled.json()).toMatchObject({
    subcategory: 'dining',
    category_origin: 'description_rule',
    origin_label: 'Corrected by a description rule',
    machine_subcategory: 'groceries',
    rule: { subcategory: 'dining' },
  });
  expect(await (await app.request('/api/transactions/2/category')).json()).toMatchObject({
    subcategory: 'dining',
    category_origin: 'description_rule',
  });
  const overridden = await (
    await app.request(
      '/api/transactions/2/category',
      json('PUT', { subcategory: 'gifts', scope: 'transaction' }),
    )
  ).json();
  expect(overridden).toMatchObject({
    subcategory: 'gifts',
    category_origin: 'transaction_override',
    override: { subcategory: 'gifts' },
    rule: { subcategory: 'dining' },
  });
  expect(await (await app.request('/api/status')).json()).toMatchObject({ uncategorised: 1 });
  const removedOverride = await (
    await app.request('/api/transactions/2/category?scope=transaction', { method: 'DELETE' })
  ).json();
  expect(removedOverride).toMatchObject({
    removed: true,
    label: { subcategory: 'dining', category_origin: 'description_rule' },
  });
  const removedRule = await (
    await app.request('/api/transactions/2/category?scope=description', { method: 'DELETE' })
  ).json();
  expect(removedRule).toMatchObject({
    removed: true,
    label: { subcategory: 'groceries', category_origin: 'llm', origin_label: 'Machine label' },
  });
  expect(
    await (
      await app.request('/api/transactions/2/category?scope=description', { method: 'DELETE' })
    ).json(),
  ).toMatchObject({ removed: false });
});
it('rejects invalid correction requests without writing', async () => {
  seedCorrections();
  const app = setup();
  const cases: [string, RequestInit | undefined, number, string][] = [
    [
      '/api/transactions/1/category',
      json('PUT', { subcategory: 'food_drink', scope: 'transaction' }),
      400,
      'Unknown subcategory',
    ],
    [
      '/api/transactions/1/category',
      json('PUT', { subcategory: 'gifts', scope: 'everything' }),
      400,
      'scope',
    ],
    ['/api/transactions/1/category', json('PUT', { subcategory: 'gifts' }), 400, 'scope'],
    ['/api/transactions/1/category', { method: 'PUT', body: '{' }, 400, 'Expected'],
    [
      '/api/transactions/999/category',
      json('PUT', { subcategory: 'gifts', scope: 'transaction' }),
      404,
      'No transaction',
    ],
    [
      '/api/transactions/abc/category',
      json('PUT', { subcategory: 'gifts', scope: 'transaction' }),
      400,
      'Invalid transaction ID',
    ],
    ['/api/transactions/999/category', undefined, 404, 'No transaction'],
    ['/api/transactions/1/category', { method: 'DELETE' }, 400, 'scope'],
    [
      '/api/transactions/999/category?scope=transaction',
      { method: 'DELETE' },
      404,
      'No transaction',
    ],
  ];
  for (const [url, init, status, message] of cases) {
    const response = await app.request(url, init);
    expect(response.status, url).toBe(status);
    expect((await read(response)).error, url).toContain(message);
  }
  expect(db.prepare('SELECT count(*) n FROM transaction_category_overrides').get()).toEqual({
    n: 0,
  });
  expect(db.prepare('SELECT count(*) n FROM description_category_rules').get()).toEqual({ n: 0 });
});
it('refuses cross-origin state changes on every API route while allowing same-origin ones', async () => {
  seedCorrections();
  const app = setup();
  const foreign = { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' };
  for (const [url, init] of [
    ['/api/transactions/1/category', json('PUT', { subcategory: 'gifts', scope: 'transaction' })],
    ['/api/transactions/1/category?scope=transaction', { method: 'DELETE' }],
    ['/api/chat', json('POST', { text: 'hi', requestId: randomUUID() })],
    [`/api/conversations/${randomUUID()}`, { method: 'DELETE' }],
  ] as const) {
    const response = await app.request(url, {
      ...init,
      headers: { ...(init.headers ?? {}), ...foreign },
    });
    expect(response.status, url).toBe(403);
  }
  expect(db.prepare('SELECT count(*) n FROM transaction_category_overrides').get()).toEqual({
    n: 0,
  });
  const same = await app.request('http://localhost:3000/api/transactions/1/category', {
    ...json('PUT', { subcategory: 'gifts', scope: 'transaction' }),
    headers: {
      'content-type': 'application/json',
      Origin: 'http://localhost:3000',
      'Sec-Fetch-Site': 'same-origin',
    },
  });
  expect(same.status).toBe(200);
  // A mismatched Origin alone is enough, and GET reads are never blocked.
  expect(
    (
      await app.request('http://localhost:3000/api/transactions/1/category?scope=transaction', {
        method: 'DELETE',
        headers: { Origin: 'http://localhost:3001' },
      })
    ).status,
  ).toBe(403);
  expect((await app.request('/api/transactions/1/category', { headers: foreign })).status).toBe(
    200,
  );
});
it('saves a repeated-call failure with its reason and streams the trace without duplicating messages', async () => {
  const app = setup({
    resolveBackend: () =>
      Promise.resolve({
        ...backend,
        complete: () =>
          Promise.resolve({
            text: '',
            toolCalls: [{ id: randomUUID(), name: 'list_accounts', rawInput: {} }],
            stopReason: 'tool_calls' as const,
            usage: { inputTokens: 1, outputTokens: 1 },
            latencyMs: 1,
          }),
      }),
  });
  const requestId = randomUUID();
  const text = await (await post(app, { requestId })).text();
  const done = events(text).at(-1) as unknown as {
    type: string;
    status: string;
    failed: boolean;
    conversationId: string;
    trace: { turns: { repeatedCalls: { occurrence: number; action: string }[] }[] };
  };
  expect(done).toMatchObject({ type: 'done', status: 'failed', failed: true });
  expect(done.trace.turns).toHaveLength(3);
  expect(done.trace.turns[2]!.repeatedCalls[0]).toMatchObject({
    occurrence: 3,
    action: 'terminated',
  });
  expect(text).toContain('three times');
  const saved = (await read(
    await app.request(`/api/conversations/${done.conversationId}`),
  )) as unknown as {
    messages: { role: string; status: string; termination_reason: string | null; text: string }[];
  };
  expect(saved.messages.map((m) => [m.role, m.status, m.termination_reason])).toEqual([
    ['user', 'completed', null],
    ['assistant', 'failed', 'repeated_call'],
  ]);
  expect(saved.messages[1]!.text).toBe('');
  // A retry of the same request id is refused rather than appended.
  expect((await post(app, { requestId })).status).toBe(409);
});
