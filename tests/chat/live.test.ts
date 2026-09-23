import { expect, it } from 'vitest';
import { createBackend } from '../../src/llm/backend.js';
import { probeCapabilities } from '../../src/llm/capabilities.js';
import { toolDefs } from '../../src/tools/registry.js';
import { systemPrompt } from '../../src/chat/prompt.js';
// Opt-in prevents accidental network use or financial-data disclosure in normal CI.
const specs = (process.env.CHAT_LIVE_BACKENDS ?? '').split(',').filter(Boolean);
it.skipIf(!specs.length)(
  'configured live backends produce a valid single-tool call',
  async () => {
    for (const spec of specs) {
      const backend = createBackend(spec);
      const capabilities = await probeCapabilities(backend);
      const turn = await backend.complete({
        system: systemPrompt(),
        messages: [{ role: 'user', text: 'Show my latest five transactions.' }],
        tools: toolDefs(),
        maxTokens: 8192,
        signal: AbortSignal.timeout(60000),
      });
      expect(capabilities).toBeDefined();
      expect(turn.toolCalls.some((call) => call.name === 'search_transactions')).toBe(true);
      const { registry } = await import('../../src/tools/registry.js');
      for (const call of turn.toolCalls)
        expect(
          registry.find((tool) => tool.name === call.name)?.schema.safeParse(call.rawInput).success,
        ).toBe(true);
    }
  },
  120000,
);
