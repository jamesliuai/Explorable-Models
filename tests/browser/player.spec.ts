import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { CheckReport, Inspection, Manifest, RuntimeState, Snapshot } from '@experiment-kit/core';

/** The same public command bridge used by the CLI; no UI model imports. */
async function request<T = unknown>(page: Page, method: string, args: Record<string, unknown> = {}): Promise<T> {
  return page.evaluate(async ({ method, args }) => {
    const bridge = (window as unknown as { __EXPERIMENT_KIT__: { request(input: unknown): Promise<unknown> } }).__EXPERIMENT_KIT__;
    return bridge.request({ method, args });
  }, { method, args }) as Promise<T>;
}

async function openExperiment(page: Page, id = 'rolling') {
  await page.goto(`/?experiment=${id}`);
  await page.waitForFunction(() => Boolean((window as unknown as { __EXPERIMENT_KIT__?: unknown }).__EXPERIMENT_KIT__));
  await expect.poll(async () => (await request<Inspection>(page, 'inspect')).experimentId).toBe(id);
}

async function setNumber(page: Page, name: string, value: string) {
  const { manifest } = await request<{ manifest: Manifest }>(page, 'describe');
  const [key, parameter] = Object.entries(manifest.parameters).find(([key, parameter]) => parameter.label === name || (key === 'incline' && name === 'Ramp angle'))!;
  const control = page.getByRole('spinbutton', { name, exact: true });
  await control.fill(value);
  await control.press('Enter');
  const expected = Number(value) / (parameter.display?.scale ?? 1);
  if (expected >= (parameter.min ?? -Infinity) && expected <= (parameter.max ?? Infinity)) {
    await expect.poll(async () => Number((await request<Inspection>(page, 'inspect')).parameters[key])).toBeCloseTo(expected, 10);
  }
}

async function command(page: Page, type: string, args: Record<string, unknown> = {}) {
  const current = await request<RuntimeState>(page, 'state');
  return request(page, 'command', {
    type, ...args, expectedRunVersion: current.run.version, expectedActiveRunId: current.activeRunId,
  });
}

async function assertBoundValues(page: Page, inspection: Inspection) {
  const bindings = await page.locator(`[data-frame-id="${inspection.frameId}"][data-quantity-id][data-value]`).evaluateAll(nodes => nodes.map(node => ({
    id: node.getAttribute('data-quantity-id')!, value: node.getAttribute('data-value'),
  })));
  expect(bindings.length).toBeGreaterThan(2);
  for (const binding of bindings) {
    expect(inspection.quantities[binding.id], binding.id).toBeDefined();
    expect(JSON.parse(binding.value!), binding.id).toEqual(inspection.quantities[binding.id].value);
  }
}

test('rolling loads a useful screen, with worker values linked to one committed frame', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openExperiment(page);
  await expect(page).toHaveTitle(/Explorable Models/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Same ramp. Different motion.');
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await command(page, 'seek', { time: 1 });
  const inspection = await request<Inspection>(page, 'inspect');
  expect(inspection.quantities['body.acceleration'].value).toBeCloseTo(3.503571428571, 9);
  expect(inspection.quantities['body.rotation'].value).toBeCloseTo(-8.758928571429, 9);
  await assertBoundValues(page, inspection);
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('all five models pass their published reference cases in real browser workers', async ({ page }) => {
  for (const id of ['rolling', 'linear-map', 'base-rates', 'riemann-sums', 'oscillator']) {
    await openExperiment(page, id);
    const report = await request<CheckReport>(page, 'verify');
    expect(report.passed, `${id}: ${JSON.stringify(report.results?.filter(result => !result.passed))}`).toBe(true);
    expect(report.results.length).toBeGreaterThan(2);
    expect(report.modelReview?.status).toBe('unreviewed');
    expect(report.learnerEvidence).toBe('not_evaluated');
  }
});

test('exact scientific edits start a new run and invalid input preserves the current run', async ({ page }) => {
  await openExperiment(page);
  await command(page, 'seek', { time: 1 });
  const previous = await request<RuntimeState>(page, 'state');
  await setNumber(page, 'Ramp angle', '20');
  await expect.poll(async () => (await request<RuntimeState>(page, 'state')).activeRunId).not.toBe(previous.activeRunId);
  const changed = await request<RuntimeState>(page, 'state');
  expect(changed.run.parameters.incline).toBeCloseTo(Math.PI / 9, 12);
  expect(changed.frame.timePoint.time).toBe(0);
  await setNumber(page, 'Ramp angle', '90');
  await expect(page.locator('.field-error')).toContainText(/from.*0.*45/);
  expect((await request<RuntimeState>(page, 'state')).activeRunId).toBe(changed.activeRunId);
  await setNumber(page, 'Ramp angle', '30');
  await expect(page.getByRole('spinbutton', { name: 'Ramp angle', exact: true })).toHaveAttribute('aria-invalid', 'false');
});

test('play, pause, step, and terminal capture preserve physical velocity', async ({ page }) => {
  await openExperiment(page);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(async () => (await request<RuntimeState>(page, 'state')).frame.timePoint.time).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect.poll(async () => (await request<RuntimeState>(page, 'state')).frame.status).toBe('paused');
  const paused = await request<RuntimeState>(page, 'state');
  await page.waitForTimeout(100);
  expect((await request<RuntimeState>(page, 'state')).frame.timePoint.time).toBe(paused.frame.timePoint.time);
  await page.getByRole('button', { name: /step/i }).click();
  await expect.poll(async () => (await request<RuntimeState>(page, 'state')).frame.timePoint.time).toBeGreaterThan(paused.frame.timePoint.time);
  const arrival = (await request<Inspection>(page, 'inspect')).quantities['event.arrivalTime'].value as number;
  await command(page, 'seek', { time: arrival });
  const boundary = await request<RuntimeState>(page, 'state');
  expect(boundary.frame.timePoint).toMatchObject({ kind: 'event', time: arrival, eventId: 'ramp-arrival' });
  expect(boundary.frame.status).toBe('boundary');
  expect(boundary.frame.quantities['body.speed'].value).toBeCloseTo(5.294201680005, 9);
  await assertBoundValues(page, await request<Inspection>(page, 'inspect'));
});

test('stale agent mutations conflict and separate sampling leaves the screen unchanged', async ({ page }) => {
  await openExperiment(page);
  const stale = await request<RuntimeState>(page, 'state');
  await setNumber(page, 'Ramp angle', '15');
  const current = await request<RuntimeState>(page, 'state');
  const conflict = await request<{ error: { code: string } }>(page, 'command', {
    type: 'set_parameters', parameters: { incline: 0.5 },
    expectedRunVersion: stale.run.version, expectedActiveRunId: stale.activeRunId,
  });
  expect(conflict.error.code).toBe('CONFLICT');
  await request(page, 'sample', { parameters: { incline: Math.PI / 6, bodyType: 'hoop' }, times: [0, 1] });
  const after = await request<RuntimeState>(page, 'state');
  expect(after.activeRunId).toBe(current.activeRunId);
  expect(after.frame.frameId).toBe(current.frame.frameId);
  expect(after.run.parameters).toEqual(current.run.parameters);
});

test('a saved snapshot restores parameters, selection, and time through the import flow', async ({ page }) => {
  await openExperiment(page);
  await command(page, 'seek', { time: 1 });
  await page.locator('[data-scene-role="primary"]').press('Enter');
  await expect.poll(async () => (await request<Inspection>(page, 'inspect')).selectedIds).toContain('body.speed');
  const snapshot = await request<Snapshot>(page, 'checkpoint');
  expect(snapshot.view.selectedIds).toContain('body.speed');
  await page.getByRole('button', { name: 'Save state', exact: true }).click();
  await page.getByRole('textbox').fill('At one second');
  await page.getByRole('button', { name: 'Save run', exact: true }).click();
  await setNumber(page, 'Ramp angle', '10');
  await page.getByRole('button', { name: /saved runs/i }).click();
  await expect(page.getByText('At one second', { exact: true })).toBeVisible();
  const dialog = page.getByRole('dialog');
  await dialog.locator('input[type="file"]').setInputFiles({ name: 'reopen.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(snapshot)) });
  await expect.poll(async () => (await request<RuntimeState>(page, 'state')).frame.timePoint.time).toBe(1);
  const restored = await request<RuntimeState>(page, 'state');
  expect(restored.run.parameters).toEqual(snapshot.parameters);
  expect(restored.view.selectedIds).toContain('body.speed');
  expect(restored.activeRunId).not.toBe(snapshot.runId);
});

test('linear maps have exact point controls, keyboard movement, and a working drag alternative', async ({ page }) => {
  await openExperiment(page, 'linear-map');
  await page.locator('summary').filter({ hasText: /^Input point$/ }).click();
  for (const [name, value] of [['Matrix a', '1'], ['Matrix b', '2'], ['Matrix c', '0.5'], ['Matrix d', '-1'], ['Input x', '1.25'], ['Input y', '-0.875']]) {
    await setNumber(page, name, value);
  }
  const inspection = await request<Inspection>(page, 'inspect');
  expect(inspection.quantities['point.output'].value).toEqual([-0.5, 1.5]);
  expect(inspection.quantities['matrix.determinant'].value).toBe(-2);
  await assertBoundValues(page, inspection);
  const point = page.getByRole('button', { name: /^Input point/ });
  await point.focus();
  await point.press('ArrowRight');
  await expect.poll(async () => (await request<Inspection>(page, 'inspect')).parameters.x).toBeCloseTo(1.35, 8);
  const circle = page.locator('.point-drag circle').last();
  const box = await circle.boundingBox();
  expect(box).not.toBeNull();
  const before = await request<Inspection>(page, 'inspect');
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 20, box!.y + box!.height / 2 - 10, { steps: 4 });
  await expect.poll(async () => (await request<Inspection>(page, 'inspect')).preview?.tentative).toBe(true);
  const busy = await request<{ error: { code: string } }>(page, 'checkpoint');
  expect(busy.error.code).toBe('BUSY');
  await page.mouse.up();
  await expect.poll(async () => (await request<RuntimeState>(page, 'state')).preview).toBeUndefined();
  await expect.poll(async () => (await request<Inspection>(page, 'inspect')).parameters.x).not.toBe(before.parameters.x);
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toHaveCount(0);
});

test('base rates show correct expected counts and an explicitly undefined empty condition', async ({ page }) => {
  await openExperiment(page, 'base-rates');
  const initial = await request<Inspection>(page, 'inspect');
  expect(initial.quantities['count.truePositive'].value).toBe(90);
  expect(initial.quantities['count.falsePositive'].value).toBe(495);
  expect(initial.quantities['probability.posterior'].value).toBeCloseTo(0.153846153846, 10);
  await page.getByRole('button', { name: '90 true positives', exact: true }).click();
  await expect.poll(async () => (await request<Inspection>(page, 'inspect')).selectedIds).toContain('count.truePositive');
  await setNumber(page, 'Sensitivity', '0');
  await setNumber(page, 'False positive rate', '0');
  const empty = await request<Inspection>(page, 'inspect');
  expect(empty.quantities['probability.posterior']).toMatchObject({ value: null, status: 'undefined' });
  await expect(page.locator('.posterior-insight')).toContainText('Undefined');
  await expect(page.locator('.posterior-insight')).toContainText('probability zero');
  await expect(page.getByText('No parts are flagged', { exact: true })).toBeVisible();
  await assertBoundValues(page, empty);
});

test('a snapshot from the wrong definition is rejected without changing the active frame', async ({ page }) => {
  await openExperiment(page, 'linear-map');
  const snapshot = await request<Snapshot>(page, 'checkpoint');
  const before = await request<RuntimeState>(page, 'state');
  const response = await command(page, 'restore', { snapshot: { ...snapshot, definitionRevision: `sha256:${'0'.repeat(64)}` } }) as { error: { code: string } };
  expect(response.error.code).toBe('INCOMPATIBLE_SNAPSHOT');
  expect((await request<RuntimeState>(page, 'state')).frame.frameId).toBe(before.frame.frameId);
});

test('the three primary screens have no serious automated accessibility violations', async ({ page }) => {
  const violations: { experiment: string; id: string; help: string; targets: unknown[] }[] = [];
  for (const id of ['rolling', 'linear-map', 'base-rates']) {
    await openExperiment(page, id);
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    const serious = result.violations.filter(item => item.impact === 'serious' || item.impact === 'critical');
    violations.push(...serious.map(item => ({ experiment: id, id: item.id, help: item.help, targets: item.nodes.map(node => node.target) })));
  }
  expect(violations).toEqual([]);
});

test('primary tasks remain visible without horizontal page overflow at supported widths', async ({ page }) => {
  for (const width of [390, 1024, 1440]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    for (const id of ['rolling', 'linear-map', 'base-rates']) {
      await openExperiment(page, id);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const dimensions = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: innerWidth }));
      expect(dimensions.document, `${id} at ${width}px`).toBeLessThanOrEqual(dimensions.viewport + 1);
      expect(await page.locator('input[type="number"]').count()).toBeGreaterThan(0);
    }
  }
});

test('a fresh page imports an exact snapshot with no AI connection or remote requests', async ({ page, context }) => {
  await openExperiment(page, 'linear-map');
  await setNumber(page, 'Matrix b', '-2');
  const snapshot = await request<Snapshot>(page, 'checkpoint');
  const expected = await request<Inspection>(page, 'inspect');
  const reopened = await context.newPage();
  await reopened.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await openExperiment(reopened, 'linear-map');
  await command(reopened, 'restore', { snapshot });
  const actual = await request<Inspection>(reopened, 'inspect');
  expect(actual.parameters).toEqual(expected.parameters);
  expect(actual.quantities).toEqual(expected.quantities);
  expect(actual.definitionRevision).toBe(expected.definitionRevision);
  expect(actual.runId).not.toBe(expected.runId);
  await reopened.close();
});
