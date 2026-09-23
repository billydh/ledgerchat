import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openMemoryDb, type Db } from '../../src/db/client.js';
import { createApp } from '../../src/server/app.js';
import { constantTenant } from '../../src/server/tenancy.js';
import { MAX_FILE_BYTES } from '../../src/server/import.js';
import { getCapabilities } from '../../src/llm/capabilities.js';
import type { LlmBackend } from '../../src/llm/backend.js';

let db: Db;
beforeEach(() => (db = openMemoryDb()));
afterEach(() => db.close());

const fixture = (name: string) =>
  readFileSync(new URL(`../../fixtures/files/${name}`, import.meta.url), 'utf8');

/** A backend that labels every description as groceries through the forced tool. */
const labeller: LlmBackend = {
  label: 'local/test',
  capabilities: getCapabilities(),
  complete: (req) => {
    const last = req.messages.at(-1);
    const prompt = last && 'text' in last ? last.text : '';
    const descriptions = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)) as string[];
    return Promise.resolve({
      text: '',
      toolCalls: [
        {
          id: '1',
          name: 'submit',
          rawInput: {
            items: descriptions.map((description) => ({
              description,
              subcategory: 'groceries',
              confidence: 0.9,
              transfer_hint: false,
              is_subscription: null,
            })),
          },
        },
      ],
      stopReason: 'tool_calls',
      usage: { inputTokens: 1, outputTokens: 1 },
      latencyMs: 1,
    });
  },
};

function setup() {
  return createApp({
    tenant: constantTenant(db),
    resolveBackend: (spec) =>
      spec === 'local/test' ? Promise.resolve(labeller) : Promise.reject(new Error('bad')),
    backendStatus: () =>
      Promise.resolve([{ spec: 'local/test', configured: true, reachable: true }]),
    defaultBackend: () => 'local/test',
  }).app;
}

function upload(
  path: string,
  name: string,
  content: string | Blob,
  options?: Record<string, unknown>,
) {
  const form = new FormData();
  form.set('file', new File([content], name));
  if (options) form.set('options', JSON.stringify(options));
  return setup().request(path, { method: 'POST', body: form });
}

const NEW_ACCOUNT = { create: { name: 'Everyday', type: 'transaction', currency: 'AUD' } };

async function events(response: Response) {
  const lines = (await response.text()).split('\n').filter((l) => l.startsWith('data: '));
  return lines.map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);
}

it('lists and creates accounts', async () => {
  const app = setup();
  expect(await (await app.request('/api/accounts')).json()).toEqual({ accounts: [] });
  const created = await app.request('/api/accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Everyday', type: 'transaction', currency: 'AUD' }),
  });
  expect(created.status).toBe(201);
  expect(await created.json()).toEqual({
    id: 1,
    name: 'Everyday',
    type: 'transaction',
    institution: null,
    currency: 'AUD',
    source: 'manual',
  });
  expect(await (await app.request('/api/accounts')).json()).toMatchObject({
    accounts: [{ id: 1, name: 'Everyday' }],
  });
  const bad = await app.request('/api/accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'X', type: 'piggy_bank', currency: 'AUD' }),
  });
  expect(bad.status).toBe(400);
});

it('deletes an account with its rows and unpairs transfer counterparts left behind', async () => {
  const app = setup();
  const imported = await upload('/api/import', 'x.csv', fixture('signed-header.csv'), {
    account: NEW_ACCOUNT,
    mapping: { sign: 'spend_negative' },
  });
  expect(imported.status).toBe(200);
  const other = await upload('/api/import', 'bank.ofx', fixture('sample-1x.ofx'));
  expect(other.status).toBe(200);
  const rows = db
    .prepare<[], { id: number; account_id: number }>(
      'SELECT min(id) id, account_id FROM transactions GROUP BY account_id ORDER BY account_id',
    )
    .all();
  const [a, b] = rows as [(typeof rows)[number], (typeof rows)[number]];
  // A pair spanning both accounts: the survivor must not point at a deleted row.
  db.prepare(
    `UPDATE transactions SET is_internal_transfer = 1, transfer_source = 'pair',
     transfer_pair_id = CASE id WHEN ? THEN ? ELSE ? END WHERE id IN (?, ?)`,
  ).run(a.id, b.id, a.id, a.id, b.id);
  expect(a.account_id).not.toBe(b.account_id);

  const gone = await app.request(`/api/accounts/${String(a.account_id)}`, { method: 'DELETE' });
  expect(gone.status).toBe(204);
  expect(db.prepare('SELECT count(*) n FROM accounts').get()).toEqual({ n: 1 });
  expect(
    db.prepare('SELECT count(*) n FROM transactions WHERE account_id = ?').get(a.account_id),
  ).toEqual({ n: 0 });
  expect(
    db
      .prepare(
        'SELECT is_internal_transfer, transfer_source, transfer_pair_id FROM transactions WHERE id = ?',
      )
      .get(b.id),
  ).toEqual({ is_internal_transfer: 0, transfer_source: null, transfer_pair_id: null });
  // Import history stays, with the account unset.
  expect(db.prepare('SELECT account_id FROM import_runs WHERE file_name = ?').get('x.csv')).toEqual(
    { account_id: null },
  );

  expect(
    (await app.request(`/api/accounts/${String(a.account_id)}`, { method: 'DELETE' })).status,
  ).toBe(404);
  expect((await app.request('/api/accounts/nope', { method: 'DELETE' })).status).toBe(400);
});

it('previews a CSV without writing, then imports it and reports the run', async () => {
  const preview = await upload('/api/import/preview', 'x.csv', fixture('signed-header.csv'), {
    account: NEW_ACCOUNT,
  });
  expect(preview.status).toBe(200);
  const body = (await preview.json()) as { row_count: number; mapping: { roles: unknown[] } };
  expect(body.row_count).toBe(7);
  expect(body.mapping.roles.length).toBeGreaterThan(3);
  expect(db.prepare('SELECT count(*) n FROM accounts').get()).toEqual({ n: 0 });

  const imported = await upload('/api/import', 'x.csv', fixture('signed-header.csv'), {
    account: NEW_ACCOUNT,
    mapping: { sign: 'spend_negative' },
  });
  expect(imported.status).toBe(200);
  expect(await imported.json()).toMatchObject({
    run: { source: 'csv', file_name: 'x.csv', account_id: 1, rows_inserted: 7, status: 'ok' },
    result: { inserted: 7, updated: 0, unchanged: 0, duplicates: 0, skipped: 0 },
  });
  // The identical file again: every row unchanged, nothing updated, in the response and the run.
  const again = await upload('/api/import', 'x.csv', fixture('signed-header.csv'), {
    account: { id: 1 },
    mapping: { sign: 'spend_negative' },
  });
  expect(await again.json()).toMatchObject({
    run: { rows_inserted: 0, rows_updated: 0, rows_unchanged: 7, rows_duplicate: 0 },
    result: { inserted: 0, updated: 0, unchanged: 7 },
  });
  const status = (await (await setup().request('/api/status')).json()) as {
    transactions: number;
    lastImport: { file_name: string; rows_updated: number; rows_unchanged: number | null };
  };
  expect(status.transactions).toBe(7);
  expect(status.lastImport).toMatchObject({
    file_name: 'x.csv',
    rows_updated: 0,
    rows_unchanged: 7,
  });
});

it('imports an OFX file with no account given', async () => {
  const response = await upload('/api/import', 'bank.ofx', fixture('sample-1x.ofx'));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ result: { inserted: 3, balancesSeen: 1 } });
});

it('explains a missing file, a missing account, bad options and a broken file', async () => {
  const noFile = await setup().request('/api/import/preview', {
    method: 'POST',
    body: new FormData(),
  });
  expect(noFile.status).toBe(400);
  expect(await noFile.json()).toEqual({ error: 'Attach the export as the file field.' });

  const noAccount = await upload('/api/import/preview', 'x.csv', fixture('ambiguous.csv'));
  expect(noAccount.status).toBe(400);
  expect(await noAccount.json()).toEqual({
    error: 'A CSV import needs an account to import into.',
  });

  const badOptions = await upload('/api/import/preview', 'x.csv', fixture('ambiguous.csv'), {
    account: NEW_ACCOUNT,
    mapping: { dateFormat: 'nope' },
  });
  expect(badOptions.status).toBe(400);
  expect(await badOptions.json()).toEqual({ error: 'Invalid import options.' });

  const unknownAccount = await upload('/api/import/preview', 'x.csv', fixture('ambiguous.csv'), {
    account: { id: 42 },
  });
  expect(unknownAccount.status).toBe(400);
  expect(await unknownAccount.json()).toEqual({ error: 'No account with id 42.' });

  const notOfx = await upload('/api/import/preview', 'x.ofx', 'hello');
  expect(notOfx.status).toBe(400);
  expect(((await notOfx.json()) as { error: string }).error).toContain('OFX');

  const noAmounts = await upload(
    '/api/import/preview',
    'x.csv',
    'Date,Description\n2026-01-01,x\n',
    {
      account: NEW_ACCOUNT,
    },
  );
  expect(noAmounts.status).toBe(400);
  expect(await noAmounts.json()).toEqual({ error: 'No column contains recognisable amounts.' });

  const empty = await upload('/api/import/preview', 'x.csv', '', { account: NEW_ACCOUNT });
  expect(empty.status).toBe(400);
  expect(await empty.json()).toEqual({ error: 'The file is empty.' });
});

it('refuses a file over the size cap with a clear message', async () => {
  const big = new Blob([new Uint8Array(MAX_FILE_BYTES + 1)]);
  const response = await upload('/api/import/preview', 'big.csv', big, { account: NEW_ACCOUNT });
  expect(response.status).toBe(413);
  expect(((await response.json()) as { error: string }).error).toContain('20 MB');
});

it('categorises over SSE with progress and refuses a second concurrent run', async () => {
  await upload('/api/import', 'x.csv', fixture('signed-header.csv'), { account: NEW_ACCOUNT });
  const app = setup();
  const response = await app.request('/api/categorise', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ backend: 'local/test' }),
  });
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const stream = await events(response);
  expect(stream[0]).toMatchObject({ type: 'progress', batch: 1, batches: 1, total: 6 });
  expect(stream.at(-1)).toMatchObject({ type: 'done', categorised: 6, failures: 0 });
  expect(db.prepare('SELECT count(*) n FROM transactions WHERE subcategory IS NULL').get()).toEqual(
    { n: 0 },
  );

  const unavailable = await app.request('/api/categorise', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ backend: 'local/other' }),
  });
  expect(unavailable.status).toBe(400);

  // Nothing left to label: the run completes with zero batches.
  const again = await events(await app.request('/api/categorise', { method: 'POST', body: '{}' }));
  expect(again).toEqual([expect.objectContaining({ type: 'done', batches: 0 })]);
});

it('loads the sample dataset over SSE and refuses a ledger that already has data', async () => {
  const app = setup();
  const response = await app.request('/api/sample', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ backend: 'local/test' }),
  });
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const stream = await events(response);
  expect(stream.slice(0, 3).map((e) => e.account)).toEqual(['Everyday', 'Savings', 'Credit card']);
  expect(stream[3]).toMatchObject({ type: 'progress', batch: 1 });
  const done = stream.at(-1)!;
  expect(done).toMatchObject({ type: 'done', backend: 'local/test', failures: 0 });
  expect(done.transactions).toBeGreaterThan(700);
  expect(db.prepare('SELECT count(*) n FROM accounts').get()).toEqual({ n: 3 });
  expect(db.prepare('SELECT count(*) n FROM transactions WHERE subcategory IS NULL').get()).toEqual(
    { n: 0 },
  );

  const again = await app.request('/api/sample', { method: 'POST', body: '{}' });
  expect(again.status).toBe(409);
  expect(((await again.json()) as { error: string }).error).toContain('empty ledger');
});

it('loads the sample dataset unlabelled when no backend is available', async () => {
  const app = createApp({
    tenant: constantTenant(db),
    resolveBackend: () => Promise.reject(new Error('none')),
    backendStatus: () => Promise.resolve([]),
  }).app;
  const stream = await events(await app.request('/api/sample', { method: 'POST', body: '{}' }));
  expect(stream.at(-1)).toMatchObject({ type: 'done', categorised: 0 });
  expect(stream.some((e) => e.type === 'progress')).toBe(false);
  expect(db.prepare('SELECT count(*) n FROM transactions WHERE subcategory IS NULL').get()).toEqual(
    { n: (db.prepare('SELECT count(*) n FROM transactions').get() as { n: number }).n },
  );
  // An explicit spec that is not available is still a 400, as for /api/categorise.
  db.prepare('DELETE FROM accounts').run();
  db.prepare('DELETE FROM import_runs').run();
  const bad = await app.request('/api/sample', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ backend: 'local/other' }),
  });
  expect(bad.status).toBe(400);
});
