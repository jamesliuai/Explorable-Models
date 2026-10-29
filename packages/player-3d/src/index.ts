/**
 * `@explorable-models/player-3d`: the optional, lazily loaded spatial renderer for `scene3d` views of Study Harness
 * activities (report §13). It implements the learner surface's `SpatialRendererModule` contract
 * (`webglAvailable`, `mount`) and draws bounded scientific primitives strictly from the authorized projection.
 * Load it only through the host's `spatialLoader`, e.g. `() => import('@explorable-models/player-3d')`; nothing on the
 * 2D path imports it. Three.js is a peer dependency.
 */
export { inspect, mount, releaseIdleRenderers, RESTORE_ATTEMPTS, webglAvailable } from './mount.js';
export { IDLE_RENDERER_LIMIT } from './pool.js';
export { SPATIAL_LIMITS, planSpatialScene } from './plan.js';
export type { SpatialLimits, SpatialNote, SpatialPlan } from './plan.js';
export { CAMERA_LIMITS, CAMERA_PRESETS, PRESET_ORDER } from './camera.js';
export type { Orbit, PresetId, Projection } from './camera.js';
export { SPATIAL_STYLESHEET } from './styles.js';
export type { InspectedArrow, SpatialInspection } from './controller.js';
export type {
  LabelAnchor, SpatialCamera, SpatialInstance, SpatialMark, SpatialMarkStyle, SpatialMountOptions, SpatialPresentationInput, SpatialStats, SpatialStatus, SpatialView,
} from './types.js';
