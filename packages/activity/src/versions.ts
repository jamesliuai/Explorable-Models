/**
 * Contract version registry and readers (report §14, A04). Every record is classified by its own declared identity
 * before validation. Legacy formats keep their own readers and are never relabelled; unknown or future versions are
 * rejected with `UNSUPPORTED_ARTIFACT` and a recovery route that keeps the original bytes.
 */
import { canonicalJSON, sha256 } from '@experiment-kit/core';
import type { JsonSchema } from '@experiment-kit/core/model';
import type { Diagnostic } from './contracts.js';
import { MESSAGES, SCHEMAS, SCHEMA_NAMES, SCHEMA_VERSIONS, type SchemaName } from './schemas.js';
import { validateRecord, type SchemaTypes } from './validator.js';

/** Supported versions per contract. A new version is added here with its own frozen schema; old ones stay readable. */
export const CONTRACT_VERSIONS: Readonly<Record<SchemaName, readonly string[]>> = Object.freeze(
  Object.fromEntries(SCHEMA_NAMES.map(name => [name, Object.freeze([SCHEMA_VERSIONS[name]])])) as Record<SchemaName, readonly string[]>);

/** Legacy formats that remain readable through their own runtimes (docs/architecture.md, agent-first-contract.md). */
export const LEGACY_FORMATS = Object.freeze({
  documentArtifact: { format: 'experiment-kit-document', version: '2.0' },
  document: { schemaVersion: '2.0' },
  sourceBundle: { schemaVersion: '1.0' },
  experimentSnapshot: { schemaVersion: '1.0' },
});

/** Compatibility matrix (report §14): every recognised format, the versions read, its reader and restore route. */
export const COMPATIBILITY = Object.freeze([
  { kind: 'study-harness', format: 'study-harness.* records and experiment-kit.model-manifest', versions: ['1.0'], reader: '@experiment-kit/activity readRecord + validate*Semantics', route: 'Restore revalidates catalogue status, current host policy and the exact model digest; no substitution.' },
  { kind: 'legacy-document-artifact', format: 'experiment-kit-document', versions: ['2.0'], reader: 'core DeclarativeSession.restoreDocument', route: 'Exact recorded runtimeVersion only; otherwise keep the original bytes (it is not an activity artifact, so archivalView does not read it). Never converted into an activity artifact implicitly.' },
  { kind: 'visualization-document', format: 'schema 2.0 VisualizationDocument', versions: ['2.0'], reader: 'core normalizeDocument', route: 'Usable as a model execution kind (document); it is not an activity record.' },
  { kind: 'legacy-source-bundle', format: 'bundle-manifest.json / source-manifest.json', versions: ['1.0'], reader: 'schema 1.0 exported playback bundle', route: 'Independently playable as exported; not an activity artifact.' },
  { kind: 'legacy-experiment-snapshot', format: 'schema 1.0 experiment snapshot', versions: ['1.0'], reader: 'core validateSnapshot', route: 'Restored only against its exact definition revision by the 1.0 runtime.' },
] as const);

export type RecordClass =
  | { kind: 'study-harness'; contract: SchemaName; version: string }
  /** Schema 2.0 document session export (`DocumentArtifact`): restore only with the exact recorded runtime. */
  | { kind: 'legacy-document-artifact'; version: '2.0'; runtimeVersion: string }
  /** Schema 2.0 visualization document: a supported `document` execution kind, not an activity record. */
  | { kind: 'visualization-document'; schemaVersion: '2.0' }
  /** Schema 1.0 exported bundle manifest (`bundle-manifest.json`) or source inventory (`source-manifest.json`). */
  | { kind: 'legacy-source-bundle'; schemaVersion: '1.0' }
  /** Schema 1.0 experiment snapshot, restored only against its definition revision by the 1.0 runtime. */
  | { kind: 'legacy-experiment-snapshot'; schemaVersion: '1.0'; runtimeVersion: string }
  | { kind: 'unsupported'; reason: string; diagnostic: Diagnostic };

export const UNSUPPORTED_RECOVERY = 'Keep the original bytes unchanged. Open the record with the runtime that produced it; an activity artifact this release verifies can be shown as an archival read-only view with archivalView(artifact, { audience }). Do not convert it without an explicit, versioned migration.';

const unsupported = (reason: string, path = '$'): RecordClass =>
  ({ kind: 'unsupported', reason, diagnostic: { code: 'UNSUPPORTED_ARTIFACT', path, message: reason, recovery: UNSUPPORTED_RECOVERY } });
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const has = (value: Record<string, unknown>, ...keys: string[]): boolean => keys.every(key => Object.hasOwn(value, key));
const KNOWN: ReadonlySet<string> = new Set(SCHEMA_NAMES);
/** Host-port messages are transient and carry no `contract` field; they are validated directly. */
const MESSAGE_NAMES: ReadonlySet<string> = new Set(Object.values(MESSAGES));

/**
 * Classifies a parsed JSON value by its declared identity only (no schema validation). Messages never echo input
 * values: an unknown contract or version is reported without repeating it.
 */
export function classifyRecord(value: unknown): RecordClass {
  if (!isObject(value)) return unsupported('The record is not a JSON object.');
  if (Object.hasOwn(value, 'contract')) {
    const { contract, schemaVersion } = value;
    if (typeof contract !== 'string' || !KNOWN.has(contract)) return unsupported('The record declares an unknown contract.', '$.contract');
    const name = contract as SchemaName;
    if (typeof schemaVersion !== 'string') return unsupported('The record does not declare a schema version.', '$.schemaVersion');
    if (!CONTRACT_VERSIONS[name].includes(schemaVersion)) return unsupported('The record declares a schema version this release cannot read.', '$.schemaVersion');
    return { kind: 'study-harness', contract: name, version: schemaVersion };
  }
  if (value.format === LEGACY_FORMATS.documentArtifact.format) {
    if (value.version !== LEGACY_FORMATS.documentArtifact.version) return unsupported('The document artifact declares a version this release cannot read.', '$.version');
    if (typeof value.runtimeVersion !== 'string') return unsupported('The document artifact does not declare its runtime version.', '$.runtimeVersion');
    return { kind: 'legacy-document-artifact', version: '2.0', runtimeVersion: value.runtimeVersion };
  }
  if (value.schemaVersion === LEGACY_FORMATS.document.schemaVersion && has(value, 'id', 'parameters', 'quantities', 'views'))
    return { kind: 'visualization-document', schemaVersion: '2.0' };
  if (value.schemaVersion === LEGACY_FORMATS.sourceBundle.schemaVersion) {
    if (has(value, 'experimentId', 'definitionRevision', 'assets') || has(value, 'experiments')) return { kind: 'legacy-source-bundle', schemaVersion: '1.0' };
    if (has(value, 'experimentId', 'definitionRevision', 'runId') && typeof value.runtimeVersion === 'string')
      return { kind: 'legacy-experiment-snapshot', schemaVersion: '1.0', runtimeVersion: value.runtimeVersion };
  }
  return unsupported('The record format is not recognized.');
}

export type ReadResult<N extends SchemaName> =
  | { ok: true; contract: N; version: string; value: SchemaTypes[N] }
  | { ok: false; classification: RecordClass; diagnostics: Diagnostic[] };

/**
 * Reads a record expected to be `contract`: classifies it, refuses other formats (legacy formats are reported with
 * their own classification, never relabelled), then validates it against the schema of its declared version.
 * Host-port messages (which carry no `contract` field) are validated against the current message schema.
 */
export function readRecord<N extends SchemaName>(contract: N, value: unknown): ReadResult<N> {
  const classification: RecordClass = MESSAGE_NAMES.has(contract) && isObject(value) && !Object.hasOwn(value, 'contract')
    ? { kind: 'study-harness', contract, version: SCHEMA_VERSIONS[contract] } : classifyRecord(value);
  if (classification.kind === 'unsupported') return { ok: false, classification, diagnostics: [classification.diagnostic] };
  if (classification.kind !== 'study-harness' || classification.contract !== contract) {
    const message = classification.kind === 'study-harness' ? 'The record is a different contract than expected.' : `The record is a ${classification.kind} and needs its own reader.`;
    return { ok: false, classification, diagnostics: [{ code: 'UNSUPPORTED_ARTIFACT', path: '$', message, recovery: UNSUPPORTED_RECOVERY }] };
  }
  const result = validateRecord(contract, value);
  return result.ok ? { ok: true, contract, version: classification.version, value: value as SchemaTypes[N] } : { ok: false, classification, diagnostics: result.diagnostics };
}

/** Identity of a schema document: sha256 of its canonical JSON. Frozen per version in `schema/frozen-1.0.json`. */
export function schemaDigest(schema: JsonSchema | object): string { return 'sha256:' + sha256(canonicalJSON(schema)); }

/** Digests of every current schema, keyed by name. */
export function schemaDigests(): Record<SchemaName, string> {
  return Object.fromEntries(SCHEMA_NAMES.map(name => [name, schemaDigest(SCHEMAS[name])])) as Record<SchemaName, string>;
}
