/**
 * Persist-before-reveal (report §6.3, activity-runtime §4, D7): stage changes need valid host receipts (A22); crash
 * injection yields honest unseen/displayed/uncertain records across a simulated restart (A23); live preview needs an
 * exploration scope and cancellation keeps exposure without committing (A24); persistence failures recover without
 * duplicate reveal records (A20); undo, reset, cancel and restore never erase exposure (A19). Host behaviour comes
 * from the memory host double (fixture-host results).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createStudyHarnessAdapter, HOST_SUSPENDED_MESSAGE, UI_STATUS, type ExposureRecord, type HostPort, type InteractionEvent } from '@explorable-models/activity';
import {
  ackCurrent, activityGuard, authorizeExploration, codesOf, DIGESTS, enterExplore, expectValidEvents, guards, harness, okOf, op, open, requestFor, settled, until,
  type Harness, type Opened,
} from './support/adapter-harness.js';
import { MemoryHost } from './support/memory-host.js';

let current: Harness[] = [];
const make = (...args: Parameters<typeof harness>) => { const h = harness(...args); current.push(h); return h; };
afterEach(() => { for (const h of current) h.adapter.dispose(); current = []; });

const types = (events: InteractionEvent[]) => events.map(event => event.type);
const hostExposures = (h: Harness): ExposureRecord[] => (h.adapter.getState('act-quadratic-1', 'host') as { exposures: ExposureRecord[] }).exposures;
const views = (opened: Opened) => opened.learner.getProjection().views.map(view => view.viewId);

/** A port that delegates to the memory host but rewrites receipts before the adapter sees them. */
function tampering(rewrite: (receipt: Record<string, unknown>) => unknown): (host: MemoryHost) => HostPort {
  return host => ({
    getPolicy: request => host.getPolicy(request), registerActivity: request => host.registerActivity(request), recordDisplayAck: request => host.recordDisplayAck(request),
    appendEvents: request => host.appendEvents(request), getJournalCursor: request => host.getJournalCursor(request), saveArtifact: request => host.saveArtifact(request),
    requestStageTransition: async request => rewrite(structuredClone(await host.requestStageTransition(request)) as unknown as Record<string, unknown>) as never,
    recordExposureIntent: async request => rewrite(structuredClone(await host.recordExposureIntent(request)) as unknown as Record<string, unknown>) as never,
    recordAssistance: async request => rewrite(structuredClone(await host.recordAssistance(request)) as unknown as Record<string, unknown>) as never,
  });
}

describe('stage changes need valid host receipts (A22)', () => {
  it('applies a verified stage receipt: stage, activity revision and an authorized exposure', async () => {
    const h = make();
    const opened = await open(h);
    const projection = await enterExplore(h, opened);
    expect(projection.stage.id).toBe('explore-step');
    expect(projection.activityRevision).toBe(1);
    const [exposure] = hostExposures(h);
    expect(exposure).toMatchObject({ scope: 'stage', intendedStage: 'explore-step', displayStatus: 'displayed' });
    expect(exposure!.groups).toEqual([{ groupId: 'trace', contentDigest: DIGESTS.trace }, { groupId: 'observations', contentDigest: DIGESTS.observations }]);
    await settled(h);
    expect(types(h.host.events())).toEqual(['activity.prepared', 'activity.opened', 'parameters.committed', 'reveal.requested', 'stage.changed', 'reveal.authorized', 'reveal.displayed']);
    expect(h.host.exposures()[0]).toMatchObject({ displayStatus: 'displayed', displayed: { projectionDigest: exposure!.displayed!.projectionDigest } });
  });

  it('refuses stale guards and undeclared transitions before contacting the host', async () => {
    const h = make();
    const opened = await open(h);
    await settled(h);
    const guard = activityGuard(opened.learner);
    expect(codesOf(await opened.control.requestStageTransition({ operationId: op(), ...guard, expectedActivityRevision: 7, toStage: 'explore-step' }))).toEqual(['STALE_ACTIVITY_REVISION']);
    expect(codesOf(await opened.control.requestStageTransition({ operationId: op(), ...guard, expectedPolicyRevision: 0, toStage: 'explore-step' }))).toEqual(['STALE_POLICY_REVISION']);
    expect(codesOf(await opened.control.requestStageTransition({ operationId: op(), ...guard, toStage: 'free-explore' }))).toEqual(['INVALID_REFERENCE']);
    expect(h.host.calls('requestStageTransition')).toHaveLength(0);
  });

  const forgeries: [string, (receipt: Record<string, unknown>) => unknown, string][] = [
    ['another idempotency key', r => ({ ...r, idempotencyKey: 'forged-key' }), 'RECEIPT_MISMATCH'],
    ['another activity', r => ({ ...r, activityId: 'act-other' }), 'RECEIPT_MISMATCH'],
    ['another base revision', r => ({ ...r, basedOnActivityRevision: 5 }), 'RECEIPT_MISMATCH'],
    ['a non-increasing revision', r => ({ ...r, activityRevision: 0 }), 'RECEIPT_MISMATCH'],
    ['another template digest', r => ({ ...r, template: { ...(r.template as object), digest: 'sha256:' + 'f'.repeat(64) } }), 'RECEIPT_MISMATCH'],
    ['another target stage', r => ({ ...r, toStage: 'explore-curvature' }), 'RECEIPT_MISMATCH'],
    ['a wrong content digest', r => ({ ...r, grant: { ...(r.grant as object), groups: [{ groupId: 'trace', contentDigest: 'sha256:' + '1'.repeat(64) }, { groupId: 'observations', contentDigest: DIGESTS.observations }] } }), 'RECEIPT_MISMATCH'],
    ['a missing group', r => ({ ...r, grant: { ...(r.grant as object), groups: [{ groupId: 'trace', contentDigest: DIGESTS.trace }] } }), 'RECEIPT_MISMATCH'],
    ['an extra group', r => ({ ...r, grant: { ...(r.grant as object), groups: [...(r.grant as { groups: object[] }).groups, { groupId: 'regime', contentDigest: DIGESTS.regime }] } }), 'RECEIPT_MISMATCH'],
    ['no grant', r => ({ ...r, grant: null }), 'RECEIPT_MISMATCH'],
    ['an unknown field', r => ({ ...r, approvedBy: 'self' }), 'RECEIPT_MISMATCH'],
    ['a newer policy revision', r => ({ ...r, policyRevision: 2 }), 'STALE_POLICY_REVISION'],
  ];
  for (const [name, rewrite, code] of forgeries) {
    it(`a receipt with ${name} fails with ${code} and shows nothing`, async () => {
      const h = make({ port: tampering(rewrite) });
      const opened = await open(h);
      await settled(h);
      expect(codesOf(await opened.control.requestStageTransition({ operationId: op(), ...activityGuard(opened.learner), toStage: 'explore-step' }))).toEqual([code]);
      const projection = opened.learner.getProjection();
      expect(projection.stage.id).toBe('predict');
      expect(projection.activityRevision).toBe(0);
      expect(projection.pendingReveal).toBeNull();
      expect(views(opened)).not.toContain('trace-plot');
      expect(hostExposures(h)).toEqual([]);
      await settled(h);
      expect(types(h.host.events())).not.toContain('stage.changed');
      expect(types(h.host.events())).not.toContain('reveal.authorized');
    });
  }

  // R04: a receipt that binds the request exactly but has expired by host time is never displayed. The host committed it,
  // so the adapter follows the host-owned stage and activity revision and keeps the grant as history that never counts;
  // on a trailing revision every later host-authorized step would be refused (activity-runtime §2: the adapter never
  // diverges from the host-owned counter).
  it('a receipt with an expired authorization fails with POLICY_EXPIRED and shows nothing; the adapter follows the host and keeps the grant as history', async () => {
    let first = true;
    const h = make({ port: tampering(r => { if (!first) return r; first = false; return { ...r, expiresAt: '2026-10-26T08:00:00.000Z' }; }) });
    const opened = await open(h);
    await settled(h);
    expect(codesOf(await opened.control.requestStageTransition({ operationId: op(), ...activityGuard(opened.learner), toStage: 'explore-step' }))).toEqual(['POLICY_EXPIRED']);
    const projection = opened.learner.getProjection();
    expect(h.host.activity('act-quadratic-1')).toEqual({ stage: 'explore-step', activityRevision: 1 });
    expect(projection.stage.id).toBe('explore-step');
    expect(projection.activityRevision).toBe(1);
    expect(projection.pendingReveal).toBeNull();
    expect(views(opened)).not.toContain('trace-plot');
    expect(hostExposures(h)).toEqual([expect.objectContaining({ scope: 'stage', displayStatus: 'authorized', groups: [{ groupId: 'trace', contentDigest: DIGESTS.trace }, { groupId: 'observations', contentDigest: DIGESTS.observations }] })]);
    expect(opened.control.freezeAssistanceSnapshot({ responseId: 'answer-expired' })).toMatchObject({ exposures: [expect.objectContaining({ scope: 'stage' })], complete: true });
    // The next host-authorized step is based on the host's revision: a reveal is authorized and only then shown.
    okOf(await opened.control.requestReveal({ operationId: op(), ...activityGuard(opened.learner), groups: ['trace'] }));
    expect(views(opened)).toContain('trace-plot');
    expect(opened.learner.getProjection().activityRevision).toBe(2);
    await settled(h);
    const events = h.host.events();
    expectValidEvents(events);
    expect(types(events).filter(type => type === 'stage.changed')).toHaveLength(1);
    expect(types(events).filter(type => type === 'reveal.authorized')).toHaveLength(2);
  });

  it('refuses a reused receipt ID on a reveal', async () => {
    const seen: string[] = [];
    const h = make({ port: tampering(receipt => { seen.push(receipt.receiptId as string); return seen.length > 1 ? { ...receipt, receiptId: seen[0] } : receipt; }) });
    const opened = await open(h, requestFor({ stageId: 'free-explore' }));
    await settled(h);
    okOf(await opened.control.requestReveal({ operationId: op(), ...activityGuard(opened.learner), groups: ['trace'] }));
    await settled(h);
    ackCurrent(opened.learner);
    await settled(h);
    expect(codesOf(await opened.control.requestReveal({ operationId: op(), ...activityGuard(opened.learner), groups: ['observations'] }))).toEqual(['RECEIPT_MISMATCH']);
    expect(opened.learner.getProjection().views.flatMap(view => view.values).map(item => item.quantityId)).not.toContain('position');
  });

  it('fails before any host call when the policy is revoked or the content revoked', async () => {
    const h = make();
    const opened = await open(h);
    await settled(h);
    okOf(await opened.control.revoke({ operationId: op(), reason: 'Host revoked the activity.' }));
    expect(opened.learner.getProjection().status.ui).toBe('stale-policy');
    expect(opened.learner.getProjection().views).toEqual([]);
    expect(codesOf(await opened.control.requestStageTransition({ operationId: op(), ...activityGuard(opened.learner), toStage: 'explore-step' }))).toEqual(['POLICY_DENIED']);
    expect(h.host.calls('requestStageTransition')).toHaveLength(0);
    const revoked = make({ catalog: { revocations: [{ kind: 'template', id: 'quadratic-gradient-descent', version: '1.0.0', reason: 'Withdrawn.' }] } });
    expect(codesOf(await revoked.adapter.prepare(requestFor(), { operationId: op() }))).toEqual(['CONTENT_REVOKED']);
  });
});

describe('display acknowledgement', () => {
  it('accepts only the exact published digest from a registered, visible, non-suspended surface', async () => {
    const h = make();
    const opened = await open(h);
    await settled(h);
    okOf(await opened.control.requestStageTransition({ operationId: op(), ...activityGuard(opened.learner), toStage: 'explore-step' }));
    await settled(h);
    const projection = opened.learner.getProjection();
    opened.learner.acknowledgeDisplay({ projectionId: projection.projectionId, projectionDigest: 'sha256:' + '2'.repeat(64), surfaceId: 'surface-main' });
    opened.learner.acknowledgeDisplay({ projectionId: projection.projectionId, projectionDigest: projection.projectionDigest, surfaceId: 'unregistered' });
    opened.learner.reportVisibility({ surfaceId: 'surface-main', visible: false });
    expect(opened.learner.getProjection().status.ui).toBe('suspended');
    opened.learner.acknowledgeDisplay({ projectionId: projection.projectionId, projectionDigest: projection.projectionDigest, surfaceId: 'surface-main' });
    await settled(h);
    expect(hostExposures(h)[0]!.displayStatus).toBe('authorized');
    expect(h.host.calls('recordDisplayAck')).toHaveLength(0);
    opened.learner.reportVisibility({ surfaceId: 'surface-main', visible: true });
    ackCurrent(opened.learner);
    await settled(h);
    expect(hostExposures(h)[0]!.displayStatus).toBe('displayed');
    expect(h.host.calls('recordDisplayAck')).toHaveLength(1);
    expect(types(h.host.events()).filter(type => type.startsWith('activity.'))).toEqual(['activity.prepared', 'activity.opened', 'activity.suspended', 'activity.resumed']);
  });

  it('a failed acknowledgement keeps the exposure displayed with uncertainty until a retry persists it (A20)', async () => {
    const h = make();
    const opened = await open(h);
    await settled(h);
    okOf(await opened.control.requestStageTransition({ operationId: op(), ...activityGuard(opened.learner), toStage: 'explore-step' }));
    await settled(h);
    h.host.failNext('recordDisplayAck', 'throw');
    ackCurrent(opened.learner);
    await until(() => hostExposures(h)[0]?.uncertainty?.code === 'ACK_NOT_PERSISTED');
    expect(hostExposures(h)[0]!.displayStatus).toBe('displayed');
    expect(opened.learner.getProjection().status.ui).toBe('awaiting-persistence');
    okOf(await opened.learner.retryPersistence({ operationId: op() }));
    await until(() => hostExposures(h)[0]?.uncertainty === undefined);
    await settled(h);
    expect(h.host.exposures()[0]!.displayStatus).toBe('displayed');
    const events = h.host.events();
    expectValidEvents(events);
    expect(types(events).filter(type => type === 'reveal.displayed')).toHaveLength(1);
    expect(types(events).filter(type => type === 'reveal.uncertain')).toHaveLength(1);
  });
});

describe('persistence recovery without duplicate reveal records (A20)', () => {
  it('a failed exposure intent keeps the reveal pending; retry resends the same request once', async () => {
    const h = make();
    const opened = await open(h, requestFor({ stageId: 'free-explore' }));
    await settled(h);
    h.host.failNext('recordExposureIntent', 'throw');
    expect(codesOf(await opened.control.requestReveal({ operationId: op('reveal'), ...activityGuard(opened.learner), groups: ['trace', 'observations'] }))).toEqual(['PERSISTENCE_FAILED']);
    let projection = opened.learner.getProjection();
    expect(projection.pendingReveal).toEqual({ labels: ['Iteration trace', 'Current values'], state: 'failed' });
    expect(projection.status).toMatchObject({ ui: 'awaiting-persistence', recovery: { action: 'retry' } });
    expect(views(opened)).not.toContain('trace-plot');
    projection = okOf(await opened.learner.retryPersistence({ operationId: op() }));
    expect(projection.pendingReveal?.state).toBe('awaiting-display');
    expect(views(opened)).toContain('trace-plot');
    await settled(h);
    ackCurrent(opened.learner);
    await settled(h);
    const events = h.host.events();
    expectValidEvents(events);
    expect(types(events).filter(type => type === 'reveal.requested')).toHaveLength(1);
    expect(types(events).filter(type => type === 'reveal.authorized')).toHaveLength(1);
    expect(h.host.exposures()).toHaveLength(1);
    const keys = h.host.calls('recordExposureIntent').map(call => (call.request as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
  });

  it('an unacknowledged journal blocks transitions with PERSISTENCE_PENDING until it is reconciled', async () => {
    const h = make({ adapter: {} });
    const opened = await open(h);
    await settled(h);
    h.host.failNext('appendEvents', 'throw', { times: 2 });
    okOf(opened.learner.setLayout({ operationId: op(), expectedPresentationRevision: 0, layout: 'side' }));
    okOf(await opened.control.submitResponseRef({ operationId: op(), expectedHostSessionRevision: 0, hostSessionRevision: 1, response: { responseId: 'resp-1', taskId: 'task-1', taskRevision: 1, kind: 'prediction', modality: 'text', stageId: 'predict' } }));
    await until(() => (h.adapter.getState('act-quadratic-1', 'host') as { persistence: string }).persistence === 'pending-recovery');
    const blocked = await opened.control.requestStageTransition({ operationId: op(), ...activityGuard(opened.learner), toStage: 'explore-step' });
    expect(codesOf(blocked)).toEqual(['PERSISTENCE_PENDING']);
    expect(h.host.calls('requestStageTransition')).toHaveLength(0);
    await opened.control.reconcile();
    await settled(h);
    okOf(await opened.control.requestStageTransition({ operationId: op(), ...activityGuard(opened.learner), toStage: 'explore-step' }));
    await settled(h);
    const events = h.host.events();
    expectValidEvents(events);
    expect(types(events).filter(type => type === 'response.submitted')).toHaveLength(1);
  });

  it('a full outbox refuses evidence-bearing work instead of dropping it (backpressure)', async () => {
    const h = make({ adapter: { outboxLimit: 6 } });
    const opened = await open(h);
    await enterExplore(h, opened);
    h.host.failNext('appendEvents', 'throw', { times: 50 });
    let refused = null as string[] | null;
    for (let index = 1; index <= 8 && !refused; index++) {
      const outcome = await opened.learner.navigate({ operationId: op(), ...guards(opened.learner), position: { kind: 'index', index } });
      if (!outcome.ok) refused = codesOf(outcome);
    }
    expect(refused).toEqual(['PERSISTENCE_BACKPRESSURE']);
    const position = opened.learner.getProjection().frame!.position;
    const state = h.adapter.getState('act-quadratic-1', 'host') as { persistence: string };
    expect(state.persistence).toBe('pending-recovery');
    // Viewing already covered by acknowledged exposure continues.
    expect(views(opened)).toContain('trace-plot');
    expect(position).toMatchObject({ kind: 'index' });
  });
});

describe('crash injection across a simulated restart (A23)', () => {
  /** Host restart (durable tables only, then the host restart rule) followed by an adapter restore of `artifact`. */
  const restart = async (h: Harness, artifact: unknown) => {
    const host = h.host.restoreInto(new MemoryHost({ policy: h.host.policy() }));
    const interrupted = host.interruptUnacknowledged();
    const hostAtStart = host.exposures();
    const adapter = createStudyHarnessAdapter({ catalog: h.catalog, host });
    const restored = await adapter.restore(artifact, { operationId: op('restore'), hostSessionRevision: 0 });
    if (!restored.ok) throw new Error(JSON.stringify(restored.diagnostics));
    current.push({ ...h, host, adapter });
    return { host, adapter, prepared: restored.prepared, report: restored.report, interrupted, hostAtStart };
  };
  const backup = async (opened: Opened) => {
    const saved = await opened.control.save({ operationId: op('save'), kind: 'backup' });
    if (!saved.ok) throw new Error(JSON.stringify(saved.diagnostics));
    return saved.artifact;
  };

  it('crash before authorization: nothing recorded, nothing shown (unseen)', async () => {
    const h = make();
    const opened = await open(h, requestFor({ stageId: 'free-explore' }));
    await settled(h);
    const artifact = await backup(opened);
    await settled(h);
    h.host.crashAt('before-intent-commit');
    expect(codesOf(await opened.control.requestReveal({ operationId: op('reveal'), ...activityGuard(opened.learner), groups: ['trace'] }))).toEqual(['PERSISTENCE_FAILED']);
    expect(views(opened)).not.toContain('trace-plot');
    const after = await restart(h, artifact);
    expect(after.host.exposures()).toEqual([]);
    expect((after.adapter.getState('act-quadratic-1', 'host') as { exposures: ExposureRecord[] }).exposures).toEqual([]);
    expect(after.prepared.binding('learner', 'surface-2').getProjection().views.map(view => view.viewId)).not.toContain('trace-plot');
  });

  it('crash after the intent commit and before the reply: the host holds an unacknowledged grant; a retry with the same key reuses it', async () => {
    const h = make();
    const opened = await open(h, requestFor({ stageId: 'free-explore' }));
    await settled(h);
    const artifact = await backup(opened);
    await settled(h);
    h.host.crashAt('after-intent-commit-before-reply');
    const operationId = op('reveal');
    const guard = activityGuard(opened.learner);
    expect(codesOf(await opened.control.requestReveal({ operationId, ...guard, groups: ['trace'] }))).toEqual(['PERSISTENCE_FAILED']);
    expect(views(opened)).not.toContain('trace-plot');
    expect(h.host.exposures()).toEqual([expect.objectContaining({ displayStatus: 'authorized' })]);
    const after = await restart(h, artifact);
    const learner = after.prepared.binding('learner', 'surface-2');
    learner.registerSurface('surface-2');
    expect(learner.getProjection().views.map(view => view.viewId)).not.toContain('trace-plot');
    // The restore adopts the host-owned revision (R04): the guard read before the crash is stale; the same operation ID
    // resumes the committed authorization (the request is resent as it was issued, so the host replays its receipt).
    expect(learner.getProjection().activityRevision).toBe(guard.expectedActivityRevision + 1);
    expect(codesOf(await after.prepared.host.requestReveal({ operationId: op('stale'), ...guard, groups: ['trace'] }))).toEqual(['STALE_ACTIVITY_REVISION']);
    okOf(await after.prepared.host.requestReveal({ operationId, ...activityGuard(learner), groups: ['trace'] }));
    await new Promise(resolve => setTimeout(resolve, 5));
    ackCurrent(learner, 'surface-2');
    await until(() => after.host.exposures()[0]?.displayStatus === 'displayed');
    expect(after.host.exposures()).toHaveLength(1);
    expect(after.host.receipts()).toHaveLength(1);
    await new Promise(resolve => setTimeout(resolve, 5));
    const events = after.host.events();
    expectValidEvents(events);
    expect(types(events).filter(type => type === 'reveal.authorized')).toHaveLength(1);
  });

  it('crash after display and before the acknowledgement is persisted: displayed and uncertain, never unseen', async () => {
    const h = make();
    const opened = await open(h);
    await settled(h);
    okOf(await opened.control.requestStageTransition({ operationId: op(), ...activityGuard(opened.learner), toStage: 'explore-step' }));
    await settled(h);
    h.host.crashAt('after-ack-commit-before-reply');
    ackCurrent(opened.learner);
    await until(() => hostExposures(h)[0]?.uncertainty?.code === 'ACK_NOT_PERSISTED');
    expect(hostExposures(h)[0]!.displayStatus).toBe('displayed');
    expect(h.host.snapshot().activities['act-quadratic-1']!.exposures[0]!.displayStatus).toBe('displayed');
  });

  /** Enters explore-step, acknowledges the revealing projection with the acknowledgement held back by the host, and takes a checkpoint while it is in flight. */
  const displayedWithAckInFlight = async (h: Harness, crash: 'before-ack-commit' | 'after-ack-commit-before-reply') => {
    const opened = await open(h);
    await settled(h);
    okOf(await opened.control.requestStageTransition({ operationId: op(), ...activityGuard(opened.learner), toStage: 'explore-step' }));
    await settled(h);
    h.host.delay('recordDisplayAck', 50).crashAt(crash);
    ackCurrent(opened.learner);
    const artifact = await backup(opened);
    await until(() => h.host.crashed);
    const sent = h.host.calls('recordDisplayAck');
    expect(sent).toHaveLength(1);
    return { opened, artifact: artifact as { exposures: ExposureRecord[] }, sent: sent[0]!.request };
  };

  it('crash after display while the acknowledgement is in flight and before the host commits it: the checkpoint says so; the restored adapter resends the same acknowledgement and the host records it after its restart uncertainty (A23)', async () => {
    const h = make();
    const { artifact, sent } = await displayedWithAckInFlight(h, 'before-ack-commit');
    // The checkpoint never claims an acknowledgement the host has not confirmed.
    expect(artifact.exposures).toEqual([expect.objectContaining({ displayStatus: 'displayed', uncertainty: expect.objectContaining({ code: 'ACK_NOT_PERSISTED' }) })]);
    expect(h.host.exposures()).toEqual([expect.objectContaining({ displayStatus: 'authorized' })]);
    const before = h.host.events().length;
    const after = await restart(h, artifact);
    // The host restart rule: authorized without a committed acknowledgement becomes uncertain (potentially seen).
    expect(after.interrupted).toEqual([artifact.exposures[0]!.exposureId]);
    expect(after.hostAtStart).toEqual([expect.objectContaining({ displayStatus: 'uncertain', uncertainty: expect.objectContaining({ code: 'INTERRUPTED_BEFORE_ACK' }) })]);
    // The displayed content stays displayed and visible; the same acknowledgement (original display identity) is resent.
    expect(after.prepared.binding('learner', 'surface-2').getProjection().views.map(view => view.viewId)).toContain('trace-plot');
    expect(after.report.notes.join(' ')).toMatch(/acknowledgements are resent/);
    await until(() => after.host.exposures()[0]?.displayStatus === 'displayed');
    expect(after.host.calls('recordDisplayAck').map(call => call.request)).toEqual([sent]);
    expect(after.host.calls('recordDisplayAck').map(call => call.outcome)).toEqual(['ok']);
    expect(after.host.exposures()[0]!.displayed).toEqual(artifact.exposures[0]!.displayed);
    await until(() => (after.adapter.getState('act-quadratic-1', 'host') as { exposures: ExposureRecord[] }).exposures[0]?.uncertainty === undefined);
    expect((after.adapter.getState('act-quadratic-1', 'host') as { exposures: ExposureRecord[] }).exposures).toEqual([expect.objectContaining({ displayStatus: 'displayed' })]);
    expect(after.prepared.binding('learner', 'surface-2').getProjection().status.ui).not.toBe('awaiting-persistence');
    await new Promise(resolve => setTimeout(resolve, 5));
    // Nothing is replayed: the restore adds only artifact.restored, no second reveal.
    expect(types(after.host.events().slice(before))).toEqual(['artifact.restored']);
  });

  it('crash after the host committed the in-flight acknowledgement and before its reply: the resent acknowledgement is the identical request, so the host replays it without a conflict (A23)', async () => {
    const h = make();
    const { artifact, sent } = await displayedWithAckInFlight(h, 'after-ack-commit-before-reply');
    expect(artifact.exposures).toEqual([expect.objectContaining({ displayStatus: 'displayed', uncertainty: expect.objectContaining({ code: 'ACK_NOT_PERSISTED' }) })]);
    expect(h.host.exposures()).toEqual([expect.objectContaining({ displayStatus: 'displayed' })]);
    const after = await restart(h, artifact);
    expect(after.interrupted).toEqual([]);
    await until(() => after.host.calls('recordDisplayAck').length === 1);
    await until(() => (after.adapter.getState('act-quadratic-1', 'host') as { exposures: ExposureRecord[] }).exposures[0]?.uncertainty === undefined);
    expect(after.host.calls('recordDisplayAck').map(call => [call.request, call.outcome])).toEqual([[sent, 'ok']]);
    expect(after.host.exposures()).toEqual([expect.objectContaining({ displayStatus: 'displayed' })]);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(after.host.events().filter(event => event.type === 'operation.failed')).toEqual([]);
  });

  it('a checkpoint taken after the host confirmed the acknowledgement records none as unconfirmed and a restore resends nothing', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    const artifact = await backup(opened) as { exposures: ExposureRecord[] };
    expect(artifact.exposures).toEqual([expect.objectContaining({ displayStatus: 'displayed' })]);
    expect(artifact.exposures[0]!.uncertainty).toBeUndefined();
    const after = await restart(h, artifact);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(after.host.calls('recordDisplayAck')).toEqual([]);
    expect(after.report.notes.join(' ')).not.toMatch(/acknowledgements are resent/);
  });

  it('an adapter restart after authorization and before any acknowledgement restores the exposure as uncertain without re-emitting reveals', async () => {
    const h = make();
    const opened = await open(h);
    await settled(h);
    okOf(await opened.control.requestStageTransition({ operationId: op(), ...activityGuard(opened.learner), toStage: 'explore-step' }));
    await settled(h);
    const artifact = await backup(opened);
    await settled(h);
    const before = h.host.events().length;
    const after = await restart(h, artifact);
    const records = (after.adapter.getState('act-quadratic-1', 'host') as { exposures: ExposureRecord[] }).exposures;
    expect(records).toEqual([expect.objectContaining({ displayStatus: 'uncertain', uncertainty: expect.objectContaining({ code: 'INTERRUPTED_BEFORE_ACK' }) })]);
    expect(after.report.notes.join(' ')).toMatch(/uncertain/);
    await new Promise(resolve => setTimeout(resolve, 5));
    const added = after.host.events().slice(before);
    expect(types(added)).toEqual(['artifact.restored']);
    // Potentially seen content is not re-requested: it remains visible under the uncertain grant.
    expect(after.prepared.binding('learner', 's').getProjection().views.map(view => view.viewId)).toContain('trace-plot');
  });
});

describe('exploration scope and previews (A24)', () => {
  it('requires an exploration scope; pointer moves never call the host; cancel keeps exposure and commits nothing', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    expect(codesOf(opened.learner.beginPreview({ operationId: op(), ...guards(opened.learner), gesture: 'pointer', parameter: 'eta' }))).toEqual(['POLICY_DENIED']);
    await authorizeExploration(h, opened);
    const base = guards(opened.learner);
    const started = okOf(opened.learner.beginPreview({ operationId: op(), ...base, gesture: 'pointer', parameter: 'eta' }));
    const previewId = started.preview!.previewId;
    await settled(h);
    const calls = h.host.calls().length;
    for (let index = 1; index <= 30; index++) {
      okOf(opened.learner.updatePreview({ operationId: op(), previewId, displayValues: { eta: 0.25 + index * 0.05 } }));
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    await until(() => opened.learner.getProjection().frame?.kind === 'tentative');
    expect(h.host.calls().length).toBe(calls);
    ackCurrent(opened.learner);
    okOf(opened.learner.cancelPreview({ operationId: op(), previewId, reason: 'escape' }));
    expect(guards(opened.learner)).toEqual(base);
    expect(opened.learner.getProjection().controls.find(control => control.parameter === 'eta')!.value).toBe(0.25);
    await settled(h);
    const exposures = hostExposures(h);
    expect(exposures.map(record => [record.scope, record.displayStatus])).toEqual([['stage', 'displayed'], ['exploration', 'displayed']]);
    const events = h.host.events();
    expectValidEvents(events);
    const observed = events.find(event => event.type === 'preview.observed')!;
    expect(observed.payload).toMatchObject({ previewId, outcome: 'cancelled' });
    const rendered = observed.payload.rendered as { params: Record<string, number>; frameId: string }[];
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThanOrEqual(20);
    expect(new TextEncoder().encode(JSON.stringify(observed.payload)).length).toBeLessThanOrEqual(8 * 1024);
    expect(events.find(event => event.type === 'preview.cancelled')!.payload).toEqual({ previewId, reason: 'escape' });
    expect(types(events).filter(type => type === 'parameters.committed')).toHaveLength(1);
  });

  it('commits only at gesture completion with fresh guards; pointer values clamp visibly inside the granted domain', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    await authorizeExploration(h, opened, { eta: [0, 1] });
    const previewId = okOf(opened.learner.beginPreview({ operationId: op(), ...guards(opened.learner), gesture: 'pointer', parameter: 'eta' })).preview!.previewId;
    const clamped = okOf(opened.learner.updatePreview({ operationId: op(), previewId, displayValues: { eta: 1.7 } }));
    expect(clamped.status.message).toMatch(/adjusted to the allowed range/);
    await until(() => opened.learner.getProjection().frame?.kind === 'tentative');
    const committed = okOf(await opened.learner.commitPreview({ operationId: op(), ...guards(opened.learner), previewId }));
    expect(committed.frame).toMatchObject({ kind: 'committed', position: { index: 0 } });
    expect(committed.controls.find(control => control.parameter === 'eta')!.value).toBe(1);
    const keyboard = okOf(opened.learner.beginPreview({ operationId: op(), ...guards(opened.learner), gesture: 'keyboard', parameter: 'eta' })).preview!.previewId;
    expect(codesOf(opened.learner.updatePreview({ operationId: op(), previewId: keyboard, displayValues: { eta: 1.7 } }))).toEqual(['OUT_OF_DOMAIN']);
    okOf(opened.learner.cancelPreview({ operationId: op(), previewId: keyboard, reason: 'blur' }));
    await settled(h);
    const commit = h.host.events().filter(event => event.type === 'parameters.committed').at(-1)!;
    expect(commit.payload).toMatchObject({ cause: 'commit', params: { eta: 1 }, previewId, gesture: 'pointer' });
  });

  it('suspension cancels the preview and pauses compute; resume has no catch-up', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    await authorizeExploration(h, opened);
    const previewId = okOf(opened.learner.beginPreview({ operationId: op(), ...guards(opened.learner), gesture: 'keyboard', parameter: 'eta' })).preview!.previewId;
    okOf(opened.learner.updatePreview({ operationId: op(), previewId, displayValues: { eta: 0.5 } }));
    okOf(opened.control.suspend({ operationId: op(), reason: 'collapsed' }));
    const suspended = opened.learner.getProjection();
    expect(suspended.status.ui).toBe('suspended');
    expect(suspended.preview).toBeNull();
    expect(suspended.frame?.kind).toBe('committed');
    expect(codesOf(await opened.learner.navigate({ operationId: op(), ...guards(opened.learner), position: { kind: 'index', index: 2 } }))).toEqual(['NOT_READY']);
    okOf(opened.control.resume({ operationId: op() }));
    expect(opened.learner.getProjection().frame?.position).toMatchObject({ index: 0 });
    expect(opened.learner.getProjection().navigation?.playing).toBe(false);
    await settled(h);
    expect(h.host.events().find(event => event.type === 'preview.cancelled')!.payload).toMatchObject({ previewId, reason: 'navigation' });
  });

  it('the suspended status names its reason: a host pause never claims the card is hidden', async () => {
    const h = make();
    const opened = await open(h);
    okOf(opened.control.suspend({ operationId: op(), reason: 'host' }));
    const byHost = opened.learner.getProjection().status;
    expect(byHost.ui).toBe('suspended');
    expect(byHost.message).toBe(HOST_SUSPENDED_MESSAGE);
    expect(byHost.message).toMatch(/^Paused by the host\./);
    expect(byHost.message).not.toMatch(/visible|hidden/);
    okOf(opened.control.resume({ operationId: op() }));
    expect(opened.learner.getProjection().status.ui).not.toBe('suspended');
    okOf(opened.control.suspend({ operationId: op(), reason: 'offscreen' }));
    const offscreen = opened.learner.getProjection().status;
    expect(offscreen.ui).toBe('suspended');
    expect(offscreen.message).toBe(UI_STATUS.suspended.message);
    expect(offscreen.message).toMatch(/^Paused while hidden\./);
    okOf(opened.control.resume({ operationId: op() }));
    // A surface that reports itself hidden (offscreen, collapsed, hidden page) is paused while hidden too.
    opened.learner.reportVisibility({ surfaceId: opened.surface, visible: false });
    expect(opened.learner.getProjection().status).toMatchObject({ ui: 'suspended', message: UI_STATUS.suspended.message });
    opened.learner.reportVisibility({ surfaceId: opened.surface, visible: true });
    await settled(h);
    expect(h.host.events().filter(event => event.type === 'activity.suspended').map(event => event.payload)).toEqual([{ reason: 'host' }, { reason: 'offscreen' }, { reason: 'hidden' }]);
  });
});

describe('exposure is never erased (A19)', () => {
  it('reset, undo-by-commit, cancellation and restore keep every exposure record', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    await authorizeExploration(h, opened);
    const snapshot = () => hostExposures(h).map(record => [record.exposureId, record.displayStatus]);
    const before = snapshot();
    okOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { eta: 0.5 } }));
    okOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { eta: 0.25 } }));
    okOf(await opened.learner.resetExperiment({ operationId: op(), ...guards(opened.learner) }));
    const previewId = okOf(opened.learner.beginPreview({ operationId: op(), ...guards(opened.learner), gesture: 'keyboard', parameter: 'eta' })).preview!.previewId;
    okOf(opened.learner.cancelPreview({ operationId: op(), previewId, reason: 'escape' }));
    expect(snapshot()).toEqual(before);
    await settled(h);
    const saved = await opened.control.save({ operationId: op(), kind: 'backup' });
    if (!saved.ok) throw new Error('save failed');
    await settled(h);
    h.adapter.dispose('act-quadratic-1');
    const restored = await h.adapter.restore(saved.artifact, { operationId: op(), hostSessionRevision: 0 });
    if (!restored.ok) throw new Error(JSON.stringify(restored.diagnostics));
    const after = (h.adapter.getState('act-quadratic-1', 'host') as { exposures: ExposureRecord[] }).exposures;
    expect(after.map(record => record.exposureId)).toEqual(before.map(([id]) => id));
    expect(after[0]!.displayStatus).toBe('displayed');
  });
});
