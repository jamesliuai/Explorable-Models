/**
 * Screen-space label layout helpers of the spatial renderer (report §10.2, §10.4; G55). Pure: CSS-pixel boxes
 * `[left, top, right, bottom]` and capsules (a segment thickened by a radius) for arrow shafts and arrowheads, which
 * labels treat as obstacles. Labels never cover an arrowhead; they avoid shafts and other labels where an alternative
 * position exists.
 */
export type Box = readonly [number, number, number, number];
export interface Capsule { readonly from: readonly [number, number]; readonly to: readonly [number, number]; readonly radius: number }

const cross = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx;
function segmentsIntersect(a: readonly [number, number], b: readonly [number, number], c: readonly [number, number], d: readonly [number, number]): boolean {
  const d1 = cross(d[0] - c[0], d[1] - c[1], a[0] - c[0], a[1] - c[1]), d2 = cross(d[0] - c[0], d[1] - c[1], b[0] - c[0], b[1] - c[1]);
  const d3 = cross(b[0] - a[0], b[1] - a[1], c[0] - a[0], c[1] - a[1]), d4 = cross(b[0] - a[0], b[1] - a[1], d[0] - a[0], d[1] - a[1]);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
function pointSegmentDistance(p: readonly [number, number], a: readonly [number, number], b: readonly [number, number]): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], length2 = dx * dx + dy * dy;
  const t = length2 > 0 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
const pointBoxDistance = (p: readonly [number, number], box: Box) => Math.hypot(Math.max(box[0] - p[0], 0, p[0] - box[2]), Math.max(box[1] - p[1], 0, p[1] - box[3]));

/** Distance between a segment and a box (0 when they touch or overlap). */
export function segmentBoxDistance(from: readonly [number, number], to: readonly [number, number], box: Box): number {
  const inside = (p: readonly [number, number]) => p[0] >= box[0] && p[0] <= box[2] && p[1] >= box[1] && p[1] <= box[3];
  if (inside(from) || inside(to)) return 0;
  const corners: [number, number][] = [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]];
  for (let i = 0; i < 4; i++) if (segmentsIntersect(from, to, corners[i]!, corners[(i + 1) % 4]!)) return 0;
  return Math.min(pointBoxDistance(from, box), pointBoxDistance(to, box), ...corners.map(corner => pointSegmentDistance(corner, from, to)));
}
/** True when the capsule (segment ± radius) overlaps the box. */
export const capsuleHitsBox = (capsule: Capsule, box: Box): boolean => segmentBoxDistance(capsule.from, capsule.to, box) < capsule.radius;
export const boxesOverlap = (a: Box, b: Box): boolean => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

/**
 * The first candidate box free of placed labels, arrowheads and shafts; otherwise the first free of placed labels and
 * arrowheads; otherwise the first free of arrowheads; otherwise null (the label is hidden rather than cover an arrowhead).
 */
export function chooseLabelBox(candidates: readonly Box[], placed: readonly Box[], heads: readonly Capsule[], shafts: readonly Capsule[]): Box | null {
  const clearOfLabels = (box: Box) => !placed.some(other => boxesOverlap(box, other));
  const clearOfHeads = (box: Box) => !heads.some(head => capsuleHitsBox(head, box));
  const clearOfShafts = (box: Box) => !shafts.some(shaft => capsuleHitsBox(shaft, box));
  return candidates.find(box => clearOfLabels(box) && clearOfHeads(box) && clearOfShafts(box))
    ?? candidates.find(box => clearOfLabels(box) && clearOfHeads(box))
    ?? candidates.find(clearOfHeads)
    ?? null;
}
