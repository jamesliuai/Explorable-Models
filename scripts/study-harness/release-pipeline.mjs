#!/usr/bin/env node
// The single Study Harness release verification pipeline (report §20.1, §21 A59, §22.3; G62, G78).
//
//   npm run release:study-harness [-- --only=a,b | --skip=a,b] [--native=verify|run] [--allow-environment-gaps]
//
// 1. Packs the six packages ONCE with scripts/study-harness/pack.mjs (complete pack: builds them first) and records the
//    manifest digest and the tarball sha256 set. Every gate record references that pack; the gates that consume tarballs
//    (verify:packages, verify:consumer, benchmark, native) are checked against exactly these sha256 values.
// 2. Runs every required gate in GATES. A gate with `script` runs the npm script read from package.json at run time,
//    segment by segment (`a && b`), with machine-readable reporters added (vitest --reporter=json, playwright
//    --reporter=json, node --test with a TAP destination; cargo test and tsc summaries parsed from their output), so the
//    pipeline runs exactly the documented commands. Per gate it records the commands, status, exact counts, duration
//    and a log under release/study-harness/logs/<run>/.
// 3. Writes release/study-harness/verification.json (the latest run) and an append-only copy in
//    release/study-harness/history/; a full (non-partial) run also writes a copy to docs/study-harness/evidence/history/.
//
// Gate statuses: pass | fail | not-run (environment): the gate cannot run on this machine, with a machine-checked reason
// (no macOS, browser not installed, cargo missing, display-dependent checks while the console is locked) |
// not-run (blocked): a prerequisite in this run failed or did not run | not-run (excluded): --only/--skip.
// Overall status: fail if any gate failed; otherwise partial if anything was excluded (never release evidence);
// otherwise incomplete if a gate was not run because of the environment; otherwise pass.
// Exit code: 1 fail; 2 incomplete (0 with --allow-environment-gaps); 0 pass or partial.
//
// --native=verify (default) checks that the recorded packaged-host evidence (docs/study-harness/evidence/
// native-conformance.json), the reference host's installed tarballs (examples/study-harness-tauri/
// packed-artifacts.json) and the tarballs each packaged app was built from (the runner's build records) are exactly
// this pack; that both packaged executables are present with the recorded sha256; that the evidence holds every
// scenario of a full run (examples/study-harness-tauri/scripts/scenarios.mjs), each from a current run, with the latest
// run not partial; and reports the evidence's per-check results (evaluateNativeEvidence). --native=run installs this
// pack into the reference host and runs the full packaged conformance suite first
// (scripts/study-harness/native-conformance.mjs --install-existing). Nothing is signed, published, deployed or uploaded.
//
// The benchmark gate judges performance.json itself (evaluateBenchmarkEvidence): this pack, identified, not --quick,
// every required row present and measured (§18 targets and reported-only measures alike) and every target met, no
// workload error, console error or CSP violation; spatial rows that could not run for lack of hardware WebGL in the GPU
// run, or of any WebGL 2 context in the software-WebGL run, make it not-run (environment).
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  consoleLocked, lockIdentity, missingReleaseIdentity, platformIdentity, sha256Hex, sourceIdentity, stamp, toolVersions, writeHistoryRecord,
} from './evidence-identity.mjs';
import { REQUIRED_SCENARIOS } from '../../examples/study-harness-tauri/scripts/scenarios.mjs';
import { changeList, hostSourceDigest, sourceChanges } from '../../examples/study-harness-tauri/scripts/build-record.mjs';
import { REQUIRED_TARGET_KEYS, benchmarkOutcome, evaluateTargets } from './benchmark-evidence.mjs';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const SCHEMA = 'study-harness.release-verification/1';
export const STATUS = Object.freeze({ pass: 'pass', fail: 'fail', environment: 'not-run (environment)', blocked: 'not-run (blocked)', excluded: 'not-run (excluded)' });
const OUT = path.join(ROOT, 'release/study-harness');
const PACK_MANIFEST = path.join(OUT, 'packages/manifest.json');
const EVIDENCE = path.join(ROOT, 'docs/study-harness/evidence');
const GATE_TIMEOUT_MS = 90 * 60_000;
const BROWSER_TESTS = ['chromium'];

/**
 * The required gates (report §20.1 and the named Study Harness gates), in run order. `needs` lists steps/gates whose
 * pass this gate depends on in the same run; `requires` lists environment capabilities (machine-checked).
 */
export const GATES = Object.freeze([
  { id: 'typecheck', script: 'typecheck', label: 'TypeScript typecheck' },
  { id: 'test', script: 'test', label: 'full vitest suite', requires: BROWSER_TESTS },
  { id: 'test:contracts', script: 'test:contracts', label: 'activity contracts: schema lock, TS/Rust agreement, cargo test', requires: ['cargo'] },
  { id: 'test:reference', script: 'test:reference', label: 'independent reference fixtures, catalogue and CLI reference checks', requires: BROWSER_TESTS },
  { id: 'test:disclosure', script: 'test:disclosure', label: 'disclosure, exposure, projection and audience filtering' },
  { id: 'test:migrations', script: 'test:migrations', label: 'artifacts, migrations, host failures, backup and restore' },
  { id: 'test:lifecycle', script: 'test:lifecycle', label: 'interaction/lifecycle unit tests and the browser lifecycle spec', requires: BROWSER_TESTS },
  { id: 'test:browser', script: 'test:browser', label: 'Playwright Chromium, all specs', requires: BROWSER_TESTS },
  { id: 'test:cross-browser', script: 'test:cross-browser', label: 'Playwright Firefox and WebKit: composition, embedding and every Study Harness spec (G73)', requires: ['firefox', 'webkit'] },
  { id: 'build', script: 'build', label: 'production site build' },
  { id: 'verify:gallery', script: 'verify:gallery', label: 'gallery worker checks on the production build', needs: ['build'], requires: BROWSER_TESTS },
  { id: 'verify:packages', script: 'verify:packages', label: 'packed 2D consumer (core, activity, player, agent)', needs: ['pack'], requires: BROWSER_TESTS },
  { id: 'verify:consumer', command: 'node scripts/study-harness/verify-consumer.mjs --use-pack={manifestSha256}', label: 'packed Study Harness consumer and budgets (this pack)', needs: ['pack'], requires: BROWSER_TESTS },
  { id: 'benchmark', script: 'benchmark', label: 'performance/lifecycle benchmark of the packed production consumer', needs: ['verify:consumer'], requires: BROWSER_TESTS },
  { id: 'review-packets', command: 'vitest run tests/cli/activity-packet.test.ts', label: 'subject-review packets are current', requires: BROWSER_TESTS },
  { id: 'test:release', script: 'test:release', label: 'release tooling tests' },
  { id: 'release', script: 'release', label: 'unified source package and clean install', requires: BROWSER_TESTS },
  { id: 'native', label: 'packaged Tauri reference-host conformance (macOS)', needs: ['pack'], requires: ['macos'] },
]);
export const STEP_IDS = Object.freeze(['pack', ...GATES.map(gate => gate.id)]);
/** Engines and specs the cross-browser gate must run (report §20.1, G73); each spec must run in both engines. */
export const CROSS_BROWSER_ENGINES = Object.freeze(['firefox', 'webkit']);
export const CROSS_BROWSER_SPECS = Object.freeze([
  'composition.spec.ts', 'embedding-renderer.spec.ts', 'study-quadratic.spec.ts', 'study-function-derivative.spec.ts',
  'study-linear-transformation.spec.ts', 'study-lifecycle.spec.ts', 'study-projection.spec.ts', 'study-interaction.spec.ts',
  'study-presentation.spec.ts', 'study-observed-data.spec.ts', 'study-spatial.spec.ts', 'study-spatial-framing.spec.ts',
]);
/** What a Playwright Firefox/WebKit result is evidence of, and what it is not (A53). */
export const CROSS_BROWSER_SCOPE = Object.freeze({
  evidence: 'Playwright-pinned Firefox and WebKit builds, headless, on this machine, against the development server and the integration-fixture host.',
  notEvidenceOf: [
    'Safari (Playwright WebKit is not the Safari application)',
    'the packaged reference host (its WKWebView is recorded separately: docs/study-harness/evidence/native-conformance.json, the native gate)',
    'real mobile devices (a narrow viewport is not a device)',
    'the Study Harness application, assistive-technology use or learning outcomes',
  ],
  actualSafari: false,
  packagedWebView: false,
  realMobileDevice: false,
});
/** Gates that read the pipeline's tarballs; selecting one selects the pack step. */
const NEEDS_PACK = new Set(GATES.filter(gate => gate.needs?.includes('pack')).map(gate => gate.id));

// ---------------------------------------------------------------------------------------------------------------------
// Arguments and selection
// ---------------------------------------------------------------------------------------------------------------------
export function parseArgs(argv) {
  const value = name => argv.find(item => item.startsWith(`${name}=`))?.slice(name.length + 1);
  const list = name => { const raw = value(name); return raw === undefined ? null : raw.split(',').map(item => item.trim()).filter(Boolean); };
  const only = list('--only'), skip = list('--skip');
  for (const id of [...(only ?? []), ...(skip ?? [])]) if (!STEP_IDS.includes(id)) throw new Error(`Unknown gate "${id}". Known: ${STEP_IDS.join(', ')}`);
  if (only && skip) throw new Error('Use either --only or --skip, not both.');
  const native = value('--native') ?? 'verify';
  if (!['verify', 'run'].includes(native)) throw new Error('--native must be verify or run.');
  const known = new Set(['--allow-environment-gaps']);
  for (const item of argv) if (!/^--(only|skip|native)=/.test(item) && !known.has(item)) throw new Error(`Unknown argument ${item}`);
  return { only, skip, native, allowEnvironmentGaps: argv.includes('--allow-environment-gaps') };
}

/** Which steps run: --only/--skip; the pack step is included whenever a selected gate reads the tarballs. */
export function selectSteps({ only, skip }) {
  const selected = new Set(only ?? STEP_IDS);
  for (const id of skip ?? []) selected.delete(id);
  if (only && [...selected].some(id => NEEDS_PACK.has(id))) selected.add('pack');
  return { selected, partial: !!(only || skip) && STEP_IDS.some(id => !selected.has(id)) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Commands and reporters
// ---------------------------------------------------------------------------------------------------------------------
const SHELL_META = /[|;<>`$()'"\\]/;
/** Splits an npm script into `&&` segments of whitespace-separated tokens; null when it needs a real shell. */
export function splitScript(script) {
  if (typeof script !== 'string' || !script.trim()) return null;
  const segments = script.split('&&').map(segment => segment.trim());
  if (segments.some(segment => !segment || SHELL_META.test(segment.replace(/&&/g, '')) || segment.includes('&'))) return null;
  return segments.map(segment => segment.split(/\s+/));
}

/** The runner of a token list after leading NAME=value assignments. */
export function runnerOf(tokens) {
  const start = tokens.findIndex(token => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
  const [command, sub] = tokens.slice(start);
  if (command === 'vitest') return 'vitest';
  if (command === 'playwright' && sub === 'test') return 'playwright';
  if (command === 'node' && tokens.slice(start).includes('--test')) return 'node-test';
  if (command === 'cargo' && sub === 'test') return 'cargo';
  if (command === 'tsc') return 'tsc';
  return 'other';
}

/**
 * Adds a machine-readable reporter to one segment. Returns the argv to spawn, extra environment and the report file
 * (null for runners parsed from their log).
 */
export function instrument(tokens, { reportFile, playwrightOutput }) {
  const start = tokens.findIndex(token => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
  const env = Object.fromEntries(tokens.slice(0, start).map(token => [token.slice(0, token.indexOf('=')), token.slice(token.indexOf('=') + 1)]));
  const argv = tokens.slice(start);
  const runner = runnerOf(tokens);
  if (runner === 'vitest') return { runner, argv: [...argv, '--reporter=default', '--reporter=json', `--outputFile.json=${reportFile}`], env, report: reportFile };
  if (runner === 'playwright') return { runner, argv: [...argv, '--reporter=list,json', `--output=${playwrightOutput}`], env: { ...env, PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile }, report: reportFile };
  if (runner === 'node-test') {
    const at = argv.indexOf('--test') + 1;
    return { runner, argv: [...argv.slice(0, at), '--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=tap', `--test-reporter-destination=${reportFile}`, ...argv.slice(at)], env, report: reportFile };
  }
  return { runner, argv, env, report: null };
}

/** Resolves the executable of a segment: workspace binaries from node_modules/.bin, node as this Node. */
function executable(command, root) {
  if (command === 'node') return process.execPath;
  const local = path.join(root, 'node_modules/.bin', command);
  return existsSync(local) ? local : command;
}

// ---------------------------------------------------------------------------------------------------------------------
// Parsers (exact counts from machine-readable output)
// ---------------------------------------------------------------------------------------------------------------------
export function parseVitestReport(json) {
  if (!json || typeof json.numTotalTests !== 'number') return null;
  const files = Array.isArray(json.testResults) ? json.testResults : [];
  return {
    total: json.numTotalTests, passed: json.numPassedTests, failed: json.numFailedTests, skipped: json.numPendingTests ?? 0, todo: json.numTodoTests ?? 0,
    files: files.length, failedFiles: files.filter(file => file.status === 'failed').map(file => path.relative(ROOT, file.name)),
    success: json.success === true,
  };
}

const PLAYWRIGHT_OUTCOME = { expected: 'passed', unexpected: 'failed', flaky: 'flaky', skipped: 'skipped' };
export function parsePlaywrightReport(json) {
  if (!json || !json.stats || typeof json.stats.expected !== 'number') return null;
  const files = new Set();
  const failedTests = [];
  /** Per project (engine): totals, per-spec counts and every skipped test with its recorded reason. */
  const byProject = {};
  const empty = () => ({ total: 0, passed: 0, failed: 0, flaky: 0, skipped: 0 });
  // A file suite's title is its file name; describe blocks nest below it.
  const visit = (suite, trail) => {
    if (suite.file) files.add(suite.file);
    const here = suite.title && suite.title !== suite.file ? [...trail, suite.title] : trail;
    for (const spec of suite.specs ?? []) {
      const file = spec.file ?? suite.file;
      for (const test of spec.tests ?? []) {
        const name = `${file} › ${[...here, spec.title].join(' › ')}`;
        if (test.status === 'unexpected') failedTests.push(`[${test.projectName ?? ''}] ${name}`);
        const outcome = PLAYWRIGHT_OUTCOME[test.status];
        if (!outcome) continue;
        const project = byProject[test.projectName ?? ''] ??= { ...empty(), specs: {}, skippedTests: [] };
        const counts = project.specs[file] ??= empty();
        for (const target of [project, counts]) { target.total++; target[outcome]++; }
        if (outcome === 'skipped') project.skippedTests.push({ test: name, reason: (test.annotations ?? []).find(item => item.type === 'skip' || item.type === 'fixme')?.description ?? null });
      }
    }
    for (const child of suite.suites ?? []) visit(child, here);
  };
  for (const suite of json.suites ?? []) visit(suite, []);
  const { expected, unexpected, flaky = 0, skipped = 0 } = json.stats;
  return {
    total: expected + unexpected + flaky + skipped, passed: expected, failed: unexpected, flaky, skipped,
    projects: (json.config?.projects ?? []).map(project => project.name), specFiles: [...files].sort(), failedTests: failedTests.slice(0, 50),
    errors: (json.errors ?? []).length, byProject,
  };
}

/**
 * The cross-browser record (G73, A53): per engine its version and build, totals, per-spec pass/fail/flaky/skip counts
 * and every skipped test with its reason; the specs the gate requires that did not run in an engine; and the scope.
 */
export function crossBrowserRecord(counts, browsers = {}) {
  const engines = {};
  const missing = [];
  for (const engine of CROSS_BROWSER_ENGINES) {
    const project = counts?.byProject?.[engine] ?? null;
    const browser = browsers[engine] ?? {};
    const build = browser.executablePath?.match(/ms-playwright[\\/]([a-z_]+-\d+)/)?.[1] ?? null;
    engines[engine] = { version: browser.version ?? null, build, ...(project ?? { total: 0, passed: 0, failed: 0, flaky: 0, skipped: 0, specs: {}, skippedTests: [] }) };
    for (const spec of CROSS_BROWSER_SPECS) if (!project?.specs?.[spec]?.total) missing.push(`${engine}: ${spec}`);
  }
  const unexplained = CROSS_BROWSER_ENGINES.flatMap(engine => engines[engine].skippedTests.filter(item => !item.reason).map(item => `[${engine}] ${item.test}`));
  return { engines, specs: [...CROSS_BROWSER_SPECS], missing, unexplainedSkips: unexplained, scope: CROSS_BROWSER_SCOPE };
}

/**
 * release/preview/cross-browser-evidence.json (written by scripts/verify-preview.mjs): the cross-browser record of one
 * run with the package identity it ran for. Playwright WebKit stays apart from the packaged WKWebView (native gate) and
 * from Safari and real mobile devices, which no automated run here establishes (A53).
 */
export function crossBrowserEvidence({ version, createdAt, source = null, record, result, packages, pipeline = null }) {
  return {
    version, createdAt, source, ...(pipeline ? { pipeline } : {}),
    command: 'npm run test:cross-browser', result,
    engines: record.engines, specs: record.specs, missing: record.missing, unexplainedSkips: record.unexplainedSkips,
    packages, scope: record.scope,
    separateEvidence: { packagedWebView: 'docs/study-harness/evidence/native-conformance.json (native gate; macOS WKWebView of the packaged reference host)', chromium: 'release/preview/verification.json (test:browser)' },
    actualSafari: false, packagedWebView: false, realMobileDevice: false,
  };
}

/** Node test runner TAP summary (`# tests`, `# pass`, …). */
export function parseTap(text) {
  if (typeof text !== 'string') return null;
  const read = name => { const all = [...text.matchAll(new RegExp(`^# ${name} (\\d+)\\s*$`, 'gm'))]; return all.length ? Number(all.at(-1)[1]) : null; };
  const total = read('tests');
  if (total === null) return null;
  return { total, passed: read('pass') ?? 0, failed: read('fail') ?? 0, cancelled: read('cancelled') ?? 0, skipped: read('skipped') ?? 0, todo: read('todo') ?? 0 };
}

/** Sums every `test result:` line of `cargo test` (one per test binary, doc tests included). */
export function parseCargo(text) {
  const results = [...String(text ?? '').matchAll(/test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out/g)];
  if (!results.length) return null;
  const sum = index => results.reduce((total, match) => total + Number(match[index]), 0);
  return { total: sum(2) + sum(3) + sum(4), passed: sum(2), failed: sum(3), skipped: sum(4), binaries: results.length };
}

/** tsc diagnostics count. */
export const parseTsc = text => ({ errors: [...String(text ?? '').matchAll(/error TS\d+:/g)].length });

/** Combined test counts of a gate's segments. */
export function combineCounts(list) {
  const counted = list.filter(Boolean);
  if (!counted.length) return null;
  const out = { total: 0, passed: 0, failed: 0, skipped: 0 };
  for (const counts of counted) {
    for (const key of ['total', 'passed', 'failed', 'skipped']) out[key] += counts[key] ?? 0;
    for (const key of ['flaky', 'todo', 'cancelled']) if (counts[key]) out[key] = (out[key] ?? 0) + counts[key];
  }
  return out;
}

/** Status of a gate from its segments (exit codes and parsed reports). */
export function gateOutcome(segments) {
  for (const segment of segments) {
    if (segment.timedOut) return { status: STATUS.fail, reason: `${segment.command} timed out after ${Math.round(GATE_TIMEOUT_MS / 60000)} min` };
    if (segment.exitCode !== 0) {
      const files = segment.counts?.failedFiles?.length ? ` (failed files: ${segment.counts.failedFiles.join(', ')})` : '';
      return { status: STATUS.fail, reason: `${segment.command} exited with ${segment.exitCode ?? segment.signal}${files}` };
    }
    if (['vitest', 'playwright', 'node-test', 'cargo'].includes(segment.runner)) {
      if (!segment.counts) return { status: STATUS.fail, reason: `${segment.command}: no machine-readable ${segment.runner} report` };
      if (segment.counts.failed > 0) return { status: STATUS.fail, reason: `${segment.command}: ${segment.counts.failed} failed` };
      if (segment.counts.total === 0) return { status: STATUS.fail, reason: `${segment.command}: no tests ran` };
    }
    if (segment.runner === 'tsc' && segment.counts?.errors > 0) return { status: STATUS.fail, reason: `${segment.command}: ${segment.counts.errors} type errors` };
  }
  return { status: STATUS.pass };
}

/** Overall status (see header). */
export function overallStatus(gates, partial) {
  if (gates.some(gate => gate.status === STATUS.fail)) return 'fail';
  if (partial) return 'partial';
  if (gates.some(gate => gate.status !== STATUS.pass)) return 'incomplete';
  return 'pass';
}

export function summarize(gates) {
  const count = status => gates.filter(gate => gate.status === status).length;
  return { gates: gates.length, pass: count(STATUS.pass), fail: count(STATUS.fail), notRunEnvironment: count(STATUS.environment), notRunBlocked: count(STATUS.blocked), notRunExcluded: count(STATUS.excluded) };
}

/** Compares tarball records ({name, sha256}) with the pipeline pack; returns the mismatches (missing or different). */
export function compareTarballs(pack, records) {
  const expected = new Map(pack.map(item => [item.name, item.sha256]));
  const mismatches = [];
  for (const record of records ?? []) {
    if (!expected.has(record.name)) mismatches.push({ name: record.name, recorded: record.sha256, pack: null });
    else if (expected.get(record.name) !== record.sha256) mismatches.push({ name: record.name, recorded: record.sha256, pack: expected.get(record.name) });
  }
  return { compared: (records ?? []).length, mismatches };
}

/** The packaged apps every native evidence record must identify (conformance.mjs builds both). */
export const NATIVE_APPS = Object.freeze(['release', 'conformance']);
const tarballNames = records => (records ?? []).map(item => item.name).sort();
/** The check results the packaged conformance runner writes (examples/study-harness-tauri/scripts/conformance.mjs). */
export const NATIVE_CHECK_RESULTS = Object.freeze(['pass', 'fail', 'not-run', 'not-run-environment']);

/**
 * Packaged-host evidence against this pack (A51, A59; report §17): tarball identities (evidence, the installed
 * packed-artifacts record, and the tarballs each packaged app was built from, from conformance.mjs's build records);
 * both executables present with exactly the recorded sha256, which is also the one each build record describes; a
 * complete scenario set — every scenario of a full run (`required`, derived from the runner's own scenario list in
 * examples/study-harness-tauri/scripts/scenarios.mjs), each from a current (non-superseded) run, with a full run among
 * them and the latest run not partial; and the per-check results (only NATIVE_CHECK_RESULTS count; any other value
 * fails), with display-dependent checks not run because of the environment reported as such (never as passed).
 * `sources` is the reference host's current hostSourceDigest (build-record.mjs): both apps must have been built from
 * the same sources, the run must have ended with them unchanged, and the tree must still hold them, since the working
 * tree is uncommitted and a commit cannot tie the binaries to their sources.
 */
export function evaluateNativeEvidence({ evidence, packedArtifacts, pack, binaries, sources, required = REQUIRED_SCENARIOS }) {
  if (!evidence) return { status: STATUS.fail, reason: 'no packaged-host evidence (docs/study-harness/evidence/native-conformance.json); run with --native=run' };
  const fromEvidence = compareTarballs(pack, evidence.packed?.packages);
  const installed = compareTarballs(pack, packedArtifacts?.packages);
  const built = Object.fromEntries(NATIVE_APPS.map(kind => [kind, compareTarballs(pack, evidence.builds?.[kind]?.packed?.packages)]));
  const summary = evidence.summary ?? {};
  const scenarios = evidence.scenarios ?? {};
  const checks = Object.values(scenarios).flatMap(scenario => scenario.checks ?? []);
  const notRunEnvironment = checks.filter(check => check.result === 'not-run-environment').map(check => ({ id: check.id, displayContext: check.displayContext ?? null }));
  // conformance.mjs writes exactly these results; any other value (or none) is not evidence of a pass.
  const unrecognised = checks.filter(check => !NATIVE_CHECK_RESULTS.includes(check.result)).map(check => `${check.id ?? 'unnamed check'} (${check.result === undefined ? 'no result' : JSON.stringify(check.result)})`);
  const counts = { total: checks.length, passed: checks.filter(check => check.result === 'pass').length, failed: checks.filter(check => check.result === 'fail').length, notRunEnvironment: notRunEnvironment.length, notRun: checks.filter(check => check.result === 'not-run').length };
  const runs = evidence.runs ?? [];
  const current = runs.filter(run => !run.superseded);
  const latest = runs.at(-1) ?? null;
  const missingScenarios = required.filter(key => !(scenarios[key]?.checks?.length));
  const fromOtherRuns = Object.entries(scenarios).filter(([, scenario]) => !current.some(run => run.id === scenario.run)).map(([key]) => key);
  const completeness = { required: [...required], missingScenarios, fromOtherRuns, latestRun: latest ? { id: latest.id, mode: latest.mode } : null, currentFullRun: current.find(run => run.mode === 'full')?.id ?? null };
  const details = {
    evidenceGeneratedAt: evidence.generatedAt ?? null, evidenceRuns: runs.map(run => ({ id: run.id, mode: run.mode, superseded: !!run.superseded, consoleSession: run.consoleSession ?? null })),
    tarballs: { evidence: fromEvidence, installed, builtFrom: built }, binaries: binaries ?? null, completeness,
    sources: { builtFrom: evidence.builds?.release?.sources?.digest ?? null, atEndOfRun: evidence.sources?.atEnd?.digest ?? null, inTree: sources?.digest ?? null, changedInTree: evidence.builds?.release?.sources?.digest && sources?.digest ? sourceChanges(evidence.builds.release.sources, sources) : null },
    failedChecks: summary.failed ?? checks.filter(check => check.result === 'fail').map(check => check.id), notRunEnvironment, unrecognisedChecks: unrecognised,
  };
  const fail = reason => ({ status: STATUS.fail, reason, counts, details });
  if (!fromEvidence.compared) return fail('the evidence records no packed tarballs');
  if (fromEvidence.mismatches.length) return fail(`the packaged-host evidence was produced from other tarballs (${fromEvidence.mismatches.map(item => item.name).join(', ')}); run with --native=run`);
  if (installed.mismatches.length || !installed.compared) return fail('the reference host does not have this pack installed (examples/study-harness-tauri/packed-artifacts.json); run with --native=run');
  for (const kind of NATIVE_APPS) {
    // The tarballs the app was BUILT from (its build record), not only those installed when the run was recorded.
    if (!built[kind].compared || tarballNames(evidence.builds?.[kind]?.packed?.packages).join() !== tarballNames(evidence.packed?.packages).join()) return fail(`the evidence does not record which tarballs the packaged ${kind} app was built from (conformance.mjs build record); run with --native=run`);
    if (built[kind].mismatches.length) return fail(`the packaged ${kind} app was built from other tarballs (${built[kind].mismatches.map(item => item.name).join(', ')}); run with --native=run`);
  }
  for (const kind of NATIVE_APPS) {
    const recorded = evidence.binaries?.[kind]?.sha256 ?? null;
    if (!recorded) return fail(`the evidence records no packaged ${kind} executable`);
    if (evidence.builds?.[kind]?.executableSha256 !== recorded) return fail(`the packaged ${kind} executable that ran is not the one its build record describes`);
    const onDisk = binaries?.[kind];
    if (!onDisk?.present) return fail(`the packaged ${kind} executable recorded in the evidence is missing (${onDisk?.executable ?? evidence.binaries[kind].executable ?? 'no path'}): the evidence cannot be tied to binaries on this machine; run with --native=run`);
    if (onDisk.matches !== true) return fail(`the packaged ${kind} executable differs from the one recorded in the evidence`);
  }
  for (const kind of NATIVE_APPS) {
    if (!evidence.builds?.[kind]?.sources?.digest) return fail(`the evidence does not record the reference host sources the packaged ${kind} app was built from (conformance.mjs build record); run with --native=run`);
  }
  const builtFrom = evidence.builds.release.sources;
  if (evidence.builds.conformance.sources.digest !== builtFrom.digest) return fail(`the packaged release and conformance apps were built from different reference host sources (${changeList(sourceChanges(evidence.builds.conformance.sources, builtFrom))}); run with --native=run`);
  if (!evidence.sources?.atEnd?.digest) return fail('the evidence does not record the reference host sources at the end of the packaged run; run with --native=run');
  if (evidence.sources.atEnd.digest !== builtFrom.digest) return fail(`the reference host sources changed during the packaged run (${changeList(evidence.sources.changedSinceBuild ?? []) || evidence.sources.atEnd.digest}); run with --native=run`);
  if (!sources?.digest) return fail('the reference host sources in this tree could not be read');
  if (sources.digest !== builtFrom.digest) return fail(`the reference host sources changed since the packaged apps were built (${changeList(sourceChanges(builtFrom, sources))}); run with --native=run`);
  if (latest?.mode === 'partial') return fail(`the latest packaged run (${latest.id}) ran only some scenario chains (--only); a partial run is never release evidence`);
  if (!completeness.currentFullRun) return fail('no current full packaged run in the evidence (every run is superseded, partial or display-only)');
  if (missingScenarios.length) return fail(`incomplete scenario set: ${missingScenarios.join(', ')} not recorded`);
  if (fromOtherRuns.length) return fail(`scenario results from a superseded or unrecorded run: ${fromOtherRuns.join(', ')}`);
  if (!counts.total) return fail('the evidence records no packaged-host checks');
  if (counts.failed) return fail(`${counts.failed} packaged-host checks failed`);
  if (counts.notRun) return fail(`${counts.notRun} packaged-host checks were not run (incomplete scenario set)`);
  if (unrecognised.length) return fail(`${unrecognised.length} packaged-host checks have no recognised result (${NATIVE_CHECK_RESULTS.join(', ')}): ${unrecognised.slice(0, 5).join('; ')}${unrecognised.length > 5 ? '; …' : ''}`);
  if (counts.notRunEnvironment) {
    const locked = notRunEnvironment.filter(item => item.displayContext?.consoleLock?.atLaunch === true || (item.displayContext?.consoleLock?.changes?.length ?? 0) > 0).length;
    return { status: STATUS.environment, reason: `${counts.notRunEnvironment} display-dependent packaged-host checks not run (environment): WebKit reported the window hidden${locked ? `; the macOS console session was locked during ${locked} of them` : ''}`, counts, details };
  }
  return { status: STATUS.pass, counts, details };
}

// ---------------------------------------------------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------------------------------------------------
export async function browserEnvironment() {
  const out = {};
  let playwright = null;
  try { playwright = await import('playwright'); } catch (error) { for (const name of ['chromium', 'firefox', 'webkit']) out[name] = { installed: false, reason: `playwright is not installed (${error.message.split('\n')[0]})` }; return out; }
  for (const name of ['chromium', 'firefox', 'webkit']) {
    const type = playwright[name];
    const executablePath = type.executablePath();
    if (!existsSync(executablePath)) { out[name] = { installed: false, executablePath, reason: `Playwright ${name} is not installed (${executablePath} missing; run npx playwright install ${name})` }; continue; }
    try { const browser = await type.launch({ headless: true }); out[name] = { installed: true, version: browser.version(), executablePath }; await browser.close(); }
    catch (error) { out[name] = { installed: true, version: null, executablePath, reason: `launch failed: ${error.message.split('\n')[0]}` }; }
  }
  return out;
}

/** Machine-checked reason a requirement is unavailable here, or null. */
export function missingRequirement(requirement, environment) {
  if (requirement === 'macos') return environment.platform.platform === 'darwin' ? null : `the packaged reference-host conformance runs on macOS only (this platform: ${environment.platform.platform})`;
  if (requirement === 'cargo') return environment.tools.cargo ? null : 'cargo is not installed (cargo -V failed)';
  const browser = environment.browsers[requirement];
  if (!browser) return `unknown requirement ${requirement}`;
  return browser.installed && browser.version ? null : browser.reason;
}

// ---------------------------------------------------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------------------------------------------------
/** Runs one segment, streaming its output to the gate log; `keepOutput` keeps all of it for summary parsing. */
function runSegment({ argv, env, cwd, log, label, keepOutput = false }) {
  return new Promise(resolve => {
    const started = Date.now();
    log.write(`\n$ ${label}\n`);
    const child = spawn(executable(argv[0], cwd), argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const take = chunk => { log.write(chunk); tail = keepOutput ? tail + chunk.toString() : (tail + chunk.toString()).slice(-400_000); };
    child.stdout.on('data', take); child.stderr.on('data', take);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 10_000).unref(); }, GATE_TIMEOUT_MS);
    child.on('error', error => { log.write(`\n[pipeline] spawn failed: ${error.message}\n`); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ exitCode: code, signal, timedOut, durationMs: Date.now() - started, output: tail }); });
  });
}

const readJson = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const readText = file => { try { return readFileSync(file, 'utf8'); } catch { return null; } };
const fresh = (record, since, key = 'createdAt') => !!record && Date.parse(record[key]) >= since;

export async function runCommandGate(gate, context) {
  const { scripts, logDir, run, pack } = context;
  const name = gate.id.replace(/[^A-Za-z0-9.-]+/g, '-');
  const logFile = path.join(logDir, `${name}.log`);
  const log = createWriteStream(logFile);
  const raw = gate.script ? scripts[gate.script] : gate.command.replace('{manifestSha256}', pack?.manifestSha256 ?? '');
  const record = { commands: [], segments: [] };
  if (gate.script && typeof raw !== 'string') { log.end(); return { ...record, status: STATUS.fail, reason: `npm script "${gate.script}" is not defined in package.json`, log: path.relative(ROOT, logFile) }; }
  const split = splitScript(raw);
  if (!split) { log.end(); return { ...record, status: STATUS.fail, reason: `cannot run "${raw}" without a shell; keep release scripts to plain && chains`, log: path.relative(ROOT, logFile) }; }
  record.script = gate.script ? `npm run ${gate.script}` : null;
  let index = 0;
  for (const tokens of split) {
    index++;
    const reportFile = path.join(logDir, `${name}.${index}.report`);
    const { runner, argv, env, report } = instrument(tokens, { reportFile: `${reportFile}${runnerOf(tokens) === 'node-test' ? '.tap' : '.json'}`, playwrightOutput: path.join(logDir, `${name}.${index}.playwright`) });
    const command = tokens.join(' ');
    record.commands.push(command);
    const childEnv = { ...process.env, ...env, NO_COLOR: '1' };
    delete childEnv.FORCE_COLOR; // NO_COLOR alone keeps logs plain; both together only produce a Node warning.
    const result = await runSegment({ argv, env: childEnv, cwd: ROOT, log, label: argv.join(' '), keepOutput: runner === 'cargo' || runner === 'tsc' });
    let counts = null;
    if (runner === 'vitest') counts = parseVitestReport(readJson(report));
    else if (runner === 'playwright') counts = parsePlaywrightReport(readJson(report));
    else if (runner === 'node-test') counts = parseTap(readText(report));
    else if (runner === 'cargo') counts = parseCargo(result.output);
    else if (runner === 'tsc') counts = parseTsc(result.output);
    record.segments.push({ command, runner, exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut, durationMs: result.durationMs, counts, ...(report ? { report: path.relative(ROOT, report) } : {}) });
    if (result.exitCode !== 0) break;
  }
  await new Promise(resolve => log.end(resolve));
  const outcome = gateOutcome(record.segments.map((segment, at) => ({ ...segment, command: record.commands[at] })));
  const counts = combineCounts(record.segments.map(segment => ['vitest', 'playwright', 'node-test', 'cargo'].includes(segment.runner) ? segment.counts : null));
  return { ...record, ...outcome, ...(counts ? { counts } : {}), log: path.relative(ROOT, logFile), startedAt: new Date(run.gateStart).toISOString() };
}

/** Gate-specific evidence checks after the commands (tarball identity, fresh evidence, recorded counts). */
export function afterGate(gate, result, { pack, gateStart, browsers = {} }) {
  if (result.status !== STATUS.pass && result.status !== STATUS.fail) return result;
  const failWith = (reason, details) => ({ ...result, status: STATUS.fail, reason: result.status === STATUS.fail ? result.reason : reason, details: { ...result.details, ...details } });
  if (gate.id === 'verify:gallery') {
    const checks = readJson(path.join(ROOT, 'dist/release-checks.json'));
    if (!checks) return failWith('dist/release-checks.json was not written');
    return { ...result, details: { legacyExperiments: checks.reports?.length ?? null, legacyReferenceChecks: checks.reports?.reduce((sum, item) => sum + item.results.length, 0) ?? null, declarativeFreshRestores: checks.documentReports?.length ?? null, externalNetwork: checks.externalNetwork ?? null } };
  }
  if (gate.id === 'verify:packages') {
    const evidence = readJson(path.join(ROOT, 'release/preview/package-evidence.json'));
    if (!fresh(evidence, gateStart)) return failWith('release/preview/package-evidence.json was not written by this run');
    const tarballs = compareTarballs(pack.packages, evidence.packages);
    const details = { tarballs, consumerChecks: evidence.checks?.length ?? null, browser: evidence.browser ?? null, source: evidence.source ?? null, packageLock: evidence.packageLock ?? null, history: evidence.history ?? null };
    if (tarballs.mismatches.length || !tarballs.compared) return failWith(`verify:packages packed different tarballs than the pipeline pack (${tarballs.mismatches.map(item => item.name).join(', ') || 'none recorded'})`, details);
    const missing = missingReleaseIdentity(evidence);
    if (missing.length) return failWith(`release/preview/package-evidence.json lacks its ${missing.join(', ')}`, details);
    return { ...result, details };
  }
  if (gate.id === 'verify:consumer') {
    const evidence = readJson(path.join(EVIDENCE, 'consumer.json'));
    if (!fresh(evidence, gateStart)) return failWith('docs/study-harness/evidence/consumer.json was not written by this run');
    const tarballs = compareTarballs(pack.packages, evidence.pack?.packages);
    const checks = evidence.checks ?? [];
    const details = { tarballs, failedChecks: checks.filter(check => !check.ok).map(check => check.id) };
    const counted = { ...result, counts: { total: checks.length, passed: checks.filter(check => check.ok).length, failed: checks.filter(check => !check.ok).length, skipped: 0 }, details };
    if (tarballs.mismatches.length || tarballs.compared !== pack.packages.length) return { ...failWith('verify:consumer verified other tarballs than the pipeline pack', details), counts: counted.counts };
    if (!evidence.ok) return { ...failWith(`${details.failedChecks.length} consumer checks failed`, details), counts: counted.counts };
    return counted;
  }
  if (gate.id === 'benchmark') {
    const evidence = readJson(path.join(EVIDENCE, 'performance.json'));
    if (!fresh(evidence, gateStart)) return failWith('docs/study-harness/evidence/performance.json was not written by this run');
    const evaluated = evaluateBenchmarkEvidence({ evidence, pack: pack.packages });
    const exitCode = result.segments?.at(-1)?.exitCode ?? null;
    const details = { ...result.details, ...evaluated.details, exitCode };
    // The evidence decides, and must agree with the script's exit code: 1 fail, 2 environment gap only, 0 pass.
    if (evaluated.status === STATUS.fail) return { ...result, status: STATUS.fail, reason: evaluated.reason, details };
    if (evaluated.status === STATUS.environment) return exitCode === 2 ? { ...result, status: STATUS.environment, reason: evaluated.reason, details } : { ...result, status: STATUS.fail, reason: `the benchmark recorded only environment gaps but exited with ${exitCode} (expected 2): ${result.reason ?? ''}`.trim(), details };
    return { ...result, details };
  }
  if (gate.id === 'release') {
    const file = path.join(ROOT, 'release/release-manifest.json');
    const manifest = readJson(file);
    if (!manifest || statSync(file).mtimeMs < gateStart) return failWith('release/release-manifest.json was not written by this run');
    const details = { package: manifest.package, sha256: manifest.sha256, source: manifest.source ?? null, packageLock: manifest.packageLock ?? null, node: manifest.node ?? null };
    const missing = missingReleaseIdentity(manifest);
    if (missing.length) return failWith(`release/release-manifest.json lacks its ${missing.join(', ')}`, details);
    return { ...result, details };
  }
  if (gate.id === 'test:cross-browser' && result.segments?.length) {
    const counts = result.segments.find(segment => segment.runner === 'playwright')?.counts;
    const record = crossBrowserRecord(counts, browsers);
    const details = { projects: counts?.projects ?? [], specFiles: counts?.specFiles ?? [], ...record };
    // Every required spec runs in both engines, and a test skipped in an engine says why (the reason is the evidence).
    if (record.missing.length) return failWith(`the cross-browser run did not run ${record.missing.join(', ')}`, details);
    if (record.unexplainedSkips.length) return failWith(`tests skipped without a recorded reason: ${record.unexplainedSkips.join('; ')}`, details);
    return { ...result, details };
  }
  return result;
}

/**
 * The benchmark gate's verdict from performance.json (report §18, §20.1, §22.3; A58): measured from exactly this pack,
 * identified (source commit and dirty flag, package-lock digest, Node), not a --quick run, and with every required
 * row present and measured and every §18 target met — a failed workload, a missing row, a row not measured (a target
 * or a reported-only measure), a missed target, a console/page error or a CSP violation fails it
 * (benchmark-evidence.mjs). Rows that could not run because the machine has no hardware WebGL for the GPU run, or no
 * WebGL 2 context for the software-WebGL run, make it not-run (environment), never pass.
 */
export function evaluateBenchmarkEvidence({ evidence, pack, budgets = readJson(path.join(ROOT, 'docs/study-harness/budgets.json')) }) {
  // Raw measurements and the repository's current budgets determine the verdict, never the statuses a JSON file
  // claims. Retain the requirement for a complete written record too: recomputing must not conceal a missing row.
  const targets = evaluateTargets(evidence ?? {}, budgets);
  const outcome = benchmarkOutcome({ ...evidence, targets });
  const recorded = new Map((evidence?.targets ?? []).map(item => [item.key, item]));
  const missingRows = REQUIRED_TARGET_KEYS.filter(key => !recorded.has(key));
  const inconsistentRows = targets.filter(item => recorded.has(item.key)
    && (recorded.get(item.key).met !== item.met || recorded.get(item.key).status !== item.status)).map(item => item.key);
  const tarballs = compareTarballs(pack, evidence?.build?.packages);
  const details = {
    tarballs,
    targets: { met: outcome.met, notMet: outcome.notMet, notMeasured: outcome.notMeasured, notApplicable: targets.filter(item => item.met !== true && item.met !== false).length, missing: missingRows, inconsistent: inconsistentRows, environment: outcome.environmentGaps },
    workloadErrors: outcome.workloadErrors, commandFailures: outcome.commandFailures, consoleErrors: outcome.consoleErrors, cspViolations: outcome.cspViolations, quick: evidence?.quick ?? null,
    source: evidence?.source ?? null, packageLock: evidence?.packageLock ?? null, history: evidence?.history ?? null,
  };
  const fail = reason => ({ status: STATUS.fail, reason, details });
  if (tarballs.mismatches.length || tarballs.compared !== pack.length) return fail('the benchmark measured a consumer built from other tarballs than the pipeline pack');
  const missing = missingReleaseIdentity(evidence);
  if (missing.length) return fail(`docs/study-harness/evidence/performance.json lacks its ${missing.join(', ')}`);
  if (evidence.quick !== false) return fail('a --quick benchmark run (fewer samples and lifecycle cycles) is never release evidence');
  if (outcome.status === 'fail') return fail(outcome.problems.join('; '));
  if (missingRows.length) return fail(`required target rows missing from the written evidence: ${missingRows.join(', ')}`);
  if (inconsistentRows.length) return fail(`written target statuses disagree with the raw measurements and current budgets: ${inconsistentRows.join(', ')}`);
  if (outcome.status === 'environment') return { status: STATUS.environment, reason: `${outcome.environmentGaps.length} spatial row(s) not run (environment): ${outcome.environmentGaps.map(item => `${item.id}: ${item.measured}`).join('; ')}`, details };
  return { status: STATUS.pass, details };
}

export async function runNative(gate, context) {
  const { pack, options, logDir } = context;
  const logFile = path.join(logDir, 'native.log');
  const record = { commands: [] };
  if (options.native === 'run') {
    const log = createWriteStream(logFile);
    const argv = ['node', 'scripts/study-harness/native-conformance.mjs', '--install-existing'];
    record.commands.push(argv.join(' '));
    const result = await runSegment({ argv, env: { ...process.env, NO_COLOR: '1' }, cwd: ROOT, log, label: argv.join(' ') });
    await new Promise(resolve => log.end(resolve));
    record.segments = [{ command: argv.join(' '), runner: 'other', exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut, durationMs: result.durationMs }];
    record.log = path.relative(ROOT, logFile);
    const evidence = readJson(path.join(EVIDENCE, 'native-conformance.json'));
    if (!fresh(evidence, context.gateStart, 'generatedAt')) return { ...record, status: STATUS.fail, reason: `the conformance run wrote no new evidence (exit ${result.exitCode})` };
  } else {
    record.commands.push('verify recorded evidence: docs/study-harness/evidence/native-conformance.json, examples/study-harness-tauri/packed-artifacts.json');
  }
  const evidence = readJson(path.join(EVIDENCE, 'native-conformance.json'));
  const packedArtifacts = readJson(path.join(ROOT, 'examples/study-harness-tauri/packed-artifacts.json'));
  const binaries = evidence?.binaries ? Object.fromEntries(Object.entries(evidence.binaries).map(([kind, item]) => {
    const file = item?.executable ? path.join(ROOT, item.executable) : null;
    const present = !!file && existsSync(file);
    return [kind, { executable: item?.executable ?? null, recorded: item?.sha256 ?? null, present, matches: present ? sha256Hex(readFileSync(file)) === item.sha256 : null }];
  })) : null;
  return { ...record, mode: options.native, ...evaluateNativeEvidence({ evidence, packedArtifacts, pack: pack.packages, binaries, sources: hostSourceDigest(ROOT) }) };
}

export function claims(status, environment) {
  const open = (requirement, gate, note) => ({ established: false, requirement, externalGate: gate, note });
  return {
    engineeringGates: status === 'pass'
      ? `Every automated gate passed for the tarball sha256 set above on ${environment.platform.os.name} ${environment.platform.os.version ?? ''} ${environment.platform.arch}.`.replace(/\s+/g, ' ')
      : `Not established by this run (overall status: ${status}).`,
    actualStudyHarnessIntegration: open('A54', 'G2', 'Not established by this pipeline: the reference host and fixture hosts are conformance fixtures, not the Study Harness application.'),
    realAgentTrial: open('A57', 'G3', 'Not established by this pipeline: scripted tool sequences are protocol evidence, not a configured host-agent trial.'),
    manualAssistiveTechnology: open('A37', 'G1', 'Not established by this pipeline: automated accessibility checks do not substitute for manual sessions.'),
    otherPlatforms: open('A53', 'G5', `Packaged evidence, where present, covers this macOS machine only; Windows and Linux packaged runs are not established.`),
    independentSubjectReview: open(null, 'G4', 'Not established: review packets are prepared, not reviewed.'),
    learningEfficacy: open(null, 'G6', 'Not established: an application-level research outcome, outside engineering completion.'),
    publication: { npm: false, signed: false, notarized: false, deployed: false },
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const { selected, partial } = selectSteps(options);
  const started = Date.now();
  const runId = stamp(new Date(started));
  const logDir = path.join(OUT, 'logs', runId);
  mkdirSync(logDir, { recursive: true });
  const scripts = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts ?? {};
  const environment = { tools: toolVersions(ROOT), platform: platformIdentity(), browsers: await browserEnvironment(), consoleLocked: consoleLocked() };
  const say = text => console.log(`[release-pipeline] ${text}`);
  say(`run ${runId}${partial ? ' (PARTIAL: not release evidence)' : ''}; logs in ${path.relative(ROOT, logDir)}`);
  const results = new Map();

  // 1. Pack once.
  let pack = null;
  const packRecord = { id: 'pack', label: 'pack the six packages once (scripts/study-harness/pack.mjs)', commands: ['node scripts/study-harness/pack.mjs'] };
  if (!selected.has('pack')) Object.assign(packRecord, { status: STATUS.excluded, reason: options.only ? 'not selected by --only' : 'excluded by --skip' });
  else {
    const gateStart = Date.now();
    const log = createWriteStream(path.join(logDir, 'pack.log'));
    const result = await runSegment({ argv: ['node', 'scripts/study-harness/pack.mjs'], env: { ...process.env, NO_COLOR: '1' }, cwd: ROOT, log, label: 'node scripts/study-harness/pack.mjs' });
    await new Promise(resolve => log.end(resolve));
    const bytes = existsSync(PACK_MANIFEST) ? readFileSync(PACK_MANIFEST) : null;
    const manifest = bytes ? JSON.parse(bytes.toString('utf8')) : null;
    Object.assign(packRecord, { durationMs: result.durationMs, log: path.relative(ROOT, path.join(logDir, 'pack.log')), startedAt: new Date(gateStart).toISOString() });
    if (result.exitCode !== 0 || !manifest || !fresh(manifest, gateStart) || manifest.complete !== true) Object.assign(packRecord, { status: STATUS.fail, reason: result.exitCode !== 0 ? `pack.mjs exited with ${result.exitCode}` : 'pack.mjs did not write a complete, fresh manifest' });
    else {
      pack = { manifest: path.relative(ROOT, PACK_MANIFEST), manifestSha256: sha256Hex(bytes), complete: manifest.complete, createdAt: manifest.createdAt, source: manifest.source, lockSha256: manifest.lockSha256, packages: manifest.packages.map(({ name, version, file, sha256, integrity, bytes: size }) => ({ name, version, file, sha256, integrity, bytes: size })) };
      Object.assign(packRecord, { status: STATUS.pass, manifestSha256: pack.manifestSha256 });
    }
  }
  results.set('pack', packRecord);
  say(`pack: ${packRecord.status}${packRecord.reason ? ` — ${packRecord.reason}` : ''}`);

  // 2. Gates.
  for (const gate of GATES) {
    const base = { id: gate.id, label: gate.label, pack: pack?.manifestSha256 ?? null };
    let record;
    const missing = (gate.requires ?? []).map(requirement => missingRequirement(requirement, environment)).filter(Boolean);
    const blockedBy = (gate.needs ?? []).filter(id => results.get(id)?.status !== STATUS.pass);
    if (!selected.has(gate.id)) record = { ...base, status: STATUS.excluded, reason: options.only ? 'not selected by --only' : 'excluded by --skip' };
    else if (missing.length) record = { ...base, status: STATUS.environment, reason: missing.join('; ') };
    else if (blockedBy.length) record = { ...base, status: STATUS.blocked, reason: `requires ${blockedBy.join(', ')} to pass in this run (${blockedBy.map(id => `${id}: ${results.get(id)?.status ?? 'not run'}`).join('; ')})` };
    else {
      const gateStart = Date.now();
      say(`${gate.id}: running`);
      const context = { scripts, logDir, pack, options, run: { gateStart }, gateStart };
      const outcome = gate.id === 'native' ? await runNative(gate, context) : afterGate(gate, await runCommandGate(gate, context), { pack, gateStart, browsers: environment.browsers });
      record = { ...base, ...outcome, durationMs: Date.now() - gateStart, startedAt: new Date(gateStart).toISOString() };
    }
    results.set(gate.id, record);
    const counts = record.counts ? ` (${record.counts.passed}/${record.counts.total} passed${record.counts.failed ? `, ${record.counts.failed} failed` : ''})` : '';
    say(`${gate.id}: ${record.status}${counts}${record.reason ? ` — ${record.reason}` : ''}`);
  }

  // 3. Record.
  const gates = [...results.values()];
  const status = overallStatus(gates, partial);
  const verification = {
    schema: SCHEMA, runId, generatedAt: new Date().toISOString(), startedAt: new Date(started).toISOString(), durationMs: Date.now() - started,
    command: ['node scripts/study-harness/release-pipeline.mjs', ...argv].join(' '),
    status, partial, releaseEvidence: status === 'pass',
    selection: { only: options.only, skip: options.skip, native: options.native, allowEnvironmentGaps: options.allowEnvironmentGaps },
    source: sourceIdentity(ROOT), packageLock: lockIdentity(ROOT),
    tools: environment.tools, browsers: environment.browsers, platform: environment.platform, consoleLocked: environment.consoleLocked,
    pack: pack ?? { status: packRecord.status, reason: packRecord.reason ?? null },
    summary: summarize(gates), gates,
    claims: claims(status, environment),
    logs: path.relative(ROOT, logDir),
  };
  writeFileSync(path.join(OUT, 'verification.json'), `${JSON.stringify(verification, null, 2)}\n`);
  const history = writeHistoryRecord(OUT, 'verification', verification, { identity: {} });
  const durable = partial ? null : writeHistoryRecord(EVIDENCE, 'verification', verification, { identity: {} });
  say(`overall: ${status}${partial ? ' (partial run; not release evidence)' : ''}; ${path.relative(ROOT, path.join(OUT, 'verification.json'))}; history ${path.relative(ROOT, history)}${durable ? `, ${path.relative(ROOT, durable)}` : ''}`);
  return { verification, exitCode: status === 'fail' ? 1 : status === 'incomplete' && !options.allowEnvironmentGaps ? 2 : 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { const { exitCode } = await main(); process.exitCode = exitCode; }
  catch (error) { console.error(`[release-pipeline] ${error.message}`); process.exitCode = 1; }
}
