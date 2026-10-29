/**
 * Live preview authorization is checked for the whole gesture, not only when it starts (report §6.3, §9; activity-runtime
 * §4 exploration, §11 gestures the host ends; A24, A39, A40): a preview cannot start while a host authorization is in
 * flight, and a stage, context, policy or grant change that takes its authorization away ends it — journaled
 * `preview.cancelled`, nothing committed, no tentative frame projected afterwards. Fixture-host results with in-process
 * test workers.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { InteractionEvent, LearnerProjection } from '@experiment-kit/activity';
import {
  ackCurrent, activityGuard, authorizeExploration, codesOf, enterExplore, guards, harness, okOf, op, open, policyFor, requestFor, settled, template, type Harness, type Opened,
} from './support/adapter-harness.js';

let current: Harness | null = null;
const make = (...args: Parameters<typeof harness>) => (current = harness(...args));
afterEach(() => { current?.adapter.dispose(); current = null; });

const after = (events: InteractionEvent[], type: string) => events.slice(events.findIndex(event => event.type === type) + 1);
const committedEta = (h: Harness): number[] => h.host.events().filter(event => event.type === 'parameters.committed').map(event => (event.payload.params as Record<string, number>).eta!);
const waitFor = async (check: () => boolean): Promise<void> => { for (let i = 0; i < 500 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 2)); expect(check()).toBe(true); };
/** Every projection published to the learner surface from now on. */
function record(opened: Opened): LearnerProjection[] {
  const seen: LearnerProjection[] = [];
  opened.learner.subscribe(projection => { seen.push(projection); });
  return seen;
}

async function previewing(h: Harness, opened: Opened, eta: number): Promise<string> {
  const previewId = okOf(opened.learner.beginPreview({ operationId: op('pv'), ...guards(opened.learner), parameter: 'eta', gesture: 'keyboard' })).preview!.previewId;
  okOf(opened.learner.updatePreview({ operationId: op('pu'), previewId, displayValues: { eta } }));
  await waitFor(() => opened.learner.getProjection().frame?.kind === 'tentative');
  return previewId;
}

describe('preview authorization across host steps (A24, A40; R09)', () => {
  it('refuses to start a preview while a stage transition awaits the host; nothing is committed in the next stage', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    await authorizeExploration(h, opened, { eta: [0, 2] });
    h.host.hold('requestStageTransition');
    const transition = opened.control.requestStageTransition({ operationId: op('stage'), ...activityGuard(opened.learner), toStage: 'explain' });
    await waitFor(() => h.host.waiting('requestStageTransition') === 1);
    expect(codesOf(opened.learner.beginPreview({ operationId: op('pv'), ...guards(opened.learner), parameter: 'eta', gesture: 'keyboard' }))).toEqual(['PERSISTENCE_PENDING']);
    await h.host.release('requestStageTransition');
    okOf(await transition);
    await settled(h);
    const projection = opened.learner.getProjection();
    expect(projection).toMatchObject({ stage: { id: 'explain' }, preview: null, frame: { kind: 'committed' } });
    expect(projection.controls.find(control => control.parameter === 'eta')).toMatchObject({ mode: 'fixed', value: 0.25 });
    expect(projection.controls.find(control => control.parameter === 'eta')).not.toHaveProperty('previewValue');
    expect(after(h.host.events(), 'stage.changed').map(event => event.type)).not.toContain('parameters.committed');
    expect(h.host.events().map(event => event.type)).not.toContain('preview.started');
  });

  it('ends a preview when a stage receipt is applied later (resumed after a failed host call): it commits nothing in the new stage', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    await authorizeExploration(h, opened, { eta: [0, 2] });
    h.host.failNext('requestStageTransition', 'throw');
    expect(codesOf(await opened.control.requestStageTransition({ operationId: op('stage'), ...activityGuard(opened.learner), toStage: 'explore-curvature' }))).toEqual(['PERSISTENCE_FAILED']);
    // The failed authorization is kept for a retry; a preview may start under the current stage's grant.
    const previewId = await previewing(h, opened, 1.8);
    const seen = record(opened);
    okOf(await opened.learner.retryPersistence({ operationId: op('retry') }));
    await settled(h);
    const projection = opened.learner.getProjection();
    expect(projection).toMatchObject({ stage: { id: 'explore-curvature' }, preview: null, frame: { kind: 'committed' } });
    // No projection of the new stage carried the old preview's tentative frame (the substituted rule is new there).
    expect(seen.filter(item => item.stage.id === 'explore-curvature' && item.frame?.kind === 'tentative')).toEqual([]);
    expect(h.host.events().find(event => event.type === 'preview.cancelled')!.payload).toEqual({ previewId, reason: 'navigation' });
    expect(codesOf(await opened.learner.commitPreview({ operationId: op('pc'), ...guards(opened.learner), previewId }))).toEqual(['NOT_FOUND']);
    expect(committedEta(h)).not.toContain(1.8);
  });

  it('ends a preview when a reveal makes a solution-bearing group visible that its exploration grant does not cover', async () => {
    const h = make();
    const opened = await open(h, requestFor({ stageId: 'free-explore' }));
    await settled(h);
    okOf(await opened.control.requestExplorationScope({ operationId: op('scope'), ...activityGuard(opened.learner), groups: ['step-control', 'trace', 'observations', 'substituted-rule'], parameterDomain: { eta: [0, 2] } }));
    await settled(h);
    const previewId = await previewing(h, opened, 0.3);
    const seen = record(opened);
    okOf(await opened.control.requestReveal({ operationId: op('reveal'), ...activityGuard(opened.learner), groups: ['regime'] }));
    await settled(h);
    expect(opened.learner.getProjection()).toMatchObject({ preview: null, frame: { kind: 'committed' } });
    // Regime values never appeared beside a tentative frame.
    expect(seen.filter(item => item.frame?.kind === 'tentative' && item.views.some(view => view.values.some(value => value.quantityId === 'regime')))).toEqual([]);
    expect(h.host.events().find(event => event.type === 'preview.cancelled')!.payload).toEqual({ previewId, reason: 'revoked' });
    expect(codesOf(opened.learner.updatePreview({ operationId: op('pu'), previewId, displayValues: { eta: 1.7 } }))).toEqual(['NOT_FOUND']);
    // A new preview needs a grant that covers the newly visible group.
    expect(codesOf(opened.learner.beginPreview({ operationId: op('pv'), ...guards(opened.learner), parameter: 'eta', gesture: 'keyboard' }))).toEqual(['POLICY_DENIED']);
  });

  it('ends a preview when a policy update makes a covered group visible again without the exploration grant covering it', async () => {
    const h = make();
    const opened = await open(h, requestFor({ stageId: 'free-explore' }));
    await settled(h);
    okOf(await opened.control.requestReveal({ operationId: op('reveal'), ...activityGuard(opened.learner), groups: ['regime'] }));
    await settled(h);
    ackCurrent(opened.learner);
    const allGroups = template.groups.map(group => group.id);
    okOf(await opened.control.updatePolicy({ operationId: op(), policy: h.host.amendPolicy({ visibleGroups: allGroups.filter(id => id !== 'regime') }) }));
    okOf(await opened.control.requestExplorationScope({ operationId: op('scope'), ...activityGuard(opened.learner), groups: ['step-control', 'trace', 'observations', 'substituted-rule'], parameterDomain: { eta: [0, 2] } }));
    await settled(h);
    const previewId = await previewing(h, opened, 0.3);
    // An unrelated policy change keeps an authorized preview.
    okOf(await opened.control.updatePolicy({ operationId: op(), policy: h.host.amendPolicy({ export: { ...h.host.policy().export, capture: true } }) }));
    expect(opened.learner.getProjection().preview?.previewId).toBe(previewId);
    okOf(await opened.control.updatePolicy({ operationId: op(), policy: h.host.amendPolicy({ visibleGroups: allGroups }) }));
    expect(opened.learner.getProjection()).toMatchObject({ preview: null, frame: { kind: 'committed' } });
    await settled(h);
    expect(h.host.events().find(event => event.type === 'preview.cancelled')!.payload).toEqual({ previewId, reason: 'navigation' });
  });

  it('ends a preview whose changed values belong to a control the policy fixed, and commits nothing', async () => {
    const h = make();
    const opened = await open(h, requestFor({ stageId: 'free-explore' }));
    await settled(h);
    okOf(await opened.control.requestExplorationScope({ operationId: op('scope'), ...activityGuard(opened.learner), groups: ['step-control', 'curvature-control', 'trace', 'observations', 'regime', 'substituted-rule'], parameterDomain: { eta: [0, 2], a: [0.5, 2] } }));
    await settled(h);
    const previewId = okOf(opened.learner.beginPreview({ operationId: op('pv'), ...guards(opened.learner), parameter: 'eta', gesture: 'keyboard' })).preview!.previewId;
    okOf(opened.learner.updatePreview({ operationId: op('pu'), previewId, displayValues: { eta: 0.5, a: 1.5 } }));
    await waitFor(() => opened.learner.getProjection().frame?.kind === 'tentative');
    okOf(await opened.control.updatePolicy({ operationId: op(), policy: h.host.amendPolicy({ permittedControls: ['eta', 'x0'] }) }));
    expect(opened.learner.getProjection().preview).toBeNull();
    expect(codesOf(await opened.learner.commitPreview({ operationId: op('pc'), ...guards(opened.learner), previewId }))).toEqual(['NOT_FOUND']);
    await settled(h);
    expect(h.host.events().filter(event => event.type === 'parameters.committed').map(event => event.payload.params)).not.toContainEqual(expect.objectContaining({ a: 1.5 }));
  });

  it('ends a preview when the policy is found expired by host time', async () => {
    const h = make({ policy: policyFor({ expiresAt: '2026-10-26T10:00:00.000Z' }) });
    const opened = await open(h, requestFor({ stageId: 'free-explore' }));
    await settled(h);
    okOf(await opened.control.requestExplorationScope({ operationId: op('scope'), ...activityGuard(opened.learner), groups: ['step-control', 'trace', 'observations', 'regime', 'substituted-rule'], parameterDomain: { eta: [0, 2] } }));
    await settled(h);
    const previewId = await previewing(h, opened, 0.4);
    h.host.advanceClock(3 * 3_600_000);
    // The later host time reaches the adapter with the save reply only (journal acknowledgements are held), so the
    // expiry is found by the next command's standing check rather than by an acknowledgement.
    h.host.hold('appendEvents');
    const saved = await opened.control.save({ operationId: op('save'), kind: 'backup' });
    expect(saved.ok).toBe(true);
    expect(opened.learner.getProjection().preview?.previewId).toBe(previewId);
    expect(codesOf(opened.learner.updatePreview({ operationId: op('pu'), previewId, displayValues: { eta: 0.6 } }))).toEqual(['POLICY_EXPIRED']);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(opened.learner.getProjection()).toMatchObject({ preview: null, status: { ui: 'stale-policy' } });
    await h.host.release('appendEvents');
    await settled(h);
    expect(h.host.events().find(event => event.type === 'preview.cancelled')!.payload).toEqual({ previewId, reason: 'revoked' });
  });
});

/**
 * R09 (closing preview): a preview whose commit is in flight — `commitPreview` sent, the worker still evaluating — is
 * covered by the same rule. A stage, context, policy or grant change that takes its authorization away aborts that commit
 * (the session refuses it), so `parameters.committed` never follows `preview.cancelled` or lands in the new stage or
 * context, and no tentative frame is projected beside a group the grant does not cover. A commit the session applied
 * before the change is journaled before it. Worker replies are held (or slowed) to open the window deterministically.
 */
describe('a preview commit in flight across host steps (A24, A25; R09)', () => {
  type Event = InteractionEvent;
  const previewCommits = (h: Harness, previewId: string): Event[] => h.host.events().filter(event => event.type === 'parameters.committed' && event.payload.previewId === previewId);
  /** Sends commitPreview with the worker's reply held; resolves once the commit's evaluation is waiting (not settled). */
  const holdCommit = async (h: Harness, opened: Opened, previewId: string) => {
    h.workers.hold = true;
    const committing = opened.learner.commitPreview({ operationId: op('pc'), ...guards(opened.learner), previewId });
    await waitFor(() => h.workers.held.length > 0);
    return { committing };
  };
  const release = (h: Harness) => { h.workers.hold = false; h.workers.flush(); };
  afterEach(() => { if (current) { current.workers.hold = false; current.workers.delayMs = 0; current.workers.flush(); } });

  it('a stage transition while the commit evaluates aborts it: nothing is committed in the next stage', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    await authorizeExploration(h, opened, { eta: [0, 2] });
    const previewId = await previewing(h, opened, 1.7);
    const { committing } = await holdCommit(h, opened, previewId);
    okOf(await opened.control.requestStageTransition({ operationId: op('stage'), ...activityGuard(opened.learner), toStage: 'explain' }));
    release(h);
    const outcome = await committing;
    expect(codesOf(outcome)).toEqual(['POLICY_DENIED']);
    await settled(h);
    const projection = opened.learner.getProjection();
    expect(projection).toMatchObject({ stage: { id: 'explain' }, preview: null, frame: { kind: 'committed' } });
    expect(projection.controls.find(control => control.parameter === 'eta')).toMatchObject({ mode: 'fixed', value: 0.25 });
    expect(previewCommits(h, previewId)).toEqual([]);
    expect(committedEta(h)).not.toContain(1.7);
    expect(h.host.events().find(event => event.type === 'preview.cancelled')!.payload).toEqual({ previewId, reason: 'navigation' });
    expect(after(h.host.events(), 'preview.cancelled').map(event => event.type)).not.toContain('parameters.committed');
    // The commitPreview operation keeps its refusal; the preview is gone.
    expect(codesOf(await opened.learner.commitPreview({ operationId: op('pc'), ...guards(opened.learner), previewId }))).toEqual(['NOT_FOUND']);
    expect(opened.learner.getProjection().status.ui).not.toBe('recoverable-failure');
  });

  it('entering an independent task while the commit evaluates aborts it: nothing is committed in the independent context', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    await authorizeExploration(h, opened, { eta: [0, 2] });
    const previewId = await previewing(h, opened, 1.7);
    const { committing } = await holdCommit(h, opened, previewId);
    const policy = h.host.amendPolicy({ independentTask: { active: true, taskRef: 'task-x', permittedTools: ['inspect.learner'], neutralScaffold: ['landscape', 'start'] } });
    okOf(await opened.control.enterIndependentTask({ operationId: op('independent'), taskRef: 'task-x', policy }));
    release(h);
    expect(codesOf(await committing)).toEqual(['POLICY_DENIED']);
    await settled(h);
    expect(opened.learner.getProjection()).toMatchObject({ context: 'independent', preview: null });
    expect(previewCommits(h, previewId)).toEqual([]);
    expect(after(h.host.events(), 'context.independent-entered').map(event => event.type)).not.toContain('parameters.committed');
    expect(h.host.events().find(event => event.type === 'preview.cancelled')!.payload).toEqual({ previewId, reason: 'navigation' });
  });

  it('a reveal the exploration grant does not cover, applied while the commit evaluates, ends the preview: no tentative frame shows the group, nothing is committed', async () => {
    const h = make();
    const opened = await open(h, requestFor({ stageId: 'free-explore' }));
    await settled(h);
    okOf(await opened.control.requestExplorationScope({ operationId: op('scope'), ...activityGuard(opened.learner), groups: ['step-control', 'trace', 'observations', 'substituted-rule'], parameterDomain: { eta: [0, 2] } }));
    await settled(h);
    const previewId = await previewing(h, opened, 1.7);
    const seen = record(opened);
    const { committing } = await holdCommit(h, opened, previewId);
    okOf(await opened.control.requestReveal({ operationId: op('reveal'), ...activityGuard(opened.learner), groups: ['regime'] }));
    expect(opened.learner.getProjection()).toMatchObject({ preview: null, frame: { kind: 'committed' } });
    release(h);
    expect(codesOf(await committing)).toEqual(['POLICY_DENIED']);
    await settled(h);
    expect(seen.filter(item => item.frame?.kind === 'tentative' && item.views.some(view => view.values.some(value => value.quantityId === 'regime')))).toEqual([]);
    expect(previewCommits(h, previewId)).toEqual([]);
    expect(committedEta(h)).not.toContain(1.7);
    expect(h.host.events().find(event => event.type === 'preview.cancelled')!.payload).toEqual({ previewId, reason: 'revoked' });
  });

  it('with a slow worker (no held replies) a stage transition sent right after the commit never lets it land in the next stage', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    await authorizeExploration(h, opened, { eta: [0, 2] });
    const previewId = await previewing(h, opened, 1.7);
    h.workers.delayMs = 50;
    const committing = opened.learner.commitPreview({ operationId: op('pc'), ...guards(opened.learner), previewId });
    okOf(await opened.control.requestStageTransition({ operationId: op('stage'), ...activityGuard(opened.learner), toStage: 'explain' }));
    const outcome = await committing;
    await settled(h);
    h.workers.delayMs = 0;
    const types = h.host.events().map(event => event.type);
    const committedAt = h.host.events().findIndex(event => event.type === 'parameters.committed' && event.payload.previewId === previewId);
    // Either the commit landed before the transition (journaled before it, preview ended committed) or it never landed.
    if (committedAt >= 0) {
      expect(outcome.ok).toBe(true);
      expect(committedAt).toBeLessThan(types.indexOf('stage.changed'));
      expect(types).not.toContain('preview.cancelled');
    } else {
      expect(codesOf(outcome)).toEqual(['POLICY_DENIED']);
      expect(opened.learner.getProjection().controls.find(control => control.parameter === 'eta')).toMatchObject({ mode: 'fixed', value: 0.25 });
    }
    expect(after(h.host.events(), 'stage.changed').map(event => event.type)).not.toContain('parameters.committed');
    expect(opened.learner.getProjection().stage.id).toBe('explain');
  });

  it('a second commitPreview of the same preview while the first is in flight is refused; the first commits once', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    await authorizeExploration(h, opened, { eta: [0, 2] });
    const previewId = await previewing(h, opened, 1.2);
    const { committing } = await holdCommit(h, opened, previewId);
    expect(codesOf(await opened.learner.commitPreview({ operationId: op('pc'), ...guards(opened.learner), previewId }))).toEqual(['CONFLICT']);
    release(h);
    expect((await committing).ok).toBe(true);
    await settled(h);
    expect(previewCommits(h, previewId)).toHaveLength(1);
    expect(opened.learner.getProjection().controls.find(control => control.parameter === 'eta')).toMatchObject({ value: 1.2 });
  });

  it('a commit the session applied before a host change is journaled before that change, and its preview ends committed', async () => {
    const h = make();
    const opened = await open(h, requestFor({ stageId: 'free-explore' }));
    await settled(h);
    okOf(await opened.control.requestExplorationScope({ operationId: op('scope'), ...activityGuard(opened.learner), groups: ['step-control', 'trace', 'observations', 'regime', 'substituted-rule'], parameterDomain: { eta: [0, 2] } }));
    await settled(h);
    const previewId = await previewing(h, opened, 0.4);
    const { committing } = await holdCommit(h, opened, previewId);
    // The session has applied the commit (its committed frame is published) but the adapter has not resumed yet: a
    // policy update applied in that window (synchronously, from the learner listener) fixes the step-size control.
    let changed: ReturnType<typeof opened.control.updatePolicy> | null = null;
    const unsubscribe = opened.learner.subscribe(projection => {
      if (changed || projection.frame?.kind !== 'committed' || projection.controls.find(control => control.parameter === 'eta')?.value !== 0.4) return;
      changed = opened.control.updatePolicy({ operationId: op('policy'), policy: h.host.amendPolicy({ permittedControls: ['x0'] }) });
    });
    release(h);
    expect((await committing).ok).toBe(true);
    expect(changed).not.toBeNull();
    okOf(await changed!);
    unsubscribe();
    await settled(h);
    const commits = previewCommits(h, previewId);
    expect(commits).toHaveLength(1);
    // Journaled under the policy it was applied under (the step size was still a shown control), once.
    expect(commits[0]!.payload.visibleParameters).toContain('eta');
    expect(h.host.events().filter(event => event.type === 'preview.cancelled')).toEqual([]);
    expect(h.host.events().filter(event => event.type === 'preview.observed').at(-1)!.payload).toMatchObject({ previewId, outcome: 'committed' });
    // The commit stands (it was applied before the change); the policy now leaves the step size out of the controls.
    expect((h.adapter.getState('act-quadratic-1', 'host') as unknown as { scientific: { params: Record<string, number> } }).scientific.params.eta).toBe(0.4);
    expect(opened.learner.getProjection().controls.map(control => control.parameter)).not.toContain('eta');
  });
});
