/**
 * Matrices as transformations of the plane in a real browser (report §10, §11, §12.2, §19; A21, A29, A32–A36, A50). It
 * drives the generic flow of `study-harness.html?template=linear-transformation`: the fixture host (sessionStorage
 * tables, receipts), the real catalogue kernel module worker, the activity adapter and the learner card in its shadow
 * root.
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
  countPointer, drawnView, drive, exact, expectAbsent, expectPresent, inCard, num, pressHost, respondByKeyboard, rowText, scenario, shot, SHOTS_2D,
} from '../player-activity/support/study-2d-browser';

const TEMPLATE = '?template=linear-transformation';
/** Learner-facing content of each solution-bearing group (labels that appear nowhere else in the card). */
const HIDDEN = {
  transformed: ['Transformed grid lines', 'Image of the unit square (area |det M|)'],
  'image-vector': ['Image Mv of the test vector', 'Image of v'],
  determinant: ['Area scale', 'Orientation'],
  collapse: ['Collapse line direction'],
  'determinant-values': ['Determinant and area scale with current values'],
  eigen: ['Unchanged-direction category', 'Real eigenvalues', 'Unit unchanged direction u₁', 'First eigen-direction'],
  'eigen-lines': ['Lines through the origin that M maps onto themselves'],
  'eigen-values': ['Characteristic equation with current values'],
} as const;
type Group = keyof typeof HIDDEN;
const TRANSFORMED: Group[] = ['transformed', 'image-vector', 'determinant', 'collapse', 'determinant-values'];
const EIGEN: Group[] = ['eigen', 'eigen-lines', 'eigen-values'];
const markers = (groups: readonly Group[]) => groups.flatMap(group => [...HIDDEN[group]]);
const QUANTITIES: Record<Group, string[]> = {
  transformed: [], 'image-vector': ['image.v'], determinant: ['determinant', 'area.scale', 'orientation'], collapse: ['rank', 'image.direction'], 'determinant-values': [],
  eigen: ['eigen.category', 'eigen.values', 'eigen.direction1', 'eigen.direction2', 'trace', 'eigen.discriminant'], 'eigen-lines': [], 'eigen-values': [],
};
const quantities = (groups: readonly Group[]) => groups.flatMap(group => QUANTITIES[group]);

const mark = (projected: LearnerProjection, id: string) => projected.views.flatMap(view => view.marks).find(item => item.markId === id);
const scenarioLabel = async (page: Page, id: string): Promise<string> =>
  page.evaluate(key => (window.studyHarnessFixture as unknown as { template: { scenarios: { id: string; label: string }[] } }).template.scenarios.find(item => item.id === key)!.label, id);
const pair = (text: string | null): number[] => (text ?? '').replace(/[()]/g, '').split(',').map(part => num(part));
const controlValue = async (page: Page, parameter: string) => (await projection(page)).controls.find(item => item.parameter === parameter)!.value;

test.describe('matrices as transformations of the plane (generic fixture host)', () => {
  test('§6.1 flow with disclosure: transformed plane, determinant, collapse and unchanged directions stay absent from every learner channel until revealed (A21 A22 A29)', async ({ page }) => {
    test.setTimeout(150_000);
    const errors = await openFixture(page, TEMPLATE);
    expect((await projection(page)).stage.id).toBe('prepare');
    const all = [...TRANSFORMED, ...EIGEN];
    await expectAbsent(page, markers(all), 'prepare', { quantities: quantities(all) });
    // The column convention and the columns of M are not solution-bearing: they show the matrix entries as drawn arrows.
    expect(pair(await rowText(page, 'image.e1'))).toEqual([1.5, 0.5]);
    expect(pair(await rowText(page, 'image.e2'))).toEqual([1, 1]);
    await expectAccessible(page, 'prepare');
    await shot(page, 'lt-prepare');

    await drive(page, 'transition', 'predict');
    await expectAbsent(page, markers(all), 'predict', { quantities: quantities(all) });
    await respond(page, 'Orientation stays the same, nothing collapses, and two directions stay on their own lines.');

    await drive(page, 'transition', 'explore');
    await expectAbsent(page, markers(all), 'explore before reveal', { quantities: quantities(all) });
    for (const group of TRANSFORMED) await drive(page, 'reveal', group);
    await expectPresent(page, ['Transformed grid lines', 'Image Mv of the test vector', 'Area scale', 'Orientation', 'Collapse line direction', 'Determinant and area scale with current values'], 'explore after reveal');
    await expectAbsent(page, markers(EIGEN), 'explore after reveal', { quantities: quantities(EIGEN) });
    const exposures = await page.evaluate(() => (window.studyHarnessFixture as unknown as { exposures(): { scope: string; displayStatus: string; groups: { groupId: string }[] }[] }).exposures());
    for (const group of TRANSFORMED) expect(exposures.find(record => record.scope === 'reveal' && record.groups.some(item => item.groupId === group))?.displayStatus, group).toBe('displayed');
    await shot(page, 'lt-explore');

    await drive(page, 'transition', 'explore-eigen');
    await expectAbsent(page, markers(EIGEN), 'explore-eigen before reveal', { quantities: quantities(EIGEN) });
    for (const group of EIGEN) await drive(page, 'reveal', group);
    await expectPresent(page, ['Unchanged-direction category', 'Real eigenvalues', 'Lines through the origin that M maps onto themselves', 'Characteristic equation with current values'], 'explore-eigen after reveal');
    await expectAccessible(page, 'explore-eigen');
    await shot(page, 'lt-explore-eigen');

    await drive(page, 'transition', 'explain');
    await respond(page, 'The sign of the determinant gives orientation and its size the area factor.');
    await drive(page, 'close');
    await expect(page.locator('[data-fx-no-card]')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('A29 cases through the rendered projection: identity, nonaxis rotations, nonsymmetric shear, reflections (orientation reversed, area nonnegative), singular collapse, zero matrix and zero vector', async ({ page }) => {
    test.setTimeout(150_000);
    const errors = await openFixture(page, `${TEMPLATE}&mode=free`);
    expect((await projection(page)).stage.id).toBe('free-explore');
    const facts = async () => ({
      det: await rowText(page, 'determinant'), area: await rowText(page, 'area.scale'), orientation: await rowText(page, 'orientation'), rank: await rowText(page, 'rank'),
      e1: pair(await rowText(page, 'image.e1')), e2: pair(await rowText(page, 'image.e2')), mv: await rowText(page, 'image.v'), category: await rowText(page, 'eigen.category'),
    });

    await scenario(page, await scenarioLabel(page, 'identity'));
    expect(await facts()).toMatchObject({ det: '1', area: '1', orientation: 'preserved', rank: '2', e1: [1, 0], e2: [0, 1], mv: '(1, 1)', category: 'repeated scalar' });
    // Conditional readout: the collapse direction of a full-rank matrix is undefined inline with its reason.
    expect(await rowText(page, 'image.direction')).toMatch(/^Undefined M has rank 2/);

    await scenario(page, await scenarioLabel(page, 'rotation-30'));
    let shown = await projection(page);
    expect(await facts()).toMatchObject({ det: '1', area: '1', orientation: 'preserved', rank: '2', e1: [0.866, 0.5], e2: [-0.5, 0.866], category: 'complex' });
    expect(pair(shown.views.flatMap(view => view.values).find(value => value.quantityId === 'image.v')!.text)).toEqual([0.366, 1.366]);
    // No real unchanged direction: the arrows have nothing to draw and say so; the state names the undefined drawing.
    expect(await rowText(page, 'eigen.direction1')).toMatch(/^Undefined/);
    expect((await drawnView(page, 'plane')).notes.join(' ')).toContain('Unit unchanged direction u₁: undefined');
    expect(shown.status.ui).toBe('undefined');
    await shot(page, 'lt-rotation-30');

    await scenario(page, await scenarioLabel(page, 'rotation-120'));
    expect(await facts()).toMatchObject({ det: '1', orientation: 'preserved', e1: [-0.5, 0.866], e2: [-0.866, -0.5], category: 'complex' });

    await scenario(page, await scenarioLabel(page, 'shear'));
    expect(await facts()).toMatchObject({ det: '1', area: '1', orientation: 'preserved', rank: '2', e1: [1, 0], e2: [1.5, 1], mv: '(2.5, 1)', category: 'repeated defective' });

    for (const id of ['reflection-diagonal', 'reflection-x-axis']) {
      await scenario(page, await scenarioLabel(page, id));
      expect(await facts(), id).toMatchObject({ det: '−1', area: '1', orientation: 'reversed', rank: '2' });
      shown = await projection(page);
      const image = mark(shown, 'unit-square-image')!.geometry as { kind: 'polygon2'; vertices: number[][]; degenerate: boolean };
      expect(image.degenerate, id).toBe(false);
      // Reversed orientation: the image vertices 0, Me₁, Me₁ + Me₂, Me₂ run clockwise (negative signed area), the area is still 1.
      const signed = image.vertices.reduce((sum, vertex, index) => { const next = image.vertices[(index + 1) % image.vertices.length]!; return sum + vertex[0]! * next[1]! - next[0]! * vertex[1]!; }, 0) / 2;
      expect(signed, id).toBe(-1);
    }
    await shot(page, 'lt-reflection');

    await scenario(page, await scenarioLabel(page, 'collapse'));
    expect(await facts()).toMatchObject({ det: '0', area: '0', orientation: 'collapsed', rank: '1', e1: [0.5, 1], e2: [1, 2] });
    expect(pair(await rowText(page, 'image.direction'))).toEqual([0.4472, 0.8944]);
    let plane = await drawnView(page, 'plane');
    expect(plane.notes).toContain('Image of the unit square (area |det M|): degenerate polygon (no area), drawn as a line.');
    await shot(page, 'lt-collapse');

    await scenario(page, await scenarioLabel(page, 'zero-matrix'));
    expect(await facts()).toMatchObject({ det: '0', area: '0', orientation: 'collapsed', rank: '0', e1: [0, 0], e2: [0, 0], mv: '(0, 0)' });
    expect(await rowText(page, 'image.direction')).toMatch(/^Undefined/);
    plane = await drawnView(page, 'plane');
    expect(plane.notes).toEqual(expect.arrayContaining([
      'Image of the unit square (area |det M|): degenerate polygon (all vertices coincide), drawn as a point.',
      'Me₁, the first column of M: zero vector (no direction), drawn as a dot.', 'Image Mv of the test vector: zero vector (no direction), drawn as a dot.',
    ]));
    // Zero vectors are dots: no arrow (and so no arrowhead) for the columns or Mv.
    expect(plane.arrows.filter(arrow => arrow.role === 'ema-role-secondary')).toEqual([]);
    expect(plane.labels.some(label => label.includes('zero vector'))).toBe(true);
    await shot(page, 'lt-zero-matrix');

    await scenario(page, await scenarioLabel(page, 'zero-test-vector'));
    expect(await facts()).toMatchObject({ det: '2', area: '2', orientation: 'preserved', rank: '2', mv: '(0, 0)' });
    expect(pair(await rowText(page, 'vector.v'))).toEqual([0, 0]);
    plane = await drawnView(page, 'plane');
    expect(plane.labels).toContain('v, Mv (zero vector)');
    expect(plane.arrows.filter(arrow => arrow.role === 'ema-role-positive')).toEqual([]);
    expect(plane.arrows.filter(arrow => arrow.role === 'ema-role-secondary').every(arrow => arrow.head)).toBe(true);
    await shot(page, 'lt-zero-vector');
    expect(errors).toEqual([]);
  });

  test('alternative exact-entry: matrix and vector entries commit exactly; out-of-range and malformed entries are explained and kept as typed', async ({ page }) => {
    const errors = await openFixture(page, `${TEMPLATE}&mode=free`);
    const run = (await projection(page)).guards.expectedRunId;
    expect(await exact(page, 'm11', '3.5', { expectError: true })).toBe('!Enter a value from −3 to 3. Values outside this range are not changed into a different experiment.');
    expect(await control(page, 'm11').getByRole('textbox').inputValue()).toBe('3.5');
    expect(await exact(page, 'm11', '1..5', { expectError: true })).toBe('!“1..5” is not a number. Use digits, an optional minus sign and a decimal point.');
    expect((await projection(page)).guards.expectedRunId).toBe(run);
    expect(await controlValue(page, 'm11')).toBe(1.5);
    await exact(page, 'm11', '2');
    await exact(page, 'm12', '−1');
    await exact(page, 'vy', '-0.5');
    expect(pair(await rowText(page, 'image.e2'))).toEqual([-1, 1]);
    expect(await rowText(page, 'determinant')).toBe('2.5');
    expect(pair(await rowText(page, 'image.v'))).toEqual([2.5, 0]);
    // Keyboard preview and a scenario reach the same guarded commit path.
    await control(page, 'm22').getByRole('slider').focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => controlValue(page, 'm22')).toBeCloseTo(1.1, 12);
    await settle(page);
    await scenario(page, await scenarioLabel(page, 'shear'));
    expect(await controlValue(page, 'm12')).toBe(1.5);
    expect(errors).toEqual([]);
  });

  test('alternative keyboard-only: the whole matrix flow completes without a pointer (A36)', async ({ page }) => {
    test.setTimeout(150_000);
    const errors = await openFixture(page, `${TEMPLATE}&policy=full`);
    const pointer = await countPointer(page);
    await page.keyboard.press(focusKey(page));
    await pressHost(page, 'data-fx-transition', 'predict');
    await respondByKeyboard(page, 'Orientation is kept and nothing collapses.');
    await pressHost(page, 'data-fx-transition', 'explore');
    await pressHost(page, 'data-fx-action', 'authorize-exploration');
    await expect(card(page).getByText('Transformed grid lines').first()).toBeAttached();

    await tabTo(page, inCard('m₁₁ (row 1, column 1)', 'input'), 'the m11 slider', { backwards: true });
    const m11 = await controlValue(page, 'm11');
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => controlValue(page, 'm11')).toBeCloseTo(m11 - 0.1, 12);
    await settle(page);
    await tabTo(page, inCard('Exact value for m₂₁ (row 2, column 1)'), 'the exact m21 field');
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('-0.5');
    await page.keyboard.press('Enter');
    await expect.poll(() => controlValue(page, 'm21')).toBe(-0.5);
    await settle(page);
    await tabTo(page, info => info.inCard && info.tag === 'button' && info.name === 'Identity', 'the scenario toolbar');
    await arrowTo(page, inCard('Reflection across y = x', 'button'), 'Reflection across y = x');
    await page.keyboard.press('Enter');
    await expect.poll(() => rowText(page, 'orientation')).toBe('reversed');
    await settle(page);
    await tabTo(page, inCard('Vector table', 'button'), 'the vector table toggle', { backwards: true });
    await page.keyboard.press('Space');
    await tabTo(page, info => info.inCard && info.tag === 'div' && info.name === 'Vector coordinates', 'the vector table region');
    await expect(card(page).getByRole('table').first()).toBeVisible();

    await pressHost(page, 'data-fx-transition', 'explore-eigen');
    await expect(card(page).getByText('Unchanged-direction category').first()).toBeAttached();
    await pressHost(page, 'data-fx-transition', 'explain');
    await respondByKeyboard(page, 'det M decides orientation and area.');
    await pressHost(page, 'data-fx-action', 'close');
    await expect(page.locator('[data-fx-no-card]')).toBeVisible();
    expect(await pointer()).toBe(0);
    expect(errors).toEqual([]);
  });

  test('alternative vector-table-equivalent: the vector table lists the coordinates of every arrow drawn on the plane', async ({ page }) => {
    const errors = await openFixture(page, `${TEMPLATE}&mode=free`);
    await scenario(page, await scenarioLabel(page, 'shear'));
    await card(page).getByRole('button', { name: 'Vector table' }).click();
    const table = card(page).locator('[data-ema-panel="table"]').filter({ hasText: 'Vector coordinates' });
    await expect(table.locator('thead th')).toHaveText(['Quantity', 'Value', 'Unit']);
    const rows = Object.fromEntries(await table.locator('tbody tr').evaluateAll(items => items.map(row => [row.children[0]!.textContent ?? '', row.children[1]!.textContent ?? ''])));
    const shown = await projection(page);
    const plane = shown.views.find(view => view.viewId === 'plane')!;
    const arrows = plane.marks.filter(item => item.kind === 'arrow');
    expect(arrows.map(item => item.markId)).toEqual(['basis-e1', 'basis-e2', 'image-e1', 'image-e2', 'test-vector', 'image-vector', 'eigen-direction-1', 'eigen-direction-2']);
    const quantityOf: Record<string, string> = {
      'basis-e1': 'Basis vector e₁', 'basis-e2': 'Basis vector e₂', 'image-e1': 'Image of e₁', 'image-e2': 'Image of e₂', 'test-vector': 'Test vector v', 'image-vector': 'Image of v',
      'eigen-direction-1': 'First eigen-direction', 'eigen-direction-2': 'Second eigen-direction',
    };
    for (const arrow of arrows) {
      const text = rows[quantityOf[arrow.markId]!];
      expect(text, arrow.markId).toBeDefined();
      if (arrow.vector) expect(pair(text!), arrow.markId).toEqual(arrow.vector.map(value => Number(value.toPrecision(4))));
      else expect(text, `${arrow.markId} has no vector, so its row says why`).toMatch(/^Undefined: /);
    }
    expect(errors).toEqual([]);
  });

  test('alternative grid-table-equivalent: the transformed grid table lists both endpoints of every drawn grid line; the square image corners follow from the vector table', async ({ page }) => {
    const errors = await openFixture(page, `${TEMPLATE}&mode=free`);
    await scenario(page, await scenarioLabel(page, 'rotation-30'));
    await card(page).getByRole('button', { name: 'Vector table' }).click();
    const table = card(page).locator('[data-ema-panel="table"]').filter({ hasText: 'Transformed grid lines' });
    await expect(table.locator('thead th')).toHaveText(['Segment', 'Start x', 'Start y', 'End x', 'End y']);
    const rows = await table.locator('tbody tr').evaluateAll(items => items.map(row => [...row.children].map(cell => cell.textContent ?? '')));
    const shown = await projection(page);
    const grid = mark(shown, 'transformed-grid')!.geometry as { kind: 'segments2'; segments: { id: string; from: number[]; to: number[] }[] };
    expect(rows).toHaveLength(grid.segments.length);
    expect(grid.segments).toHaveLength(14);
    grid.segments.forEach((segment, index) => {
      const [id, ...cells] = rows[index]!;
      expect(id!.replace(/−/g, '-')).toBe(segment.id);
      expect(cells.map(num)).toEqual([...segment.from, ...segment.to].map(value => Number(value.toPrecision(6))));
    });
    const image = (mark(shown, 'unit-square-image')!.geometry as { vertices: number[][] }).vertices;
    const e1 = pair(await rowText(page, 'image.e1')), e2 = pair(await rowText(page, 'image.e2'));
    const expected = [[0, 0], e1, [e1[0]! + e2[0]!, e1[1]! + e2[1]!], e2];
    image.forEach((vertex, index) => vertex.forEach((value, axis) => expect(value).toBeCloseTo(expected[index]![axis]!, 3)));
    await shot(page, 'lt-tables');
    expect(errors).toEqual([]);
  });

  test('alternative text-description: generated summaries name only visible marks and values', async ({ page }) => {
    const errors = await openFixture(page, TEMPLATE);
    await card(page).getByRole('button', { name: 'Text description' }).click();
    const description = card(page).locator('figure[data-ema-figure="plane"] .ema-description');
    await expect(description).toContainText('The plane under M. Shows Reference grid lines x = k and y = k; Unit square before the transformation; Basis vector e₁; Basis vector e₂; Me₁, the first column of M; Me₂, the second column of M; Test vector v.');
    for (const marker of markers([...TRANSFORMED, ...EIGEN])) await expect(description).not.toContainText(marker);
    expect(errors).toEqual([]);
  });

  test('capture: SVG and PNG of this exact surface with identities; hidden groups excluded before reveal (A50)', async ({ page }) => {
    const errors = await openFixture(page, TEMPLATE);
    const surfaceId = await page.evaluate(() => window.studyHarnessFixture.surface!.surfaceId);
    const svg = await page.evaluate(() => window.studyHarnessFixture.capture('svg', 'plane'));
    expect(svg.metadata).toMatchObject({ surfaceId, viewId: 'plane' });
    expect(svg.svg).not.toContain('foreignObject');
    for (const marker of markers([...TRANSFORMED, ...EIGEN])) expect(`${svg.svg}${svg.companionText}`).not.toContain(marker);
    await drive(page, 'transition', 'predict');
    await respond(page, 'Kept.');
    await drive(page, 'transition', 'explore');
    for (const group of TRANSFORMED) await drive(page, 'reveal', group);
    const png = await page.evaluate(() => window.studyHarnessFixture.capture('png', 'plane'));
    const now = await projection(page);
    expect(png.metadata).toMatchObject({ surfaceId, viewId: 'plane', frameId: now.frame!.frameId, activityRevision: now.activityRevision });
    expect(pngSize(png.pngBase64!)).toEqual({ width: png.width, height: png.height, signature: true });
    expect(png.companionText).toContain('Transformed grid lines');
    writeFileSync(`${SHOTS_2D}/lt-capture-plane.png`, Buffer.from(png.pngBase64!, 'base64'));
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
      await scenario(page, await scenarioLabel(page, 'reflection-diagonal'));
      const facts = await overflow(page);
      expect(facts, configuration.name).toMatchObject({ page: false, card: false, offenders: [] });
      if (configuration.width) expect(Math.abs(facts.cardWidth - configuration.width), `card width ${configuration.width}`).toBeLessThanOrEqual(2);
      const cardBox = (await card(page).locator('.ema').first().boundingBox())!;
      for (const target of [control(page, 'm11').getByRole('slider'), control(page, 'm11').getByRole('textbox'), control(page, 'm11').getByRole('button', { name: 'Apply' })]) {
        const box = (await target.boundingBox())!;
        expect(box.x + box.width, `${configuration.name}: right edge`).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1);
        expect(box.height, `${configuration.name}: target height`).toBeGreaterThanOrEqual(24);
      }
      // Equal aspect for the plane: one unit is as long on x as on y.
      const ratio = await card(page).locator('svg[data-ema-view-id="plane"]').evaluate(svg => {
        // Pixels per unit from the tick labels: x ticks are centred under the axis, y ticks end-anchored beside it.
        const value = (text: string) => Number(text.replace(/−/g, '-'));
        const ticks = [...svg.querySelectorAll('text.ema-tick')].map(text => ({ anchor: text.getAttribute('text-anchor'), x: Number(text.getAttribute('x')), y: Number(text.getAttribute('y')), value: value(text.textContent ?? '') }));
        const scale = (items: typeof ticks, coordinate: 'x' | 'y') => Math.abs((items.at(-1)![coordinate] - items[0]![coordinate]) / (items.at(-1)!.value - items[0]!.value));
        return scale(ticks.filter(tick => tick.anchor === 'middle'), 'x') / scale(ticks.filter(tick => tick.anchor === 'end'), 'y');
      });
      expect(ratio, `${configuration.name}: equal aspect`).toBeCloseTo(1, 1);
      if (configuration.name === 'dark') await expect(card(page).locator('.ema')).toHaveAttribute('data-theme', 'dark');
      expect(await rowText(page, 'orientation')).toBe('reversed');
      if (['container-320', 'desktop', 'dark', 'text-200'].includes(configuration.name)) await expectAccessible(page, configuration.name);
      await shot(page, `lt-${configuration.name}`);
      expect(errors).toEqual([]);
      await page.close();
    }
  });
});
