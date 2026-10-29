/** Artifact creation stays synchronous; readers and restore codecs are optional for prepare/save consumers. */
import { canonicalJSON } from '@experiment-kit/core';
import type {
  ActivityArtifact, ActivityInstance, ArtifactLineage, AssistanceRef, Diagnostic, ExposureRecord, PresentationSnapshot, ScientificSnapshot,
} from './contracts.js';
import { ACTIVITY_SCHEMA_VERSION, CONTRACTS } from './contracts.js';
import { diagnostic, snapshotProblems } from './artifact-validation.js';
import { artifactIntegrity } from './identity.js';
import { validateArtifactSemantics } from './semantic.js';
import { validateRecord } from './validator.js';

/** Caller-supplied projection filter for a learner snapshot (D6). Filters may only remove data, never add or change it. */
export interface LearnerFilter {
  /** Removes every parameter and comparison the learner projection does not show. */
  scientific(snapshot: ScientificSnapshot): ScientificSnapshot;
  /** Restricts views, layers, selection and display units to the projection; unchanged when omitted. */
  presentation?(snapshot: PresentationSnapshot): PresentationSnapshot;
  /** Template content IDs visible in the projection; other content references are dropped (default: none kept). */
  contentRefs?: readonly string[];
}
export interface ArtifactParts {
  kind: ActivityArtifact['kind'];
  artifactId: string;
  runtime: ActivityArtifact['runtime'];
  instance: ActivityInstance;
  /** The committed checkpoint. A tentative preview frame is never passed here. */
  scientific: ScientificSnapshot;
  presentation: PresentationSnapshot;
  exposures: ExposureRecord[];
  /** Journal checkpoint; a backup may also carry the pending events and the journal-loss record (a learner snapshot never does). */
  journal: ActivityArtifact['journal'];
  /** Preview active at save time; saving neither commits nor cancels it. */
  preview?: { previewId: string; params: Record<string, number>; baseRunId: string } | null;
  contentRefs: string[];
  reviewRefs: string[];
  /** Assistance receipts recorded up to the checkpoint; a backup lists them when there are any. */
  assistance?: AssistanceRef[];
  /** Context lineage of the exposure records (backups only, when some record no longer counts or reopening is required). */
  lineage?: ArtifactLineage;
  /** Required for `learner-snapshot`. */
  learner?: LearnerFilter;
}

/** Thrown by {@link buildArtifact}; `diagnostics` name fields only. */
export class ArtifactError extends Error {
  readonly diagnostics: Diagnostic[];
  constructor(diagnostics: Diagnostic[]) { super(diagnostics.map(item => `${item.path}: ${item.message}`).join('; ')); this.name = 'ArtifactError'; this.diagnostics = diagnostics; }
}

const same = (a: unknown, b: unknown): boolean => canonicalJSON(a) === canonicalJSON(b);
const subsetOf = (part: Record<string, unknown>, whole: Record<string, unknown>): boolean =>
  Object.entries(part).every(([key, value]) => Object.hasOwn(whole, key) && same(value, whole[key]));
const ONLY_REMOVE = 'A learner filter may only remove data; it cannot add or change values.';

/** Checks that a filtered scientific snapshot keeps identity and only drops parameters or comparisons. */
function filteredScientific(original: ScientificSnapshot, filtered: ScientificSnapshot): Diagnostic[] {
  const out: Diagnostic[] = [];
  const { params, comparisons, ...identity } = filtered;
  const { params: originalParams, comparisons: originalComparisons, ...originalIdentity } = original;
  if (!same(identity, originalIdentity)) out.push(diagnostic('INVALID_INPUT', '$.scientific', 'A learner filter must keep the model, run and position identity of the snapshot.'));
  if (!params || !subsetOf(params, originalParams)) out.push(diagnostic('INVALID_INPUT', '$.scientific.params', ONLY_REMOVE));
  (comparisons ?? []).forEach((comparison, index) => {
    const source = originalComparisons.find(item => item.runId === comparison.runId);
    const { params: kept, ...rest } = comparison;
    if (!source || !subsetOf(kept, source.params) || !same(rest, { ...source, params: undefined })) out.push(diagnostic('INVALID_INPUT', `$.scientific.comparisons[${index}]`, ONLY_REMOVE));
  });
  return out;
}
function filteredPresentation(original: PresentationSnapshot, filtered: PresentationSnapshot): Diagnostic[] {
  const out: Diagnostic[] = [];
  const { views, displayUnits, selection, ...rest } = filtered;
  const { views: originalViews, displayUnits: originalUnits, selection: _ignored, ...originalRest } = original;
  void _ignored;
  if (!same(rest, originalRest)) out.push(diagnostic('INVALID_INPUT', '$.presentation', ONLY_REMOVE));
  for (const [viewId, view] of Object.entries(views)) {
    const source = originalViews[viewId];
    if (!source || !same(view.camera, source.camera) || view.layers.some(layer => !source.layers.includes(layer))) out.push(diagnostic('INVALID_INPUT', `$.presentation.views.${viewId}`, ONLY_REMOVE));
  }
  if (!subsetOf(displayUnits, originalUnits)) out.push(diagnostic('INVALID_INPUT', '$.presentation.displayUnits', ONLY_REMOVE));
  if (selection !== null && selection !== original.selection) out.push(diagnostic('INVALID_INPUT', '$.presentation.selection', ONLY_REMOVE));
  return out;
}

/** Builds and validates an artifact, or returns why it cannot be built. */
export function tryBuildArtifact(parts: ArtifactParts): { ok: true; artifact: ActivityArtifact } | { ok: false; diagnostics: Diagnostic[] } {
  const learner = parts.kind === 'learner-snapshot';
  if (learner && !parts.learner) return { ok: false, diagnostics: [diagnostic('INVALID_INPUT', '$.learner', 'A learner snapshot requires the caller\'s projection filter.', 'Pass the learner projection filter, or save a backup instead.')] };
  if (parts.preview && parts.preview.baseRunId !== parts.scientific.runId) {
    return { ok: false, diagnostics: [diagnostic('INVALID_INPUT', '$.preview.baseRunId', 'The pending preview is not based on the saved committed run; a tentative frame is never saved as the experiment.', 'Save the committed checkpoint the preview started from.')] };
  }
  let scientific = structuredClone(parts.scientific);
  let presentation = structuredClone(parts.presentation);
  let instance = structuredClone(parts.instance);
  let contentRefs = [...parts.contentRefs];
  let pending: ActivityArtifact['pending'] = parts.preview ? { kind: 'preview', previewId: parts.preview.previewId, params: structuredClone(parts.preview.params), baseRunId: parts.preview.baseRunId } : { kind: 'none' };
  let exposures = structuredClone(parts.exposures);
  let journal = structuredClone(parts.journal);
  let reviewRefs = [...parts.reviewRefs];
  if (learner) {
    const filter = parts.learner!;
    scientific = filter.scientific(structuredClone(parts.scientific));
    const problems = filteredScientific(parts.scientific, scientific);
    if (filter.presentation) {
      presentation = filter.presentation(structuredClone(parts.presentation));
      problems.push(...filteredPresentation(parts.presentation, presentation));
    }
    const visible = new Set(filter.contentRefs ?? []);
    if ([...visible].some(ref => !parts.contentRefs.includes(ref))) problems.push(diagnostic('INVALID_INPUT', '$.learner.contentRefs', ONLY_REMOVE));
    if (problems.length) return { ok: false, diagnostics: problems };
    const keep = (values: Record<string, number>) => Object.fromEntries(Object.entries(values).filter(([key]) => Object.hasOwn(scientific.params, key)));
    contentRefs = parts.contentRefs.filter(ref => visible.has(ref));
    if (pending.kind === 'preview') pending = { ...pending, params: keep(pending.params) };
    // Host-only records: exposure evidence, review references, response records, objectives and journal internals.
    instance = { ...instance, objectiveIds: [], responses: [], initialParameters: keep(instance.initialParameters) };
    exposures = [];
    reviewRefs = [];
    journal = { cursor: { activityId: journal.cursor.activityId, lastSequence: journal.cursor.lastSequence, lastEventId: null, checkpointDigest: null }, pendingEventIds: [] };
  }
  const schemas = [CONTRACTS.artifact, CONTRACTS.instance, CONTRACTS.scientific, CONTRACTS.presentation, ...(exposures.length ? [CONTRACTS.exposure] : []),
    ...(journal.pendingEvents?.length ? [CONTRACTS.event] : [])].map(contract => ({ contract, version: ACTIVITY_SCHEMA_VERSION }));
  const body: Omit<ActivityArtifact, 'integrity'> = {
    contract: CONTRACTS.artifact, schemaVersion: ACTIVITY_SCHEMA_VERSION, artifactId: parts.artifactId, kind: parts.kind, schemas, runtime: structuredClone(parts.runtime),
    template: structuredClone(instance.template), model: structuredClone(instance.model), policyRef: structuredClone(instance.policy), instance, scientific, presentation,
    exposures, journal, pending, contentRefs, reviewRefs,
    // Assistance references are host records like exposures: a backup lists them when there are any (so an artifact
    // without assistance keeps its earlier shape and identity); a learner snapshot never carries them.
    ...(!learner && parts.assistance?.length ? { assistance: structuredClone(parts.assistance) } : {}),
    // Restricting lineage claims are host records too (backups only, and only when there is something to restrict).
    ...(!learner && parts.lineage ? { lineage: structuredClone(parts.lineage) } : {}),
  };
  const artifact: ActivityArtifact = { ...body, integrity: artifactIntegrity(body) };
  const checked = validateRecord(CONTRACTS.artifact, artifact);
  if (!checked.ok) return { ok: false, diagnostics: checked.diagnostics };
  const semantic = [...validateArtifactSemantics(artifact), ...snapshotProblems(artifact)];
  return semantic.length ? { ok: false, diagnostics: semantic } : { ok: true, artifact };
}

/** Builds a validated artifact with its integrity manifest; throws {@link ArtifactError} for invalid parts. */
export function buildArtifact(parts: ArtifactParts): ActivityArtifact {
  const result = tryBuildArtifact(parts);
  if (!result.ok) throw new ArtifactError(result.diagnostics);
  return result.artifact;
}
