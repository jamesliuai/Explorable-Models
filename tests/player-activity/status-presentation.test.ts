/**
 * Status presentation by cause (report §10.4; gaps G41, G45): every UI state of the projection lab — whose status texts
 * come from the activity runtime's own vocabulary — is presented with one title that the message does not repeat, a tone
 * by cause, at most one recovery control and a persistence chip that agrees with it; transient states are inline, never
 * a banner above the content; the placeholder renders the preparing and empty card before a binding exists. Server
 * rendering only.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { CLOSED_MESSAGE, HOST_SUSPENDED_MESSAGE, TERMINAL_TEXT, UI_STATUS, VALUE_STATUS_TEXT, type LearnerProjection, type UiState } from '../../packages/activity/src/index';
import { StudyActivityPlaceholder, StudyActivitySurface } from '../../packages/player/src/activity/index';
import { chipPersistence, presentStatus, statusCause } from '../../packages/player/src/activity/status';
import { fixtureProjection, UI_STATES } from '../../examples/study-harness-host/projection-lab.fixtures';

/** A binding that serves one projection (server rendering only; no command is issued). */
const serve = (projection: LearnerProjection) => ({
  activityId: projection.activityId, actor: 'learner', getProjection: () => projection, subscribe: () => () => undefined, registerSurface: () => () => undefined,
  reportVisibility: () => undefined, acknowledgeDisplay: () => undefined, describeCurrentValues: () => '',
}) as unknown as Parameters<typeof StudyActivitySurface>[0]['binding'];
const render = (projection: LearnerProjection) => renderToString(createElement(StudyActivitySurface, { binding: serve(projection), theme: 'light' })).replace(/<!-- -->/g, '');
const RUNTIME_VOCABULARY = new Set<string>([
  ...Object.values(UI_STATUS).map(entry => entry.message).filter((text): text is string => !!text),
  ...Object.values(TERMINAL_TEXT), ...Object.values(VALUE_STATUS_TEXT), HOST_SUSPENDED_MESSAGE, CLOSED_MESSAGE,
]);

describe('projection lab status texts are the runtime vocabulary (G45)', () => {
  it('every state of every fixture carries a message the activity runtime itself projects', () => {
    for (const name of ['quadratic', 'geometry', 'spatial', 'long', 'extreme', 'comparison'] as const) for (const state of UI_STATES) {
      const { status } = fixtureProjection(name, state);
      expect(status.ui).toBe(state);
      if (status.message !== null) expect(RUNTIME_VOCABULARY.has(status.message), `${name}/${state}: ${status.message}`).toBe(true);
      expect(status.recovery, `${name}/${state}`).toEqual(UI_STATUS[state].recovery);
    }
  });
});

describe('one presentation per cause (G41, report §10.4)', () => {
  for (const state of UI_STATES) {
    it(`${state}: one title, a message that does not repeat it, at most one recovery control, a chip that agrees`, () => {
      const projection = fixtureProjection('quadratic', state);
      const status = presentStatus(projection);
      const html = render(projection);
      const banners = html.match(/class="ema-banner"/g) ?? [];
      const retries = html.match(/>(Try again|Retry saving)</g) ?? [];
      expect(retries.length, 'retry controls').toBeLessThanOrEqual(1);
      expect(banners.length, 'banners').toBeLessThanOrEqual(1);
      if (!status) { expect(banners).toEqual([]); return; }
      if (status.message) expect(status.message.toLowerCase().startsWith(status.title.replace(/[.…]$/, '').toLowerCase()), `${state}: message repeats title`).toBe(false);
      expect(status.actions.filter(action => action !== 'cancel').length, `${state}: recovery controls`).toBeLessThanOrEqual(1);
      // Transient states never insert a banner above the content.
      if (['tentative-preview', 'playing', 'paused'].includes(state)) { expect(status.placement).toBe('inline'); expect(banners).toEqual([]); }
      if (status.placement === 'banner') expect(html).toContain(`data-cause="${status.cause}"`);
      // The chip never says “Saved” beside a saving or failed banner.
      if (['saving-reveal', 'reveal-not-saved', 'journal-not-saved', 'journal-failed', 'display-not-recorded'].includes(status.cause)) expect(chipPersistence(projection)).not.toBe('saved');
    });
  }

  it('awaiting persistence is presented by its cause: saving, not recorded, journal waiting, journal failed, display not confirmed', () => {
    const base = fixtureProjection('quadratic', 'awaiting-persistence');
    const variant = (pending: LearnerProjection['pendingReveal'], persistence: LearnerProjection['status']['persistence']): LearnerProjection =>
      ({ ...base, pendingReveal: pending, status: { ...base.status, persistence } });
    const cases: [LearnerProjection, string, string, string[], string][] = [
      [variant({ labels: ['Iteration trace'], state: 'requesting' }, 'saved'), 'saving-reveal', 'info', [], 'saving'],
      [variant({ labels: ['Iteration trace'], state: 'failed' }, 'saved'), 'reveal-not-saved', 'warning', ['retry'], 'pending-recovery'],
      [variant(null, 'pending-recovery'), 'journal-not-saved', 'warning', ['retry'], 'pending-recovery'],
      [variant(null, 'failed'), 'journal-failed', 'error', ['retry'], 'failed'],
      [variant({ labels: ['Iteration trace'], state: 'awaiting-display' }, 'saved'), 'display-not-recorded', 'warning', ['retry'], 'pending-recovery'],
    ];
    for (const [projection, cause, tone, actions, chip] of cases) {
      const status = presentStatus(projection)!;
      expect([status.cause, status.tone, status.actions, chipPersistence(projection)], cause).toEqual([cause, tone, actions, chip]);
      const html = render(projection);
      expect(html.match(/>(Try again|Retry saving)</g) ?? [], cause).toHaveLength(actions.length);
      expect(html).not.toContain('class="ema-pending"');
    }
    expect(presentStatus(cases[0]![0])!.message).toBe('The host is recording this step before showing Iteration trace. What you see stays as it is until then.');
  });

  it('titles follow the cause: a closed card is closed, a host pause and a hidden pause say which, an undefined drawing says what kind', () => {
    const empty = fixtureProjection('quadratic', 'empty');
    expect(presentStatus({ ...empty, status: { ...empty.status, message: CLOSED_MESSAGE } })).toMatchObject({ cause: 'closed', title: 'This activity is closed', message: null });
    expect(presentStatus(empty)).toMatchObject({ cause: 'empty', title: 'Nothing is shown in this activity right now', message: null });
    const suspended = fixtureProjection('quadratic', 'suspended');
    expect(statusCause(suspended)).toBe('paused-by-host');
    expect(statusCause({ ...suspended, status: { ...suspended.status, message: UI_STATUS.suspended.message } })).toBe('paused-while-hidden');
    expect(presentStatus(fixtureProjection('quadratic', 'undefined'))).toMatchObject({ title: 'Some values are beyond the representable range', tone: 'warning' });
    // A numerical-limit end is titled by its cause, also when a notice follows the terminal sentence.
    const boundary = fixtureProjection('quadratic', 'boundary');
    expect(boundary.status.cause).toBe('numerical-limit');
    expect(presentStatus(boundary)).toMatchObject({ cause: 'numerical-limit', title: 'Numerical limit reached' });
    expect(statusCause({ ...boundary, status: { ...boundary.status, message: `${TERMINAL_TEXT['numerical-limit']} The value was adjusted to the allowed range.` } })).toBe('numerical-limit');
    const playing = fixtureProjection('quadratic', 'playing');
    expect(presentStatus(playing)).toBeNull();
    expect(presentStatus({ ...playing, status: { ...playing.status, message: 'Playing. The value was adjusted to the allowed range.' } })).toMatchObject({ placement: 'inline', message: 'The value was adjusted to the allowed range.' });
    expect(presentStatus(fixtureProjection('quadratic', 'recoverable-failure'))).toMatchObject({ title: 'The last step did not complete', message: 'The previous result is still shown.', tone: 'error', actions: ['retry'] });
    expect(presentStatus(fixtureProjection('quadratic', 'restored'))).toMatchObject({ title: 'Restored from a saved state', message: 'Playback is paused.' });
  });

  it('a 2D view outside its range is presented by its figure, a 3D view by the banner', () => {
    const clipped = fixtureProjection('quadratic', 'clipped');
    expect(presentStatus(clipped)).toMatchObject({ cause: 'clipped', placement: 'inline' });
    expect(render(clipped)).not.toContain('class="ema-banner"');
    const spatial = fixtureProjection('spatial', 'clipped');
    expect(presentStatus(spatial)).toMatchObject({ cause: 'clipped', placement: 'banner' });
  });
});

describe('placeholder before a binding exists (G45)', () => {
  it('renders the card frame in preparing and empty with the runtime status text', () => {
    const preparing = renderToString(createElement(StudyActivityPlaceholder, { state: 'preparing', title: 'Step size in gradient descent', theme: 'light' }));
    expect(preparing).toContain('data-ema-ui-state="preparing"');
    expect(preparing).toContain('class="ema-card"');
    expect(preparing).toContain('aria-busy="true"');
    expect(preparing).toContain('>Step size in gradient descent</h2>');
    expect(preparing).toContain('Preparing the activity…');
    expect(preparing).toContain('role="status"');
    const empty = renderToString(createElement(StudyActivityPlaceholder, { state: 'empty' })).replace(/<!-- -->/g, '');
    expect(empty).toContain('data-ema-ui-state="empty"');
    expect(empty).toContain(UI_STATUS.empty.message!.replace(/\.$/, ''));
  });
});

/** Every UI state is covered above. */
it('covers every UI state', () => { expect([...UI_STATES].sort()).toEqual((Object.keys(UI_STATUS) as UiState[]).sort()); });
