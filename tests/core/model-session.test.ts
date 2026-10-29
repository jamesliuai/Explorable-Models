import { afterEach, describe, expect, it } from 'vitest';
import {
  createModelSession, createPreviewCoordinator, createWorkerBudget, frameId, ModelError, validateManifest,
  type ModelGuard, type ModelSession, type ModelSessionEvent, type ModelSessionOptions, type WorkerBudget,
} from '../../packages/core/src/model/index';
import { allKernels, geometricManifest, rectangleManifest } from './support/model-fixtures';
import { inlineWorkers, ManualScheduler, settle, until, type WorkerGroup } from './support/inline-worker';

const { manifest, identity } = validateManifest(geometricManifest());
const defaults = { a: 2, eta: 0.25, x0: 4 };
const cleanup: { dispose(): void }[] = [];
afterEach(() => { for (const item of cleanup.splice(0)) item.dispose(); });
let operation = 0;
const guard = (session: ModelSession): ModelGuard => ({ sessionId: session.id, expectedVersion: session.getState().version, expectedRunId: session.getState().run?.id ?? null, operationId: `op-${++operation}` });
const counter = (prefix: string) => { let n = 0; return () => `${prefix}-${++n}`; };
function setup(options: Partial<ModelSessionOptions> & { group?: WorkerGroup } = {}) {
  const group = options.group ?? inlineWorkers(allKernels);
  const scheduler = new ManualScheduler();
  const session = createModelSession({ workerFactory: group.factory, scheduler, ...options });
  cleanup.push(session);
  const events: ModelSessionEvent[] = [];
  session.subscribe(event => events.push(event));
  return { session, group, scheduler, events };
}
async function rejection(promise: Promise<unknown> | (() => unknown)): Promise<ModelError> {
  try { await (typeof promise === 'function' ? promise() : promise); } catch (error) { expect(error).toBeInstanceOf(ModelError); return error as ModelError; }
  throw new Error('Expected a ModelError.');
}
/** Runs one scheduled playback tick and waits until its evaluation settles. */
async function tick(session: ModelSession, scheduler: ManualScheduler): Promise<void> {
  const before = session.getState();
  expect(scheduler.runNext()).toBe(true);
  await until(() => session.getState() !== before);
}
const index = (session: ModelSession) => (session.getState().frame!.position as { index: number }).index;
const position = (session: ModelSession) => session.getState().frame!.quantities.position;

describe('discrete navigation (D9, A12)', () => {
  it('loads at index zero with an identified committed frame', async () => {
    const { session } = setup();
    const state = await session.load(manifest, null, guard(session));
    expect(state).toMatchObject({ status: 'ready', version: 1, playing: false, stale: false, error: null, preview: null, comparisons: [] });
    expect(state.model).toEqual({ modelId: manifest.modelId, version: manifest.version, digest: identity.digest });
    expect(state.identity).toEqual(identity);
    expect(state.run).toMatchObject({ params: defaults, position: { kind: 'index', index: 0, maxIndex: 12 }, cause: 'initial' });
    expect(state.frame!.run).toEqual({ kind: 'committed', runId: state.run!.id });
    expect(state.frame!.frameId).toBe(frameId(state.model!, state.frame!.run, defaults, state.frame!.position));
    expect(position(session)).toEqual({ status: 'valid', value: 4 });
    expect(Object.isFrozen(state.frame!.quantities)).toBe(true);
    expect(() => { (state.run!.params as Record<string, number>).eta = 1; }).toThrow();
  });

  it('navigates whole indices in the same run and rejects fractional or out-of-range indices before evaluation', async () => {
    const { session, group } = setup();
    const loaded = await session.load(manifest, null, guard(session));
    const moved = await session.navigate({ kind: 'index', index: 3 }, guard(session));
    expect(moved.version).toBe(loaded.version + 1);
    expect(moved.run!.id).toBe(loaded.run!.id);
    expect(moved.run!.position).toEqual({ kind: 'index', index: 3, maxIndex: 12 });
    expect(position(session)).toEqual({ status: 'valid', value: 0.5 });
    const posted = group.received, accepted = session.getState().frame;
    expect((await rejection(session.navigate({ kind: 'index', index: 2.5 }, guard(session)))).diagnostics[0]).toMatchObject({ code: 'INVALID_INPUT', path: '$.position.index' });
    expect((await rejection(session.navigate({ kind: 'index', index: 13 }, guard(session)))).code).toBe('OUT_OF_DOMAIN');
    expect((await rejection(session.navigate({ kind: 'index', index: -1 }, guard(session)))).code).toBe('OUT_OF_DOMAIN');
    expect((await rejection(session.navigate({ kind: 'time', time: 1 }, guard(session)))).code).toBe('INVALID_INPUT');
    expect(group.received).toBe(posted);
    expect(session.getState().frame).toBe(accepted);
    expect(session.getState()).toMatchObject({ stale: true, error: [expect.objectContaining({ code: 'INVALID_INPUT' })] });
    const end = await session.navigate({ kind: 'index', index: 12 }, guard(session));
    expect(end.frame!.terminal).toEqual({ reached: true, event: 'max-index' });
    expect(end).toMatchObject({ stale: false, error: null });
    expect((await rejection(() => session.play(guard(session)))).code).toBe('OUT_OF_DOMAIN');
  });

  it('commits restart at index zero in a new run and reproduce the report cases', async () => {
    const { session } = setup();
    await session.load(manifest, null, guard(session));
    const values: number[] = [];
    for (let i = 0; i < 4; i++) { await session.navigate({ kind: 'index', index: i }, guard(session)); values.push(position(session).status === 'valid' ? (position(session) as { value: number }).value : Number.NaN); }
    expect(values).toEqual([4, 2, 1, 0.5]);
    const old = session.getState();
    const committed = await session.commitParameters({ a: 2, eta: 0.75, x0: 4 }, guard(session));
    expect(committed.run!.id).not.toBe(old.run!.id);
    expect(committed.run).toMatchObject({ cause: 'commit', position: { kind: 'index', index: 0 } });
    expect(committed.version).toBe(old.version + 1);
    const alternating: number[] = [];
    for (let i = 0; i < 4; i++) { await session.navigate({ kind: 'index', index: i }, guard(session)); alternating.push((position(session) as { value: number }).value); }
    expect(alternating).toEqual([4, -2, 1, -0.5]);
    const zero = await session.commitParameters({ a: 2, eta: 0.75, x0: 0 }, guard(session), 'reset');
    expect(zero.run!.cause).toBe('reset');
    await session.navigate({ kind: 'index', index: 12 }, guard(session));
    expect(position(session)).toEqual({ status: 'valid', value: 0 });
    expect(session.getState().frame!.quantities.ratio).toMatchObject({ status: 'undefined', code: 'ZERO_START' });
    expect((await rejection(session.commitParameters(defaults, guard(session), 'restore'))).code).toBe('INVALID_INPUT');
  });

  it('replays deterministically within a run and across sessions', async () => {
    const one = setup({ idFactory: counter('a') }).session, two = setup({ idFactory: counter('a') }).session;
    for (const session of [one, two]) { await session.load(manifest, null, guard(session)); await session.navigate({ kind: 'index', index: 5 }, guard(session)); }
    expect(two.getState().frame).toEqual(one.getState().frame);
    const first = one.getState().frame!;
    await one.navigate({ kind: 'index', index: 2 }, guard(one));
    await one.navigate({ kind: 'index', index: 5 }, guard(one));
    expect(one.getState().frame).toEqual(first);
    expect(one.getState().frame!.frameId).toBe(first.frameId);
  });
});

describe('playback (D9, A12)', () => {
  it('advances one whole index per tick without advancing the version and stops at maxIndex', async () => {
    const { session, scheduler } = setup();
    await session.load(manifest, null, guard(session));
    session.play(guard(session));
    const version = session.getState().version;
    expect(session.getState().playing).toBe(true);
    for (let i = 1; i <= 12; i++) {
      await tick(session, scheduler);
      expect(index(session)).toBe(i);
      expect(session.getState().version).toBe(version);
    }
    expect(session.getState().playing).toBe(false);
    expect(session.getState().frame!.terminal).toEqual({ reached: true, event: 'max-index' });
    expect(scheduler.pending).toBe(0);
  });

  it('stops before a numerical limit and keeps the limit frame reachable by explicit navigation', async () => {
    const { session, scheduler } = setup();
    await session.load(manifest, { a: 5, eta: 0.5, x0: 10 }, guard(session));
    session.play(guard(session));
    for (let i = 1; i <= 5; i++) await tick(session, scheduler);
    expect(index(session)).toBe(5);
    await tick(session, scheduler);
    expect(session.getState()).toMatchObject({ playing: false, stale: false, error: [expect.objectContaining({ code: 'NUMERICAL_LIMIT' })] });
    expect(index(session)).toBe(5);
    expect(scheduler.pending).toBe(0);
    await session.navigate({ kind: 'index', index: 6 }, guard(session));
    expect(position(session)).toEqual({ status: 'numerical-limit', code: 'OVERFLOW', reason: expect.any(String), lastFiniteIndex: 5 });
    expect(session.getState().frame!.terminal).toMatchObject({ reached: true, event: 'numerical-limit' });
    expect((await rejection(() => session.play(guard(session)))).code).toBe('OUT_OF_DOMAIN');
  });

  it('pauses with stale state when a tick fails', async () => {
    const { session, scheduler, group } = setup();
    await session.load(manifest, null, guard(session));
    session.play(guard(session));
    await tick(session, scheduler);
    const accepted = session.getState().frame;
    group.hostility = 'malformed';
    await tick(session, scheduler);
    expect(session.getState()).toMatchObject({ playing: false, stale: true, error: [expect.objectContaining({ code: 'WORKER_PROTOCOL' })] });
    expect(session.getState().frame).toBe(accepted);
    group.hostility = 'none';
    session.pause(guard(session));
    expect(session.getState().playing).toBe(false);
  });

  it('rejects navigation and playback for static models', async () => {
    const { session } = setup();
    const state = await session.load(rectangleManifest(), null, guard(session));
    expect(state.frame!.position).toEqual({ kind: 'static' });
    expect(state.frame!.terminal).toEqual({ reached: false });
    expect((await rejection(session.navigate({ kind: 'static' }, guard(session)))).code).toBe('UNSUPPORTED_CAPABILITY');
    expect((await rejection(() => session.play(guard(session)))).code).toBe('UNSUPPORTED_CAPABILITY');
  });
});

describe('guarded commands', () => {
  it('rejects stale, foreign and malformed guards with actionable conflicts', async () => {
    const { session } = setup();
    await session.load(manifest, null, guard(session));
    const stale = guard(session);
    await session.navigate({ kind: 'index', index: 1 }, guard(session));
    const conflict = await rejection(session.commitParameters(defaults, stale));
    expect(conflict.diagnostics[0]).toMatchObject({ code: 'CONFLICT', recovery: expect.stringContaining('retry') });
    expect((await rejection(session.commitParameters(defaults, { ...guard(session), sessionId: 'another' }))).code).toBe('CONFLICT');
    expect((await rejection(session.commitParameters(defaults, { ...guard(session), expectedRunId: 'other-run' }))).code).toBe('CONFLICT');
    expect((await rejection(session.commitParameters(defaults, { ...guard(session), origin: 'host' } as ModelGuard))).code).toBe('INVALID_INPUT');
    expect((await rejection(session.commitParameters(defaults, { ...guard(session), operationId: '' }))).code).toBe('INVALID_INPUT');
    expect(session.getState().stale).toBe(false);
  });

  it('deduplicates retried operation IDs and rejects reuse with different arguments', async () => {
    const { session } = setup();
    await session.load(manifest, null, guard(session));
    const g = guard(session);
    const [a, b] = await Promise.all([session.commitParameters({ ...defaults, eta: 0.5 }, g), session.commitParameters({ ...defaults, eta: 0.5 }, { ...g })]);
    expect(a.run!.id).toBe(b.run!.id);
    expect((await session.commitParameters({ ...defaults, eta: 0.5 }, g)).run!.id).toBe(a.run!.id);
    expect((await rejection(session.commitParameters({ ...defaults, eta: 0.6 }, g))).code).toBe('OPERATION_CONFLICT');
    const p = guard(session);
    session.play(p);
    session.play(p);
    expect(() => session.pause(p)).toThrow(/different arguments/);
  });

  it('snapshots caller-owned inputs before awaiting', async () => {
    const { session } = setup();
    await session.load(manifest, null, guard(session));
    const input = { ...defaults, eta: 0.5 };
    const g = guard(session);
    const pending = session.commitParameters(input, g);
    input.eta = 0.9;
    g.expectedVersion = 999;
    expect((await pending).run!.params.eta).toBe(0.5);
  });
});

describe('isolated sampling (report §8.6, A13)', () => {
  it('returns exact provenance and never touches run, version, preview, playback or listeners', async () => {
    const group = inlineWorkers(allKernels);
    const budget = createWorkerBudget({ maxWorkers: 4, workerFactory: group.factory });
    cleanup.push(budget);
    const { session, scheduler, events } = setup({ group, budget });
    await session.load(manifest, null, guard(session));
    await session.navigate({ kind: 'index', index: 2 }, guard(session));
    session.play(guard(session));
    const before = session.getState(), count = events.length, pending = scheduler.pending;
    const sample = await session.sample({ params: { a: 2, eta: 0.75, x0: 4 }, positions: [{ kind: 'index', index: 0 }, { kind: 'index', index: 3 }, { kind: 'index', index: 12 }] });
    expect(session.getState()).toBe(before);
    expect(events).toHaveLength(count);
    expect(scheduler.pending).toBe(pending);
    expect(sample.model).toEqual(before.model);
    expect(sample.identity).toEqual(identity);
    expect(sample.frames.map(frame => (frame.quantities.position as { value: number }).value)).toEqual([4, -0.5, 4 * 0.5 ** 12]);
    for (const frame of sample.frames) {
      expect(frame.run).toEqual({ kind: 'sample', sampleId: sample.sampleId });
      expect(frame.frameId).toBe(frameId(frame.model, frame.run, frame.params, frame.position));
    }
    expect(sample.frames[2].terminal).toEqual({ reached: true, event: 'max-index' });
    expect(budget.stats().leases.filter(lease => lease.purpose === 'sample')).toEqual([]);
    expect((await rejection(session.sample({ params: defaults, positions: Array.from({ length: 65 }, () => ({ kind: 'index' as const, index: 0 })) }))).code).toBe('RESOURCE_LIMIT');
    expect((await rejection(session.sample({ params: defaults, positions: [{ kind: 'index', index: 1.5 }] }))).code).toBe('INVALID_INPUT');
    expect(session.getState()).toBe(before);
  });

  it('leaves an active preview untouched', async () => {
    const { session } = setup();
    await session.load(manifest, null, guard(session));
    await session.previewParameters('drag', { ...defaults, eta: 0.5 }, guard(session));
    const preview = session.getState().preview;
    await session.sample({ params: defaults, positions: [{ kind: 'index', index: 1 }] });
    expect(session.getState().preview).toBe(preview);
  });
});

describe('preview coordination (§9, A39–A41)', () => {
  it('coalesces 50 rapid previews into at most two evaluations and ends on the newest value', async () => {
    const { session, group } = setup();
    const committed = await session.load(manifest, null, guard(session));
    const before = group.received;
    const etas = Array.from({ length: 50 }, (_, i) => (i + 1) / 100);
    const results = await Promise.all(etas.map(eta => session.previewParameters('drag', { ...defaults, eta }, guard(session))));
    expect(group.received - before).toBeLessThanOrEqual(2);
    expect(group.maxInFlight).toBe(1);
    expect(results.slice(1, -1).every(result => result === null)).toBe(true);
    expect(results[0]).toMatchObject({ previewId: 'drag', status: 'evaluating' });
    const last = results[49]!;
    expect(last).toMatchObject({ previewId: 'drag', status: 'ready', error: null, params: { ...defaults, eta: 0.5 } });
    expect(last.frame!.params).toEqual({ ...defaults, eta: 0.5 });
    expect(last.frame!.run).toEqual({ kind: 'tentative', previewId: 'drag', baseRunId: committed.run!.id });
    expect(last.frame!.position).toEqual({ kind: 'index', index: 0, maxIndex: 12 });
    const state = session.getState();
    expect(state.preview).toBe(last);
    expect(state.frame).toBe(committed.frame);
    expect(state.version).toBe(committed.version);
    expect(state.run).toBe(committed.run);
  });

  it('commits only on gesture completion and discards later preview replies', async () => {
    const { session } = setup();
    const committed = await session.load(manifest, null, guard(session));
    await session.previewParameters('drag', { ...defaults, eta: 0.5 }, guard(session));
    const late = session.previewParameters('drag', { ...defaults, eta: 0.6 }, guard(session));
    const done = await session.commitParameters({ ...defaults, eta: 0.6 }, guard(session));
    expect(await late).toBeNull();
    expect(done).toMatchObject({ preview: null, version: committed.version + 1, run: { cause: 'commit', params: { ...defaults, eta: 0.6 } } });
    await settle(10);
    expect(session.getState().preview).toBeNull();
  });

  it('cancels to the committed frame, ignores late replies and blocks navigation while tentative', async () => {
    const { session, group } = setup();
    const committed = await session.load(manifest, null, guard(session));
    group.hold = true;
    const pending = session.previewParameters('drag', { ...defaults, eta: 0.4 }, guard(session));
    await until(() => group.workers.length === 2 && group.workers[1].received === 1);
    expect(session.getState().preview).toMatchObject({ status: 'evaluating', frame: null });
    for (const attempt of [
      () => session.navigate({ kind: 'index', index: 1 }, guard(session)),
      () => session.play(guard(session)),
      () => session.retainComparison('x', guard(session)),
      () => session.restore({ params: defaults, position: { kind: 'index', index: 1 }, restoredFrom: 'r' }, guard(session)),
      () => session.previewParameters('other-gesture', defaults, guard(session)),
    ]) expect((await rejection(attempt)).code).toBe('PREVIEW_ACTIVE');
    const epoch = session.getState().preview!.epoch;
    session.cancelPreview(guard(session));
    expect(session.getState().preview).toBeNull();
    expect(session.getState().frame).toBe(committed.frame);
    group.hold = false;
    group.flush();
    expect(await pending).toBeNull();
    expect(session.getState().preview).toBeNull();
    const next = await session.previewParameters('drag-2', { ...defaults, eta: 0.3 }, guard(session));
    expect(next!.epoch).toBeGreaterThan(epoch);
    expect(session.getState().version).toBe(committed.version);
  });

  it('reports invalid tentative values without a frame and without mixing old results', async () => {
    const { session } = setup();
    await session.load(manifest, null, guard(session));
    await session.previewParameters('drag', { ...defaults, eta: 0.5 }, guard(session));
    expect((await rejection(session.previewParameters('drag', { a: 5, eta: 0.9, x0: 4 }, guard(session)))).code).toBe('CONSTRAINT_VIOLATION');
    expect(session.getState().preview).toMatchObject({ status: 'failed', frame: null, error: expect.objectContaining({ code: 'CONSTRAINT_VIOLATION' }), params: { a: 5, eta: 0.9, x0: 4 } });
  });

  it('keeps two sessions sharing one budget independent', async () => {
    const group = inlineWorkers(allKernels);
    const budget: WorkerBudget = createWorkerBudget({ maxWorkers: 4, workerFactory: group.factory });
    cleanup.push(budget);
    const a = setup({ group, budget, ownerId: 'activity-a' }).session, b = setup({ group, budget, ownerId: 'activity-b' }).session;
    await a.load(manifest, null, guard(a));
    await b.load(manifest, { a: 1, eta: 0.5, x0: -3 }, guard(b));
    const bState = b.getState();
    await a.previewParameters('drag', { ...defaults, eta: 0.6 }, guard(a));
    await a.commitParameters({ ...defaults, eta: 0.6 }, guard(a));
    await a.navigate({ kind: 'index', index: 4 }, guard(a));
    expect(b.getState()).toBe(bState);
    expect((await rejection(b.navigate({ kind: 'index', index: 1 }, guard(a)))).code).toBe('CONFLICT');
    expect(budget.stats().leases).toEqual(expect.arrayContaining([{ ownerId: 'activity-a', purpose: 'primary' }, { ownerId: 'activity-a', purpose: 'scratch' }, { ownerId: 'activity-b', purpose: 'primary' }]));
    a.suspend();
    expect(budget.stats().leases).toEqual([{ ownerId: 'activity-b', purpose: 'primary' }]);
    await b.navigate({ kind: 'index', index: 2 }, guard(b));
    expect((b.getState().frame!.quantities.position as { value: number }).value).toBe(-3 * 0.5 ** 2);
    a.resume();
    await a.navigate({ kind: 'index', index: 1 }, guard(a));
    expect(budget.stats().leases.filter(lease => lease.ownerId === 'activity-a')).toEqual([{ ownerId: 'activity-a', purpose: 'primary' }]);
  });
});

describe('preview coordinator (D11)', () => {
  const deferred = () => { let resolve!: (value: number) => void, reject!: (error: unknown) => void; const promise = new Promise<number>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
  it('runs one evaluation at a time, keeps only the newest queued value and discards older epochs', async () => {
    const calls: { value: number; done: ReturnType<typeof deferred> }[] = [];
    const settled: unknown[] = [];
    const coordinator = createPreviewCoordinator<number, number, string>({
      evaluate: value => { const done = deferred(); calls.push({ value, done }); return done.promise; },
      settle: outcome => { settled.push(outcome); return 'error' in outcome ? 'failed' : `ready:${outcome.result}`; },
    });
    const first = coordinator.submit(1), second = coordinator.submit(2), third = coordinator.submit(3);
    await settle(0);
    expect(calls.map(call => call.value)).toEqual([1]);
    expect(await second).toBeNull();
    expect(coordinator).toMatchObject({ running: true, queued: true });
    calls[0].done.resolve(10);
    expect(await first).toBe('ready:10');
    expect(settled[0]).toMatchObject({ value: 1, superseded: true, result: 10 });
    await until(() => calls.length === 2);
    calls[1].done.reject(new Error('boom'));
    expect(await third).toBe('failed');
    const late = coordinator.submit(4);
    await until(() => calls.length === 3);
    coordinator.cancel();
    calls[2].done.resolve(40);
    expect(await late).toBeNull();
    expect(settled).toHaveLength(2);
    const running = coordinator.submit(5), queued = coordinator.submit(6);
    await until(() => calls.length === 4);
    coordinator.dispose(new Error('disposed'));
    await expect(queued).rejects.toThrow('disposed');
    calls[3].done.resolve(50);
    await expect(running).rejects.toThrow('disposed');
    await expect(coordinator.submit(7)).rejects.toThrow('disposed');
  });
});

describe('restore and comparisons', () => {
  it('restores into a new run at the saved position with provenance', async () => {
    const { session } = setup();
    await session.load(manifest, null, guard(session));
    await session.commitParameters({ ...defaults, eta: 0.75 }, guard(session));
    await session.navigate({ kind: 'index', index: 4 }, guard(session));
    const saved = session.getState();
    await session.commitParameters(defaults, guard(session));
    const restored = await session.restore({ params: saved.run!.params, position: { kind: 'index', index: 4 }, restoredFrom: saved.run!.id }, guard(session));
    expect(restored.run).toMatchObject({ cause: 'restore', restoredFrom: saved.run!.id, params: saved.run!.params, position: { kind: 'index', index: 4 } });
    expect(restored.run!.id).not.toBe(saved.run!.id);
    expect(restored.frame!.quantities).toEqual(saved.frame!.quantities);
    expect(restored.playing).toBe(false);
    expect((await rejection(session.restore({ params: saved.run!.params, position: { kind: 'index', index: 4.5 }, restoredFrom: saved.run!.id }, guard(session)))).code).toBe('INVALID_INPUT');
  });

  it('bounds retained comparisons without silent eviction', async () => {
    const { session } = setup({ maxComparisons: 2 });
    await session.load(manifest, null, guard(session));
    session.retainComparison('first', guard(session));
    expect((await rejection(() => session.retainComparison('again', guard(session)))).code).toBe('CONFLICT');
    await session.commitParameters({ ...defaults, eta: 0.5 }, guard(session));
    session.retainComparison('second', guard(session));
    await session.commitParameters({ ...defaults, eta: 0.6 }, guard(session));
    const full = session.getState();
    expect((await rejection(() => session.retainComparison('third', guard(session)))).diagnostics[0]).toMatchObject({ code: 'RESOURCE_LIMIT', recovery: expect.stringContaining('Remove') });
    expect(session.getState().comparisons).toBe(full.comparisons);
    expect(full.comparisons.map(item => item.label)).toEqual(['first', 'second']);
    expect(full.comparisons[0].frame.run).toEqual({ kind: 'committed', runId: full.comparisons[0].runId });
    session.removeComparison(full.comparisons[0].runId, guard(session));
    expect(session.getState().comparisons.map(item => item.label)).toEqual(['second']);
    expect((await rejection(() => session.removeComparison('missing', guard(session)))).code).toBe('NOT_FOUND');
  });
});

describe('lifecycle (§18, A42, A43)', () => {
  it('suspends without background work and resumes paused without catch-up', async () => {
    const { session, scheduler, group, events } = setup();
    await session.load(manifest, null, guard(session));
    await session.previewParameters('drag', { ...defaults, eta: 0.5 }, guard(session));
    session.cancelPreview(guard(session));
    session.play(guard(session));
    await tick(session, scheduler);
    expect(group.live).toBe(2);
    session.suspend();
    const suspended = session.getState();
    expect(suspended).toMatchObject({ status: 'suspended', playing: false, preview: null });
    expect(index(session)).toBe(1);
    expect(scheduler.pending).toBe(0);
    expect(group.live).toBe(0);
    expect(events.at(-1)!.type).toBe('suspended');
    for (const attempt of [
      () => session.navigate({ kind: 'index', index: 2 }, guard(session)),
      () => session.play(guard(session)),
      () => session.commitParameters(defaults, guard(session)),
      () => session.previewParameters('drag', defaults, guard(session)),
    ]) expect((await rejection(attempt)).code).toBe('NOT_READY');
    scheduler.advance(60_000);
    session.resume();
    expect(session.getState()).toMatchObject({ status: 'ready', playing: false });
    expect(index(session)).toBe(1);
    expect(scheduler.pending).toBe(0);
    expect(events.at(-1)!.type).toBe('resumed');
    await session.navigate({ kind: 'index', index: 2 }, guard(session));
    expect(index(session)).toBe(2);
  });

  it('rejects in-flight work on dispose and never calls listeners afterwards', async () => {
    const { session, group, events } = setup();
    await session.load(manifest, null, guard(session));
    await session.previewParameters('warm', { ...defaults, eta: 0.3 }, guard(session));
    session.cancelPreview(guard(session));
    group.hold = true;
    const navigation = session.navigate({ kind: 'index', index: 3 }, guard(session));
    const preview = session.previewParameters('drag', { ...defaults, eta: 0.5 }, guard(session));
    const queued = session.previewParameters('drag', { ...defaults, eta: 0.6 }, guard(session));
    await until(() => group.held.length === 2);
    session.dispose();
    const after = events.length;
    expect(events.at(-1)!.type).toBe('disposed');
    expect((await rejection(navigation)).code).toBe('DISPOSED');
    expect((await rejection(preview)).code).toBe('DISPOSED');
    expect((await rejection(queued)).code).toBe('DISPOSED');
    group.hold = false;
    group.flush();
    await settle(10);
    expect(events).toHaveLength(after);
    expect(group.live).toBe(0);
    expect(session.getState().status).toBe('disposed');
    expect((await rejection(session.navigate({ kind: 'index', index: 1 }, guard(session)))).code).toBe('DISPOSED');
    expect((await rejection(session.sample({ params: defaults, positions: [{ kind: 'index', index: 0 }] }))).code).toBe('DISPOSED');
    expect(() => session.subscribe(() => undefined)).toThrow(ModelError);
    session.dispose();
  });

  it('rejects a load that is still evaluating when disposed', async () => {
    const { session, group } = setup();
    group.hold = true;
    const loading = session.load(manifest, null, guard(session));
    await until(() => group.held.length === 1);
    session.dispose();
    expect((await rejection(loading)).code).toBe('DISPOSED');
  });

  it('isolates listeners from each other and from accepted state', async () => {
    const { session } = setup();
    const seen: string[] = [];
    session.subscribe(() => { throw new Error('observer failure'); });
    const unsubscribe = session.subscribe(event => seen.push(event.type));
    expect(seen).toEqual(['ready']);
    await session.load(manifest, null, guard(session));
    expect(seen).toContain('change');
    unsubscribe();
    const count = seen.length;
    await session.navigate({ kind: 'index', index: 1 }, guard(session));
    expect(seen).toHaveLength(count);
  });
});
