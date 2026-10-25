import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import reference from '../reference/fixtures/hinged-rod.json' with { type: 'json' };
import type { RodController } from '../../examples/hinged-rod/controller';

type RodWindow = Window & { __ROD_EXAMPLE__: RodController };
const inspect = (page: Page) => page.evaluate(() => (window as unknown as RodWindow).__ROD_EXAMPLE__.inspect());
const shots = '/tmp/experiment-kit-hinged-rod';
async function exact(page: Page, name: string, value: number) {
  const input = page.getByRole('textbox', { name: `${name} exact value` });
  await input.fill(String(value)); await input.press('Enter');
  await expect(page.locator('.rod-card')).toHaveAttribute('aria-busy', 'false');
}
test.beforeEach(async ({ page }) => {
  await page.goto('/hinged-rod.html');
  await expect(page.getByRole('heading', { name: 'A rod, released from rest' })).toBeVisible();
});

test('worker model agrees with external reference fixtures and bound geometry', async ({ page }) => {
  for (const fixture of reference.cases) {
    await page.evaluate(params => (window as unknown as RodWindow).__ROD_EXAMPLE__.commit(params), fixture.params);
    const { primary } = await inspect(page);
    for (const id of ['alpha', 'tangential'] as const) {
      expect(primary.frame!.quantities[id].status).toBe('valid');
      expect(primary.frame!.quantities[id].value as number).toBeCloseTo(fixture[id], 10);
    }
    for (const id of ['tip', 'acceleration'] as const) {
      const actual = primary.frame!.quantities[id].value as number[];
      actual.forEach((value, index) => expect(value).toBeCloseTo(fixture[id][index], 10));
    }
    const tip = primary.frame!.quantities.tip.value as number[];
    const acceleration = primary.frame!.quantities.acceleration.value as number[];
    expect(tip[0] * acceleration[0] + tip[1] * acceleration[1]).toBeCloseTo(0, 10);
    const rod = page.getByTestId('rod-body'), center = page.getByTestId('center-of-mass');
    for (const [start, end, midpoint] of [['x1', 'x2', 'cx'], ['y1', 'y2', 'cy']]) {
      expect(Number(await center.getAttribute(midpoint))).toBeCloseTo((Number(await rod.getAttribute(start)) + Number(await rod.getAttribute(end))) / 2, 8);
    }
    if (fixture.tangential === 0) await expect(page.getByTestId('acceleration-arrow')).toHaveCount(0);
    else {
      const arrow = page.getByTestId('acceleration-arrow');
      const dx = Number(await arrow.getAttribute('x2')) - Number(await arrow.getAttribute('x1'));
      const dy = Number(await arrow.getAttribute('y2')) - Number(await arrow.getAttribute('y1'));
      const rx = Number(await rod.getAttribute('x2')) - Number(await rod.getAttribute('x1'));
      const ry = Number(await rod.getAttribute('y2')) - Number(await rod.getAttribute('y1'));
      expect(dx * rx + dy * ry).toBeCloseTo(0, 7);
    }
  }
  await page.evaluate(() => (window as unknown as RodWindow).__ROD_EXAMPLE__.commit({ angle: .1, gravity: .01, length: 2 }));
  await expect(page.getByTestId('tangential-value')).toContainText('e-5');
  expect(Number(await page.getByTestId('acceleration-head').getAttribute('markerWidth'))).toBeLessThan(.001);
});

test('pointer drag renders multiple live frames before one primary commit; Escape and pointercancel restore', async ({ page }) => {
  const before = (await inspect(page)).primary;
  const slider = page.getByRole('slider', { name: 'Angle', exact: true });
  const box = (await slider.boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y); await page.mouse.down();
  for (const fraction of [.65, .8, .95]) {
    await page.mouse.move(box.x + box.width * fraction, y, { steps: 4 });
    await expect.poll(async () => Number(await slider.inputValue())).toBeGreaterThan(45);
    await expect.poll(async () => (await inspect(page)).displayed.run!.params.angle).toBe(Number(await slider.inputValue()));
    expect((await inspect(page)).primary.run).toEqual(before.run);
    await expect(page.locator('.rod-card')).toHaveAttribute('data-preview', 'true');
  }
  const latest = Number(await slider.inputValue());
  await page.mouse.up();
  await expect.poll(async () => (await inspect(page)).primary.run!.params.angle).toBe(latest);
  const committed = (await inspect(page)).primary;
  expect(committed.run!.id).not.toBe(before.run!.id);
  expect(await page.evaluate(() => (window as unknown as RodWindow).__ROD_EXAMPLE__.exportDocument().comparisons.length)).toBe(1);
  await slider.focus(); await page.keyboard.down('ArrowLeft');
  await expect(page.locator('.rod-card')).toHaveAttribute('data-preview', 'true');
  expect(await page.evaluate(() => { try { (window as unknown as RodWindow).__ROD_EXAMPLE__.exportDocument(); return 'allowed'; } catch { return 'blocked'; } })).toBe('blocked');
  await page.keyboard.press('Escape'); await page.keyboard.up('ArrowLeft');
  expect((await inspect(page)).primary.run).toEqual(committed.run);
  await expect(page.locator('.rod-diagram')).toHaveAttribute('data-angle', String(latest));
  await page.mouse.move(box.x + box.width * .5, y); await page.mouse.down();
  await slider.dispatchEvent('pointercancel'); await page.mouse.up();
  await expect(page.locator('.rod-card')).toHaveAttribute('data-preview', 'false');
  expect((await inspect(page)).primary.run).toEqual(committed.run);
});

test('latest preview wins, cancellation discards late replies, and worker failure preserves accepted state', async ({ page }) => {
  const before = (await inspect(page)).primary;
  await page.evaluate(() => {
    const controller = (window as unknown as RodWindow).__ROD_EXAMPLE__;
    for (let angle = 1; angle <= 90; angle++) controller.preview({ angle });
  });
  await expect.poll(async () => (await inspect(page)).displayed.run!.params.angle).toBe(90);
  expect((await inspect(page)).primary.run).toEqual(before.run);
  await page.evaluate(() => {
    const controller = (window as unknown as RodWindow).__ROD_EXAMPLE__;
    controller.preview({ angle: 12 }); controller.cancel();
  });
  await expect(page.locator('.rod-diagram')).toHaveAttribute('data-angle', '45');
  await exact(page, 'Length', 3);
  await expect(page.getByTestId('tangential-value')).toContainText('5.20');
  await expect(page.getByTestId('angular-value')).toContainText('3.47');
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(page.locator('.rod-diagram')).toHaveAttribute('data-length', '2');
  // Runtime failure, through the actual browser worker request boundary.
  await page.evaluate(() => { Worker.prototype.postMessage = () => { throw new Error('Simulated worker failure'); }; });
  await exact(page, 'Angle', 30);
  await expect(page.getByRole('alert')).toContainText('Simulated worker failure');
  await expect(page.locator('.rod-diagram')).toHaveAttribute('data-angle', '45');
  expect((await inspect(page)).primary.frame).toEqual(before.frame);
});

test('desktop/default, vertical, horizontal and mobile render without clipping or console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await mkdir(shots, { recursive: true });
  await expect(page).toHaveTitle('Hinged rod · Explorable Models');
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  await page.screenshot({ path: `${shots}/desktop.png`, fullPage: true });
  await exact(page, 'Angle', 0);
  await expect(page.getByTestId('tangential-value')).toContainText('0.00');
  await expect(page.getByTestId('angular-arrow')).toHaveCount(0);
  await page.screenshot({ path: `${shots}/vertical.png`, fullPage: true });
  await exact(page, 'Angle', 90); await exact(page, 'Length', 3); await exact(page, 'Gravity', 20);
  await page.screenshot({ path: `${shots}/horizontal.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.rod-diagram')).toHaveAttribute('viewBox', '0 0 400 360');
  await page.screenshot({ path: `${shots}/mobile-boundary.png`, fullPage: true });
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(page.locator('.rod-diagram')).toHaveAttribute('data-angle', '45');
  await page.screenshot({ path: `${shots}/mobile.png`, fullPage: true });
  for (const width of [320, 390, 650, 800, 1440]) {
    await page.setViewportSize({ width, height: 950 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.getByRole('textbox', { name: 'Length exact value' }).fill('0');
  await page.getByRole('textbox', { name: 'Length exact value' }).press('Enter');
  await expect(page.getByRole('alert')).toContainText('Enter 0.5 to 3');
  expect((await inspect(page)).primary.run!.params.length).toBe(2);
  expect(errors).toEqual([]);
});
