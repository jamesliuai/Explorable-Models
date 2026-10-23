import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { CliError } from './files.js';

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.md': 'text/plain; charset=utf-8', '.ts': 'text/plain; charset=utf-8' };
export const CONTENT_SECURITY_POLICY = "default-src 'self'; script-src 'self'; worker-src 'self' blob:; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'self'";
export interface StaticServer { server: Server; url: string; token: string; close(): Promise<void> }
export type APIHandler = (request: unknown) => Promise<unknown>;
export async function serveStatic(directory: string, options: { port?: number; api?: APIHandler } = {}): Promise<StaticServer> {
  const root = await realpath(directory);
  const token = randomBytes(32).toString('hex');
  let origin = '';
  const server = createServer((req, res) => { void handle(req, res).catch(error => { if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'SERVER_ERROR', message: error instanceof Error ? error.message : 'Unknown server error' } })); }); });
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const host = req.headers.host;
    if (origin && host !== new URL(origin).host) { res.writeHead(403); res.end('Invalid host'); return; }
    res.setHeader('Content-Security-Policy', /(?:model-worker|worker-).*\.(?:m?js)(?:\?|$)/.test(req.url ?? '') ? CONTENT_SECURITY_POLICY.replace("connect-src 'self'", "connect-src 'none'") : CONTENT_SECURITY_POLICY);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/__experiment/api' && options.api) {
      if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); res.end(); return; }
      const provided = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
      if (provided.length !== token.length || !timingSafeEqual(Buffer.from(provided), Buffer.from(token)) || (req.headers.origin !== undefined && req.headers.origin !== origin)) { res.writeHead(403); res.end('Invalid session credentials or origin'); return; }
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of req) { size += Buffer.byteLength(chunk); if (size > 1024 * 1024) { res.writeHead(413); res.end(); req.destroy(); return; } chunks.push(Buffer.from(chunk)); }
      try { const request: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); const result = await options.api(request); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result)); }
      catch (error) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error instanceof CliError ? error.toJSON() : { code: 'INVALID_COMMAND', message: error instanceof Error ? error.message : 'Invalid request' } })); }
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
    let pathname: string;
    try { pathname = decodeURIComponent(url.pathname); } catch { res.writeHead(400); res.end(); return; }
    if (pathname.includes('\0') || pathname.includes('\\')) { res.writeHead(400); res.end(); return; }
    const file = path.resolve(root, `.${pathname.endsWith('/') ? `${pathname}index.html` : pathname}`);
    if (file !== root && !file.startsWith(`${root}${path.sep}`)) { res.writeHead(403); res.end(); return; }
    try {
      const resolvedFile = await realpath(file);
      if (resolvedFile !== root && !resolvedFile.startsWith(`${root}${path.sep}`)) { res.writeHead(403); res.end(); return; }
      const info = await stat(resolvedFile);
      if (!info.isFile()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'content-length': info.size });
      res.end(req.method === 'HEAD' ? undefined : await readFile(resolvedFile));
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { res.writeHead(404); res.end('Not found'); } else throw error; }
  }
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new CliError('SERVER_ERROR', 'Could not bind local preview server.');
  origin = `http://127.0.0.1:${address.port}`;
  return { server, url: origin, token, close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }) };
}
