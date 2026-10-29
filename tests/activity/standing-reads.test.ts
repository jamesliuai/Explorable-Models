/**
 * Reads under a policy that no longer stands (report §5.3 "A stale policy or revoked activity must fail before revealing
 * or mutating content"; activity-runtime §1 expiry by host time; A55). A read that finds an expiry blocks the activity
 * like a command; policy-authorized audiences — teacher, tutor with full inspection, developer inspection — receive no
 * scientific state, exposures or teacher summaries from a blocked activity; the host audience still does, and the state
 * names why (`standing`). Fixture-host results with in-process test workers.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AudienceState } from '@explorable-models/activity';
import { codesOf, enterExplore, guards, harness, okOf, op, open, policyFor, settled, type Harness, type Opened } from './support/adapter-harness.js';

let current: Harness | null = null;
const make = (...args: Parameters<typeof harness>) => (current = harness(...args));
afterEach(() => { current?.adapter.dispose(); current = null; });

const ACTIVITY = 'act-quadratic-1';
const stateOf = (h: Harness, audience: AudienceState['audience']): AudienceState => {
  const state = h.adapter.getState(ACTIVITY, audience);
  if (!('activityId' in state)) throw new Error(JSON.stringify(state.diagnostics));
  return state;
};

async function expiringAtExplore(): Promise<{ h: Harness; opened: Opened }> {
  const h = make({ policy: policyFor({ expiresAt: '2026-10-26T10:00:00.000Z', inspection: { developer: true, tutor: 'full', teacher: true } }) });
  const opened = await open(h);
  await enterExplore(h, opened);
  return { h, opened };
}
/** Host time passes expiresAt and reaches the adapter with a save reply; journal acknowledgements are held. */
async function expire(h: Harness, opened: Opened): Promise<void> {
  h.host.advanceClock(3 * 3_600_000);
  h.host.hold('appendEvents');
  expect((await opened.control.save({ operationId: op('save'), kind: 'backup' })).ok).toBe(true);
}

describe('audience reads under an expired or revoked policy (R17)', () => {
  it('a teacher or full-inspection tutor read finds the expiry, blocks the activity and receives no scientific state or exposures', async () => {
    const { h, opened } = await expiringAtExplore();
    for (const audience of ['teacher', 'tutor', 'host'] as const) expect(stateOf(h, audience)).toMatchObject({ standing: null, scientific: expect.any(Object), exposures: expect.any(Array) });
    okOf(opened.learner.play({ operationId: op('play'), ...guards(opened.learner) }));
    await expire(h, opened);
    expect(opened.learner.getProjection().status.ui).not.toBe('stale-policy');
    const teacher = stateOf(h, 'teacher');
    expect(teacher.standing).toBe('POLICY_EXPIRED');
    expect(teacher).not.toHaveProperty('scientific');
    expect(teacher).not.toHaveProperty('exposures');
    expect(teacher.projection.status.ui).toBe('stale-policy');
    expect(teacher.projection.views).toEqual([]);
    expect(stateOf(h, 'tutor')).not.toHaveProperty('scientific');
    // The read ended playback, as an acknowledgement showing the expiry would.
    expect(opened.learner.getProjection().navigation).toBeNull();
    // The host audience keeps the full state and is told why the activity is blocked.
    expect(stateOf(h, 'host')).toMatchObject({ standing: 'POLICY_EXPIRED', scientific: expect.any(Object), exposures: expect.any(Array) });
    await h.host.release('appendEvents');
    await settled(h);
    expect(h.host.events().map(event => event.type)).toContain('playback.paused');
  });

  it('a teacher summary and developer inspection fail with POLICY_EXPIRED; host and learner summaries still answer', async () => {
    const { h, opened } = await expiringAtExplore();
    expect('ok' in h.adapter.summarizeInteraction(ACTIVITY, { audience: 'teacher' })).toBe(false);
    expect('ok' in h.adapter.inspectDeveloper(ACTIVITY)).toBe(false);
    await expire(h, opened);
    expect(codesOf(h.adapter.summarizeInteraction(ACTIVITY, { audience: 'teacher' }) as never)).toEqual(['POLICY_EXPIRED']);
    expect(codesOf(h.adapter.inspectDeveloper(ACTIVITY) as never)).toEqual(['POLICY_EXPIRED']);
    for (const audience of ['host', 'learner'] as const) expect(h.adapter.summarizeInteraction(ACTIVITY, { audience })).toMatchObject({ audience });
    await h.host.release('appendEvents');
  });

  it('a host revocation is the standing of every later read', async () => {
    const { h, opened } = await expiringAtExplore();
    okOf(await opened.control.revoke({ operationId: op('revoke'), reason: 'Withdrawn by the teacher.' }));
    expect(stateOf(h, 'teacher')).toMatchObject({ standing: 'POLICY_DENIED' });
    expect(stateOf(h, 'teacher')).not.toHaveProperty('scientific');
    expect(codesOf(h.adapter.summarizeInteraction(ACTIVITY, { audience: 'teacher' }) as never)).toEqual(['POLICY_DENIED']);
    expect(stateOf(h, 'host')).toMatchObject({ standing: 'POLICY_DENIED', scientific: expect.any(Object) });
  });
});
