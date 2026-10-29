/**
 * Preview gestures against the real adapter, catalogue and quadratic kernel (in-process test workers; report §9,
 * A39–A41; gaps G24 and Phase 4a F4). Fixture-host results only; the rendered surface is covered by the browser specs.
 *
 * - A gesture whose preview the host ends (stage transition, revoked policy, suspension) commits nothing on release.
 * - Pointer, keyboard and drag gestures never record `gesture: 'exact'`, with or without an authorized preview.
 * - A gesture pressed while the previous release is still committing waits for that commit, then previews from the
 *   new committed state and commits exactly once with its own provenance (`GestureLane`).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { InteractionEvent } from '../../packages/activity/src/contracts';
import { GestureLane, PreviewGesture } from '../../packages/player/src/activity/runtime';
import { activityGuard, authorizeExploration, enterExplore, harness, okOf, op, open, settled, type Harness } from '../activity/support/adapter-harness';

let current: Harness | null = null;
afterEach(() => { current?.adapter.dispose(); current = null; });

const since = (events: InteractionEvent[], from: number) => events.slice(from);
const payloads = (events: InteractionEvent[], type: string) => events.filter(event => event.type === type).map(event => event.payload as Record<string, unknown>);
const hooks = (failures: string[], lane?: GestureLane) => ({ onFailure: (d: { code: string }[]) => failures.push(...d.map(x => x.code)), isDisposed: () => false, ...(lane ? { lane } : {}) });

async function explore(h: Harness) {
  const opened = await open(h);
  await enterExplore(h, opened);
  await authorizeExploration(h, opened);
  await settled(h);
  return opened;
}

describe('a gesture whose preview the host ends commits nothing (G24, A40)', () => {
  it('stage transition mid-drag: preview.cancelled navigation, no parameters.committed, same run', async () => {
    current = harness();
    const h = current;
    const opened = await explore(h);
    const failures: string[] = [];
    const run = opened.learner.getProjection().guards.expectedRunId;
    const mark = h.host.events().length;
    const gesture = new PreviewGesture(opened.learner, 'eta', hooks(failures));
    gesture.begin('pointer');
    gesture.update(0.6);
    expect(gesture.state).toBe('previewing');
    okOf(await opened.control.requestStageTransition({ operationId: op('stage'), ...activityGuard(opened.learner), toStage: 'explore-curvature' }));
    // The pointer is still down and keeps moving: nothing is sent for the ended gesture, and release commits nothing.
    gesture.update(0.8);
    expect(gesture.state).toBe('ended');
    expect(gesture.active).toBe(true);
    const outcome = await gesture.commit({ eta: 0.25 });
    await settled(h);
    expect(outcome).toBeNull();
    expect(gesture.active).toBe(false);
    const events = since(h.host.events(), mark);
    expect(payloads(events, 'preview.cancelled').map(p => p.reason)).toEqual(['navigation']);
    expect(payloads(events, 'parameters.committed')).toEqual([]);
    expect(opened.learner.getProjection().guards.expectedRunId).toBe(run);
    expect(failures).toEqual([]);
  });

  it('sync() ends a held gesture as soon as the projection shows its preview gone (policy revoked)', async () => {
    current = harness();
    const h = current;
    const opened = await explore(h);
    const mark = h.host.events().length;
    const gesture = new PreviewGesture(opened.learner, 'eta', hooks([]));
    gesture.begin('drag');
    gesture.update(0.9);
    okOf(await opened.control.updatePolicy({ operationId: op('policy'), policy: { ...h.host.policy(), revision: 2, revoked: true } }));
    expect(gesture.sync(opened.learner.getProjection())).toBe(true);
    expect(gesture.state).toBe('ended');
    expect(await gesture.commit({ eta: 0.25 })).toBeNull();
    await settled(h);
    const events = since(h.host.events(), mark);
    expect(payloads(events, 'preview.cancelled').map(p => p.reason)).toEqual(['revoked']);
    expect(payloads(events, 'parameters.committed')).toEqual([]);
  });

  it('a draft (no authorized preview) ends when the stage changes under it, and when the card becomes inert', async () => {
    current = harness();
    const h = current;
    const opened = await open(h);
    await enterExplore(h, opened);
    const mark = h.host.events().length;
    // No exploration scope: the gesture is a local draft.
    const gesture = new PreviewGesture(opened.learner, 'eta', hooks([]));
    gesture.begin('pointer');
    expect(gesture.state).toBe('draft');
    gesture.update(0.9);
    okOf(await opened.control.requestStageTransition({ operationId: op('stage'), ...activityGuard(opened.learner), toStage: 'explore-curvature' }));
    expect(await gesture.commit({ eta: 0.25 })).toBeNull();
    await settled(h);
    expect(payloads(since(h.host.events(), mark), 'parameters.committed')).toEqual([]);

    const held = new PreviewGesture(opened.learner, 'eta', hooks([]));
    held.begin('keyboard');
    held.update(1.1);
    okOf(opened.control.suspend({ operationId: op('suspend'), reason: 'host' }));
    expect(opened.learner.getProjection().status.ui).toBe('suspended');
    expect(held.sync(opened.learner.getProjection())).toBe(true);
    expect(await held.commit({ eta: 0.25 })).toBeNull();
    await settled(h);
    expect(payloads(since(h.host.events(), mark), 'parameters.committed')).toEqual([]);
  });
});

describe('gesture provenance (G24: never `exact` for a pointer, keyboard or drag gesture)', () => {
  it('a draft commits its values under its own gesture kind; exact entry stays exact', async () => {
    current = harness();
    const h = current;
    const opened = await open(h);
    await enterExplore(h, opened);
    const mark = h.host.events().length;
    for (const [kind, value] of [['pointer', 0.4], ['keyboard', 0.45], ['drag', 0.5]] as const) {
      const gesture = new PreviewGesture(opened.learner, 'eta', hooks([]));
      gesture.begin(kind);
      expect(gesture.state).toBe('draft');
      gesture.update(value);
      expect((await gesture.commit({ eta: opened.learner.getProjection().controls.find(c => c.parameter === 'eta')!.value }))?.ok).toBe(true);
      await settled(h);
    }
    okOf(await opened.learner.commitParameters({ operationId: op('exact'), ...opened.learner.getProjection().guards, displayValues: { eta: 0.55 } }));
    await settled(h);
    const commits = payloads(since(h.host.events(), mark), 'parameters.committed');
    expect(commits.map(p => [p.gesture, (p.params as Record<string, number>).eta])).toEqual([['pointer', 0.4], ['keyboard', 0.45], ['drag', 0.5], ['exact', 0.55]]);
    expect(commits.every(p => p.previewId === undefined)).toBe(true);
    // An unknown provenance is refused, not recorded.
    const bad = await opened.learner.commitParameters({ operationId: op('bad'), ...opened.learner.getProjection().guards, displayValues: { eta: 0.6 }, gesture: 'telepathy' as never });
    expect(bad.ok).toBe(false);
  });
});

describe('pressing again while the previous release commits (Phase 4a F4, GestureLane)', () => {
  it('the second gesture waits, previews from the new run and commits exactly once as a pointer gesture', async () => {
    current = harness();
    const h = current;
    const opened = await explore(h);
    const lane = new GestureLane();
    const failures: string[] = [];
    const mark = h.host.events().length;
    const first = new PreviewGesture(opened.learner, 'eta', hooks(failures, lane));
    first.begin('pointer');
    first.update(0.6);
    await settled(h);
    // A slow evaluator: the commit of the first release is still in flight when the pointer goes down again.
    h.workers.hold = true;
    const firstCommit = first.commit({ eta: 0.25 });
    expect(lane.busy).toBe(true);
    const second = new PreviewGesture(opened.learner, 'eta', hooks(failures, lane));
    second.begin('pointer');
    expect(second.state).toBe('waiting');
    second.update(0.9);
    second.update(1.1);
    expect(second.values).toEqual({ eta: 1.1 });
    // Released before the first commit settled: the completion waits for the preview to start.
    const secondCommit = second.commit({ eta: 0.25 });
    expect(payloads(since(h.host.events(), mark), 'preview.started')).toHaveLength(1);
    h.workers.hold = false;
    h.workers.flush();
    expect((await firstCommit)?.ok).toBe(true);
    await settled(h);
    h.workers.flush();
    const outcome = await secondCommit;
    await settled(h);
    expect(outcome?.ok).toBe(true);
    expect(failures).toEqual([]);
    const events = since(h.host.events(), mark);
    const started = payloads(events, 'preview.started');
    const commits = payloads(events, 'parameters.committed');
    expect(started).toHaveLength(2);
    expect(commits.map(p => [p.gesture, (p.params as Record<string, number>).eta, p.previewId])).toEqual([['pointer', 0.6, started[0]!.previewId], ['pointer', 1.1, started[1]!.previewId]]);
    // The second preview started from the run the first commit produced.
    expect(started[1]!.baseRunId).toBe(commits[0]!.runId);
    expect(payloads(events, 'preview.cancelled')).toEqual([]);
    expect(lane.busy).toBe(false);
  });

  it('a waiting gesture that is cancelled never starts a preview', async () => {
    current = harness();
    const h = current;
    const opened = await explore(h);
    const lane = new GestureLane();
    const mark = h.host.events().length;
    const first = new PreviewGesture(opened.learner, 'eta', hooks([], lane));
    first.begin('pointer');
    first.update(0.7);
    h.workers.hold = true;
    const pending = first.commit({ eta: 0.25 });
    const second = new PreviewGesture(opened.learner, 'eta', hooks([], lane));
    second.begin('pointer');
    second.update(1.2);
    second.cancel('escape');
    expect(second.active).toBe(false);
    h.workers.hold = false;
    h.workers.flush();
    await pending;
    await settled(h);
    const events = since(h.host.events(), mark);
    expect(payloads(events, 'preview.started')).toHaveLength(1);
    expect(payloads(events, 'parameters.committed')).toHaveLength(1);
  });
});
