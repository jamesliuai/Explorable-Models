/**
 * Manifest validation: bounded shape (MODEL_MANIFEST_SCHEMA) and then semantic rules. Returns deep-frozen copies;
 * the caller's object is never retained or mutated.
 */
import { expressionReferences } from '../declarative/expressions.js';
import { DocumentError, type Diagnostic } from '../declarative/types.js';
import type { CompiledDocument } from '../declarative/validation.js';
import { deepFreeze } from '../identity.js';
import { checkParameters, constraintAst, isAdmissible } from './constraints.js';
import { documentExecution, missingDocumentSupport } from './document-support.js';
import { dependentCoordinate } from './geometry-units.js';
import { diagnostic, ModelError, type ModelDiagnosticCode } from './errors.js';
import { modelIdentity } from './identity.js';
import { observationErrors } from './observations.js';
import { manifestShapeErrors } from './manifest-schema.js';
import type { ModelIdentity, ModelManifest } from './types.js';
import { UNITS } from './units.js';

const RESERVED = new Set(['pi', 'e', 'time', '__proto__', 'prototype', 'constructor']);
const validated = new WeakSet<object>();

export { dependentCoordinate, geometryCoordinates } from './geometry-units.js';

/** True for a manifest object returned by `validateManifest` (frozen, so it cannot have changed since). */
export const isValidatedManifest = (value: unknown): value is ModelManifest => !!value && typeof value === 'object' && validated.has(value);

export interface AnalyzedManifest { manifest: ModelManifest; compiled: CompiledDocument | null }

const documentCode = (code: string): ModelDiagnosticCode => code === 'SCHEMA' ? 'SCHEMA' : code === 'REFERENCE' ? 'INVALID_REFERENCE' : code === 'LIMIT' ? 'RESOURCE_LIMIT' : 'INVALID_INPUT';
/** Declared coordinate units must fit the kind, name the geometry's own unit for its dependent coordinate and repeat observed columns' units. */
function coordinateErrors(manifest: ModelManifest): Diagnostic[] {
  const errors: Diagnostic[] = [];
  for (const [id, g] of Object.entries(manifest.geometry)) {
    const declared = g.coordinates;
    if (!declared) continue;
    const path = `$.geometry.${id}.coordinates`, dependent = dependentCoordinate(g.kind);
    if (dependent === 'z' && declared.z === undefined) errors.push(diagnostic('INVALID_INPUT', `${path}.z`, `A ${g.kind} geometry declares the unit of its z coordinate.`));
    if (dependent === 'y' && declared.z !== undefined) errors.push(diagnostic('INVALID_INPUT', `${path}.z`, `A ${g.kind} geometry has no z coordinate.`));
    const unit = declared[dependent];
    if (unit !== undefined && unit !== g.unit)
      errors.push(diagnostic('UNIT_MISMATCH', `${path}.${dependent}`, `The ${dependent} coordinate is the geometry's dependent coordinate, whose unit is ${g.unit}.`, `Declare ${dependent}: "${g.unit}", or change the geometry's dimension and unit.`));
    if (g.kind === 'observations2' && g.observations) {
      const columns = manifest.observations?.[g.observations.dataset]?.columns ?? [];
      for (const axis of ['x', 'y'] as const) {
        const column = columns.find(item => item.id === g.observations![axis]);
        if (column && column.unit !== declared[axis]) errors.push(diagnostic('UNIT_MISMATCH', `${path}.${axis}`, `Observed coordinates are in their column's unit ${column.unit}.`, `Declare ${axis}: "${column.unit}" or omit coordinates.`));
      }
    }
  }
  return errors;
}

/**
 * Shape and semantic validation without identity hashing (used per request inside workers). Throws ModelError with
 * every semantic diagnostic found. The returned manifest is a mutable structured clone.
 */
export function analyzeManifest(input: unknown): AnalyzedManifest {
  const shape = manifestShapeErrors(input);
  if (shape.length) throw new ModelError(shape);
  const manifest = structuredClone(input) as ModelManifest;
  const errors: Diagnostic[] = [];
  const push = (code: ModelDiagnosticCode, path: string, message: string) => { errors.push(diagnostic(code, path, message)); };
  const reserved = (id: string) => id.split('.').some(piece => RESERVED.has(piece));

  for (const [id, p] of Object.entries(manifest.parameters)) {
    const path = `$.parameters.${id}`;
    if (reserved(id)) push('INVALID_INPUT', path, 'Parameter ID is reserved.');
    if (UNITS[p.unit].dimension !== p.dimension) push('INVALID_INPUT', `${path}.unit`, 'Unit does not match the declared dimension.');
    if (!(p.min < p.max)) push('INVALID_INPUT', path, 'The minimum must be less than the maximum.');
    else if (p.default < p.min || p.default > p.max) push('OUT_OF_DOMAIN', `${path}.default`, 'The default must lie within the parameter bounds.');
    else if (!isAdmissible(p, p.default)) push('INVALID_INPUT', `${path}.default`, 'The default is not an admissible value.');
  }
  for (const [id, q] of Object.entries(manifest.quantities)) {
    const path = `$.quantities.${id}`;
    if (reserved(id)) push('INVALID_INPUT', path, 'Quantity ID is reserved.');
    if (UNITS[q.unit].dimension !== q.dimension) push('INVALID_INPUT', `${path}.unit`, 'Unit does not match the declared dimension.');
    if (q.shape.kind === 'category' && new Set(q.shape.values).size !== q.shape.values.length) push('INVALID_INPUT', `${path}.shape.values`, 'Category values must be unique.');
  }
  for (const [id, g] of Object.entries(manifest.geometry)) {
    const path = `$.geometry.${id}`;
    if (UNITS[g.unit].dimension !== g.dimension) push('INVALID_INPUT', `${path}.unit`, 'Unit does not match the declared dimension.');
    if (g.maxElements > manifest.limits.maxGeometryElements) push('RESOURCE_LIMIT', `${path}.maxElements`, 'Exceeds limits.maxGeometryElements.');
  }
  const constraintIds = new Set<string>();
  manifest.constraints.forEach((c, index) => {
    const path = `$.constraints[${index}]`;
    if (constraintIds.has(c.id)) push('INVALID_INPUT', `${path}.id`, 'Constraint IDs must be unique.');
    constraintIds.add(c.id);
    if (c.min === undefined && c.max === undefined) push('INVALID_INPUT', path, 'A constraint needs a minimum or maximum.');
    if (c.min === undefined && c.minInclusive !== undefined || c.max === undefined && c.maxInclusive !== undefined) push('INVALID_INPUT', path, 'Inclusivity applies only to a declared bound.');
    if (c.min !== undefined && c.max !== undefined && (c.min > c.max || c.min === c.max && (c.minInclusive === false || c.maxInclusive === false))) push('INVALID_INPUT', path, 'The constraint interval is empty.');
    try {
      for (const ref of expressionReferences(constraintAst(c.expression))) if (ref !== 'pi' && ref !== 'e' && !Object.hasOwn(manifest.parameters, ref)) push('INVALID_REFERENCE', `${path}.expression`, `Constraints may reference only parameter IDs; '${ref.slice(0, 80)}' is not one.`);
    } catch (error) {
      push('INVALID_INPUT', `${path}.expression`, error instanceof DocumentError ? error.diagnostics[0].message : 'Invalid constraint expression.');
    }
  });
  errors.push(...observationErrors(manifest));
  errors.push(...coordinateErrors(manifest));
  const sourceIds = new Set(manifest.sources.map(source => source.id));
  if (sourceIds.size !== manifest.sources.length) push('INVALID_INPUT', '$.sources', 'Source IDs must be unique.');
  if (new Set(manifest.capabilities.map(c => c.id)).size !== manifest.capabilities.length) push('INVALID_INPUT', '$.capabilities', 'Capability IDs must be unique.');

  const execution = manifest.execution;
  let compiled: CompiledDocument | null = null;
  if (execution.kind === 'kernel' && execution.mode === 'discrete') {
    if (!Number.isSafeInteger(execution.maxIndex)) push('INVALID_INPUT', '$.execution.maxIndex', 'maxIndex must be a safe integer.');
    if (manifest.limits.maxIndex !== execution.maxIndex) push('INVALID_INPUT', '$.limits.maxIndex', 'limits.maxIndex must equal execution.maxIndex.');
  } else if (manifest.limits.maxIndex !== undefined) push('INVALID_INPUT', '$.limits.maxIndex', 'maxIndex applies only to discrete kernels.');
  if (execution.kind === 'document') {
    // The compiler is optional (document-support.ts): without enableDocumentExecution() this throws UNSUPPORTED_CAPABILITY.
    const support = documentExecution('$.execution');
    if (!support.manifestErrors) missingDocumentSupport('$.execution', 'manifest validation');
    try { compiled = support.compile(execution.document); } catch (error) {
      if (!(error instanceof DocumentError)) throw error;
      for (const item of error.diagnostics.slice(0, 16)) push(documentCode(item.code), `$.execution.document${item.path.startsWith('$') ? item.path.slice(1) : `.${item.path}`}`, item.message);
    }
    if (compiled) {
      errors.push(...support.manifestErrors(manifest, compiled));
    }
  }
  if (!errors.length) {
    const defaults = Object.fromEntries(Object.entries(manifest.parameters).map(([id, p]) => [id, p.default]));
    for (const item of checkParameters(manifest, defaults)) push(item.code as ModelDiagnosticCode, item.path, `Default parameters are inadmissible: ${item.message}`);
  }
  if (errors.length) throw new ModelError(errors);
  return { manifest, compiled };
}

/** Validates a manifest and returns deep-frozen copies of it and its identity. */
export function validateManifest(input: unknown): { manifest: ModelManifest; identity: ModelIdentity } {
  if (isValidatedManifest(input)) return deepFreeze({ manifest: input, identity: modelIdentity(input) });
  const { manifest } = analyzeManifest(input);
  const result = deepFreeze({ manifest, identity: modelIdentity(manifest) });
  validated.add(result.manifest);
  return result;
}

/** Default canonical parameter values. */
export const defaultParameters = (manifest: ModelManifest): Record<string, number> =>
  Object.fromEntries(Object.entries(manifest.parameters).map(([id, p]) => [id, p.default]));
