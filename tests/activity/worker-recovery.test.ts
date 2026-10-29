/**
 * Worker failure recovery and the disposed notification (report §9, §10.4; A11, A14, A43; gaps G25/G38 and G39).
 * In-process test workers and the memory host: fixture results, not evidence about a packaged host.
 *
 * - After a worker timeout or crash the projected `retry` recovery (`retryPersistence`) re-issues the failed scientific
 *   operation with fresh guards: the card leaves `recoverable-failure` at the requested position with a freshly
 *   evaluated committed frame, while the last accepted frame stays shown until then.
 * - Recovery is bounded: after WORKER_RECOVERY_ATTEMPTS failed attempts the status offers `reload`, the last accepted
 *   frame stays, and further retries create no worker.
 * - A re-issue the current stage no longer permits re-evaluates the shown position instead (no policy bypass).
 * - Disposing an activity notifies its listeners exactly once with the disposed projection, then never again.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { WORKER_RECOVERY_ATTEMPTS } from '../../packages/activity/src/controller';
import type { InteractionEvent } from '../../packages/activity/src/contracts';
import { ackCurrent, activityGuard, codesOf, enterExplore, guards, harness, okOf, op, open, settled, type Harness } from './support/adapter-harness';

let current: Harness | null = null;
afterEach(() => { current?.adapter.dispose(); current = null; });
const ofType = (events: InteractionEvent[], type: string) => events.filter(event => event.type === type).map(event => event.payload as Record<string, unknown>);

async function exploring(h: Harness) {
  const opened = await open(h);
  await enterExplore(h, opened);
  okOf(await opened.learner.navigate({ operationId: op(), ...guards(opened.learner), position: { kind: 'index', index: 2 } }));
  await settled(h);
  return opened;
}

describe('worker failure recovery (G25/G38)', () => {
  it('a failed navigation is re-issued by the projected retry and reaches the requested index with a fresh frame', async () => {
    current = harness();
    const h = current;
    const opened = await exploring(h);
    const accepted = opened.learner.getProjection();
    h.workers.hostility = 'crash';
    expect(codesOf(await opened.learner.navigate({ operationId: op(), ...guards(opened.learner), position: { kind: 'index', index: 4 } }))).toEqual(['WORKER_ERROR']);
    const failed = opened.learner.getProjection();
    expect(failed.status).toMatchObject({ ui: 'recoverable-failure', recovery: { action: 'retry' } });
    // The last accepted frame stays shown, never presented as recomputed.
    expect(failed.frame).toMatchObject({ frameId: accepted.frame!.frameId, kind: 'committed', position: { index: 2 } });
    const createdBefore = h.workers.workers.length;
    const mark = h.host.events().length;
    h.workers.hostility = 'none';
    const recovered = okOf(await opened.learner.retryPersistence({ operationId: op('retry') }));
    await settled(h);
    expect(recovered.status.ui).not.toBe('recoverable-failure');
    expect(recovered.status.ui).toBe('paused');
    expect(recovered.frame).toMatchObject({ kind: 'committed', position: { index: 4 } });
    expect(recovered.frame!.frameId).not.toBe(accepted.frame!.frameId);
    expect(recovered.guards.expectedRunId).toBe(accepted.guards.expectedRunId);
    // One re-issued operation, journaled as the learner's step to the requested index; at most one new worker.
    const moves = ofType(h.host.events().slice(mark), 'position.changed');
    expect(moves).toEqual([expect.objectContaining({ from: expect.objectContaining({ index: 2 }), to: expect.objectContaining({ index: 4 }), cause: 'navigate' })]);
    expect(h.workers.workers.length - createdBefore).toBeLessThanOrEqual(1);
    expect(h.workers.live).toBeLessThanOrEqual(1);
  });

  it('a failed commit is re-issued with its cause and provenance; a failed scenario recovers as that scenario', async () => {
    current = harness();
    const h = current;
    const opened = await exploring(h);
    const run = opened.learner.getProjection().guards.expectedRunId;
    h.workers.hostility = 'crash';
    expect(codesOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { eta: 0.5 } }))).toEqual(['WORKER_ERROR']);
    expect(opened.learner.getProjection().guards.expectedRunId).toBe(run);
    h.workers.hostility = 'none';
    const mark = h.host.events().length;
    const recovered = okOf(await opened.learner.retryPersistence({ operationId: op('retry') }));
    await settled(h);
    expect(recovered.status.ui).toBe('ready');
    expect(recovered.guards.expectedRunId).not.toBe(run);
    expect(recovered.controls.find(control => control.parameter === 'eta')!.value).toBe(0.5);
    expect(recovered.frame).toMatchObject({ kind: 'committed', position: { index: 0 } });
    expect(ofType(h.host.events().slice(mark), 'parameters.committed')).toEqual([expect.objectContaining({ cause: 'commit', gesture: 'exact', previousRunId: run })]);

    const scenario = recovered.scenarios[0]!;
    h.workers.hostility = 'crash';
    expect(codesOf(await opened.learner.applyScenario({ operationId: op(), ...guards(opened.learner), scenarioId: scenario.scenarioId }))).toEqual(['WORKER_ERROR']);
    expect(opened.learner.getProjection().scenarios.some(item => item.active)).toBe(false);
    h.workers.hostility = 'none';
    const after = h.host.events().length;
    const applied = okOf(await opened.learner.retryPersistence({ operationId: op('retry') }));
    await settled(h);
    expect(applied.scenarios.find(item => item.scenarioId === scenario.scenarioId)?.active).toBe(true);
    expect(ofType(h.host.events().slice(after), 'parameters.committed')).toEqual([expect.objectContaining({ cause: 'scenario', scenarioId: scenario.scenarioId })]);
  });

  it('recovery is bounded: after the attempts are used up the last frame stays, reload is offered and no worker is created', async () => {
    current = harness();
    const h = current;
    const opened = await exploring(h);
    const accepted = opened.learner.getProjection();
    h.workers.hostility = 'crash';
    expect(codesOf(await opened.learner.step({ operationId: op(), ...guards(opened.learner), delta: 1 }))).toEqual(['WORKER_ERROR']);
    for (let attempt = 1; attempt <= WORKER_RECOVERY_ATTEMPTS; attempt++) {
      expect(codesOf(await opened.learner.retryPersistence({ operationId: op('retry') }))).toEqual(['WORKER_ERROR']);
      const status = opened.learner.getProjection().status;
      expect(status.ui).toBe('recoverable-failure');
      expect(status.recovery?.action).toBe(attempt < WORKER_RECOVERY_ATTEMPTS ? 'retry' : 'reload');
    }
    const exhausted = opened.learner.getProjection();
    expect(exhausted.status.message).toContain('Trying again did not restore the calculation.');
    expect(exhausted.frame).toMatchObject({ frameId: accepted.frame!.frameId, position: { index: 2 } });
    const created = h.workers.workers.length;
    expect(created).toBeLessThanOrEqual(2 + WORKER_RECOVERY_ATTEMPTS);
    h.workers.hostility = 'none';
    expect(codesOf(await opened.learner.retryPersistence({ operationId: op('retry') }))).toEqual(['WORKER_ERROR']);
    expect(h.workers.workers.length).toBe(created);
    expect(h.workers.live).toBeLessThanOrEqual(1);
    // A later successful evaluation (an explicit navigation) ends the episode.
    okOf(await opened.learner.navigate({ operationId: op(), ...guards(opened.learner), position: { kind: 'index', index: 3 } }));
    expect(opened.learner.getProjection().status).toMatchObject({ ui: 'paused', recovery: null });
  });

  it('a failed playback tick recovers by re-evaluating the shown position', async () => {
    current = harness();
    const h = current;
    const opened = await exploring(h);
    h.workers.hostility = 'crash';
    okOf(opened.learner.play({ operationId: op(), ...guards(opened.learner) }));
    await new Promise(resolve => setTimeout(resolve, 900));
    const failed = opened.learner.getProjection();
    expect(failed.status.ui).toBe('recoverable-failure');
    const position = failed.frame!.position;
    h.workers.hostility = 'none';
    const received = h.workers.received;
    const recovered = okOf(await opened.learner.retryPersistence({ operationId: op('retry') }));
    expect(recovered.status.ui).not.toBe('recoverable-failure');
    expect(recovered.navigation?.playing).toBe(false);
    // The shown position was evaluated again by a working worker (frame IDs are content-derived, so the ID is stable).
    expect(h.workers.received).toBeGreaterThan(received);
    expect(recovered.frame).toMatchObject({ kind: 'committed', position, frameId: failed.frame!.frameId });
  });

  it('a re-issue the stage no longer permits re-evaluates the shown position instead (no policy bypass)', async () => {
    current = harness();
    const h = current;
    const opened = await exploring(h);
    const before = opened.learner.getProjection();
    h.workers.hostility = 'crash';
    expect(codesOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { eta: 0.5 } }))).toEqual(['WORKER_ERROR']);
    h.workers.hostility = 'none';
    // The host moves on to the explanation stage, where every control is fixed.
    okOf(await opened.control.requestStageTransition({ operationId: op('stage'), ...activityGuard(opened.learner), toStage: 'explain' }));
    await settled(h);
    ackCurrent(opened.learner);
    await settled(h);
    const mark = h.host.events().length;
    const recovered = okOf(await opened.learner.retryPersistence({ operationId: op('retry') }));
    await settled(h);
    expect(recovered.status.ui).not.toBe('recoverable-failure');
    expect(recovered.guards.expectedRunId).toBe(before.guards.expectedRunId);
    expect(recovered.controls.find(control => control.parameter === 'eta')!.value).toBe(before.controls.find(control => control.parameter === 'eta')!.value);
    const events = h.host.events().slice(mark);
    expect(ofType(events, 'parameters.committed')).toEqual([]);
    expect(ofType(events, 'position.changed')).toEqual([expect.objectContaining({ from: expect.objectContaining({ index: 2 }), to: expect.objectContaining({ index: 2 }) })]);
  });
});

describe('disposal notifies a still-mounted surface once (G39)', () => {
  it('listeners hear the disposed projection exactly once, then nothing', async () => {
    current = harness();
    const h = current;
    const opened = await exploring(h);
    const heard: { ui: string; views: number; controls: number; frame: unknown }[] = [];
    opened.learner.subscribe(projection => heard.push({ ui: projection.status.ui, views: projection.views.length, controls: projection.controls.length, frame: projection.frame }));
    h.adapter.dispose('act-quadratic-1');
    expect(heard).toEqual([{ ui: 'disposed', views: 0, controls: 0, frame: null }]);
    h.adapter.dispose('act-quadratic-1');
    expect(codesOf(await opened.learner.navigate({ operationId: op(), ...guards(opened.learner), position: { kind: 'index', index: 3 } }))).toEqual(['DISPOSED']);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(heard).toHaveLength(1);
    expect(opened.learner.subscribe(() => heard.push({ ui: 'late', views: 0, controls: 0, frame: null }))()).toBeUndefined();
  });
});
