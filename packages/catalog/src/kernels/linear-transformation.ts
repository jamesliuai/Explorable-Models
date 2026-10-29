/**
 * Installed pure kernel: a real 2×2 matrix M acting on the plane (report §12.2).
 *
 * Column-vector convention: vectors are columns and M acts by M·v, so M·e₁ = (m11, m21) is the FIRST COLUMN of M and
 * M·e₂ = (m12, m22) is the second column; entry m_ij sits in row i, column j.
 *
 * Declared semantics (shared with the reference fixture, not with its oracle's code): every statement is about the
 * matrix with exactly the stored IEEE-754 entries. Each finite double is an integer multiple of 2^-1074, so the kernel
 * works on those integers with BigInt: the determinant, trace, discriminant (tr M)² − 4·det M, M·v and every mapped
 * grid point are exact and rounded to the nearest double once (ties to even). Orientation, rank and the eigen
 * category are decided from exact signs and exact equalities — never from a tolerance or from rounded display digits.
 * Irrational values (√discriminant, eigenvalues, unit directions) use an integer square root carrying 64 bits beyond
 * the exact operands, the product rule λ_small = det M / λ_big without cancellation, and the cancellation-free
 * eigenvector formulas below; they agree with exact values to within a few units in the last place.
 *
 * Undefined is a status, never zero: complex eigenvalues, all-directions (M = λ·I), a single defective direction,
 * a full-rank or zero image line each have their own code. A nonzero exact value that rounds to zero is
 * `numerical-limit`/`UNDERFLOW` (orientation and rank still follow the exact value); a computed result in the
 * subnormal range is valid with an `UNDERFLOW` approximation note, while copies of the stored inputs (v, M·e₁, M·e₂)
 * are exact and carry none. Entries are bounded by 3 in magnitude, so nothing can overflow. A zero test vector and
 * the zero matrix are valid inputs whose images are the zero vector.
 */
import type { GeometryResult, KernelInput, KernelOutput, ModelKernel, QuantityResult, Vec2 } from '@explorable-models/core/model';

export const LINEAR_KERNEL_ID = 'linear-transformation';
export const LINEAR_KERNEL_VERSION = '1.0.0';
/** Canonical (dimensionless) bounds: every matrix entry and both test-vector components lie in [−3, 3]. */
export const LINEAR_DOMAIN = Object.freeze({ entry: [-3, 3], vector: [-3, 3] } as const);
export const LINEAR_MATRIX_PARAMETERS = ['m11', 'm12', 'm21', 'm22'] as const;
export const LINEAR_VECTOR_PARAMETERS = ['vx', 'vy'] as const;
export const LINEAR_ORIENTATIONS = ['preserved', 'reversed', 'collapsed'] as const;
export const LINEAR_EIGEN_CATEGORIES = ['two-real', 'repeated-scalar', 'repeated-defective', 'complex'] as const;
export type LinearOrientation = typeof LINEAR_ORIENTATIONS[number];
export type LinearEigenCategory = typeof LINEAR_EIGEN_CATEGORIES[number];
/** Reference grid: lines x = k and y = k for the integers k in [−extent, extent], each drawn from −extent to extent. */
export const LINEAR_GRID = Object.freeze({ extent: 3, segments: 14 });
/** Half-length of each drawn eigen-direction line (beyond the half-diagonal 6√2 of the authored ±6 view). */
export const LINEAR_EIGEN_LINE_HALF_LENGTH = 9;
/** Reason codes of the undefined statuses this kernel reports. */
export const LINEAR_UNDEFINED = Object.freeze({
  complex: 'COMPLEX_EIGENVALUES', allDirections: 'ALL_DIRECTIONS', singleDirection: 'SINGLE_DIRECTION', fullRank: 'FULL_RANK', zeroImage: 'ZERO_IMAGE',
} as const);

/** Orientation from the exact sign of the determinant. */
export const orientationOf = (sign: -1 | 0 | 1): LinearOrientation => (sign > 0 ? 'preserved' : sign < 0 ? 'reversed' : 'collapsed');

// ---------------------------------------------------------------------------------------------
// Exact dyadic integers: a finite double x equals X·2^-1074 for exactly one integer X.
// ---------------------------------------------------------------------------------------------
const bits = /* @__PURE__ */ new DataView(new ArrayBuffer(8));
const QUANTUM = -1074;
/** Extra bits carried by the integer square root beyond the exact operands. */
const EXTRA = 64n;

/** Exact 2^e for −1022 ≤ e ≤ 1023, assembled from the exponent bits. */
function pow2(e: number): number {
  bits.setUint32(0, (e + 1023) << 20);
  bits.setUint32(4, 0);
  return bits.getFloat64(0);
}
const MIN_NORMAL = /* @__PURE__ */ pow2(-1022);

/** The integer X with x = X·2^-1074, read from the bit pattern. */
function dyadic(x: number): bigint {
  bits.setFloat64(0, x);
  const word = bits.getBigUint64(0);
  const biased = Number((word >> 52n) & 0x7ffn);
  const fraction = word & 0xfffffffffffffn;
  const magnitude = biased === 0 ? fraction : (fraction | 0x10000000000000n) << BigInt(biased - 1);
  return word >> 63n === 1n ? -magnitude : magnitude;
}
const bitLength = (n: bigint): number => (n === 0n ? 0 : (n < 0n ? -n : n).toString(2).length);
const absolute = (n: bigint): bigint => (n < 0n ? -n : n);
const signOf = (n: bigint): -1 | 0 | 1 => (n < 0n ? -1 : n > 0n ? 1 : 0);

/** m·2^e for an integer 0 ≤ m ≤ 2^53 whose product is representable; every step multiplies by an exact power of two. */
function ldexp(m: number, e: number): number {
  let value = m, rest = e;
  while (rest > 1000) { value *= pow2(1000); rest -= 1000; }
  while (rest < -1000) { value *= pow2(-1000); rest += 1000; }
  return value * pow2(rest);
}

/** A correctly rounded double, or `null` when a nonzero exact value rounds to zero. */
type Rounded = { value: number; subnormal: boolean } | null;

/** Nearest double (ties to even) to n·2^exponent, including the subnormal range. */
function roundScaled(n: bigint, exponent: number): Rounded {
  if (n === 0n) return { value: 0, subnormal: false };
  const magnitude = absolute(n);
  // Discard low bits beyond 53 significant bits, and never below the subnormal quantum 2^-1074.
  const drop = Math.max(bitLength(magnitude) - 53, QUANTUM - exponent);
  let kept = magnitude;
  if (drop > 0) {
    kept = magnitude >> BigInt(drop);
    const rest = magnitude - (kept << BigInt(drop)), half = 1n << BigInt(drop - 1);
    if (rest > half || (rest === half && (kept & 1n) === 1n)) kept += 1n;
  }
  if (kept === 0n) return null;
  const value = ldexp(Number(kept), exponent + Math.max(drop, 0));
  return { value: n < 0n ? -value : value, subnormal: value < MIN_NORMAL };
}

/** Nearest double to (numerator/denominator)·2^exponent, denominator ≠ 0: a ≥ 55-bit quotient plus a sticky bit, rounded once. */
function roundQuotient(numerator: bigint, denominator: bigint, exponent: number): Rounded {
  if (numerator === 0n) return { value: 0, subnormal: false };
  const shift = Math.max(0, bitLength(denominator) - bitLength(numerator) + 56);
  const scaled = absolute(numerator) << BigInt(shift), divisor = absolute(denominator);
  const quotient = scaled / divisor, sticky = scaled % divisor === 0n ? 0n : 1n;
  return roundScaled(BigInt(signOf(numerator) * signOf(denominator)) * ((quotient << 1n) | sticky), exponent - shift - 1);
}

/** ⌊√n⌋ for n ≥ 0 by Newton's iteration from above. */
function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = 1n << BigInt((bitLength(n) + 1) >> 1);
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

// ---------------------------------------------------------------------------------------------
// Quantity results
// ---------------------------------------------------------------------------------------------
const SUBNORMAL_NOTE = 'Below the smallest normal double; the value is held with reduced precision.';
const underflow = (name: string): QuantityResult =>
  ({ status: 'numerical-limit', code: 'UNDERFLOW', reason: `${name} is nonzero but smaller than the smallest representable number; it is not zero.` });
const undefinedResult = (code: string, reason: string): QuantityResult => ({ status: 'undefined', code, reason });
const valid = (value: number | number[] | string): QuantityResult => ({ status: 'valid', value });

function scalarResult(rounded: Rounded, name: string): QuantityResult {
  if (!rounded) return underflow(name);
  return rounded.subnormal ? { status: 'valid', value: rounded.value, approximation: { code: 'UNDERFLOW', reason: SUBNORMAL_NOTE } } : valid(rounded.value);
}
function vectorResult(components: Rounded[], name: string): QuantityResult {
  if (components.some(component => component === null)) return underflow(`A component of ${name}`);
  const values = components.map(component => component!.value);
  return components.some(component => component!.subnormal)
    ? { status: 'valid', value: values, approximation: { code: 'UNDERFLOW', reason: SUBNORMAL_NOTE } }
    : valid(values);
}

/**
 * Unit vector along the exact nonzero integer pair (x, y). A line has two unit directions; the one whose first
 * nonzero component is positive is reported. Both components are rounded once onto a common scale 2^-L (L the larger
 * bit length) before the floating-point normalization, so a component far smaller than the other is kept, not truncated.
 */
function unitDirection(x: bigint, y: bigint, name: string): QuantityResult {
  const flip = x < 0n || (x === 0n && y < 0n);
  const px = flip ? -x : x, py = flip ? -y : y;
  const scale = -Math.max(bitLength(px), bitLength(py));
  const fx = roundScaled(px, scale)?.value ?? 0, fy = roundScaled(py, scale)?.value ?? 0;
  const norm = Math.sqrt(fx * fx + fy * fy);
  const component = (exact: bigint, scaled: number): Rounded => {
    const value = scaled / norm;
    if (exact !== 0n && value === 0) return null;
    return { value: value + 0, subnormal: value !== 0 && Math.abs(value) < MIN_NORMAL };
  };
  return vectorResult([component(px, fx), component(py, fy)], name);
}

// ---------------------------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------------------------
type Params = Record<typeof LINEAR_MATRIX_PARAMETERS[number] | typeof LINEAR_VECTOR_PARAMETERS[number], number>;

function checkInput({ params, index }: KernelInput): Params {
  const values = {} as Params;
  for (const id of [...LINEAR_MATRIX_PARAMETERS, ...LINEAR_VECTOR_PARAMETERS]) {
    const value = (params as Record<string, number | undefined>)[id];
    const [min, max] = id.startsWith('m') ? LINEAR_DOMAIN.entry : LINEAR_DOMAIN.vector;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
      throw new RangeError('Parameters are outside the declared domain; the runtime must reject them before evaluation.');
    values[id] = value;
  }
  if (index !== 0) throw new RangeError('This static model has a single state; the runtime evaluates it at index 0.');
  return values;
}

const GRID_LINES = /* @__PURE__ */ Array.from({ length: 2 * LINEAR_GRID.extent + 1 }, (_, i) => i - LINEAR_GRID.extent);
/** The reference grid as integer endpoint pairs: x = k from (k, −3) to (k, 3), then y = k from (−3, k) to (3, k). */
const GRID: { id: string; from: [number, number]; to: [number, number] }[] = [
  ...GRID_LINES.map(k => ({ id: `x=${k}`, from: [k, -LINEAR_GRID.extent] as [number, number], to: [k, LINEAR_GRID.extent] as [number, number] })),
  ...GRID_LINES.map(k => ({ id: `y=${k}`, from: [-LINEAR_GRID.extent, k] as [number, number], to: [LINEAR_GRID.extent, k] as [number, number] })),
];
const UNIT_SQUARE: Vec2[] = [[0, 0], [1, 0], [1, 1], [0, 1]];

/** Evaluates the single static state of the transformation for the stored entries and test vector. */
export function evaluateLinearTransformation(input: KernelInput): KernelOutput {
  const p = checkInput(input);
  const [A, B, C, D, VX, VY] = [p.m11, p.m12, p.m21, p.m22, p.vx, p.vy].map(dyadic) as [bigint, bigint, bigint, bigint, bigint, bigint];
  const entry = (x: number): number => x + 0; // −0 is reported as +0

  /** M·(x, y) for integer x, y, exact then rounded; a nonzero multiple of 2^-1074 never rounds to zero. */
  const map = ([x, y]: [number, number]): Vec2 => [
    roundScaled(A * BigInt(x) + B * BigInt(y), QUANTUM)!.value,
    roundScaled(C * BigInt(x) + D * BigInt(y), QUANTUM)!.value,
  ];

  const DET = A * D - B * C; // det M at scale 2^-2148
  const TRACE = A + D; // tr M at scale 2^-1074
  const DISC = (A - D) * (A - D) + 4n * B * C; // (tr M)² − 4·det M at scale 2^-2148
  const zero = A === 0n && B === 0n && C === 0n && D === 0n;
  const scalar = B === 0n && C === 0n && A === D;
  const rank = zero ? 0 : DET === 0n ? 1 : 2;
  const category: LinearEigenCategory = scalar ? 'repeated-scalar' : DISC > 0n ? 'two-real' : DISC === 0n ? 'repeated-defective' : 'complex';

  // Image line of a rank-1 matrix: the nonzero column of larger norm (the columns are parallel), exactly.
  const imageDirection = rank === 2
    ? undefinedResult(LINEAR_UNDEFINED.fullRank, 'M has rank 2: the image is the whole plane, not a single line.')
    : rank === 0
      ? undefinedResult(LINEAR_UNDEFINED.zeroImage, 'M is the zero matrix: every vector maps to the origin, so the image is a single point with no direction.')
      : A * A + C * C >= B * B + D * D ? unitDirection(A, C, 'the image direction') : unitDirection(B, D, 'the image direction');

  let eigenvalues: QuantityResult, direction1: QuantityResult, direction2: QuantityResult;
  if (category === 'complex') {
    eigenvalues = undefinedResult(LINEAR_UNDEFINED.complex, 'The discriminant (tr M)² − 4·det M is negative, so the eigenvalues are a complex-conjugate pair; there is no real eigenvalue.');
    direction1 = direction2 = undefinedResult(LINEAR_UNDEFINED.complex, 'The eigenvalues are complex, so no real direction is mapped onto its own line.');
  } else if (category === 'repeated-scalar') {
    const lambda = roundScaled(A, QUANTUM);
    eigenvalues = vectorResult([lambda, lambda], 'the repeated eigenvalue');
    direction1 = direction2 = undefinedResult(LINEAR_UNDEFINED.allDirections, 'M is a multiple of the identity, so every direction through the origin is mapped onto its own line; no single direction is singled out.');
  } else if (category === 'repeated-defective') {
    // λ = tr M / 2; M − λI = [[δ, b], [c, −δ]] with δ = (a − d)/2 has rank 1. Its null vector from the row of larger
    // norm, exactly: (b, −δ) from row 1 or (δ, c) from row 2, both at scale 2^-1075.
    const lambda = roundScaled(TRACE, QUANTUM - 1);
    eigenvalues = vectorResult([lambda, lambda], 'the repeated eigenvalue');
    direction1 = absolute(B) >= absolute(C) ? unitDirection(2n * B, -(A - D), 'the eigen-direction') : unitDirection(A - D, 2n * C, 'the eigen-direction');
    direction2 = undefinedResult(LINEAR_UNDEFINED.singleDirection, 'The eigenvalue is repeated but M is not a multiple of the identity, so exactly one direction is mapped onto its own line; there is no second one.');
  } else {
    // Integers in units of 2^-(1075 + EXTRA): δ = (a − d)/2 ↦ delta, tr/2 ↦ center, r = √disc / 2 ↦ root (floored, 64
    // bits beyond the exact operands), b ↦ Bs, c ↦ Cs.
    const delta = (A - D) << EXTRA, center = TRACE << EXTRA, root = isqrt(DISC << (2n * EXTRA));
    const Bs = B << (EXTRA + 1n), Cs = C << (EXTRA + 1n);
    const scale = QUANTUM - 1 - Number(EXTRA);
    // λ± = tr/2 ± r. The larger magnitude has no cancellation; the other is det M / λ_big (never 0 here: r > 0).
    const big = center >= 0n ? center + root : center - root;
    const bigValue = roundScaled(big, scale), smallValue = roundQuotient(DET, big, 2 * QUANTUM - scale);
    const [plus, minus] = center >= 0n ? [bigValue, smallValue] : [smallValue, bigValue];
    eigenvalues = vectorResult([plus, minus], 'an eigenvalue');
    // (M − λI)u = 0 with a − λ± = δ ∓ r: each formula adds δ and r with equal signs, so it never cancels.
    direction1 = delta >= 0n ? unitDirection(delta + root, Cs, 'the first eigen-direction') : unitDirection(Bs, root - delta, 'the first eigen-direction');
    direction2 = delta <= 0n ? unitDirection(delta - root, Cs, 'the second eigen-direction') : unitDirection(Bs, -(delta + root), 'the second eigen-direction');
  }

  const half = LINEAR_EIGEN_LINE_HALF_LENGTH;
  const lines = [direction1, direction2].flatMap((direction, i) => direction.status === 'valid'
    ? [{ id: `u${i + 1}`, from: (direction.value as number[]).map(c => -half * c + 0) as Vec2, to: (direction.value as number[]).map(c => half * c + 0) as Vec2 }]
    : []);
  const quantity = (n: bigint, exponent: number, name: string) => scalarResult(roundScaled(n, exponent), name);
  const geometry: Record<string, GeometryResult> = {
    'grid.original': { kind: 'segments2', segments: GRID.map(({ id, from, to }) => ({ id, from: [...from], to: [...to] })) },
    'grid.transformed': { kind: 'segments2', segments: GRID.map(({ id, from, to }) => ({ id, from: map(from), to: map(to) })) },
    'unit-square': { kind: 'polygon2', vertices: UNIT_SQUARE.map(([x, y]) => [x, y]), degenerate: false },
    'unit-square.image': { kind: 'polygon2', vertices: UNIT_SQUARE.map(vertex => map(vertex)), degenerate: DET === 0n },
    'eigen.lines': { kind: 'segments2', segments: lines },
  };
  return {
    quantities: {
      'basis.e1': valid([1, 0]),
      'basis.e2': valid([0, 1]),
      'vector.v': valid([entry(p.vx), entry(p.vy)]),
      'image.e1': valid([entry(p.m11), entry(p.m21)]),
      'image.e2': valid([entry(p.m12), entry(p.m22)]),
      'image.v': vectorResult([roundScaled(A * VX + B * VY, 2 * QUANTUM), roundScaled(C * VX + D * VY, 2 * QUANTUM)], 'M·v'),
      determinant: quantity(DET, 2 * QUANTUM, 'The determinant'),
      'area.scale': quantity(absolute(DET), 2 * QUANTUM, 'The area scale'),
      orientation: valid(orientationOf(signOf(DET))),
      rank: valid(rank),
      'image.direction': imageDirection,
      trace: quantity(TRACE, QUANTUM, 'The trace'),
      'eigen.discriminant': quantity(DISC, 2 * QUANTUM, 'The discriminant'),
      'eigen.category': valid(category),
      'eigen.values': eigenvalues,
      'eigen.direction1': direction1,
      'eigen.direction2': direction2,
    },
    geometry,
  };
}

export const linearTransformationKernel: ModelKernel = /* @__PURE__ */ Object.freeze({
  id: LINEAR_KERNEL_ID,
  version: LINEAR_KERNEL_VERSION,
  mode: 'static',
  evaluate: evaluateLinearTransformation,
});
