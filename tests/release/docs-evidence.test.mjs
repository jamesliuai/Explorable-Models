// Public documents agree with the recorded evidence (report §20 "reconcile public docs with final behavior", §22.3;
// A60): relative links and heading anchors resolve (R34); statements about packaged runs name runs that exist and
// state their console-lock state and check counts as recorded (R31, R33); and the numbers performance.md quotes are the
// numbers of the immutable history records it cites (R32, R23).
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { REQUIRED_TARGET_KEYS, TARGET_STATUS, benchmarkOutcome, evaluateTargets } from '../../scripts/study-harness/benchmark-evidence.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = file => readFileSync(path.join(root, file), 'utf8');
const markdownIn = directory => readdirSync(path.join(root, directory)).filter(name => name.endsWith('.md')).map(name => path.join(directory, name));
const DOCS = [
  'README.md', 'CHANGELOG.md', 'SECURITY.md', 'CONTRIBUTING.md', 'docs/release.md', 'docs/embedding.md', 'docs/authoring.md', 'docs/architecture.md', 'docs/tooling.md',
  ...markdownIn('docs/study-harness'), ...markdownIn('docs/study-harness/evidence'),
  ...readdirSync(path.join(root, 'packages')).map(name => `packages/${name}/README.md`), ...readdirSync(path.join(root, 'examples')).map(name => `examples/${name}/README.md`),
].filter(file => existsSync(path.join(root, file)));

/** GitHub heading anchors (lower case; punctuation other than hyphens and underscores removed; spaces to hyphens; duplicates numbered). */
function anchorsOf(text) {
  const prose = text.replace(/```[\s\S]*?```/g, '');
  const seen = new Map(), out = new Set();
  for (const [, heading] of prose.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
    const slug = heading.trim().toLowerCase().replace(/<[^>]+>/g, '').replace(/`/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    out.add(count ? `${slug}-${count}` : slug);
  }
  for (const [, id] of prose.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) out.add(id);
  return out;
}

test('R34: every relative link and heading anchor in the public and handoff documents resolves', () => {
  const problems = [];
  for (const file of DOCS) {
    const text = read(file).replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      if (/^(https?:|mailto:)/.test(target)) continue;
      const [relative, anchor] = target.split('#');
      const resolved = relative ? path.resolve(path.dirname(path.join(root, file)), decodeURIComponent(relative)) : path.join(root, file);
      if (!existsSync(resolved)) { problems.push(`${file}: missing file ${target}`); continue; }
      if (anchor && statSync(resolved).isFile() && resolved.endsWith('.md') && !anchorsOf(readFileSync(resolved, 'utf8')).has(anchor)) problems.push(`${file}: missing anchor ${target}`);
    }
  }
  assert.deepEqual(problems, []);
  // The slugger keeps the section-number suffix GitHub produces.
  assert.ok(anchorsOf('## 10 Host refusals and persistence failures (§6.3, §7.2)').has('10-host-refusals-and-persistence-failures-63-72'));
});

const native = JSON.parse(read('docs/study-harness/evidence/native-conformance.json'));
const RUN_ID = /\b((?:full|partial|display-only)-\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)\b/g;
/** Lines of the documents that make claims about packaged runs (the unreleased CHANGELOG section only). */
function claimLines() {
  const changelog = read('CHANGELOG.md');
  const unreleased = changelog.slice(0, changelog.indexOf('\n## ', changelog.indexOf('unreleased')));
  const sources = { 'README.md': read('README.md'), 'CHANGELOG.md (unreleased)': unreleased, 'docs/study-harness/README.md': read('docs/study-harness/README.md'), 'docs/study-harness/performance.md': read('docs/study-harness/performance.md') };
  // Sentences (clauses up to `.` or `;`) of paragraphs, list items and table rows, joined across wrapped lines, so a
  // claim is judged together with the run it names and not with a general remark next to it.
  return Object.entries(sources).flatMap(([file, text]) => text.split(/\n(?=\s*(?:[-|#]|\d+\.)\s)|\n\s*\n|\s\|\s/)
    .flatMap(block => block.replace(/\s+/g, ' ').split(/(?<=[.;])\s+/)).map(sentence => ({ file, text: sentence })));
}

test('R31/R33: statements about packaged runs name recorded runs and agree with their console state and check counts', () => {
  const runs = new Map((native.runs ?? []).map(run => [run.id, run]));
  const current = (native.runs ?? []).filter(run => !run.superseded);
  const latest = current.at(-1);
  const problems = [];
  let cited = 0;
  for (const { file, text } of claimLines()) {
    const ids = [...text.matchAll(RUN_ID)].map(match => match[1]);
    for (const id of ids) {
      const run = runs.get(id);
      if (!run) { problems.push(`${file}: names packaged run ${id}, which the evidence does not record`); continue; }
      cited++;
      if (ids.length !== 1) continue;
      if (/console (session )?unlocked|unlocked console/i.test(text) && run.consoleSession?.lockedAtStart !== false) problems.push(`${file}: says ${id} ran with the console unlocked; the evidence records ${JSON.stringify(run.consoleSession)}`);
      if (/(?<!un)locked console|console (session )?(was )?locked|had the console session locked/i.test(text) && run.consoleSession?.lockedAtStart !== true) problems.push(`${file}: says ${id} ran with the console locked; the evidence records ${JSON.stringify(run.consoleSession)}`);
      const counts = text.match(/passed (\d+) of (\d+) checks/);
      if (counts && run.summary && (Number(counts[1]) !== run.summary.pass || Number(counts[2]) !== run.summary.pass + run.summary.fail + run.summary.notRunEnvironment + run.summary.notRun)) problems.push(`${file}: says ${id} passed ${counts[1]} of ${counts[2]} checks; its run record says ${JSON.stringify(run.summary)}`);
      if (/latest (packaged )?run/i.test(text.slice(0, text.indexOf(id))) && !/latest run (and its|with its|is always)/i.test(text) && id !== latest?.id) problems.push(`${file}: calls ${id} the latest packaged run; the latest is ${latest?.id}`);
    }
    if (!ids.length && /latest (packaged )?run/i.test(text) && /packaged|display-dependent/i.test(text)) {
      if (/(?<!un)locked console|console (session )?(was )?locked|had the console session locked/i.test(text) && latest?.consoleSession?.lockedAtStart !== true) problems.push(`${file}: says the latest packaged run had the console locked; the evidence records ${JSON.stringify(latest?.consoleSession)} for ${latest?.id}`);
      if (/display-dependent[^.]*not run|recorded as not run/i.test(text) && !(native.summary?.notRunEnvironment > 0)) problems.push(`${file}: says display-dependent checks of the latest run were not run; the evidence records ${native.summary?.notRunEnvironment} not run (environment)`);
    }
  }
  assert.deepEqual(problems, []);
  assert.ok(cited >= 3, 'README, CHANGELOG and the subsystem README name the packaged run they report');
});

test('R23: no document asserts a console lock state for the benchmark that its evidence does not record', () => {
  const performance = read('docs/study-harness/performance.md');
  assert.doesNotMatch(performance, /console session of this machine was locked during this work/);
  const evidence = JSON.parse(read('docs/study-harness/evidence/performance.json'));
  const session = evidence.results?.environment?.consoleSession;
  assert.equal(typeof session, 'object', 'the latest benchmark evidence records the measured console session state');
  assert.ok([true, false, null].includes(session.lockedAtStart) && [true, false, null].includes(session.lockedAtEnd));
});

const n = value => (typeof value === 'number' ? value.toLocaleString('en-US') : String(value));
/** The append-only records performance.md cites (envelope.record), by kind. */
function citedRecords(doc) {
  const cited = kind => {
    const links = [...new Set([...doc.matchAll(new RegExp(`\\(evidence/(history/${kind}-[0-9TZ:.-]+\\.json)\\)`, 'g'))].map(match => match[1]))];
    assert.equal(links.length, 1, `performance.md cites exactly one ${kind} history record (found ${links.join(', ') || 'none'})`);
    const envelope = JSON.parse(read(`docs/study-harness/evidence/${links[0]}`));
    assert.equal(envelope.schema, 'study-harness.evidence-history/1');
    assert.equal(envelope.kind, kind);
    return envelope.record;
  };
  return { performance: cited('performance'), consumer: cited('consumer') };
}

test('R32: every run-specific number performance.md quotes is the number of the history record it cites', () => {
  const doc = read('docs/study-harness/performance.md').replace(/\s+/g, ' ');
  const { performance, consumer } = citedRecords(read('docs/study-harness/performance.md'));
  const r = performance.results, t = r.twoD;
  const expect = text => assert.ok(doc.includes(text), `performance.md should say: ${text}`);
  // The cited benchmark run is a complete, passing, identified full run (R08, R23, R35).
  assert.equal(performance.quick, false);
  assert.equal(performance.outcome?.status, 'pass');
  // ... and still passes when its results are re-judged by the current rules (no row it reports goes unmeasured).
  const budgets = JSON.parse(read('docs/study-harness/budgets.json'));
  const rejudged = benchmarkOutcome({ ...performance, targets: evaluateTargets(performance, budgets) });
  assert.equal(rejudged.status, 'pass', rejudged.problems.join('; '));
  assert.equal(typeof performance.source?.commit, 'string');
  assert.match(performance.packageLock?.sha256 ?? '', /^[0-9a-f]{64}$/);
  expect(`benchmark run ${performance.createdAt}`);
  expect(`packed-consumer run ${consumer.createdAt}`);
  expect(`${performance.targets.filter(item => item.met === true).length} targets met, none missed`);
  assert.equal(performance.build.pack.createdAt, consumer.pack.createdAt, 'the benchmark measured the cited consumer run\'s build');
  expect(`pack of ${consumer.pack.createdAt}`);
  const session = r.environment.consoleSession;
  if (/recorded the session unlocked at both points/.test(doc)) assert.deepEqual([session.lockedAtStart, session.lockedAtEnd], [false, false]);
  // §3 targets.
  const q = t.preview['quadratic-eta'], fd = t.preview['function-derivative-A'], slow = t.slowEvaluator.preview;
  expect(`p95 ${q.inputAck.p95} ms (quadratic η, n = ${q.inputAck.count}), ${fd.inputAck.p95} ms (function/derivative with a second active card, n = ${fd.inputAck.count}), ${slow.inputAck.p95} ms with every worker reply held 250 ms (n = ${slow.inputAck.count}); ${q.unacknowledged + fd.unacknowledged + slow.unacknowledged} inputs left unacknowledged`);
  expect(`${q.frameRateFps.p50} fps display frames, ${q.droppedFrames + fd.droppedFrames} dropped frames`);
  expect(`(${q.inputRateHz.p50} Hz input → ${q.previewUpdateRateHz.p50} Hz; ${fd.inputRateHz.p50} Hz → ${fd.previewUpdateRateHz.p50} Hz), input → tentative frame painted p95 ${q.previewLatency.p95} ms`);
  const c = t.commit;
  expect(`quadratic with linked trace and math ${c['quadratic-linked-trace-and-math'].total.p95} ms; function/derivative (two 401-sample curves) ${c['function-derivative-401-sample-curves'].total.p95} ms; linear transformation ${c['linear-transformation-grid'].total.p95} ms; two active cards alternating ${c['two-active-alternating'].total.p95} ms; with 22 suspended history cards ${t.history.commitWithHistory.total.p95} ms; document-path wave ${r.documentPath.wave.total.p95} ms`);
  const single = [c['quadratic-linked-trace-and-math'], c['function-derivative-401-sample-curves'], c['linear-transformation-grid'], t.history.commitWithHistory];
  const workers = single.map(item => item.workerEvaluation.p95), renders = [...single, c['two-active-alternating']].map(item => item.render.p95);
  expect(`Worker evaluation p95 ${Math.min(...workers)}–${Math.max(...workers)} ms (${c['two-active-alternating'].workerEvaluation.p95} ms when two cards alternate), render ${Math.min(...renders)}–${Math.max(...renders)} ms`);
  expect(`1,001-iterate quadratic scene (trace table capped at 200 rows) ${t.largest.navigation.total.p95} ms; document path 1,001-sample curve ${r.documentPath['1001-sample-curve'].total.p95} ms, 100-mark scene ${r.documentPath['100-mark-scene'].total.p95} ms, 5,000-row dataset ${r.documentPath['5000-row-dataset'].total.p95} ms`);
  expect(`with a 25 ms journal-append latency the frame p95 is ${t.storage.commit.total.p95} ms while the host acknowledgement p95 is ${t.storage.commit.storageAck.p95} ms; persist-before-reveal: revealed content painted ${t.reveal.hostLatency0ms.displayed.p95} ms p95 at 0 ms host latency and ${t.reveal.hostLatency30ms.displayed.p95} ms at 30 ms (display acknowledgement persisted at ${t.reveal.hostLatency30ms.displayAckPersisted.p95} ms)`);
  const quiet = t.history.quiet;
  expect(`${t.history.cards} suspended history cards over 2 s: ${quiet.workerMessages} worker messages, ${quiet.evaluations} evaluations, ${quiet.domMutations} DOM mutations, ${quiet.notifications} projection notifications; page-wide ${t.history.pageWide.animationFrames} animation frames`);
  const life = r.lifecycle;
  expect(`${life.workers.created} workers created and terminated, ${life.workers.liveAfter} live afterwards (peak ${life.workers.peak}); ${life.timersPendingFromCycles} timers, ${life.intervalsLiveFromCycles} intervals`);
  expect(`A cycle takes p50 ${life.duration.p50} ms / p95 ${life.duration.p95} ms`);
  const v = r.spatial['vector-orientation-3d'], sq = r.spatial['quadratic-surface-gradient'];
  expect(`commit → renderer frame p95 ${v.commit.rendererFrame.p95} ms (vector orientation) and ${sq.commit.rendererFrame.p95} ms (quadratic surface); camera command → renderer frame ${v.cameraCommand.rendererFrame.p95} and ${sq.cameraCommand.rendererFrame.p95} ms; pointer orbit input → renderer frame p95 ${v.pointerOrbit.inputAck.p95} and ${sq.pointerOrbit.inputAck.p95} ms at ${Math.round(v.pointerOrbit.frameRateFps)} fps`);
  expect(`resize re-layout to paint p95 ${t.resize.relayout.p95} ms with ${t.resize.workerMessages} worker messages`);
  const stall = t.stalledPersistence;
  expect(`(outbox limit ${stall.outboxLimit}), ${stall.acceptedWhileStalled} commits render normally and commit ${stall.refusal.commit + 1} is refused with \`${stall.refusal.codes.join(', ')}\``);
  expect(`the outbox drains in ≈ ${Math.round(stall.drainMs)} ms once the host resumes`);
  // §4 findings measured in the cited runs.
  const burst = t.rapidInputs;
  expect(`${burst.within64.runs} bursts of ${burst.within64.updatesPerRun} and ${burst.burst200.runs} bursts of ${burst.burst200.updatesPerRun} calls painted the newest value every time, with ${Math.max(...burst.within64.workerMessagesDuringPreview, ...burst.burst200.workerMessagesDuringPreview)} worker messages per preview and ${burst.within64.refusedUpdates + burst.burst200.refusedUpdates} refused updates`);
  assert.ok([...burst.within64.newestValueShown, ...burst.burst200.newestValueShown].every(Boolean));
  const overlap = t.slowEvaluator.dragDuringPendingCommit;
  expect(`the control left the held pointer value in ${overlap.controlLeftPointerValue} of ${overlap.attempts.length} attempts`);
  const soft = r.spatialSoftware;
  expect(`commit → renderer frame is p95 ${soft['quadratic-surface-gradient'].commit.rendererFrame.p95} ms and pointer-orbit input → frame ${soft['quadratic-surface-gradient'].pointerOrbit.inputAck.p95} ms (vector orientation ${soft['vector-orientation-3d'].commit.rendererFrame.p95} ms and ${soft['vector-orientation-3d'].pointerOrbit.inputAck.p95} ms); on the M3 GPU the same workloads take ${sq.commit.rendererFrame.p95} ms and ${sq.pointerOrbit.inputAck.p95} ms`);
  // §6 heap and host records.
  const mib = bytes => (bytes / 2 ** 20).toFixed(2);
  const heap = life.heap.samples, at30 = heap.find(item => item.cycle === 30), later = heap.filter(item => item.cycle >= 30).map(item => item.usedJSHeapSize);
  expect(`rose from ${mib(heap[0].usedJSHeapSize)} MiB to ${mib(at30.usedJSHeapSize)} MiB over the first 30 cycles`);
  expect(`stayed between ${mib(Math.min(...later))} and ${mib(Math.max(...later))} MiB over cycles 30–100`);
  expect(`grew linearly from ${mib(heap[0].hostRecordChars)} to ${mib(heap.at(-1).hostRecordChars)} MiB of JSON text`);
  // Bytes and installation (§3, §4 F1, §5) from the cited packed-consumer run.
  const b = consumer.budgets, dom = b.activityEntry['activity.html'], react = b.activityEntry['activity-react.html'];
  expect(`${n(b.legacy2dConsumer.gzipBytes)} B (the \`verify-packages.mjs\` rule)`);
  expect(`${n(dom.gzip9)} B plain-DOM entry, ${n(react.gzip9)} B React entry`);
  expect(`**${n(dom.gzip9)} B** plain DOM and **${n(react.gzip9)} B** React, ${n(b.activityEntry['activity.html'].maxGzipBytes - dom.gzip9)} B and ${n(react.maxGzipBytes - react.gzip9)} B under the ceiling`);
  expect(`main chunk (${n(dom.chunks.find(item => !item.worker).gzip9)} B gzip) and the kernel worker (${n(dom.chunks.find(item => item.worker).gzip9)} B gzip)`);
  const content = b.catalogueContent.chunks;
  expect(`${n(b.catalogueContent.lazy)} B raw, sits in five lazy chunks of ${n(Math.min(...content.map(item => item.bytes)))}–${n(Math.max(...content.map(item => item.bytes)))} B (${n(Math.min(...content.map(item => item.gzip9)))}–${n(Math.max(...content.map(item => item.gzip9)))} B gzip)`);
  assert.equal(content.length, 5);
  expect(`| Existing 2D consumer (all JS, default gzip) | ${n(b.legacy2dConsumer.gzipBytes)} B |`);
  expect(`| Activity entry, plain DOM (eager JS incl. worker, gzip9) | ${n(dom.gzip9)} B (${n(dom.bytes)} B raw) |`);
  expect(`| Activity entry, React | ${n(react.gzip9)} B (${n(react.bytes)} B raw) |`);
  expect(`| Lazy KaTeX JS | ${n(b.lazy.math.js.bytes)} B raw, ${n(b.lazy.math.js.gzip9)} B gzip9 |`);
  expect(`| KaTeX stylesheet | ${n(b.lazy.math.css.bytes)} B raw, ${n(b.lazy.math.css.gzip9)} B gzip9 |`);
  expect(`| KaTeX fonts (${b.lazy.math.fonts.files} woff2; only faces in use are fetched) | ${n(b.lazy.math.fonts.bytes)} B |`);
  expect(`| Inter UI fonts (${b.lazy.uiFonts.files} woff2, only with \`fonts: 'bundled'\`) | ${n(b.lazy.uiFonts.bytes)} B |`);
  expect(`| Lazy 3D (player-3d + three 0.186.1, one chunk) | ${n(b.lazy.spatial.bytes)} B raw, ${n(b.lazy.spatial.gzip9)} B gzip9 |`);
  expect(`| Catalogue content, all five templates (raw) | ${n(b.catalogueContent.total)} B,`);
  expect(`clean install from tarballs with an empty cache (${Math.round(consumer.install.durationMs / 1000)} s)`);
  // F3 quotes its own measurement file.
  const stalled = JSON.parse(read('docs/study-harness/evidence/stalled-persistence.json'));
  expect(`after p50 ${n(stalled.stageTransitionMs.p50)} ms, p95 ${n(stalled.stageTransitionMs.p95)} ms (max ${n(stalled.stageTransitionMs.max)} ms)`);
  expect(`In the same runs ${stalled.acceptedWhileStalled[0]} commits rendered before the ${stalled.acceptedWhileStalled[0] + 1}nd was refused`);
  assert.ok(stalled.acceptedWhileStalled.every(value => value === stalled.acceptedWhileStalled[0]));
});

test('R08/A60: performance.md states the outcome rules benchmark-evidence.mjs applies to reported-only and software-WebGL rows', () => {
  const doc = read('docs/study-harness/performance.md').replace(/\s+/g, ' ');
  const expect = text => assert.ok(doc.includes(text), `performance.md should say: ${text}`);
  // The documented rule: reported-only rows are required like targets, and only two machine conditions are environment gaps.
  expect('A reported-only measure has no §18 number and is never judged against one, but it is required like a target.');
  expect('whether the row carries a target or is reported only: the row stays in the evidence as "not measured" with `met: false`');
  expect('a software-WebGL run with no WebGL 2 context at all for the software rows');
  // ... and the code applies it: every reported-only spatial key is required, and an unmeasured one is met: false.
  const reportedOnly = REQUIRED_TARGET_KEYS.filter(key => /^spatial-(software|commit|camera):/.test(key));
  assert.equal(reportedOnly.length, 6);
  const captured = JSON.parse(read('tests/release/fixtures/benchmark/performance-run.json'));
  const evidence = { ...captured, quick: false, consoleErrors: [], results: { ...captured.results, spatial: { diagnostics: [] }, spatialSoftware: { diagnostics: [], webglRenderer: 'SwiftShader', cspViolations: [] } } };
  const targets = evaluateTargets(evidence, JSON.parse(read('docs/study-harness/budgets.json')));
  for (const key of reportedOnly) {
    const row = targets.find(item => item.key === key);
    assert.equal(row.status, TARGET_STATUS.notMeasured, key);
    assert.equal(row.met, false, key);
  }
  assert.equal(benchmarkOutcome({ ...evidence, targets }).exitCode, 1);
});
