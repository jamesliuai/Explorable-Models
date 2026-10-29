// Native feasibility spike for the Study Harness reference host (W12 early spike).
// Runs browser-architecture probes inside the packaged Tauri WebView and reports them through
// one narrow, validated native command. No remote origin is referenced by the app itself.
import 'katex/dist/katex.min.css';
import './styles.css';
import katex from 'katex';
import katexCssText from 'katex/dist/katex.min.css?inline';
import katexMainFontUrl from 'katex/dist/fonts/KaTeX_Main-Regular.woff2?url';
import katexMathItalicFontUrl from 'katex/dist/fonts/KaTeX_Math-Italic.woff2?url';
import localFontUrl from './assets/fonts/KaTeX_Main-Regular.woff2?url';
import { invoke } from './native-bridge';
import {
  REPORT_SCHEMA,
  type CaptureArtifact,
  type CspObservation,
  type JsonValue,
  type ProbeId,
  type ProbeResult,
  type ProbeStatus,
  type ReportAck,
  type SpikeResults,
  type ViolationRecord,
} from './report-types';
import type { WorkerErrorReply, WorkerProbeReply, WorkerProbeRequest } from './worker-protocol';

type Details = { [key: string]: JsonValue };
interface Outcome {
  status: ProbeStatus;
  summary: string;
  details?: Details;
}

declare global {
  interface Window {
    __spikeEarly?: { violations: ViolationRecord[]; bootedAtMs: number };
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const SHA256_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const QUADRATIC_TEX = String.raw`x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}`;
const KATEX_OPTIONS = {
  trust: false,
  maxExpand: 1000,
  maxSize: 20,
  output: 'htmlAndMathml',
  displayMode: true,
  throwOnError: true,
} as const;
/** Deliberate CSP negative probe target: RFC 6761 reserved name that can never resolve. */
const NEGATIVE_REMOTE_URL = 'https://remote.invalid/study-harness-spike-probe';
const MAX_CAPTURE_EDGE = 4096;
const MAX_CAPTURE_PIXELS = 16_777_216;
const MAX_CAPTURE_BASE64 = 128 * 1024;
const MAX_CAPTURES = 4;
/** KaTeX 0.19 renamed .strut to .katex-strut; accept both. */
const STRUT_SELECTOR = '.katex-strut, .strut';

const startedAt = new Date().toISOString();
const startedMs = performance.now();
const runId = crypto.randomUUID();
const probes: ProbeResult[] = [];
const captures: CaptureArtifact[] = [];

// Record every fetch the page issues so the report can show which origins were contacted.
const requestLog: string[] = [];
const pageFetch = window.fetch.bind(window);
window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (requestLog.length < 128) requestLog.push(new URL(url, document.baseURI).href.slice(0, 300));
  return pageFetch(input, init);
};

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 400);
  if (typeof error === 'string') return error.slice(0, 400);
  try {
    return JSON.stringify(error).slice(0, 400);
  } catch {
    return String(error).slice(0, 400);
  }
}

function violations(): ViolationRecord[] {
  return window.__spikeEarly?.violations ?? [];
}

function violationsSince(index: number): ViolationRecord[] {
  return violations().slice(index);
}

function violationSummary(list: ViolationRecord[]): JsonValue {
  return list.map((v) => ({ directive: v.effectiveDirective || v.violatedDirective, blocked: v.blockedURI.slice(0, 120) }));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms} ms: ${label}`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(data: BufferSource): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', data));
}

function base64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function setStatus(text: string): void {
  const status = document.getElementById('status');
  if (status) status.textContent = text;
}

function showResult(result: ProbeResult): void {
  const list = document.getElementById('results');
  if (!list) return;
  const item = document.createElement('li');
  item.className = result.status;
  item.textContent = `${result.id}: ${result.status} - ${result.summary}`;
  list.append(item);
}

async function runProbe(id: ProbeId, run: () => Promise<Outcome>, timeoutMs = 10_000): Promise<ProbeResult> {
  const begin = performance.now();
  let outcome: Outcome;
  try {
    outcome = await withTimeout(run(), timeoutMs, id);
  } catch (error) {
    outcome = { status: 'fail', summary: `probe threw: ${errorText(error)}` };
  }
  const result: ProbeResult = {
    id,
    status: outcome.status,
    summary: outcome.summary.slice(0, 500),
    durationMs: Math.round((performance.now() - begin) * 10) / 10,
    details: outcome.details ?? {},
  };
  probes.push(result);
  showResult(result);
  return result;
}

function loadImage(url: string, timeoutMs = 5000): Promise<HTMLImageElement> {
  const image = new Image();
  const loaded = new Promise<HTMLImageElement>((resolve, reject) => {
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('image failed to load'));
  });
  image.src = url;
  return withTimeout(loaded, timeoutMs, `image ${url.slice(0, 40)}`);
}

interface RasterResult {
  tainted: boolean;
  taintError: string | null;
  width: number;
  height: number;
  nonWhitePixels: number;
  pixelSha256: string;
  pngBytes: number;
  pngSha256: string;
  pngSignatureOk: boolean;
  drawAttempts: number;
  pngBlob: Blob | null;
}

/** Rasterize standalone SVG markup to PNG through an <img> on a blob: URL and a 2D canvas. */
async function rasterizeSvg(svgText: string, width: number, height: number, scale = 2): Promise<RasterResult> {
  const pixelWidth = Math.round(width * scale);
  const pixelHeight = Math.round(height * scale);
  const url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }));
  try {
    const image = await loadImage(url);
    try {
      await image.decode();
    } catch {
      // decode() can reject for SVG in some engines after onload; drawing is still attempted.
    }
    const canvas = createCaptureCanvas(pixelWidth, pixelHeight);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('2d context unavailable');
    // Some engines finish laying out foreignObject content after the first paint; redraw a few times.
    let attempts = 0;
    let result: RasterResult | null = null;
    while (attempts < 3) {
      attempts += 1;
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, pixelWidth, pixelHeight);
      context.drawImage(image, 0, 0, pixelWidth, pixelHeight);
      result = await summarizeCanvas(canvas, context, attempts);
      if (result.tainted || result.nonWhitePixels > 0) break;
      await delay(100);
    }
    if (!result) throw new Error('no draw attempt');
    return result;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function createCaptureCanvas(pixelWidth: number, pixelHeight: number): HTMLCanvasElement {
  if (pixelWidth > MAX_CAPTURE_EDGE || pixelHeight > MAX_CAPTURE_EDGE || pixelWidth * pixelHeight > MAX_CAPTURE_PIXELS) {
    throw new Error(`capture ${pixelWidth}x${pixelHeight} exceeds bounds`);
  }
  const canvas = document.createElement('canvas');
  canvas.width = pixelWidth;
  canvas.height = pixelHeight;
  return canvas;
}

/** Taint check (toDataURL), pixel statistics and PNG encoding for a finished capture canvas. */
async function summarizeCanvas(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D, attempts: number): Promise<RasterResult> {
  let taintError: string | null = null;
  let pixels: Uint8ClampedArray<ArrayBuffer> | null = null;
  try {
    canvas.toDataURL('image/png');
    pixels = new Uint8ClampedArray(context.getImageData(0, 0, canvas.width, canvas.height).data);
  } catch (error) {
    taintError = errorText(error);
  }
  let nonWhite = 0;
  if (pixels) {
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] < 245 || pixels[i + 1] < 245 || pixels[i + 2] < 245) nonWhite += 1;
    }
  }
  let pngBlob: Blob | null = null;
  let pngSha256 = '';
  let pngSignatureOk = false;
  if (!taintError) {
    pngBlob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (pngBlob) {
      const bytes = await pngBlob.arrayBuffer();
      const head = new Uint8Array(bytes, 0, 8);
      pngSignatureOk = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
      pngSha256 = await sha256Hex(bytes);
    }
  }
  return {
    tainted: taintError !== null,
    taintError,
    width: canvas.width,
    height: canvas.height,
    nonWhitePixels: nonWhite,
    pixelSha256: pixels ? (await sha256Hex(pixels)).slice(0, 32) : '',
    pngBytes: pngBlob?.size ?? 0,
    pngSha256,
    pngSignatureOk,
    drawAttempts: attempts,
    pngBlob,
  };
}

/** Keeps a bounded PNG for the report so the launcher can save and inspect it. */
async function recordCapture(probeId: ProbeId, raster: RasterResult | null): Promise<void> {
  if (!raster?.pngBlob || raster.tainted || captures.length >= MAX_CAPTURES) return;
  const encoded = base64(await raster.pngBlob.arrayBuffer());
  if (encoded.length > MAX_CAPTURE_BASE64) return;
  captures.push({ probeId, mimeType: 'image/png', width: raster.width, height: raster.height, sha256: raster.pngSha256, base64: encoded });
}

function rasterDetails(result: RasterResult, extra: Details = {}): Details {
  return {
    tainted: result.tainted,
    taintError: result.taintError,
    width: result.width,
    height: result.height,
    nonWhitePixels: result.nonWhitePixels,
    pixelSha256Prefix: result.pixelSha256,
    pngBytes: result.pngBytes,
    pngSha256: result.pngSha256,
    pngSignatureOk: result.pngSignatureOk,
    drawAttempts: result.drawAttempts,
    ...extra,
  };
}

function showCapture(blob: Blob | null, label: string): void {
  const slot = document.getElementById('capture');
  if (!slot || !blob) return;
  const image = document.createElement('img');
  image.alt = label;
  image.src = URL.createObjectURL(blob);
  slot.append(image);
}

function svgElement<K extends keyof SVGElementTagNameMap>(name: K, attributes: Record<string, string | number>): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

/** Builds a small scene with presentation attributes only (no style attributes, which CSP would block). */
function buildScene(): SVGSVGElement {
  const svg = svgElement('svg', { xmlns: SVG_NS, width: 320, height: 160, viewBox: '0 0 320 160', role: 'img' });
  svg.append(svgElement('rect', { x: 0, y: 0, width: 320, height: 160, fill: '#ffffff' }));
  svg.append(svgElement('line', { x1: 20, y1: 130, x2: 300, y2: 130, stroke: '#5b6878', 'stroke-width': 1 }));
  const points: string[] = [];
  for (let i = 0; i <= 40; i += 1) {
    const x = -2 + (4 * i) / 40;
    const y = x * x - 1;
    points.push(`${i === 0 ? 'M' : 'L'}${(160 + x * 60).toFixed(2)},${(130 - (y + 1) * 25).toFixed(2)}`);
  }
  svg.append(svgElement('path', { d: points.join(' '), fill: 'none', stroke: '#0f7a4a', 'stroke-width': 3 }));
  svg.append(svgElement('circle', { cx: 160, cy: 130, r: 6, fill: '#b42318' }));
  const text = svgElement('text', { x: 20, y: 34, 'font-family': 'SpikeLocalSerif, serif', 'font-size': 24, fill: '#1f2a37' });
  text.textContent = 'y = x² − 1 (vertex)';
  svg.append(text);
  return svg;
}

function serializeSvg(svg: SVGSVGElement, extraStyle?: string): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  if (extraStyle) {
    const style = document.createElementNS(SVG_NS, 'style');
    style.textContent = extraStyle;
    clone.insertBefore(style, clone.firstChild);
  }
  return new XMLSerializer().serializeToString(clone);
}

async function fontDataUri(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`font fetch ${response.status}`);
  return `data:font/woff2;base64,${base64(await response.arrayBuffer())}`;
}

// ---------------------------------------------------------------------------------------------
// Probes

async function probeEnvironment(): Promise<Outcome> {
  const globals = window as unknown as Record<string, unknown>;
  return {
    status: 'info',
    summary: `${location.origin} secure=${String(window.isSecureContext)}`,
    details: {
      userAgent: navigator.userAgent,
      origin: location.origin,
      protocol: location.protocol,
      href: location.href,
      baseURI: document.baseURI,
      isSecureContext: window.isSecureContext,
      crossOriginIsolated: window.crossOriginIsolated,
      sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
      hardwareConcurrency: navigator.hardwareConcurrency,
      devicePixelRatio: window.devicePixelRatio,
      language: navigator.language,
      visibilityState: document.visibilityState,
      hasFocus: document.hasFocus(),
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      tauriInternalsPresent: '__TAURI_INTERNALS__' in globals,
      tauriGlobalApiPresent: '__TAURI__' in globals,
      objectPrototypeFrozen: Object.isFrozen(Object.prototype),
      earlyScriptBootedAtMs: window.__spikeEarly?.bootedAtMs ?? null,
    },
  };
}

async function probeEvalNegative(): Promise<Outcome> {
  const before = violations().length;
  try {
    const made = new Function('return 6 * 7') as () => number;
    return { status: 'unexpected-allow', summary: `new Function executed (${made()})` };
  } catch (error) {
    await delay(20);
    return { status: 'expected-block', summary: errorText(error), details: { violations: violationSummary(violationsSince(before)) } };
  }
}

async function probeInlineStyleNegative(): Promise<Outcome> {
  const before = violations().length;
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  document.body.append(host);
  try {
    host.innerHTML = '<span id="csp-style-parsed" style="color: rgb(1, 2, 3)">parsed</span>';
    const viaSetAttribute = document.createElement('span');
    viaSetAttribute.setAttribute('style', 'color: rgb(4, 5, 6)');
    viaSetAttribute.textContent = 'setAttribute';
    const viaCssom = document.createElement('span');
    viaCssom.style.color = 'rgb(7, 8, 9)';
    viaCssom.textContent = 'cssom';
    host.append(viaSetAttribute, viaCssom);
    const parsed = host.querySelector<HTMLElement>('#csp-style-parsed');
    const parsedApplied = parsed ? getComputedStyle(parsed).color === 'rgb(1, 2, 3)' : false;
    const setAttributeApplied = getComputedStyle(viaSetAttribute).color === 'rgb(4, 5, 6)';
    const cssomApplied = getComputedStyle(viaCssom).color === 'rgb(7, 8, 9)';
    await delay(20);
    const blocked = !parsedApplied && !setAttributeApplied;
    return {
      status: blocked ? 'expected-block' : 'unexpected-allow',
      summary: `parsed style attr applied=${String(parsedApplied)}, setAttribute style applied=${String(setAttributeApplied)}, CSSOM style applied=${String(cssomApplied)}`,
      details: { parsedApplied, setAttributeApplied, cssomApplied, violations: violationSummary(violationsSince(before)) },
    };
  } finally {
    host.remove();
  }
}

async function probeModuleWorker(): Promise<{ outcome: Outcome; reply: WorkerProbeReply | null }> {
  let worker: Worker;
  try {
    worker = new Worker(new URL('./probe-worker.ts', import.meta.url), { type: 'module', name: 'study-harness-probe' });
  } catch (error) {
    return { outcome: { status: 'fail', summary: `new Worker threw: ${errorText(error)}` }, reply: null };
  }
  const request: WorkerProbeRequest = {
    kind: 'probe',
    requestId: crypto.randomUUID(),
    dataUrl: new URL('./data/probe-data.json', document.baseURI).href,
  };
  try {
    const reply = await withTimeout(
      new Promise<WorkerProbeReply>((resolve, reject) => {
        worker.addEventListener('message', (event: MessageEvent<WorkerProbeReply | WorkerErrorReply>) => {
          const data = event.data;
          if (data.requestId !== request.requestId) return reject(new Error('reply for a different request'));
          if (data.kind === 'probe-result') resolve(data);
          else reject(new Error(`worker error reply: ${data.message}`));
        });
        worker.addEventListener('error', (event: ErrorEvent) => {
          reject(new Error(`worker error event: ${event.message || 'module failed to load (no message)'}`));
        });
        worker.addEventListener('messageerror', () => reject(new Error('worker messageerror')));
        worker.postMessage(request);
      }),
      8000,
      'module worker reply',
    );
    return {
      outcome: {
        status: 'pass',
        summary: `module worker ran from ${reply.workerLocation}`,
        details: {
          constructionPattern: "new Worker(new URL('./probe-worker.ts', import.meta.url), { type: 'module' })",
          workerLocation: reply.workerLocation,
          importMetaUrl: reply.importMetaUrl,
          workerIsSecureContext: reply.isSecureContext,
          sameOriginAsPage: new URL(reply.workerLocation).origin === location.origin,
        },
      },
      reply,
    };
  } catch (error) {
    return { outcome: { status: 'fail', summary: errorText(error) }, reply: null };
  } finally {
    worker.terminate();
  }
}

async function probeBlobWorkerNegative(): Promise<Outcome> {
  const before = violations().length;
  const url = URL.createObjectURL(new Blob(['postMessage("blob-worker-ran");'], { type: 'text/javascript' }));
  let worker: Worker | null = null;
  try {
    try {
      worker = new Worker(url, { type: 'module' });
    } catch (error) {
      await delay(20);
      return { status: 'expected-block', summary: `constructor threw: ${errorText(error)}`, details: { violations: violationSummary(violationsSince(before)) } };
    }
    const created = worker;
    const result = await new Promise<'message' | 'error' | 'timeout'>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 3000);
      created.addEventListener('message', () => {
        clearTimeout(timer);
        resolve('message');
      });
      created.addEventListener('error', () => {
        clearTimeout(timer);
        resolve('error');
      });
    });
    const details: Details = { outcome: result, violations: violationSummary(violationsSince(before)) };
    if (result === 'message') return { status: 'unexpected-allow', summary: 'blob: module worker executed', details };
    if (result === 'error') return { status: 'expected-block', summary: 'blob: worker failed with error event', details };
    return { status: 'fail', summary: 'blob: worker neither ran nor reported an error within 3 s', details };
  } finally {
    worker?.terminate();
    URL.revokeObjectURL(url);
  }
}

async function probeCryptoMain(): Promise<Outcome> {
  const digest = await sha256Hex(new TextEncoder().encode('abc'));
  const uuid = crypto.randomUUID();
  const random = crypto.getRandomValues(new Uint32Array(2));
  const ok = digest === SHA256_ABC && UUID_V4.test(uuid);
  return {
    status: ok ? 'pass' : 'fail',
    summary: `digest ${digest === SHA256_ABC ? 'matches' : 'MISMATCH'}, randomUUID ${UUID_V4.test(uuid) ? 'valid v4' : 'INVALID'}`,
    details: { digest, uuid, getRandomValuesNonZero: random[0] !== 0 || random[1] !== 0, isSecureContext: window.isSecureContext },
  };
}

async function probeLocalData(reply: WorkerProbeReply | null): Promise<Outcome> {
  const url = new URL('./data/probe-data.json', document.baseURI).href;
  const response = await fetch(url, { cache: 'no-store' });
  const body = (await response.json()) as { samples?: unknown[] };
  const samples = Array.isArray(body.samples) ? body.samples.length : 0;
  const workerOk = reply?.dataFetch.ok ?? false;
  return {
    status: response.ok && samples === 5 && workerOk ? 'pass' : 'fail',
    summary: `page fetch ${response.status} (${samples} samples), worker fetch ${workerOk ? 'ok' : 'failed'}`,
    details: {
      url,
      status: response.status,
      contentType: response.headers.get('content-type'),
      accessControlAllowOrigin: response.headers.get('access-control-allow-origin'),
      workerFetch: reply ? `${reply.dataFetch.detail} samples=${reply.dataFetch.samples}` : null,
    },
  };
}

async function probeLocalFont(): Promise<Outcome> {
  const sample = document.createElement('p');
  sample.className = 'local-font-sample';
  sample.textContent = 'Local font: Study harness 0123';
  document.querySelector('.spike')?.insertBefore(sample, document.getElementById('status'));
  const faces = await document.fonts.load('32px SpikeLocalSerif', 'Study');
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  let localWidth = 0;
  let fallbackWidth = 0;
  if (context) {
    context.font = '32px SpikeLocalSerif, monospace';
    localWidth = context.measureText('Study harness 0123').width;
    context.font = '32px monospace';
    fallbackWidth = context.measureText('Study harness 0123').width;
  }
  const loaded = faces.length > 0 && faces.every((face) => face.status === 'loaded');
  const differs = Math.abs(localWidth - fallbackWidth) > 0.5;
  return {
    status: loaded && differs ? 'pass' : 'fail',
    summary: `faces=${faces.length} loaded=${String(loaded)} width local=${localWidth.toFixed(1)} fallback=${fallbackWidth.toFixed(1)}`,
    details: {
      fontUrl: new URL(localFontUrl, document.baseURI).href,
      faceStatuses: faces.map((face) => `${face.family}:${face.status}`),
      checkResult: document.fonts.check('32px SpikeLocalSerif'),
      localWidth,
      fallbackWidth,
    },
  };
}

async function probeKatexDom(): Promise<Outcome> {
  const before = violations().length;
  const slot = document.getElementById('math-dom');
  if (!slot) throw new Error('missing #math-dom');
  katex.render(QUADRATIC_TEX, slot, KATEX_OPTIONS);
  const strut = slot.querySelector<HTMLElement>(STRUT_SELECTOR);
  const strutHeight = strut ? parseFloat(getComputedStyle(strut).height) : 0;
  const base = slot.querySelector<HTMLElement>('.katex-base, .base');
  const baseHeight = base ? base.getBoundingClientRect().height : 0;
  const hasHtml = slot.querySelector('.katex-html') !== null;
  const hasMathml = slot.querySelector('.katex-mathml math') !== null;
  // Untrusted command with trust:false must not produce a link element.
  const hostile = document.createElement('div');
  katex.render(String.raw`\href{https://remote.invalid/x}{x}`, hostile, { ...KATEX_OPTIONS, throwOnError: false });
  const hostileAnchor = hostile.querySelector('a') !== null;
  await delay(20);
  const ok = hasHtml && hasMathml && strutHeight > 0 && baseHeight > 0 && !hostileAnchor;
  return {
    status: ok ? 'pass' : 'fail',
    summary: `html=${String(hasHtml)} mathml=${String(hasMathml)} strutHeight=${strutHeight.toFixed(2)}px baseHeight=${baseHeight.toFixed(2)}px untrustedHrefAnchor=${String(hostileAnchor)}`,
    details: {
      api: 'katex.render (DOM nodes, styles applied through CSSOM)',
      katexVersion: katex.version,
      options: { trust: false, maxExpand: 1000, maxSize: 20, output: 'htmlAndMathml' },
      styledElements: slot.querySelectorAll('[style]').length,
      strutSelector: STRUT_SELECTOR,
      strutHeightPx: strutHeight,
      baseHeightPx: baseHeight,
      violations: violationSummary(violationsSince(before)),
    },
  };
}

async function probeKatexString(): Promise<Outcome> {
  const before = violations().length;
  const slot = document.getElementById('math-string');
  if (!slot) throw new Error('missing #math-string');
  const html = katex.renderToString(QUADRATIC_TEX, KATEX_OPTIONS);
  slot.innerHTML = html;
  const strut = slot.querySelector<HTMLElement>(STRUT_SELECTOR);
  const strutHeight = strut ? parseFloat(getComputedStyle(strut).height) : 0;
  const domSlot = document.getElementById('math-dom');
  const domStrut = domSlot?.querySelector<HTMLElement>(STRUT_SELECTOR);
  const domStrutHeight = domStrut ? parseFloat(getComputedStyle(domStrut).height) : 0;
  await delay(20);
  const styleAttributesInMarkup = (html.match(/style="/g) ?? []).length;
  const applied = strutHeight > 0 && Math.abs(strutHeight - domStrutHeight) < 0.5;
  return {
    status: applied ? 'unexpected-allow' : 'expected-block',
    summary: applied
      ? 'renderToString + innerHTML styles applied (policy allows inline style attributes)'
      : `renderToString + innerHTML lost ${styleAttributesInMarkup} inline style attributes under CSP (strut ${strutHeight.toFixed(2)}px vs DOM ${domStrutHeight.toFixed(2)}px)`,
    details: {
      api: 'katex.renderToString + innerHTML',
      styleAttributesInMarkup,
      strutHeightPx: strutHeight,
      domStrutHeightPx: domStrutHeight,
      violations: violationSummary(violationsSince(before)),
    },
  };
}

async function probeKatexFonts(): Promise<Outcome> {
  await document.fonts.load('20px KaTeX_Main', 'x');
  await document.fonts.load('italic 20px KaTeX_Math', 'x');
  await document.fonts.ready;
  const katexFaces: string[] = [];
  let mainLoaded = false;
  let mathItalicLoaded = false;
  document.fonts.forEach((face) => {
    const family = face.family.replace(/["']/g, '');
    if (!family.startsWith('KaTeX')) return;
    if (face.status !== 'unloaded') katexFaces.push(`${family}/${face.style}/${face.weight}:${face.status}`);
    if (family === 'KaTeX_Main' && face.style === 'normal' && (face.weight === '400' || face.weight === 'normal') && face.status === 'loaded') mainLoaded = true;
    if (family === 'KaTeX_Math' && face.style === 'italic' && face.status === 'loaded') mathItalicLoaded = true;
  });
  return {
    status: mainLoaded && mathItalicLoaded ? 'pass' : 'fail',
    summary: `KaTeX_Main=${String(mainLoaded)} KaTeX_Math italic=${String(mathItalicLoaded)} (${katexFaces.length} faces touched)`,
    details: { faces: katexFaces.slice(0, 40) },
  };
}

async function probeSvgRender(scene: SVGSVGElement): Promise<Outcome> {
  const slot = document.getElementById('scene');
  if (!slot) throw new Error('missing #scene');
  slot.append(scene);
  await document.fonts.ready;
  const text = scene.querySelector('text');
  const path = scene.querySelector('path');
  const textBox = text?.getBBox();
  const pathLength = path?.getTotalLength() ?? 0;
  const ok = !!textBox && textBox.width > 0 && pathLength > 0;
  return {
    status: ok ? 'pass' : 'fail',
    summary: `text bbox ${textBox ? `${textBox.width.toFixed(1)}x${textBox.height.toFixed(1)}` : 'none'}, path length ${pathLength.toFixed(1)}`,
    details: { textWidth: textBox?.width ?? 0, textHeight: textBox?.height ?? 0, pathLength, rendering: 'createElementNS + presentation attributes' },
  };
}

async function probePngSvg(scene: SVGSVGElement): Promise<{ outcome: Outcome; raster: RasterResult | null }> {
  const raster = await rasterizeSvg(serializeSvg(scene), 320, 160);
  showCapture(raster.pngBlob, 'Scene capture');
  await recordCapture('png-capture-svg', raster);
  const ok = !raster.tainted && raster.pngSignatureOk && raster.nonWhitePixels > 500;
  return {
    outcome: {
      status: ok ? 'pass' : 'fail',
      summary: raster.tainted ? `canvas tainted: ${raster.taintError ?? ''}` : `PNG ${raster.pngBytes} bytes, ${raster.nonWhitePixels} non-white px`,
      details: rasterDetails(raster, { path: 'XMLSerializer -> Blob(image/svg+xml) -> blob: URL -> <img> -> canvas.drawImage -> toDataURL/toBlob' }),
    },
    raster,
  };
}

async function probePngSvgEmbeddedFont(scene: SVGSVGElement, plain: RasterResult | null): Promise<Outcome> {
  const fontData = await fontDataUri(localFontUrl);
  const style = `@font-face{font-family:'SpikeLocalSerif';src:url(${fontData}) format('woff2');}`;
  const raster = await rasterizeSvg(serializeSvg(scene, style), 320, 160);
  await recordCapture('png-capture-svg-embedded-font', raster);
  const differs = plain ? plain.pixelSha256 !== raster.pixelSha256 : false;
  return {
    status: !raster.tainted && raster.nonWhitePixels > 500 ? 'pass' : 'fail',
    summary: raster.tainted
      ? `canvas tainted: ${raster.taintError ?? ''}`
      : `embedded data: font in SVG image ${differs ? 'changed' : 'did NOT change'} the raster vs. the plain capture`,
    details: rasterDetails(raster, {
      embeddedFontBytes: fontData.length,
      rasterDiffersFromPlainCapture: differs,
      note: 'SVG-as-image documents cannot use page web fonts; fonts must be embedded as data: URIs inside the SVG.',
    }),
  };
}

async function probeForeignObjectHtml(): Promise<Outcome> {
  const svg =
    `<svg xmlns="${SVG_NS}" width="240" height="80" viewBox="0 0 240 80">` +
    `<rect width="240" height="80" fill="#ffffff"/>` +
    `<foreignObject x="0" y="0" width="240" height="80">` +
    `<div xmlns="${XHTML_NS}" style="font: 20px sans-serif; color: #1f2a37; background: #e8f3ee; padding: 12px;">HTML in foreignObject</div>` +
    `</foreignObject></svg>`;
  const raster = await rasterizeSvg(svg, 240, 80);
  return {
    status: !raster.tainted && raster.nonWhitePixels > 500 ? 'pass' : 'fail',
    summary: raster.tainted ? `canvas tainted by foreignObject: ${raster.taintError ?? ''}` : `foreignObject HTML rasterized, ${raster.nonWhitePixels} non-white px`,
    details: rasterDetails(raster),
  };
}

async function probeForeignObjectKatex(): Promise<Outcome> {
  const holder = document.createElement('div');
  katex.render(QUADRATIC_TEX, holder, KATEX_OPTIONS);
  const markup = new XMLSerializer().serializeToString(holder);
  const [mainFont, mathFont] = await Promise.all([fontDataUri(katexMainFontUrl), fontDataUri(katexMathItalicFontUrl)]);
  const css =
    katexCssText.replace(/@font-face\s*\{[^}]*\}/g, '') +
    `@font-face{font-family:KaTeX_Main;font-style:normal;font-weight:400;src:url(${mainFont}) format('woff2');}` +
    `@font-face{font-family:KaTeX_Math;font-style:italic;font-weight:400;src:url(${mathFont}) format('woff2');}`;
  const svg =
    `<svg xmlns="${SVG_NS}" width="360" height="90" viewBox="0 0 360 90">` +
    `<style>${css.replace(/</g, '\\3c ')}</style>` +
    `<rect width="360" height="90" fill="#ffffff"/>` +
    `<foreignObject x="0" y="0" width="360" height="90">` +
    `<div xmlns="${XHTML_NS}" style="font-size: 20px; color: #1f2a37; padding: 4px 12px;">${markup}</div>` +
    `</foreignObject></svg>`;
  const raster = await rasterizeSvg(svg, 360, 90);
  if (!raster.tainted) showCapture(raster.pngBlob, 'KaTeX foreignObject capture');
  return {
    status: !raster.tainted && raster.nonWhitePixels > 500 ? 'pass' : 'fail',
    summary: raster.tainted ? `canvas tainted by KaTeX foreignObject: ${raster.taintError ?? ''}` : `KaTeX foreignObject rasterized, ${raster.nonWhitePixels} non-white px`,
    details: rasterDetails(raster, { svgBytes: svg.length, embeddedFonts: ['KaTeX_Main-Regular', 'KaTeX_Math-Italic'] }),
  };
}

function clipAncestor(element: Element, root: Element): Element {
  for (let current = element.parentElement; current && current !== root; current = current.parentElement) {
    const style = getComputedStyle(current);
    if (style.overflowX === 'hidden' || style.overflow === 'hidden') return current;
  }
  return root;
}

/**
 * Untainted KaTeX PNG capture without foreignObject: walk the laid-out KaTeX DOM and repaint it on a
 * 2D canvas (glyph runs with the already-loaded page fonts, border rules, and the inline SVG radicals
 * rasterized as pure SVG images).
 */
async function probeKatexCanvas(): Promise<Outcome> {
  const root = document.querySelector<HTMLElement>('#math-dom .katex-html');
  if (!root) throw new Error('rendered KaTeX (.katex-html) not found');
  await document.fonts.ready;
  const bases = [...root.querySelectorAll<HTMLElement>('.katex-base, .base')];
  if (bases.length === 0) throw new Error('no KaTeX base boxes');
  const pad = 8;
  const left = Math.min(...bases.map((b) => b.getBoundingClientRect().left)) - pad;
  const top = Math.min(...bases.map((b) => b.getBoundingClientRect().top)) - pad;
  const right = Math.max(...bases.map((b) => b.getBoundingClientRect().right)) + pad;
  const bottom = Math.max(...bases.map((b) => b.getBoundingClientRect().bottom)) + pad;
  const scale = 2;
  const width = Math.ceil(right - left);
  const height = Math.ceil(bottom - top);
  const canvas = createCaptureCanvas(width * scale, height * scale);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2d context unavailable');
  context.scale(scale, scale);
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);

  let glyphRuns = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? '';
    const parent = node.parentElement;
    if (!parent || !text.replace(/[\s​]/g, '')) continue;
    const style = getComputedStyle(parent);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    context.fillStyle = style.color;
    context.textBaseline = 'alphabetic';
    const metrics = context.measureText(text);
    const range = document.createRange();
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    context.fillText(text, rect.left - left, rect.top - top + metrics.fontBoundingBoxAscent);
    glyphRuns += 1;
  }

  let rules = 0;
  for (const element of root.querySelectorAll<HTMLElement>('*')) {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const topWidth = parseFloat(style.borderTopWidth);
    if (topWidth > 0 && style.borderTopStyle !== 'none') {
      context.fillStyle = style.borderTopColor;
      context.fillRect(rect.left - left, rect.top - top, rect.width, topWidth);
      rules += 1;
    }
    const bottomWidth = parseFloat(style.borderBottomWidth);
    if (bottomWidth > 0 && style.borderBottomStyle !== 'none') {
      context.fillStyle = style.borderBottomColor;
      context.fillRect(rect.left - left, rect.bottom - top - bottomWidth, rect.width, bottomWidth);
      rules += 1;
    }
  }

  let svgs = 0;
  for (const svg of root.querySelectorAll<SVGSVGElement>('svg')) {
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const clip = clipAncestor(svg, root).getBoundingClientRect();
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('xmlns', SVG_NS);
    clone.setAttribute('width', String(rect.width));
    clone.setAttribute('height', String(rect.height));
    clone.setAttribute('fill', getComputedStyle(svg).color);
    clone.setAttribute('stroke', 'none');
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' }));
    try {
      const image = await loadImage(url);
      context.save();
      context.beginPath();
      context.rect(clip.left - left, clip.top - top, clip.width, clip.height);
      context.clip();
      context.drawImage(image, rect.left - left, rect.top - top, rect.width, rect.height);
      context.restore();
      svgs += 1;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  const raster = await summarizeCanvas(canvas, context, 1);
  showCapture(raster.pngBlob, 'KaTeX canvas capture');
  await recordCapture('png-capture-katex-canvas', raster);
  const ok = !raster.tainted && glyphRuns > 0 && rules > 0 && svgs > 0 && raster.nonWhitePixels > 300;
  return {
    status: ok ? 'pass' : 'fail',
    summary: raster.tainted
      ? `canvas tainted: ${raster.taintError ?? ''}`
      : `${glyphRuns} glyph runs, ${rules} rules, ${svgs} SVG parts repainted; PNG ${raster.pngBytes} bytes`,
    details: rasterDetails(raster, {
      approach: 'DOM walk: fillText per KaTeX text node with computed font, border rules as rects, inline SVG via blob: image, clipped to overflow ancestor',
      glyphRuns,
      rules,
      svgParts: svgs,
      cssWidth: width,
      cssHeight: height,
    }),
  };
}

async function probeDataUrlNegative(): Promise<Outcome> {
  const before = violations().length;
  const svg = `<svg xmlns="${SVG_NS}" width="4" height="4"><rect width="4" height="4" fill="red"/></svg>`;
  try {
    await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, 3000);
    return { status: 'unexpected-allow', summary: 'data: image loaded', details: { violations: violationSummary(violationsSince(before)) } };
  } catch (error) {
    await delay(20);
    return { status: 'expected-block', summary: `data: image rejected (${errorText(error)})`, details: { violations: violationSummary(violationsSince(before)) } };
  }
}

async function probeOffscreen(reply: WorkerProbeReply | null): Promise<Outcome> {
  if (!reply) return { status: 'fail', summary: 'module worker unavailable' };
  return {
    status: reply.offscreen2d.ok ? 'pass' : 'fail',
    summary: `OffscreenCanvas 2d PNG ${reply.offscreen2d.pngBytes} bytes; worker webgl2 ${reply.offscreenWebgl2.available ? 'available' : 'unavailable'}`,
    details: { offscreen2d: reply.offscreen2d.detail, offscreenWebgl2: reply.offscreenWebgl2.detail },
  };
}

async function probeWebgl(): Promise<Outcome> {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 4;
  const gl2 = canvas.getContext('webgl2');
  const gl: WebGLRenderingContext | WebGL2RenderingContext | null = gl2 ?? document.createElement('canvas').getContext('webgl');
  if (!gl) return { status: 'info', summary: 'WebGL unavailable', details: { webgl2: false, webgl1: false } };
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  gl.clearColor(0, 0.5, 1, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  const pixel = new Uint8Array(4);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  const functional = pixel[2] === 255 && pixel[3] === 255;
  return {
    status: 'info',
    summary: `${gl2 ? 'WebGL2' : 'WebGL1'} available, clear/readPixels ${functional ? 'ok' : 'unexpected'}`,
    details: {
      webgl2: gl2 !== null,
      version: String(gl.getParameter(gl.VERSION)),
      shadingLanguage: String(gl.getParameter(gl.SHADING_LANGUAGE_VERSION)),
      vendor: String(gl.getParameter(gl.VENDOR)),
      renderer: String(gl.getParameter(gl.RENDERER)),
      unmaskedRenderer: debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : null,
      maxTextureSize: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)),
      readPixels: Array.from(pixel),
      functional,
    },
  };
}

async function probeAnimationFrame(): Promise<Outcome> {
  let frames = 0;
  const begin = performance.now();
  await new Promise<void>((resolve) => {
    const tick = (now: number) => {
      frames += 1;
      if (now - begin < 500) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
  const elapsed = performance.now() - begin;
  return {
    status: 'info',
    summary: `${frames} frames in ${elapsed.toFixed(0)} ms (${((frames * 1000) / elapsed).toFixed(1)} fps), visibility=${document.visibilityState}`,
    details: { frames, elapsedMs: Math.round(elapsed), visibilityState: document.visibilityState, hasFocus: document.hasFocus() },
  };
}

async function probeRemoteNegative(): Promise<Outcome> {
  const before = violations().length;
  try {
    await fetch(NEGATIVE_REMOTE_URL, { mode: 'no-cors', cache: 'no-store' });
    return { status: 'unexpected-allow', summary: 'remote fetch resolved' };
  } catch (error) {
    await delay(20);
    const found = violationsSince(before).filter((v) => (v.effectiveDirective || v.violatedDirective).startsWith('connect-src'));
    return {
      status: found.length > 0 ? 'expected-block' : 'fail',
      summary: found.length > 0 ? 'blocked by connect-src before any network activity' : `rejected without a CSP violation (${errorText(error)})`,
      details: { target: NEGATIVE_REMOTE_URL, note: 'Deliberate negative probe; .invalid is reserved and never resolves.', violations: violationSummary(found) },
    };
  }
}

function classifyOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'blob:' || parsed.protocol === 'data:') return parsed.protocol;
    return parsed.origin === 'null' ? `${parsed.protocol}//${parsed.host}` : parsed.origin;
  } catch {
    return 'unparseable';
  }
}

async function probeResourceOrigins(): Promise<{ outcome: Outcome; origins: string[] }> {
  const entries = performance.getEntriesByType('resource').map((entry) => entry.name);
  const fromTiming = entries.map(classifyOrigin);
  const fromFetch = requestLog.filter((url) => url !== NEGATIVE_REMOTE_URL).map(classifyOrigin);
  const origins = [...new Set([...fromTiming, ...fromFetch])].sort();
  const allowed = new Set([location.origin, 'blob:', 'ipc://localhost', 'http://ipc.localhost']);
  const unexpected = origins.filter((origin) => !allowed.has(origin));
  return {
    outcome: {
      status: unexpected.length === 0 ? 'pass' : 'fail',
      summary: unexpected.length === 0 ? `all ${entries.length} resource loads and ${fromFetch.length} fetches stayed on app origins` : `unexpected origins: ${unexpected.join(', ')}`,
      details: {
        origins,
        resourceEntries: entries.length,
        sampleEntries: entries.slice(0, 20).map((name) => name.slice(0, 160)),
        excludedDeliberateNegativeProbe: NEGATIVE_REMOTE_URL,
      },
    },
    origins,
  };
}

async function probeRejectedCommand(command: string): Promise<Outcome> {
  try {
    const value = await invoke<unknown>(command);
    return { status: 'unexpected-allow', summary: `${command} resolved`, details: { value: errorText(value) } };
  } catch (error) {
    return { status: 'expected-block', summary: `${command} rejected: ${errorText(error)}`, details: { command, error: errorText(error) } };
  }
}

async function readCsp(): Promise<CspObservation> {
  let header: string | null = null;
  try {
    const response = await fetch(new URL('./index.html', document.baseURI).href, { cache: 'no-store' });
    header = response.headers.get('content-security-policy');
  } catch {
    header = null;
  }
  const meta = document.querySelector<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy" i]')?.content ?? null;
  const violationPolicies = [...new Set(violations().map((v) => v.originalPolicy).filter(Boolean))];
  return { header, meta, violationPolicies };
}

function buildResults(csp: CspObservation, resourceOrigins: string[], includeCaptures: boolean): SpikeResults {
  return {
    schema: REPORT_SCHEMA,
    runId,
    userAgent: navigator.userAgent,
    origin: location.origin,
    href: location.href,
    isSecureContext: window.isSecureContext,
    startedAt,
    durationMs: Math.round(performance.now() - startedMs),
    probes: probes.slice(),
    csp,
    violations: violations().slice(0, 64),
    requestLog: requestLog.slice(0, 128),
    resourceOrigins,
    captures: includeCaptures ? captures.slice() : [],
  };
}

async function probeValidationUnknownKey(base: SpikeResults): Promise<Outcome> {
  try {
    await invoke<ReportAck>('spike_report', { results: { ...base, unexpectedKey: true } });
    return { status: 'unexpected-allow', summary: 'report with an unknown key was accepted' };
  } catch (error) {
    return { status: 'expected-block', summary: `rejected: ${errorText(error)}` };
  }
}

async function probeValidationOversized(base: SpikeResults): Promise<Outcome> {
  const oversized: SpikeResults = {
    ...base,
    probes: [{ id: 'environment', status: 'info', summary: 'x'.repeat(5000), durationMs: 0, details: {} }],
  };
  try {
    await invoke<ReportAck>('spike_report', { results: oversized });
    return { status: 'unexpected-allow', summary: 'report with a 5000-character summary was accepted' };
  } catch (error) {
    return { status: 'expected-block', summary: `rejected: ${errorText(error)}` };
  }
}

async function main(): Promise<void> {
  await runProbe('environment', probeEnvironment);
  await runProbe('eval-negative', probeEvalNegative);
  await runProbe('inline-style-attr-negative', probeInlineStyleNegative);

  let workerReply: WorkerProbeReply | null = null;
  await runProbe('module-worker', async () => {
    const { outcome, reply } = await probeModuleWorker();
    workerReply = reply;
    return outcome;
  });
  const reply = workerReply as WorkerProbeReply | null;
  await runProbe('worker-dynamic-import', async () =>
    reply
      ? { status: reply.lazyImport.ok ? 'pass' : 'fail', summary: `${reply.lazyImport.detail}: value=${reply.lazyImport.value}`, details: { chunkUrl: reply.lazyImport.moduleUrl } }
      : { status: 'fail', summary: 'module worker unavailable' },
  );
  await runProbe('web-crypto-worker', async () =>
    reply
      ? {
          status: reply.digest.ok && reply.randomUUID.ok ? 'pass' : 'fail',
          summary: `worker digest ${reply.digest.ok ? 'matches' : 'FAILED'}, randomUUID ${reply.randomUUID.ok ? 'valid' : 'INVALID'}`,
          details: { digest: reply.digest.hex || reply.digest.detail, uuid: reply.randomUUID.sample || reply.randomUUID.detail, workerIsSecureContext: reply.isSecureContext },
        }
      : { status: 'fail', summary: 'module worker unavailable' },
  );
  await runProbe('worker-csp', async () =>
    reply
      ? {
          status: reply.evalBlocked.blocked ? 'expected-block' : 'unexpected-allow',
          summary: reply.evalBlocked.blocked ? 'dynamic code blocked inside the worker' : 'dynamic code NOT blocked inside the worker (no CSP on worker script response)',
          details: { evalBlocked: reply.evalBlocked.blocked, detail: reply.evalBlocked.detail },
        }
      : { status: 'fail', summary: 'module worker unavailable' },
  );
  await runProbe('blob-worker-negative', probeBlobWorkerNegative);
  await runProbe('web-crypto-main', probeCryptoMain);
  await runProbe('local-data-fetch', () => probeLocalData(reply));
  await runProbe('local-font', probeLocalFont);
  await runProbe('katex-dom', probeKatexDom);
  await runProbe('katex-string-innerhtml', probeKatexString);
  await runProbe('katex-fonts', probeKatexFonts);

  const scene = buildScene();
  await runProbe('svg-render', () => probeSvgRender(scene));
  let plainRaster: RasterResult | null = null;
  await runProbe('png-capture-svg', async () => {
    const { outcome, raster } = await probePngSvg(scene);
    plainRaster = raster;
    return outcome;
  });
  await runProbe('png-capture-svg-embedded-font', () => probePngSvgEmbeddedFont(scene, plainRaster));
  await runProbe('png-capture-foreignobject-html', probeForeignObjectHtml);
  await runProbe('png-capture-foreignobject-katex', probeForeignObjectKatex);
  await runProbe('png-capture-katex-canvas', probeKatexCanvas);
  await runProbe('png-data-url-negative', probeDataUrlNegative);
  await runProbe('offscreen-canvas-worker', () => probeOffscreen(reply));
  await runProbe('webgl', probeWebgl);
  await runProbe('animation-frame', probeAnimationFrame);
  await runProbe('remote-connect-negative', probeRemoteNegative);
  await runProbe('command-forbidden-rejected', () => probeRejectedCommand('spike_forbidden'));
  await runProbe('plugin-command-rejected', () => probeRejectedCommand('plugin:app|version'));

  const preliminary = buildResults(await readCsp(), [], false);
  await runProbe('report-validation-rejects-unknown-key', () => probeValidationUnknownKey(preliminary));
  await runProbe('report-validation-rejects-oversized', () => probeValidationOversized(preliminary));

  let resourceOrigins: string[] = [];
  await runProbe('resource-origins', async () => {
    const { outcome, origins } = await probeResourceOrigins();
    resourceOrigins = origins;
    return outcome;
  });
  const csp = await readCsp();
  await runProbe('csp-effective', async () => ({
    status: csp.header && /default-src/.test(csp.header) ? 'pass' : 'fail',
    summary: csp.header ? `header: ${csp.header}` : 'no CSP header observed on index.html',
    details: { header: csp.header, meta: csp.meta, violationPolicies: csp.violationPolicies, headerMatchesViolationPolicy: csp.violationPolicies.includes(csp.header ?? '') },
  }));

  const results = buildResults(csp, resourceOrigins, true);
  setStatus(`Probes finished (${probes.length}); reporting to the host...`);
  try {
    const ack = await invoke<ReportAck>('spike_report', { results });
    setStatus(`Report accepted (${ack.bytes} bytes). The app will exit.`);
  } catch (error) {
    setStatus(`Report rejected: ${errorText(error)}`);
  }
}

main().catch((error: unknown) => setStatus(`Spike failed: ${errorText(error)}`));
