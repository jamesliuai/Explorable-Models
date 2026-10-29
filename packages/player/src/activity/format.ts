/**
 * Formatting for the learner surface. Scientific values are never reformatted here: `ProjectedValue.text` is produced
 * by the projection (from the identified frame, in the display unit) and is shown verbatim. This module only formats
 * presentation numbers the surface itself owns: axis ticks, the integer navigation index, camera readouts and the
 * bounds quoted in input explanations.
 */
import type { ProjectedControl, ProjectedNavigation, ProjectedValue } from '@experiment-kit/activity';

export const MINUS = '−';
const SUPERSCRIPT: Record<string, string> = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '-': '⁻' };

const numberFormat = (locale: string | undefined, options: Intl.NumberFormatOptions): Intl.NumberFormat => {
  try { return new Intl.NumberFormat(locale, options); } catch { return new Intl.NumberFormat('en', options); }
};
const typographicMinus = (text: string) => text.replace(/^-/, MINUS).replace(/-(?=\d)/g, MINUS);

/** Fraction digits needed to write `step` exactly (0.25 → 2, 5 → 0), capped at 12. */
export function decimalsFor(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  for (let digits = 0; digits <= 12; digits++) {
    const scaled = step * 10 ** digits;
    if (Math.abs(scaled - Math.round(scaled)) <= 1e-9 * Math.max(1, Math.abs(scaled))) return digits;
  }
  return 12;
}

/** `m×10ⁿ` with a superscript exponent and at most `fractionDigits` mantissa decimals (trailing zeros dropped). */
export function formatScientific(value: number, fractionDigits: number, locale?: string): string {
  if (value === 0) return '0';
  let exponent = Math.floor(Math.log10(Math.abs(value)));
  let mantissa = value / 10 ** exponent;
  const rounded = Number(mantissa.toFixed(fractionDigits));
  if (Math.abs(rounded) >= 10) { exponent += 1; mantissa = rounded / 10; } else mantissa = rounded;
  const head = typographicMinus(numberFormat(locale, { maximumFractionDigits: fractionDigits }).format(mantissa));
  const power = [...String(exponent)].map(c => SUPERSCRIPT[c] ?? c).join('');
  return head === '1' ? `10${power}` : head === `${MINUS}1` ? `${MINUS}10${power}` : `${head}×10${power}`;
}

/**
 * Tick label for `value` on an axis whose tick spacing is `step`. Uses exactly the decimals the step needs, a true
 * minus sign, and scientific notation for very large or very small spacings so tiny nonzero ticks never read as 0.
 */
export function formatTick(value: number, step: number, locale?: string): string {
  if (!Number.isFinite(value)) return '';
  if (value === 0 || Math.abs(value) < Math.abs(step) * 1e-9) return '0';
  const magnitude = Math.abs(value);
  if (magnitude >= 1e6 || step < 1e-4) {
    const exponent = Math.floor(Math.log10(magnitude));
    const digits = Math.min(6, Math.max(0, exponent - Math.floor(Math.log10(step) + 1e-9)));
    return formatScientific(value, digits, locale);
  }
  const digits = decimalsFor(step);
  return typographicMinus(numberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value));
}

/** Plain number for explanations and camera readouts (up to 6 significant digits; never rounds a nonzero to 0). */
export function formatPlain(value: number, locale?: string): string {
  if (!Number.isFinite(value)) return '';
  if (value === 0) return '0';
  const magnitude = Math.abs(value);
  if (magnitude < 1e-4 || magnitude >= 1e9) return formatScientific(value, 3, locale);
  return typographicMinus(numberFormat(locale, { maximumSignificantDigits: 6 }).format(value));
}

/**
 * A number the surface itself shows (control values, ranges, positions, coordinates, explanations): {@link formatPlain}
 * for a finite value. A non-finite input is a contract violation that a valid projection never carries; it still reads
 * as `undefined` (NaN) or `∞`/`−∞`, never as `0` or as nothing (repository rule: undefined is a status, not zero).
 */
export function formatShown(value: number, locale?: string): string {
  if (typeof value !== 'number' || Number.isNaN(value)) return 'undefined';
  if (value === Infinity) return '∞';
  if (value === -Infinity) return `${MINUS}∞`;
  return formatPlain(value, locale);
}

/** Integer navigation readout, e.g. `n = 3 of 1000`. A discrete index is always shown as a whole number. */
export function formatPosition(navigation: Pick<ProjectedNavigation, 'kind' | 'value' | 'max'>, locale?: string): string {
  if (navigation.kind === 'index') {
    const index = Number.isInteger(navigation.value) ? navigation.value : Math.floor(navigation.value);
    return navigation.max === null ? `n = ${index}` : `n = ${index} of ${navigation.max}`;
  }
  const value = formatShown(navigation.value, locale);
  return navigation.max === null ? `t = ${value}` : `t = ${value} of ${formatShown(navigation.max, locale)}`;
}

/** Typographic minus (U+2212) for negative numerals inside projection text (hyphens in words are untouched). */
export const numeralMinus = (text: string): string => text.replace(/(^|[\s(,;=])-(?=[\d.])/g, `$1${MINUS}`);

export interface ValueDisplay { text: string; unit: string; approximate: boolean; status: ProjectedValue['status']; reason: string | null }
/** Letter used for an iteration count (`n = 700`): the quantity's one-letter symbol, else `n`. */
const countSymbol = (value: Pick<ProjectedValue, 'symbol'>): string => value.symbol && /^[A-Za-z]$/.test(value.symbol) ? value.symbol : 'n';
/**
 * Display parts of a projected value: the projection's text with typographic minus signs, plus the unit label as a
 * separate element only for valid values whose text does not already end with it. Undefined/limit values keep their
 * learner-safe text; when that text embeds its reason (`Undefined: …`, `Beyond numerical range (…)`), the reason is
 * shown once, as the separate reason, instead of twice. Any reason (an undefined cause or an approximation's limits)
 * is shown with the value.
 */
export function valueDisplay(value: ProjectedValue): ValueDisplay {
  let unit = value.status === 'valid' && value.unitLabel && !value.text.trimEnd().endsWith(value.unitLabel) ? value.unitLabel : '';
  const reason = value.reason?.trim() ? value.reason : null;
  let text = value.status === 'valid' ? numeralMinus(value.text) : value.text;
  // Units read as a reader says them: an iteration count is `n = 700` (never `700 iter`), degrees attach as `45°`.
  if (value.status === 'valid' && unit && value.unit === 'iteration') { text = `${countSymbol(value)} = ${text}`; unit = ''; }
  else if (value.status === 'valid' && unit && value.unit === 'deg') { text = `${text}${unit}`; unit = ''; }
  if (reason && value.status !== 'valid') {
    const shortened = text.replace(` (${reason})`, '').replace(`: ${reason}`, '');
    if (shortened.trim()) text = shortened;
  }
  return { text, unit, approximate: value.approximate, status: value.status, reason };
}

export type DraftCheck = { ok: true; value: number } | { ok: false; message: string };

/** Decimal separator for `locale` ('.' or ','). */
export function decimalSeparator(locale?: string): string {
  return numberFormat(locale, {}).formatToParts(1.5).find(part => part.type === 'decimal')?.value === ',' ? ',' : '.';
}

/**
 * Parses a typed number without coercion: optional sign (including U+2212), digits, one decimal separator and an
 * optional exponent. Empty, partial or non-numeric drafts are rejected with a learner-safe explanation.
 */
export function parseDraft(draft: string, locale?: string): DraftCheck {
  const separator = decimalSeparator(locale);
  let text = draft.trim().replace(/−/g, '-');
  if (separator === ',' && !text.includes('.')) text = text.replace(',', '.');
  if (!text) return { ok: false, message: 'Enter a number.' };
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(text)) return { ok: false, message: `“${draft.trim().slice(0, 40)}” is not a number. Use digits, an optional minus sign and ${separator === ',' ? 'a decimal comma' : 'a decimal point'}.` };
  const value = Number(text);
  return Number.isFinite(value) ? { ok: true, value } : { ok: false, message: 'That number is too large to use.' };
}

/** Checks a typed value against the control's displayed range and integer rule; the draft itself is never altered. */
export function checkDraft(control: Pick<ProjectedControl, 'min' | 'max' | 'integer' | 'unitLabel'>, draft: string, locale?: string): DraftCheck {
  const parsed = parseDraft(draft, locale);
  if (!parsed.ok) return parsed;
  const unit = control.unitLabel ? ` ${control.unitLabel}` : '';
  if (control.integer && !Number.isInteger(parsed.value)) return { ok: false, message: 'Enter a whole number.' };
  if (parsed.value < control.min || parsed.value > control.max) {
    return { ok: false, message: `Enter a value from ${formatShown(control.min, locale)} to ${formatShown(control.max, locale)}${unit}. Values outside this range are not changed into a different experiment.` };
  }
  return parsed;
}
