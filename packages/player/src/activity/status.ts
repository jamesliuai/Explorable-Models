/**
 * Learner-facing presentation of every `UiState` by its cause (report §10.4): a calm title that never contradicts the
 * message, the projection's learner-safe message (or a neutral default), a tone that matches the cause and is carried by
 * both colour and a glyph, and at most one recovery control. No state ever shows a stack trace or an internal
 * identifier.
 *
 * Placement keeps the card still while the learner works (report §10.1, §11):
 * - `banner` states need attention or action and are shown above the content (failures, saving, permissions, pauses,
 *   boundaries, undefined values, a 3D view whose data leave its box);
 * - `inline` states are transient or already shown in place — a tentative preview (the figures are dashed and the
 *   controls say “preview”), playback (the navigation shows Pause), out-of-view data of a 2D figure (each figure has its
 *   own indicator with Inspect values and Fit to data) and a routine notice — so nothing is inserted above a control
 *   that is being dragged, stepped with the keyboard or toggled between Play and Pause.
 */
import type { LearnerProjection, ProjectedStatus, UiState } from '@experiment-kit/activity';
import { CLOSED_MESSAGE, TERMINAL_TEXT } from '@experiment-kit/activity';

export type Tone = 'info' | 'success' | 'warning' | 'error' | 'neutral';
export type RecoveryAction = 'retry' | 'commit' | 'cancel' | 'return' | 'reload';
/**
 * Why the card is in its state. `awaiting-persistence` has five causes that need different words and actions: a reveal
 * being recorded (`saving-reveal`, nothing to retry), a reveal the host did not record (`reveal-not-saved`), journal
 * events waiting to be sent again (`journal-not-saved`), a failed journal (`journal-failed`) and a display
 * acknowledgement the host has not confirmed (`display-not-recorded`).
 */
export type StatusCause =
  | 'empty' | 'closed' | 'preparing' | 'saving-reveal' | 'reveal-not-saved' | 'journal-not-saved' | 'journal-failed' | 'display-not-recorded'
  | 'ready' | 'preview' | 'playing' | 'paused' | 'end-of-steps' | 'numerical-limit' | 'end-time' | 'undefined' | 'clipped' | 'unsupported'
  | 'failure' | 'stale-policy' | 'paused-by-host' | 'paused-while-hidden' | 'restored' | 'disposed';
export interface StatusPresentation {
  state: UiState;
  cause: StatusCause;
  placement: 'banner' | 'inline';
  tone: Tone;
  glyph: string;
  title: string;
  message: string | null;
  /** At most one recovery control (`commit` and `cancel` together decide one preview). */
  actions: RecoveryAction[];
  recoveryLabel: string | null;
}
/** What `presentStatus` reads: the status plus the content it describes. */
export type StatusSource = Pick<LearnerProjection, 'status' | 'pendingReveal'> & { views?: Pick<LearnerProjection['views'][number], 'kind' | 'clipped'>[] };

const GLYPH: Record<Tone, string> = { info: 'i', success: '✓', warning: '!', error: '×', neutral: '•' };

interface Preset { tone: Tone; title: string; message?: string | null; placement?: 'inline'; action?: RecoveryAction | 'commit-or-cancel'; label?: string }
const PRESETS: Record<StatusCause, Preset | null> = {
  empty: { tone: 'neutral', title: 'Nothing is shown in this activity right now' },
  closed: { tone: 'neutral', title: 'This activity is closed' },
  preparing: { tone: 'info', title: 'Preparing the activity…' },
  'saving-reveal': { tone: 'info', title: 'Saving before showing the next part…', message: 'The host is recording this step first. What you see stays as it is until then.' },
  'reveal-not-saved': { tone: 'warning', title: 'Not saved yet', message: 'The host could not record this step, so the next part is not shown. Nothing else has changed.', action: 'retry', label: 'Try again' },
  'journal-not-saved': { tone: 'warning', title: 'Not saved yet', message: 'Recent changes are kept here and will be sent to the host again.', action: 'retry', label: 'Retry saving' },
  'journal-failed': { tone: 'error', title: 'Not saved', message: 'The host could not record recent changes. They are kept here.', action: 'retry', label: 'Try again' },
  'display-not-recorded': { tone: 'warning', title: 'Not saved yet', message: 'The host has not confirmed that the last change was shown. It will be sent again.', action: 'retry', label: 'Retry saving' },
  ready: null,
  preview: { tone: 'info', title: 'Previewing a change, not applied yet', message: 'Release the control or press Enter to apply it; press Escape to cancel.', placement: 'inline', action: 'commit-or-cancel' },
  playing: null,
  paused: null,
  'end-of-steps': { tone: 'info', title: 'End of the available steps' },
  'numerical-limit': { tone: 'warning', title: 'Numerical limit reached' },
  'end-time': { tone: 'info', title: 'End time reached' },
  undefined: { tone: 'warning', title: 'Some values are undefined here' },
  clipped: { tone: 'warning', title: 'Some of the drawing is outside the view' },
  unsupported: { tone: 'warning', title: 'This activity is not available here', action: 'return', label: 'Return to the session' },
  failure: { tone: 'error', title: 'The last step did not complete', action: 'retry', label: 'Try again' },
  'stale-policy': { tone: 'warning', title: 'Permissions changed', action: 'reload', label: 'Reload the activity' },
  'paused-by-host': { tone: 'neutral', title: 'Paused by the host' },
  'paused-while-hidden': { tone: 'neutral', title: 'Paused while hidden' },
  restored: { tone: 'success', title: 'Restored from a saved state' },
  disposed: { tone: 'neutral', title: 'This activity has been closed', action: 'return', label: 'Return to the session' },
};
/** Titles of the `undefined` state by what the affected drawn values are (`status.cause`). */
const UNDEFINED_TITLES: Record<NonNullable<ProjectedStatus['cause']>, string> = {
  undefined: 'Some values are undefined here',
  'numerical-limit': 'Some values are beyond the representable range',
  mixed: 'Some values are undefined or beyond the representable range',
};
/** Routine sentences of the fixed vocabulary (activity `UI_STATUS`) that the state already says; only a notice after them is shown. */
const ROUTINE: Partial<Record<UiState, RegExp>> = { playing: /^Playing\.\s*/, paused: /^Paused\.\s*/, ready: /^$/ };
/** Leading reason sentence of a suspended card's message (activity `HOST_SUSPENDED_MESSAGE` / `UI_STATUS.suspended`). */
const SUSPENDED_REASON = /^Paused (by|while) [^.]{1,40}\.\s*/;
const sentence = (text: string): string => text.trim().replace(/[.…]+$/, '').toLowerCase();

/** The cause of the current state (see {@link StatusCause}). */
export function statusCause(source: StatusSource): StatusCause {
  const { status } = source;
  switch (status.ui) {
    case 'empty': return status.message === CLOSED_MESSAGE ? 'closed' : 'empty';
    case 'awaiting-persistence': {
      const pending = source.pendingReveal?.state;
      if (status.persistence === 'failed') return 'journal-failed';
      if (pending === 'failed') return 'reveal-not-saved';
      if (status.persistence === 'pending-recovery') return 'journal-not-saved';
      if (pending === 'requesting') return 'saving-reveal';
      return 'display-not-recorded';
    }
    case 'tentative-preview': return 'preview';
    // `status.cause` names a numerical-limit end even when a notice follows the terminal sentence.
    case 'boundary': return status.cause === 'numerical-limit' || status.message === TERMINAL_TEXT['numerical-limit'] ? 'numerical-limit' : status.message === TERMINAL_TEXT['end-time'] ? 'end-time' : 'end-of-steps';
    case 'recoverable-failure': return 'failure';
    case 'suspended': return status.message && /^Paused by /.test(status.message) ? 'paused-by-host' : 'paused-while-hidden';
    default: return status.ui;
  }
}

/** Presentation of the projection's state, or null when the state needs no words at all. */
export function presentStatus(source: StatusSource): StatusPresentation | null {
  const { status } = source;
  const cause = statusCause(source);
  const preset = PRESETS[cause];
  // A routine sentence the state already conveys is dropped; anything after it is a notice worth showing.
  const routine = ROUTINE[status.ui];
  let message = status.message;
  if (routine && message) message = message.replace(routine, '').trim() || null;
  if (!preset && !message) return null;
  let title = preset?.title ?? 'Note';
  if (cause === 'undefined' && status.cause) title = UNDEFINED_TITLES[status.cause];
  // The projection's message is the authority on what happened; a leading sentence that repeats the title is dropped
  // (and a suspended card's reason sentence becomes the title), so the title and the message never disagree.
  if (message && (cause === 'paused-by-host' || cause === 'paused-while-hidden')) {
    const reason = SUSPENDED_REASON.exec(message);
    if (reason) { title = reason[0].trim().replace(/\.$/, ''); message = message.slice(reason[0].length).trim() || null; }
  }
  if (message) {
    const [first, ...rest] = message.split(/(?<=[.…])\s+/);
    if (first !== undefined && sentence(first) === sentence(title)) message = rest.join(' ').trim() || null;
  }
  // Causes with their own words (the persistence causes) keep them; the projection's generic sentence would mislead.
  if (preset?.message !== undefined && (status.ui === 'awaiting-persistence' || status.ui === 'tentative-preview')) {
    const notice = status.ui === 'tentative-preview' ? noticeAfter(status.message) : null;
    message = [preset.message, notice].filter(Boolean).join(' ') || null;
  }
  if (cause === 'reveal-not-saved' || cause === 'saving-reveal') {
    const labels = source.pendingReveal?.labels ?? [];
    if (labels.length) message = cause === 'saving-reveal'
      ? `The host is recording this step before showing ${list(labels)}. What you see stays as it is until then.`
      : `The host could not record this step, so ${list(labels)} ${labels.length === 1 ? 'is' : 'are'} not shown yet. Nothing else has changed.`;
  }
  const tone = preset?.tone ?? 'neutral';
  // One recovery control per state, chosen by cause (an in-flight save offers none). The projection decides when retrying
  // is no longer accepted: after the bounded worker recoveries are used up it offers `reload` (or a host `return`) in
  // place of `retry`, and the card then offers that action with the projection's words, never a refused Try again.
  let action = preset?.action ?? null;
  let label = preset?.label ?? null;
  const projected = status.recovery;
  if (action === 'retry' && projected && (projected.action === 'reload' || projected.action === 'return')) { action = projected.action; label = projected.label; }
  const actions: RecoveryAction[] = !action ? [] : action === 'commit-or-cancel' ? ['commit', 'cancel'] : [action];
  const recoveryLabel = action ? label ?? status.recovery?.label ?? null : null;
  const placement: StatusPresentation['placement'] = preset?.placement === 'inline' || inlineState(source, cause) ? 'inline' : 'banner';
  return { state: status.ui, cause, placement, tone, glyph: GLYPH[tone], title, message, actions, recoveryLabel };
}

/** Notice appended to the fixed tentative-preview sentence (for example a clamp during a pointer preview). */
function noticeAfter(message: string | null): string | null {
  if (!message) return null;
  const fixed = 'Previewing a change. It is not applied until you finish.';
  return message.startsWith(fixed) ? message.slice(fixed.length).trim() || null : null;
}
const list = (labels: readonly string[]): string => labels.length <= 1 ? labels[0] ?? '' : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
/**
 * States shown in place rather than above the content: playback and pauses with a notice, and data outside a 2D figure,
 * which each figure reports itself with its own actions. Out-of-box data of a 3D view (no figure indicator) keep the
 * banner.
 */
function inlineState(source: StatusSource, cause: StatusCause): boolean {
  if (cause === 'playing' || cause === 'paused' || cause === 'ready') return true;
  if (cause === 'clipped') return !(source.views ?? []).some(view => view.clipped && view.kind === 'scene3d');
  return false;
}

/**
 * Persistence chip state that agrees with the banner: a reveal being recorded reads `saving`, a reveal or display
 * acknowledgement the host has not recorded reads `pending-recovery`, never `saved`.
 */
export function chipPersistence(source: StatusSource): ProjectedStatus['persistence'] {
  const { persistence } = source.status;
  if (persistence === 'failed' || persistence === 'pending-recovery') return persistence;
  if (source.pendingReveal?.state === 'failed') return 'pending-recovery';
  if (source.status.ui === 'awaiting-persistence' && statusCause(source) === 'display-not-recorded') return 'pending-recovery';
  if (source.pendingReveal?.state === 'requesting') return 'saving';
  return persistence;
}

export const PERSISTENCE_TEXT: Record<ProjectedStatus['persistence'], { label: string; tone: Tone; glyph: string; detail: string }> = {
  saved: { label: 'Saved', tone: 'success', glyph: '✓', detail: 'Everything shown here has been recorded by the host.' },
  saving: { label: 'Saving…', tone: 'info', glyph: '…', detail: 'The host is recording recent changes.' },
  'pending-recovery': { label: 'Not saved yet', tone: 'warning', glyph: '!', detail: 'Recent changes are kept here and will be sent again.' },
  failed: { label: 'Not saved', tone: 'error', glyph: '×', detail: 'The host could not record recent changes. They are kept here; the host needs to act.' },
};

export const PENDING_REVEAL_TEXT: Record<NonNullable<LearnerProjection['pendingReveal']>['state'], string> = {
  requesting: 'Waiting for the host to record this before showing it',
  'awaiting-display': 'Showing',
  failed: 'Could not record this yet, so it is not shown',
};

/** States in which the card shows only its heading and status (nothing to interact with). */
export const CONTENTLESS_STATES: ReadonlySet<UiState> = new Set<UiState>(['empty', 'preparing', 'disposed']);

/**
 * Diagnostic codes of a refused command whose cause the card already presents in its status (a worker failure, saving,
 * permissions, closing), mapped to the states that present them: the command's own error banner is then not repeated.
 */
export const PRESENTED_BY: Readonly<Record<string, readonly UiState[]>> = Object.freeze({
  WORKER_ERROR: ['recoverable-failure'], WORKER_TIMEOUT: ['recoverable-failure'],
  PERSISTENCE_PENDING: ['awaiting-persistence', 'recoverable-failure'], PERSISTENCE_FAILED: ['awaiting-persistence', 'recoverable-failure'],
  PERSISTENCE_BACKPRESSURE: ['awaiting-persistence', 'recoverable-failure'],
  POLICY_DENIED: ['stale-policy', 'unsupported'], POLICY_EXPIRED: ['stale-policy', 'unsupported'], STALE_POLICY_REVISION: ['stale-policy'],
  CONTENT_REVOKED: ['unsupported', 'stale-policy'], REVIEW_UNVERIFIED: ['unsupported', 'stale-policy'],
  DISPOSED: ['disposed'], NOT_READY: ['suspended', 'preparing', 'awaiting-persistence', 'disposed', 'empty'],
});
