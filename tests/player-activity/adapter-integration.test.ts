/**
 * Surface-side helpers against the real adapter, catalogue and quadratic kernel (in-process test workers via the
 * activity test harness). Fixture-host results only; browser rendering is covered separately.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import type { ProjectedView } from '../../packages/activity/src/api';
import { StudyActivitySurface } from '../../packages/player/src/activity/index';
import { captureRejection, companionText } from '../../packages/player/src/activity/capture';
import { selectCaptureView } from '../../packages/player/src/activity/capture-renderer';
import { planScene } from '../../packages/player/src/activity/plan';
import { PreviewGesture } from '../../packages/player/src/activity/runtime';
import { boundsOf, fitFrame } from '../../packages/player/src/activity/scale';
import { authorizeExploration, enterExplore, harness, open, policyFor, settled, type Harness } from '../activity/support/adapter-harness';

let current: Harness | null = null;
afterEach(() => { current?.adapter.dispose(); current = null; });
const planOf = (view: ProjectedView) => planScene(view, fitFrame(boundsOf(view.bounds), { x: 40, y: 10, width: 480, height: 300 }, view.equalAspect));

describe('learner surface with the real quadratic activity', () => {
  it('plans and renders the predict and explore projections without hidden content', async () => {
    // Capture is authorized by this host policy (export.capture); captureRejection enforces it (G10).
    current = harness({ policy: policyFor({ export: { learnerSnapshot: true, capture: true, backup: true } }) });
    const opened = await open(current);
    const predict = opened.learner.getProjection();
    expect(predict.views.map(view => view.viewId)).not.toContain('trace-plot');
    const predictHtml = renderToString(createElement(StudyActivitySurface, { binding: opened.learner }));
    expect(predictHtml).toContain(predict.title);
    expect(predictHtml).not.toMatch(/Iterates \(x_k|Position x_n at each iteration/);

    const explore = await enterExplore(current, opened);
    const graphical = explore.views.filter(view => view.kind === 'plot2d' || view.kind === 'scene2d');
    expect(graphical.map(view => view.viewId)).toEqual(expect.arrayContaining(['landscape', 'trace-plot']));
    for (const view of graphical) {
      const plan = planOf(view);
      expect(plan.marks.some(mark => mark.primitives.length > 0), view.viewId).toBe(true);
      expect(plan.notes.filter(note => note.kind === 'unsupported')).toEqual([]);
    }
    const html = renderToString(createElement(StudyActivitySurface, { binding: opened.learner }));
    expect(html).toContain('n = 0 of 1000');
    expect(captureRejection(opened.learner.getProjection())).toBeNull();
    expect(companionText(explore, selectCaptureView(explore, 'trace-plot'))).toContain('Position by iteration');
  });

  it('runs a pointer preview gesture through the real binding and commits a new run', async () => {
    current = harness();
    const opened = await open(current);
    await enterExplore(current, opened);
    await authorizeExploration(current, opened);
    const before = opened.learner.getProjection();
    const failures: string[] = [];
    const gesture = new PreviewGesture(opened.learner, 'eta', { onFailure: d => failures.push(...d.map(x => `${x.code}: ${x.message}`)), isDisposed: () => false });
    gesture.begin('pointer');
    expect(gesture.state).toBe('previewing');
    gesture.update(0.75);
    await settled(current);
    const outcome = await gesture.commit({ eta: before.controls.find(control => control.parameter === 'eta')!.value });
    await settled(current);
    expect(failures).toEqual([]);
    expect(outcome?.ok).toBe(true);
    const after = opened.learner.getProjection();
    expect(after.preview).toBeNull();
    expect(after.controls.find(control => control.parameter === 'eta')!.value).toBe(0.75);
    expect(after.guards.expectedRunId).not.toBe(before.guards.expectedRunId);
    expect(after.frame?.kind).toBe('committed');
  });

  it('falls back to a single exact commit when the stage has no exploration grant', async () => {
    current = harness();
    const opened = await open(current);
    await enterExplore(current, opened);
    const gesture = new PreviewGesture(opened.learner, 'eta', { onFailure: () => undefined, isDisposed: () => false });
    gesture.begin('keyboard');
    // Without an exploration scope the adapter refuses the preview; the gesture becomes a local draft.
    expect(gesture.state).toBe('draft');
    expect(opened.learner.getProjection().preview).toBeNull();
    gesture.update(0.5);
    const outcome = await gesture.commit({ eta: opened.learner.getProjection().controls.find(control => control.parameter === 'eta')!.value });
    await settled(current);
    expect(outcome?.ok).toBe(true);
    expect(opened.learner.getProjection().controls.find(control => control.parameter === 'eta')!.value).toBe(0.5);
  });
});
