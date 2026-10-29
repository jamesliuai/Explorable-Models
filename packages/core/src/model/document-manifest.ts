/** Optional document/manifest agreement checks. Loaded only by enableDocumentExecution(), never a kernel-only runtime. */
import { inferExpressionType, parseDimension, sameDimension, type ExpressionType } from '../declarative/expressions.js';
import type { DatasetSpec, Diagnostic, SeriesSpec, VisualizationDocument } from '../declarative/types.js';
import type { CompiledDocument } from '../declarative/validation.js';
import { canonicalJSON } from '../identity.js';
import { documentUnits, sameScale } from './document-units.js';
import { diagnostic, type ModelDiagnosticCode } from './errors.js';
import { geometryCoordinates } from './geometry-units.js';
import type { DimensionId, ModelManifest, UnitId } from './types.js';
import { UNITS } from './units.js';

const sameKeys = (a: object, b: object): boolean => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.hasOwn(b, key));

/** Free-form schema 2.0 unit text accepted for a manifest unit: its ID (`m/s^2`) or its compact label (`m/s²`). */
const sameUnit = (text: string | undefined, unit: UnitId): boolean => text === undefined || text === unit || text === UNITS[unit].label;

/**
 * A manifest dimension in the base dimensions of the schema 2.0 dimensional algebra (`parseDimension`). `iteration` has
 * no counterpart: the algebra cannot tell an iteration count from a pure number, so a document cannot honour it.
 */
const DOCUMENT_DIMENSIONS: Readonly<Record<DimensionId, string | null>> = {
  dimensionless: 'dimensionless', iteration: null, length: 'length', time: 'time', mass: 'mass', acceleration: 'acceleration', force: 'force', angle: 'angle',
};

/**
 * The coordinates of a document's model series against the geometry's coordinate units: a sampled expression's x and
 * y dimensions (the sampling variable is a pure number) and a model dataset series' column units (base scale when unstated).
 */
function documentSeriesErrors(manifest: ModelManifest, compiled: CompiledDocument, id: string, units: ReturnType<typeof documentUnits>): Diagnostic[] {
  const errors: Diagnostic[] = [];
  const spec = compiled.document.series![id]!, coordinates = geometryCoordinates(manifest, id)!;
  for (const axis of ['x', 'y'] as const) {
    const unit = coordinates[axis], at = `$.execution.document.series.${id}.${axis}`;
    if (spec.dataset) {
      const column = compiled.document.datasets![spec.dataset]!.columns.find(item => item.id === (axis === 'x' ? spec.xColumn : spec.yColumn));
      if (column && (!sameUnit(column.unit, unit) || column.unit === undefined && UNITS[unit].factorToBase !== 1)) errors.push(diagnostic('UNIT_MISMATCH', `$.execution.document.datasets.${spec.dataset}.columns`, `The document column plotted as ${axis} of series ${JSON.stringify(id)} ${column.unit === undefined ? 'uses an unstated base scale other than' : 'states a unit other than'} the geometry's ${unit}.`, `Use ${unit} for the column, or declare the geometry's coordinates.`));
      continue;
    }
    const base = DOCUMENT_DIMENSIONS[UNITS[unit].dimension];
    if (base === null) { errors.push(diagnostic('UNIT_MISMATCH', `$.geometry.${id}.coordinates.${axis}`, 'A document series cannot have iteration coordinates: the document\'s dimensional algebra cannot distinguish an iteration count from a pure number.', 'Use an installed discrete kernel for iteration-indexed geometry.')); continue; }
    const node = compiled.series[id]![axis];
    const resolve = (name: string): ExpressionType => name === spec.variable ? { size: 1, dimension: {} } : name === 'time' ? { size: 1, dimension: { time: 1 } } : compiled.types[name]!;
    let computed: Record<string, number>;
    try { computed = inferExpressionType(node, resolve, at).dimension; } catch { continue; } // the compiler already reported it
    if (!sameDimension(computed, parseDimension(base)))
      errors.push(diagnostic('UNIT_MISMATCH', at, `The document computes the ${axis} coordinate of series ${JSON.stringify(id)} with a dimension other than the geometry's ${UNITS[unit].dimension} (${unit}).`, `Declare the geometry's coordinates (for example { x: "s", y: "m" }) to match the document, or correct the series expression.`));
    else {
      const scale = units.expressionScale(node, at, spec.variable);
      if (scale !== null && !sameScale(scale, UNITS[unit].factorToBase))
        errors.push(diagnostic('UNIT_MISMATCH', at, `The document computes the ${axis} coordinate of series ${JSON.stringify(id)} at a different unit scale than ${unit}; axis labels never convert values.`));
    }
  }
  return errors;
}

/**
 * Report §8.3, A10: the manifest's dimension and unit of a document parameter or quantity must be what the document
 * computes with. The document's dimension, declared or (for a quantity) inferred from its expression, must equal the
 * manifest dimension; an undeclared document parameter dimension is unspecified, not dimensionless, so it is accepted
 * only under an explicitly dimensionless manifest parameter (where the document's default agrees). A unit the document
 * states must be the manifest unit (its ID or compact label): document units are labels and nothing converts them.
 */
function documentAgreementErrors(kind: 'parameter' | 'quantity', id: string, declared: { dimension: DimensionId; unit: UnitId }, document: { dimension?: string; unit?: string }, computed: Record<string, number>, scale: number | null): Diagnostic[] {
  const errors: Diagnostic[] = [];
  const at = `$.execution.document.${kind === 'parameter' ? 'parameters' : 'quantities'}.${id}`;
  const base = DOCUMENT_DIMENSIONS[declared.dimension];
  if (base === null) {
    errors.push(diagnostic('UNIT_MISMATCH', `$.${kind === 'parameter' ? 'parameters' : 'quantities'}.${id}.dimension`, `A document ${kind} cannot have the iteration dimension: the document's dimensional algebra cannot distinguish an iteration count from a pure number.`, 'Declare it dimensionless, or model iterations with an installed discrete kernel.'));
    return errors;
  }
  if (kind === 'parameter' && document.dimension === undefined && declared.dimension !== 'dimensionless')
    errors.push(diagnostic('UNIT_MISMATCH', `${at}.dimension`, `The document leaves the dimension of ${kind} ${JSON.stringify(id)} unspecified, but the manifest declares ${declared.dimension}; an unspecified dimension is not checked as ${declared.dimension}.`, `Declare dimension "${base}" on the document ${kind}.`));
  else if (!sameDimension(computed, parseDimension(base)))
    errors.push(diagnostic('UNIT_MISMATCH', document.dimension === undefined ? `${at}.expression` : `${at}.dimension`, `The document computes ${kind} ${JSON.stringify(id)} with a different dimension than the manifest's ${declared.dimension}.`, `Make the document ${kind} a ${declared.dimension} (declared dimension "${base}"), or correct the manifest dimension and unit.`));
  if (!sameUnit(document.unit, declared.unit) || scale !== null && !sameScale(scale, UNITS[declared.unit].factorToBase))
    errors.push(diagnostic('UNIT_MISMATCH', `${at}.unit`, `The document's stated or computed unit for ${kind} ${JSON.stringify(id)} differs from the manifest unit ${declared.unit}; units are labels and are never converted.`, 'Declare the coherent unit of the computation. Unstated input units use the base scale; output units follow the expression.'));
  return errors;
}

/**
 * A document's observed series (a dataset series of kind `observed`): it maps to `observations2` geometry over the same
 * dataset and columns, and the manifest observation dataset with the same ID carries exactly the document dataset's
 * columns and rows (adding units, meanings, missing-cell reasons and provenance). The runtime draws observations from
 * that manifest dataset, so the two can never disagree. A sampled expression is model output and cannot be observed.
 */
function observedSeriesErrors(manifest: ModelManifest, document: VisualizationDocument, id: string, spec: SeriesSpec): Diagnostic[] {
  const errors: Diagnostic[] = [];
  const push = (code: ModelDiagnosticCode, path: string, message: string) => { errors.push(diagnostic(code, path, message)); };
  if (!spec.dataset) { push('INVALID_INPUT', `$.execution.document.series.${id}.kind`, 'Only dataset rows can be observed; a sampled expression is model output.'); return errors; }
  const g = manifest.geometry[id]!;
  if (g.kind !== 'observations2') { push('INVALID_INPUT', `$.geometry.${id}.kind`, 'Observed document series map to observations2 geometry.'); return errors; }
  const binding = g.observations;
  if (!binding || binding.dataset !== spec.dataset || binding.x !== spec.xColumn || binding.y !== spec.yColumn)
    push('INVALID_REFERENCE', `$.geometry.${id}.observations`, 'Observed geometry names the same dataset and x and y columns as the document series.');
  const source: DatasetSpec = document.datasets![spec.dataset]!;
  const observed = manifest.observations?.[spec.dataset];
  if (!observed) { push('INVALID_REFERENCE', `$.observations.${spec.dataset}`, 'An observed document dataset needs a manifest observation dataset with the same ID.'); return errors; }
  if (source.columns.length !== observed.columns.length || source.columns.some((column, c) => column.id !== observed.columns[c]!.id))
    push('INVALID_INPUT', `$.observations.${spec.dataset}.columns`, 'The manifest dataset lists the document dataset\'s columns in the same order.');
  else source.columns.forEach((column, c) => {
    if (!sameUnit(column.unit, observed.columns[c]!.unit)) push('INVALID_INPUT', `$.observations.${spec.dataset}.columns[${c}].unit`, 'The document column unit differs from the manifest column unit.');
    else if (column.unit === undefined && UNITS[observed.columns[c]!.unit].factorToBase !== 1)
      push('UNIT_MISMATCH', `$.observations.${spec.dataset}.columns[${c}].unit`, 'An unstated document column unit uses the coherent base scale, which differs from the manifest unit.');
  });
  if (canonicalJSON(source.rows) !== canonicalJSON(observed.rows)) push('INVALID_INPUT', `$.observations.${spec.dataset}.rows`, 'The manifest dataset rows must equal the document dataset rows exactly.');
  return errors;
}

/** The compiled document must name the same parameters, quantities, observed data, units and bounded series. */
export function documentManifestErrors(manifest: ModelManifest, compiled: CompiledDocument): Diagnostic[] {
  const errors: Diagnostic[] = [];
  const push = (code: ModelDiagnosticCode, path: string, message: string) => { errors.push(diagnostic(code, path, message)); };
  const document = compiled.document;
  const units = documentUnits(compiled);
  if (!sameKeys(document.parameters, manifest.parameters)) push('INVALID_REFERENCE', '$.execution.document.parameters', 'Document parameters must equal the manifest parameter IDs.');
  else for (const [id, p] of Object.entries(manifest.parameters)) {
    const spec = document.parameters[id];
    if (spec.min !== p.min || spec.max !== p.max) push('INVALID_INPUT', `$.execution.document.parameters.${id}`, 'Document bounds must equal the manifest bounds.');
    if ((spec.integer ?? false) !== (p.step.admissible === 'integer')) push('INVALID_INPUT', `$.execution.document.parameters.${id}.integer`, 'Document integer flag must match manifest admissibility.');
    errors.push(...documentAgreementErrors('parameter', id, p, spec, compiled.types[id]!.dimension, units.scales[id]!));
  }
  if (!sameKeys(document.quantities, manifest.quantities)) push('INVALID_REFERENCE', '$.execution.document.quantities', 'Every document quantity needs a manifest quantity with the same ID, and vice versa.');
  else for (const [id, q] of Object.entries(manifest.quantities)) {
    const size = compiled.types[id].size;
    if (size === 1 ? q.shape.kind !== 'scalar' : q.shape.kind !== 'vector' || q.shape.length !== size) push('INVALID_INPUT', `$.quantities.${id}.shape`, 'Shape does not match the document quantity.');
    errors.push(...documentAgreementErrors('quantity', id, q, document.quantities[id]!, compiled.types[id]!.dimension, units.scales[id]!));
  }
  const series = document.series ?? {};
  if (!sameKeys(series, manifest.geometry)) push('INVALID_REFERENCE', '$.execution.document.series', 'Every document series needs a geometry entry with the same ID (polyline2 for model series, observations2 for observed data), and vice versa.');
  else for (const [id, spec] of Object.entries(series)) {
    const g = manifest.geometry[id];
    const count = spec.dataset ? document.datasets![spec.dataset].rows.length : spec.samples!;
    // Normalized documents label every series: dataset series default to `observed`, sampled expressions to `model`.
    if (spec.kind === 'observed') errors.push(...observedSeriesErrors(manifest, document, id, spec));
    else if (g.kind !== 'polyline2') push('INVALID_INPUT', `$.geometry.${id}.kind`, 'Model series of a document map to polyline2 geometry.');
    else errors.push(...documentSeriesErrors(manifest, compiled, id, units));
    if (count > g.maxElements) push('RESOURCE_LIMIT', `$.geometry.${id}.maxElements`, 'The series has more samples than maxElements.');
  }
  errors.push(...units.errors);
  return errors;
}
