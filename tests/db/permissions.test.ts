/**
 * The ledger is financial data: the data directory and the database, with
 * its WAL sidecars, must be readable by the owner alone whatever the umask.
 */
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createConfig } from '../../src/config.js';
import { openDb } from '../../src/db/client.js';

const mode = (path: string) => (statSync(path).mode & 0o777).toString(8);
let root: string, umask: number;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ledgerchat-perm-'));
  umask = process.umask(0o022);
});
afterEach(() => {
  process.umask(umask);
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('database permissions', () => {
  it('creates the data directory owner-only', () => {
    const path = join(root, 'data', 'nested', 'ledgerchat.db');
    expect(createConfig({ DB_PATH: path }).db.path).toBe(path);
    expect(mode(join(root, 'data'))).toBe('700');
    expect(mode(join(root, 'data', 'nested'))).toBe('700');
  });

  it('creates the database and its WAL sidecars owner-only', () => {
    const path = join(root, 'ledgerchat.db');
    const db = openDb(path);
    db.prepare("INSERT INTO schema_migrations (name) VALUES ('probe')").run();
    for (const suffix of ['', '-wal', '-shm']) expect(mode(path + suffix), suffix).toBe('600');
    db.close();
  });

  it('tightens a database and leftover sidecars from an earlier release', () => {
    const path = join(root, 'ledgerchat.db');
    openDb(path).close();
    chmodSync(path, 0o644);
    writeFileSync(path + '-shm', '', { mode: 0o644 });
    const db = openDb(path);
    for (const suffix of ['', '-wal', '-shm']) expect(mode(path + suffix), suffix).toBe('600');
    db.close();
  });
});
