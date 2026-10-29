import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vitest';
import { evaluateRequest, validateKernelOutput, type GeometryResult, type KernelOutput, type QuantityResult } from '@experiment-kit/core/model';
import { ANGLE_ARC, vectorOrientationKernel as kernel } from '../../../packages/catalog/src/kernels/vector-orientation-3d.js';
import { vectorOrientationManifest as manifest } from '../../../packages/catalog/src/models/vector-orientation-3d.js';
import {
  cross, crossSquared, dot, expectations, fromDouble, oracleMismatches, piFixed, roundToDouble, sqrtToDouble, squaredLength, vectorsOf,
  angle as oracleAngle, type Tolerance, type VectorFixture, type VectorFixtureCase, type VectorParams,
} from '../oracles/vector-orientation-3d';

// Independent acceptance cases for report §12.4 (A30, A45). The fixture and its oracle live outside the catalogue; no
// independent human subject reviewer has approved them. The fixture is read as text so −0 inputs survive.
const FIXTURE_URL = new URL('../fixtures/activities/vector-orientation-3d.json', import.meta.url);
const fixture = JSON.parse(readFileSync(fileURLToPath(FIXTURE_URL), 'utf8')) as VectorFixture & { model: { modelId: string; version: string } };
const byId = (id: string): VectorFixtureCase => fixture.cases.find(entry => entry.id === id)!;
type Evaluate = (params: VectorParams) => KernelOutput;
type Vec = number[];

const statusOf = (result: QuantityResult | undefined): string =>
  !result ? 'missing' : result.status === 'valid' ? (result.approximation ? `valid:${result.approximation.code}` : 'valid') : `${result.status}:${result.code}`;
const within = (observed: unknown, expected: number, tolerance: Tolerance): boolean =>
  typeof observed === 'number' && Number.isFinite(observed) && Math.abs(observed - expected) <= tolerance.absolute + tolerance.relative * Math.abs(expected);
const negativeZero = (value: unknown): boolean =>
  typeof value === 'number' ? Object.is(value, -0) : !!value && typeof value === 'object' && Object.values(value).some(negativeZero);
const nonzero = (vector: Vec): boolean => vector.some(x => x !== 0);
const crossOf = (a: Vec, b: Vec): Vec => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
/** Unit vector in doubles, rescaled first so tiny components do not underflow. */
const unit = (vector: Vec): Vec => { const largest = Math.max(...vector.map(Math.abs)), scaled = vector.map(x => x / largest), length = Math.hypot(...scaled); return scaled.map(x => x / length); };
const TOLERANCE_OF: Record<string, keyof VectorFixtureCase['tolerance']> = { angle: 'angle', 'cross.direction': 'direction' };
const PLANES = ['xy', 'xz', 'yz'] as const;

/** The angle arc a correct implementation draws: r·(cos φ·û + sin φ·ŵ) with ŵ = n̂ × û, from the fixture's own values. */
function arcProblems(entry: VectorFixtureCase, arc: Extract<GeometryResult, { kind: 'polyline3' }>): string[] {
  const values = entry.expected.values;
  if (arc.segments.length !== 1 || arc.gaps.length) return ['arc: expected one sampled segment and no gap'];
  const points = arc.segments[0]!.points;
  if (points.length !== fixture.arc.samples) return [`arc: ${points.length} points, expected ${fixture.arc.samples}`];
  const radius = Math.min(fixture.arc.maxRadius, fixture.arc.radiusFraction * Math.min(values['u.norm'] as number, values['v.norm'] as number));
  const theta = values.angle as number, normal = values['cross.direction'] as Vec;
  const uHat = unit(values.u as Vec), vHat = unit(values.v as Vec), wHat = crossOf(normal, uHat);
  const close = (a: Vec, b: Vec): boolean => a.every((x, i) => Math.abs(x - b[i]!) <= 1e-12 * radius);
  const problems: string[] = [];
  points.forEach((point, k) => {
    const phi = (theta * k) / (points.length - 1);
    if (!close(point, uHat.map((x, i) => radius * (Math.cos(phi) * x + Math.sin(phi) * wHat[i]!)))) problems.push(`arc point ${k} is off the arc of radius ${radius}`);
    if (Math.abs(point[0] * normal[0]! + point[1] * normal[1]! + point[2] * normal[2]!) > 1e-12 * radius) problems.push(`arc point ${k} leaves the plane of u and v`);
  });
  if (!close(points[0]!, uHat.map(x => radius * x)) || !close(points[points.length - 1]!, vHat.map(x => radius * x))) problems.push('arc does not run from u to v');
  return problems;
}

/** Every disagreement between an evaluator and one fixture case; an empty list means the case passes. */
function compareCase(entry: VectorFixtureCase, evaluate: Evaluate): string[] {
  let output: KernelOutput;
  try { output = evaluate(entry.params); } catch { return ['evaluation failed']; }
  const problems: string[] = [];
  const { statuses, values } = entry.expected;
  for (const [id, status] of Object.entries(statuses)) {
    const result = output.quantities[id];
    if (statusOf(result) !== status) { problems.push(`${id}: status ${statusOf(result)}, expected ${status}`); continue; }
    const expected = values[id];
    if (expected === null || expected === undefined) continue;
    const observed = result?.status === 'valid' ? result.value : undefined;
    if (typeof expected === 'string') { if (observed !== expected) problems.push(`${id}: ${String(observed)}, expected ${expected}`); continue; }
    const tolerance = entry.tolerance[TOLERANCE_OF[id] ?? 'exact'];
    const wanted = Array.isArray(expected) ? expected : [expected], got = Array.isArray(observed) ? observed : [observed];
    if (got.length !== wanted.length || wanted.some((value, i) => !within(got[i], value, tolerance))) problems.push(`${id}: ${JSON.stringify(observed)}, expected ${JSON.stringify(expected)}`);
  }
  if (negativeZero([output.quantities, output.geometry])) problems.push('a quantity or geometry contains −0');

  // Non-solution geometry is exactly u and v (and their projections) from the inputs; anything else is leakage.
  const segments = (entries: [string, Vec][], kind: 'segments2' | 'segments3') =>
    ({ kind, segments: entries.filter(([, to]) => nonzero(to)).map(([id, to]) => ({ id, from: to.map(() => 0), to })) });
  if (!isDeepStrictEqual(output.geometry.vectors, segments([['u', values.u as Vec], ['v', values.v as Vec]], 'segments3'))) problems.push('vectors geometry differs from u and v');
  for (const plane of PLANES) {
    const expected = segments([['u', values[`u.${plane}`] as Vec], ['v', values[`v.${plane}`] as Vec]], 'segments2');
    if (!isDeepStrictEqual(output.geometry[`projection-${plane}`], expected)) problems.push(`projection-${plane} geometry differs from the projections of u and v`);
  }
  // The cross product is drawn exactly when it is a representable nonzero vector, at its rounded value.
  const crossValue = statuses.cross!.startsWith('valid') ? values.cross as Vec : null;
  if (!isDeepStrictEqual(output.geometry.cross, crossValue ? segments([['cross', crossValue]], 'segments3') : { kind: 'segments3', segments: [] })) problems.push('cross geometry differs from u × v');
  const arc = output.geometry['angle-arc'];
  if (arc?.kind !== 'polyline3') problems.push('angle arc missing');
  else if (entry.expected.arc === 'none') {
    if (arc.segments.length || arc.gaps.length !== 1 || !arc.gaps[0]!.reason) problems.push('angle arc drawn where none is expected, or without a reason');
  } else problems.push(...arcProblems(entry, arc));
  return problems;
}
const compareSuite = (evaluate: Evaluate): { id: string; problems: string[] }[] =>
  fixture.cases.map(entry => ({ id: entry.id, problems: compareCase(entry, evaluate) })).filter(result => result.problems.length);

/** The worker's evaluation path in-process: manifest and parameter validation, kernel, then frame validation. */
const installed: Evaluate = params => evaluateRequest({ manifest, params: { ...params }, position: { kind: 'static' } }, [kernel]);
const direct: Evaluate = params => kernel.evaluate({ params: { ...params }, index: 0 });
const nextDouble = (x: number): number => { const view = new DataView(new ArrayBuffer(8)); view.setFloat64(0, x); view.setBigUint64(0, view.getBigUint64(0) + 1n); return view.getFloat64(0); };

describe('spatial vector orientation reference fixture (report §12.4)', () => {
  it('is a well-formed suite for the manifest with declared provenance, tolerances and geometry rule', () => {
    expect(fixture.suiteId).toBe(manifest.referenceSuite?.suiteId);
    expect(fixture.model).toEqual({ modelId: manifest.modelId, version: manifest.version });
    expect(fixture.classificationTolerance).toMatch(/^1e-12 /);
    expect(fixture.arc).toEqual({ ...ANGLE_ARC });
    expect(new Set(fixture.cases.map(entry => entry.id)).size).toBe(fixture.cases.length);
    for (const entry of fixture.cases) {
      expect(entry.provenance.length, entry.id).toBeGreaterThan(40);
      expect(Object.keys(entry.expected.statuses).sort(), entry.id).toEqual(Object.keys(manifest.quantities).sort());
      for (const tolerance of Object.values(entry.tolerance)) expect(tolerance.absolute >= 0 && tolerance.relative >= 0 && tolerance.absolute + tolerance.relative <= 1e-15).toBe(true);
      expect(entry.tolerance.exact, entry.id).toEqual({ absolute: 0, relative: 0 });
    }
  });

  it('covers handedness, parallel, antiparallel, orthogonal, oblique, zero vectors and both sides of the tolerance', () => {
    const relationships = new Set(fixture.cases.map(entry => entry.expected.values.relationship));
    expect([...relationships].sort()).toEqual(['antiparallel', 'oblique', 'orthogonal', 'parallel', 'undefined-zero-vector']);
    const crossValue = (id: string) => byId(id).expected.values.cross;
    expect(crossValue('handedness-ex-ey')).toEqual([0, 0, 1]);
    expect(crossValue('handedness-ey-ex')).toEqual([0, 0, -1]);
    expect(crossValue('handedness-ey-ez')).toEqual([1, 0, 0]);
    expect(crossValue('handedness-ez-ex')).toEqual([0, 1, 0]);
    for (const id of ['orthogonal-axis', 'orthogonal-nonaxis']) expect(byId(id).expected.values.relationship).toBe('orthogonal');
    for (const id of ['zero-u', 'zero-v', 'zero-both']) expect(byId(id).expected.statuses).toMatchObject({ angle: 'undefined:ZERO_VECTOR', 'cross.direction': 'undefined:NO_CROSS_DIRECTION' });
    for (const id of ['parallel-nonaxis', 'antiparallel-nonaxis']) expect(byId(id).expected).toMatchObject({ arc: 'none', statuses: { 'cross.direction': 'undefined:NO_CROSS_DIRECTION' } });
    // Each boundary pair differs in one component by exactly one double, and the classification flips across it.
    const pairs = [['near-parallel', 'parallel'], ['near-orthogonal', 'orthogonal'], ['near-antiparallel', 'antiparallel']] as const;
    for (const [prefix, inside] of pairs) {
      const a = byId(`${prefix}-inside`), b = byId(`${prefix}-outside`);
      const changed = (Object.keys(a.params) as (keyof VectorParams)[]).filter(key => !Object.is(a.params[key], b.params[key]));
      expect(changed, prefix).toHaveLength(1);
      expect(nextDouble(Math.abs(a.params[changed[0]!]))).toBe(Math.abs(b.params[changed[0]!]));
      expect([a.expected.values.relationship, b.expected.values.relationship]).toEqual([inside, 'oblique']);
    }
    expect(byId('near-antiparallel-nonaxis-inside').expected.values.relationship).toBe('antiparallel');
    expect(byId('near-antiparallel-nonaxis-outside').expected.values.relationship).toBe('oblique');
    expect(byId('near-antiparallel-outside').expected.values.angle as number).toBeGreaterThan(3.1415926535);
    const statuses = new Set(fixture.cases.flatMap(entry => Object.values(entry.expected.statuses)));
    for (const status of ['valid:UNDERFLOW', 'numerical-limit:UNDERFLOW', 'undefined:ZERO_VECTOR', 'undefined:NO_CROSS_DIRECTION']) expect(statuses).toContain(status);
  });

  it('(a) agrees exactly with the independent oracle, whose two |u×v|² computations agree', () => {
    const mismatches = fixture.cases.map(entry => ({ id: entry.id, problems: oracleMismatches(entry) })).filter(result => result.problems.length);
    expect(mismatches).toEqual([]);
    for (const entry of fixture.cases) {
      const { u, v } = vectorsOf(entry.params);
      const lagrange = crossSquared(u, v), components = squaredLength(cross(u, v));
      expect(lagrange.n * components.d, entry.id).toBe(components.n * lagrange.d);
    }
  });

  it('the oracle is independent of catalogue and model code, and its reference methods check out by hand', () => {
    const source = readFileSync(fileURLToPath(new URL('../oracles/vector-orientation-3d.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/^\s*(import|export)\s[^;]*\sfrom\s|^\s*import\s|\bimport\(|\brequire\(/m);
    // π to 50 decimals (published value), against Machin's formula at 256 bits.
    const digits = 314159265358979323846264338327950288419716939937510n, scale = 10n ** 50n;
    const pi = piFixed(256), error = pi * scale - digits * (1n << 256n);
    expect((error < 0n ? -error : error) < (1n << 256n) + 4096n * scale).toBe(true); // agreement to about 10⁻⁵⁰
    expect(roundToDouble({ n: pi, d: 1n << 256n })).toBe(Math.PI);
    expect(roundToDouble(oracleAngle({ ux: 1, uy: 0, uz: 0, vx: 1, vy: 1, vz: 0 })!)).toBe(Math.PI / 4);
    expect(roundToDouble(oracleAngle({ ux: 0, uy: 0, uz: 2, vx: 3, vy: 0, vz: 0 })!)).toBe(Math.PI / 2);
    expect(roundToDouble(oracleAngle({ ux: 1, uy: 1, uz: 0, vx: -1, vy: 0, vz: 0 })!)).toBe(3 * Math.PI / 4);
    expect(sqrtToDouble(fromDouble(2))).toBe(Math.SQRT2);
    expect(sqrtToDouble({ n: 1n, d: 1n << 2148n })).toBe(2 ** -1074);
    expect(roundToDouble({ n: 1n, d: 3n })).toBe(1 / 3);
    expect(roundToDouble({ n: 1n, d: 1n << 1075n })).toBe(0); // half the smallest subnormal ties to even (0)
    expect(roundToDouble({ n: 3n, d: 1n << 1076n })).toBe(2 ** -1074);
    expect(dot(vectorsOf({ ux: 1, uy: 2, uz: 2, vx: 2, vy: 1, vz: -2 }).u, vectorsOf({ ux: 1, uy: 2, uz: 2, vx: 2, vy: 1, vz: -2 }).v).n).toBe(0n);
  });

  it('(b) the installed kernel, through the worker evaluation path, matches every case', () => {
    expect(compareSuite(installed)).toEqual([]);
  });

  it('every fixture frame passes frame validation for the manifest', () => {
    for (const entry of fixture.cases) {
      const validated = validateKernelOutput(manifest, { kind: 'static' }, direct(entry.params));
      expect(validated.terminal, entry.id).toEqual({ reached: false });
    }
  });

  it('agrees with the oracle on seeded pairs: integers, decimals, random doubles, tiny scales and near-parallel pairs', () => {
    let seed = 0x2545f491;
    const random = (): number => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
    const families: (() => number[])[] = [
      () => Array.from({ length: 6 }, () => Math.round(random() * 6 - 3)),
      () => Array.from({ length: 6 }, () => Math.round((random() * 6 - 3) * 10) / 10),
      () => Array.from({ length: 6 }, () => random() * 6 - 3),
      () => Array.from({ length: 6 }, () => (random() * 2 - 1) * 10 ** -Math.floor(random() * 320)),
      () => { const u = [0, 0, 0].map(() => random() * 2 - 1), k = random() * 2 - 1; return [...u, u[0]! * k, u[1]! * k, u[2]! * k + (random() - 0.5) * 1e-12]; },
    ];
    const tolerance = byId('oblique-acute').tolerance;
    const problems: string[] = [];
    for (let i = 0; i < 250; i++) {
      const c = families[i % families.length]!();
      const params: VectorParams = { ux: c[0]!, uy: c[1]!, uz: c[2]!, vx: c[3]!, vy: c[4]!, vz: c[5]! };
      const quantities = installed(params).quantities;
      for (const [id, wanted] of Object.entries(expectations(params))) {
        const result = quantities[id]!;
        if (statusOf(result) !== wanted.status) { problems.push(`${JSON.stringify(c)} ${id}: ${statusOf(result)} vs ${wanted.status}`); continue; }
        if (wanted.value === null || result.status !== 'valid') continue;
        const limit = tolerance[TOLERANCE_OF[id] ?? 'exact'];
        const got = [result.value].flat(), expected = [wanted.value].flat();
        if (typeof wanted.value === 'string' ? result.value !== wanted.value : expected.some((value, k) => !within(got[k], value as number, limit)))
          problems.push(`${JSON.stringify(c)} ${id}: ${JSON.stringify(result.value)} vs ${JSON.stringify(wanted.value)}`);
      }
      // Antisymmetry and symmetry: v×u = −(u×v) exactly, u·v and θ do not depend on the order.
      const swapped = installed({ ux: c[3]!, uy: c[4]!, uz: c[5]!, vx: c[0]!, vy: c[1]!, vz: c[2]! }).quantities;
      if (quantities.cross!.status === 'valid' && !isDeepStrictEqual((swapped.cross as { value: Vec }).value, (quantities.cross.value as Vec).map(x => -x + 0))) problems.push(`${JSON.stringify(c)}: v×u is not −(u×v)`);
      const same = (a: QuantityResult, b: QuantityResult): boolean => statusOf(a) === statusOf(b) && (a.status !== 'valid' || b.status !== 'valid' || isDeepStrictEqual(a.value, b.value));
      if (!same(swapped.dot!, quantities.dot!) || !same(swapped.angle!, quantities.angle!)) problems.push(`${JSON.stringify(c)}: u·v or θ depends on the order`);
    }
    expect(problems).toEqual([]);
  });

  it('reports undefined states as statuses with reasons, never as zero or an arbitrary direction', () => {
    const zero = installed(byId('zero-u').params);
    expect(zero.quantities.angle).toEqual({ status: 'undefined', code: 'ZERO_VECTOR', reason: expect.stringContaining('u is the zero vector') });
    expect(zero.quantities['cross.direction']).toEqual({ status: 'undefined', code: 'NO_CROSS_DIRECTION', reason: expect.stringContaining('zero vector') });
    expect(zero.quantities.relationship).toEqual({ status: 'valid', value: 'undefined-zero-vector' });
    expect(zero.geometry.vectors).toEqual({ kind: 'segments3', segments: [{ id: 'v', from: [0, 0, 0], to: [1, 2, 2] }] });
    expect(installed(byId('zero-both').params).geometry.vectors).toEqual({ kind: 'segments3', segments: [] });
    const parallel = installed(byId('parallel-nonaxis').params);
    expect(parallel.quantities['cross.direction']).toMatchObject({ status: 'undefined', reason: expect.stringContaining('same direction') });
    const opposite = installed(byId('antiparallel-nonaxis').params);
    expect(opposite.quantities.angle).toEqual({ status: 'valid', value: Math.PI });
    expect(opposite.geometry['angle-arc']).toEqual({ kind: 'polyline3', segments: [], gaps: [{ after: null, before: null, reason: expect.stringContaining('no single plane') }] });
    const flushed = installed(byId('tiny-orthogonal-cross-underflow').params);
    expect(flushed.quantities.cross).toMatchObject({ status: 'numerical-limit', code: 'UNDERFLOW' });
    expect(flushed.quantities['cross.direction']).toEqual({ status: 'valid', value: [0, 0, 1] });
    expect(flushed.geometry.cross).toEqual({ kind: 'segments3', segments: [] });
    const tinyAngle = installed(byId('subnormal-angle-underflow').params);
    expect(tinyAngle.quantities.angle).toMatchObject({ status: 'numerical-limit', code: 'UNDERFLOW' });
    expect(tinyAngle.quantities.relationship).toEqual({ status: 'valid', value: 'parallel' });
    expect(JSON.stringify([zero, parallel, opposite, flushed, tinyAngle])).not.toMatch(/Infinity|NaN/);
  });

  it('is pure, deterministic and rejects inputs the runtime must reject first', () => {
    const params = Object.freeze({ ux: 2, uy: 1, uz: 0, vx: 1, vy: 2, vz: 2 });
    expect(kernel.evaluate({ params, index: 0 })).toEqual(kernel.evaluate({ params, index: 0 }));
    expect(params).toEqual({ ux: 2, uy: 1, uz: 0, vx: 1, vy: 2, vz: 2 });
    expect(() => kernel.evaluate({ params: { ...params, vz: 3.5 }, index: 0 })).toThrow(RangeError);
    expect(() => kernel.evaluate({ params: { ...params, ux: Number.NaN }, index: 0 })).toThrow(RangeError);
    expect(() => kernel.evaluate({ params, index: 1 })).toThrow(RangeError);
    expect(() => installed({ ...params, ux: -3.01 })).toThrow(expect.objectContaining({ diagnostics: [expect.objectContaining({ code: 'OUT_OF_DOMAIN', path: '$.parameters.ux' })] }));
    const { vz: _vz, ...missing } = params;
    expect(() => evaluateRequest({ manifest, params: missing, position: { kind: 'static' } }, [kernel])).toThrow(expect.objectContaining({ diagnostics: [expect.objectContaining({ code: 'INVALID_INPUT', path: '$.parameters.vz' })] }));
    expect(() => evaluateRequest({ manifest, params, position: { kind: 'index', index: 0 } }, [kernel])).toThrow();
  });
});

describe('spatial vector orientation mutation sensitivity (report §12.6)', () => {
  const valid = (value: number | number[] | string): QuantityResult => ({ status: 'valid', value });
  const values = (result: QuantityResult | undefined): Vec | null => (result?.status === 'valid' && Array.isArray(result.value) ? result.value : null);
  const patch = (change: (params: VectorParams, output: KernelOutput) => { quantities?: Record<string, QuantityResult>; geometry?: Record<string, GeometryResult> }): Evaluate =>
    params => {
      const output = direct(params), delta = change(params, output);
      return { ...output, quantities: { ...output.quantities, ...delta.quantities }, geometry: { ...output.geometry, ...delta.geometry } };
    };
  const swap = (p: VectorParams): VectorParams => ({ ux: p.vx, uy: p.vy, uz: p.vz, vx: p.ux, vy: p.uy, vz: p.uz });
  const naiveCross = (p: VectorParams): Vec => crossOf([p.ux, p.uy, p.uz], [p.vx, p.vy, p.vz]).map(x => x + 0);
  const naiveRelationship = (p: VectorParams, tolerance: number): string => {
    const u = [p.ux, p.uy, p.uz], v = [p.vx, p.vy, p.vz], scale = Math.hypot(...u) * Math.hypot(...v);
    if (scale === 0) return 'undefined-zero-vector';
    const d = u[0]! * v[0]! + u[1]! * v[1]! + u[2]! * v[2]!;
    if (Math.hypot(...naiveCross(p)) <= tolerance * scale) return d > 0 ? 'parallel' : 'antiparallel';
    return Math.abs(d) <= tolerance * scale ? 'orthogonal' : 'oblique';
  };

  const mutants: Record<string, { evaluate: Evaluate; mustFail: string[] }> = {
    'left-handed cross product (v × u)': {
      evaluate: patch(params => { const other = direct(swap(params)); return { quantities: { cross: other.quantities.cross!, 'cross.direction': other.quantities['cross.direction']! }, geometry: { cross: other.geometry.cross! } }; }),
      mustFail: ['handedness-ex-ey', 'handedness-ey-ex', 'orthogonal-nonaxis', 'oblique-acute'],
    },
    'angle in degrees under the radian unit': {
      evaluate: patch((_p, output) => (output.quantities.angle!.status === 'valid' ? { quantities: { angle: valid((output.quantities.angle!.value as number) * 180 / Math.PI) } } : {})),
      mustFail: ['handedness-ex-ey', 'oblique-acute', 'antiparallel-nonaxis'],
    },
    'dot product without the z products': {
      evaluate: patch(p => ({ quantities: { dot: valid(p.ux * p.vx + p.uy * p.vy) } })),
      mustFail: ['orthogonal-nonaxis', 'parallel-nonaxis', 'oblique-domain-corners'],
    },
    'cross product with x and y components transposed': {
      evaluate: patch((_p, output) => {
        const flip = (result: QuantityResult): QuantityResult => { const v = values(result); return v ? valid([v[1]!, v[0]!, v[2]!]) : result; };
        return { quantities: { cross: flip(output.quantities.cross!), 'cross.direction': flip(output.quantities['cross.direction']!) } };
      }),
      mustFail: ['handedness-ey-ez', 'handedness-ez-ex', 'orthogonal-nonaxis'],
    },
    'xz projection transposed to (z, x)': {
      evaluate: patch(p => ({
        quantities: { 'u.xz': valid([p.uz + 0, p.ux + 0]), 'v.xz': valid([p.vz + 0, p.vx + 0]) },
        geometry: { 'projection-xz': { kind: 'segments2', segments: ([['u', [p.uz + 0, p.ux + 0]], ['v', [p.vz + 0, p.vx + 0]]] as [string, [number, number]][]).filter(([, to]) => nonzero(to)).map(([id, to]) => ({ id, from: [0, 0], to })) } },
      })),
      mustFail: ['handedness-ex-ey', 'oblique-acute'],
    },
    'zero-vector angle reported as 0': {
      evaluate: patch((_p, output) => (output.quantities.angle!.status === 'undefined' ? { quantities: { angle: valid(0) } } : {})),
      mustFail: ['zero-u', 'zero-v', 'zero-both'],
    },
    'arbitrary direction (0, 0, 1) for a zero cross product': {
      evaluate: patch((_p, output) => (output.quantities['cross.direction']!.status === 'undefined' ? { quantities: { 'cross.direction': valid([0, 0, 1]) } } : {})),
      mustFail: ['parallel-nonaxis', 'antiparallel-nonaxis', 'zero-u'],
    },
    'classification tolerance widened to 1e-9 in doubles': {
      evaluate: patch(p => ({ quantities: { relationship: valid(naiveRelationship(p, 1e-9)) } })),
      mustFail: ['near-parallel-outside', 'near-orthogonal-outside', 'near-antiparallel-outside', 'near-antiparallel-nonaxis-outside'],
    },
    'no classification tolerance (exact zero only)': {
      evaluate: patch(p => ({ quantities: { relationship: valid(naiveRelationship(p, 0)) } })),
      mustFail: ['near-parallel-inside', 'near-orthogonal-inside', 'decimal-near-parallel'],
    },
    'underflowed cross product reported as the zero vector': {
      evaluate: patch((_p, output) => (output.quantities.cross!.status === 'numerical-limit' ? { quantities: { cross: valid([0, 0, 0]), 'cross.norm': valid(0) } } : {})),
      mustFail: ['tiny-orthogonal-cross-underflow'],
    },
    'naive double products for u·v and u × v': {
      evaluate: patch(p => ({ quantities: { dot: valid(p.ux * p.vx + p.uy * p.vy + p.uz * p.vz + 0), cross: valid(naiveCross(p)) } })),
      mustFail: ['tiny-orthogonal-cross-underflow', 'tiny-parallel-dot-underflow', 'tiny-dot-subnormal'],
    },
    'leak: cross product drawn in the non-solution vectors geometry': {
      evaluate: patch((_p, output) => {
        const vectors = output.geometry.vectors as Extract<GeometryResult, { kind: 'segments3' }>, crossValue = values(output.quantities.cross);
        return crossValue && nonzero(crossValue) ? { geometry: { vectors: { ...vectors, segments: [...vectors.segments, { id: 'cross', from: [0, 0, 0], to: crossValue as [number, number, number] }] } } } : {};
      }),
      mustFail: ['handedness-ex-ey', 'oblique-acute'],
    },
    'leak: projected cross product in the non-solution xy projection': {
      evaluate: patch((_p, output) => {
        const projection = output.geometry['projection-xy'] as Extract<GeometryResult, { kind: 'segments2' }>, crossValue = values(output.quantities.cross);
        return crossValue && nonzero(crossValue.slice(0, 2)) ? { geometry: { 'projection-xy': { ...projection, segments: [...projection.segments, { id: 'cross', from: [0, 0], to: [crossValue[0]!, crossValue[1]!] }] } } } : {};
      }),
      mustFail: ['oblique-acute', 'orthogonal-nonaxis'],
    },
    'arc drawn in an arbitrary plane for antiparallel vectors': {
      evaluate: patch((_p, output) => {
        if (output.quantities.relationship!.status !== 'valid' || output.quantities.relationship!.value !== 'antiparallel') return {};
        const points = Array.from({ length: ANGLE_ARC.samples }, (_, k): [number, number, number] => { const phi = (Math.PI * k) / (ANGLE_ARC.samples - 1); return [Math.cos(phi), Math.sin(phi), 0]; });
        return { geometry: { 'angle-arc': { kind: 'polyline3', segments: [{ points, start: 'none', end: 'none' }], gaps: [] } } };
      }),
      mustFail: ['antiparallel-nonaxis', 'antiparallel-axis'],
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
});
