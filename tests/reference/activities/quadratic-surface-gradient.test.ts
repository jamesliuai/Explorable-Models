import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { evaluateRequest, validateKernelOutput, type GeometryResult, type KernelOutput, type QuantityResult, type Vec2 } from '@explorable-models/core/model';
import {
  ARROW_MAX_LENGTH, ARROW_SCALES, arrowDisclosure, CONTOUR_LEVELS, CONTOUR_SAMPLES, FIELD_GRID, quadraticSurfaceGradientKernel as kernel, SECTION_SAMPLES, SURFACE_GRID,
} from '../../../packages/catalog/src/kernels/quadratic-surface-gradient.js';
import { quadraticSurfaceGradientManifest as manifest } from '../../../packages/catalog/src/models/quadratic-surface-gradient.js';
import {
  cmp, contourResidual, declaredAccepts, exactDeterminant, expectedGradientAt, expectedHeight, expectedPoint, FIELD_AXIS, fromDouble, oracleMismatches, ratio,
  roundToDouble, SECTION_AXIS, sign, sqrtToDouble, SURFACE_AXIS, ZERO,
  type Rational, type SurfaceFixture, type SurfaceFixtureCase, type SurfaceParams, type Tolerance,
} from '../oracles/quadratic-surface-gradient';

// Independent acceptance cases for report §12.5 (A30, A46). The fixture and its oracle live outside the catalogue; no
// independent human subject reviewer has approved them. The fixture is read as text so the −0 input survives.
const ORACLE_URL = new URL('../oracles/quadratic-surface-gradient.ts', import.meta.url);
const fixture = JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/activities/quadratic-surface-gradient.json', import.meta.url)), 'utf8')) as SurfaceFixture;
const byId = (id: string): SurfaceFixtureCase => fixture.cases.find(entry => entry.id === id)!;
type Evaluate = (params: SurfaceParams) => KernelOutput;
type Geometry<K extends GeometryResult['kind']> = Extract<GeometryResult, { kind: K }>;

const statusOf = (result: QuantityResult | undefined): string =>
  !result ? 'missing' : result.status === 'valid' ? (result.approximation ? `valid:${result.approximation.code}` : 'valid') : `${result.status}:${result.code}`;
const within = (observed: unknown, expected: number, tolerance: Tolerance): boolean =>
  typeof observed === 'number' && Number.isFinite(observed) && Math.abs(observed - expected) <= tolerance.absolute + tolerance.relative * Math.abs(expected);
const valueOf = (result: QuantityResult | undefined): unknown => (result?.status === 'valid' ? result.value : undefined);
const geometry = <K extends GeometryResult['kind']>(output: KernelOutput, id: string, kind: K): Geometry<K> | null => {
  const found = output.geometry[id];
  return found?.kind === kind ? found as Geometry<K> : null;
};
const negativeZero = (value: unknown): boolean =>
  typeof value === 'number' ? Object.is(value, -0) : !!value && typeof value === 'object' && Object.values(value).some(negativeZero);
const sameNumbers = (a: readonly number[] | null | undefined, b: readonly number[]): boolean => !!a && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));

/** Oracle values for the sampled geometry of one case: computed once, compared against every evaluator. */
interface ExpectedGeometry { xs: number[]; z: number[]; field: { at: Vec2; vector: Vec2 }[]; sections: Record<'x' | 'y', Vec2[]> }
const geometryCache = new Map<string, ExpectedGeometry>();
function expectedGeometry(entry: SurfaceFixtureCase): ExpectedGeometry {
  const cached = geometryCache.get(entry.id);
  if (cached) return cached;
  const { params } = entry;
  // Sample coordinates are the declared grid values rounded once; heights and gradients are exact at those doubles.
  const doubles = (axis: Rational[]): Rational[] => axis.map(value => fromDouble(roundToDouble(value)));
  const surfaceAxis = doubles(SURFACE_AXIS), fieldAxis = doubles(FIELD_AXIS), sectionAxis = doubles(SECTION_AXIS);
  const computed: ExpectedGeometry = {
    xs: surfaceAxis.map(roundToDouble),
    z: surfaceAxis.flatMap(y => surfaceAxis.map(x => expectedHeight(params, x, y))),
    field: fieldAxis.flatMap(y => fieldAxis.map(x => ({ at: [roundToDouble(x), roundToDouble(y)] as Vec2, vector: expectedGradientAt(params, x, y) }))),
    sections: {
      x: sectionAxis.map((s): Vec2 => [roundToDouble(s), expectedHeight(params, s, ZERO)]),
      y: sectionAxis.map((s): Vec2 => [roundToDouble(s), expectedHeight(params, ZERO, s)]),
    },
  };
  geometryCache.set(entry.id, computed);
  return computed;
}
const residualCache = new Map<string, number>();
const residual = (entry: SurfaceFixtureCase, level: number, point: Vec2): number => {
  const key = `${entry.id}|${level}|${point[0]}|${point[1]}`;
  let value = residualCache.get(key);
  if (value === undefined) { value = contourResidual(entry.params, level, point); residualCache.set(key, value); }
  return value;
};

/** Disagreements between one evaluation and the fixture case and oracle; an empty list means the case passes. */
function compareCase(entry: SurfaceFixtureCase, evaluate: Evaluate): string[] {
  const problems: string[] = [];
  const { params, expected, tolerance } = entry;
  let output: KernelOutput;
  try { output = evaluate(params); } catch { return ['evaluation failed']; }
  try { validateKernelOutput(manifest, { kind: 'static' }, output); } catch (error) { problems.push(`frame rejected: ${(error as Error).message}`); }
  const q = output.quantities;
  const p: Vec2 = [params.px + 0, params.py + 0];

  // Quantities.
  if (!sameNumbers(valueOf(q.point) as number[], p)) problems.push(`point ${JSON.stringify(valueOf(q.point))}`);
  const checkStatus = (id: keyof typeof expected.statuses) => { if (statusOf(q[id]) !== expected.statuses[id]) problems.push(`${id} status ${statusOf(q[id])}, expected ${expected.statuses[id]}`); };
  (['value', 'gradient', 'gradient.norm', 'gradient.direction'] as const).forEach(checkStatus);
  if (expected.value !== null && !within(valueOf(q.value), expected.value, tolerance.rational)) problems.push(`f(p) ${String(valueOf(q.value))}, expected ${expected.value}`);
  const gradient = valueOf(q.gradient) as number[] | undefined;
  if (!gradient || expected.gradient.some((g, i) => !within(gradient[i], g, tolerance.rational))) problems.push(`gradient ${JSON.stringify(gradient)}, expected ${JSON.stringify(expected.gradient)}`);
  if (expected.gradientNorm !== null && !within(valueOf(q['gradient.norm']), expected.gradientNorm, tolerance.irrational)) problems.push(`|∇f| ${String(valueOf(q['gradient.norm']))}`);
  const direction = valueOf(q['gradient.direction']) as number[] | undefined;
  if (expected.direction) {
    if (!direction || expected.direction.some((d, i) => !within(direction[i], d, tolerance.irrational))) problems.push(`direction ${JSON.stringify(direction)}, expected ${JSON.stringify(expected.direction)}`);
    else if (Math.abs(Math.hypot(direction[0]!, direction[1]!) - 1) > 4.5e-16) problems.push('direction is not a unit vector');
  } else if (q['gradient.direction']?.status !== 'undefined' || !q['gradient.direction'].reason) problems.push('direction at the minimum must be undefined with a reason');
  if (!within(valueOf(q['hessian.det']), expected.hessianDet, tolerance.rational)) problems.push(`a·c − b² ${String(valueOf(q['hessian.det']))}`);
  if (!sameNumbers(valueOf(q['minimum.location']) as number[], [0, 0]) || !Object.is(valueOf(q['minimum.value']), 0)) problems.push('minimum is not (0, 0) with value 0');
  if (valueOf(q['arrow.scale']) !== expected.arrowScale) problems.push(`arrow scale ${String(valueOf(q['arrow.scale']))}, expected ${expected.arrowScale}`);
  if (negativeZero(q)) problems.push('a quantity reports −0');

  // Sampled surface, field and sections against the oracle.
  const want = expectedGeometry(entry);
  const grid = fixture.tolerances.grid;
  const surface = geometry(output, 'surface', 'surface-grid');
  if (!surface || !sameNumbers(surface.xs, want.xs) || !sameNumbers(surface.ys, want.xs) || surface.z.length !== want.z.length
    || JSON.stringify(surface.sampling) !== JSON.stringify({ nx: 41, ny: 41, domain: [-2, 2, -2, 2] })) problems.push('surface grid layout differs');
  else {
    const bad = surface.z.findIndex((z, i) => !within(z, want.z[i]!, grid));
    if (bad >= 0) problems.push(`surface z[${bad}] ${String(surface.z[bad])}, expected ${want.z[bad]}`);
  }
  const field = geometry(output, 'field', 'vector-field2');
  if (!field || field.samples.length !== want.field.length) problems.push('field layout differs');
  else {
    const bad = field.samples.findIndex((sample, i) => !sameNumbers(sample.at, want.field[i]!.at) || sample.vector.some((v, k) => !within(v, want.field[i]!.vector[k]!, grid)));
    if (bad >= 0) problems.push(`field sample ${bad}: ${JSON.stringify(field.samples[bad])}, expected ${JSON.stringify(want.field[bad])}`);
    if (field.scale.factor !== expected.arrowScale || field.scale.disclosure !== fixture.arrows.disclosure.replace('<factor>', String(expected.arrowScale))) problems.push(`field scale ${JSON.stringify(field.scale)}`);
  }
  for (const axis of ['x', 'y'] as const) {
    const section = geometry(output, `cross-section-${axis}`, 'polyline2');
    const points = section?.segments[0]?.points;
    if (!section || section.segments.length !== 1 || section.gaps.length || section.segments[0]!.start !== 'none' || section.segments[0]!.end !== 'none' || !points
      || JSON.stringify(section.sampling) !== JSON.stringify({ samples: 81, domain: [-2, 2] }) || points.length !== want.sections[axis].length) { problems.push(`cross-section-${axis} layout differs`); continue; }
    const bad = points.findIndex((point, i) => point[0] !== want.sections[axis][i]![0] || !within(point[1], want.sections[axis][i]![1], grid));
    if (bad >= 0) problems.push(`cross-section-${axis} sample ${bad}: ${JSON.stringify(points[bad])}, expected ${JSON.stringify(want.sections[axis][bad])}`);
  }

  // Analytic contours: five closed curves at the declared directions, every point on its level.
  const contours = geometry(output, 'contours', 'polyline2');
  if (!contours || contours.segments.length !== fixture.grids.contours.levels.length || contours.gaps.length) problems.push('contour layout differs');
  else contours.segments.forEach((segment, l) => {
    const level = fixture.grids.contours.levels[l]!;
    const { points } = segment;
    if (points.length !== fixture.grids.contours.samples || segment.start !== 'none' || segment.end !== 'none' || !sameNumbers(points[0], points[points.length - 1]!)) { problems.push(`contour ${level} is not one closed curve of ${fixture.grids.contours.samples} points`); return; }
    const worst = Math.max(...points.map(point => residual(entry, level, point)));
    if (!(worst <= tolerance.contour.relative)) problems.push(`contour ${level}: |f − L|/L = ${worst}`);
    const misplaced = points.slice(0, -1).findIndex((point, k) => Math.abs(((Math.atan2(point[1], point[0]) + 2 * Math.PI) % (2 * Math.PI)) - (Math.PI * k) / 90) > 1e-9);
    if (misplaced >= 0) problems.push(`contour ${level}: sample ${misplaced} is not at direction 2π·${misplaced}/180`);
  });

  // The point and its arrow: the same frame in both views, scaled by the disclosed factor.
  const point2 = geometry(output, 'point-2d', 'points2'), point3 = geometry(output, 'point-3d', 'points3');
  if (!point2 || point2.points.length !== 1 || point2.points[0]!.id !== 'p' || !sameNumbers(point2.points[0]!.at, p)) problems.push(`point-2d ${JSON.stringify(point2)}`);
  const height = valueOf(q.value);
  if (!point3 || point3.points.length !== 1 || point3.points[0]!.id !== 'p') problems.push('point-3d layout differs');
  else if (typeof height === 'number' ? !sameNumbers(point3.points[0]!.at, [...p, height]) : point3.points[0]!.at !== null || !point3.points[0]!.reason) problems.push(`point-3d ${JSON.stringify(point3.points[0])}`);
  const arrow2 = geometry(output, 'gradient-2d', 'segments2'), arrow3 = geometry(output, 'gradient-3d', 'segments3');
  const s = expected.arrowScale;
  const tip: Vec2 = [p[0] + s * expected.gradient[0], p[1] + s * expected.gradient[1]];
  const hasExtent = expected.direction !== null && (tip[0] !== p[0] || tip[1] !== p[1]);
  if (!arrow2 || arrow2.segments.length !== (hasExtent ? 1 : 0)) problems.push(`gradient-2d ${JSON.stringify(arrow2)}`);
  else if (hasExtent) {
    const { id, from, to } = arrow2.segments[0]!;
    const close = (k: 0 | 1) => Math.abs(to[k] - tip[k]) <= 2 ** -51 * Math.max(1, Math.abs(p[k]) + Math.abs(s * expected.gradient[k]));
    if (id !== 'gradient' || !sameNumbers(from, p) || !close(0) || !close(1)) problems.push(`gradient-2d ${JSON.stringify(arrow2.segments[0])}, expected tip ${JSON.stringify(tip)}`);
  }
  const lifted = hasExtent && typeof height === 'number' && arrow2?.segments[0] ? [{ id: 'gradient', from: [...arrow2.segments[0].from, height], to: [...arrow2.segments[0].to, height] }] : [];
  if (!arrow3 || JSON.stringify(arrow3.segments) !== JSON.stringify(lifted)) problems.push(`gradient-3d ${JSON.stringify(arrow3)} is not the contour-view arrow lifted to z = f(p)`);

  // Gradient ⟂ contour tangent where p is a contour sample.
  if (entry.onContour && contours && direction) {
    const points = contours.segments[fixture.grids.contours.levels.indexOf(entry.onContour.level)]?.points;
    const k = entry.onContour.sample, n = fixture.grids.contours.samples - 1;
    const at = points?.[k], next = points?.[(k + 1) % n], previous = points?.[(k + n - 1) % n];
    if (!at || !next || !previous || Math.hypot(at[0] - p[0], at[1] - p[1]) > 1e-12 * (1 + Math.hypot(...p))) problems.push('p is not the stated contour sample');
    else {
      const chord = [next[0] - previous[0], next[1] - previous[1]] as const;
      const cosine = (chord[0] * direction[0]! + chord[1] * direction[1]!) / Math.hypot(...chord);
      if (!(Math.abs(cosine) <= fixture.tolerances.perpendicular.absolute)) problems.push(`gradient · contour tangent = ${cosine}`);
    }
  }
  return problems;
}
const compareSuite = (evaluate: Evaluate): { id: string; problems: string[] }[] =>
  fixture.cases.map(entry => ({ id: entry.id, problems: compareCase(entry, evaluate) })).filter(result => result.problems.length);

/** The worker's evaluation path in-process: manifest and parameter validation, kernel, then frame validation. */
const installed: Evaluate = params => {
  const { quantities, geometry: drawn, terminal } = evaluateRequest({ manifest, params, position: { kind: 'static' } }, [kernel]);
  return { quantities, geometry: drawn, terminal };
};
const direct: Evaluate = params => kernel.evaluate({ params, index: 0 });

describe('quadratic surface and gradient reference fixture (report §12.5)', () => {
  it('is a well-formed suite for the installed manifest with declared provenance, tolerances and sampling', () => {
    expect(fixture.suiteId).toBe(manifest.referenceSuite?.suiteId);
    expect(fixture.model).toEqual({ modelId: manifest.modelId, version: manifest.version });
    expect(fixture.review).toMatch(/No independent human subject reviewer/);
    expect(new Set([...fixture.cases, ...fixture.rejected].map(entry => entry.id)).size).toBe(fixture.cases.length + fixture.rejected.length);
    for (const entry of [...fixture.cases, ...fixture.rejected]) expect(entry.provenance.length, entry.id).toBeGreaterThan(20);
    for (const entry of fixture.cases) for (const tolerance of [entry.tolerance.rational, entry.tolerance.irrational]) {
      expect(tolerance.absolute, entry.id).toBeGreaterThanOrEqual(0);
      expect(tolerance.relative, entry.id).toBeLessThanOrEqual(2.3e-16);
    }
    // The fixture declares the sampling and arrow semantics the kernel must implement.
    expect(fixture.grids).toEqual({
      surface: { n: SURFACE_GRID.n, spacing: 0.1 }, field: { n: FIELD_GRID.n, spacing: FIELD_GRID.spacing }, sections: { n: SECTION_SAMPLES.n, spacing: 0.05 },
      contours: { levels: [...CONTOUR_LEVELS], samples: CONTOUR_SAMPLES },
    });
    expect({ ...fixture.arrows, disclosure: fixture.arrows.disclosure.replace('<factor>', '0.05') }).toEqual({ scales: [...ARROW_SCALES], maxLength: ARROW_MAX_LENGTH, disclosure: arrowDisclosure(0.05) });
    expect(Object.is(byId('minimum-at-origin-negative-zero').params.px, -0)).toBe(true);
  });

  it('covers every §12.5 case family', () => {
    const valid = fixture.cases.filter(entry => entry.expected.direction !== null);
    expect(valid.length).toBeGreaterThanOrEqual(10);
    // Axis orientation: with b = 0 the gradient at (1, 0) points along +x, at (0, 1) along +y.
    expect([byId('axes-plus-x').params.b, byId('axes-plus-x').expected.direction]).toEqual([0, [1, 0]]);
    expect([byId('axes-plus-y').params.b, byId('axes-plus-y').expected.direction]).toEqual([0, [0, 1]]);
    expect(byId('axes-minus-x').expected.direction).toEqual([-1, 0]);
    // Minimum at the origin with zero gradient and undefined direction.
    for (const id of ['minimum-at-origin', 'minimum-at-origin-negative-zero']) {
      expect(byId(id).expected).toMatchObject({ value: 0, gradient: [0, 0], gradientNorm: 0, direction: null, statuses: { 'gradient.direction': 'undefined:ZERO_GRADIENT' } });
    }
    // Contour/gradient perpendicularity, including tilted (b ≠ 0) ellipses.
    const onContour = fixture.cases.filter(entry => entry.onContour);
    expect(onContour.length).toBeGreaterThanOrEqual(4);
    expect(onContour.filter(entry => entry.params.b !== 0).length).toBeGreaterThanOrEqual(2);
    expect(fixture.cases.filter(entry => entry.params.b !== 0 && entry.expected.direction !== null).length).toBeGreaterThanOrEqual(6);
    // Constraint boundary: exactly zero determinants rejected, tiny positive ones accepted.
    const singular = fixture.rejected.filter(entry => entry.code === 'CONSTRAINT_VIOLATION' && sign(exactDeterminant(entry.params)) === 0);
    expect(singular.length).toBeGreaterThanOrEqual(3);
    expect(fixture.cases.filter(entry => entry.id.startsWith('near-singular')).map(entry => entry.expected.hessianDet).every(det => det > 0 && det < 1e-15)).toBe(true);
    // Numerical statuses near zero are explicit, never silent zeros.
    const statuses = fixture.cases.flatMap(entry => Object.values(entry.expected.statuses));
    for (const status of ['valid:UNDERFLOW', 'numerical-limit:UNDERFLOW', 'undefined:ZERO_GRADIENT']) expect(statuses).toContain(status);
    expect(byId('steep-corner').expected.value).toBe(24);
  });

  it('(a) agrees exactly with the independent rational oracle, and the rejected cases are rejected by the declared rule', () => {
    const mismatches = fixture.cases.map(entry => ({ id: entry.id, problems: oracleMismatches(entry) })).filter(result => result.problems.length);
    expect(mismatches).toEqual([]);
    for (const entry of fixture.rejected) {
      if (entry.code === 'CONSTRAINT_VIOLATION') {
        expect(declaredAccepts(entry.params), entry.id).toBe(false);
        expect(sign(exactDeterminant(entry.params)), entry.id).toBeLessThanOrEqual(0);
      } else {
        const id = entry.path.slice('$.parameters.'.length) as keyof SurfaceParams;
        const definition = manifest.parameters[id]!;
        expect(entry.params[id] < definition.min || entry.params[id] > definition.max, entry.id).toBe(true);
      }
    }
  });

  it('the oracle is independent of catalogue and model code, and its rounding is exact on hand-checked values', () => {
    const source = readFileSync(fileURLToPath(ORACLE_URL), 'utf8');
    expect(source).not.toMatch(/^\s*(import|export)\s[^;]*\sfrom\s|^\s*import\s|\bimport\(|\brequire\(/m);
    expect(cmp(fromDouble(0.1), { n: 3602879701896397n, d: 2n ** 55n })).toBe(0);
    expect(roundToDouble(fromDouble(0.1))).toBe(0.1);
    // Ties to even in the subnormal range: 2⁻¹⁰⁷⁵ → 0 and 3·2⁻¹⁰⁷⁵ → 2⁻¹⁰⁷³.
    expect(roundToDouble({ n: 1n, d: 2n ** 1075n })).toBe(0);
    expect(roundToDouble({ n: 3n, d: 2n ** 1075n })).toBe(1e-323);
    // Math.sqrt is correctly rounded (IEEE-754), so it is an independent check of the oracle's square root.
    for (const [n, d] of [[2, 1], [17, 2], [34, 1], [5, 1], [9, 4], [1, 1024]] as const) expect(sqrtToDouble(ratio(n, d)), `√(${n}/${d})`).toBe(Math.sqrt(n / d));
    expect(sqrtToDouble(ratio(1, 3))).toBe(Math.sqrt(1 / 3)); // ⌊√(1/3)⌉ happens to agree with √ of the rounded third
  });

  it('(b) the installed kernel, through the worker evaluation path, passes frame validation and matches every case', () => {
    expect(compareSuite(installed)).toEqual([]);
  });

  it('rejects coefficients at exactly a·c − b² = 0 and out-of-range inputs before evaluation', () => {
    for (const entry of fixture.rejected) {
      expect(() => installed(entry.params), entry.id).toThrow(expect.objectContaining({ diagnostics: [expect.objectContaining({ code: entry.code, path: entry.path })] }));
      expect(() => direct(entry.params), entry.id).toThrow(RangeError);
    }
    // The neighbouring accepted cases sit one rounding step above zero.
    for (const id of ['near-singular-accepted-b-below-1', 'near-singular-accepted-c-above-1']) expect(() => installed(byId(id).params)).not.toThrow();
  });

  it('decides the zero gradient from p itself: tiny nonzero points keep a direction, the origin never gets one', () => {
    const tiny = installed(byId('tiny-point-diagonal').params);
    expect(tiny.quantities.gradient).toMatchObject({ status: 'valid', value: [0, 0], approximation: { code: 'UNDERFLOW' } });
    expect(tiny.quantities['gradient.norm']).toMatchObject({ status: 'numerical-limit', code: 'UNDERFLOW' });
    expect(tiny.quantities['gradient.direction']).toEqual({ status: 'valid', value: [Math.SQRT1_2, Math.SQRT1_2] });
    expect(tiny.quantities.value).toMatchObject({ status: 'numerical-limit', code: 'UNDERFLOW' });
    expect(tiny.geometry['point-3d']).toEqual({ kind: 'points3', points: [{ id: 'p', at: null, reason: expect.stringContaining('not exactly 0') }] });
    const origin = installed(byId('minimum-at-origin').params);
    expect(origin.quantities['gradient.direction']).toEqual({ status: 'undefined', code: 'ZERO_GRADIENT', reason: expect.stringMatching(/no direction/) });
    expect(origin.geometry['gradient-2d']).toEqual({ kind: 'segments2', segments: [] });
    expect(JSON.stringify([tiny, origin])).not.toMatch(/NaN|Infinity/);
    // The origin's field sample is the zero vector (drawn as a dot), never a chosen direction.
    const field = origin.geometry.field as Geometry<'vector-field2'>;
    expect(field.samples[40]).toEqual({ at: [0, 0], vector: [0, 0] });
    expect(expectedPoint({ a: 2, b: 0.5, c: 1, px: 0, py: 0 }).direction).toBeNull();
  });

  it('is pure and deterministic, and has no camera or other presentation input', () => {
    const params = Object.freeze({ a: 2, b: 1, c: 1.5, px: -1.25, py: 0.75 });
    expect(direct(params)).toEqual(direct(params));
    expect(params).toEqual({ a: 2, b: 1, c: 1.5, px: -1.25, py: 0.75 });
    expect(kernel.mode).toBe('static');
    expect(() => kernel.evaluate({ params, index: 1 })).toThrow(RangeError);
    // A camera, view or zoom value is not a model input: the runtime rejects it instead of evaluating.
    for (const key of ['camera', 'zoom', 'azimuth']) {
      expect(() => installed({ ...params, [key]: 1 } as SurfaceParams)).toThrow(expect.objectContaining({ diagnostics: [expect.objectContaining({ code: 'INVALID_INPUT', path: `$.parameters.${key}` })] }));
    }
  });
});

describe('quadratic surface fixture mutation sensitivity (report §12.6)', () => {
  type Output = KernelOutput & { geometry: Record<string, GeometryResult> };
  const mutate = (change: (params: SurfaceParams, output: Output) => void): Evaluate => params => {
    const output = structuredClone(direct(params)) as Output;
    change(params, output);
    return output;
  };
  const valid = (value: number | number[]): QuantityResult => ({ status: 'valid', value });
  const get = <K extends GeometryResult['kind']>(output: Output, id: string, kind: K) => geometry(output, id, kind)!;
  const pointOf = (params: SurfaceParams): Vec2 => [params.px + 0, params.py + 0];
  /** Redraws both point arrows from a (possibly mutated) gradient. */
  const redrawArrows = (params: SurfaceParams, output: Output, gradient: Vec2, factor = valueOf(output.quantities['arrow.scale']) as number) => {
    const from = pointOf(params), to: Vec2 = [from[0] + factor * gradient[0], from[1] + factor * gradient[1]];
    const height = valueOf(output.quantities.value) as number;
    const drawn = output.quantities['gradient.direction']!.status === 'valid' && (to[0] !== from[0] || to[1] !== from[1]);
    get(output, 'gradient-2d', 'segments2').segments = drawn ? [{ id: 'gradient', from, to }] : [];
    get(output, 'gradient-3d', 'segments3').segments = drawn && typeof height === 'number' ? [{ id: 'gradient', from: [...from, height], to: [...to, height] }] : [];
  };
  const fCoupled = ({ a, b, c }: SurfaceParams, x: number, y: number, coupling = 2) => (a * x * x + coupling * b * x * y + c * y * y) / 2;
  /** Recomputes every height (value, point, surface, sections) with a mutated f. */
  const reheight = (params: SurfaceParams, output: Output, f: (x: number, y: number) => number) => {
    const [px, py] = pointOf(params);
    if (output.quantities.value!.status === 'valid') output.quantities.value = valid(f(px, py));
    const surface = get(output, 'surface', 'surface-grid');
    surface.z = surface.ys.flatMap(y => surface.xs.map(x => f(x, y)));
    for (const axis of ['x', 'y'] as const) {
      const segment = get(output, `cross-section-${axis}`, 'polyline2').segments[0]!;
      segment.points = segment.points.map(([s]): Vec2 => [s, axis === 'x' ? f(s, 0) : f(0, s)]);
    }
    const point = get(output, 'point-3d', 'points3').points[0]!;
    if (point.at) point.at = [px, py, f(px, py)];
    redrawArrows(params, output, (valueOf(output.quantities.gradient) as Vec2));
  };

  const mutants: Record<string, { evaluate: Evaluate; mustFail: string[] }> = {
    'gradient with the wrong sign (pointing downhill)': {
      evaluate: mutate((params, output) => {
        const g = (valueOf(output.quantities.gradient) as Vec2).map(v => -v + 0) as Vec2;
        output.quantities.gradient = valid(g);
        const d = valueOf(output.quantities['gradient.direction']);
        if (Array.isArray(d)) output.quantities['gradient.direction'] = valid(d.map(v => -v + 0));
        redrawArrows(params, output, g);
      }),
      mustFail: ['default-point-on-level-2', 'axes-plus-x', 'tilted-point-on-x-axis'],
    },
    'x and y transposed in the gradient': {
      evaluate: mutate((params, output) => {
        const [gx, gy] = valueOf(output.quantities.gradient) as Vec2;
        output.quantities.gradient = valid([gy, gx]);
        const d = valueOf(output.quantities['gradient.direction']);
        if (Array.isArray(d)) output.quantities['gradient.direction'] = valid([d[1]!, d[0]!]);
        redrawArrows(params, output, [gy, gx]);
      }),
      mustFail: ['axes-plus-x', 'axes-plus-y', 'tilted-point-on-x-axis', 'default-point-on-level-2'],
    },
    'f without the factor 1/2': {
      evaluate: mutate((params, output) => reheight(params, output, (x, y) => 2 * fCoupled(params, x, y))),
      mustFail: ['default-point-on-level-2', 'steep-corner', 'axes-plus-x'],
    },
    'coupling term b·x·y instead of 2b·x·y': {
      evaluate: mutate((params, output) => reheight(params, output, (x, y) => fCoupled(params, x, y, 1))),
      mustFail: ['default-point-on-level-2', 'steep-corner', 'steep-corner-negative-b'],
    },
    'cross-sections with a and c exchanged': {
      evaluate: mutate(({ a, c }, output) => {
        const x = get(output, 'cross-section-x', 'polyline2').segments[0]!, y = get(output, 'cross-section-y', 'polyline2').segments[0]!;
        x.points = x.points.map(([s]): Vec2 => [s, c * s * s / 2]);
        y.points = y.points.map(([s]): Vec2 => [s, a * s * s / 2]);
      }),
      mustFail: ['default-point-on-level-2', 'axes-plus-x', 'decimal-inputs'],
    },
    'contour radius 2L/q instead of √(2L/q)': {
      evaluate: mutate((params, output) => {
        const contours = get(output, 'contours', 'polyline2');
        contours.segments.forEach((segment, l) => {
          const level = CONTOUR_LEVELS[l]!;
          segment.points = segment.points.map(([x, y]): Vec2 => { const r2 = 2 * level / (2 * fCoupled(params, x, y) / (x * x + y * y)); const r = Math.sqrt(r2); return [x / r * r2, y / r * r2]; });
        });
      }),
      mustFail: ['default-point-on-level-2', 'axes-plus-x', 'gentle-bowl'],
    },
    'direction at the minimum chosen as +x instead of undefined': {
      evaluate: mutate((_params, output) => { if (output.quantities['gradient.direction']!.status === 'undefined') output.quantities['gradient.direction'] = valid([1, 0]); }),
      mustFail: ['minimum-at-origin', 'minimum-at-origin-negative-zero'],
    },
    'zero gradient decided from rounded components instead of p': {
      evaluate: mutate((params, output) => {
        const g = valueOf(output.quantities.gradient) as Vec2;
        if (g[0] === 0 && g[1] === 0) { output.quantities['gradient.direction'] = { status: 'undefined', code: 'ZERO_GRADIENT', reason: 'Zero gradient.' }; redrawArrows(params, output, g); }
      }),
      mustFail: ['tiny-point-diagonal'],
    },
    'underflow reported as exact zero': {
      evaluate: mutate((_params, output) => {
        for (const id of ['value', 'gradient.norm']) { const result = output.quantities[id]!; if (result.status === 'numerical-limit') output.quantities[id] = valid(0); }
      }),
      mustFail: ['tiny-point-subnormal-gradient', 'tiny-point-diagonal'],
    },
    'arrow scale disclosed but the point arrow drawn at true length': {
      evaluate: mutate((params, output) => redrawArrows(params, output, valueOf(output.quantities.gradient) as Vec2, 1)),
      mustFail: ['default-point-on-level-2', 'axes-plus-x', 'steep-corner'],
    },
    'field arrows pre-scaled and disclosed as factor 1': {
      evaluate: mutate((_params, output) => {
        const field = get(output, 'field', 'vector-field2');
        const factor = field.scale.factor;
        field.samples = field.samples.map(sample => ({ at: sample.at, vector: [sample.vector[0] * factor, sample.vector[1] * factor] as Vec2 }));
        field.scale = { factor: 1, disclosure: arrowDisclosure(1) };
      }),
      mustFail: ['default-point-on-level-2', 'gentle-bowl', 'steep-corner'],
    },
    'hidden-output leakage: the gradient tip emitted as a second point of the non-solution point geometry': {
      evaluate: mutate((_params, output) => {
        const arrow = get(output, 'gradient-2d', 'segments2').segments[0];
        if (arrow) get(output, 'point-2d', 'points2').points.push({ id: 'tip', at: arrow.to });
      }),
      mustFail: ['default-point-on-level-2', 'axes-plus-x', 'tilted-point-on-x-axis'],
    },
    'hidden-output leakage within the declared size: the non-solution point marker moved to the gradient tip': {
      evaluate: mutate((_params, output) => {
        const arrow = get(output, 'gradient-2d', 'segments2').segments[0];
        if (arrow) get(output, 'point-2d', 'points2').points = [{ id: 'p', at: arrow.to }];
      }),
      mustFail: ['default-point-on-level-2', 'tilted-point-on-x-axis'],
    },
    // R37: a tie resolved to even instead of toward the dropped tiny term is one unit in the last place off.
    'one unit in the last place: ∂f/∂x rounded to even instead of correctly': {
      evaluate: mutate((params, output) => {
        const g = valueOf(output.quantities.gradient) as Vec2;
        const tie = Math.abs(params.px) < 1e-90 && params.px !== 0;
        if (!tie) return;
        const view = new DataView(new ArrayBuffer(8));
        view.setFloat64(0, g[0]);
        view.setBigUint64(0, view.getBigUint64(0) + (params.px > 0 ? -1n : 1n));
        output.quantities.gradient = valid([view.getFloat64(0), g[1]]);
      }),
      mustFail: ['exact-tie-tiny-x-term', 'exact-tie-hand-built-x'],
    },
    'hidden-output leakage: the gradient direction drawn as an extra contour segment': {
      evaluate: mutate((params, output) => {
        const d = valueOf(output.quantities['gradient.direction']);
        const [px, py] = pointOf(params);
        if (Array.isArray(d)) get(output, 'contours', 'polyline2').segments.push({ points: [[px, py], [px + d[0]!, py + d[1]!]], start: 'none', end: 'none' });
      }),
      mustFail: ['default-point-on-level-2', 'decimal-inputs'],
    },
  };

  it('the unmodified kernel passes the comparison used for mutants', () => {
    expect(compareSuite(direct)).toEqual([]);
  });
  it('runs at least six distinct mutants covering signs, factors, transposition, boundaries and leakage', () => {
    expect(Object.keys(mutants).length).toBeGreaterThanOrEqual(6);
  });
  for (const [name, mutant] of Object.entries(mutants)) {
    it(`detects: ${name}`, () => {
      const failing = compareSuite(mutant.evaluate).map(result => result.id);
      expect(failing.length).toBeGreaterThan(0);
      for (const id of mutant.mustFail) expect(failing, `${name} must fail ${id}`).toContain(id);
    });
  }
});

describe('quadratic surface point values are the correctly rounded exact values (R37)', () => {
  // Seeded sweep against the independent oracle: ordinary admissible doubles, tiny and subnormal points, and products that
  // are exact rounding ties beside a term far below one unit in the last place (where double-double sums go wrong).
  let seed = 0x5eed1234;
  const random = (): number => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const between = (low: number, high: number): number => low + (high - low) * random();
  const signed = (magnitude: number): number => (random() < 0.5 ? -magnitude : magnitude);
  function cases(): SurfaceParams[] {
    const out: SurfaceParams[] = [];
    const coefficients = () => { const a = between(0.2, 4), c = between(0.2, 4); return { a, b: between(-1, 1) * Math.min(2, 0.999 * Math.sqrt(a * c)), c }; };
    for (let i = 0; i < 60; i++) out.push({ ...coefficients(), px: between(-2, 2), py: between(-2, 2) });
    for (let i = 0; i < 40; i++) out.push({ ...coefficients(), px: signed(10 ** -between(20, 320)), py: signed(10 ** -between(0, 320)) });
    for (let i = 0; i < 60; i++) {
      // b = 1 + k·2^-52 with k odd and p_y = 1.5 make b·p_y = 1.5 + 1.5·k·2^-52 an exact tie; a tiny p_x breaks it.
      const k = 2 * Math.floor(between(0, 2 ** 20)) + 1, b = 1 + k * 2 ** -52;
      const tiny = signed(10 ** -between(20, 300));
      out.push(i % 2 === 0
        ? { a: between(1.2, 4), b, c: between(1.2, 4), px: tiny, py: 1.5 }
        : { a: between(1.2, 4), b: between(-0.9, 0.9), c: b, px: tiny, py: 1.5 }); // c·p_y is the tie in ∂f/∂y
    }
    return out.filter(declaredAccepts);
  }
  const sweep = cases();
  const bitsOf = (value: unknown): string => JSON.stringify(value, (_key, item) => (typeof item === 'number' && Object.is(item, -0) ? '-0' : item));

  it('covers at least 150 admissible cases, half of them exact ties beside a tiny term', () => {
    expect(sweep.length).toBeGreaterThanOrEqual(150);
  });

  it('reports f(p), ∇f(p), |∇f(p)|, the direction and a·c − b² bit for bit as the oracle derives them, with the same statuses', () => {
    const disagreements: string[] = [];
    for (const params of sweep) {
      const expected = expectedPoint(params);
      const q = direct(params).quantities;
      const observed = {
        value: valueOf(q.value) ?? null, gradient: valueOf(q.gradient), gradientNorm: valueOf(q['gradient.norm']) ?? null,
        direction: valueOf(q['gradient.direction']) ?? null, hessianDet: valueOf(q['hessian.det']),
        statuses: { value: statusOf(q.value), gradient: statusOf(q.gradient), 'gradient.norm': statusOf(q['gradient.norm']), 'gradient.direction': statusOf(q['gradient.direction']) },
      };
      const want = { value: expected.value, gradient: expected.gradient, gradientNorm: expected.gradientNorm, direction: expected.direction, hessianDet: expected.hessianDet, statuses: expected.statuses };
      if (bitsOf(observed) !== bitsOf(want)) disagreements.push(`${JSON.stringify(params)}: ${bitsOf(observed)} ≠ ${bitsOf(want)}`);
    }
    expect(disagreements).toEqual([]);
  });
});
