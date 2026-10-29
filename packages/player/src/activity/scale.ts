/**
 * Pure 2D view mathematics for the learner surface: nice ticks, the camera → visible-domain mapping, equal-aspect
 * fitting and camera operations. This is presentation only. It never evaluates the model: every coordinate it maps
 * comes from the projected frame, and a camera never changes scientific state (revisions.md, presentation space).
 */
import type { Camera2D } from '@explorable-models/activity';

/** `[xmin, xmax, ymin, ymax]` in the view's display units. */
export type Bounds2 = [number, number, number, number];
export interface Rect { x: number; y: number; width: number; height: number }
export type Point = [number, number];

/** Matches the presentation schema (`Camera2D.zoom` ≤ 1e6) and keeps centres within the contract number range. */
export const CAMERA_LIMITS = Object.freeze({ minZoom: 1e-6, maxZoom: 1e6, maxCenter: 1e15, zoomStep: 1.5, panFraction: 0.1 });
const DEFAULT_BOUNDS: Bounds2 = [-1, 1, -1, 1];

export const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
export const validBounds = (bounds: readonly number[] | undefined | null): bounds is Bounds2 =>
  !!bounds && bounds.length >= 4 && bounds.slice(0, 4).every(isFiniteNumber) && bounds[1] > bounds[0] && bounds[3] > bounds[2];
export const boundsOf = (bounds: readonly number[] | undefined | null): Bounds2 => validBounds(bounds) ? [bounds[0], bounds[1], bounds[2], bounds[3]] : DEFAULT_BOUNDS;

/** Tick spacing from the 1–2–2.5–5 family that yields at most `maxTicks` intervals across `span`. */
export function niceStep(span: number, maxTicks: number): number {
  if (!(span > 0) || !Number.isFinite(span)) return 1;
  const raw = span / Math.max(1, Math.floor(maxTicks));
  const power = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / power;
  const nice = fraction <= 1 + 1e-9 ? 1 : fraction <= 2 + 1e-9 ? 2 : fraction <= 2.5 + 1e-9 ? 2.5 : fraction <= 5 + 1e-9 ? 5 : 10;
  return nice * power;
}

/** Ticks at multiples of a nice step inside `[min, max]`; values are cleaned of binary noise and negative zero. */
export function niceTicks(min: number, max: number, maxTicks: number): { step: number; ticks: number[] } {
  if (!isFiniteNumber(min) || !isFiniteNumber(max) || !(max > min)) return { step: 1, ticks: [] };
  const step = niceStep(max - min, maxTicks);
  const first = Math.ceil(min / step - 1e-9), last = Math.floor(max / step + 1e-9);
  const ticks: number[] = [];
  for (let k = first; k <= last && ticks.length <= 2 * maxTicks + 2; k++) {
    const value = Number((k * step).toPrecision(12));
    ticks.push(Object.is(value, -0) ? 0 : value);
  }
  return { step, ticks };
}

/**
 * The densest nice ticks (at most 10 intervals) whose labels fit: `labelPx` measures the widest label for a candidate
 * set (labels change with the step, e.g. 2.5 needs a decimal), and adjacent labels keep at least `gapPx` apart.
 */
export function fitTicks(min: number, max: number, lengthPx: number, labelPx: (ticks: number[], step: number) => number, gapPx = 8): { step: number; ticks: number[] } {
  if (!isFiniteNumber(min) || !isFiniteNumber(max) || !(max > min)) return { step: 1, ticks: [] };
  for (let budget = 10; budget >= 2; budget--) {
    const candidate = niceTicks(min, max, budget);
    if (candidate.ticks.length <= 2) return candidate;
    const spacing = lengthPx * candidate.step / (max - min);
    if (labelPx(candidate.ticks, candidate.step) + gapPx <= spacing) return candidate;
  }
  return niceTicks(min, max, 1);
}

export function clampCamera(camera: Camera2D): Camera2D {
  const zoom = isFiniteNumber(camera.zoom) ? Math.min(CAMERA_LIMITS.maxZoom, Math.max(CAMERA_LIMITS.minZoom, camera.zoom)) : 1;
  const clampCenter = (value: number) => isFiniteNumber(value) ? Math.min(CAMERA_LIMITS.maxCenter, Math.max(-CAMERA_LIMITS.maxCenter, value)) : 0;
  return { kind: '2d', center: [clampCenter(camera.center[0]), clampCenter(camera.center[1])], zoom };
}

/** Visible domain for authored `bounds` and a camera (null = the authored teaching default). */
export function cameraDomain(bounds: Bounds2, camera: Camera2D | null): Bounds2 {
  if (!camera) return bounds;
  const { center, zoom } = clampCamera(camera);
  const halfX = (bounds[1] - bounds[0]) / 2 / zoom, halfY = (bounds[3] - bounds[2]) / 2 / zoom;
  return [center[0] - halfX, center[0] + halfX, center[1] - halfY, center[1] + halfY];
}

/** Camera equivalent to the authored bounds (zoom 1, centred). */
export const authoredCamera = (bounds: Bounds2): Camera2D => ({ kind: '2d', center: [(bounds[0] + bounds[1]) / 2, (bounds[2] + bounds[3]) / 2], zoom: 1 });

export function zoomCamera(bounds: Bounds2, camera: Camera2D | null, factor: number, focus?: Point): Camera2D {
  const current = camera ? clampCamera(camera) : authoredCamera(bounds);
  const zoom = Math.min(CAMERA_LIMITS.maxZoom, Math.max(CAMERA_LIMITS.minZoom, current.zoom * factor));
  const applied = zoom / current.zoom;
  const [fx, fy] = focus ?? current.center;
  return clampCamera({ kind: '2d', center: [fx + (current.center[0] - fx) / applied, fy + (current.center[1] - fy) / applied], zoom });
}

/** Pans by fractions of the visible span (positive x right, positive y up). */
export function panCamera(bounds: Bounds2, camera: Camera2D | null, fractionX: number, fractionY: number): Camera2D {
  const current = camera ? clampCamera(camera) : authoredCamera(bounds);
  const domain = cameraDomain(bounds, current);
  return clampCamera({ kind: '2d', center: [current.center[0] + fractionX * (domain[1] - domain[0]), current.center[1] + fractionY * (domain[3] - domain[2])], zoom: current.zoom });
}

/** Pans so that a data-space displacement follows the pointer. */
export const translateCamera = (bounds: Bounds2, camera: Camera2D | null, dx: number, dy: number): Camera2D => {
  const current = camera ? clampCamera(camera) : authoredCamera(bounds);
  return clampCamera({ kind: '2d', center: [current.center[0] - dx, current.center[1] - dy], zoom: current.zoom });
};

/**
 * Explicit fit-to-data: a camera whose domain contains `extent` with `padding` on each side. A zero-width extent keeps
 * the authored span on that axis; a single point keeps the authored zoom.
 */
export function fitCamera(bounds: Bounds2, extent: Bounds2, padding = 0.08): Camera2D {
  const spanX = extent[1] - extent[0], spanY = extent[3] - extent[2];
  const zx = spanX > 0 ? (bounds[1] - bounds[0]) / (spanX * (1 + 2 * padding)) : Infinity;
  const zy = spanY > 0 ? (bounds[3] - bounds[2]) / (spanY * (1 + 2 * padding)) : Infinity;
  const zoom = Math.min(zx, zy);
  return clampCamera({ kind: '2d', center: [(extent[0] + extent[1]) / 2, (extent[2] + extent[3]) / 2], zoom: Number.isFinite(zoom) ? zoom : 1 });
}

export const sameCamera = (a: Camera2D | null, b: Camera2D | null): boolean =>
  a === b || (!!a && !!b && a.zoom === b.zoom && a.center[0] === b.center[0] && a.center[1] === b.center[1]);

export interface PlotFrame {
  /** Domain actually shown (expanded on one axis for equal aspect so the plot box is filled). */
  domain: Bounds2;
  plot: Rect;
  /** Pixels per display unit on each axis (equal when `equalAspect`). */
  scaleX: number;
  scaleY: number;
  toScreen(x: number, y: number): Point;
  fromScreen(px: number, py: number): Point;
}

/** Maps a domain onto a plot rectangle (y up). Equal aspect expands the domain about its centre rather than letterboxing. */
export function fitFrame(domain: Bounds2, plot: Rect, equalAspect: boolean): PlotFrame {
  let [x0, x1, y0, y1] = domain;
  let scaleX = plot.width / (x1 - x0), scaleY = plot.height / (y1 - y0);
  if (equalAspect) {
    const scale = Math.min(scaleX, scaleY);
    const halfX = plot.width / scale / 2, halfY = plot.height / scale / 2, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    [x0, x1, y0, y1] = [cx - halfX, cx + halfX, cy - halfY, cy + halfY];
    scaleX = scaleY = scale;
  }
  return {
    domain: [x0, x1, y0, y1], plot, scaleX, scaleY,
    toScreen: (x, y) => [plot.x + (x - x0) * scaleX, plot.y + plot.height - (y - y0) * scaleY],
    fromScreen: (px, py) => [x0 + (px - plot.x) / scaleX, y0 + (plot.y + plot.height - py) / scaleY],
  };
}

/** Natural plot height for a width: geometry keeps its declared aspect within readable limits; charts use a fixed ratio. */
export function plotHeight(width: number, domain: Bounds2, equalAspect: boolean, fontPx: number): number {
  const min = Math.max(180, fontPx * 12), max = Math.max(min, Math.min(520, fontPx * 34));
  const natural = equalAspect ? width * (domain[3] - domain[2]) / (domain[1] - domain[0]) : width * 0.62;
  return Math.round(Math.min(max, Math.max(min, natural)));
}

export const insideDomain = (domain: Bounds2, x: number, y: number, tolerance = 1e-9): boolean => {
  const tx = tolerance * (domain[1] - domain[0]), ty = tolerance * (domain[3] - domain[2]);
  return x >= domain[0] - tx && x <= domain[1] + tx && y >= domain[2] - ty && y <= domain[3] + ty;
};

/** Grows `domain` by `fraction` of its span on every side. */
export const expandDomain = (domain: Bounds2, fraction: number): Bounds2 => {
  const dx = (domain[1] - domain[0]) * fraction, dy = (domain[3] - domain[2]) * fraction;
  return [domain[0] - dx, domain[1] + dx, domain[2] - dy, domain[3] + dy];
};

/**
 * Liang–Barsky clipping of segment p→q to `box` (data space, before any pixel mapping, so huge coordinates never
 * overflow the SVG). Returns the visible part or null.
 */
export function clipSegment(p: Point, q: Point, box: Bounds2): [Point, Point] | null {
  return clipParametric(p, q, box, 0, 1);
}

/**
 * The part of the unbounded line through p and q that lies in `box` (data space), or null when the line misses the box
 * or p = q (no direction). Used for marks whose segments depict lines (`extent: 'line'`).
 */
export function clipLine(p: Point, q: Point, box: Bounds2): [Point, Point] | null {
  if (p[0] === q[0] && p[1] === q[1]) return null;
  return clipParametric(p, q, box, -Infinity, Infinity);
}

function clipParametric(p: Point, q: Point, box: Bounds2, from: number, to: number): [Point, Point] | null {
  const dx = q[0] - p[0], dy = q[1] - p[1];
  let t0 = from, t1 = to;
  const edges: [number, number][] = [[-dx, p[0] - box[0]], [dx, box[1] - p[0]], [-dy, p[1] - box[2]], [dy, box[3] - p[1]]];
  for (const [denominator, numerator] of edges) {
    if (denominator === 0) { if (numerator < 0) return null; continue; }
    const t = numerator / denominator;
    if (denominator < 0) { if (t > t1) return null; if (t > t0) t0 = t; }
    else { if (t < t0) return null; if (t < t1) t1 = t; }
  }
  // A direction too small to resolve against the box (a line through two nearly equal points) is not drawn.
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return null;
  const a: Point = [p[0] + t0 * dx, p[1] + t0 * dy], b: Point = [p[0] + t1 * dx, p[1] + t1 * dy];
  return a.every(Number.isFinite) && b.every(Number.isFinite) ? [a, b] : null;
}
