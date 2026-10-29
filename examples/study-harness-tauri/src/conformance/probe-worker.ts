// CONFORMANCE BUILD ONLY. A module worker loaded with `new Worker(new URL('./probe-worker.ts', import.meta.url),
// { type: 'module' })` (native.md N1). It checks, inside the packaged WebView's worker context: relative module
// resolution with a nested import(), Web Crypto, a same-origin fetch, and that the worker CSP added by the host
// (native.md N2) blocks dynamic code construction.
export interface ProbeWorkerReply {
  kind: 'probe-worker';
  location: string;
  importMetaUrl: string;
  secureContext: boolean;
  lazy: { ok: boolean; value: number; url: string; detail: string };
  digest: { ok: boolean; hex: string };
  uuid: { ok: boolean };
  evalBlocked: { blocked: boolean; detail: string };
  fetch: { ok: boolean; status: number; detail: string };
}

const SHA256_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const hex = (buffer: ArrayBuffer): string => Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('');

self.addEventListener('message', (event: MessageEvent<{ indexUrl: string }>) => {
  void (async () => {
    const reply: ProbeWorkerReply = {
      kind: 'probe-worker', location: String(self.location.href), importMetaUrl: import.meta.url, secureContext: self.isSecureContext,
      lazy: { ok: false, value: 0, url: '', detail: '' }, digest: { ok: false, hex: '' }, uuid: { ok: false }, evalBlocked: { blocked: false, detail: '' },
      fetch: { ok: false, status: 0, detail: '' },
    };
    try {
      const lazy = await import('./probe-lazy');
      reply.lazy = { ok: lazy.square(7) === 49, value: lazy.square(7), url: lazy.lazyUrl, detail: 'nested import() resolved from the worker URL' };
    } catch (error) { reply.lazy.detail = String(error).slice(0, 200); }
    try {
      const digest = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('abc')));
      reply.digest = { ok: digest === SHA256_ABC, hex: digest };
      reply.uuid = { ok: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(crypto.randomUUID()) };
    } catch { /* reported as not ok */ }
    try {
      const fn = new Function('return 1') as () => number;
      reply.evalBlocked = { blocked: false, detail: `new Function executed (${fn()})` };
    } catch (error) { reply.evalBlocked = { blocked: true, detail: String(error).slice(0, 200) }; }
    try {
      const response = await fetch(event.data.indexUrl);
      reply.fetch = { ok: response.ok, status: response.status, detail: (await response.text()).length > 0 ? 'read the bundled index.html' : 'empty' };
    } catch (error) { reply.fetch.detail = String(error).slice(0, 200); }
    self.postMessage(reply);
  })();
});
