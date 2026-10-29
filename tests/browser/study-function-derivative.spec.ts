/**
 * Function and derivative activity in a real browser (report §5.3, §10, §11, §12.1, §19; A21, A28, A32–A36, A50). It
 * drives the generic flow of `study-harness.html?template=function-derivative`: the fixture host (sessionStorage
 * tables, receipts), the real catalogue kernel module worker, the activity adapter and the learner card in its shadow
 * root, and it mounts a second card through `createStudyHarnessVisualizer`.
 *
 * Evidence scope: Playwright Chromium (`npm run test:browser`), Firefox and WebKit (`npm run test:cross-browser`) with the
 * integration-fixture host. These are fixture-host results; they say
 * nothing about the Study Harness host, a packaged WebView, assistive-technology use or learning benefit. The titles of
 * the alternative-equivalence tests contain the `verifiedBy` IDs of the template.
 */
import { writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { LearnerProjection } from '@explorable-models/activity';
import { arrowTo, card, control, expectAccessible, focusKey, openFixture, overflow, pngSize, projection, respond, settle, tabTo } from './support/study-harness';
import {
  countPointer, drawnView, drive, exact, expectAbsent, expectPresent, inCard, num, pressHost, respondByKeyboard, rowText, scenario, shot, SHOTS_2D, valueOf,
} from '../player-activity/support/study-2d-browser';

const TEMPLATE = '?template=function-derivative';
/** Learner-facing content of each solution-bearing group (labels that appear nowhere else in the card). */
const HIDDEN = {
  tangent: ['Tangent line at P'],
  slope: ['Derivative at the probe', 'Direction of the graph at the probe'],
  'slope-equations': ['Slope of the tangent (analytical derivative)'],
  secant: ['Secant line through P and Q', 'Second point Q = (p + h, f(p + h))'],
  'secant-values': ['Second point position', 'Function value at the second point', 'Secant slope minus derivative'],
  'secant-equations': ['m_sec'],
  'derivative-plot': ['Graph of the derivative f′', 'Derivative at the probe (p, f′(p))'],
  shape: ['Shape of the graph', 'Vertex position'],
  'derivative-rule': ['Secant slope for h ≠ 0', '2A·x + B'],
} as const;
type Group = keyof typeof HIDDEN;
const SLOPE_GROUPS: Group[] = ['tangent', 'slope', 'slope-equations', 'secant', 'secant-values', 'secant-equations'];
const DERIVATIVE_GROUPS: Group[] = ['derivative-plot', 'shape', 'derivative-rule'];
const markers = (groups: readonly Group[]) => groups.flatMap(group => [...HIDDEN[group]]);
const QUANTITIES: Record<Group, string[]> = {
  tangent: [], slope: ['derivative', 'slope.sign'], 'slope-equations': [], secant: [], 'secant-values': ['second.x', 'second.value', 'secant.slope', 'secant.difference'],
  'secant-equations': [], 'derivative-plot': [], shape: ['curvature', 'vertex.x'], 'derivative-rule': [],
};
const quantities = (groups: readonly Group[]) => groups.flatMap(group => QUANTITIES[group]);

const mark = (projected: LearnerProjection, id: string) => projected.views.flatMap(view => view.marks).find(item => item.markId === id);
/** Endpoints of the single segment of a segments2 mark. */
const segment = (projected: LearnerProjection, id: string): { from: number[]; to: number[] } | null => {
  const geometry = mark(projected, id)?.geometry;
  return geometry?.kind === 'segments2' && geometry.segments[0] ? { from: [...geometry.segments[0].from], to: [...geometry.segments[0].to] } : null;
};
const slopeOf = (line: { from: number[]; to: number[] }) => (line.to[1]! - line.from[1]!) / (line.to[0]! - line.from[0]!);
const scenarioLabel = async (page: Page, id: string): Promise<string> =>
  page.evaluate(key => (window.studyHarnessFixture as unknown as { template: { scenarios: { id: string; label: string }[] } }).template.scenarios.find(item => item.id === key)!.label, id);
const controlValue = async (page: Page, parameter: string) => (await projection(page)).controls.find(item => item.parameter === parameter)!.value;

test.describe('function and derivative activity (generic fixture host)', () => {
  test('§6.1 flow with disclosure: every slope and the derivative stay absent from DOM, accessibility tree, read-out and captures until revealed (A21 A22 A28)', async ({ page }) => {
    test.setTimeout(150_000);
    const errors = await openFixture(page, TEMPLATE);
    expect((await projection(page)).stage.id).toBe('prepare');
    const all = [...SLOPE_GROUPS, ...DERIVATIVE_GROUPS];
    await expectAbsent(page, markers(all), 'prepare', { quantities: quantities(all) });
    expect(await card(page).locator('table').count()).toBe(0);
    await expectAccessible(page, 'prepare');
    await shot(page, 'fd-prepare');

    await drive(page, 'transition', 'predict');
    await expect(card(page).locator('[data-fx-composer="prediction"]')).toBeVisible();
    await expectAbsent(page, markers(all), 'predict', { quantities: quantities(all) });
    // The prediction is written in the host's composer inside the card's response slot; the card itself has no field.
    await respond(page, 'Falling at P, about as steep as the curve on the left; the slope grows as P moves right.');
    await expect(card(page).locator('[data-fx-response-recorded="prediction"]')).toBeVisible();

    // Held policy: entering the exploration stage does not reveal; each solution-bearing group needs a host reveal.
    await drive(page, 'transition', 'explore-slope');
    await expectAbsent(page, markers(all), 'explore-slope before reveal', { quantities: quantities(all) });
    for (const group of SLOPE_GROUPS) {
      await drive(page, 'reveal', group);
      await expectPresent(page, HIDDEN[group].filter(text => text !== 'm_sec'), `after revealing ${group}`);
    }
    expect((await projection(page)).views.flatMap(view => view.equations).map(equation => equation.equationId)).toEqual(expect.arrayContaining(['slope-at-probe', 'secant-quotient', 'secant-gap']));
    await expectAbsent(page, markers(DERIVATIVE_GROUPS), 'explore-slope after slope reveals', { quantities: quantities(DERIVATIVE_GROUPS) });
    // Every reveal is persisted by the host before display and acknowledged as displayed.
    const exposures = await page.evaluate(() => (window.studyHarnessFixture as unknown as { exposures(): { scope: string; displayStatus: string; groups: { groupId: string }[] }[] }).exposures());
    for (const group of SLOPE_GROUPS) expect(exposures.find(record => record.scope === 'reveal' && record.groups.some(item => item.groupId === group))?.displayStatus, group).toBe('displayed');
    await shot(page, 'fd-explore-slope');

    await drive(page, 'transition', 'explore-derivative');
    await expectAbsent(page, markers(DERIVATIVE_GROUPS), 'explore-derivative before reveal', { quantities: quantities(DERIVATIVE_GROUPS) });
    for (const group of DERIVATIVE_GROUPS) await drive(page, 'reveal', group);
    await expectPresent(page, ['Graph of the derivative f′', 'Shape of the graph', 'Vertex position', 'Secant slope for h ≠ 0'], 'explore-derivative after reveal');
    await expect(card(page).locator('figure[data-ema-figure="derivative-plot"]')).toBeVisible();
    await expectAccessible(page, 'explore-derivative');
    await shot(page, 'fd-explore-derivative');

    await drive(page, 'transition', 'explain');
    await respond(page, 'The tangent slope increases along the curve; secant slopes approach it as h shrinks.');
    await drive(page, 'close');
    await expect(page.locator('[data-fx-no-card]')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('A28 cases through the rendered projection: linear, constant, zero slope, sign change, coincident secant h = 0, offsets and domain boundaries', async ({ page }) => {
    test.setTimeout(150_000);
    const errors = await openFixture(page, `${TEMPLATE}&mode=free`);
    expect((await projection(page)).stage.id).toBe('free-explore');

    // Linear: constant nonzero slope; the secant equals the tangent; no vertex (inline reason, no undefined banner).
    await scenario(page, await scenarioLabel(page, 'sloped-line'));
    let shown = await projection(page);
    expect(await rowText(page, 'derivative')).toBe('1.5');
    expect(await rowText(page, 'slope.sign')).toBe('increasing');
    expect(await rowText(page, 'secant.slope')).toBe('1.5');
    expect(await rowText(page, 'secant.difference')).toBe('0');
    expect(await rowText(page, 'curvature')).toBe('linear');
    expect(await rowText(page, 'vertex.x')).toMatch(/^Undefined With A = 0 the graph is a straight line with nonzero slope, which has no vertex\.$/);
    expect(slopeOf(segment(shown, 'tangent-line')!)).toBeCloseTo(1.5, 12);
    expect(slopeOf(segment(shown, 'secant-line')!)).toBeCloseTo(1.5, 12);
    expect(shown.status.ui).not.toBe('undefined');
    await expect(card(page).locator('.ema-banner[data-ui-state="undefined"]')).toHaveCount(0);

    // Constant: slope 0 everywhere, stationary, no vertex.
    await scenario(page, await scenarioLabel(page, 'level-line'));
    shown = await projection(page);
    expect(await rowText(page, 'derivative')).toBe('0');
    expect(await rowText(page, 'slope.sign')).toBe('stationary');
    expect(await rowText(page, 'curvature')).toBe('constant');
    expect(await rowText(page, 'vertex.x')).toMatch(/^Undefined/);
    expect(slopeOf(segment(shown, 'tangent-line')!)).toBe(0);

    // Positive curvature: slope sign changes across the vertex x = 1; zero slope exactly at the vertex.
    await scenario(page, await scenarioLabel(page, 'curve-up'));
    expect(await rowText(page, 'curvature')).toBe('positive curvature');
    expect(await rowText(page, 'vertex.x')).toBe('1');
    await exact(page, 'p', '0.5');
    expect(await rowText(page, 'derivative')).toBe('−0.5');
    expect(await rowText(page, 'slope.sign')).toBe('decreasing');
    await exact(page, 'p', '1');
    expect(await rowText(page, 'derivative')).toBe('0');
    expect(await rowText(page, 'slope.sign')).toBe('stationary');
    expect(slopeOf(segment(await projection(page), 'tangent-line')!)).toBe(0);
    await exact(page, 'p', '1.5');
    expect(await rowText(page, 'derivative')).toBe('0.5');
    expect(await rowText(page, 'slope.sign')).toBe('increasing');
    await scenario(page, await scenarioLabel(page, 'curve-down'));
    expect(await rowText(page, 'curvature')).toBe('negative curvature');

    // Secant offsets for one probe: the gap m_sec − f′(p) is exactly A·h.
    for (const [id, gap] of [['offset-1', '0.5'], ['offset-0.1', '0.05'], ['offset-0.01', '0.005']] as const) {
      await scenario(page, await scenarioLabel(page, id));
      expect(await rowText(page, 'secant.difference'), id).toBe(gap);
      expect(await rowText(page, 'derivative'), id).toBe('1');
    }

    // Coincident secant (h = 0): undefined with its reason, never the derivative; nothing drawn for it; P and Q share one label.
    await exact(page, 'h', '0');
    shown = await projection(page);
    expect(await rowText(page, 'secant.slope')).toMatch(/^Undefined The secant needs two distinct points\./);
    expect(await rowText(page, 'secant.difference')).toMatch(/^Undefined/);
    expect(await rowText(page, 'derivative')).toBe('1');
    expect(valueOf(shown, 'secant.slope')).not.toHaveProperty('value');
    expect(segment(shown, 'secant-line')).toBeNull();
    const plot = await drawnView(page, 'function-plot');
    expect(plot.labels).toContain('P, Q');
    expect(plot.labels).not.toContain('Q');
    expect(shown.views.flatMap(view => view.equations).find(equation => equation.equationId === 'secant-quotient')!.plain).toContain('Undefined: The secant needs two distinct points');
    expect(shown.status.ui).not.toBe('undefined');
    await shot(page, 'fd-coincident-secant');

    // Domain boundaries: Q exactly at x = 5 is allowed; beyond it the coupled constraint refuses the entry unchanged. p and
    // h are both controls here, so the refusal carries the model's own learner-safe constraint text (G27).
    await exact(page, 'p', '5');
    expect(await rowText(page, 'probe.x')).toBe('5');
    expect(await rowText(page, 'second.x')).toBe('5');
    const run = (await projection(page)).guards.expectedRunId;
    const refused = await exact(page, 'h', '0.25', { expectError: true });
    expect(refused).toContain('The second point Q is at x = p + h, which must stay inside the plotted domain from −5 to 5.');
    expect(await control(page, 'h').getByRole('textbox').inputValue()).toBe('0.25');
    expect(await controlValue(page, 'h')).toBe(0);
    expect((await projection(page)).guards.expectedRunId).toBe(run);
    await exact(page, 'h', '-0.25');
    expect(await rowText(page, 'second.x')).toBe('4.75');
    await exact(page, 'p', '-4.75');
    expect(await rowText(page, 'second.x')).toBe('−5');
    expect(await exact(page, 'p', '-5', { expectError: true })).toContain('The second point Q is at x = p + h, which must stay inside the plotted domain from −5 to 5.');
    await shot(page, 'fd-domain-boundary');
    expect(errors).toEqual([]);
  });

  test('alternative exact-entry: values commit exactly, invalid entries are explained and kept as typed, and p + h outside −5…5 is refused identically for exact entry, keyboard preview and a scenario request', async ({ page }) => {
    test.setTimeout(120_000);
    const errors = await openFixture(page, `${TEMPLATE}&mode=free`);
    await exact(page, 'A', '0.5');
    await exact(page, 'h', '0.5');
    await exact(page, 'p', '4.5');
    const run = (await projection(page)).guards.expectedRunId;

    // Not a number and out of range: explained, kept as typed, never sent.
    expect(await exact(page, 'h', 'abc', { expectError: true })).toBe('!“abc” is not a number. Use digits, an optional minus sign and a decimal point.');
    expect(await control(page, 'h').getByRole('textbox').inputValue()).toBe('abc');
    expect(await exact(page, 'h', '7', { expectError: true })).toBe('!Enter a value from −2 to 2. Values outside this range are not changed into a different experiment.');
    expect(await control(page, 'h').getByRole('textbox').inputValue()).toBe('7');
    await expect(control(page, 'h').getByRole('textbox')).toHaveAttribute('aria-invalid', 'true');
    expect((await projection(page)).guards.expectedRunId).toBe(run);

    // Coupled constraint by exact entry: in range for h, but p + h = 5.5.
    const diagnostics = () => page.evaluate(() => (window.studyHarnessFixture as unknown as { diagnostics: { source: string; code: string; message: string }[] }).diagnostics
      .filter(item => item.source === 'binding').map(item => `${item.code}|${item.message}`));
    const before = (await diagnostics()).length;
    const exactMessage = await exact(page, 'h', '1', { expectError: true });
    expect(exactMessage).toBe('!The second point Q is at x = p + h, which must stay inside the plotted domain from −5 to 5.');
    expect(await control(page, 'h').getByRole('textbox').inputValue()).toBe('1');
    expect(await controlValue(page, 'h')).toBe(0.5);
    const exactDiagnostics = (await diagnostics()).slice(before);

    // Coupled constraint by keyboard preview (exploration is authorized in free mode): the preview update is refused.
    const slider = control(page, 'h').getByRole('slider');
    await slider.focus();
    const mid = (await diagnostics()).length;
    await page.keyboard.press('ArrowRight');
    await expect(control(page, 'h').locator('.ema-error')).toHaveText('!The second point Q is at x = p + h, which must stay inside the plotted domain from −5 to 5.');
    await settle(page);
    expect(await controlValue(page, 'h')).toBe(0.5);
    expect((await projection(page)).guards.expectedRunId).toBe(run);
    expect((await projection(page)).preview).toBeNull();
    const keyboardDiagnostics = (await diagnostics()).slice(mid);

    // Coupled constraint in a scenario request: the same check refuses a scenario whose override puts Q outside.
    const scenarioCodes = await page.evaluate(async () => {
      const fixture = window.studyHarnessFixture as unknown as { state(): { instance: import('@explorable-models/activity').ActivityInstance }; adapter: import('@explorable-models/activity').StudyHarnessAdapter };
      const state = fixture.state();
      const instance = state.instance;
      const report = await fixture.adapter.validate({
        activityId: instance.activityId, objectiveIds: instance.objectiveIds, hostSessionId: instance.hostSessionId, hostSessionRevision: instance.hostSessionRevision,
        template: { templateId: instance.template.templateId, version: instance.template.version }, mode: instance.mode, scenarioId: 'offset-1', parameters: { p: 4.5 },
      });
      return report.diagnostics.map(item => item.code);
    });
    expect(exactDiagnostics.map(item => item.split('|')[0])).toEqual(['CONSTRAINT_VIOLATION']);
    expect(keyboardDiagnostics.map(item => item.split('|')[0])).toEqual(['CONSTRAINT_VIOLATION']);
    expect(keyboardDiagnostics).toEqual(exactDiagnostics);
    expect(scenarioCodes).toEqual(['CONSTRAINT_VIOLATION']);

    // A valid exact value commits exactly one new run with the typed value.
    await exact(page, 'h', '0.5');
    await exact(page, 'h', '0.01');
    expect(await rowText(page, 'second.x')).toBe('4.51');
    expect(await rowText(page, 'secant.difference')).toBe('0.005');
    expect(errors).toEqual([]);
  });

  test('alternative keyboard-only: the whole derivative flow completes without a pointer, including keyboard preview, exact entry, scenarios and tables (A36)', async ({ page }) => {
    test.setTimeout(150_000);
    const errors = await openFixture(page, `${TEMPLATE}&policy=full`);
    const pointer = await countPointer(page);
    await page.keyboard.press(focusKey(page));
    await pressHost(page, 'data-fx-transition', 'predict');
    await respondByKeyboard(page, 'The curve falls at P.');
    await pressHost(page, 'data-fx-transition', 'explore-slope');
    await pressHost(page, 'data-fx-action', 'authorize-exploration');
    expect((await projection(page)).views.map(view => view.viewId)).toContain('function-plot');
    await expect(card(page).getByText('Tangent line at P').first()).toBeAttached();

    // Probe by keyboard: one arrow press is one keyboard preview committed on key up.
    await tabTo(page, inCard('Probe position p', 'input'), 'the probe slider', { backwards: true });
    const p = await controlValue(page, 'p');
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => controlValue(page, 'p')).toBe(p + 0.25);
    await settle(page);
    // Exact offset by keyboard.
    await tabTo(page, inCard('Exact value for Offset h'), 'the exact offset field');
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('0.1');
    await page.keyboard.press('Enter');
    await expect.poll(() => controlValue(page, 'h')).toBe(0.1);
    await settle(page);
    // A scenario from the roving scenario toolbar.
    const label = await scenarioLabel(page, 'curve-down');
    await tabTo(page, info => info.inCard && info.tag === 'button' && /^f\(x\) = /.test(info.name), 'the scenario toolbar');
    await arrowTo(page, inCard(label, 'button'), label);
    const before = (await projection(page)).guards.expectedRunId;
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await projection(page)).guards.expectedRunId).not.toBe(before);
    await settle(page);
    expect(await controlValue(page, 'A')).toBe(-0.5);
    // The table alternative is reachable and scrollable by keyboard.
    await tabTo(page, inCard('Table of f(x)', 'button'), 'the table toggle', { backwards: true });
    await page.keyboard.press('Space');
    await tabTo(page, info => info.inCard && info.tag === 'div' && info.name === 'Table of f(x)', 'the table region');
    await expect(card(page).getByRole('table').first()).toBeVisible();

    await pressHost(page, 'data-fx-transition', 'explore-derivative');
    await expect(card(page).locator('figure[data-ema-figure="derivative-plot"]')).toBeVisible();
    await pressHost(page, 'data-fx-transition', 'explain');
    await respondByKeyboard(page, 'The derivative graph records the tangent slope at every x.');
    await pressHost(page, 'data-fx-action', 'close');
    await expect(page.locator('[data-fx-no-card]')).toBeVisible();
    expect(await pointer()).toBe(0);
    expect(errors).toEqual([]);
  });

  test('alternative curve-table-equivalent: the table of f(x) lists graph samples across the whole domain, each equal to the rule with the coefficients shown', async ({ page }) => {
    const errors = await openFixture(page, `${TEMPLATE}&mode=free`);
    await scenario(page, await scenarioLabel(page, 'curve-up'));
    const toggle = card(page).getByRole('button', { name: 'Table of f(x)' });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    const table = card(page).locator('[data-ema-panel="table"]').filter({ hasText: 'Table of f(x)' });
    await expect(table.locator('thead th')).toHaveText(['x', 'f(x)']);
    await expect(table.locator('.ema-panel-note')).toHaveText('Showing 135 of 401 rows: every 3rd sample and the last one, so the whole range is covered.');
    const rows = await table.locator('tbody tr').evaluateAll(items => items.map(row => [...row.children].map(cell => cell.textContent ?? '')));
    const shown = await projection(page);
    const curve = mark(shown, 'function-curve')!.geometry as { kind: 'polyline2'; segments: { points: number[][] }[] };
    const points = curve.segments.flatMap(item => item.points);
    expect(points).toHaveLength(401);
    expect(rows).toHaveLength(135);
    const [A, B, C] = ['A', 'B', 'C'].map(id => shown.controls.find(item => item.parameter === id)!.value) as [number, number, number];
    rows.forEach((cells, index) => {
      const sample = points[Math.min(points.length - 1, index * 3)]!;
      expect(num(cells[0]!), `row ${index} x`).toBeCloseTo(sample[0]!, 4);
      expect(num(cells[1]!), `row ${index} f`).toBeCloseTo(sample[1]!, 4);
      expect(num(cells[1]!), `row ${index} rule`).toBeCloseTo(A * sample[0]! ** 2 + B * sample[0]! + C, 4);
    });
    expect(num(rows[0]![0]!)).toBe(-5);
    expect(num(rows.at(-1)![0]!)).toBe(5);
    await shot(page, 'fd-curve-table');
    expect(errors).toEqual([]);
  });

  test('alternative derivative-table-equivalent: the table of f′(x) lists derivative samples across the domain, equal to 2A·x + B, with f′(p) in the values panel', async ({ page }) => {
    const errors = await openFixture(page, `${TEMPLATE}&mode=free`);
    await scenario(page, await scenarioLabel(page, 'curve-down'));
    await card(page).getByRole('button', { name: 'Table of f(x)' }).click();
    const table = card(page).locator('[data-ema-panel="table"]').filter({ hasText: 'Table of f′(x)' });
    await expect(table.locator('thead th')).toHaveText(['x', 'f′(x)']);
    const rows = await table.locator('tbody tr').evaluateAll(items => items.map(row => [...row.children].map(cell => cell.textContent ?? '')));
    const shown = await projection(page);
    const [A, B, p] = ['A', 'B', 'p'].map(id => shown.controls.find(item => item.parameter === id)!.value) as [number, number, number];
    const curve = (mark(shown, 'derivative-curve-line')!.geometry as { segments: { points: number[][] }[] }).segments.flatMap(item => item.points);
    expect(rows).toHaveLength(135);
    rows.forEach((cells, index) => {
      const x = num(cells[0]!);
      expect(x).toBeCloseTo(curve[Math.min(400, index * 3)]![0]!, 4);
      expect(num(cells[1]!), `row ${index}`).toBeCloseTo(2 * A * x + B, 4);
    });
    expect(num((await rowText(page, 'derivative'))!)).toBeCloseTo(2 * A * p + B, 10);
    const probe = mark(shown, 'derivative-probe-marker')!.at!;
    expect(probe[0]).toBe(p);
    expect(probe[1]).toBeCloseTo(2 * A * p + B, 12);
    expect(errors).toEqual([]);
  });

  test('alternative point-values-equivalent: P, Q, f′(p) and the secant slope in the values panel determine the drawn tangent and secant lines', async ({ page }) => {
    const errors = await openFixture(page, `${TEMPLATE}&mode=free`);
    await scenario(page, await scenarioLabel(page, 'offset-0.1'));
    const shown = await projection(page);
    const [px, py, slope, qx, qy, secant] = await Promise.all(['probe.x', 'probe.value', 'derivative', 'second.x', 'second.value', 'secant.slope'].map(async id => num((await rowText(page, id))!)));
    const tangent = segment(shown, 'tangent-line')!, line = segment(shown, 'secant-line')!;
    for (const end of [tangent.from, tangent.to]) expect(end[1]!).toBeCloseTo(py! + slope! * (end[0]! - px!), 3);
    for (const end of [line.from, line.to]) expect(end[1]!).toBeCloseTo(py! + secant! * (end[0]! - px!), 3);
    expect(qy!).toBeCloseTo(py! + secant! * (qx! - px!), 3);
    expect(mark(shown, 'probe-marker')!.at).toEqual([px, expect.closeTo(py!, 3)]);
    // The drawing shows both lines and both points with their labels.
    const plot = await drawnView(page, 'function-plot');
    expect(plot.labels).toEqual(expect.arrayContaining(['P', 'Q']));
    await expect(card(page).locator('figure[data-ema-figure="function-plot"] .ema-marks path.ema-role-accent.ema-stroke')).toHaveCount(1);
    await expect(card(page).locator('figure[data-ema-figure="function-plot"] .ema-marks path.ema-role-secondary.ema-stroke')).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test('alternative text-description: generated summaries name only visible content and visible values', async ({ page, context }) => {
    const errors = await openFixture(page, TEMPLATE);
    await card(page).getByRole('button', { name: 'Text description' }).click();
    const description = card(page).locator('figure[data-ema-figure="function-plot"] .ema-description');
    await expect(description).toBeVisible();
    await expect(description).toContainText('Graph of f. Shows Graph of f; Probe point P = (p, f(p)).');
    for (const marker of markers([...SLOPE_GROUPS, ...DERIVATIVE_GROUPS])) await expect(description).not.toContainText(marker);
    // A separate tab (its own fixture session) with everything authorized lists the revealed marks too.
    const free = await context.newPage();
    const freeErrors = await openFixture(free, `${TEMPLATE}&mode=free`);
    await card(free).getByRole('button', { name: 'Text description' }).click();
    await expect(card(free).locator('figure[data-ema-figure="function-plot"] .ema-description')).toContainText('Tangent line at P; Secant line through P and Q');
    await expect(card(free).locator('figure[data-ema-figure="derivative-plot"] .ema-description')).toContainText('Graph of the derivative f′');
    expect([...errors, ...freeErrors]).toEqual([]);
  });

  test('capture: SVG and PNG of this exact surface with identities, hidden groups excluded before reveal (A50)', async ({ page }) => {
    const errors = await openFixture(page, TEMPLATE);
    const surfaceId = await page.evaluate(() => window.studyHarnessFixture.surface!.surfaceId);
    const prepare = await projection(page);
    const svg = await page.evaluate(() => window.studyHarnessFixture.capture('svg', 'function-plot'));
    expect(svg.metadata).toMatchObject({ surfaceId, viewId: 'function-plot', projectionId: prepare.projectionId, frameId: prepare.frame!.frameId });
    expect(svg.svg!.startsWith('<svg')).toBe(true);
    expect(svg.svg).not.toContain('foreignObject');
    for (const marker of markers([...SLOPE_GROUPS, ...DERIVATIVE_GROUPS])) expect(`${svg.svg}${svg.companionText}`).not.toContain(marker);
    await drive(page, 'transition', 'predict');
    await respond(page, 'Falling.');
    await drive(page, 'transition', 'explore-slope');
    for (const group of SLOPE_GROUPS) await drive(page, 'reveal', group);
    const png = await page.evaluate(() => window.studyHarnessFixture.capture('png', 'function-plot'));
    const now = await projection(page);
    expect(png.metadata).toMatchObject({ surfaceId, viewId: 'function-plot', frameId: now.frame!.frameId, activityRevision: now.activityRevision });
    expect(pngSize(png.pngBase64!)).toEqual({ width: png.width, height: png.height, signature: true });
    expect(png.companionText).toContain('Tangent line at P');
    writeFileSync(`${SHOTS_2D}/fd-capture-function-plot.png`, Buffer.from(png.pngBase64!, 'base64'));
    const shownSvg = await page.evaluate(() => window.studyHarnessFixture.capture('svg', 'function-plot'));
    writeFileSync(`${SHOTS_2D}/fd-capture-function-plot.svg`, shownSvg.svg!);
    expect(errors).toEqual([]);
  });

  test('createStudyHarnessVisualizer mounts a real surface with readiness, error hook, capture and idempotent disposal that stops its workers (§5.3)', async ({ page }) => {
    test.setTimeout(90_000);
    const errors = await openFixture(page, TEMPLATE);
    const result = await page.evaluate(async () => {
      const fixture = window.studyHarnessFixture as unknown as {
        host: { policy(id: string): unknown; setPolicy(id: string, policy: unknown): unknown };
        catalog: unknown; prepared: { activityId: string }; session: { workers: { created: number; terminated: number } };
      };
      const player = await import('/packages/player/src/activity/index.ts' as string) as typeof import('../../packages/player/src/activity/index');
      const workers = fixture.session.workers;
      const baseline = { created: workers.created, terminated: workers.terminated };
      const activityId = `act-visualizer-${Date.now()}`;
      const policy = fixture.host.policy(fixture.prepared.activityId) as Record<string, unknown>;
      fixture.host.setPolicy(activityId, { ...policy, policyId: 'policy-visualizer', revision: 1 });
      const container = document.createElement('div');
      container.dataset.visualizerTest = '';
      container.style.width = '640px';
      document.body.append(container);
      const visualizer = player.createStudyHarnessVisualizer({
        catalog: fixture.catalog as never, host: fixture.host as never, maxWorkers: 2,
        surfaceDefaults: { theme: 'light', fonts: 'system', headingLevel: 3 },
      });
      const capabilities = visualizer.getCapabilities().templates.map(entry => entry.template.templateId);
      const request = { activityId, objectiveIds: ['obj-visualizer'], hostSessionId: 'session-visualizer', hostSessionRevision: 0, template: { templateId: 'function-derivative', version: '1.0.0' }, mode: 'approved' as const };
      const validation = await visualizer.validate(request);
      const prepared = await visualizer.prepare(request, { operationId: `op-${activityId}` });
      if (!prepared.ok) return { failed: prepared.diagnostics.map(item => item.code) };
      const events: string[] = [];
      const surface = visualizer.mount(container, prepared.prepared, { onError: event => events.push(event.kind === 'state' ? `state:${event.state}` : `diagnostic:${event.diagnostic.code}`) });
      await surface.ready;
      const root = surface.element.shadowRoot!;
      const title = root.querySelector('.ema-title')?.textContent;
      const learner = visualizer.getState(activityId, 'learner');
      const capture = await surface.capture({ format: 'svg' });
      const summary = visualizer.summarizeInteraction(activityId, { audience: 'tutor' });
      const revoked = await prepared.prepared.host.revoke({ operationId: `revoke-${activityId}`, reason: 'Visualizer browser test.' });
      await new Promise(resolve => setTimeout(resolve, 100));
      const pending = surface.capture({ format: 'png' }).then(() => 'captured', (error: { code?: string }) => error.code);
      const created = workers.created - baseline.created;
      visualizer.dispose();
      visualizer.dispose();
      const late = await pending;
      await new Promise(resolve => setTimeout(resolve, 100));
      const afterDispose = visualizer.getState(activityId, 'learner');
      const prepareAfter = await visualizer.prepare({ ...request, activityId: `${activityId}-late` }, { operationId: `op-late-${activityId}` });
      return {
        capabilities, validation: validation.ok, title, learner: 'projection' in learner, captureSurface: capture.metadata.surfaceId === surface.surfaceId, summary: 'audience' in summary,
        revoked: revoked.ok, events, late, created, live: (workers.created - baseline.created) - (workers.terminated - baseline.terminated),
        removed: container.children.length === 0 && !surface.element.isConnected, disposed: surface.disposed && visualizer.disposed,
        afterDispose: 'diagnostics' in afterDispose ? afterDispose.diagnostics.map(item => item.code) : [], prepareAfter: prepareAfter.ok ? [] : prepareAfter.diagnostics.map(item => item.code),
      };
    });
    expect(result).toMatchObject({
      capabilities: ['function-derivative'], validation: true, title: 'Slope of a curve and its derivative', learner: true, captureSurface: true, summary: true,
      revoked: true, late: 'DISPOSED', live: 0, removed: true, disposed: true, afterDispose: ['DISPOSED'], prepareAfter: ['DISPOSED'],
    });
    expect((result as { created: number }).created).toBeGreaterThan(0);
    expect((result as { events: string[] }).events).toEqual([expect.stringMatching(/^state:(stale-policy|unsupported)$/)]);
    expect(errors).toEqual([]);
  });

  test('layout: container widths 320, 390, 640, 960, desktop, a mobile viewport, dark mode and 200% text stay usable without overflow (A32 A36)', async ({ context }) => {
    test.setTimeout(150_000);
    const configurations = [
      ...[320, 390, 640, 960].map(width => ({ name: `container-${width}`, query: `&width=${width}`, viewport: { width: 1440, height: 1000 }, width })),
      { name: 'desktop', query: '', viewport: { width: 1440, height: 1000 }, width: null },
      { name: 'mobile-390', query: '', viewport: { width: 390, height: 844 }, width: null },
      { name: 'dark', query: '&theme=dark', viewport: { width: 1440, height: 1000 }, width: null },
      { name: 'text-200', query: '&text=200', viewport: { width: 1440, height: 1000 }, width: null },
      { name: 'text-200-container-390', query: '&text=200&width=390', viewport: { width: 1440, height: 1000 }, width: 390 },
    ];
    for (const configuration of configurations) {
      const page = await context.newPage();
      await page.setViewportSize(configuration.viewport);
      const errors = await openFixture(page, `${TEMPLATE}&mode=free${configuration.query}`);
      await exact(page, 'h', '0.01');
      const facts = await overflow(page);
      expect(facts, configuration.name).toMatchObject({ page: false, card: false, offenders: [] });
      if (configuration.width) expect(Math.abs(facts.cardWidth - configuration.width), `card width ${configuration.width}`).toBeLessThanOrEqual(2);
      const cardBox = (await card(page).locator('.ema').first().boundingBox())!;
      for (const target of [control(page, 'p').getByRole('slider'), control(page, 'p').getByRole('textbox'), control(page, 'p').getByRole('button', { name: 'Apply' })]) {
        const box = (await target.boundingBox())!;
        expect(box.x + box.width, `${configuration.name}: right edge`).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1);
        expect(box.height, `${configuration.name}: target height`).toBeGreaterThanOrEqual(24);
      }
      if (configuration.name === 'dark') await expect(card(page).locator('.ema')).toHaveAttribute('data-theme', 'dark');
      if (configuration.name.startsWith('text-200')) expect(await card(page).locator('.ema-title').evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThan(30);
      expect(await rowText(page, 'secant.difference')).toBe('0.0025');
      if (['container-320', 'desktop', 'dark', 'text-200'].includes(configuration.name)) await expectAccessible(page, configuration.name);
      await shot(page, `fd-${configuration.name}`);
      expect(errors).toEqual([]);
      await page.close();
    }
  });
});
