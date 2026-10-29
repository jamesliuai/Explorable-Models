/**
 * Policy-scoped Study Harness activity tools (report §5.3, §6.2, §7.3, §8.6, §15.1, §16; architecture D5 and D6).
 *
 * The host constructs one tool set per authorized context: the adapter and its installed catalogue, the host policy
 * source, and the host session, activity, policy revision, audience and operations it grants. An agent only sees the
 * descriptors and the results. Authority never comes from tool input: actor, origin, principal, session, activity and
 * review fields are rejected as unknown fields, and expected revisions are guards that detect stale state, never
 * permissions. Every executor checks the bound policy revision and the granted operations before it starts, after
 * every await and immediately before its commit. A step that already committed is reported as committed and never
 * undone; when the host changed the policy meanwhile the result says the authorization is no longer current.
 *
 * Disclosure: mutating tools return only learner-visible data (the learner projection), so the operation receipt cache
 * never holds more than the learner surface shows. Full scientific state comes only from `activity_inspect` with
 * `view: 'full'` and from `activity_sample`, under explicit tutor/teacher inspection policy, and is never cached. Every
 * diagnostic uses the fixed vocabulary below with paths that name only the caller's own input fields, so recovery
 * text and serialized errors cannot carry hidden content.
 */
import { canonicalJSON, sha256 } from '@explorable-models/core';
import { checkParameters, convert, jsonDataErrors, S, schemaErrors, type JsonSchema, type ModelManifest, type ModelRef, type PositionRequest } from '@explorable-models/core/model';
import {
  forbiddenTexCommand, isHostRefusalDiagnostic, policyDiagnostics, safePath, TOOL_OPERATIONS,
  type ActivityBinding, type ActivityCatalog, type ActivityTemplate, type AudienceState, type CatalogEntryStatus, type CommandOutcome, type Diagnostic,
  type DiagnosticCode, type HostActivityControl, type HostPolicy, type LearnerProjection, type LifecycleStatus, type PreparedActivity,
  type StudyHarnessAdapter, type TemplateRef, type ToolOperation,
} from '@explorable-models/activity';
import type { ToolDescriptor, VisualizationToolResult, VisualizationTools } from './tools.js';

// ---------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------
/** Who receives the tool output. Chosen by the host when it constructs the tool set; never by tool input. */
export type ActivityToolAudience = 'learner-visible' | 'tutor' | 'teacher';
export type ActivityToolName =
  | 'activity_discover' | 'activity_describe_template' | 'activity_prepare' | 'activity_inspect' | 'activity_propose_revision'
  | 'activity_request_reveal' | 'activity_operate' | 'activity_summarize' | 'activity_save' | 'activity_restore' | 'activity_close' | 'activity_sample';

/** Declared scope of a tool; the executor enforces exactly this (A55). */
export interface ActivityToolScope {
  /** Every listed operation must be granted by the host and allowed by the current policy. */
  operations: ToolOperation[];
  /** Additional operation per `action` (activity_operate) or proposal `kind` (activity_propose_revision). */
  variants?: Record<string, ToolOperation[]>;
  audiences: ActivityToolAudience[];
  /** Whether a bound activity must exist ('required'), must not exist ('absent'), or does not matter ('any'). */
  activity: 'required' | 'absent' | 'any';
  /** The host routes this operation on the tutor's behalf (reveal, save, close); the host still decides. */
  hostRoute: boolean;
  /** Mutating tools take an operationId and their results are kept as idempotent receipts. */
  mutates: boolean;
  /** Further policy conditions checked at run time. */
  conditions: string[];
}
export interface ActivityToolDescriptor extends ToolDescriptor { name: ActivityToolName; scope: ActivityToolScope }
export interface ActivityToolDiagnostic extends Diagnostic {
  recovery: string;
  /** Only for exploratory documents the agent itself wrote: the document validator's detail about that document. */
  detail?: string;
}
export interface ActivityResultScope {
  /** Technical checks that ran for this result; they are not scientific or subject review. */
  validation: { kind: 'technical'; checks: string[]; meaning: string };
  /** Catalogue lifecycle and review scope of the exact content, or null when the result covers several templates. */
  review: { lifecycle: LifecycleStatus | 'exploratory'; scope: string } | null;
  /** Activity status as the learner surface reports it, or null when no activity is bound. */
  activity: {
    activityId: string; stage: string; stageKind: string; context: 'instructional' | 'independent'; mode: 'approved' | 'exploratory';
    closed: boolean; persistence: string; ui: string;
  } | null;
}
export type ActivityToolResult = { ok: true; data: Record<string, unknown>; scope: ActivityResultScope } | { ok: false; diagnostics: ActivityToolDiagnostic[] };
export interface ActivityTools {
  readonly descriptors: readonly ActivityToolDescriptor[];
  execute(name: string, input: unknown, options?: { signal?: AbortSignal }): Promise<ActivityToolResult>;
}

/** Host-owned lifecycle hooks: preparation and restore bind new activities only through the host. */
export interface ActivityToolLifecycle {
  /** Host-owned request fields; the agent never chooses the activity, the session, the objectives or the host revision. */
  request(): { objectiveIds: string[]; hostSessionRevision: number } | Promise<{ objectiveIds: string[]; hostSessionRevision: number }>;
  /**
   * Receives every activity these tools prepared or restored. The host mounts the learner surface and returns the
   * tutor binding (`prepared.binding('tutor', …)`) and, if it routes reveal/save/close for the tutor, its host control.
   */
  bind(prepared: PreparedActivity): { binding: ActivityBinding; host?: HostActivityControl };
  /** Host-owned artifact lookup by ID for activity_restore; never a path or URL. Resolves null when unknown. */
  loadArtifact?(artifactId: string): unknown | Promise<unknown>;
}

/** Host-authorized context. Everything here is chosen by the host; tool input can never change it. */
export interface ActivityToolContext {
  adapter: StudyHarnessAdapter;
  /** The installed catalogue the adapter was constructed with. */
  catalog: ActivityCatalog;
  /** The host's current policy for the bound activity (for example `HostPort.getPolicy`). */
  policy(): HostPolicy | Promise<HostPolicy>;
  hostSessionId: string;
  activityId: string;
  /** Policy revision this executor was authorized under; any other current revision makes every call stale. */
  policyRevision: number;
  audience: ActivityToolAudience;
  /** Host grant; effective operations are this ∩ policy.allowedTools (∩ independentTask.permittedTools when independent). */
  allowedOperations: readonly ToolOperation[];
  /** Tutor binding of an activity the host already prepared (actor 'tutor'). */
  binding?: ActivityBinding;
  /** Host routing for reveal, save and close on the tutor's behalf; the host's HostPort still decides. */
  host?: HostActivityControl;
  lifecycle?: ActivityToolLifecycle;
  /** Existing document tools bound to a host-created exploratory session (used only for exploratory composition). */
  composition?: VisualizationTools;
}

// ---------------------------------------------------------------------------------------------
// Limits and vocabulary
// ---------------------------------------------------------------------------------------------
export const ACTIVITY_TOOL_LIMITS = Object.freeze({
  inputBytes: 1_048_576, outputBytes: 4_194_304, maxDepth: 32, maxNodes: 20_000, diagnostics: 20, receipts: 256, values: 64, samplePositions: 64, groups: 64, compositionEdits: 100,
});

/**
 * Field names that would claim authority or attribution. They appear in no input schema, so they are rejected like
 * any unknown field, with a repair hint that authority comes from the host binding.
 */
export const AUTHORITY_FIELDS: readonly string[] = Object.freeze([
  'actor', 'origin', 'principal', 'sessionId', 'hostSessionId', 'activityId', 'bindingId', 'policy', 'policyId', 'review', 'reviewer', 'reviewStatus',
  'reviewed', 'lifecycle', 'approved', 'approval', 'audience', 'authority', 'role', 'receipt', 'receiptId', 'grant', 'token', 'credential',
]);
const AUTHORITY = new Set(AUTHORITY_FIELDS);

type Text = { message: string; recovery: string };
const T = (message: string, recovery: string): Text => ({ message, recovery });
const REFRESH = 'Call activity_inspect for the current guards, then retry with a new operationId.';
/** Fixed agent-facing vocabulary for every diagnostic code. No message is ever built from content. */
export const ACTIVITY_TOOL_MESSAGES: Readonly<Record<DiagnosticCode, Text>> = Object.freeze({
  UNSUPPORTED_CAPABILITY: T('This capability is not available through these tools.', 'Decline the request and offer an alternative listed by activity_discover under unsupported.'),
  INVALID_REFERENCE: T('The referenced item is not installed or not available in this activity.', 'Use IDs returned by activity_discover, activity_describe_template or activity_inspect.'),
  INVALID_INPUT: T('The tool input is not valid.', 'Correct the input to match the descriptor inputSchema, then send it with a new operationId.'),
  SCHEMA: T('The tool input does not match the tool schema.', 'Correct the input to match the descriptor inputSchema, then send it with a new operationId.'),
  CONSTRAINT_VIOLATION: T('The combination of values is outside what the model allows.', 'Choose values that satisfy the model limits; nothing was changed.'),
  OUT_OF_DOMAIN: T('A value is outside its allowed range.', 'Choose a value within the min and max that activity_inspect reports; nothing was changed.'),
  UNDEFINED_CALCULATION: T('A value is mathematically undefined for these settings.', 'Report the value as undefined, never as zero, or choose other settings.'),
  NUMERICAL_LIMIT: T('A value is beyond what can be represented.', 'Report the numerical limit, or choose an earlier step or other settings.'),
  STALE_MODEL_REVISION: T('The scientific state changed before this request.', REFRESH),
  STALE_ACTIVITY_REVISION: T('The activity changed before this request.', REFRESH),
  STALE_POLICY_REVISION: T('The host policy changed; this tool executor is no longer authorized for it.', 'Stop and ask the host for a re-authorized tool set; editing guards does not restore authorization.'),
  STALE_HOST_REVISION: T('The host session changed before this request.', REFRESH),
  STALE_PRESENTATION_REVISION: T('The view changed before this request.', REFRESH),
  POLICY_DENIED: T('The host policy does not permit this request.', 'Do not retry it; continue with the operations activity_discover reports as available, or ask the host.'),
  POLICY_EXPIRED: T('The host policy for this activity has expired.', 'Ask the host for a current policy.'),
  CONTENT_REVOKED: T('This activity content has been revoked by the host.', 'Choose another approved activity from activity_discover.'),
  REVIEW_UNVERIFIED: T('The review status could not be verified.', 'Present the content with the lifecycle that activity_discover reports.'),
  PERSISTENCE_PENDING: T('Earlier steps are still being recorded by the host.', 'Wait, then retry with the same operationId.'),
  PERSISTENCE_FAILED: T('The host did not record this step, so nothing new was shown.', 'Retry later with the same operationId.'),
  PERSISTENCE_BACKPRESSURE: T('The host is behind on recording earlier events, so this step was not taken.', 'Wait, then retry with the same operationId.'),
  WORKER_ERROR: T('The calculation did not complete; the previous result is unchanged.', 'Retry with the same operationId.'),
  WORKER_TIMEOUT: T('The calculation took too long; the previous result is unchanged.', 'Retry with the same operationId.'),
  UNSUPPORTED_ARTIFACT: T('This saved activity cannot be reopened here.', 'Ask the host to open it as a read-only record.'),
  MIGRATION_REQUIRED: T('This saved activity needs a migration first.', 'Ask the host to migrate it.'),
  INTEGRITY_FAILURE: T('This saved activity failed its integrity check.', 'Ask the host for another copy.'),
  CANCELLED: T('The request was cancelled before it took effect.', 'Retry with the same operationId if the step is still wanted.'),
  DISPOSED: T('The activity is no longer open.', 'Ask the host to open or restore the activity.'),
  CONFLICT: T('The request conflicts with the current activity state.', REFRESH),
  OPERATION_CONFLICT: T('This operationId was already used with different arguments.', 'Use a new operationId for a different request; repeat identical arguments only to obtain the original result.'),
  PREVIEW_ACTIVE: T('A change is being previewed on the learner surface.', 'Wait until the learner applies or cancels it, then retry.'),
  NOT_READY: T('No ready activity is bound to this tool set.', 'Call activity_inspect; prepare or restore the activity when the host allows it.'),
  RESOURCE_LIMIT: T('The request exceeds a resource limit.', 'Reduce the request size and retry.'),
  RECEIPT_MISMATCH: T('The host authorization could not be confirmed, so nothing new was shown.', REFRESH),
  CAPTURE_REJECTED: T('Capture is not available through these tools.', 'Capture is a host operation governed by policy.export.capture.'),
  INDEPENDENT_CONTEXT: T('Independent work is active; this is not available now.', 'Use only the operations the independent task permits.'),
  NOT_FOUND: T('No available item has this ID.', 'Use IDs returned by these tools; guessed IDs are never resolved.'),
  DUPLICATE_ID: T('An ID is listed twice.', 'Remove the duplicate and retry with a new operationId.'),
  KIND_MISMATCH: T('An item cannot be used this way.', 'Use the items activity_describe_template lists for this purpose.'),
  UNIT_MISMATCH: T('The unit cannot be used for this value.', 'Use one of the display units activity_inspect lists.'),
  EQUATION_DISCLOSURE: T('That equation is not available now.', 'Continue with what activity_inspect shows.'),
  MISSING_EQUIVALENT: T('An accessible equivalent is missing.', 'Use the alternatives activity_describe_template lists.'),
  NEVER_VISIBLE: T('That item is never shown in this activity.', 'Use the items activity_describe_template lists.'),
  UNREFERENCED: T('That item is not used by this activity.', 'Use the items activity_describe_template lists.'),
});
/** Finer fixed messages for input and authorization failures. */
export const ACTIVITY_TOOL_REASONS = Object.freeze({
  'unknown-tool': T('No tool has this name.', 'Use a tool from the descriptors; activity_discover lists unsupported capabilities and alternatives.'),
  'unknown-field': T('The field is not accepted by this tool.', 'Remove the field; the descriptor inputSchema lists every accepted field.'),
  'authority-field': T('Tool input cannot claim an actor, origin, principal, session, activity, policy or review status.', 'Remove the field; authority and attribution come from the host binding of this tool set.'),
  required: T('A required field is missing.', 'Add the field described by the descriptor inputSchema.'),
  shape: T('A field has the wrong type, format or range.', 'Correct the field to match the descriptor inputSchema.'),
  'not-json': T('The input must be plain JSON data.', 'Send plain JSON objects, arrays, strings, finite numbers, booleans and null only.'),
  'reserved-key': T('The input uses a reserved object key.', 'Remove __proto__, prototype and constructor keys.'),
  accessor: T('The input contains accessor or hidden properties.', 'Send plain data properties only.'),
  cycle: T('The input contains a cyclic reference.', 'Send acyclic JSON data.'),
  size: T('The input exceeds the size, depth or entry limit.', 'Reduce the input to the limits in ACTIVITY_TOOL_LIMITS.'),
  'unsafe-text': T('Text contains markup, a resource URL or a disallowed TeX command.', 'Use plain text and bounded TeX without links, HTML, macros or resources.'),
  'not-granted': T('The host did not grant this operation to this tool set.', 'Do not retry it; activity_discover lists the operations available to you.'),
  'host-refused': T('The host refused this request, so nothing new was shown.', 'Do not retry it; continue with what is shown, or ask the host.'),
  'not-allowed': T('The current host policy does not allow this operation.', 'Do not retry it; activity_discover lists the operations available to you.'),
  audience: T('This tool is not available to the audience of this tool set.', 'Use activity_inspect with the learner view, or ask the host.'),
  'no-host-route': T('The host does not route this operation for the tutor.', 'Ask the host; this tool set cannot perform it.'),
  'no-lifecycle': T('The host has not enabled this lifecycle operation for this tool set.', 'Ask the host to prepare or restore the activity.'),
  'session-mismatch': T('The activity does not belong to the host session of this tool set.', 'Ask the host for a tool set bound to this activity.'),
  'activity-open': T('An activity is already open for this tool set.', 'Use activity_inspect and activity_operate on the open activity, or ask the host to close it first.'),
  'policy-invalid': T('The host policy is not valid, so nothing is permitted.', 'Ask the host to correct its policy.'),
  'policy-guard': T('The expected policy revision does not match the current one.', REFRESH),
  'policy-unavailable': T('The host policy could not be read.', 'Retry later.'),
  inspection: T('The host policy does not allow this inspection.', 'Use activity_inspect with the learner view.'),
  sampling: T('The host policy does not allow sampling for this audience.', 'Sampling is available only to authorized teacher or host contexts.'),
  personalisation: T('This parameter is not among the controls the host policy lets you personalise.', 'Use the controls activity_describe_template marks as personalisable.'),
  'not-interactive': T('This control is not interactive in the current stage.', 'Use a control activity_inspect reports as interactive, or propose a stage change.'),
  'exploratory-mode': T('Exploratory composition is not allowed by the host policy.', 'Use the approved activity and its listed scenarios, controls and stages.'),
  'template-identity': T('An exploratory document cannot use the identity of an installed template.', 'Give the exploratory document its own ID.'),
  'no-composition': T('The host has not provided an exploratory composition session.', 'Ask the host; this tool set cannot compose.'),
} satisfies Record<string, Text>);
export type ActivityToolReason = keyof typeof ACTIVITY_TOOL_REASONS;

/** Requests outside the installed capability contract, each with the alternative to offer instead. */
export const ACTIVITY_TOOL_UNSUPPORTED: readonly { capability: string; alternative: string }[] = Object.freeze([
  { capability: 'general-ode-solving', alternative: 'General numerical differential-equation solving is not installed. Offer an approved activity from this list, such as a discrete-iteration model, or describe the system without a computed visual.' },
  { capability: 'computer-algebra', alternative: 'Symbolic manipulation is not provided. Use the exact quantities and equations of an installed model.' },
  { capability: 'stochastic-simulation', alternative: 'Only deterministic installed models are available. Use an installed activity or describe the process without a computed visual.' },
  { capability: 'arbitrary-html-or-scripts', alternative: 'Activities are declarative. Use template views, tables, descriptions and accessible alternatives.' },
  { capability: 'remote-resources-or-plugins', alternative: 'Only installed catalogue entries are available; URLs, paths, modules and plugins are never accepted.' },
  { capability: 'capture', alternative: 'Capture is a host operation governed by policy.export.capture; these tools do not capture.' },
  { capability: 'approved-template-edits', alternative: 'An approved template is never edited under its identity. Propose parameters, scenarios or stages within the template, or use exploratory composition where the host policy allows it.' },
]);

const VALIDATION_MEANING = 'Technical checks only (schema, references, guards, host policy, model constraints and worker evaluation); they are not scientific or subject review.';
const NO_REVIEW = 'no independent subject review';
const EXPLORATORY_LABEL = 'exploratory, not reviewed';

// ---------------------------------------------------------------------------------------------
// Descriptors
// ---------------------------------------------------------------------------------------------
const operationId = S.id();
type GuardField = 'scientificVersion' | 'runId' | 'activityRevision' | 'policyRevision' | 'presentationRevision';
const revision: JsonSchema = { type: 'integer', minimum: 0 };
const GUARD_FIELDS: Record<GuardField, JsonSchema> = {
  scientificVersion: revision, runId: { type: ['string', 'null'], maxLength: 128 }, activityRevision: revision, policyRevision: revision, presentationRevision: revision,
};
/** Every guard field is accepted (copy activity_inspect `expected` whole); the listed ones are required. Each one given is checked. */
const guardSchema = (required: GuardField[]): JsonSchema => S.object(GUARD_FIELDS, required);
const GUARDS: Record<string, JsonSchema> = {
  scientificGuard: guardSchema(['scientificVersion', 'runId']), presentationGuard: guardSchema(['presentationRevision']), activityGuard: guardSchema(['activityRevision', 'policyRevision']),
};
const expected = (name: 'scientificGuard' | 'presentationGuard' | 'activityGuard'): JsonSchema => S.ref(name);
/** Root input schema; guard definitions are shared through `$defs` so the descriptors stay compact. */
const input = (schema: JsonSchema, defs: string[] = []): JsonSchema => defs.length ? { ...schema, $defs: Object.fromEntries(defs.map(name => [name, GUARDS[name]!])) } : schema;
const values = (description: string): JsonSchema => ({ ...S.map(S.number(), ACTIVITY_TOOL_LIMITS.values), description });
const vector = (length: number): JsonSchema => S.array(S.number(), length, length);
const camera = S.anyOf(
  S.object({ kind: S.constant('2d'), center: vector(2), zoom: S.positive(1e6) }),
  S.object({ kind: S.constant('3d'), projection: S.oneOfValues(['orthographic', 'perspective']), position: vector(3), target: vector(3), up: vector(3), preset: S.nullable(S.id()) }),
  S.null());
const index = S.object({ kind: S.constant('index'), index: S.integer(0, 1_000_000) }), time = S.object({ kind: S.constant('time'), time: S.number(0) });
const action = (name: string, fields: Record<string, JsonSchema>, guarded: 'scientificGuard' | 'presentationGuard'): JsonSchema => S.object({ action: S.constant(name), operationId, ...fields, expected: expected(guarded) });

const outputSchema = (data: string): Record<string, unknown> => ({ oneOf: [
  { type: 'object', required: ['ok', 'data', 'scope'], properties: { ok: { const: true }, data: { type: 'object', description: data }, scope: { type: 'object', description: 'validation (technical checks and their meaning), review (lifecycle and review scope, or null) and activity (learner-surface status, or null), reported separately.' } } },
  { type: 'object', required: ['ok', 'diagnostics'], properties: { ok: { const: false }, diagnostics: { type: 'array', maxItems: ACTIVITY_TOOL_LIMITS.diagnostics, items: { type: 'object', required: ['code', 'path', 'message', 'recovery'] } } } },
] });
const MUTATION_NOTE = ' operationId: unique per distinct request; repeat it only to retry the identical request.';
const ALL: ActivityToolAudience[] = ['learner-visible', 'tutor', 'teacher'];
const scope = (patch: Partial<ActivityToolScope> & Pick<ActivityToolScope, 'operations'>): ActivityToolScope =>
  ({ audiences: ALL, activity: 'required', hostRoute: false, mutates: false, conditions: [], ...patch });
const describe = (name: ActivityToolName, description: string, schema: JsonSchema, data: string, toolScope: ActivityToolScope): ActivityToolDescriptor =>
  ({ name, description: toolScope.mutates ? description + MUTATION_NOTE : description, inputSchema: schema as Record<string, unknown>, outputSchema: outputSchema(data), scope: toolScope });

const OPERATE_ACTIONS: Record<string, ToolOperation> = {
  'commit-parameters': 'operate.parameters', 'apply-scenario': 'operate.parameters', reset: 'operate.parameters',
  navigate: 'operate.navigation', step: 'operate.navigation', play: 'operate.playback', pause: 'operate.playback',
  'set-camera': 'operate.presentation', 'reset-view': 'operate.presentation', select: 'operate.presentation',
};

export const ACTIVITY_TOOL_DESCRIPTORS: readonly ActivityToolDescriptor[] = Object.freeze([
  describe('activity_discover', 'List the approved installed activity templates with exact versions, controls, stages, alternatives, limits, lifecycle and review scope, the operations available to you, and unsupported capabilities with the alternative to offer. Decline unsupported requests with that alternative.',
    S.object({}, []), 'audience, operations, mode, independent, templates[], unsupported[], limits, workflow',
    scope({ operations: ['discover'], activity: 'any' })),
  describe('activity_describe_template', 'Fetch on demand the detail of one discovered template version: stages, transitions, groups, personalisable controls, scenarios and alternatives. Teacher, or tutor with full inspection, also receives equations, assumptions and constraints.',
    S.object({ templateId: S.id(), version: S.version() }), 'template, model, stages[], transitions[], groups[], controls[], scenarios[], alternatives[], model detail',
    scope({ operations: ['discover'], activity: 'any' })),
  describe('activity_prepare', 'Prepare the activity the host bound to this tool set from an approved template, optionally personalising permitted control parameters (canonical units), a scenario or a starting stage. The host supplies the activity, session and objectives.',
    S.object({
      operationId, template: S.object({ templateId: S.id(), version: S.version() }), mode: S.oneOfValues(['approved', 'exploratory']),
      parameters: values('Initial values of personalisable controls in canonical model units.'), scenarioId: S.id(), stageId: S.id(),
    }, ['operationId', 'template']),
    'activityId, projection (learner view), expected guards, validation report',
    scope({ operations: ['prepare'], activity: 'absent', mutates: true, conditions: ['host lifecycle hook present', 'parameters ⊆ policy.permittedControls'] })),
  describe('activity_inspect', 'Read the activity. view "learner" (default) returns exactly the learner projection and the guards to copy into later calls. view "full" returns scientific state for teacher (policy.inspection.teacher) or tutor (policy.inspection.tutor = full) audiences only.',
    S.object({ view: S.oneOfValues(['learner', 'full']) }, []), 'view, projection or state, expected guards',
    scope({ operations: [], variants: { learner: ['inspect.learner'], 'full:tutor': ['inspect.tutor'], 'full:teacher': ['inspect.teacher'] }, conditions: ['full view: policy.inspection.teacher (teacher) or policy.inspection.tutor = full (tutor)'] })),
  describe('activity_propose_revision', 'Check a bounded change without applying it: a parameter set (display units) within interactive controls, a listed scenario, or a declared stage transition. Approved templates are never edited. Exploratory composition (policy mode exploratory with compose.exploratory) creates a separate candidate labelled "exploratory, not reviewed".',
    S.object({
      operationId,
      proposal: S.oneOf(
        S.object({ kind: S.constant('parameters'), values: values('Display-unit values of interactive controls.') }),
        S.object({ kind: S.constant('scenario'), scenarioId: S.id() }),
        S.object({ kind: S.constant('stage'), toStage: S.id() }),
        S.object({
          kind: S.constant('exploratory-composition'),
          document: { type: 'object', description: 'Schema 2.0 visualization document (visualization_discover publishes its schema).' },
          edits: S.array({ type: 'object' }, ACTIVITY_TOOL_LIMITS.compositionEdits, 1),
        }, ['kind'])),
    }), 'verdict, proposal, apply hint or exploratory candidate',
    scope({ operations: ['propose-revision'], variants: { 'exploratory-composition': ['compose.exploratory'] }, mutates: true, conditions: ['exploratory composition: policy.mode exploratory and policy.exploratory.allowed'] })),
  describe('activity_request_reveal', 'Ask the host to authorize showing content groups, or a declared stage transition that reveals them. The host decides and persists the exposure before anything is shown. Returns authorized, pending or denied.',
    input(S.object({
      operationId,
      target: S.oneOf(S.object({ kind: S.constant('groups'), groups: S.array(S.id(), ACTIVITY_TOOL_LIMITS.groups, 1) }), S.object({ kind: S.constant('stage'), toStage: S.id() })),
      expected: expected('activityGuard'),
    }), ['activityGuard']), 'status (authorized | pending | denied), display, labels, projection, expected guards',
    scope({ operations: ['request-reveal'], hostRoute: true, mutates: true })),
  describe('activity_operate', 'Apply a guarded operation as the tutor: commit parameters (display units), apply a scenario, reset, navigate or step, play or pause, set or reset a camera, or select. Parameter commits start a new run at index/time zero.',
    input(S.oneOf(
      action('commit-parameters', { values: values('Display-unit values of interactive controls.') }, 'scientificGuard'),
      action('apply-scenario', { scenarioId: S.id() }, 'scientificGuard'),
      action('reset', {}, 'scientificGuard'),
      action('navigate', { position: S.oneOf(index, time) }, 'scientificGuard'),
      action('step', { delta: S.oneOfValues([1, -1]) }, 'scientificGuard'),
      action('play', {}, 'scientificGuard'),
      action('pause', {}, 'scientificGuard'),
      action('set-camera', { viewId: S.id(), camera }, 'presentationGuard'),
      action('reset-view', { viewId: S.id() }, 'presentationGuard'),
      action('select', { target: S.nullable(S.id()) }, 'presentationGuard')), ['scientificGuard', 'presentationGuard']),
    'action, projection (learner view), expected guards, authorization',
    scope({ operations: [], variants: Object.fromEntries(Object.entries(OPERATE_ACTIONS).map(([name, op]) => [name, [op]])), mutates: true })),
  describe('activity_summarize', 'Deterministic interaction summary for the audience of this tool set through an explicit event cursor. It reports observations only and never infers understanding.',
    S.object({
      fromSequence: S.integer(0), toSequence: S.integer(0),
      limits: S.object({ committedConfigurations: S.integer(0, 20), previewObservations: S.integer(0, 20), bytes: S.integer(1, 32 * 1024) }, []),
    }, []), 'summary', scope({ operations: ['summarize'] })),
  describe('activity_save', 'Ask the host to store a backup or a learner snapshot. Returns a reference only; the artifact stays in host storage.',
    S.object({ operationId, kind: S.oneOfValues(['backup', 'learner-snapshot']) }), 'artifactId, kind, integrityDigest, cursor',
    scope({ operations: ['save'], hostRoute: true, mutates: true, conditions: ['policy.export.backup or policy.export.learnerSnapshot'] })),
  describe('activity_restore', 'Reopen the bound activity from a host-stored artifact by its ID (never a path or URL). It restores paused, under the current host policy, with conservative exposure records.',
    S.object({ operationId, artifactId: S.id() }), 'restored, notes, projection (learner view), expected guards',
    scope({ operations: ['restore'], activity: 'absent', mutates: true, conditions: ['host lifecycle hook with loadArtifact'] })),
  describe('activity_close', 'Ask the host to close the activity. Pending previews are recorded and playback stops.',
    input(S.object({ operationId, reason: S.oneOfValues(['completed', 'tutor-decision', 'learner-request']), expected: expected('activityGuard') }), ['activityGuard']), 'closed, projection (learner view)',
    scope({ operations: ['close'], hostRoute: true, mutates: true })),
  describe('activity_sample', 'Isolated sampling of the exact installed model for teacher contexts (policy.sampling.allowed and policy.inspection.teacher). It never changes the learner run and its results are never cached or shown to the learner.',
    S.object({ parameters: values('Canonical-unit parameter values.'), positions: S.array(S.oneOf(S.object({ kind: S.constant('static') }), index, time), ACTIVITY_TOOL_LIMITS.samplePositions, 1) }), 'frames, provenance',
    scope({ operations: ['sample'], audiences: ['teacher'], conditions: ['policy.sampling.allowed', 'policy.inspection.teacher'] })),
]);
const DESCRIPTORS = new Map(ACTIVITY_TOOL_DESCRIPTORS.map(descriptor => [descriptor.name as string, descriptor]));

// ---------------------------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------------------------
type Failure = { ok: false; diagnostics: ActivityToolDiagnostic[] };
const isFailure = (value: unknown): value is Failure => !!value && typeof value === 'object' && (value as { ok?: unknown }).ok === false;
function issue(code: DiagnosticCode, path = '$', reason?: ActivityToolReason, detail?: string): ActivityToolDiagnostic {
  const text = reason ? ACTIVITY_TOOL_REASONS[reason] : ACTIVITY_TOOL_MESSAGES[code] ?? ACTIVITY_TOOL_MESSAGES.INVALID_INPUT;
  return { code, path: safePath(path), message: text.message, recovery: text.recovery, ...(detail ? { detail: detail.slice(0, 400) } : {}) };
}
const fail = (code: DiagnosticCode, path?: string, reason?: ActivityToolReason): Failure => ({ ok: false, diagnostics: [issue(code, path, reason)] });
/** Re-expresses diagnostics from the adapter, bindings or the model in the fixed vocabulary; only input paths survive. */
function rephrase(items: readonly { code: string; path: string }[], paths: (path: string, code: string) => string = () => '$'): Failure {
  const out: ActivityToolDiagnostic[] = [];
  const seen = new Set<string>();
  for (const item of items.slice(0, ACTIVITY_TOOL_LIMITS.diagnostics)) {
    const code = (Object.hasOwn(ACTIVITY_TOOL_MESSAGES, item.code) ? item.code : 'INVALID_INPUT') as DiagnosticCode;
    const path = paths(item.path, code);
    if (seen.has(`${code}\u0000${path}`)) continue;
    seen.add(`${code}\u0000${path}`);
    out.push(issue(code, path));
  }
  return { ok: false, diagnostics: out.length ? out : [issue('INVALID_INPUT')] };
}
const GUARD_PATH: Partial<Record<DiagnosticCode, string>> = {
  STALE_MODEL_REVISION: '$.expected.scientificVersion', STALE_PRESENTATION_REVISION: '$.expected.presentationRevision', STALE_ACTIVITY_REVISION: '$.expected.activityRevision',
};
/** Maps binding/host paths (learner vocabulary) to the tool's own input paths. */
const bindingPath = (prefix: string) => (path: string, code: string): string => {
  const parameter = /^\$\.(?:displayValues|parameters)\.([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})$/.exec(path)?.[1];
  if (parameter) return `${prefix}.${parameter}`;
  if (path === '$.scenarioId' || path === '$.position' || path === '$.viewId' || path === '$.target' || path === '$.camera') return path;
  if (path === '$.groups') return '$.target.groups';
  if (path === '$.toStage') return '$.target.toStage';
  return GUARD_PATH[code as DiagnosticCode] ?? '$';
};

// ---------------------------------------------------------------------------------------------
// Input checks
// ---------------------------------------------------------------------------------------------
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const lastKey = (path: string): string => /\.([^.[\]]+)$/.exec(path)?.[1] ?? '';
/** JSON safety (without invoking getters) and size bounds, then a detached copy. */
function detachInput(raw: unknown): { ok: true; value: Record<string, unknown> } | Failure {
  const data = jsonDataErrors(raw, { maxBytes: ACTIVITY_TOOL_LIMITS.inputBytes, maxDepth: ACTIVITY_TOOL_LIMITS.maxDepth, maxNodes: ACTIVITY_TOOL_LIMITS.maxNodes });
  if (data.length) {
    const first = data[0]!;
    const reason: ActivityToolReason = first.code === 'RESOURCE_LIMIT' ? 'size' : first.message.startsWith('Reserved') ? 'reserved-key'
      : first.message.startsWith('Accessors') ? 'accessor' : first.message.startsWith('Cyclic') ? 'cycle' : 'not-json';
    return { ok: false, diagnostics: [issue(reason === 'size' ? 'RESOURCE_LIMIT' : 'INVALID_INPUT', first.path, reason)] };
  }
  if (!isRecord(raw)) return fail('INVALID_INPUT', '$', 'shape');
  return { ok: true, value: JSON.parse(JSON.stringify(raw)) as Record<string, unknown> };
}
/** Discriminated unions are resolved by their constant field first, so errors name the exact field to repair. */
function discriminated(schema: JsonSchema, value: unknown): { key: string; branch: JsonSchema | null } | null {
  if (!schema.oneOf || !isRecord(value)) return null;
  const key = ['action', 'kind'].find(name => schema.oneOf!.every(option => option.properties?.[name]?.const !== undefined));
  if (!key) return null;
  return { key, branch: schema.oneOf.find(option => option.properties![key]!.const === value[key]) ?? null };
}
type InputError = { code: string; path: string; message: string };
function inputErrors(value: unknown, schema: JsonSchema, path: string, root: JsonSchema): InputError[] {
  if (schema.$ref) {
    const target = schema.$ref.startsWith('#/$defs/') ? root.$defs?.[schema.$ref.slice(8)] : undefined;
    return target ? inputErrors(value, target, path, root) : [{ code: 'SCHEMA', path, message: 'Unresolved schema reference.' }];
  }
  const union = discriminated(schema, value);
  if (union) return union.branch ? inputErrors(value, union.branch, path, root) : [{ code: 'SCHEMA', path: `${path}.${union.key}`, message: 'Unsupported value.' }];
  if (schema.type === 'object' && schema.properties && isRecord(value)) {
    const errors: InputError[] = [];
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) errors.push({ code: 'SCHEMA', path: `${path}.${key}`, message: 'Required field is missing.' });
    for (const [key, item] of Object.entries(value)) {
      const child = Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined;
      if (child) errors.push(...inputErrors(item, child, `${path}.${key}`, root));
      else errors.push({ code: 'SCHEMA', path: `${path}.${key}`, message: 'Unknown field.' });
    }
    return errors;
  }
  return schemaErrors(value, schema, root, path, ACTIVITY_TOOL_LIMITS.diagnostics);
}
function checkInput(input: Record<string, unknown>, descriptor: ActivityToolDescriptor): Failure | null {
  const errors = inputErrors(input, descriptor.inputSchema as JsonSchema, '$', descriptor.inputSchema as JsonSchema);
  if (!errors.length) return null;
  return {
    ok: false,
    diagnostics: errors.slice(0, ACTIVITY_TOOL_LIMITS.diagnostics).map(item => item.message === 'Unknown field.'
      ? issue('INVALID_INPUT', item.path, AUTHORITY.has(lastKey(item.path)) ? 'authority-field' : 'unknown-field')
      : issue(item.code === 'RESOURCE_LIMIT' ? 'RESOURCE_LIMIT' : 'INVALID_INPUT', item.path, item.message === 'Required field is missing.' ? 'required' : 'shape')),
  };
}
const MARKUP = /<\s*[A-Za-z!/?]|\b(?:javascript|vbscript|data|file|blob)\s*:|\b(?:https?|ftp|wss?):\/\/|\burl\s*\(/i;
/**
 * First string in exploratory content that carries markup, a resource URL or a disallowed TeX command. The TeX list is
 * `FORBIDDEN_TEX_COMMANDS` from `@explorable-models/activity`, the same list the learner surface's math renderer refuses.
 */
function unsafeText(value: unknown, path: string): string | null {
  if (typeof value === 'string') return MARKUP.test(value) || forbiddenTexCommand(value) !== null ? path : null;
  if (Array.isArray(value)) { for (let index = 0; index < value.length; index++) { const found = unsafeText(value[index], `${path}[${index}]`); if (found) return found; } return null; }
  if (isRecord(value)) for (const [key, item] of Object.entries(value)) { const found = unsafeText(item, `${path}.${key}`); if (found) return found; }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Tool set
// ---------------------------------------------------------------------------------------------
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const AUDIENCES: readonly ActivityToolAudience[] = ['learner-visible', 'tutor', 'teacher'];
const TRANSIENT: ReadonlySet<string> = new Set(['PERSISTENCE_FAILED', 'PERSISTENCE_PENDING', 'PERSISTENCE_BACKPRESSURE', 'WORKER_ERROR', 'WORKER_TIMEOUT', 'RESOURCE_LIMIT', 'CANCELLED', 'NOT_READY', 'DISPOSED']);
const LIFECYCLE_ORDER: readonly LifecycleStatus[] = ['authored', 'validated', 'reference-checked', 'reviewed'];
const CLOSE_REASONS: Record<string, string> = { completed: 'The tutor closed the completed activity.', 'tutor-decision': 'The tutor closed the activity.', 'learner-request': 'The tutor closed the activity at the learner\'s request.' };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const sameTemplate = (a: TemplateRef, b: TemplateRef): boolean => a.templateId === b.templateId && a.version === b.version && a.digest === b.digest;
const sameModel = (a: ModelRef, b: ModelRef): boolean => a.modelId === b.modelId && a.version === b.version && a.digest === b.digest;
const expectedOf = (projection: LearnerProjection) => ({
  scientificVersion: projection.guards.expectedScientificVersion, runId: projection.guards.expectedRunId, activityRevision: projection.activityRevision,
  policyRevision: projection.policyRevision, presentationRevision: projection.presentationRevision,
});
/** The learner view returned by every tool: exactly the learner projection and the guards derived from it. */
const learnerView = (projection: LearnerProjection) => ({ projection: clone(projection), expected: expectedOf(projection) });

interface Bound { binding: ActivityBinding; host: HostActivityControl | null }
interface Authorized { policy: HostPolicy; state: AudienceState | null; independent: boolean }
interface Receipt { fingerprint: string; promise: Promise<ActivityToolResult>; settled: boolean }
type Run = (input: Record<string, unknown>, signal: AbortSignal | undefined) => Promise<ActivityToolResult>;

export function createActivityTools(context: ActivityToolContext): ActivityTools {
  const { adapter, catalog } = context;
  if (!adapter || typeof adapter.getState !== 'function' || !catalog || typeof catalog.getTemplate !== 'function' || typeof context.policy !== 'function')
    throw new TypeError('Activity tools need the adapter, its catalogue and a host policy source.');
  // Fail closed: without the adapter's host-time standing check no tool could refuse an expired policy (agent-tools §1).
  if (typeof adapter.policyStanding !== 'function')
    throw new TypeError('Activity tools need adapter.policyStanding (policy standing by the adapter\'s host clock); an adapter wrapper must forward it.');
  for (const [name, value] of [['hostSessionId', context.hostSessionId], ['activityId', context.activityId]] as const)
    if (typeof value !== 'string' || !ID.test(value)) throw new TypeError(`Activity tools need a bounded ${name}.`);
  if (!Number.isSafeInteger(context.policyRevision) || context.policyRevision < 0) throw new TypeError('Activity tools need the authorized policy revision.');
  if (!AUDIENCES.includes(context.audience)) throw new TypeError('Unknown activity tool audience.');
  if (!Array.isArray(context.allowedOperations) || context.allowedOperations.some(op => !TOOL_OPERATIONS.includes(op))) throw new TypeError('Allowed operations must be tool operations.');
  const grant: ReadonlySet<ToolOperation> = new Set(context.allowedOperations);
  const acceptBinding = (binding: ActivityBinding | undefined, host: HostActivityControl | undefined): Bound | null => {
    if (!binding) return null;
    if (binding.actor !== 'tutor' || binding.activityId !== context.activityId) throw new TypeError('Activity tools need a tutor binding of the bound activity.');
    if (host && host.activityId !== context.activityId) throw new TypeError('Host routing must belong to the bound activity.');
    return { binding, host: host ?? null };
  };
  let bound: Bound | null = acceptBinding(context.binding, context.host);
  const receipts = new Map<string, Receipt>();
  /** Reveal operation IDs whose host authorization is pending (the retry resends the same request). */
  const pendingReveals = new Set<string>();

  // ---- authorization ------------------------------------------------------------------------------------------
  const hostState = (): AudienceState | null => {
    const state = adapter.getState(context.activityId, 'host');
    return 'activityId' in state ? state : null;
  };
  /**
   * Synchronous checks against a policy just read: revision binding, standing, session, activity presence and grants.
   * Standing is judged by host time (activity-runtime §1): the adapter's host clock judges the policy, and the bound
   * activity's own standing (a revocation, or an expiry its acknowledgements showed) refuses every step as well.
   */
  function check(policy: HostPolicy, operations: readonly ToolOperation[], activity: ActivityToolScope['activity']): Authorized | Failure {
    if (policyDiagnostics(policy).length) return fail('POLICY_DENIED', '$', 'policy-invalid');
    if (policy.revision !== context.policyRevision) return fail('STALE_POLICY_REVISION');
    const standing = adapter.policyStanding(policy);
    if (standing) return fail(standing.code);
    const state = hostState();
    if (state) {
      if (state.instance.hostSessionId !== context.hostSessionId) return fail('POLICY_DENIED', '$', 'session-mismatch');
      if (state.guards.policyRevision !== context.policyRevision) return fail('STALE_POLICY_REVISION');
      if (state.standing) return fail(state.standing);
    }
    if (activity === 'required' && (!state || !bound)) return fail('NOT_READY');
    if (activity === 'required' && bound!.binding.getProjection().status.ui === 'disposed') return fail('DISPOSED');
    if (activity === 'absent' && state) return fail('CONFLICT', '$', 'activity-open');
    const independent = state?.instance.context.kind === 'independent';
    for (const op of operations) {
      if (!policy.allowedTools.includes(op)) return fail('POLICY_DENIED', '$', 'not-allowed');
      if (independent && !policy.independentTask.permittedTools.includes(op)) return fail('INDEPENDENT_CONTEXT');
    }
    return { policy, state, independent };
  }
  /** Full authorization: audience, host grant, then the current host policy (read fresh) and the bound activity. */
  async function authorize(descriptor: ActivityToolDescriptor, operations: readonly ToolOperation[], signal: AbortSignal | undefined): Promise<Authorized | Failure> {
    if (signal?.aborted) return fail('CANCELLED');
    if (!descriptor.scope.audiences.includes(context.audience)) return fail('POLICY_DENIED', '$', 'audience');
    for (const op of operations) if (!grant.has(op)) return fail('POLICY_DENIED', '$', 'not-granted');
    let policy: HostPolicy;
    try { policy = clone(await context.policy()); } catch { return fail('PERSISTENCE_FAILED', '$', 'policy-unavailable'); }
    if (signal?.aborted) return fail('CANCELLED');
    return check(policy, operations, descriptor.scope.activity);
  }
  /** After a commit: the step is never undone; the result says whether this executor is still authorized. */
  async function stillAuthorized(descriptor: ActivityToolDescriptor, operations: readonly ToolOperation[]): Promise<{ current: boolean; code?: DiagnosticCode }> {
    let policy: HostPolicy;
    try { policy = await context.policy(); } catch { return { current: false, code: 'PERSISTENCE_FAILED' }; }
    const verdict = check(policy, operations, descriptor.scope.activity === 'absent' ? 'any' : descriptor.scope.activity);
    return isFailure(verdict) ? { current: false, code: verdict.diagnostics[0]!.code } : { current: true };
  }
  const effectiveOperations = (auth: Authorized): ToolOperation[] => TOOL_OPERATIONS.filter(op => grant.has(op) && auth.policy.allowedTools.includes(op)
    && (!auth.independent || auth.policy.independentTask.permittedTools.includes(op)));
  const fullInspection = (policy: HostPolicy): boolean => context.audience === 'teacher' ? policy.inspection.teacher : context.audience === 'tutor' && policy.inspection.tutor === 'full';

  // ---- result scope -------------------------------------------------------------------------------------------
  function reviewOf(template: TemplateRef, model: ModelRef, mode: 'approved' | 'exploratory'): NonNullable<ActivityResultScope['review']> {
    if (mode === 'exploratory') return { lifecycle: 'exploratory', scope: EXPLORATORY_LABEL };
    return reviewFromStatus(catalog.status(template), catalog.status(model));
  }
  function reviewFromStatus(template: CatalogEntryStatus, model: CatalogEntryStatus): NonNullable<ActivityResultScope['review']> {
    if (template.revoked || model.revoked || template.lifecycle === 'revoked' || model.lifecycle === 'revoked') return { lifecycle: 'revoked', scope: 'revoked; not available' };
    const rank = (status: CatalogEntryStatus) => Math.max(0, LIFECYCLE_ORDER.indexOf(status.lifecycle));
    const lowest = LIFECYCLE_ORDER[Math.min(rank(template), rank(model))]!;
    const lifecycle: LifecycleStatus = template.lifecycle === 'deprecated' || model.lifecycle === 'deprecated' ? 'deprecated' : lowest;
    const reviews = [...template.reviews, ...model.reviews].filter(review => review.outcome !== 'rejected');
    return { lifecycle, scope: lowest === 'reviewed' && reviews.length ? reviews.map(review => review.scope).join(' | ').slice(0, 4000) : NO_REVIEW };
  }
  function resultScope(checks: string[], state: AudienceState | null): ActivityResultScope {
    const validation = { kind: 'technical' as const, checks, meaning: VALIDATION_MEANING };
    if (!state) return { validation, review: null, activity: null };
    const projection = state.projection;
    return {
      validation, review: reviewOf(state.instance.template, state.instance.model, state.instance.mode),
      activity: {
        activityId: state.activityId, stage: projection.stage.id, stageKind: projection.stage.kind, context: projection.context, mode: state.instance.mode,
        closed: state.instance.closed, persistence: state.persistence, ui: projection.status.ui,
      },
    };
  }
  const success = (data: Record<string, unknown>, checks: string[]): ActivityToolResult => ({ ok: true, data, scope: resultScope(checks, hostState()) });

  // ---- shared helpers -----------------------------------------------------------------------------------------
  /** Approved (or, where the policy allows exploratory activities, installed) non-revoked catalogue entries. */
  function available(policy: HostPolicy) {
    return catalog.listTemplates().filter(entry => !entry.status.revoked && entry.status.lifecycle !== 'revoked' && !catalog.status(entry.model).revoked).map(entry => ({
      entry, approved: policy.approved.some(item => sameTemplate(item.template, entry.template) && sameModel(item.model, entry.model)),
    })).filter(item => item.approved || policy.exploratory.allowed);
  }
  function templateOf(state: AudienceState): { template: ActivityTemplate; manifest: ModelManifest } | null {
    const template = catalog.getTemplate(state.instance.template);
    const manifest = catalog.getModel(state.instance.model);
    return template && manifest ? { template, manifest } : null;
  }
  const bindPrepared = (prepared: PreparedActivity): Bound => {
    const result = context.lifecycle!.bind(prepared);
    const next = acceptBinding(result?.binding, result?.host);
    if (!next) throw new TypeError('The host lifecycle must return a tutor binding.');
    bound = next;
    return next;
  };
  const outcomeOf = (outcome: CommandOutcome, prefix = '$.values'): Failure | LearnerProjection => outcome.ok ? outcome.projection : rephrase(outcome.diagnostics, bindingPath(prefix));
  /** Checks every expected guard the caller gave against the current projection; a matching guard grants nothing. */
  function guardsHold(input: Record<string, unknown>, projection: LearnerProjection): Failure | null {
    const guard = isRecord(input.expected) ? input.expected : {};
    const current = expectedOf(projection);
    const order: [GuardField, DiagnosticCode][] = [['policyRevision', 'STALE_POLICY_REVISION'], ['activityRevision', 'STALE_ACTIVITY_REVISION'],
      ['scientificVersion', 'STALE_MODEL_REVISION'], ['runId', 'STALE_MODEL_REVISION'], ['presentationRevision', 'STALE_PRESENTATION_REVISION']];
    for (const [field, code] of order) if (Object.hasOwn(guard, field) && guard[field] !== current[field]) return fail(code, `$.expected.${field}`, field === 'policyRevision' ? 'policy-guard' : undefined);
    return null;
  }

  // ---- executors ----------------------------------------------------------------------------------------------
  const runs: Record<ActivityToolName, Run> = {
    async activity_discover(_input, signal) {
      const descriptor = DESCRIPTORS.get('activity_discover')!;
      const auth = await authorize(descriptor, descriptor.scope.operations, signal);
      if (isFailure(auth)) return auth;
      const capabilities = adapter.getCapabilities();
      const entries = available(auth.policy);
      const templates = capabilities.templates.flatMap(item => {
        const match = entries.find(entry => sameTemplate(entry.entry.template, item.template) && sameModel(entry.entry.model, item.model));
        if (!match) return [];
        const permitted = new Set(auth.policy.permittedControls);
        return [{
          template: item.template, model: item.model, title: item.title, dimension: item.dimension, executionKind: item.executionKind, mode: item.mode,
          availability: match.approved ? 'approved' : 'exploratory-only',
          controls: item.controls.map(control => ({ ...control, personalisable: permitted.has(control.parameter) })),
          stages: item.stages, alternatives: item.alternatives, renderingRequirements: item.renderingRequirements, limits: item.limits,
          validation: { kind: 'technical', lifecycle: item.lifecycle, meaning: 'Installed catalogue checks (schema, semantics and, where recorded, reference suites); not subject review.' },
          review: reviewFromStatus(match.entry.status, catalog.status(match.entry.model)),
        }];
      });
      const unsupported = [...capabilities.unsupported, ...ACTIVITY_TOOL_UNSUPPORTED.filter(item => !capabilities.unsupported.some(other => other.capability === item.capability))];
      return success({
        audience: context.audience, operations: effectiveOperations(auth), mode: auth.policy.mode, independent: auth.independent,
        exploratoryComposition: auth.policy.mode === 'exploratory' && auth.policy.exploratory.allowed && !!context.composition,
        templates, unsupported, limits: { tools: ACTIVITY_TOOL_LIMITS, adapter: capabilities.limits },
        workflow: ['activity_discover', 'activity_describe_template (on demand)', 'activity_prepare', 'activity_inspect', 'activity_propose_revision', 'activity_operate',
          'activity_request_reveal (host decides)', 'activity_summarize', 'activity_save', 'activity_close'],
      }, ['host-policy', 'catalogue-status']);
    },

    async activity_describe_template(input, signal) {
      const descriptor = DESCRIPTORS.get('activity_describe_template')!;
      const auth = await authorize(descriptor, descriptor.scope.operations, signal);
      if (isFailure(auth)) return auth;
      const match = available(auth.policy).find(item => item.entry.template.templateId === input.templateId && item.entry.template.version === input.version);
      // A catalogue that loads content on demand (createLazyCatalog) fetches and verifies this template's content first.
      if (match && typeof catalog.load === 'function' && !catalog.getTemplate(match.entry.template)) await catalog.load({ templateId: match.entry.template.templateId, version: match.entry.template.version });
      const template = match && catalog.getTemplate(match.entry.template);
      const manifest = match && catalog.getModel(match.entry.model);
      if (!match || !template || !manifest) return fail('INVALID_REFERENCE', '$.templateId');
      const full = fullInspection(auth.policy);
      const permitted = new Set(auth.policy.permittedControls);
      const data: Record<string, unknown> = {
        template: match.entry.template, model: match.entry.model, title: template.title, dimension: template.dimension, availability: match.approved ? 'approved' : 'exploratory-only',
        initialStage: template.initialStage,
        stages: template.stages.map(stage => ({
          id: stage.id, kind: stage.kind, groups: Object.keys(stage.visible).sort(), controls: stage.controls, allowsPreview: stage.allowsPreview, allowsPlayback: stage.allowsPlayback,
          allowsNavigation: stage.allowsNavigation, ...(stage.response ? { response: { kind: stage.response.kind, taskFamily: stage.response.taskFamily, ...(full ? { prompt: stage.response.prompt } : {}) } } : {}),
          ...(full ? { instruction: stage.instruction } : {}),
        })),
        transitions: template.transitions.map(transition => ({ ...transition })),
        groups: template.groups.map(group => ({ id: group.id, kind: group.kind, label: group.label, solutionBearing: group.solutionBearing, ...(full ? { description: group.description, members: [...group.members] } : {}) })),
        controls: template.controls.map(control => {
          const definition = manifest.parameters[control.parameter]!;
          return {
            parameter: control.parameter, label: control.label, unit: definition.unit, min: definition.min, max: definition.max, default: definition.default, step: control.step,
            displayUnits: [...control.displayUnits], personalisable: permitted.has(control.parameter),
          };
        }),
        scenarios: template.scenarios.map(scenario => ({ id: scenario.id, label: scenario.label, parameters: { ...scenario.parameters } })),
        alternatives: template.alternatives.map(alternative => ({ id: alternative.id, kind: alternative.kind, label: alternative.label, covers: [...alternative.covers], equivalence: alternative.equivalence })),
        modelDetail: {
          executionKind: manifest.execution.kind, ...(manifest.execution.kind === 'kernel' ? { mode: manifest.execution.mode, ...(manifest.execution.mode === 'discrete' ? { maxIndex: manifest.execution.maxIndex } : {}) } : {}),
          limits: { ...manifest.limits },
        },
        detail: full ? 'full' : 'learner-safe',
      };
      if (full) Object.assign(data, {
        purpose: template.purpose,
        equations: template.equations.map(equation => ({ id: equation.id, group: equation.group, label: equation.label, tex: equation.tex, plain: equation.plain })),
        content: template.content.map(entry => ({ ...entry })),
        constraints: manifest.constraints.map(constraint => clone(constraint)),
        interpretation: clone(manifest.interpretation),
      });
      return success(data, ['host-policy', 'catalogue-status']);
    },

    async activity_prepare(input, signal) {
      const descriptor = DESCRIPTORS.get('activity_prepare')!;
      const auth = await authorize(descriptor, descriptor.scope.operations, signal);
      if (isFailure(auth)) return auth;
      if (!context.lifecycle) return fail('POLICY_DENIED', '$', 'no-lifecycle');
      const reference = input.template as { templateId: string; version: string };
      const match = available(auth.policy).find(item => item.entry.template.templateId === reference.templateId && item.entry.template.version === reference.version);
      if (!match) {
        const installed = catalog.listTemplates().find(item => item.template.templateId === reference.templateId && item.template.version === reference.version);
        return installed?.status.revoked ? fail('CONTENT_REVOKED', '$.template') : fail('INVALID_REFERENCE', '$.template');
      }
      const parameters = isRecord(input.parameters) ? input.parameters as Record<string, number> : undefined;
      for (const key of Object.keys(parameters ?? {})) if (!auth.policy.permittedControls.includes(key)) return fail('POLICY_DENIED', `$.parameters.${key}`, 'personalisation');
      let owned: { objectiveIds: string[]; hostSessionRevision: number };
      try { owned = await context.lifecycle.request(); } catch { return fail('PERSISTENCE_FAILED'); }
      const request = {
        activityId: context.activityId, objectiveIds: [...(owned?.objectiveIds ?? [])], hostSessionId: context.hostSessionId, hostSessionRevision: owned?.hostSessionRevision,
        template: { templateId: reference.templateId, version: reference.version }, mode: (input.mode as 'approved' | 'exploratory' | undefined) ?? 'approved',
        ...(parameters ? { parameters } : {}), ...(typeof input.scenarioId === 'string' ? { scenarioId: input.scenarioId } : {}), ...(typeof input.stageId === 'string' ? { stageId: input.stageId } : {}),
      };
      const recheck = await authorize(descriptor, descriptor.scope.operations, signal);
      if (isFailure(recheck)) return recheck;
      const report = await adapter.validate(request, signal);
      const paths = (path: string): string => /^\$\.parameters\.[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(path) || ['$.scenarioId', '$.stageId', '$.template', '$.mode'].includes(path) ? path : '$';
      if (!report.ok) return rephrase(report.diagnostics, paths);
      // The last check before the commit; prepare is the commit.
      const final = await authorize(descriptor, descriptor.scope.operations, signal);
      if (isFailure(final)) return final;
      const prepared = await adapter.prepare(request, { operationId: input.operationId as string }, signal);
      if (!prepared.ok) return rephrase(prepared.diagnostics, paths);
      const next = bindPrepared(prepared.prepared);
      const authorization = await stillAuthorized(descriptor, descriptor.scope.operations);
      return success({
        activityId: context.activityId, ...learnerView(next.binding.getProjection()), authorization,
        validation: { defaultsEvaluated: report.defaults !== undefined, resourceEstimate: report.resourceEstimate ?? null },
      }, ['schema', 'references', 'host-policy', 'parameter-constraints', 'worker-evaluation-of-defaults']);
    },

    async activity_inspect(input, signal) {
      const descriptor = DESCRIPTORS.get('activity_inspect')!;
      const view = input.view === 'full' ? 'full' : 'learner';
      const operations = descriptor.scope.variants![view === 'learner' ? 'learner' : `full:${context.audience === 'teacher' ? 'teacher' : 'tutor'}`]!;
      if (view === 'full' && context.audience === 'learner-visible') return fail('POLICY_DENIED', '$.view', 'audience');
      const auth = await authorize(descriptor, operations, signal);
      if (isFailure(auth)) return auth;
      if (view === 'learner') return success({ view, ...learnerView(bound!.binding.getProjection()) }, ['host-policy']);
      if (!fullInspection(auth.policy)) return fail('POLICY_DENIED', '$.view', 'inspection');
      const state = adapter.getState(context.activityId, context.audience === 'teacher' ? 'teacher' : 'tutor');
      if (!('activityId' in state)) return rephrase(state.diagnostics);
      return success({ view, audience: context.audience, state: clone(state), expected: expectedOf(state.projection) }, ['host-policy', 'inspection-policy']);
    },

    async activity_propose_revision(input, signal) {
      const descriptor = DESCRIPTORS.get('activity_propose_revision')!;
      const proposal = input.proposal as Record<string, unknown>;
      const kind = proposal.kind as string;
      const operations: ToolOperation[] = [...descriptor.scope.operations, ...(descriptor.scope.variants?.[kind] ?? [])];
      if (kind === 'exploratory-composition') return compose(input, proposal, operations, signal);
      const auth = await authorize(descriptor, operations, signal);
      if (isFailure(auth)) return auth;
      const projection = bound!.binding.getProjection();
      const resolved = templateOf(auth.state!);
      if (!resolved) return fail('INVALID_REFERENCE');
      const { template, manifest } = resolved;
      const checks = ['schema', 'host-policy', 'template-declarations'];
      if (kind === 'parameters') {
        const entries = Object.entries(proposal.values as Record<string, number>);
        if (!entries.length) return fail('INVALID_INPUT', '$.proposal.values', 'required');
        const canonical: Record<string, number> = {};
        for (const [parameter, value] of entries) {
          const control = projection.controls.find(item => item.parameter === parameter);
          const definition = manifest.parameters[parameter];
          if (!control || !definition) return fail('NOT_FOUND', `$.proposal.values.${parameter}`);
          if (control.mode !== 'interactive') return fail('POLICY_DENIED', `$.proposal.values.${parameter}`, 'not-interactive');
          if (value < control.min || value > control.max) return fail('OUT_OF_DOMAIN', `$.proposal.values.${parameter}`);
          try { canonical[parameter] = convert(value, control.displayUnit, definition.unit); } catch { return fail('UNIT_MISMATCH', `$.proposal.values.${parameter}`); }
        }
        const committed = auth.state!.scientific?.params ?? {};
        const problems = checkParameters(manifest, { ...committed, ...canonical });
        if (problems.length) return rephrase(problems, path => bindingPath('$.proposal.values')(path, ''));
        return success({
          verdict: 'acceptable', proposal: { kind, values: { ...(proposal.values as Record<string, number>) } },
          apply: { tool: 'activity_operate', input: { action: 'commit-parameters', values: { ...(proposal.values as Record<string, number>) }, expected: { scientificVersion: projection.guards.expectedScientificVersion, runId: projection.guards.expectedRunId } } },
          note: 'Nothing changed. Apply it with a new operationId; the commit starts a new run at index/time zero.',
        }, [...checks, 'parameter-constraints']);
      }
      if (kind === 'scenario') {
        const scenario = template.scenarios.find(item => item.id === proposal.scenarioId);
        if (!scenario || !projection.scenarios.some(item => item.scenarioId === scenario.id)) return fail('NOT_FOUND', '$.proposal.scenarioId');
        const stage = template.stages.find(item => item.id === projection.stage.id);
        if (stage?.visible[scenario.group] !== 'interactive') return fail('POLICY_DENIED', '$.proposal.scenarioId', 'not-interactive');
        return success({
          verdict: 'acceptable', proposal: { kind, scenarioId: scenario.id },
          apply: { tool: 'activity_operate', input: { action: 'apply-scenario', scenarioId: scenario.id, expected: { scientificVersion: projection.guards.expectedScientificVersion, runId: projection.guards.expectedRunId } } },
          note: 'Nothing changed. Applying a scenario starts a new run at index/time zero.',
        }, checks);
      }
      const transition = template.transitions.find(item => item.from === projection.stage.id && item.to === proposal.toStage);
      if (!transition) return fail('INVALID_REFERENCE', '$.proposal.toStage');
      const routed = !!bound?.host && grant.has('request-reveal') && auth.policy.allowedTools.includes('request-reveal');
      return success({
        verdict: 'host-decision-required', proposal: { kind, toStage: transition.to }, transition: { id: transition.id, label: transition.label },
        apply: routed
          ? { tool: 'activity_request_reveal', input: { target: { kind: 'stage', toStage: transition.to }, expected: { activityRevision: projection.activityRevision, policyRevision: projection.policyRevision } } }
          : { tool: null, note: 'The host decides stage changes; this tool set cannot request it.' },
        note: 'Nothing changed. Stage changes are authorized and persisted by the host before anything new is shown.',
      }, checks);
    },

    async activity_request_reveal(input, signal) {
      const descriptor = DESCRIPTORS.get('activity_request_reveal')!;
      const auth = await authorize(descriptor, descriptor.scope.operations, signal);
      if (isFailure(auth)) return auth;
      const route = bound!.host;
      if (!route) return fail('POLICY_DENIED', '$', 'no-host-route');
      const stale = guardsHold(input, bound!.binding.getProjection());
      if (stale) return stale;
      const guard = input.expected as { activityRevision: number; policyRevision: number };
      const operation = input.operationId as string;
      const target = input.target as { kind: 'groups'; groups: string[] } | { kind: 'stage'; toStage: string };
      const before = bound!.binding.getProjection();
      let outcome: CommandOutcome;
      if (pendingReveals.has(operation) && before.pendingReveal?.state === 'failed') {
        // Same request again after the host did not record it: resend the pending authorization unchanged.
        outcome = await bound!.binding.retryPersistence({ operationId: `tool-retry.${crypto.randomUUID()}` });
      } else {
        const common = { operationId: operation, expectedActivityRevision: guard.activityRevision, expectedPolicyRevision: guard.policyRevision, actor: 'tutor' as const };
        outcome = target.kind === 'groups' ? await route.requestReveal({ ...common, groups: target.groups }) : await route.requestStageTransition({ ...common, toStage: target.toStage });
      }
      const authorization = await stillAuthorized(descriptor, descriptor.scope.operations);
      const projection = bound!.binding.getProjection();
      if (outcome.ok) {
        pendingReveals.delete(operation);
        return success({
          status: 'authorized', display: projection.pendingReveal?.state === 'awaiting-display' ? 'awaiting-display' : 'no-pending-display', labels: projection.pendingReveal?.labels ?? [],
          note: 'Authorization is not evidence that the learner saw the content; the learner surface acknowledges display.', ...learnerView(projection), authorization,
        }, ['schema', 'guards', 'host-policy', 'host-receipt']);
      }
      const codes = outcome.diagnostics.map(item => item.code);
      if (!authorization.current) return { ok: true, data: { status: 'denied', diagnostics: [issue(authorization.code ?? 'STALE_POLICY_REVISION')], ...learnerView(projection), authorization }, scope: resultScope(['host-policy'], hostState()) };
      // A host refusal (HostPort convention, activity-runtime §10) is the host's decision: denied, never retried.
      const refusals = outcome.diagnostics.filter(isHostRefusalDiagnostic);
      if (refusals.length) {
        pendingReveals.delete(operation);
        return { ok: true, data: { status: 'denied', diagnostics: refusals.map(item => issue(item.code, '$', 'host-refused')), ...learnerView(projection), authorization }, scope: resultScope(['schema', 'guards', 'host-policy'], hostState()) };
      }
      if (codes.some(code => code === 'PERSISTENCE_FAILED' || code === 'PERSISTENCE_PENDING' || code === 'PERSISTENCE_BACKPRESSURE')) {
        if (projection.pendingReveal?.state === 'failed') pendingReveals.add(operation);
        return { ok: true, data: { status: 'pending', diagnostics: rephrase(outcome.diagnostics).diagnostics, ...learnerView(projection), authorization }, scope: resultScope(['schema', 'guards', 'host-policy'], hostState()) };
      }
      if (codes.some(code => ['POLICY_DENIED', 'POLICY_EXPIRED', 'CONTENT_REVOKED', 'RECEIPT_MISMATCH', 'INDEPENDENT_CONTEXT', 'STALE_POLICY_REVISION'].includes(code)))
        return { ok: true, data: { status: 'denied', diagnostics: rephrase(outcome.diagnostics, bindingPath('$')).diagnostics, ...learnerView(projection), authorization }, scope: resultScope(['schema', 'guards', 'host-policy'], hostState()) };
      return rephrase(outcome.diagnostics, bindingPath('$'));
    },

    async activity_operate(input, signal) {
      const descriptor = DESCRIPTORS.get('activity_operate')!;
      const name = input.action as string;
      const operations = descriptor.scope.variants![name]!;
      const auth = await authorize(descriptor, operations, signal);
      if (isFailure(auth)) return auth;
      const binding = bound!.binding;
      const stale = guardsHold(input, binding.getProjection());
      if (stale) return stale;
      const guard = input.expected as { scientificVersion: number; runId: string | null; presentationRevision: number };
      const operation = input.operationId as string;
      const scientific = { operationId: operation, expectedScientificVersion: guard.scientificVersion, expectedRunId: guard.runId };
      const presentation = { operationId: operation, expectedPresentationRevision: guard.presentationRevision };
      // Commit point: no await separates the last authorization from the binding call, and a started command is never abandoned.
      let outcome: CommandOutcome;
      switch (name) {
        case 'commit-parameters': outcome = await binding.commitParameters({ ...scientific, displayValues: input.values as Record<string, number> }); break;
        case 'apply-scenario': outcome = await binding.applyScenario({ ...scientific, scenarioId: input.scenarioId as string }); break;
        case 'reset': outcome = await binding.resetExperiment(scientific); break;
        case 'navigate': outcome = await binding.navigate({ ...scientific, position: input.position as PositionRequest }); break;
        case 'step': outcome = await binding.step({ ...scientific, delta: input.delta as 1 | -1 }); break;
        case 'play': outcome = binding.play(scientific); break;
        case 'pause': outcome = binding.pause(scientific); break;
        case 'set-camera': outcome = binding.setCamera({ ...presentation, viewId: input.viewId as string, camera: input.camera as never }); break;
        case 'reset-view': outcome = binding.resetView({ ...presentation, viewId: input.viewId as string }); break;
        default: outcome = binding.select({ ...presentation, target: input.target as string | null });
      }
      const result = outcomeOf(outcome);
      if (isFailure(result)) return result;
      const authorization = await stillAuthorized(descriptor, operations);
      return success({ action: name, ...learnerView(result), authorization }, ['schema', 'guards', 'host-policy', ...(OPERATE_ACTIONS[name] === 'operate.parameters' ? ['parameter-constraints'] : [])]);
    },

    async activity_summarize(input, signal) {
      const descriptor = DESCRIPTORS.get('activity_summarize')!;
      const auth = await authorize(descriptor, descriptor.scope.operations, signal);
      if (isFailure(auth)) return auth;
      const audience = context.audience === 'learner-visible' ? 'learner' : context.audience;
      if (audience === 'teacher' && !auth.policy.inspection.teacher) return fail('POLICY_DENIED', '$', 'inspection');
      const summary = adapter.summarizeInteraction(context.activityId, {
        audience, ...(input.fromSequence !== undefined ? { fromSequence: input.fromSequence as number } : {}), ...(input.toSequence !== undefined ? { toSequence: input.toSequence as number } : {}),
        ...(isRecord(input.limits) ? { limits: input.limits as Record<string, number> } : {}),
      });
      if ('ok' in summary && summary.ok === false) return rephrase(summary.diagnostics, path => ['$.fromSequence', '$.toSequence'].includes(path) || /^\$\.limits\.[a-zA-Z]+$/.test(path) ? path : '$');
      return success({ audience, summary: clone(summary) }, ['host-policy', 'journal-cursor']);
    },

    async activity_save(input, signal) {
      const descriptor = DESCRIPTORS.get('activity_save')!;
      const auth = await authorize(descriptor, descriptor.scope.operations, signal);
      if (isFailure(auth)) return auth;
      const route = bound!.host;
      if (!route) return fail('POLICY_DENIED', '$', 'no-host-route');
      const saved = await route.save({ operationId: input.operationId as string, kind: input.kind as 'backup' | 'learner-snapshot' });
      if (!saved.ok) return rephrase(saved.diagnostics, path => path === '$.kind' ? path : '$');
      const authorization = await stillAuthorized(descriptor, descriptor.scope.operations);
      const artifact = saved.artifact;
      return success({
        artifactId: artifact.artifactId, kind: artifact.kind, integrityDigest: artifact.integrity.digest, cursor: artifact.journal.cursor.lastSequence, storedBy: 'host',
        restorable: artifact.kind === 'backup', authorization,
      }, ['host-policy', 'export-policy', 'artifact-integrity']);
    },

    async activity_restore(input, signal) {
      const descriptor = DESCRIPTORS.get('activity_restore')!;
      const auth = await authorize(descriptor, descriptor.scope.operations, signal);
      if (isFailure(auth)) return auth;
      const lifecycle = context.lifecycle;
      if (!lifecycle?.loadArtifact) return fail('POLICY_DENIED', '$', 'no-lifecycle');
      let artifact: unknown, owned: { objectiveIds: string[]; hostSessionRevision: number };
      try { artifact = await lifecycle.loadArtifact(input.artifactId as string); owned = await lifecycle.request(); } catch { return fail('PERSISTENCE_FAILED'); }
      const instance = isRecord(artifact) && isRecord(artifact.instance) ? artifact.instance : null;
      // Another activity's or session's artifact is indistinguishable from an unknown ID.
      if (!instance || instance.activityId !== context.activityId || instance.hostSessionId !== context.hostSessionId) return fail('NOT_FOUND', '$.artifactId');
      const final = await authorize(descriptor, descriptor.scope.operations, signal);
      if (isFailure(final)) return final;
      const restored = await adapter.restore(artifact, { operationId: input.operationId as string, hostSessionRevision: owned?.hostSessionRevision }, signal);
      if (!restored.ok) return rephrase(restored.diagnostics);
      const next = bindPrepared(restored.prepared);
      const authorization = await stillAuthorized(descriptor, descriptor.scope.operations);
      return success({ restored: restored.report.restored, notes: restored.report.notes.slice(0, 16), ...learnerView(next.binding.getProjection()), authorization },
        ['artifact-integrity', 'catalogue-status', 'host-policy', 'worker-re-evaluation']);
    },

    async activity_close(input, signal) {
      const descriptor = DESCRIPTORS.get('activity_close')!;
      const auth = await authorize(descriptor, descriptor.scope.operations, signal);
      if (isFailure(auth)) return auth;
      const route = bound!.host;
      if (!route) return fail('POLICY_DENIED', '$', 'no-host-route');
      const stale = guardsHold(input, bound!.binding.getProjection());
      if (stale) return stale;
      const outcome = await route.close({ operationId: input.operationId as string, reason: CLOSE_REASONS[input.reason as string]! });
      const result = outcomeOf(outcome);
      if (isFailure(result)) return result;
      const authorization = await stillAuthorized(descriptor, descriptor.scope.operations);
      return success({ closed: true, ...learnerView(result), authorization }, ['guards', 'host-policy']);
    },

    async activity_sample(input, signal) {
      const descriptor = DESCRIPTORS.get('activity_sample')!;
      const auth = await authorize(descriptor, descriptor.scope.operations, signal);
      if (isFailure(auth)) return auth;
      if (!auth.policy.sampling.allowed || !auth.policy.inspection.teacher) return fail('POLICY_DENIED', '$', 'sampling');
      const result = await adapter.sample({ activityId: context.activityId, parameters: input.parameters as Record<string, number>, positions: input.positions as PositionRequest[], audience: 'teacher' }, signal);
      if (!result.ok) return rephrase(result.diagnostics, path => /^\$\.(parameters\.[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}|positions(\[\d+\])?)$/.test(path) ? path : '$');
      const after = await authorize(descriptor, descriptor.scope.operations, signal);
      if (isFailure(after)) return after;
      return success({ frames: clone(result.frames), provenance: clone(result.provenance), note: 'Isolated sample: the learner run, preview, selection, playback and journal are unchanged.' },
        ['schema', 'host-policy', 'sampling-policy', 'parameter-constraints', 'worker-evaluation']);
    },
  };

  /** Exploratory composition: a separate document candidate, never the approved template under its identity. */
  async function compose(input: Record<string, unknown>, proposal: Record<string, unknown>, operations: ToolOperation[], signal: AbortSignal | undefined): Promise<ActivityToolResult> {
    const descriptor = DESCRIPTORS.get('activity_propose_revision')!;
    const auth = await authorize(descriptor, operations, signal);
    if (isFailure(auth)) return auth;
    if (auth.policy.mode !== 'exploratory' || !auth.policy.exploratory.allowed) return fail('POLICY_DENIED', '$.proposal.kind', 'exploratory-mode');
    const tools = context.composition;
    if (!tools) return fail('POLICY_DENIED', '$.proposal.kind', 'no-composition');
    const hasDocument = isRecord(proposal.document), hasEdits = Array.isArray(proposal.edits);
    if (hasDocument === hasEdits) return fail('INVALID_INPUT', '$.proposal', 'shape');
    const unsafe = unsafeText(hasDocument ? proposal.document : proposal.edits, hasDocument ? '$.proposal.document' : '$.proposal.edits');
    if (unsafe) return fail('INVALID_INPUT', unsafe, 'unsafe-text');
    if (hasDocument && catalog.listTemplates().some(entry => entry.template.templateId === (proposal.document as Record<string, unknown>).id)) return fail('CONFLICT', '$.proposal.document.id', 'template-identity');
    const inspected = await tools.execute('visualization_inspect', {}, signal ? { signal } : {});
    const again = await authorize(descriptor, operations, signal);
    if (isFailure(again)) return again;
    if (!inspected.ok) return documentFailure(inspected, '$.proposal');
    const state = inspected.data as { sessionId: string; version: number; run?: { id: string } | null };
    const guard = { sessionId: state.sessionId, expectedVersion: state.version, ...(state.run ? { expectedRunId: state.run.id } : {}), operationId: input.operationId as string, origin: 'agent' };
    const created = hasDocument
      ? await tools.execute('visualization_create', { document: proposal.document, guard }, signal ? { signal } : {})
      : await tools.execute('visualization_revise', { edits: proposal.edits, guard }, signal ? { signal } : {});
    if (!created.ok) return documentFailure(created, hasDocument ? '$.proposal.document' : '$.proposal.edits');
    const authorization = await stillAuthorized(descriptor, operations);
    const candidate = created.data as { candidateId: string; identity: unknown; validation: unknown };
    return {
      ok: true,
      data: {
        verdict: 'exploratory-candidate', label: EXPLORATORY_LABEL, candidateId: candidate.candidateId, identity: clone(candidate.identity), documentValidation: clone(candidate.validation),
        template: null, note: 'A separate exploratory document candidate. It is not shown until the host commits it, and it never carries an approved template identity or review status.',
        authorization,
      },
      scope: { validation: { kind: 'technical', checks: ['schema', 'references', 'computation', 'unsafe-text'], meaning: VALIDATION_MEANING }, review: { lifecycle: 'exploratory', scope: EXPLORATORY_LABEL }, activity: resultScope([], hostState()).activity },
    };
  }
  /** Document-tool failures concern the agent's own exploratory document; the validator detail is kept for repair. */
  function documentFailure(result: VisualizationToolResult, prefix: string): Failure {
    if (result.ok) return fail('INVALID_INPUT');
    return {
      ok: false,
      diagnostics: result.diagnostics.slice(0, ACTIVITY_TOOL_LIMITS.diagnostics).map(item => {
        const code: DiagnosticCode = item.code === 'CANCELLED' ? 'CANCELLED' : item.code === 'RESOURCE_LIMIT' ? 'RESOURCE_LIMIT' : item.code === 'STALE_VERSION' || item.code === 'CONFLICT' ? 'CONFLICT' : 'INVALID_INPUT';
        const path = typeof item.path === 'string' && item.path.startsWith('$.document') ? `${prefix}${item.path.slice('$.document'.length)}` : typeof item.path === 'string' && item.path.startsWith('$.edits') ? `${prefix}${item.path.slice('$.edits'.length)}` : prefix;
        return issue(code, path, undefined, typeof item.message === 'string' ? item.message : undefined);
      }),
    };
  }

  /** Validates, deduplicates mutating calls by operationId and fingerprint, and runs the executor. */
  function execute(name: string, raw: unknown, options: { signal?: AbortSignal } = {}): Promise<ActivityToolResult> {
    const descriptor = typeof name === 'string' ? DESCRIPTORS.get(name) : undefined;
    if (!descriptor) return Promise.resolve(fail('UNSUPPORTED_CAPABILITY', '$.name', 'unknown-tool'));
    const detached = detachInput(raw);
    if (!detached.ok) return Promise.resolve(detached);
    const input = detached.value;
    const invalid = checkInput(input, descriptor);
    if (invalid) return Promise.resolve(invalid);
    const run = (): Promise<ActivityToolResult> => runs[descriptor.name](input, options.signal).catch(() => fail('WORKER_ERROR'));
    // Read-only results are bounded here; mutating results carry only the adapter-bounded learner projection.
    if (!descriptor.scope.mutates) return run().then(result => result.ok && new TextEncoder().encode(JSON.stringify(result)).length > ACTIVITY_TOOL_LIMITS.outputBytes ? fail('RESOURCE_LIMIT') : result);
    const operation = input.operationId as string;
    const fingerprint = sha256(canonicalJSON({ name, input }));
    const previous = receipts.get(operation);
    if (previous) return previous.fingerprint === fingerprint ? previous.promise : Promise.resolve(fail('OPERATION_CONFLICT', '$.operationId'));
    if (receipts.size >= ACTIVITY_TOOL_LIMITS.receipts) {
      const oldest = [...receipts].find(([, receipt]) => receipt.settled);
      if (!oldest) return Promise.resolve(fail('RESOURCE_LIMIT'));
      receipts.delete(oldest[0]);
    }
    const receipt = { fingerprint, settled: false } as Receipt;
    receipt.promise = run().then(result => {
      receipt.settled = true;
      // Transient outcomes are forgotten so the identical request can be retried; everything else is the receipt.
      const transient = result.ok ? result.data.status === 'pending' : result.diagnostics.some(item => TRANSIENT.has(item.code) || item.code === 'STALE_POLICY_REVISION');
      if (transient && receipts.get(operation) === receipt) receipts.delete(operation);
      return result;
    });
    receipts.set(operation, receipt);
    return receipt.promise;
  }

  return Object.freeze({ descriptors: ACTIVITY_TOOL_DESCRIPTORS, execute });
}
