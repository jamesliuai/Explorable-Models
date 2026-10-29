/**
 * Observed data beside a model prediction in a real browser (report §8.5, A13, A21, A32, A34): the example page runs
 * the activity adapter, a real module worker (core's worker protocol, document execution) and the learner surface.
 * Observations are separate markers with no connecting path, missing rows are left out and explained, the legend,
 * table, readouts and capture say which data are observed and which are model output, and the observations are the
 * same in every run. Example content and an in-page example host: example-page results in
 * Playwright Chromium, Firefox and WebKit only.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { LearnerProjection } from '@experiment-kit/activity';
import type { ObservationGeometry } from '@experiment-kit/core/model';

const SHOTS = '/tmp/pw-observed-data/shots';
const card = (page: Page): Locator => page.locator('#ob-card [data-experiment-kit-activity]');
const figure = (page: Page): Locator => card(page).locator('figure[data-eka-figure="fall-plot"]');
const projection = (page: Page): Promise<LearnerProjection> => page.evaluate(() => JSON.parse(JSON.stringify(window.observedExample.projection())));

async function openExample(page: Page, query = ''): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`/examples/study-harness-observed/observed.html${query}`);
  await page.waitForFunction(() => document.body.dataset.exampleReady === 'true' || document.body.dataset.exampleReady === 'failed');
  expect(await page.locator('#ob-status').textContent()).toBe('');
  await expect(card(page).locator('.eka')).toHaveAttribute('data-eka-ui-state', /ready|restored/);
  await expect(figure(page)).toBeVisible();
  return errors;
}

/** Drawn data primitives of the plot: filled markers per role, and every stroke path (lines) per role. */
async function drawn(page: Page): Promise<{ markers: Record<string, number>; strokes: Record<string, number>; markerCentres: [number, number][] }> {
  return figure(page).evaluate(element => {
    const count = (selector: string) => {
      const out: Record<string, number> = {};
      for (const path of element.querySelectorAll(selector)) { const role = [...path.classList].find(name => name.startsWith('eka-role-')) ?? ''; out[role] = (out[role] ?? 0) + 1; }
      return out;
    };
    const markerCentres = [...element.querySelectorAll<SVGPathElement>('.eka-marks path.eka-role-secondary.eka-fill')].map(path => { const box = path.getBBox(); return [box.x + box.width / 2, box.y + box.height / 2] as [number, number]; });
    return { markers: count('.eka-marks path.eka-fill'), strokes: count('.eka-marks .eka-stroke'), markerCentres };
  });
}

test.describe('observed data beside a model (§8.5)', () => {
  test('observe stage: recorded heights are separate markers with gaps, explained, and no model output', async ({ page }) => {
    const errors = await openExample(page);
    const shown = await projection(page);
    const observed = shown.views[0]!.marks.find(mark => mark.markId === 'recorded-points')!.geometry as ObservationGeometry;
    const complete = observed.points.filter(point => point.values[0] !== null && point.values[1] !== null).length;
    expect(complete).toBe(8);
    const facts = await drawn(page);
    // One diamond per complete row; no line of any kind (nothing joins, interpolates or fits the observations).
    expect(facts.markers).toEqual({ 'eka-role-secondary': complete });
    expect(facts.strokes).toEqual({});
    // The markers keep time order on screen with distinct positions (no marker sits at a missing row).
    const xs = facts.markerCentres.map(([x]) => x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    expect(new Set(xs.map(x => Math.round(x))).size).toBe(complete);
    await expect(figure(page).getByRole('list', { name: 'Legend' })).toHaveText('Recorded heights (observed)');
    const notes = figure(page).locator('.eka-notes li');
    await expect(notes.nth(0)).toHaveText('Recorded heights (observed): 8 observed points are drawn separately; no line joins, interpolates or fits them.');
    await expect(notes.nth(1)).toContainText('3 of 11 observations have a missing value — The ball was hidden behind the stand in this frame; Motion blur: no height could be read in this frame; The frame timestamp was not recorded. They are not drawn.');
    await expect(card(page)).not.toContainText('Predicted height');
    await expect(card(page)).not.toContainText('(model)');

    await card(page).getByRole('button', { name: 'Tables of recorded and predicted heights' }).click();
    const table = card(page).locator('[data-eka-panel="table"]').filter({ hasText: 'Recorded heights: table' });
    await expect(table.locator('thead th')).toHaveText(['Observation', 'Time (observed) (s)', 'Height (observed) (m)']);
    await expect(table.locator('tbody tr')).toHaveCount(11);
    await expect(table.locator('tbody tr').nth(3)).toHaveText(/^40\.6Missing: The ball was hidden behind the stand in this frame\.$/);
    await expect(table.locator('tbody tr').nth(8)).toHaveText(/^9Missing: The frame timestamp was not recorded\.7\.49$/);
    await expect(table.locator('[data-eka-source="observed"]')).toHaveText('Observed data. Source: Illustrative drop log written for the Experiment Kit observed-data example (not a real measurement). Constructed by hand for this example as readings from video frames at 0.2 s intervals, rounded to 0.01 m, with three cells left unread. Licence: MIT (this repository).');
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
    expect(results.violations.filter(item => item.impact === 'serious' || item.impact === 'critical').map(item => item.id)).toEqual([]);
    await card(page).screenshot({ path: `${SHOTS}/observe-default.png` });
    expect(errors).toEqual([]);
  });

  test('compare stage: the model curve is the only line; labels, readouts and capture separate observed from model output', async ({ page }) => {
    const errors = await openExample(page, '?stage=compare&explore=1');
    let facts = await drawn(page);
    expect(facts.markers).toEqual({ 'eka-role-secondary': 8 });
    expect(facts.strokes).toEqual({ 'eka-role-primary': 1 });
    await expect(figure(page).getByRole('list', { name: 'Legend' }).getByRole('listitem')).toHaveText(['Recorded heights (observed)', 'Predicted height (model)']);
    await expect(figure(page).locator('.eka-notes')).toContainText('Predicted height (model): 101 samples of its sampling variable from 0 to 1 (spacing 0.01); straight lines join neighbouring samples, so the drawing does not show values between them or features narrower than the spacing.');
    await expect(card(page).locator('[data-eka-panel="values"] dt')).toHaveText(['Landing time (model)']);
    await card(page).screenshot({ path: `${SHOTS}/compare-default.png` });

    // A committed parameter change starts a new run: the prediction moves, the recorded points stay where they are.
    const before = await projection(page);
    const curveBefore = before.views[0]!.marks.find(mark => mark.markId === 'prediction-curve')!.geometry;
    const centresBefore = facts.markerCentres;
    const box = card(page).locator('[data-parameter="g"]').getByRole('textbox');
    await box.fill('1.6');
    await box.press('Enter');
    await expect.poll(async () => (await projection(page)).controls.find(item => item.parameter === 'g')?.value).toBe(1.6);
    const after = await projection(page);
    expect(after.guards.expectedRunId).not.toBe(before.guards.expectedRunId);
    expect(after.views[0]!.marks.find(mark => mark.markId === 'prediction-curve')!.geometry).not.toEqual(curveBefore);
    expect(after.views[0]!.marks.find(mark => mark.markId === 'recorded-points')!.geometry).toEqual(before.views[0]!.marks.find(mark => mark.markId === 'recorded-points')!.geometry);
    facts = await drawn(page);
    expect(facts.markerCentres).toEqual(centresBefore);
    // With g = 1.6 the prediction runs past the authored view: the view says so instead of rescaling.
    await expect(figure(page).locator('.eka-clip')).toContainText('Some values are outside the view');
    await card(page).screenshot({ path: `${SHOTS}/compare-moon-gravity.png` });

    const capture = await page.evaluate(() => window.observedExample.capture('svg', 'fall-plot'));
    expect(capture.companionText).toContain('Recorded heights (observed): 11 observations, 3 with a missing value (not drawn), drawn as separate points; Predicted height (model).');
    const svg = (capture as { svg?: string }).svg ?? '';
    expect(svg.match(/<path[^>]*class="[^"]*eka-role-secondary[^"]*eka-stroke/g) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });

  for (const [label, query] of [['320', '?stage=compare&width=320'], ['390-dark', '?stage=compare&width=390&theme=dark'], ['200-text', '?stage=compare&width=390&text=200']] as const) {
    test(`reflows at ${label} without horizontal overflow and keeps the labels`, async ({ page }) => {
      await openExample(page, query);
      await card(page).getByRole('button', { name: 'Tables of recorded and predicted heights' }).click();
      const overflow = await card(page).evaluate(host => {
        const root = host.shadowRoot!.querySelector<HTMLElement>('.eka')!;
        const limit = root.getBoundingClientRect().right + 1;
        return { card: root.scrollWidth > root.clientWidth + 1, offenders: [...root.querySelectorAll<HTMLElement>('*')].filter(element => !element.closest('.eka-sr, .eka-table-region') && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().right > limit).length };
      });
      expect(overflow).toEqual({ card: false, offenders: 0 });
      expect((await drawn(page)).strokes).toEqual({ 'eka-role-primary': 1 });
      // A wrapped legend entry is one text element with one tspan per line.
      const legend = await figure(page).getByRole('list', { name: 'Legend' }).getByRole('listitem').evaluateAll(items => items.map(item => [...item.querySelectorAll('tspan')].map(line => line.textContent ?? '').join(' ')));
      expect(legend).toEqual(['Recorded heights (observed)', 'Predicted height (model)']);
      await card(page).screenshot({ path: `${SHOTS}/compare-${label}.png` });
    });
  }
});
