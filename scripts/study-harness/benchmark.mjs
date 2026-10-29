#!/usr/bin/env node
// Performance and lifecycle benchmark of the PRODUCTION packed consumer (report §18; architecture D11, D14; A41–A43, A58).
//
//   node scripts/study-harness/verify-consumer.mjs   # builds release/study-harness/consumer/dist from the packed tarballs
//   node scripts/study-harness/benchmark.mjs [--quick]
//
// Serves release/study-harness/consumer/dist with the production CSP and drives its benchmark page (bench.html) in
// Playwright Chromium on this machine (the reference machine recorded in the evidence). Every measurement repeats after
// discarded warmups and reports nearest-rank p50/p95/max with the sample count, separating worker evaluation, render
// (projection → DOM → paint) and durable host acknowledgement; the page's host is an in-memory fixture with controllable
// latency, and no provider is ever called (provider latency: not applicable). Resource counts come from an instrumentation
// script installed before any page script. Writes docs/study-harness/evidence/performance.{json,md}.
//
// Scope: one desktop machine, Chromium, production bundle. Not WKWebView, not a low-end device, not the whole Study
// Harness application: the 3 s cached launch and 250/500 MB memory targets are host-level and not measured here.
//
// Outcome (benchmark-evidence.mjs): every row is required, the §18 targets and the reported-only spatial measures
// (GPU commit and camera, software WebGL) alike. A workload that throws, a series without samples or a missing row is
// "not measured" and fails the run; so do console/page errors, failed requests and CSP violations (exit 1). Spatial
// rows that cannot run because the GPU run has no hardware WebGL, or the software-WebGL run no WebGL 2 context at all,
// are "not run (environment)" (exit 2), never a pass. The evidence identifies the source commit, dirty flag, package-lock digest, tools, platform
// and the measured macOS console lock state (report §22.3), and every run (failed ones and runs that throw included)
// is also kept append-only in docs/study-harness/evidence/history/performance-<time>.json.
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { PERFORMANCE_SCHEMA, benchmarkOutcome, evaluateTargets, renderMarkdown } from './benchmark-evidence.mjs';
import { consoleLocked, platformIdentity, releaseIdentity, toolVersions, writeHistoryRecord } from './evidence-identity.mjs';
import { BUDGETS_PATH, CONSUMER_OUT, CSP, ROOT, cspRecorder, quantiles, serveDist, watchPage } from './verify-consumer.mjs';

const QUICK = process.argv.includes('--quick');
const GPU_ARGS = ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'];
const N = (full, quick) => QUICK ? quick : full;
const EVIDENCE = path.join(ROOT, 'docs/study-harness/evidence');
const shell = (command, args) => { const result = spawnSync(command, args, { encoding: 'utf8' }); return result.status === 0 ? result.stdout.trim() : null; };

/** Installed with addInitScript before any page script: counts resources the activity runtime could own, by phase. */
function instrument() {
  const phase = { value: 'load' };
  const workers = { created: 0, terminated: 0, messages: 0, peak: 0 };
  const live = new Set();
  const timers = { set: 0, cleared: 0, fired: 0 };
  const pending = new Map();
  const intervals = { set: 0, cleared: 0 };
  const liveIntervals = new Map();
  let raf = 0, shadowRoots = 0, mediaQueryListeners = 0;
  const NativeWorker = window.Worker;
  window.Worker = class CountedWorker extends NativeWorker {
    constructor(url, options) { super(url, options); workers.created++; live.add(this); workers.peak = Math.max(workers.peak, live.size); }
    postMessage(message, transfer) { workers.messages++; super.postMessage(message, transfer); }
    terminate() { if (live.delete(this)) workers.terminated++; super.terminate(); }
  };
  const nativeSet = window.setTimeout.bind(window), nativeClear = window.clearTimeout.bind(window);
  window.setTimeout = (handler, ms, ...args) => {
    const id = nativeSet(() => { pending.delete(id); timers.fired++; if (typeof handler === 'function') handler(...args); }, ms);
    pending.set(id, phase.value);
    timers.set++;
    return id;
  };
  window.clearTimeout = id => { if (id !== undefined && pending.delete(id)) timers.cleared++; nativeClear(id); };
  const nativeInterval = window.setInterval.bind(window), nativeClearInterval = window.clearInterval.bind(window);
  window.setInterval = (handler, ms, ...args) => { const id = nativeInterval(handler, ms, ...args); liveIntervals.set(id, phase.value); intervals.set++; return id; };
  window.clearInterval = id => { if (id !== undefined && liveIntervals.delete(id)) intervals.cleared++; nativeClearInterval(id); };
  const nativeRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = callback => { raf++; return nativeRaf(callback); };
  const nativeAttach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function attachShadow(init) { shadowRoots++; return nativeAttach.call(this, init); };
  const ids = new WeakMap();
  let next = 0;
  const keyOf = (type, listener, options) => {
    if (!listener || (typeof listener !== 'function' && typeof listener !== 'object')) return null;
    if (!ids.has(listener)) ids.set(listener, ++next);
    const capture = typeof options === 'boolean' ? options : !!options?.capture;
    return `${type}#${ids.get(listener)}${capture ? ':capture' : ''}`;
  };
  const registry = { window: new Map(), document: new Map() };
  for (const [name, target] of [['window', window], ['document', document]]) {
    const add = target.addEventListener.bind(target), remove = target.removeEventListener.bind(target);
    target.addEventListener = (type, listener, options) => { const key = keyOf(type, listener, options); if (key && !registry[name].has(key)) registry[name].set(key, phase.value); if (listener) add(type, listener, options); };
    target.removeEventListener = (type, listener, options) => { const key = keyOf(type, listener, options); if (key) registry[name].delete(key); if (listener) remove(type, listener, options); };
  }
  const mqlAdd = MediaQueryList.prototype.addEventListener, mqlRemove = MediaQueryList.prototype.removeEventListener;
  MediaQueryList.prototype.addEventListener = function add(...args) { mediaQueryListeners++; return mqlAdd.apply(this, args); };
  MediaQueryList.prototype.removeEventListener = function remove(...args) { mediaQueryListeners--; return mqlRemove.apply(this, args); };
  const byPhase = values => { const out = {}; for (const value of values) out[value] = (out[value] ?? 0) + 1; return out; };
  window.__instrument = {
    setPhase(value) { phase.value = value; },
    counts: () => ({
      workers: { ...workers, live: live.size }, timers: { ...timers, pending: byPhase(pending.values()) }, intervals: { ...intervals, live: byPhase(liveIntervals.values()) },
      raf, shadowRoots, mediaQueryListeners,
      listeners: { window: [...registry.window].map(([key, at]) => `${at}:${key}`), document: [...registry.document].map(([key, at]) => `${at}:${key}`) },
    }),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------------
const pick = (samples, key) => samples.filter(sample => sample.ok !== false).map(sample => sample[key]);
/** Summary of command samples: total plus each component, all as quantiles. */
function commandStats(samples) {
  const failed = samples.filter(sample => sample.ok === false);
  return {
    total: quantiles(pick(samples, 'totalMs')), command: quantiles(pick(samples, 'commandMs')), workerEvaluation: quantiles(pick(samples, 'workerMs')),
    workerDelivered: quantiles(pick(samples, 'workerDeliveredMs')), render: quantiles(pick(samples, 'renderMs')), paint: quantiles(pick(samples, 'paintMs')),
    storageAck: quantiles(pick(samples, 'storageAckMs')), failed: failed.length, failureCodes: [...new Set(failed.flatMap(sample => sample.codes ?? []))],
  };
}
async function scriptedDrag(page, box, { moves, hz, from = 0.05, to = 0.95 }) {
  const y = box.y + box.height / 2, x = fraction => box.x + 8 + (box.width - 16) * fraction;
  await page.mouse.move(x(from), y);
  await page.mouse.down();
  const interval = 1000 / hz, start = performance.now();
  const sweep = 30; // moves per sweep: each move crosses about one slider step at 1280 px
  for (let index = 1; index <= moves; index++) {
    const phase = (index % (2 * sweep)) / sweep;
    const fraction = phase <= 1 ? from + (to - from) * phase : to - (to - from) * (phase - 1);
    await page.mouse.move(x(fraction), y);
    const wait = start + index * interval - performance.now();
    if (wait > 0) await sleep(wait);
  }
  const sentMs = performance.now() - start;
  await page.mouse.up();
  return { moves, sentMs, sentRateHz: moves / (sentMs / 1000) };
}
function dragSummary(reports, refreshMs) {
  const inputAck = reports.flatMap(report => report.inputAckMs);
  return {
    drags: reports.length, refreshMs, inputEvents: reports.reduce((sum, report) => sum + report.inputEvents, 0),
    inputRateHz: quantiles(reports.map(report => report.inputRateHz)), inputAck: quantiles(inputAck), unacknowledged: reports.reduce((sum, report) => sum + report.unacknowledged, 0),
    frameRateFps: quantiles(reports.map(report => report.frameRateFps)), frameDelta: quantiles(reports.flatMap(report => report.frameDeltasMs)),
    droppedFrames: reports.reduce((sum, report) => sum + report.droppedFrames, 0), framesInWindow: reports.reduce((sum, report) => sum + report.frames, 0),
    longTasks: reports.reduce((sum, report) => sum + report.longTasks, 0), longTaskMs: Math.round(reports.reduce((sum, report) => sum + report.longTaskMs, 0)),
    tentativeFramesPainted: reports.reduce((sum, report) => sum + report.tentativeFramesPainted, 0), previewUpdateRateHz: quantiles(reports.map(report => report.previewUpdateRateHz)),
    previewLatency: quantiles(reports.flatMap(report => report.previewLatencyMs)), workerMessages: reports.reduce((sum, report) => sum + report.workerMessages, 0),
    evaluation: quantiles(reports.flatMap(report => report.evaluationMs)), sent: reports.map(report => report.sent),
  };
}
const VIEWPORT = { width: 1600, height: 1000 };
async function newPage(browser, log) {
  // Wide enough for two active cards side by side (bench.html lays #active out in two columns from 1500 px).
  const context = await browser.newContext({ viewport: VIEWPORT });
  await context.addInitScript(instrument);
  await context.addInitScript(cspRecorder);
  const page = await context.newPage();
  const watched = watchPage(page);
  log.push(watched);
  return { context, page, watched };
}
async function openBench(page, base) {
  await page.goto(`${base}/bench.html`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true', undefined, { timeout: 30_000 });
}
const counts = page => page.evaluate(() => window.__instrument.counts());
const setPhase = (page, phase) => page.evaluate(value => window.__instrument.setPhase(value), phase);
const RUN_STARTED = performance.now();
const timeline = [];
const step = message => { timeline.push({ atS: Math.round((performance.now() - RUN_STARTED) / 100) / 10, step: message }); console.log(`[benchmark] ${message}`); };

// ---------------------------------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------------------------------
async function main2d(page, base) {
  const out = {};
  await openBench(page, base);
  step('2D: open quadratic, function/derivative and linear transformation (free exploration, authorized)');
  const quadratic = (await page.evaluate(() => window.bench.open('quadratic-gradient-descent', { activityId: 'quadratic' }))).activityId;
  const derivative = (await page.evaluate(() => window.bench.open('function-derivative', { activityId: 'derivative' }))).activityId;
  const linear = (await page.evaluate(() => window.bench.open('linear-transformation', { activityId: 'linear' }))).activityId;
  // Equations render lazily once on screen: show each card once so KaTeX and its styles are loaded before measuring.
  for (const id of [quadratic, derivative, linear]) await page.evaluate(async activityId => {
    await window.bench.scrollTo(activityId);
    const root = document.querySelector(`[data-activity-id="${activityId}"] [data-experiment-kit-activity]`)?.shadowRoot;
    root?.querySelector('[data-eka-panel="equations"]')?.scrollIntoView({ block: 'center' });
    await new Promise(resolve => setTimeout(resolve, 400));
  }, id);
  await page.evaluate(() => window.bench.scrollTo('quadratic'));
  const warmup = N(10, 3), samples = N(60, 15);

  step('commit → visible frame: small 2D workloads');
  out.commit = {};
  out.commit['quadratic-linked-trace-and-math'] = commandStats(await page.evaluate(input => window.bench.commitSeries('quadratic', input), { parameter: 'eta', values: [0.5, 0.6], warmup, samples }));
  await page.evaluate(() => window.bench.scrollTo('derivative'));
  out.commit['function-derivative-401-sample-curves'] = commandStats(await page.evaluate(input => window.bench.commitSeries('derivative', input), { parameter: 'A', values: [0.5, 1], warmup, samples }));
  await page.evaluate(() => window.bench.scrollTo('linear'));
  out.commit['linear-transformation-grid'] = commandStats(await page.evaluate(input => window.bench.commitSeries('linear', input), { parameter: 'm11', values: [1, 1.5], warmup, samples }));
  out.commit['quadratic-linked-trace-and-math'].svgElements = await page.evaluate(() => window.bench.svgElements('quadratic'));
  out.commit['linear-transformation-grid'].svgElements = await page.evaluate(() => window.bench.svgElements('linear'));

  step('two simultaneous active 2D activities (side by side, both on screen): alternating commits');
  await page.evaluate(() => window.bench.scrollTo('quadratic'));
  out.twoActiveStates = await page.evaluate(() => ['quadratic', 'derivative'].map(id => ({ id, ui: window.bench.summary(id).ui })));
  const alternating = [];
  for (let index = 0; index < N(30, 8); index++) {
    alternating.push(...await page.evaluate(i => window.bench.commitSeries(i % 2 ? 'derivative' : 'quadratic', { parameter: i % 2 ? 'A' : 'eta', values: [i % 2 ? (i % 4 === 1 ? 0.5 : 1) : (i % 4 === 0 ? 0.5 : 0.6)] }), index));
  }
  out.commit['two-active-alternating'] = commandStats(alternating);

  step('input feedback and preview frame rate: scripted 60 Hz slider drags');
  const refreshMs = await page.evaluate(() => window.bench.refreshInterval());
  const drag = async (activityId, parameter, repeats) => {
    const reports = [];
    for (let index = 0; index < repeats + 1; index++) {
      const box = await page.evaluate(({ id, p }) => window.bench.sliderBox(id, p), { id: activityId, p: parameter });
      await page.evaluate(({ id, p }) => window.bench.startDrag(id, p), { id: activityId, p: parameter });
      const sent = await scriptedDrag(page, box, { moves: N(120, 60), hz: 60 });
      const report = await page.evaluate(ms => window.bench.stopDrag({ refreshMs: ms }), refreshMs);
      if (index > 0) reports.push({ ...report, sent });
    }
    return reports;
  };
  out.preview = { refreshMs };
  out.preview['quadratic-eta'] = dragSummary(await drag('quadratic', 'eta', N(3, 1)), refreshMs);
  out.preview['function-derivative-A'] = dragSummary(await drag('derivative', 'A', N(3, 1)), refreshMs);

  step('rapidly changing inputs: synchronous preview bursts and an unpaced pointer burst');
  await page.evaluate(() => window.bench.scrollTo('quadratic'));
  const burst = async (updates, runs) => {
    const list = [];
    for (let index = 0; index < runs; index++) list.push(await page.evaluate(({ i, n }) => window.bench.rapidPreview('quadratic', { parameter: 'eta', updates: n, from: i % 2 ? 0.9 : 0.3, to: i % 2 ? 0.3 : 0.9 }), { i: index, n: updates }));
    return {
      runs: list.length, updatesPerRun: updates, refusedUpdates: list.reduce((sum, run) => sum + (run.refusedUpdates ?? 0), 0), newestValueShown: list.map(run => run.newestValueShown),
      lastShownIndex: list.map(run => run.lastShownIndex), workerMessagesDuringPreview: list.map(run => run.workerMessagesDuringPreview), tentativeFramesPainted: list.map(run => run.tentativeFramesPainted),
      burst: quantiles(list.map(run => run.burstMs)), lastValueShownAfterBurst: quantiles(list.map(run => run.lastValueShownAfterBurstMs)),
      commit: commandStats(list.map(run => run.commit)), committedLastValue: list.every(run => run.committedValue === run.expectedValue),
    };
  };
  out.rapidInputs = { within64: await burst(60, N(6, 2)), burst200: await burst(200, N(3, 1)) };
  const unpaced = [];
  for (let index = 0; index < N(3, 1) + 1; index++) {
    const box = await page.evaluate(() => window.bench.sliderBox('quadratic', 'eta'));
    await page.evaluate(() => window.bench.startDrag('quadratic', 'eta'));
    const sent = await scriptedDrag(page, box, { moves: 120, hz: 100_000 });
    const report = await page.evaluate(ms => window.bench.stopDrag({ refreshMs: ms }), refreshMs);
    if (index > 0) unpaced.push({ ...report, sent });
  }
  out.rapidInputs.unpacedPointer = dragSummary(unpaced, refreshMs);

  step('slow evaluator: worker replies held 250 ms');
  await page.evaluate(() => window.bench.configure({ workerDelayMs: 250 }));
  out.slowEvaluator = { delayMs: 250 };
  out.slowEvaluator.preview = dragSummary(await drag('quadratic', 'eta', N(2, 1)), refreshMs);
  // A second drag pressed a few milliseconds after the first release, while that release still waits for the slow
  // evaluator; the pointer is then held still for 600 ms so the moment the first commit lands is visible in the control.
  {
    const attempts = [];
    for (let attempt = 0; attempt < N(6, 2); attempt++) {
      const box = await page.evaluate(() => window.bench.sliderBox('quadratic', 'eta'));
      const y = box.y + box.height / 2, x = fraction => box.x + 8 + (box.width - 16) * fraction;
      await page.mouse.move(x(0.1), y);
      await page.mouse.down();
      for (let index = 1; index <= 10; index++) { await page.mouse.move(x(0.1 + index * 0.02), y); await sleep(16); }
      await page.mouse.up();
      await page.mouse.move(x(0.8), y);
      await page.mouse.down();
      for (let index = 1; index <= 10; index++) { await page.mouse.move(x(0.8 + index * 0.01), y); await sleep(16); }
      const atPointer = await page.evaluate(() => window.bench.controlState('quadratic', 'eta'));
      await sleep(600);
      const held = await page.evaluate(() => ({ control: window.bench.controlState('quadratic', 'eta'), committed: window.bench.summary('quadratic').controls.eta }));
      await page.mouse.up();
      await sleep(1000);
      const settled = await page.evaluate(() => window.bench.settle('quadratic'));
      // The release commits the value under the pointer, so the committed value afterwards is the held pointer value.
      const pointerValue = settled.controls.eta;
      attempts.push({ pointerValue, shownAfterMoves: atPointer, shownAfter600ms: held.control, committedWhileHeld: held.committed, controlLeftPointerValue: atPointer.slider !== pointerValue || held.control.slider !== pointerValue });
      await page.evaluate(() => window.bench.commitSeries('quadratic', { parameter: 'eta', values: [0.25] }));
    }
    out.slowEvaluator.dragDuringPendingCommit = { attempts, controlLeftPointerValue: attempts.filter(item => item.controlLeftPointerValue).length };
  }
  out.slowEvaluator.commit = commandStats(await page.evaluate(samples => window.bench.commitSeries('quadratic', { parameter: 'eta', values: [0.5, 0.6], warmup: 1, samples }), N(20, 6)));
  await page.evaluate(() => window.bench.configure({ workerDelayMs: 0 }));

  step('navigation while work is pending (slow evaluator 300 ms)');
  out.navigationWhilePending = await page.evaluate(() => window.bench.navigationWhilePending('quadratic', { delayMs: 300 }));

  step('resize: container width changes');
  out.resize = await page.evaluate(input => window.bench.resizeSeries('quadratic', input), { widths: [960, 640, 390, 1200], repeats: N(8, 2) });
  out.resize.relayout = quantiles(out.resize.samplesMs);

  step('1,001-iterate scene and the capped trace table (navigation between n = 999 and n = 1000)');
  await page.evaluate(() => window.bench.commitSeries('quadratic', { parameter: 'eta', values: [0.9] }));
  await page.evaluate(() => window.bench.navigate('quadratic', 1000));
  const rows = await page.evaluate(() => window.bench.showTables('quadratic'));
  const nav = await page.evaluate(input => window.bench.navigateSeries('quadratic', input), { indices: [999, 1000], warmup: N(6, 2), samples: N(40, 10) });
  out.largest = { workload: 'quadratic trace at n = 999/1000: 1,000–1,001 iterates, step segments and trace points drawn; trace table capped at 200 rows', tableRows: rows, svgElements: await page.evaluate(() => window.bench.svgElements('quadratic')), navigation: commandStats(nav) };

  step('storage acknowledgement: journal append latency 25 ms (visible frame must not wait for it)');
  await page.evaluate(() => window.bench.configure({ hostLatency: { appendEvents: 25 } }));
  out.storage = { appendLatencyMs: 25, commit: commandStats(await page.evaluate(input => window.bench.commitSeries('quadratic', input), { parameter: 'eta', values: [0.5, 0.6], warmup: 2, samples: N(30, 8) })) };
  await page.evaluate(() => window.bench.configure({ hostLatency: { appendEvents: 0 } }));
  step('persist-before-reveal: stage transition with grants, host latency 0 and 30 ms');
  out.reveal = {};
  for (const latencyMs of [0, 30]) {
    const result = await page.evaluate(input => window.bench.revealTiming(input), { latencyMs, repeats: N(12, 3) });
    out.reveal[`hostLatency${latencyMs}ms`] = { receipt: quantiles(result.samples.map(item => item.receiptMs)), displayed: quantiles(result.samples.map(item => item.displayedMs)), displayAckPersisted: quantiles(result.samples.map(item => item.displayAckMs)) };
  }

  step('20+ suspended history cards');
  const historyIds = [];
  for (let index = 0; index < 22; index++) {
    const id = `history-${index}`;
    await page.evaluate(({ activityId, templateId }) => window.bench.open(templateId, { activityId, region: 'history', authorize: false }), { activityId: id, templateId: index % 2 ? 'function-derivative' : 'quadratic-gradient-descent' });
    await page.evaluate(activityId => window.bench.suspend(activityId), id);
    historyIds.push(id);
  }
  await page.evaluate(() => window.bench.scrollTo('quadratic'));
  await sleep(500);
  const before = await counts(page);
  await setPhase(page, 'quiet');
  const quiet = await page.evaluate(ids => window.bench.quietWindow(ids, 2000), historyIds);
  const after = await counts(page);
  await setPhase(page, 'load');
  out.history = {
    cards: historyIds.length, quiet, liveWorkersAfter: after.workers.live, maxWorkers: await page.evaluate(() => window.bench.maxWorkers),
    activeCards: await page.evaluate(() => ['quadratic', 'derivative', 'linear'].map(id => ({ id, ui: window.bench.summary(id).ui }))),
    pageWide: { workerMessages: after.workers.messages - before.workers.messages, animationFrames: after.raf - before.raf, timersSet: after.timers.set - before.timers.set, note: 'whole page during the 2 s window, including the window\'s own timer and the three idle active cards' },
  };
  out.history.commitWithHistory = commandStats(await page.evaluate(input => window.bench.commitSeries('quadratic', input), { parameter: 'eta', values: [0.5, 0.6], warmup: 2, samples: N(30, 8) }));

  step('stalled persistence (separate runtime, outbox limit 24)');
  out.stalledPersistence = await page.evaluate(() => window.bench.stalledPersistence({ outboxLimit: 24, maxCommits: 60 }));
  out.diagnostics = await page.evaluate(() => window.bench.diagnostics().map(item => ({ source: item.source, code: item.code })));
  return out;
}

async function legacy(page, base) {
  await openBench(page, base);
  const out = {};
  for (const workload of ['wave', '1001-sample-curve', '100-mark-scene', '5000-row-dataset']) {
    step(`document path: ${workload}`);
    const result = await page.evaluate(input => window.bench.legacyMeasure(input), { workload, samples: N(40, 10), warmup: N(6, 2) });
    out[workload] = { svgElements: result.svgElements, total: quantiles(result.samples.map(item => item.totalMs)), command: quantiles(result.samples.map(item => item.commandMs)), dom: quantiles(result.samples.map(item => item.domMs)) };
  }
  return out;
}

async function spatial(page, base) {
  await openBench(page, base);
  const out = {};
  for (const [templateId, parameter, values] of [['vector-orientation-3d', 'ux', [1, 2]], ['quadratic-surface-gradient', 'a', [1.5, 2]]]) {
    step(`spatial: ${templateId}`);
    const loadsBefore = (await page.evaluate(() => window.bench.spatialLoads())).length;
    const opened = await page.evaluate(id => window.bench.openSpatial(id), templateId);
    const result = { spatialState: opened.spatialState, loaderCalls: opened.loads - loadsBefore };
    if (opened.spatialState === 'ready') {
      const commits = await page.evaluate(input => window.bench.spatialCommitSeries(input.id, input), { id: opened.activityId, parameter, values, warmup: N(5, 2), samples: N(30, 8) });
      result.commit = { ...commandStats(commits), rendererFrame: quantiles(commits.map(item => item.rendererFrameMs)) };
      const camera = await page.evaluate(input => window.bench.cameraCommandSeries(input.id, input), { id: opened.activityId, samples: N(30, 8), warmup: N(5, 2) });
      result.cameraCommand = { command: quantiles(camera.map(item => item.commandMs)), dom: quantiles(camera.map(item => item.domMs)), rendererFrame: quantiles(camera.map(item => item.rendererFrameMs)), failed: camera.filter(item => !item.ok).length };
      const box = await page.evaluate(id => window.bench.canvasBox(id), opened.activityId);
      await page.evaluate(id => window.bench.startOrbit(id), opened.activityId);
      const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      const start = performance.now();
      for (let index = 1; index <= N(90, 30); index++) {
        await page.mouse.move(cx + Math.sin(index / 10) * box.width * 0.3, cy + Math.cos(index / 14) * box.height * 0.15);
        const wait = start + index * (1000 / 60) - performance.now();
        if (wait > 0) await sleep(wait);
      }
      await page.mouse.up();
      const orbit = await page.evaluate(() => window.bench.stopOrbit());
      result.pointerOrbit = { moves: orbit.moves, durationMs: Math.round(orbit.durationMs), inputAck: quantiles(orbit.inputAckMs), unacknowledged: orbit.unacknowledged, rendererFrames: orbit.rendererFrames, frameRateFps: orbit.frameRateFps };
    }
    await page.evaluate(id => window.bench.close(id), opened.activityId);
    out[templateId] = result;
  }
  out.diagnostics = await page.evaluate(() => window.bench.diagnostics().map(item => ({ source: item.source, code: item.code })));
  return out;
}

async function lifecycle(page, base) {
  await openBench(page, base);
  step(`lifecycle: ${N(100, 20)} mount/interact/suspend/save/dispose/restore/mount/suspend/resume/dispose cycles`);
  // One warm-up cycle first: React DOM registers its per-document listeners (selectionchange and the delegated events)
  // once, on the first root of a document, and never removes them; they belong to the page, not to an activity.
  await setPhase(page, 'warmup');
  await page.evaluate(() => window.bench.lifecycle({ cycles: 1, heapEvery: 1, prefix: 'warmup' }));
  await setPhase(page, 'load');
  await sleep(300);
  const before = await counts(page);
  await setPhase(page, 'cycles');
  const result = await page.evaluate(input => window.bench.lifecycle(input), { cycles: N(100, 20), heapEvery: 10 });
  await setPhase(page, 'after');
  await sleep(500);
  const after = await counts(page);
  const cycleListeners = list => list.filter(entry => entry.startsWith('cycles:'));
  return {
    cycles: result.cycles, duration: quantiles(result.durationsMs), totalMs: Math.round(result.durationsMs.reduce((a, b) => a + b, 0)),
    workers: { created: after.workers.created - before.workers.created, terminated: after.workers.terminated - before.workers.terminated, liveBefore: before.workers.live, liveAfter: after.workers.live, peak: after.workers.peak, viaBenchWrapper: result.workers },
    timersPendingFromCycles: after.timers.pending.cycles ?? 0, intervalsLiveFromCycles: after.intervals.live.cycles ?? 0,
    windowListenersFromCycles: cycleListeners(after.listeners.window), documentListenersFromCycles: cycleListeners(after.listeners.document),
    mediaQueryListenersNet: after.mediaQueryListeners - before.mediaQueryListeners, shadowRootsAttached: after.shadowRoots - before.shadowRoots,
    connectedSurfacesAfter: result.connectedSurfaces, openCardsAfter: result.openCardsInSession, adapterActivitiesStillOpen: result.adapterStillOpen,
    heap: { gcForced: result.gcForced, samples: result.heap, note: 'JS heap of the page (performance.memory.usedJSHeapSize with --enable-precise-memory-info) after a forced gc() every 10 cycles; not process memory, not GPU or worker memory.' },
  };
}

async function pageNavigationWhilePending(page, base) {
  await openBench(page, base);
  await page.evaluate(() => window.bench.open('quadratic-gradient-descent', { activityId: 'nav' }));
  await page.evaluate(() => window.bench.startPendingCommit('nav', 400));
  await sleep(50);
  const started = performance.now();
  await page.goto('about:blank');
  const unloadMs = performance.now() - started;
  await openBench(page, base);
  const reopened = await page.evaluate(() => window.bench.open('quadratic-gradient-descent', { activityId: 'nav-again' }));
  return { unloadMs: Math.round(unloadMs), reopenedStage: reopened.stage, reopenedFrame: reopened.frameKind };
}

// ---------------------------------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------------------------------
async function main() {
  const budgets = JSON.parse(await readFile(BUDGETS_PATH, 'utf8'));
  const dist = path.join(CONSUMER_OUT, 'dist');
  let build;
  try { build = JSON.parse(await readFile(path.join(CONSUMER_OUT, 'build.json'), 'utf8')); } catch { throw new Error('No production consumer build: run node scripts/study-harness/verify-consumer.mjs first.'); }
  let currentPack = null;
  try { currentPack = JSON.parse(await readFile(path.join(ROOT, 'release/study-harness/packages/manifest.json'), 'utf8')); } catch { currentPack = null; }
  const server = await serveDist(dist);
  // Every workload, the schema 2.0 document player included, runs under the production CSP: the document surface adopts
  // its stylesheet as a constructable stylesheet (packages/player/src/embedding/stylesheet.ts), so it needs no
  // style-src 'unsafe-inline'.
  // The machine's GPU through ANGLE/Metal: Playwright's default headless shell would rasterize WebGL with SwiftShader
  // (software). The spatial workloads are also run once on that software path, reported separately.
  const browser = await chromium.launch({ headless: true, args: ['--js-flags=--expose-gc', '--enable-precise-memory-info', ...GPU_ARGS] });
  const logs = [];
  const started = Date.now();
  const loadAtStart = os.loadavg();
  // Measured, never assumed (report §22.3): the lock state cannot hide headless Chromium, but it is recorded.
  const lockedAtStart = consoleLocked();
  const results = {};
  try {
    for (const [name, run] of [['twoD', main2d], ['documentPath', legacy], ['spatial', spatial], ['lifecycle', lifecycle], ['pageNavigationWhilePending', pageNavigationWhilePending]]) {
      const { context, page } = await newPage(browser, logs);
      try { results[name] = await run(page, server.base); }
      catch (error) { results[name] = { error: error.message }; console.error(`[benchmark] ${name} failed: ${error.message}`); }
      finally {
        results[name].cspViolations = await page.evaluate(() => window.__cspViolations ?? []).catch(() => null);
        await context.close();
      }
    }
    const webgl = () => { const gl = document.createElement('canvas').getContext('webgl2'); if (!gl) return null; const info = gl.getExtension('WEBGL_debug_renderer_info'); return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); };
    const probe = await browser.newPage({ viewport: VIEWPORT });
    await probe.goto(`${server.base}/bench.html`);
    const environment = await probe.evaluate(() => ({ userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, deviceMemory: navigator.deviceMemory ?? null, devicePixelRatio: window.devicePixelRatio, viewport: { width: innerWidth, height: innerHeight } }));
    environment.webglRenderer = await probe.evaluate(webgl);
    await probe.close();
    step('spatial on software WebGL (default headless Chromium, SwiftShader)');
    const software = await chromium.launch({ headless: true });
    try {
      const context = await software.newContext({ viewport: VIEWPORT });
      await context.addInitScript(cspRecorder);
      const page = await context.newPage();
      logs.push(watchPage(page));
      try { results.spatialSoftware = await spatial(page, server.base); results.spatialSoftware.webglRenderer = await page.evaluate(webgl); }
      catch (error) { results.spatialSoftware = { error: error.message }; }
      results.spatialSoftware.cspViolations = await page.evaluate(() => window.__cspViolations ?? []).catch(() => null);
      await context.close();
    } finally { await software.close(); }
    results.environment = {
      ...environment, browser: `Chromium ${browser.version()} (Playwright headless shell, ${GPU_ARGS.join(' ')})`, os: `macOS ${shell('sw_vers', ['-productVersion']) ?? os.release()}`, cpu: shell('sysctl', ['-n', 'machdep.cpu.brand_string']) ?? os.cpus()[0]?.model,
      cores: os.cpus().length, memoryBytes: os.totalmem(), node: process.version,
      loadAverage: { start: loadAtStart.map(value => Math.round(value * 100) / 100), end: os.loadavg().map(value => Math.round(value * 100) / 100), note: '1/5/15-minute load averages; other processes (including other development work) shared this machine during the run' },
      consoleSession: { lockedAtStart, lockedAtEnd: consoleLocked(), source: 'ioreg -n Root -d1: CGSSessionScreenIsLocked (null when unreadable or not macOS)', note: 'Headless Chromium renders offscreen, so the lock state does not hide the benchmark pages.' },
    };
  } finally {
    await browser.close();
    await server.close();
  }
  const errors = logs.flatMap(log => log.errors);
  const evidence = {
    schema: PERFORMANCE_SCHEMA, createdAt: new Date().toISOString(), quick: QUICK, durationMs: Date.now() - started,
    // Identity (report §22.3): source commit and dirty flag, package-lock digest, Node and platform of this run, and
    // the tool versions; `build.pack` identifies the pack the measured consumer was built from.
    ...releaseIdentity(ROOT), tools: toolVersions(ROOT), platformDetail: platformIdentity(),
    scope: 'One desktop machine (the reference machine below), Chromium through Playwright, the production consumer bundle served with the production CSP, an in-memory fixture host. Not WKWebView, not a real low-end device, not the Study Harness application. Provider latency: not applicable (no provider calls exist on these paths).',
    hostLevelTargets: budgets.performance.hostLevelNotLibraryGuarantees,
    build: {
      createdAt: build.createdAt, csp: CSP, documentPathCsp: CSP, versions: build.versions, packages: build.pack.packages.map(({ name, version, sha256 }) => ({ name, version, sha256 })),
      pack: { createdAt: build.pack.createdAt ?? null, source: build.pack.source ?? null, lockSha256: build.pack.lockSha256 ?? null }, matchesCurrentPack: currentPack ? currentPack.createdAt === build.pack.createdAt : null,
    },
    method: {
      statistics: budgets.performance.statistics, paint: 'requestAnimationFrame callback followed by a MessageChannel task (after the frame\'s rendering work)',
      commit: 'learner-binding command call → paint of the first frame whose DOM (data-eka-projection) shows the projection with the new committed frame; worker = evaluate postMessage → reply; render = projection publication → DOM commit; paint = DOM commit → paint; storageAck = first journal append started after the command → host acknowledgement',
      inputAck: 'input event timeStamp (real pointer drag sent by Playwright at a 60 Hz pacing) → paint of the frame whose control output shows that value or a later one',
      frameRate: 'requestAnimationFrame cadence between the first and last input of a drag; dropped frames = Σ(round(Δ/refresh) − 1) against the idle refresh interval; preview update rate = distinct tentative frames painted per second',
      instrumentation: 'Worker construction/messages/termination, timers, intervals, animation frames, window/document/MediaQueryList listeners and attachShadow, counted by phase by an init script installed before any page script',
    },
    results, timeline, consoleErrors: errors,
  };
  evidence.targets = evaluateTargets(evidence, budgets);
  const outcome = benchmarkOutcome(evidence);
  evidence.outcome = { status: outcome.status, problems: outcome.problems, environmentGaps: outcome.environmentGaps };
  await mkdir(EVIDENCE, { recursive: true });
  // Append-only first (failed runs included), then the latest index that links to it.
  const history = writeHistoryRecord(EVIDENCE, 'performance', evidence, { root: ROOT });
  evidence.history = path.relative(EVIDENCE, history).split(path.sep).join('/');
  await writeFile(path.join(EVIDENCE, 'performance.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  await writeFile(path.join(EVIDENCE, 'performance.md'), renderMarkdown(evidence));
  for (const item of evidence.targets) console.log(`[benchmark] ${item.met === true ? 'MET' : item.status === 'not-measured' ? 'NOT MEASURED' : item.met === false ? 'NOT MET' : item.status === 'not-run (environment)' ? 'NOT RUN (ENVIRONMENT)' : 'N/A'} ${item.id}: ${item.measured}`);
  for (const problem of outcome.problems) console.error(`[benchmark] ${problem}`);
  console.log(`[benchmark] outcome ${outcome.status}; evidence in docs/study-harness/evidence/performance.{json,md}; history record ${path.relative(ROOT, history)}`);
  process.exitCode = outcome.exitCode;
}


if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await main(); }
  catch (error) {
    // A run that throws before writing its evidence (no consumer build, browser launch, environment probe) is still
    // part of the engineering record (report §22.3).
    try { writeHistoryRecord(EVIDENCE, 'performance', { ok: false, quick: QUICK, error: String(error?.message ?? error).slice(0, 4000), argv: process.argv.slice(2) }, { root: ROOT }); } catch { /* history is best effort here */ }
    throw error;
  }
}
