import { chromium } from 'playwright';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// Capture the actual browser renderer at native device resolution. No model evaluation here.
const root = fileURLToPath(new URL('../', import.meta.url));
const out = resolve(root, 'local-captures/showcase');
const refreshReadme = process.argv.includes('--readme');
if (process.argv.slice(2).some(arg => arg !== '--readme')) throw new Error('Usage: node scripts/capture-showcase.mjs [--readme]');
const base = process.env.SHOWCASE_URL ?? 'http://127.0.0.1:4173';
const examples = [
  { id: 'projectile', title: 'Projectile motion', alternate: 'High arc', slug: 'high-arc-impact' },
  { id: 'forces', title: 'Forces on a slope', alternate: 'Held by friction', slug: 'static-equilibrium' },
  { id: 'waves', title: 'Wave interference', alternate: 'Cancel', slug: 'cancellation' },
  { id: 'light', title: 'Refraction', alternate: 'Total reflection', slug: 'total-reflection' },
  { id: 'matrix', title: 'Linear transformations', alternate: 'Collapse', slug: 'collapsed' },
  { id: 'probability', title: 'Fault detection & base rates', alternate: 'Common faults', slug: 'common-faults' },
];
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 3, reducedMotion: 'reduce' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
const records = [];
async function ready() {
  await page.locator('.ex-card[aria-busy="false"][data-preview="false"]').waitFor();
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
}
async function capture(name, cardOnly) {
  await ready();
  const filename = `${name}@3x.png`;
  const buffer = cardOnly ? await page.locator('.ex-card').screenshot({ path: resolve(out, filename) }) : await page.screenshot({ path: resolve(out, filename), fullPage: true });
  const parameters = await page.getByRole('group', { name: 'Model parameters' }).getByRole('textbox').evaluateAll(inputs => inputs.map(input => ({ label: input.getAttribute('aria-label'), value: input.value })));
  records.push({ file: filename, width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), url: page.url(), viewport: page.viewportSize(), deviceScaleFactor: 3, parameters, metrics: await page.locator('.ex-metrics').innerText(), time: await page.locator('.ex-time').count() ? await page.locator('.ex-time').textContent() : null });
  console.log(`${filename}: ${records.at(-1).width} × ${records.at(-1).height}`);
}
try {
  for (const example of examples) {
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.goto(`${base}/showcase.html?example=${example.id}`);
    await ready();
    await capture(`${example.id}-conversation`, false);
    await capture(`${example.id}-card`, true);
    await page.setViewportSize({ width: 390, height: 844 });
    await capture(`${example.id}-mobile`, false);
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.getByRole('button', { name: example.alternate, exact: true }).click();
    await ready();
    if (example.id === 'projectile') { await page.getByRole('slider', { name: 'Flight time', exact: true }).press('End'); await ready(); }
    // Remove a keyboard focus outline from the archival image without changing model state.
    await page.locator('h1').click();
    await capture(`${example.id}-${example.slug}`, true);
  }
  if (errors.length) throw new Error(`Browser errors during capture: ${errors.join('\n')}`);
  const metadata = { capturedAt: new Date().toISOString(), browser: await browser.version(), method: 'Chromium native 3× device-resolution PNG; no upscaling or reconstruction' };
  await writeFile(resolve(out, 'capture.json'), JSON.stringify({ ...metadata, records }, null, 2) + '\n');
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Explorable Models — capture collection</title><style>body{margin:0;background:#f3f5f7;color:#233344;font:15px system-ui,sans-serif}main{max-width:1740px;padding:36px;margin:auto}h1{margin:0 0 12px;font-size:32px;letter-spacing:-1px}header p{color:#627184;margin:0 0 28px;line-height:1.7}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:26px}article{min-width:0}h2{font-size:18px;font-weight:600;margin:0 0 12px}img{display:block;width:100%;height:auto;border:1px solid #d4dce5;border-radius:12px;box-sizing:border-box}nav{display:flex;gap:14px;flex-wrap:wrap;margin-top:12px;font-size:12px}a{color:#087d74;text-decoration:none}a:hover{text-decoration:underline}footer{margin-top:24px;font-size:12px;color:#627184}@media(max-width:1000px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:640px){main{padding:20px}.grid{grid-template-columns:1fr}}</style><main><header><h1>Six ways to explore.</h1><p>Interactive conversation cards · captured from the local production build at 3× resolution.<br>Open an image for full resolution, or open the live example to move its sliders.</p></header><div class="grid">${examples.map(example => `<article><h2>${example.title}</h2><a href="${example.id}-card@3x.png"><img src="${example.id}-card@3x.png" alt="${example.title} interactive card"></a><nav><a href="${base}/showcase.html?example=${example.id}">Live example ↗</a><a href="${example.id}-conversation@3x.png">Conversation</a><a href="${example.id}-mobile@3x.png">Mobile</a><a href="${example.id}-${example.slug}@3x.png">${example.id === 'projectile' ? 'At impact' : example.alternate}</a></nav></article>`).join('')}</div><footer>24 source PNGs · native screenshots · local-captures/ is Git-ignored · settings and dimensions in capture.json</footer></main></html>`;
  await writeFile(resolve(out, 'index.html'), html);
  const review = await browser.newContext({ viewport: { width: 1800, height: 1100 }, deviceScaleFactor: 2 });
  const reviewPage = await review.newPage();
  await reviewPage.goto(pathToFileURL(resolve(out, 'index.html')).href);
  await reviewPage.evaluate(async () => { await Promise.all([...document.images].map(image => image.decode())); await document.fonts.ready; });
  await reviewPage.screenshot({ path: resolve(out, 'collection@2x.png'), fullPage: true });
  console.log(`Review index: ${resolve(out, 'index.html')}`);
  if (refreshReadme) {
    const destination = resolve(root, 'docs/images/showcase');
    await mkdir(destination, { recursive: true });
    const selected = [];
    for (const id of ['projectile', 'matrix', 'probability']) {
      const record = records.find(record => record.file === `${id}-card@3x.png`);
      await cp(resolve(out, record.file), resolve(destination, `${id}.png`));
      selected.push({ ...record, file: `${id}.png`, sourceCapture: `local-captures/showcase/${record.file}` });
    }
    await writeFile(resolve(destination, 'capture.json'), JSON.stringify({ ...metadata, refresh: 'Run npm run build and npm run preview, then node scripts/capture-showcase.mjs --readme. Inspect the refreshed README images before committing.', records: selected }, null, 2) + '\n');
    console.log(`README screenshots refreshed: ${destination}`);
  }
} finally { await browser.close(); }
