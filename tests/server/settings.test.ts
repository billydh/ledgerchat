import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { modelSettings } from '../../src/server/settings.js';
import { createApp } from '../../src/server/app.js';
import { constantTenant } from '../../src/server/tenancy.js';
import { openMemoryDb } from '../../src/db/client.js';
const directories: string[] = [];
const path = () => {
  const directory = mkdtempSync(join(tmpdir(), 'ledgerchat-settings-'));
  directories.push(directory);
  return join(directory, 'model-settings.json');
};
afterEach(() => {
  directories.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
  vi.unstubAllGlobals();
});
const input = {
  model: 'local-model',
  apiKey: 'test-secret',
  baseUrl: 'http://localhost:8000',
  thinking: false,
};
/** A model server that lists these ids, whatever the URL. */
function serveModels(ids: string[]) {
  const fetch = vi
    .fn()
    .mockImplementation(() => Promise.resolve(Response.json({ data: ids.map((id) => ({ id })) })));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
it('persists privately, redacts the key, and applies the saved model immediately', async () => {
  serveModels(['local-model']);
  const file = path();
  const settings = modelSettings(file, {});
  expect(settings.defaultBackend()).toBe('');
  expect(await settings.status()).toEqual([]);
  const result = await settings.save(input);
  expect(JSON.stringify(result)).not.toContain('test-secret');
  expect(result).toMatchObject({ spec: 'local/local-model', hasApiKey: true, thinking: false });
  expect(settings.defaultBackend()).toBe('local/local-model');
  expect((await settings.resolve(result.spec)).label).toBe(result.spec);
  expect(await settings.status()).toMatchObject([
    { spec: result.spec, configured: true, reachable: true },
  ]);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(modelSettings(file, {}).read()).toEqual(settings.read());
  expect(readFileSync(file, 'utf8')).toContain('test-secret');
});
it('starts from the environment, keeps an omitted key, and saves the thinking flag', async () => {
  serveModels(['env-model', 'other-model']);
  const file = path();
  const settings = modelSettings(file, {
    LOCAL_LLM_MODEL: 'env-model',
    LOCAL_LLM_BASE_URL: 'http://localhost:11434',
    LOCAL_LLM_API_KEY: 'env-secret',
    LOCAL_LLM_THINKING: 'true',
  });
  expect(settings.read()).toEqual({
    model: 'env-model',
    baseUrl: 'http://localhost:11434',
    thinking: true,
    hasApiKey: true,
  });
  expect(settings.defaultBackend()).toBe('local/env-model');
  await settings.save({ model: 'other-model', baseUrl: 'http://localhost:11434', thinking: false });
  expect(readFileSync(file, 'utf8')).toContain('env-secret');
  expect(settings.read()).toEqual({
    model: 'other-model',
    baseUrl: 'http://localhost:11434',
    thinking: false,
    hasApiKey: true,
  });
  expect((await settings.resolve('local/other-model')).capabilities.thinking).toBe(false);
  await expect(settings.resolve('local/env-model')).rejects.toThrow('Configure');
});
it('rejects unknown models and endpoint tampering without changing saved settings', async () => {
  serveModels(['local-model']);
  const file = path();
  const settings = modelSettings(file, {});
  await settings.save(input);
  const before = readFileSync(file, 'utf8');
  for (const invalid of [
    { model: 'bad model' },
    { model: 'invented-model' },
    { baseUrl: 'https://user:secret@localhost' },
    { baseUrl: 'http://localhost:8000/v1?key=secret' },
    { baseUrl: 'ftp://localhost' },
    { baseUrl: 'http://192.168.1.10:11434' },
    { baseUrl: 'https://api.openai.com' },
  ]) {
    await expect(settings.save({ ...input, ...invalid })).rejects.toThrow();
    expect(readFileSync(file, 'utf8')).toBe(before);
  }
  await expect(settings.resolve('local/invented-model')).rejects.toThrow('Configure');
  await expect(settings.resolve('frontier:openai/gpt')).rejects.toThrow('Invalid backend spec');
});
it('discovers local models and independently checks membership when saving', async () => {
  const fetch = serveModels(['local-model', 'local-model', '../invalid']);
  const settings = modelSettings(path(), {});
  const local = { ...input, apiKey: 'local-key' };
  expect(await settings.localModels({ baseUrl: local.baseUrl, apiKey: local.apiKey })).toEqual([
    { id: 'local-model', label: 'local-model' },
  ]);
  await settings.save(local);
  expect(fetch).toHaveBeenLastCalledWith(
    'http://localhost:8000/v1/models',
    expect.objectContaining({ headers: { authorization: 'Bearer local-key' }, redirect: 'error' }),
  );
  expect(settings.defaultBackend()).toBe('local/local-model');
  await expect(settings.save({ ...local, model: 'invented-model' })).rejects.toThrow('available');
  fetch.mockResolvedValue(Response.json({ data: [] }));
  await expect(settings.save(local)).rejects.toThrow('available');
  fetch.mockRejectedValue(new Error('network failure containing secrets'));
  await expect(
    settings.localModels({ baseUrl: local.baseUrl, apiKey: local.apiKey }),
  ).rejects.toThrow('Could not load local models');
  await expect(settings.save(local)).rejects.toThrow('Could not load local models');
  expect(settings.defaultBackend()).toBe('local/local-model');
});
it('reports a saved model whose server is offline as unreachable, not unconfigured', async () => {
  serveModels(['local-model']);
  const settings = modelSettings(path(), {});
  await settings.save(input);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  expect(await settings.status()).toMatchObject([
    { spec: 'local/local-model', configured: false, reachable: false },
  ]);
  expect(settings.defaultBackend()).toBe('local/local-model');
});
it('validates direct API requests, protects cross-origin writes, and never sends a saved key to the client', async () => {
  serveModels(['local-model']);
  const db = openMemoryDb();
  try {
    const settings = modelSettings(path(), {});
    const { app } = createApp({
      tenant: constantTenant(db),
      settings,
      resolveBackend: settings.resolve,
      backendStatus: settings.status,
    });
    const request = (body: unknown, origin = 'http://localhost') =>
      app.request('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify(body),
      });
    expect((await request(input, 'https://other.example')).status).toBe(403);
    for (const bad of [
      { provider: 'openai' },
      { model: 'unknown' },
      { baseUrl: 'not a url' },
      { thinking: 'yes' },
    ]) {
      expect((await request({ ...input, ...bad })).status).toBe(400);
    }
    const response = await request(input);
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('test-secret');
    const read = await app.request('/api/settings');
    expect(read.headers.get('cache-control')).toBe('no-store');
    const body = await read.text();
    expect(body).not.toContain('test-secret');
    expect(JSON.parse(body)).toEqual({
      model: 'local-model',
      baseUrl: 'http://localhost:8000',
      thinking: false,
      hasApiKey: true,
    });
    expect(
      (
        await app.request('/api/settings/models', {
          method: 'POST',
          headers: { Origin: 'https://other.example' },
          body: '{}',
        })
      ).status,
    ).toBe(403);
    const models = await app.request('/api/settings/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'http://localhost:8000' }),
    });
    expect(await models.json()).toEqual({ models: [{ id: 'local-model', label: 'local-model' }] });
  } finally {
    db.close();
  }
});
it('refreshes the client after a save and keeps chat on the saved model', async () => {
  serveModels(['model-a', 'model-b']);
  const db = openMemoryDb();
  try {
    const settings = modelSettings(path(), {});
    await settings.save({ ...input, model: 'model-a' });
    const first = await settings.resolve('local/model-a');
    await settings.save({ ...input, model: 'model-b' });
    await expect(settings.resolve('local/model-a')).rejects.toThrow('Configure');
    expect(await settings.resolve('local/model-b')).not.toBe(first);
    const resolved: string[] = [];
    const { app } = createApp({
      tenant: constantTenant(db),
      settings,
      backendStatus: settings.status,
      defaultBackend: settings.defaultBackend,
      resolveBackend: async (spec) => {
        const backend = await settings.resolve(spec);
        resolved.push(spec);
        return {
          ...backend,
          complete: () =>
            Promise.resolve({
              text: 'Hello',
              toolCalls: [],
              stopReason: 'end' as const,
              usage: { inputTokens: 1, outputTokens: 1 },
              latencyMs: 1,
            }),
        };
      },
    });
    const post = (body: Record<string, string>) =>
      app.request('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hello', requestId: randomUUID(), ...body }),
      });
    const response = await post({});
    expect(response.status).toBe(200);
    const text = await response.text();
    const event = text
      .split('\n')
      .find((line) => line.startsWith('data:') && line.includes('conversationId'))!;
    const { conversationId } = JSON.parse(event.slice(5)) as { conversationId: string };
    const saved = (await (await app.request(`/api/conversations/${conversationId}`)).json()) as {
      conversation: { backend_spec: string };
    };
    expect(saved.conversation.backend_spec).toBe('local/model-b');
    expect(resolved).toEqual(['local/model-b']);
    expect((await post({ conversationId, backend: 'local/model-a' })).status).toBe(400);
  } finally {
    db.close();
  }
});
