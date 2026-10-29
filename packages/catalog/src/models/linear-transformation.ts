/**
 * Model manifest for a 2×2 matrix acting on the plane (report §12.2). Data only; the installed kernel
 * `linear-transformation@1.0.0` evaluates it in the catalogue worker.
 */
import type { ModelManifest, ModelParameterDefinition, ModelQuantityDefinition } from '@experiment-kit/core/model';
import {
  LINEAR_DOMAIN, LINEAR_EIGEN_CATEGORIES, LINEAR_EIGEN_LINE_HALF_LENGTH, LINEAR_GRID, LINEAR_KERNEL_ID, LINEAR_KERNEL_VERSION, LINEAR_ORIENTATIONS,
} from '../kernels/linear-transformation.js';

/**
 * sha256 of the exact bytes of tests/reference/fixtures/activities/linear-transformation.json. The fixture lives outside
 * the catalogue so a kernel change cannot rewrite its own acceptance cases; tests/catalog verifies this value against
 * the file, and any fixture change therefore changes this model's scientific revision.
 */
export const LINEAR_REFERENCE_SUITE_DIGEST = 'sha256:1bcb216bab98b268056748e3e4b53fea6cd393e5487ea35449d602c57a8ed9a5';

const PLANE = 'standard plane: x to the right, y up, origin at the centre';
const COMPONENTS = 'Components (x, y) in the standard plane, x to the right and y up.';
const DIRECTION_SIGN = 'A line through the origin has two unit directions; the one whose first nonzero component is positive is reported.';
const grid = LINEAR_GRID.extent;

const entry = (row: 1 | 2, column: 1 | 2, value: number): ModelParameterDefinition => ({
  label: `Matrix entry row ${row}, column ${column}`, symbol: `m_{${row}${column}}`,
  description: `Entry m${row}${column} of M (row ${row}, column ${column}). Column ${column} of M is the image M·e${column} of the basis vector e${column}.`,
  dimension: 'dimensionless', unit: 'dimensionless', min: LINEAR_DOMAIN.entry[0], max: LINEAR_DOMAIN.entry[1], default: value,
  step: { ui: 0.1, admissible: 'continuous' }, role: 'model-input',
});
const component = (axis: 'x' | 'y', value: number): ModelParameterDefinition => ({
  label: `Test vector ${axis} component`, symbol: `v_${axis}`,
  description: `The ${axis} component of the test vector v before the transformation. The zero vector is allowed.`,
  dimension: 'dimensionless', unit: 'dimensionless', min: LINEAR_DOMAIN.vector[0], max: LINEAR_DOMAIN.vector[1], default: value,
  step: { ui: 0.1, admissible: 'continuous' }, role: 'model-input',
});
const vector = (label: string, symbol: string, meaning: string, signConvention = COMPONENTS): ModelQuantityDefinition =>
  ({ label, symbol, shape: { kind: 'vector', length: 2 }, dimension: 'dimensionless', unit: 'dimensionless', meaning, coordinateFrame: PLANE, signConvention });
const scalar = (label: string, symbol: string, meaning: string, signConvention?: string): ModelQuantityDefinition =>
  ({ label, symbol, shape: { kind: 'scalar' }, dimension: 'dimensionless', unit: 'dimensionless', meaning, ...(signConvention ? { signConvention } : {}) });

export const linearTransformationManifest: ModelManifest = {
  contract: 'experiment-kit.model-manifest',
  schemaVersion: '1.0',
  modelId: 'linear-transformation',
  version: '1.0.0',
  title: 'A 2×2 matrix as a transformation of the plane',
  summary: 'A real 2×2 matrix M with entries in [−3, 3] acting on column vectors: images of the basis vectors (the columns of M), of a test vector, of a reference grid and of the unit square; the determinant, the nonnegative area scale, orientation, rank and the real eigen-directions where they exist.',
  execution: { kind: 'kernel', kernelId: LINEAR_KERNEL_ID, kernelVersion: LINEAR_KERNEL_VERSION, mode: 'static' },
  // Exact integer arithmetic, IEEE-754 rounding and the correctly rounded Math.sqrt (ECMAScript specifies it exactly).
  evaluation: { determinism: 'bitwise', checkpoint: 'none' },
  capabilities: [],
  parameters: {
    m11: entry(1, 1, 1.5),
    m12: entry(1, 2, 1),
    m21: entry(2, 1, 0.5),
    m22: entry(2, 2, 1),
    vx: component('x', 1),
    vy: component('y', 1),
  },
  quantities: {
    'basis.e1': vector('Basis vector e₁', '\\mathbf{e}_1', 'The standard basis vector e₁ = (1, 0) before the transformation; a fixed reference.'),
    'basis.e2': vector('Basis vector e₂', '\\mathbf{e}_2', 'The standard basis vector e₂ = (0, 1) before the transformation; a fixed reference.'),
    'vector.v': vector('Test vector v', '\\mathbf{v}', 'The test vector v = (vx, vy) before the transformation, equal to the stored parameters. It may be the zero vector.'),
    'image.e1': vector('Image of e₁', 'M\\mathbf{e}_1', 'M·e₁ = (m11, m21): the FIRST COLUMN of M (column-vector convention), the point where e₁ lands.'),
    'image.e2': vector('Image of e₂', 'M\\mathbf{e}_2', 'M·e₂ = (m12, m22): the second column of M, the point where e₂ lands.'),
    'image.v': vector('Image of v', 'M\\mathbf{v}', 'M·v = (m11·vx + m12·vy, m21·vx + m22·vy) = vx·(M·e₁) + vy·(M·e₂), exact and rounded once. It is the zero vector when v = 0 or when v lies along a collapsed direction; the zero vector is a valid result, not an undefined one.'),
    determinant: scalar('Determinant', '\\det M', 'det M = m11·m22 − m12·m21 for the stored entries, exact and rounded once: the signed factor by which M scales areas.',
      'Positive when M keeps the counterclockwise order of e₁ then e₂, negative when it reverses that order, zero when the plane collapses onto a line or a point.'),
    'area.scale': scalar('Area scale', '\\lvert\\det M\\rvert', 'The nonnegative factor |det M| by which M multiplies every area: the area of the image of the unit square. A negative determinant reverses orientation; it never makes an area negative.'),
    orientation: {
      label: 'Orientation', shape: { kind: 'category', values: [...LINEAR_ORIENTATIONS] }, dimension: 'dimensionless', unit: 'dimensionless',
      meaning: 'From the exact sign of det M for the stored entries: preserved (det M > 0, the counterclockwise order of e₁ then e₂ is kept), reversed (det M < 0, the order is flipped as by a reflection), collapsed (det M = 0, the plane is flattened onto a line or a point). Never from rounded digits.',
      coordinateFrame: PLANE, signConvention: 'Counterclockwise (from +x toward +y) is the positive orientation of the plane.',
    },
    rank: scalar('Rank', '\\operatorname{rank} M', 'Dimension of the image of M, decided exactly for the stored entries: 2 when det M ≠ 0, 1 when det M = 0 and M is not the zero matrix (the plane collapses onto a line), 0 for the zero matrix (every vector maps to the origin).'),
    'image.direction': vector('Collapse line direction', '\\hat{\\mathbf{w}}', 'For rank 1 only: the unit direction of the line through the origin onto which M collapses the plane (the line spanned by the columns of M). Undefined with FULL_RANK for rank 2 (the image is the whole plane) and with ZERO_IMAGE for the zero matrix (the image is a single point).', `${COMPONENTS} ${DIRECTION_SIGN}`),
    trace: scalar('Trace', '\\operatorname{tr} M', 'tr M = m11 + m22, exact and rounded once: the sum of the eigenvalues (counted with multiplicity, complex ones included).'),
    'eigen.discriminant': scalar('Eigenvalue discriminant', '\\Delta', 'Δ = (tr M)² − 4·det M = (m11 − m22)² + 4·m12·m21 for the stored entries, exact and rounded once. Δ > 0: two distinct real eigenvalues; Δ = 0: one repeated eigenvalue; Δ < 0: a complex-conjugate pair. Its exact sign decides the eigen category.'),
    'eigen.category': {
      label: 'Unchanged-direction category', shape: { kind: 'category', values: [...LINEAR_EIGEN_CATEGORIES] }, dimension: 'dimensionless', unit: 'dimensionless',
      meaning: 'How many directions through the origin M maps onto their own line (M·u = λ·u, with λ possibly negative or zero), decided exactly: two-real (Δ > 0: exactly two such directions), repeated-scalar (M = λ·I: every direction), repeated-defective (Δ = 0 and M ≠ λ·I: exactly one direction), complex (Δ < 0: no real direction). A real matrix does not always have two visible real eigenvectors.',
    },
    'eigen.values': {
      label: 'Real eigenvalues', symbol: '\\lambda_1, \\lambda_2', shape: { kind: 'vector', length: 2 }, dimension: 'dimensionless', unit: 'dimensionless',
      meaning: 'The real eigenvalues (λ₁, λ₂) with λ₁ ≥ λ₂, roots of λ² − (tr M)·λ + det M = 0 listed with multiplicity (a repeated eigenvalue appears twice). Undefined with COMPLEX_EIGENVALUES when Δ < 0. Irrational values agree with the exact roots to within a few units in the last place.',
      signConvention: 'A negative eigenvalue reverses vectors along its direction; zero sends that direction to the origin.',
    },
    'eigen.direction1': vector('First eigen-direction', '\\mathbf{u}_1', 'A unit vector u₁ with M·u₁ = λ₁·u₁: for two distinct real eigenvalues the direction of λ₁, and for a repeated eigenvalue with M ≠ λ·I the single unchanged direction. Undefined with COMPLEX_EIGENVALUES (no real direction is unchanged) or ALL_DIRECTIONS (M = λ·I: every direction is unchanged, so none is singled out).', `${COMPONENTS} ${DIRECTION_SIGN}`),
    'eigen.direction2': vector('Second eigen-direction', '\\mathbf{u}_2', 'A unit vector u₂ with M·u₂ = λ₂·u₂ for two distinct real eigenvalues. Undefined with SINGLE_DIRECTION (a repeated eigenvalue with only one unchanged direction), COMPLEX_EIGENVALUES or ALL_DIRECTIONS.', `${COMPONENTS} ${DIRECTION_SIGN}`),
  },
  geometry: {
    'grid.original': {
      // Element counts are vertices: two per segment.
      kind: 'segments2', label: 'Reference grid', dimension: 'dimensionless', unit: 'dimensionless', coordinateFrame: PLANE, maxElements: 2 * LINEAR_GRID.segments,
      description: `The ${LINEAR_GRID.segments} segments x = k from (k, −${grid}) to (k, ${grid}) and y = k from (−${grid}, k) to (${grid}, k) for the integers k = −${grid}…${grid}, before the transformation.`,
    },
    'grid.transformed': {
      kind: 'segments2', label: 'Transformed grid', dimension: 'dimensionless', unit: 'dimensionless', coordinateFrame: PLANE, maxElements: 2 * LINEAR_GRID.segments,
      description: 'The image of each reference-grid segment: a linear map sends a segment to the segment between the images of its endpoints, so x = k maps to the segment from M·(k, −3) to M·(k, 3), and likewise for y = k. Endpoints are exact and rounded once. When M collapses the plane the images lie on one line (rank 1) or at the origin (rank 0), and a segment can have equal endpoints.',
    },
    'unit-square': {
      kind: 'polygon2', label: 'Unit square', dimension: 'dimensionless', unit: 'dimensionless', coordinateFrame: PLANE, maxElements: 4,
      description: 'The unit square with vertices (0, 0), (1, 0), (1, 1), (0, 1) in counterclockwise order, before the transformation.',
    },
    'unit-square.image': {
      kind: 'polygon2', label: 'Image of the unit square', dimension: 'dimensionless', unit: 'dimensionless', coordinateFrame: PLANE, maxElements: 4,
      description: 'The parallelogram with vertices 0, M·e₁, M·e₁ + M·e₂ and M·e₂, in that order. Its area is |det M|; the vertex order is counterclockwise when det M > 0 and clockwise when det M < 0. `degenerate` is true exactly when det M = 0, when the parallelogram is a segment or a point.',
    },
    'eigen.lines': {
      kind: 'segments2', label: 'Unchanged-direction lines', dimension: 'dimensionless', unit: 'dimensionless', coordinateFrame: PLANE, maxElements: 4,
      description: `For each reported unit eigen-direction u, the segment from −${LINEAR_EIGEN_LINE_HALF_LENGTH}·u to ${LINEAR_EIGEN_LINE_HALF_LENGTH}·u on the line through the origin that M maps into itself (IDs u1, u2 follow the eigen-direction quantities). No segment when the eigenvalues are complex (no real direction) or when M = λ·I (every direction); the eigen-direction quantities state which.`,
    },
  },
  constraints: [],
  interpretation: {
    coordinateConvention: 'Column-vector convention: vectors are columns and M acts by M·v. M·e₁ = (m11, m21) is the FIRST COLUMN of M and M·e₂ = (m12, m22) is the second column; entry m_ij is in row i, column j. The plane has x to the right and y up; counterclockwise from +x toward +y is the positive orientation.',
    handedness: 'right',
    assumptions: [
      'M is a real 2×2 matrix acting linearly on the plane; every statement is about the matrix with exactly the stored entries.',
      'Entries and test-vector components are IEEE-754 double-precision values in [−3, 3]; every value of that range, including 0 and the zero vector, is an allowed experiment.',
      'Orientation, rank and the unchanged-direction category are decided from exact signs and exact equalities for the stored entries, never from a tolerance or from rounded display digits.',
      'Evaluation is deterministic on every conforming JavaScript engine: exact integer arithmetic, IEEE-754 rounding and one correctly rounded square root per unit direction, so the same entries and test vector always give the same values.',
    ],
    limitations: [
      'A decimal entry such as 0.7 is stored as the nearest double. A matrix that is singular in decimal arithmetic, such as columns (0.1, 0.3) and (0.7, 2.1), can be invertible as stored, with a determinant near 4e-17; the classification follows the stored values and the determinant shows it. Display rounding is separate from computation.',
      'Rotations by angles other than multiples of 90° have irrational entries; their stored entries are the nearest doubles, so for example det M differs from 1 by about 1e-16.',
      'Rational quantities (images, M·v, determinant, area scale, trace, discriminant, grid and square vertices) are exact and rounded once. Irrational quantities (eigenvalues from a non-square discriminant, unit directions) agree with the exact values to within a few units in the last place.',
      'A nonzero value too small to represent is a numerical-limit (UNDERFLOW) status, never zero; computed subnormal values carry an UNDERFLOW approximation note.',
      `The grid covers only the integer lines −${grid} ≤ k ≤ ${grid}, and unchanged-direction lines are drawn with half-length ${LINEAR_EIGEN_LINE_HALF_LENGTH}; both are bounded drawings of unbounded lines.`,
      'Only real eigen-directions are drawn. Complex eigenvalues are reported as a status; their rotation-like behaviour is not decomposed.',
    ],
  },
  // Upper bound on exact integer operations per evaluation (about 150 BigInt products plus two integer square roots);
  // maxOperations counts the kernel's own evaluated operators, calls and loop iterations (tests/catalog/kernel-work.test.ts): about 4,300 in the worst sampled case.
  limits: { maxGeometryElements: 4 * LINEAR_GRID.segments + 4 + 4 + 4, maxOperations: 10_000 },
  sources: [
    {
      id: 'derivation-linear-map', kind: 'derivation',
      citation: 'Derivation written for this catalogue: for v = vx·e₁ + vy·e₂, linearity gives M·v = vx·(M·e₁) + vy·(M·e₂), so the columns of M are the images of e₁ and e₂ and fix the whole map. The image of the unit square is the parallelogram spanned by the columns, with signed area det M = m11·m22 − m12·m21; |det M| scales every area and the sign of det M records whether the counterclockwise order of e₁, e₂ is kept. Eigenvalues are the roots of λ² − (tr M)·λ + det M = 0, real exactly when Δ = (tr M)² − 4·det M ≥ 0; when Δ = 0 and M ≠ λ·I the matrix M − λI has rank 1 and a single eigen-direction. Not independently reviewed.',
    },
    {
      id: 'study-harness-specification', kind: 'specification',
      citation: 'Study Harness visualizer implementation report §12.2: 2×2 matrix with an explicit column-vector convention, basis vectors, test vector, transformed grid, determinant and nonnegative area when authorized, prediction of orientation, collapse and unchanged directions, and the identity, nonaxis rotation, nonsymmetric shear, reflection, singular collapse, zero matrix and zero vector reference cases.',
    },
  ],
  referenceSuite: { suiteId: 'linear-transformation:1.0.0', digest: LINEAR_REFERENCE_SUITE_DIGEST },
};
