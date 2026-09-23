import { matchInternalTransfers } from '../ingest/transfers.js';
import { config } from '../config.js';
import { openDb } from '../db/client.js';
import { categorise } from '../ingest/categorise.js';
import { createBackend, formatBackendSpec } from '../llm/backend.js';
import { probeCapabilities } from '../llm/capabilities.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let spec: string | undefined;
  let recategorise = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--recategorise') recategorise = true;
    else if (arg === '--backend' && args[i + 1] && !args[i + 1]!.startsWith('--')) spec = args[++i];
    else throw new Error('Usage: pnpm categorise [--backend <spec>] [--recategorise]');
  }
  const configured = createBackend(spec ?? formatBackendSpec(config.llm));
  const capabilities = await probeCapabilities(configured);
  const backend = { ...configured, capabilities };
  const db = openDb();
  try {
    const result = await categorise(db, backend, { recategorise });
    const transfers = matchInternalTransfers(db);
    console.log(`transfers: ${JSON.stringify(transfers)}`);
    console.log(`backend: ${result.backend}`);
    console.log(`new descriptions: ${String(result.newDescriptions)}`);
    console.log(`categorised: ${String(result.categorisedDescriptions)}`);
    console.log(`batches: ${String(result.batches)}`);
    console.log(`failures: ${String(result.failures.length)}`);
    console.log(`transactions updated: ${String(result.transactionsUpdated)}`);
    console.log(
      `structured output: ${JSON.stringify({ modes: result.modes, attempts: result.attempts, usage: result.usage })}`,
    );
    if (result.failures.length) process.exitCode = 1;
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
