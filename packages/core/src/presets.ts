import type { VisualizationDocument, ParameterSpec } from './declarative/types.js';

const parameter = (label: string, value: number, min: number, max: number, step = 0.1, unit = '', dimension?: string): ParameterSpec => ({ label, value, min, max, step, unit, ...(dimension ? { dimension } : {}) });
const common = { schemaVersion: '2.0' as const, provenance: { review: 'unreviewed' as const, checks: 'author' as const }, sources: [] };
const documents: Record<string, VisualizationDocument> = {
  wave: {
    ...common, id: 'wave', title: 'Shape a wave', description: 'Change amplitude and frequency; inspect a sampled curve and the exact value at a chosen coordinate.',
    parameters: { amplitude: parameter('Amplitude', 2, 0, 5), frequency: parameter('Frequency', 1, 0, 5), probe: parameter('Probe x', 0.25, -2, 2, 0.01) },
    quantities: { ordinate: { expression: 'amplitude*sin(2*pi*frequency*probe)', label: 'Value at probe' }, probePoint: { expression: '[probe,ordinate]', label: 'Probe position' } },
    series: { wave: { label: 'Model: sine wave', x: 'x', y: 'amplitude*sin(2*pi*frequency*x)', variable: 'x', domain: [-2, 2], samples: 401, kind: 'model' } },
    views: [ { id: 'plot', type: 'plot', title: 'Amplitude and frequency', description: 'A model curve with a movable exact probe.', bounds: [-2, 2, -5, 5], xLabel: 'x', yLabel: 'y', marks: [{ id: 'wave', type: 'line', label: 'Sine wave', series: 'wave', style: { stroke: '#287c8e' } }, { id: 'probe', type: 'point', label: 'Probe', bindings: { position: 'probePoint' }, style: { fill: '#bf5b35' } }] }, { id: 'values', type: 'values', title: 'At the probe', quantities: ['ordinate'] }, { id: 'equation', type: 'equation', title: 'Relationship', equation: 'y = A sin(2πfx)\nAt the probe: y = {{ordinate}}' } ],
    assumptions: ['The frequency is expressed in cycles per x unit.', 'The curve uses uniformly spaced model samples.'], limitations: ['Sampling can miss oscillations at frequencies beyond the published bounds.']
  },
  triangle: {
    ...common, id: 'triangle', title: 'A triangle you can measure', description: 'Move the third vertex or enter exact coordinates. All side lengths and area share the same model frame.',
    parameters: { bx: parameter('Base x', 3, -5, 5), cx: parameter('Vertex x', 0, -5, 5), cy: parameter('Vertex y', 4, -5, 5) },
    quantities: { a: { expression: [0,0], label: 'Origin' }, b: { expression: '[bx,0]', label: 'Base vertex' }, c: { expression: '[cx,cy]', label: 'Movable vertex' }, vertices: { expression: '[0,0,bx,0,cx,cy]', label: 'Triangle vertices' }, sideAB: { expression: 'abs(bx)', label: 'Side AB' }, sideAC: { expression: 'sqrt(cx*cx+cy*cy)', label: 'Side AC' }, sideBC: { expression: 'sqrt((cx-bx)^2+cy^2)', label: 'Side BC' }, area: { expression: 'abs(bx*cy)/2', label: 'Area' }, angleA: { expression: 'acos((bx*cx)/(sideAB*sideAC))', label: 'Angle at A', unit: 'rad' } },
    views: [{ id: 'geometry', type: 'scene', title: 'Coordinate geometry', bounds: [-6,6,-6,6], equalAspect: true, marks: [{ id: 'triangle', type: 'polygon', label: 'Triangle ABC', bindings: { points: 'vertices' }, style: { stroke: '#287c8e', fill: '#d9edf0' } }, { id: 'vertex', type: 'point', label: 'Vertex C; exact controls below', bindings: { position: 'c' }, drag: { x: 'cx', y: 'cy' }, style: { fill: '#bf5b35' } }, { id: 'label', type: 'label', label: 'Vertex C label', text: 'C', bindings: { position: 'c' }, offset: [12,-12] }] }, { id: 'measures', type: 'values', title: 'Measurements', quantities: ['sideAB','sideAC','sideBC','area','angleA'] }],
    assumptions: ['Euclidean plane; equal axis scales.', 'Vertex A is at the origin and B lies on the x axis.'], limitations: ['The angle is undefined if either adjacent side has zero length. A collinear nonzero triangle has area zero.']
  },
  projectile: {
    ...common, id: 'projectile', title: 'One flight, linked views', description: 'Follow an ideal projectile until its exact return to the ground. The velocity at impact is retained.',
    parameters: { vx: parameter('Horizontal velocity', 3, 0, 10, 0.1, 'm/s', 'velocity'), vy: parameter('Vertical velocity', 4, 0.1, 10, 0.1, 'm/s', 'velocity'), g: parameter('Gravity', 10, 1, 20, 0.1, 'm/s²', 'acceleration') },
    quantities: { flight: { expression: '2*vy/g', label: 'Flight time', unit: 's' }, range: { expression: 'vx*flight', label: 'Range', unit: 'm' }, position: { expression: '[vx*time,vy*time-g*time*time/2]', label: 'Position', unit: 'm' }, verticalVelocity: { expression: 'vy-g*time', label: 'Vertical velocity', unit: 'm/s' }, ground: { expression: [0,0,20,0], label: 'Ground' } },
    series: { trajectory: { label: 'Predicted trajectory', variable: 'u', domain: [0,1], samples: 121, x: 'vx*u*flight', y: 'vy*u*flight-g*(u*flight)^2/2', kind: 'model' } },
    time: { end: 'flight', step: 0.02 },
    views: [{ id: 'scene', type: 'scene', title: 'Predicted flight and current position', bounds: [0,20,-1,10], equalAspect: true, xLabel: 'Distance (m)', yLabel: 'Height (m)', marks: [{ id: 'ground', type: 'path', label: 'Ground level', bindings: { points: 'ground' }, style: { stroke: '#7b817c' } }, { id: 'trajectory', type: 'line', label: 'Predicted path', series: 'trajectory', style: { stroke: '#287c8e', dash: 'dashed' } }, { id: 'body', type: 'point', label: 'Current projectile position', bindings: { position: 'position' }, style: { fill: '#bf5b35' }, semanticId: 'projectile' }] }, { id: 'values', type: 'values', title: 'Same committed frame', quantities: ['position','verticalVelocity','flight','range'] }],
    assumptions: ['Constant downward gravity; no air resistance.', 'Initial position is (0,0).'], limitations: ['The trajectory ends at the first positive ground return.', 'Fixed scene bounds may clip some allowed extreme parameters; inspect exact values.']
  },
  'linear-map': {
    ...common, id: 'linear-map-v2', title: 'See a linear transformation', description: 'Transform a point and a unit square with one editable matrix.',
    parameters: { a: parameter('Matrix a', 1, -3, 3), b: parameter('Matrix b', 0.5, -3, 3), c: parameter('Matrix c', 0, -3, 3), d: parameter('Matrix d', 1, -3, 3), x: parameter('Input x', 1, -3, 3), y: parameter('Input y', 1, -3, 3) },
    quantities: { input: { expression: '[x,y]', label: 'Input point' }, output: { expression: '[a*x+b*y,c*x+d*y]', label: 'Output point' }, origin: { expression: [0,0] }, basisX: { expression: '[a,c]' }, basisY: { expression: '[b,d]' }, square: { expression: '[0,0,a,c,a+b,c+d,b,d]' }, determinant: { expression: 'a*d-b*c', label: 'Signed determinant' }, area: { expression: 'abs(determinant)', label: 'Geometric area' } },
    views: [{ id: 'scene', type: 'scene', title: 'Transformed plane', bounds: [-7,7,-7,7], equalAspect: true, marks: [{ id: 'square', type: 'polygon', label: 'Transformed unit square', bindings: { points: 'square' }, style: { fill: '#d9edf0', stroke: '#287c8e' } }, { id: 'basis-x', type: 'arrow', label: 'First transformed basis vector', bindings: { start: 'origin', end: 'basisX' }, style: { stroke: '#bf5b35' } }, { id: 'basis-y', type: 'arrow', label: 'Second transformed basis vector', bindings: { start: 'origin', end: 'basisY' }, style: { stroke: '#5865a8', dash: 'dashed' } }, { id: 'input', type: 'point', label: 'Input point', bindings: { position: 'input' }, drag: { x: 'x', y: 'y' } }, { id: 'output', type: 'point', label: 'Transformed point', bindings: { position: 'output' }, style: { fill: '#bf5b35' } }] }, { id: 'values', type: 'values', title: 'Matrix measurements', quantities: ['input','output','determinant','area'] }],
    assumptions: ['Column-vector convention: output = M × input.', 'The displayed square has unit area before transformation.'], limitations: ['Singular matrices collapse area to zero; orientation is encoded by the signed determinant.']
  },
  'riemann-sums': {
    ...common, id: 'riemann-v2', title: 'A small error is still a value', description: 'The midpoint approximation of x² on [0,1], with the signed error kept visible.',
    parameters: { n: { ...parameter('Subdivisions', 100, 1, 1000, 1), integer: true } },
    quantities: { integral: { expression: '1/3', label: 'Exact integral' }, approximation: { expression: '(4*n*n-1)/(12*n*n)', label: 'Midpoint sum' }, error: { expression: 'approximation-integral', label: 'Signed error' } },
    series: { curve: { label: 'Integrand x²', x: 'x', y: 'x*x', domain: [0,1], samples: 101, kind: 'model' } },
    views: [{ id: 'plot', type: 'plot', title: 'Integrand', bounds: [0,1,0,1], marks: [{ id: 'area', type: 'region', label: 'Area under x²', series: 'curve', style: { fill: '#d9edf0', stroke: '#287c8e' } }] }, { id: 'values', type: 'values', title: 'Exact and approximate', quantities: ['integral','approximation','error'] }, { id: 'equation', type: 'equation', title: 'Closed-form midpoint sum', equation: 'Mₙ = (4n² − 1)/(12n²)\nMₙ − ⅓ = {{error}}' }],
    assumptions: ['Uniform midpoint rule for x² over [0,1].', 'The sum is evaluated with its exact algebraic closed form.'], limitations: ['The filled plot shows the integrand, not individual rectangles.', 'Subdivisions must be an integer; exact numeric inputs enforce this domain.']
  },
  oscillator: {
    ...common, id: 'oscillator-v2', title: 'An analytical oscillator', description: 'Inspect phase and displacement without a numerical solver.',
    parameters: { amplitude: parameter('Amplitude', 2, 0, 5), omega: parameter('Angular frequency', 1, 0.1, 5, 0.1, 'rad/s', 'frequency'), phase: parameter('Initial phase', 0, -3.14, 3.14, 0.01) },
    quantities: { second: { expression: 1, dimension: 'time', unit: 's' }, displacement: { expression: 'amplitude*cos(omega*time+phase)', label: 'Displacement' }, velocity: { expression: '-amplitude*omega*sin(omega*time+phase)', label: 'Velocity' }, position: { expression: '[displacement,0]', label: 'Position' }, anchor: { expression: [0,0] } },
    series: { predicted: { label: 'Predicted displacement', variable: 'u', x: 'u', y: 'amplitude*cos(omega*u*second+phase)', domain: [0,20], samples: 401, kind: 'model' } }, time: { end: 20, step: 0.05 },
    views: [{ id: 'scene', type: 'scene', title: 'Current position', bounds: [-6,6,-2,2], equalAspect: true, marks: [{ id: 'arm', type: 'segment', label: 'Displacement from origin', bindings: { start: 'anchor', end: 'position' } }, { id: 'mass', type: 'point', label: 'Oscillating point', bindings: { position: 'position' }, semanticId: 'mass' }] }, { id: 'plot', type: 'plot', title: 'Predicted motion', bounds: [0,20,-5,5], xLabel: 'Time', yLabel: 'Displacement', marks: [{ id: 'prediction', type: 'line', label: 'Model displacement', series: 'predicted', style: { stroke: '#287c8e' } }] }, { id: 'values', type: 'values', title: 'Current values', quantities: ['displacement','velocity'] }],
    assumptions: ['Ideal undamped sinusoidal motion.', 'Time and angular frequency use a consistent normalized unit system.'], limitations: ['This is an analytical expression, not a general dynamical solver.']
  },
  'supplied-data': {
    ...common, id: 'supplied-data', title: 'Measurements and an explicit model', description: 'Compare immutable supplied measurements with an explicitly chosen straight line. No regression is inferred.',
    parameters: { slope: parameter('Overlay slope', 2, -5, 5), intercept: parameter('Overlay intercept', 1, -5, 5) }, quantities: { first: { expression: 'intercept', label: 'Overlay at x = 0' } },
    datasets: { measurements: { columns: [{ id: 'x', label: 'Input x' }, { id: 'y', label: 'Observed y' }], rows: [[0,1],[1,3],[2,5]], description: 'Three supplied illustrative observations; null cells create gaps.' } },
    series: { observations: { label: 'Supplied observations', dataset: 'measurements', xColumn: 'x', yColumn: 'y', kind: 'observed' }, overlay: { label: 'Explicit model y = mx + b', x: 'x', y: 'slope*x+intercept', domain: [0,2], samples: 41, kind: 'model' } },
    views: [{ id: 'plot', type: 'plot', title: 'Observed and model values', bounds: [-0.2,2.2,-1,7], xLabel: 'x', yLabel: 'y', marks: [{ id: 'overlay', type: 'line', label: 'Supplied linear overlay', series: 'overlay', style: { stroke: '#287c8e', dash: 'dashed' } }, { id: 'observations', type: 'scatter', label: 'Observed samples', series: 'observations', style: { fill: '#bf5b35' } }] }, { id: 'table', type: 'table', title: 'Original supplied values', dataset: 'measurements' }],
    assumptions: ['Illustrative supplied data; no measurement uncertainty is asserted.', 'The overlay is authored explicitly.'], limitations: ['Missing values stay missing; there is no automatic interpolation or regression.']
  },
  probability: {
    ...common, id: 'probability-v2', title: 'Condition on a positive test', description: 'Expected frequencies and the positive predictive value from one explicit probability model.',
    parameters: { prevalence: parameter('Prevalence', 0.01, 0, 1, 0.001), sensitivity: parameter('Sensitivity', 0.9, 0, 1, 0.01), specificity: parameter('Specificity', 0.95, 0, 1, 0.01), population: { ...parameter('Population', 1000, 1, 10000, 1), integer: true } },
    quantities: { truePositive: { expression: 'population*prevalence*sensitivity', label: 'Expected true positives' }, falsePositive: { expression: 'population*(1-prevalence)*(1-specificity)', label: 'Expected false positives' }, positive: { expression: 'truePositive+falsePositive', label: 'Expected positive tests' }, ppv: { expression: 'truePositive/positive', label: 'P(condition | positive)' } },
    views: [{ id: 'values', type: 'values', title: 'Expected frequencies', quantities: ['truePositive','falsePositive','positive','ppv'] }, { id: 'equation', type: 'equation', title: 'Conditioning', equation: 'P(condition | +) = true positives / all positives\n= {{ppv}}' }],
    assumptions: ['Sensitivity and specificity are constant within the population.', 'Counts are expected frequencies and may be fractional.'], limitations: ['Illustrative probability model; no clinical interpretation.', 'If no positive tests are expected, the conditional probability is undefined.']
  }
};

/** Presets are ordinary editable documents; callers receive independent copies. */
export function createPreset(id: string): VisualizationDocument {
  const document = documents[id];
  if (!document) throw new Error(`Unknown preset ${id}. Available: ${Object.keys(documents).join(', ')}`);
  return structuredClone(document);
}
export const presetCatalog = Object.entries(documents).map(([id, document]) => ({ id, title: document.title, description: document.description }));
