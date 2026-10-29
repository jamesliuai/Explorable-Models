/**
 * The two spatial activities with the optional 3D renderer in a real browser (report §11, §12.4, §12.5, §13, §18;
 * A22, A36, A44–A47). It drives the generic flow of the integration fixture page
 * (`study-harness.html?template=<id>&spatial=1`): the fixture host, the real catalogue kernel module worker, the
 * activity adapter, the learner card in its shadow root and `@experiment-kit/player-3d` loaded through the host's lazy
 * loader. Rendered-scene facts come from the renderer's inspection hook (`inspect(element)`: world-space and screen
 * positions of the drawn arrows and axis ends, the camera, labels, notes, frame and resource counters).
 *
 * Evidence scope: Playwright Chromium (`npm run test:browser`), Firefox and WebKit (`npm run test:cross-browser`) with
 * the integration-fixture host; WebGL 2 is available headless in all three engines on macOS, so the 3D tests run in
 * each, and the no-WebGL tests block WebGL in each. These are fixture-host results; they say nothing about the Study
 * Harness host, a packaged WebView, Safari, assistive-technology use or learning benefit. The titles of
 * the alternative-equivalence tests contain the `verifiedBy` IDs of both spatial templates
 * (`tests/browser/study-spatial.spec.ts#<id>`).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { LearnerProjection } from '@experiment-kit/activity';
import type { SpatialInspection, SpatialStats } from '@experiment-kit/player-3d';
import { card, control, expectAccessible, focusKey, focused, openFixture, overflow, projection, respond, settle, tabTo, type FocusInfo } from './support/study-harness';

const SHOTS = '/tmp/experiment-kit-playwright/study-spatial';
mkdirSync(SHOTS, { recursive: true });
const VECTOR = '?template=vector-orientation-3d';
const SURFACE = '?template=quadratic-surface-gradient';

type Inspection = SpatialInspection & { stats: SpatialStats };
interface DriverResult { ok: boolean; codes: string[]; message: string; stage: string | null }
interface SpatialModule {
  inspect(element: Element): Inspection | null;
  mount(element: HTMLElement, options: unknown): { stats(): Record<string, unknown>; dispose(): void };
  releaseIdleRenderers(doc?: Document): number;
}
type Fixture = {
  options: { spatialLoader: (() => Promise<SpatialModule>) | null };
  template: { scenarios: { id: string; label: string }[] } | null;
  diagnostics: { code: string; message: string }[];
  binding: { getProjection(): { views: { kind: string }[]; presentationRevision: number }; setCamera(input: unknown): { ok: boolean } } | null;
  events(): { type: string; sequence: number }[];
  exposures(): { scope: string; displayStatus: string; groups: { groupId: string }[] }[];
};

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------
const spatial = (page: Page) => card(page).locator('[data-ek3-root]');
const viewport3d = (page: Page) => card(page).locator('.ek3-viewport');

/** The renderer's inspection of the card's 3D view (null when no renderer is mounted). */
async function inspect3d(page: Page): Promise<Inspection | null> {
  return page.evaluate(async () => {
    const hooks = window.studyHarnessFixture as unknown as Fixture;
    const root = document.querySelector('[data-fx-card] [data-experiment-kit-activity]')?.shadowRoot?.querySelector('[data-ek3-root]');
    if (!root || !hooks.options.spatialLoader) return null;
    const result = (await hooks.options.spatialLoader()).inspect(root);
    return result ? JSON.parse(JSON.stringify(result)) as Inspection : null;
  });
}
/** Waits until the renderer is mounted, ready and has drawn at least one frame. */
async function ready3d(page: Page): Promise<Inspection> {
  await expect(spatial(page)).toHaveAttribute('data-ek3-status', 'ready', { timeout: 15_000 });
  await expect.poll(async () => (await inspect3d(page))?.stats.frames ?? 0).toBeGreaterThan(0);
  return (await inspect3d(page))!;
}
/** Polls the inspection until `check` holds. */
async function until3d(page: Page, check: (view: Inspection) => boolean, what: string): Promise<Inspection> {
  await expect.poll(async () => { const view = await inspect3d(page); return !!view && check(view); }, { message: what, timeout: 10_000 }).toBe(true);
  return (await inspect3d(page))!;
}
const arrowsOf = (view: Inspection, markId: string) => view.arrows.filter(arrow => arrow.markId === markId);
const labelTexts = (view: Inspection) => view.labels.filter(label => label.kind === 'mark' || label.kind === 'segment').map(label => label.text);
const close = (actual: readonly number[], expected: readonly number[], tolerance = 1e-6) => actual.length === expected.length && actual.every((value, i) => Math.abs(value - expected[i]!) <= tolerance);
const unit = (v: readonly number[]) => { const n = Math.hypot(...v); return v.map(x => x / n); };
const screenVector = (arrow: { screen: { tail: [number, number]; tip: [number, number] } }): [number, number] => [arrow.screen.tip[0] - arrow.screen.tail[0], arrow.screen.tip[1] - arrow.screen.tail[1]];
/** Positive when the on-screen turn from a to b is counterclockwise as the viewer sees it (screen y flipped up). */
const turn = (a: [number, number], b: [number, number]) => a[0] * -b[1] - -a[1] * b[0];

async function drive(page: Page, call: string, argument?: string): Promise<DriverResult> {
  const result = await page.evaluate(([name, value]) => (window.studyHarnessFixture as unknown as Record<string, (input?: string) => Promise<DriverResult>>)[name!]!(value ?? undefined), [call, argument ?? null] as const);
  expect(result, `${call}(${argument ?? ''}): ${result.message}`).toMatchObject({ ok: true });
  await settle(page);
  return result;
}
async function revealAll(page: Page, groups: string[]): Promise<void> { for (const group of groups) await drive(page, 'reveal', group); }
const scenarioLabel = (page: Page, id: string): Promise<string> => page.evaluate(key => (window.studyHarnessFixture as unknown as Fixture).template!.scenarios.find(item => item.id === key)!.label, id);
async function scenario(page: Page, id: string): Promise<void> {
  const before = (await projection(page)).guards.expectedRunId;
  await card(page).getByRole('button', { name: await scenarioLabel(page, id), exact: true }).click();
  await expect.poll(async () => (await projection(page)).guards.expectedRunId).not.toBe(before);
  await settle(page);
}
async function rowText(page: Page, quantityId: string): Promise<string | null> {
  const row = card(page).locator(`[data-eka-panel="values"] .eka-value-row[data-quantity="${quantityId}"]`);
  if (!await row.count()) return null;
  return (await row.first().locator('dd').allTextContents()).join(' ').replace(/\s+/g, ' ').trim();
}
/** Body rows of a rendered table panel (cell texts), by its heading. */
async function tableRows(page: Page, title: string): Promise<string[][]> {
  const panel = card(page).locator('section[data-eka-panel="table"]').filter({ has: page.locator(`.eka-panel-title:text-is("${title}")`) });
  await expect(panel).toHaveCount(1);
  return panel.locator('tbody tr').evaluateAll(rows => rows.map(row => [...row.querySelectorAll('th, td')].map(cell => (cell.textContent ?? '').trim())));
}
const num = (text: string): number => Number(text.replace(/−/g, '-').replace(/,/g, '').replace(/[^0-9eE.+-]/g, ''));
const nums = (text: string): number[] => (text.replace(/−/g, '-').match(/-?\d+(\.\d+)?(e-?\d+)?/gi) ?? []).map(Number);
const mark = (projected: LearnerProjection, id: string) => projected.views.flatMap(view => view.marks).find(item => item.markId === id);
const tableValue = (projected: LearnerProjection, id: string) => projected.views.flatMap(view => view.table?.rows ?? []).find(row => row.key === id)?.cells[1];
const labelOf = (projected: LearnerProjection, id: string) => projected.views.flatMap(view => view.values).find(item => item.quantityId === id)?.label;
const controls = (projected: LearnerProjection): Record<string, number> => Object.fromEntries(projected.controls.map(item => [item.parameter, item.value]));
/** Independent analytic surface and gradient (the declared formulas, not the kernel). */
const f = (p: Record<string, number>, x: number, y: number) => (p.a! * x * x + 2 * p.b! * x * y + p.c! * y * y) / 2;
const gradient = (p: Record<string, number>, x: number, y: number): [number, number] => [p.a! * x + p.b! * y, p.b! * x + p.c! * y];

/** Full-page screenshot with the card at the top of the viewport (so it is not suspended as offscreen). */
async function shot(page: Page, name: string): Promise<void> {
  if (await card(page).count()) await card(page).evaluate(host => host.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}
/** Element screenshot of the 3D view (toolbar, viewport and notes). */
async function shot3d(page: Page, name: string): Promise<void> {
  await spatial(page).scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await spatial(page).screenshot({ path: `${SHOTS}/${name}.png` });
}
/** WebGL unavailable: every WebGL context request fails (as on a machine without GPU support). */
const blockWebgl = (page: Page) => page.addInitScript(() => {
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function getContext(this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
    if (/webgl/i.test(type)) return null;
    return (original as (...args: unknown[]) => unknown).call(this, type, ...rest);
  } as typeof original;
});
interface PageResources { contexts: { created: number; live: number }; canvases: number; nodes: number; listeners: string[]; lostWhileConnected: number }
/**
 * Resource counts kept by the page itself, in every engine (installed with addInitScript before any page script):
 * WebGL contexts created and still usable (held weakly; a lost context counts as released), canvases and element nodes
 * connected anywhere in the page (shadow roots included), listener registrations still in place on window, document,
 * media-query lists and connected nodes, and contexts lost while their canvas was still in the page (a view in use
 * losing its context, as opposed to a disposed renderer releasing one).
 */
function countPageResources(): void {
  const nativeAdd = EventTarget.prototype.addEventListener, nativeRemove = EventTarget.prototype.removeEventListener;
  const contexts: WeakRef<WebGLRenderingContext>[] = [];
  const seen = new WeakSet<object>();
  let created = 0, lostWhileConnected = 0;
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
    const context = (getContext as (...args: unknown[]) => unknown).call(this, type, ...rest);
    if (context && /webgl/i.test(type) && !seen.has(context as object)) {
      seen.add(context as object);
      created++;
      contexts.push(new WeakRef(context as WebGLRenderingContext));
      const canvas = this;
      nativeAdd.call(canvas, 'webglcontextlost', () => { if (canvas.isConnected) lostWhileConnected++; });
    }
    return context;
  } as typeof getContext;
  const ids = new WeakMap<object, number>();
  let next = 0;
  const idOf = (value: object) => { if (!ids.has(value)) ids.set(value, ++next); return ids.get(value)!; };
  const listeners = new Map<string, { target: WeakRef<EventTarget>; label: string }>();
  const keyOf = (target: EventTarget, type: string, listener: object, options: unknown) => {
    const capture = typeof options === 'boolean' ? options : !!(options as { capture?: boolean } | undefined)?.capture;
    return `${idOf(target)}:${type}#${idOf(listener)}${capture ? ':capture' : ''}`;
  };
  const describe = (target: EventTarget) => target === window ? 'window' : target === document ? 'document' : target instanceof MediaQueryList ? `mql(${target.media})`
    : target instanceof Element ? target.tagName.toLowerCase() : target instanceof ShadowRoot ? 'shadow-root' : target.constructor.name;
  EventTarget.prototype.addEventListener = function (this: EventTarget, type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
    if (listener && (typeof listener === 'function' || typeof listener === 'object')) {
      const key = keyOf(this, type, listener, options);
      if (!listeners.has(key)) {
        listeners.set(key, { target: new WeakRef(this), label: `${describe(this)}:${type}` });
        const capture = typeof options === 'boolean' ? options : !!options?.capture;
        if (typeof options === 'object' && options?.once) nativeAdd.call(this, type, () => listeners.delete(key), { once: true, capture });
        if (typeof options === 'object' && options?.signal) nativeAdd.call(options.signal, 'abort', () => listeners.delete(key), { once: true });
      }
    }
    return nativeAdd.call(this, type, listener, options);
  };
  EventTarget.prototype.removeEventListener = function (this: EventTarget, type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) {
    if (listener && (typeof listener === 'function' || typeof listener === 'object')) listeners.delete(keyOf(this, type, listener, options));
    return nativeRemove.call(this, type, listener, options);
  };
  const everyRoot = (visit: (root: Document | ShadowRoot) => void) => {
    const walk = (root: Document | ShadowRoot) => { visit(root); for (const element of root.querySelectorAll('*')) if (element.shadowRoot) walk(element.shadowRoot); };
    walk(document);
  };
  (window as unknown as { __pageResources: { counts(): PageResources } }).__pageResources = {
    counts: () => {
      let canvases = 0, nodes = 0;
      everyRoot(root => { canvases += root.querySelectorAll('canvas').length; nodes += root.querySelectorAll('*').length; });
      const held = [...listeners.values()].filter(entry => {
        const target = entry.target.deref();
        return !!target && (target === window || target === document || target instanceof MediaQueryList || (target instanceof Node && target.isConnected));
      }).map(entry => entry.label).sort();
      return { contexts: { created, live: contexts.filter(ref => { const context = ref.deref(); return !!context && !context.isContextLost(); }).length }, canvases, nodes, listeners: held, lostWhileConnected };
    },
  };
}
const inCard = (name: string | RegExp, tag?: string) => (info: FocusInfo) => info.inCard && (!tag || info.tag === tag) && (typeof name === 'string' ? info.name === name : name.test(info.name));
/**
 * Keyboard: the focus key (Tab; Option-Tab in WebKit on macOS, see `focusKey`) to the host button `[attribute="value"]`,
 * Enter, and wait for the host round trip.
 */
async function pressHost(page: Page, attribute: string, value: string): Promise<void> {
  await tabTo(page, info => info.data[attribute] === value, `the host button ${attribute}=${value}`, { max: 300 });
  const snapshot = () => page.evaluate(() => (window.studyHarnessFixture as unknown as { session: { getSnapshot(): { busy: string | null; lastResult: string } } }).session.getSnapshot());
  const before = (await snapshot()).lastResult;
  await page.keyboard.press('Enter');
  await page.waitForFunction(previous => {
    const current = (window.studyHarnessFixture as unknown as { session: { getSnapshot(): { busy: string | null; lastResult: string } } }).session.getSnapshot();
    return current.busy === null && current.lastResult !== previous && !current.lastResult.endsWith('…');
  }, before);
  await settle(page);
}
async function respondByKeyboard(page: Page, text: string): Promise<void> {
  await tabTo(page, info => info.id === 'fx-response', 'the host composer in the card');
  await page.keyboard.type(text);
  await page.keyboard.press(focusKey(page));
  expect((await focused(page))?.name).toMatch(/^Submit /);
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-fx-composer]')).toHaveCount(0);
  await settle(page);
}
const presentationCamera = async (page: Page, viewId: string) => (await projection(page)).presentation.views[viewId]?.camera as { preset?: string | null } | null | undefined;

const ANGLE_GROUPS = ['angle-dot', 'angle-arc', 'dot-values'];
const CROSS_GROUPS = ['cross', 'cross-drawing', 'cross-values'];
const ANGLE_QUANTITIES = ['dot', 'angle', 'relationship'];
const GRADIENT_GROUPS = ['gradient', 'gradient-drawing', 'gradient-values'];
const FIELD_GROUPS = ['field', 'minimum', 'minimum-values'];

// ---------------------------------------------------------------------------------------------
// Vector orientation (§12.4, A45)
// ---------------------------------------------------------------------------------------------
test.describe('spatial vector orientation with the 3D renderer', () => {
  test('§6.1 flow in 3D with staged disclosure: the angle and cross product reach neither the card nor the 3D drawing before the host reveals them (A22 A45)', async ({ page }) => {
    test.setTimeout(150_000);
    const errors = await openFixture(page, `${VECTOR}&spatial=1`);
    let view = await ready3d(page);
    expect(view.arrows.map(arrow => [arrow.segmentId, arrow.model.tip])).toEqual([['u', [2, 1, 0]], ['v', [1, 2, 2]]]);
    expect(labelTexts(view)).toEqual(['u', 'v']);
    expect(view.counts.vertices).toBe(4);
    for (const id of [...ANGLE_QUANTITIES, 'cross.norm']) expect(await rowText(page, id), id).toBeNull();
    await expect(spatial(page).getByRole('toolbar', { name: '3D view camera' })).toBeVisible();
    await expect(spatial(page)).toContainText('The frame is right-handed: x × y = z.');
    await expectAccessible(page, 'vector orient (3D)');
    await shot(page, 'vector-default');
    await shot3d(page, 'vector-default-3d');

    await drive(page, 'transition', 'predict');
    await respond(page, 'Acute angle, positive dot product, and u × v points mostly up out of the xy plane.');
    await drive(page, 'transition', 'explore-angle');
    view = (await inspect3d(page))!;
    expect(labelTexts(view), 'explore-angle before reveal').toEqual(['u', 'v']);
    for (const id of ANGLE_QUANTITIES) expect(await rowText(page, id), `${id} before reveal`).toBeNull();
    await drive(page, 'reveal', 'angle-dot');
    expect(await rowText(page, 'angle')).not.toBeNull();
    await drive(page, 'reveal', 'angle-arc');
    view = await until3d(page, current => labelTexts(current).includes('θ'), 'the angle arc label');
    expect(view.counts.vertices).toBe(4 + 33);
    expect(view.arrows.some(arrow => arrow.markId.startsWith('cross'))).toBe(false);
    await drive(page, 'reveal', 'dot-values');

    await drive(page, 'transition', 'explore-cross');
    view = (await inspect3d(page))!;
    expect(view.arrows.some(arrow => arrow.markId.startsWith('cross')), 'cross product before its reveal').toBe(false);
    expect(labelTexts(view)).not.toContain('u × v');
    expect(await rowText(page, 'cross.norm')).toBeNull();
    await drive(page, 'reveal', 'cross');
    view = await until3d(page, current => arrowsOf(current, 'cross-direction-arrow').length === 1, 'the cross-product direction arrow');
    expect(arrowsOf(view, 'cross-segment')).toEqual([]);
    await drive(page, 'reveal', 'cross-drawing');
    view = await until3d(page, current => arrowsOf(current, 'cross-segment').length === 1, 'the cross-product arrow');
    // u × v for u = (2, 1, 0), v = (1, 2, 2), computed here: (1·2 − 0·2, 0·1 − 2·2, 2·2 − 1·1).
    expect(close(arrowsOf(view, 'cross-segment')[0]!.model.tip, [2, -4, 3])).toBe(true);
    expect(labelTexts(view)).toContain('u × v');
    await drive(page, 'reveal', 'cross-values');
    const exposures = await page.evaluate(() => (window.studyHarnessFixture as unknown as Fixture).exposures());
    for (const group of [...ANGLE_GROUPS, ...CROSS_GROUPS]) expect(exposures.find(record => record.scope === 'reveal' && record.groups.some(item => item.groupId === group))?.displayStatus, group).toBe('displayed');
    await expectAccessible(page, 'vector explore-cross (3D)');
    await shot(page, 'vector-explore-cross');

    await drive(page, 'transition', 'explain');
    await respond(page, 'The dot product follows the angle; the cross product is perpendicular to both by the right-hand rule.');
    await drive(page, 'close');
    await expect(page.locator('[data-fx-no-card]')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('A45 handedness: e_x × e_y is drawn along +z and e_y × e_x along −z; the orientation presets show x, y and z where the right-handed frame puts them', async ({ page }) => {
    test.setTimeout(90_000);
    const errors = await openFixture(page, `${VECTOR}&spatial=1&mode=free`);
    await ready3d(page);
    await scenario(page, 'basis-x-y');
    let view = await until3d(page, current => arrowsOf(current, 'cross-segment').length === 1 && close(arrowsOf(current, 'cross-segment')[0]!.model.tip, [0, 0, 1]), 'e_x × e_y drawn');
    const science = await projection(page);
    expect(tableValue(science, 'cross')).toBe('(0, 0, 1)');
    for (const id of ['cross-segment', 'cross-direction-arrow']) {
      const [arrow] = arrowsOf(view, id);
      expect(close(arrow!.model.tail, [0, 0, 0]), id).toBe(true);
      expect(close(arrow!.model.tip, [0, 0, 1]), id).toBe(true);
      // The rendered cone sits at the tip and its axis points along +z in world space.
      expect(close(arrow!.apex, arrow!.tip, 1e-5), `${id} apex`).toBe(true);
      expect(close(arrow!.direction, [0, 0, 1], 1e-6), `${id} cone axis`).toBe(true);
    }
    // Default view (from above): the turn from u = e_x to v = e_y is counterclockwise and u × v points up the screen.
    const [u, v] = arrowsOf(view, 'vector-segments');
    expect(turn(screenVector(u!), screenVector(v!))).toBeGreaterThan(0);
    expect(screenVector(arrowsOf(view, 'cross-segment')[0]!)[1]).toBeLessThan(-10);
    // The axis arrowheads appear counterclockwise in the order x, y around the crossing point, with z up.
    const axes = view.axes.map(axis => [axis.screen[0] - view.origin[0], axis.screen[1] - view.origin[1]] as [number, number]);
    expect(turn(axes[0]!, axes[1]!)).toBeGreaterThan(0);
    expect(axes[2]![1]).toBeLessThan(0);
    await shot3d(page, 'vector-basis-default');

    const guards = science.guards, frameId = science.frame!.frameId, revision = science.presentationRevision;
    const preset = async (name: string, id: string) => {
      await spatial(page).getByRole('button', { name: `${name} view` }).click();
      await expect(spatial(page).getByRole('button', { name: `${name} view` })).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(async () => (await presentationCamera(page, 'space'))?.preset).toBe(id);
      return until3d(page, current => current.orbit.preset === id, `${id} preset drawn`);
    };
    view = await preset('Top (x–y)', 'top');
    let [x, y] = arrowsOf(view, 'vector-segments').map(screenVector);
    expect(x![0]).toBeGreaterThan(10); expect(Math.abs(x![1])).toBeLessThan(1);
    expect(y![1]).toBeLessThan(-10); expect(Math.abs(y![0])).toBeLessThan(1);
    // Seen from +z the cross product points at the viewer: it has no on-screen length.
    expect(Math.hypot(...screenVector(arrowsOf(view, 'cross-segment')[0]!))).toBeLessThan(1);
    await shot3d(page, 'vector-preset-top');
    view = await preset('Front (x–z)', 'front');
    [x, y] = arrowsOf(view, 'vector-segments').map(screenVector);
    expect(x![0]).toBeGreaterThan(10);
    expect(screenVector(arrowsOf(view, 'cross-segment')[0]!)[1]).toBeLessThan(-10);
    expect(Math.hypot(...y!)).toBeLessThan(1);
    await shot3d(page, 'vector-preset-front');
    view = await preset('Side (y–z)', 'side');
    [x, y] = arrowsOf(view, 'vector-segments').map(screenVector);
    expect(y![0]).toBeGreaterThan(10);
    expect(screenVector(arrowsOf(view, 'cross-segment')[0]!)[1]).toBeLessThan(-10);
    expect(Math.hypot(...x!)).toBeLessThan(1);
    await shot3d(page, 'vector-preset-side');
    await preset('Isometric', 'isometric');
    await shot3d(page, 'vector-preset-isometric');
    // Camera presets are presentation only.
    const after = await projection(page);
    expect(after.guards).toEqual(guards);
    expect(after.frame!.frameId).toBe(frameId);
    expect(after.presentationRevision).toBe(revision + 4);

    await scenario(page, 'basis-y-x');
    view = await until3d(page, current => arrowsOf(current, 'cross-segment').length === 1 && close(arrowsOf(current, 'cross-segment')[0]!.model.tip, [0, 0, -1]), 'e_y × e_x drawn');
    expect(close(arrowsOf(view, 'cross-segment')[0]!.direction, [0, 0, -1], 1e-6)).toBe(true);
    expect(tableValue(await projection(page), 'cross')).toBe('(0, 0, -1)');
    expect(errors).toEqual([]);
  });

  test('A45 cases: parallel and antiparallel vectors have no cross-product arrow and an undefined direction with its reason; orthogonal; a zero vector draws no arrow and leaves the angle undefined', async ({ page }) => {
    test.setTimeout(90_000);
    const errors = await openFixture(page, `${VECTOR}&spatial=1&mode=free`);
    await ready3d(page);
    for (const [id, relationship, degrees, reason] of [['pair-a', 'parallel', 0, 'the same direction'], ['pair-b', 'antiparallel', 180, 'opposite directions']] as const) {
      await scenario(page, id);
      const view = await until3d(page, current => !current.arrows.some(arrow => arrow.markId.startsWith('cross')), `${id}: no cross arrow`);
      expect(view.arrows.map(arrow => arrow.segmentId)).toEqual(['u', 'v']);
      const note = view.notes.find(item => item.markId === 'cross-direction-arrow')!;
      expect(note.kind).toBe('undefined');
      expect(note.text).toContain(reason);
      await expect(spatial(page).locator('.ek3-notes li[data-kind="undefined"]')).toContainText('Direction of u × v (length 1, not to scale): undefined');
      expect(await rowText(page, 'relationship'), id).toMatch(new RegExp(`^${relationship}\\b`));
      expect(nums((await rowText(page, 'angle'))!)[0], `${id}: ${await rowText(page, 'angle')}`).toBeCloseTo(degrees, 9);
      expect(view.notes.some(item => item.markId === 'angle-arc-curve' && item.kind === 'gap'), `${id}: arc gap`).toBe(true);
      await shot3d(page, `vector-${relationship}`);
    }
    await scenario(page, 'pair-c');
    let view = await until3d(page, current => arrowsOf(current, 'cross-segment').length === 1, 'orthogonal: cross arrow');
    const cross = arrowsOf(view, 'cross-segment')[0]!.model.tip;
    const u = [1, 2, 2], v = [2, 1, -2];
    expect(Math.abs(cross[0] * u[0]! + cross[1] * u[1]! + cross[2] * u[2]!)).toBeLessThan(1e-9);
    expect(Math.abs(cross[0] * v[0]! + cross[1] * v[1]! + cross[2] * v[2]!)).toBeLessThan(1e-9);
    expect(nums((await rowText(page, 'angle'))!)[0]).toBeCloseTo(90, 9);
    expect(await rowText(page, 'relationship')).toMatch(/^orthogonal\b/);
    await scenario(page, 'pair-e');
    view = await until3d(page, current => current.arrows.length === 1, 'zero vector: one arrow');
    expect(view.arrows.map(arrow => arrow.segmentId)).toEqual(['v']);
    expect(labelTexts(view)).toEqual(['v']);
    expect(await rowText(page, 'angle')).toMatch(/^Undefined.*zero vector/);
    await shot3d(page, 'vector-zero');
    expect(errors).toEqual([]);
  });

  test('alternative projection-views: the three plane plots and the 3D view’s own x–y projection draw exactly the projected components of the 3D arrows', async ({ page }) => {
    const errors = await openFixture(page, `${VECTOR}&spatial=1&mode=free`);
    const view = await ready3d(page);
    const shown = await projection(page);
    for (const [plane, axes] of [['xy', [0, 1]], ['xz', [0, 2]], ['yz', [1, 2]]] as const) {
      const geometry = mark(shown, `projection-${plane}-segments`)!.geometry as { segments: { id: string; to: number[] }[] };
      for (const arrow of arrowsOf(view, 'vector-segments')) {
        const projected = [arrow.model.tip[axes[0]], arrow.model.tip[axes[1]]];
        const segment = geometry.segments.find(item => item.id === arrow.segmentId);
        if (projected.every(value => value === 0)) expect(segment, `${plane}/${arrow.segmentId}`).toBeUndefined();
        else expect(segment!.to, `${plane}/${arrow.segmentId}`).toEqual(projected);
      }
    }
    // The 3D view's own projection and coordinate table are available while the renderer runs.
    await card(page).locator('[data-eka-spatial="space"]').getByRole('button', { name: '2D projection and table' }).click();
    await expect(card(page).getByRole('heading', { name: '3D view: x–y projection' })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('alternative projection-table-equivalent: the projection table lists exactly the components each projection plot draws', async ({ page }) => {
    const errors = await openFixture(page, `${VECTOR}&spatial=1&mode=free`);
    await ready3d(page);
    await scenario(page, 'pair-c');
    await card(page).getByRole('button', { name: 'Projection table' }).click();
    const rows = await tableRows(page, 'Projection table');
    const shown = await projection(page);
    for (const plane of ['xy', 'xz', 'yz'] as const) {
      const geometry = mark(shown, `projection-${plane}-segments`)!.geometry as { segments: { id: string; to: number[] }[] };
      for (const vector of ['u', 'v']) {
        const row = rows.find(cells => cells[0]!.startsWith(`${vector} projected onto the ${plane} plane`))!;
        expect(row, `${vector}.${plane} row`).toBeTruthy();
        const segment = geometry.segments.find(item => item.id === vector);
        expect(nums(row[1]!), `${vector}.${plane}`).toEqual(segment ? segment.to : [0, 0]);
      }
    }
    expect(errors).toEqual([]);
  });

  test('alternative text-description (vector-orientation-3d): generated summaries of the 3D view from visible values only', async ({ page }) => {
    const errors = await openFixture(page, `${VECTOR}&spatial=1`);
    await ready3d(page);
    const summary = card(page).locator('[data-eka-spatial="space"] figure .eka-figure-foot p').last();
    await expect(summary).toHaveClass(/eka-sr/);
    await card(page).getByRole('button', { name: 'Text description' }).click();
    await expect(summary).toHaveClass(/eka-description/);
    const text = (await summary.textContent())!;
    expect(text.length).toBeGreaterThan(20);
    for (const hidden of ['θ', 'u × v', 'Angle between', 'Cross product']) expect(text, hidden).not.toContain(hidden);
    expect(errors).toEqual([]);
  });

  test('alternative exact-entry (vector-orientation-3d): typed components commit exactly and move the 3D arrows; invalid input is explained and changes nothing', async ({ page }) => {
    const errors = await openFixture(page, `${VECTOR}&spatial=1&mode=free`);
    await ready3d(page);
    const type = async (parameter: string, value: string) => {
      const box = control(page, parameter).getByRole('textbox');
      await box.fill(value);
      await box.press('Enter');
    };
    for (const [parameter, value] of [['ux', '1'], ['uy', '0'], ['uz', '0'], ['vx', '0'], ['vy', '1'], ['vz', '0']] as const) {
      await type(parameter, value);
      await expect.poll(async () => controls(await projection(page))[parameter]).toBe(Number(value));
      await settle(page);
    }
    const view = await until3d(page, current => arrowsOf(current, 'cross-segment').length === 1 && close(arrowsOf(current, 'cross-segment')[0]!.model.tip, [0, 0, 1]), 'typed basis vectors');
    expect(arrowsOf(view, 'vector-segments').map(arrow => arrow.model.tip)).toEqual([[1, 0, 0], [0, 1, 0]]);
    const run = (await projection(page)).guards.expectedRunId;
    await type('uz', '4');
    await expect(control(page, 'uz').locator('.eka-error')).toBeVisible();
    expect((await projection(page)).guards.expectedRunId).toBe(run);
    expect(controls(await projection(page)).uz).toBe(0);
    expect(errors).toEqual([]);
  });

  test('alternative keyboard-only (vector-orientation-3d): the whole flow, 3D presets and bounded 3D rotation without a pointer (A36)', async ({ page }) => {
    test.setTimeout(180_000);
    const errors = await openFixture(page, `${VECTOR}&spatial=1`);
    await ready3d(page);
    await page.locator('body').focus();
    // The camera toolbar is one tab stop with roving focus; the viewport is one more.
    await tabTo(page, inCard('Isometric view', 'button'), 'the 3D camera toolbar');
    await page.keyboard.press('ArrowRight');
    expect((await focused(page))?.name).toBe('Front (x–z) view');
    await page.keyboard.press('Enter');
    await until3d(page, view => view.orbit.preset === 'front', 'front preset by keyboard');
    await expect.poll(async () => (await presentationCamera(page, 'space'))?.preset).toBe('front');
    const revision = (await projection(page)).presentationRevision;
    await page.keyboard.press(focusKey(page));
    expect((await focused(page))?.name).toMatch(/^3D view: Front \(x–z\) view/);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowUp');
    await until3d(page, current => current.orbit.azimuth === -120 && current.orbit.elevation === 15, 'keyboard rotation in 15° steps');
    await page.keyboard.press('+');
    await until3d(page, current => current.orbit.zoom === 1.25, 'keyboard zoom');
    // One committed camera after the pause, not one per key.
    await expect.poll(async () => (await projection(page)).presentationRevision).toBe(revision + 1);
    await page.waitForTimeout(600);
    expect((await projection(page)).presentationRevision).toBe(revision + 1);
    await page.keyboard.press('Home');
    const view = await until3d(page, current => current.orbit.azimuth === -20 && current.orbit.elevation === 30 && current.orbit.zoom === 1, 'Home resets');
    expect(view.orbit.preset).toBeNull();

    await pressHost(page, 'data-fx-transition', 'predict');
    await respondByKeyboard(page, 'Acute angle and a positive dot product.');
    await pressHost(page, 'data-fx-transition', 'explore-angle');
    for (const group of ANGLE_GROUPS) await pressHost(page, 'data-fx-reveal', group);
    await tabTo(page, inCard(/^x component of u/, 'input'), 'the u_x slider');
    const before = controls(await projection(page)).ux!;
    await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => controls(await projection(page)).ux).toBe(before - 0.5);
    await settle(page);
    await pressHost(page, 'data-fx-transition', 'explore-cross');
    for (const group of CROSS_GROUPS) await pressHost(page, 'data-fx-reveal', group);
    await until3d(page, current => arrowsOf(current, 'cross-segment').length === 1, 'cross product drawn');
    await pressHost(page, 'data-fx-transition', 'explain');
    await respondByKeyboard(page, 'The angle sets the dot product; the cross product follows the right-hand rule.');
    await pressHost(page, 'data-fx-action', 'close');
    await expect(page.locator('[data-fx-no-card]')).toBeVisible();
    expect(errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Quadratic surface and gradient (§12.5, A46)
// ---------------------------------------------------------------------------------------------
test.describe('quadratic surface and gradient with the 3D renderer', () => {
  test('§6.1 flow in 3D with staged disclosure, sampling and scale disclosures (A22 A46)', async ({ page }) => {
    test.setTimeout(150_000);
    const errors = await openFixture(page, `${SURFACE}&spatial=1`);
    let view = await ready3d(page);
    expect(view.arrows).toEqual([]);
    expect(view.counts).toMatchObject({ vertices: 41 * 41 + 1, indices: 40 * 40 * 6 + 2 * 40 * 41 * 2 });
    await expect(spatial(page).locator('.ek3-notes')).toContainText('Surface z = f(x, y): sampled on a 41 × 41 grid over x from −2 to 2 and y from −2 to 2');
    await expect(spatial(page).locator('.ek3-notes li[data-kind="aspect"]')).toContainText('The vertical axis f(x, y) is drawn at its own scale');
    expect(await rowText(page, 'gradient')).toBeNull();
    await expectAccessible(page, 'surface orient (3D)');
    await shot(page, 'surface-default');
    await shot3d(page, 'surface-default-3d');

    await drive(page, 'transition', 'predict');
    await respond(page, 'Steepest uphill points away from the centre, across the contour line.');
    await drive(page, 'transition', 'explore-point');
    expect((await inspect3d(page))!.arrows, 'gradient before reveal').toEqual([]);
    for (const group of GRADIENT_GROUPS) await drive(page, 'reveal', group);
    view = await until3d(page, current => arrowsOf(current, 'gradient-arrow-3d').length === 1, 'gradient arrow drawn');
    expect(labelTexts(view)).toContain('∇f(p)');
    expect(nums((await rowText(page, 'gradient'))!)).toEqual([2.5, 1.5]);
    await drive(page, 'transition', 'explore-field');
    await expect(card(page)).not.toContainText('Arrow lengths are scaled by');
    for (const group of FIELD_GROUPS) await drive(page, 'reveal', group);
    await expect(card(page).locator('figure').filter({ has: page.locator('svg[data-eka-view-id="contour-plot"]') })).toContainText('Arrow lengths are scaled by');
    await expectAccessible(page, 'surface explore-field (3D)');
    await shot(page, 'surface-explore-field');
    await spatial(page).getByRole('button', { name: 'Wireframe surface' }).click();
    await until3d(page, current => current.wireframe, 'wireframe');
    await shot3d(page, 'surface-wireframe');
    await drive(page, 'transition', 'explain');
    await respond(page, 'The gradient is perpendicular to the contour line and grows with the coefficients.');
    await drive(page, 'close');
    await expect(page.locator('[data-fx-no-card]')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('A46: the 3D gradient arrow agrees with the analytic gradient, lies at height f(p), matches the contour view’s arrow and is perpendicular to the contour through p; the minimum has no arrow', async ({ page }) => {
    test.setTimeout(90_000);
    const errors = await openFixture(page, `${SURFACE}&spatial=1&mode=free`);
    await ready3d(page);
    for (const id of ['default-bowl', 'round-bowl', 'tilted-bowl']) {
      if (id !== 'default-bowl') await scenario(page, id);
      const shown = await projection(page);
      const p = controls(shown);
      const view = await until3d(page, current => { const arrow = arrowsOf(current, 'gradient-arrow-3d')[0]; return !!arrow && close(arrow.model.tail.slice(0, 2), [p.px!, p.py!]); }, `${id}: gradient arrow at p`);
      const arrow = arrowsOf(view, 'gradient-arrow-3d')[0]!;
      const height = f(p, p.px!, p.py!);
      expect(arrow.model.tail[2], `${id}: tail at f(p)`).toBeCloseTo(height, 9);
      expect(arrow.model.tip[2], `${id}: tip at f(p)`).toBeCloseTo(height, 9);
      const g = gradient(p, p.px!, p.py!);
      const drawn = unit([arrow.model.tip[0] - arrow.model.tail[0], arrow.model.tip[1] - arrow.model.tail[1]]);
      expect(close(drawn, unit(g), 1e-9), `${id}: direction ${drawn} vs ${unit(g)}`).toBe(true);
      // The drawn length is the disclosed arrow scale times |∇f(p)|.
      const scale = num((await rowText(page, 'arrow.scale'))!);
      expect(Math.hypot(arrow.model.tip[0] - arrow.model.tail[0], arrow.model.tip[1] - arrow.model.tail[1])).toBeCloseTo(scale * Math.hypot(...g), 9);
      // Linked contour view: the same arrow seen from above.
      const flat = (mark(shown, 'gradient-arrow')!.geometry as { segments: { from: number[]; to: number[] }[] }).segments[0]!;
      expect(close(flat.from, arrow.model.tail.slice(0, 2), 1e-12) && close(flat.to, arrow.model.tip.slice(0, 2), 1e-12), `${id}: 2D and 3D arrows`).toBe(true);
      // Perpendicular to the contour line through p (p lies on a drawn level in these settings).
      const contours = (mark(shown, 'contour-lines')!.geometry as { segments: { points: number[][] }[] }).segments;
      const line = contours.find(segment => Math.abs(f(p, segment.points[0]![0]!, segment.points[0]![1]!) - height) < 1e-6)!;
      expect(line, `${id}: a contour at f(p) = ${height}`).toBeTruthy();
      const distance = (point: number[]) => Math.hypot(point[0]! - p.px!, point[1]! - p.py!);
      let nearest = 0;
      line.points.forEach((point, i) => { if (distance(point) < distance(line.points[nearest]!)) nearest = i; });
      expect(distance(line.points[nearest]!), `${id}: p lies on the contour`).toBeLessThan(0.05);
      const previous = line.points[(nearest - 1 + line.points.length) % line.points.length]!, next = line.points[(nearest + 1) % line.points.length]!;
      const tangent = unit([next[0]! - previous[0]!, next[1]! - previous[1]!]);
      expect(Math.abs(tangent[0]! * unit(g)[0]! + tangent[1]! * unit(g)[1]!), `${id}: contour tangent · gradient direction`).toBeLessThan(0.02);
    }
    await expect(spatial(page).locator('.ek3-notes')).toContainText('sampled on a 41 × 41 grid');
    await expect(card(page).locator('figure').filter({ has: page.locator('svg[data-eka-view-id="contour-plot"]') })).toContainText('Arrow lengths are scaled by');
    await scenario(page, 'point-at-origin');
    const view = await until3d(page, current => arrowsOf(current, 'gradient-arrow-3d').length === 0, 'no gradient arrow at the minimum');
    expect(view.arrows).toEqual([]);
    expect(await rowText(page, 'gradient.direction')).toMatch(/^Undefined/);
    expect(nums((await rowText(page, 'minimum.location'))!)).toEqual([0, 0]);
    expect(errors).toEqual([]);
  });

  test('A46: turning, zooming and presetting the 3D camera changes only the presentation: same run, version, frame and values; the journal records view changes only', async ({ page }) => {
    const errors = await openFixture(page, `${SURFACE}&spatial=1&mode=free`);
    await ready3d(page);
    const before = await projection(page);
    const events = (await page.evaluate(() => (window.studyHarnessFixture as unknown as Fixture).events())).length;
    const gradientText = await rowText(page, 'gradient');
    await viewport3d(page).focus();
    // The four steps are one burst, dispatched in one task so that they always fall inside one quiet period
    // (KEY_COMMIT_MS): separate key presses took longer than that apart on a loaded machine, and each pause then
    // (correctly) committed its own camera. Real key presses and their single commit are covered by the A36
    // keyboard-only flow; this test is about what a camera commit changes.
    await viewport3d(page).evaluate(element => {
      for (const key of ['ArrowLeft', 'ArrowLeft', 'ArrowUp', '+']) element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    });
    await expect.poll(async () => (await projection(page)).presentationRevision).toBe(before.presentationRevision + 1);
    // The whole drag stays inside the window: focusing left the view partly below the window in Firefox, where
    // Playwright delivers no release beyond the window's edge.
    await viewport3d(page).evaluate(element => element.scrollIntoView({ block: 'center' }));
    const box = (await viewport3d(page).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 30, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => (await projection(page)).presentationRevision).toBe(before.presentationRevision + 2);
    await spatial(page).getByRole('button', { name: 'Top (x–y) view' }).click();
    await expect.poll(async () => (await projection(page)).presentationRevision).toBe(before.presentationRevision + 3);
    await spatial(page).getByRole('button', { name: 'Perspective projection' }).click();
    await expect.poll(async () => (await projection(page)).presentationRevision).toBe(before.presentationRevision + 4);
    const view = await until3d(page, current => current.orbit.preset === 'top' && current.orbit.projection === 'perspective', 'top preset in perspective');
    await shot3d(page, 'surface-top-perspective');
    const after = await projection(page);
    expect(after.guards).toEqual(before.guards);
    expect(after.frame!.frameId).toBe(before.frame!.frameId);
    expect(after.activityRevision).toBe(before.activityRevision);
    expect(await rowText(page, 'gradient')).toBe(gradientText);
    expect(after.presentation.views['surface-view']!.camera).toEqual(view.camera);
    // The fixture host checkpoints (saves a backup) after each journaled change; everything else is a view change.
    const added = (await page.evaluate(() => (window.studyHarnessFixture as unknown as Fixture).events())).slice(events).map(event => event.type);
    expect(added.filter(type => type !== 'artifact.saved')).toEqual(['view.changed', 'view.changed', 'view.changed', 'view.changed']);
    expect(errors).toEqual([]);
  });

  test('alternative contour-projection-gradient: the contour view shows the same point and gradient arrow as the 3D view, with f(p) and the gradient values alongside', async ({ page }) => {
    const errors = await openFixture(page, `${SURFACE}&spatial=1&mode=free`);
    await ready3d(page);
    await scenario(page, 'tilted-bowl');
    const view = await until3d(page, current => arrowsOf(current, 'gradient-arrow-3d').length === 1 && close(arrowsOf(current, 'gradient-arrow-3d')[0]!.model.tail.slice(0, 2), [1, 0]), 'tilted bowl arrow');
    const shown = await projection(page);
    const arrow = arrowsOf(view, 'gradient-arrow-3d')[0]!;
    expect(mark(shown, 'point-marker')!.at).toEqual(arrow.model.tail.slice(0, 2));
    const flat = (mark(shown, 'gradient-arrow')!.geometry as { segments: { to: number[] }[] }).segments[0]!;
    expect(close(flat.to, arrow.model.tip.slice(0, 2), 1e-12)).toBe(true);
    expect(num((await rowText(page, 'value'))!)).toBeCloseTo(arrow.model.tail[2], 9);
    expect(nums((await rowText(page, 'gradient'))!)).toEqual(gradient(controls(shown), 1, 0));
    expect(errors).toEqual([]);
  });

  test('alternative contour-projection-shape: each contour line lies on the drawn surface at its level; the levels are the five stated values (partial: nothing between levels)', async ({ page }) => {
    const errors = await openFixture(page, `${SURFACE}&spatial=1&mode=free`);
    await ready3d(page);
    const shown = await projection(page);
    const p = controls(shown);
    const contours = (mark(shown, 'contour-lines')!.geometry as { segments: { points: number[][] }[] }).segments;
    const levels = contours.map(segment => Number(f(p, segment.points[0]![0]!, segment.points[0]![1]!).toPrecision(9)));
    expect(levels).toEqual([0.25, 0.5, 1, 2, 4]);
    for (const [i, segment] of contours.entries()) for (const point of segment.points) expect(Math.abs(f(p, point[0]!, point[1]!) - levels[i]!)).toBeLessThan(1e-9);
    // The drawn 3D surface samples are the same function at the sampled grid points.
    const surface = mark(shown, 'surface-mesh')!.geometry as { xs: number[]; ys: number[]; z: number[] };
    for (const index of [0, 20, 420, 840, 1680]) {
      const x = surface.xs[index % surface.xs.length]!, y = surface.ys[Math.floor(index / surface.xs.length)]!;
      expect(surface.z[index]).toBeCloseTo(f(p, x, y), 12);
    }
    expect(errors).toEqual([]);
  });

  test('alternative equation-values-equivalent: the equation with the coefficient values fixes the cross-sections, contours and gradient values shown', async ({ page }) => {
    const errors = await openFixture(page, `${SURFACE}&spatial=1&mode=free`);
    await ready3d(page);
    await expect(card(page).locator('[data-eka-panel="equations"]').first()).toContainText('Surface');
    const shown = await projection(page);
    const equations = shown.views.flatMap(view => view.equations).map(equation => equation.plain);
    expect(equations).toContain('f(x, y) = (a·x² + 2b·x·y + c·y²)/2');
    expect(equations).toContain('∇f(x, y) = (∂f/∂x, ∂f/∂y) = (a·x + b·y, b·x + c·y)');
    const p = controls(shown);
    await card(page).getByRole('button', { name: 'Values table' }).click();
    for (const [title, along] of [['Cross-section along the x-axis: table', 'x'], ['Cross-section along the y-axis: table', 'y']] as const) {
      const rows = await tableRows(page, title);
      expect(rows).toHaveLength(81);
      for (const row of rows) { const s = num(row[0]!); expect(num(row[1]!), `${title} ${row[0]}`).toBeCloseTo(along === 'x' ? f(p, s, 0) : f(p, 0, s), 3); }
    }
    expect(nums((await rowText(page, 'gradient'))!)).toEqual(gradient(p, p.px!, p.py!));
    expect(errors).toEqual([]);
  });

  test('alternative value-table-equivalent: the values table lists p, f(p), the gradient and the lowest point exactly as the 3D and contour marks draw them', async ({ page }) => {
    const errors = await openFixture(page, `${SURFACE}&spatial=1&mode=free`);
    await ready3d(page);
    const view = await until3d(page, current => arrowsOf(current, 'gradient-arrow-3d').length === 1, 'gradient arrow');
    await card(page).getByRole('button', { name: 'Values table' }).click();
    const rows = await tableRows(page, 'Values table');
    const shown = await projection(page);
    const cell = (id: string) => { const label = labelOf(shown, id)!; const row = rows.find(item => item[0] === label); expect(row, `${id} (${label})`).toBeTruthy(); return row![1]!; };
    const arrow = arrowsOf(view, 'gradient-arrow-3d')[0]!;
    expect(nums(cell('point'))).toEqual(arrow.model.tail.slice(0, 2));
    expect(num(cell('value'))).toBeCloseTo(arrow.model.tail[2], 9);
    const scale = num(cell('arrow.scale'));
    const drawn = [(arrow.model.tip[0] - arrow.model.tail[0]) / scale, (arrow.model.tip[1] - arrow.model.tail[1]) / scale];
    expect(close(nums(cell('gradient')), drawn, 1e-9)).toBe(true);
    expect(nums(cell('minimum.location'))).toEqual(mark(shown, 'minimum-marker')!.at);
    expect(errors).toEqual([]);
  });

  test('alternative field-table-equivalent: the gradient field table lists the 81 sampled points with exactly the vectors the field arrows draw', async ({ page }) => {
    const errors = await openFixture(page, `${SURFACE}&spatial=1&mode=free`);
    await ready3d(page);
    await card(page).getByRole('button', { name: 'Values table' }).click();
    const rows = await tableRows(page, 'Gradient field table');
    const shown = await projection(page);
    const field = mark(shown, 'field-arrows')!.geometry as { samples: { at: number[]; vector: number[] }[] };
    expect(rows).toHaveLength(81);
    expect(field.samples).toHaveLength(81);
    const p = controls(shown);
    for (const [i, sample] of field.samples.entries()) {
      const cells = rows[i]!.map(num);
      expect(cells.slice(0, 2), `row ${i}`).toEqual(sample.at);
      expect(cells[2]).toBeCloseTo(sample.vector[0]!, 3);
      expect(cells[3]).toBeCloseTo(sample.vector[1]!, 3);
      const analytic = gradient(p, sample.at[0]!, sample.at[1]!);
      expect(sample.vector[0]).toBeCloseTo(analytic[0], 12);
      expect(sample.vector[1]).toBeCloseTo(analytic[1], 12);
    }
    expect(errors).toEqual([]);
  });

  test('alternative section-tables-equivalent: each cross-section table lists all 81 samples of its curve', async ({ page }) => {
    const errors = await openFixture(page, `${SURFACE}&spatial=1&mode=free`);
    await ready3d(page);
    await card(page).getByRole('button', { name: 'Values table' }).click();
    const shown = await projection(page);
    for (const [title, markId] of [['Cross-section along the x-axis: table', 'section-x-curve'], ['Cross-section along the y-axis: table', 'section-y-curve']] as const) {
      const rows = await tableRows(page, title);
      const points = (mark(shown, markId)!.geometry as { segments: { points: number[][] }[] }).segments.flatMap(segment => segment.points);
      expect(rows).toHaveLength(points.length);
      rows.forEach((row, i) => { expect(num(row[0]!)).toBeCloseTo(points[i]![0]!, 6); expect(num(row[1]!)).toBeCloseTo(points[i]![1]!, 3); });
    }
    expect(errors).toEqual([]);
  });

  test('alternative text-description (quadratic-surface-gradient): generated summaries of the surface view from visible values only', async ({ page }) => {
    const errors = await openFixture(page, `${SURFACE}&spatial=1`);
    await ready3d(page);
    await card(page).getByRole('button', { name: 'Text description' }).click();
    const summary = card(page).locator('[data-eka-spatial="surface-view"] figure .eka-figure-foot p.eka-description');
    await expect(summary).toBeVisible();
    const text = (await summary.textContent())!;
    expect(text.length).toBeGreaterThan(20);
    for (const hidden of ['∇f', 'Gradient arrow', 'Lowest point']) expect(text, hidden).not.toContain(hidden);
    expect(errors).toEqual([]);
  });

  test('alternative exact-entry (quadratic-surface-gradient): typed coordinates move the point on the 3D surface; coefficients that break a·c − b² > 0 are explained and not applied', async ({ page }) => {
    const errors = await openFixture(page, `${SURFACE}&spatial=1&mode=free`);
    await ready3d(page);
    for (const [parameter, value] of [['px', '0.5'], ['py', '-1']] as const) {
      const box = control(page, parameter).getByRole('textbox');
      await box.fill(value);
      await box.press('Enter');
      await expect.poll(async () => controls(await projection(page))[parameter]).toBe(Number(value));
      await settle(page);
    }
    const p = controls(await projection(page));
    const view = await until3d(page, current => close(arrowsOf(current, 'gradient-arrow-3d')[0]?.model.tail ?? [], [0.5, -1, f(p, 0.5, -1)], 1e-9), 'point moved');
    const arrow = arrowsOf(view, 'gradient-arrow-3d')[0]!;
    expect(close(unit([arrow.model.tip[0] - 0.5, arrow.model.tip[1] + 1]), unit(gradient(p, 0.5, -1)), 1e-9)).toBe(true);
    const run = (await projection(page)).guards.expectedRunId;
    const box = control(page, 'b').getByRole('textbox');
    await box.fill('3');
    await box.press('Enter');
    await expect(control(page, 'b').locator('.eka-error')).toBeVisible();
    expect((await projection(page)).guards.expectedRunId).toBe(run);
    expect(errors).toEqual([]);
  });

  test('alternative keyboard-only (quadratic-surface-gradient): the whole flow, moving p and turning the 3D view without a pointer (A36)', async ({ page }) => {
    test.setTimeout(180_000);
    const errors = await openFixture(page, `${SURFACE}&spatial=1`);
    await ready3d(page);
    await page.locator('body').focus();
    await tabTo(page, inCard('Isometric view', 'button'), 'the 3D camera toolbar');
    await page.keyboard.press('End');
    expect((await focused(page))?.name).toBe('Wireframe surface');
    await page.keyboard.press('Enter');
    await until3d(page, view => view.wireframe, 'wireframe by keyboard');
    await page.keyboard.press(focusKey(page));
    expect((await focused(page))?.name).toMatch(/^Surface: Default view/);
    await page.keyboard.press('ArrowRight');
    await until3d(page, view => view.orbit.azimuth === -5, 'rotation by keyboard');
    await pressHost(page, 'data-fx-transition', 'predict');
    await respondByKeyboard(page, 'Uphill, across the contour.');
    await pressHost(page, 'data-fx-transition', 'explore-point');
    for (const group of GRADIENT_GROUPS) await pressHost(page, 'data-fx-reveal', group);
    await tabTo(page, inCard(/^Point x-coordinate/, 'input'), 'the p_x slider');
    await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => controls(await projection(page)).px).toBeCloseTo(0.9, 9);
    await settle(page);
    await until3d(page, view => close(arrowsOf(view, 'gradient-arrow-3d')[0]?.model.tail.slice(0, 2) ?? [], [0.9, 1], 1e-9), 'point moved by keyboard');
    await pressHost(page, 'data-fx-transition', 'explore-field');
    for (const group of FIELD_GROUPS) await pressHost(page, 'data-fx-reveal', group);
    await pressHost(page, 'data-fx-transition', 'explain');
    await respondByKeyboard(page, 'The gradient crosses the contour lines at right angles.');
    await pressHost(page, 'data-fx-action', 'close');
    await expect(page.locator('[data-fx-no-card]')).toBeVisible();
    expect(errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// WebGL unavailable and the default 2D graph (A44)
// ---------------------------------------------------------------------------------------------
test.describe('without WebGL and on the 2D path (A44)', () => {
  test('alternative no-webgl-completion (vector-orientation-3d): without WebGL the card says so and the whole task completes through projections, tables and values', async ({ page }) => {
    test.setTimeout(150_000);
    await blockWebgl(page);
    const errors = await openFixture(page, `${VECTOR}&spatial=1`);
    // The fallback says exactly what it carries (G54): before the angle arc (a sampled curve) is shown, the table lists everything.
    await expect(card(page).locator('[data-state="spatial-fallback"]')).toContainText('3D graphics (WebGL) are not available here. The 2D projection and the coordinate table below show the same values as the 3D view.');
    await expect(card(page).locator('canvas')).toHaveCount(0);
    await expect(card(page).getByRole('heading', { name: '3D view: x–y projection' })).toBeVisible();
    expect(await page.evaluate(() => (window.studyHarnessFixture as unknown as Fixture).diagnostics.map(item => item.code))).toContain('SPATIAL_FALLBACK');
    // The coordinate table lists the full 3D start and end of every drawn vector (what one projection drops).
    const coordinates = await card(page).locator('section').filter({ has: page.getByRole('heading', { name: '3D view: coordinates' }) })
      .locator('tbody tr').evaluateAll(rows => rows.map(row => [...row.querySelectorAll('th, td')].map(cell => (cell.textContent ?? '').trim())));
    expect(coordinates.map(row => [row[0], row[1]])).toEqual([
      ['Vectors u and v from the origin, each labelled with its name: u', '(0, 0, 0) → (2, 1, 0)'],
      ['Vectors u and v from the origin, each labelled with its name: v', '(0, 0, 0) → (1, 2, 2)'],
    ]);
    await expectAccessible(page, 'vector without WebGL');
    await shot(page, 'vector-fallback');
    await drive(page, 'transition', 'predict');
    await respond(page, 'Acute; the cross product points up.');
    await drive(page, 'transition', 'explore-angle');
    await revealAll(page, ANGLE_GROUPS);
    expect(await rowText(page, 'angle')).not.toBeNull();
    await drive(page, 'transition', 'explore-cross');
    await revealAll(page, CROSS_GROUPS);
    await scenario(page, 'basis-x-y');
    await card(page).getByRole('button', { name: 'Projection table' }).click();
    const vectorRows = await tableRows(page, 'Vector table');
    expect(vectorRows.filter(row => /cross/i.test(row[0]!)).map(row => row[1])).toEqual(['(0, 0, 1)', '(0, 0, 1)']);
    // On the x–y projection u × v = e_z is seen end-on: the drawing says where it points and how long it is, never that
    // it is a zero vector.
    const xyProjection = card(page).locator('figure').filter({ has: page.getByRole('heading', { name: '3D view: x–y projection' }) });
    await expect(xyProjection.locator('.eka-notes')).toContainText('points along +z (length 1), straight along the axis this projection leaves out');
    await expect(xyProjection).toContainText('u × v (points along +z, seen end-on)');
    await expect(xyProjection).not.toContainText('zero vector (no direction)');
    await expect(xyProjection).not.toContainText('(zero vector)');
    await card(page).getByRole('toolbar', { name: 'Projection plane' }).getByRole('button', { name: 'x–z' }).click();
    await expect(card(page).getByRole('heading', { name: '3D view: x–z projection' })).toBeVisible();
    await shot(page, 'vector-fallback-explore-cross');
    await drive(page, 'transition', 'explain');
    await respond(page, 'Right-hand rule: e_x × e_y = e_z.');
    await drive(page, 'close');
    await expect(page.locator('[data-fx-no-card]')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('alternative no-webgl-completion (quadratic-surface-gradient): without WebGL the task completes through the contour view, cross-sections, tables and values', async ({ page }) => {
    test.setTimeout(150_000);
    await blockWebgl(page);
    const errors = await openFixture(page, `${SURFACE}&spatial=1`);
    await expect(card(page).locator('[data-state="spatial-fallback"]')).toContainText('3D graphics (WebGL) are not available here.');
    await expect(card(page).locator('canvas')).toHaveCount(0);
    await shot(page, 'surface-fallback');
    await drive(page, 'transition', 'predict');
    await respond(page, 'Across the contour.');
    await drive(page, 'transition', 'explore-point');
    await revealAll(page, GRADIENT_GROUPS);
    expect(nums((await rowText(page, 'gradient'))!)).toEqual([2.5, 1.5]);
    await drive(page, 'transition', 'explore-field');
    await revealAll(page, FIELD_GROUPS);
    await expect(card(page).locator('figure').filter({ has: page.locator('svg[data-eka-view-id="contour-plot"]') })).toContainText('Arrow lengths are scaled by');
    await card(page).getByRole('button', { name: 'Values table' }).click();
    expect(await tableRows(page, 'Gradient field table')).toHaveLength(81);
    await drive(page, 'transition', 'explain');
    await respond(page, 'Perpendicular to the contours.');
    await drive(page, 'close');
    await expect(page.locator('[data-fx-no-card]')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('a 2D template never requests Three.js or the spatial renderer, even with a loader configured; a 3D template requests them only through the loader', async ({ context }) => {
    test.setTimeout(90_000);
    const requested = async (query: string, act?: (page: Page) => Promise<unknown>): Promise<string[]> => {
      const page = await context.newPage();
      const urls: string[] = [];
      page.on('request', request => urls.push(new URL(request.url()).pathname));
      await openFixture(page, query);
      await act?.(page);
      await page.waitForTimeout(500);
      await page.close();
      return urls;
    };
    const spatialCode = (urls: string[]) => urls.filter(url => /three|player-3d|spatial-loader/i.test(url));
    expect(spatialCode(await requested('?template=function-derivative&spatial=1', page => drive(page, 'transition', 'predict')))).toEqual([]);
    expect(spatialCode(await requested('?template=quadratic-gradient-descent&spatial=1'))).toEqual([]);
    expect(spatialCode(await requested(VECTOR))).toEqual([]);
    const loaded = spatialCode(await requested(`${VECTOR}&spatial=1`, page => ready3d(page)));
    expect(loaded.some(url => /player-3d/.test(url))).toBe(true);
    expect(loaded.some(url => /three/.test(url))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Lifecycle: context loss, resize, suspension, disposal (A47)
// ---------------------------------------------------------------------------------------------
test.describe('3D renderer lifecycle (A47)', () => {
  test('WebGL context loss shows a visible state and the 2D projection, then the renderer restores itself and draws again', async ({ page }) => {
    const errors = await openFixture(page, `${VECTOR}&spatial=1&mode=free`);
    const before = await ready3d(page);
    await card(page).locator('.ek3-canvas').evaluate(canvas => {
      const gl = (canvas as HTMLCanvasElement).getContext('webgl2')!;
      gl.getExtension('WEBGL_lose_context')!.loseContext();
    });
    await expect(spatial(page)).toHaveAttribute('data-ek3-status', 'context-lost');
    await expect(spatial(page).locator('.ek3-state')).toBeVisible();
    await expect(spatial(page).locator('.ek3-state')).toContainText('Graphics context lost');
    await expect(card(page).locator('[data-eka-spatial="space"]')).toHaveAttribute('data-eka-spatial-state', 'context-lost');
    await expect(card(page).getByRole('heading', { name: '3D view: x–y projection' })).toBeVisible();
    // The free-explore view draws the angle arc (a sampled curve the coordinate table summarises), so neither the surface
    // nor the renderer's own state claims that the projection and table show the same values (G54 wording, S2).
    const lostWording = 'The 2D projection shows the same drawing seen along one axis; the coordinate table below lists the positioned items and summarises the rest';
    await expect(card(page).locator('[data-eka-spatial="space"]')).toContainText(`The 3D view is unavailable right now. ${lostWording}`);
    await expect(spatial(page).locator('.ek3-state')).toContainText(`Trying to restore the 3D view… ${lostWording}`);
    await expect(spatial(page).locator('.ek3-state')).not.toContainText('show the same values');
    await shot(page, 'vector-context-lost');
    // Automatic restore attempt (no user action).
    await expect(spatial(page)).toHaveAttribute('data-ek3-status', 'ready', { timeout: 10_000 });
    await expect(spatial(page).locator('.ek3-state')).toBeHidden();
    await expect(card(page).getByRole('heading', { name: '3D view: x–y projection' })).toHaveCount(0);
    const after = await until3d(page, view => view.stats.frames > before.stats.frames, 'a frame after restore');
    expect(after.arrows.map(arrow => arrow.segmentId)).toEqual(before.arrows.map(arrow => arrow.segmentId));
    const diagnostics = await page.evaluate(() => (window.studyHarnessFixture as unknown as Fixture).diagnostics.filter(item => item.code === 'SPATIAL_FALLBACK').map(item => item.message));
    expect(diagnostics.some(message => message.includes('context-lost'))).toBe(true);
    expect(errors).toEqual([]);
  });

  test('permanent WebGL context loss: after the automatic restore attempts the view reports failed, the 2D projection and coordinate table carry the task, and Try again starts a new renderer that is ready and draws (A44 A47)', async ({ page }) => {
    test.setTimeout(90_000);
    const consoleErrors: string[] = [], lossNotices: string[] = [];
    // Renderer and graphics-context messages: WebGL errors, too many contexts, and a forced loss of an already-lost
    // context (Three.js warns that the extension is missing). Page errors are collected by openFixture.
    // Three.js logs the loss itself ("Context Lost.") at log level; GPU driver performance notes are not counted.
    // Firefox reports every loss of a WebGL context, deliberate ones included, as the warning "WebGL context was lost.":
    // here the WebGL probe releasing its test context and the loss this test forces. Those notices are counted apart.
    page.on('console', message => {
      const text = message.text();
      if (!(message.type() === 'error' || message.type() === 'warning') || !/webgl|three|lose_context|context/i.test(text) || /GL Driver Message/.test(text)) return;
      if (/^\[JavaScript Warning: "WebGL context was lost\."/.test(text)) lossNotices.push(text); else consoleErrors.push(text);
    });
    const errors = await openFixture(page, `${VECTOR}&spatial=1&mode=free`);
    await ready3d(page);
    await card(page).evaluate(host => host.scrollIntoView({ block: 'start' }));
    // Lose the context and keep it lost: the context's own WEBGL_lose_context extension object (the one the renderer
    // restores through) ignores restore requests, as when the GPU process cannot give the page a context back.
    await card(page).locator('.ek3-canvas').evaluate(canvas => {
      const extension = (canvas as HTMLCanvasElement).getContext('webgl2')!.getExtension('WEBGL_lose_context')!;
      (window as unknown as { keptLost: WEBGL_lose_context }).keptLost = extension;
      Object.defineProperty(extension, 'restoreContext', { configurable: true, value: () => undefined });
      extension.loseContext();
    });
    await expect(spatial(page)).toHaveAttribute('data-ek3-status', 'context-lost');
    const lostAt = Date.now();
    // Three automatic attempts (0.8 s, 1.5 s and 3 s apart) fail, then the renderer reports `failed`.
    await expect(spatial(page)).toHaveAttribute('data-ek3-status', 'failed', { timeout: 20_000 });
    expect(Date.now() - lostAt).toBeGreaterThanOrEqual(5_000);
    const state = spatial(page).locator('.ek3-state');
    const surface = card(page).locator('[data-eka-spatial="space"]');
    await expect(state).toBeVisible();
    await expect(state).toContainText('The 3D view could not be restored');
    await expect(state).toContainText('The 2D projection shows the same drawing seen along one axis; the coordinate table below lists the positioned items and summarises the rest');
    await expect(state).not.toContainText('show the same values');
    await expect(state.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(surface).toHaveAttribute('data-eka-spatial-state', 'failed');
    await expect(surface).toContainText('The 3D view is unavailable right now');
    await expect(card(page).getByRole('button', { name: '2D projection and table' })).toHaveAttribute('aria-disabled', 'true');
    await expect(card(page).getByRole('heading', { name: '3D view: x–y projection' })).toBeVisible();
    const diagnostics = await page.evaluate(() => (window.studyHarnessFixture as unknown as Fixture).diagnostics.filter(item => item.code === 'SPATIAL_FALLBACK').map(item => item.message));
    expect(diagnostics.some(message => message.includes('reported failed'))).toBe(true);
    await shot(page, 'vector-context-failed');

    // The task goes on through the 2D alternative: a committed scenario reaches the coordinate table, the projection
    // plots and the values while the 3D view stays failed.
    await scenario(page, 'basis-x-y');
    const coordinates = await card(page).locator('section').filter({ has: page.getByRole('heading', { name: '3D view: coordinates' }) })
      .locator('tbody tr').evaluateAll(rows => rows.map(row => [...row.querySelectorAll('th, td')].map(cell => (cell.textContent ?? '').trim())));
    const drawn = coordinates.map(row => row[1]);
    expect(drawn).toEqual(expect.arrayContaining(['(0, 0, 0) → (1, 0, 0)', '(0, 0, 0) → (0, 1, 0)', '(0, 0, 0) → (0, 0, 1)']));
    expect(coordinates.find(row => row[1] === '(0, 0, 0) → (0, 0, 1)')![0]).toMatch(/cross/i);
    expect(tableValue(await projection(page), 'cross')).toBe('(0, 0, 1)');
    await card(page).getByRole('toolbar', { name: 'Projection plane' }).getByRole('button', { name: 'x–z' }).click();
    await expect(card(page).getByRole('heading', { name: '3D view: x–z projection' })).toBeVisible();
    await expect(spatial(page)).toHaveAttribute('data-ek3-status', 'failed');

    // Graphics are available again: Try again replaces the canvas and context, and the new renderer reports `ready`
    // to the surface, which hides its fallback and draws the committed frame in 3D.
    await page.evaluate(() => { Reflect.deleteProperty((window as unknown as { keptLost: object }).keptLost, 'restoreContext'); });
    // The 3D view stays on screen throughout (no offscreen/onscreen transition can mask a missing status report).
    await spatial(page).evaluate(root => root.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(300);
    const transitions = await page.evaluate(() => {
      const log: string[] = [];
      const shadow = document.querySelector('[data-fx-card] [data-experiment-kit-activity]')!.shadowRoot!;
      new MutationObserver(records => { for (const record of records) log.push(`${record.attributeName}=${(record.target as Element).getAttribute(record.attributeName!)}`); })
        .observe(shadow, { subtree: true, attributes: true, attributeFilter: ['data-eka-spatial-state', 'data-ek3-status'] });
      (window as unknown as { spatialTransitions: string[] }).spatialTransitions = log;
    }).then(() => () => page.evaluate(() => (window as unknown as { spatialTransitions: string[] }).spatialTransitions));
    await state.getByRole('button', { name: 'Try again' }).click();
    await expect(spatial(page)).toHaveAttribute('data-ek3-status', 'ready');
    await expect(state).toBeHidden();
    await expect(surface).toHaveAttribute('data-eka-spatial-state', 'ready');
    await expect(card(page).getByRole('heading', { name: '3D view: x–z projection' })).toHaveCount(0);
    await expect(card(page).getByRole('button', { name: '2D projection and table' })).not.toHaveAttribute('aria-disabled', 'true');
    const view = await until3d(page, current => current.stats.frames > 0 && arrowsOf(current, 'cross-segment').length === 1, 'the new renderer draws the committed frame');
    expect(close(arrowsOf(view, 'cross-segment')[0]!.model.tip, [0, 0, 1])).toBe(true);
    // Straight from failed to ready, reported to the surface (never through an offscreen suspension).
    expect(await transitions()).toEqual(['data-ek3-status=ready', 'data-eka-spatial-state=ready']);
    // One canvas with a live context; focus moved from the hidden Try again button to the 3D view.
    expect(await card(page).locator('.ek3-canvas').evaluateAll(canvases => canvases.map(canvas => (canvas as HTMLCanvasElement).getContext('webgl2')?.isContextLost()))).toEqual([false]);
    expect(await focused(page)).toMatchObject({ tag: 'div', inCard: true, name: expect.stringMatching(/^3D view: /) });
    await shot3d(page, 'vector-context-retried');
    expect(consoleErrors).toEqual([]);
    // No loss beyond the probe's release and the forced loss (zero notices in Chromium and WebKit, which report none).
    expect(lossNotices.length, lossNotices.join('\n')).toBeLessThanOrEqual(2);
    expect(errors).toEqual([]);
  });

  test('resize follows the viewport, and nothing is drawn while the view is offscreen or the tab is hidden; resuming draws once with no catch-up', async ({ page }) => {
    const errors = await openFixture(page, `${VECTOR}&spatial=1&mode=free`);
    const first = await ready3d(page);
    await page.setViewportSize({ width: 900, height: 1000 });
    const resized = await until3d(page, view => view.viewport.width !== first.viewport.width && view.stats.frames > first.stats.frames, 'resized drawing');
    expect(resized.stats.frames).toBeGreaterThan(first.stats.frames);
    const canvas = await card(page).locator('.ek3-canvas').evaluate(element => ({ width: (element as HTMLCanvasElement).width, css: element.getBoundingClientRect().width, ratio: Math.min(2, Math.max(1, devicePixelRatio)) }));
    expect(Math.abs(canvas.width - Math.floor(canvas.css) * canvas.ratio)).toBeLessThanOrEqual(canvas.ratio);

    // Offscreen: scroll the card away; a presentation change while offscreen draws nothing.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(spatial(page)).toHaveAttribute('data-ek3-status', 'suspended');
    const hidden = (await inspect3d(page))!.stats.frames;
    await page.evaluate(() => {
      const binding = (window.studyHarnessFixture as unknown as Fixture).binding!;
      const camera = { kind: '3d', projection: 'orthographic', position: [0, 0, 30], target: [0, 0, 0], up: [0, 1, 0], preset: 'top' };
      binding.setCamera({ operationId: `op-test-${Date.now()}`, expectedPresentationRevision: binding.getProjection().presentationRevision, viewId: 'space', camera });
    });
    await expect.poll(async () => (await inspect3d(page))!.orbit.preset).toBe('top');
    await page.waitForTimeout(500);
    expect((await inspect3d(page))!.stats.frames).toBe(hidden);
    await card(page).evaluate(host => host.scrollIntoView({ block: 'start' }));
    await expect(spatial(page)).toHaveAttribute('data-ek3-status', 'ready');
    await until3d(page, current => current.stats.frames > hidden, 'a frame on resume');
    await page.waitForTimeout(500);
    expect((await inspect3d(page))!.stats.frames - hidden, 'frames after resuming').toBe(1);

    // Hidden tab (page visibility) suspends as well, also across a resize.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(spatial(page)).toHaveAttribute('data-ek3-status', 'suspended');
    const tabHidden = (await inspect3d(page))!.stats.frames;
    await page.setViewportSize({ width: 1100, height: 1000 });
    await page.waitForTimeout(500);
    expect((await inspect3d(page))!.stats.frames).toBe(tabHidden);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(spatial(page)).toHaveAttribute('data-ek3-status', 'ready');
    await until3d(page, current => current.stats.frames === tabHidden + 1, 'one frame after the tab is visible again');
    expect(errors).toEqual([]);
  });

  test('50 mount/dispose cycles return every resource count to zero with no growth in listeners, DOM nodes or WebGL contexts, and the shown view keeps its context in every engine', async ({ page, browserName }) => {
    test.setTimeout(120_000);
    const warnings: string[] = [];
    page.on('console', message => { if (/webgl|context/i.test(message.text()) && message.type() !== 'log') warnings.push(message.text()); });
    // A source file saved during these cycles would make the dev server reload the page mid-measurement: the page's Vite
    // HMR socket is answered by a stub that sends nothing (the page itself is unchanged), as in the lifecycle spec.
    await page.routeWebSocket(url => url.searchParams.has('token'), () => undefined);
    await page.addInitScript(countPageResources);
    const errors = await openFixture(page, `${VECTOR}&spatial=1&mode=free`);
    await ready3d(page);
    // The JS heap after a forced collection, and the engine's own counts of every event listener and DOM node (detached
    // ones included), come from the Chrome DevTools Protocol, which Playwright offers in Chromium only. Every engine is
    // checked with the page's own counts (countPageResources).
    const cdp = browserName === 'chromium' ? await page.context().newCDPSession(page) : null;
    await cdp?.send('Performance.enable');
    const metrics = async () => {
      if (!cdp) return null;
      await cdp.send('HeapProfiler.collectGarbage');
      const { metrics: list } = await cdp.send('Performance.getMetrics');
      const value = (name: string) => list.find(item => item.name === name)!.value;
      return { listeners: value('JSEventListeners'), nodes: value('Nodes'), heap: value('JSHeapUsedSize') };
    };
    const resources = () => page.evaluate(() => (window as unknown as { __pageResources: { counts(): PageResources } }).__pageResources.counts());
    const cycles = (count: number) => page.evaluate(async total => {
      const hooks = window.studyHarnessFixture as unknown as Fixture;
      const module = await hooks.options.spatialLoader!();
      const view = hooks.binding!.getProjection().views.find(item => item.kind === 'scene3d');
      // A visible host (fixed in the viewport) so each renderer mounts, becomes ready and draws.
      const host = document.createElement('div');
      Object.assign(host.style, { position: 'fixed', left: '0', top: '0', width: '360px', zIndex: '10' });
      document.body.append(host);
      const frame = () => new Promise(resolve => requestAnimationFrame(() => resolve(null)));
      // Canvases in the light DOM, where the test host lives (the card's own canvas is inside its shadow root).
      const canvases = () => document.querySelectorAll('canvas').length;
      const contexts = () => (window as unknown as { __pageResources: { counts(): PageResources } }).__pageResources.counts().contexts;
      const samples: { live: Record<string, unknown>; after: Record<string, unknown>; children: number; canvases: number; contexts: { created: number; live: number } }[] = [];
      for (let i = 0; i < total; i++) {
        const instance = module.mount(host, { view, presentation: { camera: null, selection: null, layers: [] }, onCamera() {}, onSelect() {}, reducedMotion: true });
        // The first frame follows the first intersection report (bounded wait).
        for (let wait = 0; wait < 30 && !Number(instance.stats().frames); wait++) await frame();
        const live = instance.stats();
        instance.dispose();
        samples.push({ live, after: instance.stats(), children: host.childElementCount, canvases: canvases(), contexts: contexts() });
      }
      host.remove();
      return samples;
    }, count);
    const beforeWarmUp = await resources();
    await cycles(5);
    await page.waitForTimeout(300);
    const baseline = { cdp: await metrics(), page: await resources() };
    // The warm-up created one renderer, which the pool keeps after each disposal (a live context, no connected canvas).
    expect(baseline.page.contexts.created - beforeWarmUp.contexts.created, 'contexts created by the 5 warm-up mounts').toBe(1);
    expect(baseline.page.contexts.live, 'live contexts after the warm-up: the card\'s and one idle pooled renderer').toBe(beforeWarmUp.contexts.live + 1);
    const samples = await cycles(50);
    await page.waitForTimeout(300);
    const end = { cdp: await metrics(), page: await resources() };
    const first = samples[0]!.live;
    expect(Number(first.frames)).toBeGreaterThan(0);
    expect(Number(first.geometries)).toBeGreaterThan(5);
    for (const [i, sample] of samples.entries()) {
      expect(sample.live, `cycle ${i} live`).toMatchObject({ status: 'ready', geometries: first.geometries, materials: first.materials, rendererGeometries: first.rendererGeometries, programs: first.programs, listeners: first.listeners, observers: first.observers });
      expect(Number(sample.live.frames), `cycle ${i} frames`).toBeGreaterThan(0);
      expect(sample.after, `cycle ${i} after dispose`).toMatchObject({ status: 'disposed', geometries: 0, materials: 0, textures: 0, rendererGeometries: 0, listeners: 0, observers: 0, pending: 0, vertices: 0, labels: 0 });
      expect(sample.children, `cycle ${i} DOM`).toBe(0);
      // No canvas of a disposed renderer stays in the page.
      expect(sample.canvases, `cycle ${i} canvases`).toBe(0);
      // Every mount reused the pooled renderer: no context was created and none is left beyond the baseline's.
      expect(sample.contexts, `cycle ${i} contexts`).toEqual(baseline.page.contexts);
    }
    const tooMany = warnings.filter(text => /too many active webgl contexts/i.test(text));
    test.info().annotations.push({ type: 'A47 metrics', description: JSON.stringify({ engine: browserName, baseline, end, live: first, tooManyContextsWarnings: tooMany.length }) });
    // Every engine: the page's own counts return to the baseline. The 50 mounts reuse the pooled renderer, so no context is
    // created (WebKit counts lost contexts until they are collected and would otherwise lose an older live one). The
    // card's own 3D view keeps its one live context throughout (no context of a view still in the page was lost) and
    // stays ready.
    expect(end.page.contexts.created - baseline.page.contexts.created, 'contexts created by 50 mounts').toBe(0);
    expect(end.page.contexts.live, 'live WebGL contexts after 50 cycles').toBe(baseline.page.contexts.live);
    expect(end.page.canvases, 'connected canvases after 50 cycles').toBe(baseline.page.canvases);
    expect(end.page.nodes, 'connected DOM nodes after 50 cycles').toBe(baseline.page.nodes);
    expect(end.page.listeners, 'listeners on window, document, media queries and connected nodes after 50 cycles').toEqual(baseline.page.listeners);
    expect(end.page.lostWhileConnected, 'WebGL contexts lost while their canvas was in the page').toBe(0);
    await expect(spatial(page)).toHaveAttribute('data-ek3-status', 'ready');
    expect(await card(page).locator('.ek3-canvas').evaluateAll(canvases => canvases.map(canvas => (canvas as HTMLCanvasElement).getContext('webgl2')?.isContextLost())), 'the card\'s context').toEqual([false]);
    // Releasing the idle renderers returns the live contexts to the card's one (the count before any cycle).
    const released = await page.evaluate(async () => (await (window.studyHarnessFixture as unknown as Fixture).options.spatialLoader!()).releaseIdleRenderers());
    expect(released, 'idle renderers released').toBe(1);
    expect((await resources()).contexts, 'contexts after releasing the idle renderers').toEqual({ created: end.page.contexts.created, live: beforeWarmUp.contexts.live });
    expect(await page.evaluate(async () => (await (window.studyHarnessFixture as unknown as Fixture).options.spatialLoader!()).releaseIdleRenderers()), 'a second release finds none').toBe(0);
    await expect(spatial(page)).toHaveAttribute('data-ek3-status', 'ready');
    if (end.cdp && baseline.cdp) {
      expect(end.cdp.listeners - baseline.cdp.listeners, 'JS event listeners after 50 cycles').toBeLessThanOrEqual(5);
      expect(end.cdp.nodes - baseline.cdp.nodes, 'DOM nodes after 50 cycles').toBeLessThanOrEqual(50);
      expect(end.cdp.heap - baseline.cdp.heap, 'JS heap growth after 50 cycles (bytes)').toBeLessThan(8_000_000);
    }
    expect(tooMany).toEqual([]);
    expect(errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Spatial workloads (§18): local input feedback and commit-to-frame latency
// ---------------------------------------------------------------------------------------------
test.describe('spatial workloads (§18)', () => {
  for (const [name, query, scenarios] of [
    // Each scenario differs from the one before it (and the first from the starting parameters), so every commit draws.
    ['vector-orientation-3d', VECTOR, ['basis-x-y', 'pair-a', 'pair-c', 'pair-d']],
    ['quadratic-surface-gradient', SURFACE, ['round-bowl', 'tilted-bowl', 'stretched-bowl', 'default-bowl']],
  ] as const) {
    test(`${name}: camera input reaches a rendered frame within 100 ms at p95, and committed changes reach the 3D frame (measured in the running engine, this machine)`, async ({ page, browserName }) => {
      test.setTimeout(120_000);
      const errors = await openFixture(page, `${query}&spatial=1&mode=free`);
      await ready3d(page);
      await card(page).evaluate(host => host.scrollIntoView({ block: 'start' }));
      // Warm-up, then 40 keyboard rotations: time from the key event to the end of the frame that drew it.
      const input = await page.evaluate(async () => {
        const hooks = window.studyHarnessFixture as unknown as Fixture;
        const module = await hooks.options.spatialLoader!();
        const shadow = document.querySelector('[data-fx-card] [data-experiment-kit-activity]')!.shadowRoot!;
        const root = shadow.querySelector('[data-ek3-root]')!, viewport = shadow.querySelector<HTMLElement>('.ek3-viewport')!;
        viewport.focus();
        const frames = () => module.inspect(root)!.stats.frames;
        const samples: number[] = [];
        for (let i = 0; i < 45; i++) {
          const before = frames();
          const start = performance.now();
          viewport.dispatchEvent(new KeyboardEvent('keydown', { key: i % 2 ? 'ArrowLeft' : 'ArrowRight', bubbles: true }));
          while (frames() === before) await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
          if (i >= 5) samples.push(performance.now() - start);
        }
        return samples;
      });
      // Committed scientific changes (scenario → worker evaluation → projection → 3D rebuild → frame).
      const commits: number[] = [];
      for (let round = 0; round < 3; round++) for (const id of scenarios) {
        const label = await scenarioLabel(page, id);
        const elapsed = await page.evaluate(async text => {
          const hooks = window.studyHarnessFixture as unknown as Fixture;
          const module = await hooks.options.spatialLoader!();
          const shadow = document.querySelector('[data-fx-card] [data-experiment-kit-activity]')!.shadowRoot!;
          const root = shadow.querySelector('[data-ek3-root]')!;
          const target = [...shadow.querySelectorAll('button')].find(item => item.textContent === text)!;
          const before = module.inspect(root)!;
          const start = performance.now();
          target.click();
          for (;;) {
            await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
            const now = module.inspect(root)!;
            if (now.stats.frames > before.stats.frames && JSON.stringify(now.arrows) !== JSON.stringify(before.arrows) || performance.now() - start > 5000) break;
          }
          return performance.now() - start;
        }, label);
        commits.push(elapsed);
        await settle(page);
      }
      const percentile = (values: number[], q: number) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!; };
      const report = {
        template: name, machine: `local Playwright ${browserName} ${page.context().browser()?.version() ?? ''}, integration fixture, development server`.replace(/ ,/, ','),
        inputToFrame: { samples: input.length, p50: percentile(input, 0.5), p95: percentile(input, 0.95) },
        commitToFrame: { samples: commits.length, p50: percentile(commits, 0.5), p95: percentile(commits, 0.95) },
      };
      test.info().annotations.push({ type: '§18 spatial workload', description: JSON.stringify(report) });
      writeFileSync(`${SHOTS}/workload-${name}${browserName === 'chromium' ? '' : `-${browserName}`}.json`, `${JSON.stringify(report, null, 2)}\n`);
      expect(report.inputToFrame.p95, 'camera input → rendered frame, p95 (ms)').toBeLessThanOrEqual(100);
      expect(commits).toHaveLength(scenarios.length * 3);
      expect(report.commitToFrame.p95, 'scenario commit → rendered 3D frame, p95 (ms); a regression guard, not a declared budget').toBeLessThanOrEqual(1000);
      expect(errors).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------------------------
// Layout and themes
// ---------------------------------------------------------------------------------------------
test.describe('3D views at 390 px and in dark mode', () => {
  for (const [name, query] of [['vector', VECTOR], ['surface', SURFACE]] as const) {
    test(`${name}: a 390 px viewport and dark mode keep the 3D view, its toolbar and notes usable without overflow (A32 A36)`, async ({ context }) => {
      test.setTimeout(90_000);
      for (const configuration of [{ id: 'mobile-390', extra: '', viewport: { width: 390, height: 844 } }, { id: 'dark', extra: '&theme=dark', viewport: { width: 1440, height: 1000 } }]) {
        const page = await context.newPage();
        await page.setViewportSize(configuration.viewport);
        const errors = await openFixture(page, `${query}&spatial=1&mode=free${configuration.extra}`);
        const view = await ready3d(page);
        expect(await overflow(page), configuration.id).toMatchObject({ page: false, card: false, offenders: [] });
        const toolbar = (await spatial(page).getByRole('toolbar', { name: '3D view camera' }).boundingBox())!;
        const viewport = (await viewport3d(page).boundingBox())!;
        expect(toolbar.width).toBeLessThanOrEqual(viewport.width + 1);
        expect(viewport.height).toBeGreaterThan(200);
        expect(view.viewport.width).toBeGreaterThan(200);
        if (configuration.id === 'dark') {
          await expect(card(page).locator('.eka')).toHaveAttribute('data-theme', 'dark');
          expect(await viewport3d(page).evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(25, 33, 43)');
        }
        await expectAccessible(page, `${name} ${configuration.id}`);
        await shot(page, `${name}-${configuration.id}`);
        await shot3d(page, `${name}-${configuration.id}-3d`);
        expect(errors).toEqual([]);
        await page.close();
      }
    });
  }
});
