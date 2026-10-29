/**
 * Independent context and assistance (report §6.4, activity-runtime §7, A25, A26): entering an independent task
 * removes instructional output, cancels previews, pauses playback and discards late reveal receipts; help and
 * reopening go through `HostPort.recordAssistance` before any display change; frozen assistance snapshots never change.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { artifactIntegrity, createStudyHarnessAdapter, verifyArtifact, type ActivityArtifact, type HostPolicy } from '@explorable-models/activity';
import {
  ackCurrent, activityGuard, authorizeExploration, codesOf, enterExplore, guards, harness, okOf, op, open, policyFor, requestFor, settled, type Harness, type Opened,
} from './support/adapter-harness.js';
import { MemoryHost } from './support/memory-host.js';

let current: Harness | null = null;
const make = (...args: Parameters<typeof harness>) => (current = harness(...args));
afterEach(() => { current?.adapter.dispose(); current = null; });

const viewIds = (opened: Opened) => opened.learner.getProjection().views.map(view => view.viewId).sort();
function independentPolicy(h: Harness, patch: Partial<HostPolicy['independentTask']> = {}): HostPolicy {
  return h.host.amendPolicy({ independentTask: { active: true, taskRef: 'task-new-curvature', permittedTools: ['inspect.learner'], neutralScaffold: ['landscape', 'start'], ...patch } });
}
/**
 * The host ends the independent task in its policy before it reopens instructional work: a host following the refusal
 * convention grants instructional content only under a policy that permits it (the `conformant` profile refuses it
 * while its policy still names an active independent task).
 */
async function endIndependentTask(h: Harness, opened: Opened): Promise<void> {
  const instructional = h.host.amendPolicy({ independentTask: { active: false, taskRef: null, permittedTools: [], neutralScaffold: [] } });
  okOf(await opened.control.updatePolicy({ operationId: op(), policy: instructional }));
}

describe('independent task context (A25)', () => {
  it('removes instructional output, keeps only the neutral scaffold and cancels the preview and playback', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    await authorizeExploration(h, opened);
    const previewId = okOf(opened.learner.beginPreview({ operationId: op(), ...guards(opened.learner), gesture: 'keyboard', parameter: 'eta' })).preview!.previewId;
    okOf(opened.learner.updatePreview({ operationId: op(), previewId, displayValues: { eta: 0.4 } }));
    const policy = independentPolicy(h);
    const projection = okOf(await opened.control.enterIndependentTask({ operationId: op(), taskRef: 'task-new-curvature', policy }));
    expect(projection.context).toBe('independent');
    expect(viewIds(opened)).toEqual(['landscape', 'readouts']);
    expect(projection.views.flatMap(view => view.values).map(value => value.quantityId).sort()).toEqual(['start.loss', 'start.position']);
    expect(projection.views.flatMap(view => view.marks).map(mark => mark.markId).sort()).toEqual(['objective-curve', 'start-marker']);
    expect(projection.controls).toEqual([]);
    expect(projection.preview).toBeNull();
    expect(projection.frame?.kind).toBe('committed');
    await settled(h);
    const events = h.host.events();
    expect(events.find(event => event.type === 'preview.cancelled')!.payload).toEqual({ previewId, reason: 'navigation' });
    expect(events.at(-1)!).toMatchObject({ type: 'context.independent-entered', payload: { taskRef: 'task-new-curvature', policyRevision: policy.revision } });
    expect(opened.prepared.instance.context).toEqual({ kind: 'independent', taskRef: 'task-new-curvature' });
  });

  it('invalidates a pending reveal: the late receipt is discarded and nothing is shown', async () => {
    const h = make();
    const opened = await open(h, requestFor({ stageId: 'free-explore' }));
    await settled(h);
    h.host.delay('recordExposureIntent', 20);
    const reveal = opened.control.requestReveal({ operationId: op(), ...activityGuard(opened.learner), groups: ['trace', 'regime'] });
    await new Promise(resolve => setTimeout(resolve, 2));
    expect(opened.learner.getProjection().pendingReveal?.state).toBe('requesting');
    const policy = independentPolicy(h, { neutralScaffold: ['landscape', 'start', 'trace'] });
    okOf(await opened.control.enterIndependentTask({ operationId: op(), taskRef: 'task-new-curvature', policy }));
    const outcome = await reveal;
    expect(outcome.ok).toBe(false);
    const projection = opened.learner.getProjection();
    expect(projection.pendingReveal).toBeNull();
    expect(viewIds(opened)).not.toContain('trace-plot');
    const exposures = (h.adapter.getState('act-quadratic-1', 'host') as { exposures: unknown[] }).exposures;
    expect(exposures).toEqual([]);
  });

  it('marks an authorized but unacknowledged reveal uncertain instead of unseen', async () => {
    const h = make();
    const opened = await open(h);
    await settled(h);
    okOf(await opened.control.requestStageTransition({ operationId: op(), ...activityGuard(opened.learner), toStage: 'explore-step' }));
    await settled(h);
    okOf(await opened.control.enterIndependentTask({ operationId: op(), taskRef: 'task-new-curvature', policy: independentPolicy(h) }));
    const [record] = (h.adapter.getState('act-quadratic-1', 'host') as { exposures: { displayStatus: string; uncertainty?: { code: string } }[] }).exposures;
    expect(record).toMatchObject({ displayStatus: 'uncertain', uncertainty: { code: 'SURFACE_LOST' } });
  });

  it('restricts tutor tools to the independent permitted set', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    okOf(await opened.control.enterIndependentTask({ operationId: op(), taskRef: 'task-new-curvature', policy: independentPolicy(h, { neutralScaffold: ['landscape', 'start', 'step-control'] }) }));
    expect(codesOf(await opened.tutor.navigate({ operationId: op(), ...guards(opened.tutor), position: { kind: 'index', index: 1 } }))).toEqual(['POLICY_DENIED']);
    expect(codesOf(await opened.control.requestStageTransition({ operationId: op(), ...activityGuard(opened.learner), toStage: 'explore-curvature' }))).toEqual(['INDEPENDENT_CONTEXT']);
  });
});

describe('assistance goes through the host first (A26)', () => {
  it('help is recorded by the host before anything changes', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    const before = opened.learner.getProjection();
    h.host.failNext('recordAssistance', 'throw');
    expect(codesOf(await opened.learner.requestHelp({ operationId: op('help'), ...activityGuard(opened.learner) }))).toEqual(['PERSISTENCE_FAILED']);
    expect(opened.learner.getProjection().activityRevision).toBe(before.activityRevision);
    expect(opened.learner.getProjection().views).toEqual(before.views);
    const projection = okOf(await opened.learner.retryPersistence({ operationId: op() }));
    expect(projection.activityRevision).toBe(h.host.activity('act-quadratic-1')!.activityRevision);
    await settled(h);
    const types = h.host.events().map(event => event.type);
    expect(types.filter(type => type === 'help.requested')).toHaveLength(1);
    expect(types.filter(type => type === 'assistance.recorded')).toHaveLength(1);
    expect(h.host.calls('recordAssistance').map(call => call.outcome)).toEqual(['failed', 'ok']);
  });

  it('reopening the instructional visual records assistance, then shows it; a frozen snapshot is never rewritten', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    okOf(await opened.control.enterIndependentTask({ operationId: op(), taskRef: 'task-new-curvature', policy: independentPolicy(h) }));
    okOf(await opened.control.submitResponseRef({ operationId: op(), expectedHostSessionRevision: 0, hostSessionRevision: 1, response: { responseId: 'answer-1', taskId: 'task-new-curvature', taskRevision: 1, kind: 'answer', modality: 'numeric', stageId: 'explore-step' } }));
    const frozen = opened.control.freezeAssistanceSnapshot({ responseId: 'answer-1' });
    const copy = structuredClone(frozen);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(frozen.assistance).toEqual([]);
    await settled(h);
    const calls = h.host.calls('recordAssistance').length;
    await endIndependentTask(h, opened);
    const reopened = okOf(await opened.control.reopenInstructional({ operationId: op(), ...activityGuard(opened.learner) }));
    expect(h.host.calls('recordAssistance')).toHaveLength(calls + 1);
    expect((h.host.calls('recordAssistance').at(-1)!.request as { kind: string; groups: { groupId: string }[] })).toMatchObject({ kind: 'reopen-instructional', groups: [{ groupId: 'trace' }, { groupId: 'observations' }] });
    expect(reopened.context).toBe('instructional');
    expect(reopened.pendingReveal?.state).toBe('awaiting-display');
    expect(reopened.views.map(view => view.viewId)).toContain('trace-plot');
    await settled(h);
    ackCurrent(opened.learner);
    okOf(await opened.learner.requestHelp({ operationId: op(), ...activityGuard(opened.learner) }));
    await settled(h);
    expect(opened.control.freezeAssistanceSnapshot({ responseId: 'answer-1' })).toBe(frozen);
    expect(frozen).toEqual(copy);
    const later = opened.control.freezeAssistanceSnapshot({ responseId: 'answer-2' });
    expect(later.assistance.map(item => item.kind)).toEqual(['reopen-instructional', 'help']);
    expect(later.cursor).toBeGreaterThan(frozen.cursor);
    const types = h.host.events().map(event => event.type);
    expect(types.indexOf('assistance.recorded')).toBeLessThan(types.indexOf('context.instructional-reopened'));
    expect(policyFor().independentTask.active).toBe(false);
  });
});

describe('assistance history survives save and restore (A19, A26)', () => {
  /** Help, then independent work, then a reopen with a grant; returns the backup saved afterwards. */
  async function assistedBackup(h: Harness, opened: Opened): Promise<ActivityArtifact> {
    await enterExplore(h, opened);
    okOf(await opened.learner.requestHelp({ operationId: op('help'), ...activityGuard(opened.learner) }));
    okOf(await opened.control.enterIndependentTask({ operationId: op(), taskRef: 'task-new-curvature', policy: independentPolicy(h) }));
    await endIndependentTask(h, opened);
    okOf(await opened.control.reopenInstructional({ operationId: op(), ...activityGuard(opened.learner) }));
    await settled(h);
    ackCurrent(opened.learner);
    await settled(h);
    const saved = await opened.control.save({ operationId: op('save'), kind: 'backup' });
    if (!saved.ok) throw new Error(JSON.stringify(saved.diagnostics));
    await settled(h);
    return saved.artifact;
  }

  it('a backup lists every assistance receipt with its journal sequence and grant summary; a learner snapshot lists none', async () => {
    const h = make();
    const opened = await open(h);
    const artifact = await assistedBackup(h, opened);
    const receipts = h.host.receipts().filter(receipt => receipt.contract === 'study-harness.assistance-receipt');
    expect(receipts.map(receipt => receipt.kind)).toEqual(['help', 'reopen-instructional']);
    const reopenGrant = receipts[1]!.grant!;
    expect(artifact.assistance).toEqual([
      { receiptId: receipts[0]!.receiptId, kind: 'help', sequence: expect.any(Number), grant: null },
      { receiptId: receipts[1]!.receiptId, kind: 'reopen-instructional', sequence: expect.any(Number), grant: { exposureId: reopenGrant.exposureId, groups: reopenGrant.groups.map(group => group.groupId) } },
    ]);
    // Each reference names the host-journaled assistance.recorded event of its receipt.
    for (const ref of artifact.assistance!) {
      expect(h.host.events().find(event => event.sequence === ref.sequence)).toMatchObject({ type: 'assistance.recorded', payload: { receiptId: ref.receiptId, kind: ref.kind } });
    }
    expect(artifact.exposures.find(record => record.exposureId === reopenGrant.exposureId)?.receiptId).toBe(receipts[1]!.receiptId);
    expect(artifact.integrity.entries.map(entry => entry.path)).toContain('assistance');
    const snapshot = await opened.control.save({ operationId: op('save'), kind: 'learner-snapshot' });
    if (!snapshot.ok) throw new Error(JSON.stringify(snapshot.diagnostics));
    expect(snapshot.artifact).not.toHaveProperty('assistance');
  });

  it('after a restore, frozen snapshots still list the assistance recorded before the save, and later assistance is added', async () => {
    const h = make();
    const opened = await open(h);
    const artifact = await assistedBackup(h, opened);
    h.adapter.dispose('act-quadratic-1');
    // Fresh process over the host's durable tables.
    const host = h.host.restoreInto(new MemoryHost({ policy: h.host.policy() }));
    const adapter = createStudyHarnessAdapter({ catalog: h.catalog, host });
    try {
      const restored = await adapter.restore(JSON.stringify(artifact), { operationId: op('restore'), hostSessionRevision: 0 });
      if (!restored.ok) throw new Error(JSON.stringify(restored.diagnostics));
      const control = restored.prepared.host;
      const atRestore = control.freezeAssistanceSnapshot({ responseId: 'answer-after-restore' });
      expect(atRestore.assistance).toEqual(artifact.assistance);
      expect(atRestore.assistance.every(item => item.sequence <= atRestore.cursor)).toBe(true);
      const learner = restored.prepared.binding('learner', 'surface-main');
      learner.registerSurface('surface-main');
      okOf(await learner.requestHelp({ operationId: op('help'), ...activityGuard(learner) }));
      const later = control.freezeAssistanceSnapshot({ responseId: 'answer-later' });
      expect(later.assistance.map(item => item.kind)).toEqual(['help', 'reopen-instructional', 'help']);
      expect(later.assistance.slice(0, 2)).toEqual(artifact.assistance);
      // The snapshot frozen at restore time never changes, and a second backup carries all three references.
      expect(control.freezeAssistanceSnapshot({ responseId: 'answer-after-restore' }).assistance).toHaveLength(2);
      const again = await control.save({ operationId: op('save'), kind: 'backup' });
      if (!again.ok) throw new Error(JSON.stringify(again.diagnostics));
      expect(again.artifact.assistance?.map(item => item.receiptId)).toEqual(later.assistance.map(item => item.receiptId));
    } finally { adapter.dispose(); }
  });

  it('refuses an artifact whose grant summary does not match the exposure its receipt created', async () => {
    const h = make();
    const opened = await open(h);
    const artifact = await assistedBackup(h, opened);
    const tampered = structuredClone(artifact);
    tampered.assistance![1]!.grant!.groups = ['trace'];
    const { integrity: _integrity, ...body } = tampered;
    const verified = verifyArtifact({ ...body, integrity: artifactIntegrity(body) });
    expect(verified.ok ? [] : verified.diagnostics.map(item => `${item.code} ${item.path}`)).toEqual(['INVALID_REFERENCE $.assistance[1].grant']);
    const duplicated = { ...body, assistance: [artifact.assistance![0]!, artifact.assistance![0]!] };
    const twice = verifyArtifact({ ...duplicated, integrity: artifactIntegrity(duplicated) });
    expect(twice.ok ? [] : twice.diagnostics.map(item => item.code)).toEqual(['DUPLICATE_ID']);
  });
});
