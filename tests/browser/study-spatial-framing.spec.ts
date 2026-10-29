/**
 * The 3D view on a narrow learner card (report §10.4, §13; G55, G52), in a real browser through the integration
 * fixture (`study-harness.html?template=<id>&spatial=1`) with `@experiment-kit/player-3d` loaded lazily:
 *
 * - at 320 and 390 px the default vectors of the vector-orientation activity span a readable fraction of the 3D view
 *   (the default camera frames the axes, their names and the drawn data instead of the box's bounding sphere);
 * - no label covers an arrowhead, at the default view, with every group shown and in each orientation preset;
 * - `Whole box` zooms out to the whole box (all eight corners in view: tests/player-3d/framing.test.ts), `Reset view`
 *   returns to the default framing;
 * - each rendered frame issues exactly the draw calls the plan counts, at most the spatial-3d@1.0 `drawCallsPerFrame`
 *   limit that the surface passes from the capability record.
 *
 * Evidence scope: Playwright Chromium (`npm run test:browser`), Firefox and WebKit (`npm run test:cross-browser`) with the
 * integration-fixture host; screenshots are written for inspection.
 */
import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { SpatialInspection, SpatialStats } from '@experiment-kit/player-3d';
import { card, openFixture, settle } from './support/study-harness';

const SHOTS = '/tmp/experiment-kit-playwright/study-spatial-framing';
mkdirSync(SHOTS, { recursive: true });
const VECTOR = '?template=vector-orientation-3d';
const SURFACE = '?template=quadratic-surface-gradient';
/** Minimum projected length of the default vectors as a fraction of the 3D view's shorter side. */
const READABLE = { v: 0.25, u: 0.16 };

type Inspection = SpatialInspection & { stats: SpatialStats };
interface SpatialModule { inspect(element: Element): Inspection | null }
type Fixture = { options: { spatialLoader: (() => Promise<SpatialModule>) | null } };
interface LabelBox { text: string; kind: string; box: [number, number, number, number] }

const spatial = (page: Page) => card(page).locator('[data-ek3-root]');
async function inspect3d(page: Page): Promise<Inspection | null> {
  return page.evaluate(async () => {
    const hooks = window.studyHarnessFixture as unknown as Fixture;
    const root = document.querySelector('[data-fx-card] [data-experiment-kit-activity]')?.shadowRoot?.querySelector('[data-ek3-root]');
    if (!root || !hooks.options.spatialLoader) return null;
    const result = (await hooks.options.spatialLoader()).inspect(root);
    return result ? JSON.parse(JSON.stringify(result)) as Inspection : null;
  });
}
async function ready3d(page: Page): Promise<Inspection> {
  // The 3D view loads and renders only while on screen: bring it into the (narrow, short) viewport first.
  await card(page).locator('[data-eka-spatial]').first().scrollIntoViewIfNeeded();
  await expect(spatial(page)).toHaveCount(1, { timeout: 15_000 });
  await card(page).locator('.ek3-viewport').scrollIntoViewIfNeeded();
  await expect(spatial(page)).toHaveAttribute('data-ek3-status', 'ready', { timeout: 15_000 });
  await expect.poll(async () => (await inspect3d(page))?.stats.frames ?? 0).toBeGreaterThan(0);
  await page.waitForTimeout(150);
  return (await inspect3d(page))!;
}
async function until3d(page: Page, check: (view: Inspection) => boolean, what: string): Promise<Inspection> {
  await expect.poll(async () => { const view = await inspect3d(page); return !!view && check(view); }, { message: what, timeout: 10_000 }).toBe(true);
  await page.waitForTimeout(150);
  return (await inspect3d(page))!;
}
/** Visible label boxes in the 3D viewport's coordinates (CSS pixels, y down). */
async function labelBoxes(page: Page): Promise<LabelBox[]> {
  return card(page).locator('.ek3-viewport').evaluate(viewport => {
    const origin = viewport.getBoundingClientRect();
    return [...viewport.querySelectorAll<HTMLElement>('.ek3-label')].filter(node => !node.hidden).map(node => {
      const rect = node.getBoundingClientRect();
      return { text: node.textContent ?? '', kind: node.dataset.kind ?? '', box: [rect.left - origin.left, rect.top - origin.top, rect.right - origin.left, rect.bottom - origin.top] as [number, number, number, number] };
    });
  });
}
/** Distance from a point to a segment, and from a segment to a box (independent of the renderer's layout code). */
const pointSegment = (p: number[], a: number[], b: number[]) => {
  const dx = b[0]! - a[0]!, dy = b[1]! - a[1]!, l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((p[0]! - a[0]!) * dx + (p[1]! - a[1]!) * dy) / l)) : 0;
  return Math.hypot(p[0]! - a[0]! - t * dx, p[1]! - a[1]! - t * dy);
};
function segmentBox(a: number[], b: number[], box: number[]): number {
  // Sample the segment densely: exact enough for pixel boxes and independent of the renderer's own geometry code.
  let best = Infinity;
  for (let i = 0; i <= 200; i++) {
    const x = a[0]! + (b[0]! - a[0]!) * i / 200, y = a[1]! + (b[1]! - a[1]!) * i / 200;
    best = Math.min(best, Math.hypot(Math.max(box[0]! - x, 0, x - box[2]!), Math.max(box[1]! - y, 0, y - box[3]!)));
  }
  const corners = [[box[0]!, box[1]!], [box[2]!, box[1]!], [box[2]!, box[3]!], [box[0]!, box[3]!]];
  return Math.min(best, ...corners.map(corner => pointSegment(corner, a, b)));
}
async function expectLabelsClearOfArrowheads(page: Page, view: Inspection, what: string): Promise<void> {
  const labels = await labelBoxes(page);
  expect(labels.length, `${what}: labels shown`).toBeGreaterThan(0);
  for (const arrow of view.arrows) for (const label of labels) {
    const distance = segmentBox(arrow.screen.base, arrow.screen.tip, label.box);
    expect(distance, `${what}: label "${label.text}" (${label.kind}) covers the arrowhead of ${arrow.markId}/${arrow.segmentId}`).toBeGreaterThanOrEqual(arrow.screen.headRadius);
  }
}
const length = (arrow: Inspection['arrows'][number]) => Math.hypot(arrow.screen.tip[0] - arrow.screen.tail[0], arrow.screen.tip[1] - arrow.screen.tail[1]);
async function shot3d(page: Page, name: string): Promise<void> {
  await spatial(page).scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await spatial(page).screenshot({ path: `${SHOTS}/${name}.png` });
}

test.describe('3D default framing on a narrow card (G55)', () => {
  for (const width of [320, 390]) {
    test(`at ${width} px the default vectors span a readable fraction of the 3D view and no label covers an arrowhead`, async ({ page }) => {
      test.setTimeout(90_000);
      await page.setViewportSize({ width, height: 900 });
      const errors = await openFixture(page, `${VECTOR}&spatial=1`);
      const view = await ready3d(page);
      const shorter = Math.min(view.viewport.width, view.viewport.height);
      const u = view.arrows.find(arrow => arrow.segmentId === 'u')!, v = view.arrows.find(arrow => arrow.segmentId === 'v')!;
      expect(length(v) / shorter, `|v| on screen at ${width} px (${Math.round(length(v))} of ${shorter} px)`).toBeGreaterThan(READABLE.v);
      expect(length(u) / shorter, `|u| on screen at ${width} px (${Math.round(length(u))} of ${shorter} px)`).toBeGreaterThan(READABLE.u);
      expect(view.framing.radius).toBeLessThan(view.framing.box);
      // Every axis end and the crossing point are on screen at the default framing.
      for (const axis of view.axes) {
        expect(axis.screen[0]).toBeGreaterThanOrEqual(0); expect(axis.screen[0]).toBeLessThanOrEqual(view.viewport.width);
        expect(axis.screen[1]).toBeGreaterThanOrEqual(0); expect(axis.screen[1]).toBeLessThanOrEqual(view.viewport.height);
      }
      await expectLabelsClearOfArrowheads(page, view, `default ${width}`);
      const axisNames = (await labelBoxes(page)).filter(label => label.kind === 'axis').map(label => label.text).sort();
      expect(axisNames).toEqual(['x', 'y', 'z']);
      await shot3d(page, `vector-default-${width}`);
      expect(errors).toEqual([]);
    });

    test(`at ${width} px with every group shown, in the default view and each preset, labels keep clear of every arrowhead`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width, height: 900 });
      const errors = await openFixture(page, `${VECTOR}&spatial=1&mode=free`);
      let view = await ready3d(page);
      view = await until3d(page, current => current.arrows.some(arrow => arrow.markId === 'cross-segment'), 'the cross product drawn');
      await expectLabelsClearOfArrowheads(page, view, `free default ${width}`);
      await shot3d(page, `vector-free-${width}`);
      for (const [name, preset] of [['Isometric view', 'isometric'], ['Front (x–z) view', 'front'], ['Top (x–y) view', 'top'], ['Side (y–z) view', 'side']] as const) {
        await spatial(page).getByRole('button', { name, exact: true }).click();
        view = await until3d(page, current => current.orbit.preset === preset, `${preset} preset`);
        await expectLabelsClearOfArrowheads(page, view, `free ${preset} ${width}`);
        await shot3d(page, `vector-free-${preset}-${width}`);
      }
      expect(errors).toEqual([]);
    });
  }

  test('Whole box zooms out to the whole box from the same direction; Reset view returns to the default framing', async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 390, height: 900 });
    const errors = await openFixture(page, `${VECTOR}&spatial=1`);
    const before = await ready3d(page);
    await spatial(page).getByRole('button', { name: 'Whole box (3D)', exact: true }).click();
    const whole = await until3d(page, current => Math.abs(current.orbit.zoom - before.framing.radius / before.framing.box) < 1e-6, 'whole-box zoom');
    expect(whole.orbit.azimuth).toBe(before.orbit.azimuth);
    // The arrows shrink by the zoom ratio; the box's bounding sphere fits the view (camera.ts wholeBoxZoom, unit-tested).
    const v0 = before.arrows.find(arrow => arrow.segmentId === 'v')!, v1 = whole.arrows.find(arrow => arrow.segmentId === 'v')!;
    expect(length(v1) / length(v0)).toBeCloseTo(whole.orbit.zoom, 1);
    await shot3d(page, 'vector-whole-box-390');
    await spatial(page).getByRole('button', { name: 'Reset view (3D)' }).click();
    const reset = await until3d(page, current => current.orbit.zoom === 1 && current.orbit.azimuth === -20 && current.orbit.elevation === 30, 'reset to the default framing');
    expect(length(reset.arrows.find(arrow => arrow.segmentId === 'v')!)).toBeCloseTo(length(v0), 0);
    expect(errors).toEqual([]);
  });
});

test.describe('per-frame draw calls of the 3D view (G52)', () => {
  for (const [name, query] of [['vector-orientation-3d', VECTOR], ['quadratic-surface-gradient', SURFACE]] as const) {
    test(`${name}: each frame issues exactly the planned draw calls, within the spatial-3d@1.0 limit passed from the capability record`, async ({ page }) => {
      test.setTimeout(60_000);
      const errors = await openFixture(page, `${query}&spatial=1&mode=free`);
      await ready3d(page);
      await settle(page);
      const view = await until3d(page, current => current.drawCalls.lastFrame !== null && current.drawCalls.lastFrame === current.counts.drawCalls, 'the rendered frame matches the plan');
      expect(view.limits.drawCallsPerFrame).toBe(128);
      expect(view.limits).toEqual({ vertices: 20_000, indices: 120_000, fieldSamples: 1_000, labels: 32, textureSize: 1024, drawCallsPerFrame: 128 });
      expect(view.drawCalls.lastFrame).toBe(view.drawCalls.scene);
      expect(view.drawCalls.lastFrame).toBeLessThanOrEqual(view.limits.drawCallsPerFrame);
      expect(view.stats.drawCalls).toBe(view.drawCalls.lastFrame);
      expect(view.rejected).toEqual([]);
      expect(errors).toEqual([]);
    });
  }
});
