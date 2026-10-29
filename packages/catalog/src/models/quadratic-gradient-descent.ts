/**
 * Model manifest for fixed-step gradient descent on f(x) = a·x²/2 (report §12.3). Data only; the installed kernel
 * `quadratic-gradient-descent@1.0.0` evaluates it in the catalogue worker.
 */
import type { ModelManifest } from '@explorable-models/core/model';
import {
  QUADRATIC_CURVE, QUADRATIC_DOMAIN, QUADRATIC_KERNEL_ID, QUADRATIC_KERNEL_VERSION, QUADRATIC_MAX_INDEX, QUADRATIC_REGIMES,
} from '../kernels/quadratic-gradient-descent.js';

/**
 * sha256 of the exact bytes of tests/reference/fixtures/activities/quadratic-gradient-descent.json. The fixture lives
 * outside the catalogue so a kernel change cannot rewrite its own acceptance cases; tests/catalog verifies this value
 * against the file, and any fixture change therefore changes this model's scientific revision.
 */
export const QUADRATIC_REFERENCE_SUITE_DIGEST = 'sha256:5e22c857c6557619b9634a0f8791e9567342d517e339883fc0c20b3e9b22c2f2';

const POSITION_PLANE = 'position-loss plane';
const TRACE_PLANE = 'index-position plane';
const traceLength = QUADRATIC_MAX_INDEX + 1;

export const quadraticGradientDescentManifest: ModelManifest = {
  contract: 'explorable-models.model-manifest',
  schemaVersion: '1.0',
  modelId: 'quadratic-gradient-descent',
  version: '1.0.0',
  title: 'Gradient descent on a one-dimensional quadratic',
  summary: 'Fixed-step gradient descent x_{n+1} = (1 − η·a)·x_n on the objective f(x) = a·x²/2 with a > 0, evaluated in closed form at integer iterations 0 ≤ n ≤ 1000, with explicit numerical-limit statuses.',
  execution: { kind: 'kernel', kernelId: QUADRATIC_KERNEL_ID, kernelVersion: QUADRATIC_KERNEL_VERSION, mode: 'discrete', maxIndex: QUADRATIC_MAX_INDEX },
  // Exactly specified arithmetic only (a logarithm only estimates where a numerical limit starts; that index is verified exactly).
  evaluation: { determinism: 'bitwise', checkpoint: 'none' },
  capabilities: [{ id: 'discrete-iteration', version: '1.0' }],
  parameters: {
    a: {
      label: 'Curvature', symbol: 'a', description: 'Curvature (second derivative) of the objective f(x) = a·x²/2. It must be positive.',
      dimension: 'dimensionless', unit: 'dimensionless', min: QUADRATIC_DOMAIN.a[0], max: QUADRATIC_DOMAIN.a[1], default: 2,
      step: { ui: 0.1, admissible: 'continuous' }, role: 'model-input',
    },
    eta: {
      label: 'Step size', symbol: '\\eta', description: 'Fixed step size multiplying the gradient in every update. A step size of 0 leaves the position unchanged.',
      dimension: 'dimensionless', unit: 'dimensionless', min: QUADRATIC_DOMAIN.eta[0], max: QUADRATIC_DOMAIN.eta[1], default: 0.25,
      step: { ui: 0.05, admissible: 'continuous' }, role: 'model-input',
    },
    x0: {
      label: 'Starting position', symbol: 'x_0', description: 'Position at iteration n = 0.',
      dimension: 'dimensionless', unit: 'dimensionless', min: QUADRATIC_DOMAIN.x0[0], max: QUADRATIC_DOMAIN.x0[1], default: 4,
      step: { ui: 0.5, admissible: 'continuous' }, role: 'model-input',
    },
  },
  quantities: {
    'start.position': {
      label: 'Starting position', symbol: 'x_0', shape: { kind: 'scalar' }, dimension: 'dimensionless', unit: 'dimensionless',
      meaning: 'Position at iteration 0; equal to the parameter x0.', coordinateFrame: POSITION_PLANE,
      signConvention: 'Positive positions lie to the right of the minimum at x = 0.',
    },
    'start.loss': {
      label: 'Starting loss', symbol: 'f(x_0)', shape: { kind: 'scalar' }, dimension: 'dimensionless', unit: 'dimensionless',
      meaning: 'Objective value a·x0²/2 at the starting position; never negative.', coordinateFrame: POSITION_PLANE,
    },
    position: {
      label: 'Position', symbol: 'x_n', shape: { kind: 'scalar' }, dimension: 'dimensionless', unit: 'dimensionless',
      meaning: 'Position after n fixed-step gradient-descent updates: x_n = x0·(1 − η·a)^n.', coordinateFrame: POSITION_PLANE,
      signConvention: 'Positive positions lie to the right of the minimum at x = 0.',
    },
    loss: {
      label: 'Loss', symbol: 'f(x_n)', shape: { kind: 'scalar' }, dimension: 'dimensionless', unit: 'dimensionless',
      meaning: 'Objective value a·x_n²/2 at the current position; never negative.', coordinateFrame: POSITION_PLANE,
    },
    gradient: {
      label: 'Gradient', symbol: "f'(x_n)", shape: { kind: 'scalar' }, dimension: 'dimensionless', unit: 'dimensionless',
      meaning: 'Derivative a·x_n of the objective at the current position.', coordinateFrame: POSITION_PLANE,
      signConvention: 'Positive when the objective increases to the right.',
    },
    multiplier: {
      label: 'Update multiplier', symbol: 'r', shape: { kind: 'scalar' }, dimension: 'dimensionless', unit: 'dimensionless',
      meaning: 'Factor r = 1 − η·a applied to the position by every update, using the double-precision product η·a.',
    },
    product: {
      label: 'Step size times curvature', symbol: '\\eta a', shape: { kind: 'scalar' }, dimension: 'dimensionless', unit: 'dimensionless',
      meaning: 'Product η·a, computed once in IEEE-754 double precision; the regime is classified from this value.',
    },
    threshold: {
      label: 'Largest convergent step size', symbol: '2/a', shape: { kind: 'scalar' }, dimension: 'dimensionless', unit: 'dimensionless',
      meaning: 'Step size 2/a. Positive step sizes below it bring a nonzero start to 0; at it the positions alternate with constant magnitude.',
    },
    regime: {
      label: 'Regime', shape: { kind: 'category', values: [...QUADRATIC_REGIMES] }, dimension: 'dimensionless', unit: 'dimensionless',
      meaning: 'Classification from the declared conditions on x0 and the product p = η·a: zero-start (x0 = 0), stationary (p = 0), monotone-convergence (0 < p < 1), one-step (p = 1), alternating-convergence (1 < p < 2), oscillation (p = 2), divergence (p > 2). Never derived from iterates or displayed digits.',
    },
    index: {
      label: 'Iteration', symbol: 'n', shape: { kind: 'scalar' }, dimension: 'iteration', unit: 'iteration',
      meaning: `Integer number of updates applied, from 0 to ${QUADRATIC_MAX_INDEX}. Not a time.`,
    },
  },
  geometry: {
    curve: {
      kind: 'polyline2', label: 'Objective curve', dimension: 'dimensionless', unit: 'dimensionless', coordinateFrame: POSITION_PLANE, maxElements: QUADRATIC_CURVE.samples,
      description: `f(x) = a·x²/2 sampled at ${QUADRATIC_CURVE.samples} evenly spaced positions for ${QUADRATIC_CURVE.domain[0]} ≤ x ≤ ${QUADRATIC_CURVE.domain[1]}; the polyline between samples is a drawing aid.`,
    },
    start: {
      kind: 'points2', label: 'Starting point', dimension: 'dimensionless', unit: 'dimensionless', coordinateFrame: POSITION_PLANE, maxElements: 1,
      description: 'The point (x0, f(x0)) on the objective curve.',
    },
    current: {
      kind: 'points2', label: 'Current iterate', dimension: 'dimensionless', unit: 'dimensionless', coordinateFrame: POSITION_PLANE, maxElements: 1,
      description: 'The point (x_n, f(x_n)) at the current iteration, or a gap with a reason when it is not representable.',
    },
    trace: {
      // Horizontal coordinate: the iteration index n; vertical: the position x_n (report §8.3: declared coordinate units).
      kind: 'points2', label: 'Position trace', dimension: 'dimensionless', unit: 'dimensionless', coordinates: { x: 'iteration', y: 'dimensionless' }, coordinateFrame: TRACE_PLANE, maxElements: traceLength,
      description: 'Points (n, x_n) for n = 0 to the current iteration; horizontal coordinate in iterations. Ends with a gap and reason at the first iterate that is not representable.',
    },
    iterates: {
      kind: 'points2', label: 'Iterates on the curve', dimension: 'dimensionless', unit: 'dimensionless', coordinateFrame: POSITION_PLANE, maxElements: traceLength,
      description: 'Points (x_k, f(x_k)) for k = 0 to the current iteration. Ends with a gap and reason at the first iterate that is not representable.',
    },
    steps: {
      // Element counts are vertices: two per segment.
      kind: 'segments2', label: 'Update steps', dimension: 'dimensionless', unit: 'dimensionless', coordinateFrame: POSITION_PLANE, maxElements: 2 * QUADRATIC_MAX_INDEX,
      description: 'Segments from each iterate (x_k, f(x_k)) to the next one; drawn only between representable iterates.',
    },
  },
  constraints: [{
    id: 'multiplier-lower-bound',
    expression: 'eta * a',
    max: QUADRATIC_DOMAIN.maxProduct,
    maxInclusive: true,
    message: 'The step size times the curvature (η·a) can be at most 4, which keeps the update factor 1 − η·a at or above −3 and the iterations inside the supported numerical range.',
    recovery: 'Reduce the step size η or the curvature a until η·a is at most 4.',
  }],
  interpretation: {
    coordinateConvention: 'Position x lies on a horizontal axis, positive to the right, with the minimum of f at x = 0. The iteration index n counts updates from n = 0; it is not a time.',
    assumptions: [
      'The objective is exactly the quadratic f(x) = a·x²/2 with a > 0: no noise and no higher-order terms.',
      'The step size η is the same for every update.',
      'Evaluation is deterministic on every conforming JavaScript engine: values come from exactly specified arithmetic rounded once (a logarithm only estimates the first index of a numerical limit, which is then verified exactly), so the same parameters and iteration always give the same values.',
      'Real numbers are IEEE-754 double-precision values; the product η·a is computed once in double precision and the regime is classified from it.',
    ],
    limitations: [
      'Positions are evaluated from the closed form x_n = x0·(1 − η·a)^n with extended-precision intermediates and one final rounding; the recurrence is not stepped.',
      `Iterations are bounded to 0 ≤ n ≤ ${QUADRATIC_MAX_INDEX}, and η·a is at most ${QUADRATIC_DOMAIN.maxProduct}.`,
      'Values beyond the double range are numerical-limit statuses: overflow above Number.MAX_VALUE with the last finite iteration, or underflow of a nonzero value to zero. Subnormal values are reported as reduced-precision approximations.',
      'Displayed rounding is separate from computation: a value shown as 0 at display precision is not exact convergence, and the regime never depends on displayed digits.',
      `The objective curve is sampled at ${QUADRATIC_CURVE.samples} points; the polyline between samples does not certify values between them.`,
    ],
  },
  // maxOperations counts the kernel's own evaluated operators, calls and loop iterations (tests/catalog/kernel-work.test.ts): the trace to n = 1000 with
  // double-double powers and limit searches measured at about 1.12 million in the worst sampled case; declared with margin.
  limits: { maxIndex: QUADRATIC_MAX_INDEX, maxGeometryElements: QUADRATIC_CURVE.samples + 2 + 2 * traceLength + 2 * QUADRATIC_MAX_INDEX, maxOperations: 2_000_000 },
  sources: [
    {
      id: 'derivation-closed-form', kind: 'derivation',
      citation: 'Closed form written for this catalogue: f′(x) = a·x, so x_{n+1} = x_n − η·f′(x_n) = (1 − η·a)·x_n and, by induction, x_n = x0·(1 − η·a)^n. For x0 ≠ 0 the positions tend to 0 exactly when |1 − η·a| < 1, that is 0 < η·a < 2. Not independently reviewed.',
    },
    {
      id: 'study-harness-specification', kind: 'specification',
      citation: 'Study Harness Original Project Specification (25 October 2026), section 10: exact quadratic gradient-descent worked example, boundary cases and staged controls, as carried into the Study Harness visualizer implementation report §12.3.',
    },
  ],
  referenceSuite: { suiteId: 'quadratic-gradient-descent:1.0.0', digest: QUADRATIC_REFERENCE_SUITE_DIGEST },
};
