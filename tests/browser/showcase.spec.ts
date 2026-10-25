import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import fixtures from '../reference/fixtures/showcase.json' with { type: 'json' };
import type { CardController } from '../../examples/shared/controller';

type TestWindow = { __SHOWCASE__: CardController };
const inspect = (page: Page) => page.evaluate(() => (window as unknown as TestWindow).__SHOWCASE__.inspect());
const commit = (page: Page, params: Record<string, number>) => page.evaluate(params => (window as unknown as TestWindow).__SHOWCASE__.commit(params), params);
const shots = '/tmp/experiment-kit-showcase';
const boundaries: Record<string, Record<string, number>> = {
  projectile: { angle: 80, speed: 30, height: 10 }, forces: { angle: 20, friction: .8, mass: 8 },
  waves: { phase: 180, a: 1, b: 1 }, light: { angle: 50, n1: 1.5, n2: 1 },
  matrix: { stretch: 0, shear: .8, vertical: 1.2 }, probability: { prevalence: 0, sensitivity: 0, falseAlarm: 0 },
};

for (const [id, cases] of Object.entries(fixtures.cases)) {
  test(`${id}: reference values, live preview, exact inputs, default/boundary/mobile representation`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(`/showcase.html?example=${id}`);
    await expect(page.locator('.ex-card')).toHaveAttribute('data-example', id);
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    await mkdir(shots, { recursive: true });
    await page.screenshot({ path: `${shots}/${id}-desktop.png`, fullPage: true });
    const before = (await inspect(page)).primary;
    const slider = page.getByRole('group', { name: 'Model parameters' }).getByRole('slider').first();
    const key = Object.keys(before.document!.parameters)[0];
    const box = (await slider.boundingBox())!;
    const spec = before.document!.parameters[key];
    const x = box.x + box.width * ((before.run!.params[key] - spec.min) / (spec.max - spec.min));
    await page.mouse.move(x, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width * .72, box.y + box.height / 2, { steps: 10 });
    const tentative = Number(await slider.inputValue());
    await expect.poll(async () => (await inspect(page)).displayed.run!.params[key]).toBe(tentative);
    expect((await inspect(page)).primary.run).toEqual(before.run);
    await page.keyboard.press('Escape'); await page.mouse.up();
    await expect(page.locator('.ex-card')).toHaveAttribute('data-preview', 'false');
    expect((await inspect(page)).primary.run).toEqual(before.run);
    for (const fixture of cases) {
      await commit(page, fixture.params);
      const state = (await inspect(page)).primary;
      for (const [quantity, expected] of Object.entries(fixture.expected)) {
        const result = state.frame!.quantities[quantity];
        if (expected === null) { expect(result.status).toBe('undefined'); expect(result.reason).toBeTruthy(); }
        else if (Array.isArray(expected)) expected.forEach((value, index) => expect((result.value as number[])[index]).toBeCloseTo(value, 8));
        else expect(result.value as number).toBeCloseTo(expected, 8);
      }
    }
    await commit(page, boundaries[id]);
    if (id === 'projectile') await page.evaluate(async () => { const c = (window as unknown as TestWindow).__SHOWCASE__; await c.seek(c.getSnapshot().rendered.frame!.endTime!); });
    await page.screenshot({ path: `${shots}/${id}-boundary.png`, fullPage: true });
    if (id === 'light') { await expect(page.getByTestId('refracted-ray')).toHaveCount(0); await expect(page.getByTestId('metric-transmitted')).toContainText('No refracted ray'); }
    if (id === 'probability') await expect(page.getByTestId('metric-precision')).toContainText('Undefined');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${shots}/${id}-mobile-boundary.png`, fullPage: true });
    await page.getByRole('button', { name: 'Reset parameters', exact: true }).click();
    await expect(page.locator('.ex-card')).toHaveAttribute('aria-busy', 'false');
    await page.screenshot({ path: `${shots}/${id}-mobile.png`, fullPage: true });
    for (const width of [320, 390, 680, 900, 1440]) { await page.setViewportSize({ width, height: 1000 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }
    const input = page.getByRole('textbox').first();
    await input.fill(String(spec.max + 1)); await input.press('Enter');
    await expect(page.getByRole('alert')).toContainText('Enter a value');
    expect((await inspect(page)).primary.run!.params[key]).toBe(spec.value);
    expect(errors).toEqual([]);
  });
}

test('projectile time scrubbing remains tentative; impact is exact; parameter edits restart time', async ({ page }) => {
  await page.goto('/showcase.html?example=projectile'); await expect(page.locator('.ex-card')).toBeVisible();
  const before = (await inspect(page)).primary;
  const timeline = page.getByRole('slider', { name: 'Flight time', exact: true });
  await page.evaluate(() => document.fonts.ready);
  await timeline.scrollIntoViewIfNeeded();
  const box = (await timeline.boundingBox())!;
  await page.mouse.move(box.x + box.width * (before.frame!.time / before.frame!.endTime!), box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width * .75, box.y + box.height / 2);
  await expect.poll(async () => (await inspect(page)).displayed.frame!.time).toBeGreaterThan(before.frame!.time);
  expect((await inspect(page)).primary.run).toEqual(before.run);
  await page.mouse.up();
  await expect(page.locator('.ex-card')).toHaveAttribute('data-preview', 'false');
  const after = (await inspect(page)).primary; expect(after.run!.id).toBe(before.run!.id); expect(after.frame!.time).toBeGreaterThan(before.frame!.time);
  await timeline.focus(); await timeline.press('End');
  await expect.poll(async () => (await inspect(page)).primary.frame!.terminal).toBe(true);
  const terminal = (await inspect(page)).primary.frame!;
  expect(terminal.time).toBe(terminal.endTime); expect(terminal.quantities.y.value).toBeCloseTo(0, 10);
  const dot = page.getByTestId('projectile-dot'); expect(Number(await dot.getAttribute('cy'))).toBeCloseTo(322, 7);
  await page.getByRole('button', { name: 'Replay', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await commit(page, { speed: 20 }); expect((await inspect(page)).primary.frame!.time).toBe(0);
});

test('the free-body vectors add to ma; transformed square represents determinant area', async ({ page }) => {
  await page.goto('/showcase.html?example=forces'); await expect(page.locator('.ex-card')).toBeVisible();
  const state = (await inspect(page)).primary, q = state.frame!.quantities;
  const sum = ['weightVector', 'normalVector', 'frictionVector'].map(id => q[id].value as number[]).reduce((a, b) => [a[0] + b[0], a[1] + b[1]], [0, 0]);
  (q.netVector.value as number[]).forEach((v, i) => expect(sum[i]).toBeCloseTo(v, 8));
  for (const [testId, quantity] of [['weight-force', 'weightVector'], ['normal-force', 'normalVector'], ['friction-force', 'frictionVector']]) {
    const arrow = page.getByTestId(testId).locator('line'), v = q[quantity].value as number[];
    expect(Number(await arrow.getAttribute('x2')) - Number(await arrow.getAttribute('x1'))).toBeCloseTo(v[0] * 1.4, 8);
    expect(Number(await arrow.getAttribute('y2')) - Number(await arrow.getAttribute('y1'))).toBeCloseTo(-v[1] * 1.4, 8);
  }
  await page.getByRole('link', { name: 'Matrices', exact: true }).click(); await expect(page.locator('.ex-card')).toHaveAttribute('data-example', 'matrix');
  const stretch = page.getByRole('textbox', { name: 'Horizontal stretch exact value' });
  await stretch.fill('1.43'); await stretch.press('Enter');
  await expect(page.getByLabel('Current matrix')).toContainText('1.43');
  await expect(page.getByTestId('metric-corner')).toContainText('(2.23, 1.20)');
  await page.getByRole('button', { name: 'Collapse', exact: true }).click();
  await expect(page.getByTestId('metric-area')).toContainText('0.00');
  const polygon = (await page.getByTestId('mapped-square').getAttribute('points'))!.split(' ').map(p => p.split(',').map(Number));
  expect(polygon[0]).toEqual(polygon[1]); expect(polygon[2]).toEqual(polygon[3]);
});
