import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { checkLocalPassword, localPassword } from '../../src/server/auth.js';
import { createApp } from '../../src/server/app.js';
import { openMemoryDb, type Db } from '../../src/db/client.js';
import { constantTenant } from '../../src/server/tenancy.js';

const directories: string[] = [];
let db: Db | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it('keeps a stable, owner-only local password', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ledgerchat-auth-'));
  directories.push(directory);
  const path = join(directory, 'server-password');
  const password = localPassword(path);
  expect(password).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(localPassword(path)).toBe(password);
  if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(
    checkLocalPassword(
      `Basic ${Buffer.from(`ledgerchat:${password}`).toString('base64')}`,
      password,
    ),
  ).toBe(true);
  expect(
    checkLocalPassword(`Basic ${Buffer.from(`other:${password}`).toString('base64')}`, password),
  ).toBe(false);
  expect(checkLocalPassword(undefined, password)).toBe(false);
});

it('requires the password for pages, assets, reads and writes', async () => {
  db = openMemoryDb();
  const password = 'review-password';
  const app = createApp({
    tenant: constantTenant(db),
    localPassword: password,
    resolveBackend: () => Promise.reject(new Error('unconfigured')),
    backendStatus: () => Promise.resolve([]),
  }).app;
  for (const path of ['/', '/app.js', '/api/status', '/api/transactions']) {
    const response = await app.request(path);
    expect(response.status, path).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('Basic realm="ledgerchat"');
    expect(response.headers.get('cache-control')).toBe('no-store');
  }
  const authorization = `Basic ${Buffer.from(`ledgerchat:${password}`).toString('base64')}`;
  expect((await app.request('/api/status', { headers: { authorization } })).status).toBe(200);
  expect((await app.request('/', { headers: { authorization } })).status).toBe(200);
  const write = await app.request('/api/accounts', {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Everyday', type: 'transaction', currency: 'AUD' }),
  });
  expect(write.status).toBe(201);
  expect((await app.request('/api/accounts')).status).toBe(401);
  expect(
    (await app.request('http://other.example/api/status', { headers: { authorization } })).status,
  ).toBe(421);
});
