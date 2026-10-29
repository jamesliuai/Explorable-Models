/**
 * `explorable-models activity preview` smoke test (report §15.2). The spec starts the preview server for an authoring
 * package (the CLI scaffold with an unused group, a view no stage shows, data outside the graph's bounds, a crowded root
 * label and an equation KaTeX cannot parse), opens the page, checks that the author view and the learner view both render, switches the stage with
 * the stage selector and checks the diagnostics panel. Screenshots: desktop, 390 px and 320 px, dark scheme.
 *
 * Evidence scope: Chromium (Playwright) with the preview page's in-page fixture hosts. Fixture-host results; they say
 * nothing about the Study Harness host, a packaged WebView or learning outcomes.
 */
import { mkdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { ActivityTemplate } from '@explorable-models/activity';
import type { ModelManifest } from '@explorable-models/core/model';
import { scaffoldActivity } from '../../packages/cli/src/activity-scaffold';
import { readActivityPackage } from '../../packages/cli/src/activity-files';
import { loadToolkit } from '../../packages/cli/src/activity-loader';
import { startActivityPreview, type PreviewSession } from '../../packages/cli/src/activity-preview';
import type { PreviewState } from '../../packages/cli/src/activity-preview-page';

const SHOTS = '/tmp/explorable-models-playwright/activity-preview';
mkdirSync(SHOTS, { recursive: true });

async function diagnosticPackage(directory: string): Promise<void> {
  await scaffoldActivity(directory);
  const edit = async <T>(file: string, change: (value: T) => void) => {
    const value = JSON.parse(await readFile(path.join(directory, file), 'utf8')) as T;
    change(value);
    await writeFile(path.join(directory, file), `${JSON.stringify(value, null, 2)}\n`);
  };
  await edit<ModelManifest>('model.json', model => { model.parameters.p!.default = -0.8; });
  const toolkit = await loadToolkit();
  const digest = toolkit.validatePackage((await readActivityPackage(directory)).snapshot).model!.digest;
  await edit<ActivityTemplate>('template.json', template => {
    template.model.digest = digest;
    template.groups.push({ id: 'unused-notes', kind: 'annotation', label: 'Unused notes', description: 'Declared but never assigned.', solutionBearing: false, members: [] });
    template.groups.push({ id: 'hidden-values', kind: 'view', label: 'Hidden values', description: 'A view group no stage shows.', solutionBearing: false, members: ['hidden-values'] });
    template.views.push({ id: 'hidden-values', kind: 'values', group: 'hidden-values', title: 'Hidden values', description: 'Never shown.', equalAspect: false, marks: [], quantities: ['slope'] });
    const graph = template.views[0]!;
    graph.bounds = [-5, 5, -3, 3];
    const root = graph.marks.find(mark => mark.id === 'root-marker')!;
    root.text = 'Root of the line where it crosses the horizontal axis, labelled with a deliberately long caption that cannot fit beside the probe point';
    root.placement = { anchor: 'n', offset: [0, -8], leader: false, maxWidthEm: 100 };
    template.equations.find(equation => equation.id === 'rule')!.tex = 'y = {{q:slope}} \\cdot x + \\frac{{{q:intercept}}';
  });
}

let work: string;
let session: PreviewSession;
test.beforeAll(async () => {
  work = await mkdtemp(path.join(tmpdir(), 'explorable-models-preview-spec-'));
  await diagnosticPackage(path.join(work, 'diagnostic-preview'));
  const started = await startActivityPreview({ directory: path.join(work, 'diagnostic-preview') });
  if (!started.ok) throw new Error(`The preview did not start: ${JSON.stringify(started.report)}`);
  session = started.session;
});
test.afterAll(async () => { await session?.close(); if (work) await rm(work, { recursive: true, force: true }); });

/** Opens the preview, refusing every request to another origin. */
async function open(page: Page): Promise<{ foreign: string[]; errors: string[] }> {
  const foreign: string[] = [], errors: string[] = [];
  const origin = new URL(session.url).origin;
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    foreign.push(route.request().url());
    return route.abort('blockedbyclient');
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(session.url);
  await page.waitForFunction(() => window.__activityPreview?.ready === true, undefined, { timeout: 30_000 });
  return { foreign, errors };
}
const codes = (page: Page) => page.locator('[data-preview="diagnostics"] li[data-code]').evaluateAll(items => [...new Set(items.map(item => item.getAttribute('data-code')))].sort());
/**
 * Scrolls each lane's equations into view (KaTeX loads only for visible equations) and waits until every equation is
 * rendered or reported as a MATH_FALLBACK; the malformed "Line" equation stays plain text.
 */
async function showEquations(page: Page): Promise<void> {
  for (const lane of ['author', 'learner'] as const) {
    const host = page.locator(`[data-preview="${lane}-surface"] [data-explorable-models-activity]`);
    await host.locator('.ema-equations').scrollIntoViewIfNeeded();
    await expect.poll(async () => {
      const state = await page.evaluate(() => window.__activityPreview!.state()) as PreviewState;
      const fallbacks = state.diagnostics[lane].filter(item => item.code === 'MATH_FALLBACK').length;
      return fallbacks > 0 && await host.locator('.ema-math .ema-plain').count() === fallbacks;
    }, { timeout: 8_000 }).toBe(true);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}
const DIAGNOSTIC_CODES = ['CLIPPED', 'LABEL_CALLOUT', 'MATH_FALLBACK', 'NEVER_VISIBLE', 'UNREFERENCED'];

test('opens the author and learner views, switches stage through the host and lists the diagnostics', async ({ page }) => {
  // Tall enough that both lanes stay in view: an offscreen surface pauses its activity (and says so) until it is seen.
  await page.setViewportSize({ width: 1440, height: 3200 });
  const { foreign, errors } = await open(page);
  const author = page.locator('[data-preview="author"]'), learner = page.locator('[data-preview="learner"]');
  await expect(author.getByRole('heading', { name: 'Author view' })).toBeVisible();
  await expect(learner.getByRole('heading', { name: 'Learner view' })).toBeVisible();
  // Both lanes mount the real learner surface; at the prediction stage only the author view draws the root.
  const authorSurface = author.locator('[data-explorable-models-activity]'), learnerSurface = learner.locator('[data-explorable-models-activity]');
  await expect(authorSurface.locator('svg').first()).toBeVisible();
  await expect(learnerSurface.locator('svg').first()).toBeVisible();
  await expect(authorSurface.getByText('Root (x_r, 0)', { exact: true })).toBeVisible();
  await expect(learnerSurface.getByText('Root (x_r, 0)', { exact: true })).toHaveCount(0);
  await expect(author.locator('tr[data-group="root"]')).toContainText('hidden: not in this stage');
  await expect(page.locator('[data-preview="stage"]')).toHaveValue('predict');
  await showEquations(page);
  expect(await codes(page)).toEqual(DIAGNOSTIC_CODES);
  // Template warnings (3: the TeX parse of the malformed equation, S8, and the two template warnings); the author
  // surface's CLIPPED, LABEL_CALLOUT (the crowded root label drawn as a numbered callout, S5) and MATH_FALLBACK; the
  // learner surface's CLIPPED and MATH_FALLBACK: without the root (not shown at the prediction stage) the learner view
  // has no crowded label.
  await expect(page.locator('[data-preview="jump-diagnostics"]')).toHaveText('Diagnostics (8)');
  expect((await page.evaluate(() => window.__activityPreview!.state()) as PreviewState).diagnostics.learner.map(item => item.code).sort()).toEqual(['CLIPPED', 'MATH_FALLBACK']);
  await page.screenshot({ path: `${SHOTS}/desktop-predict.png`, fullPage: true });

  await page.locator('[data-preview="stage"]').selectOption('explore');
  await expect(page.locator('[data-preview="route"]')).toContainText('predict → explore by transition show-root (host receipt');
  await expect(page.locator('[data-preview="stage"]')).toBeEnabled();
  await expect(learnerSurface.getByText('Root (x_r, 0)', { exact: true })).toBeVisible();
  await expect(author.locator('tr[data-group="root"]')).toHaveAttribute('data-learner', 'fixed');
  await showEquations(page);
  const state = await page.evaluate(() => window.__activityPreview!.state()) as PreviewState;
  expect(state).toMatchObject({ stageId: 'explore', author: { stageId: 'explore' }, learner: { stageId: 'explore' } });
  expect(state.diagnostics.learner.map(item => item.code).sort()).toEqual(['CLIPPED', 'LABEL_CALLOUT', 'MATH_FALLBACK']);
  await expect(page.locator('[data-preview="diagnostics-learner"] li[data-code="CLIPPED"]')).toContainText('lie outside the authored view bounds');
  await expect(page.locator('[data-preview="diagnostics-learner"] li[data-code="MATH_FALLBACK"]')).toContainText('KaTeX parse error');
  await page.screenshot({ path: `${SHOTS}/desktop-explore.png`, fullPage: true });

  // Closing, then returning: the activity restarts at the initial stage.
  await page.locator('[data-preview="stage"]').selectOption('closed');
  await expect(page.locator('[data-preview="route"]')).toContainText('explore → closed by transition close-from-explore');
  await page.locator('[data-preview="stage"]').selectOption('predict');
  await expect(page.locator('[data-preview="route"]')).toContainText('No transition leads from closed to predict');
  await expect(learnerSurface.getByText('Root (x_r, 0)', { exact: true })).toHaveCount(0);
  expect(foreign).toEqual([]);
  expect(errors).toEqual([]);
});

for (const width of [390, 320]) {
  test(`fits ${width} px without horizontal scrolling (dark scheme)`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.setViewportSize({ width, height: 900 });
    const { errors } = await open(page);
    await page.locator('[data-preview="stage"]').selectOption('explore');
    await expect(page.locator('[data-preview="route"]')).toContainText('show-root');
    await expect(page.locator('[data-preview="stage"]')).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await showEquations(page);
    expect(await codes(page)).toEqual(DIAGNOSTIC_CODES);
    await page.screenshot({ path: `${SHOTS}/mobile-${width}-dark.png`, fullPage: true });
    expect(errors).toEqual([]);
  });
}
