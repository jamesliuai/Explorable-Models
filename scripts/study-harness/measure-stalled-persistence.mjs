#!/usr/bin/env node
// Focused re-measurement of one benchmark scenario: a host stage transition while journal appends are stalled
// (report §18 "stalled persistence"; performance.md F3). It runs the benchmark page's own `stalledPersistence` scenario
// (examples/study-harness-consumer/src/bench.ts) on the PRODUCTION packed consumer under the production CSP, in
// Playwright Chromium on this machine, after one discarded warmup, and reports nearest-rank p50/p95/max with the sample
// count. The adapter runs with its default `persistenceWaitMs` (1,000 ms).
//
//   node scripts/study-harness/verify-consumer.mjs                # builds release/study-harness/consumer/dist
//   node scripts/study-harness/measure-stalled-persistence.mjs [--runs 8]
//
// Writes docs/study-harness/evidence/stalled-persistence.json. Scope: one desktop machine, Chromium, production bundle,
// in-memory fixture host; not WKWebView and not the Study Harness application.
import { readFile, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { CONSUMER_OUT, ROOT, cspRecorder, quantiles, serveDist, watchPage } from './verify-consumer.mjs';

const runsArg = process.argv.indexOf('--runs');
const RUNS = runsArg > 0 ? Math.max(3, Math.min(30, Number(process.argv[runsArg + 1]) || 8)) : 8;
const dist = path.join(CONSUMER_OUT, 'dist');
const OUT = path.join(ROOT, 'docs/study-harness/evidence/stalled-persistence.json');

const built = await stat(path.join(dist, 'bench.html')).catch(() => null);
if (!built) { console.error('[stalled-persistence] release/study-harness/consumer/dist is missing: run node scripts/study-harness/verify-consumer.mjs first.'); process.exit(1); }
let pack = null;
try { pack = JSON.parse(await readFile(path.join(ROOT, 'release/study-harness/packages/manifest.json'), 'utf8')); } catch { pack = null; }

const server = await serveDist(dist);
const browser = await chromium.launch({ headless: true });
const samples = [];
const errors = [];
try {
  for (let run = 0; run <= RUNS; run++) {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    await context.addInitScript(cspRecorder);
    const page = await context.newPage();
    const log = watchPage(page);
    await page.goto(`${server.base}/bench.html`);
    await page.waitForFunction(() => document.body.dataset.ready === 'true', undefined, { timeout: 30_000 });
    const result = await page.evaluate(() => window.bench.stalledPersistence({ outboxLimit: 24, maxCommits: 60 }));
    const csp = await page.evaluate(() => window.__cspViolations ?? []);
    errors.push(...log.errors, ...csp.map(item => `csp: ${JSON.stringify(item)}`));
    await context.close();
    if (result.error) throw new Error(result.error);
    if (run === 0) continue; // discarded warmup
    samples.push({
      stageTransition: result.stageTransitionWhileStalled, acceptedWhileStalled: result.acceptedWhileStalled, refusal: result.refusal,
      presentation: result.presentationWhileStalled, chip: result.chipWhileStalled, drainMs: result.drainMs, afterRelease: result.afterRelease,
    });
  }
} finally {
  await browser.close();
  await server.close?.();
}

const transition = samples.map(sample => sample.stageTransition.resolvedAfterMs);
const record = {
  contract: 'experiment-kit.measurement', scenario: 'stalled-persistence stage transition (benchmark bench.stalledPersistence)',
  createdAt: new Date().toISOString(), runs: samples.length, warmups: 1,
  adapter: { persistenceWaitMs: 1000, outboxLimit: 24 },
  environment: { platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model ?? null, cores: os.cpus().length, node: process.version, chromium: browser.version(), loadavg: os.loadavg() },
  consumer: { dist: path.relative(ROOT, dist), builtAt: built.mtime.toISOString(), pack: pack ? { createdAt: pack.createdAt ?? null, packages: (pack.packages ?? []).map(item => ({ name: item.name, sha256: item.sha256 ?? item.digest ?? null })) } : null },
  stageTransitionMs: quantiles(transition),
  stageTransitionCodes: [...new Set(samples.map(sample => sample.stageTransition.ok ? 'ok' : sample.stageTransition.codes.join('+')))],
  acceptedWhileStalled: [...new Set(samples.map(sample => sample.acceptedWhileStalled))],
  refusalCodes: [...new Set(samples.map(sample => sample.refusal?.codes.join('+') ?? 'none'))],
  presentationWhileStalledMs: quantiles(samples.map(sample => sample.presentation.totalMs)),
  presentationWhileStalledOk: samples.every(sample => sample.presentation.ok),
  drainMs: quantiles(samples.map(sample => sample.drainMs)),
  afterReleaseOk: samples.every(sample => sample.afterRelease.ok),
  chips: [...new Set(samples.map(sample => sample.chip?.text ?? ''))],
  errors,
  samples,
};
await writeFile(OUT, `${JSON.stringify(record, null, 2)}\n`);
console.log(`[stalled-persistence] ${samples.length} runs: stage transition ${record.stageTransitionCodes.join(', ')} after p50 ${record.stageTransitionMs.p50?.toFixed?.(1)} ms, p95 ${record.stageTransitionMs.p95?.toFixed?.(1)} ms, max ${record.stageTransitionMs.max?.toFixed?.(1)} ms; ${path.relative(ROOT, OUT)}`);
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
