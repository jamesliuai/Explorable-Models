/**
 * Learner projection channels and host-facing outputs (report §5.3, §6.2, §7.3, §8.2, §8.4, §18, §19): capture
 * permission in the projection (G10), the separate developer-inspection entry (G11), restricted summaries that list
 * only parameters shown as controls (G12), presentation state filtered to visible content (G13), summary mode (G16),
 * host-facing recovery for every diagnostic code (G18), reserved presentation layers (G19), capabilities with stage
 * actions and unavailable entries (G22), numerical-limit status and playback end reason (G28), host-only diagnostics and
 * a redacted local export (G67), and preview coalescing under update bursts (Phase 4a F2). Fixture-host results with
 * in-process test workers.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BLOCKED_INSTRUCTION, createStudyHarnessAdapter, DIAGNOSTIC_CODES, EXPLORATORY_SUMMARY_SENTENCE, HOST_RECOVERY, PLAYBACK_LIMIT_NOTICE, projectLearnerView, templateRef, VALUE_STATUS_TEXT,
  type ActivityCatalog, type Diagnostic, type HostPolicy, type InteractionEvent, type Visibility,
} from '@experiment-kit/activity';
import { createInstalledCatalog, functionDerivativeManifest, functionDerivativeTemplate } from '@experiment-kit/catalog';
import { modelIdentity, type ModelFrame } from '@experiment-kit/core/model';
import {
  activityGuard, authorizeExploration, enterExplore, guards, harness, manifest, okOf, op, open, policyFor, presentationGuard, rectangleModel, rectangleTemplate, requestFor,
  settled, template, TEMPLATE, until, type Harness, type Opened,
} from './support/adapter-harness.js';

let current: Harness | null = null;
const make = (...args: Parameters<typeof harness>) => (current = harness(...args));
afterEach(() => { current?.adapter.dispose(); current = null; vi.restoreAllMocks(); });

const failed = (outcome: unknown): Diagnostic[] => {
  if ((outcome as { ok?: unknown })?.ok !== false) throw new Error('expected a failure');
  return (outcome as { diagnostics: Diagnostic[] }).diagnostics;
};
const CAPTURE = { learnerSnapshot: true, capture: true, backup: true };

describe('capture permission in the learner projection (G10)', () => {
  it('mirrors policy.export.capture and is withdrawn when the activity is revoked', async () => {
    const h = make({ policy: policyFor({ export: CAPTURE }) });
    const opened = await open(h);
    expect(opened.learner.getProjection().permissions).toEqual({ capture: true });
    okOf(await opened.control.updatePolicy({ operationId: op(), policy: h.host.amendPolicy({ export: { ...CAPTURE, capture: false } }) }));
    expect(opened.learner.getProjection().permissions).toEqual({ capture: false });
    okOf(await opened.control.updatePolicy({ operationId: op(), policy: h.host.amendPolicy({ export: CAPTURE }) }));
    expect(opened.learner.getProjection().permissions).toEqual({ capture: true });
    okOf(await opened.control.revoke({ operationId: op(), reason: 'Host revoked the activity.' }));
    expect(opened.learner.getProjection().permissions).toEqual({ capture: false });
  });

  it('is false under the default (capture-off) policy', async () => {
    const h = make();
    const opened = await open(h);
    expect(opened.learner.getProjection().permissions.capture).toBe(false);
  });
});

describe('developer inspection is a separate, policy-gated entry (report §6.2, G11)', () => {
  it('refuses unless the host policy enables inspection.developer', async () => {
    const h = make();
    await open(h);
    const refused = failed(h.adapter.inspectDeveloper('act-quadratic-1'));
    expect(refused).toMatchObject([{ code: 'POLICY_DENIED', path: '$.inspection.developer' }]);
    expect(refused[0]!.recovery).toMatch(/inspection\.developer/);
  });

  it('returns hidden quantities and visibility internals when enabled, and no learner, tutor or host binding reaches it', async () => {
    const h = make({ policy: policyFor({ inspection: { developer: true, tutor: 'learner-visible', teacher: true } }) });
    const opened = await open(h);
    await settled(h);
    const inspection = h.adapter.inspectDeveloper('act-quadratic-1');
    if ('ok' in inspection) throw new Error(JSON.stringify(inspection));
    // The predict stage hides the trace and the regime; the developer view lists every quantity and the visibility map.
    expect(opened.learner.getProjection().views.map(view => view.viewId)).not.toContain('trace-plot');
    expect(Object.keys(inspection.quantities)).toEqual(expect.arrayContaining(Object.keys(manifest.quantities)));
    expect(inspection.visibility.groups.trace).toBe('absent');
    expect(inspection.visibility.digests.trace).toMatch(/^sha256:/);
    expect(inspection.stage).toEqual({ id: 'predict', kind: 'predict' });
    expect(inspection.geometry.trace).toMatchObject({ kind: 'points2' });
    for (const binding of [opened.learner, opened.tutor, opened.prepared.binding('host', 'host-panel')]) {
      expect(Object.keys(binding)).not.toContain('inspectDeveloper');
      expect(JSON.stringify(binding.getProjection())).not.toContain('"regime"');
    }
    expect(Object.keys(opened.control)).not.toContain('inspectDeveloper');
    expect(failed(h.adapter.inspectDeveloper('act-other'))).toMatchObject([{ code: 'NOT_FOUND' }]);
  });
});

describe('restricted summaries list only parameters shown as controls (G12)', () => {
  const fdTemplate = templateRef(functionDerivativeTemplate);
  const fdModel = { modelId: functionDerivativeManifest.modelId, version: functionDerivativeManifest.version, digest: modelIdentity(functionDerivativeManifest).digest };
  const fdPolicy = (): HostPolicy => policyFor({
    approved: [{ template: fdTemplate, model: fdModel }], visibleGroups: functionDerivativeTemplate.groups.map(group => group.id),
    permittedControls: functionDerivativeTemplate.controls.map(control => control.parameter),
  });

  it('omits h (no control in the prepare stage) from learner and tutor summaries; teacher and host keep every value', async () => {
    const h = make({ policy: fdPolicy() });
    const opened = await open(h, requestFor({ activityId: 'act-fd-1', template: { templateId: functionDerivativeTemplate.templateId, version: functionDerivativeTemplate.version } }));
    await settled(h, 'act-fd-1');
    const controls = opened.learner.getProjection().controls.map(control => control.parameter).sort();
    expect(controls).not.toContain('h');
    okOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { A: 1.5 } }));
    await settled(h, 'act-fd-1');
    const committed = h.host.events('act-fd-1').filter(event => event.type === 'parameters.committed');
    expect(committed.every(event => JSON.stringify((event.payload as { visibleParameters?: string[] }).visibleParameters) === JSON.stringify(controls))).toBe(true);
    for (const audience of ['learner', 'tutor'] as const) {
      const summary = h.adapter.summarizeInteraction('act-fd-1', { audience });
      if ('ok' in summary) throw new Error(JSON.stringify(summary));
      for (const configuration of summary.committedConfigurations) expect(Object.keys(configuration.params).sort(), audience).toEqual(controls);
      expect(JSON.stringify(summary.committedConfigurations), audience).not.toContain('"h"');
    }
    for (const audience of ['teacher', 'host'] as const) {
      const summary = h.adapter.summarizeInteraction('act-fd-1', { audience });
      if ('ok' in summary) throw new Error(JSON.stringify(summary));
      expect(Object.keys(summary.committedConfigurations[0]!.params), audience).toContain('h');
    }
  });
});

describe('learner projection presentation is limited to visible content (G13)', () => {
  const HIDDEN_IN_TASK = ['trace-plot', 'trace-table', 'regime', 'multiplier', 'threshold'];

  it('drops cameras of hidden views and a hidden selection when the context becomes independent', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    okOf(opened.learner.setCamera({ operationId: op(), ...presentationGuard(opened.learner), viewId: 'trace-plot', camera: { kind: '2d', center: [10, 0], zoom: 2 } }));
    okOf(opened.learner.select({ operationId: op(), ...presentationGuard(opened.learner), target: 'trace-plot' }));
    expect(Object.keys(opened.learner.getProjection().presentation.views)).toContain('trace-plot');
    const policy = h.host.amendPolicy({ independentTask: { active: true, taskRef: 'task-1', permittedTools: ['inspect.learner'], neutralScaffold: ['landscape', 'start'] } });
    okOf(await opened.control.enterIndependentTask({ operationId: op(), taskRef: 'task-1', policy }));
    const projection = opened.learner.getProjection();
    expect(projection.views.map(view => view.viewId)).not.toContain('trace-plot');
    expect(Object.keys(projection.presentation.views)).not.toContain('trace-plot');
    expect(projection.presentation.selection).toBeNull();
    const json = JSON.stringify(projection);
    for (const id of HIDDEN_IN_TASK) expect(json, id).not.toContain(`"${id}"`);
  });

  it('clears the stored selection on revoke and on close (nothing visible remains to select)', async () => {
    for (const end of ['revoke', 'close'] as const) {
      const h = make();
      const opened = await open(h);
      await enterExplore(h, opened);
      okOf(opened.learner.select({ operationId: op(), ...presentationGuard(opened.learner), target: 'landscape' }));
      okOf(end === 'revoke' ? await opened.control.revoke({ operationId: op(), reason: 'Revoked.' }) : await opened.control.close({ operationId: op(), reason: 'Closed.' }));
      expect(opened.learner.getProjection().presentation.selection).toBeNull();
      const saved = await opened.control.save({ operationId: op(), kind: 'backup' });
      if (!saved.ok) throw new Error(JSON.stringify(saved.diagnostics));
      expect(saved.artifact.presentation.selection, end).toBeNull();
      h.adapter.dispose();
      current = null;
    }
  });
});

describe('summary mode and exploratory notice (G16)', () => {
  it('states exploratory mode in a field and a fixed sentence; approved summaries carry the mode without the sentence', async () => {
    const h = make({ policy: policyFor({ mode: 'exploratory', exploratory: { allowed: true, maxParametersOverride: 2 } }) });
    const opened = await open(h, requestFor({ mode: 'exploratory', parameters: { eta: 0.5 } }));
    await settled(h);
    const summary = h.adapter.summarizeInteraction('act-quadratic-1', { audience: 'tutor' });
    if ('ok' in summary) throw new Error(JSON.stringify(summary));
    expect(summary.mode).toBe('exploratory');
    expect(summary.reviewNotice).toBe(opened.learner.getProjection().reviewNotice);
    expect(summary.text).toContain(EXPLORATORY_SUMMARY_SENTENCE);

    const approved = make();
    const plain = await open(approved);
    await settled(approved);
    const other = approved.adapter.summarizeInteraction('act-quadratic-1', { audience: 'tutor' });
    if ('ok' in other) throw new Error(JSON.stringify(other));
    expect(other.mode).toBe('approved');
    expect(other.reviewNotice).toBe(plain.learner.getProjection().reviewNotice);
    expect(other.text).not.toContain('exploratory');
    h.adapter.dispose();
  });
});

describe('host-facing recovery for every diagnostic code (report §5.3, G18)', () => {
  it('defines a non-empty recovery for every code', () => {
    for (const code of DIAGNOSTIC_CODES) expect(HOST_RECOVERY[code], code).toMatch(/\w{3,}/);
  });

  it('every adapter and host-control failure carries a recovery', async () => {
    const h = make({ adapter: { maxWorkers: 2 } });
    const outcomes: { name: string; diagnostics: Diagnostic[] }[] = [];
    const add = (name: string, outcome: unknown) => outcomes.push({ name, diagnostics: failed(outcome) });
    add('prepare', await h.adapter.prepare(requestFor({ template: { templateId: 'no-such-template', version: '1.0.0' } }), { operationId: op() }));
    add('prepare.scenario', await h.adapter.prepare(requestFor({ scenarioId: 'no-such-scenario' }), { operationId: op() }));
    add('validate', await h.adapter.validate(requestFor({ parameters: { eta: 9 } })));
    add('restore', await h.adapter.restore({ contract: 'study-harness.activity-artifact', schemaVersion: '9.9' }, { operationId: op(), hostSessionRevision: 0 }));
    add('restore.revision', await h.adapter.restore({}, { operationId: op(), hostSessionRevision: -1 }));
    add('getState', h.adapter.getState('act-missing', 'host'));
    add('summarize', h.adapter.summarizeInteraction('act-missing', { audience: 'host' }));
    add('sample.missing', await h.adapter.sample({ activityId: 'act-missing', parameters: {}, positions: [], audience: 'host' }));
    add('getDiagnostics', h.adapter.getDiagnostics('act-missing'));
    add('exportDiagnostics', h.adapter.exportDiagnostics({ activityId: 'act-missing' }));
    add('inspectDeveloper', h.adapter.inspectDeveloper('act-missing'));
    const opened = await open(h);
    await settled(h);
    add('summarize.audience', h.adapter.summarizeInteraction('act-quadratic-1', { audience: 'parent' as never }));
    add('sample.constraint', await h.adapter.sample({ activityId: 'act-quadratic-1', parameters: { a: 3, eta: 2, x0: 1 }, positions: [{ kind: 'index', index: 0 }], audience: 'host' }));
    add('sample.audience', await h.adapter.sample({ activityId: 'act-quadratic-1', parameters: { a: 2, eta: 1, x0: 1 }, positions: [], audience: 'learner' as never }));
    const control = opened.control;
    const stale = { expectedActivityRevision: 99, expectedPolicyRevision: 1 };
    add('requestStageTransition', await control.requestStageTransition({ operationId: op(), ...activityGuard(opened.learner), toStage: 'no-such-stage' }));
    add('requestStageTransition.stale', await control.requestStageTransition({ operationId: op(), ...stale, toStage: 'explore-step' }));
    add('requestReveal', await control.requestReveal({ operationId: op(), ...activityGuard(opened.learner), groups: ['no-such-group'] }));
    add('requestExplorationScope', await control.requestExplorationScope({ operationId: op(), ...activityGuard(opened.learner), groups: ['trace'] }));
    add('submitResponseRef', await control.submitResponseRef({ operationId: op(), response: {}, expectedHostSessionRevision: 0, hostSessionRevision: 1 } as never));
    add('updateResponseRef', await control.updateResponseRef({ operationId: op(), responseId: 'resp-missing', status: 'disputed', expectedHostSessionRevision: 0, hostSessionRevision: 1 } as never));
    add('enterIndependentTask', await control.enterIndependentTask({ operationId: op(), taskRef: 'task-1', policy: {} as never }));
    add('reopenInstructional', await control.reopenInstructional({ operationId: op(), ...activityGuard(opened.learner) }));
    add('updatePolicy', await control.updatePolicy({ operationId: op(), policy: policyFor() }));
    add('suspend', control.suspend({ operationId: op(), reason: 'bored' as never }));
    add('save', await control.save({ operationId: op(), kind: 'export' as never }));
    add('forget', await control.forget({ operationId: op(), scope: 'everything' as never }));
    add('close', await control.close({ operationId: op(), reason: '' }));
    add('revoke', await control.revoke({ operationId: op(), reason: '' }));
    add('operationId', await control.close({ operationId: '' as string, reason: 'x' }));
    for (const { name, diagnostics } of outcomes) {
      expect(diagnostics.length, name).toBeGreaterThan(0);
      for (const item of diagnostics) expect(item.recovery ?? '', `${name}: ${item.code} ${item.path}`).toMatch(/\w{3,}/);
    }
  });
});

describe('presentation layers are reserved in 1.0 (G19, revisions.md)', () => {
  it('no binding command sets layers, and a restored snapshot never carries layers', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    expect(Object.keys(opened.learner).filter(key => /layer/i.test(key))).toEqual([]);
    okOf(opened.learner.setCamera({ operationId: op(), ...presentationGuard(opened.learner), viewId: 'landscape', camera: { kind: '2d', center: [1, 0], zoom: 1.5 } }));
    expect(opened.learner.getProjection().presentation.views.landscape).toEqual({ camera: { kind: '2d', center: [1, 0], zoom: 1.5 }, layers: [] });
  });
});

describe('capabilities report stage actions, transitions and unavailable entries (G22)', () => {
  it('lists the quadratic transitions and per-stage actions', () => {
    const h = make();
    const report = h.adapter.getCapabilities();
    const quadratic = report.templates.find(item => item.template.templateId === template.templateId)!;
    expect(quadratic.transitions).toEqual(template.transitions.map(({ id, from, to, label }) => ({ id, from, to, label })));
    expect(quadratic.stages.find(stage => stage.id === 'predict')).toEqual({
      id: 'predict', kind: 'predict', allowsPreview: false, allowsPlayback: false, allowsNavigation: false, controls: { eta: 'fixed', a: 'fixed', x0: 'fixed' }, response: 'prediction',
    });
    expect(quadratic.stages.find(stage => stage.id === 'explore-step')).toMatchObject({ allowsPreview: true, allowsPlayback: true, allowsNavigation: true, controls: { eta: 'interactive', a: 'fixed', x0: 'fixed' }, response: null });
    // Stage instructions and response prompts are template content and are not listed.
    expect(JSON.stringify(quadratic.stages)).not.toContain(template.stages[0]!.instruction.slice(0, 30));
    expect(report.unavailable).toEqual([]);
  });

  it('reports an installed template whose model digest does not match as unavailable, with the reason', () => {
    const base = make().catalog;
    const forged = { ...structuredClone(template), model: { ...template.model, digest: `sha256:${'f'.repeat(64)}` } };
    const catalog: ActivityCatalog = {
      ...base,
      listTemplates: () => base.listTemplates().map(entry => entry.template.templateId === template.templateId ? { ...entry, template: templateRef(forged) } : entry),
      getTemplate: ref => ref.templateId === template.templateId ? structuredClone(forged) : base.getTemplate(ref),
    };
    const adapter = createStudyHarnessAdapter({ catalog, host: current!.host });
    try {
      const report = adapter.getCapabilities();
      expect(report.templates.map(item => item.template.templateId)).not.toContain(template.templateId);
      expect(report.unavailable).toEqual([{ template: { templateId: template.templateId, version: template.version }, diagnostics: [expect.objectContaining({ code: 'INVALID_REFERENCE', path: '$.model.digest' })] }]);
      expect(report.unavailable[0]!.diagnostics[0]!.recovery).toBeTruthy();
    } finally { adapter.dispose(); }
  });
});

describe('numerical limits are named apart from undefined values (report §8.2, §8.4, G28)', () => {
  it('a drawn value beyond the representable range gets numerical-limit wording, not "not defined" (a = 10, η = 0.4, x₀ = 10 at n = 400)', async () => {
    const h = make();
    const opened = await open(h, requestFor({ parameters: { a: 10, eta: 0.4, x0: 10 } }));
    await enterExplore(h, opened);
    okOf(await opened.learner.navigate({ operationId: op(), ...guards(opened.learner), position: { kind: 'index', index: 400 } }));
    const status = opened.learner.getProjection().status;
    expect(status).toMatchObject({ ui: 'undefined', cause: 'numerical-limit', message: VALUE_STATUS_TEXT['numerical-limit'] });
    expect(status.message).not.toMatch(/not defined/);
  });

  it('classifies undefined, numerical-limit and mixed drawn values in the projection', () => {
    const groups: Record<string, Visibility> = Object.fromEntries(rectangleTemplate.groups.map(group => [group.id, 'fixed' as Visibility]));
    const frame = (diagonal: ModelFrame['quantities'][string], extra: ModelFrame['quantities'] = {}): ModelFrame => ({
      frameId: 'sha256:' + '1'.repeat(64), model: { modelId: rectangleModel.modelId, version: rectangleModel.version, digest: modelIdentity(rectangleModel).digest },
      run: { kind: 'committed', runId: 'run-1' }, params: { w: 3, h: 4 }, position: { kind: 'static' }, terminal: { reached: false },
      quantities: { perimeter: { status: 'valid', value: 14 }, slope: { status: 'valid', value: 1.3 }, shape: { status: 'valid', value: 'rectangle' }, scale: { status: 'valid', value: [1, 0, 0, 1] }, diagonal, ...extra },
      geometry: { outline: { kind: 'polygon2', vertices: [[0, 0], [3, 0], [3, 4], [0, 4]], degenerate: false }, corners: { kind: 'points2', points: [{ id: 'A', at: null, reason: 'Corner beyond range: the width exceeds the largest representable number.' }] } },
    });
    // A variant that also draws the first corner as a point mark, so a geometry gap is drawn next to the diagonal arrow.
    const withCorner: typeof rectangleTemplate = {
      ...rectangleTemplate,
      views: rectangleTemplate.views.map(view => view.id !== 'outline' ? view : {
        ...view, marks: [...view.marks, { id: 'corner-point', kind: 'point', group: 'outline-view', label: 'First corner', bindings: { geometry: 'corners' }, style: view.marks[0]!.style }],
      }),
    };
    const project = (input: ModelFrame, tpl = rectangleTemplate) => projectLearnerView({
      projectionId: 'p-1', activityId: 'act-1', activityRevision: 0, policyRevision: 1, template: tpl, manifest: rectangleModel, stage: tpl.stages[0]!,
      context: 'instructional', groups, controls: { w: 'interactive', h: 'interactive' }, frame: input, frameKind: 'committed', committedParams: { w: 3, h: 4 },
      guards: { expectedScientificVersion: 1, expectedRunId: 'run-1' }, preview: null, playing: false, activeScenarioId: null, comparisons: [],
      presentation: { contract: 'study-harness.presentation-snapshot', schemaVersion: '1.0', revision: 0, views: {}, selection: null, layout: 'auto', displayUnits: {}, locale: 'en', formatVersion: '1.0' },
      operational: { forced: null, persistence: 'saved', restored: false, closed: false }, reviewNotice: 'Test', pendingReveal: null,
    }).status;
    expect(project(frame({ status: 'undefined', code: 'NO_DIAGONAL', reason: 'No diagonal here.' }))).toMatchObject({ ui: 'undefined', cause: 'undefined', message: VALUE_STATUS_TEXT.undefined });
    expect(project(frame({ status: 'numerical-limit', code: 'OVERFLOW', reason: 'The diagonal exceeds the largest representable number.' }))).toMatchObject({ ui: 'undefined', cause: 'numerical-limit', message: VALUE_STATUS_TEXT['numerical-limit'] });
    // A geometry gap takes the status of the frame quantity whose reason it carries.
    const widthLimit = { width: { status: 'numerical-limit' as const, code: 'OVERFLOW' as const, reason: 'the width exceeds the largest representable number.' } };
    expect(project(frame({ status: 'undefined', code: 'NO_DIAGONAL', reason: 'No diagonal here.' }, widthLimit), withCorner)).toMatchObject({ ui: 'undefined', cause: 'mixed', message: VALUE_STATUS_TEXT.mixed });
    expect(project(frame({ status: 'valid', value: [3, 4] }, widthLimit), withCorner)).toMatchObject({ ui: 'undefined', cause: 'numerical-limit' });
    // An unmatched geometry gap counts as undefined.
    expect(project(frame({ status: 'valid', value: [3, 4] }), withCorner)).toMatchObject({ ui: 'undefined', cause: 'undefined' });
    expect(project(frame({ status: 'valid', value: [3, 4] }))).not.toHaveProperty('cause');
  });

  it('playback that stops one step before a numerical limit says so and journals playback.ended with reason numerical-limit (a = 2, η = 2, x₀ = 4 from n = 640)', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    okOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { eta: 2 } }));
    okOf(await opened.learner.navigate({ operationId: op(), ...guards(opened.learner), position: { kind: 'index', index: 640 } }));
    okOf(opened.learner.play({ operationId: op(), ...guards(opened.learner) }));
    await until(() => !opened.learner.getProjection().navigation?.playing, 30_000);
    await settled(h);
    const projection = opened.learner.getProjection();
    expect(projection.frame!.position).toMatchObject({ kind: 'index', index: 644 });
    expect(projection.frame!.terminal).toBe(false);
    expect(projection.status.message).toContain(PLAYBACK_LIMIT_NOTICE);
    expect(projection.status.message).not.toMatch(/not defined/);
    const ended = h.host.events().filter((event: InteractionEvent) => event.type === 'playback.ended');
    expect(ended.at(-1)!.payload).toMatchObject({ reason: 'numerical-limit', position: { kind: 'index', index: 644 } });
    // Stepping forward reaches the limit frame; the notice is cleared by the navigation.
    okOf(await opened.learner.step({ operationId: op(), ...guards(opened.learner), delta: 1 }));
    expect(opened.learner.getProjection().status.message ?? '').not.toContain(PLAYBACK_LIMIT_NOTICE);
  }, 60_000);
});

describe('preview bursts coalesce to the newest value (Phase 4a F2, report §18)', () => {
  async function burst(count: number) {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    await authorizeExploration(h, opened);
    const previewId = okOf(opened.learner.beginPreview({ operationId: op(), ...guards(opened.learner), gesture: 'pointer', parameter: 'eta' })).preview!.previewId;
    const values = Array.from({ length: count }, (_, index) => Number((0.002 * (index + 1)).toFixed(3)));
    // Synchronous burst: every update is accepted and none is refused or dropped.
    for (const eta of values) okOf(opened.learner.updatePreview({ operationId: op(), previewId, displayValues: { eta } }));
    const queued = h.adapter.getDiagnostics('act-quadratic-1');
    if ('ok' in queued) throw new Error('diagnostics');
    expect(queued.activities[0]!.preview).toMatchObject({ active: true, inFlight: 1, updates: count });
    expect(queued.activities[0]!.preview.queued).toBe(count > 1 ? 1 : 0);
    const newest = values.at(-1)!;
    await until(() => {
      const shown = opened.learner.getProjection();
      return shown.frame?.kind === 'tentative' && shown.controls.find(control => control.parameter === 'eta')!.previewValue === newest;
    }, 20_000);
    const settledState = h.adapter.getDiagnostics('act-quadratic-1');
    if ('ok' in settledState) throw new Error('diagnostics');
    expect(settledState.activities[0]!.preview).toMatchObject({ inFlight: 0, queued: 0, coalesced: Math.max(0, count - 2) });
    expect(settledState.activities[0]!.failures.filter(item => item.code === 'RESOURCE_LIMIT')).toEqual([]);
    okOf(await opened.learner.commitPreview({ operationId: op(), ...guards(opened.learner), previewId }));
    expect(opened.learner.getProjection().controls.find(control => control.parameter === 'eta')!.value).toBe(newest);
    return h;
  }
  for (const count of [64, 65, 500]) it(`paints the newest of ${count} synchronous updates and commits it`, async () => { await burst(count); }, 60_000);
});

describe('host-only diagnostics and a redacted local export (report §16, §19, G67)', () => {
  it('reflects a held evaluation and a queued preview, then the settled state', async () => {
    const h = make({ policy: policyFor({ export: CAPTURE }) });
    const opened = await open(h);
    await enterExplore(h, opened);
    await authorizeExploration(h, opened);
    const previewId = okOf(opened.learner.beginPreview({ operationId: op(), ...guards(opened.learner), gesture: 'keyboard', parameter: 'eta' })).preview!.previewId;
    h.workers.hold = true;
    okOf(opened.learner.updatePreview({ operationId: op(), previewId, displayValues: { eta: 0.5 } }));
    okOf(opened.learner.updatePreview({ operationId: op(), previewId, displayValues: { eta: 0.6 } }));
    okOf(opened.learner.updatePreview({ operationId: op(), previewId, displayValues: { eta: 0.7 } }));
    await until(() => h.workers.held.length > 0);
    const held = h.adapter.getDiagnostics();
    if ('ok' in held) throw new Error('diagnostics');
    const activity = held.activities.find(item => item.activityId === 'act-quadratic-1')!;
    expect(activity.preview).toEqual({ active: true, inFlight: 1, queued: 1, updates: 3, coalesced: 1 });
    expect(held.budget.leases).toEqual(expect.arrayContaining([{ ownerId: 'act-quadratic-1', purpose: 'scratch' }]));
    expect(held.budget.maxWorkers).toBeGreaterThan(0);
    h.workers.hold = false;
    h.workers.flush();
    await until(() => opened.learner.getProjection().controls.find(control => control.parameter === 'eta')!.previewValue === 0.7, 20_000);
    const after = h.adapter.getDiagnostics('act-quadratic-1');
    if ('ok' in after) throw new Error('diagnostics');
    expect(after.activities[0]!.preview).toMatchObject({ inFlight: 0, queued: 0 });
    expect(after.activities[0]!.evaluation.preview.count).toBeGreaterThanOrEqual(1);
    expect(after.activities[0]!.evaluation.commit.count).toBeGreaterThanOrEqual(0);
    expect(after.activities[0]!).toMatchObject({ persistence: expect.any(String), outbox: { limit: expect.any(Number) }, surfaces: { registered: 1, visible: 1 } });
  });

  it('exports identities, codes and timings only: no parameter values, hidden quantities or response text, and nothing is transmitted', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    // Distinctive values that must not appear in the export.
    okOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { eta: 0.7317 } }));
    failed(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { eta: 2.9871 } }));
    await settled(h);
    const exported = h.adapter.exportDiagnostics();
    if ('ok' in exported) throw new Error(JSON.stringify(exported));
    expect(exported).toMatchObject({ contract: 'study-harness.diagnostic-export', redacted: true, execution: { adapterVersion: expect.any(String), runtime: { id: expect.any(String) } } });
    expect(exported.diagnostics.activities[0]).toMatchObject({ template: TEMPLATE, scientificRevision: expect.stringMatching(/^sha256:/) });
    expect(exported.diagnostics.activities[0]!.failures).toEqual(expect.arrayContaining([expect.objectContaining({ operation: 'commitParameters', code: 'OUT_OF_DOMAIN', path: '$.parameters' })]));
    const text = JSON.stringify(exported);
    for (const secret of ['0.7317', '2.9871', ...Object.values(manifest.quantities).map(quantity => quantity.label)]) expect(text, secret).not.toContain(secret);
    for (const quantity of Object.keys(manifest.quantities)) expect(text, quantity).not.toContain(`"${quantity}"`);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('the diagnostics path contains no network or storage call', () => {
    for (const file of ['adapter.ts', 'controller.ts', 'archival.ts', 'describe.ts']) {
      const source = readFileSync(new URL(`../../packages/activity/src/${file}`, import.meta.url), 'utf8');
      expect(source, file).not.toMatch(/\bfetch\s*\(|sendBeacon|XMLHttpRequest|new WebSocket|EventSource|localStorage|indexedDB/);
    }
  });
});

it('keeps an activity opened through the harness typed (helper sanity)', async () => {
  const h = make();
  const opened: Opened = await open(h);
  expect(opened.learner.getProjection().activityId).toBe('act-quadratic-1');
});

describe('a blocked activity invites nothing and promises nothing (report §5.3, §10.4; S4)', () => {
  const expired = (h: Harness, revision: number): HostPolicy => ({ ...h.host.policy(), revision, issuedAt: '2026-10-26T08:00:00.000Z', expiresAt: '2026-10-26T08:30:00.000Z' });
  it('a stale policy withdraws the teaching instruction and the response prompt; a current policy brings them back', async () => {
    const h = make();
    const opened = await open(h);
    await settled(h);
    const before = opened.learner.getProjection();
    expect(before.stage).toMatchObject({ id: 'predict', kind: 'predict', response: { kind: 'prediction', prompt: template.stages.find(stage => stage.id === 'predict')!.response!.prompt } });
    okOf(await opened.control.updatePolicy({ operationId: op(), policy: expired(h, 2) }));
    const stale = opened.learner.getProjection();
    expect(stale.status.ui).toBe('stale-policy');
    expect(stale.stage).toEqual({ id: 'predict', kind: 'predict', instruction: BLOCKED_INSTRUCTION['stale-policy'] });
    expect(stale).toMatchObject({ views: [], controls: [], scenarios: [], navigation: null, pendingReveal: null });
    expect(JSON.stringify(stale)).not.toContain(before.stage.instruction);
    expect(JSON.stringify(stale)).not.toContain(before.stage.response!.prompt);
    // The tutor's learner-scoped view is the same projection.
    expect(opened.tutor.getProjection().stage).toEqual(stale.stage);
    okOf(await opened.control.updatePolicy({ operationId: op(), policy: { ...h.host.policy(), revision: 3, issuedAt: new Date(Date.UTC(2026, 9, 26, 10)).toISOString() } }));
    expect(opened.learner.getProjection().status.ui).not.toBe('stale-policy');
    expect(opened.learner.getProjection().stage).toEqual(before.stage);
  });

  it('a stale policy does not present a pending reveal', async () => {
    const h = make();
    const opened = await open(h, requestFor({ stageId: 'free-explore' }));
    await settled(h);
    h.host.failNext('recordExposureIntent', 'throw');
    expect(failed(await opened.control.requestReveal({ operationId: op(), ...activityGuard(opened.learner), groups: ['trace'] })).map(item => item.code)).toEqual(['PERSISTENCE_FAILED']);
    expect(opened.learner.getProjection().pendingReveal).toMatchObject({ state: 'failed' });
    okOf(await opened.control.updatePolicy({ operationId: op(), policy: expired(h, 2) }));
    expect(opened.learner.getProjection()).toMatchObject({ status: { ui: 'stale-policy' }, pendingReveal: null, navigation: null });
  });

  it('unsupported (revoked) content shows its own neutral instruction and no prompt', async () => {
    let revoked = false;
    const h = make({ customCatalog: workerFactory => {
      const base = createInstalledCatalog({ workerFactory });
      return { ...base, status: ref => revoked ? { lifecycle: 'revoked', reviews: [], revoked: true, revocationReason: 'Withdrawn.' } : base.status(ref) } satisfies ActivityCatalog;
    } });
    const opened = await open(h);
    await settled(h);
    expect(opened.learner.getProjection().stage.response).toBeDefined();
    revoked = true;
    failed(await opened.control.requestStageTransition({ operationId: op(), ...activityGuard(opened.learner), toStage: 'explore-step' }));
    await until(() => opened.learner.getProjection().status.ui === 'unsupported');
    expect(opened.learner.getProjection().stage).toEqual({ id: 'predict', kind: 'predict', instruction: BLOCKED_INSTRUCTION.unsupported });
    expect(opened.learner.getProjection()).toMatchObject({ views: [], controls: [], navigation: null, pendingReveal: null });
  });
});
