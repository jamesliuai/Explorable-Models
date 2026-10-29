#!/usr/bin/env node
// Packed-consumer verification of the Study Harness packages (report §4.1, §16, §18, §19; architecture D14; A44, A58, A59).
//
//   node scripts/study-harness/verify-consumer.mjs [--no-pack | --use-pack=<manifest sha256>] [--keep]
//
// 1. Packs all six packages with scripts/study-harness/pack.mjs (builds them first) and snapshots the tarballs, checking
//    each sha256 against the pack manifest (--no-pack reuses a complete existing pack). --use-pack=<sha256> consumes the
//    existing release/study-harness/packages pack without re-packing and refuses to start unless the manifest's bytes
//    have exactly that sha256 (the release pipeline passes the digest of the pack it made, so this run verifies the
//    same tarballs as every other gate).
// 2. Installs them into a fresh temporary directory with an isolated, EMPTY npm cache, without lifecycle scripts and
//    without monorepo aliases, next to pinned react/react-dom/three/vite (and typescript/@types for the typecheck).
// 3. Imports every public entry in plain Node (no DOM globals) — SSR-safe imports — and typechecks the consumer against
//    the packed declarations.
// 4. Builds examples/study-harness-consumer for production (Vite) and, from the same install, the existing 2D consumer
//    examples/consumer; measures the budgets in docs/study-harness/budgets.json (exact rules there) and audits the eager
//    activity graph through the emitted source maps.
// 5. Serves the production build with a strict CSP and runs, in Chromium, the quadratic flow through the real catalogue
//    worker (prepare, reveal with display acknowledgement, exploration, slider preview, exact commit, PNG capture) in the
//    plain-DOM and React entries, then the spatial entry (a 2D template never loads Three.js; a 3D template loads it
//    only then). Zero CSP violations, zero console errors and zero failed requests are required.
// 6. Writes docs/study-harness/evidence/consumer.{json,md} (the latest run) plus an append-only record in
//    docs/study-harness/evidence/history/ (also when the run throws), and copies the production build to
//    release/study-harness/consumer/ for scripts/study-harness/benchmark.mjs.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile, lstat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync, constants as zlib } from 'node:zlib';
import { commandOutput, writeHistoryRecord } from './evidence-identity.mjs';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; font-src 'self'; connect-src 'self'; worker-src 'self'";
export const CONSUMER_OUT = path.join(ROOT, 'release/study-harness/consumer');
export const BUDGETS_PATH = path.join(ROOT, 'docs/study-harness/budgets.json');
const PACKED = path.join(ROOT, 'release/study-harness/packages');
const EVIDENCE = path.join(ROOT, 'docs/study-harness/evidence');
const PACKAGES = ['core', 'activity', 'catalog', 'player', 'player-3d', 'agent'];
/** Public entries imported in Node; worker entries (`@explorable-models/catalog/worker`, `@explorable-models/core/document-worker`) start a worker loop on import and are browser-only. */
export const PUBLIC_ENTRIES = ['@explorable-models/core', '@explorable-models/core/model', '@explorable-models/core/declarative', '@explorable-models/activity', '@explorable-models/activity/conformance', '@explorable-models/catalog',
  '@explorable-models/player', '@explorable-models/player/activity', '@explorable-models/player-3d', '@explorable-models/agent'];

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.map': 'application/json',
  '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8',
};
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sha512 = bytes => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
export const gzip9 = bytes => gzipSync(bytes, { level: 9 }).length;
export const gzipDefault = bytes => gzipSync(bytes, { level: zlib.Z_DEFAULT_COMPRESSION }).length;
const exists = file => stat(file).then(() => true, () => false);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status})\n${result.error ?? ''}${result.stderr}\n${result.stdout}`.slice(0, 12_000));
  return result.stdout;
}

/** Nearest-rank percentiles of a sample (no interpolation), with the raw samples kept. */
export function quantiles(samples) {
  const values = samples.filter(value => typeof value === 'number' && Number.isFinite(value));
  if (!values.length) return { count: 0, p50: null, p95: null, max: null, min: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = q => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
  const round = value => Math.round(value * 100) / 100;
  return { count: sorted.length, min: round(sorted[0]), p50: round(at(0.5)), p95: round(at(0.95)), max: round(sorted.at(-1)) };
}

/** Static server for a production build: every response carries the CSP; no directory listing; path traversal refused. */
export async function serveDist(dist, { csp = CSP } = {}) {
  const root = await realpath(dist);
  const requests = [];
  const server = createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    response.setHeader('Content-Security-Policy', csp);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    if (!file.startsWith(`${root}${path.sep}`)) { response.writeHead(403).end(); return; }
    try {
      const bytes = await readFile(file);
      response.setHeader('Content-Type', MIME[path.extname(file)] ?? 'application/octet-stream');
      requests.push({ path: pathname, status: 200, bytes: bytes.length });
      response.end(bytes);
    } catch {
      requests.push({ path: pathname, status: 404, bytes: 0 });
      response.writeHead(404).end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise(resolve => server.close(resolve)) };
}

/** Records CSP violations (main thread) before any page script runs; worker violations surface as console errors. */
export function cspRecorder() {
  window.__cspViolations = [];
  document.addEventListener('securitypolicyviolation', event => {
    window.__cspViolations.push({ directive: event.effectiveDirective, blocked: event.blockedURI, source: event.sourceFile, line: event.lineNumber, sample: event.sample });
  });
}

/** Listens to a page for console errors, page errors, failed requests and responses, with Node-side timestamps. */
export function watchPage(page) {
  const log = { errors: [], requests: [] };
  page.on('pageerror', error => log.errors.push(`pageerror: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') log.errors.push(`console${message.worker() ? ' (worker)' : ''}: ${message.text()}`); });
  page.on('requestfailed', request => { if (!/^(data|blob):/.test(request.url())) log.errors.push(`requestfailed: ${request.url()} ${request.failure()?.errorText ?? ''}`); });
  page.on('request', request => log.requests.push({ url: request.url(), type: request.resourceType(), at: performance.now() }));
  return log;
}

// ---------------------------------------------------------------------------------------------------------------------
// Build analysis
// ---------------------------------------------------------------------------------------------------------------------
const B64 = new Map([...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'].map((char, index) => [char, index]));
function decodeVlq(segment) {
  const values = [];
  let value = 0, shift = 0;
  for (const char of segment) {
    const digit = B64.get(char);
    value += (digit & 31) << shift;
    if (digit & 32) shift += 5;
    else { values.push(value & 1 ? -(value >>> 1) : value >>> 1); value = 0; shift = 0; }
  }
  return values;
}
/** Calls `visit(source, text)` for every generated code range of a source map (generated columns are UTF-16 offsets). */
function forEachRange(code, map, visit) {
  const lines = code.split('\n');
  let sourceIndex = 0;
  map.mappings.split(';').forEach((line, lineIndex) => {
    const text = lines[lineIndex] ?? '';
    let column = 0;
    const segments = [];
    for (const raw of line.split(',')) {
      if (!raw) continue;
      const fields = decodeVlq(raw);
      column += fields[0];
      if (fields.length >= 4) sourceIndex += fields[1];
      segments.push({ column, source: fields.length >= 4 ? map.sources[sourceIndex] : null });
    }
    if (!segments.length) { visit(null, text, lineIndex); return; }
    if (segments[0].column > 0) visit(null, text.slice(0, segments[0].column), lineIndex);
    segments.forEach((segment, index) => visit(segment.source, text.slice(segment.column, segments[index + 1]?.column ?? text.length), lineIndex));
  });
}
/** Bytes of generated code attributed to each source of a source map. */
export function attributeBytes(code, map) {
  const totals = new Map();
  forEachRange(code, map, (source, text) => totals.set(source, (totals.get(source) ?? 0) + Buffer.byteLength(text)));
  return totals;
}
/**
 * Estimated gzip9 saving of removing every generated range whose source matches `drop` (the remaining text is gzipped
 * again). An estimate for explaining a size, not a build: removed code would also change minification and chunking.
 */
export function gzipSaving(code, map, drop) {
  const kept = [];
  let removed = 0;
  forEachRange(code, map, (source, text, line) => {
    if (source !== null && drop(source)) { removed += Buffer.byteLength(text); return; }
    (kept[line] ??= []).push(text);
  });
  const remaining = Buffer.from(Array.from({ length: kept.length }, (_, line) => (kept[line] ?? []).join('')).join('\n'));
  return { removedBytes: removed, gzip9Saving: gzip9(Buffer.from(code)) - gzip9(remaining) };
}
/** Package a source path belongs to (`app` for consumer sources, `unmapped` for generated glue). */
export function packageOf(source) {
  if (source === null) return 'unmapped';
  const parts = source.split('node_modules/');
  if (parts.length < 2) return /(^|\/)src\//.test(source) ? 'app' : source.startsWith('\0') || source.includes('vite/') ? 'bundler' : 'app';
  const tail = parts.at(-1).split('/');
  return tail[0].startsWith('@') ? `${tail[0]}/${tail[1]}` : tail[0];
}
/** Patterns that must not reach the eager activity graph (report §4.1, A44). */
export const FORBIDDEN_EAGER = [
  { id: 'three', test: source => /node_modules\/three\//.test(source) },
  { id: '@explorable-models/player-3d', test: source => /node_modules\/@explorable-models\/player-3d\//.test(source) },
  { id: 'katex', test: source => /node_modules\/katex\//.test(source) || /@explorable-models\/player\/dist\/activity\/katex-[^/]+\.js$/.test(source) },
  { id: 'playwright', test: source => /node_modules\/(playwright|playwright-core|@playwright)\//.test(source) },
  { id: '@modelcontextprotocol', test: source => /node_modules\/@modelcontextprotocol\//.test(source) },
  { id: 'provider-sdk', test: source => /node_modules\/(openai|@anthropic-ai|@google\/generative-ai|@google\/genai|@mistralai|cohere-ai|ollama|@aws-sdk\/client-bedrock[^/]*)\//.test(source) },
  { id: 'tauri', test: source => /node_modules\/@tauri-apps\//.test(source) },
  { id: '@explorable-models/cli', test: source => /node_modules\/@explorable-models\/cli\//.test(source) },
  { id: '@explorable-models/agent', test: source => /node_modules\/@explorable-models\/agent\//.test(source) },
];
const FORBIDDEN_TEXT = [/THREE\.REVISION/, /WebGLRenderer/, /KaTeX parse error/, /playwright-core/, /@modelcontextprotocol/];
/** Installed catalogue content (templates, learner copy, model manifests, per-template content modules), not loaders. */
const isCatalogueContent = source => /@explorable-models\/catalog\/dist\/(templates|copy|models)\//.test(source) || /@explorable-models\/catalog\/dist\/content\/(?!loaders|types)[a-z0-9-]+\.js$/.test(source);

/**
 * Module graph of emitted chunks: static imports (`import … from`), dynamic imports (`import()`) and `new URL('….js',
 * import.meta.url)` references (module workers), resolved with esbuild's metafile of the emitted files.
 */
async function chunkGraph(dist, file) {
  const { build } = await import('esbuild');
  const result = await build({ entryPoints: [path.join(dist, file)], bundle: true, write: false, metafile: true, format: 'esm', platform: 'browser', logLevel: 'silent', absWorkingDir: dist });
  const graph = new Map();
  for (const [input, meta] of Object.entries(result.metafile.inputs)) {
    graph.set(input, { static: meta.imports.filter(item => item.kind === 'import-statement').map(item => item.path), dynamic: meta.imports.filter(item => item.kind === 'dynamic-import').map(item => item.path) });
  }
  return graph;
}
async function workerReferences(dist, file) {
  const text = await readFile(path.join(dist, file), 'utf8');
  const found = new Set();
  for (const match of text.matchAll(/new URL\(\s*(["'`])([^"'`]+?\.js)\1\s*,\s*import\.meta\.url\s*\)/g)) {
    const target = match[2].startsWith('/') ? match[2].slice(1) : path.posix.join(path.posix.dirname(file), match[2]);
    if (await exists(path.join(dist, target))) found.add(path.posix.normalize(target));
  }
  return [...found];
}
/** Eager (static + workers) and lazy (dynamic) JS of one HTML entry. */
export async function analyzeEntry(dist, html) {
  const markup = await readFile(path.join(dist, html), 'utf8');
  const local = value => value.replace(/^\.\//, '');
  const scripts = [...markup.matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"/g)].map(match => local(match[1]));
  const preloads = [...markup.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="([^"]+)"/g)].map(match => local(match[1]));
  const styles = [...markup.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map(match => local(match[1]));
  const inline = [...markup.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].filter(match => match[1].trim()).length;
  const eager = new Set(), workers = new Set(), dynamicRoots = new Set();
  const visit = async (file, viaWorker) => {
    if (eager.has(file)) return;
    const graph = await chunkGraph(dist, file);
    // Static closure from this chunk (esbuild inputs are relative to dist).
    const statics = new Set([file]);
    const queue = [file];
    while (queue.length) {
      const current = queue.shift();
      for (const next of graph.get(current)?.static ?? []) if (!statics.has(next)) { statics.add(next); queue.push(next); }
    }
    for (const item of statics) {
      eager.add(item);
      if (viaWorker) workers.add(item);
      for (const dynamic of graph.get(item)?.dynamic ?? []) dynamicRoots.add(dynamic);
    }
    for (const item of statics) for (const worker of await workerReferences(dist, item)) await visit(worker, true);
  };
  for (const file of [...scripts, ...preloads]) await visit(file, false);
  // Lazy: dynamic roots and their static closures, minus everything eager.
  const lazy = new Set();
  for (const root of dynamicRoots) {
    const graph = await chunkGraph(dist, root);
    const queue = [root];
    const seen = new Set([root]);
    while (queue.length) {
      const current = queue.shift();
      if (!eager.has(current)) lazy.add(current);
      for (const next of [...(graph.get(current)?.static ?? []), ...(graph.get(current)?.dynamic ?? [])]) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  return { html, scripts, preloads, styles, inlineScripts: inline, eager: [...eager].sort(), workers: [...workers].sort(), lazy: [...lazy].sort() };
}
/** Size and composition of one emitted JS file (sources and bytes per package from its hidden source map). */
export async function describeChunk(dist, file) {
  const bytes = await readFile(path.join(dist, file));
  const mapFile = path.join(dist, `${file}.map`);
  let packages = {}, sources = [];
  if (await exists(mapFile)) {
    const map = JSON.parse(await readFile(mapFile, 'utf8'));
    sources = map.sources;
    for (const [source, count] of attributeBytes(bytes.toString('utf8'), map)) { const name = packageOf(source); packages[name] = (packages[name] ?? 0) + count; }
    packages = Object.fromEntries(Object.entries(packages).sort((a, b) => b[1] - a[1]));
  }
  return { file, bytes: bytes.length, gzip9: gzip9(bytes), gzipDefault: gzipDefault(bytes), packages, sources, sha256: sha256(bytes) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Browser flows
// ---------------------------------------------------------------------------------------------------------------------
function pngSize(base64) {
  const bytes = Buffer.from(base64, 'base64');
  const signature = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return { signature, ihdr: bytes.subarray(12, 16).toString('ascii') === 'IHDR', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), bytes };
}
const evaluate = (page, fn, arg) => page.evaluate(fn, arg);

/** The quadratic flow on one activity entry; returns structured results and throws on the first failed expectation. */
async function quadraticFlow(page, base, html, out, log, label) {
  const steps = [];
  const expect = (condition, what, detail) => { steps.push({ step: what, ok: !!condition, ...(detail === undefined ? {} : { detail }) }); if (!condition) throw new Error(`${label}: ${what} failed${detail === undefined ? '' : `: ${JSON.stringify(detail).slice(0, 2000)}`}`); };
  await page.goto(`${base}/${html}`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true', undefined, { timeout: 30_000 });
  const readyAt = performance.now();
  const activityId = 'quadratic-flow';
  const opened = await evaluate(page, id => window.consumer.open('quadratic-gradient-descent', { activityId: id }), activityId);
  expect(opened.stage === 'predict' && opened.frameKind === 'committed', 'prepare + mount (predict stage, committed frame from the catalogue worker)', opened);
  // KaTeX, its stylesheet and fonts load only once an equation is on screen.
  const mathBefore = log.requests.filter(item => /katex/i.test(item.url)).length;
  await page.locator('[data-ema-panel="equations"]').first().scrollIntoViewIfNeeded();
  await page.locator('[data-ema-panel="equations"] .katex').first().waitFor({ timeout: 15_000 });
  expect(mathBefore === 0, 'KaTeX rendered the update rule, fetched only once the equations were on screen', { katexRequestsBeforeScroll: mathBefore });
  const transition = await evaluate(page, id => window.consumer.transition(id, 'explore-step'), activityId);
  expect(transition.ok, 'stage transition predict → explore-step (stage receipt with grants)', transition);
  const afterReveal = await evaluate(page, id => ({ exposures: window.consumer.exposures(id), acks: window.consumer.displayAcks(id), summary: window.consumer.summary(id) }), activityId);
  const traceGrant = afterReveal.exposures.find(record => record.groups.some(group => group.groupId === 'trace'));
  expect(traceGrant && traceGrant.displayStatus === 'displayed' && afterReveal.acks.includes(traceGrant.exposureId) && afterReveal.summary.views.includes('trace-plot'),
    'reveal of the trace persisted before display, displayed and display-acknowledged at the host', { exposure: traceGrant ? { scope: traceGrant.scope, displayStatus: traceGrant.displayStatus, displayed: traceGrant.displayed } : null, acks: afterReveal.acks.length });
  const scope = await evaluate(page, id => window.consumer.authorizeExploration(id), activityId);
  expect(scope.ok, 'exploration scope for the step-size control', scope);
  const before = await evaluate(page, id => window.consumer.summary(id), activityId);
  // Real pointer drag on the step-size slider: tentative preview frames, committed on release.
  const slider = page.locator('[data-parameter="eta"] input[type="range"]');
  await slider.scrollIntoViewIfNeeded();
  const box = await slider.boundingBox();
  const y = box.y + box.height / 2, at = fraction => box.x + 8 + (box.width - 16) * fraction;
  await page.mouse.move(at(0.25), y);
  await page.mouse.down();
  await page.mouse.move(at(0.4), y, { steps: 6 });
  await page.waitForFunction(id => window.consumer.summary(id).frameKind === 'tentative', activityId, { timeout: 10_000 });
  expect(true, 'pointer drag shows a tentative preview frame');
  await page.mouse.move(at(0.45), y, { steps: 4 });
  await page.mouse.up();
  // The release commits the preview: wait for the new committed run, then for the journal and the DOM to settle.
  await page.waitForFunction(({ id, runId }) => { const now = window.consumer.summary(id); return now.frameKind === 'committed' && now.runId !== runId; }, { id: activityId, runId: before.runId }, { timeout: 10_000 }).catch(() => undefined);
  const dragged = await evaluate(page, id => window.consumer.settle(id), activityId);
  expect(dragged.frameKind === 'committed' && dragged.runId !== before.runId && dragged.controls.eta !== before.controls.eta, 'pointer release commits a new run', { before: before.controls, after: dragged.controls });
  // Exact entry + Enter (the same command path as the card's Apply button).
  const exact = page.locator('[data-parameter="eta"] input.ema-input');
  await exact.fill('0.75');
  await exact.press('Enter');
  await page.waitForFunction(id => window.consumer.summary(id).controls.eta === 0.75, activityId, { timeout: 10_000 });
  const committed = await evaluate(page, id => window.consumer.settle(id), activityId);
  expect(committed.controls.eta === 0.75 && committed.runId !== dragged.runId && committed.frameKind === 'committed', 'exact entry commits η = 0.75 as a new run', committed);
  const events = await evaluate(page, id => window.consumer.events(id), activityId);
  const types = [...new Set(events.map(event => event.type))];
  expect(['preview.started', 'preview.observed', 'reveal.displayed'].every(type => types.includes(type)) && events.every((event, index) => event.sequence === index + 1),
    'host journal holds the preview and reveal evidence in gap-free order', types);
  const png = await evaluate(page, id => window.consumer.capture(id, 'png', 'trace-plot'), activityId);
  const decoded = pngSize(png.pngBase64);
  expect(decoded.signature && decoded.ihdr && decoded.width === png.width && decoded.height === png.height && png.metadata.frameId === committed.frameId && png.metadata.viewId === 'trace-plot',
    'PNG capture of the committed trace plot (frozen frame identity, valid PNG)', { width: png.width, height: png.height, fonts: png.fonts, metadata: png.metadata });
  await writeFile(path.join(out, `${label}-trace-plot.png`), decoded.bytes);
  const svg = await evaluate(page, id => window.consumer.capture(id, 'svg', 'landscape'), activityId);
  expect(svg.svgLength > 0 && svg.metadata.frameId === committed.frameId, 'SVG capture of the landscape view', { svgLength: svg.svgLength });
  await page.screenshot({ path: path.join(out, `${label}.png`), fullPage: true });
  const violations = await evaluate(page, () => window.__cspViolations);
  const diagnostics = await evaluate(page, () => window.consumer.diagnostics.map(item => ({ source: item.source, code: item.code })));
  const requested = log.requests.filter(item => item.url.startsWith(base)).map(item => ({ path: new URL(item.url).pathname.replace(/^\//, ''), type: item.type, afterReady: item.at > readyAt }));
  return { entry: html, steps, frame: { frameId: committed.frameId, runId: committed.runId }, capture: { png: { width: png.width, height: png.height, fonts: png.fonts, bytes: decoded.bytes.length }, svgLength: svg.svgLength }, cspViolations: violations, diagnostics, requested };
}

/** Spatial entry: a 2D template with the loader configured never loads the 3D chunks; a 3D template loads them then. */
async function spatialFlow(page, base, out, log, lazy3dFiles) {
  const steps = [];
  const expect = (condition, what, detail) => { steps.push({ step: what, ok: !!condition, ...(detail === undefined ? {} : { detail }) }); if (!condition) throw new Error(`spatial: ${what} failed${detail === undefined ? '' : `: ${JSON.stringify(detail).slice(0, 2000)}`}`); };
  const threeRequests = () => log.requests.filter(item => lazy3dFiles.some(file => item.url.endsWith(`/${file}`)));
  await page.goto(`${base}/spatial.html`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true', undefined, { timeout: 30_000 });
  const flat = await evaluate(page, () => window.consumer.open('quadratic-gradient-descent', { activityId: 'flat', stageId: 'free-explore' }));
  await evaluate(page, () => window.consumer.settle('flat'));
  await page.waitForTimeout(500);
  expect(threeRequests().length === 0 && (await evaluate(page, () => window.consumer.spatialLoads.length)) === 0, 'a 2D template with the spatial loader configured requests no 3D chunk', { flat: flat.views });
  const openedAt = performance.now();
  const spatial = await evaluate(page, () => window.consumer.open('vector-orientation-3d', { activityId: 'space', stageId: 'free-explore' }));
  await page.locator('[data-ema-spatial]').first().scrollIntoViewIfNeeded();
  await page.waitForFunction(() => (window.consumer.spatialState('space')[0]?.state ?? 'pending') !== 'pending' && window.consumer.spatialLoads.length > 0, undefined, { timeout: 20_000 });
  await page.waitForFunction(() => ['ready', 'fallback', 'failed'].includes(window.consumer.spatialState('space')[0]?.state), undefined, { timeout: 20_000 });
  await page.locator('[data-ema-spatial]').first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const state = await evaluate(page, () => window.consumer.spatialState('space'));
  const requests = threeRequests();
  expect(requests.length > 0 && requests.every(item => item.at >= openedAt), 'the 3D chunks (player-3d + three) are requested only after a 3D template is opened', { requests: requests.map(item => new URL(item.url).pathname), state });
  const commit = await evaluate(page, () => window.consumer.commit('space', { ux: 2 }));
  const settled = await evaluate(page, () => window.consumer.settle('space'));
  expect(commit.ok && settled.controls.ux === 2, 'commit on the 3D activity', { commit, controls: settled.controls });
  // A scene3d view rendered in 3D is not captured (the surface refuses it); its coordinate-plane projection is.
  const refused = await evaluate(page, () => window.consumer.capture('space', 'png', 'space').then(() => null, error => error.message));
  const plane = settled.views.find(viewId => viewId.startsWith('plane-'));
  const capture = await evaluate(page, viewId => window.consumer.capture('space', 'png', viewId), plane);
  const decoded = pngSize(capture.pngBase64);
  expect(decoded.signature && capture.metadata.frameId === settled.frameId && (state[0]?.state !== 'ready' || refused !== null), 'PNG capture of a coordinate-plane projection of the frozen frame (the live 3D view itself is refused)', { width: capture.width, height: capture.height, viewId: capture.metadata.viewId, refused3d: refused });
  await writeFile(path.join(out, 'spatial-capture.png'), decoded.bytes);
  await page.screenshot({ path: path.join(out, 'spatial.png'), fullPage: true });
  return { steps, spatialState: state, threeRequests: requests.map(item => new URL(item.url).pathname), cspViolations: await evaluate(page, () => window.__cspViolations), diagnostics: await evaluate(page, () => window.consumer.diagnostics.map(item => ({ source: item.source, code: item.code }))) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------------------------------
async function main() {
  const args = new Set(process.argv.slice(2));
  const started = Date.now();
  const checks = [];
  const check = (id, ok, detail) => { checks.push({ id, ok: !!ok, ...(detail === undefined ? {} : { detail }) }); console.log(`[verify-consumer] ${ok ? 'PASS' : 'FAIL'} ${id}`); return !!ok; };
  const budgets = JSON.parse(await readFile(BUDGETS_PATH, 'utf8'));
  const rootManifest = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const pinned = name => rootManifest.dependencies[name] ?? rootManifest.devDependencies[name];

  // 1. Pack and snapshot.
  const usePack = [...args].find(item => item.startsWith('--use-pack='))?.slice('--use-pack='.length) ?? null;
  if (usePack !== null) {
    const bytes = await readFile(path.join(PACKED, 'manifest.json')).catch(() => null);
    if (!bytes) throw new Error('--use-pack: release/study-harness/packages/manifest.json does not exist.');
    if (sha256(bytes) !== usePack) throw new Error(`--use-pack: the pack manifest's sha256 is ${sha256(bytes)}, not ${usePack} (the pack changed since it was recorded).`);
  }
  if (!args.has('--no-pack') && usePack === null) { console.log('[verify-consumer] packing all six packages (build:packages + npm pack)'); run(process.execPath, ['scripts/study-harness/pack.mjs'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }); }
  const manifest = JSON.parse(await readFile(path.join(PACKED, 'manifest.json'), 'utf8'));
  const scratch = await mkdtemp(path.join(tmpdir(), 'sh-consumer-'));
  const app = path.join(scratch, 'app'), tarballs = path.join(scratch, 'tarballs'), cache = path.join(scratch, 'npm-cache');
  await mkdir(tarballs, { recursive: true });
  await mkdir(cache, { recursive: true });
  const packed = [];
  for (const short of PACKAGES) {
    const entry = manifest.packages.find(item => item.name === `@explorable-models/${short}`);
    if (!entry) throw new Error(`@explorable-models/${short} is missing from the pack manifest; run without --no-pack.`);
    const bytes = await readFile(path.join(PACKED, entry.file));
    if (sha256(bytes) !== entry.sha256 || sha512(bytes) !== entry.integrity) throw new Error(`${entry.file}: bytes differ from the pack manifest (concurrent re-pack?).`);
    await writeFile(path.join(tarballs, entry.file), bytes);
    packed.push(entry);
  }
  check('pack-manifest-complete', manifest.complete === true && packed.length === 6, { createdAt: manifest.createdAt, source: manifest.source });

  let server, browser;
  const evidence = {
    schema: 'study-harness.consumer-evidence/1',
    createdAt: new Date().toISOString(),
    scope: 'Packed-consumer verification on one machine: clean npm install of the six packed tarballs, Node SSR-safe imports, Vite production build, Chromium (Playwright) under a strict production CSP. Not a packaged WebView (see native-conformance), not Firefox/WebKit, not a Study Harness host.',
    environment: { node: process.version, platform: process.platform, arch: process.arch, os: commandOutput('sw_vers', ['-productVersion']) || null, cpu: commandOutput('sysctl', ['-n', 'machdep.cpu.brand_string']) || null },
    pack: { createdAt: manifest.createdAt, source: manifest.source, lockSha256: manifest.lockSha256, manifestSha256: sha256(await readFile(path.join(PACKED, 'manifest.json'))), ...(usePack === null ? {} : { usedExistingPack: true }), packages: packed.map(({ name, version, file, sha256: hash, integrity, bytes }) => ({ name, version, file, sha256: hash, integrity, bytes })) },
  };
  try {
    // 2. Clean install.
    await cp(path.join(ROOT, 'examples/study-harness-consumer'), app, { recursive: true, filter: source => !/[\\/](dist|node_modules)([\\/]|$)/.test(path.relative(path.join(ROOT, 'examples/study-harness-consumer'), source)) });
    await cp(path.join(ROOT, 'examples/consumer'), path.join(app, 'legacy-2d'), { recursive: true });
    const dependencies = Object.fromEntries([...packed.map(entry => [entry.name, `file:../tarballs/${entry.file}`]), ['react', pinned('react')], ['react-dom', pinned('react-dom')], ['three', pinned('three')]]);
    const devDependencies = { vite: pinned('vite'), typescript: pinned('typescript'), '@types/react': pinned('@types/react'), '@types/react-dom': pinned('@types/react-dom'), '@types/three': pinned('@types/three') };
    await writeFile(path.join(app, 'package.json'), `${JSON.stringify({ name: 'study-harness-packed-consumer', private: true, type: 'module', dependencies, devDependencies }, null, 2)}\n`);
    const env = { ...process.env, npm_config_cache: cache, npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' };
    const cacheEntries = (await readdir(cache)).length;
    console.log('[verify-consumer] npm install (isolated empty cache)');
    const installStarted = Date.now();
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: app, env });
    const lock = JSON.parse(await readFile(path.join(app, 'package-lock.json'), 'utf8'));
    const installed = [];
    for (const entry of packed) {
      const directory = path.join(app, 'node_modules', entry.name);
      const info = await lstat(directory);
      const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
      const real = await realpath(directory);
      installed.push({ name: entry.name, version: pkg.version, symlink: info.isSymbolicLink(), insideInstall: real.startsWith(await realpath(app)), lockIntegrity: lock.packages?.[`node_modules/${entry.name}`]?.integrity ?? null });
    }
    check('clean-install-from-tarballs', cacheEntries === 0 && installed.every(item => !item.symlink && item.insideInstall && item.version === packed.find(entry => entry.name === item.name).version
      && item.lockIntegrity === packed.find(entry => entry.name === item.name).integrity), { emptyCacheAtStart: cacheEntries === 0, installed });
    const versions = Object.fromEntries(['react', 'react-dom', 'three', 'vite', 'typescript'].map(name => [name, lock.packages?.[`node_modules/${name}`]?.version ?? null]));
    evidence.install = { durationMs: Date.now() - installStarted, cache: 'isolated, empty at start', lifecycleScripts: 'disabled (--ignore-scripts)', aliases: 'none (file: tarball dependencies only)', versions, packages: installed };

    // 3. SSR-safe imports and typecheck.
    const ssrScript = `
      const before = ['window', 'document', 'HTMLElement', 'customElements', 'requestAnimationFrame', 'Worker'].filter(name => name in globalThis);
      const entries = ${JSON.stringify(PUBLIC_ENTRIES)};
      const out = [];
      for (const entry of entries) { const module = await import(entry); out.push({ entry, exports: Object.keys(module).length }); }
      const after = ['window', 'document', 'HTMLElement', 'customElements', 'requestAnimationFrame'].filter(name => name in globalThis);
      const { createInstalledCatalog, createLazyCatalog } = await import('@explorable-models/catalog');
      const catalog = createInstalledCatalog();
      const lazy = createLazyCatalog();
      process.stdout.write(JSON.stringify({ before, after, out, templates: catalog.listTemplates().map(item => item.template.templateId), problems: catalog.problems().length, lazyTemplates: lazy.listTemplates().map(item => item.template.templateId) }));`;
    const ssr = JSON.parse(run(process.execPath, ['--input-type=module', '-e', ssrScript], { cwd: app }));
    check('ssr-safe-imports', ssr.after.length === 0 && ssr.before.filter(name => name !== 'Worker').length === 0 && ssr.out.length === PUBLIC_ENTRIES.length && ssr.templates.length === 5 && ssr.problems === 0
      && JSON.stringify(ssr.lazyTemplates) === JSON.stringify(ssr.templates), ssr);
    evidence.ssr = { node: process.version, domGlobals: ssr.after, entries: ssr.out, installedTemplates: ssr.templates, lazyCatalogTemplates: ssr.lazyTemplates, catalogProblems: ssr.problems, workerEntriesNotImported: ['@explorable-models/catalog/worker', '@explorable-models/core/document-worker'] };
    const typecheck = spawnSync(path.join(app, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.json'], { cwd: app, encoding: 'utf8' });
    check('typecheck-against-packed-declarations', typecheck.status === 0, typecheck.status === 0 ? 'tsc -p tsconfig.json (skipLibCheck false): no errors' : `${typecheck.stdout}${typecheck.stderr}`.slice(0, 6000));
    evidence.typecheck = { command: 'tsc -p tsconfig.json', skipLibCheck: false, ok: typecheck.status === 0, output: `${typecheck.stdout}${typecheck.stderr}`.trim().slice(0, 6000) };

    // 4. Production builds and budgets. The flows use the multi-page build; each budgeted page is also built alone
    //    (CONSUMER_ENTRY) so that code shared with other pages cannot change what the measured page loads.
    const vite = path.join(app, 'node_modules/.bin/vite');
    console.log('[verify-consumer] vite build (activity consumer, all pages)');
    run(vite, ['build'], { cwd: app });
    const activityBudget = budgets.dependency.activityEntry;
    for (const html of activityBudget.entries) {
      console.log(`[verify-consumer] vite build (${html} alone)`);
      run(vite, ['build'], { cwd: app, env: { ...process.env, CONSUMER_ENTRY: html.replace(/\.html$/, '') } });
    }
    console.log('[verify-consumer] vite build (existing 2D consumer)');
    run(vite, ['build', '--config', 'vite.config.mjs'], { cwd: path.join(app, 'legacy-2d') });
    const dist = await realpath(path.join(app, 'dist'));
    const legacyAssets = path.join(app, 'legacy-2d/dist/assets');
    const legacyJs = [];
    for (const file of (await readdir(legacyAssets)).filter(name => name.endsWith('.js'))) { const bytes = await readFile(path.join(legacyAssets, file)); legacyJs.push({ file, bytes: bytes.length, gzipDefault: gzipDefault(bytes), gzip9: gzip9(bytes) }); }
    const legacyTotal = legacyJs.reduce((sum, item) => sum + item.gzipDefault, 0);
    const legacySource = (await Promise.all(legacyJs.map(item => readFile(path.join(legacyAssets, item.file), 'utf8')))).join('\n');
    const legacyBudget = budgets.dependency.legacy2dConsumer;
    check('budget-legacy-2d-consumer', legacyTotal <= legacyBudget.maxGzipBytes && !/THREE\.REVISION|WebGLRenderer|playwright-core|@modelcontextprotocol/.test(legacySource), { gzipBytes: legacyTotal, max: legacyBudget.maxGzipBytes });
    let previewEvidence = null;
    try { previewEvidence = JSON.parse(await readFile(path.join(ROOT, 'release/preview/package-evidence.json'), 'utf8')).dependencyBudget?.gzipBytes ?? null; } catch { previewEvidence = null; }

    const entries = {};
    for (const html of ['activity.html', 'activity-react.html', 'spatial.html', 'bench.html']) entries[html] = await analyzeEntry(dist, html);
    const chunkCache = new Map();
    const infoIn = async (directory, file) => { const key = `${directory}\0${file}`; if (!chunkCache.has(key)) chunkCache.set(key, await describeChunk(directory, file)); return chunkCache.get(key); };
    const info = file => infoIn(dist, file);
    /** Groups whose share of the main activity chunk explains its size (estimated by removal, see gzipSaving). */
    const SIZE_GROUPS = [
      { id: 'catalogue content (templates, learner copy, model manifests)', test: source => isCatalogueContent(source) },
      { id: 'catalogue kernels in the main thread (also in the kernel worker)', test: source => /@explorable-models\/catalog\/dist\/kernels\//.test(source) },
      { id: 'schema 2.0 document runtime in the main thread (@explorable-models/core/declarative)', test: source => /@explorable-models\/core\/dist\/declarative\//.test(source) },
      { id: 'react-dom', test: source => /node_modules\/react-dom\//.test(source) },
      { id: 'learner surface (@explorable-models/player/activity)', test: source => /@explorable-models\/player\/dist\/activity\//.test(source) },
      { id: 'activity runtime (@explorable-models/activity)', test: source => /@explorable-models\/activity\//.test(source) },
      { id: 'consumer host code (this example)', test: source => !source.includes('node_modules/') },
    ];
    const activityResults = {};
    for (const html of activityBudget.entries) {
      const singleDist = await realpath(path.join(app, `dist-${html.replace(/\.html$/, '')}`));
      const entry = await analyzeEntry(singleDist, html);
      const eager = await Promise.all(entry.eager.map(file => infoIn(singleDist, file)));
      const total9 = eager.reduce((sum, item) => sum + item.gzip9, 0), totalDefault = eager.reduce((sum, item) => sum + item.gzipDefault, 0), raw = eager.reduce((sum, item) => sum + item.bytes, 0);
      const packagesBytes = {};
      for (const item of eager) for (const [name, count] of Object.entries(item.packages)) packagesBytes[name] = (packagesBytes[name] ?? 0) + count;
      const forbidden = [];
      for (const item of eager) for (const rule of FORBIDDEN_EAGER) for (const source of item.sources) if (rule.test(source)) forbidden.push({ file: item.file, rule: rule.id, source });
      const text = (await Promise.all(entry.eager.map(file => readFile(path.join(singleDist, file), 'utf8')))).join('\n');
      const markers = FORBIDDEN_TEXT.filter(pattern => pattern.test(text)).map(String);
      const main = eager.filter(item => !entry.workers.includes(item.file)).sort((a, b) => b.bytes - a.bytes)[0];
      const mainCode = await readFile(path.join(singleDist, main.file), 'utf8'), mainMap = JSON.parse(await readFile(path.join(singleDist, `${main.file}.map`), 'utf8'));
      const sizeCauses = SIZE_GROUPS.map(group => ({ group: group.id, ...gzipSaving(mainCode, mainMap, group.test) }));
      const multiPage = (await Promise.all(entries[html].eager.map(info))).reduce((sum, item) => sum + item.gzip9, 0);
      activityResults[html] = {
        build: `single-page build (CONSUMER_ENTRY=${html.replace(/\.html$/, '')})`, gzip9: total9, gzipDefault: totalDefault, bytes: raw, overBudgetBy: Math.max(0, total9 - activityBudget.maxGzipBytes),
        multiPageBuildGzip9: multiPage, inlineScripts: entry.inlineScripts, styles: entry.styles,
        chunks: eager.map(({ file, bytes, gzip9: g9, gzipDefault: gd, packages }) => ({ file, bytes, gzip9: g9, gzipDefault: gd, worker: entry.workers.includes(file), packages })),
        packagesBytes: Object.fromEntries(Object.entries(packagesBytes).sort((a, b) => b[1] - a[1])), sizeCauses: { chunk: main.file, note: 'gzip9 saving estimated by removing the group\'s generated ranges from the minified chunk and recompressing; an explanation, not a build', groups: sizeCauses },
        forbiddenSources: forbidden, forbiddenTextMarkers: markers, lazy: entry.lazy,
      };
      check(`budget-activity-entry:${html}`, total9 <= activityBudget.maxGzipBytes && entry.workers.length > 0, { gzip9: total9, max: activityBudget.maxGzipBytes, workers: entry.workers });
      check(`eager-graph-clean:${html}`, forbidden.length === 0 && markers.length === 0 && entry.inlineScripts === 0, { forbidden, markers, inlineScripts: entry.inlineScripts });
    }
    // Lazy assets: math, fonts, 3D, catalogue content and optional capture/restore implementations.
    const allLazy = [...new Set(Object.values(entries).flatMap(entry => entry.lazy))];
    const lazyInfo = await Promise.all(allLazy.map(info));
    const isMath = item => item.sources.some(source => FORBIDDEN_EAGER.find(rule => rule.id === 'katex').test(source));
    const is3d = item => item.sources.some(source => /node_modules\/(three|@explorable-models\/player-3d)\//.test(source));
    const assets = await readdir(path.join(dist, 'assets'));
    const fileSizes = async (filter) => Promise.all(assets.filter(filter).map(async file => { const bytes = await readFile(path.join(dist, 'assets', file)); return { file: `assets/${file}`, bytes: bytes.length, gzip9: gzip9(bytes) }; }));
    const sum = (list, key) => list.reduce((total, item) => total + item[key], 0);
    const mathJs = lazyInfo.filter(isMath), threeJs = lazyInfo.filter(is3d);
    // Per-template catalogue content chunks of the multi-page build (served to the flows): file → template ID.
    const contentChunkTemplate = new Map(lazyInfo.flatMap(item => {
      const id = item.sources.map(source => /@explorable-models\/catalog\/dist\/content\/([a-z0-9-]+)\.js$/.exec(source)?.[1]).find(match => match && match !== 'loaders' && match !== 'types');
      return id ? [[item.file, id]] : [];
    }));
    const mathCss = await fileSizes(file => /^katex.*\.css$/.test(file)), mathFonts = await fileSizes(file => /^KaTeX_.*\.woff2$/.test(file)), uiFonts = await fileSizes(file => /^inter-.*\.woff2$/.test(file));
    const lazy = {
      math: {
        js: { files: mathJs.map(item => item.file), bytes: sum(mathJs, 'bytes'), gzip9: sum(mathJs, 'gzip9') },
        css: { files: mathCss.map(item => item.file), bytes: sum(mathCss, 'bytes'), gzip9: sum(mathCss, 'gzip9') },
        fonts: { files: mathFonts.length, bytes: sum(mathFonts, 'bytes'), gzip9: sum(mathFonts, 'gzip9') },
      },
      uiFonts: { files: uiFonts.length, bytes: sum(uiFonts, 'bytes'), gzip9: sum(uiFonts, 'gzip9') },
      spatial: { files: threeJs.map(item => item.file), bytes: sum(threeJs, 'bytes'), gzip9: sum(threeJs, 'gzip9'), packages: Object.assign({}, ...threeJs.map(item => item.packages)) },
      other: lazyInfo.filter(item => !isMath(item) && !is3d(item)).map(item => ({ file: item.file, bytes: item.bytes, gzip9: item.gzip9, packages: item.packages })),
    };
    const lazyBudget = budgets.dependency;
    const within = (measured, budget) => measured.bytes <= budget.maxBytes && (budget.maxGzipBytes === undefined || measured.gzip9 <= budget.maxGzipBytes);
    check('budget-lazy-math', mathJs.length > 0 && within(lazy.math.js, lazyBudget.lazyMath.js) && within(lazy.math.css, lazyBudget.lazyMath.css) && within(lazy.math.fonts, lazyBudget.lazyMath.fonts), lazy.math);
    check('budget-bundled-ui-fonts', within(lazy.uiFonts, lazyBudget.bundledUiFonts), lazy.uiFonts);
    check('budget-lazy-3d', threeJs.length > 0 && within(lazy.spatial, lazyBudget.lazy3d.js), { files: lazy.spatial.files, bytes: lazy.spatial.bytes, gzip9: lazy.spatial.gzip9 });
    // Catalogue content inside the eager activity graph (templates, learner copy, manifests) and kernels (also in the worker).
    const singleActivity = await realpath(path.join(app, 'dist-activity'));
    const singleEntry = await analyzeEntry(singleActivity, 'activity.html');
    const activityEager = singleEntry.eager.filter(file => !singleEntry.workers.includes(file));
    const contentBytes = { templatesCopyModels: 0, kernels: 0, other: 0 };
    for (const file of activityEager) {
      const map = JSON.parse(await readFile(path.join(singleActivity, `${file}.map`), 'utf8'));
      for (const [source, count] of attributeBytes((await readFile(path.join(singleActivity, file))).toString('utf8'), map)) {
        if (!source || !/node_modules\/@explorable-models\/catalog\//.test(source)) continue;
        if (isCatalogueContent(source)) contentBytes.templatesCopyModels += count;
        else if (/\/kernels\//.test(source)) contentBytes.kernels += count;
        else contentBytes.other += count;
      }
    }
    // Catalogue content is loaded per template on demand (createLazyCatalog): every content chunk is a lazy asset. The
    // content-size ceiling covers all installed content; the eager graph must carry none of it, and no kernel code.
    const contentChunks = [];
    for (const file of singleEntry.lazy) {
      const map = JSON.parse(await readFile(path.join(singleActivity, `${file}.map`), 'utf8').catch(() => 'null'));
      if (!map) continue;
      const bytes = await readFile(path.join(singleActivity, file));
      let content = 0, kernelBytes = 0, templateId = null;
      for (const [source, count] of attributeBytes(bytes.toString('utf8'), map)) {
        if (!source) continue;
        if (isCatalogueContent(source)) content += count;
        if (/@explorable-models\/catalog\/dist\/kernels\//.test(source)) kernelBytes += count;
        templateId ??= /@explorable-models\/catalog\/dist\/content\/([a-z0-9-]+)\.js$/.exec(source)?.[1] ?? null;
      }
      if (content) contentChunks.push({ file, templateId, bytes: bytes.length, gzip9: gzip9(bytes), contentBytes: content, kernelConstantBytes: kernelBytes });
    }
    const lazyContent = contentChunks.reduce((total, item) => total + item.contentBytes, 0);
    const workerFiles = new Set(singleEntry.workers);
    const kernelInPage = activityEager.length ? contentBytes.kernels : 0;
    Object.assign(contentBytes, { lazy: lazyContent, total: contentBytes.templatesCopyModels + lazyContent, chunks: contentChunks, kernelCodeInPage: kernelInPage, workerFiles: [...workerFiles] });
    check('budget-catalogue-content', contentBytes.templatesCopyModels === 0 && kernelInPage === 0 && contentChunks.length === 5 && contentBytes.total <= lazyBudget.catalogueContent.maxBytes, contentBytes);
    evidence.build = {
      tool: `vite ${versions.vite}`, csp: CSP, mode: 'production', sourcemaps: 'hidden (audit only)',
      entries: Object.fromEntries(Object.entries(entries).map(([html, entry]) => [html, { scripts: entry.scripts, preloads: entry.preloads, styles: entry.styles, eager: entry.eager, workers: entry.workers, lazy: entry.lazy, inlineScripts: entry.inlineScripts }])),
    };
    evidence.budgets = {
      rulesFrom: 'docs/study-harness/budgets.json',
      legacy2dConsumer: { gzipBytes: legacyTotal, maxGzipBytes: legacyBudget.maxGzipBytes, ok: legacyTotal <= legacyBudget.maxGzipBytes, assets: legacyJs, lastVerifyPackagesMeasurement: previewEvidence },
      activityEntry: Object.fromEntries(Object.entries(activityResults).map(([html, result]) => [html, { ...result, maxGzipBytes: activityBudget.maxGzipBytes, ok: result.gzip9 <= activityBudget.maxGzipBytes }])),
      lazy, catalogueContent: { ...contentBytes, maxBytes: lazyBudget.catalogueContent.maxBytes },
    };

    // 5. Strict-CSP browser flows.
    const out = path.join(CONSUMER_OUT, 'screenshots');
    await rm(out, { recursive: true, force: true });
    await mkdir(out, { recursive: true });
    server = await serveDist(dist);
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    evidence.browser = { name: 'chromium', version: browser.version(), headless: true };
    const flows = {};
    for (const [label, html] of [['dom', 'activity.html'], ['react', 'activity-react.html']]) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
      await context.addInitScript(cspRecorder);
      const page = await context.newPage();
      const log = watchPage(page);
      try {
        const result = await quadraticFlow(page, server.base, html, out, log, label);
        const mathRequests = result.requested.filter(item => lazy.math.js.files.includes(item.path));
        const threeRequests = result.requested.filter(item => lazy.spatial.files.includes(item.path));
        // Only the opened template's content chunk is fetched, after the page is ready (createLazyCatalog().load()).
        const contentRequests = result.requested.filter(item => contentChunkTemplate.has(item.path));
        const contentTemplates = [...new Set(contentRequests.map(item => contentChunkTemplate.get(item.path)))];
        flows[label] = { ...result, errors: log.errors, mathLoadedLazily: mathRequests.length > 0 && mathRequests.every(item => item.afterReady), threeRequested: threeRequests.length, contentTemplatesFetched: contentTemplates };
        check(`flow-${label}`, true, { steps: result.steps.length });
        check(`flow-${label}-csp-and-console-clean`, result.cspViolations.length === 0 && log.errors.length === 0, { cspViolations: result.cspViolations, errors: log.errors });
        check(`flow-${label}-lazy-loading`, flows[label].mathLoadedLazily && threeRequests.length === 0 && contentChunkTemplate.size === 5
          && JSON.stringify(contentTemplates) === JSON.stringify(['quadratic-gradient-descent']) && contentRequests.every(item => item.afterReady), { math: mathRequests, three: threeRequests.length, content: contentRequests, contentChunks: Object.fromEntries(contentChunkTemplate) });
      } catch (error) {
        flows[label] = { entry: html, error: error.message, errors: log.errors, cspViolations: await page.evaluate(() => window.__cspViolations).catch(() => null) };
        await page.screenshot({ path: path.join(out, `${label}-failure.png`), fullPage: true }).catch(() => undefined);
        check(`flow-${label}`, false, error.message);
      } finally { await context.close(); }
    }
    {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
      await context.addInitScript(cspRecorder);
      const page = await context.newPage();
      const log = watchPage(page);
      try {
        const result = await spatialFlow(page, server.base, out, log, lazy.spatial.files);
        flows.spatial = { ...result, errors: log.errors };
        check('flow-spatial', true, { spatialState: result.spatialState });
        check('flow-spatial-csp-and-console-clean', result.cspViolations.length === 0 && log.errors.length === 0, { cspViolations: result.cspViolations, errors: log.errors });
      } catch (error) {
        flows.spatial = { error: error.message, errors: log.errors };
        await page.screenshot({ path: path.join(out, 'spatial-failure.png'), fullPage: true }).catch(() => undefined);
        check('flow-spatial', false, error.message);
      } finally { await context.close(); }
    }
    {
      // The policy is really enforced: an intended negative probe in a separate context is blocked and reported.
      const context = await browser.newContext();
      await context.addInitScript(cspRecorder);
      const page = await context.newPage();
      const responses = [];
      page.on('response', response => responses.push({ url: response.url(), csp: response.headers()['content-security-policy'] ?? null }));
      await page.goto(`${server.base}/activity.html`);
      await page.waitForFunction(() => document.body.dataset.ready === 'true');
      // DevTools evaluation bypasses the eval check, so the probes use the DOM: an inserted inline script, a parsed
      // style attribute and a data: image must all be refused by the page's own policy.
      const probe = await page.evaluate(async () => {
        const script = document.createElement('script');
        script.textContent = 'window.__inlineRan = true;';
        document.body.append(script);
        const styled = document.createElement('div');
        styled.setAttribute('style', 'color: rgb(255, 0, 0)');
        document.body.append(styled);
        const image = new Image();
        const loaded = await new Promise(resolve => { image.onload = () => resolve(true); image.onerror = () => resolve(false); image.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACw='; });
        await new Promise(resolve => setTimeout(resolve, 100));
        const result = { inlineScriptRan: window.__inlineRan === true, styleAttributeApplied: getComputedStyle(styled).color === 'rgb(255, 0, 0)', dataImageLoaded: loaded, violations: window.__cspViolations.map(item => item.directive) };
        script.remove();
        styled.remove();
        return result;
      });
      const everyResponse = responses.filter(item => item.url.startsWith(server.base)).every(item => item.csp === CSP);
      check('csp-enforced-negative-probe', !probe.inlineScriptRan && !probe.styleAttributeApplied && !probe.dataImageLoaded && ['script-src-elem', 'style-src-attr', 'img-src'].every(directive => probe.violations.includes(directive)) && everyResponse,
        { ...probe, responses: responses.length, everyResponseCarriesPolicy: everyResponse });
      evidence.cspProbe = { ...probe, everyResponseCarriesPolicy: everyResponse, note: 'Intended negative probe in a separate browser context; not counted in the flows.' };
      await context.close();
    }
    evidence.flows = flows;

    // 6. Keep the production build for the benchmark.
    await rm(path.join(CONSUMER_OUT, 'dist'), { recursive: true, force: true });
    await cp(dist, path.join(CONSUMER_OUT, 'dist'), { recursive: true });
    await writeFile(path.join(CONSUMER_OUT, 'build.json'), `${JSON.stringify({ schema: 'study-harness.consumer-build/1', createdAt: new Date().toISOString(), pack: evidence.pack, versions, csp: CSP }, null, 2)}\n`);
  } finally {
    await browser?.close();
    await server?.close();
    if (!args.has('--keep')) await rm(scratch, { recursive: true, force: true });
    else console.log(`[verify-consumer] kept ${scratch}`);
  }
  evidence.durationMs = Date.now() - started;
  evidence.checks = checks;
  evidence.ok = checks.every(item => item.ok);
  await mkdir(EVIDENCE, { recursive: true });
  await writeFile(path.join(EVIDENCE, 'consumer.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  await writeFile(path.join(EVIDENCE, 'consumer.md'), renderMarkdown(evidence, budgets));
  const history = writeHistoryRecord(EVIDENCE, 'consumer', evidence, { root: ROOT });
  console.log(`[verify-consumer] history record ${path.relative(ROOT, history)}`);
  console.log(`[verify-consumer] ${evidence.ok ? 'all checks passed' : `${checks.filter(item => !item.ok).length} check(s) failed`}; evidence in docs/study-harness/evidence/consumer.{json,md}`);
  if (!evidence.ok) process.exitCode = 1;
}

const kb = bytes => `${bytes.toLocaleString('en-US')} B`;
export function renderMarkdown(evidence, budgets) {
  const rows = (items, columns) => items.map(item => `| ${columns.map(column => column(item)).join(' | ')} |`).join('\n');
  const activity = evidence.budgets?.activityEntry ?? {};
  const lazy = evidence.budgets?.lazy;
  const lines = [
    '# Packed-consumer evidence',
    '',
    `Generated by \`node scripts/study-harness/verify-consumer.mjs\` on ${evidence.createdAt} (${evidence.environment.os ? `macOS ${evidence.environment.os}` : evidence.environment.platform}, ${evidence.environment.cpu ?? evidence.environment.arch}, Node ${evidence.environment.node}${evidence.browser ? `, Chromium ${evidence.browser.version}` : ''}). Machine-readable: [consumer.json](consumer.json). Budget rules: [budgets.json](../budgets.json).`,
    '',
    `**Scope.** ${evidence.scope}`,
    '',
    `**Result:** ${evidence.ok ? 'every check passed' : 'FAILED — see the checks below'} (${evidence.checks.filter(item => item.ok).length}/${evidence.checks.length}).`,
    '',
    '## Packed tarballs (from the pack manifest)',
    '',
    `Packed ${evidence.pack.createdAt} from commit \`${evidence.pack.source?.commit ?? 'unknown'}\`${evidence.pack.source?.dirty ? ' with uncommitted changes (working tree, not a release tag)' : ''}; root lockfile sha256 \`${evidence.pack.lockSha256}\`.`,
    '',
    '| Package | Version | Tarball sha256 | Bytes |',
    '| --- | --- | --- | --- |',
    rows(evidence.pack.packages, [item => item.name, item => item.version, item => `\`${item.sha256}\``, item => kb(item.bytes)]),
    '',
    '## Checks',
    '',
    '| Check | Result |',
    '| --- | --- |',
    rows(evidence.checks, [item => item.id, item => item.ok ? 'pass' : '**fail**']),
    '',
  ];
  if (evidence.budgets) {
    lines.push('## Dependency budgets', '', '| Measure | Measured | Budget | Rule |', '| --- | --- | --- | --- |',
      `| Existing 2D consumer (examples/consumer) | ${kb(evidence.budgets.legacy2dConsumer.gzipBytes)} gzip | ${kb(budgets.dependency.legacy2dConsumer.maxGzipBytes)} | all emitted JS, zlib default level (as verify-packages) |`,
      ...Object.entries(activity).map(([html, result]) => `| Activity entry \`${html}\` | ${kb(result.gzip9)} gzip (${kb(result.bytes)} raw) | ${kb(result.maxGzipBytes)} | statically reachable JS incl. kernel worker, gzip level 9 |`),
      `| Lazy KaTeX JS | ${kb(lazy.math.js.gzip9)} gzip (${kb(lazy.math.js.bytes)}) | ${kb(budgets.dependency.lazyMath.js.maxGzipBytes)} gzip / ${kb(budgets.dependency.lazyMath.js.maxBytes)} | dynamic import only |`,
      `| Lazy KaTeX CSS | ${kb(lazy.math.css.gzip9)} gzip (${kb(lazy.math.css.bytes)}) | ${kb(budgets.dependency.lazyMath.css.maxGzipBytes)} gzip / ${kb(budgets.dependency.lazyMath.css.maxBytes)} | fetched when math first renders |`,
      `| KaTeX fonts (${lazy.math.fonts.files} woff2) | ${kb(lazy.math.fonts.bytes)} | ${kb(budgets.dependency.lazyMath.fonts.maxBytes)} | registered only with \`fonts: 'bundled'\`; browsers fetch only used faces |`,
      `| Inter UI fonts (${lazy.uiFonts.files} woff2) | ${kb(lazy.uiFonts.bytes)} | ${kb(budgets.dependency.bundledUiFonts.maxBytes)} | only with \`fonts: 'bundled'\` |`,
      `| Lazy 3D (player-3d + three) | ${kb(lazy.spatial.gzip9)} gzip (${kb(lazy.spatial.bytes)}) | ${kb(budgets.dependency.lazy3d.js.maxGzipBytes)} gzip / ${kb(budgets.dependency.lazy3d.js.maxBytes)} | host \`spatialLoader\` import only |`,
      `| Catalogue content (five templates, loaded per template on demand) | ${kb(evidence.budgets.catalogueContent.total ?? evidence.budgets.catalogueContent.templatesCopyModels)} raw; in the eager graph ${kb(evidence.budgets.catalogueContent.templatesCopyModels)}, kernel code in the page ${kb(evidence.budgets.catalogueContent.kernelCodeInPage ?? evidence.budgets.catalogueContent.kernels)} | ${kb(budgets.dependency.catalogueContent.maxBytes)} raw | source-map attribution of templates, learner copy, manifests; none eager |`,
      '');
    for (const [html, result] of Object.entries(activity)) {
      if (!result.overBudgetBy) continue;
      lines.push(`\`${html}\` is ${kb(result.overBudgetBy)} over its ceiling. Estimated gzip9 share of groups in its main chunk \`${result.sizeCauses.chunk}\` (${result.sizeCauses.note}); causes and owners: [performance.md](../performance.md) F1.`, '',
        '| Group | Raw bytes | Estimated gzip9 share |', '| --- | --- | --- |', rows(result.sizeCauses.groups, [item => item.group, item => kb(item.removedBytes), item => kb(item.gzip9Saving)]), '');
    }
    const content = evidence.budgets.catalogueContent;
    if (content?.chunks?.length) {
      lines.push('Per-template content chunks of the plain-DOM entry (`createLazyCatalog().load()`; lazy assets, fetched only for an opened template). Kernel constants are the IDs, versions and domains that templates and manifests reuse; kernel code is loaded only by the catalogue worker, one module per kernel on first use.', '',
        '| Template | Chunk | Bytes | gzip9 | Content bytes | Kernel constants |', '| --- | --- | --- | --- | --- | --- |',
        rows(content.chunks, [item => `\`${item.templateId}\``, item => `\`${item.file}\``, item => kb(item.bytes), item => kb(item.gzip9), item => kb(item.contentBytes), item => kb(item.kernelConstantBytes)]), '');
    }
    if (lazy.other.length) {
      lines.push('Other deferred chunks (including catalogue/kernel content, capture rendering and saved-record migration). These bytes remain part of the distribution; they are loaded by the operation that needs them and are reported separately from the initial entry.', '',
        '| Chunk | Bytes | gzip9 | Packages |', '| --- | --- | --- | --- |',
        rows(lazy.other, [item => `\`${item.file}\``, item => kb(item.bytes), item => kb(item.gzip9), item => Object.keys(item.packages).join(', ')]), '');
    }
    const first = Object.values(activity)[0];
    if (first) {
      lines.push('Composition of the plain-DOM activity entry (uncompressed bytes attributed through the hidden source maps):', '', '| Package | Bytes |', '| --- | --- |',
        rows(Object.entries(first.packagesBytes).slice(0, 12), [([name]) => name, ([, bytes]) => kb(bytes)]), '');
    }
  }
  if (evidence.flows) {
    lines.push('## Browser flows under the production CSP', '', `Policy on every response: \`${CSP}\`.`, '');
    for (const [label, flow] of Object.entries(evidence.flows)) {
      lines.push(`### ${label}${flow.entry ? ` (\`${flow.entry}\`)` : ''}`, '');
      if (flow.error) lines.push(`**Failed:** ${flow.error}`, '');
      for (const step of flow.steps ?? []) lines.push(`- ${step.ok ? 'pass' : 'FAIL'}: ${step.step}`);
      lines.push('', `CSP violations: ${flow.cspViolations?.length ?? 'n/a'}; console/page errors and failed requests: ${flow.errors?.length ?? 'n/a'}.`, '');
    }
  }
  lines.push('## Limits of this evidence', '',
    '- Chromium only (Playwright headless) on one macOS machine; the packaged WebView is covered by the native conformance run, other engines by the cross-browser suite.',
    '- The fixture host is an in-memory page object; it shows the host boundary works from packed tarballs, not that a Study Harness host does.',
    '- Budgets are engineering ceilings for these packages; they say nothing about learning outcomes, accessibility certification or scientific review.', '');
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await main(); }
  catch (error) {
    // A run that throws (failed install, build or launch) is still part of the engineering record (report §22.3).
    try { writeHistoryRecord(EVIDENCE, 'consumer', { ok: false, error: String(error?.message ?? error).slice(0, 4000), argv: process.argv.slice(2) }, { root: ROOT }); } catch { /* history is best effort here */ }
    throw error;
  }
}
