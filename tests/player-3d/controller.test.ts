/**
 * Lifecycle of the spatial renderer's controller with a fake renderer and a manual scheduler (report §13, §18, A47):
 * on-demand rendering, suspension without catch-up, context loss, camera commits that never change science, echo
 * handling of the presentation camera, and complete disposal over repeated cycles (own registry and the renderer's
 * memory counters return to zero; every created geometry and material receives `dispose`).
 */
import { describe, expect, it } from 'vitest';
import type { BufferGeometry, Material, Object3D } from 'three';
import { defaultOrbit, orbitToCamera, presetOrbit } from '../../packages/player-3d/src/camera';
import { KEY_COMMIT_MS, PENDING_ECHO_MS, PRESET_EASE_MS, SpatialController, sameCamera } from '../../packages/player-3d/src/controller';
import { viewFrame } from '../../packages/player-3d/src/frame';
import { LIGHT_THEME, DARK_THEME } from '../../packages/player-3d/src/theme';
import type { SpatialCamera, SpatialPresentationInput, SpatialStatus, SpatialView } from '../../packages/player-3d/src/types';
import { FakeRenderer, ManualScheduler, surface, vectors, view } from './support';

const presentation = (patch: Partial<SpatialPresentationInput> = {}): SpatialPresentationInput => ({ camera: null, selection: null, layers: [], ...patch });
const scene = (to: [number, number, number] = [1, 2, 2]): SpatialView => view([vectors([{ id: 'u', to: [2, 1, 0] }, { id: 'v', to }]), surface(9, 9)]);

function setup(options: { view?: SpatialView; presentation?: SpatialPresentationInput; reducedMotion?: boolean } = {}) {
  const renderer = new FakeRenderer();
  const scheduler = new ManualScheduler();
  const cameras: SpatialCamera[] = [];
  const statuses: SpatialStatus[] = [];
  const controller = new SpatialController(renderer, scheduler, {
    view: options.view ?? scene(), presentation: options.presentation ?? presentation(), reducedMotion: options.reducedMotion ?? true, theme: LIGHT_THEME,
    hooks: { onCamera: camera => cameras.push(camera), onStatus: status => statuses.push(status) },
  });
  return { renderer, scheduler, controller, cameras, statuses };
}

/** Every geometry and material reachable from the controller's scene, plus the shared glyph geometries. */
function resources(controller: SpatialController): { geometries: Set<BufferGeometry>; materials: Set<Material> } {
  const geometries = new Set<BufferGeometry>(), materials = new Set<Material>();
  (controller as unknown as { scene: Object3D }).scene.traverse(object => {
    const { geometry, material } = object as Object3D & { geometry?: BufferGeometry; material?: Material | Material[] };
    if (geometry) geometries.add(geometry);
    for (const item of [material ?? []].flat()) materials.add(item);
  });
  return { geometries, materials };
}

describe('on-demand rendering', () => {
  it('renders one frame per change and nothing while idle or before it has a size', () => {
    const { renderer, scheduler, controller } = setup();
    expect(scheduler.pendingFrames).toBe(0);
    controller.resize(640, 480, 2);
    expect(renderer.size).toEqual([640, 480]);
    expect(renderer.pixelRatio).toBe(2);
    expect(scheduler.flush()).toBe(1);
    expect(renderer.renders).toBe(1);
    expect(scheduler.flush()).toBe(0);
    // Two changes before the next frame coalesce into one frame.
    controller.update(scene([1, 0, 0]));
    controller.update(scene([0, 1, 0]));
    expect(scheduler.flush()).toBe(1);
    expect(renderer.renders).toBe(2);
    // An identical projection and presentation (a host re-render) draws nothing, and neither does a new projection
    // object that draws the same scene (a status or acknowledgement change of the same frame).
    const same = scene([0, 0, 1]);
    controller.update(same, presentation());
    scheduler.flush();
    controller.update(same, presentation());
    expect(scheduler.flush()).toBe(0);
    controller.update(structuredClone(same), presentation());
    expect(scheduler.flush()).toBe(0);
    controller.update({ ...structuredClone(same), summary: 'Another summary of the same drawing.' }, presentation());
    expect(scheduler.flush()).toBe(0);
    expect(controller.stats().frames).toBe(renderer.renders);
  });

  it('suspends while hidden: no frames, then exactly one frame of the current state on resume (no catch-up)', () => {
    const { renderer, scheduler, controller, statuses } = setup();
    controller.resize(400, 300, 1);
    scheduler.flush();
    controller.setVisible(false);
    expect(controller.stats().status).toBe('suspended');
    for (let i = 0; i < 10; i++) { controller.update(scene([i, 1, 1])); controller.rotateBy(15, 0); scheduler.advance(100); }
    expect(renderer.renders).toBe(1);
    expect(scheduler.pendingFrames).toBe(0);
    controller.setVisible(true);
    expect(scheduler.flush()).toBe(1);
    expect(renderer.renders).toBe(2);
    expect(scheduler.flush()).toBe(0);
    expect(statuses).toEqual(['suspended', 'ready']);
  });

  it('draws nothing while the graphics context is lost and redraws once restored', () => {
    const { renderer, scheduler, controller, statuses } = setup();
    controller.resize(400, 300, 1);
    scheduler.flush();
    controller.contextLostEvent();
    controller.update(scene([3, 0, 0]));
    expect(scheduler.flush()).toBe(0);
    expect(controller.stats().status).toBe('context-lost');
    controller.contextRestoredEvent();
    expect(scheduler.flush()).toBe(1);
    expect(renderer.renders).toBe(2);
    controller.contextLostEvent();
    controller.markFailed('Could not restore.');
    expect(statuses).toEqual(['context-lost', 'ready', 'context-lost', 'failed']);
    // Disposing after a permanent loss (Try again replaces the renderer) does not force a loss of a lost context.
    controller.dispose();
    expect([renderer.disposeCalls, renderer.contextLossCalls]).toEqual([1, 0]);
  });

  it('eases a preset over a few frames when motion is allowed, then stops rendering', () => {
    const { renderer, scheduler, controller, cameras } = setup({ reducedMotion: false });
    controller.resize(400, 300, 1);
    scheduler.flush();
    controller.preset('top');
    scheduler.advance(PRESET_EASE_MS + 100);
    expect(renderer.renders).toBeGreaterThan(5);
    const after = renderer.renders;
    scheduler.advance(500);
    expect(renderer.renders).toBe(after);
    expect(cameras).toHaveLength(1);
    expect(cameras[0]!.preset).toBe('top');
  });
});

describe('camera commits (presentation only)', () => {
  it('commits keyboard steps once after a pause, pointer drags at gesture end and presets immediately with reduced motion', () => {
    const { scheduler, controller, cameras } = setup();
    controller.resize(400, 300, 1);
    for (let i = 0; i < 3; i++) { controller.rotateBy(15, 0); scheduler.advance(100); }
    expect(cameras).toHaveLength(0);
    scheduler.advance(KEY_COMMIT_MS);
    expect(cameras).toHaveLength(1);
    expect(controller.getOrbit().azimuth).toBe(25);
    controller.beginGesture();
    controller.rotateBy(-10, 5);
    scheduler.advance(2 * KEY_COMMIT_MS);
    expect(cameras).toHaveLength(1);
    controller.endGesture();
    expect(cameras).toHaveLength(2);
    controller.preset('side');
    expect(cameras).toHaveLength(3);
    // Cameras serialize against the renderer's frame, whose zoom 1 is the default framing (G55).
    expect(cameras[2]).toEqual(orbitToCamera(presetOrbit(defaultOrbit(), 'side'), controller.currentFrame));
    controller.setProjection('perspective');
    expect(cameras.at(-1)!.projection).toBe('perspective');
    // Committing the same camera again sends nothing.
    controller.preset('side');
    expect(cameras).toHaveLength(4);
  });

  it('ignores the stale echo of its own commit but applies a newer camera from elsewhere', () => {
    const { scheduler, controller, cameras } = setup();
    controller.resize(400, 300, 1);
    controller.preset('top');
    const committed = cameras[0]!;
    // A projection produced before the commit reached the host still carries the old (default) camera.
    controller.update(scene(), presentation());
    expect(controller.getOrbit().preset).toBe('top');
    controller.update(scene(), presentation({ camera: committed }));
    expect(controller.getOrbit().preset).toBe('top');
    // Another surface (or a restore) sets the front view: adopted without being sent back.
    const external = orbitToCamera(presetOrbit(defaultOrbit(), 'front'), viewFrame(scene()));
    controller.update(scene(), presentation({ camera: external }));
    expect(controller.getOrbit().preset).toBe('front');
    expect(cameras).toHaveLength(1);
    // After the echo window, a camera that differs from ours is applied even if it equals an older one.
    controller.preset('side');
    scheduler.advance(PENDING_ECHO_MS + 10);
    controller.update(scene(), presentation({ camera: external }));
    expect(controller.getOrbit().preset).toBe('front');
  });

  it('restores a presentation camera at mount and never calls back for it', () => {
    const camera = orbitToCamera(presetOrbit(defaultOrbit('perspective'), 'front'), viewFrame(scene()));
    const { controller, cameras } = setup({ presentation: presentation({ camera }) });
    expect(controller.getOrbit()).toMatchObject({ preset: 'front', projection: 'perspective' });
    expect(cameras).toEqual([]);
    // The restored camera is the same absolute camera, whatever framing the renderer fits at zoom 1.
    expect(sameCamera(camera, orbitToCamera(controller.getOrbit(), controller.currentFrame))).toBe(true);
  });

  it('keeps a local gesture over incoming presentation cameras until it is committed', () => {
    const { scheduler, controller } = setup();
    controller.resize(400, 300, 1);
    controller.beginGesture();
    controller.rotateBy(30, 0);
    controller.update(scene(), presentation({ camera: orbitToCamera(presetOrbit(defaultOrbit(), 'top'), viewFrame(scene())) }));
    expect(controller.getOrbit().azimuth).toBe(10);
    controller.endGesture();
    scheduler.flush();
    expect(controller.getOrbit().azimuth).toBe(10);
  });
});

describe('resources and disposal', () => {
  it('rebuilding content releases the previous geometries and materials (no growth across updates)', () => {
    const { scheduler, controller, renderer } = setup();
    controller.resize(400, 300, 1);
    scheduler.flush();
    const first = controller.stats();
    const { geometries, materials } = resources(controller);
    let disposed = 0;
    for (const item of [...geometries, ...materials]) item.addEventListener('dispose', () => { disposed++; });
    for (let i = 0; i < 25; i++) { controller.update(scene([i / 10, 1, 1])); scheduler.flush(); }
    const later = controller.stats();
    expect(later.geometries).toBe(first.geometries);
    expect(later.materials).toBe(first.materials);
    expect(renderer.info.memory.geometries).toBe(first.rendererGeometries);
    // Content geometries and materials of the first build were disposed; shared glyph and axis resources were not.
    expect(disposed).toBeGreaterThan(0);
    controller.setTheme(DARK_THEME);
    scheduler.flush();
    expect(renderer.clearColor).toBe(DARK_THEME.surface);
    expect(controller.stats().geometries).toBe(first.geometries);
  });

  it('dispose releases every geometry and material, the renderer and its context, and pending work; later calls are inert', () => {
    const { scheduler, controller, renderer, cameras, statuses } = setup();
    controller.resize(400, 300, 1);
    scheduler.flush();
    const { geometries, materials } = resources(controller);
    const live = controller.stats();
    expect(live.geometries).toBeGreaterThan(5);
    expect(live.materials).toBeGreaterThan(5);
    const disposed = new Set<object>();
    for (const item of [...geometries, ...materials]) item.addEventListener('dispose', () => disposed.add(item));
    controller.rotateBy(15, 0);
    expect(scheduler.pendingTimers).toBe(1);
    controller.dispose();
    expect([...geometries, ...materials].filter(item => !disposed.has(item))).toEqual([]);
    expect(controller.stats()).toMatchObject({ status: 'disposed', geometries: 0, materials: 0, textures: 0, rendererGeometries: 0, pending: 0, vertices: 0, labels: 0 });
    expect(renderer.disposeCalls).toBe(1);
    expect(renderer.contextLossCalls).toBe(1);
    expect(scheduler.pendingFrames).toBe(0);
    expect(scheduler.pendingTimers).toBe(0);
    controller.dispose();
    controller.update(scene([1, 0, 0]));
    controller.rotateBy(15, 0);
    controller.preset('top');
    controller.setVisible(false);
    scheduler.advance(1000);
    expect(renderer.disposeCalls).toBe(1);
    expect(cameras).toEqual([]);
    expect(statuses).toEqual([]);
  });

  it('50 mount/update/render/dispose cycles leave no live resources behind', () => {
    const counts: number[] = [];
    let created = 0, released = 0;
    for (let cycle = 0; cycle < 50; cycle++) {
      const { scheduler, controller, renderer } = setup({ view: scene([cycle % 3, 1, 2]) });
      controller.resize(320 + cycle, 240, 1);
      scheduler.flush();
      for (let i = 0; i < 3; i++) { controller.update(scene([i, cycle % 5, 1])); scheduler.flush(); }
      controller.rotateBy(15, 15);
      const { geometries, materials } = resources(controller);
      created += geometries.size + materials.size;
      for (const item of [...geometries, ...materials]) item.addEventListener('dispose', () => { released++; });
      controller.dispose();
      const after = controller.stats();
      counts.push(after.geometries + after.materials + after.textures + renderer.info.memory.geometries + after.pending);
      expect(scheduler.pendingFrames + scheduler.pendingTimers).toBe(0);
    }
    expect(counts.every(count => count === 0)).toBe(true);
    expect(released).toBe(created);
  });
});
