import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright';
import { TOOLKIT_ROOT } from './compiler.js';
import { serveStatic, type StaticServer } from './server.js';
import { CliError } from './files.js';
import type { VisualizationToolResult, ToolDescriptor } from '../../agent/src/tools.js';
import type {} from './document-harness.js';

/** Blank declarative session, with no authored source project or privileged Node evaluation. */
export class DocumentBrowserSession {
  private disposed = false;
  private constructor(private directory: string, private browser: Browser, private page: Page, private server: StaticServer, public readonly descriptors: readonly ToolDescriptor[]) {}
  static async create(): Promise<DocumentBrowserSession> {
    const directory = await mkdtemp(path.join(tmpdir(), 'explorable-models-document-'));
    let server: StaticServer | undefined, browser: Browser | undefined;
    try {
      // Only fixed toolkit entries are compiled. Documents arrive later as JSON via the tool protocol.
      await build({ absWorkingDir: TOOLKIT_ROOT, entryPoints: { harness: 'packages/cli/src/document-harness.ts', 'document-worker': 'packages/core/src/declarative/document-worker.ts' }, outdir: directory, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent', alias: { '@explorable-models/core/declarative': path.join(TOOLKIT_ROOT, 'packages/core/src/declarative/index.ts') } });
      await writeFile(path.join(directory, 'index.html'), '<!doctype html><html lang="en"><meta charset="utf-8"><title>Explorable Models declarative tool worker</title><script type="module" src="/harness.js"></script></html>');
      server = await serveStatic(directory);
      try { browser = await chromium.launch({ headless: true }); }
      catch (error) { throw new CliError('BROWSER_UNAVAILABLE', `Chromium could not start: ${error instanceof Error ? error.message : String(error)}`, 'Run npx playwright install chromium, then retry.'); }
      const context = await browser.newContext();
      await context.route('**/*', route => new URL(route.request().url()).origin === server!.url ? route.continue() : route.abort('blockedbyclient'));
      const page = await context.newPage(); await page.goto(server.url, { waitUntil: 'load' });
      await page.waitForFunction(() => Boolean(window.__documentHarness?.ready || window.__documentHarness?.error), undefined, { timeout: 10000 });
      const error = await page.evaluate(() => window.__documentHarness?.error); if (error) throw new CliError('BROWSER_ERROR', error);
      const descriptors = await page.evaluate(() => window.__documentHarness!.descriptors);
      return new DocumentBrowserSession(directory, browser, page, server, descriptors);
    } catch (error) { await browser?.close(); await server?.close(); await rm(directory, { recursive: true, force: true }); throw error; }
  }
  async execute(name: string, input: unknown, options: { signal?: AbortSignal } = {}): Promise<VisualizationToolResult> {
    if (this.disposed) return { ok: false, diagnostics: [{ code: 'DISPOSED', path: '$', message: 'Document browser session is closed.' }] };
    if (options.signal?.aborted) return { ok: false, diagnostics: [{ code: 'CANCELLED', path: '$', message: 'Request cancelled before execution.' }] };
    const requestId = randomUUID();
    const abort = () => { void this.page.evaluate(id => window.__documentHarness?.cancel(id), requestId).catch(() => {}); };
    options.signal?.addEventListener('abort', abort, { once: true });
    try { return await this.page.evaluate(({ name, input, requestId }) => window.__documentHarness!.execute(name, input, requestId), { name, input, requestId }); }
    finally { options.signal?.removeEventListener('abort', abort); }
  }
  async close(): Promise<void> {
    if (this.disposed) return; this.disposed = true;
    try { await this.page.evaluate(() => window.__documentHarness?.dispose()); }
    finally { await this.browser.close(); await this.server.close(); await rm(this.directory, { recursive: true, force: true }); }
  }
}
