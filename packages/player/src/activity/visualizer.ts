/**
 * `createStudyHarnessVisualizer` (report §5.3): the six report operations as one supported API around the Study Harness
 * adapter and the learner surface —
 *
 * | Operation              | Behavior |
 * | ---------------------- | -------- |
 * | `getCapabilities`      | installed template/model versions, schema versions, controls, limits, review scope and alternatives |
 * | `validate`             | complete request, references, current host policy, constraints and budget; defaults evaluated in a worker; nothing activated |
 * | `mount` / `render`     | mounts only an activity this visualizer prepared or restored; returns a surface handle with readiness, error and disposal hooks |
 * | `getState`             | audience-appropriate state, revision guards, committed/tentative distinction and persistence |
 * | `summarizeInteraction` | deterministic bounded summary of an acknowledged event interval |
 * | `dispose`              | disposes surfaces, aborts pending requests, stops the activities' workers and invalidates pending responses; idempotent |
 *
 * plus pass-through of `prepare`, `restore` and isolated `sample`. Authority still comes only from the construction
 * context: the host constructs the visualizer with its `HostPort` and catalogue, receives `PreparedActivity.host` for
 * privileged commands, and every surface receives a learner binding (`prepared.binding('learner', surfaceId)`).
 *
 * After `dispose()`, every pending `validate`/`prepare`/`restore`/`sample` resolves with a `DISPOSED` failure (its
 * worker request is aborted), pending surface captures reject with `DISPOSED`, and no surface callback reaches the host.
 */
import {
  createStudyHarnessAdapter,
  type ActivityRequest, type AdapterDiagnostics, type AdapterOptions, type DeveloperInspection, type DiagnosticExport, type AudienceState, type CapabilityReport, type CommandBase, type CommandFailure, type Diagnostic,
  type DiagnosticCode, type InteractionSummary, type LearnerProjection, type PreparedActivity, type RestoreResult, type StudyHarnessAdapter, type UiState,
  type ValidationReport,
} from '@experiment-kit/activity';
import { CaptureError, type CaptureOptions, type CaptureResult } from './capture.js';
import { mountStudyActivity, type MountedStudyActivity } from './mount.js';
import { createSurfaceId } from './runtime.js';
import type { StudyActivitySurfaceProps, SurfaceDiagnostic } from './types.js';

/** Defaults applied to every mounted surface (per-mount options override them; diagnostics reach both callbacks). */
export type SurfaceDefaults = Partial<Omit<StudyActivitySurfaceProps, 'binding' | 'surfaceId' | 'nextAction' | 'responseSlot'>>;

/** UI states that make a mounted surface report an error event (each entry into the state is reported once). */
export type SurfaceErrorState = Extract<UiState, 'recoverable-failure' | 'stale-policy' | 'unsupported' | 'disposed'>;
/**
 * Surface error event: a learner-safe diagnostic (a refused learner command or a surface failure such as unavailable
 * styles or math assets), or the activity entering a state that needs host attention. Presentation fallbacks that keep
 * the task usable (label nudges, plain-text math, the 2D projection instead of 3D, ignored tokens) are reported through
 * `onDiagnostic` only.
 */
export type SurfaceErrorEvent =
  | { kind: 'diagnostic'; diagnostic: SurfaceDiagnostic }
  | { kind: 'state'; state: SurfaceErrorState; message: string | null };

export interface VisualizerSurfaceOptions extends Omit<StudyActivitySurfaceProps, 'binding'> {
  /** Error hook for this surface (see {@link SurfaceErrorEvent}); `StudyHarnessSurface.onError` adds more listeners. */
  onError?(event: SurfaceErrorEvent): void;
}

/** Handle of one mounted learner surface. */
export interface StudyHarnessSurface {
  readonly surfaceId: string;
  readonly activityId: string;
  /** Host element appended to the container (its shadow root holds the card when mounted with the default mounter). */
  readonly element: HTMLElement;
  /** Resolves after the first committed render (and settled bundled fonts); rejects with `DISPOSED` when disposed first. */
  readonly ready: Promise<void>;
  readonly disposed: boolean;
  /** Adds an error listener; returns its removal. Listeners are never called after disposal. */
  onError(listener: (event: SurfaceErrorEvent) => void): () => void;
  /** Frozen capture of this surface only; rejects with `DISPOSED` if the surface is disposed before it settles. */
  capture(options: CaptureOptions): Promise<CaptureResult>;
  /** Unmounts and unregisters the surface; idempotent. The activity stays open (dispose it through the visualizer). */
  dispose(): void;
}

/** Mounts a learner surface into a container (default {@link mountStudyActivity}); a React host may render `StudyActivitySurface` itself. */
export type SurfaceMounter = (container: HTMLElement, props: StudyActivitySurfaceProps) => MountedStudyActivity;

export interface StudyHarnessVisualizerOptions extends AdapterOptions {
  /** Theme, tokens, fonts, assets, loaders and callbacks shared by every surface. */
  surfaceDefaults?: SurfaceDefaults;
  /** Surface mounting function (default `mountStudyActivity`). */
  mountSurface?: SurfaceMounter;
}

type PrepareOutcome = { ok: true; prepared: PreparedActivity } | CommandFailure;
type SampleRequest = Parameters<StudyHarnessAdapter['sample']>[0];
type SampleOutcome = Awaited<ReturnType<StudyHarnessAdapter['sample']>>;
type SummaryOptions = Parameters<StudyHarnessAdapter['summarizeInteraction']>[1];

export interface StudyHarnessVisualizer {
  /** Installed capabilities (catalogue facts; still answered after disposal). */
  getCapabilities(): CapabilityReport;
  validate(request: ActivityRequest, signal?: AbortSignal): Promise<ValidationReport>;
  prepare(request: ActivityRequest, input: CommandBase, signal?: AbortSignal): Promise<PrepareOutcome>;
  restore(artifact: unknown, input: CommandBase & { hostSessionRevision: number }, signal?: AbortSignal): Promise<RestoreResult | CommandFailure>;
  /** Isolated sampling, separately authorized by the host policy; never changes learner state. */
  sample(request: SampleRequest, signal?: AbortSignal): Promise<SampleOutcome>;
  /**
   * Mounts a learner surface for an open activity that this visualizer prepared or restored. Throws
   * {@link VisualizerError} (`DISPOSED`, `INVALID_REFERENCE`, `NOT_FOUND`) instead of mounting anything else.
   */
  mount(element: HTMLElement, prepared: PreparedActivity, options?: VisualizerSurfaceOptions): StudyHarnessSurface;
  /** Alias of {@link mount} (the report's `render`). */
  render(element: HTMLElement, prepared: PreparedActivity, options?: VisualizerSurfaceOptions): StudyHarnessSurface;
  getState(activityId: string, audience: AudienceState['audience']): AudienceState | CommandFailure;
  summarizeInteraction(activityId: string, options: SummaryOptions): InteractionSummary | CommandFailure;
  /** Host-only operational metrics (no content); answered after disposal too. */
  getDiagnostics(activityId?: string): AdapterDiagnostics | CommandFailure;
  /** Local redacted diagnostic export with the execution identity; the toolkit never transmits it. */
  exportDiagnostics(options?: { activityId?: string }): DiagnosticExport | CommandFailure;
  /** Developer inspection entry (refused unless the host policy sets `inspection.developer`); never reachable from a surface. */
  inspectDeveloper(activityId: string): DeveloperInspection | CommandFailure;
  /** Without an ID: disposes everything (idempotent). With an ID: disposes that activity and its surfaces. */
  dispose(activityId?: string): void;
  readonly disposed: boolean;
}

/** A refused visualizer operation that has no failure result of its own (mounting). */
export class VisualizerError extends Error {
  readonly code: DiagnosticCode;
  readonly diagnostics: Diagnostic[];
  constructor(diagnostic: Diagnostic) {
    super(diagnostic.message);
    this.name = 'VisualizerError';
    this.code = diagnostic.code;
    this.diagnostics = [diagnostic];
  }
}

/** Surface diagnostic codes that are failures (everything from the binding is a refused command). */
const SURFACE_FAILURES: ReadonlySet<string> = new Set(['STYLES_UNAVAILABLE', 'FONTS_UNAVAILABLE', 'MATH_ASSETS_UNAVAILABLE', 'COMMAND_REJECTED', 'CAPTURE_REJECTED']);
const ERROR_STATES: ReadonlySet<UiState> = new Set<SurfaceErrorState>(['recoverable-failure', 'stale-policy', 'unsupported', 'disposed']);
const DISPOSED: Diagnostic = { code: 'DISPOSED', path: '$', message: 'The visualizer has been disposed.', recovery: 'Create a new visualizer.' };
const disposedFailure = (): CommandFailure => ({ ok: false, diagnostics: [{ ...DISPOSED }] });
const isFailure = (value: unknown): value is CommandFailure => !!value && typeof value === 'object' && (value as { ok?: unknown }).ok === false;

interface SurfaceRecord { activityId: string; dispose(): void }

export function createStudyHarnessVisualizer(options: StudyHarnessVisualizerOptions): StudyHarnessVisualizer {
  const { surfaceDefaults = {}, mountSurface = mountStudyActivity, ...adapterOptions } = options ?? ({} as StudyHarnessVisualizerOptions);
  const adapter = createStudyHarnessAdapter(adapterOptions);
  const lifetime = new AbortController();
  let disposed = false;
  let resolveDisposal!: () => void;
  const disposal = new Promise<void>(resolve => { resolveDisposal = resolve; });
  /** Prepared activities this visualizer returned (only these can be mounted). */
  const owned = new WeakSet<PreparedActivity>();
  const surfaces = new Set<SurfaceRecord>();

  /** A signal aborted by the caller's signal or by disposal; `release` detaches the listeners. */
  function linked(signal?: AbortSignal): { signal: AbortSignal; release(): void } {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (lifetime.signal.aborted || signal?.aborted) controller.abort();
    lifetime.signal.addEventListener('abort', abort, { once: true });
    signal?.addEventListener('abort', abort, { once: true });
    return { signal: controller.signal, release: () => { lifetime.signal.removeEventListener('abort', abort); signal?.removeEventListener('abort', abort); } };
  }
  /**
   * Runs one adapter request that may be pending when the visualizer is disposed: disposal aborts its worker work and
   * resolves it at once with `onDisposed()`; a result that arrives after disposal is discarded.
   */
  async function pending<T>(run: (signal: AbortSignal) => Promise<T>, signal: AbortSignal | undefined, onDisposed: () => T): Promise<T> {
    if (disposed) return onDisposed();
    const link = linked(signal);
    try {
      const result = await Promise.race([run(link.signal), disposal.then(onDisposed)]);
      return disposed ? onDisposed() : result;
    } finally { link.release(); }
  }
  const adopt = <T>(result: T): T => {
    const prepared = (result as { ok?: boolean; prepared?: PreparedActivity }).prepared;
    if ((result as { ok?: boolean }).ok === true && prepared) owned.add(prepared);
    return result;
  };

  function disposeSurfaces(activityId?: string): void {
    for (const record of [...surfaces]) if (activityId === undefined || record.activityId === activityId) record.dispose();
  }

  function mount(element: HTMLElement, prepared: PreparedActivity, surfaceOptions: VisualizerSurfaceOptions = {}): StudyHarnessSurface {
    if (disposed) throw new VisualizerError({ ...DISPOSED });
    if (!element || typeof element.appendChild !== 'function' || !element.ownerDocument) throw new TypeError('mount requires a browser HTMLElement container.');
    if (!prepared || !owned.has(prepared)) {
      throw new VisualizerError({ code: 'INVALID_REFERENCE', path: '$.prepared', message: 'This activity was not prepared or restored by this visualizer.', recovery: 'Prepare or restore the activity through this visualizer, then mount it.' });
    }
    const state = adapter.getState(prepared.activityId, 'learner');
    if (isFailure(state) || state.projection.status.ui === 'disposed') {
      throw new VisualizerError({ code: 'NOT_FOUND', path: '$.prepared', message: 'The activity is no longer open.', recovery: 'Prepare or restore the activity again.' });
    }
    const { onError, ...rest } = surfaceOptions;
    const surfaceId = rest.surfaceId ?? createSurfaceId();
    const binding = prepared.binding('learner', surfaceId);
    const listeners = new Set<(event: SurfaceErrorEvent) => void>();
    if (onError) listeners.add(onError);
    let closed = false;
    let resolveClosed!: () => void;
    const closedPromise = new Promise<void>(resolve => { resolveClosed = resolve; });
    const emit = (event: SurfaceErrorEvent) => {
      if (closed) return;
      for (const listener of [...listeners]) { try { listener(event); } catch { /* A host listener cannot break the surface. */ } }
    };
    const guard = <A extends unknown[]>(fn: ((...args: A) => void) | undefined) => fn && ((...args: A) => { if (!closed) fn(...args); });
    const props: StudyActivitySurfaceProps = {
      ...surfaceDefaults, ...rest, surfaceId, binding,
      onDiagnostic: diagnostic => {
        if (closed) return;
        try { surfaceDefaults.onDiagnostic?.(diagnostic); } catch { /* Host callbacks cannot break the surface. */ }
        try { rest.onDiagnostic?.(diagnostic); } catch { /* Host callbacks cannot break the surface. */ }
        if (diagnostic.source === 'binding' || SURFACE_FAILURES.has(diagnostic.code)) emit({ kind: 'diagnostic', diagnostic });
      },
      onRecoveryAction: guard(rest.onRecoveryAction ?? surfaceDefaults.onRecoveryAction),
    };

    // Activity states that need the host's attention are reported once per entry into the state.
    let lastState: UiState = state.projection.status.ui;
    const watch = (projection: LearnerProjection) => {
      const ui = projection.status.ui;
      if (ui !== lastState && ERROR_STATES.has(ui)) emit({ kind: 'state', state: ui as SurfaceErrorState, message: projection.status.message });
      lastState = ui;
    };
    const unsubscribe = binding.subscribe(watch);
    let mounted: MountedStudyActivity;
    try { mounted = mountSurface(element, props); } catch (error) { unsubscribe(); throw error; }

    const record: SurfaceRecord = {
      activityId: prepared.activityId,
      dispose() {
        if (closed) return;
        closed = true;
        surfaces.delete(record);
        unsubscribe();
        listeners.clear();
        resolveClosed();
        mounted.dispose();
      },
    };
    surfaces.add(record);
    const disposedError = () => new CaptureError('DISPOSED', 'This surface has been disposed.', 'Mount the activity again.');
    return {
      surfaceId, activityId: prepared.activityId, element: mounted.element, ready: mounted.ready,
      get disposed() { return closed; },
      onError(listener) {
        if (closed || typeof listener !== 'function') return () => undefined;
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
      async capture(captureOptions) {
        if (closed) throw disposedError();
        const result = await Promise.race([mounted.capture(captureOptions), closedPromise.then(() => { throw disposedError(); })]);
        if (closed) throw disposedError();
        return result;
      },
      dispose: () => record.dispose(),
    };
  }

  const visualizer: StudyHarnessVisualizer = {
    getCapabilities: () => adapter.getCapabilities(),
    validate: (request, signal) => pending<ValidationReport>(inner => adapter.validate(request, inner), signal, () => ({ ok: false, diagnostics: [{ ...DISPOSED }] })),
    prepare: (request, input, signal) => pending(inner => adapter.prepare(request, input, inner).then(adopt), signal, disposedFailure),
    restore: (artifact, input, signal) => pending(inner => adapter.restore(artifact, input, inner).then(adopt), signal, disposedFailure),
    sample: (request, signal) => pending(inner => adapter.sample(request, inner), signal, disposedFailure),
    mount,
    render: mount,
    getState: (activityId, audience) => disposed ? disposedFailure() : adapter.getState(activityId, audience),
    summarizeInteraction: (activityId, summaryOptions) => disposed ? disposedFailure() : adapter.summarizeInteraction(activityId, summaryOptions),
    getDiagnostics: activityId => adapter.getDiagnostics(activityId),
    exportDiagnostics: exportOptions => adapter.exportDiagnostics(exportOptions),
    inspectDeveloper: activityId => disposed ? disposedFailure() : adapter.inspectDeveloper(activityId),
    dispose(activityId) {
      if (activityId !== undefined) {
        if (disposed) return;
        disposeSurfaces(activityId);
        adapter.dispose(activityId);
        return;
      }
      if (disposed) return;
      disposed = true;
      disposeSurfaces();
      lifetime.abort();
      resolveDisposal();
      adapter.dispose();
    },
    get disposed() { return disposed; },
  };
  return visualizer;
}
