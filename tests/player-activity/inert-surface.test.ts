/**
 * Server-rendered learner card in inert states (report §10.2, §10.4, §11; gap G43) and the Reset experiment control
 * (report §9; gap G26). Static projections from the projection-lab fixtures; the browser behaviour is covered by
 * tests/browser/study-interaction.spec.ts.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import type { ActivityBinding, LearnerProjection, UiState } from '../../packages/activity/src/api';
import { StudyActivitySurface } from '../../packages/player/src/activity/index';
import { inertReason } from '../../packages/player/src/activity/StudyActivitySurface';
import { INERT_STATES } from '../../packages/player/src/activity/runtime';
import { fixtureProjection } from '../../examples/study-harness-host/projection-lab.fixtures';

function staticBinding(projection: LearnerProjection): ActivityBinding {
  const forbidden = () => { throw new Error('rendering must not issue commands'); };
  return new Proxy({ activityId: projection.activityId, actor: 'learner', getProjection: () => projection, subscribe: () => () => undefined } as unknown as ActivityBinding, {
    get: (target, key) => key in target ? target[key as keyof ActivityBinding] : forbidden,
  });
}
const render = (projection: LearnerProjection) => renderToString(createElement(StudyActivitySurface, { binding: staticBinding(projection), theme: 'light' }));
const tags = (html: string, pattern: RegExp) => [...html.matchAll(/<(input|button|select)\b[^>]*>/g)].map(match => match[0]).filter(tag => pattern.test(tag));
/** The HTML of the element that starts at the first match of `start` up to the end of its section. */
const section = (html: string, start: string) => { const from = html.indexOf(start); return from < 0 ? '' : html.slice(from, html.indexOf('</section>', from)); };

describe('inert states (G43)', () => {
  it('derives the inert reason from status.ui for exactly the five inert states', () => {
    const reasons = Object.fromEntries((['ready', 'paused', 'playing', 'tentative-preview', 'recoverable-failure', 'suspended', 'stale-policy', 'unsupported', 'awaiting-persistence', 'disposed'] as UiState[])
      .map(ui => [ui, inertReason({ ui, message: ui === 'suspended' ? 'Paused by the host. It continues at the same step when the host resumes it.' : null, recovery: null, persistence: 'saved', live: null })]));
    expect(reasons).toEqual({
      ready: null, paused: null, playing: null, 'tentative-preview': null, 'recoverable-failure': null,
      suspended: 'Paused by the host.', 'stale-policy': 'Waiting for updated permissions from the host.', unsupported: 'Not available here.',
      'awaiting-persistence': 'Waiting for the host to save this step.', disposed: 'This activity has ended.',
    });
    expect([...INERT_STATES].sort()).toEqual(['awaiting-persistence', 'disposed', 'stale-policy', 'suspended', 'unsupported']);
    expect(inertReason({ ui: 'suspended', message: 'Paused while hidden. It continues at the same step when it is shown again.', recovery: null, persistence: 'saved', live: null })).toBe('Paused while hidden.');
  });

  it('host suspension: every slider, exact entry, Apply, scenario, navigation button and Reset experiment is aria-disabled with the visible reason', () => {
    const projection = fixtureProjection('quadratic', 'suspended');
    expect(projection.controls.some(control => control.mode === 'interactive')).toBe(true);
    const html = render(projection);
    const sliders = tags(html, /type="range"/), entries = tags(html, /class="ema-input"/).filter(tag => !/ema-goto/.test(tag));
    expect(sliders.length).toBeGreaterThan(0);
    for (const tag of [...sliders, ...entries]) expect(tag, tag).toMatch(/aria-disabled="true"|readOnly=""|readonly=""/);
    for (const tag of sliders) expect(tag).toContain('aria-disabled="true"');
    const nav = section(html, 'aria-label="Iteration controls"');
    expect(nav).not.toBe('');
    const navButtons = tags(nav, /./);
    expect(navButtons.length).toBeGreaterThanOrEqual(5);
    for (const tag of navButtons) expect(tag, tag).toMatch(/aria-disabled="true"/);
    const scenarioButtons = tags(section(html, 'class="ema-scenarios"'), /<button/);
    expect(scenarioButtons.length).toBeGreaterThan(0);
    for (const tag of scenarioButtons) expect(tag, tag).toContain('aria-disabled="true"');
    const reset = tags(section(html, 'data-ema-action="reset-experiment"'), /<button/);
    expect(reset).toHaveLength(1);
    expect(reset[0]).toContain('aria-disabled="true"');
    expect(html.split('Paused by the host.').length - 1).toBeGreaterThanOrEqual(projection.controls.length + 2);
    expect(html).not.toContain('Keep this run');
  });

  it('stale policy: a neutral instruction replaces the teaching instruction and nothing scientific is offered', () => {
    const projection = fixtureProjection('quadratic', 'stale-policy');
    const html = render(projection);
    expect(html).toContain('This activity is waiting for the host. Nothing new is shown until the permissions are updated.');
    expect(html).not.toContain(fixtureProjection('quadratic', 'ready').stage.instruction);
    expect(tags(html, /type="range"/)).toEqual([]);
    expect(html).not.toContain('Keep this run');
    expect(html).not.toContain('Reset experiment');
  });

  it('blocked states (stale policy, unsupported) present one consistent card: the neutral instruction, the banner and nothing to navigate, answer or wait for (S4)', () => {
    for (const state of ['stale-policy', 'unsupported'] as UiState[]) {
      const projection = fixtureProjection('quadratic', state);
      expect(projection.stage.response, state).toBeUndefined();
      const html = render(projection);
      expect(html, state).not.toContain('aria-label="Iteration controls"');
      expect(html, state).not.toContain('class="ema-pending"');
      expect(html, state).not.toContain('class="ema-response"');
      expect(html, state).not.toMatch(/<input|type="range"/);
      expect(html.match(/class="ema-banner"/g) ?? [], state).toHaveLength(1);
    }
  });

  it('contentless states have a focusable heading as their focus target', () => {
    for (const state of ['preparing', 'disposed'] as UiState[]) {
      const html = render(fixtureProjection('quadratic', state));
      expect(html, state).toMatch(/<h[2-6][^>]*class="ema-title"[^>]*tabindex="-1"|<h[2-6][^>]*tabindex="-1"[^>]*class="ema-title"/i);
      expect(html, state).not.toContain('class="ema-instruction"');
    }
  });
});

describe('Reset experiment (G26)', () => {
  it('is offered, enabled and described while a control is interactive; absent when every control is fixed', () => {
    const ready = fixtureProjection('quadratic', 'ready');
    const html = render(ready);
    const reset = tags(section(html, 'data-ema-action="reset-experiment"'), /<button/);
    expect(reset).toHaveLength(1);
    expect(reset[0]).not.toContain('aria-disabled');
    expect(html).toContain('Starts a new run from the starting values. Earlier work stays recorded.');
    const fixed = { ...ready, controls: ready.controls.map(control => ({ ...control, mode: 'fixed' as const })) };
    expect(render(fixed)).not.toContain('Reset experiment');
  });
});
