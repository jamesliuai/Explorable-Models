/**
 * Per-frame operation cost of the spatial renderer (report §13 "per-frame operation costs", A47; G52): the scene is
 * built with a bounded number of draw calls per mark whatever its size, `drawCallsOf` counts exactly the draw calls the
 * built scene issues, and the planner enforces the `drawCallsPerFrame` limit of the spatial-3d@1.0 capability record —
 * at the limit everything is drawn, at limit + 1 the mark that would cross it is rejected with a visible note. Limits
 * passed at mount can only lower the renderer's own maxima.
 */
import { describe, expect, it } from 'vitest';
import { SpatialController } from '../../packages/player-3d/src/controller';
import { viewFrame } from '../../packages/player-3d/src/frame';
import { drawCallsOf, effectiveLimits, planSpatialScene, scaffoldDrawCalls, SPATIAL_LIMITS } from '../../packages/player-3d/src/plan';
import { LIGHT_THEME } from '../../packages/player-3d/src/theme';
import type { SpatialMark, SpatialView } from '../../packages/player-3d/src/types';
import { FakeRenderer, field, ManualScheduler, points, style, surface, vectors, view } from './support';

const curve = (id: string): SpatialMark => ({
  markId: id, kind: 'curve', label: `Curve ${id}`, style: style(),
  geometry: { kind: 'polyline3', segments: [{ points: [[0, 0, 0], [1, 1, 1], [2, 1, 0]], start: 'none', end: 'none' }], gaps: [] },
});
const glyphs = (marker: string, id: string): SpatialMark => ({ ...points(40, id), style: style({ marker }) });
function controllerFor(scene: SpatialView, limits?: { drawCallsPerFrame?: number }) {
  return new SpatialController(new FakeRenderer(), new ManualScheduler(), {
    view: scene, presentation: { camera: null, selection: null, layers: [] }, reducedMotion: true, theme: LIGHT_THEME,
    hooks: { onCamera: () => undefined }, ...(limits ? { limits } : {}),
  });
}

describe('draw calls per frame', () => {
  it('are counted exactly: the planned count equals the draw calls of the built scene', () => {
    const scenes: SpatialView[] = [
      view([]),
      view([vectors([{ id: 'u', to: [2, 1, 0] }, { id: 'v', to: [1, 2, 2] }, { id: 'zero', to: [0, 0, 0] }])]),
      view([vectors([{ id: 'u', to: [2, 1, 0] }]), surface(9, 9), glyphs('circle', 'dots'), glyphs('square', 'boxes'), glyphs('cross', 'crosses')]),
      view([field(60), curve('c1'), curve('c2')]),
      view([points(20_000)]),
    ];
    for (const scene of scenes) {
      const controller = controllerFor(scene);
      const inspection = controller.inspect();
      expect(inspection.counts.drawCalls).toBe(inspection.drawCalls.scene);
      controller.dispose();
    }
  });

  it('are bounded per mark, not per element: 20,000 points cost one draw call (two with an occlusion ghost)', () => {
    const frame = viewFrame(view([]));
    const lone = planSpatialScene(view([points(20_000)]), frame);
    expect(lone.counts.drawCalls).toBe(scaffoldDrawCalls(frame) + 1);
    const occluded = planSpatialScene(view([points(20), surface(5, 5)]), frame);
    // The points and their ghost, the surface mesh in two passes (transparent, double-sided) and its wireframe.
    expect(drawCallsOf(occluded, true)).toBe(2 + 3);
    expect(drawCallsOf(occluded, true, true)).toBe(2 + 1);
    // A field: its shafts and heads, plus one instanced mesh for its zero vectors' dots when it has any.
    expect(drawCallsOf(planSpatialScene(view([field(30)]), frame), false)).toBe(2);
    const withZeros = field(30);
    (withZeros.geometry as { samples: { at: number[]; vector: number[] }[] }).samples.slice(0, 5).forEach(sample => { sample.vector = [0, 0, 0]; });
    expect(drawCallsOf(planSpatialScene(view([withZeros]), frame), false)).toBe(3);
  });

  it('limit: a view needing exactly drawCallsPerFrame is drawn in full; one more rejects the mark that crosses it', () => {
    const scaffold = scaffoldDrawCalls(viewFrame(view([])));
    const fits = Array.from({ length: SPATIAL_LIMITS.drawCallsPerFrame - scaffold }, (_, i) => curve(`c${i}`));
    const at = planSpatialScene(view(fits), viewFrame(view(fits)));
    expect(at.counts.drawCalls).toBe(SPATIAL_LIMITS.drawCallsPerFrame);
    expect(at.rejected).toEqual([]);
    expect(at.lines).toHaveLength(fits.length);
    const over = [...fits, curve('one-more')];
    const result = planSpatialScene(view(over), viewFrame(view(over)));
    expect(result.counts.drawCalls).toBe(SPATIAL_LIMITS.drawCallsPerFrame);
    expect(result.rejected).toEqual([{ markId: 'one-more', label: 'Curve one-more', limit: 'drawCallsPerFrame', requested: 1, available: 0 }]);
    expect(result.notes.find(note => note.kind === 'limit')?.text).toBe('Curve one-more is not drawn in 3D: it needs 1 draw calls per frame and the 3D view draws at most 128 in total. The 2D projection and the table show it.');
  });

  it('honours a lower limit passed at mount and never raises the renderer maximum', () => {
    expect(effectiveLimits({ drawCallsPerFrame: 20, vertices: 1e9 })).toEqual({ ...SPATIAL_LIMITS, drawCallsPerFrame: 20 });
    expect(effectiveLimits({ labels: -1, indices: Number.NaN })).toEqual(SPATIAL_LIMITS);
    const scene = view(Array.from({ length: 12 }, (_, i) => curve(`c${i}`)));
    const controller = controllerFor(scene, { drawCallsPerFrame: 20 });
    const inspection = controller.inspect();
    expect(inspection.limits.drawCallsPerFrame).toBe(20);
    expect(inspection.counts.drawCalls).toBe(20);
    expect(inspection.rejected.map(entry => entry.markId)).toEqual(['c9', 'c10', 'c11']);
    expect(inspection.drawCalls.scene).toBe(20);
    controller.dispose();
  });
});
