/**
 * Save and restore (report §14, activity-runtime §9, A48, A49): a backup restores the exact scientific state, content
 * identity, permitted presentation and journal checkpoint in a fresh process; revoked or missing content is never
 * substituted; a more restrictive current policy restricts the restore; corrupted artifacts are refused; a pending
 * preview is saved separately and never becomes the experiment; restore starts paused and re-emits no reveals.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { artifactIntegrity, createStudyHarnessAdapter, type ActivityArtifact, type ExposureRecord, type HostPort, type StudyHarnessAdapter } from '@explorable-models/activity';
import { createInstalledCatalog } from '@explorable-models/catalog';
import {
  activityGuard, authorizeExploration, codesOf, enterExplore, expectValidEvents, guards, harness, okOf, op, open, policyFor, presentationGuard, settled, template, until,
  type Harness, type Opened,
} from './support/adapter-harness.js';
import { MemoryHost } from './support/memory-host.js';

let disposers: (() => void)[] = [];
const make = (...args: Parameters<typeof harness>) => { const h = harness(...args); disposers.push(() => h.adapter.dispose()); return h; };
afterEach(() => { for (const dispose of disposers) dispose(); disposers = []; });

async function backup(opened: Opened): Promise<ActivityArtifact> {
  const saved = await opened.control.save({ operationId: op('save'), kind: 'backup' });
  if (!saved.ok) throw new Error(JSON.stringify(saved.diagnostics));
  return saved.artifact;
}
/** Fresh process: a new host loaded from the durable tables and a new adapter over the same installed catalogue. */
function freshProcess(h: Harness, options: { policy?: ReturnType<typeof policyFor>; catalog?: Parameters<typeof createInstalledCatalog>[0] } = {}): { host: MemoryHost; adapter: StudyHarnessAdapter } {
  const host = h.host.restoreInto(new MemoryHost({ policy: h.host.policy() }));
  if (options.policy) host.setPolicy(options.policy);
  const catalog = options.catalog ? createInstalledCatalog({ ...options.catalog, workerFactory: h.workers.factory }) : h.catalog;
  const adapter = createStudyHarnessAdapter({ catalog, host });
  disposers.push(() => adapter.dispose());
  return { host, adapter };
}
/**
 * Restore input naming host session revision 5, which the host's own response transactions produced first: a host that
 * follows the HostPort convention refuses a registration claiming a revision it never produced (`conformant` profile).
 */
const restoreInput = (host: MemoryHost) => {
  while (host.hostSessionRevision('act-quadratic-1') < 5) host.respond('act-quadratic-1');
  return { operationId: op('restore'), hostSessionRevision: 5 };
};

describe('exact restore in a fresh process (A48)', () => {
  it('restores science, content identity, presentation, exposures and the journal checkpoint, paused', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    okOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { eta: 0.5 } }));
    okOf(await opened.learner.navigate({ operationId: op(), ...guards(opened.learner), position: { kind: 'index', index: 3 } }));
    okOf(opened.learner.retainComparison({ operationId: op(), ...guards(opened.learner), label: 'Half step' }));
    okOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { eta: 0.75 } }));
    okOf(await opened.learner.navigate({ operationId: op(), ...guards(opened.learner), position: { kind: 'index', index: 5 } }));
    okOf(opened.learner.setCamera({ operationId: op(), ...presentationGuard(opened.learner), viewId: 'landscape', camera: { kind: '2d', center: [1, 10], zoom: 1.5 } }));
    okOf(opened.learner.setLayout({ operationId: op(), ...presentationGuard(opened.learner), layout: 'side' }));
    okOf(await opened.control.submitResponseRef({ operationId: op(), expectedHostSessionRevision: 0, hostSessionRevision: 1, response: { responseId: 'resp-1', taskId: 'task-1', taskRevision: 1, kind: 'prediction', modality: 'text', stageId: 'predict' } }));
    okOf(opened.learner.play({ operationId: op(), ...guards(opened.learner) }));
    await settled(h);
    const artifact = await backup(opened);
    expect(artifact.scientific.params).toEqual({ a: 2, eta: 0.75, x0: 4 });
    await settled(h);
    okOf(opened.learner.pause({ operationId: op(), ...guards(opened.learner) }));
    await settled(h);
    const savedEvents = h.host.events().length;
    const fresh = freshProcess(h);
    const result = await fresh.adapter.restore(JSON.stringify(artifact), restoreInput(fresh.host));
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    expect(result.report.restored).toBe('exact');
    const learner = result.prepared.binding('learner', 'surface-2');
    const projection = learner.getProjection();
    expect(projection.status.ui).toBe('restored');
    expect(projection.navigation?.playing).toBe(false);
    expect(projection.frame?.position).toEqual(artifact.scientific.position);
    expect(projection.stage.id).toBe('explore-step');
    expect(projection.activityRevision).toBe(artifact.instance.activityRevision);
    expect(projection.presentation).toMatchObject({ layout: 'side', views: { landscape: { camera: { kind: '2d', center: [1, 10], zoom: 1.5 } } } });
    expect(projection.comparisons).toEqual([expect.objectContaining({ label: 'Half step', parameterDifferences: [expect.objectContaining({ parameter: 'eta', text: '0.5' })] })]);
    const state = fresh.adapter.getState('act-quadratic-1', 'host') as { instance: typeof artifact.instance; scientific: { params: Record<string, number>; restoredFrom?: string }; exposures: ExposureRecord[] };
    expect(state.scientific.params).toEqual(artifact.scientific.params);
    expect(state.scientific.restoredFrom).toBe(artifact.scientific.runId);
    expect(state.instance.template).toEqual(artifact.template);
    expect(state.instance.responses).toEqual(artifact.instance.responses);
    expect(state.instance.hostSessionRevision).toBe(5);
    expect(state.exposures.map(record => [record.exposureId, record.displayStatus])).toEqual(artifact.exposures.map(record => [record.exposureId, record.displayStatus]));
    await until(() => fresh.host.events().length > savedEvents);
    const events = fresh.host.events();
    expectValidEvents(events);
    expect(events.slice(savedEvents).map(event => event.type)).toEqual(['artifact.restored']);
    expect(events.at(-1)!.payload).toMatchObject({ artifactId: artifact.artifactId, kind: 'backup', restored: 'exact' });
    // The restored activity continues normally under fresh guards.
    okOf(await learner.step({ operationId: op(), ...guards(learner), delta: 1 }));
    expect(learner.getProjection().status.ui).not.toBe('restored');
  });

  it('saves a pending preview separately: the committed checkpoint is the experiment and the preview stays active', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    await authorizeExploration(h, opened);
    const previewId = okOf(opened.learner.beginPreview({ operationId: op(), ...guards(opened.learner), gesture: 'keyboard', parameter: 'eta' })).preview!.previewId;
    okOf(opened.learner.updatePreview({ operationId: op(), previewId, displayValues: { eta: 1.5 } }));
    const artifact = await backup(opened);
    expect(artifact.scientific.params.eta).toBe(0.25);
    expect(artifact.pending).toMatchObject({ kind: 'preview', previewId, params: { eta: 1.5 }, baseRunId: artifact.scientific.runId });
    expect(opened.learner.getProjection().preview?.previewId).toBe(previewId);
    okOf(opened.learner.cancelPreview({ operationId: op(), previewId, reason: 'escape' }));
    await settled(h);
    h.adapter.dispose('act-quadratic-1');
    const result = await h.adapter.restore(artifact, restoreInput(h.host));
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    const restored = result.prepared.binding('learner', 's').getProjection();
    expect(restored.preview).toBeNull();
    expect(restored.controls.find(control => control.parameter === 'eta')!.value).toBe(0.25);
  });
});

describe('recoverability without substitution (A49)', () => {
  const saved = async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    const artifact = await backup(opened);
    await settled(h);
    return { h, opened, artifact };
  };

  it('refuses revoked content with a read-only recovery option', async () => {
    const { h, artifact } = await saved();
    const fresh = freshProcess(h, { catalog: { revocations: [{ kind: 'model', id: 'quadratic-gradient-descent', version: '1.0.0', reason: 'Withdrawn after review.' }] } });
    const result = await fresh.adapter.restore(artifact, restoreInput(fresh.host));
    expect(codesOf(result as never)).toEqual(['CONTENT_REVOKED']);
    expect(result.ok ? '' : result.diagnostics[0]!.recovery).toMatch(/read-only/);
  });

  it('never substitutes a missing or different template or model', async () => {
    const { h, artifact } = await saved();
    const missing = createStudyHarnessAdapter({ catalog: { ...h.catalog, getModel: () => null }, host: h.host });
    disposers.push(() => missing.dispose());
    h.adapter.dispose('act-quadratic-1');
    const noModel = await missing.restore(artifact, restoreInput(h.host));
    expect(codesOf(noModel as never)).toEqual(['UNSUPPORTED_ARTIFACT']);
    expect(noModel.ok ? '' : noModel.diagnostics[0]!.recovery).toMatch(/read-only|No other model/);
    const edited = structuredClone(template);
    edited.title = 'Step size in gradient descent (edited)';
    const different = createStudyHarnessAdapter({ catalog: { ...h.catalog, getTemplate: () => structuredClone(edited) }, host: h.host });
    disposers.push(() => different.dispose());
    expect(codesOf(await different.restore(artifact, restoreInput(h.host)) as never)).toEqual(['UNSUPPORTED_ARTIFACT']);
  });

  it('applies a more restrictive current policy and reports the restriction', async () => {
    const { h, artifact } = await saved();
    const restrictive = { ...h.host.policy(), revision: 2, visibleGroups: template.groups.map(group => group.id).filter(id => id !== 'observations') };
    const fresh = freshProcess(h, { policy: restrictive });
    const result = await fresh.adapter.restore(artifact, restoreInput(fresh.host));
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    expect(result.report.restored).toBe('restricted');
    expect(result.report.notes.join(' ')).toMatch(/current host policy/);
    const values = result.prepared.binding('learner', 's').getProjection().views.flatMap(view => view.values).map(item => item.quantityId);
    expect(values).not.toContain('position');
    expect(values).toContain('start.position');
  });

  it('takes the context from the current policy, never from the artifact', async () => {
    const { h, artifact } = await saved();
    const { integrity: _integrity, ...body } = structuredClone(artifact);
    const claimed = { ...body, instance: { ...body.instance, context: { kind: 'independent' as const, taskRef: 'task-claimed' } } };
    const forged: ActivityArtifact = { ...claimed, integrity: artifactIntegrity(claimed) };
    h.adapter.dispose('act-quadratic-1');
    const result = await h.adapter.restore(forged, restoreInput(h.host));
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    expect(result.prepared.instance.context).toEqual({ kind: 'instructional' });
    expect(result.report.restored).toBe('restricted');
    // Exposure history from the artifact is kept: supported work is not turned into independent work.
    expect((h.adapter.getState('act-quadratic-1', 'host') as { exposures: ExposureRecord[] }).exposures).toHaveLength(artifact.exposures.length);
  });

  it('refuses corrupted, truncated and tampered artifacts', async () => {
    const { h, artifact } = await saved();
    h.adapter.dispose('act-quadratic-1');
    const text = JSON.stringify(artifact);
    expect(codesOf(await h.adapter.restore(text.slice(0, text.length - 10), restoreInput(h.host)) as never)).toEqual(['INTEGRITY_FAILURE']);
    const tampered = structuredClone(artifact);
    tampered.scientific.params.eta = 0.5;
    expect(codesOf(await h.adapter.restore(tampered, restoreInput(h.host)) as never)).toContain('INTEGRITY_FAILURE');
    expect(codesOf(await h.adapter.restore({ ...artifact, schemaVersion: '7.0' }, restoreInput(h.host)) as never)).toEqual(['UNSUPPORTED_ARTIFACT']);
  });

  it('does not restore a learner snapshot as an activity', async () => {
    const h = make();
    const opened = await open(h);
    await settled(h);
    const snapshot = await opened.control.save({ operationId: op(), kind: 'learner-snapshot' });
    if (!snapshot.ok) throw new Error(JSON.stringify(snapshot.diagnostics));
    h.adapter.dispose('act-quadratic-1');
    expect(codesOf(await h.adapter.restore(snapshot.artifact, restoreInput(h.host)) as never)).toEqual(['UNSUPPORTED_ARTIFACT']);
  });

  it('dispose during restore resolves into DISPOSED and leaves nothing open', async () => {
    const { h, artifact } = await saved();
    h.adapter.dispose('act-quadratic-1');
    h.host.delay('registerActivity', 5);
    const pending = h.adapter.restore(artifact, restoreInput(h.host));
    await new Promise(resolve => setTimeout(resolve, 1));
    h.adapter.dispose();
    expect((await pending).ok).toBe(false);
    expect('diagnostics' in h.adapter.getState('act-quadratic-1', 'host')).toBe(true);
  });
});

const ACTIVITY = 'act-quadratic-1';
const hostView = (adapter: StudyHarnessAdapter) => adapter.getState(ACTIVITY, 'host') as { exposures: ExposureRecord[]; scientific: { params: Record<string, number>; position: unknown } };

describe('restoring an earlier checkpoint never erases host-held history (report §6.3, §6.4; G02)', () => {
  it('merges the host-held displayed exposure and assistance into the restored ledger and frozen snapshots, without making content visible', async () => {
    const h = make();
    const opened = await open(h);
    await settled(h);
    const artifact = await backup(opened);
    expect(artifact.exposures).toEqual([]);
    // After the checkpoint: a stage reveal displayed and acknowledged at the host, and a help request.
    await enterExplore(h, opened);
    okOf(await opened.learner.requestHelp({ operationId: op('help'), ...activityGuard(opened.learner) }));
    await settled(h);
    const held = h.host.exposures(ACTIVITY);
    expect(held).toEqual([expect.objectContaining({ displayStatus: 'displayed' })]);
    const help = h.host.receipts(ACTIVITY).find(receipt => receipt.contract === 'study-harness.assistance-receipt')!;
    const helpEvent = h.host.events(ACTIVITY).find(event => event.type === 'assistance.recorded')!;
    const fresh = freshProcess(h);
    const result = await fresh.adapter.restore(artifact, restoreInput(fresh.host));
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    expect(hostView(fresh.adapter).exposures).toEqual([expect.objectContaining({ exposureId: held[0]!.exposureId, displayStatus: 'displayed', displayed: held[0]!.displayed })]);
    const notes = result.report.notes.join(' ');
    expect(notes).toMatch(/1 exposure records came from the host's records and not from the artifact/);
    expect(notes).toMatch(/1 assistance records came from the host's records and not from the artifact/);
    const frozen = result.prepared.host.freezeAssistanceSnapshot({ responseId: 'answer-after-restore' });
    expect(frozen.exposures.map(record => [record.exposureId, record.displayStatus])).toEqual([[held[0]!.exposureId, 'displayed']]);
    expect(frozen.assistance).toEqual([{ receiptId: help.receiptId, kind: 'help', sequence: helpEvent.sequence, grant: null }]);
    expect(frozen).toMatchObject({ complete: true, limitations: [] });
    // Host-held history is not a grant: the restored predict stage still shows no trace, and nothing is resent.
    expect(result.prepared.binding('learner', 'surface-2').getProjection().views.map(view => view.viewId)).not.toContain('trace-plot');
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(fresh.host.calls('recordDisplayAck')).toEqual([]);
    // Every later backup keeps the merged records.
    const again = await result.prepared.host.save({ operationId: op('save'), kind: 'backup' });
    if (!again.ok) throw new Error(JSON.stringify(again.diagnostics));
    expect(again.artifact.exposures.map(record => record.exposureId)).toEqual([held[0]!.exposureId]);
    expect(again.artifact.assistance?.map(item => item.receiptId)).toEqual([help.receiptId]);
  });

  it('an authorized host record without an acknowledgement is merged as uncertain (potentially seen), never as unseen or visible', async () => {
    const h = make();
    const opened = await open(h);
    await settled(h);
    const artifact = await backup(opened);
    okOf(await opened.control.requestStageTransition({ operationId: op('stage'), ...activityGuard(opened.learner), toStage: 'explore-step' }));
    await settled(h);
    expect(h.host.exposures(ACTIVITY)).toEqual([expect.objectContaining({ displayStatus: 'authorized' })]);
    const fresh = freshProcess(h);
    const result = await fresh.adapter.restore(artifact, restoreInput(fresh.host));
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    expect(hostView(fresh.adapter).exposures).toEqual([expect.objectContaining({ displayStatus: 'uncertain', uncertainty: expect.objectContaining({ code: 'INTERRUPTED_BEFORE_ACK' }) })]);
  });

  it('a host without the read still restores, says so and freezes snapshots marked incomplete', async () => {
    const h = make();
    const opened = await open(h);
    await settled(h);
    const artifact = await backup(opened);
    await enterExplore(h, opened);
    const restarted = h.host.restoreInto(new MemoryHost({ policy: h.host.policy() }));
    const port: HostPort = {
      getPolicy: request => restarted.getPolicy(request), registerActivity: request => restarted.registerActivity(request), requestStageTransition: request => restarted.requestStageTransition(request),
      recordExposureIntent: request => restarted.recordExposureIntent(request), recordDisplayAck: request => restarted.recordDisplayAck(request), recordAssistance: request => restarted.recordAssistance(request),
      appendEvents: request => restarted.appendEvents(request), getJournalCursor: request => restarted.getJournalCursor(request), saveArtifact: request => restarted.saveArtifact(request),
    };
    const adapter = createStudyHarnessAdapter({ catalog: h.catalog, host: port });
    disposers.push(() => adapter.dispose());
    const result = await adapter.restore(artifact, restoreInput(restarted));
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    expect(result.report.notes.join(' ')).toMatch(/does not provide its exposure and assistance records/);
    const frozen = result.prepared.host.freezeAssistanceSnapshot({ responseId: 'answer-1' });
    expect(frozen.complete).toBe(false);
    expect(frozen.limitations.join(' ')).toMatch(/known only from the host/);
  });
});

describe('a saved independent lineage restricts the restore (report §6.4, A19, A26; G03)', () => {
  it('keeps instructional content hidden after a restore into instructional work until reopenInstructional records assistance', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    const independent = h.host.amendPolicy({ independentTask: { active: true, taskRef: 'task-new-curvature', permittedTools: ['inspect.learner'], neutralScaffold: ['landscape', 'start'] } });
    okOf(await opened.control.enterIndependentTask({ operationId: op(), taskRef: 'task-new-curvature', policy: independent }));
    await settled(h);
    const artifact = await backup(opened);
    expect(artifact.lineage).toEqual({ endedExposureIds: [artifact.exposures[0]!.exposureId], reopenRequired: true });
    await settled(h);
    // The host's current policy has no active independent task.
    const instructional = { ...h.host.policy(), revision: h.host.policy().revision + 1, independentTask: { active: false, taskRef: null, permittedTools: [], neutralScaffold: [] } };
    const fresh = freshProcess(h, { policy: instructional });
    const result = await fresh.adapter.restore(artifact, restoreInput(fresh.host));
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    expect(result.report.restored).toBe('restricted');
    expect(result.prepared.instance.context).toEqual({ kind: 'instructional' });
    expect(result.report.notes.join(' ')).toMatch(/instructional content stays hidden until the host reopens instructional work/);
    const learner = result.prepared.binding('learner', 'surface-2');
    learner.registerSurface('surface-2');
    const views = () => learner.getProjection().views.map(view => view.viewId);
    expect(views()).not.toContain('trace-plot');
    expect(views()).not.toContain('trace-table');
    // Neither a reveal nor a stage transition can bypass the reopening.
    expect(codesOf(await result.prepared.host.requestReveal({ operationId: op(), ...activityGuard(learner), groups: ['trace'] }))).toEqual(['INDEPENDENT_CONTEXT']);
    expect(codesOf(await result.prepared.host.requestStageTransition({ operationId: op(), ...activityGuard(learner), toStage: 'explore-curvature' }))).toEqual(['INDEPENDENT_CONTEXT']);
    expect(fresh.host.calls('recordAssistance')).toHaveLength(0);
    // A backup taken while the reopening is pending keeps the restriction.
    const pendingBackup = await result.prepared.host.save({ operationId: op('save'), kind: 'backup' });
    if (!pendingBackup.ok) throw new Error(JSON.stringify(pendingBackup.diagnostics));
    expect(pendingBackup.artifact.lineage).toMatchObject({ reopenRequired: true });
    okOf(await result.prepared.host.reopenInstructional({ operationId: op(), ...activityGuard(learner) }));
    expect(fresh.host.calls('recordAssistance')).toHaveLength(1);
    expect(views()).toContain('trace-plot');
    await until(() => fresh.host.events(ACTIVITY).some(event => event.type === 'context.instructional-reopened'));
    const types = fresh.host.events(ACTIVITY).map(event => event.type);
    expect(types.indexOf('assistance.recorded')).toBeGreaterThan(-1);
    expect(types.indexOf('assistance.recorded')).toBeLessThan(types.indexOf('context.instructional-reopened'));
  });

  it('a backup saved without independent work restores every grant into instructional work unchanged', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    const artifact = await backup(opened);
    expect(artifact.lineage).toBeUndefined();
    const fresh = freshProcess(h);
    const result = await fresh.adapter.restore(artifact, restoreInput(fresh.host));
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    expect(result.prepared.binding('learner', 's').getProjection().views.map(view => view.viewId)).toContain('trace-plot');
  });
});

describe('presentation restore cannot widen visibility (A38; G71)', () => {
  it('neutralizes forged cameras, layers, selection, units and views; science is unchanged; a control the policy no longer permits stays non-interactive', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    okOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { eta: 0.5 } }));
    okOf(await opened.learner.navigate({ operationId: op(), ...guards(opened.learner), position: { kind: 'index', index: 4 } }));
    const artifact = await backup(opened);
    await settled(h);
    const { integrity: _integrity, ...body } = structuredClone(artifact);
    const forgedBody: Omit<ActivityArtifact, 'integrity'> = {
      ...body,
      presentation: {
        // The selection names the step-size control, which the current policy no longer permits (a permitted selection is
        // kept: report §14 "the permitted presentation", R30).
        ...body.presentation, revision: 9, selection: 'eta', displayUnits: { eta: 'deg' },
        views: {
          landscape: { camera: { kind: '3d', projection: 'perspective', position: [1, 2, 3], target: [0, 0, 0], up: [0, 0, 1], preset: null }, layers: ['g-secret'] },
          'unknown-view': { camera: { kind: '2d', center: [0, 0], zoom: 2 }, layers: [] },
        },
      },
    };
    const forged: ActivityArtifact = { ...forgedBody, integrity: artifactIntegrity(forgedBody) };
    const restrictive = { ...h.host.policy(), revision: h.host.policy().revision + 1, permittedControls: template.controls.map(control => control.parameter).filter(parameter => parameter !== 'eta') };
    const fresh = freshProcess(h, { policy: restrictive });
    const result = await fresh.adapter.restore(forged, restoreInput(fresh.host));
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    expect(result.report.restored).toBe('restricted');
    expect(result.report.notes.join(' ')).toMatch(/Presentation state was restricted to the current views, units and visible content/);
    const learner = result.prepared.binding('learner', 'surface-2');
    const projection = learner.getProjection();
    expect(projection.presentation.views.landscape).toEqual({ camera: null, layers: [] });
    expect(projection.presentation.views).not.toHaveProperty('unknown-view');
    expect(projection.presentation.selection).toBeNull();
    expect(projection.presentation.displayUnits).not.toHaveProperty('eta');
    expect(projection.controls.find(control => control.parameter === 'eta')?.mode ?? 'absent').not.toBe('interactive');
    const state = hostView(fresh.adapter);
    expect(state.scientific.params).toEqual(artifact.scientific.params);
    expect(state.scientific.position).toEqual(artifact.scientific.position);
    expect(codesOf(await learner.commitParameters({ operationId: op(), ...guards(learner), displayValues: { eta: 0.75 } }))).toEqual(['POLICY_DENIED']);
  });
});
