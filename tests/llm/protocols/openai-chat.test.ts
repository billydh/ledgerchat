import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import OpenAI from 'openai';
import parallel from '../../../fixtures/llm/openai-parallel.json' with { type: 'json' };
import { createOpenAIChat } from '../../../src/llm/protocols/openai-chat.js';
import { createBackend } from '../../../src/llm/backend.js';
import type { Capabilities } from '../../../src/llm/types.js';
import { json, options, request, sse, transport } from './helpers.js';

function setup(responses: Response[], capabilities: Partial<Capabilities> = {}) {
  const http = transport(...responses);
  const opts = options(capabilities);
  return {
    ...http,
    backend: createOpenAIChat(
      opts,
      new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL, fetch: http.fetch, maxRetries: 0 }),
    ),
  };
}
const textResponse = {
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Done.' } }],
};

describe('OpenAI Chat adapter', () => {
  it('round trips parallel calls and ordered results through the SDK', async () => {
    const { backend, bodies, fetch } = setup([json(parallel), json(textResponse)], {
      strictTools: true,
    });
    const turn = await backend.complete({ ...request, toolChoice: { name: 'search' } });
    expect(turn.toolCalls).toEqual([
      { id: 'call_a', name: 'search', rawInput: { account: 'a' } },
      { id: 'call_b', name: 'search', rawInput: { account: 'b' } },
    ]);
    expect(turn.usage).toEqual({ inputTokens: 12, outputTokens: 8 });
    expect(turn.stopReason).toBe('tool_calls');
    expect(turn.latencyMs).toBeGreaterThanOrEqual(0);
    await backend.complete({
      ...request,
      messages: [
        ...request.messages,
        { role: 'assistant', text: turn.text, toolCalls: turn.toolCalls },
        {
          role: 'tool',
          results: [
            { callId: 'call_a', content: '10', isError: false },
            { callId: 'call_b', content: 'Missing account', isError: true },
          ],
        },
      ],
    });
    expect(bodies[1]?.messages).toEqual([
      { role: 'system', content: request.system },
      { role: 'user', content: 'Check accounts.' },
      parallel.choices[0]?.message,
      { role: 'tool', tool_call_id: 'call_a', content: '10' },
      {
        role: 'tool',
        tool_call_id: 'call_b',
        content: '{"isError":true,"content":"Missing account"}',
      },
    ]);
    expect(bodies[0]).toMatchObject({
      max_tokens: 2048,
      tools: [{ function: { strict: true } }],
      tool_choice: { type: 'function', function: { name: 'search' } },
    });
    expect(fetch.mock.calls[0]?.[0]).toBe('https://example.test/v1/chat/completions');
  });
  it('assembles interleaved streamed calls by index and keeps trailing usage', async () => {
    const events = [
      {
        choices: [
          {
            index: 0,
            delta: {
              content: 'Check ',
              tool_calls: [
                {
                  index: 1,
                  type: 'function',
                  function: { name: 'search', arguments: '{"account":' },
                },
                { index: 0, id: 'first', function: { name: 'search', arguments: '{"account":' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              content: 'both.',
              tool_calls: [
                { index: 0, function: { arguments: '"a"}' } },
                { index: 1, function: { arguments: '"b"}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      { choices: [], usage: { prompt_tokens: 3, completion_tokens: 4 } },
    ];
    const { backend, bodies } = setup([sse(events), json(textResponse)]);
    const onText = vi.fn();
    const turn = await backend.complete({ ...request, onText });
    expect(onText.mock.calls).toEqual([['Check '], ['both.']]);
    expect(turn.text).toBe('Check both.');
    expect(turn.toolCalls.map((c) => c.rawInput)).toEqual([{ account: 'a' }, { account: 'b' }]);
    expect(turn.toolCalls[0]?.id).toBe('first');
    expect(turn.usage).toEqual({ inputTokens: 3, outputTokens: 4 });
    await backend.complete({
      ...request,
      messages: [{ role: 'assistant', text: turn.text, toolCalls: turn.toolCalls }],
    });
    expect(JSON.stringify(bodies[1]?.messages)).toContain(turn.toolCalls[1]!.id);
  });
  it.each([true, false])('strips refused keywords only under strict tools (%s)', async (strict) => {
    const { backend, bodies } = setup([json(textResponse)], { strictTools: strict });
    const jsonSchema = {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } },
      additionalProperties: false,
    };
    await backend.complete({
      ...request,
      tools: [{ name: 'search', description: 'Search accounts', jsonSchema }],
    });
    const tool = (bodies[0] as { tools: { function: Record<string, unknown> }[] }).tools[0]!
      .function;
    expect(tool.strict).toBe(strict ? true : undefined);
    expect(tool.parameters).toEqual(
      strict
        ? {
            type: 'object',
            properties: { limit: { type: 'integer', description: 'Constraints: >= 1, <= 100.' } },
            additionalProperties: false,
          }
        : jsonSchema,
    );
  });
  it('tolerates parsed arguments, absent usage, and missing IDs without reusing IDs across turns', async () => {
    const response = {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { type: 'function', function: { name: 'search', arguments: { account: 'a' } } },
            ],
          },
        },
      ],
    };
    const { backend } = setup([json(response), json(response)]);
    const a = await backend.complete(request);
    const b = await backend.complete(request);
    expect(a.toolCalls[0]?.rawInput).toEqual({ account: 'a' });
    expect(a.toolCalls[0]?.id).toBeTruthy();
    expect(a.toolCalls[0]?.id).not.toBe(b.toolCalls[0]?.id);
    expect(a.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(a.stopReason).toBe('other');
  });
  it.each([
    ['stop', 'end'],
    ['length', 'max_tokens'],
    ['content_filter', 'other'],
  ])('maps %s to %s', async (finish_reason, expected) => {
    const { backend } = setup([
      json({ choices: [{ finish_reason, message: { content: 'answer' } }] }),
    ]);
    expect((await backend.complete(request)).stopReason).toBe(expected);
  });
  it('keeps malformed JSON for the validation loop', async () => {
    const response = structuredClone(parallel);
    response.choices[0]!.message.tool_calls[0]!.function.arguments = '{broken';
    const { backend } = setup([json(response)]);
    expect((await backend.complete(request)).toolCalls[0]?.rawInput).toBe('{broken');
  });
  it('sends native schemas while the capability is false, without strict tools', async () => {
    const { backend, bodies } = setup([json(textResponse)]);
    await backend.complete({
      ...request,
      responseFormat: { name: 'result', jsonSchema: { type: 'object' } },
    });
    expect(bodies[0]).toMatchObject({
      max_tokens: 2048,
      chat_template_kwargs: { enable_thinking: false },
      response_format: { type: 'json_schema', json_schema: { name: 'result', strict: true } },
    });
    expect(JSON.stringify(bodies[0]?.tools)).not.toContain('strict');
  });
  it('only disables template thinking when thinking is off', async () => {
    const cases = [
      { opts: options(), expected: true },
      { opts: options({ thinking: true }), expected: false },
    ];
    for (const { opts, expected } of cases) {
      const http = transport(json(textResponse));
      const backend = createOpenAIChat(
        opts,
        new OpenAI({ apiKey: 'k', baseURL: opts.baseURL, fetch: http.fetch, maxRetries: 0 }),
      );
      await backend.complete({ ...request, tools: [] });
      expect(http.bodies[0]?.chat_template_kwargs !== undefined).toBe(expected);
    }
  });
  it('omits tool settings on text-only requests and forwards nonstreaming text', async () => {
    const { backend, bodies } = setup([json(textResponse)]);
    const onText = vi.fn();
    const b = createOpenAIChat(
      options({ streaming: false }),
      new OpenAI({ apiKey: 'k', fetch: transport(json(textResponse)).fetch }),
    );
    await b.complete({ ...request, tools: [], onText });
    expect(onText).toHaveBeenCalledWith('Done.');
    await backend.complete({ ...request, tools: [] });
    expect(bodies[0]).not.toHaveProperty('tools');
    expect(bodies[0]).not.toHaveProperty('tool_choice');
  });
  it('preserves HTTP errors for structured-output fallback and honors abort', async () => {
    const { backend } = setup([json({ error: { message: 'Unsupported schema' } }, 400)]);
    await expect(backend.complete(request)).rejects.toMatchObject({ status: 400 });
    const abort = new AbortController();
    abort.abort();
    await expect(backend.complete({ ...request, signal: abort.signal })).rejects.toThrow();
  });
  it('replays JSON string inputs with their original encoding', async () => {
    const response = structuredClone(parallel);
    response.choices[0]!.message.tool_calls[0]!.function.arguments = '"a"';
    const { backend, bodies } = setup([json(response), json(textResponse)]);
    const turn = await backend.complete(request);
    expect(turn.toolCalls[0]?.rawInput).toBe('a');
    await backend.complete({
      ...request,
      messages: [{ role: 'assistant', text: turn.text, toolCalls: turn.toolCalls }],
    });
    expect(bodies[1]?.messages).toEqual([
      { role: 'system', content: request.system },
      response.choices[0]?.message,
    ]);
  });
  it('does not return success when cancelled during streaming', async () => {
    const { backend } = setup([
      sse([{ choices: [{ index: 0, delta: { content: 'Partial' }, finish_reason: 'stop' }] }]),
    ]);
    const controller = new AbortController();
    await expect(
      backend.complete({ ...request, signal: controller.signal, onText: () => controller.abort() }),
    ).rejects.toThrow();
  });
  it('constructs the default adapter without network calls', () => {
    expect(createBackend('local/test', { env: {} }).label).toBe('local/test');
  });
  it('refuses redirects instead of forwarding chat contents', async () => {
    let forwarded = 0;
    const destination = createServer((req, res) => {
      forwarded++;
      req.resume();
      res.end();
    });
    await new Promise<void>((resolve) => destination.listen(0, '127.0.0.1', resolve));
    const destinationPort = (destination.address() as AddressInfo).port;
    const source = createServer((req, res) => {
      req.resume();
      res.writeHead(307, {
        Location: `http://127.0.0.1:${destinationPort}/v1/chat/completions`,
      });
      res.end();
    });
    await new Promise<void>((resolve) => source.listen(0, '127.0.0.1', resolve));
    try {
      const sourcePort = (source.address() as AddressInfo).port;
      const backend = createOpenAIChat({
        ...options(),
        baseURL: `http://127.0.0.1:${sourcePort}/v1`,
      });
      await expect(backend.complete({ ...request, tools: [] })).rejects.toThrow();
      expect(forwarded).toBe(0);
    } finally {
      source.closeAllConnections();
      destination.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => source.close(() => resolve())),
        new Promise<void>((resolve) => destination.close(() => resolve())),
      ]);
    }
  });
});
