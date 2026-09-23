// The files `tsc` does not emit but the server reads at runtime, copied into
// `dist/` at the same relative paths so every `import.meta.url` lookup
// resolves unchanged: the page and its scripts, the migrations and the
// sample dataset.
/* global console */
import { cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist');

const directories = ['src/server/public', 'src/db/migrations', 'samples'];
for (const dir of directories) cpSync(join(root, dir), join(out, dir), { recursive: true });

console.log(`copied ${directories.join(', ')} into dist/`);
