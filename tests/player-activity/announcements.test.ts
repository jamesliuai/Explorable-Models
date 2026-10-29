/**
 * The learner card's announcement policy and live-region scope, on projections the real activity controller produces
 * (report §6.2 live regions follow the projection, §6.4 independent work, §9 step 5 cancel restores the committed frame,
 * §11 announce committed changes at a controlled rate, §9/§10.4 bounded recovery; A21, A25; review findings R18, R27, R28,
 * R41). These are the pure rules `StudyActivitySurface` applies (`projectionAnnouncements`, `failureAnnouncement`,
 * `liveScope`/`scopeHolds`, `Announcer.clear`); the mounted card is covered by tests/browser/study-interaction.spec.ts.
 * Fixture-host results with in-process test workers.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { CommandOutcome, HostPolicy, LearnerProjection } from '../../packages/activity/src/index';
import { WORKER_RECOVERY_ATTEMPTS } from '../../packages/activity/src/controller';
import { createAnnouncer, failureAnnouncement, liveScope, projectionAnnouncements, scopeHolds, type AnnouncementMemory } from '../../packages/player/src/activity/runtime';
import { authorizeExploration, codesOf, enterExplore, guards, harness, okOf, op, open, settled, until, type Harness } from '../activity/support/adapter-harness';

let current: Harness | null = null;
afterEach(() => { current?.adapter.dispose(); current = null; });

/** Feeds projections in order, as the surface's announcement effect does, and returns what each one announced. */
function announcer() {
  const memory: AnnouncementMemory = { committedFrameId: null };
  let before: LearnerProjection | null = null;
  return (projection: LearnerProjection): string[] => {
    const out = projectionAnnouncements(before, projection, memory, 'en').map(item => item.text);
    before = projection;
    return out;
  };
}
const independentPolicy = (h: Harness): HostPolicy => h.host.amendPolicy({ independentTask: { active: true, taskRef: 'task-new-curvature', permittedTools: ['inspect.learner'], neutralScaffold: ['landscape', 'start'] } });

describe('a preview that ends without a commit announces nothing (R27, report §9 step 5, §11)', () => {
  it('Escape after a keyboard preview returns to the same committed frame silently; a committed preview is announced once', async () => {
    current = harness();
    const h = current;
    const opened = await open(h);
    await enterExplore(h, opened);
    await authorizeExploration(h, opened);
    const feed = announcer();
    const committed = opened.learner.getProjection();
    feed(committed);
    const begun = okOf(opened.learner.beginPreview({ operationId: op(), ...guards(opened.learner), gesture: 'keyboard', parameter: 'eta' }));
    const previewId = begun.preview!.previewId;
    okOf(opened.learner.updatePreview({ operationId: op(), previewId, displayValues: { eta: 0.3 } }));
    await until(() => opened.learner.getProjection().frame?.kind === 'tentative');
    const tentative = opened.learner.getProjection();
    expect(tentative.status.ui).toBe('tentative-preview');
    expect(tentative.frame?.kind).toBe('tentative');
    expect(feed(tentative)).toEqual([]);
    okOf(opened.learner.cancelPreview({ operationId: op(), previewId, reason: 'escape' }));
    await settled(h);
    const cancelled = opened.learner.getProjection();
    expect(cancelled.frame).toMatchObject({ kind: 'committed', frameId: committed.frame!.frameId });
    expect(cancelled.controls.find(control => control.parameter === 'eta')!.value).toBe(committed.controls.find(control => control.parameter === 'eta')!.value);
    expect(feed(cancelled), 'nothing was committed').toEqual([]);

    // The same gesture committed is a committed change: announced once.
    const again = okOf(opened.learner.beginPreview({ operationId: op(), ...guards(opened.learner), gesture: 'keyboard', parameter: 'eta' }));
    okOf(opened.learner.updatePreview({ operationId: op(), previewId: again.preview!.previewId, displayValues: { eta: 0.3 } }));
    await until(() => opened.learner.getProjection().frame?.kind === 'tentative');
    feed(opened.learner.getProjection());
    okOf(await opened.learner.commitPreview({ operationId: op(), ...guards(opened.learner), previewId: again.preview!.previewId }));
    await settled(h);
    const applied = opened.learner.getProjection();
    expect(applied.frame!.frameId).not.toBe(committed.frame!.frameId);
    expect(feed(applied)).toEqual(['Updated: n = 0 of 1000.']);
  });
});

describe('closing a mounted activity is announced once (R28, embedding.md announcement policy)', () => {
  it('the host close announces the closed state; nothing repeats it', async () => {
    current = harness();
    const h = current;
    const opened = await open(h);
    await enterExplore(h, opened);
    const feed = announcer();
    feed(opened.learner.getProjection());
    okOf(await opened.control.close({ operationId: op('close'), reason: 'Lesson finished.' }) as never);
    await settled(h);
    const closed = opened.learner.getProjection();
    expect(closed.status).toMatchObject({ ui: 'empty', message: 'This activity is closed.' });
    expect(feed(closed)).toEqual(['This activity is closed.']);
    expect(feed(closed)).toEqual([]);
  });
});

describe('the live region follows the projection (R41, report §6.2, §6.4; A21, A25)', () => {
  async function readOut() {
    current = harness();
    const h = current;
    const opened = await open(h);
    await enterExplore(h, opened);
    okOf(await opened.learner.navigate({ operationId: op(), ...guards(opened.learner), position: { kind: 'index', index: 3 } }));
    await settled(h);
    const instructional = opened.learner.getProjection();
    return { h, opened, instructional, scope: liveScope(instructional), text: opened.learner.describeCurrentValues() };
  }

  it('entering independent work ends the scope of everything said before it; the independent card says so', async () => {
    const { h, opened, instructional, scope, text } = await readOut();
    const hiddenLater = ['Iteration', 'Update multiplier', 'Step size times curvature'];
    for (const label of hiddenLater) expect(text, label).toContain(`${label}:`);
    expect(scopeHolds(scope, liveScope(opened.learner.getProjection()))).toBe(true);
    const feed = announcer();
    feed(instructional);
    okOf(await opened.control.enterIndependentTask({ operationId: op(), taskRef: 'task-new-curvature', policy: independentPolicy(h) }));
    await settled(h);
    const independent = opened.learner.getProjection();
    expect(independent.context).toBe('independent');
    expect(scopeHolds(scope, liveScope(independent)), 'instructional read-out may not stay').toBe(false);
    const said = feed(independent);
    expect(said.length).toBeGreaterThan(0);
    for (const line of said) for (const label of hiddenLater) expect(line, label).not.toContain(label);
    // What the independent card itself reads out stays in its own scope.
    expect(scopeHolds(liveScope(independent), liveScope(opened.learner.getProjection()))).toBe(true);
  });

  it('closing, a stage change and a narrower policy end the scope; a reveal that only adds content keeps it', async () => {
    const { opened, scope } = await readOut();
    const narrowed = { ...opened.learner.getProjection() };
    const firstValue = narrowed.views.find(view => view.values.length)!;
    const lessShown = { ...narrowed, views: narrowed.views.map(view => view === firstValue ? { ...view, values: view.values.slice(1) } : view) } as LearnerProjection;
    expect(scopeHolds(scope, liveScope(lessShown)), 'a value left the projection').toBe(false);
    const moreShown = { ...narrowed, views: [...narrowed.views, { ...firstValue, viewId: 'added-view', values: [] }] } as LearnerProjection;
    expect(scopeHolds(scope, liveScope(moreShown)), 'content was only added').toBe(true);
    expect(scopeHolds(scope, liveScope({ ...narrowed, stage: { ...narrowed.stage, id: 'explain' } }))).toBe(false);
    expect(scopeHolds(scope, liveScope({ ...narrowed, policyRevision: narrowed.policyRevision + 1 }))).toBe(false);
    okOf(await opened.control.close({ operationId: op('close'), reason: 'Lesson finished.' }) as never);
    await settled(current!);
    expect(scopeHolds(scope, liveScope(opened.learner.getProjection())), 'closed').toBe(false);
  });

  it('clearing the announcer drops what is still queued and lets the same words be spoken again', () => {
    const spoken: string[] = [];
    let now = 0;
    const timers: (() => void)[] = [];
    const queue = createAnnouncer({ emit: text => spoken.push(text), now: () => now, setTimer: fn => { timers.push(fn); return timers.length; }, clearTimer: () => { timers.length = 0; } });
    queue.announce('Position: 0.5.', 'committed');
    queue.announce('Loss: 0.25.', 'committed');
    expect(spoken).toEqual(['Position: 0.5.']);
    queue.clear();
    now = 5_000;
    for (const timer of timers.splice(0)) timer();
    expect(spoken, 'the queued message was dropped').toEqual(['Position: 0.5.']);
    queue.announce('Position: 0.5.', 'committed');
    expect(spoken, 'the same words after a clear are spoken again').toEqual(['Position: 0.5.', 'Position: 0.5.']);
    queue.dispose();
  });
});

describe('exhausted worker recovery is announced with the action the card offers (R18, report §9 bounded recovery, §10.4, §11)', () => {
  /** A card whose next step crashed its worker: recoverable failure with Try again. */
  async function crashed() {
    current = harness();
    const h = current;
    const opened = await open(h);
    await enterExplore(h, opened);
    okOf(await opened.learner.navigate({ operationId: op(), ...guards(opened.learner), position: { kind: 'index', index: 2 } }));
    await settled(h);
    const memory: AnnouncementMemory = { committedFrameId: null, statusSaid: null };
    let before: LearnerProjection | null = null;
    /** The surface's announcement effect for the binding's current projection. */
    const feed = (): string[] => {
      const projection = opened.learner.getProjection();
      const out = projectionAnnouncements(before, projection, memory, 'en').map(item => item.text);
      before = projection;
      return out;
    };
    /** The surface's `fail` for a refused command (it reads the binding's projection, which the refusal already updated). */
    const refused = (outcome: CommandOutcome): string => {
      expect(outcome.ok).toBe(false);
      return failureAnnouncement((outcome as Extract<CommandOutcome, { ok: false }>).diagnostics[0]!, opened.learner.getProjection(), memory);
    };
    feed();
    h.workers.hostility = 'crash';
    const step = await opened.learner.step({ operationId: op(), ...guards(opened.learner), delta: 1 });
    expect(codesOf(step)).toEqual(['WORKER_ERROR']);
    return { h, opened, feed, refused, step };
  }
  const RETRY_LINE = 'Not applied. The calculation did not complete. The previous result is still shown. Try again.';
  const RELOAD_STATUS = 'The last step did not complete. The previous result is still shown. Trying again did not restore the calculation. Reload the activity.';

  it('the refusal that uses up the retries says Reload the activity once (the refusal settles before its projection is shown); nothing after it says Try again', async () => {
    const { opened, feed, refused, step } = await crashed();
    const said: string[] = [refused(step), ...feed()];
    expect(said).toEqual([RETRY_LINE, 'The last step did not complete. The previous result is still shown.']);
    for (let attempt = 1; attempt <= WORKER_RECOVERY_ATTEMPTS; attempt++) {
      const outcome = await opened.learner.retryPersistence({ operationId: op('retry') });
      expect(codesOf(outcome)).toEqual(['WORKER_ERROR']);
      const line = refused(outcome);
      const after = feed();
      if (attempt < WORKER_RECOVERY_ATTEMPTS) { expect(line).toBe(RETRY_LINE); expect(after).toEqual([]); continue; }
      expect(opened.learner.getProjection().status).toMatchObject({ ui: 'recoverable-failure', recovery: { action: 'reload', label: 'Reload the activity' } });
      expect(line).toBe('Not applied. The calculation did not complete. The previous result is still shown. Trying again did not restore the calculation. Reload the activity.');
      expect(after, 'the exhausted status was already put into words by the refusal').toEqual([]);
    }
    // A later refusal of the same cause (the worker fails again on the next step) names the offered action, not Try again.
    const again = await opened.learner.step({ operationId: op(), ...guards(opened.learner), delta: 1 });
    expect(codesOf(again)).toEqual(['WORKER_ERROR']);
    expect(opened.learner.getProjection().status.recovery).toMatchObject({ action: 'reload' });
    const line = refused(again);
    expect(line).toBe('Not applied. The calculation did not complete. The previous result is still shown. Reload the activity.');
    expect(line).not.toContain('Try again');
    expect(feed()).toEqual([]);
    // A refusal whose cause the status does not present keeps its own recovery.
    expect(failureAnnouncement({ code: 'OUT_OF_DOMAIN', message: 'That value is outside the allowed range.', recovery: 'Choose a value within the stated range.' }, opened.learner.getProjection()))
      .toBe('Not applied. That value is outside the allowed range. Choose a value within the stated range.');
  });

  it('when the exhausted projection is shown first (or another actor used up the retries) it is announced with Reload the activity, and a refusal after it adds only its own cause and the action', async () => {
    const { opened, feed, refused, step } = await crashed();
    refused(step);
    feed();
    const outcomes: CommandOutcome[] = [];
    for (let attempt = 1; attempt <= WORKER_RECOVERY_ATTEMPTS; attempt++) outcomes.push(await opened.learner.retryPersistence({ operationId: op('retry') }));
    expect(feed()).toEqual([RELOAD_STATUS]);
    expect(feed(), 'said once').toEqual([]);
    expect(refused(outcomes.at(-1)!)).toBe('Not applied. The calculation did not complete. The previous result is still shown. Reload the activity.');
  });
});
