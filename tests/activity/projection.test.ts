/**
 * Learner projection (activity-runtime §3, report §6.2, §8.3, §10.4, A11, A13, A21 data side): one identified frame,
 * visibility by group, mark gating by bound data, equation substitution from visible quantities only, capped tables,
 * display units at the boundary, the digest contract and content-derived UI states.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { projectionDigest, projectLearnerView, type LearnerProjection, type Visibility } from '@explorable-models/activity';
import { modelIdentity, type ModelFrame } from '@explorable-models/core/model';
import {
  activityGuard, ackCurrent, authorizeExploration, codesOf, enterExplore, guards, harness, manifest, okOf, op, open, presentationGuard, rectangleCatalog,
  rectangleModel, rectanglePolicy, rectangleRequest, rectangleTemplate, requestFor, settled, template, until, type Harness,
} from './support/adapter-harness.js';

let current: Harness | null = null;
const make = (...args: Parameters<typeof harness>) => (current = harness(...args));
afterEach(() => { current?.adapter.dispose(); current = null; });

const valueIds = (projection: LearnerProjection) => projection.views.flatMap(view => view.values.map(value => value.quantityId));
const markIds = (projection: LearnerProjection) => projection.views.flatMap(view => view.marks.map(mark => mark.markId));
const viewIds = (projection: LearnerProjection) => projection.views.map(view => view.viewId);
const value = (projection: LearnerProjection, id: string) => projection.views.flatMap(view => view.values).find(item => item.quantityId === id);

describe('quadratic stages', () => {
  it('predict shows only the prediction groups; hidden quantities, marks, views and content are absent', async () => {
    const h = make();
    const { learner } = await open(h);
    const projection = learner.getProjection();
    expect(viewIds(projection).sort()).toEqual(['landscape', 'readouts', 'rules']);
    expect(markIds(projection).sort()).toEqual(['objective-curve', 'start-marker']);
    expect(valueIds(projection).sort()).toEqual(['start.loss', 'start.position']);
    expect(projection.views.find(view => view.viewId === 'rules')!.equations.map(item => item.equationId)).toEqual(['objective', 'update-rule']);
    expect(projection.controls.map(control => [control.parameter, control.mode])).toEqual([['eta', 'fixed'], ['a', 'fixed'], ['x0', 'fixed']]);
    expect(projection.controls.every(control => control.disabledReason)).toBe(true);
    expect(projection.navigation).toBeNull();
    expect(projection.scenarios.map(item => item.scenarioId)).toEqual(['step-0.25', 'step-0.75', 'step-1.25']);
    const text = JSON.stringify(projection);
    for (const hidden of ['Update multiplier', 'Step size times curvature', 'Largest convergent step size', 'Update rule with current values', 'Convergence condition', 'Current iterate', 'Position by iteration'])
      expect(text).not.toContain(hidden);
    for (const entry of template.content.filter(item => item.kind !== 'learner-copy')) expect(text).not.toContain(entry.text.slice(0, 40));
    expect(value(projection, 'start.position')).toMatchObject({ text: '4', status: 'valid', value: 4 });
    expect(projection.status.ui).toBe('ready');
  });

  it('a stage receipt reveals the trace and observations; groups of other stages stay absent', async () => {
    const h = make();
    const opened = await open(h);
    const revealed = await enterExplore(h, opened);
    expect(viewIds(revealed).sort()).toEqual(['landscape', 'readouts', 'rules', 'trace-plot', 'trace-table']);
    expect(valueIds(revealed)).toEqual(expect.arrayContaining(['index', 'position', 'loss', 'gradient', 'multiplier', 'product']));
    expect(valueIds(revealed)).not.toContain('regime');
    expect(valueIds(revealed)).not.toContain('threshold');
    expect(revealed.views.find(view => view.viewId === 'rules')!.equations.map(item => item.equationId)).toEqual(['objective', 'update-rule']);
    expect(markIds(revealed)).toEqual(expect.arrayContaining(['iterate-points', 'iterate-steps', 'current-iterate', 'trace-points']));
    expect(revealed.navigation).toMatchObject({ kind: 'index', value: 0, max: 1000, allowsPlayback: true });
    expect(revealed.controls.find(control => control.parameter === 'eta')!.mode).toBe('interactive');
    expect(revealed.controls.find(control => control.parameter === 'a')!.mode).toBe('fixed');
  });

  it('substitutes only visible quantities into equations and formats numerals from the frame', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    okOf(await opened.control.requestStageTransition({ operationId: op(), ...activityGuard(opened.learner), toStage: 'explore-curvature' }));
    const projection = opened.learner.getProjection();
    const substituted = projection.views.flatMap(view => view.equations).find(item => item.equationId === 'substituted-update')!;
    expect(substituted.plain).toBe('x_(n+1) = (1 − 0.5)·x_n = 0.5·x_n');
    expect(substituted.tex).toBe('x_{n+1} = (1 - 0.5)\\,x_{n} = 0.5\\,x_{n}');
    expect(JSON.stringify(projection)).not.toContain('{{q:');
    // The convergence condition substitutes the hidden threshold, so it is omitted rather than shown with a gap.
    expect(projection.views.flatMap(view => view.equations).map(item => item.equationId)).not.toContain('convergence-condition');
  });

  it('caps tables at 200 rows with the total count and keeps the first and last rows', async () => {
    const h = make();
    const opened = await open(h, requestFor({ parameters: { eta: 0 } }));
    await enterExplore(h, opened);
    okOf(await opened.learner.navigate({ operationId: op(), ...guards(opened.learner), position: { kind: 'index', index: 1000 } }));
    const table = opened.learner.getProjection().views.find(view => view.viewId === 'trace-table')!.table!;
    expect(table).toMatchObject({ truncated: true, totalRows: 1001 });
    expect(table.rows).toHaveLength(200);
    expect(table.rows[0]).toEqual({ key: 'n0', cells: ['0', '4'] });
    expect(table.rows.at(-1)).toEqual({ key: 'n1000', cells: ['1,000', '4'] });
    expect(table.columns.map(column => column.label)).toEqual(['Iteration n', 'Position x_n']);
    expect(opened.learner.getProjection().status.ui).toBe('boundary');
  });

  it('numerical limits stay statuses with reasons, never fabricated values', async () => {
    const h = make();
    const opened = await open(h, requestFor({ parameters: { eta: 2, a: 2 } }));
    await enterExplore(h, opened);
    okOf(await opened.learner.navigate({ operationId: op(), ...guards(opened.learner), position: { kind: 'index', index: 1000 } }));
    const projection = opened.learner.getProjection();
    const position = value(projection, 'position')!;
    expect(position.status).toBe('numerical-limit');
    expect(position).not.toHaveProperty('value');
    expect(position.text).toMatch(/^Beyond numerical range/);
    expect(position.reason).toEqual(expect.any(String));
    expect(projection.views.flatMap(view => view.marks).find(mark => mark.markId === 'current-iterate')).toMatchObject({ at: null, undefinedReason: expect.any(String) });
    expect(projection.frame).toMatchObject({ terminal: true, terminalDetail: expect.stringMatching(/numerical limit/) });
    expect(projection.status.ui).toBe('boundary');
    const rows = projection.views.find(view => view.viewId === 'trace-table')!.table!.rows;
    expect(rows.at(-1)!.cells[0]).toMatch(/^Not available/);
  });

  it('reports clipped geometry outside the authored bounds without rescaling', async () => {
    const h = make();
    const { learner } = await open(h, requestFor({ parameters: { a: 10 } }));
    const projection = learner.getProjection();
    expect(projection.status.ui).toBe('clipped');
    expect(projection.views.find(view => view.viewId === 'landscape')!.bounds).toEqual([-10, 10, -5, 105]);
  });

  it('uses one identified tentative frame for every value while previewing', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    await authorizeExploration(h, opened);
    const started = okOf(opened.learner.beginPreview({ operationId: op(), ...guards(opened.learner), gesture: 'pointer', parameter: 'eta' }));
    const previewId = started.preview!.previewId;
    okOf(opened.learner.updatePreview({ operationId: op(), previewId, displayValues: { eta: 0.75 } }));
    await until(() => opened.learner.getProjection().frame?.kind === 'tentative');
    const projection = opened.learner.getProjection();
    expect(projection.controls.find(control => control.parameter === 'eta')).toMatchObject({ value: 0.25, previewValue: 0.75 });
    expect(value(projection, 'product')!.value).toBe(1.5);
    expect(value(projection, 'multiplier')!.value).toBe(-0.5);
    expect(projection.status.ui).toBe('tentative-preview');
    expect(projection.guards).toEqual(started.guards);
    okOf(opened.learner.cancelPreview({ operationId: op(), previewId, reason: 'escape' }));
    expect(opened.learner.getProjection().frame?.kind).toBe('committed');
    expect(value(opened.learner.getProjection(), 'product')!.value).toBe(0.5);
  });
});

describe('digest and accessible text', () => {
  it('excludes projectionId, status.live and presentation.revision from the digest and nothing else', async () => {
    const h = make();
    const { learner } = await open(h);
    const projection = structuredClone(learner.getProjection()) as LearnerProjection;
    expect(projectionDigest(projection)).toBe(projection.projectionDigest);
    const same = { ...projection, projectionId: 'other', status: { ...projection.status, live: 'Announced.' }, presentation: { ...projection.presentation, revision: 99 } };
    expect(projectionDigest(same)).toBe(projection.projectionDigest);
    const views = structuredClone(projection.views);
    views[0]!.summary = `${views[0]!.summary} Changed accessible text.`;
    expect(projectionDigest({ ...projection, views })).not.toBe(projection.projectionDigest);
  });

  it('generates summaries and describeCurrentValues from the projection only', async () => {
    const h = make();
    const opened = await open(h);
    const text = opened.learner.describeCurrentValues();
    expect(text).toContain('Step size η: 0.25 (fixed).');
    expect(text).toContain('Starting position: 4.');
    expect(text).not.toContain('Position:');
    expect(text).not.toContain('multiplier');
    const summary = opened.learner.getProjection().views.find(view => view.viewId === 'readouts')!.summary;
    expect(summary).toBe('Values. Starting position: 4; Starting loss: 16.');
    await enterExplore(h, opened);
    expect(opened.learner.describeCurrentValues()).toContain('Position: 4.');
  });
});

describe('units, controls and mark gating (rectangle test template)', () => {
  const rectangle = () => make({ customCatalog: rectangleCatalog(), policy: rectanglePolicy() });

  it('shows controls in display units and converts exact entries to canonical units at the boundary', async () => {
    const h = rectangle();
    const opened = await open(h, rectangleRequest());
    const width = opened.learner.getProjection().controls.find(control => control.parameter === 'w')!;
    expect(width).toMatchObject({ value: 300, min: 0, max: 1000, step: 50, displayUnit: 'cm', unitLabel: 'cm', displayUnits: ['cm', 'm', 'mm'] });
    okOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { w: 250 } }));
    await settled(h);
    expect(h.host.events().at(-1)!.payload).toMatchObject({ params: { w: 2.5, h: 4 } });
    expect(value(opened.learner.getProjection(), 'perimeter')).toMatchObject({ value: 13, unit: 'm', text: '13' });
  });

  it('a display-unit change is presentation only: same run, index and version', async () => {
    const h = rectangle();
    const opened = await open(h, rectangleRequest());
    const before = opened.learner.getProjection();
    const after = okOf(opened.learner.setDisplayUnit({ operationId: op(), ...presentationGuard(opened.learner), parameter: 'w', unit: 'm' }));
    expect(after.guards).toEqual(before.guards);
    expect(after.presentationRevision).toBe(before.presentationRevision + 1);
    expect(after.controls.find(control => control.parameter === 'w')).toMatchObject({ value: 3, step: 0.5, displayUnit: 'm', max: 10 });
    expect(codesOf(opened.learner.setDisplayUnit({ operationId: op(), ...presentationGuard(opened.learner), parameter: 'w', unit: 's' }))).toEqual(['UNIT_MISMATCH']);
  });

  it('rejects invalid exact entries without coercing them into another experiment', async () => {
    const h = rectangle();
    const opened = await open(h, rectangleRequest());
    const run = guards(opened.learner).expectedRunId;
    expect(codesOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { w: 1200 } }))).toEqual(['OUT_OF_DOMAIN']);
    expect(codesOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { w: Number.NaN } }))).toEqual(['INVALID_INPUT']);
    expect(codesOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { depth: 1 } }))).toEqual(['INVALID_INPUT']);
    expect(codesOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { w: 900, h: 9 } }))).toEqual(['CONSTRAINT_VIOLATION']);
    expect(guards(opened.learner).expectedRunId).toBe(run);
  });

  it('omits a mark whose bound quantity is solution-bearing and not granted, and shows it after a reveal', async () => {
    const h = rectangle();
    const opened = await open(h, rectangleRequest());
    let projection = opened.learner.getProjection();
    expect(markIds(projection).sort()).toEqual(['corner-points', 'outline-shape']);
    expect(valueIds(projection).sort()).toEqual(['perimeter', 'slope']);
    expect(viewIds(projection)).not.toContain('rule');
    expect(JSON.stringify(projection)).not.toContain('HIDDEN-DERIVATION');
    await settled(h);
    projection = okOf(await opened.control.requestReveal({ operationId: op(), ...activityGuard(opened.learner), groups: ['diagonal-group', 'perimeter-rule'] }));
    expect(projection.pendingReveal).toEqual({ labels: ['Diagonal', 'Perimeter rule'], state: 'awaiting-display' });
    const arrow = projection.views.flatMap(view => view.marks).find(mark => mark.markId === 'diagonal-arrow')!;
    expect(arrow.vector).toEqual([3, 4]);
    expect(projection.views.find(view => view.viewId === 'rule')!.equations[0]!.plain).toBe('P = 14');
    expect(valueIds(projection)).not.toContain('shape');
    await settled(h);
    ackCurrent(opened.learner);
    await settled(h);
    expect(opened.learner.getProjection().pendingReveal).toBeNull();
  });

  it('marks undefined values with reasons; only a drawn mark without a value raises the undefined UI state (direct projection)', () => {
    const groups: Record<string, Visibility> = Object.fromEntries(rectangleTemplate.groups.map(group => [group.id, group.solutionBearing ? 'absent' : 'fixed']));
    const frame: ModelFrame = {
      frameId: 'sha256:' + '0'.repeat(64), model: { modelId: rectangleModel.modelId, version: rectangleModel.version, digest: modelIdentity(rectangleModel).digest },
      run: { kind: 'committed', runId: 'run-1' }, params: { w: 0, h: 4 }, position: { kind: 'static' }, terminal: { reached: false },
      quantities: {
        perimeter: { status: 'valid', value: 8 }, diagonal: { status: 'valid', value: [0, 4] }, scale: { status: 'valid', value: [0, 0, 0, 4] },
        slope: { status: 'undefined', code: 'ZERO_WIDTH', reason: 'The slope of a zero-width rectangle is undefined.' }, shape: { status: 'valid', value: 'degenerate' },
      },
      geometry: { outline: { kind: 'polygon2', vertices: [[0, 0], [0, 0], [0, 4], [0, 4]], degenerate: true }, corners: { kind: 'points2', points: [{ id: 'A', at: [0, 0] }] }, edges: { kind: 'segments2', segments: [] }, field: { kind: 'vector-field2', samples: [], scale: { factor: 1, disclosure: 'Unit scale.' } }, grid: { kind: 'surface-grid', xs: [0, 1], ys: [0, 1], z: [0, 0, 0, 0], sampling: { nx: 2, ny: 2, domain: [0, 1, 0, 1] } } },
    };
    const input: Parameters<typeof projectLearnerView>[0] = {
      projectionId: 'p-1', activityId: 'act-1', activityRevision: 0, policyRevision: 1, template: rectangleTemplate, manifest: rectangleModel, stage: rectangleTemplate.stages[0]!,
      context: 'instructional', groups, controls: { w: 'interactive', h: 'interactive' }, frame, frameKind: 'committed', committedParams: { w: 0, h: 4 },
      guards: { expectedScientificVersion: 1, expectedRunId: 'run-1' }, preview: null, playing: false, activeScenarioId: null, comparisons: [],
      presentation: { contract: 'study-harness.presentation-snapshot', schemaVersion: '1.0', revision: 0, views: {}, selection: null, layout: 'auto', displayUnits: {}, locale: 'en', formatVersion: '1.0' },
      operational: { forced: null, persistence: 'saved', restored: false, closed: false }, reviewNotice: 'Test', pendingReveal: null,
    };
    const projection = projectLearnerView(input);
    const slope = value(projection, 'slope')!;
    expect(slope).toMatchObject({ status: 'undefined', reason: 'The slope of a zero-width rectangle is undefined.' });
    expect(slope).not.toHaveProperty('value');
    expect(slope.text).not.toBe('0');
    // The slope appears only in readouts and tables: it is shown inline with its reason and does not raise the
    // undefined state, because nothing drawn depends on it (report §10.4 rule for conditional values).
    expect(projection.status.ui).toBe('ready');
    expect(projection.views.find(view => view.viewId === 'measures-table')!.table!.rows.find(row => row.key === 'slope')!.cells[1]).toMatch(/^Undefined/);
    // A drawn mark whose bound quantity has no value does raise it, with the reason on the mark.
    const drawn = projectLearnerView({
      ...input, groups: { ...groups, 'diagonal-group': 'fixed' },
      frame: { ...frame, quantities: { ...frame.quantities, diagonal: { status: 'undefined', code: 'NO_DIAGONAL', reason: 'No diagonal without a width.' } } },
    });
    expect(drawn.views.flatMap(view => view.marks).find(mark => mark.markId === 'diagonal-arrow')).toMatchObject({ vector: null, undefinedReason: 'No diagonal without a width.' });
    expect(drawn.status.ui).toBe('undefined');
  });
});

it('the projection never carries quantities of the manifest that no group lists', () => {
  const listed = new Set(template.groups.filter(group => group.kind === 'quantity').flatMap(group => group.members));
  expect(Object.keys(manifest.quantities).filter(id => !listed.has(id))).toEqual([]);
});
