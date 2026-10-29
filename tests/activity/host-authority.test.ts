/**
 * The host is the authority for the stage, the activity revision and which exposure grants count (report §4.2, §6.3,
 * §7.2, §14; activity-runtime §2, §4, §9; `restoreClaims`). A restore adopts the host's activity state and counts a saved
 * grant only when the host holds the same grant and the host's context lineage counts it; a backup restores only an
 * activity the host holds, and a host that cannot report its state confirms only its latest checkpoint, so an edited
 * backup cannot widen what the host's own records authorize (R01). Restoring an earlier
 * checkpoint, a receipt the context change made late, and a receipt that did not bind its request all leave the adapter
 * able to take the next host-authorized step (R04). A kept authorization is never resent without the standing checks
 * (R03); restored journal losses stay valid in later backups (R05); exposure IDs bind one receipt (R11); a restored
 * permitted selection is kept (R30); a restored closed card holds no worker (R42). Host behaviour comes from the memory
 * host double (fixture-host results), in both its `test-double` and `conformant` profiles where they differ.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  artifactIntegrity, createStudyHarnessAdapter, verifyReceipt,
  type ActivityArtifact, type ActivityCatalog, type CatalogEntryStatus, type ExposureRecord, type HostPort, type StudyHarnessAdapter,
} from '@experiment-kit/activity';
import { createInstalledCatalog } from '@experiment-kit/catalog';
import {
  ackCurrent, activityGuard, codesOf, DIGESTS, enterExplore, expectValidEvents, harness, MODEL, okOf, op, open, policyFor, presentationGuard, requestFor, settled, TEMPLATE, until,
  type Harness, type HarnessOptions, type Opened,
} from './support/adapter-harness.js';
import { MemoryHost } from './support/memory-host.js';
import { FixtureHost } from '../../examples/study-harness-host/fixture-host.js';

const ACTIVITY = 'act-quadratic-1';
const PROFILES = ['test-double', 'conformant'] as const;
let disposers: (() => void)[] = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); });
const make = (options: HarnessOptions = {}): Harness => { const h = harness(options); disposers.push(() => h.adapter.dispose()); return h; };

async function backup(opened: Opened): Promise<ActivityArtifact> {
  const saved = await opened.control.save({ operationId: op('save'), kind: 'backup' });
  if (!saved.ok) throw new Error(JSON.stringify(saved.diagnostics));
  return saved.artifact;
}
/** An edited backup whose integrity manifest was recomputed (it verifies: the manifest is not a signature). */
function forged(artifact: ActivityArtifact, edit: (body: Omit<ActivityArtifact, 'integrity'>) => void): ActivityArtifact {
  const { integrity: _integrity, ...body } = structuredClone(artifact);
  edit(body);
  if (body.exposures.length && !body.schemas.some(entry => entry.contract === 'study-harness.exposure-record')) body.schemas.push({ contract: 'study-harness.exposure-record', version: '1.0' });
  return { ...body, integrity: artifactIntegrity(body) };
}
/** Fresh process: the host's durable tables in a new host (same profile) and a new adapter. */
function freshProcess(h: Harness, options: { profile?: 'test-double' | 'conformant'; port?: (host: MemoryHost) => HostPort; maxWorkers?: number } = {}): { host: MemoryHost; adapter: StudyHarnessAdapter } {
  const host = h.host.restoreInto(new MemoryHost({ policy: h.host.policy(), ...(options.profile ? { profile: options.profile } : {}) }));
  const adapter = createStudyHarnessAdapter({ catalog: h.catalog, host: options.port ? options.port(host) : host, ...(options.maxWorkers ? { maxWorkers: options.maxWorkers } : {}) });
  disposers.push(() => adapter.dispose());
  return { host, adapter };
}
async function restored(adapter: StudyHarnessAdapter, artifact: unknown) {
  const result = await adapter.restore(artifact, { operationId: op('restore'), hostSessionRevision: 0 });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  const learner = result.prepared.binding('learner', 'surface-restored');
  learner.registerSurface('surface-restored');
  return { result, learner, control: result.prepared.host };
}
const viewIds = (projection: { views: { viewId: string }[] }) => projection.views.map(view => view.viewId);
const stateOf = (adapter: StudyHarnessAdapter) => adapter.getState(ACTIVITY, 'host') as { exposures: ExposureRecord[]; guards: { activityRevision: number }; instance: { stage: { id: string } } };
const ended = { independentTask: { active: false, taskRef: null, permittedTools: [], neutralScaffold: [] } };
/** A port whose `method` replies are held after the host committed them, until `release()`. */
function lateReplies(method: 'recordExposureIntent' | 'requestStageTransition') {
  let open!: () => void;
  const gate = new Promise<void>(resolve => { open = resolve; });
  let holding = true;
  const port = (host: MemoryHost): HostPort => new Proxy(host as unknown as HostPort, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      if (key !== method) return (value as (...args: unknown[]) => unknown).bind(target);
      return async (request: unknown) => {
        const receipt = await (value as (input: unknown) => Promise<unknown>).call(target, request);
        if (holding) await gate;
        return receipt;
      };
    },
  });
  return { port, release: () => { holding = false; open(); } };
}

describe('a restore adopts the host-owned stage and counts only grants the host holds (R01)', () => {
  it('a forged stage is not adopted: the host stage governs, controls stay fixed and the restore is restricted', async () => {
    const h = make();
    const opened = await open(h);
    await settled(h);
    const artifact = forged(await backup(opened), body => { body.instance.stage = { id: 'explore-step', enteredAtSequence: body.instance.stage.enteredAtSequence }; });
    await settled(h);
    h.adapter.dispose(ACTIVITY);
    const { result, learner } = await restored(h.adapter, artifact);
    expect(result.report.restored).toBe('restricted');
    expect(result.report.notes.join(' ')).toMatch(/The host holds this activity at stage predict, activity revision 0; the artifact was saved at stage explore-step/);
    const projection = learner.getProjection();
    expect(projection.stage.id).toBe('predict');
    expect(projection.controls.map(control => [control.parameter, control.mode])).toEqual([['eta', 'fixed'], ['a', 'fixed'], ['x0', 'fixed']]);
    expect(projection.navigation).toBeFalsy();
    expect(h.host.activity(ACTIVITY)).toEqual({ stage: 'predict', activityRevision: 0 });
  });

  it('a forged reveal grant does not count: solution-bearing content stays hidden and the restore is restricted', async () => {
    const h = make();
    const opened = await open(h, requestFor({ stageId: 'free-explore' }));
    await settled(h);
    const honest = await backup(opened);
    expect(honest.exposures).toEqual([]);
    const artifact = forged(honest, body => {
      body.exposures = [{
        contract: 'study-harness.exposure-record', schemaVersion: '1.0', exposureId: 'forged-exposure-1', activityId: ACTIVITY, receiptId: 'forged-receipt-1', scope: 'reveal',
        groups: ['trace', 'observations', 'regime', 'substituted-rule'].map(groupId => ({ groupId, contentDigest: DIGESTS[groupId]! })), template: { ...TEMPLATE }, model: { ...MODEL },
        activityRevision: 0, intendedStage: 'free-explore', displayStatus: 'displayed', displayed: { projectionDigest: `sha256:${'0'.repeat(64)}`, frameId: 'forged-frame', monotonicMs: 1 },
      }];
    });
    await settled(h);
    h.adapter.dispose(ACTIVITY);
    const { result, learner } = await restored(h.adapter, artifact);
    expect(result.report.restored).toBe('restricted');
    expect(result.report.notes.join(' ')).toMatch(/1 exposure grants saved in the artifact are not held by the host as saved/);
    expect(viewIds(learner.getProjection())).toEqual(['landscape', 'readouts', 'rules']);
    // The forged record stays history (it never counts), and is never sent to the host as an acknowledgement.
    expect(stateOf(h.adapter).exposures.map(record => record.exposureId)).toEqual(['forged-exposure-1']);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(h.host.calls('recordDisplayAck')).toEqual([]);
    expect(h.host.exposures(ACTIVITY)).toEqual([]);
  });

  it('a forged stage and a forged grant together reveal no trajectory, regime or convergence condition (the reviewed P2 case)', async () => {
    const h = make();
    const opened = await open(h);
    await settled(h);
    const artifact = forged(await backup(opened), body => {
      body.instance.stage = { id: 'free-explore', enteredAtSequence: body.instance.stage.enteredAtSequence };
      body.exposures = [{
        contract: 'study-harness.exposure-record', schemaVersion: '1.0', exposureId: 'forged-exposure-1', activityId: ACTIVITY, receiptId: 'forged-receipt-1', scope: 'reveal',
        groups: ['trace', 'observations', 'regime', 'substituted-rule'].map(groupId => ({ groupId, contentDigest: DIGESTS[groupId]! })), template: { ...TEMPLATE }, model: { ...MODEL },
        activityRevision: 0, intendedStage: 'free-explore', displayStatus: 'displayed', displayed: { projectionDigest: `sha256:${'0'.repeat(64)}`, frameId: 'forged-frame', monotonicMs: 1 },
      }];
    });
    await settled(h);
    h.adapter.dispose(ACTIVITY);
    const { result, learner } = await restored(h.adapter, artifact);
    expect(result.report.restored).toBe('restricted');
    const projection = learner.getProjection();
    expect(projection.stage.id).toBe('predict');
    expect(viewIds(projection)).toEqual(['landscape', 'readouts', 'rules']);
    const values = projection.views.flatMap(view => view.values.map(value => value.quantityId));
    expect(values).not.toContain('regime');
    expect(values).not.toContain('threshold');
    const equations = projection.views.flatMap(view => view.equations.map(equation => equation.equationId));
    expect(equations).not.toContain('substituted-update');
    expect(equations).not.toContain('convergence-condition');
    expect(learner.describeCurrentValues()).not.toMatch(/convergence|monotone|threshold/i);
  });

  it('a grant the host holds under the same IDs but with edited content does not count', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    const honest = await backup(opened);
    expect(honest.exposures).toEqual([expect.objectContaining({ scope: 'stage', displayStatus: 'displayed' })]);
    const artifact = forged(honest, body => {
      body.exposures = body.exposures.map(record => ({ ...record, groups: [...record.groups, { groupId: 'regime', contentDigest: DIGESTS.regime! }] }));
    });
    await settled(h);
    h.adapter.dispose(ACTIVITY);
    const { result, learner } = await restored(h.adapter, artifact);
    expect(result.report.restored).toBe('restricted');
    expect(viewIds(learner.getProjection())).not.toContain('trace-plot');
    // The honest grant, held by the host exactly as saved, counts again.
    h.adapter.dispose(ACTIVITY);
    const again = await restored(h.adapter, honest);
    expect(again.result.report.restored).toBe('exact');
    expect(viewIds(again.learner.getProjection())).toContain('trace-plot');
  });

  it('without the host records the restore is restricted, saved grants do not count and the host re-authorizes the content', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    const artifact = await backup(opened);
    await settled(h);
    h.adapter.dispose();
    const withoutRecords = (host: MemoryHost): HostPort => ({
      getPolicy: request => host.getPolicy(request), registerActivity: request => host.registerActivity(request), requestStageTransition: request => host.requestStageTransition(request),
      recordExposureIntent: request => host.recordExposureIntent(request), recordDisplayAck: request => host.recordDisplayAck(request), recordAssistance: request => host.recordAssistance(request),
      appendEvents: request => host.appendEvents(request), getJournalCursor: request => host.getJournalCursor(request), saveArtifact: request => host.saveArtifact(request),
    });
    const fresh = freshProcess(h, { port: withoutRecords });
    const { result, learner, control } = await restored(fresh.adapter, artifact);
    expect(result.report.restored).toBe('restricted');
    expect(result.report.notes.join(' ')).toMatch(/saved exposure grants do not make content visible, and solution-bearing content is shown again only after the host authorizes it/);
    expect(learner.getProjection().stage.id).toBe('explore-step');
    expect(viewIds(learner.getProjection())).not.toContain('trace-plot');
    const before = fresh.host.calls('recordExposureIntent').length;
    okOf(await control.requestReveal({ operationId: op('reveal'), ...activityGuard(learner), groups: ['trace'] }));
    expect(fresh.host.calls('recordExposureIntent')).toHaveLength(before + 1);
    expect(viewIds(learner.getProjection())).toContain('trace-plot');
  });

  it('host records without its activity state: held grants count, the saved stage is unconfirmed and the restore is restricted', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    const artifact = await backup(opened);
    await settled(h);
    h.adapter.dispose();
    const fresh = freshProcess(h);
    fresh.host.withholdActivity = true;
    const { result, learner } = await restored(fresh.adapter, artifact);
    expect(result.report.restored).toBe('restricted');
    expect(result.report.notes.join(' ')).toMatch(/did not report its stage and activity revision/);
    expect(viewIds(learner.getProjection())).toContain('trace-plot');
  });

  it('the host closed state makes the restore read-only, and the closed card holds no worker (R42)', async () => {
    const h = make();
    const opened = await open(h);
    await settled(h);
    const artifact = await backup(opened);
    await settled(h);
    okOf(await opened.control.close({ operationId: op('close'), reason: 'Lesson finished.' }));
    await settled(h);
    h.adapter.dispose();
    const fresh = freshProcess(h, { maxWorkers: 1 });
    const baseline = h.workers.live;
    const { result, learner, control } = await restored(fresh.adapter, artifact);
    expect(artifact.instance.closed).toBe(false);
    expect(result.report.restored).toBe('read-only');
    expect(result.report.notes.join(' ')).toMatch(/The host has closed this activity/);
    expect(learner.getProjection().status.ui).toBe('empty');
    expect(h.workers.live - baseline).toBe(0);
    // Suspension and resumption of a closed card never acquire a worker; another activity gets the only one.
    okOf(control.suspend({ operationId: op(), reason: 'offscreen' }));
    okOf(control.resume({ operationId: op() }));
    expect(h.workers.live - baseline).toBe(0);
    const second = await fresh.adapter.prepare(requestFor({ activityId: 'act-quadratic-2' }), { operationId: op('prepare') });
    expect(second.ok).toBe(true);
  });
});

const independentPolicy = (host: MemoryHost, taskRef = 'task-x') => host.amendPolicy({ independentTask: { active: true, taskRef, permittedTools: ['inspect.learner'], neutralScaffold: ['landscape', 'start'] } });

describe('the host context lineage, not the artifact, decides which saved grants count (R01)', () => {
  for (const profile of PROFILES) {
    it(`a backup edited to drop its lineage and claim instructional work shows nothing; the host requires the reopening (${profile})`, async () => {
      const h = make({ host: new MemoryHost({ policy: policyFor(), profile }) });
      const opened = await open(h);
      await enterExplore(h, opened);
      const [granted] = h.host.exposures(ACTIVITY);
      okOf(await opened.control.enterIndependentTask({ operationId: op('enter'), taskRef: 'task-x', policy: independentPolicy(h.host) }));
      await settled(h);
      const honest = await backup(opened);
      expect(honest.lineage).toEqual({ endedExposureIds: [granted!.exposureId], reopenRequired: true });
      expect(honest.instance.context).toEqual({ kind: 'independent', taskRef: 'task-x' });
      const artifact = forged(honest, body => { delete body.lineage; body.instance.context = { kind: 'instructional' }; });
      await settled(h);
      h.adapter.dispose();
      for (const candidate of [honest, artifact]) {
        const fresh = freshProcess(h, { profile });
        fresh.host.amendPolicy(ended);
        const { result, learner, control } = await restored(fresh.adapter, candidate);
        expect(result.report.restored).toBe('restricted');
        expect(viewIds(learner.getProjection())).toEqual(['landscape', 'readouts', 'rules']);
        expect(codesOf(await control.requestStageTransition({ operationId: op('stage'), ...activityGuard(learner), toStage: 'explore-curvature' }))).toEqual(['INDEPENDENT_CONTEXT']);
        expect(codesOf(await control.requestReveal({ operationId: op('reveal'), ...activityGuard(learner), groups: ['trace'] }))).toEqual(['INDEPENDENT_CONTEXT']);
        // Instructional content comes back only through a reopening the host records as assistance.
        const assisted = fresh.host.calls('recordAssistance').length;
        okOf(await control.reopenInstructional({ operationId: op('reopen'), ...activityGuard(learner) }));
        expect(fresh.host.calls('recordAssistance')).toHaveLength(assisted + 1);
        expect(viewIds(learner.getProjection())).toContain('trace-plot');
        fresh.adapter.dispose();
      }
    });
  }

  it('a grant a recorded reopening ended does not count again when an edited backup drops its ended mark', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    const [first] = h.host.exposures(ACTIVITY);
    okOf(await opened.control.enterIndependentTask({ operationId: op('enter'), taskRef: 'task-x', policy: independentPolicy(h.host) }));
    okOf(await opened.control.updatePolicy({ operationId: op('policy'), policy: h.host.amendPolicy(ended) }));
    okOf(await opened.control.reopenInstructional({ operationId: op('reopen'), ...activityGuard(opened.learner) }));
    ackCurrent(opened.learner);
    await settled(h);
    const honest = await backup(opened);
    expect(honest.lineage?.endedExposureIds).toEqual([first!.exposureId]);
    const artifact = forged(honest, body => { delete body.lineage; });
    await settled(h);
    h.adapter.dispose();
    const exact = await restored(freshProcess(h).adapter, honest);
    expect(exact.result.report.restored).toBe('exact');
    const edited = await restored(freshProcess(h).adapter, artifact);
    expect(edited.result.report.restored).toBe('restricted');
    expect(edited.result.report.notes.join(' ')).toMatch(/1 exposure grants saved in the artifact belong to a context lineage the host has ended/);
    // The reopening's own grant counts: the instructional content it authorized is shown.
    expect(viewIds(edited.learner.getProjection())).toContain('trace-plot');
  });

  it('a host that reports no context lineage confirms saved grants only through its latest checkpoint', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    const earlier = await backup(opened);
    await settled(h);
    const latest = await backup(opened);
    await settled(h);
    h.adapter.dispose();
    // The latest checkpoint: the host stored exactly these bytes, so their lineage is the host's own.
    const first = freshProcess(h);
    first.host.withholdLineage = true;
    const confirmed = await restored(first.adapter, latest);
    expect(confirmed.result.report.restored).toBe('exact');
    expect(viewIds(confirmed.learner.getProjection())).toContain('trace-plot');
    first.adapter.dispose();
    // An earlier checkpoint: no saved grant counts, and instructional content waits for a recorded reopening.
    const second = freshProcess(h);
    second.host.withholdLineage = true;
    const { result, learner, control } = await restored(second.adapter, earlier);
    expect(result.report.restored).toBe('restricted');
    expect(result.report.notes.join(' ')).toMatch(/did not report its context lineage and does not hold this artifact as its latest checkpoint/);
    expect(viewIds(learner.getProjection())).not.toContain('trace-plot');
    expect(codesOf(await control.requestStageTransition({ operationId: op('stage'), ...activityGuard(learner), toStage: 'explore-curvature' }))).toEqual(['INDEPENDENT_CONTEXT']);
    okOf(await control.reopenInstructional({ operationId: op('reopen'), ...activityGuard(learner) }));
    expect(viewIds(learner.getProjection())).toContain('trace-plot');
  });
});

describe('the reference fixture host reports its own context lineage (R01)', () => {
  it('lineage follows the policies the host issued and the reopenings it recorded; an edited backup cannot revive an ended grant', async () => {
    const h = make();
    const host = new FixtureHost({ storage: null });
    host.setPolicy(ACTIVITY, policyFor());
    const adapter = createStudyHarnessAdapter({ catalog: h.catalog, host });
    disposers.push(() => adapter.dispose());
    const prepared = await adapter.prepare(requestFor(), { operationId: op('prepare') });
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.diagnostics));
    const learner = prepared.prepared.binding('learner', 'surface-fixture');
    learner.registerSurface('surface-fixture');
    const control = prepared.prepared.host;
    okOf(await control.requestStageTransition({ operationId: op('stage'), ...activityGuard(learner), toStage: 'explore-step' }));
    ackCurrent(learner, 'surface-fixture');
    const stageReceipt = host.receipts(ACTIVITY).at(-1)!;
    const records = async () => (await host.getActivityRecords({ activityId: ACTIVITY })).activity;
    expect(await records()).toEqual({ stage: 'explore-step', activityRevision: 1, closed: false, lineage: { context: { kind: 'instructional' }, fromActivityRevision: 0 }, stageReceiptId: stageReceipt.receiptId });
    const independent = host.setPolicy(ACTIVITY, { ...policyFor(), revision: 2, independentTask: { active: true, taskRef: 'task-x', permittedTools: ['inspect.learner'], neutralScaffold: ['landscape', 'start'] } });
    expect((await records())?.lineage).toEqual({ context: { kind: 'independent', taskRef: 'task-x' }, fromActivityRevision: 2 });
    okOf(await control.enterIndependentTask({ operationId: op('enter'), taskRef: 'task-x', policy: independent }));
    okOf(await control.updatePolicy({ operationId: op('policy'), policy: host.setPolicy(ACTIVITY, { ...policyFor(), revision: 3 }) }));
    okOf(await control.reopenInstructional({ operationId: op('reopen'), ...activityGuard(learner) }));
    const reopened = host.receipts(ACTIVITY).at(-1)!;
    expect((await records())?.lineage).toEqual({ context: { kind: 'instructional' }, fromActivityRevision: reopened.activityRevision });
    ackCurrent(learner, 'surface-fixture');
    const saved = await control.save({ operationId: op('save'), kind: 'backup' });
    if (!saved.ok) throw new Error(JSON.stringify(saved.diagnostics));
    expect(saved.artifact.lineage?.endedExposureIds).toHaveLength(1);
    adapter.dispose();
    const again = createStudyHarnessAdapter({ catalog: h.catalog, host });
    disposers.push(() => again.dispose());
    const outcome = await again.restore(forged(saved.artifact, body => { delete body.lineage; }), { operationId: op('restore'), hostSessionRevision: 0 });
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.diagnostics));
    expect(outcome.report.restored).toBe('restricted');
    expect(outcome.report.notes.join(' ')).toMatch(/1 exposure grants saved in the artifact belong to a context lineage the host has ended/);
  });
});

describe('a restore needs the host to confirm the activity state (R01)', () => {
  const withoutRecords = (host: MemoryHost): HostPort => ({
    getPolicy: request => host.getPolicy(request), registerActivity: request => host.registerActivity(request), requestStageTransition: request => host.requestStageTransition(request),
    recordExposureIntent: request => host.recordExposureIntent(request), recordDisplayAck: request => host.recordDisplayAck(request), recordAssistance: request => host.recordAssistance(request),
    appendEvents: request => host.appendEvents(request), getJournalCursor: request => host.getJournalCursor(request), saveArtifact: request => host.saveArtifact(request),
  });
  for (const variant of ['withheld-activity', 'no-records'] as const) {
    it(`a forged stage on a host that does not report its activity state is refused, nothing is registered (${variant})`, async () => {
      const h = make();
      const opened = await open(h);
      await settled(h);
      const honest = await backup(opened);
      const artifact = forged(honest, body => { body.instance.stage = { id: 'explore-step', enteredAtSequence: body.instance.stage.enteredAtSequence }; });
      await settled(h);
      h.adapter.dispose();
      const fresh = freshProcess(h, variant === 'no-records' ? { port: withoutRecords } : {});
      fresh.host.withholdActivity = true;
      const registrations = fresh.host.calls('registerActivity').length;
      const refused = await fresh.adapter.restore(artifact, { operationId: op('restore'), hostSessionRevision: 0 });
      expect(refused.ok ? null : refused.diagnostics[0]).toMatchObject({ code: 'UNSUPPORTED_ARTIFACT', path: '$.instance.stage' });
      expect(refused.ok ? '' : refused.diagnostics[0]!.recovery).toMatch(/archivalView/);
      expect(fresh.host.calls('registerActivity')).toHaveLength(registrations);
      expect(fresh.host.activity(ACTIVITY)).toEqual({ stage: 'predict', activityRevision: 0 });
      // The host's own latest checkpoint restores (restricted: the host may have advanced since).
      const { result, learner } = await restored(fresh.adapter, honest);
      expect(result.report.restored).toBe('restricted');
      expect(learner.getProjection().stage.id).toBe('predict');
    });
  }

  it('an earlier checkpoint on a host that does not report its activity state is refused with the archival recovery', async () => {
    const h = make();
    const opened = await open(h);
    await settled(h);
    const earlier = await backup(opened);
    await enterExplore(h, opened);
    await backup(opened);
    await settled(h);
    h.adapter.dispose();
    const fresh = freshProcess(h);
    fresh.host.withholdActivity = true;
    expect(codesOf(await fresh.adapter.restore(earlier, { operationId: op('restore'), hostSessionRevision: 0 }))).toEqual(['UNSUPPORTED_ARTIFACT']);
    // A host that reports its state restores the same earlier checkpoint in its own stage.
    const reporting = freshProcess(h);
    const { learner } = await restored(reporting.adapter, earlier);
    expect(learner.getProjection().stage.id).toBe('explore-step');
  });

  // A host that provides the records read but did not answer it has not said it cannot confirm the saved state: the
  // restore of an earlier checkpoint is a retryable host failure, not an archival refusal cached under its operation ID.
  const invalidRecordsOnce = (host: MemoryHost): HostPort => {
    let invalid = true;
    return new Proxy(host as unknown as HostPort, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== 'function') return value;
        if (key !== 'getActivityRecords') return (value as (...args: unknown[]) => unknown).bind(target);
        return async (request: unknown) => {
          const records = await (value as (input: unknown) => Promise<Record<string, unknown>>).call(target, request);
          if (!invalid) return records;
          invalid = false;
          return { ...records, exposures: 'not a list' };
        };
      },
    });
  };
  for (const failure of ['thrown', 'invalid'] as const) {
    it(`an earlier checkpoint whose host records read fails (${failure}) is refused as a retryable host failure; the same operation ID then restores it`, async () => {
      const h = make();
      const opened = await open(h);
      await settled(h);
      const earlier = await backup(opened);
      await enterExplore(h, opened);
      await backup(opened);
      await settled(h);
      h.adapter.dispose();
      const fresh = freshProcess(h, failure === 'invalid' ? { port: invalidRecordsOnce } : {});
      if (failure === 'thrown') fresh.host.failNext('getActivityRecords', 'throw');
      const registrations = fresh.host.calls('registerActivity').length;
      const operationId = op('restore');
      const refused = await fresh.adapter.restore(earlier, { operationId, hostSessionRevision: 0 });
      expect(codesOf(refused)).toEqual(['PERSISTENCE_FAILED']);
      const diagnostic = refused.ok ? null : refused.diagnostics[0]!;
      expect(diagnostic).toMatchObject({ code: 'PERSISTENCE_FAILED', path: '$' });
      expect(diagnostic!.message).toMatch(failure === 'invalid' ? /returned invalid activity records/ : /did not return its activity records/);
      expect(diagnostic!.message).toMatch(/not the host's latest checkpoint/);
      expect(diagnostic!.message).not.toMatch(/does not report/);
      expect(diagnostic!.recovery).toBe('Retry the restore with the same operation ID when the host is available.');
      expect(diagnostic!.recovery).not.toMatch(/archivalView/);
      expect(fresh.host.calls('registerActivity')).toHaveLength(registrations);
      // Not cached as final: the retry with the same operation ID reads the host's records again and restores the earlier
      // checkpoint in the host's own stage.
      const reads = fresh.host.calls('getActivityRecords').length;
      const retried = await fresh.adapter.restore(earlier, { operationId, hostSessionRevision: 0 });
      if (!retried.ok) throw new Error(JSON.stringify(retried.diagnostics));
      expect(fresh.host.calls('getActivityRecords').length).toBeGreaterThan(reads);
      const learner = retried.prepared.binding('learner', 'surface-retried');
      learner.registerSurface('surface-retried');
      expect(learner.getProjection().stage.id).toBe('explore-step');
    });
  }

  it('an earlier checkpoint whose host records read the host refuses is refused with the host\'s refusal, never the archival recovery', async () => {
    const h = make();
    const opened = await open(h);
    await settled(h);
    const earlier = await backup(opened);
    await enterExplore(h, opened);
    await backup(opened);
    await settled(h);
    h.adapter.dispose();
    const fresh = freshProcess(h);
    fresh.host.failNext('getActivityRecords', 'reject', { code: 'POLICY_DENIED' });
    const refused = await fresh.adapter.restore(earlier, { operationId: op('restore'), hostSessionRevision: 0 });
    expect(codesOf(refused)).toEqual(['POLICY_DENIED']);
    expect(refused.ok ? '' : refused.diagnostics[0]!.message).toMatch(/activity was not restored/);
    expect(refused.ok ? '' : refused.diagnostics[0]!.recovery).not.toMatch(/archivalView/);
  });

  it('the host\'s latest checkpoint still restores (restricted) when the records read fails', async () => {
    const h = make();
    const opened = await open(h);
    await settled(h);
    const latest = await backup(opened);
    await settled(h);
    h.adapter.dispose();
    const fresh = freshProcess(h);
    fresh.host.failNext('getActivityRecords', 'throw');
    const { result } = await restored(fresh.adapter, latest);
    expect(result.report.restored).toBe('restricted');
    expect(result.report.notes.join(' ')).toMatch(/did not return its activity records/);
  });

  it('a backup edited from closed to open is refused on a host that does not report its state, and read-only on one that does', async () => {
    const h = make();
    const opened = await open(h);
    await settled(h);
    okOf(await opened.control.close({ operationId: op('close'), reason: 'Lesson finished.' }));
    await settled(h);
    const closed = await backup(opened);
    const artifact = forged(closed, body => { body.instance.closed = false; });
    h.adapter.dispose();
    const withheld = freshProcess(h);
    withheld.host.withholdActivity = true;
    expect(codesOf(await withheld.adapter.restore(artifact, { operationId: op('restore'), hostSessionRevision: 0 }))).toEqual(['UNSUPPORTED_ARTIFACT']);
    const reporting = freshProcess(h);
    expect((await restored(reporting.adapter, artifact)).result.report.restored).toBe('read-only');
  });

  for (const profile of PROFILES) {
    it(`a backup restored onto a host store that does not hold the activity is refused; the host creates nothing (${profile})`, async () => {
      const h = make({ host: new MemoryHost({ policy: policyFor(), profile }) });
      const opened = await open(h);
      await settled(h);
      const honest = await backup(opened);
      const artifact = forged(honest, body => { body.instance.stage = { id: 'explore-step', enteredAtSequence: body.instance.stage.enteredAtSequence }; body.instance.activityRevision = 3; });
      h.adapter.dispose();
      for (const candidate of [honest, artifact]) {
        const empty = new MemoryHost({ policy: policyFor(), profile });
        const adapter = createStudyHarnessAdapter({ catalog: h.catalog, host: empty });
        disposers.push(() => adapter.dispose());
        const outcome = await adapter.restore(candidate, { operationId: op('restore'), hostSessionRevision: 0 });
        expect(codesOf(outcome)).toEqual([profile === 'conformant' ? 'INVALID_INPUT' : 'PERSISTENCE_FAILED']);
        expect(empty.calls('registerActivity')).toEqual([]);
        expect(empty.activity(ACTIVITY)).toBeNull();
      }
    });
  }
});

describe('a restored closed artifact holds no worker lease (R42)', () => {
  it('restoring a backup saved after close suspends the session at once; hidden surfaces and host suspension keep it released', async () => {
    const h = make();
    const opened = await open(h);
    await settled(h);
    okOf(await opened.control.close({ operationId: op('close'), reason: 'Lesson finished.' }));
    await settled(h);
    const artifact = await backup(opened);
    expect(h.workers.live).toBe(0);
    h.adapter.dispose();
    const fresh = freshProcess(h, { maxWorkers: 1 });
    const { result, learner, control } = await restored(fresh.adapter, artifact);
    expect(result.report.restored).toBe('read-only');
    expect(h.workers.live).toBe(0);
    learner.reportVisibility({ surfaceId: 'surface-restored', visible: false });
    learner.reportVisibility({ surfaceId: 'surface-restored', visible: true });
    okOf(control.suspend({ operationId: op(), reason: 'offscreen' }));
    expect(h.workers.live).toBe(0);
    const second = await fresh.adapter.prepare(requestFor({ activityId: 'act-quadratic-2' }), { operationId: op('prepare') });
    expect(second.ok).toBe(true);
    // The closed card still saves its record.
    expect((await control.save({ operationId: op('save'), kind: 'backup' })).ok).toBe(true);
  });
});

describe('restoring an earlier checkpoint follows the host, so later host-authorized steps work (R04)', () => {
  for (const profile of PROFILES) {
    it(`adopts the host stage and revision; a stage transition, help and a reopening then succeed (${profile})`, async () => {
      const h = make({ host: new MemoryHost({ policy: policyFor(), profile }) });
      const opened = await open(h);
      await settled(h);
      const artifact = await backup(opened);
      await enterExplore(h, opened);
      expect(h.host.activity(ACTIVITY)).toEqual({ stage: 'explore-step', activityRevision: 1 });
      h.adapter.dispose();
      const fresh = freshProcess(h, { profile });
      const { result, learner, control } = await restored(fresh.adapter, artifact);
      expect(result.report.restored).toBe('restricted');
      expect(learner.getProjection()).toMatchObject({ stage: { id: 'explore-step' }, activityRevision: 1 });
      // The stage grant the host issued after the checkpoint is history: it does not show the trajectory again.
      expect(viewIds(learner.getProjection())).not.toContain('trace-plot');
      okOf(await control.requestStageTransition({ operationId: op('stage'), ...activityGuard(learner), toStage: 'explore-curvature' }));
      expect(learner.getProjection()).toMatchObject({ stage: { id: 'explore-curvature' }, activityRevision: 2 });
      expect(viewIds(learner.getProjection())).toContain('trace-plot');
      ackCurrent(learner, 'surface-restored');
      okOf(await learner.requestHelp({ operationId: op('help'), ...activityGuard(learner) }));
      const independent = fresh.host.amendPolicy({ independentTask: { active: true, taskRef: 'task-1', permittedTools: ['inspect.learner'], neutralScaffold: ['landscape', 'start'] } });
      okOf(await control.enterIndependentTask({ operationId: op('enter'), taskRef: 'task-1', policy: independent }));
      okOf(await control.updatePolicy({ operationId: op('policy'), policy: fresh.host.amendPolicy(ended) }));
      okOf(await control.reopenInstructional({ operationId: op('reopen'), ...activityGuard(learner) }));
      expect(learner.getProjection().activityRevision).toBe(fresh.host.activity(ACTIVITY)!.activityRevision);
      await settled({ ...h, host: fresh.host, adapter: fresh.adapter });
      expectValidEvents(fresh.host.events(ACTIVITY));
    });
  }

  it('a different operation for content the host authorized after the checkpoint is sent anew after the host refuses the resumption (conformant)', async () => {
    const h = make({ host: new MemoryHost({ policy: policyFor(), profile: 'conformant' }) });
    const opened = await open(h, requestFor({ stageId: 'free-explore' }));
    await settled(h);
    const artifact = await backup(opened);
    await settled(h);
    h.host.crashAt('after-intent-commit-before-reply');
    expect(codesOf(await opened.control.requestReveal({ operationId: op('lost'), ...activityGuard(opened.learner), groups: ['trace'] }))).toEqual(['PERSISTENCE_FAILED']);
    h.adapter.dispose();
    const fresh = freshProcess(h, { profile: 'conformant' });
    fresh.host.interruptUnacknowledged();
    const { learner, control } = await restored(fresh.adapter, artifact);
    expect(learner.getProjection().activityRevision).toBe(1);
    const operationId = op('new');
    okOf(await control.requestReveal({ operationId, ...activityGuard(learner), groups: ['trace'] }));
    const sent = fresh.host.calls('recordExposureIntent').map(call => call.request as { idempotencyKey: string; basedOnActivityRevision: number });
    expect(sent.map(request => [request.idempotencyKey, request.basedOnActivityRevision])).toEqual([[operationId, 0], [operationId, 1]]);
    expect(viewIds(learner.getProjection())).toContain('trace-plot');
    expect(fresh.host.exposures(ACTIVITY).map(record => record.displayStatus)).toEqual(['uncertain', 'authorized']);
    expect(learner.getProjection().activityRevision).toBe(2);
  });
});

describe('a verified receipt the adapter can no longer apply is kept as history (R04)', () => {
  for (const profile of PROFILES) {
    it(`a reveal the host committed whose reply arrives after the independent task began follows the host revision (${profile})`, async () => {
      const late = lateReplies('recordExposureIntent');
      const h = make({ host: new MemoryHost({ policy: policyFor(), profile }), port: late.port });
      const opened = await open(h, requestFor({ stageId: 'free-explore' }));
      await settled(h);
      const reveal = opened.control.requestReveal({ operationId: op('reveal'), ...activityGuard(opened.learner), groups: ['trace', 'regime'] });
      await until(() => h.host.exposures(ACTIVITY).length === 1);
      const independent = h.host.amendPolicy({ independentTask: { active: true, taskRef: 'task-x', permittedTools: ['inspect.learner'], neutralScaffold: ['landscape', 'start'] } });
      okOf(await opened.control.enterIndependentTask({ operationId: op('enter'), taskRef: 'task-x', policy: independent }));
      late.release();
      expect(codesOf(await reveal)).toEqual(['STALE_ACTIVITY_REVISION']);
      await settled(h);
      expect(stateOf(h.adapter).guards.activityRevision).toBe(h.host.activity(ACTIVITY)!.activityRevision);
      const [held] = h.host.exposures(ACTIVITY);
      expect(stateOf(h.adapter).exposures).toEqual([expect.objectContaining({ exposureId: held!.exposureId, receiptId: held!.receiptId, displayStatus: 'authorized' })]);
      expect(viewIds(opened.learner.getProjection())).not.toContain('trace-plot');
      const frozen = opened.control.freezeAssistanceSnapshot({ responseId: 'answer-1' });
      expect(frozen).toMatchObject({ complete: true, exposures: [expect.objectContaining({ exposureId: held!.exposureId })] });
      const summary = h.adapter.summarizeInteraction(ACTIVITY, { audience: 'host' }) as { revealed: { exposureId: string; displayStatus: string }[] };
      expect(summary.revealed).toEqual([expect.objectContaining({ exposureId: held!.exposureId, displayStatus: 'authorized' })]);
      // The history grant never counts again; reopening instructional work goes through the host and is accepted.
      okOf(await opened.control.updatePolicy({ operationId: op('policy'), policy: h.host.amendPolicy(ended) }));
      okOf(await opened.control.reopenInstructional({ operationId: op('reopen'), ...activityGuard(opened.learner) }));
      expect(opened.learner.getProjection().activityRevision).toBe(h.host.activity(ACTIVITY)!.activityRevision);
      await settled(h);
      expectValidEvents(h.host.events(ACTIVITY));
    });
  }

  // The closed card keeps the stage it was closed in: no `stage.changed` is journaled after `activity.closed` (report §7.1
  // ordering). The host revision is followed, the grant is history, and a restore adopts the host's stage.
  it('a stage transition the host committed whose reply arrives after close follows the host revision; the closed journal records no stage change', async () => {
    const late = lateReplies('requestStageTransition');
    const h = make({ port: late.port });
    const opened = await open(h);
    await settled(h);
    const transition = opened.control.requestStageTransition({ operationId: op('stage'), ...activityGuard(opened.learner), toStage: 'explore-step' });
    await until(() => h.host.activity(ACTIVITY)?.stage === 'explore-step');
    okOf(await opened.control.close({ operationId: op('close'), reason: 'Lesson finished.' }));
    late.release();
    expect(codesOf(await transition)).toEqual(['STALE_ACTIVITY_REVISION']);
    await settled(h);
    expect(stateOf(h.adapter).instance.stage.id).toBe('predict');
    expect(stateOf(h.adapter).guards.activityRevision).toBe(1);
    expect(opened.learner.getProjection().views).toEqual([]);
    expect(stateOf(h.adapter).exposures).toEqual([expect.objectContaining({ scope: 'stage', displayStatus: 'authorized' })]);
    const types = h.host.events(ACTIVITY).map(event => event.type);
    expect(types.slice(types.indexOf('activity.closed'))).not.toContain('stage.changed');
    expect(types.slice(types.indexOf('activity.closed'))).toContain('reveal.authorized');
    expectValidEvents(h.host.events(ACTIVITY));
    const saved = await opened.control.save({ operationId: op('save'), kind: 'backup' });
    expect(saved.ok).toBe(true);
    expect(saved.ok && saved.artifact.lineage?.endedExposureIds).toEqual([stateOf(h.adapter).exposures[0]!.exposureId]);
    // A restore of that backup adopts the stage the host committed, read-only.
    await settled(h);
    h.adapter.dispose();
    const fresh = freshProcess(h);
    const { result } = await restored(fresh.adapter, saved.ok ? saved.artifact : null);
    expect(result.report.restored).toBe('read-only');
    expect(stateOf(fresh.adapter).instance.stage.id).toBe('explore-step');
  });
});

describe('reconcile follows the host after a receipt that did not bind its request (R04, R11)', () => {
  for (const profile of PROFILES) {
    it(`a grant reusing another receipt's exposure ID is refused whole; the host's later state is adopted by reconcile (${profile})`, async () => {
      let reuse: string | null = null;
      const h = make({
        host: new MemoryHost({ policy: policyFor(), profile }),
        port: host => new Proxy(host as unknown as HostPort, {
          get(target, key) {
            const value = Reflect.get(target, key, target);
            if (typeof value !== 'function') return value;
            if (key !== 'recordExposureIntent') return (value as (...args: unknown[]) => unknown).bind(target);
            return async (request: unknown) => {
              const receipt = await (value as (input: unknown) => Promise<{ grant: { exposureId: string } }>).call(target, request);
              return reuse ? { ...receipt, grant: { ...receipt.grant, exposureId: reuse } } : receipt;
            };
          },
        }),
      });
      const opened = await open(h);
      await enterExplore(h, opened);
      reuse = h.host.exposures(ACTIVITY)[0]!.exposureId;
      const before = opened.learner.getProjection().activityRevision;
      const scope = await opened.control.requestExplorationScope({ operationId: op('scope'), ...activityGuard(opened.learner), groups: ['step-control', 'trace', 'observations'], parameterDomain: { eta: [0, 2] } });
      expect(scope.ok ? [] : scope.diagnostics.map(item => [item.code, item.path])).toEqual([['RECEIPT_MISMATCH', '$.receipt.grant.exposureId']]);
      reuse = null;
      const projection = opened.learner.getProjection();
      expect(projection.activityRevision).toBe(before);
      expect(projection.pendingReveal).toBeNull();
      expect(stateOf(h.adapter).exposures).toHaveLength(1);
      // Nothing is wedged: no step reports PERSISTENCE_PENDING. The host committed the grant whose reply did not bind
      // the request, so it is ahead; reconcile reads its state and the next step is based on the host's revision.
      const help = await opened.learner.requestHelp({ operationId: op('help'), ...activityGuard(opened.learner) });
      expect(help.ok ? [] : codesOf(help)).not.toContain('PERSISTENCE_PENDING');
      const reconciled = await opened.control.reconcile();
      expect(reconciled.activity).toEqual({ stage: 'explore-step', activityRevision: h.host.activity(ACTIVITY)!.activityRevision, adopted: true });
      expect(stateOf(h.adapter).exposures).toHaveLength(2);
      expect(viewIds(opened.learner.getProjection())).toContain('trace-plot');
      okOf(await opened.learner.requestHelp({ operationId: op('help'), ...activityGuard(opened.learner) }));
      okOf(await opened.control.requestStageTransition({ operationId: op('stage'), ...activityGuard(opened.learner), toStage: 'explore-curvature' }));
      // What reconcile adopted is journaled: the host-audience summary names every grant the ledger holds.
      await settled(h);
      const summary = h.adapter.summarizeInteraction(ACTIVITY, { audience: 'host' }) as { revealed: { exposureId: string }[] };
      expect(summary.revealed.map(item => item.exposureId).sort()).toEqual(stateOf(h.adapter).exposures.map(record => record.exposureId).sort());
      expectValidEvents(h.host.events(ACTIVITY));
    });

    it(`a stage receipt whose grant reuses an exposure ID is refused; reconcile follows the host stage and journals its receipt and grant (${profile})`, async () => {
      let reuse: string | null = null;
      const h = make({
        host: new MemoryHost({ policy: policyFor(), profile }),
        port: host => new Proxy(host as unknown as HostPort, {
          get(target, key) {
            const value = Reflect.get(target, key, target);
            if (typeof value !== 'function') return value;
            if (key !== 'requestStageTransition') return (value as (...args: unknown[]) => unknown).bind(target);
            return async (request: unknown) => {
              const receipt = await (value as (input: unknown) => Promise<{ grant: { exposureId: string } | null }>).call(target, request);
              return reuse && receipt.grant ? { ...receipt, grant: { ...receipt.grant, exposureId: reuse } } : receipt;
            };
          },
        }),
      });
      const opened = await open(h);
      await enterExplore(h, opened);
      reuse = h.host.exposures(ACTIVITY)[0]!.exposureId;
      const refused = await opened.control.requestStageTransition({ operationId: op('stage'), ...activityGuard(opened.learner), toStage: 'explore-curvature' });
      expect(codesOf(refused)).toEqual(['RECEIPT_MISMATCH']);
      reuse = null;
      expect(opened.learner.getProjection().stage.id).toBe('explore-step');
      const reconciled = await opened.control.reconcile();
      expect(reconciled.activity).toMatchObject({ stage: 'explore-curvature', adopted: true });
      await settled(h);
      const held = h.host.exposures(ACTIVITY).at(-1)!;
      const stageReceipt = h.host.receipts(ACTIVITY).find(receipt => receipt.contract === 'study-harness.stage-receipt' && (receipt as { toStage: string }).toStage === 'explore-curvature')!;
      const events = h.host.events(ACTIVITY);
      const changed = events.filter(event => event.type === 'stage.changed').at(-1)!;
      expect(changed.payload).toMatchObject({ fromStage: 'explore-step', toStage: 'explore-curvature', receiptId: stageReceipt.receiptId, activityRevision: stageReceipt.activityRevision });
      expect(events.some(event => event.type === 'reveal.authorized' && event.payload.exposureId === held.exposureId && event.payload.receiptId === held.receiptId)).toBe(true);
      expect(events.some(event => event.type === 'reveal.uncertain' && event.payload.exposureId === held.exposureId)).toBe(true);
      const summary = h.adapter.summarizeInteraction(ACTIVITY, { audience: 'host' }) as { revealed: { exposureId: string }[] };
      const ledger = stateOf(h.adapter).exposures.map(record => record.exposureId);
      expect(ledger).toContain(held.exposureId);
      expect(summary.revealed.map(item => item.exposureId).sort()).toEqual([...ledger].sort());
      expect(opened.control.freezeAssistanceSnapshot({ responseId: 'answer-1' }).exposures.map(record => record.exposureId)).toEqual(ledger);
      expectValidEvents(events);
      // The adopted grant is history: the next step is based on the host's revision and succeeds.
      okOf(await opened.learner.requestHelp({ operationId: op('help'), ...activityGuard(opened.learner) }));
    });
  }

  it('verifyReceipt refuses a grant reusing an exposure ID another receipt holds and accepts the same receipt replayed', () => {
    const groups = [{ groupId: 'trace', contentDigest: DIGESTS.trace! }];
    const expected = {
      kind: 'exposure' as const, activityId: ACTIVITY, idempotencyKey: 'op-1', basedOnActivityRevision: 0, policy: { policyId: 'policy-1', revision: 1 }, template: TEMPLATE, model: MODEL,
      groups, hostNow: null, fingerprint: 'request-1', scope: 'reveal' as const, intendedStage: 'free-explore',
    };
    const receipt = {
      contract: 'study-harness.exposure-receipt', schemaVersion: '1.0', receiptId: 'rcpt-2', activityId: ACTIVITY, basedOnActivityRevision: 0, activityRevision: 1, policyId: 'policy-1', policyRevision: 1,
      idempotencyKey: 'op-1', template: TEMPLATE, model: MODEL, issuedAt: '2026-10-26T09:00:00.000Z', expiresAt: null, intendedStage: 'free-explore', grant: { exposureId: 'exp-1', scope: 'reveal', groups },
    };
    const refused = verifyReceipt(receipt, expected, new Map(), id => id === 'exp-1' ? 'rcpt-1' : null);
    expect(refused.ok ? null : refused.diagnostic).toMatchObject({ code: 'RECEIPT_MISMATCH', path: '$.receipt.grant.exposureId' });
    expect(verifyReceipt(receipt, expected, new Map(), id => id === 'exp-1' ? 'rcpt-2' : null).ok).toBe(true);
    expect(verifyReceipt(receipt, expected, new Map()).ok).toBe(true);
  });
});

/** The installed catalogue whose status turns revoked when `state.revoked` is set (the catalogue authority revokes). */
function revocable(state: { revoked: boolean }) {
  return (createWorker: () => Worker): ActivityCatalog => {
    const base = createInstalledCatalog({ workerFactory: createWorker });
    return {
      listTemplates: () => base.listTemplates(), getTemplate: ref => base.getTemplate(ref), getModel: ref => base.getModel(ref), createWorker,
      status: (ref): CatalogEntryStatus => state.revoked ? { lifecycle: 'revoked', reviews: [], revoked: true, revocationReason: 'Withdrawn.' } : base.status(ref),
    };
  };
}

describe('a kept authorization is resent only with standing (R03)', () => {
  it('retryPersistence after a catalogue revocation reports CONTENT_REVOKED, resends nothing and shows nothing', async () => {
    const state = { revoked: false };
    const h = make({ customCatalog: revocable(state) });
    const opened = await open(h);
    await settled(h);
    h.host.failNext('requestStageTransition', 'throw');
    expect(codesOf(await opened.control.requestStageTransition({ operationId: op('stage'), ...activityGuard(opened.learner), toStage: 'explore-step' }))).toEqual(['PERSISTENCE_FAILED']);
    expect(opened.learner.getProjection().pendingReveal?.state).toBe('failed');
    state.revoked = true;
    const calls = h.host.calls('requestStageTransition').length;
    const retried = await opened.learner.retryPersistence({ operationId: op('retry') });
    expect(codesOf(retried)).toEqual(['CONTENT_REVOKED']);
    expect(h.host.calls('requestStageTransition')).toHaveLength(calls);
    const projection = opened.learner.getProjection();
    expect(projection.stage.id).toBe('predict');
    expect(projection.views).toEqual([]);
    expect(projection.pendingReveal).toBeNull();
    await settled(h);
    const types = h.host.events(ACTIVITY).map(event => event.type);
    expect(types).toContain('content.revoked');
    expect(types).not.toContain('stage.changed');
    expect(h.host.exposures(ACTIVITY)).toEqual([]);
  });

  it('a receipt that arrives after the catalogue revoked the content is not applied; the host commitment is kept as history', async () => {
    const state = { revoked: false };
    const late = lateReplies('requestStageTransition');
    const h = make({ customCatalog: revocable(state), port: late.port });
    const opened = await open(h);
    await settled(h);
    const transition = opened.control.requestStageTransition({ operationId: op('stage'), ...activityGuard(opened.learner), toStage: 'explore-step' });
    await until(() => h.host.activity(ACTIVITY)?.stage === 'explore-step');
    state.revoked = true;
    late.release();
    expect(codesOf(await transition)).toEqual(['CONTENT_REVOKED']);
    expect(opened.learner.getProjection().views).toEqual([]);
    expect(stateOf(h.adapter).exposures).toEqual([expect.objectContaining({ scope: 'stage', displayStatus: 'authorized' })]);
    expect(stateOf(h.adapter).guards.activityRevision).toBe(1);
  });
});

describe('journal losses carried onto a shorter host journal keep every later backup valid (R05)', () => {
  it('restoring onto a host store from an older copy records the loss after the host cursor; later backups save', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    await settled(h);
    const early = h.host.snapshot();
    for (const eta of [0.2, 0.3, 0.4]) { okOf(await opened.learner.commitParameters({ operationId: op(), ...opened.learner.getProjection().guards, displayValues: { eta } })); await settled(h); }
    h.host.failNext('appendEvents', 'throw', { times: 50 });
    okOf(await opened.learner.commitParameters({ operationId: op(), ...opened.learner.getProjection().guards, displayValues: { eta: 0.9 } }));
    await new Promise(resolve => setTimeout(resolve, 20));
    const artifact = await backup(opened);
    expect(artifact.journal.pendingEventIds.length).toBeGreaterThan(0);
    h.adapter.dispose();
    const host = MemoryHost.fromSnapshot(early);
    const adapter = createStudyHarnessAdapter({ catalog: h.catalog, host });
    disposers.push(() => adapter.dispose());
    const result = await adapter.restore(artifact, { operationId: op('restore'), hostSessionRevision: 0 });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    const cursor = (await host.getJournalCursor({ activityId: ACTIVITY })).lastSequence;
    expect(cursor).toBeLessThan(artifact.journal.cursor.lastSequence);
    expect(result.report.notes.join(' ')).toMatch(/could not be recovered \(the host journal ends before the checkpoint\); the loss is recorded in the journal after sequence/);
    await until(() => host.events(ACTIVITY).some(event => event.type === 'artifact.restored'));
    const marker = host.events(ACTIVITY).find(event => event.type === 'operation.failed' && event.payload.lost);
    expect((marker!.payload.lost as { afterSequence: number }).afterSequence).toBeLessThanOrEqual(cursor);
    for (let i = 0; i < 2; i++) {
      const saved = await result.prepared.host.save({ operationId: op('save'), kind: 'backup' });
      if (!saved.ok) throw new Error(JSON.stringify(saved.diagnostics));
      expect(saved.artifact.journal.lost!.afterSequence).toBeLessThanOrEqual(saved.artifact.journal.cursor.lastSequence + saved.artifact.journal.pendingEventIds.length);
    }
    expect((adapter.summarizeInteraction(ACTIVITY, { audience: 'host' }) as { complete: boolean }).complete).toBe(false);
  });
});

describe('a restored permitted selection is kept (R30, A38)', () => {
  it('keeps a selection whose target the restored projection offers, and clears one it does not, with a note', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    okOf(opened.learner.select({ operationId: op(), ...presentationGuard(opened.learner), target: 'landscape' }));
    okOf(opened.learner.setLayout({ operationId: op(), ...presentationGuard(opened.learner), layout: 'side' }));
    const artifact = await backup(opened);
    expect(artifact.presentation.selection).toBe('landscape');
    await settled(h);
    h.adapter.dispose();
    const fresh = freshProcess(h);
    const { result, learner } = await restored(fresh.adapter, artifact);
    expect(result.report.restored).toBe('exact');
    expect(result.report.notes.join(' ')).not.toMatch(/Presentation state was restricted/);
    expect(learner.getProjection().presentation).toMatchObject({ selection: 'landscape', layout: 'side' });
    fresh.adapter.dispose();
    // A selection of content the restored projection does not show (no grant counts for it here) is cleared.
    const hidden = forged(artifact, body => { body.presentation = { ...body.presentation, selection: 'regime' }; });
    const again = freshProcess(h);
    const second = await restored(again.adapter, hidden);
    expect(second.learner.getProjection().presentation.selection).toBeNull();
    expect(second.result.report.notes).toContain('Presentation state was restricted to the current views, units and visible content.');
  });
});
