/**
 * Presentation of the learner card in a real browser (report §8.4, §10.1–§10.4, §11, §13, §19; gaps G40–G42, G44, G45,
 * G49, G51, G54, G70): a still layout while the learner previews or plays, one status presentation per cause, the
 * clipped state after Fit to data, comparisons with the kept run drawn and read at the same n, the preparing placeholder
 * and a sweep of every reachable state of the real fixture, the layout matrix of all five templates, long equations at
 * 320 px, the 3D fallback's table notes and capture failures.
 *
 * Evidence scope: Playwright Chromium (`npm run test:browser`), Firefox and WebKit (`npm run test:cross-browser`) with the
 * integration-fixture host and the projection lab. These are fixture-host
 * results; they say nothing about the Study Harness host, a packaged WebView, assistive-technology use or learning.
 * Screenshots are written to /tmp/experiment-kit-playwright/study-presentation for inspection.
 */
import { mkdirSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { card, control, expectAccessible, expectHidden, openFixture, overflow, pngSize, projection, respond, settle, step } from './support/study-harness';
import { drive, scenario } from '../player-activity/support/study-2d-browser';

const SHOTS = '/tmp/experiment-kit-playwright/study-presentation';
mkdirSync(SHOTS, { recursive: true });

type Fixture = typeof window.studyHarnessFixture & {
  adapter: { dispose(id?: string): void };
  prepared: { activityId: string; host: { suspend(input: { operationId: string; reason: string }): unknown; resume(input: { operationId: string }): unknown } } | null;
  workerFaults: { drop: number; dropped: number };
};
type W = { studyHarnessFixture: Fixture };
const ui = (page: Page) => card(page).locator('.eka');
const uiState = (page: Page) => ui(page).getAttribute('data-eka-ui-state');
const shot = async (page: Page, name: string, target: Locator = card(page)) => { await target.scrollIntoViewIfNeeded(); await target.screenshot({ path: `${SHOTS}/${name}.png` }); };
const box = async (locator: Locator) => { const value = (await locator.boundingBox())!; return { x: Math.round(value.x * 10) / 10, y: Math.round(value.y * 10) / 10, width: Math.round(value.width * 10) / 10, height: Math.round(value.height * 10) / 10 }; };
/**
 * Page coordinates (scroll included), so a scroll by the browser is not mistaken for a layout shift. Compare them with
 * `same()`: layout positions are multiples of the engine's layout unit (1/64 px in Chromium and WebKit, 1/60 px in
 * Firefox) reported as floats, so a change of one unit fails while float noise does not. Rounding to 0.1 px instead
 * read one unchanged Firefox position, 1674.95, as 1675 before a scroll and 1674.9 after it.
 */
const pageBox = async (locator: Locator) => locator.evaluate(element => { const rect = element.getBoundingClientRect(); return [rect.x + scrollX, rect.y + scrollY, rect.width, rect.height]; });
/** `expected` with every number replaced by a matcher that accepts a difference below 0.005 px (see `pageBox`). */
const same = <T,>(expected: T): T => (typeof expected === 'number' ? expect.closeTo(expected, 2)
  : Array.isArray(expected) ? expected.map(same) : expected && typeof expected === 'object' ? Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, same(value)])) : expected) as T;
/** Retry controls (any wording) of the card: at most one per state. */
const retries = (page: Page) => card(page).getByRole('button', { name: /^(Try again|Retry saving)$/ });
/** Prediction → step-size exploration enabled → trace revealed (quadratic explore-step). */
async function toRevealedTrace(page: Page): Promise<void> {
  await respond(page, 'Small steps shrink the positions; larger ones overshoot and may grow.');
  await step(page, 'enable-exploration');
  await step(page, 'reveal-trace');
}
/** The host closes the open activity while its card stays mounted (the fixture flows remove the card after closing). */
async function hostClose(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const prepared = (window as unknown as { studyHarnessFixture: { prepared: { host: { close(input: { operationId: string; reason: string }): Promise<{ ok: boolean }> } } } }).studyHarnessFixture.prepared;
    const outcome = await prepared.host.close({ operationId: `close-${Date.now()}`, reason: 'Closed by the presentation test.' });
    if (!outcome.ok) throw new Error('close refused');
  });
  await settle(page);
}
async function goTo(page: Page, index: number): Promise<void> {
  const input = card(page).getByLabel('Go to n =');
  await input.fill(String(index));
  await input.press('Enter');
  await expect.poll(async () => (await projection(page)).navigation?.value).toBe(index);
  await settle(page);
}

test.describe('a still card while the learner works (G40, report §10.1, §11)', () => {
  for (const layout of [{ name: 'desktop', query: '?mode=free', viewport: { width: 1440, height: 1000 } }, { name: 'container-390', query: '?mode=free&width=390', viewport: { width: 1440, height: 1000 } }]) {
    test(`${layout.name}: keyboard and pointer previews and Play/Pause move nothing above the control in use`, async ({ page }) => {
      await page.setViewportSize(layout.viewport);
      const errors = await openFixture(page, layout.query);
      const slider = control(page, 'eta').getByRole('slider');
      await slider.scrollIntoViewIfNeeded();
      const figures = card(page).locator('figure.eka-figure');
      const stable = async () => ({
        slider: await pageBox(slider), figures: await Promise.all((await figures.all()).map(pageBox)), instruction: await pageBox(card(page).locator('.eka-instruction')),
        navigation: await pageBox(card(page).locator('.eka-nav')),
      });
      /** The layout once it has stopped changing (two equal measurements a frame apart). */
      const still = async () => {
        let last = await stable();
        for (let i = 0; i < 20; i++) {
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          const next = await stable();
          if (JSON.stringify(next) === JSON.stringify(last)) return next;
          last = next;
        }
        return last;
      };
      // Step once so the committed frame has drawn steps and a preview (at n = 0) has none: the legend stays the same.
      await card(page).getByRole('button', { name: 'Next iteration' }).click();
      await settle(page);
      const before = await still();

      // Keyboard preview: the key is held, the card is tentative, nothing above the slider moved and no banner appeared.
      await slider.focus();
      await page.keyboard.down('ArrowRight');
      await expect(ui(page)).toHaveAttribute('data-eka-ui-state', 'tentative-preview');
      await expect(card(page).locator('.eka-banner')).toHaveCount(0);
      await expect(card(page).locator('.eka-inline-status[data-cause="preview"]')).toBeVisible();
      await expect(card(page).locator('figure.eka-figure[data-tentative="true"] .eka-subtitle').first()).toHaveText('Preview, not applied yet');
      expect(await stable(), 'keyboard preview').toEqual(same(before));
      await shot(page, `g40-${layout.name}-keyboard-preview`);
      await page.keyboard.up('ArrowRight');
      await expect(ui(page)).not.toHaveAttribute('data-eka-ui-state', 'tentative-preview');
      await settle(page);
      // The commit restarts the run at n = 0 (from n = 1): still the same layout.
      const committed = await still();
      expect(committed, 'after the commit').toEqual(same(before));

      // Pointer preview: during the drag the slider stays under the pointer. The card screenshot above can leave the
      // page scrolled to the card's top (Firefox does), so the slider is brought back into view first; the measured
      // boxes are page coordinates and do not depend on the scroll.
      await slider.scrollIntoViewIfNeeded();
      const { x, y, width, height } = await box(slider);
      await page.mouse.move(x + width * 0.3, y + height / 2);
      await page.mouse.down();
      await page.mouse.move(x + width * 0.45, y + height / 2, { steps: 4 });
      await expect(ui(page)).toHaveAttribute('data-eka-ui-state', 'tentative-preview');
      const dragging = await stable();
      expect(dragging, 'pointer preview').toEqual(same(committed));
      await page.mouse.up();
      await expect(ui(page)).not.toHaveAttribute('data-eka-ui-state', 'tentative-preview');
      await settle(page);

      // Play and Pause: the button that toggles stays where it was, and so does everything above it.
      const play = card(page).getByRole('button', { name: 'Play' });
      await play.scrollIntoViewIfNeeded();
      const playBox = await pageBox(play);
      const above = await stable();
      await play.click();
      const pause = card(page).getByRole('button', { name: 'Pause' });
      await expect(pause).toBeVisible();
      await expect(ui(page)).toHaveAttribute('data-eka-ui-state', 'playing');
      await expect(card(page).locator('.eka-banner')).toHaveCount(0);
      expect(await pageBox(pause), 'Pause where Play was').toEqual(same(playBox));
      expect((await stable()).figures, 'figures while playing').toEqual(same(above.figures));
      await pause.click();
      await expect(play).toBeVisible();
      expect(await pageBox(play), 'Play where Pause was').toEqual(same(playBox));
      expect(await card(page).textContent()).not.toContain('Playing.');
      expect(errors).toEqual([]);
    });
  }
});

test.describe('playback past the authored view moves nothing (S3, report §10.1, §10.2)', () => {
  for (const layout of [{ name: 'desktop', query: '?mode=free' }, { name: 'container-390', query: '?mode=free&width=390' }, { name: 'container-320-text-200', query: '?mode=free&width=320&text=200' }]) {
    for (const run of [
      { name: 'beyond n = 12', from: 10, until: 15, scenario: null },
      { name: 'diverging past |x| = 16', from: 0, until: 6, scenario: 'η = 1.25' },
    ]) {
      test(`${layout.name}, ${run.name}: the out-of-view indicator appears in its reserved line; navigation and Pause stay put`, async ({ page }) => {
        test.setTimeout(60_000);
        const errors = await openFixture(page, layout.query);
        if (run.scenario) await scenario(page, run.scenario);
        if (run.from) await goTo(page, run.from);
        const trace = card(page).locator('figure[data-eka-figure="trace-plot"]');
        await expect(trace.locator('.eka-clip')).toHaveCount(0);
        // The line is reserved and says that everything drawn is inside the view.
        await expect(trace.locator('[data-eka-clip-slot]')).toContainText('All drawn values are inside the view.');
        const play = card(page).getByRole('button', { name: 'Play' });
        await play.scrollIntoViewIfNeeded();
        const measure = async () => ({
          navigation: await pageBox(card(page).locator('.eka-nav')), toggle: await pageBox(card(page).locator('.eka-nav').getByRole('button', { name: /^(Play|Pause)$/ })),
          figures: await Promise.all((await card(page).locator('figure.eka-figure').all()).map(pageBox)),
        });
        const before = await measure();
        await play.click();
        const samples: Awaited<ReturnType<typeof measure>>[] = [];
        // Sample the layout on every animation frame until playback is past the authored range.
        await expect.poll(async () => { samples.push(await measure()); return (await projection(page)).navigation?.value ?? 0; }, { timeout: 20_000, intervals: [50] }).toBeGreaterThanOrEqual(run.until);
        await expect(trace.locator('.eka-clip')).toBeVisible();
        await expect(trace.locator('.eka-clip')).toContainText('Some values are outside the view');
        samples.push(await measure());
        for (const [index, sample] of samples.entries()) expect(sample, `layout sample ${index}`).toEqual(same(before));
        await card(page).getByRole('button', { name: 'Pause' }).click();
        expect(await measure(), 'after Pause').toEqual(same(before));
        await shot(page, `s3-${layout.name}-${run.scenario ? 'diverging' : 'long'}`);
        expect(errors).toEqual([]);
      });
    }
  }
});

test.describe('states presented by cause (G41, report §10.4)', () => {
  test('an in-flight reveal shows progress with no retry and no “Saved” chip; a failed one warns with one retry control', async ({ page }) => {
    const errors = await openFixture(page, '?delay=exposure-intent:4000');
    await respond(page, 'They shrink.');
    await step(page, 'enable-exploration');
    await page.locator('[data-fx-step="reveal-trace"]').click();
    const saving = card(page).locator('.eka-banner[data-cause="saving-reveal"]');
    await expect(saving).toBeVisible();
    await expect(saving).toHaveAttribute('data-tone', 'info');
    await expect(saving.locator('.eka-banner-title')).toHaveText('Saving before showing the next part…');
    await expect(saving).toContainText('The host is recording this step before showing');
    await expect(saving.getByRole('button')).toHaveCount(0);
    await expect(retries(page)).toHaveCount(0);
    await expect(card(page).locator('.eka-chip')).toHaveAttribute('data-persistence', 'saving');
    await expect(card(page).locator('.eka-chip')).not.toContainText('Saved');
    await expect(card(page).locator('.eka-pending')).toHaveCount(0);
    await shot(page, 'g41-saving-reveal');
    await page.waitForFunction(() => window.studyHarnessFixture.session.getSnapshot().steps.find(item => item.id === 'reveal-trace')?.state === 'done', null, { timeout: 15_000 });
    await settle(page);
    await expect(card(page).locator('.eka-banner')).toHaveCount(0);
    await expect(card(page).locator('.eka-chip')).toHaveAttribute('data-persistence', 'saved');
    expect(errors).toEqual([]);
  });

  test('a failed reveal intent: warning tone, title “Not saved yet”, exactly one retry, a chip that agrees', async ({ page }) => {
    const errors = await openFixture(page, '?fail=exposure-intent');
    await respond(page, 'They shrink.');
    await step(page, 'enable-exploration');
    await page.locator('[data-fx-step="reveal-trace"]').click();
    const failed = card(page).locator('.eka-banner[data-cause="reveal-not-saved"]');
    await expect(failed).toBeVisible();
    await settle(page, { allowPending: true });
    await expect(failed).toHaveAttribute('data-tone', 'warning');
    await expect(failed.locator('.eka-banner-title')).toHaveText('Not saved yet');
    await expect(failed).toContainText(/(is|are) not shown yet/);
    await expect(card(page).locator('.eka-banner')).toHaveCount(1);
    await expect(retries(page)).toHaveCount(1);
    await expect(card(page).locator('.eka-chip')).toHaveAttribute('data-persistence', 'pending-recovery');
    await expect(card(page).locator('.eka-chip')).toContainText('Not saved yet');
    await expectAccessible(page, 'reveal not saved');
    await shot(page, 'g41-reveal-not-saved');
    await failed.getByRole('button', { name: 'Try again' }).click();
    await page.waitForFunction(() => window.studyHarnessFixture.session.getSnapshot().steps.find(item => item.id === 'reveal-trace')?.state === 'done');
    await settle(page);
    await expect(card(page).locator('.eka-banner')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('a worker timeout shows one error banner with one retry, never a second “not applied” banner for the same failure', async ({ page }) => {
    test.setTimeout(60_000);
    const errors = await openFixture(page, '?mode=free');
    await page.evaluate(() => { (window as unknown as W).studyHarnessFixture.workerFaults.drop = 1; });
    await card(page).getByRole('button', { name: 'Next iteration' }).click();
    await expect(ui(page)).toHaveAttribute('data-eka-ui-state', 'recoverable-failure', { timeout: 15_000 });
    const failure = card(page).locator('.eka-banner[data-cause="failure"]');
    await expect(failure).toHaveAttribute('data-tone', 'error');
    await expect(failure.locator('.eka-banner-title')).toHaveText('The last step did not complete');
    await expect(failure).not.toContainText('The last step did not complete. The last step');
    await expect(card(page).locator('.eka-banner')).toHaveCount(1);
    await expect(card(page).getByText('That change was not applied')).toHaveCount(0);
    await expect(retries(page)).toHaveCount(1);
    await shot(page, 'g41-worker-failure');
    expect(errors).toEqual([]);
  });

  test('playing says nothing twice; a closed activity is titled closed', async ({ page }) => {
    let errors = await openFixture(page, '?mode=free');
    await card(page).getByRole('button', { name: 'Play' }).click();
    await expect(ui(page)).toHaveAttribute('data-eka-ui-state', 'playing');
    expect(await card(page).textContent()).not.toMatch(/Playing\.?\s*Playing/);
    await expect(card(page).locator('.eka-banner')).toHaveCount(0);
    await card(page).getByRole('button', { name: 'Pause' }).click();
    await settle(page);
    expect(errors).toEqual([]);

    errors = await openFixture(page, '?template=function-derivative&mode=free');
    await hostClose(page);
    await expect(ui(page)).toHaveAttribute('data-eka-ui-state', 'empty');
    const closed = card(page).locator('.eka-banner[data-cause="closed"]');
    await expect(closed.locator('.eka-banner-title')).toHaveText('This activity is closed');
    await expect(card(page)).not.toContainText('Nothing to show yet');
    await expect(closed.locator('p')).toHaveCount(1);
    await shot(page, 'g41-closed');
    expect(errors).toEqual([]);
  });
});

test.describe('the clipped state and Fit to data (G42, report §10.2)', () => {
  test('every template opens its default and free stages without a warning banner or out-of-view indicator', async ({ page }) => {
    test.setTimeout(120_000);
    for (const template of ['quadratic-gradient-descent', 'function-derivative', 'linear-transformation', 'vector-orientation-3d', 'quadratic-surface-gradient']) {
      for (const mode of ['guided', 'free']) {
        const errors = await openFixture(page, `?template=${template}&flow=generic&mode=${mode}&policy=full`);
        const where = `${template} (${mode})`;
        expect(await uiState(page), where).not.toBe('clipped');
        await expect(card(page).locator('.eka-banner[data-tone="warning"], .eka-banner[data-tone="error"]'), where).toHaveCount(0);
        await expect(card(page).locator('.eka-clip'), where).toHaveCount(0);
        expect(errors, where).toEqual([]);
      }
    }
  });

  test('linear transformation: zooming in shows the figure indicator, Fit to data leaves no text claiming data are outside', async ({ page }) => {
    const errors = await openFixture(page, '?template=linear-transformation&mode=free');
    const figure = card(page).locator('figure[data-eka-figure="plane"]');
    for (let i = 0; i < 3; i++) await figure.getByRole('button', { name: 'Zoom in' }).click();
    await settle(page);
    await expect(ui(page)).toHaveAttribute('data-eka-ui-state', 'clipped');
    await expect(figure.locator('.eka-clip')).toContainText('Some values are outside the view');
    // A 2D figure presents the state itself (with its actions): no banner repeats it above the content.
    await expect(card(page).locator('.eka-banner')).toHaveCount(0);
    await shot(page, 'g42-lt-zoomed');
    await figure.getByRole('button', { name: 'Fit to data' }).first().click();
    await settle(page);
    await expect(ui(page)).not.toHaveAttribute('data-eka-ui-state', 'clipped');
    expect(await card(page).textContent()).not.toMatch(/outside the (view|shown area)/);
    await shot(page, 'g42-lt-fitted');
    expect(errors).toEqual([]);
  });
});

test.describe('comparisons (G29, G44, report §8.4, §10.2)', () => {
  test('quadratic: the kept run is drawn dashed in the trace plot and read at the same n; hidden groups stay hidden in an independent task', async ({ page }) => {
    test.setTimeout(60_000);
    const errors = await openFixture(page, '?width=640');
    await toRevealedTrace(page);
    await scenario(page, 'η = 0.25');
    await goTo(page, 5);
    await card(page).getByRole('button', { name: 'Keep this run to compare' }).click();
    await expect.poll(async () => (await projection(page)).comparisons.length).toBe(1);
    await scenario(page, 'η = 1.25');
    await goTo(page, 3);
    const panel = card(page).locator('[data-eka-panel="comparisons"]');
    await expect(panel.locator('.eka-comparison-runs')).toHaveText('Kept run 1: η = 0.25');
    await expect(panel).not.toContainText('progress');
    await expect(panel).toContainText('Kept at n = 5. Drawn dashed with hollow circle markers in the plots.');
    await expect(panel).toContainText('Aligned by iteration index n: plots against n show both runs at the same n.');
    const aligned = panel.locator('[data-eka-comparison-aligned] tbody tr');
    await expect(aligned).toHaveCount(1);
    await expect(aligned.locator('th')).toHaveText('Position x_n at n = 3');
    await expect(aligned.locator('td')).toHaveText(['−13.5', '0.5']);
    // x₃ = 4·(1 − 2.5)³ = −13.5 and 4·(1 − 0.5)³ = 0.5, both read from the drawn points of each run's own frame.
    const overlay = card(page).locator('svg[data-eka-view-id="trace-plot"] g[data-eka-comparison]');
    await expect(overlay).toHaveCount(1);
    expect(await overlay.getAttribute('data-eka-comparison-frame-id')).toBe((await projection(page)).comparisons[0]!.frameId);
    expect(await overlay.locator('path.eka-hollow').count()).toBe(6);
    await expect(card(page).locator('svg[data-eka-view-id="trace-plot"] [role="listitem"]').last()).toContainText('Kept run 1 (η = 0.25)');
    await shot(page, 'g44-quadratic-comparison');
    // Beyond n = 5 the kept run has no value, and the panel says why.
    await goTo(page, 7);
    await expect(aligned.locator('td').last()).toContainText('Not available');
    await expect(panel).toContainText('The kept run was kept at n = 5 and is not computed beyond it.');
    // The host takes the step size off the card: the kept run still differs in it, and the panel says so without the
    // value instead of calling the runs the same (A34; R10).
    await page.evaluate(async () => {
      const fixture = window.studyHarnessFixture as unknown as {
        prepared: { activityId: string; host: { updatePolicy(input: unknown): Promise<{ ok: boolean }> } };
        host: { policy(id: string): Record<string, unknown> & { revision: number }; setPolicy(id: string, policy: unknown): unknown };
      };
      const id = fixture.prepared.activityId, current = fixture.host.policy(id);
      const next = fixture.host.setPolicy(id, { ...current, revision: current.revision + 1, issuedAt: new Date().toISOString(), permittedControls: ['a', 'x0'] });
      const outcome = await fixture.prepared.host.updatePolicy({ operationId: 'test-narrow-controls', policy: next });
      if (!outcome.ok) throw new Error('updatePolicy failed');
    });
    await settle(page);
    await expect(panel.locator('.eka-comparison-runs')).toHaveText('Kept run 1: settings not shown here differ from the current run');
    await expect(panel).toContainText('Settings that are not shown here differ from the current run.');
    await expect(panel).not.toContainText('Same parameters');
    // The hidden step size is not named or valued: no parameter table, no η in the run's name.
    await expect(panel.locator('caption', { hasText: 'Parameters that differ' })).toHaveCount(0);
    await expect(panel.locator('.eka-comparison-runs')).not.toContainText('η');
    await shot(page, 'r10-comparison-hidden-difference', panel);
    // The same visibility rules apply to the comparison: an independent task shows none of it, and no navigation
    // either, since its neutral scaffold keeps no position group (A25; R02, R10).
    await page.getByRole('button', { name: 'Interrupt: independent task here' }).click();
    await expect(card(page).getByText('Independent task', { exact: true })).toBeVisible();
    await settle(page);
    await expectHidden(page, ['trace', 'observations', 'regime', 'substituted'], 'independent task with a kept run');
    await expect(card(page).locator('g[data-eka-comparison]')).toHaveCount(0);
    await expect(card(page).locator('[data-eka-panel="comparisons"]')).toHaveCount(0);
    await expect(card(page).locator('.eka-nav')).toHaveCount(0);
    expect(await projection(page)).toMatchObject({ comparisons: [], navigation: null });
    await shot(page, 'r10-independent-no-comparison');
    expect(errors).toEqual([]);
  });
});

test.describe('preparing placeholder and the real-fixture state sweep (G45, report §10.4, A32)', () => {
  test('a host shows the preparing card before the binding exists, then the surface replaces it', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    // React development warnings (for example "flushSync was called from inside a lifecycle method") and any other
    // console error or warning fail the test (S11), as does a learner card attached more than once.
    const consoleProblems: string[] = [];
    page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') consoleProblems.push(`${message.type()}: ${message.text()}`); });
    await page.addInitScript(() => {
      const counter = window as unknown as { __cardsAttached: number };
      counter.__cardsAttached = 0;
      new MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) {
          if (node instanceof Element && (node.matches('[data-experiment-kit-activity]') || node.querySelector('[data-experiment-kit-activity]'))) counter.__cardsAttached++;
        }
      }).observe(document, { subtree: true, childList: true });
    });
    await page.goto('/study-harness.html?delay=register:2500');
    const placeholder = page.locator('[data-fx-card] [data-experiment-kit-activity-placeholder]');
    await expect(placeholder).toHaveCount(1);
    const frame = placeholder.locator('.eka');
    await expect(frame).toHaveAttribute('data-eka-ui-state', 'preparing');
    await expect(frame.locator('.eka-banner-title')).toHaveText('Preparing the activity…');
    await expect(frame.getByRole('heading', { level: 2 })).toHaveText('Step size in gradient descent');
    await expect(page.locator('[data-fx-card] [data-experiment-kit-activity]')).toHaveCount(0);
    await placeholder.screenshot({ path: `${SHOTS}/g45-preparing.png` });
    await expectAccessible(page, 'preparing placeholder');
    await page.waitForFunction(() => document.body.dataset.fixtureReady === 'true');
    await expect(placeholder).toHaveCount(0);
    await expect(card(page)).toHaveCount(1);
    // The card stays attached while the learner works: one response, a host step and a settle re-attach nothing.
    await respond(page, 'They shrink.');
    await step(page, 'enable-exploration');
    await settle(page);
    await expect(card(page)).toHaveCount(1);
    expect(await page.evaluate(() => (window as unknown as { __cardsAttached: number }).__cardsAttached), 'learner cards attached').toBe(1);
    expect(consoleProblems).toEqual([]);
    expect(errors).toEqual([]);
  });

  /** Each reachable state of the real adapter, driven through the fixture; checked and photographed (`after`: more checks). */
  const STATES: { state: string; query: string; reach: (page: Page) => Promise<void>; after?: (page: Page) => Promise<void> }[] = [
    { state: 'ready', query: '', reach: async () => undefined },
    { state: 'awaiting-persistence', query: '?fail=exposure-intent', reach: async page => { await respond(page, 'They shrink.'); await step(page, 'enable-exploration'); await page.locator('[data-fx-step="reveal-trace"]').click(); await expect(ui(page)).toHaveAttribute('data-eka-ui-state', 'awaiting-persistence'); await settle(page, { allowPending: true }); } },
    { state: 'tentative-preview', query: '?mode=free', reach: async page => { await control(page, 'eta').getByRole('slider').focus(); await page.keyboard.down('ArrowLeft'); } },
    { state: 'playing', query: '?mode=free', reach: async page => { await card(page).getByRole('button', { name: 'Play' }).click(); } },
    { state: 'paused', query: '?mode=free', reach: async page => { await card(page).getByRole('button', { name: 'Play' }).click(); await page.waitForTimeout(900); await card(page).getByRole('button', { name: 'Pause' }).click(); } },
    { state: 'boundary', query: '?mode=free', reach: async page => goTo(page, 1000) },
    { state: 'undefined', query: '?template=vector-orientation-3d&mode=free', reach: async page => scenario(page, 'u = (0, 0, 0), v = (1, 2, 2)') },
    { state: 'clipped', query: '?template=linear-transformation&mode=free', reach: async page => { for (let i = 0; i < 3; i++) await card(page).locator('figure[data-eka-figure="plane"]').getByRole('button', { name: 'Zoom in' }).click(); } },
    { state: 'recoverable-failure', query: '?mode=free', reach: async page => { await page.evaluate(() => { (window as unknown as W).studyHarnessFixture.workerFaults.drop = 1; }); await card(page).getByRole('button', { name: 'Next iteration' }).click(); await expect(ui(page)).toHaveAttribute('data-eka-ui-state', 'recoverable-failure', { timeout: 15_000 }); } },
    { state: 'stale-policy', query: '?revoke=1', reach: async () => undefined },
    // Catalogue-revoked content (S6): the host revokes the open template; the learner's next command finds it revoked.
    // After a host restart the saved activity cannot be reopened and its archival read-only record is shown instead.
    {
      state: 'unsupported', query: '?mode=free',
      reach: async page => {
        await page.evaluate(() => (window as unknown as { studyHarnessFixture: { revokeCatalogue(): void } }).studyHarnessFixture.revokeCatalogue());
        await card(page).getByRole('button', { name: 'Next iteration' }).click();
      },
      after: async page => {
        await expect(card(page).locator('.eka-banner[data-cause="unsupported"] .eka-banner-title')).toHaveText('This activity is not available here');
        await expect(card(page).locator('.eka-instruction')).toHaveText('This activity cannot be used here. Follow your session for what to do next.');
        await expect(card(page).locator('figure, input, .eka-scenarios button')).toHaveCount(0);
        await expect(card(page).getByText('That change was not applied')).toHaveCount(0);
        // The scripted flow restarts its host by reloading the tab; it reopens from the host's latest checkpoint.
        const consoleProblems: string[] = [];
        page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') consoleProblems.push(`${message.type()}: ${message.text()}`); });
        await page.reload();
        await page.waitForFunction(() => document.body.dataset.fixtureReady === 'true');
        const record = page.locator('[data-fx-card] [data-experiment-kit-archival]');
        await expect(record).toHaveCount(1);
        await expect(card(page)).toHaveCount(0);
        // Learner-facing words and the host's return action only (report §10.4, R19/R29).
        await expect(record.getByRole('heading', { name: /— saved, read-only$/ })).toBeVisible();
        await expect(record).not.toContainText(/quadratic-gradient-descent|Journal checkpoint/);
        await expect(record.locator('input, select, textarea')).toHaveCount(0);
        await expect(record.getByRole('button')).toHaveCount(1);
        await expect(record.getByRole('button', { name: 'Return to the session' })).toBeVisible();
        await record.screenshot({ path: `${SHOTS}/g45-unsupported-archival.png` });
        await expectAccessible(page, 'archival record after catalogue revocation');
        expect(consoleProblems).toEqual([]);
      },
    },
    { state: 'suspended', query: '?mode=free', reach: async page => { await page.evaluate(() => { (window as unknown as W).studyHarnessFixture.prepared!.host.suspend({ operationId: 'sweep-suspend', reason: 'host' }); }); } },
    { state: 'restored', query: '?template=function-derivative&mode=free', reach: async page => { await drive(page, 'save', 'backup'); await page.evaluate(() => (window as unknown as { studyHarnessFixture: { restartHost(): Promise<unknown> } }).studyHarnessFixture.restartHost()); await settle(page); } },
    { state: 'empty', query: '?template=function-derivative&mode=free', reach: hostClose },
    { state: 'disposed', query: '?mode=free', reach: async page => { await page.evaluate(() => { const fixture = (window as unknown as W).studyHarnessFixture; fixture.adapter.dispose(fixture.prepared!.activityId); }); } },
  ];
  for (const entry of STATES) {
    test(`real fixture in ${entry.state}: one status presentation, at most one retry control, no internal identifiers`, async ({ page }) => {
      test.setTimeout(60_000);
      const errors = await openFixture(page, entry.query);
      await entry.reach(page);
      await expect(ui(page)).toHaveAttribute('data-eka-ui-state', entry.state, { timeout: 15_000 });
      expect(await card(page).locator('.eka-banner').count(), 'banners').toBeLessThanOrEqual(1);
      expect(await retries(page).count(), 'retry controls').toBeLessThanOrEqual(1);
      const text = (await card(page).textContent()) ?? '';
      expect(text).not.toMatch(/fx-[a-z0-9]|sha256:|Error:|at \w+ \(|undefined undefined/);
      const banner = card(page).locator('.eka-banner');
      if (await banner.count()) {
        const title = (await banner.locator('.eka-banner-title').textContent())!.trim().replace(/[.…]$/, '');
        const paragraphs = (await banner.locator('.eka-banner-body p').allTextContents()).slice(1);
        for (const paragraph of paragraphs) expect(paragraph.trim().startsWith(title), `${entry.state}: message repeats the title`).toBe(false);
        const cause = await banner.getAttribute('data-cause');
        if (cause && ['saving-reveal', 'reveal-not-saved', 'journal-not-saved', 'journal-failed', 'display-not-recorded'].includes(cause)) await expect(card(page).locator('.eka-chip')).not.toHaveAttribute('data-persistence', 'saved');
      }
      if (entry.state === 'disposed') { await expect(card(page).locator('figure, input')).toHaveCount(0); }
      await shot(page, `g45-${entry.state}`);
      if (entry.state === 'tentative-preview') await page.keyboard.up('ArrowLeft');
      await entry.after?.(page);
      expect(errors).toEqual([]);
    });
  }
});

test.describe('layout matrix of all five templates (G49, report §10.4, §11)', () => {
  const TEMPLATES = ['quadratic-gradient-descent', 'function-derivative', 'linear-transformation', 'vector-orientation-3d', 'quadratic-surface-gradient'];
  const CONFIGURATIONS = [
    ...[320, 390, 640, 960].map(width => ({ name: `container-${width}`, query: `&width=${width}`, viewport: { width: 1440, height: 1000 }, width })),
    { name: 'desktop', query: '', viewport: { width: 1440, height: 1000 }, width: null },
    { name: 'text-200-container-320', query: '&text=200&width=320', viewport: { width: 1440, height: 1000 }, width: 320 },
    { name: 'text-200-container-390', query: '&text=200&width=390', viewport: { width: 1440, height: 1000 }, width: 390 },
    // 1280 × 1024 CSS px at 400 % zoom is a 320 × 256 viewport (WCAG 1.4.10 reflow).
    { name: 'zoom-400', query: '', viewport: { width: 320, height: 256 }, width: null },
  ];
  /** Every slider, text field and button of the card lies inside the card, keeps a usable target height and can take focus. */
  async function usable(page: Page, where: string): Promise<void> {
    const cardBox = (await ui(page).boundingBox())!;
    const targets = await card(page).locator('.eka-slider, .eka-input, .eka-button').evaluateAll(elements => elements.filter(element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && !element.closest('.eka-sr');
    }).map(element => { const rect = element.getBoundingClientRect(); return { right: rect.right, height: rect.height, name: (element.textContent ?? element.getAttribute('aria-label') ?? element.className).trim().slice(0, 30) }; }));
    expect(targets.length, where).toBeGreaterThan(3);
    for (const target of targets) {
      expect(target.right, `${where}: ${target.name} inside the card`).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1);
      expect(target.height, `${where}: ${target.name} target height`).toBeGreaterThanOrEqual(24);
    }
    // An offscreen card is suspended (its controls inert) until it is scrolled into view, as in a 400% zoom viewport.
    await card(page).locator('.eka-slider').first().scrollIntoViewIfNeeded();
    await expect(ui(page), `${where}: resumes when on screen`).not.toHaveAttribute('data-eka-ui-state', 'suspended');
    const first = card(page).locator('.eka-slider:not([aria-disabled="true"])').first();
    await first.focus({ timeout: 10_000 });
    expect(await first.evaluate(element => (element.getRootNode() as ShadowRoot).activeElement === element), `${where}: a slider takes focus`).toBe(true);
  }
  for (const template of TEMPLATES) {
    test(`${template}: containers 320/390/640/960, desktop, 200% text at 320 and 390 and 400% zoom keep the card usable without overflow`, async ({ context }) => {
      test.setTimeout(300_000);
      const spatial = template.includes('3d') || template.includes('surface') ? '&spatial=1' : '';
      for (const configuration of CONFIGURATIONS) {
        // A new tab per configuration: a fresh fixture session (the fixture keeps its host tables in the tab's sessionStorage).
        const page = await context.newPage();
        await page.setViewportSize(configuration.viewport);
        const errors = await openFixture(page, `?template=${template}&flow=generic&mode=free&policy=full${spatial}${configuration.query}`);
        const where = `${template} ${configuration.name}`;
        await expect(ui(page)).not.toHaveAttribute('data-eka-ui-state', 'restored');
        const facts = await overflow(page);
        expect(facts, where).toMatchObject({ page: false, card: false, offenders: [] });
        if (configuration.width) expect(Math.abs(facts.cardWidth - configuration.width), `${where}: card width`).toBeLessThanOrEqual(2);
        await usable(page, where);
        if (configuration.name.startsWith('text-200')) expect(await ui(page).locator('.eka-title').evaluate(element => parseFloat(getComputedStyle(element).fontSize)), where).toBeGreaterThan(30);
        if (['container-320', 'zoom-400', 'text-200-container-390'].includes(configuration.name)) await page.screenshot({ path: `${SHOTS}/g49-${template}-${configuration.name}.png`, fullPage: true });
        expect(errors, where).toEqual([]);
        await page.close();
      }
    });
  }

  test('reduced motion: no transition time and an instant 3D preset; without it the preset eases', async ({ browser }) => {
    test.setTimeout(180_000);
    for (const motion of ['reduce', 'no-preference'] as const) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: motion });
      const page = await context.newPage();
      const errors = await openFixture(page, '?template=vector-orientation-3d&flow=generic&mode=free&policy=full&spatial=1');
      expect(await ui(page).evaluate(element => getComputedStyle(element).getPropertyValue('--eka-motion-duration').trim()), motion).toBe(motion === 'reduce' ? '0ms' : '140ms');
      const spatial = card(page).locator('[data-eka-spatial="space"]');
      await spatial.scrollIntoViewIfNeeded();
      await expect(spatial).toHaveAttribute('data-eka-spatial-state', 'ready', { timeout: 15_000 });
      const preset = spatial.getByRole('button', { name: 'Top (x–y) view' });
      await preset.click();
      const immediate = await page.evaluate(() => (window.studyHarnessFixture.binding!.getProjection().presentation.views.space?.camera as { preset?: string } | null)?.preset ?? null);
      if (motion === 'reduce') expect(immediate, 'the preset is applied at once').toBe('top');
      else {
        expect(immediate, 'the preset eases first').not.toBe('top');
        await expect.poll(() => page.evaluate(() => (window.studyHarnessFixture.binding!.getProjection().presentation.views.space?.camera as { preset?: string } | null)?.preset ?? null)).toBe('top');
      }
      expect(errors).toEqual([]);
      await context.close();
    }
  });

  test('projection lab under React StrictMode: the remounted card still announces (Read current values speaks)', async ({ page }) => {
    // StrictMode mounts, unmounts and remounts every effect once: the card must not keep an announcer it released.
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/examples/study-harness-host/projection-lab.html?fixture=quadratic&state=ready&mode=react');
    const host = page.locator('#lab-surface');
    await expect(host.locator('.eka[data-eka-ui-state="ready"]')).toHaveCount(1);
    await host.getByRole('button', { name: 'Read current values' }).click();
    await expect(host.locator('.eka-sr[role=status][aria-live=polite]')).toContainText('Fixture values:');
    expect(errors).toEqual([]);
  });

  test('projection lab: the long and extreme fixtures lay out without overflow, cut text or overlapping labels at 320, 390 and 640 px, also at 200% text', async ({ page }) => {
    test.setTimeout(240_000);
    for (const fixture of ['long', 'extreme']) for (const width of [320, 390, 640]) for (const text of [false, true]) {
      const errors: string[] = [];
      page.removeAllListeners('pageerror');
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`/examples/study-harness-host/projection-lab.html?fixture=${fixture}&state=ready&width=${width}`);
      if (text) await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
      await page.waitForFunction(() => document.body.dataset.ready === 'true');
      await page.waitForTimeout(150);
      const where = `${fixture} at ${width}${text ? ' with 200% text' : ''}`;
      const facts = await page.evaluate(() => {
        const host = document.querySelector<HTMLElement>('#lab-surface [data-experiment-kit-activity]');
        const root = host?.shadowRoot?.querySelector<HTMLElement>('.eka');
        const limit = root ? root.getBoundingClientRect().right + 1 : window.innerWidth;
        const offenders = root ? [...root.querySelectorAll<HTMLElement>('*')].filter(element => {
          if (element.closest('.eka-sr, .eka-table-region, .eka-math')) return false;
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.right > limit;
        }).slice(0, 8).map(element => `${element.tagName.toLowerCase()}.${element.className.toString().split(' ')[0]}`) : ['no card'];
        return { card: !!root && root.scrollWidth > root.clientWidth + 1, offenders };
      });
      expect(facts, where).toEqual({ card: false, offenders: [] });
      // S5 (report §10.2, §10.3): no text in a drawing is cut (axis titles, legend entries, labels, the label key), and
      // labels that find no free place become numbered callouts listed in the figure's key instead of overlapping.
      const drawn = await page.evaluate(() => {
        const root = document.querySelector('#lab-surface [data-experiment-kit-activity]')!.shadowRoot!;
        const texts = [...root.querySelectorAll('svg.eka-plot text')].map(node => node.textContent ?? '');
        const tags = [...root.querySelectorAll('svg.eka-plot .eka-labels > g[data-eka-callout]')].map(node => node.getAttribute('data-eka-callout'));
        const keyed = [...root.querySelectorAll('svg.eka-plot [data-eka-label-key] > g')].map(node => node.getAttribute('data-eka-callout'));
        const overlaps = (window as unknown as { __lab: { diagnostics: { code: string }[] } }).__lab.diagnostics.filter(item => item.code === 'LABEL_OVERLAP').length;
        return { cut: texts.filter(value => value.includes('…')), tagsKeyed: tags.every(tag => keyed.includes(tag)) && tags.length === keyed.length, overlaps };
      });
      expect(drawn, where).toEqual({ cut: [], tagsKeyed: true, overlaps: 0 });
      if (width === 320) await page.locator('#lab-surface').screenshot({ path: `${SHOTS}/g49-lab-${fixture}-${width}${text ? '-text200' : ''}.png` });
      expect(errors, where).toEqual([]);
    }
  });
});

test.describe('long equations at 320 px (G51, report §10.3)', () => {
  test('linear transformation: an equation wider than its panel is a focusable, labelled scroll region with a visible hint and its plain text', async ({ page }) => {
    const errors = await openFixture(page, '?template=linear-transformation&mode=free&width=320&fonts=bundled');
    const equations = card(page).locator('[data-eka-panel="equations"]');
    await equations.scrollIntoViewIfNeeded();
    await expect(equations.locator('.katex').first()).toBeVisible();
    await page.waitForTimeout(300);
    const regions = await equations.locator('.eka-math').evaluateAll(elements => elements.map(element => ({
      overflow: element.scrollWidth > element.clientWidth + 1, flagged: element.hasAttribute('data-overflow'), tabindex: element.getAttribute('tabindex'), role: element.getAttribute('role'),
      label: (element.getRootNode() as ShadowRoot).getElementById(element.getAttribute('aria-labelledby') ?? '')?.textContent ?? '',
      hint: (element.getRootNode() as ShadowRoot).getElementById(element.getAttribute('aria-describedby') ?? '')?.textContent ?? '',
      plain: !!element.parentElement?.querySelector('[data-eka-plain]'),
    })));
    expect(regions.filter(region => region.overflow).length, 'some equations are wider than 320 px').toBeGreaterThan(0);
    for (const region of regions) {
      // No equation is cut off silently: each one fits, or it says so and offers its plain text.
      if (!region.overflow) continue;
      expect(region, region.label).toMatchObject({ flagged: true, tabindex: '0', role: 'group', plain: true });
      expect(region.label.length).toBeGreaterThan(0);
      expect(region.hint).toContain('scroll it sideways');
    }
    const wide = equations.locator('.eka-math[data-overflow]').first();
    await wide.focus();
    expect(await wide.evaluate(element => (element.getRootNode() as ShadowRoot).activeElement === element)).toBe(true);
    await page.keyboard.press('ArrowRight');
    await expect(equations.locator('.eka-math-hint').first()).toBeVisible();
    await expect(equations.locator('[data-eka-plain]').first()).toBeVisible();
    expect(await equations.locator('.eka-math .katex').first().evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(14);
    await shot(page, 'g51-lt-equations-320', equations);
    expect(errors).toEqual([]);
  });
});

test.describe('3D fallback wording (G54, report §11, §13)', () => {
  test('quadratic surface without WebGL: the fallback says what its table lists and what it summarises', async ({ page }) => {
    const errors = await openFixture(page, '?template=quadratic-surface-gradient&mode=free');
    const spatial = card(page).locator('[data-eka-spatial="surface-view"]');
    await spatial.scrollIntoViewIfNeeded();
    const note = spatial.locator('.eka-pending[data-state="spatial-fallback"]');
    await expect(note).toContainText('No 3D renderer is configured here.');
    await expect(note).not.toContainText('show the same values');
    await expect(note).toContainText('lists the positioned items and summarises the rest');
    const notes = spatial.locator('[data-eka-coordinate-notes] li');
    await expect(notes.first()).toContainText('is summarised, not listed point by point');
    await shot(page, 'g54-surface-fallback', spatial);
    expect(errors).toEqual([]);
  });
});

test.describe('capture failures (G70, report §19)', () => {
  test('a frame changed while the optional capture renderer loads is refused, then the current frame captures normally', async ({ page }) => {
    let release!: () => void;
    let requested!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const loading = new Promise<void>(resolve => { requested = resolve; });
    await page.route('**/capture-renderer.ts*', async route => { requested(); await held; await route.continue(); });
    const errors = await openFixture(page, '?template=function-derivative&mode=free');
    // Opening an ordinary activity must not request the capture implementation.
    const before = (await projection(page)).guards.expectedRunId;
    await page.evaluate(() => {
      (window as unknown as { pendingCapture: Promise<string> }).pendingCapture = window.studyHarnessFixture.capture('svg')
        .then(() => 'resolved', (error: { code?: string }) => error.code ?? 'unknown');
    });
    await loading;
    const slider = card(page).locator('.eka-slider:not([aria-disabled="true"])').first();
    await slider.focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await projection(page)).guards.expectedRunId).not.toBe(before);
    await settle(page);
    release();
    expect(await page.evaluate(() => (window as unknown as { pendingCapture: Promise<string> }).pendingCapture)).toBe('NOT_READY');
    const frameId = (await projection(page)).frame!.frameId;
    expect(await page.evaluate(async () => (await window.studyHarnessFixture.capture('svg')).metadata.frameId)).toBe(frameId);
    expect(errors).toEqual([]);
  });

  test('missing fonts fall back to system fonts; no 2D context, no PNG encoding and a failed decode reject cleanly and leave the card usable', async ({ page }) => {
    test.setTimeout(60_000);
    const errors = await openFixture(page, '?template=function-derivative&mode=free&fonts=bundled');
    const attempt = () => page.evaluate(async () => {
      try { const result = await window.studyHarnessFixture.capture('png'); return { ok: true as const, fonts: (result as { fonts?: string }).fonts, bytes: result.pngBase64?.length ?? 0, width: result.width }; }
      catch (error) { return { ok: false as const, code: (error as { code?: string }).code ?? null, message: (error as Error).message }; }
    });
    // Baseline: fonts are embedded.
    const baseline = await attempt();
    expect(baseline).toMatchObject({ ok: true, fonts: 'embedded' });

    // 1. Font files answer 404: the capture is still taken, with system fonts.
    await page.route('**/*.woff2', route => route.fulfill({ status: 404, body: '' }));
    const noFonts = await page.evaluate(async () => {
      const result = await window.studyHarnessFixture.capture('png');
      return { fonts: (result as { fonts?: string }).fonts, png: result.pngBase64 ?? '' };
    });
    expect(noFonts.fonts).toBe('system');
    expect(pngSize(noFonts.png).signature).toBe(true);
    await page.unroute('**/*.woff2');

    const stubs = {
      context: () => { const original = HTMLCanvasElement.prototype.getContext; (window as unknown as { restore: () => void }).restore = () => { HTMLCanvasElement.prototype.getContext = original; }; HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) { return kind === '2d' ? null : (original as (...args: unknown[]) => unknown).call(this, kind, ...rest); } as typeof original; },
      blob: () => { const original = HTMLCanvasElement.prototype.toBlob; (window as unknown as { restore: () => void }).restore = () => { HTMLCanvasElement.prototype.toBlob = original; }; HTMLCanvasElement.prototype.toBlob = function (callback: BlobCallback) { callback(null); }; },
      decode: () => { const original = HTMLImageElement.prototype.decode; (window as unknown as { restore: () => void }).restore = () => { HTMLImageElement.prototype.decode = original; }; HTMLImageElement.prototype.decode = () => Promise.reject(new DOMException('The source image cannot be decoded.', 'EncodingError')); },
    };
    for (const [name, code] of [['context', 'UNSUPPORTED_CAPABILITY'], ['blob', 'CAPTURE_REJECTED'], ['decode', 'CAPTURE_REJECTED']] as const) {
      await page.evaluate(`(${stubs[name].toString()})()`);
      const failed = await attempt();
      expect(failed, name).toEqual({ ok: false, code, message: expect.any(String) });
      expect(failed.ok ? '' : failed.message, name).not.toMatch(/at \w+ \(|DOMException/);
      await page.evaluate(() => (window as unknown as { restore: () => void }).restore());
      // The card is still usable: a control commits and the next capture succeeds.
      const before = (await projection(page)).guards.expectedRunId;
      const slider = card(page).locator('.eka-slider:not([aria-disabled="true"])').first();
      await slider.focus();
      await page.keyboard.press('ArrowRight');
      await expect.poll(async () => (await projection(page)).guards.expectedRunId, name).not.toBe(before);
      await settle(page);
      expect(await attempt(), `${name}: next capture`).toMatchObject({ ok: true });
    }
    // A tainted canvas behaves like a failed encoding: toBlob throws a SecurityError.
    await page.evaluate(() => { const original = HTMLCanvasElement.prototype.toBlob; (window as unknown as { restore: () => void }).restore = () => { HTMLCanvasElement.prototype.toBlob = original; }; HTMLCanvasElement.prototype.toBlob = () => { throw new DOMException('Tainted canvases may not be exported.', 'SecurityError'); }; });
    expect(await attempt()).toEqual({ ok: false, code: 'CAPTURE_REJECTED', message: expect.any(String) });
    await page.evaluate(() => (window as unknown as { restore: () => void }).restore());
    expect(await attempt()).toMatchObject({ ok: true });
    expect(errors).toEqual([]);
  });
});
