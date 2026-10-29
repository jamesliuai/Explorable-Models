/**
 * Lifecycle, scheduling and suspension of learner surfaces in a real browser (report §9, §18; A41, A42, A43). It drives
 * `examples/study-harness-host/lifecycle.html`: one activity adapter with a shared worker budget, two active 2D
 * activities (quadratic gradient descent and function/derivative), 20 suspended history cards, the real learner
 * surface in its shadow root and the real catalogue module workers.
 *
 * Instrumentation (installed by this spec before any page script): Worker construction, postMessage and termination;
 * setTimeout/clearTimeout and setInterval/clearInterval with the test phase that created each timer;
 * requestAnimationFrame; addEventListener/removeEventListener on window, document and MediaQueryList; attachShadow.
 * The 3D cycle test adds graphics instrumentation: WebGL contexts (and whether each is still live), canvas creation and
 * canvases connected anywhere in the page (shadow roots included), Resize/Intersection/Mutation observers that were
 * never released, listeners on window, MediaQueryLists and connected nodes, and pending animation frames. These are
 * counted by the page itself, not taken from the renderer's own counters. Headless Chromium draws WebGL with SwiftShader;
 * headless Firefox and WebKit draw WebGL 2 as well on macOS.
 * Page visibility is emulated by overriding `document.visibilityState` and dispatching `visibilitychange`.
 *
 * Evidence scope: Playwright Chromium (`npm run test:browser`), Firefox and WebKit (`npm run test:cross-browser`) with an
 * in-page fixture host. Fixture-host results; they say nothing about the
 * Study Harness host, a packaged WebView or learning outcomes. Measured counts are attached to the test results.
 */
import { mkdirSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { CommandOutcome } from '@explorable-models/activity';
import type { LifecycleFixture } from '../../examples/study-harness-host/lifecycle';

const SHOTS = '/tmp/explorable-models-playwright/study-lifecycle';
mkdirSync(SHOTS, { recursive: true });
const PAGE = '/examples/study-harness-host/lifecycle.html';

interface Instrumentation {
  phase: string;
  setPhase(phase: string): void;
  counts(): {
    workers: { created: number; terminated: number; live: number; peak: number; messages: number };
    timers: { set: number; cleared: number; fired: number; pending: Record<string, number> };
    intervals: { set: number; cleared: number; live: Record<string, number> };
    raf: number; shadowRoots: number;
    listeners: { window: string[]; document: string[]; mediaQueries: number };
  };
}
interface GraphicsCounts {
  contexts: { created: number; live: number };
  canvases: { created: number; connected: number };
  observers: Record<'ResizeObserver' | 'IntersectionObserver' | 'MutationObserver', { created: number; unreleased: number }>;
  /** Live registrations on window, MediaQueryLists and connected nodes, as `phase:target:type#listener`. */
  listeners: string[];
  frames: { pending: Record<string, number> };
  surfaces: number;
  /** WebGL contexts lost while their canvas was still in the page: a view in use losing its context (not a disposal). */
  lostWhileConnected: number;
}
declare global { interface Window { lifecycleFixture: LifecycleFixture; __lifecycle: Instrumentation; __graphics: { counts(): GraphicsCounts } } }

/** Installed with addInitScript: counts browser resources the activity runtime could own. */
function instrument(): void {
  const phaseRef = { value: 'load' };
  const workers = { created: 0, terminated: 0, messages: 0, peak: 0 };
  const live = new Set<Worker>();
  const timers = { set: 0, cleared: 0, fired: 0 };
  const pending = new Map<number, string>();
  const intervals = { set: 0, cleared: 0 };
  const liveIntervals = new Map<number, string>();
  let raf = 0, shadowRoots = 0, mediaQueries = 0;
  const NativeWorker = window.Worker;
  class CountedWorker extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) { super(url, options); workers.created++; live.add(this); workers.peak = Math.max(workers.peak, live.size); }
    override postMessage(message: unknown, transfer?: unknown): void { workers.messages++; super.postMessage(message, transfer as Transferable[]); }
    override terminate(): void { if (live.delete(this)) workers.terminated++; super.terminate(); }
  }
  window.Worker = CountedWorker;
  const nativeSet = window.setTimeout.bind(window), nativeClear = window.clearTimeout.bind(window);
  window.setTimeout = ((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
    const id: number = nativeSet(() => { pending.delete(id); timers.fired++; if (typeof handler === 'function') (handler as (...values: unknown[]) => void)(...args); }, ms);
    pending.set(id, phaseRef.value);
    timers.set++;
    return id;
  }) as typeof window.setTimeout;
  window.clearTimeout = ((id?: number) => { if (id !== undefined && pending.delete(id)) timers.cleared++; nativeClear(id); }) as typeof window.clearTimeout;
  const nativeInterval = window.setInterval.bind(window), nativeClearInterval = window.clearInterval.bind(window);
  window.setInterval = ((handler: TimerHandler, ms?: number, ...args: unknown[]) => { const id = nativeInterval(handler, ms, ...args); liveIntervals.set(id, phaseRef.value); intervals.set++; return id; }) as typeof window.setInterval;
  window.clearInterval = ((id?: number) => { if (id !== undefined && liveIntervals.delete(id)) intervals.cleared++; nativeClearInterval(id); }) as typeof window.clearInterval;
  const nativeRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback => { raf++; return nativeRaf(callback); }) as typeof window.requestAnimationFrame;
  const nativeAttach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit) { shadowRoots++; return nativeAttach.call(this, init); };
  // Listener registrations on window and document, identified by type, listener identity and capture flag.
  const ids = new WeakMap<object, number>();
  let next = 0;
  const keyOf = (type: string, listener: unknown, options: unknown) => {
    if (!listener || (typeof listener !== 'function' && typeof listener !== 'object')) return null;
    if (!ids.has(listener as object)) ids.set(listener as object, ++next);
    const capture = typeof options === 'boolean' ? options : !!(options as { capture?: boolean } | undefined)?.capture;
    return `${type}#${ids.get(listener as object)}${capture ? ':capture' : ''}`;
  };
  const registry = { window: new Map<string, string>(), document: new Map<string, string>() };
  for (const [name, target] of [['window', window], ['document', document]] as const) {
    const add = target.addEventListener.bind(target), remove = target.removeEventListener.bind(target);
    target.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) => {
      const key = keyOf(type, listener, options);
      if (key && !registry[name].has(key)) registry[name].set(key, phaseRef.value);
      if (listener) add(type, listener, options);
    }) as typeof target.addEventListener;
    target.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) => {
      const key = keyOf(type, listener, options);
      if (key) registry[name].delete(key);
      if (listener) remove(type, listener, options);
    }) as typeof target.removeEventListener;
  }
  const mqlAdd = MediaQueryList.prototype.addEventListener, mqlRemove = MediaQueryList.prototype.removeEventListener;
  MediaQueryList.prototype.addEventListener = function (this: MediaQueryList, ...args: Parameters<MediaQueryList['addEventListener']>) { mediaQueries++; return mqlAdd.apply(this, args); };
  MediaQueryList.prototype.removeEventListener = function (this: MediaQueryList, ...args: Parameters<MediaQueryList['removeEventListener']>) { mediaQueries--; return mqlRemove.apply(this, args); };
  const byPhase = (values: Iterable<string>) => { const out: Record<string, number> = {}; for (const value of values) out[value] = (out[value] ?? 0) + 1; return out; };
  window.__lifecycle = {
    get phase() { return phaseRef.value; },
    setPhase(phase: string) { phaseRef.value = phase; },
    counts: () => ({
      workers: { ...workers, live: live.size },
      timers: { ...timers, pending: byPhase(pending.values()) },
      intervals: { ...intervals, live: byPhase(liveIntervals.values()) },
      raf, shadowRoots,
      listeners: { window: [...registry.window].map(([key, phase]) => `${phase}:${key}`), document: [...registry.document].map(([key, phase]) => `${phase}:${key}`), mediaQueries },
    }),
  } as Instrumentation;
}

/**
 * Graphics and DOM resource instrumentation for the 3D cycles (installed before `instrument`, so its wrappers see the
 * calls `instrument` forwards). Released means: a WebGL context lost (a disposed renderer that the renderer pool does not
 * keep is disposed and its context loss forced), an observer disconnected or left with no observed target, a listener
 * removed (or fired with `once`, or aborted). A context kept by the pool for the next mount stays live with its canvas
 * out of the page.
 */
function instrumentGraphics(): void {
  const phase = () => (window as unknown as { __lifecycle?: { phase: string } }).__lifecycle?.phase ?? 'load';
  // WebGL contexts, held weakly; live = not lost.
  const contexts: WeakRef<WebGLRenderingContext>[] = [];
  const seenContexts = new WeakSet<object>();
  let lostWhileConnected = 0;
  const watchLoss = EventTarget.prototype.addEventListener;
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
    const context = (getContext as (...args: unknown[]) => unknown).call(this, type, ...rest);
    if (context && /webgl/i.test(type) && !seenContexts.has(context as object)) {
      seenContexts.add(context as object);
      contexts.push(new WeakRef(context as WebGLRenderingContext));
      // A disposal removes the canvas before the forced loss is dispatched; a loss seen while connected is a live view's.
      const canvas = this;
      watchLoss.call(canvas, 'webglcontextlost', () => { if (canvas.isConnected) lostWhileConnected++; });
    }
    return context;
  } as typeof getContext;
  let canvasesCreated = 0;
  const createElement = Document.prototype.createElement;
  Document.prototype.createElement = function (this: Document, tag: string, options?: ElementCreationOptions) {
    if (String(tag).toLowerCase() === 'canvas') canvasesCreated++;
    return createElement.call(this, tag, options);
  } as typeof createElement;
  const everyRoot = (visit: (root: Document | ShadowRoot) => void) => {
    const walk = (root: Document | ShadowRoot) => { visit(root); for (const element of root.querySelectorAll('*')) if (element.shadowRoot) walk(element.shadowRoot); };
    walk(document);
  };
  // Observers: each instance with the set of targets it still observes.
  const observed = { ResizeObserver: new Map<object, Set<object>>(), IntersectionObserver: new Map<object, Set<object>>(), MutationObserver: new Map<object, Set<object>>() };
  const created = { ResizeObserver: 0, IntersectionObserver: 0, MutationObserver: 0 };
  for (const name of ['ResizeObserver', 'IntersectionObserver', 'MutationObserver'] as const) {
    const Native = window[name] as unknown as { prototype: { observe(target: object, options?: unknown): void; unobserve?(target: object): void; disconnect(): void } };
    const registry = observed[name];
    const observe = Native.prototype.observe, disconnect = Native.prototype.disconnect, unobserve = Native.prototype.unobserve;
    Native.prototype.observe = function (this: object, target: object, options?: unknown) {
      if (!registry.has(this)) { registry.set(this, new Set()); created[name]++; }
      registry.get(this)!.add(target);
      return observe.call(this, target, options);
    };
    Native.prototype.disconnect = function (this: object) { registry.delete(this); return disconnect.call(this); };
    if (unobserve) Native.prototype.unobserve = function (this: object, target: object) { registry.get(this)?.delete(target); if (registry.get(this)?.size === 0) registry.delete(this); return unobserve.call(this, target); };
  }
  // Listeners, keyed by target, type, listener and capture flag; targets held weakly.
  const ids = new WeakMap<object, number>();
  let next = 0;
  const idOf = (value: object) => { if (!ids.has(value)) ids.set(value, ++next); return ids.get(value)!; };
  const listeners = new Map<string, { target: WeakRef<EventTarget>; phase: string; label: string }>();
  const nativeAdd = EventTarget.prototype.addEventListener, nativeRemove = EventTarget.prototype.removeEventListener;
  const keyOf = (target: EventTarget, type: string, listener: unknown, options: unknown) => {
    const capture = typeof options === 'boolean' ? options : !!(options as { capture?: boolean } | undefined)?.capture;
    return `${idOf(target)}:${type}#${idOf(listener as object)}${capture ? ':capture' : ''}`;
  };
  const describe = (target: EventTarget) => target === window ? 'window' : target === document ? 'document' : target instanceof MediaQueryList ? `mql(${target.media})`
    : target instanceof Element ? `${target.tagName.toLowerCase()}${target.className && typeof target.className === 'string' ? `.${target.className.split(' ')[0]}` : ''}` : target instanceof ShadowRoot ? 'shadow-root' : target.constructor.name;
  EventTarget.prototype.addEventListener = function (this: EventTarget, type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
    if (listener && (typeof listener === 'function' || typeof listener === 'object')) {
      const key = keyOf(this, type, listener, options);
      if (!listeners.has(key)) {
        listeners.set(key, { target: new WeakRef(this), phase: phase(), label: `${describe(this)}:${type}` });
        const capture = typeof options === 'boolean' ? options : !!options?.capture;
        if (typeof options === 'object' && options?.once) nativeAdd.call(this, type, () => listeners.delete(key), { once: true, capture });
        if (typeof options === 'object' && options?.signal) options.signal.addEventListener('abort', () => listeners.delete(key), { once: true });
      }
    }
    return nativeAdd.call(this, type, listener, options);
  };
  EventTarget.prototype.removeEventListener = function (this: EventTarget, type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) {
    if (listener && (typeof listener === 'function' || typeof listener === 'object')) listeners.delete(keyOf(this, type, listener, options));
    return nativeRemove.call(this, type, listener, options);
  };
  // Pending animation frames by the test phase that requested them.
  const frames = new Map<number, string>();
  const raf = window.requestAnimationFrame.bind(window), cancelRaf = window.cancelAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback => { const id: number = raf(time => { frames.delete(id); callback(time); }); frames.set(id, phase()); return id; }) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = (id => { frames.delete(id); cancelRaf(id); }) as typeof window.cancelAnimationFrame;
  const byPhase = (values: Iterable<string>) => { const out: Record<string, number> = {}; for (const value of values) out[value] = (out[value] ?? 0) + 1; return out; };
  window.__graphics = {
    counts: () => {
      let connected = 0, surfaces = 0;
      everyRoot(root => { connected += root.querySelectorAll('canvas').length; surfaces += root.querySelectorAll('[data-explorable-models-activity]').length; });
      const live = [...listeners].filter(([, entry]) => {
        const target = entry.target.deref();
        return !!target && (target === window || target instanceof MediaQueryList || (target instanceof Node && target.isConnected));
      }).map(([key, entry]) => `${entry.phase}:${entry.label}:${key}`).sort();
      const observers = Object.fromEntries((Object.keys(observed) as (keyof typeof observed)[]).map(name => [name, { created: created[name], unreleased: observed[name].size }])) as GraphicsCounts['observers'];
      return {
        contexts: { created: contexts.length, live: contexts.filter(ref => { const context = ref.deref(); return !!context && !context.isContextLost(); }).length },
        canvases: { created: canvasesCreated, connected },
        observers, listeners: live, frames: { pending: byPhase(frames.values()) }, surfaces, lostWhileConnected,
      };
    },
  };
}

async function openPage(page: Page, mode: 'interactive' | 'empty' = 'interactive'): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(instrument);
  await page.goto(`${PAGE}?mode=${mode}`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true' || document.body.dataset.ready === 'failed', undefined, { timeout: 60_000 });
  expect(await page.evaluate(() => document.body.dataset.ready), await page.locator('#lf-status').textContent() ?? '').toBe('true');
  return errors;
}
const card = (page: Page, activityId: string): Locator => page.locator(`.lf-card[data-activity-id="${activityId}"]`);
const counts = (page: Page) => page.evaluate(() => window.__lifecycle.counts());
const snapshot = (page: Page, activityId: string) => page.evaluate(id => window.lifecycleFixture.snapshot(id), activityId);
const ui = (page: Page, activityId: string) => page.evaluate(id => window.lifecycleFixture.cards.get(id)!.learner.getProjection().status.ui, activityId);

/** Resource activity during a quiet window: worker messages, timers, animation frames and DOM mutations of one surface. */
async function quietWindow(page: Page, activityId: string, ms: number) {
  return page.evaluate(async ({ id, ms }) => {
    const before = window.__lifecycle.counts();
    const root = document.querySelector(`.lf-card[data-activity-id="${id}"] [data-explorable-models-activity]`)?.shadowRoot;
    let mutations = 0;
    const observer = new MutationObserver(records => { mutations += records.length; });
    if (root) observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    const notificationsBefore = window.lifecycleFixture.cards.get(id)!.notifications;
    await new Promise(resolve => window.setTimeout(resolve, ms));
    observer.disconnect();
    const after = window.__lifecycle.counts();
    return {
      workerMessages: after.workers.messages - before.workers.messages,
      // The window's own timer is excluded.
      timers: after.timers.set - before.timers.set - 1,
      raf: after.raf - before.raf,
      mutations,
      notifications: window.lifecycleFixture.cards.get(id)!.notifications - notificationsBefore,
      liveWorkers: after.workers.live,
    };
  }, { id: activityId, ms });
}

test.describe('study activity lifecycle (A41–A43)', () => {
  test('two simultaneous activities under one adapter are isolated and rapid input changes coalesce (A41)', async ({ page }) => {
    const errors = await openPage(page);
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.screenshot({ path: `${SHOTS}/default.png` });
    // Commands on the quadratic card leave the derivative card's projection, journal and listeners untouched.
    const isolation = await page.evaluate(async () => {
      const f = window.lifecycleFixture, q = 'card-quadratic', d = 'card-derivative';
      const quad = f.cards.get(q)!, deriv = f.cards.get(d)!;
      const derivBefore = f.snapshot(d);
      const outcomes: CommandOutcome[] = [];
      outcomes.push(await quad.learner.commitParameters({ operationId: f.op('c'), ...f.guards(q), displayValues: { eta: 0.75 } }));
      outcomes.push(await quad.learner.navigate({ operationId: f.op('n'), ...f.guards(q), position: { kind: 'index', index: 4 } }));
      outcomes.push(quad.learner.setLayout({ operationId: f.op('l'), expectedPresentationRevision: quad.learner.getProjection().presentationRevision, layout: 'side' }));
      await f.until(() => f.snapshot(q).persistence === 'saved');
      const derivAfterQuad = f.snapshot(d);
      // Both previews at once, then commit one and cancel the other.
      const pq = quad.learner.beginPreview({ operationId: f.op('bp'), ...f.guards(q), gesture: 'keyboard', parameter: 'eta' });
      const pd = deriv.learner.beginPreview({ operationId: f.op('bp'), ...f.guards(d), gesture: 'keyboard', parameter: 'p' });
      const qPreview = quad.learner.getProjection().preview!.previewId, dPreview = deriv.learner.getProjection().preview!.previewId;
      quad.learner.updatePreview({ operationId: f.op('u'), previewId: qPreview, displayValues: { eta: 1.2 } });
      deriv.learner.updatePreview({ operationId: f.op('u'), previewId: dPreview, displayValues: { p: 1.5 } });
      await f.until(() => quad.learner.getProjection().frame?.kind === 'tentative' && deriv.learner.getProjection().frame?.kind === 'tentative');
      const committed = await quad.learner.commitPreview({ operationId: f.op('cp'), ...f.guards(q), previewId: qPreview });
      const derivDuring = f.snapshot(d);
      const cancelled = deriv.learner.cancelPreview({ operationId: f.op('x'), previewId: dPreview, reason: 'escape' });
      await f.until(() => f.snapshot(d).persistence === 'saved' && f.snapshot(q).persistence === 'saved');
      return {
        outcomes: outcomes.map(item => item.ok), previews: [pq.ok, pd.ok, committed.ok, cancelled.ok], derivBefore, derivAfterQuad, derivDuring, quadAfter: f.snapshot(q), derivAfter: f.snapshot(d),
      };
    });
    expect(isolation.outcomes).toEqual([true, true, true]);
    expect(isolation.previews).toEqual([true, true, true, true]);
    expect(isolation.derivAfterQuad).toEqual(isolation.derivBefore);
    expect(isolation.derivDuring.preview?.parameter).toBe('p');
    expect(isolation.derivDuring.frame?.kind).toBe('tentative');
    expect(isolation.derivDuring.controls.p.value).toBe(isolation.derivBefore.controls.p.value);
    expect(isolation.quadAfter.controls.eta.value).toBe(1.2);
    expect(isolation.derivAfter.controls).toEqual(isolation.derivBefore.controls);
    expect(isolation.derivAfter.guards).toEqual(isolation.derivBefore.guards);
    expect(isolation.derivAfter.frame?.frameId).toBe(isolation.derivBefore.frame?.frameId);

    // Rapid changes while the first evaluation is outstanding: one active evaluation plus the newest queued value.
    const burst = await page.evaluate(async () => {
      const f = window.lifecycleFixture, d = 'card-derivative', deriv = f.cards.get(d)!;
      const start = window.__lifecycle.counts().workers.messages;
      f.workers.holdReplies(true);
      const begin = deriv.learner.beginPreview({ operationId: f.op('bp'), ...f.guards(d), gesture: 'pointer', parameter: 'p' });
      const previewId = deriv.learner.getProjection().preview!.previewId;
      const values = Array.from({ length: 40 }, (_, index) => Number((-2 + index * 0.1).toFixed(1)));
      for (const p of values) deriv.learner.updatePreview({ operationId: f.op('u'), previewId, displayValues: { p } });
      await new Promise(resolve => window.setTimeout(resolve, 300));
      const whileHeld = window.__lifecycle.counts().workers.messages - start;
      f.workers.holdReplies(false);
      f.workers.flush();
      const last = values.at(-1)!;
      await f.until(() => deriv.learner.getProjection().controls.find(control => control.parameter === 'p')?.previewValue === last && deriv.learner.getProjection().frame?.kind === 'tentative'
        && (deriv.learner.getProjection().frame as { frameId: string } | null) !== null);
      await new Promise(resolve => window.setTimeout(resolve, 200));
      const previewTotal = window.__lifecycle.counts().workers.messages - start;
      const commit = await deriv.learner.commitPreview({ operationId: f.op('cp'), ...f.guards(d), previewId });
      await f.until(() => f.snapshot(d).persistence === 'saved');
      const host = f.host.events(d).filter(event => event.type === 'preview.observed').at(-1)!;
      return { begin: begin.ok, updates: values.length, whileHeld, previewTotal, total: window.__lifecycle.counts().workers.messages - start, commit: commit.ok, committedP: f.snapshot(d).controls.p.value, observed: host.payload, live: window.__lifecycle.counts().workers.live };
    });
    expect(burst.begin).toBe(true);
    expect(burst.whileHeld).toBe(1);
    expect(burst.previewTotal).toBe(2);
    expect(burst.total).toBe(3);
    expect(burst.commit).toBe(true);
    expect(burst.committedP).toBe(1.9);
    expect(burst.live).toBeLessThanOrEqual(6);

    // A real pointer drag on the quadratic step-size slider while replies are held: still bounded to one in flight.
    const slider = card(page, 'card-quadratic').getByRole('slider').first();
    await slider.scrollIntoViewIfNeeded();
    const box = (await slider.boundingBox())!;
    const startMessages = (await counts(page)).workers.messages;
    await page.evaluate(() => window.lifecycleFixture.workers.holdReplies(true));
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2, { steps: 25 });
    const heldDrag = (await counts(page)).workers.messages - startMessages;
    await page.mouse.up();
    await page.evaluate(() => { window.lifecycleFixture.workers.holdReplies(false); window.lifecycleFixture.workers.flush(); });
    await expect.poll(() => snapshot(page, 'card-quadratic').then(state => state.frame?.kind === 'committed' && state.preview === null && state.persistence === 'saved')).toBe(true);
    const dragTotal = (await counts(page)).workers.messages - startMessages;
    expect(heldDrag).toBeLessThanOrEqual(1);
    expect(dragTotal).toBeLessThanOrEqual(3);
    test.info().annotations.push({ type: 'A41 coalescing', description: JSON.stringify({ updates: burst.updates, whileHeld: burst.whileHeld, previewMessages: burst.previewTotal, withCommit: burst.total, dragMoves: 25, dragHeld: heldDrag, dragTotal }) });
    expect(errors).toEqual([]);
  });

  test('20 suspended history cards hold frozen state without workers or timers and compute only when reactivated (§9, §18)', async ({ page }) => {
    const errors = await openPage(page);
    const history = await page.evaluate(() => [...window.lifecycleFixture.cards.values()].filter(card => card.activityId.startsWith('history-')).map(card => ({ id: card.activityId, ui: card.learner.getProjection().status.ui, projectionId: card.learner.getProjection().projectionId })));
    expect(history).toHaveLength(20);
    expect(history.every(item => item.ui === 'suspended')).toBe(true);
    const settled = await counts(page);
    // Only the two active cards hold a worker (their primary leases); suspended cards hold none.
    expect(settled.workers.live).toBe(2);
    expect(settled.workers.peak).toBeLessThanOrEqual(6);
    const quiet = await quietWindow(page, 'history-3', 1500);
    expect(quiet).toMatchObject({ workerMessages: 0, timers: 0, raf: 0, mutations: 0, notifications: 0, liveWorkers: 2 });
    const frozen = await page.evaluate(() => [...window.lifecycleFixture.cards.values()].filter(card => card.activityId.startsWith('history-')).map(card => card.learner.getProjection().projectionId));
    expect(frozen).toEqual(history.map(item => item.projectionId));

    // Reactivation: resume alone acquires nothing; the next evaluation leases a worker; suspending gives it back.
    await card(page, 'history-2').scrollIntoViewIfNeeded();
    const reactivated = await page.evaluate(async () => {
      const f = window.lifecycleFixture, id = 'history-2', item = f.cards.get(id)!;
      // Scrolling to the history moved the active cards offscreen: they suspend and give their workers back too.
      await f.until(() => ['card-quadratic', 'card-derivative'].every(active => f.cards.get(active)!.learner.getProjection().status.ui === 'suspended'));
      await f.until(() => window.__lifecycle.counts().workers.live === 0);
      const before = window.__lifecycle.counts().workers;
      const resumed = item.prepared.host.resume({ operationId: f.op('resume') }).ok;
      try { await f.until(() => item.learner.getProjection().status.ui !== 'suspended'); } catch { return { failed: f.host.events(id).map(event => event.type), ui: item.learner.getProjection().status.ui } as never; }
      const afterResume = window.__lifecycle.counts().workers;
      const commit = await item.learner.commitParameters({ operationId: f.op('c'), ...f.guards(id), displayValues: { eta: 0.5 } });
      const afterCommit = window.__lifecycle.counts().workers;
      item.prepared.host.suspend({ operationId: f.op('s'), reason: 'host' });
      await f.until(() => window.__lifecycle.counts().workers.live === before.live);
      return { resumed, commit: commit.ok, before, afterResume, afterCommit, after: window.__lifecycle.counts().workers, ui: item.learner.getProjection().status.ui };
    });
    expect(reactivated.resumed && reactivated.commit).toBe(true);
    expect(reactivated.afterResume.created).toBe(reactivated.before.created);
    expect(reactivated.afterResume.messages).toBe(reactivated.before.messages);
    expect(reactivated.afterCommit.live).toBe(reactivated.before.live + 1);
    expect(reactivated.afterCommit.messages).toBeGreaterThan(reactivated.before.messages);
    expect(reactivated.after.live).toBe(reactivated.before.live);
    expect(reactivated.ui).toBe('suspended');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await card(page, 'history-0').evaluate(element => element.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/history-suspended.png` });
    test.info().annotations.push({ type: '§18 history cards', description: JSON.stringify({ cards: 20, liveWorkers: settled.workers.live, peakWorkers: settled.workers.peak, quiet, reactivated: { workersBefore: reactivated.before.live, duringCommit: reactivated.afterCommit.live, after: reactivated.after.live } }) });
    expect(errors).toEqual([]);
  });

  for (const variant of ['offscreen', 'collapsed', 'display-none', 'hidden', 'host'] as const) {
    test(`${variant}: playback and worker work stop, and resume is paused without wall-clock catch-up (A42)`, async ({ page }) => {
      const errors = await openPage(page);
      const id = 'card-quadratic';
      await card(page, id).scrollIntoViewIfNeeded();
      const playing = await page.evaluate(async () => {
        const f = window.lifecycleFixture, item = f.cards.get('card-quadratic')!;
        const play = item.learner.play({ operationId: f.op('play'), ...f.guards('card-quadratic') });
        const start = window.__lifecycle.counts().workers.messages;
        await f.until(() => (item.learner.getProjection().navigation?.value ?? 0) >= 2, 8000);
        return { play: play.ok, ticks: window.__lifecycle.counts().workers.messages - start };
      });
      expect(playing.play).toBe(true);
      expect(playing.ticks).toBeGreaterThanOrEqual(2);
      // Suspend through the variant.
      if (variant === 'offscreen') await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      if (variant === 'collapsed') await card(page, id).locator(':scope > summary').click();
      if (variant === 'display-none') await card(page, id).evaluate(element => { (element as HTMLElement).style.display = 'none'; });
      if (variant === 'hidden') await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      if (variant === 'host') expect(await page.evaluate(() => window.lifecycleFixture.cards.get('card-quadratic')!.prepared.host.suspend({ operationId: window.lifecycleFixture.op('s'), reason: 'host' }).ok)).toBe(true);
      await expect.poll(() => ui(page, id)).toBe('suspended');
      const suspendedAt = await snapshot(page, id);
      expect(suspendedAt.navigation?.playing).toBe(false);
      await page.waitForTimeout(300);
      const quiet = await quietWindow(page, id, 1500);
      expect(quiet).toMatchObject({ workerMessages: 0, timers: 0, raf: 0, mutations: 0, notifications: 0 });
      const events = await page.evaluate(() => window.lifecycleFixture.host.events('card-quadratic').map(event => event.type));
      expect(events.slice(-2)).toEqual(['playback.paused', 'activity.suspended']);
      // Undo the variant; the activity resumes paused at the same position, with no catch-up for the elapsed time.
      if (variant === 'offscreen') await card(page, id).scrollIntoViewIfNeeded();
      if (variant === 'collapsed') await card(page, id).locator(':scope > summary').click();
      if (variant === 'display-none') await card(page, id).evaluate(element => { (element as HTMLElement).style.display = ''; });
      if (variant === 'hidden') await page.evaluate(() => {
        delete (document as { visibilityState?: unknown }).visibilityState;
        delete (document as { hidden?: unknown }).hidden;
        document.dispatchEvent(new Event('visibilitychange'));
      });
      if (variant === 'host') await page.evaluate(() => window.lifecycleFixture.cards.get('card-quadratic')!.prepared.host.resume({ operationId: window.lifecycleFixture.op('r') }));
      await expect.poll(() => ui(page, id)).not.toBe('suspended');
      const resumed = await snapshot(page, id);
      expect(resumed.navigation?.playing).toBe(false);
      expect(resumed.navigation?.value).toBe(suspendedAt.navigation?.value);
      expect(resumed.frame?.position).toEqual(suspendedAt.frame?.position);
      await page.waitForTimeout(900);
      expect((await snapshot(page, id)).navigation?.value).toBe(suspendedAt.navigation?.value);
      const after = await page.evaluate(() => window.lifecycleFixture.host.events('card-quadratic').map(event => event.type));
      expect(after.at(-1)).toBe('activity.resumed');
      // Playback can continue, one index per tick from the declared position.
      const continued = await page.evaluate(async from => {
        const f = window.lifecycleFixture, item = f.cards.get('card-quadratic')!;
        item.learner.play({ operationId: f.op('play'), ...f.guards('card-quadratic') });
        await f.until(() => (item.learner.getProjection().navigation?.value ?? 0) > from, 4000);
        const value = item.learner.getProjection().navigation!.value;
        item.learner.pause({ operationId: f.op('pause'), ...f.guards('card-quadratic') });
        return value;
      }, suspendedAt.navigation!.value);
      expect(continued).toBe(suspendedAt.navigation!.value + 1);
      if (variant === 'host') await page.screenshot({ path: `${SHOTS}/resumed.png` });
      test.info().annotations.push({ type: `A42 ${variant}`, description: JSON.stringify({ ticksBefore: playing.ticks, quiet, position: suspendedAt.navigation?.value }) });
      expect(errors).toEqual([]);
    });
  }

  test('100 mount/interact/suspend/restore/dispose cycles leave no activity-owned workers, timers, listeners or surfaces (A43, §18)', async ({ page }) => {
    test.setTimeout(240_000);
    const errors = await openPage(page, 'empty');
    // Warm-up cycle: one-time module loads and caches (math, stylesheets) are pool resources, measured separately.
    await page.evaluate(() => window.lifecycleFixture.cycle(0));
    await page.waitForTimeout(300);
    const baseline = await counts(page);
    const result = await page.evaluate(async () => {
      const f = window.lifecycleFixture;
      window.__lifecycle.setPhase('cycles');
      const started = performance.now();
      for (let index = 1; index <= 100; index++) await f.cycle(index);
      const elapsed = performance.now() - started;
      window.__lifecycle.setPhase('settle');
      await new Promise(resolve => window.setTimeout(resolve, 500));
      const open = [...f.cards.keys()];
      const states = Array.from({ length: 101 }, (_, index) => 'diagnostics' in f.adapter.getState(`stress-${index}`, 'host'));
      return { elapsed, open, closedEverywhere: states.every(Boolean), hostActivities: f.host.activities().length, surfaces: document.querySelectorAll('[data-explorable-models-activity]').length, pageWorkers: { created: f.workers.created, terminated: f.workers.terminated } };
    });
    const end = await counts(page);
    const created = end.workers.created - baseline.workers.created;
    const report = {
      cycles: 100, elapsedMs: Math.round(result.elapsed),
      workers: { createdDuringCycles: created, terminatedDuringCycles: end.workers.terminated - baseline.workers.terminated, liveAtEnd: end.workers.live, peakLive: end.workers.peak },
      timers: { pendingFromCycles: end.timers.pending.cycles ?? 0, setDuringRun: end.timers.set - baseline.timers.set },
      intervals: { liveFromCycles: end.intervals.live.cycles ?? 0 },
      listeners: {
        window: end.listeners.window.filter(key => !baseline.listeners.window.includes(key)),
        document: end.listeners.document.filter(key => !baseline.listeners.document.includes(key)),
        mediaQueryNet: end.listeners.mediaQueries - baseline.listeners.mediaQueries,
      },
      shadowRoots: { attachedDuringCycles: end.shadowRoots - baseline.shadowRoots, connectedAtEnd: result.surfaces },
      adapter: { openActivities: result.open.length, everyCycleClosed: result.closedEverywhere },
      pool: { workerBudgetMax: 6, peakLiveWorkers: end.workers.peak, hostActivityRecordsRetained: result.hostActivities },
    };
    test.info().annotations.push({ type: 'A43 lifecycle stress', description: JSON.stringify(report) });
    expect(report.workers.liveAtEnd).toBe(0);
    expect(report.workers.terminatedDuringCycles).toBe(created);
    expect(created).toBeGreaterThanOrEqual(200);
    expect(report.workers.peakLive).toBeLessThanOrEqual(6);
    expect(report.timers.pendingFromCycles).toBe(0);
    expect(report.intervals.liveFromCycles).toBe(0);
    expect(report.listeners.window).toEqual([]);
    expect(report.listeners.document).toEqual([]);
    expect(report.listeners.mediaQueryNet).toBe(0);
    expect(report.shadowRoots.attachedDuringCycles).toBe(200);
    expect(report.shadowRoots.connectedAtEnd).toBe(0);
    expect(report.adapter).toEqual({ openActivities: 0, everyCycleClosed: true });
    // Host records are the host's durable state, not activity-owned resources: they are retained by design.
    expect(report.pool.hostActivityRecordsRetained).toBe(101);
    expect(result.pageWorkers.created).toBe(result.pageWorkers.terminated);
    expect(errors).toEqual([]);
  });

  test('disposal during prepare, evaluate, save, reveal and capture produces no later visible callback (A43)', async ({ page }) => {
    const errors = await openPage(page, 'empty');
    const outcome = await page.evaluate(async () => {
      const f = window.lifecycleFixture;
      const settle = (ms = 250) => new Promise(resolve => window.setTimeout(resolve, ms));
      const codes = (value: { ok: boolean; diagnostics?: { code: string }[] }) => value.ok ? ['OK'] : (value.diagnostics ?? []).map(item => item.code);
      const results: Record<string, unknown> = {};

      // prepare: dispose while the host registration is outstanding.
      f.host.hold('registerActivity');
      const workersBefore = window.__lifecycle.counts().workers.created;
      const preparing = f.adapter.prepare({ activityId: 'dispose-prepare', objectiveIds: ['lifecycle'], hostSessionId: 'lifecycle-session', hostSessionRevision: 0, template: { templateId: 'quadratic-gradient-descent', version: '1.0.0' }, mode: 'approved', stageId: 'free-explore' }, { operationId: f.op('prepare') });
      await f.until(() => f.host.calls('registerActivity', 'dispose-prepare').length === 1);
      f.adapter.dispose('dispose-prepare');
      f.host.release('registerActivity');
      const prepared = await preparing;
      await settle();
      results.prepare = { codes: codes(prepared), hostCalls: f.host.calls(undefined, 'dispose-prepare').map(call => call.method), workersCreated: window.__lifecycle.counts().workers.created - workersBefore, open: !('diagnostics' in f.adapter.getState('dispose-prepare', 'host')) };

      // evaluate: dispose while the worker reply of a commit is held.
      const evaluating = await f.open({ activityId: 'dispose-evaluate', template: 'quadratic', container: 'stress' });
      await f.until(() => f.snapshot('dispose-evaluate').persistence === 'saved');
      f.workers.holdReplies(true);
      const messages = window.__lifecycle.counts().workers.messages;
      const commit = evaluating.learner.commitParameters({ operationId: f.op('c'), ...f.guards('dispose-evaluate'), displayValues: { eta: 0.5 } });
      await f.until(() => window.__lifecycle.counts().workers.messages > messages);
      const eventsAtDispose = f.host.events('dispose-evaluate').length;
      // Disposal itself notifies a still-subscribed surface once with the disposed projection (report §10.4, G39);
      // A43 is about what comes after it.
      const beforeClose = evaluating.notifications;
      f.close('dispose-evaluate');
      const notified = evaluating.notifications;
      f.workers.holdReplies(false);
      f.workers.flush();
      const committed = await commit;
      await settle();
      results.evaluate = { codes: codes(committed), atDisposal: notified - beforeClose, notificationsAfter: evaluating.notifications - notified, eventsAfter: f.host.events('dispose-evaluate').length - eventsAtDispose, ui: evaluating.learner.getProjection().status.ui, surface: !!document.querySelector('[data-explorable-models-activity="surface-dispose-evaluate"]') };

      // save: dispose while the host save is outstanding.
      const saving = await f.open({ activityId: 'dispose-save', template: 'derivative', container: 'stress' });
      await f.until(() => f.snapshot('dispose-save').persistence === 'saved');
      f.host.hold('saveArtifact');
      const save = saving.prepared.host.save({ operationId: f.op('save'), kind: 'backup' });
      await f.until(() => f.host.calls('saveArtifact', 'dispose-save').length === 1);
      const saveEvents = f.host.events('dispose-save').length;
      f.close('dispose-save');
      const saveNotified = saving.notifications;
      f.host.release('saveArtifact');
      const saved = await save;
      await settle();
      results.save = { codes: codes(saved), notificationsAfter: saving.notifications - saveNotified, events: f.host.events('dispose-save').slice(saveEvents).map(event => event.type) };

      // reveal: dispose while the exposure intent is outstanding; nothing may be acknowledged as displayed.
      const revealing = await f.open({ activityId: 'dispose-reveal', template: 'quadratic', container: 'stress' });
      await f.until(() => f.snapshot('dispose-reveal').persistence === 'saved');
      f.host.hold('recordExposureIntent');
      const projection = revealing.learner.getProjection();
      const reveal = revealing.prepared.host.requestReveal({ operationId: f.op('reveal'), expectedActivityRevision: projection.activityRevision, expectedPolicyRevision: projection.policyRevision, groups: ['trace'] });
      await f.until(() => f.host.calls('recordExposureIntent', 'dispose-reveal').length === 1);
      const revealEvents = f.host.events('dispose-reveal').length;
      f.close('dispose-reveal');
      const revealNotified = revealing.notifications;
      f.host.release('recordExposureIntent');
      const revealed = await reveal;
      await settle();
      results.reveal = {
        codes: codes(revealed), notificationsAfter: revealing.notifications - revealNotified, displayAcks: f.host.calls('recordDisplayAck', 'dispose-reveal').length,
        events: f.host.events('dispose-reveal').slice(revealEvents).map(event => event.type), exposures: f.host.exposures('dispose-reveal').map(record => record.displayStatus),
      };

      // capture: dispose immediately, and dispose while a PNG capture is being produced.
      const capturing = await f.open({ activityId: 'dispose-capture', template: 'quadratic', container: 'stress' });
      const first = capturing.mounted!.capture({ format: 'png' }).then(() => 'resolved', (error: { code?: string }) => error.code ?? 'error');
      capturing.mounted!.dispose();
      const immediate = await first;
      const second = await f.open({ activityId: 'dispose-capture-2', template: 'derivative', container: 'stress' });
      let settledAt = -1, disposedAt = -1;
      const late = second.mounted!.capture({ format: 'png', scale: 4 }).then(() => { settledAt = performance.now(); return 'resolved'; }, (error: { code?: string }) => { settledAt = performance.now(); return error.code ?? 'error'; });
      await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
      await new Promise(resolve => window.setTimeout(resolve, 0));
      disposedAt = performance.now();
      f.close('dispose-capture-2');
      const lateOutcome = await late;
      f.close('dispose-capture');
      await settle();
      results.capture = { immediate, late: lateOutcome, lateSettledAfterDispose: settledAt >= disposedAt, surfaces: document.querySelectorAll('[data-explorable-models-activity]').length };
      results.end = { live: window.__lifecycle.counts().workers.live, open: [...f.cards.keys()] };
      return results;
    });
    test.info().annotations.push({ type: 'A43 disposal', description: JSON.stringify(outcome) });
    expect(outcome.prepare).toEqual({ codes: ['DISPOSED'], hostCalls: ['getPolicy', 'registerActivity'], workersCreated: 0, open: false });
    expect(outcome.evaluate).toEqual({ codes: ['DISPOSED'], atDisposal: 1, notificationsAfter: 0, eventsAfter: 0, ui: 'disposed', surface: false });
    expect(outcome.save).toEqual({ codes: ['DISPOSED'], notificationsAfter: 0, events: [] });
    expect(outcome.reveal).toMatchObject({ codes: ['DISPOSED'], notificationsAfter: 0, displayAcks: 0, events: [] });
    // The host committed the intent it was asked for (its record, never displayed): conservatively potentially seen.
    expect((outcome.reveal as { exposures: string[] }).exposures.every(status => status !== 'displayed')).toBe(true);
    expect((outcome.capture as { immediate: string }).immediate).toBe('DISPOSED');
    // A capture interrupted by disposal rejects DISPOSED (never NOT_READY, never data after disposal); only a capture
    // that completed before the disposal may have resolved.
    const late = outcome.capture as { late: string; lateSettledAfterDispose: boolean };
    expect(late.late === 'DISPOSED' || (late.late === 'resolved' && !late.lateSettledAfterDispose), JSON.stringify(late)).toBe(true);
    expect((outcome.capture as { surfaces: number }).surfaces).toBe(0);
    expect(outcome.end).toEqual({ live: 0, open: [] });
    expect(errors).toEqual([]);
  });

  test('3D cards: mount/interact/suspend/restore/dispose cycles of both spatial activities, with motion-preference remounts, reuse one pooled WebGL context and leave no contexts, canvases, observers, listeners, workers, timers or frames (A47, §13, §18)', async ({ page }) => {
    test.setTimeout(600_000);
    // §18: 100 cycles, alternating the two spatial activities; every fourth cycle also changes the motion preference.
    const CYCLES = Number(process.env.SPATIAL_CYCLES ?? 100), MOTION_EVERY = 4;
    const warnings: string[] = [];
    page.on('console', message => { if (/too many active webgl contexts|WEBGL_lose_context|context lost/i.test(message.text())) warnings.push(message.text()); });
    // Saving any source file during this multi-minute run would make the dev server reload the page in the middle of
    // the measurement. The page's Vite HMR socket is answered by a stub that sends nothing (the page itself is unchanged).
    await page.routeWebSocket(url => url.searchParams.has('token'), () => undefined);
    await page.addInitScript(instrumentGraphics);
    const errors = await openPage(page, 'empty');
    const graphics = () => page.evaluate(() => window.__graphics.counts());
    const state = (id: string) => page.evaluate(key => window.lifecycleFixture.spatialState(key), id);
    /**
     * Changes the motion preference and waits until the SpatialView has remounted its renderer (a new renderer root
     * replaces the marked one) and it is ready. The remount reuses the pooled renderer: no context is created.
     */
    const remount = async (id: string, reducedMotion: 'reduce' | 'no-preference') => {
      const before = (await graphics()).contexts.created;
      await page.evaluate(key => { window.lifecycleFixture.cards.get(key)!.mounted!.element.shadowRoot!.querySelector('[data-em3-root]')!.setAttribute('data-test-replaced', ''); }, id);
      await page.emulateMedia({ reducedMotion });
      await page.waitForFunction(key => {
        const root = window.lifecycleFixture.cards.get(key)?.mounted?.element.shadowRoot?.querySelector('[data-em3-root]');
        return !!root && !root.hasAttribute('data-test-replaced');
      }, id, { timeout: 20_000 });
      await page.evaluate(key => window.lifecycleFixture.spatialReady(key), id);
      const after = await graphics();
      return { created: after.contexts.created - before, live: after.contexts.live, canvases: after.canvases.connected };
    };
    const cycle = async (index: number, motion: boolean) => {
      const id = await page.evaluate(i => window.lifecycleFixture.spatialOpen(i), index);
      const mounted = await graphics();
      // The project runs with reduced motion; allowing motion and reducing it again each remount the renderer.
      const remounts = motion ? [await remount(id, 'no-preference'), await remount(id, 'reduce')] : [];
      const closed = await page.evaluate(key => window.lifecycleFixture.spatialClose(key), id);
      return { index, template: index % 2 ? 'surface' : 'vector', mounted: { live: mounted.contexts.live, canvases: mounted.canvases.connected, surfaces: mounted.surfaces }, remounts, ...closed, after: await graphics() };
    };
    // Warm-up: one cycle of each spatial activity with a remount (module loads, shader programs, stylesheets and the
    // worker pool are page-lifetime resources, measured separately from the cycles).
    await cycle(0, true);
    await cycle(1, true);
    await page.waitForTimeout(500);
    const baseline = await graphics();
    const baseLifecycle = await counts(page);
    // The warm-up created one renderer (and its context and canvas); the pool keeps it, idle and out of the page.
    expect({ created: baseline.contexts.created, live: baseline.contexts.live, canvases: baseline.canvases.connected }).toEqual({ created: 2, live: 1, canvases: 0 });
    await page.evaluate(() => window.__lifecycle.setPhase('cycles'));
    const started = Date.now();
    const samples: Awaited<ReturnType<typeof cycle>>[] = [];
    for (let index = 2; index < 2 + CYCLES; index++) samples.push(await cycle(index, index % MOTION_EVERY === 0));
    const elapsedMs = Date.now() - started;
    await page.evaluate(() => window.__lifecycle.setPhase('settle'));
    await page.waitForTimeout(800);
    const end = await graphics();
    const endLifecycle = await counts(page);
    const open = await page.evaluate(() => [...window.lifecycleFixture.cards.keys()]);
    const unreleased = (counts: GraphicsCounts) => Object.fromEntries(Object.entries(counts.observers).map(([name, value]) => [name, value.unreleased]));
    const report = {
      cycles: CYCLES, elapsedMs, motionRemounts: samples.reduce((total, sample) => total + sample.remounts.length, 0),
      contexts: { createdDuringCycles: end.contexts.created - baseline.contexts.created, liveAtBaseline: baseline.contexts.live, liveAtEnd: end.contexts.live, lostWhileConnected: end.lostWhileConnected },
      tooManyContextsWarnings: warnings.filter(text => /too many active webgl contexts/i.test(text)).length,
      canvases: { createdDuringCycles: end.canvases.created - baseline.canvases.created, connectedAtBaseline: baseline.canvases.connected, connectedAtEnd: end.canvases.connected },
      observers: { created: Object.fromEntries(Object.entries(end.observers).map(([name, value]) => [name, value.created - baseline.observers[name as keyof GraphicsCounts['observers']].created])), unreleasedAtBaseline: unreleased(baseline), unreleasedAtEnd: unreleased(end) },
      listeners: { added: end.listeners.filter(key => !baseline.listeners.includes(key)), removed: baseline.listeners.filter(key => !end.listeners.includes(key)).length },
      frames: { pendingFromCycles: end.frames.pending.cycles ?? 0 },
      timers: { pendingFromCycles: endLifecycle.timers.pending.cycles ?? 0, intervalsFromCycles: endLifecycle.intervals.live.cycles ?? 0 },
      workers: { created: endLifecycle.workers.created - baseLifecycle.workers.created, terminated: endLifecycle.workers.terminated - baseLifecycle.workers.terminated, liveAtEnd: endLifecycle.workers.live, peak: endLifecycle.workers.peak },
      windowDocumentListeners: { window: endLifecycle.listeners.window.filter(key => !baseLifecycle.listeners.window.includes(key)), document: endLifecycle.listeners.document.filter(key => !baseLifecycle.listeners.document.includes(key)), mediaQueryNet: endLifecycle.listeners.mediaQueries - baseLifecycle.listeners.mediaQueries },
      surfaces: { connectedAtEnd: end.surfaces, shadowRootsAttached: endLifecycle.shadowRoots - baseLifecycle.shadowRoots },
      openActivities: open,
    };
    test.info().annotations.push({ type: 'A47 3D lifecycle cycles', description: JSON.stringify(report) });
    // Every cycle: one live context and one canvas while a card is mounted (also after each motion remount) — the pooled
    // renderer's, so no context is created — and after disposal only that idle context, no canvas in the page and no
    // unreleased observer or listener beyond the baseline: no growth.
    for (const sample of samples) {
      expect(sample.mounted, `cycle ${sample.index} mounted`).toEqual({ live: 1, canvases: baseline.canvases.connected + 1, surfaces: 1 });
      for (const step of sample.remounts) expect(step, `cycle ${sample.index} remount`).toEqual({ created: 0, live: 1, canvases: baseline.canvases.connected + 1 });
      expect(sample.cameraRestored, `cycle ${sample.index} restored camera`).toBe(true);
      expect(sample.suspendedUi).toBe('suspended');
      expect({ created: sample.after.contexts.created, live: sample.after.contexts.live, canvases: sample.after.canvases.connected, observers: unreleased(sample.after), listeners: sample.after.listeners.length, surfaces: sample.after.surfaces }, `cycle ${sample.index} after dispose`)
        .toEqual({ created: baseline.contexts.created, live: baseline.contexts.live, canvases: baseline.canvases.connected, observers: unreleased(baseline), listeners: baseline.listeners.length, surfaces: 0 });
    }
    // Two mounts per cycle (the card and its restored copy) plus two per motion change, all on the pooled renderer.
    expect(report.contexts.createdDuringCycles).toBe(0);
    expect(report.canvases.createdDuringCycles).toBe(0);
    expect(report.contexts.liveAtEnd).toBe(baseline.contexts.live);
    // Releasing the idle renderers leaves no live context.
    expect(await page.evaluate(() => window.lifecycleFixture.releaseIdleSpatialRenderers())).toBe(1);
    expect((await graphics()).contexts.live).toBe(0);
    expect(report.canvases.connectedAtEnd).toBe(baseline.canvases.connected);
    expect(report.observers.unreleasedAtEnd).toEqual(report.observers.unreleasedAtBaseline);
    expect(report.listeners.added).toEqual([]);
    expect(report.frames.pendingFromCycles).toBe(0);
    expect(report.timers).toEqual({ pendingFromCycles: 0, intervalsFromCycles: 0 });
    expect(report.workers.liveAtEnd).toBe(0);
    expect(report.workers.terminated).toBe(report.workers.created);
    expect(report.workers.peak).toBeLessThanOrEqual(6);
    expect(report.windowDocumentListeners).toEqual({ window: [], document: [], mediaQueryNet: 0 });
    expect(report.surfaces).toEqual({ connectedAtEnd: 0, shadowRootsAttached: 2 * CYCLES });
    expect(report.openActivities).toEqual([]);
    // No view in use ever lost its context, and no engine evicted one: the cycles create no context, so WebKit (which
    // counts a lost context until it is collected) never reaches its limit of 16. Every engine is held to the same check.
    expect(report.contexts.lostWhileConnected).toBe(0);
    expect(report.tooManyContextsWarnings).toBe(0);
    expect(warnings).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('mobile width renders both active cards without horizontal overflow', async ({ page }) => {
    const errors = await openPage(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await card(page, 'card-quadratic').scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `${SHOTS}/mobile.png` });
    await card(page, 'card-derivative').scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/mobile-derivative.png` });
    expect(errors).toEqual([]);
  });
});

