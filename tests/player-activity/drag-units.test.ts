/** Physical drag displacements and keyboard alternatives agree with selected display-unit grids. */
import { describe, expect, it } from 'vitest';
import type { ProjectedControl } from '../../packages/activity/src/api';
import { dragAxisValue, dragControlStep, snapToStep } from '../../packages/player/src/activity/drag';

const control = (displayUnit: ProjectedControl['displayUnit'], step: number, integer = false) => ({ displayUnit, step, integer });

describe('point drags through canonical axes into display controls', () => {
  it('moves half a metre from a nonzero centimetre value, without treating metres as centimetres', () => {
    const cm = control('cm', 10);
    // The point starts at 1.25 m (125 cm). Half a metre right must end at 1.75 m (175 cm).
    expect(dragAxisValue(125, 0.5, 'm', cm, { min: 25, max: 325 }, false)).toBe(175);
    // A 27 cm displacement is snapped to the 25, 35, ... cm grid, then bounded in those same units.
    expect(dragAxisValue(125, 0.27, 'm', cm, { min: 25, max: 325 }, false)).toBe(155);
    expect(dragAxisValue(125, 10, 'm', cm, { min: 25, max: 325 }, false)).toBe(325);
    expect(dragAxisValue(125, -10, 'm', cm, { min: 25, max: 325 }, false)).toBe(25);
  });

  it('judges the untouched-axis threshold after conversion into the centimetre grid', () => {
    const cm = control('cm', 10), range = { min: 0, max: 300 };
    expect(dragAxisValue(100, 0.049, 'm', cm, range, false)).toBeNull(); // 4.9 cm < half a 10 cm step.
    expect(dragAxisValue(100, 0.06, 'm', cm, range, false)).toBe(110); // 6 cm activates and rounds to 10 cm.
    expect(dragAxisValue(100, 0, 'm', cm, range, false)).toBeNull();
    expect(dragAxisValue(100, 0, 'm', cm, range, true)).toBe(100); // Returning an already-moved axis to its press.
  });

  it('moves π/6 radians as 30 degrees, and snaps/bounds using the selected degree grid', () => {
    const deg = control('deg', 15), range = { min: -180, max: 180 };
    expect(dragAxisValue(30, Math.PI / 6, 'rad', deg, range, false)).toBe(60);
    expect(dragAxisValue(30, -Math.PI / 3, 'rad', deg, range, false)).toBe(-30);
    expect(dragAxisValue(30, Math.PI / 72, 'rad', deg, range, false)).toBeNull(); // 2.5° < 7.5° threshold.
    expect(dragAxisValue(30, Math.PI / 18, 'rad', deg, range, false)).toBe(45); // 10° rounds to one 15° step.
    expect(dragAxisValue(30, Math.PI, 'rad', deg, range, false)).toBe(180);
  });

  it('converts x and y independently and never changes an axis whose own threshold was not reached', () => {
    // x starts at 1.2 m displayed as 120 cm; y starts at 0.5 s displayed as 500 ms.
    const x = (delta: number) => dragAxisValue(120, delta, 'm', control('cm', 20), { min: 0, max: 200 }, false);
    const y = (delta: number) => dragAxisValue(500, delta, 's', control('ms', 50), { min: 100, max: 900 }, false);
    expect([x(0.26), y(-0.08)]).toEqual([140, 400]);
    expect([x(0.26), y(0.01)]).toEqual([140, null]);
    expect([x(2), y(-1)]).toEqual([200, 100]);
  });

  it('also handles a smaller selected display scale and preserves ordinary dimensionless dragging', () => {
    expect(dragAxisValue(1.2, 20, 'cm', control('m', 0.1), { min: 0, max: 2 }, false)).toBe(1.4);
    expect(dragAxisValue(0.4, 0.06, '', control('dimensionless', 0.1), { min: -1, max: 1 }, false)).toBe(0.5);
  });

  it('accepts supported unit IDs, compact symbols and plain labels from host-authored axes', () => {
    for (const label of ['m', 'metres']) expect(dragAxisValue(100, 0.06, label, control('cm', 10), { min: 0, max: 300 }, false)).toBe(110);
    for (const label of ['m/s^2', 'm/s²', 'metres per second squared'])
      expect(dragAxisValue(2, 1, label, control('m/s^2', 0.5), { min: 0, max: 10 }, false)).toBe(3);
  });

  it('does not reinterpret missing, unsupported or incompatible axis units, or nonfinite input', () => {
    const cm = control('cm', 10), range = { min: 0, max: 300 };
    for (const label of [undefined, 'unsupported-unit', 'rad']) expect(dragAxisValue(100, 1, label, cm, range, false)).toBeNull();
    expect(dragAxisValue(100, Infinity, 'm', cm, range, false)).toBeNull();
    expect(dragAxisValue(Number.NaN, 1, 'm', cm, range, false)).toBeNull();
  });
});

describe('keyboard steps on the same display grid', () => {
  it('takes one selected degree step without converting an already displayed keyboard displacement', () => {
    const step = dragControlStep(control('deg', 15), 'rad');
    expect(step).toBe(15);
    expect(snapToStep(30 + step, -180, 180, step)).toBe(45);
    expect(snapToStep(180 + step, -180, 180, step)).toBe(180);
  });

  it('keeps the canonical integer minimum in selected units rather than rounding display steps up to one', () => {
    const seconds = dragControlStep(control('s', 0.001, true), 'ms');
    expect(seconds).toBe(0.001); // One integer millisecond, displayed in seconds.
    expect(snapToStep(0.005 + seconds, 0, 0.01, seconds)).toBe(0.006);
    const milliseconds = dragControlStep(control('ms', 500, true), 's');
    expect(milliseconds).toBe(1000); // Canonical integer seconds cannot be changed by half a second.
    expect(snapToStep(1000 + milliseconds, 0, 3000, milliseconds)).toBe(2000);
  });
});
