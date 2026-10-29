/** Small 3-vector helpers (plain tuples, no Three.js), shared by the pure planning and camera modules. */
export type Vec3 = [number, number, number];

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
/** Unit vector, or null for a zero or non-finite vector (a zero vector has no direction). */
export function normalize(a: Vec3): Vec3 | null {
  const n = length(a);
  return n > 0 && Number.isFinite(n) ? [a[0] / n, a[1] / n, a[2] / n] : null;
}
export const sameVec = (a: Vec3, b: Vec3): boolean => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
export const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * A finite 3D coordinate from projection data: three finite numbers, or two (a 2D coordinate placed in the z = 0
 * plane of a 3D view). Anything else is null and is reported as undefined, never drawn as zero.
 */
export function vec3(value: readonly number[] | null | undefined): Vec3 | null {
  if (!Array.isArray(value)) return null;
  if (value.length === 3 && value.every(isFiniteNumber)) return [value[0]!, value[1]!, value[2]!];
  if (value.length === 2 && value.every(isFiniteNumber)) return [value[0]!, value[1]!, 0];
  return null;
}
