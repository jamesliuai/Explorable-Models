/**
 * Server-rendered learner card scans for the terminal outcome, navigation and comparison channels (report §6.2, §6.4,
 * §10.2; A21, A25, A34; R02, R10). Real adapter projections (fixture host, in-process test workers) rendered by the
 * shipped StudyActivitySurface through a read-only binding: with the trace hidden a divergent and a convergent run render
 * the same card apart from their own step-size control, an independent card without a position group in its scaffold has
 * no navigation and no retained runs, and a kept run whose differing setting is not shown is never called the same.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { PLAYBACK_LIMIT_NOTICE, TERMINAL_TEXT, VALUE_STATUS_TEXT, type ActivityBinding, type LearnerProjection } from '../../packages/activity/src/index';
import { StudyActivitySurface } from '../../packages/player/src/activity/index';
import { enterExplore, guards, harness, okOf, op, open, requestFor, settled, type Harness, type Opened } from '../activity/support/adapter-harness.js';

let current: Harness | null = null;
const make = () => (current = harness());
afterEach(() => { current?.adapter.dispose(); current = null; });

function staticBinding(projection: LearnerProjection): ActivityBinding {
  const forbidden = () => { throw new Error('rendering must not issue commands'); };
  return new Proxy({ activityId: projection.activityId, actor: 'learner', getProjection: () => projection, subscribe: () => () => undefined } as unknown as ActivityBinding, {
    get: (target, key) => key in target ? target[key as keyof ActivityBinding] : forbidden,
  });
}
const render = (projection: LearnerProjection) => renderToString(createElement(StudyActivitySurface, { binding: staticBinding(projection), theme: 'light' }));
/** Visible and accessible text of the card: tags and attributes become single spaces (aria text is element content). */
const textOf = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, '\'').replace(/\s+/g, ' ').trim();
const OUTCOME = [TERMINAL_TEXT['numerical-limit'], PLAYBACK_LIMIT_NOTICE, VALUE_STATUS_TEXT['numerical-limit'], VALUE_STATUS_TEXT.mixed, 'Its last finite value'];

async function freeExploreAt(eta: number, index: number): Promise<LearnerProjection> {
  const h = make();
  const opened = await open(h, requestFor({ stageId: 'free-explore', parameters: { a: 2, eta, x0: 4 } }));
  await settled(h);
  okOf(await opened.learner.navigate({ operationId: op(), ...guards(opened.learner), position: { kind: 'index', index } }));
  await settled(h);
  const projection = opened.learner.getProjection();
  h.adapter.dispose();
  return projection;
}

describe('rendered terminal outcome with the trace hidden (R02)', () => {
  for (const index of [1000, 700]) {
    it(`a divergent and a convergent run render the same card at n = ${index}, apart from the step-size control`, async () => {
      const divergent = await freeExploreAt(2, index), convergent = await freeExploreAt(0.25, index);
      for (const projection of [divergent, convergent]) {
        const html = render(projection);
        expect(html).toContain('class="ema-panel ema-nav"');
        for (const text of OUTCOME) expect(html).not.toContain(text);
      }
      const card = (projection: LearnerProjection) => textOf(render({ ...projection, controls: [] }));
      expect(card(divergent)).toBe(card(convergent));
      if (index === 1000) expect(card(divergent)).toContain(`End of the computed run : ${TERMINAL_TEXT['max-index']}`);
      else expect(card(divergent)).not.toContain('End of the computed run');
    });
  }
});

describe('rendered independent card and comparisons (R02, R10)', () => {
  async function keptThenChanged(h: Harness): Promise<Opened> {
    const opened = await open(h);
    await enterExplore(h, opened);
    okOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { eta: 1.25 } }));
    okOf(await opened.learner.navigate({ operationId: op(), ...guards(opened.learner), position: { kind: 'index', index: 6 } }));
    okOf(opened.learner.retainComparison({ operationId: op(), ...guards(opened.learner), label: 'Kept run' }));
    okOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { eta: 0.25 } }));
    await settled(h);
    return opened;
  }

  it('an independent card whose scaffold keeps no position group renders no navigation and no retained run', async () => {
    const h = make();
    const opened = await keptThenChanged(h);
    expect(render(opened.learner.getProjection())).toContain('data-ema-panel="comparisons"');
    const policy = h.host.amendPolicy({ independentTask: { active: true, taskRef: 'task-new-curvature', permittedTools: ['inspect.learner'], neutralScaffold: ['landscape', 'start'] } });
    okOf(await opened.control.enterIndependentTask({ operationId: op(), taskRef: 'task-new-curvature', policy }));
    await settled(h);
    const html = render(opened.learner.getProjection());
    expect(html).not.toContain('ema-nav');
    expect(html).not.toContain('data-ema-panel="comparisons"');
    for (const text of ['Iterations', 'Play', 'Restart', 'End of the computed run', 'Kept run', 'same settings', 'Same parameters']) expect(textOf(html)).not.toContain(text);
  });

  it('a kept run whose differing setting is not shown says so instead of "Same parameters"', async () => {
    const h = make();
    const opened = await keptThenChanged(h);
    okOf(await opened.control.updatePolicy({ operationId: op(), policy: h.host.amendPolicy({ permittedControls: ['a', 'x0'] }) }));
    const text = textOf(render(opened.learner.getProjection()));
    expect(text).toContain('Kept run 1 : settings not shown here differ from the current run');
    expect(text).toContain('Settings that are not shown here differ from the current run.');
    expect(text).not.toContain('Same parameters as the current run.');
    expect(text).not.toContain('same settings as the current run');
  });
});
