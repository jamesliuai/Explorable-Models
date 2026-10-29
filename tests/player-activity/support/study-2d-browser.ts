/**
 * BROWSER TEST SUPPORT (Playwright, not run by vitest) shared by tests/browser/study-function-derivative.spec.ts and
 * tests/browser/study-linear-transformation.spec.ts. They drive the generic flow of the integration fixture page
 * (`study-harness.html?template=<id>`): the fixture host, the real catalogue kernel module worker, the activity adapter
 * and the learner card in its shadow root. They run in Chromium (`npm run test:browser`) and in Firefox and WebKit
 * (`npm run test:cross-browser`); every result is a fixture-host Playwright result, not evidence about the Study Harness
 * host, a packaged WebView, Safari itself, assistive-technology use or learning benefit.
 */
import { mkdirSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';
import type { LearnerProjection, ProjectedValue } from '@experiment-kit/activity';
import { card, cardDom, control, focusKey, focused, projection, readCurrentValues, settle, tabTo, type FocusInfo } from '../../browser/support/study-harness';

export const SHOTS_2D = '/tmp/experiment-kit-playwright/study-2d';
mkdirSync(SHOTS_2D, { recursive: true });

/** Outcome of a generic driver call (`window.studyHarnessFixture.<call>`), read after the fixture settled. */
export interface DriverResult { ok: boolean; codes: string[]; message: string; stage: string | null; context: string | null }
type DriverCall = 'transition' | 'reveal' | 'authorizeExploration' | 'enterIndependent' | 'reopen' | 'close' | 'respond' | 'save';

/** Runs one generic host driver call and expects it to succeed (or returns the refusal with `expectOk: false`). */
export async function drive(page: Page, call: DriverCall, argument?: string, options: { expectOk?: boolean } = {}): Promise<DriverResult> {
  const result = await page.evaluate(([name, value]) => {
    const hooks = window.studyHarnessFixture as unknown as Record<string, (input?: string) => Promise<DriverResult>>;
    return hooks[name!]!(value ?? undefined);
  }, [call, argument ?? null] as const);
  if (options.expectOk !== false) expect(result, `${call}(${argument ?? ''}): ${result.message}`).toMatchObject({ ok: true });
  await settle(page);
  return result;
}

/** Waits for the card to show the binding's current projection and for the fixture to be quiet. */
export const quiet = (page: Page) => settle(page);

/** Full-card screenshot under SHOTS_2D (equations scrolled into view first so KaTeX output is in the picture). */
export async function shot(page: Page, name: string): Promise<void> {
  const equations = card(page).locator('[data-eka-panel="equations"]');
  if (await equations.count()) {
    await equations.last().scrollIntoViewIfNeeded();
    await expect(equations.last().locator('.katex').first()).toBeVisible();
  }
  if (await card(page).count()) await card(page).evaluate(host => host.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(100);
  await page.waitForFunction(() => window.studyHarnessFixture.binding?.getProjection().status.ui !== 'suspended');
  await page.screenshot({ path: `${SHOTS_2D}/${name}.png`, fullPage: true });
}

/** Projected value by quantity ID. */
export const valueOf = (projected: LearnerProjection, id: string): ProjectedValue | undefined =>
  projected.views.flatMap(view => view.values).find(value => value.quantityId === id);
/** Text of the rendered value row of a quantity (`dd` cells joined), or null when the row is absent. */
export async function rowText(page: Page, quantityId: string): Promise<string | null> {
  const row = card(page).locator(`[data-eka-panel="values"] .eka-value-row[data-quantity="${quantityId}"]`);
  if (!await row.count()) return null;
  return ((await row.first().locator('dd').allTextContents()).join(' ')).replace(/\s+/g, ' ').trim();
}
/** Rendered plain-text equations (the plain form, shown while KaTeX loads or with “Plain text”). */
export async function equationTexts(page: Page): Promise<string[]> {
  return projection(page).then(projected => projected.views.flatMap(view => view.equations).map(equation => `${equation.label}: ${equation.plain}`));
}
/** Number from learner text (U+2212 minus, digit grouping). */
export const num = (text: string): number => Number(text.replace(/−/g, '-').replace(/,/g, '').replace(/[^0-9eE.+-]/g, ''));

/**
 * Content is absent from every learner channel: card DOM (HTML and text, including screen-reader-only text), the
 * accessibility tree, the value rows, the read-out text and an SVG capture (image, companion text and metadata).
 */
export async function expectAbsent(page: Page, markers: readonly string[], label: string, options: { capture?: boolean; quantities?: readonly string[] } = {}): Promise<void> {
  const dom = await cardDom(page);
  const aria = await page.locator('[data-fx-card]').ariaSnapshot();
  const readOut = await readCurrentValues(page);
  for (const marker of markers) {
    expect(dom.html, `${label}: card HTML contains ${marker}`).not.toContain(marker);
    expect(aria, `${label}: accessibility tree contains ${marker}`).not.toContain(marker);
    expect(readOut, `${label}: read-out contains ${marker}`).not.toContain(marker);
  }
  for (const id of options.quantities ?? []) expect(await rowText(page, id), `${label}: value row ${id}`).toBeNull();
  if (options.capture !== false) {
    const capture = await page.evaluate(() => window.studyHarnessFixture.capture('svg'));
    const blob = `${capture.svg}\n${capture.companionText}\n${JSON.stringify(capture.metadata)}`;
    for (const marker of markers) expect(blob, `${label}: capture contains ${marker}`).not.toContain(marker);
  }
}
/** Content is present in the card DOM and the accessibility tree. */
export async function expectPresent(page: Page, markers: readonly string[], label: string): Promise<void> {
  const dom = await cardDom(page);
  const aria = await page.locator('[data-fx-card]').ariaSnapshot();
  for (const marker of markers) {
    expect(dom.text, `${label}: card text lacks ${marker}`).toContain(marker);
    expect(aria, `${label}: accessibility tree lacks ${marker}`).toContain(marker);
  }
}

/** Exact entry of one control in display units; resolves after the committed run (or returns the shown error). */
export async function exact(page: Page, parameter: string, value: string, options: { expectError?: boolean } = {}): Promise<string | null> {
  const box = control(page, parameter).getByRole('textbox');
  const error = control(page, parameter).locator('.eka-error');
  const previous = await error.count() ? (await error.textContent())?.trim() ?? '' : null;
  await box.fill(value);
  await box.press('Enter');
  if (options.expectError) {
    await expect(error).toBeVisible();
    // A new explanation replaces any earlier one (the same text twice would mean nothing new was checked).
    await expect.poll(async () => (await error.textContent())?.trim()).not.toBe(previous);
    return (await error.textContent())?.trim() ?? '';
  }
  await expect.poll(async () => (await projection(page)).controls.find(item => item.parameter === parameter)?.value).toBe(Number(value.replace('−', '-')));
  await settle(page);
  return null;
}
/** Applies a scenario through its button in the card. */
export async function scenario(page: Page, label: string): Promise<void> {
  const before = (await projection(page)).guards.expectedRunId;
  await card(page).getByRole('button', { name: label, exact: true }).click();
  await expect.poll(async () => (await projection(page)).guards.expectedRunId).not.toBe(before);
  await settle(page);
}

/** Keyboard-only helpers: host buttons, in-card controls and the composer in the card's response slot. */
export const inCard = (name: string | RegExp, tag?: string) => (info: FocusInfo) => info.inCard && (!tag || info.tag === tag) && (typeof name === 'string' ? info.name === name : name.test(info.name));
/**
 * Moves keyboard focus with the focus key (Tab; Option-Tab in WebKit on macOS, see `focusKey`) to the host button
 * `[attribute="value"]` and presses Enter; waits for the host round trip.
 */
export async function pressHost(page: Page, attribute: string, value: string): Promise<void> {
  await tabTo(page, info => info.data[attribute] === value, `the host button ${attribute}=${value}`, { max: 250 });
  const lastResult = () => page.evaluate(() => (window.studyHarnessFixture as unknown as { session: { getSnapshot(): { lastResult: string } } }).session.getSnapshot().lastResult);
  const before = await lastResult();
  await page.keyboard.press('Enter');
  // The driver reports `<label>…` while it runs and `<label>: …` once the host round trip settled.
  await page.waitForFunction(previous => {
    const current = (window.studyHarnessFixture as unknown as { session: { getSnapshot(): { busy: string | null; lastResult: string } } }).session.getSnapshot();
    return current.busy === null && current.lastResult !== previous && !current.lastResult.endsWith('…');
  }, before);
  await settle(page);
}
export async function respondByKeyboard(page: Page, text: string): Promise<void> {
  await tabTo(page, info => info.id === 'fx-response', 'the host composer in the card');
  await page.keyboard.type(text);
  await page.keyboard.press(focusKey(page));
  expect((await focused(page))?.name).toMatch(/^Submit /);
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-fx-composer]')).toHaveCount(0);
  await settle(page);
}

/** Starts counting pointer input (a keyboard-only run must end with zero). */
export async function countPointer(page: Page): Promise<() => Promise<number>> {
  await page.evaluate(() => {
    const count = { pointer: 0 };
    (window as unknown as { fxPointer: typeof count }).fxPointer = count;
    for (const type of ['pointerdown', 'mousedown', 'click']) document.addEventListener(type, event => { if ((event as MouseEvent).detail > 0 || type !== 'click') count.pointer++; }, { capture: true });
  });
  return () => page.evaluate(() => (window as unknown as { fxPointer: { pointer: number } }).fxPointer.pointer);
}

/** Rendered SVG facts of one view: path data per primitive class and the label texts drawn on the plot. */
export async function drawnView(page: Page, viewId: string): Promise<{ labels: string[]; notes: string[]; arrows: { shaft: string; head: boolean; role: string }[]; dots: number }> {
  return card(page).locator(`figure[data-eka-figure="${viewId}"]`).evaluate(figure => ({
    // A wrapped label is one text element with one tspan per line.
    labels: [...figure.querySelectorAll('.eka-labels text')].map(text => [...text.querySelectorAll('tspan')].map(line => line.textContent ?? '').join(' ') || (text.textContent ?? '')),
    notes: [...figure.querySelectorAll('.eka-notes li')].map(item => item.textContent ?? ''),
    arrows: [...figure.querySelectorAll('.eka-marks g.eka-stroke')].map(group => ({ shaft: group.querySelector('path')?.getAttribute('d') ?? '', head: group.querySelectorAll('path').length > 1, role: [...group.classList].find(name => name.startsWith('eka-role-')) ?? '' })),
    dots: figure.querySelectorAll('.eka-marks path.eka-fill, .eka-marks path.eka-hollow').length,
  }));
}
