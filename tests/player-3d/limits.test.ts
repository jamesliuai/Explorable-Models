/**
 * Spatial resource bounds (report §13, A47): concrete limits on vertices, indices, vector-field samples and labels,
 * enforced by the planner. At the limit everything is drawn; at limit + 1 the whole mark is rejected with a visible
 * note (no partial surface or field), or the lowest-priority labels are dropped with a note.
 */
import { describe, expect, it } from 'vitest';
import { viewFrame } from '../../packages/player-3d/src/frame';
import { axisLabels, planSpatialScene, SPATIAL_LIMITS } from '../../packages/player-3d/src/plan';
import type { SpatialMark } from '../../packages/player-3d/src/types';
import { SPATIAL_3D_LIMITS } from '../../packages/activity/src/capabilities';
import { field, points, style, surface, vectors, view } from './support';

const plan = (marks: SpatialMark[], limits = {}) => { const v = view(marks); return planSpatialScene(v, viewFrame(v), { limits }); };
/** Indices of a complete nx × ny grid: two triangles per cell plus wireframe edges along rows and columns. */
const gridIndices = (nx: number, ny: number) => 6 * (nx - 1) * (ny - 1) + 2 * ((nx - 1) * ny + nx * (ny - 1));

describe('SPATIAL_LIMITS', () => {
  it('declares the documented bounds', () => {
    expect(SPATIAL_LIMITS).toEqual({ vertices: 20_000, indices: 120_000, fieldSamples: 1_000, labels: 32, textureSize: 1024, drawCallsPerFrame: 128 });
    // The renderer's maxima are the spatial-3d@1.0 capability record's limits (contract data, not renderer assumptions).
    expect(SPATIAL_LIMITS).toEqual(SPATIAL_3D_LIMITS);
    expect(Object.isFrozen(SPATIAL_LIMITS)).toBe(true);
  });

  it('vertices: 20,000 are drawn; 20,001 reject the mark with a note pointing to the 2D alternatives', () => {
    const at = plan([points(20_000)]);
    expect(at.points).toHaveLength(20_000);
    expect(at.counts.vertices).toBe(20_000);
    expect(at.rejected).toEqual([]);
    const over = plan([points(20_001)]);
    expect(over.points).toHaveLength(0);
    expect(over.counts.vertices).toBe(0);
    expect(over.rejected).toEqual([{ markId: 'cloud', label: 'Cloud cloud', limit: 'vertices', requested: 20_001, available: 20_000 }]);
    expect(over.notes.find(note => note.kind === 'limit')?.text).toBe('Cloud cloud is not drawn in 3D: it needs 20001 vertices and the 3D view draws at most 20000 in total. The 2D projection and the table show it.');
  });

  it('vertices are budgeted across marks: the mark that would cross the limit is rejected, earlier and later fitting marks are drawn', () => {
    const result = plan([points(15_000, 'a'), points(5_001, 'b'), points(5_000, 'c')]);
    expect(result.rejected.map(entry => entry.markId)).toEqual(['b']);
    expect(result.counts.vertices).toBe(20_000);
    expect(new Set(result.points.map(point => point.markId))).toEqual(new Set(['a', 'c']));
  });

  it('indices: a surface exactly at the index limit is drawn; one more index rejects the whole surface', () => {
    const exact = gridIndices(30, 30);
    const atLimit = plan([surface(30, 30)], { indices: exact });
    expect(atLimit.surfaces).toHaveLength(1);
    expect(atLimit.counts.indices).toBe(exact);
    const over = plan([surface(30, 30)], { indices: exact - 1 });
    expect(over.surfaces).toHaveLength(0);
    expect(over.rejected[0]).toMatchObject({ markId: 'surface-mesh', limit: 'indices', requested: exact, available: exact - 1 });
    // With the default limits: 110 × 110 fits (119,246 indices), 120 × 120 (142,086) does not, although its vertices fit.
    expect(gridIndices(110, 110)).toBe(119_246);
    expect(plan([surface(110, 110)]).surfaces).toHaveLength(1);
    const big = plan([surface(120, 120)]);
    expect(big.surfaces).toHaveLength(0);
    expect(big.rejected[0]).toMatchObject({ limit: 'indices', requested: 142_086 });
  });

  it('field samples: 1,000 are drawn; 1,001 reject the field (no partial field)', () => {
    const atLimit = plan([field(1_000)]);
    expect(atLimit.fields).toHaveLength(1);
    expect(atLimit.counts.fieldSamples).toBe(1_000);
    const over = plan([field(1_001)]);
    expect(over.fields).toHaveLength(0);
    expect(over.rejected[0]).toMatchObject({ markId: 'field-arrows', limit: 'fieldSamples', requested: 1_001, available: 1_000 });
    expect(over.notes.some(note => note.kind === 'limit' && note.text.includes('1001 field samples'))).toBe(true);
    // A rejected field also carries no scale disclosure, because nothing of it is drawn.
    expect(over.notes.some(note => note.kind === 'scale')).toBe(false);
  });

  it('labels: 32 are shown; at 33 the lowest-priority label (a tick) is dropped with a note', () => {
    const base = view([]);
    const scaffold = axisLabels(viewFrame(base)).length;
    const marks = (count: number): SpatialMark[] => Array.from({ length: count }, (_, i) => ({ markId: `m${i}`, kind: 'point', label: `Point ${i}`, style: style({ marker: 'circle' }), at: [i / 10, 0, 1], text: `P${i}` }));
    const atLimit = plan(marks(SPATIAL_LIMITS.labels - scaffold));
    expect(atLimit.labels).toHaveLength(32);
    expect(atLimit.droppedLabels).toBe(0);
    expect(atLimit.notes.some(note => note.kind === 'limit')).toBe(false);
    const over = plan(marks(SPATIAL_LIMITS.labels - scaffold + 1));
    expect(over.labels).toHaveLength(32);
    expect(over.droppedLabels).toBe(1);
    expect(over.labels.filter(label => label.kind === 'mark')).toHaveLength(SPATIAL_LIMITS.labels - scaffold + 1);
    expect(over.labels.filter(label => label.kind === 'tick').length).toBe(atLimit.labels.filter(label => label.kind === 'tick').length - 1);
    expect(over.notes.find(note => note.kind === 'limit')?.text).toBe('1 label is not shown: the 3D view shows at most 32 labels. The table lists every value.');
  });

  it('a rejected mark does not consume budget, and arrows count two vertices each', () => {
    const pair = () => vectors([{ id: 'u', to: [1, 2, 2] }, { id: 'v', to: [2, 1, 0] }]);
    const over = plan([pair(), points(19_997)]);
    expect(over.arrows).toHaveLength(2);
    expect(over.counts.vertices).toBe(4);
    expect(over.rejected.map(entry => entry.markId)).toEqual(['cloud']);
    const fits = plan([pair(), points(19_996)]);
    expect(fits.counts.vertices).toBe(20_000);
    expect(fits.rejected).toEqual([]);
  });
});
