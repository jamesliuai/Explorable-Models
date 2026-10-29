// Synthetic release records and real temporary archives/tarballs exercise identity refusal without running gates.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  PLAN_SCHEMA, RERUN_GATES, auditResume, evaluateConsumer, parseResumeArgs, readArchive, reusedGate, sourceFiles,
  validateChanges, validateParent, verifyPack,
} from '../../scripts/study-harness/resume-release.mjs';
import { GATES, SCHEMA, STATUS, STEP_IDS, summarize } from '../../scripts/study-harness/release-pipeline.mjs';
import { sha256Hex } from '../../scripts/study-harness/evidence-identity.mjs';

const hash = value => sha256Hex(value);
const digest = hash('six-package-manifest');
function fullParent() {
  const gates = STEP_IDS.map(id => ({ id, status: ['test:cross-browser', 'native'].includes(id) ? STATUS.fail : STATUS.pass, ...(id === 'pack' ? { manifestSha256: digest } : { pack: digest }) }));
  return {
    schema: SCHEMA, runId: 'full-parent', status: 'fail', partial: false, releaseEvidence: false,
    generatedAt: '2026-10-29T05:00:00.000Z', selection: { only: null, skip: null },
    packageLock: { sha256: hash('lock') },
    pack: { complete: true, manifestSha256: digest, lockSha256: hash('lock'), packages: Array.from({ length: 6 }, (_, i) => ({ name: `package-${i}` })) },
    gates, summary: summarize(gates),
  };
}
function directory(t) { const root = mkdtempSync(path.join(tmpdir(), 'study-resume-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }
function put(root, file, content) { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), content); }
const change = (file = 'tests/browser/study-spatial.spec.ts') => ({ path: file, kind: 'test-synchronization', beforeSha256: hash('before'), afterSha256: hash('after'), reason: 'Wait for the queued rendered frame while retaining every assertion.' });
function changeInput() { const row = change(); return { before: [{ path: row.path, sha256: row.beforeSha256 }], current: [{ path: row.path, sha256: row.afterSha256 }], plan: { schema: PLAN_SCHEMA, changes: [row] } }; }

test('resume has a fixed complete affected-gate schedule, and refuses partial selection arguments', () => {
  assert.deepEqual(RERUN_GATES, ['typecheck', 'test', 'test:cross-browser', 'test:release', 'release', 'native']);
  assert.ok(RERUN_GATES.every(id => GATES.some(row => row.id === id)));
  assert.deepEqual(parseResumeArgs(['--parent=p', '--checkpoint=c', '--plan=r', '--check']), { check: true, parent: 'p', checkpoint: 'c', plan: 'r' });
  for (const option of ['--only=test', '--skip=native', '--native=verify', '--unknown=x']) assert.throws(() => parseResumeArgs(['--parent=p', '--checkpoint=c', '--plan=r', option]), /Unknown/);
  assert.throws(() => parseResumeArgs(['--parent=p']), /Required/);
});

test('only a completed full parent with all 19 gates can supply reusable results', () => {
  assert.equal(validateParent(fullParent()).status, 'fail');
  for (const mutation of [p => { p.partial = true; }, p => { p.selection.only = ['test']; }, p => { p.gates.pop(); }, p => { p.generatedAt = null; }, p => { p.resume = {}; }]) {
    const parent = fullParent(); mutation(parent); assert.throws(() => validateParent(parent));
  }
});

test('a failed unchanged gate, excluded gate, changed pack or false parent summary cannot be reused', () => {
  for (const mutation of [
    p => { p.gates.find(row => row.id === 'test:browser').status = STATUS.fail; p.summary = summarize(p.gates); },
    p => { p.gates[3].status = STATUS.excluded; p.summary = summarize(p.gates); },
    p => { p.gates[4].pack = hash('different'); },
    p => { p.summary.pass++; },
    p => { p.pack.packages[1].name = p.pack.packages[0].name; },
  ]) { const parent = fullParent(); mutation(parent); assert.throws(() => validateParent(parent)); }
});

test('a passing parent row with a nonzero reporter result is not reusable', () => {
  const parent = fullParent(); parent.gates.find(row => row.id === 'test').segments = [{ command: 'vitest run', runner: 'vitest', exitCode: 1, counts: { total: 2, passed: 1, failed: 1 } }];
  assert.throws(() => validateParent(parent), /segment/);
});

test('an exact reviewed synchronization delta passes without relaxing the protected-source checks', () => {
  const input = changeInput();
  input.before.push({ path: 'packages/core/src/index.ts', sha256: hash('runtime') }); input.current.push({ path: 'packages/core/src/index.ts', sha256: hash('runtime') });
  assert.deepEqual(validateChanges(input), [{ path: input.plan.changes[0].path, beforeSha256: hash('before'), afterSha256: hash('after') }]);
});

test('a runtime change is refused even if a plan attempts to authorize it', () => {
  const input = changeInput(), row = { ...change('packages/core/src/model/manifest.ts'), kind: 'verification-tooling' };
  input.plan.changes.push(row); input.before.push({ path: row.path, sha256: row.beforeSha256 }); input.current.push({ path: row.path, sha256: row.afterSha256 });
  assert.throws(() => validateChanges(input), /Unapproved change path/);
});

test('unreviewed additions, changed fixtures, removal and wrong before/after hashes all fail', () => {
  for (const mutation of [
    input => input.current.push({ path: 'tests/reference/fixtures/new.json', sha256: hash('new') }),
    input => { input.before.push({ path: 'packages/activity/schema/index.json', sha256: hash('old') }); input.current.push({ path: 'packages/activity/schema/index.json', sha256: hash('new') }); },
    input => { input.current = []; },
    input => { input.plan.changes[0].beforeSha256 = hash('wrong'); },
    input => { input.plan.changes[0].afterSha256 = hash('wrong'); },
    input => { input.plan.changes.push(input.plan.changes[0]); },
  ]) { const input = changeInput(); mutation(input); assert.throws(() => validateChanges(input)); }
});

test('a new verification file needs a null before hash; documentation is bound to its archived bytes', () => {
  const file = 'scripts/study-harness/resume-release.mjs', docs = 'docs/release.md', input = changeInput();
  input.current.push({ path: file, sha256: hash('tool') }, { path: docs, sha256: hash('new docs') });
  input.plan.changes.push({ path: file, kind: 'verification-tooling', beforeSha256: null, afterSha256: hash('tool'), reason: 'Guard every inherited result and run all affected gates again.' }, { path: docs, kind: 'documentation', beforeSha256: hash('old docs'), afterSha256: hash('new docs'), reason: 'Document the explicit resumed verification provenance and refusal rules.' });
  input.archive = new Map([[docs, { sha256: hash('old docs') }]]);
  assert.equal(validateChanges(input).length, 3);
});

test('the source inventory includes authored model.md and lock/config/fixture inputs, excluding generated output', t => {
  const root = directory(t);
  for (const name of ['packages', 'examples', 'scripts', 'tests', 'public']) mkdirSync(path.join(root, name));
  for (const name of ['package.json', 'package-lock.json', 'publication.config.json', 'tsconfig.json', 'vite.config.ts', 'vitest.config.ts', 'playwright.config.ts', 'index.html', 'agent.html', 'gallery.html', 'guide.html', 'hinged-rod.html', 'showcase.html', 'study-harness.html']) put(root, name, '{}');
  put(root, 'examples/demo/model.md', 'scientific assumptions'); put(root, 'tests/reference/fixtures/data.json', '[1]'); put(root, 'examples/native/Cargo.lock', 'lock');
  put(root, 'packages/core/dist/generated.js', 'output'); put(root, 'examples/demo/README.md', 'explanation');
  const files = sourceFiles(root).map(row => row.path);
  for (const file of ['examples/demo/model.md', 'tests/reference/fixtures/data.json', 'examples/native/Cargo.lock', 'package-lock.json', 'playwright.config.ts']) assert.ok(files.includes(file));
  assert.ok(!files.some(file => file.includes('/dist/') || file.endsWith('/README.md')));
});

test('archive auditing uses the bytes of real regular members, including long PAX paths', t => {
  const root = directory(t), long = `package/docs/${'long-'.repeat(25)}/source.ts`;
  put(root, 'package/packages/core/src/index.ts', 'export const sdk = 1;'); put(root, long, 'long path body');
  const file = path.join(root, 'original.tgz'); execFileSync('tar', ['-czf', file, '-C', root, 'package'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const archive = readArchive(readFileSync(file));
  assert.equal(archive.get('packages/core/src/index.ts').sha256, hash('export const sdk = 1;'));
  assert.equal(archive.get(long.slice('package/'.length)).bytes.toString(), 'long path body');
  const damaged = readFileSync(file); damaged[Math.floor(damaged.length / 2)] ^= 1; assert.throws(() => readArchive(damaged));
});

test('the full audit refuses a changed checkpoint or original archive before running any gate', t => {
  const root = directory(t), parent = fullParent(), parentPath = 'docs/study-harness/evidence/history/verification-parent.json';
  const archivePath = 'release/study-harness/artifacts/parent/source.tgz', archive = Buffer.from('preserved original archive');
  parent.gates.find(row => row.id === 'release').details = { sha256: `sha256:${hash(archive)}` };
  const checkpoint = { schema: 'study-harness.resume-source-checkpoint/1', createdAt: '2026-10-29T05:01:00.000Z', parentRunId: parent.runId, parentRecordSha256: hash(`${JSON.stringify(parent, null, 2)}\n`), files: [], digest: hash('[]'), sourceArchive: { path: archivePath, sha256: `sha256:${hash(archive)}` } };
  const checkpointPath = 'checkpoint.json', planPath = 'reviewed.json';
  put(root, parentPath, JSON.stringify({ schema: 'study-harness.evidence-history/1', kind: 'verification', record: parent }));
  put(root, checkpointPath, JSON.stringify(checkpoint));
  put(root, planPath, JSON.stringify({ schema: PLAN_SCHEMA, parentRunId: parent.runId, checkpointSha256: hash(readFileSync(path.join(root, checkpointPath))), review: 'Synthetic review provenance for this refusal test.', changes: [] }));
  put(root, archivePath, 'tampered archive bytes');
  assert.throws(() => auditResume({ root, parentPath, checkpointPath, planPath }), /Preserved original source archive changed/);
  put(root, checkpointPath, JSON.stringify({ ...checkpoint, digest: hash('other files') }));
  assert.throws(() => auditResume({ root, parentPath, checkpointPath, planPath }), /Checkpoint source digest is invalid/);
});

function packedFixture(t) {
  const root = directory(t), parent = fullParent(); put(root, 'package-lock.json', 'lock');
  const packages = Array.from({ length: 6 }, (_, index) => { const body = Buffer.from(`actual package bytes ${index}`), file = `package-${index}.tgz`; put(root, `release/study-harness/packages/${file}`, body); return { name: `package-${index}`, version: '1.0', file, sha256: hash(body), integrity: 'sha512-recorded', bytes: body.length }; });
  const manifest = { complete: true, packages }, bytes = JSON.stringify(manifest);
  put(root, 'release/study-harness/packages/manifest.json', bytes);
  parent.pack = { ...parent.pack, packages, manifest: 'release/study-harness/packages/manifest.json', manifestSha256: hash(bytes) };
  return { root, parent };
}
test('six actual tarballs and the root lock must still match the parent, not just their manifest', t => {
  const { root, parent } = packedFixture(t); assert.equal(verifyPack(root, parent).packages.length, 6);
  put(root, `release/study-harness/packages/${parent.pack.packages[2].file}`, 'changed runtime');
  assert.throws(() => verifyPack(root, parent), /Actual tarball changed/);
});
test('changed manifest bytes or a root lock change refuse reuse', t => {
  const { root, parent } = packedFixture(t); put(root, 'package-lock.json', 'different dependencies'); assert.throws(() => verifyPack(root, parent), /lock changed/);
  put(root, 'package-lock.json', 'lock'); put(root, parent.pack.manifest, '{}'); assert.throws(() => verifyPack(root, parent), /manifest bytes/);
});

function consumerFixture() {
  const within = { bytes: 10, gzip9: 5 }, limit = { maxBytes: 20, maxGzipBytes: 10 };
  return {
    pack: [{ name: 'core', sha256: hash('core') }],
    budgets: { dependency: { legacy2dConsumer: { maxGzipBytes: 20 }, activityEntry: { entries: ['activity.html'], maxGzipBytes: 20 }, lazyMath: { js: limit, css: limit, fonts: limit }, bundledUiFonts: limit, lazy3d: { js: limit }, catalogueContent: { maxBytes: 20 } } },
    evidence: { ok: true, checks: [{ id: 'flow', ok: true }], pack: { packages: [{ name: 'core', sha256: hash('core') }] }, budgets: { legacy2dConsumer: { gzipBytes: 10 }, activityEntry: { 'activity.html': { gzip9: 10, chunks: [{ file: 'page.js', gzip9: 6, worker: false }, { file: 'worker.js', gzip9: 4, worker: true }], inlineScripts: 0, forbiddenSources: [], forbiddenTextMarkers: [] } }, lazy: { math: { js: within, css: within, fonts: within }, uiFonts: within, spatial: within }, catalogueContent: { templatesCopyModels: 0, kernelCodeInPage: 0, chunks: [1, 2, 3, 4, 5], total: 10 } } },
  };
}
test('consumer re-evaluation uses raw numbers instead of persisted positive budget statuses', () => {
  const fixture = consumerFixture(); assert.equal(evaluateConsumer(fixture.evidence, fixture.pack, fixture.budgets).status, STATUS.pass);
  fixture.evidence.budgets.activityEntry['activity.html'].gzip9 = 21;
  fixture.evidence.budgets.activityEntry['activity.html'].ok = true;
  assert.throws(() => evaluateConsumer(fixture.evidence, fixture.pack, fixture.budgets), /activity raw budget/);
});
test('failed consumer checks, wrong package hashes and leaked eager content refuse reuse', () => {
  for (const mutate of [f => { f.evidence.checks[0].ok = false; }, f => { f.evidence.pack.packages[0].sha256 = hash('other'); }, f => { f.evidence.budgets.catalogueContent.templatesCopyModels = 1; }]) { const fixture = consumerFixture(); mutate(fixture); assert.throws(() => evaluateConsumer(fixture.evidence, fixture.pack, fixture.budgets)); }
});

test('a reused gate retains its real timestamps/counts/logs and binds parent, gate, log and report hashes', t => {
  const root = directory(t); put(root, 'release/study-harness/logs/parent/test.log', 'actual pass'); put(root, 'release/study-harness/logs/parent/report.json', '{"success":true}');
  const row = { id: 'test:browser', status: STATUS.pass, startedAt: '2026-10-29T04:00:00Z', durationMs: 42, counts: { total: 208, passed: 208 }, log: 'release/study-harness/logs/parent/test.log', segments: [{ report: 'release/study-harness/logs/parent/report.json' }] };
  const parent = { runId: 'parent', status: 'fail', history: 'immutable-parent.json', historySha256: hash('parent'), recordSha256: hash('record') }, reused = reusedGate(row, { parent }, root);
  assert.equal(reused.execution, 'reused'); assert.deepEqual(reused.counts, row.counts); assert.equal(reused.startedAt, row.startedAt); assert.equal(reused.reusedFrom.status, 'fail');
  assert.equal(reused.reusedFrom.gateRecordSha256, hash(JSON.stringify(row))); assert.equal(reused.reusedFrom.log.sha256, hash('actual pass')); assert.equal(reused.reusedFrom.reports[0].sha256, hash('{"success":true}'));
  assert.throws(() => reusedGate({ ...row, status: STATUS.fail }, { parent }, root), /Cannot reuse failed/);
});

test('derived preview records retain resumed/reused provenance without executing gates or real browsers', t => {
  const root = directory(t), origin = { runId: 'failed-parent', status: 'fail', historySha256: hash('original history'), log: { path: 'parent/chromium.log', sha256: hash('log') } };
  const ids = ['typecheck', 'test', 'test:contracts', 'test:release', 'test:browser', 'test:cross-browser', 'build', 'verify:gallery', 'pack', 'verify:packages', 'release'];
  const pipeline = {
    runId: 'resumed-candidate', status: 'pass', partial: false, mode: 'resumed-full-candidate', source: { commit: null }, summary: { gates: 19, pass: 19 }, pack: { manifestSha256: hash('pack') },
    resume: { parent: origin, rerun: [...RERUN_GATES], reused: STEP_IDS.filter(id => !RERUN_GATES.includes(id)) },
    gates: ids.map(id => ({ id, status: 'pass', startedAt: '2026-10-29T04:00:00Z', durationMs: 10, execution: RERUN_GATES.includes(id) ? 'rerun' : 'reused', ...(!RERUN_GATES.includes(id) ? { reusedFrom: origin } : {}), ...(id === 'test:cross-browser' ? { details: { engines: {}, specs: [], scope: {} } } : {}) })),
  };
  put(root, 'release/study-harness/verification.json', JSON.stringify(pipeline));
  put(root, 'release/preview/package-evidence.json', JSON.stringify({ version: 'test-only', packages: [] }));
  put(root, 'dist/release-checks.json', JSON.stringify({ reports: [], documentReports: [], externalNetwork: 'blocked' }));
  // The real derivation script runs, but browser discovery alone is a labelled test double. No gate is invoked.
  const mock = `const browser={launch:async()=>({version:()=>"TEST DOUBLE",close:async()=>{}}),executablePath:()=>"/test-double"};export{browser as chromium,browser as firefox,browser as webkit};`;
  put(root, 'mock-browser-loader.mjs', `export async function resolve(name,context,next){if(name==='playwright')return {url:${JSON.stringify(`data:text/javascript,${encodeURIComponent(mock)}`)},shortCircuit:true};return next(name,context);}`);
  const script = fileURLToPath(new URL('../../scripts/verify-preview.mjs', import.meta.url));
  execFileSync(process.execPath, ['--experimental-loader', path.join(root, 'mock-browser-loader.mjs'), script, '--from-pipeline'], { cwd: root, env: { ...process.env, GITHUB_SHA: '', GITHUB_RUN_ID: '' }, stdio: 'pipe' });
  const derived = JSON.parse(readFileSync(path.join(root, 'release/preview/verification.json'))), cross = JSON.parse(readFileSync(path.join(root, 'release/preview/cross-browser-evidence.json')));
  assert.equal(derived.pipeline.mode, 'resumed-full-candidate'); assert.deepEqual(derived.pipeline.resume, pipeline.resume); assert.deepEqual(cross.pipeline.resume, pipeline.resume);
  const chromium = derived.results.find(row => row.command === 'npm run test:browser');
  assert.equal(chromium.execution, 'reused'); assert.equal(chromium.startedAt, '2026-10-29T04:00:00Z'); assert.deepEqual(chromium.reusedFrom, origin);
  assert.equal(derived.results.find(row => row.command === 'npm run test:cross-browser').execution, 'rerun');
});

test('terminology-normalized historical copies cannot become resumed release evidence', t => {
  const root=directory(t),parentPath='docs/study-harness/evidence/history/verification-projected.json';
  put(root,parentPath,JSON.stringify({schema:'study-harness.evidence-history/1',kind:'verification',record:fullParent(),terminologyProjection:{sourceCommit:'original'}}));
  assert.throws(()=>auditResume({root,parentPath,checkpointPath:'unused.json',planPath:'unused-plan.json'}),/Terminology-normalized historical evidence cannot be resumed/);
});
