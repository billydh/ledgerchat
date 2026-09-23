/**
 * Web hardening: the response headers every answer carries, the same-origin
 * CSP the page runs under, request ids in the log, and the graceful shutdown
 * a stop signal relies on.
 */
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openMemoryDb, type Db } from '../../src/db/client.js';
import { getCapabilities } from '../../src/llm/capabilities.js';
import type { LlmBackend } from '../../src/llm/backend.js';
import { createApp } from '../../src/server/app.js';
import { gracefulShutdown } from '../../src/server/shutdown.js';
import { constantTenant } from '../../src/server/tenancy.js';

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
    resolveBackend: () => Promise.resolve(backend),
    backendStatus: () =>
      Promise.resolve([{ spec: 'local/test', configured: true, reachable: true }]),
    ...overrides,
  }).app;
}

describe('response headers', () => {
  it('sends a same-origin CSP and a page with no inline script', async () => {
    const page = await setup().request('/');
    const csp = page.headers.get('content-security-policy')!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('nonce');
    const html = await page.text();
    const tags = html.match(/<script[^>]*>/g)!;
    expect(tags.length).toBeGreaterThanOrEqual(3);
    for (const tag of tags) expect(tag).toContain('src="/');
  });

  it('sets the fixed hardening headers and never sends HSTS', async () => {
    const app = setup();
    for (const path of ['/', '/api/status', '/theme.css', '/missing']) {
      const response = await app.request(path);
      expect(response.headers.get('referrer-policy'), path).toBe('same-origin');
      expect(response.headers.get('x-frame-options'), path).toBe('DENY');
      expect(response.headers.get('x-content-type-options'), path).toBe('nosniff');
      expect(response.headers.get('permissions-policy'), path).toContain('camera=()');
      expect(response.headers.get('strict-transport-security'), path).toBeNull();
      expect(response.headers.get('x-request-id'), path).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('marks every /api response no-store, including streams and errors', async () => {
    const app = setup();
    expect((await app.request('/api/status')).headers.get('cache-control')).toBe('no-store');
    expect((await app.request('/api/missing')).headers.get('cache-control')).toBe('no-store');
    const cross = await app.request('/api/conversations/x', {
      method: 'DELETE',
      headers: { origin: 'https://evil.example' },
    });
    expect(cross.status).toBe(403);
    expect(cross.headers.get('cache-control')).toBe('no-store');
    const stream = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello', requestId: randomUUID(), backend: 'local/test' }),
    });
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    expect(stream.headers.get('cache-control')).toBe('no-store');
    await stream.text();
    // Assets outside /api keep their own caching.
    expect((await app.request('/fonts/dm-mono-400.woff2')).headers.get('cache-control')).toContain(
      'immutable',
    );
  });

  it('logs the request id it answered with', async () => {
    const log = vi.fn();
    const response = await setup({ log }).request('/api/status');
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toMatchObject({
      requestId: response.headers.get('x-request-id'),
      method: 'GET',
      path: '/api/status',
      status: 200,
    });
    expect(log.mock.calls[0]![0]).not.toHaveProperty('user');
  });
});

describe('host check', () => {
  it('answers only requests addressed to this machine, on every route', async () => {
    const app = setup();
    for (const host of ['localhost:3000', '127.0.0.1:3000', '[::1]:3000', '127.5.6.7'])
      for (const path of ['/', '/api/status', '/theme.css'])
        expect((await app.request(`http://${host}${path}`)).status, `${host}${path}`).toBe(200);
    // A rebinding page reaches 127.0.0.1 through its own hostname, so Host
    // names that site while Origin matches it; reads and writes alike fail.
    for (const host of [
      'rebind.evil.example',
      'localhost.evil.example',
      '192.168.1.10:3000',
      '[::ffff:127.0.0.1]:3000',
    ])
      for (const [path, init] of [
        ['/', {}],
        ['/api/status', {}],
        ['/api/transactions', {}],
        [
          '/api/conversations/x',
          {
            method: 'DELETE',
            headers: { Origin: `http://${host}`, 'Sec-Fetch-Site': 'same-origin' },
          },
        ],
      ] as const) {
        const response = await app.request(`http://${host}${path}`, init);
        expect(response.status, `${host}${path}`).toBe(421);
        expect(response.headers.get('x-frame-options'), `${host}${path}`).toBe('DENY');
        expect(await response.json()).toEqual({
          error: 'This server only answers to localhost.',
        });
      }
  });
});

describe('graceful shutdown', () => {
  let stop: (() => void) | undefined;
  const app = new Hono();
  app.get('/stream', (c) =>
    streamSSE(c, async (stream) => {
      await stream.writeSSE({ data: 'start' });
      await new Promise<void>((resolve) => {
        stop = resolve;
        stream.onAbort(resolve);
      });
      await stream.writeSSE({ data: 'end' }).catch(() => {});
    }),
  );
  app.get('/quick', (c) => c.text('ok'));

  const listen = () =>
    new Promise<{ server: ReturnType<typeof serve>; url: string }>((resolve) => {
      const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (info) =>
        resolve({ server, url: `http://127.0.0.1:${info.port}` }),
      );
    });
  const decode = (chunk: { done: boolean; value?: Uint8Array | undefined }) =>
    chunk.done ? '' : new TextDecoder().decode(chunk.value);
  const firstChunk = async (response: Response) => {
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    return { reader, text: decode(await reader.read()) };
  };

  it('waits for an in-flight stream to finish before closing the databases', async () => {
    const { server, url } = await listen();
    const onClosed = vi.fn(),
      log = vi.fn();
    const shutdown = gracefulShutdown(server, { drainMs: 5_000, onClosed, log });
    const response = await fetch(`${url}/stream`);
    const { reader, text } = await firstChunk(response);
    expect(text).toContain('start');
    const done = shutdown('SIGTERM');
    expect(shutdown()).toBe(done); // a second signal joins the first
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onClosed).not.toHaveBeenCalled();
    // The listener is closed: a new connection is refused while the stream lives on.
    await expect(fetch(`${url}/quick`)).rejects.toThrow();
    stop?.();
    expect(decode(await reader.read())).toContain('end');
    await done;
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.map(([entry]) => (entry as { event: string }).event)).toEqual([
      'shutdown',
      'shutdown_complete',
    ]);
    expect(log.mock.calls[0]![0]).toMatchObject({ signal: 'SIGTERM' });
    expect(log.mock.calls.at(-1)![0]).toMatchObject({ clean: true });
    // A keep-alive socket left open by the client did not hold the close up.
    expect((log.mock.calls.at(-1)![0] as { durationMs: number }).durationMs).toBeLessThan(2_000);
  });

  it('cuts a stream that outlives the drain window, then waits for work to settle', async () => {
    const { server, url } = await listen();
    let busy = true;
    const onClosed = vi.fn(),
      log = vi.fn();
    const shutdown = gracefulShutdown(server, {
      drainMs: 100,
      settleMs: 2_000,
      busy: () => busy,
      onClosed,
      log,
    });
    const response = await fetch(`${url}/stream`);
    const { reader } = await firstChunk(response);
    const done = shutdown('SIGTERM');
    // The connection is destroyed at the deadline: the client's read fails.
    await expect(reader.read()).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Work aborted by the cut is still finishing: the handles stay open.
    expect(onClosed).not.toHaveBeenCalled();
    busy = false;
    await done;
    expect(onClosed).toHaveBeenCalledTimes(1);
    const events = log.mock.calls.map(([entry]) => (entry as { event: string }).event);
    expect(events).toEqual(['shutdown', 'shutdown_drain_expired', 'shutdown_complete']);
  });

  it('gives up on work that never settles once the settle window passes', async () => {
    const { server } = await listen();
    const onClosed = vi.fn(),
      log = vi.fn();
    const shutdown = gracefulShutdown(server, { settleMs: 120, busy: () => true, onClosed, log });
    await shutdown('SIGINT');
    expect(onClosed).toHaveBeenCalledTimes(1);
    const events = log.mock.calls.map(([entry]) => (entry as { event: string }).event);
    expect(events).toEqual(['shutdown', 'shutdown_settle_expired', 'shutdown_complete']);
    expect(log.mock.calls.at(-1)![0]).toMatchObject({ clean: false });
  });
});
