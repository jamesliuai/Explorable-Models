import { expect, test, type Page } from '@playwright/test';
import type { MutationGuard, VisualizationSession } from '@experiment-kit/core/declarative';

interface Studio { session: VisualizationSession; guard(): MutationGuard }
async function studioState(page: Page) {
  return page.evaluate(() => (window as unknown as { __COMPOSITION_STUDIO__: Studio }).__COMPOSITION_STUDIO__.session.getState());
}
async function openTriangle(page: Page) {
  await page.goto('/agent.html');
  await page.getByRole('combobox').selectOption('triangle');
  await expect(page.getByRole('status').first()).toContainText('Editable composition loaded');
}

test('drag preview preserves the committed frame and uses a stable downward coordinate transform', async ({ page }) => {
  await openTriangle(page);
  const before = await studioState(page);
  const vertex = page.locator('[data-mark-id="vertex"] circle');
  await vertex.scrollIntoViewIfNeeded();
  const box = await vertex.boundingBox();
  expect(box).not.toBeNull();
  const start = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(start.x + 35, start.y + 25, { steps: 4 });
  await expect.poll(async () => (await studioState(page)).preview).not.toBeNull();
  const tentative = await studioState(page);
  expect(tentative.preview).not.toBeNull();
  expect(tentative.run).toEqual(before.run);
  expect(tentative.frame).toEqual(before.frame);
  expect(tentative.preview!.cx).toBeGreaterThan(0);
  expect(tentative.preview!.cy).toBeLessThan(4);
  const previewCapture = await page.evaluate(async () => {
    const path = '/packages/player/src/public.ts'; const { exportSceneSvg } = await import(path);
    try { exportSceneSvg((window as unknown as { __COMPOSITION_STUDIO__: Studio }).__COMPOSITION_STUDIO__.session, 'geometry'); return 'unexpected success'; }
    catch (error) { return String(error); }
  });
  expect(previewCapture).toContain('preview');
  await page.mouse.up();
  await expect.poll(async () => (await studioState(page)).preview).toBeNull();
  const after = await studioState(page);
  expect(after.run?.id).not.toBe(before.run?.id);
  expect(after.run?.params.cx).toBeGreaterThan(0);
  expect(after.run?.params.cy).toBeLessThan(4);
  expect(after.error).toBeNull();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('label fill and opacity render explicitly and a group does not swallow child selection', async ({ page }) => {
  await openTriangle(page);
  await page.evaluate(async () => {
    const { session, guard } = (window as unknown as { __COMPOSITION_STUDIO__: Studio }).__COMPOSITION_STUDIO__;
    const candidate = await session.reviseCandidate([{ op: 'setMark', viewId: 'geometry', mark: {
      id: 'annotation-group', type: 'group', label: 'Annotation group', style: { opacity: .5 },
      children: [{ id: 'styled-label', type: 'label', label: 'Styled vertex label', text: 'Styled C', bindings: { position: 'c' }, offset: [25, 20], style: { fill: '#aa2233', opacity: .4 } }],
    } }], guard());
    await session.commitCandidate(candidate.id, guard());
  });
  await expect(page.locator('[data-mark-id="annotation-group"]')).toHaveAttribute('opacity', '0.5');
  const label = page.locator('[data-mark-id="styled-label"] text');
  await expect(label).toHaveAttribute('fill', '#aa2233');
  await expect(label).toHaveAttribute('opacity', '0.4');
  await page.getByRole('button', { name: 'Styled vertex label', exact: true }).click();
  await expect.poll(async () => (await studioState(page)).selection).toBe('styled-label');
});

test('keyboard selection and camera changes preserve scientific state, and SVG export pins the committed frame', async ({ page }) => {
  await openTriangle(page);
  await page.locator('[data-mark-id="vertex"]').focus(); await page.keyboard.press('Enter');
  await expect(page.locator('[data-mark-id="vertex"]')).toHaveAttribute('aria-pressed', 'true');
  const before = await studioState(page);
  await page.getByRole('button', { name: 'Zoom in Coordinate geometry' }).click();
  await page.getByRole('button', { name: 'Pan right Coordinate geometry' }).click();
  expect((await studioState(page)).run).toEqual(before.run);
  const frozen = await page.evaluate(async () => {
    const path = '/packages/player/src/public.ts'; const { exportSceneSvg } = await import(path);
    return exportSceneSvg((window as unknown as { __COMPOSITION_STUDIO__: Studio }).__COMPOSITION_STUDIO__.session, 'geometry');
  });
  expect(frozen.mimeType).toBe('image/svg+xml');
  expect(frozen.metadata.documentRevision).toBe(before.identity?.documentRevision);
  expect(frozen.metadata.runId).toBe(before.run?.id);
  expect(frozen.metadata.time).toBe(before.frame?.time);
  expect(frozen.svg).toContain('<metadata>');
  expect(frozen.svg).toContain('data-selected="true"');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => Number((await page.locator('svg[data-view-id="geometry"]').getAttribute('viewBox'))!.split(' ')[2])).toBeLessThan(400);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
