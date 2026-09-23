import { readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createBackend, formatBackendSpec, parseBackendSpec } from '../llm/backend.js';
import { createConfig } from '../config.js';
import { backendServices } from './backends.js';

const savedSchema = z.strictObject({
  model: z.string().trim().max(250),
  apiKey: z.string().trim().max(4096),
  baseUrl: z.string().trim().max(2048),
  thinking: z.boolean(),
});
export const settingsSchema = savedSchema.extend({
  apiKey: savedSchema.shape.apiKey.optional(),
  baseUrl: savedSchema.shape.baseUrl.default(''),
  thinking: savedSchema.shape.thinking.default(false),
});
export const localModelsSchema = settingsSchema.pick({ baseUrl: true, apiKey: true });
export class SettingsValidationError extends Error {}
type Saved = z.infer<typeof savedSchema>;

/**
 * The model the web app uses, saved in an owner-readable file beside the
 * database. `.env` supplies the starting values; the file, once written,
 * wins. The key is never returned to the browser.
 */
export function modelSettings(path: string, initialEnv = process.env) {
  const env = { ...initialEnv };
  let saved: Saved = {
    model: env.LOCAL_LLM_MODEL ?? '',
    apiKey: env.LOCAL_LLM_API_KEY ?? '',
    baseUrl: env.LOCAL_LLM_BASE_URL?.trim() || 'http://localhost:8000',
    thinking: env.LOCAL_LLM_THINKING === 'true' || env.LOCAL_LLM_THINKING === '1',
  };
  try {
    saved = savedSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error('Could not load model settings. Check the settings file.', { cause: error });
  }
  function environment(profile = saved) {
    return {
      ...env,
      LOCAL_LLM_MODEL: profile.model || undefined,
      LOCAL_LLM_API_KEY: profile.apiKey || undefined,
      LOCAL_LLM_BASE_URL: profile.baseUrl || undefined,
      LOCAL_LLM_THINKING: profile.thinking ? 'true' : 'false',
    };
  }
  let services: ReturnType<typeof backendServices> | undefined;
  function configuredSpec(): string | undefined {
    if (!saved.model) return undefined;
    try {
      const spec = formatBackendSpec(createConfig(environment()).llm);
      createBackend(spec, { env: environment() });
      return spec;
    } catch {
      return undefined;
    }
  }
  function service() {
    services ??= backendServices(environment());
    return services;
  }
  const defaultBackend = () => configuredSpec() ?? '';
  const status = async () => (configuredSpec() ? service().status() : []);
  const read = () => ({
    model: saved.model,
    baseUrl: saved.baseUrl,
    thinking: saved.thinking,
    hasApiKey: Boolean(saved.apiKey),
  });
  const localModels = async (input: z.input<typeof localModelsSchema>) => {
    const value = localModelsSchema.parse(input);
    const key = value.apiKey ?? saved.apiKey;
    let baseURL: string;
    try {
      baseURL = createBackend('local/discovery', {
        env: environment({
          model: 'discovery',
          apiKey: key,
          baseUrl: value.baseUrl,
          thinking: false,
        }),
      }).target.baseURL;
    } catch {
      throw new SettingsValidationError(
        'Enter an HTTP(S) URL on this machine (localhost, 127.0.0.1 or [::1]) without credentials, query, or fragment.',
      );
    }
    try {
      const response = await fetch(`${baseURL}/models`, {
        headers: { authorization: `Bearer ${key || 'local'}` },
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      });
      if (!response.ok) throw new Error('Model listing failed');
      const body = z
        .object({ data: z.array(z.object({ id: z.string().min(1).max(250) })).max(1000) })
        .parse(await response.json());
      return [...new Set(body.data.map((m) => m.id))]
        .filter((id) => {
          try {
            parseBackendSpec(`local/${id}`);
            return true;
          } catch {
            return false;
          }
        })
        .map((id) => ({ id, label: id }));
    } catch {
      throw new SettingsValidationError(
        'Could not load local models. Check the server URL and API key, start the server, then refresh models.',
      );
    }
  };
  const save = async (input: z.infer<typeof settingsSchema>) => {
    const value = settingsSchema.parse(input);
    const next: Saved = { ...value, apiKey: value.apiKey ?? saved.apiKey };
    let spec: string;
    try {
      spec = formatBackendSpec(createConfig(environment(next)).llm);
      createBackend(spec, { env: environment(next) });
    } catch {
      throw new SettingsValidationError(
        'Enter a valid model ID and an HTTP(S) endpoint on this machine (localhost, 127.0.0.1 or [::1]) without credentials, query, or fragment.',
      );
    }
    const models = await localModels({ baseUrl: next.baseUrl, apiKey: next.apiKey });
    if (!models.some((m) => m.id === next.model))
      throw new SettingsValidationError(
        'Choose a model available on the local server. Refresh models and try again.',
      );
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
    saved = next;
    services = undefined;
    return { ...read(), spec };
  };
  return {
    read,
    save,
    localModels,
    defaultBackend,
    status,
    resolve: async (spec: string) => {
      parseBackendSpec(spec);
      if (spec !== configuredSpec())
        throw new SettingsValidationError('Configure this model in Settings first.');
      return service().resolve(spec);
    },
  };
}
export type ModelSettings = ReturnType<typeof modelSettings>;
