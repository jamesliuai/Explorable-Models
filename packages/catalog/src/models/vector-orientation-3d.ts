/**
 * Model manifest for the orientation of two vectors in a right-handed three-dimensional frame (report §12.4). Data
 * only; the installed kernel `vector-orientation-3d@1.0.0` evaluates it in the catalogue worker.
 */
import type { ModelGeometryDefinition, ModelManifest, ModelParameterDefinition, ModelQuantityDefinition } from '@experiment-kit/core/model';
import {
  ANGLE_ARC, RELATIONSHIP_TOLERANCE, VECTOR_ORIENTATION_DOMAIN, VECTOR_ORIENTATION_KERNEL_ID, VECTOR_ORIENTATION_KERNEL_VERSION, VECTOR_RELATIONSHIPS,
} from '../kernels/vector-orientation-3d.js';

/**
 * sha256 of the exact bytes of tests/reference/fixtures/activities/vector-orientation-3d.json. The fixture lives
 * outside the catalogue so a kernel change cannot rewrite its own acceptance cases; tests/catalog verifies this value
 * against the file, and any fixture change therefore changes this model's scientific revision.
 */
export const VECTOR_ORIENTATION_REFERENCE_SUITE_DIGEST = 'sha256:ae6ee27be8c85f6c6d209a3a3361f443ea01d8d0d651ccb051b6aa64fa560f02';

const FRAME = 'right-handed Cartesian frame (x, y, z), origin shared by u and v';
const COMPONENTS = 'Components (x, y, z) along the positive axes of the right-handed frame, where e_x × e_y = e_z.';
const PLANES = {
  xy: { frame: 'xy plane of the right-handed frame, viewed from +z (z toward the viewer)', axes: '(x, y)' },
  xz: { frame: 'xz plane of the right-handed frame, viewed from −y (y away from the viewer)', axes: '(x, z)' },
  yz: { frame: 'yz plane of the right-handed frame, viewed from +x (x toward the viewer)', axes: '(y, z)' },
} as const;
const { min, max } = VECTOR_ORIENTATION_DOMAIN;
const DEFAULTS = { ux: 2, uy: 1, uz: 0, vx: 1, vy: 2, vz: 2 } as const;

const component = (vector: 'u' | 'v', axis: 'x' | 'y' | 'z'): ModelParameterDefinition => ({
  label: `${vector} ${axis} component`, symbol: `${vector}_${axis}`,
  description: `The ${axis} component of the vector ${vector}, drawn from the origin. Every component from ${min} to ${max} is allowed, including 0.`,
  dimension: 'dimensionless', unit: 'dimensionless', min, max, default: DEFAULTS[`${vector}${axis}`],
  step: { ui: 0.5, admissible: 'continuous' }, role: 'model-input',
});
const vector3 = (label: string, symbol: string, meaning: string, signConvention = COMPONENTS): ModelQuantityDefinition =>
  ({ label, symbol, shape: { kind: 'vector', length: 3 }, dimension: 'dimensionless', unit: 'dimensionless', meaning, coordinateFrame: FRAME, signConvention });
const length = (label: string, symbol: string, meaning: string): ModelQuantityDefinition =>
  ({ label, symbol, shape: { kind: 'scalar' }, dimension: 'dimensionless', unit: 'dimensionless', meaning, coordinateFrame: FRAME, signConvention: 'A length: never negative; 0 only for the zero vector.' });
const projection = (vector: 'u' | 'v', plane: keyof typeof PLANES): ModelQuantityDefinition => ({
  label: `${vector} projected onto the ${plane} plane`, symbol: `${vector}_{${plane}}`, shape: { kind: 'vector', length: 2 }, dimension: 'dimensionless', unit: 'dimensionless',
  meaning: `Orthogonal projection of ${vector} onto the ${plane} plane: its components ${PLANES[plane].axes}, with the third component dropped.`,
  coordinateFrame: PLANES[plane].frame, signConvention: `Components ${PLANES[plane].axes} along the positive axes of that plane.`,
});
const segments = (kind: 'segments2' | 'segments3', label: string, coordinateFrame: string, count: number, description: string): ModelGeometryDefinition =>
  // Element counts are vertices: two per segment.
  ({ kind, label, description, dimension: 'dimensionless', unit: 'dimensionless', coordinateFrame, maxElements: 2 * count });
const projectionGeometry = (plane: keyof typeof PLANES): ModelGeometryDefinition =>
  segments('segments2', `Projections onto the ${plane} plane`, PLANES[plane].frame, 2,
    `Segments from the origin to the projections of u (ID "u") and v (ID "v") onto the ${plane} plane. A vector perpendicular to the plane projects to a point and has no segment there.`);

export const vectorOrientationManifest: ModelManifest = {
  contract: 'experiment-kit.model-manifest',
  schemaVersion: '1.0',
  modelId: 'vector-orientation-3d',
  version: '1.0.0',
  title: 'Orientation of two vectors in space',
  summary: `Two vectors u and v with components in [${min}, ${max}] in a right-handed frame: lengths, dot product, angle in radians, cross product with its unit direction, a classification as parallel, antiparallel, orthogonal or oblique, and projections onto the coordinate planes, with explicit undefined states for zero vectors and zero cross products.`,
  execution: { kind: 'kernel', kernelId: VECTOR_ORIENTATION_KERNEL_ID, kernelVersion: VECTOR_ORIENTATION_KERNEL_VERSION, mode: 'static' },
  // θ, the unit directions and the arc use Math.atan2, Math.cos, Math.sin and `**`, which ECMAScript lets engines approximate.
  evaluation: { determinism: 'within-engine', checkpoint: 'none' },
  capabilities: [{ id: 'spatial-3d', version: '1.0' }],
  parameters: {
    ux: component('u', 'x'), uy: component('u', 'y'), uz: component('u', 'z'),
    vx: component('v', 'x'), vy: component('v', 'y'), vz: component('v', 'z'),
  },
  quantities: {
    u: vector3('Vector u', 'u', 'The vector u = (u_x, u_y, u_z), equal to its three parameters.'),
    v: vector3('Vector v', 'v', 'The vector v = (v_x, v_y, v_z), equal to its three parameters.'),
    'u.norm': length('Length of u', '|u|', '|u| = √(u_x² + u_y² + u_z²), rounded once from its exact value.'),
    'v.norm': length('Length of v', '|v|', '|v| = √(v_x² + v_y² + v_z²), rounded once from its exact value.'),
    dot: {
      label: 'Dot product', symbol: 'u \\cdot v', shape: { kind: 'scalar' }, dimension: 'dimensionless', unit: 'dimensionless',
      meaning: 'u·v = u_x v_x + u_y v_y + u_z v_z = |u|·|v|·cos θ, rounded once from its exact value. It does not depend on the order of u and v.',
      coordinateFrame: FRAME, signConvention: 'Positive for an acute angle, 0 for a right angle or a zero vector, negative for an obtuse angle.',
    },
    angle: {
      label: 'Angle between u and v', symbol: '\\theta', shape: { kind: 'scalar' }, dimension: 'angle', unit: 'rad',
      meaning: 'θ = atan2(|u×v|, u·v), the unsigned angle between u and v in radians, 0 ≤ θ ≤ π. Undefined (ZERO_VECTOR) when u or v is the zero vector, because a zero vector has no direction.',
      coordinateFrame: FRAME, signConvention: 'Unsigned: the same for (u, v) and (v, u); 0 when u and v point the same way, π when they point in opposite directions.',
    },
    relationship: {
      label: 'Relationship of u and v', shape: { kind: 'category', values: [...VECTOR_RELATIONSHIPS] }, dimension: 'dimensionless', unit: 'dimensionless',
      meaning: `Classification with the declared tolerance τ = ${RELATIONSHIP_TOLERANCE} (the rational 1/10¹², applied exactly to the inputs): parallel when sin θ ≤ τ and u·v > 0, antiparallel when sin θ ≤ τ and u·v < 0, orthogonal when |cos θ| ≤ τ, oblique otherwise, undefined-zero-vector when u or v is the zero vector. Never derived from displayed digits.`,
    },
    cross: vector3('Cross product', 'u \\times v',
      'u×v = (u_y v_z − u_z v_y, u_z v_x − u_x v_z, u_x v_y − u_y v_x), each component rounded once from its exact value. Its length is |u|·|v|·sin θ and it is perpendicular to both u and v; it is the zero vector exactly when u or v is zero or u and v are parallel or antiparallel.',
      'Right-hand rule: with the fingers of the right hand turning from u toward v through θ, the thumb points along u×v; e_x × e_y = e_z, and v×u = −(u×v).'),
    'cross.norm': length('Length of the cross product', '|u \\times v|', '|u×v| = |u|·|v|·sin θ, the area of the parallelogram spanned by u and v, rounded once from its exact value.'),
    'cross.direction': vector3('Direction of the cross product', '\\hat{n}',
      'Unit vector u×v / |u×v|, normal to the plane of u and v. Undefined (NO_CROSS_DIRECTION) whenever u×v = 0 exactly (a zero vector, or parallel or antiparallel vectors); no direction is ever chosen arbitrarily. Defined for every nonzero u×v, including nearly parallel vectors classified as parallel within the tolerance, where it is sensitive to tiny input changes.',
      'Right-hand rule, as for u×v.'),
    'u.xy': projection('u', 'xy'), 'v.xy': projection('v', 'xy'),
    'u.xz': projection('u', 'xz'), 'v.xz': projection('v', 'xz'),
    'u.yz': projection('u', 'yz'), 'v.yz': projection('v', 'yz'),
  },
  geometry: {
    vectors: segments('segments3', 'Vectors u and v', FRAME, 2,
      'Segments from the origin to u (ID "u") and to v (ID "v"). A zero vector has no segment, so no arrowhead is ever drawn for it; its components remain in the values.'),
    cross: segments('segments3', 'Cross product u × v', FRAME, 1,
      'Segment from the origin to u×v (ID "cross") at true scale, which can extend beyond the default view. Empty when u×v = 0 or is too small to represent.'),
    'angle-arc': {
      kind: 'polyline3', label: 'Angle arc', dimension: 'dimensionless', unit: 'dimensionless', coordinateFrame: FRAME, maxElements: ANGLE_ARC.samples,
      description: `${ANGLE_ARC.samples} points sampled evenly in angle along the circular arc from u to v in their common plane, with radius min(${ANGLE_ARC.maxRadius}, ${ANGLE_ARC.radiusFraction}·min(|u|, |v|)). Empty, with a reason, when a vector is zero, when u and v point the same way (θ = 0), when they point in opposite directions (the plane of the turn is not unique) or when θ is too small to represent.`,
    },
    'projection-xy': projectionGeometry('xy'),
    'projection-xz': projectionGeometry('xz'),
    'projection-yz': projectionGeometry('yz'),
  },
  constraints: [],
  interpretation: {
    coordinateConvention: 'Right-handed Cartesian frame with axes x, y, z and e_x × e_y = e_z; u and v are free vectors drawn from the common origin. The xy projection is viewed from +z, the xz projection from −y and the yz projection from +x, each with its first named axis to the right and the second up.',
    angleConvention: 'θ is the unsigned angle between u and v in radians, 0 ≤ θ ≤ π, computed as atan2(|u×v|, u·v). Degree display converts at the presentation boundary (1° = π/180 rad); the canonical value stays in radians.',
    handedness: 'right',
    assumptions: [
      'u and v are dimensionless vectors in a right-handed Cartesian frame; their components are exact IEEE-754 double values.',
      'The cross product follows the right-hand rule: e_x × e_y = e_z, e_y × e_z = e_x, e_z × e_x = e_y.',
      `Two nonzero vectors are classified with the tolerance τ = 1/10¹²: parallel or antiparallel when sin θ ≤ τ, orthogonal when |cos θ| ≤ τ, decided exactly from the inputs.`,
      'Evaluation is deterministic within one JavaScript engine: θ, the unit directions and the angle arc use Math.atan2, Math.cos, Math.sin and exponentiation, which ECMAScript lets each engine approximate, so their last bits can differ between engines; the dot and cross products, the lengths and the relationship are computed exactly and are the same on every engine.',
    ],
    limitations: [
      'Dot products, cross-product components and lengths are rounded once from exact values; θ and the unit direction are computed from those rounded, rescaled values and agree with exact references to a few units in the last place.',
      'The classification is a tolerance decision on exact values, not a property of displayed digits: decimal inputs that are not exactly proportional in binary can be parallel within the tolerance while u×v is a tiny nonzero vector with a defined, input-sensitive direction.',
      'A nonzero result smaller than the smallest representable number is a numerical-limit status, never 0; an inexact result below the smallest normal double is reported as a reduced-precision approximation.',
      `The cross product is drawn at true scale and can leave the default view; the unit direction is drawn with length 1. The angle arc is sampled at ${ANGLE_ARC.samples} points; the polyline between samples is a drawing aid.`,
      'Projections onto coordinate planes drop one component each, so a single projection cannot show whether two vectors are parallel or orthogonal in space.',
    ],
  },
  // Static evaluation: about forty exact integer products and sums, one integer square root per length, and the arc samples;
  // maxOperations counts the kernel's own evaluated operators, calls and loop iterations (tests/catalog/kernel-work.test.ts): about 2,600 in the worst sampled case.
  limits: { maxGeometryElements: 2 * 2 + 2 + ANGLE_ARC.samples + 3 * 2 * 2, maxOperations: 5_000 },
  sources: [
    {
      id: 'derivation-vector-products', kind: 'derivation',
      citation: 'Derivation written for this catalogue: u·v = Σ u_i v_i = |u||v| cos θ; u×v = (u_y v_z − u_z v_y, u_z v_x − u_x v_z, u_x v_y − u_y v_x) with e_x × e_y = e_z in a right-handed frame, so |u×v| = |u||v| sin θ and |u×v|² + (u·v)² = |u|²|v|² (Lagrange\'s identity). Hence θ = atan2(|u×v|, u·v) ∈ [0, π], defined when u ≠ 0 and v ≠ 0; u×v = 0 exactly when a vector is zero or u and v are parallel or antiparallel, and then it has no direction. Not independently reviewed.',
    },
    {
      id: 'study-harness-specification', kind: 'specification',
      citation: 'Study Harness visualizer implementation report §12.4 (spatial vector orientation: two vectors, their angle, dot and cross products with declared handedness, coordinate projections, orientation presets, exact numeric alternatives, parallel, antiparallel, orthogonal and zero-vector checks) and §11 (3D equivalents).',
    },
  ],
  referenceSuite: { suiteId: 'vector-orientation-3d:1.0.0', digest: VECTOR_ORIENTATION_REFERENCE_SUITE_DIGEST },
};
