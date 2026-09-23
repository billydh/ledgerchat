import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { readCsv } from '../../../src/ingest/files/csv.js';
import {
  applyOverrides,
  detectMapping,
  mapRows,
  MappingError,
} from '../../../src/ingest/files/detect.js';

const fixture = (name: string) =>
  readCsv(readFileSync(new URL(`../../../fixtures/files/${name}`, import.meta.url), 'utf8'));

describe('detectMapping', () => {
  it('maps a signed amount column with a header, a balance and no ambiguity', () => {
    const { mapping, confidence, ambiguousDate } = detectMapping(fixture('signed-header.csv'));
    expect(mapping).toEqual({
      date: 0,
      dateFormat: 'YYYY-MM-DD',
      amount: { kind: 'signed', column: 2 },
      sign: 'spend_negative',
      description: 1,
      balance: 3,
    });
    expect(ambiguousDate).toBe(false);
    expect(confidence.date).toBe(1);
    expect(confidence.amount).toBe(1);
    expect(confidence.balance).toBe(1);
    expect(confidence.sign).toBeGreaterThan(0.6);
  });

  it('pairs debit and credit columns by header and reads DD/MM from a day above 12', () => {
    const { mapping, confidence, ambiguousDate } = detectMapping(fixture('debit-credit.csv'));
    expect(mapping.amount).toEqual({ kind: 'split', debit: 2, credit: 3 });
    expect(mapping.dateFormat).toBe('DD/MM/YYYY');
    expect(ambiguousDate).toBe(false);
    expect(confidence.sign).toBe(1);
    expect(confidence.amount).toBeGreaterThanOrEqual(0.9);
  });

  it('pairs two numeric columns that are never both filled even without header hints', () => {
    const table = readCsv('2026-01-01,x,,5.00\n2026-01-02,y,-3.00,\n2026-01-03,z,-4.00,\n', {
      hasHeader: false,
    });
    const { mapping, confidence } = detectMapping(table);
    expect(mapping.amount).toEqual({ kind: 'split', debit: 2, credit: 3 });
    expect(confidence.amount).toBeLessThan(0.9);
  });

  it('copes with no header, dollar signs, thousands separators and parentheses', () => {
    const { mapping } = detectMapping(fixture('no-header-dmy.csv'));
    expect(mapping).toMatchObject({
      date: 0,
      dateFormat: 'DD/MM/YYYY',
      amount: { kind: 'signed', column: 1 },
      description: 2,
    });
  });

  it('reads a semicolon file with MM/DD dates and a decimal comma', () => {
    const { mapping } = detectMapping(fixture('semicolon-mdy.csv'));
    expect(mapping).toMatchObject({ date: 0, dateFormat: 'MM/DD/YYYY', description: 1 });
    expect(mapping.amount).toEqual({ kind: 'signed', column: 2 });
    const { rows } = mapRows(fixture('semicolon-mdy.csv'), mapping);
    expect(rows.map((r) => r.amountCents)).toEqual([-1299, -4000, -7245, 240000]);
  });

  it('defaults to DD/MM and flags the file when every date fits both', () => {
    const { mapping, ambiguousDate } = detectMapping(fixture('ambiguous.csv'));
    expect(mapping.dateFormat).toBe('DD/MM/YYYY');
    expect(ambiguousDate).toBe(true);
  });

  it('reads the sign convention from purchase-like rows and from header hints', () => {
    const positive = readCsv(
      'Date,Description,Amount\n2026-01-01,WOOLWORTHS,20.00\n2026-01-02,COLES,30.00\n2026-01-03,SALARY,-3000.00\n',
    );
    expect(detectMapping(positive).mapping.sign).toBe('spend_positive');
    const hinted = readCsv(
      'Date,Description,Spent\n2026-01-01,RENT,1200.00\n2026-01-02,FEE,5.00\n',
    );
    expect(detectMapping(hinted).mapping.sign).toBe('spend_positive');
  });

  it('appends a memo column and picks up a status column', () => {
    const table = readCsv(
      'Date,Description,Reference,Amount,Status\n2026-01-01,WOOLWORTHS,REF 123,-20.00,Posted\n2026-01-02,COLES,,-30.00,Pending\n',
    );
    const { mapping } = detectMapping(table);
    expect(mapping).toMatchObject({ description: 1, memo: 2, status: 4 });
    const { rows } = mapRows(table, mapping);
    expect(rows.map((r) => [r.description, r.pending])).toEqual([
      ['WOOLWORTHS | REF 123', false],
      ['COLES', true],
    ]);
  });

  it('refuses a file with no dates, no amounts or no text', () => {
    expect(() => detectMapping(readCsv('a,b\nx,y\n'))).toThrow(MappingError);
    expect(() => detectMapping(readCsv('Date,Amount\n2026-01-01,-1.00\n'))).toThrow('descriptions');
    expect(() => detectMapping(readCsv('Date,Description\n2026-01-01,x\n'))).toThrow('amounts');
    expect(() => detectMapping(readCsv('Date,Description,Amount\n', { hasHeader: true }))).toThrow(
      'no data rows',
    );
  });
});

describe('applyOverrides', () => {
  const table = fixture('ambiguous.csv');

  it('pins the date format, sign and columns and lifts their confidence', () => {
    const detected = detectMapping(table);
    const result = applyOverrides(
      detected,
      { dateFormat: 'MM/DD/YYYY', sign: 'spend_positive', description: 1 },
      table,
    );
    expect(result.mapping.dateFormat).toBe('MM/DD/YYYY');
    expect(result.mapping.sign).toBe('spend_positive');
    expect(result.ambiguousDate).toBe(false);
    expect(result.confidence).toMatchObject({ date: 1, sign: 1, description: 1 });
    expect(mapRows(table, result.mapping).rows[0]).toMatchObject({
      date: '2026-01-02',
      amountCents: 2000,
    });
  });

  it('rejects an out-of-range column, a half pair and colliding roles', () => {
    const detected = detectMapping(table);
    expect(() => applyOverrides(detected, { amount: 7 }, table)).toThrow('no column 8');
    expect(() => applyOverrides(detected, { debit: 2 }, table)).toThrow('together');
    expect(() => applyOverrides(detected, { description: 2 }, table)).toThrow('different');
  });

  it('can drop an optional role with null', () => {
    const signed = fixture('signed-header.csv');
    const result = applyOverrides(detectMapping(signed), { balance: null }, signed);
    expect(result.mapping.balance).toBeUndefined();
  });
});

describe('mapRows', () => {
  it('reports every bad row by line and keeps the good ones', () => {
    const table = readCsv(
      'Date,Description,Amount\n2026-01-01,OK,-1.00\nnot a date,BAD DATE,-1.00\n2026-01-03,BAD AMOUNT,abc\n2026-01-04,,-2.00\n',
    );
    const { rows, errors } = mapRows(table, detectMapping(table).mapping);
    expect(rows.map((r) => r.line)).toEqual([2]);
    expect(errors).toEqual([
      { line: 3, message: 'Date: "not a date" is not a YYYY-MM-DD date' },
      { line: 4, message: 'Amount: "abc" is not an amount' },
      { line: 5, message: 'Description: description is empty' },
    ]);
  });

  it('turns a debit/credit pair into one signed amount whichever way the debit is written', () => {
    const table = readCsv(
      'Date,Narrative,Debit,Credit\n2026-01-01,a,-5.00,\n2026-01-02,b,5.00,\n2026-01-03,c,,7.00\n2026-01-04,d,,\n',
    );
    const { rows, errors } = mapRows(table, detectMapping(table).mapping);
    expect(rows.map((r) => r.amountCents)).toEqual([-500, -500, 700]);
    expect(errors).toEqual([{ line: 5, message: 'neither debit nor credit is filled' }]);
  });

  it('keeps every cell in raw keyed by column name', () => {
    const table = fixture('signed-header.csv');
    const { rows } = mapRows(table, detectMapping(table).mapping);
    expect(rows[0]!.raw).toEqual({
      Date: '2026-08-01',
      Description: 'WOOLWORTHS 3120 RICHMOND',
      Amount: '-84.20',
      Balance: '1523.45',
    });
    expect(rows[0]!.balanceCents).toBe(152345);
  });
});
