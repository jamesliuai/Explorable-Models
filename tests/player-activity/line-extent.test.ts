/**
 * Unbounded lines (`MarkSpec.extent: 'line'`, report §10.2, A34): a segment mark that depicts a line (tangent, secant,
 * invariant direction) is extended to the view and clipped silently; its endpoints are not data, so it never raises the
 * "values outside the view" indicator or the projection's `clipped` state, while genuinely out-of-view data (points,
 * traces, curves, transformed grids) is still reported. Real adapter, catalogue and kernels with in-process test
 * workers and the test-only memory host (fixture-host results; no browser rendering here).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ActivityTemplate, LearnerProjection, ProjectedMark, ProjectedView } from '../../packages/activity/src/index';
import { validateTemplateSemantics } from '../../packages/activity/src/index';
import { createInstalledCatalog, functionDerivativeTemplate, linearTransformationTemplate } from '../../packages/catalog/src/index';
import { planScene, type ScenePlan } from '../../packages/player/src/activity/plan';
import { boundsOf, clipLine, fitFrame } from '../../packages/player/src/activity/scale';
import { activityGuard, ackCurrent, harness, okOf, op, open, policyFor, settled, type Harness } from '../activity/support/adapter-harness';

let current: Harness | null = null;
afterEach(() => { current?.adapter.dispose(); current = null; });

const STYLE: ProjectedMark['style'] = { role: 'primary', dash: 'solid', marker: 'none', weight: 'regular' };
const segments = (markId: string, from: [number, number], to: [number, number], extent?: ProjectedMark['extent']): ProjectedMark => ({
  markId, kind: 'segments', label: markId, style: STYLE, interactive: false, ...(extent ? { extent } : {}),
  geometry: { kind: 'segments2', segments: [{ id: 's', from, to }] },
});
const view = (marks: ProjectedMark[]): Pick<ProjectedView, 'marks'> => ({ marks });
const frame = () => fitFrame([-6, 6, -6, 6], { x: 0, y: 0, width: 300, height: 300 }, true);
/** Plans a projected view in a square plot, so an equal-aspect view shows exactly its authored bounds. */
const planOf = (projected: ProjectedView): ScenePlan => planScene(projected, fitFrame(boundsOf(projected.bounds), { x: 40, y: 10, width: 320, height: 320 }, projected.equalAspect));

describe('line marks in the 2D plan', () => {
  it('extend across the view, clip silently and stay out of the data extent; bounded marks with the same data are reported', () => {
    const line = planScene(view([segments('line', [-9, -9], [9, 9], 'line')]), frame());
    expect(line.clipped).toEqual([]);
    expect(line.extent).toBeNull();
    const [path] = line.marks[0]!.primitives;
    expect(path?.shape).toMatchObject({ type: 'path', fill: false });
    // A short piece of the line is drawn to the edges of the view, not only between its endpoints.
    const short = planScene(view([segments('line', [0, 0], [1, 1], 'line')]), frame());
    const bounded = planScene(view([segments('segment', [0, 0], [1, 1])]), frame());
    const length = (plan: ScenePlan) => { const d = (plan.marks[0]!.primitives[0]!.shape as { d: string }).d; const [x1, y1, x2, y2] = d.match(/-?\d+(\.\d+)?/g)!.map(Number); return Math.hypot(x2! - x1!, y2! - y1!); };
    expect(length(short)).toBeGreaterThan(10 * length(bounded));
    // The drawn path ends at the edges of the plot, never beyond it (bounding boxes ignore clip paths).
    const ends = ((short.marks[0]!.primitives[0]!.shape as { d: string }).d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
    const { plot } = frame();
    for (let i = 0; i < ends.length; i += 2) {
      expect(ends[i]!).toBeGreaterThanOrEqual(plot.x - 0.1); expect(ends[i]!).toBeLessThanOrEqual(plot.x + plot.width + 0.1);
      expect(ends[i + 1]!).toBeGreaterThanOrEqual(plot.y - 0.1); expect(ends[i + 1]!).toBeLessThanOrEqual(plot.y + plot.height + 0.1);
    }
    const reported = planScene(view([segments('segment', [-9, -9], [9, 9])]), frame());
    expect(reported.clipped).toEqual([{ markId: 'segment', label: 'segment', count: 2 }]);
  });

  it('still reports out-of-view points next to a line mark, and never draws a line through two equal points', () => {
    const point: ProjectedMark = { markId: 'far', kind: 'point', label: 'Far point', style: { ...STYLE, marker: 'circle' }, interactive: false, at: [8, 0] };
    const plan = planScene(view([segments('line', [-9, 0], [9, 0], 'line'), point]), frame());
    expect(plan.clipped).toEqual([{ markId: 'far', label: 'Far point', count: 1 }]);
    const degenerate = planScene(view([segments('line', [1, 1], [1, 1], 'line')]), frame());
    expect(degenerate.marks[0]!.primitives.map(primitive => primitive.shape.type)).toEqual(['marker']);
    expect(clipLine([1, 1], [1, 1], [-1, 1, -1, 1])).toBeNull();
    expect(clipLine([0, 0], [1, 0], [-2, 2, -1, 1])).toEqual([[-2, 0], [2, 0]]);
    expect(clipLine([0, 5], [1, 5], [-2, 2, -1, 1])).toBeNull();
    expect(clipLine([0, 0], [Number.MIN_VALUE, 0], [-2, 2, -1, 1])).toBeNull();
  });

  it('is accepted only on segment marks of 2D views', () => {
    const template = structuredClone(linearTransformationTemplate) as ActivityTemplate;
    const manifest = createInstalledCatalog().getModel(template.model)!;
    expect(validateTemplateSemantics(template, manifest)).toEqual([]);
    const misuse = template.views[0]!.marks.find(mark => mark.id === 'test-vector')!;
    misuse.extent = 'line';
    expect(validateTemplateSemantics(template, manifest).map(item => `${item.code} ${item.path}`)).toEqual(['KIND_MISMATCH $.views[0].marks[9].extent']);
  });
});

/** Opens `template` at `free-explore` with every group revealed and acknowledged, at the given scenario. */
async function freeExplore(template: ActivityTemplate, start: { scenarioId?: string; parameters?: Record<string, number> }): Promise<LearnerProjection> {
  const entry = createInstalledCatalog().listTemplates().find(item => item.template.templateId === template.templateId)!;
  current = harness({ policy: policyFor({
    policyId: 'policy-lines', approved: [{ template: entry.template, model: entry.model }], visibleGroups: template.groups.map(group => group.id),
    permittedControls: template.controls.map(control => control.parameter),
  }) });
  const activityId = `act-lines-${template.templateId}`.slice(0, 64);
  const opened = await open(current, {
    activityId, objectiveIds: ['obj-1'], hostSessionId: 'session-1', hostSessionRevision: 0, template: { templateId: template.templateId, version: template.version },
    mode: 'approved', stageId: 'free-explore', ...start,
  });
  await settled(current, activityId);
  const solution = template.groups.filter(group => group.solutionBearing && template.stages.find(stage => stage.id === 'free-explore')!.visible[group.id]).map(group => group.id);
  okOf(await opened.control.requestReveal({ operationId: op('reveal'), ...activityGuard(opened.learner), groups: solution }));
  await settled(current, activityId);
  ackCurrent(opened.learner);
  await settled(current, activityId);
  return opened.learner.getProjection();
}

describe('installed templates', () => {
  it('linear transformation: unchanged-direction lines clip silently, a transformed grid beyond the view is still reported', async () => {
    const identityLike = await freeExplore(linearTransformationTemplate, { scenarioId: 'reflection-x-axis' });
    const plane = identityLike.views.find(item => item.viewId === 'plane')!;
    expect(plane.marks.find(mark => mark.markId === 'eigen-direction-lines')).toMatchObject({ extent: 'line', geometry: { kind: 'segments2' } });
    // The reflection keeps the grid inside the view; only the ±9 invariant lines leave it, and that is not out-of-view data.
    expect(identityLike.status.ui).not.toBe('clipped');
    expect(planOf(plane).clipped).toEqual([]);
    current?.adapter.dispose(); current = null;
    // A stretch by 3 along x: two real unchanged directions (the axes) and grid images out to x = ±9, beyond the ±8 view.
    const stretched = await freeExplore(linearTransformationTemplate, { parameters: { m11: 3, m12: 0, m21: 0, m22: 1 } });
    expect(stretched.status.ui).toBe('clipped');
    const stretchedClipped = planOf(stretched.views.find(item => item.viewId === 'plane')!).clipped.map(item => item.markId);
    expect(stretchedClipped).toContain('transformed-grid');
    expect(stretchedClipped).not.toContain('eigen-direction-lines');
  });

  it('function and derivative: a steep tangent and secant clip silently, the curve leaving the view is still reported', async () => {
    // f(x) = x²/2 − x − 2 with P at x = −2: f(−5) = 15.5 lies above the view, and so do both lines (slope −3 at P).
    const projection = await freeExplore(functionDerivativeTemplate, { scenarioId: 'curve-up' });
    const graph = projection.views.find(item => item.viewId === 'function-plot')!;
    expect(graph.marks.filter(mark => mark.extent === 'line').map(mark => mark.markId).sort()).toEqual(['secant-line', 'tangent-line']);
    expect(projection.status.ui).toBe('clipped');
    expect(planOf(graph).clipped.map(item => item.markId)).toEqual(['function-curve']);
  });
});
