/**
 * Projection and surface rules found by inspection (report §10.2, §10.4, A28, A29, A34): the `undefined` UI state is
 * raised only by drawn marks; conditional values that appear only in readouts are shown inline with their reason;
 * trace tables keep exact integers and six significant digits while readouts keep four; iteration counts read
 * `n = …`; coincident labels merge; comparisons show both runs. Real adapter, catalogue and kernels with in-process test
 * workers and the test-only memory host (fixture-host results, server rendering only).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describeProjection, type ActivityRequest, type ActivityTemplate, type LearnerProjection, type ProjectedValue } from '../../packages/activity/src/index';
import { createInstalledCatalog, functionDerivativeTemplate, linearTransformationTemplate, vectorOrientationTemplate } from '../../packages/catalog/src/index';
import { projectView, PROJECTION_PLANES } from '../../packages/player/src/activity/project3d';
import { StudyActivitySurface } from '../../packages/player/src/activity/index';
import { valueDisplay } from '../../packages/player/src/activity/format';
import { labelObstacles, mergeCoincidentLabels, planScene, SHORT_VECTOR_LABEL, ZERO_VECTOR_LABEL } from '../../packages/player/src/activity/plan';
import { labelMetrics, placeLabels } from '../../packages/player/src/activity/labels';
import { boundsOf, fitFrame } from '../../packages/player/src/activity/scale';
import { ackCurrent, activityGuard, enterExplore, guards, harness, okOf, op, open, policyFor, requestFor, settled, type Harness, type Opened } from '../activity/support/adapter-harness';

let current: Harness | null = null;
afterEach(() => { current?.adapter.dispose(); current = null; });

async function openTemplate(template: ActivityTemplate, path: string[], parameters?: Record<string, number>): Promise<{ h: Harness; opened: Opened; activityId: string }> {
  const entry = createInstalledCatalog().listTemplates().find(item => item.template.templateId === template.templateId)!;
  const h = harness({ policy: policyFor({
    policyId: 'policy-polish', approved: [{ template: entry.template, model: entry.model }], visibleGroups: template.groups.map(group => group.id),
    permittedControls: template.controls.map(control => control.parameter),
  }) });
  current = h;
  const activityId = `act-polish-${template.templateId}`;
  const request: ActivityRequest = { activityId, objectiveIds: ['obj-1'], hostSessionId: 'session-1', hostSessionRevision: 0, template: { templateId: template.templateId, version: template.version }, mode: 'approved', ...(parameters ? { parameters } : {}) };
  const opened = await open(h, request);
  await settled(h, activityId);
  for (const stage of path) {
    okOf(await opened.control.requestStageTransition({ operationId: op('stage'), ...activityGuard(opened.learner), toStage: stage }));
    await settled(h, activityId);
    ackCurrent(opened.learner);
    await settled(h, activityId);
  }
  return { h, opened, activityId };
}
/** Server-rendered card markup without React's text-node separators. */
const render = (opened: Opened): string => renderToString(createElement(StudyActivitySurface, { binding: opened.learner, theme: 'light' })).replace(/<!-- -->/g, '');
const valueOf = (projection: LearnerProjection, id: string): ProjectedValue | undefined => projection.views.flatMap(view => view.values).find(value => value.quantityId === id);
const markOf = (projection: LearnerProjection, id: string) => projection.views.flatMap(view => view.marks).find(mark => mark.markId === id);
const planOf = (projection: LearnerProjection, viewId: string) => {
  const view = projection.views.find(item => item.viewId === viewId)!;
  return planScene(view, fitFrame(boundsOf(view.bounds), { x: 40, y: 10, width: 480, height: 320 }, view.equalAspect));
};

describe('the undefined UI state is raised by drawn marks only', () => {
  it('linear transformation: the collapse direction of a full-rank matrix is inline, not a banner; an undefined drawn direction is', async () => {
    const { h, opened, activityId } = await openTemplate(linearTransformationTemplate, ['predict', 'explore']);
    let projection = opened.learner.getProjection();
    expect(valueOf(projection, 'rank')).toMatchObject({ status: 'valid', value: 2 });
    expect(valueOf(projection, 'image.direction')).toMatchObject({ status: 'undefined', reason: expect.stringMatching(/./) });
    expect(valueOf(projection, 'image.direction')!.text).toMatch(/^Undefined/);
    // Not reported as undefined; and at the default matrix the transformed grid fits the authored view (G42), so the card is ready.
    expect(projection.status.ui).toBe('ready');
    const html = render(opened);
    expect(html).not.toContain('Some values are undefined here');
    expect(html).toContain(valueOf(projection, 'image.direction')!.reason!.replace(/'/g, '&#x27;'));

    // Collapse: the direction is defined and still no banner.
    projection = okOf(await opened.learner.applyScenario({ operationId: op('scenario'), ...guards(opened.learner), scenarioId: 'collapse' }));
    await settled(h, activityId);
    expect(valueOf(projection, 'rank')).toMatchObject({ value: 1 });
    expect(valueOf(projection, 'image.direction')).toMatchObject({ status: 'valid' });
    expect(projection.status.ui).not.toBe('undefined');

    // Unchanged directions of a rotation are drawn marks without a value: the drawing is affected, so the state is raised.
    okOf(await opened.control.requestStageTransition({ operationId: op('stage'), ...activityGuard(opened.learner), toStage: 'explore-eigen' }));
    await settled(h, activityId);
    ackCurrent(opened.learner);
    projection = okOf(await opened.learner.applyScenario({ operationId: op('scenario'), ...guards(opened.learner), scenarioId: 'rotation-30' }));
    expect(valueOf(projection, 'eigen.category')).toMatchObject({ value: 'complex' });
    expect(markOf(projection, 'eigen-direction-1')!.undefinedReason).toMatch(/./);
    expect(projection.status.ui).toBe('undefined');
  });

  it('function and derivative: h = 0 shows the secant slope as undefined inline, merges P and Q, and raises no banner', async () => {
    const { opened } = await openTemplate(functionDerivativeTemplate, ['predict', 'explore-slope'], { A: 0.5, B: -1, C: -2, p: 1, h: 0 });
    const projection = opened.learner.getProjection();
    expect(valueOf(projection, 'secant.slope')).toMatchObject({ status: 'undefined', reason: expect.stringContaining('needs two distinct points') });
    expect(valueOf(projection, 'secant.slope')).not.toHaveProperty('value');
    expect(valueOf(projection, 'derivative')).toMatchObject({ status: 'valid', value: 0 });
    const quotient = projection.views.flatMap(view => view.equations).find(item => item.equationId === 'secant-quotient')!;
    expect(quotient.plain).toContain('Undefined: The secant needs two distinct points');
    // Lines reach beyond the authored y-range (clipped indicator); the undefined secant slope does not raise a banner.
    expect(projection.status.ui).toBe('clipped');
    expect(render(opened)).not.toContain('Some values are undefined here');
    const plan = planOf(projection, 'function-plot');
    expect(plan.marks.find(mark => mark.markId === 'secant-line')!.primitives).toEqual([]);
    expect(plan.labels.map(label => label.text)).toContain('P, Q');
    expect(plan.labels.map(label => label.text)).not.toContain('Q');
  });
});

describe('number formatting of tables and readouts', () => {
  it('writes exact integers and six significant digits in trace tables; readouts keep four; tiny values never print as 0', async () => {
    const h = harness();
    current = h;
    const opened = await open(h, requestFor({ parameters: { a: 2, eta: 2, x0: 4 } }));
    await enterExplore(h, opened);
    let projection = okOf(await opened.learner.navigate({ operationId: op('nav'), ...guards(opened.learner), position: { kind: 'index', index: 10 } }));
    const table = projection.views.find(view => view.viewId === 'trace-table')!.table!;
    expect(table.rows.find(row => row.key === 'n10')!.cells).toEqual(['10', '236,196']);
    expect(table.rows.find(row => row.key === 'n9')!.cells).toEqual(['9', '−78,732'.replace('−', '-')]);
    expect(valueOf(projection, 'position')?.text ?? valueOf(projection, 'index')!.text).toBeDefined();
    const index = valueOf(projection, 'index')!;
    expect(valueDisplay(index)).toMatchObject({ text: 'n = 10', unit: '' });
    expect(describeProjection(projection)).toContain('Iteration: n = 10.');
    expect(describeProjection(projection)).not.toContain('iter');

    projection = okOf(await opened.learner.navigate({ operationId: op('nav'), ...guards(opened.learner), position: { kind: 'index', index: 40 } }));
    const far = projection.views.find(view => view.viewId === 'trace-table')!.table!.rows.find(row => row.key === 'n40')!;
    // 4·3⁴⁰ is above 2⁵³: six significant digits in scientific notation, not a fabricated integer.
    expect(far.cells).toEqual(['40', '4.86307 × 10¹⁹']);

    const tiny = await open(h, requestFor({ activityId: 'act-tiny', parameters: { a: 1, eta: 0.999, x0: 4 } }));
    await enterExplore(h, tiny);
    const small = okOf(await tiny.learner.navigate({ operationId: op('nav'), ...guards(tiny.learner), position: { kind: 'index', index: 3 } }));
    const row = small.views.find(view => view.viewId === 'trace-table')!.table!.rows.find(item => item.key === 'n3')!;
    expect(row.cells[1]).toMatch(/^4(\.0+)? × 10⁻⁹$/);
    h.adapter.dispose('act-tiny');
  });
});

describe('the 2D fallback of the 3D vector view (A44; F4)', () => {
  it('u × v along z seen end-on on the x–y plane is not called a zero vector; its true direction and length are said', async () => {
    const { opened } = await openTemplate(vectorOrientationTemplate, ['predict', 'explore-angle', 'explore-cross']);
    okOf(await opened.learner.applyScenario({ operationId: op('scenario'), ...guards(opened.learner), scenarioId: 'basis-x-y' }));
    await settled(current!, 'act-polish-vector-orientation-3d');
    const space = opened.learner.getProjection().views.find(view => view.kind === 'scene3d')!;
    expect(space.marks.find(mark => mark.markId === 'cross-direction-arrow')!.vector).toEqual([0, 0, 1]);
    const plan = (plane: (typeof PROJECTION_PLANES)[number]) => {
      const projected = projectView(space, plane);
      return planScene(projected, fitFrame(boundsOf(projected.bounds!), { x: 40, y: 10, width: 480, height: 320 }, true));
    };
    const xy = plan('xy');
    const notes = xy.notes.filter(note => note.markId === 'cross-direction-arrow');
    expect(notes.map(note => note.kind)).toEqual(['end-on']);
    expect(notes[0]!.text).toMatch(/^Direction of u × v.*: points along \+z \(length 1\), straight along the axis this projection leaves out.*\(not a zero vector\)/);
    expect(xy.notes.filter(note => note.kind === 'zero-vector')).toEqual([]);
    expect(xy.labels.map(label => label.text)).toContain('u × v (points along +z, seen end-on)');
    expect(xy.labels.map(label => label.text).join(' ')).not.toContain(ZERO_VECTOR_LABEL);
    // Where the plane shows z, the direction is an arrow and nothing is end-on.
    for (const plane of ['xz', 'yz'] as const) expect(plan(plane).notes.filter(note => note.markId === 'cross-direction-arrow')).toEqual([]);
  });
});

describe('coincident labels and comparisons', () => {
  it('merges the labels of coincident features deterministically, names first and descriptors last', () => {
    const at: [number, number] = [100, 100];
    const merged = mergeCoincidentLabels([
      { id: 'a', markId: 'start', text: 'x₀', at, data: [2, 3], placement: { anchor: 'ne', offset: [6, -6], leader: false, maxWidthEm: 4 } },
      { id: 'b', markId: 'current', text: 'xₙ', at, data: [2, 3], placement: { anchor: 'nw', offset: [-6, -6], leader: false, maxWidthEm: 4 } },
      // Within a pixel but not the same point: kept apart (placement separates it), never presented as coincident.
      { id: 'n', markId: 'next', text: 'x₁', at: [100.4, 99.8], data: [2.001, 3] },
      { id: 'c', markId: 'other', text: 'Q', at: [140, 100], data: [4, 3] },
    ]);
    expect(merged.map(label => label.text)).toEqual(['x₀, xₙ', 'x₁', 'Q']);
    expect(merged[0]).toMatchObject({ id: 'a+1', markId: 'start', markIds: ['start', 'current'], at, placement: { anchor: 'ne' } });
    expect(mergeCoincidentLabels([
      { id: 'z', markId: 'v', text: ZERO_VECTOR_LABEL, at }, { id: 'v', markId: 'v', text: 'v', at }, { id: 'mv', markId: 'mv', text: 'Mv', at }, { id: 'z2', markId: 'mv', text: ZERO_VECTOR_LABEL, at },
    ]).map(label => label.text)).toEqual(['v, Mv (zero vector)']);
    expect(mergeCoincidentLabels([{ id: 's', markId: 'u', text: SHORT_VECTOR_LABEL, at }]).map(label => label.text)).toEqual([SHORT_VECTOR_LABEL]);
  });

  it('quadratic at n = 0: x₀ and xₙ share one label; a comparison names both runs and both values of each difference', async () => {
    const h = harness();
    current = h;
    const opened = await open(h);
    const explore = await enterExplore(h, opened);
    const labels = planOf(explore, 'landscape').labels.map(label => label.text);
    expect(labels).toContain('x₀, xₙ');
    expect(labels.filter(text => text === 'xₙ' || text === 'x₀')).toEqual([]);

    okOf(opened.learner.retainComparison({ operationId: op('keep'), ...guards(opened.learner), label: 'η = 0.5' }));
    const eta = explore.controls.find(control => control.parameter === 'eta')!.value;
    const next = okOf(await opened.learner.commitParameters({ operationId: op('commit'), ...guards(opened.learner), displayValues: { eta: eta === 1.5 ? 1.25 : 1.5 } }));
    await settled(h);
    const comparison = next.comparisons[0]!;
    expect(comparison.parameterDifferences).toEqual([{ parameter: 'eta', label: 'Step size η', symbol: 'η', text: String(eta), currentText: eta === 1.5 ? '1.25' : '1.5' }]);
    // The panel names the kept run by its differing parameters' symbols (G44), not by the label it was kept under.
    expect(comparison.name).toBe(`η = ${eta}`);
    const html = render(opened);
    expect(html).toContain(`Kept run 1: <span class="ema-comparison-name">η = ${eta}</span>`);
    expect(html).toMatch(/<th scope="col">Current run<\/th><th scope="col">Kept run 1<\/th>/);
  });
});

describe('label crowding near the origin (report §10.2, A34)', () => {
  /** Plans and places the plane's labels at a square plot of `side` pixels, as the 2D surface does. */
  const placedAt = (projection: LearnerProjection, side: number) => {
    const view = projection.views.find(item => item.viewId === 'plane')!;
    const frame = fitFrame(boundsOf(view.bounds), { x: 30, y: 10, width: side, height: side }, view.equalAspect);
    const plan = planScene(view, frame);
    const obstacles = labelObstacles(plan);
    return { plan, obstacles, ...placeLabels(plan.labels, { metrics: labelMetrics(13 * 0.8125), bounds: frame.plot, obstacles }) };
  };
  const hits = (a: { x: number; y: number; width: number; height: number }, b: typeof a) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  /** Separating-axis test of an open rectangle against a convex polygon (written here, independently of the placement code). */
  const hitsTriangle = (box: { x: number; y: number; width: number; height: number }, polygon: readonly (readonly [number, number])[]) => {
    const corners: [number, number][] = [[box.x, box.y], [box.x + box.width, box.y], [box.x + box.width, box.y + box.height], [box.x, box.y + box.height]];
    const axes: [number, number][] = [[1, 0], [0, 1], ...polygon.map((p, i) => { const q = polygon[(i + 1) % polygon.length]!; return [q[1] - p[1], p[0] - q[0]] as [number, number]; })];
    return axes.every(([ax, ay]) => {
      const project = (points: readonly (readonly [number, number])[]) => points.map(([x, y]) => x * ax + y * ay);
      const a = project(corners), b = project(polygon);
      return Math.max(...a) > Math.min(...b) && Math.max(...b) > Math.min(...a);
    });
  };

  it('linear transformation after a reflection: labels at 300 and 560 px never overlap each other, other arrowheads or other labelled points', async () => {
    // reflection-diagonal with v = (1, 1): Mv = v, Me₁ = e₂ and Me₂ = e₁ coincide exactly; u₁ = (1, 1)/√2 lies on v.
    const { opened } = await openTemplate(linearTransformationTemplate, ['predict', 'explore', 'explore-eigen'], { m11: 0, m12: 1, m21: 1, m22: 0, vx: 1, vy: 1 });
    const projection = opened.learner.getProjection();
    for (const side of [300, 560]) {
      const { plan, obstacles, labels, diagnostics } = placedAt(projection, side);
      // Only exactly coincident features share a label.
      expect(plan.labels.map(label => label.text).sort(), `${side}`).toEqual(['e₁, Me₂', 'e₂, Me₁', 'u₁', 'u₂', 'v, Mv']);
      expect(diagnostics.filter(item => item.code === 'LABEL_OVERLAP'), `${side}`).toEqual([]);
      for (const label of labels) {
        const request = plan.labels.find(item => item.id === label.id)!;
        const own = new Set(request.markIds ?? [request.markId]);
        for (const other of labels) if (other !== label) expect(hits(label.box, other.box), `${side}: ${label.id} / ${other.id}`).toBe(false);
        // An arrowhead obstacle is its exact triangle (labelObstacles); point markers are their boxes.
        for (const obstacle of obstacles) if (!own.has(obstacle.markId!)) expect(obstacle.polygon ? hitsTriangle(label.box, obstacle.polygon) : hits(label.box, obstacle), `${side}: ${request.text} covers ${obstacle.markId}`).toBe(false);
        for (const other of plan.labels) if (other.id !== label.id) expect(hits(label.box, { x: other.at[0] - 2, y: other.at[1] - 2, width: 4, height: 4 }), `${side}: ${request.text} covers ${other.text}`).toBe(false);
      }
    }
  });
});
