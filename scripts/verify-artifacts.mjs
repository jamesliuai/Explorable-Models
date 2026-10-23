import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { register } from 'tsx/esm/api';
import { chromium } from 'playwright';
import { verifyInventory, verifySiteArchive } from './artifact-integrity.mjs';
register();
const { serveStatic } = await import('../packages/cli/src/server.ts');
const directory = path.resolve('release/preview');
const manifest = await verifyInventory(directory);
const site = manifest.files.find(item => item.file === `explorable-models-site-${manifest.version}.zip`);
if (!site) throw new Error('Missing static site archive.');
const { files } = verifySiteArchive(await readFile(path.join(directory, site.file)));
for (const entry of manifest.files.filter(item => item.file.endsWith('.tgz'))) {
  const metadata = JSON.parse(execFileSync('tar', ['-xOf', path.join(directory, entry.file), 'package/package.json'], { encoding: 'utf8' }));
  if (metadata.version !== manifest.version || metadata.publishConfig?.tag !== 'preview' || metadata.repository?.url !== 'git+https://github.com/jamesliuai/Explorable-Models.git') throw new Error(`Package metadata mismatch: ${entry.file}`);
}

const temporary = await mkdtemp(path.join(tmpdir(), 'explorable-models-artifacts-'));
const subpath = 'nested-preview';
const screenshots = '/tmp/experiment-kit-public-preview';
await mkdir(screenshots, { recursive: true });
let server, browser;
try {
  for (const [name, bytes] of Object.entries(files)) {
    const destination = path.join(temporary, subpath, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
  server = await serveStatic(temporary);
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await context.route('**/*', route => new URL(route.request().url()).origin === server.url ? route.continue() : route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const base = `${server.url}/${subpath}/`;
  await page.goto(base);
  await page.waitForFunction(() => Boolean(window.__COMPOSITION_STUDIO__));
  if (!/Explorable Models/.test(await page.title()) || await page.locator('vite-error-overlay').count()) throw new Error('Public entry did not render the studio.');
  await page.screenshot({ path: `${screenshots}/studio-default-1440.png`, fullPage: true });
  await page.getByRole('textbox', { name: 'Amplitude exact value' }).fill('3');
  await page.getByRole('button', { name: 'Apply Amplitude', exact: true }).click();
  await page.waitForFunction(() => window.__COMPOSITION_STUDIO__.session.getState().frame.quantities.ordinate.value === 3);
  const run = await page.evaluate(() => window.__COMPOSITION_STUDIO__.session.getState().run.id);
  await page.getByRole('button', { name: 'Try a targeted revision' }).click();
  await page.getByRole('status').first().filter({ hasText: 'scientific run and time preserved' }).waitFor();
  if (await page.evaluate(() => window.__COMPOSITION_STUDIO__.session.getState().run.id) !== run) throw new Error('Presentation revision replaced the scientific run.');
  await page.setViewportSize({ width: 390, height: 900 });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) throw new Error('Public studio overflows a mobile viewport.');
  await page.screenshot({ path: `${screenshots}/studio-mobile-390.png`, fullPage: true });
  await page.getByRole('combobox').selectOption('triangle');
  await page.getByRole('status').first().filter({ hasText: 'Editable composition loaded' }).waitFor();
  await page.getByRole('textbox', { name: 'Base x exact value' }).fill('0');
  await page.getByRole('button', { name: 'Apply Base x', exact: true }).click();
  await page.waitForFunction(() => window.__COMPOSITION_STUDIO__.session.getState().frame.quantities.angleA.status === 'undefined');
  await page.screenshot({ path: `${screenshots}/studio-boundary-390.png`, fullPage: true });
  await page.goto(`${base}guide.html`);
  await page.getByRole('heading', { name: 'Embed an explanation' }).waitFor();
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) throw new Error('Preview guide overflows a mobile viewport.');
  await page.screenshot({ path: `${screenshots}/guide-mobile-390.png`, fullPage: true });
  for (const route of ['gallery.html', '?experiment=linear-map&embed=1']) {
    await page.goto(base + route);
    await page.waitForFunction(() => Boolean(window.__EXPERIMENT_KIT__));
  }
  // A v1 download must reopen through the new default entry without a query string.
  await page.goto(`${base}?experiment=linear-map`);
  await page.waitForFunction(() => Boolean(window.__EXPERIMENT_KIT__));
  await page.evaluate(async () => {
    const api = window.__EXPERIMENT_KIT__;
    const state = await api.request({ method: 'state' });
    await api.request({ method: 'command', args: { type: 'set_parameters', parameters: { a: 2, b: 0.5, x: -1, y: 2 }, expectedRunVersion: state.run.version, expectedActiveRunId: state.activeRunId } });
  });
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const pendingDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download runnable bundle' }).click();
  const download = await pendingDownload;
  const exported = verifySiteArchive(await readFile(await download.path()));
  for (const [name, data] of Object.entries(exported.files)) {
    const destination = path.join(temporary, 'reopened', name);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, data);
  }
  await page.goto(`${server.url}/reopened/`);
  await page.getByRole('status').filter({ hasText: 'Saved state restored as a new run.' }).waitFor();
  const restored = await page.evaluate(() => window.__EXPERIMENT_KIT__.request({ method: 'inspect' }));
  if (restored.parameters.a !== 2 || JSON.stringify(restored.quantities['point.output'].value) !== '[-1,2]') throw new Error('Downloaded v1 state did not reopen through the default entry.');
  await page.goto(`${base}agent.html`);
  await page.waitForFunction(() => Boolean(window.__COMPOSITION_STUDIO__));
  if (errors.length) throw new Error(errors.join('\n'));
  const evidence = { version: manifest.version, status: 'passed', siteSha256: site.sha256, deliverables: manifest.files.length, staticAssets: Object.keys(files).length, subpath: `/${subpath}/`, browser: browser.version(), checks: ['deliverable and asset integrity', 'all tarball versions, repository and preview tags', 'default studio entry', 'legacy gallery/query routes', 'downloaded v1 artifact reopens exact state through new default entry', 'studio alias', 'exact parameter input', 'presentation preserves run', 'undefined boundary', 'public guide', 'mobile overflow', 'no browser errors', 'external network blocked'], screenshots, publication: 'not performed' };
  await writeFile(`${screenshots}/artifact-checks.json`, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await browser?.close();
  await server?.close();
  await rm(temporary, { recursive: true, force: true });
}
