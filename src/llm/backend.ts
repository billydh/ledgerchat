import { createOpenAIChat } from './protocols/openai-chat.js';
import { createConfig } from '../config.js';
import { isLoopbackHost } from '../loopback.js';
import { getCapabilities } from './capabilities.js';
import type { Capabilities, CompleteRequest, Turn } from './types.js';

export interface BackendSpec {
  model: string;
}

export interface LlmBackend {
  readonly label: string;
  readonly capabilities: Readonly<Capabilities>;
  /** Configured output cap; callers fall back to DEFAULT_MAX_TOKENS when absent. */
  readonly maxTokens?: number;
  complete(req: CompleteRequest): Promise<Turn>;
}

export interface BackendTarget {
  label: string;
  baseURL: string;
  model: string;
}

export interface AdapterOptions extends BackendTarget {
  apiKey: string;
  capabilities: Readonly<Capabilities>;
}

export type AdapterFactory = (options: AdapterOptions) => Pick<LlmBackend, 'complete'>;

export interface BackendOptions {
  /** Override the protocol factory for tests or custom transports. */
  adapter?: AdapterFactory;
  env?: Record<string, string | undefined>;
}

export interface ConfiguredBackend extends LlmBackend {
  readonly target: Readonly<BackendTarget>;
  readonly probe: boolean;
}

/**
 * A backend is named `local/<model id>` everywhere a user can see or save one:
 * the chat selector, saved conversations and the CLI's `--backend`.
 */
export function parseBackendSpec(spec: string): BackendSpec {
  // Preserve slash-containing model IDs, but reject empty/path-traversal segments.
  const match = /^local\/(\S+)$/.exec(spec);
  const model = match?.[1];
  if (!model || match[0] !== spec || model.split('/').some((s) => !s || s === '.' || s === '..')) {
    throw new Error(
      'Invalid backend spec. Expected local/<model>, with a non-empty model and no whitespace.',
    );
  }
  return { model };
}

export function formatBackendSpec(spec: BackendSpec): string {
  const label = `local/${spec.model}`;
  parseBackendSpec(label);
  return label;
}

/**
 * Resolves credentials/config without sending requests or probing the server.
 * The configured endpoint must use a loopback host, so ledgerchat does not
 * send model requests directly to another host.
 */
export function createBackend(spec: string, options: BackendOptions = {}): ConfiguredBackend {
  const parsed = parseBackendSpec(spec);
  const env = options.env ?? process.env;
  // The explicit spec selects the model even when the default env differs.
  const llm = createConfig({ ...env, LOCAL_LLM_MODEL: parsed.model }).llm;
  let baseURL = llm.baseUrl;
  const url = new URL(baseURL);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('LLM base URL must be HTTP(S), without credentials, query or fragment');
  }
  if (!isLoopbackHost(url.hostname)) {
    throw new Error('LLM base URL must be on this machine: localhost, 127.0.0.1 or [::1]');
  }
  baseURL = baseURL.replace(/\/+$/, '');
  if (!baseURL.endsWith('/v1')) baseURL += '/v1';
  const target = Object.freeze({ label: formatBackendSpec(parsed), baseURL, model: llm.model });
  const capabilities = getCapabilities(llm.thinking);
  const adapter = (options.adapter ?? createOpenAIChat)({
    ...target,
    apiKey: llm.apiKey,
    capabilities,
  });
  return {
    label: target.label,
    target,
    capabilities,
    maxTokens: llm.maxTokens,
    probe: llm.probe,
    complete: (req) => adapter.complete(req),
  };
}
