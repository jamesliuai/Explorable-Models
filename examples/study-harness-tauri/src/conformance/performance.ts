// CONFORMANCE BUILD ONLY (`vite --mode conformance`). Packaged-host performance scenario (report §18; A42, A43, A47,
// A58; R22): the §18 measurements that apply to a host, taken inside the packaged app's WKWebView against the Rust
// reference host and its SQLite store (every commit, display acknowledgement and checkpoint is a real native call).
//
// The scenario runs in one launch, on a fresh store, in this order:
//  1. lifecycle stress: one warm-up cycle, then 100 cycles of open → stage → commit → navigate → suspend → save →
//     dispose → restore → suspend/resume → dispose through the host's own flows (`ReferenceHostApp`); afterwards the
//     activity-owned resources (workers, timers, intervals, window/document/MediaQueryList listeners, surfaces, open
//     activities) are counted. The 100 activities and their records stay in the store: the measurements below run
//     against a store with that retained history;
//  2. the quadratic activity (linked trace and math): prediction, stage, reveal and exploration scope through the host;
//     a commit series (command → paint of the first frame showing the new committed frame, with worker evaluation,
//     render, paint and the native journal acknowledgement reported separately); scripted 60 Hz slider drags (input
//     feedback, display frame rate, dropped frames, tentative frames painted); playback suspended by the host and by a
//     hidden window (no work during a 2 s window; resume without catch-up);
//  3. each spatial activity: pointer orbit input → renderer frame painted, camera command → renderer frame painted, and
//     a host-suspended 2 s window with no renderer frames.
//
// Inputs are DOM events dispatched by this runner (pointer and input events on the real controls, at a 60 Hz pacing),
// not OS-level input: the time from the OS event to its dispatch is not part of these numbers. The raw series go to the
// report; the driver (scripts/conformance.mjs) computes nearest-rank p50/p95 and judges the targets of
// docs/study-harness/budgets.json. Nothing here changes host records outside this scenario's own fresh store.
import type { ActivityBinding, Camera3D, LearnerProjection, PreparedActivity } from '@explorable-models/activity';
import type { ReferenceHostApp } from '../app';
import { call, onCall } from '../native-bridge';
import { spatialRecords } from '../spatial';
import type { Json } from './probes';

/** The runner's report, as this scenario uses it (runner.ts `Report`). */
export interface ScenarioReport {
  readonly data: Record<string, Json>;
  step(id: string, run: () => Promise<unknown>): Promise<boolean>;
  write(status: string): Promise<void>;
}

const LIFECYCLE_CYCLES = 100;
const COMMIT_WARMUP = 2;
const COMMIT_SAMPLES = 30;
const DRAGS = 6;
const DRAG_MOVES = 120;
const INPUT_HZ = 60;
const QUIET_WINDOW_MS = 2000;
/** Time a suspension is given to settle before the quiet window starts (§18 "after suspension settles"). */
const SETTLE_MS = 1000;
const ORBIT_DRAGS = 3;
const ORBIT_MOVES = 60;
const CAMERA_WARMUP = 2;
const CAMERA_SAMPLES = 20;
const SPATIAL_TEMPLATES = ['vector-orientation-3d', 'quadratic-surface-gradient'] as const;

const now = () => performance.now();
const round = (value: number) => Math.round(value * 100) / 100;
const toJson = (value: unknown): Json => JSON.parse(JSON.stringify(value ?? null)) as Json;
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 500);

// ---------------------------------------------------------------------------------------------------------------------
// Instrumentation: counts resources the activity runtime could own, labelled by phase (as the Chromium benchmark's init
// script does). Installed when this scenario starts, before any activity exists in this launch.
// ---------------------------------------------------------------------------------------------------------------------
interface Instrument {
  setPhase(value: string): void;
  counts(): {
    workers: { created: number; terminated: number; live: number; peak: number; messages: number };
    timers: { set: number; cleared: number; fired: number; pending: Record<string, number> };
    intervals: { set: number; cleared: number; live: Record<string, number> };
    raf: number; shadowRoots: number; mediaQueryListeners: number;
    listeners: { window: string[]; document: string[] };
  };
  /** Worker evaluations: `evaluate` postMessage → reply received. */
  evaluations: { postedAt: number; repliedAt: number }[];
}

function instrument(): Instrument {
  const phase = { value: 'load' };
  const workers = { created: 0, terminated: 0, messages: 0, peak: 0 };
  const live = new Set<Worker>();
  const evaluations: { postedAt: number; repliedAt: number }[] = [];
  const pendingEvaluations = new Map<string, number>();
  const NativeWorker = window.Worker;
  class CountedWorker extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      workers.created++;
      live.add(this);
      workers.peak = Math.max(workers.peak, live.size);
      this.addEventListener('message', event => {
        const id = (event.data as { id?: unknown } | null)?.id;
        const postedAt = typeof id === 'string' ? pendingEvaluations.get(id) : undefined;
        if (typeof id === 'string' && postedAt !== undefined) {
          pendingEvaluations.delete(id);
          evaluations.push({ postedAt, repliedAt: now() });
          if (evaluations.length > 20_000) evaluations.splice(0, 10_000);
        }
      });
    }
    override postMessage(message: unknown, transfer?: unknown): void {
      workers.messages++;
      const request = message as { type?: unknown; id?: unknown } | null;
      if (request?.type === 'evaluate' && typeof request.id === 'string') pendingEvaluations.set(request.id, now());
      (NativeWorker.prototype.postMessage as (message: unknown, transfer?: unknown) => void).call(this, message, transfer);
    }
    override terminate(): void {
      if (live.delete(this)) workers.terminated++;
      super.terminate();
    }
  }
  window.Worker = CountedWorker as typeof Worker;
  const timers = { set: 0, cleared: 0, fired: 0 };
  const pending = new Map<number, string>();
  const nativeSet = window.setTimeout.bind(window), nativeClear = window.clearTimeout.bind(window);
  window.setTimeout = ((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
    const id: number = nativeSet(() => { pending.delete(id); timers.fired++; if (typeof handler === 'function') (handler as (...rest: unknown[]) => void)(...args); }, ms);
    pending.set(id, phase.value);
    timers.set++;
    return id;
  }) as typeof window.setTimeout;
  window.clearTimeout = ((id?: number) => { if (id !== undefined && pending.delete(id)) timers.cleared++; nativeClear(id); }) as typeof window.clearTimeout;
  const intervals = { set: 0, cleared: 0 };
  const liveIntervals = new Map<number, string>();
  const nativeInterval = window.setInterval.bind(window), nativeClearInterval = window.clearInterval.bind(window);
  window.setInterval = ((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
    const id: number = nativeInterval(handler, ms, ...args);
    liveIntervals.set(id, phase.value);
    intervals.set++;
    return id;
  }) as typeof window.setInterval;
  window.clearInterval = ((id?: number) => { if (id !== undefined && liveIntervals.delete(id)) intervals.cleared++; nativeClearInterval(id); }) as typeof window.clearInterval;
  let raf = 0, shadowRoots = 0, mediaQueryListeners = 0;
  const nativeRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback: FrameRequestCallback) => { raf++; return nativeRaf(callback); };
  const nativeAttach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function attachShadow(this: Element, init: ShadowRootInit) { shadowRoots++; return nativeAttach.call(this, init); };
  const ids = new WeakMap<object, number>();
  let next = 0;
  const keyOf = (type: string, listener: unknown, options: unknown) => {
    if (!listener || (typeof listener !== 'function' && typeof listener !== 'object')) return null;
    if (!ids.has(listener)) ids.set(listener, ++next);
    const capture = typeof options === 'boolean' ? options : !!(options as { capture?: boolean } | undefined)?.capture;
    return `${type}#${ids.get(listener)}${capture ? ':capture' : ''}`;
  };
  const registry = { window: new Map<string, string>(), document: new Map<string, string>() };
  const targets: [keyof typeof registry, EventTarget][] = [['window', window], ['document', document]];
  for (const [name, target] of targets) {
    const add = target.addEventListener.bind(target), remove = target.removeEventListener.bind(target);
    target.addEventListener = (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) => {
      const key = keyOf(type, listener, options);
      if (key && !registry[name].has(key)) registry[name].set(key, phase.value);
      if (listener) add(type, listener, options);
    };
    target.removeEventListener = (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) => {
      const key = keyOf(type, listener, options);
      if (key) registry[name].delete(key);
      if (listener) remove(type, listener, options);
    };
  }
  type Listen = (this: MediaQueryList, ...args: unknown[]) => void;
  const mqlAdd = MediaQueryList.prototype.addEventListener as unknown as Listen, mqlRemove = MediaQueryList.prototype.removeEventListener as unknown as Listen;
  MediaQueryList.prototype.addEventListener = function add(this: MediaQueryList, ...args: unknown[]) { mediaQueryListeners++; mqlAdd.apply(this, args); } as unknown as MediaQueryList['addEventListener'];
  MediaQueryList.prototype.removeEventListener = function remove(this: MediaQueryList, ...args: unknown[]) { mediaQueryListeners--; mqlRemove.apply(this, args); } as unknown as MediaQueryList['removeEventListener'];
  const byPhase = (values: Iterable<string>) => { const out: Record<string, number> = {}; for (const value of values) out[value] = (out[value] ?? 0) + 1; return out; };
  return {
    setPhase(value) { phase.value = value; },
    counts: () => ({
      workers: { ...workers, live: live.size }, timers: { ...timers, pending: byPhase(pending.values()) }, intervals: { ...intervals, live: byPhase(liveIntervals.values()) },
      raf, shadowRoots, mediaQueryListeners,
      listeners: { window: [...registry.window].map(([key, at]) => `${at}:${key}`), document: [...registry.document].map(([key, at]) => `${at}:${key}`) },
    }),
    evaluations,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Timing primitives
// ---------------------------------------------------------------------------------------------------------------------
/** The page's own timer, captured before the instrumentation wraps it: the runner's waits are not counted. */
const nativeTimeout = window.setTimeout.bind(window);
const sleep = (ms: number) => new Promise<void>(resolve => nativeTimeout(resolve, ms));
/** Calls back after the next frame's rendering work (requestAnimationFrame, then a task). */
function afterPaint(callback: (at: number) => void): void {
  requestAnimationFrame(() => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => { channel.port1.close(); callback(now()); };
    channel.port2.postMessage(null);
  });
}
const nextPaint = () => new Promise<number>(resolve => afterPaint(resolve));
async function until<T>(probe: () => T | null | undefined | false, what: string, timeoutMs = 10_000): Promise<T> {
  const start = now();
  for (;;) {
    const value = probe();
    if (value) return value;
    if (now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(2);
  }
}
async function refreshInterval(): Promise<number> {
  const stamps: number[] = [];
  for (let index = 0; index < 61; index++) stamps.push(await new Promise<number>(resolve => requestAnimationFrame(resolve)));
  const deltas = stamps.slice(1).map((value, index) => value - stamps[index]!).sort((a, b) => a - b);
  return round(deltas[Math.floor(deltas.length / 2)]!);
}

/** Native calls as the bridge saw them (start and end in this page's time base). */
interface NativeCall { command: string; ok: boolean; startedAt: number; endedAt: number }
const nativeCalls: NativeCall[] = [];
function recordNativeCalls(): () => void {
  return onCall(record => {
    const endedAt = now();
    nativeCalls.push({ command: record.command, ok: record.ok, startedAt: endedAt - record.ms, endedAt });
    if (nativeCalls.length > 20_000) nativeCalls.splice(0, 10_000);
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Per-card probe: projection publications and DOM commits with their paint time
// ---------------------------------------------------------------------------------------------------------------------
interface Published {
  kind: string | null; frameId: string | null; publishedAt: number; previews: Record<string, number | null>; presentationRevision: number;
  navigation: number | null; ui: string;
}
interface DomCommit { projectionId: string; at: number; paintAt: number | null }
class CardProbe {
  readonly published = new Map<string, Published>();
  readonly dom: DomCommit[] = [];
  notifications = 0;
  private readonly observer: MutationObserver;
  private readonly unsubscribe: () => void;
  constructor(readonly binding: ActivityBinding, readonly root: HTMLElement) {
    const record = (projection: LearnerProjection) => {
      this.notifications++;
      this.published.set(projection.projectionId, {
        kind: projection.frame?.kind ?? null, frameId: projection.frame?.frameId ?? null, publishedAt: now(),
        previews: Object.fromEntries(projection.controls.map(control => [control.parameter, control.previewValue ?? control.value])),
        presentationRevision: projection.presentationRevision, navigation: projection.navigation?.value ?? null, ui: projection.status.ui,
      });
      if (this.published.size > 4000) this.published.delete(this.published.keys().next().value!);
    };
    record(binding.getProjection());
    this.unsubscribe = binding.subscribe(record);
    this.observer = new MutationObserver(() => {
      const projectionId = this.root.dataset.emaProjection;
      if (!projectionId || this.dom.at(-1)?.projectionId === projectionId) return;
      const entry: DomCommit = { projectionId, at: now(), paintAt: null };
      this.dom.push(entry);
      if (this.dom.length > 4000) this.dom.splice(0, 2000);
      afterPaint(at => { entry.paintAt = at; });
    });
    this.observer.observe(root, { attributes: true, attributeFilter: ['data-ema-projection'] });
  }
  /** The first DOM commit at or after `since` whose projection satisfies `test`, once painted. */
  painted(since: number, test: (published: Published) => boolean, timeoutMs = 10_000): Promise<DomCommit & { paintAt: number; published: Published }> {
    return until(() => {
      for (const entry of this.dom) {
        if (entry.at < since || entry.paintAt === null) continue;
        const published = this.published.get(entry.projectionId);
        if (published && test(published)) return { ...entry, paintAt: entry.paintAt, published };
      }
      return null;
    }, 'a painted projection', timeoutMs);
  }
  dispose(): void { this.observer.disconnect(); this.unsubscribe(); }
}

function surfaceRoot(app: ReferenceHostApp): HTMLElement {
  const root = app.surface?.element.shadowRoot?.querySelector<HTMLElement>('[data-ema-surface]');
  if (!root) throw new Error('no mounted learner surface');
  return root;
}
function bindingOf(app: ReferenceHostApp): ActivityBinding {
  if (!app.binding) throw new Error('no learner binding');
  return app.binding;
}
function preparedOf(app: ReferenceHostApp): PreparedActivity {
  if (!app.prepared) throw new Error('no prepared activity');
  return app.prepared;
}
/** A host step of the reference host app; its failure text fails the measurement. */
async function host(step: Promise<string | null>, what: string): Promise<void> {
  const failed = await step;
  if (failed) throw new Error(`${what}: ${failed}`);
}
let operations = 0;
const op = (kind: string) => `perf-${kind}-${++operations}`;

async function openCard(app: ReferenceHostApp, templateId: string): Promise<string> {
  await host(app.openActivity(templateId, '1.0.0'), `open ${templateId}`);
  await until(() => !!app.binding && !!app.surface && !!bindingOf(app).getProjection().frame && bindingOf(app).getProjection().status.ui !== 'preparing', `the ${templateId} card`, 20_000);
  await app.surface!.ready;
  return app.getSnapshot().current!.activityId;
}
const saved = (app: ReferenceHostApp) => until(() => !app.binding || bindingOf(app).getProjection().status.persistence === 'saved', 'the journal to be acknowledged', 15_000);

// ---------------------------------------------------------------------------------------------------------------------
// Lifecycle stress
// ---------------------------------------------------------------------------------------------------------------------
async function lifecycleCycle(app: ReferenceHostApp, index: number, opened: string[]): Promise<void> {
  const quadratic = index % 2 === 0;
  const templateId = quadratic ? 'quadratic-gradient-descent' : 'function-derivative';
  const activityId = await openCard(app, templateId);
  opened.push(activityId);
  if (quadratic) await host(app.transition('explore-step'), `cycle ${index} stage`);
  const binding = bindingOf(app);
  const parameter = quadratic ? 'eta' : 'A';
  const value = quadratic ? 0.5 + (index % 5) * 0.1 : -1 + (index % 5) * 0.5;
  const committed = await binding.commitParameters({ operationId: op('commit'), ...binding.getProjection().guards, displayValues: { [parameter]: value } });
  if (!committed.ok) throw new Error(`cycle ${index} commit: ${committed.diagnostics.map(item => item.code).join(', ')}`);
  if (quadratic) {
    const moved = await binding.navigate({ operationId: op('nav'), ...binding.getProjection().guards, position: { kind: 'index', index: 3 } });
    if (!moved.ok) throw new Error(`cycle ${index} navigate: ${moved.diagnostics.map(item => item.code).join(', ')}`);
  }
  const suspended = preparedOf(app).host.suspend({ operationId: op('suspend'), reason: 'host' });
  if (!suspended.ok) throw new Error(`cycle ${index} suspend: ${suspended.diagnostics.map(item => item.code).join(', ')}`);
  await host(app.save(), `cycle ${index} save`);
  await app.idle();
  await saved(app);
  app.detach();
  await host(app.reopen(activityId), `cycle ${index} restore`);
  await until(() => !!app.binding && !!app.surface && !!bindingOf(app).getProjection().frame, `cycle ${index} restored card`, 20_000);
  await app.surface!.ready;
  const prepared = preparedOf(app);
  if (!prepared.host.suspend({ operationId: op('suspend'), reason: 'host' }).ok || !prepared.host.resume({ operationId: op('resume') }).ok) throw new Error(`cycle ${index} suspend/resume`);
  await app.idle();
  await saved(app);
  app.detach();
}

async function lifecycle(app: ReferenceHostApp, meter: Instrument) {
  const opened: string[] = [];
  // One warm-up cycle first: React DOM registers its per-document listeners once, on the first root of a document,
  // and never removes them; they belong to the page, not to an activity (as in the Chromium benchmark).
  meter.setPhase('warmup');
  await lifecycleCycle(app, 0, opened);
  meter.setPhase('load');
  await sleep(300);
  const before = meter.counts();
  meter.setPhase('cycles');
  const durations: number[] = [];
  for (let index = 0; index < LIFECYCLE_CYCLES; index++) {
    const started = now();
    await lifecycleCycle(app, index, opened);
    durations.push(round(now() - started));
  }
  meter.setPhase('after');
  await sleep(600);
  await nextPaint();
  const after = meter.counts();
  const fromCycles = (list: string[]) => list.filter(entry => entry.startsWith('cycles:'));
  const stillOpen = opened.slice(1).filter(id => {
    const state = app.visualizer.getState(id, 'learner') as { ok?: boolean; projection?: LearnerProjection };
    return !(state.ok === false) && state.projection?.status.ui !== 'disposed';
  }).length;
  return {
    cycles: durations.length, durationsMs: durations,
    workers: { created: after.workers.created - before.workers.created, terminated: after.workers.terminated - before.workers.terminated, liveBefore: before.workers.live, liveAfter: after.workers.live, peak: after.workers.peak },
    timersPendingFromCycles: after.timers.pending.cycles ?? 0, intervalsLiveFromCycles: after.intervals.live.cycles ?? 0,
    windowListenersFromCycles: fromCycles(after.listeners.window), documentListenersFromCycles: fromCycles(after.listeners.document),
    mediaQueryListenersNet: after.mediaQueryListeners - before.mediaQueryListeners, shadowRootsAttached: after.shadowRoots - before.shadowRoots,
    connectedSurfacesAfter: document.querySelectorAll('[data-explorable-models-activity]').length,
    adapterActivitiesStillOpen: stillOpen,
    activitiesOpened: opened.length,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Commit series
// ---------------------------------------------------------------------------------------------------------------------
interface CommandSample {
  ok: boolean; codes: string[]; totalMs: number | null; commandMs: number; workerMs: number | null; renderMs: number | null; paintMs: number | null;
  /** The native `append_events` call that carried the command's journal batch: start → durable acknowledgement. */
  storageAckMs: number | null;
  /** Command call → durable acknowledgement of that batch by the native host. */
  durableAfterMs: number | null;
}
async function commitSeries(app: ReferenceHostApp, probe: CardProbe, meter: Instrument, parameter: string, values: number[]): Promise<CommandSample[]> {
  const samples: CommandSample[] = [];
  for (let index = 0; index < COMMIT_WARMUP + COMMIT_SAMPLES; index++) {
    const binding = bindingOf(app);
    const before = binding.getProjection();
    const evaluationsBefore = meter.evaluations.length;
    const t0 = now();
    const outcome = await binding.commitParameters({ operationId: op('commit'), ...before.guards, displayValues: { [parameter]: values[index % values.length]! } });
    const commandMs = now() - t0;
    let sample: CommandSample;
    if (!outcome.ok) sample = { ok: false, codes: outcome.diagnostics.map(item => item.code), totalMs: null, commandMs, workerMs: null, renderMs: null, paintMs: null, storageAckMs: null, durableAfterMs: null };
    else {
      const shown = await probe.painted(t0, published => published.kind === 'committed' && published.frameId !== before.frame?.frameId);
      const evaluation = meter.evaluations.slice(evaluationsBefore).find(item => item.postedAt >= t0) ?? null;
      const append = await until(() => nativeCalls.find(call => call.command === 'append_events' && call.startedAt >= t0), 'the journal append', 15_000).catch(() => null);
      sample = {
        ok: true, codes: [], totalMs: round(shown.paintAt - t0), commandMs: round(commandMs), workerMs: evaluation ? round(evaluation.repliedAt - evaluation.postedAt) : null,
        renderMs: round(shown.at - shown.published.publishedAt), paintMs: round(shown.paintAt - shown.at),
        storageAckMs: append ? round(append.endedAt - append.startedAt) : null, durableAfterMs: append ? round(append.endedAt - t0) : null,
      };
    }
    if (index >= COMMIT_WARMUP) samples.push(sample);
    await saved(app);
    await sleep(40);
  }
  return samples;
}

// ---------------------------------------------------------------------------------------------------------------------
// Scripted slider drags (DOM pointer and input events on the real control, 60 Hz pacing)
// ---------------------------------------------------------------------------------------------------------------------
interface InputRecord { t: number; value: number; ackAt: number | null; exact: boolean }
const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
function pointer(type: string, target: Element, x: number, y: number, buttons: number): void {
  target.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons, clientX: x, clientY: y, bubbles: true, cancelable: true, composed: true }));
}
async function drag(app: ReferenceHostApp, probe: CardProbe, meter: Instrument, parameter: string, refreshMs: number) {
  const root = surfaceRoot(app);
  const control = root.querySelector<HTMLElement>(`[data-parameter="${parameter}"]`);
  const slider = control?.querySelector<HTMLInputElement>('input[type="range"]');
  const output = control?.querySelector<HTMLOutputElement>('output');
  if (!slider || !output) throw new Error(`no slider for ${parameter}`);
  slider.scrollIntoView({ block: 'center' });
  await nextPaint();
  const min = Number(slider.min), max = Number(slider.max), step = slider.step === 'any' ? 0 : Number(slider.step);
  const quantize = (value: number) => step > 0 ? Math.round(Math.round((value - min) / step) * step * 1e9) / 1e9 + min : value;
  const rect = slider.getBoundingClientRect();
  const y = rect.y + rect.height / 2, xAt = (fraction: number) => rect.x + 8 + (rect.width - 16) * fraction;
  const inputs: InputRecord[] = [], frames: number[] = [];
  let running = true;
  const displayed = () => { const text = (output.textContent ?? '').replace(/preview/g, '').replace('−', '-').replace(/[^0-9.\-]/g, ''); const value = Number.parseFloat(text); return Number.isFinite(value) ? value : null; };
  const frame = (stamp: number) => {
    if (!running) return;
    frames.push(stamp);
    const shown = displayed();
    if (shown !== null) {
      // The latest input whose value the output shows: it and every earlier input are acknowledged by this frame.
      let last = -1;
      for (let index = inputs.length - 1; index >= 0; index--) if (Math.abs(inputs[index]!.value - shown) <= 1e-9 * Math.max(1, Math.abs(shown))) { last = index; break; }
      const pending = inputs.slice(0, last + 1).filter(item => item.ackAt === null);
      if (pending.length) {
        pending.at(-1)!.exact = true;
        const channel = new MessageChannel();
        channel.port1.onmessage = () => { channel.port1.close(); const at = now(); for (const item of pending) item.ackAt = at; };
        channel.port2.postMessage(null);
      }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  const messagesBefore = meter.counts().workers.messages, evaluationsBefore = meter.evaluations.length;
  const from = 0.05, to = 0.95, sweep = 30, interval = 1000 / INPUT_HZ;
  pointer('pointerdown', slider, xAt(from), y, 1);
  const start = now();
  for (let index = 1; index <= DRAG_MOVES; index++) {
    const phase = (index % (2 * sweep)) / sweep;
    const fraction = phase <= 1 ? from + (to - from) * phase : to - (to - from) * (phase - 1);
    const value = quantize(min + (max - min) * fraction);
    pointer('pointermove', slider, xAt(fraction), y, 1);
    if (Number(slider.value) !== value) {
      valueSetter.call(slider, String(value));
      inputs.push({ t: now(), value: Number(slider.value), ackAt: null, exact: false });
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const wait = start + index * interval - now();
    if (wait > 0) await sleep(wait);
  }
  const sentMs = now() - start;
  pointer('pointerup', slider, xAt(to), y, 0);
  const binding = bindingOf(app);
  await until(() => !binding.getProjection().preview && binding.getProjection().frame?.kind === 'committed', 'the release to commit', 15_000).catch(() => undefined);
  await saved(app).catch(() => undefined);
  await nextPaint();
  running = false;
  const first = inputs[0]?.t ?? start, last = inputs.at(-1)?.t ?? first;
  const windowFrames = frames.filter(stamp => stamp >= first && stamp <= last + refreshMs);
  const deltas = windowFrames.slice(1).map((value, index) => round(value - windowFrames[index]!));
  const dropped = deltas.reduce((sum, delta) => sum + Math.max(0, Math.round(delta / refreshMs) - 1), 0);
  const tentative = probe.dom.filter(entry => entry.at >= first && entry.paintAt !== null).map(entry => ({ entry, published: probe.published.get(entry.projectionId) }))
    .filter(item => item.published?.kind === 'tentative');
  const distinct = tentative.filter((item, index) => index === 0 || item.published!.frameId !== tentative[index - 1]!.published!.frameId);
  const previewLatency = distinct.map(item => {
    const value = item.published!.previews[parameter];
    const source = [...inputs].reverse().find(record => record.t <= item.entry.at && value !== null && value !== undefined && Math.abs(record.value - value) <= 1e-9 * Math.max(1, Math.abs(value)));
    return source ? round(item.entry.paintAt! - source.t) : null;
  }).filter((value): value is number => value !== null);
  const durationMs = last - first;
  return {
    inputEvents: inputs.length, sentMs: round(sentMs), durationMs: round(durationMs), inputRateHz: durationMs > 0 ? round((inputs.length - 1) / (durationMs / 1000)) : null,
    inputAckMs: inputs.filter(item => item.ackAt !== null).map(item => round(item.ackAt! - item.t)), unacknowledged: inputs.filter(item => item.ackAt === null).length,
    exactlyShown: inputs.filter(item => item.exact).length,
    frames: windowFrames.length, frameRateFps: deltas.length ? round(deltas.length / (deltas.reduce((a, b) => a + b, 0) / 1000)) : null, frameDeltasMs: deltas, droppedFrames: dropped,
    tentativeFramesPainted: distinct.length, previewUpdateRateHz: durationMs > 0 ? round(distinct.length / (durationMs / 1000)) : null, previewLatencyMs: previewLatency,
    workerMessages: meter.counts().workers.messages - messagesBefore, evaluationMs: meter.evaluations.slice(evaluationsBefore).map(item => round(item.repliedAt - item.postedAt)),
    committedValue: binding.getProjection().controls.find(item => item.parameter === parameter)?.value ?? null,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Suspension: no work during a quiet window; resume from the declared state
// ---------------------------------------------------------------------------------------------------------------------
/** Counts DOM mutations under `root` until stopped, with a summary of the first records (never their text content). */
function watchMutations(root: Node) {
  let count = 0, lastAtMs: number | null = null;
  const sample: { type: string; target: string; attribute: string | null; atMs: number }[] = [];
  const describe = (node: Node): string => {
    const element = node instanceof Element ? node : node.parentElement;
    if (!element) return node.nodeName;
    const data = [...element.attributes].filter(attribute => attribute.name.startsWith('data-')).map(attribute => attribute.name).slice(0, 3).join(',');
    return `${element.nodeName.toLowerCase()}${element.classList.length ? `.${[...element.classList].slice(0, 2).join('.')}` : ''}${data ? `[${data}]` : ''}${node === element ? '' : ` ${node.nodeName}`}`;
  };
  const started = now();
  const observer = new MutationObserver(records => {
    count += records.length;
    lastAtMs = round(now() - started);
    for (const record of records) if (sample.length < 24) sample.push({ type: record.type, target: describe(record.target), attribute: record.attributeName, atMs: lastAtMs });
  });
  observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
  return { stop: () => { observer.disconnect(); return { count, lastAtMs, sample }; } };
}

async function quietWindow(app: ReferenceHostApp, probe: CardProbe, meter: Instrument, viewId: string | null) {
  const mutations = watchMutations(app.surface!.element.shadowRoot!);
  const counts = meter.counts();
  const before = { messages: counts.workers.messages, evaluations: meter.evaluations.length, notifications: probe.notifications, raf: counts.raf, calls: nativeCalls.length, frames: rendererFrames(viewId) };
  await sleep(QUIET_WINDOW_MS);
  const changed = mutations.stop();
  const after = meter.counts();
  return {
    windowMs: QUIET_WINDOW_MS, ui: bindingOf(app).getProjection().status.ui, workerMessages: after.workers.messages - before.messages, evaluations: meter.evaluations.length - before.evaluations,
    domMutations: changed.count, mutationSample: changed.sample, notifications: probe.notifications - before.notifications, nativeCalls: nativeCalls.length - before.calls,
    rendererFrames: viewId === null ? null : (rendererFrames(viewId) ?? 0) - (before.frames ?? 0),
    pageAnimationFrames: after.raf - before.raf, liveWorkers: after.workers.live,
  };
}

/**
 * Suspends and waits for the suspension to settle (SETTLE_MS: the work a suspension may finish, such as the card's
 * own state change and announcement, recorded separately as `settling`), then measures the quiet window.
 */
async function settleThenQuiet(app: ReferenceHostApp, probe: CardProbe, meter: Instrument, viewId: string | null) {
  const settling = watchMutations(app.surface!.element.shadowRoot!);
  await sleep(SETTLE_MS);
  const settled = settling.stop();
  const quiet = await quietWindow(app, probe, meter, viewId);
  return { settling: { ms: SETTLE_MS, domMutations: settled.count, lastMutationAtMs: settled.lastAtMs, mutationSample: settled.sample }, quiet };
}

async function suspension(app: ReferenceHostApp, probe: CardProbe, meter: Instrument, kind: 'host' | 'hidden-window') {
  const binding = bindingOf(app);
  // Playback from the first iteration, so the activity is still playing when it is suspended.
  const rewound = await binding.navigate({ operationId: op('nav'), ...binding.getProjection().guards, position: { kind: 'index', index: 0 } });
  if (!rewound.ok) throw new Error(`navigate refused: ${rewound.diagnostics.map(item => item.code).join(', ')}`);
  await saved(app);
  const played = binding.play({ operationId: op('play'), ...binding.getProjection().guards });
  if (!played.ok) throw new Error(`play refused: ${played.diagnostics.map(item => item.code).join(', ')}`);
  await sleep(700);
  const playingBefore = binding.getProjection().navigation?.playing ?? false;
  if (kind === 'host') {
    const suspended = preparedOf(app).host.suspend({ operationId: op('suspend'), reason: 'host' });
    if (!suspended.ok) throw new Error(`suspend refused: ${suspended.diagnostics.map(item => item.code).join(', ')}`);
  } else {
    await call('conformance_window', { action: 'hide' });
    await until(() => document.visibilityState === 'hidden', 'document.visibilityState hidden', 5000);
  }
  const { settling, quiet } = await settleThenQuiet(app, probe, meter, null);
  const atSuspension = { ui: binding.getProjection().status.ui, playing: binding.getProjection().navigation?.playing ?? null, index: binding.getProjection().navigation?.value ?? null };
  if (kind === 'host') {
    const resumed = preparedOf(app).host.resume({ operationId: op('resume') });
    if (!resumed.ok) throw new Error(`resume refused: ${resumed.diagnostics.map(item => item.code).join(', ')}`);
  } else {
    await call('conformance_window', { action: 'show' });
    await until(() => document.visibilityState === 'visible', 'document.visibilityState visible', 5000);
  }
  await sleep(700);
  const afterResume = { ui: binding.getProjection().status.ui, playing: binding.getProjection().navigation?.playing ?? null, index: binding.getProjection().navigation?.value ?? null };
  const pause = binding.getProjection().navigation?.playing ? binding.pause({ operationId: op('pause'), ...binding.getProjection().guards }) : null;
  return { kind, playingBefore, atSuspension, settling, quiet, afterResume, pausedAfter: pause ? pause.ok : null };
}

// ---------------------------------------------------------------------------------------------------------------------
// Spatial: orbit input, camera command, suspended renderer
// ---------------------------------------------------------------------------------------------------------------------
function rendererFrames(viewId: string | null): number | null {
  if (viewId === null) return null;
  const record = spatialRecords().filter(item => item.viewId === viewId && item.disposedAtMs === null).at(-1);
  const frames = record?.stats()?.frames;
  return typeof frames === 'number' ? frames : null;
}
async function rendererFrameAfter(viewId: string, frames: number): Promise<number> {
  await until(() => (rendererFrames(viewId) ?? -1) > frames, 'a renderer frame', 5000);
  return nextPaint();
}

async function orbit(viewport: HTMLElement, viewId: string) {
  viewport.scrollIntoView({ block: 'center' });
  await nextPaint();
  const rect = viewport.getBoundingClientRect();
  const moves: { t: number; ackAt: number | null }[] = [], frames: number[] = [];
  let running = true, lastFrames = rendererFrames(viewId) ?? 0;
  const framesBefore = lastFrames;
  const tick = (stamp: number) => {
    if (!running) return;
    frames.push(stamp);
    const current = rendererFrames(viewId) ?? lastFrames;
    if (current > lastFrames) {
      lastFrames = current;
      const pending = moves.filter(move => move.ackAt === null);
      afterPaint(at => { for (const move of pending) if (move.ackAt === null) move.ackAt = at; });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  const interval = 1000 / INPUT_HZ;
  const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
  pointer('pointerdown', viewport, cx, cy, 1);
  const start = now();
  for (let index = 1; index <= ORBIT_MOVES; index++) {
    const dx = (index % 30 < 15 ? 4 : -4);
    moves.push({ t: now(), ackAt: null });
    pointer('pointermove', viewport, cx + dx * (index % 15), cy + (index % 2), 1);
    const wait = start + index * interval - now();
    if (wait > 0) await sleep(wait);
  }
  pointer('pointerup', viewport, cx, cy, 0);
  await sleep(250);
  await nextPaint();
  running = false;
  const first = moves[0]?.t ?? start, last = moves.at(-1)?.t ?? first;
  const windowFrames = frames.filter(stamp => stamp >= first && stamp <= last);
  const deltas = windowFrames.slice(1).map((value, index) => value - windowFrames[index]!);
  return {
    moves: moves.length, durationMs: round(last - first), inputAckMs: moves.filter(move => move.ackAt !== null).map(move => round(move.ackAt! - move.t)),
    unacknowledged: moves.filter(move => move.ackAt === null).length, rendererFrames: (rendererFrames(viewId) ?? 0) - framesBefore,
    frameRateFps: deltas.length ? round(deltas.length / (deltas.reduce((a, b) => a + b, 0) / 1000)) : null,
  };
}

async function cameraSeries(app: ReferenceHostApp, probe: CardProbe, viewId: string) {
  const cameras: Camera3D[] = [
    { kind: '3d', projection: 'perspective', position: [6, 4, 5], target: [0, 0, 0], up: [0, 0, 1], preset: null },
    { kind: '3d', projection: 'perspective', position: [5, -4, 6], target: [0, 0, 0], up: [0, 0, 1], preset: null },
  ];
  const samples: { ok: boolean; codes: string[]; domMs: number | null; rendererFrameMs: number | null }[] = [];
  for (let index = 0; index < CAMERA_WARMUP + CAMERA_SAMPLES; index++) {
    const binding = bindingOf(app);
    const before = binding.getProjection();
    const frames = rendererFrames(viewId) ?? 0;
    const t0 = now();
    const outcome = binding.setCamera({ operationId: op('camera'), expectedPresentationRevision: before.presentationRevision, viewId, camera: cameras[index % 2]! });
    if (!outcome.ok) { if (index >= CAMERA_WARMUP) samples.push({ ok: false, codes: outcome.diagnostics.map(item => item.code), domMs: null, rendererFrameMs: null }); continue; }
    const shown = await probe.painted(t0, published => published.presentationRevision > before.presentationRevision);
    const rendered = await rendererFrameAfter(viewId, frames);
    if (index >= CAMERA_WARMUP) samples.push({ ok: true, codes: [], domMs: round(shown.at - t0), rendererFrameMs: round(rendered - t0) });
    await saved(app);
  }
  return samples;
}

async function spatialActivity(app: ReferenceHostApp, meter: Instrument, templateId: string) {
  await openCard(app, templateId);
  const root = app.surface!.element.shadowRoot!;
  const host = await until(() => root.querySelector<HTMLElement>('[data-ema-spatial]'), 'the spatial view', 15_000);
  host.scrollIntoView({ block: 'center' });
  const viewId = host.dataset.emaSpatial!;
  // The view reads `fallback` until the lazily loaded renderer mounts (it loads once the view is on screen); a real
  // fallback or failure stays. Wait for `ready` and record whatever state the view settled in otherwise.
  const state = await until(() => ['ready', 'failed'].includes(host.dataset.emaSpatialState ?? '') ? host.dataset.emaSpatialState! : null, 'the spatial renderer', 20_000)
    .catch(() => host.dataset.emaSpatialState ?? 'none');
  if (state !== 'ready') return { templateId, spatialState: state, note: (host.querySelector('[data-state="spatial-fallback"]')?.textContent ?? '').slice(0, 200) };
  await until(() => (rendererFrames(viewId) ?? 0) > 0, 'the first renderer frame', 15_000);
  const viewport = host.querySelector<HTMLElement>('.em3-viewport') ?? host.shadowRoot?.querySelector<HTMLElement>('.em3-viewport') ?? null;
  if (!viewport) throw new Error('no 3D viewport element');
  const probe = new CardProbe(bindingOf(app), surfaceRoot(app));
  try {
    const orbits = [];
    for (let index = 0; index < ORBIT_DRAGS; index++) {
      orbits.push(await orbit(viewport, viewId));
      await saved(app);
      await sleep(150);
    }
    const camera = await cameraSeries(app, probe, viewId);
    // A host-suspended spatial card draws nothing.
    const suspended = preparedOf(app).host.suspend({ operationId: op('suspend'), reason: 'host' });
    if (!suspended.ok) throw new Error(`suspend refused: ${suspended.diagnostics.map(item => item.code).join(', ')}`);
    const { settling, quiet } = await settleThenQuiet(app, probe, meter, viewId);
    preparedOf(app).host.resume({ operationId: op('resume') });
    return { templateId, spatialState: state, viewId, orbits, camera, settling, quiet };
  } finally {
    probe.dispose();
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------------------------------------------------
function webglRenderer(): string | null {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) return null;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return renderer;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------------------------------------------------
export async function performanceScenario(app: ReferenceHostApp, report: ScenarioReport, windowVisible: () => boolean): Promise<boolean> {
  const result: Record<string, unknown> = { errors: [] as { part: string; error: string }[] };
  const errors = result.errors as { part: string; error: string }[];
  const publish = () => { report.data.performance = toJson(result); };
  if (!windowVisible()) {
    // A hidden window runs no animation frames or previews (WebKit): nothing here can be measured.
    result.skipped = { reason: 'WebKit reported the window hidden at the start of the scenario', visibilityState: document.visibilityState };
    publish();
    return true;
  }
  const meter = instrument();
  const stopCalls = recordNativeCalls();
  try {
    result.environment = {
      userAgent: navigator.userAgent, devicePixelRatio, hardwareConcurrency: navigator.hardwareConcurrency, viewport: { width: innerWidth, height: innerHeight },
      refreshIntervalMs: await refreshInterval(), webglRenderer: webglRenderer(), reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      inputs: 'DOM pointer/input events dispatched by the runner at a 60 Hz pacing (not OS-level input)',
    };
    publish();
    /** One measured part as a runner step; a part that throws is recorded and the next part still runs. */
    const run = async (part: string, measure: () => Promise<unknown>, store: (value: unknown) => void) => {
      const ok = await report.step(`performance-${part}`, async () => { store(await measure()); return null; });
      if (!ok) errors.push({ part, error: 'the measurement threw; see the step error' });
      publish();
      await app.idle();
      if (app.prepared) app.detach();
      return ok;
    };
    await run('lifecycle', () => lifecycle(app, meter), value => { result.lifecycle = value; });
    await run('twoD', async () => {
      const activityId = await openCard(app, 'quadratic-gradient-descent');
      await host(app.submitResponse('Small steps should shrink the positions; larger steps may overshoot and grow.'), 'prediction');
      await host(app.transition('explore-step'), 'stage explore-step');
      await host(app.reveal(), 'reveal');
      await until(() => app.heldBackGroups().length === 0 && (app.hostState()?.exposures ?? []).some(record => record.scope === 'reveal' && record.displayStatus === 'displayed'), 'the displayed reveal', 15_000);
      await host(app.authorizeExploration(), 'exploration scope');
      await saved(app);
      const probe = new CardProbe(bindingOf(app), surfaceRoot(app));
      try {
        const refreshMs = (result.environment as { refreshIntervalMs: number }).refreshIntervalMs;
        const out: Record<string, unknown> = { activityId };
        out.commit = await commitSeries(app, probe, meter, 'eta', [0.5, 0.6]);
        out.drags = [];
        for (let index = 0; index < DRAGS; index++) {
          (out.drags as unknown[]).push(await drag(app, probe, meter, 'eta', refreshMs));
          await sleep(200);
        }
        out.hostSuspension = await suspension(app, probe, meter, 'host');
        out.hiddenWindow = await suspension(app, probe, meter, 'hidden-window');
        return out;
      } finally {
        probe.dispose();
      }
    }, value => { result.twoD = value; });
    const spatial: Record<string, unknown> = {};
    result.spatial = spatial;
    for (const templateId of SPATIAL_TEMPLATES) await run(`spatial-${templateId}`, () => spatialActivity(app, meter, templateId), value => { spatial[templateId] = value; });
    result.spatialRecords = spatialRecords().map(item => ({ viewId: item.viewId, disposed: item.disposedAtMs !== null, stats: item.stats() }));
    result.finalCounts = meter.counts();
  } catch (error) {
    errors.push({ part: 'scenario', error: errorText(error) });
  } finally {
    stopCalls();
    publish();
  }
  return errors.length === 0;
}
