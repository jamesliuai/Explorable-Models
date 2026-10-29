import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkParameters, evaluateRequest, type GeometryResult, type KernelOutput, type ModelManifest, type QuantityResult } from '@experiment-kit/core/model';
import { QUADRATIC_MAX_INDEX, quadraticGradientDescentKernel as kernel, quadraticGradientDescentManifest as manifest } from '@experiment-kit/catalog';
import fixtureJson from '../fixtures/activities/quadratic-gradient-descent.json';
import {
  cmp, CURVE, curveSamplePosition, declaredProduct, DOMAIN, exactQuantity, exactStatus, expectedNumber, fromDouble, lastFiniteIndex, MAX_FINITE, mul,
  multiplier as oracleMultiplier, objectiveAt, oracleMismatches, regime as oracleRegime, rejection, roundToDouble, threshold as oracleThreshold,
  type ExactStatus, type QuadraticFixture, type QuadraticFixtureCase, type QuadraticParams, type Regime, type SequenceQuantity,
} from '../oracles/quadratic';

// Independent acceptance cases for report §12.3 (A27, A30). The fixture and its oracle live outside the catalogue;
// no independent human subject reviewer has approved them.
const fixture = fixtureJson as unknown as QuadraticFixture;
type Evaluate = (params: QuadraticParams, index: number) => KernelOutput;
const SEQUENCES = [['positions', 'position'], ['losses', 'loss'], ['gradients', 'gradient']] as const;

const statusOf = (result: QuantityResult | undefined): string =>
  !result ? 'missing' : result.status === 'valid' ? (result.approximation ? `valid:${result.approximation.code}` : 'valid') : `${result.status}:${result.code}`;
const within = (observed: unknown, expected: number, tolerance: QuadraticFixtureCase['tolerance']): boolean =>
  typeof observed === 'number' && Number.isFinite(observed) && Math.abs(observed - expected) <= tolerance.absolute + tolerance.relative * Math.abs(expected);
const scalar = (result: QuantityResult | undefined): unknown => (result?.status === 'valid' ? result.value : undefined);
const points = (geometry: GeometryResult | undefined) => (geometry?.kind === 'points2' ? geometry.points : []);
/** The double the oracle expects for an exact value (null for a numerical limit). */
const oracleNumber = (params: QuadraticParams, quantity: SequenceQuantity, n: number) => expectedNumber(exactQuantity(params, quantity, n));

/**
 * Declared tolerances of the objective curve, a drawing aid sampled at CURVE.samples positions (manifest geometry
 * `curve`): each sample position lies within one unit in the last place at |x| = 10 (2⁻⁴⁹) of its exact declared
 * position (i − 100)/10, and each value within 2⁻⁵¹ relative (four units of roundoff) of the exact a·x²/2 at the
 * reported position. Both are computed here from the oracle, never from the kernel.
 */
const CURVE_TOLERANCE = Object.freeze({ position: 2 ** -49, relative: 2 ** -51 });
const curveSamples = (geometry: GeometryResult | undefined) =>
  geometry?.kind === 'polyline2' && geometry.segments.length === 1 ? geometry.segments[0]!.points : null;

/**
 * Parameter-only outputs a learner sees before any reveal (the `start` quantity group and the `landscape` view): the
 * starting point and the objective curve. Any other content in them is hidden-output leakage. Also the declared step
 * product and the current-iterate marker, which must be the reported (x_n, f(x_n)) of the same frame.
 */
function parameterOnlyProblems(entry: QuadraticFixtureCase, n: number, output: KernelOutput): string[] {
  const problems: string[] = [];
  const { params, tolerance } = entry;
  const q = output.quantities;
  // The declared step product p is the double product of η and a, exactly (the regime is classified from it).
  const product = roundToDouble(declaredProduct(params)) + 0;
  if (statusOf(q.product) !== 'valid' || !Object.is(scalar(q.product), product)) problems.push(`n=${n}: product ${statusOf(q.product)} ${String(scalar(q.product))}, expected ${product}`);
  // start.position echoes the parameter x0 exactly; start.loss is the exact loss at n = 0.
  if (statusOf(q['start.position']) !== 'valid' || !Object.is(scalar(q['start.position']), params.x0 + 0)) problems.push(`n=${n}: start.position ${statusOf(q['start.position'])} ${String(scalar(q['start.position']))}, expected x0 = ${params.x0}`);
  const startLoss = exactQuantity(params, 'loss', 0), startStatus = exactStatus(startLoss), startValue = expectedNumber(startLoss);
  if (statusOf(q['start.loss']) !== startStatus) problems.push(`n=${n}: start.loss status ${statusOf(q['start.loss'])}, expected ${startStatus}`);
  else if (startValue !== null && !within(scalar(q['start.loss']), startValue, tolerance)) problems.push(`n=${n}: start.loss ${String(scalar(q['start.loss']))}, expected ${startValue}`);
  // The starting marker is exactly (x0, f(x0)) (a drawing position: −0 and +0 are the same point), or a gap with a
  // reason when f(x0) is not representable.
  const start = points(output.geometry.start);
  const marker = start[0];
  if (output.geometry.start?.kind !== 'points2' || start.length !== 1 || marker?.id !== 'x0') problems.push(`n=${n}: start geometry is not the single point x0`);
  else if (startValue === null ? marker.at !== null || !marker.reason : !marker.at || marker.at[0] !== params.x0 || !within(marker.at[1], startValue, tolerance))
    problems.push(`n=${n}: start marker ${JSON.stringify(marker.at)}, expected ${startValue === null ? 'a gap with a reason' : JSON.stringify([params.x0 + 0, startValue])}`);
  // The objective curve: the declared samples of a·x²/2 and nothing else.
  const curve = output.geometry.curve;
  const samples = curveSamples(curve);
  if (!samples || curve?.kind !== 'polyline2' || curve.gaps.length || samples.length !== CURVE.samples
    || curve.sampling?.samples !== CURVE.samples || curve.sampling.domain[0] !== CURVE.low || curve.sampling.domain[1] !== CURVE.high) {
    problems.push(`n=${n}: curve is not one gap-free polyline of the ${CURVE.samples} declared samples (${samples?.length ?? 'no'} points)`);
  } else {
    const wrong = samples.findIndex(([x, y], i) => {
      const exactX = roundToDouble(curveSamplePosition(i));
      const exactY = roundToDouble(objectiveAt(params.a, x));
      return !(Math.abs(x - exactX) <= CURVE_TOLERANCE.position) || !(Math.abs(y - exactY) <= CURVE_TOLERANCE.relative * Math.abs(exactY));
    });
    if (wrong >= 0) problems.push(`n=${n}: curve sample ${wrong} is ${JSON.stringify(samples[wrong])}, not the declared sample of a·x²/2`);
  }
  // The current-iterate marker is the reported (x_n, f(x_n)) of this frame, or a gap with a reason.
  const current = points(output.geometry.current);
  const x = scalar(q.position), f = scalar(q.loss);
  const expectedCurrent = typeof x === 'number' && typeof f === 'number' ? [x, f] : null;
  if (current.length !== 1 || current[0]!.id !== `n${n}` || (expectedCurrent ? JSON.stringify(current[0]!.at) !== JSON.stringify(expectedCurrent) : current[0]!.at !== null || !current[0]!.reason))
    problems.push(`n=${n}: current marker ${JSON.stringify(current)} does not match (x_n, f(x_n))`);
  return problems;
}

/** Every disagreement between an evaluator and one fixture case; an empty list means the case passes. */
function compareCase(entry: QuadraticFixtureCase, evaluate: Evaluate): string[] {
  const problems: string[] = [];
  const { params, indices, expected, tolerance } = entry;
  const run = (n: number): KernelOutput | null => {
    try { return evaluate(params, n); } catch { problems.push(`n=${n}: evaluation failed`); return null; }
  };
  indices.forEach((n, i) => {
    const output = run(n);
    if (!output) return;
    const q = output.quantities;
    if (expected.regime !== undefined && scalar(q.regime) !== expected.regime) problems.push(`n=${n}: regime ${String(scalar(q.regime))}, expected ${expected.regime}`);
    if (expected.multiplier !== undefined && !within(scalar(q.multiplier), expected.multiplier, tolerance)) problems.push(`n=${n}: multiplier ${String(scalar(q.multiplier))}`);
    if (expected.threshold !== undefined && !within(scalar(q.threshold), expected.threshold, tolerance)) problems.push(`n=${n}: threshold ${String(scalar(q.threshold))}`);
    if (scalar(q.index) !== n) problems.push(`n=${n}: index ${String(scalar(q.index))}`);
    for (const [key, quantity] of SEQUENCES) {
      const result = q[quantity];
      const status = expected.statuses?.[quantity]?.[i];
      if (status !== undefined && statusOf(result) !== status) problems.push(`n=${n}: ${quantity} status ${statusOf(result)}, expected ${status}`);
      const value = expected[key]?.[i];
      if (value === null && result?.status === 'valid') problems.push(`n=${n}: ${quantity} reported a value where a numerical limit is expected`);
      if (typeof value === 'number' && !within(scalar(result), value, tolerance)) problems.push(`n=${n}: ${quantity} ${String(scalar(result))}, expected ${value}`);
      if (result?.status === 'numerical-limit' && result.code === 'OVERFLOW' && result.lastFiniteIndex !== expected.lastFiniteIndex?.[quantity])
        problems.push(`n=${n}: ${quantity} lastFiniteIndex ${String(result.lastFiniteIndex)}, expected ${String(expected.lastFiniteIndex?.[quantity])}`);
    }
    // The trace is bound to the same frame: its point at n is the position, or the trace stops with a reason.
    const trace = points(output.geometry.trace);
    const position = q.position;
    const last = trace[trace.length - 1];
    if (position?.status === 'valid') {
      if (trace.length !== n + 1 || last?.at?.[0] !== n || last.at[1] !== position.value) problems.push(`n=${n}: trace does not end at the current position`);
    } else if (!last || last.at !== null || !last.reason) problems.push(`n=${n}: trace does not stop with a reason at the numerical limit`);
    problems.push(...parameterOnlyProblems(entry, n, output));
  });
  // The last finite index is exact: finite there, overflowing one iteration later and reported as such.
  for (const [quantity, k] of Object.entries(expected.lastFiniteIndex ?? {}) as [SequenceQuantity, number][]) {
    const at = run(k), after = run(k + 1);
    if (at && at.quantities[quantity]?.status !== 'valid') problems.push(`${quantity}: not finite at its last finite index ${k}`);
    const next = after?.quantities[quantity];
    if (after && (next?.status !== 'numerical-limit' || next.code !== 'OVERFLOW' || next.lastFiniteIndex !== k)) problems.push(`${quantity}: no OVERFLOW with lastFiniteIndex ${k} at n=${k + 1}`);
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Boundary neighbours (report §12.3: "test neighboring floating-point values around each boundary")
// ---------------------------------------------------------------------------------------------
// Kept test-side so the fixture file, its digest and the model's scientific revision stay unchanged. Each row states
// its expectations by hand from the declared semantics (p is the double product of η and a; a subnormal value is valid
// with an UNDERFLOW note; a nonzero value that rounds to zero is a numerical limit, never 0); the oracle must agree with
// those statements, and the installed kernel must agree with the oracle at every listed index.
type StatusRow = Partial<Record<SequenceQuantity, ExactStatus[]>>;
interface Neighbour { id: string; label: string; params: QuadraticParams; indices: number[]; regime: Regime; product: number; multiplier: number; positions: (number | null)[]; statuses: StatusRow }
const SUBNORMAL = 5e-324; // 2⁻¹⁰⁷⁴, the smallest positive double
const NEIGHBOURS: readonly Neighbour[] = [
  {
    id: 'neighbour-eta0-a2', label: 'η = 0 at a = 2: zero step, stationary (the lower side of the η·a = 0 boundary)', params: { a: 2, eta: 0, x0: 4 }, indices: [0, 1, 1000],
    regime: 'stationary', product: 0, multiplier: 1, positions: [4, 4, 4], statuses: { position: ['valid', 'valid', 'valid'] },
  },
  {
    id: 'neighbour-eta-min-a2', label: 'η = 5e-324 at a = 2: the smallest positive step is positive-step convergence although 1 − η·a rounds to 1', params: { a: 2, eta: SUBNORMAL, x0: 4 }, indices: [0, 1, 1000],
    regime: 'monotone-convergence', product: 1e-323, multiplier: 1, positions: [4, 4, 4], statuses: { position: ['valid', 'valid', 'valid'], loss: ['valid', 'valid', 'valid'] },
  },
  {
    id: 'neighbour-x0-zero', label: 'x0 = 0 at η = 0.25, a = 2: zero start, exactly +0 at every index', params: { a: 2, eta: 0.25, x0: 0 }, indices: [0, 1, 1000],
    regime: 'zero-start', product: 0.5, multiplier: 0.5, positions: [0, 0, 0], statuses: { position: ['valid', 'valid', 'valid'], loss: ['valid', 'valid', 'valid'], gradient: ['valid', 'valid', 'valid'] },
  },
  {
    id: 'neighbour-x0-negative-zero', label: 'x0 = −0 at η = 0.25, a = 2: the same zero start, reported as +0', params: { a: 2, eta: 0.25, x0: -0 }, indices: [0, 1, 1000],
    regime: 'zero-start', product: 0.5, multiplier: 0.5, positions: [0, 0, 0], statuses: { position: ['valid', 'valid', 'valid'] },
  },
  {
    id: 'neighbour-x0-min', label: 'x0 = 5e-324 at η = 0.25, a = 2: not a zero start; subnormal at n = 0, then a nonzero value below the double range', params: { a: 2, eta: 0.25, x0: SUBNORMAL }, indices: [0, 1, 2],
    regime: 'monotone-convergence', product: 0.5, multiplier: 0.5, positions: [SUBNORMAL, null, null],
    statuses: {
      position: ['valid:UNDERFLOW', 'numerical-limit:UNDERFLOW', 'numerical-limit:UNDERFLOW'],
      gradient: ['valid:UNDERFLOW', 'valid:UNDERFLOW', 'numerical-limit:UNDERFLOW'],
      loss: ['numerical-limit:UNDERFLOW', 'numerical-limit:UNDERFLOW', 'numerical-limit:UNDERFLOW'],
    },
  },
  {
    id: 'neighbour-x0-negative-min', label: 'x0 = −5e-324 at η = 0.25, a = 2: the mirror image, with the sign kept', params: { a: 2, eta: 0.25, x0: -SUBNORMAL }, indices: [0, 1, 2],
    regime: 'monotone-convergence', product: 0.5, multiplier: 0.5, positions: [-SUBNORMAL, null, null],
    statuses: { position: ['valid:UNDERFLOW', 'numerical-limit:UNDERFLOW', 'numerical-limit:UNDERFLOW'], gradient: ['valid:UNDERFLOW', 'valid:UNDERFLOW', 'numerical-limit:UNDERFLOW'] },
  },
];
/** A neighbour as a fixture-shaped case whose every expectation is computed by the oracle (exact, tolerance 0). */
function oracleCase(row: Neighbour): QuadraticFixtureCase {
  const { params, indices } = row;
  const values = (quantity: SequenceQuantity) => indices.map(n => oracleNumber(params, quantity, n));
  const statuses = (quantity: SequenceQuantity) => indices.map(n => exactStatus(exactQuantity(params, quantity, n)));
  return {
    id: row.id, label: row.label, provenance: 'Test-side boundary neighbour (report §12.3); every expectation computed by tests/reference/oracles/quadratic.ts.', params, indices,
    expected: {
      regime: oracleRegime(params), multiplier: expectedNumber(oracleMultiplier(params))!, threshold: expectedNumber(oracleThreshold(params))!,
      positions: values('position'), losses: values('loss'), gradients: values('gradient'),
      statuses: { position: statuses('position'), loss: statuses('loss'), gradient: statuses('gradient') },
    },
    tolerance: { absolute: 0, relative: 0 },
  };
}
const NEIGHBOUR_CASES = NEIGHBOURS.map(oracleCase);

/**
 * Admission neighbours: each declared bound, the coupled bound p ≤ 4 at a = 10, at the bound (admitted) and at the
 * next double beyond it (refused, with the code every entry point reports). Hand-stated; the oracle must agree.
 */
interface Admission { id: string; params: QuadraticParams; reject: 'OUT_OF_DOMAIN' | 'CONSTRAINT_VIOLATION' | null; path?: string }
const ADMISSIONS: readonly Admission[] = [
  { id: 'coupled-a10-eta0.4', params: { a: 10, eta: 0.4, x0: 1 }, reject: null }, // p = fl(0.4·10) = 4 exactly
  { id: 'coupled-a10-eta-next', params: { a: 10, eta: 0.4000000000000001, x0: 1 }, reject: 'CONSTRAINT_VIOLATION', path: '$.constraints.multiplier-lower-bound' },
  { id: 'coupled-a2-eta2', params: { a: 2, eta: 2, x0: 1 }, reject: null },
  { id: 'coupled-a-next-eta2', params: { a: 2.0000000000000004, eta: 2, x0: 1 }, reject: 'CONSTRAINT_VIOLATION', path: '$.constraints.multiplier-lower-bound' },
  { id: 'a-min', params: { a: 0.1, eta: 0.25, x0: 4 }, reject: null },
  { id: 'a-below-min', params: { a: 0.09999999999999999, eta: 0.25, x0: 4 }, reject: 'OUT_OF_DOMAIN', path: '$.parameters.a' },
  { id: 'a-max', params: { a: 10, eta: 0.1, x0: 4 }, reject: null },
  { id: 'a-above-max', params: { a: 10.000000000000002, eta: 0.1, x0: 4 }, reject: 'OUT_OF_DOMAIN', path: '$.parameters.a' },
  { id: 'eta-zero', params: { a: 2, eta: 0, x0: 4 }, reject: null },
  { id: 'eta-below-zero', params: { a: 2, eta: -SUBNORMAL, x0: 4 }, reject: 'OUT_OF_DOMAIN', path: '$.parameters.eta' },
  { id: 'eta-max', params: { a: 0.1, eta: 2, x0: 4 }, reject: null },
  { id: 'eta-above-max', params: { a: 0.1, eta: 2.0000000000000004, x0: 4 }, reject: 'OUT_OF_DOMAIN', path: '$.parameters.eta' },
  { id: 'x0-min', params: { a: 2, eta: 0.25, x0: -10 }, reject: null },
  { id: 'x0-below-min', params: { a: 2, eta: 0.25, x0: -10.000000000000002 }, reject: 'OUT_OF_DOMAIN', path: '$.parameters.x0' },
  { id: 'x0-max', params: { a: 2, eta: 0.25, x0: 10 }, reject: null },
  { id: 'x0-above-max', params: { a: 2, eta: 0.25, x0: 10.000000000000002 }, reject: 'OUT_OF_DOMAIN', path: '$.parameters.x0' },
];
/** Admission decision: the diagnostic codes of the parameter check (empty when admitted). */
type Admit = (params: QuadraticParams) => string[];
/** The one check every entry point uses (exact entry, previews, commits, restore, sampling, worker requests). */
const admitWith = (model: ModelManifest): Admit => params => checkParameters(model, params).map(item => item.code);
const admissionProblems = (admit: Admit): { id: string; problems: string[] }[] => ADMISSIONS.map(entry => {
  const codes = admit(entry.params);
  const expected = entry.reject ? [entry.reject] : [];
  return { id: entry.id, problems: JSON.stringify(codes) === JSON.stringify(expected) ? [] : [`${JSON.stringify(entry.params)}: ${JSON.stringify(codes)}, expected ${JSON.stringify(expected)}`] };
}).filter(result => result.problems.length);

const compareSuite = (evaluate: Evaluate): { id: string; problems: string[] }[] =>
  [...fixture.cases, ...NEIGHBOUR_CASES].map(entry => ({ id: entry.id, problems: compareCase(entry, evaluate) })).filter(result => result.problems.length);

/** The worker's evaluation path in-process: manifest, parameter and index validation, kernel, then frame validation. */
const installed: Evaluate = (params, index) => evaluateRequest({ manifest, params, position: { kind: 'index', index } }, [kernel]);
const direct: Evaluate = (params, index) => kernel.evaluate({ params, index });

describe('quadratic gradient-descent reference fixture (report §12.3)', () => {
  it('is a well-formed suite for the installed manifest with declared provenance and tolerances', () => {
    expect(fixture.suiteId).toBe(manifest.referenceSuite?.suiteId);
    expect(fixture.maxIndex).toBe(QUADRATIC_MAX_INDEX);
    expect(new Set(fixture.cases.map(entry => entry.id)).size).toBe(fixture.cases.length);
    for (const entry of fixture.cases) {
      expect(entry.provenance.length, entry.id).toBeGreaterThan(10);
      expect(entry.tolerance.absolute, entry.id).toBeGreaterThanOrEqual(0);
      expect(entry.tolerance.relative, entry.id).toBeGreaterThanOrEqual(0);
    }
    const tabulated = fixture.cases.filter(entry => entry.provenance.startsWith('report §12.3 (tabulated sequence)'));
    expect(tabulated.map(entry => [entry.params, entry.expected.positions, entry.tolerance])).toEqual([
      [{ a: 2, eta: 0.25, x0: 4 }, [4, 2, 1, 0.5], { absolute: 0, relative: 0 }],
      [{ a: 2, eta: 0.75, x0: 4 }, [4, -2, 1, -0.5], { absolute: 0, relative: 0 }],
      [{ a: 2, eta: 1.25, x0: 4 }, [4, -6, 9, -13.5], { absolute: 0, relative: 0 }],
    ]);
  });

  it('covers every mandatory §12.3 case family', () => {
    const ids = fixture.cases.map(entry => entry.id);
    const regimes = new Set(fixture.cases.filter(entry => entry.params.x0 !== 0).map(entry => entry.expected.regime));
    expect([...regimes].sort()).toEqual(['alternating-convergence', 'divergence', 'monotone-convergence', 'one-step', 'oscillation', 'stationary']);
    const zeroStarts = fixture.cases.filter(entry => entry.params.x0 === 0);
    expect(new Set(zeroStarts.map(entry => Math.sign(entry.params.eta * entry.params.a - 2)))).toEqual(new Set([-1, 0, 1]));
    for (const entry of zeroStarts) expect(entry.indices).toEqual([0, 1, 500, 1000]);
    for (const a of [2, 5]) for (const boundary of a === 2 ? [0.5, 1] : [0.2, 0.4]) {
      expect(ids).toContain(`neighbour-a${a}-eta${boundary}-below`);
      expect(ids).toContain(`neighbour-a${a}-eta${boundary}-above`);
    }
    const a5 = fixture.cases.filter(entry => entry.id.startsWith('a5-eta'));
    for (const entry of a5) {
      const converges = entry.params.eta > 0 && entry.params.eta < 0.4;
      expect(['monotone-convergence', 'one-step', 'alternating-convergence'].includes(entry.expected.regime!), entry.id).toBe(converges);
    }
    expect(fixture.cases.filter(entry => entry.id.startsWith('multiplier-minus-0.8')).length).toBeGreaterThanOrEqual(4);
    expect(fixture.cases.some(entry => entry.expected.lastFiniteIndex?.position !== undefined)).toBe(true);
    const statuses = fixture.cases.flatMap(entry => Object.values(entry.expected.statuses ?? {}).flat()) as ExactStatus[];
    expect(statuses).toContain('valid:UNDERFLOW');
    expect(statuses).toContain('numerical-limit:UNDERFLOW');
    expect(statuses).toContain('numerical-limit:OVERFLOW');
  });

  it('(a) agrees exactly with the independent rational oracle', () => {
    const mismatches = fixture.cases.map(entry => ({ id: entry.id, problems: oracleMismatches(fixture, entry) })).filter(result => result.problems.length);
    expect(mismatches).toEqual([]);
  });

  it('the oracle is independent of catalogue and model code, and its overflow bound is exact', () => {
    const source = readFileSync(fileURLToPath(new URL('../oracles/quadratic.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/^\s*(import|export)\s[^;]*\sfrom\s|^\s*import\s|\bimport\(|\brequire\(/m);
    // Hand check of one bound with plain integers: Number.MAX_VALUE = (2^53 − 1)·2^971 exactly.
    const max = (2n ** 53n - 1n) * 2n ** 971n;
    expect(MAX_FINITE).toEqual({ n: max, d: 1n });
    expect(10n * 3n ** 643n <= max && 10n * 3n ** 644n > max).toBe(true);
    expect(lastFiniteIndex({ a: 10, eta: 0.4, x0: 10 }, 'position', 1000)).toBe(643);
    expect(cmp(fromDouble(0.1), { n: 3602879701896397n, d: 2n ** 55n })).toBe(0);
  });

  it('(b) the installed kernel, through the worker evaluation path, matches every case', () => {
    expect(compareSuite(installed)).toEqual([]);
  });

  it('keeps x0 = 0 exactly zero at extreme indices without forming 0·∞', () => {
    for (const [a, eta] of [[2, 1.25], [10, 0.4], [2, 2], [2, 0], [2, 0.5]] as const) for (const index of [0, 1, 999, 1000]) {
      const output = installed({ a, eta, x0: 0 }, index);
      for (const id of ['position', 'loss', 'gradient', 'start.position', 'start.loss']) {
        const result = output.quantities[id]!;
        expect(result.status, id).toBe('valid');
        expect(Object.is(scalar(result), 0), `${id} is +0`).toBe(true);
      }
      expect(points(output.geometry.trace).every(point => point.at !== null && point.at[1] === 0)).toBe(true);
      expect(output.terminal).toEqual(index === 1000 ? { reached: true, event: 'max-index', detail: expect.any(String) } : { reached: false });
    }
  });

  it('stops the trace and iterates at the exact last finite index with a reason, never Infinity or zero', () => {
    const output = installed({ a: 10, eta: 0.4, x0: 10 }, 1000);
    expect(output.quantities.position).toMatchObject({ status: 'numerical-limit', code: 'OVERFLOW', lastFiniteIndex: 643 });
    expect(output.terminal).toMatchObject({ reached: true, event: 'numerical-limit' });
    const trace = points(output.geometry.trace);
    expect(trace).toHaveLength(645);
    expect(trace[643]).toEqual({ id: 'n643', at: [643, expect.any(Number)] });
    expect(trace[644]).toEqual({ id: 'n644', at: null, reason: expect.stringContaining('n = 643') });
    const iterates = points(output.geometry.iterates); // the loss overflows first (after n = 320)
    expect(iterates).toHaveLength(322);
    expect(iterates[321]).toMatchObject({ id: 'n321', at: null });
    const steps = output.geometry.steps;
    expect(steps?.kind === 'segments2' && steps.segments.length).toBe(320);
    expect(points(output.geometry.current)).toEqual([{ id: 'n1000', at: null, reason: expect.any(String) }]);
    const numbers = JSON.stringify(output);
    expect(numbers).not.toMatch(/Infinity|NaN|null,null/);
  });

  it('reports an underflowed nonzero position as a numerical limit, not as exact convergence', () => {
    const tiny = installed({ a: 2, eta: 0.375, x0: 4 }, 538);
    expect(tiny.quantities.position).toEqual({ status: 'valid', value: 5e-324, approximation: { code: 'UNDERFLOW', reason: expect.any(String) } });
    const flushed = installed({ a: 2, eta: 0.375, x0: 4 }, 539);
    expect(flushed.quantities.position).toMatchObject({ status: 'numerical-limit', code: 'UNDERFLOW' });
    expect(flushed.quantities.regime).toEqual({ status: 'valid', value: 'monotone-convergence' });
    expect(flushed.terminal).toMatchObject({ reached: true, event: 'numerical-limit' });
    // A displayed value of 0.000000 is not one-step arrival: the regime comes from η·a, not from rounded iterates.
    const nearOne = installed({ a: 2, eta: 0.5000000000000001, x0: 4 }, 1);
    expect(Math.abs(scalar(nearOne.quantities.position) as number).toFixed(6)).toBe('0.000000');
    expect(scalar(nearOne.quantities.regime)).toBe('alternating-convergence');
  });

  it('is pure, deterministic and rejects inputs the runtime must reject first', () => {
    const params = Object.freeze({ a: 2, eta: 0.75, x0: 4 });
    expect(direct(params, 40)).toEqual(direct(params, 40));
    expect(params).toEqual({ a: 2, eta: 0.75, x0: 4 });
    expect(() => direct(params, 1.5)).toThrow(RangeError);
    expect(() => direct(params, 1001)).toThrow(RangeError);
    expect(() => direct({ a: 10, eta: 0.41, x0: 1 }, 0)).toThrow(RangeError);
    expect(() => installed({ a: 10, eta: 0.41, x0: 1 }, 0)).toThrow(expect.objectContaining({ diagnostics: [expect.objectContaining({ code: 'CONSTRAINT_VIOLATION', path: '$.constraints.multiplier-lower-bound' })] }));
    expect(() => installed({ a: 2, eta: 0.25, x0: 4 }, 2.5)).toThrow();
  });

  it('reports every quantity and the parameter-only geometry exactly: product, start.position, start.loss, the start marker and the objective curve', () => {
    // compareCase checks these for every fixture case; this pins one case by hand as well.
    const output = installed({ a: 2, eta: 0.75, x0: 4 }, 3);
    expect(output.quantities.product).toEqual({ status: 'valid', value: 1.5 });
    expect(output.quantities['start.position']).toEqual({ status: 'valid', value: 4 });
    expect(output.quantities['start.loss']).toEqual({ status: 'valid', value: 16 });
    expect(output.geometry.start).toEqual({ kind: 'points2', points: [{ id: 'x0', at: [4, 16] }] });
    expect(output.geometry.current).toEqual({ kind: 'points2', points: [{ id: 'n3', at: [-0.5, 0.25] }] });
    const samples = curveSamples(output.geometry.curve)!;
    expect(samples).toHaveLength(201);
    expect([samples[0], samples[100], samples[200]]).toEqual([[-10, 100], [0, 0], [10, 100]]);
    // compareCase reads every declared quantity; a new quantity must be added to it (and to this list).
    expect(Object.keys(manifest.quantities).sort()).toEqual(['gradient', 'index', 'loss', 'multiplier', 'position', 'product', 'regime', 'start.loss', 'start.position', 'threshold']);
  });

  it('boundary neighbours: the independent oracle agrees with every hand-stated expectation (report §12.3)', () => {
    for (const row of NEIGHBOURS) {
      expect(oracleRegime(row.params), row.id).toBe(row.regime);
      expect(roundToDouble(declaredProduct(row.params)), row.id).toBe(row.product);
      expect(expectedNumber(oracleMultiplier(row.params)), row.id).toBe(row.multiplier);
      expect(row.indices.map(n => oracleNumber(row.params, 'position', n)), row.id).toEqual(row.positions);
      for (const [quantity, statuses] of Object.entries(row.statuses) as [SequenceQuantity, ExactStatus[]][])
        expect(row.indices.map(n => exactStatus(exactQuantity(row.params, quantity, n))), `${row.id}: ${quantity}`).toEqual(statuses);
    }
    // η = 5e-324 is positive although the multiplier 1 − η·a = 1 − 10⁻³²³ is the double 1: the regime follows p, not r.
    expect(cmp(declaredProduct({ a: 2, eta: SUBNORMAL, x0: 4 }), { n: 0n, d: 1n })).toBe(1);
  });

  it('boundary neighbours: the installed kernel, through the worker evaluation path, matches the oracle at every index', () => {
    expect(NEIGHBOUR_CASES.map(entry => ({ id: entry.id, problems: compareCase(entry, installed) })).filter(result => result.problems.length)).toEqual([]);
    const smallest = installed({ a: 2, eta: SUBNORMAL, x0: 4 }, 1000);
    expect([smallest.quantities.regime, smallest.quantities.product, smallest.quantities.multiplier, smallest.quantities.position]).toEqual([
      { status: 'valid', value: 'monotone-convergence' }, { status: 'valid', value: 1e-323 }, { status: 'valid', value: 1 }, { status: 'valid', value: 4 },
    ]);
    const tiny = installed({ a: 2, eta: 0.25, x0: -SUBNORMAL }, 1);
    expect(tiny.quantities.regime).toEqual({ status: 'valid', value: 'monotone-convergence' });
    expect(tiny.quantities['start.position']).toEqual({ status: 'valid', value: -SUBNORMAL });
    expect(tiny.quantities.position).toMatchObject({ status: 'numerical-limit', code: 'UNDERFLOW' });
    expect(tiny.quantities['start.loss']).toMatchObject({ status: 'numerical-limit', code: 'UNDERFLOW' });
    expect(points(tiny.geometry.start)).toEqual([{ id: 'x0', at: null, reason: expect.stringContaining('not exactly zero') }]);
    expect(tiny.terminal).toMatchObject({ reached: true, event: 'numerical-limit' });
    const negativeZero = installed({ a: 2, eta: 0.25, x0: -0 }, 1000);
    for (const id of ['position', 'loss', 'gradient', 'start.position', 'start.loss']) expect(Object.is(scalar(negativeZero.quantities[id]), 0), `${id} is +0`).toBe(true);
  });

  it('admission neighbours: every declared bound and the coupled bound η·a ≤ 4 admit the bound and refuse the next double, in the oracle, the core check, the worker path and the kernel guard', () => {
    for (const entry of ADMISSIONS) {
      const refused = rejection(entry.params, 0, QUADRATIC_MAX_INDEX);
      expect(refused?.code ?? null, entry.id).toBe(entry.reject);
      if (refused && 'parameter' in refused) expect(entry.path, entry.id).toBe(`$.parameters.${refused.parameter}`);
    }
    // p = fl(0.4·10) = 4 although the exact product of the double 0.4 and 10 exceeds 4 (the bound is on p).
    expect(cmp(mul(fromDouble(0.4), fromDouble(10)), DOMAIN.maxProduct)).toBe(1);
    expect(cmp(declaredProduct({ a: 10, eta: 0.4, x0: 1 }), DOMAIN.maxProduct)).toBe(0);
    expect(admissionProblems(admitWith(manifest))).toEqual([]);
    for (const entry of ADMISSIONS) {
      if (entry.reject) {
        expect(() => installed(entry.params, 0), entry.id).toThrow(expect.objectContaining({ diagnostics: [expect.objectContaining({ code: entry.reject, path: entry.path })] }));
        expect(() => direct(entry.params, 0), entry.id).toThrow(RangeError);
      } else {
        expect(installed(entry.params, 0).quantities['start.position'], entry.id).toEqual({ status: 'valid', value: entry.params.x0 });
        expect(() => direct(entry.params, QUADRATIC_MAX_INDEX), entry.id).not.toThrow();
      }
    }
    // The iteration bound: n = 1000 is evaluated, n = 1001 is refused.
    expect(rejection({ a: 2, eta: 0.25, x0: 4 }, QUADRATIC_MAX_INDEX, QUADRATIC_MAX_INDEX)).toBeNull();
    expect(rejection({ a: 2, eta: 0.25, x0: 4 }, QUADRATIC_MAX_INDEX + 1, QUADRATIC_MAX_INDEX)).toEqual({ code: 'OUT_OF_DOMAIN', parameter: 'index' });
    expect(installed({ a: 2, eta: 0.25, x0: 4 }, QUADRATIC_MAX_INDEX).quantities.index).toEqual({ status: 'valid', value: QUADRATIC_MAX_INDEX });
    expect(() => installed({ a: 2, eta: 0.25, x0: 4 }, QUADRATIC_MAX_INDEX + 1)).toThrow(expect.objectContaining({ diagnostics: [expect.objectContaining({ code: 'OUT_OF_DOMAIN', path: '$.position.index' })] }));
  });
});

describe('quadratic fixture mutation sensitivity (report §12.6)', () => {
  const valid = (value: number | string): QuantityResult => ({ status: 'valid', value });
  const naive = (value: number): QuantityResult => (Number.isFinite(value) ? valid(value) : { status: 'numerical-limit', code: 'OVERFLOW', reason: 'Not finite.' });
  const patch = (change: (params: QuadraticParams, n: number, output: KernelOutput) => Record<string, QuantityResult>): Evaluate =>
    (params, n) => { const output = direct(params, n); return { ...output, quantities: { ...output.quantities, ...change(params, n, output) } }; };
  const patchGeometry = (change: (params: QuadraticParams, n: number, output: KernelOutput) => Record<string, GeometryResult>): Evaluate =>
    (params, n) => { const output = direct(params, n); return { ...output, geometry: { ...output.geometry, ...change(params, n, output) } }; };
  /** (x_n, f(x_n)) of the frame when both are representable: the solution-bearing current iterate. */
  const currentIterate = (output: KernelOutput): [number, number] | null => {
    const x = scalar(output.quantities.position), f = scalar(output.quantities.loss);
    return typeof x === 'number' && typeof f === 'number' ? [x, f] : null;
  };
  const positionValue = (output: KernelOutput): number => (output.quantities.position?.status === 'valid' ? output.quantities.position.value as number : Number.NaN);
  const fromOverflow = (result: QuantityResult, sign: number): QuantityResult =>
    result.status === 'numerical-limit' && result.code === 'OVERFLOW' ? { status: 'valid', value: sign * Infinity } : result;

  const mutants: Record<string, { evaluate: Evaluate; mustFail: string[] }> = {
    'multiplier with the wrong sign (1 + η·a)': {
      evaluate: patch(({ a, eta, x0 }, n) => ({ position: naive(x0 * (1 + eta * a) ** n), multiplier: valid(1 + eta * a) })),
      mustFail: ['report-eta-0.25', 'report-eta-0.75', 'report-eta-1.25'],
    },
    'objective missing the factor 1/2': {
      evaluate: patch(({ a }, _n, output) => ({ loss: naive(a * positionValue(output) ** 2) })),
      mustFail: ['report-eta-0.25', 'eta-zero'],
    },
    'threshold 1/a instead of 2/a': {
      evaluate: patch(({ a }) => ({ threshold: valid(1 / a) })),
      mustFail: ['report-eta-0.25', 'a5-eta0.4'],
    },
    'boundary η·a = 2 classified as divergence': {
      evaluate: patch(({ a, eta, x0 }, _n, output) => (x0 !== 0 && eta * a >= 2 ? { regime: valid('divergence') } : { regime: output.quantities.regime! })),
      mustFail: ['oscillation-a2-eta1', 'oscillation-a5-eta0.4', 'a5-eta0.4'],
    },
    'zero start through the naive power x0·(1 − η·a)^n': {
      evaluate: patch(({ a, eta, x0 }, n) => ({ position: valid(x0 * (1 - eta * a) ** n) })),
      mustFail: ['zero-start-divergence-multiplier-minus-3', 'zero-start-divergence-eta-max'],
    },
    'off-by-one iteration index': {
      evaluate: patch((params, n, output) => ({ position: n < QUADRATIC_MAX_INDEX ? direct(params, n + 1).quantities.position! : output.quantities.position! })),
      mustFail: ['report-eta-0.25', 'report-eta-0.75', 'report-eta-1.25'],
    },
    'overflow returned as Infinity': {
      evaluate: patch(({ x0 }, n, output) => ({
        position: fromOverflow(output.quantities.position!, Math.sign(x0) * (n % 2 === 0 ? 1 : -1)),
        loss: fromOverflow(output.quantities.loss!, 1),
        gradient: fromOverflow(output.quantities.gradient!, Math.sign(x0) * (n % 2 === 0 ? 1 : -1)),
      })),
      mustFail: ['overflow-multiplier-minus-3', 'overflow-small-start'],
    },
    'underflow reported as exact zero': {
      evaluate: patch((_params, _n, output) => Object.fromEntries((['position', 'loss', 'gradient'] as const).map(id => {
        const result = output.quantities[id]!;
        return [id, result.status === 'numerical-limit' && result.code === 'UNDERFLOW' ? valid(0) : result];
      }))),
      mustFail: ['underflow-multiplier-0.25', 'neighbour-a2-eta0.5-above', 'neighbour-x0-min'],
    },
    // A wrong factor in a reported quantity that the generic fixture runner did not cover before.
    'product computed as η/a': {
      evaluate: patch(({ a, eta }) => ({ product: valid(eta / a) })),
      mustFail: ['report-eta-0.25', 'a5-eta0.4', 'neighbour-eta-min-a2'],
    },
    // Hidden-output leakage into the parameter-only channels (the `landscape` view and the `start` group).
    'leak: x_n appended to the objective curve': {
      evaluate: patchGeometry((_params, _n, output): Record<string, GeometryResult> => {
        const curve = output.geometry.curve as Extract<GeometryResult, { kind: 'polyline2' }>;
        const point = currentIterate(output);
        return point ? { curve: { ...curve, segments: [{ ...curve.segments[0]!, points: [...curve.segments[0]!.points, point] }] } } : {};
      }),
      mustFail: ['report-eta-0.25', 'report-eta-0.75', 'report-eta-1.25'],
    },
    'leak: start marker moved to (x_n, f(x_n))': {
      evaluate: patchGeometry((_params, _n, output): Record<string, GeometryResult> => {
        const point = currentIterate(output);
        return point ? { start: { kind: 'points2', points: [{ id: 'x0', at: point }] } } : {};
      }),
      mustFail: ['report-eta-0.25', 'report-eta-0.75', 'report-eta-1.25'],
    },
    'leak: start.position reports the current iterate x_n': {
      evaluate: patch((_params, _n, output) => ({ 'start.position': output.quantities.position! })),
      mustFail: ['report-eta-0.25', 'multiplier-minus-0.8-x0-4'],
    },
    // Incorrect regime boundaries next to η·a = 0 and x0 = 0 (report §12.3 boundary neighbours).
    'stationary decided from the rounded multiplier (1 − η·a = 1) instead of η·a = 0': {
      evaluate: patch(({ a, eta, x0 }, _n, output) => ({ regime: x0 !== 0 && 1 - eta * a === 1 ? valid('stationary') : output.quantities.regime! })),
      mustFail: ['neighbour-eta-min-a2'],
    },
    'zero step counted as positive-step convergence (η·a ≥ 0 instead of η·a > 0)': {
      evaluate: patch(({ a, eta, x0 }, _n, output) => ({ regime: x0 !== 0 && eta * a >= 0 && eta * a < 1 ? valid('monotone-convergence') : output.quantities.regime! })),
      mustFail: ['eta-zero', 'neighbour-eta0-a2'],
    },
    'zero start decided from a magnitude below the smallest normal double': {
      evaluate: patch(({ x0 }, _n, output): Record<string, QuantityResult> => (Math.abs(x0) < 2 ** -1022
        ? { regime: valid('zero-start'), position: valid(0), loss: valid(0), gradient: valid(0), 'start.loss': valid(0) }
        : { regime: output.quantities.regime! })),
      mustFail: ['neighbour-x0-min', 'neighbour-x0-negative-min'],
    },
  };

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

  // Incorrect admission boundaries: the declared rules moved (as an author could declare them), evaluated through the
  // same core check every entry point uses, and one implementation that bounds the exact real product instead of p.
  const withConstraint = (change: Partial<ModelManifest['constraints'][number]>): ModelManifest =>
    ({ ...manifest, constraints: manifest.constraints.map(constraint => ({ ...constraint, ...change })) });
  const withBound = (parameter: 'a' | 'eta', bound: 'min' | 'max', value: number): ModelManifest =>
    ({ ...manifest, parameters: { ...manifest.parameters, [parameter]: { ...manifest.parameters[parameter]!, [bound]: value } } });
  const admissionMutants: Record<string, { admit: Admit; mustFail: string[] }> = {
    'coupled bound exclusive: η·a < 4 (≥ in place of >)': { admit: admitWith(withConstraint({ maxInclusive: false })), mustFail: ['coupled-a10-eta0.4', 'coupled-a2-eta2'] },
    'coupled bound moved to the next double above 4 (4 + ε)': { admit: admitWith(withConstraint({ max: 4.000000000000001 })), mustFail: ['coupled-a10-eta-next', 'coupled-a-next-eta2'] },
    'coupled bound applied to the exact real product of the inputs instead of p': {
      admit: params => cmp(mul(fromDouble(params.eta), fromDouble(params.a)), DOMAIN.maxProduct) > 0 ? ['CONSTRAINT_VIOLATION'] : admitWith(manifest)(params),
      mustFail: ['coupled-a10-eta0.4'],
    },
    'curvature bound exclusive: a > 0.1': { admit: admitWith(withBound('a', 'min', 0.10000000000000002)), mustFail: ['a-min'] },
    'curvature bound one double low': { admit: admitWith(withBound('a', 'min', 0.09999999999999999)), mustFail: ['a-below-min'] },
    'step-size bound exclusive: η > 0': { admit: admitWith(withBound('eta', 'min', SUBNORMAL)), mustFail: ['eta-zero'] },
  };
  it('the unmodified admission rules pass the admission neighbours', () => {
    expect(admissionProblems(admitWith(manifest))).toEqual([]);
  });
  for (const [name, mutant] of Object.entries(admissionMutants)) {
    it(`detects: ${name}`, () => {
      const failing = admissionProblems(mutant.admit).map(result => result.id);
      expect(failing.length).toBeGreaterThan(0);
      for (const id of mutant.mustFail) expect(failing, `${name} must fail ${id}`).toContain(id);
    });
  }
});
