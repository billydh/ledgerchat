import type { BackendTarget, LlmBackend } from './backend.js';
import type { Capabilities, CompleteRequest, Turn } from './types.js';

export const CONSERVATIVE_CAPABILITIES: Readonly<Capabilities> = Object.freeze({
  streaming: false,
  strictTools: false,
  nativeStructuredOutput: false,
  thinking: false,
  promptCaching: false,
  forcedToolChoice: false,
});

/**
 * What a local OpenAI-compatible server is assumed to support until a probe
 * says otherwise. Native structured output was unreliable on the servers this
 * was set up against, so the categoriser asks for a forced `submit` tool call
 * by default; `LOCAL_LLM_PROBE=true` tests the endpoint once per process and
 * uses what it finds.
 */
const local = Object.freeze({
  streaming: true,
  strictTools: false,
  nativeStructuredOutput: false,
  thinking: false,
  promptCaching: false,
  forcedToolChoice: true,
});

export function getCapabilities(thinking = false): Readonly<Capabilities> {
  return Object.freeze({ ...local, thinking });
}

const probes = new Map<string, Promise<Readonly<Capabilities>>>();
const schema = {
  type: 'object',
  properties: { ok: { type: 'boolean', const: true } },
  required: ['ok'],
  additionalProperties: false,
};
function valid(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.keys(value).length === 1 &&
    'ok' in value &&
    value.ok === true
  );
}

/** One startup probe per endpoint/model per process, including failures. */
export function probeCapabilities(
  backend: LlmBackend & { target: Readonly<BackendTarget>; probe?: boolean },
): Promise<Readonly<Capabilities>> {
  const { target } = backend;
  if (!backend.probe) return Promise.resolve(backend.capabilities);
  const key = JSON.stringify([target.baseURL, target.model]);
  let pending = probes.get(key);
  if (!pending) {
    pending = runProbe(backend);
    probes.set(key, pending);
  }
  return pending;
}

async function runProbe(backend: LlmBackend): Promise<Readonly<Capabilities>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Capability probe timed out'));
    }, 5000);
  });
  const complete = (request: CompleteRequest): Promise<Turn> =>
    Promise.race([
      Promise.resolve().then(() => backend.complete({ ...request, signal: controller.signal })),
      timeout,
    ]);
  const request: CompleteRequest = {
    system: 'This is a capability test. Follow the requested output exactly.',
    messages: [{ role: 'user', text: 'Call submit with {"ok":true}.' }],
    tools: [
      { name: 'submit', description: 'Submit the capability test result.', jsonSchema: schema },
    ],
    toolChoice: { name: 'submit' },
    maxTokens: 64,
  };
  try {
    const tools = await complete(request);
    const tool = tools.toolCalls[0];
    if (
      tools.stopReason !== 'tool_calls' ||
      tools.toolCalls.length !== 1 ||
      tool?.name !== 'submit' ||
      !valid(tool.rawInput)
    )
      return CONSERVATIVE_CAPABILITIES;
    // A tool argument is not evidence of native JSON output. Test it separately.
    const output = await complete({
      system: request.system,
      messages: [{ role: 'user', text: 'Return {"ok":true} as JSON.' }],
      tools: [],
      maxTokens: 64,
      responseFormat: { name: 'probe', jsonSchema: schema },
    });
    if (
      output.stopReason !== 'end' ||
      output.toolCalls.length ||
      !valid(JSON.parse(output.text) as unknown)
    )
      return CONSERVATIVE_CAPABILITIES;
    return Object.freeze({
      ...backend.capabilities,
      forcedToolChoice: true,
      nativeStructuredOutput: true,
    });
  } catch {
    return CONSERVATIVE_CAPABILITIES;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
