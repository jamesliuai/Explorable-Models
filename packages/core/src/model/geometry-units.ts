/** Canonical coordinate units shared by kernel and document manifests and template semantics. */
import type { GeometryCoordinates, GeometryKind, ModelManifest, UnitId } from './types.js';

/** Geometry kinds whose points have a z coordinate (their dependent coordinate); every other kind is planar (x, y). */
const SPATIAL_KINDS: ReadonlySet<GeometryKind> = new Set(['polyline3', 'points3', 'segments3', 'vector-field3', 'surface-grid']);
/** The dependent coordinate of a geometry kind: the one `dimension`/`unit` describe. */
export const dependentCoordinate = (kind: GeometryKind): 'y' | 'z' => SPATIAL_KINDS.has(kind) ? 'z' : 'y';

/**
 * Canonical units of the coordinates of geometry `id` (report §8.3): its declared `coordinates`; absent, the units of
 * an observed geometry's x and y columns, or `unit` for every coordinate of any other geometry. Null for an unknown ID.
 * Template axes drawing the geometry must name these units exactly (`@explorable-models/activity` semantic validation).
 */
export function geometryCoordinates(manifest: ModelManifest, id: string): GeometryCoordinates | null {
  const g = Object.hasOwn(manifest.geometry, id) ? manifest.geometry[id] : undefined;
  if (!g) return null;
  if (g.coordinates) return { ...g.coordinates };
  if (g.kind === 'observations2' && g.observations) {
    const columns = manifest.observations?.[g.observations.dataset]?.columns ?? [];
    const unitOf = (column: string): UnitId => columns.find(item => item.id === column)?.unit ?? g.unit;
    return { x: unitOf(g.observations.x), y: unitOf(g.observations.y) };
  }
  return SPATIAL_KINDS.has(g.kind) ? { x: g.unit, y: g.unit, z: g.unit } : { x: g.unit, y: g.unit };
}

