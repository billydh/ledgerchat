export const CLASS_LABELS: Record<string, string>;
export function classLabel(cls: string | null | undefined): string;
export const CADENCE_LABELS: Record<string, string>;
export function cadenceLabel(cadence: string | null | undefined): string;
export function reconciliationLabel(
  state: { status?: string; unexplained_cents?: number } | null | undefined,
  format?: (cents: number) => string,
): { text: string; tone: 'ok' | 'warn' | 'muted' };
export const TOOL_LABELS: Record<string, string>;
export function toolLabel(name: string | null | undefined): string;
export function describeToolInput(name: string, input: unknown): string;
export const GLOSSARY: Record<string, { title: string; text: string }>;
