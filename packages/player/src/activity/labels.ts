/**
 * Bounded, deterministic label placement (report §10.2): anchor positions, pixel offsets, word wrapping to a maximum
 * width, leader lines and collision diagnostics. Text widths are estimated from the font size, so the same input
 * always gives the same layout (the layout is testable without a DOM and identical in captures). Placement is
 * collision-aware: a label avoids earlier labels, the drawn obstacles of other marks (arrowheads, point markers) and
 * every other labelled point, and a label moved away from its feature gets a leader line.
 */
import type { LabelPlacement } from '@experiment-kit/activity';
import type { Rect } from './scale.js';

export type Anchor = LabelPlacement['anchor'];
export interface LabelMetrics { fontPx: number; lineHeight: number; charWidth: number }
export const labelMetrics = (fontPx: number): LabelMetrics => ({ fontPx, lineHeight: Math.round(fontPx * 1.25), charWidth: fontPx * 0.58 });

export interface LabelRequest {
  id: string;
  /** Mark the label belongs to (diagnostics). */
  markId: string;
  text: string;
  /** Screen position of the labelled feature. */
  at: [number, number];
  placement?: LabelPlacement;
  /** Data coordinates of the labelled feature; labels are merged only when these coincide exactly. */
  data?: [number, number];
  /** Every mark the label stands for (a merged label names several); defaults to `markId`. Their obstacles never block it. */
  markIds?: string[];
}
/**
 * Area a label must not cover: a box, optionally with the exact convex outline inside it (an arrowhead triangle), which
 * is then what overlap is tested against. Every label avoids an obstacle without `markId` and the obstacles of other
 * marks. Its own mark's obstacle is allowed (`own: 'allowed'`, the default: a point marker beside its name) or avoided
 * when the label can stay at the same distance elsewhere (`own: 'avoid'`: its own arrowhead).
 */
export interface LabelObstacle { x: number; y: number; width: number; height: number; markId?: string; own?: 'allowed' | 'avoid'; polygon?: readonly (readonly [number, number])[] }
export interface PlacedLabel {
  id: string;
  markId: string;
  lines: string[];
  box: Rect;
  /** Baseline origin of the first line, at `textAnchor`. */
  x: number;
  y: number;
  /**
   * Text alignment that keeps the text against the side facing its feature (labels west of their point end there, labels
   * north or south of it are centred), so an estimated text width never opens a gap between label and feature.
   */
  textAnchor: 'start' | 'middle' | 'end';
  leader: { x1: number; y1: number; x2: number; y2: number } | null;
  anchor: Anchor;
  nudged: boolean;
  /** Set when the label is drawn as a numbered callout tag; its full text is entry `callout` of the figure's label key. */
  callout?: number;
}
/** One entry of a figure's label key: a label drawn as a numbered tag because its text had no free place (report §10.2, §10.3). */
export interface LabelCallout { number: number; labelId: string; markId: string; text: string }
/** Lines a label may wrap to inside the drawing; a longer label is drawn as a callout with its full text in the key. */
export const LABEL_MAX_LINES = 4;
export type LabelDiagnosticCode = 'LABEL_NUDGED' | 'LABEL_OVERLAP' | 'LABEL_CLAMPED' | 'LABEL_CALLOUT';
export interface LabelDiagnostic { code: LabelDiagnosticCode; labelId: string; markId: string; message: string }

const DEFAULT_PLACEMENT: LabelPlacement = { anchor: 'ne', offset: [6, -6], leader: false, maxWidthEm: 14 };
/** Half the side (px) of the square around every labelled point that other labels keep clear. */
const POINT_CLEARANCE = 3;
/** Distances (in line heights) a label is pushed out when no anchor at the authored distance fits. */
const PUSH_STEPS = [0, 0.5, 1, 1.5, 2, 3, 4];
const ALTERNATES: Anchor[] = ['ne', 'nw', 'se', 'sw', 'n', 's', 'e', 'w'];
const SIGN: Record<Anchor, [number, number]> = { n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0], nw: [-1, -1], center: [0, 0] };

/**
 * Greedy word wrap to `maxWidth` pixels; words longer than a line are split by characters. At most `maxLines` lines,
 * the last one ending in `…` when text was cut: callers that must never hide text pass `Infinity` (axis titles, legend
 * entries, the label key) or test {@link wrappedLineCount} first (labels inside the drawing).
 */
export function wrapText(text: string, maxWidth: number, charWidth: number, maxLines = 4): string[] {
  const perLine = Math.max(4, Math.floor(maxWidth / charWidth));
  const words = text.trim().split(/\s+/).filter(Boolean).flatMap(word => {
    const chars = [...word];
    if (chars.length <= perLine) return [word];
    const parts: string[] = [];
    for (let i = 0; i < chars.length; i += perLine) parts.push(chars.slice(i, i + perLine).join(''));
    return parts;
  });
  const lines: string[] = [];
  for (const word of words) {
    const last = lines[lines.length - 1];
    if (last !== undefined && [...last].length + 1 + [...word].length <= perLine) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const tail = [...kept[maxLines - 1]];
  kept[maxLines - 1] = `${tail.slice(0, Math.max(1, perLine - 1)).join('')}…`;
  return kept;
}

/** Lines `text` needs at `maxWidth` without any cut. */
export const wrappedLineCount = (text: string, maxWidth: number, charWidth: number): number => wrapText(text, maxWidth, charWidth, Infinity).length;

export const textWidth = (lines: string[], metrics: LabelMetrics): number => Math.max(0, ...lines.map(line => [...line].length)) * metrics.charWidth;

/** True when `box` (grown by `pad`) meets the convex `polygon`: a corner inside the other, or crossing edges. */
function boxMeetsPolygon(box: Rect, polygon: readonly (readonly [number, number])[], pad = 1): boolean {
  const x0 = box.x - pad, y0 = box.y - pad, x1 = box.x + box.width + pad, y1 = box.y + box.height + pad;
  if (polygon.some(([x, y]) => x > x0 && x < x1 && y > y0 && y < y1)) return true;
  const corners: [number, number][] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const cross = (a: readonly [number, number], b: readonly [number, number], c: readonly [number, number]) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const insidePolygon = (point: [number, number]) => {
    const signs = polygon.map((vertex, i) => Math.sign(cross(vertex, polygon[(i + 1) % polygon.length]!, point)));
    return signs.every(sign => sign >= 0) || signs.every(sign => sign <= 0);
  };
  if (corners.some(insidePolygon)) return true;
  const segmentsCross = (a: readonly [number, number], b: readonly [number, number], c: readonly [number, number], d: readonly [number, number]) =>
    cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0;
  return polygon.some((vertex, i) => corners.some((corner, j) => segmentsCross(vertex, polygon[(i + 1) % polygon.length]!, corner, corners[(j + 1) % 4]!)));
}
const blocks = (box: Rect, other: Rect & { polygon?: readonly (readonly [number, number])[] }) =>
  overlaps(box, other) && (!other.polygon || boxMeetsPolygon(box, other.polygon));
const overlaps = (a: Rect, b: Rect, pad = 1) =>
  a.x < b.x + b.width + pad && b.x < a.x + a.width + pad && a.y < b.y + b.height + pad && b.y < a.y + a.height + pad;
/** Shortest distance between two rectangles (0 when they touch or overlap). */
const gapBetween = (a: Rect, b: Rect) =>
  Math.hypot(Math.max(0, b.x - (a.x + a.width), a.x - (b.x + b.width)), Math.max(0, b.y - (a.y + a.height), a.y - (b.y + b.height)));
const overlapArea = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
const inside = (box: Rect, bounds: Rect) => box.x >= bounds.x && box.y >= bounds.y && box.x + box.width <= bounds.x + bounds.width && box.y + box.height <= bounds.y + bounds.height;

/** Box for a label of `width × height` placed at `anchor` with pixel `offset` from point `at`. */
export function anchoredBox(at: [number, number], anchor: Anchor, offset: [number, number], width: number, height: number): Rect {
  const [sx, sy] = SIGN[anchor];
  const ox = Math.abs(offset[0]), oy = Math.abs(offset[1]);
  const x = sx > 0 ? at[0] + ox : sx < 0 ? at[0] - ox - width : at[0] - width / 2 + offset[0];
  const y = sy > 0 ? at[1] + oy : sy < 0 ? at[1] - oy - height : at[1] - height / 2 + offset[1];
  return { x, y, width, height };
}

function nearestEdgePoint(box: Rect, point: [number, number]): [number, number] {
  return [Math.min(box.x + box.width, Math.max(box.x, point[0])), Math.min(box.y + box.height, Math.max(box.y, point[1]))];
}

/**
 * Places labels in input order. Each label keeps its authored anchor/offset when that box is inside `bounds` and
 * overlaps no earlier label, no obstacle of another mark, none of its own avoided obstacles (its arrowhead) and no
 * other labelled point. Otherwise the other anchors are tried at the authored distance, then every anchor pushed
 * outwards by ½, 1, 1½, 2, 3 and 4 line heights. At each distance a candidate clear of everything is preferred; failing
 * that, one that only touches the label's own arrowhead (staying beside its feature beats drifting away). Among the
 * free candidates of that distance the one with the most clearance wins (ties keep the fixed anchor order), so a nudged
 * label sits where it is least likely to be read as another feature's. A label moved further than its authored
 * distance gets a leader. When no candidate is free, the candidate inside `bounds` with the least overlap is kept and a
 * `LABEL_OVERLAP` diagnostic is emitted, so collisions are reported rather than hidden.
 */
export function placeLabels(requests: readonly LabelRequest[], options: { metrics: LabelMetrics; bounds: Rect; obstacles?: readonly LabelObstacle[]; callouts?: boolean }): { labels: PlacedLabel[]; diagnostics: LabelDiagnostic[]; callouts: LabelCallout[] } {
  if (!options.callouts) return { ...placeOnce(requests, options, new Map()), callouts: [] };
  // Collision handling by an alternate representation (report §10.2, §10.3; text is never shrunk or cut): a label that
  // cannot be placed clear of earlier labels and marks, or that needs more than LABEL_MAX_LINES lines, is drawn as a
  // short numbered tag at its feature, and its full text goes to the figure's label key. Rounds repeat with the freed
  // space until no further label overlaps; tags are numbered in input order, so the result is deterministic.
  const valid = requests.filter(request => request.text.trim() && request.at.every(Number.isFinite));
  const { metrics } = options;
  const tagged = new Set<string>(valid.filter(request => {
    const placement = request.placement ?? DEFAULT_PLACEMENT;
    return wrappedLineCount(request.text, Math.max(metrics.fontPx * 3, placement.maxWidthEm * metrics.fontPx), metrics.charWidth) > LABEL_MAX_LINES;
  }).map(request => request.id));
  for (let round = 0; ; round++) {
    const numbers = new Map(valid.filter(request => tagged.has(request.id)).map((request, index) => [request.id, index + 1] as const));
    const placed = placeOnce(valid, options, numbers);
    const overlapping = placed.diagnostics.filter(item => item.code === 'LABEL_OVERLAP' && !tagged.has(item.labelId));
    if (!overlapping.length || round >= valid.length) {
      const callouts = valid.filter(request => numbers.has(request.id)).map(request => ({ number: numbers.get(request.id)!, labelId: request.id, markId: request.markId, text: request.text.trim() }));
      const diagnostics = [...placed.diagnostics, ...callouts.map(callout => ({ code: 'LABEL_CALLOUT' as const, labelId: callout.labelId, markId: callout.markId, message: `Label “${callout.text.slice(0, 40)}” does not fit beside its feature; it is shown as callout ${callout.number} with its full text in the figure's label key.` }))];
      return { labels: placed.labels, diagnostics, callouts };
    }
    for (const item of overlapping) tagged.add(item.labelId);
  }
}

function placeOnce(requests: readonly LabelRequest[], options: { metrics: LabelMetrics; bounds: Rect; obstacles?: readonly LabelObstacle[] }, callouts: ReadonlyMap<string, number>): { labels: PlacedLabel[]; diagnostics: LabelDiagnostic[] } {
  const { metrics, bounds } = options;
  const obstacles = options.obstacles ?? [];
  const valid = requests.filter(request => request.text.trim() && request.at.every(Number.isFinite));
  // Every labelled point stays visible: no other label may cover it.
  const points = valid.map(request => ({ id: request.id, box: { x: request.at[0] - POINT_CLEARANCE, y: request.at[1] - POINT_CLEARANCE, width: 2 * POINT_CLEARANCE, height: 2 * POINT_CLEARANCE } }));
  const taken: Rect[] = [];
  const labels: PlacedLabel[] = [];
  const diagnostics: LabelDiagnostic[] = [];
  for (const request of valid) {
    const own = new Set(request.markIds ?? [request.markId]);
    const isOwn = (obstacle: LabelObstacle) => obstacle.markId !== undefined && own.has(obstacle.markId);
    const blocking: (Rect & { polygon?: LabelObstacle['polygon'] })[] = [
      ...taken,
      ...obstacles.filter(obstacle => !isOwn(obstacle)),
      ...points.filter(point => point.id !== request.id).map(point => point.box),
    ];
    // The label's own avoided obstacles (its arrowhead): kept clear when possible, never reported as an overlap.
    const ownAvoided = obstacles.filter(obstacle => isOwn(obstacle) && obstacle.own === 'avoid');
    const strict = [...blocking, ...ownAvoided];
    const placement = request.placement ?? DEFAULT_PLACEMENT;
    const callout = callouts.get(request.id);
    const lines = callout !== undefined ? [String(callout)] : wrapText(request.text, Math.max(metrics.fontPx * 3, placement.maxWidthEm * metrics.fontPx), metrics.charWidth, LABEL_MAX_LINES);
    // A callout tag is drawn on a small plate (its digits plus padding on each side).
    const width = Math.ceil(textWidth(lines, metrics)) + (callout !== undefined ? 8 : 2), height = lines.length * metrics.lineHeight;
    const offset: [number, number] = [placement.offset[0], placement.offset[1]];
    const magnitude: [number, number] = [Math.max(4, Math.abs(offset[0])), Math.max(4, Math.abs(offset[1]))];
    // Authored placement first; then every anchor at the same distance; then every anchor pushed further out. The order
    // is fixed, so the result is deterministic.
    const candidates: { anchor: Anchor; box: Rect; authored: boolean; push: number }[] = [{ anchor: placement.anchor, box: anchoredBox(request.at, placement.anchor, offset, width, height), authored: true, push: 0 }];
    for (const step of PUSH_STEPS) {
      const push = step * metrics.lineHeight;
      for (const anchor of [placement.anchor, ...ALTERNATES.filter(a => a !== placement.anchor)]) {
        if (step === 0 && anchor === placement.anchor) continue;
        candidates.push({ anchor, box: anchoredBox(request.at, anchor, [magnitude[0] + push, magnitude[1] + push], width, height), authored: false, push });
      }
    }
    const inBounds = candidates.filter(candidate => inside(candidate.box, bounds));
    const clearOf = (set: typeof blocking) => (candidate: typeof candidates[number]) => !set.some(other => blocks(candidate.box, other));
    // Clearance of a box from everything it must not be confused with (other labels, labelled points and marks' obstacles).
    const clearance = (box: Rect) => strict.reduce((least, other) => Math.min(least, gapBetween(box, other)), Infinity);
    let chosen: typeof candidates[number] | undefined = inBounds[0]?.authored && clearOf(strict)(inBounds[0]) ? inBounds[0] : undefined;
    for (const push of [...new Set(inBounds.map(candidate => candidate.push))]) {
      if (chosen) break;
      const atDistance = inBounds.filter(candidate => candidate.push === push);
      const strictFree = atDistance.filter(clearOf(strict));
      const free = strictFree.length ? strictFree : atDistance.filter(clearOf(blocking));
      chosen = free.reduce<typeof candidates[number] | undefined>((best, candidate) => !best || clearance(candidate.box) > clearance(best.box) + 0.5 ? candidate : best, undefined);
    }
    let nudged = !!chosen && !chosen.authored;
    if (!chosen) {
      // Nothing is free: keep the in-bounds candidate covering the least (first in order on ties), or clamp the authored box.
      const covered = (box: Rect) => blocking.reduce((sum, other) => sum + overlapArea(box, other), 0);
      const least = inBounds.reduce<{ candidate: typeof candidates[number]; area: number } | null>((best, candidate) => {
        const area = covered(candidate.box);
        return !best || area < best.area ? { candidate, area } : best;
      }, null);
      if (least) {
        chosen = least.candidate;
        nudged = !chosen.authored;
      } else {
        const authored = candidates[0]!.box;
        const box: Rect = {
          ...authored,
          x: Math.min(Math.max(bounds.x, authored.x), Math.max(bounds.x, bounds.x + bounds.width - authored.width)),
          y: Math.min(Math.max(bounds.y, authored.y), Math.max(bounds.y, bounds.y + bounds.height - authored.height)),
        };
        chosen = { anchor: placement.anchor, box, authored: true, push: 0 };
        nudged = box.x !== authored.x || box.y !== authored.y;
        if (nudged) diagnostics.push({ code: 'LABEL_CLAMPED', labelId: request.id, markId: request.markId, message: `Label “${request.text.slice(0, 40)}” was moved inside the view.` });
      }
      if (blocking.some(other => blocks(chosen!.box, other))) diagnostics.push({ code: 'LABEL_OVERLAP', labelId: request.id, markId: request.markId, message: `Label “${request.text.slice(0, 40)}” overlaps another label or mark; every label stays in the text description.` });
    } else if (nudged) {
      diagnostics.push({ code: 'LABEL_NUDGED', labelId: request.id, markId: request.markId, message: `Label “${request.text.slice(0, 40)}” was moved to avoid another label or mark.` });
    }
    const box = chosen.box;
    const edge = nearestEdgePoint(box, request.at);
    const distance = Math.hypot(edge[0] - request.at[0], edge[1] - request.at[1]);
    // A label pushed beyond its authored distance (or clamped away) is tied to its feature by a leader.
    const moved = nudged && (chosen.push > 0 || distance > Math.hypot(magnitude[0], magnitude[1]) + 1);
    const leader = placement.leader || moved ? { x1: request.at[0], y1: request.at[1], x2: edge[0], y2: edge[1] } : null;
    taken.push(box);
    const side = SIGN[chosen.anchor][0];
    const textAnchor = side < 0 ? 'end' : side > 0 ? 'start' : 'middle';
    const x = textAnchor === 'start' ? box.x + 1 : textAnchor === 'end' ? box.x + box.width - 1 : box.x + box.width / 2;
    if (callout !== undefined) labels.push({ id: request.id, markId: request.markId, lines, box, x: box.x + box.width / 2, y: box.y + metrics.lineHeight * 0.8, textAnchor: 'middle', leader, anchor: chosen.anchor, nudged, callout });
    else labels.push({ id: request.id, markId: request.markId, lines, box, x, y: box.y + metrics.lineHeight * 0.8, textAnchor, leader, anchor: chosen.anchor, nudged });
  }
  return { labels, diagnostics };
}

export interface LegendItem { markId: string; label: string; style: { role: string; dash: string; marker: string; weight: string }; kind: string }
export interface LegendEntry extends LegendItem { x: number; y: number; lines: string[] }
/** Wrapping legend rows (swatch + label); labels wrap to as many lines as they need and are never cut. */
export function layoutLegend(items: readonly LegendItem[], width: number, metrics: LabelMetrics, swatch = 30): { entries: LegendEntry[]; height: number } {
  const entries: LegendEntry[] = [];
  let x = 0, y = 0, rowHeight = 0;
  for (const item of items) {
    const lines = wrapText(item.label, Math.max(metrics.fontPx * 6, Math.min(width - swatch - 8, metrics.fontPx * 22)), metrics.charWidth, Infinity);
    const itemWidth = swatch + 6 + textWidth(lines, metrics) + 14;
    if (x > 0 && x + itemWidth > width) { y += rowHeight; x = 0; rowHeight = 0; }
    entries.push({ ...item, x, y, lines });
    x += itemWidth;
    rowHeight = Math.max(rowHeight, lines.length * metrics.lineHeight + 4);
  }
  return { entries, height: y + rowHeight };
}

export interface LabelKeyEntry extends LabelCallout { y: number; lines: string[] }
/** The label key under a figure: one row per callout (its number, then its full text wrapped, never cut). */
export function layoutLabelKey(callouts: readonly LabelCallout[], width: number, metrics: LabelMetrics, indent: number): { entries: LabelKeyEntry[]; height: number } {
  let y = 0;
  const entries = callouts.map(callout => {
    const lines = wrapText(callout.text, Math.max(metrics.fontPx * 6, width - indent), metrics.charWidth, Infinity);
    const entry = { ...callout, y, lines };
    y += lines.length * metrics.lineHeight + 4;
    return entry;
  });
  return { entries, height: y };
}
