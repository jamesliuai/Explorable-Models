/**
 * Independent reference oracle for the function-and-derivative package (report §12.1).
 *
 * Written separately from the installed kernel and deliberately imports nothing from `packages/`. Values are exact
 * rationals over BigInt with arbitrary denominators. A double is converted to its exact value by repeated doubling
 * (doubling a finite double is exact, and some power of two makes it an integer), not by reading its bit pattern.
 * Quantities follow their definitions rather than the kernel's simplified forms:
 * - the derivative is the central difference quotient (f(x + 1) − f(x − 1))/2, which equals f′(x) exactly for every
 *   polynomial of degree at most two;
 * - the secant slope is the literal quotient (f(p + h) − f(p))/h, and its difference from the derivative is the
 *   literal subtraction;
 * - the curvature class comes from the second difference f(1) − 2f(0) + f(−1) = 2A and the first difference;
 * - the vertex solves f′(x) = 0 from those differences.
 * Each exact value is rounded once to the nearest double (ties to even) by scaled integer division.
 *
 * Declared semantics checked here: f(x) = A·x² + B·x + C; P = (p, f(p)); Q = (p + h, f(p + h)) for the exact sum; the
 * domain constraint holds when the double nearest to p + h (the IEEE sum) lies in [−5, 5].
 */

/** Exact rational n/d with d > 0 (not reduced; comparisons cross-multiply). */
export interface Rational { readonly n: bigint; readonly d: bigint }

const make = (n: bigint, d = 1n): Rational => {
  if (d === 0n) throw new RangeError('Zero denominator.');
  return d < 0n ? { n: -n, d: -d } : { n, d };
};
export const integer = (value: number): Rational => make(BigInt(value));
export const plus = (x: Rational, y: Rational): Rational => make(x.n * y.d + y.n * x.d, x.d * y.d);
export const minus = (x: Rational, y: Rational): Rational => make(x.n * y.d - y.n * x.d, x.d * y.d);
export const times = (x: Rational, y: Rational): Rational => make(x.n * y.n, x.d * y.d);
export const over = (x: Rational, y: Rational): Rational => make(x.n * y.d, x.d * y.n);
export const signOf = (x: Rational): -1 | 0 | 1 => (x.n < 0n ? -1 : x.n > 0n ? 1 : 0);
export const same = (x: Rational, y: Rational): boolean => x.n * y.d === y.n * x.d;

/** Exact value of a finite double: double it until it is an integer (each doubling is exact below the overflow bound). */
export function exactValue(value: number): Rational {
  if (!Number.isFinite(value)) throw new RangeError('Only finite doubles have an exact value.');
  let scaled = value, power = 0n;
  while (!Number.isInteger(scaled)) { scaled *= 2; power += 1n; }
  return make(BigInt(scaled), 1n << power);
}

const width = (value: bigint): number => (value === 0n ? 0 : value.toString(2).length);
const MIN_NORMAL = 2.2250738585072014e-308;

/**
 * The double nearest to an exact rational (ties to even), with ±Infinity when rounding passes the largest double and
 * ±0 when a nonzero value rounds to zero. Works by finding s with 2^52 ≤ |x|·2^s < 2^53 (s at most 1074, the
 * subnormal quantum), rounding the integer part, and scaling back by exact powers of two.
 */
export function nearestDouble(x: Rational): number {
  if (x.n === 0n) return 0;
  const negative = x.n < 0n, top = negative ? -x.n : x.n;
  const integerPart = (s: number): bigint => (s >= 0 ? (top << BigInt(s)) / x.d : top / (x.d << BigInt(-s)));
  let s = 53 - (width(top) - width(x.d));
  for (let length = width(integerPart(s)); length !== 53; length = width(integerPart(s))) s += length < 53 ? 1 : -1;
  s = Math.min(s, 1074);
  const numerator = s >= 0 ? top << BigInt(s) : top, denominator = s >= 0 ? x.d : x.d << BigInt(-s);
  let q = numerator / denominator;
  const twice = 2n * (numerator - q * denominator);
  if (twice > denominator || (twice === denominator && q % 2n === 1n)) q += 1n;
  if (q === 0n) return negative ? -0 : 0;
  if (width(q) - s > 1024) return negative ? -Infinity : Infinity;
  const first = Math.min(Math.max(s, 0), 1023);
  const magnitude = s >= 0
    ? Number(q) / Number(1n << BigInt(first)) / Number(1n << BigInt(s - first))
    : Number(q) * Number(1n << BigInt(-s));
  return negative ? -magnitude : magnitude;
}

// ---------------------------------------------------------------------------------------------
// The model, from its definitions
// ---------------------------------------------------------------------------------------------
export type FunctionParams = { A: number; B: number; C: number; p: number; h: number };
export const QUANTITY_IDS = ['probe.x', 'probe.value', 'derivative', 'second.x', 'second.value', 'secant.slope', 'secant.difference', 'slope.sign', 'curvature', 'vertex.x'] as const;
export type QuantityId = typeof QUANTITY_IDS[number];
/** A number is a valid normal (or zero) value; strings are categories; objects are statuses. */
export type Expected = number | string | { undefined: string } | { limit: 'OVERFLOW' | 'UNDERFLOW' } | { subnormal: number };
/** Domain written independently of the manifest (the reference test compares the two). */
export const DOMAIN = { A: [-2, 2], B: [-5, 5], C: [-5, 5], p: [-5, 5], h: [-2, 2], x: [-5, 5] } as const;

const ONE = integer(1), TWO = integer(2);
export const f = (params: FunctionParams, x: Rational): Rational =>
  plus(plus(times(exactValue(params.A), times(x, x)), times(exactValue(params.B), x)), exactValue(params.C));
/** Central difference with step 1: exact for degree ≤ 2. */
export const slopeAt = (params: FunctionParams, x: Rational): Rational => over(minus(f(params, plus(x, ONE)), f(params, minus(x, ONE))), TWO);
export const secondPoint = (params: FunctionParams): Rational => plus(exactValue(params.p), exactValue(params.h));
/** Literal difference quotient through P and Q, or null when h = 0. */
export function secantSlope(params: FunctionParams): Rational | null {
  const h = exactValue(params.h);
  if (h.n === 0n) return null;
  const p = exactValue(params.p);
  return over(minus(f(params, plus(p, h)), f(params, p)), h);
}

/** Status and value a correct implementation reports for an exact numeric value. */
export function expectedNumber(value: Rational): Expected {
  if (value.n === 0n) return 0;
  const rounded = nearestDouble(value);
  if (!Number.isFinite(rounded)) return { limit: 'OVERFLOW' };
  if (rounded === 0) return { limit: 'UNDERFLOW' };
  return Math.abs(rounded) < MIN_NORMAL ? { subnormal: rounded } : rounded;
}

/** Every quantity of the declared model for admissible parameters. */
export function expectedQuantities(params: FunctionParams): Record<QuantityId, Expected> {
  const p = exactValue(params.p), zero = integer(0);
  const derivative = slopeAt(params, p);
  const secant = secantSlope(params);
  const atPlusOne = f(params, ONE), atZero = f(params, zero), atMinusOne = f(params, integer(-1));
  const secondDifference = plus(minus(atPlusOne, times(TWO, atZero)), atMinusOne); // 2A
  const firstDifference = minus(atPlusOne, atZero); // A + B, which is B when A = 0
  const derivativeAtZero = slopeAt(params, zero); // B
  const coincident = { undefined: 'COINCIDENT_POINTS' };
  return {
    'probe.x': params.p + 0,
    'probe.value': expectedNumber(f(params, p)),
    derivative: expectedNumber(derivative),
    'second.x': expectedNumber(secondPoint(params)),
    'second.value': expectedNumber(f(params, secondPoint(params))),
    'secant.slope': secant ? expectedNumber(secant) : coincident,
    'secant.difference': secant ? expectedNumber(minus(secant, derivative)) : coincident,
    'slope.sign': ['decreasing', 'stationary', 'increasing'][signOf(derivative) + 1]!,
    curvature: signOf(secondDifference) > 0 ? 'positive-curvature' : signOf(secondDifference) < 0 ? 'negative-curvature' : signOf(firstDifference) !== 0 ? 'linear' : 'constant',
    'vertex.x': secondDifference.n === 0n ? { undefined: 'NO_VERTEX' } : expectedNumber(over(minus(zero, derivativeAtZero), secondDifference)),
  };
}

/** Drawn coordinate: the nearest double, with a nonzero value below the double range drawn at +0. */
const drawn = (value: Rational): number => nearestDouble(value) + 0;
/** Endpoints at x = −5 and x = 5 of the line through P with the given slope. */
function lineThroughProbe(params: FunctionParams, slope: Rational): [[number, number], [number, number]] {
  const p = exactValue(params.p), fp = f(params, p);
  const at = (x: number): [number, number] => [x, drawn(plus(fp, times(slope, minus(integer(x), p))))];
  return [at(DOMAIN.x[0]), at(DOMAIN.x[1])];
}
export const tangentEndpoints = (params: FunctionParams) => lineThroughProbe(params, slopeAt(params, exactValue(params.p)));
export function secantEndpoints(params: FunctionParams): [[number, number], [number, number]] | [] {
  const slope = secantSlope(params);
  return slope ? lineThroughProbe(params, slope) : [];
}

/** Sample position x_i: the double nearest to −5 + i/40. */
export const sampleX = (i: number): number => nearestDouble(make(BigInt(i - 200), 40n));
export const curveValue = (params: FunctionParams, i: number): Rational => f(params, exactValue(sampleX(i)));
export const derivativeCurveValue = (params: FunctionParams, i: number): Rational => slopeAt(params, exactValue(sampleX(i)));

export type Rejection = { code: 'CONSTRAINT_VIOLATION' | 'OUT_OF_DOMAIN'; path: string };
/** The first rejection the runtime must report: per-parameter bounds first, then the coupled constraint on the double sum. */
export function rejection(params: FunctionParams): Rejection | null {
  for (const id of ['A', 'B', 'C', 'p', 'h'] as const) {
    const [min, max] = DOMAIN[id];
    if (!(params[id] >= min && params[id] <= max)) return { code: 'OUT_OF_DOMAIN', path: `$.parameters.${id}` };
  }
  const sum = nearestDouble(secondPoint(params));
  return sum >= DOMAIN.x[0] && sum <= DOMAIN.x[1] ? null : { code: 'CONSTRAINT_VIOLATION', path: '$.constraints.secant-in-domain' };
}

// ---------------------------------------------------------------------------------------------
// Fixture self-consistency
// ---------------------------------------------------------------------------------------------
export interface FixtureCase {
  id: string;
  label: string;
  provenance: string;
  families: string[];
  params: FunctionParams;
  /** Present for admissible parameters. */
  expected?: Record<QuantityId, Expected>;
  /** Drawn tangent and secant endpoints; the secant is empty when h = 0. */
  lines?: { tangent: [number, number][]; secant: [number, number][] };
  /** Present for parameters the runtime must reject before evaluation. */
  rejected?: Rejection;
  tolerance: { absolute: number; relative: number };
}
export interface Fixture {
  suiteId: string;
  model: { modelId: string; version: string };
  domain: typeof DOMAIN;
  sampling: { samples: number; domain: [number, number]; tolerance: { absolute: number; relative: number } };
  cases: FixtureCase[];
}

const show = (value: unknown): string => JSON.stringify(value);
/**
 * Mismatches between a fixture case and this oracle. Every stored number must be exactly the correctly rounded double
 * of the oracle's exact value, every status, category and rejection must match, and a tolerance of 0 is allowed only
 * when every stored number is exact. An empty list means the case is self-consistent.
 */
export function oracleMismatches(entry: FixtureCase): string[] {
  const problems: string[] = [];
  const reject = rejection(entry.params);
  if (show(entry.rejected ?? null) !== show(reject)) problems.push(`rejected: fixture ${show(entry.rejected)}, oracle ${show(reject)}`);
  if (reject) {
    if (entry.expected || entry.lines) problems.push('a rejected case carries no expected values');
    return problems;
  }
  if (!entry.expected || !entry.lines) return [...problems, 'an admissible case lists expected values and lines'];
  const wanted = expectedQuantities(entry.params);
  for (const id of QUANTITY_IDS) {
    const stored = entry.expected[id], exact = wanted[id];
    if (typeof exact === 'number' ? !Object.is(stored, exact) : show(stored) !== show(exact)) problems.push(`${id}: fixture ${show(stored)}, oracle ${show(exact)}`);
  }
  if (Object.keys(entry.expected).length !== QUANTITY_IDS.length) problems.push('expected lists exactly the model quantities');
  const lines = { tangent: tangentEndpoints(entry.params), secant: secantEndpoints(entry.params) };
  if (show(entry.lines) !== show(lines)) problems.push(`lines: fixture ${show(entry.lines)}, oracle ${show(lines)}`);
  if (entry.tolerance.absolute === 0 && entry.tolerance.relative === 0 && !isExact(entry.params)) problems.push('tolerance 0 is used only when every expected number is exact');
  return problems;
}

/** True when every expected quantity and line endpoint equals its exact value (no rounding happened). */
export function isExact(params: FunctionParams): boolean {
  const p = exactValue(params.p), derivative = slopeAt(params, p), secant = secantSlope(params);
  const values = [f(params, p), derivative, secondPoint(params), f(params, secondPoint(params))];
  if (secant) values.push(secant, minus(secant, derivative));
  const B = slopeAt(params, integer(0)), twoA = plus(minus(f(params, ONE), times(TWO, f(params, integer(0)))), f(params, integer(-1)));
  if (twoA.n !== 0n) values.push(over(minus(integer(0), B), twoA));
  for (const slope of secant ? [derivative, secant] : [derivative])
    for (const x of DOMAIN.x) values.push(plus(f(params, p), times(slope, minus(integer(x), p))));
  return values.every(value => { const rounded = nearestDouble(value); return Number.isFinite(rounded) && same(exactValue(rounded + 0), value); });
}
