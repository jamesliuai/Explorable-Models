/**
 * Units for the bundled activities only (report §8.3); this is not a universal unit engine. Every UnitId has one
 * dimension. `dimensionless` (an explicit pure number) and `iteration` (an iteration count/index) are distinct,
 * mutually incompatible dimensions; there is no "unspecified" unit.
 */
import type { DimensionId, UnitId } from './types.js';
import { fail } from './errors.js';

export interface UnitInfo {
  dimension: DimensionId;
  /** Multiply a value in this unit by this factor to obtain the dimension's base unit. */
  factorToBase: number;
  base: UnitId;
  /** Compact symbol shown next to numerals (empty for pure numbers). */
  label: string;
  /** Plain-language name for accessible text. */
  plainLabel: string;
}

// The annotation makes the table exhaustive over UnitId and rejects any additional key at compile time.
const UNIT_TABLE: Record<UnitId, UnitInfo> = {
  dimensionless: { dimension: 'dimensionless', factorToBase: 1, base: 'dimensionless', label: '', plainLabel: 'dimensionless' },
  iteration: { dimension: 'iteration', factorToBase: 1, base: 'iteration', label: 'iter', plainLabel: 'iterations' },
  m: { dimension: 'length', factorToBase: 1, base: 'm', label: 'm', plainLabel: 'metres' },
  cm: { dimension: 'length', factorToBase: 0.01, base: 'm', label: 'cm', plainLabel: 'centimetres' },
  mm: { dimension: 'length', factorToBase: 0.001, base: 'm', label: 'mm', plainLabel: 'millimetres' },
  s: { dimension: 'time', factorToBase: 1, base: 's', label: 's', plainLabel: 'seconds' },
  ms: { dimension: 'time', factorToBase: 0.001, base: 's', label: 'ms', plainLabel: 'milliseconds' },
  kg: { dimension: 'mass', factorToBase: 1, base: 'kg', label: 'kg', plainLabel: 'kilograms' },
  g: { dimension: 'mass', factorToBase: 0.001, base: 'kg', label: 'g', plainLabel: 'grams' },
  'm/s^2': { dimension: 'acceleration', factorToBase: 1, base: 'm/s^2', label: 'm/s²', plainLabel: 'metres per second squared' },
  N: { dimension: 'force', factorToBase: 1, base: 'N', label: 'N', plainLabel: 'newtons' },
  rad: { dimension: 'angle', factorToBase: 1, base: 'rad', label: 'rad', plainLabel: 'radians' },
  deg: { dimension: 'angle', factorToBase: Math.PI / 180, base: 'rad', label: '°', plainLabel: 'degrees' },
};
const BASE_TABLE: Record<DimensionId, UnitId> = {
  dimensionless: 'dimensionless', iteration: 'iteration', length: 'm', time: 's', mass: 'kg', acceleration: 'm/s^2', force: 'N', angle: 'rad',
};

export const UNITS: Readonly<Record<UnitId, Readonly<UnitInfo>>> = Object.freeze(Object.fromEntries(Object.entries(UNIT_TABLE).map(([id, info]) => [id, Object.freeze(info)])) as Record<UnitId, UnitInfo>);
export const DIMENSION_BASE_UNITS: Readonly<Record<DimensionId, UnitId>> = Object.freeze(BASE_TABLE);
export const UNIT_IDS: readonly UnitId[] = Object.freeze(Object.keys(UNIT_TABLE) as UnitId[]);
export const DIMENSION_IDS: readonly DimensionId[] = Object.freeze(Object.keys(BASE_TABLE) as DimensionId[]);

export const isUnitId = (value: unknown): value is UnitId => typeof value === 'string' && Object.hasOwn(UNIT_TABLE, value);
export const isDimensionId = (value: unknown): value is DimensionId => typeof value === 'string' && Object.hasOwn(BASE_TABLE, value);
export const dimensionOf = (unit: UnitId): DimensionId => UNITS[unit].dimension;
export const isCompatible = (a: UnitId, b: UnitId): boolean => isUnitId(a) && isUnitId(b) && UNITS[a].dimension === UNITS[b].dimension;
/** Compact label (default) or plain-language name. */
export const unitLabel = (unit: UnitId, plain = false): string => plain ? UNITS[unit].plainLabel : UNITS[unit].label;

/**
 * Converts between compatible units. Decimal prefixes use the exact integer ratio (for example cm→m divides by 100) so
 * conversions are correctly rounded; deg↔rad use π/180. Incompatible or unknown units and nonfinite values throw a
 * ModelError (`INVALID_INPUT`) rather than returning a fabricated number.
 */
export function convert(value: number, from: UnitId, to: UnitId): number {
  if (!isUnitId(from) || !isUnitId(to)) fail('INVALID_INPUT', '$.unit', 'Unknown unit.', 'Use a unit supported by the bundled activities.');
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('INVALID_INPUT', '$.value', 'Only finite numbers can be converted.');
  if (UNITS[from].dimension !== UNITS[to].dimension) fail('INVALID_INPUT', '$.unit', `Cannot convert ${UNITS[from].plainLabel} to ${UNITS[to].plainLabel}: the dimensions differ.`, 'Choose a display unit of the same dimension.');
  const a = UNITS[from].factorToBase, b = UNITS[to].factorToBase;
  if (a === b) return value;
  const ratio = a > b ? a / b : b / a, whole = Math.round(ratio);
  const exact = Math.abs(ratio - whole) <= 1e-9 * whole;
  const result = exact ? (a > b ? value * whole : value / whole) : value * a / b;
  if (!Number.isFinite(result)) fail('INVALID_INPUT', '$.value', 'The converted value is outside the representable range.');
  return result;
}
/** Diagnostic form of `convert` for callers that collect errors. */
export function conversionError(from: UnitId, to: UnitId): string | null {
  if (!isUnitId(from) || !isUnitId(to)) return 'Unknown unit.';
  return UNITS[from].dimension === UNITS[to].dimension ? null : `Cannot convert ${UNITS[from].plainLabel} to ${UNITS[to].plainLabel}.`;
}
