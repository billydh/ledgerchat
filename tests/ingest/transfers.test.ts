import { beforeEach, describe, expect, it } from 'vitest';
import { openMemoryDb } from '../../src/db/client.js';
import type { Db } from '../../src/db/client.js';
import {
  upsertAccount,
  upsertDescriptionCategories,
  upsertTransactions,
  type TransactionRow,
} from '../../src/db/repo.js';
import { matchInternalTransfers } from '../../src/ingest/transfers.js';
import { setTransferDecision } from '../../src/ingest/corrections.js';

const SOURCE = 'csv';

interface TxSpec {
  id: string;
  account: string;
  postedAt: string;
  amountCents: number;
  currency?: string;
  description?: string;
}

let db: Db;

beforeEach(() => {
  db = openMemoryDb();
  for (const external of ['everyday', 'savings', 'offset']) {
    upsertAccount(db, {
      source: SOURCE,
      externalId: external,
      name: external,
      currency: 'AUD',
      raw: {},
    });
  }
  upsertDescriptionCategories(db, [
    { descriptionNorm: 'transfer to savings', subcategory: 'savings', transferHint: true },
  ]);
});

/** Inserts in argument order, so transaction ids follow the order given. */
function seed(...specs: TxSpec[]): void {
  upsertTransactions(
    db,
    specs.map((spec) => ({
      source: SOURCE,
      externalId: spec.id,
      accountExternalId: spec.account,
      postedAt: spec.postedAt,
      amountCents: spec.amountCents,
      currency: spec.currency ?? 'AUD',
      descriptionRaw: spec.description ?? 'TRANSFER TO SAVINGS',
      descriptionNorm: spec.description ?? 'transfer to savings',
      status: 'posted' as const,
      raw: {},
    })),
  );
}

function get(externalId: string): TransactionRow {
  const row = db
    .prepare<[string], TransactionRow>('SELECT * FROM transactions WHERE external_id = ?')
    .get(externalId);
  if (!row) throw new Error(`no transaction ${externalId}`);
  return row;
}

/** The enrichment columns, which are all these passes may touch. */
function flags(externalId: string) {
  const row = get(externalId);
  return {
    is_internal_transfer: row.is_internal_transfer,
    transfer_source: row.transfer_source,
    transfer_pair_id: row.transfer_pair_id,
  };
}

function unflagged() {
  return { is_internal_transfer: 0, transfer_source: null, transfer_pair_id: null };
}

function hint(descriptionNorm: string): void {
  upsertDescriptionCategories(db, [{ descriptionNorm, subcategory: 'other', transferHint: true }]);
}

describe('pair pass', () => {
  it('pairs opposite amounts across two accounts and links them by a shared id', () => {
    seed(
      {
        id: 'out',
        account: 'everyday',
        postedAt: '2026-09-10T09:00:00.000Z',
        amountCents: -50_000,
      },
      { id: 'in', account: 'savings', postedAt: '2026-09-10T22:00:00.000Z', amountCents: 50_000 },
    );

    expect(matchInternalTransfers(db)).toEqual({ pairsCreated: 1, heuristicFlagged: 0 });

    const out = flags('out');
    expect(out).toEqual({
      is_internal_transfer: 1,
      transfer_source: 'pair',
      transfer_pair_id: get('out').id,
    });
    expect(flags('in')).toEqual(out);
  });

  it('does not pair opposite amounts within the same account', () => {
    seed(
      {
        id: 'refunded',
        account: 'everyday',
        postedAt: '2026-09-10T09:00:00.000Z',
        amountCents: -7_500,
      },
      {
        id: 'refund',
        account: 'everyday',
        postedAt: '2026-09-11T09:00:00.000Z',
        amountCents: 7_500,
      },
    );

    expect(matchInternalTransfers(db)).toEqual({ pairsCreated: 0, heuristicFlagged: 0 });
    expect(flags('refunded')).toEqual(unflagged());
    expect(flags('refund')).toEqual(unflagged());
  });

  it('pairs across a three-day gap', () => {
    seed(
      {
        id: 'out',
        account: 'everyday',
        postedAt: '2026-09-10T08:30:00.000Z',
        amountCents: -20_000,
      },
      { id: 'in', account: 'savings', postedAt: '2026-09-13T08:30:00.000Z', amountCents: 20_000 },
    );

    expect(matchInternalTransfers(db).pairsCreated).toBe(1);
    expect(flags('in').transfer_source).toBe('pair');
  });

  it('does not pair across a four-day gap', () => {
    seed(
      {
        id: 'out',
        account: 'everyday',
        postedAt: '2026-09-10T08:30:00.000Z',
        amountCents: -20_000,
      },
      { id: 'in', account: 'savings', postedAt: '2026-09-14T08:30:00.000Z', amountCents: 20_000 },
    );

    expect(matchInternalTransfers(db).pairsCreated).toBe(0);
    expect(flags('out')).toEqual(unflagged());
    expect(flags('in')).toEqual(unflagged());
  });

  it('leaves multiple candidates visible even when one is closer', () => {
    seed(
      {
        id: 'out',
        account: 'everyday',
        postedAt: '2026-09-10T00:00:00.000Z',
        amountCents: -30_000,
      },
      { id: 'far', account: 'savings', postedAt: '2026-09-13T00:00:00.000Z', amountCents: 30_000 },
      { id: 'near', account: 'offset', postedAt: '2026-09-11T00:00:00.000Z', amountCents: 30_000 },
    );

    expect(matchInternalTransfers(db).pairsCreated).toBe(0);
    expect(flags('out')).toEqual(unflagged());
    expect(flags('near')).toEqual(unflagged());
    expect(flags('far')).toEqual(unflagged());
  });

  it('leaves an exact date tie visible for review', () => {
    seed(
      {
        id: 'out',
        account: 'everyday',
        postedAt: '2026-09-10T00:00:00.000Z',
        amountCents: -30_000,
      },
      {
        id: 'first',
        account: 'savings',
        postedAt: '2026-09-11T00:00:00.000Z',
        amountCents: 30_000,
      },
      {
        id: 'second',
        account: 'offset',
        postedAt: '2026-09-11T00:00:00.000Z',
        amountCents: 30_000,
      },
    );

    expect(matchInternalTransfers(db).pairsCreated).toBe(0);
    expect(flags('out')).toEqual(unflagged());
    expect(flags('first')).toEqual(unflagged());
    expect(flags('second')).toEqual(unflagged());
  });

  it('does not pair equal magnitudes in different currencies', () => {
    seed(
      {
        id: 'out',
        account: 'everyday',
        postedAt: '2026-09-10T00:00:00.000Z',
        amountCents: -10_000,
      },
      {
        id: 'in',
        account: 'savings',
        postedAt: '2026-09-10T00:00:00.000Z',
        amountCents: 10_000,
        currency: 'USD',
      },
    );

    expect(matchInternalTransfers(db).pairsCreated).toBe(0);
    expect(flags('out')).toEqual(unflagged());
  });

  it('does not pair zero-amount rows with each other', () => {
    seed(
      { id: 'zero-a', account: 'everyday', postedAt: '2026-09-10T00:00:00.000Z', amountCents: 0 },
      { id: 'zero-b', account: 'savings', postedAt: '2026-09-10T00:00:00.000Z', amountCents: 0 },
    );

    expect(matchInternalTransfers(db).pairsCreated).toBe(0);
    expect(flags('zero-a')).toEqual(unflagged());
    expect(flags('zero-b')).toEqual(unflagged());
  });
});

describe('conservative matching', () => {
  it('does not pair an unrelated payment and refund with matching amounts', () => {
    seed(
      {
        id: 'rent',
        account: 'everyday',
        postedAt: '2026-09-10T00:00:00.000Z',
        amountCents: -10_000,
        description: 'rent',
      },
      {
        id: 'refund',
        account: 'savings',
        postedAt: '2026-09-11T00:00:00.000Z',
        amountCents: 10_000,
        description: 'merchant refund',
      },
    );
    expect(matchInternalTransfers(db).pairsCreated).toBe(0);
    expect(flags('rent')).toEqual(unflagged());
    expect(flags('refund')).toEqual(unflagged());
  });

  it('requires both descriptions to be transfer-like', () => {
    seed(
      {
        id: 'out',
        account: 'everyday',
        postedAt: '2026-09-10T00:00:00.000Z',
        amountCents: -10_000,
      },
      {
        id: 'refund',
        account: 'savings',
        postedAt: '2026-09-11T00:00:00.000Z',
        amountCents: 10_000,
        description: 'merchant refund',
      },
    );
    expect(matchInternalTransfers(db).pairsCreated).toBe(0);
    expect(flags('out')).toEqual(unflagged());
  });

  it('does not hide a hinted row that has no counterpart', () => {
    seed({
      id: 'lonely',
      account: 'everyday',
      postedAt: '2026-09-10T00:00:00.000Z',
      amountCents: -40_000,
      description: 'transfer to external',
    });
    hint('transfer to external');

    expect(matchInternalTransfers(db)).toEqual({ pairsCreated: 0, heuristicFlagged: 0 });
    expect(flags('lonely')).toEqual(unflagged());
  });

  it('leaves an unhinted unpaired row alone', () => {
    seed({
      id: 'groceries',
      account: 'everyday',
      postedAt: '2026-09-10T00:00:00.000Z',
      amountCents: -8_250,
      description: 'woolworths',
    });

    expect(matchInternalTransfers(db).heuristicFlagged).toBe(0);
    expect(flags('groceries')).toEqual(unflagged());
  });

  it('prefers the pair pass when a hinted row also has a counterpart', () => {
    seed(
      {
        id: 'out',
        account: 'everyday',
        postedAt: '2026-09-10T00:00:00.000Z',
        amountCents: -60_000,
        description: 'transfer to savings',
      },
      {
        id: 'in',
        account: 'savings',
        postedAt: '2026-09-10T00:00:00.000Z',
        amountCents: 60_000,
        description: 'transfer to savings',
      },
    );
    hint('transfer to savings');

    expect(matchInternalTransfers(db)).toEqual({ pairsCreated: 1, heuristicFlagged: 0 });
    expect(flags('out').transfer_source).toBe('pair');
    expect(flags('in').transfer_source).toBe('pair');
  });
});

describe('manual transfer decisions', () => {
  it('corrects both legs of an automatic pair and preserves the decision on re-import', () => {
    seed(
      {
        id: 'out',
        account: 'everyday',
        postedAt: '2026-09-10T00:00:00.000Z',
        amountCents: -50_000,
      },
      { id: 'in', account: 'savings', postedAt: '2026-09-11T00:00:00.000Z', amountCents: 50_000 },
    );
    expect(matchInternalTransfers(db).pairsCreated).toBe(1);
    expect(setTransferDecision(db, get('out').id, false).affected_ids).toEqual([
      get('out').id,
      get('in').id,
    ]);
    expect(flags('out').is_internal_transfer).toBe(0);
    expect(flags('in').is_internal_transfer).toBe(0);
    expect(get('out').transfer_override).toBe(0);
    expect(get('in').transfer_override).toBe(0);
    seed({
      id: 'out',
      account: 'everyday',
      postedAt: '2026-09-10T00:00:00.000Z',
      amountCents: -50_000,
    });
    expect(matchInternalTransfers(db).pairsCreated).toBe(0);
    expect(flags('out').is_internal_transfer).toBe(0);
    expect(flags('in').is_internal_transfer).toBe(0);
  });

  it('lets a user mark an unpaired transfer and keeps it out of matching', () => {
    seed({
      id: 'out',
      account: 'everyday',
      postedAt: '2026-09-10T00:00:00.000Z',
      amountCents: -25_000,
    });
    expect(setTransferDecision(db, get('out').id, true).label.is_internal_transfer).toBe(true);
    expect(get('out').transfer_override).toBe(1);
    expect(matchInternalTransfers(db).pairsCreated).toBe(0);
  });
});

describe('idempotence', () => {
  it('changes nothing on a re-run', () => {
    seed(
      {
        id: 'out',
        account: 'everyday',
        postedAt: '2026-09-10T00:00:00.000Z',
        amountCents: -50_000,
      },
      { id: 'in', account: 'savings', postedAt: '2026-09-11T00:00:00.000Z', amountCents: 50_000 },
      {
        id: 'lonely',
        account: 'offset',
        postedAt: '2026-09-12T00:00:00.000Z',
        amountCents: -1_500,
        description: 'transfer to external',
      },
    );
    hint('transfer to external');

    expect(matchInternalTransfers(db)).toEqual({ pairsCreated: 1, heuristicFlagged: 0 });
    const after = ['out', 'in', 'lonely'].map(flags);

    expect(matchInternalTransfers(db)).toEqual({ pairsCreated: 0, heuristicFlagged: 0 });
    expect(['out', 'in', 'lonely'].map(flags)).toEqual(after);
  });

  it('removes an automatic pair when a second candidate arrives', () => {
    seed(
      {
        id: 'out',
        account: 'everyday',
        postedAt: '2026-09-10T00:00:00.000Z',
        amountCents: -30_000,
      },
      { id: 'in', account: 'savings', postedAt: '2026-09-12T00:00:00.000Z', amountCents: 30_000 },
    );
    expect(matchInternalTransfers(db).pairsCreated).toBe(1);
    seed({
      id: 'nearer',
      account: 'offset',
      postedAt: '2026-09-10T00:00:00.000Z',
      amountCents: 30_000,
    });

    expect(matchInternalTransfers(db).pairsCreated).toBe(0);
    expect(flags('out')).toEqual(unflagged());
    expect(flags('nearer')).toEqual(unflagged());
    expect(flags('in')).toEqual(unflagged());
  });

  it('removes an automatic match when a re-import changes its amount', () => {
    seed(
      {
        id: 'out',
        account: 'everyday',
        postedAt: '2026-09-10T00:00:00.000Z',
        amountCents: -30_000,
      },
      { id: 'in', account: 'savings', postedAt: '2026-09-11T00:00:00.000Z', amountCents: 30_000 },
    );
    expect(matchInternalTransfers(db).pairsCreated).toBe(1);
    seed({
      id: 'in',
      account: 'savings',
      postedAt: '2026-09-11T00:00:00.000Z',
      amountCents: 31_000,
    });
    expect(matchInternalTransfers(db).pairsCreated).toBe(0);
    expect(flags('out')).toEqual(unflagged());
    expect(flags('in')).toEqual(unflagged());
  });

  it('pairs two hinted legs when the counterpart arrives later', () => {
    seed({
      id: 'out',
      account: 'everyday',
      postedAt: '2026-09-10T00:00:00.000Z',
      amountCents: -25_000,
      description: 'transfer to savings',
    });
    hint('transfer to savings');

    expect(matchInternalTransfers(db)).toEqual({ pairsCreated: 0, heuristicFlagged: 0 });
    expect(flags('out')).toEqual(unflagged());

    seed({
      id: 'in',
      account: 'savings',
      postedAt: '2026-09-11T00:00:00.000Z',
      amountCents: 25_000,
      description: 'transfer from everyday',
    });
    hint('transfer from everyday');

    expect(matchInternalTransfers(db).pairsCreated).toBe(1);
    expect(flags('out')).toEqual({
      is_internal_transfer: 1,
      transfer_source: 'pair',
      transfer_pair_id: get('out').id,
    });
    expect(flags('in').transfer_pair_id).toBe(get('out').id);
  });
});
