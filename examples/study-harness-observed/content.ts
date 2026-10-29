/**
 * EXAMPLE CONTENT — observed data beside a model prediction (report §8.5). Not catalogue content, not reviewed, and
 * not evidence about falling bodies: the recorded heights are illustrative values constructed by hand for this example
 * (stated in their provenance), not a measurement.
 *
 * The model is a bounded schema 2.0 document: the prediction h(t) = h₀ − g t²/2 is a sampled model series, and the
 * recorded heights are a dataset series of kind `observed`. The manifest's `observations.drops` repeats the document
 * dataset exactly and adds what the Study Harness requires: canonical units, column meanings, a reason for every
 * missing cell and the provenance. The template draws the observations only as separate points (a `points` mark over
 * `observations2` geometry); the only curve is the model's own series. Nothing interpolates or fits the data.
 *
 * Flow: `observe` shows the recorded heights and their table only; `compare` adds the model prediction, its landing
 * time and the h₀/g controls; `done` closes. No group is solution-bearing, so the example needs no exposure receipts.
 */
import type { ActivityTemplate, ContentGroup, MarkSpec } from '@explorable-models/activity';
import { enableDocumentExecution, modelIdentity, MODEL_CONTRACT, MODEL_SCHEMA_VERSION, type ModelManifest, type ObservationDataset } from '@explorable-models/core/model';
import type { VisualizationDocument } from '@explorable-models/core/declarative';

// A document-kind model needs the opt-in schema 2.0 runtime in every realm that identifies or evaluates it.
enableDocumentExecution();

export const PREDICTION_SAMPLES = 101;
export const OBSERVED_TEMPLATE_ID = 'example-falling-ball-observed';

/** Illustrative recorded heights (s, m). Row 3 and 7 lack a height, row 8 a time; each missing cell has a reason. */
export const RECORDED_DROPS: ObservationDataset = {
  label: 'Recorded heights',
  description: 'Heights of a ball released from rest, one reading every 0.2 s.',
  columns: [
    { id: 't', label: 'Time', dimension: 'time', unit: 's', meaning: 'Time since the ball was released.' },
    { id: 'h', label: 'Height', dimension: 'length', unit: 'm', meaning: 'Height of the bottom of the ball above the floor.' },
  ],
  rows: [[0, 20.02], [0.2, 19.81], [0.4, 19.23], [0.6, null], [0.8, 16.83], [1, 15.08], [1.2, 12.97], [1.4, null], [null, 7.49], [1.8, 4.15], [2, 0.44]],
  missing: [
    { row: 3, column: 'h', reason: 'The ball was hidden behind the stand in this frame.' },
    { row: 8, column: 't', reason: 'The frame timestamp was not recorded.' },
  ],
  missingReason: 'Motion blur: no height could be read in this frame.',
  provenance: {
    sourceId: 'example-drop-log',
    description: 'Constructed by hand for this example as readings from video frames at 0.2 s intervals, rounded to 0.01 m, with three cells left unread.',
    license: 'MIT (this repository)',
  },
};

export const fallingBallDocument: VisualizationDocument = {
  schemaVersion: '2.0', id: 'falling-ball', title: 'Falling ball', description: 'A constant-gravity prediction beside recorded heights.',
  parameters: {
    h0: { label: 'Release height', value: 20, min: 5, max: 30, unit: 'm', dimension: 'length' },
    g: { label: 'Gravitational acceleration', value: 9.8, min: 1, max: 20, unit: 'm/s²', dimension: 'acceleration' },
  },
  quantities: { landing: { expression: 'sqrt(2*h0/g)', label: 'Landing time', dimension: 'time' } },
  datasets: { drops: { columns: [{ id: 't', label: 'Time', unit: 's' }, { id: 'h', label: 'Height', unit: 'm' }], rows: RECORDED_DROPS.rows.map(row => [...row]), description: RECORDED_DROPS.description } },
  series: {
    prediction: { label: 'Predicted height', variable: 'u', domain: [0, 1], samples: PREDICTION_SAMPLES, x: 'u*landing', y: 'h0-g*(u*landing)^2/2', kind: 'model' },
    measured: { label: 'Recorded heights', dataset: 'drops', xColumn: 't', yColumn: 'h', kind: 'observed' },
  },
  views: [{ id: 'plot', type: 'plot', title: 'Height over time', marks: [
    { id: 'prediction', type: 'line', label: 'Predicted height', series: 'prediction' },
    { id: 'measured', type: 'scatter', label: 'Recorded heights', series: 'measured' },
  ] }],
  assumptions: ['The ball starts from rest at t = 0 and falls with constant acceleration g; air resistance is neglected.'],
  limitations: ['The recorded heights are not used to choose h₀ or g: the model is never fitted to them.'],
};

const GRAPH = 'time t horizontal (s), height h vertical (m)';
export const fallingBallManifest: ModelManifest = {
  contract: MODEL_CONTRACT, schemaVersion: MODEL_SCHEMA_VERSION, modelId: 'example.falling-ball', version: '0.1.0',
  title: 'Falling ball: prediction and recorded heights (example)',
  summary: 'Height of a ball released from rest under constant gravity, h(t) = h₀ − g t²/2, beside illustrative recorded heights.',
  execution: { kind: 'document', document: fallingBallDocument },
  capabilities: [],
  parameters: {
    h0: { label: 'Release height', symbol: 'h_0', description: 'Height of the ball above the floor when it is released.', dimension: 'length', unit: 'm', min: 5, max: 30, default: 20, step: { ui: 0.5, admissible: 'continuous' }, role: 'model-input' },
    g: { label: 'Gravitational acceleration', symbol: 'g', description: 'Constant downward acceleration of the ball.', dimension: 'acceleration', unit: 'm/s^2', min: 1, max: 20, default: 9.8, step: { ui: 0.1, admissible: 'continuous' }, role: 'model-input' },
  },
  quantities: {
    landing: { label: 'Landing time', symbol: 't_{\\text{land}}', shape: { kind: 'scalar' }, dimension: 'time', unit: 's', meaning: 'Predicted time from release until the height reaches 0: √(2h₀/g).' },
  },
  geometry: {
    prediction: {
      kind: 'polyline2', label: 'Predicted height', dimension: 'length', unit: 'm', coordinates: { x: 's', y: 'm' }, coordinateFrame: GRAPH, maxElements: PREDICTION_SAMPLES,
      description: `The model prediction h(t) = h₀ − g t²/2 sampled at ${PREDICTION_SAMPLES} evenly spaced times from release to landing; the line between samples is a drawing aid.`,
    },
    measured: {
      kind: 'observations2', label: 'Recorded heights', dimension: 'length', unit: 'm', coordinateFrame: GRAPH, maxElements: RECORDED_DROPS.rows.length,
      description: 'Every recorded (time, height) pair of the drop log, missing cells included.', observations: { dataset: 'drops', x: 't', y: 'h' },
    },
  },
  constraints: [],
  interpretation: {
    coordinateConvention: 'Height measured upward from the floor; time from release.',
    assumptions: ['Release from rest at t = 0.', 'Constant downward acceleration g; no air resistance.'],
    limitations: [
      'The recorded heights are illustrative example values, not a measurement.',
      'The model is not fitted to the recorded heights, and no value is interpolated between them.',
      `The prediction is sampled at ${PREDICTION_SAMPLES} times; the line between samples does not certify values between them.`,
    ],
  },
  limits: { maxGeometryElements: PREDICTION_SAMPLES + RECORDED_DROPS.rows.length, maxOperations: 100_000 },
  sources: [
    { id: 'constant-gravity', kind: 'derivation', citation: 'Integrating a constant acceleration −g twice from rest at height h₀ gives h(t) = h₀ − g t²/2, which is 0 at t = √(2h₀/g).' },
    { id: 'example-drop-log', kind: 'dataset', citation: 'Illustrative drop log written for the Explorable Models observed-data example (not a real measurement).' },
  ],
  referenceSuite: null,
  observations: { drops: RECORDED_DROPS },
};

const group = (id: string, kind: ContentGroup['kind'], label: string, description: string, members: string[]): ContentGroup =>
  ({ id, kind, label, description, solutionBearing: false, members });
const style = (role: MarkSpec['style']['role'], marker: MarkSpec['style']['marker']): MarkSpec['style'] => ({ role, dash: 'solid', marker, weight: 'regular' });

export const fallingBallTemplate: ActivityTemplate = {
  contract: 'study-harness.activity-template', schemaVersion: '1.0', templateId: OBSERVED_TEMPLATE_ID, version: '0.1.0',
  model: { modelId: fallingBallManifest.modelId, version: fallingBallManifest.version, digest: modelIdentity(fallingBallManifest).digest },
  title: 'Falling ball: recorded heights and a model',
  purpose: 'Look at recorded heights of a falling ball, including the readings that are missing, then compare them with the constant-gravity prediction h(t) = h₀ − g t²/2.',
  dimension: '2d', locale: 'en', requires: [],
  groups: [
    group('fall-plot-view', 'view', 'Height over time', 'Plot of height against time.', ['fall-plot']),
    group('recorded-data', 'dataset', 'Recorded heights', 'The recorded heights, drawn as separate points, and their table.', ['measured']),
    group('model-prediction', 'dataset', 'Model prediction', 'The predicted height curve and its table.', ['prediction']),
    group('model-values', 'quantity', 'Model values', 'The predicted landing time.', ['landing']),
    group('model-controls', 'control', 'Model parameters', 'Release height and gravitational acceleration.', ['h0', 'g']),
    group('alternatives', 'alternative', 'Tables', 'Tables listing every value the plot shows.', ['fall-tables']),
  ],
  views: [
    {
      id: 'fall-plot', kind: 'plot2d', group: 'fall-plot-view', title: 'Height over time', description: 'Recorded heights as separate points and, once shown, the predicted height as a curve.',
      bounds: [-0.1, 2.4, -1, 22], equalAspect: false, axes: { x: { label: 'Time t', unit: 's' }, y: { label: 'Height h', unit: 'm' } },
      marks: [
        { id: 'recorded-points', kind: 'points', group: 'recorded-data', label: 'Recorded heights', bindings: { geometry: 'measured' }, style: style('secondary', 'diamond') },
        { id: 'prediction-curve', kind: 'curve', group: 'model-prediction', label: 'Predicted height', bindings: { geometry: 'prediction' }, style: style('primary', 'none') },
      ],
    },
    { id: 'recorded-table', kind: 'table', group: 'recorded-data', title: 'Recorded heights: table', description: 'Every recorded time and height, with each missing value and its reason.', equalAspect: false, marks: [], rowsFrom: 'measured' },
    { id: 'prediction-table', kind: 'table', group: 'model-prediction', title: 'Predicted height: table', description: 'Time and predicted height at each sample of the model curve.', equalAspect: false, marks: [], rowsFrom: 'prediction', axes: { x: { label: 'Time t', unit: 's' }, y: { label: 'Height h', unit: 'm' } } },
    { id: 'model-readout', kind: 'values', group: 'model-values', title: 'Model values', description: 'The predicted landing time.', equalAspect: false, marks: [], quantities: ['landing'] },
  ],
  controls: [
    { parameter: 'h0', group: 'model-controls', label: 'Release height h₀', displayUnits: ['m'], slider: true, exact: true, step: 0.5, description: 'Height of the ball above the floor when it is released.' },
    { parameter: 'g', group: 'model-controls', label: 'Gravitational acceleration g', displayUnits: ['m/s^2'], slider: true, exact: true, step: 0.1, description: 'Constant downward acceleration in the model.' },
  ],
  scenarios: [],
  equations: [],
  stages: [
    {
      id: 'observe', kind: 'predict', instruction: 'Look at the recorded heights. Some readings are missing; the table says why.',
      visible: { 'fall-plot-view': 'fixed', 'recorded-data': 'fixed', alternatives: 'fixed' }, controls: {},
      allowsPreview: false, allowsPlayback: false, allowsNavigation: false,
      response: { kind: 'prediction', prompt: 'How does the recorded height change as time passes? Is the ball speeding up, slowing down or moving steadily?', taskFamily: 'falling-ball-prediction' },
    },
    {
      id: 'compare', kind: 'explore', instruction: 'The constant-gravity prediction is now shown beside the recorded heights. Change h₀ and g and compare the curve with the points.',
      visible: { 'fall-plot-view': 'interactive', 'recorded-data': 'fixed', 'model-prediction': 'fixed', 'model-values': 'fixed', 'model-controls': 'interactive', alternatives: 'fixed' },
      controls: { h0: 'interactive', g: 'interactive' }, allowsPreview: true, allowsPlayback: false, allowsNavigation: false,
    },
    { id: 'done', kind: 'closed', instruction: 'This activity is finished.', visible: {}, controls: {}, allowsPreview: false, allowsPlayback: false, allowsNavigation: false },
  ],
  transitions: [{ id: 'show-model', from: 'observe', to: 'compare', label: 'Show the model' }, { id: 'finish', from: 'compare', to: 'done', label: 'Finish' }],
  initialStage: 'observe',
  alternatives: [{
    id: 'fall-tables', kind: 'table', group: 'alternatives', label: 'Tables of recorded and predicted heights', covers: ['fall-plot'], equivalence: 'equivalent',
    description: 'The recorded-heights table lists every observation, each missing value with its reason; once the model is shown, the predicted-height table lists every sample of the curve.',
    verifiedBy: 'tests/browser/study-observed-data.spec.ts',
  }],
  taskFamilies: [{ id: 'falling-ball-prediction', description: 'Host-owned prediction about the recorded fall.', hostOwned: true }],
  content: [{ id: 'model-derivation', kind: 'derivation', text: 'From rest with constant downward acceleration g: h(t) = h₀ − g t²/2, which reaches 0 at t = √(2h₀/g).' }],
};
