/**
 * Projection-owned learner outputs in a real browser (report §5.3, §8.2, §14; G10, G20/G69, G28): the card itself refuses
 * a capture when the host policy turns `export.capture` off; a drawn value beyond the representable range is titled and
 * described as a numerical limit, not as "undefined"; a saved activity whose template the host revoked is shown as its
 * archival read-only record (learner audience) instead of being reopened or substituted.
 *
 * Evidence scope: Playwright Chromium (`npm run test:browser`), Firefox and WebKit (`npm run test:cross-browser`) with the
 * integration-fixture host. Fixture-host results only; they say nothing
 * about the Study Harness host, a packaged WebView, assistive-technology use or learning benefit.
 */
import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { card, control, expectAccessible, openFixture, overflow, projection, settle } from './support/study-harness';

const SHOTS = '/tmp/explorable-models-playwright/study-projection';
mkdirSync(SHOTS, { recursive: true });

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
type Hooks = {
  host: { policy(id: string): Record<string, unknown> & { revision: number; export: Record<string, boolean> }; setPolicy(id: string, policy: unknown): unknown; id(prefix: string): string };
  prepared: { activityId: string; host: { updatePolicy(input: unknown): Promise<{ ok: boolean; diagnostics?: unknown }> } } | null;
  capture(format: 'svg' | 'png', viewId?: string): Promise<{ mimeType: string }>;
  revokeCatalogueAndRestart(): Promise<{ ok: boolean; message: string }>;
  archival(): { audience: string; readOnly: boolean; template: { templateId: string }; parameters: unknown; lines: string[] } | null;
  template: { templateId: string; version: string; title: string; equations: { label: string }[] } | null;
};
const TEMPLATE_ID = 'quadratic-gradient-descent';
/** Restricted text of the quadratic activity that a learner record must never show (solution values and the constraint text). */
const RESTRICTED = ['Largest convergent step size', 'Update multiplier', 'Step size times curvature', 'Convergence condition', 'can be at most 4', 'Update rule with current values'];
const hooks = (page: Page, run: (fx: Hooks) => unknown) => page.evaluate(run as never, undefined);

test.describe('projection-owned learner outputs', () => {
  test('capture follows the host policy: with export.capture off the card refuses the capture itself (G10)', async ({ page }) => {
    const errors = await openFixture(page, '?mode=free');
    expect((await projection(page)).permissions).toEqual({ capture: true });
    const allowed = await page.evaluate(() => (window as unknown as { studyHarnessFixture: Hooks }).studyHarnessFixture.capture('svg', 'landscape').then(result => result.mimeType, (error: { code?: string }) => `${error.code}`));
    expect(allowed).toBe('image/svg+xml');
    // The host issues a policy revision with export.capture off (a host decision; nothing else changes).
    await page.evaluate(async () => {
      const fx = (window as unknown as { studyHarnessFixture: Hooks }).studyHarnessFixture;
      const id = fx.prepared!.activityId, current = fx.host.policy(id);
      const next = fx.host.setPolicy(id, { ...current, revision: current.revision + 1, issuedAt: new Date().toISOString(), export: { ...current.export, capture: false } });
      const outcome = await fx.prepared!.host.updatePolicy({ operationId: fx.host.id('fx-capture-off'), policy: next });
      if (!outcome.ok) throw new Error(JSON.stringify(outcome.diagnostics));
    });
    await settle(page);
    expect((await projection(page)).permissions).toEqual({ capture: false });
    for (const format of ['svg', 'png'] as const) {
      const refused = await page.evaluate(value => (window as unknown as { studyHarnessFixture: Hooks }).studyHarnessFixture.capture(value).then(() => 'captured', (error: Error & { code?: string }) => `${error.code}: ${error.message}`), format);
      expect(refused).toBe('CAPTURE_REJECTED: The host policy does not allow captures of this activity.');
    }
    // The card itself is unaffected: no failure state, the controls still work.
    expect((await projection(page)).status.ui).not.toBe('recoverable-failure');
    await exact(page, 'eta', '0.5');
    expect(errors).toEqual([]);
  });

  test('a drawn value beyond the representable range is a numerical limit, not "undefined" (a = 10, η = 0.4, x₀ = 10 at n = 400; G28)', async ({ page }) => {
    const errors = await openFixture(page, '?mode=free');
    await exact(page, 'a', '10');
    await exact(page, 'eta', '0.4');
    await exact(page, 'x0', '10');
    await goTo(page, 400);
    const shown = await projection(page);
    expect(shown.status).toMatchObject({ ui: 'undefined', cause: 'numerical-limit' });
    const banner = card(page).locator('.ema-banner[data-ui-state="undefined"]');
    await expect(banner).toBeVisible();
    await expect(banner.locator('.ema-banner-title')).toHaveText('Some values are beyond the representable range');
    await expect(banner).toContainText('beyond the range that can be represented');
    await expect(banner).not.toContainText('not defined');
    await expectAccessible(page, 'numerical-limit banner');
    await card(page).evaluate(host => host.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: `${SHOTS}/numerical-limit-banner.png`, fullPage: true });
    expect(errors).toEqual([]);
  });

  for (const variant of [{ name: 'default', query: '' }, { name: '390-dark', query: '&width=390&theme=dark' }, { name: '320-text200', query: '&width=320&text=200' }]) {
    test(`a revoked template is shown as the archival read-only record, never reopened or substituted (${variant.name}; G20/G69)`, async ({ page }) => {
      const errors = await openFixture(page, `?template=${TEMPLATE_ID}&flow=generic${variant.query}`);
      const template = await hooks(page, () => (window as unknown as { studyHarnessFixture: Hooks }).studyHarnessFixture.template) as NonNullable<Hooks['template']>;
      await expect(card(page)).toHaveCount(1);
      const restarted = await hooks(page, () => (window as unknown as { studyHarnessFixture: Hooks }).studyHarnessFixture.revokeCatalogueAndRestart()) as { ok: boolean };
      expect(restarted.ok).toBe(true);
      // No learner card: the restore was refused (CONTENT_REVOKED) and nothing else was opened in its place.
      await expect(card(page)).toHaveCount(0);
      const record = page.locator('[data-fx-card] [data-explorable-models-archival]');
      await expect(record).toHaveCount(1);
      // Learner-facing words only (report §10.4, R19/R29): the host's names for the saved template, no identifiers.
      await expect(record.getByRole('heading', { name: `${template.title} — saved, read-only` })).toBeVisible();
      await expect(record).not.toContainText(template.templateId);
      await expect(record).not.toContainText(/Journal checkpoint|Event \d+/);
      await expect(record).toContainText('The saved settings are kept with the record');
      // Its only control is the host's return action; nothing in the record can change the saved activity.
      await expect(record.locator('input, select, textarea')).toHaveCount(0);
      await expect(record.getByRole('button')).toHaveCount(1);
      await expect(record.getByRole('button', { name: 'Return to the session' })).toBeVisible();
      const archival = await hooks(page, () => (window as unknown as { studyHarnessFixture: Hooks }).studyHarnessFixture.archival()) as ReturnType<Hooks['archival']>;
      expect(archival).toMatchObject({ audience: 'learner', readOnly: true, template: { templateId: template.templateId }, parameters: null });
      // Learner-audience leak scan over the rendered record, and no artifact or activity identifier in it.
      const text = (await record.evaluate(host => host.shadowRoot!.textContent ?? '')) as string;
      for (const label of [...RESTRICTED, ...template.equations.map(equation => equation.label)]) expect(text, label).not.toContain(label);
      const ids = await hooks(page, () => { const view = (window as unknown as { studyHarnessFixture: { archival(): { artifact: { artifactId: string }; activity: { activityId: string; stageId: string } } } }).studyHarnessFixture.archival(); return [view.artifact.artifactId, view.activity.activityId, view.activity.stageId]; }) as string[];
      for (const id of ids) expect(text, id).not.toContain(id);
      const layout = await overflow(page);
      expect(layout.page, `page overflow: ${layout.offenders.join(', ')}`).toBe(false);
      await page.locator('[data-fx-card]').evaluate(element => element.scrollIntoView({ block: 'start' }));
      await page.screenshot({ path: `${SHOTS}/archival-${variant.name}.png`, fullPage: true });
      expect(errors).toEqual([]);
    });
  }
});
