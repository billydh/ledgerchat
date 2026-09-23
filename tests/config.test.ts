import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type * as NodeOs from 'node:os';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { ConfigError, createConfig, defaultDataDir, defaultDbPath } from '../src/config.js';

vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof NodeOs>();
  return { ...original, homedir: () => `${original.tmpdir()}/ledgerchat-config-${process.pid}` };
});
afterAll(() =>
  rmSync(`${tmpdir()}/ledgerchat-config-${process.pid}`, { recursive: true, force: true }),
);

describe('config', () => {
  it('parses a fully populated env', () => {
    const config = createConfig({
      DB_PATH: '/tmp/ledgerchat-test/ledgerchat.db',
      PORT: '4000',
      LOCAL_LLM_BASE_URL: 'http://localhost:11434',
      LOCAL_LLM_MODEL: 'qwen3:32b',
      LOCAL_LLM_API_KEY: 'local-key-value',
      LOCAL_LLM_THINKING: 'true',
      LOCAL_LLM_PROBE: '1',
      LLM_MAX_TOKENS: '16384',
    });

    expect(config.db.path).toBe('/tmp/ledgerchat-test/ledgerchat.db');
    expect(config.server.port).toBe(4000);
    expect(config.llm).toEqual({
      baseUrl: 'http://localhost:11434',
      model: 'qwen3:32b',
      apiKey: 'local-key-value',
      thinking: true,
      probe: true,
      maxTokens: 16384,
    });
  });

  it('expands ~ in DB_PATH and defaults the port', () => {
    const config = createConfig({ DB_PATH: '~/ledgerchat-test/db.sqlite' });
    expect(config.db.path.startsWith('~')).toBe(false);
    expect(config.db.path.endsWith('/ledgerchat-test/db.sqlite')).toBe(true);
    expect(config.server.port).toBe(3000);
  });

  it('applies local model defaults', () => {
    const config = createConfig({ LOCAL_LLM_MODEL: 'qwen3.8-27b-4bit' });
    expect(config.llm).toEqual({
      baseUrl: 'http://localhost:8000',
      model: 'qwen3.8-27b-4bit',
      apiKey: 'local',
      thinking: false,
      probe: false,
      maxTokens: 8192,
    });
  });

  it('treats blank .env assignments as unset', () => {
    const config = createConfig({
      DB_PATH: '',
      PORT: '',
      LOCAL_LLM_BASE_URL: '',
      LOCAL_LLM_MODEL: 'local-model',
      LOCAL_LLM_API_KEY: '',
      LOCAL_LLM_THINKING: '',
      LOCAL_LLM_PROBE: '',
      LLM_MAX_TOKENS: '',
    });
    expect(config.db.path).toBe(defaultDbPath());
    expect(config.server.port).toBe(3000);
    expect(config.llm).toEqual({
      baseUrl: 'http://localhost:8000',
      model: 'local-model',
      apiKey: 'local',
      thinking: false,
      probe: false,
      maxTokens: 8192,
    });
  });

  it('names the missing variable when LOCAL_LLM_MODEL is absent', () => {
    const config = createConfig({ LOCAL_LLM_BASE_URL: 'http://localhost:8000' });
    expect(() => config.llm).toThrow(ConfigError);
    expect(() => config.llm).toThrow(/LOCAL_LLM_MODEL/);
  });

  it('rejects a malformed flag or token cap by name', () => {
    expect(() => createConfig({ LOCAL_LLM_MODEL: 'm', LOCAL_LLM_THINKING: 'yes' }).llm).toThrow(
      /LOCAL_LLM_THINKING/,
    );
    expect(() => createConfig({ LOCAL_LLM_MODEL: 'm', LLM_MAX_TOKENS: '0' }).llm).toThrow(
      /LLM_MAX_TOKENS/,
    );
    expect(() => createConfig({ PORT: '70000' }).server).toThrow(/PORT/);
  });

  it('lets a DB-only CLI run with an otherwise empty env', () => {
    const config = createConfig({ DB_PATH: '/tmp/ledgerchat-test/only-db.db' });
    expect(config.db.path).toBe('/tmp/ledgerchat-test/only-db.db');
    expect(() => config.llm).toThrow(ConfigError);
  });

  it('memoises a group so it is parsed once', () => {
    const config = createConfig({ LOCAL_LLM_MODEL: 'm' });
    expect(config.llm).toBe(config.llm);
  });

  it('redactedSummary contains no secret values', () => {
    const config = createConfig({
      DB_PATH: '/tmp/ledgerchat-test/redact.db',
      LOCAL_LLM_MODEL: 'qwen3:8b',
      LOCAL_LLM_API_KEY: 'local-key-value',
    });

    const serialised = JSON.stringify(config.redactedSummary());
    expect(serialised).not.toContain('local-key-value');
    expect(config.redactedSummary().llm.label).toBe('local/qwen3:8b');
  });

  it('reports an unconfigured group as not configured rather than throwing', () => {
    const summary = createConfig({
      DB_PATH: '/tmp/ledgerchat-test/unconfigured.db',
    }).redactedSummary();
    expect(summary.llm.configured).toBe(false);
  });
});

describe('default database location', () => {
  const home = '/home/ada';

  it('uses Application Support on macOS', () => {
    expect(defaultDbPath({ platform: 'darwin', env: {}, home })).toBe(
      '/home/ada/Library/Application Support/ledgerchat/ledgerchat.db',
    );
  });

  it('uses XDG_DATA_HOME on Linux, falling back to ~/.local/share', () => {
    expect(defaultDataDir({ platform: 'linux', env: {}, home })).toBe(
      '/home/ada/.local/share/ledgerchat',
    );
    expect(defaultDataDir({ platform: 'linux', env: { XDG_DATA_HOME: '/data/xdg' }, home })).toBe(
      '/data/xdg/ledgerchat',
    );
    // A blank XDG variable is unset, as every other env var is treated.
    expect(defaultDataDir({ platform: 'linux', env: { XDG_DATA_HOME: '  ' }, home })).toBe(
      '/home/ada/.local/share/ledgerchat',
    );
  });

  it('uses APPDATA on Windows, falling back to the roaming profile', () => {
    expect(
      defaultDataDir({
        platform: 'win32',
        env: { APPDATA: 'C:\\Users\\ada\\AppData\\Roaming' },
        home: 'C:\\Users\\ada',
      }),
    ).toMatch(/^C:\\Users\\ada\\AppData\\Roaming[\\/]ledgerchat$/);
    expect(defaultDataDir({ platform: 'win32', env: {}, home: 'C:\\Users\\ada' })).toMatch(
      /^C:\\Users\\ada[\\/]AppData[\\/]Roaming[\\/]ledgerchat$/,
    );
  });
});
