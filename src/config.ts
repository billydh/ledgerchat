import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';

/**
 * Configuration is grouped and validated lazily: a DB-only CLI must not fail
 * for want of a model. Each group is parsed on first access and cached.
 */

export class ConfigError extends Error {
  constructor(group: string, issues: string[]) {
    super(`Invalid configuration for "${group}":\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}

function parseGroup<T>(name: string, schema: z.ZodType<T>, env: Env): T {
  const result = schema.safeParse(env);
  if (!result.success) throw new ConfigError(name, formatIssues(result.error));
  return Object.freeze(result.data);
}

/** A blank assignment in .env means the same thing as an unset variable. */
const emptyAsUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;
const optional = z.preprocess(emptyAsUndefined, z.string().trim().min(1).optional());
const required = (varName: string) =>
  z
    .string({ error: `${varName} is required but not set` })
    .trim()
    .min(1, `${varName} is required but not set`);

const boolish = (varName: string, fallback: boolean) =>
  z.preprocess(
    emptyAsUndefined,
    z
      .enum(['true', 'false', '1', '0'], {
        error: `${varName} must be one of true, false, 1, 0`,
      })
      .optional()
      .transform((v) => (v === undefined ? fallback : v === 'true' || v === '1')),
  );

/**
 * Output cap per model request. Thinking models spend this budget on
 * reasoning too, so keep it in step with LOCAL_LLM_THINKING.
 */
const DEFAULT_LLM_MAX_TOKENS = 8192;
const llmMaxTokens = z.preprocess(
  emptyAsUndefined,
  z
    .string()
    .regex(/^\d+$/, 'LLM_MAX_TOKENS must be a positive integer')
    .optional()
    .transform((v) => (v === undefined ? DEFAULT_LLM_MAX_TOKENS : Number(v)))
    .refine((v) => v > 0, { error: 'LLM_MAX_TOKENS must be a positive integer' }),
);

const APP_DIR = 'ledgerchat';
const DB_FILE_NAME = 'ledgerchat.db';

export interface DataDirOptions {
  platform?: NodeJS.Platform;
  env?: Env;
  home?: string;
}

/**
 * The platform's per-user application data directory, so the database lands
 * where each OS expects it and never inside the repository or a synced folder:
 * `~/Library/Application Support/ledgerchat` on macOS, `%APPDATA%\ledgerchat`
 * on Windows, and `$XDG_DATA_HOME/ledgerchat` (default `~/.local/share`)
 * elsewhere.
 */
export function defaultDataDir({
  platform = process.platform,
  env = process.env,
  home = homedir(),
}: DataDirOptions = {}): string {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', APP_DIR);
  if (platform === 'win32') {
    const appData = env.APPDATA?.trim();
    return join(appData ? appData : join(home, 'AppData', 'Roaming'), APP_DIR);
  }
  const xdg = env.XDG_DATA_HOME?.trim();
  return join(xdg ? xdg : join(home, '.local', 'share'), APP_DIR);
}

/** `ledgerchat.db` in the data directory. */
export function defaultDbPath(options: DataDirOptions = {}): string {
  return join(defaultDataDir(options), DB_FILE_NAME);
}

const dbSchema = z
  .object({ DB_PATH: optional })
  .transform((env) => ({
    path: env.DB_PATH === undefined ? defaultDbPath({ env }) : expandHome(env.DB_PATH),
  }))
  .refine((v) => isAbsolute(v.path), { error: 'DB_PATH must resolve to an absolute path' });

const serverSchema = z
  .object({
    PORT: z.preprocess(
      emptyAsUndefined,
      z
        .string()
        .regex(/^\d+$/, 'PORT must be a positive integer')
        .optional()
        .transform((v) => (v === undefined ? 3000 : Number(v)))
        .refine((v) => v > 0 && v < 65536, { error: 'PORT must be between 1 and 65535' }),
    ),
  })
  .transform((env) => ({ port: env.PORT }));

/**
 * The local model: any OpenAI-compatible chat completions server. The model
 * id is the one thing without a default; the web app's Settings page supplies
 * it when `.env` does not.
 */
const llmSchema = z
  .object({
    LOCAL_LLM_BASE_URL: optional,
    LOCAL_LLM_MODEL: required('LOCAL_LLM_MODEL'),
    LOCAL_LLM_API_KEY: optional,
    LOCAL_LLM_THINKING: boolish('LOCAL_LLM_THINKING', false),
    LOCAL_LLM_PROBE: boolish('LOCAL_LLM_PROBE', false),
    LLM_MAX_TOKENS: llmMaxTokens,
  })
  .transform((env) => ({
    baseUrl: env.LOCAL_LLM_BASE_URL ?? 'http://localhost:8000',
    model: env.LOCAL_LLM_MODEL,
    apiKey: env.LOCAL_LLM_API_KEY ?? 'local',
    thinking: env.LOCAL_LLM_THINKING,
    probe: env.LOCAL_LLM_PROBE,
    maxTokens: env.LLM_MAX_TOKENS,
  }));

export type DbConfig = z.infer<typeof dbSchema>;
export type ServerConfig = z.infer<typeof serverSchema>;
export type LlmConfig = z.infer<typeof llmSchema>;

export interface Config {
  readonly db: DbConfig;
  readonly server: ServerConfig;
  readonly llm: LlmConfig;
  redactedSummary(): RedactedSummary;
}

export interface RedactedSummary {
  db: { path: string };
  server: { port: number };
  llm: { configured: boolean; label?: string; baseUrl?: string };
}

/**
 * Builds a config bound to an env object. Groups memoise on first access, so
 * `createConfig(process.env).db` never touches the model variables.
 */
export function createConfig(env: Env = process.env): Config {
  const cache = new Map<string, unknown>();
  const group = <T>(name: string, load: () => T): T => {
    if (!cache.has(name)) cache.set(name, load());
    return cache.get(name) as T;
  };

  const config: Config = {
    get db() {
      return group('db', () => {
        const parsed = parseGroup('db', dbSchema, env);
        // Owner-only, as the directory holds the ledger and the model
        // settings. Applies when the directory is created; an existing one
        // (a custom DB_PATH may point into a shared folder) is left alone.
        mkdirSync(dirname(parsed.path), { recursive: true, mode: 0o700 });
        return parsed;
      });
    },
    get server() {
      return group('server', () => parseGroup('server', serverSchema, env));
    },
    get llm() {
      return group('llm', () => parseGroup('llm', llmSchema, env));
    },
    redactedSummary(): RedactedSummary {
      return {
        db: safe(() => ({ path: config.db.path })) ?? { path: '<invalid>' },
        server: safe(() => ({ port: config.server.port })) ?? { port: 0 },
        llm: safe(() => {
          const llm = config.llm;
          return { configured: true, label: `local/${llm.model}`, baseUrl: llm.baseUrl };
        }) ?? { configured: false },
      };
    },
  };

  return config;
}

/** A group that fails to validate is reported as "not configured", never as a throw. */
function safe<T>(load: () => T): T | undefined {
  try {
    return load();
  } catch {
    return undefined;
  }
}

export const config = createConfig();
