import { describe, expect, it } from 'vitest';
import { openMemoryDb } from '../../src/db/client.js';
import {
  getImportRun,
  getLastSuccessfulImportRun,
  upsertTransactionOverride,
} from '../../src/db/repo.js';
import { runImport, describeImportCounts } from '../../src/ingest/pipeline.js';
import type {
  NormalisedAccount,
  NormalisedBalance,
  NormalisedTransaction,
} from '../../src/ingest/normalise.js';
import type { DataSource } from '../../src/ingest/source.js';

const ACCOUNT: NormalisedAccount = {
  source: 'csv',
  externalId: 'acc-1',
  name: 'Everyday',
  type: 'transaction',
  institution: 'Test Bank',
  currency: 'AUD',
  raw: { account_id: 'acc-1' },
};

function transaction(id: string, overrides: Partial<NormalisedTransaction> = {}) {
  return {
    source: 'csv',
    externalId: id,
    accountExternalId: 'acc-1',
    postedAt: '2026-09-10T00:00:00.000Z',
    amountCents: -1799,
    currency: 'AUD',
    descriptionRaw: 'Purchase from UBER* EATS SYDNEY NS, Card xx1560',
    status: 'posted',
    raw: { row: id },
    ...overrides,
  } satisfies NormalisedTransaction;
}

interface FakeOptions {
  accounts?: NormalisedAccount[];
  /** Given, the fake implements `listBalances`; each entry is stamped with the import's observedAt. */
  balances?: Omit<NormalisedBalance, 'asOf' | 'source'>[];
  pages?: NormalisedTransaction[][];
  failOnPage?: number;
  skipped?: number;
}

function fakeSource(options: FakeOptions = {}) {
  let fetches = 0;
  const source: DataSource & { skipped: number; skips: never[] } = {
    id: 'csv',
    skipped: options.skipped ?? 0,
    skips: [],
    listAccounts: () => Promise.resolve(options.accounts ?? [ACCOUNT]),
    ...(options.balances === undefined
      ? {}
      : {
          listBalances: ({ observedAt }: { observedAt: string }) =>
            Promise.resolve(
              options.balances!.map((b) => ({ ...b, source: 'csv' as const, asOf: observedAt })),
            ),
        }),
    // eslint-disable-next-line @typescript-eslint/require-await
    async *fetchTransactions() {
      fetches++;
      const pages = options.pages ?? [[transaction('tx-1'), transaction('tx-2')]];
      for (const [index, page] of pages.entries()) {
        if (options.failOnPage === index) throw new Error('upstream exploded');
        yield page;
      }
    },
  };
  return { source, fetches: () => fetches };
}

const FILE = { fileName: 'export.csv' };

function countRows(db: ReturnType<typeof openMemoryDb>, table: string): number {
  return db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;
}

describe('runImport', () => {
  it('upserts accounts and transactions and records the run against the account', async () => {
    const db = openMemoryDb();
    const { source } = fakeSource();

    const result = await runImport(db, source, FILE);

    expect(result.status).toBe('ok');
    expect(result.accountsSeen).toBe(1);
    expect(result).toMatchObject({ inserted: 2, updated: 0, skipped: 0 });
    expect(countRows(db, 'transactions')).toBe(2);
    expect(getImportRun(db, result.runId)).toMatchObject({
      source: 'csv',
      file_name: 'export.csv',
      account_id: 1,
      rows_inserted: 2,
      rows_updated: 0,
      rows_skipped: 0,
      status: 'ok',
      error: null,
    });
    expect(getLastSuccessfulImportRun(db, 1)?.id).toBe(result.runId);
  });

  it('leaves the run unattributed when a file lists several accounts', async () => {
    const db = openMemoryDb();
    const second = { ...ACCOUNT, externalId: 'acc-2', name: 'Savings' };
    const result = await runImport(db, fakeSource({ accounts: [ACCOUNT, second] }).source, FILE);
    expect(result.accountsSeen).toBe(2);
    expect(getImportRun(db, result.runId)?.account_id).toBeNull();
  });

  it('stores balances against listed accounts and reports the count', async () => {
    const db = openMemoryDb();
    const now = () => Date.parse('2026-09-11T05:00:00.000Z');
    const balance = { accountExternalId: 'acc-1', currentCents: 74777, currency: 'AUD', raw: {} };
    const orphan = { ...balance, accountExternalId: 'acc-gone' };
    const { source } = fakeSource({ balances: [balance, orphan] });

    const result = await runImport(db, source, { ...FILE, now });

    expect(result.status).toBe('ok');
    expect(result.balancesSeen).toBe(1);
    expect(result.skipped).toBe(1);
    expect(getImportRun(db, result.runId)?.rows_skipped).toBe(1);
    expect(
      db.prepare('SELECT as_of, current_cents, available_cents FROM account_balances').all(),
    ).toEqual([{ as_of: '2026-09-11T05:00:00.000Z', current_cents: 74777, available_cents: null }]);

    // Same observation time again: nothing new is inserted, nothing is updated.
    await runImport(db, fakeSource({ balances: [{ ...balance, currentCents: 1 }] }).source, {
      ...FILE,
      now,
    });
    expect(countRows(db, 'account_balances')).toBe(1);
    // A later import is a new observation.
    await runImport(db, fakeSource({ balances: [balance] }).source, {
      ...FILE,
      now: () => now() + 60_000,
    });
    expect(countRows(db, 'account_balances')).toBe(2);
  });

  it('stores no balances for a source without them', async () => {
    const db = openMemoryDb();
    const result = await runImport(db, fakeSource().source, FILE);
    expect(result.balancesSeen).toBe(0);
    expect(countRows(db, 'account_balances')).toBe(0);
  });

  it('stores the normalised description alongside the raw one', async () => {
    const db = openMemoryDb();
    await runImport(db, fakeSource({ pages: [[transaction('tx-1')]] }).source, FILE);

    const row = db
      .prepare<[], { description_norm: string }>('SELECT description_norm FROM transactions')
      .get()!;
    expect(row.description_norm).toBe('PURCHASE FROM UBER* EATS SYDNEY NS');
  });

  it('is idempotent: a re-import updates rather than duplicates, and says so', async () => {
    const db = openMemoryDb();
    await runImport(db, fakeSource().source, FILE);

    const updated = transaction('tx-1', { amountCents: -2000, status: 'pending' });
    const second = await runImport(
      db,
      fakeSource({ pages: [[updated, transaction('tx-2'), transaction('tx-3')]] }).source,
      FILE,
    );

    expect(second).toMatchObject({ inserted: 1, updated: 1, unchanged: 1, duplicates: 0 });
    expect(getImportRun(db, second.runId)).toMatchObject({
      rows_inserted: 1,
      rows_updated: 1,
      rows_unchanged: 1,
      rows_duplicate: 0,
    });
    expect(countRows(db, 'transactions')).toBe(3);
    expect(countRows(db, 'accounts')).toBe(1);
    const row = db
      .prepare<[string], { amount_cents: number; status: string }>(
        'SELECT amount_cents, status FROM transactions WHERE external_id = ?',
      )
      .get('tx-1')!;
    expect(row).toEqual({ amount_cents: -2000, status: 'pending' });
  });

  it('counts a no-op re-import as unchanged, a pending-to-posted row as one update, and in-file repeats as duplicates', async () => {
    const db = openMemoryDb();
    const pending = transaction('tx-1', { status: 'pending' });
    await runImport(db, fakeSource({ pages: [[pending, transaction('tx-2')]] }).source, FILE);
    // Enrichment the user owns must not count as a change and must survive.
    upsertTransactionOverride(
      db,
      db.prepare<[], { id: number }>("SELECT id FROM transactions WHERE external_id='tx-2'").get()!
        .id,
      'groceries',
    );
    const same = await runImport(
      db,
      fakeSource({ pages: [[pending, transaction('tx-2')]] }).source,
      FILE,
    );
    expect(same).toMatchObject({ inserted: 0, updated: 0, unchanged: 2, duplicates: 0 });
    const posted = await runImport(
      db,
      fakeSource({
        pages: [[transaction('tx-1', { status: 'posted' })], [transaction('tx-2')]],
      }).source,
      FILE,
    );
    expect(posted).toMatchObject({ inserted: 0, updated: 1, unchanged: 1 });
    // The same id twice in one file: written once, the repeat counted and never an update.
    const repeated = await runImport(
      db,
      fakeSource({
        pages: [[transaction('tx-3'), transaction('tx-3', { amountCents: -999 })]],
      }).source,
      FILE,
    );
    expect(repeated).toMatchObject({ inserted: 1, updated: 0, unchanged: 0, duplicates: 1 });
    expect(countRows(db, 'transactions')).toBe(3);
    expect(
      db.prepare('SELECT amount_cents, status, subcategory FROM transactions ORDER BY id').all(),
    ).toEqual([
      { amount_cents: -1799, status: 'posted', subcategory: null },
      { amount_cents: -1799, status: 'posted', subcategory: 'groceries' },
      { amount_cents: -1799, status: 'posted', subcategory: null },
    ]);
    expect(describeImportCounts(repeated)).toBe(
      '1 new, 0 updated, 0 unchanged, 1 duplicate in file, 0 skipped',
    );
    expect(
      describeImportCounts({
        inserted: 3,
        updated: 0,
        unchanged: null,
        duplicates: null,
        skipped: 0,
      }),
    ).toBe('3 new, 0 updated, unchanged not recorded, 0 skipped');
  });

  it('always processes the whole file: there is no incremental window', async () => {
    const db = openMemoryDb();
    const first = fakeSource();
    await runImport(db, first.source, FILE);
    const second = fakeSource();
    await runImport(db, second.source, FILE);
    expect(first.fetches()).toBe(1);
    expect(second.fetches()).toBe(1);
  });

  it('closes the run with an error when the source fails mid-import', async () => {
    const db = openMemoryDb();
    const { source } = fakeSource({
      pages: [[transaction('tx-1')], [transaction('tx-2')]],
      failOnPage: 1,
    });

    const result = await runImport(db, source, FILE);

    expect(result.status).toBe('error');
    expect(result.error).toBe('upstream exploded');
    // The first page is already committed; the run row says so.
    expect(countRows(db, 'transactions')).toBe(1);
    expect(getImportRun(db, result.runId)).toMatchObject({
      status: 'error',
      error: 'upstream exploded',
      rows_inserted: 1,
    });
    expect(getImportRun(db, result.runId)?.finished_at).not.toBeNull();
    expect(getLastSuccessfulImportRun(db)).toBeUndefined();
  });

  it('skips a transaction whose account the source never listed', async () => {
    const db = openMemoryDb();
    const { source } = fakeSource({
      pages: [[transaction('tx-1'), transaction('tx-orphan', { accountExternalId: 'acc-gone' })]],
    });

    const result = await runImport(db, source, FILE);

    expect(result.status).toBe('ok');
    expect(result.inserted).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it("adds the source's own skip count to the reported total", async () => {
    const db = openMemoryDb();
    const result = await runImport(db, fakeSource({ skipped: 3 }).source, FILE);
    expect(result.skipped).toBe(3);
  });
});

it('keeps an unpaired model transfer hint in ordinary transactions', async () => {
  const { getCapabilities } = await import('../../src/llm/capabilities.js');
  const db = openMemoryDb();
  try {
    const { source } = fakeSource({
      pages: [[transaction('hinted', { descriptionRaw: 'OWN SAVINGS' })]],
    });
    const backend = {
      label: 'local/test',
      capabilities: getCapabilities(),
      complete: () =>
        Promise.resolve({
          text: '',
          toolCalls: [
            {
              id: '1',
              name: 'submit',
              rawInput: {
                items: [
                  {
                    description: 'OWN SAVINGS',
                    subcategory: 'savings',
                    confidence: 0.9,
                    transfer_hint: true,
                    is_subscription: false,
                  },
                ],
              },
            },
          ],
          stopReason: 'tool_calls' as const,
          usage: { inputTokens: 1, outputTokens: 1 },
          latencyMs: 0,
        }),
    };
    expect((await runImport(db, source, { ...FILE, backend })).status).toBe('ok');
    // A model hint on one leg is not evidence of money moving between owned accounts.
    expect(
      db
        .prepare(
          'SELECT subcategory, is_subscription, is_internal_transfer, transfer_source FROM transactions',
        )
        .get(),
    ).toEqual({
      subcategory: 'savings',
      is_subscription: 0,
      is_internal_transfer: 0,
      transfer_source: null,
    });
  } finally {
    db.close();
  }
});

it('reports categorisation failures while keeping ingested transactions resumable', async () => {
  const { getCapabilities } = await import('../../src/llm/capabilities.js');
  const db = openMemoryDb();
  try {
    const { source } = fakeSource();
    const backend = {
      label: 'local/test',
      capabilities: getCapabilities(),
      complete: () => Promise.reject(new Error('Offline')),
    };
    expect(await runImport(db, source, { ...FILE, backend })).toMatchObject({
      status: 'error',
      inserted: 2,
      error: 'Categorisation failed for 1 batches; run pnpm categorise to resume',
    });
    expect(countRows(db, 'transactions')).toBe(2);
  } finally {
    db.close();
  }
});
