import { afterEach, describe, expect, it } from 'vitest';
import {
  createModelEvaluator, createModelSession, createWorkerBudget, evaluateRequest, frameId, ModelError, serveModelWorker, validateKernelOutput, validateManifest,
  type FramePosition, type KernelOutput, type ModelEvaluator, type ModelGuard, type ModelKernel, type ModelSession,
} from '../../packages/core/src/model/index';
import { allKernels, geometricKernel, geometricManifest, rectangleKernel, rectangleManifest } from './support/model-fixtures';
import { inlineWorkers, settle, until, type WorkerGroup } from './support/inline-worker';

const manifest = validateManifest(geometricManifest()).manifest;
const rectangle = validateManifest(rectangleManifest()).manifest;
const params = { a: 2, eta: 0.25, x0: 4 };
const at = (index: number) => ({ manifest, params, position: { kind: 'index' as const, index } });
const disposers: { dispose(): void }[] = [];
afterEach(() => { for (const item of disposers.splice(0)) item.dispose(); });
function evaluatorFor(group: WorkerGroup, options: Parameters<typeof createModelEvaluator>[1] = {}): ModelEvaluator {
  const evaluator = createModelEvaluator(group.factory, options);
  disposers.push(evaluator);
  return evaluator;
}
async function rejection(promise: Promise<unknown>): Promise<ModelError> {
  try { await promise; } catch (error) { expect(error).toBeInstanceOf(ModelError); return error as ModelError; }
  throw new Error('Expected a rejection.');
}
const kernelWith = (base: ModelKernel, evaluate: ModelKernel['evaluate']): ModelKernel => ({ ...base, evaluate });

describe('worker evaluator (report §16, A09, A14)', () => {
  it('evaluates installed kernels in the worker and validates every reply', async () => {
    const group = inlineWorkers(allKernels);
    const evaluator = evaluatorFor(group);
    const data = await evaluator.evaluate(at(2));
    expect(data.params).toEqual(params);
    expect(data.position).toEqual({ kind: 'index', index: 2, maxIndex: 12 });
    expect(data.quantities.position).toEqual({ status: 'valid', value: 1 });
    expect(data.quantities.regime).toEqual({ status: 'valid', value: 'monotone' });
    expect(data.terminal).toEqual({ reached: false });
    expect(data.geometry.trace).toEqual({ kind: 'polyline2', segments: [{ points: [[0, 4], [1, 2], [2, 1]], start: 'closed', end: 'closed' }], gaps: [] });
    const end = await evaluator.evaluate(at(12));
    expect(end.terminal).toEqual({ reached: true, event: 'max-index' });
    const shapes = await evaluator.evaluate({ manifest: rectangle, params: { w: 3, h: 4 }, position: { kind: 'static' } });
    expect(shapes.quantities.scale).toEqual({ status: 'valid', value: [3, 0, 0, 4] });
    expect(shapes.geometry.grid).toMatchObject({ kind: 'surface-grid', z: [0, null, 1, 2] });
    expect(group.workers).toHaveLength(1);
    expect(group.maxInFlight).toBe(1);
  });

  it('posts installed IDs and data only, never executable source (A09)', async () => {
    const group = inlineWorkers(allKernels);
    const posted: unknown[] = [];
    const evaluator = evaluatorFor({ ...group, factory: () => { const worker = group.factory(); const post = worker.postMessage.bind(worker); worker.postMessage = (message: unknown) => { posted.push(message); post(message); }; return worker; } });
    await evaluator.evaluate(at(1));
    expect(posted).toHaveLength(1);
    const message = posted[0] as { type: string; id: string; request: Record<string, unknown> };
    expect(Object.keys(message).sort()).toEqual(['id', 'request', 'type']);
    expect(Object.keys(message.request).sort()).toEqual(['manifest', 'params', 'position']);
    expect(JSON.parse(JSON.stringify(message))).toEqual(message);
    expect((message.request.manifest as typeof manifest).execution).toEqual({ kind: 'kernel', kernelId: 'test.geometric', kernelVersion: '1.0.0', mode: 'discrete', maxIndex: 12 });
    const smuggled = structuredClone(geometricManifest()) as unknown as { execution: Record<string, unknown> };
    smuggled.execution.module = 'https://example.invalid/kernel.js';
    expect((await rejection(evaluator.evaluate({ ...at(1), manifest: smuggled as never }))).code).toBe('SCHEMA');
    expect(posted).toHaveLength(1);
  });

  it('rejects fractional or out-of-range indices before anything is posted', async () => {
    const group = inlineWorkers(allKernels);
    const evaluator = evaluatorFor(group);
    expect((await rejection(evaluator.evaluate(at(2.5)))).diagnostics[0]).toMatchObject({ code: 'INVALID_INPUT', path: '$.position.index' });
    expect((await rejection(evaluator.evaluate(at(13)))).code).toBe('OUT_OF_DOMAIN');
    expect((await rejection(evaluator.evaluate({ manifest, params, position: { kind: 'time', time: 1 } }))).code).toBe('INVALID_INPUT');
    expect((await rejection(evaluator.evaluate({ manifest: rectangle, params: { w: 3, h: 4 }, position: { kind: 'index', index: 0 } }))).code).toBe('INVALID_INPUT');
    expect(group.received).toBe(0);
  });

  it('fails unknown kernels, mode mismatches and throwing kernels without leaking details', async () => {
    const throwing = kernelWith(geometricKernel, () => { throw new Error('SECRET internal state'); });
    const evaluator = evaluatorFor(inlineWorkers([throwing, rectangleKernel]));
    const thrown = await rejection(evaluator.evaluate(at(1)));
    expect(thrown.code).toBe('WORKER_ERROR');
    expect(JSON.stringify(thrown.diagnostics)).not.toContain('SECRET');
    const unknown = structuredClone(geometricManifest());
    (unknown.execution as { kernelVersion: string }).kernelVersion = '9.9.9';
    expect((await rejection(evaluator.evaluate({ ...at(1), manifest: unknown }))).code).toBe('UNSUPPORTED_CAPABILITY');
    const modeMismatch = evaluatorFor(inlineWorkers([{ ...geometricKernel, mode: 'static' }]));
    expect((await rejection(modeMismatch.evaluate(at(1)))).code).toBe('UNSUPPORTED_CAPABILITY');
    expect(() => serveModelWorker({ addEventListener() {}, postMessage() {} }, [geometricKernel, geometricKernel])).toThrow(/installed twice/);
  });

  it('rejects wrong shapes and oversized geometry produced by a kernel', async () => {
    const wrongShape = kernelWith(rectangleKernel, input => { const output = rectangleKernel.evaluate(input); return { ...output, quantities: { ...output.quantities, diagonal: { status: 'valid', value: [1, 2, 3] } } }; });
    const oversized = kernelWith(rectangleKernel, input => { const output = rectangleKernel.evaluate(input); return { ...output, geometry: { ...output.geometry, outline: { kind: 'polygon2', vertices: [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0.5]], degenerate: false } } }; });
    for (const kernel of [wrongShape, oversized]) {
      const evaluator = evaluatorFor(inlineWorkers([kernel]));
      const failure = await rejection(evaluator.evaluate({ manifest: rectangle, params: { w: 3, h: 4 }, position: { kind: 'static' } }));
      expect(failure.code).toBe('WORKER_ERROR');
      expect(failure.message).toMatch(/invalid frame/);
    }
  });

  it('terminates the worker on malformed, oversized, garbage or unknown replies (WORKER_PROTOCOL)', async () => {
    for (const hostility of ['malformed', 'oversized', 'garbage', 'unknown-type'] as const) {
      const group = inlineWorkers(allKernels, { hostility });
      const evaluator = evaluatorFor(group);
      expect((await rejection(evaluator.evaluate(at(1)))).code).toBe('WORKER_PROTOCOL');
      expect(group.terminated).toBe(1);
      group.hostility = 'none';
      expect((await evaluator.evaluate(at(1))).quantities.position).toEqual({ status: 'valid', value: 2 });
      expect(group.workers).toHaveLength(2);
    }
  });

  it('enforces the watchdog for excess work, ignores late replies and recovers with a fresh worker', async () => {
    const group = inlineWorkers(allKernels, { hostility: 'silent' });
    const evaluator = evaluatorFor(group, { timeoutMs: 30 });
    const timeout = await rejection(evaluator.evaluate(at(3)));
    expect(timeout.code).toBe('WORKER_TIMEOUT');
    expect(group.terminated).toBe(1);
    // A reply for another job is ignored; the watchdog still decides.
    group.hostility = 'wrong-id';
    expect((await rejection(evaluator.evaluate(at(3)))).code).toBe('WORKER_TIMEOUT');
    group.hostility = 'none';
    group.delayMs = 60;
    const slow = evaluator.evaluate(at(4));
    expect((await rejection(slow)).code).toBe('WORKER_TIMEOUT');
    group.delayMs = 0;
    await settle(80); // the slow worker's reply would arrive now; it was terminated and nothing resolves twice
    expect((await evaluator.evaluate(at(5))).position).toEqual({ kind: 'index', index: 5, maxIndex: 12 });
  });

  it('cancels active and queued jobs with AbortSignal and serializes the rest', async () => {
    const group = inlineWorkers(allKernels);
    const evaluator = evaluatorFor(group);
    const first = new AbortController(), second = new AbortController();
    const a = evaluator.evaluate(at(1), first.signal);
    const b = evaluator.evaluate(at(2), second.signal);
    const c = evaluator.evaluate(at(3));
    second.abort();
    first.abort();
    expect((await rejection(a)).code).toBe('CANCELLED');
    expect((await rejection(b)).code).toBe('CANCELLED');
    expect((await c).position).toMatchObject({ index: 3 });
    expect(group.maxInFlight).toBe(1);
    const aborted = new AbortController(); aborted.abort();
    expect((await rejection(evaluator.evaluate(at(1), aborted.signal))).code).toBe('CANCELLED');
  });

  it('reports a crashed worker and restarts it on demand', async () => {
    const group = inlineWorkers(allKernels, { hostility: 'crash' });
    const evaluator = evaluatorFor(group);
    expect((await rejection(evaluator.evaluate(at(1)))).code).toBe('WORKER_ERROR');
    expect(group.terminated).toBe(1);
    group.hostility = 'none';
    await expect(evaluator.evaluate(at(1))).resolves.toBeTruthy();
  });

  it('bounds the queue and rejects everything after disposal', async () => {
    const group = inlineWorkers(allKernels, { hostility: 'silent' });
    const evaluator = evaluatorFor(group, { queueLimit: 2 });
    const pending = [evaluator.evaluate(at(1)), evaluator.evaluate(at(2))];
    expect((await rejection(evaluator.evaluate(at(3)))).code).toBe('RESOURCE_LIMIT');
    evaluator.dispose();
    expect(evaluator.disposed).toBe(true);
    for (const promise of pending) expect((await rejection(promise)).code).toBe('DISPOSED');
    expect((await rejection(evaluator.evaluate(at(1)))).code).toBe('DISPOSED');
    expect(group.live).toBe(0);
    expect(group.workers[0].listenerCount()).toBe(0);
  });
});

describe('kernel output validation (report §16)', () => {
  const index = (i: number): FramePosition => ({ kind: 'index', index: i, maxIndex: 12 });
  const output = (i: number) => geometricKernel.evaluate({ params, index: i }) as KernelOutput;
  const protocol = (run: () => unknown) => { try { run(); } catch (error) { expect(error).toBeInstanceOf(ModelError); expect((error as ModelError).code).toBe('WORKER_PROTOCOL'); return (error as ModelError).diagnostics[0]; } throw new Error('Expected WORKER_PROTOCOL.'); };

  it('requires exact keys, declared shapes and status-specific fields', () => {
    expect(validateKernelOutput(manifest, index(1), output(1)).terminal).toEqual({ reached: false });
    protocol(() => validateKernelOutput(manifest, index(1), { ...output(1), extra: true }));
    const missing = output(1); delete (missing.quantities as Record<string, unknown>).ratio;
    expect(protocol(() => validateKernelOutput(manifest, index(1), missing)).path).toBe('$.quantities.ratio');
    const category = output(1); category.quantities.regime = { status: 'valid', value: 'converging' };
    expect(protocol(() => validateKernelOutput(manifest, index(1), category)).path).toBe('$.quantities.regime.value');
    const mixed = output(1); mixed.quantities.position = { status: 'valid', value: 2, reason: 'extra' } as never;
    protocol(() => validateKernelOutput(manifest, index(1), mixed));
    const undefinedValue = output(1); undefinedValue.quantities.position = { status: 'undefined', code: 'ZERO', reason: 'x', value: 0 } as never;
    protocol(() => validateKernelOutput(manifest, index(1), undefinedValue));
    const lowercase = output(1); lowercase.quantities.position = { status: 'undefined', code: 'zero', reason: 'x' };
    protocol(() => validateKernelOutput(manifest, index(1), lowercase));
    const longReason = output(1); longReason.quantities.position = { status: 'undefined', code: 'ZERO', reason: 'x'.repeat(2001) };
    protocol(() => validateKernelOutput(manifest, index(1), longReason));
    const late = output(1); late.quantities.position = { status: 'numerical-limit', code: 'OVERFLOW', reason: 'x', lastFiniteIndex: 4 };
    protocol(() => validateKernelOutput(manifest, index(1), late));
    const matrix = rectangleKernel.evaluate({ params: { w: 1, h: 2 }, index: 0 });
    matrix.quantities.scale = { status: 'valid', value: [1, 0, 0] };
    protocol(() => validateKernelOutput(rectangle, { kind: 'static' }, matrix));
  });

  it('rejects nonfinite coordinates, empty segments, inconsistent gaps and accessor payloads', () => {
    const nan = output(2); (nan.geometry.trace as { segments: { points: number[][] }[] }).segments[0].points[1][1] = Number.NaN;
    protocol(() => validateKernelOutput(manifest, index(2), nan));
    const empty = output(2); (empty.geometry.trace as { segments: unknown[] }).segments.push({ points: [], start: 'none', end: 'none' });
    protocol(() => validateKernelOutput(manifest, index(2), empty));
    const gap = output(2); (gap.geometry.trace as { gaps: unknown[] }).gaps.push({ after: 0, before: 3, reason: 'x' });
    protocol(() => validateKernelOutput(manifest, index(2), gap));
    const missingReason = rectangleKernel.evaluate({ params: { w: 1, h: 2 }, index: 0 });
    (missingReason.geometry.corners as { points: { at: unknown }[] }).points[0].at = null;
    protocol(() => validateKernelOutput(rectangle, { kind: 'static' }, missingReason));
    let touched = false;
    const getter = output(1) as unknown as Record<string, unknown>;
    Object.defineProperty(getter, 'terminal', { enumerable: true, get() { touched = true; return undefined; } });
    protocol(() => validateKernelOutput(manifest, index(1), getter));
    expect(touched).toBe(false);
    const huge = output(1); (huge.geometry.trace as { segments: { points: number[][] }[] }).segments[0].points = Array.from({ length: 100_000 }, (_, i) => [i, i]);
    expect(protocol(() => validateKernelOutput(manifest, index(1), huge)).message).toMatch(/exceeds/);
  });

  it('requires terminal state consistent with the position', () => {
    expect(validateKernelOutput(manifest, index(12), output(12)).terminal).toEqual({ reached: true, event: 'max-index' });
    protocol(() => validateKernelOutput(manifest, index(12), { ...output(12), terminal: { reached: false } }));
    protocol(() => validateKernelOutput(manifest, index(3), { ...output(3), terminal: { reached: true, event: 'max-index' } }));
    protocol(() => validateKernelOutput(manifest, index(3), { ...output(3), terminal: { reached: true } }));
    const limited = geometricKernel.evaluate({ params: { a: 5, eta: 0.5, x0: 10 }, index: 12 });
    expect(validateKernelOutput(manifest, index(12), limited).terminal).toMatchObject({ reached: true, event: 'numerical-limit' });
    protocol(() => validateKernelOutput(rectangle, { kind: 'static' }, { ...rectangleKernel.evaluate({ params: { w: 1, h: 2 }, index: 0 }), terminal: { reached: true, event: 'end-time' } }));
  });

  it('derives deterministic frame identities', () => {
    const model = { modelId: 'm', version: '1.0.0', digest: 'sha256:' + 'a'.repeat(64) };
    const position: FramePosition = { kind: 'index', index: 2, maxIndex: 12 };
    const run = { kind: 'committed' as const, runId: 'r1' };
    expect(frameId(model, run, params, position)).toBe(frameId(model, { ...run }, { ...params }, { ...position }));
    expect(frameId(model, run, params, position)).not.toBe(frameId(model, { kind: 'tentative', previewId: 'p', baseRunId: 'r1' }, params, position));
    expect(frameId(model, run, params, position)).not.toBe(frameId(model, run, { ...params, eta: 0.3 }, position));
  });

  it('evaluates trusted requests in-process with the same checks (worker entry seam)', () => {
    expect(evaluateRequest(at(1), allKernels).quantities.position).toEqual({ status: 'valid', value: 2 });
    expect(() => evaluateRequest({ ...at(1), extra: 1 }, allKernels)).toThrow(ModelError);
  });
});

describe('worker budget (report §9, §18)', () => {
  it('bounds workers, prioritizes primary leases and rejects a full wait queue', async () => {
    const group = inlineWorkers(allKernels);
    const budget = createWorkerBudget({ maxWorkers: 2, workerFactory: group.factory, maxWaiting: 2 });
    disposers.push(budget);
    const a = await budget.acquire('activity-a', 'primary');
    const b = await budget.acquire('activity-b', 'scratch');
    const order: string[] = [];
    const scratch = budget.acquire('activity-c', 'scratch').then(lease => { order.push('scratch'); return lease; });
    const primary = budget.acquire('activity-c', 'primary').then(lease => { order.push('primary'); return lease; });
    expect((await rejection(budget.acquire('activity-d', 'sample'))).code).toBe('RESOURCE_LIMIT');
    expect(budget.stats()).toMatchObject({ workers: 2, active: 2, idle: 0, waiting: 2 });
    b.release();
    const granted = await primary;
    expect(order).toEqual(['primary']);
    a.release();
    await scratch;
    expect(order).toEqual(['primary', 'scratch']);
    expect(budget.stats().leases).toEqual([{ ownerId: 'activity-c', purpose: 'primary' }, { ownerId: 'activity-c', purpose: 'scratch' }]);
    expect(granted.evaluator.disposed).toBe(false);
  });

  it('disposes on release by default, rejecting the released lease\'s pending work', async () => {
    const group = inlineWorkers(allKernels, { hostility: 'silent' });
    const budget = createWorkerBudget({ maxWorkers: 1, workerFactory: group.factory });
    disposers.push(budget);
    const lease = await budget.acquire('owner', 'scratch');
    const pending = lease.evaluator.evaluate(at(1));
    await until(() => group.received === 1);
    lease.release();
    lease.release();
    expect((await rejection(pending)).code).toBe('DISPOSED');
    expect((await rejection(lease.evaluator.evaluate(at(1)))).code).toBe('DISPOSED');
    expect(group.live).toBe(0);
    expect(budget.stats()).toMatchObject({ workers: 0, active: 0, idle: 0 });
  });

  it('optionally keeps idle evaluators for reuse within idleMs', async () => {
    const group = inlineWorkers(allKernels);
    const budget = createWorkerBudget({ maxWorkers: 1, workerFactory: group.factory, idleMs: 40 });
    disposers.push(budget);
    const first = await budget.acquire('owner', 'primary');
    await first.evaluator.evaluate(at(1));
    first.release();
    expect(budget.stats()).toMatchObject({ workers: 1, active: 0, idle: 1 });
    const second = await budget.acquire('owner', 'primary');
    await second.evaluator.evaluate(at(2));
    expect(group.workers).toHaveLength(1);
    second.release();
    await settle(70);
    expect(budget.stats()).toMatchObject({ workers: 0, idle: 0 });
    expect(group.live).toBe(0);
  });

  it('cancels waiting requests and rejects everything on dispose', async () => {
    const group = inlineWorkers(allKernels);
    const budget = createWorkerBudget({ maxWorkers: 1, workerFactory: group.factory });
    const held = await budget.acquire('owner', 'primary');
    const controller = new AbortController();
    const cancelled = budget.acquire('other', 'scratch', controller.signal);
    controller.abort();
    expect((await rejection(cancelled)).code).toBe('CANCELLED');
    const waiting = budget.acquire('other', 'sample');
    budget.dispose();
    expect((await rejection(waiting)).code).toBe('DISPOSED');
    expect((await rejection(held.evaluator.evaluate(at(1)))).code).toBe('DISPOSED');
    expect((await rejection(budget.acquire('owner', 'primary'))).code).toBe('DISPOSED');
  });
});

describe('accepted state survives hostile workers (A14)', () => {
  const sessions: ModelSession[] = [];
  afterEach(() => { for (const session of sessions.splice(0)) session.dispose(); });
  let operation = 0;
  const guard = (session: ModelSession): ModelGuard => ({ sessionId: session.id, expectedVersion: session.getState().version, expectedRunId: session.getState().run?.id ?? null, operationId: `h-${++operation}` });

  it('keeps the last accepted frame marked stale after each failure class', async () => {
    const group = inlineWorkers(allKernels);
    const session = createModelSession({ workerFactory: group.factory, evaluatorOptions: { timeoutMs: 40 } });
    sessions.push(session);
    await session.load(manifest, null, guard(session));
    await session.navigate({ kind: 'index', index: 3 }, guard(session));
    const accepted = session.getState();
    for (const [hostility, code] of [['malformed', 'WORKER_PROTOCOL'], ['oversized', 'WORKER_PROTOCOL'], ['silent', 'WORKER_TIMEOUT'], ['crash', 'WORKER_ERROR'], ['garbage', 'WORKER_PROTOCOL']] as const) {
      group.hostility = hostility;
      expect((await rejection(session.commitParameters({ a: 2, eta: 0.5, x0: 4 }, guard(session)))).code).toBe(code);
      const state = session.getState();
      expect(state.frame).toBe(accepted.frame);
      expect(state.run).toBe(accepted.run);
      expect(state.version).toBe(accepted.version);
      expect(state).toMatchObject({ stale: true, error: [expect.objectContaining({ code })] });
    }
    group.hostility = 'none';
    const recovered = await session.commitParameters({ a: 2, eta: 0.5, x0: 4 }, guard(session));
    expect(recovered).toMatchObject({ stale: false, error: null, version: accepted.version + 1 });
    expect(recovered.frame!.params).toEqual({ a: 2, eta: 0.5, x0: 4 });
  });
});
