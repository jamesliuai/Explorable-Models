/**
 * Quadratic learning-and-return fixture in a real browser (report §6.1, §6.3, §9, §10, §11, §12.3, §12.6, §17; A21–A26,
 * A31–A36, A39–A43, A50). It drives `study-harness.html`: the fixture host (sessionStorage tables, receipts, fault
 * injection), the real catalogue kernel module worker, the activity adapter and the learner card in its shadow root.
 *
 * Evidence scope: Playwright Chromium (`npm run test:browser`), Firefox and WebKit (`npm run test:cross-browser`) with the
 * integration-fixture host. These are fixture-host results; they say
 * nothing about the Study Harness host, a packaged WebView, assistive-technology use or learning benefit. The titles of
 * the alternative-equivalence tests carry the `verifiedBy` IDs of the quadratic template.
 */
import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import {
  activityId, arrowTo, card, control, expectAccessible, expectHidden, expectShown, focusKey, focused, hostEvents, hostExposures, hostState, numeral, openFixture, overflow, pngSize,
  projection, renderedFrameIds, respond, settle, SHOTS, step, tabTo, tables, types, valueLabels,
} from './support/study-harness';

mkdirSync(SHOTS, { recursive: true });

const shot = async (page: Page, name: string) => {
  // Equations render lazily once visible: bring the card's last panel into view so KaTeX output is in the picture.
  const equations = card(page).locator('[data-ema-panel="equations"]');
  if (await equations.count()) {
    await equations.last().scrollIntoViewIfNeeded();
    await expect(equations.last().locator('.katex').first()).toBeVisible();
  }
  // With the card's top at the top of the viewport the card stays in view while the full-page capture resizes the
  // viewport, so the capture never catches the card suspended as offscreen (which it correctly is when scrolled away).
  if (await card(page).count()) await card(page).evaluate(host => host.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(100);
  await page.waitForFunction(() => window.studyHarnessFixture.binding?.getProjection().status.ui !== 'suspended');
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
};
const valueOf = async (page: Page, label: string): Promise<string> =>
  ((await card(page).locator('[data-ema-panel="values"] .ema-value-row').filter({ has: page.locator(`dt:text-is("${label}")`) }).locator('dd').first().textContent()) ?? '').trim();

/** Prediction → step-size exploration enabled → trace revealed and displayed (explore-step). */
async function toRevealedTrace(page: Page): Promise<void> {
  await respond(page, 'Small steps shrink the positions; larger ones overshoot and may grow.');
  await step(page, 'enable-exploration');
  await step(page, 'reveal-trace');
}

/** Exact entry for one control (display units); waits for the committed run. */
async function exact(page: Page, parameter: string, value: string): Promise<void> {
  const box = control(page, parameter).getByRole('textbox');
  await box.fill(value);
  await box.press('Enter');
  await expect.poll(async () => (await projection(page)).controls.find(item => item.parameter === parameter)?.value).toBe(Number(value));
  await settle(page);
}
async function goTo(page: Page, index: number): Promise<void> {
  const box = card(page).getByRole('textbox', { name: 'Go to n =' });
  await box.fill(String(index));
  await box.press('Enter');
  await expect.poll(async () => (await projection(page)).navigation?.value).toBe(index);
  await settle(page);
}

test.describe('quadratic learning-and-return fixture', () => {
  test('§6.1 required flow: prediction with the trace hidden, exploration, reveal, curvature, explanation, close, independent task (A21 A22 A25 A31)', async ({ page }) => {
    test.setTimeout(120_000);
    const errors = await openFixture(page);
    await expect(page.getByRole('note').first()).toContainText('Integration fixture — not a tutor');
    await expect(page.locator('.fx-message-from').first()).toHaveText('Scripted tutor message (fixture)');

    // Predict: the trace, observations, regime and substituted rule are absent from every learner channel.
    const predicting = await projection(page);
    expect(predicting.stage.id).toBe('predict');
    expect(predicting.views.map(view => view.viewId)).toEqual(['landscape', 'readouts', 'rules']);
    await expectHidden(page, ['trace', 'observations', 'regime', 'substituted'], 'predict', { snapshot: true });
    // The card has no response field: the composer belongs to the host page.
    expect(await card(page).locator('textarea').count()).toBe(0);
    await expect(card(page).getByRole('textbox', { name: /prediction|explanation|answer/i })).toHaveCount(0);
    await expect(page.locator('[data-fx-composer="prediction"]')).toBeVisible();
    await expect(page.locator('[data-fx-step="enable-exploration"]')).toHaveAttribute('aria-disabled', 'true');
    await expectAccessible(page, 'predict');
    await shot(page, 'default-predict');

    const prediction = 'Small steps shrink the positions; larger ones overshoot and may grow.';
    await respond(page, prediction);
    const afterPrediction = await hostEvents(page);
    const submitted = afterPrediction.filter(event => event.type === 'response.submitted');
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.payload).toMatchObject({ response: { kind: 'prediction', modality: 'text', stageId: 'predict', status: 'submitted' } });
    // The host keeps the text; the activity journal holds only the reference.
    expect(JSON.stringify(afterPrediction)).not.toContain(prediction);
    expect((await tables(page)).responses.map(entry => entry.text)).toContain(prediction);

    // Step-size exploration is enabled while the trace stays hidden (exploration scope recorded by the host).
    await step(page, 'enable-exploration');
    const exploring = await projection(page);
    expect(exploring.stage.id).toBe('explore-step');
    expect(exploring.controls.find(item => item.parameter === 'eta')?.mode).toBe('interactive');
    expect(exploring.controls.find(item => item.parameter === 'a')?.mode).toBe('fixed');
    await expectHidden(page, ['trace', 'observations', 'regime', 'substituted'], 'explore-step before reveal');
    expect((await hostExposures(page)).map(record => record.scope)).toEqual(['exploration']);
    await expectAccessible(page, 'explore-step before reveal');

    // Reveal under the updated host policy; present only after the display acknowledgement.
    await step(page, 'reveal-trace');
    const reveal = (await hostExposures(page)).find(record => record.scope === 'reveal')!;
    expect(reveal.groups.map(group => group.groupId)).toEqual(['trace', 'observations']);
    expect(reveal).toMatchObject({ displayStatus: 'displayed', acked: true });
    const revealEvents = types(await hostEvents(page));
    expect(revealEvents.indexOf('reveal.authorized')).toBeLessThan(revealEvents.indexOf('reveal.displayed'));
    await expectShown(page, ['trace', 'observations'], 'after reveal');
    await expectHidden(page, ['regime', 'substituted'], 'after reveal', { capture: false });
    await expectAccessible(page, 'trace revealed');
    await shot(page, 'default-revealed');

    // Curvature control added; the substituted rule arrives with its own stage receipt.
    await step(page, 'add-curvature');
    const curvature = await projection(page);
    expect(curvature.controls.filter(item => item.mode === 'interactive').map(item => item.parameter)).toEqual(['eta', 'a']);
    await expectShown(page, ['trace', 'observations', 'substituted'], 'curvature');
    await expectHidden(page, ['regime'], 'curvature', { capture: false });
    await expectAccessible(page, 'curvature');

    // Explanation through the host composer.
    await step(page, 'request-explanation');
    expect((await projection(page)).stage).toMatchObject({ id: 'explain', response: { kind: 'explanation' } });
    await expect(page.locator('[data-fx-composer="explanation"]')).toBeVisible();
    await expectAccessible(page, 'explain');
    await respond(page, 'The product of the step size and the curvature decides it.');

    // Close the instructional view: the card is unmounted, the activity closed in the host journal.
    const instructional = await page.evaluate(() => window.studyHarnessFixture.prepared!.activityId);
    await step(page, 'close');
    await expect(card(page)).toHaveCount(0);
    expect(types(await hostEvents(page, instructional))).toContain('activity.closed');

    // A new independent-task activity: only the neutral scaffold, no teaching visual, no pending reveal.
    await step(page, 'independent-task');
    const task = await projection(page);
    expect(task.activityId).not.toBe(instructional);
    expect(task.context).toBe('independent');
    expect(task.views.map(view => view.viewId)).toEqual(['rules']);
    expect(task.views[0]!.equations.map(equation => equation.equationId)).toEqual(['objective', 'update-rule']);
    expect(task.controls).toEqual([]);
    expect(task.pendingReveal).toBeNull();
    // The neutral scaffold keeps no position group, so the card offers no navigation or playback (R02).
    expect(task.navigation).toBeNull();
    await expect(card(page).locator('.ema-nav')).toHaveCount(0);
    // The teaching stage's instruction and prompt are withheld: the host owns the independent task's prompt.
    expect(task.stage.response).toBeUndefined();
    expect(task.stage.instruction).toBe('Independent work: follow the task given in your session. Teaching content from this activity is not shown here.');
    // With no drawing left, the scaffold takes the card's full width instead of leaving an empty column.
    await expect(card(page).locator('.ema-workspace')).toHaveAttribute('data-single', 'true');
    await expect(card(page).getByText('Independent task', { exact: true })).toBeVisible();
    await expectHidden(page, ['trace', 'observations', 'regime', 'substituted'], 'independent task', { capture: false });
    const taskDom = await card(page).evaluate(host => host.shadowRoot!.textContent ?? '');
    for (const teaching of ['Objective landscape', 'η = 0.25', 'Comparison scenarios', 'Step size η']) expect(taskDom).not.toContain(teaching);
    await expect(page.locator('.fx-message').last()).toContainText('Predict x₃');
    await expectAccessible(page, 'independent task');
    await shot(page, 'independent-task');

    await respond(page, 'x₃ = −0.5');
    await expect(page.locator('[data-fx-complete]')).toBeVisible();
    const answer = (await tables(page)).responses.find(entry => entry.ref.kind === 'answer')!;
    expect(answer.snapshotCursor).toBeGreaterThan(0);

    // Every journaled event of both activities is schema-valid and gap-free; one response event per response.
    const state = await tables(page);
    for (const [id, table] of Object.entries(state.activities)) {
      table.events.forEach((event, index) => expect(event.sequence, `${id} sequence`).toBe(index + 1));
      const problems = await page.evaluate(events => events.flatMap(event => window.studyHarnessFixture.validate('study-harness.interaction-event', event)), table.events);
      expect(problems, id).toEqual([]);
    }
    const all = Object.values(state.activities).flatMap(table => table.events);
    expect(all.filter(event => event.type === 'response.submitted').map(event => (event.payload.response as { kind: string }).kind)).toEqual(['prediction', 'explanation', 'answer']);
    expect(all.filter(event => event.type === 'context.independent-entered')).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  test('persist-before-reveal: a failed exposure intent shows nothing, keeps the reveal pending and a retry recovers (A22 A23)', async ({ page }) => {
    const errors = await openFixture(page, '?fail=exposure-intent');
    await respond(page, 'They shrink.');
    await step(page, 'enable-exploration');
    await page.locator('[data-fx-step="reveal-trace"]').click();
    // The banner names what is not shown yet and offers the one retry (G41: no second pending row or retry control).
    const pending = card(page).locator('.ema-banner[data-cause="reveal-not-saved"]');
    await expect(pending).toContainText(/so .+ (is|are) not shown yet/);
    await settle(page, { allowPending: true });
    expect((await projection(page)).pendingReveal).toMatchObject({ state: 'failed' });
    await expectHidden(page, ['trace', 'observations'], 'failed intent', { capture: false });
    expect((await hostExposures(page)).filter(record => record.scope !== 'exploration')).toEqual([]);
    expect(await page.evaluate(() => window.studyHarnessFixture.host.calls().filter(call => call.point === 'exposure-intent').map(call => call.outcome))).toEqual(['failed']);
    await expectAccessible(page, 'failed intent');

    // The learner's retry resends the same request (same idempotency key); the host step then completes.
    await pending.getByRole('button', { name: 'Try again' }).click();
    await page.waitForFunction(() => window.studyHarnessFixture.session.getSnapshot().steps.find(item => item.id === 'reveal-trace')?.state === 'done');
    await settle(page);
    await expectShown(page, ['trace', 'observations'], 'after retry');
    const reveals = (await hostExposures(page)).filter(record => record.scope === 'reveal');
    expect(reveals).toHaveLength(1);
    expect(reveals[0]).toMatchObject({ displayStatus: 'displayed', acked: true });
    const events = await hostEvents(page);
    const requested = events.filter(event => event.type === 'reveal.requested' && (event.payload as { scope: string }).scope === 'reveal');
    expect(requested).toHaveLength(1);
    expect(types(events).filter(type => type === 'reveal.authorized')).toHaveLength(1);
    expect(events.find(event => event.type === 'operation.failed')?.payload).toMatchObject({ operation: 'recordExposureIntent', code: 'PERSISTENCE_FAILED', recoverable: true });
    expect(errors).toEqual([]);
  });

  test('persist-before-reveal: a failed display acknowledgement keeps the trace shown and the exposure uncertain until retry (A23)', async ({ page }) => {
    const errors = await openFixture(page, '?fail=display-ack');
    await toRevealedTrace(page);
    await expectShown(page, ['trace', 'observations'], 'ack failed');
    const local = (await hostState(page)).exposures!.find(record => record.scope === 'reveal')!;
    expect(local).toMatchObject({ displayStatus: 'displayed', uncertainty: { code: 'ACK_NOT_PERSISTED' } });
    const held = (await hostExposures(page)).find(record => record.scope === 'reveal')!;
    expect(held).toMatchObject({ displayStatus: 'authorized', acked: false });
    expect(types(await hostEvents(page))).toContain('reveal.uncertain');
    const banner = card(page).locator('.ema-banner[data-ui-state="awaiting-persistence"]');
    await expect(banner).toBeVisible();
    await expectAccessible(page, 'ack not persisted');

    await banner.getByRole('button', { name: 'Retry saving' }).click();
    await expect.poll(async () => (await hostExposures(page)).find(record => record.scope === 'reveal')?.acked).toBe(true);
    await settle(page);
    expect((await hostState(page)).exposures!.find(record => record.scope === 'reveal')!.uncertainty).toBeUndefined();
    await expect(banner).toHaveCount(0);
    expect((await hostExposures(page)).find(record => record.scope === 'reveal')!.displayStatus).toBe('displayed');
    expect(errors).toEqual([]);
  });

  test('preview gesture coherence: one tentative frame across representations; Escape and pointercancel restore the committed frame; only pointerup commits one run (A24 A39 A40)', async ({ page }) => {
    test.setTimeout(60_000);
    const errors = await openFixture(page);
    await toRevealedTrace(page);
    const before = await projection(page);
    const committedFrame = before.frame!.frameId, committedRun = before.guards.expectedRunId;
    const slider = control(page, 'eta').getByRole('slider', { name: 'Step size η' });
    await slider.scrollIntoViewIfNeeded();
    await page.evaluate(() => {
      const root = document.querySelector('[data-fx-card] [data-explorable-models-activity]')!.shadowRoot!;
      root.addEventListener('pointerdown', event => { (window as unknown as { fxPointer: number }).fxPointer = (event as PointerEvent).pointerId; }, { capture: true });
    });
    const box = (await slider.boundingBox())!;
    const y = box.y + box.height / 2, at = (eta: number) => box.x + 8 + (box.width - 16) * eta / 2;
    const hostCallsBefore = (await page.evaluate(() => window.studyHarnessFixture.host.calls().length));

    /** Waits for a tentative frame in the DOM and checks that every representation shows exactly that frame. */
    const coherent = async (label: string) => {
      await page.waitForFunction(() => {
        const current = window.studyHarnessFixture.binding!.getProjection();
        const root = document.querySelector('[data-fx-card] [data-explorable-models-activity]')?.shadowRoot?.querySelector('.ema');
        return current.frame?.kind === 'tentative' && root?.getAttribute('data-ema-projection') === current.projectionId;
      });
      const shown = await projection(page);
      const ids = await renderedFrameIds(page);
      expect(ids.length, label).toBeGreaterThanOrEqual(5);
      expect(new Set(ids.map(item => item.frameId)), `${label}: ${JSON.stringify(ids)}`).toEqual(new Set([shown.frame!.frameId]));
      expect(shown.frame!.frameId).not.toBe(committedFrame);
      await expect(card(page).locator('[data-ema-figure][data-tentative="true"]')).toHaveCount(2);
      const eta = shown.controls.find(item => item.parameter === 'eta')!;
      expect(eta.previewValue, label).toBeDefined();
      await expect(control(page, 'eta').locator('output')).toContainText('preview');
      expect(numeral(await valueOf(page, 'Step size times curvature')), label).toBeCloseTo(eta.previewValue! * 2, 9);
      expect(numeral(await valueOf(page, 'Update multiplier')), label).toBeCloseTo(1 - eta.previewValue! * 2, 9);
      return shown.frame!.frameId;
    };
    const restored = async (label: string) => {
      await page.waitForFunction(frameId => window.studyHarnessFixture.binding!.getProjection().frame?.frameId === frameId, committedFrame);
      await settle(page, { allowPending: true });
      const shown = await projection(page);
      expect(shown.preview, label).toBeNull();
      expect(shown.guards.expectedRunId, label).toBe(committedRun);
      expect(new Set((await renderedFrameIds(page)).map(item => item.frameId)), label).toEqual(new Set([committedFrame]));
      await expect(card(page).locator('[data-ema-figure][data-tentative="true"]')).toHaveCount(0);
      expect(numeral(await valueOf(page, 'Step size times curvature')), label).toBeCloseTo(0.5, 9);
    };

    // 1) Drag, then Escape: the committed frame returns; moving on and releasing commits nothing.
    await page.mouse.move(at(0.25), y);
    await page.mouse.down();
    await page.mouse.move(at(0.6), y, { steps: 4 });
    const first = await coherent('drag 1');
    await page.mouse.move(at(0.9), y, { steps: 4 });
    const second = await coherent('drag 1, further');
    expect(second).not.toBe(first);
    await expectAccessible(page, 'tentative preview');
    await page.keyboard.press('Escape');
    await restored('after Escape');
    await page.mouse.move(at(1.2), y, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(250);
    await restored('after release following Escape');

    // 2) Drag, then pointercancel: the committed frame returns.
    await page.mouse.move(at(0.25), y);
    await page.mouse.down();
    await page.mouse.move(at(0.7), y, { steps: 4 });
    await coherent('drag 2');
    const pointerId = await page.evaluate(() => (window as unknown as { fxPointer: number }).fxPointer);
    await slider.dispatchEvent('pointercancel', { pointerId, isPrimary: true, pointerType: 'mouse', bubbles: true });
    await restored('after pointercancel');
    await page.mouse.move(at(1.1), y, { steps: 3 });
    await page.mouse.up();
    await page.waitForTimeout(250);
    await restored('after release following pointercancel');

    // 3) Drag and release: exactly one new run.
    await page.mouse.move(at(0.25), y);
    await page.mouse.down();
    await page.mouse.move(at(0.75), y, { steps: 5 });
    const tentative = await coherent('drag 3');
    await page.mouse.up();
    await page.waitForFunction(run => { const current = window.studyHarnessFixture.binding!.getProjection(); return current.guards.expectedRunId !== run && current.frame?.kind === 'committed'; }, committedRun);
    await settle(page);
    const after = await projection(page);
    const eta = after.controls.find(item => item.parameter === 'eta')!.value;
    expect(after.frame!.frameId).not.toBe(tentative === committedFrame ? '' : committedFrame);
    expect(new Set((await renderedFrameIds(page)).map(item => item.frameId))).toEqual(new Set([after.frame!.frameId]));
    expect(numeral(await valueOf(page, 'Step size times curvature'))).toBeCloseTo(eta * 2, 9);

    const events = await hostEvents(page);
    const since = events.slice(events.findIndex(event => event.type === 'preview.started'));
    expect(types(since).filter(type => type === 'preview.started')).toHaveLength(3);
    expect(since.filter(event => event.type === 'preview.cancelled').map(event => (event.payload as { reason: string }).reason)).toEqual(['escape', 'pointercancel']);
    const commits = since.filter(event => event.type === 'parameters.committed');
    expect(commits).toHaveLength(1);
    expect(commits[0]!.payload).toMatchObject({ cause: 'commit', gesture: 'pointer', params: { eta } });
    // Cancelled previews keep the exposure: the exploration scope was displayed (on a tentative frame) and stays so.
    const scope = (await hostExposures(page)).filter(record => record.scope === 'exploration').at(-1)!;
    expect(scope.displayStatus).toBe('displayed');
    // Pointer moves never called the host: the only host calls since the drags began are journal/ack/save traffic.
    const calls = await page.evaluate(start => window.studyHarnessFixture.host.calls().slice(start).map(call => call.method), hostCallsBefore);
    expect(calls.filter(method => !['appendEvents', 'recordDisplayAck', 'saveArtifact'].includes(method))).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('late worker replies after a cancelled preview never appear (A40 A43)', async ({ page }) => {
    test.setTimeout(60_000);
    const errors = await openFixture(page, '?workerDelay=600');
    await toRevealedTrace(page);
    const committed = await projection(page);
    const slider = control(page, 'eta').getByRole('slider', { name: 'Step size η' });
    await slider.scrollIntoViewIfNeeded();
    const box = (await slider.boundingBox())!;
    const y = box.y + box.height / 2, at = (eta: number) => box.x + 8 + (box.width - 16) * eta / 2;
    const mark = await page.evaluate(() => window.studyHarnessFixture.projectionLog.length);
    await page.mouse.move(at(0.25), y);
    await page.mouse.down();
    await page.mouse.move(at(1.5), y, { steps: 3 });
    // The worker reply for the preview is still in flight; cancel before it arrives.
    await page.waitForTimeout(100);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await page.waitForTimeout(1500);
    const log = await page.evaluate(start => window.studyHarnessFixture.projectionLog.slice(start), mark);
    expect(log.some(entry => entry.previewId !== null), 'the preview started').toBe(true);
    expect(log.filter(entry => entry.frameKind === 'tentative'), 'no tentative frame was ever published').toEqual([]);
    const now = await projection(page);
    expect(now.frame!.frameId).toBe(committed.frame!.frameId);
    expect(now.guards.expectedRunId).toBe(committed.guards.expectedRunId);
    await expect(card(page).locator('[data-ema-figure][data-tentative="true"]')).toHaveCount(0);
    expect(new Set((await renderedFrameIds(page)).map(item => item.frameId))).toEqual(new Set([committed.frame!.frameId]));

    // Disposal while a navigation evaluation is in flight: nothing is published afterwards, the card is gone and the
    // adapter's workers are terminated.
    await card(page).getByRole('button', { name: 'Next iteration' }).click();
    await page.waitForTimeout(50);
    const disposedAt = await page.evaluate(() => {
      const fixture = window.studyHarnessFixture as unknown as { surface: { dispose(): void }; adapter: { dispose(id?: string): void }; projectionLog: unknown[] };
      fixture.surface.dispose();
      fixture.adapter.dispose();
      return fixture.projectionLog.length;
    });
    await page.waitForTimeout(1200);
    expect(await page.evaluate(start => window.studyHarnessFixture.projectionLog.slice(start), disposedAt)).toEqual([]);
    await expect(card(page)).toHaveCount(0);
    const workers = await page.evaluate(() => (window.studyHarnessFixture as unknown as { session: { workers: { created: number; terminated: number } } }).session.workers);
    expect(workers.created).toBeGreaterThan(0);
    expect(workers.terminated).toBe(workers.created);
    expect(errors).toEqual([]);
  });

  test('policy revocation during a preview cancels it, commits nothing and shows the stale-policy state (A40)', async ({ page }) => {
    const errors = await openFixture(page);
    await toRevealedTrace(page);
    const committed = await projection(page);
    const slider = control(page, 'eta').getByRole('slider', { name: 'Step size η' });
    await slider.scrollIntoViewIfNeeded();
    const box = (await slider.boundingBox())!;
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + 8 + (box.width - 16) * 0.125, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, y, { steps: 4 });
    await page.waitForFunction(() => window.studyHarnessFixture.binding!.getProjection().frame?.kind === 'tentative');
    await page.evaluate(() => window.studyHarnessFixture.session.revokePolicy());
    await page.mouse.move(box.x + box.width * 0.7, y, { steps: 3 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const now = await projection(page);
    expect(now.status.ui).toBe('stale-policy');
    expect(now.preview).toBeNull();
    expect(now.views).toEqual([]);
    expect(now.guards.expectedRunId).toBe(committed.guards.expectedRunId);
    await expect(card(page).locator('.ema-banner[data-ui-state="stale-policy"]')).toContainText('Permissions changed');
    const events = await hostEvents(page);
    expect(events.filter(event => event.type === 'preview.cancelled').map(event => (event.payload as { reason: string }).reason)).toEqual(['revoked']);
    expect(events.filter(event => event.type === 'parameters.committed').map(event => (event.payload as { cause: string }).cause)).toEqual(['initial']);
    await expectHidden(page, ['trace', 'observations', 'regime', 'substituted'], 'revoked', { capture: false });
    await expectAccessible(page, 'revoked');
    expect(errors).toEqual([]);
  });

  test('a host policy revoked at startup (?revoke=1) shows nothing new and refuses host steps (A22 A40)', async ({ page }) => {
    const errors = await openFixture(page, '?revoke=1');
    await expect(card(page).locator('.ema-banner[data-ui-state="stale-policy"]')).toBeVisible();
    expect((await projection(page)).views).toEqual([]);
    // The response reference is refused, the host rolls its record back and the next step stays blocked.
    await page.locator('#fx-response').fill('They shrink.');
    await page.locator('[data-fx-composer] button[type=submit]').click();
    await expect(page.locator('[data-fx-composer] [role=status]')).toHaveText('The host could not record the response (POLICY_DENIED).');
    expect((await tables(page)).responses).toEqual([]);
    await expect(page.locator('[data-fx-step="enable-exploration"]')).toHaveAttribute('aria-disabled', 'true');
    expect(types(await hostEvents(page))).not.toContain('response.submitted');
    expect((await projection(page)).stage.id).toBe('predict');
    expect(await hostExposures(page)).toEqual([]);
    await expectAccessible(page, 'revoked at startup');
    expect(errors).toEqual([]);
  });

  test('§17 restart sequence (browser): response, reveal, exploration, camera, save, terminate, reopen exact and paused with conservative exposures, then a fresh independent task (A20 A31 A48)', async ({ page }) => {
    test.setTimeout(90_000);
    const errors = await openFixture(page);
    await toRevealedTrace(page);
    // Commit an exploration (exact entry), move to an iteration and change the camera.
    await exact(page, 'eta', '0.75');
    await goTo(page, 3);
    await card(page).locator('[data-ema-figure="landscape"]').getByRole('button', { name: 'Zoom in' }).click();
    await expect.poll(async () => (await projection(page)).presentation.views.landscape?.camera).toMatchObject({ kind: '2d' });
    await settle(page);
    await page.getByRole('button', { name: 'Save backup now' }).click();
    await settle(page);
    const before = await hostState(page);
    const shownBefore = await projection(page);
    const eventsBefore = await hostEvents(page);
    const exposuresBefore = await hostExposures(page);
    expect(shownBefore.frame!.position).toMatchObject({ kind: 'index', index: 3 });

    // Terminate and reopen (reload of the tab = host restart; the host tables persist in sessionStorage).
    await page.reload();
    await page.waitForFunction(() => document.body.dataset.fixtureReady === 'true');
    await settle(page);
    const after = await hostState(page);
    const shown = await projection(page);
    expect(after.instance.activityId).toBe(before.instance.activityId);
    expect(after.scientific!.params).toEqual(before.scientific!.params);
    expect(after.scientific!.position).toEqual(before.scientific!.position);
    expect(after.scientific!.restoredFrom).toBe(before.scientific!.runId);
    expect(after.instance.stage.id).toBe('explore-step');
    expect(after.guards.activityRevision).toBe(before.guards.activityRevision);
    expect(shown.presentation.views.landscape?.camera).toEqual(shownBefore.presentation.views.landscape?.camera);
    expect(shown.status.ui).toBe('restored');
    expect(shown.navigation).toMatchObject({ value: 3, playing: false });
    await expect(card(page).locator('.ema-banner[data-ui-state="restored"]')).toContainText('Restored');
    await expect(card(page).locator('[data-ema-figure="landscape"]')).toContainText('Moved view');
    await expectShown(page, ['trace', 'observations'], 'restored');
    expect(numeral(await valueOf(page, 'Position'))).toBeCloseTo(-0.5, 12);
    await expectAccessible(page, 'restored');
    await shot(page, 'restored');

    // Event order: the journal continues gap-free; the restart adds artifact.restored and no reveal or response events.
    const eventsAfter = await hostEvents(page);
    eventsAfter.forEach((event, index) => expect(event.sequence).toBe(index + 1));
    expect(eventsAfter.slice(0, eventsBefore.length).map(event => event.eventId)).toEqual(eventsBefore.map(event => event.eventId));
    const added = types(eventsAfter.slice(eventsBefore.length));
    const reopenedAt = added.indexOf('artifact.restored');
    expect(reopenedAt).toBeGreaterThanOrEqual(0);
    // Before the restart only the unload is journaled (the hidden tab suspends the activity).
    expect(added.slice(0, reopenedAt).every(type => type === 'activity.suspended')).toBe(true);
    for (const type of ['reveal.requested', 'reveal.authorized', 'reveal.displayed', 'response.submitted', 'stage.changed', 'parameters.committed']) expect(added, type).not.toContain(type);
    // Conservative exposure history: displayed stays displayed; authorized-without-acknowledgement becomes uncertain.
    const exposuresAfter = await hostExposures(page);
    expect(exposuresAfter.map(record => record.exposureId)).toEqual(exposuresBefore.map(record => record.exposureId));
    for (const record of exposuresAfter) {
      const previous = exposuresBefore.find(item => item.exposureId === record.exposureId)!;
      if (previous.displayStatus === 'displayed') expect(record.displayStatus).toBe('displayed');
      else expect(record).toMatchObject({ displayStatus: 'uncertain', uncertainty: { code: 'INTERRUPTED_BEFORE_ACK' } });
    }
    const local = after.exposures!;
    expect(local.find(record => record.scope === 'reveal')!.displayStatus).toBe('displayed');
    expect(local.filter(record => record.displayStatus === 'authorized' || record.displayStatus === 'not-displayed')).toEqual([]);

    // Continue to a fresh independent task with the teaching visual unavailable.
    await step(page, 'add-curvature');
    await step(page, 'request-explanation');
    await respond(page, 'Their product decides the multiplier.');
    await step(page, 'close');
    await step(page, 'independent-task');
    const task = await projection(page);
    expect(task.context).toBe('independent');
    expect(task.views.map(view => view.viewId)).toEqual(['rules']);
    await expectHidden(page, ['trace', 'observations', 'regime', 'substituted'], 'task after restart', { capture: false });
    // A restart inside the task reopens it independent, still without the teaching visual.
    await page.reload();
    await page.waitForFunction(() => document.body.dataset.fixtureReady === 'true');
    await settle(page);
    const reopened = await projection(page);
    expect(reopened.activityId).toBe(task.activityId);
    expect(reopened.context).toBe('independent');
    expect(reopened.views.map(view => view.viewId)).toEqual(['rules']);
    expect(errors).toEqual([]);
  });

  for (const [crash, expectation] of [
    ['before-intent', 'unseen: the host committed nothing'],
    ['after-intent', 'authorized, never displayed: uncertain at restart, then the same receipt on resume'],
    ['after-display', 'displayed before the acknowledgement was committed: uncertain at restart, never unseen'],
  ] as const) {
    test(`§17 crash ${crash} during the trace reveal: ${expectation} (A20 A23)`, async ({ page }) => {
      test.setTimeout(60_000);
      await openFixture(page, `?crash=${crash}`);
      await respond(page, 'They shrink.');
      await step(page, 'enable-exploration');
      await page.locator('[data-fx-step="reveal-trace"]').click();
      await expect(page.getByRole('alert')).toContainText('Host process terminated');
      await expect(card(page)).toHaveCount(0);
      const id = await page.evaluate(() => Object.keys(window.studyHarnessFixture.host.snapshot().activities)[0]!);
      const atCrash = (await hostExposures(page, id)).filter(record => record.scope === 'reveal');
      const receiptsAtCrash = await page.evaluate(key => window.studyHarnessFixture.host.snapshot().activities[key]!.receipts.length, id);
      if (crash === 'before-intent') expect(atCrash).toEqual([]);
      else expect(atCrash).toEqual([expect.objectContaining({ displayStatus: 'authorized', acked: false })]);

      await page.getByRole('button', { name: 'Relaunch the host' }).click();
      await page.waitForFunction(() => document.body.dataset.fixtureReady === 'true');
      await settle(page);
      // The host's restart rule also marks unused exploration scopes uncertain; only the reveal record matters here.
      const recoveries = (await page.evaluate(() => window.studyHarnessFixture.host.snapshot().recoveries)).filter(item => atCrash.some(record => record.exposureId === item.exposureId));
      const restored = await projection(page);
      expect(restored.stage.id).toBe('explore-step');
      if (crash === 'after-display') {
        // The reveal had been applied and displayed: the restored card shows it again under the restored grant.
        expect(recoveries.map(item => item.exposureId)).toEqual([atCrash[0]!.exposureId]);
        await expectShown(page, ['trace', 'observations'], 'after-display restart');
        await expect.poll(async () => (await hostExposures(page, id)).filter(record => record.scope === 'reveal'))
          .toEqual([expect.objectContaining({ exposureId: atCrash[0]!.exposureId, displayStatus: 'displayed', acked: true })]);
        // The interrupted host step resumes: the reveal is already shown, so only the exploration scope is requested.
        await expect(page.locator('[data-fx-step="reveal-trace"]')).toHaveText('Resume: Reveal the iteration trace');
        await step(page, 'reveal-trace');
        expect((await hostExposures(page, id)).filter(record => record.scope === 'reveal')).toHaveLength(1);
      } else {
        if (crash === 'after-intent') {
          expect(recoveries.map(item => item.exposureId)).toEqual([atCrash[0]!.exposureId]);
          expect((await hostExposures(page, id)).filter(record => record.scope === 'reveal')).toEqual([expect.objectContaining({ displayStatus: 'uncertain', uncertainty: expect.objectContaining({ code: 'INTERRUPTED_BEFORE_ACK' }) })]);
        } else expect(recoveries).toEqual([]);
        // Nothing was displayed: the restored card does not show the trace until the host resumes the interrupted step.
        await expectHidden(page, ['trace', 'observations'], `${crash} restart`, { capture: false });
        await expect(page.locator('[data-fx-step="reveal-trace"]')).toHaveText('Resume: Reveal the iteration trace');
        await step(page, 'reveal-trace');
        await expectShown(page, ['trace', 'observations'], `${crash} resumed`);
        const records = (await hostExposures(page, id)).filter(record => record.scope === 'reveal');
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({ displayStatus: 'displayed', acked: true });
        if (crash === 'after-intent') {
          expect(records[0]!.exposureId).toBe(atCrash[0]!.exposureId);
          // The resumed request reused its idempotency key: the host returned the committed receipt, no second one.
          const receipts = await page.evaluate(key => window.studyHarnessFixture.host.snapshot().activities[key]!.receipts.length, id);
          expect(receipts).toBe(receiptsAtCrash + 1);
        }
      }
      const events = await hostEvents(page, id);
      events.forEach((event, index) => expect(event.sequence).toBe(index + 1));
      expect(events.filter(event => event.type === 'reveal.requested' && (event.payload as { scope: string }).scope === 'reveal')).toHaveLength(1);
      const authorized = types(events).filter(type => type === 'reveal.authorized').length;
      if (crash === 'after-display' && authorized === 0) {
        // Events emitted in the same turn as the crash never reached the host journal; the restore reports them as
        // unacknowledged at the checkpoint (lost, never replayed) while the host's exposure record stays authoritative.
        expect((await page.evaluate(() => window.studyHarnessFixture.session.getSnapshot().restoredNotes)).join(' ')).toMatch(/unacknowledged when the artifact was saved/);
      } else expect(authorized).toBe(1);
      expect(types(events).filter(type => type === 'response.submitted')).toHaveLength(1);
      expect(types(events)).toContain('artifact.restored');
    });
  }

  test('entering an independent task removes instructional output and invalidates the pending reveal (A25)', async ({ page }) => {
    // The host commits the reveal intent at once but its reply arrives 1.5 s later (a late receipt).
    const errors = await openFixture(page, '?lag=exposure-intent:1500');
    await respond(page, 'They shrink.');
    await step(page, 'enable-exploration');
    await page.locator('[data-fx-step="reveal-trace"]').click();
    await expect(card(page).locator('.ema-banner[data-cause="saving-reveal"]')).toContainText('The host is recording this step before showing');
    await expectHidden(page, ['trace', 'observations'], 'reveal requesting', { capture: false });
    await page.getByRole('button', { name: 'Interrupt: independent task here' }).click();
    await expect(card(page).getByText('Independent task', { exact: true })).toBeVisible();
    const interrupted = await projection(page);
    expect(interrupted).toMatchObject({ context: 'independent', pendingReveal: null, controls: [], navigation: null, comparisons: [] });
    expect(interrupted.views.map(view => view.viewId)).toEqual(['rules']);
    await expect(card(page).locator('.ema-pending, .ema-banner[data-cause="saving-reveal"]')).toHaveCount(0);
    // The late receipt for the committed intent is never applied: nothing appears. The host committed it, so the adapter
    // follows the host-owned activity revision and keeps the authorization as history that never counts (R04).
    await page.waitForFunction(() => window.studyHarnessFixture.session.getSnapshot().steps.find(item => item.id === 'reveal-trace')?.state !== 'running');
    await settle(page);
    const late = await projection(page);
    expect(late.views.map(view => view.viewId)).toEqual(['rules']);
    expect(late.context).toBe('independent');
    const id = await activityId(page);
    expect(late.activityRevision).toBe(await page.evaluate(key => window.studyHarnessFixture.host.snapshot().activities[key]!.activityRevision, id));
    expect((await hostState(page)).exposures!.filter(record => record.scope === 'reveal')).toEqual([expect.objectContaining({ displayStatus: 'authorized' })]);
    expect((await hostExposures(page)).filter(record => record.scope === 'reveal')).toEqual([expect.objectContaining({ displayStatus: 'authorized', acked: false })]);
    const events = types(await hostEvents(page));
    expect(events).toContain('context.independent-entered');
    expect(events.filter(type => type === 'reveal.authorized')).toHaveLength(1);
    expect(events.indexOf('reveal.authorized')).toBeGreaterThan(events.indexOf('context.independent-entered'));
    await expectHidden(page, ['trace', 'observations', 'regime', 'substituted'], 'after interrupt', { capture: false });
    for (const teaching of ['Objective landscape', 'Step size η', 'Comparison scenarios']) expect((await card(page).evaluate(host => host.shadowRoot!.textContent ?? ''))).not.toContain(teaching);
    await expectAccessible(page, 'interrupted');
    expect(errors).toEqual([]);
  });

  test('reopening the teaching visual goes through host assistance persistence and never rewrites a submitted answer snapshot (A26)', async ({ page }) => {
    const errors = await openFixture(page);
    await toRevealedTrace(page);
    await page.getByRole('button', { name: 'Interrupt: independent task here' }).click();
    await expect(card(page).getByText('Independent task', { exact: true })).toBeVisible();
    await expectHidden(page, ['trace', 'observations'], 'independent', { capture: false });
    await respond(page, 'x₃ = −0.5');
    const answer = (await tables(page)).responses.find(entry => entry.ref.kind === 'answer')!;
    const frozen = await page.evaluate(id => (window.studyHarnessFixture as unknown as { frozen(id: string): { cursor: number; assistance: unknown[]; exposures: unknown[] } }).frozen(id), answer.ref.responseId);
    expect(frozen.cursor).toBe(answer.snapshotCursor);
    expect(frozen.assistance).toEqual([]);
    const callsBefore = await page.evaluate(() => window.studyHarnessFixture.host.calls().length);

    await page.getByRole('button', { name: 'Reopen teaching visual (assistance)' }).click();
    await page.waitForFunction(() => window.studyHarnessFixture.binding!.getProjection().context === 'instructional');
    await settle(page);
    await expectShown(page, ['trace', 'observations'], 'reopened');
    // The host recorded the assistance before anything was shown again.
    const calls = await page.evaluate(start => window.studyHarnessFixture.host.calls().slice(start).map(call => `${call.method}:${call.outcome}`), callsBefore);
    expect(calls.indexOf('recordAssistance:ok')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('recordAssistance:ok')).toBeLessThan(calls.indexOf('recordDisplayAck:ok'));
    const events = types(await hostEvents(page));
    expect(events.indexOf('assistance.recorded')).toBeGreaterThan(events.indexOf('context.independent-entered'));
    expect(events.indexOf('assistance.recorded')).toBeLessThan(events.indexOf('context.instructional-reopened'));
    // The answer's frozen snapshot and the host's binding to it are unchanged by the later assistance.
    const after = await page.evaluate(id => (window.studyHarnessFixture as unknown as { frozen(id: string): unknown }).frozen(id), answer.ref.responseId);
    expect(after).toEqual(frozen);
    expect((await tables(page)).responses.find(entry => entry.ref.responseId === answer.ref.responseId)!.snapshotCursor).toBe(answer.snapshotCursor);
    await expectAccessible(page, 'reopened');
    expect(errors).toEqual([]);
  });

  test('capture: SVG and PNG of the exact surface, never a second mounted card, rejected during a preview (A50)', async ({ page }) => {
    const errors = await openFixture(page);
    await toRevealedTrace(page);
    const shown = await projection(page);
    const surfaceId = await page.evaluate(() => window.studyHarnessFixture.surface!.surfaceId);
    const firstWidth = await card(page).locator('svg[data-ema-view-id="landscape"]').evaluate(svg => (svg as SVGSVGElement).viewBox.baseVal.width);
    // A second card of the same activity at another width must not be the one captured.
    const extra = await page.evaluate(() => window.studyHarnessFixture.session.mountExtra(300));
    await expect(page.locator('[data-fx-extra-card] [data-explorable-models-activity]')).toHaveCount(1);
    const extraWidth = await page.locator('[data-fx-extra-card] svg[data-ema-view-id="landscape"]').evaluate(svg => (svg as SVGSVGElement).viewBox.baseVal.width);
    expect(extraWidth).not.toBe(firstWidth);
    const now = await projection(page);

    const svg = await page.evaluate(() => window.studyHarnessFixture.capture('svg', 'landscape'));
    expect(svg.metadata).toMatchObject({ surfaceId, viewId: 'landscape', projectionId: now.projectionId, frameId: shown.frame!.frameId, activityRevision: now.activityRevision });
    expect(svg.metadata.surfaceId).not.toBe(extra);
    expect(svg.svg!.startsWith('<svg')).toBe(true);
    expect(svg.svg).not.toContain('foreignObject');
    expect(svg.svg).toContain(`width="${firstWidth}"`);
    expect(svg.svg).not.toContain(`width="${extraWidth}"`);
    expect(svg.companionText).toContain('Objective landscape');
    expect(svg.companionText).toContain('Position: n = 0 of 1000');
    for (const marker of ['Update rule with current values', 'Largest convergent step size', 'Regime']) expect(`${svg.svg}${svg.companionText}${JSON.stringify(svg.metadata)}`).not.toContain(marker);

    const png = await page.evaluate(() => window.studyHarnessFixture.capture('png', 'trace-plot'));
    expect(png.metadata).toMatchObject({ surfaceId, viewId: 'trace-plot', frameId: shown.frame!.frameId });
    const header = pngSize(png.pngBase64!);
    expect(header).toEqual({ width: png.width, height: png.height, signature: true });
    const decoded = await page.evaluate(async data => { const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode(); return [image.naturalWidth, image.naturalHeight]; }, png.pngBase64!);
    expect(decoded).toEqual([png.width, png.height]);
    expect(png.width).toBeGreaterThan(300);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(`${SHOTS}/capture-trace-plot.png`, Buffer.from(png.pngBase64!, 'base64'));

    // During a preview the capture is refused (a tentative frame is not a committed run).
    const slider = control(page, 'eta').getByRole('slider', { name: 'Step size η' });
    await slider.scrollIntoViewIfNeeded();
    const box = (await slider.boundingBox())!;
    await page.mouse.move(box.x + 8 + (box.width - 16) * 0.125, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2, { steps: 3 });
    await page.waitForFunction(() => window.studyHarnessFixture.binding!.getProjection().frame?.kind === 'tentative');
    const refused = await page.evaluate(() => window.studyHarnessFixture.capture('svg').then(() => 'captured', (error: Error & { code?: string }) => `${error.code}: ${error.message}`));
    expect(refused).toMatch(/^CAPTURE_REJECTED: A tentative preview is shown/);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await page.evaluate(() => window.studyHarnessFixture.session.disposeExtra());
    expect(errors).toEqual([]);
  });

  test('alternative trace-table-equivalent: the trace table lists exactly the (n, xₙ) pairs of the trace plot (§12.3 η = 0.75 case)', async ({ page }) => {
    await openFixture(page);
    await toRevealedTrace(page);
    await card(page).getByRole('button', { name: 'η = 0.75', exact: true }).click();
    await settle(page);
    await goTo(page, 3);
    const toggle = card(page).getByRole('button', { name: 'Trace table' });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    const table = card(page).getByRole('table');
    await expect(table).toBeVisible();
    await expect(table.locator('thead th')).toHaveText(['Iteration n (iter)', 'Position x_n']);
    const rows = await table.locator('tbody tr').evaluateAll(trs => trs.map(tr => [...tr.children].map(cell => cell.textContent ?? '')));
    expect(rows.map(row => row.map(numeral))).toEqual([[0, 4], [1, -2], [2, 1], [3, -0.5]]);
    // The same pairs the plot draws (projection geometry of the trace-plot mark).
    const plotted = (await projection(page)).views.find(view => view.viewId === 'trace-plot')!.marks[0]!.geometry as { points: { at: number[] }[] };
    expect(plotted.points.map(point => point.at)).toEqual(rows.map(row => row.map(numeral)));
    // The scrollable table region is a keyboard stop with the table's name.
    await expect(card(page).locator('.ema-table-region')).toHaveAttribute('tabindex', '0');
    await expectAccessible(page, 'trace table');
  });

  test('alternative landscape-equivalent: the objective equation, start and current values and the trace table carry every landscape mark', async ({ page }) => {
    await openFixture(page);
    await toRevealedTrace(page);
    await card(page).getByRole('button', { name: 'η = 0.75', exact: true }).click();
    await settle(page);
    await goTo(page, 3);
    await card(page).getByRole('button', { name: 'Trace table' }).click();
    const a = numeral((await control(page, 'a').locator('output').textContent()) ?? '');
    expect(a).toBe(2);
    await card(page).locator('[data-ema-panel="equations"]').getByRole('button', { name: 'Plain text' }).click();
    await expect(card(page).locator('[data-ema-panel="equations"]')).toContainText('f(x) = (a/2)·x²');
    const objective = (x: number) => a * x * x / 2;
    const landscape = (await projection(page)).views.find(view => view.viewId === 'landscape')!;
    const mark = (id: string) => landscape.marks.find(item => item.markId === id)!;
    // Start marker = (Starting position, Starting loss).
    expect(mark('start-marker').at).toEqual([numeral(await valueOf(page, 'Starting position')), numeral(await valueOf(page, 'Starting loss'))]);
    // Current iterate = (Position, Loss) at n = 3.
    expect(mark('current-iterate').at).toEqual([numeral(await valueOf(page, 'Position')), numeral(await valueOf(page, 'Loss'))]);
    // Iterates = (xₖ from the trace table, f(xₖ) from the objective equation with the shown curvature).
    const xs = (await card(page).getByRole('table').locator('tbody tr td').allTextContents()).map(numeral);
    const iterates = (mark('iterate-points').geometry as { points: { at: number[] }[] }).points.map(point => point.at);
    expect(iterates).toEqual(xs.map(x => [x, objective(x)]));
    // Steps join successive iterates.
    const steps = (mark('iterate-steps').geometry as { segments: { from: number[]; to: number[] }[] }).segments;
    expect(steps.map(segment => [segment.from[0], segment.to[0]])).toEqual(xs.slice(1).map((x, index) => [xs[index], x]));
  });

  test('alternative text-description: generated summaries of each plot, from visible content only', async ({ page }) => {
    await openFixture(page);
    const toggle = card(page).getByRole('button', { name: 'Text description' });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    const before = card(page).locator('[data-ema-figure="landscape"] .ema-description');
    await expect(before).toHaveText('Objective landscape. Shows Objective f(x); Starting point (x₀, f(x₀)).');
    await toggle.click();
    await toRevealedTrace(page);
    await card(page).getByRole('button', { name: 'Text description' }).click();
    const views = (await projection(page)).views;
    for (const id of ['landscape', 'trace-plot']) {
      const description = card(page).locator(`[data-ema-figure="${id}"] .ema-description`);
      await expect(description).toBeVisible();
      await expect(description).toHaveText(views.find(view => view.viewId === id)!.summary);
      const describedBy = await card(page).locator(`svg[data-ema-view-id="${id}"]`).getAttribute('aria-describedby');
      expect(await description.getAttribute('id')).toBe(describedBy);
    }
    await expect(card(page).locator('[data-ema-figure="trace-plot"] .ema-description')).toContainText('Position x_n at each iteration n');
    // The equivalence is declared partial: the summary names what is drawn rather than listing every point.
    await card(page).getByText('Other ways to work with this activity').click();
    await expect(card(page).locator('.ema-alternatives dt').filter({ hasText: 'Text description' })).toContainText('Partial');
  });

  test('alternative exact-entry: typed values commit exactly; invalid input is explained, kept as typed and never changed into another experiment', async ({ page }) => {
    const errors = await openFixture(page, '?mode=free');
    await exact(page, 'eta', '0.75');
    let shown = await projection(page);
    expect(shown.controls.find(item => item.parameter === 'eta')!.value).toBe(0.75);
    await goTo(page, 1);
    expect(numeral(await valueOf(page, 'Position'))).toBe(-2);
    const run = shown.guards.expectedRunId;
    for (const [value, message] of [['2.5', /Enter a value from 0 to 2|outside|range/i], ['abc', /is not a number/]] as const) {
      const box = control(page, 'eta').getByRole('textbox');
      await box.fill(value);
      await box.press('Enter');
      await expect(control(page, 'eta').locator('.ema-error')).toContainText(message);
      await expect(box).toHaveValue(value);
      await expect(box).toHaveAttribute('aria-invalid', 'true');
      expect((await projection(page)).guards.expectedRunId).toBe(run);
    }
    await expectAccessible(page, 'exact entry error');
    // Coupled constraint η·a ≤ 4: η = 1.5 with a = 3 is refused. η and a are both controls here, so the error under the
    // curvature control states the model's own learner-safe limit (G27); the typed draft stays and the run is unchanged.
    await exact(page, 'eta', '1.5');
    shown = await projection(page);
    const box = control(page, 'a').getByRole('textbox');
    await box.fill('3');
    await box.press('Enter');
    await expect(control(page, 'a').locator('.ema-error')).toContainText('The step size times the curvature (η·a) can be at most 4');
    await expect(box).toHaveValue('3');
    await expect(box).toHaveAttribute('aria-invalid', 'true');
    expect((await projection(page)).guards.expectedRunId).toBe(shown.guards.expectedRunId);
    expect((await projection(page)).controls.find(item => item.parameter === 'a')!.value).toBe(2);
    // Whole iterations only.
    const goto = card(page).getByRole('textbox', { name: 'Go to n =' });
    await goto.fill('2.5');
    await goto.press('Enter');
    await expect(card(page).locator('.ema-nav .ema-error')).toContainText('Iterations are whole numbers');
    expect(errors).toEqual([]);
  });

  test('keyboard-only: the whole quadratic flow completes without a pointer (A36)', async ({ page }) => {
    test.setTimeout(150_000);
    const errors = await openFixture(page);
    await page.evaluate(() => {
      const count = { pointer: 0 };
      (window as unknown as { fxPointer: typeof count }).fxPointer = count;
      for (const type of ['pointerdown', 'mousedown', 'click']) document.addEventListener(type, event => { if ((event as MouseEvent).detail > 0 || type !== 'click') count.pointer++; }, { capture: true });
    });
    const respondByKeyboard = async (text: string) => {
      await tabTo(page, info => info.id === 'fx-response', 'the host composer');
      await page.keyboard.type(text);
      await page.keyboard.press(focusKey(page));
      expect((await focused(page))?.name).toMatch(/^Submit /);
      await page.keyboard.press('Enter');
      await expect(page.locator('[data-fx-composer]')).toHaveCount(0);
      await settle(page);
    };
    const hostStep = async (id: string) => {
      await tabTo(page, info => info.step === id, `host step ${id}`);
      await page.keyboard.press('Enter');
      await page.waitForFunction(stepId => window.studyHarnessFixture.session.getSnapshot().steps.find(item => item.id === stepId)?.state === 'done', id);
      await settle(page);
    };
    const inCard = (name: string | RegExp, tag?: string) => (info: { name: string; inCard: boolean; tag: string }) => info.inCard && (!tag || info.tag === tag) && (typeof name === 'string' ? info.name === name : name.test(info.name));

    await respondByKeyboard('Small steps shrink, large steps overshoot.');
    await hostStep('enable-exploration');
    await hostStep('reveal-trace');

    // Step size by keyboard: each arrow press is one keyboard preview committed on key up.
    await tabTo(page, inCard('Step size η', 'input'), 'the step-size slider', { backwards: true });
    const run = (await projection(page)).guards.expectedRunId;
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await projection(page)).controls.find(item => item.parameter === 'eta')!.value).toBe(0.3);
    expect((await projection(page)).guards.expectedRunId).not.toBe(run);
    // A held arrow key previews; Escape cancels before the key is released, so nothing is committed.
    const committed = (await projection(page)).guards.expectedRunId;
    await page.keyboard.down('ArrowRight');
    await page.keyboard.press('Escape');
    await page.keyboard.up('ArrowRight');
    await settle(page);
    expect((await projection(page)).guards.expectedRunId).toBe(committed);
    expect((await projection(page)).controls.find(item => item.parameter === 'eta')!.value).toBe(0.3);

    // Exact entry by keyboard.
    await page.keyboard.press(focusKey(page));
    expect(await focused(page)).toMatchObject({ name: 'Exact value for Step size η' });
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('0.75');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await projection(page)).controls.find(item => item.parameter === 'eta')!.value).toBe(0.75);
    await settle(page);

    // One whole iteration at a time through the roving iteration toolbar.
    await tabTo(page, info => info.inCard && /^(⏮ ?n = 0|Back one iteration|Next iteration|Play|Restart)/.test(info.name), 'the iteration toolbar', { backwards: true });
    await arrowTo(page, inCard('Next iteration'), 'Next iteration');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await projection(page)).navigation?.value).toBe(1);
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await projection(page)).navigation?.value).toBe(2);
    await settle(page);
    expect(numeral(await valueOf(page, 'Position'))).toBe(1);

    // The trace table is reachable and scrollable by keyboard.
    await tabTo(page, inCard('Trace table', 'button'), 'the trace table toggle');
    await page.keyboard.press('Space');
    await tabTo(page, info => info.inCard && info.tag === 'div' && info.name === 'Trace table', 'the trace table region');
    await expect(card(page).getByRole('table')).toBeVisible();

    await hostStep('add-curvature');
    await tabTo(page, inCard('Curvature a', 'input'), 'the curvature slider', { backwards: true });
    await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => (await projection(page)).controls.find(item => item.parameter === 'a')!.value).toBeCloseTo(1.9, 12);
    await settle(page);
    await hostStep('request-explanation');
    await respondByKeyboard('The product of η and a sets the multiplier.');
    await hostStep('close');
    await hostStep('independent-task');
    await respondByKeyboard('x₃ = −0.5');
    await expect(page.locator('[data-fx-complete]')).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { fxPointer: { pointer: number } }).fxPointer.pointer)).toBe(0);
    expect(errors).toEqual([]);
  });

  /** Controls are inside the card, at least 24 px high and usable: an exact entry commits. */
  const expectUsable = async (page: Page, label: string) => {
    const cardBox = (await card(page).locator('.ema').first().boundingBox())!;
    for (const target of [control(page, 'eta').getByRole('slider'), control(page, 'eta').getByRole('textbox'), control(page, 'eta').getByRole('button', { name: 'Apply' }), card(page).getByRole('button', { name: 'Next iteration' })]) {
      await expect(target, label).toBeVisible();
      const box = (await target.boundingBox())!;
      expect(box.x, `${label}: left edge`).toBeGreaterThanOrEqual(cardBox.x - 1);
      expect(box.x + box.width, `${label}: right edge`).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1);
      expect(box.height, `${label}: target height`).toBeGreaterThanOrEqual(24);
    }
    await exact(page, 'eta', '0.5');
    expect(numeral(await valueOf(page, 'Step size times curvature')), label).toBe(1);
  };

  test('layout: container widths 320, 390, 640, 960 and desktop keep every control usable without horizontal overflow (A32)', async ({ context }) => {
    test.setTimeout(120_000);
    for (const width of [320, 390, 640, 960, null] as const) {
      const page = await context.newPage();
      const errors = await openFixture(page, `?mode=free${width ? `&width=${width}` : ''}`);
      await goTo(page, 3);
      const facts = await overflow(page);
      expect(facts, `width ${width ?? 'desktop'}`).toMatchObject({ page: false, card: false, offenders: [] });
      if (width) expect(Math.abs(facts.cardWidth - width), `card width ${width}`).toBeLessThanOrEqual(2);
      for (const id of ['landscape', 'trace-plot']) {
        const svg = (await card(page).locator(`svg[data-ema-view-id="${id}"]`).boundingBox())!;
        expect(svg.width, `${id} at ${width}`).toBeLessThanOrEqual(facts.cardWidth);
      }
      await expectUsable(page, `width ${width ?? 'desktop'}`);
      expect((await overflow(page)).card).toBe(false);
      if (width === 320 || width === null) await expectAccessible(page, `width ${width ?? 'desktop'}`);
      await shot(page, width ? `container-${width}` : 'desktop');
      expect(errors).toEqual([]);
      await page.close();
    }
  });

  test('layout: mobile viewport 390, dark mode and 200% text keep the card readable and usable (A32 A36)', async ({ context }) => {
    test.setTimeout(120_000);
    const configurations = [
      { name: 'mobile-390', query: '?mode=free', viewport: { width: 390, height: 844 } },
      { name: 'dark', query: '?mode=free&theme=dark', viewport: { width: 1440, height: 1000 } },
      { name: 'text-200', query: '?mode=free&text=200', viewport: { width: 1440, height: 1000 } },
      { name: 'text-200-container-390', query: '?mode=free&text=200&width=390', viewport: { width: 1440, height: 1000 } },
    ];
    for (const configuration of configurations) {
      const page = await context.newPage();
      await page.setViewportSize(configuration.viewport);
      const errors = await openFixture(page, configuration.query);
      await goTo(page, 3);
      expect(await overflow(page), configuration.name).toMatchObject({ page: false, card: false, offenders: [] });
      if (configuration.name === 'dark') await expect(card(page).locator('.ema')).toHaveAttribute('data-theme', 'dark');
      if (configuration.name.startsWith('text-200')) {
        const size = await card(page).locator('.ema-title').evaluate(element => parseFloat(getComputedStyle(element).fontSize));
        expect(size, 'title font size doubles with the root text size').toBeGreaterThan(30);
      }
      await expectUsable(page, configuration.name);
      await expectAccessible(page, configuration.name);
      await shot(page, configuration.name);
      expect(errors).toEqual([]);
      await page.close();
    }
  });

  test('the end of a run does not tell a hidden trace\'s outcome: η·a = 4 at n = 1000 reads like any run until the trace is revealed (A21; R02)', async ({ page }) => {
    const errors = await openFixture(page);
    await respond(page, 'Small steps shrink the positions; larger ones overshoot and may grow.');
    await step(page, 'enable-exploration');
    await exact(page, 'eta', '2');
    await goTo(page, 1000);
    const hidden = await projection(page);
    expect(hidden.status).toMatchObject({ ui: 'boundary', message: 'The last available step is reached.' });
    expect(hidden.frame).toMatchObject({ terminal: true, terminalDetail: 'The last available step is reached.' });
    await expect(card(page).locator('.ema-terminal')).toHaveText('End of the computed run: The last available step is reached.');
    const text = await card(page).evaluate(host => host.shadowRoot!.textContent ?? '');
    for (const outcome of ['numerical limit, not a computed value', 'Playback stopped before a value', 'Its last finite value', 'beyond the range that can be represented']) expect(text).not.toContain(outcome);
    await expectHidden(page, ['trace', 'observations', 'regime', 'substituted'], 'end of a run with the trace hidden', { capture: false });
    await expectAccessible(page, 'end of a run with the trace hidden');
    await shot(page, 'r02-hidden-end-of-run');
    // Playback crosses the limit the card does not show, as for any run: from n = 990 (past the limit at n = 645) Play is
    // offered, is not refused and runs to the last step with no error banner or notice (R02).
    await goTo(page, 990);
    const play = card(page).getByRole('button', { name: 'Play' });
    await expect(play).not.toHaveAttribute('aria-disabled', 'true');
    await play.click();
    await expect.poll(async () => { const now = await projection(page); return [now.navigation?.value, now.navigation?.playing]; }, { timeout: 20_000 }).toEqual([1000, false]);
    await settle(page);
    await expect(card(page).getByText('That change was not applied')).toHaveCount(0);
    expect((await projection(page)).status).toMatchObject({ ui: 'boundary', message: 'The last available step is reached.' });
    const played = await card(page).evaluate(host => host.shadowRoot!.textContent ?? '');
    for (const outcome of ['numerical limit, not a computed value', 'Playback stopped before a value', 'Its last finite value', 'That value is outside the allowed range.']) expect(played).not.toContain(outcome);
    await shot(page, 'r02-hidden-played-to-end');
    // Revealed, the trace reaches the limit and the card says so.
    await step(page, 'reveal-trace');
    await settle(page);
    await expect(card(page).locator('.ema-banner[data-ui-state="boundary"]')).toContainText('numerical limit, not a computed value');
    await expect(card(page).locator('.ema-terminal')).toContainText('numerical limit, not a computed value');
    await shot(page, 'r02-revealed-end-of-run');
    expect(errors).toEqual([]);
  });

  test('boundary, divergence and limit states read truthfully: η·a = 2 oscillation and a numerical limit at a large index (§12.3, A34)', async ({ page }) => {
    const errors = await openFixture(page, '?mode=free');
    // Boundary η·a = 2: fixed-magnitude oscillation.
    await exact(page, 'eta', '1');
    await goTo(page, 5);
    expect(await valueOf(page, 'Regime')).toBe('oscillation');
    expect(numeral(await valueOf(page, 'Step size times curvature'))).toBe(2);
    expect(numeral(await valueOf(page, 'Update multiplier'))).toBe(-1);
    expect(numeral(await valueOf(page, 'Position'))).toBe(-4);
    await card(page).getByRole('button', { name: 'Trace table' }).click();
    const xs = (await card(page).getByRole('table').locator('tbody tr td').allTextContents()).map(numeral);
    expect(xs).toEqual([4, -4, 4, -4, 4, -4]);
    await expect(card(page).locator('[data-ema-panel="values"] dd').filter({ hasText: '-' })).toHaveCount(0);
    // A paused run at n = 5 is a calm state: no status banner.
    expect((await projection(page)).status.ui).toBe('paused');
    await expect(card(page).locator('.ema-banner')).toHaveCount(0);
    // The out-of-view line's sizing copy reserves its height without text: the card's text, and what selecting the line
    // copies, never say values are outside the view while the visible line says every drawn value is inside it (F5).
    const traceSlot = card(page).locator('[data-ema-figure="trace-plot"] [data-ema-clip-slot]');
    await expect(traceSlot).toContainText('All drawn values are inside the view.');
    const calmText = await card(page).evaluate(host => host.shadowRoot!.textContent ?? '');
    expect(calmText).toContain('All drawn values are inside the view.');
    expect(calmText).not.toContain('Some values are outside the view');
    expect(await traceSlot.evaluate(element => (element as HTMLElement).innerText)).not.toContain('Some values are outside the view');
    const sizer = traceSlot.locator('[data-ema-clip-sizer]');
    await expect(sizer).toHaveAttribute('aria-hidden', 'true');
    expect(await sizer.evaluate(element => element.textContent)).toBe('');
    expect((await sizer.boundingBox())!.height).toBeGreaterThan(10);
    expect(await card(page).locator('[data-ema-clip-sizer]').evaluateAll(sizers => sizers.every(element => element.textContent === ''))).toBe(true);
    await shot(page, 'boundary-eta-a-2');

    // Divergence (η·a = 4): beyond n = 644 the position is a numerical limit, never a fabricated number.
    await exact(page, 'eta', '2');
    await goTo(page, 700);
    const shown = await projection(page);
    expect(shown.status.ui).toBe('boundary');
    // The cause agrees with the message: a numerical-limit end (F6).
    expect(shown.status).toMatchObject({ message: 'The next value cannot be represented; this is a numerical limit, not a computed value.', cause: 'numerical-limit' });
    expect(shown.frame).toMatchObject({ terminal: true, terminalDetail: 'The next value cannot be represented; this is a numerical limit, not a computed value.' });
    await expect(card(page).locator('.ema-banner[data-ui-state="boundary"]')).toContainText('numerical limit, not a computed value');
    const position = card(page).locator('[data-ema-panel="values"] .ema-value-row').filter({ has: page.locator('dt:text-is("Position")') });
    await expect(position).toHaveAttribute('data-status', 'numerical-limit');
    await expect(position.locator('dd').first()).toHaveText(/^Beyond numerical range; last finite index 644\s*limit$/);
    await expect(position.locator('.ema-value-reason')).toHaveText('The position exceeds the largest representable number from n = 645; the last finite value is at n = 644.');
    expect(await valueOf(page, 'Regime')).toBe('divergence');
    const lastRows = await card(page).getByRole('table').locator('tbody tr').evaluateAll(rows => rows.slice(-2).map(row => [...row.children].map(cell => cell.textContent ?? '')));
    // Trace tables carry six significant digits (readouts keep four: the position readout states the limit instead).
    expect(lastRows[0]![1]).toBe('7.38156 × 10³⁰⁷');
    expect(lastRows[1]).toEqual([expect.stringMatching(/^Not available: Trace stops/)]);
    // The note row spans the table, so the position column stays in view without horizontal scrolling.
    const region = card(page).locator('.ema-table-region');
    expect(await region.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await expect(card(page).locator('[data-ema-figure="trace-plot"] .ema-clip')).toContainText('Some values are outside the view');
    // The sizing copy still reserves at least the height of the visible line it stands in for (F5).
    const limitSlot = card(page).locator('[data-ema-figure="trace-plot"] [data-ema-clip-slot]');
    expect((await limitSlot.locator('[data-ema-clip-sizer]').boundingBox())!.height).toBeGreaterThanOrEqual((await limitSlot.locator('.ema-clip').boundingBox())!.height - 0.5);
    await expect(card(page).locator('[data-ema-figure="landscape"] .ema-notes')).not.toContainText('..');
    await expectAccessible(page, 'numerical limit');
    await shot(page, 'divergence-limit');
    await card(page).locator('[data-ema-panel="values"]').screenshot({ path: `${SHOTS}/limit-values.png` });
    // The read-out and an SVG capture state the limit, not a value.
    const readOut = await card(page).getByRole('button', { name: 'Read current values' }).click().then(() => card(page).locator('.ema-sr[role=status][aria-live=polite]').textContent());
    expect(readOut).toContain('Position: Beyond numerical range');
    expect(errors).toEqual([]);
  });
});
