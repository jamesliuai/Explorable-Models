/**
 * Independent reference oracle for quadratic gradient descent (report §12.3).
 *
 * Written separately from the installed kernel and deliberately imports nothing from `packages/`. Every value is
 * exact rational arithmetic over BigInt: IEEE-754 inputs are converted to their exact rational values, results are
 * computed exactly, and only then rounded (ties to even) to the double a correct implementation must report.
 *
 * Declared model semantics checked here: f(x) = a·x²/2 with a > 0, x[n+1] = (1 − p)·x[n] where the step product
 * p = η·a is the IEEE-754 double product of the two inputs (computed once; this oracle performs that rounding itself
 * from the exact product). The multiplier r = 1 − p, the positions x[n] = x0·rⁿ, the gradient a·x[n] and the loss
 * a·x[n]²/2 are exact real values for those inputs. The regime is a property of (x0, p) alone, never of iterates
 * or displayed digits. The declared input domain (single bounds, the coupled bound p ≤ 4 and the iteration bound)
 * and the parameter-only outputs shown before any reveal (the objective curve at its declared samples and the starting
 * point (x0, f(x0))) are stated here as well, so tests can check them without the candidate kernel.
 */

/** Exact rational n/d with d > 0. Never reduced (reduction of huge powers is slow); comparisons cross-multiply. */
export interface Rational { readonly n: bigint; readonly d: bigint }

const rational = (n: bigint, d = 1n): Rational => {
  if (d === 0n) throw new RangeError('Zero denominator.');
  return d < 0n ? { n: -n, d: -d } : { n, d };
};
export const ZERO = rational(0n);
export const ONE = rational(1n);
export const TWO = rational(2n);
export const add = (x: Rational, y: Rational): Rational => rational(x.n * y.d + y.n * x.d, x.d * y.d);
export const sub = (x: Rational, y: Rational): Rational => rational(x.n * y.d - y.n * x.d, x.d * y.d);
export const mul = (x: Rational, y: Rational): Rational => rational(x.n * y.n, x.d * y.d);
export const div = (x: Rational, y: Rational): Rational => rational(x.n * y.d, x.d * y.n);
export const pow = (x: Rational, k: number): Rational => {
  if (!Number.isSafeInteger(k) || k < 0) throw new RangeError('Exponent must be a nonnegative integer.');
  return rational(x.n ** BigInt(k), x.d ** BigInt(k));
};
export const abs = (x: Rational): Rational => rational(x.n < 0n ? -x.n : x.n, x.d);
export const sign = (x: Rational): -1 | 0 | 1 => (x.n < 0n ? -1 : x.n > 0n ? 1 : 0);
export const cmp = (x: Rational, y: Rational): -1 | 0 | 1 => {
  const left = x.n * y.d, right = y.n * x.d;
  return left < right ? -1 : left > right ? 1 : 0;
};

/** Exact rational value of a finite IEEE-754 double, read from its bit pattern. */
export function fromDouble(value: number): Rational {
  if (!Number.isFinite(value)) throw new RangeError('Only finite doubles have an exact rational value.');
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const negative = bits >> 63n === 1n;
  const biased = Number((bits >> 52n) & 0x7ffn);
  let significand = bits & ((1n << 52n) - 1n);
  let scale = -1074;
  if (biased !== 0) { significand |= 1n << 52n; scale = biased - 1075; }
  const signed = negative ? -significand : significand;
  return scale >= 0 ? rational(signed << BigInt(scale)) : rational(signed, 1n << BigInt(-scale));
}

/** Exact power of two as a double, for −1074 ≤ e ≤ 971 (each step below is an exact IEEE operation). */
function powerOfTwo(e: number): number {
  if (e >= 0) return Number(1n << BigInt(e));
  if (e >= -1022) return 1 / Number(1n << BigInt(-e));
  return (1 / Number(1n << 1022n)) * (1 / Number(1n << BigInt(-e - 1022)));
}
const bitLength = (value: bigint): number => value.toString(2).length;

/**
 * Correctly rounded (ties to even) double nearest to an exact rational, including the subnormal range.
 * Returns ±Infinity when IEEE-754 rounding overflows and ±0 when it flushes to zero.
 */
export function roundToDouble(value: Rational): number {
  if (value.n === 0n) return 0;
  const negative = value.n < 0n;
  const n = negative ? -value.n : value.n, d = value.d;
  // Choose e so that 2^52 ≤ |value|·2^−e < 2^53, then clamp to the subnormal quantum 2^−1074.
  let e = bitLength(n) - bitLength(d) - 53;
  const scaled = (exponent: number): [bigint, bigint] => (exponent >= 0 ? [n, d << BigInt(exponent)] : [n << BigInt(-exponent), d]);
  for (;;) {
    const [num, den] = scaled(e);
    if (num < den << 52n) e -= 1;
    else if (num >= den << 53n) e += 1;
    else break;
  }
  if (e < -1074) e = -1074;
  if (e > 971) return negative ? -Infinity : Infinity;
  const [num, den] = scaled(e);
  let quotient = num / den;
  const twiceRemainder = 2n * (num - quotient * den);
  if (twiceRemainder > den || (twiceRemainder === den && (quotient & 1n) === 1n)) quotient += 1n;
  const magnitude = Number(quotient) * powerOfTwo(e);
  return negative ? -magnitude : magnitude;
}

export const MAX_FINITE = fromDouble(Number.MAX_VALUE);
const MIN_NORMAL = 2 ** -1022;

export type Regime = 'zero-start' | 'stationary' | 'monotone-convergence' | 'one-step' | 'alternating-convergence' | 'oscillation' | 'divergence';
export type ExactStatus = 'valid' | 'valid:UNDERFLOW' | 'numerical-limit:OVERFLOW' | 'numerical-limit:UNDERFLOW';
export type SequenceQuantity = 'position' | 'loss' | 'gradient';
export type QuadraticParams = { a: number; eta: number; x0: number };

/** The declared step product p = η·a: the exact product of the two inputs, rounded once to a double. */
export function declaredProduct(params: QuadraticParams): Rational {
  return fromDouble(roundToDouble(mul(fromDouble(params.eta), fromDouble(params.a))));
}
export const multiplier = (params: QuadraticParams): Rational => sub(ONE, declaredProduct(params));
export const threshold = (params: QuadraticParams): Rational => div(TWO, fromDouble(params.a));

/** Regime from the declared conditions on (x0, p); x0 = 0 takes precedence because the sequence is then identically 0. */
export function regime(params: QuadraticParams): Regime {
  if (fromDouble(params.x0).n === 0n) return 'zero-start';
  const p = declaredProduct(params);
  if (p.n === 0n) return 'stationary';
  const toOne = cmp(p, ONE), toTwo = cmp(p, TWO);
  return toOne < 0 ? 'monotone-convergence' : toOne === 0 ? 'one-step' : toTwo < 0 ? 'alternating-convergence' : toTwo === 0 ? 'oscillation' : 'divergence';
}

/** Exact value of a sequence quantity at iteration n. */
export function exactQuantity(params: QuadraticParams, quantity: SequenceQuantity, n: number): Rational {
  const a = fromDouble(params.a);
  const x = mul(fromDouble(params.x0), pow(multiplier(params), n));
  if (quantity === 'position') return x;
  if (quantity === 'gradient') return mul(a, x);
  return div(mul(a, mul(x, x)), TWO);
}

/** Status a correct implementation reports for an exact value: overflow is |v| > Number.MAX_VALUE exactly. */
export function exactStatus(value: Rational): ExactStatus {
  if (value.n === 0n) return 'valid';
  if (cmp(abs(value), MAX_FINITE) > 0) return 'numerical-limit:OVERFLOW';
  const rounded = Math.abs(roundToDouble(value));
  if (rounded === 0) return 'numerical-limit:UNDERFLOW';
  return rounded < MIN_NORMAL ? 'valid:UNDERFLOW' : 'valid';
}

/** The double a correct implementation reports, or null when the status is a numerical limit. */
export function expectedNumber(value: Rational): number | null {
  return exactStatus(value).startsWith('numerical-limit') ? null : roundToDouble(value) + 0;
}

/**
 * Last index ≤ maxIndex before the first exact overflow of a quantity, or null when it never overflows there.
 * |q[n]| = |q[0]|·|r|^(kn) with k ∈ {1, 2}: nondecreasing in n when |r| ≥ 1 (binary search is valid) and bounded by
 * the finite |q[0]| when |r| < 1.
 */
export function lastFiniteIndex(params: QuadraticParams, quantity: SequenceQuantity, maxIndex: number): number | null {
  const overflows = (n: number): boolean => exactStatus(exactQuantity(params, quantity, n)) === 'numerical-limit:OVERFLOW';
  if (cmp(abs(multiplier(params)), ONE) < 0 || !overflows(maxIndex)) return null;
  let finite = 0, overflowing = maxIndex;
  if (overflows(finite)) throw new RangeError('The initial value already overflows.');
  while (overflowing - finite > 1) {
    const middle = Math.floor((finite + overflowing) / 2);
    if (overflows(middle)) overflowing = middle; else finite = middle;
  }
  return finite;
}

// ---------------------------------------------------------------------------------------------
// Declared input domain (report §12.3: explicit curvature, step-size and iteration bounds)
// ---------------------------------------------------------------------------------------------
/**
 * Declared admissible inputs: a ∈ [1/10, 10], η ∈ [0, 2], x0 ∈ [−10, 10] (exact decimal bounds), integer
 * 0 ≤ n ≤ maxIndex, and the coupled bound p ≤ 4 on the declared step product p (the double product of η and a, the
 * same p the regime uses). For doubles, a ≥ 1/10 is the same test as a ≥ 0.1 as a double: no double lies strictly
 * between 1/10 and the double nearest to it. The coupled bound is on p, not on the exact real product: 0.4 is the
 * double 0.400000000000000022…, so the exact product 0.4·10 exceeds 4 while p = 4 is admissible.
 */
export const DOMAIN = Object.freeze({
  a: [rational(1n, 10n), rational(10n)] as const,
  eta: [ZERO, TWO] as const,
  x0: [rational(-10n), rational(10n)] as const,
  maxProduct: rational(4n),
});
export type Rejection = { code: 'OUT_OF_DOMAIN'; parameter: 'a' | 'eta' | 'x0' } | { code: 'OUT_OF_DOMAIN'; parameter: 'index' } | { code: 'CONSTRAINT_VIOLATION' };

/** Why the declared domain excludes these inputs (single bounds before the coupled bound), or null when admissible. */
export function rejection(params: QuadraticParams, index: number, maxIndex: number): Rejection | null {
  for (const parameter of ['a', 'eta', 'x0'] as const) {
    const value = fromDouble(params[parameter]);
    const [low, high] = DOMAIN[parameter];
    if (cmp(value, low) < 0 || cmp(value, high) > 0) return { code: 'OUT_OF_DOMAIN', parameter };
  }
  if (cmp(declaredProduct(params), DOMAIN.maxProduct) > 0) return { code: 'CONSTRAINT_VIOLATION' };
  if (!Number.isInteger(index) || index < 0 || index > maxIndex) return { code: 'OUT_OF_DOMAIN', parameter: 'index' };
  return null;
}

// ---------------------------------------------------------------------------------------------
// Parameter-only outputs: what the learner sees before any reveal (objective curve and starting point)
// ---------------------------------------------------------------------------------------------
/** Declared sampling of the objective curve: 201 evenly spaced positions from −10 to 10. */
export const CURVE = Object.freeze({ samples: 201, low: -10, high: 10 });
/** Exact i-th declared sample position low + (high − low)·i/(samples − 1); here (i − 100)/10. */
export function curveSamplePosition(i: number): Rational {
  const span = BigInt(CURVE.samples - 1);
  return rational(BigInt(CURVE.low) * (span - BigInt(i)) + BigInt(CURVE.high) * BigInt(i), span);
}
/** Exact objective a·x²/2 at a double position x (for the curve: at the position the frame reports). */
export function objectiveAt(a: number, x: number): Rational {
  const value = fromDouble(x);
  return div(mul(fromDouble(a), mul(value, value)), TWO);
}

// ---------------------------------------------------------------------------------------------
// Fixture self-consistency
// ---------------------------------------------------------------------------------------------
export interface QuadraticFixtureCase {
  id: string;
  label: string;
  provenance: string;
  params: QuadraticParams;
  indices: number[];
  expected: {
    regime?: Regime;
    multiplier?: number;
    threshold?: number;
    positions?: (number | null)[];
    losses?: (number | null)[];
    gradients?: (number | null)[];
    statuses?: Partial<Record<SequenceQuantity, ExactStatus[]>>;
    lastFiniteIndex?: Partial<Record<SequenceQuantity, number>>;
  };
  tolerance: { absolute: number; relative: number };
}
export interface QuadraticFixture { suiteId: string; maxIndex: number; cases: QuadraticFixtureCase[] }

const sequenceKeys = { positions: 'position', losses: 'loss', gradients: 'gradient' } as const;

/**
 * Mismatches between a fixture case and this oracle. Every stored number must be exactly the correctly rounded
 * double of the oracle's exact value, every status and regime must match, and every declared lastFiniteIndex must be
 * the exact one. An empty list means the case is self-consistent.
 */
export function oracleMismatches(fixture: QuadraticFixture, entry: QuadraticFixtureCase): string[] {
  const problems: string[] = [];
  const same = (label: string, stored: number | null | undefined, exact: Rational | null): void => {
    const wanted = exact === null ? null : expectedNumber(exact);
    if (!Object.is(stored, wanted)) problems.push(`${label}: fixture ${String(stored)}, oracle ${String(wanted)}`);
  };
  const { expected, params, indices } = entry;
  if (expected.regime !== undefined && expected.regime !== regime(params)) problems.push(`regime: fixture ${expected.regime}, oracle ${regime(params)}`);
  if (expected.multiplier !== undefined) same('multiplier', expected.multiplier, multiplier(params));
  if (expected.threshold !== undefined) same('threshold', expected.threshold, threshold(params));
  for (const [key, quantity] of Object.entries(sequenceKeys) as [keyof typeof sequenceKeys, SequenceQuantity][]) {
    const values = expected[key];
    if (!values) continue;
    if (values.length !== indices.length) { problems.push(`${key}: length differs from indices`); continue; }
    indices.forEach((n, i) => same(`${quantity}[n=${n}]`, values[i], exactQuantity(params, quantity, n)));
  }
  for (const [quantity, statuses] of Object.entries(expected.statuses ?? {}) as [SequenceQuantity, ExactStatus[]][]) {
    if (statuses.length !== indices.length) { problems.push(`statuses.${quantity}: length differs from indices`); continue; }
    indices.forEach((n, i) => {
      const actual = exactStatus(exactQuantity(params, quantity, n));
      if (statuses[i] !== actual) problems.push(`status ${quantity}[n=${n}]: fixture ${statuses[i]}, oracle ${actual}`);
    });
  }
  for (const [quantity, index] of Object.entries(expected.lastFiniteIndex ?? {}) as [SequenceQuantity, number][]) {
    const actual = lastFiniteIndex(params, quantity, fixture.maxIndex);
    if (index !== actual) problems.push(`lastFiniteIndex.${quantity}: fixture ${index}, oracle ${String(actual)}`);
  }
  if (indices.some(n => !Number.isInteger(n) || n < 0 || n > fixture.maxIndex)) problems.push('indices must be integers in [0, maxIndex]');
  return problems;
}
