// The release pipeline's native gate in its default --native=verify mode (report §17 restart/interrupted-exposure
// sequence, §20.1, A51, A59; R07): only complete packaged evidence of a full run, built from exactly this pack and from
// the reference host sources still in the tree, and tied to the executables on this machine, can pass. Also the
// runner's scenario list and --no-build build records.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { GATES, NATIVE_APPS, NATIVE_CHECK_RESULTS, STATUS, evaluateNativeEvidence, overallStatus } from '../../scripts/study-harness/release-pipeline.mjs';
import { CRASH_POINTS, REQUIRED_SCENARIOS, SCENARIO_CHAINS, parseOnly, scenarioKeys } from '../../examples/study-harness-tauri/scripts/scenarios.mjs';
import { BUILD_RECORD_SCHEMA, HOST_SOURCE_INPUTS, buildRecordPath, changeList, createBuildRecord, hostSourceDigest, noBuildProblems, sourceChanges, tarballSet, treeDigest } from '../../examples/study-harness-tauri/scripts/build-record.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const PACK = ['core', 'activity', 'catalog', 'player', 'player-3d'].map((name, index) => ({ name: `@experiment-kit/${name}`, version: '0.3.0-preview.1', sha256: String(index + 1).repeat(64), integrity: `sha512-${index}` }));
const SHA = { release: 'e'.repeat(64), conformance: 'c'.repeat(64) };
const installed = { packages: PACK };
const onDisk = (overrides = {}) => Object.fromEntries(NATIVE_APPS.map(kind => [kind, { executable: `examples/${kind}/app`, recorded: SHA[kind], present: true, matches: true, ...overrides[kind] }]));
const HOST_RS = 'examples/study-harness-tauri/src-tauri/src/host.rs';
/** Host sources as hostSourceDigest returns them: one entry per file and their digest. */
const sourcesOf = (files) => {
  const entries = Object.entries(files).map(([file, sha256]) => ({ path: file, sha256 })).sort((a, b) => (a.path < b.path ? -1 : 1));
  return { digest: `sha256:${createHash('sha256').update(entries.map(entry => `${entry.path}\0${entry.sha256}`).join('\n')).digest('hex')}`, files: entries.length, entries };
};
/** The sources both apps were built from, and (unless a test changes it) the tree's sources now. */
const SOURCES = sourcesOf({ [HOST_RS]: '7'.repeat(64), 'packages/activity/schema/index.json': '8'.repeat(64) });

/** Evidence as conformance.mjs writes it after one full run (every scenario, build records, both executables). */
function fullEvidence() {
  return {
    schema: 'study-harness.native-conformance.evidence/1', generatedAt: '2026-10-27T05:00:00.000Z',
    summary: {}, packed: { packages: PACK },
    runs: [{ id: 'full-2026-10-26T20:00:00.000Z', mode: 'full', superseded: true }, { id: 'full-2026-10-27T05:00:00.000Z', mode: 'full', scenarios: [...REQUIRED_SCENARIOS] }],
    builds: Object.fromEntries(NATIVE_APPS.map(kind => [kind, { schema: BUILD_RECORD_SCHEMA, kind, executableSha256: SHA[kind], packed: { packages: tarballSet(installed) }, sources: SOURCES }])),
    sources: { inputs: HOST_SOURCE_INPUTS, builtFrom: { release: SOURCES.digest, conformance: SOURCES.digest }, atEnd: { digest: SOURCES.digest, files: SOURCES.files }, changedSinceBuild: [] },
    binaries: Object.fromEntries(NATIVE_APPS.map(kind => [kind, { executable: `examples/${kind}/app`, sha256: SHA[kind] }])),
    scenarios: Object.fromEntries(REQUIRED_SCENARIOS.map(key => [key, { run: 'full-2026-10-27T05:00:00.000Z', checks: [{ id: `${key}:a`, result: 'pass' }, { id: `${key}:b`, result: 'pass' }] }])),
  };
}
const evaluate = (evidence, binaries = onDisk(), sources = SOURCES) => evaluateNativeEvidence({ evidence, packedArtifacts: installed, pack: PACK, binaries, sources });

test('the required scenario set is the runner\'s own full run: release, offline, restart, every crash point, restore, hostport-kit, templates, performance', () => {
  // performance: the packaged §18 measurements the native owner added to the runner (R22) are required like the rest.
  for (const key of ['release', 'offline', 'restart', 'crash:intent-before-commit', 'crash:intent-after-commit', 'crash:intent-after-reply', 'crash:display-ack-before-commit', 'crash:save-before-commit', 'restore', 'hostport-kit', 'templates', 'performance']) {
    assert.ok(REQUIRED_SCENARIOS.includes(key), key);
  }
  assert.deepEqual([...REQUIRED_SCENARIOS], scenarioKeys(SCENARIO_CHAINS));
  assert.deepEqual(scenarioKeys(['crash']), CRASH_POINTS.map(point => `crash:${point}`));
  // conformance.mjs takes its chains, crash points and display chains from scenarios.mjs (no second list to drift).
  const runner = readFileSync(path.join(root, 'examples/study-harness-tauri/scripts/conformance.mjs'), 'utf8');
  assert.match(runner, /import \{ CRASH_POINTS, DISPLAY_SCENARIOS, SCENARIO_CHAINS, parseOnly \} from '\.\/scenarios\.mjs';/);
  assert.doesNotMatch(runner, /const (ALL|CRASH_POINTS|DISPLAY_SCENARIOS) = \[/);
  assert.match(runner, /parseOnly\(option\('--only', ALL\.join\(','\)\)\)\.chains/);
  // Every chain the runner dispatches is a known chain (a chain added to the runner must be added to scenarios.mjs).
  for (const [, chain] of runner.matchAll(/only\.includes\('([a-z0-9-]+)'\)/g)) assert.ok(SCENARIO_CHAINS.includes(chain), `${chain} is dispatched by conformance.mjs but missing from scenarios.mjs`);
  assert.equal(GATES.find(gate => gate.id === 'native').requires.join(), 'macos');
});

test('R07: complete evidence of a full run passes; a display-only re-run of the same binaries merged into it still passes', () => {
  const result = evaluate(fullEvidence());
  assert.equal(result.status, STATUS.pass);
  assert.equal(result.counts.total, 2 * REQUIRED_SCENARIOS.length);
  assert.deepEqual(result.details.completeness.missingScenarios, []);
  const merged = fullEvidence();
  merged.runs.push({ id: 'display-only-2026-10-27T06:00:00.000Z', mode: 'display-only' });
  merged.scenarios.offline.run = 'display-only-2026-10-27T06:00:00.000Z';
  assert.equal(evaluate(merged).status, STATUS.pass);
});

test('R07: evidence of a partial run (--only=release) fails the gate and the overall status', () => {
  // Exactly what conformance.mjs writes for --only=release: only that scenario, run mode "partial", earlier runs superseded.
  const partial = fullEvidence();
  partial.runs = [...partial.runs.map(run => ({ ...run, superseded: true })), { id: 'partial-2026-10-27T07:00:00.000Z', mode: 'partial', scenarios: ['release'] }];
  partial.scenarios = { release: { ...partial.scenarios.release, run: 'partial-2026-10-27T07:00:00.000Z' } };
  const result = evaluate(partial);
  assert.equal(result.status, STATUS.fail);
  assert.match(result.reason, /latest packaged run \(partial-2026-10-27T07:00:00\.000Z\) ran only some scenario chains/);
  assert.equal(overallStatus([...GATES.filter(gate => gate.id !== 'native').map(() => ({ status: STATUS.pass })), { status: result.status }], false), 'fail');
  // Missing scenarios are named even when the run itself is not marked partial.
  const missing = fullEvidence();
  for (const key of ['restart', 'crash:display-ack-before-commit', 'restore']) delete missing.scenarios[key];
  const incomplete = evaluate(missing);
  assert.equal(incomplete.status, STATUS.fail);
  assert.match(incomplete.reason, /incomplete scenario set: restart, crash:display-ack-before-commit, restore not recorded/);
  // A scenario that ran no check, an empty scenario set, and scenario results left from a superseded run fail too.
  const empty = fullEvidence();
  empty.scenarios.templates.checks = [];
  assert.match(evaluate(empty).reason, /incomplete scenario set: templates/);
  const none = fullEvidence();
  none.scenarios = {};
  assert.equal(evaluate(none).status, STATUS.fail);
  const stale = fullEvidence();
  stale.scenarios.restore.run = 'full-2026-10-26T20:00:00.000Z';
  assert.match(evaluate(stale).reason, /scenario results from a superseded or unrecorded run: restore/);
  const superseded = fullEvidence();
  superseded.runs = superseded.runs.map(run => ({ ...run, superseded: true }));
  assert.match(evaluate(superseded).reason, /no current full packaged run/);
});

test('R07: a check whose result is not one the runner writes (pass, fail, not-run, not-run-environment) fails the gate', () => {
  // The runner's own result vocabulary is the gate's: conformance.mjs renders exactly these results.
  const runner = readFileSync(path.join(root, 'examples/study-harness-tauri/scripts/conformance.mjs'), 'utf8');
  const resultText = runner.match(/const RESULT_TEXT = \{([^}]*)\};/)?.[1] ?? '';
  assert.deepEqual([...resultText.matchAll(/'?([a-z-]+)'?:\s*'/g)].map(match => match[1]).sort(), [...NATIVE_CHECK_RESULTS].sort());
  for (const value of ['skipped', 'passed', null, undefined]) {
    const odd = fullEvidence();
    odd.scenarios.templates.checks[0].result = value;
    const result = evaluate(odd);
    assert.equal(result.status, STATUS.fail, String(value));
    assert.equal(result.details.unrecognisedChecks.length, 1);
    assert.match(result.reason, /1 packaged-host checks have no recognised result \(pass, fail, not-run, not-run-environment\): templates:a/);
  }
  const noResult = fullEvidence();
  delete noResult.scenarios.restore.checks[1].result;
  assert.match(evaluate(noResult).reason, /restore:b \(no result\)/);
  // The recognised values keep their meaning: not-run-environment alone is an environment gap, not a failure.
  const display = fullEvidence();
  display.scenarios.templates.checks[0].result = 'not-run-environment';
  assert.equal(evaluate(display).status, STATUS.environment);
});

test('R07: missing executables, or executables other than the ones recorded and built, fail the gate', () => {
  const absent = evaluate(fullEvidence(), onDisk({ release: { present: false, matches: null }, conformance: { present: false, matches: null } }));
  assert.equal(absent.status, STATUS.fail);
  assert.match(absent.reason, /packaged release executable recorded in the evidence is missing/);
  assert.match(evaluate(fullEvidence(), onDisk({ conformance: { matches: false } })).reason, /packaged conformance executable differs/);
  assert.match(evaluate(fullEvidence(), null).reason, /packaged release executable recorded in the evidence is missing/);
  const noBinaries = fullEvidence();
  delete noBinaries.binaries;
  assert.match(evaluate(noBinaries).reason, /records no packaged release executable/);
  const rebuilt = fullEvidence();
  rebuilt.builds.release.executableSha256 = 'f'.repeat(64);
  assert.match(evaluate(rebuilt).reason, /release executable that ran is not the one its build record describes/);
});

test('R07: evidence must say which tarballs each app was built from, and they must be this pack', () => {
  // The evidence shape before build records existed (builds hold only the build command).
  const legacy = fullEvidence();
  for (const kind of NATIVE_APPS) legacy.builds[kind] = { kind, command: 'not rebuilt (--no-build)', durationMs: 0, aclSnapshot: null };
  const result = evaluate(legacy);
  assert.equal(result.status, STATUS.fail);
  assert.match(result.reason, /does not record which tarballs the packaged release app was built from/);
  // A --no-build run after installing a new pack would have recorded the new tarballs for binaries built from the old.
  const old = fullEvidence();
  old.builds.conformance.packed.packages = old.builds.conformance.packed.packages.map(item => item.name === '@experiment-kit/player' ? { ...item, sha256: '9'.repeat(64) } : item);
  assert.match(evaluate(old).reason, /packaged conformance app was built from other tarballs \(@experiment-kit\/player\)/);
  const fewer = fullEvidence();
  fewer.builds.release.packed.packages = fewer.builds.release.packed.packages.slice(1);
  assert.match(evaluate(fewer).reason, /does not record which tarballs the packaged release app was built from/);
});

test('--only names are checked: a typo or an empty list is refused instead of running nothing', () => {
  assert.deepEqual(parseOnly(undefined), { chains: [...SCENARIO_CHAINS], full: true });
  assert.deepEqual(parseOnly('templates,release'), { chains: ['release', 'templates'], full: false });
  assert.throws(() => parseOnly('crashes'), /Unknown scenario chain\(s\) crashes/);
  assert.throws(() => parseOnly(''), /selects no scenario chain/);
  assert.throws(() => parseOnly(','), /selects no scenario chain/);
});

test('--no-build reuses an app only while its build record describes the executable, the installed tarballs, the dist and the host sources', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'build-record-'));
  try {
    const dist = path.join(directory, 'dist');
    mkdirSync(path.join(dist, 'assets'), { recursive: true });
    writeFileSync(path.join(dist, 'index.html'), '<!doctype html>');
    writeFileSync(path.join(dist, 'assets', 'main.js'), 'console.log(1)');
    const digest = treeDigest(dist);
    assert.match(digest.digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(digest.files, 2);
    assert.equal(treeDigest(path.join(directory, 'missing')), null);
    const packed = { packManifest: { createdAt: '2026-10-27T01:00:00.000Z' }, packages: PACK };
    const record = createBuildRecord({ kind: 'release', command: 'npx tauri build', builtAt: '2026-10-27T01:10:00.000Z', executable: 'x/app', executableSha256: SHA.release, packed, dist: 'dist', distDigest: digest, sources: SOURCES });
    assert.equal(record.schema, BUILD_RECORD_SCHEMA);
    assert.deepEqual(record.packed.packages.map(item => item.name), PACK.map(item => item.name).sort());
    assert.deepEqual(record.sources, { inputs: HOST_SOURCE_INPUTS, digest: SOURCES.digest, files: 2, entries: SOURCES.entries });
    const ok = { kind: 'release', record, executableSha256: SHA.release, packed, distDigest: digest, sources: SOURCES };
    assert.deepEqual(noBuildProblems(ok), []);
    assert.match(noBuildProblems({ ...ok, record: null })[0], /no build record next to the app/);
    assert.match(noBuildProblems({ ...ok, executableSha256: 'd'.repeat(64) }).join(), /not the one the build record describes/);
    const newer = { ...packed, packages: PACK.map(item => item.name === '@experiment-kit/core' ? { ...item, sha256: '0'.repeat(64) } : item) };
    assert.match(noBuildProblems({ ...ok, packed: newer }).join(), /installed tarballs \(packed-artifacts\.json\) differ from those the app was built from \(@experiment-kit\/core built 111111111111, installed 000000000000\)/);
    writeFileSync(path.join(dist, 'assets', 'main.js'), 'console.log(2)');
    assert.match(noBuildProblems({ ...ok, distDigest: treeDigest(dist) }).join(), /frontend dist .* is not the one the app embeds/);
    assert.equal(buildRecordPath({ targetDir: '/t', product: 'P' }), path.join('/t', 'release/bundle/macos', 'P.build-record.json'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  // conformance.mjs writes the record after every build, carries it into the evidence and refuses --no-build otherwise.
  const runner = readFileSync(path.join(root, 'examples/study-harness-tauri/scripts/conformance.mjs'), 'utf8');
  assert.match(runner, /writeBuildRecord\(buildRecordPath\(build\), record\);\n  return \{ \.\.\.record, durationMs/);
  assert.match(runner, /noBuildProblems\(\{ kind, record, executableSha256: sha256File\(app\.executable\), packed: installed, distDigest: treeDigest\(BUILDS\[kind\]\.dist\), sources \}\)/);
  assert.match(runner, /--no-build refused; nothing was run or written[\s\S]{0,300}process\.exit\(2\);/);
});

// Evidence identity of the packaged apps' SOURCES (collateral of the R22/phase-2 native review: host.rs was edited after
// the binaries cited as evidence were built, and nothing could show whether the binaries still matched it). The tree is
// uncommitted, so the build record names every source file with its sha256 instead of a commit.
test('the host sources a build record names cover the Rust host, its embedded files, the frontend and the contracts crate, and no build output', () => {
  for (const input of HOST_SOURCE_INPUTS) assert.ok(existsSync(path.join(root, input.path)), `${input.path} is listed as a source input but does not exist`);
  const tree = hostSourceDigest(root);
  assert.match(tree.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(tree.files, tree.entries.length);
  const files = new Set(tree.entries.map(entry => entry.path));
  const host = 'examples/study-harness-tauri';
  for (const file of [HOST_RS, `${host}/src-tauri/src/backup.rs`, `${host}/src-tauri/src/store.rs`, `${host}/src-tauri/src/lib.rs`, `${host}/src-tauri/src/conformance.rs`,
    `${host}/src-tauri/build.rs`, `${host}/src-tauri/Cargo.toml`, `${host}/src-tauri/Cargo.lock`, `${host}/src-tauri/policy/approved.json`, `${host}/src-tauri/tauri.conf.json`,
    `${host}/src-tauri/tauri.conformance.conf.json`, `${host}/src-tauri/capabilities/main-window.json`, `${host}/src/app.ts`, `${host}/src/conformance/performance.ts`,
    `${host}/index.html`, `${host}/vite.config.mjs`, `${host}/package-lock.json`, 'packages/activity/rust/src/lib.rs', 'packages/activity/rust/Cargo.lock', 'packages/activity/schema/index.json']) {
    assert.ok(files.has(file), `${file} is not among the host sources`);
  }
  // Every schema the contracts crate embeds (include_str! of ../../schema/<name>.schema.json) and every file the Rust
  // host embeds with include_str! is an input.
  for (const name of readdirSync(path.join(root, 'packages/activity/schema')).filter(name => name.endsWith('.schema.json'))) assert.ok(files.has(`packages/activity/schema/${name}`), name);
  const rustSources = [...files].filter(file => file.endsWith('.rs'));
  let embedded = 0;
  for (const file of rustSources) {
    for (const [, target] of readFileSync(path.join(root, file), 'utf8').matchAll(/include_str!\("([^"]+)"\)/g)) {
      embedded++;
      assert.ok(files.has(path.posix.normalize(path.posix.join(path.posix.dirname(file), target))), `${file} embeds ${target}, which is not a host source`);
    }
  }
  assert.ok(embedded >= 2, 'the approved policy and the schema index are embedded with include_str!');
  for (const file of files) assert.doesNotMatch(file, /(^|\/)(node_modules|target|gen|autogenerated|dist|\.conformance-out)\/|\.DS_Store$|frozen-1\.0\.json$/, file);
});

test('hostSourceDigest changes with any host source and names the file; build outputs, Finder files and unread schema files leave it unchanged', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'host-sources-'));
  const write = (file, text) => { mkdirSync(path.dirname(path.join(directory, file)), { recursive: true }); writeFileSync(path.join(directory, file), text); };
  try {
    write(HOST_RS, 'pub fn a() {}');
    write('examples/study-harness-tauri/src-tauri/src/tests.rs', '#[test] fn t() {}');
    write('examples/study-harness-tauri/src/app.ts', 'export {};');
    write('packages/activity/schema/index.json', '{}');
    write('packages/activity/schema/study-harness.activity-records.schema.json', '{}');
    write('packages/activity/schema/frozen-1.0.json', '{}');
    const built = hostSourceDigest(directory);
    assert.deepEqual(built.entries.map(entry => entry.path), ['examples/study-harness-tauri/src-tauri/src/host.rs', 'examples/study-harness-tauri/src-tauri/src/tests.rs', 'examples/study-harness-tauri/src/app.ts', 'packages/activity/schema/index.json', 'packages/activity/schema/study-harness.activity-records.schema.json']);
    assert.equal(built.digest, sourcesOf(Object.fromEntries(built.entries.map(entry => [entry.path, entry.sha256]))).digest);
    for (const output of ['examples/study-harness-tauri/src-tauri/target/release/study-harness-reference', 'examples/study-harness-tauri/src-tauri/gen/schemas/acl-manifests.json',
      'examples/study-harness-tauri/src-tauri/permissions/autogenerated/get_policy.toml', 'examples/study-harness-tauri/dist/index.html', 'examples/study-harness-tauri/.conformance-out/dist/index.html',
      'examples/study-harness-tauri/node_modules/x/index.js', 'examples/study-harness-tauri/src-tauri/src/.DS_Store', 'packages/activity/rust/target/debug/x']) write(output, 'output');
    write('packages/activity/schema/frozen-1.0.json', '{"amended":true}');
    assert.equal(hostSourceDigest(directory).digest, built.digest);
    assert.deepEqual(sourceChanges(built, hostSourceDigest(directory)), []);
    // The verifier's case: host.rs edited after the apps were built.
    write(HOST_RS, 'pub fn a() { b() }');
    const edited = hostSourceDigest(directory);
    assert.notEqual(edited.digest, built.digest);
    assert.deepEqual(sourceChanges(built, edited), [`${HOST_RS} (changed)`]);
    write('examples/study-harness-tauri/src/new.ts', 'export {};');
    rmSync(path.join(directory, 'examples/study-harness-tauri/src-tauri/src/tests.rs'));
    assert.deepEqual(sourceChanges(built, hostSourceDigest(directory)), [`${HOST_RS} (changed)`, 'examples/study-harness-tauri/src-tauri/src/tests.rs (removed)', 'examples/study-harness-tauri/src/new.ts (added)']);
    assert.equal(changeList(['a', 'b', 'c'], 2), 'a, b, and 1 more');
    // --no-build refuses an app whose sources changed since it was built, and a record that names no sources.
    const packed = { packManifest: null, packages: PACK };
    const dist = { digest: `sha256:${'d'.repeat(64)}`, files: 1 };
    const record = createBuildRecord({ kind: 'conformance', command: 'npx tauri build', builtAt: '2026-10-27T06:42:50.744Z', executable: 'x/app', executableSha256: SHA.conformance, packed, dist: 'dist', distDigest: dist, sources: built });
    const reuse = { kind: 'conformance', record, executableSha256: SHA.conformance, packed, distDigest: dist };
    assert.deepEqual(noBuildProblems({ ...reuse, sources: built }), []);
    assert.deepEqual(noBuildProblems({ ...reuse, sources: edited }), [`conformance: the reference host sources changed since the app was built (${HOST_RS} (changed))`]);
    assert.match(noBuildProblems({ ...reuse, sources: undefined }).join(), /reference host sources changed since the app was built/);
    assert.match(noBuildProblems({ ...reuse, record: { ...record, sources: null }, sources: built }).join(), /does not name the reference host sources the app was built from/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the native gate refuses evidence whose apps were not built from the reference host sources in the tree', () => {
  assert.equal(evaluate(fullEvidence()).status, STATUS.pass);
  const edited = sourcesOf({ [HOST_RS]: '9'.repeat(64), 'packages/activity/schema/index.json': '8'.repeat(64) });
  // host.rs edited after the run, with the binaries and their sha256 unchanged.
  const stale = evaluate(fullEvidence(), onDisk(), edited);
  assert.equal(stale.status, STATUS.fail);
  assert.equal(stale.reason, `the reference host sources changed since the packaged apps were built (${HOST_RS} (changed)); run with --native=run`);
  assert.deepEqual(stale.details.sources, { builtFrom: SOURCES.digest, atEndOfRun: SOURCES.digest, inTree: edited.digest, changedInTree: [`${HOST_RS} (changed)`] });
  assert.match(evaluate(fullEvidence(), onDisk(), null).reason, /reference host sources in this tree could not be read/);
  // Evidence written before build records named sources.
  const legacy = fullEvidence();
  delete legacy.builds.conformance.sources;
  assert.match(evaluate(legacy).reason, /does not record the reference host sources the packaged conformance app was built from/);
  // Sources edited while the run was going on, or between the two builds.
  const during = fullEvidence();
  during.sources = { ...during.sources, atEnd: { digest: edited.digest, files: 2 }, changedSinceBuild: [`${HOST_RS} (changed)`] };
  assert.equal(evaluate(during).reason, `the reference host sources changed during the packaged run (${HOST_RS} (changed)); run with --native=run`);
  const unrecorded = fullEvidence();
  delete unrecorded.sources;
  assert.match(evaluate(unrecorded).reason, /does not record the reference host sources at the end of the packaged run/);
  const split = fullEvidence();
  split.builds.conformance.sources = edited;
  assert.equal(evaluate(split).reason, `the packaged release and conformance apps were built from different reference host sources (${HOST_RS} (changed)); run with --native=run`);
});

test('the runner reads the host sources before and after each build, refuses a source change during a build or before a reuse, and fails a run whose sources changed', () => {
  const runner = readFileSync(path.join(root, 'examples/study-harness-tauri/scripts/conformance.mjs'), 'utf8');
  // The build's own policy step runs first, so the sources read before the build are the ones it embeds.
  assert.match(runner, /generate-approved-policy\.mjs'\)\][\s\S]{0,300}const sourcesBefore = hostSourceDigest\(repoRoot\);\n  const result = spawnSync\('npx', command/);
  assert.match(runner, /const sources = hostSourceDigest\(repoRoot\);\n  const changedWhileBuilding = sourceChanges\(sourcesBefore, sources\);\n  if \(changedWhileBuilding\.length\) throw new Error/);
  assert.match(runner, /distDigest: treeDigest\(build\.dist\), sources,\n  \}\);/);
  // --display-only merges only into evidence of binaries built from the sources in the tree.
  assert.match(runner, /if \(!builtFrom\?\.digest\) refuse\([\s\S]{0,200}const changed = sourceChanges\(builtFrom, hostSourceDigest\(repoRoot\)\);\n    if \(changed\.length\) refuse\(/);
  // The end of every run reads them again; a change fails the run and is written into the evidence.
  assert.match(runner, /const sourcesAtEnd = hostSourceDigest\(repoRoot\);\nconst sourcesChanged = \[\.\.\.new Set\(\['conformance', 'release'\]\.flatMap\(\(kind\) => sourceChanges\(builds\[kind\]\?\.sources, sourcesAtEnd\)\)\)\]\.sort\(\);/);
  assert.match(runner, /sourcesUnchangedSinceBuild: !sourcesChanged\.length,\n  \},\n  sources: sourceRecord,/);
  assert.match(runner, /process\.exitCode = evidence\.summary\.fail \|\| sourcesChanged\.length \? 1 : 0;/);
  // The release pipeline compares the evidence with the tree it verifies.
  const pipeline = readFileSync(path.join(root, 'scripts/study-harness/release-pipeline.mjs'), 'utf8');
  assert.match(pipeline, /evaluateNativeEvidence\(\{ evidence, packedArtifacts, pack: pack\.packages, binaries, sources: hostSourceDigest\(ROOT\) \}\)/);
});
