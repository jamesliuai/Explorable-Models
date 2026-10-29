/**
 * TEST-ONLY portable host backup over the MemoryHost durable tables (report §14, A48). It models what a Study Harness
 * host backup must carry to restore into an EMPTY host store on another machine, offline: the activity's journal
 * records through the checkpoint, the host exposure, receipt, idempotency and display-acknowledgement records those
 * records reference, the host activity record and policy, every stored artifact of the activity, and all referenced
 * immutable content (the exact template and model manifest, content-addressed by digest), listed in a manifest with a
 * sha256 per file. Nothing refers to a path or ID that only exists on the original machine. The format is a fixture
 * of this repository, not a Study Harness format; import is the host's transaction, not a HostPort call.
 */
import { canonicalJSON, sha256 } from '../../../packages/core/src/identity.js';
import { modelIdentity, validateManifest, type ModelManifest } from '../../../packages/core/src/model/index.js';
import {
  CONTRACTS, type ActivityArtifact, type ActivityCatalog, type ActivityTemplate, type CatalogEntryStatus, type ExposureRecord, type HostPolicy,
  type InteractionEvent, type ModelRef, type TemplateRef,
} from '../../../packages/activity/src/contracts.js';
import { artifactDigest, templateRef } from '../../../packages/activity/src/identity.js';
import { verifyArtifact } from '../../../packages/activity/src/artifacts.js';
import { validateRecord } from '../../../packages/activity/src/validator.js';
import type { MemoryHostSnapshot } from './memory-host.js';

export const PORTABLE_BACKUP_FORMAT = 'experiment-kit.fixture.portable-host-backup';
export const PORTABLE_BACKUP_VERSION = '1.0';
type Table = MemoryHostSnapshot['activities'][string];
type Receipt = Table['receipts'][number];

export interface PortableBackupManifest {
  format: typeof PORTABLE_BACKUP_FORMAT;
  formatVersion: typeof PORTABLE_BACKUP_VERSION;
  activityId: string;
  /** The coherent restore point: the backup artifact and the journal cursor it was saved at. */
  checkpoint: { artifactId: string; artifactDigest: string; lastSequence: number; lastEventId: string | null };
  journal: { path: string; count: number };
  records: { policy: string; activity: string; exposures: string; receipts: string; idempotency: string; displayAcks: string };
  artifacts: { artifactId: string; kind: ActivityArtifact['kind']; digest: string; path: string }[];
  content: ({ kind: 'template'; ref: TemplateRef; path: string } | { kind: 'model'; ref: ModelRef; path: string })[];
  files: { path: string; sha256: string; bytes: number }[];
  /** Verified offline recovery strategy: every referenced immutable record is inside the bundle. */
  recovery: string;
}
export interface PortableBackup { manifest: PortableBackupManifest; files: Record<string, string> }

/** Thrown by import; `code` names the failure class (the bundle is never partially imported). */
export class PortableBackupError extends Error {
  constructor(readonly code: 'MISSING_FILE' | 'INTEGRITY_FAILURE' | 'UNSUPPORTED_FORMAT' | 'INVALID_RECORD' | 'CONFLICT', message: string, readonly path = '$') { super(message); this.name = 'PortableBackupError'; }
}

const text = (value: unknown): string => canonicalJSON(value);
const hex = (digest: string): string => digest.replace(/^sha256:/, '');
const clone = <T>(value: T): T => structuredClone(value);
const digestOf = (value: unknown): string => 'sha256:' + sha256(canonicalJSON(value));

/** IDs referenced by journal payloads (receipts and exposures), collected without knowing each event type. */
function referencedIds(events: readonly InteractionEvent[]): { receipts: Set<string>; exposures: Set<string> } {
  const receipts = new Set<string>(), exposures = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (!value || typeof value !== 'object' || depth > 6) return;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'receiptId' && typeof item === 'string') receipts.add(item);
      else if (key === 'exposureId' && typeof item === 'string') exposures.add(item);
      else visit(item, depth + 1);
    }
  };
  for (const event of events) visit(event.payload, 0);
  return { receipts, exposures };
}

/**
 * Builds the bundle from the host's durable tables at backup time. `checkpointArtifactId` names the backup artifact
 * whose journal cursor defines the restore point; `content` supplies the exact immutable template and model.
 */
export function exportPortableBackup(store: MemoryHostSnapshot, input: { activityId: string; checkpointArtifactId: string; template: ActivityTemplate; model: ModelManifest }): PortableBackup {
  const table = store.activities[input.activityId];
  if (!table) throw new PortableBackupError('INVALID_RECORD', 'The activity is not in the host store.');
  const stored = store.artifacts[input.checkpointArtifactId];
  if (!stored || stored.artifact.kind !== 'backup' || stored.artifact.instance.activityId !== input.activityId) throw new PortableBackupError('INVALID_RECORD', 'The checkpoint must be a backup artifact of this activity.');
  const checkpoint = stored.artifact;
  if (checkpoint.journal.pendingEventIds.length) throw new PortableBackupError('INVALID_RECORD', 'The checkpoint has unacknowledged events; back up after the journal is acknowledged.');
  const through = checkpoint.journal.cursor.lastSequence;
  const events = table.events.filter(event => event.sequence <= through);
  const ids = referencedIds(events);
  for (const exposure of checkpoint.exposures) ids.exposures.add(exposure.exposureId);
  const exposures = table.exposures.filter(record => ids.exposures.has(record.exposureId));
  for (const exposure of exposures) ids.receipts.add(exposure.receiptId);
  const receipts = table.receipts.filter(receipt => ids.receipts.has(receipt.receiptId));
  const idempotency = Object.fromEntries(Object.entries(table.idempotency).filter(([, entry]) => ids.receipts.has(entry.receiptId)));
  const displayAcks = Object.fromEntries(Object.entries(table.displayAcks).filter(([exposureId]) => ids.exposures.has(exposureId)));
  const artifacts = Object.values(store.artifacts).filter(entry => entry.artifact.instance.activityId === input.activityId);
  const tRef = templateRef(input.template), mRef: ModelRef = { modelId: input.model.modelId, version: input.model.version, digest: modelIdentity(input.model).digest };
  if (canonicalJSON(tRef) !== canonicalJSON(checkpoint.template) || canonicalJSON(mRef) !== canonicalJSON(checkpoint.model)) throw new PortableBackupError('INVALID_RECORD', 'The supplied content is not the content the checkpoint references.');

  const files: Record<string, string> = {};
  const base = `activities/${input.activityId}`;
  const records = {
    policy: 'policy.json', activity: `${base}/activity.json`, exposures: `${base}/exposures.json`, receipts: `${base}/receipts.json`,
    idempotency: `${base}/idempotency.json`, displayAcks: `${base}/display-acks.json`,
  };
  files[records.policy] = text(store.policy);
  files[records.activity] = text({
    instance: table.instance, activityRevision: table.activityRevision, stage: table.stage, registrations: table.registrations, checkpointDigest: table.checkpointDigest,
    // Host ID space and clock high-water marks, so an importing host never reissues an imported ID or goes back in time.
    idHighWater: store.counter, clockMs: store.clockMs,
  });
  files[records.exposures] = text(exposures);
  files[records.receipts] = text(receipts);
  files[records.idempotency] = text(idempotency);
  files[records.displayAcks] = text(displayAcks);
  const journalPath = `${base}/journal.json`;
  files[journalPath] = text(events);
  const artifactEntries = artifacts.map(entry => {
    const path = `artifacts/${entry.artifact.artifactId}.json`;
    files[path] = text(entry.artifact);
    return { artifactId: entry.artifact.artifactId, kind: entry.artifact.kind, digest: entry.digest, path };
  });
  const templatePath = `content/template-${hex(tRef.digest)}.json`, modelPath = `content/model-${hex(mRef.digest)}.json`;
  files[templatePath] = text(input.template);
  files[modelPath] = text(input.model);
  const manifest: PortableBackupManifest = {
    format: PORTABLE_BACKUP_FORMAT, formatVersion: PORTABLE_BACKUP_VERSION, activityId: input.activityId,
    checkpoint: { artifactId: checkpoint.artifactId, artifactDigest: artifactDigest(checkpoint), lastSequence: through, lastEventId: checkpoint.journal.cursor.lastEventId },
    journal: { path: journalPath, count: events.length }, records, artifacts: artifactEntries,
    content: [{ kind: 'template', ref: tRef, path: templatePath }, { kind: 'model', ref: mRef, path: modelPath }],
    files: Object.entries(files).map(([path, body]) => ({ path, sha256: 'sha256:' + sha256(body), bytes: new TextEncoder().encode(body).byteLength })),
    recovery: 'Offline: the bundle holds the journal through the checkpoint, the host records it references, every artifact of the activity and the exact template and model content. No original path, network resource or host-local ID is needed.',
  };
  return { manifest, files };
}

export interface ImportReport {
  imported: { events: number; exposures: number; receipts: number; artifacts: number };
  duplicates: { events: number; exposures: number; receipts: number; artifacts: number };
}
export interface VerifiedContent { template: ActivityTemplate; model: ModelManifest; templateRef: TemplateRef; modelRef: ModelRef }

/** Reads and verifies every manifest file (presence, sha256, record schema, content digests) before anything is imported. */
export function readPortableBackup(read: (path: string) => string | null): { manifest: PortableBackupManifest; parsed: Record<string, unknown>; content: VerifiedContent; checkpoint: ActivityArtifact } {
  const manifestText = read('manifest.json');
  if (manifestText === null) throw new PortableBackupError('MISSING_FILE', 'The bundle has no manifest.', 'manifest.json');
  let manifest: PortableBackupManifest;
  try { manifest = JSON.parse(manifestText) as PortableBackupManifest; } catch { throw new PortableBackupError('INTEGRITY_FAILURE', 'The manifest is not complete JSON.', 'manifest.json'); }
  if (manifest?.format !== PORTABLE_BACKUP_FORMAT || manifest.formatVersion !== PORTABLE_BACKUP_VERSION) throw new PortableBackupError('UNSUPPORTED_FORMAT', 'Unknown backup format or version; the bundle is kept unchanged.');
  const parsed: Record<string, unknown> = {};
  for (const entry of manifest.files) {
    if (entry.path.startsWith('/') || entry.path.includes('..')) throw new PortableBackupError('INVALID_RECORD', 'The manifest names a path outside the bundle.', entry.path);
    const body = read(entry.path);
    if (body === null) throw new PortableBackupError('MISSING_FILE', 'A file the manifest lists is missing; nothing was imported.', entry.path);
    if ('sha256:' + sha256(body) !== entry.sha256) throw new PortableBackupError('INTEGRITY_FAILURE', 'A file does not match its manifest digest; nothing was imported.', entry.path);
    parsed[entry.path] = JSON.parse(body);
  }
  const listed = new Set(manifest.files.map(entry => entry.path));
  for (const path of [...Object.values(manifest.records), manifest.journal.path, ...manifest.artifacts.map(entry => entry.path), ...manifest.content.map(entry => entry.path)])
    if (!listed.has(path)) throw new PortableBackupError('MISSING_FILE', 'A referenced record is not listed with a digest.', path);
  const templateEntry = manifest.content.find(entry => entry.kind === 'template'), modelEntry = manifest.content.find(entry => entry.kind === 'model');
  if (!templateEntry || !modelEntry) throw new PortableBackupError('MISSING_FILE', 'The bundle does not carry the referenced template and model content.');
  const template = parsed[templateEntry.path] as ActivityTemplate, model = parsed[modelEntry.path] as ModelManifest;
  const tRef = templateRef(template);
  let mRef: ModelRef;
  try { mRef = { modelId: model.modelId, version: model.version, digest: validateManifest(model).identity.digest }; } catch { throw new PortableBackupError('INVALID_RECORD', 'The model content is not a valid manifest.', modelEntry.path); }
  if (canonicalJSON(tRef) !== canonicalJSON(templateEntry.ref)) throw new PortableBackupError('INTEGRITY_FAILURE', 'The template content does not have the referenced digest.', templateEntry.path);
  if (canonicalJSON(mRef) !== canonicalJSON(modelEntry.ref)) throw new PortableBackupError('INTEGRITY_FAILURE', 'The model content does not have the referenced digest.', modelEntry.path);
  const events = parsed[manifest.journal.path] as InteractionEvent[];
  events.forEach((event, index) => {
    if (!validateRecord(CONTRACTS.event, event).ok || event.activityId !== manifest.activityId || event.sequence !== index + 1) throw new PortableBackupError('INVALID_RECORD', 'The journal is not a gap-free sequence of valid events of this activity.', `${manifest.journal.path}[${index}]`);
  });
  if ((events.at(-1)?.sequence ?? 0) !== manifest.checkpoint.lastSequence || events.length !== manifest.journal.count) throw new PortableBackupError('INVALID_RECORD', 'The journal does not reach the checkpoint.', manifest.journal.path);
  for (const record of parsed[manifest.records.exposures] as ExposureRecord[]) if (!validateRecord(CONTRACTS.exposure, record).ok) throw new PortableBackupError('INVALID_RECORD', 'An exposure record is invalid.', manifest.records.exposures);
  let checkpoint: ActivityArtifact | null = null;
  for (const entry of manifest.artifacts) {
    const verified = verifyArtifact(parsed[entry.path]);
    if (!verified.ok || artifactDigest(verified.artifact) !== entry.digest) throw new PortableBackupError('INTEGRITY_FAILURE', 'An artifact does not verify.', entry.path);
    if (entry.artifactId === manifest.checkpoint.artifactId) checkpoint = verified.artifact;
  }
  if (!checkpoint || artifactDigest(checkpoint) !== manifest.checkpoint.artifactDigest) throw new PortableBackupError('MISSING_FILE', 'The checkpoint artifact is missing.');
  if (canonicalJSON(checkpoint.template) !== canonicalJSON(tRef) || canonicalJSON(checkpoint.model) !== canonicalJSON(mRef)) throw new PortableBackupError('INTEGRITY_FAILURE', 'The checkpoint references other content than the bundle carries.');
  return { manifest, parsed, content: { template, model, templateRef: tRef, modelRef: mRef }, checkpoint };
}

/**
 * Imports a verified bundle into a host store (null = an empty store) in one transaction on a copy: records are keyed
 * by their own identity (eventId, exposureId, receiptId, idempotency key, artifactId), so importing the same bundle
 * again adds nothing and reports duplicates; a different record under an existing identity is a CONFLICT.
 */
export function importPortableBackup(target: MemoryHostSnapshot | null, read: (path: string) => string | null): { store: MemoryHostSnapshot; report: ImportReport; content: VerifiedContent; checkpoint: ActivityArtifact } {
  const { manifest, parsed, content, checkpoint } = readPortableBackup(read);
  const policy = parsed[manifest.records.policy] as HostPolicy;
  const activity = parsed[manifest.records.activity] as Pick<Table, 'instance' | 'activityRevision' | 'stage' | 'registrations' | 'checkpointDigest'> & { idHighWater: number; clockMs: number };
  const store: MemoryHostSnapshot = target ? clone(target) : { policy: clone(policy), activities: {}, artifacts: {}, artifactOperations: {}, counter: 0, clockMs: 0 };
  if (store.policy.policyId === policy.policyId && store.policy.revision < policy.revision) store.policy = clone(policy);
  store.counter = Math.max(store.counter, activity.idHighWater);
  store.clockMs = Math.max(store.clockMs, activity.clockMs);
  const report: ImportReport = { imported: { events: 0, exposures: 0, receipts: 0, artifacts: 0 }, duplicates: { events: 0, exposures: 0, receipts: 0, artifacts: 0 } };
  const table: Table = store.activities[manifest.activityId] ??= {
    instance: clone(activity.instance), activityRevision: activity.activityRevision, stage: activity.stage, registrations: [...activity.registrations],
    events: [], eventDigests: {}, exposures: [], receipts: [], idempotency: {}, displayAcks: {}, checkpointDigest: activity.checkpointDigest,
  };
  for (const event of parsed[manifest.journal.path] as InteractionEvent[]) {
    const identity = digestOf(event), known = table.eventDigests[event.eventId];
    if (known !== undefined) {
      if (known !== identity) throw new PortableBackupError('CONFLICT', 'A different event with this eventId is already journaled.', event.eventId);
      report.duplicates.events++;
      continue;
    }
    if (event.sequence !== (table.events.at(-1)?.sequence ?? 0) + 1) throw new PortableBackupError('CONFLICT', 'The bundle journal does not continue the store journal.', event.eventId);
    table.events.push(clone(event));
    table.eventDigests[event.eventId] = identity;
    report.imported.events++;
  }
  for (const record of parsed[manifest.records.exposures] as ExposureRecord[]) {
    const existing = table.exposures.find(item => item.exposureId === record.exposureId);
    if (existing) { if (existing.receiptId !== record.receiptId) throw new PortableBackupError('CONFLICT', 'A different exposure record has this exposureId.', record.exposureId); report.duplicates.exposures++; continue; }
    table.exposures.push(clone(record));
    report.imported.exposures++;
  }
  for (const receipt of parsed[manifest.records.receipts] as Receipt[]) {
    const existing = table.receipts.find(item => item.receiptId === receipt.receiptId);
    if (existing) { if (digestOf(existing) !== digestOf(receipt)) throw new PortableBackupError('CONFLICT', 'A different receipt has this receiptId.', receipt.receiptId); report.duplicates.receipts++; continue; }
    table.receipts.push(clone(receipt));
    report.imported.receipts++;
  }
  for (const [key, entry] of Object.entries(parsed[manifest.records.idempotency] as Table['idempotency'])) {
    const existing = table.idempotency[key];
    if (existing && canonicalJSON(existing) !== canonicalJSON(entry)) throw new PortableBackupError('CONFLICT', 'An idempotency key maps to another receipt.', key);
    table.idempotency[key] = clone(entry);
  }
  for (const [exposureId, ack] of Object.entries(parsed[manifest.records.displayAcks] as Table['displayAcks'])) table.displayAcks[exposureId] ??= ack;
  for (const entry of manifest.artifacts) {
    const existing = store.artifacts[entry.artifactId];
    if (existing) { if (existing.digest !== entry.digest) throw new PortableBackupError('CONFLICT', 'A different artifact has this artifactId.', entry.artifactId); report.duplicates.artifacts++; continue; }
    store.artifacts[entry.artifactId] = { artifact: clone(parsed[entry.path] as ActivityArtifact), digest: entry.digest, operationId: `import.${entry.artifactId}`.slice(0, 128) };
    report.imported.artifacts++;
  }
  if (table.checkpointDigest === null) table.checkpointDigest = manifest.checkpoint.artifactDigest;
  return { store, report, content, checkpoint };
}

/**
 * Activity catalogue serving the bundle's content-addressed template and model (exact refs only, never a substitute).
 * Lifecycle status comes from the host-trusted installed registry; kernels are installed code in `createWorker`.
 */
export function bundleCatalog(content: VerifiedContent, status: (ref: TemplateRef | ModelRef) => CatalogEntryStatus, createWorker: () => Worker): ActivityCatalog {
  return {
    listTemplates: () => [{ template: { ...content.templateRef }, model: { ...content.modelRef }, title: content.template.title, dimension: content.template.dimension, status: status(content.templateRef) }],
    getTemplate: ref => ref.templateId === content.templateRef.templateId && ref.version === content.templateRef.version ? clone(content.template) : null,
    getModel: ref => ref.modelId === content.modelRef.modelId && ref.version === content.modelRef.version ? clone(content.model) : null,
    status,
    createWorker,
  };
}
