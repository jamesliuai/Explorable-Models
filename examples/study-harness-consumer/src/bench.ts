/**
 * BENCHMARK FIXTURE PAGE of the packed consumer (report §18). Driven by scripts/study-harness/benchmark.mjs against the
 * production build; not a Study Harness host and not part of the measured activity entry. It mounts real learner cards
 * (`createStudyHarnessVisualizer` + `mountStudyActivity`) over the installed catalogue's own kernel module workers and
 * the in-memory fixture host, and the legacy schema 2.0 document player for the document-path workloads.
 *
 * Measurement primitives (all in-page, `performance.now()` time base):
 * - `paint`: a requestAnimationFrame callback followed by a MessageChannel task, i.e. after the frame's rendering work;
 * - projection publication: the learner binding's subscription callback;
 * - DOM commit: a MutationObserver on the surface root's `data-eka-projection` attribute (the projection now in the DOM);
 * - worker evaluation: the catalogue worker is wrapped (`MeasuredWorker`) to time each `evaluate` request from
 *   postMessage to its reply, and optionally to hold replies (`workerDelayMs`, the slow-evaluator scenario);
 * - storage acknowledgement: the fixture host's own call log (`appendEvents`, `recordExposureIntent`, `recordDisplayAck`).
 */
import type { Camera3D, CommandOutcome, LearnerProjection } from '@experiment-kit/activity';
import { createLazyCatalog } from '@experiment-kit/catalog';
import { createPreset, createVisualizationSession, type VisualizationSession } from '@experiment-kit/core/declarative';
import { mountVisualization } from '@experiment-kit/player';
import { createStudyHarnessVisualizer, mountStudyActivity, type SpatialRendererModule } from '@experiment-kit/player/activity';
import { ConsumerHost, type HostMethod } from './host';
import { ConsumerSession, type CardMounter, type OpenCard } from './session';
import './page.css';

// ---------------------------------------------------------------------------------------------------------------------
// Timing primitives
// ---------------------------------------------------------------------------------------------------------------------
const now = () => performance.now();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** Calls back after the next frame's rendering work (rAF, then a task). */
function afterPaint(callback: (at: number) => void): void {
  requestAnimationFrame(() => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => { channel.port1.close(); callback(now()); };
    channel.port2.postMessage(null);
  });
}
const nextPaint = () => new Promise<number>(resolve => afterPaint(resolve));
async function until<T>(probe: () => T | null | undefined | false, timeoutMs = 10_000, what = 'condition'): Promise<T> {
  const start = now();
  for (;;) {
    const value = probe();
    if (value) return value;
    if (now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}.`);
    await sleep(2);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Catalogue worker wrapper: evaluation timing and optional reply delay (slow evaluator)
// ---------------------------------------------------------------------------------------------------------------------
interface Evaluation { id: string; postedAt: number; repliedAt: number; deliveredAt: number }
const workerStats = { created: 0, terminated: 0, live: 0, peak: 0, messages: 0, delayMs: 0, evaluations: [] as Evaluation[], pending: new Map<string, number>() };
class MeasuredWorker extends EventTarget {
  private terminated = false;
  private readonly detach: () => void;
  constructor(private readonly worker: Worker) {
    super();
    workerStats.created++;
    workerStats.live++;
    workerStats.peak = Math.max(workerStats.peak, workerStats.live);
    const forward = (event: Event) => {
      const repliedAt = now();
      const data = (event as MessageEvent).data as { id?: unknown } | undefined;
      if (event.type === 'error') event.preventDefault();
      const copy = event.type === 'error' ? new Event('error') : new MessageEvent(event.type, { data });
      const deliver = () => {
        if (this.terminated) return;
        const id = typeof data?.id === 'string' ? data.id : null;
        const postedAt = id === null ? undefined : workerStats.pending.get(id);
        if (id !== null && postedAt !== undefined) {
          workerStats.pending.delete(id);
          workerStats.evaluations.push({ id, postedAt, repliedAt, deliveredAt: now() });
          if (workerStats.evaluations.length > 10_000) workerStats.evaluations.splice(0, 5_000);
        }
        this.dispatchEvent(copy);
      };
      if (workerStats.delayMs > 0) setTimeout(deliver, workerStats.delayMs); else deliver();
    };
    for (const type of ['message', 'messageerror', 'error']) worker.addEventListener(type, forward);
    this.detach = () => { for (const type of ['message', 'messageerror', 'error']) worker.removeEventListener(type, forward); };
  }
  postMessage(message: unknown): void {
    if (this.terminated) return;
    workerStats.messages++;
    const request = message as { type?: unknown; id?: unknown } | null;
    if (request?.type === 'evaluate' && typeof request.id === 'string') workerStats.pending.set(request.id, now());
    this.worker.postMessage(message);
  }
  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    workerStats.terminated++;
    workerStats.live--;
    this.detach();
    this.worker.terminate();
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Page setup
// ---------------------------------------------------------------------------------------------------------------------
const installed = createLazyCatalog();
const catalog = createLazyCatalog({ workerFactory: () => new MeasuredWorker(installed.createWorker()) as unknown as Worker });
let spatialModule: (SpatialRendererModule & { inspect?(element: Element): { stats: { frames: number } & Record<string, number | string> } | null }) | null = null;
const spatialLoads: number[] = [];
const spatialLoader = async (): Promise<SpatialRendererModule> => {
  spatialLoads.push(now());
  const module = await import('@experiment-kit/player-3d');
  spatialModule = module as unknown as typeof spatialModule;
  return module;
};
export const MAX_WORKERS = 6;
const region = (id: string) => document.getElementById(id)!;
const diagnostics: unknown[] = [];

function createRuntime(options: { outboxLimit?: number } = {}) {
  const host = new ConsumerHost(catalog);
  const visualizer = createStudyHarnessVisualizer({
    catalog, host, maxWorkers: MAX_WORKERS, ...(options.outboxLimit ? { outboxLimit: options.outboxLimit } : {}), mountSurface: mountStudyActivity,
    surfaceDefaults: { theme: 'light', fonts: 'bundled', headingLevel: 3, spatialLoader, onDiagnostic: diagnostic => { if (diagnostics.length < 500) diagnostics.push(diagnostic); } },
  });
  const mount: CardMounter = (container, prepared, surfaceId) => visualizer.mount(container, prepared, { surfaceId });
  const session = new ConsumerSession({
    catalog, host, mount, container: region('active'),
    prepare: (request, input) => visualizer.prepare(request, input),
    restore: (artifact, input) => visualizer.restore(artifact, input),
    release: activityId => visualizer.dispose(activityId),
  });
  return { host, visualizer, session };
}
const main = createRuntime();

// ---------------------------------------------------------------------------------------------------------------------
// Per-card probe: projection publications and DOM commits with their paint time
// ---------------------------------------------------------------------------------------------------------------------
interface Published {
  projectionId: string; frameId: string | null; kind: string | null; publishedAt: number; previews: Record<string, number | null>; ui: string; persistence: string;
  activityRevision: number; presentationRevision: number; views: string[];
}
interface DomCommit { projectionId: string; at: number; paintAt: number | null }
class Probe {
  readonly published = new Map<string, Published>();
  readonly dom: DomCommit[] = [];
  notifications = 0;
  private readonly observer: MutationObserver;
  private readonly unsubscribe: () => void;
  constructor(readonly card: OpenCard, readonly root: HTMLElement) {
    const record = (projection: LearnerProjection) => {
      this.notifications++;
      this.published.set(projection.projectionId, {
        projectionId: projection.projectionId, frameId: projection.frame?.frameId ?? null, kind: projection.frame?.kind ?? null, publishedAt: now(),
        // The parameter value the frame shows: the tentative value, or the committed one when they are equal (no badge).
        previews: Object.fromEntries(projection.controls.map(control => [control.parameter, control.previewValue ?? control.value])), ui: projection.status.ui, persistence: projection.status.persistence,
        activityRevision: projection.activityRevision, presentationRevision: projection.presentationRevision, views: projection.views.map(view => view.viewId),
      });
      if (this.published.size > 4000) this.published.delete(this.published.keys().next().value!);
    };
    record(card.learner.getProjection());
    this.unsubscribe = card.learner.subscribe(record);
    this.observer = new MutationObserver(() => {
      const projectionId = this.root.dataset.ekaProjection;
      if (!projectionId || this.dom.at(-1)?.projectionId === projectionId) return;
      const entry: DomCommit = { projectionId, at: now(), paintAt: null };
      this.dom.push(entry);
      if (this.dom.length > 4000) this.dom.splice(0, 2000);
      afterPaint(at => { entry.paintAt = at; });
    });
    this.observer.observe(root, { attributes: true, attributeFilter: ['data-eka-projection'] });
  }
  /** First DOM commit at or after `since` whose projection satisfies `test`, once painted. */
  painted(since: number, test: (published: Published) => boolean, timeoutMs = 10_000): Promise<DomCommit & { paintAt: number; published: Published }> {
    return until(() => {
      for (const entry of this.dom) {
        if (entry.at < since || entry.paintAt === null) continue;
        const published = this.published.get(entry.projectionId);
        if (published && test(published)) return { ...entry, paintAt: entry.paintAt, published };
      }
      return null;
    }, timeoutMs, 'a painted projection');
  }
  dispose(): void { this.observer.disconnect(); this.unsubscribe(); }
}
const probes = new Map<string, Probe>();
function probeOf(activityId: string, session = main.session): Probe {
  let probe = probes.get(activityId);
  if (!probe) {
    const card = session.card(activityId);
    probe = new Probe(card, session.surfaceRoot(activityId)!);
    probes.set(activityId, probe);
  }
  return probe;
}
function forget(activityId: string): void { probes.get(activityId)?.dispose(); probes.delete(activityId); }

// ---------------------------------------------------------------------------------------------------------------------
// Command measurement
// ---------------------------------------------------------------------------------------------------------------------
export interface CommandSample {
  ok: boolean; codes: string[];
  /** Command call → paint of the first frame showing the result. */
  totalMs: number | null;
  /** Command call → promise resolution. */
  commandMs: number;
  /** Worker evaluation: postMessage → reply received (and → delivered, which includes an injected delay). */
  workerMs: number | null; workerDeliveredMs: number | null;
  /** Projection publication → DOM commit, and DOM commit → paint. */
  renderMs: number | null; paintMs: number | null;
  /** Durable host acknowledgement of the journal batch that carries the command's evidence (separate from the visible frame). */
  storageAckMs: number | null;
}
async function measureCommand(
  activityId: string, run: () => Promise<CommandOutcome> | CommandOutcome, test: (published: Published, before: LearnerProjection) => boolean, session = main.session, awaitStorage = true,
): Promise<CommandSample> {
  const probe = probeOf(activityId, session);
  const before = session.projection(activityId);
  const evaluationsBefore = workerStats.evaluations.length;
  const t0 = now();
  const outcome = await run();
  const commandMs = now() - t0;
  if (!outcome.ok) return { ok: false, codes: outcome.diagnostics.map(item => item.code), totalMs: null, commandMs, workerMs: null, workerDeliveredMs: null, renderMs: null, paintMs: null, storageAckMs: null };
  const shown = await probe.painted(t0, published => test(published, before));
  const evaluation = workerStats.evaluations.slice(evaluationsBefore).find(item => item.postedAt >= t0) ?? null;
  // Journal flush for the command (one microtask turn after it); waits for the host's acknowledgement.
  const append = session.options.host.calls('appendEvents', t0).find(call => call.activityId === activityId) ?? null;
  let storageAckMs: number | null = null;
  if (append && awaitStorage) {
    const settled = await until(() => session.options.host.calls('appendEvents', t0).find(call => call.activityId === activityId && call.startedAt === append.startedAt && call.settledAt !== null) ?? null, 20_000, 'journal acknowledgement').catch(() => null);
    storageAckMs = settled ? settled.settledAt! - settled.startedAt : null;
  }
  return {
    ok: true, codes: [], totalMs: shown.paintAt - t0, commandMs,
    workerMs: evaluation ? evaluation.repliedAt - evaluation.postedAt : null, workerDeliveredMs: evaluation ? evaluation.deliveredAt - evaluation.postedAt : null,
    renderMs: shown.at - shown.published.publishedAt, paintMs: shown.paintAt - shown.at, storageAckMs,
  };
}
const newCommittedFrame = (published: Published, before: LearnerProjection) => published.kind === 'committed' && published.frameId !== before.frame?.frameId;

/** Commits `values` in turn (`warmup` discarded, then `samples` measured; default one sample per value). */
async function commitSeries(activityId: string, input: { parameter: string; values: number[]; warmup?: number; samples?: number }, session = main.session): Promise<CommandSample[]> {
  const samples: CommandSample[] = [];
  const total = (input.warmup ?? 0) + (input.samples ?? input.values.length);
  for (let index = 0; index < total; index++) {
    const value = input.values[index % input.values.length];
    const learner = session.card(activityId).learner;
    const sample = await measureCommand(activityId, () => learner.commitParameters({ operationId: session.op('commit'), ...learner.getProjection().guards, displayValues: { [input.parameter]: value } }), newCommittedFrame, session);
    if (index >= (input.warmup ?? 0)) samples.push(sample);
  }
  return samples;
}
async function navigateSeries(activityId: string, input: { indices: number[]; warmup?: number; samples?: number }): Promise<CommandSample[]> {
  const samples: CommandSample[] = [];
  const total = (input.warmup ?? 0) + (input.samples ?? input.indices.length);
  for (let index = 0; index < total; index++) {
    const target = input.indices[index % input.indices.length];
    const learner = main.session.card(activityId).learner;
    const sample = await measureCommand(activityId, () => learner.navigate({ operationId: main.session.op('nav'), ...learner.getProjection().guards, position: { kind: 'index', index: target } }), newCommittedFrame);
    if (index >= (input.warmup ?? 0)) samples.push(sample);
  }
  return samples;
}

// ---------------------------------------------------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------------------------------------------------
type Region = 'active' | 'history' | 'stress' | 'spatial';
async function open(templateId: string, input: { activityId?: string; stageId?: string; region?: Region; authorize?: boolean } = {}) {
  const summary = await main.session.open(templateId, { stageId: input.stageId ?? 'free-explore', container: region(input.region ?? 'active'), ...(input.activityId ? { activityId: input.activityId } : {}) });
  if (input.authorize !== false) {
    // A reveal is acknowledged only by a surface that is on screen.
    main.session.card(summary.activityId).wrapper.scrollIntoView({ block: 'start' });
    await nextPaint();
    const revealed = await main.session.revealStage(summary.activityId);
    if (!revealed.ok) throw new Error(`reveal failed: ${revealed.codes.join(', ')}`);
    const scoped = await main.session.authorizeExploration(summary.activityId);
    if (!scoped.ok) throw new Error(`exploration scope failed: ${scoped.codes.join(', ')}`);
  }
  probeOf(summary.activityId);
  return main.session.settle(summary.activityId);
}
function close(activityId: string): void { forget(activityId); main.session.close(activityId); }
function closeAll(): void { for (const activityId of [...main.session.cards.keys()]) close(activityId); }
function control(activityId: string, parameter: string) {
  const root = main.session.surfaceRoot(activityId)!;
  const element = root.querySelector<HTMLElement>(`[data-parameter="${parameter}"]`);
  if (!element) throw new Error(`No control ${parameter}.`);
  return { element, slider: element.querySelector<HTMLInputElement>('input[type="range"]')!, output: element.querySelector<HTMLOutputElement>('output')! };
}
function sliderBox(activityId: string, parameter: string) {
  const { slider } = control(activityId, parameter);
  slider.scrollIntoView({ block: 'center' });
  const rect = slider.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, min: Number(slider.min), max: Number(slider.max), step: slider.step };
}
/** Shows the card's table alternative (the toggle in the “Also show” toolbar); returns the rendered table rows. */
async function showTables(activityId: string): Promise<number> {
  const root = main.session.surfaceRoot(activityId)!;
  const toggle = root.querySelector<HTMLButtonElement>('[role="group"][aria-label="Also show"] button');
  if (toggle && toggle.getAttribute('aria-pressed') !== 'true') toggle.click();
  await nextPaint();
  return root.querySelectorAll('[data-eka-panel="table"] tbody tr').length;
}
const svgElements = (activityId: string) => main.session.surfaceRoot(activityId)?.querySelectorAll('svg *').length ?? 0;

// ---------------------------------------------------------------------------------------------------------------------
// Slider drag recorder (the drag itself is real pointer input from the driver)
// ---------------------------------------------------------------------------------------------------------------------
interface InputRecord { t: number; value: number; ackAt: number | null; exact: boolean }
let drag: null | {
  activityId: string; parameter: string; inputs: InputRecord[]; frames: number[]; longTasks: number; longTaskMs: number; startedAt: number;
  messagesBefore: number; evaluationsBefore: number; stop: () => void;
} = null;
async function refreshInterval(): Promise<number> {
  const stamps: number[] = [];
  for (let index = 0; index < 31; index++) stamps.push(await new Promise<number>(resolve => requestAnimationFrame(resolve)));
  const deltas = stamps.slice(1).map((value, index) => value - stamps[index]).sort((a, b) => a - b);
  return deltas[Math.floor(deltas.length / 2)];
}
function startDrag(activityId: string, parameter: string): void {
  if (drag) drag.stop();
  const { slider, output } = control(activityId, parameter);
  const inputs: InputRecord[] = [], frames: number[] = [];
  let running = true, longTasks = 0, longTaskMs = 0;
  const displayed = () => { const text = (output.textContent ?? '').replace(/preview/g, '').replace('−', '-').replace(/[^0-9.\-]/g, ''); const value = Number.parseFloat(text); return Number.isFinite(value) ? value : null; };
  const onInput = (event: Event) => { inputs.push({ t: event.timeStamp, value: Number((event.target as HTMLInputElement).value), ackAt: null, exact: false }); };
  slider.addEventListener('input', onInput, true);
  const frame = (stamp: number) => {
    if (!running) return;
    frames.push(stamp);
    const shown = displayed();
    if (shown !== null) {
      // The latest input whose value the output shows; it and every earlier input are acknowledged by this frame.
      let last = -1;
      for (let index = inputs.length - 1; index >= 0; index--) if (Math.abs(inputs[index].value - shown) <= 1e-9 * Math.max(1, Math.abs(shown))) { last = index; break; }
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
  const observer = typeof PerformanceObserver === 'function' && PerformanceObserver.supportedEntryTypes?.includes('longtask')
    ? new PerformanceObserver(list => { for (const entry of list.getEntries()) { longTasks++; longTaskMs += entry.duration; } }) : null;
  observer?.observe({ type: 'longtask', buffered: false });
  drag = {
    activityId, parameter, inputs, frames, get longTasks() { return longTasks; }, get longTaskMs() { return longTaskMs; }, startedAt: now(),
    messagesBefore: workerStats.messages, evaluationsBefore: workerStats.evaluations.length,
    stop: () => { running = false; slider.removeEventListener('input', onInput, true); observer?.disconnect(); },
  };
}
async function stopDrag(input: { refreshMs: number; waitForCommit?: boolean }) {
  if (!drag) throw new Error('No drag is being recorded.');
  const current = drag;
  drag = null;
  // Let the commit on pointerup end the preview and reach the screen before the recorder stops.
  const learner = main.session.card(current.activityId).learner;
  if (input.waitForCommit !== false) await until(() => !learner.getProjection().preview && learner.getProjection().frame?.kind === 'committed', 15_000, 'the release to commit').catch(() => undefined);
  await main.session.settle(current.activityId).catch(() => undefined);
  await nextPaint();
  current.stop();
  const probe = probeOf(current.activityId);
  const inputs = current.inputs;
  const first = inputs[0]?.t ?? current.startedAt, last = inputs.at(-1)?.t ?? first;
  // Frames from the first input to one refresh interval after the last one.
  const windowFrames = current.frames.filter(stamp => stamp >= first && stamp <= last + input.refreshMs);
  const deltas = windowFrames.slice(1).map((value, index) => value - windowFrames[index]);
  const dropped = deltas.reduce((sum, delta) => sum + Math.max(0, Math.round(delta / input.refreshMs) - 1), 0);
  const tentative = probe.dom.filter(entry => entry.at >= first && entry.paintAt !== null).map(entry => ({ entry, published: probe.published.get(entry.projectionId) }))
    .filter(item => item.published?.kind === 'tentative');
  // Frames are content-addressed, so a value revisited on the way back has the same frame ID: count changes of the
  // painted tentative frame, not distinct IDs.
  const distinctFrames = tentative.filter((item, index) => index === 0 || item.published!.frameId !== tentative[index - 1].published!.frameId);
  const previewLatency = distinctFrames.map(item => {
    const value = item.published!.previews[current.parameter];
    const source = [...inputs].reverse().find(record => record.t <= item.entry.at && value !== null && Math.abs(record.value - value) <= 1e-9 * Math.max(1, Math.abs(value)));
    return source ? item.entry.paintAt! - source.t : null;
  }).filter((value): value is number => value !== null);
  const durationMs = last - first;
  return {
    inputEvents: inputs.length, durationMs, inputRateHz: durationMs > 0 ? (inputs.length - 1) / (durationMs / 1000) : null,
    inputAckMs: inputs.filter(item => item.ackAt !== null).map(item => item.ackAt! - item.t), unacknowledged: inputs.filter(item => item.ackAt === null).length,
    exactlyShown: inputs.filter(item => item.exact).length,
    frames: windowFrames.length, frameRateFps: deltas.length ? deltas.length / (deltas.reduce((a, b) => a + b, 0) / 1000) : null, frameDeltasMs: deltas, droppedFrames: dropped,
    longTasks: current.longTasks, longTaskMs: current.longTaskMs,
    tentativeFramesPainted: distinctFrames.length, previewUpdateRateHz: durationMs > 0 ? distinctFrames.length / (durationMs / 1000) : null, previewLatencyMs: previewLatency,
    workerMessages: workerStats.messages - current.messagesBefore,
    evaluationMs: workerStats.evaluations.slice(current.evaluationsBefore).map(item => item.repliedAt - item.postedAt),
    final: main.session.summary(current.activityId),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Rapidly changing inputs: one preview, many synchronous updates (coalescing), then commit
// ---------------------------------------------------------------------------------------------------------------------
async function rapidPreview(activityId: string, input: { parameter: string; updates: number; from: number; to: number }) {
  const learner = main.session.card(activityId).learner;
  const probe = probeOf(activityId);
  const begun = learner.beginPreview({ operationId: main.session.op('preview'), ...learner.getProjection().guards, gesture: 'pointer', parameter: input.parameter });
  if (!begun.ok) return { ok: false, codes: begun.diagnostics.map(item => item.code) };
  const previewId = learner.getProjection().preview!.previewId;
  const messagesBefore = workerStats.messages, evaluationsBefore = workerStats.evaluations.length;
  const values = Array.from({ length: input.updates }, (_, index) => Math.round((input.from + (input.to - input.from) * (index + 1) / input.updates) * 1e6) / 1e6);
  const t0 = now();
  let refused = 0;
  for (const value of values) if (!learner.updatePreview({ operationId: main.session.op('update'), previewId, displayValues: { [input.parameter]: value } }).ok) refused++;
  const burstMs = now() - t0;
  const last = values.at(-1)!;
  const shown = await probe.painted(t0, published => published.kind === 'tentative' && published.previews[input.parameter] === last, 3_000).catch(() => null);
  // When the newest value never reaches the screen, report the last tentative value that did (and its position in the burst).
  const tentative = probe.dom.filter(entry => entry.at >= t0 && entry.paintAt !== null).map(entry => probe.published.get(entry.projectionId)).filter(item => item?.kind === 'tentative');
  const lastShownValue = tentative.at(-1)?.previews[input.parameter] ?? null;
  const messagesDuringPreview = workerStats.messages - messagesBefore;
  const commit = await measureCommand(activityId, () => learner.commitPreview({ operationId: main.session.op('commit'), ...learner.getProjection().guards, previewId }), newCommittedFrame);
  return {
    ok: !!shown && commit.ok, newestValueShown: !!shown, updates: values.length, refusedUpdates: refused, burstMs, lastValueShownAfterBurstMs: shown ? shown.paintAt - (t0 + burstMs) : null,
    lastShownValue, lastShownIndex: lastShownValue === null ? null : values.indexOf(lastShownValue) + 1,
    workerMessagesDuringPreview: messagesDuringPreview, previewEvaluations: workerStats.evaluations.slice(evaluationsBefore).length - (commit.workerMs === null ? 0 : 1),
    tentativeFramesPainted: tentative.filter((item, index) => index === 0 || item!.frameId !== tentative[index - 1]!.frameId).length,
    commit, committedValue: main.session.summary(activityId).controls[input.parameter], expectedValue: last,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Resize: container width changes re-layout the drawing; no evaluation, no scientific change
// ---------------------------------------------------------------------------------------------------------------------
async function resizeSeries(activityId: string, input: { widths: number[]; repeats: number }) {
  const card = main.session.card(activityId);
  const root = main.session.surfaceRoot(activityId)!;
  const before = main.session.summary(activityId);
  const messagesBefore = workerStats.messages;
  const samples: number[] = [];
  let unchanged = 0;
  for (let repeat = 0; repeat < input.repeats; repeat++) {
    for (const width of input.widths) {
      const svg = root.querySelector('svg.eka-plot');
      const previous = svg?.getAttribute('width') ?? null;
      let changedAt: number | null = null;
      const observer = new MutationObserver(() => { if (changedAt === null && root.querySelector('svg.eka-plot')?.getAttribute('width') !== previous) changedAt = now(); });
      observer.observe(root, { subtree: true, attributes: true, attributeFilter: ['width'] });
      const t0 = now();
      card.wrapper.style.width = `${width}px`;
      const changed = await until(() => changedAt !== null, 2_000, 'a re-layout').then(() => true, () => false);
      observer.disconnect();
      if (!changed) { unchanged++; continue; }
      const painted = await new Promise<number>(resolve => afterPaint(resolve));
      samples.push(painted - t0);
    }
  }
  card.wrapper.style.width = '';
  await nextPaint();
  const after = main.session.summary(activityId);
  return {
    samplesMs: samples, unchanged, workerMessages: workerStats.messages - messagesBefore,
    scientificUnchanged: after.scientificVersion === before.scientificVersion && after.runId === before.runId && after.frameId === before.frameId,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Quiet window: suspended cards must not compute, render or notify
// ---------------------------------------------------------------------------------------------------------------------
async function quietWindow(activityIds: string[], ms: number) {
  const roots = activityIds.map(id => main.session.surfaceRoot(id)!);
  const probesList = activityIds.map(id => probeOf(id));
  const notificationsBefore = probesList.map(probe => probe.notifications);
  let mutations = 0;
  const observers = roots.map(root => { const observer = new MutationObserver(records => { mutations += records.length; }); observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true }); return observer; });
  const messagesBefore = workerStats.messages, evaluationsBefore = workerStats.evaluations.length;
  await sleep(ms);
  for (const observer of observers) observer.disconnect();
  return {
    cards: activityIds.length, windowMs: ms, workerMessages: workerStats.messages - messagesBefore, evaluations: workerStats.evaluations.length - evaluationsBefore, domMutations: mutations,
    notifications: probesList.reduce((sum, probe, index) => sum + probe.notifications - notificationsBefore[index], 0),
    uiStates: [...new Set(activityIds.map(id => main.session.projection(id).status.ui))], liveWorkers: workerStats.live,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Stalled persistence: the host stops acknowledging journal appends
// ---------------------------------------------------------------------------------------------------------------------
async function stalledPersistence(input: { outboxLimit: number; maxCommits: number }) {
  const runtime = createRuntime({ outboxLimit: input.outboxLimit });
  const session = runtime.session;
  try {
    const opened = await session.open('quadratic-gradient-descent', { stageId: 'free-explore', container: region('stress') });
    const activityId = opened.activityId;
    session.card(activityId).wrapper.scrollIntoView({ block: 'start' });
    await nextPaint();
    if (!(await session.revealStage(activityId)).ok || !(await session.authorizeExploration(activityId)).ok) throw new Error('authorization failed');
    await session.settle(activityId);
    const probe = probeOf(activityId, session);
    const learner = session.card(activityId).learner;
    const chip = () => { const element = session.surfaceRoot(activityId)?.querySelector<HTMLElement>('.eka-chip'); return element ? { tone: element.dataset.tone ?? null, text: (element.textContent ?? '').trim() } : null; };
    runtime.host.hold('appendEvents');
    const heldAt = now();
    const samples: CommandSample[] = [];
    const persistence: string[] = [];
    let refusal: { commit: number; codes: string[] } | null = null;
    for (let index = 0; index < input.maxCommits; index++) {
      const sample = await measureCommand(activityId, () => learner.commitParameters({ operationId: session.op('commit'), ...learner.getProjection().guards, displayValues: { eta: index % 2 ? 0.55 : 0.65 } }), newCommittedFrame, session, false);
      persistence.push(learner.getProjection().status.persistence);
      if (!sample.ok) { refusal = { commit: index, codes: sample.codes }; break; }
      samples.push(sample);
    }
    await nextPaint();
    const chipWhileStalled = chip();
    // Evidence-bearing host step while appends are stalled.
    const projection = learner.getProjection();
    const prepared = session.card(activityId).prepared;
    const transitionStarted = now();
    const transition = await prepared.host.requestStageTransition({ operationId: session.op('stage'), expectedActivityRevision: projection.activityRevision, expectedPolicyRevision: projection.policyRevision, toStage: 'closed' });
    const transitionMs = now() - transitionStarted;
    // Viewing continues: a presentation change (layout) and reading values still work.
    const view = await measureCommand(activityId, () => learner.setLayout({ operationId: session.op('layout'), expectedPresentationRevision: learner.getProjection().presentationRevision, layout: 'expanded' }),
      (published, before) => published.presentationRevision > before.presentationRevision, session, false);
    const values = learner.describeCurrentValues().length;
    const stalledMs = now() - heldAt;
    runtime.host.release('appendEvents');
    const releasedAt = now();
    await until(() => learner.getProjection().status.persistence === 'saved' && !runtime.host.calls().some(call => call.activityId === activityId && call.settledAt === null), 20_000, 'the journal to drain');
    const drainMs = now() - releasedAt;
    const afterRelease = await measureCommand(activityId, () => learner.commitParameters({ operationId: session.op('commit'), ...learner.getProjection().guards, displayValues: { eta: 0.7 } }), newCommittedFrame, session);
    forget(activityId);
    return {
      outboxLimit: input.outboxLimit, acceptedWhileStalled: samples.length, refusal, persistenceWhileStalled: [...new Set(persistence)], chipWhileStalled,
      commitsWhileStalledMs: samples.map(sample => sample.totalMs), stageTransitionWhileStalled: { ...(transition.ok ? { ok: true, codes: [] } : { ok: false, codes: transition.diagnostics.map(item => item.code) }), resolvedAfterMs: transitionMs },
      presentationWhileStalled: { ok: view.ok, codes: view.codes, totalMs: view.totalMs }, describeCurrentValuesChars: values, stalledMs, drainMs,
      afterRelease: { ok: afterRelease.ok, codes: afterRelease.codes, totalMs: afterRelease.totalMs, storageAckMs: afterRelease.storageAckMs },
      hostEvents: runtime.host.events(activityId).length,
    };
  } finally {
    runtime.host.release('appendEvents');
    session.closeAll();
    runtime.visualizer.dispose();
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Navigation while work is pending (slow evaluator)
// ---------------------------------------------------------------------------------------------------------------------
async function navigationWhilePending(activityId: string, input: { delayMs: number }) {
  const learner = main.session.card(activityId).learner;
  const probe = probeOf(activityId);
  const t0 = now();
  workerStats.delayMs = input.delayMs;
  try {
    // A committed evaluation is in flight when the learner steps.
    const commit = learner.commitParameters({ operationId: main.session.op('commit'), ...learner.getProjection().guards, displayValues: { eta: 0.45 } });
    await sleep(Math.min(30, input.delayMs / 4));
    const stepDuringCommit = await learner.step({ operationId: main.session.op('step'), ...learner.getProjection().guards, delta: 1 });
    const committed = await commit;
    await main.session.settle(activityId);
    // A preview evaluation is in flight when the learner navigates.
    const begun = learner.beginPreview({ operationId: main.session.op('preview'), ...learner.getProjection().guards, gesture: 'pointer', parameter: 'eta' });
    const previewId = learner.getProjection().preview?.previewId ?? null;
    if (previewId) learner.updatePreview({ operationId: main.session.op('update'), previewId, displayValues: { eta: 0.35 } });
    await sleep(Math.min(30, input.delayMs / 4));
    const navigateDuringPreview = await learner.navigate({ operationId: main.session.op('nav'), ...learner.getProjection().guards, position: { kind: 'index', index: 4 } });
    const previewAfterNavigate = learner.getProjection().preview;
    if (previewAfterNavigate) learner.cancelPreview({ operationId: main.session.op('cancel'), previewId: previewAfterNavigate.previewId, reason: 'navigation' });
    await sleep(input.delayMs + 50);
    const settled = await main.session.settle(activityId);
    const projection = learner.getProjection();
    const lastDom = probe.dom.at(-1);
    return {
      delayMs: input.delayMs,
      commit: { ok: committed.ok, codes: committed.ok ? [] : committed.diagnostics.map(item => item.code) },
      stepDuringCommit: { ok: stepDuringCommit.ok, codes: stepDuringCommit.ok ? [] : stepDuringCommit.diagnostics.map(item => item.code) },
      previewBegun: begun.ok,
      navigateDuringPreview: { ok: navigateDuringPreview.ok, codes: navigateDuringPreview.ok ? [] : navigateDuringPreview.diagnostics.map(item => item.code) },
      previewActiveAfterNavigate: !!previewAfterNavigate,
      final: settled, domShowsCurrentProjection: lastDom?.projectionId === projection.projectionId && projection.frame?.kind === 'committed',
      tentativeFramesShownAfterNavigate: probe.dom.filter(entry => entry.at >= t0 && probe.published.get(entry.projectionId)?.kind === 'tentative').length,
      elapsedMs: now() - t0,
    };
  } finally {
    workerStats.delayMs = 0;
  }
}
/** Starts a commit whose evaluation is held by the slow evaluator and returns without waiting (page navigation test). */
function startPendingCommit(activityId: string, delayMs: number): void {
  workerStats.delayMs = delayMs;
  main.session.options.host.hold('appendEvents');
  const learner = main.session.card(activityId).learner;
  void learner.commitParameters({ operationId: main.session.op('commit'), ...learner.getProjection().guards, displayValues: { eta: 0.4 } });
}

// ---------------------------------------------------------------------------------------------------------------------
// Persist-before-reveal timing under host latency
// ---------------------------------------------------------------------------------------------------------------------
async function revealTiming(input: { latencyMs: number; repeats: number }) {
  const host = main.session.options.host;
  const methods: HostMethod[] = ['requestStageTransition', 'recordDisplayAck'];
  for (const method of methods) host.setLatency(method, input.latencyMs);
  const samples: { receiptMs: number; displayedMs: number; displayAckMs: number | null }[] = [];
  try {
    for (let repeat = 0; repeat < input.repeats; repeat++) {
      const opened = await main.session.open('quadratic-gradient-descent', { stageId: 'predict', container: region('stress') });
      // Display is acknowledged only by a visible surface.
      main.session.card(opened.activityId).wrapper.scrollIntoView({ block: 'start' });
      await nextPaint();
      await main.session.settle(opened.activityId);
      const probe = probeOf(opened.activityId);
      const card = main.session.card(opened.activityId);
      const before = card.learner.getProjection();
      const t0 = now();
      const outcome = await card.prepared.host.requestStageTransition({ operationId: main.session.op('stage'), expectedActivityRevision: before.activityRevision, expectedPolicyRevision: before.policyRevision, toStage: 'explore-step' });
      if (!outcome.ok) throw new Error(`stage transition failed: ${outcome.diagnostics.map(item => item.code).join(', ')}`);
      const receipt = host.calls('requestStageTransition', t0).find(call => call.activityId === opened.activityId);
      const shown = await probe.painted(t0, published => published.activityRevision > before.activityRevision && published.views.includes('trace-plot'));
      const ack = await until(() => host.calls('recordDisplayAck', t0).find(call => call.activityId === opened.activityId && call.settledAt !== null), 10_000, 'the display acknowledgement').catch(() => null);
      samples.push({ receiptMs: receipt?.settledAt ? receipt.settledAt - t0 : -1, displayedMs: shown.paintAt - t0, displayAckMs: ack ? ack.settledAt! - t0 : null });
      await main.session.settle(opened.activityId);
      close(opened.activityId);
    }
  } finally {
    for (const method of methods) host.setLatency(method, 0);
  }
  return { latencyMs: input.latencyMs, samples };
}

// ---------------------------------------------------------------------------------------------------------------------
// Spatial activities: commit → renderer frame, camera command → renderer frame, pointer orbit → renderer frame
// ---------------------------------------------------------------------------------------------------------------------
const spatialContainer = (activityId: string) => main.session.surfaceRoot(activityId)?.querySelector<HTMLElement>('.eka-spatial') ?? null;
function rendererFrames(activityId: string): number | null {
  const container = spatialContainer(activityId);
  return container && spatialModule?.inspect ? spatialModule.inspect(container)?.stats.frames ?? null : null;
}
/** The mounted renderer's live resource counters (player-3d `inspect`), or null without a renderer. */
function rendererStats(activityId: string) {
  const container = spatialContainer(activityId);
  return container && spatialModule?.inspect ? spatialModule.inspect(container)?.stats ?? null : null;
}
async function rendererFrameAfter(activityId: string, frames: number): Promise<number> {
  await until(() => (rendererFrames(activityId) ?? -1) > frames, 5_000, 'a renderer frame');
  return new Promise<number>(resolve => afterPaint(resolve));
}
async function openSpatial(templateId: string) {
  const summary = await open(templateId, { region: 'spatial' });
  main.session.surfaceRoot(summary.activityId)?.querySelector('[data-eka-spatial]')?.scrollIntoView({ block: 'center' });
  const state = await until(() => {
    const element = main.session.surfaceRoot(summary.activityId)?.querySelector<HTMLElement>('[data-eka-spatial]');
    const value = element?.dataset.ekaSpatialState;
    return value === 'ready' || value === 'fallback' || value === 'failed' ? value : null;
  }, 15_000, 'the spatial view');
  if (state === 'ready') await until(() => (rendererFrames(summary.activityId) ?? 0) > 0, 10_000, 'the first renderer frame');
  return { ...summary, spatialState: state, loads: spatialLoads.length, frames: rendererFrames(summary.activityId) };
}
async function spatialCommitSeries(activityId: string, input: { parameter: string; values: number[]; warmup: number; samples: number }) {
  const out: (CommandSample & { rendererFrameMs: number | null })[] = [];
  for (let index = 0; index < input.warmup + input.samples; index++) {
    const value = input.values[index % input.values.length];
    const learner = main.session.card(activityId).learner;
    const frames = rendererFrames(activityId);
    const t0 = now();
    const sample = await measureCommand(activityId, () => learner.commitParameters({ operationId: main.session.op('commit'), ...learner.getProjection().guards, displayValues: { [input.parameter]: value } }), newCommittedFrame);
    const rendered = sample.ok && frames !== null ? await rendererFrameAfter(activityId, frames) : null;
    if (index >= input.warmup) out.push({ ...sample, rendererFrameMs: rendered === null ? null : rendered - t0 });
  }
  return out;
}
async function cameraCommandSeries(activityId: string, input: { samples: number; warmup: number }) {
  const cameras: Camera3D[] = [
    { kind: '3d', projection: 'perspective', position: [6, 4, 5], target: [0, 0, 0], up: [0, 0, 1], preset: null },
    { kind: '3d', projection: 'perspective', position: [5, -4, 6], target: [0, 0, 0], up: [0, 0, 1], preset: null },
  ];
  const viewId = main.session.projection(activityId).views.find(view => view.kind === 'scene3d')!.viewId;
  const out: { ok: boolean; codes: string[]; commandMs: number; domMs: number | null; rendererFrameMs: number | null }[] = [];
  for (let index = 0; index < input.warmup + input.samples; index++) {
    const learner = main.session.card(activityId).learner;
    const probe = probeOf(activityId);
    const before = learner.getProjection();
    const frames = rendererFrames(activityId) ?? 0;
    const t0 = now();
    const outcome = learner.setCamera({ operationId: main.session.op('camera'), expectedPresentationRevision: before.presentationRevision, viewId, camera: cameras[index % 2] });
    const commandMs = now() - t0;
    if (!outcome.ok) { out.push({ ok: false, codes: outcome.diagnostics.map(item => item.code), commandMs, domMs: null, rendererFrameMs: null }); continue; }
    const shown = await probe.painted(t0, published => published.presentationRevision > before.presentationRevision);
    const rendered = await rendererFrameAfter(activityId, frames);
    if (index >= input.warmup) out.push({ ok: true, codes: [], commandMs, domMs: shown.at - t0, rendererFrameMs: rendered - t0 });
  }
  return out;
}
let orbit: null | { moves: { t: number; ackAt: number | null }[]; frames: number[]; stop(): void; activityId: string; framesBefore: number } = null;
function canvasBox(activityId: string) {
  const container = spatialContainer(activityId);
  if (!container?.querySelector('canvas')) return null;
  container.scrollIntoView({ block: 'center' });
  const rect = container.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}
function startOrbit(activityId: string): void {
  // The renderer's own viewport element receives the pointer events; listen on the container in the capture phase.
  const canvas = spatialContainer(activityId)!;
  const moves: { t: number; ackAt: number | null }[] = [], frames: number[] = [];
  let running = true, lastFrames = rendererFrames(activityId) ?? 0;
  const onMove = (event: PointerEvent) => { if (event.buttons) moves.push({ t: event.timeStamp, ackAt: null }); };
  canvas.addEventListener('pointermove', onMove, true);
  const tick = (stamp: number) => {
    if (!running) return;
    frames.push(stamp);
    const current = rendererFrames(activityId) ?? lastFrames;
    if (current > lastFrames) {
      lastFrames = current;
      const pending = moves.filter(move => move.ackAt === null && move.t <= now());
      afterPaint(at => { for (const move of pending) if (move.ackAt === null) move.ackAt = at; });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  orbit = { activityId, moves, frames, framesBefore: lastFrames, stop: () => { running = false; canvas.removeEventListener('pointermove', onMove, true); } };
}
async function stopOrbit() {
  if (!orbit) throw new Error('No orbit is being recorded.');
  const current = orbit;
  orbit = null;
  await sleep(200);
  current.stop();
  const first = current.moves[0]?.t ?? 0, last = current.moves.at(-1)?.t ?? first;
  const window = current.frames.filter(stamp => stamp >= first && stamp <= last);
  const deltas = window.slice(1).map((value, index) => value - window[index]);
  return {
    moves: current.moves.length, durationMs: last - first, inputAckMs: current.moves.filter(move => move.ackAt !== null).map(move => move.ackAt! - move.t),
    unacknowledged: current.moves.filter(move => move.ackAt === null).length, rendererFrames: (rendererFrames(current.activityId) ?? 0) - current.framesBefore,
    frameRateFps: deltas.length ? deltas.length / (deltas.reduce((a, b) => a + b, 0) / 1000) : null,
    presentationRevision: main.session.projection(current.activityId).presentationRevision,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Legacy schema 2.0 document path (@experiment-kit/player + @experiment-kit/core/declarative)
// ---------------------------------------------------------------------------------------------------------------------
/** The parts of a schema 2.0 document the workloads change (the session validates the whole document). */
type LegacyDocument = { quantities: Record<string, unknown>; views: { marks: unknown[]; bounds?: unknown }[]; series: Record<string, unknown>; datasets?: unknown };
function legacyDocument(workload: string): LegacyDocument {
  const document = createPreset('wave') as unknown as LegacyDocument;
  if (workload === '1001-sample-curve') (document.series.wave as { samples: number }).samples = 1001;
  if (workload === '100-mark-scene') {
    document.views[0].marks = Array.from({ length: 100 }, (_, index) => {
      const id = `position${index}`;
      document.quantities[id] = { expression: `[amplitude*0.01+${(index % 10) * 0.4 - 1.8},${Math.floor(index / 10) - 4.5}]`, label: `Position ${index}` };
      return { id: `point-${index}`, type: 'point', label: `Semantic point ${index}`, bindings: { position: id } };
    });
  }
  if (workload === '5000-row-dataset') {
    document.datasets = { supplied: { columns: [{ id: 'x', label: 'x' }, { id: 'y', label: 'Observed y' }], rows: Array.from({ length: 5000 }, (_, index) => [index / 1000, Math.sin(index / 1000)]), description: 'Fixed synthetic benchmark values; not experimental observations.' } };
    document.series.wave = { label: 'Supplied 5000-row series', dataset: 'supplied', xColumn: 'x', yColumn: 'y', kind: 'observed' };
    document.views[0].bounds = [0, 5, -2, 2];
  }
  return document;
}
async function legacyMeasure(input: { workload: string; samples: number; warmup: number }) {
  const container = document.createElement('section');
  container.className = 'bench-legacy';
  region('legacy').append(container);
  const session: VisualizationSession = await createVisualizationSession();
  const guard = () => { const state = session.getState(); return { sessionId: session.id, expectedVersion: state.version, ...(state.run ? { expectedRunId: state.run.id } : {}), operationId: main.session.op('legacy'), origin: 'host' as const }; };
  const surface = mountVisualization(container, { session });
  try {
    const candidate = await session.createCandidate(legacyDocument(input.workload) as unknown as Parameters<VisualizationSession['createCandidate']>[0], guard());
    await session.commitCandidate(candidate.id, guard());
    container.scrollIntoView({ block: 'center' });
    const shadow = surface.element.shadowRoot!;
    const matches = () => {
      const state = session.getState();
      const svg = shadow.querySelector<SVGSVGElement>('svg[data-view-id]');
      return !!svg && Number(svg.dataset.sessionVersion) === state.version && svg.dataset.runId === state.run?.id;
    };
    await until(matches, 10_000, 'the legacy surface');
    const samples: { totalMs: number; commandMs: number; domMs: number }[] = [];
    for (let index = 0; index < input.warmup + input.samples; index++) {
      let domAt: number | null = null;
      const observer = new MutationObserver(() => { if (domAt === null && matches()) domAt = now(); });
      observer.observe(shadow, { subtree: true, attributes: true, attributeFilter: ['data-session-version', 'data-run-id'] });
      const t0 = now();
      await session.setParameters({ amplitude: index % 2 ? 2 : 3 }, guard());
      const commandMs = now() - t0;
      if (domAt === null && matches()) domAt = now();
      await until(() => domAt !== null, 10_000, 'the legacy frame');
      observer.disconnect();
      const painted = await nextPaint();
      if (index >= input.warmup) samples.push({ totalMs: painted - t0, commandMs, domMs: domAt! - t0 });
    }
    return { workload: input.workload, svgElements: shadow.querySelectorAll('svg *').length, samples };
  } finally {
    surface.dispose();
    session.dispose();
    container.remove();
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Lifecycle stress: mount → interact → suspend → save → dispose → restore → mount → suspend/resume → dispose
// ---------------------------------------------------------------------------------------------------------------------
const opened: string[] = [];
async function lifecycleCycle(index: number, prefix: string): Promise<void> {
  const activityId = `${prefix}-${index}`;
  const templateId = index % 2 ? 'function-derivative' : 'quadratic-gradient-descent';
  await main.session.open(templateId, { activityId, stageId: 'free-explore', container: region('stress') });
  opened.push(activityId);
  const parameter = index % 2 ? 'p' : 'eta';
  const value = index % 2 ? -1 + (index % 5) * 0.5 : 0.5 + (index % 5) * 0.1;
  const committed = await main.session.commit(activityId, { [parameter]: value });
  if (!committed.ok) throw new Error(`cycle ${index} commit: ${committed.codes.join(', ')}`);
  if (!(index % 2)) { const moved = await main.session.navigate(activityId, 3); if (!moved.ok) throw new Error(`cycle ${index} navigate: ${moved.codes.join(', ')}`); }
  if (!main.session.suspend(activityId).ok) throw new Error(`cycle ${index} suspend`);
  const artifact = await main.session.save(activityId, 'backup');
  await until(() => main.session.projection(activityId).status.persistence === 'saved', 10_000, 'saved');
  main.session.close(activityId);
  await main.session.restore(artifact, region('stress'));
  if (!main.session.suspend(activityId).ok || !main.session.resume(activityId).ok) throw new Error(`cycle ${index} suspend/resume`);
  await until(() => main.session.projection(activityId).status.persistence === 'saved', 10_000, 'saved');
  main.session.close(activityId);
}
async function lifecycle(input: { cycles: number; heapEvery: number; prefix?: string }) {
  const durations: number[] = [];
  const heap: { cycle: number; usedJSHeapSize: number; hostRecordChars: number }[] = [];
  const gc = (globalThis as { gc?: () => void }).gc;
  const memory = () => (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null;
  /** Size of the fixture host's durable records (journal events and artifacts), which the heap necessarily holds. */
  const hostRecordBytes = () => {
    const host = main.session.options.host;
    return host.activities().reduce((sum, id) => sum + JSON.stringify(host.events(id)).length, 0) + JSON.stringify(host.artifacts()).length;
  };
  const sampleHeap = (cycle: number) => { gc?.(); const used = memory(); if (used !== null) heap.push({ cycle, usedJSHeapSize: used, hostRecordChars: hostRecordBytes() }); };
  const workersBefore = { created: workerStats.created, terminated: workerStats.terminated };
  sampleHeap(0);
  for (let index = 0; index < input.cycles; index++) {
    const t0 = now();
    await lifecycleCycle(index, input.prefix ?? 'stress');
    durations.push(now() - t0);
    if ((index + 1) % input.heapEvery === 0) sampleHeap(index + 1);
  }
  await nextPaint();
  return {
    cycles: input.cycles, durationsMs: durations, heap, gcForced: typeof gc === 'function',
    workers: { created: workerStats.created - workersBefore.created, terminated: workerStats.terminated - workersBefore.terminated, live: workerStats.live, peak: workerStats.peak },
    openCardsInSession: main.session.cards.size,
    connectedSurfaces: document.querySelectorAll('#stress [data-experiment-kit-activity]').length,
    adapterStillOpen: opened.filter(id => { const state = main.visualizer.getState(id, 'learner'); return !('ok' in state && state.ok === false) && (state as { projection?: LearnerProjection }).projection?.status.ui !== 'disposed'; }).length,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Driver interface
// ---------------------------------------------------------------------------------------------------------------------
const bench = {
  maxWorkers: MAX_WORKERS,
  configure(input: { workerDelayMs?: number; hostLatency?: Partial<Record<HostMethod | '*', number>> }) {
    if (input.workerDelayMs !== undefined) workerStats.delayMs = input.workerDelayMs;
    for (const [method, ms] of Object.entries(input.hostLatency ?? {})) main.session.options.host.setLatency(method as HostMethod | '*', ms ?? 0);
  },
  workers: () => ({ created: workerStats.created, terminated: workerStats.terminated, live: workerStats.live, peak: workerStats.peak, messages: workerStats.messages, evaluations: workerStats.evaluations.length }),
  hostCalls: (method?: HostMethod, since = 0) => main.session.options.host.calls(method, since),
  open, close, closeAll, summary: (activityId: string) => main.session.summary(activityId), settle: (activityId: string) => main.session.settle(activityId),
  suspend: (activityId: string) => main.session.suspend(activityId), resume: (activityId: string) => main.session.resume(activityId),
  navigate: (activityId: string, index: number) => main.session.navigate(activityId, index),
  scrollTo: (activityId: string) => { main.session.card(activityId).wrapper.scrollIntoView({ block: 'start' }); return nextPaint(); },
  showTables, svgElements, sliderBox, refreshInterval,
  /** What the control shows: the slider position and its output text (with the preview badge, if any). */
  controlState: (activityId: string, parameter: string) => { const { slider, output } = control(activityId, parameter); return { slider: Number(slider.value), output: (output.textContent ?? '').trim() }; },
  commitSeries, navigateSeries, startDrag, stopDrag, rapidPreview, resizeSeries, quietWindow, stalledPersistence, navigationWhilePending, startPendingCommit, revealTiming,
  openSpatial, spatialCommitSeries, rendererStats, cameraCommandSeries, canvasBox, startOrbit, stopOrbit, spatialLoads: () => [...spatialLoads],
  legacyMeasure, lifecycle,
  diagnostics: () => diagnostics.slice(),
  /** The card probe's recent publications and DOM commits (for diagnosing a failed measurement). */
  probeLog: (activityId: string, last = 30) => {
    const probe = probeOf(activityId);
    return {
      published: [...probe.published.values()].slice(-last).map(item => ({ id: item.projectionId.slice(0, 8), frame: item.frameId?.slice(-8) ?? null, kind: item.kind, values: item.previews, ui: item.ui, at: Math.round(item.publishedAt * 10) / 10 })),
      dom: probe.dom.slice(-last).map(entry => ({ id: entry.projectionId.slice(0, 8), at: Math.round(entry.at * 10) / 10, paintAt: entry.paintAt === null ? null : Math.round(entry.paintAt * 10) / 10 })),
    };
  },
  connectedSurfaces: () => document.querySelectorAll('[data-experiment-kit-activity]').length,
};
export type Bench = typeof bench;
Object.assign(window, { bench });
document.body.dataset.ready = 'true';
