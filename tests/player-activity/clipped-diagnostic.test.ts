/**
 * The `CLIPPED` surface diagnostic (report §15.2): bounded data drawn outside the authored view is reported to the
 * author (the 2D surface emits one `CLIPPED` diagnostic per such mark at the authored camera; Chromium coverage in
 * tests/cli/activity-preview.test.ts and tests/browser/activity-preview.spec.ts). Reference marks (`role: 'reference'`),
 * reference grids (`grid` marks) and unbounded lines (`extent: 'line'`) are never counted: they are not data.
 */
import { describe, expect, it } from 'vitest';
import type { ProjectedMark, ProjectedView } from '../../packages/activity/src/index';
import { clippedData, planScene } from '../../packages/player/src/activity/plan';
import { fitFrame } from '../../packages/player/src/activity/scale';

type Role = ProjectedMark['style']['role'];
const style = (role: Role): ProjectedMark['style'] => ({ role, dash: 'solid', marker: 'none', weight: 'regular' });
const points = (markId: string, at: [number, number][], role: Role = 'primary'): ProjectedMark => ({
  markId, kind: 'points', label: markId, style: style(role), interactive: false,
  geometry: { kind: 'points2', points: at.map((point, i) => ({ id: `p${i}`, at: point })) },
});
const segments = (markId: string, kind: 'segments' | 'grid', from: [number, number], to: [number, number], extent?: ProjectedMark['extent']): ProjectedMark => ({
  markId, kind, label: markId, style: style('primary'), interactive: false, ...(extent ? { extent } : {}),
  geometry: { kind: 'segments2', segments: [{ id: 's', from, to }] },
});
/** Plans `marks` in the authored view [-6, 6]² and returns the plan's clipped marks and the CLIPPED subset. */
function clipped(marks: ProjectedMark[]) {
  const view: Pick<ProjectedView, 'marks'> = { marks };
  const plan = planScene(view, fitFrame([-6, 6, -6, 6], { x: 0, y: 0, width: 300, height: 300 }, true));
  return { indicator: plan.clipped.map(item => item.markId), diagnostic: clippedData(view, plan).map(item => [item.markId, item.count]) };
}

describe('CLIPPED surface diagnostic', () => {
  it('counts each bounded data mark drawn outside the authored view, with the number of outside coordinates', () => {
    const result = clipped([
      points('inside', [[0, 0], [5, -5]]),
      points('outside', [[0, 0], [9, 0], [0, -7]]),
      segments('segment', 'segments', [0, 0], [8, 8]),
    ]);
    expect(result.diagnostic).toEqual([['outside', 2], ['segment', 1]]);
  });

  it('never counts reference marks, reference grids or unbounded lines', () => {
    const result = clipped([
      points('reference-point', [[10, 10]], 'reference'),
      segments('reference-grid', 'grid', [-9, 0], [9, 0]),
      segments('tangent', 'segments', [-9, -9], [9, 9], 'line'),
      points('data', [[0, 8]]),
    ]);
    // The learner-facing clipped indicator still names the reference point; the author diagnostic does not.
    expect(result.indicator).toEqual(['reference-point', 'data']);
    expect(result.diagnostic).toEqual([['data', 1]]);
  });

  it('reports nothing when every bounded datum is inside the view', () => {
    expect(clipped([points('inside', [[-6, -6], [6, 6]]), segments('segment', 'segments', [-1, 0], [1, 0])]).diagnostic).toEqual([]);
  });
});
