/** Artifact decoding, verification and restore claims; reached on demand by the adapter restore operation. */
import { canonicalJSON, sha256 } from '@experiment-kit/core';
import { jsonDataErrors } from '@experiment-kit/core/model';
import type { ActivityArtifact, Diagnostic, ExposureRecord } from './contracts.js';
import { CONTRACTS } from './contracts.js';
import { diagnostic, snapshotProblems } from './artifact-validation.js';
import { ARTIFACT_DATA_LIMITS } from './schemas.js';
import { validateArtifactSemantics } from './semantic.js';
import { validateRecord } from './validator.js';
import { UNSUPPORTED_RECOVERY, classifyRecord } from './versions.js';

// ---------------------------------------------------------------------------------------------
// Input decoding and verification
// ---------------------------------------------------------------------------------------------
/** Raw text may be indented; this factor bounds it before parsing, then the counted data limit applies. */
export const RAW_TEXT_FACTOR = 2;
const CORRUPT = 'Keep the original bytes and restore from another copy of the artifact or backup.';

export interface DecodedInput { value: unknown; original: { digest: string; basis: 'bytes' | 'canonical-json' } }
/**
 * Accepts the original bytes (`Uint8Array`), their UTF-8 text, or an already parsed value. The original digest is
 * sha256 over the exact bytes when they are available and over canonical JSON otherwise. Size is bounded before
 * parsing; unparsable (truncated or corrupted) JSON is an `INTEGRITY_FAILURE`.
 */
export function decodeArtifactInput(raw: unknown): { ok: true; decoded: DecodedInput } | { ok: false; diagnostics: Diagnostic[] } {
  if (typeof raw !== 'string' && !(raw instanceof Uint8Array)) {
    const data = jsonDataErrors(raw, ARTIFACT_DATA_LIMITS);
    if (data.length) return { ok: false, diagnostics: data.slice(0, 8).map(item => diagnostic(item.code === 'RESOURCE_LIMIT' ? 'RESOURCE_LIMIT' : 'SCHEMA', item.path, item.message)) };
    return { ok: true, decoded: { value: raw, original: { digest: 'sha256:' + sha256(canonicalJSON(raw)), basis: 'canonical-json' } } };
  }
  const length = typeof raw === 'string' ? raw.length : raw.byteLength;
  if (length > ARTIFACT_DATA_LIMITS.maxBytes * RAW_TEXT_FACTOR) return { ok: false, diagnostics: [diagnostic('RESOURCE_LIMIT', '$', `The artifact exceeds ${ARTIFACT_DATA_LIMITS.maxBytes * RAW_TEXT_FACTOR} bytes.`, 'Artifacts larger than the documented limit cannot be restored.')] };
  let text: string;
  try { text = typeof raw === 'string' ? raw : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw); } catch {
    return { ok: false, diagnostics: [diagnostic('INTEGRITY_FAILURE', '$', 'The artifact bytes are not valid UTF-8.', CORRUPT)] };
  }
  let value: unknown;
  // A leading byte-order mark is tolerated for parsing; the original digest still covers the exact bytes.
  try { value = JSON.parse(text.startsWith('\uFEFF') ? text.slice(1) : text); } catch {
    return { ok: false, diagnostics: [diagnostic('INTEGRITY_FAILURE', '$', 'The artifact is not complete JSON: it is truncated or corrupted.', CORRUPT)] };
  }
  const data = jsonDataErrors(value, ARTIFACT_DATA_LIMITS);
  if (data.length) return { ok: false, diagnostics: data.slice(0, 8).map(item => diagnostic(item.code === 'RESOURCE_LIMIT' ? 'RESOURCE_LIMIT' : 'SCHEMA', item.path, item.message)) };
  return { ok: true, decoded: { value, original: { digest: 'sha256:' + sha256(text), basis: 'bytes' } } };
}

const REQUIRED_FIELDS = ['contract', 'schemaVersion', 'artifactId', 'kind', 'schemas', 'runtime', 'template', 'model', 'policyRef', 'instance', 'scientific', 'presentation',
  'exposures', 'journal', 'pending', 'contentRefs', 'reviewRefs', 'integrity'] as const;

/** Top-level fields that are absent; a field the integrity manifest references is reported as missing content. */
function missingFields(value: Record<string, unknown>): Diagnostic[] {
  const integrity = value.integrity as { entries?: unknown } | undefined;
  const referenced = new Set(Array.isArray(integrity?.entries) ? integrity.entries.map(entry => (entry as { path?: unknown })?.path).filter((path): path is string => typeof path === 'string') : []);
  return REQUIRED_FIELDS.filter(field => !Object.hasOwn(value, field)).map(field => referenced.has(field)
    ? diagnostic('INTEGRITY_FAILURE', `$.${field}`, `The content of ${field} is missing although the integrity manifest references it.`, 'Restore the missing content from the host content store or a portable backup; the artifact cannot be restored without it.')
    : diagnostic('SCHEMA', `$.${field}`, `The artifact has no ${field} field.`, CORRUPT));
}

export interface VerifyOptions {
  /** Reports whether referenced template content is available offline; unavailable references are `NOT_FOUND`. */
  content?(ref: string): boolean;
}
/**
 * Verifies an activity artifact 1.0 from bytes, text or a parsed value: size before traversal, declared identity
 * (legacy and other versions are refused, never relabelled), missing content, schema, semantic cross-references and
 * the integrity manifest recomputed field by field. Returns a detached copy.
 */
export function verifyArtifact(raw: unknown, options: VerifyOptions = {}): { ok: true; artifact: ActivityArtifact } | { ok: false; diagnostics: Diagnostic[] } {
  const decoded = decodeArtifactInput(raw);
  if (!decoded.ok) return decoded;
  const { value } = decoded.decoded;
  const classification = classifyRecord(value);
  if (classification.kind === 'unsupported') {
    const declared = value as { contract?: unknown; schemaVersion?: unknown };
    const draft = declared?.contract === CONTRACTS.artifact && typeof declared.schemaVersion === 'string';
    return { ok: false, diagnostics: [draft ? { ...classification.diagnostic, recovery: `${UNSUPPORTED_RECOVERY} A registered draft version can be converted with migrateArtifact.` } : classification.diagnostic] };
  }
  if (classification.kind !== 'study-harness' || classification.contract !== CONTRACTS.artifact) {
    const message = classification.kind === 'study-harness' ? 'The record is a different contract than an activity artifact.' : `The record is a ${classification.kind} and needs its own reader.`;
    return { ok: false, diagnostics: [diagnostic('UNSUPPORTED_ARTIFACT', '$', message, UNSUPPORTED_RECOVERY)] };
  }
  const record = value as Record<string, unknown>;
  const missing = missingFields(record);
  if (missing.length) return { ok: false, diagnostics: missing };
  const checked = validateRecord(CONTRACTS.artifact, record);
  if (!checked.ok) return { ok: false, diagnostics: checked.diagnostics };
  const artifact = record as unknown as ActivityArtifact;
  const problems = [...validateArtifactSemantics(artifact), ...snapshotProblems(artifact)];
  if (options.content) artifact.contentRefs.forEach((ref, index) => { if (!options.content!(ref)) problems.push(diagnostic('NOT_FOUND', `$.contentRefs[${index}]`, 'Referenced content is not available offline.', 'Install the catalogue content this artifact references, or open it read-only.')); });
  return problems.length ? { ok: false, diagnostics: problems } : { ok: true, artifact: structuredClone(artifact) };
}

// ---------------------------------------------------------------------------------------------
// Restore claims
// ---------------------------------------------------------------------------------------------
export type ClaimSource = 'host-policy' | 'host-activity' | 'host-journal' | 'host-exposures' | 'catalog' | 'review-registry';
export interface UntrustedClaim { path: string; saved: unknown; rederiveFrom: ClaimSource; reason: string }

/**
 * Saved values a restore must not trust (report §14). Each is re-derived from the named authority: current host policy
 * (context, mode, tools, visibility), the host activity record (stage and activity revision), the host journal, host
 * exposure records, the installed catalogue (exact template/model and revocation) or the host review registry. Only
 * claims present in the artifact are listed, in a fixed order.
 */
const STAGE_REASON = 'Stage and activity revision are host-authorized through receipts; a restore adopts the host\'s current stage and revision (ActivityRecords.activity). Without them only the host\'s latest checkpoint (the journal cursor\'s checkpointDigest) confirms the saved values, restricted; any other artifact is refused with the archival recovery.';
export function restoreClaims(artifact: ActivityArtifact): UntrustedClaim[] {
  const { instance } = artifact;
  const claims: UntrustedClaim[] = [
    { path: '$.instance.context', saved: instance.context, rederiveFrom: 'host-policy', reason: 'Independent or instructional context comes from the current policy, never from the artifact; whether saved grants count and whether instructional content waits for a reopening come from the host\'s context lineage (ActivityRecords.activity.lineage).' },
    { path: '$.instance.mode', saved: instance.mode, rederiveFrom: 'host-policy', reason: 'Approved mode requires the current policy approval list and a non-revoked catalogue entry.' },
    { path: '$.instance.allowedActions', saved: instance.allowedActions, rederiveFrom: 'host-policy', reason: 'Permitted operations come from the current policy.' },
    { path: '$.policyRef', saved: artifact.policyRef, rederiveFrom: 'host-policy', reason: 'The current policy may be more restrictive than the saved revision.' },
    { path: '$.presentation.views', saved: Object.fromEntries(Object.entries(artifact.presentation.views).map(([viewId, view]) => [viewId, view.layers])), rederiveFrom: 'host-policy', reason: 'Visible views, layers and controls are recomputed from the current projection; a saved layer cannot re-enable a forbidden group.' },
    { path: '$.instance.stage', saved: instance.stage, rederiveFrom: 'host-activity', reason: STAGE_REASON },
    { path: '$.instance.activityRevision', saved: instance.activityRevision, rederiveFrom: 'host-activity', reason: STAGE_REASON },
    { path: '$.instance.closed', saved: instance.closed, rederiveFrom: 'host-activity', reason: 'Closure is the host\'s: a restore adopts the host\'s closed state (ActivityRecords.activity), so an activity the host closed is restored read-only whatever the artifact claims.' },
    { path: '$.instance.persistence', saved: instance.persistence, rederiveFrom: 'host-journal', reason: 'Persistence state is re-established by reconciling with the host journal.' },
    { path: '$.journal', saved: { cursor: artifact.journal.cursor, pendingEventIds: artifact.journal.pendingEventIds }, rederiveFrom: 'host-journal', reason: 'The checkpoint is reconciled with the host cursor; carried pending events are resent (the host deduplicates by eventId) or reported lost, never duplicated.' },
    { path: '$.template', saved: artifact.template, rederiveFrom: 'catalog', reason: 'The exact template digest must be installed and not revoked; no substitution.' },
    { path: '$.model', saved: artifact.model, rederiveFrom: 'catalog', reason: 'The exact model digest must be installed and not revoked; no substitution.' },
  ];
  if (artifact.exposures.length) claims.push({ path: '$.exposures', saved: artifact.exposures.map(exposure => ({ exposureId: exposure.exposureId, displayStatus: exposure.displayStatus })), rederiveFrom: 'host-exposures', reason: 'Exposure history comes from host records and is restored conservatively: authorized without an acknowledgement is uncertain. A saved grant counts for visibility only when the host holds the same grant (exposure ID, receipt ID and content) and the host\'s context lineage counts it; without the host records no saved grant counts.' });
  if (artifact.assistance?.length) claims.push({ path: '$.assistance', saved: artifact.assistance.map(item => ({ receiptId: item.receiptId, kind: item.kind, sequence: item.sequence })), rederiveFrom: 'host-journal', reason: 'Assistance receipts are host records; the references are carried for frozen snapshots and are confirmed against the host journal, never re-issued.' });
  if (artifact.lineage) claims.push({ path: '$.lineage', saved: artifact.lineage, rederiveFrom: 'host-activity', reason: 'Lineage marks only ever restrict: ended grants never count again and a required reopening goes through host assistance. Their absence is not trusted: a saved grant counts only when the host\'s context lineage counts it (ActivityRecords.activity.lineage, or the host\'s latest checkpoint), and the host\'s lineage can require a reopening the artifact does not claim.' });
  if (artifact.reviewRefs.length) claims.push({ path: '$.reviewRefs', saved: artifact.reviewRefs, rederiveFrom: 'review-registry', reason: 'Review approval is resolved only from the host review registry; saved references are provenance.' });
  if (artifact.kind === 'learner-snapshot') claims.push({ path: '$.kind', saved: artifact.kind, rederiveFrom: 'host-policy', reason: 'A learner snapshot never implies that all information was visible; visibility comes from the current policy.' });
  if (artifact.migratedFrom) claims.push({ path: '$.migratedFrom', saved: { contract: artifact.migratedFrom.contract, version: artifact.migratedFrom.version }, rederiveFrom: 'catalog', reason: 'A migrated artifact is format-converted; scientific equivalence is established only by the exact installed model digest.' });
  return structuredClone(claims);
}

/**
 * Conservative exposure restore (activity-runtime §4.6): an authorized exposure without a persisted display
 * acknowledgement becomes `uncertain` (potentially exposed). Displayed exposures never revert.
 */
export function conservativeExposures(exposures: readonly ExposureRecord[]): ExposureRecord[] {
  return exposures.map(exposure => exposure.displayStatus !== 'authorized' ? structuredClone(exposure) : {
    ...structuredClone(exposure), displayStatus: 'uncertain',
    uncertainty: { code: 'INTERRUPTED_BEFORE_ACK', reason: 'Restored without a persisted display acknowledgement; treated as potentially exposed.' },
  });
}
