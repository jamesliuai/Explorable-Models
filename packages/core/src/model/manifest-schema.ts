/**
 * Authoritative JSON Schema (bounded 2020-12 subset) for model manifest 1.0. Shape only: semantic rules (ordered
 * bounds, unit/dimension agreement, constraint references, document agreement, limits) are enforced by
 * `validateManifest`. Unknown fields are rejected at every level.
 */
import type { Diagnostic } from '../declarative/types.js';
import { deepFreeze } from '../identity.js';
import { S, SAFE_NUMBER, validateJson, type DataLimits, type JsonSchema } from './json-schema.js';
import { MODEL_CONTRACT, MODEL_SCHEMA_VERSION } from './types.js';
import { DIMENSION_IDS, UNIT_IDS } from './units.js';

/**
 * Bounds of manifest 1.0 (report §5.1). `maxIndex` is the largest discrete iteration index; activity records that
 * carry positions or `lastFiniteIndex` (`@explorable-models/activity` schemas) use the same bound, so every position of
 * a valid manifest is recordable.
 */
export const MANIFEST_LIMITS = Object.freeze({
  parameters: 64, quantities: 128, geometry: 32, constraints: 32, capabilities: 16, sources: 64, interpretationItems: 64,
  categoryValues: 64, vectorLength: 1024, matrixSide: 64, expression: 2048, text: 4000, label: 200, symbol: 64,
  maxIndex: 10_000_000, maxGeometryElements: 100_000, maxOperations: 1_000_000_000, bytes: 1_048_576,
  // Observed datasets (report §8.5): every observation row is carried in every frame, so they stay small.
  observationDatasets: 8, observationColumns: 16, observationRows: 2000, observationCells: 20_000,
});
/** Parameter/quantity IDs are expression symbols so constraints and documents can reference them. */
export const SYMBOL_PATTERN = '^[A-Za-z_][A-Za-z0-9_]*([.][A-Za-z_][A-Za-z0-9_]*)*$';
export const GEOMETRY_ID_PATTERN = '^[A-Za-z_][A-Za-z0-9_.-]{0,79}$';
export const CAPABILITY_VERSION_PATTERN = '^[0-9]{1,4}([.][0-9]{1,4}){0,2}$';
/** Data limits applied before schema traversal; a document execution is the largest legitimate payload. */
export const MANIFEST_DATA_LIMITS: DataLimits = Object.freeze({ maxBytes: MANIFEST_LIMITS.bytes, maxDepth: 40, maxNodes: 120_000 });

const label = (): JsonSchema => S.text(MANIFEST_LIMITS.label);
const text = (): JsonSchema => S.text(MANIFEST_LIMITS.text);
const unit = (): JsonSchema => S.oneOfValues([...UNIT_IDS]);
const dimension = (): JsonSchema => S.oneOfValues([...DIMENSION_IDS]);
const symbolKey = (): JsonSchema => S.pattern(SYMBOL_PATTERN, 80);

const parameter = S.object({
  label: label(), symbol: S.text(MANIFEST_LIMITS.symbol), description: text(), dimension: dimension(), unit: unit(),
  min: S.number(), max: S.number(), default: S.number(),
  step: S.object({ ui: S.positive(), admissible: S.oneOf(S.oneOfValues(['continuous', 'integer']), S.object({ multipleOf: S.positive() })) }),
  role: S.constant('model-input'),
}, ['label', 'description', 'dimension', 'unit', 'min', 'max', 'default', 'step', 'role']);

const shape = S.oneOf(
  S.object({ kind: S.constant('scalar') }),
  S.object({ kind: S.constant('vector'), length: S.integer(1, MANIFEST_LIMITS.vectorLength) }),
  S.object({ kind: S.constant('matrix'), rows: S.integer(1, MANIFEST_LIMITS.matrixSide), columns: S.integer(1, MANIFEST_LIMITS.matrixSide) }),
  S.object({ kind: S.constant('category'), values: S.array(label(), MANIFEST_LIMITS.categoryValues, 1) }),
);
const quantity = S.object({
  label: label(), symbol: S.text(MANIFEST_LIMITS.symbol), shape, dimension: dimension(), unit: unit(), meaning: text(),
  coordinateFrame: label(), signConvention: text(),
}, ['label', 'shape', 'dimension', 'unit', 'meaning']);

/** An object schema whose `keys` are optional (additive 1.0 fields); every other property stays required. */
const optional = (schema: JsonSchema, ...keys: string[]): JsonSchema => ({ ...schema, required: (schema.required ?? []).filter(key => !keys.includes(key)) });

const dataId = (): JsonSchema => S.pattern(GEOMETRY_ID_PATTERN, 80);
const geometry = optional(S.object({
  kind: S.oneOfValues(['polyline2', 'points2', 'segments2', 'polygon2', 'polyline3', 'points3', 'segments3', 'surface-grid', 'vector-field2', 'vector-field3', 'observations2']),
  label: label(), description: text(), dimension: dimension(), unit: unit(), coordinateFrame: label(),
  maxElements: S.integer(1, MANIFEST_LIMITS.maxGeometryElements),
  observations: S.object({ dataset: dataId(), x: dataId(), y: dataId() }),
  // Canonical unit of each coordinate (additive in 1.0; see ModelGeometryDefinition.coordinates).
  coordinates: S.object({ x: unit(), y: unit(), z: unit() }, ['x', 'y']),
}), 'observations', 'coordinates');

/** Observed dataset (report §8.5). Cross-references, row widths, missing-cell reasons and units are checked semantically. */
const observationDataset = S.object({
  label: label(), description: text(),
  columns: S.array(S.object({ id: dataId(), label: label(), dimension: dimension(), unit: unit(), meaning: text() }), MANIFEST_LIMITS.observationColumns, 1),
  rows: S.array(S.array({ type: ['number', 'null'], minimum: -SAFE_NUMBER, maximum: SAFE_NUMBER }, MANIFEST_LIMITS.observationColumns, 1), MANIFEST_LIMITS.observationRows, 1),
  missing: S.array(S.object({ row: S.integer(0, MANIFEST_LIMITS.observationRows - 1), column: dataId(), reason: S.text(2000) }), MANIFEST_LIMITS.observationCells),
  missingReason: S.text(2000),
  provenance: S.object({ sourceId: S.id(), description: text(), license: label() }, ['sourceId', 'description']),
}, ['label', 'description', 'columns', 'rows', 'provenance']);

const constraint = S.object({
  id: S.id(), expression: S.text(MANIFEST_LIMITS.expression), min: S.number(), max: S.number(),
  minInclusive: S.boolean(), maxInclusive: S.boolean(), message: text(), recovery: text(),
}, ['id', 'expression', 'message', 'recovery']);

const execution = S.oneOf(
  S.object({ kind: S.constant('kernel'), kernelId: S.id(), kernelVersion: S.version(), mode: S.constant('discrete'), maxIndex: S.integer(0, MANIFEST_LIMITS.maxIndex) }),
  S.object({ kind: S.constant('kernel'), kernelId: S.id(), kernelVersion: S.version(), mode: S.constant('static') }),
  // The embedded schema 2.0 document is validated by normalizeDocument during semantic validation.
  S.object({ kind: S.constant('document'), document: { type: 'object' } }),
);

export const MODEL_MANIFEST_SCHEMA: JsonSchema = deepFreeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://explorable-models.invalid/schema/model-manifest-1.0.json',
  title: 'Explorable Models model manifest 1.0',
  ...optional(S.object({
    contract: S.constant(MODEL_CONTRACT),
    schemaVersion: S.constant(MODEL_SCHEMA_VERSION),
    modelId: S.id(),
    version: S.version(),
    title: label(),
    summary: text(),
    execution,
    capabilities: S.array(S.object({ id: S.id(), version: S.pattern(CAPABILITY_VERSION_PATTERN, 16) }), MANIFEST_LIMITS.capabilities),
    parameters: S.map(parameter, MANIFEST_LIMITS.parameters, symbolKey()),
    quantities: S.map(quantity, MANIFEST_LIMITS.quantities, symbolKey()),
    geometry: S.map(geometry, MANIFEST_LIMITS.geometry, S.pattern(GEOMETRY_ID_PATTERN, 80)),
    constraints: S.array(constraint, MANIFEST_LIMITS.constraints),
    interpretation: S.object({
      coordinateConvention: text(), angleConvention: text(), handedness: S.oneOfValues(['right', 'left']),
      assumptions: S.array(text(), MANIFEST_LIMITS.interpretationItems), limitations: S.array(text(), MANIFEST_LIMITS.interpretationItems),
    }, ['coordinateConvention', 'assumptions', 'limitations']),
    limits: S.object({
      maxIndex: S.integer(0, MANIFEST_LIMITS.maxIndex), maxGeometryElements: S.integer(1, MANIFEST_LIMITS.maxGeometryElements),
      maxOperations: S.integer(1, MANIFEST_LIMITS.maxOperations),
    }, ['maxGeometryElements', 'maxOperations']),
    sources: S.array(S.object({ id: S.id(), kind: S.oneOfValues(['derivation', 'textbook', 'specification', 'dataset']), citation: text() }), MANIFEST_LIMITS.sources),
    referenceSuite: S.nullable(S.object({ suiteId: S.id(), digest: S.digest() })),
    observations: S.map(observationDataset, MANIFEST_LIMITS.observationDatasets, dataId()),
    // Declared evaluation behaviour (report §8.1; additive in 1.0, see ModelEvaluationBehavior).
    evaluation: S.object({ determinism: S.oneOfValues(['bitwise', 'within-engine']), checkpoint: S.oneOfValues(['none']) }),
  }), 'observations', 'evaluation'),
});

/** JSON data safety (no accessors, cycles, prototypes or nonfinite numbers; bounded size) followed by the schema. */
export function manifestShapeErrors(input: unknown): Diagnostic[] {
  return validateJson(input, MODEL_MANIFEST_SCHEMA, MANIFEST_DATA_LIMITS);
}
