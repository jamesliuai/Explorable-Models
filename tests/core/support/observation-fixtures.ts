/**
 * TEST-ONLY observed-data manifests for the model engine tests (report §8.5): a static kernel model and a schema 2.0
 * document model, each with the same small observed dataset beside a model prediction. The numbers are illustrative
 * values written for these tests, not measurements, and carry no scientific-review claim.
 */
import { enableDocumentExecution, MODEL_CONTRACT, MODEL_SCHEMA_VERSION } from '../../../packages/core/src/model/index';
import type { KernelOutput, ModelKernel, ModelManifest, ObservationDataset } from '../../../packages/core/src/model/index';
import type { VisualizationDocument } from '../../../packages/core/src/declarative/types';

// The document model below needs the opt-in schema 2.0 document runtime (core/model/document-support.ts).
enableDocumentExecution();

export const PREDICTION_SAMPLES = 21;

/** Constant-gravity drop from rest: landing time √(2h₀/g) and the predicted height curve h(t) = h₀ − g t²/2. */
export const fallKernel: ModelKernel = {
  id: 'test.fall', version: '1.0.0', mode: 'static',
  evaluate({ params }): KernelOutput {
    const { h0, g } = params as Record<'h0' | 'g', number>;
    const landing = Math.sqrt(2 * h0 / g);
    const points: [number, number][] = Array.from({ length: PREDICTION_SAMPLES }, (_, i) => { const t = landing * i / (PREDICTION_SAMPLES - 1); return [t, h0 - g * t * t / 2]; });
    return {
      quantities: { landing: { status: 'valid', value: landing } },
      geometry: { prediction: { kind: 'polyline2', segments: [{ points, start: 'closed', end: 'closed' }], gaps: [], sampling: { samples: PREDICTION_SAMPLES, domain: [0, landing] } } },
    };
  },
};

/** Rows: a complete row, a missing height (own reason), a missing time (dataset reason) and complete rows around them. */
export function drops(): ObservationDataset {
  return {
    label: 'Recorded heights', description: 'Heights of a released ball read from video frames.',
    columns: [
      { id: 't', label: 'Time', dimension: 'time', unit: 's', meaning: 'Time since release.' },
      { id: 'h', label: 'Height', dimension: 'length', unit: 'm', meaning: 'Height of the ball above the floor.' },
    ],
    rows: [[0, 20.02], [0.5, 18.8], [1, null], [null, 12.4], [1.5, 9.04], [2, 0.41]],
    missing: [{ row: 2, column: 'h', reason: 'The ball was hidden behind the stand in this frame.' }],
    missingReason: 'The frame timestamp was not recorded.',
    provenance: { sourceId: 'drop-video', description: 'Illustrative values written for these tests; not a measurement.', license: 'MIT (this repository)' },
  };
}

const base = (): Omit<ModelManifest, 'execution' | 'modelId'> => ({
  contract: MODEL_CONTRACT, schemaVersion: MODEL_SCHEMA_VERSION, version: '1.0.0',
  title: 'Falling ball (test)', summary: 'A constant-gravity prediction beside recorded heights.',
  capabilities: [],
  parameters: {
    h0: { label: 'Release height', description: 'Height of release above the floor.', dimension: 'length', unit: 'm', min: 5, max: 30, default: 20, step: { ui: 0.5, admissible: 'continuous' }, role: 'model-input' },
    g: { label: 'Gravitational acceleration', description: 'Constant downward acceleration.', dimension: 'acceleration', unit: 'm/s^2', min: 1, max: 20, default: 9.8, step: { ui: 0.1, admissible: 'continuous' }, role: 'model-input' },
  },
  quantities: { landing: { label: 'Landing time', shape: { kind: 'scalar' }, dimension: 'time', unit: 's', meaning: 'Predicted time from release to the floor.' } },
  geometry: {
    prediction: { kind: 'polyline2', label: 'Predicted height', description: 'Model prediction h(t) = h₀ − g t²/2, sampled.', dimension: 'length', unit: 'm', coordinates: { x: 's', y: 'm' }, coordinateFrame: 'time horizontal (s), height vertical (m)', maxElements: PREDICTION_SAMPLES },
    measured: { kind: 'observations2', label: 'Recorded heights', description: 'Recorded heights against time.', dimension: 'length', unit: 'm', coordinateFrame: 'time horizontal (s), height vertical (m)', maxElements: 6, observations: { dataset: 'drops', x: 't', y: 'h' } },
  },
  constraints: [],
  interpretation: { coordinateConvention: 'Height upward from the floor; time from release.', assumptions: ['Constant gravity; no air resistance.'], limitations: ['Recorded heights are not used to fit the model.'] },
  limits: { maxGeometryElements: 64, maxOperations: 1000 },
  sources: [{ id: 'drop-video', kind: 'dataset', citation: 'Test fixture: illustrative drop recording (no real measurement).' }],
  referenceSuite: null,
  observations: { drops: drops() },
});

export function fallKernelManifest(): ModelManifest {
  return { ...base(), modelId: 'test.fall-kernel', execution: { kind: 'kernel', kernelId: 'test.fall', kernelVersion: '1.0.0', mode: 'static' } };
}

export function fallDocument(): VisualizationDocument {
  const data = drops();
  return {
    schemaVersion: '2.0', id: 'fall', title: 'Falling ball', description: 'A constant-gravity prediction beside recorded heights.',
    parameters: { h0: { label: 'Release height', value: 20, min: 5, max: 30, unit: 'm', dimension: 'length' }, g: { label: 'Gravity', value: 9.8, min: 1, max: 20, unit: 'm/s²', dimension: 'acceleration' } },
    quantities: { landing: { expression: 'sqrt(2*h0/g)', label: 'Landing time', dimension: 'time' } },
    datasets: { drops: { columns: [{ id: 't', label: 'Time', unit: 's' }, { id: 'h', label: 'Height', unit: 'm' }], rows: structuredClone(data.rows), description: data.description } },
    series: {
      prediction: { label: 'Predicted height', variable: 'u', domain: [0, 1], samples: PREDICTION_SAMPLES, x: 'u*landing', y: 'h0-g*(u*landing)^2/2' },
      measured: { label: 'Recorded heights', dataset: 'drops', xColumn: 't', yColumn: 'h' },
    },
    views: [{ id: 'plot', type: 'plot', title: 'Height over time', marks: [{ id: 'prediction', type: 'line', label: 'Prediction', series: 'prediction' }, { id: 'measured', type: 'scatter', label: 'Recorded', series: 'measured' }] }],
    assumptions: ['Constant gravity; no air resistance.'], limitations: ['Recorded heights are not used to fit the model.'],
  };
}

export function fallDocumentManifest(document: VisualizationDocument = fallDocument()): ModelManifest {
  return { ...base(), modelId: 'test.fall-document', execution: { kind: 'document', document } };
}
