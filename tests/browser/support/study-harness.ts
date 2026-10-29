/**
 * Helpers for the Study Harness integration-fixture browser specs (`study-harness.html`). They read the learner card
 * through its open shadow root and the fixture's `window.studyHarnessFixture` hooks; the fixture host is a test
 * fixture, so every result here is a fixture-host Playwright result (Chromium in `npm run test:browser`, Firefox and
 * WebKit in `npm run test:cross-browser`), not evidence about the Study Harness host, a packaged WebView or Safari.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { AudienceState, ExposureRecord, InteractionEvent, LearnerProjection } from '@explorable-models/activity';

export const SHOTS = '/tmp/explorable-models-playwright/study-quadratic';

/** Learner-facing content of each solution-bearing group of the quadratic template (labels, titles and DOM IDs). */
export const HIDDEN = {
  trace: ['Position by iteration', 'Steps between successive iterates', 'Iterates (x_k, f(x_k))', 'Current iterate (x_n, f(x_n))', 'Position x_n at each iteration n', 'trace-plot', 'iterate-points', 'iterate-steps', 'current-iterate', 'trace-points'],
  observations: ['Update multiplier', 'Step size times curvature'],
  regime: ['Largest convergent step size', 'Convergence condition', 'monotone convergence', 'alternating convergence', 'oscillation', 'divergence'],
  substituted: ['Update rule with current values'],
} as const;
/** Value-row labels (`dt`) of the solution-bearing quantity groups. */
export const HIDDEN_VALUES = { observations: ['Position', 'Loss', 'Gradient', 'Update multiplier', 'Step size times curvature'], regime: ['Regime', 'Largest convergent step size'] } as const;
export type HiddenGroup = keyof typeof HIDDEN;

interface Fixture {
  session: {
    getSnapshot(): { steps: { id: string; state: string; reason: string | null }[]; phase: string; complete: boolean; composer: { kind: string } | null; interruptedStep: string | null; restoredNotes: string[] };
    runStep(step: string): Promise<string | null>; revokePolicy(): Promise<void>; saveNow(kind?: string): Promise<{ ok: boolean }>; interruptWithIndependentTask(): Promise<string | null>;
    mountExtra(width: number): string | null; disposeExtra(): void;
  };
  host: {
    snapshot(): { activities: Record<string, { events: InteractionEvent[]; exposures: ExposureRecord[]; receipts: { receiptId: string; idempotencyKey: string }[]; displayAcks: Record<string, string>; activityRevision: number; stage: string }>; recoveries: { exposureId: string }[]; starts: number; responses: { ref: { responseId: string; kind: string }; text: string; snapshotCursor: number | null }[]; artifacts: { kind: string; activityId: string; artifact: unknown }[] };
    calls(): { method: string; outcome: string; point: string | null }[];
    failNext(point: string, times?: number): void;
  };
  binding: { getProjection(): LearnerProjection; retryPersistence(input: { operationId: string }): Promise<unknown> } | null;
  prepared: { activityId: string } | null;
  surface: { surfaceId: string } | null;
  projectionLog: { projectionId: string; frameId: string | null; frameKind: string | null; ui: string; stage: string; previewId: string | null; activityId: string; at: number }[];
  state(): AudienceState | null;
  validate(contract: string, record: unknown): unknown[];
  capture(format: 'svg' | 'png', viewId?: string): Promise<{ companionText: string; metadata: Record<string, unknown>; width: number; height: number; mimeType: string; svg?: string; pngBase64?: string }>;
}
declare global { interface Window { studyHarnessFixture: Fixture } }

/** Opens the fixture page and waits until the host has started and the card shows the current projection. */
export async function openFixture(page: Page, query = ''): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`/study-harness.html${query}`);
  await page.waitForFunction(() => document.body.dataset.fixtureReady === 'true');
  await settle(page);
  return errors;
}

/** The learner card (its shadow host); Playwright locators pierce the open shadow root. */
export const card = (page: Page): Locator => page.locator('[data-fx-card] [data-explorable-models-activity]');
export const control = (page: Page, parameter: string): Locator => card(page).locator(`[data-parameter="${parameter}"]`);

export const projection = (page: Page): Promise<LearnerProjection> => page.evaluate(() => JSON.parse(JSON.stringify(window.studyHarnessFixture.binding!.getProjection())));
export const hostState = (page: Page): Promise<AudienceState> => page.evaluate(() => window.studyHarnessFixture.state()!);
export const activityId = (page: Page): Promise<string> => page.evaluate(() => window.studyHarnessFixture.prepared!.activityId);
export const tables = (page: Page) => page.evaluate(() => window.studyHarnessFixture.host.snapshot());
export async function hostEvents(page: Page, id?: string): Promise<InteractionEvent[]> {
  const activity = id ?? await activityId(page);
  return page.evaluate(key => window.studyHarnessFixture.host.snapshot().activities[key]?.events ?? [], activity);
}
export async function hostExposures(page: Page, id?: string): Promise<(ExposureRecord & { acked: boolean })[]> {
  const activity = id ?? await activityId(page);
  return page.evaluate(key => {
    const table = window.studyHarnessFixture.host.snapshot().activities[key];
    return (table?.exposures ?? []).map(record => ({ ...record, acked: !!table!.displayAcks[record.exposureId] }));
  }, activity);
}
export const types = (events: InteractionEvent[]): string[] => events.map(event => event.type);

/**
 * Waits until the fixture is quiet: no host step running, the journal saved, no reveal awaiting a display
 * acknowledgement, and the card's DOM showing the binding's current projection. `allowPending` waits only for the DOM
 * (a step may be waiting on a failed request that the test retries).
 */
export async function settle(page: Page, options: { allowPending?: boolean } = {}): Promise<void> {
  await page.waitForFunction(allowPending => {
    const fixture = window.studyHarnessFixture;
    if (!allowPending && fixture.session.getSnapshot().steps.some(step => step.state === 'running')) return false;
    const binding = fixture.binding;
    if (!binding) return true;
    const current = binding.getProjection();
    const root = document.querySelector('[data-fx-card] [data-explorable-models-activity]')?.shadowRoot?.querySelector('.ema');
    if (root?.getAttribute('data-ema-projection') !== current.projectionId) return false;
    if (allowPending) return true;
    return current.status.persistence === 'saved' && (!current.pendingReveal || current.pendingReveal.state === 'failed');
  }, options.allowPending ?? false);
}

/** Submits a response through the host composer (pointer-free when `keyboard`). */
export async function respond(page: Page, text: string): Promise<void> {
  const kind = await page.evaluate(() => window.studyHarnessFixture.session.getSnapshot().composer?.kind);
  expect(kind, 'a response is requested').toBeTruthy();
  await page.locator('#fx-response').fill(text);
  await page.locator('[data-fx-composer] button[type=submit]').click();
  await expect(page.locator('[data-fx-composer]')).toHaveCount(0);
  await settle(page);
}

/** Runs one host stage step from the host panel and waits until it is done. */
export async function step(page: Page, id: string): Promise<void> {
  await page.locator(`[data-fx-step="${id}"]`).click();
  await page.waitForFunction(stepId => window.studyHarnessFixture.session.getSnapshot().steps.find(item => item.id === stepId)?.state === 'done', id);
  await settle(page);
}

/** Learner card DOM (shadow root HTML and text). */
export async function cardDom(page: Page): Promise<{ html: string; text: string }> {
  return page.evaluate(() => {
    const root = document.querySelector('[data-fx-card] [data-explorable-models-activity]')?.shadowRoot;
    return { html: root?.innerHTML ?? '', text: root?.textContent ?? '' };
  });
}
export const valueLabels = async (page: Page): Promise<string[]> => (await card(page).locator('[data-ema-panel="values"] dt').allTextContents()).map(text => text.trim());

/** Text the card announces for “Read current values” (the learner's copy/read-out channel). */
export async function readCurrentValues(page: Page): Promise<string> {
  await card(page).getByRole('button', { name: 'Read current values' }).click();
  const live = card(page).locator('.ema-sr[role=status][aria-live=polite]');
  await expect(live).not.toHaveText('');
  return (await live.textContent()) ?? '';
}

/**
 * Hidden groups are absent from every learner channel: card DOM (HTML and text, including screen-reader-only text),
 * the accessibility tree, tables, value rows, the read-out text, an SVG capture (image, companion text, metadata) and a
 * learner snapshot artifact.
 */
export async function expectHidden(page: Page, groups: HiddenGroup[], label: string, options: { capture?: boolean; snapshot?: boolean } = {}): Promise<void> {
  const markers = groups.flatMap(group => [...HIDDEN[group]]);
  const values = groups.flatMap(group => group in HIDDEN_VALUES ? [...HIDDEN_VALUES[group as keyof typeof HIDDEN_VALUES]] : []);
  const dom = await cardDom(page);
  const aria = await page.locator('[data-fx-card]').ariaSnapshot();
  const readOut = await readCurrentValues(page);
  for (const marker of markers) {
    expect(dom.html, `${label}: card HTML contains ${marker}`).not.toContain(marker);
    expect(aria, `${label}: accessibility tree contains ${marker}`).not.toContain(marker);
    expect(readOut, `${label}: read-out contains ${marker}`).not.toContain(marker);
  }
  const rows = await valueLabels(page);
  for (const value of values) {
    expect(rows, `${label}: value row ${value}`).not.toContain(value);
    expect(readOut, `${label}: read-out names ${value}`).not.toMatch(new RegExp(`(^|\\. )${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`));
  }
  if (groups.includes('trace')) expect(await card(page).locator('table').count(), `${label}: tables`).toBe(0);
  if (options.capture !== false) {
    const capture = await page.evaluate(() => window.studyHarnessFixture.capture('svg'));
    const blob = `${capture.svg}\n${capture.companionText}\n${JSON.stringify(capture.metadata)}`;
    for (const marker of markers) expect(blob, `${label}: capture contains ${marker}`).not.toContain(marker);
    for (const value of values) expect(capture.companionText, `${label}: capture companion names ${value}`).not.toContain(`- ${value}:`);
  }
  if (options.snapshot) {
    const id = await activityId(page);
    await page.evaluate(() => window.studyHarnessFixture.session.saveNow('learner-snapshot'));
    const snapshot = await page.evaluate(key => JSON.stringify(window.studyHarnessFixture.host.snapshot().artifacts.filter(entry => entry.activityId === key && entry.kind === 'learner-snapshot').at(-1)?.artifact ?? null), id);
    expect(snapshot).not.toBe('null');
    for (const marker of markers) expect(snapshot, `${label}: learner snapshot contains ${marker}`).not.toContain(marker);
  }
}

/** The groups' content is present in the card DOM and the accessibility tree. */
export async function expectShown(page: Page, groups: HiddenGroup[], label: string): Promise<void> {
  const dom = await cardDom(page);
  const aria = await page.locator('[data-fx-card]').ariaSnapshot();
  const rows = await valueLabels(page);
  if (groups.includes('trace')) { expect(dom.html, label).toContain('Position by iteration'); expect(aria, label).toContain('Position by iteration'); }
  if (groups.includes('observations')) for (const value of HIDDEN_VALUES.observations) expect(rows, `${label}: ${value}`).toContain(value);
  if (groups.includes('regime')) for (const value of HIDDEN_VALUES.regime) expect(rows, `${label}: ${value}`).toContain(value);
  if (groups.includes('substituted')) expect(dom.text, label).toContain('Update rule with current values');
}

/** axe-core over the whole page (host chrome and the card's shadow root): no serious or critical violations. */
export async function expectAccessible(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const serious = results.violations.filter(violation => violation.impact === 'serious' || violation.impact === 'critical');
  expect(serious.map(violation => `${violation.id}: ${violation.nodes.map(node => node.target.join(' > ')).join(' | ')}`), `axe at ${label}`).toEqual([]);
}

/** Every element of the card that names a frame (drawings, panels, navigation, controls). */
export async function renderedFrameIds(page: Page): Promise<{ where: string; frameId: string }[]> {
  return page.evaluate(() => {
    const root = document.querySelector('[data-fx-card] [data-explorable-models-activity]')?.shadowRoot;
    return [...(root?.querySelectorAll<HTMLElement | SVGElement>('[data-ema-frame-id]') ?? [])].map(element => ({
      where: element.getAttribute('data-ema-view-id') ?? element.getAttribute('data-ema-panel') ?? element.getAttribute('aria-label') ?? element.className.toString(),
      frameId: element.getAttribute('data-ema-frame-id') ?? '',
    }));
  });
}

/** Normalizes learner numerals (U+2212 minus) for numeric comparison. */
export const numeral = (text: string): number => Number(text.replace(/−/g, '-').replace(/[^0-9eE.+-]/g, ''));

/** Width/overflow facts of the card and the page. */
export async function overflow(page: Page): Promise<{ page: boolean; card: boolean; offenders: string[]; cardWidth: number }> {
  return page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('[data-fx-card] [data-explorable-models-activity]');
    const root = host?.shadowRoot?.querySelector<HTMLElement>('.ema');
    const limit = root ? root.getBoundingClientRect().right + 1 : window.innerWidth;
    const offenders = root ? [...root.querySelectorAll<HTMLElement>('*')].filter(element => {
      if (element.closest('.ema-sr, .ema-table-region, .ema-math')) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.right > limit;
    }).slice(0, 8).map(element => `${element.tagName.toLowerCase()}.${element.className.toString().split(' ')[0]}`) : [];
    return { page: document.documentElement.scrollWidth > window.innerWidth + 1, card: !!root && root.scrollWidth > root.clientWidth + 1, offenders, cardWidth: root?.getBoundingClientRect().width ?? 0 };
  });
}

/** PNG width/height from the IHDR chunk. */
export function pngSize(base64: string): { width: number; height: number; signature: boolean } {
  const bytes = Buffer.from(base64, 'base64');
  const signature = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), signature };
}

/** `data`: the focused element's `data-fx-*` attributes (the fixture host's step, transition, action and reveal buttons). */
export interface FocusInfo { tag: string; type: string | null; name: string; step: string | null; id: string; inCard: boolean; data: Record<string, string> }
/** The focused element, looking through shadow roots, with its accessible-ish name. */
export async function focused(page: Page): Promise<FocusInfo | null> {
  return page.evaluate(() => {
    let element = document.activeElement as Element | null;
    let inCard = false;
    while (element?.shadowRoot?.activeElement) { inCard ||= element.hasAttribute('data-explorable-models-activity'); element = element.shadowRoot.activeElement; }
    if (!element || element === document.body) return null;
    const root = element.getRootNode() as Document | ShadowRoot;
    const byIds = (ids: string | null) => (ids ?? '').split(/\s+/).filter(Boolean).map(id => root.getElementById(id)?.textContent ?? '').join(' ').trim();
    const labelFor = element.id ? root.querySelector(`label[for="${element.id}"]`)?.textContent ?? '' : '';
    const name = element.getAttribute('aria-label') ?? (byIds(element.getAttribute('aria-labelledby')) || labelFor || (element as HTMLElement).innerText || element.textContent || '');
    const data = Object.fromEntries([...element.attributes].filter(attribute => attribute.name.startsWith('data-fx-')).map(attribute => [attribute.name, attribute.value]));
    return { tag: element.tagName.toLowerCase(), type: element.getAttribute('type'), name: name.replace(/\s+/g, ' ').trim(), step: element.getAttribute('data-fx-step'), id: element.id, inCard, data };
  });
}
/**
 * The key that moves keyboard focus to the next (with `backwards`, the previous) control of the page. WebKit on macOS
 * follows Safari's default keyboard model: Tab moves only between text fields, pop-up menus and elements with an
 * explicit tabindex, and Option-Tab reaches every control (buttons and sliders included). Keyboard-only runs in that
 * engine therefore press Option-Tab, the key a Safari keyboard user presses without changing preferences; Chromium,
 * Firefox and WebKit on other platforms use Tab.
 */
export function focusKey(page: Page, backwards = false): string {
  const optionTab = process.platform === 'darwin' && page.context().browser()?.browserType().name() === 'webkit';
  return `${optionTab ? 'Alt+' : ''}${backwards ? 'Shift+' : ''}Tab`;
}
/** Presses the focus key once; false when focus did not move. */
export async function moveFocus(page: Page, backwards = false): Promise<boolean> {
  type Marked = { ekFocusMark?: Element | null };
  await page.evaluate(() => {
    let element = document.activeElement as Element | null;
    while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
    (window as unknown as Marked).ekFocusMark = element;
  });
  await page.keyboard.press(focusKey(page, backwards));
  return page.evaluate(() => {
    let element = document.activeElement as Element | null;
    while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
    return (window as unknown as Marked).ekFocusMark !== element;
  });
}
/**
 * Moves keyboard focus with the focus key until `match` holds for the focused element. Keyboard only. Chromium and
 * WebKit move focus past the last control into the browser's own controls and from there back to the first one;
 * Firefox's automation keeps focus on the last control, so when the key no longer moves focus the search continues in
 * the other direction (Shift with the focus key, as a keyboard user would).
 */
export async function tabTo(page: Page, match: (info: FocusInfo) => boolean, what: string, options: { max?: number; backwards?: boolean } = {}): Promise<FocusInfo> {
  let backwards = options.backwards ?? false;
  for (let index = 0; index < (options.max ?? 160); index++) {
    const info = await focused(page);
    if (info && match(info)) return info;
    if (!await moveFocus(page, backwards)) backwards = !backwards;
  }
  throw new Error(`Keyboard focus never reached ${what}.`);
}
/** Arrow keys inside a roving toolbar until `match` holds. */
export async function arrowTo(page: Page, match: (info: FocusInfo) => boolean, what: string, key: 'ArrowRight' | 'ArrowLeft' = 'ArrowRight'): Promise<void> {
  for (let index = 0; index < 12; index++) {
    const info = await focused(page);
    if (info && match(info)) return;
    await page.keyboard.press(key);
  }
  throw new Error(`Arrow keys never reached ${what}.`);
}
