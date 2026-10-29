/**
 * Installed activity capabilities (report §5.1, §13, A05; G52): versioned records of the optional runtime capabilities a
 * template may require, with the concrete limits that the semantic validator, the adapter and the renderer enforce.
 * They are contract data (`study-harness.capability-record` 1.0), not renderer assumptions: the schema bounds every
 * limit at the value recorded here, `validateTemplateSemantics` checks templates against them, `getCapabilities`
 * reports them, and the learner surface passes the spatial limits to the lazily loaded renderer, which enforces them per
 * view and per frame.
 *
 * A template's `requires` and a model's `capabilities` name capabilities by exact ID and version; an unknown ID or
 * version is rejected, never approximated by another version.
 */
import { deepFreeze } from '@experiment-kit/core';
import type { ModelManifest } from '@experiment-kit/core/model';
import { CONTRACTS, type ActivityTemplate, type CapabilityRef, type Diagnostic } from './contracts.js';

export const CAPABILITY_CONTRACT = CONTRACTS.capability;

/**
 * Spatial rendering limits of `spatial-3d@1.0`, per `scene3d` view: data-derived vertices, surface indices, vector-field
 * samples, overlay labels (axis names, mark labels, segment names, ticks), the largest texture edge (the renderer
 * allocates none) and draw calls per rendered frame (scaffolding included).
 */
export const SPATIAL_3D_LIMITS = Object.freeze({ vertices: 20_000, indices: 120_000, fieldSamples: 1_000, labels: 32, textureSize: 1024, drawCallsPerFrame: 128 });
/** Geometry kinds a `spatial-3d@1.0` view draws in 3D (2D geometry is drawn in the plane z = 0). */
export const SPATIAL_3D_GEOMETRY_KINDS = Object.freeze(['points3', 'segments3', 'polyline3', 'surface-grid', 'vector-field3'] as const);
/** Limits of `discrete-iteration@1.0`: the largest integer index a discrete kernel may declare (manifest 1.0 bound). */
export const DISCRETE_ITERATION_LIMITS = Object.freeze({ maxIndex: 10_000_000 });

export interface Spatial3dCapabilityRecord {
  contract: typeof CAPABILITY_CONTRACT;
  schemaVersion: '1.0';
  id: 'spatial-3d';
  version: '1.0';
  title: string;
  limits: { vertices: number; indices: number; fieldSamples: number; labels: number; textureSize: number; drawCallsPerFrame: number };
  geometryKinds: (typeof SPATIAL_3D_GEOMETRY_KINDS[number])[];
}
export interface DiscreteIterationCapabilityRecord {
  contract: typeof CAPABILITY_CONTRACT;
  schemaVersion: '1.0';
  id: 'discrete-iteration';
  version: '1.0';
  title: string;
  limits: { maxIndex: number };
}
export type CapabilityRecord = Spatial3dCapabilityRecord | DiscreteIterationCapabilityRecord;

export const SPATIAL_3D_CAPABILITY: Spatial3dCapabilityRecord = deepFreeze({
  contract: CAPABILITY_CONTRACT, schemaVersion: '1.0', id: 'spatial-3d', version: '1.0',
  title: 'Optional bounded 3D view (lazily loaded renderer) with a complete 2D projection and table alternative',
  limits: { ...SPATIAL_3D_LIMITS }, geometryKinds: [...SPATIAL_3D_GEOMETRY_KINDS],
});
export const DISCRETE_ITERATION_CAPABILITY: DiscreteIterationCapabilityRecord = deepFreeze({
  contract: CAPABILITY_CONTRACT, schemaVersion: '1.0', id: 'discrete-iteration', version: '1.0',
  title: 'Integer-indexed discrete iteration from index 0 with exact navigation and playback by whole indices',
  limits: { ...DISCRETE_ITERATION_LIMITS },
});

/** Every capability this runtime supports, in a stable order. */
export const INSTALLED_CAPABILITIES: readonly CapabilityRecord[] = Object.freeze([DISCRETE_ITERATION_CAPABILITY, SPATIAL_3D_CAPABILITY]);

/** The installed record for an exact ID and version, or null (unknown ID, or a version this runtime does not support). */
export function capabilityRecord(ref: CapabilityRef): CapabilityRecord | null {
  return INSTALLED_CAPABILITIES.find(record => record.id === ref.id && record.version === ref.version) ?? null;
}

const quoted = (text: string): string => JSON.stringify(text);
const RECOVERY = 'Require only capabilities that getCapabilities().capabilities lists, at exactly their listed version.';

/** Declared worst-case drawing work of one `scene3d` view, from the model's geometry bounds (`maxElements`). */
export interface SpatialViewWork { vertices: number; indices: number; fieldSamples: number; labels: number }

/**
 * Worst-case data-derived work of a `scene3d` view as the bounded renderer counts it (player-3d plan): each point,
 * polyline sample or polygon vertex is one vertex, a segment two, a vector-field arrow two (and one field sample), a
 * sampled surface one vertex per sample and fewer than ten surface indices per sample (six per grid cell for its two
 * triangles, four per sample for its wireframe edges); a coordinate-bound arrow or segment adds two vertices, a point
 * one. Labels count the three axis names and each mark that carries text.
 */
export function spatialViewWork(view: ActivityTemplate['views'][number], manifest: ModelManifest): SpatialViewWork {
  const work: SpatialViewWork = { vertices: 0, indices: 0, fieldSamples: 0, labels: 3 };
  for (const mark of view.marks) {
    if (mark.text !== undefined || mark.kind === 'label') work.labels += 1;
    const geometry = mark.bindings.geometry !== undefined ? manifest.geometry[mark.bindings.geometry] : undefined;
    if (!geometry) { work.vertices += mark.kind === 'arrow' || mark.kind === 'segment' ? 2 : mark.kind === 'point' ? 1 : 0; continue; }
    const n = geometry.maxElements;
    switch (geometry.kind) {
      case 'segments2': case 'segments3': work.vertices += 2 * n; break;
      case 'vector-field2': case 'vector-field3': work.vertices += 2 * n; work.fieldSamples += n; break;
      case 'surface-grid': work.vertices += n; work.indices += 10 * n; break;
      default: work.vertices += n;
    }
  }
  return work;
}

/**
 * Capability checks of a template against this runtime's installed capability records (G52; run by
 * `validateTemplateSemantics`): every required capability must be installed at its exact version (no nearest version is
 * substituted); a capability the model declares must be required by the template; a template with a `scene3d` view must
 * require `spatial-3d@1.0`; and each `scene3d` view's declared worst-case geometry must fit the spatial limits.
 */
export function capabilityDiagnostics(template: ActivityTemplate, manifest: ModelManifest): Diagnostic[] {
  const out: Diagnostic[] = [];
  const add = (code: Diagnostic['code'], path: string, message: string, recovery?: string) => out.push({ code, path, message, ...(recovery ? { recovery } : {}) });
  const seen = new Set<string>();
  template.requires.forEach((ref, index) => {
    if (seen.has(ref.id)) add('DUPLICATE_ID', `$.requires[${index}].id`, `Capability ${quoted(ref.id)} is required twice.`, 'Require each capability once.');
    seen.add(ref.id);
    if (!INSTALLED_CAPABILITIES.some(record => record.id === ref.id)) add('UNSUPPORTED_CAPABILITY', `$.requires[${index}].id`, `Capability ${quoted(ref.id)} is not supported by this runtime.`, RECOVERY);
    else if (!capabilityRecord(ref)) add('UNSUPPORTED_CAPABILITY', `$.requires[${index}].version`, `Version ${quoted(ref.version)} of capability ${quoted(ref.id)} is not supported; no other version is substituted.`, RECOVERY);
  });
  manifest.capabilities.forEach(ref => {
    // Capabilities outside the activity runtime (for example schema 2.0 document capabilities) are core's to check.
    if (!INSTALLED_CAPABILITIES.some(record => record.id === ref.id)) return;
    if (!template.requires.some(item => item.id === ref.id && item.version === ref.version))
      add('UNSUPPORTED_CAPABILITY', '$.requires', `The model needs capability ${quoted(`${ref.id}@${ref.version}`)}; the template must require it.`, 'Add the model\'s capability to the template\'s requires.');
  });
  const spatialViews = template.views.map((view, index) => ({ view, index })).filter(entry => entry.view.kind === 'scene3d');
  if (!spatialViews.length) return out;
  const spatial = capabilityRecord({ id: SPATIAL_3D_CAPABILITY.id, version: SPATIAL_3D_CAPABILITY.version }) as Spatial3dCapabilityRecord;
  if (!template.requires.some(ref => ref.id === spatial.id && ref.version === spatial.version))
    add('UNSUPPORTED_CAPABILITY', '$.requires', 'A template with a scene3d view must require spatial-3d@1.0, the capability that loads the bounded 3D renderer.', 'Add { id: "spatial-3d", version: "1.0" } to requires.');
  for (const { view, index } of spatialViews) {
    const work = spatialViewWork(view, manifest);
    const limits = spatial.limits;
    const over = (what: keyof SpatialViewWork, noun: string) => {
      if (work[what] > limits[what]) add('RESOURCE_LIMIT', `$.views[${index}]`, `The view declares up to ${work[what]} ${noun}; spatial-3d@1.0 draws at most ${limits[what]} per view.`, 'Lower the maxElements of the bound geometry, or show it in a 2D view or table.');
    };
    over('vertices', 'vertices'); over('indices', 'surface indices'); over('fieldSamples', 'vector-field samples'); over('labels', 'labels (axis names and mark text)');
  }
  return out;
}
