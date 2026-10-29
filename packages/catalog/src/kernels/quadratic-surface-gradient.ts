/**
 * Installed pure kernel: the quadratic surface f(x, y) = (a·x² + 2b·x·y + c·y²)/2 and its gradient (report §12.5).
 *
 * Declared semantics (shared with the reference fixture, not with its oracle's code). The Hessian H = [[a, b], [b, c]]
 * is symmetric positive definite on the whole admissible domain: the runtime evaluates the constraint
 * `a*c - b*b > 0` as fl(fl(a·c) − fl(b·b)) > 0, and because rounding is monotone that test passes only when the exact
 * a·c − b² is positive. The gradient ∇f(p) = H·p = (a·px + b·py, b·px + c·py) is therefore zero exactly at p = (0, 0):
 * the zero-gradient case is decided from the declared condition on p, never from rounded components, and only there
 * is the direction `undefined` (ZERO_GRADIENT). No direction is ever chosen arbitrarily.
 *
 * Point quantities — f(p), ∇f(p), |∇f(p)|, the direction ∇f/|∇f| and a·c − b² — are computed exactly from the double
 * inputs (BigInt dyadic arithmetic, and integer square roots with a sticky bit for the two irrational ones) and each is
 * rounded once to the nearest double, ties to even, subnormals included: exactly the value the reference fixture's
 * oracle derives (version 1.1.0; 1.0.0 used double-double sums, which can land one unit in the last place away when one
 * product is an exact rounding tie and the other term lies below 2⁻¹⁰⁶ of it). Tiny nonzero points therefore keep a
 * defined direction and an honest status: a subnormal result is valid with an UNDERFLOW approximation note, a nonzero
 * f(p) or |∇f(p)| that rounds to 0 is `numerical-limit`/UNDERFLOW, never 0, and a nonzero gradient or direction
 * component shown as 0 carries an UNDERFLOW approximation note. All geometry comes from the same evaluation: the sampled
 * surface, analytic contour ellipses, the gradient field with its disclosed arrow scale, the two axis cross-sections and
 * the point with its gradient arrow in the contour plane and in the plane z = f(p) of the 3D view. Sampled heights and
 * field vectors use double-double (≈ 106-bit) intermediates rounded once (within the fixture's grid tolerance). The
 * kernel has no camera or other presentation input.
 */
import type { GeometryResult, KernelInput, KernelOutput, ModelKernel, QuantityResult, Vec2, Vec3 } from '@experiment-kit/core/model';

export const SURFACE_GRADIENT_KERNEL_ID = 'quadratic-surface-gradient';
export const SURFACE_GRADIENT_KERNEL_VERSION = '1.1.0';
export const SURFACE_GRADIENT_PARAMETERS = ['a', 'b', 'c', 'px', 'py'] as const;
/** Canonical (dimensionless) parameter domain; a·c − b² > 0 is the coupled `positive-definite` constraint. */
export const SURFACE_GRADIENT_DOMAIN = Object.freeze({ a: [0.2, 4], b: [-2, 2], c: [0.2, 4], px: [-2, 2], py: [-2, 2] } as const);
/** Surface samples x_i = (i − 20)/10 and y_j = (j − 20)/10, i, j = 0 … 40 (spacing 0.1), z stored row by row in y. */
export const SURFACE_GRID = Object.freeze({ n: 41, half: 20, divisor: 10, domain: [-2, 2] as const });
/** Contour levels L of f, one closed ellipse each. */
export const CONTOUR_LEVELS = Object.freeze([0.25, 0.5, 1, 2, 4] as const);
/** Directions t_k = 2πk/180 for k = 0 … 179, plus the first point repeated to close each ellipse. */
export const CONTOUR_SAMPLES = 181;
/** Gradient field grid x_i = (i − 4)/2 and y_j = (j − 4)/2, i, j = 0 … 8 (spacing 0.5), samples row by row in y. */
export const FIELD_GRID = Object.freeze({ n: 9, half: 4, divisor: 2, spacing: 0.5 });
/** Cross-section samples s_i = (i − 40)/20, i = 0 … 80 (spacing 0.05). */
export const SECTION_SAMPLES = Object.freeze({ n: 81, half: 40, divisor: 20, domain: [-2, 2] as const });
/**
 * Candidate arrow scales, largest first. The frame's scale s is the first one with s·M ≤ ARROW_MAX_LENGTH, where M is
 * the longest field gradient. On the admissible domain M ≤ 6·2√2 < 17, so s ≥ 0.02 and the list never runs out.
 */
export const ARROW_SCALES = Object.freeze([1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01, 0.005, 0.002, 0.001] as const);
/** Longest drawn field arrow: 90% of the field spacing. */
export const ARROW_MAX_LENGTH = 0.45;
export const arrowDisclosure = (factor: number): string => `Arrow lengths are scaled by ${factor} for legibility; directions are exact.`;

// ---------------------------------------------------------------------------------------------
// Double-double arithmetic: a value is hi + lo with |lo| ≤ ulp(hi)/2.
// ---------------------------------------------------------------------------------------------
type DD = readonly [number, number];
const SPLITTER = 134217729; // 2^27 + 1
const MIN_NORMAL = 2.2250738585072014e-308; // 2^-1022
const bits = /* @__PURE__ */ new DataView(new ArrayBuffer(8));

function twoSum(a: number, b: number): DD {
  const s = a + b, v = s - a;
  return [s, (a - (s - v)) + (b - v)];
}
function quickTwoSum(a: number, b: number): DD {
  const s = a + b;
  return [s, b - (s - a)];
}
function split(a: number): DD {
  const t = SPLITTER * a, hi = t - (t - a);
  return [hi, a - hi];
}
/** Exact product a·b as a double-double (inputs here never overflow). */
function product(a: number, b: number): DD {
  const p = a * b;
  const [ah, al] = split(a), [bh, bl] = split(b);
  return [p, ((ah * bh - p) + ah * bl + al * bh) + al * bl];
}
function sum(x: DD, y: DD): DD {
  const [s, e] = twoSum(x[0], y[0]);
  const [t, f] = twoSum(x[1], y[1]);
  const [u, g] = quickTwoSum(s, e + t);
  return quickTwoSum(u, g + f);
}
const negate = (x: DD): DD => [-x[0], -x[1]];
function scale(x: DD, d: number): DD {
  const [p, e] = product(x[0], d);
  return quickTwoSum(p, e + x[1] * d);
}
function divide(x: DD, y: DD): DD {
  const q = x[0] / y[0];
  const r = sum(x, negate(scale(y, q)));
  return quickTwoSum(q, r[0] / y[0]);
}
function squareRoot(x: DD): DD {
  if (x[0] <= 0) return [0, 0];
  const s = Math.sqrt(x[0]);
  const [p, e] = product(s, s);
  return quickTwoSum(s, ((x[0] - p) - e + x[1]) / (2 * s));
}

/** Exact 2^e for −1022 ≤ e ≤ 1023, assembled from the exponent bits. */
function pow2(e: number): number {
  bits.setUint32(0, (e + 1023) << 20);
  bits.setUint32(4, 0);
  return bits.getFloat64(0);
}
/** Binary exponent k with |x| = m·2^k, 0.5 ≤ m < 1, for finite nonzero x (subnormals included). */
function exponent(x: number): number {
  bits.setFloat64(0, x);
  const biased = (bits.getUint32(0) >>> 20) & 0x7ff;
  return biased === 0 ? exponent(x * 18446744073709551616) - 64 : biased - 1022;
}
/** x·2^e in steps that are exact whenever x and the result are normal or the result is exact. */
function ldexp(x: number, e: number): number {
  let y = x;
  for (let k = e; k !== 0;) { const step = Math.max(-1000, Math.min(1000, k)); y *= pow2(step); k -= step; }
  return y;
}
/**
 * The double nearest (hi + lo)·2^e, rounded once (ties to even). A normal result is the correctly rounded hi + lo
 * scaled exactly; a subnormal result counts quanta of 2^-1074 from hi and lets lo decide an exact tie.
 */
function roundScaled([hi, lo]: DD, e: number): number {
  if (hi === 0) return 0;
  const t = exponent(hi) + e;
  if (t >= -1021) return ldexp(hi + lo, e);
  if (t < -1076) return 0;
  const quanta = Math.abs(ldexp(hi, e + 1074)); // exact: a normal double with at most 53 integer bits
  let count = Math.floor(quanta);
  const fraction = quanta - count, toward = Math.sign(lo) * Math.sign(hi);
  if (fraction > 0.5 || (fraction === 0.5 && (toward > 0 || (toward === 0 && count % 2 === 1)))) count += 1;
  return Math.sign(hi) * count * Number.MIN_VALUE;
}

// ---------------------------------------------------------------------------------------------
// The quadratic form
// ---------------------------------------------------------------------------------------------
interface Coefficients { a: number; b: number; c: number }
interface FormTerms { gx: DD; gy: DD; twiceF: DD }

/** ∇f = H·(x, y) and 2f = x·∂f/∂x + y·∂f/∂y in double-double; exact for products, about 2^-104 relative for sums. */
function form({ a, b, c }: Coefficients, x: number, y: number): FormTerms {
  const gx = sum(product(a, x), product(b, y));
  const gy = sum(product(b, x), product(c, y));
  return { gx, gy, twiceF: sum(scale(gx, x), scale(gy, y)) };
}
/** f at a sample with moderate coordinates (no scaling needed): rounded once. */
function height(coefficients: Coefficients, x: number, y: number): number {
  if (x === 0 && y === 0) return 0;
  return roundScaled(form(coefficients, x, y).twiceF, -1);
}
/** Gradient at a sample with moderate coordinates, each component rounded once. */
function gradientAt(coefficients: Coefficients, x: number, y: number): Vec2 {
  const { gx, gy } = form(coefficients, x, y);
  return [gx[0] + gx[1] + 0, gy[0] + gy[1] + 0];
}

// ---------------------------------------------------------------------------------------------
// Exact dyadic arithmetic for the point quantities: value = n·2^e with a BigInt significand.
// ---------------------------------------------------------------------------------------------
interface Dyadic { readonly n: bigint; readonly e: number }
const NONE: Dyadic = Object.freeze({ n: 0n, e: 0 });
/** Exact value of a finite double, read from its bit pattern (−0 is 0). */
function exact(x: number): Dyadic {
  if (x === 0) return NONE;
  bits.setFloat64(0, x);
  const high = bits.getUint32(0), low = bits.getUint32(4);
  const biased = (high >>> 20) & 0x7ff;
  const fraction = (BigInt(high & 0xfffff) << 32n) | BigInt(low);
  const n = biased === 0 ? fraction : fraction | (1n << 52n);
  return { n: high >>> 31 ? -n : n, e: biased === 0 ? -1074 : biased - 1075 };
}
function plus(x: Dyadic, y: Dyadic): Dyadic {
  if (x.n === 0n) return y;
  if (y.n === 0n) return x;
  const e = Math.min(x.e, y.e);
  return { n: (x.n << BigInt(x.e - e)) + (y.n << BigInt(y.e - e)), e };
}
const times = (x: Dyadic, y: Dyadic): Dyadic => (x.n === 0n || y.n === 0n ? NONE : { n: x.n * y.n, e: x.e + y.e });
const bitLength = (n: bigint): number => (n === 0n ? 0 : n.toString(2).length);
/** ⌊√n⌋ for n ≥ 0 (Newton's iteration from above). */
function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = 1n << BigInt((bitLength(n) + 1) >> 1);
  for (;;) { const y = (x + n / x) >> 1n; if (y >= x) return x; x = y; }
}
/** The double nearest n·2^e (ties to even, subnormals included); 0 when a nonzero value rounds to zero. Never overflows here. */
function nearest({ n, e }: Dyadic): number {
  if (n === 0n) return 0;
  const negative = n < 0n, magnitude = negative ? -n : n;
  // Drop low bits so that at most 53 significant bits remain and none lies below 2^-1074.
  const drop = Math.max(bitLength(magnitude) - 53, -1074 - e);
  let q = magnitude, k = e;
  if (drop > 0) {
    const shift = BigInt(drop);
    q = magnitude >> shift;
    const rest = magnitude - (q << shift), half = 1n << (shift - 1n);
    if (rest > half || (rest === half && (q & 1n) === 1n)) q += 1n;
    k += drop;
  }
  if (q === 0n) return 0;
  // q ≤ 2^53 and q·2^k is representable: scale in exact steps (ldexp splits subnormal powers).
  const value = ldexp(Number(q), k);
  return negative ? -value : value + 0;
}
/**
 * The double nearest √(num/den · 2^e) for num ≥ 0, den > 0 (ties to even). The integer root carries at least 56
 * significant bits, and its unit lies below the subnormal quantum when the result can be subnormal, so the remainder
 * enters the single rounding only as a sticky bit.
 */
function nearestRoot(num: bigint, den: bigint, e: number): number {
  if (num === 0n) return 0;
  if (e & 1) { num <<= 1n; e -= 1; }
  const width = bitLength(num) - bitLength(den);
  const k = Math.max(0, Math.ceil((114 - width) / 2), (e + width) / 2 < -1018 ? e / 2 + 1078 : 0);
  const scaled = num << BigInt(2 * k);
  const quotient = scaled / den, root = isqrt(quotient);
  const exactRoot = quotient * den === scaled && root * root === quotient;
  return nearest({ n: (root << 1n) | (exactRoot ? 0n : 1n), e: e / 2 - k - 1 });
}

const valid = (value: number | number[]): QuantityResult => ({ status: 'valid', value });
const REDUCED = 'Below the smallest normal double; the value is held with reduced precision.';
/** Status of a positive exact value rounded to `rounded`: never 0 for a nonzero value. */
function positive(rounded: number, name: string): QuantityResult {
  if (rounded === 0) return { status: 'numerical-limit', code: 'UNDERFLOW', reason: `${name} is positive but smaller than the smallest representable number; it is not exactly 0.` };
  return rounded < MIN_NORMAL ? { status: 'valid', value: rounded, approximation: { code: 'UNDERFLOW', reason: REDUCED } } : valid(rounded);
}
/** A vector of correctly rounded components of exactly known values: a lost (nonzero → 0) or subnormal component is noted. */
function components(rounded: Vec2, exactNonzero: readonly boolean[], what: string): QuantityResult {
  const lost = rounded.some((value, i) => exactNonzero[i] && value === 0);
  const reduced = rounded.some(value => value !== 0 && Math.abs(value) < MIN_NORMAL);
  return lost
    ? { status: 'valid', value: rounded, approximation: { code: 'UNDERFLOW', reason: `${what} component is nonzero but smaller than the smallest representable number and is shown as 0; it is not exactly 0.` } }
    : reduced ? { status: 'valid', value: rounded, approximation: { code: 'UNDERFLOW', reason: REDUCED } } : valid(rounded);
}

interface PointResult {
  value: QuantityResult;
  gradient: QuantityResult;
  norm: QuantityResult;
  direction: QuantityResult;
  determinant: QuantityResult;
  /** Rounded height and gradient components for drawing (height null when it is a numerical limit). */
  height: number | null;
  components: Vec2;
}
const zeroGradient = (): QuantityResult => ({
  status: 'undefined', code: 'ZERO_GRADIENT',
  reason: 'The gradient is the zero vector at this point, so it has no direction; no direction is chosen in its place.',
});

/** Quantities at the selected point: exact values of the double inputs, each rounded once; p = (0, 0) decided exactly. */
function evaluatePoint({ a, b, c }: Coefficients, px: number, py: number): PointResult {
  const A = exact(a), B = exact(b), C = exact(c), X = exact(px), Y = exact(py);
  const det = plus(times(A, C), { n: -times(B, B).n, e: times(B, B).e });
  const determinant = valid(nearest(det));
  if (px === 0 && py === 0) {
    return { value: valid(0), gradient: valid([0, 0]), norm: valid(0), direction: zeroGradient(), determinant, height: 0, components: [0, 0] };
  }
  const gx = plus(times(A, X), times(B, Y)), gy = plus(times(B, X), times(C, Y));
  // 2f = x·∂f/∂x + y·∂f/∂y; f is 2f·2^-1, exactly.
  const twiceF = plus(times(X, gx), times(Y, gy));
  const drawn: Vec2 = [nearest(gx), nearest(gy)];
  const gradient = components(drawn, [gx.n !== 0n, gy.n !== 0n], 'A gradient');
  const value = positive(nearest({ n: twiceF.n, e: twiceF.e - 1 }), 'f(p)');
  // |∇f|² = gx² + gy² exactly; each direction component is ±√(g²/|∇f|²).
  const squared = plus(times(gx, gx), times(gy, gy));
  const norm = positive(nearestRoot(squared.n, 1n, squared.e), 'The gradient length');
  const unit = (g: Dyadic): number => {
    if (g.n === 0n) return 0;
    const root = nearestRoot(g.n * g.n, squared.n, 2 * g.e - squared.e);
    return g.n < 0n ? -root : root;
  };
  const direction = components([unit(gx), unit(gy)], [gx.n !== 0n, gy.n !== 0n], 'A direction');
  return { value, gradient, norm, direction, determinant, height: value.status === 'valid' ? value.value as number : null, components: drawn };
}

/** The analytic contour f = L: r(t)² = 2L/q(t) with q(t) = a·cos²t + 2b·cos t·sin t + c·sin²t > 0, closed at t = 2π. */
function contour({ a, b, c }: Coefficients, level: number): Vec2[] {
  const points: Vec2[] = [];
  for (let k = 0; k < CONTOUR_SAMPLES - 1; k++) {
    const t = (Math.PI * k) / 90, cos = Math.cos(t), sin = Math.sin(t);
    const q = sum(sum(scale(product(cos, cos), a), scale(product(cos, sin), 2 * b)), scale(product(sin, sin), c));
    const r = squareRoot(divide([2 * level, 0], q));
    const x = scale(r, cos), y = scale(r, sin);
    points.push([x[0] + x[1] + 0, y[0] + y[1] + 0]);
  }
  points.push([...points[0]!]);
  return points;
}

const gridValue = (index: number, grid: { half: number; divisor: number }): number => (index - grid.half) / grid.divisor + 0;

function checkInput({ params, index }: KernelInput): Coefficients & { px: number; py: number } {
  const values = params as Record<string, number | undefined>;
  for (const id of SURFACE_GRADIENT_PARAMETERS) {
    const value = values[id], [min, max] = SURFACE_GRADIENT_DOMAIN[id];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
      throw new RangeError('Parameters are outside the declared domain; the runtime must reject them before evaluation.');
  }
  const { a, b, c, px, py } = values as Record<typeof SURFACE_GRADIENT_PARAMETERS[number], number>;
  if (!(a * c - b * b > 0)) throw new RangeError('The coefficients are not positive definite (a·c − b² ≤ 0); the runtime must reject them before evaluation.');
  if (index !== 0) throw new RangeError('This static model has no iteration index.');
  return { a, b, c, px, py };
}

/** Evaluates the one static frame: point quantities and every view's geometry from the same parameters. */
export function evaluateQuadraticSurfaceGradient(input: KernelInput): KernelOutput {
  const { a, b, c, px: rawX, py: rawY } = checkInput(input);
  const coefficients = { a, b, c };
  const px = rawX + 0, py = rawY + 0;
  const point = evaluatePoint(coefficients, px, py);

  const xs = Array.from({ length: SURFACE_GRID.n }, (_, i) => gridValue(i, SURFACE_GRID));
  const z = xs.flatMap(y => xs.map(x => height(coefficients, x, y)));
  const field: { at: Vec2; vector: Vec2 }[] = [];
  let longest = 0;
  for (let j = 0; j < FIELD_GRID.n; j++) for (let i = 0; i < FIELD_GRID.n; i++) {
    const at: Vec2 = [gridValue(i, FIELD_GRID), gridValue(j, FIELD_GRID)];
    const vector = gradientAt(coefficients, at[0], at[1]);
    longest = Math.max(longest, Math.hypot(vector[0], vector[1]));
    field.push({ at, vector });
  }
  const arrowScale = ARROW_SCALES.find(factor => factor * longest <= ARROW_MAX_LENGTH) ?? ARROW_SCALES[ARROW_SCALES.length - 1]!;
  const sections = Array.from({ length: SECTION_SAMPLES.n }, (_, i) => gridValue(i, SECTION_SAMPLES));
  const section = (along: 'x' | 'y') => ({
    kind: 'polyline2' as const,
    segments: [{ points: sections.map((s): Vec2 => [s, along === 'x' ? height(coefficients, s, 0) : height(coefficients, 0, s)]), start: 'none' as const, end: 'none' as const }],
    gaps: [], sampling: { samples: SECTION_SAMPLES.n, domain: [...SECTION_SAMPLES.domain] as [number, number] },
  });

  // The point's arrow s·∇f(p) from p, in the contour plane and in the plane z = f(p); omitted where it has no extent.
  const tail: Vec2 = [px, py];
  const tip: Vec2 = [px + arrowScale * point.components[0] + 0, py + arrowScale * point.components[1] + 0];
  const drawn = point.direction.status === 'valid' && (tip[0] !== tail[0] || tip[1] !== tail[1]);
  const lifted = (at: Vec2): Vec3 => [at[0], at[1], point.height!];
  const geometry: Record<string, GeometryResult> = {
    surface: { kind: 'surface-grid', xs, ys: [...xs], z, sampling: { nx: SURFACE_GRID.n, ny: SURFACE_GRID.n, domain: [-2, 2, -2, 2] } },
    contours: { kind: 'polyline2', segments: CONTOUR_LEVELS.map(level => ({ points: contour(coefficients, level), start: 'none' as const, end: 'none' as const })), gaps: [] },
    field: { kind: 'vector-field2', samples: field, scale: { factor: arrowScale, disclosure: arrowDisclosure(arrowScale) } },
    'cross-section-x': section('x'),
    'cross-section-y': section('y'),
    'point-2d': { kind: 'points2', points: [{ id: 'p', at: tail }] },
    'point-3d': { kind: 'points3', points: [point.height === null ? { id: 'p', at: null, reason: `The height cannot be drawn: ${(point.value as { reason: string }).reason}` } : { id: 'p', at: lifted(tail) }] },
    'gradient-2d': { kind: 'segments2', segments: drawn ? [{ id: 'gradient', from: tail, to: tip }] : [] },
    'gradient-3d': { kind: 'segments3', segments: drawn && point.height !== null ? [{ id: 'gradient', from: lifted(tail), to: lifted(tip) }] : [] },
  };
  return {
    quantities: {
      point: valid([px, py]),
      value: point.value,
      gradient: point.gradient,
      'gradient.norm': point.norm,
      'gradient.direction': point.direction,
      'hessian.det': point.determinant,
      'minimum.location': valid([0, 0]),
      'minimum.value': valid(0),
      'arrow.scale': valid(arrowScale),
    },
    geometry,
  };
}

export const quadraticSurfaceGradientKernel: ModelKernel = /* @__PURE__ */ Object.freeze({
  id: SURFACE_GRADIENT_KERNEL_ID,
  version: SURFACE_GRADIENT_KERNEL_VERSION,
  mode: 'static',
  evaluate: evaluateQuadraticSurfaceGradient,
});
