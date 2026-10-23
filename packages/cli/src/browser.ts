import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { CompiledProject } from './compiler.js';
import { serveStatic, type StaticServer } from './server.js';
import { CliError, writeJSON } from './files.js';
import type { HarnessRequest } from './browser-harness.js';
import type { Snapshot } from '../../core/src/types.js';

export class BrowserSession {
  private constructor(public readonly project: CompiledProject, private readonly browser: Browser, private readonly context: BrowserContext, public readonly page: Page, public readonly server: StaticServer) {}
  static async create(project: CompiledProject): Promise<BrowserSession> {
    const server = await serveStatic(project.directory);
    let browser: Browser | undefined;
    try {
      try { browser = await chromium.launch({ headless: true }); }
      catch (error) { throw new CliError('BROWSER_UNAVAILABLE', `Chromium could not start: ${error instanceof Error ? error.message : String(error)}`, 'Run npx playwright install chromium once, then retry.'); }
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      // Exports must work without external services. Block all nonlocal network, including model worker requests.
      await context.route('**/*', route => new URL(route.request().url()).origin === server.url ? route.continue() : route.abort('blockedbyclient'));
      const page = await context.newPage();
      await page.goto(`${server.url}/harness.html`, { waitUntil: 'load' });
      await page.waitForFunction(() => Boolean(window.__experimentHarness?.ready || window.__experimentHarness?.error), undefined, { timeout: 10000 });
      const error = await page.evaluate(() => window.__experimentHarness?.error);
      if (error) throw new CliError('MODEL_ERROR', JSON.stringify(error));
      return new BrowserSession(project, browser, context, page, server);
    } catch (error) { await browser?.close(); await server.close(); throw error; }
  }
  async request(method: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const input: HarnessRequest = { method, args };
    const result = await this.page.evaluate(request => window.__experimentHarness!.request(request), input);
    return result;
  }
  async checked(method: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const result = await this.request(method, args);
    if (result && typeof result === 'object' && 'error' in result) { const error = (result as { error: { code: string; message: string; recovery?: string } }).error; throw new CliError(error.code, error.message, error.recovery); }
    return result;
  }
  async close(): Promise<void> { await this.context.close(); await this.browser.close(); await this.server.close(); }
  async capture(output: string, options: { snapshot?: Snapshot; width?: number; height?: number } = {}): Promise<unknown> {
    const snapshot = options.snapshot ?? await this.checked('checkpoint') as Snapshot;
    const viewport = { width: options.width ?? 1440, height: options.height ?? 1000 };
    if (![viewport.width, viewport.height].every(v => Number.isInteger(v) && v >= 320 && v <= 4096)) throw new CliError('INVALID_PARAMETER', 'Capture width and height must be integers from 320 to 4096.');
    const page = await this.context.newPage();
    try {
      await page.setViewportSize(viewport);
      // A separate, frozen instance cannot alter the interactive or headless source run.
      await page.addInitScript(value => { (window as unknown as Record<string, unknown>).__EXPERIMENT_KIT_CAPTURE__ = value; }, snapshot);
      await page.goto(`${this.server.url}/?experiment=${encodeURIComponent(this.project.definition.manifest.id)}&capture=1`, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => Boolean((window as unknown as Record<string, unknown>).__EXPERIMENT_KIT_CAPTURE_READY__), undefined, { timeout: 15000 });
      await page.evaluate(() => document.fonts.ready);
      const identity = await page.evaluate(() => (window as unknown as Record<string, unknown>).__EXPERIMENT_KIT_CAPTURE_READY__);
      await page.screenshot({ path: output, fullPage: true, animations: 'disabled' });
      const result = { path: output, snapshot, viewport, identity, externalNetwork: 'blocked', capture: 'frozen separate player instance' };
      await writeJSON(`${output}.json`, result);
      return result;
    } finally { await page.close(); }
  }
}
