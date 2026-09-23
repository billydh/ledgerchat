import { createBackend, type LlmBackend } from '../llm/backend.js';
import { probeCapabilities } from '../llm/capabilities.js';
export interface BackendStatus {
  spec: string;
  configured: boolean;
  reachable: boolean | null;
  processing?: { destination: string };
}
/**
 * Where chat and categorisation run. `createBackend` only accepts loopback
 * endpoints, so the origin names the configured loopback server.
 * Expose the origin, never URL credentials, paths, query strings or API keys.
 */
export function processingLocation(baseURL: string): NonNullable<BackendStatus['processing']> {
  return { destination: new URL(baseURL).origin };
}
export function configuredSpecs(env = process.env): string[] {
  return env.LOCAL_LLM_MODEL?.trim() ? [`local/${env.LOCAL_LLM_MODEL.trim()}`] : [];
}
export function backendServices(env = process.env) {
  const cache = new Map<string, Promise<LlmBackend>>();
  let statusCache: Promise<BackendStatus[]> | undefined;
  let expires = 0;
  const resolve = async (spec: string) => {
    const configured = createBackend(spec, { env });
    let pending = cache.get(spec);
    if (!pending) {
      pending = probeCapabilities(configured).then((capabilities) => ({
        ...configured,
        capabilities,
      }));
      cache.set(spec, pending);
      pending.catch(() => cache.delete(spec));
    }
    return pending;
  };
  const status = (): Promise<BackendStatus[]> => {
    if (statusCache && Date.now() < expires) return statusCache;
    expires = Date.now() + 15000;
    statusCache = Promise.all(
      configuredSpecs(env).map(async (spec) => {
        let processing: BackendStatus['processing'];
        try {
          const backend = createBackend(spec, { env });
          processing = processingLocation(backend.target.baseURL);
          // Model listing is cheap and generates no tokens.
          const response = await fetch(`${backend.target.baseURL}/models`, {
            headers: { authorization: `Bearer ${env.LOCAL_LLM_API_KEY ?? 'local'}` },
            signal: AbortSignal.timeout(1500),
            redirect: 'error',
          });
          const body: unknown = await response.json();
          const data =
            typeof body === 'object' && body !== null && 'data' in body ? body.data : undefined;
          const reachable =
            response.ok &&
            Array.isArray(data) &&
            data.some(
              (model: unknown) =>
                typeof model === 'object' &&
                model !== null &&
                'id' in model &&
                model.id === backend.target.model,
            );
          return { spec, configured: true, reachable, processing };
        } catch {
          return {
            spec,
            configured: false,
            reachable: false,
            ...(processing ? { processing } : {}),
          };
        }
      }),
    );
    return statusCache;
  };
  return { resolve, status };
}
