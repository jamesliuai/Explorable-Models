/** Local, scripted transport demonstration. No real LLM or production auth is implied. */
import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createSessionRelay } from '../../packages/agent/dist/index.js';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const directory = await mkdtemp(join(tmpdir(), 'explorable-models-relay-'));
await build({ absWorkingDir: root, entryPoints: { browser: 'examples/host-relay/browser.ts', 'document-worker': 'packages/core/src/declarative/document-worker.ts' }, outdir: directory, bundle: true, format: 'esm', target: 'es2022', platform: 'browser', minify: false, define: { 'process.env.NODE_ENV': '"production"' }, alias: { '@explorable-models/core/declarative': resolve(root, 'packages/core/src/declarative/index.ts'), '@explorable-models/agent': resolve(root, 'packages/agent/src/index.ts'), '@explorable-models/player': resolve(root, 'packages/player/src/public.ts') } });
const token = randomBytes(24).toString('hex');
const principal = 'local-demo-user';
const sessions = new Map();
const relay = createSessionRelay({ authorize: (who, sessionId) => who === principal && sessions.has(sessionId) });
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Explorable Models · scoped relay demo</title><style>body{font:16px system-ui;color:#173439;background:#f5f7f4;margin:0;padding:24px}main{max-width:1150px;margin:auto}button{padding:12px 18px;border:1px solid #247c8e;border-radius:8px;background:#fff;cursor:pointer}pre{max-height:400px;overflow:auto;background:white;padding:16px;font-size:12px}#surface{margin:24px 0}</style><main><h1>A server can author the browser session</h1><p>This local demo uses a deterministic scripted caller. It does not connect an LLM or claim an external integration trial.</p><button id="run" disabled>Run scripted tool workflow</button><p id="status" role="status">Connecting…</p><div id="surface"></div><details><summary>Protocol results and saved revisions</summary><pre id="result"></pre></details></main><script type="module" src="/browser.js"></script></html>`;
function json(response, status, data) { if (!response.writableEnded) { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(data)); } }
async function readJson(request) { let size = 0; const chunks = []; for await (const chunk of request) { size += chunk.length; if (size > 4_000_000) throw new Error('Input too large.'); chunks.push(chunk); } return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
function authenticate(request) { const provided = Buffer.from((request.headers.authorization ?? '').replace(/^Bearer /, '')); const expected = Buffer.from(token); return provided.length === expected.length && timingSafeEqual(provided, expected); }
function route(id) { const value = sessions.get(id); if (!value) throw new Error('Session is not registered to this authenticated user.'); return value; }
function send(session, message) { session.queue.push(message); if (session.queue.length > 32) throw new Error('Transport queue exceeded.'); if (session.poll) { const poll = session.poll; session.poll = null; clearTimeout(poll.timeout); json(poll.response, 200, session.queue.splice(0)); } }
async function scripted(sessionId) {
  const transcript = [];
  const call = async (name, input) => { const result = await relay.dispatch({ principal, sessionId, requestId: randomUUID(), name, input }); transcript.push({ name, ok: result.ok }); if (!result.ok) throw new Error(JSON.stringify(result.diagnostics)); return result.data; };
  const guard = async () => { const inspection = await call('visualization_inspect', {}); return { ...inspection.guard, operationId: randomUUID(), origin: 'agent' }; };
  const discovery = await call('visualization_discover', { includeExample: true });
  const created = await call('visualization_create', { document: discovery.example, guard: await guard() });
  await call('visualization_commit', { candidateId: created.candidateId, guard: await guard() });
  const revised = await call('visualization_revise', { guard: await guard(), edits: [
    { op: 'set', collection: 'series', id: 'second', value: { ...discovery.example.series.wave, label: 'Double frequency', y: 'amplitude*sin(2*frequency*x)' } },
    { op: 'setMark', viewId: 'plot', mark: { id: 'second-line', type: 'line', label: 'Double frequency', series: 'second', style: { stroke: '#c36c39', dash: 'dashed' } } },
    { op: 'setMark', viewId: 'plot', mark: { id: 'origin-note', type: 'label', label: 'Origin note', text: 'Zero', bindings: { position: 'origin' }, offset: [12, -18] } },
  ] });
  await call('visualization_commit', { candidateId: revised.candidateId, guard: await guard() });
  await call('visualization_operate', { action: 'parameters', parameters: { amplitude: 2 }, guard: await guard() });
  const artifact = await call('visualization_save', {}); // Host-owned persistence seam: this demo keeps the artifact in memory only.
  await call('visualization_restore', { artifact, guard: await guard() });
  return { evidence: 'scripted HTTP server/browser round trip; no LLM connected', sessionId, transcript, artifactRevision: artifact.identity.documentRevision, comparisonRuns: artifact.comparisons.length, final: await call('visualization_inspect', {}) };
}
const server = createServer(async (request, response) => {
  const address = server.address(); const origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 8788}`;
  const url = new URL(request.url, origin);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; worker-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  try {
    if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin)) { json(response, 403, { error: 'Origin rejected.' }); return; }
    if (request.method === 'GET' && url.pathname === '/') { response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }); response.end(html); return; }
    if (request.method === 'GET' && ['/browser.js', '/document-worker.js'].includes(url.pathname)) { response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }); response.end(await readFile(join(directory, url.pathname.slice(1)))); return; }
    if (!authenticate(request)) { json(response, 401, { error: 'Authentication required. Open the exact local URL printed by the server.' }); return; }
    if (request.method === 'GET' && url.pathname === '/api/events') {
      const session = route(url.searchParams.get('sessionId')); if (session.queue.length) { json(response, 200, session.queue.splice(0)); return; }
      if (session.poll) throw new Error('Another poll is already active for this tab.');
      const timeout = setTimeout(() => { session.poll = null; json(response, 200, []); }, 20_000); session.poll = { response, timeout };
      response.on('close', () => { if (session.poll?.response === response) { clearTimeout(timeout); session.poll = null; } }); return;
    }
    if (request.method !== 'POST') { json(response, 404, { error: 'Unknown route.' }); return; }
    const body = await readJson(request);
    if (url.pathname === '/api/connect') {
      if (typeof body.sessionId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.sessionId)) throw new Error('Invalid session identity.');
      if (sessions.size >= 8 && !sessions.has(body.sessionId)) throw new Error('Local demo tab limit reached.');
      const old = sessions.get(body.sessionId); old?.connection.disconnect();
      const session = { queue: [], poll: null, connection: null, expiresAt: Date.now() + 15 * 60_000 }; sessions.set(body.sessionId, session);
      session.connection = await relay.connect({ principal, sessionId: body.sessionId, expiresAt: session.expiresAt, send: message => send(session, message) }); json(response, 200, { sessionId: body.sessionId, expiresAt: session.expiresAt }); return;
    }
    const session = route(body.sessionId);
    if (url.pathname === '/api/response') { session.connection.receive(body); json(response, 200, { received: true }); }
    else if (url.pathname === '/api/disconnect') { session.connection.disconnect(); if (session.poll) { clearTimeout(session.poll.timeout); json(session.poll.response, 200, []); } sessions.delete(body.sessionId); json(response, 200, { disconnected: true }); }
    else if (url.pathname === '/api/scripted') json(response, 200, await scripted(body.sessionId));
    else json(response, 404, { error: 'Unknown route.' });
  } catch (error) { json(response, 400, { error: error instanceof Error ? error.message : String(error) }); }
});
const port = Number(process.env.EXPLORABLE_MODELS_RELAY_PORT ?? 8788);
server.listen(port, '127.0.0.1', () => { const address = server.address(); console.log(`Scripted relay demo (loopback only): http://127.0.0.1:${address.port}/#${token}`); });
const shutdown = async () => { relay.dispose(); for (const session of sessions.values()) if (session.poll) { clearTimeout(session.poll.timeout); json(session.poll.response, 503, { error: 'Server shutting down.' }); } server.closeAllConnections(); server.close(); await rm(directory, { recursive: true, force: true }); };
process.once('SIGINT', () => { void shutdown(); }); process.once('SIGTERM', () => { void shutdown(); });
