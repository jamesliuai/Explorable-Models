/**
 * Input and output types of the spatial renderer. They are structural: the renderer depends on `@experiment-kit/core`
 * types only (architecture §1), and the activity surface's `ProjectedView`, `Camera3D` and `SpatialPresentation`
 * (`@experiment-kit/player/activity` spatial contract) are assignable to them. A compile-time conformance test in
 * `tests/player-3d` checks that this module satisfies the surface's `SpatialRendererModule` contract.
 */
import type { GeometryResult } from '@experiment-kit/core/model';

export type LabelAnchor = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw' | 'center';
export interface SpatialMarkStyle { role: string; dash: 'solid' | 'dashed' | 'dotted'; marker: string; weight: 'thin' | 'regular' | 'bold' }

/** One authorized mark of a `scene3d` view, exactly as the learner projection supplies it (display units). */
export interface SpatialMark {
  markId: string;
  kind: string;
  label: string;
  style: SpatialMarkStyle;
  text?: string;
  placement?: { anchor: LabelAnchor; offset: [number, number] };
  geometry?: GeometryResult;
  at?: number[] | null;
  vector?: number[] | null;
  from?: number[] | null;
  to?: number[] | null;
  value?: { text: string; status: string };
  /** Learner-safe reason when a bound value is undefined; drawn as nothing plus a note, never as zero. */
  undefinedReason?: string;
  /**
   * Reasons (as they appear in `geometry` and `undefinedReason`) of gaps that are numerical limits — overflow, underflow,
   * iteration limit — rather than mathematically undefined; their notes say "beyond the representable range".
   */
  limitReasons?: readonly string[];
}

export interface SpatialAxis { label: string; unitLabel: string }
/** An authorized `scene3d` view (the surface's `ProjectedView`). */
export interface SpatialView {
  viewId: string;
  kind: string;
  title: string;
  summary: string;
  /** [xmin, xmax, ymin, ymax, zmin, zmax] in canonical units: the authored teaching box, never rescaled silently. */
  bounds3?: readonly number[];
  equalAspect: boolean;
  axes?: { x: SpatialAxis; y: SpatialAxis; z?: SpatialAxis };
  marks: readonly SpatialMark[];
}

/** Serialized camera (the activity contract's `Camera3D`): model coordinates of the view, canonical units. */
export interface SpatialCamera {
  kind: '3d';
  projection: 'orthographic' | 'perspective';
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  preset: string | null;
}

export interface SpatialPresentationInput {
  /** Serialized camera for this view (null = the authored default). */
  camera: SpatialCamera | null;
  selection: string | null;
  /** Enabled presentation layers; `wireframe` starts sampled surfaces as wireframes. */
  layers: string[];
}

/**
 * Renderer state: `ready` draws on demand; `suspended` draws nothing while hidden or offscreen; `context-lost` shows a
 * visible state while a restore is attempted; `failed` means the graphics context could not be restored (a retry
 * button is shown and the 2D projection remains usable); `disposed` after teardown.
 */
export type SpatialStatus = 'ready' | 'suspended' | 'context-lost' | 'failed' | 'disposed';

export interface SpatialMountOptions {
  view: SpatialView;
  presentation: SpatialPresentationInput;
  /** Called at the end of a camera gesture, preset, reset or projection change — never per animation frame. */
  onCamera(camera: SpatialCamera): void;
  onSelect(target: string | null): void;
  /** No automatic animation: camera presets jump instead of easing. */
  reducedMotion: boolean;
  /** Optional status listener (context loss, recovery, failure); the surface uses it to show its 2D fallback. */
  onStatus?(status: SpatialStatus, message: string | null): void;
  /**
   * The host surface's wording of what its 2D alternative carries for this view, read each time the lost- or
   * failed-context state is shown or the view is updated while it is shown. Without it the state names no alternative:
   * the renderer cannot know what the surface's projection and table hold.
   */
  describeAlternative?(): string;
  /**
   * Limits of the `spatial-3d@1.0` capability record the activity requires (vertices, indices, field samples, labels,
   * texture size, draw calls per frame). Each is enforced up to the renderer's own maximum (`SPATIAL_LIMITS`).
   */
  limits?: { vertices?: number; indices?: number; fieldSamples?: number; labels?: number; textureSize?: number; drawCallsPerFrame?: number };
}

/** Live resource and work counters of one mounted renderer (report §13, A47). */
export interface SpatialStats {
  status: SpatialStatus;
  /** `renderer.render` calls since mount (frames are rendered on demand only). */
  frames: number;
  /** Geometries, materials and textures this instance created and has not yet disposed (own registry). */
  geometries: number;
  materials: number;
  textures: number;
  /** `renderer.info.memory` and program cache size (0 after disposal; the renderer's caches die with it). */
  rendererGeometries: number;
  rendererTextures: number;
  programs: number;
  /** DOM/event listeners, observers and pending timers or animation frames owned by this instance. */
  listeners: number;
  observers: number;
  pending: number;
  /** Data-derived vertices, indices, field samples and labels of the current drawing (see `SPATIAL_LIMITS`). */
  vertices: number;
  indices: number;
  fieldSamples: number;
  labels: number;
  /** Draw calls of the last rendered frame (bounded by `drawCallsPerFrame`). */
  drawCalls: number;
}

export interface SpatialInstance {
  /** New projection or presentation for the same view; never changes scientific values. */
  update(view: SpatialView, presentation?: SpatialPresentationInput): void;
  /** Releases geometries, materials, renderer, observers, listeners and pending frames. Idempotent. */
  dispose(): void;
  stats(): SpatialStats;
}
