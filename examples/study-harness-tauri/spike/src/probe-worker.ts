// ES module Web Worker loaded from bundled assets through
// `new Worker(new URL('./probe-worker.ts', import.meta.url), { type: 'module' })`.
import type { WorkerCheck, WorkerProbeReply, WorkerProbeRequest, WorkerErrorReply } from './worker-protocol';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const SHA256_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function message(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 300);
  return String(error).slice(0, 300);
}

async function check<T extends object>(fallback: T, run: () => Promise<WorkerCheck & T>): Promise<WorkerCheck & T> {
  try {
    return await run();
  } catch (error) {
    return { ok: false, detail: message(error), ...fallback };
  }
}

async function probe(request: WorkerProbeRequest): Promise<WorkerProbeReply> {
  const lazyImport = await check({ moduleUrl: '', value: Number.NaN }, async () => {
    const lazy = await import('./worker-lazy');
    const value = lazy.quadratic(1, -3, 2, 4);
    return { ok: value === 6, detail: 'dynamic import() of a split chunk from the worker', moduleUrl: lazy.lazyModuleUrl, value };
  });

  const digest = await check({ hex: '' }, async () => {
    const result = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('abc')));
    return { ok: result === SHA256_ABC, detail: 'crypto.subtle.digest SHA-256("abc")', hex: result };
  });

  const randomUUID = await check({ sample: '' }, async () => {
    const sample = crypto.randomUUID();
    return { ok: UUID_V4.test(sample), detail: 'crypto.randomUUID() format', sample };
  });

  // Tauri attaches its CSP header only to HTML responses; a dedicated worker gets its policy
  // from its own script response. This records whether dynamic code is blocked in the worker.
  const evalBlocked = await check({ blocked: false }, async () => {
    try {
      const made = new Function('return 6 * 7') as () => number;
      return { ok: true, detail: `new Function executed in worker (result ${made()}); worker has no script-src restriction`, blocked: false };
    } catch (error) {
      return { ok: true, detail: `new Function rejected in worker: ${message(error)}`, blocked: true };
    }
  });

  const dataFetch = await check({ samples: 0 }, async () => {
    const response = await fetch(request.dataUrl, { cache: 'no-store' });
    const body = (await response.json()) as { samples?: unknown };
    const samples = Array.isArray(body.samples) ? body.samples.length : 0;
    return { ok: response.ok && samples === 5, detail: `fetch ${response.status} ${response.headers.get('content-type') ?? ''}`, samples };
  });

  const offscreen2d = await check({ pngBytes: 0 }, async () => {
    if (typeof OffscreenCanvas === 'undefined') return { ok: false, detail: 'OffscreenCanvas undefined in worker', pngBytes: 0 };
    const canvas = new OffscreenCanvas(64, 32);
    const context = canvas.getContext('2d');
    if (!context) return { ok: false, detail: 'OffscreenCanvas 2d context unavailable', pngBytes: 0 };
    context.fillStyle = '#0f7a4a';
    context.fillRect(0, 0, 64, 32);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
    const png = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
    return { ok: png && blob.size > 0, detail: `convertToBlob ${blob.type}`, pngBytes: blob.size };
  });

  const offscreenWebgl2 = await check({ available: false }, async () => {
    if (typeof OffscreenCanvas === 'undefined') return { ok: true, detail: 'OffscreenCanvas undefined', available: false };
    const gl = new OffscreenCanvas(8, 8).getContext('webgl2');
    return { ok: true, detail: gl ? 'webgl2 context created on OffscreenCanvas in worker' : 'webgl2 unavailable on OffscreenCanvas', available: gl !== null };
  });

  return {
    kind: 'probe-result',
    requestId: request.requestId,
    workerLocation: scope.location.href,
    importMetaUrl: import.meta.url,
    isSecureContext: scope.isSecureContext,
    lazyImport,
    digest,
    randomUUID,
    evalBlocked,
    dataFetch,
    offscreen2d,
    offscreenWebgl2,
  };
}

scope.addEventListener('message', (event: MessageEvent<unknown>) => {
  const data = event.data as Partial<WorkerProbeRequest> | null;
  if (!data || data.kind !== 'probe' || typeof data.requestId !== 'string' || typeof data.dataUrl !== 'string') {
    const reply: WorkerErrorReply = { kind: 'probe-error', requestId: String(data?.requestId ?? ''), message: 'malformed request' };
    scope.postMessage(reply);
    return;
  }
  const request = data as WorkerProbeRequest;
  probe(request).then(
    (reply) => scope.postMessage(reply),
    (error: unknown) => {
      const reply: WorkerErrorReply = { kind: 'probe-error', requestId: request.requestId, message: message(error) };
      scope.postMessage(reply);
    },
  );
});
