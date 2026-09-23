/**
 * pnpm seed [--force] [--no-categorise] [--backend <spec>]
 *
 * Loads the committed synthetic dataset through `loadSampleData`: creates the
 * three sample accounts, imports the three CSVs through the same pipeline as
 * any other file, then categorises with the configured backend. Refuses to
 * touch a database that already holds accounts or transactions unless
 * `--force` is given, which deletes them (and their balances, corrections and
 * import runs) first.
 */

import { config } from '../config.js';
import { openDb } from '../db/client.js';
import { clearLedger, ledgerCounts, loadSampleData } from '../ingest/sample.js';
import { createBackend, formatBackendSpec, type LlmBackend } from '../llm/backend.js';
import { probeCapabilities } from '../llm/capabilities.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let force = false;
  let label = true;
  let spec: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--force') force = true;
    else if (arg === '--no-categorise') label = false;
    else if (arg === '--backend' && args[i + 1] && !args[i + 1]!.startsWith('--')) spec = args[++i];
    else throw new Error('Usage: pnpm seed [--force] [--no-categorise] [--backend <spec>]');
  }
  const db = openDb();
  try {
    const counts = ledgerCounts(db);
    if (counts.accounts || counts.transactions) {
      if (!force)
        throw new Error(
          `The database at ${config.db.path} already holds ${String(counts.accounts)} accounts and ${String(counts.transactions)} transactions. Pass --force to replace them.`,
        );
      clearLedger(db);
      console.log('Cleared existing accounts, transactions, balances and import runs.');
    }
    let backend: LlmBackend | undefined;
    if (label) {
      let backendSpec: string | undefined;
      try {
        backendSpec = spec ?? formatBackendSpec(config.llm);
      } catch {
        console.log(
          'No model configured; run pnpm categorise once LOCAL_LLM_MODEL is set in .env.',
        );
      }
      if (backendSpec) {
        const configured = createBackend(backendSpec);
        backend = { ...configured, capabilities: await probeCapabilities(configured) };
      }
    }
    const result = await loadSampleData(db, {
      ...(backend ? { backend } : {}),
      onProgress: (p) => {
        if (p.stage === 'import')
          console.log(
            `${p.account}: ${String(p.inserted)} rows from ${p.file}${p.skipped ? ` (${String(p.skipped)} skipped)` : ''}`,
          );
        else console.log(`categorised ${String(p.categorised)}/${String(p.total)} descriptions`);
      },
    });
    if (!label) {
      console.log('Skipped categorisation; run pnpm categorise when a model is configured.');
      return;
    }
    if (!result.categorise) return;
    console.log(
      `labelled ${String(result.categorise.categorisedDescriptions)} descriptions with ${result.categorise.backend}; ${String(result.categorise.failures.length)} failed batches; transfers ${JSON.stringify(result.transfers)}`,
    );
    if (result.categorise.failures.length) {
      console.log('Run pnpm categorise to resume the failed batches.');
      process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
