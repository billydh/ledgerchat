import { describe, expect, it } from 'vitest';
import {
  normaliseDescription,
  normalisedAccountSchema,
  normalisedTransactionSchema,
} from '../../src/ingest/normalise.js';

describe('normaliseDescription', () => {
  it('strips masked and full card numbers', () => {
    expect(normaliseDescription('Purchase from UBER* EATS SYDNEY NS, Card xx1560')).toBe(
      'PURCHASE FROM UBER* EATS SYDNEY NS',
    );
    expect(normaliseDescription('EFTPOS 4111 1111 1111 1111 COLES')).toBe('EFTPOS COLES');
    expect(normaliseDescription('POS XXXX-XXXX-XXXX-4242 KMART')).toBe('POS KMART');
  });

  it('strips receipt and reference numbers, labelled or bare', () => {
    expect(normaliseDescription('CTRLINK PENSION  011P2475603410708A  Receipt 192610')).toBe(
      'CTRLINK PENSION',
    );
    expect(normaliseDescription('PAYMENT   TO SYNERGY RETAIL B  1403410709763')).toBe(
      'PAYMENT TO SYNERGY RETAIL B',
    );
    expect(normaliseDescription('Direct Credit 139852, AutoGrid Systems')).toBe(
      'DIRECT CREDIT, AUTOGRID SYSTEMS',
    );
  });

  it('keeps short numbers that are part of the merchant name', () => {
    expect(normaliseDescription('Pending WOOLWORTHS 3120 RICHMOND AUS, Card xx4943')).toBe(
      'PENDING WOOLWORTHS 3120 RICHMOND AUS',
    );
    expect(normaliseDescription('Pending 7-ELEVEN MELBOURNE AUS, Card xx3485')).toBe(
      'PENDING 7-ELEVEN MELBOURNE AUS',
    );
  });

  it('collapses whitespace and trims stranded separators', () => {
    expect(normaliseDescription('  MCDONALDS   950435   HAWTHORN AU AUS,  Card xx1148 ')).toBe(
      'MCDONALDS HAWTHORN AU AUS',
    );
  });

  it('collapses the per-transaction noise so one merchant is one key', () => {
    const keys = new Set(
      [
        'Transfer from xx1061 CommBank app, Uber Eats Income',
        'Transfer from xx9399 CommBank app, Uber Eats Income',
        'Transfer from xx2096 CommBank app, Uber Eats Income',
      ].map(normaliseDescription),
    );
    expect([...keys]).toEqual(['TRANSFER FROM COMMBANK APP, UBER EATS INCOME']);
  });

  it('is idempotent', () => {
    const inputs = [
      'Purchase from UBER* EATS SYDNEY NS, Card xx1560',
      'CTRLINK PENSION  011P2475603410708A  Receipt 192610',
      'Direct Credit 110825  CITIBANK EUROPE, Etsy Ireland Limited',
      'Payroll Credit DIT - Payroll D 162950796',
      '   ,,,  ',
      '',
    ];
    for (const input of inputs) {
      const once = normaliseDescription(input);
      expect(normaliseDescription(once)).toBe(once);
    }
  });
});

describe('normalised schemas', () => {
  const account = {
    source: 'csv',
    externalId: 'acc-1',
    name: 'Everyday',
    currency: 'AUD',
    raw: {},
  };
  const transaction = {
    source: 'csv',
    externalId: 'tx-1',
    accountExternalId: 'acc-1',
    postedAt: '2026-09-10T00:00:00.000Z',
    amountCents: -1799,
    currency: 'AUD',
    descriptionRaw: 'COLES',
    status: 'posted',
    raw: {},
  };

  it('accepts a well formed record', () => {
    expect(normalisedAccountSchema.parse(account).externalId).toBe('acc-1');
    expect(normalisedTransactionSchema.parse(transaction).amountCents).toBe(-1799);
  });

  it('rejects non-integer cents', () => {
    expect(
      normalisedTransactionSchema.safeParse({ ...transaction, amountCents: -17.99 }).success,
    ).toBe(false);
  });

  it('rejects naive and offset timestamps', () => {
    for (const postedAt of [
      '2026-09-10 00:00:00',
      '2026-09-10T00:00:00',
      '2026-09-10T00:00:00+10:00',
      '2026-09-10',
    ]) {
      expect(normalisedTransactionSchema.safeParse({ ...transaction, postedAt }).success).toBe(
        false,
      );
    }
  });

  it('rejects a currency that is not an ISO-4217 code', () => {
    expect(normalisedAccountSchema.safeParse({ ...account, currency: 'aud' }).success).toBe(false);
    expect(normalisedAccountSchema.safeParse({ ...account, currency: 'AUDD' }).success).toBe(false);
  });
});
