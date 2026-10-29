/**
 * Model manifest for a quadratic function, its analytical derivative, a probe with its tangent and a secant through a
 * second point (report §12.1). Data only; the installed kernel `function-derivative@1.0.0` evaluates it in the
 * catalogue worker.
 */
import type { ModelManifest } from '@experiment-kit/core/model';
import {
  FUNCTION_DERIVATIVE_CURVATURES, FUNCTION_DERIVATIVE_CURVE, FUNCTION_DERIVATIVE_DOMAIN, FUNCTION_DERIVATIVE_KERNEL_ID, FUNCTION_DERIVATIVE_KERNEL_VERSION,
  FUNCTION_DERIVATIVE_SLOPE_SIGNS,
} from '../kernels/function-derivative.js';

/**
 * sha256 of the exact bytes of tests/reference/fixtures/activities/function-derivative.json. The fixture lives outside
 * the catalogue so a kernel change cannot rewrite its own acceptance cases; tests/catalog verifies this value against
 * the file, and any fixture change therefore changes this model's scientific revision.
 */
export const FUNCTION_DERIVATIVE_REFERENCE_SUITE_DIGEST = 'sha256:07404667c68ff04613998c5a4d8e7ce5acf21c53e84cb28d37384fe8a21394f4';

const GRAPH = 'x–f(x) plane';
const DERIVATIVE_GRAPH = 'x–f′(x) plane';
const SLOPE_SIGN = 'Positive when f increases as x increases (rise over run in the x–f(x) plane).';
const { samples } = FUNCTION_DERIVATIVE_CURVE;
const D = FUNCTION_DERIVATIVE_DOMAIN;
const parameter = (label: string, symbol: string, description: string, [min, max]: readonly [number, number], value: number) => ({
  label, symbol, description, dimension: 'dimensionless', unit: 'dimensionless', min, max, default: value,
  step: { ui: 0.25, admissible: 'continuous' }, role: 'model-input',
} as const);

export const functionDerivativeManifest: ModelManifest = {
  contract: 'experiment-kit.model-manifest',
  schemaVersion: '1.0',
  modelId: 'function-derivative',
  version: '1.0.0',
  title: 'A quadratic function and its derivative',
  summary: 'f(x) = A·x² + B·x + C on −5 ≤ x ≤ 5 with its analytical derivative f′(x) = 2A·x + B, a probe point P with its tangent, and a secant through P and a second point Q at offset h; the secant slope is undefined when h = 0.',
  execution: { kind: 'kernel', kernelId: FUNCTION_DERIVATIVE_KERNEL_ID, kernelVersion: FUNCTION_DERIVATIVE_KERNEL_VERSION, mode: 'static' },
  evaluation: { determinism: 'bitwise', checkpoint: 'none' },
  capabilities: [],
  parameters: {
    A: parameter('Coefficient A', 'A', 'Coefficient of x² in f(x) = A·x² + B·x + C. With A = 0 the function is linear or constant.', D.A, 0.25),
    B: parameter('Coefficient B', 'B', 'Coefficient of x in f(x) = A·x² + B·x + C.', D.B, -0.5),
    C: parameter('Coefficient C', 'C', 'Constant term of f(x) = A·x² + B·x + C; it shifts the graph up or down.', D.C, -2),
    p: parameter('Probe position', 'p', 'x-coordinate of the probe point P = (p, f(p)) on the graph.', D.p, -1),
    h: parameter('Secant offset', 'h', 'Horizontal offset from P to the second point Q, which lies at x = p + h. With h = 0 the two points coincide.', D.h, 1),
  },
  quantities: {
    'probe.x': {
      label: 'Probe position', symbol: 'p', shape: { kind: 'scalar' }, dimension: 'dimensionless', unit: 'dimensionless',
      meaning: 'x-coordinate of the probe point P; it repeats the parameter p exactly.', coordinateFrame: GRAPH,
      signConvention: 'Positive to the right of x = 0.',
    },
    'probe.value': {
      label: 'Function value at the probe', symbol: 'f(p)', shape: { kind: 'scalar' }, dimension: 'dimensionless', unit: 'dimensionless',
      meaning: 'f(p) = A·p² + B·p + C, the height of the graph at the probe, rounded once from its exact value.', coordinateFrame: GRAPH,
      signConvention: 'Positive above the x-axis.',
    },
    derivative: {
      label: 'Derivative at the probe', symbol: "f'(p)", shape: { kind: 'scalar' }, dimension: 'dimensionless', unit: 'dimensionless',
      meaning: 'Analytical derivative f′(p) = 2A·p + B of the quadratic at the probe: the slope of the tangent at P, from the exact differentiation rule for this polynomial. It is not estimated from secant slopes, samples or a numerical limit.',
      coordinateFrame: GRAPH, signConvention: SLOPE_SIGN,
    },
    'second.x': {
      label: 'Second point position', symbol: 'p + h', shape: { kind: 'scalar' }, dimension: 'dimensionless', unit: 'dimensionless',
      meaning: 'x-coordinate p + h of the second point Q, rounded once from the exact sum (the same double the domain constraint checks). Equal to p when h = 0.',
      coordinateFrame: GRAPH, signConvention: 'Positive to the right of x = 0.',
    },
    'second.value': {
      label: 'Function value at the second point', symbol: 'f(p + h)', shape: { kind: 'scalar' }, dimension: 'dimensionless', unit: 'dimensionless',
      meaning: 'f(p + h) = A·(p + h)² + B·(p + h) + C for the exact sum p + h, rounded once.', coordinateFrame: GRAPH,
      signConvention: 'Positive above the x-axis.',
    },
    'secant.slope': {
      label: 'Secant slope', symbol: 'm_sec', shape: { kind: 'scalar' }, dimension: 'dimensionless', unit: 'dimensionless',
      meaning: 'Slope (f(p + h) − f(p))/h of the line through P and Q, which equals 2A·p + B + A·h exactly for h ≠ 0. Undefined (COINCIDENT_POINTS) when h = 0 because a secant needs two distinct points; it is never replaced by the derivative.',
      coordinateFrame: GRAPH, signConvention: SLOPE_SIGN,
    },
    'secant.difference': {
      label: 'Secant slope minus derivative', symbol: "m_sec - f'(p)", shape: { kind: 'scalar' }, dimension: 'dimensionless', unit: 'dimensionless',
      meaning: 'Difference between the secant slope and the analytical derivative at the probe, equal to A·h exactly for h ≠ 0; undefined (COINCIDENT_POINTS) when h = 0 because the secant slope is undefined.',
      coordinateFrame: GRAPH, signConvention: 'Positive when the secant is steeper upward (larger slope) than the tangent.',
    },
    'slope.sign': {
      label: 'Direction of the graph at the probe', shape: { kind: 'category', values: [...FUNCTION_DERIVATIVE_SLOPE_SIGNS] }, dimension: 'dimensionless', unit: 'dimensionless',
      meaning: 'increasing when f′(p) > 0, decreasing when f′(p) < 0, stationary when f′(p) = 0; classified from the exact sign of 2A·p + B for the input values, never from rounded or displayed digits.',
      coordinateFrame: GRAPH, signConvention: SLOPE_SIGN,
    },
    curvature: {
      label: 'Shape of the graph', shape: { kind: 'category', values: [...FUNCTION_DERIVATIVE_CURVATURES] }, dimension: 'dimensionless', unit: 'dimensionless',
      meaning: 'positive-curvature when A > 0 (opens upward, slope increasing), negative-curvature when A < 0 (opens downward, slope decreasing), linear when A = 0 and B ≠ 0 (constant nonzero slope), constant when A = 0 and B = 0 (slope 0 everywhere).',
      coordinateFrame: GRAPH,
    },
    'vertex.x': {
      label: 'Vertex position', symbol: 'x_v', shape: { kind: 'scalar' }, dimension: 'dimensionless', unit: 'dimensionless',
      meaning: 'x-coordinate −B/(2A) of the vertex, the only x where the analytical derivative is zero; one correctly rounded division. Undefined (NO_VERTEX) when A = 0 because a line has no vertex. It may lie outside the plotted domain.',
      coordinateFrame: GRAPH, signConvention: 'Positive to the right of x = 0.',
    },
  },
  geometry: {
    curve: {
      kind: 'polyline2', label: 'Graph of f', dimension: 'dimensionless', unit: 'dimensionless', coordinateFrame: GRAPH, maxElements: samples,
      description: `f(x) = A·x² + B·x + C at ${samples} evenly spaced positions x_i (the double nearest to −5 + i/40) for −5 ≤ x ≤ 5, evaluated in double precision; the polyline between samples is a drawing aid.`,
    },
    'derivative-curve': {
      kind: 'polyline2', label: 'Graph of the derivative f′', dimension: 'dimensionless', unit: 'dimensionless', coordinateFrame: DERIVATIVE_GRAPH, maxElements: samples,
      description: `The analytical derivative f′(x) = 2A·x + B at the same ${samples} positions as the graph of f, evaluated in double precision.`,
    },
    tangent: {
      // Element counts are vertices: two per segment.
      kind: 'segments2', label: 'Tangent line at P', dimension: 'dimensionless', unit: 'dimensionless', coordinateFrame: GRAPH, maxElements: 2,
      description: 'One segment of the line y = f(p) + f′(p)·(x − p) from x = −5 to x = 5, with correctly rounded endpoints.',
    },
    secant: {
      kind: 'segments2', label: 'Secant line through P and Q', dimension: 'dimensionless', unit: 'dimensionless', coordinateFrame: GRAPH, maxElements: 2,
      description: 'One segment of the line through P and Q, y = f(p) + m_sec·(x − p), from x = −5 to x = 5. Empty (no segments) when h = 0, because no secant exists through a single point.',
    },
    probe: {
      kind: 'points2', label: 'Probe point P', dimension: 'dimensionless', unit: 'dimensionless', coordinateFrame: GRAPH, maxElements: 1,
      description: 'The point (p, f(p)), or a gap with a reason when f(p) is not representable.',
    },
    second: {
      kind: 'points2', label: 'Second point Q', dimension: 'dimensionless', unit: 'dimensionless', coordinateFrame: GRAPH, maxElements: 1,
      description: 'The point (p + h, f(p + h)); it coincides with P when h = 0.',
    },
    'derivative-probe': {
      kind: 'points2', label: 'Derivative at the probe', dimension: 'dimensionless', unit: 'dimensionless', coordinateFrame: DERIVATIVE_GRAPH, maxElements: 1,
      description: 'The point (p, f′(p)) on the graph of the derivative, or a gap with a reason when f′(p) is not representable.',
    },
  },
  constraints: [{
    id: 'secant-in-domain',
    expression: 'p + h',
    min: D.x[0],
    max: D.x[1],
    minInclusive: true,
    maxInclusive: true,
    message: 'The second point Q is at x = p + h, which must stay inside the plotted domain from −5 to 5.',
    recovery: 'Move the probe p or shorten the offset h so that p + h is between −5 and 5.',
  }],
  interpretation: {
    coordinateConvention: 'x is horizontal and increases to the right; f(x) and f′(x) are vertical and increase upward. A slope is rise over run in these coordinates, so a positive slope rises to the right.',
    assumptions: [
      'The function is exactly the quadratic f(x) = A·x² + B·x + C with real coefficients; A = 0 gives a straight line and A = B = 0 a constant.',
      'The derivative is the analytical derivative f′(x) = 2A·x + B of this polynomial. It is not estimated from secant slopes, samples or a numerical limit.',
      'Inputs are IEEE-754 double-precision values taken at their exact values; the second point is evaluated at the exact sum p + h.',
      'Evaluation is deterministic on every conforming JavaScript engine: only exactly specified arithmetic is used, so the same parameters always give the same values.',
    ],
    limitations: [
      'Each quantity is its exact value rounded to the nearest double once. Categories come from exact signs, so a slope that displays as 0 can still be classified as increasing or decreasing.',
      'A probe entered as a decimal is in general not exactly at a vertex whose position is not a binary fraction (for example −1/3), so the slope there is a small nonzero number.',
      'The secant slope is undefined at h = 0 and no limiting value is substituted. For h ≠ 0 it differs from the derivative by exactly A·h.',
      'The domain constraint −5 ≤ p + h ≤ 5 is evaluated on the double sum p + h, as by every runtime entry point; the exact sum can then lie outside by at most 2^−51, and Q is evaluated at that exact sum.',
      'Values outside the double range are statuses: a nonzero value that rounds to zero is a numerical limit (UNDERFLOW), subnormal values carry a reduced-precision note, and the vertex of a curve with a tiny nonzero A can exceed the largest double (OVERFLOW).',
      `The graphs of f and f′ are sampled at ${samples} positions from −5 to 5 in double precision; the polyline between samples does not certify values between them. Tangent and secant lines are drawn from correctly rounded endpoints, and an endpoint whose exact value is nonzero but below the double range is drawn at 0.`,
    ],
  },
  // About 8 floating-point operations per curve sample for two curves, plus a few hundred exact dyadic operations;
  // maxOperations counts the kernel's own evaluated operators, calls and loop iterations (tests/catalog/kernel-work.test.ts): about 7,400 in the worst sampled case.
  limits: { maxGeometryElements: 2 * samples + 2 + 2 + 1 + 1 + 1, maxOperations: 10_000 },
  sources: [
    {
      id: 'derivation-difference-quotient', kind: 'derivation',
      citation: 'Derivation written for this catalogue: expanding A·(x + h)² + B·(x + h) + C gives (f(x + h) − f(x))/h = 2A·x + B + A·h for every h ≠ 0, so the secant slope differs from f′(x) = 2A·x + B by exactly A·h and tends to it as h → 0; at h = 0 the quotient is 0/0. When A ≠ 0, f′(x) = 0 only at x = −B/(2A). Not independently reviewed.',
    },
    {
      id: 'study-harness-specification', kind: 'specification',
      citation: 'Study Harness visualizer implementation report §12.1 and acceptance item A28: a bounded polynomial family with an analytically defined derivative, a movable probe, tangent, optional secant and linked slope values, a derivative plot shown only when authorized, and the linear, constant, zero-slope, coincident-secant, sign-change and domain-boundary cases.',
    },
  ],
  referenceSuite: { suiteId: 'function-derivative:1.0.0', digest: FUNCTION_DERIVATIVE_REFERENCE_SUITE_DIGEST },
};
