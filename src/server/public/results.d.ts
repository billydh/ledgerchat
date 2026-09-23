export type PresetKey = 'this_month' | 'last_month' | 'last_30_days' | 'ytd' | 'custom';
export function presetWindow(
  preset: PresetKey | string,
  today?: string,
): { from: string; to: string } | null;
export function describeWindow(from: string | null, to: string | null, locale?: string): string;
