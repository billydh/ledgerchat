import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { getCapabilities } from '../../src/llm/capabilities.js';
import { generateStructured, StructuredOutputError } from '../../src/llm/structured.js';
import type { CompleteRequest, Turn } from '../../src/llm/types.js';

const schema = z.object({ ok: z.boolean() });
const turn = (raw: unknown, text = false): Turn => ({
  text: text ? String(raw) : '',
  toolCalls: text ? [] : [{ id: 'call-1', name: 'submit', rawInput: raw }],
  stopReason: text ? 'end' : 'tool_calls',
  usage: { inputTokens: 10, outputTokens: 5 },
  latencyMs: 0,
});
function fake(native = false) {
  return {
    label: 'test',
    capabilities: { ...getCapabilities(), nativeStructuredOutput: native },
    complete: vi.fn<(_: CompleteRequest) => Promise<Turn>>(),
  };
}

it.each([false, true])('valid first response, native=%s', async (native) => {
  const backend = fake(native);
  backend.complete.mockResolvedValue(turn(native ? '{"ok":true}' : { ok: true }, native));
  expect(await generateStructured(backend, schema, 'Test')).toEqual({
    value: { ok: true },
    mode: native ? 'native' : 'forced_tool',
    attempts: 1,
    usage: { inputTokens: 10, outputTokens: 5 },
  });
  const request = backend.complete.mock.calls[0]![0];
  expect(native ? request.responseFormat?.jsonSchema : request.tools[0]?.jsonSchema).toEqual(
    z.toJSONSchema(schema),
  );
});

it('retries with validation errors and preserves tool array identity', async () => {
  const backend = fake();
  const bad = turn({ ok: 'wrong' });
  backend.complete.mockResolvedValueOnce(bad).mockResolvedValueOnce(turn({ ok: true }));
  expect(await generateStructured(backend, schema, 'Test')).toMatchObject({
    attempts: 2,
    usage: { inputTokens: 20, outputTokens: 10 },
  });
  const messages = backend.complete.mock.calls[1]![0].messages;
  expect(messages[1]).toMatchObject({ role: 'assistant', toolCalls: bad.toolCalls });
  const assistant = messages[1]!;
  expect(assistant.role === 'assistant' && assistant.toolCalls).toBe(bad.toolCalls);
  expect(messages[2]).toMatchObject({
    role: 'tool',
    results: [
      { callId: 'call-1', isError: true, content: expect.stringContaining('ok') as unknown },
    ],
  });
});

it('exhausts after three invalid results and carries output and Zod error', async () => {
  const backend = fake();
  backend.complete.mockResolvedValue(turn({ ok: 'wrong' }));
  const error = await generateStructured(backend, schema, 'Test').catch((e) => e as unknown);
  expect(error).toBeInstanceOf(StructuredOutputError);
  expect(error).toMatchObject({
    lastRawOutput: { ok: 'wrong' },
    lastValidationError: expect.any(z.ZodError) as unknown,
    attempts: 3,
    usage: { inputTokens: 30, outputTokens: 15 },
  });
  expect(backend.complete).toHaveBeenCalledTimes(3);
});

it('falls back on native 4xx without consuming validation attempts', async () => {
  const backend = fake(true);
  backend.complete.mockRejectedValueOnce({ status: 400 }).mockResolvedValueOnce(turn({ ok: true }));
  expect(await generateStructured(backend, schema, 'Test')).toMatchObject({
    mode: 'forced_tool',
    attempts: 2,
  });
  expect(backend.complete.mock.calls[1]![0]).toMatchObject({
    tools: [{ name: 'submit' }],
    toolChoice: { name: 'submit' },
  });
  expect(backend.complete.mock.calls[1]![0].responseFormat).toBeUndefined();
});

it.each([500, undefined])('propagates non-4xx errors (%s)', async (status) => {
  const backend = fake(true);
  const error = Object.assign(new Error('transport'), { status });
  backend.complete.mockRejectedValue(error);
  await expect(generateStructured(backend, schema, 'Test')).rejects.toBe(error);
  expect(backend.complete).toHaveBeenCalledTimes(1);
});

it.each([
  '```json\n{"ok":true}\n```',
  '<tool_call>{"name":"submit","arguments":{"ok":true}}</tool_call>',
  '{"type":"tool_use","name":"submit","input":{"ok":true}}',
  '{"function":{"name":"submit","arguments":"{\\"ok\\":true}"}}',
])('recovers literal output %s', async (text) => {
  const backend = fake();
  backend.capabilities.forcedToolChoice = false;
  backend.complete.mockResolvedValue(turn(text, true));
  expect((await generateStructured(backend, schema, 'Test')).value).toEqual({ ok: true });
  expect(backend.complete.mock.calls[0]![0].toolChoice).toBeUndefined();
});

it('rejects unknown and multiple calls and completes all error results', async () => {
  const backend = fake();
  const bad = turn({ ok: true });
  bad.toolCalls.push({ id: 'call-2', name: 'wrong', rawInput: {} });
  backend.complete.mockResolvedValueOnce(bad).mockResolvedValueOnce(turn({ ok: true }));
  await generateStructured(backend, schema, 'Test');
  expect(backend.complete.mock.calls[1]![0].messages[2]).toMatchObject({
    results: [{ callId: 'call-1' }, { callId: 'call-2' }],
  });
});

it('retries malformed and truncated text', async () => {
  const backend = fake(true);
  backend.complete
    .mockResolvedValueOnce(turn('{"ok":', true))
    .mockResolvedValueOnce({ ...turn('{"ok":true}', true), stopReason: 'max_tokens' })
    .mockResolvedValueOnce(turn('{"ok":true}', true));
  expect((await generateStructured(backend, schema, 'Test')).attempts).toBe(3);
});
