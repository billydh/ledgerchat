// Decimal strings are parsed as integers; no floating point multiplication.
export function parseMoney(value, { signed = false, optional = false } = {}) {
  const text = value.trim();
  if (!text && optional) return null;
  if (!text) throw new Error('Enter an amount, including 0 if intended.');
  if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(text))
    throw new Error('Use a number with at most two decimal places, such as 10,000.00.');
  if (!signed && text.startsWith('-')) throw new Error('Enter a positive amount or zero.');
  const [whole, fraction = ''] = text.replaceAll(',', '').replace('-', '').split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('This amount is too large.');
  return Number(cents) * (text.startsWith('-') ? -1 : 1);
}
export function moneyInput(cents) {
  if (cents === null || cents === undefined || cents === '') return '';
  const n = BigInt(cents);
  const abs = n < 0n ? -n : n;
  return `${n < 0n ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}
/**
 * Money for display. Negative cents render as "-$12.34", positive as "$12.34"
 * (or "+$12.34" with `sign: 'always'`); `sign: 'never'` drops the sign. The
 * currency code is added only when `code` is true, for mixed-currency lists.
 */
export function formatMoney(
  cents,
  currency,
  { sign = 'auto', code = false, locale = 'en-AU' } = {},
) {
  const value = Number(cents) || 0;
  let text;
  try {
    text = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: currency || 'AUD',
      currencyDisplay: 'narrowSymbol',
    }).format(Math.abs(value) / 100);
  } catch {
    text = `${(Math.abs(value) / 100).toFixed(2)}`;
  }
  const prefix = value < 0 && sign !== 'never' ? '-' : value > 0 && sign === 'always' ? '+' : '';
  return `${prefix}${text}${code && currency ? ` ${currency}` : ''}`;
}
