/**
 * Spatial scene planning (report §8.5, §10.2, §13): turns the authorized marks of one `scene3d` view into bounded
 * primitives in model coordinates, learner-visible notes and label requests. Pure and deterministic. It draws only
 * what the projection supplies — geometry from the identified frame and resolved coordinates — and never evaluates or
 * differentiates the model:
 *
 * - a `segment`/`segments` mark with the `triangle` marker, and every `arrow` mark, is directed: a shaft from `from`
 *   to `to` with a cone head at `to`; a zero-length vector is a dot with a note and never gets a head; the arrows of a
 *   `segments` mark are named at their tips by segment ID;
 * - polylines are split at missing samples and never bridged; gaps are listed with their reasons;
 * - a sampled surface becomes an indexed mesh over its grid; a cell with any missing sample is left as a hole;
 * - vector-field arrows are drawn at the field's declared scale factor, which is always disclosed;
 * - undefined coordinates become notes with their reasons, never zeros (D10); a gap whose reason the projection lists as a
 *   numerical limit (`limitReasons`: overflow, underflow, iteration limit) is noted as beyond the representable range,
 *   never as undefined (report §8.2, A11), and a surface sample without a value (which carries no reason) is called
 *   neither;
 * - a segment is named by its ID only where the drawing shows that ID (`namesSegments`: a directed `segments` mark, or
 *   several directed segments): at its tip, or, for a zero vector that has no tip, beside its dot (`u (zero vector)`);
 *   otherwise the mark's label names it, and the zero-length segments of an undirected mark are counted, never named.
 *
 * Bounds (`SPATIAL_LIMITS`, the limits of the `spatial-3d@1.0` capability record in `@experiment-kit/activity`, passed
 * in by the learner surface): a mark whose primitives would exceed the remaining vertex, index or field-sample budget is
 * rejected as a whole (no partial surface or field) with a visible note pointing to the 2D projection and table;
 * labels beyond the label limit are dropped lowest priority first (ticks, then segment names) with a note. Scaffolding
 * (axes, ticks, floor grid, glyph meshes) is bounded by construction and not counted in vertices.
 *
 * Per-frame cost (`drawCallsPerFrame`): the scene is built with a bounded number of draw calls per mark, whatever its
 * size — one wide-line object for all of a mark's lines or arrow shafts, one instanced mesh for all of its arrowheads or
 * glyphs of one shape, two objects per surface, three per vector field, each doubled by an occlusion ghost when a
 * surface is drawn — and the axes, ticks, box and floor grid. `drawCallsOf` computes exactly the draw calls the scene
 * builder issues (a transparent double-sided surface is drawn in two passes); a mark that would exceed the remaining
 * per-frame budget is rejected as a whole with the same note.
 */
import type { GeometryResult } from '@experiment-kit/core/model';
import { formatNumber, formatTick, type ViewFrame } from './frame.js';
import type { LabelAnchor, SpatialMark, SpatialView } from './types.js';
import { sameVec, vec3, type Vec3 } from './vec.js';

export interface SpatialLimits {
  /** Data-derived vertices across all marks of a view. */
  vertices: number;
  /** Surface triangle and wireframe indices across all marks of a view. */
  indices: number;
  /** Vector-field samples across all marks of a view. */
  fieldSamples: number;
  /** Overlay labels (axis names, mark labels, segment names, ticks). */
  labels: number;
  /** Largest texture edge the renderer may allocate (it allocates none: labels are DOM, nothing is fetched). */
  textureSize: number;
  /** Draw calls per rendered frame, scaffolding (axes, ticks, box, floor grid) included. */
  drawCallsPerFrame: number;
}
/**
 * The renderer's own maxima, equal to the `spatial-3d@1.0` capability record (`SPATIAL_3D_LIMITS` in
 * `@experiment-kit/activity`, checked by tests/player-3d/limits.test.ts). Limits passed at mount can only lower them.
 */
export const SPATIAL_LIMITS: Readonly<SpatialLimits> = Object.freeze({ vertices: 20_000, indices: 120_000, fieldSamples: 1_000, labels: 32, textureSize: 1024, drawCallsPerFrame: 128 });
/** Effective limits: each requested limit is honoured only up to the renderer's own maximum. */
export const effectiveLimits = (requested: Partial<SpatialLimits> = {}): SpatialLimits => Object.fromEntries((Object.keys(SPATIAL_LIMITS) as (keyof SpatialLimits)[])
  .map(key => [key, typeof requested[key] === 'number' && Number.isFinite(requested[key]) && requested[key]! >= 0 ? Math.min(Math.floor(requested[key]!), SPATIAL_LIMITS[key]) : SPATIAL_LIMITS[key]])) as unknown as SpatialLimits;

export type Glyph = 'circle' | 'square' | 'diamond' | 'triangle' | 'cross';
export interface PlannedStyle { role: string; dash: 'solid' | 'dashed' | 'dotted'; weight: 'thin' | 'regular' | 'bold'; selected: boolean }
/** Consecutive points joined by straight segments (model coordinates). */
export interface PlannedLine { key: string; markId: string; style: PlannedStyle; points: Vec3[] }
export interface PlannedArrow { key: string; markId: string; segmentId: string; style: PlannedStyle; tail: Vec3; tip: Vec3 }
export interface PlannedPoint { key: string; markId: string; style: PlannedStyle; glyph: Glyph; hollow: boolean; at: Vec3 }
export interface PlannedSurface {
  key: string; markId: string; style: PlannedStyle;
  vertices: Vec3[];
  /** Triangle indices into `vertices` (6 per complete grid cell). */
  triangles: number[];
  /** Wireframe index pairs along grid rows and columns between defined samples. */
  edges: number[];
  holes: number;
}
export interface PlannedField { key: string; markId: string; style: PlannedStyle; arrows: { at: Vec3; tip: Vec3 }[]; zero: Vec3[]; factor: number }
export type LabelKind = 'axis' | 'mark' | 'segment' | 'tick';
export interface PlannedLabel { key: string; markId: string | null; kind: LabelKind; text: string; at: Vec3; anchor: LabelAnchor; offset: [number, number] }
/** `limit` is a drawing-budget limit; `numerical-limit` a value beyond the representable range (never `undefined`). */
export type NoteKind = 'undefined' | 'numerical-limit' | 'zero-vector' | 'short-vector' | 'degenerate' | 'gap' | 'scale' | 'sampling' | 'holes' | 'limit' | 'aspect' | 'outside' | 'unsupported';
export interface SpatialNote { markId: string | null; kind: NoteKind; text: string }
export interface RejectedMark { markId: string; label: string; limit: 'vertices' | 'indices' | 'fieldSamples' | 'drawCallsPerFrame'; requested: number; available: number }
/** Data-derived counts of the drawing, and the exact draw calls of one rendered frame (`drawCallsOf`). */
export interface PlanCounts { vertices: number; indices: number; fieldSamples: number; labels: number; drawCalls: number }
export interface SpatialPlan {
  lines: PlannedLine[];
  arrows: PlannedArrow[];
  points: PlannedPoint[];
  surfaces: PlannedSurface[];
  fields: PlannedField[];
  labels: PlannedLabel[];
  notes: SpatialNote[];
  rejected: RejectedMark[];
  counts: PlanCounts;
  droppedLabels: number;
  /** Drawn coordinates outside the authored box (drawn anyway; the projection reports the clipped state). */
  outside: number;
}

/** Relative length below which a nonzero vector is drawn as a dot (fraction of the box radius in world units). */
export const SHORT_VECTOR = 1e-3;
export const ZERO_VECTOR_LABEL = 'zero vector';
const LABEL_PRIORITY: Record<LabelKind, number> = { axis: 0, mark: 1, segment: 2, tick: 3 };
const GLYPHS = new Set<Glyph>(['circle', 'square', 'diamond', 'triangle', 'cross']);

/** Directed marks carry a head at their tip (the 2D plan uses the same convention). */
export const isDirected = (mark: Pick<SpatialMark, 'kind' | 'style'>): boolean =>
  mark.kind === 'arrow' || ((mark.kind === 'segment' || mark.kind === 'segments') && mark.style.marker === 'triangle');
/**
 * Whether the drawing names the `count` segments of this mark by their IDs (report §10.4: no unexplained IDs): only the
 * segments of a directed `segments` mark, or several directed segments, whose IDs are shown at their tips (a zero
 * vector's beside its dot). Undirected segments carry no name in the drawing, so neither notes nor the 2D alternative's
 * coordinate table (`coordinateTable` in `@experiment-kit/player`, which applies the same rule) use their IDs.
 */
export const namesSegments = (mark: Pick<SpatialMark, 'kind' | 'style'>, count: number): boolean =>
  isDirected(mark) && (mark.kind === 'segments' || count > 1);
/** The label beside the dot of a zero vector the drawing names by `name` (the 2D view merges coincident labels alike). */
export const namedZeroVector = (name: string): string => `${name} (${ZERO_VECTOR_LABEL})`;

interface MarkPlan {
  lines: PlannedLine[]; arrows: PlannedArrow[]; points: PlannedPoint[]; surfaces: PlannedSurface[]; fields: PlannedField[];
  labels: PlannedLabel[]; notes: SpatialNote[]; vertices: number; indices: number; fieldSamples: number; drawn: Vec3[];
}
const emptyPlan = (): MarkPlan => ({ lines: [], arrows: [], points: [], surfaces: [], fields: [], labels: [], notes: [], vertices: 0, indices: 0, fieldSamples: 0, drawn: [] });

function styleOf(mark: SpatialMark, selection: string | null): PlannedStyle {
  const dash = mark.style.dash === 'dashed' || mark.style.dash === 'dotted' ? mark.style.dash : 'solid';
  const weight = mark.style.weight === 'thin' || mark.style.weight === 'bold' ? mark.style.weight : 'regular';
  return { role: mark.style.role, dash, weight, selected: selection === mark.markId };
}
const glyphOf = (mark: SpatialMark): Glyph => GLYPHS.has(mark.style.marker as Glyph) ? mark.style.marker as Glyph : 'circle';
const sentence = (text: string) => text.trim().replace(/\.+$/, '');

interface Context { frame: ViewFrame; selection: string | null; radius: number }

function addLabel(plan: MarkPlan, mark: SpatialMark, key: string, kind: LabelKind, text: string | undefined, at: Vec3 | null): void {
  if (!text || !at) return;
  plan.labels.push({ key, markId: mark.markId, kind, text, at, anchor: mark.placement?.anchor ?? 'ne', offset: mark.placement?.offset ?? [7, -7] });
}
/** Whether the projection classifies this gap reason of the mark as a numerical limit (report §8.2, A11). */
const isLimit = (mark: SpatialMark, reason: string | null | undefined): boolean => !!reason && !!mark.limitReasons?.includes(reason);
/** The mark has no coordinates to draw: undefined, or beyond the representable range, with its reason. */
function undefinedNote(plan: MarkPlan, mark: SpatialMark, reason?: string | null): void {
  const limit = isLimit(mark, reason);
  plan.notes.push({ markId: mark.markId, kind: limit ? 'numerical-limit' : 'undefined', text: `${mark.label}: ${limit ? 'beyond the representable range' : 'undefined'}${reason ? ` — ${sentence(reason)}` : ''}. Nothing is drawn for it.` });
}
/** Notes for points without coordinates, undefined ones apart from those beyond the representable range. */
function missingPointNotes(plan: MarkPlan, mark: SpatialMark, missing: readonly string[]): void {
  for (const [kind, words, reasons] of [
    ['undefined', 'undefined', missing.filter(reason => !isLimit(mark, reason))],
    ['numerical-limit', 'beyond the representable range', missing.filter(reason => isLimit(mark, reason))],
  ] as const) {
    if (!reasons.length) continue;
    const listed = [...new Set(reasons.map(sentence))];
    plan.notes.push({ markId: mark.markId, kind, text: `${mark.label}: ${reasons.length} ${reasons.length === 1 ? 'point is' : 'points are'} ${words} — ${listed.join('; ')}. ${reasons.length === 1 ? 'It is' : 'They are'} not drawn.` });
  }
}

/** World-space length of a model displacement (the frame may scale z). */
const worldLength = (ctx: Context, a: Vec3, b: Vec3): number =>
  Math.hypot((b[0] - a[0]) * ctx.frame.scale[0], (b[1] - a[1]) * ctx.frame.scale[1], (b[2] - a[2]) * ctx.frame.scale[2]);

/**
 * A directed segment: an arrow, or a dot with a note when it has no length (never a head). `named`: the drawing names
 * this segment by `segmentId` (`namesSegments`) — at its tip, or beside the dot of a zero vector — so its notes do too.
 */
function arrow(ctx: Context, plan: MarkPlan, mark: SpatialMark, key: string, segmentId: string, tail: Vec3, tip: Vec3, style: PlannedStyle, noteZero = true, named = false): void {
  const who = `${mark.label}${named ? ` (${segmentId})` : ''}`;
  plan.drawn.push(tail, tip);
  if (sameVec(tail, tip)) {
    plan.points.push({ key: `${key}:zero`, markId: mark.markId, style, glyph: 'circle', hollow: false, at: tail });
    plan.vertices += 1;
    if (noteZero) {
      plan.notes.push({ markId: mark.markId, kind: 'zero-vector', text: `${who}: zero vector (no direction), drawn as a dot without an arrowhead.` });
      addLabel(plan, mark, `${key}:zero-label`, 'segment', named ? namedZeroVector(segmentId) : ZERO_VECTOR_LABEL, tail);
    }
    return;
  }
  if (worldLength(ctx, tail, tip) < SHORT_VECTOR * ctx.radius) {
    plan.points.push({ key: `${key}:short`, markId: mark.markId, style, glyph: 'circle', hollow: true, at: tail });
    plan.vertices += 1;
    if (noteZero) plan.notes.push({ markId: mark.markId, kind: 'short-vector', text: `${who}: nonzero vector, too short to draw at this scale; drawn as a hollow dot. The table lists its value.` });
    return;
  }
  plan.arrows.push({ key, markId: mark.markId, segmentId, style, tail, tip });
  plan.vertices += 2;
}

/** Splits a coordinate list at missing or non-finite entries (never bridged). */
function finiteRuns(points: readonly (readonly number[] | null)[]): Vec3[][] {
  const runs: Vec3[][] = [];
  let run: Vec3[] = [];
  for (const raw of points) {
    const point = vec3(raw as number[] | null);
    if (point) run.push(point);
    else if (run.length) { runs.push(run); run = []; }
  }
  if (run.length) runs.push(run);
  return runs;
}

function planSurface(ctx: Context, plan: MarkPlan, mark: SpatialMark, geometry: Extract<GeometryResult, { kind: 'surface-grid' }>, style: PlannedStyle): Vec3 | null {
  const { xs, ys, z } = geometry;
  const nx = xs.length, ny = ys.length;
  const slot = new Int32Array(nx * ny).fill(-1);
  const vertices: Vec3[] = [];
  let missing = 0;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const height = z[j * nx + i];
    const x = xs[i], y = ys[j];
    if (height === null || height === undefined || !Number.isFinite(height) || !Number.isFinite(x) || !Number.isFinite(y)) { missing++; continue; }
    slot[j * nx + i] = vertices.length;
    vertices.push([x!, y!, height]);
  }
  const triangles: number[] = [], edges: number[] = [];
  let holes = 0;
  for (let j = 0; j + 1 < ny; j++) for (let i = 0; i + 1 < nx; i++) {
    const a = slot[j * nx + i]!, b = slot[j * nx + i + 1]!, c = slot[(j + 1) * nx + i]!, d = slot[(j + 1) * nx + i + 1]!;
    if (a < 0 || b < 0 || c < 0 || d < 0) { holes++; continue; }
    triangles.push(a, b, d, a, d, c);
  }
  for (let j = 0; j < ny; j++) for (let i = 0; i + 1 < nx; i++) {
    const a = slot[j * nx + i]!, b = slot[j * nx + i + 1]!;
    if (a >= 0 && b >= 0) edges.push(a, b);
  }
  for (let i = 0; i < nx; i++) for (let j = 0; j + 1 < ny; j++) {
    const a = slot[j * nx + i]!, b = slot[(j + 1) * nx + i]!;
    if (a >= 0 && b >= 0) edges.push(a, b);
  }
  plan.surfaces.push({ key: `${mark.markId}:surface`, markId: mark.markId, style, vertices, triangles, edges, holes });
  plan.vertices += vertices.length;
  plan.indices += triangles.length + edges.length;
  plan.drawn.push(...vertices);
  const [x0, x1, y0, y1] = geometry.sampling.domain;
  plan.notes.push({
    markId: mark.markId, kind: 'sampling',
    text: `${mark.label}: sampled on a ${geometry.sampling.nx} × ${geometry.sampling.ny} grid over x from ${formatNumber(x0)} to ${formatNumber(x1)} and y from ${formatNumber(y0)} to ${formatNumber(y1)}; between samples it is drawn flat, so features smaller than the grid spacing are not shown.`,
  });
  // A surface sample carries no reason, so a missing one is not called undefined (it may be a numerical limit).
  if (missing) plan.notes.push({ markId: mark.markId, kind: 'holes', text: `${mark.label}: ${missing} ${missing === 1 ? 'sample has' : 'samples have'} no value; the ${holes} grid ${holes === 1 ? 'cell' : 'cells'} touching them ${holes === 1 ? 'is' : 'are'} left as holes.` });
  return vertices[0] ?? null;
}

function planGeometry(ctx: Context, plan: MarkPlan, mark: SpatialMark, geometry: GeometryResult, style: PlannedStyle): Vec3 | null {
  switch (geometry.kind) {
    case 'surface-grid': return planSurface(ctx, plan, mark, geometry, style);
    case 'polyline2': case 'polyline3': {
      let handle: Vec3 | null = null;
      geometry.segments.forEach((segment, index) => {
        finiteRuns(segment.points as readonly (readonly number[])[]).forEach((run, runIndex) => {
          handle ??= run[0]!;
          plan.drawn.push(...run);
          plan.vertices += run.length;
          if (run.length === 1 || mark.kind === 'points') run.forEach((point, p) => plan.points.push({ key: `${mark.markId}:s${index}.${runIndex}.p${p}`, markId: mark.markId, style, glyph: glyphOf(mark), hollow: false, at: point }));
          else plan.lines.push({ key: `${mark.markId}:s${index}.${runIndex}`, markId: mark.markId, style, points: run });
        });
      });
      for (const reason of new Set(geometry.gaps.map(gap => gap.reason))) plan.notes.push({ markId: mark.markId, kind: 'gap', text: `${mark.label} has a gap that is not joined: ${reason}` });
      return handle;
    }
    case 'points2': case 'points3': {
      let handle: Vec3 | null = null;
      const missing: string[] = [];
      geometry.points.forEach((entry, index) => {
        const point = vec3(entry.at);
        if (!point) { missing.push(entry.reason ?? 'no value'); return; }
        handle ??= point;
        plan.drawn.push(point);
        plan.vertices += 1;
        plan.points.push({ key: `${mark.markId}:p${index}`, markId: mark.markId, style, glyph: glyphOf(mark), hollow: false, at: point });
      });
      missingPointNotes(plan, mark, missing);
      return handle;
    }
    case 'segments2': case 'segments3': {
      const directed = isDirected(mark);
      const named = namesSegments(mark, geometry.segments.length);
      // Undirected segments carry no name in the drawing: their zero-length ones are counted in one note, never named.
      let points = 0;
      geometry.segments.forEach((segment, index) => {
        const from = vec3(segment.from), to = vec3(segment.to);
        if (!from || !to) return;
        const key = `${mark.markId}:g${index}`;
        if (directed) {
          arrow(ctx, plan, mark, key, segment.id, from, to, style, true, named);
          if (named && !sameVec(from, to)) addLabel(plan, mark, `${key}:id`, 'segment', segment.id, to);
          return;
        }
        plan.drawn.push(from, to);
        plan.vertices += sameVec(from, to) ? 1 : 2;
        if (sameVec(from, to)) {
          plan.points.push({ key: `${key}:point`, markId: mark.markId, style, glyph: 'circle', hollow: true, at: from });
          points++;
        } else plan.lines.push({ key, markId: mark.markId, style, points: [from, to] });
      });
      if (points) plan.notes.push({
        markId: mark.markId, kind: 'degenerate',
        text: geometry.segments.length === 1 ? `${mark.label}: zero-length segment, drawn as a point.`
          : `${mark.label}: ${points} of its ${geometry.segments.length} segments ${points === 1 ? 'has' : 'have'} zero length and ${points === 1 ? 'is' : 'are'} drawn as ${points === 1 ? 'a point' : 'points'}.`,
      });
      const first = geometry.segments[0];
      return first ? vec3(directed ? first.to : first.from) : null;
    }
    case 'vector-field2': case 'vector-field3': {
      const field: PlannedField = { key: `${mark.markId}:field`, markId: mark.markId, style, arrows: [], zero: [], factor: geometry.scale.factor };
      for (const sample of geometry.samples as readonly { at: readonly number[]; vector: readonly number[] }[]) {
        const at = vec3(sample.at as number[]), vector = vec3(sample.vector as number[]);
        if (!at || !vector) continue;
        const tip: Vec3 = [at[0] + vector[0] * field.factor, at[1] + vector[1] * field.factor, at[2] + vector[2] * field.factor];
        plan.drawn.push(at);
        if (sameVec(at, tip)) field.zero.push(at); else field.arrows.push({ at, tip });
      }
      plan.fields.push(field);
      plan.fieldSamples += geometry.samples.length;
      plan.vertices += field.arrows.length * 2 + field.zero.length;
      plan.notes.push({ markId: mark.markId, kind: 'scale', text: `${mark.label}: arrows drawn at ${field.factor}× length. ${geometry.scale.disclosure}` });
      if (field.zero.length) plan.notes.push({ markId: mark.markId, kind: 'zero-vector', text: `${mark.label}: ${field.zero.length} zero ${field.zero.length === 1 ? 'vector is' : 'vectors are'} drawn as ${field.zero.length === 1 ? 'a dot' : 'dots'} (no direction).` });
      return field.arrows[0]?.at ?? field.zero[0] ?? null;
    }
    case 'polygon2': {
      const vertices = geometry.vertices.map(vertex => vec3(vertex)).filter((vertex): vertex is Vec3 => !!vertex);
      if (vertices.length >= 2) {
        plan.lines.push({ key: `${mark.markId}:outline`, markId: mark.markId, style, points: geometry.degenerate ? vertices : [...vertices, vertices[0]!] });
        plan.vertices += vertices.length;
        plan.drawn.push(...vertices);
        if (geometry.degenerate) plan.notes.push({ markId: mark.markId, kind: 'degenerate', text: `${mark.label}: degenerate polygon (no area), drawn as a line.` });
      } else if (vertices.length === 1) {
        plan.points.push({ key: `${mark.markId}:collapsed`, markId: mark.markId, style, glyph: 'circle', hollow: false, at: vertices[0]! });
        plan.vertices += 1;
        plan.drawn.push(vertices[0]!);
        plan.notes.push({ markId: mark.markId, kind: 'degenerate', text: `${mark.label}: degenerate polygon (all vertices coincide), drawn as a point.` });
      } else undefinedNote(plan, mark, mark.undefinedReason ?? 'no vertices');
      return vertices[0] ?? null;
    }
    // Observed data are 2D (template validation keeps them out of scene3d views); never drawn or joined here.
    case 'observations2':
      plan.notes.push({ markId: mark.markId, kind: 'unsupported', text: `${mark.label} is drawn only in 2D views; the table lists its values.` });
      return null;
  }
}

function planCoordinates(ctx: Context, plan: MarkPlan, mark: SpatialMark, style: PlannedStyle): { handle: Vec3 | null; tip: Vec3 | null } {
  const at = vec3(mark.at ?? null), from = vec3(mark.from ?? null), to = vec3(mark.to ?? null), vector = vec3(mark.vector ?? null);
  if (mark.kind === 'arrow') {
    const tail = from ?? at ?? (vector ? [0, 0, 0] as Vec3 : null);
    const tip = to ?? (tail && vector ? [tail[0] + vector[0], tail[1] + vector[1], tail[2] + vector[2]] as Vec3 : null);
    if (!tail || !tip) { undefinedNote(plan, mark, mark.undefinedReason); return { handle: null, tip: null }; }
    arrow(ctx, plan, mark, mark.markId, mark.markId, tail, tip, style);
    return { handle: tail, tip: sameVec(tail, tip) ? null : tip };
  }
  if (mark.kind === 'segment') {
    if (!from || !to) { undefinedNote(plan, mark, mark.undefinedReason); return { handle: null, tip: null }; }
    if (isDirected(mark)) { arrow(ctx, plan, mark, mark.markId, mark.markId, from, to, style); return { handle: from, tip: sameVec(from, to) ? null : to }; }
    plan.drawn.push(from, to);
    plan.vertices += 2;
    if (sameVec(from, to)) {
      plan.points.push({ key: mark.markId, markId: mark.markId, style, glyph: 'circle', hollow: true, at: from });
      plan.notes.push({ markId: mark.markId, kind: 'degenerate', text: `${mark.label}: zero-length segment, drawn as a point.` });
    } else plan.lines.push({ key: mark.markId, markId: mark.markId, style, points: [from, to] });
    return { handle: from, tip: null };
  }
  if (mark.kind === 'angle' || mark.kind === 'region' || mark.kind === 'bar' || mark.kind === 'polygon') {
    plan.notes.push({ markId: mark.markId, kind: 'unsupported', text: `${mark.label} is drawn only in the 2D projection; the table lists its values.` });
    return { handle: null, tip: null };
  }
  if (!at) { undefinedNote(plan, mark, mark.undefinedReason); return { handle: null, tip: null }; }
  plan.drawn.push(at);
  if (mark.kind === 'label') {
    addLabel(plan, mark, `${mark.markId}:text`, 'mark', mark.text ?? mark.value?.text ?? mark.label, at);
    return { handle: null, tip: null };
  }
  plan.vertices += 1;
  plan.points.push({ key: mark.markId, markId: mark.markId, style, glyph: glyphOf(mark), hollow: false, at });
  return { handle: at, tip: null };
}

/** Axis names at the positive ends and tick labels along each axis line (model coordinates). */
export function axisLabels(frame: ViewFrame): PlannedLabel[] {
  const labels: PlannedLabel[] = [];
  const { bounds, axisOrigin, ticks, axisNames } = frame;
  for (let axis = 0; axis < 3; axis++) {
    const range = bounds[axis * 2 + 1]! - bounds[axis * 2]!;
    const end: Vec3 = [...axisOrigin];
    end[axis] = bounds[axis * 2 + 1]! + range * 0.07;
    labels.push({ key: `axis:${axis}`, markId: null, kind: 'axis', text: axisNames[axis]!, at: end, anchor: 'center', offset: [0, 0] });
    for (const value of ticks[axis]!.values) {
      // The crossing point is not labelled on every axis (it would stack three labels at one place).
      if (value === axisOrigin[axis]) continue;
      const at: Vec3 = [...axisOrigin];
      at[axis] = value;
      labels.push({ key: `tick:${axis}:${value}`, markId: null, kind: 'tick', text: formatTick(value, ticks[axis]!.step), at, anchor: axis === 2 ? 'w' : 'sw', offset: axis === 2 ? [-6, 0] : [-3, 3] });
    }
  }
  return labels;
}

export interface PlanOptions { limits?: Partial<SpatialLimits>; selection?: string | null }

type DrawPrimitives = Pick<SpatialPlan, 'lines' | 'arrows' | 'points' | 'surfaces' | 'fields'>;
/** Draw passes of a sampled surface mesh: it is transparent and double-sided, so Three.js draws back then front faces. */
const SURFACE_PASSES = 2;
/** Draw calls of the scaffolding: per axis its line, arrowhead and ticks (when it has any), the box and the floor grid. */
export function scaffoldDrawCalls(frame: ViewFrame): number {
  const { bounds, axisOrigin, ticks } = frame;
  const free = (value: number, axis: 0 | 1) => value !== axisOrigin[axis] && value !== bounds[axis * 2] && value !== bounds[axis * 2 + 1];
  const floor = ticks[0].values.some(value => free(value, 0)) || ticks[1].values.some(value => free(value, 1));
  return ticks.reduce((total, axis) => total + 2 + (axis.values.length ? 1 : 0), 0) + 1 + (floor ? 1 : 0);
}
/**
 * Exact draw calls `buildContent` issues for these primitives (scene.ts): per mark one line object for its lines, one
 * for its arrow shafts and one instanced mesh for its arrowheads; one instanced mesh per glyph shape and fill of its
 * points (a line object for crosses); per surface its mesh (two passes: it is transparent and double-sided) and its
 * wireframe; per field its shafts, heads and zero dots. With `occluding` (a surface is drawn) every arrow and glyph
 * object has a ghost copy. A wireframe surface hides its mesh.
 */
export function drawCallsOf(primitives: DrawPrimitives, occluding: boolean, wireframe = false): number {
  const ghost = occluding ? 2 : 1;
  const marks = (items: readonly { markId: string }[]) => new Set(items.map(item => item.markId)).size;
  const glyphGroups = new Set(primitives.points.map(point => `${point.markId}\u0000${point.glyph}\u0000${point.hollow}`));
  const crossGroups = [...glyphGroups].filter(group => group.split('\u0000')[1] === 'cross').length;
  return marks(primitives.lines) + 2 * ghost * marks(primitives.arrows)
    + crossGroups + ghost * (glyphGroups.size - crossGroups)
    + primitives.surfaces.reduce((total, surface) => total + (wireframe ? 0 : SURFACE_PASSES) + (surface.edges.length >= 2 ? 1 : 0), 0)
    + primitives.fields.reduce((total, field) => total + (field.arrows.length ? 2 : 0) + (field.zero.length ? 1 : 0), 0);
}

/** Plans every mark of a `scene3d` view against its frame, enforcing the limits (`SPATIAL_LIMITS` or lower). */
export function planSpatialScene(view: Pick<SpatialView, 'marks'>, frame: ViewFrame, options: PlanOptions = {}): SpatialPlan {
  const limits: SpatialLimits = effectiveLimits(options.limits);
  const ctx: Context = { frame, selection: options.selection ?? null, radius: frame.radius };
  const out: SpatialPlan = { lines: [], arrows: [], points: [], surfaces: [], fields: [], labels: [], notes: [], rejected: [], counts: { vertices: 0, indices: 0, fieldSamples: 0, labels: 0, drawCalls: 0 }, droppedLabels: 0, outside: 0 };
  const reject = (mark: SpatialMark, limit: RejectedMark['limit'], requested: number, available: number) => {
    const noun = { vertices: 'vertices', indices: 'surface indices', fieldSamples: 'field samples', drawCallsPerFrame: 'draw calls per frame' }[limit];
    out.rejected.push({ markId: mark.markId, label: mark.label, limit, requested, available });
    out.notes.push({ markId: mark.markId, kind: 'limit', text: `${mark.label} is not drawn in 3D: it needs ${requested} ${noun} and the 3D view draws at most ${limits[limit]} in total. The 2D projection and the table show it.` });
  };
  // Pass 1: data-derived budgets in mark order.
  const accepted: { mark: SpatialMark; plan: MarkPlan }[] = [];
  for (const mark of view.marks) {
    const plan = emptyPlan();
    const style = styleOf(mark, ctx.selection);
    let handle: Vec3 | null = null, tip: Vec3 | null = null;
    if (mark.undefinedReason && !mark.geometry && !mark.at && !mark.from && !mark.to && !mark.vector) undefinedNote(plan, mark, mark.undefinedReason);
    else if (mark.geometry) {
      handle = planGeometry(ctx, plan, mark, mark.geometry, style);
      if (isDirected(mark) && (mark.geometry.kind === 'segments3' || mark.geometry.kind === 'segments2') && mark.geometry.segments.length === 1) tip = plan.arrows[0]?.tip ?? null;
    } else ({ handle, tip } = planCoordinates(ctx, plan, mark, style));
    // Mark text sits at the arrow tip (the end that carries the meaning); other marks at their handle.
    if (mark.text && mark.kind !== 'label') addLabel(plan, mark, `${mark.markId}:text`, 'mark', mark.text, tip ?? handle);
    const exceeded = plan.vertices + out.counts.vertices > limits.vertices ? { limit: 'vertices' as const, requested: plan.vertices, available: limits.vertices - out.counts.vertices }
      : plan.indices + out.counts.indices > limits.indices ? { limit: 'indices' as const, requested: plan.indices, available: limits.indices - out.counts.indices }
        : plan.fieldSamples + out.counts.fieldSamples > limits.fieldSamples ? { limit: 'fieldSamples' as const, requested: plan.fieldSamples, available: limits.fieldSamples - out.counts.fieldSamples }
          : null;
    if (exceeded) { reject(mark, exceeded.limit, exceeded.requested, exceeded.available); continue; }
    out.counts.vertices += plan.vertices; out.counts.indices += plan.indices; out.counts.fieldSamples += plan.fieldSamples;
    accepted.push({ mark, plan });
  }
  // Pass 2: per-frame draw calls in mark order (occlusion ghosts are counted when any accepted mark draws a surface).
  const occluding = accepted.some(entry => entry.plan.surfaces.length > 0);
  let draws = scaffoldDrawCalls(frame);
  const candidates: PlannedLabel[] = [...axisLabels(frame)];
  for (const { mark, plan } of accepted) {
    const cost = drawCallsOf(plan, occluding);
    if (draws + cost > limits.drawCallsPerFrame) {
      reject(mark, 'drawCallsPerFrame', cost, limits.drawCallsPerFrame - draws);
      out.counts.vertices -= plan.vertices; out.counts.indices -= plan.indices; out.counts.fieldSamples -= plan.fieldSamples;
      continue;
    }
    draws += cost;
    out.lines.push(...plan.lines); out.arrows.push(...plan.arrows); out.points.push(...plan.points); out.surfaces.push(...plan.surfaces); out.fields.push(...plan.fields);
    out.notes.push(...plan.notes);
    candidates.push(...plan.labels);
    const [x0, x1, y0, y1, z0, z1] = frame.bounds;
    out.outside += plan.drawn.filter(p => p[0] < x0 || p[0] > x1 || p[1] < y0 || p[1] > y1 || p[2] < z0 || p[2] > z1).length;
  }
  // Exact draw calls of the drawing that is built (a surface rejected above can only remove ghosts).
  out.counts.drawCalls = scaffoldDrawCalls(frame) + drawCallsOf(out, out.surfaces.length > 0);
  // Labels by priority (stable within a priority); the remainder is dropped with a note.
  const ordered = candidates.map((label, index) => ({ label, index })).sort((a, b) => LABEL_PRIORITY[a.label.kind] - LABEL_PRIORITY[b.label.kind] || a.index - b.index);
  out.labels = ordered.slice(0, limits.labels).map(entry => entry.label);
  out.droppedLabels = Math.max(0, ordered.length - limits.labels);
  out.counts.labels = out.labels.length;
  if (out.droppedLabels) out.notes.push({ markId: null, kind: 'limit', text: `${out.droppedLabels} ${out.droppedLabels === 1 ? 'label is' : 'labels are'} not shown: the 3D view shows at most ${limits.labels} labels. The table lists every value.` });
  if (frame.aspectNote) out.notes.push({ markId: null, kind: 'aspect', text: frame.aspectNote });
  if (out.outside) out.notes.push({ markId: null, kind: 'outside', text: 'Part of the drawing extends past the axis box; it is drawn at its true position and the table lists its values.' });
  return out;
}

const sameList = (a: readonly number[] | null | undefined, b: readonly number[] | null | undefined): boolean =>
  a === b || (!!a && !!b && a.length === b.length && a.every((value, i) => Object.is(value, b[i])));
const sameJson = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);
function sameMark(a: SpatialMark, b: SpatialMark): boolean {
  return a.markId === b.markId && a.kind === b.kind && a.label === b.label && a.text === b.text && a.undefinedReason === b.undefinedReason
    && a.style.role === b.style.role && a.style.dash === b.style.dash && a.style.marker === b.style.marker && a.style.weight === b.style.weight
    && sameJson(a.placement, b.placement) && a.value?.text === b.value?.text && sameJson(a.limitReasons, b.limitReasons)
    && sameList(a.at, b.at) && sameList(a.from, b.from) && sameList(a.to, b.to) && sameList(a.vector, b.vector)
    // Projections of one frame share its geometry objects; otherwise the values are compared.
    && sameJson(a.geometry, b.geometry);
}
/**
 * Two projected views draw the same scene (a new projection object for a status, acknowledgement or presentation change
 * of the same frame). The renderer then keeps its scene and draws nothing new.
 */
export function sameDrawing(a: SpatialView, b: SpatialView): boolean {
  return a === b || (a.viewId === b.viewId && a.title === b.title && a.equalAspect === b.equalAspect && sameList(a.bounds3, b.bounds3)
    && sameJson(a.axes, b.axes) && a.marks.length === b.marks.length && a.marks.every((mark, i) => sameMark(mark, b.marks[i]!)));
}

