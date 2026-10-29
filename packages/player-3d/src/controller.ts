/**
 * The renderer's state machine, independent of the DOM (report §13, §18, A47). It owns the Three.js scene, cameras
 * and resources, and renders on demand only: a change requests one animation frame; nothing renders while the view is
 * hidden or offscreen, while the graphics context is lost, or after disposal. A camera preset eases over a few frames
 * unless reduced motion is requested, then stops. Resuming renders the current state once, with no catch-up.
 *
 * Camera changes are presentation: they are committed through `onCamera` at the end of a gesture (pointer up, a
 * pause after keyboard steps, a preset, reset or projection change) and never alter scientific values. An incoming
 * presentation camera is applied unless a local gesture is in progress or it is the stale echo of the camera this
 * renderer just committed.
 *
 * The renderer and scheduler are injected (`RendererPort`, `SchedulerPort`) so this module runs under Node with fakes.
 */
import { Color, Group, Matrix4, OrthographicCamera, PerspectiveCamera, Quaternion, Scene, Vector2, Vector3, type Camera } from 'three';
import {
  cameraToOrbit, defaultOrbit, framingRadius, orbitPose, orbitToCamera, presetOrbit, rotateOrbit, sameOrbit, verticalFov, wholeBoxZoom, wrapAzimuth, zoomOrbit,
  type Orbit, type PresetId, type Projection,
} from './camera.js';
import { sameFrame, toModel, viewFrame, type ViewFrame } from './frame.js';
import { effectiveLimits, planSpatialScene, sameDrawing, type SpatialLimits, type SpatialPlan } from './plan.js';
import { ResourceGroup, ResourceRegistry } from './registry.js';
import { buildAxes, buildContent, countDrawCalls, createLights, createSharedGeometries, HEAD_RADIUS, headSize, type BuiltAxes, type BuiltScene, type SharedGeometries } from './scene.js';
import { sameTheme, type SpatialTheme } from './theme.js';
import type { SpatialCamera, SpatialPresentationInput, SpatialStatus, SpatialView } from './types.js';
import type { Vec3 } from './vec.js';

export interface RendererPort {
  render(scene: Scene, camera: Camera): void;
  setSize(width: number, height: number, updateStyle?: boolean): void;
  setPixelRatio(ratio: number): void;
  setClearColor(color: Color, alpha?: number): void;
  dispose(): void;
  forceContextLoss(): void;
  readonly info: { readonly memory: { geometries: number; textures: number }; readonly programs: readonly unknown[] | null; readonly render?: { readonly calls: number } };
}
export interface SchedulerPort {
  frame(callback: (time: number) => void): number;
  cancelFrame(handle: number): void;
  timer(callback: () => void, ms: number): number;
  cancelTimer(handle: number): void;
  now(): number;
}
export interface ControllerHooks {
  onCamera(camera: SpatialCamera): void;
  onStatus?(status: SpatialStatus, message: string | null): void;
  /** After a re-plan (new projection, selection or theme): the DOM layer rebuilds labels and notes. */
  onPlan?(plan: SpatialPlan, frame: ViewFrame): void;
  /** After every rendered frame: the DOM layer positions labels. */
  onFrame?(controller: SpatialController): void;
  /** The orbit changed; `committed` when it was just sent through `onCamera`. */
  onOrbit?(orbit: Orbit, committed: boolean): void;
}
export interface ControllerOptions {
  view: SpatialView;
  presentation: SpatialPresentationInput;
  reducedMotion: boolean;
  theme: SpatialTheme;
  hooks: ControllerHooks;
  /** Limits from the `spatial-3d@1.0` capability record (passed by the surface); each is honoured up to `SPATIAL_LIMITS`. */
  limits?: Partial<SpatialLimits>;
  /**
   * The renderer is borrowed (the DOM layer's renderer pool, pool.ts): `dispose()` hands it back through this hook,
   * after disposing every geometry and material it drew, instead of disposing it and forcing its context loss.
   * `contextLost` is true while the context is lost or could not be restored.
   */
  releaseRenderer?(contextLost: boolean): void;
}

/** Quiet period after the last keyboard or wheel step before the camera is committed. */
export const KEY_COMMIT_MS = 400;
/** Preset easing duration when motion is allowed. */
export const PRESET_EASE_MS = 280;
/** How long a stale presentation echo is ignored after this renderer committed a camera. */
export const PENDING_ECHO_MS = 3000;

export interface InspectedArrow {
  markId: string;
  segmentId: string;
  /** World-space tail and tip of the drawn arrow, and the apex and axis of its rendered cone head. */
  tail: Vec3; tip: Vec3; apex: Vec3; direction: Vec3;
  /** The same tail and tip mapped back to model coordinates (canonical units). */
  model: { tail: Vec3; tip: Vec3 };
  /** CSS-pixel positions in the viewport (y down); `base` is the centre of the arrowhead's base, `headRadius` its radius. */
  screen: { tail: [number, number]; tip: [number, number]; base: [number, number]; headRadius: number };
}
export interface SpatialInspection {
  status: SpatialStatus;
  frames: number;
  camera: SpatialCamera;
  orbit: Orbit;
  viewport: { width: number; height: number };
  scale: Vec3;
  arrows: InspectedArrow[];
  /** Positive axis ends (world) and their screen positions; `origin` is the axes' crossing point on screen. */
  axes: { tip: Vec3; screen: [number, number] }[];
  origin: [number, number];
  labels: { kind: string; text: string; markId: string | null }[];
  notes: SpatialPlan['notes'];
  counts: SpatialPlan['counts'];
  rejected: SpatialPlan['rejected'];
  wireframe: boolean;
  /** Effective limits, the draw calls of the last rendered frame (`renderer.info.render.calls`) and of the built scene. */
  limits: SpatialLimits;
  drawCalls: { lastFrame: number | null; scene: number };
  /** Radius fitted at zoom 1 (the default framing) and the box's bounding sphere, world units. */
  framing: { radius: number; box: number };
}

const UP = new Vector3(0, 1, 0);
const sameNumbers = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((value, i) => Math.abs(value - b[i]!) <= 1e-6 * Math.max(1, Math.abs(value)));
export const sameCamera = (a: SpatialCamera | null, b: SpatialCamera | null): boolean =>
  a === b || (!!a && !!b && a.projection === b.projection && a.preset === b.preset && sameNumbers(a.position, b.position) && sameNumbers(a.target, b.target) && sameNumbers(a.up, b.up));

export class SpatialController {
  private readonly registry = new ResourceRegistry();
  private readonly scene = new Scene();
  private readonly ortho = new OrthographicCamera();
  private readonly perspective = new PerspectiveCamera();
  private readonly lights = createLights();
  private readonly sharedResources: ResourceGroup;
  private readonly axesResources: ResourceGroup;
  private readonly contentResources: ResourceGroup;
  private readonly shared: SharedGeometries;
  private axes: BuiltAxes | null = null;
  private content: BuiltScene | null = null;

  private view: SpatialView;
  private presentation: SpatialPresentationInput;
  private frame: ViewFrame;
  private plan: SpatialPlan;
  private theme: SpatialTheme;
  private orbit: Orbit;
  private wireframe: boolean;
  private readonly reducedMotion: boolean;

  private status: SpatialStatus = 'ready';
  private visible = true;
  private contextLost = false;
  private failed = false;
  private disposed = false;
  private width = 0;
  private height = 0;
  private frames = 0;
  private frameHandle: number | null = null;
  private commitTimer: number | null = null;
  private gesture = false;
  private tween: { from: Orbit; to: Orbit; start: number } | null = null;
  private pending: { camera: SpatialCamera; at: number } | null = null;
  private applied: SpatialCamera | null;
  private readonly limits: SpatialLimits;
  private lastDrawCalls: number | null = null;

  constructor(private readonly renderer: RendererPort, private readonly scheduler: SchedulerPort, private readonly options: ControllerOptions) {
    this.view = options.view;
    this.presentation = options.presentation;
    this.theme = options.theme;
    this.reducedMotion = options.reducedMotion;
    this.wireframe = options.presentation.layers.includes('wireframe');
    this.sharedResources = new ResourceGroup(this.registry);
    this.axesResources = new ResourceGroup(this.registry);
    this.contentResources = new ResourceGroup(this.registry);
    this.shared = createSharedGeometries(this.sharedResources);
    this.limits = effectiveLimits(options.limits);
    this.frame = viewFrame(this.view);
    this.plan = planSpatialScene(this.view, this.frame, { selection: this.presentation.selection, limits: this.limits });
    this.frame = this.framed(this.frame);
    this.applied = options.presentation.camera;
    this.orbit = (options.presentation.camera && cameraToOrbit(options.presentation.camera, this.frame)) ?? defaultOrbit();
    this.scene.add(this.lights.ambient, this.lights.key);
    this.renderer.setClearColor(new Color(this.theme.surface), 1);
    this.rebuildAxes();
    this.rebuildContent();
  }

  // ---- inputs ----------------------------------------------------------------------------------------------------
  update(view: SpatialView, presentation: SpatialPresentationInput = this.presentation): void {
    if (this.disposed) return;
    // A new projection object that draws the same scene (status, acknowledgement, presentation) keeps the scene.
    if (view !== this.view && sameDrawing(view, this.view)) this.view = view;
    const replan = view !== this.view || presentation.selection !== this.presentation.selection;
    const wireframe = presentation.layers.includes('wireframe');
    const layersChanged = wireframe !== this.presentation.layers.includes('wireframe');
    this.presentation = presentation;
    let frameChanged = false;
    if (view !== this.view) {
      const next = viewFrame(view);
      frameChanged = !sameFrame(this.frame, next);
      this.view = view;
      // The default framing is kept while the box stays the same, so the drawing does not rescale with every commit.
      this.frame = frameChanged ? next : { ...next, framing: this.frame.framing };
    }
    if (layersChanged) this.wireframe = wireframe;
    if (replan) {
      this.plan = planSpatialScene(this.view, this.frame, { selection: presentation.selection, limits: this.limits });
      if (frameChanged) { this.frame = this.framed(this.frame); this.rebuildAxes(); }
      this.rebuildContent();
    } else if (layersChanged) this.applyWireframe();
    // An identical projection and presentation (a re-render of the host) draws nothing new.
    if (replan || layersChanged) this.requestRender();
    this.syncCamera(presentation.camera);
  }

  setTheme(theme: SpatialTheme): void {
    if (this.disposed || sameTheme(theme, this.theme)) return;
    this.theme = theme;
    this.renderer.setClearColor(new Color(theme.surface), 1);
    this.rebuildAxes();
    this.rebuildContent();
    this.requestRender();
  }

  resize(width: number, height: number, pixelRatio: number): void {
    if (this.disposed) return;
    const w = Math.max(0, Math.floor(width)), h = Math.max(0, Math.floor(height));
    if (w === this.width && h === this.height) return;
    this.width = w; this.height = h;
    if (w > 0 && h > 0) {
      this.renderer.setPixelRatio(Math.min(2, Math.max(1, pixelRatio || 1)));
      this.renderer.setSize(w, h, false);
      this.applyResolution();
    }
    this.requestRender();
  }

  /** Hidden tab, offscreen or collapsed: no rendering until visible again (then one frame, no catch-up). */
  setVisible(visible: boolean): void {
    if (this.disposed || visible === this.visible) return;
    this.visible = visible;
    if (!visible) {
      this.cancelFrame();
      // An easing preset jumps to its end instead of resuming later.
      if (this.tween) this.finishTween();
    }
    this.updateStatus();
    if (visible) this.requestRender();
  }

  contextLostEvent(): void {
    if (this.disposed || this.contextLost) return;
    this.contextLost = true;
    this.cancelFrame();
    this.updateStatus('The graphics context was lost. Trying to restore the 3D view…');
  }
  contextRestoredEvent(): void {
    if (this.disposed) return;
    this.contextLost = false;
    this.failed = false;
    this.updateStatus();
    this.requestRender();
  }
  /** The context could not be restored (the DOM layer offers a retry). */
  markFailed(message: string): void {
    if (this.disposed) return;
    this.failed = true;
    this.updateStatus(message);
  }

  // ---- camera commands -------------------------------------------------------------------------------------------
  getOrbit(): Orbit { return { ...this.orbit }; }
  beginGesture(): void { if (!this.disposed) { this.gesture = true; this.stopTween(); } }
  endGesture(): void {
    if (this.disposed || !this.gesture) return;
    this.gesture = false;
    this.commit();
  }
  /** Pointer drags commit at `endGesture`; keyboard and wheel steps commit after a short pause. */
  rotateBy(deltaAzimuth: number, deltaElevation: number): void {
    if (this.disposed) return;
    this.stopTween();
    this.setOrbit(rotateOrbit(this.orbit, deltaAzimuth, deltaElevation));
    if (!this.gesture) this.scheduleCommit();
  }
  zoomBy(factor: number): void {
    if (this.disposed) return;
    this.stopTween();
    this.setOrbit(zoomOrbit(this.orbit, factor));
    if (!this.gesture) this.scheduleCommit();
  }
  preset(preset: PresetId): void { if (!this.disposed) this.moveTo(presetOrbit(this.orbit, preset)); }
  /** The authored default view at zoom 1 (the default framing), orthographic. */
  reset(): void { if (!this.disposed) this.moveTo(defaultOrbit()); }
  /** Shows the whole axis box (its bounding sphere) from the current direction; the projection is kept. */
  wholeBox(): void { if (!this.disposed) this.moveTo({ ...this.orbit, zoom: wholeBoxZoom(this.frame) }); }
  setProjection(projection: Projection): void {
    if (this.disposed || projection === this.orbit.projection) return;
    this.stopTween();
    this.setOrbit({ ...this.orbit, projection });
    this.commit();
  }
  setWireframe(on: boolean): void {
    if (this.disposed || on === this.wireframe) return;
    this.wireframe = on;
    this.applyWireframe();
    this.requestRender();
  }
  get wireframeOn(): boolean { return this.wireframe; }
  get hasSurface(): boolean { return this.plan.surfaces.length > 0; }

  // ---- rendering ---------------------------------------------------------------------------------------------------
  private get canRender(): boolean { return !this.disposed && this.visible && !this.contextLost && !this.failed && this.width > 0 && this.height > 0; }

  requestRender(): void {
    if (!this.canRender || this.frameHandle !== null) return;
    this.frameHandle = this.scheduler.frame(() => this.renderFrame());
  }

  private renderFrame(): void {
    this.frameHandle = null;
    if (!this.canRender) return;
    if (this.tween) this.advanceTween();
    const camera = this.updateCamera();
    this.renderer.render(this.scene, camera);
    // Draw calls of this frame (Three.js resets the counter per render); bounded by the plan's per-frame budget.
    this.lastDrawCalls = this.renderer.info.render?.calls ?? null;
    this.frames++;
    this.options.hooks.onFrame?.(this);
    if (this.tween) this.requestRender();
  }

  /** Active Three.js camera, posed for the current orbit and viewport. */
  updateCamera(): Camera {
    const pose = orbitPose(this.orbit, this.frame);
    const aspect = this.width > 0 && this.height > 0 ? this.width / this.height : 1;
    const reach = this.frame.radius * 4;
    let camera: OrthographicCamera | PerspectiveCamera;
    if (this.orbit.projection === 'orthographic') {
      const half = pose.halfHeight / Math.min(1, aspect);
      camera = this.ortho;
      Object.assign(camera, { left: -half * aspect, right: half * aspect, top: half, bottom: -half, near: -reach, far: pose.distance + reach });
    } else {
      camera = this.perspective;
      Object.assign(camera, { fov: verticalFov(aspect), aspect, near: Math.max(pose.distance * 0.01, 1e-6), far: pose.distance + reach });
    }
    camera.position.set(...pose.position);
    camera.up.set(...pose.up);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    // The key light follows the camera (above and to the right of the viewer).
    const light = new Vector3(...pose.position).addScaledVector(new Vector3(...pose.up), pose.distance * 0.6).addScaledVector(new Vector3(...pose.right), pose.distance * 0.4);
    this.lights.key.position.copy(light);
    this.lights.key.updateMatrixWorld();
    return camera;
  }

  /** CSS-pixel position of a world point in the current viewport (y down). */
  project(point: Vec3, camera: Camera = this.updateCamera()): [number, number, number] {
    const ndc = new Vector3(...point).project(camera);
    return [(ndc.x + 1) / 2 * this.width, (1 - ndc.y) / 2 * this.height, ndc.z];
  }

  get viewportSize(): { width: number; height: number } { return { width: this.width, height: this.height }; }
  get currentPlan(): SpatialPlan { return this.plan; }
  get currentFrame(): ViewFrame { return this.frame; }
  get currentStatus(): SpatialStatus { return this.status; }
  get frameCount(): number { return this.frames; }

  // ---- teardown and introspection ----------------------------------------------------------------------------------
  /**
   * Releases every owned resource, then the renderer: a borrowed renderer goes back through `releaseRenderer`; an owned
   * one is disposed and its context released. Idempotent; no hook runs afterwards.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelFrame();
    if (this.commitTimer !== null) { this.scheduler.cancelTimer(this.commitTimer); this.commitTimer = null; }
    this.tween = null;
    this.registry.releaseAll();
    this.scene.clear();
    this.content = null;
    this.axes = null;
    this.status = 'disposed';
    if (this.options.releaseRenderer) { this.options.releaseRenderer(this.contextLost); return; }
    this.renderer.dispose();
    // Releases the context now rather than at garbage collection; a context that is already lost has nothing to release
    // (and no WEBGL_lose_context extension to call).
    if (!this.contextLost) this.renderer.forceContextLoss();
  }

  stats() {
    const own = this.registry.counts();
    // After disposal the renderer's counters are no longer this instance's (a borrowed renderer may draw another view).
    const info = this.disposed ? null : this.renderer.info;
    return {
      status: this.status, frames: this.frames,
      geometries: own.geometries, materials: own.materials, textures: own.textures,
      rendererGeometries: info?.memory.geometries ?? 0, rendererTextures: info?.memory.textures ?? 0, programs: info?.programs?.length ?? 0,
      pending: (this.frameHandle !== null ? 1 : 0) + (this.commitTimer !== null ? 1 : 0),
      vertices: this.disposed ? 0 : this.plan.counts.vertices, indices: this.disposed ? 0 : this.plan.counts.indices,
      fieldSamples: this.disposed ? 0 : this.plan.counts.fieldSamples, labels: this.disposed ? 0 : this.plan.counts.labels,
      drawCalls: this.disposed ? 0 : this.lastDrawCalls ?? 0,
    };
  }

  inspect(): SpatialInspection {
    const camera = this.updateCamera();
    const screen = (point: Vec3): [number, number] => { const [x, y] = this.project(point, camera); return [x, y]; };
    const arrows: InspectedArrow[] = this.arrowShapes(camera).map(({ arrow, apex, direction, base, headRadius }) => ({
      markId: arrow.markId, segmentId: arrow.segmentId, tail: arrow.tail, tip: arrow.tip, apex, direction,
      model: { tail: toModel(this.frame, arrow.tail), tip: toModel(this.frame, arrow.tip) }, screen: { tail: screen(arrow.tail), tip: screen(arrow.tip), base: screen(base), headRadius },
    }));
    const origin = this.frame.axisOrigin;
    const worldOrigin: Vec3 = [(origin[0] - this.frame.center[0]) * this.frame.scale[0], (origin[1] - this.frame.center[1]) * this.frame.scale[1], (origin[2] - this.frame.center[2]) * this.frame.scale[2]];
    return {
      status: this.status, frames: this.frames, camera: orbitToCamera(this.orbit, this.frame), orbit: { ...this.orbit }, viewport: { width: this.width, height: this.height },
      scale: [...this.frame.scale], arrows, axes: (this.axes?.tips ?? []).map(tip => ({ tip, screen: screen(tip) })), origin: screen(worldOrigin),
      labels: this.plan.labels.map(label => ({ kind: label.kind, text: label.text, markId: label.markId })),
      notes: this.plan.notes, counts: this.plan.counts, rejected: this.plan.rejected, wireframe: this.wireframe,
      limits: { ...this.limits }, drawCalls: { lastFrame: this.lastDrawCalls, scene: countDrawCalls(this.scene) },
      framing: { radius: this.frame.framing ?? this.frame.radius, box: this.frame.radius },
    };
  }

  /**
   * Rendered arrows with their arrowheads read back from the instanced head meshes: world apex and axis, the centre of
   * the head's base, and its base radius in CSS pixels at the current camera (label placement treats the head and
   * the shaft as obstacles, mount.ts).
   */
  arrowShapes(camera: Camera = this.updateCamera()): { arrow: BuiltScene['arrows'][number]; apex: Vec3; direction: Vec3; base: Vec3; headRadius: number }[] {
    const matrix = new Matrix4(), position = new Vector3(), rotation = new Quaternion(), size = new Vector3();
    return (this.content?.arrows ?? []).map(arrow => {
      arrow.head.mesh.updateMatrixWorld();
      arrow.head.mesh.getMatrixAt(arrow.head.index, matrix);
      matrix.premultiply(arrow.head.mesh.matrixWorld).decompose(position, rotation, size);
      const direction = UP.clone().applyQuaternion(rotation).normalize();
      const apex = position.toArray() as Vec3;
      const length = Math.hypot(arrow.tip[0] - arrow.tail[0], arrow.tip[1] - arrow.tail[1], arrow.tip[2] - arrow.tail[2]);
      const head = headSize(length, this.frame.radius);
      const base: Vec3 = [apex[0] - direction.x * head, apex[1] - direction.y * head, apex[2] - direction.z * head];
      // Pixels per world unit at the head: a unit step along the camera's right vector, projected.
      const pose = orbitPose(this.orbit, this.frame);
      const [x0, y0] = this.project(base, camera), [x1, y1] = this.project([base[0] + pose.right[0], base[1] + pose.right[1], base[2] + pose.right[2]], camera);
      return { arrow, apex, direction: direction.toArray() as Vec3, base, headRadius: head * HEAD_RADIUS * Math.hypot(x1 - x0, y1 - y0) };
    });
  }

  /** The frame with its default framing for the current plan (axes, axis names and drawn data inside the box). */
  private framed(frame: ViewFrame): ViewFrame {
    const plan = this.plan;
    const data: Vec3[] = [
      ...plan.arrows.flatMap(arrow => [arrow.tail, arrow.tip]), ...plan.lines.flatMap(line => line.points), ...plan.points.map(point => point.at),
      ...plan.surfaces.flatMap(surface => surface.vertices), ...plan.fields.flatMap(field => [...field.arrows.flatMap(arrow => [arrow.at, arrow.tip]), ...field.zero]),
    ];
    return { ...frame, framing: framingRadius(frame, data) };
  }

  // ---- internals ---------------------------------------------------------------------------------------------------
  private updateStatus(message: string | null = null): void {
    if (this.disposed) return;
    const next: SpatialStatus = this.failed ? 'failed' : this.contextLost ? 'context-lost' : this.visible ? 'ready' : 'suspended';
    if (next === this.status) return;
    this.status = next;
    this.options.hooks.onStatus?.(next, message);
  }

  private cancelFrame(): void {
    if (this.frameHandle !== null) { this.scheduler.cancelFrame(this.frameHandle); this.frameHandle = null; }
  }

  private rebuildAxes(): void {
    if (this.axes) this.scene.remove(this.axes.group);
    this.axesResources.release();
    this.axes = buildAxes(this.frame, this.theme, this.axesResources, this.shared);
    this.scene.add(this.axes.group);
    this.applyResolution();
  }

  private rebuildContent(): void {
    if (this.content) this.scene.remove(this.content.group);
    this.contentResources.release();
    this.content = buildContent(this.plan, this.frame, this.theme, this.contentResources, this.shared, { wireframe: this.wireframe });
    this.scene.add(this.content.group);
    this.applyResolution();
    this.options.hooks.onPlan?.(this.plan, this.frame);
  }

  private applyWireframe(): void {
    // Wireframe switches styles of existing objects, so the surface is rebuilt with the other line style.
    this.rebuildContent();
  }

  private applyResolution(): void {
    if (!(this.width > 0 && this.height > 0)) return;
    const resolution = new Vector2(this.width, this.height);
    for (const material of [...(this.axes?.lineMaterials ?? []), ...(this.content?.lineMaterials ?? [])]) material.resolution = resolution;
  }

  private setOrbit(orbit: Orbit, committed = false): void {
    this.orbit = orbit;
    this.options.hooks.onOrbit?.(orbit, committed);
    this.requestRender();
  }

  private scheduleCommit(): void {
    if (this.commitTimer !== null) this.scheduler.cancelTimer(this.commitTimer);
    this.commitTimer = this.scheduler.timer(() => { this.commitTimer = null; this.commit(); }, KEY_COMMIT_MS);
  }

  private commit(): void {
    if (this.disposed) return;
    if (this.commitTimer !== null) { this.scheduler.cancelTimer(this.commitTimer); this.commitTimer = null; }
    const camera = orbitToCamera(this.orbit, this.frame);
    const current = this.pending?.camera ?? this.applied;
    if (sameCamera(camera, current)) return;
    this.pending = { camera, at: this.scheduler.now() };
    this.options.hooks.onOrbit?.(this.orbit, true);
    this.options.hooks.onCamera(camera);
  }

  /** Applies a presentation camera unless a local gesture is active or it is the stale echo of our own commit. */
  private syncCamera(camera: SpatialCamera | null): void {
    if (this.gesture || this.tween || this.commitTimer !== null) return;
    let expired = false;
    if (this.pending) {
      if (camera && sameCamera(camera, this.pending.camera)) { this.applied = camera; this.pending = null; return; }
      if (sameCamera(camera, this.applied) && this.scheduler.now() - this.pending.at < PENDING_ECHO_MS) return;
      // Our commit never reached the presentation (refused or superseded): the presentation is the source of truth.
      this.pending = null;
      expired = true;
    }
    if (!expired && sameCamera(camera, this.applied)) return;
    this.applied = camera;
    const target = (camera && cameraToOrbit(camera, this.frame)) ?? defaultOrbit();
    if (!sameOrbit(target, this.orbit)) this.setOrbit(target);
  }

  private moveTo(target: Orbit): void {
    this.stopTween();
    if (sameOrbit(target, this.orbit)) { this.setOrbit(target); this.commit(); return; }
    if (this.reducedMotion || !this.canRender) { this.setOrbit(target); this.commit(); return; }
    this.tween = { from: { ...this.orbit }, to: target, start: this.scheduler.now() };
    this.requestRender();
  }

  private advanceTween(): void {
    const tween = this.tween!;
    const t = Math.min(1, (this.scheduler.now() - tween.start) / PRESET_EASE_MS);
    if (t >= 1) { this.finishTween(); return; }
    const ease = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    const deltaAzimuth = wrapAzimuth(tween.to.azimuth - tween.from.azimuth);
    this.orbit = {
      azimuth: wrapAzimuth(tween.from.azimuth + deltaAzimuth * ease),
      elevation: tween.from.elevation + (tween.to.elevation - tween.from.elevation) * ease,
      zoom: tween.from.zoom * (tween.to.zoom / tween.from.zoom) ** ease,
      projection: tween.to.projection, preset: null,
    };
  }

  private finishTween(): void {
    const tween = this.tween;
    if (!tween) return;
    this.tween = null;
    this.setOrbit(tween.to);
    this.commit();
  }

  /** A new gesture interrupts an easing preset where it is (and commits nothing until the gesture ends). */
  private stopTween(): void {
    if (this.tween) { this.tween = null; this.options.hooks.onOrbit?.(this.orbit, false); }
  }
}


