import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { evaluateRequest, ModelError, validateKernelOutput, type GeometryResult, type KernelOutput, type QuantityResult } from '@experiment-kit/core/model';
import { FUNCTION_DERIVATIVE_CURVE, FUNCTION_DERIVATIVE_DOMAIN, functionDerivativeKernel as kernel } from '../../../packages/catalog/src/kernels/function-derivative';
import { functionDerivativeManifest as manifest } from '../../../packages/catalog/src/models/function-derivative';
import fixtureJson from '../fixtures/activities/function-derivative.json';
import {
  curveValue, derivativeCurveValue, exactValue, integer, minus, nearestDouble, oracleMismatches, plus, same, sampleX, secantSlope, slopeAt, times,
  QUANTITY_IDS, type Expected, type Fixture, type FixtureCase, type FunctionParams,
} from '../oracles/function-derivative';

// Independent acceptance cases for report §12.1 (A28, A30). The fixture and its oracle live outside the catalogue;
// no independent human subject reviewer has approved them.
const fixture = fixtureJson as unknown as Fixture;
type Evaluate = (params: FunctionParams) => KernelOutput;
type Tolerance = FixtureCase['tolerance'];
const admissible = fixture.cases.filter(entry => entry.expected);
const byId = (id: string): FixtureCase => fixture.cases.find(entry => entry.id === id)!;

const show = (value: unknown): string => JSON.stringify(value);
const within = (observed: unknown, expected: number, tolerance: Tolerance): boolean =>
  typeof observed === 'number' && Number.isFinite(observed) && Math.abs(observed - expected) <= tolerance.absolute + tolerance.relative * Math.abs(expected);
const scalar = (result: QuantityResult | undefined): unknown => (result?.status === 'valid' ? result.value : undefined);
const X = Array.from({ length: FUNCTION_DERIVATIVE_CURVE.samples }, (_, i) => sampleX(i));

function quantityProblem(result: QuantityResult | undefined, expected: Expected, tolerance: Tolerance): string | null {
  const ok = !result ? false
    : typeof expected === 'number' ? result.status === 'valid' && !result.approximation && within(result.value, expected, tolerance)
      : typeof expected === 'string' ? result.status === 'valid' && result.value === expected
        : 'undefined' in expected ? result.status === 'undefined' && result.code === expected.undefined && result.reason.length > 0
          : 'limit' in expected ? result.status === 'numerical-limit' && result.code === expected.limit && result.reason.length > 0
            : result.status === 'valid' && result.approximation?.code === 'UNDERFLOW' && within(result.value, expected.subnormal, tolerance);
  return ok ? null : `${show(result)}, expected ${show(expected)}`;
}
/** A points2 geometry holding exactly one point bound to the frame's own quantities (or a gap with a reason). */
function pointProblem(geometry: GeometryResult | undefined, id: string, x: QuantityResult | undefined, y: QuantityResult | undefined): string | null {
  if (geometry?.kind !== 'points2' || geometry.points.length !== 1) return `${show(geometry)} is not exactly one point`;
  const point = geometry.points[0]!, keys = Object.keys(point).sort().join();
  const vx = scalar(x), vy = scalar(y);
  if (typeof vx === 'number' && typeof vy === 'number')
    return keys === 'at,id' && point.id === id && point.at !== null && Object.is(point.at[0], vx) && Object.is(point.at[1], vy) ? null : `${show(point)}, expected ${id} at ${show([vx, vy])}`;
  return keys === 'at,id,reason' && point.id === id && point.at === null && !!point.reason ? null : `${show(point)}, expected ${id} as a gap with a reason`;
}
/** A segments2 geometry with no segment (empty expectation) or one segment from x = −5 to x = 5. */
function lineProblem(geometry: GeometryResult | undefined, id: string, expected: [number, number][], tolerance: Tolerance): string | null {
  if (geometry?.kind !== 'segments2') return `${show(geometry)} is not segments2`;
  if (!expected.length) return geometry.segments.length === 0 ? null : `${geometry.segments.length} segments where none may be drawn`;
  const segment = geometry.segments[0];
  const ok = geometry.segments.length === 1 && !!segment && Object.keys(segment).sort().join() === 'from,id,to' && segment.id === id
    && segment.from[0] === expected[0]![0] && segment.to[0] === expected[1]![0] && within(segment.from[1], expected[0]![1], tolerance) && within(segment.to[1], expected[1]![1], tolerance);
  return ok ? null : `${show(geometry.segments)}, expected ${show(expected)}`;
}
/** A polyline2 of the 401 declared samples whose values lie within the sampling tolerance of the oracle. */
function curveProblem(geometry: GeometryResult | undefined, values: number[]): string | null {
  if (geometry?.kind !== 'polyline2') return `${show(geometry?.kind)} is not polyline2`;
  if (show(geometry.sampling) !== show({ samples: fixture.sampling.samples, domain: fixture.sampling.domain }) || geometry.gaps.length || geometry.segments.length !== 1) return 'wrong sampling, gaps or segments';
  const segment = geometry.segments[0]!;
  if (segment.start !== 'none' || segment.end !== 'none' || segment.points.length !== X.length) return `${segment.points.length} samples`;
  const bad = segment.points.findIndex((point, i) => !Object.is(point[0], X[i]) || !within(point[1], values[i]!, fixture.sampling.tolerance));
  return bad < 0 ? null : `sample ${bad} is ${show(segment.points[bad])}, expected ${show([X[bad], values[bad]])}`;
}

const curveCache = new Map<string, { f: number[]; derivative: number[] }>();
/** Oracle values of both curves at the declared samples (cached per parameter set). */
function oracleCurves(params: FunctionParams) {
  const key = show(params);
  if (!curveCache.has(key)) curveCache.set(key, {
    f: X.map((_, i) => nearestDouble(curveValue(params, i)) + 0),
    derivative: X.map((_, i) => nearestDouble(derivativeCurveValue(params, i)) + 0),
  });
  return curveCache.get(key)!;
}

/** Every disagreement between an evaluator and one fixture case; an empty list means the case passes. */
function compareCase(entry: FixtureCase, evaluate: Evaluate): string[] {
  let output: KernelOutput;
  try { output = evaluate(entry.params); } catch { return entry.rejected ? [] : ['evaluation failed for admissible parameters']; }
  if (entry.rejected) return [`accepted parameters that must be rejected with ${entry.rejected.code}`];
  const problems: string[] = [];
  try { validateKernelOutput(manifest, { kind: 'static' }, output); } catch (error) { problems.push(`frame rejected: ${(error as ModelError).diagnostics?.[0]?.message ?? String(error)}`); }
  const q = output.quantities, g = output.geometry;
  if (Object.keys(q).sort().join() !== [...QUANTITY_IDS].sort().join()) problems.push(`quantities ${Object.keys(q).sort().join()}`);
  for (const id of QUANTITY_IDS) {
    const problem = quantityProblem(q[id], entry.expected![id], entry.tolerance);
    if (problem) problems.push(`${id}: ${problem}`);
  }
  const curves = oracleCurves(entry.params);
  const geometry: [string, string | null][] = [
    ['curve', curveProblem(g.curve, curves.f)],
    ['derivative-curve', curveProblem(g['derivative-curve'], curves.derivative)],
    ['probe', pointProblem(g.probe, 'P', q['probe.x'], q['probe.value'])],
    ['second', pointProblem(g.second, 'Q', q['second.x'], q['second.value'])],
    ['derivative-probe', pointProblem(g['derivative-probe'], 'P', q['probe.x'], q.derivative)],
    ['tangent', lineProblem(g.tangent, 'tangent', entry.lines!.tangent, entry.tolerance)],
    ['secant', lineProblem(g.secant, 'secant', entry.lines!.secant, entry.tolerance)],
  ];
  for (const [id, problem] of geometry) if (problem) problems.push(`geometry ${id}: ${problem}`);
  if (output.terminal !== undefined && show(output.terminal) !== show({ reached: false })) problems.push('a static frame has no terminal event');
  return problems;
}
const compareSuite = (evaluate: Evaluate): { id: string; problems: string[] }[] =>
  fixture.cases.map(entry => ({ id: entry.id, problems: compareCase(entry, evaluate) })).filter(result => result.problems.length);

/** The worker's evaluation path in-process: manifest, parameter and constraint validation, kernel, then frame validation. */
const installed: Evaluate = params => {
  const { quantities, geometry, terminal } = evaluateRequest({ manifest, params, position: { kind: 'static' } }, [kernel]);
  return { quantities, geometry, terminal };
};
const direct: Evaluate = params => kernel.evaluate({ params, index: 0 });

/** Hand-derived values (fixture order: f(p), f′(p), p + h, f(p + h), secant slope, difference, sign, curvature, vertex). */
const COINCIDENT = { undefined: 'COINCIDENT_POINTS' }, NO_VERTEX = { undefined: 'NO_VERTEX' };
const HAND: Record<string, Expected[]> = {
  defaults: [-1.25, -1, 0, -2, -0.75, 0.25, 'decreasing', 'positive-curvature', 1], // 0.25 + 0.5 − 2; −0.5 − 0.5; f(0) = −2; (−2 + 1.25)/1
  'positive-curvature': [0, 4, 4, 5, 5, 1, 'increasing', 'positive-curvature', 1], // 9 − 6 − 3; 6 − 2; 16 − 8 − 3; (5 − 0)/1
  'negative-curvature': [1, -2, 1, 2, -1, 1, 'decreasing', 'negative-curvature', 1], // −4 + 4 + 1; −4 + 2; −1 + 2 + 1; (2 − 1)/(−1)
  linear: [0.5, 1.5, 1.5, 1.25, 1.5, 0, 'increasing', 'linear', NO_VERTEX], // 1.5 − 1; 2.25 − 1; (1.25 − 0.5)/0.5
  'linear-decreasing': [9, -2, -2, 5, -2, 0, 'decreasing', 'linear', NO_VERTEX], // 8 + 1; 4 + 1; (5 − 9)/2
  constant: [2, 0, -2, 2, 0, 0, 'stationary', 'constant', NO_VERTEX],
  'constant-coincident': [-5, 0, 0, -5, COINCIDENT, COINCIDENT, 'stationary', 'constant', NO_VERTEX],
  'zero-slope-at-vertex': [-2.5, 0, 2, -2, 0.5, 0.5, 'stationary', 'positive-curvature', 1], // 0.5 − 1 − 2; 1 − 1; 2 − 2 − 2
  'zero-slope-at-vertex-downward': [2, 0, 0.5, 1.5, 1, 1, 'stationary', 'negative-curvature', 1], // −2 + 4; −4 + 4; −0.5 + 2; (1.5 − 2)/(−0.5)
  'secant-h-1': [-2, 1, 3, -0.5, 1.5, 0.5, 'increasing', 'positive-curvature', 1], // 2 − 2 − 2; 4.5 − 3 − 2
  'coincident-h-0': [-2, 1, 2, -2, COINCIDENT, COINCIDENT, 'increasing', 'positive-curvature', 1],
  'coincident-at-vertex': [-2.5, 0, 1, -2.5, COINCIDENT, COINCIDENT, 'stationary', 'positive-curvature', 1],
  'sign-before-vertex': [-3.75, -1, 0.75, -3.9375, -0.75, 0.25, 'decreasing', 'positive-curvature', 1], // 0.5625 − 1.5 − 3; −0.1875/0.25
  'sign-at-vertex': [-4, 0, 1.25, -3.9375, 0.25, 0.25, 'stationary', 'positive-curvature', 1], // 1.5625 − 2.5 − 3; 0.0625/0.25
  'sign-after-vertex': [-3.75, 1, 1.75, -3.4375, 1.25, 0.25, 'increasing', 'positive-curvature', 1], // 3.0625 − 3.5 − 3; 0.3125/0.25
  'sign-before-vertex-downward': [3, 1, -1.5, 3.375, 0.75, -0.25, 'increasing', 'negative-curvature', -1], // −2 + 2 + 3; −1.125 + 1.5 + 3
  'sign-after-vertex-downward': [3, -1, 0.5, 2.375, -1.25, -0.25, 'decreasing', 'negative-curvature', -1], // −0.125 − 0.5 + 3; −0.625/0.5
  'probe-right-boundary': [12, 8, 4, 5, 7, -1, 'increasing', 'positive-curvature', 1], // 25 − 10 − 3; 16 − 8 − 3; (5 − 12)/(−1)
  'probe-left-boundary': [32, -12, -3, 12, -10, 2, 'decreasing', 'positive-curvature', 1], // 25 + 10 − 3; 9 + 6 − 3; (12 − 32)/2
  'second-right-boundary': [0, 4, 5, 12, 6, 2, 'increasing', 'positive-curvature', 1],
  'second-left-boundary': [12, -8, -5, 32, -10, -2, 'decreasing', 'positive-curvature', 1], // (32 − 12)/(−2)
  'coincident-at-boundary': [12, 8, 5, 12, COINCIDENT, COINCIDENT, 'increasing', 'positive-curvature', 1],
  'corner-values-high': [30, -15, -3, 8, -11, 4, 'decreasing', 'positive-curvature', -1.25], // 50 − 25 + 5; −20 + 5; 18 − 15 + 5; −5/4
  'corner-values-low': [-80, -25, 3, -38, -21, 4, 'decreasing', 'negative-curvature', -1.25], // −50 − 25 − 5; −18 − 15 − 5; 42/(−2)
};
const HAND_QUANTITIES = QUANTITY_IDS.filter(id => id !== 'probe.x');

describe('function-derivative reference fixture (report §12.1)', () => {
  it('is a well-formed suite for the manifest with declared provenance and tolerances', () => {
    expect(fixture.suiteId).toBe(manifest.referenceSuite?.suiteId);
    expect(fixture.model).toEqual({ modelId: manifest.modelId, version: manifest.version });
    for (const [id, definition] of Object.entries(manifest.parameters)) expect(fixture.domain[id as keyof Fixture['domain']], id).toEqual([definition.min, definition.max]);
    expect(fixture.domain).toEqual(FUNCTION_DERIVATIVE_DOMAIN);
    expect([manifest.constraints[0]!.min, manifest.constraints[0]!.max]).toEqual(fixture.domain.x);
    expect({ samples: fixture.sampling.samples, domain: fixture.sampling.domain }).toEqual({ samples: FUNCTION_DERIVATIVE_CURVE.samples, domain: [...FUNCTION_DERIVATIVE_CURVE.domain] });
    expect(fixture.sampling.samples).toBe(manifest.geometry.curve!.maxElements);
    expect(new Set(fixture.cases.map(entry => entry.id)).size).toBe(fixture.cases.length);
    for (const entry of fixture.cases) {
      expect(entry.provenance.length, entry.id).toBeGreaterThan(20);
      expect(entry.families.length, entry.id).toBeGreaterThan(0);
      expect(Boolean(entry.expected) !== Boolean(entry.rejected), entry.id).toBe(true);
      expect(entry.tolerance.absolute, entry.id).toBeGreaterThanOrEqual(0);
      expect(entry.tolerance.relative, entry.id).toBeGreaterThanOrEqual(0);
      expect(entry.tolerance.relative, entry.id).toBeLessThanOrEqual(1e-12);
    }
  });

  it('covers every mandatory §12.1 case family', () => {
    const families = new Set(fixture.cases.flatMap(entry => entry.families));
    for (const family of ['positive-curvature', 'negative-curvature', 'linear', 'constant', 'zero-slope', 'secant-approach', 'coincident', 'sign-change', 'domain-boundary', 'outside'])
      expect(families.has(family), family).toBe(true);
    const valueOf = (entry: FixtureCase, id: (typeof QUANTITY_IDS)[number]) => entry.expected?.[id];
    // Linear and constant degeneracies: A = 0 with B ≠ 0 and B = 0; constant slope 0 everywhere.
    expect(admissible.some(entry => entry.params.A === 0 && entry.params.B !== 0 && valueOf(entry, 'curvature') === 'linear')).toBe(true);
    for (const entry of admissible.filter(entry => entry.families.includes('constant'))) {
      expect(entry.params.A === 0 && entry.params.B === 0, entry.id).toBe(true);
      expect([valueOf(entry, 'derivative'), valueOf(entry, 'curvature')], entry.id).toEqual([0, 'constant']);
    }
    // Secant points approaching the probe from both sides, with h = 1, 0.1, 0.001 and −0.001 for one probe.
    const approach = admissible.filter(entry => entry.id.startsWith('secant-h-'));
    expect(approach.map(entry => entry.params.h)).toEqual([1, 0.1, 0.001, -0.001]);
    expect(new Set(approach.map(entry => show({ ...entry.params, h: 0 }))).size).toBe(1);
    // Coincident points, zero slope at a vertex, and a sign change across one vertex.
    expect(admissible.filter(entry => entry.params.h === 0).every(entry => show(valueOf(entry, 'secant.slope')) === show(COINCIDENT))).toBe(true);
    expect(admissible.some(entry => entry.params.h === 0 && valueOf(entry, 'derivative') === 0)).toBe(true);
    expect(admissible.filter(entry => entry.id.startsWith('sign-') && !entry.id.endsWith('downward')).map(entry => valueOf(entry, 'slope.sign'))).toEqual(['decreasing', 'stationary', 'increasing']);
    // Domain boundaries for p and for p + h on both sides, and rejection outside.
    const sum = (entry: FixtureCase) => entry.params.p + entry.params.h;
    for (const edge of [-5, 5]) {
      expect(admissible.some(entry => entry.params.p === edge), `p = ${edge}`).toBe(true);
      expect(admissible.some(entry => sum(entry) === edge && entry.params.h !== 0), `p + h = ${edge}`).toBe(true);
      expect(fixture.cases.some(entry => entry.rejected?.code === 'CONSTRAINT_VIOLATION' && Math.sign(sum(entry)) === Math.sign(edge)), `outside ${edge}`).toBe(true);
    }
  });

  it('agrees with values derived by hand', () => {
    for (const [id, values] of Object.entries(HAND)) {
      const entry = byId(id);
      expect(entry.tolerance, id).toEqual({ absolute: 0, relative: 0 });
      expect(HAND_QUANTITIES.map(quantity => entry.expected![quantity]), id).toEqual(values);
      expect(entry.expected!['probe.x'], id).toBe(entry.params.p);
    }
    // Lines by hand: tangent y = 4(x − 3) and secant y = 5(x − 3) for f(x) = x² − 2x − 3 at p = 3, h = 1.
    expect(byId('positive-curvature').lines).toEqual({ tangent: [[-5, -32], [5, 8]], secant: [[-5, -40], [5, 10]] });
    expect(byId('coincident-h-0').lines).toEqual({ tangent: [[-5, -9], [5, 1]], secant: [] });
    // f′(p) = 3·fl(−1/3) + 1 = 2^−54 exactly at the double nearest −1/3: increasing, not stationary.
    expect(byId('probe-near-non-dyadic-vertex').expected).toMatchObject({ derivative: 2 ** -54, 'slope.sign': 'increasing' });
  });

  it('(a) agrees exactly with the independent rational oracle', () => {
    const mismatches = fixture.cases.map(entry => ({ id: entry.id, problems: oracleMismatches(entry) })).filter(result => result.problems.length);
    expect(mismatches).toEqual([]);
  });

  it('the oracle is independent of catalogue and model code, and its primitives are exact', () => {
    const source = readFileSync(fileURLToPath(new URL('../oracles/function-derivative.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/^\s*(import|export)\s[^;]*\sfrom\s|^\s*import\s|\bimport\(|\brequire\(/m);
    expect(same(exactValue(0.1), { n: 3602879701896397n, d: 2n ** 55n })).toBe(true);
    expect(same(exactValue(5e-324), { n: 1n, d: 2n ** 1074n })).toBe(true);
    for (const value of [0.1, -1 / 3, 5e-324, 2.2250738585072014e-308, Number.MAX_VALUE, 1e-200, 4.999999999999999]) expect(Object.is(nearestDouble(exactValue(value)), value), String(value)).toBe(true);
    // Rounding boundaries checked with plain integers: MAX_VALUE + half an ulp overflows (ties to even), just below it does not.
    const halfway = { n: 2n ** 1024n - 2n ** 970n, d: 1n };
    expect(nearestDouble(halfway)).toBe(Infinity);
    expect(nearestDouble(minus(halfway, integer(1)))).toBe(Number.MAX_VALUE);
    expect(nearestDouble({ n: 1n, d: 2n ** 1075n })).toBe(0); // half the smallest subnormal ties to even (zero)
    expect(nearestDouble({ n: 3n, d: 2n ** 1076n })).toBe(5e-324);
    // The central-difference derivative equals 2A·x + B, and the literal secant quotient equals 2A·p + B + A·h exactly.
    for (const entry of admissible.filter(item => item.families.includes('secant-approach'))) {
      const a = exactValue(entry.params.A), b = exactValue(entry.params.B), x = exactValue(entry.params.p), dx = exactValue(entry.params.h);
      const analytic = plus(times(times(integer(2), a), x), b);
      expect(same(slopeAt(entry.params, x), analytic), entry.id).toBe(true);
      expect(same(secantSlope(entry.params)!, plus(analytic, times(a, dx))), entry.id).toBe(true);
    }
  });

  it('(b) the installed kernel, through the worker evaluation path, matches every case including its geometry', () => {
    expect(compareSuite(installed)).toEqual([]);
  });

  it('refuses inadmissible parameters before evaluation with the declared diagnostic', () => {
    for (const entry of fixture.cases.filter(item => item.rejected)) {
      let error: unknown;
      try { installed(entry.params); } catch (caught) { error = caught; }
      expect(error, entry.id).toBeInstanceOf(ModelError);
      expect((error as ModelError).diagnostics, entry.id).toEqual([expect.objectContaining(entry.rejected)]);
      expect(() => direct(entry.params), entry.id).toThrow(RangeError);
    }
    const violation = (() => { try { installed(byId('second-beyond-right-boundary').params); } catch (error) { return (error as ModelError).diagnostics[0]; } })();
    expect(violation).toEqual({
      code: 'CONSTRAINT_VIOLATION', path: '$.constraints.secant-in-domain', message: manifest.constraints[0]!.message, recovery: manifest.constraints[0]!.recovery,
    });
    expect(() => kernel.evaluate({ params: byId('defaults').params, index: 1 })).toThrow(RangeError);
  });

  it('never relabels the coincident secant as the derivative and still emits the secant geometry key', () => {
    for (const h of [0, -0]) for (const evaluate of [installed, direct]) {
      const output = evaluate({ ...byId('coincident-h-0').params, h });
      expect(output.geometry.secant).toEqual({ kind: 'segments2', segments: [] });
      expect(output.quantities['secant.slope']).toMatchObject({ status: 'undefined', code: 'COINCIDENT_POINTS', reason: expect.stringContaining('two distinct points') });
      expect(output.quantities['secant.difference']).toMatchObject({ status: 'undefined', code: 'COINCIDENT_POINTS' });
      expect(output.quantities.derivative).toEqual({ status: 'valid', value: 1 });
      expect(Object.is(scalar(output.quantities['second.x']), 2)).toBe(true);
      expect(show(output.quantities['secant.slope'])).not.toMatch(/"value"/);
    }
    // A tiny nonzero offset is a defined secant even though Q rounds onto P.
    const tiny = direct(byId('secant-tiny-offset').params);
    expect(scalar(tiny.quantities['second.x'])).toBe(scalar(tiny.quantities['probe.x']));
    expect(tiny.quantities['secant.slope']).toEqual({ status: 'valid', value: 2 });
    expect(tiny.quantities['secant.difference']).toEqual({ status: 'valid', value: 1e-300 });
  });

  it('draws the linear and constant degeneracies exactly', () => {
    const level = direct(byId('constant').params);
    const points = (geometry: GeometryResult | undefined) => (geometry?.kind === 'polyline2' ? geometry.segments.flatMap(segment => segment.points) : []);
    expect(points(level.geometry['derivative-curve']).every(([, y]) => Object.is(y, 0))).toBe(true);
    expect(points(level.geometry.curve).every(([, y]) => y === 2)).toBe(true);
    expect(level.geometry.tangent).toEqual({ kind: 'segments2', segments: [{ id: 'tangent', from: [-5, 2], to: [5, 2] }] });
    const line = direct(byId('linear').params);
    expect(points(line.geometry['derivative-curve']).every(([, y]) => y === 1.5)).toBe(true);
    // The tangent to a line is the line itself: its endpoints are f(−5) and f(5).
    expect(line.geometry.tangent).toEqual({ kind: 'segments2', segments: [{ id: 'tangent', from: [-5, -8.5], to: [5, 6.5] }] });
    expect(line.geometry.secant).toEqual({ kind: 'segments2', segments: [{ id: 'secant', from: [-5, -8.5], to: [5, 6.5] }] });
  });

  it('classifies slopes from exact signs, not from displayed digits', () => {
    const near = direct(byId('probe-near-non-dyadic-vertex').params);
    expect(Math.abs(scalar(near.quantities.derivative) as number).toFixed(6)).toBe('0.000000');
    expect(scalar(near.quantities['slope.sign'])).toBe('increasing');
    expect(scalar(near.quantities['vertex.x'])).toBe(byId('probe-near-non-dyadic-vertex').params.p);
    const subnormal = direct(byId('vertex-underflow').params);
    expect(subnormal.quantities.derivative).toEqual({ status: 'valid', value: 5e-324, approximation: { code: 'UNDERFLOW', reason: expect.any(String) } });
    expect(scalar(subnormal.quantities['slope.sign'])).toBe('increasing');
    expect(scalar(direct(byId('vertex-overflow').params).quantities.curvature)).toBe('positive-curvature');
  });

  it('reports numerical limits as statuses, never as zero, Infinity or a fabricated point', () => {
    const tiny = direct(byId('function-value-underflow').params);
    expect(tiny.quantities['probe.value']).toMatchObject({ status: 'numerical-limit', code: 'UNDERFLOW', reason: expect.stringContaining('not zero') });
    expect(tiny.geometry.probe).toEqual({ kind: 'points2', points: [{ id: 'P', at: null, reason: expect.stringContaining('not zero') }] });
    expect(direct(byId('vertex-overflow').params).quantities['vertex.x']).toMatchObject({ status: 'numerical-limit', code: 'OVERFLOW' });
    expect(direct(byId('vertex-underflow').params).quantities['vertex.x']).toMatchObject({ status: 'numerical-limit', code: 'UNDERFLOW' });
    for (const entry of admissible) expect(show(direct(entry.params)), entry.id).not.toMatch(/Infinity|NaN|null,null/);
  });

  it('evaluates the exact second point and documents the double-sum constraint at the boundary', () => {
    const entry = byId('second-within-half-ulp-of-boundary');
    expect(entry.params.p + entry.params.h).toBe(5);
    const output = installed(entry.params);
    expect(scalar(output.quantities['second.x'])).toBe(5);
    // f(5 + 2^−52) for f(x) = x² + x + 1 is 31 + 11·2^−52 + 2^−104, which rounds above f(5) = 31.
    expect(scalar(output.quantities['second.value'])).toBe(31 + 11 * 2 ** -52);
    expect(manifest.interpretation.limitations.some(text => text.includes('double sum p + h'))).toBe(true);
  });

  it('is pure and deterministic, and keeps every number in canonical form', () => {
    const params = Object.freeze({ ...byId('decimal-coefficients').params });
    expect(direct(params)).toEqual(direct(params));
    expect(params).toEqual(byId('decimal-coefficients').params);
    const negativeZero = direct({ A: 0, B: 0, C: -0, p: -0, h: 1 });
    expect(show(negativeZero)).toBe(show(direct({ A: 0, B: 0, C: 0, p: 0, h: 1 })));
    expect(Object.is(scalar(negativeZero.quantities['probe.x']), 0) && Object.is(scalar(negativeZero.quantities['probe.value']), 0)).toBe(true);
  });
});

describe('function-derivative mutation sensitivity (report §12.6)', () => {
  const valid = (value: number | string): QuantityResult => ({ status: 'valid', value: typeof value === 'number' ? value + 0 : value });
  type Change = { quantities?: Record<string, QuantityResult>; geometry?: Record<string, GeometryResult> };
  const patch = (change: (params: FunctionParams, output: KernelOutput) => Change): Evaluate => params => {
    const output = direct(params), changed = change(params, output);
    return { ...output, quantities: { ...output.quantities, ...changed.quantities }, geometry: { ...output.geometry, ...changed.geometry } };
  };
  const value = (output: KernelOutput, id: string): number => scalar(output.quantities[id]) as number;
  const polyline = (fn: (x: number) => number): GeometryResult =>
    ({ kind: 'polyline2', segments: [{ points: X.map(x => [x, fn(x) + 0]), start: 'none', end: 'none' }], gaps: [], sampling: { samples: X.length, domain: [-5, 5] } });
  const line = (id: string, p: number, fp: number, m: number): GeometryResult =>
    ({ kind: 'segments2', segments: [{ id, from: [-5, fp + m * (-5 - p)], to: [5, fp + m * (5 - p)] }] });
  const point = (id: string, x: number, y: number): GeometryResult => ({ kind: 'points2', points: [{ id, at: [x, y] }] });
  const fOf = ({ A, B, C }: FunctionParams) => (x: number) => (A * x + B) * x + C;

  const mutants: Record<string, { evaluate: Evaluate; mustFail: string[] }> = {
    'derivative with the wrong sign, −(2A·p + B)': {
      evaluate: patch(({ A, B, p }, output) => ({
        quantities: { derivative: valid(-(2 * A * p + B)) },
        geometry: { 'derivative-curve': polyline(x => -(2 * A * x + B)), 'derivative-probe': point('P', p, -(2 * A * p + B)), tangent: line('tangent', p, value(output, 'probe.value'), -(2 * A * p + B)) },
      })),
      mustFail: ['defaults', 'positive-curvature', 'secant-h-1', 'sign-before-vertex'],
    },
    'derivative missing the factor 2, A·p + B': {
      evaluate: patch(({ A, B, p }, output) => ({
        quantities: { derivative: valid(A * p + B) },
        geometry: { 'derivative-curve': polyline(x => A * x + B), 'derivative-probe': point('P', p, A * p + B), tangent: line('tangent', p, value(output, 'probe.value'), A * p + B) },
      })),
      mustFail: ['positive-curvature', 'negative-curvature', 'zero-slope-at-vertex'],
    },
    'coefficients A and B transposed in f': {
      evaluate: patch(params => {
        const swapped = fOf({ ...params, A: params.B, B: params.A }), { p, h } = params;
        return { quantities: { 'probe.value': valid(swapped(p)), 'second.value': valid(swapped(p + h)) }, geometry: { curve: polyline(swapped), probe: point('P', p, swapped(p)), second: point('Q', p + h, swapped(p + h)) } };
      }),
      mustFail: ['defaults', 'positive-curvature', 'linear'],
    },
    'secant at h = 0 relabelled as the derivative': {
      evaluate: patch(({ p, h }, output) => (h !== 0 ? {} : {
        quantities: { 'secant.slope': output.quantities.derivative!, 'secant.difference': valid(0) },
        geometry: { secant: line('secant', p, value(output, 'probe.value'), value(output, 'derivative')) },
      })),
      mustFail: ['coincident-h-0', 'coincident-at-vertex', 'constant-coincident', 'coincident-at-boundary'],
    },
    'secant difference with the wrong sign, f′(p) − m_sec': {
      evaluate: patch((_params, output) => (output.quantities['secant.difference']?.status === 'valid' ? { quantities: { 'secant.difference': valid(-value(output, 'secant.difference')) } } : {})),
      mustFail: ['secant-h-1', 'secant-h-0.1', 'secant-h-minus-0.001'],
    },
    'offset read in hundredths of a unit (Q at p + h/100)': {
      evaluate: patch(params => {
        const { A, B, p, h } = params, f = fOf(params), q = p + h / 100, slope = 2 * A * p + B + A * (h / 100);
        return h === 0 ? {} : {
          quantities: { 'second.x': valid(q), 'second.value': valid(f(q)), 'secant.slope': valid(slope), 'secant.difference': valid(A * (h / 100)) },
          geometry: { second: point('Q', q, f(q)), secant: line('secant', p, f(p), slope) },
        };
      }),
      mustFail: ['secant-h-1', 'positive-curvature', 'second-right-boundary'],
    },
    'domain boundaries treated as exclusive': {
      evaluate: params => {
        if (Math.abs(params.p) >= 5 || Math.abs(params.p + params.h) >= 5) throw new RangeError('Boundary excluded.');
        return direct(params);
      },
      mustFail: ['probe-right-boundary', 'probe-left-boundary', 'second-right-boundary', 'second-left-boundary', 'coincident-at-boundary'],
    },
    'second point silently clamped into the domain instead of rejected': {
      evaluate: params => {
        const clamp = (x: number, [low, high]: readonly [number, number]) => Math.min(high, Math.max(low, x));
        const D = FUNCTION_DERIVATIVE_DOMAIN;
        const p = clamp(params.p, D.p), h = clamp(clamp(params.h, D.h), [D.x[0] - p, D.x[1] - p]);
        return direct({ A: clamp(params.A, D.A), B: clamp(params.B, D.B), C: clamp(params.C, D.C), p, h });
      },
      mustFail: ['second-beyond-right-boundary', 'second-beyond-left-boundary', 'second-one-ulp-beyond-boundary', 'probe-beyond-domain'],
    },
    'vertex reported as 0 for a line instead of undefined': {
      evaluate: patch(({ A }) => (A === 0 ? { quantities: { 'vertex.x': valid(0) } } : {})),
      mustFail: ['linear', 'linear-decreasing', 'constant'],
    },
    'slope sign classified from rounded digits': {
      evaluate: patch((_params, output) => {
        const slope = value(output, 'derivative');
        return { quantities: { 'slope.sign': valid(Math.abs(slope) < 1e-9 ? 'stationary' : slope > 0 ? 'increasing' : 'decreasing') } };
      }),
      mustFail: ['probe-near-non-dyadic-vertex', 'vertex-underflow'],
    },
    'underflow reported as exact zero': {
      evaluate: patch(({ p }, output) => {
        const zeroed = (id: string) => (output.quantities[id]?.status === 'numerical-limit' && output.quantities[id]!.code === 'UNDERFLOW' ? valid(0) : output.quantities[id]!);
        const probeValue = zeroed('probe.value');
        return { quantities: { 'probe.value': probeValue, 'vertex.x': zeroed('vertex.x') }, geometry: { probe: point('P', p, scalar(probeValue) as number) } };
      }),
      mustFail: ['function-value-underflow', 'vertex-underflow'],
    },
    'hidden-output leakage: derivative encoded in the probe point ID': {
      evaluate: patch(({ p }, output) => ({ geometry: { probe: { kind: 'points2', points: [{ id: `P:slope=${value(output, 'derivative')}`, at: [p, value(output, 'probe.value')] }] } } })),
      mustFail: ['defaults', 'positive-curvature', 'constant'],
    },
    'hidden-output leakage: derivative drawn under the non-solution graph geometry': {
      evaluate: patch(({ A, B }) => ({ geometry: { curve: polyline(x => 2 * A * x + B) } })),
      mustFail: ['defaults', 'positive-curvature'],
    },
    'hidden-output leakage: tangent appended to the graph polyline': {
      evaluate: patch((_params, output) => {
        const curve = output.geometry.curve as Extract<GeometryResult, { kind: 'polyline2' }>, tangent = output.geometry.tangent as Extract<GeometryResult, { kind: 'segments2' }>;
        const extra = { points: [tangent.segments[0]!.from, tangent.segments[0]!.to], start: 'none' as const, end: 'none' as const };
        return { geometry: { curve: { ...curve, segments: [...curve.segments, extra], gaps: [{ after: 0, before: 1, reason: 'Annotation.' }] } } };
      }),
      mustFail: ['defaults', 'positive-curvature'],
    },
  };

  it('has at least six mutants covering signs, factors, transposition, units, boundaries and leakage', () => {
    expect(Object.keys(mutants).length).toBeGreaterThanOrEqual(6);
  });
  it('the unmodified kernel passes the comparison used for mutants', () => {
    expect(compareSuite(direct)).toEqual([]);
  });
  for (const [name, mutant] of Object.entries(mutants)) {
    it(`detects: ${name}`, () => {
      const failing = compareSuite(mutant.evaluate).map(result => result.id);
      expect(failing.length).toBeGreaterThan(0);
      for (const id of mutant.mustFail) expect(failing, `${name} must fail ${id}`).toContain(id);
    });
  }
});
