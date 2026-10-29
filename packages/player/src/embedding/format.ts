import type { ValueResult } from '@explorable-models/core/declarative';

/** Significant digits preserve small nonzero errors; only actual negative zero becomes zero. */
export function formatNumber(value: number, precision = 6, locale = 'en-US'): string {
  if (!Number.isFinite(value)) return 'Undefined';
  const n = Object.is(value, -0) ? 0 : value;
  const notation = n !== 0 && (Math.abs(n) < 0.0001 || Math.abs(n) >= 1e7) ? 'scientific' : 'standard';
  try { return new Intl.NumberFormat(locale, { maximumSignificantDigits: precision, notation }).format(n); }
  catch { return new Intl.NumberFormat('en-US', { maximumSignificantDigits: 6, notation }).format(n); }
}

export function formatValue(result: ValueResult | undefined, precision = 6, locale = 'en-US'): string {
  if (!result || result.status === 'undefined' || result.value === null) return `Undefined: ${result?.reason ?? 'quantity is unavailable'}`;
  return Array.isArray(result.value)
    ? `[${result.value.map(n => formatNumber(n, precision, locale)).join(', ')}]`
    : formatNumber(result.value, precision, locale);
}
