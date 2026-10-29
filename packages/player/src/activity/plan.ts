/**
 * Scene planning: turns the marks of one projected 2D view into screen primitives, label requests, learner-visible
 * notes and clipping facts. Pure and deterministic. It draws only what the projection supplies (geometry from the
 * identified frame, resolved coordinates, formatted value text) and never evaluates the model:
 *
 * - every polyline segment is drawn separately and gaps are never bridged (A13); open/closed endpoints get glyphs;
 * - a sampled polyline states its sampling (count, range and spacing) in a `sampling` note: a line through samples
 *   does not certify the values between them (report §8.5), as the 3D renderer's surface note says for grids;
 * - observed data (`observations2`) are separate markers only: never joined, interpolated or fitted; rows with a
 *   missing value are not drawn and are counted, with their reasons, in a `missing` note (report §8.5);
 * - a zero vector is a dot labelled “zero vector”, never an arrowhead; a nonzero vector too short to draw at the
 *   current zoom is a dot with an explicit note (A34); a nonzero 3D vector along the axis a coordinate projection leaves
 *   out is a hollow dot labelled with its direction (`points along +z, seen end-on`), with its length in a note;
 * - a degenerate polygon is drawn as the line or point it collapses to, with a note;
 * - a `segment`/`segments` mark with the `triangle` marker is directed (see {@link isDirected}): each segment is an
 *   arrow from `from` to `to`, and the segments of a multi-segment mark are labelled at their tips by segment ID;
 * - undefined coordinates become notes with their reasons, never zeros (D10); a gap whose reason the projection lists as a
 *   numerical limit (`limitReasons`: overflow, underflow, iteration limit) is noted as beyond the representable range,
 *   never as undefined (report §8.2, A11);
 * - geometry is clipped in data space and anything outside the visible domain is counted for the clipped indicator;
 * - a segment mark with `extent: 'line'` depicts unbounded lines: each segment is extended to the edges of the view and
 *   clipped there silently, and its endpoints are neither counted as out-of-view data nor part of the data extent.
 */
import type { MarkSpec, ProjectedMark, ProjectedView } from '@experiment-kit/activity';
import type { GeometryResult } from '@experiment-kit/core/model';
import type { LabelPlacement } from '@experiment-kit/activity';
import type { LabelObstacle, LabelRequest } from './labels.js';
import { formatShown } from './format.js';
import { clipLine, clipSegment, expandDomain, insideDomain, isFiniteNumber, type Bounds2, type PlotFrame, type Point } from './scale.js';

export type MarkStyle = ProjectedMark['style'];
export type MarkerGlyph = Exclude<MarkSpec['style']['marker'], 'none'>;
export type PrimitiveShape =
  | { type: 'path'; d: string; fill: boolean }
  | { type: 'marker'; x: number; y: number; glyph: MarkerGlyph; hollow: boolean; radius: number }
  | { type: 'arrow'; shaft: string; head: string }
  | { type: 'bar'; x: number; y: number; width: number; height: number };
export interface Primitive { key: string; markId: string; style: MarkStyle; shape: PrimitiveShape }
export interface PlannedMark {
  markId: string;
  kind: ProjectedMark['kind'];
  label: string;
  interactive: boolean;
  draggable: ProjectedMark['draggable'];
  primitives: Primitive[];
  /** Screen position of the mark's handle (focus ring / drag), when it has one inside the view. */
  handle: Point | null;
  /** Data coordinates of the handle. */
  handleData: Point | null;
}
/** `numerical-limit`: a value beyond the representable range (overflow, underflow, iteration limit), never `undefined`. */
export type SceneNoteKind = 'undefined' | 'numerical-limit' | 'zero-vector' | 'short-vector' | 'end-on' | 'degenerate' | 'gap' | 'scale' | 'sampling' | 'observed' | 'missing' | 'unsupported';
export interface SceneNote { markId: string; kind: SceneNoteKind; text: string }
export interface ClippedMark { markId: string; label: string; count: number }
export interface ScenePlan {
  marks: PlannedMark[];
  labels: LabelRequest[];
  notes: SceneNote[];
  clipped: ClippedMark[];
  /** Data extent of every finite drawn coordinate (for the explicit fit-to-data action); null when nothing is drawable. */
  extent: Bounds2 | null;
}

export const STROKE_WIDTH: Record<MarkStyle['weight'], number> = { thin: 1.25, regular: 2, bold: 3 };
export const MARKER_RADIUS: Record<MarkStyle['weight'], number> = { thin: 3.5, regular: 4.5, bold: 5.5 };
/** Dash patterns are a non-colour encoding of the mark role (WCAG 1.4.1). */
export const DASH: Record<MarkStyle['dash'], string | undefined> = { solid: undefined, dashed: '7 5', dotted: '1.5 4' };
export const ZERO_VECTOR_LABEL = 'zero vector';
export const SHORT_VECTOR_LABEL = 'nonzero vector, too short to draw at this zoom';
const MIN_ARROW_PX = 2;

/**
 * True for a geometry-bound `segment`/`segments` mark styled with the `triangle` marker: its segments are directed
 * (vectors, gradients) and carry an arrowhead at `to`. Other segment marks (grid lines, tangent and secant lines) are
 * undirected. The convention reads the authored style only; the projection supplies no other direction flag.
 */
export const isDirected = (mark: Pick<ProjectedMark, 'kind' | 'style'>): boolean => (mark.kind === 'segment' || mark.kind === 'segments') && mark.style.marker === 'triangle';

/** True for a segment mark whose segments depict unbounded lines (`extent: 'line'`): drawn across the view, never data. */
export const isLine = (mark: Pick<ProjectedMark, 'kind' | 'extent'>): boolean => (mark.kind === 'segment' || mark.kind === 'segments') && mark.extent === 'line';

const round = (value: number) => Math.round(value * 10) / 10;
const vec2 = (value: number[] | null | undefined): Point | null =>
  Array.isArray(value) && value.length >= 2 && isFiniteNumber(value[0]) && isFiniteNumber(value[1]) ? [value[0], value[1]] : null;
const samePoint = (a: Point, b: Point) => a[0] === b[0] && a[1] === b[1];

interface Context { frame: PlotFrame; clipBox: Bounds2; near: Bounds2; extent: [number, number, number, number] | null; notes: SceneNote[]; labels: LabelRequest[]; outside: Map<string, number> }

/** Records a drawn data point for the extent and the clipped indicator (reference grids are background, not data). */
function track(ctx: Context, mark: ProjectedMark, point: Point): void {
  if (mark.kind === 'grid') return;
  const e = ctx.extent;
  ctx.extent = e ? [Math.min(e[0], point[0]), Math.max(e[1], point[0]), Math.min(e[2], point[1]), Math.max(e[3], point[1])] : [point[0], point[0], point[1], point[1]];
  if (!insideDomain(ctx.frame.domain, point[0], point[1])) ctx.outside.set(mark.markId, (ctx.outside.get(mark.markId) ?? 0) + 1);
}

/**
 * SVG path of the unbounded line through `from` and `to`, clipped exactly to the visible domain (so the path never
 * reaches beyond the plot, even where clip paths do not apply, as in bounding-box measurements); empty when it misses.
 */
function linePath(from: Point, to: Point, frame: PlotFrame): string {
  const ends = clipLine(from, to, frame.domain);
  if (!ends) return '';
  const [a, b] = ends.map(p => frame.toScreen(p[0], p[1]));
  return `M${round(a[0])} ${round(a[1])}L${round(b[0])} ${round(b[1])}`;
}

/** SVG path for a polyline in data space: consecutive pairs are clipped, and a break starts a new subpath. */
export function polylinePath(points: readonly Point[], frame: PlotFrame, clipBox: Bounds2, closed = false): string {
  const parts: string[] = [];
  let pen: Point | null = null;
  const sequence = closed && points.length > 2 ? [...points, points[0]] : points;
  for (let i = 1; i < sequence.length; i++) {
    const clipped = clipSegment(sequence[i - 1], sequence[i], clipBox);
    if (!clipped) { pen = null; continue; }
    const [a, b] = clipped.map(p => frame.toScreen(p[0], p[1]));
    if (!pen || !samePoint(pen, a)) parts.push(`M${round(a[0])} ${round(a[1])}`);
    parts.push(`L${round(b[0])} ${round(b[1])}`);
    pen = b;
  }
  return parts.join('');
}

/** Splits a coordinate list at non-finite entries so no line is drawn across them. */
function finiteRuns(points: readonly (readonly number[] | null)[]): Point[][] {
  const runs: Point[][] = [];
  let run: Point[] = [];
  for (const raw of points) {
    const point = vec2(raw as number[] | null);
    if (point) run.push(point);
    else if (run.length) { runs.push(run); run = []; }
  }
  if (run.length) runs.push(run);
  return runs;
}

function marker(mark: ProjectedMark, key: string, screen: Point, hollow = false, glyph?: MarkerGlyph): Primitive {
  return { key, markId: mark.markId, style: mark.style, shape: { type: 'marker', x: round(screen[0]), y: round(screen[1]), glyph: glyph ?? (mark.style.marker === 'none' ? 'circle' : mark.style.marker), hollow, radius: MARKER_RADIUS[mark.style.weight] ?? 4.5 } };
}

const visible = (ctx: Context, point: Point) => insideDomain(ctx.near, point[0], point[1]);

function addLabel(ctx: Context, mark: ProjectedMark, id: string, text: string | undefined, at: Point | null, placement?: LabelPlacement): void {
  if (!text || !at || !visible(ctx, at)) return;
  ctx.labels.push({ id, markId: mark.markId, text, at: ctx.frame.toScreen(at[0], at[1]), data: [at[0], at[1]], placement });
}

/** Arrow (or zero/short-vector dot) from `tail` to `tip`. */
function arrow(ctx: Context, mark: ProjectedMark, key: string, tail: Point, tip: Point, primitives: Primitive[], labelZero = true): void {
  track(ctx, mark, tail); track(ctx, mark, tip);
  if (samePoint(tail, tip)) {
    if (visible(ctx, tail)) primitives.push(marker(mark, `${key}:zero`, ctx.frame.toScreen(tail[0], tail[1]), false, 'circle'));
    if (labelZero) {
      ctx.notes.push({ markId: mark.markId, kind: 'zero-vector', text: `${mark.label}: zero vector (no direction), drawn as a dot.` });
      addLabel(ctx, mark, `${key}:zero-label`, ZERO_VECTOR_LABEL, tail);
    }
    return;
  }
  const a = ctx.frame.toScreen(tail[0], tail[1]), b = ctx.frame.toScreen(tip[0], tip[1]);
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (length < MIN_ARROW_PX) {
    if (visible(ctx, tail)) primitives.push(marker(mark, `${key}:short`, a, true, 'circle'));
    if (labelZero) {
      ctx.notes.push({ markId: mark.markId, kind: 'short-vector', text: `${mark.label}: ${SHORT_VECTOR_LABEL}.` });
      addLabel(ctx, mark, `${key}:short-label`, SHORT_VECTOR_LABEL, tail);
    }
    return;
  }
  const clipped = clipSegment(tail, tip, ctx.clipBox);
  if (!clipped) return;
  const [p, q] = clipped.map(point => ctx.frame.toScreen(point[0], point[1]));
  const shaft = `M${round(p[0])} ${round(p[1])}L${round(q[0])} ${round(q[1])}`;
  // The head is drawn only where the true tip is inside the clip box; a clipped arrow keeps its shaft only.
  let head = '';
  if (samePoint(clipped[1], tip)) {
    const size = Math.min(10, Math.max(4, length * 0.35));
    const ux = (b[0] - a[0]) / length, uy = (b[1] - a[1]) / length;
    const back: Point = [b[0] - ux * size, b[1] - uy * size];
    const left: Point = [back[0] - uy * size * 0.5, back[1] + ux * size * 0.5], right: Point = [back[0] + uy * size * 0.5, back[1] - ux * size * 0.5];
    head = `M${round(b[0])} ${round(b[1])}L${round(left[0])} ${round(left[1])}L${round(right[0])} ${round(right[1])}Z`;
  }
  primitives.push({ key, markId: mark.markId, style: mark.style, shape: { type: 'arrow', shaft, head } });
}

/**
 * A positioned arrow seen end-on in a coordinate projection (see {@link END_ON_ARROWS}): a hollow dot, the direction
 * along the hidden axis and the true 3D length in a note, and a label that says where it points — never “zero vector”
 * (A34, A44). The coordinate table lists its components.
 */
function endOnArrow(ctx: Context, mark: ProjectedMark, at: Point, info: EndOnArrow, primitives: Primitive[]): void {
  track(ctx, mark, at);
  if (visible(ctx, at)) primitives.push(marker(mark, `${mark.markId}:end-on`, ctx.frame.toScreen(at[0], at[1]), true, 'circle'));
  ctx.notes.push({ markId: mark.markId, kind: 'end-on', text: `${mark.label}: points along ${direction(info)} (length ${formatShown(info.length)}), straight along the axis this projection leaves out, so it is seen end-on and drawn as a hollow dot here (not a zero vector); the coordinate table lists its components.` });
  addLabel(ctx, mark, `${mark.markId}:end-on-label`, endOnLabel(info), at);
}

/** Whether the projection classifies this gap reason of the mark as a numerical limit (report §8.2, A11). */
const isLimit = (mark: ProjectedMark, reason: string | null | undefined): boolean => !!reason && !!mark.limitReasons?.includes(reason);
/** The mark has nothing to draw: undefined, or beyond the representable range, with its reason. */
function undefinedNote(ctx: Context, mark: ProjectedMark, reason?: string | null): void {
  const why = reason?.trim().replace(/\.+$/, '');
  const limit = isLimit(mark, reason);
  ctx.notes.push({ markId: mark.markId, kind: limit ? 'numerical-limit' : 'undefined', text: `${mark.label}: ${limit ? 'beyond the representable range' : 'undefined'}${why ? ` — ${why}` : ''}. Nothing is drawn for it.` });
}

function planGeometry(ctx: Context, mark: ProjectedMark, geometry: GeometryResult, primitives: Primitive[]): Point | null {
  const { frame, clipBox } = ctx;
  switch (geometry.kind) {
    case 'polyline2': {
      let handle: Point | null = null;
      geometry.segments.forEach((segment, index) => {
        for (const [runIndex, run] of finiteRuns(segment.points).entries()) {
          run.forEach(point => track(ctx, mark, point));
          handle ??= run[0];
          const d = mark.kind === 'points' ? '' : polylinePath(run, frame, clipBox, mark.kind === 'region');
          if (d) primitives.push({ key: `${mark.markId}:s${index}.${runIndex}`, markId: mark.markId, style: mark.style, shape: { type: 'path', d, fill: mark.kind === 'region' } });
          // An isolated finite sample between gaps is shown as a dot rather than silently dropped.
          if (run.length === 1 && mark.kind !== 'points' && mark.kind !== 'trace' && visible(ctx, run[0])) primitives.push(marker(mark, `${mark.markId}:s${index}.${runIndex}.solo`, frame.toScreen(run[0][0], run[0][1]), false, 'circle'));
          if (mark.kind === 'trace' || mark.kind === 'points') run.forEach((point, i) => { if (visible(ctx, point)) primitives.push(marker(mark, `${mark.markId}:s${index}.${runIndex}.p${i}`, frame.toScreen(point[0], point[1]))); });
        }
        const first = vec2(segment.points[0] as number[]), last = vec2(segment.points[segment.points.length - 1] as number[]);
        if (segment.start !== 'none' && first && visible(ctx, first)) primitives.push(marker(mark, `${mark.markId}:s${index}:start`, frame.toScreen(first[0], first[1]), segment.start === 'open', 'circle'));
        if (segment.end !== 'none' && last && visible(ctx, last)) primitives.push(marker(mark, `${mark.markId}:s${index}:end`, frame.toScreen(last[0], last[1]), segment.end === 'open', 'circle'));
      });
      const reasons = [...new Set(geometry.gaps.map(gap => gap.reason))];
      for (const reason of reasons) ctx.notes.push({ markId: mark.markId, kind: 'gap', text: `${mark.label} has a gap that is not joined: ${reason}` });
      if (geometry.sampling) ctx.notes.push({ markId: mark.markId, kind: 'sampling', text: samplingNote(mark.label, geometry.sampling, mark.kind !== 'points') });
      return handle;
    }
    case 'observations2': {
      let handle: Point | null = null;
      const missing: string[] = [];
      geometry.points.forEach(entry => {
        const point = vec2(entry.values as number[]);
        if (!point) { missing.push(entry.reason ?? 'missing value'); return; }
        track(ctx, mark, point);
        handle ??= point;
        if (visible(ctx, point)) primitives.push(marker(mark, `${mark.markId}:o${entry.row}`, frame.toScreen(point[0], point[1])));
      });
      const total = geometry.points.length;
      ctx.notes.push({ markId: mark.markId, kind: 'observed', text: `${mark.label}: ${total - missing.length} observed ${total - missing.length === 1 ? 'point is' : 'points are'} drawn separately; no line joins, interpolates or fits them.` });
      if (missing.length) {
        const reasons = [...new Set(missing.map(reason => reason.trim().replace(/\.+$/, '')))];
        ctx.notes.push({ markId: mark.markId, kind: 'missing', text: `${mark.label}: ${missing.length} of ${total} ${total === 1 ? 'observation has' : 'observations have'} a missing value — ${reasons.join('; ')}. ${missing.length === 1 ? 'It is' : 'They are'} not drawn.` });
      }
      return handle;
    }
    case 'points2': {
      let handle: Point | null = null;
      const missing: string[] = [];
      const barWidth = mark.kind === 'bar' ? barWidthPx(geometry.points.map(entry => vec2(entry.at)?.[0]).filter(isFiniteNumber), frame.scaleX) : 0;
      const limits: string[] = [];
      geometry.points.forEach((entry, index) => {
        const point = vec2(entry.at);
        if (!point) { (isLimit(mark, entry.reason) ? limits : missing).push(entry.reason ?? 'no value'); return; }
        track(ctx, mark, point);
        handle ??= point;
        if (mark.kind === 'bar') {
          const base = clipSegment([point[0], 0], point, clipBox);
          if (!base) return;
          const [a, b] = base.map(p => frame.toScreen(p[0], p[1]));
          primitives.push({ key: `${mark.markId}:b${index}`, markId: mark.markId, style: mark.style, shape: { type: 'bar', x: round(a[0] - barWidth / 2), y: round(Math.min(a[1], b[1])), width: round(barWidth), height: round(Math.abs(b[1] - a[1])) } });
        } else if (visible(ctx, point)) primitives.push(marker(mark, `${mark.markId}:p${index}`, frame.toScreen(point[0], point[1])));
      });
      // Undefined points and points beyond the representable range are counted apart, each with its reasons.
      for (const [kind, words, gaps] of [['undefined', 'undefined', missing], ['numerical-limit', 'beyond the representable range', limits]] as const) {
        if (!gaps.length) continue;
        const reasons = [...new Set(gaps.map(reason => reason.trim().replace(/\.+$/, '')))];
        ctx.notes.push({ markId: mark.markId, kind, text: `${mark.label}: ${gaps.length} ${gaps.length === 1 ? 'point is' : 'points are'} ${words} — ${reasons.join('; ')}. They are not drawn.` });
      }
      return handle;
    }
    case 'segments2': {
      const directed = isDirected(mark), line = isLine(mark);
      const zeroVectors: Point[] = [];
      const endOn = END_ON_SEGMENTS.get(geometry);
      let endOnCount = 0;
      geometry.segments.forEach((segment, index) => {
        const from = vec2(segment.from), to = vec2(segment.to);
        if (!from || !to) return;
        if (samePoint(from, to)) {
          // A directed segment that only a coordinate projection collapsed points along the hidden axis: it is not a zero
          // vector, so it stays a hollow dot with its own note. Any other directed zero-length segment is a zero vector:
          // the same filled dot, note and label as a zero arrow (A34).
          if (directed && endOn?.has(segment.id)) { endOnCount++; track(ctx, mark, from); if (visible(ctx, from)) primitives.push(marker(mark, `${mark.markId}:e${index}`, frame.toScreen(from[0], from[1]), true, 'circle')); return; }
          if (directed) { zeroVectors.push(from); arrow(ctx, mark, `${mark.markId}:g${index}`, from, to, primitives, false); return; }
          track(ctx, mark, from); if (visible(ctx, from)) primitives.push(marker(mark, `${mark.markId}:z${index}`, frame.toScreen(from[0], from[1]), true, 'circle')); return;
        }
        if (line) {
          const d = linePath(from, to, frame);
          if (d) primitives.push({ key: `${mark.markId}:g${index}`, markId: mark.markId, style: mark.style, shape: { type: 'path', d, fill: false } });
          return;
        }
        if (directed) {
          // A segment of zero drawn length here is only a projection artefact or below the zoom; arrow() never adds a head then.
          arrow(ctx, mark, `${mark.markId}:g${index}`, from, to, primitives, false);
          if (geometry.segments.length > 1) addLabel(ctx, mark, `${mark.markId}:g${index}:id`, segment.id, to);
          return;
        }
        track(ctx, mark, from); track(ctx, mark, to);
        const d = polylinePath([from, to], frame, clipBox);
        if (d) primitives.push({ key: `${mark.markId}:g${index}`, markId: mark.markId, style: mark.style, shape: { type: 'path', d, fill: false } });
      });
      if (zeroVectors.length) {
        const all = zeroVectors.length === geometry.segments.length && geometry.segments.length === 1;
        ctx.notes.push({ markId: mark.markId, kind: 'zero-vector', text: all ? `${mark.label}: zero vector (no direction), drawn as a dot.` : `${mark.label}: ${zeroVectors.length} zero ${zeroVectors.length === 1 ? 'vector is' : 'vectors are'} drawn as dots (no direction).` });
        if (all) addLabel(ctx, mark, `${mark.markId}:zero-label`, ZERO_VECTOR_LABEL, zeroVectors[0]!);
      }
      if (endOnCount) ctx.notes.push({ markId: mark.markId, kind: 'end-on', text: `${mark.label}: ${endOnCount === 1 ? 'one segment points' : `${endOnCount} segments point`} straight along the axis this projection leaves out, so ${endOnCount === 1 ? 'it is' : 'they are'} drawn as a hollow dot here (not a zero vector); the coordinate table lists ${endOnCount === 1 ? 'it' : 'them'}.` });
      const first = geometry.segments[0];
      return first ? vec2(first.from) : null;
    }
    case 'polygon2': {
      const vertices = geometry.vertices.map(v => vec2(v)).filter((v): v is Point => !!v);
      vertices.forEach(point => track(ctx, mark, point));
      const distinct = vertices.filter((v, i) => vertices.findIndex(w => samePoint(v, w)) === i);
      if (!geometry.degenerate && distinct.length >= 3) {
        const d = polylinePath(vertices, frame, clipBox, true);
        if (d) primitives.push({ key: `${mark.markId}:poly`, markId: mark.markId, style: mark.style, shape: { type: 'path', d: `${d}Z`, fill: true } });
      } else if (distinct.length >= 2) {
        const d = polylinePath(vertices, frame, clipBox);
        if (d) primitives.push({ key: `${mark.markId}:collapsed`, markId: mark.markId, style: mark.style, shape: { type: 'path', d, fill: false } });
        ctx.notes.push({ markId: mark.markId, kind: 'degenerate', text: `${mark.label}: degenerate polygon (no area), drawn as a line.` });
      } else if (distinct.length === 1) {
        if (visible(ctx, distinct[0])) primitives.push(marker(mark, `${mark.markId}:collapsed`, frame.toScreen(distinct[0][0], distinct[0][1]), false, 'circle'));
        ctx.notes.push({ markId: mark.markId, kind: 'degenerate', text: `${mark.label}: degenerate polygon (all vertices coincide), drawn as a point.` });
      } else undefinedNote(ctx, mark, mark.undefinedReason ?? 'no vertices');
      return distinct[0] ?? null;
    }
    case 'vector-field2': {
      let zero = 0;
      geometry.samples.forEach((sample, index) => {
        const at = vec2(sample.at), vector = vec2(sample.vector);
        if (!at || !vector) return;
        const tip: Point = [at[0] + vector[0] * geometry.scale.factor, at[1] + vector[1] * geometry.scale.factor];
        if (samePoint(at, tip)) zero++;
        arrow(ctx, mark, `${mark.markId}:v${index}`, at, tip, primitives, false);
      });
      ctx.notes.push({ markId: mark.markId, kind: 'scale', text: `${mark.label}: arrows drawn at ${geometry.scale.factor}× length. ${geometry.scale.disclosure}` });
      if (zero) ctx.notes.push({ markId: mark.markId, kind: 'zero-vector', text: `${mark.label}: ${zero} zero ${zero === 1 ? 'vector is' : 'vectors are'} drawn as dots (no direction).` });
      return vec2(geometry.samples[0]?.at);
    }
    default:
      ctx.notes.push({ markId: mark.markId, kind: 'unsupported', text: `${mark.label} needs the 3D view; use the 2D projection or the table.` });
      return null;
  }
}

/**
 * Sampling disclosure of a sampled polyline: sample count, the range of its sampling variable (x for the installed
 * kernels; a document series' own variable, which may be a curve parameter) and the spacing of the evenly spaced
 * samples. `joined` marks draw straight lines between neighbouring samples, which do not certify the values between
 * them (report §8.5).
 */
export function samplingNote(label: string, sampling: { samples: number; domain: [number, number] }, joined = true): string {
  const [lo, hi] = sampling.domain;
  const number = (value: number) => formatShown(value);
  const spacing = sampling.samples > 1 ? ` (spacing ${number((hi - lo) / (sampling.samples - 1))})` : '';
  return `${label}: ${sampling.samples} samples of its sampling variable from ${number(lo)} to ${number(hi)}${spacing}; ${joined
    ? 'straight lines join neighbouring samples, so the drawing does not show values between them or features narrower than the spacing.'
    : 'only the samples are drawn.'}`;
}

/** Tail and tip of an arrow mark: `from`/`at` (or the origin) plus `vector`, or `from` → `to`; null when undefined. */
export function arrowEnds(mark: Pick<ProjectedMark, 'at' | 'from' | 'to' | 'vector'>): [Point, Point] | null {
  const at = vec2(mark.at), from = vec2(mark.from), to = vec2(mark.to), vector = vec2(mark.vector);
  const tail = from ?? at ?? (vector ? [0, 0] as Point : null);
  const tip = to ?? (tail && vector ? [tail[0] + vector[0], tail[1] + vector[1]] as Point : null);
  return tail && tip ? [tail, tip] : null;
}

function planCoordinates(ctx: Context, mark: ProjectedMark, primitives: Primitive[]): Point | null {
  const at = vec2(mark.at), from = vec2(mark.from), to = vec2(mark.to), vector = vec2(mark.vector);
  const { frame, clipBox } = ctx;
  switch (mark.kind) {
    case 'arrow': {
      const ends = arrowEnds(mark);
      if (!ends) { undefinedNote(ctx, mark, mark.undefinedReason); return null; }
      const [tail, tip] = ends;
      // A nonzero 3D arrow that only a coordinate projection collapsed points along the hidden axis: never a zero vector.
      const endOn = END_ON_ARROWS.get(mark);
      if (endOn && samePoint(tail, tip)) { endOnArrow(ctx, mark, tail, endOn, primitives); return tail; }
      arrow(ctx, mark, mark.markId, tail, tip, primitives);
      return tail;
    }
    case 'segment': {
      if (!from || !to) { undefinedNote(ctx, mark, mark.undefinedReason); return null; }
      const line = isLine(mark);
      if (!line || samePoint(from, to)) { track(ctx, mark, from); track(ctx, mark, to); }
      if (samePoint(from, to)) {
        if (visible(ctx, from)) primitives.push(marker(mark, mark.markId, frame.toScreen(from[0], from[1]), true, 'circle'));
        ctx.notes.push({ markId: mark.markId, kind: 'degenerate', text: `${mark.label}: ${line ? 'two equal points define no line' : 'zero-length segment'}, drawn as a point.` });
      } else {
        const d = line ? linePath(from, to, frame) : polylinePath([from, to], frame, clipBox);
        if (d) primitives.push({ key: mark.markId, markId: mark.markId, style: mark.style, shape: { type: 'path', d, fill: false } });
      }
      return from;
    }
    case 'angle': {
      if (!at || !from || !to) { undefinedNote(ctx, mark, mark.undefinedReason); return null; }
      track(ctx, mark, at);
      if (samePoint(at, from) || samePoint(at, to)) { undefinedNote(ctx, mark, mark.undefinedReason ?? 'a side has zero length, so the angle has no value'); return at; }
      const centre = frame.toScreen(at[0], at[1]), p = frame.toScreen(from[0], from[1]), q = frame.toScreen(to[0], to[1]);
      const a1 = Math.atan2(-(p[1] - centre[1]), p[0] - centre[0]), a2 = Math.atan2(-(q[1] - centre[1]), q[0] - centre[0]);
      const signed = typeof mark.value?.value === 'number' ? mark.value.value : null;
      let sweep = a2 - a1;
      // Orientation follows the sign of the projected angle when it has one; otherwise the smaller arc is drawn.
      if (signed !== null && signed < 0) { while (sweep > 0) sweep -= 2 * Math.PI; } else if (signed !== null) { while (sweep < 0) sweep += 2 * Math.PI; }
      else { while (sweep > Math.PI) sweep -= 2 * Math.PI; while (sweep < -Math.PI) sweep += 2 * Math.PI; }
      const radius = 22, steps = Math.max(4, Math.ceil(Math.abs(sweep) / (Math.PI / 24)));
      const arc: string[] = [];
      for (let i = 0; i <= steps; i++) {
        const angle = a1 + sweep * i / steps;
        arc.push(`${i ? 'L' : 'M'}${round(centre[0] + radius * Math.cos(angle))} ${round(centre[1] - radius * Math.sin(angle))}`);
      }
      if (visible(ctx, at)) primitives.push({ key: mark.markId, markId: mark.markId, style: mark.style, shape: { type: 'path', d: arc.join(''), fill: false } });
      const middle = a1 + sweep / 2;
      const labelAt = frame.fromScreen(centre[0] + (radius + 4) * Math.cos(middle), centre[1] - (radius + 4) * Math.sin(middle));
      addLabel(ctx, mark, `${mark.markId}:value`, mark.text ?? mark.value?.text, labelAt, mark.placement);
      return at;
    }
    case 'bar': {
      if (!at) { undefinedNote(ctx, mark, mark.undefinedReason); return null; }
      return planGeometry(ctx, mark, { kind: 'points2', points: [{ id: mark.markId, at }] }, primitives);
    }
    case 'label': {
      if (!at) { undefinedNote(ctx, mark, mark.undefinedReason); return null; }
      track(ctx, mark, at);
      addLabel(ctx, mark, `${mark.markId}:text`, mark.text ?? mark.value?.text ?? mark.label, at, mark.placement ?? { anchor: 'center', offset: [0, 0], leader: false, maxWidthEm: 16 });
      return at;
    }
    default: {
      if (!at) { undefinedNote(ctx, mark, mark.undefinedReason); return null; }
      track(ctx, mark, at);
      if (visible(ctx, at)) primitives.push(marker(mark, mark.markId, frame.toScreen(at[0], at[1])));
      return at;
    }
  }
}

const DESCRIPTORS = new Set([ZERO_VECTOR_LABEL, SHORT_VECTOR_LABEL]);
const END_ON_DESCRIPTOR = /^points along [+−][xyz], seen end-on$/;
const isDescriptor = (text: string): boolean => DESCRIPTORS.has(text) || END_ON_DESCRIPTOR.test(text);
/** True when two labelled features are the same point: equal data coordinates, or equal screen positions without data. */
const coincident = (a: LabelRequest, b: LabelRequest): boolean =>
  a.data && b.data ? a.data[0] === b.data[0] && a.data[1] === b.data[1] : a.at[0] === b.at[0] && a.at[1] === b.at[1];
/**
 * Merges the labels of exactly coincident features (for example x₀ and xₙ at n = 0, P and Q at h = 0, v and Mv when M
 * fixes v) into one combined label at the first label's placement, so they can never collide. Only exact coincidence
 * merges: features that are merely close keep separate labels, which placement separates with leaders, so a merged
 * label always means the same point. Names come first in input order, followed by descriptors in parentheses
 * (`v, Mv (zero vector)`); duplicates are dropped. Deterministic; the marks' own labels stay in the legend and the text
 * description.
 */
export function mergeCoincidentLabels(labels: readonly LabelRequest[]): LabelRequest[] {
  const groups: LabelRequest[][] = [];
  for (const label of labels) {
    const group = groups.find(candidate => coincident(candidate[0]!, label));
    if (group) group.push(label); else groups.push([label]);
  }
  return groups.map(group => {
    if (group.length === 1) return group[0]!;
    const texts = [...new Set(group.map(label => label.text.trim()).filter(Boolean))];
    const names = texts.filter(text => !isDescriptor(text)), descriptors = texts.filter(isDescriptor);
    const text = names.length ? `${names.join(', ')}${descriptors.length ? ` (${descriptors.join('; ')})` : ''}` : descriptors.join('; ');
    const first = group[0]!;
    const widest = Math.max(...group.map(label => label.placement?.maxWidthEm ?? 14));
    const markIds = [...new Set(group.flatMap(label => label.markIds ?? [label.markId]))];
    return { ...first, id: `${first.id}+${group.length - 1}`, text, markIds, ...(first.placement ? { placement: { ...first.placement, maxWidthEm: Math.min(24, Math.max(widest, Math.ceil([...text].length * 0.65))) } } : {}) };
  });
}

/**
 * Areas labels must keep clear (report §10.2): every arrowhead (exact triangle; never covered by another mark's label,
 * and by its own label only when nothing at the same distance is free) and every point marker (a label may sit beside
 * its own marker). Vector-field samples are a background texture like grid lines, and lines and fills are not
 * obstacles; labels may cross them.
 */
export function labelObstacles(plan: Pick<ScenePlan, 'marks'>): LabelObstacle[] {
  const out: LabelObstacle[] = [];
  for (const mark of plan.marks) {
    if (mark.kind === 'vector-field') continue;
    for (const primitive of mark.primitives) {
      const shape = primitive.shape;
      if (shape.type === 'marker') out.push({ x: shape.x - shape.radius, y: shape.y - shape.radius, width: 2 * shape.radius, height: 2 * shape.radius, markId: mark.markId });
      else if (shape.type === 'arrow' && shape.head) {
        const numbers = shape.head.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
        const polygon = Array.from({ length: Math.floor(numbers.length / 2) }, (_, i) => [numbers[2 * i]!, numbers[2 * i + 1]!] as const);
        if (polygon.length < 3) continue;
        const xs = polygon.map(point => point[0]), ys = polygon.map(point => point[1]);
        out.push({ x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), markId: mark.markId, own: 'avoid', polygon });
      }
    }
  }
  return out;
}

/** Plans every mark of a 2D (or 2D-projected) view against a fitted frame. */
export function planScene(view: Pick<ProjectedView, 'marks'>, frame: PlotFrame): ScenePlan {
  const ctx: Context = { frame, clipBox: expandDomain(frame.domain, 1), near: expandDomain(frame.domain, 0.02), extent: null, notes: [], labels: [], outside: new Map() };
  const marks: PlannedMark[] = [];
  for (const mark of view.marks) {
    const primitives: Primitive[] = [];
    let handleData: Point | null = null;
    if (mark.undefinedReason && !mark.geometry && !mark.at && !mark.from && !mark.to && !mark.vector) undefinedNote(ctx, mark, mark.undefinedReason);
    else if (mark.geometry) {
      handleData = planGeometry(ctx, mark, mark.geometry, primitives);
      if (mark.kind === 'point' || mark.kind === 'label') handleData = handleData ?? vec2(mark.at);
    } else handleData = planCoordinates(ctx, mark, primitives);
    // Arrow labels sit at the tip (the end that carries the meaning); other marks are labelled at their handle.
    const directedTip = isDirected(mark) && mark.geometry?.kind === 'segments2' ? vec2(mark.geometry.segments[0]?.to) : null;
    const labelPoint = mark.kind === 'arrow' && !mark.geometry ? arrowEnds(mark)?.[1] ?? handleData : directedTip ?? handleData;
    if (mark.text && labelPoint && mark.kind !== 'angle' && mark.kind !== 'label') addLabel(ctx, mark, `${mark.markId}:text`, mark.text, labelPoint, mark.placement);
    const handle = handleData && visible(ctx, handleData) ? frame.toScreen(handleData[0], handleData[1]) : null;
    marks.push({ markId: mark.markId, kind: mark.kind, label: mark.label, interactive: mark.interactive, draggable: mark.draggable, primitives, handle, handleData });
  }
  const clipped = view.marks.filter(mark => ctx.outside.has(mark.markId)).map(mark => ({ markId: mark.markId, label: mark.label, count: ctx.outside.get(mark.markId)! }));
  return { marks, labels: mergeCoincidentLabels(ctx.labels), notes: ctx.notes, clipped, extent: ctx.extent };
}

/**
 * Bounded data drawn outside the visible view, for the `CLIPPED` surface diagnostic: the plan's clipped marks without
 * `reference`-role marks. Reference grids (`grid` marks) and unbounded lines (`extent: 'line'`) are never tracked by
 * the plan, so they are never counted either.
 */
export function clippedData(view: Pick<ProjectedView, 'marks'>, plan: Pick<ScenePlan, 'clipped'>): ClippedMark[] {
  const reference = new Set(view.marks.filter(mark => mark.style.role === 'reference').map(mark => mark.markId));
  return plan.clipped.filter(item => !reference.has(item.markId));
}

/**
 * Directed segments that a coordinate projection collapsed to a point (their 3D segment was not zero), keyed by the
 * projected `segments2` geometry and listed by segment ID; set by the 2D projection of a 3D view (`project3d`).
 */
export const END_ON_SEGMENTS = new WeakMap<object, ReadonlySet<string>>();
/** A positioned 3D arrow along the axis a coordinate projection leaves out: that axis, the sign along it and its 3D length. */
export interface EndOnArrow { axis: 'x' | 'y' | 'z'; sign: 1 | -1; length: number }
/**
 * Positioned arrow marks (`at`/`from`/`to`/`vector`) whose nonzero 3D arrow a coordinate projection collapsed to a point,
 * keyed by the projected mark; set by the 2D projection of a 3D view (`project3d`). A true zero vector is never listed.
 */
export const END_ON_ARROWS = new WeakMap<object, EndOnArrow>();
const direction = (info: EndOnArrow): string => `${info.sign < 0 ? '−' : '+'}${info.axis}`;
/** The label of an arrow seen end-on: where it points, as a descriptor beside the mark's name (`u × v (points along +z, seen end-on)`). */
export const endOnLabel = (info: EndOnArrow): string => `points along ${direction(info)}, seen end-on`;

/** Bar width limits in pixels: wide enough to see, narrow enough to stay a bar (report §10.2). */
export const BAR_WIDTH = Object.freeze({ min: 2, max: 28, single: 24, fill: 0.7 });
/**
 * Width of the bars of one mark: a fraction of the smallest spacing between distinct bar positions (in pixels at the
 * current scale), so neighbouring bars never overlap however the positions are spaced; a single bar has a fixed width.
 */
export function barWidthPx(xs: readonly number[], scaleX: number): number {
  const distinct = [...new Set(xs)].sort((a, b) => a - b);
  let spacing = Infinity;
  for (let i = 1; i < distinct.length; i++) spacing = Math.min(spacing, distinct[i]! - distinct[i - 1]!);
  if (!Number.isFinite(spacing) || !(scaleX > 0)) return BAR_WIDTH.single;
  return Math.max(BAR_WIDTH.min, Math.min(BAR_WIDTH.max, spacing * scaleX * BAR_WIDTH.fill));
}

/** Dash pattern of every kept-run overlay (a comparison is always dashed, whatever the current run's mark uses). */
export const COMPARISON_DASH = DASH.dashed;
const COMPARISON_GLYPHS: readonly MarkerGlyph[] = ['circle', 'square', 'triangle', 'diamond', 'cross'];
/** Marker shape of kept run `ordinal` (1-based): kept runs differ by shape as well as by their legend text (WCAG 1.4.1). */
export const comparisonGlyph = (ordinal: number): MarkerGlyph => COMPARISON_GLYPHS[(Math.max(1, Math.floor(ordinal)) - 1) % COMPARISON_GLYPHS.length]!;
export const GLYPH_NAME: Readonly<Record<MarkerGlyph, string>> = Object.freeze({ circle: 'hollow circle', square: 'hollow square', triangle: 'hollow triangle', diamond: 'hollow diamond', cross: 'cross' });
/**
 * Marks of a kept run's overlay as drawn: muted, dashed, the run's own hollow marker shape, never interactive and never
 * labelled (the legend and the comparisons panel name the run). Geometry and coordinates are the projection's, unchanged.
 */
export function comparisonMarks(marks: readonly ProjectedMark[], ordinal: number): ProjectedMark[] {
  const glyph = comparisonGlyph(ordinal);
  return marks.map(mark => ({
    ...mark, markId: `kept${ordinal}:${mark.markId}`, interactive: false, text: undefined, placement: undefined, draggable: undefined,
    style: { role: 'muted', dash: 'dashed', weight: 'regular', marker: mark.style.marker === 'none' ? 'none' : glyph },
  }));
}

/** SVG path data for a marker glyph centred at (x, y); shapes, not colour, distinguish point series. */
export function markerPath(glyph: MarkerGlyph, x: number, y: number, r: number): string {
  switch (glyph) {
    case 'square': return `M${round(x - r)} ${round(y - r)}h${round(2 * r)}v${round(2 * r)}h${round(-2 * r)}Z`;
    case 'diamond': { const s = r * 1.3; return `M${round(x)} ${round(y - s)}L${round(x + s)} ${round(y)}L${round(x)} ${round(y + s)}L${round(x - s)} ${round(y)}Z`; }
    case 'triangle': { const s = r * 1.25; return `M${round(x)} ${round(y - s)}L${round(x + s)} ${round(y + s * 0.8)}L${round(x - s)} ${round(y + s * 0.8)}Z`; }
    case 'cross': return `M${round(x - r)} ${round(y - r)}L${round(x + r)} ${round(y + r)}M${round(x + r)} ${round(y - r)}L${round(x - r)} ${round(y + r)}`;
    default: return `M${round(x - r)} ${round(y)}a${round(r)} ${round(r)} 0 1 0 ${round(2 * r)} 0a${round(r)} ${round(r)} 0 1 0 ${round(-2 * r)} 0Z`;
  }
}
