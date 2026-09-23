import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONSERVATIVE_CAPABILITIES,
  getCapabilities,
  probeCapabilities,
} from '../../src/llm/capabilities.js';
import type { ConfiguredBackend } from '../../src/llm/backend.js';
import type { Turn } from '../../src/llm/types.js';

const toolTurn: Turn = {
  text: '',
  toolCalls: [{ id: '1', name: 'submit', rawInput: { ok: true } }],
  stopReason: 'tool_calls',
  usage: { inputTokens: 1, outputTokens: 1 },
  latencyMs: 1,
};
const jsonTurn: Turn = { ...toolTurn, text: '{"ok":true}', toolCalls: [], stopReason: 'end' };
function backend(model: string, probe = true) {
  return {
    label: `local/${model}`,
    target: { label: `local/${model}`, model, baseURL: 'http://localhost:8000/v1' },
    probe,
    capabilities: getCapabilities(),
    complete: vi
      .fn<ConfiguredBackend['complete']>()
      .mockResolvedValueOnce(toolTurn)
      .mockResolvedValueOnce(jsonTurn),
  } satisfies ConfiguredBackend;
}

afterEach(() => vi.useRealTimers());

describe('capability table', () => {
  it('assumes a streaming, forced-tool-choice local server without native JSON output', () => {
    const actual = getCapabilities();
    expect(actual).toEqual({
      streaming: true,
      strictTools: false,
      nativeStructuredOutput: false,
      thinking: false,
      promptCaching: false,
      forcedToolChoice: true,
    });
    expect(Object.isFrozen(actual)).toBe(true);
    expect(getCapabilities(true).thinking).toBe(true);
    expect(Object.isFrozen(CONSERVATIVE_CAPABILITIES)).toBe(true);
  });
});

describe('capability probe', () => {
  it('skips the probe unless opted in', async () => {
    const b = backend('skip-local', false);
    expect(await probeCapabilities(b)).toBe(b.capabilities);
    expect(b.complete).not.toHaveBeenCalled();
  });
  it('deduplicates concurrent and later requests across backend instances', async () => {
    const b = backend('dedup');
    const second = backend('dedup');
    const [a, c] = await Promise.all([probeCapabilities(b), probeCapabilities(second)]);
    expect(a).toBe(c);
    expect(a.nativeStructuredOutput).toBe(true);
    expect(a.strictTools).toBe(false);
    expect(await probeCapabilities(second)).toBe(a);
    expect(b.complete).toHaveBeenCalledTimes(2);
    expect(second.complete).not.toHaveBeenCalled();
    expect(b.complete.mock.calls[1]?.[0]).toMatchObject({
      tools: [],
      responseFormat: { name: 'probe' },
    });
  });
  it('enables what the probe verified and nothing more', async () => {
    const b = backend('verified');
    expect(await probeCapabilities(b)).toEqual({
      ...getCapabilities(),
      forcedToolChoice: true,
      nativeStructuredOutput: true,
    });
  });
  it('fails soft and caches rejected requests', async () => {
    const b = backend('reject');
    b.complete.mockReset().mockRejectedValue(new Error('offline'));
    expect(await probeCapabilities(b)).toBe(CONSERVATIVE_CAPABILITIES);
    expect(await probeCapabilities(b)).toBe(CONSERVATIVE_CAPABILITIES);
    expect(b.complete).toHaveBeenCalledTimes(1);
  });
  it.each(['{"ok":false}', '{"ok":true,"extra":1}', 'not JSON'])(
    'rejects invalid structured response %s',
    async (text) => {
      const b = backend(`bad-json-${text}`);
      b.complete
        .mockReset()
        .mockResolvedValueOnce(toolTurn)
        .mockResolvedValueOnce({ ...jsonTurn, text });
      expect(await probeCapabilities(b)).toBe(CONSERVATIVE_CAPABILITIES);
    },
  );
  it('does not mistake prose for tool calling', async () => {
    const b = backend('prose');
    b.complete.mockReset().mockResolvedValue(jsonTurn);
    expect(await probeCapabilities(b)).toBe(CONSERVATIVE_CAPABILITIES);
    expect(b.complete).toHaveBeenCalledTimes(1);
  });
  it('bounds a hung request and aborts its transport', async () => {
    vi.useFakeTimers();
    const b = backend('hung');
    b.complete.mockReset().mockImplementation(() => new Promise(() => {}));
    const pending = probeCapabilities(b);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toBe(CONSERVATIVE_CAPABILITIES);
    expect(b.complete.mock.calls[0]?.[0].signal?.aborted).toBe(true);
  });
  it('keeps different endpoints separate', async () => {
    const a = backend('endpoint');
    const b = backend('endpoint');
    b.target.baseURL = 'http://localhost:9000/v1';
    await Promise.all([probeCapabilities(a), probeCapabilities(b)]);
    expect(a.complete).toHaveBeenCalledTimes(2);
    expect(b.complete).toHaveBeenCalledTimes(2);
  });
});
