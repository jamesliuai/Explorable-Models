/**
 * Independent reference oracle for the quadratic surface and gradient (report §12.5).
 *
 * Written separately from the installed kernel and deliberately imports nothing. Every finite IEEE-754 input is
 * converted to its exact (dyadic) rational value and every model value is computed exactly over BigInt; only then is
 * it rounded (ties to even, subnormals included) to the double a correct implementation must report. Square roots are
 * rounded correctly by bracketing the exact root between two integer square roots until both ends round alike.
 *
 * Declared model semantics checked here:
 * - f(x, y) = (a·x² + 2b·x·y + c·y²)/2 and ∇f(x, y) = (a·x + b·y, b·x + c·y), exactly, for the double inputs;
 * - the runtime accepts coefficients when fl(fl(a·c) − fl(b·b)) > 0, i.e. when the rounded product a·c exceeds the
 *   rounded product b·b; accepted coefficients are positive definite (exact a·c − b² > 0);
 * - the gradient direction is undefined (ZERO_GRADIENT) exactly when p = (0, 0); elsewhere it is ∇f/|∇f|;
 * - a positive value that rounds to 0 is a numerical limit (UNDERFLOW); a value below 2^-1022 is a valid
 *   approximation (UNDERFLOW); a gradient vector with such a component carries the approximation;
 * - the arrow scale is the first of 1, 1/2, 1/5, 1/10, 1/20, 1/50, … with s·M ≤ 9/20, where M is the longest
 *   gradient on the grid x, y ∈ {−2, −1.5, …, 2};
 * - grids: surface (i − 20)/10 for i ≤ 40, field (i − 4)/2 for i ≤ 8, sections (i − 40)/20 for i ≤ 80.
 */

/** Exact rational n/d with d > 0 (not reduced; comparisons cross-multiply). */
export interface Rational { readonly n: bigint; readonly d: bigint }

const make = (n: bigint, d = 1n): Rational => {
  if (d === 0n) throw new RangeError('Zero denominator.');
  return d < 0n ? { n: -n, d: -d } : { n, d };
};
export const ZERO = make(0n);
export const ONE = make(1n);
export const ratio = (n: number, d: number): Rational => make(BigInt(n), BigInt(d));
export const add = (x: Rational, y: Rational): Rational => make(x.n * y.d + y.n * x.d, x.d * y.d);
export const sub = (x: Rational, y: Rational): Rational => make(x.n * y.d - y.n * x.d, x.d * y.d);
export const mul = (x: Rational, y: Rational): Rational => make(x.n * y.n, x.d * y.d);
export const div = (x: Rational, y: Rational): Rational => make(x.n * y.d, x.d * y.n);
export const abs = (x: Rational): Rational => make(x.n < 0n ? -x.n : x.n, x.d);
export const sign = (x: Rational): -1 | 0 | 1 => (x.n < 0n ? -1 : x.n > 0n ? 1 : 0);
export const cmp = (x: Rational, y: Rational): -1 | 0 | 1 => {
  const left = x.n * y.d, right = y.n * x.d;
  return left < right ? -1 : left > right ? 1 : 0;
};
const bitLength = (value: bigint): number => (value === 0n ? 0 : value.toString(2).length);

/** Exact rational value of a finite double, read from its bit pattern (−0 becomes 0). */
export function fromDouble(value: number): Rational {
  if (!Number.isFinite(value)) throw new RangeError('Only finite doubles have an exact rational value.');
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const raw = view.getBigUint64(0);
  const biased = Number((raw >> 52n) & 0x7ffn);
  let significand = raw & ((1n << 52n) - 1n);
  let power = -1074;
  if (biased !== 0) { significand |= 1n << 52n; power = biased - 1075; }
  if (raw >> 63n === 1n) significand = -significand;
  return power >= 0 ? make(significand << BigInt(power)) : make(significand, 1n << BigInt(-power));
}

/** 2^e as a double for −1074 ≤ e ≤ 1023, built from exact powers of two. */
function twoTo(e: number): number {
  let value = 1;
  for (let k = e; k > 0; k -= 1) value *= 2;
  for (let k = e; k < 0; k += 1) value /= 2;
  return value;
}

/** Correctly rounded double (ties to even) of an exact rational, including subnormals; ±Infinity on overflow. */
export function roundToDouble(value: Rational): number {
  if (value.n === 0n) return 0;
  const negative = value.n < 0n;
  const n = negative ? -value.n : value.n, d = value.d;
  // Choose e with 2^52 ≤ |value|·2^−e < 2^53, then never below the subnormal quantum 2^−1074.
  let e = bitLength(n) - bitLength(d) - 53;
  const scaled = (k: number): [bigint, bigint] => (k >= 0 ? [n, d << BigInt(k)] : [n << BigInt(-k), d]);
  for (;;) {
    const [num, den] = scaled(e);
    if (num < den << 52n) e -= 1;
    else if (num >= den << 53n) e += 1;
    else break;
  }
  if (e < -1074) e = -1074;
  const [num, den] = scaled(e);
  let quotient = num / den;
  const twice = 2n * (num - quotient * den);
  if (twice > den || (twice === den && (quotient & 1n) === 1n)) quotient += 1n;
  if (quotient === 1n << 53n) { quotient = 1n << 52n; e += 1; }
  if (e > 971) return negative ? -Infinity : Infinity;
  const magnitude = Number(quotient) * twoTo(e);
  return negative ? -magnitude : magnitude;
}

/** Integer square root ⌊√n⌋ for n ≥ 0 (Newton's method). */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError('Negative radicand.');
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(bitLength(n) / 2));
  for (;;) {
    const next = (x + n / x) >> 1n;
    if (next >= x) return x;
    x = next;
  }
}

/**
 * Correctly rounded √q for q ≥ 0. √(n/d) = √(n·d)/d lies in [s, s + 1)/(d·2^k) with s = ⌊√(n·d·4^k)⌋; k grows until
 * both ends round to the same double. A rational root is exact (s² = n·d·4^k); an irrational root is never a
 * rounding midpoint, so the loop ends.
 */
export function sqrtToDouble(q: Rational): number {
  if (q.n < 0n) throw new RangeError('Negative radicand.');
  if (q.n === 0n) return 0;
  const m = q.n * q.d;
  for (let k = Math.max(0, 80 + bitLength(q.d) - (bitLength(m) >> 1)); ; k += 64) {
    const radicand = m << BigInt(2 * k);
    const s = isqrt(radicand), denominator = q.d << BigInt(k);
    const low = roundToDouble(make(s, denominator));
    if (s * s === radicand) return low;
    if (low === roundToDouble(make(s + 1n, denominator))) return low;
  }
}

// ---------------------------------------------------------------------------------------------
// The model, exactly
// ---------------------------------------------------------------------------------------------
/** Canonical parameter values (a type alias, so it is also a plain record of numbers). */
export type SurfaceParams = { a: number; b: number; c: number; px: number; py: number };
interface Coefficients { a: Rational; b: Rational; c: Rational }
const coefficients = ({ a, b, c }: SurfaceParams): Coefficients => ({ a: fromDouble(a), b: fromDouble(b), c: fromDouble(c) });
const TWO = make(2n);

/** f(x, y) = (a·x² + 2b·x·y + c·y²)/2, exactly. */
export function exactF(params: SurfaceParams, x: Rational, y: Rational): Rational {
  const { a, b, c } = coefficients(params);
  return div(add(add(mul(a, mul(x, x)), mul(TWO, mul(b, mul(x, y)))), mul(c, mul(y, y))), TWO);
}
/** ∇f(x, y) = (a·x + b·y, b·x + c·y), exactly. */
export function exactGradient(params: SurfaceParams, x: Rational, y: Rational): [Rational, Rational] {
  const { a, b, c } = coefficients(params);
  return [add(mul(a, x), mul(b, y)), add(mul(b, x), mul(c, y))];
}
export const exactDeterminant = (params: SurfaceParams): Rational => {
  const { a, b, c } = coefficients(params);
  return sub(mul(a, c), mul(b, b));
};
/** The runtime's declared acceptance test fl(fl(a·c) − fl(b·b)) > 0, decided from exactly rounded products. */
export function declaredAccepts(params: SurfaceParams): boolean {
  const { a, b, c } = coefficients(params);
  return roundToDouble(mul(a, c)) > roundToDouble(mul(b, b));
}

export type ScalarStatus = 'valid' | 'valid:UNDERFLOW' | 'numerical-limit:UNDERFLOW';
export type DirectionStatus = 'valid' | 'valid:UNDERFLOW' | 'undefined:ZERO_GRADIENT';
const MIN_NORMAL = twoTo(-1022);
/** Status and reported double of a nonnegative scalar whose correctly rounded value is `rounded` (exact value `exact`). */
function scalarStatus(exactIsZero: boolean, rounded: number): { status: ScalarStatus; value: number | null } {
  if (exactIsZero) return { status: 'valid', value: 0 };
  if (rounded === 0) return { status: 'numerical-limit:UNDERFLOW', value: null };
  return { status: Math.abs(rounded) < MIN_NORMAL ? 'valid:UNDERFLOW' : 'valid', value: rounded };
}

export interface PointExpectation {
  value: number | null;
  gradient: [number, number];
  gradientNorm: number | null;
  direction: [number, number] | null;
  hessianDet: number;
  statuses: { value: ScalarStatus; gradient: 'valid' | 'valid:UNDERFLOW'; 'gradient.norm': ScalarStatus; 'gradient.direction': DirectionStatus };
}

/** Everything a correct implementation reports at the selected point. */
export function expectedPoint(params: SurfaceParams): PointExpectation {
  const x = fromDouble(params.px), y = fromDouble(params.py);
  const f = exactF(params, x, y);
  const [gx, gy] = exactGradient(params, x, y);
  const squared = add(mul(gx, gx), mul(gy, gy));
  const value = scalarStatus(f.n === 0n, roundToDouble(f));
  const norm = scalarStatus(squared.n === 0n, sqrtToDouble(squared));
  const gradient: [number, number] = [roundToDouble(gx) + 0, roundToDouble(gy) + 0];
  const approximate = [gx, gy].some((component, i) => component.n !== 0n && (gradient[i] === 0 || Math.abs(gradient[i]!) < MIN_NORMAL));
  const atOrigin = x.n === 0n && y.n === 0n;
  const unit = (component: Rational): number => sign(component) * sqrtToDouble(div(mul(component, component), squared)) + 0;
  const direction: [number, number] | null = atOrigin ? null : [unit(gx), unit(gy)];
  // The direction is a vector too: a nonzero component reported below 2^-1022 (or as 0) carries the approximation.
  const approximateDirection = !!direction && [gx, gy].some((component, i) => component.n !== 0n && (direction[i] === 0 || Math.abs(direction[i]!) < MIN_NORMAL));
  return {
    value: value.value, gradient, gradientNorm: norm.value, direction, hessianDet: roundToDouble(exactDeterminant(params)),
    statuses: {
      value: value.status, gradient: approximate ? 'valid:UNDERFLOW' : 'valid', 'gradient.norm': norm.status,
      'gradient.direction': atOrigin ? 'undefined:ZERO_GRADIENT' : approximateDirection ? 'valid:UNDERFLOW' : 'valid',
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Grids, arrow scale and contour residuals
// ---------------------------------------------------------------------------------------------
/** Exact grid coordinates (i − half)/divisor for i = 0 … count − 1. */
export const axis = (count: number, half: number, divisor: number): Rational[] => Array.from({ length: count }, (_, i) => ratio(i - half, divisor));
export const SURFACE_AXIS = axis(41, 20, 10);
export const FIELD_AXIS = axis(9, 4, 2);
export const SECTION_AXIS = axis(81, 40, 20);
/** Candidate arrow scales as exact decimals, largest first. */
export const ARROW_LADDER: readonly Rational[] = [[1, 1], [1, 2], [1, 5], [1, 10], [1, 20], [1, 50], [1, 100], [1, 200], [1, 500], [1, 1000]].map(([n, d]) => ratio(n!, d!));
const LONGEST_SQUARED = mul(ratio(9, 20), ratio(9, 20));

/**
 * The declared arrow scale: the first ladder value s with s²·M² ≤ (9/20)², where M² is the largest exact |∇f|² on the
 * field grid. `margin` is the smallest relative gap |s²·M² − (9/20)²|/(9/20)² over the ladder values compared, so a
 * fixture can show that rounding in an implementation cannot change the choice.
 */
export function expectedArrowScale(params: SurfaceParams): { scale: number; margin: number } {
  let longest = ZERO;
  for (const y of FIELD_AXIS) for (const x of FIELD_AXIS) {
    const [gx, gy] = exactGradient(params, x, y);
    const squared = add(mul(gx, gx), mul(gy, gy));
    if (cmp(squared, longest) > 0) longest = squared;
  }
  let margin = Infinity;
  for (const candidate of ARROW_LADDER) {
    const drawn = mul(mul(candidate, candidate), longest);
    margin = Math.min(margin, Math.abs(roundToDouble(div(sub(drawn, LONGEST_SQUARED), LONGEST_SQUARED))));
    if (cmp(drawn, LONGEST_SQUARED) <= 0) return { scale: roundToDouble(candidate), margin };
  }
  throw new RangeError('No arrow scale keeps the field arrows short enough.');
}

/** |f(point) − L|/L for a reported contour point, computed exactly and rounded once. */
export function contourResidual(params: SurfaceParams, level: number, point: readonly [number, number]): number {
  const target = fromDouble(level);
  const f = exactF(params, fromDouble(point[0]), fromDouble(point[1]));
  return roundToDouble(div(abs(sub(f, target)), target));
}

/** Correctly rounded f at exact grid coordinates. */
export const expectedHeight = (params: SurfaceParams, x: Rational, y: Rational): number => roundToDouble(exactF(params, x, y)) + 0;
/** Correctly rounded gradient at exact grid coordinates. */
export const expectedGradientAt = (params: SurfaceParams, x: Rational, y: Rational): [number, number] =>
  exactGradient(params, x, y).map(component => roundToDouble(component) + 0) as [number, number];

/**
 * Eigenvalue ratio λmax/λmin of H in doubles (a tolerance input only, never a model value):
 * λ = (a + c)/2 ± √(((a − c)/2)² + b²), with λmin = det/λmax to avoid cancellation.
 */
export function conditionNumber({ a, b, c }: SurfaceParams): number {
  const largest = (a + c) / 2 + Math.hypot((a - c) / 2, b);
  const determinant = roundToDouble(exactDeterminant({ a, b, c, px: 0, py: 0 }));
  return largest / (determinant / largest);
}

// ---------------------------------------------------------------------------------------------
// Fixture self-consistency
// ---------------------------------------------------------------------------------------------
export interface Tolerance { absolute: number; relative: number }
export interface SurfaceFixtureCase {
  id: string;
  label: string;
  provenance: string;
  params: SurfaceParams;
  expected: PointExpectation & { arrowScale: number };
  /** Rational quantities (f, ∇f, det) and irrational quantities (|∇f|, direction). */
  tolerance: { rational: Tolerance; irrational: Tolerance; contour: { relative: number } };
  /** Contour sample index k at which p lies on the drawn level `level` (gradient ⟂ tangent check). */
  onContour?: { level: number; sample: number };
}
export interface RejectedCase { id: string; label: string; provenance: string; params: SurfaceParams; code: 'CONSTRAINT_VIOLATION' | 'OUT_OF_DOMAIN'; path: string }
export interface SurfaceFixture {
  suiteId: string;
  model: { modelId: string; version: string };
  author: string;
  review: string;
  semantics: string;
  format: string;
  grids: { surface: { n: number; spacing: number }; field: { n: number; spacing: number }; sections: { n: number; spacing: number }; contours: { levels: number[]; samples: number } };
  arrows: { scales: number[]; maxLength: number; disclosure: string };
  tolerances: { grid: Tolerance; perpendicular: { absolute: number } };
  perpendicularProvenance: string;
  cases: SurfaceFixtureCase[];
  rejected: RejectedCase[];
}

/**
 * Mismatches between a fixture case and this oracle. Stored numbers must equal the oracle's correctly rounded doubles
 * exactly (Object.is, so −0 is caught), statuses must match, the arrow scale must be the declared choice with a margin
 * that rounding cannot cross, and the coefficients must be accepted and positive definite.
 */
export function oracleMismatches(entry: SurfaceFixtureCase): string[] {
  const problems: string[] = [];
  const oracle = expectedPoint(entry.params);
  const same = (label: string, stored: unknown, exact: unknown): void => {
    const equal = Array.isArray(exact) && Array.isArray(stored) ? exact.length === stored.length && exact.every((value, i) => Object.is(value, stored[i])) : Object.is(stored, exact);
    if (!equal) problems.push(`${label}: fixture ${JSON.stringify(stored)}, oracle ${JSON.stringify(exact)}`);
  };
  const { expected } = entry;
  same('value', expected.value, oracle.value);
  same('gradient', expected.gradient, oracle.gradient);
  same('gradientNorm', expected.gradientNorm, oracle.gradientNorm);
  same('direction', expected.direction, oracle.direction);
  same('hessianDet', expected.hessianDet, oracle.hessianDet);
  for (const key of Object.keys(oracle.statuses) as (keyof PointExpectation['statuses'])[]) same(`status ${key}`, expected.statuses[key], oracle.statuses[key]);
  const arrow = expectedArrowScale(entry.params);
  same('arrowScale', expected.arrowScale, arrow.scale);
  if (!(arrow.margin > 1e-9)) problems.push(`arrowScale: margin ${arrow.margin} is too close to the threshold`);
  if (!declaredAccepts(entry.params)) problems.push('params: the declared constraint test rejects these coefficients');
  if (sign(exactDeterminant(entry.params)) <= 0) problems.push('params: the coefficients are not positive definite');
  if (entry.onContour) {
    const p: [number, number] = [entry.params.px, entry.params.py];
    if (contourResidual(entry.params, entry.onContour.level, p) !== 0) problems.push(`onContour: p is not on the level ${entry.onContour.level}`);
    const angle = Math.atan2(p[1], p[0]);
    if (Math.abs(((angle + 2 * Math.PI) % (2 * Math.PI)) - (Math.PI * entry.onContour.sample) / 90) > 1e-12) problems.push('onContour: p is not at the stated sample direction');
  }
  return problems;
}
