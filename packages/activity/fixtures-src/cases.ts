/**
 * Shared contract fixtures: every valid exemplar plus invalid cases derived from a valid base by one targeted
 * mutation each. The expectation and reason are declared here by hand, independently of either validator; both the
 * TypeScript and the Rust validator must reach the declared decision for every fixture file.
 */
import { sha256 } from '@experiment-kit/core';
import { CONTRACTS } from '../src/contracts.js';
import { MESSAGES, MODEL_MANIFEST_CONTRACT, SCHEMA_NAMES, SHORT_NAMES, type SchemaName } from '../src/schemas.js';
import { EXEMPLARS, event } from './exemplars.js';

export interface ContractFixture { contract: SchemaName; expect: 'valid' | 'invalid'; why: string; value: unknown }
export interface FixtureFile { path: string; fixture: ContractFixture }

// Mutations address arbitrary JSON paths of cloned exemplars.
type Json = any;
type Mutation = (value: Json) => Json;
interface InvalidCase { case: string; why: string; base?: string; mutate: Mutation }

const segments = (path: string): (string | number)[] => path.split('.').map(part => /^[0-9]+$/.test(part) ? Number(part) : part);
const parent = (root: Json, path: string): [Json, string | number] => {
  const keys = segments(path);
  let node = root;
  for (const key of keys.slice(0, -1)) node = node[key];
  return [node, keys[keys.length - 1]!];
};
/** Sets a value as an own enumerable data property (so `__proto__`-like keys stay plain JSON keys). */
const set = (path: string, value: unknown): Mutation => root => {
  const [node, key] = parent(root, path);
  Object.defineProperty(node, key, { value, enumerable: true, writable: true, configurable: true });
  return root;
};
const del = (path: string): Mutation => root => { const [node, key] = parent(root, path); delete node[key]; return root; };
const replace = (value: unknown): Mutation => () => value;
const astral = (count: number): string => '\u{1F600}'.repeat(count);
const repeat = (char: string, count: number): string => char.repeat(count);
const list = <T>(count: number, item: (index: number) => T): T[] => Array.from({ length: count }, (_, index) => item(index));
const entries = <T>(count: number, value: (index: number) => T): Record<string, T> => Object.fromEntries(list(count, index => [`k${index}`, value(index)]));
const digest = (label: string): string => 'sha256:' + sha256(label);
const groupDigest = (index: number) => ({ groupId: `g-extra-${index}`, contentDigest: digest(`group-${index}`) });
const first = <N extends SchemaName>(name: N, index = 0): Json => structuredClone(EXEMPLARS[name][index]!.value);

const GENERIC: InvalidCase[] = [
  { case: 'unknown-top-level-field', why: 'Unknown fields are rejected at the top level.', mutate: set('unexpectedField', true) },
  { case: 'not-an-object', why: 'The record must be a JSON object.', mutate: replace([]) },
];

const INVALID: { [N in SchemaName]: InvalidCase[] } = {
  [CONTRACTS.template]: [
    { case: 'unknown-nested-field', why: 'Mark style rejects an unknown colour field (no free styling).', mutate: set('views.0.marks.0.style.color', '#ff0000') },
    { case: 'missing-initial-stage', why: 'initialStage is required.', mutate: del('initialStage') },
    { case: 'title-over-limit-astral', why: 'Title of 201 code points exceeds 200 (a UTF-16 count would be 402).', mutate: set('title', astral(201)) },
    { case: 'template-id-pattern', why: 'Template IDs may not contain spaces.', mutate: set('templateId', 'quadratic descent') },
    { case: 'label-width-out-of-range', why: 'maxWidthEm must be at least 1.', mutate: set('views.0.marks.5.placement.maxWidthEm', 0) },
    { case: 'step-not-positive', why: 'Control step must be strictly positive.', mutate: set('controls.0.step', 0) },
    { case: 'groups-over-max-items', why: 'At most 64 content groups.', mutate: root => set('groups', list(65, index => ({ ...root.groups[0], id: `g-extra-${index}` })))(root) },
    { case: 'visible-map-over-max-properties', why: 'A stage lists at most 64 visible groups.', mutate: set('stages.0.visible', entries(65, () => 'fixed')) },
    { case: 'view-kind-enum', why: 'Unknown view kind.', mutate: set('views.0.kind', 'scene4d') },
    { case: 'schema-version-const', why: 'Only schema version 1.0 is accepted by the 1.0 schema.', mutate: set('schemaVersion', '2.0') },
    { case: 'drag-anyof-mismatch', why: 'A drag mapping names at least one axis parameter.', mutate: set('views.0.marks.1.drag', {}) },
    { case: 'model-ref-target', why: 'ModelRef digest must be lowercase hexadecimal ($ref target violation).', mutate: set('model.digest', 'sha256:' + repeat('A', 64)) },
    { case: 'tex-over-limit', why: 'TeX is limited to 4096 code points.', mutate: set('equations.0.tex', repeat('x', 4097)) },
    { case: 'reserved-key-constructor', why: 'Prototype-reserved keys are rejected even where the ID pattern would allow them.', mutate: set('scenarios.0.parameters.constructor', 1) },
    { case: 'wrong-type-boolean', why: 'equalAspect is a boolean.', mutate: set('views.0.equalAspect', 'yes') },
    { case: 'empty-transition-label', why: 'Transition labels are non-empty.', mutate: set('transitions.0.label', '') },
    { case: 'bounds-length', why: '2D bounds have exactly four numbers.', mutate: set('views.0.bounds', [-10, 10, -5]) },
    { case: 'host-owned-const', why: 'Task families are always host-owned.', mutate: set('taskFamilies.0.hostOwned', false) },
    { case: 'quantity-display-unit-enum', why: 'Quantity display units come from the bundled unit list only.', mutate: set('quantityDisplay', { angle: { units: ['grad'] } }) },
    { case: 'quantity-display-empty-units', why: 'A quantity display entry lists at least one unit.', mutate: set('quantityDisplay', { angle: { units: [] } }) },
    { case: 'quantity-display-unknown-field', why: 'A quantity display entry carries units only (no free precision or format).', mutate: set('quantityDisplay', { angle: { units: ['deg'], precision: 2 } }) },
    { case: 'control-section-unknown-field', why: 'A control section carries an ID and a label only (no free styling or order).', mutate: set('controls.0.section', { id: 'step', label: 'Step size', collapsed: true }) },
    { case: 'control-section-missing-label', why: 'A control section names its label.', mutate: set('controls.0.section', { id: 'step' }) },
    { case: 'control-section-label-over-limit-astral', why: 'Section label of 201 code points exceeds 200.', mutate: set('controls.0.section', { id: 'step', label: astral(201) }) },
  ],
  [CONTRACTS.instance]: [
    { case: 'unknown-nested-field', why: 'Stage reference rejects unknown fields.', mutate: set('stage.label', 'Predict') },
    { case: 'missing-policy', why: 'policy is required.', mutate: del('policy') },
    { case: 'activity-id-pattern', why: 'IDs may not contain a slash.', mutate: set('activityId', 'act/0001') },
    { case: 'host-session-revision-non-integer', why: 'Revisions are integers.', mutate: set('hostSessionRevision', 4.5) },
    { case: 'activity-revision-negative', why: 'Revisions are non-negative.', mutate: set('activityRevision', -1) },
    { case: 'objective-ids-over-max-items', why: 'At most 32 objective IDs.', mutate: set('objectiveIds', list(33, index => `obj-${index}`)) },
    { case: 'initial-parameters-over-max-properties', why: 'At most 64 parameters.', mutate: set('initialParameters', entries(65, () => 1)) },
    { case: 'context-oneof-missing-task', why: 'An independent context names its task.', mutate: set('context', { kind: 'independent' }) },
    { case: 'context-oneof-extra-task', why: 'An instructional context carries no task reference.', mutate: set('context', { kind: 'instructional', taskRef: 'task-1' }) },
    { case: 'persistence-enum', why: 'Unknown persistence status.', mutate: set('persistence', 'lost') },
    { case: 'template-ref-target', why: 'TemplateRef digest must be a full sha256 digest.', mutate: set('template.digest', 'sha256:short') },
    { case: 'response-ref-target', why: 'ResponseRef status must be a known status.', base: 'independent-with-responses', mutate: set('responses.0.status', 'archived') },
    { case: 'reserved-key-prototype', why: 'Prototype-reserved keys are rejected.', mutate: set('initialParameters.prototype', 1) },
    { case: 'allowed-action-enum', why: 'Allowed actions are tool operations.', mutate: set('allowedActions.0', 'shell') },
  ],
  [CONTRACTS.policy]: [
    { case: 'unknown-nested-field', why: 'Export rules reject unknown fields.', mutate: set('export.print', true) },
    { case: 'missing-revoked', why: 'revoked is required.', mutate: del('revoked') },
    { case: 'issued-at-pattern', why: 'Timestamps are RFC 3339 with a zone.', mutate: set('issuedAt', '2026-10-26 09:00:00') },
    { case: 'max-positions-out-of-range', why: 'At most 1000 sampled positions.', mutate: set('sampling.maxPositions', 1001) },
    { case: 'revision-non-integer', why: 'Revisions are integers.', mutate: set('revision', 3.2) },
    { case: 'allowed-tools-over-max-items', why: 'At most 32 tool entries.', mutate: set('allowedTools', list(33, () => 'discover')) },
    { case: 'tool-enum', why: 'Unknown tool operation.', mutate: set('allowedTools.0', 'shell') },
    { case: 'expires-at-anyof-mismatch', why: 'expiresAt is a timestamp or null.', mutate: set('expiresAt', 0) },
    { case: 'approved-model-ref-target', why: 'ModelRef version must be a full version.', mutate: set('approved.0.model.version', '1') },
    { case: 'contract-const', why: 'Contract name must match exactly.', mutate: set('contract', 'study-harness.policy') },
    { case: 'tutor-inspection-enum', why: 'Unknown tutor inspection level.', mutate: set('inspection.tutor', 'everything') },
  ],
  [CONTRACTS.scientific]: [
    { case: 'unknown-nested-field', why: 'Runtime reference rejects unknown fields.', mutate: set('runtime.build', '42') },
    { case: 'missing-position', why: 'position is required.', mutate: del('position') },
    { case: 'position-oneof-missing-max-index', why: 'An index position carries maxIndex.', mutate: set('position', { kind: 'index', index: 3 }) },
    { case: 'position-index-non-integer', why: 'Discrete indices are integers.', mutate: set('position.index', 2.5) },
    { case: 'position-time-negative', why: 'Time positions are non-negative.', mutate: set('position', { kind: 'time', time: -1, endTime: null }) },
    { case: 'comparisons-over-max-items', why: 'At most 16 retained comparisons.', mutate: root => set('comparisons', list(17, index => ({ ...root.comparisons[0], runId: `run-c${index}` })))(root) },
    { case: 'params-over-max-properties', why: 'At most 64 parameters.', mutate: set('params', entries(65, () => 0)) },
    { case: 'comparison-label-over-limit-astral', why: 'Label of 201 code points exceeds 200.', mutate: set('comparisons.0.label', astral(201)) },
    { case: 'scientific-revision-pattern', why: 'Scientific revision is a sha256 digest.', mutate: set('scientificRevision', 'rev-7') },
    { case: 'model-ref-target', why: 'ModelRef modelId must be non-empty.', mutate: set('model.modelId', '') },
    { case: 'terminal-wrong-type', why: 'terminal is a boolean.', mutate: set('terminal', 'false') },
  ],
  [CONTRACTS.presentation]: [
    { case: 'unknown-nested-field', why: 'View presentation rejects unknown fields.', mutate: set('views.plot.zoomLimit', 4) },
    { case: 'missing-locale', why: 'locale is required.', mutate: del('locale') },
    { case: 'camera-oneof-mismatch', why: 'A 2D camera has no up vector.', mutate: set('views.plot.camera', { kind: '2d', center: [0, 0], zoom: 1, up: [0, 0, 1] }) },
    { case: 'camera-zoom-not-positive', why: 'Camera2D zoom must be positive ($ref target violation).', mutate: set('views.plot.camera.zoom', 0) },
    { case: 'camera-center-length', why: 'A 2D camera centre has two coordinates.', mutate: set('views.plot.camera.center', [0, 0, 0]) },
    { case: 'revision-negative', why: 'Revisions are non-negative.', mutate: set('revision', -1) },
    { case: 'layers-over-max-items', why: 'At most 64 layers per view.', mutate: set('views.plot.layers', list(65, index => `layer-${index}`)) },
    { case: 'views-over-max-properties', why: 'At most 16 views.', mutate: set('views', entries(17, () => ({ camera: null, layers: [] }))) },
    { case: 'display-unit-enum', why: 'Unknown unit.', mutate: set('displayUnits.eta', 'km') },
    { case: 'format-version-const', why: 'Only format version 1.0.', mutate: set('formatVersion', '2.0') },
    { case: 'locale-pattern', why: 'Locale is a BCP 47 tag.', mutate: set('locale', 'english') },
    { case: 'reserved-key-constructor', why: 'Prototype-reserved keys are rejected.', mutate: set('views.constructor', { camera: null, layers: [] }) },
  ],
  [CONTRACTS.event]: [
    { case: 'unknown-payload-field', why: 'Typed payloads reject unknown fields.', mutate: set('payload.secretAnswer', 'x') },
    { case: 'missing-payload', why: 'payload is required.', mutate: del('payload') },
    { case: 'payload-missing-required', why: 'A parameters.committed payload names its run.', mutate: del('payload.runId') },
    { case: 'unknown-event-type', why: 'Unknown event type matches no variant.', mutate: set('type', 'activity.deleted') },
    { case: 'payload-of-other-type', why: 'The payload must match the event type.', mutate: set('type', 'preview.cancelled') },
    { case: 'sequence-zero', why: 'Sequences start at 1.', mutate: set('sequence', 0) },
    { case: 'sequence-non-integer', why: 'Sequences are integers.', mutate: set('sequence', 1.5) },
    { case: 'causes-over-max-items', why: 'At most 16 causal references.', mutate: set('causes', list(17, index => `evt-${index}`)) },
    { case: 'activity-opened-extra-payload-key', why: 'The activity.opened payload names its stage only (closed payload).', base: 'activity-opened', mutate: set('payload.viewport', [360, 640]) },
    { case: 'activity-prepared-extra-payload-key', why: 'The activity.prepared payload is closed.', base: 'activity-prepared', mutate: set('payload.review', 'reviewed') },
    { case: 'activity-prepared-missing-mode', why: 'The activity.prepared payload names its mode.', base: 'activity-prepared', mutate: del('payload.mode') },
    { case: 'activity-closed-extra-payload-key', why: 'The activity.closed payload is closed.', base: 'activity-closed', mutate: set('payload.grade', 'A') },
    { case: 'activity-closed-pending-enum', why: 'A close resolves a pending preview by cancel, commit or retain only.', base: 'activity-closed', mutate: set('payload.pending', 'discard') },
    { case: 'activity-suspended-reason-enum', why: 'Suspension reasons come from the host suspend vocabulary.', base: 'activity-suspended', mutate: set('payload.reason', 'bored') },
    { case: 'activity-suspended-extra-payload-key', why: 'The activity.suspended payload is closed.', base: 'activity-suspended', mutate: set('payload.detail', 'x') },
    { case: 'activity-resumed-extra-payload-key', why: 'The activity.resumed payload is empty.', base: 'activity-resumed', mutate: set('payload.after', 3) },
    { case: 'help-requested-extra-payload-key', why: 'The help.requested payload is empty: learner text never enters the journal here.', base: 'help-requested', mutate: set('payload.question', 'What is the answer?') },
    { case: 'content-revoked-extra-payload-key', why: 'The content.revoked payload is closed.', base: 'content-revoked', mutate: set('payload.detail', 'x') },
    { case: 'content-revoked-source-enum', why: 'Revocation sources are host, policy or catalogue.', base: 'content-revoked', mutate: set('payload.source', 'learner') },
    { case: 'content-revoked-missing-code', why: 'A revocation names its diagnostic code.', base: 'content-revoked', mutate: del('payload.code') },
    { case: 'operation-failed-lost-count-zero', why: 'A journal-loss record counts at least one event.', base: 'operation-failed-lost', mutate: set('payload.lost.count', 0) },
    { case: 'operation-failed-lost-type-enum', why: 'A journal-loss record names known event types.', base: 'operation-failed-lost', mutate: set('payload.lost.types', ['activity.deleted']) },
    { case: 'actor-kind-enum', why: 'Unknown actor kind.', mutate: set('actor.kind', 'admin') },
    { case: 'frame-position-ref-target', why: 'FramePosition index requires maxIndex.', mutate: set('frame.position', { kind: 'index', index: 0 }) },
    { case: 'comparison-label-over-limit-astral', why: 'Label of 201 code points exceeds 200.', base: 'comparison-retained', mutate: set('payload.label', astral(201)) },
    { case: 'model-digest-pattern', why: 'Model digest is a sha256 digest.', mutate: set('revisions.scientific.modelDigest', 'sha256:xyz') },
    { case: 'reserved-key-in-generic-payload', why: 'Prototype-reserved keys are rejected in payloads before the schema is applied.', base: 'help-requested', mutate: set('payload.constructor', 'x') },
    { case: 'proto-key-in-generic-payload', why: 'A __proto__ key is rejected.', base: 'help-requested', mutate: set('payload.__proto__', { polluted: true }) },
    { case: 'schema-version-const', why: 'Only schema version 1.0.', mutate: set('schemaVersion', '1.1') },
    { case: 'monotonic-negative', why: 'Monotonic time is non-negative.', mutate: set('monotonicMs', -1) },
    { case: 'operation-failed-code-enum', why: 'Failure codes come from the stable vocabulary.', base: 'operation-failed', mutate: set('payload.code', 'SECRET_LEAK') },
    { case: 'playback-ended-reason-enum', why: 'A playback end reason comes from the fixed list (terminal, numerical-limit, error).', base: 'playback-ended-numerical-limit', mutate: set('payload.reason', 'tired') },
    { case: 'visible-parameters-not-ids', why: 'visibleParameters lists parameter IDs.', base: 'parameters-committed-visible-parameters', mutate: set('payload.visibleParameters', [42]) },
    { case: 'payload-over-byte-limit', why: 'An event payload is at most 8 KiB (8448 counted bytes here: a 2800-code-point reason of 3-byte characters) although every field is within its schema bound.', base: 'content-revoked', mutate: set('payload', { source: 'host', code: 'POLICY_DENIED', reason: repeat('\u20AC', 2800) }) },
  ],
  [CONTRACTS.exposure]: [
    { case: 'unknown-nested-field', why: 'Display record rejects unknown fields.', mutate: set('displayed.surface', 'main') },
    { case: 'missing-display-status', why: 'displayStatus is required.', mutate: del('displayStatus') },
    { case: 'groups-empty', why: 'An exposure covers at least one group.', mutate: set('groups', []) },
    { case: 'groups-over-max-items', why: 'At most 64 groups.', mutate: set('groups', list(65, groupDigest)) },
    { case: 'parameter-domain-pair-length', why: 'A domain is a [min, max] pair.', base: 'uncertain', mutate: set('parameterDomain.eta', [0]) },
    { case: 'parameter-domain-over-max-properties', why: 'At most 64 parameters.', base: 'uncertain', mutate: set('parameterDomain', entries(65, () => [0, 1])) },
    { case: 'reason-over-limit-astral', why: 'Reason of 4001 code points exceeds 4000.', base: 'uncertain', mutate: set('uncertainty.reason', astral(4001)) },
    { case: 'display-status-enum', why: 'Unknown display status.', mutate: set('displayStatus', 'seen') },
    { case: 'activity-revision-non-integer', why: 'Revisions are integers.', mutate: set('activityRevision', 1.5) },
    { case: 'group-digest-ref-target', why: 'GroupDigest digest has 64 hex digits.', mutate: set('groups.0.contentDigest', 'sha256:' + repeat('0', 63)) },
    { case: 'monotonic-negative', why: 'Monotonic time is non-negative.', mutate: set('displayed.monotonicMs', -5) },
    { case: 'display-end-reason-enum', why: 'A display interval ends for a known reason only.', base: 'displayed-interval-ended', mutate: set('displayed.endedBy', 'bored') },
    { case: 'display-end-negative', why: 'The display interval end is a non-negative monotonic time.', base: 'displayed-interval-ended', mutate: set('displayed.endedMonotonicMs', -1) },
  ],
  [CONTRACTS.summary]: [
    { case: 'unknown-nested-field', why: 'Cursor rejects unknown fields.', mutate: set('cursor.extra', 1) },
    { case: 'missing-text', why: 'text is required.', mutate: del('text') },
    { case: 'committed-over-max-items', why: 'At most 20 committed configurations.', mutate: root => set('committedConfigurations', list(21, index => ({ ...root.committedConfigurations[0], sequence: index + 1 })))(root) },
    { case: 'rendered-over-max-items', why: 'At most 20 rendered preview samples.', mutate: root => set('previewObservations.0.rendered', list(21, () => root.previewObservations[0].rendered[0]))(root) },
    { case: 'observation-oneof-missing-value', why: 'A valid quantity result carries its value.', mutate: set('committedConfigurations.0.observations.x', { status: 'valid' }) },
    { case: 'observation-oneof-bad-code', why: 'Undefined codes are upper-case identifiers.', mutate: set('committedConfigurations.0.observations.x', { status: 'undefined', code: 'not-visible', reason: 'Hidden.' }) },
    { case: 'audience-enum', why: 'Unknown audience.', mutate: set('audience', 'parent') },
    { case: 'mode-enum', why: 'A summary mode is approved or exploratory.', base: 'exploratory-mode', mutate: set('mode', 'free') },
    { case: 'review-notice-over-limit-astral', why: 'Review notice of 201 code points exceeds 200.', base: 'exploratory-mode', mutate: set('reviewNotice', astral(201)) },
    { case: 'cursor-non-integer', why: 'Sequences are integers.', mutate: set('cursor.toSequence', 2.5) },
    { case: 'limitation-over-limit-astral', why: 'Limitation of 4001 code points exceeds 4000.', mutate: set('limitations.0', astral(4001)) },
    { case: 'furthest-position-ref-target', why: 'A static position has no index.', mutate: set('committedConfigurations.0.furthestPosition', { kind: 'static', index: 0 }) },
    { case: 'summarizer-version-pattern', why: 'Summarizer version is a full version.', mutate: set('summarizerVersion', '1') },
    { case: 'observation-over-max-items', why: 'A quantity value has at most 4096 numbers (the largest 64×64 manifest matrix).', base: 'matrix-observation-at-limit', mutate: set('committedConfigurations.0.observations.m.value', list(4097, () => 0)) },
  ],
  [CONTRACTS.artifact]: [
    { case: 'unknown-nested-field', why: 'Journal checkpoint rejects unknown fields.', mutate: set('journal.extra', true) },
    { case: 'missing-integrity', why: 'integrity is required.', mutate: del('integrity') },
    { case: 'integrity-algorithm-const', why: 'Only sha256.', mutate: set('integrity.algorithm', 'md5') },
    { case: 'integrity-path-enum', why: 'Integrity entries name protected top-level fields only.', mutate: set('integrity.entries.0.path', 'integrity') },
    { case: 'pending-oneof-mismatch', why: 'A pending preview names its parameters and base run.', mutate: set('pending', { kind: 'preview' }) },
    { case: 'instance-ref-target', why: 'Embedded instance mode must be known.', mutate: set('instance.mode', 'free') },
    { case: 'pending-events-over-max-items', why: 'At most 256 pending event IDs.', mutate: set('journal.pendingEventIds', list(257, index => `evt-${index}`)) },
    { case: 'schemas-empty', why: 'An artifact lists its schemas.', mutate: set('schemas', []) },
    { case: 'scientific-params-over-max-properties', why: 'At most 64 parameters.', mutate: set('scientific.params', entries(65, () => 0)) },
    { case: 'reserved-key-prototype', why: 'Prototype-reserved keys are rejected.', mutate: set('presentation.views.prototype', { camera: null, layers: [] }) },
    { case: 'schema-version-pattern', why: 'Schema versions are major.minor.', mutate: set('schemas.0.version', '1') },
    { case: 'assistance-kind-enum', why: 'Assistance references name a known assistance kind.', base: 'backup-with-assistance', mutate: set('assistance.0.kind', 'hint') },
    { case: 'assistance-grant-groups-empty', why: 'A grant summary names at least one group.', base: 'backup-with-assistance', mutate: set('assistance.1.grant.groups', []) },
    { case: 'assistance-unknown-field', why: 'Assistance references reject unknown fields.', base: 'backup-with-assistance', mutate: set('assistance.0.text', 'secret') },
    { case: 'journal-lost-count-zero', why: 'A journal-loss record counts at least one event.', base: 'backup-with-pending-events-and-lineage', mutate: set('journal.lost.count', 0) },
    { case: 'journal-lost-unknown-field', why: 'A journal-loss record rejects unknown fields.', base: 'backup-with-pending-events-and-lineage', mutate: set('journal.lost.payloads', []) },
    { case: 'journal-pending-events-empty', why: 'Carried pending events are omitted rather than empty.', base: 'backup-with-pending-events-and-lineage', mutate: set('journal.pendingEvents', []) },
    { case: 'journal-pending-event-invalid', why: 'A carried pending event must be a valid interaction event.', base: 'backup-with-pending-events-and-lineage', mutate: set('journal.pendingEvents.0.payload.reason', 'bored') },
    { case: 'lineage-unknown-field', why: 'The lineage record carries restricting claims only.', base: 'backup-with-pending-events-and-lineage', mutate: set('lineage.allVisible', true) },
    { case: 'lineage-missing-reopen', why: 'The lineage record states whether reopening is required.', base: 'backup-with-pending-events-and-lineage', mutate: del('lineage.reopenRequired') },
  ],
  [CONTRACTS.review]: [
    { case: 'unknown-nested-field', why: 'Reviewer rejects unknown fields.', mutate: set('reviewer.email', 'reviewer@example.org') },
    { case: 'missing-outcome', why: 'outcome is required.', mutate: del('outcome') },
    { case: 'subject-oneof-mismatch', why: 'A model subject cannot carry template fields.', mutate: set('subject', { kind: 'model', templateId: 'x', version: '1.0.0', contentDigest: digest('x') }) },
    { case: 'date-pattern', why: 'Dates are YYYY-MM-DD.', mutate: set('date', '20/10/2026') },
    { case: 'reviewer-name-over-limit-astral', why: 'Name of 201 code points exceeds 200.', mutate: set('reviewer.name', astral(201)) },
    { case: 'limitations-over-max-items', why: 'At most 32 limitations.', mutate: set('limitations', list(33, index => `Limitation ${index}.`)) },
    { case: 'outcome-enum', why: 'Unknown outcome.', mutate: set('outcome', 'pending') },
    { case: 'reference-suite-digest-pattern', why: 'Reference suite digest is sha256.', mutate: set('referenceSuiteDigest', 'md5:abc') },
    { case: 'scope-empty', why: 'Scope is non-empty.', mutate: set('scope', '') },
  ],
  [CONTRACTS.exposureReceipt]: [
    { case: 'unknown-nested-field', why: 'Grant rejects unknown fields.', mutate: set('grant.note', 'x') },
    { case: 'missing-intended-stage', why: 'intendedStage is required.', mutate: del('intendedStage') },
    { case: 'grant-groups-empty', why: 'A grant covers at least one group.', mutate: set('grant.groups', []) },
    { case: 'grant-scope-enum', why: 'Unknown grant scope.', mutate: set('grant.scope', 'forever') },
    { case: 'policy-revision-negative', why: 'Revisions are non-negative.', mutate: set('policyRevision', -1) },
    { case: 'based-on-revision-non-integer', why: 'Revisions are integers.', mutate: set('basedOnActivityRevision', 2.5) },
    { case: 'expires-at-anyof-mismatch', why: 'expiresAt is a timestamp or null.', mutate: set('expiresAt', 'tomorrow') },
    { case: 'template-ref-target', why: 'TemplateRef version must be a full version.', mutate: set('template.version', 'v1') },
    { case: 'idempotency-key-pattern', why: 'Idempotency keys are IDs.', mutate: set('idempotencyKey', 'op reveal 1') },
    { case: 'contract-const', why: 'A stage receipt name is not an exposure receipt.', mutate: set('contract', CONTRACTS.stageReceipt) },
  ],
  [CONTRACTS.stageReceipt]: [
    { case: 'unknown-nested-field', why: 'ModelRef rejects unknown fields.', mutate: set('model.revision', 'x') },
    { case: 'missing-grant', why: 'grant is required (null when nothing is revealed).', mutate: del('grant') },
    { case: 'grant-anyof-mismatch', why: 'grant is a grant or null.', mutate: set('grant', {}) },
    { case: 'from-stage-pattern', why: 'Stage IDs start with a letter or digit.', mutate: set('fromStage', '-explore') },
    { case: 'activity-revision-over-max', why: 'Revisions are at most 2^53 − 1.', mutate: set('activityRevision', 10_000_000_000_000_000) },
    { case: 'issued-at-pattern', why: 'Timestamps carry a zone.', mutate: set('issuedAt', '2026-10-26T09:12:04') },
    { case: 'grant-ref-target', why: 'GroupDigest groupId is non-empty.', base: 'revealing', mutate: set('grant.groups.0.groupId', '') },
    { case: 'contract-const', why: 'An exposure receipt name is not a stage receipt.', mutate: set('contract', CONTRACTS.exposureReceipt) },
  ],
  [CONTRACTS.assistanceReceipt]: [
    { case: 'unknown-nested-field', why: 'TemplateRef rejects unknown fields.', mutate: set('template.label', 'x') },
    { case: 'missing-kind', why: 'kind is required.', mutate: del('kind') },
    { case: 'kind-enum', why: 'Unknown assistance kind.', mutate: set('kind', 'hint') },
    { case: 'grant-anyof-mismatch', why: 'A grant needs at least one group.', mutate: set('grant', { exposureId: 'exp-1', scope: 'reveal', groups: [] }) },
    { case: 'policy-id-too-long', why: 'IDs are at most 128 characters.', mutate: set('policyId', repeat('p', 129)) },
    { case: 'revision-wrong-type', why: 'Revisions are numbers.', mutate: set('activityRevision', '3') },
    { case: 'expires-at-pattern', why: 'A date without time is not a timestamp.', mutate: set('expiresAt', '2026-10-26') },
  ],
  [MESSAGES.activityRequest]: [
    { case: 'unknown-nested-field', why: 'A template request names ID and version only.', mutate: set('template.digest', digest('x')) },
    { case: 'missing-mode', why: 'mode is required.', mutate: del('mode') },
    { case: 'parameters-over-max-properties', why: 'At most 64 parameters.', mutate: set('parameters', entries(65, () => 0)) },
    { case: 'parameter-wrong-type', why: 'Parameter values are numbers.', mutate: set('parameters.eta', '0.5') },
    { case: 'objective-ids-over-max-items', why: 'At most 32 objectives.', mutate: set('objectiveIds', list(33, index => `obj-${index}`)) },
    { case: 'host-session-revision-negative', why: 'Revisions are non-negative.', mutate: set('hostSessionRevision', -1) },
    { case: 'mode-enum', why: 'Unknown mode.', mutate: set('mode', 'graded') },
    { case: 'stage-id-pattern', why: 'Stage IDs contain no spaces.', mutate: set('stageId', 'stage one') },
    { case: 'reserved-key-constructor', why: 'Prototype-reserved keys are rejected.', mutate: set('parameters.constructor', 1) },
    { case: 'template-version-pattern', why: 'Versions are explicit.', mutate: set('template.version', 'latest') },
  ],
  [MESSAGES.stageTransitionRequest]: [
    { case: 'unknown-nested-field', why: 'GroupDigest rejects unknown fields.', base: 'revealing', mutate: set('groups.0.label', 'x') },
    { case: 'missing-groups', why: 'groups is required.', mutate: del('groups') },
    { case: 'groups-over-max-items', why: 'At most 64 groups.', mutate: set('groups', list(65, groupDigest)) },
    { case: 'actor-enum', why: 'Unknown actor.', mutate: set('actor', 'admin') },
    { case: 'expected-policy-revision-non-integer', why: 'Revisions are integers.', mutate: set('expectedPolicyRevision', 1.5) },
    { case: 'group-digest-ref-target', why: 'GroupDigest digest is complete.', base: 'revealing', mutate: set('groups.0.contentDigest', 'sha256:') },
    { case: 'to-stage-empty', why: 'Stage IDs are non-empty.', mutate: set('toStage', '') },
  ],
  [MESSAGES.exposureIntentRequest]: [
    { case: 'groups-empty', why: 'An intent covers at least one group.', mutate: set('groups', []) },
    { case: 'scope-enum', why: 'Unknown scope.', mutate: set('scope', 'everything') },
    { case: 'parameter-domain-pair-length', why: 'A domain is a [min, max] pair.', base: 'exploration', mutate: set('parameterDomain.eta', [0, 1, 2]) },
    { case: 'missing-intended-stage', why: 'intendedStage is required.', mutate: del('intendedStage') },
    { case: 'unknown-nested-field', why: 'ModelRef rejects unknown fields.', mutate: set('model.signature', 'x') },
    { case: 'operation-id-too-long', why: 'IDs are at most 128 characters.', mutate: set('operationId', repeat('o', 129)) },
  ],
  [MESSAGES.displayAckRequest]: [
    { case: 'missing-frame-id', why: 'frameId is required.', mutate: del('frameId') },
    { case: 'projection-digest-pattern', why: 'Digest is lowercase hexadecimal.', mutate: set('projectionDigest', 'sha256:' + repeat('g', 64)) },
    { case: 'monotonic-negative', why: 'Monotonic time is non-negative.', mutate: set('monotonicMs', -1) },
    { case: 'monotonic-wrong-type', why: 'Monotonic time is a number.', mutate: set('monotonicMs', '48213') },
    { case: 'receipt-id-too-long', why: 'IDs are at most 128 characters.', mutate: set('receiptId', repeat('r', 129)) },
  ],
  [MESSAGES.assistanceRequest]: [
    { case: 'missing-kind', why: 'kind is required.', mutate: del('kind') },
    { case: 'kind-enum', why: 'Unknown assistance kind.', mutate: set('kind', 'answer') },
    { case: 'groups-over-max-items', why: 'At most 64 groups.', mutate: set('groups', list(65, groupDigest)) },
    { case: 'template-ref-target', why: 'TemplateRef digest has exactly 64 hex digits.', mutate: set('template.digest', 'sha256:' + repeat('f', 65)) },
    { case: 'actor-enum', why: 'Unknown actor.', mutate: set('actor', 'system') },
  ],
  [CONTRACTS.capability]: [
    { case: 'vertices-over-limit', why: 'spatial-3d@1.0 enforces at most 20,000 vertices per view (limit + 1).', mutate: set('limits.vertices', 20_001) },
    { case: 'indices-over-limit', why: 'spatial-3d@1.0 enforces at most 120,000 surface indices per view (limit + 1).', mutate: set('limits.indices', 120_001) },
    { case: 'field-samples-over-limit', why: 'spatial-3d@1.0 enforces at most 1,000 vector-field samples per view (limit + 1).', mutate: set('limits.fieldSamples', 1_001) },
    { case: 'labels-over-limit', why: 'spatial-3d@1.0 shows at most 32 labels per view (limit + 1).', mutate: set('limits.labels', 33) },
    { case: 'texture-size-over-limit', why: 'spatial-3d@1.0 allows textures of at most 1024 pixels per edge (limit + 1).', mutate: set('limits.textureSize', 1025) },
    { case: 'draw-calls-over-limit', why: 'spatial-3d@1.0 renders at most 128 draw calls per frame (limit + 1).', mutate: set('limits.drawCallsPerFrame', 129) },
    { case: 'draw-calls-missing', why: 'The per-frame draw-call limit is required.', mutate: del('limits.drawCallsPerFrame') },
    { case: 'unknown-capability-id', why: 'Only installed capability IDs have records.', mutate: set('id', 'spatial-4d') },
    { case: 'unknown-capability-version', why: 'Only installed capability versions have records (no nearest version).', mutate: set('version', '1.1') },
    { case: 'unknown-limit-field', why: 'Limits are closed: no unrecognised limit can be claimed.', mutate: set('limits.shaders', 1) },
    { case: 'geometry-kind-enum', why: 'Only the bounded scientific primitives are drawable.', mutate: set('geometryKinds.0', 'mesh-file') },
    { case: 'max-index-over-limit', why: 'discrete-iteration@1.0 bounds the index at 10,000,000 (limit + 1).', base: 'discrete-iteration', mutate: set('limits.maxIndex', 10_000_001) },
    { case: 'discrete-with-spatial-limits', why: 'Each capability has its own closed limits.', base: 'discrete-iteration', mutate: set('limits.vertices', 10) },
  ],
  [MESSAGES.appendEventsRequest]: [
    { case: 'events-empty', why: 'A batch has at least one event.', mutate: set('events', []) },
    { case: 'events-over-max-items', why: 'At most 32 events per batch.', mutate: set('events', list(33, index => event('activity.resumed', index + 1, {}))) },
    { case: 'event-oneof-mismatch', why: 'An event payload must match its type.', base: 'batch', mutate: set('events.1.type', 'preview.started') },
    { case: 'event-unknown-field', why: 'Events reject unknown fields.', mutate: set('events.0.debug', true) },
    { case: 'activity-id-empty', why: 'IDs are non-empty.', mutate: set('activityId', '') },
    { case: 'missing-events', why: 'events is required.', mutate: del('events') },
    { case: 'event-payload-over-byte-limit', why: 'Each event payload in a batch is at most 8 KiB.', mutate: set('events.0', event('content.revoked', 2, { source: 'host', code: 'POLICY_DENIED', reason: repeat('\u20AC', 2800) })) },
  ],
  [MESSAGES.appendResult]: [
    { case: 'durable-sequence-zero', why: 'Durable sequences start at 1.', base: 'with-duplicate', mutate: set('acknowledged.0.durableSequence', 0) },
    { case: 'host-timestamp-pattern', why: 'Host timestamps are RFC 3339.', mutate: set('acknowledged.0.hostTimestamp', 'yesterday') },
    { case: 'duplicates-over-max-items', why: 'At most 32 duplicates.', mutate: set('duplicates', list(33, index => `evt-${index}`)) },
    { case: 'cursor-ref-target', why: 'JournalCursor lastSequence is non-negative.', mutate: set('cursor.lastSequence', -1) },
    { case: 'acknowledged-unknown-field', why: 'Acknowledgements reject unknown fields.', mutate: set('acknowledged.0.latencyMs', 3) },
    { case: 'missing-cursor', why: 'cursor is required.', mutate: del('cursor') },
  ],
  [MESSAGES.journalCursor]: [
    { case: 'last-sequence-negative', why: 'Sequences are non-negative.', base: 'checkpoint', mutate: set('lastSequence', -1) },
    { case: 'last-sequence-non-integer', why: 'Sequences are integers.', base: 'checkpoint', mutate: set('lastSequence', 1.5) },
    { case: 'last-event-id-anyof-mismatch', why: 'lastEventId is an ID or null.', base: 'checkpoint', mutate: set('lastEventId', 5) },
    { case: 'checkpoint-digest-pattern', why: 'Digest is lowercase hexadecimal.', base: 'checkpoint', mutate: set('checkpointDigest', 'sha256:' + repeat('A', 64)) },
    { case: 'missing-activity-id', why: 'activityId is required.', mutate: del('activityId') },
    { case: 'activity-id-too-long', why: 'IDs are at most 128 characters.', mutate: set('activityId', repeat('a', 129)) },
  ],
  [MESSAGES.registerActivityRequest]: [
    { case: 'missing-operation-id', why: 'operationId is required.', mutate: del('operationId') },
    { case: 'instance-ref-target', why: 'Embedded instance persistence must be known.', mutate: set('instance.persistence', 'unknown') },
    { case: 'missing-instance', why: 'instance is required.', mutate: del('instance') },
    { case: 'operation-id-pattern', why: 'Operation IDs start with a letter or digit.', mutate: set('operationId', '#1') },
    { case: 'instance-unknown-field', why: 'The instance rejects unknown fields such as grades.', mutate: set('instance.grade', 'A') },
  ],
  [MESSAGES.saveArtifactRequest]: [
    { case: 'missing-artifact', why: 'artifact is required.', mutate: del('artifact') },
    { case: 'artifact-kind-enum', why: 'Unknown artifact kind.', base: 'snapshot', mutate: set('artifact.kind', 'export') },
    { case: 'integrity-digest-pattern', why: 'Integrity digest is complete.', base: 'snapshot', mutate: set('artifact.integrity.digest', 'sha256:') },
    { case: 'artifact-unknown-field', why: 'The artifact rejects unknown fields.', base: 'snapshot', mutate: set('artifact.notes', 'x') },
    { case: 'operation-id-too-long', why: 'IDs are at most 128 characters.', mutate: set('operationId', repeat('o', 129)) },
  ],
  [MESSAGES.activityLookupRequest]: [
    { case: 'missing-activity-id', why: 'activityId is required.', mutate: replace({}) },
    { case: 'activity-id-empty', why: 'IDs are non-empty.', mutate: set('activityId', '') },
    { case: 'activity-id-path-like', why: 'IDs cannot be paths.', mutate: set('activityId', '../etc/passwd') },
    { case: 'activity-id-wrong-type', why: 'IDs are strings.', mutate: set('activityId', 42) },
    { case: 'activity-id-too-long', why: 'IDs are at most 128 characters.', mutate: set('activityId', repeat('a', 129)) },
    { case: 'activity-id-trailing-newline', why: 'Patterns anchor at the end of input: a trailing newline does not match `$` (JavaScript and Rust agree; Python would not).', mutate: set('activityId', 'act-quadratic-0001\n') },
    { case: 'activity-id-unicode-digit', why: 'ID classes are ASCII: an Arabic-Indic digit is not [0-9].', mutate: set('activityId', 'act-\u0663') },
  ],
  [MESSAGES.hostAck]: [
    { case: 'ok-const', why: 'An acknowledgement is ok: true; failures are errors, not acks.', mutate: set('ok', false) },
    { case: 'ok-wrong-type', why: 'ok is the boolean true.', mutate: set('ok', 'true') },
    { case: 'missing-host-timestamp', why: 'hostTimestamp is required.', mutate: del('hostTimestamp') },
    { case: 'host-timestamp-pattern', why: 'Timestamps include seconds.', mutate: set('hostTimestamp', '2026-10-26T09:01Z') },
    { case: 'artifact-digest-pattern', why: 'Artifact digest is sha256.', base: 'artifact', mutate: set('artifactDigest', 'sha1:abc') },
  ],
  [MESSAGES.activityRecords]: [
    { case: 'missing-assistance', why: 'assistance is required (empty when none).', mutate: del('assistance') },
    { case: 'exposure-invalid', why: 'Each exposure is a valid exposure record.', base: 'with-records', mutate: set('exposures.0.displayStatus', 'seen') },
    { case: 'assistance-sequence-zero', why: 'Assistance sequences start at 1.', base: 'with-records', mutate: set('assistance.0.sequence', 0) },
    { case: 'assistance-unknown-field', why: 'Assistance references reject unknown fields.', base: 'with-records', mutate: set('assistance.0.text', 'secret') },
    { case: 'exposures-over-max-items', why: 'At most 256 exposure records.', base: 'with-records', mutate: root => set('exposures', list(257, index => ({ ...root.exposures[0], exposureId: `exp-${index}` })))(root) },
    { case: 'activity-unknown-field', why: 'The host activity state is closed: no other claim can ride along.', base: 'with-host-activity', mutate: set('activity.visibleGroups', ['g-trajectory']) },
    { case: 'activity-missing-closed', why: 'The host activity state names whether the host closed the activity.', base: 'with-host-activity', mutate: del('activity.closed') },
    { case: 'activity-revision-negative', why: 'Activity revisions are non-negative integers.', base: 'with-host-activity', mutate: set('activity.activityRevision', -1) },
    { case: 'activity-stage-path-like', why: 'The stage is an ID, never a path.', base: 'with-host-activity', mutate: set('activity.stage', '../explore') },
    { case: 'lineage-unknown-field', why: 'The host lineage is closed: it carries no ended-grant list or other claim.', base: 'with-host-lineage', mutate: set('activity.lineage.endedExposureIds', ['exp-0001']) },
    { case: 'lineage-missing-from-revision', why: 'A lineage names the first activity revision whose grants count in it.', base: 'with-host-lineage', mutate: del('activity.lineage.fromActivityRevision') },
    { case: 'lineage-independent-without-task', why: 'An independent lineage names its task.', base: 'with-host-lineage', mutate: set('activity.lineage.context', { kind: 'independent' }) },
    { case: 'lineage-from-revision-negative', why: 'Activity revisions are non-negative integers.', base: 'with-host-lineage', mutate: set('activity.lineage.fromActivityRevision', -1) },
    { case: 'stage-receipt-path-like', why: 'The stage receipt is an ID, never a path.', base: 'with-host-lineage', mutate: set('activity.stageReceiptId', '../rcpt') },
  ],
  [MODEL_MANIFEST_CONTRACT]: [
    { case: 'unknown-nested-field', why: 'Parameter definitions reject unknown fields.', mutate: set('parameters.a.unitLabel', '') },
    { case: 'missing-interpretation', why: 'interpretation is required.', mutate: del('interpretation') },
    { case: 'unit-enum', why: 'Unknown unit.', mutate: set('parameters.a.unit', 'km') },
    { case: 'parameters-over-max-properties', why: 'At most 64 parameters.', mutate: root => set('parameters', entries(65, () => root.parameters.a))(root) },
    { case: 'shape-oneof-mismatch', why: 'A vector shape declares its length.', mutate: set('quantities.point.shape', { kind: 'vector' }) },
    { case: 'execution-oneof-mismatch', why: 'Kernel mode is discrete or static.', mutate: set('execution.mode', 'continuous') },
    { case: 'max-operations-out-of-range', why: 'maxOperations is at least 1.', mutate: set('limits.maxOperations', 0) },
    { case: 'title-over-limit-astral', why: 'Title of 201 code points exceeds 200.', mutate: set('title', astral(201)) },
    { case: 'capability-version-pattern', why: 'Capability versions have at most three parts.', mutate: set('capabilities.0.version', '1.0.0.0') },
    { case: 'reserved-key-constructor', why: 'Prototype-reserved keys are rejected even though the symbol pattern allows them.', mutate: root => set('quantities.constructor', root.quantities.x)(root) },
    { case: 'reference-suite-anyof-mismatch', why: 'A reference suite names its digest.', mutate: set('referenceSuite', { suiteId: 'x' }) },
    { case: 'max-index-out-of-range', why: 'Discrete iteration is bounded to index 10,000,000, the largest position activity records can carry.', mutate: set('limits.maxIndex', 10_000_001) },
    { case: 'evaluation-determinism-enum', why: 'Determinism is bitwise or within-engine; nothing weaker can be declared.', base: 'evaluation-declared', mutate: set('evaluation.determinism', 'approximate') },
    { case: 'evaluation-checkpoint-enum', why: 'Manifest 1.0 kernels keep no evaluation state: checkpoint is none.', base: 'evaluation-declared', mutate: set('evaluation.checkpoint', 'snapshot') },
    { case: 'evaluation-missing-checkpoint', why: 'A declared evaluation behaviour names both determinism and checkpoint.', base: 'evaluation-declared', mutate: del('evaluation.checkpoint') },
    { case: 'evaluation-unknown-field', why: 'The evaluation behaviour is closed.', base: 'evaluation-declared', mutate: set('evaluation.seed', 1) },
    { case: 'observation-cell-type', why: 'An observed cell is a number or null (missing); text is not data.', base: 'observed-static', mutate: set('observations.drops.rows.1.1', '18.8') },
    { case: 'observation-rows-over-max-items', why: 'An observed dataset holds at most 2000 rows.', base: 'observed-static', mutate: set('observations.drops.rows', list(2001, index => [index, index])) },
    { case: 'observation-unknown-field', why: 'Observed datasets reject unknown fields (no interpolation or fitting switch exists).', base: 'observed-static', mutate: set('observations.drops.interpolate', true) },
    { case: 'observation-missing-provenance', why: 'Observed data always carry their provenance.', base: 'observed-static', mutate: del('observations.drops.provenance') },
    { case: 'observation-column-unit-enum', why: 'Observed columns use the supported unit IDs, not free text.', base: 'observed-static', mutate: set('observations.drops.columns.1.unit', 'metres') },
    { case: 'observation-binding-unknown-field', why: 'An observed geometry binding names only dataset, x and y.', base: 'observed-static', mutate: set('geometry.measured.observations.fit', 'linear') },
    { case: 'coordinates-unit-enum', why: 'Coordinate units are supported unit IDs, not free text.', base: 'geometry-coordinates', mutate: set('geometry.trace.coordinates.x', 'iterations') },
    { case: 'coordinates-unknown-field', why: 'Geometry coordinates name only x, y and z.', base: 'geometry-coordinates', mutate: set('geometry.trace.coordinates.w', 'm') },
    { case: 'coordinates-missing-y', why: 'Declared coordinates name at least the x and y units.', base: 'geometry-coordinates', mutate: del('geometry.trace.coordinates.y') },
  ],
};

/** All shared fixture files, in a stable order. */
export function buildFixtures(): FixtureFile[] {
  const files: FixtureFile[] = [];
  for (const name of SCHEMA_NAMES) {
    const short = SHORT_NAMES[name];
    for (const exemplar of EXEMPLARS[name]) files.push({ path: `valid/${short}/${exemplar.case}.json`, fixture: { contract: name, expect: 'valid', why: exemplar.why, value: structuredClone(exemplar.value) } });
    for (const item of [...GENERIC, ...INVALID[name]]) {
      const index = item.base ? EXEMPLARS[name].findIndex(exemplar => exemplar.case === item.base) : 0;
      if (index < 0) throw new Error(`Unknown base exemplar ${item.base} for ${name}.`);
      files.push({ path: `invalid/${short}/${item.case}.json`, fixture: { contract: name, expect: 'invalid', why: item.why, value: item.mutate(first(name, index)) } });
    }
  }
  return files;
}

/** File text exactly as written to disk. */
export const fixtureText = (fixture: ContractFixture): string => JSON.stringify(fixture, null, 2) + '\n';
