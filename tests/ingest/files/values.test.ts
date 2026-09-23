import { describe, expect, it } from 'vitest';
import { dateFormatsOf, parseAmount, parseDate } from '../../../src/ingest/files/values.js';

describe('parseDate', () => {
  it('parses each supported format', () => {
    expect(parseDate('2026-08-05', 'YYYY-MM-DD')).toBe('2026-08-05');
    expect(parseDate('05/08/2026', 'DD/MM/YYYY')).toBe('2026-08-05');
    expect(parseDate('08/05/2026', 'MM/DD/YYYY')).toBe('2026-08-05');
    expect(parseDate('05-08-2026', 'DD-MM-YYYY')).toBe('2026-08-05');
    expect(parseDate('5 Aug 2026', 'DD MMM YYYY')).toBe('2026-08-05');
    expect(parseDate('05-Sept-2026', 'DD MMM YYYY')).toBe('2026-09-05');
  });

  it('accepts two-digit years and a trailing time of day', () => {
    expect(parseDate('05/08/26', 'DD/MM/YYYY')).toBe('2026-08-05');
    expect(parseDate('2026-08-05 14:03:00', 'YYYY-MM-DD')).toBe('2026-08-05');
    expect(parseDate('2026-08-05T14:03:00Z', 'YYYY-MM-DD')).toBe('2026-08-05');
  });

  it('rejects impossible dates and the wrong format', () => {
    expect(parseDate('31/02/2026', 'DD/MM/YYYY')).toBeUndefined();
    expect(parseDate('13/13/2026', 'MM/DD/YYYY')).toBeUndefined();
    expect(parseDate('2026-08-05', 'DD/MM/YYYY')).toBeUndefined();
    expect(parseDate('', 'YYYY-MM-DD')).toBeUndefined();
    expect(parseDate('WOOLWORTHS', 'DD MMM YYYY')).toBeUndefined();
  });

  it('reports every format a cell fits, which exposes day/month ambiguity', () => {
    expect(dateFormatsOf('03/04/2026')).toEqual(['DD/MM/YYYY', 'MM/DD/YYYY']);
    expect(dateFormatsOf('25/04/2026')).toEqual(['DD/MM/YYYY']);
    expect(dateFormatsOf('2026-04-25')).toEqual(['YYYY-MM-DD']);
  });
});

describe('parseAmount', () => {
  it('parses plain, signed and currency-prefixed amounts to cents', () => {
    expect(parseAmount('12.34')).toBe(1234);
    expect(parseAmount('-12.34')).toBe(-1234);
    expect(parseAmount('+12')).toBe(1200);
    expect(parseAmount('$1,234.56')).toBe(123456);
    expect(parseAmount('-$1,234.56')).toBe(-123456);
    expect(parseAmount('$-1,234.56')).toBe(-123456);
    expect(parseAmount('A$5.00')).toBe(500);
    expect(parseAmount('AUD 5.00')).toBe(500);
    expect(parseAmount('12.34-')).toBe(-1234);
  });

  it('reads parentheses and CR/DR markers', () => {
    expect(parseAmount('(10.00)')).toBe(-1000);
    expect(parseAmount('10.00 CR')).toBe(1000);
    expect(parseAmount('10.00 DR')).toBe(-1000);
    expect(parseAmount('$10.00DR')).toBe(-1000);
  });

  it('handles thousands and decimal separators either way round', () => {
    expect(parseAmount('1,234')).toBe(123400);
    expect(parseAmount('12,99')).toBe(1299);
    expect(parseAmount('2.400,00')).toBe(240000);
    expect(parseAmount('1 234,50')).toBe(123450);
  });

  it('rejects text, empties and more than two decimals', () => {
    expect(parseAmount('')).toBeUndefined();
    expect(parseAmount('WOOLWORTHS')).toBeUndefined();
    expect(parseAmount('1.234.5')).toBeUndefined();
    expect(parseAmount('12.345')).toBeUndefined();
    expect(parseAmount('2026-08-05')).toBeUndefined();
  });
});
