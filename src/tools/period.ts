import { z } from 'zod';
export const dateSchema = z.iso.date();
export const PRESETS = ['last_month', 'this_month', 'last_30_days', 'ytd'] as const;
export type Preset = (typeof PRESETS)[number];
export type DateWindow = { from: string; to: string };
export type Period = Preset | DateWindow;
/**
 * A window as the model sends it: flat fields, never a union. Exactly
 * one of `period` (a preset) or the `from`/`to` pair is allowed; the same
 * shape is reused with a `compare_` prefix for the comparison window.
 */
export type FlatWindow = {
  period?: Preset | undefined;
  from?: string | undefined;
  to?: string | undefined;
};
export type WindowPrefix = '' | 'compare_';
const presetList = PRESETS.join(', ');
/** The two valid forms, spelled out for validation messages and descriptions. */
export const windowForms = (prefix: WindowPrefix = ''): string =>
  `either ${prefix}period (one of ${presetList}) or both ${prefix}from and ${prefix}to as YYYY-MM-DD dates`;
/**
 * Field schemas for one flat window. The messages name the flat fields so a
 * model that sends the retired `{from, to}` object, or that object as a JSON
 * string, is told what to send instead rather than only what was wrong.
 */
export function windowFields(prefix: WindowPrefix = '') {
  const rejected = (field: string) =>
    `${prefix}${field} must be a YYYY-MM-DD date, not an object or a JSON string; send ${windowForms(prefix)}`;
  return {
    period: z
      .enum(PRESETS, {
        error: `${prefix}period must be one of ${presetList}; for explicit dates omit ${prefix}period and send ${prefix}from and ${prefix}to as YYYY-MM-DD dates`,
      })
      .optional(),
    from: z.iso.date({ error: rejected('from') }).optional(),
    to: z.iso.date({ error: rejected('to') }).optional(),
  };
}
/**
 * How a tool takes its window. The summary tools require one and take dates
 * only as a pair; `search_transactions` may omit it and may bound one
 * side only, since "through today" is a search idiom the reference calls use.
 */
export type WindowRule = { required?: boolean; openEnded?: boolean };
/** The exactly-one rule for a flat window; null when the fields are valid. */
export function windowIssue(
  fields: FlatWindow,
  prefix: WindowPrefix = '',
  { required = true, openEnded = false }: WindowRule = {},
) {
  const hasPreset = fields.period !== undefined;
  const dates = [fields.from, fields.to].filter((v) => v !== undefined).length;
  if (hasPreset && dates) return `Send ${windowForms(prefix)}, not both`;
  if (dates === 1 && !openEnded)
    return `${prefix}from and ${prefix}to must be sent together; send ${windowForms(prefix)}`;
  if (!hasPreset && !dates) return required ? `Missing window: send ${windowForms(prefix)}` : null;
  if (fields.from !== undefined && fields.to !== undefined && fields.from > fields.to)
    return `${prefix}from must be on or before ${prefix}to`;
  return null;
}
/** Reads the prefixed flat fields out of a parsed tool input. */
export function flatWindow(input: Record<string, unknown>, prefix: WindowPrefix): FlatWindow {
  return {
    period: input[`${prefix}period`] as Preset | undefined,
    from: input[`${prefix}from`] as string | undefined,
    to: input[`${prefix}to`] as string | undefined,
  };
}
/**
 * Zod refinement shared by every tool that takes flat windows, so the rule
 * lives in one place and a scorer's `safeParse` sees the same verdict as the
 * tool. The primary window is required; the comparison window is optional
 * but, once any of its fields is present, must be complete.
 */
export function refineWindows(
  input: Record<string, unknown>,
  ctx: z.RefinementCtx,
  prefixes: WindowPrefix[] = [''],
  rule: WindowRule = {},
) {
  for (const prefix of prefixes) {
    const message = windowIssue(flatWindow(input, prefix), prefix, {
      ...rule,
      required: prefix === '' && rule.required !== false,
    });
    if (message) ctx.addIssue({ code: 'custom', message, path: [`${prefix}period`] });
  }
}
/** Turns validated flat fields into the resolved inclusive UTC window. */
export function resolveWindow(
  fields: FlatWindow,
  now: Date,
  prefix: WindowPrefix = '',
): DateWindow {
  const message = windowIssue(fields, prefix);
  if (message) throw new Error(message);
  return resolvePeriod(fields.period ?? { from: fields.from!, to: fields.to! }, now);
}
/**
 * The open-ended form for search: a preset resolves as above, explicit dates
 * pass through with either side possibly absent, and no window at all is an
 * unbounded pair.
 */
export function resolveOpenWindow(
  fields: FlatWindow,
  now: Date,
): { from: string | undefined; to: string | undefined } {
  const message = windowIssue(fields, '', { required: false, openEnded: true });
  if (message) throw new Error(message);
  if (fields.period !== undefined) return resolvePeriod(fields.period, now);
  return { from: fields.from, to: fields.to };
}
export const day = (date: Date): string => date.toISOString().slice(0, 10);
export function resolvePeriod(period: Period, now = new Date()): DateWindow {
  const today = day(now);
  let range: DateWindow;
  if (typeof period !== 'string') range = period;
  else {
    const y = now.getUTCFullYear(),
      m = now.getUTCMonth();
    range =
      period === 'last_month'
        ? { from: day(new Date(Date.UTC(y, m - 1, 1))), to: day(new Date(Date.UTC(y, m, 0))) }
        : {
            from:
              period === 'this_month'
                ? day(new Date(Date.UTC(y, m, 1)))
                : period === 'ytd'
                  ? `${y}-01-01`
                  : day(new Date(Date.parse(today) - 29 * 86400000)),
            to: today,
          };
  }
  if (range.from > range.to) throw new Error('from must be on or before to');
  return range;
}
export function nextMonth(date: string): string {
  const d = new Date(date),
    y = d.getUTCFullYear(),
    m = d.getUTCMonth();
  return day(
    new Date(
      Date.UTC(y, m + 1, Math.min(d.getUTCDate(), new Date(Date.UTC(y, m + 2, 0)).getUTCDate())),
    ),
  );
}
