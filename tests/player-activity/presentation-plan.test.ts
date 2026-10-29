/**
 * Plan and fallback-table rules of the 2D learner surface (report §10.2, §11, §13; gaps G57, G54): bar widths come from
 * the spacing of the bars, bounded regions are filled and closed, a directed segment collapsed only by a coordinate
 * projection is not called a zero vector, and the coordinate table of a 3D view's 2D fallback says what it does not
 * list in full. Pure planning and table functions; no DOM.
 */
import { describe, expect, it } from 'vitest';
import type { ProjectedMark, ProjectedView } from '../../packages/activity/src/api';
import { BAR_WIDTH, barWidthPx, comparisonGlyph, comparisonMarks, mergeCoincidentLabels, planScene, ZERO_VECTOR_LABEL } from '../../packages/player/src/activity/plan';
import { COORDINATE_ROW_LIMIT, coordinateTable, projectView, spatialEquivalence } from '../../packages/player/src/activity/project3d';
import { fitFrame } from '../../packages/player/src/activity/scale';

const style = { role: 'primary' as const, dash: 'solid' as const, marker: 'circle' as const, weight: 'regular' as const };
const mark = (extra: Partial<ProjectedMark> & Pick<ProjectedMark, 'markId' | 'kind'>): ProjectedMark => ({ label: extra.markId, style, interactive: false, ...extra });
const bars = (xs: number[], ys: number[]): ProjectedMark => mark({ markId: 'bars', kind: 'bar', geometry: { kind: 'points2', points: xs.map((x, i) => ({ id: `b${i}`, at: [x, ys[i]!] })) } });
const barShapes = (plan: ReturnType<typeof planScene>) => plan.marks[0]!.primitives.map(primitive => primitive.shape).filter((shape): shape is Extract<typeof shape, { type: 'bar' }> => shape.type === 'bar');

describe('bar marks (G57)', () => {
  it('sizes bars from the smallest spacing between them, so bars at 0.1 never overlap and bars at 10 are not hairlines', () => {
    const fine = fitFrame([0, 1, 0, 10], { x: 0, y: 0, width: 400, height: 200 }, false); // 400 px per unit
    const tight = barShapes(planScene({ marks: [bars([0.1, 0.2, 0.3, 0.4], [1, 2, 3, 4])] }, fine));
    expect(tight).toHaveLength(4);
    // 0.1 apart = 40 px; width = 0.7 · 40 = 28 px (the cap), and neighbours do not overlap.
    for (let i = 1; i < tight.length; i++) expect(tight[i]!.x - (tight[i - 1]!.x + tight[i - 1]!.width)).toBeGreaterThanOrEqual(0);
    const dense = fitFrame([0, 1, 0, 10], { x: 0, y: 0, width: 100, height: 200 }, false); // 100 px per unit → 10 px apart
    const narrow = barShapes(planScene({ marks: [bars([0.1, 0.2, 0.3], [1, 2, 3])] }, dense));
    expect(narrow[0]!.width).toBeCloseTo(7, 5);
    for (let i = 1; i < narrow.length; i++) expect(narrow[i]!.x).toBeGreaterThan(narrow[i - 1]!.x + narrow[i - 1]!.width);
    // Bars 10 units apart on a 4 px/unit axis are 40 px apart: 28 px wide, not the 4 px “one data unit” width.
    const wide = fitFrame([0, 100, 0, 10], { x: 0, y: 0, width: 400, height: 200 }, false);
    expect(barShapes(planScene({ marks: [bars([10, 20, 30], [1, 2, 3])] }, wide)).map(shape => shape.width)).toEqual([28, 28, 28]);
    expect(barWidthPx([10, 20, 30], 4)).toBe(28);
    expect(barWidthPx([0, 1.5, 0.5], 10)).toBe(BAR_WIDTH.fill * 0.5 * 10);
    expect(barWidthPx([3], 10)).toBe(BAR_WIDTH.single);
    expect(barWidthPx([0, 0.0001], 10)).toBe(BAR_WIDTH.min);
  });

  it('draws negative values downward from zero and clips a bar whose zero baseline is outside the view', () => {
    const frame = fitFrame([0, 4, -5, 5], { x: 0, y: 0, width: 400, height: 200 }, false);
    const [up, down] = barShapes(planScene({ marks: [bars([1, 2], [3, -2])] }, frame));
    const zero = frame.toScreen(0, 0)[1];
    expect(up!.y + up!.height).toBeCloseTo(zero, 0);
    expect(down!.y).toBeCloseTo(zero, 0);
    expect(down!.height).toBeCloseTo(frame.toScreen(0, 0)[1] - frame.toScreen(0, 2)[1], 0);
    // The view shows y from 10 to 20: the baseline y = 0 is below it; the bar is drawn from the clip box edge, not from y = 0
    // in pixel space far outside, and its top is the value.
    const high = fitFrame([0, 4, 10, 20], { x: 0, y: 0, width: 400, height: 200 }, false);
    const plan = planScene({ marks: [bars([1, 2], [15, 18])] }, high);
    const [first] = barShapes(plan);
    expect(first!.y).toBeCloseTo(high.toScreen(0, 15)[1], 0);
    expect(first!.y + first!.height).toBeLessThanOrEqual(high.toScreen(0, 0)[1] + 1);
    expect(Number.isFinite(first!.height)).toBe(true);
    expect(plan.clipped).toEqual([]);
  });
});

describe('bounded regions (G57)', () => {
  const frame = fitFrame([-5, 5, -5, 5], { x: 0, y: 0, width: 300, height: 300 }, true);
  it('fills a region from a closed polyline and from a polygon, and keeps gaps as separate filled pieces', () => {
    const region = planScene({ marks: [mark({ markId: 'r', kind: 'region', geometry: { kind: 'polyline2', segments: [{ points: [[0, 0], [2, 0], [2, 2], [0, 2]], start: 'none', end: 'none' }], gaps: [] } })] }, frame);
    const [shape] = region.marks[0]!.primitives.map(primitive => primitive.shape);
    expect(shape).toMatchObject({ type: 'path', fill: true });
    if (shape?.type === 'path') expect(shape.d.match(/L/g)!.length).toBe(4); // closed: back to the first vertex
    const polygon = planScene({ marks: [mark({ markId: 'p', kind: 'region', geometry: { kind: 'polygon2', vertices: [[0, 0], [3, 0], [0, 3]], degenerate: false } })] }, frame);
    expect(polygon.marks[0]!.primitives[0]!.shape).toMatchObject({ type: 'path', fill: true, d: expect.stringMatching(/Z$/) });
    const split = planScene({ marks: [mark({ markId: 's', kind: 'region', geometry: { kind: 'polyline2', segments: [
      { points: [[-4, -4], [-2, -4], [-2, -2]], start: 'none', end: 'none' }, { points: [[1, 1], [3, 1], [3, 3]], start: 'none', end: 'none' },
    ], gaps: [{ after: 0, before: 1, reason: 'Not defined between the pieces.' }] } })] }, frame);
    expect(split.marks[0]!.primitives.filter(primitive => primitive.shape.type === 'path')).toHaveLength(2);
    expect(split.notes.map(note => note.kind)).toEqual(['gap']);
  });
});

describe('directed segments collapsed by a coordinate projection (G57, A34)', () => {
  const view: ProjectedView = {
    viewId: 'space', kind: 'scene3d', title: 'Space', description: '', visibility: 'fixed', bounds3: [-3, 3, -3, 3, -3, 3], equalAspect: true,
    marks: [{
      markId: 'uv', kind: 'segments', label: 'Vectors u and v', style: { ...style, marker: 'triangle' }, interactive: false,
      geometry: { kind: 'segments3', segments: [{ id: 'u', from: [0, 0, 0], to: [0, 0, 2] }, { id: 'zero', from: [1, 1, 1], to: [1, 1, 1] }] },
    }],
    values: [], equations: [], summary: '',
  };
  it('draws a vector along the hidden axis as a hollow dot with an end-on note, and a true zero vector with the zero-vector rule', () => {
    const projected = projectView(view, 'xy');
    const plan = planScene(projected, fitFrame([-3, 3, -3, 3], { x: 0, y: 0, width: 300, height: 300 }, true));
    const shapes = plan.marks[0]!.primitives.map(primitive => primitive.shape);
    expect(shapes).toMatchObject([{ type: 'marker', hollow: true }, { type: 'marker', hollow: false }]);
    expect(plan.notes.map(note => note.kind).sort()).toEqual(['end-on', 'zero-vector']);
    expect(plan.notes.find(note => note.kind === 'end-on')!.text).toMatch(/one segment points straight along the axis this projection leaves out.*not a zero vector/);
    // On the x–z plane u is an ordinary arrow; only the true zero vector is a dot.
    const xz = planScene(projectView(view, 'xz'), fitFrame([-3, 3, -3, 3], { x: 0, y: 0, width: 300, height: 300 }, true));
    expect(xz.marks[0]!.primitives.map(primitive => primitive.shape.type)).toEqual(['arrow', 'marker']);
    expect(xz.notes.map(note => note.kind)).toEqual(['zero-vector']);
    expect(xz.labels.map(label => label.text)).not.toContain(ZERO_VECTOR_LABEL); // two segments: aggregated note, segment labels
  });
});

describe('positioned arrows seen end-on in a coordinate projection (A34, A44; F4)', () => {
  const frame = fitFrame([-3, 3, -3, 3], { x: 0, y: 0, width: 300, height: 300 }, true);
  const space = (marks: ProjectedMark[]): ProjectedView => ({ viewId: 'space', kind: 'scene3d', title: 'Space', description: '', visibility: 'fixed', bounds3: [-3, 3, -3, 3, -3, 3], equalAspect: true, marks, values: [], equations: [], summary: '' });
  const arrowMark = (markId: string, label: string, extra: Partial<ProjectedMark>): ProjectedMark => mark({ markId, kind: 'arrow', label, style: { ...style, marker: 'diamond' }, ...extra });

  it('a nonzero arrow along the hidden axis says where it points and its true length, never “zero vector”', () => {
    const view = space([
      arrowMark('dir', 'Direction of u × v', { vector: [0, 0, 1] }),
      arrowMark('down', 'Offset', { from: [1, 1, 2], to: [1, 1, -0.5] }),
    ]);
    const plan = planScene(projectView(view, 'xy'), frame);
    expect(plan.notes.map(note => note.kind)).toEqual(['end-on', 'end-on']);
    expect(plan.notes[0]!.text).toBe('Direction of u × v: points along +z (length 1), straight along the axis this projection leaves out, so it is seen end-on and drawn as a hollow dot here (not a zero vector); the coordinate table lists its components.');
    expect(plan.notes[1]!.text).toMatch(/^Offset: points along −z \(length 2\.5\)/);
    expect(plan.notes.map(note => note.text).join(' ')).not.toMatch(/zero vector \(no direction\)/);
    expect(plan.labels.map(label => label.text)).toEqual(['points along +z, seen end-on', 'points along −z, seen end-on']);
    expect(plan.labels.map(label => label.text)).not.toContain(ZERO_VECTOR_LABEL);
    expect(plan.marks.map(item => item.primitives.map(primitive => primitive.shape))).toMatchObject([[{ type: 'marker', hollow: true }], [{ type: 'marker', hollow: true }]]);
    // On a plane that shows its axis the same arrow is an ordinary arrow.
    const xz = planScene(projectView(view, 'xz'), frame);
    expect(xz.notes).toEqual([]);
    expect(xz.marks[0]!.primitives.map(primitive => primitive.shape.type)).toEqual(['arrow']);
  });

  it('a true zero vector stays a zero vector on every plane', () => {
    const view = space([arrowMark('zero', 'Cross product', { vector: [0, 0, 0] }), arrowMark('point', 'Displacement', { from: [1, 2, 3], to: [1, 2, 3] })]);
    for (const plane of ['xy', 'xz', 'yz'] as const) {
      const plan = planScene(projectView(view, plane), frame);
      expect(plan.notes.map(note => note.kind), plane).toEqual(['zero-vector', 'zero-vector']);
      expect(plan.notes[0]!.text).toBe('Cross product: zero vector (no direction), drawn as a dot.');
      expect(plan.labels.map(label => label.text), plane).toEqual([ZERO_VECTOR_LABEL, ZERO_VECTOR_LABEL]);
    }
  });

  it('merges an end-on descriptor after the names of coincident labels', () => {
    const at: [number, number] = [50, 50];
    expect(mergeCoincidentLabels([
      { id: 'n', markId: 'cross', text: 'u × v', at, data: [0, 0] }, { id: 'd', markId: 'dir', text: 'points along +z, seen end-on', at, data: [0, 0] },
    ]).map(label => label.text)).toEqual(['u × v (points along +z, seen end-on)']);
  });
});

describe('coordinate table of the 2D fallback (G54)', () => {
  const points = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `p${i}`, at: [i, i / 2, -i] as [number, number, number] }));
  const view = (marks: ProjectedMark[]): ProjectedView => ({ viewId: 'v', kind: 'scene3d', title: 'View', description: '', visibility: 'fixed', bounds3: [-1, 1, -1, 1, -1, 1], equalAspect: true, marks, values: [], equations: [], summary: '' });

  it('states how many points it shows when a point set is longer than the row limit', () => {
    const table = coordinateTable(view([mark({ markId: 'cloud', kind: 'points', label: 'Sample points', geometry: { kind: 'points3', points: points(81) } })]), 'en');
    expect(table.rows).toHaveLength(COORDINATE_ROW_LIMIT);
    expect(table.notes).toEqual([`Sample points: showing ${COORDINATE_ROW_LIMIT} of 81 points.`]);
    expect(table.complete).toBe(false);
    const short = coordinateTable(view([mark({ markId: 'cloud', kind: 'points', label: 'Sample points', geometry: { kind: 'points3', points: points(12) } })]), 'en');
    expect(short).toMatchObject({ notes: [], complete: true });
    expect(short.rows).toHaveLength(12);
  });

  it('lists segments with their ends and summarises curves, surfaces and fields instead of omitting them silently', () => {
    const table = coordinateTable(view([
      // Directed (vectors), so the 3D view names the segment u at its tip and the table may too (R40).
      mark({ markId: 'seg', kind: 'segments', label: 'Vectors', style: { ...style, marker: 'triangle' }, geometry: { kind: 'segments3', segments: [{ id: 'u', from: [0, 0, 0], to: [1, -2, 3] }] } }),
      mark({ markId: 'curve', kind: 'curve', label: 'Cross-section', geometry: { kind: 'polyline3', segments: [{ points: [[0, 0, 0], [1, 1, 1], [2, 4, 8]], start: 'none', end: 'none' }], gaps: [] } }),
      mark({ markId: 'surf', kind: 'surface', label: 'Surface f(x, y)', geometry: { kind: 'surface-grid', xs: [-1, 0, 1], ys: [-1, 1], z: [1, 0, 1, null, 0, 1], sampling: { nx: 3, ny: 2, domain: [-1, 1, -1, 1] } } }),
      mark({ markId: 'field', kind: 'vector-field', label: 'Gradient field', geometry: { kind: 'vector-field3', samples: [{ at: [0, 0, 0], vector: [1, 0, 0] }, { at: [1, 0, 0], vector: [0, 1, 0] }], scale: { factor: 0.5, disclosure: 'Half length.' } } }),
    ]), 'en');
    expect(table.rows[0]).toEqual({ key: 'seg:u', label: 'Vectors: u', cells: ['(0, 0, 0) → (1, −2, 3)', ''] });
    expect(table.rows.map(row => row.cells[0])).toEqual([
      '(0, 0, 0) → (1, −2, 3)', 'A curve through 3 sampled points (not listed here)',
      'A surface sampled on a 3 × 2 grid for x from −1 to 1 and y from −1 to 1 (heights not listed here)', '2 arrows sampled on a grid (not listed here)',
    ]);
    expect(table.notes).toEqual([
      'Cross-section: a curve of 3 sampled points is summarised, not listed point by point.',
      'Surface f(x, y): a sampled surface (5 of 6 heights defined) is summarised, not listed point by point.',
      'Gradient field: a field of 2 arrows is summarised, not listed arrow by arrow.',
    ]);
    expect(table.complete).toBe(false);
  });

  it('never writes a non-finite coordinate as 0', () => {
    const table = coordinateTable(view([mark({ markId: 'a', kind: 'point', label: 'A', at: [Number.NaN, Infinity, 1] })]), 'en');
    expect(table.rows[0]!.cells[0]).toBe('(undefined, ∞, 1)');
  });

  it('words the equivalence by what the table holds (one text for the surface fallback and the renderer\'s lost/failed states; S2)', () => {
    const complete = coordinateTable(view([mark({ markId: 'seg', kind: 'segments', label: 'Vectors', geometry: { kind: 'segments3', segments: [{ id: 'u', from: [0, 0, 0], to: [1, 2, 3] }] } })]), 'en');
    expect(spatialEquivalence(complete, ['Vector table'])).toBe('The 2D projection and the coordinate table below show the same values as the 3D view.');
    const summarised = coordinateTable(view([mark({ markId: 'surf', kind: 'surface', label: 'Surface', geometry: { kind: 'surface-grid', xs: [0, 1], ys: [0, 1], z: [0, 1, 1, 2], sampling: { nx: 2, ny: 2, domain: [0, 1, 0, 1] } } })]), 'en');
    expect(spatialEquivalence(summarised, [])).toBe('The 2D projection shows the same drawing seen along one axis; the coordinate table below lists the positioned items and summarises the rest.');
    expect(spatialEquivalence(summarised, ['Surface table'])).toBe('The 2D projection shows the same drawing seen along one axis; the coordinate table below lists the positioned items and summarises the rest (the table “Surface table” lists values in full).');
    expect(spatialEquivalence(summarised, ['A', 'B'])).toContain('(the tables “A”, “B” list values in full)');
    expect(spatialEquivalence(summarised, ['A'])).not.toContain('show the same values');
  });
});

describe('kept-run overlays (G44)', () => {
  it('draw a kept run muted, dashed, with its own hollow marker shape and nothing interactive or labelled', () => {
    const marks = comparisonMarks([mark({ markId: 'trace', kind: 'points', text: 'xₙ', interactive: true, draggable: { x: { parameter: 'eta', min: 0, max: 2 } }, geometry: { kind: 'points2', points: [{ id: 'n0', at: [0, 4] }] } })], 2);
    expect(marks[0]).toMatchObject({ markId: 'kept2:trace', interactive: false, text: undefined, draggable: undefined, style: { role: 'muted', dash: 'dashed', marker: 'square' } });
    expect([1, 2, 3, 4, 5, 6].map(comparisonGlyph)).toEqual(['circle', 'square', 'triangle', 'diamond', 'cross', 'circle']);
  });
});
