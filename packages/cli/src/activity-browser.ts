/**
 * Headless Chromium session over a built activity bundle (Node side). Serves the bundle on loopback with the CLI's
 * content security policy (module workers get `connect-src 'none'`), blocks every request to another origin (and
 * records it), and drives the fixed harness pages. Authored code runs only inside the bundle's module workers.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { CliError } from './files.js';
import { serveStatic, type StaticServer } from './server.js';
import type { BuiltBundle } from './activity-bundle.js';

export interface StageCaptureOutcome { result: Record<string, unknown> & { ok: boolean }; png: Buffer | null; pageErrors: string[] }

export class ActivityBrowser {
  readonly blockedRequests: string[] = [];
  readonly pageErrors: string[] = [];
  private constructor(private readonly browser: Browser, private readonly context: BrowserContext, private readonly page: Page, private readonly server: StaticServer, readonly version: string) {}

  static async open(bundle: BuiltBundle): Promise<ActivityBrowser> {
    const server = await serveStatic(bundle.directory);
    let browser: Browser | undefined;
    try {
      try { browser = await chromium.launch({ headless: true }); }
      catch (error) { throw new CliError('BROWSER_UNAVAILABLE', `Chromium could not start: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`, 'Run npx playwright install chromium once, then retry.'); }
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
      const session = { blocked: [] as string[] };
      await context.route('**/*', route => {
        const url = route.request().url();
        if (new URL(url).origin === server.url) return route.continue();
        if (session.blocked.length < 64) session.blocked.push(url.slice(0, 300));
        return route.abort('blockedbyclient');
      });
      const page = await context.newPage();
      const instance = new ActivityBrowser(browser, context, page, server, browser.version());
      session.blocked = instance.blockedRequests;
      page.on('pageerror', error => { if (instance.pageErrors.length < 32) instance.pageErrors.push(error.message.slice(0, 500)); });
      await page.goto(`${server.url}/harness.html`, { waitUntil: 'load' });
      await page.waitForFunction(() => Boolean(window.__activityAuthor?.ready), undefined, { timeout: 15000 });
      return instance;
    } catch (error) { await browser?.close(); await server.close(); throw error; }
  }

  /** Calls a harness method; harness failures become CliError with the harness code. */
  async request<T>(method: string, input: unknown): Promise<T> {
    const json = JSON.stringify(input, (_key, value: unknown) => Object.is(value, -0) ? { __negativeZero: true } : value).replace(/\{"__negativeZero":true\}/g, '-0');
    const reply = await this.page.evaluate(({ method, json }) => window.__activityAuthor!.request(method, json), { method, json }) as { result?: T; error?: { code: string; message: string } };
    if (reply.error) throw new CliError(reply.error.code, reply.error.message);
    return reply.result as T;
  }

  /** Captures one stage in a fresh page sized to `width` CSS pixels of card width. */
  async captureStage(input: unknown, options: { width: number }): Promise<StageCaptureOutcome> {
    const page = await this.context.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', error => { if (pageErrors.length < 16) pageErrors.push(error.message.slice(0, 500)); });
    try {
      await page.setViewportSize({ width: options.width + 32, height: 3200 });
      await page.goto(`${this.server.url}/capture.html`, { waitUntil: 'load' });
      await page.waitForFunction(() => Boolean(window.__activityCapture?.ready), undefined, { timeout: 15000 });
      const result = await page.evaluate(json => window.__activityCapture!.capture(json), JSON.stringify(input)) as StageCaptureOutcome['result'];
      const png = result.ok ? await page.locator('[data-explorable-models-activity]').screenshot({ animations: 'disabled', timeout: 20000 }) : null;
      return { result, png, pageErrors };
    } finally { await page.close(); }
  }

  async close(): Promise<void> { await this.context.close(); await this.browser.close(); await this.server.close(); }
}
