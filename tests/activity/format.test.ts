import { describe, expect, it } from 'vitest';
import type { QuantityResult } from '../../packages/core/src/model/index.js';
import { formatNumber, formatQuantity } from '../../packages/activity/src/format.js';

describe('formatNumber', () => {
  it('never prints a tiny nonzero value as exact zero', () => {
    for (const value of [1e-20, -3e-9, Number.MIN_VALUE, 2.2250738585072014e-308, 9e-5]) {
      const text = formatNumber(value);
      expect(text, String(value)).not.toBe('0');
      expect(text, String(value)).toMatch(/× 10⁻/);
    }
    expect(formatNumber(1e-20)).toBe('1 × 10⁻²⁰');
    expect(formatNumber(Number.MIN_VALUE)).toBe('4.941 × 10⁻³²⁴');
    expect(formatNumber(0.00012346)).toBe('0.0001235');
    // Rounds to 1.000e-4 at 4 significant digits, which is inside the plain range.
    expect(formatNumber(9.99996e-5)).toBe('0.0001');
  });

  it('prints -0 and 0 as 0 and keeps the sign of other negatives', () => {
    expect(formatNumber(-0)).toBe('0');
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(-0.5)).toBe('-0.5');
  });

  it('uses significant digits, scientific notation at 1e7 and above, and the requested notation', () => {
    expect(formatNumber(1.5)).toBe('1.5');
    expect(formatNumber(2 / 3)).toBe('0.6667');
    expect(formatNumber(2 / 3, { precision: 2 })).toBe('0.67');
    expect(formatNumber(1234.5678)).toBe('1,235');
    expect(formatNumber(9_999_999)).toBe('1 × 10⁷');
    expect(formatNumber(12_345_678)).toBe('1.235 × 10⁷');
    expect(formatNumber(Number.MAX_VALUE)).toBe('1.798 × 10³⁰⁸');
    expect(formatNumber(1.234e-5, { notation: 'ascii' })).toBe('1.234e-5');
    expect(formatNumber(1.234e-5, { notation: 'tex' })).toBe('1.234 \\times 10^{-5}');
    expect(formatNumber(1234.5678, { notation: 'tex' })).toBe('1{,}235');
  });

  it('formats with the locale and falls back to en-US for an invalid locale', () => {
    expect(formatNumber(0.5, { locale: 'de-DE' })).toBe('0,5');
    expect(formatNumber(0.5, { locale: 'not a locale!' })).toBe('0.5');
  });

  it('rejects nonfinite numbers and invalid precision instead of inventing a numeral', () => {
    for (const value of [Number.NaN, Infinity, -Infinity]) expect(() => formatNumber(value)).toThrow(RangeError);
    for (const precision of [0, 22, 1.5]) expect(() => formatNumber(1, { precision })).toThrow(RangeError);
  });
});

describe('formatQuantity', () => {
  const never0 = (text: string) => { expect(text).not.toBe('0'); expect(text).not.toMatch(/^-?0(\D|$)/); };

  it('formats undefined and numerical-limit statuses as text, never as zero', () => {
    const undefinedResult: QuantityResult = { status: 'undefined', code: 'SECANT_UNDEFINED', reason: 'the secant needs two distinct points' };
    const undefinedText = formatQuantity(undefinedResult, { unit: 'dimensionless' });
    expect(undefinedText).toEqual({ text: 'Undefined: the secant needs two distinct points', display: 'Undefined: the secant needs two distinct points', status: 'undefined', approximate: false, unit: 'dimensionless', unitLabel: '', reason: 'the secant needs two distinct points' });
    expect(undefinedText.value).toBeUndefined();
    const overflow = formatQuantity({ status: 'numerical-limit', code: 'OVERFLOW', reason: 'the iterate exceeds the double range', lastFiniteIndex: 1023 }, { unit: 'dimensionless' });
    expect(overflow.text).toBe('Beyond numerical range (the iterate exceeds the double range); last finite index 1023');
    expect(overflow.status).toBe('numerical-limit');
    expect(overflow.value).toBeUndefined();
    const withoutIndex = formatQuantity({ status: 'numerical-limit', code: 'ITERATION_LIMIT', reason: 'iteration limit reached' }, { unit: 'iteration' });
    expect(withoutIndex.text).toBe('Beyond numerical range (iteration limit reached)');
    for (const item of [undefinedText, overflow, withoutIndex]) never0(item.text);
  });

  it('flags underflow approximations with ≈ and keeps significant digits', () => {
    const tiny = formatQuantity({ status: 'valid', value: 1e-310, approximation: { code: 'UNDERFLOW', reason: 'Subnormal value with reduced precision.' } }, { unit: 'dimensionless' });
    expect(tiny.text).toBe('≈ 1 × 10⁻³¹⁰');
    expect(tiny.approximate).toBe(true);
    expect(tiny.value).toBe(1e-310);
    // A subnormal display value is approximate even without an upstream flag.
    expect(formatQuantity({ status: 'valid', value: 3e-320 }, { unit: 'dimensionless' }).approximate).toBe(true);
    expect(formatQuantity({ status: 'valid', value: 3e-20 }, { unit: 'dimensionless' })).toMatchObject({ text: '3 × 10⁻²⁰', approximate: false });
  });

  it('converts radians to degrees and back at the display boundary', () => {
    const right = formatQuantity({ status: 'valid', value: Math.PI / 2 }, { unit: 'rad', displayUnit: 'deg' });
    expect(right.value).toBeCloseTo(90, 12);
    expect(right).toMatchObject({ text: '90', display: '90°', unit: 'deg', unitLabel: '°', status: 'valid' });
    const back = formatQuantity({ status: 'valid', value: 45 }, { unit: 'deg', displayUnit: 'rad' });
    expect(back.value).toBeCloseTo(Math.PI / 4, 14);
    expect(back.display).toBe('0.7854 rad');
    expect(formatQuantity({ status: 'valid', value: Math.PI / 6 }, { unit: 'rad' }).display).toBe('0.5236 rad');
  });

  it('converts metres and centimetres exactly, including vectors', () => {
    expect(formatQuantity({ status: 'valid', value: 0.25 }, { unit: 'm', displayUnit: 'cm' })).toMatchObject({ value: 25, text: '25', display: '25 cm' });
    expect(formatQuantity({ status: 'valid', value: 3 }, { unit: 'cm', displayUnit: 'm' })).toMatchObject({ value: 0.03, display: '0.03 m' });
    expect(formatQuantity({ status: 'valid', value: [1, -2.5] }, { unit: 'm', displayUnit: 'cm' })).toMatchObject({ value: [100, -250], text: '(100, -250)', display: '(100, -250) cm' });
    expect(formatQuantity({ status: 'valid', value: [0.5, 1.25] }, { unit: 'm', locale: 'de-DE' }).text).toBe('(0,5; 1,25)');
  });

  it('reports a value that leaves the double range in the display unit as a numerical limit', () => {
    const under = formatQuantity({ status: 'valid', value: Number.MIN_VALUE }, { unit: 'cm', displayUnit: 'm' });
    expect(under).toMatchObject({ status: 'numerical-limit', text: 'Beyond numerical range (the value is too small to represent in metres)' });
    const over = formatQuantity({ status: 'valid', value: 1e308 }, { unit: 'm', displayUnit: 'mm' });
    expect(over).toMatchObject({ status: 'numerical-limit', text: 'Beyond numerical range (the value exceeds the representable range in millimetres)' });
    for (const item of [under, over]) { never0(item.text); expect(item.value).toBeUndefined(); }
  });

  it('labels categories and rejects incompatible display units', () => {
    expect(formatQuantity({ status: 'valid', value: 'one-step' }, { unit: 'dimensionless', categoryLabels: { 'one-step': 'Reaches the minimum in one step' } }))
      .toEqual({ text: 'Reaches the minimum in one step', display: 'Reaches the minimum in one step', status: 'valid', approximate: false, value: 'one-step', unit: 'dimensionless', unitLabel: '' });
    expect(formatQuantity({ status: 'valid', value: 'oscillation' }, { unit: 'dimensionless' }).text).toBe('oscillation');
    expect(() => formatQuantity({ status: 'valid', value: 1 }, { unit: 'm', displayUnit: 'deg' })).toThrow(RangeError);
  });
});
