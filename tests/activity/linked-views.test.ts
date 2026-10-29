/**
 * Linked views of every bundled activity (report §10.2 "linked selection/probing, coordinated current-point markers …
 * where the activity needs them", §12, A46). Each activity's probe is a model parameter or the navigation index, so a
 * change made in any view or control commits one run and every linked marker is drawn from the same identified frame:
 * there is no separate selection state that could disagree with the scientific state. These tests check, from single
 * published projections, that the linked markers agree with each other and with independently computed analytic values
 * after a committed change (and, for the function and derivative activity, during a tentative preview).
 *
 * Fixture-host results with in-process kernel workers (test-only memory host); they say nothing about a Study Harness
 * host, about rendering or about learning.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ActivityTemplate, HostPolicy, LearnerProjection, ProjectedMark } from '@explorable-models/activity';
import { createInstalledCatalog, INSTALLED_TEMPLATES } from '@explorable-models/catalog';
import { ackCurrent, activityGuard, guards, harness, okOf, op, open, policyFor, settled, until, type Harness, type Opened } from './support/adapter-harness.js';

const disposers: (() => void)[] = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); });

const close = (actual: number, expected: number, what: string) => expect(Math.abs(actual - expected), `${what}: ${actual} vs ${expected}`).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(expected)));
const closeAll = (actual: readonly number[] | null | undefined, expected: readonly number[], what: string) => {
  expect(actual, what).toHaveLength(expected.length);
  expected.forEach((value, i) => close(actual![i]!, value, `${what}[${i}]`));
};

/** Opens `templateId` in free-explore under a policy that permits every group, with its solution-bearing groups revealed. */
async function freeExplore(templateId: string): Promise<{ h: Harness; opened: Opened; template: ActivityTemplate; activityId: string }> {
  const template = INSTALLED_TEMPLATES.find(item => item.templateId === templateId)!;
  const entry = createInstalledCatalog().listTemplates().find(item => item.template.templateId === templateId)!;
  const policy: HostPolicy = policyFor({ policyId: `policy-${templateId}`.slice(0, 64), approved: [{ template: entry.template, model: entry.model }], visibleGroups: template.groups.map(group => group.id), permittedControls: template.controls.map(control => control.parameter) });
  const h = harness({ policy });
  disposers.push(() => h.adapter.dispose());
  const activityId = `act-${templateId}`.slice(0, 64);
  const opened = await open(h, { activityId, objectiveIds: ['obj-1'], hostSessionId: 'session-1', hostSessionRevision: 0, template: { templateId, version: template.version }, mode: 'approved', stageId: 'free-explore' });
  await settled(h, activityId);
  const stage = template.stages.find(item => item.id === 'free-explore')!;
  const groups = template.groups.filter(group => group.solutionBearing && stage.visible[group.id]).map(group => group.id);
  if (groups.length) okOf(await opened.control.requestReveal({ operationId: op(), ...activityGuard(opened.learner), groups }));
  await settled(h, activityId);
  ackCurrent(opened.learner);
  await settled(h, activityId);
  return { h, opened, template, activityId };
}
async function commit(run: { h: Harness; opened: Opened; activityId: string }, displayValues: Record<string, number>): Promise<LearnerProjection> {
  okOf(await run.opened.learner.commitParameters({ operationId: op(), ...guards(run.opened.learner), displayValues }));
  await settled(run.h, run.activityId);
  ackCurrent(run.opened.learner);
  await settled(run.h, run.activityId);
  return run.opened.learner.getProjection();
}
const mark = (projection: LearnerProjection, viewId: string, markId: string): ProjectedMark => {
  const found = projection.views.find(view => view.viewId === viewId)?.marks.find(item => item.markId === markId);
  if (!found) throw new Error(`${viewId}/${markId} is not projected`);
  return found;
};
const value = (projection: LearnerProjection, quantityId: string): string => projection.views.flatMap(view => view.values).find(item => item.quantityId === quantityId)!.text;
const points = (item: ProjectedMark) => (item.geometry as { kind: string; points: { id: string; at: number[] }[] }).points;
const segments = (item: ProjectedMark) => (item.geometry as { kind: string; segments: { id: string; from: number[]; to: number[] }[] }).segments;
const polylineAt = (item: ProjectedMark, x: number, axis = 0): number => {
  const all = (item.geometry as { segments: { points: number[][] }[] }).segments.flatMap(segment => segment.points);
  const found = all.find(point => Math.abs(point[axis]! - x) < 1e-12);
  if (!found) throw new Error(`no sample at ${x}`);
  return found[1]!;
};

describe('linked views from one committed frame (report §10.2, §12, A46; S7)', () => {
  it('every bundled activity is covered here', () => {
    expect(INSTALLED_TEMPLATES.map(template => template.templateId).sort()).toEqual(['function-derivative', 'linear-transformation', 'quadratic-gradient-descent', 'quadratic-surface-gradient', 'vector-orientation-3d']);
  });

  it('quadratic gradient descent: the current-iterate marker on the landscape, the last point of the trace, the values and the navigation are one iteration', async () => {
    const run = await freeExplore('quadratic-gradient-descent');
    const { opened } = run;
    const check = (projection: LearnerProjection, n: number, x: number, a: number) => {
      expect(projection.navigation?.value).toBe(n);
      closeAll(mark(projection, 'landscape', 'current-iterate').at, [x, a * x * x / 2], 'landscape current iterate (x_n, f(x_n))');
      const trace = points(mark(projection, 'trace-plot', 'trace-points'));
      expect(trace).toHaveLength(n + 1);
      closeAll(trace.at(-1)!.at, [n, x], 'trace plot last point (n, x_n)');
      expect(points(mark(projection, 'landscape', 'iterate-points')).map(point => point.at[0])).toEqual(trace.map(point => point.at[1]));
      expect(value(projection, 'index')).toBe(String(n));
      close(Number(value(projection, 'position')), x, 'values: position');
    };
    // a = 2, η = 0.25, x₀ = 4: 4, 2, 1, 0.5 (report §12.3).
    okOf(await opened.learner.navigate({ operationId: op(), ...guards(opened.learner), position: { kind: 'index', index: 3 } }));
    await settled(run.h, run.activityId);
    check(opened.learner.getProjection(), 3, 0.5, 2);
    // A committed step size restarts the run at n = 0 and moves every linked marker together: 4, −2, 1 (η = 0.75).
    const restarted = await commit(run, { eta: 0.75 });
    check(restarted, 0, 4, 2);
    okOf(await opened.learner.navigate({ operationId: op(), ...guards(opened.learner), position: { kind: 'index', index: 2 } }));
    await settled(run.h, run.activityId);
    check(opened.learner.getProjection(), 2, 1, 2);
  });

  it('function and derivative: P on f, its tangent, P on f′ and the slope read-outs follow one probe p, also during a tentative preview', async () => {
    const run = await freeExplore('function-derivative');
    const { opened } = run;
    const A = 0.25, B = -0.5, C = -2;
    const f = (x: number) => A * x * x + B * x + C, slope = (x: number) => 2 * A * x + B;
    const check = (projection: LearnerProjection, p: number, what: string) => {
      closeAll(mark(projection, 'function-plot', 'probe-marker').at, [p, f(p)], `${what}: P on f`);
      closeAll(mark(projection, 'derivative-plot', 'derivative-probe-marker').at, [p, slope(p)], `${what}: P on f′`);
      const [tangent] = segments(mark(projection, 'function-plot', 'tangent-line'));
      close((tangent!.to[1]! - tangent!.from[1]!) / (tangent!.to[0]! - tangent!.from[0]!), slope(p), `${what}: tangent slope`);
      close(tangent!.from[1]! + slope(p) * (p - tangent!.from[0]!), f(p), `${what}: tangent through P`);
    };
    const committed = await commit(run, { p: 1.5 });
    expect(committed.frame?.kind).toBe('committed');
    check(committed, 1.5, 'committed p = 1.5');
    expect(value(committed, 'probe.x')).toBe('1.5');
    close(Number(value(committed, 'derivative')), slope(1.5), 'values: f′(p)');
    // Linked probing during a gesture: one tentative frame moves every linked marker; cancelling restores the committed ones.
    const stage = run.template.stages.find(item => item.id === 'free-explore')!;
    const groups = ['probe-control', ...run.template.groups.filter(group => group.solutionBearing && stage.visible[group.id]).map(group => group.id)];
    okOf(await opened.control.requestExplorationScope({ operationId: op('scope'), ...activityGuard(opened.learner), groups, parameterDomain: { p: [-5, 5] } }));
    await settled(run.h, run.activityId);
    const previewId = okOf(opened.learner.beginPreview({ operationId: op(), ...guards(opened.learner), gesture: 'pointer', parameter: 'p' })).preview!.previewId;
    okOf(opened.learner.updatePreview({ operationId: op(), previewId, displayValues: { p: -2.5 } }));
    await until(() => opened.learner.getProjection().frame?.kind === 'tentative');
    check(opened.learner.getProjection(), -2.5, 'tentative p = −2.5');
    okOf(opened.learner.cancelPreview({ operationId: op(), previewId, reason: 'escape' }));
    await until(() => opened.learner.getProjection().frame?.kind === 'committed');
    check(opened.learner.getProjection(), 1.5, 'after cancel');
  });

  it('linear transformation: the test vector, its image and the images of the basis vectors agree (Mv = v_x·Me₁ + v_y·Me₂) with the values', async () => {
    const run = await freeExplore('linear-transformation');
    const projection = await commit(run, { vx: 2, vy: -1 });
    const M = [[1.5, 1], [0.5, 1]];
    closeAll(mark(projection, 'plane', 'test-vector').vector, [2, -1], 'v');
    closeAll(mark(projection, 'plane', 'image-e1').vector, [M[0]![0]!, M[1]![0]!], 'Me₁ (first column)');
    closeAll(mark(projection, 'plane', 'image-e2').vector, [M[0]![1]!, M[1]![1]!], 'Me₂ (second column)');
    const image = [M[0]![0]! * 2 + M[0]![1]! * -1, M[1]![0]! * 2 + M[1]![1]! * -1];
    closeAll(mark(projection, 'plane', 'image-vector').vector, image, 'Mv');
    expect(value(projection, 'image.v')).toBe('(2, 0)');
    expect(value(projection, 'vector.v')).toBe('(2, -1)');
  });

  it('vector orientation in 3D: each coordinate-plane view draws the components of the same u and v as the 3D view', async () => {
    const run = await freeExplore('vector-orientation-3d');
    const projection = await commit(run, { uz: 1 });
    const u = [2, 1, 1], v = [1, 2, 2];
    const space = segments(mark(projection, 'space', 'vector-segments'));
    closeAll(space.find(item => item.id === 'u')!.to, u, '3D u');
    closeAll(space.find(item => item.id === 'v')!.to, v, '3D v');
    for (const [viewId, markId, axes] of [['plane-xy', 'projection-xy-segments', [0, 1]], ['plane-xz', 'projection-xz-segments', [0, 2]], ['plane-yz', 'projection-yz-segments', [1, 2]]] as const) {
      const drawn = segments(mark(projection, viewId, markId));
      closeAll(drawn.find(item => item.id === 'u')!.to, axes.map(axis => u[axis]!), `${viewId} u`);
      closeAll(drawn.find(item => item.id === 'v')!.to, axes.map(axis => v[axis]!), `${viewId} v`);
    }
    // u × v (right-handed) = (1·2 − 1·2, 1·1 − 2·2, 2·2 − 1·1).
    closeAll(segments(mark(projection, 'space', 'cross-segment'))[0]!.to, [0, -3, 3], 'u × v');
  });

  it('quadratic surface: the selected point and its gradient agree between the 3D view and the contour view; the axis cross-sections do not follow the point', async () => {
    const run = await freeExplore('quadratic-surface-gradient');
    const projection = await commit(run, { px: -1, py: 0.5 });
    const a = 2, b = 0.5, c = 1;
    const f = (x: number, y: number) => a * x * x / 2 + b * x * y + c * y * y / 2;
    const gradient = [a * -1 + b * 0.5, b * -1 + c * 0.5];
    closeAll(mark(projection, 'surface-view', 'point-on-surface').at, [-1, 0.5, f(-1, 0.5)], 'point on the surface');
    closeAll(mark(projection, 'contour-plot', 'point-marker').at, [-1, 0.5], 'point on the contour view');
    const flat = segments(mark(projection, 'contour-plot', 'gradient-arrow'))[0]!, raised = segments(mark(projection, 'surface-view', 'gradient-arrow-3d'))[0]!;
    closeAll(flat.from, [-1, 0.5], 'contour gradient arrow tail');
    closeAll(raised.from, [-1, 0.5, f(-1, 0.5)], '3D gradient arrow tail');
    closeAll(raised.to.slice(0, 2), flat.to, '3D arrow over the contour arrow');
    const scale = Number(value(projection, 'arrow.scale'));
    closeAll(flat.to, [-1 + gradient[0]! * scale, 0.5 + gradient[1]! * scale], 'arrow = point + scale · ∇f');
    expect(value(projection, 'gradient')).toBe('(-1.75, 0)');
    // The cross-sections are the approved axis sections (the vertical planes y = 0 and x = 0, as their views say), not
    // probe-linked views: they follow the coefficients and never move with the selected point.
    close(polylineAt(mark(projection, 'section-x', 'section-x-curve'), -1), f(-1, 0), 'section y = 0 at x = −1');
    close(polylineAt(mark(projection, 'section-y', 'section-y-curve'), 0.5), f(0, 0.5), 'section x = 0 at y = 0.5');
    const moved = await commit(run, { px: 1.5, py: -1 });
    expect(mark(moved, 'section-x', 'section-x-curve').geometry).toEqual(mark(projection, 'section-x', 'section-x-curve').geometry);
    expect(mark(moved, 'section-y', 'section-y-curve').geometry).toEqual(mark(projection, 'section-y', 'section-y-curve').geometry);
    closeAll(mark(moved, 'contour-plot', 'point-marker').at, [1.5, -1], 'moved point on the contour view');
    closeAll(mark(moved, 'surface-view', 'point-on-surface').at, [1.5, -1, f(1.5, -1)], 'moved point on the surface');
  });
});
