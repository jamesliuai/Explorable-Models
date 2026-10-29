/**
 * Spatial scene planning (report §8.5, §10.2, §13): what is drawn for each kind of projected geometry, and the notes
 * that explain what is not drawn. The planner places supplied values only; it never computes model quantities.
 */
import { describe, expect, it } from 'vitest';
import { viewFrame } from '../../packages/player-3d/src/frame';
import { isDirected, namesSegments, planSpatialScene } from '../../packages/player-3d/src/plan';
import type { SpatialMark } from '../../packages/player-3d/src/types';
import { field, style, surface, vectors, view } from './support';

const plan = (marks: SpatialMark[], patch = {}) => { const v = view(marks, patch); return planSpatialScene(v, viewFrame(v)); };

describe('directed marks', () => {
  it('draws each nonzero directed segment as an arrow and labels multi-segment tips with their IDs', () => {
    const result = plan([vectors([{ id: 'u', to: [2, 1, 0] }, { id: 'v', to: [1, 2, 2] }])]);
    expect(result.arrows.map(arrow => [arrow.segmentId, arrow.tail, arrow.tip])).toEqual([['u', [0, 0, 0], [2, 1, 0]], ['v', [0, 0, 0], [1, 2, 2]]]);
    expect(result.labels.filter(label => label.kind === 'segment').map(label => [label.text, label.at])).toEqual([['u', [2, 1, 0]], ['v', [1, 2, 2]]]);
    expect(result.points).toHaveLength(0);
  });
  it('a zero-length vector is a dot with a note and never gets an arrowhead', () => {
    const result = plan([vectors([{ id: 'u', to: [0, 0, 0] }, { id: 'v', to: [1, 2, 2] }])]);
    expect(result.arrows.map(arrow => arrow.segmentId)).toEqual(['v']);
    expect(result.points).toEqual([expect.objectContaining({ glyph: 'circle', hollow: false, at: [0, 0, 0] })]);
    expect(result.notes).toContainEqual({ markId: 'vector-segments', kind: 'zero-vector', text: 'Vectors (u): zero vector (no direction), drawn as a dot without an arrowhead.' });
    // The drawing names this mark's segments, so the zero vector's dot carries its name too: the note's “u” is shown (R40).
    expect(result.labels.filter(label => label.kind === 'segment').map(label => [label.text, label.at])).toEqual([['u (zero vector)', [0, 0, 0]], ['v', [1, 2, 2]]]);
  });
  it('an arrow mark draws from the origin along its vector; an undefined vector draws nothing and states its reason', () => {
    const arrow = (vector: number[] | null, undefinedReason?: string): SpatialMark => ({ markId: 'cross-direction-arrow', kind: 'arrow', label: 'Direction of u × v', style: style({ role: 'accent', marker: 'diamond', dash: 'dotted' }), vector, ...(undefinedReason ? { undefinedReason } : {}) });
    expect(plan([arrow([0, 0, 1])]).arrows).toEqual([expect.objectContaining({ tail: [0, 0, 0], tip: [0, 0, 1] })]);
    const undefinedArrow = plan([arrow(null, 'u and v point in exactly the same direction, so u × v = 0 and has no direction; none is chosen arbitrarily.')]);
    expect(undefinedArrow.arrows).toEqual([]);
    expect(undefinedArrow.points).toEqual([]);
    expect(undefinedArrow.notes).toContainEqual({ markId: 'cross-direction-arrow', kind: 'undefined', text: 'Direction of u × v: undefined — u and v point in exactly the same direction, so u × v = 0 and has no direction; none is chosen arbitrarily. Nothing is drawn for it.' });
  });
  it('treats triangle-marked segment marks and arrow marks as directed, other segments as lines', () => {
    expect(isDirected({ kind: 'segments', style: style({ marker: 'triangle' }) })).toBe(true);
    expect(isDirected({ kind: 'arrow', style: style({ marker: 'diamond' }) })).toBe(true);
    expect(isDirected({ kind: 'segment', style: style({ marker: 'none' }) })).toBe(false);
    const lines = plan([{ markId: 'edge', kind: 'segment', label: 'Edge', style: style(), from: [0, 0, 0], to: [1, 1, 1] }, { markId: 'flat', kind: 'segment', label: 'Flat', style: style(), from: [1, 1, 1], to: [1, 1, 1] }]);
    expect(lines.lines.map(line => line.markId)).toEqual(['edge']);
    expect(lines.arrows).toEqual([]);
    expect(lines.notes).toContainEqual({ markId: 'flat', kind: 'degenerate', text: 'Flat: zero-length segment, drawn as a point.' });
  });
  it('mark text sits at the tip of a single directed segment', () => {
    const result = plan([{ markId: 'cross-segment', kind: 'segment', label: 'Cross', style: style({ marker: 'triangle', dash: 'dashed' }), text: 'u × v', geometry: { kind: 'segments3', segments: [{ id: 'cross', from: [0, 0, 0], to: [0, 0, 1] }] } }]);
    expect(result.labels.find(label => label.kind === 'mark')).toMatchObject({ text: 'u × v', at: [0, 0, 1] });
  });
});

describe('curves, surfaces and fields', () => {
  it('splits polylines at missing samples, never bridging them, and lists gap reasons', () => {
    const result = plan([{
      markId: 'arc', kind: 'curve', label: 'Arc', style: style({ dash: 'dotted' }),
      geometry: { kind: 'polyline3', segments: [{ start: 'none', end: 'none', points: [[0, 0, 0], [1, 0, 0], [NaN, 0, 0] as never, [2, 0, 0], [3, 0, 0]] }], gaps: [{ after: null, before: null, reason: 'The angle is undefined here.' }] },
    }]);
    expect(result.lines.map(line => line.points)).toEqual([[[0, 0, 0], [1, 0, 0]], [[2, 0, 0], [3, 0, 0]]]);
    expect(result.notes).toContainEqual({ markId: 'arc', kind: 'gap', text: 'Arc has a gap that is not joined: The angle is undefined here.' });
  });
  it('meshes a sampled surface with holes at undefined samples and discloses the sampling grid', () => {
    const result = plan([surface(5, 4, (x, y) => (x === 0 && y > 0 ? null : x + y))], { bounds3: [-2, 2, -2, 2, -4, 4] });
    const [mesh] = result.surfaces;
    // 20 samples, one undefined (x = 0, y = 2/3 and y = 2 → two undefined samples).
    expect(mesh!.vertices).toHaveLength(18);
    expect(mesh!.holes).toBe(4);
    expect(mesh!.triangles).toHaveLength((4 * 3 - 4) * 6);
    expect(mesh!.triangles.every(index => index >= 0 && index < 18)).toBe(true);
    expect(result.notes).toContainEqual(expect.objectContaining({ kind: 'sampling', text: 'Surface: sampled on a 5 × 4 grid over x from −2 to 2 and y from −2 to 2; between samples it is drawn flat, so features smaller than the grid spacing are not shown.' }));
    // A surface sample carries no reason: a missing one is not called undefined (it may be a numerical limit; R24).
    expect(result.notes).toContainEqual(expect.objectContaining({ kind: 'holes', text: 'Surface: 2 samples have no value; the 4 grid cells touching them are left as holes.' }));
    expect(result.notes.some(note => /undefined/.test(note.text))).toBe(false);
  });
  it('draws field arrows at the declared scale and always discloses it; zero vectors are dots', () => {
    const result = plan([field(12, 0.5)]);
    const [planned] = result.fields;
    expect(planned!.arrows).toHaveLength(12);
    expect(planned!.arrows[1]).toEqual({ at: [-4, -5, 0], tip: [-3.5, -4.5, 0] });
    expect(result.notes).toContainEqual({ markId: 'field-arrows', kind: 'scale', text: 'Field: arrows drawn at 0.5× length. Arrow lengths are scaled by 0.5 for legibility; directions are exact.' });
    const zero = plan([{ ...field(1), geometry: { kind: 'vector-field3', samples: [{ at: [1, 1, 0], vector: [0, 0, 0] }], scale: { factor: 1, disclosure: 'Scale 1.' } } }]);
    expect(zero.fields[0]!.zero).toEqual([[1, 1, 0]]);
    expect(zero.notes.some(note => note.kind === 'zero-vector')).toBe(true);
  });
  it('places 2D geometry in the z = 0 plane of a 3D view', () => {
    const result = plan([{ markId: 'flat-field', kind: 'vector-field', label: 'Flat field', style: style(), geometry: { kind: 'vector-field2', samples: [{ at: [1, 2], vector: [1, 0] }], scale: { factor: 2, disclosure: 'Doubled.' } } }]);
    expect(result.fields[0]!.arrows).toEqual([{ at: [1, 2, 0], tip: [3, 2, 0] }]);
  });
  it('reports undefined points with their reasons instead of drawing them at zero', () => {
    const result = plan([{ markId: 'point-on-surface', kind: 'point', label: 'Point', style: style({ marker: 'circle' }), geometry: { kind: 'points3', points: [{ id: 'p', at: null, reason: 'The height cannot be drawn.' }] } }]);
    expect(result.points).toEqual([]);
    expect(result.notes).toContainEqual({ markId: 'point-on-surface', kind: 'undefined', text: 'Point: 1 point is undefined — The height cannot be drawn. It is not drawn.' });
  });
  it('words a gap the projection lists as a numerical limit as beyond the representable range, never as undefined (R24, §8.2, A11)', () => {
    const underflow = 'The height cannot be drawn: f(p) is positive but smaller than the smallest representable number; it is not exactly 0.';
    const point = plan([{ markId: 'point-on-surface', kind: 'point', label: 'Point', style: style({ marker: 'circle' }), limitReasons: [underflow], geometry: { kind: 'points3', points: [{ id: 'p', at: null, reason: underflow }] } }]);
    expect(point.points).toEqual([]);
    expect(point.notes).toEqual([{ markId: 'point-on-surface', kind: 'numerical-limit', text: `Point: 1 point is beyond the representable range — ${underflow.replace(/\.$/, '')}. It is not drawn.` }]);
    // Both causes in one mark stay distinguishable: one note per cause.
    const mixed = plan([{ markId: 'cloud', kind: 'points', label: 'Cloud', style: style(), limitReasons: ['Overflow from n = 3.'], geometry: { kind: 'points3', points: [
      { id: 'a', at: [1, 1, 1] }, { id: 'b', at: null, reason: 'Overflow from n = 3.' }, { id: 'c', at: null, reason: 'Overflow from n = 3.' }, { id: 'd', at: null, reason: 'Not defined at x = 0.' },
    ] } }]);
    expect(mixed.notes.map(note => [note.kind, note.text])).toEqual([
      ['undefined', 'Cloud: 1 point is undefined — Not defined at x = 0. It is not drawn.'],
      ['numerical-limit', 'Cloud: 2 points are beyond the representable range — Overflow from n = 3. They are not drawn.'],
    ]);
    // A positioned mark whose coordinates are a numerical limit.
    const arrow = plan([{ markId: 'arrow', kind: 'arrow', label: 'Arrow', style: style({ marker: 'triangle' }), vector: null, undefinedReason: 'The length exceeds the largest representable number.', limitReasons: ['The length exceeds the largest representable number.'] }]);
    expect(arrow.notes).toEqual([{ markId: 'arrow', kind: 'numerical-limit', text: 'Arrow: beyond the representable range — The length exceeds the largest representable number. Nothing is drawn for it.' }]);
    // Without the projection's classification a gap stays undefined (the default of the gap's class).
    expect(plan([{ markId: 'arrow', kind: 'arrow', label: 'Arrow', style: style({ marker: 'triangle' }), vector: null, undefinedReason: 'No direction.' }]).notes[0]).toMatchObject({ kind: 'undefined', text: 'Arrow: undefined — No direction. Nothing is drawn for it.' });
  });
  it('names a segment in its notes only where the drawing shows its ID: never a single-segment segment mark or undirected segments (R40)', () => {
    const single = plan([{ markId: 'cross-segment', kind: 'segment', label: 'Cross product u × v', style: style({ marker: 'triangle' }), geometry: { kind: 'segments3', segments: [{ id: 'cross', from: [0, 0, 0], to: [0, 0, 0] }] } }]);
    expect(single.notes).toContainEqual({ markId: 'cross-segment', kind: 'zero-vector', text: 'Cross product u × v: zero vector (no direction), drawn as a dot without an arrowhead.' });
    expect(single.labels.filter(label => label.kind === 'segment').map(label => label.text)).toEqual(['zero vector']);
    const flat = plan([{ markId: 'edge', kind: 'segment', label: 'Edge', style: style(), geometry: { kind: 'segments3', segments: [{ id: 'e1', from: [1, 1, 1], to: [1, 1, 1] }] } }]);
    expect(flat.notes).toContainEqual({ markId: 'edge', kind: 'degenerate', text: 'Edge: zero-length segment, drawn as a point.' });
    // Undirected segments are never named in the drawing (no tip, no ID label), so their notes count them, never name them.
    const several = plan([{ markId: 'edges', kind: 'segment', label: 'Edges', style: style(), geometry: { kind: 'segments3', segments: [{ id: 'e1', from: [1, 1, 1], to: [1, 1, 1] }, { id: 'e2', from: [0, 0, 0], to: [1, 0, 0] }] } }]);
    expect(several.labels.filter(label => label.kind === 'segment')).toEqual([]);
    expect(several.notes).toEqual([{ markId: 'edges', kind: 'degenerate', text: 'Edges: 1 of its 2 segments has zero length and is drawn as a point.' }]);
    const undirectedSet = plan([{ markId: 'edges', kind: 'segments', label: 'Edges', style: style(), geometry: { kind: 'segments3', segments: [{ id: 'e1', from: [1, 1, 1], to: [1, 1, 1] }, { id: 'e2', from: [0, 0, 0], to: [0, 0, 0] }, { id: 'e3', from: [0, 0, 0], to: [1, 0, 0] }] } }]);
    expect(undirectedSet.notes).toEqual([{ markId: 'edges', kind: 'degenerate', text: 'Edges: 2 of its 3 segments have zero length and are drawn as points.' }]);
    expect(undirectedSet.points.map(point => point.hollow)).toEqual([true, true]);
    expect(plan([{ markId: 'tiny', kind: 'segment', label: 'Tiny', style: style({ marker: 'triangle' }), geometry: { kind: 'segments3', segments: [{ id: 'gradient', from: [0, 0, 0], to: [1e-9, 0, 0] }] } }]).notes)
      .toContainEqual({ markId: 'tiny', kind: 'short-vector', text: 'Tiny: nonzero vector, too short to draw at this scale; drawn as a hollow dot. The table lists its value.' });
  });
  it('every segment ID a note uses is shown in the drawing, for every kind, direction, count and length of segment (R40, §10.4)', () => {
    const shown = (result: ReturnType<typeof plan>) => new Set(result.labels.filter(label => label.kind === 'segment').map(label => label.text.replace(/ \(zero vector\)$/, '')));
    for (const kind of ['segment', 'segments'] as const) for (const marker of ['triangle', 'none'] as const) for (const count of [1, 2, 3]) for (const zero of [false, true]) {
      const segments = Array.from({ length: count }, (_, i) => ({ id: `id${i}`, from: [0, 0, 0] as [number, number, number], to: (zero && i === 0 ? [0, 0, 0] : [i + 1, 1, 0]) as [number, number, number] }));
      const result = plan([{ markId: 'm', kind, label: 'Mark', style: style({ marker }), geometry: { kind: 'segments3', segments } }]);
      const case_ = `${kind} ${marker} ×${count}${zero ? ' with a zero one' : ''}`;
      const named = marker === 'triangle' && (kind === 'segments' || count > 1);
      expect(namesSegments({ kind, style: style({ marker }) }, count), case_).toBe(named);
      const ids = shown(result);
      for (const segment of segments) expect(ids.has(segment.id), `${case_}: ${segment.id} shown`).toBe(named);
      for (const note of result.notes) for (const segment of segments) if (note.text.includes(segment.id)) expect(ids.has(segment.id), `${case_}: ${note.text}`).toBe(true);
    }
  });
  it('notes drawing outside the authored box without rescaling the view', () => {
    const result = plan([vectors([{ id: 'cross', to: [0, 0, 18] }])]);
    expect(result.arrows).toHaveLength(1);
    expect(result.outside).toBe(1);
    expect(result.notes.some(note => note.kind === 'outside')).toBe(true);
  });
  it('marks the selected mark for emphasis', () => {
    const v = view([vectors([{ id: 'u', to: [1, 0, 0] }])]);
    expect(planSpatialScene(v, viewFrame(v), { selection: 'vector-segments' }).arrows[0]!.style.selected).toBe(true);
    expect(planSpatialScene(v, viewFrame(v)).arrows[0]!.style.selected).toBe(false);
  });
});

describe('frame and axes', () => {
  it('labels the axes at their positive ends and ticks in canonical units, skipping the crossing point', () => {
    const result = plan([], { bounds3: [-2.5, 2.5, -2.5, 2.5, 0, 24], equalAspect: false, axes: { x: { label: 'x', unitLabel: '' }, y: { label: 'y', unitLabel: '' }, z: { label: 'f(x, y)', unitLabel: '' } } });
    const axis = result.labels.filter(label => label.kind === 'axis').map(label => label.text);
    expect(axis).toEqual(['x', 'y', 'f(x, y)']);
    const ticks = result.labels.filter(label => label.kind === 'tick').map(label => label.text);
    expect(ticks).toEqual(['−2', '2', '−2', '2', '10', '20']);
    expect(result.notes).toContainEqual({ markId: null, kind: 'aspect', text: 'The vertical axis f(x, y) is drawn at its own scale: one unit along it is drawn 0.16 times as long as one unit along x and y.' });
  });
  it('falls back to the data extent when a view has no valid authored box', () => {
    const frame = viewFrame(view([vectors([{ id: 'u', to: [3, 1, 2] }])], { bounds3: [1, 0, 0, 1, 0, 1] }));
    expect(frame.boundsSource).toBe('data');
    expect(frame.bounds).toEqual([0, 3, 0, 1, 0, 2]);
  });
});
