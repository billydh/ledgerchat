import { describe, expect, it, vi } from 'vitest';
import { createBackend, formatBackendSpec, parseBackendSpec } from '../../src/llm/backend.js';
import { isLoopbackHost } from '../../src/loopback.js';
import type { AdapterOptions, LlmBackend } from '../../src/llm/backend.js';

function adapter() {
  const complete = vi
    .fn<LlmBackend['complete']>()
    .mockRejectedValue(new Error('No network in factory'));
  return { complete, factory: vi.fn((_options: AdapterOptions) => ({ complete })) };
}

describe('backend specs', () => {
  it.each(['local/qwen-4bit', 'local/org/model', 'local/qwen3:32b'])('round trips %s', (spec) => {
    expect(formatBackendSpec(parseBackendSpec(spec))).toBe(spec);
  });
  it.each([
    '',
    'local',
    'local/',
    ' local/m',
    'local/m ',
    'LOCAL/m',
    'frontier:openai/m',
    'local/a//b',
    'local/../b',
    'local/a\nb',
    'local/m\n',
  ])('rejects %j helpfully', (spec) => {
    expect(() => parseBackendSpec(spec)).toThrow('Expected local/<model>');
  });
});

describe('backend factory', () => {
  it('resolves a local model and its flags without a request', () => {
    const { factory, complete } = adapter();
    const backend = createBackend('local/org/model', {
      adapter: factory,
      env: { LOCAL_LLM_THINKING: 'true', LOCAL_LLM_PROBE: '1' },
    });
    expect(backend.label).toBe('local/org/model');
    expect(backend.target.baseURL).toBe('http://localhost:8000/v1');
    expect(backend.capabilities.thinking).toBe(true);
    expect(backend.probe).toBe(true);
    expect(backend.maxTokens).toBe(8192);
    expect(factory).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ model: 'org/model', apiKey: 'local' }),
    );
    expect(complete).not.toHaveBeenCalled();
  });
  it('lets the spec override LOCAL_LLM_MODEL from the env', () => {
    const { factory } = adapter();
    const backend = createBackend('local/chosen', {
      adapter: factory,
      env: { LOCAL_LLM_MODEL: 'default', LOCAL_LLM_API_KEY: 'k' },
    });
    expect(backend.target.model).toBe('chosen');
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'k' }));
  });
  it('preserves endpoint overrides and avoids duplicate v1', () => {
    const { factory } = adapter();
    const backend = createBackend('local/m', {
      adapter: factory,
      env: { LOCAL_LLM_BASE_URL: 'http://localhost:9000/v1/' },
    });
    expect(backend.target.baseURL).toBe('http://localhost:9000/v1');
    expect(
      createBackend('local/m', {
        adapter: factory,
        env: { LOCAL_LLM_BASE_URL: 'http://localhost:11434' },
      }).target.baseURL,
    ).toBe('http://localhost:11434/v1');
  });
  it('reads LLM_MAX_TOKENS', () => {
    const { factory } = adapter();
    expect(
      createBackend('local/m', { adapter: factory, env: { LLM_MAX_TOKENS: '2048' } }).maxTokens,
    ).toBe(2048);
  });
  it('validates flags and unsafe URLs before constructing an adapter', () => {
    const { factory } = adapter();
    expect(() =>
      createBackend('local/m', { adapter: factory, env: { LOCAL_LLM_PROBE: 'yes' } }),
    ).toThrow('LOCAL_LLM_PROBE');
    for (const bad of ['0', '-1', 'lots'])
      expect(() =>
        createBackend('local/m', { adapter: factory, env: { LLM_MAX_TOKENS: bad } }),
      ).toThrow('LLM_MAX_TOKENS');
    for (const url of [
      'https://user:secret@localhost',
      'http://localhost:8000?key=1',
      'http://localhost:8000#x',
      'ftp://localhost',
    ])
      expect(() =>
        createBackend('local/m', { adapter: factory, env: { LOCAL_LLM_BASE_URL: url } }),
      ).toThrow('without credentials');
    expect(factory).not.toHaveBeenCalled();
  });
  it('accepts only endpoints on this machine', () => {
    const { factory } = adapter();
    for (const url of [
      'http://localhost:11434',
      'http://127.0.0.1:8000',
      'http://127.1.2.3:8000',
      'http://[::1]:8000',
      'http://[0:0:0:0:0:0:0:1]:8000',
    ])
      expect(
        createBackend('local/m', { adapter: factory, env: { LOCAL_LLM_BASE_URL: url } }).target
          .baseURL,
      ).toMatch(/\/v1$/);
    for (const url of [
      'http://192.168.1.10:8080',
      'https://api.openai.com',
      'https://localhost.example.com',
      'http://127.0.0.1.example.com',
      'http://[::ffff:127.0.0.1]:8000',
      'http://0.0.0.0:8000',
    ])
      expect(() =>
        createBackend('local/m', { adapter: factory, env: { LOCAL_LLM_BASE_URL: url } }),
      ).toThrow('on this machine');
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('LOCALHOST')).toBe(false);
  });
});
