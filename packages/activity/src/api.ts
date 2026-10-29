/**
 * Runtime API for the Study Harness adapter: learner projection, activity controller and the six
 * public operations. The learner surface only ever receives `LearnerProjection` objects.
 */
import type {
  ActivityArtifact, ActivityCatalog, ActivityInstance, ActivityRequest, ActorKind, AlternativeSpec, AssistanceRef, Camera2D, Camera3D, Diagnostic, DiagnosticCode,
  ExposureRecord, HostPolicy, HostPort, InteractionSummary, JournalCursor, MarkSpec, PersistenceStatus, PresentationSnapshot,
  ResponseRef, ScientificSnapshot, StageKind, TemplateRef, ToolOperation, ViewKind,
} from './contracts.js';
import type { FramePosition, GeometryResult, ModelRef, PositionRequest, UnitId } from '@experiment-kit/core/model';
import type { CapabilityRecord } from './capabilities.js';

// ---------------------------------------------------------------------------------------------
// Learner projection (the only data the learner surface receives)
// ---------------------------------------------------------------------------------------------
export type UiState =
  | 'empty' | 'preparing' | 'awaiting-persistence' | 'ready' | 'tentative-preview' | 'playing' | 'paused' | 'boundary'
  | 'undefined' | 'clipped' | 'unsupported' | 'recoverable-failure' | 'stale-policy' | 'suspended' | 'restored' | 'disposed';

export interface ProjectedValue {
  quantityId: string;
  label: string;
  symbol?: string;
  /** Formatted in the display unit; undefined/limit states carry learner-safe text, never zero. */
  text: string;
  status: 'valid' | 'undefined' | 'numerical-limit';
  approximate: boolean;
  /** Raw value in display units for valid scalars/vectors; omitted otherwise. */
  value?: number | number[] | string;
  /** Display unit of `text` and `value` (the canonical unit unless the template declares display units for it). */
  unit: UnitId;
  unitLabel: string;
  reason?: string;
  /** Units the template allows for this quantity (first = default) when it declares more than one; select with `setDisplayUnit`. */
  displayUnits?: UnitId[];
  /**
   * `model` when the activity's model also declares observed data (report §8.5): a quantity is always model output, so
   * readouts say so beside observations (`label` then ends with “(model)”). Absent in activities without observed data.
   */
  origin?: DataOrigin;
}
/** Whether projected data are observations (manifest datasets) or model output (report §8.5). */
export type DataOrigin = 'observed' | 'model';
export interface ProjectedMark {
  markId: string;
  kind: MarkSpec['kind'];
  label: string;
  style: MarkSpec['style'];
  placement?: MarkSpec['placement'];
  text?: string;
  /** `line` when the segments depict unbounded lines clipped to the view (never reported as out-of-view data). */
  extent?: MarkSpec['extent'];
  geometry?: GeometryResult;
  /** Resolved point/arrow/segment/angle coordinates in the view's canonical axis units, independent of readout units. */
  at?: number[] | null;
  vector?: number[] | null;
  from?: number[] | null;
  to?: number[] | null;
  value?: ProjectedValue;
  /** Learner-safe reason when a bound value is undefined; rendered as a gap/label, never zero. */
  undefinedReason?: string;
  /**
   * Which of this mark's gaps are numerical limits (report §8.2, A11): the reasons, exactly as they appear in its
   * geometry's missing points and gaps and in `undefinedReason`, whose frame quantity is a numerical limit (overflow,
   * underflow, iteration limit) rather than mathematically undefined. Renderers word those gaps as beyond the
   * representable range, never as undefined. Absent when there is none.
   */
  limitReasons?: string[];
  draggable?: { x?: ProjectedControlRef; y?: ProjectedControlRef };
  interactive: boolean;
  /**
   * In an activity whose model declares observed data (report §8.5): `observed` for a mark drawing an observed dataset
   * (unconnected points only) and `model` for a mark drawing model output; `label` then ends with “(observed)” or
   * “(model)”, so every channel that shows the label distinguishes them. Absent otherwise (and for marks bound to nothing).
   */
  origin?: DataOrigin;
}
export interface ProjectedControlRef { parameter: string; min: number; max: number }
export interface ProjectedView {
  viewId: string;
  kind: ViewKind;
  title: string;
  description: string;
  visibility: 'fixed' | 'interactive';
  bounds?: [number, number, number, number];
  bounds3?: [number, number, number, number, number, number];
  equalAspect: boolean;
  axes?: { x: { label: string; unitLabel: string }; y: { label: string; unitLabel: string }; z?: { label: string; unitLabel: string } };
  marks: ProjectedMark[];
  values: ProjectedValue[];
  equations: ProjectedEquation[];
  table?: ProjectedTable;
  /**
   * True when visible data of this view lie outside the range it currently shows (report §10.2): the committed camera
   * of a 2D view (its authored bounds without one), the authored `bounds3` of a 3D view. Reference-role marks, `grid`
   * marks and unbounded lines (`extent: 'line'`) are background and never count. The `clipped` UI state is raised
   * from these flags.
   */
  clipped?: boolean;
  /** Accessible text description generated from visible values only. */
  summary: string;
}
export interface ProjectedEquation { equationId: string; label: string; tex: string; plain: string }
export interface ProjectedTable {
  caption: string;
  columns: { id: string; label: string; unitLabel: string }[];
  rows: { key: string; cells: string[] }[];
  truncated: boolean;
  totalRows: number;
  /**
   * How a truncated table was shortened: `ends` keeps the first and last rows (traces), `every` keeps every `step`-th row
   * of a sampled curve plus the last one, so the whole domain stays covered.
   */
  shortened?: { kind: 'ends' } | { kind: 'every'; step: number };
  /** Set beside observed data (report §8.5): whether the rows are observations or model output. */
  origin?: DataOrigin;
  /**
   * Observed rows only: the learner-visible source line (citation, how the data were obtained and the licence when
   * known), from the manifest provenance.
   */
  source?: string;
}
export interface ProjectedControl {
  parameter: string;
  label: string;
  description: string;
  mode: 'interactive' | 'fixed';
  disabledReason?: string;
  /** Committed value in display unit. */
  value: number;
  /** Tentative value while previewing, in display unit. */
  previewValue?: number;
  min: number;
  max: number;
  step: number;
  integer: boolean;
  slider: boolean;
  exact: boolean;
  displayUnit: UnitId;
  displayUnits: UnitId[];
  unitLabel: string;
  /** Plain-text symbol of the parameter from the manifest (for example `η`, `m₁₁`, `u_x`); omitted when it declares none. */
  symbol?: string;
  /** Presentation section from the template (`ControlSpec.section`); controls sharing a section ID form one labelled group. */
  section?: { id: string; label: string };
}
export interface ProjectedScenario { scenarioId: string; label: string; description: string; active: boolean }
/**
 * Navigation and playback of a positioned run. Content of the template's position groups (quantity groups listing the
 * iteration index or the time): absent when none of them is visible — in an independent context, when the neutral
 * scaffold keeps none — and without stepping or playback when they are only fixed.
 */
export interface ProjectedNavigation {
  kind: 'index' | 'time';
  value: number;
  max: number | null;
  /**
   * The run's end as the learner may see it: a numerical limit only when the projection shows the value or drawn gap at
   * the limit; otherwise only the last index or the end time. A hidden limit is never stated or implied.
   */
  terminal: boolean;
  canStepBack: boolean;
  canStepForward: boolean;
  playing: boolean;
  allowsPlayback: boolean;
  /** Presentation-only interpolation flag for discrete playback. */
  interpolated: boolean;
}
/**
 * A retained run compared with the current run (report §8.4, §10.2). Everything is projected from the kept run's own
 * identified frame (the committed frame at which it was kept) with the same visibility filter as the current frame:
 * hidden quantities and marks of hidden groups never appear in a comparison either.
 */
export interface ProjectedComparison {
  runId: string;
  /** Label given when the run was kept (by the learner surface or a tool caller); a surface may show `name` instead. */
  label: string;
  /** 1-based position among the kept runs, oldest first (“Kept run 1”). */
  ordinal: number;
  /**
   * Generated identification: every differing shown parameter by its symbol with the kept run's value (`η = 0.25`,
   * `m₁₁ = 1.5, v_x = 2`), followed by `, and settings not shown here` when parameters that are not shown as controls
   * differ too; `settings not shown here differ from the current run` when only those differ; `same settings as the
   * current run` only when no parameter differs.
   */
  name: string;
  /** Shown parameters that differ: `text` is the retained run's value and `currentText` the current run's, both formatted alike. */
  parameterDifferences: { parameter: string; label: string; symbol?: string; text: string; currentText?: string }[];
  /** Present when parameters that are not shown as controls also differ; their values are not projected. */
  hiddenDifferences?: true;
  /**
   * How the two runs line up: the same iteration index, the same time, a normalized progress fraction, or `static`
   * (single states with no position, so there is nothing to align).
   */
  alignment: 'index' | 'time' | 'progress' | 'static';
  domainNote: string;
  /** Identified frame of the kept run; null only for a comparison restored without a frame. */
  frameId: string | null;
  /** Position at which the run was kept (`static` for static models). */
  position: FramePosition;
  /** The kept run's position in words (`n = 10`, `t = 1.5 s`); null for static models. */
  positionText: string | null;
  /**
   * The kept run's own domain boundary in words, when it ends before the current position can follow it: a terminal
   * event (`The next value cannot be represented…`, with its last finite index, only where the projection shows the
   * kept run's limit; otherwise only its last index or end time) or the last position it was computed to. Null when
   * nothing limits it.
   */
  boundary: string | null;
  /** Visible values whose text differs between the runs: the current run at its position and the kept run at its own. */
  values: { quantityId: string; label: string; current: ProjectedValue | null; kept: ProjectedValue }[];
  /** Count of visible values that are the same in both runs (not listed in `values`). */
  sameValues: number;
  /**
   * Observations at the same position in plots aligned by iteration index (horizontal axis in iterations): the current
   * and kept runs' plotted values at the current n, read from each run's own drawn points. `kept` is null with `reason`
   * when the kept run has no point there.
   */
  aligned: { viewId: string; label: string; at: number; current: string | null; kept: string | null; reason?: string }[];
  /** The kept run's version of each visible data mark, per graphical view, for a dashed overlay (never interactive). */
  overlays: { viewId: string; marks: ProjectedMark[] }[];
}
export interface ProjectedAlternative { alternativeId: string; kind: AlternativeSpec['kind']; label: string; description: string; equivalence: AlternativeSpec['equivalence'] }
export interface ProjectedStatus {
  ui: UiState;
  message: string | null;
  recovery: { action: 'retry' | 'return' | 'commit-or-cancel' | 'reload' | 'none'; label: string } | null;
  persistence: PersistenceStatus;
  live: string | null;
  /**
   * With `ui: 'undefined'`: what the affected drawn values are — mathematically undefined, beyond a numerical limit, or
   * both (report §8.2, A11). With `ui: 'boundary'` at a numerical-limit end (the message states the limit, which the
   * projection shows): `numerical-limit`. The message says the same in words; a surface may title the state
   * accordingly. Absent otherwise.
   */
  cause?: 'undefined' | 'numerical-limit' | 'mixed';
}
/**
 * Learner-side permissions the host policy grants for this projection (no content): `capture` mirrors
 * `policy.export.capture`; a surface refuses a capture with `CAPTURE_REJECTED` when it is false.
 */
export interface ProjectedPermissions { capture: boolean }

export interface LearnerProjection {
  projectionId: string;
  /** Digest of every visible content element, including accessible text; used for display acknowledgement. */
  projectionDigest: string;
  activityId: string;
  activityRevision: number;
  policyRevision: number;
  presentationRevision: number;
  /**
   * Scientific guard echo (session version and run ID; identities only, no content). The learner surface copies it
   * into scientific commands; without it the surface cannot issue guarded parameter, navigation or playback commands.
   */
  guards: ScientificGuard;
  /** Active tentative preview (identity only) so a surface can update, commit or cancel it; null when none. */
  preview: { previewId: string; parameter: string } | null;
  title: string;
  stage: { id: string; kind: StageKind; instruction: string; response?: { kind: 'prediction' | 'explanation'; prompt: string } };
  context: 'instructional' | 'independent';
  /**
   * Identity of the one frame behind every representation. `terminal` and `terminalDetail` state the run's end as the
   * learner may see it (see {@link ProjectedNavigation.terminal}): a numerical limit only where the projection shows it.
   */
  frame: { frameId: string; kind: 'committed' | 'tentative'; position: FramePosition; terminal: boolean; terminalDetail?: string } | null;
  views: ProjectedView[];
  controls: ProjectedControl[];
  scenarios: ProjectedScenario[];
  navigation: ProjectedNavigation | null;
  /** Retained runs, oldest first; none in an independent context (they belong to instructional work). */
  comparisons: ProjectedComparison[];
  alternatives: ProjectedAlternative[];
  presentation: PresentationSnapshot;
  status: ProjectedStatus;
  reviewNotice: string;
  /** Pending reveal awaiting host persistence; groups named by learner-safe labels only. */
  pendingReveal: { labels: string[]; state: 'requesting' | 'awaiting-display' | 'failed' } | null;
  /** Host-policy permissions for learner-side outputs of this projection (capture). */
  permissions: ProjectedPermissions;
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------
export interface CommandBase { operationId: string }
export interface ScientificGuard { expectedScientificVersion: number; expectedRunId: string | null }
export interface ActivityGuard { expectedActivityRevision: number; expectedPolicyRevision: number }
export interface PresentationGuard { expectedPresentationRevision: number }
export type GestureKind = 'pointer' | 'keyboard' | 'exact' | 'drag';

export interface CommandResult { ok: true; projection: LearnerProjection }
export interface CommandFailure { ok: false; diagnostics: Diagnostic[] }
export type CommandOutcome = CommandResult | CommandFailure;

/** Learner/tutor-facing binding. Actor is fixed at construction (`bindSurface` or tool executor). */
export interface ActivityBinding {
  readonly activityId: string;
  readonly actor: ActorKind;
  getProjection(): LearnerProjection;
  subscribe(listener: (projection: LearnerProjection) => void): () => void;
  beginPreview(input: CommandBase & ScientificGuard & { gesture: GestureKind; parameter: string }): CommandOutcome;
  updatePreview(input: CommandBase & { previewId: string; displayValues: Record<string, number> }): CommandOutcome;
  commitPreview(input: CommandBase & ScientificGuard & { previewId: string }): Promise<CommandOutcome>;
  cancelPreview(input: CommandBase & { previewId: string; reason: 'escape' | 'pointercancel' | 'blur' | 'navigation' | 'revoked' | 'superseded' }): CommandOutcome;
  /**
   * Exact entry in display units; rejected input never coerces to another experiment. `gesture` (default `exact`) is
   * the provenance recorded on `parameters.committed`: a pointer, keyboard or drag gesture that had no authorized
   * preview commits its draft values here under its own kind, never as `exact`.
   */
  commitParameters(input: CommandBase & ScientificGuard & { displayValues: Record<string, number>; gesture?: GestureKind }): Promise<CommandOutcome>;
  applyScenario(input: CommandBase & ScientificGuard & { scenarioId: string }): Promise<CommandOutcome>;
  resetExperiment(input: CommandBase & ScientificGuard): Promise<CommandOutcome>;
  navigate(input: CommandBase & ScientificGuard & { position: PositionRequest }): Promise<CommandOutcome>;
  step(input: CommandBase & ScientificGuard & { delta: 1 | -1 }): Promise<CommandOutcome>;
  restartPlayback(input: CommandBase & ScientificGuard): Promise<CommandOutcome>;
  /**
   * Plays the run from the shown position to its end. A numerical limit the projection does not show is crossed, as
   * for any other frame (playback runs on to the last index or the end time, and play is accepted from a frame past
   * it); a shown limit stops playback one step before it (activity-runtime §3).
   */
  play(input: CommandBase & ScientificGuard): CommandOutcome;
  pause(input: CommandBase & ScientificGuard): CommandOutcome;
  retainComparison(input: CommandBase & ScientificGuard & { label: string }): CommandOutcome;
  removeComparison(input: CommandBase & ScientificGuard & { runId: string }): CommandOutcome;
  setCamera(input: CommandBase & PresentationGuard & { viewId: string; camera: Camera2D | Camera3D | null }): CommandOutcome;
  resetView(input: CommandBase & PresentationGuard & { viewId: string }): CommandOutcome;
  /**
   * Presentation-only display unit of a visible control parameter or of a visible quantity the template declares in
   * `quantityDisplay` (`parameter` names either); the scientific run, index and version are unchanged.
   */
  setDisplayUnit(input: CommandBase & PresentationGuard & { parameter: string; unit: UnitId }): CommandOutcome;
  select(input: CommandBase & PresentationGuard & { target: string | null }): CommandOutcome;
  setLayout(input: CommandBase & PresentationGuard & { layout: PresentationSnapshot['layout'] }): CommandOutcome;
  requestHelp(input: CommandBase & ActivityGuard): Promise<CommandOutcome>;
  /** Surface reports that an exact projection is rendered in an active, visible surface. */
  acknowledgeDisplay(input: { projectionId: string; projectionDigest: string; surfaceId: string }): void;
  /**
   * Registers a mounted surface (initially visible) and returns its unregister function. Display acknowledgements are
   * accepted only from a registered, visible surface of a non-suspended activity.
   */
  registerSurface(surfaceId: string): () => void;
  /**
   * Learner-permitted visibility report from a registered surface (offscreen, collapsed, hidden tab). While surfaces
   * are registered and none is visible, the activity suspends compute: playback pauses, the preview is cancelled and
   * scratch leases are released. Becoming visible again resumes paused at the same position, with no catch-up.
   */
  reportVisibility(input: { surfaceId: string; visible: boolean }): void;
  /**
   * The projected `retry` recovery: resends evidence that is paused on persistence (outbox, display acknowledgements,
   * a failed reveal), then, after a worker timeout or crash (`recoverable-failure`), re-issues the failed scientific
   * operation once with fresh guards. Recovery attempts are bounded; once they are used up the status offers `reload`.
   */
  retryPersistence(input: CommandBase): Promise<CommandOutcome>;
  describeCurrentValues(): string;
}

/** Privileged host binding. Created only from the adapter construction context. */
export interface HostActivityControl {
  readonly activityId: string;
  requestStageTransition(input: CommandBase & ActivityGuard & { toStage: string; actor?: ActorKind }): Promise<CommandOutcome>;
  requestReveal(input: CommandBase & ActivityGuard & { groups: string[]; actor?: ActorKind }): Promise<CommandOutcome>;
  requestExplorationScope(input: CommandBase & ActivityGuard & { groups: string[]; parameterDomain?: Record<string, [number, number]> }): Promise<CommandOutcome>;
  /**
   * Records a host-persisted response reference. `hostSessionRevision` is the host session revision the host's response
   * transaction produced (greater than `expectedHostSessionRevision`); the adapter adopts it and never computes one.
   */
  submitResponseRef(input: CommandBase & { response: Omit<ResponseRef, 'status'> & { status?: ResponseRef['status'] }; expectedHostSessionRevision: number; hostSessionRevision: number }): Promise<CommandOutcome>;
  /** Changes a response reference's status; `hostSessionRevision` is the revision the host's correction produced. */
  updateResponseRef(input: CommandBase & { responseId: string; status: 'superseded' | 'corrected' | 'disputed' | 'deleted'; supersededBy?: string; expectedHostSessionRevision: number; hostSessionRevision: number }): Promise<CommandOutcome>;
  /**
   * Follows a host session revision the host advanced elsewhere (a correction, dispute or attempt outside this activity):
   * guarded by the expected current value; the new value must be greater. Nothing is journaled; later events carry it.
   */
  observeHostSessionRevision(input: CommandBase & { expectedHostSessionRevision: number; hostSessionRevision: number }): CommandOutcome;
  enterIndependentTask(input: CommandBase & { taskRef: string; policy: HostPolicy }): Promise<CommandOutcome>;
  reopenInstructional(input: CommandBase & ActivityGuard): Promise<CommandOutcome>;
  /**
   * Frozen exposure/assistance snapshot for an attempt; the host stores it with the submitted answer. `complete` is false
   * when the adapter's local record may be partial (a restore that could not read the host's records, a migrated artifact
   * without an assistance list, or journal losses); `limitations` then says why, and the host's own records govern.
   */
  freezeAssistanceSnapshot(input: { responseId: string }): AssistanceSnapshot;
  updatePolicy(input: CommandBase & { policy: HostPolicy }): Promise<CommandOutcome>;
  revoke(input: CommandBase & { reason: string }): Promise<CommandOutcome>;
  suspend(input: CommandBase & { reason: 'offscreen' | 'collapsed' | 'hidden' | 'host' }): CommandOutcome;
  resume(input: CommandBase): CommandOutcome;
  /**
   * Closes the activity. `pending` resolves an active preview under the host's policy (default `cancel`): `cancel` ends
   * it as interrupted; `commit` commits its latest tentative values through the guarded commit path (the close fails and
   * nothing closes when that commit fails); `retain` ends it without committing and keeps the draft, which later backups
   * record as the pending draft and a restore reports (`report.pendingDraft`) for the host to re-offer. Exposure records
   * and the journaled preview observations survive every choice.
   */
  close(input: CommandBase & { reason: string; pending?: 'cancel' | 'commit' | 'retain' }): Promise<CommandOutcome>;
  save(input: CommandBase & { kind: 'backup' | 'learner-snapshot' }): Promise<{ ok: true; artifact: ActivityArtifact } | CommandFailure>;
  /**
   * Reconciles with the host after a reconnect (activity-runtime §5, §2): resends unconfirmed journal events, then, when
   * the host provides `getActivityRecords` and no authorization is pending, follows the host-owned stage and activity
   * revision wherever they differ (`activity.adopted`) and merges host-held exposure and assistance records as history
   * that never counts for visibility. Nothing new is shown; `activity` is absent when the host does not report its state.
   */
  reconcile(): Promise<{ cursor: JournalCursor; resent: number; activity?: { stage: string; activityRevision: number; adopted: boolean } }>;
  /**
   * Host deletion policy: releases the adapter's own cached copies (frozen snapshots, acknowledged journal copies of
   * deleted responses, or for `activity` every cached comparison, sample, projection and acknowledged copy). The toolkit
   * keeps no summaries; summaries carry their cursor and response statuses, so the host marks stored ones stale by
   * reference. Pending events are never released.
   */
  forget(input: CommandBase & { scope: 'activity' | 'responses'; responseIds?: string[] }): Promise<CommandOutcome>;
}

export interface AudienceState {
  audience: 'learner' | 'tutor' | 'teacher' | 'host';
  activityId: string;
  instance: ActivityInstance;
  projection: LearnerProjection;
  guards: { scientificVersion: number; runId: string | null; activityRevision: number; policyRevision: number; presentationRevision: number; hostSessionRevision: number };
  committed: boolean;
  persistence: PersistenceStatus;
  /**
   * Why the activity is blocked, judged at this read by host time (activity-runtime §1): `POLICY_DENIED` (the host or a
   * policy revoked it, or the policy no longer approves its content), `POLICY_EXPIRED` (expired by host time) or
   * `CONTENT_REVOKED` (catalogue revocation); null while the current policy stands. A read that finds an expiry blocks
   * the activity at once, as a command would. While it is set, policy-authorized audiences (teacher, tutor with full
   * inspection) receive no `scientific` state or `exposures`; the host audience still does.
   */
  standing: DiagnosticCode | null;
  /** Host, and teacher/tutor when the policy allows full inspection and stands. */
  scientific?: ScientificSnapshot & { quantities: Record<string, unknown> };
  exposures?: ExposureRecord[];
}

/**
 * Actions a template stage allows (report §5.3 getCapabilities): preview, playback, navigation and the stage's own
 * control modes before the host policy narrows them. The host-owned response request is named by kind only; its prompt
 * and the stage instruction are template content and are not listed.
 */
export interface CapabilityStage {
  id: string;
  kind: StageKind;
  allowsPreview: boolean;
  allowsPlayback: boolean;
  allowsNavigation: boolean;
  controls: Record<string, 'interactive' | 'fixed'>;
  response: 'prediction' | 'explanation' | null;
}
/** Content-derived part of a `CapabilityReport` template entry (`templateDiscovery`, `ActivityCatalog.describe`). */
export type TemplateDiscovery = Omit<CapabilityReport['templates'][number], 'template' | 'model' | 'lifecycle' | 'reviewScope'>;
export interface CapabilityReport {
  adapterVersion: string;
  schemas: { contract: string; version: string }[];
  runtime: { id: string; version: string };
  templates: {
    template: TemplateRef; model: ModelRef; title: string; dimension: '2d' | '3d'; executionKind: 'kernel' | 'document'; mode: 'discrete' | 'static' | 'continuous';
    controls: { parameter: string; label: string; min: number; max: number; unit: UnitId; displayUnits: UnitId[] }[];
    stages: CapabilityStage[];
    /** Stage graph edges the host may request with `requestStageTransition`. */
    transitions: { id: string; from: string; to: string; label: string }[];
    alternatives: { id: string; kind: string; equivalence: string }[];
    lifecycle: string; reviewScope: string; renderingRequirements: string[]; limits: Record<string, number>;
    /** Capabilities the template requires, by exact version; each is listed in `capabilities` (additive in 1.0). */
    requires: { id: string; version: string }[];
  }[];
  /** Installed capability records with the limits this runtime enforces (e.g. spatial-3d@1.0; additive in 1.0). */
  capabilities: CapabilityRecord[];
  /**
   * Installed catalogue entries that cannot be offered (template or model missing, invalid manifest, digest mismatch),
   * each with the diagnostic that explains why. They are reported, never silently dropped and never substituted.
   */
  unavailable: { template: { templateId: string; version: string }; diagnostics: Diagnostic[] }[];
  limits: Record<string, number>;
  unsupported: { capability: string; alternative: string }[];
}

/** Bounded latency summary of worker evaluations (milliseconds of the adapter's monotonic clock). */
export interface EvaluationMetrics { count: number; lastMs: number | null; p50Ms: number | null; p95Ms: number | null; maxMs: number | null }
/**
 * Host-only operational state of one activity (report §19): no parameter values, quantities, labels or learner text —
 * identities, counts, timings, states and diagnostic codes only.
 */
export interface ActivityDiagnostics {
  activityId: string;
  template: TemplateRef;
  model: ModelRef;
  scientificRevision: string;
  stageId: string;
  context: 'instructional' | 'independent';
  ui: UiState;
  ready: boolean;
  suspended: boolean;
  playing: boolean;
  closed: boolean;
  persistence: PersistenceStatus;
  /** Journal outbox: unacknowledged evidence-bearing events, the configured bound and coalesced presentation changes. */
  outbox: { pending: number; limit: number; coalesced: number; unpersistedDisplayAcks: number };
  /**
   * Live preview queue: whether a preview is active, evaluations in flight (at most one) and the newest value waiting
   * behind it (at most one); `updates` counts accepted updates and `coalesced` the ones replaced by a newer value
   * before they were evaluated.
   */
  preview: { active: boolean; inFlight: number; queued: number; updates: number; coalesced: number };
  evaluation: { commit: EvaluationMetrics; navigate: EvaluationMetrics; preview: EvaluationMetrics };
  surfaces: { registered: number; visible: number };
  /** Most recent refused commands (oldest first, at most 32): operation name, code and the top-level path segment only. */
  failures: { operation: string; code: DiagnosticCode; path: string; monotonicMs: number }[];
}
/** Host-only operational metrics (`StudyHarnessAdapter.getDiagnostics`). */
export interface AdapterDiagnostics {
  adapterVersion: string;
  runtime: { id: string; version: string };
  /** Shared worker budget: workers, active leases (owner activity and purpose), idle workers and waiting requests. */
  budget: { maxWorkers: number; workers: number; active: number; idle: number; waiting: number; leases: { ownerId: string; purpose: string }[] };
  activities: ActivityDiagnostics[];
}
/**
 * Local, redacted diagnostic export (report §16, §19): a reproducible failure record with the execution identity attached
 * and content removed. It is a plain value returned to the host; the toolkit never transmits it.
 */
export interface DiagnosticExport {
  contract: 'study-harness.diagnostic-export';
  version: '1.0';
  redacted: true;
  notice: string;
  monotonicMs: number;
  execution: { adapterVersion: string; runtime: { id: string; version: string }; schemas: { contract: string; version: string }[] };
  diagnostics: AdapterDiagnostics;
}

/**
 * Developer inspection (report §6.2: "a separate capability and entry point, disabled in ordinary Study Harness use").
 * Only `StudyHarnessAdapter.inspectDeveloper` returns it, only when the current host policy sets
 * `inspection.developer`; no learner or tutor binding, agent tool or surface reaches it.
 */
export interface DeveloperInspection {
  activityId: string;
  template: TemplateRef;
  model: ModelRef;
  scientificRevision: string;
  runtime: { id: string; version: string };
  stage: { id: string; kind: StageKind };
  context: 'instructional' | 'independent';
  guards: AudienceState['guards'];
  /** Group visibility and control modes behind the current projection, and the exact content digest of every group. */
  visibility: { groups: Record<string, 'absent' | 'fixed' | 'interactive'>; controls: Record<string, 'interactive' | 'fixed'>; digests: Record<string, string> };
  frame: { frameId: string; kind: 'committed' | 'tentative'; position: FramePosition; terminal: boolean } | null;
  scientific: ScientificSnapshot | null;
  /** Every quantity of the displayed frame (hidden ones included) and the size of every geometry result. */
  quantities: Record<string, unknown>;
  geometry: Record<string, { kind: string; elements: number }>;
  exposures: ExposureRecord[];
  preview: { previewId: string; parameter: string; gesture: GestureKind; rendered: number; dropped: number } | null;
  diagnostics: ActivityDiagnostics;
}

/** Audience of an archival view: learner and tutor views are restricted like restricted summaries. */
export type ArchivalAudience = 'learner' | 'tutor' | 'teacher' | 'host';
/**
 * Archival read-only representation of a verified activity artifact (report §14, A49), produced by `archivalView`. It
 * is built from the artifact's own records only: no model is evaluated, nothing is looked up in the catalogue and
 * nothing is substituted. Learner and tutor audiences receive only identities, the saved stage and position, parameter
 * values a learner snapshot recorded as visible (never the full parameter set of a backup) and the exposure history of
 * content that was shown or potentially shown.
 */
export interface ArchivalView {
  kind: 'archival-view';
  version: '1.0';
  audience: ArchivalAudience;
  readOnly: true;
  artifact: { artifactId: string; kind: 'backup' | 'learner-snapshot'; digest: string; migratedFrom: { contract: string; version: string } | null };
  template: TemplateRef;
  model: ModelRef;
  runtime: { id: string; version: string };
  activity: { activityId: string; mode: 'approved' | 'exploratory'; stageId: string; context: 'instructional' | 'independent'; closed: boolean; activityRevision: number };
  position: FramePosition;
  terminal: boolean;
  /** Saved parameter values (canonical units), or null when withheld from this audience. */
  parameters: { parameter: string; value: number }[] | null;
  comparisons: { label: string; parameters: { parameter: string; value: number }[] | null; position: FramePosition }[];
  exposures: { scope: ExposureRecord['scope']; groups: string[]; displayStatus: ExposureRecord['displayStatus']; uncertainty: string | null }[];
  journal: { lastSequence: number; pendingEvents: number };
  /** Readable sentences generated from the fields above with fixed templates. */
  lines: string[];
  notes: string[];
}

export interface ValidationReport { ok: boolean; diagnostics: Diagnostic[]; defaults?: { frameId: string; statuses: Record<string, string> }; resourceEstimate?: { operations: number; geometryElements: number } }

export interface PreparedActivity { activityId: string; instance: ActivityInstance; binding(actor: ActorKind, bindingId: string): ActivityBinding; host: HostActivityControl }

/** {@link HostActivityControl.freezeAssistanceSnapshot}: exposures and assistance up to `cursor`, frozen for one response. */
export interface AssistanceSnapshot { responseId: string; cursor: number; exposures: ExposureRecord[]; assistance: AssistanceRef[]; complete: boolean; limitations: string[] }

/**
 * Restore report. `pendingDraft` is the preview that was pending when the backup was saved (never committed by the
 * restore): the host may re-offer it to the learner.
 */
export interface RestoreResult {
  ok: true;
  prepared: PreparedActivity;
  report: { restored: 'exact' | 'restricted' | 'read-only'; notes: string[]; pendingDraft?: { previewId: string; params: Record<string, number>; baseRunId: string } };
}

/** The six report operations plus explicit lifecycle commands (report §5.3). */
export interface StudyHarnessAdapter {
  getCapabilities(): CapabilityReport;
  validate(request: ActivityRequest, signal?: AbortSignal): Promise<ValidationReport>;
  prepare(request: ActivityRequest, input: CommandBase, signal?: AbortSignal): Promise<{ ok: true; prepared: PreparedActivity } | CommandFailure>;
  getState(activityId: string, audience: AudienceState['audience']): AudienceState | CommandFailure;
  summarizeInteraction(activityId: string, options: { audience: InteractionSummary['audience']; fromSequence?: number; toSequence?: number; limits?: Partial<{ committedConfigurations: number; previewObservations: number; bytes: number }> }): InteractionSummary | CommandFailure;
  restore(artifact: unknown, input: CommandBase & { hostSessionRevision: number }, signal?: AbortSignal): Promise<RestoreResult | CommandFailure>;
  dispose(activityId?: string): void;
  /** Isolated sampling, separately authorized by policy.sampling; never mutates learner state. */
  sample(request: { activityId: string; parameters: Record<string, number>; positions: PositionRequest[]; audience: 'host' | 'teacher' }, signal?: AbortSignal): Promise<{ ok: true; frames: unknown[]; provenance: { model: ModelRef; scientificRevision: string; runtime: { id: string; version: string } } } | CommandFailure>;
  /**
   * Standing of a host policy judged by this adapter's host clock (activity-runtime §1: the latest host timestamp it has
   * observed — policy issue times, receipts and acknowledgements): `POLICY_DENIED` when it is revoked or invalid,
   * `POLICY_EXPIRED` when host time has reached `expiresAt`, otherwise null. Callers that read the host policy themselves
   * (the agent tools) judge it with this before every step instead of with the policy's own issue time.
   */
  policyStanding(policy: HostPolicy): Diagnostic | null;
  /** Host-only operational metrics of every open activity (or one); contains no content. Answered after disposal too. */
  getDiagnostics(activityId?: string): AdapterDiagnostics | CommandFailure;
  /** Local redacted diagnostic export with the execution identity attached; never transmitted by the toolkit. */
  exportDiagnostics(options?: { activityId?: string }): DiagnosticExport | CommandFailure;
  /** Developer inspection entry, refused with POLICY_DENIED unless the current host policy sets `inspection.developer`. */
  inspectDeveloper(activityId: string): DeveloperInspection | CommandFailure;
}

export interface AdapterOptions {
  catalog: ActivityCatalog;
  host: HostPort;
  /** Shared bounded worker budget across activities. */
  maxWorkers?: number;
  outboxLimit?: number;
  /**
   * How long a step that must flush the journal first (stage transition, reveal, assistance, close) waits for in-flight
   * batches before it is refused with `PERSISTENCE_PENDING` and the card shows the awaiting-persistence state
   * (0–60,000 ms, default `DEFAULT_PERSISTENCE_WAIT_MS`).
   */
  persistenceWaitMs?: number;
  clock?: { monotonic(): number };
  idFactory?: () => string;
}

export type { ToolOperation };
