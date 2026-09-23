import { describe, expect, it } from 'vitest';
import { parseMoney, moneyInput } from '../../src/server/public/money.js';
describe('financial form decimal conversion', () => {
  it.each([
    ['10,000.00', 1000000],
    ['0', 0],
    ['0.29', 29],
    ['12.3', 1230],
    ['-12.34', -1234],
    ['90071992547409.91', Number.MAX_SAFE_INTEGER],
  ])('parses %s exactly', (value, cents) => {
    expect(parseMoney(value, { signed: true })).toBe(cents);
    expect(parseMoney(moneyInput(cents), { signed: true })).toBe(cents);
  });
  it.each(['1.001', '1e3', '12,34', 'NaN', '.', '+2', '90071992547409.92'])('rejects %s', (value) =>
    expect(() => parseMoney(value)).toThrow(),
  );
  it('keeps optional blank distinct from zero and rejects required blanks and unsigned negatives', () => {
    expect(parseMoney('', { optional: true })).toBeNull();
    expect(parseMoney('0', { optional: true })).toBe(0);
    expect(moneyInput(null)).toBe('');
    expect(() => parseMoney('')).toThrow();
    expect(() => parseMoney('-1')).toThrow();
  });
});
