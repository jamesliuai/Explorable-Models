/**
 * Observed data beside a model prediction through the real adapter, controller, projection and model worker protocol
 * (report §8.5, A13, A21, A34): template validation keeps observations unconnected, the learner projection labels
 * observed and model output in every learner channel, missing cells stay missing with their reasons, provenance reaches
 * the learner, and stage visibility hides the prediction until the template shows it. Example content and the memory
 * host double: fixture-host results only.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  groupContentDigest, templateRef, templateWarnings, validateRecord, validateTemplateSemantics,
  type ActivityCatalog, type ActivityTemplate, type CatalogEntryStatus, type HostPolicy, type LearnerProjection, type MarkSpec,
} from '@experiment-kit/activity';
import { modelIdentity, type ModelManifest, type ObservationGeometry } from '@experiment-kit/core/model';
import { fallingBallManifest as manifest, fallingBallTemplate as template, OBSERVED_TEMPLATE_ID, RECORDED_DROPS } from '../../examples/study-harness-observed/content';
import { activityGuard, guards, harness, okOf, op, open, policyFor, requestFor, settled, type Harness } from './support/adapter-harness';

const MODEL = { modelId: manifest.modelId, version: manifest.version, digest: modelIdentity(manifest).digest };
const ACTIVITY = 'act-observed-1';
let current: Harness | null = null;
afterEach(() => { current?.adapter.dispose(); current = null; });

function catalog(served: ActivityTemplate = template): (createWorker: () => Worker) => ActivityCatalog {
  return createWorker => {
    const ref = templateRef(served);
    const status = (): CatalogEntryStatus => ({ lifecycle: 'validated', reviews: [], revoked: false });
    return {
      listTemplates: () => [{ template: ref, model: MODEL, title: served.title, dimension: '2d', status: status() }],
      getTemplate: request => request.templateId === served.templateId && request.version === served.version ? structuredClone(served) : null,
      getModel: request => request.modelId === manifest.modelId && request.version === manifest.version ? structuredClone(manifest) : null,
      status, createWorker,
    };
  };
}
const policy = (patch: Partial<HostPolicy> = {}): HostPolicy => policyFor({
  approved: [{ template: templateRef(template), model: MODEL }], visibleGroups: template.groups.map(group => group.id), permittedControls: ['h0', 'g'], ...patch,
});
async function openObserved() {
  current = harness({ customCatalog: catalog(), policy: policy() });
  const opened = await open(current, requestFor({ activityId: ACTIVITY, template: { templateId: OBSERVED_TEMPLATE_ID, version: template.version } }));
  await settled(current, ACTIVITY);
  return opened;
}
const view = (projection: LearnerProjection, id: string) => projection.views.find(item => item.viewId === id);
const mark = (projection: LearnerProjection, id: string) => projection.views.flatMap(item => item.marks).find(item => item.markId === id);
const withMark = (kind: MarkSpec['kind'], viewKind: 'plot2d' | 'scene3d' = 'plot2d'): ActivityTemplate => {
  const edited = structuredClone(template);
  edited.views[0]!.marks[0]!.kind = kind;
  edited.views[0]!.kind = viewKind;
  return edited;
};

describe('observed-data template validation (§8.5)', () => {
  it('the example template is valid, with observations drawn by a points mark only', () => {
    expect(validateRecord('study-harness.activity-template', template).diagnostics).toEqual([]);
    expect(validateTemplateSemantics(template, manifest)).toEqual([]);
    expect(templateWarnings(template, manifest)).toEqual([]);
  });

  it('rejects a curve, trace or region over observed data: no line is drawn through observations without a model', () => {
    for (const kind of ['curve', 'trace', 'segments'] as const) {
      const problems = validateTemplateSemantics(withMark(kind), manifest).filter(item => item.path === '$.views[0].marks[0].bindings.geometry');
      expect(problems.map(item => item.code), kind).toEqual(['KIND_MISMATCH']);
      expect(problems[0]!.message, kind).toMatch(/drawn only as separate points; a \w+ mark would join, interpolate or fit them/);
      expect(problems[0]!.recovery, kind).toMatch(/bind any curve to a model series/);
    }
    // The model curve over the model's own series stays valid: an explicit model series is the only way to draw a line.
    expect(validateTemplateSemantics(template, manifest).filter(item => item.path.startsWith('$.views[0].marks[1]'))).toEqual([]);
    // Observations are 2D data; a 3D view cannot draw them.
    const spatial = validateTemplateSemantics({ ...withMark('points', 'scene3d'), dimension: '3d', views: withMark('points', 'scene3d').views.map((item, index) => index === 0 ? { ...item, bounds3: [0, 2, 0, 2, 0, 2] } : item) }, manifest);
    expect(spatial.some(item => item.path === '$.views[0].marks[0].bindings.geometry' && item.code === 'KIND_MISMATCH')).toBe(true);
  });

  it('a changed cell changes the model identity and the content digest of the group showing it', () => {
    const edited: ModelManifest = structuredClone(manifest);
    edited.observations!.drops!.rows[1]![1] = 19.8;
    (edited.execution as unknown as { document: { datasets: { drops: { rows: (number | null)[][] } } } }).document.datasets.drops.rows[1]![1] = 19.8;
    expect(modelIdentity(edited).scientificRevision).not.toBe(modelIdentity(manifest).scientificRevision);
    expect(groupContentDigest(template, edited, 'recorded-data')).not.toBe(groupContentDigest(template, manifest, 'recorded-data'));
    expect(groupContentDigest(template, edited, 'model-prediction')).toBe(groupContentDigest(template, manifest, 'model-prediction'));
  });
});

describe('observed data through the adapter and learner projection (§8.5, A13, A21)', () => {
  it('shows the recorded heights as labelled observations with missing cells and provenance, and no model output', async () => {
    const opened = await openObserved();
    const projection = opened.learner.getProjection();
    expect(projection.stage.id).toBe('observe');
    const points = mark(projection, 'recorded-points')!;
    expect(points).toMatchObject({ kind: 'points', label: 'Recorded heights (observed)', origin: 'observed' });
    const geometry = points.geometry as ObservationGeometry;
    expect(geometry.kind).toBe('observations2');
    expect(geometry.points.map(point => point.values)).toEqual(RECORDED_DROPS.rows);
    expect(geometry.points.filter(point => point.reason).map(point => [point.row, point.reason])).toEqual([
      [3, 'The ball was hidden behind the stand in this frame.'], [7, 'Motion blur: no height could be read in this frame.'], [8, 'The frame timestamp was not recorded.'],
    ]);
    expect(geometry.provenance).toEqual({ sourceId: 'example-drop-log', citation: manifest.sources[1]!.citation, description: RECORDED_DROPS.provenance.description, license: 'MIT (this repository)' });

    const table = view(projection, 'recorded-table')!.table!;
    expect(table.origin).toBe('observed');
    expect(table.columns).toEqual([
      { id: 'observation', label: 'Observation', unitLabel: '' }, { id: 'observed-t', label: 'Time (observed)', unitLabel: 's' }, { id: 'observed-h', label: 'Height (observed)', unitLabel: 'm' },
    ]);
    expect(table.rows).toHaveLength(RECORDED_DROPS.rows.length);
    expect(table.rows[3]!.cells).toEqual(['4', '0.6', 'Missing: The ball was hidden behind the stand in this frame.']);
    expect(table.rows[8]!.cells).toEqual(['9', 'Missing: The frame timestamp was not recorded.', '7.49']);
    expect(table.rows.flatMap(row => row.cells.slice(1)).filter(cell => cell === '0')).toEqual(['0']); // only the real t = 0 reading
    expect(table.source).toBe(`Observed data. Source: ${manifest.sources[1]!.citation} ${RECORDED_DROPS.provenance.description} Licence: MIT (this repository).`);
    expect(view(projection, 'fall-plot')!.summary).toContain('Recorded heights (observed): 11 observations, 3 with a missing value (not drawn), drawn as separate points');
    // Missing observations are data facts shown with reasons, not undefined model values.
    expect(projection.status.ui).not.toBe('undefined');

    // Disclosure: the stage shows no model output in any learner channel.
    const text = JSON.stringify(projection) + opened.learner.describeCurrentValues();
    for (const hidden of ['Predicted height', 'Landing time', 'prediction-curve', 'prediction-table', '(model)']) expect(text, hidden).not.toContain(hidden);
    expect(projection.controls).toEqual([]);
  });

  it('after the host shows the model, labels the prediction as model output and keeps observations fixed across runs', async () => {
    const opened = await openObserved();
    const before = mark(opened.learner.getProjection(), 'recorded-points')!.geometry;
    okOf(await opened.control.requestStageTransition({ operationId: op('stage'), ...activityGuard(opened.learner), toStage: 'compare' }));
    await settled(current!, ACTIVITY);
    let projection = opened.learner.getProjection();
    expect(projection.stage.id).toBe('compare');
    expect(mark(projection, 'prediction-curve')).toMatchObject({ kind: 'curve', label: 'Predicted height (model)', origin: 'model', geometry: { kind: 'polyline2', sampling: { samples: 101, domain: [0, 1] } } });
    expect(mark(projection, 'recorded-points')).toMatchObject({ label: 'Recorded heights (observed)', origin: 'observed' });
    expect(view(projection, 'model-readout')!.values).toEqual([expect.objectContaining({ label: 'Landing time (model)', origin: 'model', status: 'valid', unitLabel: 's' })]);
    const predicted = view(projection, 'prediction-table')!.table!;
    expect(predicted).toMatchObject({ origin: 'model', totalRows: 101 });
    expect(predicted.columns.map(column => column.label)).toEqual(['Time t (model)', 'Height h (model)']);
    expect(predicted.source).toBeUndefined();
    expect(view(projection, 'fall-plot')!.summary).toMatch(/Recorded heights \(observed\): 11 observations.*; Predicted height \(model\)\./);

    // A parameter commit starts a new run: the prediction changes, the observations do not.
    const prediction = mark(projection, 'prediction-curve')!.geometry;
    okOf(await opened.learner.commitParameters({ operationId: op('commit'), ...guards(opened.learner), displayValues: { g: 1.6 } }));
    await settled(current!, ACTIVITY);
    projection = opened.learner.getProjection();
    expect(mark(projection, 'prediction-curve')!.geometry).not.toEqual(prediction);
    expect(mark(projection, 'recorded-points')!.geometry).toEqual(before);
  });

  it('isolated sampling returns the observations with the same provenance as the learner frame', async () => {
    const opened = await openObserved();
    const sampled = await current!.adapter.sample({ activityId: ACTIVITY, parameters: { h0: 25, g: 9.8 }, positions: [{ kind: 'static' }], audience: 'host' });
    expect(sampled.ok).toBe(true);
    if (!sampled.ok) return;
    const frame = sampled.frames[0] as { geometry: Record<string, ObservationGeometry> };
    expect(frame.geometry.measured).toEqual(mark(opened.learner.getProjection(), 'recorded-points')!.geometry);
  });
});
