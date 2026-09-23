import { config } from '../config.js';
import { openDb } from '../db/client.js';
import { createBackend, formatBackendSpec } from '../llm/backend.js';
import { probeCapabilities } from '../llm/capabilities.js';
import { runConversation } from '../chat/orchestrator.js';
async function main() {
  const args = process.argv.slice(2);
  let spec: string | undefined;
  const question: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--backend' && args[i + 1]) spec = args[++i];
    else if (arg.startsWith('--'))
      throw new Error('Usage: pnpm chat "question" [--backend <spec>]');
    else question.push(arg);
  }
  if (!question.length) throw new Error('Usage: pnpm chat "question" [--backend <spec>]');
  const configured = createBackend(spec ?? formatBackendSpec(config.llm));
  const backend = { ...configured, capabilities: await probeCapabilities(configured) };
  const db = openDb(),
    controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  try {
    const result = await runConversation({
      backend,
      db,
      messages: [{ role: 'user', text: question.join(' ') }],
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === 'text') process.stdout.write(event.text);
        if (event.type === 'retry')
          process.stdout.write('\n[answer withheld: asking the model for verifiable data]\n');
        if (event.type === 'error') console.error(`\n${event.error}`);
      },
    });
    console.log();
    console.error(JSON.stringify(result.trace, null, 2));
    if (result.failed) process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', cancel);
    db.close();
  }
}
main().catch(() => {
  console.error('Chat could not start. Check configuration and command arguments.');
  process.exitCode = 1;
});
