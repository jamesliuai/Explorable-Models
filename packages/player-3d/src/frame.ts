/**
 * The drawing frame of a `scene3d` view: the authored box, the model→world mapping and the axis ticks. Pure.
 *
 * World coordinates are model coordinates centred on the box, scaled per axis by a positive factor (never mirrored,
 * so the right-handed model frame stays right-handed on screen). With `equalAspect` every factor is 1. Otherwise x and
 * y keep a common scale and only z is rescaled so its extent is 0.75 of the larger horizontal extent; that difference
 * is disclosed to the learner (`aspectNote`). The mapping only places already-evaluated values; it computes nothing
 * scientific.
 */
import type { SpatialView } from './types.js';
import { isFiniteNumber, vec3, type Vec3 } from './vec.js';

export type Bounds3 = [number, number, number, number, number, number];
export interface AxisTicks { step: number; values: number[] }
export interface ViewFrame {
  readonly bounds: Bounds3;
  /** Box centre in model coordinates (world origin). */
  readonly center: Vec3;
  /** World units per model unit along x, y and z (all positive). */
  readonly scale: Vec3;
  /** Radius of the world-space bounding sphere of the box. */
  readonly radius: number;
  /** Where the three axes cross (model): 0 on each axis whose range contains it, otherwise the minimum. */
  readonly axisOrigin: Vec3;
  readonly ticks: [AxisTicks, AxisTicks, AxisTicks];
  readonly axisNames: [string, string, string];
  /** Learner-facing disclosure when z is drawn at a different scale from x and y; null for equal aspect. */
  readonly aspectNote: string | null;
  readonly boundsSource: 'authored' | 'data' | 'default';
  /**
   * Radius (world units, around the box centre) that the camera fits at zoom 1: the default framing of the axes, their
   * names and the drawn data inside the box (`framingRadius` in camera.ts). Absent: the box's bounding sphere (`radius`).
   */
  readonly framing?: number;
}

export const Z_EXTENT_RATIO = 0.75;
const MAX_TICKS = 13;

const validBounds = (bounds: readonly number[] | undefined): bounds is Bounds3 =>
  Array.isArray(bounds) && bounds.length === 6 && bounds.every(isFiniteNumber) && bounds[0]! < bounds[1]! && bounds[2]! < bounds[3]! && bounds[4]! < bounds[5]!;

/** Nice tick step (1, 2 or 5 × 10^k) for about `target` intervals. */
export function niceStep(range: number, target: number): number {
  const raw = range / Math.max(1, target);
  const power = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / power;
  return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power;
}
/** Ticks inside [min, max] (inclusive, within rounding) at a nice step; at most 13. */
export function axisTicks(min: number, max: number, target = 4): AxisTicks {
  if (!(max > min)) return { step: 0, values: [] };
  let step = niceStep(max - min, target);
  while ((max - min) / step > MAX_TICKS - 1) step *= 2;
  const values: number[] = [];
  const first = Math.ceil(min / step - 1e-9);
  for (let k = first; k * step <= max + step * 1e-9 && values.length < MAX_TICKS; k++) {
    const value = Number((k * step).toPrecision(12));
    values.push(Object.is(value, -0) ? 0 : value);
  }
  return { step, values };
}

/** Finite coordinates of every mark (for views without authored bounds). */
function dataExtent(view: SpatialView): Bounds3 | null {
  let box: Bounds3 | null = null;
  const take = (point: Vec3 | null) => {
    if (!point) return;
    box = box ? [Math.min(box[0], point[0]), Math.max(box[1], point[0]), Math.min(box[2], point[1]), Math.max(box[3], point[1]), Math.min(box[4], point[2]), Math.max(box[5], point[2])]
      : [point[0], point[0], point[1], point[1], point[2], point[2]];
  };
  for (const mark of view.marks) {
    [mark.at, mark.from, mark.to].forEach(value => take(vec3(value ?? null)));
    const geometry = mark.geometry;
    if (!geometry) continue;
    switch (geometry.kind) {
      case 'points2': case 'points3': geometry.points.forEach(point => take(vec3(point.at))); break;
      case 'segments2': case 'segments3': geometry.segments.forEach(segment => { take(vec3(segment.from)); take(vec3(segment.to)); }); break;
      case 'polyline2': case 'polyline3': geometry.segments.forEach(segment => (segment.points as readonly (readonly number[])[]).forEach(point => take(vec3(point as number[])))); break;
      case 'vector-field2': case 'vector-field3': geometry.samples.forEach(sample => take(vec3(sample.at))); break;
      case 'polygon2': geometry.vertices.forEach(vertex => take(vec3(vertex))); break;
      case 'surface-grid': geometry.z.forEach((z, i) => { if (z !== null) take([geometry.xs[i % geometry.xs.length]!, geometry.ys[Math.floor(i / geometry.xs.length)]!, z]); }); break;
    }
  }
  if (!box) return null;
  const b = box as Bounds3;
  // Pad degenerate extents so every axis has a range.
  for (let axis = 0; axis < 3; axis++) if (!(b[axis * 2 + 1]! > b[axis * 2]!)) { b[axis * 2] -= 1; b[axis * 2 + 1] += 1; }
  return b;
}

const shortNumber = (value: number): string => {
  const text = Number(value.toPrecision(2)).toString();
  return text.replace('-', '−');
};

export function viewFrame(view: SpatialView): ViewFrame {
  const authored = validBounds(view.bounds3) ? [...view.bounds3] as Bounds3 : null;
  const data = authored ? null : dataExtent(view);
  const bounds: Bounds3 = authored ?? data ?? [-1, 1, -1, 1, -1, 1];
  const ranges: Vec3 = [bounds[1] - bounds[0], bounds[3] - bounds[2], bounds[5] - bounds[4]];
  const center: Vec3 = [(bounds[0] + bounds[1]) / 2, (bounds[2] + bounds[3]) / 2, (bounds[4] + bounds[5]) / 2];
  const horizontal = Math.max(ranges[0], ranges[1]);
  const zScale = view.equalAspect ? 1 : (Z_EXTENT_RATIO * horizontal) / ranges[2];
  const sameScale = Math.abs(zScale - 1) < 1e-9;
  const scale: Vec3 = [1, 1, sameScale ? 1 : zScale];
  const half: Vec3 = [ranges[0] * scale[0] / 2, ranges[1] * scale[1] / 2, ranges[2] * scale[2] / 2];
  const radius = Math.hypot(half[0], half[1], half[2]);
  const within = (axis: number) => bounds[axis * 2]! <= 0 && 0 <= bounds[axis * 2 + 1]!;
  const axisOrigin: Vec3 = [within(0) ? 0 : bounds[0], within(1) ? 0 : bounds[2], within(2) ? 0 : bounds[4]];
  const names: [string, string, string] = [view.axes?.x, view.axes?.y, view.axes?.z].map((axis, index) => {
    const name = axis?.label?.trim() || ['x', 'y', 'z'][index]!;
    return axis?.unitLabel ? `${name} (${axis.unitLabel})` : name;
  }) as [string, string, string];
  const aspectNote = sameScale ? null
    : `The vertical axis ${names[2]} is drawn at its own scale: one unit along it is drawn ${shortNumber(zScale)} times as long as one unit along ${names[0]} and ${names[1]}.`;
  return {
    bounds, center, scale, radius, axisOrigin, axisNames: names, aspectNote,
    ticks: [axisTicks(bounds[0], bounds[1]), axisTicks(bounds[2], bounds[3]), axisTicks(bounds[4], bounds[5])],
    boundsSource: authored ? 'authored' : data ? 'data' : 'default',
  };
}

export const toWorld = (frame: ViewFrame, p: Vec3): Vec3 =>
  [(p[0] - frame.center[0]) * frame.scale[0], (p[1] - frame.center[1]) * frame.scale[1], (p[2] - frame.center[2]) * frame.scale[2]];
export const toModel = (frame: ViewFrame, w: Vec3): Vec3 =>
  [w[0] / frame.scale[0] + frame.center[0], w[1] / frame.scale[1] + frame.center[1], w[2] / frame.scale[2] + frame.center[2]];
/** A model-space direction (or displacement) in world space; not normalized. */
export const directionToWorld = (frame: ViewFrame, d: Vec3): Vec3 => [d[0] * frame.scale[0], d[1] * frame.scale[1], d[2] * frame.scale[2]];
export const directionToModel = (frame: ViewFrame, d: Vec3): Vec3 => [d[0] / frame.scale[0], d[1] / frame.scale[1], d[2] / frame.scale[2]];
/** Two frames draw identically (box, scale, axes) — used to keep axes and camera when only marks change. */
export const sameFrame = (a: ViewFrame | null, b: ViewFrame): boolean =>
  !!a && a.bounds.every((value, i) => value === b.bounds[i]) && a.scale.every((value, i) => value === b.scale[i]) && a.axisNames.every((name, i) => name === b.axisNames[i]);

/** Plain learner numeral (up to 6 significant digits, U+2212 minus, no “−0”). */
export function formatNumber(value: number): string {
  const rounded = Number(value.toPrecision(6));
  return (Object.is(rounded, -0) ? '0' : String(rounded)).replace('-', '\u2212');
}

/** Tick label in canonical units: decimals from the step, U+2212 minus, no “−0”. */
export function formatTick(value: number, step: number): string {
  const decimals = step > 0 && step < 1 ? Math.min(6, Math.ceil(-Math.log10(step) - 1e-9)) : 0;
  const text = Math.abs(value) < step * 1e-9 ? '0' : value.toFixed(decimals);
  return text.replace('-', '−');
}
