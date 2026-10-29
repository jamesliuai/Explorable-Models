/**
 * BROWSER INTEGRATION FIXTURE — the host's lazy spatial renderer loader for `?spatial=1` (report §13, A44).
 *
 * The page imports this module only through a dynamic `import()` when a card actually shows a `scene3d` view, so
 * neither this module nor `@experiment-kit/player-3d` (and Three.js) is part of the page's default 2D dependency graph.
 * Keeping the renderer import in its own module also contains failure: if the renderer cannot be resolved, transformed
 * or evaluated, only this dynamic import rejects and the card falls back to its 2D projection and coordinate table
 * (`SPATIAL_FALLBACK` diagnostic); the page itself keeps working.
 */
import type { SpatialRendererModule } from '@experiment-kit/player/activity';

export function loadSpatialRenderer(): Promise<SpatialRendererModule> {
  return import('@experiment-kit/player-3d');
}

/**
 * Releases the idle renderers the 3D renderer keeps for reuse in this document (its bounded renderer pool), as a host
 * does when no 3D view will be shown for a while. Returns how many were released.
 */
export async function releaseIdleSpatialRenderers(): Promise<number> {
  return (await import('@experiment-kit/player-3d')).releaseIdleRenderers();
}
