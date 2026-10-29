import { describe, expect, it } from 'vitest';
import type { EventType, HostPort, InteractionEvent, JournalCursor } from '../../packages/activity/src/contracts.js';
import {
  ACKNOWLEDGED_MIRROR_LIMIT, DEFAULT_HOST_TIMEOUT_MS, DEFAULT_PERSISTENCE_WAIT_MS, NON_EVIDENCE_EVENTS, PersistenceError, classifyHostFailure, commandCapacity, createOutbox,
  isEvidenceBearing, systemReserve, type OutboxOptions, type OutboxState, type Scheduler,
} from '../../packages/activity/src/journal.js';
import { createHostClock, policyStanding } from '../../packages/activity/src/policy.js';
import { EVENT_TYPES } from '../../packages/activity/src/schemas.js';
import { MESSAGE_EXEMPLARS, approvedPolicy, backupArtifact, event as exemplarEvent, predictInstance } from '../../packages/activity/fixtures-src/exemplars.js';
import { MemoryHost, MemoryHostError } from './support/memory-host.js';

const ACTIVITY = predictInstance.activityId;
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** Manual scheduler: timers fire only when the test advances time. */
function manualScheduler() {
  let now = 0, next = 0;
  const timers = new Map<number, { at: number; ms: number; callback: () => void }>();
  const scheduler: Scheduler & { delays(): number[]; advance(ms: number): Promise<void> } = {
    setTimeout(callback, ms) { const handle = ++next; timers.set(handle, { at: now + ms, ms, callback }); return handle; },
    clearTimeout(handle) { timers.delete(handle as number); },
    delays: () => [...timers.values()].map(timer => timer.ms),
    async advance(ms) {
      now += ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= now).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        timers.delete(due[0]);
        due[1].callback();
        await settle();
      }
    },
  };
  return scheduler;
}

/** Event with the exemplar envelope; payloads match each type's schema. */
function makeEvent(sequence: number, type: EventType = 'activity.opened', extra: Partial<InteractionEvent> = {}): InteractionEvent {
  const payload: Record<string, unknown> = type === 'view.changed' ? { change: 'camera', presentationRevision: sequence, viewId: 'plot' }
    : type === 'parameters.committed' ? { runId: `run-${sequence}`, previousRunId: null, params: { a: 1, eta: 0.5, x0: 8 }, cause: 'commit' }
      : { stageId: `stage-${sequence}` };
  return exemplarEvent(type, sequence, payload, extra);
}

async function setup(overrides: Partial<OutboxOptions> = {}, host = new MemoryHost({ policy: approvedPolicy })) {
  await host.registerActivity({ instance: predictInstance, operationId: 'op-register' });
  const changes: OutboxState[] = [];
  const scheduler = manualScheduler();
  const outbox = createOutbox({ host, activityId: ACTIVITY, limit: 16, onChange: state => changes.push(state), scheduler, timeoutMs: 0, ...overrides });
  return { host, outbox, changes, scheduler };
}
const appendAll = (outbox: ReturnType<typeof createOutbox>, events: InteractionEvent[]) => { for (const item of events) expect(outbox.append(item)).toEqual({ ok: true }); };
const ids = (events: InteractionEvent[]) => events.map(item => item.eventId);

describe('event classification', () => {
  it('treats every event type except presentation changes as evidence-bearing', () => {
    expect([...NON_EVIDENCE_EVENTS]).toEqual(['view.changed']);
    for (const type of EVENT_TYPES) expect(isEvidenceBearing(type), type).toBe(type !== 'view.changed');
  });

  it('classifies host refusals as permanent and transport failures as recoverable without echoing host text', () => {
    expect(classifyHostFailure({ code: 'SCHEMA', message: 'secret field x' })).toMatchObject({ permanent: true, diagnostic: { code: 'PERSISTENCE_FAILED' } });
    const transient = classifyHostFailure(new Error('socket closed: token=abc'));
    expect(transient.permanent).toBe(false);
    expect(JSON.stringify(transient)).not.toContain('token');
  });
});

describe('ordering, validation and attribution (A15)', () => {
  it('flushes in sequence order in batches of at most batchSize and acknowledges everything', async () => {
    const { host, outbox } = await setup({ limit: 128, batchSize: 32 });
    const events = Array.from({ length: 70 }, (_, index) => makeEvent(index + 1));
    appendAll(outbox, events);
    expect(outbox.state()).toMatchObject({ persistence: 'saving', pending: 70, acknowledgedThrough: 0 });
    await outbox.flush();
    expect(host.calls('appendEvents').map(call => (call.request as { events: unknown[] }).events.length)).toEqual([32, 32, 6]);
    expect(ids(host.events(ACTIVITY))).toEqual(ids(events));
    expect(outbox.state()).toEqual({ persistence: 'saved', pending: 0, acknowledgedThrough: 70, lastError: null, coalesced: 0 });
    expect(ids(outbox.acknowledgedEvents())).toEqual(ids(events));
    expect(outbox.checkpoint()).toEqual({ cursor: { activityId: ACTIVITY, lastSequence: 70, lastEventId: 'evt-0070', checkpointDigest: null }, pendingEventIds: [] });
  });

  it('keeps trusted attribution, revisions and frame references exactly as appended', async () => {
    const { host, outbox } = await setup();
    const tutor = makeEvent(1, 'activity.opened', { actor: { kind: 'tutor', binding: 'tool-executor-1' } });
    const host1 = makeEvent(2, 'stage.changed', { actor: { kind: 'host', binding: 'host-stage-button' }, payload: { fromStage: 'predict', toStage: 'explore', receiptId: 'rcpt-1', activityRevision: 3 } });
    const learner = makeEvent(3, 'parameters.committed', { frame: { frameId: 'frame-1', runId: 'run-3', kind: 'committed', position: { kind: 'index', index: 0, maxIndex: 1000 } } });
    appendAll(outbox, [tutor, host1, learner]);
    await outbox.flush();
    expect(host.events(ACTIVITY)).toEqual([tutor, host1, learner]);
  });

  it('rejects gaps, reordering, foreign activities and invalid events; an identical re-append is a no-op', async () => {
    const { outbox } = await setup();
    expect(outbox.append(makeEvent(2))).toMatchObject({ ok: false, diagnostic: { code: 'INVALID_INPUT', path: '$.sequence' } });
    const first = makeEvent(1);
    expect(outbox.append(first)).toEqual({ ok: true });
    expect(outbox.append(structuredClone(first))).toEqual({ ok: true });
    expect(outbox.append({ ...first, payload: { stageId: 'stage-99' } })).toMatchObject({ ok: false, diagnostic: { code: 'OPERATION_CONFLICT' } });
    expect(outbox.append(makeEvent(3))).toMatchObject({ ok: false, diagnostic: { code: 'INVALID_INPUT' } });
    expect(outbox.append({ ...makeEvent(2), activityId: 'act-other' })).toMatchObject({ ok: false, diagnostic: { code: 'INVALID_INPUT', path: '$.activityId' } });
    expect(outbox.append({ ...makeEvent(2), payload: { stageId: 'x'.repeat(9000) } })).toMatchObject({ ok: false, diagnostic: { code: 'RESOURCE_LIMIT' } });
    // Closed payloads (G17): an extra payload key is refused like any other schema violation.
    expect(outbox.append({ ...makeEvent(2), payload: { stageId: 'stage-2', viewport: [360, 640] } })).toMatchObject({ ok: false, diagnostic: { code: 'SCHEMA' } });
    expect(outbox.append({ ...makeEvent(2), type: 'parameters.committed' })).toMatchObject({ ok: false, diagnostic: { code: 'SCHEMA' } });
    expect(outbox.pendingEvents()).toEqual([first]);
    expect(outbox.nextSequence()).toBe(2);
  });

  it('stores copies so later caller mutation cannot change journaled evidence', async () => {
    const { host, outbox } = await setup();
    const item = makeEvent(1);
    outbox.append(item);
    (item.payload as { stageId: string }).stageId = 'stage-42';
    await outbox.flush();
    expect(host.events(ACTIVITY)[0]!.payload).toEqual({ stageId: 'stage-1' });
  });
});

describe('durable duplicate handling across reconnects (A15, A20)', () => {
  it('a disconnect after commit is retried with backoff and deduplicated by eventId', async () => {
    const { host, outbox, scheduler } = await setup();
    host.failNext('appendEvents', 'disconnect-after-commit');
    appendAll(outbox, [makeEvent(1), makeEvent(2), makeEvent(3)]);
    await outbox.flush();
    expect(outbox.state()).toMatchObject({ persistence: 'pending-recovery', pending: 3, lastError: { code: 'PERSISTENCE_FAILED' } });
    expect(host.events(ACTIVITY)).toHaveLength(3);
    expect(scheduler.delays()).toEqual([500]);
    await scheduler.advance(500);
    await outbox.flush();
    expect(outbox.state()).toMatchObject({ persistence: 'saved', pending: 0, acknowledgedThrough: 3, lastError: null });
    expect(ids(host.events(ACTIVITY))).toEqual(['evt-0001', 'evt-0002', 'evt-0003']);
    const [, retry] = host.calls('appendEvents');
    expect(retry?.outcome).toBe('ok');
    expect(ids(outbox.acknowledgedEvents())).toEqual(['evt-0001', 'evt-0002', 'evt-0003']);
  });

  it('reconcile after a restart resends unconfirmed events once and the restarted host reports duplicates', async () => {
    const first = new MemoryHost({ policy: approvedPolicy });
    let current = first;
    const port = new Proxy({} as HostPort, { get: (_, method: keyof HostPort) => (request: never) => (current[method] as (request: never) => Promise<unknown>).call(current, request) });
    await first.registerActivity({ instance: predictInstance, operationId: 'op-register' });
    const scheduler = manualScheduler();
    const outbox = createOutbox({ host: port, activityId: ACTIVITY, limit: 16, onChange: () => {}, scheduler, timeoutMs: 0 });
    appendAll(outbox, [makeEvent(1), makeEvent(2)]);
    await outbox.flush();
    first.failNext('appendEvents', 'disconnect-after-commit');
    appendAll(outbox, [makeEvent(3), makeEvent(4)]);
    await outbox.flush();
    expect(outbox.state()).toMatchObject({ persistence: 'pending-recovery', pending: 2, acknowledgedThrough: 2 });
    // The host process restarts from its durable tables.
    current = first.restoreInto(new MemoryHost({ policy: approvedPolicy }));
    const { cursor, resent } = await outbox.reconcile();
    expect(resent).toBe(2);
    expect(cursor).toMatchObject({ lastSequence: 4, lastEventId: 'evt-0004' });
    expect(outbox.state()).toMatchObject({ persistence: 'saved', pending: 0, acknowledgedThrough: 4 });
    expect(ids(current.events(ACTIVITY))).toEqual(['evt-0001', 'evt-0002', 'evt-0003', 'evt-0004']);
    expect(scheduler.delays()).toEqual([]);
  });

  it('an unanswered call times out as an uncertain outcome and the resend does not duplicate', async () => {
    const { host, outbox, scheduler } = await setup({ timeoutMs: 1000 });
    host.failNext('appendEvents', 'timeout');
    appendAll(outbox, [makeEvent(1)]);
    const flushing = outbox.flush();
    await settle();
    await scheduler.advance(1000);
    await flushing;
    expect(outbox.state()).toMatchObject({ persistence: 'pending-recovery', pending: 1, lastError: { message: expect.stringContaining('in time') } });
    await scheduler.advance(500);
    await outbox.flush();
    expect(outbox.state().persistence).toBe('saved');
    expect(host.releaseHung()).toBe(1);
    await settle();
    expect(ids(host.events(ACTIVITY))).toEqual(['evt-0001']);
    expect(outbox.state()).toMatchObject({ persistence: 'saved', pending: 0 });
  });

  it('keeps events the host did not confirm and resends them', async () => {
    const host = new MemoryHost({ policy: approvedPolicy });
    let drop = true;
    const port: HostPort = Object.assign(Object.create(host) as HostPort, {
      appendEvents: async (request: { activityId: string; events: InteractionEvent[] }) => {
        const result = await host.appendEvents(request);
        if (drop) { drop = false; return { ...result, acknowledged: result.acknowledged.slice(0, 1) }; }
        return result;
      },
    });
    const { outbox, scheduler } = await setup({ host: port }, host);
    appendAll(outbox, [makeEvent(1), makeEvent(2)]);
    await outbox.flush();
    expect(outbox.state()).toMatchObject({ persistence: 'pending-recovery', pending: 1, acknowledgedThrough: 1 });
    await scheduler.advance(500);
    await outbox.flush();
    expect(outbox.state()).toMatchObject({ persistence: 'saved', acknowledgedThrough: 2 });
    expect(ids(host.events(ACTIVITY))).toEqual(['evt-0001', 'evt-0002']);
  });

  it('treats an invalid append result as an uncertain outcome', async () => {
    const host = new MemoryHost({ policy: approvedPolicy });
    const port: HostPort = Object.assign(Object.create(host) as HostPort, { appendEvents: async () => ({ acknowledged: 'all' }) });
    const { outbox } = await setup({ host: port }, host);
    appendAll(outbox, [makeEvent(1)]);
    await outbox.flush();
    expect(outbox.state()).toMatchObject({ persistence: 'pending-recovery', pending: 1, lastError: { message: 'The host returned an invalid append result; the outcome is uncertain.' } });
  });
});

describe('bounded outbox never drops evidence silently (A16)', () => {
  it('rejects an evidence-bearing event with PERSISTENCE_BACKPRESSURE at the bound and keeps everything queued', async () => {
    const { host, outbox, changes } = await setup({ limit: 4, retry: { baseMs: 10, maxMs: 10, maxAttempts: 0 } });
    host.failNext('appendEvents', 'throw', { times: 2 });
    appendAll(outbox, [1, 2, 3, 4].map(sequence => makeEvent(sequence, 'parameters.committed')));
    await outbox.flush();
    const rejected = outbox.append(makeEvent(5, 'parameters.committed'));
    expect(rejected).toMatchObject({ ok: false, diagnostic: { code: 'PERSISTENCE_BACKPRESSURE' } });
    expect(outbox.state()).toMatchObject({ persistence: 'pending-recovery', pending: 4 });
    expect(outbox.nextSequence()).toBe(5);
    // A presentation change at the bound is coalesced: counted, reported, and its sequence is not consumed.
    expect(outbox.append(makeEvent(5, 'view.changed'))).toEqual({ ok: true, coalesced: true });
    expect(outbox.state().coalesced).toBe(1);
    expect(changes.at(-1)?.coalesced).toBe(1);
    expect(outbox.nextSequence()).toBe(5);
    expect(ids(outbox.pendingEvents())).toEqual(['evt-0001', 'evt-0002', 'evt-0003', 'evt-0004']);
    await outbox.flush();
    expect(outbox.state().persistence).toBe('pending-recovery');
    await outbox.flush();
    expect(outbox.state()).toMatchObject({ persistence: 'saved', pending: 0, acknowledgedThrough: 4, coalesced: 1 });
    expect(outbox.append(makeEvent(5, 'parameters.committed'))).toEqual({ ok: true });
    await outbox.flush();
    expect(ids(host.events(ACTIVITY))).toEqual(['evt-0001', 'evt-0002', 'evt-0003', 'evt-0004', 'evt-0005']);
  });

  it('limits presentation changes to an eighth of the bound so evidence keeps its capacity', async () => {
    const { outbox } = await setup({ limit: 16 });
    expect(outbox.append(makeEvent(1, 'view.changed'))).toEqual({ ok: true });
    expect(outbox.append(makeEvent(2, 'view.changed'))).toEqual({ ok: true });
    expect(outbox.append(makeEvent(3, 'view.changed'))).toEqual({ ok: true, coalesced: true });
    for (let sequence = 3; sequence <= 16; sequence++) expect(outbox.append(makeEvent(sequence))).toEqual({ ok: true });
    expect(outbox.append(makeEvent(17))).toMatchObject({ ok: false, diagnostic: { code: 'PERSISTENCE_BACKPRESSURE' } });
    expect(outbox.state()).toMatchObject({ pending: 16, coalesced: 1 });
  });

  it('bounds the acknowledged mirror and counts trimmed events for summaries', async () => {
    expect(ACKNOWLEDGED_MIRROR_LIMIT).toBe(5000);
    const { outbox } = await setup({ limit: 32, mirrorLimit: 10 });
    for (let sequence = 1; sequence <= 25; sequence++) { outbox.append(makeEvent(sequence)); if (sequence % 8 === 0) await outbox.flush(); }
    await outbox.flush();
    expect(outbox.acknowledgedEvents().map(item => item.sequence)).toEqual([16, 17, 18, 19, 20, 21, 22, 23, 24, 25]);
    expect(outbox.trimmedBefore()).toBe(15);
  });

  it('keeps the default mirror at 5000 acknowledged events', async () => {
    const { outbox } = await setup({ limit: 256 });
    for (let sequence = 1; sequence <= 5010; sequence++) { outbox.append(makeEvent(sequence)); if (sequence % 200 === 0) await outbox.flush(); }
    await outbox.flush();
    expect(outbox.acknowledgedEvents()).toHaveLength(5000);
    expect(outbox.acknowledgedEvents()[0]!.sequence).toBe(11);
    expect(outbox.trimmedBefore()).toBe(10);
  }, 60_000);

  it('releases acknowledged copies under the host deletion policy but never pending evidence', async () => {
    const { host, outbox } = await setup();
    appendAll(outbox, [makeEvent(1), makeEvent(2)]);
    await outbox.flush();
    host.failNext('appendEvents', 'throw');
    appendAll(outbox, [makeEvent(3)]);
    await outbox.flush();
    expect(outbox.forgetAcknowledged(() => true)).toBe(2);
    expect(outbox.acknowledgedEvents()).toEqual([]);
    expect(ids(outbox.pendingEvents())).toEqual(['evt-0003']);
  });
});

describe('persistence states and recovery (A20)', () => {
  it('retries with bounded exponential backoff, then waits for an explicit retry', async () => {
    const { host, outbox, scheduler } = await setup({ retry: { baseMs: 100, maxMs: 250, maxAttempts: 3 } });
    host.failNext('appendEvents', 'throw', { times: 3 });
    appendAll(outbox, [makeEvent(1)]);
    await outbox.flush();
    expect(scheduler.delays()).toEqual([100]);
    await scheduler.advance(100);
    expect(scheduler.delays()).toEqual([200]);
    await scheduler.advance(200);
    expect(scheduler.delays()).toEqual([]);
    expect(outbox.state()).toMatchObject({ persistence: 'pending-recovery', pending: 1, lastError: { recovery: expect.stringContaining('Automatic retries stopped') } });
    await outbox.flush();
    expect(outbox.state()).toMatchObject({ persistence: 'saved', pending: 0 });
    expect(host.events(ACTIVITY)).toHaveLength(1);
  });

  it('a host rejection is failed: no automatic retry, requireFlushed reports it, events are kept', async () => {
    const { host, outbox, scheduler } = await setup();
    host.failNext('appendEvents', 'reject', { code: 'SCHEMA', times: 2 });
    appendAll(outbox, [makeEvent(1)]);
    await outbox.flush();
    expect(outbox.state()).toMatchObject({ persistence: 'failed', pending: 1, lastError: { code: 'PERSISTENCE_FAILED', message: 'The host rejected the journal batch (SCHEMA).' } });
    expect(scheduler.delays()).toEqual([]);
    await expect(outbox.requireFlushed()).rejects.toMatchObject({ diagnostic: { code: 'PERSISTENCE_FAILED' } });
    expect(outbox.pendingEvents()).toHaveLength(1);
    await outbox.requireFlushed();
    expect(outbox.state()).toMatchObject({ persistence: 'saved', pending: 0 });
  });

  it('requireFlushed rejects PERSISTENCE_PENDING while the host is unreachable and resolves once acknowledged', async () => {
    const { host, outbox } = await setup();
    await outbox.requireFlushed();
    host.failNext('appendEvents', 'throw');
    appendAll(outbox, [makeEvent(1)]);
    const failure = await outbox.requireFlushed().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PersistenceError);
    expect((failure as PersistenceError).diagnostic).toMatchObject({ code: 'PERSISTENCE_PENDING', message: '1 journal events are not yet acknowledged by the host.' });
    await outbox.requireFlushed();
    expect(outbox.state().persistence).toBe('saved');
  });

  it('requireFlushed(waitMs) refuses PERSISTENCE_PENDING once the wait elapses with a batch still in flight, without waiting for the host timeout (Phase 4a F3)', async () => {
    const { host, outbox, scheduler } = await setup({ timeoutMs: DEFAULT_HOST_TIMEOUT_MS });
    expect(DEFAULT_PERSISTENCE_WAIT_MS).toBeLessThan(DEFAULT_HOST_TIMEOUT_MS);
    host.failNext('appendEvents', 'timeout');
    appendAll(outbox, [makeEvent(1)]);
    const waiting = outbox.requireFlushed(50).catch((error: unknown) => error);
    await settle();
    await scheduler.advance(50);
    const refused = await waiting;
    expect(refused).toBeInstanceOf(PersistenceError);
    expect((refused as PersistenceError).diagnostic).toMatchObject({ code: 'PERSISTENCE_PENDING', message: '1 journal events are still being saved; the host has not answered yet.' });
    // Nothing was dropped and the batch is still in flight; the host timeout has not fired.
    expect(outbox.state()).toMatchObject({ persistence: 'saving', pending: 1 });
    expect(host.calls('appendEvents')).toHaveLength(1);
    expect(host.releaseHung()).toBe(1);
    await settle();
    expect(outbox.state().persistence).toBe('pending-recovery');
    await scheduler.advance(500);
    await outbox.requireFlushed(50);
    expect(outbox.state()).toMatchObject({ persistence: 'saved', pending: 0 });
    expect(host.events(ACTIVITY).map(item => item.sequence)).toEqual([1]);
  });

  it('passes every acknowledgement host timestamp to onHostTime, so host-clock checks follow host time (G05)', async () => {
    const seen: string[] = [];
    const { host, outbox } = await setup({ onHostTime: timestamp => seen.push(timestamp) });
    host.advanceClock(3 * 3_600_000);
    appendAll(outbox, [makeEvent(1), makeEvent(2)]);
    await outbox.flush();
    expect(seen).toHaveLength(2);
    expect(Date.parse(seen[0]!)).toBeGreaterThanOrEqual(Date.UTC(2026, 9, 26, 12, 0, 0));
    // A clock fed by the acknowledgements finds a policy expired by host time although no policy or receipt said so.
    const clock = createHostClock();
    const policy = { ...approvedPolicy, issuedAt: '2026-10-26T08:00:00.000Z', expiresAt: '2026-10-26T10:00:00.000Z', revoked: false };
    clock.observe(policy.issuedAt);
    expect(policyStanding(policy, clock.now())).toBeNull();
    for (const timestamp of seen) clock.observe(timestamp);
    expect(policyStanding(policy, clock.now())).toMatchObject({ code: 'POLICY_EXPIRED' });
  });

  it('keeps a reserve above the command capacity for events recorded without a command (G01)', async () => {
    expect([1, 3, 4, 6, 8, 16, 64, 256].map(systemReserve)).toEqual([0, 0, 2, 2, 2, 2, 8, 32]);
    expect([4, 6, 256].map(commandCapacity)).toEqual([2, 4, 224]);
    // The outbox itself accepts evidence up to the full bound; commands stop at the capacity (controller room check).
    const { outbox, host } = await setup({ limit: 6 });
    host.failNext('appendEvents', 'throw', { times: 20 });
    appendAll(outbox, [1, 2, 3, 4, 5, 6].map(sequence => makeEvent(sequence)));
    expect(outbox.append(makeEvent(7))).toMatchObject({ ok: false, diagnostic: { code: 'PERSISTENCE_BACKPRESSURE' } });
  });

  it('reports state transitions saving → pending-recovery → saved through onChange', async () => {
    const { host, outbox, changes, scheduler } = await setup();
    host.failNext('appendEvents', 'throw');
    appendAll(outbox, [makeEvent(1)]);
    await outbox.flush();
    await scheduler.advance(500);
    await outbox.flush();
    const sequence = changes.map(state => state.persistence).filter((state, index, all) => state !== all[index - 1]);
    expect(sequence).toEqual(['saving', 'pending-recovery', 'saved']);
  });

  it('reconcile adopts a host cursor that is ahead of a restored outbox with nothing pending', async () => {
    const { host, outbox } = await setup();
    appendAll(outbox, [makeEvent(1), makeEvent(2), makeEvent(3)]);
    await outbox.flush();
    const restored = createOutbox({ host, activityId: ACTIVITY, limit: 16, onChange: () => {}, lastSequence: 1, timeoutMs: 0 });
    expect(restored.append(makeEvent(2))).toEqual({ ok: true });
    const fresh = createOutbox({ host, activityId: ACTIVITY, limit: 16, onChange: () => {}, lastSequence: 1, timeoutMs: 0 });
    const { cursor, resent } = await fresh.reconcile();
    expect({ cursor, resent }).toEqual({ cursor: { activityId: ACTIVITY, lastSequence: 3, lastEventId: 'evt-0003', checkpointDigest: null }, resent: 0 });
    expect(fresh.nextSequence()).toBe(4);
    expect(fresh.state()).toMatchObject({ persistence: 'saved', acknowledgedThrough: 3 });
  });

  it('reconcile reports a conflict instead of guessing when the host journal disagrees', async () => {
    const { host, outbox } = await setup();
    appendAll(outbox, [makeEvent(1), makeEvent(2)]);
    await outbox.flush();
    const behind = createOutbox({ host, activityId: ACTIVITY, limit: 16, onChange: () => {}, lastSequence: 5, timeoutMs: 0 });
    expect((await behind.reconcile()).resent).toBe(0);
    expect(behind.state()).toMatchObject({ persistence: 'failed', lastError: { code: 'CONFLICT' } });
    const ahead = createOutbox({ host, activityId: ACTIVITY, limit: 16, onChange: () => {}, lastSequence: 0, timeoutMs: 0 });
    expect(ahead.append(makeEvent(1, 'activity.opened', { eventId: 'evt-other-1' }))).toEqual({ ok: true });
    await ahead.reconcile();
    expect(ahead.state()).toMatchObject({ persistence: 'failed', pending: 1, lastError: { code: 'CONFLICT' } });
    expect(ids(host.events(ACTIVITY))).toEqual(['evt-0001', 'evt-0002']);
  });

  it('reconcile rejects with a PersistenceError when the host cursor cannot be read', async () => {
    const { host, outbox } = await setup();
    host.failNext('getJournalCursor', 'throw');
    await expect(outbox.reconcile()).rejects.toBeInstanceOf(PersistenceError);
    expect(outbox.state().persistence).toBe('pending-recovery');
    const cursor: JournalCursor = (await outbox.reconcile()).cursor;
    expect(cursor.lastSequence).toBe(0);
    expect(outbox.state().persistence).toBe('saved');
  });

  it('dispose stops retries and suppresses callbacks from replies that arrive later', async () => {
    const { host, outbox, changes, scheduler } = await setup({ timeoutMs: 0 });
    host.delay('appendEvents', 20);
    appendAll(outbox, [makeEvent(1)]);
    const flushing = outbox.flush();
    const count = changes.length;
    outbox.dispose();
    await flushing;
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(changes).toHaveLength(count);
    expect(scheduler.delays()).toEqual([]);
    expect(outbox.append(makeEvent(2))).toMatchObject({ ok: false, diagnostic: { code: 'DISPOSED' } });
    await expect(outbox.requireFlushed()).rejects.toMatchObject({ diagnostic: { code: 'DISPOSED' } });
  });

  it('validates construction options', () => {
    const host = new MemoryHost({ policy: approvedPolicy });
    const base = { host, activityId: ACTIVITY, onChange: () => {} };
    expect(() => createOutbox({ ...base, limit: 0 })).toThrow(RangeError);
    expect(() => createOutbox({ ...base, limit: 257 })).toThrow(RangeError);
    expect(() => createOutbox({ ...base, limit: 4, batchSize: 33 })).toThrow(RangeError);
  });
});

describe('MemoryHost test double (fixture host, not a reference host)', () => {
  const intent = MESSAGE_EXEMPLARS.exposureIntentRequest[0]!;
  const registered = async () => { const host = new MemoryHost({ policy: approvedPolicy }); await host.registerActivity({ instance: predictInstance, operationId: 'op-register' }); return host; };
  const failure = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error as MemoryHostError);

  it('issues receipts that echo the request, advance the activity revision and record an authorized exposure', async () => {
    const host = await registered();
    const receipt = await host.recordExposureIntent(intent);
    expect(receipt).toMatchObject({
      contract: 'study-harness.exposure-receipt', activityId: intent.activityId, idempotencyKey: intent.idempotencyKey, basedOnActivityRevision: 2, activityRevision: 3,
      policyId: approvedPolicy.policyId, policyRevision: approvedPolicy.revision, template: intent.template, model: intent.model, intendedStage: 'explore',
      grant: { scope: 'reveal', groups: intent.groups },
    });
    expect(host.activity(intent.activityId)).toEqual({ activityRevision: 3, stage: 'predict' });
    expect(host.exposures(intent.activityId)).toMatchObject([{ exposureId: receipt.grant.exposureId, receiptId: receipt.receiptId, displayStatus: 'authorized', groups: intent.groups }]);
    // Same idempotency key and request: the same receipt, no second revision. Different request: conflict.
    expect(await host.recordExposureIntent(intent)).toEqual(receipt);
    expect(host.activity(intent.activityId)?.activityRevision).toBe(3);
    expect(await failure(host.recordExposureIntent({ ...intent, intendedStage: 'explain' }))).toMatchObject({ kind: 'rejected', code: 'OPERATION_CONFLICT' });
    await host.recordDisplayAck({ activityId: intent.activityId, exposureId: receipt.grant.exposureId, receiptId: receipt.receiptId, projectionDigest: 'sha256:' + 'b'.repeat(64), frameId: 'frame-1', monotonicMs: 10 });
    expect(host.exposures()[0]).toMatchObject({ displayStatus: 'displayed', displayed: { frameId: 'frame-1' } });
    expect(await failure(host.recordDisplayAck({ activityId: intent.activityId, exposureId: receipt.grant.exposureId, receiptId: 'rcpt-other', projectionDigest: 'sha256:' + 'b'.repeat(64), frameId: 'frame-1', monotonicMs: 10 }))).toMatchObject({ code: 'RECEIPT_MISMATCH' });
  });

  it('enforces revisions, policy revocation and expiry, and request schemas', async () => {
    const host = await registered();
    expect(await failure(host.recordExposureIntent({ ...intent, idempotencyKey: 'k-1', basedOnActivityRevision: 1 }))).toMatchObject({ code: 'STALE_ACTIVITY_REVISION' });
    expect(await failure(host.recordExposureIntent({ ...intent, idempotencyKey: 'k-2', expectedPolicyRevision: 2 }))).toMatchObject({ code: 'STALE_POLICY_REVISION' });
    expect(await failure(host.recordExposureIntent({ ...intent, idempotencyKey: 'k-3', groups: [] }))).toMatchObject({ code: 'SCHEMA' });
    const transition = MESSAGE_EXEMPLARS.stageTransitionRequest[1]!;
    const stage = await host.requestStageTransition(transition);
    expect(stage).toMatchObject({ fromStage: 'predict', toStage: 'explore', grant: { scope: 'stage', groups: transition.groups } });
    expect(host.activity(intent.activityId)).toEqual({ activityRevision: 3, stage: 'explore' });
    const revoked = host.revokePolicy();
    expect(revoked).toMatchObject({ revision: approvedPolicy.revision + 1, revoked: true });
    expect(await host.getPolicy({ activityId: intent.activityId })).toEqual(revoked);
    expect(await failure(host.recordExposureIntent({ ...intent, idempotencyKey: 'k-4', basedOnActivityRevision: 3, expectedPolicyRevision: revoked.revision }))).toMatchObject({ code: 'POLICY_DENIED' });
    host.setPolicy(approvedPolicy);
    host.advanceClock(9 * 3600 * 1000);
    expect(await failure(host.recordExposureIntent({ ...intent, idempotencyKey: 'k-5', basedOnActivityRevision: 3 }))).toMatchObject({ code: 'POLICY_EXPIRED' });
  });

  it('crashes at protocol points, keeps durable state and restarts from a snapshot', async () => {
    const before = await registered();
    before.crashAt('before-intent-commit');
    expect(await failure(before.recordExposureIntent(intent))).toMatchObject({ kind: 'crashed', committed: false });
    expect(before.crashed).toBe(true);
    expect(await failure(before.getJournalCursor({ activityId: intent.activityId }))).toMatchObject({ kind: 'crashed' });
    const restarted = before.restoreInto(new MemoryHost({ policy: approvedPolicy }));
    expect(restarted.exposures()).toEqual([]);

    restarted.crashAt('after-intent-commit-before-reply');
    expect(await failure(restarted.recordExposureIntent(intent))).toMatchObject({ kind: 'crashed', committed: true });
    const again = restarted.restoreInto(new MemoryHost({ policy: approvedPolicy }));
    expect(again.exposures()).toMatchObject([{ displayStatus: 'authorized' }]);
    // The retried request after the restart returns the committed receipt instead of a second exposure.
    const receipt = await again.recordExposureIntent(intent);
    expect(again.exposures()).toHaveLength(1);
    again.crashAt('after-ack-commit-before-reply');
    expect(await failure(again.recordDisplayAck({ activityId: intent.activityId, exposureId: receipt.grant.exposureId, receiptId: receipt.receiptId, projectionDigest: 'sha256:' + 'c'.repeat(64), frameId: 'frame-2', monotonicMs: 5 }))).toMatchObject({ kind: 'crashed', committed: true });
    expect(again.restoreInto(new MemoryHost({ policy: approvedPolicy })).exposures()).toMatchObject([{ displayStatus: 'displayed' }]);
  });

  it('injects failures, delays and hung calls, and stores artifacts idempotently', async () => {
    const host = await registered();
    host.failNext('saveArtifact', 'reject', { code: 'RESOURCE_LIMIT' });
    expect(await failure(host.saveArtifact({ artifact: backupArtifact, operationId: 'op-save' }))).toMatchObject({ kind: 'rejected', code: 'RESOURCE_LIMIT' });
    const saved = await host.saveArtifact({ artifact: backupArtifact, operationId: 'op-save' });
    expect(await host.saveArtifact({ artifact: backupArtifact, operationId: 'op-save' })).toMatchObject({ artifactDigest: saved.artifactDigest });
    expect(await failure(host.saveArtifact({ artifact: { ...backupArtifact, kind: 'learner-snapshot' }, operationId: 'op-save' }))).toMatchObject({ code: 'OPERATION_CONFLICT' });
    expect((await host.getJournalCursor({ activityId: intent.activityId })).checkpointDigest).toBe(saved.artifactDigest);
    host.failNext('getJournalCursor', 'timeout');
    const hung = failure(host.getJournalCursor({ activityId: intent.activityId }));
    expect(host.releaseHung()).toBe(1);
    expect(await hung).toMatchObject({ kind: 'timeout' });
    host.delay('getPolicy', 5);
    const started = Date.now();
    await host.getPolicy({ activityId: intent.activityId });
    expect(Date.now() - started).toBeGreaterThanOrEqual(4);
    expect(host.calls('getJournalCursor').map(call => call.outcome)).toEqual(['ok', 'hung']);
  });
});
