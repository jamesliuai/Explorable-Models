// Evaluation and rendering of the benchmark's performance evidence (report §18, §20.1, §22.3; A58). Pure: no browser,
// no file system. `benchmark.mjs` uses it to decide its exit code and to write evidence/performance.md, and the release
// pipeline's `benchmark` gate re-checks the written evidence with it.
//
// Every row the benchmark records is REQUIRED (REQUIRED_TARGET_KEYS): the §18 targets and the reported-only measures
// (each spatial activity's commit and camera rows and its software-WebGL row, which have no §18 number and are never
// judged against one). A workload that throws, a series with no samples or a missing result never removes a row: it
// stays in the evidence as "not measured" with met: false, and the run fails, whether the row carries a target or is
// reported only. Rows that cannot run because this machine gives the GPU run no hardware WebGL, or the software-WebGL
// run no WebGL 2 context at all, are "not run (environment)" (met: null): an environment gap to resolve or report,
// never a pass. Workload errors, rows not measured, console/page errors, failed requests and CSP violations are listed
// in the Errors section and fail the run. A failed command in ANY recorded sample series also fails, including the
// deliberately slow evaluator, storage-latency and rapid-input series: successful samples cannot erase it, and the
// correctness check does not impose the small-2D latency target on those workloads.
import { quantiles } from './verify-consumer.mjs';

export const PERFORMANCE_SCHEMA = 'study-harness.performance-evidence/1';
/** Row statuses (`met` stays true | false | null for older readers). */
export const TARGET_STATUS = Object.freeze({
  met: 'met', notMet: 'not-met', notMeasured: 'not-measured', environment: 'not-run (environment)', quick: 'not-run (quick)', reported: 'reported',
});
/** Workloads every run must produce a result for (§18 "Benchmark at least …"). */
export const WORKLOADS = Object.freeze(['twoD', 'documentPath', 'spatial', 'lifecycle', 'pageNavigationWhilePending', 'spatialSoftware']);
export const SPATIAL_TEMPLATES = Object.freeze(['vector-orientation-3d', 'quadratic-surface-gradient']);
/** WebGL renderer strings of software rasterizers: a GPU-run measurement on one of them is not the reference GPU. */
export const SOFTWARE_WEBGL = /swiftshader|llvmpipe|softpipe|software rasterizer|microsoft basic render/i;

const INPUT_FEEDBACK = [
  ['quadratic-eta', 'quadratic η', r => r.twoD?.preview?.['quadratic-eta']],
  ['function-derivative-A', 'function/derivative A (second active card present)', r => r.twoD?.preview?.['function-derivative-A']],
  ['quadratic-eta-slow-evaluator', 'quadratic η, slow evaluator 250 ms', r => r.twoD?.slowEvaluator?.preview],
];
const PREVIEW = [
  ['quadratic-eta', 'quadratic η', r => r.twoD?.preview?.['quadratic-eta']],
  ['function-derivative-A', 'function/derivative A', r => r.twoD?.preview?.['function-derivative-A']],
];
const COMMIT = [
  ['quadratic-linked-trace-and-math', 'quadratic-linked-trace-and-math', r => r.twoD?.commit?.['quadratic-linked-trace-and-math'], 'twoD'],
  ['function-derivative-401-sample-curves', 'function-derivative-401-sample-curves', r => r.twoD?.commit?.['function-derivative-401-sample-curves'], 'twoD'],
  ['linear-transformation-grid', 'linear-transformation-grid', r => r.twoD?.commit?.['linear-transformation-grid'], 'twoD'],
  ['two-active-alternating', 'two active cards, alternating', r => r.twoD?.commit?.['two-active-alternating'], 'twoD'],
  ['with-history-cards', 'with 22 suspended history cards', r => r.twoD?.history?.commitWithHistory, 'twoD'],
  ['document-path-wave', 'document path wave (401 samples)', r => r.documentPath?.wave, 'documentPath'],
];
const LARGER = [
  ['quadratic-1001-iterate-navigation', '1,001-iterate quadratic scene (navigation)', r => r.twoD?.largest?.navigation, 'twoD'],
  ['document-1001-sample-curve', 'document path 1,001-sample curve', r => r.documentPath?.['1001-sample-curve'], 'documentPath'],
  ['document-100-mark-scene', 'document path 100-mark scene', r => r.documentPath?.['100-mark-scene'], 'documentPath'],
  ['document-5000-row-dataset', 'document path 5,000-row dataset', r => r.documentPath?.['5000-row-dataset'], 'documentPath'],
];

/** Stable keys of every row a complete run records; a missing key fails the run and the release gate. */
export const REQUIRED_TARGET_KEYS = Object.freeze([
  ...INPUT_FEEDBACK.map(([key]) => `input-feedback:${key}`),
  ...PREVIEW.map(([key]) => `preview-2d:${key}`),
  ...COMMIT.map(([key]) => `commit:${key}`),
  ...LARGER.map(([key]) => `larger:${key}`),
  ...SPATIAL_TEMPLATES.flatMap(template => [`spatial-software:${template}`, `spatial-commit:${template}`, `spatial-camera:${template}`, `spatial-orbit-input:${template}`]),
  'rapid-inputs:newest-value', 'offscreen:history-cards', 'lifecycle:cycles', 'stalled-persistence',
]);

const p95 = stats => stats?.p95 ?? null;
const counted = stats => !!stats && typeof stats.count === 'number' && stats.count > 0 && typeof stats.p95 === 'number';
/** Successful samples never erase a command that failed in the same series. */
const failedSeries = stats => (stats?.failed ?? 0) !== 0 || (stats?.failureCodes?.length ?? 0) !== 0;
const failures = stats => `${stats?.failed ?? 0} failed${stats?.failureCodes?.length ? `: ${stats.failureCodes.join(', ')}` : ''}`;
/** Why a row has no measurement: its workload's error, or the missing result. */
function absent(results, workload, what) {
  const error = results?.[workload]?.error;
  return error ? `not measured: the ${workload} workload failed (${error})` : `not measured: no ${what} in the results`;
}

/**
 * Each §18 target (and each reported measure) with its measured value, `met` and `status`. Every key in
 * REQUIRED_TARGET_KEYS is present whatever the results hold.
 */
export function evaluateTargets(evidence, budgets) {
  const t = budgets.performance.targets;
  const r = evidence.results ?? {};
  const out = [];
  const add = (key, id, measured, met, status, note) => out.push({ key, id, measured, met, status, ...(note ? { note } : {}) });
  // A required row without a measurement fails the run whether it carries a §18 target or is reported only.
  const notMeasured = (key, id, measured, note) => add(key, id, measured, false, TARGET_STATUS.notMeasured, note);
  const judged = (key, id, measured, ok, note) => add(key, id, measured, ok, ok ? TARGET_STATUS.met : TARGET_STATUS.notMet, note);

  for (const [name, label, get] of INPUT_FEEDBACK) {
    const key = `input-feedback:${name}`, id = `input feedback acknowledgement p95 ≤ ${t.inputFeedbackAck.p95Ms} ms (${label})`;
    const preview = get(r);
    if (!counted(preview?.inputAck)) { notMeasured(key, id, preview ? 'not measured: no acknowledged input samples' : absent(r, 'twoD', 'slider drag')); continue; }
    judged(key, id, `p95 ${p95(preview.inputAck)} ms, n = ${preview.inputAck.count}, ${preview.unacknowledged} unacknowledged`, p95(preview.inputAck) <= t.inputFeedbackAck.p95Ms && preview.unacknowledged === 0);
  }
  for (const [name, label, get] of PREVIEW) {
    const key = `preview-2d:${name}`, id = `ordinary 2D preview: usable ≥ ${t.preview2d.usableFps} fps, target ${t.preview2d.targetFps} fps (${label})`;
    const preview = get(r);
    if (!preview || typeof preview.frameRateFps?.p50 !== 'number') { notMeasured(key, id, preview ? 'not measured: no frame-rate samples' : absent(r, 'twoD', 'slider drag')); continue; }
    // The preview cannot update faster than the slider produces values: it keeps up when the painted tentative frames
    // follow at least 90 % of the input rate (capped by the display rate).
    const display = preview.frameRateFps.p50 ?? 0, input = preview.inputRateHz?.p50 ?? 0, painted = preview.previewUpdateRateHz?.p50 ?? 0;
    const keepsUp = painted >= 0.9 * Math.min(input, display);
    judged(key, id, `display ${display} fps (p50 of drags), ${preview.droppedFrames} dropped of ${preview.framesInWindow} frames; slider produced values at ${input} Hz and tentative frames were painted at ${painted} Hz; input → tentative frame painted p95 ${preview.previewLatency?.p95 ?? null} ms`,
      display >= t.preview2d.usableFps && keepsUp, `${display >= t.preview2d.targetFps - 2 && preview.droppedFrames === 0 ? '60 fps target met for display frames' : '60 fps target not met'}; tentative frames ${keepsUp ? 'kept up with' : 'did not keep up with'} the input`);
  }
  const commitRows = [...COMMIT];
  // Further small-2D commit series the page reports are evaluated too (never dropped).
  for (const name of Object.keys(r.twoD?.commit ?? {})) if (!COMMIT.some(([key]) => key === name)) commitRows.push([name, name, results => results.twoD?.commit?.[name], 'twoD']);
  for (const [name, label, get, workload] of commitRows) {
    const key = `commit:${name}`, id = `commit → visible frame p95 ≤ ${t.commitToVisibleFrame.p95Ms} ms (${label})`;
    const stats = get(r);
    if (!counted(stats?.total)) { notMeasured(key, id, stats ? `not measured: no committed samples (${stats.failed ?? 0} failed${stats.failureCodes?.length ? `: ${stats.failureCodes.join(', ')}` : ''})` : absent(r, workload, 'commit series')); continue; }
    judged(key, id, `p95 ${p95(stats.total)} ms, n = ${stats.total.count}; ${failures(stats)}${stats.workerEvaluation?.count ? `; worker p95 ${p95(stats.workerEvaluation)} ms, render p95 ${p95(stats.render)} ms, paint p95 ${p95(stats.paint)} ms` : ''}`, p95(stats.total) <= t.commitToVisibleFrame.p95Ms && !failedSeries(stats));
  }
  for (const [name, label, get, workload] of LARGER) {
    const key = `larger:${name}`, id = `larger workload, reported against the same ${t.commitToVisibleFrame.p95Ms} ms (${label})`;
    const stats = get(r);
    if (!counted(stats?.total)) { notMeasured(key, id, stats ? 'not measured: no samples' : absent(r, workload, 'larger workload')); continue; }
    judged(key, id, `p95 ${p95(stats.total)} ms, n = ${stats.total.count}; ${failures(stats)}`, p95(stats.total) <= t.commitToVisibleFrame.p95Ms && !failedSeries(stats), 'outside the declared small-2D scope of the target');
  }

  // Spatial: the GPU run carries the input target; its commit and camera rows and the software run are reported only,
  // but every one of them is required: a reported measure without samples fails like a target. A GPU run without
  // hardware WebGL (no WebGL 2 context, or a software rasterizer) is an environment gap for the GPU rows, and a
  // software run without any WebGL 2 context one for the software rows; never a pass and never omitted.
  const gpuRenderer = r.environment ? r.environment.webglRenderer ?? null : undefined;
  const noHardwareWebgl = gpuRenderer === null || (typeof gpuRenderer === 'string' && SOFTWARE_WEBGL.test(gpuRenderer));
  const rendererText = gpuRenderer ? `WebGL renderer ${gpuRenderer}` : 'no WebGL 2 context';
  // benchmark.mjs records the software run's renderer after its spatial workload (null: no WebGL 2 context).
  const softRenderer = r.spatialSoftware && typeof r.spatialSoftware === 'object' && 'webglRenderer' in r.spatialSoftware ? r.spatialSoftware.webglRenderer : undefined;
  const diagnostics = list => (list ?? []).map(item => item.code).filter(Boolean);
  const SOFT_NOTE = 'software rasterization, not the reference GPU; reported only';
  for (const template of SPATIAL_TEMPLATES) {
    const soft = r.spatialSoftware?.[template];
    const softKey = `spatial-software:${template}`, softId = `spatial on software WebGL (SwiftShader): commit → renderer frame (${template})`;
    if (soft?.spatialState === 'ready' && counted(soft.commit?.rendererFrame)) {
      const measured = `p95 ${p95(soft.commit.rendererFrame)} ms; ${failures(soft.commit)}; pointer orbit input → frame ${counted(soft.pointerOrbit?.inputAck) ? `p95 ${p95(soft.pointerOrbit.inputAck)} ms` : 'not measured (no acknowledged orbit input)'}`;
      if (failedSeries(soft.commit)) judged(softKey, softId, measured, false, SOFT_NOTE);
      else add(softKey, softId, measured, null, TARGET_STATUS.reported, SOFT_NOTE);
    }
    else if (soft?.spatialState && soft.spatialState !== 'ready' && softRenderer === null) add(softKey, softId, `renderer state ${soft.spatialState}; no WebGL 2 context in the software-WebGL run`, null, TARGET_STATUS.environment, 'no software WebGL on this machine: not evidence; resolve the environment or report it');
    else if (soft?.spatialState === 'ready') notMeasured(softKey, softId, 'not measured: no renderer frames', SOFT_NOTE);
    else if (soft) notMeasured(softKey, softId, `not measured: renderer state ${soft.spatialState ?? 'unknown'}${typeof softRenderer === 'string' ? ` although the software run has WebGL (${softRenderer})` : ''}${diagnostics(r.spatialSoftware?.diagnostics).length ? `; diagnostics ${diagnostics(r.spatialSoftware.diagnostics).join(', ')}` : ''}`, SOFT_NOTE);
    else notMeasured(softKey, softId, absent(r, 'spatialSoftware', template), SOFT_NOTE);

    const result = r.spatial?.[template];
    const ids = {
      commit: [`spatial-commit:${template}`, `spatial commit → renderer frame (${template})`],
      camera: [`spatial-camera:${template}`, `spatial camera command → renderer frame (${template})`],
      orbit: [`spatial-orbit-input:${template}`, `spatial pointer orbit input → renderer frame p95 ≤ ${t.inputFeedbackAck.p95Ms} ms (${template})`],
    };
    const COMMIT_NOTE = 'no numeric target in §18; reported', CAMERA_NOTE = 'presentation only; reported';
    if (!result?.spatialState) {
      const why = absent(r, 'spatial', template);
      notMeasured(...ids.commit, why, COMMIT_NOTE);
      notMeasured(...ids.camera, why, CAMERA_NOTE);
      notMeasured(...ids.orbit, why);
      continue;
    }
    if (noHardwareWebgl) {
      // Environment gap: recorded with whatever was measured, never judged against the GPU target.
      const state = result.spatialState === 'ready' ? `measured on ${rendererText}, not the reference GPU` : `renderer state ${result.spatialState}; ${rendererText}`;
      const measured = value => result.spatialState === 'ready' && value !== null ? `p95 ${value} ms (${state})` : state;
      if (failedSeries(result.commit)) judged(...ids.commit, `${measured(p95(result.commit?.rendererFrame))}; ${failures(result.commit)}`, false, 'failed commands remain failures on a software renderer');
      else add(...ids.commit, measured(p95(result.commit?.rendererFrame)), null, TARGET_STATUS.environment, 'no hardware WebGL in the GPU run');
      if (failedSeries(result.cameraCommand)) judged(...ids.camera, `${measured(p95(result.cameraCommand?.rendererFrame))}; ${failures(result.cameraCommand)}`, false, 'failed commands remain failures on a software renderer');
      else add(...ids.camera, measured(p95(result.cameraCommand?.rendererFrame)), null, TARGET_STATUS.environment, 'no hardware WebGL in the GPU run');
      add(...ids.orbit, measured(p95(result.pointerOrbit?.inputAck)), null, TARGET_STATUS.environment, 'no hardware WebGL in the GPU run: not evidence for the target; resolve the environment or report it');
      continue;
    }
    if (result.spatialState !== 'ready') {
      // Hardware WebGL is available, so a renderer that is not ready is a failure of the spatial path, not the machine.
      const why = `not measured: renderer state ${result.spatialState} although the GPU run has hardware WebGL (${rendererText})${diagnostics(r.spatial?.diagnostics).length ? `; diagnostics ${diagnostics(r.spatial.diagnostics).join(', ')}` : ''}`;
      notMeasured(...ids.commit, why, COMMIT_NOTE);
      notMeasured(...ids.camera, why, CAMERA_NOTE);
      notMeasured(...ids.orbit, why);
      continue;
    }
    const reportedSeries = ([key, id], series, note) => {
      const stats = series?.rendererFrame;
      if (counted(stats) && failedSeries(series)) judged(key, id, `p95 ${p95(stats)} ms, n = ${stats.count}; ${failures(series)}`, false, note);
      else if (counted(stats)) add(key, id, `p95 ${p95(stats)} ms, n = ${stats.count}`, null, TARGET_STATUS.reported, note);
      else notMeasured(key, id, 'not measured: no renderer frames although the renderer was ready', note);
    };
    reportedSeries(ids.commit, result.commit, COMMIT_NOTE);
    reportedSeries(ids.camera, result.cameraCommand, CAMERA_NOTE);
    if (!counted(result.pointerOrbit?.inputAck)) notMeasured(...ids.orbit, 'not measured: no acknowledged orbit input');
    else judged(...ids.orbit, `p95 ${p95(result.pointerOrbit.inputAck)} ms, n = ${result.pointerOrbit.inputAck.count}, ${result.pointerOrbit.unacknowledged} unacknowledged`, p95(result.pointerOrbit.inputAck) <= t.inputFeedbackAck.p95Ms && result.pointerOrbit.unacknowledged === 0);
  }

  const rapid = r.twoD?.rapidInputs;
  const rapidId = 'rapidly changing inputs: the newest preview value reaches the screen';
  if (rapid?.burst200 && rapid?.within64) judged('rapid-inputs:newest-value', rapidId, `bursts of 60: ${rapid.within64.newestValueShown.every(Boolean) ? 'always' : 'not always'}; bursts of 200: ${rapid.burst200.newestValueShown.every(Boolean) ? 'always' : `no — the tentative frame stopped at update ${rapid.burst200.lastShownIndex.join(', ')} until commit`}; commits applied the newest value: ${rapid.within64.committedLastValue && rapid.burst200.committedLastValue}`,
    rapid.within64.newestValueShown.every(Boolean) && rapid.burst200.newestValueShown.every(Boolean), 'not a §18 numeric target; a correctness check of preview coalescing');
  else notMeasured('rapid-inputs:newest-value', rapidId, absent(r, 'twoD', 'rapid-input bursts'));

  const history = r.twoD?.history;
  const offscreenId = 'offscreen: suspended history cards do no work';
  if (history?.quiet) judged('offscreen:history-cards', offscreenId, `${history.cards} cards, 2 s window: ${history.quiet.workerMessages} worker messages, ${history.quiet.domMutations} DOM mutations, ${history.quiet.notifications} notifications; ${history.liveWorkersAfter} live workers page-wide`,
    history.quiet.workerMessages === 0 && history.quiet.domMutations === 0 && history.quiet.notifications === 0 && history.quiet.evaluations === 0);
  else notMeasured('offscreen:history-cards', offscreenId, absent(r, 'twoD', 'suspended history cards'));

  const required = t.lifecycle.cycles;
  const life = r.lifecycle;
  if (life && !life.error && life.workers) {
    const id = `lifecycle: ${life.cycles} cycles leave no activity-owned resources`;
    const measured = `workers ${life.workers.created} created / ${life.workers.terminated} terminated, ${life.workers.liveAfter} live (before ${life.workers.liveBefore}); ${life.timersPendingFromCycles} timers, ${life.intervalsLiveFromCycles} intervals, ${life.windowListenersFromCycles.length + life.documentListenersFromCycles.length} window/document listeners, MediaQueryList net ${life.mediaQueryListenersNet}; ${life.connectedSurfacesAfter} surfaces, ${life.adapterActivitiesStillOpen} open activities`;
    const clean = life.workers.liveAfter === life.workers.liveBefore && life.timersPendingFromCycles === 0 && life.intervalsLiveFromCycles === 0 && life.windowListenersFromCycles.length === 0 && life.documentListenersFromCycles.length === 0 && life.mediaQueryListenersNet === 0 && life.connectedSurfacesAfter === 0 && life.adapterActivitiesStillOpen === 0;
    // The §18 row is 100 cycles (budgets.json): fewer cycles never meet it. A --quick run reports them as not run.
    if (!clean || life.cycles >= required) judged('lifecycle:cycles', id, measured, clean && life.cycles >= required);
    else if (evidence.quick) add('lifecycle:cycles', id, measured, null, TARGET_STATUS.quick, `quick run: ${life.cycles} of the ${required} cycles the target requires; not evidence for it`);
    else judged('lifecycle:cycles', id, measured, false, `${life.cycles} of the ${required} cycles the target requires`);
  } else notMeasured('lifecycle:cycles', `lifecycle: ${required} cycles leave no activity-owned resources`, absent(r, 'lifecycle', 'lifecycle cycles'));

  const stall = r.twoD?.stalledPersistence;
  const stallId = 'stalled persistence: evidence-bearing work pauses visibly, viewing continues';
  if (stall && !stall.error && stall.stageTransitionWhileStalled) judged('stalled-persistence', stallId, `${stall.acceptedWhileStalled} commits accepted, then ${stall.refusal?.codes.join(', ') ?? 'no refusal'}; stage transition ${stall.stageTransitionWhileStalled.ok ? 'accepted' : stall.stageTransitionWhileStalled.codes.join(', ')}; layout change ${stall.presentationWhileStalled.ok ? 'rendered' : 'refused'}; chip "${stall.chipWhileStalled?.text ?? ''}"; drained in ${Math.round(stall.drainMs)} ms`,
    !!stall.refusal && !stall.stageTransitionWhileStalled.ok && stall.presentationWhileStalled.ok && stall.afterRelease.ok);
  else notMeasured('stalled-persistence', stallId, stall?.error ? `not measured: ${stall.error}` : absent(r, 'twoD', 'stalled-persistence scenario'));
  return out;
}

/** Workloads that threw or produced no result at all. */
export function workloadErrors(results) {
  return WORKLOADS.flatMap(workload => {
    const value = results?.[workload];
    if (!value || typeof value !== 'object') return [{ workload, error: 'no result recorded' }];
    return typeof value.error === 'string' ? [{ workload, error: value.error }] : [];
  });
}

/** Failed sampled commands anywhere in the raw results, including series without a numeric latency target. */
export function commandFailures(results) {
  const failures = [];
  const visit = (value, path) => {
    if (!value || typeof value !== 'object') return;
    // commandStats series have total/command quantiles; camera series have command/rendererFrame quantiles.
    // Deliberately refused actions (for example navigation during a commit) are observations, not sample series.
    const series = ['total', 'command', 'rendererFrame'].some(key => value[key] && typeof value[key] === 'object');
    if (series && failedSeries(value)) failures.push({ path, failed: value.failed ?? 0, failureCodes: [...(value.failureCodes ?? [])] });
    for (const [key, child] of Object.entries(value)) {
      const at = Array.isArray(value) ? `${path}[${key}]` : /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
      visit(child, at);
    }
  };
  visit(results, '$.results');
  return failures;
}

/** CSP violations recorded per workload page, and pages whose violations could not be read. */
export function cspFindings(results) {
  const violations = [], unreadable = [];
  for (const workload of WORKLOADS) {
    const value = results?.[workload]?.cspViolations;
    if (value === null) unreadable.push(workload);
    else if (Array.isArray(value)) for (const item of value) violations.push({ workload, ...item });
  }
  return { violations, unreadable };
}

/** Row statuses that settle a row without `met: true`: reported-only measures, environment gaps, --quick rows. */
const SETTLED_WITHOUT_TARGET = new Set([TARGET_STATUS.reported, TARGET_STATUS.environment, TARGET_STATUS.quick]);
/** A row that was not measured: by its status, whatever its `met` says (older evidence wrote met: null for some). */
const unmeasured = item => item.status === TARGET_STATUS.notMeasured;
/** A measured row that misses its target, or a row whose status is unknown and that is not met. */
const missed = item => !unmeasured(item) && (item.met === false || item.status === TARGET_STATUS.notMet || (item.met !== true && !SETTLED_WITHOUT_TARGET.has(item.status)));

/**
 * The run's outcome from its evidence: `fail` on a workload error, a missing required row, a row not measured (a §18
 * target or a reported-only measure), a target not met, any failed sampled command (including reported-only/slow
 * series), a console/page error or failed request, or a CSP violation;
 * otherwise `environment` when a row could not run on this machine; otherwise `pass`. Exit code 1, 2 and 0
 * respectively.
 */
export function benchmarkOutcome(evidence) {
  const targets = evidence?.targets ?? [];
  const keys = new Set(targets.map(item => item.key).filter(Boolean));
  const missingTargets = REQUIRED_TARGET_KEYS.filter(key => !keys.has(key));
  const errors = workloadErrors(evidence?.results);
  const commands = commandFailures(evidence?.results);
  const notMeasured = targets.filter(unmeasured);
  const notMet = targets.filter(missed);
  const environmentGaps = targets.filter(item => item.status === TARGET_STATUS.environment);
  const consoleErrors = evidence?.consoleErrors ?? [];
  const csp = cspFindings(evidence?.results);
  const problems = [];
  if (errors.length) problems.push(`workload failed: ${errors.map(item => `${item.workload} (${item.error})`).join('; ')}`);
  if (commands.length) problems.push(`failed command series: ${commands.map(item => `${item.path} (${failures(item)})`).join('; ')}`);
  if (missingTargets.length) problems.push(`required target rows missing: ${missingTargets.join(', ')}`);
  if (notMeasured.length) problems.push(`${notMeasured.length} required row(s) not measured: ${notMeasured.map(item => item.id).join('; ')}`);
  if (notMet.length) problems.push(`${notMet.length} target(s) not met: ${notMet.map(item => item.id).join('; ')}`);
  if (consoleErrors.length) problems.push(`${consoleErrors.length} console error(s), page error(s) or failed request(s)`);
  if (csp.violations.length) problems.push(`${csp.violations.length} CSP violation(s)`);
  if (csp.unreadable.length) problems.push(`CSP violations could not be read for ${csp.unreadable.join(', ')}`);
  const status = problems.length ? 'fail' : environmentGaps.length ? 'environment' : 'pass';
  return {
    status, exitCode: status === 'fail' ? 1 : status === 'environment' ? 2 : 0, problems,
    workloadErrors: errors, commandFailures: commands, missingTargets, notMet: notMet.map(item => item.id), notMeasured: notMeasured.map(item => item.id),
    environmentGaps: environmentGaps.map(item => ({ id: item.id, measured: item.measured })),
    met: targets.filter(item => item.met === true).length, consoleErrors: consoleErrors.length, cspViolations: csp.violations.length, cspUnreadable: csp.unreadable, quick: !!evidence?.quick,
  };
}

const MET_TEXT = {
  [TARGET_STATUS.met]: 'yes', [TARGET_STATUS.notMet]: '**no**', [TARGET_STATUS.notMeasured]: '**not measured**', [TARGET_STATUS.environment]: 'not run (environment)',
  [TARGET_STATUS.quick]: 'not run (quick run)', [TARGET_STATUS.reported]: 'n/a (reported)',
};
const metText = item => (item.status ? MET_TEXT[item.status] : null) ?? (item.met === true ? 'yes' : item.met === false ? '**no**' : 'n/a');
const short = value => (typeof value === 'string' ? value.slice(0, 12) : 'unknown');
const lockText = value => (value === true ? 'locked' : value === false ? 'unlocked' : 'unknown');

export function renderMarkdown(evidence) {
  const r = evidence.results, env = r.environment ?? {};
  const outcome = benchmarkOutcome(evidence);
  const q = stats => stats && stats.count ? `${stats.p50} / ${stats.p95} / ${stats.max} (n = ${stats.count})` : 'n/a';
  const pack = evidence.build?.pack ?? {};
  const lines = [
    '# Performance and lifecycle evidence',
    '',
    `Generated by \`node scripts/study-harness/benchmark.mjs${evidence.quick ? ' --quick' : ''}\` on ${evidence.createdAt}. Machine-readable: [performance.json](performance.json)${evidence.history ? `; this run's append-only record: [${evidence.history}](${evidence.history})` : ''}. Method and interpretation: [performance.md](../performance.md). Budgets: [budgets.json](../budgets.json).`,
    '',
    `**Outcome: ${outcome.status === 'pass' ? 'pass' : outcome.status === 'environment' ? 'not run (environment)' : '**FAIL**'}.** ${outcome.status === 'pass' ? `Every required row is present; ${outcome.met} targets met, none missed.` : [...outcome.problems, ...outcome.environmentGaps.map(item => `environment gap: ${item.id} — ${item.measured}`)].join(' ')}${evidence.quick ? ' A --quick run takes fewer samples and cycles; it is never release evidence.' : ''}`,
    '',
    `**Scope.** ${evidence.scope}`,
    '',
    `**Host-level targets.** ${evidence.hostLevelTargets}`,
    '',
    '## Reference machine and build',
    '',
    `- WebGL: ${env.webglRenderer ?? 'unknown'}.`,
    `- ${env.cpu ?? 'unknown CPU'}, ${env.cores ?? '?'} cores, ${env.memoryBytes ? `${Math.round(env.memoryBytes / 2 ** 30)} GiB` : '?'} memory, ${env.os ?? ''}; ${env.browser ?? ''}; hardwareConcurrency ${env.hardwareConcurrency ?? '?'}, devicePixelRatio ${env.devicePixelRatio ?? '?'}, viewport ${env.viewport ? `${env.viewport.width}×${env.viewport.height}` : '?'}.`,
    `- userAgent: \`${env.userAgent ?? ''}\``,
    `- Load average (1/5/15 min) at start ${env.loadAverage?.start?.join(' / ') ?? '?'}, at end ${env.loadAverage?.end?.join(' / ') ?? '?'}: the machine was shared with other development work during the run, so isolated outliers (long frames, maxima) can come from outside the page. Run time ${Math.round(evidence.durationMs / 1000)} s.`,
    `- macOS console session (measured with \`ioreg\`): ${lockText(env.consoleSession?.lockedAtStart)} at start, ${lockText(env.consoleSession?.lockedAtEnd)} at end. ${env.consoleSession?.note ?? ''}`.trimEnd(),
    `- Source: commit \`${short(evidence.source?.commit)}\`${evidence.source?.dirty === true ? ' with uncommitted changes' : evidence.source?.dirty === false ? ' (clean)' : ''}; package-lock sha256 \`${short(evidence.packageLock?.sha256)}\`; Node ${evidence.node ?? '?'}.`,
    `- Production consumer build of ${evidence.build?.createdAt} (Vite ${evidence.build?.versions?.vite ?? '?'}, React ${evidence.build?.versions?.react ?? '?'}) from tarballs ${(evidence.build?.packages ?? []).map(item => `${item.name.replace('@experiment-kit/', '')} \`${item.sha256.slice(0, 12)}\``).join(', ')}, packed ${pack.createdAt ?? '?'} from commit \`${short(pack.source?.commit)}\`${pack.source?.dirty ? ' with uncommitted changes' : ''} and package-lock \`${short(pack.lockSha256)}\`; served with \`${evidence.build?.csp}\`. Build matches the current pack manifest: ${evidence.build?.matchesCurrentPack}.`,
    '',
    '## Targets',
    '',
    '| Target | Measured | Met |',
    '| --- | --- | --- |',
    ...evidence.targets.map(item => `| ${item.id} | ${item.measured}${item.note ? ` — ${item.note}` : ''} | ${metText(item)} |`),
    '',
    'Values below are p50 / p95 / max in milliseconds with the sample count, after discarded warmups.',
    '',
  ];
  if (r.twoD && !r.twoD.error) {
    lines.push('## Commit → visible frame (2D)', '', '| Workload | Total | Worker evaluation | Render | Paint | Storage ack | Failed |', '| --- | --- | --- | --- | --- | --- | --- |');
    const rows = { ...r.twoD.commit, 'with 22 suspended history cards': r.twoD.history?.commitWithHistory, 'journal append latency 25 ms': r.twoD.storage?.commit, 'slow evaluator 250 ms': r.twoD.slowEvaluator?.commit, '1,001-iterate scene, navigation n = 999 ↔ 1000': r.twoD.largest?.navigation };
    for (const [label, stats] of Object.entries(rows)) if (stats) lines.push(`| ${label} | ${q(stats.total)} | ${q(stats.workerEvaluation)} | ${q(stats.render)} | ${q(stats.paint)} | ${q(stats.storageAck)} | ${stats.failed} |`);
    lines.push('', '## Slider drags (real pointer input, 60 Hz pacing)', '', '| Drag | Input ack | Input rate (Hz) | Display fps | Dropped / frames | Tentative frames (Hz) | Input → tentative frame | Worker messages | Long tasks |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const [label, preview] of Object.entries({ 'quadratic η': r.twoD.preview?.['quadratic-eta'], 'function/derivative A': r.twoD.preview?.['function-derivative-A'], 'quadratic η, slow evaluator 250 ms': r.twoD.slowEvaluator?.preview })) {
      if (preview) lines.push(`| ${label} | ${q(preview.inputAck)} | ${preview.inputRateHz.p50} | ${preview.frameRateFps.p50} | ${preview.droppedFrames} / ${preview.framesInWindow} | ${preview.previewUpdateRateHz.p50} | ${q(preview.previewLatency)} | ${preview.workerMessages} | ${preview.longTasks} (${preview.longTaskMs} ms) |`);
    }
    lines.push('', `Idle refresh interval ${r.twoD.preview?.refreshMs?.toFixed?.(2) ?? '?'} ms. Two cards were on screen side by side (${(r.twoD.twoActiveStates ?? []).map(item => `${item.id} ${item.ui}`).join(', ')}).`, '');
    const overlap = r.twoD.slowEvaluator?.dragDuringPendingCommit;
    if (overlap) lines.push(`With the slow evaluator, a second drag was pressed a few milliseconds after the first release, while that release was still being committed, and held still for 600 ms. In ${overlap.controlLeftPointerValue} of ${overlap.attempts.length} attempts the control stopped showing the held pointer value and showed the first drag's committed value instead (for example ${overlap.attempts.filter(item => item.controlLeftPointerValue).slice(0, 1).map(item => `pointer at ${item.pointerValue}, control "${item.shownAfter600ms.output}" after 600 ms`).join('') || 'none'}); the release then committed the pointer value in every attempt.`, '');
    const rapid = r.twoD.rapidInputs;
    if (rapid?.within64) {
      const line = (label, item) => `- ${label}: ${item.runs} runs × ${item.updatesPerRun} synchronous \`updatePreview\` calls in one task; refused ${item.refusedUpdates}; worker messages per preview ${JSON.stringify(item.workerMessagesDuringPreview)}; tentative frames painted ${JSON.stringify(item.tentativeFramesPainted)}; newest value painted ${JSON.stringify(item.newestValueShown)} (last painted value was update ${JSON.stringify(item.lastShownIndex)}); last value painted after the burst ${q(item.lastValueShownAfterBurst)}; commit ${q(item.commit.total)}; committed value equals the newest value: ${item.committedLastValue}.`;
      lines.push('## Rapidly changing inputs', '', line('Bursts within the model session\'s 64 pending operations', rapid.within64), line('Bursts of 200', rapid.burst200),
        `- Unpaced pointer burst (120 moves sent without waiting): input ack ${q(rapid.unpacedPointer.inputAck)}, input ${rapid.unpacedPointer.inputRateHz.p50} Hz, tentative frames ${rapid.unpacedPointer.previewUpdateRateHz.p50} Hz, ${rapid.unpacedPointer.workerMessages} worker messages for ${rapid.unpacedPointer.inputEvents} input events.`, '');
    }
    if (r.twoD.resize) lines.push('## Resize', '', `Width changes 960 → 640 → 390 → 1200 px: re-layout to paint ${q(r.twoD.resize.relayout)}; worker messages ${r.twoD.resize.workerMessages}; scientific state unchanged: ${r.twoD.resize.scientificUnchanged}; no re-layout observed ${r.twoD.resize.unchanged} time(s).`, '');
    const nav = r.twoD.navigationWhilePending;
    if (nav) lines.push('## Navigation while work is pending', '', `Slow evaluator ${nav.delayMs} ms. Step during an in-flight commit: ${nav.stepDuringCommit.ok ? 'accepted' : nav.stepDuringCommit.codes.join(', ')}; the commit: ${nav.commit.ok ? 'applied' : nav.commit.codes.join(', ')}. Navigate during an in-flight preview: ${nav.navigateDuringPreview.ok ? 'accepted' : nav.navigateDuringPreview.codes.join(', ')}; preview active afterwards: ${nav.previewActiveAfterNavigate}. Final DOM shows the current committed projection: ${nav.domShowsCurrentProjection}. ${r.pageNavigationWhilePending && !r.pageNavigationWhilePending.error ? `Page navigation away with a held commit and a held journal append: page unloaded in ${r.pageNavigationWhilePending.unloadMs} ms, and a fresh page opened an activity (${r.pageNavigationWhilePending.reopenedFrame} frame); console and page errors of every page are listed under Errors.` : 'Page navigation away with held work: not measured (see Errors).'}`, '');
    if (r.twoD.storage || r.twoD.reveal) {
      lines.push('## Storage acknowledgement and persist-before-reveal', '', `With a 25 ms journal append latency the visible frame p95 is ${r.twoD.storage?.commit.total.p95} ms while the host acknowledgement p95 is ${r.twoD.storage?.commit.storageAck.p95} ms: the frame never waits for storage.`, '', '| Host latency | Receipt | Revealed content painted | Display acknowledgement persisted |', '| --- | --- | --- | --- |');
      for (const [label, item] of Object.entries(r.twoD.reveal ?? {})) lines.push(`| ${label.replace('hostLatency', '').replace('ms', ' ms')} | ${q(item.receipt)} | ${q(item.displayed)} | ${q(item.displayAckPersisted)} |`);
      lines.push('');
    }
    const history = r.twoD.history;
    if (history) lines.push('## Suspended history cards', '', `${history.cards} cards opened and suspended by the host. During a 2 s window: ${history.quiet.workerMessages} worker messages, ${history.quiet.evaluations} evaluations, ${history.quiet.domMutations} DOM mutations and ${history.quiet.notifications} projection notifications in the history cards (states ${history.quiet.uiStates.join(', ')}); page-wide ${history.pageWide.workerMessages} worker messages, ${history.pageWide.animationFrames} animation frames, ${history.pageWide.timersSet} timers (including the window's own). Live workers page-wide afterwards: ${history.liveWorkersAfter} (pool of at most ${history.maxWorkers}); active cards ${history.activeCards.map(item => `${item.id} ${item.ui}`).join(', ')}.`, '');
    const stall = r.twoD.stalledPersistence;
    if (stall && !stall.error) lines.push('## Stalled persistence', '', `Outbox limit ${stall.outboxLimit}. With journal appends held, ${stall.acceptedWhileStalled} commits rendered (total ${q(quantiles(stall.commitsWhileStalledMs ?? []))}) before ${stall.refusal ? `commit ${stall.refusal.commit + 1} was refused with ${stall.refusal.codes.join(', ')}` : 'no refusal'}; persistence states ${stall.persistenceWhileStalled.join(', ')}; the card's chip read "${stall.chipWhileStalled?.text ?? ''}". A stage transition was ${stall.stageTransitionWhileStalled.ok ? 'accepted' : `refused (${stall.stageTransitionWhileStalled.codes.join(', ')})`} after ${Math.round(stall.stageTransitionWhileStalled.resolvedAfterMs)} ms; a layout change ${stall.presentationWhileStalled.ok ? `rendered in ${Math.round(stall.presentationWhileStalled.totalMs)} ms` : 'was refused'}; "Read current values" text stayed available (${stall.describeCurrentValuesChars} characters). After ${Math.round(stall.stalledMs)} ms the host resumed; the outbox drained in ${Math.round(stall.drainMs)} ms and the next commit was ${stall.afterRelease.ok ? 'accepted' : 'refused'}.`, '');
  }
  if (r.documentPath && !r.documentPath.error) {
    lines.push('## Schema 2.0 document path (@experiment-kit/player)', '', '| Workload | SVG elements | Total | Command | DOM |', '| --- | --- | --- | --- | --- |');
    for (const [label, item] of Object.entries(r.documentPath)) if (item?.total) lines.push(`| ${label} | ${item.svgElements} | ${q(item.total)} | ${q(item.command)} | ${q(item.dom)} |`);
    lines.push('');
  }
  for (const [key, title] of [['spatial', `Spatial activities (lazy player-3d, WebGL on ${env.webglRenderer ?? 'the GPU'})`], ['spatialSoftware', `Spatial activities on software WebGL (${r.spatialSoftware?.webglRenderer ?? 'SwiftShader'}) — not the reference GPU`]]) {
    if (!r[key] || r[key].error) continue;
    lines.push(`## ${title}`, '', '| Activity | Renderer | Commit → DOM frame | Commit → renderer frame | Camera command → renderer frame | Pointer orbit input → renderer frame | Orbit fps |', '| --- | --- | --- | --- | --- | --- | --- |');
    for (const [label, item] of Object.entries(r[key])) if (item?.spatialState) lines.push(`| ${label} | ${item.spatialState} | ${q(item.commit?.total)} | ${q(item.commit?.rendererFrame)} | ${q(item.cameraCommand?.rendererFrame)} | ${q(item.pointerOrbit?.inputAck)} | ${item.pointerOrbit?.frameRateFps?.toFixed?.(1) ?? 'n/a'} |`);
    lines.push('');
  }
  const life = r.lifecycle;
  if (life && !life.error) lines.push('## Lifecycle stress', '', `${life.cycles} cycles (mount → commit → navigate → suspend → save → dispose → restore → mount → suspend/resume → dispose, alternating quadratic and function/derivative) in ${life.totalMs} ms (per cycle ${q(life.duration)}).`, '',
    `- Activity-owned: workers ${life.workers.created} created and ${life.workers.terminated} terminated, ${life.workers.liveAfter} live afterwards (${life.workers.liveBefore} before), peak ${life.workers.peak}; ${life.timersPendingFromCycles} pending timers and ${life.intervalsLiveFromCycles} live intervals created by the cycles; ${life.windowListenersFromCycles.length} window and ${life.documentListenersFromCycles.length} document listeners left; MediaQueryList listeners net ${life.mediaQueryListenersNet}; ${life.shadowRootsAttached} shadow roots attached, ${life.connectedSurfacesAfter} surfaces connected afterwards; ${life.adapterActivitiesStillOpen} activities open in the visualizer.`,
    `- Bounded pool, identified separately: the shared worker budget (at most ${r.twoD?.history?.maxWorkers ?? 6} live workers, dispose on release), adopted stylesheets per shadow root, the lazily loaded KaTeX and renderer modules (one promise per loader), bundled font registrations, and the fixture host's records (durable host state by design).`,
    `- Page JS heap after a forced gc every 10 cycles (diagnostic only; not process, worker or GPU memory): ${life.heap.samples.map(item => `${item.cycle}: ${(item.usedJSHeapSize / 2 ** 20).toFixed(2)} MiB`).join(', ')}. Over the same samples the fixture host's own records (journal events and backup artifacts, which a host keeps by design) grew to ${((life.heap.samples.at(-1)?.hostRecordChars ?? 0) / 2 ** 20).toFixed(2)} MiB of JSON text.`, '');
  lines.push(...renderErrors(evidence));
  return lines.join('\n');
}

/**
 * The Errors section: workload failures, missing rows, rows not measured (targets and reported-only measures alike),
 * failed sampled commands, console/page errors and failed requests, CSP violations.
 */
export function renderErrors(evidence) {
  const errors = workloadErrors(evidence.results);
  const commands = commandFailures(evidence.results);
  const missing = REQUIRED_TARGET_KEYS.filter(key => !(evidence.targets ?? []).some(item => item.key === key));
  const notMeasured = (evidence.targets ?? []).filter(unmeasured);
  const consoleErrors = evidence.consoleErrors ?? [];
  const csp = cspFindings(evidence.results);
  const lines = ['## Errors', ''];
  if (!errors.length && !commands.length && !missing.length && !notMeasured.length && !consoleErrors.length && !csp.violations.length && !csp.unreadable.length) {
    const gaps = (evidence.targets ?? []).filter(item => item.status === TARGET_STATUS.environment).length;
    lines.push(`No workload failed; every required row is present and measured${gaps ? `, except ${gaps} not run (environment; see the outcome above)` : ''}; no console errors, page errors or failed requests; no CSP violations in any benchmark page.`, '');
    return lines;
  }
  for (const item of errors) lines.push(`- Workload \`${item.workload}\` failed: ${item.error}`);
  for (const item of commands) lines.push(`- Command series \`${item.path}\`: ${failures(item)}`);
  if (missing.length) lines.push(`- Required rows missing from the evidence: ${missing.join(', ')}`);
  for (const item of notMeasured) lines.push(`- Required row not measured: ${item.id} — ${item.measured}`);
  for (const item of consoleErrors) lines.push(`- ${item}`);
  for (const item of csp.violations) lines.push(`- CSP violation in \`${item.workload}\`: ${item.directive ?? '?'} blocked ${item.blocked ?? '?'}${item.source ? ` (${item.source}${item.line ? `:${item.line}` : ''})` : ''}`);
  for (const workload of csp.unreadable) lines.push(`- CSP violations of \`${workload}\` could not be read (its page did not answer)`);
  lines.push('');
  return lines;
}
