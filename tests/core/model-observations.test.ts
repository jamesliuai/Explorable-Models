/**
 * Observed datasets in the model contract (report §8.5, A10, A13): provenance, units and missing cells are preserved,
 * observations stay distinct from model output through the worker protocol, kernels and documents can never supply or
 * alter them, and every cell belongs to the scientific identity.
 */
import { describe, expect, it } from 'vitest';
import {
  createModelEvaluator, evaluateRequest, manifestShapeErrors, ModelError, validateKernelOutput, validateManifest,
  type GeometryResult, type ModelManifest, type ObservationGeometry,
} from '../../packages/core/src/model/index';
import { fallDocument, fallDocumentManifest, fallKernel, fallKernelManifest } from './support/observation-fixtures';
import { inlineWorkers } from './support/inline-worker';

const STATIC = { kind: 'static' } as const;
const DEFAULTS = { h0: 20, g: 9.8 };
const codes = (run: () => unknown): string[] => {
  try { run(); } catch (error) { expect(error).toBeInstanceOf(ModelError); return (error as ModelError).diagnostics.map(item => `${item.code} ${item.path}`); }
  throw new Error('Expected a ModelError.');
};
const measured = (geometry: Record<string, GeometryResult>) => geometry.measured as ObservationGeometry;
const EXPECTED_POINTS = [
  { row: 0, values: [0, 20.02] },
  { row: 1, values: [0.5, 18.8] },
  { row: 2, values: [1, null], reason: 'The ball was hidden behind the stand in this frame.' },
  { row: 3, values: [null, 12.4], reason: 'The frame timestamp was not recorded.' },
  { row: 4, values: [1.5, 9.04] },
  { row: 5, values: [2, 0.41] },
];
const PROVENANCE = { sourceId: 'drop-video', citation: 'Test fixture: illustrative drop recording (no real measurement).', description: 'Illustrative values written for these tests; not a measurement.', license: 'MIT (this repository)' };

describe('observed datasets: kernel and document executions', () => {
  it('a kernel model frame carries the observations with provenance and missing cells preserved (never 0)', () => {
    const { manifest } = validateManifest(fallKernelManifest());
    const data = evaluateRequest({ manifest, params: DEFAULTS, position: STATIC }, [fallKernel]);
    expect(measured(data.geometry)).toEqual({ kind: 'observations2', dataset: 'drops', columns: ['t', 'h'], provenance: PROVENANCE, points: EXPECTED_POINTS });
    // The model prediction stays a separate, connected model geometry.
    expect(data.geometry.prediction!.kind).toBe('polyline2');
  });

  it('a document manifest with a dataset series yields observation geometry, not a connected polyline', () => {
    const { manifest } = validateManifest(fallDocumentManifest());
    const data = evaluateRequest({ manifest, params: DEFAULTS, position: STATIC }, []);
    expect(measured(data.geometry)).toEqual({ kind: 'observations2', dataset: 'drops', columns: ['t', 'h'], provenance: PROVENANCE, points: EXPECTED_POINTS });
    expect(data.geometry.prediction).toMatchObject({ kind: 'polyline2', sampling: { samples: 21, domain: [0, 1] } });
  });

  it('a document dataset series explicitly labelled model output stays a model polyline', () => {
    const document = fallDocument();
    document.series!.measured = { ...document.series!.measured!, kind: 'model' };
    const manifest = fallDocumentManifest(document);
    const { observations: _observations, ...geometry } = manifest.geometry.measured!;
    // A polyline's coordinates are in its unit unless declared: time against height declares x in seconds (report §8.3).
    manifest.geometry.measured = { ...geometry, kind: 'polyline2' };
    expect(() => validateManifest(manifest)).toThrow(/plotted as x of series "measured" states a unit other than the geometry's m/);
    manifest.geometry.measured = { ...geometry, kind: 'polyline2', coordinates: { x: 's', y: 'm' } };
    const data = evaluateRequest({ manifest: validateManifest(manifest).manifest, params: DEFAULTS, position: STATIC }, []);
    expect(data.geometry.measured!.kind).toBe('polyline2');
  });

  it('does not silently assign centimetres to observed document cells with unstated units', () => {
    const document = fallDocument();
    delete document.datasets!.drops!.columns[1]!.unit;
    const manifest = fallDocumentManifest(document);
    manifest.observations!.drops!.columns[1]!.unit = 'cm';
    manifest.geometry.measured!.unit = 'cm';
    expect(codes(() => validateManifest(manifest))).toContain('UNIT_MISMATCH $.observations.drops.columns[1].unit');
  });

  it('every cell, unit, reason, the provenance and the label wording belong to the scientific identity; label spelling is presentation', () => {
    const identity = (edit: (manifest: ModelManifest) => void) => { const manifest = fallKernelManifest(); edit(manifest); return validateManifest(manifest).identity; };
    const original = identity(() => undefined);
    const cell = identity(manifest => { manifest.observations!.drops!.rows[1]![1] = 18.81; });
    expect(cell.scientificRevision).not.toBe(original.scientificRevision);
    expect(cell.digest).not.toBe(original.digest);
    for (const edit of [
      (manifest: ModelManifest) => { manifest.observations!.drops!.rows[1]![1] = null; manifest.observations!.drops!.missing!.push({ row: 1, column: 'h', reason: 'Lost.' }); },
      // Metres relabelled as centimetres with unchanged numbers is a different experiment (report §8.3).
      (manifest: ModelManifest) => { manifest.observations!.drops!.columns[1]!.unit = 'cm'; manifest.geometry.measured!.unit = 'cm'; },
      (manifest: ModelManifest) => { manifest.observations!.drops!.missing![0]!.reason = 'Another reason.'; },
      (manifest: ModelManifest) => { manifest.observations!.drops!.provenance.license = 'CC-BY-4.0'; },
      (manifest: ModelManifest) => { manifest.observations!.drops!.columns[0]!.meaning = 'Time since the camera started.'; },
      (manifest: ModelManifest) => { manifest.geometry.measured!.observations = { dataset: 'drops', x: 'h', y: 't' }; manifest.geometry.measured!.unit = 's'; manifest.geometry.measured!.dimension = 'time'; },
    ]) expect(identity(edit).scientificRevision).not.toBe(original.scientificRevision);
    // Dataset and column labels are the learner's table headers (report §8.3, R38): a respelling that keeps the wording
    // is presentation, a reworded or swapped header is a change of meaning.
    const respelled = identity(manifest => { manifest.observations!.drops!.label = 'Recorded\u00a0heights'; manifest.observations!.drops!.columns[1]!.label = ' Height '; });
    expect(respelled.scientificRevision).toBe(original.scientificRevision);
    expect(respelled.presentationRevision).not.toBe(original.presentationRevision);
    for (const edit of [
      (manifest: ModelManifest) => { manifest.observations!.drops!.label = 'Measured heights'; },
      (manifest: ModelManifest) => { manifest.observations!.drops!.columns[1]!.label = 'Height above floor'; },
      (manifest: ModelManifest) => { const [t, h] = manifest.observations!.drops!.columns; [t!.label, h!.label] = [h!.label, t!.label]; },
    ]) {
      const relabelled = identity(edit);
      expect(relabelled.scientificRevision).not.toBe(original.scientificRevision);
      expect(relabelled.presentationRevision).not.toBe(original.presentationRevision);
    }
    // The order of missing-cell entries is not science.
    const reordered = identity(manifest => { const data = manifest.observations!.drops!; data.rows[0]![1] = null; data.missing = [{ row: 2, column: 'h', reason: 'The ball was hidden behind the stand in this frame.' }, { row: 0, column: 'h', reason: 'Blur.' }]; });
    const sorted = identity(manifest => { const data = manifest.observations!.drops!; data.rows[0]![1] = null; data.missing = [{ row: 0, column: 'h', reason: 'Blur.' }, { row: 2, column: 'h', reason: 'The ball was hidden behind the stand in this frame.' }]; });
    expect(reordered.scientificRevision).toBe(sorted.scientificRevision);
    // A manifest without observations keeps its identity (the field is additive).
    expect(Object.keys(validateManifest(fallKernelManifest()).manifest)).toContain('observations');
  });

  it('a document dataset must equal the manifest dataset exactly', () => {
    const document = fallDocument();
    document.datasets!.drops!.rows[4]![1] = 9.05;
    expect(codes(() => validateManifest(fallDocumentManifest(document)))).toContain('INVALID_INPUT $.observations.drops.rows');
    const units = fallDocument();
    units.datasets!.drops!.columns[1]!.unit = 'cm';
    expect(codes(() => validateManifest(fallDocumentManifest(units)))).toContain('INVALID_INPUT $.observations.drops.columns[1].unit');
    const polyline = fallDocumentManifest();
    const { observations: _o, ...rest } = polyline.geometry.measured!;
    polyline.geometry.measured = { ...rest, kind: 'polyline2' };
    expect(codes(() => validateManifest(polyline))).toContain('INVALID_INPUT $.geometry.measured.kind');
    const sampled = fallDocument();
    sampled.series!.prediction = { ...sampled.series!.prediction!, kind: 'observed' };
    expect(codes(() => validateManifest(fallDocumentManifest(sampled)))).toContain('INVALID_INPUT $.execution.document.series.prediction.kind');
    const missing = fallDocumentManifest();
    delete missing.observations;
    expect(codes(() => validateManifest(missing))).toEqual(expect.arrayContaining(['INVALID_REFERENCE $.geometry.measured.observations.dataset', 'INVALID_REFERENCE $.observations.drops']));
  });

  it('rejects unexplained missing cells, misplaced reasons, uncited data and unit mismatches', () => {
    const invalid = (edit: (manifest: ModelManifest) => void) => { const manifest = fallKernelManifest(); edit(manifest); return codes(() => validateManifest(manifest)); };
    expect(invalid(manifest => { delete manifest.observations!.drops!.missingReason; })).toContain('INVALID_INPUT $.observations.drops.missingReason');
    expect(invalid(manifest => { manifest.observations!.drops!.missing!.push({ row: 0, column: 'h', reason: 'Not missing.' }); })).toContain('INVALID_INPUT $.observations.drops.missing[1]');
    expect(invalid(manifest => { manifest.observations!.drops!.missing!.push({ row: 2, column: 'h', reason: 'Twice.' }); })).toContain('INVALID_INPUT $.observations.drops.missing[1]');
    expect(invalid(manifest => { manifest.observations!.drops!.missing![0]!.column = 'speed'; })).toContain('INVALID_REFERENCE $.observations.drops.missing[0].column');
    expect(invalid(manifest => { manifest.observations!.drops!.rows[0] = [0]; })).toContain('INVALID_INPUT $.observations.drops.rows[0]');
    expect(invalid(manifest => { manifest.observations!.drops!.columns[0]!.unit = 'm'; })).toContain('INVALID_INPUT $.observations.drops.columns[0].unit');
    expect(invalid(manifest => { manifest.sources[0]!.kind = 'derivation'; })).toContain('INVALID_INPUT $.observations.drops.provenance.sourceId');
    expect(invalid(manifest => { manifest.observations!.drops!.provenance.sourceId = 'elsewhere'; })).toContain('INVALID_REFERENCE $.observations.drops.provenance.sourceId');
    expect(invalid(manifest => { manifest.geometry.measured!.unit = 'cm'; })).toContain('INVALID_INPUT $.geometry.measured.unit');
    expect(invalid(manifest => { manifest.geometry.measured!.maxElements = 5; })).toContain('RESOURCE_LIMIT $.geometry.measured.maxElements');
    expect(invalid(manifest => { manifest.geometry.measured!.observations = { dataset: 'drops', x: 't', y: 'speed' }; })).toContain('INVALID_REFERENCE $.geometry.measured.observations.y');
    expect(invalid(manifest => { delete manifest.geometry.measured!.observations; })).toContain('INVALID_INPUT $.geometry.measured.observations');
    expect(invalid(manifest => { manifest.geometry.prediction!.observations = { dataset: 'drops', x: 't', y: 'h' }; })).toContain('INVALID_INPUT $.geometry.prediction.observations');
  });

  it('bounds observed data by schema: row count, unknown fields and nonfinite-free numeric cells', () => {
    const manifest = fallKernelManifest();
    expect(manifestShapeErrors(manifest)).toEqual([]);
    const huge = fallKernelManifest();
    huge.observations!.drops!.rows = Array.from({ length: 2001 }, (_, i) => [i, i]);
    expect(manifestShapeErrors(huge).length).toBeGreaterThan(0);
    const unknown = fallKernelManifest() as unknown as { observations: { drops: Record<string, unknown> } };
    unknown.observations.drops.interpolate = true;
    expect(manifestShapeErrors(unknown).map(item => item.path)).toContain('$.observations.drops.interpolate');
    const text = fallKernelManifest() as unknown as { observations: { drops: { rows: unknown[][] } } };
    text.observations.drops.rows[0]![1] = '20.02';
    expect(manifestShapeErrors(text).length).toBeGreaterThan(0);
  });
});

describe('observed data through the worker protocol', () => {
  it('a kernel cannot return or replace observed geometry', () => {
    const { manifest } = validateManifest(fallKernelManifest());
    const output = fallKernel.evaluate({ params: DEFAULTS, index: 0 });
    expect(validateKernelOutput(manifest, STATIC, output).geometry.measured).toBeUndefined();
    const forged = { ...output, geometry: { ...output.geometry, measured: { kind: 'observations2', dataset: 'drops', columns: ['t', 'h'], provenance: PROVENANCE, points: [] } } };
    expect(codes(() => validateKernelOutput(manifest, STATIC, forged))).toEqual(['WORKER_PROTOCOL $.geometry.measured']);
    const lying: typeof fallKernel = { ...fallKernel, evaluate: input => ({ ...fallKernel.evaluate(input), geometry: { ...fallKernel.evaluate(input).geometry, measured: forged.geometry.measured as GeometryResult } }) };
    expect(codes(() => evaluateRequest({ manifest, params: DEFAULTS, position: STATIC }, [lying]))[0]).toMatch(/^WORKER_ERROR/);
  });

  it('the main thread accepts the manifest observations from the worker and rejects an altered cell', async () => {
    const { manifest } = validateManifest(fallKernelManifest());
    const evaluator = createModelEvaluator(inlineWorkers([fallKernel]).factory);
    try {
      const data = await evaluator.evaluate({ manifest, params: DEFAULTS, position: STATIC });
      expect(measured(data.geometry).points).toEqual(EXPECTED_POINTS);
    } finally { evaluator.dispose(); }

    // A worker whose reply changes one observed cell (for example a worker that interpolated a missing height).
    const group = inlineWorkers([fallKernel]);
    const tampering = () => {
      const worker = group.factory() as unknown as { addEventListener(type: string, listener: (event: { data?: unknown }) => void): void };
      const original = worker.addEventListener.bind(worker);
      worker.addEventListener = (type, listener) => original(type, event => {
        const reply = event.data as { type?: string; data?: { geometry: Record<string, ObservationGeometry> } };
        if (type === 'message' && reply?.type === 'result') reply.data!.geometry.measured!.points[2]!.values[1] = 16.9;
        listener(event);
      });
      return worker as unknown as Worker;
    };
    const tampered = createModelEvaluator(tampering);
    try {
      const error = await tampered.evaluate({ manifest, params: DEFAULTS, position: STATIC }).then(() => null, failure => failure as ModelError);
      expect(error?.diagnostics.map(item => `${item.code} ${item.path}`)).toEqual(['WORKER_PROTOCOL $.geometry.measured']);
    } finally { tampered.dispose(); }
  });
});
