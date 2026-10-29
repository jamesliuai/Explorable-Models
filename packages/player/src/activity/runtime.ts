/**
 * Surface runtime helpers without React: identifiers, rate-limited announcements and the preview gesture controller
 * that maps pointer/keyboard/exact gestures onto guarded binding commands (report §9, A39–A40).
 */
import type { ActivityBinding, CommandOutcome, Diagnostic, GestureKind, LearnerProjection, ProjectedStatus, UiState } from '@explorable-models/activity';
import { CLOSED_MESSAGE } from '@explorable-models/activity';
import { formatPosition } from './format.js';
import { presentStatus, PRESENTED_BY } from './status.js';

let counter = 0;
/** Random identifier matching the contract ID pattern (`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$`). */
export function randomId(prefix: string): string {
  const bytes = new Uint8Array(12);
  const crypto = (globalThis as { crypto?: Crypto }).crypto;
  if (crypto?.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = (Date.now() + counter * 7919 + i * 104729) % 256;
  counter++;
  return `${prefix}-${[...bytes].map(b => b.toString(16).padStart(2, '0')).join('')}`;
}
export const createSurfaceId = (): string => randomId('surface');
export const createOperationId = (): string => randomId('op');

export type AnnouncementKind = 'committed' | 'boundary' | 'error' | 'request';
const PRIORITY: Record<AnnouncementKind, number> = { committed: 0, boundary: 1, error: 2, request: 3 };
export interface Announcer {
  announce(text: string, kind: AnnouncementKind): void;
  /** Drops the pending message and forgets the last one (an identical message may be spoken again); the rate holds. */
  clear(): void;
  dispose(): void;
}

/**
 * Polite announcements at a controlled rate (report §11): committed changes, boundaries and errors at most one per
 * `minIntervalMs`, keeping only the highest-priority (then newest) pending message; learner requests ("read current
 * values") are spoken at once. Identical consecutive messages are not repeated. Nothing is emitted after dispose.
 */
export function createAnnouncer(options: { emit(text: string): void; minIntervalMs?: number; now?: () => number; setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (handle: unknown) => void }): Announcer {
  const interval = options.minIntervalMs ?? 1500;
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let last = -Infinity, lastText = '', pending: { text: string; kind: AnnouncementKind } | null = null, timer: unknown = null, disposed = false;
  const speak = (text: string) => { last = now(); lastText = text; options.emit(text); };
  const flush = () => { timer = null; if (disposed || !pending) return; const next = pending; pending = null; speak(next.text); };
  return {
    announce(text, kind) {
      const message = text.trim();
      if (disposed || !message) return;
      if (kind === 'request') { if (timer !== null) { clearTimer(timer); timer = null; } pending = null; speak(message); return; }
      if (message === lastText && now() - last < interval * 4) return;
      if (now() - last >= interval && timer === null) { speak(message); return; }
      if (!pending || PRIORITY[kind] >= PRIORITY[pending.kind]) pending = { text: message, kind };
      if (timer === null) timer = setTimer(flush, Math.max(0, last + interval - now()));
    },
    clear() { pending = null; lastText = ''; if (timer !== null) clearTimer(timer); timer = null; },
    dispose() { disposed = true; pending = null; if (timer !== null) clearTimer(timer); timer = null; },
  };
}

export interface Announcement { text: string; kind: AnnouncementKind }
/**
 * What {@link projectionAnnouncements} remembers between projections: the last committed frame that was shown, and the
 * status whose words were last announced (by a projection or by a refused command, {@link failureAnnouncement}), so one
 * status is put into words once however its projection and the refusal that caused it arrive.
 */
export interface AnnouncementMemory { committedFrameId: string | null; statusSaid?: string | null }
const isClosed = (projection: LearnerProjection): boolean => projection.status.ui === 'empty' && projection.status.message === CLOSED_MESSAGE;
/** Identity of a status as the learner hears it: its state, message and offered recovery. */
export const statusKey = (status: ProjectedStatus): string => JSON.stringify([status.ui, status.message, status.recovery?.action ?? null, status.recovery?.label ?? null]);
/** Recovery the card offers in place of trying again (`reload` once worker recovery is used up, `return`). */
const hostRecovery = (projection: LearnerProjection): string | null => {
  const presented = presentStatus(projection);
  return presented && presented.recoveryLabel && presented.actions.some(action => action === 'reload' || action === 'return') ? presented.recoveryLabel : null;
};
const sentences = (text: string | null | undefined): string[] => (text ?? '').split(/(?<=[.…])\s+/).map(item => item.trim()).filter(Boolean);
const asSentence = (label: string): string => /[.…!?]$/.test(label) ? label : `${label}.`;
/**
 * Words of a status whose offered recovery changed while its state stayed (for example worker recovery used up: the
 * card now offers Reload the activity instead of Try again): the status message and the action it offers.
 */
function recoveryWords(projection: LearnerProjection): string {
  const presented = presentStatus(projection);
  const label = presented?.actions.length ? presented.recoveryLabel : null;
  return [projection.status.message ?? presented?.title ?? 'The activity needs attention.', label ? asSentence(label) : null].filter(Boolean).join(' ');
}

/**
 * What a refused command announces (report §10.4, §11): `Not applied.`, the command's learner-safe message and how to
 * recover. The recovery never names an action the card no longer offers: when the card's status already presents the
 * refusal's cause (`PRESENTED_BY`, the rule that also hides the refusal's own banner) and offers a host action instead
 * of trying again (`reload` once worker recovery is used up, `return`), the announcement takes the status's own words —
 * its sentences the message has not said (unless the status was just announced) and its action — and records that
 * status as said in `memory`, so its projection does not announce it again.
 */
export function failureAnnouncement(diagnostic: { code: string; message: string; recovery?: string }, projection: LearnerProjection | null, memory?: AnnouncementMemory): string {
  const message = diagnostic.message.trim();
  const own = `Not applied. ${message}${diagnostic.recovery ? ` ${diagnostic.recovery.trim()}` : ''}`;
  if (!projection || !(PRESENTED_BY[diagnostic.code] ?? []).includes(projection.status.ui)) return own;
  const label = hostRecovery(projection);
  if (!label) return own;
  const key = statusKey(projection.status);
  const said = new Set(sentences(message));
  const rest = memory?.statusSaid === key ? [] : sentences(presentStatus(projection)?.message).filter(item => !said.has(item));
  if (memory) memory.statusSaid = key;
  return ['Not applied.', message, ...rest, asSentence(label)].filter(Boolean).join(' ');
}

/**
 * What the card announces when its projection changes (report §11: committed changes, relevant boundaries and actionable
 * errors at a controlled rate; never animation frames or tentative output):
 * - a card that opens restored says so once;
 * - nothing while playing or previewing;
 * - entering a recoverable failure, a stale policy or unsupported content (error); a terminal boundary, undefined values
 *   or clipped data (boundary); a host suspension, awaiting persistence, a restored, closed or disposed activity (once);
 * - a change of the recovery the status offers while its state stays (error): worker recovery used up says the status
 *   message and Reload the activity, which replaces Try again;
 * - the position once when playback pauses;
 * - a newly committed frame (`Updated: …`): compared with the last committed frame shown, so a preview that ends without a
 *   commit (Escape, pointer cancellation, a revoked policy) returns to the same frame and announces nothing;
 * - the projection's own live message when it changes; a new stage; entering independent work.
 * A status that a refused command has already put into words ({@link failureAnnouncement}) is not announced again.
 */
export function projectionAnnouncements(before: LearnerProjection | null, projection: LearnerProjection, memory: AnnouncementMemory, locale?: string): Announcement[] {
  const lastCommitted = memory.committedFrameId;
  if (projection.frame?.kind === 'committed') memory.committedFrameId = projection.frame.frameId;
  const ui = projection.status.ui;
  const message = projection.status.message;
  // Only the status still shown can count as said: any other status is announced afresh when it comes back.
  const key = statusKey(projection.status);
  const said = memory.statusSaid === key;
  memory.statusSaid = said ? key : null;
  if (!before) return ui === 'restored' ? [{ text: message ?? 'Restored from a saved state.', kind: 'committed' }] : [];
  if (ui === 'playing' || ui === 'tentative-preview') return [];
  const out: Announcement[] = [];
  const changedState = ui !== before.status.ui;
  const closed = isClosed(projection) && !isClosed(before);
  const recoveryChanged = !changedState && projection.status.recovery !== null && (projection.status.recovery?.action ?? null) !== (before.status.recovery?.action ?? null);
  // Entering a host suspension (not a visibility one: the card is out of view), awaiting persistence, restored, closed or
  // disposed is announced once; the announcer drops an identical repeat.
  const notable = closed || (changedState && ((ui === 'suspended' && /^Paused by the host/.test(message ?? '')) || ui === 'awaiting-persistence' || ui === 'restored' || ui === 'disposed'));
  const status = (text: string, kind: AnnouncementKind) => { if (!said) { out.push({ text, kind }); memory.statusSaid = key; } };
  if (changedState && (ui === 'recoverable-failure' || ui === 'stale-policy' || ui === 'unsupported')) status(message ?? 'The activity needs attention.', 'error');
  else if (recoveryChanged) status(recoveryWords(projection), 'error');
  else if (changedState && (ui === 'boundary' || ui === 'undefined' || ui === 'clipped')) out.push({ text: message ?? 'A boundary case is shown.', kind: 'boundary' });
  else if (notable) status(message ?? 'The activity is paused.', 'committed');
  // Pausing playback reads the position once (frames are never announced while playing).
  else if (before.status.ui === 'playing' && projection.navigation) out.push({ text: `Paused at ${formatPosition(projection.navigation, locale)}.`, kind: 'committed' });
  else if (projection.frame?.kind === 'committed' && projection.frame.frameId !== lastCommitted) {
    out.push({ text: projection.status.live ?? (projection.navigation ? `Updated: ${formatPosition(projection.navigation, locale)}.` : 'Updated.'), kind: 'committed' });
  } else if (projection.status.live && projection.status.live !== before.status.live) out.push({ text: projection.status.live, kind: 'committed' });
  if (projection.stage.id !== before.stage.id) out.push({ text: `New step: ${projection.stage.instruction}`, kind: 'committed' });
  else if (projection.context === 'independent' && before.context !== 'independent') out.push({ text: `Independent task. ${projection.stage.instruction}`, kind: 'committed' });
  return out;
}

/**
 * What an announcement could mention (report §6.2: live regions follow the same projection as every other learner
 * channel): the activity, stage, context and policy it was made under, whether the card showed content, and every view,
 * mark, value, equation and control the projection showed then.
 */
export interface LiveScope { key: string; shown: ReadonlySet<string> }
/** States without learner content: nothing announced earlier may remain in the live region. */
const WITHOUT_CONTENT: ReadonlySet<UiState> = new Set<UiState>(['empty', 'preparing', 'disposed', 'stale-policy', 'unsupported']);
export function liveScope(projection: LearnerProjection): LiveScope {
  const shown = new Set<string>();
  for (const view of projection.views) {
    shown.add(`view:${view.viewId}`);
    for (const mark of view.marks) shown.add(`mark:${mark.markId}`);
    for (const value of view.values) shown.add(`value:${value.quantityId}`);
    for (const equation of view.equations) shown.add(`equation:${equation.equationId}`);
  }
  for (const control of projection.controls) shown.add(`control:${control.parameter}`);
  const content = WITHOUT_CONTENT.has(projection.status.ui) ? 'none' : 'content';
  return { key: [projection.activityId, projection.stage.id, projection.context, projection.policyRevision, content].join('|'), shown };
}
/**
 * True while an announcement made under `announced` may stay in the live region: same activity, stage, context and
 * policy, content still shown, and nothing it could mention has left the projection (entering independent work, a stage
 * or policy change, closing or a narrower projection clears it; report §6.2, §6.4; A21, A25).
 */
export function scopeHolds(announced: LiveScope, current: LiveScope): boolean {
  if (announced.key !== current.key) return false;
  for (const id of announced.shown) if (!current.shown.has(id)) return false;
  return true;
}

export type CancelReason = 'escape' | 'pointercancel' | 'blur' | 'navigation' | 'revoked' | 'superseded';

/**
 * Gesture completions of one surface that are still in flight (report §9 steps 1 and 4). A gesture that begins while
 * an earlier completion is committing waits for it, then starts its preview from the newly committed state, so a
 * learner who presses again during a slow commit keeps the live preview and never commits a draft against a state
 * that is about to change. Every surface owns one lane; all its sliders and draggable points share it.
 */
export class GestureLane {
  private readonly pending = new Set<Promise<void>>();
  private readonly waiters: (() => void)[] = [];
  private readonly listeners = new Set<() => void>();
  /** A completion is committing. */
  get busy(): boolean { return this.pending.size > 0; }
  /** Tracks one completion; the lane is idle again once every tracked completion has settled. */
  track<T>(promise: Promise<T>): Promise<T> {
    const settled = promise.then(() => undefined, () => undefined);
    this.pending.add(settled);
    if (this.pending.size === 1) this.changed();
    void settled.then(() => {
      this.pending.delete(settled);
      if (this.pending.size) return;
      for (const waiter of this.waiters.splice(0)) waiter();
      this.changed();
    });
    return promise;
  }
  /** Resolves when no completion is in flight (at once when idle). */
  idle(): Promise<void> { return this.busy ? new Promise(resolve => { this.waiters.push(resolve); }) : Promise.resolve(); }
  /** Called when the lane turns busy or idle. */
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed(): void { for (const listener of [...this.listeners]) { try { listener(); } catch { /* A listener cannot affect the lane. */ } } }
}

export interface GestureHooks {
  /** Failed command diagnostics (learner-safe messages from the binding). */
  onFailure(diagnostics: Diagnostic[]): void;
  isDisposed(): boolean;
  operationId?: () => string;
  /** The surface's completion lane; without one a gesture never waits. */
  lane?: GestureLane;
}
/**
 * `idle` → `waiting` (an earlier completion of this surface is committing) → `previewing` (an identified tentative
 * preview) or `draft` (no preview is authorized: values stay local until completion) → `idle`. `ended`: the activity
 * moved on under the gesture (its preview ended elsewhere: navigation, a stage change, a revoked policy, another
 * surface; for a draft, the stage, context, policy or run changed; or the card became inert). An ended gesture stays
 * held until its own completion or cancel event and then commits nothing.
 */
export type GestureState = 'idle' | 'waiting' | 'previewing' | 'draft' | 'ended';

/**
 * UI states in which the card is inert (report §10.2, §10.4, §11): every scientific action is unavailable, shown
 * `aria-disabled` with a visible reason, and an unfinished gesture ends without committing.
 */
export const INERT_STATES: ReadonlySet<UiState> = new Set<UiState>(['suspended', 'stale-policy', 'unsupported', 'awaiting-persistence', 'disposed']);

const failure = (error: unknown): Diagnostic[] => [{ code: 'INVALID_INPUT', path: '$', message: error instanceof Error ? error.message : 'The command could not be completed.' }];

/** What a gesture started from: a change of any of these means the gesture no longer applies. */
interface GestureBasis { stage: string; context: LearnerProjection['context']; policyRevision: number; runId: string | null }
const basisOf = (projection: LearnerProjection): GestureBasis => ({ stage: projection.stage.id, context: projection.context, policyRevision: projection.policyRevision, runId: projection.guards.expectedRunId });
const movedOn = (basis: GestureBasis, projection: LearnerProjection): boolean => {
  const now = basisOf(projection);
  return now.stage !== basis.stage || now.context !== basis.context || now.policyRevision !== basis.policyRevision || now.runId !== basis.runId;
};

/**
 * One parameter gesture (report §9). `begin` asks the binding for a tentative preview from the exact committed state;
 * when the stage or policy does not allow previews it falls back to a local draft that is committed once on
 * completion (`commitParameters` with the gesture's own kind as provenance), so the control still works without
 * showing tentative frames. Pointer, keyboard and drag gestures keep distinct semantics: the caller decides when the
 * gesture completes (pointer up / key up / Enter) or is cancelled (Escape, pointer cancel, lost capture, blur).
 *
 * A gesture never commits against a state it did not start from: when its preview ends elsewhere, a draft's stage,
 * context, policy or run changes, or the card becomes inert, the gesture becomes `ended` and its completion commits
 * nothing (A40).
 */
export class PreviewGesture {
  state: GestureState = 'idle';
  previewId: string | null = null;
  /** Latest gesture values in display units (one parameter for controls; x and y for a dragged point). */
  values: Record<string, number> | null = null;
  gesture: GestureKind | null = null;
  /** The latest value of the current gesture was refused (its explanation should stay visible after the gesture ends). */
  rejected = false;
  private basis: GestureBasis | null = null;
  /** A completion requested while the gesture was still waiting; it runs right after the preview starts. */
  private completion: { committed: Record<string, number>; resolve: (outcome: CommandOutcome | null) => void } | null = null;
  /** Invalidates a pending start of a waiting gesture that was completed, cancelled or reset meanwhile. */
  private epoch = 0;

  constructor(private readonly binding: ActivityBinding, readonly parameter: string, private readonly hooks: GestureHooks) {}

  private op(): string { return this.hooks.operationId?.() ?? createOperationId(); }
  private reset(): void {
    this.state = 'idle'; this.previewId = null; this.values = null; this.gesture = null; this.basis = null; this.epoch++;
    const completion = this.completion;
    this.completion = null;
    completion?.resolve(null);
  }
  private run<T extends CommandOutcome>(fn: () => T): T | null {
    try { return fn(); } catch (error) { this.hooks.onFailure(failure(error)); return null; }
  }
  /** Ends the gesture; one that was already released while waiting has nothing left to hold and becomes idle. */
  private end(): void {
    if (this.completion) { this.reset(); return; }
    this.state = 'ended'; this.previewId = null; this.values = null; this.basis = null;
  }

  get active(): boolean { return this.state !== 'idle'; }

  begin(gesture: GestureKind): void {
    if (this.active || this.hooks.isDisposed()) return;
    this.gesture = gesture;
    this.rejected = false;
    const lane = this.hooks.lane;
    if (lane?.busy) {
      // Pressed again while an earlier completion commits: follow the input locally and start the preview from the
      // state that commit produces.
      this.state = 'waiting';
      this.startWhenIdle(lane, this.epoch);
      return;
    }
    this.start();
  }

  private startWhenIdle(lane: GestureLane, epoch: number): void {
    void lane.idle().then(() => {
      if (this.epoch !== epoch || this.state !== 'waiting') return;
      if (lane.busy) this.startWhenIdle(lane, epoch); else this.start();
    });
  }

  private start(): void {
    if (this.hooks.isDisposed()) { this.reset(); return; }
    const projection = this.binding.getProjection();
    this.basis = basisOf(projection);
    const outcome = this.run(() => this.binding.beginPreview({ operationId: this.op(), ...projection.guards, gesture: this.gesture!, parameter: this.parameter }));
    const preview = outcome?.ok ? (outcome.projection.preview ?? this.binding.getProjection().preview) : null;
    if (preview && preview.parameter === this.parameter) { this.state = 'previewing'; this.previewId = preview.previewId; }
    else this.state = 'draft';
    // A gesture that waited replays its latest values, then a completion requested while it waited.
    if (this.state === 'previewing' && this.values) this.send(this.values);
    const completion = this.completion;
    if (completion) { this.completion = null; void this.commit(completion.committed).then(completion.resolve); }
  }

  private send(values: Record<string, number>): void {
    const outcome = this.run(() => this.binding.updatePreview({ operationId: this.op(), previewId: this.previewId!, displayValues: { ...values } }));
    if (outcome && !outcome.ok) {
      // The preview ended elsewhere (navigation, revoked policy, another surface): this gesture no longer applies.
      if (this.binding.getProjection().preview?.previewId !== this.previewId) this.end();
      else { this.rejected = true; this.hooks.onFailure(outcome.diagnostics); }
    } else if (outcome) this.rejected = false;
  }

  /** A number updates the gesture's parameter; a record updates several parameters (a dragged point). */
  update(value: number | Record<string, number>): void {
    const values = typeof value === 'number' ? { [this.parameter]: value } : value;
    if (!this.active || this.state === 'ended' || this.hooks.isDisposed() || !Object.values(values).every(Number.isFinite)) return;
    this.values = { ...values };
    if (this.state === 'previewing' && this.previewId) this.send(this.values);
  }

  /**
   * Checks the gesture against the latest projection: a preview that ended elsewhere, a draft whose stage, context,
   * policy or run changed, or a card that became inert (suspended, stale policy, unsupported, awaiting persistence,
   * disposed) ends the gesture; a preview still open in the binding is cancelled (`superseded`). Returns true when
   * this call ended it.
   */
  sync(projection: LearnerProjection): boolean {
    if (this.state === 'previewing' && projection.preview?.previewId !== this.previewId) { this.end(); return true; }
    if (this.state !== 'draft' && this.state !== 'previewing' && this.state !== 'waiting') return false;
    if (!INERT_STATES.has(projection.status.ui) && !(this.basis && movedOn(this.basis, projection))) return false;
    const previewId = this.state === 'previewing' ? this.previewId : null;
    this.end();
    this.epoch++;
    if (previewId && !this.hooks.isDisposed()) this.run(() => this.binding.cancelPreview({ operationId: this.op(), previewId, reason: 'superseded' }));
    return true;
  }

  /**
   * Completes the gesture: commits the preview, or commits draft values that differ from `committed`. A waiting
   * gesture completes as soon as its preview has started; an ended gesture commits nothing.
   */
  async commit(committed: Record<string, number> = {}): Promise<CommandOutcome | null> {
    if (!this.active || this.hooks.isDisposed()) { this.reset(); return null; }
    if (this.state === 'waiting') {
      if (this.completion) return null;
      return new Promise(resolve => { this.completion = { committed, resolve }; });
    }
    const projection = this.binding.getProjection();
    this.sync(projection);
    const { state, previewId, values, gesture } = this;
    this.reset();
    if (state === 'ended') return null;
    let pending: Promise<CommandOutcome> | null = null;
    try {
      if (state === 'previewing' && previewId) pending = this.binding.commitPreview({ operationId: this.op(), ...projection.guards, previewId });
      else if (values && Object.entries(values).some(([key, value]) => committed[key] !== value)) {
        pending = this.binding.commitParameters({ operationId: this.op(), ...projection.guards, displayValues: values, ...(gesture ? { gesture } : {}) });
      }
    } catch (error) { if (!this.hooks.isDisposed()) this.hooks.onFailure(failure(error)); return null; }
    if (!pending) return null;
    this.hooks.lane?.track(pending);
    let outcome: CommandOutcome;
    try { outcome = await pending; } catch (error) { if (!this.hooks.isDisposed()) this.hooks.onFailure(failure(error)); return null; }
    if (!outcome.ok && !this.hooks.isDisposed()) this.hooks.onFailure(outcome.diagnostics);
    return outcome;
  }

  /** Cancels the gesture; a preview is reverted by the binding (exposure already recorded is kept by the adapter). */
  cancel(reason: CancelReason): void {
    if (!this.active) return;
    const { state, previewId } = this;
    this.reset();
    if (state === 'previewing' && previewId && !this.hooks.isDisposed()) {
      const outcome = this.run(() => this.binding.cancelPreview({ operationId: this.op(), previewId, reason }));
      if (outcome && !outcome.ok && this.binding.getProjection().preview?.previewId === previewId) this.hooks.onFailure(outcome.diagnostics);
    }
  }
}
