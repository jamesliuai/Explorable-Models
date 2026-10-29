/**
 * Authoritative JSON Schemas (2020-12 subset, see `@explorable-models/core/model` json-schema) for every Study
 * Harness record and host-port message, schema 1.0. `npm run generate:contracts` emits them to
 * `packages/activity/schema/*.schema.json`; the Rust crate in `packages/activity/rust` validates the same files.
 * Every object rejects unknown fields and every string, array, map and number is bounded. Cross-references are
 * checked separately by ./semantic.ts. Enum lists are proven against the TypeScript unions at compile time.
 */
import { CAPABILITY_VERSION_PATTERN, MANIFEST_DATA_LIMITS, MANIFEST_LIMITS, MODEL_MANIFEST_SCHEMA, S, type JsonSchema, type UnitId } from '@explorable-models/core/model';
import {
  ACTIVITY_SCHEMA_VERSION, CONTRACTS, SUMMARY_LIMITS, type ActivityArtifact, type ActorKind, type AlternativeSpec, type ContentRef,
  type ContractName, type DiagnosticCode, type DisplayEndReason, type DisplayStatus, type EventType, type GroupKind, type LifecycleStatus, type MarkKind,
  type MarkRole, type MarkerShape, type LabelPlacement, type PersistenceStatus, type ResponseRef, type StageKind, type ToolOperation, type ViewKind,
} from './contracts.js';
import { DISCRETE_ITERATION_LIMITS, SPATIAL_3D_GEOMETRY_KINDS, SPATIAL_3D_LIMITS } from './capabilities.js';
import { INTEGRITY_FIELDS } from './identity.js';

export const MODEL_MANIFEST_CONTRACT = 'explorable-models.model-manifest' as const;
/** Host-port messages validated at the native/host boundary. Names are stable schema identities. */
export const MESSAGES = Object.freeze({
  activityRequest: 'study-harness.activity-request',
  stageTransitionRequest: 'study-harness.stage-transition-request',
  exposureIntentRequest: 'study-harness.exposure-intent-request',
  displayAckRequest: 'study-harness.display-ack-request',
  assistanceRequest: 'study-harness.assistance-request',
  appendEventsRequest: 'study-harness.append-events-request',
  appendResult: 'study-harness.append-result',
  journalCursor: 'study-harness.journal-cursor',
  registerActivityRequest: 'study-harness.register-activity-request',
  saveArtifactRequest: 'study-harness.save-artifact-request',
  activityLookupRequest: 'study-harness.activity-lookup-request',
  hostAck: 'study-harness.host-ack',
  // Additive in 1.0: the reply of the optional `HostPort.getActivityRecords`.
  activityRecords: 'study-harness.activity-records',
} as const);
export type MessageName = typeof MESSAGES[keyof typeof MESSAGES];
export type SchemaName = ContractName | MessageName | typeof MODEL_MANIFEST_CONTRACT;

export const LIMITS = Object.freeze({
  id: 128, label: 200, text: 4000, tex: 4096, locale: 35, code: 64,
  capabilities: 16, groups: 64, groupMembers: 256, views: 16, marksPerView: 256, viewQuantities: 128, viewEquations: 64,
  controls: 64, displayUnits: 8, scenarios: 64, parameters: 64, equations: 64, stages: 16, transitions: 32,
  alternatives: 64, alternativeCovers: 64, taskFamilies: 32, contentRefs: 128, labelOffset: 1000, labelWidthEm: 100,
  approved: 64, tools: 32, policyGroups: 64, policyControls: 64, samplingPositions: 1000,
  objectives: 32, responses: 256, quantities: 128,
  // Model-derived bounds come from the manifest contract, so every value and position a valid model frame can carry
  // is recordable: a quantity value has at most max(vector length, matrix rows·columns) numbers.
  quantityValueItems: Math.max(MANIFEST_LIMITS.vectorLength, MANIFEST_LIMITS.matrixSide ** 2), maxIndex: MANIFEST_LIMITS.maxIndex,
  grantGroups: 64, comparisons: 16, presentationViews: 16, layers: 64, cameraZoom: 1e6,
  causes: 16, payloadEntries: 32, payloadArray: 64, eventsPerAppend: 32,
  committedConfigurations: SUMMARY_LIMITS.committedConfigurations, previewObservations: SUMMARY_LIMITS.previewObservations,
  renderedSamples: 20, revealed: 64, summaryComparisons: 64, summaryLimitations: 32,
  exposures: 256, pendingEvents: 256, reviewRefs: 64, artifactSchemas: 32, integrityEntries: 32, migrationNotes: 64, reviewLimitations: 32,
  assistanceRefs: 256,
});

/**
 * Data limits applied before schema traversal (identical in the Rust validator). `maxPayloadBytes` bounds each event
 * payload with the same byte accounting (activity-runtime §5: payload ≤ 8 KiB).
 */
export interface RecordDataLimits { maxBytes: number; maxDepth: number; maxNodes: number; maxPayloadBytes?: number }
export const RECORD_DATA_LIMITS: RecordDataLimits = Object.freeze({ maxBytes: 512 * 1024, maxDepth: 32, maxNodes: 100_000 });
export const EVENT_DATA_LIMITS: RecordDataLimits = Object.freeze({ ...RECORD_DATA_LIMITS, maxPayloadBytes: 8 * 1024 });
export const ARTIFACT_DATA_LIMITS: RecordDataLimits = Object.freeze({ maxBytes: 4 * 1024 * 1024, maxDepth: 32, maxNodes: 400_000 });

export const CONTRACT_NAME_PATTERN = '^[a-z][a-z0-9-]{0,63}([.][a-z][a-z0-9-]{0,63}){1,3}$';
export const SCHEMA_VERSION_PATTERN = '^[0-9]{1,4}[.][0-9]{1,4}$';
export const LOCALE_PATTERN = '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$';
export const CODE_PATTERN = '^[A-Z][A-Z0-9_]{0,63}$';
export const OPERATION_PATTERN = '^[A-Za-z][A-Za-z0-9.-]{0,63}$';
export const DATE_PATTERN = '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';

/** Compile-time proof that a value list covers exactly the union `T` (no missing and no extra members). */
const values = <T extends string>() => <const L extends readonly T[]>(list: L & ([T] extends [L[number]] ? unknown : { missing: Exclude<T, L[number]> })): L => list;

/** Local literal list (not core's table order) so a core refactor cannot change frozen activity schema digests. */
const UNITS = values<UnitId>()(['dimensionless', 'iteration', 'm', 'cm', 'mm', 's', 'ms', 'kg', 'g', 'm/s^2', 'N', 'rad', 'deg']);
export const TOOL_OPERATIONS = values<ToolOperation>()(['discover', 'prepare', 'inspect.learner', 'inspect.tutor', 'inspect.teacher', 'propose-revision', 'request-reveal',
  'operate.parameters', 'operate.navigation', 'operate.playback', 'operate.presentation', 'summarize', 'save', 'restore', 'close', 'sample', 'compose.exploratory']);
export const EVENT_TYPES = values<EventType>()(['activity.prepared', 'activity.opened', 'activity.closed', 'stage.changed',
  'response.submitted', 'response.superseded', 'response.invalidated', 'reveal.requested', 'reveal.authorized', 'reveal.displayed', 'reveal.uncertain',
  'exposure.scope-authorized', 'preview.started', 'preview.observed', 'preview.cancelled', 'parameters.committed', 'position.changed',
  'playback.started', 'playback.paused', 'playback.ended', 'comparison.retained', 'comparison.removed', 'view.changed', 'help.requested',
  'assistance.recorded', 'context.independent-entered', 'context.instructional-reopened', 'activity.suspended', 'activity.resumed',
  'artifact.saved', 'artifact.restored', 'operation.failed', 'content.revoked']);
export const DIAGNOSTIC_CODES = values<DiagnosticCode>()(['UNSUPPORTED_CAPABILITY', 'INVALID_REFERENCE', 'INVALID_INPUT', 'SCHEMA', 'CONSTRAINT_VIOLATION',
  'OUT_OF_DOMAIN', 'UNDEFINED_CALCULATION', 'NUMERICAL_LIMIT', 'STALE_MODEL_REVISION', 'STALE_ACTIVITY_REVISION', 'STALE_POLICY_REVISION',
  'STALE_HOST_REVISION', 'STALE_PRESENTATION_REVISION', 'POLICY_DENIED', 'POLICY_EXPIRED', 'CONTENT_REVOKED', 'REVIEW_UNVERIFIED',
  'PERSISTENCE_PENDING', 'PERSISTENCE_FAILED', 'PERSISTENCE_BACKPRESSURE', 'WORKER_ERROR', 'WORKER_TIMEOUT', 'UNSUPPORTED_ARTIFACT',
  'MIGRATION_REQUIRED', 'INTEGRITY_FAILURE', 'CANCELLED', 'DISPOSED', 'CONFLICT', 'OPERATION_CONFLICT', 'PREVIEW_ACTIVE', 'NOT_READY',
  'RESOURCE_LIMIT', 'RECEIPT_MISMATCH', 'CAPTURE_REJECTED', 'INDEPENDENT_CONTEXT', 'NOT_FOUND', 'DUPLICATE_ID', 'KIND_MISMATCH',
  'UNIT_MISMATCH', 'EQUATION_DISCLOSURE', 'MISSING_EQUIVALENT', 'NEVER_VISIBLE', 'UNREFERENCED']);
const GROUP_KINDS = values<GroupKind>()(['view', 'mark', 'quantity', 'equation', 'dataset', 'control', 'annotation', 'alternative']);
const MARK_KINDS = values<MarkKind>()(['curve', 'point', 'points', 'arrow', 'segment', 'segments', 'polygon', 'angle', 'region', 'label', 'trace', 'bar', 'grid', 'surface', 'vector-field']);
const MARK_ROLES = values<MarkRole>()(['primary', 'secondary', 'accent', 'muted', 'positive', 'negative', 'warning', 'reference']);
const MARKERS = values<MarkerShape>()(['circle', 'square', 'diamond', 'triangle', 'cross', 'none']);
const ANCHORS = values<LabelPlacement['anchor']>()(['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw', 'center']);
const VIEW_KINDS = values<ViewKind>()(['scene2d', 'plot2d', 'values', 'equation', 'table', 'scene3d']);
const STAGE_KINDS = values<StageKind>()(['prepare', 'predict', 'explore', 'explain', 'closed']);
const ALTERNATIVE_KINDS = values<AlternativeSpec['kind']>()(['table', 'description', 'projection-2d', 'numeric-entry', 'keyboard', 'alternative-activity']);
const EQUIVALENCE = values<AlternativeSpec['equivalence']>()(['equivalent', 'partial', 'alternative-activity']);
const CONTENT_KINDS = values<ContentRef['kind']>()(['derivation', 'assumption', 'source', 'learner-copy']);
const LIFECYCLE = values<LifecycleStatus>()(['authored', 'validated', 'reference-checked', 'reviewed', 'deprecated', 'revoked']);
const ACTORS = values<ActorKind>()(['learner', 'tutor', 'host']);
const RESPONSE_KINDS = values<ResponseRef['kind']>()(['prediction', 'explanation', 'answer']);
const MODALITIES = values<ResponseRef['modality']>()(['speech-derived', 'text', 'numeric', 'choice', 'diagram']);
const RESPONSE_STATUS = values<ResponseRef['status']>()(['submitted', 'superseded', 'corrected', 'disputed', 'deleted']);
const PERSISTENCE = values<PersistenceStatus>()(['saved', 'saving', 'pending-recovery', 'failed']);
const DISPLAY_STATUS = values<DisplayStatus>()(['authorized', 'displayed', 'uncertain', 'not-displayed']);
const DISPLAY_END = values<DisplayEndReason>()(['stage', 'independent', 'policy', 'revoked', 'closed']);
/** Reasons journaled with `activity.suspended` (the host's suspend reasons; a surface hidden from view reports `hidden`). */
const SUSPEND_REASONS = ['offscreen', 'collapsed', 'hidden', 'host'] as const;
/** Top-level artifact fields an integrity entry may name (everything except `integrity`). */
const ARTIFACT_FIELDS = values<Exclude<keyof ActivityArtifact, 'integrity'>>()(INTEGRITY_FIELDS);
export const LIFECYCLE_STATUSES = LIFECYCLE;

const id = S.id;
const label = () => S.text(LIMITS.label);
const text = () => S.text(LIMITS.text);
const description = () => S.string(LIMITS.text);
const revision = () => S.integer(0);
const ids = (maxItems: number, minItems = 0) => S.array(S.id(), maxItems, minItems);
const vector = (length: number) => S.array(S.number(), length, length);
const enumOf = (list: readonly (string | number | boolean | null)[]) => S.oneOfValues([...list]);
/**
 * Any finite double. Scientific quantity values are not limited to the contract-number range (±1e15): a valid frame
 * may carry any representable value, and only values beyond the double range are numerical-limit statuses (D10,
 * report §12.3). Nonfinite numbers are already rejected by the data checks before the schema runs.
 */
const finiteDouble = () => S.number(-Number.MAX_VALUE, Number.MAX_VALUE);
const ref = S.ref;
const header = (contract: string) => ({ contract: S.constant(contract), schemaVersion: S.constant(ACTIVITY_SCHEMA_VERSION) });
const quantities = () => S.map(ref('QuantityResult'), LIMITS.quantities);

// ---------------------------------------------------------------------------------------------
// Shared definitions
// ---------------------------------------------------------------------------------------------
const SHARED: Record<string, JsonSchema> = {
  ModelRef: S.object({ modelId: id(), version: S.version(), digest: S.digest() }),
  TemplateRef: S.object({ templateId: id(), version: S.version(), digest: S.digest() }),
  CapabilityRef: S.object({ id: id(), version: S.pattern(CAPABILITY_VERSION_PATTERN, 16) }),
  RuntimeRef: S.object({ id: id(), version: S.version() }),
  PolicyRef: S.object({ policyId: id(), revision: revision() }),
  GroupDigest: S.object({ groupId: id(), contentDigest: S.digest() }),
  ParameterValues: S.map(S.number(), LIMITS.parameters),
  ParameterDomain: S.map(vector(2), LIMITS.parameters),
  FramePosition: S.oneOf(
    S.object({ kind: S.constant('static') }),
    S.object({ kind: S.constant('index'), index: S.integer(0, LIMITS.maxIndex), maxIndex: S.integer(0, LIMITS.maxIndex) }),
    S.object({ kind: S.constant('time'), time: S.number(0), endTime: S.nullable(S.number(0)) })),
  QuantityValue: S.anyOf(finiteDouble(), S.array(finiteDouble(), LIMITS.quantityValueItems), S.string(LIMITS.label)),
  QuantityResult: S.oneOf(
    S.object({ status: S.constant('valid'), value: ref('QuantityValue'), approximation: S.object({ code: enumOf(['UNDERFLOW', 'ROUNDING']), reason: text() }) }, ['status', 'value']),
    S.object({ status: S.constant('undefined'), code: S.pattern(CODE_PATTERN, LIMITS.code), reason: text() }),
    S.object({ status: S.constant('numerical-limit'), code: enumOf(['OVERFLOW', 'UNDERFLOW', 'ITERATION_LIMIT']), reason: text(), lastFiniteIndex: S.integer(0, LIMITS.maxIndex) }, ['status', 'code', 'reason'])),
  ResponseRef: S.object({
    responseId: id(), taskId: id(), taskRevision: revision(), kind: enumOf(RESPONSE_KINDS), modality: enumOf(MODALITIES), stageId: id(),
    status: enumOf(RESPONSE_STATUS), supersededBy: id(),
  }, ['responseId', 'taskId', 'taskRevision', 'kind', 'modality', 'stageId', 'status']),
  ExposureGrant: S.object({
    exposureId: id(), scope: enumOf(['stage', 'reveal', 'exploration']), groups: S.array(ref('GroupDigest'), LIMITS.grantGroups, 1), parameterDomain: ref('ParameterDomain'),
  }, ['exposureId', 'scope', 'groups']),
  Camera2D: S.object({ kind: S.constant('2d'), center: vector(2), zoom: S.positive(LIMITS.cameraZoom) }),
  Camera3D: S.object({ kind: S.constant('3d'), projection: enumOf(['orthographic', 'perspective']), position: vector(3), target: vector(3), up: vector(3), preset: S.nullable(id()) }),
  JournalCursor: S.object({ activityId: id(), lastSequence: S.integer(0), lastEventId: S.nullable(id()), checkpointDigest: S.nullable(S.digest()) }),
  // Additive in 1.0: events the journal outbox could not accept (count, types when known, last journaled sequence before them).
  JournalLoss: S.object({ count: S.integer(1), types: S.array(enumOf(EVENT_TYPES), EVENT_TYPES.length), afterSequence: S.integer(0) }),
  AssistanceRef: S.object({
    receiptId: id(), kind: enumOf(['help', 'reopen-instructional']), sequence: S.integer(1),
    grant: S.nullable(S.object({ exposureId: id(), groups: ids(LIMITS.grantGroups, 1) })),
  }),
};

// ---------------------------------------------------------------------------------------------
// Activity template
// ---------------------------------------------------------------------------------------------
const TEMPLATE_DEFS: Record<string, JsonSchema> = {
  ContentGroup: S.object({ id: id(), kind: enumOf(GROUP_KINDS), label: label(), description: description(), solutionBearing: S.boolean(), members: ids(LIMITS.groupMembers) }),
  LabelPlacement: S.object({ anchor: enumOf(ANCHORS), offset: S.array(S.number(-LIMITS.labelOffset, LIMITS.labelOffset), 2, 2), leader: S.boolean(), maxWidthEm: S.number(1, LIMITS.labelWidthEm) }),
  MarkSpec: S.object({
    id: id(), kind: enumOf(MARK_KINDS), group: id(), label: label(),
    bindings: S.object({ geometry: id(), at: id(), vector: id(), from: id(), to: id(), vertices: id(), value: id(), origin: id() }, []),
    style: S.object({ role: enumOf(MARK_ROLES), dash: enumOf(['solid', 'dashed', 'dotted']), marker: enumOf(MARKERS), weight: enumOf(['thin', 'regular', 'bold']) }),
    text: text(), placement: ref('LabelPlacement'),
    drag: S.anyOf(S.object({ x: id(), y: id() }, ['x']), S.object({ x: id(), y: id() }, ['y'])),
    // Optional and additive in 1.0: the bound segments depict unbounded lines clipped to the view.
    extent: enumOf(['bounded', 'line']),
  }, ['id', 'kind', 'group', 'label', 'bindings', 'style']),
  AxisSpec: S.object({ label: label(), unit: enumOf(UNITS), quantity: id() }, ['label', 'unit']),
  ViewSpec: S.object({
    id: id(), kind: enumOf(VIEW_KINDS), group: id(), title: label(), description: text(), bounds: vector(4), bounds3: vector(6), equalAspect: S.boolean(),
    axes: S.object({ x: ref('AxisSpec'), y: ref('AxisSpec'), z: ref('AxisSpec') }, ['x', 'y']),
    marks: S.array(ref('MarkSpec'), LIMITS.marksPerView), quantities: ids(LIMITS.viewQuantities), equations: ids(LIMITS.viewEquations), rowsFrom: id(),
  }, ['id', 'kind', 'group', 'title', 'description', 'equalAspect', 'marks']),
  ControlSpec: S.object({
    parameter: id(), group: id(), label: label(), displayUnits: S.array(enumOf(UNITS), LIMITS.displayUnits, 1), slider: S.boolean(), exact: S.boolean(),
    step: S.positive(), description: description(),
    // Optional and additive in 1.0: a labelled presentation section that groups related controls (report §10.2).
    section: S.object({ id: id(), label: label() }),
  }, ['parameter', 'group', 'label', 'displayUnits', 'slider', 'exact', 'step', 'description']),
  ScenarioSpec: S.object({ id: id(), label: label(), description: description(), parameters: ref('ParameterValues'), group: id() }),
  EquationSpec: S.object({ id: id(), group: id(), label: label(), tex: S.text(LIMITS.tex), plain: S.text(LIMITS.tex) }),
  StageSpec: S.object({
    id: id(), kind: enumOf(STAGE_KINDS), instruction: text(),
    visible: S.map(enumOf(['fixed', 'interactive']), LIMITS.groups), controls: S.map(enumOf(['interactive', 'fixed']), LIMITS.parameters),
    allowsPreview: S.boolean(), allowsPlayback: S.boolean(), allowsNavigation: S.boolean(),
    response: S.object({ kind: enumOf(['prediction', 'explanation']), prompt: text(), taskFamily: id() }),
  }, ['id', 'kind', 'instruction', 'visible', 'controls', 'allowsPreview', 'allowsPlayback', 'allowsNavigation']),
  TransitionSpec: S.object({ id: id(), from: id(), to: id(), label: label() }),
  AlternativeSpec: S.object({
    id: id(), kind: enumOf(ALTERNATIVE_KINDS), group: id(), label: label(), covers: ids(LIMITS.alternativeCovers, 1), equivalence: enumOf(EQUIVALENCE),
    description: text(), verifiedBy: label(),
  }),
  TaskFamilyRef: S.object({ id: id(), description: text(), hostOwned: S.constant(true) }),
  ContentRef: S.object({ id: id(), kind: enumOf(CONTENT_KINDS), text: text() }),
  QuantityDisplaySpec: S.object({ units: S.array(enumOf(UNITS), LIMITS.displayUnits, 1) }),
};
const ActivityTemplate = S.object({
  ...header(CONTRACTS.template), templateId: id(), version: S.version(), model: ref('ModelRef'), title: label(), purpose: text(),
  dimension: enumOf(['2d', '3d']), locale: S.pattern(LOCALE_PATTERN, LIMITS.locale), requires: S.array(ref('CapabilityRef'), LIMITS.capabilities),
  groups: S.array(ref('ContentGroup'), LIMITS.groups, 1), views: S.array(ref('ViewSpec'), LIMITS.views, 1), controls: S.array(ref('ControlSpec'), LIMITS.controls),
  scenarios: S.array(ref('ScenarioSpec'), LIMITS.scenarios), equations: S.array(ref('EquationSpec'), LIMITS.equations),
  stages: S.array(ref('StageSpec'), LIMITS.stages, 1), transitions: S.array(ref('TransitionSpec'), LIMITS.transitions), initialStage: id(),
  alternatives: S.array(ref('AlternativeSpec'), LIMITS.alternatives), taskFamilies: S.array(ref('TaskFamilyRef'), LIMITS.taskFamilies),
  content: S.array(ref('ContentRef'), LIMITS.contentRefs),
  // Optional and additive in 1.0: per-quantity display units (report §8.3).
  quantityDisplay: S.map(ref('QuantityDisplaySpec'), LIMITS.quantities),
}, ['contract', 'schemaVersion', 'templateId', 'version', 'model', 'title', 'purpose', 'dimension', 'locale', 'requires', 'groups', 'views', 'controls',
  'scenarios', 'equations', 'stages', 'transitions', 'initialStage', 'alternatives', 'taskFamilies', 'content']);

// ---------------------------------------------------------------------------------------------
// Review, policy, instance, receipts, exposure, snapshots
// ---------------------------------------------------------------------------------------------
const ReviewRecord = S.object({
  ...header(CONTRACTS.review), reviewId: id(),
  subject: S.oneOf(
    S.object({ kind: S.constant('model'), modelId: id(), version: S.version(), scientificRevision: S.digest() }),
    S.object({ kind: S.constant('template'), templateId: id(), version: S.version(), contentDigest: S.digest() })),
  reviewer: S.object({ name: label(), role: label(), affiliation: label() }, ['name', 'role']),
  date: S.pattern(DATE_PATTERN, 10), scope: text(), limitations: S.array(text(), LIMITS.reviewLimitations), referenceSuiteDigest: S.digest(),
  outcome: enumOf(['approved', 'approved-with-limitations', 'rejected']),
});
const tools = () => S.array(enumOf(TOOL_OPERATIONS), LIMITS.tools);
const HostPolicy = S.object({
  ...header(CONTRACTS.policy), policyId: id(), revision: revision(), issuedAt: S.timestamp(), expiresAt: S.nullable(S.timestamp()), revoked: S.boolean(),
  mode: enumOf(['approved', 'exploratory']), approved: S.array(S.object({ template: ref('TemplateRef'), model: ref('ModelRef') }), LIMITS.approved),
  allowedTools: tools(), visibleGroups: ids(LIMITS.policyGroups), permittedControls: ids(LIMITS.policyControls),
  export: S.object({ learnerSnapshot: S.boolean(), capture: S.boolean(), backup: S.boolean() }),
  inspection: S.object({ developer: S.boolean(), tutor: enumOf(['learner-visible', 'full']), teacher: S.boolean() }),
  independentTask: S.object({ active: S.boolean(), taskRef: S.nullable(id()), permittedTools: tools(), neutralScaffold: ids(LIMITS.policyGroups) }),
  sampling: S.object({ allowed: S.boolean(), maxPositions: S.integer(0, LIMITS.samplingPositions) }),
  exploratory: S.object({ allowed: S.boolean(), maxParametersOverride: S.integer(0, LIMITS.parameters) }),
});
/** Instructional or independent context (an activity instance's, and the host's context lineage in activity records). */
const ActivityContext = S.oneOf(S.object({ kind: S.constant('instructional') }), S.object({ kind: S.constant('independent'), taskRef: id() }));
const ActivityInstance = S.object({
  ...header(CONTRACTS.instance), activityId: id(), objectiveIds: ids(LIMITS.objectives), hostSessionId: id(), hostSessionRevision: revision(),
  template: ref('TemplateRef'), model: ref('ModelRef'), initialParameters: ref('ParameterValues'), mode: enumOf(['approved', 'exploratory']),
  stage: S.object({ id: id(), enteredAtSequence: S.integer(0) }), activityRevision: revision(), policy: ref('PolicyRef'),
  context: ActivityContext,
  responses: S.array(ref('ResponseRef'), LIMITS.responses), allowedActions: tools(), persistence: enumOf(PERSISTENCE), closed: S.boolean(),
});
const receiptBase = (contract: string) => ({
  ...header(contract), receiptId: id(), activityId: id(), basedOnActivityRevision: revision(), activityRevision: revision(), policyId: id(),
  policyRevision: revision(), idempotencyKey: id(), template: ref('TemplateRef'), model: ref('ModelRef'), issuedAt: S.timestamp(), expiresAt: S.nullable(S.timestamp()),
});
const ExposureReceipt = S.object({ ...receiptBase(CONTRACTS.exposureReceipt), grant: ref('ExposureGrant'), intendedStage: id() });
const StageReceipt = S.object({ ...receiptBase(CONTRACTS.stageReceipt), fromStage: id(), toStage: id(), grant: S.nullable(ref('ExposureGrant')) });
const AssistanceReceipt = S.object({ ...receiptBase(CONTRACTS.assistanceReceipt), kind: enumOf(['help', 'reopen-instructional']), grant: S.nullable(ref('ExposureGrant')) });
const ExposureRecord = S.object({
  ...header(CONTRACTS.exposure), exposureId: id(), activityId: id(), receiptId: id(), scope: enumOf(['stage', 'reveal', 'exploration']),
  groups: S.array(ref('GroupDigest'), LIMITS.grantGroups, 1), template: ref('TemplateRef'), model: ref('ModelRef'), activityRevision: revision(),
  intendedStage: id(), parameterDomain: ref('ParameterDomain'), displayStatus: enumOf(DISPLAY_STATUS),
  // endedMonotonicMs/endedBy are optional and additive in 1.0: the end of the observed display interval.
  displayed: S.object({ projectionDigest: S.digest(), frameId: id(), monotonicMs: S.number(0), endedMonotonicMs: S.number(0), endedBy: enumOf(DISPLAY_END) }, ['projectionDigest', 'frameId', 'monotonicMs']),
  uncertainty: S.object({ code: enumOf(['ACK_NOT_PERSISTED', 'INTERRUPTED_BEFORE_ACK', 'SURFACE_LOST']), reason: text() }),
}, ['contract', 'schemaVersion', 'exposureId', 'activityId', 'receiptId', 'scope', 'groups', 'template', 'model', 'activityRevision', 'intendedStage', 'displayStatus']);
const ScientificSnapshot = S.object({
  ...header(CONTRACTS.scientific), model: ref('ModelRef'), scientificRevision: S.digest(), runtime: ref('RuntimeRef'), runId: id(), restoredFrom: id(),
  params: ref('ParameterValues'), position: ref('FramePosition'), terminal: S.boolean(),
  comparisons: S.array(S.object({ runId: id(), label: label(), params: ref('ParameterValues'), position: ref('FramePosition') }), LIMITS.comparisons),
}, ['contract', 'schemaVersion', 'model', 'scientificRevision', 'runtime', 'runId', 'params', 'position', 'terminal', 'comparisons']);
const PresentationSnapshot = S.object({
  ...header(CONTRACTS.presentation), revision: revision(),
  views: S.map(S.object({ camera: S.oneOf(ref('Camera2D'), ref('Camera3D'), S.null()), layers: ids(LIMITS.layers) }), LIMITS.presentationViews),
  selection: S.nullable(id()), layout: enumOf(['auto', 'card', 'side', 'expanded']), displayUnits: S.map(enumOf(UNITS), LIMITS.parameters),
  locale: S.pattern(LOCALE_PATTERN, LIMITS.locale), formatVersion: S.constant('1.0'),
});

// ---------------------------------------------------------------------------------------------
// Interaction events: one variant per type, each with its own payload schema
// ---------------------------------------------------------------------------------------------
const PAYLOAD_DEFS: Record<string, JsonSchema> = {
  // Closed payloads of the lifecycle, help and revocation events (replacing the open generic payload in 1.0, pre-release).
  'payload.activity.prepared': S.object({ templateId: id(), templateVersion: S.version(), mode: enumOf(['approved', 'exploratory']), stageId: id() }),
  'payload.activity.opened': S.object({ stageId: id() }),
  'payload.activity.closed': S.object({ reason: text(), pending: enumOf(['cancel', 'commit', 'retain']) }, ['reason']),
  'payload.activity.suspended': S.object({ reason: enumOf(SUSPEND_REASONS) }),
  'payload.empty': S.object({}),
  'payload.content.revoked': S.object({ source: enumOf(['host', 'policy', 'catalogue']), code: enumOf(DIAGNOSTIC_CODES), reason: text() }, ['source', 'code']),
  'payload.parameters.committed': S.object({
    runId: id(), previousRunId: S.nullable(id()), params: ref('ParameterValues'), cause: enumOf(['initial', 'commit', 'reset', 'scenario', 'restore', 'undo']),
    scenarioId: id(), previewId: id(), gesture: enumOf(['pointer', 'keyboard', 'exact', 'drag']), visibleQuantities: quantities(),
    // Additive in 1.0: parameters shown as controls when the event was recorded (restricted summaries list only these).
    visibleParameters: ids(LIMITS.parameters),
  }, ['runId', 'previousRunId', 'params', 'cause']),
  'payload.preview.started': S.object({ previewId: id(), baseRunId: id(), parameter: id(), gesture: enumOf(['pointer', 'keyboard', 'exact', 'drag']) }),
  'payload.preview.observed': S.object({
    previewId: id(), outcome: enumOf(['committed', 'cancelled', 'interrupted']), samplingPolicy: label(),
    rendered: S.array(S.object({ params: ref('ParameterValues'), frameId: id(), visibleQuantities: quantities() }, ['params', 'frameId']), LIMITS.renderedSamples),
    omitted: S.integer(0),
    // Additive in 1.0: parameters shown as controls during the preview (restricted summaries list only these).
    visibleParameters: ids(LIMITS.parameters),
  }, ['previewId', 'outcome', 'samplingPolicy', 'rendered', 'omitted']),
  'payload.preview.cancelled': S.object({ previewId: id(), reason: enumOf(['escape', 'pointercancel', 'blur', 'navigation', 'revoked', 'superseded']) }),
  'payload.reveal.requested': S.object({ idempotencyKey: id(), scope: enumOf(['stage', 'reveal', 'exploration']), groups: S.array(ref('GroupDigest'), LIMITS.grantGroups, 1), intendedStage: id() }),
  'payload.exposure.authorized': S.object({
    exposureId: id(), receiptId: id(), scope: enumOf(['stage', 'reveal', 'exploration']), groups: S.array(ref('GroupDigest'), LIMITS.grantGroups, 1),
    activityRevision: revision(), parameterDomain: ref('ParameterDomain'),
  }, ['exposureId', 'receiptId', 'scope', 'groups', 'activityRevision']),
  'payload.reveal.displayed': S.object({ exposureId: id(), receiptId: id(), projectionDigest: S.digest(), frameId: id(), surfaceId: id() }),
  'payload.reveal.uncertain': S.object({ exposureId: id(), receiptId: id(), code: enumOf(['ACK_NOT_PERSISTED', 'INTERRUPTED_BEFORE_ACK', 'SURFACE_LOST']), reason: text() }),
  'payload.stage.changed': S.object({ fromStage: id(), toStage: id(), receiptId: id(), activityRevision: revision(), transitionId: id() }, ['fromStage', 'toStage', 'receiptId', 'activityRevision']),
  'payload.response.submitted': S.object({ response: ref('ResponseRef') }),
  'payload.response.updated': S.object({ responseId: id(), status: enumOf(['superseded', 'corrected', 'disputed', 'deleted']), supersededBy: id() }, ['responseId', 'status']),
  'payload.position.changed': S.object({
    runId: id(), from: ref('FramePosition'), to: ref('FramePosition'), cause: enumOf(['navigate', 'step', 'restart', 'playback']), visibleQuantities: quantities(),
  }, ['runId', 'from', 'to', 'cause']),
  'payload.playback': S.object({ runId: id(), position: ref('FramePosition') }),
  // Additive in 1.0: why playback stopped by itself (the exact end, the last representable position before a numerical
  // limit, or a failed evaluation). Absent in events written before the field existed.
  'payload.playback.ended': S.object({ runId: id(), position: ref('FramePosition'), reason: enumOf(['terminal', 'numerical-limit', 'error']) }, ['runId', 'position']),
  'payload.comparison.retained': S.object({ runId: id(), label: label() }),
  'payload.comparison.removed': S.object({ runId: id() }),
  'payload.view.changed': S.object({
    change: enumOf(['camera', 'reset-view', 'display-unit', 'selection', 'layout']), presentationRevision: revision(), viewId: id(), parameter: id(),
    unit: enumOf(UNITS), layout: enumOf(['auto', 'card', 'side', 'expanded']), selection: S.nullable(id()),
  }, ['change', 'presentationRevision']),
  'payload.assistance.recorded': S.object({ receiptId: id(), kind: enumOf(['help', 'reopen-instructional']) }),
  'payload.context.independent-entered': S.object({ taskRef: id(), policyRevision: revision() }),
  'payload.context.instructional-reopened': S.object({ receiptId: id() }),
  'payload.artifact.saved': S.object({ artifactId: id(), kind: enumOf(['backup', 'learner-snapshot']), artifactDigest: S.digest(), cursor: S.integer(0) }),
  'payload.artifact.restored': S.object({
    artifactId: id(), kind: enumOf(['backup', 'learner-snapshot']), artifactDigest: S.digest(), restored: enumOf(['exact', 'restricted', 'read-only']),
    migratedFrom: S.object({ contract: S.pattern(CONTRACT_NAME_PATTERN, LIMITS.id), version: S.pattern(SCHEMA_VERSION_PATTERN, 9) }),
  }, ['artifactId', 'kind', 'artifactDigest', 'restored']),
  // `lost` (additive in 1.0) records events the journal outbox could not accept.
  'payload.operation.failed': S.object({ operation: S.pattern(OPERATION_PATTERN, 64), code: enumOf(DIAGNOSTIC_CODES), recoverable: S.boolean(), path: S.string(LIMITS.label), lost: ref('JournalLoss') }, ['operation', 'code', 'recoverable']),
};
/** Payload schema per event type; every type has a closed payload schema. */
export const EVENT_PAYLOADS: Readonly<Record<EventType, string>> = Object.freeze({
  'activity.prepared': 'payload.activity.prepared', 'activity.opened': 'payload.activity.opened', 'activity.closed': 'payload.activity.closed',
  'activity.suspended': 'payload.activity.suspended', 'activity.resumed': 'payload.empty', 'help.requested': 'payload.empty', 'content.revoked': 'payload.content.revoked',
  'parameters.committed': 'payload.parameters.committed', 'preview.started': 'payload.preview.started', 'preview.observed': 'payload.preview.observed',
  'preview.cancelled': 'payload.preview.cancelled', 'reveal.requested': 'payload.reveal.requested', 'reveal.authorized': 'payload.exposure.authorized',
  'exposure.scope-authorized': 'payload.exposure.authorized', 'reveal.displayed': 'payload.reveal.displayed', 'reveal.uncertain': 'payload.reveal.uncertain',
  'stage.changed': 'payload.stage.changed', 'response.submitted': 'payload.response.submitted', 'response.superseded': 'payload.response.updated',
  'response.invalidated': 'payload.response.updated', 'position.changed': 'payload.position.changed', 'playback.started': 'payload.playback',
  'playback.paused': 'payload.playback', 'playback.ended': 'payload.playback.ended', 'comparison.retained': 'payload.comparison.retained',
  'comparison.removed': 'payload.comparison.removed', 'view.changed': 'payload.view.changed', 'assistance.recorded': 'payload.assistance.recorded',
  'context.independent-entered': 'payload.context.independent-entered', 'context.instructional-reopened': 'payload.context.instructional-reopened',
  'artifact.saved': 'payload.artifact.saved', 'artifact.restored': 'payload.artifact.restored', 'operation.failed': 'payload.operation.failed',
});
const EVENT_DEFS: Record<string, JsonSchema> = {
  Actor: S.object({ kind: enumOf(ACTORS), binding: id() }),
  EventRevisions: S.object({
    scientific: S.object({ modelDigest: S.digest(), runId: S.nullable(id()), version: revision() }), presentation: revision(), activity: revision(),
    hostSession: revision(), policy: revision(),
  }),
  FrameRef: S.object({ frameId: id(), runId: id(), kind: enumOf(['committed', 'tentative']), position: ref('FramePosition') }),
  ...Object.fromEntries(EVENT_TYPES.map(type => [`event.${type}`, S.object({
    ...header(CONTRACTS.event), eventId: id(), activityId: id(), sequence: S.integer(1), operationId: id(), actor: ref('Actor'), type: S.constant(type),
    revisions: ref('EventRevisions'), frame: ref('FrameRef'), payload: ref(EVENT_PAYLOADS[type]), monotonicMs: S.number(0), causes: ids(LIMITS.causes),
  }, ['contract', 'schemaVersion', 'eventId', 'activityId', 'sequence', 'operationId', 'actor', 'type', 'revisions', 'payload', 'monotonicMs', 'causes'])])),
};
const InteractionEvent = S.oneOf(...EVENT_TYPES.map(type => ref(`event.${type}`)));

// ---------------------------------------------------------------------------------------------
// Summary and artifact
// ---------------------------------------------------------------------------------------------
const InteractionSummary = S.object({
  ...header(CONTRACTS.summary), summarizerVersion: S.version(), activityId: id(), audience: enumOf(['learner', 'tutor', 'teacher', 'host']),
  template: ref('TemplateRef'), model: ref('ModelRef'), cursor: S.object({ fromSequence: S.integer(0), toSequence: S.integer(0), acknowledgedThrough: S.integer(0) }),
  complete: S.boolean(),
  committedConfigurations: S.array(S.object({
    runId: id(), params: ref('ParameterValues'), furthestPosition: S.nullable(ref('FramePosition')), cause: enumOf(['initial', 'commit', 'reset', 'scenario', 'restore', 'undo']),
    sequence: S.integer(1), observations: quantities(),
  }), LIMITS.committedConfigurations),
  previewObservations: S.array(S.object({
    previewId: id(), outcome: enumOf(['committed', 'cancelled', 'interrupted']), samplingPolicy: label(),
    rendered: S.array(S.object({ params: ref('ParameterValues'), frameId: id() }), LIMITS.renderedSamples), omitted: S.integer(0),
  }), LIMITS.previewObservations),
  revealed: S.array(S.object({ exposureId: id(), groups: ids(LIMITS.grantGroups, 1), displayStatus: enumOf(DISPLAY_STATUS), sequence: S.integer(1) }), LIMITS.revealed),
  comparisons: S.array(S.object({ runId: id(), label: label(), action: enumOf(['retained', 'removed']), sequence: S.integer(1) }), LIMITS.summaryComparisons),
  responses: S.array(ref('ResponseRef'), LIMITS.responses),
  omitted: S.object({ committedConfigurations: S.integer(0), previewObservations: S.integer(0), events: S.integer(0) }),
  limitations: S.array(text(), LIMITS.summaryLimitations), text: text(),
  // Additive in 1.0: the mode the activity ran in and the host-resolved review notice (report §5.2, §7.3).
  mode: enumOf(['approved', 'exploratory']), reviewNotice: label(),
}, ['contract', 'schemaVersion', 'summarizerVersion', 'activityId', 'audience', 'template', 'model', 'cursor', 'complete', 'committedConfigurations',
  'previewObservations', 'revealed', 'comparisons', 'responses', 'omitted', 'limitations', 'text']);
const ActivityArtifact = S.object({
  ...header(CONTRACTS.artifact), artifactId: id(), kind: enumOf(['backup', 'learner-snapshot']),
  schemas: S.array(S.object({ contract: S.pattern(CONTRACT_NAME_PATTERN, LIMITS.id), version: S.pattern(SCHEMA_VERSION_PATTERN, 9) }), LIMITS.artifactSchemas, 1),
  runtime: ref('RuntimeRef'), template: ref('TemplateRef'), model: ref('ModelRef'), policyRef: ref('PolicyRef'),
  instance: ref('ActivityInstance'), scientific: ref('ScientificSnapshot'), presentation: ref('PresentationSnapshot'),
  exposures: S.array(ref('ExposureRecord'), LIMITS.exposures),
  // pendingEvents and lost are optional and additive in 1.0 (backups only).
  journal: S.object({ cursor: ref('JournalCursor'), pendingEventIds: ids(LIMITS.pendingEvents), pendingEvents: S.array(ref('InteractionEvent'), LIMITS.pendingEvents, 1), lost: ref('JournalLoss') }, ['cursor', 'pendingEventIds']),
  pending: S.oneOf(S.object({ kind: S.constant('none') }), S.object({ kind: S.constant('preview'), previewId: id(), params: ref('ParameterValues'), baseRunId: id() })),
  contentRefs: ids(LIMITS.contentRefs), reviewRefs: ids(LIMITS.reviewRefs),
  migratedFrom: S.object({
    contract: S.pattern(CONTRACT_NAME_PATTERN, LIMITS.id), version: S.pattern(SCHEMA_VERSION_PATTERN, 9), digest: S.digest(), report: S.array(text(), LIMITS.migrationNotes),
  }),
  // Optional and additive in 1.0: assistance receipt references (report §6.4).
  assistance: S.array(ref('AssistanceRef'), LIMITS.assistanceRefs),
  // Optional and additive in 1.0: context lineage of the exposure records (restricting claims only).
  lineage: S.object({ endedExposureIds: ids(LIMITS.exposures), reopenRequired: S.boolean() }),
  integrity: S.object({
    algorithm: S.constant('sha256'), entries: S.array(S.object({ path: enumOf(ARTIFACT_FIELDS), digest: S.digest() }), LIMITS.integrityEntries, 1), digest: S.digest(),
  }),
}, ['contract', 'schemaVersion', 'artifactId', 'kind', 'schemas', 'runtime', 'template', 'model', 'policyRef', 'instance', 'scientific', 'presentation',
  'exposures', 'journal', 'pending', 'contentRefs', 'reviewRefs', 'integrity']);

// ---------------------------------------------------------------------------------------------
// Host-port messages
// ---------------------------------------------------------------------------------------------
const guardedRequest = { activityId: id(), operationId: id(), idempotencyKey: id(), basedOnActivityRevision: revision(), expectedPolicyRevision: revision(), actor: enumOf(ACTORS), template: ref('TemplateRef'), model: ref('ModelRef') };
const MESSAGE_SCHEMAS: Record<MessageName, JsonSchema> = {
  [MESSAGES.activityRequest]: S.object({
    activityId: id(), objectiveIds: ids(LIMITS.objectives), hostSessionId: id(), hostSessionRevision: revision(),
    template: S.object({ templateId: id(), version: S.version() }), parameters: ref('ParameterValues'), scenarioId: id(), mode: enumOf(['approved', 'exploratory']), stageId: id(),
  }, ['activityId', 'objectiveIds', 'hostSessionId', 'hostSessionRevision', 'template', 'mode']),
  [MESSAGES.stageTransitionRequest]: S.object({ ...guardedRequest, fromStage: id(), toStage: id(), groups: S.array(ref('GroupDigest'), LIMITS.grantGroups) }),
  [MESSAGES.exposureIntentRequest]: S.object({
    ...guardedRequest, scope: enumOf(['stage', 'reveal', 'exploration']), groups: S.array(ref('GroupDigest'), LIMITS.grantGroups, 1), parameterDomain: ref('ParameterDomain'), intendedStage: id(),
  }, [...Object.keys(guardedRequest), 'scope', 'groups', 'intendedStage']),
  [MESSAGES.displayAckRequest]: S.object({ activityId: id(), exposureId: id(), receiptId: id(), projectionDigest: S.digest(), frameId: id(), monotonicMs: S.number(0) }),
  [MESSAGES.assistanceRequest]: S.object({ ...guardedRequest, kind: enumOf(['help', 'reopen-instructional']), groups: S.array(ref('GroupDigest'), LIMITS.grantGroups) }),
  [MESSAGES.appendEventsRequest]: S.object({ activityId: id(), events: S.array(ref('InteractionEvent'), LIMITS.eventsPerAppend, 1) }),
  [MESSAGES.appendResult]: S.object({
    acknowledged: S.array(S.object({ eventId: id(), durableSequence: S.integer(1), hostTimestamp: S.timestamp() }), LIMITS.eventsPerAppend),
    duplicates: ids(LIMITS.eventsPerAppend), cursor: ref('JournalCursor'),
  }),
  [MESSAGES.journalCursor]: SHARED.JournalCursor!,
  [MESSAGES.registerActivityRequest]: S.object({ instance: ref('ActivityInstance'), operationId: id() }),
  [MESSAGES.saveArtifactRequest]: S.object({ artifact: ref('ActivityArtifact'), operationId: id() }),
  [MESSAGES.activityLookupRequest]: S.object({ activityId: id() }),
  [MESSAGES.hostAck]: S.object({ ok: S.constant(true), hostTimestamp: S.timestamp(), artifactDigest: S.digest() }, ['ok', 'hostTimestamp']),
  // `activity` (additive in 1.0): the host-owned stage, activity revision, closed state and context lineage a restore adopts.
  [MESSAGES.activityRecords]: S.object({
    activityId: id(), exposures: S.array(ref('ExposureRecord'), LIMITS.exposures), assistance: S.array(ref('AssistanceRef'), LIMITS.assistanceRefs),
    activity: S.object({
      stage: id(), activityRevision: revision(), closed: S.boolean(),
      lineage: S.object({ context: ActivityContext, fromActivityRevision: revision() }), stageReceiptId: id(),
    }, ['stage', 'activityRevision', 'closed']),
  }, ['activityId', 'exposures', 'assistance']),
};

// ---------------------------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------------------------
/**
 * Installed capability record (additive in 1.0, capabilities.ts): one closed shape per capability ID and version, each
 * limit bounded at the value this runtime enforces, so a record claiming a larger limit, an unknown capability or an
 * unknown version is invalid.
 */
const capabilityBase = (id: string) => ({ contract: S.constant(CONTRACTS.capability), schemaVersion: S.constant(ACTIVITY_SCHEMA_VERSION), id: S.constant(id), version: S.constant('1.0'), title: S.text(LIMITS.label) });
const Spatial3dCapabilityRecord = S.object({
  ...capabilityBase('spatial-3d'),
  limits: S.object(Object.fromEntries(Object.entries(SPATIAL_3D_LIMITS).map(([key, max]) => [key, S.integer(key === 'textureSize' ? 0 : 1, max)]))),
  geometryKinds: S.array(enumOf([...SPATIAL_3D_GEOMETRY_KINDS]), SPATIAL_3D_GEOMETRY_KINDS.length),
});
const DiscreteIterationCapabilityRecord = S.object({ ...capabilityBase('discrete-iteration'), limits: S.object({ maxIndex: S.integer(0, DISCRETE_ITERATION_LIMITS.maxIndex) }) });
const CapabilityRecord = S.oneOf(ref('Spatial3dCapabilityRecord'), ref('DiscreteIterationCapabilityRecord'));
const RECORDS: Record<string, JsonSchema> = {
  ActivityTemplate, ReviewRecord, HostPolicy, ActivityInstance, ExposureReceipt, StageReceipt, AssistanceReceipt, ExposureRecord,
  ScientificSnapshot, PresentationSnapshot, InteractionEvent, InteractionSummary, ActivityArtifact, CapabilityRecord,
  Spatial3dCapabilityRecord, DiscreteIterationCapabilityRecord,
};
/** Every named definition available to `$ref`; each emitted schema embeds only those it reaches. */
export const DEFINITIONS: Readonly<Record<string, JsonSchema>> = Object.freeze({ ...SHARED, ...TEMPLATE_DEFS, ...PAYLOAD_DEFS, ...EVENT_DEFS, ...RECORDS });

const RECORD_FOR_CONTRACT: Record<ContractName, string> = {
  [CONTRACTS.template]: 'ActivityTemplate', [CONTRACTS.instance]: 'ActivityInstance', [CONTRACTS.policy]: 'HostPolicy',
  [CONTRACTS.scientific]: 'ScientificSnapshot', [CONTRACTS.presentation]: 'PresentationSnapshot', [CONTRACTS.event]: 'InteractionEvent',
  [CONTRACTS.exposure]: 'ExposureRecord', [CONTRACTS.summary]: 'InteractionSummary', [CONTRACTS.artifact]: 'ActivityArtifact',
  [CONTRACTS.review]: 'ReviewRecord', [CONTRACTS.exposureReceipt]: 'ExposureReceipt', [CONTRACTS.stageReceipt]: 'StageReceipt',
  [CONTRACTS.assistanceReceipt]: 'AssistanceReceipt', [CONTRACTS.capability]: 'CapabilityRecord',
};

const DRAFT = 'https://json-schema.org/draft/2020-12/schema';
const references = (schema: unknown, found: Set<string>): Set<string> => {
  if (Array.isArray(schema)) { for (const item of schema) references(item, found); return found; }
  if (!schema || typeof schema !== 'object') return found;
  for (const [key, value] of Object.entries(schema)) {
    if (key === '$ref' && typeof value === 'string') {
      const name = value.slice('#/$defs/'.length);
      if (!DEFINITIONS[name]) throw new Error(`Schema reference ${value} has no definition.`);
      if (!found.has(name)) { found.add(name); references(DEFINITIONS[name], found); }
    } else references(value, found);
  }
  return found;
};
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const item of Object.values(value)) freeze(item); }
  return value;
};
/** Builds a standalone 2020-12 document: metadata, the body, and the transitive closure of referenced `$defs`. */
function document(name: SchemaName, title: string, body: JsonSchema): JsonSchema {
  const names = [...references(body, new Set())].sort();
  const $defs = Object.fromEntries(names.map(key => [key, structuredClone(DEFINITIONS[key]!)]));
  return freeze({ $schema: DRAFT, $id: `https://explorable-models.invalid/schema/${name}-${ACTIVITY_SCHEMA_VERSION}.json`, title, ...structuredClone(body), ...(names.length ? { $defs } : {}) });
}

const TITLES: Record<Exclude<SchemaName, typeof MODEL_MANIFEST_CONTRACT>, string> = {
  [CONTRACTS.template]: 'Study Harness activity template', [CONTRACTS.instance]: 'Study Harness activity instance', [CONTRACTS.policy]: 'Study Harness host policy',
  [CONTRACTS.scientific]: 'Study Harness scientific snapshot', [CONTRACTS.presentation]: 'Study Harness presentation snapshot',
  [CONTRACTS.event]: 'Study Harness interaction event', [CONTRACTS.exposure]: 'Study Harness exposure record', [CONTRACTS.summary]: 'Study Harness interaction summary',
  [CONTRACTS.artifact]: 'Study Harness activity artifact', [CONTRACTS.review]: 'Study Harness review record', [CONTRACTS.exposureReceipt]: 'Study Harness exposure receipt',
  [CONTRACTS.stageReceipt]: 'Study Harness stage receipt', [CONTRACTS.assistanceReceipt]: 'Study Harness assistance receipt',
  [CONTRACTS.capability]: 'Study Harness installed capability record',
  [MESSAGES.activityRequest]: 'Study Harness activity request', [MESSAGES.stageTransitionRequest]: 'Study Harness stage transition request',
  [MESSAGES.exposureIntentRequest]: 'Study Harness exposure intent request', [MESSAGES.displayAckRequest]: 'Study Harness display acknowledgement request',
  [MESSAGES.assistanceRequest]: 'Study Harness assistance request', [MESSAGES.appendEventsRequest]: 'Study Harness append events request',
  [MESSAGES.appendResult]: 'Study Harness append result', [MESSAGES.journalCursor]: 'Study Harness journal cursor',
  [MESSAGES.registerActivityRequest]: 'Study Harness register activity request', [MESSAGES.saveArtifactRequest]: 'Study Harness save artifact request',
  [MESSAGES.activityLookupRequest]: 'Study Harness activity lookup request', [MESSAGES.hostAck]: 'Study Harness host acknowledgement',
  [MESSAGES.activityRecords]: 'Study Harness activity records',
};

/** Authoritative schema per contract or message name. The model manifest schema is owned by core. */
export const SCHEMAS: Readonly<Record<SchemaName, JsonSchema>> = Object.freeze({
  ...Object.fromEntries((Object.keys(RECORD_FOR_CONTRACT) as ContractName[]).map(name => [name, document(name, TITLES[name], DEFINITIONS[RECORD_FOR_CONTRACT[name]]!)])),
  ...Object.fromEntries((Object.keys(MESSAGE_SCHEMAS) as MessageName[]).map(name => [name, document(name, TITLES[name], MESSAGE_SCHEMAS[name])])),
  [MODEL_MANIFEST_CONTRACT]: MODEL_MANIFEST_SCHEMA,
} as Record<SchemaName, JsonSchema>);
export const SCHEMA_NAMES = Object.freeze(Object.keys(SCHEMAS) as SchemaName[]);

/** Schema version per name (all 1.0 in this release; the model manifest follows core's MODEL_SCHEMA_VERSION). */
export const SCHEMA_VERSIONS: Readonly<Record<SchemaName, string>> = Object.freeze(Object.fromEntries(SCHEMA_NAMES.map(name => [name, '1.0'])) as Record<SchemaName, string>);

/** Short directory names used by the shared fixtures (`fixtures/contracts/<valid|invalid>/<short>/`). */
// Freezing this fresh table has no external effects; a learner bundle that never imports fixture names can omit it.
export const SHORT_NAMES: Readonly<Record<SchemaName, string>> = /* @__PURE__ */ Object.freeze({
  [CONTRACTS.template]: 'template', [CONTRACTS.instance]: 'instance', [CONTRACTS.policy]: 'policy', [CONTRACTS.scientific]: 'scientific',
  [CONTRACTS.presentation]: 'presentation', [CONTRACTS.event]: 'event', [CONTRACTS.exposure]: 'exposure', [CONTRACTS.summary]: 'summary',
  [CONTRACTS.artifact]: 'artifact', [CONTRACTS.review]: 'review', [CONTRACTS.exposureReceipt]: 'exposure-receipt', [CONTRACTS.stageReceipt]: 'stage-receipt',
  [CONTRACTS.assistanceReceipt]: 'assistance-receipt', [CONTRACTS.capability]: 'capability', [MESSAGES.activityRequest]: 'activity-request', [MESSAGES.stageTransitionRequest]: 'stage-transition-request',
  [MESSAGES.exposureIntentRequest]: 'exposure-intent-request', [MESSAGES.displayAckRequest]: 'display-ack-request', [MESSAGES.assistanceRequest]: 'assistance-request',
  [MESSAGES.appendEventsRequest]: 'append-events-request', [MESSAGES.appendResult]: 'append-result', [MESSAGES.journalCursor]: 'journal-cursor',
  [MESSAGES.registerActivityRequest]: 'register-activity-request', [MESSAGES.saveArtifactRequest]: 'save-artifact-request',
  [MESSAGES.activityLookupRequest]: 'activity-lookup-request', [MESSAGES.hostAck]: 'host-ack', [MESSAGES.activityRecords]: 'activity-records',
  [MODEL_MANIFEST_CONTRACT]: 'model-manifest',
});

export const dataLimitsFor = (name: SchemaName): RecordDataLimits =>
  name === CONTRACTS.artifact || name === MESSAGES.saveArtifactRequest ? ARTIFACT_DATA_LIMITS : name === MODEL_MANIFEST_CONTRACT ? MANIFEST_DATA_LIMITS
    : name === CONTRACTS.event || name === MESSAGES.appendEventsRequest ? EVENT_DATA_LIMITS : RECORD_DATA_LIMITS;
export const schemaFileName = (name: SchemaName): string => `${name}.schema.json`;
