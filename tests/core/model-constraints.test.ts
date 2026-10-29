import { afterEach, describe, expect, it } from 'vitest';
import {
  checkParameters, clampForPreview, createModelEvaluator, createModelSession, MULTIPLE_OF_RELATIVE_TOLERANCE, ModelError, validateManifest,
  type ModelGuard, type ModelManifest, type ModelSession,
} from '../../packages/core/src/model/index';
import { allKernels, geometricManifest, rectangleManifest } from './support/model-fixtures';
import { inlineWorkers } from './support/inline-worker';

const manifest = validateManifest(geometricManifest()).manifest;
const rectangle = validateManifest(rectangleManifest()).manifest;
const valid = { a: 2, eta: 0.25, x0: 4 };
const failure = async (promise: Promise<unknown> | (() => unknown)) => {
  try { await (typeof promise === 'function' ? promise() : promise); } catch (error) { expect(error).toBeInstanceOf(ModelError); return (error as ModelError).diagnostics; }
  throw new Error('Expected a ModelError.');
};

describe('individual parameter rules (report §8.2, A06)', () => {
  it('accepts exact admissible values', () => {
    expect(checkParameters(manifest, valid)).toEqual([]);
    expect(checkParameters(manifest, { a: 5, eta: 0.5, x0: -10 })).toEqual([]);
  });
  it('requires exact keys unless partial', () => {
    expect(checkParameters(manifest, { ...valid, zz: 1 })).toEqual([expect.objectContaining({ code: 'INVALID_INPUT', path: '$.parameters.zz' })]);
    expect(checkParameters(manifest, { a: 2, eta: 0.25 })).toEqual([expect.objectContaining({ code: 'INVALID_INPUT', path: '$.parameters.x0' })]);
    expect(checkParameters(manifest, { eta: 0.3 }, { partial: true })).toEqual([]);
    expect(checkParameters(manifest, null)[0]).toMatchObject({ code: 'INVALID_INPUT', path: '$.parameters' });
    expect(checkParameters(manifest, [1, 2, 3])[0].code).toBe('INVALID_INPUT');
    expect(checkParameters(manifest, new Map())[0].code).toBe('INVALID_INPUT');
  });
  it('rejects nonfinite and nonnumeric values without invoking accessors', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '0.3', null, undefined]) expect(checkParameters(manifest, { ...valid, eta: bad })).toEqual([expect.objectContaining({ code: 'INVALID_INPUT', path: '$.parameters.eta' })]);
    let touched = false;
    const getter = { a: 2, x0: 4 } as Record<string, unknown>;
    Object.defineProperty(getter, 'eta', { enumerable: true, get() { touched = true; return 0.25; } });
    expect(checkParameters(manifest, getter)[0].path).toBe('$.parameters.eta');
    expect(touched).toBe(false);
  });
  it('reports the domain with OUT_OF_DOMAIN and the parameter path', () => {
    const [problem] = checkParameters(manifest, { ...valid, x0: 11 });
    expect(problem).toMatchObject({ code: 'OUT_OF_DOMAIN', path: '$.parameters.x0' });
    expect(problem.message).toContain('-10 to 10 m');
    expect(checkParameters(manifest, { ...valid, eta: -0.0001 })[0].code).toBe('OUT_OF_DOMAIN');
  });
  it('enforces integer and multipleOf admissibility with a documented tolerance', () => {
    expect(checkParameters(manifest, { ...valid, x0: 1.5 })).toEqual([expect.objectContaining({ code: 'INVALID_INPUT', path: '$.parameters.x0', message: 'Expected a whole number.' })]);
    expect(checkParameters(manifest, { ...valid, a: 1.2 })[0]).toMatchObject({ code: 'INVALID_INPUT', path: '$.parameters.a' });
    expect(checkParameters(manifest, { ...valid, a: 1.5 })).toEqual([]);
    const tenths: ModelManifest = structuredClone(geometricManifest());
    tenths.parameters.eta.step.admissible = { multipleOf: 0.1 };
    tenths.parameters.eta.default = 0.2;
    const checked = validateManifest(tenths).manifest;
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(checkParameters(checked, { ...valid, eta: 0.1 + 0.2 })).toEqual([]);
    expect(checkParameters(checked, { ...valid, eta: 0.3 * (1 + 50 * MULTIPLE_OF_RELATIVE_TOLERANCE) })[0].code).toBe('INVALID_INPUT');
    expect(checkParameters(checked, { ...valid, eta: 0.31 })[0].code).toBe('INVALID_INPUT');
  });
});

describe('coupled constraints (A06)', () => {
  it('evaluates manifest constraints with their message, recovery and inclusivity', () => {
    const [problem] = checkParameters(manifest, { a: 3, eta: 1, x0: 4 });
    expect(problem).toEqual({ code: 'CONSTRAINT_VIOLATION', path: '$.constraints.stable-step', message: 'This step size is too large for the curvature.', recovery: 'Reduce the step size or the curvature.' });
    expect(checkParameters(manifest, { a: 5, eta: 0.5, x0: 4 })).toEqual([]); // eta·a = 2.5 is inclusive by default
    const exclusive = structuredClone(geometricManifest()); exclusive.constraints[0].maxInclusive = false;
    expect(checkParameters(validateManifest(exclusive).manifest, { a: 5, eta: 0.5, x0: 4 })[0].code).toBe('CONSTRAINT_VIOLATION');
  });
  it('never lets an undefined or invalid constraint pass silently', () => {
    // w/h is undefined for h = 0: a violation, not a pass.
    expect(checkParameters(rectangle, { w: 3, h: 0 })).toEqual([expect.objectContaining({ code: 'CONSTRAINT_VIOLATION', path: '$.constraints.aspect' })]);
    const unchecked = structuredClone(geometricManifest());
    unchecked.constraints[0].expression = 'eta*(';
    expect(checkParameters(unchecked, valid)[0]).toMatchObject({ code: 'CONSTRAINT_VIOLATION', path: '$.constraints.stable-step' });
    unchecked.constraints[0].expression = 'eta*undeclared';
    expect(checkParameters(unchecked, valid)[0].code).toBe('CONSTRAINT_VIOLATION');
    unchecked.constraints[0].expression = '[eta,a]';
    expect(checkParameters(unchecked, valid)[0].code).toBe('CONSTRAINT_VIOLATION');
  });
  it('defers coupled checks for absent or individually invalid inputs instead of masking simpler errors', () => {
    expect(checkParameters(manifest, { eta: 1 }, { partial: true })).toEqual([]);
    expect(checkParameters(manifest, { eta: 1, a: 3 }, { partial: true })[0].code).toBe('CONSTRAINT_VIOLATION');
    expect(checkParameters(manifest, { a: 3, eta: 7, x0: 4 }).map(item => item.code)).toEqual(['OUT_OF_DOMAIN']);
  });
});

describe('preview clamping', () => {
  it('clamps deterministically per parameter and reports what moved', () => {
    expect(clampForPreview(manifest, { a: 7.2, eta: -1, x0: 3.6 })).toEqual({ params: { a: 5, eta: 0, x0: 4 }, clamped: ['a', 'eta', 'x0'] });
    expect(clampForPreview(manifest, { a: 1.3, eta: 0.25, x0: -2.5 })).toEqual({ params: { a: 1.5, eta: 0.25, x0: -3 }, clamped: ['a', 'x0'] });
    expect(clampForPreview(manifest, valid)).toEqual({ params: valid, clamped: [] });
  });
  it('passes unknown or nonfinite values through for rejection and never clamps coupled violations', () => {
    const odd = clampForPreview(manifest, { a: 2, eta: Number.NaN, x0: 4, zz: 1 } as Record<string, number>);
    expect(odd.clamped).toEqual([]);
    expect(checkParameters(manifest, odd.params).map(item => item.path)).toEqual(['$.parameters.zz', '$.parameters.eta']);
    const coupled = clampForPreview(manifest, { a: 5, eta: 0.9, x0: 4 });
    expect(coupled).toEqual({ params: { a: 5, eta: 0.9, x0: 4 }, clamped: [] });
    expect(checkParameters(manifest, coupled.params)[0].code).toBe('CONSTRAINT_VIOLATION');
  });
});

describe('every entry point applies the same rules (A06)', () => {
  const sessions: ModelSession[] = [];
  afterEach(() => { for (const session of sessions.splice(0)) session.dispose(); });
  let operation = 0;
  const guard = (session: ModelSession): ModelGuard => ({ sessionId: session.id, expectedVersion: session.getState().version, expectedRunId: session.getState().run?.id ?? null, operationId: `c-${++operation}` });

  it('rejects identical violations for load, commit, preview, restore, sample and the evaluator', async () => {
    const workers = inlineWorkers(allKernels);
    const session = createModelSession({ workerFactory: workers.factory });
    sessions.push(session);
    const bad = { a: 3, eta: 1, x0: 4 };
    const expected = checkParameters(manifest, bad);
    expect(await failure(session.load(manifest, bad, guard(session)))).toEqual(expected);
    await session.load(manifest, null, guard(session));
    const before = session.getState();
    expect(await failure(session.commitParameters(bad, guard(session)))).toEqual(expected);
    expect(await failure(session.previewParameters('gesture', bad, guard(session)))).toEqual(expected);
    expect(session.getState().preview).toMatchObject({ status: 'failed', frame: null, error: expected[0] });
    session.cancelPreview(guard(session));
    expect(await failure(session.restore({ params: bad, position: { kind: 'index', index: 2 }, restoredFrom: 'run-1' }, guard(session)))).toEqual(expected);
    expect(await failure(session.sample({ params: bad, positions: [{ kind: 'index', index: 0 }] }))).toEqual(expected);
    const evaluator = createModelEvaluator(workers.factory);
    expect(await failure(evaluator.evaluate({ manifest, params: bad, position: { kind: 'index', index: 0 } }))).toEqual(expected);
    evaluator.dispose();
    // The worker enforces the same rules even when the main thread is bypassed.
    const posted = workers.received;
    const raw = workers.factory();
    const reply = new Promise<unknown>(resolve => raw.addEventListener('message', event => resolve((event as MessageEvent).data)));
    raw.postMessage({ type: 'evaluate', id: 'direct-1', request: { manifest: geometricManifest(), params: bad, position: { kind: 'index', index: 0 } } });
    expect(await reply).toEqual({ type: 'error', id: 'direct-1', diagnostics: expected });
    expect(workers.received).toBe(posted + 1);
    // Every rejected request kept the accepted state.
    expect(session.getState().frame).toBe(before.frame);
    expect(session.getState().run).toBe(before.run);
  });
});
