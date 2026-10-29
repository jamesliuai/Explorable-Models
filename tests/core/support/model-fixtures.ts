/**
 * TEST-ONLY manifests and pure kernels for the model engine tests. They exercise the contract; they are not catalogue
 * content and carry no scientific-review claim.
 */
import { MODEL_CONTRACT, MODEL_SCHEMA_VERSION } from '../../../packages/core/src/model/index';
import type { KernelOutput, ModelKernel, ModelManifest, QuantityResult } from '../../../packages/core/src/model/index';
import type { VisualizationDocument } from '../../../packages/core/src/declarative/types';

/** Allowed bound for the geometric iterate (an "allowed bounds" numerical limit, report §12.3). */
export const BOUND = 100;
export const regimeOf = (r: number): string => r === 1 ? 'stationary' : r > 0 && r < 1 ? 'monotone' : r === 0 ? 'one-step' : r < 0 && r > -1 ? 'alternating' : r === -1 ? 'oscillating' : 'diverging';

/** Closed-form x_n = x0 (1 − ηa)^n with an explicit numerical limit beyond ±BOUND. */
export const geometricKernel: ModelKernel = {
  id: 'test.geometric', version: '1.0.0', mode: 'discrete',
  evaluate({ params, index }): KernelOutput {
    const { a, eta, x0 } = params as Record<'a' | 'eta' | 'x0', number>;
    const r = 1 - eta * a;
    const at = (k: number) => x0 === 0 ? 0 : x0 * r ** k;
    const points: [number, number][] = [];
    let limitAt = -1;
    for (let k = 0; k <= index; k++) { const x = at(k); if (!Number.isFinite(x) || Math.abs(x) > BOUND) { limitAt = k; break; } points.push([k, x]); }
    const limited = limitAt >= 0;
    const limit: QuantityResult = { status: 'numerical-limit', code: 'OVERFLOW', reason: `The iterate exceeds the allowed bound of ±${BOUND} m.`, lastFiniteIndex: limitAt - 1 };
    return {
      quantities: {
        position: limited ? limit : { status: 'valid', value: at(index) },
        multiplier: { status: 'valid', value: r },
        ratio: x0 === 0 ? { status: 'undefined', code: 'ZERO_START', reason: 'The ratio to a zero start is undefined.' } : limited ? limit : { status: 'valid', value: r ** index },
        regime: { status: 'valid', value: regimeOf(r) },
        step: { status: 'valid', value: index },
      },
      geometry: { trace: { kind: 'polyline2', segments: [{ points, start: 'closed', end: limited ? 'open' : 'closed' }], gaps: limited ? [{ after: 0, before: null, reason: 'Later iterates exceed the allowed bound.' }] : [] } },
      ...(limited && { terminal: { reached: true, event: 'numerical-limit' as const, detail: 'Iterate exceeds the allowed bound.' } }),
    };
  },
};

export function geometricManifest(maxIndex = 12): ModelManifest {
  return {
    contract: MODEL_CONTRACT, schemaVersion: MODEL_SCHEMA_VERSION, modelId: 'test.geometric-descent', version: '1.0.0',
    title: 'Geometric descent (test)', summary: 'Closed-form gradient-descent iterates on a quadratic, used to test the engine.',
    execution: { kind: 'kernel', kernelId: 'test.geometric', kernelVersion: '1.0.0', mode: 'discrete', maxIndex },
    capabilities: [{ id: 'discrete-iteration', version: '1.0' }],
    parameters: {
      a: { label: 'Curvature', description: 'Curvature a of f(x) = a x²/2.', dimension: 'dimensionless', unit: 'dimensionless', min: 0.5, max: 5, default: 2, step: { ui: 0.5, admissible: { multipleOf: 0.5 } }, role: 'model-input' },
      eta: { label: 'Step size', symbol: '\\eta', description: 'Gradient step size.', dimension: 'dimensionless', unit: 'dimensionless', min: 0, max: 1, default: 0.25, step: { ui: 0.05, admissible: 'continuous' }, role: 'model-input' },
      x0: { label: 'Start', description: 'Initial position.', dimension: 'length', unit: 'm', min: -10, max: 10, default: 4, step: { ui: 1, admissible: 'integer' }, role: 'model-input' },
    },
    quantities: {
      position: { label: 'Position', shape: { kind: 'scalar' }, dimension: 'length', unit: 'm', meaning: 'Current iterate x_n.', coordinateFrame: 'x axis through the minimum', signConvention: 'Positive to the right of the minimum.' },
      multiplier: { label: 'Multiplier', shape: { kind: 'scalar' }, dimension: 'dimensionless', unit: 'dimensionless', meaning: 'Per-step multiplier 1 − ηa.' },
      ratio: { label: 'Ratio to start', shape: { kind: 'scalar' }, dimension: 'dimensionless', unit: 'dimensionless', meaning: 'x_n / x_0; undefined for a zero start.' },
      regime: { label: 'Regime', shape: { kind: 'category', values: ['stationary', 'monotone', 'one-step', 'alternating', 'oscillating', 'diverging'] }, dimension: 'dimensionless', unit: 'dimensionless', meaning: 'Classification of the multiplier.' },
      step: { label: 'Iteration', shape: { kind: 'scalar' }, dimension: 'iteration', unit: 'iteration', meaning: 'Iteration index n.' },
    },
    geometry: { trace: { kind: 'polyline2', label: 'Trace', description: 'Iterates (n, x_n) up to the current index.', dimension: 'length', unit: 'm', coordinateFrame: 'n horizontal, x vertical', maxElements: maxIndex + 1 } },
    constraints: [{ id: 'stable-step', expression: 'eta*a', max: 2.5, message: 'This step size is too large for the curvature.', recovery: 'Reduce the step size or the curvature.' }],
    interpretation: { coordinateConvention: 'x is measured from the minimum.', assumptions: ['Exact closed-form iterates.'], limitations: [`Iterates beyond ±${BOUND} m are reported as a numerical limit.`] },
    limits: { maxIndex, maxGeometryElements: maxIndex + 1, maxOperations: 1000 },
    sources: [{ id: 'derivation', kind: 'derivation', citation: 'Gradient descent on f(x) = a x²/2.' }],
    referenceSuite: null,
  };
}

/** Static rectangle exercising every geometry kind validated by the engine. */
export const rectangleKernel: ModelKernel = {
  id: 'test.rectangle', version: '1.0.0', mode: 'static',
  evaluate({ params }): KernelOutput {
    const { w, h } = params as Record<'w' | 'h', number>;
    return {
      quantities: {
        perimeter: { status: 'valid', value: 2 * (w + h) },
        diagonal: { status: 'valid', value: [w, h] },
        scale: { status: 'valid', value: [w, 0, 0, h] },
        slope: w === 0 ? { status: 'undefined', code: 'ZERO_WIDTH', reason: 'The slope of a zero-width rectangle is undefined.' } : { status: 'valid', value: h / w },
        shape: { status: 'valid', value: w === 0 || h === 0 ? 'degenerate' : w === h ? 'square' : 'rectangle' },
      },
      geometry: {
        outline: { kind: 'polygon2', vertices: [[0, 0], [w, 0], [w, h], [0, h]], degenerate: w === 0 || h === 0 },
        corners: { kind: 'points2', points: [{ id: 'A', at: [0, 0] }, { id: 'C', at: [w, h] }, { id: 'centroid', at: w === 0 ? null : [w / 2, h / 2], ...(w === 0 && { reason: 'Shown only for a nondegenerate rectangle.' }) }] },
        edges: { kind: 'segments2', segments: [{ id: 'base', from: [0, 0], to: [w, 0] }, { id: 'side', from: [w, 0], to: [w, h] }] },
        field: { kind: 'vector-field2', samples: [{ at: [0, 0], vector: [w, h] }], scale: { factor: 0.5, disclosure: 'Arrows are drawn at half length.' } },
        grid: { kind: 'surface-grid', xs: [0, w || 1], ys: [0, h || 1], z: [0, null, 1, 2], sampling: { nx: 2, ny: 2, domain: [0, w || 1, 0, h || 1] } },
      },
    };
  },
};

export function rectangleManifest(kernelId = 'test.rectangle'): ModelManifest {
  const length = (label: string, def: number) => ({ label, description: `${label} of the rectangle.`, dimension: 'length' as const, unit: 'm' as const, min: 0, max: 10, default: def, step: { ui: 0.5, admissible: 'continuous' as const }, role: 'model-input' as const });
  const geometry = (kind: ModelManifest['geometry'][string]['kind'], maxElements: number) => ({ kind, label: kind, description: `${kind} geometry.`, dimension: 'length' as const, unit: 'm' as const, coordinateFrame: 'Right-handed x–y plane.', maxElements });
  return {
    contract: MODEL_CONTRACT, schemaVersion: MODEL_SCHEMA_VERSION, modelId: 'test.rectangle', version: '1.0.0',
    title: 'Rectangle (test)', summary: 'A static rectangle covering every geometry kind.',
    execution: { kind: 'kernel', kernelId, kernelVersion: '1.0.0', mode: 'static' },
    capabilities: [],
    parameters: { w: length('Width', 3), h: length('Height', 4) },
    quantities: {
      perimeter: { label: 'Perimeter', shape: { kind: 'scalar' }, dimension: 'length', unit: 'm', meaning: 'Perimeter 2(w + h).' },
      diagonal: { label: 'Diagonal', shape: { kind: 'vector', length: 2 }, dimension: 'length', unit: 'm', meaning: 'Diagonal vector from A to C.', coordinateFrame: 'x–y plane' },
      scale: { label: 'Scale matrix', shape: { kind: 'matrix', rows: 2, columns: 2 }, dimension: 'length', unit: 'm', meaning: 'Row-major diag(w, h).' },
      slope: { label: 'Slope', shape: { kind: 'scalar' }, dimension: 'dimensionless', unit: 'dimensionless', meaning: 'h / w.' },
      shape: { label: 'Shape', shape: { kind: 'category', values: ['square', 'rectangle', 'degenerate'] }, dimension: 'dimensionless', unit: 'dimensionless', meaning: 'Shape class.' },
    },
    geometry: { outline: geometry('polygon2', 4), corners: geometry('points2', 3), edges: geometry('segments2', 4), field: geometry('vector-field2', 1), grid: geometry('surface-grid', 4) },
    constraints: [
      { id: 'area-cap', expression: 'w*h', max: 50, message: 'The rectangle is larger than this activity supports.', recovery: 'Reduce the width or height.' },
      { id: 'aspect', expression: 'w/h', min: 0.1, message: 'The rectangle is too narrow for its height.', recovery: 'Increase the width or choose a nonzero height.' },
    ],
    interpretation: { coordinateConvention: 'Origin at corner A; x right, y up.', handedness: 'right', assumptions: ['Euclidean plane.'], limitations: ['Static model.'] },
    limits: { maxGeometryElements: 8, maxOperations: 100 },
    sources: [],
    referenceSuite: null,
  };
}

/** Free fall from height h with gravity g: an analytical time document with an exact end time √(2h/g). */
export function dropDocument(): VisualizationDocument {
  return {
    schemaVersion: '2.0', id: 'drop', title: 'Free fall', description: 'A body released from rest falls to the ground.',
    parameters: { h: { label: 'Drop height', value: 20, min: 1, max: 100, unit: 'm', dimension: 'length' }, g: { label: 'Gravity', value: 10, min: 1, max: 20, unit: 'm/s²', dimension: 'acceleration' } },
    quantities: { flight: { expression: 'sqrt(2*h/g)', label: 'Flight time', dimension: 'time' }, height: { expression: 'h-g*time*time/2', label: 'Height', dimension: 'length' } },
    series: { fall: { label: 'Height over time', variable: 'u', domain: [0, 1], samples: 51, x: 'u*flight', y: 'h-g*(u*flight)^2/2' } },
    time: { end: 'flight', step: 0.5 },
    views: [{ id: 'plot', type: 'plot', title: 'Height over time', marks: [{ id: 'fall', type: 'line', label: 'Fall', series: 'fall' }] }],
    assumptions: ['Constant gravity; no air resistance.'], limitations: ['Ends at ground contact.'],
  };
}
export function dropManifest(document: VisualizationDocument = dropDocument()): ModelManifest {
  return {
    contract: MODEL_CONTRACT, schemaVersion: MODEL_SCHEMA_VERSION, modelId: 'test.drop', version: '1.0.0',
    title: 'Free fall (test)', summary: 'A schema 2.0 time document wrapped as a model.',
    execution: { kind: 'document', document },
    capabilities: [{ id: 'declarative-2d', version: '1.0' }],
    parameters: {
      h: { label: 'Drop height', description: 'Initial height above the ground.', dimension: 'length', unit: 'm', min: 1, max: 100, default: 20, step: { ui: 1, admissible: 'continuous' }, role: 'model-input' },
      g: { label: 'Gravity', description: 'Downward gravitational acceleration.', dimension: 'acceleration', unit: 'm/s^2', min: 1, max: 20, default: 10, step: { ui: 0.5, admissible: 'continuous' }, role: 'model-input' },
    },
    quantities: {
      flight: { label: 'Flight time', shape: { kind: 'scalar' }, dimension: 'time', unit: 's', meaning: 'Time to reach the ground.' },
      height: { label: 'Height', shape: { kind: 'scalar' }, dimension: 'length', unit: 'm', meaning: 'Height above the ground.', signConvention: 'Positive upward.' },
    },
    geometry: { fall: { kind: 'polyline2', label: 'Height over time', description: 'Sampled height against time.', dimension: 'length', unit: 'm', coordinates: { x: 's', y: 'm' }, coordinateFrame: 'time horizontal (s), height vertical (m)', maxElements: 51 } },
    constraints: [],
    interpretation: { coordinateConvention: 'Height measured upward from the ground.', assumptions: ['Constant gravity; no air resistance.'], limitations: ['Ends at ground contact.'] },
    limits: { maxGeometryElements: 64, maxOperations: 100000 },
    sources: [],
    referenceSuite: null,
  };
}

/** Parametric document whose sampled curve is undefined on (−0.5, 0.5). */
export function gapDocument(): VisualizationDocument {
  return {
    schemaVersion: '2.0', id: 'gap', title: 'Curve with a gap', description: 'y = sqrt(x² − c²) is undefined between −c and c.',
    parameters: { c: { label: 'Half-width', value: 0.5, min: 0.1, max: 0.9 } },
    quantities: { width: { expression: '2*c', label: 'Gap width' }, inverse: { expression: '1/(c-0.5)', label: 'Inverse offset' } },
    series: { curve: { label: 'Curve', variable: 'x', domain: [-1, 1], samples: 21, y: 'sqrt(x*x-c*c)' } },
    views: [{ id: 'plot', type: 'plot', title: 'Curve', marks: [{ id: 'curve', type: 'line', label: 'Curve', series: 'curve' }] }],
    assumptions: ['Real-valued square root.'], limitations: ['Sampled at 21 points.'],
  };
}
export function gapManifest(): ModelManifest {
  return {
    contract: MODEL_CONTRACT, schemaVersion: MODEL_SCHEMA_VERSION, modelId: 'test.gap', version: '1.0.0',
    title: 'Curve with a gap (test)', summary: 'A parametric document whose curve has an undefined interval.',
    execution: { kind: 'document', document: gapDocument() },
    capabilities: [],
    parameters: { c: { label: 'Half-width', description: 'Half-width of the undefined interval.', dimension: 'dimensionless', unit: 'dimensionless', min: 0.1, max: 0.9, default: 0.5, step: { ui: 0.1, admissible: 'continuous' }, role: 'model-input' } },
    quantities: {
      width: { label: 'Gap width', shape: { kind: 'scalar' }, dimension: 'dimensionless', unit: 'dimensionless', meaning: 'Width of the undefined interval.' },
      inverse: { label: 'Inverse offset', shape: { kind: 'scalar' }, dimension: 'dimensionless', unit: 'dimensionless', meaning: '1/(c − 0.5); undefined at c = 0.5.' },
    },
    geometry: { curve: { kind: 'polyline2', label: 'Curve', description: 'Sampled curve.', dimension: 'dimensionless', unit: 'dimensionless', coordinateFrame: 'x horizontal, y vertical', maxElements: 21 } },
    constraints: [],
    interpretation: { coordinateConvention: 'Cartesian x–y.', assumptions: ['Real-valued square root.'], limitations: ['Sampled at 21 points.'] },
    limits: { maxGeometryElements: 21, maxOperations: 10000 },
    sources: [],
    referenceSuite: null,
  };
}

export const allKernels: ModelKernel[] = [geometricKernel, rectangleKernel];
