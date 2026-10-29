/**
 * Guarded model session (report §8–§9, D9–D11). One coordinated interaction authority per activity:
 * - Mutations carry `{ sessionId, expectedVersion, expectedRunId, operationId }`. A repeated operation ID with the same
 *   arguments returns the original outcome; with different arguments it fails with OPERATION_CONFLICT. A stale version
 *   or run fails with CONFLICT.
 * - load/commit/restore start a new run (index/time zero, or the saved position for restore); navigation keeps the
 *   run and advances the version; playback ticks never advance the version. Playback stops one position before a
 *   numerical limit unless the `play` caller crosses it (ModelPlaybackOptions), then at the position's own end.
 * - Failures keep the last accepted frame with `stale: true` and the diagnostics in `error`; old results are never
 *   presented as recomputed.
 * - Previews evaluate the initial position of the would-be run on a separate scratch evaluator with at most one
 *   active request and one newest queued value; superseded values resolve `null`; stale epochs are discarded.
 * - The scratch lease is kept between gestures but is reclaimable once a preview ends: the shared budget releases it
 *   for any request that would otherwise wait, and the next preview leases again (report §9).
 * - suspend stops playback, cancels the preview and releases scratch (and idle primary) workers; resume stays paused.
 * - dispose rejects pending work and no listener fires afterwards.
 */
import { DocumentError } from '../declarative/types.js';
import { deepFreeze } from '../identity.js';
import type { Lease, LeasePurpose, WorkerBudget } from './budget.js';
import { checkParameters } from './constraints.js';
import { documentExecution } from './document-support.js';
import { diagnostic, fail, ModelError, modelError, toDiagnostics } from './errors.js';
import { createModelEvaluator, type ModelEvaluatorOptions } from './evaluator.js';
import { assembleFrame, checkPosition, initialPosition, positionMode, type ResolvedPosition } from './frame.js';
import { defaultParameters, validateManifest } from './manifest.js';
import { createPreviewCoordinator } from './preview.js';
import type {
  FramePosition, FrameRun, ModelEvaluator, ModelFrame, ModelGuard, ModelIdentity, ModelManifest, ModelPlaybackOptions, ModelPreviewState, ModelRef,
  ModelRunState, ModelSession, ModelSessionEvent, ModelSessionState, PositionRequest, RetainedComparison, SampleResult,
} from './types.js';

export const MODEL_SESSION_LIMITS = Object.freeze({ maxComparisons: 8, comparisonCeiling: 64, deduplicatedOperations: 64, samplePositions: 64, label: 200 });
export const DEFAULT_DISCRETE_PLAYBACK_MS = 400;
export interface Scheduler { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }
export interface ModelSessionOptions {
  /** Primary evaluator; owned by the session and disposed with it. */
  evaluator?: ModelEvaluator;
  /** Shared worker budget for primary (when no evaluator is given), scratch and sample leases. */
  budget?: WorkerBudget;
  /** Factory for session-owned evaluators when no budget is given. */
  workerFactory?: () => Worker;
  ownerId?: string;
  /** Retained comparison limit (default 8, at most 64). Full → RESOURCE_LIMIT; nothing is evicted silently. */
  maxComparisons?: number;
  idFactory?: () => string;
  scheduler?: Scheduler;
  /** Playback tick interval. Defaults: 400 ms per discrete index; the document time step (16–1000 ms) for time models. */
  playbackIntervalMs?: number;
  /** Options for session-owned evaluators. */
  evaluatorOptions?: ModelEvaluatorOptions;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const COMMIT_CAUSES: readonly ModelRunState['cause'][] = ['commit', 'reset', 'scenario', 'undo'];
type Receipt = { fingerprint: string; pending: boolean; value?: Promise<unknown>; failure?: unknown };
interface Slot {
  get(signal: AbortSignal): Promise<ModelEvaluator>;
  release(): void;
  /** Whether the session can do without the slot's lease now (budget reclamation; applied to later grants too). */
  setReclaimable(reclaimable: boolean): void;
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
/** Detached copy of caller data without invoking accessors; non-plain objects become null. Bounded depth/size. */
function snapshot(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') return typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint' ? null : value;
  if (depth > 6) return null;
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) return value.length > 1024 ? null : Array.from({ length: value.length }, (_, index) => { const d = Object.getOwnPropertyDescriptor(value, index); return d && 'value' in d ? snapshot(d.value, depth + 1) : null; });
  if (prototype !== Object.prototype && prototype !== null || Reflect.ownKeys(value).some(key => typeof key === 'symbol')) return null;
  const keys = Object.keys(value);
  if (keys.length > 256) return null;
  const copy: Record<string, unknown> = {};
  for (const key of keys) { const d = Object.getOwnPropertyDescriptor(value, key)!; copy[key] = 'value' in d ? snapshot(d.value, depth + 1) : undefined; }
  return copy;
}
function stable(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(Object.is(value, -0) ? 0 : value) : `"#${String(value)}"`;
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
const ordered = (manifest: ModelManifest, params: Record<string, unknown>): Record<string, number> =>
  Object.fromEntries(Object.keys(manifest.parameters).map(id => [id, params[id] as number]));
const request = (position: ResolvedPosition): PositionRequest => position.kind === 'index' ? { kind: 'index', index: position.index } : position;
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(modelError('CANCELLED', '$', 'The operation was cancelled.'));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(modelError('CANCELLED', '$', 'The operation was cancelled.'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

export function createModelSession(options: ModelSessionOptions = {}): ModelSession {
  const idFactory = options.idFactory ?? (() => crypto.randomUUID());
  const newId = (): string => { const value = idFactory(); if (typeof value !== 'string' || !ID.test(value)) fail('INVALID_INPUT', '$.idFactory', 'The ID factory returned an invalid ID.'); return value; };
  const maxComparisons = options.maxComparisons ?? MODEL_SESSION_LIMITS.maxComparisons;
  if (!Number.isSafeInteger(maxComparisons) || maxComparisons < 1 || maxComparisons > MODEL_SESSION_LIMITS.comparisonCeiling) fail('INVALID_INPUT', '$.maxComparisons', `Expected an integer from 1 to ${MODEL_SESSION_LIMITS.comparisonCeiling}.`);
  if (options.playbackIntervalMs !== undefined && (!Number.isSafeInteger(options.playbackIntervalMs) || options.playbackIntervalMs < 1 || options.playbackIntervalMs > 60_000)) fail('INVALID_INPUT', '$.playbackIntervalMs', 'Expected an integer from 1 to 60000.');
  if (!options.evaluator && !options.budget && !options.workerFactory) fail('INVALID_INPUT', '$', 'Provide an evaluator, a worker budget or a worker factory.');
  if (options.workerFactory) createModelEvaluator(options.workerFactory, options.evaluatorOptions).dispose(); // fail fast on invalid options; no worker is created
  const scheduler: Scheduler = options.scheduler ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) };
  const id = newId();
  const ownerId = options.ownerId ?? `session:${id}`;
  if (!ID.test(ownerId)) fail('INVALID_INPUT', '$.ownerId', 'Invalid owner ID.');

  let state: ModelSessionState = deepFreeze({ sessionId: id, status: 'empty', model: null, identity: null, version: 0, run: null, frame: null, preview: null, playing: false, comparisons: [], stale: false, error: null });
  let manifest: ModelManifest | null = null, timeStep = 1 / 60, resumeStatus: 'empty' | 'ready' = 'empty';
  const listeners = new Set<(event: ModelSessionEvent) => void>();
  const receipts = new Map<string, Receipt>();
  const lifetime = new AbortController();
  let playbackEpoch = 0, timer: unknown, tickController: AbortController | undefined;
  let primaryBusy = 0;

  const disposed = () => state.status === 'disposed';
  const emit = (type: ModelSessionEvent['type'], operationId?: string) => {
    const event: ModelSessionEvent = deepFreeze({ type, state, ...(operationId !== undefined && { operationId }) });
    for (const listener of [...listeners]) { try { listener(event); } catch { /* Observers cannot roll back accepted state. */ } }
  };
  const update = (patch: Partial<ModelSessionState>, type: ModelSessionEvent['type'], operationId?: string, advance = false) => {
    if (disposed()) return;
    state = deepFreeze({ ...state, ...patch, version: state.version + (advance ? 1 : 0) });
    emit(type, operationId);
  };
  const live = () => { if (disposed()) fail('DISPOSED', '$.sessionId', 'This session has been disposed.'); };
  const active = () => { live(); if (state.status === 'suspended') fail('NOT_READY', '$.status', 'The session is suspended.', 'Resume the session first.'); };
  const ready = (): ModelManifest => { active(); if (!manifest || !state.run || !state.frame || state.status !== 'ready') fail('NOT_READY', '$', 'No model is loaded.', 'Load a model first.'); return manifest; };
  const noPreview = () => { if (state.preview) fail('PREVIEW_ACTIVE', '$.preview', 'A tentative preview is active.'); };
  const settle = (signal?: AbortSignal) => { live(); if (signal?.aborted) fail('CANCELLED', '$', 'The operation was cancelled.'); };
  const normalize = (error: unknown): ModelError => disposed() ? modelError('DISPOSED', '$.sessionId', 'This session has been disposed.')
    : error instanceof ModelError ? error : error instanceof DocumentError ? new ModelError(error.diagnostics) : new ModelError(toDiagnostics(error));

  // ---- evaluator slots ---------------------------------------------------------------------------------------
  function slot(purpose: LeasePurpose): Slot {
    let evaluator: ModelEvaluator | null = null, lease: Lease | null = null, acquiring: Promise<ModelEvaluator> | null = null, cancel: AbortController | null = null, generation = 0, reclaimable = false;
    const injected = purpose === 'primary' ? options.evaluator : undefined;
    return {
      get(signal) {
        if (injected) return injected.disposed ? Promise.reject(modelError('DISPOSED', '$', 'The evaluator has been disposed.')) : Promise.resolve(injected);
        if (evaluator && !evaluator.disposed) return Promise.resolve(evaluator);
        if (options.budget) {
          if (!acquiring) {
            const current = generation, controller = new AbortController();
            cancel = controller;
            acquiring = options.budget.acquire(ownerId, purpose, controller.signal).then(granted => {
              if (current !== generation || disposed()) { granted.release(); throw modelError('CANCELLED', '$', 'The worker lease is no longer needed.'); }
              lease = granted; evaluator = granted.evaluator;
              if (reclaimable) granted.setReclaimable(true);
              return granted.evaluator;
            }).finally(() => { if (current === generation) { acquiring = null; cancel = null; } });
          }
          return abortable(acquiring, signal);
        }
        if (options.workerFactory) { evaluator = createModelEvaluator(options.workerFactory, options.evaluatorOptions); return Promise.resolve(evaluator); }
        return Promise.reject(modelError('UNSUPPORTED_CAPABILITY', '$', `No ${purpose} evaluator is available.`, 'Create the session with a worker budget or worker factory.'));
      },
      release() {
        generation++;
        cancel?.abort();
        cancel = null; acquiring = null;
        if (injected) return;
        if (lease) lease.release(); else evaluator?.dispose();
        lease = null; evaluator = null;
      },
      setReclaimable(value) {
        reclaimable = value;
        if (lease && !evaluator?.disposed) lease.setReclaimable(value);
      },
    };
  }
  const primary = slot('primary'), scratch = slot('scratch');
  const releasePrimaryIfIdle = () => { if (primaryBusy === 0 && (state.status === 'suspended' || disposed())) primary.release(); };

  async function evaluate(target: Slot, m: ModelManifest, model: ModelRef, run: FrameRun, params: Record<string, number>, position: PositionRequest, signal?: AbortSignal): Promise<ModelFrame> {
    const controller = new AbortController(), abort = () => controller.abort();
    if (signal?.aborted || lifetime.signal.aborted) controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    lifetime.signal.addEventListener('abort', abort, { once: true });
    if (target === primary) primaryBusy++;
    try {
      const evaluator = await target.get(controller.signal);
      const data = await evaluator.evaluate({ manifest: m, params, position }, controller.signal);
      return deepFreeze(assembleFrame(model, run, data));
    } finally {
      signal?.removeEventListener('abort', abort);
      lifetime.signal.removeEventListener('abort', abort);
      if (target === primary) { primaryBusy--; releasePrimaryIfIdle(); }
    }
  }

  // ---- guards and operation receipts -------------------------------------------------------------------------
  function checkGuard(guard: unknown): asserts guard is ModelGuard {
    live();
    if (!isObject(guard) || Object.keys(guard).some(key => !['sessionId', 'expectedVersion', 'expectedRunId', 'operationId'].includes(key)) || !Object.hasOwn(guard, 'expectedRunId'))
      fail('INVALID_INPUT', '$.guard', 'Expected { sessionId, expectedVersion, expectedRunId, operationId }.');
    if (guard.sessionId !== id) fail('CONFLICT', '$.guard.sessionId', 'The guard targets a different session.', 'Use this session\'s ID.');
    if (typeof guard.operationId !== 'string' || !ID.test(guard.operationId)) fail('INVALID_INPUT', '$.guard.operationId', 'Provide a bounded unique operation ID.');
    if (!Number.isSafeInteger(guard.expectedVersion) || (guard.expectedVersion as number) < 0) fail('INVALID_INPUT', '$.guard.expectedVersion', 'Expected a nonnegative integer version.');
    if (guard.expectedRunId !== null && typeof guard.expectedRunId !== 'string') fail('INVALID_INPUT', '$.guard.expectedRunId', 'Expected a run ID or null.');
  }
  const current = (guard: ModelGuard) => {
    live();
    if (guard.expectedVersion !== state.version || guard.expectedRunId !== (state.run?.id ?? null))
      fail('CONFLICT', '$.guard', `State changed: expected version ${guard.expectedVersion}, actual ${state.version}.`, 'Read the current state and retry with its version and run ID.');
  };
  function receipt(name: string, payload: unknown, guard: ModelGuard): { entry: Receipt; existing: boolean } {
    checkGuard(guard);
    const fingerprint = stable({ name, payload, guard });
    const previous = receipts.get(guard.operationId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) fail('OPERATION_CONFLICT', '$.guard.operationId', 'This operation ID was already used with different arguments.');
      return { entry: previous, existing: true };
    }
    current(guard);
    if (receipts.size >= MODEL_SESSION_LIMITS.deduplicatedOperations) {
      const oldest = [...receipts].find(([, entry]) => !entry.pending);
      if (!oldest) fail('RESOURCE_LIMIT', '$', 'Too many concurrent operations.');
      receipts.delete(oldest[0]);
    }
    const entry: Receipt = { fingerprint, pending: true };
    receipts.set(guard.operationId, entry);
    return { entry, existing: false };
  }
  const report = (failure: ModelError, operationId: string, patch: Partial<ModelSessionState> = {}) => {
    if (disposed() || failure.diagnostics.every(item => item.code === 'CANCELLED')) { if (Object.keys(patch).length) update(patch, 'change', operationId); return; }
    update({ ...patch, stale: true, error: structuredClone(failure.diagnostics.slice(0, 20)) }, 'error', operationId);
  };
  function asyncOperation<T>(name: string, payload: unknown, rawGuard: unknown, action: (guard: ModelGuard) => Promise<T>, onFailure?: () => Partial<ModelSessionState>): Promise<T> {
    const guard = snapshot(rawGuard) as ModelGuard;
    let result: { entry: Receipt; existing: boolean };
    try { result = receipt(name, payload, guard); } catch (error) { return Promise.reject(normalize(error)); }
    if (result.existing) return result.entry.value as Promise<T>;
    // Preconditions run synchronously, so commands are checked in call order; the receipt exists before any await.
    const promise = (async () => action(guard))().catch(error => {
      const failure = normalize(error);
      report(failure, guard.operationId, onFailure?.() ?? {});
      throw failure;
    }).finally(() => { result.entry.pending = false; });
    result.entry.value = promise;
    return promise;
  }
  function syncOperation(name: string, payload: unknown, rawGuard: unknown, action: (guard: ModelGuard) => void): void {
    const guard = snapshot(rawGuard) as ModelGuard;
    let result: { entry: Receipt; existing: boolean };
    try { result = receipt(name, payload, guard); } catch (error) { throw normalize(error); }
    if (result.existing) { if (result.entry.failure) throw result.entry.failure; return; }
    try { action(guard); } catch (error) {
      const failure = normalize(error);
      result.entry.failure = failure;
      report(failure, guard.operationId);
      throw failure;
    } finally { result.entry.pending = false; }
  }
  const parameters = (m: ModelManifest, input: unknown): Record<string, number> => {
    const problems = checkParameters(m, input);
    if (problems.length) throw new ModelError(problems);
    return ordered(m, input as Record<string, unknown>);
  };
  const modelRef = (): ModelRef => state.model!;

  // ---- playback ----------------------------------------------------------------------------------------------
  const stopPlayback = () => {
    playbackEpoch++;
    if (timer !== undefined) scheduler.clearTimeout(timer);
    timer = undefined;
    tickController?.abort();
    tickController = undefined;
  };
  /** The current playback's `throughNumericalLimit` (ModelPlaybackOptions); null keeps the default stop before a limit. */
  let throughLimit: ModelPlaybackOptions['throughNumericalLimit'] | null = null;
  /** A frame at its position's own end: the last index or the end time (a static frame has no other position). */
  const atPositionEnd = (position: FramePosition): boolean => position.kind === 'index' ? position.index >= position.maxIndex
    : position.kind === 'time' ? position.endTime !== null && position.time >= position.endTime : true;
  /** Whether playback crosses the numerical limit of `frame`: only on an explicit `true` from the caller's decision. */
  const crossesLimit = (frame: ModelFrame, decide: ModelPlaybackOptions['throughNumericalLimit'] | null): boolean => {
    if (!decide) return false;
    try { return decide(frame) === true; } catch { return false; }
  };
  const interval = (m: ModelManifest) => options.playbackIntervalMs ?? (positionMode(m) === 'index' ? DEFAULT_DISCRETE_PLAYBACK_MS : Math.max(16, Math.min(1000, Math.round(timeStep * 1000))));
  function schedule(): void {
    if (!state.playing || state.status !== 'ready' || !manifest) return;
    const epoch = playbackEpoch;
    timer = scheduler.setTimeout(() => { timer = undefined; void tick(epoch); }, interval(manifest));
  }
  async function tick(epoch: number): Promise<void> {
    if (epoch !== playbackEpoch || !state.playing || !manifest || !state.run || !state.frame || state.status !== 'ready') return;
    const m = manifest, run = state.run, position = state.frame.position;
    const next: PositionRequest | null = position.kind === 'index' ? (position.index < position.maxIndex ? { kind: 'index', index: position.index + 1 } : null)
      : position.kind === 'time' ? { kind: 'time', time: position.endTime === null ? position.time + timeStep : Math.min(position.endTime, position.time + timeStep) } : null;
    if (!next) { stopPlayback(); update({ playing: false }, 'change'); return; }
    const controller = new AbortController();
    tickController = controller;
    try {
      const frame = await evaluate(primary, m, modelRef(), { kind: 'committed', runId: run.id }, run.params, next, controller.signal);
      if (epoch !== playbackEpoch || state.run?.id !== run.id || !state.playing || disposed()) return;
      if (frame.terminal.event === 'numerical-limit') {
        const crosses = crossesLimit(frame, throughLimit);
        if (epoch !== playbackEpoch || state.run?.id !== run.id || !state.playing || disposed()) return;
        if (!crosses) {
          // Playback stops at the last representable iterate; the limit frame stays reachable by explicit navigation.
          stopPlayback();
          update({ playing: false, stale: false, error: [diagnostic('NUMERICAL_LIMIT', '$.position', 'Playback stopped: the next position reaches a numerical limit.', 'Navigate to it explicitly to inspect the limit.')] }, 'change');
          return;
        }
      }
      // A crossed numerical limit ends playback only at the position's own end, like any other frame.
      const ended = frame.terminal.reached && (frame.terminal.event !== 'numerical-limit' || atPositionEnd(frame.position));
      if (ended) stopPlayback();
      update({ frame, run: { ...state.run, position: frame.position }, playing: !ended, stale: false, error: null }, 'change');
      if (!ended) schedule();
    } catch (error) {
      if (epoch !== playbackEpoch || disposed()) return;
      stopPlayback();
      update({ playing: false, stale: true, error: toDiagnostics(normalize(error)) }, 'error');
    } finally { if (tickController === controller) tickController = undefined; }
  }

  // ---- preview coordination ----------------------------------------------------------------------------------
  type PreviewValue = { previewId: string; params: Record<string, number>; operationId: string };
  const previews = createPreviewCoordinator<PreviewValue, ModelFrame, ModelPreviewState>({
    evaluate: value => {
      const m = manifest!;
      return evaluate(scratch, m, modelRef(), { kind: 'tentative', previewId: value.previewId, baseRunId: state.run!.id }, value.params, initialPosition(m));
    },
    settle: outcome => {
      const { value, superseded } = outcome;
      if (state.preview?.previewId !== value.previewId) return null;
      if ('error' in outcome) {
        if (superseded) return null;
        update({ preview: { ...state.preview, status: 'failed', frame: null, error: normalize(outcome.error).diagnostics[0] } }, 'preview', value.operationId);
      } else update({ preview: { ...state.preview, status: superseded ? 'evaluating' : 'ready', frame: outcome.result!, error: null } }, 'preview', value.operationId);
      return state.preview;
    },
  });
  /**
   * Ends the current preview epoch: queued values resolve null and late replies are discarded. The scratch lease stays
   * for the next gesture but becomes reclaimable, so the budget hands its worker to any other request that would
   * otherwise wait (report §9; a later preview leases again).
   */
  const endPreview = () => { previews.cancel(); scratch.setReclaimable(true); };
  function startPreview(previewId: unknown, input: unknown, operationId: string): Promise<ModelPreviewState | null> {
    const m = ready();
    if (typeof previewId !== 'string' || !ID.test(previewId)) fail('INVALID_INPUT', '$.previewId', 'Provide a bounded preview ID.');
    if (state.preview && state.preview.previewId !== previewId) fail('PREVIEW_ACTIVE', '$.previewId', 'Another preview is active.');
    if (state.playing) stopPlayback();
    const problems = checkParameters(m, input);
    if (problems.length) {
      endPreview();
      const attempted = isObject(input) ? Object.fromEntries(Object.entries(input).filter(([key, value]) => Object.hasOwn(m.parameters, key) && typeof value === 'number' && Number.isFinite(value))) as Record<string, number> : {};
      update({ playing: false, preview: { previewId, epoch: previews.epoch, params: attempted, status: 'failed', frame: null, error: problems[0] } }, 'preview', operationId);
      throw new ModelError(problems);
    }
    const params = ordered(m, input as Record<string, unknown>);
    const previous = state.preview?.previewId === previewId ? state.preview : null;
    update({ playing: false, preview: { previewId, epoch: previews.epoch, params, status: 'evaluating', frame: previous?.frame ?? null, error: null } }, 'preview', operationId);
    // A gesture in progress keeps its scratch worker until the preview ends.
    scratch.setReclaimable(false);
    return previews.submit({ previewId, params, operationId });
  }

  // ---- session object ----------------------------------------------------------------------------------------
  const session: ModelSession = {
    id,
    getState: () => state,
    subscribe(listener) {
      live();
      if (typeof listener !== 'function') fail('INVALID_INPUT', '$.listener', 'Expected a function.');
      listeners.add(listener);
      try { listener(deepFreeze({ type: 'ready', state })); } catch { /* Observers cannot affect state. */ }
      return () => { listeners.delete(listener); };
    },
    load(input, params, guard, signal) {
      let validated: { manifest: ModelManifest; identity: ModelIdentity } | null = null, invalid: unknown = null;
      try { validated = validateManifest(input); } catch (error) { invalid = error; }
      const values = params === null ? null : snapshot(params);
      return asyncOperation('load', { model: validated?.identity.digest ?? null, params: values }, guard, async g => {
        active();
        if (!validated) throw invalid;
        const { manifest: m, identity } = validated;
        const chosen = parameters(m, values === null ? defaultParameters(m) : values);
        const model: ModelRef = { modelId: m.modelId, version: m.version, digest: identity.digest };
        const runId = newId();
        const frame = await evaluate(primary, m, model, { kind: 'committed', runId }, chosen, initialPosition(m), signal);
        settle(signal); current(g);
        stopPlayback(); endPreview();
        manifest = m;
        timeStep = m.execution.kind === 'document' ? documentExecution('$.execution.document').normalize(m.execution.document).time?.step ?? 1 / 60 : 1 / 60;
        resumeStatus = 'ready';
        // Comparisons stay meaningful only for the identical model; a different model starts without them.
        const comparisons = state.model?.digest === model.digest ? state.comparisons : [];
        update({ status: state.status === 'suspended' ? 'suspended' : 'ready', model, identity, run: { id: runId, params: chosen, position: frame.position, cause: 'initial' }, frame, preview: null, playing: false, comparisons, stale: false, error: null }, 'change', g.operationId, true);
        return state;
      });
    },
    commitParameters(params, guard, cause = 'commit', signal) {
      const values = snapshot(params);
      let gesture: string | null = null;
      return asyncOperation('commitParameters', { params: values, cause }, guard, async g => {
        const m = ready();
        if (!COMMIT_CAUSES.includes(cause)) fail('INVALID_INPUT', '$.cause', 'Expected commit, reset, scenario or undo.');
        const chosen = parameters(m, values);
        // Gesture completion: further preview replies are discarded; the tentative frame stays until the outcome.
        if (state.preview) { gesture = state.preview.previewId; endPreview(); }
        const runId = newId();
        const frame = await evaluate(primary, m, modelRef(), { kind: 'committed', runId }, chosen, initialPosition(m), signal);
        settle(signal); current(g);
        stopPlayback(); endPreview();
        update({ run: { id: runId, params: chosen, position: frame.position, cause }, frame, preview: null, playing: false, stale: false, error: null }, 'change', g.operationId, true);
        return state;
      }, () => gesture !== null && state.preview?.previewId === gesture ? { preview: null } : {});
    },
    previewParameters(previewId, params, guard) {
      const values = snapshot(params);
      const g = snapshot(guard) as ModelGuard;
      let result: { entry: Receipt; existing: boolean };
      try { result = receipt('previewParameters', { previewId, params: values }, g); } catch (error) { return Promise.reject(normalize(error)); }
      if (result.existing) return result.entry.value as Promise<ModelPreviewState | null>;
      let promise: Promise<ModelPreviewState | null>;
      try { promise = startPreview(previewId, values, g.operationId); } catch (error) { promise = Promise.reject(normalize(error)); }
      result.entry.value = promise.catch(error => { throw normalize(error); }).finally(() => { result.entry.pending = false; });
      return result.entry.value as Promise<ModelPreviewState | null>;
    },
    cancelPreview(guard) {
      syncOperation('cancelPreview', null, guard, g => {
        ready();
        if (!state.preview) return;
        endPreview();
        update({ preview: null }, 'preview', g.operationId);
      });
    },
    navigate(position, guard, signal) {
      const target = snapshot(position);
      return asyncOperation('navigate', { position: target }, guard, async g => {
        const m = ready();
        noPreview();
        if (positionMode(m) === 'static') fail('UNSUPPORTED_CAPABILITY', '$.position', 'This model has a single static state; there is nothing to navigate.');
        const resolved = checkPosition(m, target);
        const run = state.run!;
        const frame = await evaluate(primary, m, modelRef(), { kind: 'committed', runId: run.id }, run.params, request(resolved), signal);
        settle(signal); current(g); noPreview();
        stopPlayback();
        update({ frame, run: { ...state.run!, position: frame.position }, playing: false, stale: false, error: null }, 'change', g.operationId, true);
        return state;
      });
    },
    play(guard, options) {
      syncOperation('play', null, guard, g => {
        const m = ready();
        noPreview();
        const given: unknown = options === undefined ? undefined : isObject(options) ? options.throughNumericalLimit : null;
        if (given !== undefined && typeof given !== 'function') fail('INVALID_INPUT', '$.options', 'Expected { throughNumericalLimit?: (frame) => boolean }.');
        const decide = given as ModelPlaybackOptions['throughNumericalLimit'];
        if (positionMode(m) === 'static') fail('UNSUPPORTED_CAPABILITY', '$.position', 'This model has no playback.');
        if (state.playing) return;
        const { position, terminal } = state.frame!;
        // A frame at a numerical limit is an end only where the caller does not cross it (ModelPlaybackOptions).
        const crossable = terminal.event === 'numerical-limit' && !atPositionEnd(position) && crossesLimit(state.frame!, decide ?? null);
        if (terminal.reached && !crossable) fail('OUT_OF_DOMAIN', '$.position', 'Playback has reached its exact end.', 'Navigate to an earlier position before playing.');
        stopPlayback();
        throughLimit = decide ?? null;
        update({ playing: true, stale: false, error: null }, 'change', g.operationId);
        schedule();
      });
    },
    pause(guard) {
      syncOperation('pause', null, guard, g => {
        ready();
        stopPlayback();
        update({ playing: false, stale: false, error: null }, 'change', g.operationId);
      });
    },
    retainComparison(label, guard) {
      syncOperation('retainComparison', { label }, guard, g => {
        ready();
        noPreview();
        if (typeof label !== 'string' || !label.length || label.length > MODEL_SESSION_LIMITS.label) fail('INVALID_INPUT', '$.label', `Expected a label of 1–${MODEL_SESSION_LIMITS.label} characters.`);
        if (state.comparisons.length >= maxComparisons) fail('RESOURCE_LIMIT', '$.comparisons', `At most ${maxComparisons} comparisons can be retained.`, 'Remove a retained comparison first.');
        const run = state.run!;
        if (state.comparisons.some(item => item.runId === run.id)) fail('CONFLICT', '$.comparisons', 'This run is already retained.');
        const comparison: RetainedComparison = { runId: run.id, label, params: run.params, position: state.frame!.position, frame: state.frame! };
        update({ comparisons: [...state.comparisons, comparison], stale: false, error: null }, 'change', g.operationId, true);
      });
    },
    removeComparison(runId, guard) {
      syncOperation('removeComparison', { runId }, guard, g => {
        ready();
        if (!state.comparisons.some(item => item.runId === runId)) fail('NOT_FOUND', '$.runId', 'No retained comparison has this run ID.');
        update({ comparisons: state.comparisons.filter(item => item.runId !== runId), stale: false, error: null }, 'change', g.operationId, true);
      });
    },
    async sample(input, signal) {
      live();
      if (!manifest || !state.model || !state.identity) fail('NOT_READY', '$', 'No model is loaded.', 'Load a model first.');
      const m = manifest, model = state.model, identity = state.identity;
      const raw = snapshot(input);
      if (!isObject(raw) || Object.keys(raw).some(key => key !== 'params' && key !== 'positions')) fail('INVALID_INPUT', '$', 'Expected { params, positions }.');
      if (!Array.isArray(raw.positions) || !raw.positions.length) fail('INVALID_INPUT', '$.positions', 'Provide at least one position.');
      if (raw.positions.length > MODEL_SESSION_LIMITS.samplePositions) fail('RESOURCE_LIMIT', '$.positions', `At most ${MODEL_SESSION_LIMITS.samplePositions} positions per sample.`);
      const chosen = parameters(m, raw.params);
      const positions = raw.positions.map((position, index) => request(checkPosition(m, position, `$.positions[${index}]`)));
      const sampleId = newId();
      const run: FrameRun = { kind: 'sample', sampleId };
      const controller = new AbortController(), abort = () => controller.abort();
      if (signal?.aborted) controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      lifetime.signal.addEventListener('abort', abort, { once: true });
      let lease: Lease | null = null, own: ModelEvaluator | null = null;
      try {
        if (options.budget) lease = await options.budget.acquire(ownerId, 'sample', controller.signal);
        else if (options.workerFactory) own = createModelEvaluator(options.workerFactory, options.evaluatorOptions);
        else fail('UNSUPPORTED_CAPABILITY', '$', 'Sampling needs a worker budget or worker factory.', 'Create the session with a worker budget or worker factory.');
        const evaluator = (lease?.evaluator ?? own)!;
        const frames: ModelFrame[] = [];
        for (const position of positions) {
          const data = await evaluator.evaluate({ manifest: m, params: chosen, position }, controller.signal);
          settle(signal);
          frames.push(assembleFrame(model, run, data));
        }
        const result: SampleResult = { sampleId, model, identity, frames };
        return deepFreeze(result);
      } catch (error) { throw normalize(error); } finally {
        signal?.removeEventListener('abort', abort);
        lifetime.signal.removeEventListener('abort', abort);
        lease?.release();
        own?.dispose();
      }
    },
    restore(input, guard, signal) {
      const saved = snapshot(input);
      return asyncOperation('restore', { snapshot: saved }, guard, async g => {
        const m = ready();
        noPreview();
        if (!isObject(saved) || Object.keys(saved).length !== 3 || !['params', 'position', 'restoredFrom'].every(key => Object.hasOwn(saved, key))) fail('INVALID_INPUT', '$.snapshot', 'Expected { params, position, restoredFrom }.');
        if (typeof saved.restoredFrom !== 'string' || !ID.test(saved.restoredFrom)) fail('INVALID_INPUT', '$.snapshot.restoredFrom', 'Expected the original run ID.');
        const chosen = parameters(m, saved.params);
        const resolved = checkPosition(m, saved.position, '$.snapshot.position');
        const runId = newId();
        const frame = await evaluate(primary, m, modelRef(), { kind: 'committed', runId }, chosen, request(resolved), signal);
        if (resolved.kind === 'time' && frame.position.kind === 'time' && frame.position.time !== resolved.time) fail('OUT_OF_DOMAIN', '$.snapshot.position.time', 'The saved time lies outside this run\'s time domain.');
        settle(signal); current(g); noPreview();
        stopPlayback();
        update({ run: { id: runId, params: chosen, position: frame.position, restoredFrom: saved.restoredFrom, cause: 'restore' }, frame, playing: false, stale: false, error: null }, 'change', g.operationId, true);
        return state;
      });
    },
    suspend() {
      if (disposed() || state.status === 'suspended') return;
      resumeStatus = state.status === 'ready' ? 'ready' : 'empty';
      stopPlayback();
      endPreview();
      scratch.release();
      update({ status: 'suspended', playing: false, preview: null }, 'suspended');
      releasePrimaryIfIdle();
    },
    resume() {
      if (state.status !== 'suspended') return;
      // Resume stays paused at the declared position: no wall-clock catch-up.
      update({ status: resumeStatus }, 'resumed');
    },
    dispose() {
      if (disposed()) return;
      stopPlayback();
      previews.dispose(modelError('DISPOSED', '$.sessionId', 'This session has been disposed.'));
      // Release retained frames; the final state keeps only identity for diagnostics.
      state = deepFreeze({ ...state, status: 'disposed', playing: false, preview: null, run: null, frame: null, comparisons: [] });
      manifest = null;
      lifetime.abort();
      scratch.release();
      primary.release();
      options.evaluator?.dispose();
      receipts.clear();
      emit('disposed');
      listeners.clear();
    },
  };
  return session;
}

