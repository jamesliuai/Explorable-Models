/**
 * Learner-safe text (report §6.2, §10.4, §16). Everything here is generated from a fixed vocabulary or from an
 * already-built learner projection, so it can never mention a hidden quantity, a hidden label or a value that the
 * projection does not contain. Error messages for learner and tutor bindings come only from {@link LEARNER_MESSAGES};
 * the paths they carry name only the caller's own input fields.
 */
import type { Diagnostic, DiagnosticCode } from './contracts.js';
import type { LearnerProjection, ProjectedStatus, ProjectedValue, ProjectedView, UiState } from './api.js';

type Text = { message: string; recovery: string };
const T = (message: string, recovery: string): Text => ({ message, recovery });
const RETRY = 'Try again.';

/** Fixed learner-safe vocabulary for every diagnostic code. */
export const LEARNER_MESSAGES: Readonly<Record<DiagnosticCode, Text>> = Object.freeze({
  UNSUPPORTED_CAPABILITY: T('This is not available in this activity.', 'Use the controls that are shown.'),
  INVALID_REFERENCE: T('That item is not part of this activity.', 'Use the items that are shown.'),
  INVALID_INPUT: T('That entry is not a valid value here.', 'Enter a number within the stated range; it is not changed for you.'),
  SCHEMA: T('That request is not in the expected form.', RETRY),
  CONSTRAINT_VIOLATION: T('That combination of values is outside what this model allows.', 'Choose values that satisfy the stated limits.'),
  OUT_OF_DOMAIN: T('That value is outside the allowed range.', 'Choose a value within the stated range.'),
  UNDEFINED_CALCULATION: T('This value is not defined for the current settings.', 'Try different settings if you want a defined value.'),
  NUMERICAL_LIMIT: T('This value is beyond what can be represented.', 'Choose an earlier step or different settings.'),
  STALE_MODEL_REVISION: T('The experiment changed before this request arrived.', 'Use the current view and try again.'),
  STALE_ACTIVITY_REVISION: T('The activity changed before this request arrived.', 'Use the current view and try again.'),
  STALE_POLICY_REVISION: T('The activity settings changed before this request arrived.', 'Use the current view and try again.'),
  STALE_HOST_REVISION: T('The session changed before this request arrived.', 'Use the current view and try again.'),
  STALE_PRESENTATION_REVISION: T('The view changed before this request arrived.', 'Use the current view and try again.'),
  POLICY_DENIED: T('This is not available right now.', 'Continue with what is shown.'),
  POLICY_EXPIRED: T('The permission for this activity has expired.', 'Return to the session to continue.'),
  CONTENT_REVOKED: T('This activity is no longer available.', 'Return to the session.'),
  REVIEW_UNVERIFIED: T('This activity has not been verified for this use.', 'Return to the session.'),
  PERSISTENCE_PENDING: T('Your earlier steps are still being saved.', 'Wait a moment and try again.'),
  PERSISTENCE_FAILED: T('Saving did not complete, so nothing new was shown.', 'Try again.'),
  PERSISTENCE_BACKPRESSURE: T('Saving is behind, so this step is paused.', 'Wait for saving to catch up, then try again.'),
  WORKER_ERROR: T('The calculation did not complete. The previous result is still shown.', RETRY),
  WORKER_TIMEOUT: T('The calculation took too long. The previous result is still shown.', RETRY),
  UNSUPPORTED_ARTIFACT: T('This saved activity cannot be opened here.', 'Ask the host to show it as a read-only record.'),
  MIGRATION_REQUIRED: T('This saved activity needs to be updated before it can open.', 'Ask the host to update it.'),
  INTEGRITY_FAILURE: T('This saved activity is damaged.', 'Use another copy.'),
  CANCELLED: T('That step was cancelled.', 'Start it again when ready.'),
  DISPOSED: T('This activity has been closed.', 'Return to the session.'),
  CONFLICT: T('Something changed before this request arrived.', 'Use the current view and try again.'),
  OPERATION_CONFLICT: T('That request was already used for a different step.', 'Try the step again.'),
  PREVIEW_ACTIVE: T('A change is still being previewed.', 'Finish or cancel the change first.'),
  NOT_READY: T('The activity is not ready for this step.', 'Wait until it is shown, then try again.'),
  RESOURCE_LIMIT: T('Too much is open at once.', 'Close or remove something, then try again.'),
  RECEIPT_MISMATCH: T('The permission for this step could not be confirmed, so nothing new was shown.', RETRY),
  CAPTURE_REJECTED: T('This view cannot be captured now.', 'Finish any change in progress first.'),
  INDEPENDENT_CONTEXT: T('This is not available during independent work.', 'Continue with the task.'),
  NOT_FOUND: T('That item is not available.', 'Use the items that are shown.'),
  DUPLICATE_ID: T('That item is listed twice.', RETRY),
  KIND_MISMATCH: T('That item cannot be used this way.', 'Use the items that are shown.'),
  UNIT_MISMATCH: T('That unit cannot be used for this value.', 'Choose one of the listed units.'),
  EQUATION_DISCLOSURE: T('That equation is not available now.', 'Continue with what is shown.'),
  MISSING_EQUIVALENT: T('An equivalent view is not available.', 'Continue with what is shown.'),
  NEVER_VISIBLE: T('That item is not shown in this activity.', 'Use the items that are shown.'),
  UNREFERENCED: T('That item is not used in this activity.', 'Use the items that are shown.'),
});

const INPUT_PATH = /^\$\.(displayValues|parameters)\.[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const CONSTRAINT_PATH = /^\$\.constraints\.([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})$/;

/** Learner-facing text of a coupled model constraint (report §8.2): the manifest's learner-safe message and recovery. */
export interface LearnerConstraintText { message: string; recovery: string }
export interface LearnerDiagnosticOptions {
  /**
   * Coupled constraints whose own text the learner may read, keyed by constraint ID: the caller lists a constraint only
   * when every parameter it references is a control the learner sees in the current stage, so the text cannot mention a
   * hidden quantity. A `CONSTRAINT_VIOLATION` at `$.constraints.<id>` of a listed constraint carries that text; every
   * other diagnostic (and every unlisted constraint) keeps the fixed vocabulary.
   */
  constraints?: Readonly<Record<string, LearnerConstraintText>>;
}

/**
 * Rewrites diagnostics into the learner-safe vocabulary. A path is kept only when it names a field of the caller's
 * own input (`inputPaths`) or one of their parameter entries; every other path collapses to `$`. The only text that
 * does not come from {@link LEARNER_MESSAGES} is the manifest text of a coupled constraint the caller lists in
 * `options.constraints` (see {@link LearnerDiagnosticOptions}).
 */
export function learnerDiagnostics(items: readonly Diagnostic[], inputPaths: readonly string[] = [], options: LearnerDiagnosticOptions = {}): Diagnostic[] {
  const seen = new Set<string>();
  const out: Diagnostic[] = [];
  for (const item of items.slice(0, 16)) {
    const path = INPUT_PATH.test(item.path) ? item.path.replace(/^\$\.parameters\./, '$.displayValues.') : inputPaths.includes(item.path) ? item.path : '$';
    const constraintId = item.code === 'CONSTRAINT_VIOLATION' ? CONSTRAINT_PATH.exec(item.path)?.[1] : undefined;
    const constraint = constraintId !== undefined && options.constraints && Object.hasOwn(options.constraints, constraintId) ? options.constraints[constraintId]! : null;
    const key = `${item.code}\u0000${path}\u0000${constraint ? constraintId : ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const text = constraint ?? LEARNER_MESSAGES[item.code] ?? LEARNER_MESSAGES.INVALID_INPUT;
    out.push({ code: item.code, path, message: text.message, recovery: text.recovery });
  }
  return out;
}

/**
 * Default host-facing recovery for every diagnostic code (report §5.3: each error describes a valid recovery without
 * exposing hidden content). Host-control and adapter failures that carry no recovery of their own receive this text;
 * learner and tutor bindings keep {@link LEARNER_MESSAGES}. The sentences name API operations, never content.
 */
export const HOST_RECOVERY: Readonly<Record<DiagnosticCode, string>> = Object.freeze({
  UNSUPPORTED_CAPABILITY: 'Use a capability listed by getCapabilities(); this adapter does not provide the requested one and nothing is substituted.',
  INVALID_REFERENCE: 'Use IDs and exact versions listed by getCapabilities() or the current state; references never resolve to another item.',
  INVALID_INPUT: 'Correct the field named by the path, then send the request again.',
  SCHEMA: 'Send a record that matches the published 1.0 schema for its contract; unknown fields are rejected.',
  CONSTRAINT_VIOLATION: 'Choose parameter values that satisfy the model constraint named by the path; exact entries are never clamped.',
  OUT_OF_DOMAIN: 'Choose a value inside the declared parameter range or the authorized exploration domain.',
  UNDEFINED_CALCULATION: 'The value is undefined for these inputs; present it as undefined with its reason, or choose other inputs.',
  NUMERICAL_LIMIT: 'Use an earlier position or other inputs; the value lies beyond the representable range and is never shown as a number.',
  STALE_MODEL_REVISION: 'Read the current scientific guards (getState or the projection) and retry with a new operation ID if the request still applies.',
  STALE_ACTIVITY_REVISION: 'Read the current activity revision and retry with a new operation ID if the request still applies.',
  STALE_POLICY_REVISION: 'Fetch the current host policy, then retry under its revision if the request still applies.',
  STALE_HOST_REVISION: 'Read the current host session revision and retry if the change still applies.',
  STALE_PRESENTATION_REVISION: 'Read the current presentation revision and retry if the change still applies.',
  POLICY_DENIED: 'The current host policy does not permit this; change the policy through the host or offer a permitted alternative.',
  POLICY_EXPIRED: 'Issue a current policy through the host, then prepare or restore the activity again.',
  CONTENT_REVOKED: 'Revoked content is not reopened; choose another installed activity, or show a saved artifact read-only with archivalView(artifact, { audience }).',
  REVIEW_UNVERIFIED: 'Resolve review status through the host review registry; review claims carried in data are not trusted.',
  PERSISTENCE_PENDING: 'Let the host acknowledge the journal (retryPersistence or reconcile), then repeat the request.',
  PERSISTENCE_FAILED: 'Retry when the host is available; the same operation ID resends the identical request.',
  PERSISTENCE_BACKPRESSURE: 'Let the host acknowledge queued events (retryPersistence or reconcile), then repeat the request.',
  WORKER_ERROR: 'Retry the operation; the last accepted result is kept. If the failure repeats, dispose the activity and prepare or restore it again.',
  WORKER_TIMEOUT: 'Retry the operation; the last accepted result is kept. If the timeout repeats, dispose the activity and prepare or restore it again.',
  UNSUPPORTED_ARTIFACT: 'Keep the original bytes; nothing is substituted. A verified 1.0 artifact can be shown read-only with archivalView(artifact, { audience }).',
  MIGRATION_REQUIRED: 'Convert the artifact with migrateArtifact (an explicit, registered migration), then restore the result.',
  INTEGRITY_FAILURE: 'Keep the original bytes and restore from another copy of the artifact or a portable host backup.',
  CANCELLED: 'Start the operation again if it is still wanted.',
  DISPOSED: 'Create a new adapter or prepare or restore the activity again; a disposed activity accepts no requests.',
  CONFLICT: 'Read the current state and retry if the request still applies.',
  OPERATION_CONFLICT: 'Use a new operation ID for a request with different arguments.',
  PREVIEW_ACTIVE: 'Commit or cancel the active preview first.',
  NOT_READY: 'Wait until the activity is open and ready (not suspended or closed), then retry.',
  RESOURCE_LIMIT: 'Make the request smaller or release resources (comparisons, open activities, positions), then retry.',
  RECEIPT_MISMATCH: 'Retry the request; the host must return a receipt for exactly this request, its revisions and content digests.',
  CAPTURE_REJECTED: 'Capture a committed, paused frame of a mounted surface, and only where the host policy allows capture (policy.export.capture).',
  INDEPENDENT_CONTEXT: 'Use only the tools the independent task permits, or reopen instructional work through the host (reopenInstructional).',
  NOT_FOUND: 'Use an ID from the current state, projection or capabilities.',
  DUPLICATE_ID: 'Give each item a unique ID.',
  KIND_MISMATCH: 'Reference an item of the kind this field requires.',
  UNIT_MISMATCH: 'Use a unit listed for this parameter or quantity, with the same dimension.',
  EQUATION_DISCLOSURE: 'Substitute only quantities whose groups are visible wherever the equation is visible.',
  MISSING_EQUIVALENT: 'Declare a non-visual alternative that covers this view or control.',
  NEVER_VISIBLE: 'Show the item in at least one stage, or remove it.',
  UNREFERENCED: 'Reference the declaration where it is meant to be used, or remove it.',
});

/** Fills a missing recovery from {@link HOST_RECOVERY}; diagnostics that carry their own recovery are unchanged. */
export function withHostRecovery(items: readonly Diagnostic[]): Diagnostic[] {
  return items.map(item => item.recovery ? item : { ...item, recovery: HOST_RECOVERY[item.code] ?? HOST_RECOVERY.INVALID_INPUT });
}

/** Learner-safe status text per UI state (report §10.4): a message and one clear recovery action where useful. */
export const UI_STATUS: Readonly<Record<UiState, { message: string | null; recovery: ProjectedStatus['recovery'] }>> = Object.freeze({
  empty: { message: 'Nothing is shown in this activity right now.', recovery: null },
  preparing: { message: 'Preparing the activity.', recovery: null },
  'awaiting-persistence': { message: 'Saving before anything new is shown.', recovery: { action: 'retry', label: 'Retry saving' } },
  ready: { message: null, recovery: null },
  'tentative-preview': { message: 'Previewing a change. It is not applied until you finish.', recovery: { action: 'commit-or-cancel', label: 'Apply or cancel the change' } },
  playing: { message: 'Playing.', recovery: null },
  paused: { message: 'Paused.', recovery: null },
  boundary: { message: 'The end of the available steps is reached.', recovery: null },
  undefined: { message: 'Some values are not defined for the current settings; they are marked rather than shown as zero.', recovery: null },
  clipped: { message: 'Some of the drawing lies outside the shown area. The values are still listed.', recovery: null },
  unsupported: { message: 'This activity is not available here.', recovery: { action: 'return', label: 'Return to the session' } },
  'recoverable-failure': { message: 'The last step did not complete. The previous result is still shown.', recovery: { action: 'retry', label: 'Try again' } },
  'stale-policy': { message: 'The permission for this activity changed or ended.', recovery: { action: 'reload', label: 'Reload the activity' } },
  suspended: { message: 'Paused while hidden. It continues at the same step when it is shown again.', recovery: null },
  restored: { message: 'Restored from a saved state. Playback is paused.', recovery: null },
  disposed: { message: 'This activity has been closed.', recovery: { action: 'return', label: 'Return to the session' } },
});

/**
 * Message of the `undefined` UI state by what the affected drawn values actually are (report §8.2, A11): mathematical
 * undefinedness, a numerical limit (overflow, underflow or iteration limit), or both. `ProjectedStatus.cause` names the
 * case so a surface can title it accordingly; none of them is ever shown as zero.
 */
export const VALUE_STATUS_TEXT: Readonly<Record<'undefined' | 'numerical-limit' | 'mixed', string>> = Object.freeze({
  undefined: UI_STATUS.undefined.message!,
  'numerical-limit': 'Some values are beyond the range that can be represented; they are marked as numerical limits rather than shown as numbers.',
  mixed: 'Some values are not defined for the current settings and some are beyond the range that can be represented; they are marked rather than shown as numbers.',
});

/** Notice when the newest preview value could not be evaluated: the preview shown is the last value that was evaluated. */
export const PREVIEW_REFUSED_NOTICE = 'The preview could not follow the latest value; it shows the last value that was evaluated. Move the control again, or apply or cancel the change.';

/**
 * Notice after playback stopped by itself one step before a numerical limit the projection shows (the limit frame stays
 * reachable by stepping); playback crosses a limit that is not shown, so this notice never describes a hidden value.
 */
export const PLAYBACK_LIMIT_NOTICE = 'Playback stopped before a value that cannot be represented (a numerical limit). Step forward to inspect it.';

/**
 * `recoverable-failure` after a worker timeout or crash once the bounded recovery attempts are used up (report §9):
 * the last accepted result stays shown, the notice is appended to the state message and `reload` replaces `retry`.
 */
export const WORKER_RECOVERY_EXHAUSTED: Readonly<{ notice: string; recovery: { action: 'reload'; label: string } }> = Object.freeze({
  notice: 'Trying again did not restore the calculation.',
  recovery: Object.freeze({ action: 'reload' as const, label: 'Reload the activity' }),
});

/**
 * Status message of a `suspended` activity that the host paused while its card may still be visible (suspend reason
 * `host`); `UI_STATUS.suspended` ("Paused while hidden") covers the visibility reasons (offscreen, collapsed, hidden).
 */
export const HOST_SUSPENDED_MESSAGE = 'Paused by the host. It continues at the same step when the host resumes it.';

/** Status message of an activity the host has closed (UI state `empty`); a surface titles the card as closed. */
export const CLOSED_MESSAGE = 'This activity is closed.';

/** Stage instruction projected in an independent-task context (the teaching instruction and prompt are withheld). */
export const INDEPENDENT_INSTRUCTION = 'Independent work: follow the task given in your session. Teaching content from this activity is not shown here.';

/**
 * Stage instruction projected while the activity cannot be used (report §5.3, §10.4): under a stale policy and for
 * unsupported (revoked) content the teaching instruction, the response prompt and any pending reveal are withheld, so
 * nothing invites work the activity cannot accept or promises content the host has not re-authorized.
 */
export const BLOCKED_INSTRUCTION: Readonly<Record<'stale-policy' | 'unsupported', string>> = Object.freeze({
  'stale-policy': 'This activity is waiting for the host. Nothing new is shown until the permissions are updated.',
  unsupported: 'This activity cannot be used here. Follow your session for what to do next.',
});

/** Fixed terminal descriptions; kernel detail text is never forwarded to the learner. */
export const TERMINAL_TEXT: Readonly<Record<'max-index' | 'numerical-limit' | 'end-time', string>> = Object.freeze({
  'max-index': 'The last available step is reached.',
  'numerical-limit': 'The next value cannot be represented; this is a numerical limit, not a computed value.',
  'end-time': 'The end time is reached.',
});

/**
 * Value text with its unit as a reader says it: degrees attach as `45°`, an iteration count reads `n = 700` (never
 * `700 iter`), other units follow after a space; undefined and limit texts carry no unit.
 */
export function valueWithUnit(value: Pick<ProjectedValue, 'text' | 'status' | 'unit' | 'unitLabel' | 'symbol'>): string {
  if (value.status !== 'valid' || !value.unitLabel) return value.text;
  if (value.unit === 'iteration') return `${value.symbol && /^[A-Za-z]$/.test(value.symbol) ? value.symbol : 'n'} = ${value.text}`;
  return value.unit === 'deg' ? `${value.text}°` : `${value.text} ${value.unitLabel}`;
}
const valueText = (value: ProjectedValue): string => `${value.label}: ${valueWithUnit(value)}${value.approximate ? ' (approximate)' : ''}`;
const MAX_SUMMARY = 2000;
const clip = (text: string): string => text.length > MAX_SUMMARY ? `${text.slice(0, MAX_SUMMARY - 1)}…` : text;

/** Observed points of a mark (report §8.5): how many rows, how many have a missing value, and that none are joined. */
function observedCount(mark: ProjectedView['marks'][number]): string {
  if (mark.geometry?.kind !== 'observations2') return '';
  const total = mark.geometry.points.length, missing = mark.geometry.points.filter(point => point.values[0] === null || point.values[1] === null).length;
  return `: ${total} observation${total === 1 ? '' : 's'}${missing ? `, ${missing} with a missing value (not drawn)` : ''}, drawn as separate points`;
}

/** Accessible summary of one projected view, generated from its projected content only. */
export function viewSummary(view: Omit<ProjectedView, 'summary'>): string {
  const parts = [`${view.title}.`];
  if (view.marks.length) parts.push(`Shows ${view.marks.map(mark => mark.undefinedReason ? `${mark.label} (not available)` : `${mark.label}${observedCount(mark)}`).join('; ')}.`);
  if (view.values.length) parts.push(`${view.values.map(valueText).join('; ')}.`);
  if (view.equations.length) parts.push(view.equations.map(equation => `${equation.label}: ${equation.plain}`).join('; ') + '.');
  if (view.table) parts.push(`Table with ${view.table.totalRows} row${view.table.totalRows === 1 ? '' : 's'}${view.table.truncated ? `, ${view.table.rows.length} listed` : ''}.`);
  return clip(parts.join(' '));
}

/** Plain-text description of the values the learner can currently see (controls, position and visible values). */
export function describeProjection(projection: LearnerProjection): string {
  const parts: string[] = [];
  if (projection.frame?.kind === 'tentative') parts.push('Previewing a change that is not yet applied.');
  for (const control of projection.controls) {
    const shown = control.previewValue ?? control.value;
    parts.push(`${control.label}: ${shown}${control.unitLabel ? ` ${control.unitLabel}` : ''}${control.mode === 'fixed' ? ' (fixed)' : ''}.`);
  }
  if (projection.navigation) {
    const nav = projection.navigation;
    parts.push(nav.kind === 'index' ? `Step ${nav.value}${nav.max !== null ? ` of ${nav.max}` : ''}.` : `Time ${nav.value}.`);
  }
  const seen = new Set<string>();
  for (const view of projection.views) for (const value of view.values) {
    if (seen.has(value.quantityId)) continue;
    seen.add(value.quantityId);
    parts.push(`${valueText(value)}.`);
  }
  if (!parts.length) return 'No values are shown right now.';
  return clip(parts.join(' '));
}
