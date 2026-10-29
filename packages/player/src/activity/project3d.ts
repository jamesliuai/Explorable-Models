/**
 * Orthographic coordinate projections of a `scene3d` view onto one coordinate plane (report §11, §13): the 2D
 * alternative used when no spatial renderer is configured, it fails to load, or WebGL is unavailable. Projection only
 * selects two of the three supplied display coordinates; it never evaluates the model. The coordinate table that
 * accompanies it lists the full 3D values, because a projection alone does not carry all spatial information.
 */
import type { ProjectedMark, ProjectedView } from '@explorable-models/activity';
import type { GeometryResult } from '@explorable-models/core/model';
import { formatShown } from './format.js';
import { END_ON_ARROWS, END_ON_SEGMENTS, type EndOnArrow } from './plan.js';

export type ProjectionPlane = 'xy' | 'xz' | 'yz';
export const PROJECTION_PLANES: readonly ProjectionPlane[] = Object.freeze(['xy', 'xz', 'yz']);
const AXES: Record<ProjectionPlane, [number, number]> = { xy: [0, 1], xz: [0, 2], yz: [1, 2] };
const AXIS_NAMES = ['x', 'y', 'z'] as const;

type Vec3Like = readonly number[] | null | undefined;
const pick = (value: Vec3Like, [i, j]: [number, number]): [number, number] | null =>
  Array.isArray(value) && value.length === 3 && Number.isFinite(value[i]) && Number.isFinite(value[j]) ? [value[i], value[j]] : null;
const pickList = (value: number[] | null | undefined, axes: [number, number]): number[] | null => {
  const picked = pick(value, axes);
  return picked ? [...picked] : null;
};

function projectGeometry(geometry: GeometryResult, axes: [number, number]): GeometryResult {
  switch (geometry.kind) {
    case 'polyline3':
      return { kind: 'polyline2', gaps: geometry.gaps, segments: geometry.segments.map(segment => ({ start: segment.start, end: segment.end, points: segment.points.map(point => pick(point, axes) ?? [NaN, NaN]) })) };
    case 'points3':
      return { kind: 'points2', points: geometry.points.map(point => ({ id: point.id, at: pick(point.at, axes), reason: point.reason })) };
    case 'segments3': {
      // A segment seen end-on (nonzero in 3D, a point in this plane) is recorded, so the plan does not call it a zero vector.
      const endOn = new Set<string>();
      const projected: GeometryResult = { kind: 'segments2', segments: geometry.segments.flatMap(segment => {
        const from = pick(segment.from, axes), to = pick(segment.to, axes);
        if (!from || !to) return [];
        if (from[0] === to[0] && from[1] === to[1] && segment.from.some((value, i) => value !== segment.to[i])) endOn.add(segment.id);
        return [{ id: segment.id, from, to }];
      }) };
      if (endOn.size) END_ON_SEGMENTS.set(projected, endOn);
      return projected;
    }
    case 'vector-field3':
      return { kind: 'vector-field2', scale: geometry.scale, samples: geometry.samples.flatMap(sample => { const at = pick(sample.at, axes), vector = pick(sample.vector, axes); return at && vector ? [{ at, vector }] : []; }) };
    case 'surface-grid': {
      // The sampled surface becomes its grid lines (rows and columns); undefined samples split the lines.
      const { xs, ys, z } = geometry;
      const value = (i: number, j: number): [number, number, number] | null => { const height = z[j * xs.length + i]; return height === null || height === undefined ? null : [xs[i], ys[j], height]; };
      const segments: { start: 'none'; end: 'none'; points: [number, number][] }[] = [];
      const line = (points: ([number, number, number] | null)[]) => {
        let run: [number, number][] = [];
        for (const point of points) {
          const projected = point ? pick(point, axes) : null;
          if (projected) run.push(projected);
          else { if (run.length) segments.push({ start: 'none', end: 'none', points: run }); run = []; }
        }
        if (run.length) segments.push({ start: 'none', end: 'none', points: run });
      };
      for (let j = 0; j < ys.length; j++) line(xs.map((_, i) => value(i, j)));
      for (let i = 0; i < xs.length; i++) line(ys.map((_, j) => value(i, j)));
      return { kind: 'polyline2', segments, gaps: [] };
    }
    default:
      return geometry;
  }
}

const vec3 = (value: Vec3Like): readonly number[] | null => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite) ? value : null;
/**
 * A positioned arrow (`from`/`at`, or the origin, to `to` or `+ vector`) whose 3D arrow is not zero but lies along the
 * axis this plane leaves out, so its projection is a point; null for any other arrow, a true zero vector included.
 */
function endOnArrow(mark: ProjectedMark, axes: [number, number]): EndOnArrow | null {
  if (mark.kind !== 'arrow' || mark.geometry) return null;
  const at = vec3(mark.at), from = vec3(mark.from), to = vec3(mark.to), vector = vec3(mark.vector);
  const tail = from ?? at ?? (vector ? [0, 0, 0] : null);
  const tip = to ?? (tail && vector ? tail.map((value, i) => value + vector[i]!) : null);
  if (!tail || !tip) return null;
  const hidden = 3 - axes[0] - axes[1];
  if (tail[axes[0]] !== tip[axes[0]] || tail[axes[1]] !== tip[axes[1]] || tail[hidden] === tip[hidden]) return null;
  const along = tip[hidden]! - tail[hidden]!;
  return { axis: AXIS_NAMES[hidden]!, sign: along < 0 ? -1 : 1, length: Math.abs(along) };
}

/** Projects one mark; marks that are already 2D pass through unchanged. */
export function projectMark(mark: ProjectedMark, plane: ProjectionPlane): ProjectedMark {
  const axes = AXES[plane];
  const projected: ProjectedMark = {
    ...mark,
    kind: mark.kind === 'surface' ? 'curve' : mark.kind,
    geometry: mark.geometry ? projectGeometry(mark.geometry, axes) : undefined,
    at: mark.at === undefined ? undefined : pickList(mark.at, axes),
    vector: mark.vector === undefined ? undefined : pickList(mark.vector, axes),
    from: mark.from === undefined ? undefined : pickList(mark.from, axes),
    to: mark.to === undefined ? undefined : pickList(mark.to, axes),
    // Dragging a projected point would edit only two of three coordinates; exact controls remain the alternative.
    draggable: undefined,
  };
  // An arrow seen end-on is recorded, so the plan does not call it a zero vector (as for end-on segments).
  const endOn = endOnArrow(mark, axes);
  if (endOn) END_ON_ARROWS.set(projected, endOn);
  return projected;
}

/** A `scene3d` view as an equal-aspect 2D view on `plane`, with axis labels and a summary that names the projection. */
export function projectView(view: ProjectedView, plane: ProjectionPlane): ProjectedView {
  const axes = AXES[plane];
  const b = view.bounds3;
  const bounds: [number, number, number, number] | undefined = b ? [b[axes[0] * 2], b[axes[0] * 2 + 1], b[axes[1] * 2], b[axes[1] * 2 + 1]] : view.bounds;
  const axisSpec = (index: number) => view.axes ? (index === 0 ? view.axes.x : index === 1 ? view.axes.y : view.axes.z) : undefined;
  const horizontal = axisSpec(axes[0]), vertical = axisSpec(axes[1]);
  const planeName = `${AXIS_NAMES[axes[0]]}–${AXIS_NAMES[axes[1]]}`;
  return {
    ...view,
    kind: 'scene2d',
    bounds,
    bounds3: undefined,
    equalAspect: true,
    axes: horizontal && vertical ? { x: horizontal, y: vertical } : undefined,
    marks: view.marks.map(mark => projectMark(mark, plane)),
    summary: `${view.summary} Shown as a projection onto the ${planeName} plane; the ${AXIS_NAMES[3 - axes[0] - axes[1]]} coordinate is not shown in this drawing but is listed in the coordinate table.`,
  };
}

export interface CoordinateRow { key: string; label: string; cells: string[] }
/** Rows listed per mark in the coordinate table; longer lists say how many are shown. */
export const COORDINATE_ROW_LIMIT = 50;
const tuple = (value: readonly number[] | null | undefined, locale?: string): string | null => Array.isArray(value) ? `(${value.map(n => formatShown(n, locale)).join(', ')})` : null;
/**
 * The text of coordinates that have no value, with their reason: a numerical limit (the projection's `limitReasons`)
 * reads as beyond the numerical range, never as undefined (report §8.2, A11), in the wording of formatted values.
 */
const missing = (mark: ProjectedMark, reason: string | undefined): string =>
  reason && mark.limitReasons?.includes(reason) ? `Beyond numerical range (${reason.trim().replace(/\.+$/, '')})` : `Undefined${reason ? `: ${reason}` : ''}`;
/**
 * Row names are learner text (report §10.4, §11): the mark's label, and a segment's ID only where the 3D drawing shows
 * that ID — the segments of a directed `segments` mark, or several directed segments, named at their tips (the rule of
 * `namesSegments` in `@explorable-models/player-3d`, which this package does not import; tests/player-activity/
 * coordinate-table.test.ts checks that the two agree). The segments of an undirected mark carry no name in the
 * drawing, so they are listed by their order. A positioned mark with several coordinates names each by a word, never
 * by a property key.
 */
const isDirected = (mark: ProjectedMark): boolean => mark.kind === 'arrow' || ((mark.kind === 'segment' || mark.kind === 'segments') && mark.style.marker === 'triangle');
const namesSegments = (mark: ProjectedMark, count: number): boolean => isDirected(mark) && (mark.kind === 'segments' || count > 1);
const segmentName = (mark: ProjectedMark, id: string, index: number, count: number): string =>
  namesSegments(mark, count) ? `${mark.label}: ${id}` : count === 1 ? mark.label : `${mark.label}, segment ${index + 1}`;
const ROLE_WORDS = { at: 'position', from: 'start', to: 'end', vector: 'components' } as const;

/**
 * Full 3D coordinates of every positioned mark and the first {@link COORDINATE_ROW_LIMIT} points of each point set. A
 * mark with a start and an end is one row (`start → end`); a point mark positioned by a one-point geometry is listed
 * once.
 */
export function coordinateRows(view: ProjectedView, locale?: string): CoordinateRow[] {
  const rows: CoordinateRow[] = [];
  for (const mark of view.marks) {
    const points = mark.geometry?.kind === 'points3' ? mark.geometry.points : null;
    const cell = (value: number[] | null | undefined) => tuple(value, locale) ?? missing(mark, mark.undefinedReason);
    const entries: { role: keyof typeof ROLE_WORDS; text: string }[] = [];
    // The projection copies the point of a one-point geometry into `at`: that geometry row lists it.
    if (mark.at !== undefined && !(points && points.length === 1)) entries.push({ role: 'at', text: cell(mark.at) });
    if (mark.from !== undefined && mark.to !== undefined) entries.push({ role: 'from', text: `${cell(mark.from)} → ${cell(mark.to)}` });
    else {
      if (mark.from !== undefined) entries.push({ role: 'from', text: cell(mark.from) });
      if (mark.to !== undefined) entries.push({ role: 'to', text: cell(mark.to) });
    }
    if (mark.vector !== undefined) entries.push({ role: 'vector', text: cell(mark.vector) });
    for (const entry of entries) {
      const word = entry.role === 'from' && mark.to !== undefined ? 'start → end' : ROLE_WORDS[entry.role];
      rows.push({ key: `${mark.markId}:${entry.role}`, label: entries.length === 1 ? mark.label : `${mark.label}: ${word}`, cells: [entry.text, mark.value?.text ?? ''] });
    }
    if (points) {
      points.slice(0, COORDINATE_ROW_LIMIT).forEach((point, index) => rows.push({
        key: `${mark.markId}:${point.id}`, label: points.length === 1 ? mark.label : `${mark.label}, point ${index + 1}`,
        cells: [tuple(point.at, locale) ?? missing(mark, point.reason), points.length === 1 ? mark.value?.text ?? '' : ''],
      }));
    }
  }
  return rows;
}

export interface CoordinateTable {
  rows: CoordinateRow[];
  /** What the table does not list in full, in words (truncated lists, curves, surfaces and fields that are summarised). */
  notes: string[];
  /** True when every drawn item of the view is listed in full. */
  complete: boolean;
}
/**
 * The coordinate table that accompanies a 2D projection of a 3D view (report §11, §13): every segment (start → end),
 * positioned mark and point, at most {@link COORDINATE_ROW_LIMIT} per mark with a note saying how many are shown; curves,
 * sampled surfaces and vector fields get one summary row each (with a note), because listing thousands of samples is
 * not a usable table. `complete` says whether the table carries everything the view draws.
 */
export function coordinateTable(view: ProjectedView, locale?: string): CoordinateTable {
  const rows: CoordinateRow[] = [];
  const notes: string[] = [];
  const shown = (label: string, listed: number, total: number, noun: string) => { if (listed < total) notes.push(`${label}: showing ${listed} of ${total} ${noun}.`); };
  for (const mark of view.marks) {
    const geometry = mark.geometry;
    if (geometry?.kind === 'segments3') {
      const count = geometry.segments.length;
      geometry.segments.slice(0, COORDINATE_ROW_LIMIT).forEach((segment, index) => rows.push({ key: `${mark.markId}:${segment.id}`, label: segmentName(mark, segment.id, index, count), cells: [`${tuple(segment.from, locale)} → ${tuple(segment.to, locale)}`, ''] }));
      shown(mark.label, Math.min(COORDINATE_ROW_LIMIT, geometry.segments.length), geometry.segments.length, 'segments');
    } else if (geometry?.kind === 'points3') {
      shown(mark.label, Math.min(COORDINATE_ROW_LIMIT, geometry.points.length), geometry.points.length, 'points');
    } else if (geometry?.kind === 'polyline3') {
      const count = geometry.segments.reduce((sum, segment) => sum + segment.points.length, 0);
      rows.push({ key: `${mark.markId}:summary`, label: mark.label, cells: [`A curve through ${count} sampled points (not listed here)`, ''] });
      notes.push(`${mark.label}: a curve of ${count} sampled points is summarised, not listed point by point.`);
    } else if (geometry?.kind === 'surface-grid') {
      const [x0, x1, y0, y1] = geometry.sampling.domain;
      const defined = geometry.z.filter(z => z !== null).length;
      rows.push({ key: `${mark.markId}:summary`, label: mark.label, cells: [`A surface sampled on a ${geometry.xs.length} × ${geometry.ys.length} grid for x from ${formatShown(x0, locale)} to ${formatShown(x1, locale)} and y from ${formatShown(y0, locale)} to ${formatShown(y1, locale)} (heights not listed here)`, ''] });
      notes.push(`${mark.label}: a sampled surface (${defined} of ${geometry.z.length} heights defined) is summarised, not listed point by point.`);
    } else if (geometry?.kind === 'vector-field3') {
      rows.push({ key: `${mark.markId}:summary`, label: mark.label, cells: [`${geometry.samples.length} arrows sampled on a grid (not listed here)`, ''] });
      notes.push(`${mark.label}: a field of ${geometry.samples.length} arrows is summarised, not listed arrow by arrow.`);
    }
  }
  rows.push(...coordinateRows(view, locale));
  return { rows, notes, complete: notes.length === 0 };
}

/**
 * What the 2D alternative of a 3D view carries, said exactly (report §11, G54): everything the 3D view draws when the
 * coordinate table is complete, otherwise the projection plus the positioned items with the rest summarised, naming the
 * activity's own tables (titles) that list values in full. The surface shows it with its fallback, and the spatial
 * renderer shows the same words in its lost- and failed-context states, so neither claims more than the table holds.
 */
export function spatialEquivalence(table: Pick<CoordinateTable, 'complete'>, otherTables: readonly string[]): string {
  if (table.complete) return 'The 2D projection and the coordinate table below show the same values as the 3D view.';
  const named = otherTables.map(title => `“${title}”`);
  return `The 2D projection shows the same drawing seen along one axis; the coordinate table below lists the positioned items and summarises the rest${named.length ? ` (the ${named.length === 1 ? 'table' : 'tables'} ${named.join(', ')} ${named.length === 1 ? 'lists' : 'list'} values in full)` : ''}.`;
}
