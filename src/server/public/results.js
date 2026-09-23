// Date-window helpers shared by the Overview and the Transactions filters.
/**
 * Preset date windows for the Transactions filters and the Overview period
 * control, matching the chat tools' `period` presets (`src/tools/period.ts`):
 * calendar months, a rolling 30 days that ends today, and the year to date.
 * Returns `null` for "all time".
 */
export function presetWindow(preset, todayText) {
  const today = todayText ?? new Date().toISOString().slice(0, 10);
  const [y, m] = today.split('-').map(Number);
  const iso = (d) => d.toISOString().slice(0, 10);
  const monthEnd = (year, month) => iso(new Date(Date.UTC(year, month, 0)));
  switch (preset) {
    case 'this_month':
      return { from: `${today.slice(0, 7)}-01`, to: today };
    case 'last_month': {
      const d = new Date(Date.UTC(y, m - 2, 1));
      return { from: iso(d), to: monthEnd(d.getUTCFullYear(), d.getUTCMonth() + 1) };
    }
    case 'last_30_days':
      return { from: iso(new Date(Date.parse(today) - 29 * 86400000)), to: today };
    case 'ytd':
      return { from: `${today.slice(0, 4)}-01-01`, to: today };
    default:
      return null;
  }
}
/** "1 to 14 September 2026", "28 August to 3 September 2026", "3 March 2025 to 2 March 2026". */
export function describeWindow(from, to, locale = 'en-AU') {
  if (!from || !to) return 'All imported history';
  const a = new Date(`${from}T00:00:00Z`),
    b = new Date(`${to}T00:00:00Z`);
  const day = (d) => d.getUTCDate();
  const month = (d) => d.toLocaleDateString(locale, { month: 'long', timeZone: 'UTC' });
  const year = (d) => d.getUTCFullYear();
  if (from === to) return `${day(a)} ${month(a)} ${year(a)}`;
  if (year(a) !== year(b))
    return `${day(a)} ${month(a)} ${year(a)} to ${day(b)} ${month(b)} ${year(b)}`;
  if (month(a) !== month(b)) return `${day(a)} ${month(a)} to ${day(b)} ${month(b)} ${year(b)}`;
  return `${day(a)} to ${day(b)} ${month(b)} ${year(b)}`;
}
