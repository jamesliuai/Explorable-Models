import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  evaluateRequest, validateKernelOutput, validateManifest, type GeometryResult, type KernelOutput, type QuantityResult, type Vec2,
} from '@experiment-kit/core/model';
import {
  LINEAR_EIGEN_LINE_HALF_LENGTH, linearTransformationKernel as kernel,
} from '../../../packages/catalog/src/kernels/linear-transformation';
import { linearTransformationManifest as manifest } from '../../../packages/catalog/src/models/linear-transformation';
import fixtureJson from '../fixtures/activities/linear-transformation.json';
import {
  compare, determinant, exactDouble, expectationDifferences, expectedQuantities, mapPoint, nearestDouble, oracleMismatches, parameterOnlyOutputs,
  REFERENCE_GRID, rootOf, sign, times, minus, plus,
  type Expectation, type LinearFixture, type LinearFixtureCase, type LinearParams, type Tolerance,
} from '../oracles/linear-transformation';

// Independent acceptance cases for report §12.2 (A29, A30). The fixture and its oracle live outside the catalogue;
// no independent human subject reviewer has approved them.
const fixture = fixtureJson as unknown as LinearFixture;
type Evaluate = (params: LinearParams) => KernelOutput;
const byId = (id: string): LinearFixtureCase => fixture.cases.find(entry => entry.id === id)!;
const { manifest: validated } = validateManifest(manifest);
const STATIC = { kind: 'static' } as const;

/** A frame quantity in the fixture's expectation format. */
function observed(result: QuantityResult | undefined): Expectation {
  if (!result) return { undefined: 'MISSING' };
  if (result.status === 'undefined') return { undefined: result.code };
  if (result.status === 'numerical-limit') return { limit: result.code as 'UNDERFLOW' };
  return result.approximation ? { value: result.value as number | number[], approximation: result.approximation.code as 'UNDERFLOW' } : result.value;
}
const segments = (geometry: GeometryResult | undefined) => (geometry?.kind === 'segments2' ? geometry.segments : []);
const polygon = (geometry: GeometryResult | undefined) => (geometry?.kind === 'polygon2' ? geometry : null);
const valueOf = (result: QuantityResult | undefined): number[] | null => (result?.status === 'valid' && Array.isArray(result.value) ? result.value : null);
const sameNumbers = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b) && Array.isArray(a) === Array.isArray(b);

/**
 * Every disagreement between an evaluator and one fixture case; an empty list means the case passes. Besides the
 * stored expectations this checks that outputs shown before exposure carry parameter-only values (no hidden result
 * leaks into them), that the transformed grid is the exact image of the reference grid, and that the
 * unchanged-direction lines follow the frame's own eigen-directions.
 */
function compareCase(entry: LinearFixtureCase, evaluate: Evaluate): string[] {
  let output: KernelOutput;
  try { output = evaluate(entry.params); } catch { return ['evaluation failed']; }
  const problems: string[] = [];
  const { quantities: q, geometry: g } = output;
  for (const [id, wanted] of Object.entries(entry.expected.quantities)) problems.push(...expectationDifferences(id, observed(q[id]), wanted, entry.tolerance));

  const square = polygon(g['unit-square.image']);
  if (!square || square.vertices.length !== 4) problems.push('unit-square.image: missing or not four vertices');
  else {
    entry.expected.unitSquareImage.vertices.forEach(([x, y], i) => {
      const vertex = square.vertices[i]!;
      if (expectationDifferences(`unit-square.image[${i}]`, vertex, [x, y], entry.tolerance).length) problems.push(`unit-square.image[${i}]: ${JSON.stringify(vertex)}, expected ${JSON.stringify([x, y])}`);
    });
    if (square.degenerate !== entry.expected.unitSquareImage.degenerate) problems.push(`unit-square.image.degenerate: ${square.degenerate}`);
  }

  // Hidden-output leakage: groups shown before exposure must carry exactly their parameter-only values.
  const reference = parameterOnlyOutputs(entry.params);
  for (const [id, value] of Object.entries(reference.quantities)) {
    const result = q[id];
    if (result?.status !== 'valid' || result.approximation || !sameNumbers(result.value, value)) problems.push(`${id}: ${JSON.stringify(result)} is not the parameter-only value ${JSON.stringify(value)}`);
  }
  for (const [id, value] of Object.entries(reference.geometry)) if (JSON.stringify(g[id]) !== JSON.stringify(value)) problems.push(`${id}: geometry differs from the parameter-only reference`);

  // The transformed grid is the exact image of the reference grid, rounded once per coordinate.
  const grid = segments(g['grid.transformed']);
  if (grid.length !== REFERENCE_GRID.length) problems.push(`grid.transformed: ${grid.length} segments`);
  REFERENCE_GRID.forEach((segment, i) => {
    const drawn = grid[i];
    const wanted = { id: segment.id, from: mapPoint(entry.params, segment.from), to: mapPoint(entry.params, segment.to) };
    if (JSON.stringify(drawn) !== JSON.stringify(wanted)) problems.push(`grid.transformed ${segment.id}: ${JSON.stringify(drawn)}, expected ${JSON.stringify(wanted)}`);
  });

  // Unchanged-direction lines are ±9·u for each reported direction, in order, and nothing else.
  const directions = (['eigen.direction1', 'eigen.direction2'] as const).flatMap((id, i) => {
    const u = valueOf(q[id]);
    return u ? [{ id: `u${i + 1}`, from: u.map(c => -LINEAR_EIGEN_LINE_HALF_LENGTH * c + 0), to: u.map(c => LINEAR_EIGEN_LINE_HALF_LENGTH * c + 0) }] : [];
  });
  if (JSON.stringify(segments(g['eigen.lines'])) !== JSON.stringify(directions)) problems.push('eigen.lines do not follow the reported eigen-directions');
  return problems;
}
const compareSuite = (evaluate: Evaluate): { id: string; problems: string[] }[] =>
  fixture.cases.map(entry => ({ id: entry.id, problems: compareCase(entry, evaluate) })).filter(result => result.problems.length);

/** The worker's evaluation path in-process: manifest, parameter and position validation, kernel, then frame validation. */
const installed: Evaluate = params => evaluateRequest({ manifest, params, position: STATIC }, [kernel]);
const direct: Evaluate = params => kernel.evaluate({ params, index: 0 });

describe('linear-transformation reference fixture (report §12.2, A29)', () => {
  it('is a well-formed suite for the installed manifest with declared provenance and tolerances', () => {
    expect(fixture.suiteId).toBe(manifest.referenceSuite?.suiteId);
    expect(new Set(fixture.cases.map(entry => entry.id)).size).toBe(fixture.cases.length);
    const listed = Object.keys(manifest.quantities).filter(id => !['basis.e1', 'basis.e2', 'vector.v'].includes(id)).sort();
    for (const entry of fixture.cases) {
      expect(entry.provenance.length, entry.id).toBeGreaterThan(40);
      expect(entry.tolerance.absolute, entry.id).toBeGreaterThanOrEqual(0);
      expect(entry.tolerance.relative, entry.id).toBeGreaterThanOrEqual(0);
      expect(entry.tolerance.relative, entry.id).toBeLessThanOrEqual(1e-12);
      expect(Object.keys(entry.expected.quantities).sort(), entry.id).toEqual(listed);
      expect(Object.keys(entry.params).sort()).toEqual(Object.keys(manifest.parameters).sort());
    }
  });

  it('covers every mandatory §12.2 case family and both sides of each exact boundary', () => {
    const q = (id: string) => byId(id).expected.quantities;
    // Identity, nonaxis rotations with irrational entries, nonsymmetric shear, axis and nonaxis reflections.
    expect(q('identity')['eigen.category']).toBe('repeated-scalar');
    expect([byId('rotation-30').params.m11, byId('rotation-30').params.m21, byId('rotation-120').params.m11, byId('rotation-120').params.m21]).toEqual([Math.sqrt(3) / 2, 0.5, -0.5, Math.sqrt(3) / 2]);
    for (const id of ['rotation-30', 'rotation-120']) {
      expect([q(id).orientation, q(id)['eigen.category'], q(id)['eigen.values']]).toEqual(['preserved', 'complex', { undefined: 'COMPLEX_EIGENVALUES' }]);
      expect(byId(id).tolerance).toEqual({ absolute: 0, relative: 1e-12 });
    }
    expect(byId('shear').params.m12).not.toBe(byId('shear').params.m21);
    expect([q('shear')['eigen.category'], q('shear')['eigen.direction1'], q('shear')['eigen.direction2']]).toEqual(['repeated-defective', [1, 0], { undefined: 'SINGLE_DIRECTION' }]);
    for (const id of ['reflection-x-axis', 'reflection-diagonal', 'reflection-line-2-1', 'scaling-reflection', 'golden']) {
      expect(q(id).orientation, id).toBe('reversed');
      expect(q(id)['area.scale'] as number, id).toBeGreaterThan(0);
    }
    // Singular collapse with image direction (1, 2)/√5, the zero matrix and the zero test vector.
    expect([q('singular-collapse').rank, q('singular-collapse').orientation, q('singular-collapse')['area.scale']]).toEqual([1, 'collapsed', 0]);
    expect(q('singular-collapse')['image.direction']).toEqual([1 / Math.sqrt(5), 2 / Math.sqrt(5)]);
    expect([q('zero-matrix').rank, q('zero-matrix')['image.direction'], q('zero-matrix')['image.v']]).toEqual([0, { undefined: 'ZERO_IMAGE' }, [0, 0]]);
    expect([byId('zero-test-vector').params.vx, byId('zero-test-vector').params.vy, q('zero-test-vector')['image.v']]).toEqual([0, 0, [0, 0]]);
    // Every category, orientation and rank occurs; det = 0 and Δ = 0 are approached from both sides.
    const all = (key: string) => new Set(fixture.cases.map(entry => JSON.stringify(entry.expected.quantities[key])));
    expect(all('eigen.category')).toEqual(new Set(['"two-real"', '"repeated-scalar"', '"repeated-defective"', '"complex"']));
    expect(all('orientation')).toEqual(new Set(['"preserved"', '"reversed"', '"collapsed"']));
    expect(all('rank')).toEqual(new Set(['0', '1', '2']));
    expect([q('near-singular-positive').orientation, q('near-singular-negative').orientation]).toEqual(['preserved', 'reversed']);
    expect([q('near-repeated-two-real')['eigen.category'], q('near-repeated-complex')['eigen.category']]).toEqual(['two-real', 'complex']);
    expect(q('underflow-determinant').determinant).toEqual({ limit: 'UNDERFLOW' });
    expect(q('subnormal-determinant').determinant).toEqual({ value: 2 ** -1060, approximation: 'UNDERFLOW' });
  });

  it('represents the report case [[1, 2], [2, 4]] by its half, because m22 = 4 is outside the declared domain and is rejected, not coerced', () => {
    expect(() => installed({ m11: 1, m12: 2, m21: 2, m22: 4, vx: 1, vy: 1 }))
      .toThrow(expect.objectContaining({ diagnostics: [expect.objectContaining({ code: 'OUT_OF_DOMAIN', path: '$.parameters.m22' })] }));
    expect(byId('singular-collapse').params).toEqual({ m11: 0.5, m12: 1, m21: 1, m22: 2, vx: 1, vy: 1 });
    // Halving M keeps the rank, the image line and the eigen-directions; it halves the eigenvalues.
    const half = expectedQuantities(byId('singular-collapse').params);
    expect([half.rank, half['eigen.values']]).toEqual([1, [2.5, 0]]);
  });

  it('(a) agrees with the independent rational oracle', () => {
    const mismatches = fixture.cases.map(entry => ({ id: entry.id, problems: oracleMismatches(entry) })).filter(result => result.problems.length);
    expect(mismatches).toEqual([]);
  });

  it('the oracle is independent of catalogue and model code, and its exact arithmetic passes hand checks', () => {
    const source = readFileSync(fileURLToPath(new URL('../oracles/linear-transformation.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/^\s*(import|export)\s[^;]*\sfrom\s|^\s*import\s|\bimport\(|\brequire\(/m);
    expect(compare(exactDouble(0.1), { n: 3602879701896397n, d: 2n ** 55n })).toBe(0);
    expect(compare(exactDouble(2 ** -1074), { n: 1n, d: 2n ** 1074n })).toBe(0);
    // The stored rotation entry is the nearest double to √3/2: (c ∓ ulp/2)² brackets 3/4 (ulp of c is 2^-53).
    const c = exactDouble(Math.sqrt(3) / 2), halfUlp = { n: 1n, d: 2n ** 54n }, threeQuarters = { n: 3n, d: 4n };
    const square = (x: typeof c) => times(x, x);
    expect([compare(square(minus(c, halfUlp)), threeQuarters), compare(square(plus(c, halfUlp)), threeQuarters)]).toEqual([-1, 1]);
    // So the stored 30° rotation is not exactly a rotation: det = c² + 1/4 ≠ 1, within 2e-16 of 1.
    const det = determinant(byId('rotation-30').params);
    expect(sign(minus(det, { n: 1n, d: 1n }))).not.toBe(0);
    expect(Math.abs(nearestDouble(det) - 1)).toBeLessThan(2e-16);
    // Perfect squares have exact roots; 2^-1060 rounds to a subnormal exactly; 0.1·2.1 − 0.7·0.3 is nonzero as stored.
    expect(rootOf({ n: 25n, d: 4n })).toSatisfy((root: { n: bigint; d: bigint }) => root.n * 2n === 5n * root.d);
    expect(nearestDouble({ n: 1n, d: 2n ** 1060n })).toBe(2 ** -1060);
    expect(sign(determinant({ m11: 0.1, m12: 0.7, m21: 0.3, m22: 2.1, vx: 0, vy: 0 }))).toBe(1);
  });

  it('(b) the kernel, through the worker evaluation path, matches every case without leaking hidden results', () => {
    expect(compareSuite(installed)).toEqual([]);
  });

  it('every fixture frame passes validateKernelOutput as a static frame of plain finite data', () => {
    for (const entry of fixture.cases) {
      const output = direct(entry.params);
      const checked = validateKernelOutput(validated, STATIC, output);
      expect(checked.terminal, entry.id).toEqual({ reached: false });
      expect(JSON.stringify(output), entry.id).not.toMatch(/NaN|Infinity|null/);
      expect(Object.keys(output.quantities).sort()).toEqual(Object.keys(manifest.quantities).sort());
      expect(Object.keys(output.geometry).sort()).toEqual(Object.keys(manifest.geometry).sort());
    }
  });

  it('(c) agrees with the oracle on every quantity and on exact geometry across a deterministic sweep', () => {
    // Rational quantities are exact and rounded once, so they must match bit for bit; irrational eigen data within the
    // fixture tolerance for irrational values.
    const exact: Tolerance = { absolute: 0, relative: 0 }, irrational: Tolerance = { absolute: 0, relative: 1e-12 };
    const IRRATIONAL = new Set(['eigen.values', 'eigen.direction1', 'eigen.direction2', 'image.direction']);
    let seed = 20261026;
    const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
    const DYADIC = [-3, -2.5, -2, -1.5, -1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 1, 1.5, 2, 2.5, 3];
    const DECIMAL = [-2.1, -0.7, -0.3, -0.1, 0.1, 0.3, 0.6, 0.7, 0.8, 2.1];
    const value = (kind: number): number => [
      () => pick(DYADIC), () => pick(DECIMAL), () => random() * 6 - 3, () => pick([-1, 1]) * 2 ** -Math.floor(random() * 1074),
    ][kind]!();
    const structured = (kind: number, i: number): number[] => {
      const [a, b, c, d] = [value(kind), value(kind), value(kind), value(kind)];
      switch (i % 6) {
        case 0: return [a, b, 0, a]; // triangular with equal diagonal: defective or scalar
        case 1: return [a, 0, 0, a]; // scalar
        case 2: return [a * c / 4, a * d / 4, b * c / 4, b * d / 4]; // outer product: rank ≤ 1
        case 3: return [a, -b, b, a]; // rotation–scaling: complex unless b = 0
        default: return [a, b, c, d];
      }
    };
    const failures: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < 1200; i++) {
      const [m11, m12, m21, m22] = structured(i % 4, i);
      const params = { m11: m11!, m12: m12!, m21: m21!, m22: m22!, vx: value(i % 4), vy: value((i + 1) % 4) };
      if (Object.values(params).some(item => !(item >= -3 && item <= 3))) continue;
      const output = direct(params);
      validateKernelOutput(validated, STATIC, output);
      const reference = expectedQuantities(params);
      seen.add(`${reference['eigen.category']}/${reference.rank}`);
      const problems = Object.entries(reference).flatMap(([id, wanted]) => expectationDifferences(id, observed(output.quantities[id]), wanted, IRRATIONAL.has(id) ? irrational : exact));
      REFERENCE_GRID.forEach((segment, j) => {
        const drawn = segments(output.geometry['grid.transformed'])[j];
        if (JSON.stringify([drawn?.from, drawn?.to]) !== JSON.stringify([mapPoint(params, segment.from), mapPoint(params, segment.to)])) problems.push(`grid ${segment.id}`);
      });
      const square = polygon(output.geometry['unit-square.image'])!;
      if (JSON.stringify(square.vertices) !== JSON.stringify(([[0, 0], [1, 0], [1, 1], [0, 1]] as [number, number][]).map(vertex => mapPoint(params, vertex)))) problems.push('unit square');
      if (square.degenerate !== (reference.orientation === 'collapsed')) problems.push('degenerate flag');
      if (problems.length) failures.push(`${JSON.stringify(params)}: ${problems.join('; ')}`);
    }
    expect(failures.slice(0, 5)).toEqual([]);
    expect([...seen].sort()).toEqual(['complex/2', 'repeated-defective/1', 'repeated-defective/2', 'repeated-scalar/0', 'repeated-scalar/2', 'two-real/1', 'two-real/2']);
  });

  it('binds all geometry to the frame: the unit-square image is spanned by the reported columns and degenerates exactly when det M = 0', () => {
    for (const entry of fixture.cases) {
      const output = direct(entry.params);
      const e1 = valueOf(output.quantities['image.e1'])!, e2 = valueOf(output.quantities['image.e2'])!;
      const square = polygon(output.geometry['unit-square.image'])!;
      expect(square.vertices[0], entry.id).toEqual([0, 0]);
      expect([square.vertices[1], square.vertices[3]], entry.id).toEqual([e1, e2]);
      expect(square.vertices[2], entry.id).toEqual(mapPoint(entry.params, [1, 1]));
      expect(square.degenerate, entry.id).toBe(observed(output.quantities.orientation) === 'collapsed');
      expect(observed(output.quantities.rank) === 2, entry.id).toBe(!square.degenerate);
      expect(segments(output.geometry['grid.original']).map(segment => segment.id)).toEqual(segments(output.geometry['grid.transformed']).map(segment => segment.id));
    }
  });

  it('reports undefined states as statuses with codes and reasons, never as zero vectors or invented directions', () => {
    const check = (id: string, quantity: string, code: string) => {
      const result = direct(byId(id).params).quantities[quantity]!;
      expect(result, `${id} ${quantity}`).toMatchObject({ status: 'undefined', code, reason: expect.stringMatching(/\S{3}/) });
      expect('value' in result).toBe(false);
    };
    check('rotation-30', 'eigen.values', 'COMPLEX_EIGENVALUES');
    check('rotation-30', 'eigen.direction1', 'COMPLEX_EIGENVALUES');
    check('identity', 'eigen.direction1', 'ALL_DIRECTIONS');
    check('zero-matrix', 'eigen.direction2', 'ALL_DIRECTIONS');
    check('shear', 'eigen.direction2', 'SINGLE_DIRECTION');
    check('identity', 'image.direction', 'FULL_RANK');
    check('zero-matrix', 'image.direction', 'ZERO_IMAGE');
    expect(segments(direct(byId('rotation-30').params).geometry['eigen.lines'])).toEqual([]);
    expect(segments(direct(byId('identity').params).geometry['eigen.lines'])).toEqual([]);
    expect(segments(direct(byId('shear').params).geometry['eigen.lines']).map(segment => segment.id)).toEqual(['u1']);
    // A nonzero determinant below the double range is a numerical limit, not a collapse.
    const tiny = direct(byId('underflow-determinant').params).quantities;
    expect(tiny.determinant).toMatchObject({ status: 'numerical-limit', code: 'UNDERFLOW' });
    expect([observed(tiny.orientation), observed(tiny.rank)]).toEqual(['preserved', 2]);
  });

  it('reports a zero test vector and the image of anything under the zero matrix as the valid zero vector', () => {
    for (const id of ['zero-test-vector', 'zero-matrix']) {
      const result = installed(byId(id).params).quantities['image.v']!;
      expect(result, id).toEqual({ status: 'valid', value: [0, 0] });
      expect((result as { value: number[] }).value.every(component => Object.is(component, 0)), id).toBe(true);
    }
    expect(installed(byId('zero-test-vector').params).quantities['vector.v']).toEqual({ status: 'valid', value: [0, 0] });
    // Negative zero entries are reported as +0 in every quantity and every geometry coordinate (JSON would hide −0).
    const negativeZeros = (value: unknown): number => (typeof value === 'number' ? Number(Object.is(value, -0))
      : value && typeof value === 'object' ? Object.values(value).reduce((total: number, item) => total + negativeZeros(item), 0) : 0);
    for (const params of [{ m11: -0, m12: -0, m21: -0, m22: -0, vx: -0, vy: -0 }, { m11: -0, m12: 1, m21: -0, m22: -0, vx: -0, vy: 2 }, byId('rotation-120').params])
      expect(negativeZeros(direct(params)), JSON.stringify(params)).toBe(0);
  });

  it('is pure, deterministic and rejects inputs the runtime must reject first', () => {
    const params = Object.freeze({ ...byId('default-nonsymmetric').params });
    expect(direct(params)).toEqual(direct(params));
    expect(params).toEqual(byId('default-nonsymmetric').params);
    expect(() => direct({ ...params, m11: 3.0000000000000004 })).toThrow(RangeError);
    expect(() => kernel.evaluate({ params, index: 1 })).toThrow(RangeError);
    expect(() => direct({ ...params, vy: Number.NaN })).toThrow(RangeError);
    expect(() => installed({ ...params, m11: 3.0000000000000004 })).toThrow(expect.objectContaining({ diagnostics: [expect.objectContaining({ code: 'OUT_OF_DOMAIN', path: '$.parameters.m11' })] }));
    expect(() => installed({ ...params, vx: Number.NaN })).toThrow(expect.objectContaining({ diagnostics: [expect.objectContaining({ code: 'INVALID_INPUT' })] }));
    expect(() => evaluateRequest({ manifest, params, position: { kind: 'index', index: 0 } }, [kernel])).toThrow(expect.objectContaining({ diagnostics: [expect.objectContaining({ code: 'INVALID_INPUT' })] }));
    // The boundary values themselves are allowed experiments.
    expect(installed({ m11: 3, m12: -3, m21: 3, m22: -3, vx: -3, vy: 3 }).quantities.orientation).toEqual({ status: 'valid', value: 'collapsed' });
  });
});

describe('linear-transformation fixture mutation sensitivity (report §12.6)', () => {
  const valid = (value: number | number[] | string): QuantityResult => ({ status: 'valid', value });
  const num = (result: QuantityResult | undefined): number => (result?.status === 'valid' && typeof result.value === 'number' ? result.value : Number.NaN);
  const patch = (change: (params: LinearParams, output: KernelOutput) => { quantities?: Record<string, QuantityResult>; geometry?: Record<string, GeometryResult> }): Evaluate =>
    params => {
      const output = direct(params);
      const changed = change(params, output);
      return { quantities: { ...output.quantities, ...changed.quantities }, geometry: { ...output.geometry, ...changed.geometry } };
    };
  const orientationFrom = (det: number) => valid(det > 0 ? 'preserved' : det < 0 ? 'reversed' : 'collapsed');

  const mutants: Record<string, { evaluate: Evaluate; mustFail: string[] }> = {
    'transposed convention: rows used as the images of e₁ and e₂': {
      evaluate: params => direct({ ...params, m12: params.m21, m21: params.m12 }),
      mustFail: ['shear', 'shear-lower', 'singular-nonsymmetric', 'rotation-30', 'default-nonsymmetric'],
    },
    'determinant computed as m11·m22 + m12·m21': {
      evaluate: patch(({ m11, m12, m21, m22 }) => {
        const det = m11 * m22 + m12 * m21;
        return { quantities: { determinant: valid(det), 'area.scale': valid(Math.abs(det)), orientation: orientationFrom(det) } };
      }),
      mustFail: ['rotation-30', 'reflection-diagonal', 'singular-collapse', 'reflection-line-2-1'],
    },
    'area scale reported as the signed determinant (negative area)': {
      evaluate: patch((_params, output) => ({ quantities: { 'area.scale': output.quantities.determinant! } })),
      mustFail: ['reflection-x-axis', 'reflection-diagonal', 'scaling-reflection', 'golden'],
    },
    'orientation ignores the sign of the determinant': {
      evaluate: patch((_params, output) => ({ quantities: { orientation: valid(num(output.quantities.determinant) === 0 ? 'collapsed' : 'preserved') } })),
      mustFail: ['reflection-x-axis', 'reflection-diagonal', 'reflection-line-2-1', 'scaling-reflection', 'near-singular-negative'],
    },
    'real eigenvectors claimed for a rotation (eigen data of the symmetric part)': {
      evaluate: patch((params, output) => {
        if (observed(output.quantities['eigen.category']) !== 'complex') return {};
        const mean = (params.m12 + params.m21) / 2;
        const symmetric = direct({ ...params, m12: mean, m21: mean });
        const ids = ['eigen.category', 'eigen.values', 'eigen.direction1', 'eigen.direction2'];
        return { quantities: Object.fromEntries(ids.map(id => [id, symmetric.quantities[id]!])), geometry: { 'eigen.lines': symmetric.geometry['eigen.lines']! } };
      }),
      mustFail: ['rotation-30', 'rotation-120', 'zero-test-vector', 'near-repeated-complex'],
    },
    'defective shear reported with two unchanged directions': {
      evaluate: patch((_params, output) => {
        if (observed(output.quantities['eigen.category']) !== 'repeated-defective') return {};
        const [x, y] = valueOf(output.quantities['eigen.direction1']) as Vec2;
        return { quantities: { 'eigen.category': valid('two-real'), 'eigen.direction2': valid([-y + 0, x]) } };
      }),
      mustFail: ['shear', 'shear-lower', 'nilpotent'],
    },
    'matrix–vector product with a sign error': {
      evaluate: patch(({ m11, m12, m21, m22, vx, vy }) => ({ quantities: { 'image.v': valid([m11 * vx - m12 * vy, m21 * vx - m22 * vy]) } })),
      mustFail: ['identity', 'shear', 'default-nonsymmetric'],
    },
    'area scale off by a factor of 1/2 (triangle area)': {
      evaluate: patch((_params, output) => ({ quantities: { 'area.scale': valid(Math.abs(num(output.quantities.determinant)) / 2) } })),
      mustFail: ['identity', 'scaling-reflection', 'zero-test-vector'],
    },
    'collapse decided with an absolute tolerance on det M (boundary handling)': {
      evaluate: patch((_params, output) => (Math.abs(num(output.quantities.determinant)) < 1e-12 ? { quantities: { orientation: valid('collapsed'), rank: valid(1) } } : {})),
      mustFail: ['near-singular-positive', 'near-singular-negative', 'decimal-near-singular'],
    },
    'repeated-eigenvalue boundary misclassified: Δ = 0 treated as complex': {
      evaluate: patch((_params, output) => {
        if (observed(output.quantities['eigen.category']) !== 'repeated-defective') return {};
        const none: QuantityResult = { status: 'undefined', code: 'COMPLEX_EIGENVALUES', reason: 'Mutant.' };
        return { quantities: { 'eigen.category': valid('complex'), 'eigen.values': none, 'eigen.direction1': none, 'eigen.direction2': none }, geometry: { 'eigen.lines': { kind: 'segments2', segments: [] } } };
      }),
      mustFail: ['shear', 'shear-lower', 'nilpotent'],
    },
    'hidden output leaked: transformed grid emitted under the reference-grid geometry': {
      evaluate: patch((_params, output) => ({ geometry: { 'grid.original': output.geometry['grid.transformed']! } })),
      mustFail: ['shear', 'rotation-30', 'zero-matrix'],
    },
    'hidden output leaked: M·v emitted under the test-vector quantity': {
      evaluate: patch((_params, output) => ({ quantities: { 'vector.v': output.quantities['image.v']! } })),
      mustFail: ['shear', 'rotation-30', 'zero-matrix'],
    },
    'hidden output leaked: an eigen-direction emitted under a basis vector': {
      evaluate: patch((_params, output) => (output.quantities['eigen.direction1']?.status === 'valid' ? { quantities: { 'basis.e1': output.quantities['eigen.direction1'] } } : {})),
      mustFail: ['default-nonsymmetric', 'reflection-diagonal', 'singular-collapse'],
    },
    'zero test vector reported as undefined': {
      evaluate: patch(({ vx, vy }) => (vx === 0 && vy === 0 ? { quantities: { 'image.v': { status: 'undefined', code: 'ZERO_VECTOR', reason: 'Mutant.' } } } : {})),
      mustFail: ['zero-test-vector'],
    },
    'zero matrix given rank 1': {
      evaluate: patch((_params, output) => ({ quantities: { rank: valid(num(output.quantities.determinant) === 0 ? 1 : 2) } })),
      mustFail: ['zero-matrix'],
    },
    'underflowed determinant reported as exact zero': {
      evaluate: patch((_params, output) => (output.quantities.determinant?.status === 'numerical-limit' ? { quantities: { determinant: valid(0), 'area.scale': valid(0) } } : {})),
      mustFail: ['underflow-determinant'],
    },
    'unit-square image never marked degenerate': {
      evaluate: patch((_params, output) => ({ geometry: { 'unit-square.image': { ...polygon(output.geometry['unit-square.image'])!, degenerate: false } } })),
      mustFail: ['singular-collapse', 'zero-matrix', 'nilpotent'],
    },
  };

  it('the unmodified kernel passes the comparison used for mutants', () => {
    expect(compareSuite(direct)).toEqual([]);
  });
  it('has at least six mutants covering signs, factors, transposition, boundaries and hidden-output leakage', () => {
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
