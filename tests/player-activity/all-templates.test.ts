/**
 * The learner surface against every installed template through the real adapter (in-process test workers and the
 * test-only memory host; fixture-host results, server rendering only — browser and packaged WebView rendering are
 * not covered here). At every stage of each template's walk: every 2D view, and the 2D projection of every 3D view,
 * plans without unsupported marks; directed geometry (vectors, gradients) is drawn with arrowheads; tables are
 * rectangular; the server-rendered surface carries no label of an absent group that visible content does not also
 * carry.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import type { ActivityTemplate, LearnerProjection, ProjectedView } from '../../packages/activity/src/index';
import { createInstalledCatalog, INSTALLED_TEMPLATES } from '../../packages/catalog/src/index';
import { StudyActivitySurface } from '../../packages/player/src/activity/index';
import { isDirected, planScene, type ScenePlan } from '../../packages/player/src/activity/plan';
import { PROJECTION_PLANES, projectView } from '../../packages/player/src/activity/project3d';
import { boundsOf, fitFrame } from '../../packages/player/src/activity/scale';
import { ackCurrent, activityGuard, harness, okOf, op, open, policyFor, settled, type Harness } from '../activity/support/adapter-harness';

/** Stages walked from the initial stage (the last one before `closed` shows every group). */
const PATHS: Record<string, string[]> = {
  'quadratic-gradient-descent': ['explore-step', 'explore-curvature', 'explain'],
  'function-derivative': ['predict', 'explore-slope', 'explore-derivative', 'explain'],
  'linear-transformation': ['predict', 'explore', 'explore-eigen', 'explain'],
  'vector-orientation-3d': ['predict', 'explore-angle', 'explore-cross', 'explain'],
  'quadratic-surface-gradient': ['predict', 'explore-point', 'explore-field', 'explain'],
};

let current: Harness | null = null;
afterEach(() => { current?.adapter.dispose(); current = null; });

const planOf = (view: ProjectedView): ScenePlan => planScene(view, fitFrame(boundsOf(view.bounds), { x: 40, y: 10, width: 480, height: 320 }, view.equalAspect));
/** Every graphical view as the surface draws it without a spatial renderer: 2D views as they are, 3D views as each coordinate projection. */
const drawn = (projection: LearnerProjection): ProjectedView[] => projection.views.flatMap(view =>
  view.kind === 'plot2d' || view.kind === 'scene2d' ? [view] : view.kind === 'scene3d' ? PROJECTION_PLANES.map(plane => projectView(view, plane)) : []);

/** Checks one stage; returns the number of arrowheads drawn for directed segment marks. */
function checkStage(template: ActivityTemplate, projection: LearnerProjection, html: string): number {
  const where = `${template.templateId} @ ${projection.stage.id}`;
  let arrows = 0;
  expect(html, where).toContain('class="eka"');
  expect(html, where).toContain(`data-eka-ui-state="${projection.status.ui}"`);
  for (const view of drawn(projection)) {
    const plan = planOf(view);
    expect(plan.notes.filter(note => note.kind === 'unsupported'), `${where} ${view.viewId}`).toEqual([]);
    for (const mark of view.marks) {
      const planned = plan.marks.find(item => item.markId === mark.markId)!;
      const noted = plan.notes.some(note => note.markId === mark.markId);
      // Something is drawn for each mark, or a note says why not (undefined, degenerate, gap, zero vector).
      expect(planned.primitives.length > 0 || noted || mark.geometry?.kind === 'segments2' && mark.geometry.segments.length === 0, `${where} ${view.viewId}/${mark.markId}`).toBe(true);
      // A directed segment is an arrow, or a dot when it is too short to draw at this zoom; never a line without a head.
      if (isDirected(mark)) {
        expect(planned.primitives.map(primitive => primitive.shape.type).filter(type => type !== 'arrow' && type !== 'marker'), `${where} ${view.viewId}/${mark.markId}`).toEqual([]);
        arrows += planned.primitives.filter(primitive => primitive.shape.type === 'arrow').length;
      }
    }
  }
  for (const view of projection.views) if (view.table) for (const row of view.table.rows) expect(row.cells, `${where} ${view.viewId}`).toHaveLength(view.table.columns.length);
  // Absent groups: none of their view titles or mark labels reaches the markup unless visible content repeats the text.
  const stage = template.stages.find(item => item.id === projection.stage.id)!;
  const visible = new Set(Object.keys(stage.visible));
  const corpus = JSON.stringify(projection);
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
  const hidden = [
    ...template.views.filter(view => !visible.has(view.group)).map(view => view.title),
    ...template.views.flatMap(view => view.marks).filter(mark => !visible.has(mark.group)).map(mark => mark.label),
    ...template.equations.filter(equation => !visible.has(equation.group)).map(equation => equation.label),
  ];
  expect(hidden.filter(text => text.length >= 4 && html.includes(escape(text)) && !corpus.includes(JSON.stringify(text).slice(1, -1))), where).toEqual([]);
  return arrows;
}

describe('learner surface with every installed template (server rendering, fixture host)', () => {
  it('walks exactly the installed templates', () => {
    expect(Object.keys(PATHS).sort()).toEqual(INSTALLED_TEMPLATES.map(template => template.templateId).sort());
  });

  for (const template of INSTALLED_TEMPLATES) {
    it(`${template.templateId}: plans, draws directed geometry with arrowheads and renders each stage`, async () => {
      const entry = createInstalledCatalog().listTemplates().find(item => item.template.templateId === template.templateId)!;
      current = harness({ policy: policyFor({
        policyId: 'policy-surface', approved: [{ template: entry.template, model: entry.model }], visibleGroups: template.groups.map(group => group.id),
        permittedControls: template.controls.map(control => control.parameter), sampling: { allowed: false, maxPositions: 0 },
        allowedTools: ['discover', 'prepare', 'inspect.learner', 'request-reveal', 'operate.parameters', 'operate.navigation', 'operate.playback', 'operate.presentation', 'summarize', 'save', 'restore', 'close'],
      }) });
      const activityId = `act-surface-${template.templateId}`.slice(0, 64);
      const opened = await open(current, { activityId, objectiveIds: ['obj-1'], hostSessionId: 'session-1', hostSessionRevision: 0, template: { templateId: template.templateId, version: template.version }, mode: 'approved' });
      await settled(current, activityId);
      checkStage(template, opened.learner.getProjection(), renderToString(createElement(StudyActivitySurface, { binding: opened.learner, theme: 'light' })));
      let arrows = 0;
      for (const stage of PATHS[template.templateId]!) {
        okOf(await opened.control.requestStageTransition({ operationId: op('stage'), ...activityGuard(opened.learner), toStage: stage }));
        await settled(current, activityId);
        ackCurrent(opened.learner);
        await settled(current, activityId);
        const projection = opened.learner.getProjection();
        expect(projection.stage.id).toBe(stage);
        arrows += checkStage(template, projection, renderToString(createElement(StudyActivitySurface, { binding: opened.learner, theme: 'light' })));
      }
      // Templates with directed segment marks (vectors, cross product, gradients) show arrowheads once those marks are visible.
      if (template.views.some(view => view.marks.some(mark => isDirected({ kind: mark.kind, style: mark.style })))) expect(arrows).toBeGreaterThan(0);
    });
  }
});
