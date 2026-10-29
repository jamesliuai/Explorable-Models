/** Point drags move through canonical scene coordinates; controls and their step grids use selected display units. */
import type { ProjectedControl, ProjectedControlRef } from '@explorable-models/activity';
import { convert, isCompatible, UNIT_IDS, UNITS, type UnitId } from '@explorable-models/core/model';

type DragControl = Pick<ProjectedControl, 'step' | 'integer' | 'displayUnit'>;
type DragRange = Pick<ProjectedControlRef, 'min' | 'max'>;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
// Runtime projections use compact labels; host-authored projections may use supported IDs or plain-language labels.
const AXIS_UNITS = new Map<string, UnitId>(UNIT_IDS.flatMap(unit => [unit, UNITS[unit].label, UNITS[unit].plainLabel].map(label => [label, unit] as const)));
const axisUnit = (label: string | undefined): UnitId | undefined => label === undefined ? undefined : AXIS_UNITS.get(label);

/** Digits after the decimal point of a finite number as written (1e-7 → 7). */
const decimalsOf = (value: number): number => {
  const text = String(Math.abs(value));
  const exponent = /e-(\d+)$/.exec(text);
  if (exponent) return Number(exponent[1]) + (text.split('e')[0]!.split('.')[1]?.length ?? 0);
  return text.split('.')[1]?.length ?? 0;
};

/** Nearest value on the selected display-unit grid, anchored at the control minimum and clamped to its range. */
export function snapToStep(value: number, min: number, max: number, step: number): number {
  if (!(step > 0) || !Number.isFinite(value)) return clamp(value, min, max);
  const snapped = min + Math.round((value - min) / step) * step;
  return clamp(Number(snapped.toFixed(Math.min(15, Math.max(decimalsOf(step), decimalsOf(min))))), min, max);
}

/** An integer constraint is in canonical units; its minimum step must be converted too (1 ms = 0.001 s). */
export function dragControlStep(control: DragControl, canonicalAxisLabel: string | undefined): number {
  const canonical = axisUnit(canonicalAxisLabel);
  const integerStep = control.integer && canonical !== undefined && isCompatible(canonical, control.displayUnit)
    ? Math.abs(convert(1, canonical, control.displayUnit)) : 0;
  return Math.max(control.step, integerStep);
}

/**
 * A pointer displacement on one axis, added to its value at the press. Null leaves an axis untouched until it has
 * moved half a display step. Invalid/unknown unit metadata produces no update, rather than reinterpreting coordinates.
 */
export function dragAxisValue(
  start: number, canonicalDisplacement: number, canonicalAxisLabel: string | undefined,
  control: DragControl, range: DragRange, alreadyMoved: boolean,
): number | null {
  const canonical = axisUnit(canonicalAxisLabel);
  if (canonical === undefined || !isCompatible(canonical, control.displayUnit)
    || !Number.isFinite(start) || !Number.isFinite(canonicalDisplacement)) return null;
  let delta: number;
  try { delta = convert(canonicalDisplacement, canonical, control.displayUnit); } catch { return null; }
  const step = dragControlStep(control, canonicalAxisLabel);
  if (!alreadyMoved && Math.abs(delta) < (step > 0 ? step / 2 : 1e-9)) return null;
  return snapToStep(start + delta, range.min, range.max, step);
}
