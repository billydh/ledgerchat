/**
 * Cell-level parsers shared by column detection and row mapping. Both must
 * agree on what counts as a date or an amount, so they live in one place.
 */

export const DATE_FORMATS = [
  'YYYY-MM-DD',
  'DD/MM/YYYY',
  'MM/DD/YYYY',
  'DD-MM-YYYY',
  'DD MMM YYYY',
] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/** A trailing time of day is accepted and ignored; the stored date is the day. */
const TRAILING_TIME =
  /(?:[T ]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\s*(?:[AP]M)?(?:Z|[+-]\d{2}:?\d{2})?)?\s*$/i;

const ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})/;
const SLASH = /^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})/;
const DASH = /^(\d{1,2})-(\d{1,2})-(\d{4}|\d{2})/;
const NAMED = /^(\d{1,2})[ -]([A-Za-z]{3,9})[ -](\d{4}|\d{2})/;

function fullYear(text: string): number {
  const year = Number(text);
  return text.length === 2 ? 2000 + year : year;
}

function calendarDay(year: number, month: number, day: number): string | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900 || year > 2200)
    return undefined;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return date.toISOString().slice(0, 10);
}

/**
 * Parses one cell in the given format. Returns the calendar day as
 * `YYYY-MM-DD`, or undefined when the cell does not fit the format or is not a
 * real date (31 February, month 13).
 */
export function parseDate(cell: string, format: DateFormat): string | undefined {
  const text = cell.trim().replace(TRAILING_TIME, '');
  if (!text) return undefined;
  switch (format) {
    case 'YYYY-MM-DD': {
      const m = ISO.exec(text);
      return m && m[0].length === text.length
        ? calendarDay(Number(m[1]), Number(m[2]), Number(m[3]))
        : undefined;
    }
    case 'DD/MM/YYYY':
    case 'MM/DD/YYYY': {
      const m = SLASH.exec(text);
      if (!m || m[0].length !== text.length) return undefined;
      const [a, b] = [Number(m[1]), Number(m[2])];
      return format === 'DD/MM/YYYY'
        ? calendarDay(fullYear(m[3]!), b, a)
        : calendarDay(fullYear(m[3]!), a, b);
    }
    case 'DD-MM-YYYY': {
      const m = DASH.exec(text);
      return m && m[0].length === text.length
        ? calendarDay(fullYear(m[3]!), Number(m[2]), Number(m[1]))
        : undefined;
    }
    case 'DD MMM YYYY': {
      const m = NAMED.exec(text);
      if (!m || m[0].length !== text.length) return undefined;
      const month =
        MONTHS[m[2]!.slice(0, 4).toLowerCase()] ?? MONTHS[m[2]!.slice(0, 3).toLowerCase()];
      return month === undefined ? undefined : calendarDay(fullYear(m[3]!), month, Number(m[1]));
    }
  }
}

/** Every format the cell parses under, so a caller can spot day/month ambiguity. */
export function dateFormatsOf(cell: string): DateFormat[] {
  return DATE_FORMATS.filter((format) => parseDate(cell, format) !== undefined);
}

/** A currency marker in front of the figure. Only real codes, so `REF 123` stays text. */
const CURRENCY_PREFIX = /^(?:AUD|USD|NZD|GBP|EUR|CAD|SGD|JPY|CHF|INR|HKD|ZAR|[A-Z]{0,2}\$|€|£)\s*/i;

/**
 * Parses a money cell into minor units. Accepts `$`, `A$`, a three-letter
 * currency code, thousands separators, a leading or trailing minus, a
 * parenthesised negative, and a trailing `CR` (credit, positive) or `DR`
 * (debit, negative). Returns undefined for anything else, including empty.
 */
export function parseAmount(cell: string): number | undefined {
  let text = cell.trim();
  if (!text) return undefined;
  let negative = false;
  const marker = /\s*(CR|DR)$/i.exec(text);
  if (marker) {
    if (marker[1]!.toUpperCase() === 'DR') negative = true;
    text = text.slice(0, marker.index);
  }
  if (text.startsWith('(') && text.endsWith(')')) {
    negative = true;
    text = text.slice(1, -1).trim();
  }
  if (text.startsWith('-')) {
    negative = !negative;
    text = text.slice(1).trim();
  } else if (text.startsWith('+')) {
    text = text.slice(1).trim();
  }
  text = text.replace(CURRENCY_PREFIX, '');
  if (text.startsWith('-')) {
    negative = !negative;
    text = text.slice(1).trim();
  }
  if (text.endsWith('-')) {
    negative = !negative;
    text = text.slice(0, -1).trim();
  }
  if (!/^[\d.,\s]+$/.test(text) || !/\d/.test(text)) return undefined;
  text = text.replace(/\s+/g, '');
  const digits = decimalise(text);
  if (digits === undefined) return undefined;
  const [whole, fraction = ''] = digits.split('.');
  if (fraction.length > 2) return undefined;
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) return undefined;
  return negative ? -cents : cents;
}

/**
 * Normalises separators to a plain `1234.56`. When both `.` and `,` appear the
 * last one is the decimal point; a lone comma followed by exactly three digits
 * is a thousands separator, otherwise it is the decimal point.
 */
function decimalise(text: string): string | undefined {
  const lastDot = text.lastIndexOf('.');
  const lastComma = text.lastIndexOf(',');
  if (lastDot !== -1 && lastComma !== -1) {
    return lastDot > lastComma ? text.replace(/,/g, '') : text.replace(/\./g, '').replace(',', '.');
  }
  if (lastComma !== -1) {
    const groups = text.split(',');
    const thousands = groups.slice(1).every((g) => g.length === 3) && groups[0]!.length <= 3;
    return thousands
      ? groups.join('')
      : groups.length === 2
        ? `${groups[0]!}.${groups[1]!}`
        : undefined;
  }
  if ((text.match(/\./g) ?? []).length > 1) return undefined;
  return text;
}
