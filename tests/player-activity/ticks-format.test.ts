import { describe, expect, it } from 'vitest';
import type { ProjectedValue } from '../../packages/activity/src/api';
import { checkDraft, decimalsFor, formatPlain, formatPosition, formatScientific, formatTick, MINUS, parseDraft, valueDisplay } from '../../packages/player/src/activity/format';
import {
  authoredCamera, cameraDomain, CAMERA_LIMITS, clampCamera, clipSegment, fitCamera, fitFrame, fitTicks, niceStep, niceTicks, panCamera, plotHeight, zoomCamera,
} from '../../packages/player/src/activity/scale';

const value = (extra: Partial<ProjectedValue>): ProjectedValue => ({ quantityId: 'q', label: 'Q', text: '1', status: 'valid', approximate: false, unit: 'dimensionless', unitLabel: '', ...extra });

describe('nice ticks (report §10.2 useful ticks)', () => {
  it('uses the 1–2–2.5–5 family and never exceeds the requested interval count', () => {
    expect(niceStep(20, 7)).toBe(5);
    expect(niceStep(20, 10)).toBe(2);
    expect(niceStep(10, 4)).toBe(2.5);
    expect(niceStep(1e-12, 5)).toBeCloseTo(2e-13, 25);
    for (const [min, max, n] of [[-10, 10, 6], [0, 1000, 5], [-1e-12, 3e-12, 4], [0.1, 0.35, 5], [-5, 105, 8]] as const) {
      const { ticks, step } = niceTicks(min, max, n);
      expect(ticks.length).toBeGreaterThan(0);
      expect(ticks.length - 1).toBeLessThanOrEqual(2 * n);
      expect(ticks[0]).toBeGreaterThanOrEqual(min - step * 1e-6);
      expect(ticks[ticks.length - 1]).toBeLessThanOrEqual(max + step * 1e-6);
      for (let i = 1; i < ticks.length; i++) expect(ticks[i] - ticks[i - 1]).toBeCloseTo(step, 10);
    }
  });

  it('cleans binary noise and negative zero, and rejects empty or invalid ranges', () => {
    expect(niceTicks(-0.3, 0.3, 6).ticks).toEqual([-0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3]);
    expect(Object.is(niceTicks(-1, 1, 2).ticks[1], -0)).toBe(false);
    expect(niceTicks(1, 1, 5).ticks).toEqual([]);
    expect(niceTicks(Number.NaN, 1, 5).ticks).toEqual([]);
    expect(niceTicks(0, Infinity, 5).ticks).toEqual([]);
  });

  it('fits ticks to the width their labels actually need (a 2.5 step needs decimals)', () => {
    const label = (charWidth: number) => (ticks: number[], step: number) => Math.max(...ticks.map(t => [...formatTick(t, step)].length)) * charWidth;
    expect(fitTicks(-10, 10, 254, label(5.7), 12).step).toBe(5);
    expect(fitTicks(-10, 10, 900, label(5.7), 12).step).toBe(2);
    expect(fitTicks(-10, 10, 60, label(5.7), 12).ticks.length).toBeGreaterThan(0);
  });
});

describe('tick and readout formatting', () => {
  it('writes exactly the decimals a step needs, with a true minus sign', () => {
    expect(decimalsFor(0.25)).toBe(2);
    expect(decimalsFor(5)).toBe(0);
    expect(formatTick(-7.5, 2.5, 'en')).toBe(`${MINUS}7.5`);
    expect(formatTick(-10, 2.5, 'en')).toBe(`${MINUS}10.0`);
    expect(formatTick(0, 2.5, 'en')).toBe('0');
    expect(formatTick(1e-17, 0.5, 'en')).toBe('0');
  });

  it('keeps tiny and huge ticks distinguishable with scientific notation (never rounds a nonzero to 0)', () => {
    expect(formatTick(1e-12, 5e-13, 'en')).toBe('10⁻¹²');
    expect(formatTick(-1e-12, 5e-13, 'en')).toBe(`${MINUS}10⁻¹²`);
    expect(formatTick(1.5e-12, 5e-13, 'en')).toBe('1.5×10⁻¹²');
    expect(formatTick(2e7, 5e6, 'en')).toBe('2×10⁷');
    expect(formatScientific(9.99e5, 1, 'en')).toBe('10⁶');
    expect(formatScientific(-2.5e-7, 2, 'en')).toBe(`${MINUS}2.5×10⁻⁷`);
    expect(formatPlain(1.25e-12, 'en')).toBe('1.25×10⁻¹²');
    expect(formatPlain(-13.5, 'en')).toBe(`${MINUS}13.5`);
    expect(formatPlain(Number.NaN)).toBe('');
  });

  it('shows the discrete index as a whole number, never fractional', () => {
    expect(formatPosition({ kind: 'index', value: 3, max: 1000 })).toBe('n = 3 of 1000');
    expect(formatPosition({ kind: 'index', value: 3.6, max: 1000 })).toBe('n = 3 of 1000');
    expect(formatPosition({ kind: 'index', value: 0, max: null })).toBe('n = 0');
    expect(formatPosition({ kind: 'time', value: 1.25, max: 10 }, 'en')).toBe('t = 1.25 of 10');
  });
});

describe('value display passes projection text through (A11, D10)', () => {
  it('shows the projection text verbatim and appends a unit only when it is missing', () => {
    expect(valueDisplay(value({ text: '0.5', unitLabel: 'm' }))).toMatchObject({ text: '0.5', unit: 'm' });
    expect(valueDisplay(value({ text: '0.5 m', unitLabel: 'm' }))).toMatchObject({ text: '0.5 m', unit: '' });
    expect(valueDisplay(value({ text: '1.25×10⁻¹²', approximate: true }))).toMatchObject({ text: '1.25×10⁻¹²', approximate: true });
  });

  it('keeps undefined and limit states as text with their reasons, never a zero', () => {
    const undefinedValue = valueDisplay(value({ text: 'Undefined', status: 'undefined', unitLabel: 'm', reason: 'h = 0: the secant has no slope' }));
    expect(undefinedValue).toEqual({ text: 'Undefined', unit: '', approximate: false, status: 'undefined', reason: 'h = 0: the secant has no slope' });
    expect(valueDisplay(value({ text: 'Too large to represent', status: 'numerical-limit', reason: 'overflow after n = 36' })).text).not.toMatch(/^0$/);
  });
});

describe('exact entry drafts (A33)', () => {
  it('parses plain numbers including a typographic minus and rejects everything else without coercion', () => {
    expect(parseDraft(' −2.5 ')).toEqual({ ok: true, value: -2.5 });
    expect(parseDraft('1e-3')).toEqual({ ok: true, value: 0.001 });
    expect(parseDraft('.5')).toEqual({ ok: true, value: 0.5 });
    for (const bad of ['', '1..2', '0x10', 'Infinity', 'NaN', '1,000', '2 3', 'abc']) expect(parseDraft(bad).ok).toBe(false);
    expect(parseDraft('1e400')).toEqual({ ok: false, message: 'That number is too large to use.' });
    expect(parseDraft('0,25', 'de-DE')).toEqual({ ok: true, value: 0.25 });
  });

  it('explains range and integer violations without altering the draft', () => {
    const control = { min: 0, max: 2, integer: false, unitLabel: '' };
    expect(checkDraft(control, '0.75')).toEqual({ ok: true, value: 0.75 });
    const outside = checkDraft(control, '2.5');
    expect(outside.ok).toBe(false);
    if (!outside.ok) expect(outside.message).toContain('from 0 to 2');
    expect(checkDraft({ ...control, integer: true, max: 10 }, '3.5')).toEqual({ ok: false, message: 'Enter a whole number.' });
  });
});

describe('camera and view domain (presentation only)', () => {
  const bounds: [number, number, number, number] = [-10, 10, -5, 105];
  it('maps null to the authored bounds and zooms about a fixed focus', () => {
    expect(cameraDomain(bounds, null)).toEqual(bounds);
    expect(cameraDomain(bounds, authoredCamera(bounds))).toEqual(bounds);
    const zoomed = zoomCamera(bounds, null, 2, [5, 50]);
    const domain = cameraDomain(bounds, zoomed);
    // The focus keeps its relative position in the visible domain.
    expect((5 - domain[0]) / (domain[1] - domain[0])).toBeCloseTo((5 - bounds[0]) / (bounds[1] - bounds[0]), 12);
    expect(domain[1] - domain[0]).toBeCloseTo(10, 12);
  });

  it('pans by fractions of the visible span and clamps zoom/centre to the presentation schema limits', () => {
    const panned = panCamera(bounds, null, CAMERA_LIMITS.panFraction, 0);
    expect(panned.center[0]).toBeCloseTo(2, 12);
    expect(clampCamera({ kind: '2d', center: [1e20, Number.NaN], zoom: 1e9 })).toEqual({ kind: '2d', center: [1e15, 0], zoom: 1e6 });
    expect(clampCamera({ kind: '2d', center: [0, 0], zoom: 0 }).zoom).toBe(1e-6);
  });

  it('fits explicitly to a data extent, including a single point', () => {
    const fit = fitCamera(bounds, [-30, 30, 0, 450]);
    const domain = cameraDomain(bounds, fit);
    expect(domain[0]).toBeLessThanOrEqual(-30);
    expect(domain[1]).toBeGreaterThanOrEqual(30);
    expect(domain[3]).toBeGreaterThanOrEqual(450);
    expect(fitCamera(bounds, [3, 3, 7, 7])).toEqual({ kind: '2d', center: [3, 7], zoom: 1 });
  });

  it('keeps equal aspect by expanding the domain, and maps y upwards', () => {
    const frame = fitFrame([-4, 4, -3, 3], { x: 10, y: 20, width: 400, height: 200 }, true);
    expect(frame.scaleX).toBe(frame.scaleY);
    expect(frame.domain[3] - frame.domain[2]).toBeCloseTo(6, 12);
    expect(frame.domain[1] - frame.domain[0]).toBeCloseTo(12, 12);
    expect(frame.toScreen(0, 0)).toEqual([210, 120]);
    expect(frame.toScreen(0, 3)[1]).toBeLessThan(frame.toScreen(0, 0)[1]);
    const [x, y] = frame.fromScreen(...frame.toScreen(1.5, -2));
    expect(x).toBeCloseTo(1.5, 12); expect(y).toBeCloseTo(-2, 12);
    expect(plotHeight(300, [-4, 4, -3, 3], true, 15)).toBe(225);
  });

  it('clips segments in data space so huge coordinates never reach the SVG', () => {
    expect(clipSegment([0, 0], [1e300, 1e300], [-1, 1, -1, 1])).toEqual([[0, 0], [1, 1]]);
    expect(clipSegment([2, 2], [3, 3], [-1, 1, -1, 1])).toBeNull();
    expect(clipSegment([-5, 0], [5, 0], [-1, 1, -1, 1])).toEqual([[-1, 0], [1, 0]]);
  });
});
