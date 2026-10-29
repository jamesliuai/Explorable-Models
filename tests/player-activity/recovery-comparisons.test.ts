/**
 * Learner card recovery and comparison panel, server-rendered from projections the real activity controller produces
 * (report §9, §10.2, §10.4; A11, A34; review findings R18, R20, R26, R39): exhausted worker recovery offers the
 * projection's `Reload the activity` instead of a refused Try again; `Stop comparing` is inert like every other scientific
 * action; the comparison values table keeps the reason of an undefined or limit value; and the kept run's boundary
 * sentence is stated once. Fixture-host results with in-process test workers; the mounted behaviour is covered by
 * tests/browser/study-interaction.spec.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createInstalledCatalog, INSTALLED_TEMPLATES } from '@experiment-kit/catalog';
import type { ActivityBinding, LearnerProjection } from '../../packages/activity/src/index';
import { WORKER_RECOVERY_ATTEMPTS } from '../../packages/activity/src/controller';
import { StudyActivitySurface } from '../../packages/player/src/activity/index';
import { inertReason } from '../../packages/player/src/activity/StudyActivitySurface';
import { INERT_STATES } from '../../packages/player/src/activity/runtime';
import { CONTENTLESS_STATES, presentStatus } from '../../packages/player/src/activity/status';
import { fixtureProjection } from '../../examples/study-harness-host/projection-lab.fixtures';
import {
  ackCurrent, activityGuard, codesOf, enterExplore, guards, harness, okOf, op, open, policyFor, settled, type Harness,
} from '../activity/support/adapter-harness';

let current: Harness | null = null;
afterEach(() => { current?.adapter.dispose(); current = null; });

const render = (binding: ActivityBinding, props: Record<string, unknown> = {}): string =>
  renderToString(createElement(StudyActivitySurface, { binding, theme: 'light', ...props } as never)).replace(/<!--[\s\S]*?-->/g, '');
/** Readable text of one element of the HTML that starts at `start` (tags removed). */
const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
/** A binding that serves one static projection; rendering must not issue commands. */
function staticBinding(projection: LearnerProjection): ActivityBinding {
  const forbidden = () => { throw new Error('rendering must not issue commands'); };
  return new Proxy({ activityId: projection.activityId, actor: 'learner', getProjection: () => projection, subscribe: () => () => undefined } as unknown as ActivityBinding, {
    get: (target, key) => key in target ? target[key as keyof ActivityBinding] : forbidden,
  });
}
const between = (html: string, start: string, end: string): string => { const from = html.indexOf(start); return from < 0 ? '' : html.slice(from, end ? html.indexOf(end, from + start.length) : undefined); };
const banner = (html: string): string => /<div class="eka-banner"[\s\S]*?<\/div><\/div>/.exec(html)?.[0] ?? '';
const comparisons = (html: string): string => between(html, 'data-eka-panel="comparisons"', '</section>');

describe('exhausted worker recovery (R18, report §9 bounded recovery, §10.4)', () => {
  async function exhausted(): Promise<{ opened: Awaited<ReturnType<typeof open>>; projection: LearnerProjection }> {
    current = harness();
    const h = current;
    const opened = await open(h);
    await enterExplore(h, opened);
    okOf(await opened.learner.navigate({ operationId: op(), ...guards(opened.learner), position: { kind: 'index', index: 2 } }));
    await settled(h);
    h.workers.hostility = 'crash';
    expect(codesOf(await opened.learner.step({ operationId: op(), ...guards(opened.learner), delta: 1 }))).toEqual(['WORKER_ERROR']);
    return { opened, projection: opened.learner.getProjection() };
  }

  it('while retries remain the banner offers Try again; once they are used up it offers the projection\'s Reload the activity and never the refused retry', async () => {
    const { opened, projection: first } = await exhausted();
    expect(first.status).toMatchObject({ ui: 'recoverable-failure', recovery: { action: 'retry', label: 'Try again' } });
    expect(presentStatus(first)).toMatchObject({ actions: ['retry'], recoveryLabel: 'Try again' });
    expect(text(banner(render(opened.learner)))).toContain('Try again');

    for (let attempt = 1; attempt <= WORKER_RECOVERY_ATTEMPTS; attempt++) await opened.learner.retryPersistence({ operationId: op('retry') });
    const spent = opened.learner.getProjection();
    expect(spent.status).toMatchObject({ ui: 'recoverable-failure', recovery: { action: 'reload', label: 'Reload the activity' } });
    // A further retry is refused by the runtime: the card must not offer it.
    expect(codesOf(await opened.learner.retryPersistence({ operationId: op('retry') }))).toEqual(['WORKER_ERROR']);
    expect(presentStatus(spent)).toMatchObject({ cause: 'failure', actions: ['reload'], recoveryLabel: 'Reload the activity', tone: 'error' });

    // With a host that handles reload: one Reload the activity button, no Try again anywhere on the card.
    const handled = render(opened.learner, { onRecoveryAction: () => undefined });
    const shown = banner(handled);
    expect(shown).toMatch(/<button[^>]*>Reload the activity<\/button>/);
    expect(text(shown)).toContain('The last step did not complete');
    expect(text(shown)).toContain('The previous result is still shown');
    expect(text(handled)).not.toContain('Try again');
    expect(handled).not.toMatch(/<button[^>]*>Retry saving<\/button>/);
    // Without one, the action is described, not offered as a control that does nothing.
    const described = banner(render(opened.learner));
    expect(described).not.toMatch(/<button/);
    expect(text(described)).toContain('Reload the activity.');
  });
});

describe('Stop comparing follows the inert contract (R20, report §10.2, G43)', () => {
  async function kept(): Promise<{ h: Harness; opened: Awaited<ReturnType<typeof open>> }> {
    current = harness();
    const h = current;
    const opened = await open(h);
    await enterExplore(h, opened);
    okOf(await opened.learner.retainComparison({ operationId: op(), ...guards(opened.learner), label: 'η = 0.25' }));
    okOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { eta: 0.75 } }));
    await settled(h);
    return { h, opened };
  }
  const stopButton = (html: string): string => /<button[^>]*>Stop comparing with kept run 1<\/button>/.exec(html)?.[0] ?? '';

  it('is available while the card is ready, and aria-disabled with the card\'s visible reason during a host suspension', async () => {
    const { opened } = await kept();
    const ready = stopButton(render(opened.learner));
    expect(ready).not.toBe('');
    expect(ready).not.toContain('aria-disabled');

    opened.control.suspend({ operationId: op(), reason: 'host' });
    const suspended = opened.learner.getProjection();
    expect(suspended.status.ui).toBe('suspended');
    expect(suspended.comparisons).toHaveLength(1);
    const html = render(opened.learner);
    const button = stopButton(html);
    expect(button).toContain('aria-disabled="true"');
    const describedBy = /aria-describedby="([^"]+)"/.exec(button)?.[1];
    expect(describedBy).toBeTruthy();
    expect(text(between(html, `id="${describedBy}"`, '</p>'))).toContain('Paused by the host.');
    // The command it would send is the one the runtime refuses while suspended (NOT_READY): it must not be offered.
    expect(codesOf(await opened.learner.removeComparison({ operationId: op(), ...guards(opened.learner), runId: suspended.comparisons[0]!.runId }))).toEqual(['NOT_READY']);
  });

  it('in every inert state that still shows kept runs (suspension, awaiting persistence) it is aria-disabled with the visible reason', () => {
    const checked: string[] = [];
    for (const state of [...INERT_STATES].filter(item => !CONTENTLESS_STATES.has(item))) {
      const projection = fixtureProjection('comparison', state);
      expect(projection.status.ui).toBe(state);
      if (!projection.comparisons.length) continue;
      checked.push(state);
      const html = render(staticBinding(projection));
      const reason = inertReason(projection.status)!;
      const buttons = [...html.matchAll(/<button[^>]*>Stop comparing with kept run \d+<\/button>/g)].map(match => match[0]);
      expect(buttons.length, state).toBe(projection.comparisons.length);
      for (const button of buttons) {
        expect(button, state).toContain('aria-disabled="true"');
        const describedBy = /aria-describedby="([^"]+)"/.exec(button)?.[1];
        expect(text(between(html, `id="${describedBy}"`, '</p>')), state).toContain(reason);
      }
    }
    // A stale or unsupported projection withdraws the comparisons with the rest of the content.
    expect(checked.sort()).toEqual(['awaiting-persistence', 'suspended']);
  });
});

describe('comparison panel reasons (R26 A11/A34; R39 one statement per reason)', () => {
  async function openTemplate(id: string, stages: string[]) {
    const template = INSTALLED_TEMPLATES.find(item => item.templateId === id)!;
    const entry = createInstalledCatalog().listTemplates().find(item => item.template.templateId === id)!;
    current = harness({ policy: policyFor({ policyId: 'p', approved: [{ template: entry.template, model: entry.model }], visibleGroups: template.groups.map(group => group.id), permittedControls: template.controls.map(control => control.parameter) }) });
    const activityId = `act-${id}`.slice(0, 60);
    const opened = await open(current, { activityId, objectiveIds: ['obj-1'], hostSessionId: 'session-1', hostSessionRevision: 0, template: { templateId: id, version: template.version }, mode: 'approved' });
    await settled(current, activityId);
    for (const stage of stages) {
      okOf(await opened.control.requestStageTransition({ operationId: op('stage'), ...activityGuard(opened.learner), toStage: stage }));
      await settled(current, activityId);
      ackCurrent(opened.learner);
      await settled(current, activityId);
    }
    return { opened, activityId };
  }

  it('an undefined value of the kept run keeps its reason in the values table (linear transformation: collapse direction of a full-rank matrix)', async () => {
    const { opened, activityId } = await openTemplate('linear-transformation', ['predict', 'explore']);
    okOf(await opened.learner.retainComparison({ operationId: op(), ...guards(opened.learner), label: 'first' }));
    okOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { m11: 1, m12: 1.5, m21: 2, m22: 3 } }));
    await settled(current!, activityId);
    const row = opened.learner.getProjection().comparisons[0]!.values.find(value => value.label.startsWith('Collapse'))!;
    expect(row.kept.status).toBe('undefined');
    expect(row.kept.reason).toContain('rank 2');
    const html = comparisons(render(opened.learner));
    const values = between(html, 'data-eka-comparison-values', '</table>');
    const cells = [...values.matchAll(/<tr><th scope="row">([^<]*)<\/th><td>([\s\S]*?)<\/td><td>([\s\S]*?)<\/td><\/tr>/g)].find(match => match[1]!.startsWith('Collapse'))!;
    expect(cells, 'collapse row').toBeTruthy();
    // The kept cell says Undefined and gives the reason (never a bare word, never a number).
    expect(text(cells[3]!)).toBe(`Undefined ${row.kept.reason}`);
    expect(cells[3]).toContain('class="eka-comparison-reason"');
  });

  it('a value beyond the representable range keeps its limit badge and reason in the values table', async () => {
    current = harness();
    const h = current;
    const opened = await open(h);
    await enterExplore(h, opened);
    // η·a = 4: the iterates diverge and overflow; kept at a late index, compared with a convergent run.
    okOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { eta: 2 } }));
    okOf(await opened.learner.navigate({ operationId: op(), ...guards(opened.learner), position: { kind: 'index', index: 700 } }));
    await settled(h);
    okOf(await opened.learner.retainComparison({ operationId: op(), ...guards(opened.learner), label: 'diverging' }));
    okOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { eta: 0.25 } }));
    okOf(await opened.learner.navigate({ operationId: op(), ...guards(opened.learner), position: { kind: 'index', index: 700 } }));
    await settled(h);
    const comparison = opened.learner.getProjection().comparisons[0]!;
    const limited = comparison.values.filter(value => value.kept.status === 'numerical-limit');
    expect(limited.length).toBeGreaterThan(0);
    const html = comparisons(render(opened.learner));
    for (const value of limited) {
      const cells = [...between(html, 'data-eka-comparison-values', '</table>').matchAll(/<tr><th scope="row">([^<]*)<\/th><td>([\s\S]*?)<\/td><td>([\s\S]*?)<\/td><\/tr>/g)].find(match => match[1] === value.label)!;
      expect(cells, value.label).toBeTruthy();
      expect(cells[3]).toContain('<span class="eka-badge">limit</span>');
      expect(text(cells[3]!)).toContain(value.kept.reason!);
    }
  });

  it('the kept run\'s boundary sentence is stated once; its Not available cell points at it instead of repeating it', async () => {
    current = harness();
    const h = current;
    const opened = await open(h);
    await enterExplore(h, opened);
    okOf(await opened.learner.navigate({ operationId: op(), ...guards(opened.learner), position: { kind: 'index', index: 5 } }));
    okOf(await opened.learner.retainComparison({ operationId: op(), ...guards(opened.learner), label: 'k' }));
    okOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { eta: 1.25 } }));
    okOf(await opened.learner.navigate({ operationId: op(), ...guards(opened.learner), position: { kind: 'index', index: 8 } }));
    await settled(h);
    const comparison = opened.learner.getProjection().comparisons[0]!;
    const sentence = 'The kept run was kept at n = 5 and is not computed beyond it.';
    expect(comparison.boundary).toBe(sentence);
    expect(comparison.aligned.some(row => row.kept === null && row.reason === sentence)).toBe(true);
    const html = comparisons(render(opened.learner));
    // Once in the whole panel, including screen-reader-only text.
    expect(text(html).split(sentence).length - 1).toBe(1);
    const boundaryId = /<p class="eka-comparison-boundary" id="([^"]+)"/.exec(html)?.[1];
    expect(boundaryId).toBeTruthy();
    const missing = [...html.matchAll(/<span class="eka-comparison-missing"([^>]*)>Not available<\/span>/g)];
    expect(missing.length).toBeGreaterThan(0);
    for (const cell of missing) expect(cell[1]).toContain(`aria-describedby="${boundaryId}"`);
  });
});
