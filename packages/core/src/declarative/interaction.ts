/**
 * Document interaction controller (report §9, §18; architecture D11, W08). The supported form of the primary/scratch
 * pattern that the examples used to carry privately:
 *
 * - The **primary** session holds the committed experiment. During a gesture it is marked tentative
 *   (`previewParameters`), so it cannot be exported or mutated by another path, and only the declared completion
 *   gesture (`commit`) creates one new primary run with fresh guards.
 * - A **scratch** session (one retained run) evaluates the tentative values. Scratch runs are never exported and never
 *   become the committed experiment; the displayed tentative frame is identified by `{ previewId, sequence }`.
 * - Previews go through `createPreviewCoordinator` (`@experiment-kit/core/model`): at most one active scratch
 *   evaluation plus one newest queued value; superseded values are dropped; commit, cancel, seek, suspension and
 *   disposal start a new epoch so a stale reply can never replace a later commit or a restored state.
 * - Optional shared worker budget: every session evaluator runs under a lease (`primary` or `scratch`) from a
 *   `WorkerBudget`. The lease is a counting authority for one worker slot; the controller's own document worker runs
 *   under it and is terminated before the lease is released. The lease's model evaluator is never used.
 * - Suspension (offscreen, collapsed, hidden or host request): pauses playback, cancels the preview (the committed
 *   frame is shown again), terminates the scratch worker and releases its lease, and releases the primary worker as
 *   soon as it is idle. Resume stays paused at the declared position: there is no wall-clock catch-up, and workers
 *   are acquired again only when the next evaluation needs one.
 * - After `dispose()` no listener runs and no late reply becomes visible.
 *
 * Commands are ignored (state unchanged) while the controller is disposed, suspended or committing; read
 * `getSnapshot()` for the reason. The controller is DOM-free apart from the default browser worker factory.
 */
import { createVisualizationSession } from '../declarative-session.js';
import { createPreviewCoordinator } from '../model/preview.js';
import type { WorkerBudget } from '../model/budget.js';
import { createDocumentEvaluator } from './worker.js';
import { DocumentError } from './types.js';
import type { Diagnostic, DocumentArtifact, DocumentEvaluator, MutationGuard, SessionState, VisualizationDocument, VisualizationSession } from './types.js';

export type InteractionLeasePurpose = 'primary' | 'scratch';
/** Structural subset of `WorkerBudget` from `@experiment-kit/core/model`; any shared budget instance satisfies it. */
export type InteractionBudget = Pick<WorkerBudget, 'acquire'>;

export interface DocumentInteractionOptions {
  /** Worker factory for the controller's document evaluators (default: the bundled document worker). */
  workerFactory?: () => Worker;
  /** Trusted host/test seam replacing the worker-backed evaluator of each session. */
  evaluatorFactory?: (purpose: InteractionLeasePurpose) => DocumentEvaluator;
  /** Shared worker budget across controllers (and activities). Without it each controller owns at most two workers. */
  budget?: InteractionBudget;
  /** Lease owner ID (default `interaction:<uuid>`); must match `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$`. */
  ownerId?: string;
  /** Retained primary runs (default and maximum 10). */
  maxRuns?: number;
  /** Preview IDs and operation IDs (default `crypto.randomUUID`). */
  idFactory?: () => string;
  /** Origin recorded on every guarded mutation (default `human`). */
  origin?: NonNullable<MutationGuard['origin']>;
}

/** Identity of the frame on screen: the committed primary run, or one identified tentative frame of a preview. */
export type DisplayedFrame =
  | { kind: 'committed'; runId: string; version: number }
  | { kind: 'tentative'; previewId: string; sequence: number; baseRunId: string };

export interface InteractionState {
  /** Session state of the displayed frame: the committed primary state, or the scratch state of the tentative frame. */
  rendered: SessionState;
  displayed: DisplayedFrame;
  /** Committed parameters, or the tentative values of the active gesture. */
  parameters: Record<string, number>;
  previewing: boolean;
  /** Identifier of the active gesture; null when no preview is active. */
  previewId: string | null;
  /** Tentative time of a time-scrub preview. */
  previewTime: number | null;
  /** A commit or seek is being evaluated; the shown frame stays until its outcome. */
  saving: boolean;
  suspended: boolean;
  disposed: boolean;
  /** Learner-readable message of the last failure; the last accepted state is retained. */
  error: string | null;
  diagnostics: Diagnostic[] | null;
}

export interface InteractionStats {
  /** Evaluation requests issued per session since creation (worker requests when worker-backed). */
  evaluations: Record<InteractionLeasePurpose, number>;
  /** Whether each session currently holds an evaluator (and its lease when budgeted). */
  holding: Record<InteractionLeasePurpose, boolean>;
  preview: { epoch: number; running: boolean; queued: boolean };
}

export interface DocumentInteractionController {
  readonly ownerId: string;
  getSnapshot(): InteractionState;
  /** `useSyncExternalStore`-compatible subscription. */
  subscribe(listener: () => void): () => void;
  /** Tentative parameter values (pointer/keyboard gesture). Never creates a primary run. */
  preview(updates: Record<string, number>): void;
  /** Tentative time scrub of the committed run. */
  previewTime(time: number): void;
  /** Completion gesture: commits the preview (or `updates`) as one new primary run, or seeks to the scrubbed time. */
  commit(updates?: Record<string, number>): Promise<void>;
  /** Escape / pointer cancellation: restores the committed frame and discards stale replies. */
  cancel(): void;
  seek(time: number): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  togglePlay(): Promise<void>;
  step(): Promise<void>;
  /** Restores the document's default parameters as a new run (history is kept). */
  reset(): Promise<void>;
  suspend(): void;
  resume(): void;
  inspect(): { primary: SessionState; displayed: SessionState; scratch: SessionState | null; stats: InteractionStats };
  /** Committed experiment only; refused while a preview is active. */
  exportDocument(): DocumentArtifact;
  dispose(): void;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const documentError = (code: string, message: string, recovery?: string) => new DocumentError([{ code, path: '$', message, ...(recovery ? { recovery } : {}) }]);
/** Budget failures (ModelError) keep their stable codes as document diagnostics. */
function asDocumentError(error: unknown): unknown {
  if (error instanceof DocumentError) return error;
  const diagnostics = (error as { diagnostics?: unknown } | null)?.diagnostics;
  return Array.isArray(diagnostics) && diagnostics.length ? new DocumentError(diagnostics as Diagnostic[]) : error;
}
const sameValues = (a: Record<string, number>, b: Record<string, number>) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.is(a[key], b[key]));

interface LeasedEvaluator extends DocumentEvaluator {
  /** Terminates the worker and releases the lease now (in-flight work rejects), or once idle with `whenIdle`. */
  release(whenIdle?: boolean): void;
  readonly holding: boolean;
  readonly requests: number;
}

/** Session evaluator that acquires its worker slot lazily and gives it back on release. */
function leasedEvaluator(purpose: InteractionLeasePurpose, ownerId: string, options: DocumentInteractionOptions): LeasedEvaluator {
  let inner: DocumentEvaluator | null = null, lease: { release(): void } | null = null;
  let acquiring: Promise<DocumentEvaluator> | null = null, cancelAcquire: AbortController | null = null;
  let generation = 0, pending = 0, requests = 0, releaseWhenIdle = false, disposed = false;
  const create = (): DocumentEvaluator => options.evaluatorFactory ? options.evaluatorFactory(purpose) : createDocumentEvaluator(options.workerFactory);
  function acquire(): Promise<DocumentEvaluator> {
    if (inner) return Promise.resolve(inner);
    if (!acquiring) {
      const current = generation, controller = new AbortController();
      cancelAcquire = controller;
      acquiring = (async () => {
        const granted = options.budget ? await options.budget.acquire(ownerId, purpose, controller.signal) : null;
        if (current !== generation || disposed) { granted?.release(); throw documentError('CANCELLED', 'The worker lease is no longer needed.'); }
        lease = granted;
        inner = create();
        return inner;
      })().catch(error => { throw asDocumentError(error); }).finally(() => { if (current === generation) { acquiring = null; cancelAcquire = null; } });
    }
    return acquiring;
  }
  function releaseNow(): void {
    generation++;
    releaseWhenIdle = false;
    cancelAcquire?.abort();
    cancelAcquire = null; acquiring = null;
    const evaluator = inner, granted = lease;
    inner = null; lease = null;
    // The worker is terminated before its slot is handed back.
    evaluator?.dispose();
    granted?.release();
  }
  return {
    async evaluate(request, signal) {
      if (disposed) throw documentError('DISPOSED', 'The controller has been disposed.');
      requests++;
      pending++;
      try {
        const evaluator = await acquire();
        if (signal?.aborted) throw documentError('CANCELLED', 'Evaluation was cancelled.');
        return await evaluator.evaluate(request, signal);
      } finally {
        pending--;
        if (pending === 0 && releaseWhenIdle) releaseNow();
      }
    },
    dispose() { disposed = true; releaseNow(); },
    release(whenIdle = false) {
      if (whenIdle && pending > 0) { releaseWhenIdle = true; return; }
      releaseNow();
    },
    get holding() { return inner !== null || lease !== null; },
    get requests() { return requests; },
  };
}

/**
 * Creates the controller for one schema 2.0 document: validates and commits it on the primary session (a worker
 * evaluation of the defaults). The scratch session is created on the first preview and kept for later gestures.
 */
export async function createDocumentInteractionController(document: VisualizationDocument, options: DocumentInteractionOptions = {}): Promise<DocumentInteractionController> {
  const idFactory = options.idFactory ?? (() => crypto.randomUUID());
  const newId = (): string => { const value = idFactory(); if (typeof value !== 'string' || !ID.test(value)) throw documentError('INVALID_INPUT', 'The ID factory returned an invalid ID.'); return value; };
  const ownerId = options.ownerId ?? `interaction:${newId()}`;
  if (!ID.test(ownerId)) throw documentError('INVALID_INPUT', 'Invalid lease owner ID.');
  if (options.budget !== undefined && typeof options.budget?.acquire !== 'function') throw documentError('INVALID_INPUT', 'The worker budget must provide acquire().');
  const origin = options.origin ?? 'human';
  if (!['human', 'agent', 'host'].includes(origin)) throw documentError('INVALID_INPUT', 'Unknown mutation origin.');
  const guard = (session: VisualizationSession): MutationGuard => {
    const current = session.getState();
    return { sessionId: session.id, expectedVersion: current.version, ...(current.run ? { expectedRunId: current.run.id } : {}), operationId: newId(), origin };
  };

  const evaluators: Record<InteractionLeasePurpose, LeasedEvaluator> = { primary: leasedEvaluator('primary', ownerId, options), scratch: leasedEvaluator('scratch', ownerId, options) };
  const primary = await createVisualizationSession({ evaluator: evaluators.primary, ...(options.maxRuns !== undefined ? { maxRuns: options.maxRuns } : {}) });
  try {
    const candidate = await primary.createCandidate(document, guard(primary));
    await primary.commitCandidate(candidate.id, guard(primary));
  } catch (error) { primary.dispose(); evaluators.scratch.dispose(); throw error; }

  const accepted = primary.getState().document!;
  const defaults = Object.fromEntries(Object.entries(accepted.parameters).map(([id, spec]) => [id, spec.value]));
  const committed = (session: SessionState): DisplayedFrame => ({ kind: 'committed', runId: session.run!.id, version: session.version });
  let state: InteractionState = {
    rendered: primary.getState(), displayed: committed(primary.getState()), parameters: { ...primary.getState().run!.params }, previewing: false, previewId: null,
    previewTime: null, saving: false, suspended: false, disposed: false, error: null, diagnostics: null,
  };
  const listeners = new Set<() => void>();
  let disposed = false, sequence = 0;
  let scratch: VisualizationSession | null = null, creatingScratch: Promise<VisualizationSession> | null = null;

  const publish = (patch: Partial<InteractionState>) => {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const listener of [...listeners]) { try { listener(); } catch { /* Observers cannot roll back accepted state. */ } }
  };
  const committedPatch = (rendered: SessionState): Partial<InteractionState> => ({
    rendered, displayed: committed(rendered), parameters: { ...rendered.run!.params }, previewing: false, previewId: null, previewTime: null, saving: false,
  });
  const unsubscribe = primary.subscribe(event => {
    // Playback ticks and accepted changes of the committed run; a gesture or commit in progress owns the display.
    if (!state.previewing && !state.saving && event.state.run) publish({ ...committedPatch(event.state), saving: false, error: event.state.error?.[0]?.message ?? null, diagnostics: event.state.error ?? null });
  });
  const fail = (error: unknown) => {
    if (disposed) return;
    previews.cancel();
    try { if (primary.getState().preview) primary.cancelPreview(guard(primary)); } catch { /* The committed state is shown regardless. */ }
    const diagnostics = error instanceof DocumentError ? error.diagnostics.slice(0, 20) : null;
    publish({ ...committedPatch(primary.getState()), error: error instanceof Error ? error.message : 'Unable to update the model.', diagnostics });
  };

  async function ensureScratch(): Promise<VisualizationSession> {
    if (scratch) return scratch;
    creatingScratch ??= (async () => {
      const session = await createVisualizationSession({ evaluator: evaluators.scratch, maxRuns: 1 });
      try {
        const candidate = await session.createCandidate(accepted, guard(session));
        await session.commitCandidate(candidate.id, guard(session));
      } catch (error) { session.dispose(); throw error; }
      if (disposed) { session.dispose(); throw documentError('DISPOSED', 'The controller has been disposed.'); }
      scratch = session;
      return session;
    })().finally(() => { creatingScratch = null; });
    return creatingScratch;
  }

  type PreviewValue = { previewId: string; params: Record<string, number>; time: number | null };
  const previews = createPreviewCoordinator<PreviewValue, SessionState, SessionState>({
    async evaluate(value) {
      const session = await ensureScratch();
      let rendered = session.getState();
      const sameParams = !!rendered.run && sameValues(rendered.run.params, value.params);
      if (!sameParams || (value.time === null && rendered.frame!.time !== 0)) rendered = await session.setParameters(value.params, guard(session));
      if (value.time !== null && rendered.frame!.time !== value.time) rendered = await session.seek(value.time, guard(session));
      return rendered;
    },
    settle(outcome) {
      const { value } = outcome;
      if (disposed || state.suspended || !state.previewing || state.previewId !== value.previewId) return null;
      if ('error' in outcome) { if (!outcome.superseded) fail(outcome.error); return null; }
      // Superseded frames are still complete frames of their values: showing them keeps feedback continuous.
      publish({ rendered: outcome.result!, displayed: { kind: 'tentative', previewId: value.previewId, sequence: ++sequence, baseRunId: primary.getState().run!.id } });
      return outcome.result!;
    },
  });
  const submit = (value: PreviewValue) => { previews.submit(value).catch(() => undefined); };
  const idle = () => !disposed && !state.suspended && !state.saving;
  const hasTime = () => !!accepted.time;

  /** Stops playback and any primary preview. Not used while a commit is evaluated: it would invalidate its guard. */
  function quiesce(): void {
    if (primary.getState().playing) { try { primary.pause(guard(primary)); } catch { /* Stopped either way. */ } }
    if (primary.getState().preview) { try { primary.cancelPreview(guard(primary)); } catch { /* Committed state is shown regardless. */ } }
  }
  /** A commit or seek that completes after suspension leaves the controller quiet. */
  const settled = () => { if (!disposed && state.suspended) { quiesce(); publish(committedPatch(primary.getState())); } };
  async function seek(time: number): Promise<void> {
    if (!idle() || !hasTime()) return;
    previews.cancel();
    publish({ saving: true, error: null, diagnostics: null });
    try {
      if (primary.getState().preview) primary.cancelPreview(guard(primary));
      const rendered = await primary.seek(time, guard(primary));
      publish(committedPatch(rendered));
    } catch (error) { fail(error); }
    settled();
  }
  async function commit(updates?: Record<string, number>): Promise<void> {
    if (!idle() || (!updates && !state.previewing)) return;
    if (!updates && state.previewTime !== null) return seek(state.previewTime);
    const params = { ...state.parameters, ...updates };
    // Gesture completion: later scratch replies are discarded; the tentative frame stays until the outcome.
    previews.cancel();
    publish({ saving: true, error: null, diagnostics: null });
    try {
      const rendered = await primary.setParameters(params, guard(primary));
      publish(committedPatch(rendered));
    } catch (error) { fail(error); }
    settled();
  }
  function pause(): void {
    if (disposed || !primary.getState().playing) return;
    try { primary.pause(guard(primary)); } catch (error) { fail(error); }
  }
  async function play(): Promise<void> {
    if (!idle() || state.previewing || !hasTime() || primary.getState().playing) return;
    if (primary.getState().frame!.terminal) {
      await seek(0);
      if (state.error) return;
    }
    if (!idle() || state.previewing) return;
    try { primary.play(guard(primary)); } catch (error) { fail(error); }
  }

  const controller: DocumentInteractionController = {
    ownerId,
    getSnapshot: () => state,
    subscribe(listener) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    preview(updates) {
      if (!idle()) return;
      const params = { ...state.parameters, ...updates };
      try {
        primary.previewParameters(params, guard(primary));
        const previewId = state.previewId ?? newId();
        publish({ parameters: params, previewing: true, previewId, previewTime: null, error: null, diagnostics: null });
        submit({ previewId, params, time: null });
      } catch (error) { fail(error); }
    },
    previewTime(time) {
      const frame = primary.getState().frame;
      if (!idle() || !hasTime() || !frame || !Number.isFinite(time) || time < 0 || time > (frame.endTime ?? Infinity)) return;
      const params = { ...primary.getState().run!.params };
      try {
        primary.previewParameters(params, guard(primary));
        const previewId = state.previewId ?? newId();
        publish({ parameters: params, previewing: true, previewId, previewTime: time, error: null, diagnostics: null });
        submit({ previewId, params, time });
      } catch (error) { fail(error); }
    },
    commit,
    cancel() {
      if (!idle() || !state.previewing) return;
      previews.cancel();
      try { primary.cancelPreview(guard(primary)); } catch (error) { fail(error); return; }
      publish({ ...committedPatch(primary.getState()), error: null, diagnostics: null });
    },
    seek,
    play,
    pause,
    togglePlay: () => primary.getState().playing ? Promise.resolve(pause()) : play(),
    step() {
      const frame = primary.getState().frame!;
      return seek(Math.min(frame.endTime ?? Infinity, frame.time + (accepted.time?.step ?? 0.05)));
    },
    reset: () => commit({ ...defaults }),
    suspend() {
      if (disposed || state.suspended) return;
      previews.cancel();
      // An in-flight commit or seek is allowed to finish (its guard must stay valid); `settled` quiets it afterwards.
      if (!state.saving) quiesce();
      evaluators.scratch.release();
      evaluators.primary.release(true);
      publish(state.saving ? { suspended: true } : { ...committedPatch(primary.getState()), suspended: true });
    },
    resume() {
      if (disposed || !state.suspended) return;
      // Paused at the declared position; workers are acquired again only by the next evaluation.
      publish({ suspended: false });
    },
    inspect: () => ({
      primary: primary.getState(), displayed: state.rendered, scratch: scratch?.getState() ?? null,
      stats: {
        evaluations: { primary: evaluators.primary.requests, scratch: evaluators.scratch.requests },
        holding: { primary: evaluators.primary.holding, scratch: evaluators.scratch.holding },
        preview: { epoch: previews.epoch, running: previews.running, queued: previews.queued },
      },
    }),
    exportDocument: () => primary.exportDocument(),
    dispose() {
      if (disposed) return;
      state = { ...state, disposed: true, previewing: false, previewId: null, previewTime: null, saving: false };
      disposed = true;
      previews.dispose(documentError('DISPOSED', 'The controller has been disposed.'));
      listeners.clear();
      unsubscribe();
      primary.dispose();
      scratch?.dispose();
      scratch = null;
      evaluators.scratch.dispose();
      evaluators.primary.dispose();
    },
  };
  return controller;
}
