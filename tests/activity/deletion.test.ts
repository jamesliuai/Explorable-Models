/**
 * Correction, revision, dispute and deletion (report §7.2, A18) and the permanence of exposure (§9, A19). Derived
 * records — summaries and artifacts — become stale through stable references (response ID, status, task revision,
 * supersession, journal cursor) without the original causal record being deleted; `forget` releases the toolkit's
 * cached copies. Undo-like returns to earlier parameters, reset, cancellation and restore never erase an exposure record
 * or turn supported work into independent work. Fixture-host results (memory host, inline workers).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createStudyHarnessAdapter, type ExposureRecord, type InteractionSummary, type ResponseRef } from '@explorable-models/activity';
import {
  activityGuard, authorizeExploration, codesOf, enterExplore, guards, harness, okOf, op, open, requestFor, settled, until, type Harness, type Opened,
} from './support/adapter-harness.js';
import { staleReferences } from './support/dependencies.js';
import { MemoryHost } from './support/memory-host.js';

let disposers: (() => void)[] = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); });
const make = (...args: Parameters<typeof harness>): Harness => { const h = harness(...args); disposers.push(() => h.adapter.dispose()); return h; };
const ACTIVITY = 'act-quadratic-1';

type HostView = { instance: { responses: ResponseRef[]; hostSessionRevision: number; context: { kind: string } }; exposures: ExposureRecord[]; scientific: { runId: string; params: Record<string, number> } };
const hostView = (h: Harness | { adapter: Harness['adapter'] }): HostView => h.adapter.getState(ACTIVITY, 'host') as unknown as HostView;
function summary(h: Harness): InteractionSummary {
  const result = h.adapter.summarizeInteraction(ACTIVITY, { audience: 'host' });
  if (!('contract' in result)) throw new Error(JSON.stringify(result));
  return result;
}
let revision = 0;
async function respond(h: Harness, opened: Opened, response: Omit<ResponseRef, 'status'>): Promise<void> {
  okOf(await opened.control.submitResponseRef({ operationId: op('resp'), expectedHostSessionRevision: hostView(h).instance.hostSessionRevision, hostSessionRevision: hostView(h).instance.hostSessionRevision + 1, response }));
  revision = hostView(h).instance.hostSessionRevision;
  await settled(h);
}
async function mark(h: Harness, opened: Opened, responseId: string, status: 'superseded' | 'corrected' | 'disputed' | 'deleted', supersededBy?: string): Promise<void> {
  okOf(await opened.control.updateResponseRef({ operationId: op('update'), responseId, status, ...(supersededBy ? { supersededBy } : {}), expectedHostSessionRevision: hostView(h).instance.hostSessionRevision, hostSessionRevision: hostView(h).instance.hostSessionRevision + 1 }));
  await settled(h);
}
const prediction = (responseId: string, taskRevision = 1): Omit<ResponseRef, 'status'> => ({ responseId, taskId: 'task-predict', taskRevision, kind: 'prediction', modality: 'text', stageId: 'predict' });
const exposureKey = (records: readonly ExposureRecord[]) => records.map(record => `${record.exposureId}:${record.scope}`).sort();

describe('derived records are invalidated through stable references (A18)', () => {
  it('a correction supersedes the response; earlier summaries and artifacts become stale by reference while the causal record stays', async () => {
    const h = make();
    const opened = await open(h);
    await respond(h, opened, prediction('resp-1'));
    const before = summary(h);
    const savedBefore = await opened.control.save({ operationId: op('save'), kind: 'backup' });
    if (!savedBefore.ok) throw new Error(JSON.stringify(savedBefore.diagnostics));
    await settled(h);
    expect(before.responses.map(ref => [ref.responseId, ref.status])).toEqual([['resp-1', 'submitted']]);
    expect(staleReferences(before, hostView(h).instance.responses)).toEqual([]);
    // The learner corrects the prediction: the host records a new response and supersedes the old one.
    await respond(h, opened, prediction('resp-2'));
    await mark(h, opened, 'resp-1', 'corrected');
    await mark(h, opened, 'resp-1', 'superseded', 'resp-2');
    const current = hostView(h).instance.responses;
    expect(staleReferences(before, current)).toEqual([{ responseId: 'resp-1', recorded: { status: 'submitted', taskRevision: 1 }, current: { status: 'superseded', taskRevision: 1, supersededBy: 'resp-2' } }]);
    expect(staleReferences(savedBefore.artifact, current).map(item => item.responseId)).toEqual(['resp-1']);
    const after = summary(h);
    expect(after.cursor.toSequence).toBeGreaterThan(before.cursor.toSequence);
    expect(staleReferences(after, current)).toEqual([]);
    // The journal keeps the original submission and records the supersession after the earlier summary's cursor.
    const events = h.host.events(ACTIVITY);
    expect(events.filter(event => event.type === 'response.submitted').map(event => (event.payload.response as ResponseRef).responseId)).toEqual(['resp-1', 'resp-2']);
    const superseded = events.filter(event => event.type === 'response.superseded');
    expect(superseded.map(event => [event.payload.responseId, event.payload.status])).toEqual([['resp-1', 'corrected'], ['resp-1', 'superseded']]);
    expect(superseded.every(event => event.sequence > before.cursor.toSequence)).toBe(true);
    // A stale host session revision cannot rewrite a response reference.
    expect(codesOf(await opened.control.updateResponseRef({ operationId: op(), responseId: 'resp-2', status: 'disputed', expectedHostSessionRevision: revision - 1, hostSessionRevision: revision }))).toEqual(['STALE_HOST_REVISION']);
  });

  it('a task revision and a dispute invalidate dependents; a frozen assistance snapshot never changes afterwards', async () => {
    const h = make();
    const opened = await open(h);
    await respond(h, opened, prediction('resp-1'));
    const frozen = opened.control.freezeAssistanceSnapshot({ responseId: 'resp-1' });
    const before = summary(h);
    // The host revises the task: the answer to revision 1 is superseded by an answer to revision 2.
    await respond(h, opened, prediction('resp-3', 2));
    await mark(h, opened, 'resp-1', 'superseded', 'resp-3');
    await enterExplore(h, opened);
    await mark(h, opened, 'resp-3', 'disputed');
    const current = hostView(h).instance.responses;
    expect(staleReferences(before, current).map(item => [item.responseId, item.current === 'missing' ? 'missing' : item.current.status])).toEqual([['resp-1', 'superseded']]);
    const mid = summary(h);
    expect(mid.responses.map(ref => [ref.responseId, ref.taskRevision, ref.status])).toEqual([['resp-1', 1, 'superseded'], ['resp-3', 2, 'disputed']]);
    expect(h.host.events(ACTIVITY).filter(event => event.type === 'response.invalidated').map(event => [event.payload.responseId, event.payload.status])).toEqual([['resp-3', 'disputed']]);
    // The snapshot frozen for the first answer is unchanged by the later reveal and the dispute.
    expect(opened.control.freezeAssistanceSnapshot({ responseId: 'resp-1' })).toBe(frozen);
    expect(frozen.exposures).toEqual([]);
    expect(Object.isFrozen(frozen)).toBe(true);
  });

  it('deletion invalidates dependents; forget releases cached copies but never pending evidence or host records', async () => {
    const h = make();
    const opened = await open(h);
    await respond(h, opened, prediction('resp-1'));
    await respond(h, opened, prediction('resp-2'));
    const frozen = opened.control.freezeAssistanceSnapshot({ responseId: 'resp-1' });
    const before = summary(h);
    const saved = await opened.control.save({ operationId: op('save'), kind: 'backup' });
    if (!saved.ok) throw new Error(JSON.stringify(saved.diagnostics));
    await settled(h);
    // Only a response the host has deleted can be forgotten.
    expect(codesOf(await opened.control.forget({ operationId: op(), scope: 'responses', responseIds: ['resp-1'] }))).toEqual(['CONFLICT']);
    await mark(h, opened, 'resp-1', 'deleted');
    const current = hostView(h).instance.responses;
    expect(staleReferences(before, current)).toEqual([{ responseId: 'resp-1', recorded: { status: 'submitted', taskRevision: 1 }, current: { status: 'deleted', taskRevision: 1 } }]);
    expect(staleReferences(saved.artifact, current).map(item => item.responseId)).toEqual(['resp-1']);
    const hostEvents = h.host.events(ACTIVITY).length;
    okOf(await opened.control.forget({ operationId: op(), scope: 'responses', responseIds: ['resp-1'] }));
    // The cached frozen snapshot is released: a new freeze is taken at the current cursor.
    const refrozen = opened.control.freezeAssistanceSnapshot({ responseId: 'resp-1' });
    expect(refrozen).not.toBe(frozen);
    expect(refrozen.cursor).toBeGreaterThan(frozen.cursor);
    // Local mirror copies of the deleted response's events are released and reported as not held locally.
    const after = summary(h);
    expect(after.complete).toBe(false);
    expect(after.omitted.events).toBeGreaterThan(0);
    expect(after.limitations.join(' ')).toMatch(/not held locally/);
    expect(after.responses.find(ref => ref.responseId === 'resp-1')?.status).toBe('deleted');
    // The toolkit never deletes host records: the host applies its own deletion policy to its journal and artifacts.
    expect(h.host.events(ACTIVITY)).toHaveLength(hostEvents);
    expect(h.host.artifacts().map(artifact => artifact.artifactId)).toEqual([saved.artifact.artifactId]);
  });

  it('forgetting the activity releases cached frames, comparisons and mirrored events; later summaries say what is not held', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    okOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { eta: 0.5 } }));
    okOf(opened.learner.retainComparison({ operationId: op(), ...guards(opened.learner), label: 'Half step' }));
    okOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { eta: 0.75 } }));
    await settled(h);
    expect(summary(h).complete).toBe(true);
    const exposures = hostView(h).exposures;
    const hostEvents = h.host.events(ACTIVITY).length;
    okOf(await opened.control.forget({ operationId: op(), scope: 'activity' }));
    await settled(h);
    expect(opened.learner.getProjection().comparisons).toEqual([]);
    const after = summary(h);
    expect(after.complete).toBe(false);
    expect(after.limitations.join(' ')).toMatch(/not held locally/);
    // Exposure records and the host journal are not cached copies: they are kept.
    expect(hostView(h).exposures).toEqual(exposures);
    expect(h.host.events(ACTIVITY).length).toBeGreaterThanOrEqual(hostEvents);
    expect(codesOf(await opened.control.forget({ operationId: op(), scope: 'everything' as 'activity' }))).toEqual(['INVALID_INPUT']);
  });

  // R13: the operation-deduplication cache holds outcomes with copies (saved artifacts, projections); forget releases them,
  // so replaying an operation ID can no longer hand back a forgotten backup.
  it('forget releases cached operation outcomes: a replayed save no longer returns the forgotten backup', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    await respond(h, opened, prediction('resp-1'));
    const saveOp = op('save');
    const saved = await opened.control.save({ operationId: saveOp, kind: 'backup' });
    if (!saved.ok) throw new Error(JSON.stringify(saved.diagnostics));
    const commitInput = { operationId: op('commit'), ...guards(opened.learner), displayValues: { eta: 0.5 } };
    const committed = await opened.learner.commitParameters(commitInput);
    expect(committed.ok).toBe(true);
    expect(await opened.learner.commitParameters(commitInput)).toBe(committed);
    // Before forget, a replay returns the cached outcome without contacting the host again.
    const saves = h.host.calls('saveArtifact').length;
    expect(await opened.control.save({ operationId: saveOp, kind: 'backup' })).toBe(saved);
    await settled(h);
    okOf(await opened.control.forget({ operationId: op(), scope: 'activity' }));
    const replay = await opened.control.save({ operationId: saveOp, kind: 'backup' });
    expect(replay.ok).toBe(false);
    expect(replay.ok ? null : replay.diagnostics[0]).toMatchObject({ code: 'NOT_FOUND', path: '$.operationId' });
    expect(JSON.stringify(replay)).not.toContain('resp-1');
    expect(h.host.calls('saveArtifact')).toHaveLength(saves);
    // The operation ID stays used: different arguments still conflict; a replayed learner command reports the release too.
    expect(codesOf(await opened.control.save({ operationId: saveOp, kind: 'learner-snapshot' }))).toEqual(['OPERATION_CONFLICT']);
    const learnerReplay = await opened.learner.commitParameters(commitInput);
    expect(learnerReplay.ok).toBe(false);
    expect(JSON.stringify(learnerReplay)).not.toContain('projection');
  });

  // R13 (in flight): an operation still waiting for the host when forget runs is released when it settles; its caller
  // still receives its outcome once, but a replay of its operation ID never hands back the pre-forget copy.
  it('a save in flight while forget(activity) runs is released when it settles; the forget itself still replays', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    await respond(h, opened, prediction('resp-1'));
    const saveOp = op('save');
    h.host.hold('saveArtifact');
    const saving = opened.control.save({ operationId: saveOp, kind: 'backup' });
    await until(() => h.host.waiting('saveArtifact') === 1);
    const forgetInput = { operationId: op('forget'), scope: 'activity' as const };
    const forgotten = await opened.control.forget(forgetInput);
    expect(forgotten.ok).toBe(true);
    await h.host.release('saveArtifact');
    const first = await saving;
    // The caller that asked for the save receives its artifact (the host stored it).
    expect(first.ok).toBe(true);
    const saves = h.host.calls('saveArtifact').length;
    const replay = await opened.control.save({ operationId: saveOp, kind: 'backup' });
    expect(replay.ok ? null : replay.diagnostics[0]).toMatchObject({ code: 'NOT_FOUND', path: '$.operationId' });
    expect(JSON.stringify(replay)).not.toContain('resp-1');
    expect(h.host.calls('saveArtifact')).toHaveLength(saves);
    // The forget is not one of the outcomes it released: replaying it returns its own outcome.
    expect(await opened.control.forget(forgetInput)).toBe(forgotten);
  });

  // R13 (adapter): restore and prepare are deduplicated by the adapter itself. A restore report holds the pending draft's
  // parameter values and the restore notes, so forget(activity) releases those outcomes too; the IDs stay used.
  it('forget(activity) releases the adapter\'s cached restore and prepare outcomes: a replay returns neither the draft nor the handle', async () => {
    const h = make();
    const prepareOp = op('prepare');
    const prepared = await h.adapter.prepare(requestFor(), { operationId: prepareOp });
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.diagnostics));
    const learner = prepared.prepared.binding('learner', 'surface-main');
    learner.registerSurface('surface-main');
    const opened: Opened = { prepared: prepared.prepared, learner, tutor: prepared.prepared.binding('tutor', 'tool-executor'), control: prepared.prepared.host, surface: 'surface-main' };
    await settled(h);
    await enterExplore(h, opened);
    await authorizeExploration(h, opened);
    const previewId = okOf(opened.learner.beginPreview({ operationId: op(), ...guards(opened.learner), gesture: 'keyboard', parameter: 'eta' })).preview!.previewId;
    okOf(opened.learner.updatePreview({ operationId: op(), previewId, displayValues: { eta: 1.5 } }));
    const saved = await opened.control.save({ operationId: op('save'), kind: 'backup' });
    if (!saved.ok) throw new Error(JSON.stringify(saved.diagnostics));
    await settled(h);
    // Before forget, the adapter replays the prepare outcome (the same handle).
    expect(await h.adapter.prepare(requestFor(), { operationId: prepareOp })).toBe(prepared);
    okOf(await opened.control.forget({ operationId: op('forget'), scope: 'activity' }));
    const preparedReplay = await h.adapter.prepare(requestFor(), { operationId: prepareOp });
    expect(preparedReplay.ok ? null : preparedReplay.diagnostics[0]).toMatchObject({ code: 'NOT_FOUND', path: '$.operationId' });
    h.adapter.dispose();

    const host = h.host.restoreInto(new MemoryHost({ policy: h.host.policy() }));
    const adapter = createStudyHarnessAdapter({ catalog: h.catalog, host });
    disposers.push(() => adapter.dispose());
    const restoreOp = op('restore');
    const first = await adapter.restore(saved.artifact, { operationId: restoreOp, hostSessionRevision: 0 });
    if (!first.ok) throw new Error(JSON.stringify(first.diagnostics));
    expect(first.report.pendingDraft?.params).toMatchObject({ eta: 1.5 });
    // Before forget, a replay returns the cached outcome (with the draft), without contacting the host again.
    const registrations = host.calls('registerActivity').length;
    expect(await adapter.restore(saved.artifact, { operationId: restoreOp, hostSessionRevision: 0 })).toBe(first);
    okOf(await first.prepared.host.forget({ operationId: op('forget'), scope: 'activity' }));
    const replay = await adapter.restore(saved.artifact, { operationId: restoreOp, hostSessionRevision: 0 });
    expect(replay.ok).toBe(false);
    expect(replay.ok ? null : replay.diagnostics[0]).toMatchObject({ code: 'NOT_FOUND', path: '$.operationId' });
    expect(JSON.stringify(replay)).not.toContain('pendingDraft');
    expect(JSON.stringify(replay)).not.toContain('1.5');
    // Released, not re-run: nothing is registered again, the open activity stays the one restored, and the ID stays used.
    expect(host.calls('registerActivity')).toHaveLength(registrations);
    expect(adapter.getState(ACTIVITY, 'host')).toMatchObject({ instance: { activityId: ACTIVITY } });
    expect(codesOf(await adapter.restore(saved.artifact, { operationId: restoreOp, hostSessionRevision: 1 }))).toEqual(['OPERATION_CONFLICT']);
  });

  it('a learner command in flight while forget(activity) runs is released when it settles', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    await settled(h);
    const commitInput = { operationId: op('commit'), ...guards(opened.learner), displayValues: { eta: 0.5 } };
    const committing = opened.learner.commitParameters(commitInput);
    okOf(await opened.control.forget({ operationId: op('forget'), scope: 'activity' }));
    expect((await committing).ok).toBe(true);
    const replay = await opened.learner.commitParameters(commitInput);
    expect(replay.ok).toBe(false);
    expect(JSON.stringify(replay)).not.toContain('projection');
  });

  it('a save in flight that fails after forget keeps no unsent copy: its retry builds the artifact anew', async () => {
    const h = make();
    const opened = await open(h);
    await respond(h, opened, prediction('resp-1'));
    await mark(h, opened, 'resp-1', 'deleted');
    await settled(h);
    const before = await opened.control.save({ operationId: op('save'), kind: 'backup' });
    if (!before.ok) throw new Error(JSON.stringify(before.diagnostics));
    const saveOp = op('save');
    h.host.hold('saveArtifact');
    h.host.failNext('saveArtifact', 'throw');
    const saving = opened.control.save({ operationId: saveOp, kind: 'backup' });
    await until(() => h.host.waiting('saveArtifact') === 1);
    okOf(await opened.control.forget({ operationId: op('forget'), scope: 'responses', responseIds: ['resp-1'] }));
    await h.host.release('saveArtifact');
    expect(codesOf(await saving)).toEqual(['PERSISTENCE_FAILED']);
    // The retry does not resend the copy built before the forget: it is a new artifact (new artifact ID).
    const sent = h.host.calls('saveArtifact').map(call => (call.request as { artifact: { artifactId: string } }).artifact.artifactId);
    const retried = await opened.control.save({ operationId: saveOp, kind: 'backup' });
    if (!retried.ok) throw new Error(JSON.stringify(retried.diagnostics));
    expect(sent.at(-1)).not.toBe(retried.artifact.artifactId);
  });

  it('forgetting deleted responses releases the cached save outcomes and unsent save copies that name them', async () => {
    const h = make();
    const opened = await open(h);
    await respond(h, opened, prediction('resp-1'));
    const naming = op('save');
    const first = await opened.control.save({ operationId: naming, kind: 'backup' });
    if (!first.ok) throw new Error(JSON.stringify(first.diagnostics));
    // A save whose host outcome is unknown keeps its artifact for an identical retry: it names resp-1 too.
    h.host.failNext('saveArtifact', 'throw');
    const unsent = op('save');
    expect(codesOf(await opened.control.save({ operationId: unsent, kind: 'backup' }))).toEqual(['PERSISTENCE_FAILED']);
    await mark(h, opened, 'resp-1', 'deleted');
    await settled(h);
    const later = op('save');
    const after = await opened.control.save({ operationId: later, kind: 'backup' });
    if (!after.ok) throw new Error(JSON.stringify(after.diagnostics));
    okOf(await opened.control.forget({ operationId: op(), scope: 'responses', responseIds: ['resp-1'] }));
    expect(codesOf(await opened.control.save({ operationId: naming, kind: 'backup' }))).toEqual(['NOT_FOUND']);
    // The retry of the unconfirmed save builds a new artifact (the current, deleted status) instead of resending the
    // released copy that still named the submitted response.
    const retried = await opened.control.save({ operationId: unsent, kind: 'backup' });
    if (!retried.ok) throw new Error(JSON.stringify(retried.diagnostics));
    expect(retried.artifact.instance.responses.find(item => item.responseId === 'resp-1')?.status).toBe('deleted');
  });
});

describe('exposure is permanent; supported work stays supported (A19)', () => {
  it('cancel, reset and a return to earlier parameters keep every exposure and the instructional context', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    await authorizeExploration(h, opened);
    const learner = opened.learner;
    const exposures = exposureKey(hostView(h).exposures);
    const statuses = () => hostView(h).exposures.map(record => record.displayStatus);
    const before = statuses();
    expect(exposures).toHaveLength(2);
    // Cancelled preview: the tentative values are reverted; the exploration exposure is not.
    const runBefore = hostView(h).scientific.runId;
    const previewId = okOf(learner.beginPreview({ operationId: op(), ...guards(learner), gesture: 'pointer', parameter: 'eta' })).preview!.previewId;
    okOf(learner.updatePreview({ operationId: op(), previewId, displayValues: { eta: 1.6 } }));
    await settled(h);
    okOf(learner.cancelPreview({ operationId: op(), previewId, reason: 'escape' }));
    await settled(h);
    expect(hostView(h).scientific.runId).toBe(runBefore);
    expect(exposureKey(hostView(h).exposures)).toEqual(exposures);
    expect(statuses()).toEqual(before);
    // Commit, then return to the earlier value (the binding offers no undo; a return is a new run with provenance).
    okOf(await learner.commitParameters({ operationId: op(), ...guards(learner), displayValues: { eta: 0.9 } }));
    okOf(await learner.commitParameters({ operationId: op(), ...guards(learner), displayValues: { eta: 0.25 } }));
    okOf(await learner.resetExperiment({ operationId: op(), ...guards(learner) }));
    await settled(h);
    const committed = h.host.events(ACTIVITY).filter(event => event.type === 'parameters.committed');
    expect(committed.slice(-3).map(event => [event.payload.cause, (event.payload.params as Record<string, number>).eta])).toEqual([['commit', 0.9], ['commit', 0.25], ['reset', 0.25]]);
    expect(new Set(committed.map(event => event.payload.runId)).size).toBe(committed.length);
    expect(committed.slice(1).every((event, index) => event.payload.previousRunId === committed[index]!.payload.runId)).toBe(true);
    expect(exposureKey(hostView(h).exposures)).toEqual(exposures);
    expect(statuses()).toEqual(before);
    expect(hostView(h).instance.context.kind).toBe('instructional');
    expect(learner.getProjection().context).toBe('instructional');
    // Every recorded exposure is still reported, and the snapshot bound to an answer carries them.
    expect(summary(h).revealed.map(item => item.exposureId).sort()).toEqual(hostView(h).exposures.map(record => record.exposureId).sort());
    expect(exposureKey(opened.control.freezeAssistanceSnapshot({ responseId: 'resp-after-reset' }).exposures)).toEqual(exposures);
  });

  it('restore keeps exposure history conservatively and never turns the restored work into independent work', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    await authorizeExploration(h, opened);
    okOf(await opened.learner.requestHelp({ operationId: op(), ...activityGuard(opened.learner) }));
    await settled(h);
    const saved = await opened.control.save({ operationId: op('save'), kind: 'backup' });
    if (!saved.ok) throw new Error(JSON.stringify(saved.diagnostics));
    await settled(h);
    const original = hostView(h).exposures;
    const assistance = h.host.receipts(ACTIVITY).filter(receipt => receipt.contract === 'study-harness.assistance-receipt');
    h.adapter.dispose();
    const restarted = h.host.restoreInto(new MemoryHost({ policy: h.host.policy() }));
    const adapter = createStudyHarnessAdapter({ catalog: h.catalog, host: restarted });
    disposers.push(() => adapter.dispose());
    const restored = await adapter.restore(saved.artifact, { operationId: op('restore'), hostSessionRevision: 0 });
    if (!restored.ok) throw new Error(JSON.stringify(restored.diagnostics));
    const view = hostView({ adapter });
    expect(view.instance.context.kind).toBe('instructional');
    expect(exposureKey(view.exposures)).toEqual(exposureKey(original));
    // Displayed stays displayed; authorized without a persisted acknowledgement becomes uncertain (potentially seen).
    for (const record of view.exposures) {
      const was = original.find(item => item.exposureId === record.exposureId)!;
      expect(record.displayStatus).toBe(was.displayStatus === 'authorized' ? 'uncertain' : was.displayStatus);
    }
    expect(exposureKey(restored.prepared.host.freezeAssistanceSnapshot({ responseId: 'resp-restored' }).exposures)).toEqual(exposureKey(original));
    // The host's assistance and exposure records are untouched by the restore; nothing is re-requested.
    expect(restarted.receipts(ACTIVITY).filter(receipt => receipt.contract === 'study-harness.assistance-receipt')).toEqual(assistance);
    expect(restarted.calls('recordAssistance')).toEqual([]);
    expect(restarted.calls('recordExposureIntent')).toEqual([]);
    // Events before the restore are not held by the restored adapter: its summary says so instead of reporting none.
    const after = adapter.summarizeInteraction(ACTIVITY, { audience: 'host' }) as InteractionSummary;
    expect(after.complete).toBe(false);
    expect(after.limitations.join(' ')).toMatch(/not held locally/);
    // Exposures whose authorizing events are not held locally are still named, pointing to the host records.
    const unlinked = after.limitations.find(text => text.includes('no authorizing event in the local journal')) ?? '';
    for (const record of original) expect(unlinked).toContain(record.exposureId);
  });
});
