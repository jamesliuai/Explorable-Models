// The benchmark's outcome and the release pipeline's benchmark gate (report §18 "never silently delete the test",
// §20.1 "an environment failure to resolve or report, not a passing feature check", §22.3 evidence identity and
// failed attempts; A58). The base scenario is a captured real run (fixtures/benchmark/performance-run.json).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  REQUIRED_TARGET_KEYS, SPATIAL_TEMPLATES, TARGET_STATUS, WORKLOADS, benchmarkOutcome, evaluateTargets, renderMarkdown,
} from '../../scripts/study-harness/benchmark-evidence.mjs';
import { STATUS, evaluateBenchmarkEvidence } from '../../scripts/study-harness/release-pipeline.mjs';
import { releaseIdentity } from '../../scripts/study-harness/evidence-identity.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const budgets = JSON.parse(readFileSync(path.join(root, 'docs/study-harness/budgets.json'), 'utf8'));
const captured = JSON.parse(readFileSync(new URL('./fixtures/benchmark/performance-run.json', import.meta.url), 'utf8'));
const PACK = captured.build.packages.map(({ name, sha256 }) => ({ name, sha256 }));
const identity = { source: { commit: 'f'.repeat(40), dirty: true }, packageLock: { file: 'package-lock.json', sha256: 'a'.repeat(64) }, node: 'v22.22.3', platform: { platform: 'darwin', arch: 'arm64' } };

/** A complete evidence object as benchmark.mjs writes it, from (possibly modified) results. */
function evidenceFrom(change = () => {}, extra = {}) {
  const evidence = { schema: 'study-harness.performance-evidence/1', createdAt: '2026-10-27T03:00:00.000Z', ...identity, quick: false, build: structuredClone(captured.build), results: structuredClone(captured.results), consoleErrors: [], ...extra };
  change(evidence.results, evidence);
  evidence.targets = evaluateTargets(evidence, budgets);
  return evidence;
}
const row = (evidence, key) => evidence.targets.find(item => item.key === key);

test('a complete run records every required §18 row and passes', () => {
  const evidence = evidenceFrom();
  assert.deepEqual(evidence.targets.map(item => item.key).filter(key => REQUIRED_TARGET_KEYS.includes(key)).sort(), [...REQUIRED_TARGET_KEYS].sort());
  assert.ok(REQUIRED_TARGET_KEYS.includes('lifecycle:cycles') && REQUIRED_TARGET_KEYS.includes('offscreen:history-cards') && REQUIRED_TARGET_KEYS.includes('stalled-persistence'));
  for (const template of SPATIAL_TEMPLATES) assert.ok(REQUIRED_TARGET_KEYS.includes(`spatial-orbit-input:${template}`), template);
  assert.equal(row(evidence, 'lifecycle:cycles').id, 'lifecycle: 100 cycles leave no activity-owned resources');
  const outcome = benchmarkOutcome(evidence);
  assert.equal(outcome.status, 'pass');
  assert.equal(outcome.exitCode, 0);
  assert.deepEqual(outcome.problems, []);
  assert.match(renderMarkdown(evidence), /No workload failed; every required row is present and measured; no console errors/);
});

test('acknowledged spatial samples do not conceal an unacknowledged orbit input', () => {
  for (const template of SPATIAL_TEMPLATES) {
    for (const unacknowledged of [1, undefined]) {
      const evidence = evidenceFrom(results => { results.spatial[template].pointerOrbit.unacknowledged = unacknowledged; });
      assert.equal(row(evidence, `spatial-orbit-input:${template}`).met, false);
      assert.equal(benchmarkOutcome(evidence).status, 'fail');
      assert.equal(evaluateBenchmarkEvidence({ evidence, pack: PACK }).status, STATUS.fail);
    }
  }
});

test('a failed commit in a series fails despite other successful samples, including larger and reported spatial workloads', () => {
  const series = [
    ['commit:quadratic-linked-trace-and-math', r => r.twoD.commit['quadratic-linked-trace-and-math']],
    ['commit:with-history-cards', r => r.twoD.history.commitWithHistory],
    ['commit:document-path-wave', r => r.documentPath.wave],
    ['larger:quadratic-1001-iterate-navigation', r => r.twoD.largest.navigation],
    ['larger:document-1001-sample-curve', r => r.documentPath['1001-sample-curve']],
    ['spatial-commit:vector-orientation-3d', r => r.spatial['vector-orientation-3d'].commit],
    ['spatial-camera:vector-orientation-3d', r => r.spatial['vector-orientation-3d'].cameraCommand],
    ['spatial-software:vector-orientation-3d', r => r.spatialSoftware['vector-orientation-3d'].commit],
  ];
  for (const [key, get] of series) {
    const evidence = evidenceFrom(results => { get(results).failed = 1; get(results).failureCodes = ['STALE_RUN']; });
    assert.equal(row(evidence, key).met, false, key);
    assert.match(row(evidence, key).measured, /1 failed: STALE_RUN/, key);
    assert.equal(benchmarkOutcome(evidence).status, 'fail', key);
    assert.equal(evaluateBenchmarkEvidence({ evidence, pack: PACK }).status, STATUS.fail, key);
  }
  const contradictory = evidenceFrom(results => { results.twoD.commit['quadratic-linked-trace-and-math'].failureCodes = ['STALE_RUN']; });
  assert.equal(benchmarkOutcome(contradictory).status, 'fail');
  const software = evidenceFrom(results => {
    results.environment.webglRenderer = 'SwiftShader';
    results.spatial['vector-orientation-3d'].commit.failed = 1;
  });
  assert.equal(benchmarkOutcome(software).status, 'fail', 'a software renderer does not excuse a failed scientific commit');
});

test('the pipeline recomputes verdicts from raw results and current budgets instead of trusting saved target statuses', () => {
  const slow = evidenceFrom();
  slow.results.twoD.commit['linear-transformation-grid'].total.p95 = budgets.performance.targets.commitToVisibleFrame.p95Ms + 1;
  assert.equal(row(slow, 'commit:linear-transformation-grid').met, true, 'saved verdict predates the changed raw sample');
  const failed = evaluateBenchmarkEvidence({ evidence: slow, pack: PACK });
  assert.equal(failed.status, STATUS.fail);
  assert.match(failed.reason, /target\(s\) not met.*linear-transformation-grid/);
  assert.ok(failed.details.targets.notMet.some(id => id.includes('linear-transformation-grid')));
  const failedCommit = evidenceFrom();
  failedCommit.results.twoD.commit['linear-transformation-grid'].failed = 1;
  assert.equal(evaluateBenchmarkEvidence({ evidence: failedCommit, pack: PACK }).status, STATUS.fail);
  const lostInput = evidenceFrom();
  lostInput.results.spatial['vector-orientation-3d'].pointerOrbit.unacknowledged = 1;
  assert.equal(evaluateBenchmarkEvidence({ evidence: lostInput, pack: PACK }).status, STATUS.fail);
  const stricter = structuredClone(budgets);
  stricter.performance.targets.commitToVisibleFrame.p95Ms = 1;
  assert.equal(evaluateBenchmarkEvidence({ evidence: evidenceFrom(), pack: PACK, budgets: stricter }).status, STATUS.fail);
  const missing = evidenceFrom();
  missing.targets = missing.targets.filter(item => item.key !== 'lifecycle:cycles');
  assert.match(evaluateBenchmarkEvidence({ evidence: missing, pack: PACK }).reason, /required target rows missing from the written evidence: lifecycle:cycles/);
  const dishonest = evidenceFrom();
  row(dishonest, 'lifecycle:cycles').status = TARGET_STATUS.environment;
  row(dishonest, 'lifecycle:cycles').met = null;
  assert.match(evaluateBenchmarkEvidence({ evidence: dishonest, pack: PACK }).reason, /written target statuses disagree.*lifecycle:cycles/);
});

test('failed commands in nested slow-evaluator, storage and rapid-input series fail correctness with their raw paths', () => {
  const series = [
    ['$.results.twoD.slowEvaluator.commit', r => r.twoD.slowEvaluator.commit],
    ['$.results.twoD.storage.commit', r => r.twoD.storage.commit],
    ['$.results.twoD.rapidInputs.within64.commit', r => r.twoD.rapidInputs.within64.commit],
    ['$.results.twoD.rapidInputs.burst200.commit', r => r.twoD.rapidInputs.burst200.commit],
  ];
  for (const [path, get] of series) {
    const evidence = evidenceFrom(results => { get(results).failed = 1; get(results).failureCodes = ['STALE_RUN']; });
    assert.ok(evidence.targets.every(item => item.met !== false), `${path}: the ordinary target rows alone still pass`);
    const outcome = benchmarkOutcome(evidence);
    assert.equal(outcome.status, 'fail', path);
    assert.deepEqual(outcome.commandFailures, [{ path, failed: 1, failureCodes: ['STALE_RUN'] }]);
    assert.ok(outcome.problems.includes(`failed command series: ${path} (1 failed: STALE_RUN)`));
    const gate = evaluateBenchmarkEvidence({ evidence, pack: PACK });
    assert.equal(gate.status, STATUS.fail, path);
    assert.deepEqual(gate.details.commandFailures, outcome.commandFailures);
    const markdown = renderMarkdown(evidence);
    assert.ok(markdown.includes(`- Command series \`${path}\`: 1 failed: STALE_RUN`));
    assert.doesNotMatch(markdown, /No workload failed/);
  }
  // These are correctness checks, not a new 100 ms target on explicitly slow or reported-only workloads.
  const slow = evidenceFrom(results => { for (const [, get] of series) get(results).total.p95 = 10_000; });
  assert.equal(benchmarkOutcome(slow).status, 'pass');
  assert.equal(evaluateBenchmarkEvidence({ evidence: slow, pack: PACK }).status, STATUS.pass);
});

test('R08: a reported-only spatial measure (GPU commit or camera series) without samples is not measured and fails like a target', () => {
  // The renderer was ready on hardware WebGL, the workload did not throw, but the series came back empty.
  const empty = evidenceFrom(results => {
    for (const template of SPATIAL_TEMPLATES) {
      results.spatial[template].commit.rendererFrame = { count: 0, p50: null, p95: null, max: null, min: null };
      results.spatial[template].cameraCommand.rendererFrame = { count: 0, p50: null, p95: null, max: null, min: null };
    }
  });
  const keys = SPATIAL_TEMPLATES.flatMap(template => [`spatial-commit:${template}`, `spatial-camera:${template}`]);
  for (const key of keys) {
    assert.ok(REQUIRED_TARGET_KEYS.includes(key), key);
    assert.equal(row(empty, key).status, TARGET_STATUS.notMeasured, key);
    assert.equal(row(empty, key).met, false, key);
    assert.match(row(empty, key).measured, /not measured: no renderer frames although the renderer was ready/);
  }
  const outcome = benchmarkOutcome(empty);
  assert.equal(outcome.status, 'fail');
  assert.equal(outcome.exitCode, 1);
  assert.deepEqual(outcome.workloadErrors, []);
  assert.deepEqual(outcome.notMeasured.length, keys.length);
  assert.deepEqual(outcome.notMet, []);
  assert.match(outcome.problems.join(' '), /4 required row\(s\) not measured: spatial commit → renderer frame \(vector-orientation-3d\)/);
  const markdown = renderMarkdown(empty);
  assert.match(markdown, /\*\*Outcome: \*\*FAIL\*\*\.\*\*/);
  assert.match(markdown, /- Required row not measured: spatial camera command → renderer frame \(quadratic-surface-gradient\) — not measured/);
  assert.doesNotMatch(markdown, /No workload failed/);
  assert.doesNotMatch(markdown, /none missed/);
  const gate = evaluateBenchmarkEvidence({ evidence: empty, pack: PACK });
  assert.equal(gate.status, STATUS.fail);
  assert.match(gate.reason, /required row\(s\) not measured/);
  assert.deepEqual(gate.details.targets.notMeasured.length, keys.length);
  // A missing GPU result for one template (no throw) fails its commit and camera rows too, not only the orbit row.
  const missing = evidenceFrom(results => { delete results.spatial['vector-orientation-3d']; });
  for (const key of ['spatial-commit:vector-orientation-3d', 'spatial-camera:vector-orientation-3d', 'spatial-orbit-input:vector-orientation-3d']) assert.equal(row(missing, key).met, false, key);
  assert.equal(benchmarkOutcome(missing).notMeasured.length, 3);
});

test('R08: the software-WebGL rows are required: unmeasured fails, and only a run with no WebGL 2 context at all is an environment gap', () => {
  const softKeys = SPATIAL_TEMPLATES.map(template => `spatial-software:${template}`);
  // SwiftShader gave a WebGL 2 context but the spatial renderer fell back: a failure of the spatial path.
  const fallback = evidenceFrom(results => { for (const template of SPATIAL_TEMPLATES) results.spatialSoftware[template] = { spatialState: 'fallback', loaderCalls: 1 }; });
  for (const key of softKeys) {
    assert.equal(row(fallback, key).status, TARGET_STATUS.notMeasured, key);
    assert.equal(row(fallback, key).met, false, key);
    assert.match(row(fallback, key).measured, /renderer state fallback although the software run has WebGL \(ANGLE \(Google, Vulkan/);
  }
  assert.equal(benchmarkOutcome(fallback).status, 'fail');
  assert.equal(benchmarkOutcome(fallback).exitCode, 1);
  assert.equal(evaluateBenchmarkEvidence({ evidence: fallback, pack: PACK }).status, STATUS.fail);
  // Ready but no frames, or no result for a template, fails as well.
  const noFrames = evidenceFrom(results => { results.spatialSoftware['quadratic-surface-gradient'].commit.rendererFrame = { count: 0, p50: null, p95: null, max: null, min: null }; });
  assert.equal(row(noFrames, 'spatial-software:quadratic-surface-gradient').met, false);
  assert.equal(benchmarkOutcome(noFrames).exitCode, 1);
  const absentTemplate = evidenceFrom(results => { delete results.spatialSoftware['vector-orientation-3d']; });
  assert.match(row(absentTemplate, 'spatial-software:vector-orientation-3d').measured, /not measured: no vector-orientation-3d in the results/);
  assert.equal(benchmarkOutcome(absentTemplate).exitCode, 1);
  // No WebGL 2 context at all in the software run: an environment gap (exit 2, gate not-run (environment)), never a pass.
  const noContext = evidenceFrom(results => {
    results.spatialSoftware.webglRenderer = null;
    for (const template of SPATIAL_TEMPLATES) results.spatialSoftware[template] = { spatialState: 'fallback', loaderCalls: 1 };
  });
  for (const key of softKeys) {
    assert.equal(row(noContext, key).status, TARGET_STATUS.environment, key);
    assert.equal(row(noContext, key).met, null, key);
    assert.match(row(noContext, key).measured, /renderer state fallback; no WebGL 2 context in the software-WebGL run/);
  }
  const outcome = benchmarkOutcome(noContext);
  assert.equal(outcome.status, 'environment');
  assert.equal(outcome.exitCode, 2);
  assert.equal(outcome.environmentGaps.length, softKeys.length);
  assert.doesNotMatch(renderMarkdown(noContext), /\*\*Outcome: pass/);
  assert.match(renderMarkdown(noContext), /every required row is present and measured, except 2 not run \(environment; see the outcome above\)/);
  const gate = evaluateBenchmarkEvidence({ evidence: noContext, pack: PACK });
  assert.equal(gate.status, STATUS.environment);
  assert.match(gate.reason, /not run \(environment\): spatial on software WebGL/);
});

test('R08: the outcome judges a row by its status: an older not-measured row with met: null, or an unknown status, still fails', () => {
  // Evidence written before this rule (reported-only rows that were not measured carried met: null).
  const older = evidenceFrom();
  const commit = older.targets.find(item => item.key === 'spatial-commit:vector-orientation-3d');
  Object.assign(commit, { met: null, status: TARGET_STATUS.notMeasured, measured: 'not measured: no renderer frames' });
  assert.equal(benchmarkOutcome(older).status, 'fail');
  assert.deepEqual(benchmarkOutcome(older).notMeasured, [commit.id]);
  assert.equal(evaluateBenchmarkEvidence({ evidence: older, pack: PACK }).status, STATUS.fail);
  const unknown = evidenceFrom();
  Object.assign(unknown.targets.find(item => item.key === 'stalled-persistence'), { met: null, status: 'skipped' });
  assert.equal(benchmarkOutcome(unknown).status, 'fail');
  assert.match(benchmarkOutcome(unknown).problems.join(' '), /1 target\(s\) not met: stalled persistence/);
});

test('R08: a workload that throws keeps its rows as not measured, fails the run and is listed under Errors', () => {
  const evidence = evidenceFrom(results => {
    results.lifecycle = { error: 'page.evaluate: Timeout 30000ms exceeded', cspViolations: [] };
    results.twoD = { error: 'locator.waitFor: Timeout 15000ms exceeded', cspViolations: [] };
  });
  // Every required row is still there; none silently disappears.
  assert.deepEqual(REQUIRED_TARGET_KEYS.filter(key => !row(evidence, key)), []);
  for (const key of ['lifecycle:cycles', 'input-feedback:quadratic-eta', 'offscreen:history-cards', 'commit:quadratic-linked-trace-and-math', 'stalled-persistence', 'rapid-inputs:newest-value']) {
    assert.equal(row(evidence, key).met, false, key);
    assert.equal(row(evidence, key).status, TARGET_STATUS.notMeasured, key);
  }
  assert.match(row(evidence, 'lifecycle:cycles').measured, /the lifecycle workload failed \(page\.evaluate: Timeout 30000ms exceeded\)/);
  assert.match(row(evidence, 'input-feedback:quadratic-eta').measured, /the twoD workload failed/);
  const outcome = benchmarkOutcome(evidence);
  assert.equal(outcome.status, 'fail');
  assert.equal(outcome.exitCode, 1);
  assert.deepEqual(outcome.workloadErrors.map(item => item.workload), ['twoD', 'lifecycle']);
  const markdown = renderMarkdown(evidence);
  assert.match(markdown, /- Workload `lifecycle` failed: page\.evaluate: Timeout 30000ms exceeded/);
  assert.match(markdown, /- Workload `twoD` failed: locator\.waitFor/);
  assert.doesNotMatch(markdown, /No workload failed/);
  assert.match(markdown, /\*\*Outcome: \*\*FAIL\*\*\.\*\*/);
  // The release gate fails on the same evidence.
  const gate = evaluateBenchmarkEvidence({ evidence, pack: PACK });
  assert.equal(gate.status, STATUS.fail);
  assert.match(gate.reason, /workload failed: twoD .*lifecycle/);
});

test('R08: a workload with no result at all, an empty sample series or a missing required row fails', () => {
  const missingWorkload = evidenceFrom(results => { delete results.pageNavigationWhilePending; });
  assert.equal(benchmarkOutcome(missingWorkload).status, 'fail');
  assert.deepEqual(benchmarkOutcome(missingWorkload).workloadErrors, [{ workload: 'pageNavigationWhilePending', error: 'no result recorded' }]);
  assert.deepEqual([...WORKLOADS].sort(), ['documentPath', 'lifecycle', 'pageNavigationWhilePending', 'spatial', 'spatialSoftware', 'twoD']);
  const empty = evidenceFrom(results => { results.twoD.commit['linear-transformation-grid'].total = { count: 0, p50: null, p95: null, max: null, min: null }; });
  assert.equal(row(empty, 'commit:linear-transformation-grid').met, false);
  assert.equal(benchmarkOutcome(empty).exitCode, 1);
  const dropped = evidenceFrom();
  dropped.targets = dropped.targets.filter(item => item.key !== 'lifecycle:cycles');
  const outcome = benchmarkOutcome(dropped);
  assert.equal(outcome.status, 'fail');
  assert.deepEqual(outcome.missingTargets, ['lifecycle:cycles']);
  assert.match(renderMarkdown(dropped), /Required rows missing from the evidence: lifecycle:cycles/);
  // Evidence written before rows had keys (or by an older script) is missing every required row.
  const legacy = evidenceFrom();
  legacy.targets = legacy.targets.map(({ key, status, ...rest }) => rest);
  assert.equal(benchmarkOutcome(legacy).missingTargets.length, REQUIRED_TARGET_KEYS.length);
});

test('R08: no hardware WebGL for the GPU run is an environment gap (exit 2, gate not-run (environment)), never a pass or an omission', () => {
  const noWebgl = evidenceFrom(results => {
    results.environment.webglRenderer = null;
    for (const template of SPATIAL_TEMPLATES) results.spatial[template] = { spatialState: 'fallback', loaderCalls: 1 };
  });
  for (const template of SPATIAL_TEMPLATES) {
    const orbit = row(noWebgl, `spatial-orbit-input:${template}`);
    assert.equal(orbit.met, null);
    assert.equal(orbit.status, TARGET_STATUS.environment);
    assert.match(orbit.measured, /renderer state fallback; no WebGL 2 context/);
  }
  const outcome = benchmarkOutcome(noWebgl);
  assert.equal(outcome.status, 'environment');
  assert.equal(outcome.exitCode, 2);
  assert.equal(outcome.environmentGaps.length, 3 * SPATIAL_TEMPLATES.length);
  assert.match(renderMarkdown(noWebgl), /\*\*Outcome: not run \(environment\)\.\*\* environment gap: spatial/);
  const gate = evaluateBenchmarkEvidence({ evidence: noWebgl, pack: PACK });
  assert.equal(gate.status, STATUS.environment);
  assert.match(gate.reason, /not run \(environment\)/);
  // A software rasterizer in the GPU run is the same gap, even when it renders.
  const software = evidenceFrom(results => { results.environment.webglRenderer = 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0) (0x0000C0DE)), SwiftShader driver)'; });
  assert.equal(row(software, 'spatial-orbit-input:vector-orientation-3d').status, TARGET_STATUS.environment);
  assert.match(row(software, 'spatial-orbit-input:vector-orientation-3d').measured, /measured on WebGL renderer ANGLE \(Google, Vulkan/);
  assert.equal(benchmarkOutcome(software).status, 'environment');
  // With hardware WebGL available, a renderer that is not ready is a failure of the spatial path.
  const broken = evidenceFrom(results => { results.spatial['quadratic-surface-gradient'] = { spatialState: 'failed', loaderCalls: 1 }; });
  assert.equal(row(broken, 'spatial-orbit-input:quadratic-surface-gradient').met, false);
  assert.match(row(broken, 'spatial-orbit-input:quadratic-surface-gradient').measured, /renderer state failed although the GPU run has hardware WebGL/);
  assert.equal(benchmarkOutcome(broken).status, 'fail');
});

test('the lifecycle row needs the 100 cycles of budgets.json; a --quick run reports fewer as not run and is never release evidence', () => {
  const short = evidenceFrom(results => { results.lifecycle.cycles = 20; });
  assert.equal(row(short, 'lifecycle:cycles').met, false);
  assert.match(row(short, 'lifecycle:cycles').note, /20 of the 100 cycles/);
  const quick = evidenceFrom(results => { results.lifecycle.cycles = 20; }, { quick: true });
  assert.equal(row(quick, 'lifecycle:cycles').met, null);
  assert.equal(row(quick, 'lifecycle:cycles').status, TARGET_STATUS.quick);
  assert.equal(benchmarkOutcome(quick).exitCode, 0);
  const gate = evaluateBenchmarkEvidence({ evidence: quick, pack: PACK });
  assert.equal(gate.status, STATUS.fail);
  assert.match(gate.reason, /--quick .*never release evidence/);
  const leaking = evidenceFrom(results => { results.lifecycle.timersPendingFromCycles = 2; }, { quick: true });
  assert.equal(row(leaking, 'lifecycle:cycles').met, false);
});

test('console errors and CSP violations fail the run and are listed; the Errors section never claims none', () => {
  const csp = evidenceFrom(results => { results.spatial.cspViolations = [{ directive: 'style-src-elem', blocked: 'inline', source: 'bench.html', line: 3 }]; results.lifecycle.cspViolations = null; });
  const outcome = benchmarkOutcome(csp);
  assert.equal(outcome.status, 'fail');
  assert.match(outcome.problems.join(' '), /1 CSP violation\(s\).*could not be read for lifecycle/);
  const markdown = renderMarkdown(csp);
  assert.match(markdown, /- CSP violation in `spatial`: style-src-elem blocked inline \(bench\.html:3\)/);
  assert.match(markdown, /- CSP violations of `lifecycle` could not be read/);
  const consoleError = evidenceFrom(() => {}, { consoleErrors: ['pageerror: boom'] });
  assert.equal(benchmarkOutcome(consoleError).exitCode, 1);
  assert.match(renderMarkdown(consoleError), /- pageerror: boom/);
});

test('the release gate requires this pack and an identified, full run (R35)', () => {
  const evidence = evidenceFrom();
  assert.deepEqual(evaluateBenchmarkEvidence({ evidence, pack: PACK }).status, STATUS.pass);
  const otherPack = evaluateBenchmarkEvidence({ evidence, pack: [{ ...PACK[0], sha256: '0'.repeat(64) }, ...PACK.slice(1)] });
  assert.match(otherPack.reason, /other tarballs/);
  const { source, packageLock, ...anonymous } = evidence;
  const unidentified = evaluateBenchmarkEvidence({ evidence: anonymous, pack: PACK });
  assert.equal(unidentified.status, STATUS.fail);
  assert.match(unidentified.reason, /lacks its source commit and dirty flag, package-lock sha256/);
  // The identity the benchmark writes satisfies the check.
  assert.equal(evaluateBenchmarkEvidence({ evidence: { ...anonymous, ...releaseIdentity(root) }, pack: PACK }).status, STATUS.pass);
});

test('R23/R35: benchmark.mjs measures the console lock state, identifies its evidence and keeps every run in history', () => {
  const source = readFileSync(path.join(root, 'scripts/study-harness/benchmark.mjs'), 'utf8');
  assert.doesNotMatch(source, /locked during this run/);
  assert.match(source, /consoleSession: \{ lockedAtStart, lockedAtEnd: consoleLocked\(\)/);
  assert.match(source, /const lockedAtStart = consoleLocked\(\);/);
  assert.match(source, /\.\.\.releaseIdentity\(ROOT\), tools: toolVersions\(ROOT\)/);
  assert.match(source, /pack: \{ createdAt: build\.pack\.createdAt \?\? null, source: build\.pack\.source \?\? null, lockSha256: build\.pack\.lockSha256 \?\? null \}/);
  // History before the latest index, on every run; a run that throws records its failure too.
  assert.match(source, /const history = writeHistoryRecord\(EVIDENCE, 'performance', evidence, \{ root: ROOT \}\);[\s\S]{0,200}writeFile\(path\.join\(EVIDENCE, 'performance\.json'\)/);
  assert.match(source, /catch \(error\) \{[\s\S]{0,300}writeHistoryRecord\(EVIDENCE, 'performance', \{ ok: false/);
  assert.match(source, /process\.exitCode = outcome\.exitCode;/);
  // verify:packages (2D consumer evidence) carries the same identity and history.
  const packages = readFileSync(path.join(root, 'scripts/verify-packages.mjs'), 'utf8');
  assert.match(packages, /source:identity\.source,packageLock:identity\.packageLock,tools:toolVersions\(root\)/);
  assert.match(packages, /evidence\.history=path\.relative\(out,writeHistoryRecord\(out,'package-evidence',evidence,\{root\}\)\)/);
  assert.match(packages, /catch\(error\) \{[\s\S]{0,200}writeHistoryRecord\(out,'package-evidence',\{ok:false/);
  assert.match(readFileSync(path.join(root, 'scripts/study-harness/release-pipeline.mjs'), 'utf8'), /release\/preview\/package-evidence\.json lacks its/);
});
