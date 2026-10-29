/**
 * Study Harness activity contracts, schema 1.0. JSON-compatible, DOM-free and provider-neutral.
 * The JSON Schemas in ./schemas.ts are authoritative; these types are checked against them by tests.
 */
import type { CapabilityRef, FramePosition, ModelManifest, ModelRef, PositionRequest, QuantityResult, UnitId } from '@explorable-models/core/model';
import type { TemplateDiscovery } from './api.js';

export const ACTIVITY_SCHEMA_VERSION = '1.0' as const;
export const CONTRACTS = Object.freeze({
  template: 'study-harness.activity-template',
  instance: 'study-harness.activity-instance',
  policy: 'study-harness.host-policy',
  scientific: 'study-harness.scientific-snapshot',
  presentation: 'study-harness.presentation-snapshot',
  event: 'study-harness.interaction-event',
  exposure: 'study-harness.exposure-record',
  summary: 'study-harness.interaction-summary',
  artifact: 'study-harness.activity-artifact',
  review: 'study-harness.review-record',
  exposureReceipt: 'study-harness.exposure-receipt',
  stageReceipt: 'study-harness.stage-receipt',
  assistanceReceipt: 'study-harness.assistance-receipt',
  // Additive in 1.0: installed runtime capability records with their enforced limits (capabilities.ts, report §13).
  capability: 'study-harness.capability-record',
} as const);
export type ContractName = typeof CONTRACTS[keyof typeof CONTRACTS];

export interface TemplateRef { templateId: string; version: string; digest: string }
export interface Diagnostic { code: DiagnosticCode; path: string; message: string; recovery?: string }

/** Stable diagnostic vocabulary (report §5.3). Messages never include hidden content. */
export type DiagnosticCode =
  | 'UNSUPPORTED_CAPABILITY' | 'INVALID_REFERENCE' | 'INVALID_INPUT' | 'SCHEMA' | 'CONSTRAINT_VIOLATION' | 'OUT_OF_DOMAIN'
  | 'UNDEFINED_CALCULATION' | 'NUMERICAL_LIMIT' | 'STALE_MODEL_REVISION' | 'STALE_ACTIVITY_REVISION' | 'STALE_POLICY_REVISION'
  | 'STALE_HOST_REVISION' | 'STALE_PRESENTATION_REVISION' | 'POLICY_DENIED' | 'POLICY_EXPIRED' | 'CONTENT_REVOKED' | 'REVIEW_UNVERIFIED'
  | 'PERSISTENCE_PENDING' | 'PERSISTENCE_FAILED' | 'PERSISTENCE_BACKPRESSURE' | 'WORKER_ERROR' | 'WORKER_TIMEOUT'
  | 'UNSUPPORTED_ARTIFACT' | 'MIGRATION_REQUIRED' | 'INTEGRITY_FAILURE' | 'CANCELLED' | 'DISPOSED' | 'CONFLICT'
  | 'OPERATION_CONFLICT' | 'PREVIEW_ACTIVE' | 'NOT_READY' | 'RESOURCE_LIMIT' | 'RECEIPT_MISMATCH' | 'CAPTURE_REJECTED'
  | 'INDEPENDENT_CONTEXT' | 'NOT_FOUND'
  // Authoring-time semantic validation (template/policy/instance cross-references).
  | 'DUPLICATE_ID' | 'KIND_MISMATCH' | 'UNIT_MISMATCH' | 'EQUATION_DISCLOSURE' | 'MISSING_EQUIVALENT'
  // Authoring-time warnings (`templateWarnings`; additive in 1.0): declared content the stages never show, unused declarations.
  | 'NEVER_VISIBLE' | 'UNREFERENCED';

// ---------------------------------------------------------------------------------------------
// Activity template
// ---------------------------------------------------------------------------------------------
export type GroupKind = 'view' | 'mark' | 'quantity' | 'equation' | 'dataset' | 'control' | 'annotation' | 'alternative';
export type Visibility = 'absent' | 'fixed' | 'interactive';
export interface ContentGroup {
  id: string;
  kind: GroupKind;
  label: string;
  description: string;
  /** Solution-bearing groups need a host exposure receipt before display. */
  solutionBearing: boolean;
  /** IDs of views, marks, quantities, equations, controls, annotations or alternatives in this group. */
  members: string[];
}

export type MarkKind = 'curve' | 'point' | 'points' | 'arrow' | 'segment' | 'segments' | 'polygon' | 'angle' | 'region' | 'label' | 'trace' | 'bar' | 'grid' | 'surface' | 'vector-field';
export type MarkRole = 'primary' | 'secondary' | 'accent' | 'muted' | 'positive' | 'negative' | 'warning' | 'reference';
export type MarkerShape = 'circle' | 'square' | 'diamond' | 'triangle' | 'cross' | 'none';
export interface LabelPlacement { anchor: 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw' | 'center'; offset: [number, number]; leader: boolean; maxWidthEm: number }
export interface MarkSpec {
  id: string;
  kind: MarkKind;
  group: string;
  label: string;
  /** Geometry ID or quantity IDs from the model manifest. Rendering never recomputes them. */
  bindings: { geometry?: string; at?: string; vector?: string; from?: string; to?: string; vertices?: string; value?: string; origin?: string };
  style: { role: MarkRole; dash: 'solid' | 'dashed' | 'dotted'; marker: MarkerShape; weight: 'thin' | 'regular' | 'bold' };
  text?: string;
  placement?: LabelPlacement;
  /** Draggable point: maps the point's coordinates to parameters, always with an exact alternative. */
  drag?: { x?: string; y?: string };
  /**
   * What the bound segments depict (additive in 1.0; absent means `bounded`). `line`: each segment is a piece of an
   * unbounded line (a tangent, a secant, an invariant direction) that the renderer extends to and clips at the view. Its
   * endpoints are not data, so a line leaving the view is not reported as out-of-view data and does not count toward
   * the data extent. Only `segment`/`segments` marks of 2D views may use it.
   */
  extent?: 'bounded' | 'line';
}
export type ViewKind = 'scene2d' | 'plot2d' | 'values' | 'equation' | 'table' | 'scene3d';
export interface AxisSpec { label: string; unit: UnitId; quantity?: string }
export interface ViewSpec {
  id: string;
  kind: ViewKind;
  group: string;
  title: string;
  description: string;
  /** [xmin, xmax, ymin, ymax] (2D) in canonical model units; authored teaching default, never auto-rescaled silently. */
  bounds?: [number, number, number, number];
  /** [xmin, xmax, ymin, ymax, zmin, zmax] for scene3d. */
  bounds3?: [number, number, number, number, number, number];
  equalAspect: boolean;
  axes?: { x: AxisSpec; y: AxisSpec; z?: AxisSpec };
  marks: MarkSpec[];
  /** For values/table views: quantity IDs. */
  quantities?: string[];
  /** For equation views: equation IDs. */
  equations?: string[];
  /** Table rows for discrete traces: geometry ID whose points become rows. */
  rowsFrom?: string;
}
export interface ControlSpec {
  parameter: string;
  group: string;
  label: string;
  /** Allowed display units; the first is the default. Conversion happens at the boundary. */
  displayUnits: UnitId[];
  slider: boolean;
  exact: boolean;
  /** UI increment in the default display unit. */
  step: number;
  description: string;
  /**
   * Optional and additive in 1.0: the presentation section the control belongs to (report §10.2 "group related
   * parameters"), for example `{ id: 'matrix', label: 'Matrix M' }`. Controls that share a section ID are rendered
   * together as one labelled group, in the order of the first control of each section; every control of a section
   * must carry the same label. Presentation only: it never changes visibility (that is `group`) or scientific state.
   */
  section?: ControlSection;
}
/** Presentation section of a control (see {@link ControlSpec.section}). */
export interface ControlSection { id: string; label: string }
export interface ScenarioSpec { id: string; label: string; description: string; parameters: Record<string, number>; group: string }
export interface EquationSpec {
  id: string;
  group: string;
  label: string;
  /** Bounded TeX (≤ 4096). Placeholders `{{q:quantityId}}` are replaced by formatted numerals only. */
  tex: string;
  /** Plain-text equivalent with the same placeholders. */
  plain: string;
}
export type StageKind = 'prepare' | 'predict' | 'explore' | 'explain' | 'closed';
export interface StageSpec {
  id: string;
  kind: StageKind;
  instruction: string;
  /** Groups visible in this stage; unlisted groups are absent. */
  visible: Record<string, Exclude<Visibility, 'absent'>>;
  /** Parameter control modes in this stage; unlisted parameters are hidden. */
  controls: Record<string, 'interactive' | 'fixed'>;
  allowsPreview: boolean;
  allowsPlayback: boolean;
  allowsNavigation: boolean;
  /** Host-owned response request; the visualizer never collects or grades the response. */
  response?: { kind: 'prediction' | 'explanation'; prompt: string; taskFamily: string };
}
export interface TransitionSpec { id: string; from: string; to: string; label: string }
export interface AlternativeSpec {
  id: string;
  kind: 'table' | 'description' | 'projection-2d' | 'numeric-entry' | 'keyboard' | 'alternative-activity';
  group: string;
  label: string;
  covers: string[];
  equivalence: 'equivalent' | 'partial' | 'alternative-activity';
  description: string;
  /** Test or manual-check identifier that exercised the claimed equivalence. */
  verifiedBy: string;
}
export interface TaskFamilyRef { id: string; description: string; hostOwned: true }
export interface ContentRef { id: string; kind: 'derivation' | 'assumption' | 'source' | 'learner-copy'; text: string }
/**
 * Display units of one model quantity (report §8.3): the units its readouts, tables, descriptions and substituted
 * equations may be shown in; the first is the default. The model keeps evaluating in the canonical unit; values are
 * converted at the output boundary. Every unit must have the dimension of the quantity's canonical unit.
 */
export interface QuantityDisplaySpec { units: UnitId[] }

export interface ActivityTemplate {
  contract: typeof CONTRACTS.template;
  schemaVersion: typeof ACTIVITY_SCHEMA_VERSION;
  templateId: string;
  version: string;
  model: ModelRef;
  title: string;
  purpose: string;
  dimension: '2d' | '3d';
  locale: string;
  requires: CapabilityRef[];
  groups: ContentGroup[];
  views: ViewSpec[];
  controls: ControlSpec[];
  scenarios: ScenarioSpec[];
  equations: EquationSpec[];
  stages: StageSpec[];
  transitions: TransitionSpec[];
  initialStage: string;
  alternatives: AlternativeSpec[];
  taskFamilies: TaskFamilyRef[];
  content: ContentRef[];
  /**
   * Optional per-quantity display units keyed by manifest quantity ID (additive in schema 1.0). A key may not also be a
   * controlled parameter, so `setDisplayUnit` names either a control parameter or a declared quantity unambiguously.
   */
  quantityDisplay?: Record<string, QuantityDisplaySpec>;
}

// ---------------------------------------------------------------------------------------------
// Review authority (host-trusted registry only)
// ---------------------------------------------------------------------------------------------
export type LifecycleStatus = 'authored' | 'validated' | 'reference-checked' | 'reviewed' | 'deprecated' | 'revoked';
export interface ReviewRecord {
  contract: typeof CONTRACTS.review;
  schemaVersion: typeof ACTIVITY_SCHEMA_VERSION;
  reviewId: string;
  subject: { kind: 'model'; modelId: string; version: string; scientificRevision: string } | { kind: 'template'; templateId: string; version: string; contentDigest: string };
  reviewer: { name: string; role: string; affiliation?: string };
  date: string;
  scope: string;
  limitations: string[];
  referenceSuiteDigest: string;
  outcome: 'approved' | 'approved-with-limitations' | 'rejected';
}

// ---------------------------------------------------------------------------------------------
// Host policy
// ---------------------------------------------------------------------------------------------
export type ToolOperation =
  | 'discover' | 'prepare' | 'inspect.learner' | 'inspect.tutor' | 'inspect.teacher' | 'propose-revision' | 'request-reveal'
  | 'operate.parameters' | 'operate.navigation' | 'operate.playback' | 'operate.presentation' | 'summarize' | 'save' | 'restore'
  | 'close' | 'sample' | 'compose.exploratory';
export interface ApprovedEntry { template: TemplateRef; model: ModelRef }
export interface HostPolicy {
  contract: typeof CONTRACTS.policy;
  schemaVersion: typeof ACTIVITY_SCHEMA_VERSION;
  policyId: string;
  revision: number;
  issuedAt: string;
  expiresAt: string | null;
  revoked: boolean;
  mode: 'approved' | 'exploratory';
  approved: ApprovedEntry[];
  allowedTools: ToolOperation[];
  /** Ceiling on visible groups; a stage can never show a group outside this list. */
  visibleGroups: string[];
  permittedControls: string[];
  export: { learnerSnapshot: boolean; capture: boolean; backup: boolean };
  inspection: { developer: boolean; tutor: 'learner-visible' | 'full'; teacher: boolean };
  independentTask: { active: boolean; taskRef: string | null; permittedTools: ToolOperation[]; neutralScaffold: string[] };
  sampling: { allowed: boolean; maxPositions: number };
  exploratory: { allowed: boolean; maxParametersOverride: number };
}

// ---------------------------------------------------------------------------------------------
// Activity instance, receipts and responses
// ---------------------------------------------------------------------------------------------
export interface ResponseRef {
  responseId: string;
  taskId: string;
  taskRevision: number;
  kind: 'prediction' | 'explanation' | 'answer';
  modality: 'speech-derived' | 'text' | 'numeric' | 'choice' | 'diagram';
  stageId: string;
  status: 'submitted' | 'superseded' | 'corrected' | 'disputed' | 'deleted';
  supersededBy?: string;
}
export type PersistenceStatus = 'saved' | 'saving' | 'pending-recovery' | 'failed';
export interface ActivityInstance {
  contract: typeof CONTRACTS.instance;
  schemaVersion: typeof ACTIVITY_SCHEMA_VERSION;
  activityId: string;
  objectiveIds: string[];
  hostSessionId: string;
  hostSessionRevision: number;
  template: TemplateRef;
  model: ModelRef;
  initialParameters: Record<string, number>;
  mode: 'approved' | 'exploratory';
  stage: { id: string; enteredAtSequence: number };
  activityRevision: number;
  policy: { policyId: string; revision: number };
  context: { kind: 'instructional' } | { kind: 'independent'; taskRef: string };
  responses: ResponseRef[];
  allowedActions: ToolOperation[];
  persistence: PersistenceStatus;
  closed: boolean;
}

export interface GroupDigest { groupId: string; contentDigest: string }
export interface ExposureGrant {
  exposureId: string;
  scope: 'stage' | 'reveal' | 'exploration';
  groups: GroupDigest[];
  /** Exploration scope: parameter domain (canonical units) covered by the grant. */
  parameterDomain?: Record<string, [number, number]>;
}
interface ReceiptBase {
  schemaVersion: typeof ACTIVITY_SCHEMA_VERSION;
  receiptId: string;
  activityId: string;
  basedOnActivityRevision: number;
  activityRevision: number;
  policyId: string;
  policyRevision: number;
  idempotencyKey: string;
  template: TemplateRef;
  model: ModelRef;
  issuedAt: string;
  expiresAt: string | null;
}
export interface ExposureReceipt extends ReceiptBase { contract: typeof CONTRACTS.exposureReceipt; grant: ExposureGrant; intendedStage: string }
export interface StageReceipt extends ReceiptBase { contract: typeof CONTRACTS.stageReceipt; fromStage: string; toStage: string; grant: ExposureGrant | null }
export interface AssistanceReceipt extends ReceiptBase { contract: typeof CONTRACTS.assistanceReceipt; kind: 'help' | 'reopen-instructional'; grant: ExposureGrant | null }
/**
 * Reference to an assistance receipt the host issued (report §6.4, A19/A26): the receipt, the kind of assistance, the
 * journal sequence of its `assistance.recorded` event and a summary of the exposure grant it carried (the exposure ID
 * and group IDs; the full record with content digests is in the exposure list). Backups carry these references so a
 * restored activity's frozen assistance snapshots still name assistance recorded before the restore.
 */
export interface AssistanceRef {
  receiptId: string;
  kind: AssistanceReceipt['kind'];
  sequence: number;
  grant: { exposureId: string; groups: string[] } | null;
}

// ---------------------------------------------------------------------------------------------
// Exposure record
// ---------------------------------------------------------------------------------------------
export type DisplayStatus = 'authorized' | 'displayed' | 'uncertain' | 'not-displayed';
/**
 * Why the granted groups left the published projection after an acknowledged display (additive in 1.0): a stage change,
 * an independent context, a narrower or ended policy, a revocation (host, policy or catalogue) or close.
 */
export type DisplayEndReason = 'stage' | 'independent' | 'policy' | 'revoked' | 'closed';
export interface ExposureRecord {
  contract: typeof CONTRACTS.exposure;
  schemaVersion: typeof ACTIVITY_SCHEMA_VERSION;
  exposureId: string;
  activityId: string;
  receiptId: string;
  scope: ExposureGrant['scope'];
  groups: GroupDigest[];
  template: TemplateRef;
  model: ModelRef;
  activityRevision: number;
  intendedStage: string;
  parameterDomain?: Record<string, [number, number]>;
  displayStatus: DisplayStatus;
  /**
   * Projection digest and frame actually displayed, when acknowledged. `monotonicMs` is the first acknowledged display.
   * `endedMonotonicMs`/`endedBy` (additive in 1.0) close the observed display interval: set by the adapter process that
   * acknowledged the display when none of the granted groups is in the published projection any more, and cleared if
   * they are published again (the interval is then an envelope from the first display to the last end). Suspension does
   * not end it (the journal's `activity.suspended`/`activity.resumed` bound idle periods); absent means the interval is
   * open or was not observed by this process (for example a record restored from an artifact).
   */
  displayed?: { projectionDigest: string; frameId: string; monotonicMs: number; endedMonotonicMs?: number; endedBy?: DisplayEndReason };
  uncertainty?: { code: 'ACK_NOT_PERSISTED' | 'INTERRUPTED_BEFORE_ACK' | 'SURFACE_LOST'; reason: string };
}

// ---------------------------------------------------------------------------------------------
// Scientific and presentation snapshots
// ---------------------------------------------------------------------------------------------
export interface ScientificSnapshot {
  contract: typeof CONTRACTS.scientific;
  schemaVersion: typeof ACTIVITY_SCHEMA_VERSION;
  model: ModelRef;
  scientificRevision: string;
  runtime: { id: string; version: string };
  runId: string;
  restoredFrom?: string;
  params: Record<string, number>;
  position: FramePosition;
  terminal: boolean;
  comparisons: { runId: string; label: string; params: Record<string, number>; position: FramePosition }[];
}
export interface Camera2D { kind: '2d'; center: [number, number]; zoom: number }
export interface Camera3D { kind: '3d'; projection: 'orthographic' | 'perspective'; position: [number, number, number]; target: [number, number, number]; up: [number, number, number]; preset: string | null }
export interface PresentationSnapshot {
  contract: typeof CONTRACTS.presentation;
  schemaVersion: typeof ACTIVITY_SCHEMA_VERSION;
  revision: number;
  views: Record<string, { camera: Camera2D | Camera3D | null; layers: string[] }>;
  selection: string | null;
  layout: 'auto' | 'card' | 'side' | 'expanded';
  displayUnits: Record<string, UnitId>;
  locale: string;
  formatVersion: '1.0';
}

// ---------------------------------------------------------------------------------------------
// Interaction events
// ---------------------------------------------------------------------------------------------
export type ActorKind = 'learner' | 'tutor' | 'host';
export type EventType =
  | 'activity.prepared' | 'activity.opened' | 'activity.closed' | 'stage.changed'
  | 'response.submitted' | 'response.superseded' | 'response.invalidated'
  | 'reveal.requested' | 'reveal.authorized' | 'reveal.displayed' | 'reveal.uncertain'
  | 'exposure.scope-authorized' | 'preview.started' | 'preview.observed' | 'preview.cancelled'
  | 'parameters.committed' | 'position.changed' | 'playback.started' | 'playback.paused' | 'playback.ended'
  | 'comparison.retained' | 'comparison.removed' | 'view.changed' | 'help.requested' | 'assistance.recorded'
  | 'context.independent-entered' | 'context.instructional-reopened'
  | 'activity.suspended' | 'activity.resumed' | 'artifact.saved' | 'artifact.restored'
  | 'operation.failed' | 'content.revoked';
export interface FrameRef { frameId: string; runId: string; kind: 'committed' | 'tentative'; position: FramePosition }
export interface InteractionEvent {
  contract: typeof CONTRACTS.event;
  schemaVersion: typeof ACTIVITY_SCHEMA_VERSION;
  eventId: string;
  activityId: string;
  /** Adapter-assigned, gap-free per activity. */
  sequence: number;
  operationId: string;
  actor: { kind: ActorKind; binding: string };
  type: EventType;
  revisions: { scientific: { modelDigest: string; runId: string | null; version: number }; presentation: number; activity: number; hostSession: number; policy: number };
  frame?: FrameRef;
  payload: Record<string, unknown>;
  /** Milliseconds since the adapter's monotonic origin; not wall clock and not a competence measure. */
  monotonicMs: number;
  causes: string[];
}
export interface AppendAck { eventId: string; durableSequence: number; hostTimestamp: string }
export interface AppendResult { acknowledged: AppendAck[]; duplicates: string[]; cursor: JournalCursor }
export interface JournalCursor { activityId: string; lastSequence: number; lastEventId: string | null; checkpointDigest: string | null }

// ---------------------------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------------------------
export const SUMMARY_LIMITS = Object.freeze({ committedConfigurations: 20, previewObservations: 20, bytes: 32 * 1024 });
export interface SummaryConfiguration { runId: string; params: Record<string, number>; furthestPosition: FramePosition | null; cause: string; sequence: number; observations: Record<string, QuantityResult> }
export interface SummaryPreview { previewId: string; outcome: 'committed' | 'cancelled' | 'interrupted'; samplingPolicy: string; rendered: { params: Record<string, number>; frameId: string }[]; omitted: number }
export interface InteractionSummary {
  contract: typeof CONTRACTS.summary;
  schemaVersion: typeof ACTIVITY_SCHEMA_VERSION;
  summarizerVersion: string;
  activityId: string;
  audience: 'learner' | 'tutor' | 'teacher' | 'host';
  template: TemplateRef;
  model: ModelRef;
  cursor: { fromSequence: number; toSequence: number; acknowledgedThrough: number };
  complete: boolean;
  committedConfigurations: SummaryConfiguration[];
  previewObservations: SummaryPreview[];
  revealed: { exposureId: string; groups: string[]; displayStatus: DisplayStatus; sequence: number }[];
  comparisons: { runId: string; label: string; action: 'retained' | 'removed'; sequence: number }[];
  responses: ResponseRef[];
  omitted: { committedConfigurations: number; previewObservations: number; events: number };
  limitations: string[];
  /** Concise text generated deterministically from the structured fields; never asserts mastery. */
  text: string;
  /**
   * Mode the activity ran in (additive in 1.0; always written by this summarizer). An `exploratory` summary is never
   * reviewed assessment content: its text says so in a fixed sentence (report §5.2).
   */
  mode?: 'approved' | 'exploratory';
  /** Host-resolved review notice of the exact template and model (the learner-facing `reviewNotice`; additive in 1.0). */
  reviewNotice?: string;
}

// ---------------------------------------------------------------------------------------------
// Artifact
// ---------------------------------------------------------------------------------------------
export interface IntegrityEntry { path: string; digest: string }
/**
 * Events the journal outbox could not accept, or unacknowledged events a restore could not recover (activity-runtime §5,
 * additive in 1.0): their number, their types where known and the sequence of the last event journaled before the first
 * of them. Evidence is never dropped silently: a loss is carried
 * in the next journaled event (`operation.failed` with `lost`), in every later backup and in summaries
 * (`complete: false`).
 */
export interface JournalLoss { count: number; types: EventType[]; afterSequence: number }
/**
 * Context lineage at the checkpoint (additive in 1.0, report §6.4, A19). `endedExposureIds` names exposure records whose
 * lineage had ended before the save (granted before an independent context began or before instructional work was
 * reopened); they never count for visibility after a restore. `reopenRequired` is true when the checkpoint was taken in
 * an independent context, or after a restore from one before instructional work was reopened: a restore into an
 * instructional context then shows instructional solution-bearing content only after `reopenInstructional` has recorded
 * assistance through the host. Both are restricting claims; a restore never widens visibility because of them.
 */
export interface ArtifactLineage { endedExposureIds: string[]; reopenRequired: boolean }
export interface ActivityArtifact {
  contract: typeof CONTRACTS.artifact;
  schemaVersion: typeof ACTIVITY_SCHEMA_VERSION;
  artifactId: string;
  kind: 'backup' | 'learner-snapshot';
  schemas: { contract: string; version: string }[];
  runtime: { id: string; version: string };
  template: TemplateRef;
  model: ModelRef;
  policyRef: { policyId: string; revision: number };
  instance: ActivityInstance;
  scientific: ScientificSnapshot;
  presentation: PresentationSnapshot;
  exposures: ExposureRecord[];
  /**
   * Journal checkpoint: the last acknowledged position and the IDs of events still unacknowledged at the save. A backup
   * also carries those events (`pendingEvents`, additive in 1.0; the longest contiguous prefix that fits the artifact
   * budget) so a restore can resend them to the host, which deduplicates by `eventId`, and the record of any events the
   * outbox could not accept (`lost`, additive in 1.0). A learner snapshot carries neither.
   */
  journal: { cursor: JournalCursor; pendingEventIds: string[]; pendingEvents?: InteractionEvent[]; lost?: JournalLoss };
  /** A pending preview is never the saved experiment; it is recorded separately. */
  pending: { kind: 'none' } | { kind: 'preview'; previewId: string; params: Record<string, number>; baseRunId: string };
  contentRefs: string[];
  reviewRefs: string[];
  /** Original bytes digest when produced by a migration. */
  migratedFrom?: { contract: string; version: string; digest: string; report: string[] };
  /**
   * Assistance receipts recorded for the activity up to the checkpoint, oldest first (additive in 1.0). A backup lists
   * them when there are any; absent means none were recorded, or that the artifact was written before the field existed
   * (a migrated 0.9 draft), in which case earlier assistance is known only from the host journal. Never present in a
   * learner snapshot.
   */
  assistance?: AssistanceRef[];
  /** Context lineage of the exposure records (additive in 1.0); absent when every record counted at the save and no reopening is required. Never present in a learner snapshot. */
  lineage?: ArtifactLineage;
  integrity: { algorithm: 'sha256'; entries: IntegrityEntry[]; digest: string };
}

// ---------------------------------------------------------------------------------------------
// Requests and host port
// ---------------------------------------------------------------------------------------------
export interface ActivityRequest {
  activityId: string;
  objectiveIds: string[];
  hostSessionId: string;
  hostSessionRevision: number;
  template: { templateId: string; version: string };
  /** Initial parameters in canonical units; defaults when omitted. */
  parameters?: Record<string, number>;
  scenarioId?: string;
  mode: 'approved' | 'exploratory';
  stageId?: string;
}
export interface StageTransitionRequest { activityId: string; operationId: string; idempotencyKey: string; fromStage: string; toStage: string; basedOnActivityRevision: number; expectedPolicyRevision: number; actor: ActorKind; groups: GroupDigest[]; template: TemplateRef; model: ModelRef }
export interface ExposureIntentRequest { activityId: string; operationId: string; idempotencyKey: string; scope: ExposureGrant['scope']; groups: GroupDigest[]; parameterDomain?: Record<string, [number, number]>; basedOnActivityRevision: number; expectedPolicyRevision: number; intendedStage: string; actor: ActorKind; template: TemplateRef; model: ModelRef }
export interface DisplayAckRequest { activityId: string; exposureId: string; receiptId: string; projectionDigest: string; frameId: string; monotonicMs: number }
export interface AssistanceRequest { activityId: string; operationId: string; idempotencyKey: string; kind: 'help' | 'reopen-instructional'; basedOnActivityRevision: number; expectedPolicyRevision: number; actor: ActorKind; groups: GroupDigest[]; template: TemplateRef; model: ModelRef }
export interface HostAck { ok: true; hostTimestamp: string }
/**
 * The host's durable exposure and assistance records of one activity (`HostPort.getActivityRecords`, additive in 1.0;
 * activity-runtime §9). Exposure records are the host's own rows (an authorized row without a committed display
 * acknowledgement stays `authorized` or `uncertain`). Each assistance reference names a receipt the host issued; its
 * `sequence` is the journal sequence of the matching `assistance.recorded` event, or the host journal's last sequence
 * when no such event is journaled (an upper bound: the assistance happened no later than that).
 *
 * `activity` (additive in 1.0) is the host's own state of the activity: its current stage, the host-owned activity
 * revision (the value its latest receipt carried), whether the host closed the activity and its context lineage. The
 * host, not a saved artifact, is the authority for these (report §4.2, §6.4, §14): a restore adopts them, and counts a
 * saved exposure grant only when `exposures` holds the same grant (exposure ID, receipt ID and content) and the host's
 * lineage counts it. A host that omits `activity` confirms a saved stage, revision, closure and lineage only by holding
 * the restored artifact as its latest checkpoint (`JournalCursor.checkpointDigest`); otherwise the restore is refused
 * (activity-runtime §9).
 */
export interface ActivityRecords { activityId: string; exposures: ExposureRecord[]; assistance: AssistanceRef[]; activity?: HostActivityState }
/**
 * The host-owned state of one activity (`ActivityRecords.activity`, additive in 1.0). `stageReceiptId` names the receipt
 * that moved the activity to its current stage (absent while the activity is in the stage it was registered in): when
 * `reconcile` follows a stage the host moved to, the journaled `stage.changed` names that receipt.
 */
export interface HostActivityState { stage: string; activityRevision: number; closed: boolean; lineage?: HostContextLineage; stageReceiptId?: string }
/**
 * The context lineage the host holds for an activity (`HostActivityState.lineage`, additive in 1.0; report §6.4, A19,
 * A26). `context` is `independent` from the host's activation of an independent task until it records a
 * `reopen-instructional` assistance, and `instructional` otherwise. `fromActivityRevision` is the first host activity
 * revision of the current lineage: a grant whose `activityRevision` is lower belongs to an ended lineage and never counts
 * for visibility again (an independent task activated at revision r starts a lineage at r + 1; a reopening recorded by a
 * receipt with revision r starts one at r, so its own grant counts). These are host decisions, never derived from an
 * artifact or from adapter-written journal events.
 */
export interface HostContextLineage { context: { kind: 'instructional' } | { kind: 'independent'; taskRef: string }; fromActivityRevision: number }

/**
 * Narrow, typed host persistence and policy port. The host owns transactions, sequencing, duplicate
 * detection and acknowledgement. Every method must be idempotent for a repeated idempotency key/event ID.
 */
export interface HostPort {
  getPolicy(request: { activityId: string }): Promise<HostPolicy>;
  /**
   * Registers an adapter's instance of an activity. For an activity it holds, the host never adopts a stage, activity
   * revision, closure or context from a registered instance: those are its own (`getActivityRecords`); a prepared
   * instance carries the stage the host's own request chose. A restore registers only after it has read
   * `getJournalCursor` and the host's records, with the host's stage and revision.
   */
  registerActivity(request: { instance: ActivityInstance; operationId: string }): Promise<HostAck>;
  requestStageTransition(request: StageTransitionRequest): Promise<StageReceipt>;
  recordExposureIntent(request: ExposureIntentRequest): Promise<ExposureReceipt>;
  recordDisplayAck(request: DisplayAckRequest): Promise<HostAck>;
  recordAssistance(request: AssistanceRequest): Promise<AssistanceReceipt>;
  appendEvents(request: { activityId: string; events: InteractionEvent[] }): Promise<AppendResult>;
  /**
   * The journal cursor of an activity the host holds; `checkpointDigest` is the artifact digest of the latest backup the
   * host stored for it. A host refuses the read for an activity it does not hold: a restore reads it before registering
   * anything, so a backup never creates an activity at the host.
   */
  getJournalCursor(request: { activityId: string }): Promise<JournalCursor>;
  saveArtifact(request: { artifact: ActivityArtifact; operationId: string }): Promise<HostAck & { artifactDigest: string }>;
  /**
   * Optional (additive in 1.0): the host's durable exposure and assistance records of the activity. A restore merges them
   * with the artifact conservatively, so restoring an earlier checkpoint never erases exposure or assistance history
   * (report §6.3, §6.4). A host without it still restores; the restore then notes that host records were not read and
   * frozen assistance snapshots report `complete: false`.
   */
  getActivityRecords?(request: { activityId: string }): Promise<ActivityRecords>;
}

/**
 * Host refusal convention (activity-runtime §10). A HostPort method that decides not to perform a request rejects with
 * an error or plain object whose `code` is one of these: the host decided, nothing was recorded, and repeating the same
 * request cannot succeed. The adapter reports that code, does not retry and records no uncertainty. Any other rejection
 * (transport error, timeout, failed write, crash, any other code) is a persistence failure: the outcome may be uncertain
 * and the request is retryable (`PERSISTENCE_FAILED`). The host's message is never shown to the learner.
 */
export const HOST_REFUSAL_CODES = Object.freeze(['POLICY_DENIED', 'POLICY_EXPIRED', 'CONTENT_REVOKED', 'STALE_POLICY_REVISION', 'INVALID_INPUT'] as const satisfies readonly DiagnosticCode[]);
export type HostRefusalCode = typeof HOST_REFUSAL_CODES[number];
export interface HostRefusal { code: HostRefusalCode; message: string }

/** True when a HostPort rejection value is a host refusal (see {@link HOST_REFUSAL_CODES}); never throws. */
export function isHostRefusal(value: unknown): value is HostRefusal {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false;
  try {
    const code = (value as { code?: unknown }).code;
    return typeof code === 'string' && (HOST_REFUSAL_CODES as readonly string[]).includes(code);
  } catch { return false; }
}

/** The rejection value a host uses to refuse a request: an `Error` carrying a refusal code. */
export function hostRefusal(code: HostRefusalCode, message = 'The host refused the request.'): Error & HostRefusal {
  if (!(HOST_REFUSAL_CODES as readonly string[]).includes(code)) throw new RangeError('Unknown host refusal code.');
  return Object.assign(new Error(message), { name: 'HostRefusal', code });
}

/** Catalogue interface injected into the adapter; implemented by @explorable-models/catalog. */
export interface CatalogEntryStatus { lifecycle: LifecycleStatus; reviews: ReviewRecord[]; revoked: boolean; revocationReason?: string }
export interface ActivityCatalog {
  listTemplates(): { template: TemplateRef; model: ModelRef; title: string; dimension: '2d' | '3d'; status: CatalogEntryStatus }[];
  getTemplate(ref: { templateId: string; version: string }): ActivityTemplate | null;
  getModel(ref: { modelId: string; version: string }): ModelManifest | null;
  status(ref: TemplateRef | ModelRef): CatalogEntryStatus;
  /** Installed kernel worker factory; hosts may override for bundler compatibility. */
  createWorker(): Worker;
  /**
   * Optional (additive in 1.0): loads one listed template version's content — template, learner copy and model
   * manifest — and verifies it against the catalogue's installed digests, so that `getTemplate`/`getModel` return it
   * afterwards. A catalogue that holds all content in memory may omit it. The adapter awaits it before resolving a
   * reference in `validate`, `prepare` and `restore`; `NOT_FOUND` means the version is not listed.
   */
  load?(ref: { templateId: string; version: string }): Promise<CatalogLoadResult>;
  /**
   * Optional (additive in 1.0): the discovery summary of a listed template whose content is not loaded yet, from the
   * catalogue's verified installed index; `getCapabilities` uses it so discovery is complete before any content loads.
   */
  describe?(ref: { templateId: string; version: string }): TemplateDiscovery | null;
  /**
   * Optional (additive in 1.0): installed entries the catalogue excluded because they failed verification or validation
   * (for example on-demand content that does not reproduce its installed digest, which withdraws the entry from
   * `listTemplates`). `getCapabilities` reports every template entry here under `unavailable` with these diagnostics, so
   * an installed entry is never dropped silently (report §5.3).
   */
  problems?(): CatalogProblemEntry[];
}
/** One excluded catalogue entry (`ActivityCatalog.problems`). */
export interface CatalogProblemEntry { kind: 'template' | 'model'; id: string; version: string; diagnostics: Diagnostic[] }
/** Outcome of `ActivityCatalog.load`. */
export type CatalogLoadResult = { ok: true } | { ok: false; diagnostics: Diagnostic[] };

export type { CapabilityRef, FramePosition, ModelManifest, ModelRef, PositionRequest, QuantityResult, UnitId };
