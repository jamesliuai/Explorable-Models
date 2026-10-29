/**
 * Orbit camera math (report §11, §13): orientation presets, bounded keyboard/pointer rotation and zoom, and
 * serialization to the activity contract's `Camera3D`. Pure; the camera is presentation state and never touches
 * scientific values.
 *
 * The camera orbits the box centre (world origin) at azimuth α (about +z, from +x towards +y) and elevation ε
 * (−90°…90°). Screen-right is (−sin α, cos α, 0) and screen-up is right × forward, so the view never rolls and the
 * right-handed frame always appears right-handed: in the top preset x points right and y up (z toward the viewer), in
 * the front preset x right and z up (seen from −y), in the side preset y right and z up (seen from +x).
 */
import { directionToModel, directionToWorld, toModel, toWorld, type ViewFrame } from './frame.js';
import { axisLabels } from './plan.js';
import type { SpatialCamera } from './types.js';
import { cross, isFiniteNumber, length, normalize, scale, sub, type Vec3 } from './vec.js';

export type PresetId = 'isometric' | 'front' | 'top' | 'side';
export type Projection = 'orthographic' | 'perspective';
/** Elevation of the isometric direction (1, 1, 1): atan(1/√2). */
export const ISOMETRIC_ELEVATION = (Math.atan(1 / Math.SQRT2) * 180) / Math.PI;
export const CAMERA_PRESETS: Readonly<Record<PresetId, Readonly<{ azimuth: number; elevation: number; label: string; description: string }>>> = Object.freeze({
  isometric: Object.freeze({ azimuth: 45, elevation: ISOMETRIC_ELEVATION, label: 'Isometric', description: 'isometric view from the (+x, +y, +z) side' }),
  front: Object.freeze({ azimuth: -90, elevation: 0, label: 'Front (x–z)', description: 'front view of the x–z plane, seen from −y: x to the right, z up' }),
  top: Object.freeze({ azimuth: -90, elevation: 90, label: 'Top (x–y)', description: 'top view of the x–y plane, seen from +z: x to the right, y up' }),
  side: Object.freeze({ azimuth: 0, elevation: 0, label: 'Side (y–z)', description: 'side view of the y–z plane, seen from +x: y to the right, z up' }),
});
export const PRESET_ORDER: readonly PresetId[] = Object.freeze(['isometric', 'front', 'top', 'side']);
export const CAMERA_LIMITS = Object.freeze({
  /** Keyboard rotation step (degrees) and pointer rotation rate (degrees per CSS pixel). */
  rotateStep: 15, dragRate: 0.4,
  /** Zoom factor per step and its bounds (1 = the default framing fits the view, see `framingRadius`). */
  zoomStep: 1.25, minZoom: 0.25, maxZoom: 4,
  /** Vertical field of view of the perspective camera; the orthographic view matches it at the target. */
  fov: 40,
  /** Scale of the framing sphere that fits the view at zoom 1 (1: the sphere touches the frustum). */
  fitMargin: 1,
  /** Room around the framed axes, axis names and data for label text (a fraction of the framing radius). */
  framingMargin: 1.1,
});

export interface Orbit { azimuth: number; elevation: number; zoom: number; projection: Projection; preset: PresetId | null }
export interface Pose { position: Vec3; target: Vec3; up: Vec3; right: Vec3; forward: Vec3; distance: number; halfHeight: number }

const RAD = Math.PI / 180;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
/** Azimuth in (−180, 180]. */
export const wrapAzimuth = (degrees: number): number => {
  let value = ((degrees + 180) % 360 + 360) % 360 - 180;
  if (value === -180) value = 180;
  return Math.abs(value) < 1e-12 ? 0 : value;
};
const isPreset = (value: unknown): value is PresetId => typeof value === 'string' && Object.hasOwn(CAMERA_PRESETS, value);

/**
 * The authored default view (azimuth −20°, elevation 30°): from the front right and above, z up. It is chosen so that
 * the axes and the starting vectors of the bundled activities (u = (2, 1, 0), v = (1, 2, 2), u × v = (2, −4, 3)) are
 * each at least 30° from the line of sight and no starting vector runs within 20° of another one or of an axis on
 * screen. Any fixed view sees some direction end-on; the presets and bounded rotation cover the rest.
 */
export const DEFAULT_VIEW = Object.freeze({ azimuth: -20, elevation: 30 });
export const defaultOrbit = (projection: Projection = 'orthographic'): Orbit =>
  ({ azimuth: DEFAULT_VIEW.azimuth, elevation: DEFAULT_VIEW.elevation, zoom: 1, projection, preset: null });

type Framed = Pick<ViewFrame, 'radius' | 'framing'>;
/** The radius fitted at zoom 1: the frame's default framing, or the box's bounding sphere when it has none. */
const fitted = (frame: Framed): number => frame.framing ?? frame.radius;
/**
 * Camera distance at zoom 1: the framing sphere fits the vertical field of view (the horizontal one in a portrait
 * viewport), so no rotation clips what it frames. Without a framing that is the whole box.
 */
export const baseDistance = (frame: Framed): number => (fitted(frame) * CAMERA_LIMITS.fitMargin) / Math.sin((CAMERA_LIMITS.fov / 2) * RAD);

/**
 * Default framing of a spatial view (report §10.4; G55): the radius around the box centre (the orbit target) of the
 * three axes with their arrowheads and names, and of every drawn data point that lies inside the axis box, with room for
 * labels. Data drawn outside the box (disclosed by the planner's note) is not framed, so one long vector cannot shrink
 * the rest. A data set filling the box frames the whole box as before; a small one inside a large teaching box is drawn
 * large enough to read on a narrow card. `Whole box` (`wholeBoxZoom`) always shows the entire box.
 */
export function framingRadius(frame: ViewFrame, data: Iterable<Vec3>): number {
  let reach = 0;
  const take = (world: Vec3) => { const distance = length(world); if (Number.isFinite(distance) && distance > reach) reach = distance; };
  const { bounds, axisOrigin } = frame;
  for (let axis = 0; axis < 3; axis++) {
    const start: Vec3 = [...axisOrigin], end: Vec3 = [...axisOrigin];
    start[axis] = bounds[axis * 2]!; end[axis] = bounds[axis * 2 + 1]!;
    const tip = toWorld(frame, end);
    tip[axis] += frame.radius * 0.06; // the axis arrowhead's apex beyond the box (scene.ts buildAxes)
    take(toWorld(frame, start)); take(tip);
  }
  for (const label of axisLabels(frame)) if (label.kind === 'axis') take(toWorld(frame, label.at));
  const inside = (p: Vec3) => p.every((value, axis) => value >= bounds[axis * 2]! - 1e-9 && value <= bounds[axis * 2 + 1]! + 1e-9);
  for (const point of data) if (point.every(Number.isFinite) && inside(point)) take(toWorld(frame, point));
  return reach > 0 ? reach * CAMERA_LIMITS.framingMargin : frame.radius;
}
/** Zoom at which the whole box (its bounding sphere) fits again, whatever the framing. */
export const wholeBoxZoom = (frame: Framed): number => clamp(Number((fitted(frame) / frame.radius).toPrecision(12)), CAMERA_LIMITS.minZoom, CAMERA_LIMITS.maxZoom);

export function orbitPose(orbit: Orbit, frame: Framed): Pose {
  const alpha = orbit.azimuth * RAD, epsilon = orbit.elevation * RAD;
  const distance = baseDistance(frame) / orbit.zoom;
  const offset: Vec3 = [Math.cos(epsilon) * Math.cos(alpha), Math.cos(epsilon) * Math.sin(alpha), Math.sin(epsilon)];
  const position = scale(offset, distance);
  const forward = scale(offset, -1);
  const right: Vec3 = [-Math.sin(alpha), Math.cos(alpha), 0];
  const up = normalize(cross(right, forward)) ?? [0, 0, 1];
  return { position, target: [0, 0, 0], up, right, forward, distance, halfHeight: distance * Math.tan((CAMERA_LIMITS.fov / 2) * RAD) };
}

export function rotateOrbit(orbit: Orbit, deltaAzimuth: number, deltaElevation: number): Orbit {
  return { ...orbit, azimuth: wrapAzimuth(orbit.azimuth + deltaAzimuth), elevation: clamp(orbit.elevation + deltaElevation, -90, 90), preset: null };
}
export function zoomOrbit(orbit: Orbit, factor: number): Orbit {
  const zoom = clamp(Number((orbit.zoom * factor).toPrecision(12)), CAMERA_LIMITS.minZoom, CAMERA_LIMITS.maxZoom);
  return { ...orbit, zoom };
}
/** A preset keeps the current zoom and projection. */
export const presetOrbit = (orbit: Orbit, preset: PresetId): Orbit => ({ ...orbit, azimuth: CAMERA_PRESETS[preset].azimuth, elevation: CAMERA_PRESETS[preset].elevation, preset });

const round = (value: number): number => { const rounded = Math.round(value * 1e6) / 1e6; return Object.is(rounded, -0) ? 0 : rounded; };
const round3 = (v: Vec3): [number, number, number] => [round(v[0]), round(v[1]), round(v[2])];

/** Serialized camera in model coordinates (canonical units) for `binding.setCamera`. */
export function orbitToCamera(orbit: Orbit, frame: ViewFrame): SpatialCamera {
  const pose = orbitPose(orbit, frame);
  return {
    kind: '3d', projection: orbit.projection,
    position: round3(toModel(frame, pose.position)), target: round3(toModel(frame, pose.target)),
    up: round3(normalize(directionToModel(frame, pose.up)) ?? [0, 0, 1]), preset: orbit.preset,
  };
}

const finite3 = (value: unknown): value is [number, number, number] => Array.isArray(value) && value.length === 3 && value.every(isFiniteNumber);

/**
 * Orbit from a serialized camera, or null when it is malformed (not a 3D camera, non-finite, position equal to target,
 * unknown projection). A known preset restores its exact angles; otherwise the angles come from the position relative
 * to the target (and from `up` when looking straight down or up). The orbit always targets the box centre, has no
 * roll and keeps the zoom within its bounds.
 */
export function cameraToOrbit(camera: unknown, frame: ViewFrame): Orbit | null {
  if (!camera || typeof camera !== 'object') return null;
  const c = camera as Partial<SpatialCamera>;
  if (c.kind !== '3d' || (c.projection !== 'orthographic' && c.projection !== 'perspective') || !finite3(c.position) || !finite3(c.target) || !finite3(c.up)) return null;
  const offset = sub(toWorld(frame, c.position), toWorld(frame, c.target));
  const distance = length(offset);
  if (!(distance > 0) || !Number.isFinite(distance)) return null;
  const zoom = clamp(baseDistance(frame) / distance, CAMERA_LIMITS.minZoom, CAMERA_LIMITS.maxZoom);
  if (isPreset(c.preset)) return { azimuth: CAMERA_PRESETS[c.preset].azimuth, elevation: CAMERA_PRESETS[c.preset].elevation, zoom: Number(zoom.toPrecision(12)), projection: c.projection, preset: c.preset };
  const elevation = clamp(Math.asin(clamp(offset[2] / distance, -1, 1)) / RAD, -90, 90);
  let azimuth: number;
  if (Math.hypot(offset[0], offset[1]) > distance * 1e-9) azimuth = Math.atan2(offset[1], offset[0]) / RAD;
  else {
    // Looking straight down (up) the z-axis: screen-up is −(cos α, sin α, 0) from above and +(cos α, sin α, 0) from below.
    const up = normalize(directionToWorld(frame, c.up));
    if (!up || Math.hypot(up[0], up[1]) < 1e-9) return null;
    azimuth = elevation > 0 ? Math.atan2(-up[1], -up[0]) / RAD : Math.atan2(up[1], up[0]) / RAD;
  }
  return { azimuth: wrapAzimuth(Number(azimuth.toPrecision(12))), elevation: Number(elevation.toPrecision(12)), zoom: Number(zoom.toPrecision(12)), projection: c.projection, preset: null };
}

/** Same orbit within serialization rounding. */
export const sameOrbit = (a: Orbit, b: Orbit): boolean =>
  a.projection === b.projection && a.preset === b.preset && Math.abs(wrapAzimuth(a.azimuth - b.azimuth)) < 1e-4 && Math.abs(a.elevation - b.elevation) < 1e-4 && Math.abs(a.zoom / b.zoom - 1) < 1e-6;

const degrees = (value: number) => `${Math.round(value)}°`.replace('-', '\u2212');
/** Learner-facing camera description (announced after a committed camera change). */
export function describeOrbit(orbit: Orbit): string {
  const where = orbit.preset ? `${CAMERA_PRESETS[orbit.preset].label} view: ${CAMERA_PRESETS[orbit.preset].description}`
    : orbit.azimuth === DEFAULT_VIEW.azimuth && orbit.elevation === DEFAULT_VIEW.elevation ? `Default view from azimuth ${degrees(orbit.azimuth)} and elevation ${degrees(orbit.elevation)}`
      : `View from azimuth ${degrees(orbit.azimuth)} and elevation ${degrees(orbit.elevation)}`;
  const zoom = Math.abs(orbit.zoom - 1) < 1e-9 ? '' : `, zoom ${Number(orbit.zoom.toPrecision(3))}×`;
  return `${where}; ${orbit.projection} projection${zoom}.`;
}

/**
 * Projects a world point to CSS pixels for a viewport of `width` × `height` (the same projection the renderer's
 * cameras use): [x, y, depth], depth > 0 in front of the camera. Narrow viewports widen the vertical extent so the
 * box still fits horizontally.
 */
export function projectPoint(point: Vec3, orbit: Orbit, frame: Framed, width: number, height: number): Vec3 {
  const pose = orbitPose(orbit, frame);
  const aspect = width / height;
  const v = sub(point, pose.position);
  const x = v[0] * pose.right[0] + v[1] * pose.right[1] + v[2] * pose.right[2];
  const y = v[0] * pose.up[0] + v[1] * pose.up[1] + v[2] * pose.up[2];
  const depth = v[0] * pose.forward[0] + v[1] * pose.forward[1] + v[2] * pose.forward[2];
  const fit = Math.min(1, aspect);
  let nx: number, ny: number;
  if (orbit.projection === 'orthographic') {
    const half = pose.halfHeight / fit;
    nx = x / (half * aspect); ny = y / half;
  } else {
    const tan = Math.tan((CAMERA_LIMITS.fov / 2) * RAD) / fit;
    nx = x / (depth * tan * aspect); ny = y / (depth * tan);
  }
  return [(nx + 1) / 2 * width, (1 - ny) / 2 * height, depth];
}

/** Vertical field of view (degrees) for a viewport aspect, widened when the viewport is narrower than tall. */
export const verticalFov = (aspect: number): number => {
  const fit = Math.min(1, aspect);
  return (2 * Math.atan(Math.tan((CAMERA_LIMITS.fov / 2) * RAD) / fit)) / RAD;
};
