// Judgement of the packaged-host performance measurements (report §18, A58; R22) taken by the conformance runner's
// `performance` scenario (src/conformance/performance.ts). Side-effect free: scripts/conformance.mjs uses it to record
// the checks, and tests/activity/native-performance.test.ts checks its rules. The targets and their measurement rules
// are docs/study-harness/budgets.json `performance.targets`, the contract the Chromium benchmark is judged by as well.
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** The §18 targets of docs/study-harness/budgets.json under `root`. */
export function loadTargets(root) {
  return JSON.parse(readFileSync(path.join(root, 'docs/study-harness/budgets.json'), 'utf8')).performance.targets;
}
/** Every target row a performance run records (a missing or unmeasured row fails; it is never dropped). */
export const PERFORMANCE_ROWS = Object.freeze([
  'input-feedback:quadratic-eta', 'preview-2d:quadratic-eta', 'commit:quadratic-linked-trace-and-math', 'offscreen:host-suspension', 'offscreen:hidden-window',
  'suspension:resume-without-catch-up', 'lifecycle:cycles',
  'spatial-orbit-input:vector-orientation-3d', 'offscreen:spatial-suspension:vector-orientation-3d',
  'spatial-orbit-input:quadratic-surface-gradient', 'offscreen:spatial-suspension:quadratic-surface-gradient',
]);
export const SPATIAL_TEMPLATES = Object.freeze(['vector-orientation-3d', 'quadratic-surface-gradient']);
/** WebGL renderer strings of software rasterizers: spatial rows measured on one are an environment gap, never a pass. */
export const SOFTWARE_WEBGL = /swiftshader|llvmpipe|softpipe|software rasterizer|microsoft basic render/i;
/** Nearest-rank p50/p95 with min, max and the sample count (the rule of scripts/study-harness/verify-consumer.mjs). */
export function quantiles(samples) {
  const values = (samples ?? []).filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (!values.length) return { count: 0, p50: null, p95: null, max: null, min: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
  const round = (value) => Math.round(value * 100) / 100;
  return { count: sorted.length, min: round(sorted[0]), p50: round(at(0.5)), p95: round(at(0.95)), max: round(sorted.at(-1)) };
}
const sum = (values) => values.reduce((total, value) => total + (value ?? 0), 0);
/** The settle period before a quiet window, as recorded (work a suspension finishes is reported, not judged). */
const settled = (settling) => (settling
  ? `after ${settling.ms / 1000} s to settle (${settling.domMutations} card DOM mutations while settling${settling.lastMutationAtMs === null || settling.lastMutationAtMs === undefined ? '' : `, the last ${settling.lastMutationAtMs} ms after the suspension`}), a `
  : '');

/**
 * Judges the in-app measurements (`report.data.performance`, src/conformance/performance.ts) against the §18 targets.
 * Returns one `{ id, ok, measured, detail, environment }` row per PERFORMANCE_ROWS entry, in that order: `ok` null with
 * `environment` when this machine could not run the row (a spatial row without hardware WebGL), `ok` false when a
 * measurement is missing (never dropped) or misses its target.
 */
export function judgePerformance(perf, targets, { failedSteps = [] } = {}) {
  const rows = [];
  const add = (id, ok, measured, detail = {}, environment = false) => rows.push({ id, ok, measured, detail: { measured, ...detail }, environment });
  const missing = (part) => `not measured: the ${part} part did not produce a result${failedSteps.length ? ` (${failedSteps.filter((line) => line.includes(part)).join('; ') || failedSteps.join('; ')})` : ''}`;
  const twoD = perf?.twoD ?? null, life = perf?.lifecycle ?? null;
  const t = targets;
  // Input feedback (all drags).
  const drags = twoD?.drags ?? [];
  const inputAck = quantiles(drags.flatMap((drag) => drag.inputAckMs));
  const unacknowledged = sum(drags.map((drag) => drag.unacknowledged));
  if (!drags.length || !inputAck.count) add('input-feedback:quadratic-eta', false, twoD ? 'not measured: no acknowledged input samples' : missing('twoD'));
  else add('input-feedback:quadratic-eta', inputAck.p95 <= t.inputFeedbackAck.p95Ms && unacknowledged === 0,
    `p95 ${inputAck.p95} ms, n = ${inputAck.count}, ${unacknowledged} unacknowledged (target p95 ≤ ${t.inputFeedbackAck.p95Ms} ms)`,
    { target: { p95Ms: t.inputFeedbackAck.p95Ms }, inputAck, unacknowledged, drags: drags.length, inputRateHz: quantiles(drags.map((drag) => drag.inputRateHz)), exactlyShown: sum(drags.map((drag) => drag.exactlyShown)) });
  // Ordinary 2D preview: display frame rate during the drags and tentative frames keeping up with the input.
  if (!drags.length) add('preview-2d:quadratic-eta', false, twoD ? 'not measured: no drags' : missing('twoD'));
  else {
    const display = quantiles(drags.map((drag) => drag.frameRateFps)).p50 ?? 0, input = quantiles(drags.map((drag) => drag.inputRateHz)).p50 ?? 0, painted = quantiles(drags.map((drag) => drag.previewUpdateRateHz)).p50 ?? 0;
    const dropped = sum(drags.map((drag) => drag.droppedFrames)), frames = sum(drags.map((drag) => drag.frames));
    const keepsUp = painted >= 0.9 * Math.min(input, display);
    const previewLatency = quantiles(drags.flatMap((drag) => drag.previewLatencyMs));
    const supported = t.preview2d.packagedSupportedFps ?? t.preview2d.targetFps;
    const objectiveMet = display >= t.preview2d.targetFps - 2 && dropped === 0;
    add('preview-2d:quadratic-eta', display >= Math.max(t.preview2d.usableFps, supported) && keepsUp,
      `display ${display} fps (p50 of ${drags.length} drags), ${dropped} dropped of ${frames} frames; slider values at ${input} Hz, tentative frames painted at ${painted} Hz; input → tentative frame painted p95 ${previewLatency.p95} ms (supported packaged target ≥ ${supported} fps; ${t.preview2d.targetFps} fps objective ${objectiveMet ? 'met for display frames' : 'not met'})`,
      { target: { usableFps: t.preview2d.usableFps, targetFps: t.preview2d.targetFps, packagedSupportedFps: supported }, objectiveMet, displayFps: display, inputRateHz: input, tentativeFrameRateHz: painted, keepsUp, droppedFrames: dropped, framesInWindow: frames,
        frameDelta: quantiles(drags.flatMap((drag) => drag.frameDeltasMs)), previewLatency, refreshIntervalMs: perf?.environment?.refreshIntervalMs ?? null, workerEvaluation: quantiles(drags.flatMap((drag) => drag.evaluationMs)) });
  }
  // Commit → visible frame with the native journal acknowledgement measured separately.
  const samples = twoD?.commit ?? [];
  const ok = samples.filter((sample) => sample.ok);
  const total = quantiles(ok.map((sample) => sample.totalMs));
  if (!total.count) add('commit:quadratic-linked-trace-and-math', false, twoD ? `not measured: no committed samples (${samples.length - ok.length} refused: ${[...new Set(samples.flatMap((sample) => sample.codes))].join(', ')})` : missing('twoD'));
  else {
    const parts = { command: quantiles(ok.map((sample) => sample.commandMs)), workerEvaluation: quantiles(ok.map((sample) => sample.workerMs)), render: quantiles(ok.map((sample) => sample.renderMs)), paint: quantiles(ok.map((sample) => sample.paintMs)),
      nativeJournalAck: quantiles(ok.map((sample) => sample.storageAckMs)), commandToDurableAck: quantiles(ok.map((sample) => sample.durableAfterMs)) };
    add('commit:quadratic-linked-trace-and-math', total.p95 <= t.commitToVisibleFrame.p95Ms && ok.length === samples.length,
      `p95 ${total.p95} ms, n = ${total.count} (target p95 ≤ ${t.commitToVisibleFrame.p95Ms} ms); worker p95 ${parts.workerEvaluation.p95} ms, render p95 ${parts.render.p95} ms, paint p95 ${parts.paint.p95} ms; native journal acknowledgement (append_events, SQLite synchronous=FULL) p95 ${parts.nativeJournalAck.p95} ms, durable ${parts.commandToDurableAck.p95} ms after the command; measured after the ${life?.activitiesOpened ?? 0} lifecycle activities, whose records the store retains`,
      { target: { p95Ms: t.commitToVisibleFrame.p95Ms }, total, ...parts, refused: samples.length - ok.length, retainedActivities: life?.activitiesOpened ?? 0 });
  }
  // Suspension: no work in a 2 s window (host suspension and a hidden window), resume without catch-up.
  for (const [key, label] of [['hostSuspension', 'host-suspension'], ['hiddenWindow', 'hidden-window']]) {
    const item = twoD?.[key];
    const id = `offscreen:${label}`;
    if (!item?.quiet) { add(id, false, twoD ? `not measured: no ${label} window` : missing('twoD')); continue; }
    const q = item.quiet;
    add(id, q.workerMessages === 0 && q.evaluations === 0 && q.domMutations === 0 && q.notifications === 0 && item.playingBefore === true && q.ui === 'suspended',
      `playing before; ${settled(item.settling)}${q.windowMs / 1000} s window while ${q.ui}: ${q.workerMessages} worker messages, ${q.evaluations} evaluations, ${q.domMutations} card DOM mutations, ${q.notifications} projection notifications; page-wide ${q.pageAnimationFrames} animation frames requested, ${q.nativeCalls} native calls`,
      { item });
  }
  const resumed = ['hostSuspension', 'hiddenWindow'].map((key) => twoD?.[key]).filter(Boolean);
  if (resumed.length !== 2) add('suspension:resume-without-catch-up', false, twoD ? 'not measured: missing suspension windows' : missing('twoD'));
  else add('suspension:resume-without-catch-up', resumed.every((item) => item.afterResume.playing === false && item.afterResume.index === item.atSuspension.index && item.afterResume.ui !== 'suspended'),
    resumed.map((item) => `${item.kind}: index ${item.atSuspension.index} at suspension, ${item.afterResume.index} 0.7 s after resuming (playing ${item.afterResume.playing}, ${item.afterResume.ui})`).join('; '), { resumed });
  // Lifecycle stress (the benchmark's rule: 100 cycles, activity-owned counts back to zero).
  if (!life?.workers) add('lifecycle:cycles', false, missing('lifecycle'));
  else {
    const clean = life.workers.liveAfter === life.workers.liveBefore && life.timersPendingFromCycles === 0 && life.intervalsLiveFromCycles === 0 && life.windowListenersFromCycles.length === 0
      && life.documentListenersFromCycles.length === 0 && life.mediaQueryListenersNet === 0 && life.connectedSurfacesAfter === 0 && life.adapterActivitiesStillOpen === 0;
    const duration = quantiles(life.durationsMs);
    add('lifecycle:cycles', clean && life.cycles >= t.lifecycle.cycles,
      `${life.cycles} cycles (p50 ${duration.p50} ms, p95 ${duration.p95} ms each): workers ${life.workers.created} created / ${life.workers.terminated} terminated, ${life.workers.liveAfter} live (before ${life.workers.liveBefore}, peak ${life.workers.peak}); ${life.timersPendingFromCycles} timers, ${life.intervalsLiveFromCycles} intervals, ${life.windowListenersFromCycles.length + life.documentListenersFromCycles.length} window/document listeners, MediaQueryList net ${life.mediaQueryListenersNet}; ${life.connectedSurfacesAfter} surfaces, ${life.adapterActivitiesStillOpen} open activities (${life.activitiesOpened} activities opened, warm-up included)`,
      { target: { cycles: t.lifecycle.cycles }, duration, ...life, durationsMs: undefined });
  }
  // Spatial activities: orbit input (the input target), camera command (reported), suspended renderer.
  // No WebGL 2 context in the page's own probe, or a software rasterizer: an environment gap for the spatial rows. A
  // renderer that reached `ready` proves a WebGL 2 context even when the page could not read the renderer's name.
  const renderer = perf?.environment?.webglRenderer ?? null;
  const software = typeof renderer === 'string' && SOFTWARE_WEBGL.test(renderer);
  for (const template of SPATIAL_TEMPLATES) {
    const result = perf?.spatial?.[template] ?? null;
    const orbitId = `spatial-orbit-input:${template}`, quietId = `offscreen:spatial-suspension:${template}`;
    if (!result) { add(orbitId, false, missing(`spatial-${template}`)); add(quietId, false, missing(`spatial-${template}`)); continue; }
    if (result.spatialState !== 'ready') {
      const why = `not measured: renderer state ${result.spatialState} (${renderer ? `WebGL renderer ${renderer}` : 'no WebGL 2 context'})`;
      const gap = renderer === null || software;
      add(orbitId, gap ? null : false, why, {}, gap);
      add(quietId, gap ? null : false, why, {}, gap);
      continue;
    }
    const orbits = result.orbits ?? [];
    const ack = quantiles(orbits.flatMap((orbit) => orbit.inputAckMs));
    const unack = sum(orbits.map((orbit) => orbit.unacknowledged));
    const camera = quantiles((result.camera ?? []).filter((sample) => sample.ok).map((sample) => sample.rendererFrameMs));
    const measured = `pointer orbit input → renderer frame painted p95 ${ack.p95} ms, n = ${ack.count}, ${unack} unacknowledged, ${quantiles(orbits.map((orbit) => orbit.frameRateFps)).p50} fps (target p95 ≤ ${t.inputFeedbackAck.p95Ms} ms); camera command → renderer frame p95 ${camera.p95} ms, n = ${camera.count} (reported, no §18 number); WebGL renderer ${renderer ?? 'unknown'}`;
    if (software) add(orbitId, null, `${measured}; software rasterizer: not evidence for the target`, { inputAck: ack, camera }, true);
    else add(orbitId, ack.count > 0 && ack.p95 <= t.inputFeedbackAck.p95Ms && unack === 0, measured,
      { target: { p95Ms: t.inputFeedbackAck.p95Ms }, inputAck: ack, unacknowledged: unack, orbitFrameRateFps: quantiles(orbits.map((orbit) => orbit.frameRateFps)), rendererFrames: orbits.map((orbit) => orbit.rendererFrames), cameraCommandToRendererFrame: camera, webglRenderer: renderer });
    const q = result.quiet;
    if (!q) add(quietId, false, 'not measured: no suspended window');
    else add(quietId, q.rendererFrames === 0 && q.workerMessages === 0 && q.evaluations === 0 && q.domMutations === 0 && q.notifications === 0 && q.ui === 'suspended',
      `${settled(result.settling)}${q.windowMs / 1000} s window while ${q.ui}: ${q.rendererFrames} renderer frames, ${q.workerMessages} worker messages, ${q.domMutations} card DOM mutations, ${q.notifications} projection notifications; page-wide ${q.pageAnimationFrames} animation frames requested`, { quiet: q });
  }
  return rows;
}
