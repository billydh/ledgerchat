/**
 * The seam between a file format and the rest of the app. `pipeline.ts` is the
 * only consumer; nothing downstream imports from a parser. Adding a format
 * means a new module implementing this interface, nothing else.
 */

import type {
  NormalisedAccount,
  NormalisedBalance,
  NormalisedTransaction,
  SourceId,
} from './normalise.js';

export interface DataSource {
  readonly id: SourceId;
  listAccounts(): Promise<NormalisedAccount[]>;
  /**
   * Yields pages in source order. One page is one upsert batch. A file is
   * always processed whole; there is no incremental window, because the upsert
   * on `(source, external_id)` makes re-importing an overlapping export safe.
   */
  fetchTransactions(): AsyncIterable<NormalisedTransaction[]>;
  /**
   * Optional: not every source carries balances (a CSV export usually does
   * not), and the pipeline stores nothing rather than forcing one to invent them.
   */
  listBalances?(opts: ListBalancesOptions): Promise<NormalisedBalance[]>;
}

export interface ListBalancesOptions {
  /**
   * Observation time to stamp on a balance whose payload carries none, as an
   * ISO-8601 UTC timestamp. The pipeline passes the import's start time.
   */
  observedAt: string;
}

/** One record that could not be mapped. Skipped, never silently dropped. */
export interface MappingSkip {
  /** The source's id for the record, or a description of why one could not be read. */
  externalId: string;
  reason: string;
}

/**
 * Implemented by sources that tolerate unmappable records. A single bad row
 * must not abort an import, so the pipeline reads the count off the source
 * once the stream is drained and reports it.
 */
export interface SkipReporting {
  readonly skipped: number;
  readonly skips: readonly MappingSkip[];
}

export function isSkipReporting(source: DataSource): source is DataSource & SkipReporting {
  return typeof (source as Partial<SkipReporting>).skipped === 'number';
}
