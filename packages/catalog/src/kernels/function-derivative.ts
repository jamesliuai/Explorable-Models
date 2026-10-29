/**
 * Installed pure kernel: a quadratic function, its analytical derivative, a probe point with its tangent, and a
 * secant through a second point (report §12.1).
 *
 * Declared semantics (shared with the reference fixture, not with its oracle's code): f(x) = A·x² + B·x + C with the
 * analytical derivative f′(x) = 2A·x + B. Inputs are IEEE-754 doubles taken at their exact values. The probe is
 * P = (p, f(p)) and the second point is Q = (p + h, f(p + h)) for the exact sum p + h. Every reported quantity is the
 * exact real value for those inputs rounded to the nearest double once: polynomial quantities are evaluated exactly in
 * dyadic arithmetic (a BigInt significand with a binary exponent) and the vertex −B/(2A) is one correctly rounded
 * IEEE division. For h ≠ 0 the secant slope (f(p + h) − f(p))/h is evaluated through its exact algebraic
 * simplification 2A·p + B + A·h, so small offsets suffer no cancellation; for h = 0 it is undefined
 * (`COINCIDENT_POINTS`) and is never replaced by the derivative. Categories come from exact signs, never from rounded
 * or displayed values.
 *
 * Numerical limits are statuses, never values: a nonzero exact value that rounds to zero is `numerical-limit`/
 * `UNDERFLOW`, a subnormal result is valid with an `UNDERFLOW` approximation note, and a vertex beyond the double range
 * (a nonzero A far below 1) is `numerical-limit`/`OVERFLOW`. The sampled curves are drawing aids evaluated in double
 * precision; tangent and secant lines are drawn from correctly rounded endpoints.
 */
import type { GeometryResult, KernelInput, KernelOutput, ModelKernel, QuantityResult, Vec2 } from '@experiment-kit/core/model';

export const FUNCTION_DERIVATIVE_KERNEL_ID = 'function-derivative';
export const FUNCTION_DERIVATIVE_KERNEL_VERSION = '1.0.0';
/** Canonical (dimensionless) parameter domain; `x` is the plotted domain, which must also contain p + h. */
export const FUNCTION_DERIVATIVE_DOMAIN = Object.freeze({ A: [-2, 2], B: [-5, 5], C: [-5, 5], p: [-5, 5], h: [-2, 2], x: [-5, 5] } as const);
/** Samples of f and f′ for the curves: x_i is the double nearest to −5 + i/40, i = 0 … 400. */
export const FUNCTION_DERIVATIVE_CURVE = Object.freeze({ samples: 401, domain: [-5, 5] as const });
export const FUNCTION_DERIVATIVE_SLOPE_SIGNS = ['increasing', 'decreasing', 'stationary'] as const;
export const FUNCTION_DERIVATIVE_CURVATURES = ['positive-curvature', 'negative-curvature', 'linear', 'constant'] as const;
export type SlopeSign = typeof FUNCTION_DERIVATIVE_SLOPE_SIGNS[number];
export type CurvatureClass = typeof FUNCTION_DERIVATIVE_CURVATURES[number];

/** Curvature class from the declared conditions on the coefficients. */
export function classifyCurvature(A: number, B: number): CurvatureClass {
  if (A > 0) return 'positive-curvature';
  if (A < 0) return 'negative-curvature';
  return B !== 0 ? 'linear' : 'constant';
}

// ---------------------------------------------------------------------------------------------
// Exact dyadic arithmetic: value = n·2^e. Sums and products of doubles stay dyadic, so no rounding happens here.
// ---------------------------------------------------------------------------------------------
interface Dyadic { readonly n: bigint; readonly e: number }
const ZERO: Dyadic = Object.freeze({ n: 0n, e: 0 });
const bits = /* @__PURE__ */ new DataView(new ArrayBuffer(8));

/** Exact value of a finite double, read from its bit pattern. */
function exact(x: number): Dyadic {
  if (x === 0) return ZERO;
  bits.setFloat64(0, x);
  const high = bits.getUint32(0), low = bits.getUint32(4);
  const biased = (high >>> 20) & 0x7ff;
  const fraction = (BigInt(high & 0xfffff) << 32n) | BigInt(low);
  const n = biased === 0 ? fraction : fraction | (1n << 52n);
  return { n: high >>> 31 ? -n : n, e: biased === 0 ? -1074 : biased - 1075 };
}
function add(x: Dyadic, y: Dyadic): Dyadic {
  if (x.n === 0n) return y;
  if (y.n === 0n) return x;
  const e = Math.min(x.e, y.e);
  return { n: (x.n << BigInt(x.e - e)) + (y.n << BigInt(y.e - e)), e };
}
const multiply = (x: Dyadic, y: Dyadic): Dyadic => ({ n: x.n * y.n, e: x.e + y.e });
const twice = (x: Dyadic): Dyadic => ({ n: x.n, e: x.e + 1 });
const negate = (x: Dyadic): Dyadic => ({ n: -x.n, e: x.e });
const bitLength = (n: bigint): number => (n === 0n ? 0 : n.toString(2).length);

/** Exact 2^k for −1022 ≤ k ≤ 1023, assembled from the exponent bits. */
function pow2(k: number): number {
  bits.setUint32(0, (k + 1023) << 20);
  bits.setUint32(4, 0);
  return bits.getFloat64(0);
}
const MIN_NORMAL = /* @__PURE__ */ pow2(-1022);

type Rounded = { kind: 'value'; value: number } | { kind: 'underflow' } | { kind: 'overflow' };
/** Nearest double (ties to even), reporting a nonzero value that rounds to zero and a magnitude that rounds past MAX_VALUE. */
function round(x: Dyadic): Rounded {
  if (x.n === 0n) return { kind: 'value', value: 0 };
  const negative = x.n < 0n, magnitude = negative ? -x.n : x.n;
  // Drop low bits so that at most 53 significant bits remain and none lies below 2^-1074.
  const drop = Math.max(bitLength(magnitude) - 53, -1074 - x.e);
  let q = magnitude, k = x.e;
  if (drop > 0) {
    const shift = BigInt(drop);
    q = magnitude >> shift;
    const rest = magnitude - (q << shift), half = 1n << (shift - 1n);
    if (rest > half || (rest === half && (q & 1n) === 1n)) q += 1n;
    k += drop;
  }
  if (q === 0n) return { kind: 'underflow' };
  if (bitLength(q) + k > 1024) return { kind: 'overflow' };
  // q ≤ 2^53 and q·2^k is representable: scale in two exact steps when 2^k itself is subnormal.
  let value = Number(q);
  if (k < -1022) { value *= MIN_NORMAL; k += 1022; }
  value *= pow2(k);
  return { kind: 'value', value: negative ? -value : value };
}

const SUBNORMAL_NOTE = 'Below the smallest normal double; the value is held with reduced precision.';
const valid = (value: number | string): QuantityResult => ({ status: 'valid', value });
/** A finite double result: subnormal magnitudes carry the reduced-precision note. */
const finiteResult = (value: number): QuantityResult =>
  value !== 0 && Math.abs(value) < MIN_NORMAL ? { status: 'valid', value, approximation: { code: 'UNDERFLOW', reason: SUBNORMAL_NOTE } } : valid(value + 0);
const underflow = (name: string): QuantityResult =>
  ({ status: 'numerical-limit', code: 'UNDERFLOW', reason: `${name} is nonzero but smaller than the smallest representable number; it is not zero.` });
const overflow = (name: string): QuantityResult =>
  ({ status: 'numerical-limit', code: 'OVERFLOW', reason: `${name} exceeds the largest representable number.` });

function quantity(x: Dyadic, name: string): QuantityResult {
  const rounded = round(x);
  return rounded.kind === 'value' ? finiteResult(rounded.value) : rounded.kind === 'underflow' ? underflow(name) : overflow(name);
}
/**
 * Line endpoint for drawing. Endpoints are bounded by the checked domain (|y| ≤ 370), so overflow cannot occur; an
 * exact value that is nonzero but below the double range is drawn at 0 (declared in the manifest limitations).
 */
function endpoint(x: Dyadic): number {
  const rounded = round(x);
  if (rounded.kind === 'overflow') throw new RangeError('A line endpoint left the double range; the inputs were not checked.');
  return rounded.kind === 'value' ? rounded.value + 0 : 0;
}
const numeric = (result: QuantityResult): number | null => (result.status === 'valid' && typeof result.value === 'number' ? result.value : null);
const pointOf = (id: string, x: QuantityResult, y: QuantityResult): { id: string; at: Vec2 | null; reason?: string } => {
  const px = numeric(x), py = numeric(y);
  if (px !== null && py !== null) return { id, at: [px, py] };
  const missing = px === null ? x : y;
  return { id, at: null, reason: `The point cannot be placed: ${missing.status === 'valid' ? 'a coordinate is not a number.' : missing.reason}` };
};

// Undefined statuses are built per frame so no caller can share or alter another frame's result.
const coincidentSecant = (): QuantityResult => ({
  status: 'undefined', code: 'COINCIDENT_POINTS',
  reason: 'The secant needs two distinct points. With h = 0 the second point Q coincides with P, so (f(p + h) − f(p))/h is 0/0; the analytical derivative is reported separately and is not substituted.',
});
const coincidentDifference = (): QuantityResult => ({
  status: 'undefined', code: 'COINCIDENT_POINTS',
  reason: 'The secant slope is undefined when h = 0, so its difference from the derivative is undefined.',
});
const noVertex = (B: number): QuantityResult => ({
  status: 'undefined', code: 'NO_VERTEX',
  reason: B !== 0 ? 'With A = 0 the graph is a straight line with nonzero slope, which has no vertex.'
    : 'With A = 0 and B = 0 the graph is a horizontal line: the derivative is 0 everywhere, so there is no single vertex.',
});

/** Vertex −B/(2A) as one correctly rounded IEEE division (2A is exact). */
function vertex(A: number, B: number): QuantityResult {
  if (A === 0) return noVertex(B);
  if (B === 0) return valid(0);
  const value = -B / (2 * A);
  if (!Number.isFinite(value)) return overflow('The vertex position −B/(2A)');
  if (value === 0) return underflow('The vertex position −B/(2A)');
  return finiteResult(value);
}

interface Inputs { A: number; B: number; C: number; p: number; h: number }
/** The runtime rejects these inputs before evaluation; the kernel re-checks them with the same double arithmetic. */
function checkInput({ params, index }: KernelInput): Inputs {
  const { A, B, C, p, h } = params as Record<string, number | undefined>;
  const D = FUNCTION_DERIVATIVE_DOMAIN;
  const inRange = (value: number | undefined, [min, max]: readonly [number, number]): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
  if (!inRange(A, D.A) || !inRange(B, D.B) || !inRange(C, D.C) || !inRange(p, D.p) || !inRange(h, D.h) || !inRange(p + h, D.x))
    throw new RangeError('Parameters are outside the declared domain; the runtime must reject them before evaluation.');
  if (index !== 0) throw new RangeError('A static model is evaluated at index 0 only.');
  return { A, B, C, p, h };
}

/** Evaluates the static frame: quantities at the probe and the second point, both curves, the tangent and the secant. */
export function evaluateFunctionDerivative(input: KernelInput): KernelOutput {
  const { A, B, C, p, h } = checkInput(input);
  const a = exact(A), b = exact(B), c = exact(C), x = exact(p), offset = exact(h);
  const f = (t: Dyadic): Dyadic => add(multiply(add(multiply(a, t), b), t), c); // (A·t + B)·t + C
  const xq = add(x, offset);
  const fp = f(x), fq = f(xq), slope = add(twice(multiply(a, x)), b);
  // (f(p + h) − f(p))/h = 2A·p + B + A·h exactly for h ≠ 0 (−0 counts as 0).
  const secant = h === 0 ? null : add(slope, multiply(a, offset));
  const slopeSign = slope.n > 0n ? 'increasing' : slope.n < 0n ? 'decreasing' : 'stationary';

  const probeValue = quantity(fp, 'f(p)'), derivative = quantity(slope, 'f′(p)');
  const secondX = quantity(xq, 'p + h'), secondValue = quantity(fq, 'f(p + h)');
  // The line through P with slope m, y = f(p) + m·(x − p), drawn between x = −5 and x = 5.
  const [left, right] = FUNCTION_DERIVATIVE_DOMAIN.x;
  const at = (m: Dyadic, end: number): Vec2 => [end, endpoint(add(fp, multiply(m, add(exact(end), negate(x)))))];
  const line = (id: string, m: Dyadic) => ({ id, from: at(m, left), to: at(m, right) });

  const { samples, domain: [low, high] } = FUNCTION_DERIVATIVE_CURVE;
  const xs = Array.from({ length: samples }, (_, i) => (i * (high - low) + low * (samples - 1)) / (samples - 1)); // one rounding of −5 + i/40
  const curve: Vec2[] = xs.map(t => [t, (A * t + B) * t + C + 0]);
  const derivativeCurve: Vec2[] = xs.map(t => [t, 2 * A * t + B + 0]);
  const geometry: Record<string, GeometryResult> = {
    curve: { kind: 'polyline2', segments: [{ points: curve, start: 'none', end: 'none' }], gaps: [], sampling: { samples, domain: [low, high] } },
    'derivative-curve': { kind: 'polyline2', segments: [{ points: derivativeCurve, start: 'none', end: 'none' }], gaps: [], sampling: { samples, domain: [low, high] } },
    tangent: { kind: 'segments2', segments: [line('tangent', slope)] },
    secant: { kind: 'segments2', segments: secant ? [line('secant', secant)] : [] },
    probe: { kind: 'points2', points: [pointOf('P', valid(p + 0), probeValue)] },
    second: { kind: 'points2', points: [pointOf('Q', secondX, secondValue)] },
    'derivative-probe': { kind: 'points2', points: [pointOf('P', valid(p + 0), derivative)] },
  };
  return {
    quantities: {
      'probe.x': valid(p + 0),
      'probe.value': probeValue,
      derivative,
      'second.x': secondX,
      'second.value': secondValue,
      'secant.slope': secant ? quantity(secant, 'The secant slope') : coincidentSecant(),
      'secant.difference': secant ? quantity(multiply(a, offset), 'The difference between the secant slope and the derivative') : coincidentDifference(),
      'slope.sign': valid(slopeSign),
      curvature: valid(classifyCurvature(A, B)),
      'vertex.x': vertex(A, B),
    },
    geometry,
  };
}

export const functionDerivativeKernel: ModelKernel = /* @__PURE__ */ Object.freeze({
  id: FUNCTION_DERIVATIVE_KERNEL_ID,
  version: FUNCTION_DERIVATIVE_KERNEL_VERSION,
  mode: 'static',
  evaluate: evaluateFunctionDerivative,
});
