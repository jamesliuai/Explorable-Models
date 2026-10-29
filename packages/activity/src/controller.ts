/**
 * Activity controller: one coordinated interaction authority per activity (report §5.3, §6, §7, §9; activity-runtime
 * §1–§9). It owns the guarded model session, the exposure ledger, the journal outbox and the presentation state, and
 * publishes one learner projection for every channel.
 *
 * Authority: actor attribution is fixed by the binding that issued a command (`binding(actor, id)` or the host
 * control); no input field chooses it. Receipts are accepted only as resolved values of the HostPort call made for
 * that request and only after `verifyReceipt`. Every command is deduplicated by operation ID (same arguments → same
 * outcome; different arguments → OPERATION_CONFLICT). Learner and tutor failures use the fixed learner-safe
 * vocabulary. After disposal no listener fires and late host or worker replies resolve into DISPOSED no-ops.
 *
 * Revisions: the activity revision is owned by the host and changes only to the value a verified receipt carries
 * (stage, reveal, exploration scope, assistance). Host-local changes — response references, policy updates, the
 * independent context, revocation and close — are guarded by the policy revision, the host session revision (echoed
 * as advanced by the host's response transaction) and the closed state instead, so the adapter never diverges from
 * the host's own revision counter.
 */
import { canonicalJSON, deepFreeze } from '@explorable-models/core';
import {
  checkParameters, clampForPreview, constraintReferences, convert, createModelSession, initialPosition, isModelError, jsonDataErrors,
  type FramePosition, type ModelFrame, type ModelGuard, type ModelIdentity, type ModelManifest, type ModelRef, type ModelSession,
  type ModelSessionState, type PositionRequest, type QuantityResult, type UnitId, type WorkerBudget,
} from '@explorable-models/core/model';
import type {
  ActivityBinding, ActivityDiagnostics, AudienceState, CommandFailure, CommandOutcome, DeveloperInspection, EvaluationMetrics, GestureKind, HostActivityControl,
  LearnerProjection, PreparedActivity,
} from './api.js';
import type {
  ActivityArtifact, ActivityCatalog, ActivityInstance, ActivityTemplate, ActorKind, AssistanceReceipt, AssistanceRef, Camera2D, Camera3D, Diagnostic, DiagnosticCode,
  EventType, ExposureGrant, ExposureRecord, FrameRef, GroupDigest, HostPolicy, HostPort, HostRefusalCode, InteractionEvent, InteractionSummary,
  PresentationSnapshot, ResponseRef, ScientificSnapshot, StageSpec, TemplateRef, ToolOperation, Visibility,
} from './contracts.js';
import { ACTIVITY_SCHEMA_VERSION, CONTRACTS, isHostRefusal } from './contracts.js';
import { EVENT_DATA_LIMITS, MESSAGES } from './schemas.js';
import { describeProjection, learnerDiagnostics, PLAYBACK_LIMIT_NOTICE, PREVIEW_REFUSED_NOTICE, withHostRecovery, WORKER_RECOVERY_EXHAUSTED, type LearnerConstraintText } from './describe.js';
import { fromModelDiagnostics, hostRefusalDiagnostic } from './diagnostics.js';
import { createExposureLedger, type ExposureLedger } from './exposure.js';
import { artifactDigest, groupDigests } from './identity.js';
import { createOutbox, isEvidenceBearing, isPersistenceError, type Outbox } from './journal.js';
import { modeDiagnostic, policyDiagnostics, policyStanding, revocationDiagnostic, toolPermitted, type HostClock } from './policy.js';
import { controlDisplayUnit, numericalLimitShown, projectLearnerView, visibleGroupIds, type OperationalStatus } from './projection.js';
import { verifyReceipt, type ReceiptExpectation } from './receipts.js';
import { trySummarize } from './summary.js';
import { tryBuildArtifact } from './artifact-build.js';
import { validateRecord } from './validator.js';
import { computeControlModes, computeVisibility, navigationVisibility, solutionGroupsFor, visibleQuantityIds } from './visibility.js';
import type { AssistanceSnapshot } from './api.js';
import type { ActivityRecords, ArtifactLineage, DisplayEndReason, JournalLoss } from './contracts.js';
import { commandCapacity } from './journal.js';

/** Runtime identity recorded in scientific snapshots and sample provenance. */
export const MODEL_RUNTIME = Object.freeze({ id: 'explorable-models.model-runtime', version: '1.0.0' });
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const OPERATION_CACHE = 256;
const PUBLISHED_RING = 16;
const RENDERED_CAP = 2000;
/** preview.observed keeps at most this many rendered samples (first, last, evenly spaced). */
export const PREVIEW_SAMPLE_LIMIT = 20;
/** Bytes of unacknowledged events a backup carries for a restore to resend (a contiguous prefix; the rest are listed by ID). */
export const PENDING_EVENT_BYTES = 1024 * 1024;
/** Latency samples kept per evaluation kind, and refused commands kept, for host-only diagnostics. */
const METRIC_SAMPLES = 64;
const FAILURE_RING = 32;
/** p50/p95/max of bounded latency samples (nearest-rank). */
function summarizeLatency(samples: readonly number[]): EvaluationMetrics {
  if (!samples.length) return { count: 0, lastMs: null, p50Ms: null, p95Ms: null, maxMs: null };
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
  return { count: samples.length, lastMs: samples.at(-1)!, p50Ms: rank(0.5), p95Ms: rank(0.95), maxMs: sorted.at(-1)! };
}
/** True when an event payload fits the 8 KiB bound under the validator's own byte accounting. */
const fits = (payload: unknown): boolean => jsonDataErrors(payload, { maxBytes: EVENT_DATA_LIMITS.maxPayloadBytes!, maxDepth: EVENT_DATA_LIMITS.maxDepth, maxNodes: EVENT_DATA_LIMITS.maxNodes }).length === 0;

type Actor = { kind: ActorKind; binding: string };
type Fail = { ok: false; diagnostics: Diagnostic[] };
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const diag = (code: DiagnosticCode, path: string, message: string, recovery?: string): Diagnostic => ({ code, path, message, ...(recovery ? { recovery } : {}) });
/** A failure; every diagnostic without a recovery of its own gets the host-facing default (report §5.3, `HOST_RECOVERY`). */
const failure = (...diagnostics: Diagnostic[]): Fail => ({ ok: false, diagnostics: withHostRecovery(diagnostics) });
const sameJSON = (a: unknown, b: unknown): boolean => canonicalJSON(a) === canonicalJSON(b);
const groupKeys = (record: ExposureRecord): string => canonicalJSON(record.groups.map(group => `${group.groupId}\u0000${group.contentDigest}`).sort());
/** The same grant: exposure ID, receipt, scope, exact group digests, stage, revision, parameter domain and references. */
const sameGrant = (a: ExposureRecord, b: ExposureRecord): boolean => a.exposureId === b.exposureId && a.receiptId === b.receiptId && a.activityId === b.activityId
  && a.scope === b.scope && a.intendedStage === b.intendedStage && a.activityRevision === b.activityRevision && groupKeys(a) === groupKeys(b)
  && sameJSON(a.parameterDomain ?? null, b.parameterDomain ?? null) && sameJSON(a.template, b.template) && sameJSON(a.model, b.model);

/** Detached JSON copy of caller input; accessors, functions and cycles make the input invalid. */
function detach(value: unknown): { ok: true; value: unknown } | { ok: false } {
  try {
    const text = JSON.stringify(value, (_key, item) => {
      if (typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint') throw new TypeError('not data');
      return item;
    });
    return { ok: true, value: text === undefined ? undefined : JSON.parse(text) };
  } catch { return { ok: false }; }
}
const toDiagnostics = (error: unknown): Diagnostic[] => isModelError(error) ? fromModelDiagnostics(error.diagnostics, 'WORKER_ERROR')
  : isRecord(error) && Array.isArray(error.diagnostics) ? fromModelDiagnostics(error.diagnostics as Diagnostic[], 'WORKER_ERROR')
    : [diag('WORKER_ERROR', '$', 'The operation failed.')];

export interface ControllerContext {
  activityId: string;
  template: ActivityTemplate;
  manifest: ModelManifest;
  identity: ModelIdentity;
  templateRef: TemplateRef;
  modelRef: ModelRef;
  catalog: ActivityCatalog;
  host: HostPort;
  budget: WorkerBudget;
  hostClock: HostClock;
  clock: { monotonic(): number };
  /** Monotonic origin of the adapter; event `monotonicMs` is measured from it. */
  origin: number;
  idFactory: () => string;
  outboxLimit: number;
  /** Wait for in-flight journal batches before a flush-first step is refused with PERSISTENCE_PENDING (`persistenceWaitMs`). */
  persistenceWaitMs: number;
  policy: HostPolicy;
  instance: ActivityInstance;
  reviewNotice: string;
  /** Called once when the controller is disposed (the adapter forgets it). */
  onDisposed(): void;
  /**
   * Called when `forget({ scope: 'activity' })` runs: the adapter releases the outcomes of its own deduplicated
   * operations for this activity (prepare and restore; a restore report holds draft parameter values and notes), so a
   * replay of their operation IDs no longer returns them (activity-runtime §8).
   */
  onForgotten(): void;
}

/** One cached command outcome (see `operations` in the controller). */
interface OperationEntry {
  fingerprint: string; outcome: unknown; settled: boolean; retryable: boolean; value?: unknown; forgotten?: boolean;
  release?: ((value: Record<string, unknown>) => boolean)[];
}

export interface RestoredState {
  artifact: ActivityArtifact;
  artifactDigest: string;
  /** The outcome the artifact and current policy allow; the host's records can only make it more restrictive. */
  restored: 'exact' | 'restricted' | 'read-only';
  /**
   * Saved exposure records whose context lineage, as the artifact records it, counts in the restored context. These are
   * restricting claims only: a record counts for visibility only when, in addition, the host's records hold the same grant
   * and the host's context lineage counts it (`openRestored`): the host decides which grants count.
   */
  counts(record: ExposureRecord): boolean;
  /**
   * The artifact claims that instructional solution-bearing content waits for `reopenInstructional` (an assistance
   * record): it was saved in an independent context, or awaited reopening, and the activity is restored instructional.
   * A restricting claim: the host's context lineage can also require a reopening the artifact does not claim.
   */
  reopenRequired: boolean;
}

export interface ActivityController {
  readonly activityId: string;
  readonly disposed: boolean;
  /** Registers with the host, loads the model, appends activity.prepared/opened and the initial run. */
  open(input: { params: Record<string, number>; operationId: string; signal?: AbortSignal }): Promise<Fail | null>;
  /** Restores a verified artifact (activity-runtime §9): paused, conservative exposures, no reveal re-emission. */
  openRestored(input: { restored: RestoredState; operationId: string; signal?: AbortSignal }): Promise<Fail | null>;
  /** Notes collected while restoring (restrictions, journal gaps, conservative exposure changes). */
  notes(): string[];
  /** The restore outcome after the host's records were read: the requested one, or a more restrictive one. */
  restoration(): RestoredState['restored'];
  prepared(): PreparedActivity;
  state(audience: AudienceState['audience']): AudienceState;
  summary(options: { audience: InteractionSummary['audience']; fromSequence?: number; toSequence?: number; limits?: Partial<{ committedConfigurations: number; previewObservations: number; bytes: number }> }): InteractionSummary | CommandFailure;
  sample(request: { parameters: Record<string, number>; positions: PositionRequest[]; audience: 'host' | 'teacher' }, signal?: AbortSignal): Promise<{ ok: true; frames: unknown[]; provenance: { model: ModelRef; scientificRevision: string; runtime: { id: string; version: string } } } | CommandFailure>;
  /** Host-only operational metrics (no content): see `ActivityDiagnostics`. */
  diagnostics(): ActivityDiagnostics;
  /** Developer inspection, refused with POLICY_DENIED unless the current policy sets `inspection.developer`. */
  developer(): DeveloperInspection | CommandFailure;
  dispose(): void;
}

interface PreviewTrack {
  previewId: string;
  parameter: string;
  gesture: GestureKind;
  /** Stage and context the preview was authorized in: a change of either ends it (activity-runtime §11). */
  stageId: string;
  context: 'instructional' | 'independent';
  baseRunId: string;
  actor: Actor;
  operationId: string;
  domain: Record<string, [number, number]> | null;
  /** Last accepted full canonical parameter set. */
  params: Record<string, number> | null;
  /** The session refused the last submission for a reason other than a worker failure; the next update resends. */
  refused: boolean;
  /** The preview is being committed: no further value is sent to the session. */
  closing: boolean;
  rendered: { params: Record<string, number>; frameId: string; visibleQuantities: Record<string, QuantityResult> }[];
  dropped: number;
  clamped: boolean;
  /** Journal ID of `preview.started` (causal antecedent of the preview's later events). */
  startedEventId?: string | null;
  /**
   * Coalescing (report §18, D11: one active preview evaluation plus one newest pending value). At most one session
   * submission is outstanding; later updates replace `params` and are submitted when it settles, so the newest value
   * always wins and a burst never grows the session's pending operations.
   */
  inFlight: boolean;
  /** Parameters of the outstanding or last settled submission. */
  submitted: Record<string, number> | null;
  /** Monotonic time of the outstanding submission (preview evaluation latency). */
  submittedAt: number;
  /** Accepted updates, and updates replaced by a newer value before they were submitted. */
  updates: number;
  coalesced: number;
  /** The commit of this preview while it is in flight (`commitPreview`; see {@link CommitFlight}). */
  commit?: CommitFlight;
}
/**
 * A preview commit in flight (report §6.3, §9, A24; activity-runtime §11). Every change that can take the preview's
 * authorization away settles it first (`settleClosingCommit`): a commit the session has already applied happened before
 * the change and is journaled then, in that order; otherwise the change re-validates the preview and, when it is no
 * longer authorized, aborts the commit, so the session refuses it (CANCELLED) and nothing lands in the new stage,
 * context, policy or grant.
 */
interface CommitFlight {
  abort: AbortController;
  /** True once the session applied this commit (its run replaced the one the commit started from) and it is not journaled yet. */
  landed(): boolean;
  /** Journals the applied commit (`parameters.committed`) and ends the preview committed, once, whichever path gets there first. */
  journal(): void;
}
interface PendingAuthorization {
  kind: 'stage' | 'reveal' | 'exploration' | 'assistance';
  /** The command that created it; a re-issue of that command with the same operation ID resumes it. */
  origin: string;
  operationId: string;
  actor: Actor;
  labels: string[];
  groups: GroupDigest[];
  state: 'requesting' | 'failed';
  /** Revisions the host request is based on (sent as `basedOnActivityRevision` and `expectedPolicyRevision`). */
  basedOn: { activity: number; policy: number };
  /** The adapter's activity revision when the request was issued (equal to `basedOn.activity` except for a resumption). */
  revision: number;
  epoch: number;
  call(): Promise<unknown>;
  expectation: ReceiptExpectation;
  apply(receipt: unknown): Diagnostic | null;
  /**
   * Keeps a verified receipt that can no longer be applied (the context, activity or policy changed while the host
   * answered, or it expired) as history: the host committed it, so the adapter follows the host-owned activity revision
   * (and stage) and records the grant and assistance without letting them count for visibility.
   */
  history(receipt: unknown): void;
  /** Resumption of a host-held grant the restored checkpoint did not know (see `resumes`). */
  resume?: { exposureId: string; receiptId: string };
  /** For a resumption: the same request as a new one, based on the current activity revision. */
  renew?(): PendingAuthorization;
  /** The host refusal code, when the host refused this request. */
  refusal?: HostRefusalCode;
}
/**
 * A grant the host committed after the restored checkpoint whose receipt never reached the adapter (a crash after the
 * host's commit and before its reply): re-issuing exactly that request resends it as it was issued, based on the activity
 * revision the host held before that grant, so the host's idempotency replays the committed receipt instead of a second
 * authorization being recorded (report §6.3, §7.2, A20).
 */
interface ResumableGrant { record: ExposureRecord; base: number; epoch: number }
interface Published { projectionId: string; digest: string; groups: Set<string>; frameId: string | null; frameKind: 'committed' | 'tentative' }
/**
 * The scientific operation a worker timeout or crash interrupted (report §9: bounded recovery). `retryPersistence`
 * re-issues it with fresh guards; `refresh` re-evaluates the shown position (a failed playback tick, or a re-issue that
 * the current stage or policy no longer permits); `preview` re-submits the active preview's latest values.
 */
type FailedOperation =
  | { kind: 'commit'; params: Record<string, number>; cause: 'commit' | 'reset' | 'scenario'; extra: Record<string, unknown> }
  | { kind: 'navigate'; position: PositionRequest; cause: 'navigate' | 'step' | 'restart' }
  | { kind: 'preview'; previewId: string }
  | { kind: 'refresh' };
/** Recovery attempts per worker failure; after them the status offers `reload` instead of `retry`. */
export const WORKER_RECOVERY_ATTEMPTS = 3;

export function createActivityController(ctx: ControllerContext): ActivityController {
  const { activityId, template, manifest, templateRef, modelRef, host, idFactory } = ctx;
  const newId = (): string => { const value = idFactory(); if (typeof value !== 'string' || !ID.test(value)) throw new RangeError('The ID factory returned an invalid ID.'); return value; };
  const internalOp = () => `adapter.${newId()}`.slice(0, 128);
  const digests: Record<string, string> = Object.fromEntries(groupDigests(template, manifest).map(entry => [entry.groupId, entry.contentDigest]));
  const stages = new Map(template.stages.map(stage => [stage.id, stage]));
  const controlsByParameter = new Map(template.controls.map(control => [control.parameter, control]));
  const quantityDisplay = template.quantityDisplay ?? {};
  /** Units a presentation snapshot may name for an ID: a control's display units or a declared quantity's units. */
  const listedUnits = (id: string): readonly UnitId[] => controlsByParameter.get(id)?.displayUnits ?? (Object.hasOwn(quantityDisplay, id) ? quantityDisplay[id]!.units : []);
  const groupsById = new Map(template.groups.map(group => [group.id, group]));

  let instance: ActivityInstance = structuredClone(ctx.instance);
  let policy: HostPolicy = structuredClone(ctx.policy);
  let presentation: PresentationSnapshot = {
    contract: CONTRACTS.presentation, schemaVersion: ACTIVITY_SCHEMA_VERSION, revision: 0, views: {}, selection: null, layout: 'auto', displayUnits: {},
    locale: template.locale, formatVersion: '1.0',
  };
  const reviewNotice = ctx.reviewNotice;
  const exposures: ExposureLedger = createExposureLedger();
  const session: ModelSession = createModelSession({ budget: ctx.budget, workerFactory: () => ctx.catalog.createWorker(), ownerId: activityId, idFactory: () => newId() });
  let disposed = false, ready = false, restored = false;
  let hostSuspended: string | null = null;
  const surfaces = new Map<string, boolean>();
  let preview: PreviewTrack | null = null;
  let pending: PendingAuthorization | null = null;
  let pendingReveal: LearnerProjection['pendingReveal'] = null;
  let revealEpoch = 0;
  let workerFailure = false;
  /** What a worker failure interrupted, the recovery attempts made for it and the recovery in flight. */
  let failedOperation: FailedOperation | null = null;
  let recoveryAttempts = 0;
  let recovering: Promise<CommandOutcome> | null = null;
  /** An event the outbox refused after the command was accepted; reported as a recoverable failure. */
  let journalError: Diagnostic | null = null;
  /**
   * Events the outbox refused (activity-runtime §5): every loss since the activity opened (carried by backups and
   * restores), and the losses not yet recorded in the journal by an `operation.failed` event with `lost`.
   */
  let lost: JournalLoss | null = null;
  let unrecordedLoss: JournalLoss | null = null;
  let lossCode: DiagnosticCode = 'PERSISTENCE_BACKPRESSURE';
  let recordingLoss = false;
  /** A flush-first step was refused while journal batches were in flight; the card awaits persistence until saved. */
  let awaitingFlush = false;
  /** Causal antecedents journaled by this process: each exposure's authorization and each response's submission. */
  const authorizedEvents = new Map<string, string>();
  const submittedEvents = new Map<string, string>();
  /** Exposures whose display this process acknowledged: their display interval end is observed here. */
  const displayedHere = new Set<string>();
  let endCause: DisplayEndReason | null = null;
  /** Restored from an independent lineage into instructional work: instructional content waits for reopenInstructional. */
  let reopenRequired = false;
  /** Why the local exposure and assistance ledger may be partial (a restore without the host's records). */
  const ledgerLimitations: string[] = [];
  /** Revocation sources already journaled: `content.revoked` is recorded once per source. */
  const revokedSources = new Set<'host' | 'policy' | 'catalogue'>();
  /** A preview the host closed with `pending: 'retain'`: later backups record it as the pending draft. */
  let retainedDraft: { previewId: string; params: Record<string, number>; baseRunId: string } | null = null;
  let notice: string | null = null;
  /** Set when playback stopped by itself before a numerical limit; cleared by the next navigation, commit or play. */
  let playbackNotice: string | null = null;
  /**
   * The frame at a numerical limit that playback declined to cross because the learner projection showed its limit
   * (`crossesLimit`), and the one it stopped before. The notice names that value, so it is projected only while the
   * projection still shows the limit of this frame (report §6.2): otherwise it would describe a hidden value.
   */
  let limitAhead: ModelFrame | null = null, playbackLimit: ModelFrame | null = null;
  /** Host-only metrics (report §19): evaluation latencies (ms, newest last) and the most recent refused commands. */
  const latency: Record<'commit' | 'navigate' | 'preview', number[]> = { commit: [], navigate: [], preview: [] };
  const failures: ActivityDiagnostics['failures'] = [];
  const now = (): number => Math.max(0, ctx.clock.monotonic() - ctx.origin);
  const measure = (kind: keyof typeof latency, startedAt: number): void => {
    const samples = latency[kind];
    samples.push(Math.max(0, now() - startedAt));
    if (samples.length > METRIC_SAMPLES) samples.shift();
  };
  let stale: Diagnostic | null = null;
  let revokedByHost: Diagnostic | null = null;
  let unsupported: Diagnostic | null = null;
  let activeScenarioId: string | null = null;
  let playbackActor: Actor | null = null;
  const restoreNotes: string[] = [];
  /** Acknowledged events released by `forget`; summaries report them as omitted. */
  let forgottenEvents = 0;
  const usedReceipts = new Map<string, string>();
  /** Host-held grants a re-issued request may resume after a restore (see {@link ResumableGrant}), by exposure ID. */
  const resumes = new Map<string, ResumableGrant>();
  /** How the restore came out once the host's records were read (`openRestored`); reported by `restoration()`. */
  let restoredAs: RestoredState['restored'] = 'exact';
  /** Assistance receipts of this activity, oldest first; restored from a backup and saved with every backup. */
  const assistance: AssistanceRef[] = [];
  const frozen = new Map<string, ReturnType<HostActivityControl['freezeAssistanceSnapshot']>>();
  /**
   * Outcomes by operation ID (same arguments → same outcome). `value` is the settled outcome; `forgotten` marks an
   * outcome released by `forget` (it held copies of activity data), which a replay then reports instead of returning it.
   * `release` holds the `forget` filters that ran while the operation was still in flight: its outcome is released as
   * soon as it settles, so an operation that finishes after a `forget` never leaves a copy behind.
   */
  const operations = new Map<string, OperationEntry>();
  const listeners = new Set<(projection: LearnerProjection) => void>();
  const published: Published[] = [];
  const ackInFlight = new Set<string>();
  const lifetime = new AbortController();
  let projection: LearnerProjection;
  let visibility: { groups: Record<string, Visibility>; controls: Record<string, 'interactive' | 'fixed'> } = { groups: {}, controls: {} };

  // Created when the activity opens: a restored activity continues after the host's journal cursor.
  let outbox!: Outbox;
  let journalOpen = false;
  const openJournal = (lastSequence: number) => {
    outbox = createOutbox({ host, activityId, limit: ctx.outboxLimit, lastSequence, onChange: outboxChanged, onHostTime: observeHostTime });
    journalOpen = true;
  };
  /** Sequence of the last journaled event. */
  const lastSequence = (): number => journalOpen ? outbox.nextSequence() - 1 : 0;
  const stage = (): StageSpec => stages.get(instance.stage.id)!;
  const independent = () => instance.context.kind === 'independent';
  const suspended = () => session.getState().status === 'suspended';
  const hostActor: Actor = { kind: 'host', binding: 'host-control' };

  // ---- visibility and projection ------------------------------------------------------------------------------
  function computeVis(): typeof visibility {
    const blocked = disposed || instance.closed || stale !== null || unsupported !== null;
    const groups: Record<string, Visibility> = blocked ? Object.fromEntries(template.groups.map(group => [group.id, 'absent' as Visibility]))
      : computeVisibility(template, stage(), policy, exposures.current(), { kind: instance.context.kind, digests, template: templateRef, model: modelRef });
    return { groups, controls: blocked ? {} : computeControlModes(template, stage(), policy, groups) };
  }
  function displayedFrame(state: ModelSessionState = session.getState()): { frame: ModelFrame | null; kind: 'committed' | 'tentative' } {
    const tentative = preview && state.preview?.previewId === preview.previewId ? state.preview.frame : null;
    return tentative ? { frame: tentative, kind: 'tentative' } : { frame: state.frame, kind: 'committed' };
  }
  function operational(): OperationalStatus {
    const persistence = outbox.state().persistence;
    const awaiting = awaitingFlush || pendingReveal !== null && pendingReveal.state !== 'awaiting-display' || persistence === 'pending-recovery' || persistence === 'failed'
      || exposures.unpersistedAcks().some(record => record.uncertainty?.code === 'ACK_NOT_PERSISTED');
    const forced: OperationalStatus['forced'] = disposed ? 'disposed' : !ready ? 'preparing' : unsupported ? 'unsupported' : stale ? 'stale-policy'
      : instance.closed ? null : suspended() ? 'suspended' : awaiting ? 'awaiting-persistence' : workerFailure || journalError ? 'recoverable-failure' : null;
    const suspension = forced === 'suspended' ? hostSuspended === 'host' ? 'host' : 'visibility' : null;
    // Worker recovery used up: the failure stays visible with the last accepted frame and the card offers a reload.
    const exhausted = forced === 'recoverable-failure' && workerFailure && recoveryAttempts >= WORKER_RECOVERY_ATTEMPTS;
    return {
      forced, persistence, restored, closed: instance.closed, suspension,
      notice: exhausted ? WORKER_RECOVERY_EXHAUSTED.notice : [notice, shownPlaybackNotice()].filter(Boolean).join(' ') || null, ...(exhausted ? { recovery: { ...WORKER_RECOVERY_EXHAUSTED.recovery } } : {}),
    };
  }
  /** The playback-limit notice, only while the projection shows the limit playback stopped before (`playbackLimit`). */
  function shownPlaybackNotice(): string | null {
    return playbackNotice && playbackLimit && numericalLimitShown(template, visibility.groups, playbackLimit) ? playbackNotice : null;
  }
  /**
   * Whether playback crosses the numerical limit of `frame` (report §6.2, §8.4, A21; `ModelPlaybackOptions`). A limit the
   * learner projection does not show is crossed: playback runs on to the position's own end (the last index or the end
   * time) and play is accepted from a frame at it, exactly as for a run without a limit, so neither where playback stops
   * nor a refused play tells a hidden outcome (for example a diverging trace that is not shown) from another. A shown
   * limit is not crossed: playback stops one step before it and the frame is kept for the notice.
   */
  function crossesLimit(frame: ModelFrame): boolean {
    if (disposed) return false;
    if (!numericalLimitShown(template, computeVis().groups, frame)) return true;
    limitAhead = frame;
    return false;
  }

  function build(): LearnerProjection {
    const state = session.getState();
    visibility = computeVis();
    const { frame, kind } = displayedFrame(state);
    return projectLearnerView({
      projectionId: 'unpublished', activityId, activityRevision: instance.activityRevision, policyRevision: policy.revision, template, manifest, stage: stage(),
      context: instance.context.kind, groups: visibility.groups, controls: visibility.controls, frame: disposed ? null : frame, frameKind: kind,
      committedParams: state.run?.params ?? null, guards: { expectedScientificVersion: state.version, expectedRunId: state.run?.id ?? null },
      preview: preview ? { previewId: preview.previewId, parameter: preview.parameter } : null,
      playing: state.playing, activeScenarioId, comparisons: state.comparisons, presentation, operational: operational(), reviewNotice, pendingReveal,
      // Capture follows the current host policy (report §5.3 authorized capture); nothing is capturable while blocked.
      permissions: { capture: policy.export.capture && !disposed && !instance.closed && stale === null && unsupported === null },
    });
  }
  function publish(): LearnerProjection {
    if (disposed && projection) return projection;
    // A tentative frame is projected only while its preview is authorized (report §6.3, A24): a stage, context, policy or
    // grant change that took the authorization away — on any path, including a receipt applied after the host answered —
    // ends the preview (`preview.cancelled`, nothing committed) before anything is built from it. A preview whose commit
    // is in flight is re-validated too: its commit is then aborted (`interruptPreview`), so it never lands afterwards.
    if (preview && ready && journalOpen && !previewAuthorized(preview)) revalidatePreview('revoked', internalOp(), hostActor);
    const next = build();
    if (projection && next.projectionDigest === projection.projectionDigest && next.presentationRevision === projection.presentationRevision) return projection;
    next.projectionId = newId();
    projection = deepFreeze(next);
    published.push({ projectionId: projection.projectionId, digest: projection.projectionDigest, groups: new Set(visibleGroupIds(visibility.groups)), frameId: projection.frame?.frameId ?? null, frameKind: projection.frame?.kind ?? 'committed' });
    trackDisplayIntervals(published.at(-1)!.groups);
    if (published.length > PUBLISHED_RING) published.shift();
    for (const listener of [...listeners]) { try { listener(projection); } catch { /* A listener cannot affect accepted state. */ } }
    return projection;
  }
  let flushScheduled = false;
  /** Appends never contact the host; one flush per turn sends everything queued in that turn. */
  function scheduleFlush(): void {
    if (flushScheduled || disposed) return;
    flushScheduled = true;
    queueMicrotask(() => { flushScheduled = false; if (!disposed) void outbox.flush(); });
  }
  let scheduled = false;
  function schedulePublish(): void {
    if (scheduled || disposed) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; if (!disposed && ready) publish(); });
  }
  /** Outbox state changed: republish, end a finished persistence wait and record journal losses once there is room. */
  function outboxChanged(): void {
    if (awaitingFlush && outbox.state().pending === 0) awaitingFlush = false;
    if (unrecordedLoss && outbox.state().pending < ctx.outboxLimit) queueMicrotask(() => { if (!disposed) recordLoss(); });
    schedulePublish();
  }
  /**
   * A host acknowledgement time advances the host clock (report §5.1 expiry state). When it shows the policy has expired,
   * the activity stops at once: the card shows the stale policy and any preview or playback ends, as on a policy update.
   */
  function observeHostTime(timestamp: string): void {
    ctx.hostClock.observe(timestamp);
    if (disposed || !ready || stale || unsupported) return;
    const standing = policyStanding(policy, ctx.hostClock.now());
    if (!standing) return;
    // A preview commit still in flight never lands under the expired policy (its preview ends just below); one the
    // session already applied is journaled there, before the preview would have been cancelled.
    const flight = preview?.commit;
    if (flight && !flight.landed()) flight.abort.abort('revoked');
    stale = standing;
    queueMicrotask(() => {
      if (disposed) return;
      const operationId = internalOp();
      interruptPreview('revoked', operationId, hostActor);
      stopPlayback(operationId, hostActor);
      publish();
    });
  }
  /**
   * Observed display intervals (report §5.1): a grant this process saw displayed ends when none of its groups is in the
   * published projection any more, with the reason; if its groups are published again the end is cleared (the interval
   * is then an envelope from the first display to the last end).
   */
  function trackDisplayIntervals(shown: ReadonlySet<string>): void {
    if (!displayedHere.size) { endCause = null; return; }
    const now = Math.max(0, ctx.clock.monotonic() - ctx.origin);
    const cause: DisplayEndReason = instance.closed ? 'closed' : unsupported || revokedByHost || policy.revoked ? 'revoked' : stale ? 'policy' : independent() ? 'independent' : endCause ?? 'stage';
    for (const exposureId of displayedHere) {
      const record = exposures.get(exposureId);
      if (!record?.displayed) continue;
      const visible = record.groups.some(group => shown.has(group.groupId));
      if (!visible && record.displayed.endedMonotonicMs === undefined) exposures.endDisplay(exposureId, { endedMonotonicMs: now, endedBy: cause });
      else if (visible && record.displayed.endedMonotonicMs !== undefined) exposures.endDisplay(exposureId, null);
    }
    endCause = null;
  }

  // ---- journal ------------------------------------------------------------------------------------------------
  function frameRef(): FrameRef | undefined {
    const { frame, kind } = displayedFrame();
    if (!frame) return undefined;
    const runId = frame.run.kind === 'committed' ? frame.run.runId : frame.run.kind === 'tentative' ? frame.run.baseRunId : null;
    return runId ? { frameId: frame.frameId, runId, kind, position: structuredClone(frame.position) } : undefined;
  }
  type Cause = string | null | undefined;
  function eventOf(type: EventType, payload: Record<string, unknown>, actor: Actor, operationId: string, causes: readonly Cause[]): InteractionEvent {
    const state = session.getState();
    const frame = frameRef();
    return {
      contract: CONTRACTS.event, schemaVersion: ACTIVITY_SCHEMA_VERSION, eventId: newId(), activityId, sequence: outbox.nextSequence(), operationId, actor: { ...actor }, type,
      revisions: {
        scientific: { modelDigest: modelRef.digest, runId: state.run?.id ?? null, version: state.version }, presentation: presentation.revision,
        activity: instance.activityRevision, hostSession: instance.hostSessionRevision, policy: policy.revision,
      },
      ...(frame ? { frame } : {}), payload, monotonicMs: Math.max(0, ctx.clock.monotonic() - ctx.origin),
      causes: [...new Set(causes.filter((cause): cause is string => typeof cause === 'string' && cause.length > 0))].slice(0, 16),
    };
  }
  /**
   * Appends one event (with its causal antecedents) and returns its eventId (null for a coalesced presentation change).
   * A refusal is counted as a journal loss and recorded in the next journaled event; it is never hidden.
   */
  function journal(type: EventType, payload: Record<string, unknown>, actor: Actor, operationId: string, causes: readonly Cause[] = []): { ok: true; eventId: string | null } | { ok: false; diagnostic: Diagnostic } {
    if (disposed) return { ok: false, diagnostic: diag('DISPOSED', '$', 'The activity has been disposed.') };
    if (unrecordedLoss) recordLoss();
    const event = eventOf(type, payload, actor, operationId, causes);
    const result = outbox.append(event);
    if (!result.ok) {
      // Commands check capacity first and system events use the reserve, so a refusal here means evidence could not be
      // recorded: count it, record it in the journal at the next opportunity and surface it.
      noteLoss([type], result.diagnostic);
      return { ok: false, diagnostic: result.diagnostic };
    }
    scheduleFlush();
    return { ok: true, eventId: result.coalesced ? null : event.eventId };
  }
  function emit(type: EventType, payload: Record<string, unknown>, actor: Actor, operationId: string, causes: readonly Cause[] = []): Diagnostic | null {
    const result = journal(type, payload, actor, operationId, causes);
    return result.ok ? null : result.diagnostic;
  }
  /** {@link journal}, returning only the eventId (null when nothing was journaled). */
  function emitted(type: EventType, payload: Record<string, unknown>, actor: Actor, operationId: string, causes: readonly Cause[] = []): string | null {
    const result = journal(type, payload, actor, operationId, causes);
    return result.ok ? result.eventId : null;
  }
  const addLoss = (current: JournalLoss | null, count: number, types: readonly EventType[], afterSequence: number): JournalLoss => current
    ? { count: current.count + count, types: [...new Set([...current.types, ...types])], afterSequence: Math.min(current.afterSequence, afterSequence) }
    : { count, types: [...new Set(types)], afterSequence };
  /** Counts an event the outbox refused; the card shows a recoverable failure until the loss is recorded. */
  function noteLoss(types: readonly EventType[], diagnostic: Diagnostic, count = 1, afterSequence = lastSequence()): void {
    if (!unrecordedLoss) lossCode = diagnostic.code;
    lost = addLoss(lost, count, types, afterSequence);
    unrecordedLoss = addLoss(unrecordedLoss, count, types, afterSequence);
    journalError = diag(diagnostic.code, '$', 'An event could not be recorded in the journal; the loss is recorded as soon as there is room.', 'Restore the host connection and retry persistence.');
    schedulePublish();
  }
  /** Records unrecorded losses as `operation.failed` with `lost` (the next journaled event). Nothing clears a loss silently. */
  function recordLoss(): void {
    if (!unrecordedLoss || recordingLoss || disposed || !journalOpen) return;
    recordingLoss = true;
    try {
      const marker = eventOf('operation.failed', { operation: 'appendEvents', code: lossCode, recoverable: false, lost: structuredClone(unrecordedLoss) }, hostActor, internalOp(), []);
      if (outbox.append(marker).ok) { unrecordedLoss = null; journalError = null; scheduleFlush(); schedulePublish(); }
    } finally { recordingLoss = false; }
  }
  /** Events that ending the active preview and playback would journal (room is reserved only for what will happen). */
  const interruptions = (): EventType[] => [...(preview ? ['preview.observed', 'preview.cancelled'] as const : []), ...(session.getState().playing ? ['playback.paused'] as const : [])];
  /** Fails with PERSISTENCE_BACKPRESSURE before a command when its evidence-bearing events would not fit. */
  function room(...types: EventType[]): Diagnostic | null {
    const needed = types.filter(isEvidenceBearing).length;
    const state = outbox.state();
    // Commands stop at the command capacity; the reserve above it is kept for events recorded without a command.
    return state.pending + needed > commandCapacity(ctx.outboxLimit)
      ? diag('PERSISTENCE_BACKPRESSURE', '$', 'The journal outbox is full; this step was not taken.', 'Wait for saving to catch up, then retry.') : null;
  }
  /** Visible quantities of a frame under the current projection (recorded so summaries can filter by audience). */
  function visibleQuantities(frame: ModelFrame | null, scalarOnly = false): Record<string, QuantityResult> {
    if (!frame) return {};
    const ids = visibleQuantityIds(template, visibility.groups);
    const out: Record<string, QuantityResult> = {};
    for (const id of [...ids].sort()) {
      const result = frame.quantities[id];
      if (!result || scalarOnly && manifest.quantities[id]?.shape.kind !== 'scalar') continue;
      out[id] = structuredClone(result);
    }
    return out;
  }
  const withQuantities = (payload: Record<string, unknown>, quantities: Record<string, QuantityResult>): Record<string, unknown> => {
    if (!Object.keys(quantities).length) return payload;
    const full = { ...payload, visibleQuantities: quantities };
    return fits(full) ? full : payload;
  };

  // ---- command plumbing ---------------------------------------------------------------------------------------
  /** Deduplicates by operation ID and runs `action`; failures from learner/tutor bindings use the learner vocabulary. */
  /** Records refused commands for host diagnostics: operation name, code and the top-level path segment only (no values or IDs). */
  function noteFailure(operation: string, diagnostics: readonly Diagnostic[]): void {
    for (const item of diagnostics.slice(0, 4)) {
      failures.push({ operation, code: item.code, path: /^\$(\.[A-Za-z][A-Za-z0-9]{0,63})?/.exec(item.path)?.[0] ?? '$', monotonicMs: now() });
      if (failures.length > FAILURE_RING) failures.shift();
    }
  }
  /**
   * Coupled constraints whose manifest text a learner or tutor may read now (report §8.2): every parameter the constraint
   * references is a control shown in the current stage, so the text names nothing hidden. Others keep the fixed vocabulary.
   */
  function learnerConstraints(): Record<string, LearnerConstraintText> {
    const shown = new Set(Object.keys(visibility.controls));
    const out: Record<string, LearnerConstraintText> = {};
    for (const constraint of manifest.constraints ?? []) {
      const refs = constraintReferences(constraint);
      if (refs?.length && refs.every(ref => shown.has(ref))) out[constraint.id] = { message: constraint.message, recovery: constraint.recovery };
    }
    return out;
  }
  function command<T>(name: string, actor: Actor, raw: unknown, sanitize: boolean, action: (input: Record<string, unknown>) => T): T | Fail {
    const output = (result: Fail): Fail => {
      noteFailure(name, result.diagnostics);
      return sanitize ? failure(...learnerDiagnostics(result.diagnostics, ['$.operationId', '$.previewId', '$.parameter', '$.scenarioId', '$.position', '$.toStage', '$.groups'], { constraints: learnerConstraints() }))
        : failure(...result.diagnostics);
    };
    if (disposed) return output(failure(diag('DISPOSED', '$', 'This activity has been disposed.', 'Prepare or restore the activity again.')));
    const copy = detach(raw);
    if (!copy.ok || !isRecord(copy.value)) return output(failure(diag('INVALID_INPUT', '$', 'Expected a command object.')));
    const input = copy.value;
    if (typeof input.operationId !== 'string' || !ID.test(input.operationId)) return output(failure(diag('INVALID_INPUT', '$.operationId', 'Provide a bounded operation ID.')));
    const fingerprint = canonicalJSON({ name, actor, input });
    const previous = operations.get(input.operationId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) return output(failure(diag('OPERATION_CONFLICT', '$.operationId', 'This operation ID was already used with different arguments.', 'Use a new operation ID for a different request.')));
      // A transient failure keeps its fingerprint: the identical request runs again (resuming a kept authorization).
      if (previous.forgotten) return output(failure(diag('NOT_FOUND', '$.operationId', 'The outcome of this operation was released when the host forgot the activity\'s cached copies.', 'Use a new operation ID.')));
      if (!previous.retryable) return previous.outcome as T | Fail;
      operations.delete(input.operationId);
    }
    if (operations.size >= OPERATION_CACHE) { const oldest = [...operations].find(([, entry]) => entry.settled); if (oldest) operations.delete(oldest[0]); }
    const entry: OperationEntry = { fingerprint, outcome: undefined, settled: false, retryable: false };
    operations.set(input.operationId, entry);
    const finish = (result: unknown) => {
      entry.settled = true;
      entry.value = result;
      // A `forget` ran while this operation was in flight: the caller still receives its outcome, but no copy is kept.
      const filters = entry.release;
      delete entry.release;
      if (filters && isRecord(result) && result.ok === true && filters.some(holds => holds(result))) {
        entry.forgotten = true;
        entry.outcome = undefined;
        entry.value = undefined;
      }
      if (isRecord(result) && result.ok === false && Array.isArray(result.diagnostics)) {
        const sanitized = output(result as Fail);
        // Transient persistence or disposal failures are not cached: retrying the same operation is legitimate.
        if (sanitized.diagnostics.some(item => ['PERSISTENCE_FAILED', 'PERSISTENCE_PENDING', 'PERSISTENCE_BACKPRESSURE', 'DISPOSED', 'NOT_READY', 'RESOURCE_LIMIT', 'WORKER_ERROR', 'WORKER_TIMEOUT'].includes(item.code))) entry.retryable = true;
        return sanitized;
      }
      return result;
    };
    let result: T;
    try { result = action(input); } catch (error) { const out = finish(failure(...toDiagnostics(error))); entry.outcome = out; return out as Fail; }
    if (result instanceof Promise) {
      const promise = result.then(finish, error => finish(failure(...toDiagnostics(error)))).then(value => disposed && isRecord(value) && value.ok === true ? output(failure(diag('DISPOSED', '$', 'This activity has been disposed.'))) : value);
      entry.outcome = promise;
      return promise as T;
    }
    entry.outcome = finish(result);
    return entry.outcome as T | Fail;
  }
  const ok = (): CommandOutcome => ({ ok: true, projection: publish() });
  function gate(actor: Actor, tool: ToolOperation | null, options: { compute?: boolean } = {}): Diagnostic | null {
    if (disposed) return diag('DISPOSED', '$', 'This activity has been disposed.');
    if (!ready) return diag('NOT_READY', '$', 'The activity is not ready.');
    if (unsupported) return unsupported;
    if (stale) return stale;
    const standing = policyStanding(policy, ctx.hostClock.now());
    if (standing) return blockOnStanding(standing);
    const revoked = revocationDiagnostic(ctx.catalog, templateRef, modelRef);
    if (revoked) { contentRevoked('catalogue', revoked); sanitizeSelection(); schedulePublish(); return revoked; }
    if (instance.closed) return diag('NOT_READY', '$', 'The activity is closed.');
    if (options.compute !== false && suspended()) return diag('NOT_READY', '$', 'The activity is suspended.', 'Resume or show the activity first.');
    if (actor.kind === 'tutor' && tool && !toolPermitted(policy, tool, independent())) return diag('POLICY_DENIED', '$', 'The host policy does not permit this tool operation.');
    visibility = computeVis();
    return null;
  }
  function scientificGuard(input: Record<string, unknown>): Diagnostic | null {
    const version = input.expectedScientificVersion, runId = input.expectedRunId;
    if (!Number.isSafeInteger(version) || runId !== null && typeof runId !== 'string') return diag('INVALID_INPUT', '$', 'Provide expectedScientificVersion and expectedRunId.');
    const state = session.getState();
    return version !== state.version || runId !== (state.run?.id ?? null)
      ? diag('STALE_MODEL_REVISION', '$.expectedScientificVersion', 'The scientific state changed before this command.', 'Read the current projection guards and retry.') : null;
  }
  function activityGuard(input: Record<string, unknown>): Diagnostic | null {
    if (!Number.isSafeInteger(input.expectedActivityRevision) || !Number.isSafeInteger(input.expectedPolicyRevision)) return diag('INVALID_INPUT', '$', 'Provide expectedActivityRevision and expectedPolicyRevision.');
    if (input.expectedPolicyRevision !== policy.revision) return diag('STALE_POLICY_REVISION', '$.expectedPolicyRevision', 'The policy revision changed before this command.', 'Read the current policy revision and retry.');
    if (input.expectedActivityRevision !== instance.activityRevision) return diag('STALE_ACTIVITY_REVISION', '$.expectedActivityRevision', 'The activity revision changed before this command.', 'Read the current activity revision and retry.');
    return null;
  }
  function presentationGuard(input: Record<string, unknown>): Diagnostic | null {
    if (!Number.isSafeInteger(input.expectedPresentationRevision)) return diag('INVALID_INPUT', '$.expectedPresentationRevision', 'Provide expectedPresentationRevision.');
    return input.expectedPresentationRevision !== presentation.revision
      ? diag('STALE_PRESENTATION_REVISION', '$.expectedPresentationRevision', 'The view changed before this command.', 'Read the current presentation revision and retry.') : null;
  }
  const sessionGuard = (): ModelGuard => { const state = session.getState(); return { sessionId: session.id, expectedVersion: state.version, expectedRunId: state.run?.id ?? null, operationId: internalOp() }; };
  const isWorkerFailure = (diagnostics: readonly Diagnostic[]) => diagnostics.some(item => item.code === 'WORKER_ERROR' || item.code === 'WORKER_TIMEOUT');
  /** Records a worker timeout or crash and the operation it interrupted (by default: re-evaluate the shown position). */
  const noteWorker = (diagnostics: Diagnostic[], operation: FailedOperation = { kind: 'refresh' }) => {
    if (!isWorkerFailure(diagnostics)) return;
    workerFailure = true;
    failedOperation = operation;
  };
  /** A successful evaluation ends a worker failure episode. */
  const clearWorkerFailure = () => { workerFailure = false; failedOperation = null; recoveryAttempts = 0; };

  // ---- parameters ---------------------------------------------------------------------------------------------
  /** Converts display-unit entries of permitted controls to canonical units; never clamps or coerces. */
  function canonical(raw: unknown, allowed: (parameter: string) => boolean): { ok: true; values: Record<string, number> } | Fail {
    if (!isRecord(raw) || !Object.keys(raw).length || Object.keys(raw).length > 64) return failure(diag('INVALID_INPUT', '$.displayValues', 'Provide one or more parameter values.'));
    const values: Record<string, number> = {};
    for (const [parameter, value] of Object.entries(raw)) {
      const control = controlsByParameter.get(parameter), definition = manifest.parameters[parameter];
      if (!control || !definition) return failure(diag('INVALID_INPUT', `$.displayValues.${ID.test(parameter) ? parameter : '<redacted-key>'}`, 'Unknown parameter.'));
      if (!allowed(parameter)) return failure(diag('POLICY_DENIED', `$.displayValues.${parameter}`, 'This parameter cannot be changed now.'));
      if (typeof value !== 'number' || !Number.isFinite(value)) return failure(diag('INVALID_INPUT', `$.displayValues.${parameter}`, 'Expected a finite number.'));
      try { values[parameter] = convert(value, controlDisplayUnit(control, presentation), definition.unit); } catch (error) { return failure(...toDiagnostics(error).map(item => ({ ...item, path: `$.displayValues.${parameter}` }))); }
    }
    return { ok: true, values };
  }
  const check = (params: Record<string, number>): Fail | null => {
    const problems = checkParameters(manifest, params);
    return problems.length ? failure(...fromModelDiagnostics(problems)) : null;
  };

  // ---- preview ------------------------------------------------------------------------------------------------
  /** The exploration grant authorizing live tentative output for `parameter` in the current stage, if any. */
  function explorationGrant(parameter: string): ExposureRecord | null {
    const control = controlsByParameter.get(parameter);
    if (!control) return null;
    const required = [control.group, ...template.groups.filter(group => group.solutionBearing && visibility.groups[group.id] !== 'absent').map(group => group.id)];
    return exposures.current().find(record => record.scope === 'exploration' && record.intendedStage === instance.stage.id && record.displayStatus !== 'not-displayed'
      && record.template.digest === templateRef.digest && record.model.digest === modelRef.digest
      && required.every(id => record.groups.some(group => group.groupId === id && group.contentDigest === digests[id]))
      && (!record.parameterDomain || Object.hasOwn(record.parameterDomain, parameter))) ?? null;
  }
  /** Selects first, last and evenly spaced samples and fits the payload into the 8 KiB event bound. */
  function observedPayload(track: PreviewTrack, outcome: 'committed' | 'cancelled' | 'interrupted'): Record<string, unknown> {
    const all = track.rendered;
    const picks = all.length <= PREVIEW_SAMPLE_LIMIT ? all.map((_, index) => index)
      : [...new Set(Array.from({ length: PREVIEW_SAMPLE_LIMIT }, (_, i) => Math.round(i * (all.length - 1) / (PREVIEW_SAMPLE_LIMIT - 1))))];
    let rendered = picks.map(index => ({ params: all[index]!.params, frameId: all[index]!.frameId, ...(Object.keys(all[index]!.visibleQuantities).length ? { visibleQuantities: all[index]!.visibleQuantities } : {}) }));
    let policyText = 'first, last and evenly spaced rendered values (at most 20)';
    let omitted = all.length - rendered.length + track.dropped;
    const visibleParameters = shownParameters();
    const payload = () => ({ previewId: track.previewId, outcome, samplingPolicy: policyText, rendered, omitted, visibleParameters });
    if (!fits(payload())) {
      rendered = rendered.map(({ params, frameId }) => ({ params, frameId }));
      policyText = 'first, last and evenly spaced rendered values (at most 20); per-sample values omitted to fit the event size';
    }
    while (!fits(payload()) && rendered.length > 2) { rendered.splice(Math.floor(rendered.length / 2), 1); omitted++; }
    return payload();
  }
  /** Parameters shown as controls right now (recorded with commits and previews so restricted summaries can filter: G12). */
  const shownParameters = (): string[] => Object.keys(visibility.controls).sort();
  /**
   * Sends the newest preview value to the session (report §18, D11: one active evaluation plus one newest pending value).
   * At most one submission is outstanding; values accepted meanwhile only replace `track.params`, and the newest one is
   * sent when the outstanding submission settles. A burst of updates therefore never grows the session's pending
   * operations (its 64-operation window) and the painted tentative frame always converges to the newest value. A session
   * refusal is never dropped: a worker failure enters worker recovery; any other refusal keeps the last evaluated frame,
   * sets a learner-safe notice and is resent with the next update.
   */
  function pumpPreview(track: PreviewTrack): void {
    if (track.inFlight || track.refused || track.closing || disposed || preview !== track || !track.params) return;
    if (track.submitted !== null && sameJSON(track.submitted, track.params)) return;
    const params = track.params;
    track.inFlight = true;
    track.submitted = params;
    track.submittedAt = now();
    let submission: Promise<unknown>;
    try { submission = session.previewParameters(track.previewId, params, sessionGuard()); } catch (error) { submission = Promise.reject(error); }
    submission.then(state => {
      if (!disposed && state && (state as { status?: unknown }).status === 'ready') measure('preview', track.submittedAt);
    }, error => {
      if (disposed || preview !== track) return;
      const diagnostics = toDiagnostics(error);
      if (diagnostics.every(item => item.code === 'CANCELLED' || item.code === 'DISPOSED')) return;
      if (isWorkerFailure(diagnostics)) { noteWorker(diagnostics, { kind: 'preview', previewId: track.previewId }); return; }
      track.refused = true;
      track.submitted = null;
      notice = PREVIEW_REFUSED_NOTICE;
    }).finally(() => {
      track.inFlight = false;
      if (disposed || preview !== track) return;
      pumpPreview(track);
      schedulePublish();
    });
  }
  /** Ends the active preview in the journal (observed + optional cancelled); the session preview is ended by the caller. */
  function endPreview(outcome: 'committed' | 'cancelled' | 'interrupted', reason: 'escape' | 'pointercancel' | 'blur' | 'navigation' | 'revoked' | 'superseded' | null, operationId: string, actor: Actor): void {
    const track = preview;
    if (!track) return;
    preview = null;
    notice = null;
    emit('preview.observed', observedPayload(track, outcome), actor, operationId, [track.startedEventId]);
    if (reason) emit('preview.cancelled', { previewId: track.previewId, reason }, actor, operationId, [track.startedEventId]);
  }
  /**
   * Cancels any active preview (session and journal) for navigation, suspension, revocation or context changes. A preview
   * whose commit is in flight is settled first: a commit the session already applied is journaled and the preview ends
   * committed (it happened before this change); otherwise its commit is aborted, so it never lands after the change.
   */
  function interruptPreview(reason: 'blur' | 'navigation' | 'revoked', operationId: string, actor: Actor): void {
    if (!preview) return;
    if (settleClosingCommit()) return;
    preview?.commit?.abort.abort(reason);
    try { if (session.getState().preview) session.cancelPreview(sessionGuard()); } catch { /* The session may already be suspended or disposed. */ }
    endPreview('interrupted', reason, operationId, actor);
  }
  /**
   * Called before any change that can take a preview's authorization away: when the session has already applied the
   * active preview's in-flight commit, that commit is journaled now — before the change — and the preview ends committed.
   * Returns true when it did. A commit not applied yet is left to the re-validation after the change (`CommitFlight`).
   */
  function settleClosingCommit(): boolean {
    const flight = preview?.commit;
    if (!flight || !flight.landed()) return false;
    flight.journal();
    return true;
  }
  function stopPlayback(operationId: string, actor: Actor): void {
    const state = session.getState();
    if (!state.playing) return;
    playbackActor = null;
    try { session.pause(sessionGuard()); } catch { /* Suspension or disposal already stopped it. */ }
    emit('playback.paused', { runId: state.run!.id, position: structuredClone(session.getState().frame?.position ?? state.frame!.position) }, actor, operationId);
  }
  /**
   * Whether the active preview is still authorized (report §6.3, A24; activity-runtime §4, §11): the stage and context
   * it began in, a stage that allows preview, interactive controls for every value it changes and an exploration grant
   * that covers every visible solution-bearing group now (a group revealed since needs a new authorization).
   */
  function previewAuthorized(track: PreviewTrack): boolean {
    visibility = computeVis();
    const base = session.getState().run?.params ?? {};
    return track.stageId === instance.stage.id && track.context === instance.context.kind && stage().allowsPreview
      && visibility.controls[track.parameter] === 'interactive' && explorationGrant(track.parameter) !== null
      && Object.entries(track.params ?? {}).every(([parameter, value]) => base[parameter] === value || visibility.controls[parameter] === 'interactive');
  }
  /**
   * Ends the active preview when a stage, context, policy or grant change took its authorization away: it is journaled
   * `preview.cancelled` and commits nothing (activity-runtime §11). A preview that is still authorized continues.
   */
  function revalidatePreview(reason: 'navigation' | 'revoked', operationId: string, actor: Actor): void {
    const track = preview;
    if (!track || previewAuthorized(track)) return;
    interruptPreview(track.stageId !== instance.stage.id || track.context !== instance.context.kind ? 'navigation' : reason, operationId, actor);
  }
  /**
   * A policy found revoked or expired by a check blocks the activity at once (activity-runtime §1): the card shows the
   * stale policy, any preview or playback ends and an invalid selection is cleared.
   */
  function blockOnStanding(standing: Diagnostic): Diagnostic {
    stale = standing;
    if (ready && journalOpen && !disposed) {
      const operationId = internalOp();
      interruptPreview('revoked', operationId, hostActor);
      stopPlayback(operationId, hostActor);
    }
    sanitizeSelection();
    schedulePublish();
    return standing;
  }
  /**
   * Standing of the activity at a read (report §5.3, activity-runtime §1): host or policy revocation, catalogue revocation,
   * or a policy that host time shows expired — found at the read, it blocks the activity at once, as a command would.
   * Null while the current policy stands.
   */
  function readStanding(): Diagnostic | null {
    if (disposed || !ready) return null;
    if (unsupported) return unsupported;
    if (stale) return stale;
    const revoked = revocationDiagnostic(ctx.catalog, templateRef, modelRef);
    if (revoked) { contentRevoked('catalogue', revoked); sanitizeSelection(); publish(); return revoked; }
    const standing = policyStanding(policy, ctx.hostClock.now());
    if (!standing) return null;
    blockOnStanding(standing);
    publish();
    return standing;
  }
  /**
   * Navigation and playback are content of the position groups (activity-runtime §3): commands are accepted only where
   * the projection offers them (`navigationVisibility` interactive), so an independent context accepts them only when the
   * neutral scaffold keeps a position group.
   */
  function navigationRefusal(): Diagnostic | null {
    if (navigationVisibility(template, manifest, visibility.groups, instance.context.kind) === 'interactive') return null;
    return independent() ? diag('INDEPENDENT_CONTEXT', '$', 'Navigation and playback are not part of the neutral scaffold of this independent task.')
      : diag('POLICY_DENIED', '$', 'Navigation is not available now.');
  }

  // ---- session observation ------------------------------------------------------------------------------------
  let wasPlaying = false;
  session.subscribe(event => {
    if (disposed) return;
    const state = event.state;
    const track = preview;
    // Every new tentative frame the session holds is displayed by the next projection (a superseded evaluation still
    // replaces the previous frame), so each one counts as a rendered value.
    if (track && state.preview?.previewId === track.previewId && state.preview.frame) {
      const frame = state.preview.frame;
      if (track.rendered.at(-1)?.frameId !== frame.frameId) {
        if (track.rendered.length >= RENDERED_CAP) { track.rendered.splice(1, 1); track.dropped++; }
        track.rendered.push({ params: { ...frame.params }, frameId: frame.frameId, visibleQuantities: visibleQuantities(frame, true) });
      }
    }
    if (wasPlaying && !state.playing && playbackActor) {
      const actor = playbackActor;
      playbackActor = null;
      // Why playback stopped by itself (report §8.4 terminal/numerical-limit events): the exact end, one step before a
      // value that cannot be represented (the limit frame stays reachable by stepping), or a failed evaluation.
      const reason = state.error?.some(item => item.code === 'NUMERICAL_LIMIT') ? 'numerical-limit' : event.type === 'error' || state.stale ? 'error' : 'terminal';
      // The notice says playback stopped *before* the limit; where it stopped at a limit frame already (a limit that
      // became shown while playback was crossing it), the end text of that frame says so instead.
      if (reason === 'numerical-limit' && limitAhead && state.frame?.terminal.event !== 'numerical-limit') { playbackNotice = PLAYBACK_LIMIT_NOTICE; playbackLimit = limitAhead; }
      limitAhead = null;
      if (state.frame && state.run) emit('playback.ended', { runId: state.run.id, position: structuredClone(state.frame.position), reason }, actor, internalOp());
    }
    wasPlaying = state.playing;
    if (event.type === 'error' && state.error) noteWorker(fromModelDiagnostics(state.error));
    schedulePublish();
  });

  // ---- commits ------------------------------------------------------------------------------------------------
  /**
   * Commits `params` through the session and journals `parameters.committed`. `track` is the preview being committed
   * (`commitPreview`): its commit is registered as a {@link CommitFlight}, so a change that takes the preview's
   * authorization away while the session evaluates either journals the already-applied commit first or aborts it.
   */
  async function commit(params: Record<string, number>, cause: 'commit' | 'reset' | 'scenario', actor: Actor, operationId: string, extra: Record<string, unknown>, causes: readonly Cause[] = [], track?: PreviewTrack): Promise<CommandOutcome> {
    const before = session.getState();
    const invalid = check(params);
    if (invalid) return invalid;
    const full = room('parameters.committed');
    if (full) return failure(full);
    stopPlayback(operationId, actor);
    const startedAt = now();
    let journaled = false;
    const journal = (): void => {
      if (journaled || disposed) return;
      journaled = true;
      measure('commit', startedAt);
      clearWorkerFailure();
      restored = false;
      playbackNotice = null;
      const after = session.getState();
      visibility = computeVis();
      emit('parameters.committed', withQuantities({
        runId: after.run!.id, previousRunId: before.run?.id ?? null, params: { ...after.run!.params }, cause, ...extra, visibleParameters: shownParameters(),
      }, visibleQuantities(after.frame)), actor, operationId, causes);
      // The committed preview ends in the same step, so nothing can interrupt it between its commit and its end.
      if (track && preview === track) endPreview('committed', null, operationId, actor);
    };
    let signal = lifetime.signal;
    let release = (): void => undefined;
    if (track) {
      // The preview's own abort, also aborted when the activity is disposed.
      const abort = new AbortController();
      const onDisposed = () => abort.abort();
      if (lifetime.signal.aborted) abort.abort(); else lifetime.signal.addEventListener('abort', onDisposed, { once: true });
      release = () => lifetime.signal.removeEventListener('abort', onDisposed);
      signal = abort.signal;
      track.commit = { abort, landed: () => !journaled && session.getState().run?.id !== before.run?.id, journal };
    }
    try { await session.commitParameters(params, sessionGuard(), cause, signal); } catch (error) {
      release();
      if (disposed) return failure(diag('DISPOSED', '$', 'This activity has been disposed.'));
      const diagnostics = toDiagnostics(error);
      // An aborted preview commit was refused on purpose (its preview ended); it is not a worker failure to recover.
      if (!signal.aborted) noteWorker(diagnostics, { kind: 'commit', params: { ...params }, cause, extra: structuredClone(extra) });
      publish();
      return failure(...diagnostics);
    }
    release();
    if (disposed) return failure(diag('DISPOSED', '$', 'This activity has been disposed.'));
    journal();
    return ok();
  }

  // ---- display acknowledgement --------------------------------------------------------------------------------
  function persistAck(record: ExposureRecord): void {
    if (ackInFlight.has(record.exposureId) || !record.displayed) return;
    ackInFlight.add(record.exposureId);
    const request = { activityId, exposureId: record.exposureId, receiptId: record.receiptId, projectionDigest: record.displayed.projectionDigest, frameId: record.displayed.frameId, monotonicMs: record.displayed.monotonicMs };
    Promise.resolve().then(() => host.recordDisplayAck(request)).then(ack => {
      ackInFlight.delete(record.exposureId);
      if (disposed) return;
      ctx.hostClock.observe(ack?.hostTimestamp);
      exposures.ackPersisted(record.exposureId);
      schedulePublish();
    }, error => {
      ackInFlight.delete(record.exposureId);
      if (disposed) return;
      if (isHostRefusal(error)) {
        // The host decided not to record this acknowledgement: the display happened and stays recorded locally, the
        // request is not repeated, and no uncertainty is invented for a definite answer.
        exposures.ackRefused(record.exposureId);
        emit('operation.failed', { operation: 'recordDisplayAck', code: error.code, recoverable: false }, hostActor, internalOp());
        schedulePublish();
        return;
      }
      const current = exposures.get(record.exposureId);
      if (current && current.uncertainty?.code !== 'ACK_NOT_PERSISTED') {
        const reason = 'The display was acknowledged locally but the host has not persisted the acknowledgement; it will be retried.';
        exposures.markUncertain(record.exposureId, { code: 'ACK_NOT_PERSISTED', reason });
        emit('reveal.uncertain', { exposureId: record.exposureId, receiptId: record.receiptId, code: 'ACK_NOT_PERSISTED', reason }, hostActor, internalOp(), [authorizedEvents.get(record.exposureId)]);
      }
      schedulePublish();
    });
  }
  function acknowledge(actor: Actor, raw: unknown): void {
    if (disposed || !ready) return;
    const copy = detach(raw);
    if (!copy.ok || !isRecord(copy.value)) return;
    const { projectionId, projectionDigest, surfaceId } = copy.value;
    if (typeof projectionId !== 'string' || typeof projectionDigest !== 'string' || typeof surfaceId !== 'string') return;
    if (surfaces.get(surfaceId) !== true || suspended() || instance.closed) return;
    const shown = published.find(entry => entry.projectionId === projectionId && entry.digest === projectionDigest);
    if (!shown || shown.frameId === null) return;
    const operationId = internalOp();
    const monotonicMs = Math.max(0, ctx.clock.monotonic() - ctx.origin);
    for (const record of exposures.awaitingDisplay()) {
      if (!record.groups.every(group => shown.groups.has(group.groupId) && digests[group.groupId] === group.contentDigest)) continue;
      if (record.scope === 'exploration' && shown.frameKind !== 'tentative') continue;
      const displayed = exposures.markDisplayed(record.exposureId, { projectionDigest, frameId: shown.frameId, monotonicMs });
      if (!displayed) continue;
      displayedHere.add(record.exposureId);
      emit('reveal.displayed', { exposureId: record.exposureId, receiptId: record.receiptId, projectionDigest, frameId: shown.frameId, surfaceId }, actor, operationId, [authorizedEvents.get(record.exposureId)]);
      persistAck(displayed);
    }
    if (pendingReveal?.state === 'awaiting-display' && !exposures.awaitingDisplay().some(record => record.scope !== 'exploration')) pendingReveal = null;
    schedulePublish();
  }

  // ---- host authorization protocol ----------------------------------------------------------------------------
  /**
   * Before a transition, reveal, assistance request or close every journaled event must be acknowledged. Batches still in
   * flight are awaited for at most `persistenceWaitMs`; the step is then refused with PERSISTENCE_PENDING at once and the
   * card shows the awaiting-persistence state until the journal is saved (report §7.2: the work pauses with a recovery
   * path; the host repeats it with the same operation ID), instead of waiting silently for the host call timeout.
   */
  function flushFirst(): Promise<Diagnostic | null> {
    return outbox.requireFlushed(ctx.persistenceWaitMs).then(() => null, error => {
      if (disposed) return diag('DISPOSED', '$', 'This activity has been disposed.');
      const diagnostic = isPersistenceError(error) ? error.diagnostic : diag('PERSISTENCE_PENDING', '$', 'Journal events are not yet acknowledged.', 'Retry persistence, then repeat the operation.');
      if (diagnostic.code === 'PERSISTENCE_PENDING' && outbox.state().pending > 0) { awaitingFlush = true; publish(); }
      return diagnostic;
    });
  }
  /**
   * The failed authorization a re-issued command resumes: same command and operation ID, and nothing changed since
   * (context epoch, activity and policy revisions). The identical host request is resent, so the host's idempotency key
   * replays a receipt it may already have committed, and no second `reveal.requested` is journaled.
   */
  function resumable(origin: string, operationId: string): PendingAuthorization | null {
    const entry = pending;
    if (!entry || entry.state !== 'failed' || entry.origin !== origin || entry.operationId !== operationId) return null;
    if (entry.epoch !== revealEpoch || entry.revision !== instance.activityRevision || entry.basedOn.policy !== policy.revision) return null;
    return entry;
  }
  /** Recovery text naming a method the caller of the failed authorization actually has. */
  const resumeRecovery = (entry: PendingAuthorization): string => entry.origin === 'requestHelp'
    ? 'Call retryPersistence, or repeat requestHelp with the same operation ID; the same request is resent without a new request record.'
    : `Repeat ${entry.origin} with the same operation ID (or call retryPersistence on the learner binding); the same request is resent without a new request record.`;
  async function authorize(entry: PendingAuthorization): Promise<CommandOutcome> {
    pending = entry;
    entry.state = 'requesting';
    if (entry.groups.length) pendingReveal = { labels: entry.labels, state: 'requesting' };
    publish();
    let receipt: unknown;
    try { receipt = await entry.call(); } catch (error) {
      if (disposed) return failure(diag('DISPOSED', '$', 'This activity has been disposed.'));
      if (pending !== entry || entry.epoch !== revealEpoch) return failure(diag('STALE_ACTIVITY_REVISION', '$', 'The request was superseded.'));
      if (isHostRefusal(error) && error.code === 'INVALID_INPUT' && entry.renew) return renew(entry);
      if (isHostRefusal(error)) return refused(entry, error.code);
      entry.state = 'failed';
      if (entry.groups.length) pendingReveal = { labels: entry.labels, state: 'failed' };
      emit('operation.failed', { operation: hostOperation(entry), code: 'PERSISTENCE_FAILED', recoverable: true }, entry.actor, entry.operationId);
      publish();
      return failure(diag('PERSISTENCE_FAILED', '$', 'The host did not record the authorization; nothing new was shown.', resumeRecovery(entry)));
    }
    if (disposed) return failure(diag('DISPOSED', '$', 'This activity has been disposed.'));
    const discard = (diagnostic: Diagnostic): CommandOutcome => {
      if (pending === entry) { pending = null; pendingReveal = null; }
      publish();
      return failure(diagnostic);
    };
    // The receipt is verified even when it arrives late: a receipt that binds this request is a host commitment, kept as
    // history below; one that does not bind it is discarded (nothing is applied).
    const verdict = verifyReceipt(receipt, { ...entry.expectation, hostNow: ctx.hostClock.now() } as ReceiptExpectation, usedReceipts, exposures.receiptOf);
    if (!verdict.ok) {
      if (verdict.history) { ctx.hostClock.observe(verdict.history.issuedAt); keepHistory(entry, verdict.history); }
      if (verdict.refreshPolicy) await refreshPolicy();
      return discard(verdict.diagnostic);
    }
    ctx.hostClock.observe(verdict.receipt.issuedAt);
    if (pending !== entry || entry.epoch !== revealEpoch) {
      keepHistory(entry, verdict.receipt);
      return discard(diag('STALE_ACTIVITY_REVISION', '$', 'The context changed while the host was answering; the host\'s authorization is kept as history and nothing new was shown.'));
    }
    if (instance.activityRevision !== entry.revision || policy.revision !== entry.basedOn.policy) {
      keepHistory(entry, verdict.receipt);
      return discard(diag('STALE_ACTIVITY_REVISION', '$', 'The activity changed while the host was answering; the host\'s authorization is kept as history and nothing new was shown.'));
    }
    // A resumption must replay exactly the host-held grant it resumes.
    if (entry.resume && (verdict.receipt.receiptId !== entry.resume.receiptId || verdict.receipt.grant?.exposureId !== entry.resume.exposureId)) {
      keepHistory(entry, verdict.receipt);
      return discard(diag('RECEIPT_MISMATCH', '$.receipt.grant', 'The host receipt does not replay the authorization this request resumes; nothing was shown.', 'Retry the request with a new operation ID.'));
    }
    // Standing is checked again after the host answered and before anything is applied (report §5.3): a policy that
    // expired, or content that was revoked while the request was in flight, is never revealed.
    const standing = hostGate({}, false);
    if (standing) { keepHistory(entry, verdict.receipt); return discard(standing); }
    let applied: Diagnostic | null;
    // A preview commit the session applied before this receipt is journaled first; one still in flight is re-validated
    // after the receipt is applied (the projection published below) and aborted if no longer authorized.
    settleClosingCommit();
    // Everything `apply` needs was verified above; `pending` is cleared whatever happens, so no step can stay wedged.
    try { applied = entry.apply(verdict.receipt); } catch { applied = diag('RECEIPT_MISMATCH', '$.receipt', 'The host receipt could not be applied; nothing new was shown.', 'Retry the request with a new operation ID.'); } finally { if (pending === entry) pending = null; }
    if (applied) return discard(applied);
    pendingReveal = exposures.awaitingDisplay().some(record => record.scope !== 'exploration') && entry.groups.length ? { labels: entry.labels, state: 'awaiting-display' } : null;
    return ok();
  }
  /**
   * The host refused a resumption (its decision against that exact request: the operation is not the one that produced
   * the held grant). Nothing was recorded, so the held grant stays history and the request is sent anew, with the same
   * operation ID and the host's current revision, after the same standing checks.
   */
  async function renew(entry: PendingAuthorization): Promise<CommandOutcome> {
    entry.refusal = 'INVALID_INPUT';
    if (entry.resume) resumes.delete(entry.resume.exposureId);
    if (pending === entry) { pending = null; pendingReveal = null; }
    const blocked = hostGate({}, false);
    if (blocked) { publish(); return failure(blocked); }
    return authorize(entry.renew!());
  }
  /** {@link PendingAuthorization.history}: follows the host-owned revision and keeps the receipt's records as history. */
  function keepHistory(entry: PendingAuthorization, receipt: unknown): void {
    if (disposed) return;
    // The host may have moved the stage (`history`): a preview commit already applied is journaled first, and a preview
    // the move no longer authorizes ends at once, so a commit still in flight cannot land in the host's new stage.
    settleClosingCommit();
    entry.history(receipt);
    if (ready && journalOpen) revalidatePreview('revoked', internalOp(), hostActor);
    sanitizeSelection();
    schedulePublish();
  }
  /** Follows a host-owned activity revision carried by a verified receipt (never backwards). */
  const followRevision = (revision: number): void => { if (revision > instance.activityRevision) instance = { ...instance, activityRevision: revision }; };
  const hostOperation = (entry: PendingAuthorization): string => entry.kind === 'stage' ? 'requestStageTransition' : entry.kind === 'assistance' ? 'recordAssistance' : 'recordExposureIntent';
  /**
   * A host refusal ends the request (activity-runtime §10): nothing stays pending, nothing is retried and no uncertainty
   * is recorded, because the host decided and recorded nothing. A policy refusal also refreshes the policy, so a newer
   * revision or a revocation is reflected at once.
   */
  async function refused(entry: PendingAuthorization, code: HostRefusalCode): Promise<CommandOutcome> {
    entry.refusal = code;
    if (pending === entry) { pending = null; pendingReveal = null; }
    emit('operation.failed', { operation: hostOperation(entry), code, recoverable: false }, entry.actor, entry.operationId);
    if (code !== 'INVALID_INPUT') await refreshPolicy();
    if (disposed) return failure(diag('DISPOSED', '$', 'This activity has been disposed.'));
    publish();
    return failure(hostRefusalDiagnostic(code));
  }
  async function refreshPolicy(): Promise<void> {
    try {
      const next = await host.getPolicy({ activityId });
      if (disposed || policyDiagnostics(next).length || next.revision <= policy.revision) return;
      applyPolicy(next);
      // A preview the newer policy no longer authorizes ends now (with a commit in flight, before it can land).
      if (ready && journalOpen) revalidatePreview('revoked', internalOp(), hostActor);
    } catch { /* The next command retries with the stale revision and fails again. */ }
  }
  function applyPolicy(next: HostPolicy): void {
    // A preview commit the session applied under the previous policy is journaled before the policy changes.
    if (ready && journalOpen) settleClosingCommit();
    ctx.hostClock.observe(next.issuedAt);
    policy = structuredClone(next);
    instance = { ...instance, policy: { policyId: policy.policyId, revision: policy.revision }, allowedActions: allowedActions() };
    // A host revocation is terminal: a later policy cannot silently reactivate the activity.
    stale = revokedByHost ?? policyStanding(policy, ctx.hostClock.now()) ?? modeDiagnostic(instance.mode, policy, ctx.catalog, templateRef, modelRef);
    if (stale?.code === 'CONTENT_REVOKED') { const revoked = stale; stale = null; contentRevoked('catalogue', revoked); }
    // A revoked policy, or one that no longer approves this exact content, revokes the activity's content (journaled once).
    else if (!revokedByHost && stale?.code === 'POLICY_DENIED') contentRevoked('policy', stale);
  }
  /**
   * The activity's content became unavailable: `content.revoked` is journaled once per source (host revoke, a revoking or
   * denying policy, catalogue revocation), any preview and playback end, and the projection blocks every group.
   */
  function contentRevoked(source: 'host' | 'policy' | 'catalogue', diagnostic: Diagnostic, reason?: string, operationId = internalOp()): void {
    if (source === 'catalogue' && !unsupported) unsupported = diagnostic;
    if (disposed || revokedSources.has(source)) { schedulePublish(); return; }
    revokedSources.add(source);
    if (ready && journalOpen) {
      interruptPreview('revoked', operationId, hostActor);
      stopPlayback(operationId, hostActor);
      emit('content.revoked', { source, code: diagnostic.code, ...(reason ? { reason } : {}) }, hostActor, operationId);
    }
    schedulePublish();
  }
  const allowedActions = (): ToolOperation[] => [...(independent() ? policy.independentTask.permittedTools : policy.allowedTools)];
  const labelsOf = (groups: readonly GroupDigest[]): string[] => groups.map(group => groupsById.get(group.groupId)?.label ?? group.groupId);
  const fingerprintOf = (request: unknown): string => canonicalJSON(request);
  function recordGrant(receiptId: string, grant: ExposureGrant | null, intendedStage: string, activityRevision: number, actor: Actor, operationId: string, causes: readonly Cause[] = [], options: { history?: boolean } = {}): void {
    if (!grant) return;
    const record = exposures.authorize({ activityId, receiptId, grant, intendedStage, activityRevision, template: templateRef, model: modelRef }, options);
    const eventId = emitted(grant.scope === 'exploration' ? 'exposure.scope-authorized' : 'reveal.authorized', {
      exposureId: record.exposureId, receiptId, scope: grant.scope, groups: grant.groups.map(group => ({ ...group })), activityRevision,
      ...(grant.parameterDomain ? { parameterDomain: structuredClone(grant.parameterDomain) } : {}),
    }, actor, operationId, causes);
    if (eventId) authorizedEvents.set(record.exposureId, eventId);
  }
  function sanitizeSelection(): void {
    if (presentation.selection === null) return;
    const vis = computeVis();
    const visibleIds = new Set<string>([...template.views.filter(view => vis.groups[view.group] !== 'absent').map(view => view.id), ...Object.keys(vis.controls),
      ...visibleQuantityIds(template, vis.groups)]);
    for (const view of template.views) for (const mark of view.marks) if (vis.groups[mark.group] !== 'absent') visibleIds.add(mark.id);
    if (!visibleIds.has(presentation.selection)) presentation = { ...presentation, revision: presentation.revision + 1, selection: null };
  }
  /** What `select` may target in a projection: its views, marks, displayed quantities and controls. */
  const selectable = (shown: LearnerProjection): Set<string> =>
    new Set([...shown.views.flatMap(view => [view.viewId, ...view.marks.map(mark => mark.markId), ...view.values.map(item => item.quantityId)]), ...shown.controls.map(item => item.parameter)]);
  /** Groups of `ids` that need a receipt: solution-bearing, permitted by stage and policy, not yet covered. */
  function revealable(ids: unknown): { ok: true; groups: GroupDigest[] } | Fail {
    if (!Array.isArray(ids) || !ids.length || ids.length > 64 || ids.some(id => typeof id !== 'string')) return failure(diag('INVALID_INPUT', '$.groups', 'Provide one or more group IDs.'));
    const current = stage(), ceiling = new Set(policy.visibleGroups);
    visibility = computeVis();
    const out: GroupDigest[] = [];
    for (const id of new Set(ids as string[])) {
      const group = groupsById.get(id);
      if (!group) return failure(diag('INVALID_REFERENCE', '$.groups', 'Unknown content group.'));
      if (!Object.hasOwn(current.visible, id) || !ceiling.has(id)) return failure(diag('POLICY_DENIED', '$.groups', 'The current stage or policy does not permit this group.'));
      if (independent() && !policy.independentTask.neutralScaffold.includes(id)) return failure(diag('INDEPENDENT_CONTEXT', '$.groups', 'Only the neutral scaffold may be shown during independent work.'));
      if (reopenRequired && group.solutionBearing) return failure(diag('INDEPENDENT_CONTEXT', '$.groups', 'Instructional content waits until the host reopens instructional work.', 'Reopen instructional work through the host (reopenInstructional) first.'));
      if (group.solutionBearing && visibility.groups[id] === 'absent') out.push({ groupId: id, contentDigest: digests[id]! });
    }
    return { ok: true, groups: out };
  }
  function receiptBase(operationId: string) {
    return { activityId, idempotencyKey: operationId, basedOnActivityRevision: instance.activityRevision, policy: { policyId: policy.policyId, revision: policy.revision }, template: templateRef, model: modelRef, hostNow: null };
  }

  // ---- learner/tutor binding ----------------------------------------------------------------------------------
  function binding(actorKind: ActorKind, bindingId: string): ActivityBinding {
    if (!['learner', 'tutor', 'host'].includes(actorKind)) throw new RangeError('Unknown actor kind.');
    if (typeof bindingId !== 'string' || !ID.test(bindingId)) throw new RangeError('Invalid binding ID.');
    const actor: Actor = Object.freeze({ kind: actorKind, binding: bindingId });
    const run = <T>(name: string, raw: unknown, action: (input: Record<string, unknown>) => T) => command(name, actor, raw, true, action);
    const sync = (name: string, raw: unknown, action: (input: Record<string, unknown>) => CommandOutcome): CommandOutcome => run(name, raw, action) as CommandOutcome;
    const async = (name: string, raw: unknown, action: (input: Record<string, unknown>) => Promise<CommandOutcome>): Promise<CommandOutcome> => Promise.resolve(run(name, raw, action));
    const scientific = (input: Record<string, unknown>, tool: ToolOperation): Diagnostic | null => gate(actor, tool) ?? scientificGuard(input);
    const presentationCommand = (name: string, raw: unknown, apply: (input: Record<string, unknown>) => Diagnostic | Record<string, unknown>): CommandOutcome => sync(name, raw, input => {
      const blocked = gate(actor, 'operate.presentation', { compute: false }) ?? presentationGuard(input);
      if (blocked) return failure(blocked);
      const result = apply(input);
      if ('code' in result && typeof result.code === 'string' && 'message' in result) return failure(result as Diagnostic);
      presentation = { ...presentation, revision: presentation.revision + 1 };
      emit('view.changed', { ...(result as Record<string, unknown>), presentationRevision: presentation.revision }, actor, input.operationId as string);
      return ok();
    });
    const projectedView = (viewId: unknown) => typeof viewId === 'string' ? template.views.find(view => view.id === viewId && visibility.groups[view.group] !== 'absent') ?? null : null;

    return Object.freeze({
      activityId,
      actor: actorKind,
      getProjection: () => projection,
      subscribe(listener: (projection: LearnerProjection) => void) {
        if (typeof listener !== 'function') throw new TypeError('Expected a listener function.');
        if (disposed) return () => undefined;
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
      beginPreview: raw => sync('beginPreview', raw, input => {
        const blocked = scientific(input, 'operate.parameters');
        if (blocked) return failure(blocked);
        const parameter = input.parameter, gesture = input.gesture as GestureKind;
        if (typeof parameter !== 'string' || !controlsByParameter.has(parameter)) return failure(diag('INVALID_INPUT', '$.parameter', 'Unknown parameter.'));
        if (!['pointer', 'keyboard', 'exact', 'drag'].includes(gesture as string)) return failure(diag('INVALID_INPUT', '$.gesture', 'Unknown gesture.'));
        if (preview) return failure(diag('PREVIEW_ACTIVE', '$.previewId', 'A preview is already active.'));
        // A stage, reveal, exploration or assistance authorization awaiting the host may change what this preview would
        // show (report §6.3): live preview waits until the host has answered.
        if (pending?.state === 'requesting') return failure(diag('PERSISTENCE_PENDING', '$', 'An authorization is awaiting the host; live preview starts after it.', 'Wait until the host answers, then start the preview again.'));
        if (!stage().allowsPreview || visibility.controls[parameter] !== 'interactive') return failure(diag('POLICY_DENIED', '$.parameter', 'Live preview is not available for this control now.'));
        const grant = explorationGrant(parameter);
        if (!grant) return failure(diag('POLICY_DENIED', '$.parameter', 'Live preview needs an authorized exploration scope.', 'Ask the host to authorize exploration for this stage.'));
        const full = room('preview.started', 'preview.observed', 'preview.cancelled');
        if (full) return failure(full);
        stopPlayback(input.operationId as string, actor);
        const state = session.getState();
        preview = {
          previewId: newId(), parameter, gesture, stageId: instance.stage.id, context: instance.context.kind, baseRunId: state.run!.id, actor, operationId: input.operationId as string,
          domain: grant.parameterDomain ? structuredClone(grant.parameterDomain) : null, params: null, rendered: [], dropped: 0, clamped: false,
          refused: false, closing: false, inFlight: false, submitted: null, submittedAt: 0, updates: 0, coalesced: 0,
        };
        preview.startedEventId = emitted('preview.started', { previewId: preview.previewId, baseRunId: preview.baseRunId, parameter, gesture }, actor, input.operationId as string);
        return ok();
      }),
      updatePreview: raw => sync('updatePreview', raw, input => {
        const blocked = gate(actor, 'operate.parameters');
        if (blocked) return failure(blocked);
        const track = preview;
        if (!track || input.previewId !== track.previewId) return failure(diag('NOT_FOUND', '$.previewId', 'No active preview has this ID.'));
        // Authorization is re-checked on every update (report §6.3, A24): a preview whose stage, context, control or
        // exploration grant changed ends here and shows nothing more.
        if (!previewAuthorized(track)) {
          interruptPreview(track.stageId !== instance.stage.id || track.context !== instance.context.kind ? 'navigation' : 'revoked', input.operationId as string, actor);
          return failure(diag('POLICY_DENIED', '$.previewId', 'This live preview is no longer authorized; it ended without a change.'));
        }
        const domain = track.domain;
        const converted = canonical(input.displayValues, parameter => visibility.controls[parameter] === 'interactive' && (!domain || Object.hasOwn(domain, parameter)));
        if (!converted.ok) return converted;
        let params: Record<string, number> = { ...session.getState().run!.params, ...converted.values };
        let clamped: string[] = [];
        if (track.gesture === 'pointer' || track.gesture === 'drag') {
          const result = clampForPreview(manifest, params);
          params = result.params;
          clamped = result.clamped;
          for (const [parameter, [lo, hi]] of Object.entries(domain ?? {})) {
            if (!Object.hasOwn(converted.values, parameter)) continue;
            const next = Math.min(hi, Math.max(lo, params[parameter]!));
            if (next !== params[parameter]) { params[parameter] = next; if (!clamped.includes(parameter)) clamped.push(parameter); }
          }
        } else for (const [parameter, [lo, hi]] of Object.entries(domain ?? {})) {
          const value = converted.values[parameter];
          if (value !== undefined && (value < lo || value > hi)) return failure(diag('OUT_OF_DOMAIN', `$.displayValues.${parameter}`, 'The value is outside the authorized exploration range.'));
        }
        const invalid = check(params);
        if (invalid) return invalid;
        // A value accepted while an evaluation is outstanding and replaced before it was sent is coalesced (never sent).
        if (track.inFlight && track.params && track.params !== track.submitted) track.coalesced++;
        track.updates++;
        track.params = params;
        track.clamped = clamped.length > 0;
        track.refused = false;
        notice = track.clamped ? 'The value was adjusted to the allowed range.' : null;
        pumpPreview(track);
        return ok();
      }),
      commitPreview: raw => async('commitPreview', raw, async input => {
        const blocked = scientific(input, 'operate.parameters');
        if (blocked) return failure(blocked);
        const track = preview;
        if (!track || input.previewId !== track.previewId) return failure(diag('NOT_FOUND', '$.previewId', 'No active preview has this ID.'));
        // One commit per preview: a second commitPreview (another operation ID) while the first is in flight is refused.
        if (track.closing) return failure(diag('CONFLICT', '$.previewId', 'This live preview is already being applied.', 'Wait for the first commit to finish.'));
        // The commit is guarded like commitParameters (report §9): the preview must still be authorized and every value it
        // changes must belong to a control that is interactive now; otherwise it ends and commits nothing.
        if (!previewAuthorized(track)) {
          interruptPreview(track.stageId !== instance.stage.id || track.context !== instance.context.kind ? 'navigation' : 'revoked', input.operationId as string, actor);
          return failure(diag('POLICY_DENIED', '$.previewId', 'This live preview is no longer authorized; it ended without a change.'));
        }
        if (!track.params) {
          try { session.cancelPreview(sessionGuard()); } catch { /* No session preview was started. */ }
          endPreview('cancelled', 'superseded', input.operationId as string, actor);
          return ok();
        }
        const full = room('preview.observed', 'parameters.committed');
        if (full) return failure(full);
        // The newest accepted value is committed (never an older coalesced one); no further preview value is sent.
        const params = track.params;
        track.closing = true;
        const outcome = await commit(params, 'commit', actor, input.operationId as string, { previewId: track.previewId, gesture: track.gesture }, [track.startedEventId], track);
        // A stage, context, policy or grant change (or suspension) while the commit was in flight ended the preview and
        // aborted its commit: nothing was committed (activity-runtime §11).
        const aborted = track.commit?.abort.signal;
        if (!outcome.ok && aborted?.aborted && !disposed) {
          const reason: unknown = aborted.reason;
          if (preview === track) interruptPreview(reason === 'blur' || reason === 'navigation' ? reason : 'revoked', input.operationId as string, actor);
          return failure(reason === 'navigation' || reason === 'revoked'
            ? diag('POLICY_DENIED', '$.previewId', 'This live preview is no longer authorized; it ended before its value was applied and nothing was changed.')
            : reason === 'blur'
              ? diag('CANCELLED', '$.previewId', 'The activity was hidden before this live preview\'s value was applied; nothing was changed.', 'Show the activity, then change the value again.')
              : diag('CANCELLED', '$.previewId', 'The live preview was cancelled before its value was applied; nothing was changed.'));
        }
        if (preview === track) endPreview(outcome.ok ? 'committed' : 'interrupted', outcome.ok ? null : 'superseded', input.operationId as string, actor);
        return outcome.ok ? ok() : outcome;
      }),
      cancelPreview: raw => sync('cancelPreview', raw, input => {
        if (disposed) return failure(diag('DISPOSED', '$', 'This activity has been disposed.'));
        // A commit of this preview that the session already applied is journaled first (the preview then ended committed).
        settleClosingCommit();
        const track = preview;
        if (!track || input.previewId !== track.previewId) return failure(diag('NOT_FOUND', '$.previewId', 'No active preview has this ID.'));
        const reason = input.reason as 'escape';
        if (!['escape', 'pointercancel', 'blur', 'navigation', 'revoked', 'superseded'].includes(reason)) return failure(diag('INVALID_INPUT', '$.reason', 'Unknown cancellation reason.'));
        // A commit of this preview still in flight is cancelled with it: it never lands after the cancellation.
        track.commit?.abort.abort(reason);
        try { if (session.getState().preview) session.cancelPreview(sessionGuard()); } catch { /* Suspended sessions have no preview. */ }
        endPreview('cancelled', reason, input.operationId as string, actor);
        return ok();
      }),
      commitParameters: raw => async('commitParameters', raw, async input => {
        const blocked = scientific(input, 'operate.parameters');
        if (blocked) return failure(blocked);
        if (preview) return failure(diag('PREVIEW_ACTIVE', '$', 'A preview is active.'));
        const gesture = input.gesture ?? 'exact';
        if (!['pointer', 'keyboard', 'exact', 'drag'].includes(gesture as string)) return failure(diag('INVALID_INPUT', '$.gesture', 'Unknown gesture.'));
        const converted = canonical(input.displayValues, parameter => visibility.controls[parameter] === 'interactive');
        if (!converted.ok) return converted;
        // Provenance: a pointer, keyboard or drag gesture without an authorized preview commits its draft as itself.
        return commit({ ...session.getState().run!.params, ...converted.values }, 'commit', actor, input.operationId as string, { gesture });
      }),
      applyScenario: raw => async('applyScenario', raw, async input => {
        const blocked = scientific(input, 'operate.parameters');
        if (blocked) return failure(blocked);
        if (preview) return failure(diag('PREVIEW_ACTIVE', '$', 'A preview is active.'));
        const scenario = template.scenarios.find(item => item.id === input.scenarioId);
        if (!scenario || visibility.groups[scenario.group] === 'absent') return failure(diag('NOT_FOUND', '$.scenarioId', 'No available scenario has this ID.'));
        if (visibility.groups[scenario.group] !== 'interactive') return failure(diag('POLICY_DENIED', '$.scenarioId', 'Scenarios cannot be applied now.'));
        const outcome = await commit({ ...session.getState().run!.params, ...scenario.parameters }, 'scenario', actor, input.operationId as string, { scenarioId: scenario.id });
        if (outcome.ok) { activeScenarioId = scenario.id; return ok(); }
        return outcome;
      }),
      resetExperiment: raw => async('resetExperiment', raw, async input => {
        const blocked = scientific(input, 'operate.parameters');
        if (blocked) return failure(blocked);
        if (preview) return failure(diag('PREVIEW_ACTIVE', '$', 'A preview is active.'));
        activeScenarioId = null;
        return commit({ ...instance.initialParameters }, 'reset', actor, input.operationId as string, {});
      }),
      navigate: raw => async('navigate', raw, input => navigateTo(actor, input, 'navigate')),
      step: raw => async('step', raw, async input => {
        const frame = session.getState().frame;
        if (input.delta !== 1 && input.delta !== -1) return failure(diag('INVALID_INPUT', '$.delta', 'Step by 1 or -1.'));
        if (!frame || frame.position.kind !== 'index') return failure(diag('UNSUPPORTED_CAPABILITY', '$.delta', 'This activity has no iteration steps.'));
        return navigateTo(actor, { ...input, position: { kind: 'index', index: frame.position.index + (input.delta as number) } }, 'step');
      }),
      restartPlayback: raw => async('restartPlayback', raw, input => navigateTo(actor, { ...input, position: initialPosition(manifest) }, 'restart')),
      play: raw => sync('play', raw, input => {
        const blocked = scientific(input, 'operate.playback');
        if (blocked) return failure(blocked);
        if (!stage().allowsPlayback) return failure(diag('POLICY_DENIED', '$', 'Playback is not available now.'));
        const hidden = navigationRefusal();
        if (hidden) return failure(hidden);
        if (preview) return failure(diag('PREVIEW_ACTIVE', '$', 'A preview is active.'));
        const full = room('playback.started', 'playback.ended');
        if (full) return failure(full);
        if (session.getState().playing) return ok();
        limitAhead = null;
        session.play(sessionGuard(), { throughNumericalLimit: crossesLimit });
        playbackActor = actor;
        wasPlaying = true;
        const state = session.getState();
        restored = false;
        playbackNotice = null;
        emit('playback.started', { runId: state.run!.id, position: structuredClone(state.frame!.position) }, actor, input.operationId as string);
        return ok();
      }),
      pause: raw => sync('pause', raw, input => {
        const blocked = gate(actor, 'operate.playback', { compute: false }) ?? scientificGuard(input);
        if (blocked) return failure(blocked);
        stopPlayback(input.operationId as string, actor);
        return ok();
      }),
      retainComparison: raw => sync('retainComparison', raw, input => {
        const blocked = scientific(input, 'operate.parameters');
        if (blocked) return failure(blocked);
        if (typeof input.label !== 'string') return failure(diag('INVALID_INPUT', '$.label', 'Provide a label.'));
        // Evidence-bearing: refused at the command capacity before the session changes (activity-runtime §5).
        const full = room('comparison.retained');
        if (full) return failure(full);
        session.retainComparison(input.label, sessionGuard());
        emit('comparison.retained', { runId: session.getState().run!.id, label: input.label }, actor, input.operationId as string);
        return ok();
      }),
      removeComparison: raw => sync('removeComparison', raw, input => {
        const blocked = scientific(input, 'operate.parameters');
        if (blocked) return failure(blocked);
        if (typeof input.runId !== 'string') return failure(diag('INVALID_INPUT', '$.runId', 'Provide a run ID.'));
        const full = room('comparison.removed');
        if (full) return failure(full);
        session.removeComparison(input.runId, sessionGuard());
        emit('comparison.removed', { runId: input.runId }, actor, input.operationId as string);
        return ok();
      }),
      setCamera: raw => presentationCommand('setCamera', raw, input => {
        const view = projectedView(input.viewId);
        if (!view) return diag('NOT_FOUND', '$.viewId', 'No visible view has this ID.');
        const camera = input.camera as Camera2D | Camera3D | null;
        if (camera !== null && (view.kind === 'scene3d' ? camera?.kind !== '3d' : camera?.kind !== '2d' || !['scene2d', 'plot2d'].includes(view.kind))) return diag('INVALID_INPUT', '$.camera', 'The camera does not match the view.');
        const next = { ...presentation, views: { ...presentation.views, [view.id]: { camera, layers: presentation.views[view.id]?.layers ?? [] } } };
        if (!validateRecord(CONTRACTS.presentation, next).ok) return diag('INVALID_INPUT', '$.camera', 'The camera is not valid.');
        presentation = next;
        return { change: 'camera', viewId: view.id };
      }),
      resetView: raw => presentationCommand('resetView', raw, input => {
        const view = projectedView(input.viewId);
        if (!view) return diag('NOT_FOUND', '$.viewId', 'No visible view has this ID.');
        presentation = { ...presentation, views: { ...presentation.views, [view.id]: { camera: null, layers: presentation.views[view.id]?.layers ?? [] } } };
        return { change: 'reset-view', viewId: view.id };
      }),
      setDisplayUnit: raw => presentationCommand('setDisplayUnit', raw, input => {
        const parameter = input.parameter, unit = input.unit as UnitId;
        // A visible control parameter, or a visible quantity with declared display units (report §8.3).
        const control = typeof parameter === 'string' && visibility.controls[parameter] ? controlsByParameter.get(parameter) : undefined;
        const quantity = !control && typeof parameter === 'string' && Object.hasOwn(quantityDisplay, parameter) && visibleQuantityIds(template, visibility.groups).has(parameter)
          ? quantityDisplay[parameter]! : undefined;
        const units = control?.displayUnits ?? quantity?.units;
        if (!units) return diag('NOT_FOUND', '$.parameter', 'No visible control or displayed quantity has this ID.');
        if (preview) return diag('PREVIEW_ACTIVE', '$', 'A preview is active.');
        if (!units.includes(unit)) return diag('UNIT_MISMATCH', '$.unit', 'Choose one of the listed units.');
        presentation = { ...presentation, displayUnits: { ...presentation.displayUnits, [parameter as string]: unit } };
        return { change: 'display-unit', parameter, unit };
      }),
      select: raw => presentationCommand('select', raw, input => {
        const target = input.target;
        if (target !== null && (typeof target !== 'string' || !selectable(projection).has(target))) return diag('NOT_FOUND', '$.target', 'Nothing visible has this ID.');
        presentation = { ...presentation, selection: target as string | null };
        return { change: 'selection', selection: target };
      }),
      setLayout: raw => presentationCommand('setLayout', raw, input => {
        if (!['auto', 'card', 'side', 'expanded'].includes(input.layout as string)) return diag('INVALID_INPUT', '$.layout', 'Unknown layout.');
        presentation = { ...presentation, layout: input.layout as PresentationSnapshot['layout'] };
        return { change: 'layout', layout: input.layout };
      }),
      requestHelp: raw => async('requestHelp', raw, async input => {
        const blocked = gate(actor, null, { compute: false }) ?? activityGuard(input);
        if (blocked) return failure(blocked);
        if (pending?.state === 'requesting') return failure(diag('PERSISTENCE_PENDING', '$', 'Another authorization is in progress.'));
        const flushed = await flushFirst();
        if (flushed) return failure(flushed);
        const blockedAfter = gate(actor, null, { compute: false }) ?? activityGuard(input);
        if (blockedAfter) return failure(blockedAfter);
        const operationId = input.operationId as string;
        // The same request again after the host did not record it: resume it (no second help.requested).
        const kept = resumable('requestHelp', operationId);
        if (kept) return authorize(kept);
        const full = room('help.requested', 'assistance.recorded', 'reveal.authorized');
        if (full) return failure(full);
        const helpId = emitted('help.requested', {}, actor, operationId);
        return requestAssistance('help', actor, operationId, [], 'requestHelp', [helpId]);
      }),
      // Display acknowledgement and surface registration come from the learner surface only (report §6.3 step 4): a tutor
      // or host binding cannot attest that the learner's surface rendered content.
      acknowledgeDisplay: raw => { if (actor.kind === 'learner') acknowledge(actor, raw); },
      registerSurface(surfaceId: string) {
        if (actor.kind !== 'learner') throw new TypeError('Only a learner binding can register a surface.');
        if (typeof surfaceId !== 'string' || !ID.test(surfaceId)) throw new RangeError('Invalid surface ID.');
        if (disposed) return () => undefined;
        surfaces.set(surfaceId, true);
        applySuspension(internalOp(), actor);
        let registered = true;
        return () => {
          if (!registered || disposed) return;
          registered = false;
          surfaces.delete(surfaceId);
          applySuspension(internalOp(), actor);
          schedulePublish();
        };
      },
      reportVisibility(raw: unknown) {
        if (disposed || actor.kind !== 'learner' || !isRecord(raw)) return;
        const { surfaceId, visible } = raw;
        if (typeof surfaceId !== 'string' || typeof visible !== 'boolean' || !surfaces.has(surfaceId)) return;
        if (surfaces.get(surfaceId) === visible) return;
        surfaces.set(surfaceId, visible);
        applySuspension(internalOp(), actor);
        publish();
      },
      retryPersistence: raw => async('retryPersistence', raw, async input => {
        if (disposed) return failure(diag('DISPOSED', '$', 'This activity has been disposed.'));
        return retry(input.operationId as string, actor);
      }),
      describeCurrentValues: () => describeProjection(projection),
    } satisfies ActivityBinding);
  }

  /** `refresh`: a worker recovery that re-evaluates the shown position, which is not a learner navigation. */
  async function navigateTo(actor: Actor, input: Record<string, unknown>, cause: 'navigate' | 'step' | 'restart', options: { refresh?: boolean } = {}): Promise<CommandOutcome> {
    const blocked = gate(actor, 'operate.navigation') ?? scientificGuard(input);
    if (blocked) return failure(blocked);
    if (!options.refresh && !stage().allowsNavigation && !(cause === 'restart' && stage().allowsPlayback)) return failure(diag('POLICY_DENIED', '$', 'Navigation is not available now.'));
    const hidden = options.refresh ? null : navigationRefusal();
    if (hidden) return failure(hidden);
    if (preview) return failure(diag('PREVIEW_ACTIVE', '$', 'A preview is active.'));
    const full = room('position.changed');
    if (full) return failure(full);
    const before = session.getState();
    const from = structuredClone(before.frame!.position);
    stopPlayback(input.operationId as string, actor);
    const startedAt = now();
    try { await session.navigate(input.position as PositionRequest, sessionGuard(), lifetime.signal); } catch (error) {
      if (disposed) return failure(diag('DISPOSED', '$', 'This activity has been disposed.'));
      const diagnostics = toDiagnostics(error);
      noteWorker(diagnostics, options.refresh ? { kind: 'refresh' } : { kind: 'navigate', position: structuredClone(input.position as PositionRequest), cause });
      publish();
      return failure(...diagnostics.map(item => item.path.startsWith('$.position') ? item : { ...item, path: '$.position' }));
    }
    if (disposed) return failure(diag('DISPOSED', '$', 'This activity has been disposed.'));
    measure('navigate', startedAt);
    clearWorkerFailure();
    restored = false;
    playbackNotice = null;
    const after = session.getState();
    emit('position.changed', withQuantities({ runId: after.run!.id, from, to: structuredClone(after.frame!.position), cause }, visibleQuantities(after.frame)), actor, input.operationId as string);
    return ok();
  }

  function applySuspension(operationId: string, actor: Actor): void {
    if (disposed || !ready || instance.closed) return;
    const hidden = surfaces.size > 0 && ![...surfaces.values()].some(Boolean);
    const should = hostSuspended !== null || hidden;
    if (should && !suspended()) {
      interruptPreview(hostSuspended ? 'navigation' : 'blur', operationId, actor);
      stopPlayback(operationId, actor);
      session.suspend();
      emit('activity.suspended', { reason: hostSuspended ?? 'hidden' }, actor, operationId);
    } else if (!should && suspended()) {
      session.resume();
      emit('activity.resumed', {}, actor, operationId);
    }
  }

  async function retry(operationId: string, actor: Actor): Promise<CommandOutcome> {
    for (const record of exposures.unpersistedAcks()) persistAck(record);
    try { await outbox.flush(); } catch { /* Reported through persistence state. */ }
    // A journal loss is cleared only once it is recorded in the journal, never silently.
    recordLoss();
    if (!unrecordedLoss) journalError = null;
    if (disposed) return failure(diag('DISPOSED', '$', 'This activity has been disposed.'));
    if (pending && pending.state === 'failed') {
      if (pending.epoch !== revealEpoch) { pending = null; pendingReveal = null; return ok(); }
      // The same standing checks as every host-authorized step (report §5.3, A07): a stale or expired policy, revoked
      // content, withdrawn approval or a closed activity ends the kept authorization instead of resending it.
      const blocked = hostGate({}, false);
      if (blocked) { pending = null; pendingReveal = null; publish(); return failure(blocked); }
      return authorize(pending);
    }
    if (workerFailure) return recoverWorker(operationId, actor);
    return ok();
  }

  /**
   * Bounded worker recovery (report §9, §10.4): re-issues the operation a worker timeout or crash interrupted, through
   * the same guarded command path with fresh guards, so the retry is journaled as that actor's operation. The last
   * accepted frame stays shown until the re-issued evaluation is accepted; the evaluator has already terminated the
   * failed worker and creates its replacement inside the same lease (no extra worker). A re-issue the current stage
   * or policy no longer permits re-evaluates the shown position instead. After WORKER_RECOVERY_ATTEMPTS failed
   * attempts the status offers `reload` and further retries do nothing.
   */
  function recoverWorker(operationId: string, actor: Actor): Promise<CommandOutcome> {
    if (recovering) return recovering;
    const blocked = gate(actor, 'operate.navigation');
    if (blocked) return Promise.resolve(failure(blocked));
    if (recoveryAttempts >= WORKER_RECOVERY_ATTEMPTS) return Promise.resolve(failure(diag('WORKER_ERROR', '$', WORKER_RECOVERY_EXHAUSTED.notice, WORKER_RECOVERY_EXHAUSTED.recovery.label)));
    if (preview && failedOperation?.kind !== 'preview') return Promise.resolve(failure(diag('PREVIEW_ACTIVE', '$', 'A preview is active.')));
    recoveryAttempts++;
    const operation: FailedOperation = failedOperation ?? { kind: 'refresh' };
    const fresh = () => { const state = session.getState(); return { operationId, expectedScientificVersion: state.version, expectedRunId: state.run?.id ?? null }; };
    const refresh = (): Promise<CommandOutcome> => {
      const frame = session.getState().frame;
      if (!frame) return Promise.resolve(failure(diag('NOT_READY', '$', 'The activity is not ready.')));
      const position: PositionRequest = frame.position.kind === 'index' ? { kind: 'index', index: frame.position.index } : frame.position.kind === 'time' ? { kind: 'time', time: frame.position.time } : { kind: 'static' };
      return navigateTo(actor, { ...fresh(), position }, 'navigate', { refresh: true });
    };
    const permitted = (op: Extract<FailedOperation, { kind: 'commit' }>): boolean => {
      visibility = computeVis();
      if (op.cause === 'reset') return true;
      if (op.cause === 'scenario') { const scenario = template.scenarios.find(item => item.id === op.extra.scenarioId); return !!scenario && visibility.groups[scenario.group] === 'interactive'; }
      const current = session.getState().run?.params ?? {};
      return Object.entries(op.params).every(([parameter, value]) => current[parameter] === value || visibility.controls[parameter] === 'interactive');
    };
    const attempt = async (): Promise<CommandOutcome> => {
      switch (operation.kind) {
        case 'commit': {
          if (!permitted(operation)) return refresh();
          const outcome = await commit(operation.params, operation.cause, actor, operationId, operation.extra);
          if (!outcome.ok || operation.cause !== 'scenario') return outcome;
          activeScenarioId = operation.extra.scenarioId as string;
          return ok();
        }
        case 'navigate': {
          const outcome = await navigateTo(actor, { ...fresh(), position: operation.position }, operation.cause);
          return !outcome.ok && outcome.diagnostics.some(item => item.code === 'POLICY_DENIED' || item.code === 'INDEPENDENT_CONTEXT') ? refresh() : outcome;
        }
        case 'preview': {
          // Attempts stay counted until an evaluation is accepted. A preview still open resends its newest value
          // through the single-submission pump (a repeated failure is noted again); once its preview has ended the
          // failed tentative evaluation is no longer shown and nothing is left to recompute.
          workerFailure = false;
          failedOperation = null;
          const track = preview;
          if (track && track.previewId === operation.previewId && track.params) { track.submitted = null; track.refused = false; pumpPreview(track); }
          return ok();
        }
        case 'refresh': return refresh();
      }
    };
    const run = attempt().then(outcome => { recovering = null; if (!outcome.ok) publish(); return outcome; }, error => { recovering = null; publish(); return failure(...toDiagnostics(error)); });
    recovering = run;
    return run;
  }

  function requestAssistance(kind: 'help' | 'reopen-instructional', actor: Actor, operationId: string, groups: GroupDigest[], origin: string, causes: readonly Cause[] = []): Promise<CommandOutcome> {
    const base = receiptBase(operationId);
    const request = { activityId, operationId, idempotencyKey: operationId, kind, basedOnActivityRevision: instance.activityRevision, expectedPolicyRevision: policy.revision, actor: actor.kind, groups, template: templateRef, model: modelRef };
    const entry: PendingAuthorization = {
      kind: 'assistance', origin, operationId, actor, labels: labelsOf(groups), groups, state: 'requesting', basedOn: { activity: instance.activityRevision, policy: policy.revision },
      revision: instance.activityRevision, epoch: revealEpoch,
      call: () => host.recordAssistance(request),
      expectation: { ...base, kind: 'assistance', assistanceKind: kind, groups, digests, fingerprint: fingerprintOf(request) },
      apply(raw) {
        const receipt = raw as AssistanceReceipt;
        if (kind === 'reopen-instructional') {
          exposures.advanceLineage();
          reopenRequired = false;
          instance = { ...instance, context: { kind: 'instructional' }, allowedActions: [] };
          instance.allowedActions = allowedActions();
        }
        instance = { ...instance, activityRevision: receipt.activityRevision };
        recordGrant(receipt.receiptId, receipt.grant, instance.stage.id, receipt.activityRevision, actor, operationId, causes);
        assistance.push({
          receiptId: receipt.receiptId, kind, sequence: lastSequence() + 1,
          grant: receipt.grant ? { exposureId: receipt.grant.exposureId, groups: receipt.grant.groups.map(group => group.groupId) } : null,
        });
        const recordedId = emitted('assistance.recorded', { receiptId: receipt.receiptId, kind }, actor, operationId, causes);
        if (kind === 'reopen-instructional') emit('context.instructional-reopened', { receiptId: receipt.receiptId }, actor, operationId, [recordedId]);
        sanitizeSelection();
        return null;
      },
      history(raw) {
        // The host recorded this assistance: it stays in every later frozen snapshot, but a late reopening does not reopen
        // the context that changed meanwhile, and its grant never counts.
        const receipt = raw as AssistanceReceipt;
        followRevision(receipt.activityRevision);
        recordGrant(receipt.receiptId, receipt.grant, instance.stage.id, receipt.activityRevision, actor, operationId, causes, { history: true });
        if (assistance.some(item => item.receiptId === receipt.receiptId)) return;
        assistance.push({
          receiptId: receipt.receiptId, kind, sequence: lastSequence() + 1,
          grant: receipt.grant ? { exposureId: receipt.grant.exposureId, groups: receipt.grant.groups.map(group => group.groupId) } : null,
        });
        emit('assistance.recorded', { receiptId: receipt.receiptId, kind }, actor, operationId, causes);
      },
    };
    return authorize(entry);
  }

  // ---- privileged host control --------------------------------------------------------------------------------
  const hostCommand = <T>(name: string, raw: unknown, action: (input: Record<string, unknown>) => T) => command(name, hostActor, raw, false, action);
  const hostGate = (input: Record<string, unknown>, guarded = true): Diagnostic | null => {
    if (disposed) return diag('DISPOSED', '$', 'This activity has been disposed.');
    if (!ready) return diag('NOT_READY', '$', 'The activity is not ready.');
    if (unsupported) return unsupported;
    if (stale) return stale;
    const standing = policyStanding(policy, ctx.hostClock.now());
    if (standing) return blockOnStanding(standing);
    const revoked = modeDiagnostic(instance.mode, policy, ctx.catalog, templateRef, modelRef);
    if (revoked) { if (revoked.code === 'CONTENT_REVOKED') contentRevoked('catalogue', revoked); else { stale = revoked; contentRevoked('policy', revoked); } sanitizeSelection(); schedulePublish(); return revoked; }
    if (instance.closed) return diag('NOT_READY', '$', 'The activity is closed.');
    return guarded ? activityGuard(input) : null;
  };
  const actorOf = (input: Record<string, unknown>): Actor | Diagnostic => input.actor === undefined ? hostActor
    : ['learner', 'tutor', 'host'].includes(input.actor as string) ? { kind: input.actor as ActorKind, binding: 'host-control' } : diag('INVALID_INPUT', '$.actor', 'Unknown actor.');

  const hostControl: HostActivityControl = {
    activityId,
    requestStageTransition: raw => Promise.resolve(hostCommand('requestStageTransition', raw, async input => {
      const blocked = hostGate(input);
      if (blocked) return failure(blocked);
      const actor = actorOf(input);
      if ('code' in actor) return failure(actor);
      if (independent() || reopenRequired) return failure(diag('INDEPENDENT_CONTEXT', '$', 'Stage transitions wait until instructional work is reopened.', 'Reopen instructional work through the host (reopenInstructional) first.'));
      const from = instance.stage.id, to = input.toStage;
      const transition = template.transitions.find(item => item.from === from && item.to === to);
      if (typeof to !== 'string' || !transition) return failure(diag('INVALID_REFERENCE', '$.toStage', 'The template declares no transition from the current stage to this stage.'));
      if (pending?.state === 'requesting') return failure(diag('PERSISTENCE_PENDING', '$', 'Another authorization is in progress.'));
      const flushed = await flushFirst();
      if (flushed) return failure(flushed);
      const again = hostGate(input);
      if (again) return failure(again);
      const operationId = input.operationId as string;
      // The same request again after the host did not record it: resume it (no second reveal.requested).
      const kept = resumable('requestStageTransition', operationId);
      if (kept) {
        const room2 = room('stage.changed', ...(kept.groups.length ? ['reveal.authorized' as const] : []), ...interruptions());
        if (room2) return failure(room2);
        interruptPreview('navigation', operationId, actor);
        stopPlayback(operationId, actor);
        return authorize(kept);
      }
      const target = stages.get(to)!;
      const needed = solutionGroupsFor(template, target, policy, 'instructional')
        .filter(group => !exposures.current().some(record => record.scope === 'reveal' && record.displayStatus !== 'not-displayed' && record.groups.some(item => item.groupId === group.id && item.contentDigest === digests[group.id])))
        .map(group => ({ groupId: group.id, contentDigest: digests[group.id]! }));
      const full = room(...(needed.length ? ['reveal.requested', 'reveal.authorized'] as const : []), 'stage.changed', ...interruptions());
      if (full) return failure(full);
      interruptPreview('navigation', operationId, actor);
      stopPlayback(operationId, actor);
      const requested = needed.length ? emitted('reveal.requested', { idempotencyKey: operationId, scope: 'stage', groups: needed, intendedStage: to }, actor, operationId) : null;
      const request = { activityId, operationId, idempotencyKey: operationId, fromStage: from, toStage: to, basedOnActivityRevision: instance.activityRevision, expectedPolicyRevision: policy.revision, actor: actor.kind, groups: needed, template: templateRef, model: modelRef };
      return authorize({
        kind: 'stage', origin: 'requestStageTransition', operationId, actor, labels: labelsOf(needed), groups: needed, state: 'requesting', basedOn: { activity: instance.activityRevision, policy: policy.revision },
        revision: instance.activityRevision, epoch: revealEpoch,
        call: () => host.requestStageTransition(request),
        expectation: { ...receiptBase(operationId), kind: 'stage', fromStage: from, toStage: to, groups: needed, fingerprint: fingerprintOf(request) },
        apply(raw) {
          const receipt = raw as { receiptId: string; activityRevision: number; grant: ExposureGrant | null };
          instance = { ...instance, stage: { id: to, enteredAtSequence: lastSequence() + 1 }, activityRevision: receipt.activityRevision };
          activeScenarioId = null;
          emit('stage.changed', { fromStage: from, toStage: to, receiptId: receipt.receiptId, activityRevision: receipt.activityRevision, transitionId: transition.id }, actor, operationId, [requested]);
          recordGrant(receipt.receiptId, receipt.grant, to, receipt.activityRevision, actor, operationId, [requested]);
          sanitizeSelection();
          return null;
        },
        history(raw) {
          // The host moved the activity to the new stage: the adapter follows the host-owned stage and revision; the
          // stage's grant is history and never counts, so its solution-bearing content waits for a new authorization.
          // A closed activity keeps the stage it was closed in: its journal never records a stage change after
          // `activity.closed` (report §7.1 ordering); the host's records still hold the stage it committed, and a restore
          // adopts it. The grant stays in the history either way.
          const receipt = raw as { receiptId: string; activityRevision: number; grant: ExposureGrant | null };
          followRevision(receipt.activityRevision);
          if (instance.stage.id === from && !instance.closed) {
            instance = { ...instance, stage: { id: to, enteredAtSequence: lastSequence() + 1 } };
            activeScenarioId = null;
            emit('stage.changed', { fromStage: from, toStage: to, receiptId: receipt.receiptId, activityRevision: receipt.activityRevision, transitionId: transition.id }, actor, operationId, [requested]);
          }
          recordGrant(receipt.receiptId, receipt.grant, to, receipt.activityRevision, actor, operationId, [requested], { history: true });
        },
      });
    })),
    requestReveal: raw => Promise.resolve(hostCommand('requestReveal', raw, async input => revealOrScope(input, 'reveal'))),
    requestExplorationScope: raw => Promise.resolve(hostCommand('requestExplorationScope', raw, async input => revealOrScope(input, 'exploration'))),
    submitResponseRef: raw => Promise.resolve(hostCommand('submitResponseRef', raw, async input => {
      const blocked = hostGate(input, false) ?? hostRevision(input);
      if (blocked) return failure(blocked);
      const response = isRecord(input.response) ? { ...input.response, status: input.response.status ?? 'submitted' } as ResponseRef : null;
      const candidate = response ? { ...instance, responses: [...instance.responses, response] } : null;
      if (!response || !candidate || !validateRecord(CONTRACTS.instance, candidate).ok) return failure(diag('INVALID_INPUT', '$.response', 'The response reference is not valid.'));
      if (!stages.has(response.stageId)) return failure(diag('INVALID_REFERENCE', '$.response.stageId', 'Unknown stage.'));
      if (instance.responses.some(item => item.responseId === response.responseId)) return failure(diag('CONFLICT', '$.response.responseId', 'This response is already recorded.'));
      const full = room('response.submitted');
      if (full) return failure(full);
      // The host session revision is the one the host's response transaction produced; the adapter never advances it.
      instance = { ...candidate, hostSessionRevision: input.hostSessionRevision as number };
      const submittedId = emitted('response.submitted', { response: structuredClone(response) }, hostActor, input.operationId as string);
      if (submittedId) submittedEvents.set(response.responseId, submittedId);
      return ok();
    })),
    updateResponseRef: raw => Promise.resolve(hostCommand('updateResponseRef', raw, async input => {
      const blocked = hostGate(input, false) ?? hostRevision(input);
      if (blocked) return failure(blocked);
      const index = instance.responses.findIndex(item => item.responseId === input.responseId);
      if (index < 0) return failure(diag('NOT_FOUND', '$.responseId', 'No response has this ID.'));
      const status = input.status as ResponseRef['status'];
      if (!['superseded', 'corrected', 'disputed', 'deleted'].includes(status)) return failure(diag('INVALID_INPUT', '$.status', 'Unknown status.'));
      const supersededBy = input.supersededBy;
      if (status === 'superseded' && (typeof supersededBy !== 'string' || supersededBy === input.responseId || !instance.responses.some(item => item.responseId === supersededBy)))
        return failure(diag('INVALID_REFERENCE', '$.supersededBy', 'A superseded response names another response of this activity.'));
      const full = room('response.superseded');
      if (full) return failure(full);
      const responses = instance.responses.map((item, i) => i === index ? { ...item, status, ...(typeof supersededBy === 'string' ? { supersededBy } : {}) } : item);
      instance = { ...instance, responses, hostSessionRevision: input.hostSessionRevision as number };
      const type: EventType = status === 'superseded' || status === 'corrected' ? 'response.superseded' : 'response.invalidated';
      emit(type, { responseId: input.responseId, status, ...(typeof supersededBy === 'string' ? { supersededBy } : {}) }, hostActor, input.operationId as string,
        [submittedEvents.get(input.responseId as string), typeof supersededBy === 'string' ? submittedEvents.get(supersededBy) : null]);
      return ok();
    })),
    observeHostSessionRevision: raw => hostCommand('observeHostSessionRevision', raw, input => {
      if (disposed) return failure(diag('DISPOSED', '$', 'This activity has been disposed.', 'Prepare or restore the activity again.'));
      if (!ready) return failure(diag('NOT_READY', '$', 'The activity is not ready.', 'Wait until the activity is prepared, then repeat.'));
      const invalid = hostRevision(input);
      if (invalid) return failure(invalid);
      instance = { ...instance, hostSessionRevision: input.hostSessionRevision as number };
      return ok();
    }) as CommandOutcome,
    enterIndependentTask: raw => Promise.resolve(hostCommand('enterIndependentTask', raw, async input => {
      if (disposed) return failure(diag('DISPOSED', '$', 'This activity has been disposed.'));
      if (!ready || instance.closed) return failure(diag('NOT_READY', '$', 'The activity is not ready.'));
      const next = input.policy as HostPolicy;
      const problems = policyDiagnostics(next);
      if (problems.length) return failure(...problems);
      if (typeof input.taskRef !== 'string' || !ID.test(input.taskRef)) return failure(diag('INVALID_INPUT', '$.taskRef', 'Provide a task reference.'));
      if (!next.independentTask.active || next.independentTask.taskRef !== input.taskRef) return failure(diag('CONFLICT', '$.policy.independentTask', 'The policy does not activate this independent task.'));
      if (next.revision < policy.revision || next.revision === policy.revision && !sameJSON(next, policy)) return failure(diag('STALE_POLICY_REVISION', '$.policy.revision', 'The policy revision is older than the current one.'));
      const full = room(...interruptions(), 'context.independent-entered', ...exposures.awaitingDisplay().map(() => 'reveal.uncertain' as const));
      if (full) return failure(full);
      const operationId = input.operationId as string;
      interruptPreview('navigation', operationId, hostActor);
      stopPlayback(operationId, hostActor);
      // Late receipts of pending reveal requests are discarded; unacknowledged reveals stay potentially exposed.
      revealEpoch++;
      pending = null;
      pendingReveal = null;
      for (const record of exposures.awaitingDisplay()) {
        const reason = 'The context became independent before a display acknowledgement; treat the content as potentially seen.';
        if (exposures.markUncertain(record.exposureId, { code: 'SURFACE_LOST', reason }))
          emit('reveal.uncertain', { exposureId: record.exposureId, receiptId: record.receiptId, code: 'SURFACE_LOST', reason }, hostActor, operationId, [authorizedEvents.get(record.exposureId)]);
      }
      exposures.advanceLineage();
      reopenRequired = false;
      instance = { ...instance, context: { kind: 'independent', taskRef: input.taskRef } };
      applyPolicy(next);
      sanitizeSelection();
      emit('context.independent-entered', { taskRef: input.taskRef, policyRevision: policy.revision }, hostActor, operationId);
      return ok();
    })),
    reopenInstructional: raw => Promise.resolve(hostCommand('reopenInstructional', raw, async input => {
      const blocked = hostGate(input);
      if (blocked) return failure(blocked);
      // Also after a restore from an independent lineage into instructional work (`reopenRequired`).
      if (!independent() && !reopenRequired) return failure(diag('CONFLICT', '$', 'The activity is already in an instructional context.', 'Nothing to reopen; continue with the current stage.'));
      if (pending?.state === 'requesting') return failure(diag('PERSISTENCE_PENDING', '$', 'Another authorization is in progress.'));
      const flushed = await flushFirst();
      if (flushed) return failure(flushed);
      const again = hostGate(input);
      if (again) return failure(again);
      const kept = resumable('reopenInstructional', input.operationId as string);
      if (kept) return authorize(kept);
      const full = room('assistance.recorded', 'context.instructional-reopened', 'reveal.authorized');
      if (full) return failure(full);
      const groups = solutionGroupsFor(template, stage(), policy, 'instructional').map(group => ({ groupId: group.id, contentDigest: digests[group.id]! }));
      return requestAssistance('reopen-instructional', hostActor, input.operationId as string, groups, 'reopenInstructional');
    })),
    freezeAssistanceSnapshot(raw: { responseId: string }) {
      const responseId = isRecord(raw) ? raw.responseId : undefined;
      if (typeof responseId !== 'string' || !ID.test(responseId)) throw new RangeError('Provide a response ID.');
      const existing = frozen.get(responseId);
      if (existing) return existing;
      const cursor = lastSequence();
      // Incomplete when the local ledger may lack host-held records (a restore that could not read them).
      const snapshot: AssistanceSnapshot = deepFreeze({
        responseId, cursor, exposures: exposures.all().map(record => structuredClone(record)), assistance: assistance.filter(item => item.sequence <= cursor).map(item => structuredClone(item)),
        complete: ledgerLimitations.length === 0, limitations: [...ledgerLimitations],
      });
      frozen.set(responseId, snapshot);
      return snapshot;
    },
    updatePolicy: raw => Promise.resolve(hostCommand('updatePolicy', raw, async input => {
      if (disposed) return failure(diag('DISPOSED', '$', 'This activity has been disposed.'));
      const next = input.policy as HostPolicy;
      const problems = policyDiagnostics(next);
      if (problems.length) return failure(...problems);
      if (next.revision <= policy.revision) return failure(diag('STALE_POLICY_REVISION', '$.policy.revision', 'The policy revision must increase.'));
      const operationId = input.operationId as string;
      applyPolicy(next);
      endCause = 'policy';
      visibility = computeVis();
      revalidatePreview(next.revoked ? 'revoked' : 'navigation', operationId, hostActor);
      if (stale || unsupported) { interruptPreview('revoked', operationId, hostActor); stopPlayback(operationId, hostActor); }
      sanitizeSelection();
      return ok();
    })),
    revoke: raw => Promise.resolve(hostCommand('revoke', raw, async input => {
      if (disposed) return failure(diag('DISPOSED', '$', 'This activity has been disposed.'));
      if (typeof input.reason !== 'string' || !input.reason.length || input.reason.length > 4000) return failure(diag('INVALID_INPUT', '$.reason', 'Provide a reason.'));
      const operationId = input.operationId as string;
      interruptPreview('revoked', operationId, hostActor);
      stopPlayback(operationId, hostActor);
      revealEpoch++;
      pending = null;
      pendingReveal = null;
      policy = { ...policy, revoked: true };
      revokedByHost = diag('POLICY_DENIED', '$.policy', 'The host revoked this activity.', 'Return to the session.');
      stale = revokedByHost;
      // Nothing is visible any more: a selection must not survive into a later state (report §6.2).
      sanitizeSelection();
      contentRevoked('host', revokedByHost, input.reason, operationId);
      return ok();
    })),
    suspend: raw => hostCommand('suspend', raw, input => {
      if (disposed) return failure(diag('DISPOSED', '$', 'This activity has been disposed.'));
      if (!['offscreen', 'collapsed', 'hidden', 'host'].includes(input.reason as string)) return failure(diag('INVALID_INPUT', '$.reason', 'Unknown suspension reason.'));
      hostSuspended = input.reason as string;
      applySuspension(input.operationId as string, hostActor);
      return ok();
    }) as CommandOutcome,
    resume: raw => hostCommand('resume', raw, input => {
      if (disposed) return failure(diag('DISPOSED', '$', 'This activity has been disposed.'));
      hostSuspended = null;
      applySuspension(input.operationId as string, hostActor);
      return ok();
    }) as CommandOutcome,
    close: raw => Promise.resolve(hostCommand('close', raw, async input => {
      if (disposed) return failure(diag('DISPOSED', '$', 'This activity has been disposed.'));
      if (!ready) return failure(diag('NOT_READY', '$', 'The activity is not ready.'));
      if (instance.closed) return ok();
      if (typeof input.reason !== 'string' || !input.reason.length || input.reason.length > 4000) return failure(diag('INVALID_INPUT', '$.reason', 'Provide a reason.'));
      const choice = input.pending ?? 'cancel';
      if (choice !== 'cancel' && choice !== 'commit' && choice !== 'retain') return failure(diag('INVALID_INPUT', '$.pending', 'Resolve a pending preview with cancel, commit or retain.'));
      const flushed = await flushFirst();
      if (flushed) return failure(flushed);
      if (disposed) return failure(diag('DISPOSED', '$', 'This activity has been disposed.'));
      const operationId = input.operationId as string;
      // The host resolves a pending preview under its policy (report §14); exposure history survives every choice.
      const resolved = preview ? choice : null;
      const track = preview;
      if (track && choice === 'commit' && track.params) {
        const blockedCommit = gate(hostActor, null);
        if (blockedCommit) return failure(blockedCommit);
        const committed = await commit(track.params, 'commit', hostActor, operationId, { previewId: track.previewId, gesture: track.gesture }, [track.startedEventId]);
        if (!committed.ok) return committed;
        if (preview === track) endPreview('committed', null, operationId, hostActor);
      }
      const full = room(...interruptions(), 'activity.closed');
      if (full) return failure(full);
      // A preview commit the session already applied is journaled before the closure; one still in flight never lands.
      settleClosingCommit();
      if (preview && choice === 'retain') {
        const kept = preview;
        kept.commit?.abort.abort('navigation');
        retainedDraft = kept.params ? { previewId: kept.previewId, params: { ...kept.params }, baseRunId: kept.baseRunId } : null;
        try { if (session.getState().preview) session.cancelPreview(sessionGuard()); } catch { /* No session preview was started. */ }
        endPreview('interrupted', null, operationId, hostActor);
      } else interruptPreview('navigation', operationId, hostActor);
      stopPlayback(operationId, hostActor);
      revealEpoch++;
      pending = null;
      pendingReveal = null;
      instance = { ...instance, closed: true };
      sanitizeSelection();
      emit('activity.closed', { reason: input.reason, ...(resolved ? { pending: resolved } : {}) }, hostActor, operationId);
      session.suspend();
      try { await outbox.flush(); } catch { /* Reported through persistence state. */ }
      return disposed ? failure(diag('DISPOSED', '$', 'This activity has been disposed.')) : ok();
    })),
    save: raw => Promise.resolve(hostCommand('save', raw, async input => saveArtifact(input))) as ReturnType<HostActivityControl['save']>,
    async reconcile() {
      if (disposed) throw new RangeError('This activity has been disposed.');
      const result = await outbox.reconcile();
      const activity = await resyncActivity();
      schedulePublish();
      return activity ? { ...result, activity } : result;
    },
    forget: raw => Promise.resolve(hostCommand('forget', raw, async input => {
      if (disposed) return failure(diag('DISPOSED', '$', 'This activity has been disposed.'));
      const scope = input.scope;
      if (scope === 'responses') {
        const ids = input.responseIds;
        if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string')) return failure(diag('INVALID_INPUT', '$.responseIds', 'Name the deleted responses.'));
        for (const id of ids) {
          const response = instance.responses.find(item => item.responseId === id);
          if (!response) return failure(diag('NOT_FOUND', '$.responseIds', 'No response has this ID.'));
          if (response.status !== 'deleted') return failure(diag('CONFLICT', '$.responseIds', 'Only responses the host has deleted can be forgotten.'));
        }
        const forgotten = new Set(ids as string[]);
        for (const id of forgotten) frozen.delete(id);
        // Saved artifacts naming these responses: the outcomes of their save operations and unsent save copies.
        const names = (artifact: unknown) => isRecord(artifact) && isRecord(artifact.instance) && Array.isArray(artifact.instance.responses)
          && (artifact.instance.responses as ResponseRef[]).some(response => forgotten.has(response.responseId));
        releaseOutcomes(value => names(value.artifact), input.operationId as string);
        for (const [operationId, artifact] of unconfirmedSaves) if (names(artifact)) unconfirmedSaves.delete(operationId);
        // Release acknowledged mirror copies that carry these response references (the host already deleted them).
        forgottenEvents += outbox.forgetAcknowledged(event => event.type.startsWith('response.')
          && forgotten.has(String((event.payload.response as { responseId?: unknown } | undefined)?.responseId ?? event.payload.responseId)));
      } else if (scope === 'activity') {
        // Release cached frames and comparisons, the preview sample buffer and derived caches.
        for (const comparison of session.getState().comparisons) { try { session.removeComparison(comparison.runId, sessionGuard()); } catch { /* Suspended or disposed. */ } }
        if (preview) { preview.rendered = []; }
        published.splice(0, published.length - 1);
        frozen.clear();
        unconfirmedSaves.clear();
        // Every outcome holds copies (projections, saved artifacts): a replay of its operation ID now fails, also for an
        // operation still in flight (released when it settles; a save in flight keeps no unsent copy).
        releaseOutcomes(() => true, input.operationId as string);
        // The adapter's own operation outcomes for this activity (prepare, restore) are released too.
        ctx.onForgotten();
        forgottenEvents += outbox.forgetAcknowledged(() => true);
      } else return failure(diag('INVALID_INPUT', '$.scope', 'Expected activity or responses.'));
      return ok();
    })),
  };
  Object.freeze(hostControl);
  /**
   * Adds the host's assistance references the local record lacks (oldest first). A reference whose grant names an
   * exposure record the ledger does not hold under the same receipt would make every later backup inconsistent; it is
   * left out and counted (the host's own records still hold it).
   */
  function mergeHostAssistance(records: ActivityRecords): { added: number; inconsistent: number } {
    const known = new Set(assistance.map(item => item.receiptId));
    const consistent = (item: AssistanceRef) => !item.grant || exposures.get(item.grant.exposureId)?.receiptId === item.receiptId;
    const inconsistent = records.assistance.filter(item => !known.has(item.receiptId) && !consistent(item)).length;
    const fromHost = records.assistance.filter(item => !known.has(item.receiptId) && consistent(item)).map(item => structuredClone(item));
    if (fromHost.length) { assistance.push(...fromHost); assistance.sort((a, b) => a.sequence - b.sequence); }
    return { added: fromHost.length, inconsistent };
  }
  /**
   * Reconciliation of the host-owned activity state (report §7.2 "reconcile on reconnect before issuing conflicting
   * transitions", §4.2): reads `getActivityRecords` and, unless an authorization is in flight, follows the host's stage
   * and activity revision wherever they differ from the adapter's (after a receipt that did not bind its request, an
   * outcome superseded by a context change, or a host store restored from another copy). An authorization kept after a
   * failed host call is withdrawn when the host's state differs (the host's records say what it holds; a new request is
   * based on its revision). Host-held exposure and assistance records the local record lacks are merged as history that
   * never counts for visibility, so nothing new is shown and frozen snapshots stay complete. What is adopted is journaled
   * (report §7.1): each host-held grant this adapter never journaled as a history `reveal.authorized` (or
   * `exposure.scope-authorized`), and a stage the host moved to as `stage.changed` naming the host's stage receipt
   * (`ActivityRecords.activity.stageReceiptId`; without it the stage is followed and the journal cannot name the move). A
   * host without the read, or one that omits its activity state, changes nothing here.
   */
  async function resyncActivity(): Promise<{ stage: string; activityRevision: number; adopted: boolean } | null> {
    if (typeof host.getActivityRecords !== 'function' || !ready || instance.closed || pending?.state === 'requesting') return null;
    let records: ActivityRecords;
    try { records = await host.getActivityRecords({ activityId }); } catch { return null; }
    if (disposed || !validateRecord(MESSAGES.activityRecords, records).ok || records.activityId !== activityId) return null;
    // Re-checked after the read: an authorization may have started meanwhile.
    if ((pending as PendingAuthorization | null)?.state === 'requesting' || instance.closed) return null;
    const operationId = internalOp();
    const merged = exposures.mergeHost(records.exposures);
    for (const exposureId of merged.added) {
      const record = exposures.get(exposureId);
      if (!record || authorizedEvents.has(exposureId)) continue;
      const eventId = emitted(record.scope === 'exploration' ? 'exposure.scope-authorized' : 'reveal.authorized', {
        exposureId, receiptId: record.receiptId, scope: record.scope, groups: record.groups.map(group => ({ ...group })), activityRevision: record.activityRevision,
        ...(record.parameterDomain ? { parameterDomain: structuredClone(record.parameterDomain) } : {}),
      }, hostActor, operationId);
      if (eventId) authorizedEvents.set(exposureId, eventId);
      // Merged conservatively as potentially seen (`mergeHost`): the journal says so too.
      if (record.displayStatus === 'uncertain' && record.uncertainty) {
        emit('reveal.uncertain', { exposureId, receiptId: record.receiptId, code: record.uncertainty.code, reason: record.uncertainty.reason }, hostActor, operationId, [eventId]);
      }
    }
    mergeHostAssistance(records);
    const state = records.activity;
    if (!state || !stages.has(state.stage)) return null;
    const moved = state.stage !== instance.stage.id;
    const adopted = moved || state.activityRevision !== instance.activityRevision;
    if (adopted) {
      if (pending) { pending = null; pendingReveal = null; }
      const from = instance.stage.id;
      if (moved) {
        // A stage the host moved to ends a preview and playback of the old stage, as a stage transition does.
        interruptPreview('navigation', operationId, hostActor);
        stopPlayback(operationId, hostActor);
        activeScenarioId = null;
        endCause = 'stage';
      }
      instance = { ...instance, activityRevision: state.activityRevision, ...(moved ? { stage: { id: state.stage, enteredAtSequence: lastSequence() + (state.stageReceiptId ? 1 : 0) } } : {}) };
      if (moved && state.stageReceiptId) {
        const transition = template.transitions.find(item => item.from === from && item.to === state.stage);
        emit('stage.changed', { fromStage: from, toStage: state.stage, receiptId: state.stageReceiptId, activityRevision: state.activityRevision, ...(transition ? { transitionId: transition.id } : {}) }, hostActor, operationId);
      }
      sanitizeSelection();
    }
    return { stage: state.stage, activityRevision: state.activityRevision, adopted };
  }
  /**
   * Releases successful outcomes that `holds` names (activity-runtime §8): the copy is dropped, the ID stays used. An
   * operation still in flight keeps the filter and is released when it settles (`command`), and an unsent copy of a save
   * in flight is not kept for a retry (`saveArtifact`).
   */
  function releaseOutcomes(holds: (value: Record<string, unknown>) => boolean, except: string): void {
    for (const [operationId, entry] of operations) {
      if (operationId === except) continue;
      if (!entry.settled) { (entry.release ??= []).push(holds); continue; }
      if (!isRecord(entry.value) || entry.value.ok !== true || !holds(entry.value)) continue;
      entry.forgotten = true;
      entry.outcome = undefined;
      entry.value = undefined;
    }
    for (const flight of savesInFlight.values()) if (holds({ ok: true, artifact: flight.artifact })) flight.released = true;
  }
  /**
   * Host session guard (report §4.2): the expected revision must be current, and `hostSessionRevision` is the revision the
   * host's own transaction produced (greater than the expected one). The adapter adopts the host's value; it never
   * computes one.
   */
  function hostRevision(input: Record<string, unknown>): Diagnostic | null {
    if (!Number.isSafeInteger(input.expectedHostSessionRevision)) return diag('INVALID_INPUT', '$.expectedHostSessionRevision', 'Provide expectedHostSessionRevision.', 'Pass the host session revision the activity currently holds (getState guards).');
    if (input.expectedHostSessionRevision !== instance.hostSessionRevision)
      return diag('STALE_HOST_REVISION', '$.expectedHostSessionRevision', 'The host session revision changed.', 'Read the current host session revision and retry.');
    if (!Number.isSafeInteger(input.hostSessionRevision) || (input.hostSessionRevision as number) <= instance.hostSessionRevision)
      return diag('INVALID_INPUT', '$.hostSessionRevision', 'Provide the host session revision the host transaction produced; it is greater than the expected revision.', 'Pass the revision the host recorded for this change.');
    return null;
  }

  async function revealOrScope(input: Record<string, unknown>, scope: 'reveal' | 'exploration'): Promise<CommandOutcome> {
    const blocked = hostGate(input);
    if (blocked) return failure(blocked);
    const actor = scope === 'reveal' ? actorOf(input) : hostActor;
    if ('code' in actor) return failure(actor);
    let groups: GroupDigest[];
    let parameterDomain: Record<string, [number, number]> | undefined;
    if (scope === 'reveal') {
      const chosen = revealable(input.groups);
      if (!chosen.ok) return chosen;
      if (!chosen.groups.length) return ok();
      groups = chosen.groups;
    } else {
      if (!stage().allowsPreview) return failure(diag('POLICY_DENIED', '$', 'This stage does not allow live preview.'));
      if (!Array.isArray(input.groups) || !input.groups.length || input.groups.length > 64) return failure(diag('INVALID_INPUT', '$.groups', 'Provide one or more group IDs.'));
      groups = [];
      for (const id of new Set(input.groups as unknown[])) {
        if (typeof id !== 'string' || !groupsById.has(id)) return failure(diag('INVALID_REFERENCE', '$.groups', 'Unknown content group.'));
        if (!Object.hasOwn(stage().visible, id) || !policy.visibleGroups.includes(id)) return failure(diag('POLICY_DENIED', '$.groups', 'The current stage or policy does not permit this group.'));
        if (reopenRequired && groupsById.get(id)!.solutionBearing) return failure(diag('INDEPENDENT_CONTEXT', '$.groups', 'Instructional content waits until the host reopens instructional work.', 'Reopen instructional work through the host (reopenInstructional) first.'));
        groups.push({ groupId: id, contentDigest: digests[id]! });
      }
      if (input.parameterDomain !== undefined) {
        if (!isRecord(input.parameterDomain) || !Object.keys(input.parameterDomain).length) return failure(diag('INVALID_INPUT', '$.parameterDomain', 'Provide parameter ranges.'));
        parameterDomain = {};
        for (const [parameter, range] of Object.entries(input.parameterDomain)) {
          const definition = manifest.parameters[parameter];
          if (!definition || !controlsByParameter.has(parameter)) return failure(diag('INVALID_REFERENCE', '$.parameterDomain', 'Unknown parameter.'));
          if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isFinite) || !(range[0] <= range[1]) || range[0] < definition.min || range[1] > definition.max)
            return failure(diag('OUT_OF_DOMAIN', `$.parameterDomain.${parameter}`, 'The range must lie inside the parameter domain.'));
          parameterDomain[parameter] = [range[0], range[1]];
        }
      }
    }
    if (pending?.state === 'requesting') return failure(diag('PERSISTENCE_PENDING', '$', 'Another authorization is in progress.'));
    const flushed = await flushFirst();
    if (flushed) return failure(flushed);
    const again = hostGate(input);
    if (again) return failure(again);
    const operationId = input.operationId as string;
    // The same request again after the host did not record it: resume it (no second reveal.requested).
    const kept = resumable(scope === 'reveal' ? 'requestReveal' : 'requestExplorationScope', operationId);
    if (kept) return authorize(kept);
    const full = room('reveal.requested', 'reveal.authorized');
    if (full) return failure(full);
    const intendedStage = instance.stage.id;
    const requested = emitted('reveal.requested', { idempotencyKey: operationId, scope, groups, intendedStage }, actor, operationId);
    const entryFor = (base: number, resume: ResumableGrant | null): PendingAuthorization => {
      const request = {
        activityId, operationId, idempotencyKey: operationId, scope, groups, ...(parameterDomain ? { parameterDomain } : {}), basedOnActivityRevision: base,
        expectedPolicyRevision: policy.revision, intendedStage, actor: actor.kind, template: templateRef, model: modelRef,
      };
      return {
        kind: scope, origin: scope === 'reveal' ? 'requestReveal' : 'requestExplorationScope', operationId, actor, labels: scope === 'reveal' ? labelsOf(groups) : [], groups: scope === 'reveal' ? groups : [], state: 'requesting',
        basedOn: { activity: base, policy: policy.revision }, revision: instance.activityRevision, epoch: revealEpoch,
        // The host refusing a resumption means this operation is not the request that produced the held grant: nothing
        // was recorded, so the request is sent as a new one based on the host's current revision.
        ...(resume ? { resume: { exposureId: resume.record.exposureId, receiptId: resume.record.receiptId }, renew: () => entryFor(instance.activityRevision, null) } : {}),
        call: () => host.recordExposureIntent(request),
        expectation: { ...receiptBase(operationId), basedOnActivityRevision: base, kind: 'exposure', scope, intendedStage, groups, ...(parameterDomain ? { parameterDomain } : {}), fingerprint: fingerprintOf(request) },
        apply(raw) {
          const receipt = raw as { receiptId: string; activityRevision: number; grant: ExposureGrant };
          // A resumed grant was issued before the host's latest step: the revision only ever moves forward.
          if (resume) { followRevision(receipt.activityRevision); resumes.delete(resume.record.exposureId); } else instance = { ...instance, activityRevision: receipt.activityRevision };
          recordGrant(receipt.receiptId, receipt.grant, intendedStage, receipt.activityRevision, actor, operationId, [requested]);
          return null;
        },
        history(raw) {
          const receipt = raw as { receiptId: string; activityRevision: number; grant: ExposureGrant };
          followRevision(receipt.activityRevision);
          recordGrant(receipt.receiptId, receipt.grant, intendedStage, receipt.activityRevision, actor, operationId, [requested], { history: true });
        },
      };
    };
    const resume = resumeFor(scope, groups, parameterDomain, intendedStage);
    return authorize(entryFor(resume ? resume.base : instance.activityRevision, resume));
  }
  /** The host-held grant a request for exactly this content resumes after a restore, if any (see {@link ResumableGrant}). */
  function resumeFor(scope: ExposureGrant['scope'], groups: readonly GroupDigest[], parameterDomain: Record<string, [number, number]> | undefined, intendedStage: string): ResumableGrant | null {
    const key = (list: readonly GroupDigest[]) => canonicalJSON([...list].map(group => `${group.groupId}\u0000${group.contentDigest}`).sort());
    for (const candidate of resumes.values()) {
      const record = candidate.record;
      if (candidate.epoch !== revealEpoch || record.scope !== scope || record.intendedStage !== intendedStage || key(record.groups) !== key(groups)) continue;
      if (!sameJSON(record.parameterDomain ?? null, parameterDomain ?? null) || record.template.digest !== templateRef.digest || record.model.digest !== modelRef.digest) continue;
      if (exposures.get(record.exposureId)?.receiptId !== record.receiptId) continue;
      return candidate;
    }
    return null;
  }

  // ---- host diagnostics (report §19: local metrics; no content) ------------------------------------------------
  function operationalDiagnostics(): ActivityDiagnostics {
    const state = session.getState();
    const queue = journalOpen ? outbox.state() : null;
    const track = preview;
    const queued = !!track && track.inFlight && !!track.params && !(track.submitted !== null && sameJSON(track.submitted, track.params));
    const shown = projection as LearnerProjection | undefined;
    return {
      activityId, template: { ...templateRef }, model: { ...modelRef }, scientificRevision: ctx.identity.scientificRevision,
      stageId: instance.stage.id, context: instance.context.kind, ui: shown?.status.ui ?? 'preparing',
      ready, suspended: state.status === 'suspended', playing: state.playing, closed: instance.closed,
      persistence: queue?.persistence ?? instance.persistence,
      outbox: { pending: queue?.pending ?? 0, limit: ctx.outboxLimit, coalesced: queue?.coalesced ?? 0, unpersistedDisplayAcks: exposures.unpersistedAcks().length },
      preview: { active: !!track, inFlight: track?.inFlight ? 1 : 0, queued: queued ? 1 : 0, updates: track?.updates ?? 0, coalesced: track?.coalesced ?? 0 },
      evaluation: { commit: summarizeLatency(latency.commit), navigate: summarizeLatency(latency.navigate), preview: summarizeLatency(latency.preview) },
      surfaces: { registered: surfaces.size, visible: [...surfaces.values()].filter(Boolean).length },
      failures: failures.map(item => ({ ...item })),
    };
  }
  /** Elements of one geometry result (points, vertices, samples or grid cells) for developer inspection. */
  function geometryElements(geometry: unknown): number {
    const record = geometry as Record<string, unknown>;
    if (Array.isArray(record.segments)) return (record.segments as { points?: unknown }[]).reduce((total, segment) => total + (Array.isArray(segment.points) ? segment.points.length : 1), 0);
    for (const key of ['points', 'vertices', 'samples', 'z', 'rows', 'observations']) if (Array.isArray(record[key])) return (record[key] as unknown[]).length;
    return 0;
  }

  // ---- snapshots, artifacts -----------------------------------------------------------------------------------
  function scientificSnapshot(): ScientificSnapshot {
    const state = session.getState();
    return {
      contract: CONTRACTS.scientific, schemaVersion: ACTIVITY_SCHEMA_VERSION, model: { ...modelRef }, scientificRevision: ctx.identity.scientificRevision, runtime: { ...MODEL_RUNTIME },
      runId: state.run!.id, ...(state.run!.restoredFrom ? { restoredFrom: state.run!.restoredFrom } : {}), params: { ...state.run!.params },
      position: structuredClone(state.frame!.position), terminal: state.frame!.terminal.reached,
      comparisons: state.comparisons.map(item => ({ runId: item.runId, label: item.label, params: { ...item.params }, position: structuredClone(item.position) })),
    };
  }
  const currentInstance = (): ActivityInstance => structuredClone({ ...instance, persistence: journalOpen ? outbox.state().persistence : instance.persistence });
  const pick = <T>(record: Record<string, T>, keep: (key: string) => boolean): Record<string, T> => Object.fromEntries(Object.entries(record).filter(([key]) => keep(key)));
  /** Template content entries the learner can see: members of visible annotation groups (derivations and sources in no group never are). */
  const visibleContent = (): string[] => template.content.filter(entry => template.groups.some(group => group.kind === 'annotation' && group.members.includes(entry.id) && visibility.groups[group.id] !== 'absent')).map(entry => entry.id);
  /**
   * Saves a backup (everything needed to restore) or a learner snapshot (projection-filtered). During a preview the
   * committed checkpoint is saved and the pending preview recorded separately; saving never commits or cancels it.
   */
  /**
   * Artifacts of saves whose host outcome is unknown (failed or lost reply), by operation ID. A retry with the same
   * operation ID resends the identical artifact, so a save the host already committed is acknowledged by the host's
   * idempotency instead of conflicting with a rebuilt one; a save that never committed stores the original checkpoint.
   */
  const unconfirmedSaves = new Map<string, ActivityArtifact>();
  /** Saves waiting for the host's reply, by operation ID; `released` once a `forget` named the artifact meanwhile. */
  const savesInFlight = new Map<string, { artifact: ActivityArtifact; released: boolean }>();
  async function saveArtifact(input: Record<string, unknown>): Promise<{ ok: true; artifact: ActivityArtifact } | Fail> {
    if (disposed) return failure(diag('DISPOSED', '$', 'This activity has been disposed.'));
    if (!ready || !session.getState().run || !session.getState().frame) return failure(diag('NOT_READY', '$', 'The activity is not ready.'));
    const kind = input.kind;
    if (kind !== 'backup' && kind !== 'learner-snapshot') return failure(diag('INVALID_INPUT', '$.kind', 'Expected backup or learner-snapshot.'));
    if (kind === 'backup' ? !policy.export.backup : !policy.export.learnerSnapshot) return failure(diag('POLICY_DENIED', '$.kind', 'The host policy does not allow this export.'));
    const full = room('artifact.saved');
    if (full) return failure(full);
    visibility = computeVis();
    const controls = new Set(Object.keys(visibility.controls));
    const shownQuantities = visibleQuantityIds(template, visibility.groups);
    const views = new Set(template.views.filter(view => visibility.groups[view.group] !== 'absent').map(view => view.id));
    // A pending draft: the active preview, or the one the host closed with `pending: 'retain'`.
    const tentative = preview && preview.params ? { previewId: preview.previewId, params: { ...preview.params }, baseRunId: preview.baseRunId } : retainedDraft ? structuredClone(retainedDraft) : null;
    // Record any journal loss first, so the backup's carried events include its record.
    if (kind === 'backup') recordLoss();
    const reviews = [...ctx.catalog.status(templateRef).reviews, ...ctx.catalog.status(modelRef).reviews].map(review => review.reviewId);
    const operationId = input.operationId as string;
    const unconfirmed = unconfirmedSaves.get(operationId);
    const built = unconfirmed?.kind === kind ? { ok: true as const, artifact: unconfirmed } : tryBuildArtifact({
      kind, artifactId: newId(), runtime: { ...MODEL_RUNTIME }, instance: currentInstance(), scientific: scientificSnapshot(), presentation: structuredClone(presentation),
      exposures: exposures.forArtifact(), journal: kind === 'backup' ? backupJournal() : outbox.checkpoint(), preview: tentative,
      ...(kind === 'backup' && lineageOf() ? { lineage: lineageOf()! } : {}),
      contentRefs: template.content.map(entry => entry.id), reviewRefs: [...new Set(reviews)], assistance: assistance.map(item => structuredClone(item)),
      ...(kind === 'learner-snapshot' ? {
        learner: {
          // Like the projection: retained runs belong to instructional work and are not part of an independent snapshot.
          scientific: snapshot => ({ ...snapshot, params: pick(snapshot.params, id => controls.has(id)), comparisons: independent() ? [] : snapshot.comparisons.map(item => ({ ...item, params: pick(item.params, id => controls.has(id)) })) }),
          presentation: snapshot => ({ ...snapshot, views: pick(snapshot.views, id => views.has(id)), displayUnits: pick(snapshot.displayUnits, id => controls.has(id) || shownQuantities.has(id)), selection: null }),
          contentRefs: visibleContent(),
        },
      } : {}),
    });
    if (!built.ok) return failure(...built.diagnostics);
    let ack: { artifactDigest: string; hostTimestamp: string };
    const flight = { artifact: built.artifact, released: false };
    savesInFlight.set(operationId, flight);
    try { ack = await host.saveArtifact({ artifact: built.artifact, operationId }); } catch (error) {
      if (savesInFlight.get(operationId) === flight) savesInFlight.delete(operationId);
      if (disposed) return failure(diag('DISPOSED', '$', 'This activity has been disposed.'));
      if (isHostRefusal(error)) {
        // The host decided not to store it: nothing is kept for a retry of the same operation.
        unconfirmedSaves.delete(operationId);
        emit('operation.failed', { operation: 'saveArtifact', code: error.code, recoverable: false }, hostActor, operationId);
        return failure(hostRefusalDiagnostic(error.code, 'The artifact was not stored.'));
      }
      // An unsent copy is kept for a retry of the same operation, unless a `forget` released it while the host answered
      // (the retry then builds a new artifact from the activity as it is now).
      if (flight.released) unconfirmedSaves.delete(operationId);
      else {
        if (!unconfirmedSaves.has(operationId) && unconfirmedSaves.size >= OPERATION_CACHE) unconfirmedSaves.delete(unconfirmedSaves.keys().next().value!);
        unconfirmedSaves.set(operationId, built.artifact);
      }
      emit('operation.failed', { operation: 'saveArtifact', code: 'PERSISTENCE_FAILED', recoverable: true }, hostActor, operationId);
      return failure(diag('PERSISTENCE_FAILED', '$', 'The host did not store the artifact.', 'Retry the save with the same operation ID.'));
    }
    if (savesInFlight.get(operationId) === flight) savesInFlight.delete(operationId);
    unconfirmedSaves.delete(operationId);
    if (disposed) return failure(diag('DISPOSED', '$', 'This activity has been disposed.'));
    ctx.hostClock.observe(ack?.hostTimestamp);
    const digest = typeof ack?.artifactDigest === 'string' && /^sha256:[0-9a-f]{64}$/.test(ack.artifactDigest) ? ack.artifactDigest : artifactDigest(built.artifact);
    emit('artifact.saved', { artifactId: built.artifact.artifactId, kind, artifactDigest: digest, cursor: built.artifact.journal.cursor.lastSequence }, hostActor, operationId);
    schedulePublish();
    return { ok: true, artifact: built.artifact };
  }
  /**
   * Journal checkpoint of a backup: the acknowledged cursor and the pending IDs, the longest prefix of the pending events
   * that fits {@link PENDING_EVENT_BYTES} (a restore resends them; the host deduplicates by eventId) and the loss record.
   */
  function backupJournal(): ActivityArtifact['journal'] {
    const checkpoint = outbox.checkpoint();
    const carried: InteractionEvent[] = [];
    let bytes = 0;
    for (const event of outbox.pendingEvents()) {
      const size = canonicalJSON(event).length;
      if (bytes + size > PENDING_EVENT_BYTES) break;
      bytes += size;
      carried.push(event);
    }
    return { ...checkpoint, ...(carried.length ? { pendingEvents: carried } : {}), ...(lost ? { lost: structuredClone(lost) } : {}) };
  }
  /** Context lineage of a backup: ended grants, and whether instructional content needs a reopening first. */
  function lineageOf(): ArtifactLineage | null {
    const ended = exposures.ended();
    const reopen = reopenRequired || independent();
    return ended.length || reopen ? { endedExposureIds: ended, reopenRequired: reopen } : null;
  }
  /**
   * Saved presentation restricted to existing views, matching cameras and listed units; it can never re-enable hidden
   * content. The selection is decided once the restored projection is known (`openRestored`): it is kept when its target
   * is selectable there, exactly as the `select` command would accept it, and cleared otherwise.
   */
  function restoredPresentation(saved: PresentationSnapshot): { snapshot: PresentationSnapshot; changed: boolean; selection: string | null } {
    let changed = false;
    const views: PresentationSnapshot['views'] = {};
    for (const [viewId, view] of Object.entries(saved.views)) {
      const spec = template.views.find(item => item.id === viewId);
      if (!spec) { changed = true; continue; }
      const camera = view.camera && (spec.kind === 'scene3d' ? view.camera.kind === '3d' : (spec.kind === 'scene2d' || spec.kind === 'plot2d') && view.camera.kind === '2d') ? view.camera : null;
      if (camera !== view.camera || view.layers.length) changed = true;
      views[viewId] = { camera, layers: [] };
    }
    const displayUnits = pick(saved.displayUnits, id => listedUnits(id).includes(saved.displayUnits[id]!));
    if (Object.keys(displayUnits).length !== Object.keys(saved.displayUnits).length) changed = true;
    return { snapshot: { ...saved, views, displayUnits, selection: null }, changed, selection: saved.selection };
  }

  // ---- restore: journal replay ---------------------------------------------------------------------------------
  interface ReplayPlan { events: InteractionEvent[]; held: number; unrecoverable: number; reason: string | null }
  /**
   * Which of the artifact's unacknowledged events to resend after a restore (report §6.3, §7.2). The host journal is a
   * prefix of the adapter's sequence, so events at or before the host cursor are already held (confirmed by the host's
   * last event ID where the artifact can tell); the carried events after it are resent with their original IDs and
   * sequences (the host deduplicates by eventId). Events the artifact did not carry, or that cannot continue the host
   * journal without a gap or a conflicting history, cannot be recovered.
   */
  function replayPlan(artifact: ActivityArtifact, cursor: { lastSequence: number; lastEventId: string | null }): ReplayPlan {
    const ids = artifact.journal.pendingEventIds, carried = artifact.journal.pendingEvents ?? [];
    if (!ids.length) return { events: [], held: 0, unrecoverable: 0, reason: null };
    const checkpoint = artifact.journal.cursor, held = cursor.lastSequence - checkpoint.lastSequence;
    if (held < 0) return { events: [], held: 0, unrecoverable: ids.length, reason: 'the host journal ends before the checkpoint' };
    if (held >= ids.length) return { events: [], held: ids.length, unrecoverable: 0, reason: null };
    const expected = held === 0 ? checkpoint.lastEventId : ids[held - 1]!;
    if (expected !== null && cursor.lastEventId !== null && cursor.lastEventId !== expected)
      return { events: [], held: 0, unrecoverable: ids.length - held, reason: 'the host journal continued with other events' };
    const events = carried.slice(held).filter((event, index) => event.sequence === cursor.lastSequence + 1 + index);
    return { events, held, unrecoverable: ids.length - held - events.length, reason: events.length < ids.length - held ? 'the artifact did not carry them' : null };
  }
  /** Resends the planned events in order and records the rest as a journal loss (never a silent gap). */
  function applyReplay(plan: ReplayPlan, artifact: ActivityArtifact): void {
    let replayed = 0;
    for (const event of plan.events) {
      if (!outbox.append(structuredClone(event)).ok) break;
      replayed++;
    }
    const missing = plan.unrecoverable + plan.events.length - replayed;
    if (replayed) {
      scheduleFlush();
      restoreNotes.push(`${replayed} events that were unacknowledged when the artifact was saved were resent to the host journal (the host deduplicates them by eventId).`);
    }
    if (plan.held) restoreNotes.push(`${plan.held} events that were unacknowledged when the artifact was saved are already in the host journal.`);
    if (missing) {
      // Types are known only for carried events; the others are counted by ID.
      const carriedTypes = (artifact.journal.pendingEvents ?? []).slice(plan.held + replayed).map(event => event.type);
      // The loss is expressed in the restored journal's terms: it follows the last event of the journal the activity now
      // continues (the host cursor plus any resent events), which never lies past the end of a later checkpoint, even
      // when the host journal ends before the artifact's checkpoint (activity-runtime §5, §9).
      const after = lastSequence();
      noteLoss(carriedTypes, diag('PERSISTENCE_FAILED', '$', 'Unacknowledged events could not be recovered.'), missing, after);
      restoreNotes.push(`${missing} events that were unacknowledged when the artifact was saved could not be recovered (${plan.reason ?? 'the outbox could not accept them'}); the loss is recorded in the journal after sequence ${after}${after < artifact.journal.cursor.lastSequence ? ` (the artifact's checkpoint ended at sequence ${artifact.journal.cursor.lastSequence})` : ''} and summaries report the record as incomplete.`);
    }
  }

  // ---- lifecycle ----------------------------------------------------------------------------------------------
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    // The final projection shows the disposed state and no content. A surface that is still mounted hears it once, at
    // the end of disposal (report §10.4 `disposed`, A43), so it never keeps showing figures or live controls; no
    // listener is called after that.
    if (ready) { try { const last = build(); last.projectionId = newId(); projection = deepFreeze(last); } catch { /* Keep the last published projection. */ } }
    lifetime.abort();
    const last = ready && projection ? [...listeners] : [];
    listeners.clear();
    surfaces.clear();
    preview = null;
    pending = null;
    revealEpoch++;
    try { session.dispose(); } catch { /* Already disposed. */ }
    try { outbox.dispose(); } catch { /* Already disposed. */ }
    operations.clear();
    unconfirmedSaves.clear();
    savesInFlight.clear();
    ctx.onDisposed();
    for (const listener of last) { try { listener(projection); } catch { /* A listener cannot affect disposal. */ } }
  }

  const prepared: PreparedActivity = {
    activityId,
    get instance() { return currentInstance(); },
    binding,
    host: hostControl,
  };

  async function load(params: Record<string, number>, signal?: AbortSignal): Promise<Fail | null> {
    try { await session.load(manifest, params, sessionGuard(), signal ?? lifetime.signal); } catch (error) {
      return failure(...(disposed ? [diag('DISPOSED', '$', 'This activity has been disposed.')] : toDiagnostics(error)));
    }
    return disposed ? failure(diag('DISPOSED', '$', 'This activity has been disposed.')) : null;
  }

  return {
    activityId,
    get disposed() { return disposed; },
    async open(input) {
      openJournal(0);
      try {
        const ack = await host.registerActivity({ instance: currentInstance(), operationId: input.operationId });
        ctx.hostClock.observe(ack?.hostTimestamp);
      } catch (error) {
        return failure(isHostRefusal(error) ? hostRefusalDiagnostic(error.code, 'The activity was not registered.')
          : diag('PERSISTENCE_FAILED', '$', 'The host did not register the activity.', 'Retry prepare with the same operation ID.'));
      }
      if (disposed) return failure(diag('DISPOSED', '$', 'This activity has been disposed.'));
      const loaded = await load(input.params, input.signal);
      if (loaded) return loaded;
      ready = true;
      visibility = computeVis();
      const actor = hostActor;
      emit('activity.prepared', { templateId: templateRef.templateId, templateVersion: templateRef.version, mode: instance.mode, stageId: instance.stage.id }, actor, input.operationId);
      emit('activity.opened', { stageId: instance.stage.id }, actor, input.operationId);
      const state = session.getState();
      emit('parameters.committed', withQuantities({ runId: state.run!.id, previousRunId: null, params: { ...state.run!.params }, cause: 'initial', visibleParameters: shownParameters() }, visibleQuantities(state.frame)), actor, input.operationId);
      publish();
      void outbox.flush();
      return null;
    },
    async openRestored(input) {
      const { artifact } = input.restored;
      // A backup restores only an activity the host already holds (report §14: the host owns the activity; a portable host
      // backup is imported into the host store first). The host's journal cursor is read before anything is registered,
      // so a host that does not hold the activity refuses the read and never creates one from the artifact's claims.
      let cursor;
      try { cursor = await host.getJournalCursor({ activityId }); } catch (error) {
        return failure(isHostRefusal(error) ? hostRefusalDiagnostic(error.code, 'The activity was not restored.')
          : diag('PERSISTENCE_FAILED', '$', 'The host did not return its journal cursor for this activity.', 'Retry the restore when the host is available. A backup restores only an activity the host holds: import the host backup that holds it first.'));
      }
      if (disposed) return failure(diag('DISPOSED', '$', 'This activity has been disposed.'));
      if (!validateRecord(MESSAGES.journalCursor, cursor).ok || cursor.activityId !== activityId) return failure(diag('PERSISTENCE_FAILED', '$', 'The host returned an invalid journal cursor.'));
      if (cursor.lastSequence < artifact.journal.cursor.lastSequence) restoreNotes.push('The host journal ends before the artifact checkpoint; new events continue after the host cursor.');
      // The host's own exposure and assistance records (optional HostPort read): restoring an earlier checkpoint must not
      // erase history the host holds (report §6.3, §6.4).
      let hostRecords: ActivityRecords | null = null;
      /** How the read of the host's records failed, when the host provides the read: a refusal, or a transient failure. */
      let recordsFailure: { kind: 'refused'; code: HostRefusalCode } | { kind: 'failed' | 'invalid' } | null = null;
      if (typeof host.getActivityRecords === 'function') {
        try {
          const records = await host.getActivityRecords({ activityId });
          if (validateRecord(MESSAGES.activityRecords, records).ok && records.activityId === activityId) hostRecords = records;
          else {
            recordsFailure = { kind: 'invalid' };
            ledgerLimitations.push('The host returned invalid activity records; exposure and assistance history is known only from the artifact.');
          }
        } catch (error) {
          recordsFailure = isHostRefusal(error) ? { kind: 'refused', code: error.code } : { kind: 'failed' };
          ledgerLimitations.push('The host did not return its activity records; exposure and assistance history is known only from the artifact.');
        }
        if (disposed) return failure(diag('DISPOSED', '$', 'This activity has been disposed.'));
      } else ledgerLimitations.push('The host does not provide its exposure and assistance records; history recorded after the checkpoint is known only from the host.');
      // Said in the restore report too: frozen assistance snapshots of this activity report `complete: false`.
      if (!hostRecords) restoreNotes.push(`${ledgerLimitations.at(-1)!} Frozen assistance snapshots of this activity are marked incomplete.`);
      restoredAs = input.restored.restored;
      const restrict = (note: string): void => { if (restoredAs === 'exact') restoredAs = 'restricted'; restoreNotes.push(note); };
      // The host, not the artifact, is the authority for the stage, the activity revision, closure and the context lineage
      // (report §4.2, §6.4, §14; `restoreClaims`): the restored activity adopts the host's activity state. A host without
      // it confirms the saved state only by holding this exact artifact as its latest checkpoint (the checkpoint digest of
      // its journal cursor): the host stored those bytes, so their stage, revision, closure and lineage are the host's own
      // as of that checkpoint. Anything else cannot be confirmed and is not reopened as a live activity.
      const claimed = { stage: instance.stage.id, revision: instance.activityRevision };
      const reported = hostRecords?.activity ?? null;
      const hostActivity = reported && stages.has(reported.stage) ? reported : null;
      const checkpoint = cursor.checkpointDigest !== null && cursor.checkpointDigest === input.restored.artifactDigest;
      if (!hostActivity && !checkpoint && recordsFailure) {
        // The host provides the read but did not answer it: whether it can confirm the saved stage, activity revision and
        // closure is unknown, not refused. A host refusal is the host's decision; any other failure is transient, so the
        // restore can be retried with the same operation ID once the host answers (nothing was registered).
        if (recordsFailure.kind === 'refused') return failure(hostRefusalDiagnostic(recordsFailure.code, 'The host did not return its activity records; the activity was not restored.'));
        return failure(diag('PERSISTENCE_FAILED', '$', recordsFailure.kind === 'invalid'
          ? 'The host returned invalid activity records, so the stage, activity revision and closure it holds for this activity could not be read; this backup is not the host\'s latest checkpoint, so the restore needs them. Nothing was registered.'
          : 'The host did not return its activity records, so the stage, activity revision and closure it holds for this activity could not be read; this backup is not the host\'s latest checkpoint, so the restore needs them. Nothing was registered.',
        'Retry the restore with the same operation ID when the host is available.'));
      }
      if (!hostActivity && !checkpoint) {
        return failure(diag('UNSUPPORTED_ARTIFACT', '$.instance.stage', reported
          ? 'The host reported a stage the installed template does not declare, and it does not hold this artifact as its latest checkpoint: the saved stage, activity revision and closure cannot be confirmed.'
          : 'The host does not report this activity\'s stage, activity revision and closure, and it does not hold this artifact as its latest checkpoint: the saved state cannot be confirmed.',
        'Restore the host\'s latest checkpoint of this activity, or show this artifact read-only with archivalView(artifact, { audience }). A host that reports its activity state (ActivityRecords.activity) restores any checkpoint it holds the activity for.'));
      }
      if (hostActivity) {
        if (hostActivity.closed && !instance.closed) {
          instance = { ...instance, closed: true };
          restoredAs = 'read-only';
          restoreNotes.push('The host has closed this activity; it is restored read-only.');
        }
        if (hostActivity.stage !== claimed.stage || hostActivity.activityRevision !== claimed.revision) {
          instance = { ...instance, activityRevision: hostActivity.activityRevision, stage: hostActivity.stage === claimed.stage ? instance.stage : { id: hostActivity.stage, enteredAtSequence: cursor.lastSequence } };
          restrict(`The host holds this activity at stage ${hostActivity.stage}, activity revision ${hostActivity.activityRevision}; the artifact was saved at stage ${claimed.stage}, activity revision ${claimed.revision}. The host's stage and revision govern the restored activity.`);
        }
      } else restrict(`${reported ? 'The host reported a stage the installed template does not declare' : 'The host did not report its stage and activity revision'}; the artifact is the host's latest checkpoint, so its saved stage, activity revision and closure are used (the host may have advanced them since), and the restore is restricted.`);
      if (!hostRecords) restrict('Without the host\'s records the saved exposure grants cannot be confirmed: saved exposure grants do not make content visible, and solution-bearing content is shown again only after the host authorizes it.');
      // Which saved grants the host's context lineage counts, and whether instructional content waits for a reopening
      // (report §6.4, A19, A26). The artifact's own lineage marks (`input.restored`) only ever restrict; the host decides.
      const lineage = hostActivity?.lineage ?? null;
      const savedReopen = input.restored.reopenRequired;
      let lineageCounts: (record: ExposureRecord) => boolean;
      if (lineage) {
        const held = lineage.context, current = instance.context;
        const agrees = held.kind === current.kind && (held.kind === 'instructional' || current.kind === 'independent' && held.taskRef === current.taskRef);
        lineageCounts = record => agrees && record.activityRevision >= lineage.fromActivityRevision;
        // The host still holds the activity in independent work, or the artifact's pending reopening is not superseded by
        // a context change the host recorded after the checkpoint.
        reopenRequired = current.kind === 'instructional' && (held.kind === 'independent' || savedReopen && lineage.fromActivityRevision <= claimed.revision);
        if (reopenRequired && !savedReopen) restrict('The host holds this activity in independent work: instructional content stays hidden until the host reopens instructional work (reopenInstructional records the assistance).');
      } else if (checkpoint) {
        // The host's own latest checkpoint: its lineage marks are the ones the host stored.
        lineageCounts = () => true;
        reopenRequired = savedReopen;
      } else {
        // The host reports its stage but not its context lineage, and this is not its latest checkpoint: no saved grant can
        // be placed in a lineage, and whether the activity left independent work is unknown, so instructional content waits
        // for a reopening recorded through the host (conservatively treated as potentially assisted).
        lineageCounts = () => false;
        reopenRequired = instance.context.kind === 'instructional';
        restrict('The host did not report its context lineage and does not hold this artifact as its latest checkpoint: saved exposure grants do not make content visible, and instructional solution-bearing content waits until the host reopens instructional work (reopenInstructional records the assistance).');
      }
      // The restored instance — in the host's stage and revision — is registered only now.
      try {
        const ack = await host.registerActivity({ instance: currentInstance(), operationId: input.operationId });
        ctx.hostClock.observe(ack?.hostTimestamp);
      } catch (error) {
        return failure(isHostRefusal(error) ? hostRefusalDiagnostic(error.code, 'The restored activity was not registered.')
          : diag('PERSISTENCE_FAILED', '$', 'The host did not register the restored activity.', 'Retry the restore with the same operation ID.'));
      }
      if (disposed) return failure(diag('DISPOSED', '$', 'This activity has been disposed.'));
      const replay = replayPlan(artifact, cursor);
      openJournal(cursor.lastSequence);
      // Re-evaluate the saved position (and each retained comparison) in the worker and compare with the saved state.
      const saved = artifact.scientific;
      const loaded = await load(saved.params, input.signal);
      if (loaded) return loaded;
      const request = (position: FramePosition): PositionRequest => position.kind === 'index' ? { kind: 'index', index: position.index } : position.kind === 'time' ? { kind: 'time', time: position.time } : { kind: 'static' };
      try {
        for (const comparison of saved.comparisons) {
          await session.restore({ params: comparison.params, position: request(comparison.position), restoredFrom: comparison.runId }, sessionGuard(), input.signal ?? lifetime.signal);
          session.retainComparison(comparison.label, sessionGuard());
        }
        await session.restore({ params: saved.params, position: request(saved.position), restoredFrom: saved.runId }, sessionGuard(), input.signal ?? lifetime.signal);
      } catch (error) { return failure(...(disposed ? [diag('DISPOSED', '$', 'This activity has been disposed.')] : toDiagnostics(error))); }
      if (disposed) return failure(diag('DISPOSED', '$', 'This activity has been disposed.'));
      const frame = session.getState().frame!;
      if (!sameJSON(frame.position, saved.position) || frame.terminal.reached !== saved.terminal)
        return failure(diag('UNSUPPORTED_ARTIFACT', '$.scientific', 'Re-evaluating the saved position does not reproduce the saved state.', 'Show the artifact read-only with archivalView(artifact, { audience }); it is not reopened with a different result.'));
      const restoredView = restoredPresentation(artifact.presentation);
      presentation = restoredView.snapshot;
      if (!validateRecord(CONTRACTS.presentation, presentation).ok) presentation = { ...presentation, views: {}, displayUnits: {} };
      // A saved grant counts only when the artifact's own lineage marks allow it, the host holds the same grant (exposure ID,
      // receipt ID and content) AND the host's context lineage counts it: the host decides which authorizations exist and
      // which still count (report §6.3, §6.4, §14). Any other grant stays in the history and never makes content visible.
      const heldByHost = new Map((hostRecords?.exposures ?? []).map(record => [record.exposureId, record]));
      const confirmed = (record: ExposureRecord): boolean => { const held = heldByHost.get(record.exposureId); return !!held && sameGrant(record, held); };
      const counts = (record: ExposureRecord): boolean => input.restored.counts(record) && confirmed(record) && lineageCounts(record);
      const { changed } = exposures.restore(artifact.exposures, counts);
      if (changed.length) restoreNotes.push(`${changed.length} exposure records were authorized without a persisted display acknowledgement and are restored as uncertain (potentially seen).`);
      const ended = artifact.exposures.filter(record => !input.restored.counts(record)).length;
      if (ended) restoreNotes.push(`${ended} exposure records belong to an ended or independent context lineage; they stay in the history and do not make content visible.`);
      const unconfirmedGrants = artifact.exposures.filter(record => input.restored.counts(record) && !confirmed(record)).length;
      if (unconfirmedGrants) restrict(hostRecords ? `${unconfirmedGrants} exposure grants saved in the artifact are not held by the host as saved; they stay in the history and do not make content visible.`
        : `${unconfirmedGrants} exposure grants saved in the artifact are kept as history and do not make content visible until the host authorizes the content again.`);
      const lineageEnded = lineage ? artifact.exposures.filter(record => input.restored.counts(record) && confirmed(record) && !lineageCounts(record)).length : 0;
      if (lineageEnded) restrict(`${lineageEnded} exposure grants saved in the artifact belong to a context lineage the host has ended or does not hold; they stay in the history and do not make content visible.`);
      if (reopenRequired && savedReopen) restoreNotes.push('The artifact was saved during independent work: instructional content stays hidden until the host reopens instructional work (reopenInstructional records the assistance).');
      else if (savedReopen && !reopenRequired && instance.context.kind === 'instructional') restoreNotes.push('The artifact was saved during independent work; the host recorded a context change after the checkpoint, so its context lineage governs: saved grants stay history and no reopening is required.');
      if (hostRecords) {
        const merged = exposures.mergeHost(hostRecords.exposures);
        if (merged.added.length) restoreNotes.push(`${merged.added.length} exposure records came from the host's records and not from the artifact; they are kept as history (potentially seen) and do not make content visible.`);
        if (merged.updated.length) restoreNotes.push(`${merged.updated.length} exposure records were updated from the host's records (display acknowledged by the host).`);
        if (merged.mismatched.length) restoreNotes.push(`${merged.mismatched.length} host exposure records name another receipt than the artifact's record of the same ID; the artifact's record is kept.`);
      }
      // Grants the host committed after this checkpoint whose receipts never reached the saving process (a crash after the
      // host's commit, before its reply) stay history; re-issuing exactly such a request resumes it (`ResumableGrant`).
      if (hostRecords && hostActivity && hostActivity.activityRevision > claimed.revision) {
        const saved = new Set(artifact.exposures.map(record => record.exposureId));
        const later = hostRecords.exposures.map(record => record.activityRevision).filter(revision => revision > claimed.revision);
        for (const record of hostRecords.exposures) {
          if (saved.has(record.exposureId) || record.scope === 'stage' || (record.displayStatus !== 'authorized' && record.displayStatus !== 'uncertain') || record.activityRevision <= claimed.revision) continue;
          resumes.set(record.exposureId, { record: structuredClone(record), base: Math.max(claimed.revision, ...later.filter(revision => revision < record.activityRevision)), epoch: revealEpoch });
        }
      }
      // Displayed before the save, acknowledgement not confirmed by the host (in flight or failed, for example a crash
      // before the host committed it): the content stays displayed and the same acknowledgement is resent below, so the
      // host can record the display next to its own restart uncertainty (activity-runtime §4 steps 5–6).
      const unconfirmedAcks = exposures.unpersistedAcks();
      if (unconfirmedAcks.length) restoreNotes.push(`${unconfirmedAcks.length} exposure records were displayed without a display acknowledgement confirmed by the host; the same acknowledgements are resent.`);
      // Assistance recorded before the save stays part of every later frozen snapshot (A19, A26); restore never erases it.
      if (artifact.assistance) assistance.push(...artifact.assistance.map(item => structuredClone(item)));
      else if (artifact.migratedFrom) {
        restoreNotes.push('The migrated artifact lists no assistance receipts because its original format had no such list; assistance recorded before it was saved is known only from the host journal.');
        if (!hostRecords) ledgerLimitations.push('The migrated artifact lists no assistance receipts and the host records were not read; earlier assistance is known only from the host journal.');
      }
      if (hostRecords) {
        const { added, inconsistent } = mergeHostAssistance(hostRecords);
        if (inconsistent) restoreNotes.push(`${inconsistent} host assistance records name an exposure record the host did not return; they are not merged.`);
        if (added) restoreNotes.push(`${added} assistance records came from the host's records and not from the artifact.`);
      }
      // Journal losses before the checkpoint stay part of the record, expressed in the restored journal's terms: on a host
      // journal that ends before the checkpoint the loss follows the host cursor (activity-runtime §5, §9), so every later
      // backup stays valid. A closed activity keeps its retained draft.
      if (artifact.journal.lost) {
        const carried = artifact.journal.lost;
        lost = { ...structuredClone(carried), afterSequence: Math.min(carried.afterSequence, cursor.lastSequence) };
        if (carried.afterSequence > cursor.lastSequence) restoreNotes.push(`The journal loss saved after sequence ${carried.afterSequence} is recorded after sequence ${cursor.lastSequence}, where the host journal ends.`);
      }
      // The draft is re-based on the restored run (the same committed state, `restoredFrom` the saved run).
      if (instance.closed && artifact.pending.kind === 'preview') retainedDraft = { previewId: artifact.pending.previewId, params: { ...artifact.pending.params }, baseRunId: session.getState().run?.id ?? artifact.pending.baseRunId };
      restored = true;
      ready = true;
      visibility = computeVis();
      // The permitted presentation (report §14, A38): a saved selection is kept when the restored projection offers its
      // target to `select`, and cleared otherwise; only an actual removal is reported.
      let presentationRestricted = restoredView.changed;
      if (restoredView.selection !== null) {
        if (selectable(build()).has(restoredView.selection)) presentation = { ...presentation, selection: restoredView.selection };
        else presentationRestricted = true;
      }
      if (presentationRestricted) restoreNotes.push('Presentation state was restricted to the current views, units and visible content.');
      applyReplay(replay, artifact);
      emit('artifact.restored', {
        artifactId: artifact.artifactId, kind: artifact.kind, artifactDigest: input.restored.artifactDigest, restored: restoredAs,
        ...(artifact.migratedFrom ? { migratedFrom: { contract: artifact.migratedFrom.contract, version: artifact.migratedFrom.version } } : {}),
      }, hostActor, input.operationId);
      // A closed activity is a historical card: like `close`, its session is suspended at once, so it holds no worker
      // lease (report §9, lifecycle §2); a closed activity never resumes.
      if (instance.closed) session.suspend();
      publish();
      for (const record of unconfirmedAcks) persistAck(record);
      return null;
    },
    notes: () => [...restoreNotes],
    restoration: () => restoredAs,
    prepared: () => prepared,
    state(audience) {
      // Revocation and expiry by host time are judged at every read (report §5.3): a teacher or full-inspection tutor
      // receives no scientific state or exposures from a blocked activity; the host audience still does.
      const standing = readStanding();
      const state = session.getState();
      const inspection = audience === 'teacher' && policy.inspection.teacher || audience === 'tutor' && policy.inspection.tutor === 'full';
      const full = audience === 'host' || inspection && standing === null;
      const base: AudienceState = {
        audience, activityId, instance: full ? currentInstance() : { ...currentInstance(), initialParameters: Object.fromEntries(Object.entries(instance.initialParameters).filter(([id]) => visibility.controls[id])) },
        projection, committed: !preview,
        guards: { scientificVersion: state.version, runId: state.run?.id ?? null, activityRevision: instance.activityRevision, policyRevision: policy.revision, presentationRevision: presentation.revision, hostSessionRevision: instance.hostSessionRevision },
        persistence: outbox.state().persistence, standing: standing?.code ?? null,
      };
      if (full && state.run && state.frame) {
        base.scientific = { ...scientificSnapshot(), quantities: structuredClone(state.frame.quantities) };
        base.exposures = exposures.all().map(record => structuredClone(record));
      }
      return base;
    },
    summary(options) {
      if (disposed) return failure(diag('DISPOSED', '$', 'This activity has been disposed.'));
      const audience = options?.audience;
      if (!['learner', 'tutor', 'teacher', 'host'].includes(audience)) return failure(diag('INVALID_INPUT', '$.audience', 'Unknown audience.'));
      if (audience === 'teacher' && !policy.inspection.teacher) return failure(diag('POLICY_DENIED', '$.audience', 'The host policy does not allow teacher inspection.'));
      // Teacher summaries are authorized by the policy, so they end with it (revocation, expiry by host time).
      const standing = readStanding();
      if (standing && audience === 'teacher') return failure(standing);
      const result = trySummarize({
        events: outbox.acknowledgedEvents(), pending: outbox.pendingEvents(), trimmedBefore: outbox.trimmedBefore() + forgottenEvents, instance: currentInstance(),
        template, manifest, exposures: exposures.all().map(record => structuredClone(record)), audience,
        // Through the journal's last sequence by default, so events released by `forget` are reported as omitted.
        ...(options.fromSequence !== undefined ? { fromSequence: options.fromSequence } : {}), toSequence: options.toSequence ?? lastSequence(),
        ...(options.limits !== undefined ? { limits: options.limits } : {}), coalescedViewChanges: outbox.state().coalesced,
        ...(lost ? { journalLoss: structuredClone(lost) } : {}), reviewNotice,
      });
      return result.ok ? result.summary : failure(...result.diagnostics);
    },
    diagnostics: () => operationalDiagnostics(),
    developer() {
      // A separate entry (report §6.2): refused unless the current host policy enables developer inspection.
      if (!policy.inspection.developer) return failure(diag('POLICY_DENIED', '$.inspection.developer', 'The host policy does not enable developer inspection for this activity.', 'Enable inspection.developer in the host policy for a development context; it stays off in ordinary Study Harness use.'));
      // Authorized by the policy, so it ends with it (revocation, expiry by host time).
      const standing = readStanding();
      if (standing) return failure(standing);
      const state = session.getState();
      const { frame, kind } = disposed ? { frame: null, kind: 'committed' as const } : displayedFrame(state);
      const current = disposed ? visibility : computeVis();
      const geometry: DeveloperInspection['geometry'] = {};
      if (frame) for (const [id, result] of Object.entries(frame.geometry)) geometry[id] = { kind: result.kind, elements: geometryElements(result) };
      return {
        activityId, template: { ...templateRef }, model: { ...modelRef }, scientificRevision: ctx.identity.scientificRevision, runtime: { ...MODEL_RUNTIME },
        stage: { id: stage().id, kind: stage().kind }, context: instance.context.kind,
        guards: { scientificVersion: state.version, runId: state.run?.id ?? null, activityRevision: instance.activityRevision, policyRevision: policy.revision, presentationRevision: presentation.revision, hostSessionRevision: instance.hostSessionRevision },
        visibility: { groups: { ...current.groups }, controls: { ...current.controls }, digests: { ...digests } },
        frame: frame ? { frameId: frame.frameId, kind, position: structuredClone(frame.position), terminal: frame.terminal.reached } : null,
        scientific: state.run && state.frame ? scientificSnapshot() : null,
        quantities: frame ? structuredClone(frame.quantities) as Record<string, unknown> : {},
        geometry, exposures: exposures.all().map(record => structuredClone(record)),
        preview: preview ? { previewId: preview.previewId, parameter: preview.parameter, gesture: preview.gesture, rendered: preview.rendered.length, dropped: preview.dropped } : null,
        diagnostics: operationalDiagnostics(),
      };
    },
    async sample(request, signal) {
      if (disposed) return failure(diag('DISPOSED', '$', 'This activity has been disposed.'));
      // The same standing checks as every command, before any worker lease (report §5.3, §8.6).
      if (!ready) return failure(diag('NOT_READY', '$', 'The activity is not ready.', 'Wait until the activity is prepared, then repeat.'));
      if (unsupported) return failure(unsupported);
      if (stale) return failure(stale);
      const standing = policyStanding(policy, ctx.hostClock.now());
      if (standing) return failure(blockOnStanding(standing));
      const revoked = revocationDiagnostic(ctx.catalog, templateRef, modelRef);
      if (revoked) { contentRevoked('catalogue', revoked); return failure(revoked); }
      if (!policy.sampling.allowed || policy.revoked) return failure(diag('POLICY_DENIED', '$', 'The host policy does not allow sampling.'));
      if (request.audience !== 'host' && !(request.audience === 'teacher' && policy.inspection.teacher)) return failure(diag('POLICY_DENIED', '$.audience', 'Sampling is available to the host and to authorized teachers only.'));
      if (!Array.isArray(request.positions) || request.positions.length > policy.sampling.maxPositions) return failure(diag('RESOURCE_LIMIT', '$.positions', 'Too many sample positions for the host policy.'));
      try {
        const result = await session.sample({ params: request.parameters, positions: request.positions }, signal);
        if (disposed) return failure(diag('DISPOSED', '$', 'This activity has been disposed.'));
        return { ok: true, frames: structuredClone(result.frames) as unknown[], provenance: { model: { ...result.model }, scientificRevision: result.identity.scientificRevision, runtime: { ...MODEL_RUNTIME } } };
      } catch (error) { return failure(...toDiagnostics(error)); }
    },
    dispose,
  };
}
