#!/usr/bin/env node
// Packaged conformance runner for the Study Harness reference host (macOS; report §17, A23, A26, A48, A51–A53).
//
//   node scripts/conformance.mjs [--no-build] [--only=release,offline,restart,crash,restore,hostport-kit,templates,performance] [--timeout=150] [--keep] [--no-evidence] [--evidence-dir=<dir>]
//   node scripts/conformance.mjs --display-only [--timeout=150] [--keep] [--evidence-dir=<dir>]
//
// The scenario chains (and so the --only names) are listed in scenarios.mjs; an unknown --only name is refused. A run
// that is not the full set is recorded as mode "partial" and never satisfies the release pipeline's native gate, which
// requires every scenario of a full run (scenarios.mjs REQUIRED_SCENARIOS).
//
// Each build writes a build record next to its .app (build-record.mjs): the executable sha256, the installed tarballs
// (packed-artifacts.json) the frontend was bundled from, the frontend dist digest and the reference host sources
// (HOST_SOURCE_INPUTS, one sha256 per file, taken before and after `tauri build`; a build during which they changed is
// refused); the evidence's `builds` carries it. --no-build and --display-only refuse to run unless both records still
// describe the existing apps, the currently installed tarballs, the current dist and the current sources. Every run
// records the sources again when it ends (`sources` in the evidence): sources that changed while it ran fail the run.
// --no-build cannot include the release chain: that chain needs both build-specific generated ACL manifests, which
// are snapshotted only during a build. The shared src-tauri/gen/schemas holds just the last build and cannot prove both.
//
// --display-only re-runs only the scenario chains that hold display-dependent checks (offline, restart, crash:*, templates, performance) against
// the ALREADY BUILT apps, and merges their results into the existing evidence. It refuses to start unless both
// executables have exactly the sha256 recorded in that evidence (otherwise run the full suite) and the macOS console
// session is unlocked. Release and restore results are kept from the run that produced them; every scenario records
// the run it came from.
//
// 1. Builds two packaged apps with `tauri build --bundles app --no-sign` (never signed, notarized or published):
//    the RELEASE app (production commands, `vite --mode production`) and a separate CONFORMANCE app
//    (`--features conformance`, `vite --mode conformance`, `--config src-tauri/tauri.conformance.conf.json`, its own
//    CARGO_TARGET_DIR). Snapshots of the generated ACL (`src-tauri/gen/schemas`) are kept per build.
// 2. Runs scenario chains by launching the packaged binary with SH_SCENARIO / SH_PHASE / SH_CRASH_AT / SH_REPORT_OUT
//    and HOME pointing at a fresh directory per chain (Tauri's app-data directory follows HOME on macOS), with bounded
//    waits, SIGKILL as "terminate the process" and SIGTERM→SIGKILL on timeout. `lsof` samples the process's sockets.
//    Host records are read from the SQLite store with the system `sqlite3` CLI after (and between) processes.
//    The console lock state (`ioreg` CGSSessionScreenIsLocked and IOConsoleLocked) is sampled before each launch and while it runs, and
//    recorded with the launch and with every display-dependent check: WebKit reports a window hidden while the session
//    is locked, and such checks are then "not run (environment)", never passed.
// 3. The `performance` chain measures the report §18 targets that apply to a host inside the packaged WKWebView (R22):
//    input feedback, 2D preview frame rate, commit → visible frame (journal acknowledgement by the Rust host reported
//    separately), suspension, the 100-cycle lifecycle stress and each spatial activity's orbit input, judged against
//    docs/study-harness/budgets.json with nearest-rank p50/p95 and sample counts, with the machine's load average.
// 4. Writes docs/study-harness/evidence/native-conformance.{json,md} and copies card captures next to them.
import { execFile, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, loadavg, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { compactNativeEvidence, sourceIdentity, writeHistoryRecord } from '../../../scripts/study-harness/evidence-identity.mjs';
import { HOST_SOURCE_INPUTS, buildRecordPath, changeList, createBuildRecord, hostSourceDigest, noBuildProblems, readBuildRecord, sourceChanges, treeDigest, writeBuildRecord } from './build-record.mjs';
import { CRASH_POINTS, DISPLAY_SCENARIOS, SCENARIO_CHAINS, parseOnly } from './scenarios.mjs';
import { judgePerformance, loadTargets } from './performance-targets.mjs';
import { validArchivalRecord } from './conformance-checks.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(appRoot, '../..');
const tauriDir = path.join(appRoot, 'src-tauri');
const argvEarly = process.argv.slice(2);
const evidenceDir = path.resolve(argvEarly.find((item) => item.startsWith('--evidence-dir='))?.slice(15) ?? path.join(repoRoot, 'docs/study-harness/evidence'));
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name, fallback) => argv.find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
// Scenario chains, crash points and the display-dependent chains live in scenarios.mjs, shared with the release
// pipeline's native gate: a chain added there is required of every full run's evidence. Unknown --only names are refused.
const ALL = SCENARIO_CHAINS;
const displayOnly = flag('--display-only');
const only = displayOnly ? DISPLAY_SCENARIOS : parseOnly(option('--only', ALL.join(','))).chains;
if (flag('--no-build') && only.includes('release')) {
  console.error('[conformance] --no-build cannot include the release chain: its ACL checks require snapshots from both builds, while src-tauri/gen/schemas describes only the last build. Run without --no-build to rebuild both apps, or select a partial --only list without release. Nothing was run or written.');
  process.exit(2);
}
const timeoutMs = Number(option('--timeout', '150')) * 1000;
const work = mkdtempSync(path.join(tmpdir(), 'sh-reference-conformance-'));
const LAUNCH_ARGS = ['-ApplePersistenceIgnoreState', 'YES'];
const PRODUCTION_COMMANDS = [
  'get_policy', 'register_activity', 'request_stage_transition', 'record_exposure_intent', 'record_display_ack', 'record_assistance', 'append_events',
  'get_journal_cursor', 'save_artifact', 'get_activity_records', 'load_latest_artifact', 'list_activity', 'delete_activity', 'open_activity', 'authorize_reveal',
  'start_independent_task', 'reopen_instructional', 'record_response', 'confirm_response', 'get_response_snapshot', 'export_backup', 'list_importable_backups', 'import_backup',
  'host_status',
];
const CONFORMANCE_COMMANDS = ['conformance_scenario', 'conformance_report', 'conformance_capture', 'conformance_exit', 'conformance_window', 'conformance_arm', 'conformance_fault',
  'conformance_reopen_store', 'conformance_withdraw_approval', 'conformance_ungranted'];
/** Strings that must not appear in the release binary (test commands, environment inputs, crash points, permissions). */
const RELEASE_FORBIDDEN = [...CONFORMANCE_COMMANDS, 'allow-conformance', 'SH_CRASH_AT', 'SH_REPORT_OUT', 'SH_SCENARIO', ...CRASH_POINTS, 'std::process::abort()'];
const BUILDS = {
  conformance: {
    targetDir: path.join(tauriDir, 'target/conformance'), product: 'StudyHarnessReferenceConformance', identifier: 'dev.explorablemodels.studyharness.reference.conformance',
    args: ['--features', 'conformance', '--config', 'src-tauri/tauri.conformance.conf.json'], dist: path.join(appRoot, '.conformance-out/dist'),
  },
  release: { targetDir: path.join(tauriDir, 'target'), product: 'StudyHarnessReference', identifier: 'dev.explorablemodels.studyharness.reference', args: [], dist: path.join(appRoot, 'dist') },
};
const home = homedir();
const redact = (value) => {
  if (typeof value === 'string') return value.split(work).join('<work>').split(home).join('~');
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
  return value;
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** Source identity passed to the conformance binary for the HostPort kit's result record (bounded SH_* inputs). */
const source = sourceIdentity(repoRoot);
const osVersion = spawnSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).stdout?.trim() || 'unknown';
const IDENTITY_ENV = { SH_SOURCE_COMMIT: source.commit ?? '', SH_SOURCE_DIRTY: source.dirty === false ? '0' : '1', SH_OS_VERSION: osVersion };
const sha256File = (file) => sha256(readFileSync(file));
const log = (text) => console.log(`[conformance] ${text}`);
/** Canonical JSON as `canonicalJSON` in @explorable-models/core for the plain JSON the host stores (sorted keys). */
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const digest = (value) => `sha256:${sha256(canonical(value))}`;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  return { status: result.status, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() };
}
/**
 * The macOS console lock state from the IORegistry root (`CGSSessionScreenIsLocked`): true when locked, false when the
 * key is absent or `No` (unlocked), null when `ioreg` could not be read.
 */
const lockStateOf = (text) => /"CGSSessionScreenIsLocked"\s*=\s*Yes/.test(text) || /"IOConsoleLocked"\s*=\s*Yes/.test(text);
function consoleLocked() {
  const result = run('ioreg', ['-n', 'Root', '-d1']);
  return result.status === 0 ? lockStateOf(result.stdout) : null;
}
function sanitizedEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) if (/^(APPLE_|TAURI_SIGNING_|CODESIGN_|SH_)/.test(key) && !(key in extra)) delete env[key];
  return env;
}
function walk(directory, files = []) {
  if (!existsSync(directory)) return files;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

// ---------------------------------------------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------------------------------------------
function appOf(build) {
  const appPath = path.join(build.targetDir, 'release/bundle/macos', `${build.product}.app`);
  const executable = path.join(appPath, 'Contents/MacOS/study-harness-reference');
  return existsSync(executable) ? { appPath, executable } : null;
}
function buildApp(kind) {
  const build = BUILDS[kind];
  const command = ['tauri', 'build', '--bundles', 'app', '--no-sign', ...build.args];
  log(`building ${kind}: npx ${command.join(' ')}`);
  const started = Date.now();
  // The build's first step regenerates the embedded policy from the installed catalogue (`npm run policy` in
  // build:web; deterministic). Run it first, so the sources read before the build are the ones the build embeds.
  const policy = spawnSync(process.execPath, [path.join(appRoot, 'scripts/generate-approved-policy.mjs')], { cwd: appRoot, stdio: 'inherit', env: sanitizedEnv() });
  if (policy.status !== 0) throw new Error(`policy generation before the ${kind} build failed with status ${policy.status}`);
  const sourcesBefore = hostSourceDigest(repoRoot);
  const result = spawnSync('npx', command, { cwd: appRoot, stdio: 'inherit', env: sanitizedEnv(kind === 'conformance' ? { CARGO_TARGET_DIR: build.targetDir } : {}) });
  if (result.status !== 0) throw new Error(`tauri build (${kind}) failed with status ${result.status}`);
  // Sources edited while cargo and vite read them leave a binary no single source state describes.
  const sources = hostSourceDigest(repoRoot);
  const changedWhileBuilding = sourceChanges(sourcesBefore, sources);
  if (changedWhileBuilding.length) throw new Error(`the reference host sources changed while the ${kind} app was built (${changeList(changedWhileBuilding)}); nothing was run, re-run when no one is editing them`);
  const snapshot = path.join(work, `gen-${kind}`);
  cpSync(path.join(tauriDir, 'gen/schemas'), snapshot, { recursive: true });
  const description = `npx ${command.join(' ')}${kind === 'conformance' ? ' (CARGO_TARGET_DIR=src-tauri/target/conformance)' : ''}`;
  // What this app embeds (build-record.mjs): the installed tarballs the frontend was bundled from and the dist itself,
  // kept next to the bundle so a later --no-build run can prove it still describes these binaries.
  const app = appOf(build);
  if (!app) throw new Error(`tauri build (${kind}) produced no ${build.product}.app`);
  const record = createBuildRecord({
    kind, command: description, builtAt: new Date().toISOString(), executable: path.relative(repoRoot, app.executable), executableSha256: sha256File(app.executable),
    packed: packedArtifacts(), dist: path.relative(repoRoot, build.dist), distDigest: treeDigest(build.dist), sources,
  });
  writeBuildRecord(buildRecordPath(build), record);
  return { ...record, durationMs: Date.now() - started, aclSnapshot: snapshot };
}

// ---------------------------------------------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------------------------------------------
function readReports(outDir) {
  const reports = {};
  for (const name of existsSync(outDir) ? readdirSync(outDir) : []) {
    if (!/^report(\.gen\d+)?\.json$/.test(name)) continue;
    try { reports[name] = JSON.parse(readFileSync(path.join(outDir, name), 'utf8')); } catch { /* written atomically; retry next poll */ }
  }
  return reports;
}

/** Launches a packaged binary; resolves when it exits (after optional termination by `killWhen`) or times out. */
function launch({ build, homeDir, outDir, scenario = null, phase = '1', crashAt = null, killWhen = () => false, limitMs = timeoutMs }) {
  const app = appOf(BUILDS[build]);
  if (!app) throw new Error(`no packaged ${build} app`);
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  const env = sanitizedEnv({ HOME: homeDir });
  if (scenario) Object.assign(env, { SH_SCENARIO: scenario, SH_PHASE: phase, SH_REPORT_OUT: path.join(outDir, 'report.json'), ...IDENTITY_ENV, ...(crashAt ? { SH_CRASH_AT: crashAt } : {}) });
  // Recorded before display-dependent work starts: a locked console makes WebKit report the window hidden.
  const consoleLock = { atLaunch: consoleLocked(), atExit: null, changes: [] };
  const started = Date.now();
  // After repeated deliberate aborts AppKit shows a modal "restore windows?" alert at the next launch
  // (NSPersistentUIRestorer crash history), which blocks startup. Every launch therefore passes the argument-domain
  // default ApplePersistenceIgnoreState=YES (as automated UI test runners do); the app itself is unchanged.
  const child = spawn(app.executable, LAUNCH_ARGS, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const collect = (chunk) => { output = (output + chunk.toString()).slice(-12_000); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const sockets = new Set();
  let samples = 0;
  const sampler = setInterval(() => {
    execFile('lsof', ['-a', '-n', '-P', '-p', String(child.pid), '-i'], { timeout: 2000 }, (_error, stdout) => {
      samples += 1;
      for (const line of String(stdout ?? '').split('\n').slice(1)) if (line.trim()) sockets.add(line.trim().replace(/\s+/g, ' '));
    });
  }, 250);
  let lastLock = consoleLock.atLaunch;
  const lockSampler = setInterval(() => {
    execFile('ioreg', ['-n', 'Root', '-d1'], { timeout: 2000 }, (error, stdout) => {
      const locked = error ? null : lockStateOf(String(stdout ?? ''));
      if (locked !== lastLock) { lastLock = locked; consoleLock.changes.push({ atMs: Date.now() - started, locked }); }
    });
  }, 1000);
  let killedByDriver = false;
  let timedOut = false;
  const poll = setInterval(() => {
    if (!killedByDriver && killWhen(readReports(outDir))) {
      killedByDriver = true;
      child.kill('SIGKILL');
    }
  }, 200);
  const limit = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 3000).unref();
  }, limitMs);
  return new Promise((resolve) => child.on('exit', (code, signal) => {
    clearInterval(sampler);
    clearInterval(lockSampler);
    clearInterval(poll);
    clearTimeout(limit);
    consoleLock.atExit = consoleLocked();
    const lines = [...sockets];
    resolve({
      build, scenario, phase, crashAt, pid: child.pid, exitCode: code, signal, killedByDriver, timedOut, elapsedMs: Date.now() - started, consoleLock,
      sockets: { samples, sockets: lines, listening: lines.filter((line) => /LISTEN/.test(line)) },
      outputTail: output.split('\n').filter(Boolean).slice(-15),
      reports: readReports(outDir),
      appData: path.join(homeDir, 'Library/Application Support', BUILDS[build].identifier),
    });
  }));
}

// ---------------------------------------------------------------------------------------------------------------
// Host records (read-only, system sqlite3)
// ---------------------------------------------------------------------------------------------------------------
function sql(appData, query) {
  const database = path.join(appData, 'reference-host.sqlite3');
  if (!existsSync(database)) return [];
  const result = run('sqlite3', ['-readonly', '-json', database, query]);
  if (result.status !== 0) throw new Error(`sqlite3 failed: ${result.stderr}`);
  return result.stdout ? JSON.parse(result.stdout) : [];
}
function records(appData) {
  const events = sql(appData, "SELECT activity_id, event_id, sequence, durable_sequence, event_digest, json_extract(event, '$.type') AS type, json_extract(event, '$.payload.scope') AS scope, json_extract(event, '$.payload.exposureId') AS exposure_id, json_extract(event, '$.payload.lost') IS NOT NULL AS has_lost FROM events ORDER BY activity_id, sequence");
  return {
    activities: sql(appData, 'SELECT activity_id, kind, stage, closed, closed_pending, activity_revision, host_session_revision, latest_backup, checkpoint_digest FROM activities ORDER BY created_at'),
    events,
    exposures: sql(appData, "SELECT exposure_id, activity_id, receipt_id, scope, display_status, json_extract(record, '$.uncertainty.code') AS uncertainty FROM exposures ORDER BY created_at, exposure_id"),
    displayAcks: sql(appData, "SELECT exposure_id, activity_id, acknowledged_at, request_digest, json_extract(request, '$.projectionDigest') AS projection_digest FROM display_acks ORDER BY acknowledged_at, exposure_id"),
    receipts: sql(appData, "SELECT receipt_id, activity_id, method, idempotency_key, json_extract(receipt, '$.grant.scope') AS scope FROM receipts ORDER BY issued_at"),
    assistance: sql(appData, 'SELECT receipt_id, activity_id, kind FROM assistance'),
    recoveries: sql(appData, 'SELECT activity_id, exposure_id, from_status, to_status, host_start, recorded_at FROM recoveries ORDER BY id'),
    responses: sql(appData, 'SELECT response_id, activity_id, kind, status FROM responses'),
    responseSnapshots: sql(appData, 'SELECT response_id, activity_id, snapshot, snapshot_digest, frozen_at FROM response_snapshots ORDER BY frozen_at, response_id')
      .map((row) => ({ ...row, snapshot: JSON.parse(row.snapshot) })),
    policies: sql(appData, "SELECT activity_id, revision, json_extract(policy, '$.independentTask.active') AS independent FROM policies ORDER BY activity_id, revision"),
    artifacts: sql(appData, 'SELECT artifact_id, activity_id, kind, artifact_digest, blob_sha256, operation_id FROM artifacts ORDER BY seq'),
    blobs: sql(appData, 'SELECT sha256, size, hex(sha256) IS NOT NULL AS present FROM blobs ORDER BY sha256'),
    orphanBlobs: Number(sql(appData, 'SELECT COUNT(*) AS n FROM blobs WHERE sha256 NOT IN (SELECT blob_sha256 FROM artifacts)')[0]?.n ?? 0),
    missingBlobs: Number(sql(appData, 'SELECT COUNT(*) AS n FROM artifacts WHERE blob_sha256 NOT IN (SELECT sha256 FROM blobs)')[0]?.n ?? 0),
    meta: Object.fromEntries(sql(appData, 'SELECT key, value FROM meta').map((row) => [row.key, row.value])),
    pragmas: { journalMode: sql(appData, 'PRAGMA journal_mode')[0]?.journal_mode ?? null },
  };
}
const eventsOf = (db, activityId) => db.events.filter((event) => event.activity_id === activityId);
/**
 * Tries to rewrite and to delete the frozen answer snapshots in a COPY of a finished process's store (the evidence store
 * is opened read-only): the store's triggers must refuse both while the response exists.
 */
function immutableInStore(appData) {
  const copy = mkdtempSync(path.join(work, 'immutable-'));
  for (const suffix of ['', '-wal', '-shm']) {
    const file = path.join(appData, `reference-host.sqlite3${suffix}`);
    if (existsSync(file)) copyFileSync(file, path.join(copy, `reference-host.sqlite3${suffix}`));
  }
  const database = path.join(copy, 'reference-host.sqlite3');
  const count = () => Number(run('sqlite3', [database, 'SELECT COUNT(*) FROM response_snapshots']).stdout);
  const before = count();
  const update = run('sqlite3', [database, "UPDATE response_snapshots SET snapshot = '{}'"]);
  const remove = run('sqlite3', [database, 'DELETE FROM response_snapshots']);
  const after = count();
  const refused = (result, text) => result.status !== 0 && result.stderr.includes(text);
  return [before === 1 && after === 1 && refused(update, 'response snapshots are immutable') && refused(remove, 'removed only with its response'),
    { snapshots: before, after, update: { status: update.status, stderr: update.stderr }, delete: { status: remove.status, stderr: remove.stderr } }];
}
const gapFree = (events) => events.every((event, index) => event.sequence === index + 1);

// ---------------------------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------------------------
class Checks {
  constructor() { this.items = []; }
  /** `display` marks a display-dependent check and records what it depended on (see {@link displayContext}). */
  add(id, ok, detail = null, { environment = false, display = null } = {}) {
    this.items.push({
      id, result: ok === null ? (environment ? 'not-run-environment' : 'not-run') : ok ? 'pass' : 'fail', detail,
      ...(display ? { displayDependent: true, displayContext: display } : {}),
    });
    return ok;
  }
  get failed() { return this.items.filter((item) => item.result === 'fail'); }
}
const stepsOk = (report) => report && report.steps.every((step) => step.ok);
const stepDetail = (report, id) => report?.steps.find((step) => step.id === id)?.detail ?? null;
const failedSteps = (report) => (report?.steps ?? []).filter((step) => !step.ok).map((step) => `${step.id}: ${step.error}`);
const visibleAtStart = (report) => report?.data?.visibilityAtStart === 'visible';
/** What a display-dependent check depended on: WebKit's visibility in that process and the console lock state around it. */
const displayContext = (launched, report) => ({
  windowVisibleAtStart: report?.data?.visibilityAtStart ?? null,
  visibilityChanges: report?.data?.visibilityChanges ?? [],
  consoleLock: launched?.consoleLock ?? null,
});

// ---------------------------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------------------------
async function releaseScenario(builds) {
  const checks = new Checks();
  const release = appOf(BUILDS.release), conformance = appOf(BUILDS.conformance);
  const releaseBytes = readFileSync(release.executable), conformanceBytes = readFileSync(conformance.executable);
  const found = (bytes, token) => bytes.includes(Buffer.from(token));
  const presentInRelease = RELEASE_FORBIDDEN.filter((token) => found(releaseBytes, token));
  const presentInConformance = RELEASE_FORBIDDEN.filter((token) => found(conformanceBytes, token));
  checks.add('release-binary-excludes-test-endpoints', presentInRelease.length === 0, { searched: RELEASE_FORBIDDEN, presentInRelease });
  checks.add('strings-check-positive-control', presentInConformance.length >= CONFORMANCE_COMMANDS.length + CRASH_POINTS.length, { presentInConformance });
  const productionInRelease = PRODUCTION_COMMANDS.filter((command) => found(releaseBytes, command));
  checks.add('release-binary-registers-production-commands', productionInRelease.length === PRODUCTION_COMMANDS.length, { missing: PRODUCTION_COMMANDS.filter((command) => !productionInRelease.includes(command)) });

  const acl = (kind) => {
    const snapshot = builds[kind]?.aclSnapshot;
    if (!snapshot) throw new Error(`release ACL checks require the ${kind} build's own snapshot; rebuild both apps without --no-build`);
    const manifests = JSON.parse(readFileSync(path.join(snapshot, 'acl-manifests.json'), 'utf8'));
    const capabilities = JSON.parse(readFileSync(path.join(snapshot, 'capabilities.json'), 'utf8'));
    return { appPermissions: Object.keys(manifests['__app-acl__']?.permissions ?? {}).sort(), capabilities };
  };
  const expectedPermissions = (commands) => commands.flatMap((command) => [`allow-${command.replaceAll('_', '-')}`, `deny-${command.replaceAll('_', '-')}`]).sort();
  const releaseAcl = acl('release'), conformanceAcl = acl('conformance');
  checks.add('release-app-manifest-production-only', isDeepStrictEqual(releaseAcl.appPermissions, expectedPermissions(PRODUCTION_COMMANDS)), { appPermissions: releaseAcl.appPermissions });
  const granted = releaseAcl.capabilities['main-window']?.permissions ?? [];
  checks.add('release-capability-grants-exactly-production-commands', Object.keys(releaseAcl.capabilities).join() === 'main-window'
    && isDeepStrictEqual([...granted].sort(), PRODUCTION_COMMANDS.map((command) => `allow-${command.replaceAll('_', '-')}`).sort()), { capabilities: Object.keys(releaseAcl.capabilities), granted });
  checks.add('conformance-app-manifest-adds-test-commands', isDeepStrictEqual(conformanceAcl.appPermissions, expectedPermissions([...PRODUCTION_COMMANDS, ...CONFORMANCE_COMMANDS])), { appPermissions: conformanceAcl.appPermissions.filter((item) => item.includes('conformance')) });
  const inline = JSON.parse(readFileSync(path.join(tauriDir, 'tauri.conformance.conf.json'), 'utf8')).app.security.capabilities.find((entry) => typeof entry === 'object');
  checks.add('conformance-capability-leaves-probe-command-ungranted', !inline.permissions.includes('allow-conformance-ungranted'), { inlineCapability: inline.identifier, permissions: inline.permissions });

  const distScan = (dist) => {
    const files = walk(dist).filter((file) => /\.(?:js|css|html)$/.test(file));
    const text = files.map((file) => readFileSync(file, 'utf8')).join('\n');
    const urls = [...new Set([...text.matchAll(/https?:\/\/[A-Za-z0-9._~:/?#@!$&'*+,;=%-]+/g)].map((match) => match[0].replace(/[`'",;)\\]+$/, '')))];
    const classify = (url) => /^http:\/\/www\.w3\.org\//.test(url) ? 'XML/SVG/MathML namespace identifier (never fetched)'
      : /^https:\/\/json-schema\.org\/draft\/2020-12\/schema/.test(url) ? 'JSON Schema $schema identifier (never fetched)'
        : /^https:\/\/explorable-models\.invalid\//.test(url) ? 'schema $id under the reserved .invalid name (never fetched)'
          : /^https:\/\/react\.dev\/errors\//.test(url) ? 'React production error-message text (never fetched)'
            : /^https:\/\/explorable-models\.dev\/schema\//.test(url) ? 'JSON Schema $id of the host conformance result template (identifier, never fetched; conformance build only)'
              : url === 'https://jcgt.org/published/0007/04/01/' ? 'literature citation in a Three.js GLSL shader comment inside the lazy 3D chunk (never fetched)'
                : /^https:\/\/remote\.invalid\//.test(url) ? 'deliberate CSP negative probe (reserved .invalid name; conformance build only)'
                  : 'UNEXPECTED';
    return { files: files.length, runner: files.some((file) => /runner-|probe-worker-/.test(path.basename(file))) || text.includes('conformance_scenario'), urls: urls.map((url) => ({ url, classification: classify(url) })) };
  };
  const releaseDist = distScan(BUILDS.release.dist), conformanceDist = distScan(BUILDS.conformance.dist);
  checks.add('release-frontend-excludes-runner', !releaseDist.runner && conformanceDist.runner, { releaseRunner: releaseDist.runner, conformanceRunner: conformanceDist.runner });
  checks.add('frontend-remote-references-are-identifiers-only', [...releaseDist.urls, ...conformanceDist.urls].every((item) => item.classification !== 'UNEXPECTED'), { release: releaseDist.urls, conformance: conformanceDist.urls });

  // Launch the release binary briefly: it starts offline, creates its store and opens no socket.
  const homeDir = path.join(work, 'release/home');
  const launched = await launch({ build: 'release', homeDir, outDir: path.join(work, 'release/out'), limitMs: 9000 });
  const db = records(launched.appData);
  checks.add('release-binary-starts-and-opens-store', db.meta.starts === '1' && db.pragmas.journalMode === 'wal', { meta: db.meta, pragmas: db.pragmas, terminatedAfterMs: launched.elapsedMs, signal: launched.signal });
  checks.add('release-binary-no-sockets', launched.sockets.samples > 5 && launched.sockets.sockets.length === 0, launched.sockets);
  checks.add('release-binary-reads-no-scenario-input', !existsSync(path.join(work, 'release/out/report.json')), { note: 'launched with SH_* removed; release code has no SH_* input to read' });
  return { checks: checks.items, distScan: { release: releaseDist, conformance: conformanceDist }, releaseLaunch: launched, acl: { release: releaseAcl, conformance: { appPermissions: conformanceAcl.appPermissions, fileCapabilities: Object.keys(conformanceAcl.capabilities), inlineCapability: inline } } };
}

async function offlineScenario() {
  const checks = new Checks();
  const outDir = path.join(work, 'offline/out');
  const launched = await launch({ build: 'conformance', homeDir: path.join(work, 'offline/home'), outDir, scenario: 'offline' });
  const first = launched.reports['report.json'], second = launched.reports['report.gen2.json'];
  checks.add('runner-completed', launched.exitCode === 0 && second?.status === 'complete' && !launched.timedOut, { exitCode: launched.exitCode, signal: launched.signal, timedOut: launched.timedOut, status: [first?.status, second?.status], failedSteps: [...failedSteps(first), ...failedSteps(second)] });
  const probes = new Map([...(first?.probes ?? []), ...(second?.probes ?? []).map((item) => ({ ...item, id: `${item.id}@reopened` }))].map((item) => [item.id, item]));
  const visible = visibleAtStart(first);
  const expect = (id, status, { needsVisible = false } = {}) => {
    const item = probes.get(id);
    const display = needsVisible ? displayContext(launched, id.endsWith('@reopened') ? second : first) : null;
    if (needsVisible && !visible && item?.status !== status) return checks.add(`probe:${id}`, null, item ?? null, { environment: true, display });
    return checks.add(`probe:${id}`, item?.status === status, item ?? null, { display });
  };
  for (const id of ['csp-effective', 'web-crypto-main', 'module-worker', 'resource-origins', 'resource-origins@reopened']) expect(id, 'pass');
  for (const id of ['katex-in-card', 'katex-in-card@reopened', 'explore-capture-svg', 'explore-capture-png']) expect(id, 'pass', { needsVisible: true });
  for (const id of ['eval-negative', 'worker-eval-negative', 'inline-style-attr-negative', 'data-image-negative', 'blob-worker-negative', 'remote-connect-negative',
    'ipc-json-object-body-refused', 'ipc-oversized-body-refused', 'ipc-malformed-json-refused', 'ipc-schema-error-is-stable', 'ipc-unknown-activity', 'ipc-unapproved-template',
    'ipc-path-like-input-refused', 'ipc-host-port-refusal-recognized', 'ipc-host-port-schema-refusal-recognized', 'ipc-unknown-response-snapshot',
    'acl-ungranted-command-rejected', 'acl-plugin-command-rejected', 'acl-path-plugin-rejected']) expect(id, 'expected-block');
  const lifecycle = probes.get('window-hide-show-suspends');
  checks.add('window-hide-show-suspends-and-resumes-without-catch-up', visible ? lifecycle?.status === 'pass' : null, lifecycle ?? null, { environment: !visible, display: displayContext(launched, first) });
  checks.add('window-close-reopen-restores-activity', second?.status === 'complete' && stepDetail(second, 'window-reopened')?.activityId === first?.data?.activityId, stepDetail(second, 'window-reopened'));
  checks.add('ungranted-command-never-executed', first?.data?.ungrantedExecuted === false, { ungrantedExecuted: first?.data?.ungrantedExecuted });
  const negativeKeys = new Set((first?.data?.negativeProbeViolations ?? []).map((item) => `${item.atMs}|${item.blockedURI}|${item.effectiveDirective}`));
  const unexpected = [...(first?.csp?.violations ?? []).filter((item) => !negativeKeys.has(`${item.atMs}|${item.blockedURI}|${item.effectiveDirective}`)), ...(second?.csp?.violations ?? [])];
  checks.add('csp-violations-only-from-intended-negative-probes', unexpected.length === 0 && negativeKeys.size === 5, { intended: [...negativeKeys], unexpected });
  // tauri://localhost serves the bundle; ipc://localhost is Tauri's custom-protocol IPC; remote.invalid is the negative probe.
  const remoteRequests = [...(first?.csp?.requests ?? []), ...(second?.csp?.requests ?? [])].filter((request) => !['tauri://localhost', 'ipc://localhost', 'https://remote.invalid'].includes(request.origin));
  checks.add('app-request-log-same-origin-only', remoteRequests.length === 0, { requests: (first?.csp?.requests?.length ?? 0) + (second?.csp?.requests?.length ?? 0), remoteRequests });
  checks.add('no-process-sockets', launched.sockets.samples > 10 && launched.sockets.sockets.length === 0, launched.sockets);
  return { checks: checks.items, launch: launched, captures: path.join(outDir, 'captures'), csp: probes.get('csp-effective')?.details ?? null, environmentProbe: probes.get('environment')?.details ?? null };
}

async function restartScenario() {
  const checks = new Checks();
  const homeDir = path.join(work, 'restart/home');
  const phases = [];
  const terminateAt = (reports) => ['awaiting-termination', 'failed'].includes(reports['report.json']?.status);
  const p1 = await launch({ build: 'conformance', homeDir, outDir: path.join(work, 'restart/p1'), scenario: 'restart', phase: '1', killWhen: terminateAt });
  phases.push(p1);
  const r1 = p1.reports['report.json'];
  const db1 = records(p1.appData);
  checks.add('phase1-sequence', r1?.status === 'awaiting-termination' && stepsOk(r1) && p1.killedByDriver && p1.signal === 'SIGKILL', { status: r1?.status, failed: failedSteps(r1), killedBy: p1.signal });
  // The card area shows the placeholder (`empty` with nothing open, `preparing` while the activity is prepared) before
  // the surface replaces it (report §10.4; mountStudyActivityPlaceholder).
  const states1 = (r1?.data?.cardStates ?? []).map((item) => item.state);
  const order = (states, ...wanted) => { let at = -1; return wanted.every((state) => (at = states.indexOf(state, at + 1)) >= 0); };
  /** The first surface appears only after a placeholder in `preparing` (nothing of the card before it). */
  const preparedFirst = (states) => states.indexOf('surface') > 0 && states.slice(0, states.indexOf('surface')).every((state) => state === 'empty' || state === 'preparing')
    && states[states.indexOf('surface') - 1] === 'preparing';
  checks.add('placeholder-before-the-card', order(states1, 'empty', 'preparing', 'surface') && preparedFirst(states1), { cardStates: r1?.data?.cardStates ?? null });
  if (r1?.status !== 'awaiting-termination') return { checks: checks.items, phases, db: { db1 } };
  const p2 = await launch({ build: 'conformance', homeDir, outDir: path.join(work, 'restart/p2'), scenario: 'restart', phase: '2', killWhen: terminateAt });
  phases.push(p2);
  const r2 = p2.reports['report.json'];
  const db2 = records(p2.appData);
  checks.add('phase2-sequence', r2?.status === 'awaiting-termination' && stepsOk(r2) && p2.signal === 'SIGKILL', { status: r2?.status, failed: failedSteps(r2) });
  // The relaunch restores the open activity at startup: `preparing` is shown until the restored surface replaces it.
  checks.add('placeholder-while-restoring', preparedFirst((r2?.data?.cardStates ?? []).map((item) => item.state)), { cardStates: r2?.data?.cardStates ?? null });
  const before = r1.data.before, after = r2?.data?.after;
  if (after) {
    checks.add('restored-same-activity', after.activityId === before.activityId, { before: before.activityId, after: after.activityId });
    checks.add('restored-exact-scientific-parameters', isDeepStrictEqual(after.scientific?.params, before.scientific?.params), { before: before.scientific?.params, after: after.scientific?.params });
    checks.add('restored-exact-position', isDeepStrictEqual(after.scientific?.position, before.scientific?.position), { before: before.scientific?.position, after: after.scientific?.position });
    checks.add('restored-run-provenance', after.scientific?.restoredFrom === before.scientific?.runId, { beforeRunId: before.scientific?.runId, restoredFrom: after.scientific?.restoredFrom });
    checks.add('restored-stage-and-revisions', after.stage === before.stage && after.guards?.activityRevision === before.guards?.activityRevision && after.guards?.policyRevision === before.guards?.policyRevision,
      { before: [before.stage, before.guards?.activityRevision, before.guards?.policyRevision], after: [after.stage, after.guards?.activityRevision, after.guards?.policyRevision] });
    const hidden1 = !visibleAtStart(r1), hidden2 = !visibleAtStart(r2);
    checks.add('exploration-commit-and-navigation-before-save', hidden1 ? null : !!stepDetail(r1, 'exploration-commit') && !!stepDetail(r1, 'navigate-index-3'),
      { exploration: stepDetail(r1, 'exploration-commit'), navigation: stepDetail(r1, 'navigate-index-3'), skippedWhileHidden: r1.data.skippedWhileHidden ?? null },
      { environment: hidden1, display: displayContext(p1, r1) });
    const cameraSet = before.projection?.camera !== null && before.projection?.camera !== undefined;
    checks.add('restored-permitted-presentation-camera', !cameraSet && hidden1 ? null : cameraSet && isDeepStrictEqual(after.projection?.camera, before.projection?.camera),
      { before: before.projection?.camera, after: after.projection?.camera, cameraWhileHidden: r1.data.cameraWhileHidden ?? null }, { environment: !cameraSet && hidden1, display: displayContext(p1, r1) });
    checks.add('restored-paused', after.projection?.navigation?.playing === false && (r2.data.afterUi?.ui === 'restored' || (hidden2 && r2.data.afterUi?.ui === 'suspended')),
      { navigation: after.projection?.navigation, ui: r2.data.afterUi, windowVisible: !hidden2 });
    checks.add('restored-visible-content-unchanged', isDeepStrictEqual(after.projection?.visibleGroups, before.projection?.visibleGroups), { before: before.projection?.visibleGroups, after: after.projection?.visibleGroups });
    const activityId = before.activityId;
    const e1 = eventsOf(db1, activityId), e2 = eventsOf(db2, activityId);
    const prefix = e2.slice(0, e1.length).map((event) => event.event_id);
    const added = e2.slice(e1.length).map((event) => event.type);
    const restoredAt = added.indexOf('artifact.restored');
    const forbidden = ['reveal.requested', 'reveal.authorized', 'reveal.displayed', 'response.submitted', 'stage.changed', 'parameters.committed'];
    checks.add('event-order-preserved-gap-free', gapFree(e1) && gapFree(e2) && isDeepStrictEqual(prefix, e1.map((event) => event.event_id)), { phase1Events: e1.length, phase2Events: e2.length });
    checks.add('restore-adds-no-reveal-or-response-events', restoredAt >= 0 && added.slice(0, restoredAt).every((type) => type === 'activity.suspended') && !added.slice(0, restoredAt + 1).some((type) => forbidden.includes(type)),
      { addedBeforeIndependentTask: added.slice(0, Math.max(restoredAt + 1, 0)) });
    const exposures1 = db1.exposures.filter((record) => record.activity_id === activityId), exposures2 = db2.exposures.filter((record) => record.activity_id === activityId);
    const conservative = exposures1.every((record) => {
      const later = exposures2.find((item) => item.exposure_id === record.exposure_id);
      if (record.display_status === 'displayed') return later?.display_status === 'displayed';
      if (record.display_status === 'authorized') return later?.display_status === 'uncertain' && later.uncertainty === 'INTERRUPTED_BEFORE_ACK' && db2.recoveries.some((item) => item.exposure_id === record.exposure_id);
      return later?.display_status === record.display_status;
    });
    checks.add('conservative-exposure-history', conservative && exposures2.length === exposures1.length && !exposures2.some((record) => record.display_status === 'not-displayed'),
      { phase1: exposures1.map((record) => [record.scope, record.display_status]), phase2: exposures2.map((record) => [record.scope, record.display_status, record.uncertainty]), recoveries: db2.recoveries });
    const reveal1 = exposures1.find((record) => record.scope === 'reveal');
    checks.add('reveal-display-acknowledged-before-termination', visibleAtStart(r1) ? reveal1?.display_status === 'displayed' : null, { reveal: reveal1 ?? null, windowVisible: visibleAtStart(r1) },
      { environment: !visibleAtStart(r1), display: displayContext(p1, r1) });
    const task = stepDetail(r2, 'independent-task');
    const approved = JSON.parse(readFileSync(path.join(tauriDir, 'policy/approved.json'), 'utf8')).templates.find((entry) => entry.template.templateId === 'quadratic-gradient-descent');
    checks.add('independent-task-teaching-visual-unavailable', !!task && isDeepStrictEqual(task.views, ['rules']) && task.traceFigureInDom === false && task.landscapeInDom === false && task.controls.length === 0
      && task.visibleGroups.every((group) => approved.neutralScaffold.includes(group)), task);
    const taskActivity = db2.activities.find((item) => item.kind === 'independent-task');
    checks.add('independent-task-host-policy', !!taskActivity && db2.policies.filter((policy) => policy.activity_id === taskActivity.activity_id).every((policy) => policy.independent === 1), { taskActivity, policies: db2.policies.filter((policy) => policy.activity_id === taskActivity?.activity_id) });
    // A26: the answer is submitted together with its frozen assistance/exposure snapshot, stored by the host.
    const answer = db2.responses.find((row) => row.activity_id === taskActivity?.activity_id && row.kind === 'answer');
    const frozen = db2.responseSnapshots.find((row) => row.response_id === answer?.response_id);
    const inspected = r2.data?.answerSnapshot;
    checks.add('answer-submitted-with-frozen-assistance-snapshot', !!answer && answer.status === 'submitted' && !!frozen && frozen.snapshot_digest === digest(frozen.snapshot)
      && frozen.snapshot.adapter?.responseId === answer.response_id && frozen.snapshot.host?.independentTaskActive === true && inspected?.snapshotDigest === frozen.snapshot_digest
      && frozen.snapshot.host.origin?.activityId === before.activityId,
    { answer, snapshotDigest: frozen?.snapshot_digest ?? null, digestVerified: frozen ? frozen.snapshot_digest === digest(frozen.snapshot) : null, inspectedDigest: inspected?.snapshotDigest ?? null,
      adapter: frozen ? { cursor: frozen.snapshot.adapter.cursor, exposures: frozen.snapshot.adapter.exposures.length, assistance: frozen.snapshot.adapter.assistance.length } : null,
      host: frozen ? { assistance: frozen.snapshot.host.assistance.length, origin: frozen.snapshot.host.origin } : null });
  }
  if (r2?.status !== 'awaiting-termination') return { checks: checks.items, phases, db: { db1, db2 } };
  const p3 = await launch({ build: 'conformance', homeDir, outDir: path.join(work, 'restart/p3'), scenario: 'restart', phase: '3' });
  phases.push(p3);
  const r3 = p3.reports['report.json'];
  const db3 = records(p3.appData);
  checks.add('phase3-sequence', r3?.status === 'complete' && stepsOk(r3) && p3.exitCode === 0, { status: r3?.status, failed: failedSteps(r3), exitCode: p3.exitCode });
  const restoredTask = stepDetail(r3, 'task-relaunch');
  checks.add('task-relaunch-stays-independent', restoredTask?.context === 'independent' && restoredTask?.kind === 'independent-task' && isDeepStrictEqual(restoredTask?.views, ['rules']), restoredTask);
  const reopened = stepDetail(r3, 'reopen-teaching-visual-assistance');
  const assistance = db3.assistance.filter((row) => row.kind === 'reopen-instructional');
  checks.add('reopen-goes-through-host-assistance', reopened?.context === 'instructional' && assistance.length === 1, { reopened, assistance });
  // A26: assistance recorded after the answer (the reopening) leaves the snapshot frozen with the answer unchanged.
  const frozenBefore = db2.responseSnapshots, frozenAfter = db3.responseSnapshots;
  const answerSnapshot = frozenAfter[0];
  const laterAssistance = assistance.filter((row) => row.activity_id === answerSnapshot?.activity_id);
  const assistanceEvents = eventsOf(db3, answerSnapshot?.activity_id ?? '').filter((event) => event.type === 'assistance.recorded');
  checks.add('feedback-after-answer-leaves-frozen-snapshot-unchanged', frozenBefore.length === 1 && frozenAfter.length === 1 && isDeepStrictEqual(frozenAfter, frozenBefore)
    && r3?.data?.answerSnapshotAfterAssistance?.snapshotDigest === frozenBefore[0].snapshot_digest && laterAssistance.length === 1
    && !answerSnapshot.snapshot.host.assistance.some((row) => row.receiptId === laterAssistance[0].receipt_id)
    && !answerSnapshot.snapshot.adapter.assistance.some((row) => row.receiptId === laterAssistance[0].receipt_id)
    && assistanceEvents.length > 0 && assistanceEvents.every((event) => event.sequence > answerSnapshot.snapshot.adapter.cursor),
  { snapshotDigestPhase2: frozenBefore[0]?.snapshot_digest ?? null, snapshotDigestPhase3: frozenAfter[0]?.snapshot_digest ?? null, inspectedAfterAssistance: r3?.data?.answerSnapshotAfterAssistance?.snapshotDigest ?? null,
    laterAssistance, assistanceEventSequences: assistanceEvents.map((event) => event.sequence), frozenCursor: answerSnapshot?.snapshot.adapter.cursor ?? null });
  checks.add('frozen-snapshot-immutable-in-store', ...immutableInStore(p3.appData));
  const instructionalId = before.activityId;
  const all = eventsOf(db3, instructionalId);
  checks.add('no-duplicate-reveal-or-prediction-events', all.filter((event) => event.type === 'reveal.requested' && event.scope === 'reveal').length === 1 && all.filter((event) => event.type === 'response.submitted').length === 1 && gapFree(all),
    { revealRequested: all.filter((event) => event.type === 'reveal.requested').map((event) => event.scope), responses: all.filter((event) => event.type === 'response.submitted').length });
  const exported = stepDetail(r3, 'export-portable-backup');
  const exportFile = exported ? path.join(p3.appData, 'exports', exported.fileName) : null;
  checks.add('portable-backup-exported', !!exportFile && existsSync(exportFile) && sha256File(exportFile) === exported.sha256, { exported, exists: !!exportFile && existsSync(exportFile) });
  return { checks: checks.items, phases, db: { db1, db2, db3 }, exportFile, before, homeDir };
}

/** The latest backup the store holds: its exposures and journal checkpoint (read as the process left the store). */
function latestCheckpoint(appData) {
  const row = sql(appData,
    "SELECT a.artifact_id, a.artifact_digest, json_extract(CAST(b.bytes AS TEXT), '$.exposures') AS exposures, json_extract(CAST(b.bytes AS TEXT), '$.journal') AS journal FROM artifacts a JOIN blobs b ON b.sha256 = a.blob_sha256 WHERE a.kind = 'backup' ORDER BY a.seq DESC LIMIT 1")[0];
  return row ? { artifactId: row.artifact_id, artifactDigest: row.artifact_digest, exposures: JSON.parse(row.exposures ?? '[]'), journal: JSON.parse(row.journal ?? 'null') } : null;
}

/**
 * Interrupted save (G77): abort inside save_artifact before its commit; the relaunched host holds the previous
 * checkpoint, no partial row and every earlier record, restores from that checkpoint and accepts the repeated save.
 */
async function saveCrashScenario(point) {
  const checks = new Checks();
  const homeDir = path.join(work, `crash-${point}/home`);
  const p1 = await launch({ build: 'conformance', homeDir, outDir: path.join(work, `crash-${point}/p1`), scenario: 'crash', phase: '1', crashAt: point, limitMs: 150_000 });
  const r1 = p1.reports['report.json'];
  const dbCrash = records(p1.appData);
  const fired = p1.outputTail.some((line) => line.includes(`crash point ${point}`)) && (p1.signal === 'SIGABRT' || p1.exitCode === 134) && !p1.timedOut;
  checks.add('crash-point-fired', fired, { signal: p1.signal, exitCode: p1.exitCode, statusBeforeCrash: r1?.status, armed: r1?.data?.armed ?? null, failed: failedSteps(r1), outputTail: p1.outputTail.slice(-3) });
  if (!fired) return { point, checks: checks.items, phases: [p1], db: { dbCrash } };
  const activityId = r1?.data?.preCrash?.activityId;
  const activity = dbCrash.activities.find((row) => row.activity_id === activityId);
  const before = r1?.data?.cursorBeforeCrash ?? null;
  const latest = dbCrash.artifacts.filter((row) => row.activity_id === activityId && row.kind === 'backup').at(-1);
  checks.add('at-crash-no-partial-rows', !!activity && !!before && dbCrash.orphanBlobs === 0 && dbCrash.missingBlobs === 0 && activity.checkpoint_digest === before.checkpointDigest
    && latest?.artifact_digest === before.checkpointDigest && latest?.artifact_id === activity.latest_backup,
  { checkpointBeforeArm: before?.checkpointDigest ?? null, checkpointAtCrash: activity?.checkpoint_digest ?? null, latestBackup: latest ?? null, orphanBlobs: dbCrash.orphanBlobs, missingBlobs: dbCrash.missingBlobs });
  // The save point fires only when armed (`conformance_arm`, which phase 2 never calls): naming it in phase 2 routes the
  // runner to the save scenario's relaunch phase without any abort.
  const p2 = await launch({ build: 'conformance', homeDir, outDir: path.join(work, `crash-${point}/p2`), scenario: 'crash', phase: '2', crashAt: point });
  const r2 = p2.reports['report.json'];
  const dbFinal = records(p2.appData);
  checks.add('relaunch-restore-and-repeat-save', r2?.status === 'complete' && stepsOk(r2) && p2.exitCode === 0, { status: r2?.status, failed: failedSteps(r2) });
  const pre = r1?.data?.preCrash, restored = r2?.data?.restored;
  checks.add('restored-from-previous-checkpoint', !!pre && !!restored && isDeepStrictEqual(restored.scientific?.params, pre.scientific?.params) && isDeepStrictEqual(restored.scientific?.position, pre.scientific?.position)
    && r2?.data?.cursorAfterRestart?.checkpointDigest === before?.checkpointDigest,
  { before: pre?.scientific ?? null, restored: restored?.scientific ?? null, checkpointAfterRestart: r2?.data?.cursorAfterRestart?.checkpointDigest ?? null });
  const eventsAtCrash = eventsOf(dbCrash, activityId), eventsFinal = eventsOf(dbFinal, activityId);
  const exposuresAtCrash = dbCrash.exposures.filter((row) => row.activity_id === activityId);
  const rank = { 'not-displayed': 0, authorized: 1, uncertain: 2, displayed: 3 };
  checks.add('evidence-retained-across-restart', gapFree(eventsFinal) && isDeepStrictEqual(eventsFinal.slice(0, eventsAtCrash.length).map((event) => event.event_id), eventsAtCrash.map((event) => event.event_id))
    && exposuresAtCrash.every((row) => { const later = dbFinal.exposures.find((item) => item.exposure_id === row.exposure_id); return later && rank[later.display_status] >= rank[row.display_status] && later.display_status !== 'not-displayed'; }),
  { eventsAtCrash: eventsAtCrash.length, eventsFinal: eventsFinal.length, exposuresAtCrash: exposuresAtCrash.map((row) => [row.scope, row.display_status]), exposuresFinal: dbFinal.exposures.filter((row) => row.activity_id === activityId).map((row) => [row.scope, row.display_status]) });
  const finalActivity = dbFinal.activities.find((row) => row.activity_id === activityId);
  const finalLatest = dbFinal.artifacts.filter((row) => row.activity_id === activityId && row.kind === 'backup').at(-1);
  checks.add('repeated-save-committed', !!finalActivity && finalActivity.checkpoint_digest === r2?.data?.cursorFinal?.checkpointDigest && finalActivity.checkpoint_digest !== before?.checkpointDigest
    && finalLatest?.artifact_digest === finalActivity.checkpoint_digest && dbFinal.orphanBlobs === 0 && dbFinal.missingBlobs === 0,
  { checkpointFinal: finalActivity?.checkpoint_digest ?? null, latestBackup: finalLatest ?? null, orphanBlobs: dbFinal.orphanBlobs, missingBlobs: dbFinal.missingBlobs });
  return { point, checks: checks.items, phases: [p1, p2], db: { dbCrash, dbFinal } };
}

async function crashScenario(point) {
  if (point === 'save-before-commit') return saveCrashScenario(point);
  const checks = new Checks();
  const homeDir = path.join(work, `crash-${point}/home`);
  const p1 = await launch({ build: 'conformance', homeDir, outDir: path.join(work, `crash-${point}/p1`), scenario: 'crash', phase: '1', crashAt: point, limitMs: 120_000 });
  const r1 = p1.reports['report.json'];
  const dbCrash = records(p1.appData);
  // Exposure records and journal checkpoint of the last backup the crashed process saved (what the relaunched adapter
  // restores from), read from the store as the crash left it.
  const latestAtCrash = latestCheckpoint(p1.appData);
  const checkpointAtCrash = latestAtCrash?.exposures ?? [];
  // Fired = the host printed the crash-point marker and the process ended by abort (SIGABRT), not by the driver.
  const fired = p1.outputTail.some((line) => line.includes(`crash point ${point}`)) && (p1.signal === 'SIGABRT' || p1.exitCode === 134) && !p1.timedOut;
  const visible = visibleAtStart(r1);
  if (!fired) {
    const displayPoint = point === 'display-ack-before-commit';
    checks.add('crash-point-fired', displayPoint && !visible ? null : false, { status: r1?.status, signal: p1.signal, exitCode: p1.exitCode, failed: failedSteps(r1), windowVisible: visible },
      { environment: displayPoint && !visible, display: displayPoint ? displayContext(p1, r1) : null });
    return { point, checks: checks.items, phases: [p1], db: { dbCrash } };
  }
  checks.add('crash-point-fired', true, { signal: p1.signal, exitCode: p1.exitCode, statusBeforeCrash: r1?.status, outputTail: p1.outputTail.slice(-3) },
    { display: point === 'display-ack-before-commit' ? displayContext(p1, r1) : null });
  const activityId = r1?.data?.preReveal?.activityId;
  const revealAtCrash = dbCrash.exposures.filter((record) => record.activity_id === activityId && record.scope === 'reveal');
  const ackAtCrash = dbCrash.displayAcks.filter((ack) => revealAtCrash.some((record) => record.exposure_id === ack.exposure_id));
  if (point === 'intent-before-commit') checks.add('at-crash-nothing-committed', revealAtCrash.length === 0 && !dbCrash.receipts.some((receipt) => receipt.scope === 'reveal'), { revealAtCrash });
  else checks.add('at-crash-intent-committed-without-ack', revealAtCrash.length === 1 && revealAtCrash[0].display_status === 'authorized' && ackAtCrash.length === 0, { revealAtCrash, ackAtCrash });
  const p2 = await launch({ build: 'conformance', homeDir, outDir: path.join(work, `crash-${point}/p2`), scenario: 'crash', phase: '2' });
  const r2 = p2.reports['report.json'];
  const dbFinal = records(p2.appData);
  checks.add('relaunch-and-resume', r2?.status === 'complete' && stepsOk(r2) && p2.exitCode === 0, { status: r2?.status, failed: failedSteps(r2) });
  const recovered = dbFinal.recoveries.filter((item) => revealAtCrash.some((record) => record.exposure_id === item.exposure_id));
  if (point === 'intent-before-commit') {
    checks.add('honest-unseen-after-restart', recovered.length === 0 && r2?.data?.restoredTraceVisible === false, { restoredTraceVisible: r2?.data?.restoredTraceVisible, recovered });
  } else {
    checks.add(point === 'display-ack-before-commit' ? 'honest-displayed-uncertain-after-restart' : 'honest-uncertain-after-restart',
      recovered.length === 1 && recovered[0].to_status === 'uncertain' && recovered[0].host_start === 2, { recovered, restored: r2?.data?.restored?.exposures, restoredTraceVisible: r2?.data?.restoredTraceVisible });
  }
  const finalReveal = dbFinal.exposures.filter((record) => record.activity_id === activityId && record.scope === 'reveal');
  const finalReceipts = dbFinal.receipts.filter((receipt) => receipt.activity_id === activityId && receipt.scope === 'reveal');
  checks.add('one-reveal-record-and-receipt', finalReveal.length === 1 && finalReceipts.length === 1 && (point === 'intent-before-commit' || finalReveal[0].exposure_id === revealAtCrash[0].exposure_id),
    { finalReveal, finalReceipts });
  const visibleRelaunch = visibleAtStart(r2);
  // After resume the host holds the display acknowledgement next to its restart record, which is never erased. For
  // display-ack-before-commit the content was displayed before the crash and the checkpoint recorded the acknowledgement
  // as unconfirmed (ACK_NOT_PERSISTED): the restored adapter resends that same acknowledgement (the original display's
  // projection digest), committed after the restart's recoveries row (report §6.3 step 5, activity-runtime §4 steps 5–6).
  const finalAck = dbFinal.displayAcks.filter((ack) => ack.exposure_id === finalReveal[0]?.exposure_id);
  const restartRecord = point === 'intent-before-commit' ? null : recovered[0] ?? null;
  // The reveal record in the last checkpoint saved before the crash (read from the store as the crash left it).
  const checkpointRecord = checkpointAtCrash.find((record) => record.exposureId === finalReveal[0]?.exposure_id) ?? null;
  const displayedBeforeCrash = checkpointRecord ? { displayStatus: checkpointRecord.displayStatus, uncertainty: checkpointRecord.uncertainty?.code ?? null, projectionDigest: checkpointRecord.displayed?.projectionDigest ?? null } : null;
  const ackAfterRestart = finalAck.length === 1 && (!restartRecord || (restartRecord.to_status === 'uncertain' && finalAck[0].acknowledged_at >= restartRecord.recorded_at))
    // Displayed before the crash: the checkpoint must say the acknowledgement was unconfirmed, and the resent one is the original display.
    && (displayedBeforeCrash?.displayStatus !== 'displayed' || (displayedBeforeCrash.uncertainty === 'ACK_NOT_PERSISTED' && finalAck[0].projection_digest === displayedBeforeCrash.projectionDigest));
  checks.add('display-acknowledged-after-resume', visibleRelaunch ? finalReveal[0]?.display_status === 'displayed' && ackAfterRestart : null,
    { finalReveal, finalAck, restartRecord, windowVisible: visibleRelaunch, resumeStep: stepDetail(r2, 'resume-reveal'), restoredNotes: r2?.data?.restored?.restoredNotes ?? null, displayedBeforeCrash },
    { environment: !visibleRelaunch, display: displayContext(p2, r2) });
  const events = eventsOf(dbFinal, activityId);
  checks.add('no-duplicate-reveal-or-prediction-events', gapFree(events) && events.filter((event) => event.type === 'reveal.requested' && event.scope === 'reveal').length === 1 && events.filter((event) => event.type === 'response.submitted').length === 1,
    { revealRequested: events.filter((event) => event.type === 'reveal.requested').length, responses: events.filter((event) => event.type === 'response.submitted').length, events: events.length });
  // Host journal after resume (report §7.2, activity-runtime §9; re-verified for Wave 1's replay of unacknowledged
  // events): the reveal exposure has exactly one `reveal.authorized`; once displayed after the restart it has exactly one
  // `reveal.displayed` (the original display's event, recorded before the crash or replayed from the checkpoint's
  // `journal.pendingEvents`, or the resumed display's — never both, never neither); every event the checkpoint carried as
  // unacknowledged is in the host journal with its original eventId; and an unrecoverable event is never a silent gap:
  // the journal then holds the durable loss record (`operation.failed` with `lost`).
  const exposureId = finalReveal[0]?.exposure_id ?? null;
  const authorizedEvents = events.filter((event) => event.type === 'reveal.authorized' && event.exposure_id === exposureId);
  const displayedEvents = events.filter((event) => event.type === 'reveal.displayed' && event.exposure_id === exposureId);
  const carried = (latestAtCrash?.journal?.pendingEvents ?? []).map((event) => event.eventId);
  const missingCarried = carried.filter((id) => !events.some((event) => event.event_id === id));
  const lossRecords = events.filter((event) => event.type === 'operation.failed' && event.has_lost === 1);
  const lossAtCrash = !!latestAtCrash?.journal?.lost;
  const journalDetail = {
    exposureId, authorized: authorizedEvents.map((event) => event.sequence), displayed: displayedEvents.map((event) => event.sequence), carriedByCheckpoint: carried,
    missingCarried, lossRecords: lossRecords.map((event) => event.sequence), checkpointLoss: latestAtCrash?.journal?.lost ?? null, eventTypes: events.map((event) => event.type),
  };
  const complete = authorizedEvents.length === 1 && missingCarried.length === 0 && (!lossAtCrash || lossRecords.length > 0);
  checks.add('host-journal-complete-or-loss-recorded', visibleRelaunch ? complete && (displayedEvents.length === 1 || (displayedEvents.length === 0 && lossRecords.length > 0)) : null, journalDetail,
    { environment: !visibleRelaunch, display: displayContext(p2, r2) });
  return { point, checks: checks.items, phases: [p1, p2], db: { dbCrash, dbFinal } };
}

async function restoreScenario(restart) {
  const checks = new Checks();
  if (!restart?.exportFile || !existsSync(restart.exportFile)) {
    checks.add('portable-backup-available', false, { note: 'the restart chain did not export a backup' });
    return { checks: checks.items };
  }
  const backup = JSON.parse(readFileSync(restart.exportFile, 'utf8'));
  const homeDir = path.join(work, 'restore/home');
  const imports = path.join(homeDir, 'Library/Application Support', BUILDS.conformance.identifier, 'imports');
  mkdirSync(imports, { recursive: true });
  copyFileSync(restart.exportFile, path.join(imports, 'portable-backup.json'));
  // Original files unavailable: the source store, its exports and artifacts are deleted before the restore.
  rmSync(restart.homeDir, { recursive: true, force: true });
  checks.add('original-store-removed', !existsSync(restart.homeDir), { removed: restart.homeDir });
  const launched = await launch({ build: 'conformance', homeDir, outDir: path.join(work, 'restore/out'), scenario: 'restore' });
  const report = launched.reports['report.json'];
  const db = records(launched.appData);
  checks.add('restore-sequence', report?.status === 'complete' && stepsOk(report) && launched.exitCode === 0, { status: report?.status, failed: failedSteps(report) });
  for (const item of backup.activities) {
    const activityId = item.activity.activity_id;
    const stored = eventsOf(db, activityId);
    const original = item.events.map((event) => [event.event_id, event.event_digest]);
    checks.add(`journal-identity-preserved:${item.activity.kind}`, isDeepStrictEqual(stored.slice(0, original.length).map((event) => [event.event_id, event.event_digest]), original) && gapFree(stored),
      { backupEvents: original.length, storeEvents: stored.length, addedAfterImport: stored.slice(original.length).map((event) => event.type) });
    checks.add(`assistance-not-duplicated:${item.activity.kind}`, isDeepStrictEqual(db.assistance.filter((row) => row.activity_id === activityId).map((row) => row.receipt_id).sort(), item.assistance.map((row) => row.receipt_id).sort()),
      { backup: item.assistance.length, store: db.assistance.filter((row) => row.activity_id === activityId).length });
    checks.add(`receipts-preserved:${item.activity.kind}`, isDeepStrictEqual(db.receipts.filter((row) => row.activity_id === activityId).map((row) => row.receipt_id).sort(), item.receipts.map((row) => row.receipt_id).sort()), null);
    const snapshots = (rows) => rows.map((row) => [row.response_id, row.snapshot_digest]).sort((a, b) => a[0].localeCompare(b[0]));
    checks.add(`frozen-answer-snapshots-preserved:${item.activity.kind}`, isDeepStrictEqual(snapshots(db.responseSnapshots.filter((row) => row.activity_id === activityId)), snapshots(item.response_snapshots ?? []))
      && (item.activity.kind !== 'independent-task' || (item.response_snapshots ?? []).length === 1),
    { backup: (item.response_snapshots ?? []).length, store: db.responseSnapshots.filter((row) => row.activity_id === activityId).length });
  }
  checks.add('reimport-adds-nothing', stepDetail(report, 'reimport-adds-nothing')?.alreadyImported === true, stepDetail(report, 'reimport-adds-nothing'));
  const restored = report?.data?.instructional;
  checks.add('restored-scientific-state-matches-original', !!restored && isDeepStrictEqual(restored.scientific?.params, restart.before.scientific?.params) && isDeepStrictEqual(restored.scientific?.position, restart.before.scientific?.position),
    { original: restart.before.scientific, restored: restored?.scientific });
  // The restored activity is closed: its stage shows no view, so the learner projection carries no presentation for the
  // landscape view (presentation is projected for visible views only). The restored presentation snapshot (read back in a
  // backup saved after the restore) must still hold the original camera.
  const restoredCamera = report?.data?.instructionalPresentation?.views?.landscape?.camera ?? null;
  checks.add('restored-presentation-matches-original', !!restored && !!restoredCamera && isDeepStrictEqual(restoredCamera, restart.before.projection?.camera),
    { original: restart.before.projection?.camera, restoredSnapshot: restoredCamera, learnerProjection: restored?.projection?.camera ?? null, restoredStage: restored?.stage ?? null });
  checks.add('restored-exposures-never-weaker', !!restored && restored.exposures.every((record) => record.displayStatus !== 'not-displayed' && record.displayStatus !== 'authorized'), restored?.exposures ?? null);
  const archival = stepDetail(report, 'archival-record-on-withdrawn-approval');
  // Nothing evaluated and no activity control; the host's own return action (app.ts, R29) is the record's only control.
  checks.add('archival-record-on-withdrawn-approval', validArchivalRecord(archival),
  { detail: archival, failed: failedSteps(report).filter((line) => line.startsWith('archival')) });
  checks.add('no-process-sockets', launched.sockets.samples >= 3 && launched.sockets.sockets.length === 0, launched.sockets);
  return { checks: checks.items, launch: launched, db };
}

/**
 * The host-agnostic HostPort conformance kit (`@explorable-models/activity/conformance`) run in the packaged conformance app
 * against the Rust reference host (labelled `reference-fixture-host`). Its result record is checked here against the
 * docs template file (with the packed kit's checker, after confirming the kit's embedded schema equals that file) and
 * written next to the evidence.
 */
async function hostPortKitScenario() {
  const checks = new Checks();
  const outDir = path.join(work, 'hostport-kit/out');
  const launched = await launch({ build: 'conformance', homeDir: path.join(work, 'hostport-kit/home'), outDir, scenario: 'hostport-kit', limitMs: 240_000 });
  const report = launched.reports['report.json'];
  const kit = report?.data?.kit ?? null;
  checks.add('kit-ran', report?.status === 'complete' && stepsOk(report) && launched.exitCode === 0 && !!kit, { status: report?.status, failed: failedSteps(report), exitCode: launched.exitCode });
  if (!kit) return { checks: checks.items, launch: launched };
  // The record is checked here against the docs template file itself with the packed kit's checker (from the tarball
  // installed in this app), after confirming that the kit's embedded schema is exactly that template.
  const schema = JSON.parse(readFileSync(path.join(repoRoot, 'docs/study-harness/templates/host-conformance-result.schema.json'), 'utf8'));
  const packedKit = await import(pathToFileURL(path.join(appRoot, 'node_modules/@explorable-models/activity/dist/conformance/index.js')).href);
  const { schemaErrors } = await import(pathToFileURL(path.join(appRoot, 'node_modules/@explorable-models/core/dist/model/index.js')).href);
  const sameSchema = isDeepStrictEqual(JSON.parse(JSON.stringify(packedKit.HOST_CONFORMANCE_RESULT_JSON_SCHEMA)), schema);
  const templateErrors = schemaErrors(kit.result, schema);
  checks.add('kit-result-conforms-to-template', sameSchema && templateErrors.length === 0 && kit.problems.length === 0, { sameSchema, templateErrors, kitProblems: kit.problems });
  const conformance = appOf(BUILDS.conformance);
  checks.add('kit-result-identifies-this-binary', kit.result.subject === 'reference-fixture-host' && kit.result.host.binarySha256 === sha256File(conformance.executable)
    && kit.result.host.commit === source.commit && kit.result.host.dirty === (source.dirty !== false),
  { subject: kit.result.subject, binarySha256: kit.result.host.binarySha256, commit: kit.result.host.commit, dirty: kit.result.host.dirty });
  for (const [step, value] of Object.entries(kit.result.steps)) {
    const failed = (value.assertions ?? []).filter((item) => item.outcome !== 'pass');
    checks.add(`kit:${step}`, value.outcome === 'pass' ? true : value.outcome === 'fail' ? false : null, { outcome: value.outcome, reason: value.reason ?? value.environmentReason ?? null, assertions: (value.assertions ?? []).length, notPassed: failed },
      { environment: value.outcome === 'not-run (environment)' });
  }
  checks.add('kit-overall-result', kit.result.result === 'pass', { result: kit.result.result });
  // The kit run is short (about a second): at least three socket samples (every 250 ms) cover it, as in the restore scenario.
  checks.add('no-process-sockets', launched.sockets.samples >= 3 && launched.sockets.sockets.length === 0, { ...launched.sockets, elapsedMs: launched.elapsedMs });
  return { checks: checks.items, launch: launched, result: kit.result, kitChecks: kit.checks };
}

/** Dist chunks of the catalogue's kernels, and whether the catalogue worker chunk loads each by dynamic import. */
function kernelChunks(dist) {
  const assets = path.join(dist, 'assets');
  const files = existsSync(assets) ? readdirSync(assets) : [];
  const ids = ['quadratic-gradient-descent', 'function-derivative', 'linear-transformation', 'vector-orientation-3d', 'quadratic-surface-gradient'];
  const workers = files.filter((file) => /^worker-[\w-]+\.js$/.test(file)).map((file) => ({ file, text: readFileSync(path.join(assets, file), 'utf8') }));
  return ids.map((id) => {
    const chunk = files.find((file) => file.startsWith(`${id}-`) && file.endsWith('.js')) ?? null;
    const importer = chunk ? workers.find((worker) => worker.text.includes(chunk))?.file ?? null : null;
    return { kernel: id, chunk, importedByWorkerChunk: importer };
  });
}

/**
 * Every installed template opened through the host (kernels evaluated in the catalogue worker, each loaded by its own
 * same-origin dynamic import under the production and worker CSPs), and the two spatial templates rendered by the packed
 * player-3d chunk in WKWebView with frames counted and resources released.
 */
async function templatesScenario() {
  const checks = new Checks();
  const outDir = path.join(work, 'templates/out');
  const launched = await launch({ build: 'conformance', homeDir: path.join(work, 'templates/home'), outDir, scenario: 'templates', limitMs: 180_000 });
  const report = launched.reports['report.json'];
  const visible = visibleAtStart(report);
  checks.add('runner-completed', report?.status === 'complete' && stepsOk(report) && launched.exitCode === 0, { status: report?.status, failed: failedSteps(report), exitCode: launched.exitCode });
  const kernels = report?.data?.kernels ?? [];
  checks.add('every-template-prepared-in-the-catalogue-worker', kernels.length === 5 && kernels.every((item) => !!item.frameId && item.validValues > 0), { kernels });
  const chunks = kernelChunks(BUILDS.conformance.dist);
  checks.add('kernels-load-as-separate-chunks-imported-by-the-worker', chunks.every((item) => item.chunk && item.importedByWorkerChunk), { chunks });
  const probes = new Map((report?.probes ?? []).map((item) => [item.id, item]));
  for (const id of ['vector-orientation-3d', 'quadratic-surface-gradient']) {
    const render = probes.get(`spatial-render:${id}`), dispose = probes.get(`spatial-dispose:${id}`);
    const display = displayContext(launched, report);
    checks.add(`spatial-renders-frames:${id}`, !visible && render?.status !== 'pass' ? null : render?.status === 'pass', render ?? null, { environment: !visible && render?.status !== 'pass', display });
    checks.add(`spatial-releases-resources:${id}`, !visible && render?.status !== 'pass' ? null : dispose?.status === 'pass', dispose ?? null, { environment: !visible && render?.status !== 'pass', display });
  }
  const violations = report?.data?.cspViolationsDuringScenario ?? report?.csp?.violations ?? null;
  checks.add('no-csp-violations-while-loading-kernels-and-3d', Array.isArray(violations) && violations.length === 0 && (report?.csp?.violations ?? []).length === 0, { violations, all: report?.csp?.violations ?? null });
  const remote = (report?.csp?.requests ?? []).filter((request) => !['tauri://localhost', 'ipc://localhost'].includes(request.origin));
  checks.add('app-request-log-same-origin-only', remote.length === 0, { requests: (report?.csp?.requests ?? []).length, remote });
  checks.add('no-process-sockets', launched.sockets.samples > 5 && launched.sockets.sockets.length === 0, launched.sockets);
  return { checks: checks.items, launch: launched };
}

// ---------------------------------------------------------------------------------------------------------------
// Packaged-host performance (report §18, A58; R22); the rows and their rules are in performance-targets.mjs
// ---------------------------------------------------------------------------------------------------------------
async function performanceScenario() {
  const checks = new Checks();
  const outDir = path.join(work, 'performance/out');
  const loadAtStart = loadavg().map((value) => Math.round(value * 100) / 100);
  const launched = await launch({ build: 'conformance', homeDir: path.join(work, 'performance/home'), outDir, scenario: 'performance', limitMs: 900_000 });
  const loadAtEnd = loadavg().map((value) => Math.round(value * 100) / 100);
  const report = launched.reports['report.json'];
  // The retained history the 2D and spatial measurements ran against (the store as the process left it).
  const count = (table) => Number(sql(launched.appData, `SELECT COUNT(*) AS n FROM ${table}`)[0]?.n ?? 0);
  const store = Object.fromEntries(['activities', 'events', 'receipts', 'exposures', 'artifacts', 'blobs'].map((table) => [table, count(table)]));
  const perf = report?.data?.performance ?? null;
  const display = displayContext(launched, report);
  const failed = failedSteps(report);
  const environment = {
    ...(perf?.environment ?? {}), loadAverage: { start: loadAtStart, end: loadAtEnd }, consoleLock: launched.consoleLock, visibilityAtStart: report?.data?.visibilityAtStart ?? null,
    store, elapsedMs: launched.elapsedMs, build: 'conformance (the release binary has no runner; both embed the same frontend bundle and host code apart from test-only commands)',
  };
  checks.add('runner-completed', report?.status === 'complete' && stepsOk(report) && launched.exitCode === 0 && !launched.timedOut,
    { status: report?.status ?? null, exitCode: launched.exitCode, timedOut: launched.timedOut, failed, errors: perf?.errors ?? null, skipped: perf?.skipped ?? null, environment });
  const hidden = !visibleAtStart(report) || !!perf?.skipped;
  for (const row of judgePerformance(perf, loadTargets(repoRoot), { failedSteps: failed })) {
    if (hidden) checks.add(`target:${row.id}`, null, { measured: 'not run: WebKit reported the window hidden (no animation frames, previews or display acknowledgements)', environment }, { environment: true, display });
    else checks.add(`target:${row.id}`, row.ok, row.detail, { environment: row.environment, display });
  }
  checks.add('no-process-sockets', launched.sockets.samples > 5 && launched.sockets.sockets.length === 0, launched.sockets);
  return { checks: checks.items, launch: launched, environment };
}

// ---------------------------------------------------------------------------------------------------------------
// Environment and evidence
// ---------------------------------------------------------------------------------------------------------------
function plist(file) {
  const result = run('plutil', ['-convert', 'json', '-o', '-', file]);
  try { return result.status === 0 ? JSON.parse(result.stdout) : null; } catch { return null; }
}
function hostInfo() {
  const sw = run('sw_vers', []).stdout;
  const field = (name) => sw.match(new RegExp(`${name}:\\s*(.+)`))?.[1]?.trim() ?? null;
  const sysctl = (name) => run('sysctl', ['-n', name]).stdout || null;
  const safari = plist('/Applications/Safari.app/Contents/Info.plist');
  const webkit = plist('/System/Library/Frameworks/WebKit.framework/Versions/A/Resources/Info.plist');
  return {
    macOS: { productVersion: field('ProductVersion'), buildVersion: field('BuildVersion'), darwin: run('uname', ['-r']).stdout },
    hardware: { model: sysctl('hw.model'), cpu: sysctl('machdep.cpu.brand_string'), logicalCpus: Number(sysctl('hw.ncpu')), memoryBytes: Number(sysctl('hw.memsize')), arch: run('uname', ['-m']).stdout },
    webKit: { frameworkVersion: webkit?.CFBundleVersion ?? null, safariShortVersion: safari?.CFBundleShortVersionString ?? null, safariBundleVersion: safari?.CFBundleVersion ?? null },
    consoleSessionLocked: consoleLocked(),
  };
}
function toolchain() {
  const lock = readFileSync(path.join(tauriDir, 'Cargo.lock'), 'utf8');
  const wanted = new Set(['tauri', 'tauri-build', 'tauri-codegen', 'tauri-runtime', 'tauri-runtime-wry', 'tauri-utils', 'wry', 'tao', 'rusqlite', 'libsqlite3-sys', 'jsonschema', 'serde_json', 'sha2', 'uuid']);
  const crates = {};
  for (const block of lock.split('[[package]]')) {
    const name = block.match(/^name = "([^"]+)"/m)?.[1], version = block.match(/^version = "([^"]+)"/m)?.[1];
    if (name && version && wanted.has(name)) crates[name] = crates[name] ? `${crates[name]}, ${version}` : version;
  }
  const npmVersion = (name) => { const file = path.join(appRoot, 'node_modules', name, 'package.json'); return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).version : null; };
  const xcode = run('xcodebuild', ['-version']);
  return {
    rustc: run('rustc', ['-V']).stdout, cargo: run('cargo', ['-V']).stdout, node: process.version, npmCli: run('npm', ['-v']).stdout, xcode: xcode.status === 0 ? xcode.stdout.replace(/\n/g, '; ') : null,
    sqliteCli: run('sqlite3', ['--version']).stdout.split(' ').slice(0, 2).join(' '),
    crates,
    npm: Object.fromEntries(['@tauri-apps/cli', '@tauri-apps/api', 'vite', 'typescript', 'react', 'react-dom'].map((name) => [name, npmVersion(name)])),
  };
}
function binaryInfo(kind) {
  const app = appOf(BUILDS[kind]);
  if (!app) return null;
  const info = plist(path.join(app.appPath, 'Contents/Info.plist'));
  const signature = run('codesign', ['-dv', '--verbose=2', app.appPath]);
  const text = `${signature.stdout}\n${signature.stderr}`;
  return {
    bundle: path.relative(repoRoot, app.appPath), executable: path.relative(repoRoot, app.executable), sha256: sha256File(app.executable), bytes: statSync(app.executable).size,
    bundleIdentifier: info?.CFBundleIdentifier ?? null, bundleVersion: info?.CFBundleVersion ?? null, minimumSystemVersion: info?.LSMinimumSystemVersion ?? null,
    signature: text.match(/^Signature=(.+)$/m)?.[1] ?? null, codesignFlags: text.match(/flags=(0x[0-9a-f]+\([^)]*\))/)?.[1] ?? null,
  };
}
function packedArtifacts() {
  const installed = JSON.parse(readFileSync(path.join(appRoot, 'packed-artifacts.json'), 'utf8'));
  const manifestFile = path.join(repoRoot, 'release/study-harness/packages/manifest.json');
  const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : null;
  const lock = JSON.parse(readFileSync(path.join(appRoot, 'package-lock.json'), 'utf8'));
  return {
    packManifest: installed.packManifest,
    packages: installed.packages.map((entry) => {
      const inManifest = manifest?.packages.find((item) => item.name === entry.name);
      return { ...entry, lockIntegrity: lock.packages?.[`node_modules/${entry.name}`]?.integrity ?? null, matchesCurrentPackManifest: inManifest?.sha256 === entry.sha256 };
    }),
  };
}
function cspSummary(offline) {
  const config = JSON.parse(readFileSync(path.join(tauriDir, 'tauri.conf.json'), 'utf8'));
  const configured = config.app.security.csp;
  const parse = (header) => Object.fromEntries(header.split(';').map((part) => part.trim().split(/\s+/)).filter((part) => part[0]).map(([name, ...sources]) => [name, sources.sort()]));
  const effective = offline?.csp?.header ?? null;
  const effectiveSet = effective ? parse(effective) : null;
  const withoutHashes = effectiveSet ? Object.fromEntries(Object.entries(effectiveSet).map(([name, sources]) => [name, sources.filter((source) => !source.startsWith("'sha256-"))])) : null;
  return {
    configured, configuredDirectives: parse(configured), effectiveHeader: effective, effectiveDirectives: effectiveSet,
    effectiveEqualsConfiguredApartFromScriptHashes: withoutHashes ? isDeepStrictEqual(withoutHashes, parse(configured)) : null,
    scriptHashes: effectiveSet?.['script-src']?.filter((source) => source.startsWith("'sha256-")).length ?? null,
    workerScriptCsp: "default-src 'none'; script-src 'self'; connect-src 'self'",
    workerScriptCspMechanism: 'on_web_resource_request on the Rust-created main window adds it to bundled JavaScript responses without a CSP header (native.md N2); verified by the worker-eval-negative probe.',
    freezePrototype: config.app.security.freezePrototype,
  };
}

const RESULT_TEXT = { pass: 'pass', fail: '**FAIL**', 'not-run-environment': 'not run (environment)', 'not-run': 'not run' };
const lockText = (locked) => locked === true ? 'locked' : locked === false ? 'unlocked' : 'unknown';

function markdown(evidence) {
  const lines = [];
  const status = (result) => RESULT_TEXT[result] ?? result;
  const notRunDisplay = Object.values(evidence.scenarios).flatMap((scenario) => scenario.checks ?? []).filter((check) => check.result === 'not-run-environment');
  lines.push('# Packaged reference host conformance — macOS', '');
  lines.push(`Generated by \`examples/study-harness-tauri/scripts/conformance.mjs\` at ${evidence.generatedAt}. Machine-readable: [\`native-conformance.json\`](native-conformance.json).${evidence.captures.length ? ` Card captures (${evidence.captures.length}): [\`native-conformance-captures/\`](native-conformance-captures/).` : ' No card captures were produced.'}`, '');
  lines.push(`**Summary:** ${evidence.summary.pass} checks passed, ${evidence.summary.fail} failed, ${evidence.summary.notRunEnvironment} not run because of the environment, ${evidence.summary.notRun} not run.`, '');
  if (evidence.sources?.changedSinceBuild?.length) lines.push(`**Source identity failed:** the reference host sources changed after the packaged apps were built (${evidence.sources.changedSinceBuild.join(', ')}), so these results are not evidence for the sources in the tree. Re-run the full suite.`, '');
  lines.push(`Scope: one macOS machine (${evidence.host.macOS.productVersion} ${evidence.host.macOS.buildVersion}, ${evidence.host.hardware.model}, ${evidence.host.hardware.cpu}). This is fixture-host evidence for the toolkit boundary; it is not evidence for the actual Study Harness application (A54), for Windows or Linux (A53), for signed or notarized builds, for assistive-technology use or for learning benefit.`, '');
  if (notRunDisplay.length) {
    lines.push(`**Environment limit:** ${notRunDisplay.length} display-dependent check${notRunDisplay.length === 1 ? ' was' : 's were'} not run because WebKit reported the app window hidden (console session lock state per run below and per launch in the JSON). A hidden window never acknowledges a display (by design) and does not run previews or animation frames, so these checks are recorded as "not run (environment)", never as passed. With the session unlocked and the display awake, \`npm run conformance:display\` (in \`examples/study-harness-tauri\`) re-runs them against the same binaries and updates this evidence.`, '');
  }
  lines.push('## Runs', '', '| Run | Mode | Scenarios | Console session at start | Window reported by WebKit at start | Results in this evidence |', '| --- | --- | --- | --- | --- | --- |');
  const shortSha = (value) => (value ? value.slice(0, 12) : 'n/a');
  const resultsText = (item) => {
    if (!item.superseded) return 'yes';
    const left = item.evidenceSummaryAfterRun;
    const binaries = item.binaries;
    return `superseded (history only${binaries ? `; release ${shortSha(binaries.release)}, conformance ${shortSha(binaries.conformance)}` : ''}${left ? `; evidence after it: ${left.pass} pass, ${left.fail} fail, ${left.notRunEnvironment} not run (environment)` : ''})`;
  };
  for (const item of evidence.runs) lines.push(`| ${item.id} | ${item.mode} | ${item.scenarios.join(', ')} | ${lockText(item.consoleSession?.lockedAtStart)} | ${item.visibilityAtStart ?? 'n/a'} | ${resultsText(item)} |`);
  lines.push('');
  lines.push('## Identity', '', '| Item | Value |', '| --- | --- |');
  lines.push(`| macOS / hardware | ${evidence.host.macOS.productVersion} (${evidence.host.macOS.buildVersion}), Darwin ${evidence.host.macOS.darwin}, ${evidence.host.hardware.model}, ${evidence.host.hardware.cpu}, ${evidence.host.hardware.logicalCpus} CPUs, ${Math.round(evidence.host.hardware.memoryBytes / 2 ** 30)} GiB |`);
  lines.push(`| WebKit | framework ${evidence.host.webKit.frameworkVersion}; Tauri-reported WebView ${evidence.environment.webviewVersion ?? 'n/a'}; Safari ${evidence.host.webKit.safariShortVersion} |`);
  lines.push(`| Toolchain | ${evidence.toolchain.rustc}; Node ${evidence.toolchain.node}; npm ${evidence.toolchain.npmCli}; ${evidence.toolchain.xcode ?? ''} |`);
  lines.push(`| Crates | ${Object.entries(evidence.toolchain.crates).map(([name, version]) => `${name} ${version}`).join(', ')} |`);
  lines.push(`| npm | ${Object.entries(evidence.toolchain.npm).map(([name, version]) => `${name} ${version}`).join(', ')} |`);
  for (const kind of ['release', 'conformance']) {
    const binary = evidence.binaries[kind];
    if (binary) lines.push(`| ${kind} binary | \`${binary.executable}\` sha256 \`${binary.sha256}\`, ${binary.bytes.toLocaleString('en-US')} bytes, ${binary.signature ?? 'unsigned'} ${binary.codesignFlags ?? ''} |`);
  }
  for (const entry of evidence.packed.packages) lines.push(`| ${entry.name} ${entry.version} | tarball sha256 \`${entry.sha256}\` (installed from \`${entry.resolved}\`) |`);
  if (evidence.sources) {
    const built = [...new Set(Object.values(evidence.sources.builtFrom))];
    const files = evidence.builds?.release?.sources?.files ?? evidence.sources.atEnd.files;
    lines.push(`| Reference host sources | built from \`${built.join('`, `')}\` (${files} files: \`HOST_SOURCE_INPUTS\` in \`scripts/build-record.mjs\`, one sha256 per file in each build record); at the end of the last run \`${evidence.sources.atEnd.digest}\`: ${evidence.sources.changedSinceBuild.length ? `**changed since the build** (${evidence.sources.changedSinceBuild.join(', ')})` : 'unchanged since the build'} |`);
  }
  lines.push('', '## Effective CSP', '');
  lines.push(`Configured: \`${evidence.csp.configured}\`.`, '');
  lines.push(`Effective header on \`index.html\` equals the configured directive set apart from ${evidence.csp.scriptHashes ?? '?'} per-file \`script-src\` hashes added by Tauri: **${evidence.csp.effectiveEqualsConfiguredApartFromScriptHashes}**. Worker scripts: \`${evidence.csp.workerScriptCsp}\` (${evidence.csp.workerScriptCspMechanism})`, '');
  lines.push('## Scenarios', '', 'Display-dependent checks need a rendered, visible card; their JSON entries record the window visibility and the console lock state of the process they ran in.', '');
  for (const [name, scenario] of Object.entries(evidence.scenarios)) {
    lines.push(`### ${name}`, '', `Run: ${scenario.run ?? 'n/a'}`, '', '| Check | Result | Display-dependent |', '| --- | --- | --- |');
    for (const check of scenario.checks ?? []) lines.push(`| ${check.id} | ${status(check.result)} | ${check.displayDependent ? 'yes' : ''} |`);
    lines.push('');
  }
  const kit = evidence.scenarios['hostport-kit']?.result;
  if (kit) {
    lines.push('## HostPort conformance kit result (reference-fixture-host)', '');
    lines.push(`Record in the form of \`docs/study-harness/templates/host-conformance-result.schema.json\`: [\`host-conformance-reference-fixture.json\`](host-conformance-reference-fixture.json). Subject \`${kit.subject}\` (a fixture result; it never satisfies A54), kit \`${kit.kit?.name ?? 'n/a'}\` ${kit.kit?.version ?? ''}, binary sha256 \`${kit.host.binarySha256}\`, overall **${kit.result}**.`, '');
    lines.push('| Step | Outcome | Assertions |', '| --- | --- | --- |');
    for (const [step, value] of Object.entries(kit.steps)) lines.push(`| ${step} | ${value.outcome} | ${(value.assertions ?? []).map((item) => `${item.id}: ${item.outcome}`).join('; ')} |`);
    lines.push('');
  }
  const performance = evidence.scenarios.performance;
  if (performance) {
    const environment = (performance.checks ?? []).find((check) => check.id === 'runner-completed')?.detail?.environment ?? {};
    lines.push('## Packaged-host performance (report §18)', '');
    lines.push(`Run: ${performance.run ?? 'n/a'}. Measured inside this app's WKWebView against the Rust host and its SQLite store (one launch, fresh store, the 100 lifecycle activities retained before the 2D and spatial measurements). Inputs are DOM events dispatched by the runner at a 60 Hz pacing, not OS-level input. Display refresh interval ${environment.refreshIntervalMs ?? 'n/a'} ms, device pixel ratio ${environment.devicePixelRatio ?? 'n/a'}, WebGL renderer ${environment.webglRenderer ?? 'n/a'}, load average ${environment.loadAverage ? `${environment.loadAverage.start.join(' / ')} at start, ${environment.loadAverage.end.join(' / ')} at end` : 'n/a'}. Targets and rules: \`docs/study-harness/budgets.json\`.`, '');
    lines.push('| Target | Result | Measured |', '| --- | --- | --- |');
    for (const check of (performance.checks ?? []).filter((item) => item.id.startsWith('target:'))) lines.push(`| ${check.id.slice(7)} | ${status(check.result)} | ${String(check.detail?.measured ?? '').replace(/\|/g, '\\|')} |`);
    lines.push('');
  }
  lines.push('## Limitations', '');
  for (const item of evidence.limitations) lines.push(`- ${item}`);
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------------------------
const evidenceFile = path.join(evidenceDir, 'native-conformance.json');
const captureDir = path.join(evidenceDir, 'native-conformance-captures');
const mode = displayOnly ? 'display-only' : only.length === ALL.length && ALL.every((name) => only.includes(name)) ? 'full' : 'partial';
const runId = `${mode}-${new Date().toISOString()}`;
let previous = null;
if (displayOnly) {
  // Merge only into evidence produced by exactly these binaries, and only when the window can be visible.
  const refuse = (message, code) => {
    console.error(`[conformance] --display-only: ${message} Nothing was changed.`);
    rmSync(work, { recursive: true, force: true });
    process.exit(code);
  };
  if (flag('--no-evidence')) refuse('merges into the evidence and cannot be combined with --no-evidence.', 2);
  if (!existsSync(evidenceFile)) refuse(`there is no evidence at ${path.relative(repoRoot, evidenceFile)}; run the full suite first (npm run conformance).`, 2);
  previous = JSON.parse(readFileSync(evidenceFile, 'utf8'));
  for (const kind of ['release', 'conformance']) {
    const app = appOf(BUILDS[kind]);
    const recorded = previous.binaries?.[kind]?.sha256;
    if (!app || !recorded || sha256File(app.executable) !== recorded) refuse(`the packaged ${kind} executable is missing or differs from the one recorded in the evidence; run the full suite (npm run conformance).`, 2);
    // Results merged into the evidence must belong to binaries of the sources in the tree (build-record.mjs).
    const builtFrom = previous.builds?.[kind]?.sources;
    if (!builtFrom?.digest) refuse(`the evidence does not name the reference host sources the packaged ${kind} app was built from; run the full suite (npm run conformance).`, 2);
    const changed = sourceChanges(builtFrom, hostSourceDigest(repoRoot));
    if (changed.length) refuse(`the reference host sources changed since the packaged ${kind} app was built (${changeList(changed)}); run the full suite (npm run conformance).`, 2);
  }
  const locked = consoleLocked();
  if (locked !== false) refuse(`the macOS console session is ${locked === null ? 'in an unknown lock state (ioreg unreadable)' : 'locked'}; unlock it and keep the display awake, then re-run.`, 3);
}
// A full or partial run replaces every scenario result (they belong to the binaries it builds or finds), but earlier
// run records stay in runs[] as history: marked superseded, with their own binaries, mode and console-session state,
// and the evidence summary they left behind. Their scenario results are not part of the new evidence.
let history = [];
if (!displayOnly && !flag('--no-evidence') && existsSync(evidenceFile)) {
  try {
    const earlier = JSON.parse(readFileSync(evidenceFile, 'utf8'));
    const earlierRuns = earlier.runs ?? [];
    history = earlierRuns.map((run, index) => ({
      ...run, superseded: true,
      // The evidence summary as it stood right after the earlier evidence's last run.
      ...(index === earlierRuns.length - 1 && !run.evidenceSummaryAfterRun ? { evidenceSummaryAfterRun: earlier.summary ?? null } : {}),
    }));
  } catch { history = []; }
}
const builds = {};
if (displayOnly) {
  Object.assign(builds, previous.builds);
} else if (!flag('--no-build')) {
  // Conformance first, release last: src-tauri/gen and permissions/autogenerated then reflect the release build.
  builds.conformance = buildApp('conformance');
  builds.release = buildApp('release');
} else {
  // Reuse the apps only while their build records still describe them: same executables, the installed tarballs they
  // were built from and the dist they embed. Otherwise the evidence would attribute old binaries to newer tarballs.
  const installed = packedArtifacts();
  const sources = hostSourceDigest(repoRoot);
  const problems = [];
  for (const kind of ['conformance', 'release']) {
    const app = appOf(BUILDS[kind]);
    if (!app) { problems.push(`${kind}: no packaged app`); continue; }
    const record = readBuildRecord(buildRecordPath(BUILDS[kind]));
    const found = noBuildProblems({ kind, record, executableSha256: sha256File(app.executable), packed: installed, distDigest: treeDigest(BUILDS[kind].dist), sources });
    problems.push(...found);
    if (!found.length) builds[kind] = { ...record, command: 'not rebuilt (--no-build)', builtWith: record.command, durationMs: 0, aclSnapshot: null };
  }
  if (problems.length) {
    console.error(`[conformance] --no-build refused; nothing was run or written:\n  - ${problems.join('\n  - ')}\nRun without --no-build to rebuild both apps from the installed tarballs and the current sources.`);
    rmSync(work, { recursive: true, force: true });
    process.exit(2);
  }
  log('--no-build: build records match the executables, the installed tarballs, the dist and the host sources; release/ACL checks require a rebuild and are excluded from this partial run.');
}
const lockedAtStart = consoleLocked();
if (lockedAtStart) log('WARNING: the console session is locked; WebKit will report the window hidden and display-dependent checks cannot run.');
const scenarios = {};
if (only.includes('release')) { log('release scenario'); scenarios.release = await releaseScenario(builds); }
if (only.includes('offline')) { log('offline scenario'); scenarios.offline = await offlineScenario(); }
let restart = null;
if (only.includes('restart') || only.includes('restore')) { log('restart scenario'); restart = await restartScenario(); scenarios.restart = restart; }
if (only.includes('crash')) for (const point of CRASH_POINTS) { log(`crash scenario ${point}`); scenarios[`crash:${point}`] = await crashScenario(point); }
if (only.includes('restore')) { log('restore scenario'); scenarios.restore = await restoreScenario(restart); }
if (only.includes('hostport-kit')) { log('HostPort conformance kit scenario'); scenarios['hostport-kit'] = await hostPortKitScenario(); }
if (only.includes('templates')) { log('templates scenario (kernels in the worker, spatial rendering)'); scenarios.templates = await templatesScenario(); }
if (only.includes('performance')) { log('performance scenario (report §18 targets in the packaged WKWebView)'); scenarios.performance = await performanceScenario(); }
for (const scenario of Object.values(scenarios)) scenario.run = runId;

// The sources once more, now that every scenario ran: the evidence describes these binaries only while the tree still
// holds the sources they were built from. A file edited during the run (or between the two builds) fails the run.
const sourcesAtEnd = hostSourceDigest(repoRoot);
const sourcesChanged = [...new Set(['conformance', 'release'].flatMap((kind) => sourceChanges(builds[kind]?.sources, sourcesAtEnd)))].sort();
if (sourcesChanged.length) console.error(`[conformance] the reference host sources changed since the packaged apps were built (${changeList(sourcesChanged)}); this run is recorded as failed. Re-run the full suite when no one is editing them.`);
const sourceRecord = {
  inputs: HOST_SOURCE_INPUTS,
  builtFrom: Object.fromEntries(['release', 'conformance'].map((kind) => [kind, builds[kind]?.sources?.digest ?? null])),
  atEnd: { digest: sourcesAtEnd.digest, files: sourcesAtEnd.files },
  changedSinceBuild: sourcesChanged,
};

const generatedAt = new Date().toISOString();
const offlineReport = scenarios.offline?.launch?.reports?.['report.json'];
const scenarioInfo = offlineReport?.scenario ?? scenarios.restart?.phases?.[0]?.reports?.['report.json']?.scenario ?? null;
const visibilityAtStart = offlineReport?.data?.visibilityAtStart ?? scenarios.restart?.phases?.[0]?.reports?.['report.json']?.data?.visibilityAtStart ?? null;
const binaries = { release: binaryInfo('release'), conformance: binaryInfo('conformance') };
const runRecord = {
  id: runId, mode, generatedAt, command: ['node scripts/conformance.mjs', ...argv].join(' '), scenarios: Object.keys(scenarios),
  consoleSession: { lockedAtStart, lockedAtEnd: consoleLocked() }, visibilityAtStart, node: process.version,
  binaries: { release: binaries.release?.sha256 ?? null, conformance: binaries.conformance?.sha256 ?? null },
  sources: { builtFrom: sourceRecord.builtFrom, atEnd: sourceRecord.atEnd.digest, changedSinceBuild: sourcesChanged },
  // Outcome of the scenarios this run executed (the evidence summary may also include merged earlier scenarios).
  summary: (() => {
    const own = Object.values(scenarios).flatMap((scenario) => scenario.checks ?? []);
    return { pass: own.filter((check) => check.result === 'pass').length, fail: own.filter((check) => check.result === 'fail').length,
      notRunEnvironment: own.filter((check) => check.result === 'not-run-environment').length, notRun: own.filter((check) => check.result === 'not-run').length };
  })(),
};
// --display-only: the re-run scenarios replace their earlier results; every other scenario keeps the run it came from.
const legacyRunId = previous ? previous.runs?.[0]?.id ?? `full-${previous.generatedAt}` : null;
const mergedScenarios = {};
if (previous) for (const [name, scenario] of Object.entries(previous.scenarios)) mergedScenarios[name] = { ...scenario, run: scenario.run ?? legacyRunId };
Object.assign(mergedScenarios, scenarios);
const runs = previous
  ? [...(previous.runs ?? [{ id: legacyRunId, mode: 'full', generatedAt: previous.generatedAt, scenarios: Object.keys(previous.scenarios), consoleSession: { lockedAtStart: previous.environment?.consoleSessionLockedAtStart ?? null }, visibilityAtStart: previous.environment?.visibilityAtStart ?? null }]), runRecord]
  : [...history, runRecord];
const allChecks = Object.values(mergedScenarios).flatMap((scenario) => scenario.checks ?? []);
const notRunDisplay = allChecks.filter((check) => check.result === 'not-run-environment');
const captureSources = [scenarios.offline?.captures, path.join(work, 'restart/p1/captures'), path.join(work, 'restart/p2/captures'), path.join(work, 'restore/out/captures')].filter((source) => source && existsSync(source));
/** Capture files each scenario writes (by name prefix): a re-run scenario replaces its own captures only. */
const capturePrefixes = { offline: ['explore-'], restart: ['restart-'], restore: ['restored-backup-'] };
const replacedPrefixes = Object.keys(scenarios).flatMap((name) => capturePrefixes[name] ?? []);
const keptCaptures = previous ? (previous.captures ?? []).filter((item) => !replacedPrefixes.some((prefix) => item.file.startsWith(prefix))) : [];
const evidence = redact({
  schema: 'study-harness.native-conformance.evidence/1',
  generatedAt,
  generator: 'examples/study-harness-tauri/scripts/conformance.mjs',
  scope: 'Packaged Tauri 2 reference host (conformance fixture) on one macOS machine. Not evidence for the actual Study Harness application, other operating systems, signed/notarized builds, assistive technology or learning benefit.',
  summary: {
    pass: allChecks.filter((check) => check.result === 'pass').length,
    fail: allChecks.filter((check) => check.result === 'fail').length,
    notRunEnvironment: notRunDisplay.length,
    notRun: allChecks.filter((check) => check.result === 'not-run').length,
    failed: allChecks.filter((check) => check.result === 'fail').map((check) => check.id),
    notRunEnvironmentChecks: notRunDisplay.map((check) => check.id),
    sourcesUnchangedSinceBuild: !sourcesChanged.length,
  },
  sources: sourceRecord,
  host: hostInfo(),
  environment: {
    consoleSessionLockedAtStart: lockedAtStart, visibilityAtStart, windowHidden: visibilityAtStart !== null && visibilityAtStart !== 'visible',
    lockStateSource: 'ioreg -n Root -d1: CGSSessionScreenIsLocked or IOConsoleLocked = Yes means locked (sampled before every launch, every second while it runs, and at exit)',
    webviewVersion: scenarioInfo?.webviewVersion ?? previous?.environment?.webviewVersion ?? null, tauriVersion: scenarioInfo?.tauriVersion ?? previous?.environment?.tauriVersion ?? null,
    userAgent: offlineReport?.userAgent ?? previous?.environment?.userAgent ?? null, origin: offlineReport?.origin ?? previous?.environment?.origin ?? null,
    appDataDirectory: 'HOME/Library/Application Support/<identifier> with HOME set to a fresh directory per scenario chain',
    launchArguments: LAUNCH_ARGS,
    launchArgumentsReason: 'AppKit crash-history window-restoration prompt (modal NSAlert) otherwise blocks relaunch after the deliberate aborts',
  },
  runs,
  toolchain: previous ? previous.toolchain : toolchain(),
  packed: previous ? previous.packed : packedArtifacts(),
  builds,
  binaries,
  csp: cspSummary(mergedScenarios.offline),
  captures: [...keptCaptures, ...captureSources.flatMap((source) => readdirSync(source).map((file) => ({ file, sha256: sha256File(path.join(source, file)), run: runId })))],
  scenarios: mergedScenarios,
  limitations: [
    'One macOS machine only (A53). Windows (WebView2) and Linux (WebKitGTK) packaged runs are external gates (external-gates.md G5); nothing here supports a claim for them.',
    'Builds are unsigned (`--no-sign`, linker ad-hoc signature only); signing and notarization are owner-controlled and untested.',
    'The release binary cannot run in-app probes (it has no test endpoints by design); its command scope is verified by ACL/manifest inspection, a strings check and a brief offline launch, and the ACL mechanism itself by the conformance binary rejecting a registered-but-ungranted command.',
    'Offline means: no remote origin referenced or fetched by the app, CSP connect-src blocks remote origins, and no socket opened by the app process (sampled with lsof). WebKit networking runs in separate XPC processes that are not sampled, and the machine network was not disabled.',
    'The runner drives host controls by DOM click and the learner binding programmatically (preview gesture, navigation); it does not synthesize OS-level pointer input. Manual visual and assistive-technology inspection of the packaged app remain open (A37).',
    'The reference host is a conformance fixture. Results are separate from, and do not stand in for, the actual Study Harness integration (A54).',
    'The hostport-kit scenario runs the host-agnostic HostPort conformance kit inside the packaged app: its restarts reopen the same SQLite store in the running process and its interruptions are in-process simulated faults at the named crash points; process terminations are covered by the restart and crash:* scenarios. Its display acknowledgements come from the kit acting as the learner surface (no rendering).',
    ...(mergedScenarios.performance ? ['Packaged-host performance (scenario performance): one launch on this one machine, which was also used for other work (load average recorded). Inputs are DOM events dispatched by the runner, so OS input delivery is not included; the reference host mounts one learner card at a time, so simultaneous cards are measured only in Chromium (benchmark.mjs); WebKit exposes no JavaScript heap figures, so no memory is reported; the host-level launch and memory targets concern the Study Harness application and are not measured here.'] : []),
    ...(runs.filter((item) => !item.superseded).length > 1 ? ['Scenario results come from more than one run of the SAME binaries (sha256 checked before merging; see Runs). Each scenario records the run it came from.'] : []),
    ...(runs.some((item) => item.superseded) ? ['Runs marked superseded are kept as history only: they ran earlier binaries or sources, and none of their scenario results is part of this evidence.'] : []),
    ...(sourcesChanged.length ? [`The reference host sources changed after the packaged apps were built (${changeList(sourcesChanged)}): these results cannot be attributed to the sources in the tree, and the run is recorded as failed.`] : []),
    ...(notRunDisplay.length ? ['WebKit reported the window hidden (console session locked) for the display-dependent checks listed as "not run (environment)": display acknowledgements, live previews, lazily rendered math, captures, the hide/show lifecycle and the display-ack crash point could not be exercised.'] : []),
  ],
});
if (!flag('--no-evidence')) {
  mkdirSync(evidenceDir, { recursive: true });
  if (!previous) rmSync(captureDir, { recursive: true, force: true });
  mkdirSync(captureDir, { recursive: true });
  for (const file of readdirSync(captureDir)) if (!evidence.captures.some((item) => item.file === file && item.run !== runId)) rmSync(path.join(captureDir, file), { force: true });
  for (const source of captureSources) for (const file of readdirSync(source)) copyFileSync(path.join(source, file), path.join(captureDir, file));
  if (!readdirSync(captureDir).length) rmSync(captureDir, { recursive: true, force: true });
  writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
  // The kit's result record on its own (template form, external gate G2), kept with the run that produced it.
  if (scenarios['hostport-kit']?.result) writeFileSync(path.join(evidenceDir, 'host-conformance-reference-fixture.json'), `${JSON.stringify(scenarios['hostport-kit'].result, null, 2)}\n`);
  writeFileSync(path.join(evidenceDir, 'native-conformance.md'), markdown(evidence));
  log(`evidence written to ${path.relative(repoRoot, evidenceDir)}/native-conformance.{json,md}`);
  // Append-only history (report §22.3, G78): every run, failed ones included, keeps its checks; the summary files above
  // stay the latest index.
  log(`history record ${path.relative(repoRoot, writeHistoryRecord(evidenceDir, 'native-conformance', compactNativeEvidence(evidence), { root: repoRoot }))}`);
}
log(`summary: ${JSON.stringify(evidence.summary)}`);
if (!flag('--keep')) rmSync(work, { recursive: true, force: true });
else log(`kept work directory ${work}`);
process.exitCode = evidence.summary.fail || sourcesChanged.length ? 1 : 0;
