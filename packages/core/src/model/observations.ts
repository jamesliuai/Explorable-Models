/**
 * Observed datasets (report §8.5): bounded, immutable rows of measured data with units, provenance and explicit
 * missing cells, kept distinct from model predictions.
 *
 * - Data live in `manifest.observations` and are part of the scientific identity (`identity.ts`).
 * - An `observations2` geometry plots two columns of one dataset. Its frame geometry is built here from the manifest by
 *   the runtime, never by a kernel or document: kernel output must not contain it, and the main thread checks that the
 *   observed geometry of every worker reply equals the manifest's rows exactly.
 * - Rows are never joined, interpolated, smoothed or fitted. A missing cell stays `null` with a reason; it is never 0.
 *   Connecting observations needs an explicit model series (a separate model geometry), which is the model's claim.
 */
import { canonicalJSON } from '../identity.js';
import type { Diagnostic } from '../declarative/types.js';
import { diagnostic, type ModelDiagnosticCode } from './errors.js';
import { MANIFEST_LIMITS } from './manifest-schema.js';
import type { ModelManifest, ObservationDataset, ObservationGeometry, ObservationPoint } from './types.js';
import { UNITS } from './units.js';

const REASON_LIMIT = 2000;

/** IDs of the manifest's observed (`observations2`) geometry, in manifest order. */
export const observationGeometryIds = (manifest: Pick<ModelManifest, 'geometry'>): string[] =>
  Object.entries(manifest.geometry).filter(([, definition]) => definition.kind === 'observations2').map(([id]) => id);

/** Reason for the missing cell (row, column) of a dataset: its own entry, else the dataset's `missingReason`. */
function missingReason(dataset: ObservationDataset, row: number, column: string): string {
  const own = dataset.missing?.find(entry => entry.row === row && entry.column === column);
  return own?.reason ?? dataset.missingReason ?? 'Missing observation.';
}

/** Frame geometry of one observed geometry, built from the manifest's dataset (a validated manifest is assumed). */
export function observationGeometry(manifest: ModelManifest, geometryId: string): ObservationGeometry {
  const binding = manifest.geometry[geometryId]?.observations;
  const dataset = binding ? manifest.observations?.[binding.dataset] : undefined;
  if (!binding || !dataset) throw new RangeError(`Geometry ${JSON.stringify(geometryId)} is not observed data of this manifest.`);
  const xi = dataset.columns.findIndex(column => column.id === binding.x), yi = dataset.columns.findIndex(column => column.id === binding.y);
  const source = manifest.sources.find(item => item.id === dataset.provenance.sourceId);
  const points: ObservationPoint[] = dataset.rows.map((row, index) => {
    const x = row[xi] ?? null, y = row[yi] ?? null;
    const point: ObservationPoint = { row: index, values: [x, y] };
    if (x === null || y === null) {
      const reasons = [...new Set([...(x === null ? [missingReason(dataset, index, binding.x)] : []), ...(y === null ? [missingReason(dataset, index, binding.y)] : [])])];
      point.reason = reasons.join('; ').slice(0, REASON_LIMIT);
    }
    return point;
  });
  return {
    kind: 'observations2', dataset: binding.dataset, columns: [binding.x, binding.y],
    provenance: {
      sourceId: dataset.provenance.sourceId, citation: source?.citation ?? '', description: dataset.provenance.description,
      ...(dataset.provenance.license !== undefined ? { license: dataset.provenance.license } : {}),
    },
    points,
  };
}

const cache = new WeakMap<object, { geometry: Record<string, ObservationGeometry>; canonical: Record<string, string> }>();
function built(manifest: ModelManifest): { geometry: Record<string, ObservationGeometry>; canonical: Record<string, string> } {
  const frozen = Object.isFrozen(manifest);
  const hit = frozen ? cache.get(manifest) : undefined;
  if (hit) return hit;
  const geometry: Record<string, ObservationGeometry> = {}, canonical: Record<string, string> = {};
  for (const id of observationGeometryIds(manifest)) { geometry[id] = observationGeometry(manifest, id); canonical[id] = canonicalJSON(geometry[id]); }
  const entry = { geometry, canonical };
  // Only a frozen (validated) manifest cannot change after it was cached.
  if (frozen) cache.set(manifest, entry);
  return entry;
}

/** Observed geometry of every `observations2` entry, keyed by geometry ID (fresh copies). */
export function observedGeometry(manifest: ModelManifest): Record<string, ObservationGeometry> {
  return structuredClone(built(manifest).geometry);
}

/** True when `value` is exactly the observed geometry the manifest defines for `geometryId`. */
export function matchesObservations(manifest: ModelManifest, geometryId: string, value: unknown): boolean {
  const expected = built(manifest).canonical[geometryId];
  if (expected === undefined) return false;
  try { return canonicalJSON(value) === expected; } catch { return false; }
}

/**
 * Semantic rules for observed datasets and `observations2` geometry (shape is checked by the manifest schema):
 * units match dimensions, column IDs are unique, rows have one cell per column, the total cell count is bounded,
 * provenance names a `dataset` source, every missing cell has a reason (its own entry or `missingReason`) and every
 * reason entry names a missing cell once; an observed geometry names a dataset and two of its columns, takes the
 * vertical column's dimension and unit, and has room for every row. Only `observations2` geometry has a binding.
 */
export function observationErrors(manifest: ModelManifest): Diagnostic[] {
  const errors: Diagnostic[] = [];
  const push = (code: ModelDiagnosticCode, path: string, message: string) => { errors.push(diagnostic(code, path, message)); };
  const datasets = manifest.observations ?? {};
  let cells = 0;
  for (const [id, dataset] of Object.entries(datasets)) {
    const path = `$.observations.${id}`;
    const columns = new Set<string>();
    dataset.columns.forEach((column, c) => {
      if (columns.has(column.id)) push('INVALID_INPUT', `${path}.columns[${c}].id`, 'Column IDs must be unique.');
      columns.add(column.id);
      if (UNITS[column.unit].dimension !== column.dimension) push('INVALID_INPUT', `${path}.columns[${c}].unit`, 'Unit does not match the declared dimension.');
    });
    let unexplained = false;
    dataset.rows.forEach((row, r) => {
      if (row.length !== dataset.columns.length) { push('INVALID_INPUT', `${path}.rows[${r}]`, 'Every row has exactly one cell per column.'); return; }
      row.forEach((cell, c) => { if (cell === null && !dataset.missing?.some(entry => entry.row === r && entry.column === dataset.columns[c]!.id)) unexplained = true; });
    });
    cells += dataset.rows.length * dataset.columns.length;
    if (unexplained && dataset.missingReason === undefined) push('INVALID_INPUT', `${path}.missingReason`, 'A missing cell needs a reason: list it in `missing` or give `missingReason`.');
    const named = new Set<string>();
    (dataset.missing ?? []).forEach((entry, m) => {
      const at = `${path}.missing[${m}]`, column = dataset.columns.findIndex(item => item.id === entry.column), key = `${entry.row}\u0000${entry.column}`;
      if (named.has(key)) push('INVALID_INPUT', at, 'A missing cell is listed more than once.');
      named.add(key);
      if (column < 0) push('INVALID_REFERENCE', `${at}.column`, 'The column does not exist in this dataset.');
      else if (entry.row >= dataset.rows.length) push('INVALID_REFERENCE', `${at}.row`, 'The row does not exist in this dataset.');
      else if (dataset.rows[entry.row]![column] !== null) push('INVALID_INPUT', at, 'Only a missing (null) cell has a missing reason; this cell holds a value.');
    });
    const source = manifest.sources.find(item => item.id === dataset.provenance.sourceId);
    if (!source) push('INVALID_REFERENCE', `${path}.provenance.sourceId`, 'Provenance must name a manifest source.');
    else if (source.kind !== 'dataset') push('INVALID_INPUT', `${path}.provenance.sourceId`, 'Observed data must cite a source of kind "dataset".');
  }
  if (cells > MANIFEST_LIMITS.observationCells) push('RESOURCE_LIMIT', '$.observations', `Observed datasets hold at most ${MANIFEST_LIMITS.observationCells} cells in total.`);
  for (const [id, definition] of Object.entries(manifest.geometry)) {
    const path = `$.geometry.${id}`;
    const binding = definition.observations;
    if (definition.kind !== 'observations2') {
      if (binding) push('INVALID_INPUT', `${path}.observations`, 'Only observations2 geometry plots an observed dataset.');
      continue;
    }
    if (!binding) { push('INVALID_INPUT', `${path}.observations`, 'Observed geometry names its dataset and its x and y columns.'); continue; }
    const dataset = datasets[binding.dataset];
    if (!dataset) { push('INVALID_REFERENCE', `${path}.observations.dataset`, 'The observed dataset does not exist.'); continue; }
    const column = (key: 'x' | 'y') => {
      const found = dataset.columns.find(item => item.id === binding[key]);
      if (!found) push('INVALID_REFERENCE', `${path}.observations.${key}`, 'The column does not exist in the observed dataset.');
      return found;
    };
    const x = column('x'), y = column('y');
    if (x && y && x.id === y.id) push('INVALID_INPUT', `${path}.observations`, 'Observed geometry plots two different columns.');
    if (y && (y.dimension !== definition.dimension || y.unit !== definition.unit)) push('INVALID_INPUT', `${path}.unit`, 'Observed geometry takes the dimension and unit of its vertical (y) column.');
    if (dataset.rows.length > definition.maxElements) push('RESOURCE_LIMIT', `${path}.maxElements`, 'The dataset has more rows than maxElements.');
  }
  return errors;
}
