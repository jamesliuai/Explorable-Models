/**
 * Explicit, versioned artifact migrations (report §14, A49). A registry of steps converts a registered earlier
 * version, one version at a time, into the current activity artifact 1.0. The original is never modified: steps work
 * on a private copy, the original bytes digest is retained in `migratedFrom`, the result gets a new artifact identity
 * and a recomputed integrity manifest, and a report lists every change. Format migration is kept separate from
 * scientific equivalence: a step that changes meaning sets `semanticsChanged`, and the result may then only be
 * opened restricted or read-only. Unknown and future versions are refused with a recovery path; legacy schema 2.0
 * document artifacts and schema 1.0 exports are routed to their retained runtimes and never relabelled.
 */
import { canonicalJSON, sha256 } from '@explorable-models/core';
import type { ActivityArtifact, Diagnostic, DiagnosticCode, ExposureRecord } from './contracts.js';
import { ACTIVITY_SCHEMA_VERSION, CONTRACTS } from './contracts.js';
import { INTEGRITY_FIELDS, artifactIntegrity } from './identity.js';
import { LIMITS } from './schemas.js';
import { decodeArtifactInput, verifyArtifact, type VerifyOptions } from './artifact-read.js';
import { UNSUPPORTED_RECOVERY, classifyRecord, type RecordClass } from './versions.js';

export interface VersionId { contract: string; version: string }
export interface MigrationStepResult { value: Record<string, unknown>; report: string[]; semanticsChanged: boolean }
export interface MigrationStep {
  from: VersionId;
  to: VersionId;
  /** Checks the source record — complete shape and its own integrity — before anything is converted. */
  verify(value: Readonly<Record<string, unknown>>): Diagnostic[];
  /** Pure, deterministic conversion of a private copy. Throwing aborts the whole migration. */
  migrate(value: Record<string, unknown>): MigrationStepResult;
}
export interface MigrationRegistry {
  readonly steps: readonly MigrationStep[];
  /** Steps from `from` to the current artifact version, or null when no registered path exists. */
  chain(from: VersionId): MigrationStep[] | null;
}

export const CURRENT_ARTIFACT_VERSION: Readonly<VersionId> = Object.freeze({ contract: CONTRACTS.artifact, version: ACTIVITY_SCHEMA_VERSION });
const key = (id: VersionId): string => `${id.contract}@${id.version}`;
const digestOf = (value: unknown): string => 'sha256:' + sha256(canonicalJSON(value));
const diagnostic = (code: DiagnosticCode, path: string, message: string, recovery?: string): Diagnostic => ({ code, path, message, ...(recovery ? { recovery } : {}) });
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Validates that steps start at distinct versions and that every chain reaches the current version without a cycle. */
export function createMigrationRegistry(steps: readonly MigrationStep[]): MigrationRegistry {
  const byFrom = new Map<string, MigrationStep>();
  for (const step of steps) {
    if (byFrom.has(key(step.from))) throw new Error(`Two migrations start at ${key(step.from)}.`);
    if (key(step.from) === key(CURRENT_ARTIFACT_VERSION) || key(step.from) === key(step.to)) throw new Error(`A migration cannot start at ${key(step.from)}.`);
    byFrom.set(key(step.from), step);
  }
  const chain = (from: VersionId): MigrationStep[] | null => {
    const out: MigrationStep[] = [];
    const seen = new Set<string>();
    for (let at = key(from); at !== key(CURRENT_ARTIFACT_VERSION);) {
      const step = byFrom.get(at);
      if (!step || seen.has(at)) return null;
      seen.add(at);
      out.push(step);
      at = key(step.to);
    }
    return out.length ? out : null;
  };
  for (const step of steps) if (!chain(step.from)) throw new Error(`The migration from ${key(step.from)} does not reach ${key(CURRENT_ARTIFACT_VERSION)}.`);
  return Object.freeze({ steps: Object.freeze([...steps]), chain });
}

// ---------------------------------------------------------------------------------------------
// Draft 0.9 → 1.0
// ---------------------------------------------------------------------------------------------
/**
 * Pre-release draft `study-harness.activity-artifact` 0.9: the 1.0 shape except that exposure records were stored
 * under `reveals`, there was no `pending` field (the draft recorded only the committed checkpoint) and no
 * `migratedFrom`. Its integrity manifest uses the 1.0 algorithm over these fields, in this order.
 */
export const DRAFT_0_9_FIELDS = Object.freeze(['contract', 'schemaVersion', 'artifactId', 'kind', 'schemas', 'runtime', 'template', 'model', 'policyRef', 'instance',
  'scientific', 'presentation', 'reveals', 'journal', 'contentRefs', 'reviewRefs'] as const);
export const DRAFT_0_9: Readonly<VersionId> = Object.freeze({ contract: CONTRACTS.artifact, version: '0.9' });

/** Integrity manifest of a draft 0.9 artifact (sha256 of each present field's canonical JSON, then of the entries). */
export function draft09Integrity(value: Readonly<Record<string, unknown>>): ActivityArtifact['integrity'] {
  const entries = DRAFT_0_9_FIELDS.filter(path => value[path] !== undefined).map(path => ({ path, digest: digestOf(value[path]) }));
  return { algorithm: 'sha256', entries, digest: digestOf(entries) };
}

const CORRUPT = 'Keep the original bytes; restore from another copy of the artifact.';
function verifyDraft09(value: Readonly<Record<string, unknown>>): Diagnostic[] {
  const out: Diagnostic[] = [];
  const allowed = new Set<string>([...DRAFT_0_9_FIELDS, 'integrity']);
  if (Object.keys(value).some(field => !allowed.has(field))) out.push(diagnostic('SCHEMA', '$', 'The draft artifact has a field the 0.9 format does not define.', CORRUPT));
  const integrity = value.integrity;
  const entries = isObject(integrity) && Array.isArray(integrity.entries) ? integrity.entries.filter(isObject) : [];
  const referenced = new Set(entries.map(entry => entry.path));
  for (const field of [...DRAFT_0_9_FIELDS, 'integrity']) {
    if (Object.hasOwn(value, field)) continue;
    out.push(referenced.has(field)
      ? diagnostic('INTEGRITY_FAILURE', `$.${field}`, `The content of ${field} is missing although the integrity manifest references it.`, 'Restore the missing content from the host content store or a portable backup; the artifact cannot be migrated without it.')
      : diagnostic('SCHEMA', `$.${field}`, `The draft artifact has no ${field} field.`, CORRUPT));
  }
  if (out.length) return out;
  if (!Array.isArray(value.reveals) || !Array.isArray(value.schemas) || !value.schemas.every(entry => isObject(entry) && typeof entry.contract === 'string' && typeof entry.version === 'string')) {
    return [diagnostic('SCHEMA', '$', 'The draft artifact does not have the 0.9 shape.', CORRUPT)];
  }
  const expected = draft09Integrity(value);
  if (!isObject(integrity) || integrity.algorithm !== 'sha256' || canonicalJSON(integrity) !== canonicalJSON(expected)) {
    const recorded = new Map(entries.map(entry => [entry.path, entry.digest]));
    const altered = expected.entries.filter(entry => recorded.get(entry.path) !== entry.digest).map(entry => entry.path);
    for (const field of altered) out.push(diagnostic('INTEGRITY_FAILURE', `$.${field}`, `Field ${field} does not match its integrity digest.`, CORRUPT));
    if (!altered.length) out.push(diagnostic('INTEGRITY_FAILURE', '$.integrity', 'The integrity manifest does not match the artifact.', CORRUPT));
  }
  return out;
}

function migrateDraft09(value: Record<string, unknown>): MigrationStepResult {
  const reveals = value.reveals as ExposureRecord[];
  const schemas = (value.schemas as { contract: string; version: string }[]).map(entry => entry.contract === CONTRACTS.artifact ? { contract: entry.contract, version: ACTIVITY_SCHEMA_VERSION } : entry);
  const report = [
    `Format: the draft field "reveals" is now "exposures"; ${reveals.length} exposure record${reveals.length === 1 ? ' is' : 's are'} carried unchanged.`,
    'Format: "pending" is recorded as none. The draft format kept only the committed checkpoint and had no field for a pending preview, so a preview active when the draft was saved was not retained and cannot be recovered.',
    'Format: the schema entry for study-harness.activity-artifact changed from 0.9 to 1.0; nested records were already 1.0 and are unchanged.',
  ];
  if (reveals.length && !schemas.some(entry => entry.contract === CONTRACTS.exposure)) {
    schemas.push({ contract: CONTRACTS.exposure, version: ACTIVITY_SCHEMA_VERSION });
    report.push('Format: the schema list now names study-harness.exposure-record 1.0 for the carried exposure records.');
  }
  report.push('Semantics: the scientific snapshot, presentation, exposure history and journal checkpoint are unchanged. Equivalence with the installed model is established only at restore, by the exact model digest.');
  return {
    value: {
      contract: CONTRACTS.artifact, schemaVersion: ACTIVITY_SCHEMA_VERSION, artifactId: value.artifactId, kind: value.kind, schemas, runtime: value.runtime, template: value.template,
      model: value.model, policyRef: value.policyRef, instance: value.instance, scientific: value.scientific, presentation: value.presentation, exposures: reveals,
      journal: value.journal, pending: { kind: 'none' }, contentRefs: value.contentRefs, reviewRefs: value.reviewRefs,
    },
    report,
    semanticsChanged: false,
  };
}

export const DRAFT_0_9_TO_1_0: MigrationStep = Object.freeze({ from: DRAFT_0_9, to: CURRENT_ARTIFACT_VERSION, verify: verifyDraft09, migrate: migrateDraft09 });
/** Registered migrations of this release. */
export const MIGRATIONS: MigrationRegistry = createMigrationRegistry([DRAFT_0_9_TO_1_0]);

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------
export type LegacyRoute = 'document-session' | 'source-runtime';
export type LegacyClass = Extract<RecordClass, { kind: 'legacy-document-artifact' | 'visualization-document' | 'legacy-source-bundle' | 'legacy-experiment-snapshot' }>;
export interface OriginalIdentity { digest: string; basis: 'bytes' | 'canonical-json' }
export type MigrationOutcome =
  /** `restore` is the least restricted mode the migration permits; catalogue and policy checks may restrict further. */
  | { ok: true; artifact: ActivityArtifact; migrated: boolean; semanticsChanged: boolean; restore: 'exact' | 'restricted'; report: string[]; original: OriginalIdentity & VersionId }
  /** Legacy records keep their identity and are opened only by their retained runtime. */
  | { ok: false; kind: 'legacy'; route: LegacyRoute; legacy: LegacyClass; recovery: string; diagnostics: Diagnostic[]; original: OriginalIdentity }
  | { ok: false; kind: 'rejected'; diagnostics: Diagnostic[] };
export interface MigrateOptions extends VerifyOptions { registry?: MigrationRegistry }

const LEGACY: Record<LegacyClass['kind'], { route: LegacyRoute; recovery: string }> = {
  'legacy-document-artifact': { route: 'document-session', recovery: 'Restore it with the schema 2.0 document session (DeclarativeSession.restoreDocument) at the exact runtime version recorded in it; otherwise keep the original bytes unchanged (archivalView reads activity artifacts only). It is never converted into an activity artifact.' },
  'visualization-document': { route: 'document-session', recovery: 'Open it as a schema 2.0 visualization document in a document session; it carries no activity state and is not converted into an activity artifact.' },
  'legacy-experiment-snapshot': { route: 'source-runtime', recovery: 'Restore it with the schema 1.0 runtime recorded in it, against its exact definition revision; otherwise keep the original bytes unchanged (archivalView reads activity artifacts only). It is never converted into an activity artifact.' },
  'legacy-source-bundle': { route: 'source-runtime', recovery: 'Play it with the schema 1.0 exported bundle runtime as exported; it is not an activity artifact.' },
};

/** Deterministic identity of a migrated artifact, derived from the original digest (re-migrating yields the same ID). */
export const migratedArtifactId = (originalDigest: string): string => `migrated-${originalDigest.slice('sha256:'.length, 'sha256:'.length + 24)}`;

const rejected = (diagnostics: Diagnostic[]): MigrationOutcome => ({ ok: false, kind: 'rejected', diagnostics });
const failure = (message: string): Diagnostic => diagnostic('UNSUPPORTED_ARTIFACT', '$', message, `${UNSUPPORTED_RECOVERY} The original artifact is unchanged.`);

/**
 * Reads bytes, text or a parsed value and returns a current 1.0 artifact: a verified 1.0 artifact as is (`migrated:
 * false`), a registered earlier version migrated step by step and verified again, a legacy record routed to its
 * retained runtime, or a rejection (corrupt, truncated, missing content, unknown or future version, failed step).
 */
export function migrateArtifact(raw: unknown, options: MigrateOptions = {}): MigrationOutcome {
  const registry = options.registry ?? MIGRATIONS;
  const decoded = decodeArtifactInput(raw);
  if (!decoded.ok) return rejected(decoded.diagnostics);
  const { value, original } = decoded.decoded;
  const classification = classifyRecord(value);
  if (classification.kind !== 'study-harness' && classification.kind !== 'unsupported') {
    const { route, recovery } = LEGACY[classification.kind];
    return {
      ok: false, kind: 'legacy', route, legacy: classification, recovery, original,
      diagnostics: [diagnostic('UNSUPPORTED_ARTIFACT', '$', `The record is a ${classification.kind}; it is not an activity artifact and is not converted.`, recovery)],
    };
  }
  if (classification.kind === 'study-harness') {
    if (classification.contract !== CONTRACTS.artifact) return rejected([diagnostic('UNSUPPORTED_ARTIFACT', '$', 'The record is a different contract than an activity artifact.', UNSUPPORTED_RECOVERY)]);
    const verified = verifyArtifact(value, options);
    if (!verified.ok) return rejected(verified.diagnostics);
    return { ok: true, artifact: verified.artifact, migrated: false, semanticsChanged: false, restore: 'exact', report: [], original: { ...original, ...CURRENT_ARTIFACT_VERSION } };
  }
  const declared = isObject(value) && typeof value.contract === 'string' && typeof value.schemaVersion === 'string' ? { contract: value.contract, version: value.schemaVersion } : null;
  const chain = declared ? registry.chain(declared) : null;
  if (!declared || !chain) return rejected([classification.diagnostic]);

  let working = structuredClone(value) as Record<string, unknown>;
  const report: string[] = [];
  let semanticsChanged = false;
  for (const step of chain) {
    const span = `${step.from.version} to ${step.to.version}`;
    const problems = step.verify(working);
    if (problems.length) return rejected([failure(`The artifact cannot be migrated from ${span}: the source record failed verification.`), ...problems]);
    let result: MigrationStepResult;
    try { result = step.migrate(structuredClone(working)); } catch {
      return rejected([failure(`The migration from ${span} failed.`)]);
    }
    if (!isObject(result.value) || !Array.isArray(result.report)) return rejected([failure(`The migration from ${span} returned no artifact.`)]);
    report.push(...result.report);
    semanticsChanged ||= result.semanticsChanged;
    working = result.value;
  }
  const fields = new Set<string>(INTEGRITY_FIELDS);
  if (Object.keys(working).some(field => !fields.has(field) || field === 'migratedFrom')) return rejected([failure('The migration produced fields the current format does not define.')]);
  const notes = [...report, `Identity: the migrated artifact has a new artifactId; the digest of the original ${original.basis === 'bytes' ? 'bytes' : 'canonical JSON'} is retained in migratedFrom.`]
    .map(note => [...note].slice(0, LIMITS.text).join(''));
  if (notes.length > LIMITS.migrationNotes) notes.splice(LIMITS.migrationNotes - 1, Infinity, `${notes.length - LIMITS.migrationNotes + 1} further migration notes are not listed.`);
  const body = {
    ...Object.fromEntries(INTEGRITY_FIELDS.filter(field => working[field] !== undefined).map(field => [field, working[field]])),
    artifactId: migratedArtifactId(original.digest),
    migratedFrom: { contract: declared.contract, version: declared.version, digest: original.digest, report: notes },
  } as Omit<ActivityArtifact, 'integrity'>;
  const ordered = Object.fromEntries(INTEGRITY_FIELDS.filter(field => body[field] !== undefined).map(field => [field, body[field]])) as Omit<ActivityArtifact, 'integrity'>;
  const verified = verifyArtifact({ ...ordered, integrity: artifactIntegrity(ordered) }, options);
  if (!verified.ok) return rejected([failure('The migrated artifact did not validate.'), ...verified.diagnostics]);
  return { ok: true, artifact: verified.artifact, migrated: true, semanticsChanged, restore: semanticsChanged ? 'restricted' : 'exact', report: notes, original: { ...original, ...declared } };
}
