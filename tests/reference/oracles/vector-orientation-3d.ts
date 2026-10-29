/**
 * Independent reference oracle for spatial vector orientation (report §12.4).
 *
 * Written separately from the installed kernel and deliberately imports nothing. IEEE-754 inputs are read as their
 * exact rational values; dot products, cross products and squared lengths are exact rationals; values a correct
 * implementation reports as doubles are rounded here once (ties to even). The method differs from the kernel's on
 * purpose: |u×v|² is taken from Lagrange's identity |u|²|v|² − (u·v)² (the kernel sums squared components), square
 * roots are found by bisection over double bit patterns with exact midpoint comparisons (the kernel uses an integer
 * square root), and the angle is computed in high-precision fixed point with an argument-halving arctangent series
 * and Machin's formula for π (the kernel calls Math.atan2), so it is a reference value, not a replay.
 *
 * Declared semantics checked here: right-handed frame, u×v = (u_y v_z − u_z v_y, u_z v_x − u_x v_z, u_x v_y − u_y v_x);
 * θ = atan2(|u×v|, u·v) ∈ [0, π] in radians, undefined when u or v is zero; relationship with tolerance τ = 1/10¹²:
 * parallel/antiparallel when |u×v|² ≤ τ²|u|²|v|² (by the sign of u·v), orthogonal when (u·v)² ≤ τ²|u|²|v|², else
 * oblique; the unit direction of u×v exists exactly when u×v ≠ 0.
 */

/** Exact rational n/d with d > 0 (not reduced; comparisons cross-multiply). */
export interface Rational { readonly n: bigint; readonly d: bigint }
const rational = (n: bigint, d = 1n): Rational => {
  if (d === 0n) throw new RangeError('Zero denominator.');
  return d < 0n ? { n: -n, d: -d } : { n, d };
};
export const ZERO = rational(0n);
export const add = (x: Rational, y: Rational): Rational => rational(x.n * y.d + y.n * x.d, x.d * y.d);
export const sub = (x: Rational, y: Rational): Rational => rational(x.n * y.d - y.n * x.d, x.d * y.d);
export const mul = (x: Rational, y: Rational): Rational => rational(x.n * y.n, x.d * y.d);
export const div = (x: Rational, y: Rational): Rational => rational(x.n * y.d, x.d * y.n);
export const cmp = (x: Rational, y: Rational): -1 | 0 | 1 => { const a = x.n * y.d, b = y.n * x.d; return a < b ? -1 : a > b ? 1 : 0; };
export const sign = (x: Rational): -1 | 0 | 1 => (x.n < 0n ? -1 : x.n > 0n ? 1 : 0);
const absolute = (x: Rational): Rational => rational(x.n < 0n ? -x.n : x.n, x.d);

/** Exact rational value of a finite double, read from its 64-bit pattern. */
export function fromDouble(value: number): Rational {
  if (!Number.isFinite(value)) throw new RangeError('Only finite doubles have an exact rational value.');
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const pattern = view.getBigUint64(0);
  const biased = Number((pattern >> 52n) & 0x7ffn);
  const significand = (pattern & ((1n << 52n) - 1n)) | (biased === 0 ? 0n : 1n << 52n);
  const scale = biased === 0 ? -1074 : biased - 1075;
  const signed = pattern >> 63n ? -significand : significand;
  return scale >= 0 ? rational(signed << BigInt(scale)) : rational(signed, 1n << BigInt(-scale));
}

/** Double with a given nonnegative 64-bit pattern (nonnegative doubles are monotone in their pattern). */
function fromPattern(pattern: bigint): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, pattern);
  return view.getFloat64(0);
}
const MAX_PATTERN = 0x7fefffffffffffffn; // Number.MAX_VALUE

/**
 * Nearest nonnegative double (ties to even) to a target described by `compare(x)` = sign(x − target) for exact
 * rationals x: bisection over bit patterns finds the largest double not above the target, then the exact midpoint to
 * the next double decides.
 */
function nearestByBisection(compare: (x: Rational) => -1 | 0 | 1): number {
  let low = 0n, high = MAX_PATTERN;
  if (compare(fromDouble(Number.MAX_VALUE)) < 0) throw new RangeError('Value beyond the double range.');
  while (low < high) {
    const middle = (low + high + 1n) >> 1n;
    if (compare(fromDouble(fromPattern(middle))) <= 0) low = middle; else high = middle - 1n;
  }
  const lower = fromPattern(low);
  if (compare(fromDouble(lower)) === 0) return lower;
  const upper = fromPattern(low + 1n);
  const side = compare(div(add(fromDouble(lower), fromDouble(upper)), rational(2n)));
  return side > 0 ? lower : side < 0 ? upper : (low & 1n) === 0n ? lower : upper;
}

/** Nearest double to an exact rational (ties to even), including subnormals; −0 is never returned. */
export function roundToDouble(value: Rational): number {
  if (value.n === 0n) return 0;
  const magnitude = absolute(value);
  const result = nearestByBisection(x => cmp(x, magnitude));
  return (value.n < 0n ? -result : result) + 0;
}

/** Nearest double to √S for an exact nonnegative rational S (ties to even), comparing exact squares. */
export function sqrtToDouble(square: Rational): number {
  if (square.n < 0n) throw new RangeError('Negative square.');
  return square.n === 0n ? 0 : nearestByBisection(x => cmp(mul(x, x), square));
}

// ---------------------------------------------------------------------------------------------
// Status rules for doubles rounded from exact values
// ---------------------------------------------------------------------------------------------
export type ScalarStatus = 'valid' | 'valid:UNDERFLOW' | 'numerical-limit:UNDERFLOW';
export const SMALLEST_NORMAL = 2 ** -1022;

/** Status of a double rounded once from an exact value: a flushed nonzero is a limit; an inexact subnormal is approximate. */
export function roundedStatus(exactIsZero: boolean, rounded: number, inexact: boolean): ScalarStatus {
  if (!exactIsZero && rounded === 0) return 'numerical-limit:UNDERFLOW';
  return inexact && Math.abs(rounded) < SMALLEST_NORMAL ? 'valid:UNDERFLOW' : 'valid';
}
export function scalarExpectation(value: Rational): { status: ScalarStatus; value: number | null } {
  const rounded = roundToDouble(value);
  const status = roundedStatus(value.n === 0n, rounded, cmp(fromDouble(rounded), value) !== 0);
  return { status, value: status === 'numerical-limit:UNDERFLOW' ? null : rounded };
}
export function lengthExpectation(square: Rational): { status: ScalarStatus; value: number | null } {
  const rounded = sqrtToDouble(square);
  const exact = fromDouble(rounded);
  const status = roundedStatus(square.n === 0n, rounded, cmp(mul(exact, exact), square) !== 0);
  return { status, value: status === 'numerical-limit:UNDERFLOW' ? null : rounded };
}
/** Vector rule: every nonzero component flushed → limit; any flushed or inexact subnormal component → approximate. */
export function vectorExpectation(components: Rational[]): { status: ScalarStatus; value: number[] | null } {
  const parts = components.map(component => ({ ...scalarExpectation(component), rounded: roundToDouble(component) }));
  const values = parts.map(part => part.rounded);
  const flushed = parts.some(part => part.status === 'numerical-limit:UNDERFLOW');
  if (flushed && values.every(value => value === 0)) return { status: 'numerical-limit:UNDERFLOW', value: null };
  return { status: flushed || parts.some(part => part.status === 'valid:UNDERFLOW') ? 'valid:UNDERFLOW' : 'valid', value: values };
}

// ---------------------------------------------------------------------------------------------
// Exact vector algebra
// ---------------------------------------------------------------------------------------------
export interface VectorParams { ux: number; uy: number; uz: number; vx: number; vy: number; vz: number }
export type Vector = [Rational, Rational, Rational];
export const vectorsOf = (p: VectorParams): { u: Vector; v: Vector } =>
  ({ u: [fromDouble(p.ux), fromDouble(p.uy), fromDouble(p.uz)], v: [fromDouble(p.vx), fromDouble(p.vy), fromDouble(p.vz)] });
export const dot = (a: Vector, b: Vector): Rational => add(add(mul(a[0], b[0]), mul(a[1], b[1])), mul(a[2], b[2]));
/** Right-handed cross product written out from the definition (e_x × e_y = e_z). */
export const cross = (a: Vector, b: Vector): Vector => [
  sub(mul(a[1], b[2]), mul(a[2], b[1])),
  sub(mul(a[2], b[0]), mul(a[0], b[2])),
  sub(mul(a[0], b[1]), mul(a[1], b[0])),
];
export const squaredLength = (a: Vector): Rational => dot(a, a);
/** |u×v|² by Lagrange's identity (independent of the component formula). */
export const crossSquared = (u: Vector, v: Vector): Rational => sub(mul(squaredLength(u), squaredLength(v)), mul(dot(u, v), dot(u, v)));

export type Relationship = 'parallel' | 'antiparallel' | 'orthogonal' | 'oblique' | 'undefined-zero-vector';
/** τ² = 1/10²⁴ exactly. */
export const TOLERANCE_SQUARED = rational(1n, 10n ** 24n);

export function relationship(p: VectorParams): Relationship {
  const { u, v } = vectorsOf(p);
  const uu = squaredLength(u), vv = squaredLength(v);
  if (uu.n === 0n || vv.n === 0n) return 'undefined-zero-vector';
  const limit = mul(TOLERANCE_SQUARED, mul(uu, vv)), d = dot(u, v);
  if (cmp(crossSquared(u, v), limit) <= 0) return sign(d) > 0 ? 'parallel' : 'antiparallel';
  return cmp(mul(d, d), limit) <= 0 ? 'orthogonal' : 'oblique';
}

// ---------------------------------------------------------------------------------------------
// High-precision fixed point: integers X standing for X·2^-q
// ---------------------------------------------------------------------------------------------
const GUARD_BITS = 200;
const bitLength = (n: bigint): number => (n === 0n ? 0 : (n < 0n ? -n : n).toString(2).length);
function isqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError('Negative argument.');
  if (n < 2n) return n;
  let x = n, y = (x + 1n) >> 1n;
  while (y < x) { x = y; y = (x + n / x) >> 1n; }
  return x;
}
/** floor(r·2^q) for r ≥ 0. */
const toFixed = (r: Rational, q: number): bigint => (r.n << BigInt(q)) / r.d;
/** atan(1/m)·2^q by its alternating series (Machin terms). */
function arctanInverse(m: bigint, q: number): bigint {
  let term = (1n << BigInt(q)) / m, sum = 0n, k = 0n;
  while (term !== 0n) { sum += (k % 2n === 0n ? term : -term) / (2n * k + 1n); term /= m * m; k += 1n; }
  return sum;
}
export const piFixed = (q: number): bigint => 16n * arctanInverse(5n, q) - 4n * arctanInverse(239n, q);
/** atan(x)·2^q for 0 ≤ x ≤ 1 given as X = x·2^q: halve the argument until x ≤ 1/16, then the Taylor series. */
function arctanFixed(X: bigint, q: number): bigint {
  const one = 1n << BigInt(q);
  let x = X, halvings = 0n;
  while (x > one >> 4n) { x = (x << BigInt(q)) / (one + isqrt((one << BigInt(q)) + x * x)); halvings += 1n; }
  const x2 = (x * x) >> BigInt(q);
  let term = x, sum = 0n, k = 0n;
  while (term !== 0n) { sum += (k % 2n === 0n ? term : -term) / (2n * k + 1n); term = (term * x2) >> BigInt(q); k += 1n; }
  return sum << halvings;
}

/**
 * θ = atan2(|u×v|, u·v) as an exact-scale fixed-point rational (absolute error far below 2^-(q−8) where q adapts so
 * that tiny angles keep about 190 significant bits), or null when u or v is zero.
 */
export function angle(p: VectorParams): Rational | null {
  const { u, v } = vectorsOf(p);
  if (squaredLength(u).n === 0n || squaredLength(v).n === 0n) return null;
  const s = crossSquared(u, v), d = dot(u, v);
  if (s.n === 0n) return sign(d) > 0 ? ZERO : rational(piFixed(GUARD_BITS + 64), 1n << BigInt(GUARD_BITS + 64));
  const d2 = mul(d, d), steep = cmp(d2, s) < 0; // |u·v| < |u×v|: measure from π/2
  const ratio = steep ? div(d2, s) : div(s, d2); // ≤ 1; atan(√ratio) is the offset
  const smallness = Math.max(0, bitLength(ratio.d) - bitLength(ratio.n)) >> 1;
  const q = GUARD_BITS + (steep || sign(d) < 0 ? 0 : smallness) + 64;
  const offset = arctanFixed(isqrt(toFixed(ratio, 2 * q)), q);
  const pi = piFixed(q);
  const theta = steep ? (pi >> 1n) - BigInt(sign(d)) * offset : sign(d) > 0 ? offset : pi - offset;
  return rational(theta, 1n << BigInt(q));
}

/** Unit direction of u×v rounded per component, or null when u×v = 0 exactly. Absolute error well below 2^-150. */
export function crossDirection(p: VectorParams): number[] | null {
  const { u, v } = vectorsOf(p);
  const c = cross(u, v), s = crossSquared(u, v);
  if (s.n === 0n) return null;
  // Scale-free: c_k/|c| = (c_k·2^q)/√(s·2^2q) with q chosen from the magnitude of s.
  const q = GUARD_BITS + Math.max(0, (bitLength(s.d) - bitLength(s.n)) >> 1) + 64;
  const length = isqrt(toFixed(s, 2 * q));
  return c.map(component => {
    const scaled = sign(component) < 0 ? -toFixed(absolute(component), q) : toFixed(component, q);
    return roundToDouble(rational(scaled, length));
  });
}

// ---------------------------------------------------------------------------------------------
// Expected values for one case and fixture self-consistency
// ---------------------------------------------------------------------------------------------
export type Status = ScalarStatus | 'undefined:ZERO_VECTOR' | 'undefined:NO_CROSS_DIRECTION';
export interface Expectation { status: Status; value: number | number[] | string | null }

/** Every quantity a correct implementation reports for these inputs, from the definitions above. */
export function expectations(p: VectorParams): Record<string, Expectation> {
  const { u, v } = vectorsOf(p);
  const theta = angle(p), direction = crossDirection(p);
  let angleExpectation: Expectation = { status: 'undefined:ZERO_VECTOR', value: null };
  if (theta) {
    const rounded = roundToDouble(theta);
    const exactZeroOrPi = crossSquared(u, v).n === 0n;
    // A nonzero θ is never a double: cos θ is algebraic, so by Lindemann–Weierstrass θ ≠ 0 is transcendental.
    const status = roundedStatus(exactZeroOrPi && sign(dot(u, v)) > 0, rounded, !(exactZeroOrPi && sign(dot(u, v)) > 0));
    angleExpectation = { status, value: status === 'numerical-limit:UNDERFLOW' ? null : rounded };
  }
  const plainVector = (values: number[]): number[] => values.map(value => value + 0);
  return {
    u: { status: 'valid', value: plainVector([p.ux, p.uy, p.uz]) },
    v: { status: 'valid', value: plainVector([p.vx, p.vy, p.vz]) },
    'u.norm': lengthExpectation(squaredLength(u)),
    'v.norm': lengthExpectation(squaredLength(v)),
    dot: scalarExpectation(dot(u, v)),
    angle: angleExpectation,
    relationship: { status: 'valid', value: relationship(p) },
    cross: vectorExpectation(cross(u, v)),
    'cross.norm': lengthExpectation(crossSquared(u, v)),
    'cross.direction': direction ? { status: 'valid', value: direction } : { status: 'undefined:NO_CROSS_DIRECTION', value: null },
    'u.xy': { status: 'valid', value: plainVector([p.ux, p.uy]) }, 'v.xy': { status: 'valid', value: plainVector([p.vx, p.vy]) },
    'u.xz': { status: 'valid', value: plainVector([p.ux, p.uz]) }, 'v.xz': { status: 'valid', value: plainVector([p.vx, p.vz]) },
    'u.yz': { status: 'valid', value: plainVector([p.uy, p.uz]) }, 'v.yz': { status: 'valid', value: plainVector([p.vy, p.vz]) },
  };
}

export interface Tolerance { absolute: number; relative: number }
export interface VectorFixtureCase {
  id: string;
  label: string;
  provenance: string;
  params: VectorParams;
  expected: { statuses: Record<string, Status>; values: Record<string, number | number[] | string | null>; arc: 'drawn' | 'none' };
  /** `exact`: dot, cross, lengths, components; `angle`: θ; `direction`: unit direction of u×v and arc points. */
  tolerance: { exact: Tolerance; angle: Tolerance; direction: Tolerance };
}
export interface VectorFixture { suiteId: string; classificationTolerance: string; arc: { samples: number; maxRadius: number; radiusFraction: number }; cases: VectorFixtureCase[] }

/** Whether a correct implementation draws the angle arc: only for a unique plane (u×v ≠ 0) and a representable angle. */
export const arcDrawn = (p: VectorParams): boolean => {
  const values = expectations(p);
  return values['cross.direction']!.status === 'valid' && values.angle!.status !== 'numerical-limit:UNDERFLOW';
};

/**
 * Mismatches between a fixture case and this oracle. Stored doubles must equal the oracle's rounded values exactly
 * (−0 and +0 are distinguished), statuses and categories must match, and the arc flag must agree. Empty when
 * self-consistent.
 */
export function oracleMismatches(entry: VectorFixtureCase): string[] {
  const problems: string[] = [];
  const expected = expectations(entry.params);
  const same = (a: unknown, b: unknown): boolean =>
    Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((item, i) => Object.is(item, b[i])) : Object.is(a, b);
  for (const [id, wanted] of Object.entries(expected)) {
    if (entry.expected.statuses[id] !== wanted.status) problems.push(`${id}: status ${String(entry.expected.statuses[id])}, oracle ${wanted.status}`);
    if (!same(entry.expected.values[id] ?? null, wanted.value)) problems.push(`${id}: value ${JSON.stringify(entry.expected.values[id])}, oracle ${JSON.stringify(wanted.value)}`);
  }
  const extra = [...Object.keys(entry.expected.statuses), ...Object.keys(entry.expected.values)].filter(id => !(id in expected));
  if (extra.length) problems.push(`unknown quantities: ${extra.join(', ')}`);
  if ((entry.expected.arc === 'drawn') !== arcDrawn(entry.params)) problems.push(`arc: fixture ${entry.expected.arc}, oracle ${arcDrawn(entry.params) ? 'drawn' : 'none'}`);
  const params = Object.values(entry.params);
  if (params.length !== 6 || params.some(value => typeof value !== 'number' || !(value >= -3 && value <= 3))) problems.push('params must be six components in [-3, 3]');
  return problems;
}
