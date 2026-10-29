// CONFORMANCE BUILD ONLY. Packaged-WebView probes (report §17): CSP and its effective directive set, deliberate
// negative probes, module workers, Web Crypto, KaTeX output and fonts inside the learner card, SVG/PNG capture of the
// card, an optional WebGL probe, resource origins and the native command boundary (raw bodies, bounds, stable errors,
// ACL rejection of ungranted and plugin commands).
import { isHostRefusal } from '@explorable-models/activity';
import type { StudyHarnessSurface } from '@explorable-models/player/activity';
import { call, callBytes, callJsonObject, NativeHostError, toNativeError } from '../native-bridge';
import { NativeHostPort } from '../native-host';
import type { ProbeWorkerReply } from './probe-worker';
import { equationVisibility, lazyMathEvidence, mathResources, mathVisibilityState } from './math-visibility';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface ProbeResult { id: string; status: 'pass' | 'fail' | 'info' | 'expected-block' | 'unexpected-allow'; summary: string; ms: number; details: Record<string, unknown> }
interface Violation { violatedDirective: string; effectiveDirective: string; blockedURI: string; sourceFile: string; sample: string; disposition: string; atMs: number }
declare global {
  interface Window { __referenceHostAudit?: { violations: Violation[]; requests: { origin: string; atMs: number }[]; bootedAtMs: number } }
}

const SHA256_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const NEGATIVE_REMOTE_URL = 'https://remote.invalid/study-harness-reference-probe';
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export const audit = () => window.__referenceHostAudit ?? { violations: [], requests: [], bootedAtMs: 0 };
export const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const text = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 300);
const hex = (buffer: ArrayBuffer) => Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('');

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms} ms: ${label}`)), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

export async function probe(id: string, run: () => Promise<Omit<ProbeResult, 'id' | 'ms'>>, timeoutMs = 15_000): Promise<ProbeResult> {
  const started = performance.now();
  let outcome: Omit<ProbeResult, 'id' | 'ms'>;
  try { outcome = await withTimeout(run(), timeoutMs, id); } catch (error) { outcome = { status: 'fail', summary: `probe threw: ${text(error)}`, details: {} }; }
  return { id, ms: Math.round(performance.now() - started), ...outcome };
}

/** Parses a CSP header into a normalized directive set (sorted sources; Tauri's per-file script hashes counted). */
export function directiveSet(header: string): Record<string, string[]> {
  const set: Record<string, string[]> = {};
  for (const part of header.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/).filter(Boolean);
    if (name) set[name.toLowerCase()] = sources.sort();
  }
  return set;
}

export async function environmentProbes(): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  results.push(await probe('environment', async () => ({
    status: 'info', summary: `${location.origin} secure=${isSecureContext}`,
    details: { userAgent: navigator.userAgent, origin: location.origin, href: location.href, isSecureContext, devicePixelRatio, languages: [...navigator.languages], visibilityState: document.visibilityState },
  })));
  results.push(await probe('csp-effective', async () => {
    const response = await fetch(location.href, { cache: 'no-store' });
    const header = response.headers.get('content-security-policy');
    const meta = document.querySelector('meta[http-equiv="Content-Security-Policy" i]')?.getAttribute('content') ?? null;
    if (!header) return { status: 'fail', summary: 'no CSP header on the bundled index.html', details: { meta } };
    const set = directiveSet(header);
    const hashes = (set['script-src'] ?? []).filter(source => source.startsWith("'sha256-")).length;
    const unsafe = header.includes("'unsafe-inline'") || header.includes("'unsafe-eval'");
    return { status: !unsafe && set['default-src']?.[0] === "'none'" ? 'pass' : 'fail', summary: `${Object.keys(set).length} directives, ${hashes} script hashes`, details: { header, directives: set, scriptHashes: hashes, meta } };
  }));
  results.push(await probe('web-crypto-main', async () => {
    const digest = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('abc')));
    const uuid = crypto.randomUUID();
    const random = crypto.getRandomValues(new Uint8Array(16));
    const ok = digest === SHA256_ABC && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid) && random.some(byte => byte !== 0);
    return { status: ok ? 'pass' : 'fail', summary: 'SHA-256 known answer, v4 UUID, getRandomValues', details: { digest } };
  }));
  results.push(await probe('module-worker', async () => {
    const worker = new Worker(new URL('./probe-worker.ts', import.meta.url), { type: 'module' });
    try {
      const reply = await new Promise<ProbeWorkerReply>((resolve, reject) => {
        worker.addEventListener('message', event => resolve(event.data as ProbeWorkerReply));
        worker.addEventListener('error', event => reject(new Error(`worker error: ${event.message || 'load failed'}`)));
        worker.postMessage({ indexUrl: new URL('index.html', location.href).href });
      });
      const sameOrigin = new URL(reply.location).origin === location.origin;
      const ok = sameOrigin && reply.secureContext && reply.lazy.ok && reply.digest.ok && reply.uuid.ok && reply.fetch.ok;
      return {
        status: ok ? 'pass' : 'fail', summary: `module worker at ${reply.location}; nested import ${reply.lazy.ok}; crypto ${reply.digest.ok}; fetch ${reply.fetch.ok}`,
        details: { location: reply.location, importMetaUrl: reply.importMetaUrl, lazyUrl: reply.lazy.url, secureContext: reply.secureContext, digest: reply.digest.ok, uuid: reply.uuid.ok, fetch: reply.fetch.ok, workerEval: reply.evalBlocked },
      };
    } finally { worker.terminate(); }
  }));
  return results;
}

/** Deliberate negative probes; their CSP violations are the only intended ones and are counted separately. */
export async function negativeProbes(workerEvalBlocked: boolean): Promise<{ results: ProbeResult[]; violations: Violation[] }> {
  const before = audit().violations.length;
  const results: ProbeResult[] = [];
  results.push(await probe('eval-negative', async () => {
    try {
      const fn = new Function('return 1') as () => number;
      return { status: 'unexpected-allow', summary: `new Function executed (${fn()})`, details: {} };
    } catch (error) { return { status: 'expected-block', summary: text(error), details: {} }; }
  }));
  results.push({ id: 'worker-eval-negative', ms: 0, status: workerEvalBlocked ? 'expected-block' : 'unexpected-allow', summary: workerEvalBlocked ? 'the host worker CSP blocked new Function in the module worker' : 'new Function ran in the module worker', details: {} });
  results.push(await probe('inline-style-attr-negative', async () => {
    const probeElement = document.createElement('div');
    probeElement.setAttribute('style', 'color: rgb(1, 2, 3)');
    document.body.append(probeElement);
    await delay(30);
    const applied = getComputedStyle(probeElement).color === 'rgb(1, 2, 3)';
    probeElement.remove();
    return { status: applied ? 'unexpected-allow' : 'expected-block', summary: applied ? 'parsed style attribute applied' : 'parsed style attribute blocked (style-src)', details: {} };
  }));
  results.push(await probe('data-image-negative', async () => {
    const image = new Image();
    const loaded = await new Promise<boolean>(resolve => { image.onload = () => resolve(true); image.onerror = () => resolve(false); image.src = TINY_PNG; setTimeout(() => resolve(false), 3000); });
    return { status: loaded ? 'unexpected-allow' : 'expected-block', summary: loaded ? 'data: image loaded' : 'data: image blocked (img-src)', details: {} };
  }));
  results.push(await probe('blob-worker-negative', async () => {
    const url = URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'text/javascript' }));
    try {
      const outcome = await new Promise<string>(resolve => {
        let worker: Worker;
        try { worker = new Worker(url); } catch (error) { resolve(`constructor threw: ${text(error)}`); return; }
        worker.onmessage = () => { worker.terminate(); resolve('ran'); };
        worker.onerror = () => { worker.terminate(); resolve('error event'); };
        setTimeout(() => { worker.terminate(); resolve('no reply'); }, 3000);
      });
      return { status: outcome === 'ran' ? 'unexpected-allow' : 'expected-block', summary: `blob: worker ${outcome}`, details: {} };
    } finally { URL.revokeObjectURL(url); }
  }));
  results.push(await probe('remote-connect-negative', async () => {
    try {
      await fetch(NEGATIVE_REMOTE_URL, { cache: 'no-store' });
      return { status: 'unexpected-allow', summary: 'remote fetch resolved', details: {} };
    } catch (error) { return { status: 'expected-block', summary: `remote fetch refused: ${text(error)}`, details: { url: NEGATIVE_REMOTE_URL } }; }
  }));
  await delay(200);
  return { results, violations: audit().violations.slice(before) };
}

/**
 * Expects a rejection with `expected` (`CODE` or `CODE/REASON`: a HostPort refusal reports its convention code with the
 * specific host code as `reason`). With `refusal`, the rejection must also satisfy the packed library's `isHostRefusal`.
 */
const expectCode = async (label: string, run: () => Promise<unknown>, expected: string, secret?: string, refusal?: boolean): Promise<ProbeResult> => probe(label, async () => {
  try {
    await run();
    return { status: 'unexpected-allow', summary: `${label}: accepted`, details: {} };
  } catch (error) {
    const failure = toNativeError(error);
    const leaks = secret ? JSON.stringify({ message: failure.message, reason: failure.reason }).includes(secret) : false;
    const [code, reason = null] = expected.split('/');
    const recognized = refusal === undefined ? null : isHostRefusal(error) === refusal;
    const ok = failure.code === code && failure.reason === reason && !leaks && recognized !== false;
    return {
      status: ok ? 'expected-block' : 'fail', summary: `${failure.code}${failure.reason ? `/${failure.reason}` : ''}: ${failure.message}`.slice(0, 300),
      details: { code: failure.code, reason: failure.reason, expected, echoesInput: leaks, ...(refusal === undefined ? {} : { isHostRefusal: isHostRefusal(error) }) },
    };
  }
});

/** The native command boundary as seen from the webview. */
export async function ipcProbes(): Promise<ProbeResult[]> {
  const secret = 'hidden-solution-text-42';
  const results: ProbeResult[] = [];
  const port = new NativeHostPort();
  // get_policy is a HostPort command: every refusal is reported under the HostPort refusal convention.
  results.push(await expectCode('ipc-json-object-body-refused', () => callJsonObject('get_policy', { activityId: 'act-x' }), 'INVALID_INPUT/INVALID_INPUT'));
  results.push(await expectCode('ipc-oversized-body-refused', () => callBytes('get_policy', new Uint8Array(600 * 1024).fill(0x20)), 'INVALID_INPUT/RESOURCE_LIMIT'));
  results.push(await expectCode('ipc-malformed-json-refused', () => callBytes('get_policy', new TextEncoder().encode('{"activityId":')), 'INVALID_INPUT/INVALID_INPUT'));
  results.push(await expectCode('ipc-schema-error-is-stable', () => call('get_policy', { activityId: secret, extraField: secret }), 'INVALID_INPUT/SCHEMA', secret));
  results.push(await expectCode('ipc-unknown-activity', () => call('get_policy', { activityId: 'act-unknown' }), 'INVALID_INPUT/NOT_FOUND'));
  // The adapter's HostPort rejects a host decision with a value the library recognizes as a refusal (not retried).
  results.push(await expectCode('ipc-host-port-refusal-recognized', () => port.getJournalCursor({ activityId: 'act-unknown' }), 'INVALID_INPUT/NOT_FOUND', undefined, true));
  results.push(await expectCode('ipc-host-port-schema-refusal-recognized', () => port.appendEvents({ activityId: 'act-unknown', events: [] }), 'INVALID_INPUT/SCHEMA', undefined, true));
  // Host-owned commands report the specific code.
  results.push(await expectCode('ipc-unapproved-template', () => call('open_activity', { templateId: 'quadratic-gradient-descent', version: '9.9.9' }), 'POLICY_DENIED'));
  results.push(await expectCode('ipc-path-like-input-refused', () => call('import_backup', { backupSha256: '../../../../etc/passwd' }), 'SCHEMA'));
  results.push(await expectCode('ipc-unknown-response-snapshot', () => call('get_response_snapshot', { activityId: 'act-unknown', responseId: 'resp-unknown' }), 'NOT_FOUND'));
  results.push(await expectCode('acl-ungranted-command-rejected', () => call('conformance_ungranted', {}), 'IPC_DENIED'));
  results.push(await expectCode('acl-plugin-command-rejected', () => callJsonObject('plugin:app|version', {}), 'IPC_DENIED'));
  results.push(await expectCode('acl-path-plugin-rejected', () => callJsonObject('plugin:path|resolve_directory', { directory: 14 }), 'IPC_DENIED'));
  return results;
}

/**
 * KaTeX output and fonts inside the learner card's shadow root (rendered by the packed player's lazy math chunk).
 *
 * The card loads KaTeX, its stylesheet and fonts only once an equation is on screen (report §18: no eager math assets),
 * A prior stage can put an equation on screen before later content moves it below the fold. The conformance-only
 * observer audit starts before the first app mount and records actual viewport eligibility per observation. The probe
 * records that history and any exposed resource timing, scrolls the current panel into view,
 * and then requires real KaTeX DOM output for every equation (MathML, a strut and a formula box with non-zero layout)
 * and a loaded KaTeX_Main face. `document.fonts.check` alone is not evidence: it is also true when no face is registered.
 */
export async function mathProbe(surface: StudyHarnessSurface, timeoutMs = 20_000): Promise<ProbeResult> {
  return probe('katex-in-card', async () => {
    const root = surface.element.shadowRoot;
    if (!root) return { status: 'fail', summary: 'no shadow root', details: {} };
    const panel = root.querySelector<HTMLElement>('[data-ema-panel="equations"]');
    if (!panel) return { status: 'fail', summary: 'the card shows no equations panel', details: {} };
    const equations = panel.querySelectorAll('.ema-equation').length;
    const katexFaces = (status?: FontFaceLoadStatus) => [...document.fonts].filter(face => /^["']?KaTeX_/.test(face.family) && (!status || face.status === status));
    const mainLoaded = () => katexFaces('loaded').some(face => /KaTeX_Main/.test(face.family));
    const typeset = (node: Element) => [...node.querySelectorAll('.katex')].filter(math => !math.closest('[hidden]'));
    const rendered = () => typeset(panel).length;
    const placement = () => {
      const rect = panel.getBoundingClientRect();
      return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), viewportHeight: innerHeight, inViewport: rect.bottom > 0 && rect.top < innerHeight };
    };
    const history = [...panel.querySelectorAll('.ema-equation')].map(node => ({
      equationId: node.getAttribute('data-ema-equation'), ...equationVisibility(node), rendered: typeset(node).length > 0,
    }));
    const visibility = mathVisibilityState();
    const resources = mathResources(performance.getEntriesByType('resource'));
    const lazy = lazyMathEvidence({ auditInstalled: visibility.installed, firstVisibleAt: visibility.firstVisibleAt,
      equations: history, resources, registeredFaces: katexFaces().length });
    const before = { ...placement(), katexNodes: rendered(), katexFaces: katexFaces().length,
      visibilityAudit: visibility, equationHistory: history, mathResources: resources, lazyEvidence: lazy };
    // What a learner does to read the equations; the card's IntersectionObserver then loads the math chunk.
    panel.scrollIntoView({ block: 'center', inline: 'nearest' });
    const after = placement();
    const started = performance.now();
    const budget = Math.max(2_000, timeoutMs - 3_000);
    while (performance.now() - started < budget && (rendered() < equations || !mainLoaded())) {
      await delay(100);
      if (rendered() >= equations) await document.fonts.ready;
    }
    const renderMs = Math.round(performance.now() - started);
    // The installed KaTeX (0.19) names the strut `katex-strut` (`.strut` is kept for other versions); its height comes
    // from a CSSOM style.
    const strutHeight = panel.querySelector<HTMLElement>('.katex-html .katex-strut, .katex-html .strut')?.getBoundingClientRect().height ?? 0;
    const box = panel.querySelector<HTMLElement>('.katex-html')?.getBoundingClientRect() ?? null;
    const mathml = panel.querySelectorAll('.katex-mathml math').length;
    const loadedKatex = [...new Set(katexFaces('loaded').map(face => `${face.family.replace(/["']/g, '')} ${face.style} ${face.weight}`))];
    const ok = equations > 0 && rendered() === equations && mathml >= equations && strutHeight > 0 && !!box && box.width > 0 && box.height > 0
      && mainLoaded() && after.inViewport && lazy.ok;
    return {
      status: ok ? 'pass' : 'fail',
      summary: `${rendered()}/${equations} equations rendered by KaTeX after scrolling the panel into view (before: top ${before.top} px in a ${before.viewportHeight} px viewport, ${before.katexNodes} KaTeX nodes); MathML ${mathml}, strut ${strutHeight.toFixed(1)} px, box ${box ? `${box.width.toFixed(0)}x${box.height.toFixed(0)}` : 'none'} px, ${loadedKatex.length} KaTeX faces loaded`,
      details: {
        equations, katexNodes: rendered(), mathml, strutHeight, formulaBox: box ? { width: box.width, height: box.height } : null, renderMs,
        beforeScroll: before, afterScroll: after, loadedWhileOffscreen: !lazy.ok, loadedKatexFaces: loadedKatex,
        fonts: { katexMainLoaded: mainLoaded(), inter: document.fonts.check('16px "Inter Variable"') },
      },
    };
  }, timeoutMs);
}

/** SVG and PNG capture of the card (pure SVG, no foreignObject; PNG rasterized from it) sent as raw binary IPC. */
export async function captureProbes(surface: StudyHarnessSurface, prefix: string, timeoutMs = 30_000): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  results.push(await probe(`${prefix}-capture-svg`, async () => {
    const capture = await surface.capture({ format: 'svg' });
    if (capture.mimeType !== 'image/svg+xml') return { status: 'fail', summary: 'not SVG', details: {} };
    const bytes = new TextEncoder().encode(capture.svg);
    const stored = await callBytes<{ sha256: string; bytes: number; file: string }>('conformance_capture', bytes, { 'x-sh-capture': `${prefix}-svg` });
    const remote = (capture.svg.match(/https?:\/\/[^"'\s)]+/g) ?? []).filter(url => !url.startsWith('http://www.w3.org/'));
    const ok = capture.svg.startsWith('<svg') && !capture.svg.includes('<foreignObject') && remote.length === 0;
    return { status: ok ? 'pass' : 'fail', summary: `${capture.width}x${capture.height} SVG, ${bytes.length} bytes, fonts ${capture.fonts}`, details: { ...stored, width: capture.width, height: capture.height, fonts: capture.fonts, viewId: capture.metadata.viewId, frameId: capture.metadata.frameId, foreignObject: capture.svg.includes('<foreignObject'), remoteReferences: remote } };
  }, timeoutMs));
  results.push(await probe(`${prefix}-capture-png`, async () => {
    const capture = await surface.capture({ format: 'png', scale: 1 });
    if (capture.mimeType !== 'image/png') return { status: 'fail', summary: 'not PNG', details: {} };
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => capture.bytes[index] === byte);
    const stored = await callBytes<{ sha256: string; bytes: number; file: string }>('conformance_capture', capture.bytes, { 'x-sh-capture': `${prefix}-png` });
    return { status: signature && capture.bytes.length > 1000 ? 'pass' : 'fail', summary: `${capture.width}x${capture.height} PNG, ${capture.bytes.length} bytes (raw binary IPC)`, details: { ...stored, width: capture.width, height: capture.height, fonts: capture.fonts, viewId: capture.metadata.viewId, frameId: capture.metadata.frameId, companionText: capture.companionText.slice(0, 400) } };
  }, timeoutMs));
  return results;
}

export async function webglProbe(): Promise<ProbeResult> {
  return probe('webgl-optional', async () => {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) return { status: 'info', summary: 'WebGL2 unavailable (optional; 2D alternatives are required anyway)', details: {} };
    const renderer = gl.getParameter(gl.RENDERER) as string;
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    gl.clearColor(0.2, 0.4, 0.6, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const pixel = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return { status: 'info', summary: `WebGL2 available (${renderer}), clear/readPixels ${pixel[2] > 140 ? 'ok' : 'unexpected'}`, details: { renderer, maxTextureSize: max, pixel: [...pixel] } };
  });
}

/** Origins of loaded resources and of every fetch the page issued (Resource Timing is empty for custom schemes). */
export function originsProbe(): ProbeResult {
  const origins = new Set<string>();
  for (const element of document.querySelectorAll<HTMLScriptElement | HTMLLinkElement>('script[src], link[href]')) {
    const url = element instanceof HTMLScriptElement ? element.src : element.href;
    origins.add(new URL(url, location.href).origin);
  }
  const requests = audit().requests;
  for (const request of requests) origins.add(request.origin);
  const timing = performance.getEntriesByType('resource').length;
  // ipc://localhost is Tauri's custom-protocol IPC endpoint (connect-src ipc:), not a network origin.
  const remote = [...origins].filter(origin => origin !== location.origin && origin !== 'null' && origin !== 'ipc://localhost');
  const intended = remote.filter(origin => origin === new URL(NEGATIVE_REMOTE_URL).origin);
  return {
    id: 'resource-origins', ms: 0, status: remote.length === intended.length ? 'pass' : 'fail',
    summary: `origins: ${[...origins].join(', ')}; ${requests.length} fetches logged; Resource Timing entries ${timing}`,
    details: { origins: [...origins], requests: requests.length, resourceTimingEntries: timing, intendedNegativeOrigins: intended },
  };
}

export { NativeHostError };
