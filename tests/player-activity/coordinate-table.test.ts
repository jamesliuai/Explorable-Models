/**
 * Row names and missing-value text of the coordinate table that accompanies the 2D projection of a 3D view (report §10.4,
 * §11, §8.2; A11, A44; review findings R40 and R24). Rows are named in learner text: the mark's label, a segment's ID only
 * where the 3D drawing names the segment by it, words for a mark's several coordinates (never property keys), and a
 * point positioned by a one-point geometry listed once. A coordinate without a value reads as undefined or as beyond the
 * numerical range, as the projection classifies its reason (`limitReasons`). Real-template rows are checked in
 * tests/player-3d/templates.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { ProjectedMark, ProjectedView } from '../../packages/activity/src/index';
import { coordinateRows, coordinateTable } from '../../packages/player/src/activity/project3d';
import { viewFrame } from '../../packages/player-3d/src/frame';
import { planSpatialScene } from '../../packages/player-3d/src/plan';

const style = { role: 'primary' as const, dash: 'solid' as const, marker: 'triangle' as const, weight: 'regular' as const };
const mark = (extra: Partial<ProjectedMark> & Pick<ProjectedMark, 'markId' | 'kind' | 'label'>): ProjectedMark => ({ style, interactive: false, ...extra });
const view = (marks: ProjectedMark[]): ProjectedView => ({
  viewId: 'space', kind: 'scene3d', title: 'Space', description: '', visibility: 'fixed', bounds3: [-3, 3, -3, 3, -3, 3], equalAspect: true,
  marks, values: [], equations: [], summary: 'A test view.',
} as unknown as ProjectedView);

describe('coordinate table row names (R40)', () => {
  it('names a single segment by its mark label and several segments by the IDs drawn at their tips', () => {
    const rows = coordinateTable(view([
      mark({ markId: 'cross-segment', kind: 'segment', label: 'Cross product u × v', geometry: { kind: 'segments3', segments: [{ id: 'cross', from: [0, 0, 0], to: [0, 0, 1] }] } }),
      mark({ markId: 'edges', kind: 'segment', label: 'Edges', geometry: { kind: 'segments3', segments: [{ id: 'a', from: [0, 0, 0], to: [1, 0, 0] }, { id: 'b', from: [0, 0, 0], to: [0, 1, 0] }] } }),
      mark({ markId: 'vectors', kind: 'segments', label: 'Vectors', geometry: { kind: 'segments3', segments: [{ id: 'u', from: [0, 0, 0], to: [1, 2, 3] }] } }),
    ]), 'en').rows;
    expect(rows.map(row => row.label)).toEqual(['Cross product u × v', 'Edges: a', 'Edges: b', 'Vectors: u']);
  });

  it('lists undirected segments, which the 3D drawing never names, by their order and never by their IDs', () => {
    const plain = { ...style, marker: 'none' as const };
    const rows = coordinateTable(view([
      mark({ markId: 'edges', kind: 'segment', label: 'Edges', style: plain, geometry: { kind: 'segments3', segments: [{ id: 'e1', from: [1, 1, 1], to: [1, 1, 1] }, { id: 'e2', from: [0, 0, 0], to: [1, 0, 0] }] } }),
      mark({ markId: 'rungs', kind: 'segments', label: 'Rungs', style: plain, geometry: { kind: 'segments3', segments: [{ id: 'r9', from: [0, 0, 0], to: [0, 1, 0] }] } }),
    ]), 'en').rows;
    expect(rows.map(row => [row.label, row.cells[0]])).toEqual([
      ['Edges, segment 1', '(1, 1, 1) → (1, 1, 1)'], ['Edges, segment 2', '(0, 0, 0) → (1, 0, 0)'], ['Rungs', '(0, 0, 0) → (0, 1, 0)'],
    ]);
  });

  it('names a segment by its ID exactly when the 3D drawing shows that ID (agrees with the spatial planner for every case)', () => {
    for (const kind of ['segment', 'segments'] as const) for (const marker of ['triangle', 'none', 'circle'] as const) for (const count of [1, 2]) for (const zero of [false, true]) {
      const segments = Array.from({ length: count }, (_, i) => ({ id: `s${i}`, from: [0, 0, 0] as [number, number, number], to: (zero && i === 0 ? [0, 0, 0] : [i + 1, 2, 0]) as [number, number, number] }));
      const projected = mark({ markId: 'm', kind, label: 'Mark', style: { ...style, marker }, geometry: { kind: 'segments3', segments } });
      const drawn = planSpatialScene({ marks: [projected as never] }, viewFrame({ ...view([projected]), marks: [projected] } as never));
      const shownIds = new Set(drawn.labels.filter(label => label.kind === 'segment').map(label => label.text.replace(/ \(zero vector\)$/, '')));
      const rows = coordinateTable(view([projected]), 'en').rows;
      const case_ = `${kind} ${marker} ×${count}${zero ? ' with a zero one' : ''}`;
      expect(rows, case_).toHaveLength(count);
      rows.forEach((row, i) => {
        const id = segments[i]!.id;
        expect(row.label === `Mark: ${id}`, `${case_}: ${row.label}`).toBe(shownIds.has(id));
        expect(row.label.includes(id), `${case_}: ${row.label}`).toBe(shownIds.has(id));
      });
    }
  });

  it('a mark with one coordinate is named by its label; several are named by words, a start and an end as one row', () => {
    const rows = coordinateRows(view([
      mark({ markId: 'direction', kind: 'arrow', label: 'Direction of u × v', vector: [0, 0, 1] }),
      mark({ markId: 'edge', kind: 'segment', label: 'Edge', from: [0, 0, 0], to: [1, 1, 1] }),
      mark({ markId: 'step', kind: 'arrow', label: 'Step', at: [1, 0, 0], vector: [0, 2, 0] }),
      mark({ markId: 'tail', kind: 'arrow', label: 'Tail only', from: [1, 2, 3], vector: [1, 0, 0] }),
    ]), 'en');
    expect(rows.map(row => [row.label, row.cells[0]])).toEqual([
      ['Direction of u × v', '(0, 0, 1)'],
      ['Edge', '(0, 0, 0) → (1, 1, 1)'],
      ['Step: position', '(1, 0, 0)'], ['Step: components', '(0, 2, 0)'],
      ['Tail only: start', '(1, 2, 3)'], ['Tail only: components', '(1, 0, 0)'],
    ]);
    for (const row of rows) expect(row.label).not.toMatch(/\((at|from|to|vector)\)$/);
  });

  it('lists a point positioned by its one-point geometry once, and the points of a set by their order, not their IDs', () => {
    const rows = coordinateRows(view([
      mark({ markId: 'point', kind: 'point', label: 'Point on the surface', at: [1, 1, 2], value: { text: 'f = 2' } as ProjectedMark['value'], geometry: { kind: 'points3', points: [{ id: 'p', at: [1, 1, 2] }] } }),
      mark({ markId: 'cloud', kind: 'points', label: 'Samples', geometry: { kind: 'points3', points: [{ id: 'k17', at: [0, 0, 0] }, { id: 'k18', at: [1, 0, 0] }] } }),
    ]), 'en');
    expect(rows.map(row => [row.label, ...row.cells])).toEqual([
      ['Point on the surface', '(1, 1, 2)', 'f = 2'],
      ['Samples, point 1', '(0, 0, 0)', ''], ['Samples, point 2', '(1, 0, 0)', ''],
    ]);
  });
});

describe('coordinate table cells without a value (R24)', () => {
  it('say beyond the numerical range for a reason the projection lists as a numerical limit, and undefined otherwise', () => {
    const underflow = 'The height cannot be drawn: f(p) is smaller than the smallest representable number.';
    const rows = coordinateRows(view([
      mark({ markId: 'point', kind: 'point', label: 'Point', at: null, undefinedReason: underflow, limitReasons: [underflow], geometry: { kind: 'points3', points: [{ id: 'p', at: null, reason: underflow }] } }),
      mark({ markId: 'big', kind: 'arrow', label: 'Big arrow', vector: null, undefinedReason: 'The length overflows.', limitReasons: ['The length overflows.'] }),
      mark({ markId: 'direction', kind: 'arrow', label: 'Direction', vector: null, undefinedReason: 'u × v = 0 has no direction.' }),
    ]), 'en');
    expect(rows.map(row => row.cells[0])).toEqual([
      'Beyond numerical range (The height cannot be drawn: f(p) is smaller than the smallest representable number)',
      'Beyond numerical range (The length overflows)',
      'Undefined: u × v = 0 has no direction.',
    ]);
  });
});
