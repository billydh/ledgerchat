import Database from 'better-sqlite3';
import { chmodSync, closeSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { matchInternalTransfers } from '../ingest/transfers.js';

export type Db = Database.Database;

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/** SQLite's WAL sidecars, which live beside the database while it is open. */
const SIDECARS = ['-wal', '-shm'];

/**
 * Makes the database file owner-only. SQLite creates it with the umask, so
 * the file is created here first with an explicit mode; the chmod covers a
 * database from an earlier release. SQLite gives the WAL sidecars the mode
 * of the main file when it creates them, and leftover ones (an unclean stop
 * before an upgrade) are tightened to match.
 */
function ensurePrivate(path: string): void {
  closeSync(openSync(path, 'a', 0o600));
  chmodSync(path, 0o600);
  for (const suffix of SIDECARS) {
    try {
      chmodSync(path + suffix, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

/**
 * Opens the database, applies any unapplied migrations and returns the handle.
 *
 * Migrations are append-only once released: an applied file must never change.
 * Add a new numbered file instead of editing `001_init.sql`.
 */
export function openDb(path?: string): Db {
  const file = path ?? config.db.path;
  ensurePrivate(file);
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

/** In-memory database with the same schema, for tests. */
export function openMemoryDb(): Db {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

/**
 * Applies the unapplied `.sql` files in `dir` in name order, recording each in
 * `schema_migrations`.
 */
export function migrate(db: Db, dir: string = MIGRATIONS_DIR): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name        TEXT PRIMARY KEY,
    applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`);

  const applied = new Set(
    db
      .prepare<[], { name: string }>('SELECT name FROM schema_migrations')
      .all()
      .map((row) => row.name),
  );

  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const record = db.prepare<[string]>('INSERT INTO schema_migrations (name) VALUES (?)');

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      if (file === '003_transfer_override.sql') matchInternalTransfers(db);
      record.run(file);
    })();
  }
}
