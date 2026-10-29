/**
 * HostPort refusal convention (activity-runtime §10; report §6.3, §7.2; A21, A49): a host method that rejects with a
 * refusal code (POLICY_DENIED, POLICY_EXPIRED, CONTENT_REVOKED, STALE_POLICY_REVISION, INVALID_INPUT) decided against
 * the request. The adapter reports that code at `$.host`, keeps nothing pending, never retries it and records no
 * uncertainty. Every other rejection stays a retryable PERSISTENCE_FAILED. Fixture-host results (test-only memory host).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyHostFailure, HOST_REFUSAL_CODES, HOST_REFUSAL_PATH, hostRefusal, isHostRefusal, isHostRefusalDiagnostic,
  type ActivityInstance, type HostPort, type StageTransitionRequest,
} from '@explorable-models/activity';
import { activityGuard, ackCurrent, codesOf, enterExplore, guards, harness, okOf, op, open, requestFor, settled, type Harness } from './support/adapter-harness.js';
import { MemoryHost, MemoryHostError } from './support/memory-host.js';

const ACTIVITY = 'act-quadratic-1';
let current: Harness | null = null;
const make = (...args: Parameters<typeof harness>) => (current = harness(...args));
afterEach(() => { current?.adapter.dispose(); current = null; });

/** Host port that forwards to the memory host but answers chosen methods with `answer` (test double). */
function overriding(host: MemoryHost, answers: Partial<Record<keyof HostPort, () => Promise<never>>>): HostPort {
  const forward = <K extends keyof HostPort>(method: K) => ((request: never) => (answers[method] ?? ((value: never) => (host[method] as (input: never) => Promise<unknown>).call(host, value)))(request)) as HostPort[K];
  return {
    getPolicy: forward('getPolicy'), registerActivity: forward('registerActivity'), requestStageTransition: forward('requestStageTransition'),
    recordExposureIntent: forward('recordExposureIntent'), recordDisplayAck: forward('recordDisplayAck'), recordAssistance: forward('recordAssistance'),
    appendEvents: forward('appendEvents'), getJournalCursor: forward('getJournalCursor'), saveArtifact: forward('saveArtifact'),
  };
}
const failedEvents = (h: Harness) => h.host.events(ACTIVITY).filter(event => event.type === 'operation.failed').map(event => event.payload);

describe('refusal helpers', () => {
  it('recognise a refusal by its code on an error or a plain object, and nothing else', () => {
    expect([...HOST_REFUSAL_CODES]).toEqual(['POLICY_DENIED', 'POLICY_EXPIRED', 'CONTENT_REVOKED', 'STALE_POLICY_REVISION', 'INVALID_INPUT']);
    for (const code of HOST_REFUSAL_CODES) {
      const error = hostRefusal(code, 'decided');
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ code, message: 'decided', name: 'HostRefusal' });
      expect(isHostRefusal(error)).toBe(true);
      expect(isHostRefusal({ code, message: 'from a native bridge' })).toBe(true);
    }
    for (const value of [null, undefined, 'POLICY_DENIED', new Error('timeout'), { code: 'STALE_ACTIVITY_REVISION' }, { code: 'SCHEMA' }, { code: 'PERSISTENCE_FAILED' }, { code: 7 }]) {
      expect(isHostRefusal(value), JSON.stringify(value)).toBe(false);
    }
    const hostile = Object.defineProperty({}, 'code', { get() { throw new Error('getter'); } });
    expect(isHostRefusal(hostile)).toBe(false);
    expect(() => hostRefusal('NOT_FOUND' as never)).toThrow(RangeError);
  });

  it('the memory host refuses policy decisions with refusal codes and rejects other problems without them', async () => {
    const h = make();
    await open(h);
    await settled(h);
    const { instance } = h.host.calls('registerActivity')[0]!.request as { instance: ActivityInstance };
    const transition = (patch: Partial<StageTransitionRequest>): StageTransitionRequest => ({
      activityId: ACTIVITY, operationId: op(), idempotencyKey: op('key'), fromStage: instance.stage.id, toStage: 'explore-step', basedOnActivityRevision: 0,
      expectedPolicyRevision: h.host.policy().revision, actor: 'host', groups: [], template: instance.template, model: instance.model, ...patch,
    });
    const stale = await h.host.requestStageTransition(transition({ expectedPolicyRevision: h.host.policy().revision + 1 })).catch((error: unknown) => error);
    expect(stale).toBeInstanceOf(MemoryHostError);
    expect(stale).toMatchObject({ kind: 'refused', code: 'STALE_POLICY_REVISION' });
    expect(isHostRefusal(stale)).toBe(true);
    const wrongStage = await h.host.requestStageTransition(transition({ fromStage: 'explain' })).catch((error: unknown) => error);
    expect(wrongStage).toMatchObject({ kind: 'rejected', code: 'STALE_ACTIVITY_REVISION' });
    expect(isHostRefusal(wrongStage)).toBe(false);
    h.host.revokePolicy();
    expect(await h.host.requestStageTransition(transition({})).catch((error: unknown) => error)).toMatchObject({ kind: 'refused', code: 'POLICY_DENIED' });
  });
});

describe('the adapter maps refusals to their code without retry or uncertainty', () => {
  it('a refused stage transition fails with the host code, keeps nothing pending and is not resent', async () => {
    const h = make();
    const opened = await open(h);
    await settled(h);
    const before = opened.learner.getProjection();
    h.host.revokePolicy();
    const input = { operationId: op('stage'), ...activityGuard(opened.learner), toStage: 'explore-step' };
    const refused = await opened.control.requestStageTransition(input);
    expect(refused.ok ? [] : refused.diagnostics).toEqual([expect.objectContaining({ code: 'POLICY_DENIED', path: HOST_REFUSAL_PATH })]);
    expect(refused.ok ? false : isHostRefusalDiagnostic(refused.diagnostics[0]!)).toBe(true);
    const projection = opened.learner.getProjection();
    expect(projection.pendingReveal).toBeNull();
    expect(projection.activityRevision).toBe(before.activityRevision);
    expect(projection.views.map(view => view.viewId)).not.toContain('trace-plot');
    // The refusal refreshed the policy: the revoked host policy now governs the card (no awaiting-persistence state).
    expect(projection.status.ui).toBe('stale-policy');
    await settled(h);
    expect(failedEvents(h)).toEqual([{ operation: 'requestStageTransition', code: 'POLICY_DENIED', recoverable: false }]);
    // Neither a retry nor the same operation contacts the host again.
    await opened.learner.retryPersistence({ operationId: op() });
    expect(codesOf(await opened.control.requestStageTransition(input))).toEqual(['POLICY_DENIED']);
    expect(h.host.calls('requestStageTransition')).toHaveLength(1);
    expect(h.host.exposures(ACTIVITY)).toEqual([]);
  });

  it('a stale policy revision at the host is reported as such and the newer policy is adopted', async () => {
    const h = make();
    const opened = await open(h, requestFor({ stageId: 'free-explore' }));
    await settled(h);
    const amended = h.host.amendPolicy({});
    const refused = await opened.control.requestReveal({ operationId: op(), ...activityGuard(opened.learner), groups: ['trace'] });
    expect(codesOf(refused)).toEqual(['STALE_POLICY_REVISION']);
    expect(opened.learner.getProjection().policyRevision).toBe(amended.revision);
    expect(opened.learner.getProjection().pendingReveal).toBeNull();
  });

  it('an injected refusal code is final while a failed write stays retryable', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    h.host.failNext('recordAssistance', 'reject', { code: 'INVALID_INPUT' });
    const refused = await opened.control.requestReveal({ operationId: op(), ...activityGuard(opened.learner), groups: ['trace'] });
    expect(refused.ok).toBe(true);
    const help = await opened.learner.requestHelp({ operationId: op('help'), ...activityGuard(opened.learner) });
    // Learner bindings see the learner vocabulary; the code is the host's.
    expect(codesOf(help)).toEqual(['INVALID_INPUT']);
    expect(opened.learner.getProjection().status.ui).not.toBe('awaiting-persistence');
    await opened.learner.retryPersistence({ operationId: op() });
    expect(h.host.calls('recordAssistance').map(call => call.outcome)).toEqual(['rejected']);
    h.host.failNext('recordAssistance', 'throw');
    expect(codesOf(await opened.learner.requestHelp({ operationId: op('help'), ...activityGuard(opened.learner) }))).toEqual(['PERSISTENCE_FAILED']);
    okOf(await opened.learner.retryPersistence({ operationId: op() }));
    expect(h.host.calls('recordAssistance').map(call => call.outcome)).toEqual(['rejected', 'failed', 'ok']);
  });

  it('a refused display acknowledgement keeps the display, is not retried and records no uncertainty', async () => {
    const h = make({ port: host => overriding(host, { recordDisplayAck: () => Promise.reject({ code: 'POLICY_DENIED', message: 'not recorded' }) }) });
    const opened = await open(h);
    await settled(h);
    okOf(await opened.control.requestStageTransition({ operationId: op('stage'), ...activityGuard(opened.learner), toStage: 'explore-step' }));
    await settled(h);
    ackCurrent(opened.learner);
    await settled(h);
    const exposures = () => (h.adapter.getState(ACTIVITY, 'host') as { exposures: { displayStatus: string; uncertainty?: unknown }[] }).exposures;
    expect(exposures()).toEqual([expect.objectContaining({ displayStatus: 'displayed' })]);
    expect(exposures()[0]).not.toHaveProperty('uncertainty');
    expect(opened.learner.getProjection().status.ui).not.toBe('awaiting-persistence');
    expect(failedEvents(h)).toEqual([{ operation: 'recordDisplayAck', code: 'POLICY_DENIED', recoverable: false }]);
    expect(h.host.events(ACTIVITY).filter(event => event.type === 'reveal.uncertain')).toEqual([]);
    okOf(await opened.learner.retryPersistence({ operationId: op() }));
    await settled(h);
    expect(failedEvents(h)).toHaveLength(1);
  });

  it('a refused save stores nothing and the same operation is not retried', async () => {
    let saves = 0;
    const h = make({ port: host => overriding(host, { saveArtifact: () => { saves++; return Promise.reject(hostRefusal('POLICY_EXPIRED', 'expired')); } }) });
    const opened = await open(h);
    await settled(h);
    const operationId = op('save');
    const refused = await opened.control.save({ operationId, kind: 'backup' });
    expect(refused.ok ? [] : refused.diagnostics).toEqual([expect.objectContaining({ code: 'POLICY_EXPIRED', path: HOST_REFUSAL_PATH })]);
    expect(codesOf(await opened.control.save({ operationId, kind: 'backup' }))).toEqual(['POLICY_EXPIRED']);
    expect(saves).toBe(1);
    await settled(h);
    expect(failedEvents(h)).toEqual([{ operation: 'saveArtifact', code: 'POLICY_EXPIRED', recoverable: false }]);
    okOf(opened.learner.pause({ operationId: op(), ...guards(opened.learner) }));
  });

  it('prepare reports a refused policy lookup or registration with the host code', async () => {
    const denied = make({ port: host => overriding(host, { getPolicy: () => Promise.reject(hostRefusal('POLICY_DENIED')) }) });
    const first = await denied.adapter.prepare(requestFor(), { operationId: op('prepare') });
    expect(first.ok ? [] : first.diagnostics).toEqual([expect.objectContaining({ code: 'POLICY_DENIED', path: HOST_REFUSAL_PATH })]);
    denied.adapter.dispose();
    const unregistered = make({ port: host => overriding(host, { registerActivity: () => Promise.reject({ code: 'CONTENT_REVOKED' }) }) });
    expect(codesOf(await unregistered.adapter.prepare(requestFor(), { operationId: op('prepare') }) as never)).toEqual(['CONTENT_REVOKED']);
  });

  it('a refused journal batch is a permanent failure: kept, not retried automatically', () => {
    for (const code of HOST_REFUSAL_CODES) expect(classifyHostFailure({ code, message: 'secret detail' })).toMatchObject({ permanent: true, diagnostic: { code: 'PERSISTENCE_FAILED', message: `The host rejected the journal batch (${code}).` } });
    expect(classifyHostFailure(new Error('socket closed'))).toMatchObject({ permanent: false });
  });
});
