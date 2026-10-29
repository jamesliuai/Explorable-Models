/**
 * Shared worker budget: idle scratch leases never starve a primary request, and a wait that cannot be satisfied ends
 * with a diagnostic and a recovery (report §9 "Budget scratch workers across activities", §18 global worker budget,
 * §5.3 stable diagnostics; A41, A42, A43). Review finding R43.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  createModelSession, createWorkerBudget, DEFAULT_MAX_WAIT_MS, ModelError, validateManifest,
  type ModelGuard, type ModelSession, type WorkerBudget,
} from '../../packages/core/src/model/index';
import { allKernels, geometricManifest } from './support/model-fixtures';
import { inlineWorkers, ManualScheduler } from './support/inline-worker';

const { manifest } = validateManifest(geometricManifest());
const defaults = { a: 2, eta: 0.25, x0: 4 };
const cleanup: { dispose(): void }[] = [];
afterEach(() => { for (const item of cleanup.splice(0)) item.dispose(); });
let operation = 0;
const guard = (session: ModelSession): ModelGuard => ({ sessionId: session.id, expectedVersion: session.getState().version, expectedRunId: session.getState().run?.id ?? null, operationId: `reclaim-${++operation}` });
async function rejection(promise: Promise<unknown>): Promise<ModelError> {
  try { await promise; } catch (error) { expect(error).toBeInstanceOf(ModelError); return error as ModelError; }
  throw new Error('Expected a ModelError.');
}
const pendingAfter = async <T>(promise: Promise<T>): Promise<boolean> => {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  return !settled;
};
function budgetWith(maxWorkers: number, scheduler = new ManualScheduler()): { budget: WorkerBudget; scheduler: ManualScheduler } {
  const budget = createWorkerBudget({ maxWorkers, workerFactory: inlineWorkers(allKernels).factory, scheduler });
  cleanup.push(budget);
  return { budget, scheduler };
}

describe('worker budget: reclamation and bounded waits (R43)', () => {
  it('releases a reclaimable scratch lease to a primary request that would otherwise wait', async () => {
    const { budget, scheduler } = budgetWith(2);
    const primary = await budget.acquire('card-a', 'primary');
    const scratch = await budget.acquire('card-a', 'scratch');
    scratch.setReclaimable(true);
    // Marking alone frees nothing: no request is waiting.
    expect(budget.stats()).toMatchObject({ active: 2, reclaimable: 1, waiting: 0 });
    expect(scratch.evaluator.disposed).toBe(false);
    const third = await budget.acquire('card-b', 'primary');
    expect(scratch.evaluator.disposed).toBe(true);
    expect(budget.stats().leases).toEqual([{ ownerId: 'card-a', purpose: 'primary' }, { ownerId: 'card-b', purpose: 'primary' }]);
    expect(budget.stats()).toMatchObject({ workers: 2, reclaimable: 0 });
    expect(third.evaluator.disposed).toBe(false);
    expect(primary.evaluator.disposed).toBe(false);
    expect(scheduler.pending).toBe(0);
  });

  it('never reclaims a primary lease or a lease its owner still needs', async () => {
    const { budget } = budgetWith(2);
    const primary = await budget.acquire('card-a', 'primary');
    const scratch = await budget.acquire('card-a', 'scratch');
    primary.setReclaimable(true);
    scratch.setReclaimable(true);
    scratch.setReclaimable(false);
    expect(budget.stats().reclaimable).toBe(0);
    const waiting = budget.acquire('card-b', 'primary');
    expect(await pendingAfter(waiting)).toBe(true);
    expect(primary.evaluator.disposed).toBe(false);
    expect(scratch.evaluator.disposed).toBe(false);
    // Marking the scratch lease reclaimable while a request waits hands its slot over at once.
    scratch.setReclaimable(true);
    const granted = await waiting;
    expect(scratch.evaluator.disposed).toBe(true);
    expect(granted.ownerId).toBe('card-b');
  });

  it('fails a wait that cannot be satisfied with RESOURCE_LIMIT and a recovery, leaving no timer or waiter behind', async () => {
    const { budget, scheduler } = budgetWith(1);
    await budget.acquire('card-a', 'primary');
    const waiting = budget.acquire('card-b', 'primary');
    expect(await pendingAfter(waiting)).toBe(true);
    expect(budget.stats().waiting).toBe(1);
    expect(scheduler.pending).toBe(1);
    expect(scheduler.runNext()).toBe(true);
    const error = await rejection(waiting);
    expect(error.diagnostics[0]).toEqual({
      code: 'RESOURCE_LIMIT', path: '$',
      message: `No worker became free within ${DEFAULT_MAX_WAIT_MS} ms: all 1 workers are in use by other activities.`,
      recovery: 'Suspend, hide or close another activity (or configure more workers), then retry.',
    });
    expect(budget.stats()).toMatchObject({ waiting: 0, active: 1 });
    expect(scheduler.pending).toBe(0);
  });

  it('clears the wait timer when a waiter is granted, cancelled or the budget is disposed', async () => {
    const { budget, scheduler } = budgetWith(1);
    const held = await budget.acquire('card-a', 'primary');
    const granted = budget.acquire('card-b', 'primary');
    held.release();
    await granted;
    expect(scheduler.pending).toBe(0);
    const controller = new AbortController();
    const cancelled = budget.acquire('card-c', 'scratch', controller.signal);
    expect(scheduler.pending).toBe(1);
    controller.abort();
    expect((await rejection(cancelled)).code).toBe('CANCELLED');
    expect(scheduler.pending).toBe(0);
    const orphan = budget.acquire('card-d', 'primary');
    budget.dispose();
    expect((await rejection(orphan)).code).toBe('DISPOSED');
    expect(scheduler.pending).toBe(0);
    expect(() => createWorkerBudget({ maxWorkers: 1, workerFactory: inlineWorkers(allKernels).factory, maxWaitMs: 0 })).toThrow(ModelError);
  });
});

describe('model sessions on a shared budget: idle scratch workers do not starve other activities (R43)', () => {
  it('lets a third session load while two sessions keep their scratch leases between gestures, then re-leases on the next preview', async () => {
    const group = inlineWorkers(allKernels);
    const budget = createWorkerBudget({ maxWorkers: 4, workerFactory: group.factory });
    cleanup.push(budget);
    const sessions = ['card-a', 'card-b', 'card-c'].map(ownerId => { const session = createModelSession({ budget, ownerId }); cleanup.push(session); return session; });
    const [a, b, c] = sessions as [ModelSession, ModelSession, ModelSession];
    for (const session of [a, b]) {
      await session.load(manifest, null, guard(session));
      await session.previewParameters('drag', { ...defaults, eta: 0.5 }, guard(session));
      await session.commitParameters({ ...defaults, eta: 0.5 }, guard(session));
    }
    // Two primaries plus two idle (reclaimable) scratch leases fill the default-sized budget.
    expect(budget.stats()).toMatchObject({ active: 4, reclaimable: 2 });
    const loaded = await c.load(manifest, null, guard(c));
    expect(loaded.status).toBe('ready');
    expect(budget.stats().leases).toEqual(expect.arrayContaining([{ ownerId: 'card-c', purpose: 'primary' }]));
    expect(budget.stats().leases.filter(lease => lease.purpose === 'scratch')).toHaveLength(1);
    // The card whose scratch worker was reclaimed previews again with a fresh lease; the other's is reclaimed for it.
    const reclaimedOwner = budget.stats().leases.some(lease => lease.ownerId === 'card-a' && lease.purpose === 'scratch') ? b : a;
    const preview = await reclaimedOwner.previewParameters('drag-2', { ...defaults, eta: 0.6 }, guard(reclaimedOwner));
    expect(preview).toMatchObject({ status: 'ready', frame: expect.objectContaining({ run: expect.objectContaining({ kind: 'tentative' }) }) });
    expect(budget.stats().active).toBeLessThanOrEqual(4);
  });

  it('keeps the scratch lease of a gesture in progress and gives the waiting request a diagnostic instead of waiting forever', async () => {
    const group = inlineWorkers(allKernels);
    const scheduler = new ManualScheduler();
    const budget = createWorkerBudget({ maxWorkers: 2, workerFactory: group.factory, scheduler });
    cleanup.push(budget);
    const a = createModelSession({ budget, ownerId: 'card-a' }), b = createModelSession({ budget, ownerId: 'card-b' });
    cleanup.push(a, b);
    await a.load(manifest, null, guard(a));
    await a.previewParameters('drag', { ...defaults, eta: 0.5 }, guard(a));
    expect(budget.stats()).toMatchObject({ active: 2, reclaimable: 0 });
    const loading = b.load(manifest, null, guard(b));
    expect(await pendingAfter(loading)).toBe(true);
    expect(scheduler.runNext()).toBe(true);
    expect((await rejection(loading)).code).toBe('RESOURCE_LIMIT');
    // The gesture was never interrupted.
    expect(a.getState().preview).toMatchObject({ previewId: 'drag', status: 'ready' });
    // Ending the gesture makes the scratch worker available: the retried load succeeds.
    await a.commitParameters({ ...defaults, eta: 0.5 }, guard(a));
    expect((await b.load(manifest, null, guard(b))).status).toBe('ready');
  });
});
