/**
 * Packaged-host performance (report §18, A58; R22). The conformance runner's `performance` chain measures, inside the
 * packaged reference host's WKWebView and against the Rust host, the §18 targets that apply to a host; this file checks
 * that every full packaged run must carry it, the rules that judge it (examples/study-harness-tauri/scripts/
 * performance-targets.mjs, against docs/study-harness/budgets.json), and that the recorded evidence and the documents
 * quoting it agree.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM module without declarations
import { DISPLAY_SCENARIOS, REQUIRED_SCENARIOS, SCENARIO_CHAINS } from '../../examples/study-harness-tauri/scripts/scenarios.mjs';
// @ts-expect-error -- plain ESM module without declarations
import { judgePerformance, loadTargets, PERFORMANCE_ROWS, quantiles } from '../../examples/study-harness-tauri/scripts/performance-targets.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (file: string) => readFileSync(join(root, file), 'utf8');
type Row = { id: string; ok: boolean | null; measured: string; detail: Record<string, unknown>; environment: boolean };
const judge = (perf: unknown, targets = loadTargets(root)): Row[] => judgePerformance(perf, targets);
const byId = (rows: Row[]) => Object.fromEntries(rows.map(row => [row.id, row]));

/** In-app measurements as src/conformance/performance.ts reports them, every target met. */
function passing(): Record<string, any> {
  const drag = () => ({
    inputEvents: 100, inputAckMs: Array.from({ length: 100 }, (_, index) => 4 + (index % 10)), unacknowledged: 0, exactlyShown: 100, inputRateHz: 59.5,
    frames: 120, frameRateFps: 60, frameDeltasMs: Array.from({ length: 119 }, () => 16.67), droppedFrames: 0, tentativeFramesPainted: 100, previewUpdateRateHz: 58,
    previewLatencyMs: [20, 22, 25], workerMessages: 120, evaluationMs: [1, 2], committedValue: 1.9,
  });
  const quiet = (spatial = false) => ({ windowMs: 2000, ui: 'suspended', workerMessages: 0, evaluations: 0, domMutations: 0, notifications: 0, nativeCalls: 0, rendererFrames: spatial ? 0 : null, pageAnimationFrames: 0, liveWorkers: 1 });
  const suspension = (kind: string) => ({ kind, playingBefore: true, atSuspension: { ui: 'suspended', playing: false, index: 4 }, quiet: quiet(), afterResume: { ui: 'ready', playing: false, index: 4 }, pausedAfter: null });
  const spatial = (templateId: string) => ({
    templateId, spatialState: 'ready', viewId: 'space',
    orbits: [0, 1, 2].map(() => ({ moves: 60, inputAckMs: Array.from({ length: 60 }, () => 20), unacknowledged: 0, rendererFrames: 60, frameRateFps: 60 })),
    camera: Array.from({ length: 20 }, () => ({ ok: true, codes: [], domMs: 5, rendererFrameMs: 30 })), quiet: quiet(true),
  });
  return {
    errors: [], environment: { refreshIntervalMs: 16.67, webglRenderer: 'Apple GPU', devicePixelRatio: 2 },
    lifecycle: {
      cycles: 100, durationsMs: Array.from({ length: 100 }, () => 400), workers: { created: 200, terminated: 200, liveBefore: 0, liveAfter: 0, peak: 1 },
      timersPendingFromCycles: 0, intervalsLiveFromCycles: 0, windowListenersFromCycles: [], documentListenersFromCycles: [], mediaQueryListenersNet: 0, shadowRootsAttached: 300,
      connectedSurfacesAfter: 0, adapterActivitiesStillOpen: 0, activitiesOpened: 101,
    },
    twoD: {
      commit: Array.from({ length: 30 }, () => ({ ok: true, codes: [], totalMs: 25, commandMs: 5, workerMs: 2, renderMs: 3, paintMs: 10, storageAckMs: 4, durableAfterMs: 8 })),
      drags: Array.from({ length: 6 }, drag), hostSuspension: suspension('host'), hiddenWindow: suspension('hidden-window'),
    },
    spatial: { 'vector-orientation-3d': spatial('vector-orientation-3d'), 'quadratic-surface-gradient': spatial('quadratic-surface-gradient') },
  };
}

describe('packaged-host performance chain (R22)', () => {
  it('reports the packaged scope explicitly and keeps an unmet 60 fps objective visible', () => {
    const perf = passing();
    for (const drag of perf.twoD.drags) { drag.frameRateFps = 58.56; drag.droppedFrames = 5; }
    const row = byId(judge(perf))['preview-2d:quadratic-eta']!;
    expect(row.ok).toBe(true);
    expect(row.detail.target).toEqual({ usableFps: 30, targetFps: 60, packagedSupportedFps: 30 });
    expect(row.detail.objectiveMet).toBe(false);
    expect(row.measured).toContain('supported packaged target ≥ 30 fps; 60 fps objective not met');
    for (const drag of perf.twoD.drags) drag.frameRateFps = 29;
    expect(byId(judge(perf))['preview-2d:quadratic-eta']!.ok).toBe(false);
  });
  it('every full packaged run must carry the performance chain, and --display-only re-runs it', () => {
    expect(SCENARIO_CHAINS).toContain('performance');
    expect(REQUIRED_SCENARIOS).toContain('performance');
    expect(DISPLAY_SCENARIOS).toContain('performance');
    const driver = read('examples/study-harness-tauri/scripts/conformance.mjs');
    expect(driver).toMatch(/only\.includes\('performance'\)\) \{[^\n]*scenarios\.performance = await performanceScenario\(\)/);
    expect(driver).toMatch(/judgePerformance\(perf, loadTargets\(repoRoot\)/);
    const runner = read('examples/study-harness-tauri/src/conformance/runner.ts');
    expect(runner).toMatch(/case 'performance': await performanceRun\(app, report\)/);
  });

  it('judges every row against docs/study-harness/budgets.json and never drops one', () => {
    const targets = loadTargets(root);
    expect(targets.inputFeedbackAck.p95Ms).toBe(100);
    expect(targets.commitToVisibleFrame.p95Ms).toBe(100);
    expect(targets.lifecycle.cycles).toBe(100);
    const rows = judge(passing());
    expect(rows.map(row => row.id)).toEqual([...PERFORMANCE_ROWS]);
    expect(rows.filter(row => row.ok !== true)).toEqual([]);
    for (const row of rows) expect(row.measured.length, row.id).toBeGreaterThan(10);
    // Missing parts stay as failed rows with their reason.
    const empty = judge({ errors: [{ part: 'twoD', error: 'x' }] });
    expect(empty.map(row => row.id)).toEqual([...PERFORMANCE_ROWS]);
    expect(empty.every(row => row.ok === false && /not measured/.test(row.measured))).toBe(true);
    expect(judge(null).every(row => row.ok === false)).toBe(true);
  });

  it('a missed target or leftover work fails its row', () => {
    const cases: [string, (perf: Record<string, any>) => void][] = [
      ['input-feedback:quadratic-eta', perf => { perf.twoD.drags[0].inputAckMs = Array.from({ length: 100 }, () => 150); perf.twoD.drags.splice(1); }],
      ['input-feedback:quadratic-eta', perf => { perf.twoD.drags[2].unacknowledged = 1; }],
      ['preview-2d:quadratic-eta', perf => { for (const drag of perf.twoD.drags) drag.frameRateFps = 24; }],
      ['preview-2d:quadratic-eta', perf => { for (const drag of perf.twoD.drags) drag.previewUpdateRateHz = 20; }],
      ['commit:quadratic-linked-trace-and-math', perf => { for (const sample of perf.twoD.commit) sample.totalMs = 140; }],
      ['commit:quadratic-linked-trace-and-math', perf => { perf.twoD.commit[3] = { ok: false, codes: ['CONFLICT'] }; }],
      ['offscreen:host-suspension', perf => { perf.twoD.hostSuspension.quiet.domMutations = 2; }],
      ['offscreen:host-suspension', perf => { perf.twoD.hostSuspension.playingBefore = false; }],
      ['offscreen:hidden-window', perf => { perf.twoD.hiddenWindow.quiet.workerMessages = 1; }],
      ['suspension:resume-without-catch-up', perf => { perf.twoD.hiddenWindow.afterResume.index = 7; }],
      ['lifecycle:cycles', perf => { perf.lifecycle.cycles = 99; }],
      ['lifecycle:cycles', perf => { perf.lifecycle.timersPendingFromCycles = 1; }],
      ['lifecycle:cycles', perf => { perf.lifecycle.workers.liveAfter = 2; }],
      ['spatial-orbit-input:vector-orientation-3d', perf => { perf.spatial['vector-orientation-3d'].orbits[0].inputAckMs = Array.from({ length: 60 }, () => 180); perf.spatial['vector-orientation-3d'].orbits.splice(1); }],
      ['offscreen:spatial-suspension:quadratic-surface-gradient', perf => { perf.spatial['quadratic-surface-gradient'].quiet.rendererFrames = 3; }],
    ];
    for (const [id, mutate] of cases) {
      const perf = passing();
      mutate(perf);
      const rows = byId(judge(perf));
      expect(rows[id]!.ok, `${id}: ${rows[id]!.measured}`).toBe(false);
      expect(Object.values(rows).filter(row => row.ok !== true).map(row => row.id)).toEqual([id]);
    }
  });

  it('a spatial row without hardware WebGL is an environment gap, never a pass', () => {
    const software = passing();
    software.environment.webglRenderer = 'Google SwiftShader';
    const rows = byId(judge(software));
    expect([rows['spatial-orbit-input:vector-orientation-3d']!.ok, rows['spatial-orbit-input:vector-orientation-3d']!.environment]).toEqual([null, true]);
    const fallback = passing();
    fallback.environment.webglRenderer = null;
    fallback.spatial['quadratic-surface-gradient'] = { templateId: 'quadratic-surface-gradient', spatialState: 'fallback' };
    expect(byId(judge(fallback))['spatial-orbit-input:quadratic-surface-gradient']!.environment).toBe(true);
    // A renderer that reached `ready` proves WebGL 2 even when the page could not read the renderer's name.
    const unnamed = passing();
    unnamed.environment.webglRenderer = null;
    expect(byId(judge(unnamed))['spatial-orbit-input:vector-orientation-3d']!.ok).toBe(true);
    // With hardware WebGL a renderer that is not ready fails.
    const broken = passing();
    broken.spatial['vector-orientation-3d'] = { templateId: 'vector-orientation-3d', spatialState: 'failed' };
    expect(byId(judge(broken))['spatial-orbit-input:vector-orientation-3d']!.ok).toBe(false);
  });

  it('quantiles are nearest-rank, as in the Chromium benchmark', () => {
    expect(quantiles([5, 1, 3, 2, 4])).toEqual({ count: 5, min: 1, p50: 3, p95: 5, max: 5 });
    expect(quantiles([]).count).toBe(0);
  });
});

/** The latest native evidence's run record and performance scenario (written by conformance.mjs). */
const evidence = JSON.parse(read('docs/study-harness/evidence/native-conformance.json'));

describe('recorded packaged-host performance evidence (R22)', () => {
  it('the native evidence carries every §18 host row from the packaged binary, measured in a visible window', () => {
    const scenario = evidence.scenarios.performance;
    expect(scenario, 'native-conformance.json has a performance scenario').toBeDefined();
    const run = evidence.runs.find((item: { id: string }) => item.id === scenario.run);
    expect(run && !run.superseded).toBe(true);
    const checks = new Map<string, { result: string; detail: Record<string, unknown> }>(scenario.checks.map((check: { id: string }) => [check.id, check]));
    for (const id of PERFORMANCE_ROWS) {
      const check = checks.get(`target:${id}`);
      expect(check, id).toBeDefined();
      expect(typeof check!.detail.measured, id).toBe('string');
      // A locked console or hidden window records the rows as not run (environment), never as passed.
      expect(['pass', 'fail', 'not-run-environment'], id).toContain(check!.result);
      if (run.consoleSession?.lockedAtStart === false && check!.result === 'not-run-environment') expect(id).toMatch(/^spatial-/);
    }
    const environment = (checks.get('runner-completed')!.detail as { environment: Record<string, unknown> }).environment;
    expect(environment.refreshIntervalMs).toEqual(expect.any(Number));
    expect(environment.loadAverage).toEqual({ start: expect.any(Array), end: expect.any(Array) });
    expect(environment.consoleLock).toEqual(expect.objectContaining({ atLaunch: expect.anything() }));
  });

  it('performance.md and native.md quote the packaged measurements of the history record they cite', () => {
    const performance = read('docs/study-harness/performance.md').replace(/\s+/g, ' ');
    const native = read('docs/study-harness/native.md').replace(/\s+/g, ' ');
    const links = [...new Set([...performance.matchAll(/\(evidence\/(history\/native-conformance-[0-9TZ:.-]+\.json)\)/g)].map(match => match[1]))];
    expect(links, 'performance.md cites one native-conformance history record').toHaveLength(1);
    const file = join(root, 'docs/study-harness/evidence', links[0]!);
    expect(existsSync(file)).toBe(true);
    const record = JSON.parse(readFileSync(file, 'utf8')).record;
    const scenario = record.scenarios.performance;
    const runRecord = record.runs.find((item: { id: string }) => item.id === scenario.run);
    expect(performance).toContain(`packaged run \`${scenario.run}\``);
    expect(native).toContain(`\`${scenario.run}\``);
    expect(runRecord.consoleSession.lockedAtStart).toBe(false);
    const check = (id: string) => scenario.checks.find((item: { id: string }) => item.id === `target:${id}`);
    for (const id of PERFORMANCE_ROWS) {
      const row = check(id);
      // Each row's result and its measured sentence, as recorded.
      expect(performance, id).toContain(`| ${id} | ${row.result === 'pass' ? 'met' : row.result === 'fail' ? 'not met' : 'not run (environment)'} | ${row.detail.measured} |`);
    }
  });
});
