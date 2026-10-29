/**
 * The spatial renderer's plan for the two installed spatial activities, from real learner projections (in-process
 * adapter, test workers and memory host; fixture results, no WebGL). A45: e_x × e_y = e_z is drawn along +z and
 * e_y × e_x along −z; parallel and antiparallel vectors have no cross-product arrow and an undefined direction with a
 * reason; orthogonal and zero-vector cases. A46: the 3D gradient arrow at p lies in the plane z = f(p) along the
 * analytic gradient (a·x + b·y, b·x + c·y), which is computed here independently of the kernel; the minimum has no
 * arrow; the surface is the sampled 41 × 41 grid with its sampling disclosed; camera changes never alter science.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ActivityBinding, ProjectedView } from '../../packages/activity/src/index';
import { createInstalledCatalog, INSTALLED_TEMPLATES } from '../../packages/catalog/src/index';
import { defaultOrbit, orbitToCamera, presetOrbit } from '../../packages/player-3d/src/camera';
import { viewFrame } from '../../packages/player-3d/src/frame';
import { coordinateTable } from '../../packages/player/src/activity/project3d';
import { planSpatialScene, type SpatialPlan } from '../../packages/player-3d/src/plan';
import { normalize, type Vec3 } from '../../packages/player-3d/src/vec';
import { ackCurrent, activityGuard, guards, harness, okOf, op, open, policyFor, presentationGuard, settled, type Harness, type Opened } from '../activity/support/adapter-harness';

let current: Harness | null = null;
afterEach(() => { current?.adapter.dispose(); current = null; });

async function openAt(templateId: string, stages: string[]): Promise<Opened> {
  const template = INSTALLED_TEMPLATES.find(item => item.templateId === templateId)!;
  const entry = createInstalledCatalog().listTemplates().find(item => item.template.templateId === templateId)!;
  current = harness({ policy: policyFor({
    policyId: 'policy-spatial', approved: [{ template: entry.template, model: entry.model }], visibleGroups: template.groups.map(group => group.id),
    permittedControls: template.controls.map(control => control.parameter), sampling: { allowed: false, maxPositions: 0 },
    allowedTools: ['discover', 'prepare', 'inspect.learner', 'request-reveal', 'operate.parameters', 'operate.navigation', 'operate.playback', 'operate.presentation', 'summarize', 'save', 'restore', 'close'],
  }) });
  const activityId = `act-spatial-${templateId}`.slice(0, 64);
  const opened = await open(current, { activityId, objectiveIds: ['obj-1'], hostSessionId: 'session-1', hostSessionRevision: 0, template: { templateId, version: template.version }, mode: 'approved' });
  await settled(current, activityId);
  for (const stage of stages) {
    okOf(await opened.control.requestStageTransition({ operationId: op('stage'), ...activityGuard(opened.learner), toStage: stage }));
    await settled(current, activityId);
    ackCurrent(opened.learner);
    await settled(current, activityId);
  }
  return opened;
}
async function scenario(binding: ActivityBinding, scenarioId: string): Promise<void> {
  okOf(await binding.applyScenario({ operationId: op('scenario'), ...guards(binding), scenarioId }));
  await settled(current!);
}
const scene3d = (binding: ActivityBinding): ProjectedView => binding.getProjection().views.find(view => view.kind === 'scene3d')!;
const planOf = (view: ProjectedView): SpatialPlan => planSpatialScene(view, viewFrame(view));
const value = (binding: ActivityBinding, id: string) => binding.getProjection().views.flatMap(view => view.values).find(item => item.quantityId === id);
/** An angle value in its display unit (the projection formats angles in the presentation's display unit). */
const angle = (binding: ActivityBinding): number => { const item = value(binding, 'angle')!; return item.unit === 'deg' ? (item.value as number) * Math.PI / 180 : item.value as number; };
const expectClose = (actual: readonly number[], expected: readonly number[], digits = 12) => actual.forEach((item, i) => expect(item).toBeCloseTo(expected[i]!, digits));

describe('vector orientation in 3D (A45)', () => {
  it('draws u and v with arrowheads and hides the angle arc and cross product before they are shown', async () => {
    const opened = await openAt('vector-orientation-3d', ['predict']);
    const plan = planOf(scene3d(opened.learner));
    expect(plan.arrows.map(arrow => [arrow.markId, arrow.segmentId, arrow.tip])).toEqual([['vector-segments', 'u', [2, 1, 0]], ['vector-segments', 'v', [1, 2, 2]]]);
    expect(plan.lines).toEqual([]);
    expect(plan.labels.filter(label => label.kind !== 'tick' && label.kind !== 'axis').map(label => label.text)).toEqual(['u', 'v']);
    expect(plan.rejected).toEqual([]);
  });

  it('right-handed cross products: e_x × e_y along +z and e_y × e_x along −z, with the angle arc in the xy plane', async () => {
    const opened = await openAt('vector-orientation-3d', ['predict', 'explore-angle', 'explore-cross']);
    await scenario(opened.learner, 'basis-x-y');
    let plan = planOf(scene3d(opened.learner));
    const crossOf = (p: SpatialPlan) => p.arrows.filter(arrow => arrow.markId === 'cross-segment' || arrow.markId === 'cross-direction-arrow');
    expect(crossOf(plan).map(arrow => [arrow.markId, arrow.tail, arrow.tip])).toEqual([['cross-segment', [0, 0, 0], [0, 0, 1]], ['cross-direction-arrow', [0, 0, 0], [0, 0, 1]]]);
    const arc = plan.lines.find(line => line.markId === 'angle-arc-curve')!;
    expect(arc.points.every(point => point[2] === 0)).toBe(true);
    expect(plan.labels.find(label => label.text === 'u × v')!.at).toEqual([0, 0, 1]);
    await scenario(opened.learner, 'basis-y-x');
    plan = planOf(scene3d(opened.learner));
    expect(crossOf(plan).map(arrow => arrow.tip)).toEqual([[0, 0, -1], [0, 0, -1]]);
  });

  it('parallel and antiparallel vectors: no cross arrow, no arrowhead, the undefined direction is stated with its reason', async () => {
    const opened = await openAt('vector-orientation-3d', ['predict', 'explore-angle', 'explore-cross']);
    for (const [id, relationship, expected] of [['pair-a', 'parallel', 0], ['pair-b', 'antiparallel', Math.PI]] as const) {
      await scenario(opened.learner, id);
      const plan = planOf(scene3d(opened.learner));
      expect(plan.arrows.map(arrow => arrow.markId), id).toEqual(['vector-segments', 'vector-segments']);
      expect(plan.points, id).toEqual([]);
      const note = plan.notes.find(item => item.markId === 'cross-direction-arrow')!;
      expect(note.kind).toBe('undefined');
      expect(note.text).toMatch(/^Direction of u × v \(length 1, not to scale\): undefined — u and v point in exactly (the same|opposite) directions?, so u × v = 0 and has no direction/);
      expect(value(opened.learner, 'relationship')!.text, id).toContain(relationship);
      expect(angle(opened.learner), id).toBeCloseTo(expected, 12);
      expect(plan.notes.some(item => item.markId === 'angle-arc-curve' && item.kind === 'gap')).toBe(true);
    }
  });

  it('orthogonal vectors: the cross product is drawn and is perpendicular to both; a zero vector draws no arrow and leaves the angle undefined', async () => {
    const opened = await openAt('vector-orientation-3d', ['predict', 'explore-angle', 'explore-cross']);
    await scenario(opened.learner, 'pair-c');
    let plan = planOf(scene3d(opened.learner));
    const u: Vec3 = [1, 2, 2], v: Vec3 = [2, 1, -2];
    const cross = plan.arrows.find(arrow => arrow.markId === 'cross-segment')!.tip;
    // Independent cross product of the scenario inputs.
    expect(cross).toEqual([u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]);
    expect(cross[0] * u[0] + cross[1] * u[1] + cross[2] * u[2]).toBe(0);
    expect(cross[0] * v[0] + cross[1] * v[1] + cross[2] * v[2]).toBe(0);
    expect(angle(opened.learner)).toBeCloseTo(Math.PI / 2, 12);
    expect(value(opened.learner, 'relationship')!.text).toContain('orthogonal');
    await scenario(opened.learner, 'pair-e');
    plan = planOf(scene3d(opened.learner));
    expect(plan.arrows.filter(arrow => arrow.markId === 'vector-segments').map(arrow => arrow.segmentId)).toEqual(['v']);
    expect(plan.arrows.some(arrow => arrow.markId !== 'vector-segments')).toBe(false);
    expect(value(opened.learner, 'angle')).toMatchObject({ status: 'undefined' });
    expect(value(opened.learner, 'angle')!.reason).toContain('zero vector');
  });

  it('camera changes advance only the presentation revision', async () => {
    const opened = await openAt('vector-orientation-3d', ['predict', 'explore-angle']);
    const before = opened.learner.getProjection();
    const camera = orbitToCamera(presetOrbit(defaultOrbit(), 'top'), viewFrame(scene3d(opened.learner)));
    okOf(opened.learner.setCamera({ operationId: op('camera'), ...presentationGuard(opened.learner), viewId: 'space', camera }));
    const after = opened.learner.getProjection();
    expect(after.presentationRevision).toBe(before.presentationRevision + 1);
    expect(after.guards).toEqual(before.guards);
    expect(after.frame!.frameId).toBe(before.frame!.frameId);
    expect(after.activityRevision).toBe(before.activityRevision);
    expect(after.presentation.views.space!.camera).toEqual(camera);
    expect(planOf(scene3d(opened.learner)).arrows).toEqual(planOf(before.views.find(view => view.kind === 'scene3d')!).arrows);
  });
});

describe('quadratic surface and gradient in 3D (A46)', () => {
  /** Analytic gradient of f(x, y) = (a·x² + 2b·x·y + c·y²)/2 (independent of the kernel). */
  const gradient = (a: number, b: number, c: number, x: number, y: number): [number, number] => [a * x + b * y, b * x + c * y];

  it('draws the sampled 41 × 41 surface with its sampling and vertical scale disclosed and no holes', async () => {
    const opened = await openAt('quadratic-surface-gradient', []);
    const view = scene3d(opened.learner);
    const plan = planOf(view);
    const [mesh] = plan.surfaces;
    expect(mesh!.vertices).toHaveLength(41 * 41);
    expect(mesh!.triangles).toHaveLength(40 * 40 * 6);
    expect(mesh!.holes).toBe(0);
    expect(plan.notes.map(note => note.kind)).toEqual(expect.arrayContaining(['sampling', 'aspect']));
    expect(plan.notes.find(note => note.kind === 'sampling')!.text).toContain('41 × 41 grid over x from −2 to 2 and y from −2 to 2');
    expect(plan.arrows).toEqual([]);
    expect(plan.points).toEqual([expect.objectContaining({ markId: 'point-on-surface', at: [1, 1, 2] })]);
  });

  it('the gradient arrow at p lies in the plane z = f(p) along the analytic gradient, for several coefficient sets', async () => {
    const opened = await openAt('quadratic-surface-gradient', ['predict', 'explore-point', 'explore-field']);
    for (const id of ['default-bowl', 'round-bowl', 'stretched-bowl', 'tilted-bowl', 'narrow-tilted-bowl']) {
      await scenario(opened.learner, id);
      const params = opened.learner.getProjection().controls.reduce<Record<string, number>>((all, control) => ({ ...all, [control.parameter]: control.value }), {});
      const plan = planOf(scene3d(opened.learner));
      const arrow = plan.arrows.find(item => item.markId === 'gradient-arrow-3d')!;
      const height = (params.a! * params.px! ** 2 + 2 * params.b! * params.px! * params.py! + params.c! * params.py! ** 2) / 2;
      expectClose(arrow.tail, [params.px!, params.py!, height]);
      expect(arrow.tip[2]).toBeCloseTo(height, 12);
      const [gx, gy] = gradient(params.a!, params.b!, params.c!, params.px!, params.py!);
      expectClose(normalize([arrow.tip[0] - arrow.tail[0], arrow.tip[1] - arrow.tail[1], 0])!, [gx / Math.hypot(gx, gy), gy / Math.hypot(gx, gy), 0]);
      // The linked contour view draws the same arrow seen from above.
      const contour = opened.learner.getProjection().views.find(view => view.viewId === 'contour-plot')!;
      const flat = contour.marks.find(mark => mark.markId === 'gradient-arrow')!.geometry as { segments: { from: number[]; to: number[] }[] };
      expectClose(flat.segments[0]!.to, [arrow.tip[0], arrow.tip[1]]);
    }
  });

  it('a height that underflows is noted as beyond the representable range in the 3D notes and the coordinate table, never as undefined (R24, §8.2, A11)', async () => {
    const opened = await openAt('quadratic-surface-gradient', ['predict', 'explore-point']);
    okOf(await opened.learner.commitParameters({ operationId: op('commit'), ...guards(opened.learner), displayValues: { px: 1e-200, py: 0 } }));
    await settled(current!);
    const view = scene3d(opened.learner);
    const point = view.marks.find(mark => mark.markId === 'point-on-surface')!;
    expect(point.at).toBeNull();
    expect(value(opened.learner, 'value')).toMatchObject({ status: 'numerical-limit' });
    const reason = (point.geometry as { points: { reason?: string }[] }).points[0]!.reason!;
    expect(reason).toMatch(/smallest representable number/);
    // The projection classifies the gap by its frame quantity and says so on the mark.
    expect(point.limitReasons).toEqual(expect.arrayContaining([reason, point.undefinedReason]));
    expect(opened.learner.getProjection().status).toMatchObject({ ui: 'undefined', cause: 'numerical-limit' });
    const notes = planOf(view).notes.filter(note => note.markId === 'point-on-surface');
    expect(notes).toEqual([{ markId: 'point-on-surface', kind: 'numerical-limit', text: `${point.label}: 1 point is beyond the representable range — ${reason.replace(/\.$/, '')}. It is not drawn.` }]);
    expect(planOf(view).notes.some(note => /\bundefined\b/.test(note.text))).toBe(false);
    const row = coordinateTable(view, 'en').rows.find(item => item.key.startsWith('point-on-surface'))!;
    expect(row.cells[0]).toBe(`Beyond numerical range (${reason.replace(/\.$/, '')})`);
  });

  it('at the minimum (p at the origin) the gradient is zero: no arrow is drawn and its direction is undefined', async () => {
    const opened = await openAt('quadratic-surface-gradient', ['predict', 'explore-point', 'explore-field']);
    await scenario(opened.learner, 'point-at-origin');
    const plan = planOf(scene3d(opened.learner));
    expect(plan.arrows).toEqual([]);
    expect(plan.points).toEqual([expect.objectContaining({ at: [0, 0, 0] })]);
    expect(value(opened.learner, 'gradient.direction')).toMatchObject({ status: 'undefined' });
    expect(value(opened.learner, 'minimum.location')!.value).toEqual([0, 0]);
  });
});

describe('the 2D alternative\'s coordinate table names rows in learner text (R40, §10.4, §11, A44)', () => {
  const ROLE_KEY = /\((at|from|to|vector)\)$|: (at|from|to|vector)$/;

  it('vector orientation: the segments the 3D view names at their tips (u, v) by those names, the cross product and its direction by their labels alone', async () => {
    const opened = await openAt('vector-orientation-3d', ['predict', 'explore-angle', 'explore-cross']);
    await scenario(opened.learner, 'basis-x-y');
    const view = scene3d(opened.learner);
    const label = (id: string) => view.marks.find(mark => mark.markId === id)!.label;
    const table = coordinateTable(view, 'en');
    expect(table.rows.map(row => [row.label, row.cells[0]])).toEqual([
      [`${label('vector-segments')}: u`, '(0, 0, 0) → (1, 0, 0)'],
      [`${label('vector-segments')}: v`, '(0, 0, 0) → (0, 1, 0)'],
      [label('angle-arc-curve'), expect.stringMatching(/^A curve through \d+ sampled points/)],
      [label('cross-segment'), '(0, 0, 0) → (0, 0, 1)'],
      [label('cross-direction-arrow'), '(0, 0, 1)'],
    ]);
    // Every segment ID in a row name is a name the 3D drawing shows at that segment's tip.
    const drawnNames = new Set(planOf(view).labels.filter(item => item.kind === 'segment').map(item => item.text));
    expect([...drawnNames].sort()).toEqual(['u', 'v']);
    for (const row of table.rows) expect(row.label, row.label).not.toMatch(ROLE_KEY);
    expect(table.rows.some(row => /: cross$/.test(row.label))).toBe(false);
  });

  it('quadratic surface: the gradient arrow by its label alone and the point on the surface listed once', async () => {
    const opened = await openAt('quadratic-surface-gradient', ['predict', 'explore-point']);
    const view = scene3d(opened.learner);
    const label = (id: string) => view.marks.find(mark => mark.markId === id)!.label;
    const rows = coordinateTable(view, 'en').rows;
    expect(rows.map(row => row.label)).toEqual([label('surface-mesh'), label('gradient-arrow-3d'), label('point-on-surface')]);
    expect(rows.find(row => row.label === label('point-on-surface'))!.cells[0]).toBe('(1, 1, 2)');
    expect(rows.find(row => row.label === label('gradient-arrow-3d'))!.cells[0]).toMatch(/^\(1, 1, 2\) → \(/);
    for (const row of rows) expect(row.label, row.label).not.toMatch(ROLE_KEY);
  });
});
