/**
 * DOM-free formatting of numbers and quantity results, shared by the learner projection, accessible descriptions and
 * summaries. Numbers use significant digits (never fixed decimals), so a tiny nonzero value can never print as an
 * exact 0; undefined and numerical-limit statuses become explanatory text, never a number (D10, report §8.3).
 * Conversion from the canonical unit to a display unit happens here, at the presentation boundary, with core
 * `convert()`; nothing is rescaled silently.
 */
import { UNITS, convert, isCompatible, unitLabel, type QuantityResult, type UnitId } from '@explorable-models/core/model';

export const DEFAULT_PRECISION = 4;
export const DEFAULT_LOCALE = 'en-US';
/** Decimal exponents of the plain-notation range: 1e-4 ≤ |x| < 1e7. Other nonzero magnitudes use scientific notation. */
export const PLAIN_EXPONENTS = Object.freeze({ min: -4, below: 7 });
/** Smallest positive normal double; nonzero magnitudes below it are subnormal and carry reduced precision. */
const MIN_NORMAL = 2.2250738585072014e-308;

/**
 * `unicode`: `1.234 × 10⁻⁵` (learner text); `ascii`: `1.234e-5` (logs, copy); `tex`: `1.234 \times 10^{-5}` with
 * grouping commas braced so math mode does not space them as punctuation.
 */
export type Notation = 'unicode' | 'ascii' | 'tex';
export interface NumberFormatOptions {
  precision?: number;
  locale?: string;
  notation?: Notation;
  /** Locale digit grouping (default true); tables turn it off so a cell reads back as a number. */
  grouping?: boolean;
  /** Writes a safe integer with every digit (236196) instead of rounding it to `precision` significant digits. */
  exactIntegers?: boolean;
}

const MAX_FORMATTERS = 64;
const formatters = new Map<string, Intl.NumberFormat | null>();
/**
 * Locale-aware formatter with a fallback to {@link DEFAULT_LOCALE}; null when `Intl` is unavailable. `precision` 0
 * formats whole numbers with every digit.
 */
function formatter(locale: string, precision: number, grouping = true): Intl.NumberFormat | null {
  const key = `${locale}\u0000${precision}\u0000${grouping ? 1 : 0}`;
  const cached = formatters.get(key);
  if (cached !== undefined) return cached;
  let made: Intl.NumberFormat | null = null;
  const options: Intl.NumberFormatOptions = precision === 0 ? { maximumFractionDigits: 0, useGrouping: grouping } : { maximumSignificantDigits: precision, useGrouping: grouping };
  for (const candidate of [locale, DEFAULT_LOCALE]) {
    try { made = new Intl.NumberFormat(candidate, options); break; } catch { /* next candidate */ }
  }
  if (formatters.size >= MAX_FORMATTERS) formatters.clear();
  formatters.set(key, made);
  return made;
}

const checkPrecision = (precision: number): number => {
  if (!Number.isInteger(precision) || precision < 1 || precision > 21) throw new RangeError('precision must be an integer number of significant digits from 1 to 21.');
  return precision;
};

/** Formats a value already rounded to `precision` significant digits (0: a whole number) in plain notation. */
function plain(value: number, precision: number, locale: string, notation: Notation, grouping = true): string {
  const text = formatter(locale, precision, grouping)?.format(value) ?? (precision === 0 ? String(value) : String(Number(value.toPrecision(precision))));
  return notation === 'tex' ? text.replaceAll(',', '{,}') : text;
}

const SUPERSCRIPT: Readonly<Record<string, string>> = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };

/**
 * Formats a finite number with `precision` significant digits (default 4) in `locale` (default en-US). Magnitudes
 * below 1e-4 or at least 1e7 use scientific notation; `-0` prints as `0`. Throws `RangeError` for a nonfinite number:
 * statuses are formatted by {@link formatQuantity}, never by inventing a numeral.
 */
export function formatNumber(value: number, options: NumberFormatOptions = {}): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new RangeError('formatNumber requires a finite number; format undefined and numerical-limit statuses with formatQuantity.');
  const precision = checkPrecision(options.precision ?? DEFAULT_PRECISION);
  const locale = options.locale ?? DEFAULT_LOCALE, notation = options.notation ?? 'unicode', grouping = options.grouping ?? true;
  if (value === 0) return '0';
  if (options.exactIntegers && Number.isSafeInteger(value)) return plain(value, 0, locale, notation, grouping);
  // The decision uses the exponent of the rounded value (mantissa in [1, 10)), so 9.99996e-5, which rounds to
  // 1.000e-4, prints as 0.0001 and the thresholds are exact.
  const [mantissa, exponent] = value.toExponential(precision - 1).split('e') as [string, string];
  const power = Number(exponent);
  if (power >= PLAIN_EXPONENTS.min && power < PLAIN_EXPONENTS.below) return plain(Number(value.toPrecision(precision)), precision, locale, notation, grouping);
  const head = plain(Number(mantissa), precision, locale, notation, grouping);
  if (notation === 'ascii') return `${head}e${power}`;
  if (notation === 'tex') return `${head} \\times 10^{${power}}`;
  return `${head} × 10${[...String(power)].map(char => SUPERSCRIPT[char] ?? char).join('')}`;
}

export interface QuantityFormatOptions extends NumberFormatOptions {
  /** Canonical unit of the quantity (from the model manifest). */
  unit: UnitId;
  /** Display unit; must have the same dimension as `unit`. Defaults to `unit`. */
  displayUnit?: UnitId;
  /** Learner-facing labels for category values; the raw category ID is used when absent. */
  categoryLabels?: Readonly<Record<string, string>>;
}
export interface FormattedQuantity {
  /** Numeral(s), category label or status text, without the unit. Never a fabricated number. */
  text: string;
  /** `text` with the unit label attached for valid numeric values; equal to `text` otherwise. */
  display: string;
  /** `numerical-limit` also reports a valid canonical value that cannot be represented in the display unit. */
  status: QuantityResult['status'];
  /** True for an upstream approximation (underflow, rounding) or a subnormal display value; the text starts with `≈`. */
  approximate: boolean;
  /** Value in the display unit for valid results; omitted for undefined and numerical-limit statuses. */
  value?: number | number[] | string;
  unit: UnitId;
  unitLabel: string;
  /** Learner-safe reason for undefined and numerical-limit statuses. */
  reason?: string;
}

type Converted = { ok: true; value: number; approximate: boolean } | { ok: false; reason: string };
function toDisplay(value: number, from: UnitId, to: UnitId): Converted {
  let converted: number;
  try { converted = convert(value, from, to); } catch { return { ok: false, reason: `the value exceeds the representable range in ${UNITS[to].plainLabel}` }; }
  if (value !== 0 && converted === 0) return { ok: false, reason: `the value is too small to represent in ${UNITS[to].plainLabel}` };
  return { ok: true, value: converted, approximate: converted !== 0 && Math.abs(converted) < MIN_NORMAL };
}

/** Separator between vector components that cannot be confused with the locale's decimal separator. */
function componentSeparator(locale: string): string {
  const decimal = formatter(locale, 2)?.formatToParts(1.5).find(part => part.type === 'decimal')?.value ?? '.';
  return decimal === ',' ? '; ' : ', ';
}

const attachUnit = (text: string, unit: UnitId): string => {
  const label = unitLabel(unit);
  return !label ? text : unit === 'deg' ? `${text}°` : `${text} ${label}`;
};

/**
 * Formats one quantity result in its display unit. `undefined` → `Undefined: <reason>`; `numerical-limit` →
 * `Beyond numerical range (<reason>)` with the last finite index when known; a valid value that overflows or
 * underflows to zero in the display unit is reported as a numerical limit, never as `0` or `Infinity`. Approximate
 * values are prefixed with `≈`. Incompatible units are a template error and throw `RangeError`.
 */
export function formatQuantity(result: QuantityResult, options: QuantityFormatOptions): FormattedQuantity {
  const target = options.displayUnit ?? options.unit;
  if (!isCompatible(options.unit, target)) throw new RangeError('The display unit must have the same dimension as the quantity unit.');
  const base = { unit: target, unitLabel: unitLabel(target) };
  const limit = (reason: string, lastFiniteIndex?: number): FormattedQuantity => {
    const text = `Beyond numerical range (${reason})${lastFiniteIndex !== undefined ? `; last finite index ${lastFiniteIndex}` : ''}`;
    return { text, display: text, status: 'numerical-limit', approximate: false, ...base, reason };
  };
  if (result.status === 'undefined') {
    const text = `Undefined: ${result.reason}`;
    return { text, display: text, status: 'undefined', approximate: false, ...base, reason: result.reason };
  }
  if (result.status === 'numerical-limit') return limit(result.reason, result.lastFiniteIndex);
  const value = result.value;
  if (typeof value === 'string') {
    const text = options.categoryLabels?.[value] ?? value;
    return { text, display: text, status: 'valid', approximate: false, value, unit: target, unitLabel: '' };
  }
  const numbers = typeof value === 'number' ? [value] : value;
  const converted: number[] = [];
  let approximate = result.approximation !== undefined;
  for (const item of numbers) {
    const next = toDisplay(item, options.unit, target);
    if (!next.ok) return limit(next.reason);
    converted.push(next.value);
    approximate ||= next.approximate;
  }
  const numerals = converted.map(item => formatNumber(item, options));
  const body = typeof value === 'number' ? numerals[0]! : `(${numerals.join(componentSeparator(options.locale ?? DEFAULT_LOCALE))})`;
  const text = approximate ? `≈ ${body}` : body;
  return { text, display: attachUnit(text, target), status: 'valid', approximate, value: typeof value === 'number' ? converted[0]! : converted, ...base };
}
