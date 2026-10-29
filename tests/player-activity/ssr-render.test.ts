import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import type { ActivityBinding, LearnerProjection } from '../../packages/activity/src/api';
import { fixtureProjection, FIXTURES, UI_STATES } from '../../examples/study-harness-host/projection-lab.fixtures';

/** Read-only binding: rendering must not issue commands. */
function staticBinding(projection: LearnerProjection): ActivityBinding {
  const forbidden = () => { throw new Error('rendering must not issue commands'); };
  return new Proxy({ activityId: projection.activityId, actor: 'learner', getProjection: () => projection, subscribe: () => () => undefined } as unknown as ActivityBinding, {
    get: (target, key) => key in target ? target[key as keyof ActivityBinding] : forbidden,
  });
}

describe('server-safe import and render (no DOM at module load or render time)', () => {
  it('imports the entry without browser globals and renders every fixture and UI state', async () => {
    expect(typeof (globalThis as { document?: unknown }).document).toBe('undefined');
    const { StudyActivitySurface } = await import('../../packages/player/src/activity/index');
    for (const fixture of FIXTURES) {
      for (const state of UI_STATES) {
        const projection = fixtureProjection(fixture, state);
        const html = renderToString(createElement(StudyActivitySurface, { binding: staticBinding(projection), theme: 'light' }));
        expect(html, `${fixture}/${state}`).toContain('class="eka"');
        expect(html).toContain(`data-eka-ui-state="${state}"`);
        expect(html).not.toContain('fixture-run');
        expect(html).not.toMatch(/<foreignObject|dangerously/);
      }
    }
  });

  it('escapes script-like learner text and never renders it as markup', async () => {
    const { StudyActivitySurface } = await import('../../packages/player/src/activity/index');
    const projection = fixtureProjection('quadratic', 'ready');
    projection.title = '<img src=x onerror=alert(1)>';
    projection.stage = { ...projection.stage, instruction: '<script>alert(1)</script>' };
    projection.views[0] = { ...projection.views[0], title: '"><svg onload=alert(1)>', marks: projection.views[0].marks.map(mark => ({ ...mark, label: '<b>bold</b>' })) };
    const html = renderToString(createElement(StudyActivitySurface, { binding: staticBinding(projection) }));
    expect(html).not.toMatch(/<img src=x|<script>|<svg onload|<b>bold<\/b>/);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('renders hidden controls as absent and fixed controls as aria-disabled with a visible reason', async () => {
    const { StudyActivitySurface } = await import('../../packages/player/src/activity/index');
    const projection = fixtureProjection('quadratic', 'ready');
    projection.controls = projection.controls.filter(control => control.parameter !== 'x0');
    const html = renderToString(createElement(StudyActivitySurface, { binding: staticBinding(projection) }));
    expect(html).not.toContain('data-parameter="x0"');
    expect(html).toMatch(/data-parameter="a"[\s\S]*aria-disabled="true"/);
    expect(html).toContain('Curvature is fixed until the next part of the activity.');
    expect(html).toContain('n = 3 of 1000');
  });

  // The out-of-view line keeps its height with an invisible sizing copy of its longest text. That copy is CSS-generated
  // content, so the card's text — what a reader, selection, copy or text extraction gets — never says values are outside
  // the view while the visible line says every drawn value is inside it (F5).
  it('the out-of-view sizing copy carries no text and never contradicts the visible indicator', async () => {
    const { StudyActivitySurface } = await import('../../packages/player/src/activity/index');
    const html = renderToString(createElement(StudyActivitySurface, { binding: staticBinding(fixtureProjection('quadratic', 'ready')), theme: 'light' }));
    const textOf = (markup: string) => markup.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const sizers = html.match(/<div class="eka-clip-sizer"[^>]*>[\s\S]*?<\/div>/g) ?? [];
    expect(sizers.length).toBeGreaterThan(0);
    for (const sizer of sizers) {
      expect(sizer).toMatch(/^<div class="eka-clip-sizer" aria-hidden="true" inert=""/);
      expect(textOf(sizer)).toBe('');
      expect(sizer).toContain('data-eka-sizer-text="Some values are outside the view"');
    }
    const text = textOf(html);
    expect(text).toContain('All drawn values are inside the view.');
    expect(text).not.toContain('Some values are outside the view');
    // The sizing rule generates the copy's words for layout only, in an element that stays hidden.
    const { ACTIVITY_STYLESHEET } = await import('../../packages/player/src/activity/styles');
    expect(ACTIVITY_STYLESHEET).toContain('.eka-clip-sizer{visibility:hidden}');
    expect(ACTIVITY_STYLESHEET).toContain('.eka-clip-sizer [data-eka-sizer-text]::before{content:attr(data-eka-sizer-text)}');
  });
});
