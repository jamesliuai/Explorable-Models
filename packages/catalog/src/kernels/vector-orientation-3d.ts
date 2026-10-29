/**
 * Installed pure kernel: orientation of two vectors u, v in a right-handed three-dimensional frame (report §12.4).
 *
 * Declared semantics (shared with the reference fixture, not with its oracle's code): every input is an IEEE-754
 * double, so u and v have exact dyadic-rational components. The dot product u·v, the components of the cross product
 * u×v = (u_y v_z − u_z v_y, u_z v_x − u_x v_z, u_x v_y − u_y v_x) and the lengths |u|, |v|, |u×v| are computed from
 * those exact values (integer arithmetic on the inputs scaled by 2^1074) and rounded to the nearest double once (ties
 * to even). No product underflows on the way, so exact zeros and exact signs are never artefacts of rounding.
 *
 * The relationship is classified from exact conditions with the declared tolerance τ = 10⁻¹² (the rational 1/10¹²):
 * parallel or antiparallel when |u×v| ≤ τ·|u|·|v| (sin θ ≤ τ) with the sign of u·v, orthogonal when
 * |u·v| ≤ τ·|u|·|v| (|cos θ| ≤ τ), otherwise oblique; a zero vector gives `undefined-zero-vector`. The angle
 * θ = atan2(|u×v|, u·v) ∈ [0, π] is in radians and evaluated from the rounded, commonly rescaled exact values, so it
 * keeps full relative precision for tiny and nearly opposite vectors.
 *
 * Undefined states are statuses, never numbers: an angle with a zero vector is `undefined`/`ZERO_VECTOR`; the unit
 * direction of u×v is `undefined`/`NO_CROSS_DIRECTION` whenever u×v = 0 exactly (zero, parallel or antiparallel
 * vectors) — no direction is ever chosen arbitrarily — and the angle arc is omitted with a reason when the plane of
 * the turn from u to v is not unique. A nonzero exact value that rounds to zero is `numerical-limit`/`UNDERFLOW`; an
 * inexact result below the smallest normal double is valid with an `UNDERFLOW` approximation note.
 */
import type { GeometryResult, KernelInput, KernelOutput, ModelKernel, PolylineSegment, QuantityResult, Vec2, Vec3 } from '@experiment-kit/core/model';

export const VECTOR_ORIENTATION_KERNEL_ID = 'vector-orientation-3d';
export const VECTOR_ORIENTATION_KERNEL_VERSION = '1.0.0';
/** Parameter IDs in order: components of u, then of v. */
export const VECTOR_ORIENTATION_PARAMETERS = ['ux', 'uy', 'uz', 'vx', 'vy', 'vz'] as const;
export type VectorParameter = typeof VECTOR_ORIENTATION_PARAMETERS[number];
/** Canonical (dimensionless) domain of every component. */
export const VECTOR_ORIENTATION_DOMAIN = Object.freeze({ min: -3, max: 3 } as const);
export const VECTOR_RELATIONSHIPS = ['parallel', 'antiparallel', 'orthogonal', 'oblique', 'undefined-zero-vector'] as const;
export type VectorRelationship = typeof VECTOR_RELATIONSHIPS[number];
/** Classification tolerance τ on sin θ and |cos θ|. Applied exactly as the rational 1/10¹², not as the double 1e-12. */
export const RELATIONSHIP_TOLERANCE = 1e-12;
/** Angle arc: samples, and radius min(maxRadius, radiusFraction·min(|u|, |v|)) so the arc never passes either tip. */
export const ANGLE_ARC = Object.freeze({ samples: 33, maxRadius: 1, radiusFraction: 0.5 } as const);

const TOLERANCE_INVERSE_SQUARED = 10n ** 24n; // 1/τ²
const QUANTUM_EXPONENT = 1074; // every double is an integer multiple of 2^-1074
const PRODUCT_SHIFT = 2 * QUANTUM_EXPONENT; // a product of two scaled inputs carries 2^-2148
const SMALLEST_NORMAL = 2.2250738585072014e-308;
const SUBNORMAL_NOTE = 'Below the smallest normal double: this value was rounded with reduced precision.';

// ---------------------------------------------------------------------------------------------
// Exact layer: integers n standing for n·2^-shift, rounded to a double once.
// ---------------------------------------------------------------------------------------------
const bits = /* @__PURE__ */ new DataView(new ArrayBuffer(8));

/** x·2^1074 as an exact integer (any finite double, including subnormals and −0). */
function scaledInteger(x: number): bigint {
  bits.setFloat64(0, x);
  const high = bits.getUint32(0), low = bits.getUint32(4);
  const biased = (high >>> 20) & 0x7ff;
  const fraction = (high & 0xfffff) * 4294967296 + low;
  const magnitude = biased === 0 ? BigInt(fraction) : BigInt(fraction + 4503599627370496) << BigInt(biased - 1);
  return high >>> 31 ? -magnitude : magnitude;
}
function bitLength(n: bigint): number {
  if (n === 0n) return 0;
  const hex = (n < 0n ? -n : n).toString(16);
  return (hex.length - 1) * 4 + 32 - Math.clz32(parseInt(hex[0]!, 16));
}
/** Exact 2^e for −1074 ≤ e ≤ 1023. */
function pow2(e: number): number {
  if (e < -1022) return pow2(e + 64) * pow2(-64);
  bits.setUint32(0, (e + 1023) << 20);
  bits.setUint32(4, 0);
  return bits.getFloat64(0);
}

interface Rounded { value: number; exact: boolean }
/** Nearest double to n·2^-shift (ties to even), rounded once, including the subnormal range. */
function nearest(n: bigint, shift: number): Rounded {
  if (n === 0n) return { value: 0, exact: true };
  const negative = n < 0n, m = negative ? -n : n;
  // Keep 53 significant bits, or fewer where the quantum 2^-1074 is coarser.
  const drop = Math.max(bitLength(m) - 53, shift - QUANTUM_EXPONENT);
  let q = m, exact = true;
  if (drop > 0) {
    const cut = BigInt(drop);
    q = m >> cut;
    const remainder = m - (q << cut), half = 1n << (cut - 1n);
    exact = remainder === 0n;
    if (remainder > half || (remainder === half && (q & 1n) === 1n)) q += 1n;
  }
  // q has at most 54 bits and the exponent is at least −1074, so the product is exact.
  const magnitude = Number(q) * pow2(Math.max(drop, 0) - shift);
  return { value: negative ? -magnitude : magnitude, exact };
}

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = 1n << BigInt((bitLength(n) >> 1) + 1);
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}
/** Nearest double to √(n·2^-shift) for n ≥ 0 and even shift. */
function nearestSqrt(n: bigint, shift: number): Rounded {
  if (n === 0n) return { value: 0, exact: true };
  const extra = Math.max(0, Math.ceil((128 - bitLength(n)) / 2)); // the root carries at least 64 bits
  const scaled = n << BigInt(2 * extra), root = isqrt(scaled);
  if (root * root === scaled) return nearest(root, shift / 2 + extra);
  // A non-square root lies strictly between root and root + 1, where no rounding boundary falls; root + ½ rounds alike.
  return { value: nearest(2n * root + 1n, shift / 2 + extra + 1).value, exact: false };
}

// ---------------------------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------------------------
const valid = (value: number | number[] | string): QuantityResult => ({ status: 'valid', value });
const tooSmall = (name: string): QuantityResult => ({ status: 'numerical-limit', code: 'UNDERFLOW', reason: `${name} is not zero but is smaller than the smallest representable number.` });
const reduced = (rounded: Rounded): boolean => !rounded.exact && Math.abs(rounded.value) < SMALLEST_NORMAL;

function scalar(rounded: Rounded, nonzero: boolean, name: string): QuantityResult {
  if (nonzero && rounded.value === 0) return tooSmall(name);
  return reduced(rounded) ? { status: 'valid', value: rounded.value, approximation: { code: 'UNDERFLOW', reason: SUBNORMAL_NOTE } } : valid(rounded.value + 0);
}
function vector(parts: Rounded[], exactParts: bigint[], name: string): QuantityResult {
  const values = parts.map(part => part.value + 0);
  const flushed = parts.some((part, i) => exactParts[i] !== 0n && part.value === 0);
  if (flushed && values.every(value => value === 0)) return { status: 'numerical-limit', code: 'UNDERFLOW', reason: `${name} is not the zero vector, but each of its nonzero components is smaller than the smallest representable number.` };
  if (flushed || parts.some(reduced))
    return { status: 'valid', value: values, approximation: { code: 'UNDERFLOW', reason: 'At least one component is below the smallest normal double: it is shown with reduced precision, or as 0 although it is not exactly 0.' } };
  return valid(values);
}

// ---------------------------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------------------------
type Triple = [bigint, bigint, bigint];
const crossOf = (a: Triple, b: Triple): Triple => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dotOf = (a: Triple, b: Triple): bigint => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const abs = (n: bigint): bigint => (n < 0n ? -n : n);
const plain = (x: number): number => x + 0;

/** Unit vector along exact components (scale-free): rescaled so the largest is in [½, 1), then normalized in doubles. */
function unit(components: Triple): Vec3 {
  const largest = components.reduce((max, c) => (abs(c) > max ? abs(c) : max), 0n);
  const scaled = components.map(c => nearest(c, bitLength(largest)).value);
  const length = Math.sqrt(scaled[0]! ** 2 + scaled[1]! ** 2 + scaled[2]! ** 2);
  return [plain(scaled[0]! / length), plain(scaled[1]! / length), plain(scaled[2]! / length)];
}
const crossDouble = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function checkInput({ params, index }: KernelInput): number[] {
  const values = VECTOR_ORIENTATION_PARAMETERS.map(id => params[id]);
  if (values.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < VECTOR_ORIENTATION_DOMAIN.min || value > VECTOR_ORIENTATION_DOMAIN.max))
    throw new RangeError('Parameters are outside the declared domain; the runtime must reject them before evaluation.');
  if (index !== 0) throw new RangeError('A static model is evaluated at index 0 only.');
  return values as number[];
}

/** Evaluates the single static state for the six components of u and v. */
export function evaluateVectorOrientation(input: KernelInput): KernelOutput {
  const inputs = checkInput(input).map(plain);
  const u: Vec3 = [inputs[0]!, inputs[1]!, inputs[2]!], v: Vec3 = [inputs[3]!, inputs[4]!, inputs[5]!];
  const U = u.map(scaledInteger) as Triple, V = v.map(scaledInteger) as Triple;
  const C = crossOf(U, V), P = dotOf(U, V);
  const normU2 = dotOf(U, U), normV2 = dotOf(V, V), cross2 = dotOf(C, C);
  const zeroU = normU2 === 0n, zeroV = normV2 === 0n;

  const uNorm = nearestSqrt(normU2, PRODUCT_SHIFT), vNorm = nearestSqrt(normV2, PRODUCT_SHIFT);
  const dot = scalar(nearest(P, PRODUCT_SHIFT), P !== 0n, 'The dot product');
  const cross = vector(C.map(c => nearest(c, PRODUCT_SHIFT)), C, 'The cross product');
  const crossNorm = scalar(nearestSqrt(cross2, 2 * PRODUCT_SHIFT), cross2 !== 0n, 'The length of the cross product');

  const zeroReason = zeroU && zeroV ? 'u and v are both the zero vector' : zeroU ? 'u is the zero vector' : 'v is the zero vector';
  let relationship: VectorRelationship;
  if (zeroU || zeroV) relationship = 'undefined-zero-vector';
  else if (cross2 * TOLERANCE_INVERSE_SQUARED <= normU2 * normV2) relationship = P > 0n ? 'parallel' : 'antiparallel';
  else if (P * P * TOLERANCE_INVERSE_SQUARED <= normU2 * normV2) relationship = 'orthogonal';
  else relationship = 'oblique';

  // θ = atan2(|u×v|, u·v); both carry 2^-2148, so one common power of two brings the larger near 1.
  let angle: QuantityResult;
  if (zeroU || zeroV) angle = { status: 'undefined', code: 'ZERO_VECTOR', reason: `${zeroReason}, so it has no direction and the angle between u and v is undefined.` };
  else {
    const common = Math.max(bitLength(P), Math.ceil(bitLength(cross2) / 2)) - 1;
    const theta = Math.atan2(nearestSqrt(cross2, 2 * common).value, nearest(P, common).value);
    angle = theta === 0 && cross2 !== 0n ? tooSmall('The angle')
      : theta !== 0 && theta < SMALLEST_NORMAL ? { status: 'valid', value: theta, approximation: { code: 'UNDERFLOW', reason: SUBNORMAL_NOTE } } : valid(theta);
  }

  const noDirection = zeroU || zeroV ? `${zeroReason}, so u × v = 0 and has no direction.`
    : P > 0n ? 'u and v point in exactly the same direction, so u × v = 0 and has no direction; none is chosen arbitrarily.'
      : 'u and v point in exactly opposite directions, so u × v = 0 and has no direction; no single plane contains a unique turn from u to v.';
  const direction = cross2 === 0n ? null : unit(C);
  const crossDirection: QuantityResult = direction ? valid(direction) : { status: 'undefined', code: 'NO_CROSS_DIRECTION', reason: noDirection };

  // Angle arc in the plane of u and v: r·(cos φ·û + sin φ·ŵ) with ŵ = n̂ × û, 0 ≤ φ ≤ θ, ending exactly on û and v̂.
  const arc: { segments: PolylineSegment<Vec3>[]; gaps: { after: null; before: null; reason: string }[] } = { segments: [], gaps: [] };
  if (!direction) arc.gaps.push({ after: null, before: null, reason: zeroU || zeroV ? `${zeroReason}, so the angle is undefined and no arc is drawn.` : P > 0n ? 'u and v point in exactly the same direction: the angle is 0 and there is no arc to draw.' : 'u and v point in exactly opposite directions: the angle is π, but no single plane contains the turn from u to v, so no arc is drawn.' });
  else if (angle.status !== 'valid') arc.gaps.push({ after: null, before: null, reason: 'The angle is smaller than the smallest representable number, so no arc is drawn.' });
  else {
    const theta = angle.value as number, uHat = unit(U), vHat = unit(V), wHat = crossDouble(direction, uHat);
    const radius = Math.min(ANGLE_ARC.maxRadius, ANGLE_ARC.radiusFraction * Math.min(uNorm.value, vNorm.value));
    const last = ANGLE_ARC.samples - 1;
    const points = Array.from({ length: ANGLE_ARC.samples }, (_, k): Vec3 => {
      if (k === 0 || k === last) { const tip = k === 0 ? uHat : vHat; return [plain(radius * tip[0]), plain(radius * tip[1]), plain(radius * tip[2])]; }
      const phi = (theta * k) / last, c = Math.cos(phi), s = Math.sin(phi);
      return [0, 1, 2].map(i => plain(radius * (c * uHat[i]! + s * wHat[i]!))) as Vec3;
    });
    arc.segments.push({ points, start: 'none', end: 'none' });
  }

  // Zero-length segments are omitted: a zero vector (or a vector perpendicular to a projection plane) has no arrow.
  const segments3 = (entries: [string, Vec3][]) => entries.filter(([, to]) => to.some(x => x !== 0)).map(([id, to]) => ({ id, from: [0, 0, 0] as Vec3, to: [...to] as Vec3 }));
  const project = (a: Vec3, i: number, j: number): Vec2 => [a[i]!, a[j]!];
  const projection = (i: number, j: number): GeometryResult => ({
    kind: 'segments2',
    segments: ([['u', project(u, i, j)], ['v', project(v, i, j)]] as [string, Vec2][]).filter(([, to]) => to.some(x => x !== 0)).map(([id, to]) => ({ id, from: [0, 0] as Vec2, to })),
  });
  const crossValues = cross.status === 'valid' ? cross.value as Vec3 : null;

  return {
    quantities: {
      u: valid([...u]),
      v: valid([...v]),
      'u.norm': scalar(uNorm, !zeroU, 'The length of u'),
      'v.norm': scalar(vNorm, !zeroV, 'The length of v'),
      dot,
      angle,
      relationship: valid(relationship),
      cross,
      'cross.norm': crossNorm,
      'cross.direction': crossDirection,
      'u.xy': valid(project(u, 0, 1)), 'v.xy': valid(project(v, 0, 1)),
      'u.xz': valid(project(u, 0, 2)), 'v.xz': valid(project(v, 0, 2)),
      'u.yz': valid(project(u, 1, 2)), 'v.yz': valid(project(v, 1, 2)),
    },
    geometry: {
      vectors: { kind: 'segments3', segments: segments3([['u', u], ['v', v]]) },
      cross: { kind: 'segments3', segments: crossValues ? segments3([['cross', crossValues]]) : [] },
      'angle-arc': { kind: 'polyline3', segments: arc.segments, gaps: arc.gaps },
      'projection-xy': projection(0, 1),
      'projection-xz': projection(0, 2),
      'projection-yz': projection(1, 2),
    },
  };
}

export const vectorOrientationKernel: ModelKernel = /* @__PURE__ */ Object.freeze({
  id: VECTOR_ORIENTATION_KERNEL_ID,
  version: VECTOR_ORIENTATION_KERNEL_VERSION,
  mode: 'static',
  evaluate: evaluateVectorOrientation,
});
