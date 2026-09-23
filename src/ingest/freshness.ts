/**
 * How fresh the stored data is, read from `import_runs`. There is no provider
 * refresh time any more: a file is as fresh as the export it came from, so the
 * best the app can say is when each account was last imported into, and from
 * which file.
 */

import type { Db } from '../db/client.js';

export interface AccountImport {
  /** The `import_runs` row. */
  run_id: number;
  source: string;
  file_name: string;
  /** `finished_at` of the run, ISO-8601 UTC. */
  imported_at: string;
  rows_inserted: number;
  rows_updated: number;
  rows_skipped: number;
}

/**
 * The last successful import per account, keyed by internal account id. An
 * account with no successful import is absent, so the caller can tell "never
 * imported" from "imported, nothing new". Failed and running attempts never
 * count; a run whose file listed several accounts carries no account and is
 * not attributed to any of them.
 */
export function lastImportPerAccount(db: Db): Map<number, AccountImport> {
  const rows = db
    .prepare<[], AccountImport & { account_id: number }>(
      `SELECT r.account_id, r.id run_id, r.source, r.file_name,
              coalesce(r.finished_at, r.started_at) imported_at,
              r.rows_inserted, r.rows_updated, r.rows_skipped
       FROM import_runs r
       WHERE r.status = 'ok' AND r.account_id IS NOT NULL
         AND r.id = (
           SELECT max(id) FROM import_runs
           WHERE status = 'ok' AND account_id = r.account_id
         )
       ORDER BY r.account_id`,
    )
    .all();
  return new Map(rows.map(({ account_id, ...run }) => [account_id, run]));
}
