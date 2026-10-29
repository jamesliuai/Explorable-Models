/**
 * Contract between the 2D learner surface and an optional spatial renderer (report §13, A44). The surface never
 * imports a renderer: the host supplies `spatialLoader`, typically `() => import('@explorable-models/player-3d')`, and
 * the renderer receives the same authorized `ProjectedView` that the 2D projection fallback draws. Camera and
 * selection changes are presentation only; the renderer reports them and the surface serializes them through the
 * activity binding with presentation-revision guards. Types only: this module has no runtime code.
 */
import type { Camera3D, ProjectedView } from '@explorable-models/activity';

export interface SpatialPresentation {
  /** Serialized camera for this view (null = the authored default). */
  camera: Camera3D | null;
  selection: string | null;
  /** Enabled presentation layers for this view. */
  layers: string[];
}

/**
 * Renderer state reported through `onStatus`: `ready` renders on demand; `suspended` renders nothing while hidden or
 * offscreen; `context-lost` shows a visible state while a restore is attempted; `failed` when the graphics context
 * could not be restored (the renderer offers a retry); `disposed` after teardown.
 */
export type SpatialStatus = 'ready' | 'suspended' | 'context-lost' | 'failed' | 'disposed';

export interface SpatialMountOptions {
  view: ProjectedView;
  presentation: SpatialPresentation;
  /** Called at the end of a camera gesture or preset change (not per animation frame). */
  onCamera(camera: Camera3D): void;
  onSelect(target: string | null): void;
  /** When true the renderer runs no automatic animation and changes the camera in discrete steps. */
  reducedMotion: boolean;
  /**
   * Optional status listener. On `context-lost` or `failed` the surface shows its tested 2D alternative (projection and
   * coordinate table) next to the renderer's visible state.
   */
  onStatus?(status: SpatialStatus, message: string | null): void;
  /**
   * The surface's exact wording of what its 2D alternative carries for this view (report §11, G54), read whenever the
   * renderer shows its lost- or failed-context state, so the renderer never claims more than the surface's table holds.
   */
  describeAlternative?(): string;
  /**
   * Limits of the `spatial-3d@1.0` capability record (`SPATIAL_3D_CAPABILITY.limits` in @explorable-models/activity) that
   * the renderer enforces per view and per frame, each up to its own maximum.
   */
  limits?: { vertices?: number; indices?: number; fieldSamples?: number; labels?: number; textureSize?: number; drawCallsPerFrame?: number };
}

/** Live resource and work counters of a mounted renderer (report §13, A47). */
export interface SpatialRendererStats {
  status: SpatialStatus;
  /** Frames rendered since mount (rendering is on demand). */
  frames: number;
  /** Geometries, materials and textures created by the renderer and not yet disposed. */
  geometries: number;
  materials: number;
  textures: number;
  /** The graphics library's own GPU resource counters and shader program cache size. */
  rendererGeometries: number;
  rendererTextures: number;
  programs: number;
  /** Event listeners, observers and pending frames or timers owned by the renderer. */
  listeners: number;
  observers: number;
  pending: number;
  /** Data-derived vertices, indices, vector-field samples and labels of the current drawing. */
  vertices: number;
  indices: number;
  fieldSamples: number;
  labels: number;
  /** Draw calls of the last rendered frame (at most the capability's `drawCallsPerFrame`). */
  drawCalls: number;
}

export interface SpatialRendererInstance {
  /** New projection or presentation for the same view; the renderer must not alter scientific values. */
  update(view: ProjectedView, presentation?: SpatialPresentation): void;
  /** Releases geometries, materials, textures, observers, listeners and render loops. Idempotent. */
  dispose(): void;
  /** Live resource counts (optional for renderers that do not track them). */
  stats?(): SpatialRendererStats;
}

export interface SpatialRendererModule {
  /** Runtime probe; false makes the surface render the 2D projection and coordinate table instead. */
  webglAvailable(): boolean;
  mount(element: HTMLElement, options: SpatialMountOptions): SpatialRendererInstance;
}
