import { vi } from 'vitest';
import type { AdapterOptions } from '../../../src/llm/backend.js';
import { getCapabilities } from '../../../src/llm/capabilities.js';
import type { Capabilities, CompleteRequest } from '../../../src/llm/types.js';

export const request: CompleteRequest = {
  system: 'Use tools.',
  messages: [{ role: 'user', text: 'Check accounts.' }],
  tools: [
    {
      name: 'search',
      description: 'Search accounts',
      jsonSchema: {
        type: 'object',
        properties: { account: { type: 'string' } },
        required: ['account'],
        additionalProperties: false,
      },
    },
  ],
  maxTokens: 2048,
};
/** A local backend at a test endpoint; `overrides` adjusts the assumed capabilities. */
export function options(overrides: Partial<Capabilities> = {}): AdapterOptions {
  return {
    label: 'local/test',
    model: 'test',
    apiKey: 'test-key',
    baseURL: 'https://example.test/v1',
    capabilities: { ...getCapabilities(), ...overrides },
  };
}
export function transport(...responses: Response[]) {
  const bodies: Record<string, unknown>[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>((_url, init) => {
    if (typeof init?.body !== 'string') throw new Error('Expected JSON request body');
    bodies.push(JSON.parse(init.body) as Record<string, unknown>);
    const response = responses.shift();
    if (!response) throw new Error('Unexpected request');
    return Promise.resolve(response);
  });
  return { fetch, bodies };
}
export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
export function sse(events: unknown[], done = true): Response {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') +
      (done ? 'data: [DONE]\n\n' : ''),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}
