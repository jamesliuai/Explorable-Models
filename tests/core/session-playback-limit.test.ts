/**
 * Playback across a numerical limit (report §6.2, §8.4; `ModelPlaybackOptions`). By default playback stops one position
 * before a frame at a numerical limit and play from such a frame is refused; a caller whose display does not show the
 * limit passes `throughNumericalLimit` so that playback runs on to the position's own end as for any other run, and a
 * frame at a limit is no end. The decision is asked again at every limit frame, so a limit that becomes shown stops
 * playback where it is.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createModelSession, ModelError, validateManifest, type ModelFrame, type ModelGuard, type ModelSession } from '../../packages/core/src/model/index';
import { allKernels, geometricManifest } from './support/model-fixtures';
import { inlineWorkers, ManualScheduler, until } from './support/inline-worker';

const { manifest } = validateManifest(geometricManifest());
/** a = 5, η = 0.5, x₀ = 10: the multiplier is −1.5 and |x_n| leaves the representable bound at n = 6 (maxIndex 12). */
const DIVERGING = { a: 5, eta: 0.5, x0: 10 };
const cleanup: { dispose(): void }[] = [];
afterEach(() => { for (const item of cleanup.splice(0)) item.dispose(); });
let operation = 0;
const guard = (session: ModelSession): ModelGuard => ({ sessionId: session.id, expectedVersion: session.getState().version, expectedRunId: session.getState().run?.id ?? null, operationId: `limit-op-${++operation}` });
function setup() {
  const scheduler = new ManualScheduler();
  const session = createModelSession({ workerFactory: inlineWorkers(allKernels).factory, scheduler });
  cleanup.push(session);
  return { session, scheduler };
}
async function tick(session: ModelSession, scheduler: ManualScheduler): Promise<void> {
  const before = session.getState();
  expect(scheduler.runNext()).toBe(true);
  await until(() => session.getState() !== before);
}
const index = (session: ModelSession) => (session.getState().frame!.position as { index: number }).index;
function refusal(action: () => unknown): ModelError {
  try { action(); } catch (error) { expect(error).toBeInstanceOf(ModelError); return error as ModelError; }
  throw new Error('Expected a ModelError.');
}

describe('playback across a numerical limit (ModelPlaybackOptions)', () => {
  it('crosses a limit the caller does not show and ends at the last index, asked once per limit frame', async () => {
    const { session, scheduler } = setup();
    await session.load(manifest, DIVERGING, guard(session));
    const asked: number[] = [];
    session.play(guard(session), { throughNumericalLimit: frame => { asked.push((frame.position as { index: number }).index); return true; } });
    for (let i = 1; i <= 12; i++) {
      await tick(session, scheduler);
      expect(index(session)).toBe(i);
      expect(session.getState()).toMatchObject({ stale: false, error: null });
    }
    expect(session.getState().playing).toBe(false);
    expect(scheduler.pending).toBe(0);
    // Every frame from n = 6 is at the limit; none of them stopped playback, which ended at the last index.
    expect(asked).toEqual([6, 7, 8, 9, 10, 11, 12]);
    expect(session.getState().frame!.terminal).toMatchObject({ reached: true, event: 'numerical-limit' });
    expect(session.getState().frame!.quantities.position).toMatchObject({ status: 'numerical-limit' });
  });

  it('plays from a frame at a crossed limit, and refuses play at the last index as for any run', async () => {
    const { session, scheduler } = setup();
    await session.load(manifest, DIVERGING, guard(session));
    await session.navigate({ kind: 'index', index: 8 }, guard(session));
    expect(session.getState().frame!.terminal).toMatchObject({ reached: true, event: 'numerical-limit' });
    // Default: a frame at a limit is an end.
    expect(refusal(() => session.play(guard(session))).code).toBe('OUT_OF_DOMAIN');
    expect(refusal(() => session.play(guard(session), { throughNumericalLimit: () => false })).code).toBe('OUT_OF_DOMAIN');
    // Crossed: playback starts there and runs to the end.
    session.play(guard(session), { throughNumericalLimit: () => true });
    expect(session.getState().playing).toBe(true);
    for (let i = 9; i <= 12; i++) { await tick(session, scheduler); expect(index(session)).toBe(i); }
    expect(session.getState().playing).toBe(false);
    expect(refusal(() => session.play(guard(session), { throughNumericalLimit: () => true })).code).toBe('OUT_OF_DOMAIN');
    // Each play decides afresh: a later play without options does not inherit the earlier decision.
    await session.navigate({ kind: 'index', index: 8 }, guard(session));
    expect(refusal(() => session.play(guard(session))).code).toBe('OUT_OF_DOMAIN');
    session.play(guard(session), { throughNumericalLimit: () => true });
    session.pause(guard(session));
    await session.navigate({ kind: 'index', index: 4 }, guard(session));
    session.play(guard(session));
    await tick(session, scheduler);
    await tick(session, scheduler);
    expect(session.getState()).toMatchObject({ playing: false, error: [expect.objectContaining({ code: 'NUMERICAL_LIMIT' })] });
    expect(index(session)).toBe(5);
  });

  it('stops where it is once the decision changes (a limit that became shown), and treats a throw or non-boolean as no', async () => {
    const { session, scheduler } = setup();
    await session.load(manifest, DIVERGING, guard(session));
    let shown = false;
    session.play(guard(session), { throughNumericalLimit: () => !shown });
    for (let i = 1; i <= 7; i++) await tick(session, scheduler);
    expect(index(session)).toBe(7);
    shown = true;
    await tick(session, scheduler);
    expect(session.getState()).toMatchObject({ playing: false, stale: false, error: [expect.objectContaining({ code: 'NUMERICAL_LIMIT' })] });
    expect(index(session)).toBe(7);
    expect(scheduler.pending).toBe(0);

    await session.navigate({ kind: 'index', index: 3 }, guard(session));
    session.play(guard(session), { throughNumericalLimit: () => { throw new Error('caller failure'); } });
    for (let i = 4; i <= 6; i++) await tick(session, scheduler);
    expect(session.getState()).toMatchObject({ playing: false, error: [expect.objectContaining({ code: 'NUMERICAL_LIMIT' })] });
    expect(index(session)).toBe(5);
    await session.navigate({ kind: 'index', index: 5 }, guard(session));
    session.play(guard(session), { throughNumericalLimit: (() => 'yes') as unknown as (frame: ModelFrame) => boolean });
    await tick(session, scheduler);
    expect(index(session)).toBe(5);
    expect(session.getState().playing).toBe(false);
  });

  it('leaves runs without a limit unchanged and rejects malformed options', async () => {
    const { session, scheduler } = setup();
    await session.load(manifest, null, guard(session));
    let asked = 0;
    session.play(guard(session), { throughNumericalLimit: () => { asked++; return true; } });
    for (let i = 1; i <= 12; i++) await tick(session, scheduler);
    expect(session.getState().frame!.terminal).toEqual({ reached: true, event: 'max-index' });
    expect(asked).toBe(0);
    await session.navigate({ kind: 'index', index: 0 }, guard(session));
    for (const options of [null, 3, { throughNumericalLimit: true }]) expect(refusal(() => session.play(guard(session), options as never)).code).toBe('INVALID_INPUT');
    expect(session.getState().playing).toBe(false);
  });
});
