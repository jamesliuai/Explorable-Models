/**
 * Interaction edge cases of the learner card in a real browser (report §9, §10.2, §10.4, §11; A33, A36, A39–A43):
 * gestures ended by the host, pressing again during a slow commit, worker-failure recovery, the disposed state,
 * Reset experiment, inert states, focus restoration, the announcement policy, lost pointer capture, touch scrolling,
 * IME composition, blur, rapid scenario switching and draggable points. Each test asserts the host journal.
 *
 * Evidence scope: Playwright Chromium (`npm run test:browser`), Firefox and WebKit (`npm run test:cross-browser`) with the
 * integration-fixture host (`study-harness.html`). These are fixture-host
 * results; they say nothing about the Study Harness host, a packaged WebView, assistive-technology use or learning.
 */
import { expect, test, type Page } from '@playwright/test';
import type { InteractionEvent, LearnerProjection } from '@experiment-kit/activity';
import { card, control, expectAccessible, focused, hostEvents, hostExposures, openFixture, projection, renderedFrameIds, respond, settle, step } from './support/study-harness';
import { drive } from '../player-activity/support/study-2d-browser';

/** Fixture hooks used here beyond the shared helper's declaration (read inside `page.evaluate` through `W`). */
type Fixture = typeof window.studyHarnessFixture & {
  adapter: { dispose(id?: string): void };
  prepared: { activityId: string; host: { suspend(input: { operationId: string; reason: string }): unknown; resume(input: { operationId: string }): unknown } } | null;
  workerFaults: { drop: number; dropped: number };
  diagnostics: { code: string; message: string }[];
};
type W = { studyHarnessFixture: Fixture };
type ProjectionLab = { __lab: { binding: { getProjection(): LearnerProjection; publish(change: (p: LearnerProjection) => LearnerProjection): unknown } } };
const payloads = (events: InteractionEvent[], type: string) => events.filter(event => event.type === type).map(event => event.payload as Record<string, unknown>);
const since = async (page: Page, mark: number) => (await hostEvents(page)).slice(mark);
const ui = (page: Page) => card(page).locator('.eka');
const current = (page: Page, parameter: string) => projection(page).then(p => p.controls.find(item => item.parameter === parameter)!.value);

test('R14 graph dragging converts canonical metre displacements to centimetre control values on both axes', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/examples/study-harness-host/projection-lab.html?fixture=geometry&width=960');
  const surface = page.locator('#lab-surface [data-experiment-kit-activity]');
  await expect(surface.locator('.eka')).toHaveAttribute('data-eka-ui-state', 'ready');
  // This is a renderer fixture: supply a consistent learner projection in centimetres while its drawing stays in
  // canonical metres. Its binding echoes commands, so the assertions measure the renderer's actual command values.
  await page.evaluate(() => (window as unknown as ProjectionLab).__lab.binding.publish(p => ({
    ...p,
    controls: p.controls.map(c => ({ ...c, value: c.value * 100, min: c.min * 100, max: c.max * 100, step: c.step * 100, displayUnit: 'cm', unitLabel: 'cm' })),
    views: p.views.map(v => ({ ...v, marks: v.marks.map(m => m.draggable ? { ...m, draggable: Object.fromEntries(Object.entries(m.draggable).map(([axis, ref]) => [axis, { ...ref, min: ref.min * 100, max: ref.max * 100 }])) } : m) })),
  })));
  const handle = surface.locator('[data-draggable="true"]').first();
  await handle.scrollIntoViewIfNeeded();
  const position = await handle.locator('circle.eka-hit').boundingBox();
  expect(position).not.toBeNull();
  const scale = await surface.locator('figure').first().evaluate(figure => {
    const spacing = (anchor: string, coordinate: 'x' | 'y') => {
      const ticks = [...figure.querySelectorAll<SVGTextElement>(`text.eka-tick[text-anchor="${anchor}"]`)].map(tick => {
        const rect = tick.getBoundingClientRect();
        return { value: Number((tick.textContent ?? '').replace('−', '-')), pixel: coordinate === 'x' ? rect.x + rect.width / 2 : rect.y + rect.height / 2 };
      });
      return Math.abs((ticks[1]!.pixel - ticks[0]!.pixel) / (ticks[1]!.value - ticks[0]!.value));
    };
    return { x: spacing('middle', 'x'), y: spacing('end', 'y') };
  });
  const x = position!.x + position!.width / 2, y = position!.y + position!.height / 2;
  const values = () => page.evaluate(() => (window as unknown as ProjectionLab).__lab.binding.getProjection().controls.map(c => ({ parameter: c.parameter, value: c.previewValue ?? c.value })));
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + scale.x, y, { steps: 4 });
  await expect.poll(values).toEqual([{ parameter: 'px', value: -150 }, { parameter: 'py', value: 150 }]);
  await page.mouse.move(x + scale.x, y - scale.y / 2, { steps: 4 });
  await expect.poll(values).toEqual([{ parameter: 'px', value: -150 }, { parameter: 'py', value: 200 }]);
  await page.mouse.up();
  await expect(surface.locator('.eka')).toHaveAttribute('data-eka-ui-state', 'ready');
  await expect.poll(values).toEqual([{ parameter: 'px', value: -150 }, { parameter: 'py', value: 200 }]);
  await handle.press('ArrowRight');
  await expect.poll(values).toEqual([{ parameter: 'px', value: -140 }, { parameter: 'py', value: 200 }]);
  expect(errors).toEqual([]);
});

/** Prediction → step-size exploration enabled → trace revealed and displayed (quadratic explore-step). */
async function toRevealedTrace(page: Page): Promise<void> {
  await respond(page, 'Small steps shrink the positions; larger ones overshoot and may grow.');
  await step(page, 'enable-exploration');
  await step(page, 'reveal-trace');
}
/** Screen position of a value on a range slider (thumb inset 8 px). */
async function sliderAt(page: Page, parameter: string) {
  const p = await projection(page);
  const spec = p.controls.find(item => item.parameter === parameter)!;
  const slider = control(page, parameter).getByRole('slider');
  await slider.scrollIntoViewIfNeeded();
  const box = (await slider.boundingBox())!;
  return { slider, y: box.y + box.height / 2, at: (value: number) => box.x + 8 + (box.width - 16) * (value - spec.min) / (spec.max - spec.min) };
}
/** Records the pointer ID of every pointerdown inside the card (for lost-capture and pointercancel dispatch). */
async function trackPointer(page: Page): Promise<void> {
  await page.evaluate(() => {
    const root = document.querySelector('[data-fx-card] [data-experiment-kit-activity]')!.shadowRoot!;
    root.addEventListener('pointerdown', event => { (window as unknown as { fxPointer: number }).fxPointer = (event as PointerEvent).pointerId; }, { capture: true });
  });
}
/**
 * Loses pointer capture on the element under `selector`: when it holds the capture, releasing it makes the browser fire
 * a real `lostpointercapture`; a native range input takes no explicit capture (Firefox and WebKit then report none), so
 * for it the same event is dispatched where the element holds none. Returns which path was taken. A released capture is
 * reported before the next pointer event is dispatched (Pointer Events, "process pending pointer capture"): Chromium
 * reports it at once, Firefox and WebKit with the next pointer move, so callers move the pointer before expecting it.
 */
async function loseCapture(page: Page, selector: string): Promise<'released' | 'dispatched'> {
  return page.evaluate(css => {
    const root = document.querySelector('[data-fx-card] [data-experiment-kit-activity]')!.shadowRoot!;
    const element = root.querySelector(css)!;
    const id = (window as unknown as { fxPointer: number }).fxPointer;
    if (element.hasPointerCapture(id)) { element.releasePointerCapture(id); return 'released' as const; }
    element.dispatchEvent(new PointerEvent('lostpointercapture', { pointerId: id, bubbles: true, composed: true, isPrimary: true, pointerType: 'mouse' }));
    return 'dispatched' as const;
  }, selector);
}
/**
 * Records every text the card's polite live region shows from now on (`since(mark)`: the non-empty texts after `mark`,
 * trimmed; `now()`: the current page time).
 */
async function recordLive(page: Page): Promise<{ now(): Promise<number>; since(mark: number): Promise<string[]> }> {
  await page.evaluate(() => {
    const live = document.querySelector('[data-fx-card] [data-experiment-kit-activity]')!.shadowRoot!.querySelector('.eka-sr[role=status][aria-live=polite]')!;
    const log: { at: number; text: string }[] = [];
    (window as unknown as { fxLiveLog: typeof log }).fxLiveLog = log;
    new MutationObserver(() => log.push({ at: performance.now(), text: live.textContent ?? '' })).observe(live, { childList: true, characterData: true, subtree: true });
  });
  return {
    now: () => page.evaluate(() => performance.now()),
    since: mark => page.evaluate(at => (window as unknown as { fxLiveLog: { at: number; text: string }[] }).fxLiveLog.filter(entry => entry.at >= at && entry.text.trim()).map(entry => entry.text.trim()), mark),
  };
}
const bindingErrors = (page: Page) => page.evaluate(() => (window as unknown as W).studyHarnessFixture.diagnostics.filter(item => item.code !== 'CLIPPED' && item.code !== 'LABEL_OVERLAP').map(item => item.code));
const tentative = (page: Page) => page.waitForFunction(() => window.studyHarnessFixture.binding!.getProjection().frame?.kind === 'tentative');
const handle = (page: Page, figure: string) => card(page).locator(`figure[data-eka-figure="${figure}"] [data-draggable="true"]`).first();
async function handleCenter(page: Page, figure: string): Promise<{ x: number; y: number }> {
  const target = handle(page, figure);
  await target.scrollIntoViewIfNeeded();
  const box = (await target.locator('circle.eka-hit').boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test.describe('interaction edge cases (report §9–§11)', () => {
  test('G24 quadratic: a host stage change mid-drag cancels the preview (navigation); moving on and releasing commits nothing', async ({ page }) => {
    const errors = await openFixture(page);
    await toRevealedTrace(page);
    const before = await projection(page);
    const mark = (await hostEvents(page)).length;
    const { slider, at, y } = await sliderAt(page, 'eta');
    await page.mouse.move(at(0.25), y);
    await page.mouse.down();
    await page.mouse.move(at(0.7), y, { steps: 4 });
    await tentative(page);
    // The host adds the curvature control while the pointer is still down.
    await page.evaluate(() => { void (window as unknown as W).studyHarnessFixture.session.runStep('add-curvature'); });
    await page.waitForFunction(() => window.studyHarnessFixture.binding!.getProjection().stage.id === 'explore-curvature');
    await settle(page, { allowPending: true });
    await page.mouse.move(at(1.1), y, { steps: 4 });
    // The held slider shows the committed value again; the still-pressed pointer changes nothing.
    expect(Number(await slider.inputValue())).toBe(0.25);
    await page.mouse.up();
    await page.waitForTimeout(400);
    await settle(page);
    const events = await since(page, mark);
    expect(payloads(events, 'preview.cancelled').map(p => p.reason)).toEqual(['navigation']);
    expect(payloads(events, 'parameters.committed')).toEqual([]);
    const after = await projection(page);
    expect(after.guards.expectedRunId).toBe(before.guards.expectedRunId);
    expect(after.controls.find(item => item.parameter === 'eta')!.value).toBe(0.25);
    expect(await bindingErrors(page)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('G24 function-derivative: a host stage change and a revoked policy mid-drag of P cancel the preview; release commits nothing', async ({ page }) => {
    const errors = await openFixture(page, '?template=function-derivative');
    await drive(page, 'transition', 'predict');
    await respond(page, 'The slope of the curve at P is negative.');
    await drive(page, 'transition', 'explore-slope');
    await drive(page, 'authorizeExploration');
    const before = await projection(page);
    let mark = (await hostEvents(page)).length;
    let at = await handleCenter(page, 'function-plot');
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.move(at.x + 40, at.y, { steps: 4 });
    await tentative(page);
    await page.evaluate(() => { void ((window as unknown as W).studyHarnessFixture as unknown as { transition(stage: string): Promise<unknown> }).transition('explore-derivative'); });
    await page.waitForFunction(() => window.studyHarnessFixture.binding!.getProjection().stage.id === 'explore-derivative');
    await page.mouse.move(at.x + 90, at.y, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    await settle(page);
    let events = await since(page, mark);
    expect(payloads(events, 'preview.cancelled').map(p => p.reason)).toEqual(['navigation']);
    expect(payloads(events, 'parameters.committed')).toEqual([]);
    expect((await projection(page)).guards.expectedRunId).toBe(before.guards.expectedRunId);
    expect(await current(page, 'p')).toBe(-1);

    await drive(page, 'authorizeExploration');
    mark = (await hostEvents(page)).length;
    at = await handleCenter(page, 'function-plot');
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.move(at.x + 40, at.y, { steps: 4 });
    await tentative(page);
    await page.evaluate(() => (window as unknown as W).studyHarnessFixture.session.revokePolicy());
    await page.mouse.move(at.x + 80, at.y, { steps: 3 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    events = await since(page, mark);
    expect(payloads(events, 'preview.cancelled').map(p => p.reason)).toEqual(['revoked']);
    expect(payloads(events, 'parameters.committed')).toEqual([]);
    // No pointer or drag gesture has ever been recorded as exact entry.
    expect(payloads(await hostEvents(page), 'parameters.committed').filter(p => p.gesture === 'exact' && p.previewId)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('F4 slow evaluator: pressing again while the previous release commits follows the pointer throughout, previews from the new run and commits once as a pointer gesture', async ({ page }) => {
    test.setTimeout(90_000);
    const errors = await openFixture(page, '?workerDelay=600');
    await toRevealedTrace(page);
    const start = await projection(page);
    const mark = (await hostEvents(page)).length;
    const { slider, at, y } = await sliderAt(page, 'eta');
    await page.mouse.move(at(0.25), y);
    await page.mouse.down();
    await page.mouse.move(at(0.6), y, { steps: 4 });
    await tentative(page);
    const first = Number(await slider.inputValue());
    await page.mouse.up();
    // The first release is committing (one evaluation at 600 ms) when the pointer goes down again.
    expect((await projection(page)).guards.expectedRunId).toBe(start.guards.expectedRunId);
    await page.mouse.down();
    const seen: number[] = [];
    for (const target of [0.75, 0.9, 1.05, 1.2]) {
      await page.mouse.move(at(target), y, { steps: 2 });
      seen.push(Number(await slider.inputValue()));
    }
    // The slider followed the pointer at every step.
    for (const [index, target] of [0.75, 0.9, 1.05, 1.2].entries()) expect(Math.abs(seen[index]! - target), `step ${index}`).toBeLessThan(0.051);
    const held = seen.at(-1)!;
    // The first commit lands while the pointer is still down: the held value stays (it used to jump back).
    await page.waitForFunction(run => window.studyHarnessFixture.binding!.getProjection().guards.expectedRunId !== run, start.guards.expectedRunId);
    for (let sample = 0; sample < 6; sample++) { expect(Number(await slider.inputValue())).toBe(held); await page.waitForTimeout(40); }
    // The live preview starts from the new run and shows the held value.
    await page.waitForFunction(value => {
      const p = window.studyHarnessFixture.binding!.getProjection();
      return p.frame?.kind === 'tentative' && p.controls.find(item => item.parameter === 'eta')?.previewValue === value;
    }, held, { timeout: 10_000 });
    expect(Number(await slider.inputValue())).toBe(held);
    await page.mouse.up();
    await page.waitForFunction(value => {
      const p = window.studyHarnessFixture.binding!.getProjection();
      return p.frame?.kind === 'committed' && p.controls.find(item => item.parameter === 'eta')?.value === value;
    }, held, { timeout: 10_000 });
    await settle(page);
    const events = await since(page, mark);
    const started = payloads(events, 'preview.started');
    const commits = payloads(events, 'parameters.committed');
    expect(commits.map(p => [p.gesture, (p.params as Record<string, number>).eta])).toEqual([['pointer', first], ['pointer', held]]);
    expect(commits.map(p => p.previewId)).toEqual(started.map(p => p.previewId));
    expect(started[1]!.baseRunId).toBe(commits[0]!.runId);
    expect(payloads(events, 'preview.cancelled')).toEqual([]);
    expect(await bindingErrors(page)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('G38 worker timeout: the previous frame stays shown, and one Try again re-runs the failed step to the requested index', async ({ page }) => {
    test.setTimeout(60_000);
    const errors = await openFixture(page);
    await toRevealedTrace(page);
    const before = await projection(page);
    const mark = (await hostEvents(page)).length;
    await page.evaluate(() => { (window as unknown as W).studyHarnessFixture.workerFaults.drop = 1; });
    await card(page).getByRole('button', { name: 'Next iteration' }).click();
    await expect(ui(page)).toHaveAttribute('data-eka-ui-state', 'recoverable-failure', { timeout: 9_000 });
    expect(await page.evaluate(() => (window as unknown as W).studyHarnessFixture.workerFaults.dropped)).toBe(1);
    const failed = await projection(page);
    expect(failed.frame).toMatchObject({ frameId: before.frame!.frameId, kind: 'committed', position: { index: 0 } });
    expect(new Set((await renderedFrameIds(page)).map(item => item.frameId))).toEqual(new Set([before.frame!.frameId]));
    await expectAccessible(page, 'recoverable failure');
    await card(page).getByRole('button', { name: 'Try again' }).first().click();
    await expect(ui(page)).toHaveAttribute('data-eka-ui-state', 'paused');
    await settle(page);
    const after = await projection(page);
    expect(after.navigation?.value).toBe(1);
    expect(after.frame).toMatchObject({ kind: 'committed', position: { index: 1 } });
    expect(after.guards.expectedRunId).toBe(before.guards.expectedRunId);
    expect(new Set((await renderedFrameIds(page)).map(item => item.frameId))).toEqual(new Set([after.frame!.frameId]));
    const moves = payloads(await since(page, mark), 'position.changed');
    expect(moves.map(p => [(p.from as { index: number }).index, (p.to as { index: number }).index])).toEqual([[0, 1]]);
    await expect(card(page).getByRole('button', { name: 'Try again' })).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('G39/G48 disposing a mounted activity renders the disposed state at once, with no figures or controls, and focus moves to the card heading', async ({ page }) => {
    const errors = await openFixture(page);
    await toRevealedTrace(page);
    await card(page).getByRole('button', { name: 'Next iteration' }).focus();
    const timing = await page.evaluate(() => new Promise<{ logged: string | undefined; elapsed: number }>(resolve => {
      const root = document.querySelector('[data-fx-card] [data-experiment-kit-activity]')!.shadowRoot!.querySelector<HTMLElement>('.eka')!;
      let started = 0;
      const observer = new MutationObserver(() => {
        if (root.dataset.ekaUiState !== 'disposed') return;
        observer.disconnect();
        resolve({ logged: (window as unknown as W).studyHarnessFixture.projectionLog.at(-1)?.ui, elapsed: performance.now() - started });
      });
      observer.observe(root, { attributes: true, attributeFilter: ['data-eka-ui-state'] });
      started = performance.now();
      (window as unknown as W).studyHarnessFixture.adapter.dispose((window as unknown as W).studyHarnessFixture.prepared!.activityId);
    }));
    // The binding notified the surface synchronously; React rendered it in the next task.
    expect(timing.logged).toBe('disposed');
    expect(timing.elapsed).toBeLessThan(250);
    await expect(card(page).locator('figure')).toHaveCount(0);
    await expect(card(page).locator('input, select, [data-draggable]')).toHaveCount(0);
    await expect(card(page).getByRole('button', { name: /Next iteration|Reset experiment|Keep this run|Read current values/ })).toHaveCount(0);
    await expect(card(page).locator('.eka-banner').first()).toContainText(/This activity has (ended|been closed)/);
    const focus = await focused(page);
    expect(focus).toMatchObject({ tag: expect.stringMatching(/^h[2-6]$/), inCard: true, name: (await projection(page)).title });
    await expectAccessible(page, 'disposed');
    expect(errors).toEqual([]);
  });

  test('G26 Reset experiment starts a new run from the starting values; Restart keeps the run; Reset view changes only the presentation; each works by keyboard', async ({ page }) => {
    const errors = await openFixture(page);
    await toRevealedTrace(page);
    const initial = await projection(page);
    const box = control(page, 'eta').getByRole('textbox');
    await box.fill('0.5');
    await box.press('Enter');
    await expect.poll(() => current(page, 'eta')).toBe(0.5);
    const goto = card(page).getByRole('textbox', { name: 'Go to n =' });
    await goto.fill('5');
    await goto.press('Enter');
    await expect.poll(async () => (await projection(page)).navigation?.value).toBe(5);
    await settle(page);
    const changed = await projection(page);
    const exposuresBefore = await hostExposures(page);
    const mark = (await hostEvents(page)).length;

    // Restart (keyboard): same run and parameters, back to n = 0.
    await card(page).getByRole('button', { name: /Restart/ }).focus();
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await projection(page)).navigation?.value).toBe(0);
    await settle(page);
    const restarted = await projection(page);
    expect(restarted.guards.expectedRunId).toBe(changed.guards.expectedRunId);
    expect(restarted.controls.find(item => item.parameter === 'eta')!.value).toBe(0.5);

    // Reset view (keyboard): presentation only.
    await card(page).getByRole('button', { name: 'Zoom in' }).first().click();
    await settle(page);
    const zoomed = await projection(page);
    await card(page).getByRole('button', { name: 'Reset view' }).first().focus();
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await projection(page)).presentationRevision).toBeGreaterThan(zoomed.presentationRevision);
    await settle(page);
    const viewReset = await projection(page);
    expect(viewReset.guards).toEqual(zoomed.guards);
    expect(viewReset.frame!.frameId).toBe(zoomed.frame!.frameId);

    // Reset experiment (keyboard): a new run at n = 0 from the starting values.
    const resetButton = card(page).getByRole('button', { name: 'Reset experiment' });
    await expect(resetButton).toBeVisible();
    await expectAccessible(page, 'reset experiment offered');
    const beforeReset = await projection(page);
    const earlier = (await hostEvents(page)).map(event => event.eventId);
    const resetMark = earlier.length;
    await resetButton.focus();
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await projection(page)).guards.expectedRunId).not.toBe(beforeReset.guards.expectedRunId);
    await settle(page);
    const reset = await projection(page);
    expect(reset.navigation?.value).toBe(0);
    expect(reset.controls.map(item => [item.parameter, item.value])).toEqual(initial.controls.map(item => [item.parameter, item.value]));
    const resetEvents = await since(page, resetMark);
    expect(payloads(resetEvents, 'parameters.committed')).toEqual([expect.objectContaining({ cause: 'reset', previousRunId: beforeReset.guards.expectedRunId })]);
    // History stays: earlier events and every exposure record remain.
    const all = await hostEvents(page);
    expect(all.slice(0, resetMark).map(event => event.eventId)).toEqual(earlier);
    expect(all.length).toBeGreaterThan(mark);
    expect(payloads(all, 'parameters.committed').some(p => p.cause === 'commit' && (p.params as Record<string, number>).eta === 0.5)).toBe(true);
    const exposuresAfter = await hostExposures(page);
    for (const record of exposuresBefore) expect(exposuresAfter.find(item => item.exposureId === record.exposureId)?.displayStatus).toBe(record.displayStatus);
    expect(errors).toEqual([]);
  });

  test('G43 host suspension and stale policy: every scientific action is aria-disabled with a visible reason and nothing offered fails', async ({ page }) => {
    const errors = await openFixture(page);
    await toRevealedTrace(page);
    // Disabled navigation buttons expose their reason programmatically.
    const back = card(page).getByRole('button', { name: 'Back one iteration' });
    await expect(back).toHaveAttribute('aria-disabled', 'true');
    await expect(back).toHaveAccessibleDescription(/already at the start \(n = 0\)/);
    // Being at n = 0 is read from the position readout; its reason is announced, not shown, so the panel keeps its height (G40).
    await expect(card(page).locator('.eka-position')).toHaveText('n = 0 of 1000');
    const before = await projection(page);
    const mark = (await hostEvents(page)).length;

    await page.evaluate(() => (window as unknown as W).studyHarnessFixture.prepared!.host.suspend({ operationId: 'fx-test-suspend', reason: 'host' }));
    await expect(ui(page)).toHaveAttribute('data-eka-ui-state', 'suspended');
    const scientific = card(page).locator('input[type=range], .eka-control input.eka-input, .eka-control button, .eka-scenarios button, .eka-nav button, [data-eka-action="reset-experiment"] button');
    const count = await scientific.count();
    expect(count).toBeGreaterThan(10);
    for (let index = 0; index < count; index++) await expect(scientific.nth(index), `control ${index}`).toHaveAttribute('aria-disabled', 'true');
    await expect(control(page, 'eta').locator('.eka-reason')).toContainText('Paused by the host.');
    await expect(card(page).getByRole('button', { name: 'Next iteration' })).toHaveAccessibleDescription(/Paused by the host/);
    await expect(card(page).getByRole('button', { name: 'Reset experiment' })).toHaveAccessibleDescription(/Paused by the host/);
    await expect(card(page).getByRole('button', { name: /Keep this run/ })).toHaveCount(0);
    // Trying anyway changes nothing and shows no "not applied" error.
    // (Playwright treats aria-disabled as not actionable, so the attempts are forced like a determined learner's.)
    const slider = control(page, 'eta').getByRole('slider');
    await slider.focus();
    await page.keyboard.press('ArrowRight');
    await card(page).getByRole('button', { name: 'Next iteration' }).click({ force: true });
    await card(page).locator('.eka-scenarios button').nth(1).click({ force: true });
    await card(page).getByRole('button', { name: 'Reset experiment' }).click({ force: true });
    await page.waitForTimeout(300);
    const suspended = await projection(page);
    expect(suspended.guards).toEqual(before.guards);
    expect(await bindingErrors(page)).toEqual([]);
    await expect(card(page).getByText('That change was not applied')).toHaveCount(0);
    await expectAccessible(page, 'host suspension');

    await page.evaluate(() => (window as unknown as W).studyHarnessFixture.prepared!.host.resume({ operationId: 'fx-test-resume' }));
    await expect(ui(page)).not.toHaveAttribute('data-eka-ui-state', 'suspended');
    await expect(slider).not.toHaveAttribute('aria-disabled', 'true');
    await expect(card(page).getByRole('button', { name: /Keep this run/ })).toHaveCount(1);

    await page.evaluate(() => (window as unknown as W).studyHarnessFixture.session.revokePolicy());
    await expect(ui(page)).toHaveAttribute('data-eka-ui-state', 'stale-policy');
    await expect(card(page).locator('.eka-instruction')).toHaveText('This activity is waiting for the host. Nothing new is shown until the permissions are updated.');
    await expect(card(page).locator('input[type=range], .eka-scenarios button, [data-eka-action="reset-experiment"]')).toHaveCount(0);
    await expect(card(page).getByRole('button', { name: /Keep this run/ })).toHaveCount(0);
    // A blocked card shows nothing to navigate and nothing that invites work it cannot accept (S4, report §10.4).
    await expect(card(page).locator('.eka-nav')).toHaveCount(0);
    await expect(card(page).locator('.eka-pending')).toHaveCount(0);
    expect(payloads(await since(page, mark), 'parameters.committed')).toEqual([]);
    expect(await bindingErrors(page)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('S4 a stale policy in a prompting stage: the prompt and the teaching instruction are withdrawn; one banner, one neutral line, nothing to navigate', async ({ page }) => {
    const errors = await openFixture(page);
    const before = await projection(page);
    expect(before.stage.response?.prompt).toBeTruthy();
    await expect(card(page).locator('.eka-response .eka-panel-title')).toHaveText(before.stage.response!.prompt);
    await page.evaluate(() => (window as unknown as W).studyHarnessFixture.session.revokePolicy());
    await expect(ui(page)).toHaveAttribute('data-eka-ui-state', 'stale-policy');
    await expect(card(page).locator('.eka-banner')).toHaveCount(1);
    await expect(card(page).locator('.eka-banner .eka-banner-title')).toHaveText('Permissions changed');
    await expect(card(page).locator('.eka-instruction')).toHaveText('This activity is waiting for the host. Nothing new is shown until the permissions are updated.');
    // The host's own response area (its slot) is the host's; the activity's prompt inviting a response is gone.
    await expect(card(page).locator('.eka-response .eka-panel-title')).toHaveCount(0);
    const text = (await card(page).textContent()) ?? '';
    expect(text).not.toContain(before.stage.response!.prompt);
    expect(text).not.toContain(before.stage.instruction);
    await expect(card(page).locator('.eka-nav, .eka-pending, figure, input[type=range]')).toHaveCount(0);
    expect((await projection(page)).stage.response).toBeUndefined();
    await expectAccessible(page, 'stale policy in a prompting stage');
    expect(errors).toEqual([]);
  });

  test('G48 focus restoration: a slider removed by a revoked policy hands focus to the stage instruction', async ({ page }) => {
    const errors = await openFixture(page);
    await toRevealedTrace(page);
    await control(page, 'eta').getByRole('slider').focus();
    expect(await focused(page)).toMatchObject({ tag: 'input', type: 'range', inCard: true });
    await page.evaluate(() => (window as unknown as W).studyHarnessFixture.session.revokePolicy());
    await expect(ui(page)).toHaveAttribute('data-eka-ui-state', 'stale-policy');
    await expect.poll(() => focused(page)).toMatchObject({ tag: 'p', inCard: true, name: 'This activity is waiting for the host. Nothing new is shown until the permissions are updated.' });
    // Into a contentless state: the instruction goes as well, so focus moves on to the card heading.
    await page.evaluate(() => (window as unknown as W).studyHarnessFixture.adapter.dispose((window as unknown as W).studyHarnessFixture.prepared!.activityId));
    await expect(ui(page)).toHaveAttribute('data-eka-ui-state', 'disposed');
    await expect.poll(() => focused(page)).toMatchObject({ tag: expect.stringMatching(/^h[2-6]$/), inCard: true });
    expect(errors).toEqual([]);
  });

  test('G50 announcements: nothing during playback, the position once on pause, a host suspension once', async ({ page }) => {
    test.setTimeout(60_000);
    const errors = await openFixture(page);
    await toRevealedTrace(page);
    await page.waitForTimeout(2_000);
    await page.evaluate(() => {
      const live = document.querySelector('[data-fx-card] [data-experiment-kit-activity]')!.shadowRoot!.querySelector('.eka-sr[role=status][aria-live=polite]')!;
      const log: { at: number; text: string }[] = [];
      (window as unknown as { fxLive: typeof log }).fxLive = log;
      new MutationObserver(() => log.push({ at: performance.now(), text: live.textContent ?? '' })).observe(live, { childList: true, characterData: true, subtree: true });
    });
    const now = () => page.evaluate(() => performance.now());
    const live = () => page.evaluate(() => (window as unknown as { fxLive: { at: number; text: string }[] }).fxLive.map(entry => ({ ...entry })));
    await card(page).getByRole('button', { name: 'Play' }).click();
    await expect(ui(page)).toHaveAttribute('data-eka-ui-state', 'playing');
    const playing = await now();
    await page.waitForTimeout(2_500);
    expect((await projection(page)).navigation!.value).toBeGreaterThan(2);
    const pauseAt = await now();
    await card(page).getByRole('button', { name: 'Pause' }).click();
    await expect(ui(page)).not.toHaveAttribute('data-eka-ui-state', 'playing');
    await page.waitForTimeout(2_000);
    const paused = await projection(page);
    let log = await live();
    expect(log.filter(entry => entry.at >= playing && entry.at < pauseAt), 'announcements while playing').toEqual([]);
    const afterPause = log.filter(entry => entry.at >= pauseAt).map(entry => entry.text.trim());
    expect(afterPause).toEqual([`Paused at n = ${paused.navigation!.value} of 1000.`]);

    const suspendAt = await now();
    await page.evaluate(() => (window as unknown as W).studyHarnessFixture.prepared!.host.suspend({ operationId: 'fx-test-suspend-live', reason: 'host' }));
    await page.waitForTimeout(2_000);
    log = await live();
    const afterSuspend = log.filter(entry => entry.at >= suspendAt).map(entry => entry.text.trim());
    expect(afterSuspend).toHaveLength(1);
    expect(afterSuspend[0]).toMatch(/^Paused by the host\./);
    expect(errors).toEqual([]);
  });

  test('G50 a card reopened from a checkpoint announces the restored state once', async ({ page }) => {
    const errors = await openFixture(page, '?template=function-derivative&mode=free');
    const exact = control(page, 'p').getByRole('textbox');
    await exact.fill('2');
    await exact.press('Enter');
    await expect.poll(() => current(page, 'p')).toBe(2);
    await settle(page);
    await drive(page, 'save', 'backup');
    const restarted = await page.evaluate(() => (window as unknown as { studyHarnessFixture: { restartHost(): Promise<{ ok: boolean; message: string }> } }).studyHarnessFixture.restartHost());
    expect(restarted, restarted.message).toMatchObject({ ok: true });
    await settle(page);
    await expect(ui(page)).toHaveAttribute('data-eka-ui-state', 'restored');
    const liveRegion = card(page).locator('.eka-sr[role=status][aria-live=polite]');
    await expect(liveRegion).toContainText('Restored from a saved state');
    expect(errors).toEqual([]);
  });

  test('R27 a keyboard preview cancelled with Escape is not announced as an update; the committed one is, once', async ({ page }) => {
    const errors = await openFixture(page);
    await toRevealedTrace(page);
    const live = await recordLive(page);
    const before = await projection(page);
    const slider = control(page, 'eta').getByRole('slider');
    await slider.focus();
    let mark = await live.now();
    await page.keyboard.down('ArrowRight');
    await tentative(page);
    await page.keyboard.press('Escape');
    await page.keyboard.up('ArrowRight');
    await expect.poll(async () => (await projection(page)).frame?.kind).toBe('committed');
    await page.waitForTimeout(2_000);
    const cancelled = await projection(page);
    expect(cancelled.frame!.frameId).toBe(before.frame!.frameId);
    expect(cancelled.controls.find(item => item.parameter === 'eta')!.value).toBe(before.controls.find(item => item.parameter === 'eta')!.value);
    // Nothing was committed, so no update is announced (a host save the gesture caused may still be announced).
    expect((await live.since(mark)).filter(text => /^Updated/.test(text)), 'no update announced for a cancelled preview').toEqual([]);
    // The same key gesture completed (key release) commits a new run: announced as an update, once.
    mark = await live.now();
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await projection(page)).guards.expectedRunId).not.toBe(before.guards.expectedRunId);
    await page.waitForTimeout(2_000);
    expect((await live.since(mark)).filter(text => /^Updated/.test(text))).toEqual(['Updated: n = 0 of 1000.']);
    expect(errors).toEqual([]);
  });

  test('R28 R41 the live region follows the projection: an independent task empties it of instructional values at once; closing the mounted card is announced once', async ({ page }) => {
    test.setTimeout(60_000);
    const errors = await openFixture(page);
    await toRevealedTrace(page);
    await card(page).getByRole('button', { name: 'Next iteration' }).click();
    await settle(page);
    const region = card(page).locator('.eka-sr[role=status][aria-live=polite]');
    const instructional = (await projection(page)).views.flatMap(view => view.values).map(value => value.label);
    await card(page).getByRole('button', { name: 'Read current values' }).click();
    for (const label of instructional) await expect(region).toContainText(`${label}:`);
    const live = await recordLive(page);
    const mark = await live.now();
    expect(await page.evaluate(() => (window as unknown as W).studyHarnessFixture.session.interruptWithIndependentTask())).toBeNull();
    // Visibility/persistence can publish a newer independent projection before an earlier ID ever reaches the DOM.
    // Match the current projection and rendered ID in one read, rather than waiting for a superseded snapshot ID.
    await page.waitForFunction(() => {
      const current = window.studyHarnessFixture.binding!.getProjection();
      const root = document.querySelector('[data-fx-card] [data-experiment-kit-activity]')?.shadowRoot?.querySelector('.eka');
      return current.context === 'independent' && root?.getAttribute('data-eka-projection') === current.projectionId;
    }, null, { timeout: 8_000 });
    const independent = await projection(page);
    expect(independent.context).toBe('independent');
    const shown = new Set(independent.views.flatMap(view => view.values).map(value => value.label));
    const withdrawn = instructional.filter(label => !shown.has(label));
    expect(withdrawn.length, 'the independent projection withdraws instructional values').toBeGreaterThan(0);
    // In the same render that hides the instructional output: no withdrawn value remains in the region or the tree.
    const atOnce = (await region.textContent()) ?? '';
    for (const label of withdrawn) expect(atOnce, label).not.toContain(`${label}:`);
    const aria = await page.locator('[data-fx-card]').ariaSnapshot();
    for (const label of withdrawn) expect(aria, label).not.toContain(`${label}: `);
    await expect(region).toContainText('Independent task.');
    for (const text of await live.since(mark)) for (const label of withdrawn) expect(text, label).not.toContain(`${label}:`);

    // Closing the mounted card (the host keeps it on screen): announced once, and nothing earlier stays.
    const closeAt = await live.now();
    await page.evaluate(() => (window as unknown as { studyHarnessFixture: { prepared: { host: { close(input: { operationId: string; reason?: string }): Promise<unknown> } } } }).studyHarnessFixture.prepared.host.close({ operationId: 'fx-test-close-live', reason: 'Lesson finished.' }));
    await expect(ui(page)).toHaveAttribute('data-eka-ui-state', 'empty');
    await page.waitForTimeout(2_000);
    expect(await live.since(closeAt)).toEqual(['This activity is closed.']);
    await expect(region).toHaveText('This activity is closed.');
    expect(errors).toEqual([]);
  });

  test('R20 Stop comparing is a scientific action like the others: during a host suspension it is aria-disabled with the visible reason and sends nothing', async ({ page }) => {
    const errors = await openFixture(page);
    await toRevealedTrace(page);
    await card(page).getByRole('button', { name: 'Keep this run to compare' }).click();
    await settle(page);
    const exact = control(page, 'eta').getByRole('textbox');
    await exact.fill('0.75');
    await exact.press('Enter');
    await expect.poll(() => current(page, 'eta')).toBe(0.75);
    await settle(page);
    const stop = card(page).getByRole('button', { name: 'Stop comparing with kept run 1' });
    await expect(stop).not.toHaveAttribute('aria-disabled', 'true');
    const live = await recordLive(page);
    await page.evaluate(() => (window as unknown as W).studyHarnessFixture.prepared!.host.suspend({ operationId: 'fx-test-suspend-compare', reason: 'host' }));
    await expect(ui(page)).toHaveAttribute('data-eka-ui-state', 'suspended');
    await expect(stop).toHaveAttribute('aria-disabled', 'true');
    await expect(stop).toHaveAccessibleDescription(/Paused by the host\./);
    const mark = await live.now();
    await stop.click({ force: true });
    await page.waitForTimeout(1_800);
    expect((await projection(page)).comparisons).toHaveLength(1);
    expect(await bindingErrors(page)).toEqual([]);
    expect((await live.since(mark)).filter(text => /Not applied/.test(text))).toEqual([]);
    await expect(card(page).getByText('That change was not applied')).toHaveCount(0);
    await page.evaluate(() => (window as unknown as W).studyHarnessFixture.prepared!.host.resume({ operationId: 'fx-test-resume-compare' }));
    await expect(stop).not.toHaveAttribute('aria-disabled', 'true');
    await stop.click();
    await expect.poll(async () => (await projection(page)).comparisons.length).toBe(0);
    expect(errors).toEqual([]);
  });

  test('R18 bounded worker recovery: once the retries are used up the card offers and announces Reload the activity (the host reloads), never a refused Try again', async ({ page }) => {
    test.setTimeout(120_000);
    const errors = await openFixture(page);
    await toRevealedTrace(page);
    // Every worker reply is dropped: the step and each recovery time out (watchdog), so recovery is exhausted.
    await page.evaluate(() => { (window as unknown as W).studyHarnessFixture.workerFaults.drop = 1_000; });
    await card(page).getByRole('button', { name: 'Next iteration' }).click();
    await expect(ui(page)).toHaveAttribute('data-eka-ui-state', 'recoverable-failure', { timeout: 15_000 });
    const banner = card(page).locator('.eka-banner[data-ui-state="recoverable-failure"]');
    // Each attempt is refused by the card's binding with a worker diagnostic once its evaluation times out.
    const workerRefusals = () => page.evaluate(() => (window as unknown as W).studyHarnessFixture.diagnostics.filter(item => item.code === 'WORKER_TIMEOUT' || item.code === 'WORKER_ERROR').length);
    const live = await recordLive(page);
    let lastAttempt = 0;
    for (let attempt = 1; attempt <= 3; attempt++) {
      await expect(banner.getByRole('button', { name: 'Try again' }), `attempt ${attempt}`).toHaveCount(1);
      const refused = await workerRefusals();
      lastAttempt = await live.now();
      await banner.getByRole('button', { name: 'Try again' }).click();
      await expect.poll(workerRefusals, { timeout: 15_000 }).toBeGreaterThan(refused);
      await expect.poll(async () => (await projection(page)).status.recovery?.action).toBe(attempt < 3 ? 'retry' : 'reload');
      await expect(ui(page)).toHaveAttribute('data-eka-ui-state', 'recoverable-failure');
    }
    await expect(banner.getByRole('button', { name: 'Reload the activity' })).toHaveCount(1);
    await expect(banner).toContainText('Trying again did not restore the calculation.');
    await expect(card(page).getByRole('button', { name: 'Try again' })).toHaveCount(0);
    // The screen-reader channel agrees with the banner: the attempt that uses up the retries is announced with the new
    // status and Reload the activity, said once, and nothing after it tells the learner to try again (residual of R18).
    const region = card(page).locator('.eka-sr[role=status][aria-live=polite]');
    await expect(region).toContainText('Trying again did not restore the calculation. Reload the activity.');
    await page.waitForTimeout(2_000);
    const said = await live.since(lastAttempt);
    expect(said.length, JSON.stringify(said)).toBeGreaterThan(0);
    expect(said.filter(text => /Try again/i.test(text)), JSON.stringify(said)).toEqual([]);
    expect(said.filter(text => text.includes('Trying again did not restore the calculation.')), JSON.stringify(said)).toHaveLength(1);
    for (const text of said) expect(text).toMatch(/Reload the activity\.$/);
    expect(((await region.textContent()) ?? '').trim()).toMatch(/Reload the activity\.$/);
    await expectAccessible(page, 'recovery used up');
    // The fixture host handles reload by reloading the page; the reloaded fixture starts again.
    const reloaded = page.waitForEvent('load');
    await banner.getByRole('button', { name: 'Reload the activity' }).click();
    await reloaded;
    await page.waitForFunction(() => document.body.dataset.fixtureReady === 'true');
    expect(errors).toEqual([]);
  });

  test('layout stability: an equation typeset as it comes on screen keeps the element under the pointer in place, so a click aimed below it lands (WebKit baseline failure)', async ({ page }) => {
    // KaTeX is fetched only once an equation is on screen; here it is held back so the typesetting arrives after the
    // pointer has reached the button below the equations, as it did in the failed WebKit run.
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route(/katex/i, async route => { await held; await route.continue(); });
    const errors = await openFixture(page, '?template=linear-transformation');
    const read = card(page).getByRole('button', { name: 'Read current values' });
    const equations = card(page).locator('[data-eka-panel="equations"]');
    await expect(equations.locator('.katex')).toHaveCount(0);
    await read.evaluate(element => element.scrollIntoView({ block: 'end' }));
    const box = (await read.boundingBox())!;
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.mouse.move(point.x, point.y);
    release();
    await expect(equations.locator('.katex').first()).toBeVisible();
    // The typeset formulas settle (a formula wider than the panel adds its hint and plain form a moment later).
    await page.waitForTimeout(500);
    const after = (await read.boundingBox())!;
    expect(Math.abs(after.y - box.y), 'the button under the pointer did not move').toBeLessThanOrEqual(1);
    await page.mouse.down();
    await page.mouse.up();
    await expect(card(page).locator('.eka-sr[role=status][aria-live=polite]')).toContainText('Image of e');
    expect(errors).toEqual([]);
  });

  test('slider drags in every engine: the thumb follows the pointer and the release commits one run; a keyboard-focused slider keeps a pointer drag, which Escape cancels', async ({ page }) => {
    // Engine defects this guards (found by the cross-browser run): an explicit setPointerCapture on the native range
    // input stopped WebKit's thumb from following the pointer at all, and WebKit's blur of a pressed range input that
    // had keyboard focus cancelled the drag (reason `blur`), so Escape never reached it.
    const errors = await openFixture(page, '?template=function-derivative&mode=free');
    const { slider, at, y } = await sliderAt(page, 'A');
    const spec = (await projection(page)).controls.find(item => item.parameter === 'A')!;
    const value = (fraction: number) => spec.min + (spec.max - spec.min) * fraction;
    const mark = (await hostEvents(page)).length;
    // A plain drag: the value follows the pointer while the preview is tentative; the release commits exactly once.
    await page.mouse.move(at(value(0.5)), y);
    await page.mouse.down();
    await page.mouse.move(at(value(0.75)), y, { steps: 4 });
    await tentative(page);
    await expect.poll(async () => Number(await slider.inputValue())).toBeCloseTo(value(0.75), 9);
    await page.mouse.up();
    await page.waitForTimeout(300);
    await settle(page);
    const dragged = await current(page, 'A');
    expect(dragged).toBeCloseTo(value(0.75), 9);
    // Keyboard focus first (one keyboard commit), then a pointer drag of the same slider: it previews, Escape cancels it,
    // and the release after Escape commits nothing.
    await slider.focus();
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => current(page, 'A')).not.toBe(dragged);
    await settle(page);
    const keyed = await current(page, 'A');
    await page.mouse.move(at(value(0.5)), y);
    await page.mouse.down();
    await page.mouse.move(at(value(0.25)), y, { steps: 4 });
    await tentative(page);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.studyHarnessFixture.binding!.getProjection().frame?.kind === 'committed');
    await page.mouse.move(at(value(0.1)), y, { steps: 2 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    await settle(page);
    expect(await current(page, 'A')).toBe(keyed);
    const events = await since(page, mark);
    expect(payloads(events, 'parameters.committed').map(p => p.gesture)).toEqual(['pointer', 'keyboard']);
    expect(payloads(events, 'preview.cancelled').map(p => p.reason)).toEqual(['escape']);
    expect(await bindingErrors(page)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('G33 lost pointer capture mid-drag cancels the preview (slider and point); the release commits nothing', async ({ page }) => {
    const errors = await openFixture(page, '?template=function-derivative&mode=free');
    await trackPointer(page);
    const mark = (await hostEvents(page)).length;
    const { at, y } = await sliderAt(page, 'A');
    await page.mouse.move(at(0.5), y);
    await page.mouse.down();
    await page.mouse.move(at(1.5), y, { steps: 4 });
    await tentative(page);
    const sliderPath = await loseCapture(page, '[data-parameter="A"] input[type=range]');
    // Moving on: the move is also the pointer event before which Firefox and WebKit report a released capture.
    await page.mouse.move(at(2), y, { steps: 2 });
    await page.waitForFunction(() => window.studyHarnessFixture.binding!.getProjection().frame?.kind === 'committed');
    await page.mouse.up();
    await page.waitForTimeout(300);

    const point = await handleCenter(page, 'function-plot');
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + 50, point.y, { steps: 4 });
    await tentative(page);
    const pointPath = await loseCapture(page, 'figure[data-eka-figure="function-plot"] [data-draggable="true"]');
    test.info().annotations.push({ type: 'G33 lost capture', description: `slider: ${sliderPath}; point: ${pointPath}` });
    await page.mouse.move(point.x + 80, point.y, { steps: 2 });
    await page.waitForFunction(() => window.studyHarnessFixture.binding!.getProjection().frame?.kind === 'committed');
    await page.mouse.up();
    await page.waitForTimeout(300);
    await settle(page);
    const events = await since(page, mark);
    expect(payloads(events, 'preview.cancelled').map(p => p.reason)).toEqual(['pointercancel', 'pointercancel']);
    expect(payloads(events, 'parameters.committed')).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('G33 touch: every slider leaves vertical panning to the browser (touch-action: pan-y), so a swipe that starts on it can scroll the page', async ({ page }) => {
    const errors = await openFixture(page, '?template=function-derivative&mode=free');
    const sliders = card(page).locator('input[type=range]');
    expect(await sliders.count()).toBeGreaterThan(0);
    expect(new Set(await sliders.evaluateAll(items => items.map(item => getComputedStyle(item).touchAction)))).toEqual(new Set(['pan-y']));
    expect(errors).toEqual([]);
  });

  test('G33 touch: a vertical swipe that starts on a slider scrolls the page, cancels any gesture and commits nothing', async ({ browser, browserName, baseURL }) => {
    // A trusted touch-move sequence needs the Chrome DevTools Protocol (Input.dispatchTouchEvent), which Playwright
    // offers in Chromium only; in Firefox and WebKit it can only tap. Those engines run the touch-action test above
    // and the pointercancel paths of the quadratic coherence test instead.
    test.skip(browserName !== 'chromium', 'trusted touch swipes need the Chrome DevTools Protocol (Chromium only in Playwright)');
    const context = await browser.newContext({ hasTouch: true, isMobile: false, viewport: { width: 1000, height: 640 }, reducedMotion: 'reduce', baseURL });
    const page = await context.newPage();
    try {
      const errors = await openFixture(page, '?template=function-derivative&mode=free');
      const before = await projection(page);
      const mark = (await hostEvents(page)).length;
      const slider = control(page, 'A').getByRole('slider');
      await slider.evaluate(element => element.scrollIntoView({ block: 'center' }));
      const box = (await slider.boundingBox())!;
      const scrollBefore = await page.evaluate(() => window.scrollY);
      const cdp = await context.newCDPSession(page);
      const x = box.x + box.width * 0.7, y0 = box.y + box.height / 2;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] });
      for (let index = 1; index <= 12; index++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 - index * 18 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForTimeout(500);
      await settle(page);
      expect(await page.evaluate(() => window.scrollY)).not.toBe(scrollBefore);
      const events = await since(page, mark);
      expect(payloads(events, 'parameters.committed')).toEqual([]);
      expect(payloads(events, 'preview.cancelled').map(p => p.reason).every(reason => reason === 'pointercancel')).toBe(true);
      const after = await projection(page);
      expect(after.guards).toEqual(before.guards);
      expect(Number(await slider.inputValue())).toBe(before.controls.find(item => item.parameter === 'A')!.value);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });

  test('G33 IME composition: Enter during composition does not apply the typed value; after compositionend Enter applies it once', async ({ page }) => {
    const errors = await openFixture(page, '?template=function-derivative&mode=free');
    const mark = (await hostEvents(page)).length;
    const box = control(page, 'A').getByRole('textbox');
    await box.fill('0.75');
    await box.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, composed: true, data: '' })));
    await box.press('Enter');
    await page.waitForTimeout(400);
    expect(payloads(await since(page, mark), 'parameters.committed')).toEqual([]);
    await expect(box).toHaveValue('0.75');
    await box.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, composed: true, data: '0.75' })));
    await box.press('Enter');
    await expect.poll(() => current(page, 'A')).toBe(0.75);
    await settle(page);
    expect(payloads(await since(page, mark), 'parameters.committed').map(p => [p.gesture, (p.params as Record<string, number>).A])).toEqual([['exact', 0.75]]);
    expect(errors).toEqual([]);
  });

  test('G33 blur (one rule for sliders and points): focus leaving mid keyboard gesture cancels it, and the key release commits nothing', async ({ page }) => {
    const errors = await openFixture(page, '?template=function-derivative&mode=free');
    const before = await projection(page);
    const mark = (await hostEvents(page)).length;
    const elsewhere = () => page.evaluate(() => (document.querySelector('[data-fx-transition], [data-fx-action]') as HTMLElement).focus());
    const slider = control(page, 'B').getByRole('slider');
    await slider.focus();
    await page.keyboard.down('ArrowRight');
    await tentative(page);
    await elsewhere();
    await page.keyboard.up('ArrowRight');
    await page.waitForTimeout(300);
    expect(Number(await slider.inputValue())).toBe(before.controls.find(item => item.parameter === 'B')!.value);

    const point = handle(page, 'function-plot');
    await point.focus();
    await page.keyboard.down('ArrowRight');
    await tentative(page);
    await elsewhere();
    await page.keyboard.up('ArrowRight');
    await page.waitForTimeout(300);
    await settle(page);
    const events = await since(page, mark);
    expect(payloads(events, 'preview.cancelled').map(p => p.reason)).toEqual(['blur', 'blur']);
    expect(payloads(events, 'parameters.committed')).toEqual([]);
    expect((await projection(page)).guards).toEqual(before.guards);
    expect(errors).toEqual([]);
  });

  test('G33 rapid scenario switching: two scenarios activated in one task commit exactly one run', async ({ page }) => {
    const errors = await openFixture(page);
    await toRevealedTrace(page);
    const mark = (await hostEvents(page)).length;
    const clicked = await page.evaluate(() => {
      const buttons = [...document.querySelector('[data-fx-card] [data-experiment-kit-activity]')!.shadowRoot!.querySelectorAll<HTMLButtonElement>('.eka-scenarios button')];
      buttons[1]!.click();
      buttons[2]!.click();
      return [buttons[1]!.textContent, buttons[2]!.textContent];
    });
    await page.waitForTimeout(500);
    await settle(page);
    const commits = payloads(await since(page, mark), 'parameters.committed');
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({ cause: 'scenario' });
    const shown = await projection(page);
    expect(shown.scenarios.filter(item => item.active).map(item => item.label)).toEqual([clicked[0]]);
    expect(await bindingErrors(page)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('G47 quadratic-surface-gradient point: a pointer drag commits step-aligned values and leaves the unmoved axis; arrow keys move one step; Escape cancels', async ({ page }) => {
    const errors = await openFixture(page, '?template=quadratic-surface-gradient&mode=free');
    const before = await projection(page);
    const px0 = before.controls.find(item => item.parameter === 'px')!.value, py0 = before.controls.find(item => item.parameter === 'py')!.value;
    let mark = (await hostEvents(page)).length;
    // Pointer: a horizontal drag.
    let point = await handleCenter(page, 'contour-plot');
    await page.mouse.move(point.x + 3, point.y + 2);
    await page.mouse.down();
    await page.mouse.move(point.x - 37, point.y + 2, { steps: 6 });
    await tentative(page);
    await page.mouse.up();
    await expect.poll(async () => (await projection(page)).guards.expectedRunId).not.toBe(before.guards.expectedRunId);
    await settle(page);
    let commits = payloads(await since(page, mark), 'parameters.committed');
    expect(commits).toHaveLength(1);
    expect(commits[0]!.gesture).toBe('drag');
    const params = commits[0]!.params as Record<string, number>;
    expect(params.py).toBe(py0);
    expect(params.px).toBeLessThan(px0);
    expect(Math.abs(params.px! * 10 - Math.round(params.px! * 10))).toBeLessThan(1e-9);
    expect(String(params.px).replace('-', '').length).toBeLessThanOrEqual(3);
    await expect(control(page, 'px').getByRole('textbox')).toHaveValue(String(params.px));

    // Keyboard: one step up; px unchanged.
    mark = (await hostEvents(page)).length;
    await handle(page, 'contour-plot').focus();
    await page.keyboard.press('ArrowUp');
    await expect.poll(() => current(page, 'py')).toBe(Number((py0 + 0.1).toFixed(1)));
    await settle(page);
    commits = payloads(await since(page, mark), 'parameters.committed');
    expect(commits.map(p => [p.gesture, (p.params as Record<string, number>).px, (p.params as Record<string, number>).py])).toEqual([['keyboard', params.px, Number((py0 + 0.1).toFixed(1))]]);

    // Escape during a pointer drag: the preview ends and the release commits nothing.
    mark = (await hostEvents(page)).length;
    const run = (await projection(page)).guards.expectedRunId;
    point = await handleCenter(page, 'contour-plot');
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + 30, point.y - 30, { steps: 5 });
    await tentative(page);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.studyHarnessFixture.binding!.getProjection().frame?.kind === 'committed');
    await page.mouse.move(point.x + 60, point.y - 60, { steps: 3 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    await settle(page);
    const events = await since(page, mark);
    expect(payloads(events, 'preview.cancelled').map(p => p.reason)).toEqual(['escape']);
    expect(payloads(events, 'parameters.committed')).toEqual([]);
    expect((await projection(page)).guards.expectedRunId).toBe(run);
    expect(errors).toEqual([]);
  });

  test('G47 function-derivative: P is draggable while exploring (pointer, keyboard, Escape), commits on the 0.25 grid, and the copy says so', async ({ page }) => {
    const errors = await openFixture(page, '?template=function-derivative&mode=free');
    await expect(control(page, 'p').locator('.eka-control-hint')).toContainText('You can also drag P');
    const target = handle(page, 'function-plot');
    await expect(target).toHaveAttribute('aria-roledescription', 'movable point');
    await expectAccessible(page, 'draggable P');
    const before = await projection(page);
    const others = (p: LearnerProjection) => p.controls.filter(item => item.parameter !== 'p').map(item => [item.parameter, item.value]);
    let mark = (await hostEvents(page)).length;
    const point = await handleCenter(page, 'function-plot');
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + 70, point.y + 25, { steps: 6 });
    await tentative(page);
    await page.mouse.up();
    await expect.poll(async () => (await projection(page)).guards.expectedRunId).not.toBe(before.guards.expectedRunId);
    await settle(page);
    let commits = payloads(await since(page, mark), 'parameters.committed');
    expect(commits).toHaveLength(1);
    expect(commits[0]!.gesture).toBe('drag');
    const p1 = (commits[0]!.params as Record<string, number>).p!;
    expect(p1).toBeGreaterThan(-1);
    expect(Math.abs(p1 * 4 - Math.round(p1 * 4))).toBeLessThan(1e-9);
    const dragged = await projection(page);
    expect(others(dragged)).toEqual(others(before));
    // Linked probing (S7): dragging P on f moved the linked P on f′ in the same committed frame, rendered by both figures.
    const at = (viewId: string, markId: string) => dragged.views.find(view => view.viewId === viewId)!.marks.find(item => item.markId === markId)!.at!;
    expect(at('function-plot', 'probe-marker')[0]).toBe(p1);
    expect(at('derivative-plot', 'derivative-probe-marker')[0]).toBe(p1);
    expect(new Set((await renderedFrameIds(page)).map(item => item.frameId))).toEqual(new Set([dragged.frame!.frameId]));

    mark = (await hostEvents(page)).length;
    await target.focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => current(page, 'p')).toBe(p1 + 0.25);
    await settle(page);
    commits = payloads(await since(page, mark), 'parameters.committed');
    expect(commits.map(p => [p.gesture, (p.params as Record<string, number>).p])).toEqual([['keyboard', p1 + 0.25]]);

    mark = (await hostEvents(page)).length;
    await page.keyboard.down('ArrowLeft');
    await tentative(page);
    await page.keyboard.press('Escape');
    await page.keyboard.up('ArrowLeft');
    await page.waitForTimeout(300);
    await settle(page);
    const events = await since(page, mark);
    expect(payloads(events, 'preview.cancelled').map(p => p.reason)).toEqual(['escape']);
    expect(payloads(events, 'parameters.committed')).toEqual([]);
    expect(await current(page, 'p')).toBe(p1 + 0.25);
    expect(errors).toEqual([]);
  });
});
