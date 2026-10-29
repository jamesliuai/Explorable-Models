/**
 * Shared bounded worker budget across activities (report §9, §18; D11). Every lease owns one evaluator (one worker,
 * created lazily on first evaluation). `primary` requests wait ahead of `scratch` and `sample` requests; waiting is a
 * bounded FIFO and a full queue rejects with RESOURCE_LIMIT.
 *
 * Release policy: with the default `idleMs: 0` a released evaluator is disposed immediately (its worker terminated),
 * which keeps ownership deterministic and leaves no worker behind a suspended or historical card. With `idleMs > 0`
 * an evaluator released without pending work is kept idle for at most `idleMs` and handed to the next lease; idle
 * evaluators count toward `maxWorkers`. Reuse is opt-in because it has not been measured to help.
 *
 * Reclamation and bounded waits (report §9 "Budget scratch workers across activities", §5.3): an owner marks a scratch
 * or sample lease reclaimable while it can do without it (a model session's scratch lease between preview gestures).
 * Whenever a request would otherwise wait, the budget releases a reclaimable lease — terminating its worker — and
 * grants the request instead, so an idle scratch worker never keeps another activity's primary request waiting; the
 * owner leases again on its next preview. A request that still cannot be granted within `maxWaitMs` (default 10 s)
 * fails with RESOURCE_LIMIT and a recovery instead of waiting without bound.
 */
import { diagnostic, fail, ModelError, modelError } from './errors.js';
import { createModelEvaluator, type ModelEvaluatorOptions } from './evaluator.js';
import type { ModelEvaluator } from './types.js';

export type LeasePurpose = 'primary' | 'scratch' | 'sample';
export interface Lease {
  readonly ownerId: string;
  readonly purpose: LeasePurpose;
  /** Lease-scoped evaluator. `dispose()` releases the lease; after release every call rejects with DISPOSED. */
  readonly evaluator: ModelEvaluator;
  /** Idempotent. Pending evaluations of this lease reject with DISPOSED. */
  release(): void;
  /**
   * Additive: marks whether the owner can do without this lease now. While reclaimable, the budget releases the lease
   * (as `release()` does) as soon as another request would otherwise wait; the owner then sees `evaluator.disposed`
   * and leases again when it next needs a worker. Ignored for `primary` leases and after release.
   */
  setReclaimable(reclaimable: boolean): void;
}
/** `reclaimable`: leases currently marked reclaimable (additive). */
export interface WorkerBudgetStats { workers: number; active: number; idle: number; waiting: number; reclaimable: number; leases: { ownerId: string; purpose: LeasePurpose }[] }
export interface WorkerBudget {
  readonly maxWorkers: number;
  acquire(ownerId: string, purpose: LeasePurpose, signal?: AbortSignal): Promise<Lease>;
  stats(): WorkerBudgetStats;
  dispose(): void;
  readonly disposed: boolean;
}
export interface WorkerBudgetOptions {
  maxWorkers: number;
  workerFactory: () => Worker;
  /** Keep released evaluators idle for reuse (ms). Default 0: dispose on release. */
  idleMs?: number;
  /** Bounded wait queue. Default 32. */
  maxWaiting?: number;
  /** Longest wait for a lease before the request fails with RESOURCE_LIMIT (ms, 1–600000). Default 10000. */
  maxWaitMs?: number;
  evaluator?: ModelEvaluatorOptions;
  scheduler?: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
}

/** Default bound on a lease wait (report §5.3: a pending resource gets a diagnostic, not an unbounded wait). */
export const DEFAULT_MAX_WAIT_MS = 10_000;
type Waiter = { ownerId: string; purpose: LeasePurpose; resolve: (lease: Lease) => void; reject: (error: unknown) => void; signal?: AbortSignal; abort: () => void; timer: unknown };
type Idle = { evaluator: ModelEvaluator; timer: unknown };
const OWNER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export function createWorkerBudget(options: WorkerBudgetOptions): WorkerBudget {
  const { maxWorkers, workerFactory } = options;
  if (!Number.isSafeInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 64) fail('INVALID_INPUT', '$.maxWorkers', 'Expected an integer from 1 to 64.');
  if (typeof workerFactory !== 'function') fail('INVALID_INPUT', '$.workerFactory', 'A worker factory is required.');
  const idleMs = options.idleMs ?? 0, maxWaiting = options.maxWaiting ?? 32, maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  if (!Number.isSafeInteger(idleMs) || idleMs < 0 || idleMs > 600_000) fail('INVALID_INPUT', '$.idleMs', 'Expected an integer from 0 to 600000.');
  if (!Number.isSafeInteger(maxWaiting) || maxWaiting < 0 || maxWaiting > 1024) fail('INVALID_INPUT', '$.maxWaiting', 'Expected an integer from 0 to 1024.');
  if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs < 1 || maxWaitMs > 600_000) fail('INVALID_INPUT', '$.maxWaitMs', 'Expected an integer from 1 to 600000.');
  createModelEvaluator(workerFactory, options.evaluator).dispose(); // validates evaluator options eagerly; no worker is created
  const scheduler = options.scheduler ?? { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>) };
  const leases = new Map<{ ownerId: string; purpose: LeasePurpose }, Lease>();
  /** Leases their owners marked reclaimable, each with the function that releases it without draining the queue. */
  const reclaimable = new Map<Lease, () => void>();
  const idle: Idle[] = [];
  const waiting: Waiter[] = [];
  let disposed = false;

  const disposeIdle = (entry: Idle) => { scheduler.clearTimeout(entry.timer); const index = idle.indexOf(entry); if (index >= 0) idle.splice(index, 1); entry.evaluator.dispose(); };
  function grant(ownerId: string, purpose: LeasePurpose): Lease {
    const reused = idle.pop();
    // Invariant: active + idle ≤ maxWorkers, because a new evaluator is created only when none is idle.
    if (reused) scheduler.clearTimeout(reused.timer);
    const underlying = reused?.evaluator ?? createModelEvaluator(workerFactory, options.evaluator);
    const record = { ownerId, purpose };
    const lifetime = new AbortController();
    let released = false, pending = 0;
    const disposedError = () => new ModelError([diagnostic('DISPOSED', '$', 'The worker lease was released.')]);
    const evaluator: ModelEvaluator = {
      async evaluate(request, signal) {
        if (released) throw disposedError();
        const controller = new AbortController();
        const forward = () => controller.abort();
        signal?.addEventListener('abort', forward, { once: true });
        lifetime.signal.addEventListener('abort', forward, { once: true });
        if (signal?.aborted) controller.abort();
        pending++;
        try { return await underlying.evaluate(request, controller.signal); } catch (error) {
          if (released && !signal?.aborted) throw disposedError();
          throw error;
        } finally {
          pending--;
          signal?.removeEventListener('abort', forward);
          lifetime.signal.removeEventListener('abort', forward);
        }
      },
      dispose() { lease.release(); },
      get disposed() { return released; },
    };
    const free = () => {
      if (released) return;
      released = true;
      const busy = pending > 0;
      lifetime.abort();
      leases.delete(record);
      reclaimable.delete(lease);
      if (disposed || idleMs === 0 || busy || underlying.disposed) underlying.dispose();
      else { const entry: Idle = { evaluator: underlying, timer: null }; entry.timer = scheduler.setTimeout(() => disposeIdle(entry), idleMs); idle.push(entry); }
    };
    const lease: Lease = {
      ownerId, purpose, evaluator,
      release() {
        if (released) return;
        free();
        drain();
      },
      setReclaimable(value) {
        if (released || purpose === 'primary') return;
        if (!value) { reclaimable.delete(lease); return; }
        reclaimable.set(lease, free);
        drain();
      },
    };
    leases.set(record, lease);
    return lease;
  }
  /** A free slot, made by releasing the oldest reclaimable lease when every slot is leased. */
  function room(): boolean {
    if (leases.size < maxWorkers) return true;
    const oldest = reclaimable.values().next();
    if (oldest.done) return false;
    oldest.value();
    return leases.size < maxWorkers;
  }
  function settleWaiter(waiter: Waiter): void {
    waiter.signal?.removeEventListener('abort', waiter.abort);
    scheduler.clearTimeout(waiter.timer);
  }
  function drain(): void {
    while (!disposed && waiting.length && room()) {
      const next = waiting.shift()!;
      settleWaiter(next);
      next.resolve(grant(next.ownerId, next.purpose));
    }
  }
  return {
    maxWorkers,
    acquire(ownerId, purpose, signal) {
      if (disposed) return Promise.reject(modelError('DISPOSED', '$', 'The worker budget has been disposed.'));
      if (typeof ownerId !== 'string' || !OWNER.test(ownerId) || !['primary', 'scratch', 'sample'].includes(purpose)) return Promise.reject(modelError('INVALID_INPUT', '$', 'Expected an owner ID and a lease purpose.'));
      if (signal?.aborted) return Promise.reject(modelError('CANCELLED', '$', 'Lease request was cancelled.'));
      if ((purpose === 'primary' || !waiting.length) && room()) return Promise.resolve(grant(ownerId, purpose));
      if (waiting.length >= maxWaiting) return Promise.reject(modelError('RESOURCE_LIMIT', '$', `All ${maxWorkers} workers are leased and the wait queue is full.`, 'Suspend or dispose inactive activities, then retry.'));
      return new Promise<Lease>((resolve, reject) => {
        const leave = () => { const index = waiting.indexOf(waiter); if (index >= 0) waiting.splice(index, 1); settleWaiter(waiter); };
        const waiter: Waiter = {
          ownerId, purpose, resolve, reject, signal, timer: undefined,
          abort: () => { leave(); reject(modelError('CANCELLED', '$', 'Lease request was cancelled.')); },
        };
        waiter.timer = scheduler.setTimeout(() => {
          leave();
          reject(modelError('RESOURCE_LIMIT', '$', `No worker became free within ${maxWaitMs} ms: all ${maxWorkers} workers are in use by other activities.`, 'Suspend, hide or close another activity (or configure more workers), then retry.'));
        }, maxWaitMs);
        signal?.addEventListener('abort', waiter.abort, { once: true });
        // Primary requests queue ahead of every scratch/sample request, FIFO among themselves.
        const firstSecondary = purpose === 'primary' ? waiting.findIndex(item => item.purpose !== 'primary') : -1;
        if (firstSecondary >= 0) waiting.splice(firstSecondary, 0, waiter); else waiting.push(waiter);
      });
    },
    stats() {
      return { workers: leases.size + idle.length, active: leases.size, idle: idle.length, waiting: waiting.length, reclaimable: reclaimable.size, leases: [...leases.keys()].map(lease => ({ ...lease })) };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of [...idle]) disposeIdle(entry);
      for (const waiter of waiting.splice(0)) { settleWaiter(waiter); waiter.reject(modelError('DISPOSED', '$', 'The worker budget has been disposed.')); }
      // Outstanding leases are invalidated: their evaluators are disposed and reject further work.
      for (const lease of [...leases.values()]) lease.release();
    },
    get disposed() { return disposed; },
  };
}
