import { describe, expect, it } from 'vitest';
import type { ProjectedMark, ProjectedView } from '../../packages/activity/src/api';
import { anchoredBox, LABEL_MAX_LINES, labelMetrics, layoutLabelKey, layoutLegend, placeLabels, wrapText, type LabelRequest } from '../../packages/player/src/activity/labels';
import { arrowEnds, markerPath, planScene, polylinePath, SHORT_VECTOR_LABEL, ZERO_VECTOR_LABEL } from '../../packages/player/src/activity/plan';
import { fitFrame } from '../../packages/player/src/activity/scale';
import { coordinateRows, projectView } from '../../packages/player/src/activity/project3d';

const metrics = labelMetrics(12);
const style = { role: 'primary' as const, dash: 'solid' as const, marker: 'circle' as const, weight: 'regular' as const };
const mark = (extra: Partial<ProjectedMark> & Pick<ProjectedMark, 'markId' | 'kind'>): ProjectedMark => ({ label: extra.markId, style, interactive: false, ...extra });
const frame = fitFrame([-10, 10, -10, 10], { x: 40, y: 10, width: 400, height: 400 }, true);
const plan = (marks: ProjectedMark[]) => planScene({ marks }, frame);
const shapes = (p: ReturnType<typeof plan>, markId: string) => p.marks.find(m => m.markId === markId)!.primitives.map(primitive => primitive.shape);

describe('label placement (report §10.2: anchors, offsets, wrapping, leaders, collision diagnostics)', () => {
  it('wraps words to the maximum width and splits words longer than a line', () => {
    expect(wrapText('area = |det M| = 0', 9 * 12, 12 * 0.58)).toEqual(['area = |det M|', '= 0']);
    expect(wrapText('x'.repeat(40), 60, 6)).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(10), 'x'.repeat(10)]);
    expect(wrapText('a b c d e f g h i j k l', 24, 6, 2)).toHaveLength(2);
  });

  it('never cuts text where it must stay whole: legends and the label key wrap to as many lines as they need (S5, report §10.3)', () => {
    const long = 'Lines through the origin that M maps onto themselves, drawn dashed across the whole plane';
    const legend = layoutLegend([{ markId: 'm', label: long, kind: 'segment', style: { role: 'primary', dash: 'dashed', marker: 'none', weight: 'regular' } }], 240, labelMetrics(26));
    expect(legend.entries[0]!.lines.join(' ')).toBe(long);
    expect(legend.entries[0]!.lines.length).toBeGreaterThan(3);
    expect(legend.height).toBe(legend.entries[0]!.lines.length * labelMetrics(26).lineHeight + 4);
    expect(wrapText(long, 160, 10, Infinity).join(' ')).toBe(long);
    const key = layoutLabelKey([{ number: 1, labelId: 'a', markId: 'a', text: long }, { number: 2, labelId: 'b', markId: 'b', text: '54.5°' }], 200, metrics, 36);
    expect(key.entries.map(entry => entry.lines.join(' '))).toEqual([long, '54.5°']);
    expect(key.entries[1]!.y).toBe(key.entries[0]!.lines.length * metrics.lineHeight + 4);
  });

  it('draws a label with no free place as a numbered callout and lists its full text in the key; nothing overlaps (S5)', () => {
    // Four labels on almost the same point inside a small plot: the later ones cannot be placed clear of the earlier ones.
    const at: [number, number] = [60, 60];
    const requests: LabelRequest[] = ['area = |det M| = 0', 'det M = 0 (collapse)', 'zero vector', '54.5°'].map((text, i) => ({
      id: `l${i}`, markId: `m${i}`, text, at: [at[0] + i, at[1] + i], placement: { anchor: 'ne', offset: [4, -4], leader: false, maxWidthEm: 6 },
    }));
    const bounds = { x: 0, y: 0, width: 130, height: 110 };
    const plain = placeLabels(requests, { metrics, bounds });
    expect(plain.diagnostics.filter(d => d.code === 'LABEL_OVERLAP').length).toBeGreaterThan(0);
    expect(plain.callouts).toEqual([]);
    const handled = placeLabels(requests, { metrics, bounds, callouts: true });
    expect(handled).toEqual(placeLabels(requests, { metrics, bounds, callouts: true }));
    expect(handled.diagnostics.filter(d => d.code === 'LABEL_OVERLAP')).toEqual([]);
    expect(handled.callouts.length).toBeGreaterThan(0);
    // Numbered in input order; each tag shows its number and the key keeps the whole text.
    expect(handled.callouts.map(callout => callout.number)).toEqual(handled.callouts.map((_, i) => i + 1));
    for (const callout of handled.callouts) {
      const label = handled.labels.find(item => item.id === callout.labelId)!;
      expect(label).toMatchObject({ callout: callout.number, lines: [String(callout.number)] });
      expect(callout.text).toBe(requests.find(request => request.id === callout.labelId)!.text);
    }
    expect(handled.diagnostics.filter(d => d.code === 'LABEL_CALLOUT').map(d => d.labelId)).toEqual(handled.callouts.map(callout => callout.labelId));
    // No two placed boxes overlap.
    const boxes = handled.labels.map(label => label.box);
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!, b = boxes[j]!;
      expect(a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height, `${i}/${j}`).toBe(false);
    }
  });

  it('shows a label longer than the drawing allows as a callout instead of cutting it with an ellipsis (S5)', () => {
    const text = 'a very long annotation that cannot fit in four short lines next to its point in the plot';
    const placement = { anchor: 'ne' as const, offset: [4, -4] as [number, number], leader: false, maxWidthEm: 4 };
    expect(wrapText(text, 4 * metrics.fontPx, metrics.charWidth, Infinity).length).toBeGreaterThan(LABEL_MAX_LINES);
    const { labels, callouts } = placeLabels([{ id: 'x', markId: 'x', text, at: [100, 100], placement }], { metrics, bounds: { x: 0, y: 0, width: 400, height: 400 }, callouts: true });
    expect(callouts).toEqual([{ number: 1, labelId: 'x', markId: 'x', text }]);
    expect(labels[0]!.lines).toEqual(['1']);
    expect(labels[0]!.lines.join('')).not.toContain('…');
  });

  it('honours the authored anchor and offset when nothing collides', () => {
    const { labels, diagnostics } = placeLabels([{ id: 'a', markId: 'a', text: 'x₀', at: [100, 100], placement: { anchor: 'ne', offset: [6, -6], leader: false, maxWidthEm: 4 } }], { metrics, bounds: { x: 0, y: 0, width: 400, height: 400 } });
    expect(diagnostics).toEqual([]);
    expect(labels[0].anchor).toBe('ne');
    expect(labels[0].box.x).toBe(106);
    expect(labels[0].box.y + labels[0].box.height).toBe(94);
    expect(labels[0].nudged).toBe(false);
    expect(anchoredBox([0, 0], 'sw', [4, 4], 10, 5)).toEqual({ x: -14, y: 4, width: 10, height: 5 });
  });

  it('nudges a colliding label deterministically, draws a leader when moved far, and reports it', () => {
    const requests: LabelRequest[] = [
      { id: 'a', markId: 'a', text: 'det M = 0 (collapse)', at: [110, 528], placement: { anchor: 'ne', offset: [4, -4], leader: false, maxWidthEm: 9 } },
      { id: 'b', markId: 'b', text: 'area = |det M| = 0', at: [117, 521], placement: { anchor: 'ne', offset: [4, -4], leader: true, maxWidthEm: 9 } },
    ];
    const bounds = { x: 24, y: 23, width: 570, height: 560 };
    const first = placeLabels(requests, { metrics, bounds });
    const second = placeLabels(requests, { metrics, bounds });
    expect(second).toEqual(first);
    const [a, b] = first.labels;
    const overlap = a.box.x < b.box.x + b.box.width && b.box.x < a.box.x + a.box.width && a.box.y < b.box.y + b.box.height && b.box.y < a.box.y + a.box.height;
    expect(overlap).toBe(false);
    // The first label's authored box would cover the second labelled point, so it moves to another anchor at the same
    // distance (beside its own point: no leader); the second keeps its authored place and leader.
    expect(a).toMatchObject({ nudged: true, leader: null });
    expect(a.anchor).not.toBe('ne');
    expect(a.box.x < 117 + 3 && 117 - 3 < a.box.x + a.box.width && a.box.y < 521 + 3 && 521 - 3 < a.box.y + a.box.height).toBe(false);
    expect(b.nudged).toBe(false);
    expect(b.leader).not.toBeNull();
    expect(first.diagnostics.map(d => `${d.code} ${d.labelId}`)).toEqual(['LABEL_NUDGED a']);
  });

  it('keeps every labelled point and arrowhead of other marks uncovered, pushing crowded labels out with leaders', () => {
    const cluster: LabelRequest[] = [
      { id: 'e2', markId: 'e2', text: 'e₂, Me₁', at: [200, 173], markIds: ['e2', 'me1'], placement: { anchor: 'nw', offset: [4, -4], leader: false, maxWidthEm: 4 } },
      { id: 'u1', markId: 'u1', text: 'u₁', at: [219, 181], placement: { anchor: 'n', offset: [4, -4], leader: false, maxWidthEm: 4 } },
      { id: 'v', markId: 'v', text: 'v, Mv', at: [227, 173], markIds: ['v', 'mv'], placement: { anchor: 'e', offset: [4, -4], leader: false, maxWidthEm: 4 } },
      { id: 'e1', markId: 'e1', text: 'e₁, Me₂', at: [227, 200], markIds: ['e1', 'me2'], placement: { anchor: 'se', offset: [4, -4], leader: false, maxWidthEm: 4 } },
      { id: 'u2', markId: 'u2', text: 'u₂', at: [219, 219], placement: { anchor: 's', offset: [4, -4], leader: false, maxWidthEm: 4 } },
    ];
    // Arrowheads at each tip (the merged marks share theirs), as labelObstacles reports them.
    const heads = [['e2', 200, 173], ['me1', 200, 173], ['u1', 219, 181], ['v', 227, 173], ['mv', 227, 173], ['e1', 227, 200], ['me2', 227, 200], ['u2', 219, 219]]
      .map(([markId, x, y]) => ({ markId: markId as string, x: (x as number) - 6, y: (y as number) - 6, width: 12, height: 12 }));
    const bounds = { x: 40, y: 20, width: 330, height: 330 };
    const placed = placeLabels(cluster, { metrics, bounds, obstacles: heads });
    expect(placeLabels(cluster, { metrics, bounds, obstacles: heads })).toEqual(placed);
    expect(placed.diagnostics.filter(d => d.code === 'LABEL_OVERLAP')).toEqual([]);
    const hits = (a: { x: number; y: number; width: number; height: number }, b: typeof a) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    for (const label of placed.labels) {
      const request = cluster.find(item => item.id === label.id)!;
      const own = new Set(request.markIds ?? [label.markId]);
      for (const other of placed.labels) if (other !== label) expect(hits(label.box, other.box), `${label.id} / ${other.id}`).toBe(false);
      for (const head of heads) if (!own.has(head.markId)) expect(hits(label.box, head), `${label.id} covers ${head.markId}`).toBe(false);
      for (const other of cluster) if (other.id !== label.id) expect(hits(label.box, { x: other.at[0] - 2, y: other.at[1] - 2, width: 4, height: 4 }), `${label.id} covers ${other.id}`).toBe(false);
      // A label pushed away from its feature is tied to it by a leader.
      const [x, y] = request.at, { box } = label;
      const gap = Math.hypot(Math.max(box.x - x, 0, x - box.x - box.width), Math.max(box.y - y, 0, y - box.y - box.height));
      if (gap > 8) expect(label.leader, `${label.id} leader`).not.toBeNull();
    }
  });

  it('reports an overlap instead of hiding a label when no candidate fits', () => {
    const tight = { x: 0, y: 0, width: 60, height: 14 };
    const { labels, diagnostics } = placeLabels([
      { id: 'a', markId: 'a', text: 'first', at: [5, 7] },
      { id: 'b', markId: 'b', text: 'second', at: [6, 7] },
    ], { metrics, bounds: tight });
    expect(labels).toHaveLength(2);
    expect(diagnostics.some(d => d.code === 'LABEL_OVERLAP' && d.labelId === 'b')).toBe(true);
    for (const label of labels) {
      expect(label.box.x).toBeGreaterThanOrEqual(tight.x);
      expect(label.box.y).toBeGreaterThanOrEqual(tight.y);
    }
  });

  it('wraps legend rows instead of truncating long labels', () => {
    const items = ['Objective f(x)', 'Starting point (x₀, f(x₀))', 'Steps between successive iterates', 'A very long legend label that must wrap rather than being cut off'].map((label, i) => ({ markId: `m${i}`, label, kind: 'curve', style }));
    const narrow = layoutLegend(items, 260, metrics);
    expect(narrow.entries.every(entry => entry.x + 30 <= 260)).toBe(true);
    expect(narrow.entries.flatMap(entry => entry.lines).join(' ')).toContain('cut off');
    expect(narrow.height).toBeGreaterThan(layoutLegend(items, 900, metrics).height);
  });
});

describe('scene planning (A13, A34)', () => {
  it('draws each polyline segment separately and never bridges a gap', () => {
    const curve = mark({ markId: 'f', kind: 'curve', geometry: {
      kind: 'polyline2', gaps: [{ after: 0, before: 1, reason: 'f is undefined at x = 0' }],
      segments: [{ points: [[-5, 1], [-1, 2]], start: 'none', end: 'open' }, { points: [[1, 2], [5, 1]], start: 'closed', end: 'none' }],
    } });
    const result = plan([curve]);
    const paths = shapes(result, 'f').filter(shape => shape.type === 'path');
    expect(paths).toHaveLength(2);
    for (const path of paths) if (path.type === 'path') expect(path.d.match(/M/g)).toHaveLength(1);
    const glyphs = shapes(result, 'f').filter(shape => shape.type === 'marker');
    expect(glyphs.map(g => g.type === 'marker' && g.hollow)).toEqual([true, false]);
    expect(result.notes).toEqual([{ markId: 'f', kind: 'gap', text: 'f has a gap that is not joined: f is undefined at x = 0' }]);
  });

  it('splits at non-finite samples and shows an isolated sample as a dot', () => {
    const d = polylinePath([[0, 0], [1, 1]], frame, [-20, 20, -20, 20]);
    expect(d).toMatch(/^M[\d.]+ [\d.]+L[\d.]+ [\d.]+$/);
    const result = plan([mark({ markId: 'c', kind: 'curve', geometry: { kind: 'polyline2', gaps: [], segments: [{ points: [[0, 0], [1, 1], [Number.NaN, 2], [3, 3], [Number.NaN, 0], [5, 5], [6, 6]], start: 'none', end: 'none' }] } })]);
    const kinds = shapes(result, 'c').map(shape => shape.type);
    expect(kinds.filter(kind => kind === 'path')).toHaveLength(2);
    expect(kinds.filter(kind => kind === 'marker')).toHaveLength(1);
  });

  it('draws a zero vector as a labelled dot with no arrowhead', () => {
    const result = plan([mark({ markId: 'v', kind: 'arrow', label: 'M·v', from: [0, 0], vector: [0, 0] })]);
    expect(shapes(result, 'v').map(shape => shape.type)).toEqual(['marker']);
    expect(result.labels.map(label => label.text)).toEqual([ZERO_VECTOR_LABEL]);
    expect(result.notes[0]).toMatchObject({ kind: 'zero-vector' });
  });

  it('never draws a misleading arrowhead for a nonzero vector shorter than two pixels', () => {
    const result = plan([mark({ markId: 'w', kind: 'arrow', from: [0, 0], vector: [1e-6, 0] })]);
    expect(shapes(result, 'w').map(shape => shape.type)).toEqual(['marker']);
    expect(result.labels[0].text).toBe(SHORT_VECTOR_LABEL);
    expect(result.notes[0].kind).toBe('short-vector');
  });

  it('draws a normal arrow with a head at its tip and labels it at the tip', () => {
    const result = plan([mark({ markId: 'e1', kind: 'arrow', text: 'M·e₁', from: [0, 0], vector: [2, 1] })]);
    const [shape] = shapes(result, 'e1');
    expect(shape.type).toBe('arrow');
    if (shape.type === 'arrow') expect(shape.head).toMatch(/Z$/);
    expect(result.labels[0].at).toEqual(frame.toScreen(2, 1));
    expect(arrowEnds({ from: [1, 1], to: [3, 2] })).toEqual([[1, 1], [3, 2]]);
    expect(arrowEnds({ vector: null })).toBeNull();
  });

  it('draws triangle-marked segment geometry as directed arrows labelled by segment ID, and other segments as plain lines', () => {
    const triangle = { ...style, marker: 'triangle' as const };
    const vectors = plan([mark({ markId: 'uv', kind: 'segments', style: triangle, geometry: { kind: 'segments2', segments: [{ id: 'u', from: [0, 0], to: [3, 1] }, { id: 'v', from: [0, 0], to: [-1, 2] }] } })]);
    const heads = shapes(vectors, 'uv');
    expect(heads.map(shape => shape.type)).toEqual(['arrow', 'arrow']);
    for (const shape of heads) if (shape.type === 'arrow') expect(shape.head).toMatch(/Z$/);
    expect(vectors.labels.map(label => [label.text, label.at])).toEqual([['u', frame.toScreen(3, 1)], ['v', frame.toScreen(-1, 2)]]);
    // One directed segment is labelled with the mark text at its tip.
    const single = plan([mark({ markId: 'g', kind: 'segment', style: triangle, text: '∇f', geometry: { kind: 'segments2', segments: [{ id: 'gradient', from: [1, 1], to: [2, 1.5] }] } })]);
    expect(shapes(single, 'g').map(shape => shape.type)).toEqual(['arrow']);
    expect(single.labels.map(label => [label.text, label.at])).toEqual([['∇f', frame.toScreen(2, 1.5)]]);
    // A directed zero-length segment is a zero vector, exactly like a zero arrow (G57, A34): a filled dot, never an
    // arrowhead, with the zero-vector note and label.
    const flat = plan([mark({ markId: 'z', kind: 'segments', style: triangle, geometry: { kind: 'segments2', segments: [{ id: 'u', from: [1, 1], to: [1, 1] }] } })]);
    const zeroArrow = plan([mark({ markId: 'za', kind: 'arrow', from: [1, 1], vector: [0, 0] })]);
    expect(shapes(flat, 'z')).toMatchObject([{ type: 'marker', hollow: false, glyph: 'circle' }]);
    expect(shapes(flat, 'z')).toEqual(shapes(zeroArrow, 'za'));
    expect(flat.notes.map(note => note.kind)).toEqual(['zero-vector']);
    expect(flat.notes[0]!.text).toMatch(/zero vector \(no direction\), drawn as a dot/);
    expect(flat.labels.map(label => label.text)).toEqual([ZERO_VECTOR_LABEL]);
    // Several of them in one mark: one aggregated note, no per-segment labels.
    const flats = plan([mark({ markId: 'zz', kind: 'segments', style: triangle, geometry: { kind: 'segments2', segments: [{ id: 'u', from: [1, 1], to: [1, 1] }, { id: 'v', from: [0, 0], to: [0, 0] }, { id: 'w', from: [0, 0], to: [1, 2] }] } })]);
    expect(shapes(flats, 'zz').map(shape => shape.type)).toEqual(['marker', 'marker', 'arrow']);
    expect(flats.notes).toEqual([{ markId: 'zz', kind: 'zero-vector', text: expect.stringContaining('2 zero vectors are drawn as dots (no direction)') }]);
    const grid = plan([mark({ markId: 'grid-lines', kind: 'segments', style: { ...style, marker: 'none' }, geometry: { kind: 'segments2', segments: [{ id: 'x=1', from: [1, -3], to: [1, 3] }, { id: 'x=2', from: [2, -3], to: [2, 3] }] } })]);
    expect(shapes(grid, 'grid-lines').map(shape => shape.type)).toEqual(['path', 'path']);
    expect(grid.labels).toEqual([]);
  });

  it('draws a degenerate polygon as the line or point it collapses to, with a note', () => {
    const line = plan([mark({ markId: 'sq', kind: 'polygon', geometry: { kind: 'polygon2', vertices: [[0, 0], [1, 2], [2, 4], [1, 2]], degenerate: true } })]);
    expect(shapes(line, 'sq')).toHaveLength(1);
    expect(shapes(line, 'sq')[0].type === 'path' && !(shapes(line, 'sq')[0] as { fill: boolean }).fill).toBe(true);
    expect(line.notes[0].text).toContain('drawn as a line');
    const point = plan([mark({ markId: 'sq', kind: 'polygon', geometry: { kind: 'polygon2', vertices: [[1, 1], [1, 1], [1, 1]], degenerate: true } })]);
    expect(shapes(point, 'sq').map(shape => shape.type)).toEqual(['marker']);
    expect(point.notes[0].text).toContain('drawn as a point');
    const square = plan([mark({ markId: 'sq', kind: 'polygon', geometry: { kind: 'polygon2', vertices: [[0, 0], [1, 0], [1, 1], [0, 1]], degenerate: false } })]);
    expect(shapes(square, 'sq')[0]).toMatchObject({ type: 'path', fill: true });
    expect(square.notes).toEqual([]);
  });

  it('keeps undefined coordinates as notes with reasons, never as zeros', () => {
    const result = plan([
      mark({ markId: 'p', kind: 'point', at: null, undefinedReason: 'the probe is outside the domain' }),
      mark({ markId: 'pts', kind: 'points', geometry: { kind: 'points2', points: [{ id: 'a', at: [1, 1] }, { id: 'b', at: null, reason: 'overflow' }] } }),
    ]);
    expect(shapes(result, 'p')).toEqual([]);
    expect(result.notes.map(note => note.text)).toEqual([
      'p: undefined — the probe is outside the domain. Nothing is drawn for it.',
      'pts: 1 point is undefined — overflow. They are not drawn.',
    ]);
    expect(result.extent).toEqual([1, 1, 1, 1]);
  });

  it('detects geometry outside the view without rescaling, ignores reference grids, and reports the data extent', () => {
    const result = plan([
      mark({ markId: 'grid', kind: 'grid', geometry: { kind: 'segments2', segments: [{ id: 'g', from: [-50, 0], to: [50, 0] }] } }),
      mark({ markId: 'far', kind: 'point', label: 'Far point', at: [30, 200] }),
      mark({ markId: 'near', kind: 'point', at: [1, 1] }),
    ]);
    expect(result.clipped).toEqual([{ markId: 'far', label: 'Far point', count: 1 }]);
    expect(result.extent).toEqual([1, 30, 1, 200]);
    expect(shapes(result, 'far')).toEqual([]);
    expect(frame.domain).toEqual(fitFrame([-10, 10, -10, 10], { x: 40, y: 10, width: 400, height: 400 }, true).domain);
  });

  it('discloses vector-field scaling and draws zero samples as dots', () => {
    const result = plan([mark({ markId: 'field', kind: 'vector-field', geometry: { kind: 'vector-field2', scale: { factor: 0.5, disclosure: 'Arrows are half length.' }, samples: [{ at: [0, 0], vector: [0, 0] }, { at: [1, 1], vector: [2, 0] }] } })]);
    expect(shapes(result, 'field').map(shape => shape.type)).toEqual(['marker', 'arrow']);
    expect(result.notes.map(note => note.kind)).toEqual(['scale', 'zero-vector']);
  });

  it('orients an angle arc by the sign of the projected value and labels it with the projection text', () => {
    const angle = (value: number) => plan([mark({ markId: 'ang', kind: 'angle', at: [0, 0], from: [1, 0], to: [0, 1], value: { quantityId: 'a', label: 'a', text: `${value}°`, status: 'valid', approximate: false, value, unit: 'deg', unitLabel: '°' } })]);
    const positive = angle(90), negative = angle(-270);
    expect(positive.labels[0].text).toBe('90°');
    const length = (p: ReturnType<typeof plan>) => (shapes(p, 'ang')[0] as { d: string }).d.split('L').length;
    expect(length(negative)).toBeGreaterThan(length(positive));
    const zeroSide = plan([mark({ markId: 'ang', kind: 'angle', at: [0, 0], from: [0, 0], to: [0, 1] })]);
    expect(zeroSide.notes[0].kind).toBe('undefined');
  });

  it('uses marker shapes as a non-colour encoding', () => {
    const glyphs = (['circle', 'square', 'diamond', 'triangle', 'cross'] as const).map(glyph => markerPath(glyph, 10, 10, 4));
    expect(new Set(glyphs).size).toBe(5);
  });
});

describe('3D projection alternative (A44 fallback path)', () => {
  const view: ProjectedView = {
    viewId: 'space', kind: 'scene3d', title: 'Vectors', description: '', visibility: 'fixed', bounds3: [-3, 3, -2, 2, -1, 1], equalAspect: true,
    axes: { x: { label: 'x', unitLabel: '' }, y: { label: 'y', unitLabel: '' }, z: { label: 'z', unitLabel: '' } },
    marks: [
      mark({ markId: 'u', kind: 'arrow', label: 'u', from: [0, 0, 0], vector: [2, 1, 3] }),
      mark({ markId: 's', kind: 'surface', label: 'surface', geometry: { kind: 'surface-grid', xs: [0, 1], ys: [0, 1], z: [0, 1, null, 2], sampling: { nx: 2, ny: 2, domain: [0, 1, 0, 1] } } }),
    ],
    values: [], equations: [], summary: 'Two vectors.',
  };
  it('selects two coordinates per plane, keeps equal aspect and names the hidden axis', () => {
    const xz = projectView(view, 'xz');
    expect(xz.kind).toBe('scene2d');
    expect(xz.bounds).toEqual([-3, 3, -1, 1]);
    expect(xz.axes?.y.label).toBe('z');
    expect(xz.marks[0].vector).toEqual([2, 3]);
    expect(xz.summary).toContain('y coordinate is not shown');
    expect(projectView(view, 'yz').marks[0].vector).toEqual([1, 3]);
  });

  it('turns a sampled surface into grid lines split at undefined samples', () => {
    const geometry = projectView(view, 'xz').marks[1].geometry;
    expect(geometry?.kind).toBe('polyline2');
    if (geometry?.kind === 'polyline2') expect(geometry.segments.every(segment => segment.points.length >= 1)).toBe(true);
    const result = planScene(projectView(view, 'xz'), fitFrame([-3, 3, -1, 3], { x: 0, y: 0, width: 300, height: 200 }, true));
    expect(result.marks[0].primitives[0].shape.type).toBe('arrow');
  });

  it('lists full 3D coordinates in the accompanying table', () => {
    expect(coordinateRows(view, 'en').map(row => row.cells[0])).toEqual(['(0, 0, 0)', '(2, 1, 3)']);
  });
});
