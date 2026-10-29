// The release pipeline's selection, command instrumentation, report parsing and recording logic (report §20.1, §22.3;
// A59; G62, G78), tested against reporter outputs captured from real runs (tests/release/fixtures/release-pipeline:
// vitest JSON of tests/activity/versions.test.ts, the Playwright JSON structure of study-lifecycle.spec.ts with recorded
// outcomes, node --test TAP of tests/release, cargo test of the contract crate; local paths replaced by /repo).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CROSS_BROWSER_ENGINES, CROSS_BROWSER_SPECS, GATES, NATIVE_APPS, STATUS, STEP_IDS, combineCounts, compareTarballs, crossBrowserEvidence, crossBrowserRecord, evaluateNativeEvidence, gateOutcome, instrument,
  missingRequirement, overallStatus, parseArgs, parseCargo, parsePlaywrightReport, parseTap, parseTsc, parseVitestReport, runnerOf, selectSteps, splitScript, summarize,
} from '../../scripts/study-harness/release-pipeline.mjs';
import { compactNativeEvidence, lockIdentity, missingReleaseIdentity, releaseIdentity, sourceIdentity, writeHistoryRecord } from '../../scripts/study-harness/evidence-identity.mjs';
import { REQUIRED_SCENARIOS } from '../../examples/study-harness-tauri/scripts/scenarios.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = name => readFileSync(new URL(`./fixtures/release-pipeline/${name}`, import.meta.url), 'utf8');
const scripts = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;

test('the gate list covers every §20.1 command and the named Study Harness gates, each defined in package.json', () => {
  const ids = GATES.map(gate => gate.id);
  for (const required of ['typecheck', 'test', 'test:browser', 'test:cross-browser', 'build', 'verify:gallery', 'verify:packages', 'test:release',
    'test:contracts', 'test:reference', 'test:disclosure', 'test:migrations', 'test:lifecycle', 'verify:consumer', 'benchmark', 'review-packets', 'release', 'native']) {
    assert.ok(ids.includes(required), `missing gate ${required}`);
  }
  assert.deepEqual(STEP_IDS, ['pack', ...ids]);
  for (const gate of GATES.filter(item => item.script)) {
    assert.equal(typeof scripts[gate.script], 'string', `npm script ${gate.script}`);
    const segments = splitScript(scripts[gate.script]);
    assert.ok(segments, `${gate.script} runs without a shell`);
  }
  // Every documented script the docs name exists.
  for (const name of ['verify:consumer', 'benchmark', 'pack:study-harness', 'test:native', 'release:study-harness']) assert.equal(typeof scripts[name], 'string', name);
  // Each named gate runs real tests (not an empty command).
  for (const name of ['test:reference', 'test:disclosure', 'test:migrations', 'test:lifecycle', 'test:contracts']) {
    const runners = splitScript(scripts[name]).map(runnerOf);
    assert.ok(runners.some(runner => ['vitest', 'playwright', 'cargo'].includes(runner)), `${name} runs a test runner`);
    for (const tokens of splitScript(scripts[name]).filter(item => runnerOf(item) === 'vitest')) assert.ok(tokens.length > 2, `${name}: vitest with explicit files`);
  }
});

test('segments get a machine-readable reporter without changing the documented command', () => {
  assert.equal(splitScript('a && b | c'), null);
  assert.equal(splitScript("node -e 'x'"), null);
  const [vitest] = splitScript('vitest run tests/a.test.ts');
  assert.deepEqual(instrument(vitest, { reportFile: '/r.json', playwrightOutput: '/o' }).argv, ['vitest', 'run', 'tests/a.test.ts', '--reporter=default', '--reporter=json', '--outputFile.json=/r.json']);
  const [cross] = splitScript(scripts['test:cross-browser']);
  const playwright = instrument(cross, { reportFile: '/p.json', playwrightOutput: '/o' });
  assert.equal(playwright.runner, 'playwright');
  assert.equal(playwright.env.EXPERIMENT_KIT_CROSS_BROWSER, '1');
  assert.equal(playwright.env.PLAYWRIGHT_JSON_OUTPUT_FILE, '/p.json');
  assert.ok(playwright.argv.includes('--reporter=list,json') && playwright.argv.includes('--output=/o'));
  const [nodeTest] = splitScript(scripts['test:release']);
  const tap = instrument(nodeTest, { reportFile: '/t.tap', playwrightOutput: '/o' });
  assert.deepEqual(tap.argv.slice(0, 6), ['node', '--test', '--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=tap', '--test-reporter-destination=/t.tap']);
  assert.equal(tap.argv.at(-1), 'tests/release/*.test.mjs');
  const contracts = splitScript(scripts['test:contracts']).map(runnerOf);
  assert.deepEqual(contracts, ['other', 'vitest', 'cargo']);
  assert.equal(runnerOf(splitScript(scripts.typecheck)[0]), 'tsc');
});

test('exact counts are parsed from vitest, Playwright, node --test, cargo and tsc output', () => {
  const vitest = parseVitestReport(JSON.parse(fixture('vitest-report.json')));
  assert.deepEqual({ ...vitest, failedFiles: vitest.failedFiles.length }, { total: 40, passed: 40, failed: 0, skipped: 0, todo: 0, files: 1, failedFiles: 0, success: true });
  const failing = JSON.parse(fixture('vitest-report.json'));
  Object.assign(failing, { numPassedTests: 39, numFailedTests: 1, success: false });
  failing.testResults[0].status = 'failed';
  assert.deepEqual(parseVitestReport(failing).failedFiles.length, 1);
  assert.equal(parseVitestReport({}), null);

  const playwright = parsePlaywrightReport(JSON.parse(fixture('playwright-report.json')));
  assert.deepEqual({ total: playwright.total, passed: playwright.passed, failed: playwright.failed, flaky: playwright.flaky, skipped: playwright.skipped }, { total: 4, passed: 1, failed: 1, flaky: 1, skipped: 1 });
  assert.deepEqual(playwright.projects, ['chromium']);
  assert.deepEqual(playwright.specFiles, ['study-lifecycle.spec.ts']);
  assert.equal(playwright.failedTests.length, 1);
  assert.match(playwright.failedTests[0], /^\[chromium\] study-lifecycle\.spec\.ts › study activity lifecycle \(A41–A43\) › /);

  assert.deepEqual(parseTap(fixture('node-test-tap.txt')), { total: 5, passed: 5, failed: 0, cancelled: 0, skipped: 0, todo: 0 });
  assert.equal(parseTap('TAP version 13\nok 1 - x\n'), null);

  assert.deepEqual(parseCargo(fixture('cargo-test.txt')), { total: 6, passed: 6, failed: 0, skipped: 0, binaries: 4 });
  assert.equal(parseCargo('no tests'), null);
  assert.deepEqual(parseTsc('a.ts(1,2): error TS2322: x\nb.ts(3,4): error TS7006: y\n'), { errors: 2 });
  assert.deepEqual(combineCounts([{ total: 2, passed: 2, failed: 0, skipped: 0 }, null, { total: 3, passed: 2, failed: 1, skipped: 0, flaky: 1 }]), { total: 5, passed: 4, failed: 1, skipped: 0, flaky: 1 });
});

test('test:cross-browser runs every Study Harness spec, composition and embedding in Firefox and WebKit (G73)', () => {
  const [tokens] = splitScript(scripts['test:cross-browser']);
  assert.equal(runnerOf(tokens), 'playwright');
  assert.ok(tokens.includes('EXPERIMENT_KIT_CROSS_BROWSER=1'));
  const listed = tokens.filter(token => token.endsWith('.spec.ts'));
  assert.deepEqual([...listed].sort(), [...CROSS_BROWSER_SPECS].sort());
  // Every study spec in tests/browser is listed: a new one cannot silently stay Chromium-only.
  const studySpecs = readdirSync(path.join(root, 'tests/browser')).filter(name => /^study-.*\.spec\.ts$/.test(name));
  for (const spec of studySpecs) assert.ok(listed.includes(spec), `${spec} is not in test:cross-browser`);
  // The variable selects exactly the Firefox and WebKit projects.
  const config = readFileSync(path.join(root, 'playwright.config.ts'), 'utf8');
  assert.match(config, /EXPERIMENT_KIT_CROSS_BROWSER \? \[\s*\{ name: 'firefox', use: \{ \.\.\.devices\['Desktop Firefox'\] \} \},\s*\{ name: 'webkit', use: \{ \.\.\.devices\['Desktop Safari'\] \} \},\s*\]/);
  assert.deepEqual([...CROSS_BROWSER_ENGINES], ['firefox', 'webkit']);
});

test('the cross-browser record gives per-engine, per-spec counts with versions and the reason for every skip (G73, A53)', () => {
  // Captured from `EXPERIMENT_KIT_CROSS_BROWSER=1 playwright test study-projection.spec.ts study-interaction.spec.ts -g …`.
  const report = JSON.parse(fixture('playwright-cross-browser-report.json'));
  const counts = parsePlaywrightReport(report);
  assert.deepEqual({ total: counts.total, passed: counts.passed, failed: counts.failed, skipped: counts.skipped }, { total: 6, passed: 4, failed: 0, skipped: 2 });
  assert.deepEqual(counts.projects, ['firefox', 'webkit']);
  for (const engine of ['firefox', 'webkit']) {
    const project = counts.byProject[engine];
    assert.deepEqual({ total: project.total, passed: project.passed, failed: project.failed, flaky: project.flaky, skipped: project.skipped }, { total: 3, passed: 2, failed: 0, flaky: 0, skipped: 1 });
    assert.deepEqual(project.specs['study-projection.spec.ts'], { total: 1, passed: 1, failed: 0, flaky: 0, skipped: 0 });
    assert.deepEqual(project.specs['study-interaction.spec.ts'], { total: 2, passed: 1, failed: 0, flaky: 0, skipped: 1 });
    assert.equal(project.skippedTests.length, 1);
    assert.match(project.skippedTests[0].test, /^study-interaction\.spec\.ts › interaction edge cases .* › G33 touch: a vertical swipe/);
    assert.match(project.skippedTests[0].reason, /Chrome DevTools Protocol/);
  }
  const browsers = { firefox: { version: '157.0', executablePath: '/home/u/.cache/ms-playwright/firefox-1555/firefox/firefox' }, webkit: { version: '27.2', executablePath: '/Users/u/Library/Caches/ms-playwright/webkit-2370/pw_run.sh' } };
  const record = crossBrowserRecord(counts, browsers);
  assert.deepEqual({ version: record.engines.firefox.version, build: record.engines.firefox.build }, { version: '157.0', build: 'firefox-1555' });
  assert.deepEqual({ version: record.engines.webkit.version, build: record.engines.webkit.build }, { version: '27.2', build: 'webkit-2370' });
  // Only two of the required specs ran in this capture: the others are named per engine, so the gate fails.
  assert.equal(record.missing.length, 2 * (CROSS_BROWSER_SPECS.length - 2));
  assert.ok(record.missing.includes('webkit: study-quadratic.spec.ts') && !record.missing.some(item => item.endsWith('study-projection.spec.ts')));
  assert.deepEqual(record.unexplainedSkips, []);
  // A skip without a recorded reason is reported.
  const silent = structuredClone(report);
  const strip = suite => { for (const spec of suite.specs ?? []) for (const item of spec.tests ?? []) item.annotations = []; for (const child of suite.suites ?? []) strip(child); };
  for (const suite of silent.suites) strip(suite);
  assert.equal(crossBrowserRecord(parsePlaywrightReport(silent), browsers).unexplainedSkips.length, 2);
  // The scope never claims Safari, the packaged WebView or a mobile device.
  assert.deepEqual({ actualSafari: record.scope.actualSafari, packagedWebView: record.scope.packagedWebView, realMobileDevice: record.scope.realMobileDevice }, { actualSafari: false, packagedWebView: false, realMobileDevice: false });
  // The older single-project report still parses, with its Chromium counts per spec.
  const chromium = parsePlaywrightReport(JSON.parse(fixture('playwright-report.json')));
  assert.equal(chromium.byProject.chromium.specs['study-lifecycle.spec.ts'].total, 4);
  // release/preview/cross-browser-evidence.json carries the record, keeps the packaged WebView apart and claims no Safari.
  const evidence = crossBrowserEvidence({ version: '0.3.0-preview.1', createdAt: '2026-10-26T18:00:00.000Z', record, result: { command: 'npm run test:cross-browser', status: 'passed' }, packages: [] });
  assert.equal(evidence.engines.webkit.specs['study-interaction.spec.ts'].skipped, 1);
  assert.equal(evidence.engines.webkit.version, '27.2');
  assert.deepEqual({ actualSafari: evidence.actualSafari, packagedWebView: evidence.packagedWebView, realMobileDevice: evidence.realMobileDevice }, { actualSafari: false, packagedWebView: false, realMobileDevice: false });
  assert.match(evidence.separateEvidence.packagedWebView, /native-conformance\.json/);
  const verifyPreview = readFileSync(path.join(root, 'scripts/verify-preview.mjs'), 'utf8');
  assert.match(verifyPreview, /crossBrowserEvidence\(\{/);
  assert.match(verifyPreview, /PLAYWRIGHT_JSON_OUTPUT_FILE:crossBrowserReport/);
  assert.match(verifyPreview, /gate\.details\?\.engines/);
});

test('a gate passes only with a zero exit, a machine-readable report, no failures and at least one test', () => {
  const ok = { command: 'vitest run x', runner: 'vitest', exitCode: 0, counts: { total: 3, passed: 3, failed: 0, skipped: 0 } };
  assert.deepEqual(gateOutcome([ok]), { status: STATUS.pass });
  assert.equal(gateOutcome([{ ...ok, exitCode: 1 }]).status, STATUS.fail);
  // A suite that fails to load counts no failed test but fails the run, and is named.
  assert.match(gateOutcome([{ ...ok, exitCode: 1, counts: { ...ok.counts, failedFiles: ['tests/core/interaction.test.ts'] } }]).reason, /exited with 1 \(failed files: tests\/core\/interaction\.test\.ts\)/);
  assert.match(gateOutcome([{ ...ok, counts: null }]).reason, /no machine-readable vitest report/);
  assert.match(gateOutcome([{ ...ok, counts: { total: 0, passed: 0, failed: 0, skipped: 0 } }]).reason, /no tests ran/);
  assert.match(gateOutcome([{ ...ok, counts: { total: 3, passed: 2, failed: 1, skipped: 0 } }]).reason, /1 failed/);
  assert.match(gateOutcome([{ ...ok, timedOut: true }]).reason, /timed out/);
  assert.match(gateOutcome([{ command: 'tsc --noEmit', runner: 'tsc', exitCode: 0, counts: { errors: 2 } }]).reason, /2 type errors/);
  assert.deepEqual(gateOutcome([{ command: 'node scripts/x.mjs', runner: 'other', exitCode: 0 }]), { status: STATUS.pass });
});

test('selection: --only/--skip runs are partial and never release evidence; the pack is included for tarball gates', () => {
  assert.deepEqual(parseArgs([]), { only: null, skip: null, native: 'verify', allowEnvironmentGaps: false });
  assert.throws(() => parseArgs(['--only=nope']), /Unknown gate/);
  assert.throws(() => parseArgs(['--only=test', '--skip=build']), /either/);
  assert.throws(() => parseArgs(['--native=maybe']), /verify or run/);
  assert.throws(() => parseArgs(['--sign']), /Unknown argument/);
  const smoke = selectSteps(parseArgs(['--only=typecheck,test:contracts']));
  assert.equal(smoke.partial, true);
  assert.deepEqual([...smoke.selected].sort(), ['test:contracts', 'typecheck']);
  assert.ok(selectSteps(parseArgs(['--only=verify:consumer'])).selected.has('pack'));
  assert.equal(selectSteps(parseArgs([])).partial, false);
  assert.equal(selectSteps(parseArgs(['--skip=benchmark'])).partial, true);
  const gate = status => ({ status });
  assert.equal(overallStatus([gate(STATUS.pass), gate(STATUS.excluded)], true), 'partial');
  assert.equal(overallStatus([gate(STATUS.fail), gate(STATUS.excluded)], true), 'fail');
  assert.equal(overallStatus([gate(STATUS.pass), gate(STATUS.environment)], false), 'incomplete');
  assert.equal(overallStatus([gate(STATUS.pass), gate(STATUS.blocked)], false), 'incomplete');
  assert.equal(overallStatus([gate(STATUS.pass), gate(STATUS.pass)], false), 'pass');
  assert.deepEqual(summarize([gate(STATUS.pass), gate(STATUS.fail), gate(STATUS.environment), gate(STATUS.blocked), gate(STATUS.excluded)]),
    { gates: 5, pass: 1, fail: 1, notRunEnvironment: 1, notRunBlocked: 1, notRunExcluded: 1 });
});

test('environment gaps are machine-checked reasons, never passes', () => {
  const environment = { platform: { platform: 'linux' }, tools: { cargo: null }, browsers: { chromium: { installed: true, version: '140.0' }, firefox: { installed: false, reason: 'Playwright firefox is not installed (/x missing; run npx playwright install firefox)' } } };
  assert.match(missingRequirement('macos', environment), /macOS only \(this platform: linux\)/);
  assert.match(missingRequirement('cargo', environment), /cargo is not installed/);
  assert.equal(missingRequirement('chromium', environment), null);
  assert.match(missingRequirement('firefox', environment), /firefox is not installed/);
});

const PACK = [{ name: '@experiment-kit/core', sha256: 'a'.repeat(64) }, { name: '@experiment-kit/activity', sha256: 'b'.repeat(64) }];
const check = (id, result, locked) => ({ id, result, ...(locked === undefined ? {} : { displayDependent: true, displayContext: { windowVisibleAtStart: 'hidden', visibilityChanges: [], consoleLock: { atLaunch: locked, atExit: locked, changes: [] } } }) });
const SHA = { release: '1'.repeat(64), conformance: '2'.repeat(64) };
/** The reference host sources both apps were built from, still in the tree (build-record.mjs hostSourceDigest). */
const SOURCES = { digest: `sha256:${'5'.repeat(64)}`, files: 1, entries: [{ path: 'examples/study-harness-tauri/src-tauri/src/host.rs', sha256: '6'.repeat(64) }] };
/**
 * Complete packaged-host evidence of one full run (every required scenario, build records of both apps, both
 * executables, the sources unchanged until the run ended); `checks` go into `offline`, every other required scenario
 * holds one passing check.
 */
const nativeEvidence = checks => ({
  generatedAt: '2026-10-26T10:00:00.000Z', packed: { packages: PACK }, summary: {}, runs: [{ id: 'full-1', mode: 'full' }],
  builds: Object.fromEntries(NATIVE_APPS.map(kind => [kind, { kind, executableSha256: SHA[kind], packed: { packages: PACK }, sources: SOURCES }])),
  sources: { atEnd: { digest: SOURCES.digest, files: SOURCES.files }, changedSinceBuild: [] },
  binaries: Object.fromEntries(NATIVE_APPS.map(kind => [kind, { executable: `${kind}/app`, sha256: SHA[kind] }])),
  scenarios: Object.fromEntries(REQUIRED_SCENARIOS.map(key => [key, { run: 'full-1', checks: key === 'offline' ? checks : [check(`${key}-ran`, 'pass')] }])),
});
const ON_DISK = Object.fromEntries(NATIVE_APPS.map(kind => [kind, { executable: `${kind}/app`, recorded: SHA[kind], present: true, matches: true }]));
const OTHERS = REQUIRED_SCENARIOS.length - 1;

test('packaged-host evidence counts for this pack only, and display checks not run while locked stay not run', () => {
  assert.deepEqual(compareTarballs(PACK, [{ name: '@experiment-kit/core', sha256: 'c'.repeat(64) }]).mismatches, [{ name: '@experiment-kit/core', recorded: 'c'.repeat(64), pack: 'a'.repeat(64) }]);
  const installed = { packages: PACK };
  const binaries = ON_DISK;
  const passing = evaluateNativeEvidence({ evidence: nativeEvidence([check('a', 'pass'), check('b', 'pass', false)]), packedArtifacts: installed, pack: PACK, sources: SOURCES, binaries });
  assert.equal(passing.status, STATUS.pass);
  assert.deepEqual(passing.counts, { total: 2 + OTHERS, passed: 2 + OTHERS, failed: 0, notRunEnvironment: 0, notRun: 0 });
  const locked = evaluateNativeEvidence({ evidence: nativeEvidence([check('a', 'pass'), check('b', 'not-run-environment', true)]), packedArtifacts: installed, pack: PACK, sources: SOURCES, binaries });
  assert.equal(locked.status, STATUS.environment);
  assert.match(locked.reason, /1 display-dependent packaged-host checks not run \(environment\).*console session was locked during 1/);
  assert.deepEqual(locked.details.notRunEnvironment.map(item => item.id), ['b']);
  assert.equal(evaluateNativeEvidence({ evidence: nativeEvidence([check('a', 'fail'), check('b', 'not-run-environment', true)]), packedArtifacts: installed, pack: PACK, sources: SOURCES, binaries }).status, STATUS.fail);
  const other = evaluateNativeEvidence({ evidence: { ...nativeEvidence([check('a', 'pass')]), packed: { packages: [{ ...PACK[0], sha256: 'd'.repeat(64) }, PACK[1]] } }, packedArtifacts: installed, pack: PACK, sources: SOURCES, binaries });
  assert.equal(other.status, STATUS.fail);
  assert.match(other.reason, /produced from other tarballs \(@experiment-kit\/core\)/);
  assert.match(evaluateNativeEvidence({ evidence: nativeEvidence([check('a', 'pass')]), packedArtifacts: { packages: [] }, pack: PACK, sources: SOURCES, binaries }).reason, /does not have this pack installed/);
  assert.match(evaluateNativeEvidence({ evidence: nativeEvidence([check('a', 'pass')]), packedArtifacts: installed, pack: PACK, sources: SOURCES, binaries: { ...ON_DISK, release: { ...ON_DISK.release, matches: false } } }).reason, /release executable differs/);
  assert.match(evaluateNativeEvidence({ evidence: null, packedArtifacts: installed, pack: PACK, sources: SOURCES }).reason, /no packaged-host evidence/);
  assert.match(evaluateNativeEvidence({ evidence: nativeEvidence([check('a', 'not-run')]), packedArtifacts: installed, pack: PACK, sources: SOURCES, binaries }).reason, /incomplete scenario set/);
});

test('history records are append-only: a second record never replaces the first (G78)', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'evidence-history-'));
  try {
    const now = new Date('2026-10-26T12:00:00.000Z');
    const first = writeHistoryRecord(directory, 'native-conformance', { run: 1 }, { now, identity: {} });
    const second = writeHistoryRecord(directory, 'native-conformance', { run: 2 }, { now, identity: {} });
    assert.notEqual(first, second);
    assert.deepEqual(readdirSync(path.join(directory, 'history')).sort(), ['native-conformance-2026-10-26T12-00-00.000Z-1.json', 'native-conformance-2026-10-26T12-00-00.000Z.json']);
    assert.equal(JSON.parse(readFileSync(first, 'utf8')).record.run, 1);
    assert.equal(JSON.parse(readFileSync(second, 'utf8')).record.run, 2);
    assert.throws(() => writeHistoryRecord(directory, '../escape', {}), /Invalid history kind/);
    // An existing file is never overwritten, even when it was written by someone else.
    writeFileSync(path.join(directory, 'history', 'consumer-2026-10-26T12-00-00.000Z.json'), 'kept');
    writeHistoryRecord(directory, 'consumer', { ok: false }, { now, identity: {} });
    assert.equal(readFileSync(path.join(directory, 'history', 'consumer-2026-10-26T12-00-00.000Z.json'), 'utf8'), 'kept');
    // Identity envelope: commit, dirty flag and lock digest from the working tree.
    const withIdentity = JSON.parse(readFileSync(writeHistoryRecord(directory, 'consumer', {}, { now, root }), 'utf8'));
    assert.match(withIdentity.packageLock.sha256, /^[0-9a-f]{64}$/);
    assert.ok('commit' in withIdentity.source && 'dirty' in withIdentity.source);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('source identity reads the commit and dirty state; a missing git checkout is recorded as unknown, not clean', () => {
  const fake = (outputs) => (command, args) => outputs[`${command} ${args[0]}`] ?? null;
  assert.deepEqual(sourceIdentity('/x', fake({ 'git rev-parse': 'f'.repeat(40), 'git status': ' M a.ts\n?? b.ts' })), { commit: 'f'.repeat(40), dirty: true, changedPaths: 2 });
  assert.deepEqual(sourceIdentity('/x', fake({ 'git rev-parse': 'f'.repeat(40), 'git status': '' })), { commit: 'f'.repeat(40), dirty: false });
  assert.deepEqual(sourceIdentity('/x', fake({})), { commit: null, dirty: null });
  assert.equal(lockIdentity('/nonexistent').sha256, null);
});

test('release manifests identify their source commit, dirty flag, lock digest and Node version (G78)', () => {
  // The 0.3.0-preview.1 manifest shape before G78: tarball hash and validation flags only.
  const before = { package: 'experiment-kit-0.3.0-preview.1.tgz', version: '0.3.0-preview.1', sha256: `sha256:${'e'.repeat(64)}`, validation: { npmPackDryRun: 'passed' } };
  assert.deepEqual(missingReleaseIdentity(before), ['source commit and dirty flag', 'package-lock sha256', 'node version']);
  const identity = releaseIdentity(root);
  assert.deepEqual(missingReleaseIdentity({ ...before, ...identity }), []);
  assert.equal(identity.node, process.version);
  assert.equal(identity.packageLock.sha256, lockIdentity(root).sha256);
  // scripts/package-release.mjs writes that identity into release/release-manifest.json, and the pipeline's release
  // gate fails a manifest without it.
  const packageRelease = readFileSync(path.join(root, 'scripts/package-release.mjs'), 'utf8');
  assert.match(packageRelease, /const evidence=\{[^\n]*\.\.\.releaseIdentity\(root\)/);
  assert.match(readFileSync(path.join(root, 'scripts/study-harness/release-pipeline.mjs'), 'utf8'), /missingReleaseIdentity\(manifest\)/);
});

test('the consumer, packaged-host, performance and 2D-consumer evidence writers append a history record next to their latest summary (G78, R35)', () => {
  const conformance = readFileSync(path.join(root, 'examples/study-harness-tauri/scripts/conformance.mjs'), 'utf8');
  const block = conformance.slice(conformance.indexOf("if (!flag('--no-evidence')) {"));
  assert.match(block.slice(0, block.indexOf('\n}\n')), /writeHistoryRecord\(evidenceDir, 'native-conformance', compactNativeEvidence\(evidence\)/);
  const consumer = readFileSync(path.join(root, 'scripts/study-harness/verify-consumer.mjs'), 'utf8');
  assert.match(consumer, /writeFile\(path\.join\(EVIDENCE, 'consumer\.json'\)[\s\S]{0,400}writeHistoryRecord\(EVIDENCE, 'consumer', evidence/);
  assert.match(consumer, /catch \(error\) \{[\s\S]{0,300}writeHistoryRecord\(EVIDENCE, 'consumer', \{ ok: false/);
  // The performance evidence (benchmark.mjs) and the 2D-consumer evidence (verify-packages.mjs) do the same (R35).
  const benchmark = readFileSync(path.join(root, 'scripts/study-harness/benchmark.mjs'), 'utf8');
  assert.match(benchmark, /writeHistoryRecord\(EVIDENCE, 'performance', evidence, \{ root: ROOT \}\)/);
  assert.match(benchmark, /catch \(error\) \{[\s\S]{0,300}writeHistoryRecord\(EVIDENCE, 'performance', \{ ok: false/);
  const packages = readFileSync(path.join(root, 'scripts/verify-packages.mjs'), 'utf8');
  assert.match(packages, /writeHistoryRecord\(out,'package-evidence',evidence,\{root\}\)/);
  assert.match(packages, /catch\(error\) \{[\s\S]{0,200}writeHistoryRecord\(out,'package-evidence',\{ok:false/);
  // The compact native record keeps every scenario's checks (ID, result, detail) and drops only raw diagnostics.
  const evidence = { schema: 's', summary: { pass: 2 }, scenarios: { offline: { run: 'r1', checks: [{ id: 'a', result: 'pass' }], launch: { log: 'x'.repeat(1000) } }, crash: { run: 'r1', point: 'p', checks: [{ id: 'b', result: 'fail', detail: { code: 1 } }], phases: [1, 2, 3] } } };
  const compact = compactNativeEvidence(evidence);
  assert.deepEqual(compact.scenarios, { offline: { run: 'r1', checks: [{ id: 'a', result: 'pass' }] }, crash: { run: 'r1', point: 'p', checks: [{ id: 'b', result: 'fail', detail: { code: 1 } }] } });
  assert.deepEqual(compact.summary, evidence.summary);
});
