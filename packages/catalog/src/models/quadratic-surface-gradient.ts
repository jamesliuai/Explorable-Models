/**
 * Model manifest for the quadratic surface f(x, y) = (a·x² + 2b·x·y + c·y²)/2 and its gradient (report §12.5). Data
 * only; the installed kernel `quadratic-surface-gradient@1.1.0` evaluates it in the catalogue worker.
 */
import type { ModelGeometryDefinition, ModelManifest, ModelParameterDefinition, ModelQuantityDefinition } from '@explorable-models/core/model';
import {
  ARROW_MAX_LENGTH, ARROW_SCALES, CONTOUR_LEVELS, CONTOUR_SAMPLES, FIELD_GRID, SECTION_SAMPLES, SURFACE_GRADIENT_DOMAIN, SURFACE_GRADIENT_KERNEL_ID,
  SURFACE_GRADIENT_KERNEL_VERSION, SURFACE_GRID,
} from '../kernels/quadratic-surface-gradient.js';

/**
 * sha256 of the exact bytes of tests/reference/fixtures/activities/quadratic-surface-gradient.json. The fixture lives
 * outside the catalogue so a kernel change cannot rewrite its own acceptance cases; tests/catalog verifies this value
 * against the file, and any fixture change therefore changes this model's scientific revision.
 */
export const SURFACE_GRADIENT_REFERENCE_SUITE_DIGEST = 'sha256:4982408532970c0fca1657884b9307956e4f20ee91e0c68cdff00e8b66c2af20';

const PLANE = 'xy plane of a right-handed frame: x to the right, y up when viewed from +z';
const GRAPH = 'graph space of a right-handed frame: x and y horizontal, z = f(x, y) up';
const COMPONENTS = 'Components along +x (right) and +y (up) in the xy plane.';
const LEVELS = CONTOUR_LEVELS.join(', ');
const FIELD_COUNT = FIELD_GRID.n * FIELD_GRID.n;
const SURFACE_COUNT = SURFACE_GRID.n * SURFACE_GRID.n;
const CONTOUR_POINTS = CONTOUR_LEVELS.length * CONTOUR_SAMPLES;
const SCALES = ARROW_SCALES.slice(0, 6).join(', ');

const coefficient = (symbol: 'a' | 'b' | 'c', label: string, description: string, fallback: number): ModelParameterDefinition => ({
  label, symbol, description, dimension: 'dimensionless', unit: 'dimensionless',
  min: SURFACE_GRADIENT_DOMAIN[symbol][0], max: SURFACE_GRADIENT_DOMAIN[symbol][1], default: fallback,
  step: { ui: 0.1, admissible: 'continuous' }, role: 'model-input',
});
const coordinate = (axis: 'x' | 'y', fallback: number): ModelParameterDefinition => ({
  label: `Point ${axis}-coordinate`, symbol: `p_${axis}`,
  description: `The ${axis}-coordinate of the selected point p. Any value from −2 to 2 is allowed, including 0.`,
  dimension: 'dimensionless', unit: 'dimensionless', min: SURFACE_GRADIENT_DOMAIN[`p${axis}`][0], max: SURFACE_GRADIENT_DOMAIN[`p${axis}`][1], default: fallback,
  step: { ui: 0.1, admissible: 'continuous' }, role: 'model-input',
});
const scalar = (label: string, symbol: string, meaning: string, extra: Partial<ModelQuantityDefinition> = {}): ModelQuantityDefinition =>
  ({ label, symbol, shape: { kind: 'scalar' }, dimension: 'dimensionless', unit: 'dimensionless', meaning, ...extra });
const vector2 = (label: string, symbol: string, meaning: string, signConvention = COMPONENTS): ModelQuantityDefinition =>
  ({ label, symbol, shape: { kind: 'vector', length: 2 }, dimension: 'dimensionless', unit: 'dimensionless', meaning, coordinateFrame: PLANE, signConvention });
const geometry = (kind: ModelGeometryDefinition['kind'], label: string, coordinateFrame: string, maxElements: number, description: string): ModelGeometryDefinition =>
  ({ kind, label, description, dimension: 'dimensionless', unit: 'dimensionless', coordinateFrame, maxElements });
const ARROW_NOTE = `drawn at length s·|∇f(p)| with the arrow scale s (quantity arrow.scale), the same scale as the gradient field; its direction is exact`;

export const quadraticSurfaceGradientManifest: ModelManifest = {
  contract: 'explorable-models.model-manifest',
  schemaVersion: '1.0',
  modelId: 'quadratic-surface-gradient',
  version: '1.0.0',
  title: 'Gradient on a positive-definite quadratic surface',
  summary: 'The surface f(x, y) = (a·x² + 2b·x·y + c·y²)/2 with a·c − b² > 0 and a selected point p in [−2, 2]²: f(p), the gradient ∇f(p) with its length and direction (undefined at the minimum), the Hessian determinant, the minimum, a sampled surface, analytic contour ellipses, a gradient field with disclosed arrow scale and the two axis cross-sections, all from one static evaluation.',
  execution: { kind: 'kernel', kernelId: SURFACE_GRADIENT_KERNEL_ID, kernelVersion: SURFACE_GRADIENT_KERNEL_VERSION, mode: 'static' },
  // Contour directions use Math.cos and Math.sin and arrow scaling Math.hypot, which ECMAScript lets engines approximate.
  evaluation: { determinism: 'within-engine', checkpoint: 'none' },
  capabilities: [{ id: 'spatial-3d', version: '1.0' }],
  parameters: {
    a: coefficient('a', 'Coefficient a', 'Coefficient of x²/2: the curvature of f along the x-axis (∂²f/∂x²). Must be positive.', 2),
    b: coefficient('b', 'Coefficient b', 'Coupling coefficient of x·y (∂²f/∂x∂y). Nonzero values tilt the contour ellipses away from the axes; together with a and c it must keep a·c − b² > 0.', 0.5),
    c: coefficient('c', 'Coefficient c', 'Coefficient of y²/2: the curvature of f along the y-axis (∂²f/∂y²). Must be positive.', 1),
    px: coordinate('x', 1),
    py: coordinate('y', 1),
  },
  quantities: {
    point: vector2('Selected point', 'p', 'The selected point p = (p_x, p_y), equal to its two parameters.'),
    value: scalar('Height at the point', 'f(p)', 'f(p) = (a·p_x² + 2b·p_x·p_y + c·p_y²)/2, the exact value rounded once. Positive except at the minimum.', {
      coordinateFrame: GRAPH, signConvention: 'Height above the xy plane along +z; never negative on this family.',
    }),
    gradient: vector2('Gradient at the point', '\\nabla f(p)', 'Vector of partial derivatives ∇f(p) = (∂f/∂x, ∂f/∂y) = (a·p_x + b·p_y, b·p_x + c·p_y), each component rounded once. It is the zero vector only at the minimum.',
      'Points toward increasing f (uphill); components along +x (right) and +y (up).'),
    'gradient.norm': scalar('Length of the gradient', '|\\nabla f(p)|', '|∇f(p)| = √((∂f/∂x)² + (∂f/∂y)²): the rate of increase of f per unit distance in the direction of the gradient.', {
      coordinateFrame: PLANE, signConvention: 'A length: never negative; 0 only at the minimum.',
    }),
    'gradient.direction': vector2('Direction of the gradient', '\\hat{u}', 'Unit vector ∇f(p)/|∇f(p)|, the direction of fastest increase of f. Undefined (ZERO_GRADIENT) at the minimum p = (0, 0), where the gradient is zero; no direction is ever chosen in its place. Decided from p itself, so a tiny nonzero point keeps a defined direction.',
      'Unit vector toward increasing f; components along +x (right) and +y (up).'),
    'hessian.det': scalar('Hessian determinant', 'ac - b^2', 'Determinant a·c − b² of the constant Hessian H = [[a, b], [b, c]], rounded once. Positive on the whole admissible domain (constraint positive-definite).', {
      signConvention: 'Positive for every admissible coefficient set.',
    }),
    'minimum.location': vector2('Location of the minimum', 'p_{\\min}', 'The unique minimum of the symmetric positive-definite family: (0, 0) for every admissible a, b and c, because H is positive definite and ∇f = 0 only at the origin.'),
    'minimum.value': scalar('Minimum value', 'f_{\\min}', 'f(0, 0) = 0, the unique lowest value of f on this family.', { coordinateFrame: GRAPH, signConvention: 'Height along +z; f is never below it.' }),
    'arrow.scale': scalar('Arrow length scale', 's', `Factor s by which drawn gradient arrows are shortened or lengthened: each arrow is drawn as s·∇f. s is chosen per frame from ${SCALES}, … as the largest value with s·M ≤ ${ARROW_MAX_LENGTH}, where M is the longest gradient on the ${FIELD_GRID.n} × ${FIELD_GRID.n} field grid (90% of its spacing ${FIELD_GRID.spacing}). Presentation scale only: no quantity is changed by it.`, {
      signConvention: 'Positive; 1 means arrows are drawn at true length.',
    }),
  },
  geometry: {
    surface: geometry('surface-grid', 'Surface samples', GRAPH, SURFACE_COUNT,
      `f(x, y) sampled on a ${SURFACE_GRID.n} × ${SURFACE_GRID.n} grid x, y = −2, −1.9, …, 2 (spacing 0.1), z stored row by row in y. The mesh between samples is a drawing aid; it does not certify values between them.`),
    contours: geometry('polyline2', 'Contour lines', PLANE, CONTOUR_POINTS,
      `One closed ellipse f(x, y) = L for each level L = ${LEVELS}, in that order, computed analytically as r(t) = √(2L/q(t)) with q(t) = a·cos²t + 2b·cos t·sin t + c·sin²t at the ${CONTOUR_SAMPLES - 1} directions t = 2πk/180 counterclockwise from +x, with the first point repeated to close the curve (${CONTOUR_SAMPLES} points per level; a closed curve has no endpoints). Large levels and elongated ellipses can extend beyond the default view.`),
    field: geometry('vector-field2', 'Gradient field', PLANE, FIELD_COUNT,
      `The gradient ∇f at the ${FIELD_GRID.n} × ${FIELD_GRID.n} grid points x, y = −2, −1.5, …, 2 (spacing ${FIELD_GRID.spacing}), row by row in y. Vectors are true values; they are drawn at s·∇f with the disclosed scale s (see arrow.scale). The zero vector at the origin has no direction and is drawn as a dot.`),
    'cross-section-x': geometry('polyline2', 'Cross-section along the x-axis', 'vertical section y = 0: horizontal x to the right, vertical z = f(x, 0) up', SECTION_SAMPLES.n,
      `The section f(x, 0) = a·x²/2 sampled at ${SECTION_SAMPLES.n} points x = −2, −1.95, …, 2 (spacing 0.05); the polyline between samples is a drawing aid.`),
    'cross-section-y': geometry('polyline2', 'Cross-section along the y-axis', 'vertical section x = 0: horizontal y to the right, vertical z = f(0, y) up', SECTION_SAMPLES.n,
      `The section f(0, y) = c·y²/2 sampled at ${SECTION_SAMPLES.n} points y = −2, −1.95, …, 2 (spacing 0.05); the polyline between samples is a drawing aid.`),
    'point-2d': geometry('points2', 'Selected point in the contour view', PLANE, 1, 'The point p (ID "p").'),
    'point-3d': geometry('points3', 'Selected point on the surface', GRAPH, 1, 'The point (p_x, p_y, f(p)) on the surface (ID "p"), or a gap with a reason when f(p) is a numerical limit.'),
    // Element counts are vertices: two per segment.
    'gradient-2d': geometry('segments2', 'Gradient arrow in the contour view', PLANE, 2,
      `Segment (ID "gradient") from p to p + s·∇f(p), ${ARROW_NOTE}. Empty at the minimum, where the gradient is zero, and when the scaled arrow is too short to have distinct endpoints.`),
    'gradient-3d': geometry('segments3', 'Gradient arrow on the surface', GRAPH, 2,
      `Segment (ID "gradient") from (p, f(p)) to (p + s·∇f(p), f(p)) in the horizontal plane z = f(p), ${ARROW_NOTE}. Empty at the minimum, when the scaled arrow has no extent, or when f(p) is a numerical limit.`),
  },
  constraints: [{
    id: 'positive-definite',
    expression: 'a*c - b*b',
    min: 0,
    minInclusive: false,
    message: 'The coefficients must satisfy a·c − b² > 0. Only then is the surface a bowl with a single lowest point, which is the family this activity covers; at a·c − b² = 0 the surface becomes a trough with a whole line of lowest points, and below 0 a saddle.',
    recovery: 'Reduce the size of b (move b toward 0), or increase a or c, until a·c − b² is greater than 0.',
  }],
  interpretation: {
    coordinateConvention: 'Right-handed Cartesian frame with x to the right and y up in the contour view (viewed from +z) and z = f(x, y) up in the 3D view. Contour, field, point and arrow coordinates share the xy plane; the cross-sections are the vertical planes y = 0 (horizontal axis x) and x = 0 (horizontal axis y).',
    angleConvention: 'Contour sample directions t are in radians, measured counterclockwise from +x toward +y.',
    handedness: 'right',
    assumptions: [
      'f is exactly the quadratic form (a·x² + 2b·x·y + c·y²)/2 with constant coefficients: no noise and no higher-order terms.',
      'The Hessian H = [[a, b], [b, c]] is symmetric positive definite: a ≥ 0.2, c ≥ 0.2 and a·c − b² > 0 (constraint positive-definite). Degenerate troughs (a·c − b² = 0) and saddles (a·c − b² < 0) are outside this model.',
      'The gradient is the vector of partial derivatives (∂f/∂x, ∂f/∂y) = (a·x + b·y, b·x + c·y); it points toward increasing f.',
      'Coefficients and coordinates are dimensionless IEEE-754 double values; evaluation is deterministic within one JavaScript engine.',
      'The 3D view and its camera are presentation only: the kernel has no camera input, and turning or resetting the view never changes a, b, c or the point.',
    ],
    limitations: [
      'Point values — f(p), ∇f(p), |∇f(p)|, the direction ∇f/|∇f| and a·c − b² — are computed exactly from the double inputs (exact binary arithmetic, with integer square roots for the length and the direction) and each is rounded once to the nearest double, ties to even. Sampled surface heights, section heights and field vectors use about 106-bit intermediates and agree with the exactly rounded values to a unit in the last place.',
      'Results below the smallest normal double are reduced-precision approximations; a nonzero f(p) or gradient length that rounds to 0 is a numerical-limit status, never 0, a nonzero gradient or direction component shown as 0 carries an approximation note, and the gradient direction stays defined at every point other than the origin.',
      `The surface is sampled on a ${SURFACE_GRID.n} × ${SURFACE_GRID.n} grid with spacing 0.1 and the cross-sections at ${SECTION_SAMPLES.n} points each; the drawing between samples does not certify values between them.`,
      `Contours are exact ellipses sampled at ${CONTOUR_SAMPLES - 1} directions per level for L = ${LEVELS} only. Because the coordinates are rounded, f at a contour point equals L to about 4·√(λmax/λmin)·2⁻⁵³ relative (better than 10⁻¹² unless λmax/λmin exceeds about 10⁶). Directions use the platform Math.cos and Math.sin, so the last bits of sample positions can differ between JavaScript engines; f = L at each point holds regardless.`,
      `Gradient arrows (the point's arrow and the ${FIELD_GRID.n} × ${FIELD_GRID.n} field) are drawn at s·∇f with the disclosed scale s ≤ 1 chosen per frame; the arrow at p can therefore not be compared in length across frames without the scale.`,
      'Only the axis cross-sections f(x, 0) and f(0, y) are provided; sections along other lines are not part of this model.',
    ],
  },
  // Double-double operations for the surface, contours, field, sections and the point; maxOperations counts the kernel's own evaluated operators, calls and loop iterations (tests/catalog/kernel-work.test.ts):
  // about 0.78 million in the worst sampled case, declared with margin.
  limits: { maxGeometryElements: SURFACE_COUNT + CONTOUR_POINTS + FIELD_COUNT + 2 * SECTION_SAMPLES.n + 1 + 1 + 2 + 2, maxOperations: 1_500_000 },
  sources: [
    {
      id: 'derivation-quadratic-form', kind: 'derivation',
      citation: 'Derivation written for this catalogue: f(x, y) = ½·[x y]·H·[x y]ᵀ with H = [[a, b], [b, c]], so ∇f = H·[x y]ᵀ = (a·x + b·y, b·x + c·y). H is positive definite exactly when a > 0 and a·c − b² > 0; then f(x, y) > 0 for (x, y) ≠ (0, 0), the origin is the unique minimum with f = 0, and ∇f = 0 only there because H is invertible. On the ray (x, y) = r·(cos t, sin t), f = r²·q(t)/2 with q(t) = a·cos²t + 2b·cos t·sin t + c·sin²t > 0, so the level f = L is the closed ellipse r(t) = √(2L/q(t)). f is constant along a level curve, so ∇f is perpendicular to its tangent. The axis sections are f(x, 0) = a·x²/2 and f(0, y) = c·y²/2. Not independently reviewed.',
    },
    {
      id: 'study-harness-specification', kind: 'specification',
      citation: 'Study Harness visualizer implementation report §12.5 (bounded two-variable quadratic surface from a declared symmetric positive-definite family, linked contour/projection view, selected point with a gradient vector and a bounded gradient field, disclosed sampling and vector scaling, checks of analytic gradients, axis orientation, minimum, zero gradient and approved cross-sections, camera-independent model state) and acceptance criterion A46.',
    },
  ],
  referenceSuite: { suiteId: 'quadratic-surface-gradient:1.0.0', digest: SURFACE_GRADIENT_REFERENCE_SUITE_DIGEST },
};
