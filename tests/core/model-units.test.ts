import { describe, expect, it } from 'vitest';
import {
  conversionError, convert, DIMENSION_BASE_UNITS, DIMENSION_IDS, isCompatible, isUnitId, ModelError, MODEL_MANIFEST_SCHEMA, UNIT_IDS, UNITS, unitLabel, validateManifest,
  type UnitId,
} from '../../packages/core/src/model/index';
import { geometricManifest } from './support/model-fixtures';

const expectInvalid = (run: () => unknown) => { try { run(); } catch (error) { expect(error).toBeInstanceOf(ModelError); expect((error as ModelError).code).toBe('INVALID_INPUT'); return; } throw new Error('Expected a ModelError.'); };
const relative = (a: number, b: number) => a === b ? 0 : Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b));

describe('model units (report §8.3, A10)', () => {
  it('covers exactly the contract unit and dimension identifiers', () => {
    const units: UnitId[] = ['dimensionless', 'iteration', 'm', 'cm', 'mm', 's', 'ms', 'kg', 'g', 'm/s^2', 'N', 'rad', 'deg'];
    expect([...UNIT_IDS].sort()).toEqual([...units].sort());
    expect([...DIMENSION_IDS].sort()).toEqual(['acceleration', 'angle', 'dimensionless', 'force', 'iteration', 'length', 'mass', 'time']);
    for (const unit of UNIT_IDS) {
      const info = UNITS[unit];
      expect(DIMENSION_IDS).toContain(info.dimension);
      expect(UNITS[info.base].dimension).toBe(info.dimension);
      expect(UNITS[info.base].factorToBase).toBe(1);
      expect(DIMENSION_BASE_UNITS[info.dimension]).toBe(info.base);
      expect(info.plainLabel.length).toBeGreaterThan(0);
    }
    expect(Object.isFrozen(UNITS)).toBe(true);
    expect(Object.isFrozen(UNITS.deg)).toBe(true);
    // The manifest schema enumerates exactly the same identifiers.
    const unitEnum = (MODEL_MANIFEST_SCHEMA.properties!.parameters.additionalProperties as { properties: Record<string, { enum: string[] }> }).properties.unit.enum;
    expect([...unitEnum].sort()).toEqual([...units].sort());
  });

  it('converts decimal prefixes with exact integer ratios and angles through π/180', () => {
    expect(convert(1, 'm', 'cm')).toBe(100);
    expect(convert(250, 'cm', 'm')).toBe(2.5);
    expect(convert(3, 'cm', 'mm')).toBe(30);
    expect(convert(1500, 'ms', 's')).toBe(1.5);
    expect(convert(2, 'kg', 'g')).toBe(2000);
    expect(convert(250, 'g', 'kg')).toBe(0.25);
    expect(convert(180, 'deg', 'rad')).toBe(Math.PI);
    expect(convert(Math.PI / 2, 'rad', 'deg')).toBe(90);
    expect(convert(-45, 'deg', 'rad')).toBe(-Math.PI / 4);
    expect(convert(9.81, 'm/s^2', 'm/s^2')).toBe(9.81);
    expect(convert(0, 'deg', 'rad')).toBe(0);
  });

  it('round-trips every compatible pair within one rounding step', () => {
    const values = [0, 1, -1, 0.07, 123.456, -9.87654321e-3, 1e12, -2.5e-9, Math.PI];
    for (const from of UNIT_IDS) for (const to of UNIT_IDS) {
      if (!isCompatible(from, to)) continue;
      for (const value of values) expect(relative(convert(convert(value, from, to), to, from), value)).toBeLessThanOrEqual(4.5e-16);
    }
  });

  it('rejects incompatible dimensions, unknown units and nonfinite values instead of fabricating numbers', () => {
    expectInvalid(() => convert(1, 'm', 's'));
    expectInvalid(() => convert(1, 'rad', 'dimensionless'));
    expectInvalid(() => convert(1, 'N', 'kg'));
    expectInvalid(() => convert(1, 'm' as UnitId, 'ft' as UnitId));
    expectInvalid(() => convert(Number.NaN, 'm', 'cm'));
    expectInvalid(() => convert(Number.POSITIVE_INFINITY, 'm', 'cm'));
    expectInvalid(() => convert(1e308, 'm', 'mm'));
    expect(conversionError('m', 's')).toMatch(/metres to seconds/);
    expect(conversionError('cm', 'm')).toBeNull();
  });

  it('keeps explicit dimensionless distinct from iteration counts, with no unspecified unit', () => {
    expect(isCompatible('dimensionless', 'iteration')).toBe(false);
    expectInvalid(() => convert(3, 'iteration', 'dimensionless'));
    expect(isCompatible('deg', 'rad')).toBe(true);
    expect(isUnitId('unspecified')).toBe(false);
    expect(isUnitId('')).toBe(false);
    // A manifest cannot omit a unit or declare a free-form unit string.
    const missing = geometricManifest() as unknown as { parameters: { eta: Record<string, unknown> } };
    delete missing.parameters.eta.unit;
    expect(() => validateManifest(missing)).toThrow(/Required field is missing/);
    const freeForm = geometricManifest() as unknown as { parameters: { eta: Record<string, unknown> } };
    freeForm.parameters.eta.unit = 'furlongs';
    expect(() => validateManifest(freeForm)).toThrow(ModelError);
    // A declared unit must belong to the declared dimension.
    const mismatch = geometricManifest();
    mismatch.parameters.x0.unit = 's';
    expect(() => validateManifest(mismatch)).toThrow(/Unit does not match the declared dimension/);
  });

  it('labels units compactly and in plain language', () => {
    expect(unitLabel('m/s^2')).toBe('m/s²');
    expect(unitLabel('m/s^2', true)).toBe('metres per second squared');
    expect(unitLabel('deg')).toBe('°');
    expect(unitLabel('dimensionless')).toBe('');
    expect(unitLabel('iteration', true)).toBe('iterations');
  });
});
