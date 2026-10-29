// The reference host's lazy spatial renderer (report §13, A44, native G76). The learner card asks for it only when a
// `scene3d` view of a spatial activity is on screen; `import('@explorable-models/player-3d')` is a separate chunk (with
// Three.js) loaded from the packaged bundle under the production CSP, so a 2D activity never loads it. If the chunk
// cannot load, the card shows its tested 2D projection and coordinate table instead.
//
// Every mounted renderer is also kept in a small host-side registry (view, mount and disposal times and the renderer's
// own `stats()` counters) so the host can see that a spatial view rendered frames and released its resources when the
// card went away. The registry holds no projection data and is never shown to the learner.
import type { SpatialMountOptions, SpatialRendererInstance, SpatialRendererModule, SpatialRendererStats } from '@explorable-models/player/activity';

export interface SpatialRecord {
  viewId: string;
  mountedAtMs: number;
  disposedAtMs: number | null;
  /** The renderer's counters (frames rendered, live geometries/materials/textures, listeners, observers, pending work). */
  stats(): SpatialRendererStats | null;
}

const RECORD_LIMIT = 16;
const records: SpatialRecord[] = [];

/** Renderers mounted in this window, oldest first (at most 16). */
export function spatialRecords(): readonly SpatialRecord[] { return records; }

function tracked(module: SpatialRendererModule): SpatialRendererModule {
  return {
    webglAvailable: () => module.webglAvailable(),
    mount(element: HTMLElement, options: SpatialMountOptions): SpatialRendererInstance {
      const instance = module.mount(element, options);
      const record: SpatialRecord = { viewId: options.view.viewId, mountedAtMs: performance.now(), disposedAtMs: null, stats: () => instance.stats?.() ?? null };
      records.push(record);
      if (records.length > RECORD_LIMIT) records.shift();
      return {
        update: (view, presentation) => instance.update(view, presentation),
        dispose: () => { instance.dispose(); if (record.disposedAtMs === null) record.disposedAtMs = performance.now(); },
        ...(instance.stats ? { stats: () => instance.stats!() } : {}),
      };
    },
  };
}

let loading: Promise<SpatialRendererModule> | null = null;
/** `spatialLoader` for the learner card: the packed `@explorable-models/player-3d` chunk, loaded once. */
export function loadSpatialRenderer(): Promise<SpatialRendererModule> {
  loading ??= import('@explorable-models/player-3d').then(module => tracked(module), error => { loading = null; throw error; });
  return loading;
}
