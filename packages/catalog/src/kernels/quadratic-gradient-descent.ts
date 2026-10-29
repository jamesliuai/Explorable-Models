/**
 * Installed pure kernel: fixed-step gradient descent on f(x) = a·x²/2 (report §12.3).
 *
 * Declared semantics (shared with the reference fixture, not with its oracle's code): the step product p = η·a is
 * the IEEE-754 double product of the inputs, computed once; the multiplier is r = 1 − p; x[n] = x0·rⁿ at integer
 * n. The regime is classified from the declared conditions on (x0, p) alone — never from iterates or from rounded
 * display values. Positions, gradients and losses are evaluated in closed form with a scaled double-double
 * representation (mantissa pair plus a separate binary exponent), so no intermediate overflows, underflows or
 * produces 0·∞, and every result is rounded to a double exactly once. Exact special cases come first: x0 = 0 is
 * identically 0 (checked before any power), n = 0 is x0, and p = 1 makes every later iterate exactly 0.
 *
 * Numerical limits are statuses, never values: a magnitude above Number.MAX_VALUE is `numerical-limit`/`OVERFLOW`
 * with the last finite index (estimated with logarithms, then verified by direct evaluation next to the threshold);
 * a nonzero value that rounds to zero is `numerical-limit`/`UNDERFLOW`; a subnormal result is valid with an
 * `UNDERFLOW` approximation note.
 */
import type { GeometryResult, KernelInput, KernelOutput, ModelKernel, QuantityResult, Vec2 } from '@experiment-kit/core/model';

export const QUADRATIC_KERNEL_ID = 'quadratic-gradient-descent';
export const QUADRATIC_KERNEL_VERSION = '1.0.0';
export const QUADRATIC_MAX_INDEX = 1000;
/** Canonical (dimensionless) parameter domain and the coupled bound on p = η·a (multiplier 1 − p ≥ −3). */
export const QUADRATIC_DOMAIN = Object.freeze({ a: [0.1, 10], eta: [0, 2], x0: [-10, 10], maxProduct: 4 } as const);
export const QUADRATIC_REGIMES = ['zero-start', 'stationary', 'monotone-convergence', 'one-step', 'alternating-convergence', 'oscillation', 'divergence'] as const;
export type QuadraticRegime = typeof QUADRATIC_REGIMES[number];
/** Objective samples for the landscape curve. */
export const QUADRATIC_CURVE = Object.freeze({ samples: 201, domain: [-10, 10] as const });

/** Regime from the declared conditions on x0 and the double product p = η·a. */
export function classifyRegime(x0: number, product: number): QuadraticRegime {
  if (x0 === 0) return 'zero-start';
  if (product === 0) return 'stationary';
  if (product < 1) return 'monotone-convergence';
  if (product === 1) return 'one-step';
  if (product < 2) return 'alternating-convergence';
  return product === 2 ? 'oscillation' : 'divergence';
}

// ---------------------------------------------------------------------------------------------
// Scaled double-double arithmetic: value = (hi + lo)·2^exp with 0.5 ≤ |hi| < 1, or hi = lo = 0.
// ---------------------------------------------------------------------------------------------
interface Scaled { hi: number; lo: number; exp: number }
const bits = /* @__PURE__ */ new DataView(new ArrayBuffer(8));
const TWO_64 = 18446744073709551616;
const SPLITTER = 134217729; // 2^27 + 1
const MAX_MANTISSA = 1 - /* @__PURE__ */ pow2(-53); // largest double below 1: MAX_VALUE = MAX_MANTISSA·2^1024
const MIN_SUBNORMAL = Number.MIN_VALUE; // 2^-1074
const TWO_52 = 4503599627370496;

/** Exact 2^e for −1022 ≤ e ≤ 1023, assembled from the exponent bits. */
function pow2(e: number): number {
  bits.setUint32(0, (e + 1023) << 20);
  bits.setUint32(4, 0);
  return bits.getFloat64(0);
}
/** x = m·2^e with 0.5 ≤ |m| < 1 for finite nonzero x (subnormals included). */
function frexp(x: number): [number, number] {
  bits.setFloat64(0, x);
  const high = bits.getUint32(0);
  const biased = (high >>> 20) & 0x7ff;
  if (biased === 0) { const [m, e] = frexp(x * TWO_64); return [m, e - 64]; }
  bits.setUint32(0, (high & 0x800fffff) | (1022 << 20));
  return [bits.getFloat64(0), biased - 1022];
}
function twoSum(a: number, b: number): [number, number] {
  const s = a + b, v = s - a;
  return [s, (a - (s - v)) + (b - v)];
}
function split(a: number): [number, number] {
  const t = SPLITTER * a, hi = t - (t - a);
  return [hi, a - hi];
}
function twoProduct(a: number, b: number): [number, number] {
  const p = a * b;
  const [ah, al] = split(a), [bh, bl] = split(b);
  return [p, ((ah * bh - p) + ah * bl + al * bh) + al * bl];
}
function normalize(hi: number, lo: number, exp: number): Scaled {
  if (hi === 0) return { hi: 0, lo: 0, exp: 0 };
  const [s, e] = twoSum(hi, lo);
  const [m, shift] = frexp(s);
  const scale = Math.abs(shift) <= 1022 ? pow2(-shift) : 0;
  return { hi: m, lo: e * scale, exp: exp + shift };
}
const scaled = (x: number): Scaled => {
  if (x === 0) return { hi: 0, lo: 0, exp: 0 };
  const [m, e] = frexp(x);
  return { hi: m, lo: 0, exp: e };
};
function multiply(x: Scaled, y: Scaled): Scaled {
  if (x.hi === 0 || y.hi === 0) return { hi: 0, lo: 0, exp: 0 };
  const [p, e] = twoProduct(x.hi, y.hi);
  return normalize(p, e + (x.hi * y.lo + x.lo * y.hi), x.exp + y.exp);
}
function power(base: Scaled, n: number): Scaled {
  let result: Scaled = { hi: 0.5, lo: 0, exp: 1 }, factor = base;
  for (let k = n; k > 0; k = Math.floor(k / 2)) {
    if (k % 2 === 1) result = multiply(result, factor);
    if (k > 1) factor = multiply(factor, factor);
  }
  return result;
}
const log2Magnitude = (x: Scaled): number => x.exp + Math.log2(Math.abs(x.hi));

type Rounded = { kind: 'value'; value: number; subnormal: boolean } | { kind: 'overflow' } | { kind: 'underflow' };
/** Rounds a scaled value to the nearest double once (ties to even), reporting overflow above MAX_VALUE and nonzero flush to zero. */
function round(x: Scaled): Rounded {
  if (x.hi === 0) return { kind: 'value', value: 0, subnormal: false };
  const magnitude = Math.abs(x.hi), sign = Math.sign(x.hi);
  if (x.exp > 1024 || (x.exp === 1024 && (magnitude > MAX_MANTISSA || (magnitude === MAX_MANTISSA && sign * x.lo > 0)))) return { kind: 'overflow' };
  if (x.exp === 1024) return { kind: 'value', value: x.hi * 2 * pow2(1023), subnormal: false };
  if (x.exp >= -1021) return { kind: 'value', value: x.hi * pow2(x.exp), subnormal: false };
  // Subnormal range: count quanta of 2^-1074 and round once, deciding ties with the low word.
  const shift = x.exp + 1074;
  if (shift < -60) return { kind: 'underflow' };
  const scale = shift >= -1022 ? pow2(shift) : 0;
  const high = magnitude * scale, low = sign * x.lo * scale;
  let quanta = Math.floor(high);
  const fraction = high - quanta;
  if (fraction >= 0.25) {
    const excess = (fraction - 0.5) + low;
    if (excess > 0 || (excess === 0 && quanta % 2 === 1)) quanta += 1;
  }
  if (quanta === 0) return { kind: 'underflow' };
  return { kind: 'value', value: sign * quanta * MIN_SUBNORMAL, subnormal: quanta < TWO_52 };
}

// ---------------------------------------------------------------------------------------------
// Sequence evaluation
// ---------------------------------------------------------------------------------------------
type SequenceQuantity = 'position' | 'loss' | 'gradient';
type Limit = { kind: 'overflow' | 'underflow'; index: number } | null;

const SUBNORMAL_NOTE = 'Below the smallest normal double; the value is held with reduced precision.';
const NAMES: Record<SequenceQuantity, string> = { position: 'The position', loss: 'The loss', gradient: 'The gradient' };

function createSequence(a: number, x0: number, product: number) {
  const zero = x0 === 0;
  const [rHigh, rLow] = twoSum(1, -product); // exact 1 − p
  const multiplier = normalize(rHigh, rLow, 0);
  const oneStep = rHigh === 0 && rLow === 0;
  const start = scaled(x0), curvature = scaled(a), halfCurvature = scaled(a / 2);
  let cached: [number, Scaled] = [0, start];
  const rawPosition = (n: number): Scaled => {
    if (zero || (oneStep && n > 0)) return scaled(0);
    if (cached[0] !== n) cached = [n, multiply(start, power(multiplier, n))];
    return cached[1];
  };
  const raw = (quantity: SequenceQuantity, n: number): Scaled => {
    const x = rawPosition(n);
    return quantity === 'position' ? x : quantity === 'gradient' ? multiply(curvature, x) : multiply(halfCurvature, multiply(x, x));
  };
  const growth = zero || oneStep ? 0 : log2Magnitude(multiplier);
  const limits = new Map<SequenceQuantity, Limit>();
  /** First index ≤ QUADRATIC_MAX_INDEX at which the quantity leaves the double range (monotone in n when |r| ≠ 1). */
  const limit = (quantity: SequenceQuantity): Limit => {
    if (limits.has(quantity)) return limits.get(quantity)!;
    let found: Limit = null;
    if (growth !== 0) {
      const kind = growth > 0 ? 'overflow' : 'underflow';
      const isLimit = (n: number) => round(raw(quantity, n)).kind === kind;
      const target = kind === 'overflow' ? 1024 : -1075;
      const rate = growth * (quantity === 'loss' ? 2 : 1);
      // Logarithmic estimate of the crossing, then direct verification on both sides of it.
      const estimate = Math.ceil((target - log2Magnitude(raw(quantity, 0))) / rate);
      let n = Math.min(QUADRATIC_MAX_INDEX + 1, Math.max(0, Number.isFinite(estimate) ? estimate : QUADRATIC_MAX_INDEX + 1));
      while (n > 0 && isLimit(n - 1)) n -= 1;
      while (n <= QUADRATIC_MAX_INDEX && !isLimit(n)) n += 1;
      if (n <= QUADRATIC_MAX_INDEX) found = { kind, index: n };
    }
    limits.set(quantity, found);
    return found;
  };
  const limitResult = (quantity: SequenceQuantity, kind: 'overflow' | 'underflow', first: number | null): QuantityResult =>
    kind === 'overflow'
      ? { status: 'numerical-limit', code: 'OVERFLOW', reason: `${NAMES[quantity]} exceeds the largest representable number${first === null ? '' : ` from n = ${first}; the last finite value is at n = ${first - 1}`}.`, ...(first === null ? {} : { lastFiniteIndex: first - 1 }) }
      : { status: 'numerical-limit', code: 'UNDERFLOW', reason: `${NAMES[quantity]} is nonzero but smaller than the smallest representable number${first === null ? '' : ` from n = ${first}`}; it is not exactly zero.` };
  const at = (quantity: SequenceQuantity, n: number): QuantityResult => {
    const bound = limit(quantity);
    if (bound && n >= bound.index) return limitResult(quantity, bound.kind, bound.index);
    const rounded = round(raw(quantity, n));
    if (rounded.kind !== 'value') return limitResult(quantity, rounded.kind, null);
    return rounded.subnormal
      ? { status: 'valid', value: rounded.value, approximation: { code: 'UNDERFLOW', reason: SUBNORMAL_NOTE } }
      : { status: 'valid', value: rounded.value + 0 };
  };
  return { at };
}

const numeric = (result: QuantityResult): number | null => (result.status === 'valid' && typeof result.value === 'number' ? result.value : null);
const unavailable = (result: QuantityResult): string => (result.status === 'valid' ? '' : result.reason);

function checkInput({ params, index }: KernelInput): { a: number; eta: number; x0: number } {
  const { a, eta, x0 } = params as Record<string, number | undefined>;
  const inRange = (value: number | undefined, [min, max]: readonly [number, number]): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
  if (!inRange(a, QUADRATIC_DOMAIN.a) || !inRange(eta, QUADRATIC_DOMAIN.eta) || !inRange(x0, QUADRATIC_DOMAIN.x0) || eta * a > QUADRATIC_DOMAIN.maxProduct)
    throw new RangeError('Parameters are outside the declared domain; the runtime must reject them before evaluation.');
  if (!Number.isInteger(index) || index < 0 || index > QUADRATIC_MAX_INDEX) throw new RangeError(`Iteration index must be an integer from 0 to ${QUADRATIC_MAX_INDEX}.`);
  return { a, eta, x0 };
}

/** Evaluates one identified iteration: quantities at n plus the trace, iterates and steps for 0 ≤ k ≤ n. */
export function evaluateQuadraticGradientDescent(input: KernelInput): KernelOutput {
  const { a, eta, x0 } = checkInput(input);
  const n = input.index;
  const product = eta * a;
  const sequence = createSequence(a, x0, product);
  const position = sequence.at('position', n), loss = sequence.at('loss', n), gradient = sequence.at('gradient', n);
  const startLoss = sequence.at('loss', 0);

  // Trace and iterates stop at the first iterate that is not representable, recorded as a null point with a reason.
  const tracePoints: { id: string; at: Vec2 | null; reason?: string }[] = [];
  const iteratePoints: { id: string; at: Vec2 | null; reason?: string }[] = [];
  const steps: { id: string; from: Vec2; to: Vec2 }[] = [];
  let traceOpen = true, iteratesOpen = true;
  for (let k = 0; k <= n && (traceOpen || iteratesOpen); k++) {
    const xk = k === n ? position : sequence.at('position', k);
    const fk = k === n ? loss : sequence.at('loss', k);
    const x = numeric(xk), f = numeric(fk);
    if (traceOpen) {
      if (x === null) { tracePoints.push({ id: `n${k}`, at: null, reason: `Trace stops: ${unavailable(xk)}` }); traceOpen = false; }
      else tracePoints.push({ id: `n${k}`, at: [k, x] });
    }
    if (iteratesOpen) {
      if (x === null || f === null) { iteratePoints.push({ id: `n${k}`, at: null, reason: `Iterates stop: ${unavailable(x === null ? xk : fk)}` }); iteratesOpen = false; }
      else {
        const previous = iteratePoints[iteratePoints.length - 1];
        if (previous?.at) steps.push({ id: `s${k}`, from: previous.at, to: [x, f] });
        iteratePoints.push({ id: `n${k}`, at: [x, f] });
      }
    }
  }
  const [low, high] = QUADRATIC_CURVE.domain;
  const curve: Vec2[] = Array.from({ length: QUADRATIC_CURVE.samples }, (_, i) => {
    const x = low + ((high - low) * i) / (QUADRATIC_CURVE.samples - 1);
    return [x, (a * x * x) / 2];
  });
  const startPoint = numeric(startLoss), currentX = numeric(position), currentF = numeric(loss);
  const geometry: Record<string, GeometryResult> = {
    curve: { kind: 'polyline2', segments: [{ points: curve, start: 'none', end: 'none' }], gaps: [], sampling: { samples: QUADRATIC_CURVE.samples, domain: [low, high] } },
    start: { kind: 'points2', points: [startPoint === null ? { id: 'x0', at: null, reason: unavailable(startLoss) } : { id: 'x0', at: [x0, startPoint] }] },
    current: { kind: 'points2', points: [currentX === null || currentF === null ? { id: `n${n}`, at: null, reason: unavailable(currentX === null ? position : loss) } : { id: `n${n}`, at: [currentX, currentF] }] },
    trace: { kind: 'points2', points: tracePoints },
    iterates: { kind: 'points2', points: iteratePoints },
    steps: { kind: 'segments2', segments: steps },
  };
  const valid = (value: number | string): QuantityResult => ({ status: 'valid', value });
  return {
    quantities: {
      'start.position': valid(x0 + 0),
      'start.loss': startLoss,
      position,
      loss,
      gradient,
      multiplier: valid(1 - product),
      product: valid(product),
      threshold: valid(2 / a),
      regime: valid(classifyRegime(x0, product)),
      index: valid(n),
    },
    geometry,
    terminal: position.status === 'numerical-limit'
      ? { reached: true, event: 'numerical-limit', detail: position.reason }
      : n === QUADRATIC_MAX_INDEX ? { reached: true, event: 'max-index', detail: `The iteration bound n = ${QUADRATIC_MAX_INDEX} is reached.` } : { reached: false },
  };
}

export const quadraticGradientDescentKernel: ModelKernel = /* @__PURE__ */ Object.freeze({
  id: QUADRATIC_KERNEL_ID,
  version: QUADRATIC_KERNEL_VERSION,
  mode: 'discrete',
  evaluate: evaluateQuadraticGradientDescent,
});
