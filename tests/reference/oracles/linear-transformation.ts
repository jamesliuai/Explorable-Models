/**
 * Independent reference oracle for the 2×2 linear-transformation activity (report §12.2).
 *
 * Written separately from the installed kernel and deliberately imports nothing (not `packages/`, not other oracles).
 * Every IEEE-754 input is converted to its exact rational value and every rational quantity — images, M·v,
 * determinant, area, trace, discriminant, orientation, rank, eigen category, rational eigenvalues, the rank-1 image
 * line — is computed exactly and only then rounded (ties to even) to the double a correct implementation must report.
 * Irrational values use a different method from the kernel: λ± = (tr ± √disc)/2 evaluated directly with a square
 * root accurate to 2400 bits (enough that cancellation cannot matter for any stored entries in [−3, 3]), and each
 * eigen-direction is the null vector of M − λI chosen as the larger-norm of (b, λ − a) and (λ − d, c), normalized
 * with the same high-precision root. Those values are references within 2^-2000 relative before the final rounding.
 *
 * Declared model semantics checked here: column-vector convention (M·e₁ = (m11, m21) is the first column);
 * det M = m11·m22 − m12·m21; area scale = |det M| (never negative); orientation preserved / reversed / collapsed by
 * the exact sign of det M; rank 0/1/2; eigen category from the exact discriminant (tr M)² − 4·det M and whether M is
 * exactly λ·I; unit directions report the representative whose first nonzero component is positive.
 */

/** Exact rational n/d with d > 0 (not reduced; comparisons cross-multiply). */
export interface Rational { readonly n: bigint; readonly d: bigint }

const make = (n: bigint, d = 1n): Rational => {
  if (d === 0n) throw new RangeError('Zero denominator.');
  return d < 0n ? { n: -n, d: -d } : { n, d };
};
export const ZERO = make(0n);
const powerOfTwo = (d: bigint): boolean => (d & (d - 1n)) === 0n;
/** Sum; two power-of-two denominators are brought to the larger one, so dyadic values stay small. */
export function plus(x: Rational, y: Rational): Rational {
  if (x.d === y.d) return make(x.n + y.n, x.d);
  if (powerOfTwo(x.d) && powerOfTwo(y.d)) return x.d > y.d ? make(x.n + y.n * (x.d / y.d), x.d) : make(x.n * (y.d / x.d) + y.n, y.d);
  return make(x.n * y.d + y.n * x.d, x.d * y.d);
}
export const minus = (x: Rational, y: Rational): Rational => plus(x, negate(y));
export const times = (x: Rational, y: Rational): Rational => make(x.n * y.n, x.d * y.d);
export const over = (x: Rational, y: Rational): Rational => make(x.n * y.d, x.d * y.n);
export const negate = (x: Rational): Rational => make(-x.n, x.d);
export const sign = (x: Rational): -1 | 0 | 1 => (x.n < 0n ? -1 : x.n > 0n ? 1 : 0);
export const compare = (x: Rational, y: Rational): -1 | 0 | 1 => sign(minus(x, y));
export const isZero = (x: Rational): boolean => x.n === 0n;
const integer = (k: number): Rational => make(BigInt(k));

/** Exact rational value of a finite double, read from its bit pattern. */
export function exactDouble(value: number): Rational {
  if (!Number.isFinite(value)) throw new RangeError('Only finite doubles have an exact rational value.');
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const word = view.getBigUint64(0);
  const exponentBits = Number((word >> 52n) & 2047n);
  let significand = word & ((1n << 52n) - 1n);
  let exponent = -1074;
  if (exponentBits !== 0) { significand += 1n << 52n; exponent = exponentBits - 1075; }
  const signed = word >> 63n === 1n ? -significand : significand;
  return exponent >= 0 ? make(signed << BigInt(exponent)) : make(signed, 1n << BigInt(-exponent));
}

const binaryDigits = (value: bigint): number => (value === 0n ? 0 : value.toString(2).length);

/** 2^e as a double for −1074 ≤ e ≤ 1023, built only from exact operations. */
function twoTo(e: number): number {
  if (e >= 0) return Number(1n << BigInt(e));
  if (e >= -1022) return 1 / Number(1n << BigInt(-e));
  return (1 / Number(1n << 1022n)) / Number(1n << BigInt(-e - 1022));
}

/** Correctly rounded double (ties to even) of an exact rational, including subnormals; 0 when a nonzero value flushes. */
export function nearestDouble(value: Rational): number {
  if (value.n === 0n) return 0;
  const negative = value.n < 0n;
  const num = negative ? -value.n : value.n, den = value.d;
  // Find e with 2^52 ≤ |value|·2^-e < 2^53, then clamp to the subnormal quantum.
  let e = binaryDigits(num) - binaryDigits(den) - 53;
  const parts = (k: number): [bigint, bigint] => (k >= 0 ? [num, den << BigInt(k)] : [num << BigInt(-k), den]);
  for (;;) {
    const [a, b] = parts(e);
    if (a < b << 52n) e -= 1;
    else if (a >= b << 53n) e += 1;
    else break;
  }
  if (e < -1074) e = -1074;
  if (e > 971) throw new RangeError('Values in this activity never exceed the double range.');
  const [a, b] = parts(e);
  let q = a / b;
  const twice = 2n * (a - q * b);
  if (twice > b || (twice === b && q % 2n === 1n)) q += 1n;
  const magnitude = Number(q) * twoTo(e);
  return negative ? -magnitude : magnitude;
}

const MIN_NORMAL = 2 ** -1022;
/** Status a correct implementation reports for an exact (or 2^-2000-accurate) value. */
export type NumberStatus = 'valid' | 'valid:UNDERFLOW' | 'numerical-limit:UNDERFLOW';
export function numberStatus(value: Rational): NumberStatus {
  if (value.n === 0n) return 'valid';
  const rounded = Math.abs(nearestDouble(value));
  return rounded === 0 ? 'numerical-limit:UNDERFLOW' : rounded < MIN_NORMAL ? 'valid:UNDERFLOW' : 'valid';
}

/**
 * ⌊√n⌋ for a nonnegative integer: Newton's iteration from a floating-point estimate scaled into range, followed by an
 * exact correction and an explicit check of root² ≤ n < (root + 1)², so the result never rests on the iteration alone.
 */
function floorSqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError('Negative radicand.');
  if (n < 2n) return n;
  const shift = 2 * Math.max(0, Math.floor((binaryDigits(n) - 900) / 2));
  const estimate = (BigInt(Math.floor(Math.sqrt(Number(n >> BigInt(shift))))) << BigInt(shift / 2)) || 1n;
  // One unconditional step lands at or above ⌊√n⌋ (AM–GM); from there the iteration decreases monotonically to it.
  let root = (estimate + n / estimate) / 2n;
  for (let step = 0; step < 4096; step++) {
    const next = (root + n / root) / 2n;
    if (next >= root) break;
    root = next;
  }
  while (root * root > n) root -= 1n;
  while ((root + 1n) * (root + 1n) <= n) root += 1n;
  if (!(root * root <= n && (root + 1n) * (root + 1n) > n)) throw new Error('Integer square root failed its check.');
  return root;
}

/** Square root of a nonnegative rational with relative error below 2^-precision (exact for perfect squares). */
export function rootOf(value: Rational, precision = 2400): Rational {
  if (value.n < 0n) throw new RangeError('Negative radicand.');
  if (value.n === 0n) return ZERO;
  // √(n/d) = √(n·d)/d; scale n·d by 4^k so that the integer root has at least `precision` bits.
  const product = value.n * value.d;
  const k = Math.max(0, precision - Math.floor(binaryDigits(product) / 2) + 2);
  const scaled = product << BigInt(2 * k);
  return make(floorSqrt(scaled), value.d << BigInt(k));
}

// ---------------------------------------------------------------------------------------------
// The model, computed independently
// ---------------------------------------------------------------------------------------------
export type LinearParams = { m11: number; m12: number; m21: number; m22: number; vx: number; vy: number };
export type Orientation = 'preserved' | 'reversed' | 'collapsed';
export type EigenCategory = 'two-real' | 'repeated-scalar' | 'repeated-defective' | 'complex';
type Pair = [Rational, Rational];

function entries(params: LinearParams) {
  return { a: exactDouble(params.m11), b: exactDouble(params.m12), c: exactDouble(params.m21), d: exactDouble(params.m22), x: exactDouble(params.vx), y: exactDouble(params.vy) };
}
/** M·(x, y) with the column-vector convention: x·(first column) + y·(second column). */
export function applyExact(params: LinearParams, x: Rational, y: Rational): Pair {
  const { a, b, c, d } = entries(params);
  return [plus(times(a, x), times(b, y)), plus(times(c, x), times(d, y))];
}
export const determinant = (params: LinearParams): Rational => { const { a, b, c, d } = entries(params); return minus(times(a, d), times(b, c)); };
export const trace = (params: LinearParams): Rational => { const { a, d } = entries(params); return plus(a, d); };
export const discriminant = (params: LinearParams): Rational => minus(times(trace(params), trace(params)), times(integer(4), determinant(params)));
export function orientation(params: LinearParams): Orientation {
  const s = sign(determinant(params));
  return s > 0 ? 'preserved' : s < 0 ? 'reversed' : 'collapsed';
}
export function rank(params: LinearParams): 0 | 1 | 2 {
  const { a, b, c, d } = entries(params);
  if ([a, b, c, d].every(isZero)) return 0;
  return isZero(determinant(params)) ? 1 : 2;
}
export function eigenCategory(params: LinearParams): EigenCategory {
  const { a, b, c, d } = entries(params);
  if (isZero(b) && isZero(c) && compare(a, d) === 0) return 'repeated-scalar';
  const s = sign(discriminant(params));
  return s > 0 ? 'two-real' : s === 0 ? 'repeated-defective' : 'complex';
}
const half = (x: Rational): Rational => make(x.n, x.d * 2n);

/** Real eigenvalues λ₁ ≥ λ₂ with multiplicity (exact when rational, 2^-2000-accurate otherwise), or null when complex. */
export function eigenvalues(params: LinearParams): Pair | null {
  const category = eigenCategory(params);
  if (category === 'complex') return null;
  if (category === 'repeated-scalar') { const { a } = entries(params); return [a, a]; }
  const root = rootOf(discriminant(params));
  return [half(plus(trace(params), root)), half(minus(trace(params), root))];
}

/** Unit vector of a nonzero pair, with the first nonzero component made positive. */
function unit([x, y]: Pair): Pair {
  const flip = sign(x) < 0 || (isZero(x) && sign(y) < 0);
  const [px, py] = flip ? [negate(x), negate(y)] : [x, y];
  const length = rootOf(plus(times(px, px), times(py, py)));
  return [over(px, length), over(py, length)];
}
const squaredNorm = ([x, y]: Pair): Rational => plus(times(x, x), times(y, y));

/** A null vector of M − λI: the larger-norm of (b, λ − a) and (λ − d, c). */
function nullVector(params: LinearParams, lambda: Rational): Pair {
  const { a, b, c, d } = entries(params);
  const first: Pair = [b, minus(lambda, a)], second: Pair = [minus(lambda, d), c];
  return compare(squaredNorm(first), squaredNorm(second)) >= 0 ? first : second;
}

export type DirectionResult = { status: 'valid'; value: Pair } | { status: 'undefined'; code: string };
/** Unit eigen-directions u₁ (for λ₁) and u₂ (for λ₂), or the undefined code the model declares. */
export function eigenDirections(params: LinearParams): [DirectionResult, DirectionResult] {
  const category = eigenCategory(params);
  if (category === 'complex') return [{ status: 'undefined', code: 'COMPLEX_EIGENVALUES' }, { status: 'undefined', code: 'COMPLEX_EIGENVALUES' }];
  if (category === 'repeated-scalar') return [{ status: 'undefined', code: 'ALL_DIRECTIONS' }, { status: 'undefined', code: 'ALL_DIRECTIONS' }];
  const values = eigenvalues(params)!;
  const first: DirectionResult = { status: 'valid', value: unit(nullVector(params, values[0])) };
  if (category === 'repeated-defective') return [first, { status: 'undefined', code: 'SINGLE_DIRECTION' }];
  return [first, { status: 'valid', value: unit(nullVector(params, values[1])) }];
}

/** The line a rank-1 matrix collapses the plane onto, or the undefined code. */
export function imageDirection(params: LinearParams): DirectionResult {
  const r = rank(params);
  if (r === 2) return { status: 'undefined', code: 'FULL_RANK' };
  if (r === 0) return { status: 'undefined', code: 'ZERO_IMAGE' };
  const { a, b, c, d } = entries(params);
  const first: Pair = [a, c], second: Pair = [b, d];
  return { status: 'valid', value: unit(compare(squaredNorm(first), squaredNorm(second)) >= 0 ? first : second) };
}

// ---------------------------------------------------------------------------------------------
// Expectations in the fixture format
// ---------------------------------------------------------------------------------------------
/**
 * One expected quantity: a number, numeric vector or category (valid, no note); `{ undefined: code }`;
 * `{ limit: 'UNDERFLOW' }` (a nonzero value that rounds to zero); or `{ value, approximation: 'UNDERFLOW' }`
 * (a valid subnormal value).
 */
export type Expectation =
  | number | number[] | string
  | { undefined: string }
  | { limit: 'UNDERFLOW' }
  | { value: number | number[]; approximation: 'UNDERFLOW' };

function expectNumbers(values: Rational[]): Expectation {
  const statuses = values.map(numberStatus);
  if (statuses.includes('numerical-limit:UNDERFLOW')) return { limit: 'UNDERFLOW' };
  const numbers = values.map(value => nearestDouble(value) + 0);
  const value = numbers.length === 1 ? numbers[0]! : numbers;
  return statuses.includes('valid:UNDERFLOW') ? { value, approximation: 'UNDERFLOW' } : value;
}
const expectDirection = (result: DirectionResult): Expectation => (result.status === 'valid' ? expectNumbers(result.value) : { undefined: result.code });

/** Every model quantity as a correct implementation reports it for these stored inputs. */
export function expectedQuantities(params: LinearParams): Record<string, Expectation> {
  const { x, y } = entries(params);
  const det = determinant(params);
  const values = eigenvalues(params);
  const [u1, u2] = eigenDirections(params);
  const absDet = sign(det) < 0 ? negate(det) : det;
  return {
    'basis.e1': [1, 0],
    'basis.e2': [0, 1],
    // Copies of the stored inputs are exact, so even a subnormal entry carries no approximation note.
    'vector.v': [params.vx + 0, params.vy + 0],
    'image.e1': [params.m11 + 0, params.m21 + 0],
    'image.e2': [params.m12 + 0, params.m22 + 0],
    'image.v': expectNumbers(applyExact(params, x, y)),
    determinant: expectNumbers([det]),
    'area.scale': expectNumbers([absDet]),
    orientation: orientation(params),
    rank: rank(params),
    'image.direction': expectDirection(imageDirection(params)),
    trace: expectNumbers([trace(params)]),
    'eigen.discriminant': expectNumbers([discriminant(params)]),
    'eigen.category': eigenCategory(params),
    'eigen.values': values ? expectNumbers(values) : { undefined: 'COMPLEX_EIGENVALUES' },
    'eigen.direction1': expectDirection(u1),
    'eigen.direction2': expectDirection(u2),
  };
}

/** Reference grid segments: x = k from (k, −3) to (k, 3), then y = k from (−3, k) to (3, k), k = −3…3. */
export const REFERENCE_GRID: { id: string; from: [number, number]; to: [number, number] }[] = [
  ...[-3, -2, -1, 0, 1, 2, 3].map(k => ({ id: `x=${k}`, from: [k, -3] as [number, number], to: [k, 3] as [number, number] })),
  ...[-3, -2, -1, 0, 1, 2, 3].map(k => ({ id: `y=${k}`, from: [-3, k] as [number, number], to: [3, k] as [number, number] })),
];
export const REFERENCE_SQUARE: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];

/** M applied to an integer point, rounded once per coordinate. */
export function mapPoint(params: LinearParams, [x, y]: [number, number]): [number, number] {
  const [px, py] = applyExact(params, integer(x), integer(y));
  return [nearestDouble(px) + 0, nearestDouble(py) + 0];
}

/**
 * Outputs that must depend on the stored inputs alone and carry no transformed or derived result: the reference
 * grid and square, the standard basis, the test vector and the columns of M (which are the visible entries). A
 * kernel that writes any hidden result into one of them leaks it through a group shown before exposure.
 */
export function parameterOnlyOutputs(params: LinearParams) {
  return {
    quantities: {
      'basis.e1': [1, 0], 'basis.e2': [0, 1],
      'vector.v': [params.vx + 0, params.vy + 0],
      'image.e1': [params.m11 + 0, params.m21 + 0],
      'image.e2': [params.m12 + 0, params.m22 + 0],
    } as Record<string, number[]>,
    geometry: {
      'grid.original': { kind: 'segments2', segments: REFERENCE_GRID.map(({ id, from, to }) => ({ id, from: [...from], to: [...to] })) },
      'unit-square': { kind: 'polygon2', vertices: REFERENCE_SQUARE.map(([x, y]) => [x, y]), degenerate: false },
    } as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------------------------
// Fixture self-consistency
// ---------------------------------------------------------------------------------------------
export interface Tolerance { absolute: number; relative: number }
export interface LinearFixtureCase {
  id: string;
  label: string;
  provenance: string;
  params: LinearParams;
  expected: {
    quantities: Record<string, Expectation>;
    unitSquareImage: { vertices: [number, number][]; degenerate: boolean };
  };
  tolerance: Tolerance;
}
export interface LinearFixture { suiteId: string; cases: LinearFixtureCase[] }

export const within = (observed: unknown, expected: number, tolerance: Tolerance): boolean =>
  typeof observed === 'number' && Number.isFinite(observed) && Math.abs(observed - expected) <= tolerance.absolute + tolerance.relative * Math.abs(expected);

/** Differences between two expectations; numbers within the tolerance, everything else exactly. */
export function expectationDifferences(label: string, observed: Expectation, wanted: Expectation, tolerance: Tolerance): string[] {
  const numbers = (value: unknown): number[] | null => (typeof value === 'number' ? [value] : Array.isArray(value) && value.every(item => typeof item === 'number') ? value : null);
  const shape = (value: Expectation): string => (typeof value !== 'object' || Array.isArray(value) ? 'value' : Object.keys(value).sort().join('+'));
  if (shape(observed) !== shape(wanted)) return [`${label}: ${JSON.stringify(observed)}, expected ${JSON.stringify(wanted)}`];
  const left = typeof observed === 'object' && !Array.isArray(observed) ? observed : { value: observed };
  const right = typeof wanted === 'object' && !Array.isArray(wanted) ? wanted : { value: wanted };
  const problems: string[] = [];
  for (const [key, expected] of Object.entries(right)) {
    const actual = (left as Record<string, unknown>)[key];
    const expectedNumbers = numbers(expected), actualNumbers = numbers(actual);
    if (expectedNumbers && actualNumbers) {
      if (expectedNumbers.length !== actualNumbers.length || (typeof expected === 'number') !== (typeof actual === 'number')
        || expectedNumbers.some((item, i) => !within(actualNumbers[i], item, tolerance)))
        problems.push(`${label}: ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    } else if (actual !== expected) problems.push(`${label}.${key}: ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
  return problems;
}

/**
 * Mismatches between a fixture case and this oracle. Every stored expectation must agree with the oracle (numbers
 * within the case tolerance, categories, codes and statuses exactly), and the stored unit-square image must be the
 * image of the reference square with `degenerate` exactly when det M = 0. An empty list means the case is consistent.
 */
export function oracleMismatches(entry: LinearFixtureCase): string[] {
  const problems: string[] = [];
  const reference = expectedQuantities(entry.params);
  for (const [id, stored] of Object.entries(entry.expected.quantities)) {
    if (!Object.hasOwn(reference, id)) { problems.push(`${id}: not a model quantity`); continue; }
    problems.push(...expectationDifferences(id, stored, reference[id]!, entry.tolerance));
  }
  const square = entry.expected.unitSquareImage;
  REFERENCE_SQUARE.forEach((vertex, i) => {
    const [x, y] = mapPoint(entry.params, vertex);
    const stored = square.vertices[i];
    if (!stored || !within(stored[0], x, entry.tolerance) || !within(stored[1], y, entry.tolerance)) problems.push(`unitSquareImage.vertices[${i}]: ${JSON.stringify(stored)}, oracle ${JSON.stringify([x, y])}`);
  });
  if (square.vertices.length !== REFERENCE_SQUARE.length) problems.push('unitSquareImage: expected four vertices');
  if (square.degenerate !== isZero(determinant(entry.params))) problems.push(`unitSquareImage.degenerate: fixture ${square.degenerate}`);
  for (const [id, value] of Object.entries(entry.params)) if (!Number.isFinite(value) || value < -3 || value > 3) problems.push(`params.${id} is outside [−3, 3]`);
  return problems;
}
