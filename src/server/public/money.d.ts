export function parseMoney(
  value: string,
  options?: { signed?: boolean; optional?: boolean },
): number | null;
export function moneyInput(cents: number | null | undefined | ''): string;
export function formatMoney(
  cents: number | null | undefined,
  currency: string | null | undefined,
  options?: { sign?: 'auto' | 'always' | 'never'; code?: boolean; locale?: string },
): string;
