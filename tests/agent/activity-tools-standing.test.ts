/**
 * Policy standing by host time on the tool path (report §5.3, §15.1; activity-runtime §1; docs/study-harness/agent-tools.md
 * §1 "checks the revision, standing, session, activity presence and operations"; A55). Expiry is judged by the adapter's
 * host clock — the latest host timestamp it has observed — not by the policy's own issue time, so read-only tools (full
 * inspection, summaries, template detail) end with the authorization exactly like commands and sampling. Fixture-host
 * results with in-process test workers.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { policyStanding } from '@experiment-kit/activity';
import { createActivityTools } from '@experiment-kit/agent';
import { guards, op, settled, until } from '../activity/support/adapter-harness.js';
import { ACTIVITY_ID, codesOf, dataOf, opId, prepareThroughTools, rig, type Rig } from './support/activity-tools.js';

const EXPIRES = '2026-10-26T10:00:00.000Z';
let current: Rig | null = null;
const make = (...args: Parameters<typeof rig>) => (current = rig(...args));
afterEach(() => { current?.h.adapter.dispose(); current = null; });

const READS = [
  ['activity_inspect (full)', 'activity_inspect', { view: 'full' }],
  ['activity_inspect (learner)', 'activity_inspect', {}],
  ['activity_summarize', 'activity_summarize', {}],
  ['activity_describe_template (full detail)', 'activity_describe_template', { templateId: 'quadratic-gradient-descent', version: '1.0.0' }],
  ['activity_discover', 'activity_discover', {}],
] as const;

async function teacherAtExplore(): Promise<Rig> {
  const r = make({ audience: 'teacher', policy: { expiresAt: EXPIRES, inspection: { developer: false, tutor: 'full', teacher: true } } });
  await prepareThroughTools(r, { stageId: 'explore-step' });
  for (const [, name, input] of READS) dataOf(await r.tools.execute(name, input));
  return r;
}

describe('agent tools judge policy expiry by host time (R17)', () => {
  it('refuses full inspection, summaries and template detail once a host reply shows the policy expired', async () => {
    const r = await teacherAtExplore();
    expect(dataOf(await r.tools.execute('activity_inspect', { view: 'full' })).state.scientific).toBeTruthy();
    r.h.host.advanceClock(3 * 3_600_000);
    // The later host time reaches the adapter with the save reply (activity-runtime §1: any host timestamp counts).
    const saved = await r.prepared().host.save({ operationId: op('save'), kind: 'backup' });
    expect(saved.ok).toBe(true);
    // The policy the tools read is the same revision 1 issued at 08:00: only host time shows it expired.
    expect(policyStanding(r.h.host.policy(), null)).toBeNull();
    expect(r.h.adapter.policyStanding(r.h.host.policy())).toMatchObject({ code: 'POLICY_EXPIRED' });
    for (const [label, name, input] of READS) expect(codesOf(await r.tools.execute(name, input)), label).toEqual(['POLICY_EXPIRED']);
    expect(codesOf(await r.tools.execute('activity_sample', { parameters: { a: 2, eta: 0.25, x0: 4 }, positions: [{ kind: 'index', index: 1 }] }))).toEqual(['POLICY_EXPIRED']);
    // The tools' own check blocked the activity, as a command would.
    expect(r.learner().getProjection().status.ui).toBe('stale-policy');
  });

  it('refuses them once a journal acknowledgement shows the policy expired', async () => {
    const r = await teacherAtExplore();
    r.h.host.advanceClock(3 * 3_600_000);
    const learner = r.learner();
    await learner.commitParameters({ operationId: op(), ...guards(learner), displayValues: { eta: 0.3 } });
    await settled(r.h);
    await until(() => learner.getProjection().status.ui === 'stale-policy');
    for (const [label, name, input] of READS) expect(codesOf(await r.tools.execute(name, input)), label).toEqual(['POLICY_EXPIRED']);
  });

  it('judges a policy by the adapter\'s host clock when no activity is open', async () => {
    const r = await teacherAtExplore();
    r.h.host.advanceClock(3 * 3_600_000);
    expect((await r.prepared().host.save({ operationId: op('save'), kind: 'backup' })).ok).toBe(true);
    r.h.adapter.dispose(ACTIVITY_ID);
    expect(codesOf(await r.tools.execute('activity_describe_template', { templateId: 'quadratic-gradient-descent', version: '1.0.0' }))).toEqual(['POLICY_EXPIRED']);
    expect(codesOf(await r.tools.execute('activity_prepare', { operationId: opId('prepare'), template: { templateId: 'quadratic-gradient-descent', version: '1.0.0' } }))).toEqual(['POLICY_EXPIRED']);
  });

  it('refuses every step after the host revoked the bound activity, although the policy source still returns the unrevoked policy', async () => {
    const r = await teacherAtExplore();
    expect((await r.prepared().host.revoke({ operationId: op('revoke'), reason: 'The teacher withdrew the activity.' })).ok).toBe(true);
    expect(r.h.host.policy().revoked).toBe(false);
    for (const [label, name, input] of READS.filter(([, name]) => name !== 'activity_discover')) expect(codesOf(await r.tools.execute(name, input)), label).toEqual(['POLICY_DENIED']);
  });

  it('keeps answering while the policy stands', async () => {
    const r = await teacherAtExplore();
    r.h.host.advanceClock(30 * 60_000);
    expect((await r.prepared().host.save({ operationId: op('save'), kind: 'backup' })).ok).toBe(true);
    expect(r.h.adapter.policyStanding(r.h.host.policy())).toBeNull();
    for (const [, name, input] of READS) dataOf(await r.tools.execute(name, input));
  });

  it('fails closed at construction for an adapter wrapper that does not forward policyStanding, naming the method', () => {
    const r = make();
    const { policyStanding: _dropped, ...wrapped } = r.h.adapter;
    expect(() => createActivityTools({ ...r.context, adapter: wrapped as never })).toThrow(/adapter\.policyStanding/);
    // A wrapper that forwards it works.
    expect(() => createActivityTools({ ...r.context, adapter: { ...wrapped, policyStanding: policy => r.h.adapter.policyStanding(policy) } })).not.toThrow();
  });
});
