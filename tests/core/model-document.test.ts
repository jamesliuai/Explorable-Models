import { afterEach, describe, expect, it } from 'vitest';
import {
  createModelSession, enableDocumentExecution, ModelError, seriesToPolyline, validateManifest,
  type GeometryResult, type ModelGuard, type ModelSession,
} from '../../packages/core/src/model/index';
import { allKernels, dropManifest, gapManifest } from './support/model-fixtures';
import { inlineWorkers, ManualScheduler, until } from './support/inline-worker';

// Document executions are opt-in (tests/core/document-execution.test.ts covers the default); the inline workers share this realm.
enableDocumentExecution();

const sessions: ModelSession[] = [];
afterEach(() => { for (const session of sessions.splice(0)) session.dispose(); });
let operation = 0;
const guard = (session: ModelSession): ModelGuard => ({ sessionId: session.id, expectedVersion: session.getState().version, expectedRunId: session.getState().run?.id ?? null, operationId: `d-${++operation}` });
function setup() {
  const scheduler = new ManualScheduler();
  const session = createModelSession({ workerFactory: inlineWorkers(allKernels).factory, scheduler });
  sessions.push(session);
  return { session, scheduler };
}
async function rejection(promise: Promise<unknown>): Promise<ModelError> {
  try { await promise; } catch (error) { expect(error).toBeInstanceOf(ModelError); return error as ModelError; }
  throw new Error('Expected a ModelError.');
}
type Polyline = Extract<GeometryResult, { kind: 'polyline2' }>;
const quantity = (session: ModelSession, id: string) => session.getState().frame!.quantities[id];

describe('document executions: analytical time (§8.4, A12)', () => {
  it('starts at time zero and ends exactly at the analytical end time', async () => {
    const { session } = setup();
    const loaded = await session.load(dropManifest(), null, guard(session));
    expect(loaded.frame!.position).toEqual({ kind: 'time', time: 0, endTime: 2 });
    expect(loaded.frame!.terminal).toEqual({ reached: false });
    expect(quantity(session, 'flight')).toEqual({ status: 'valid', value: 2 });
    expect(quantity(session, 'height')).toEqual({ status: 'valid', value: 20 });
    await session.navigate({ kind: 'time', time: 1 }, guard(session));
    expect(quantity(session, 'height')).toEqual({ status: 'valid', value: 15 });
    const end = await session.navigate({ kind: 'time', time: 5 }, guard(session));
    expect(end.frame!.position).toEqual({ kind: 'time', time: 2, endTime: 2 });
    expect(end.frame!.terminal).toEqual({ reached: true, event: 'end-time' });
    expect(quantity(session, 'height')).toEqual({ status: 'valid', value: 0 });
    expect(end.run!.id).toBe(loaded.run!.id);
    expect((await rejection(session.navigate({ kind: 'time', time: -0.1 }, guard(session)))).code).toBe('OUT_OF_DOMAIN');
    expect((await rejection(session.navigate({ kind: 'index', index: 1 }, guard(session)))).code).toBe('INVALID_INPUT');
    const fall = end.frame!.geometry.fall as Polyline;
    expect(fall.segments).toHaveLength(1);
    expect(fall.gaps).toEqual([]);
    expect(fall.sampling).toEqual({ samples: 51, domain: [0, 1] });
    expect(fall.segments[0].points[0]).toEqual([0, 20]);
    expect(fall.segments[0].points.at(-1)).toEqual([2, 0]);
  });

  it('plays to the exact end and restarts at time zero on commit', async () => {
    const { session, scheduler } = setup();
    await session.load(dropManifest(), null, guard(session));
    session.play(guard(session));
    const times: number[] = [];
    while (session.getState().playing) {
      const before = session.getState();
      scheduler.runNext();
      await until(() => session.getState() !== before);
      times.push((session.getState().frame!.position as { time: number }).time);
    }
    expect(times).toEqual([0.5, 1, 1.5, 2]);
    expect(session.getState().frame!.terminal).toEqual({ reached: true, event: 'end-time' });
    const committed = await session.commitParameters({ h: 45, g: 10 }, guard(session));
    expect(committed.frame!.position).toEqual({ kind: 'time', time: 0, endTime: 3 });
    expect(committed.run!.cause).toBe('commit');
  });

  it('restores only times inside the run domain', async () => {
    const { session } = setup();
    await session.load(dropManifest(), null, guard(session));
    const restored = await session.restore({ params: { h: 20, g: 10 }, position: { kind: 'time', time: 1.5 }, restoredFrom: 'saved-run' }, guard(session));
    expect(restored.run).toMatchObject({ cause: 'restore', restoredFrom: 'saved-run', position: { kind: 'time', time: 1.5, endTime: 2 } });
    expect((await rejection(session.restore({ params: { h: 20, g: 10 }, position: { kind: 'time', time: 3 }, restoredFrom: 'saved-run' }, guard(session)))).code).toBe('OUT_OF_DOMAIN');
  });
});

describe('document executions: missing samples (§8.5, A11, A13)', () => {
  it('splits undefined samples into separate segments with a reasoned gap and never connects across it', async () => {
    const { session } = setup();
    const state = await session.load(gapManifest(), null, guard(session));
    expect(state.frame!.position).toEqual({ kind: 'static' });
    expect(quantity(session, 'width')).toEqual({ status: 'valid', value: 1 });
    expect(quantity(session, 'inverse')).toEqual({ status: 'undefined', code: 'UNDEFINED', reason: 'Division by zero.' });
    const curve = state.frame!.geometry.curve as Polyline;
    expect(curve.segments).toHaveLength(2);
    expect(curve.segments.map(segment => segment.points.length)).toEqual([6, 6]);
    expect(curve.gaps).toEqual([{ after: 0, before: 1, reason: 'Square root requires a nonnegative argument.' }]);
    expect(curve.segments[0].points.at(-1)).toEqual([-0.5, 0]);
    expect(curve.segments[1].points[0]).toEqual([0.5, 0]);
    // No drawn point lies inside the undefined interval, and no zero was invented for a missing sample.
    for (const segment of curve.segments) for (const [x] of segment.points) expect(Math.abs(x)).toBeGreaterThanOrEqual(0.5);
    expect(curve.segments.flatMap(segment => segment.points)).toHaveLength(12);
    expect((await rejection(session.navigate({ kind: 'static' }, guard(session)))).code).toBe('UNSUPPORTED_CAPABILITY');
    const narrower = await session.commitParameters({ c: 0.2 }, guard(session));
    expect(narrower.frame!.quantities.inverse).toEqual({ status: 'valid', value: 1 / (0.2 - 0.5) });
    const next = narrower.frame!.geometry.curve as Polyline;
    expect(next.segments).toHaveLength(2);
    expect(next.gaps).toHaveLength(1);
  });

  it('places gaps at either end and handles fully undefined series', () => {
    const point = (x: number | null, y: number | null, reason?: string) => ({ x, y, ...(reason && { reason }) });
    expect(seriesToPolyline([point(0, null, 'a'), point(1, 1), point(2, 2), point(3, null, 'b')])).toEqual({
      kind: 'polyline2', segments: [{ points: [[1, 1], [2, 2]], start: 'none', end: 'none' }],
      gaps: [{ after: null, before: 0, reason: 'a' }, { after: 0, before: null, reason: 'b' }],
    });
    expect(seriesToPolyline([point(null, null, 'all'), point(null, null, 'all')])).toEqual({ kind: 'polyline2', segments: [], gaps: [{ after: null, before: null, reason: 'all' }] });
    // A discontinuity crossing keeps its x but has no y: the line breaks there.
    const broken = seriesToPolyline([point(-1, -1), point(-0.5, -2), point(0.5, null, 'Sample interval crosses a known division or tangent discontinuity.'), point(1, 1)]);
    expect(broken.segments.map(segment => segment.points)).toEqual([[[-1, -1], [-0.5, -2]], [[1, 1]]]);
    expect(broken.gaps).toEqual([{ after: 0, before: 1, reason: 'Sample interval crosses a known division or tangent discontinuity.' }]);
  });

  it('validates the wrapped document once and evaluates it only in the worker path', () => {
    const { manifest } = validateManifest(dropManifest());
    expect(manifest.execution.kind).toBe('document');
    expect(Object.isFrozen((manifest.execution as { document: object }).document)).toBe(true);
  });
});
