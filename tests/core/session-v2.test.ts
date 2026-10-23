import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVisualizationSession, SESSION_LIMITS } from '../../packages/core/src/declarative-session';
import { evaluateDocument, normalizeDocument, documentIdentity } from '../../packages/core/src/declarative/index';
import type { DocumentEvaluator, MutationGuard, VisualizationDocument, VisualizationSession } from '../../packages/core/src/declarative/types';

// A trusted interpreter test seam; authored JavaScript is never imported or executed here.
const evaluator = (): DocumentEvaluator => ({ evaluate: async request => evaluateDocument(request), dispose: vi.fn() });
const document = (): VisualizationDocument => ({ schemaVersion: '2.0', id: 'session-proof', title: 'Session proof', description: 'A bounded analytical test.', parameters: { speed: { label: 'Speed', value: 2, min: 0.1, max: 5 } }, quantities: { position: { expression: '[speed*time,speed*time]' }, amount: { expression: 'speed*time' }, anchor: { expression: [0, 0] } }, time: { end: 0.25, step: 0.1 }, views: [{ id: 'scene', type: 'scene', title: 'Scene', bounds: [0, 2, -1, 1], marks: [{ id: 'body', type: 'point', label: 'Body', bindings: { position: 'position' } }, { id: 'label', type: 'label', label: 'Label', text: 'A', bindings: { position: 'anchor' } }] }], assumptions: ['Test analytical relationship.'], limitations: ['Not a scientific acceptance fixture.'] });
let operation = 0;
function guard(session: VisualizationSession): MutationGuard { const state = session.getState(); return { sessionId: session.id, expectedVersion: state.version, ...(state.run && { expectedRunId: state.run.id }), operationId: `op-${++operation}`, origin: 'human' }; }
const sessions: VisualizationSession[] = [];
async function create(options: Parameters<typeof createVisualizationSession>[0] = {}) { const session = await createVisualizationSession({ evaluator: evaluator(), ...options }); sessions.push(session); return session; }
async function accept(session: VisualizationSession, input = document()) { const candidate = await session.createCandidate(input, guard(session)); await session.commitCandidate(candidate.id, guard(session)); return candidate; }
afterEach(() => { for (const session of sessions.splice(0)) session.dispose(); vi.useRealTimers(); });

describe('v2 instance-owned session', () => {
  it('has isolated immutable subscriptions and leaves imports free of DOM/storage access', async () => {
    const a = await create(), b = await create(); const events: string[] = []; const unsubscribe = a.subscribe(event => events.push(event.type));
    const empty = a.getState(); expect(a.getState()).toBe(empty); await accept(a);
    expect(a.id).not.toBe(b.id); expect(b.getState().status).toBe('empty'); expect(events).toContain('candidate');
    expect(Object.isFrozen(a.getState().document!.parameters.speed)).toBe(true); expect(() => { a.getState().run!.params.speed = 4; }).toThrow();
    unsubscribe(); const count = events.length; a.pause(guard(a)); expect(events).toHaveLength(count);
  });
  it('guards session, version and active run with actionable conflicts', async () => {
    const session = await create(); await accept(session); const stale = guard(session); await session.seek(0.1, guard(session));
    await expect(session.setParameters({ speed: 3 }, stale)).rejects.toThrow('actual');
    await expect(session.setParameters({ speed: 3 }, { ...guard(session), sessionId: 'another' })).rejects.toThrow('different session');
    await expect(session.setParameters({ speed: 3 }, { ...guard(session), expectedRunId: undefined })).rejects.toThrow('active run');
    expect(session.getState().run!.params.speed).toBe(2);
  });
  it('deduplicates concurrent and completed retries while rejecting operation-ID payload conflicts', async () => {
    const session = await create(); await accept(session); const original = session.getState().run!.id; const g = guard(session);
    const [a, b] = await Promise.all([session.setParameters({ speed: 3 }, g), session.setParameters({ speed: 3 }, g)]);
    expect(a.run!.id).toBe(b.run!.id); expect(a.run!.id).not.toBe(original);
    expect((await session.setParameters({ speed: 3 }, g)).run!.id).toBe(a.run!.id);
    await expect(session.setParameters({ speed: 4 }, g)).rejects.toThrow('different arguments'); expect(session.exportDocument().comparisons).toHaveLength(1);
  });
  it('snapshots caller-owned payloads and guards before awaiting', async () => {
    const session = await create(); const input = document(), g = guard(session); const pending = session.createCandidate(input, g);
    input.parameters.speed.value = 4; g.expectedVersion = 999;
    const candidate = await pending; expect(candidate.document.parameters.speed.value).toBe(2); await session.commitCandidate(candidate.id, guard(session));
    const params = { speed: 3 }; const requestGuard = guard(session); const update = session.setParameters(params, requestGuard); params.speed = 5; requestGuard.expectedRunId = 'changed';
    expect((await update).run!.params.speed).toBe(3);
  });
  it('retains accepted state when candidates fail and rejects stale valid candidates', async () => {
    const session = await create(); await accept(session); const original = session.getState(); const candidate = await session.reviseCandidate([{ op: 'metadata', title: 'Next' }], guard(session));
    await expect(session.reviseCandidate([{ op: 'set', collection: 'quantities', id: 'amount', value: { expression: 'missing' } }], guard(session))).rejects.toThrow();
    expect(session.getState().document).toBe(original.document); expect(session.getState().run).toBe(original.run);
    await session.setParameters({ speed: 4 }, guard(session)); await expect(session.commitCandidate(candidate.id, guard(session))).rejects.toThrow('since candidate');
    expect(session.getState().document!.title).toBe('Session proof');
  });
  it('cancels pending computation without changing the last accepted document or run', async () => {
    let blocked = false; let finish!: () => void;
    const testEvaluator: DocumentEvaluator = { evaluate: async (request, signal) => { if (blocked) await new Promise<void>((resolve, reject) => { finish = resolve; signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); }); return evaluateDocument(request); }, dispose() {} };
    const session = await create({ evaluator: testEvaluator }); await accept(session); const before = session.getState(); blocked = true;
    const controller = new AbortController(); const promise = session.reviseCandidate([{ op: 'metadata', title: 'Cancelled' }], guard(session), controller.signal);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function')); controller.abort(); finish(); await expect(promise).rejects.toThrow();
    expect(session.getState().run).toBe(before.run); expect(session.getState().document).toBe(before.document);
  });
  it('rejects async work after concurrent human changes', async () => {
    let release!: () => void; let slow = false;
    const session = await create({ evaluator: { evaluate: async request => { if (slow) await new Promise<void>(resolve => { release = resolve; }); return evaluateDocument(request); }, dispose() {} } });
    await accept(session); slow = true; const pending = session.setParameters({ speed: 3 }, guard(session)); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    session.select('body', guard(session)); release(); await expect(pending).rejects.toThrow('actual'); expect(session.getState().run!.params.speed).toBe(2); expect(session.getState().selection).toBe('body');
  });
  it('preserves run, parameters and current time for presentation revisions', async () => {
    const session = await create(); await accept(session); await session.setParameters({ speed: 4 }, guard(session)); await session.seek(0.13, guard(session)); const previous = session.getState();
    const candidate = await session.reviseCandidate([{ op: 'setMark', viewId: 'scene', mark: { ...previous.document!.views[0].marks![1], offset: [10, 20], style: { fill: '#123456' } } }, { op: 'presentation', value: { columns: 2, precision: 6 } }], guard(session));
    await session.commitCandidate(candidate.id, guard(session)); const next = session.getState();
    expect(next.identity!.modelRevision).toBe(previous.identity!.modelRevision); expect(next.identity!.documentRevision).not.toBe(previous.identity!.documentRevision); expect(next.run).toBe(previous.run); expect(next.frame).toBe(previous.frame);
  });
  it('scientific binding edits start a new run while projection bounds preserve it', async () => {
    const session = await create(); await accept(session); await session.seek(0.1, guard(session)); const before = session.getState();
    const bounds = await session.reviseCandidate([{ op: 'setView', view: { ...before.document!.views[0], bounds: [-1, 2, -1, 1] } }], guard(session));
    await session.commitCandidate(bounds.id, guard(session)); expect(session.getState().run!.id).toBe(before.run!.id);
    const candidate = await session.reviseCandidate([{ op: 'setMark', viewId: 'scene', mark: { ...before.document!.views[0].marks![0], bindings: { position: 'anchor' } } }], guard(session));
    await session.commitCandidate(candidate.id, guard(session)); expect(session.getState().run!.id).not.toBe(before.run!.id); expect(session.getState().run!.time).toBe(0);
  });
  it('uses exact finite boundaries and restarts every parameter commit at zero', async () => {
    const session = await create(); await accept(session); await session.seek(20, guard(session)); const end = session.getState();
    expect(end.frame!.time).toBe(0.25); expect(end.frame!.quantities.amount.value).toBe(0.5); expect(end.frame!.terminal).toBe(true);
    await session.setParameters({ speed: 3 }, guard(session)); expect(session.getState().frame!.time).toBe(0); expect(session.getState().run!.id).not.toBe(end.run!.id); expect(session.exportDocument().comparisons[0].run.time).toBe(0.25);
  });
  it('pauses and terminates playback at the exact off-grid boundary', async () => {
    vi.useFakeTimers(); const session = await create(); await accept(session); session.play(guard(session)); const version = session.getState().version;
    await vi.advanceTimersByTimeAsync(301); expect(session.getState().frame!.time).toBe(0.25); expect(session.getState().playing).toBe(false); expect(session.getState().version).toBe(version);
  });
  it('keeps preview tentative and blocks export, selection, candidates and seek until commit/cancel', async () => {
    const session = await create(); await accept(session); const before = session.getState(); session.previewParameters({ speed: 4 }, guard(session));
    expect(session.getState().preview!.speed).toBe(4); expect(session.getState().run).toBe(before.run); expect(session.getState().frame).toBe(before.frame);
    expect(() => session.exportDocument()).toThrow('tentative'); expect(() => session.select('body', guard(session))).toThrow('tentative');
    await expect(session.seek(0.1, guard(session))).rejects.toThrow('tentative'); await expect(session.reviseCandidate([{ op: 'metadata', title: 'Blocked' }], guard(session))).rejects.toThrow('tentative');
    session.cancelPreview(guard(session)); expect(session.getState().run).toBe(before.run);
    session.previewParameters({ speed: 3 }, guard(session)); await session.setParameters({ speed: 3 }, guard(session)); expect(session.getState().preview).toBeNull(); expect(session.getState().run!.params.speed).toBe(3);
  });
  it('round-trips complete comparison definitions and rejects tampering atomically', async () => {
    const source = await create(), target = await create(); await accept(source); await source.seek(0.2, guard(source)); await source.setParameters({ speed: 4 }, guard(source)); source.select('body', guard(source));
    const artifact = source.exportDocument(); await target.restoreDocument(artifact, guard(target)); const restored = target.getState(); expect(restored.run!.restoredFrom).toBe(artifact.run.id); expect(restored.run!.id).not.toBe(artifact.run.id); expect(target.exportDocument().comparisons[0].run.time).toBe(0.2); expect(restored.selection).toBe('body');
    const altered = structuredClone(artifact); altered.comparisons[0].document.quantities.amount.expression = 'speed*time*2'; await expect(target.restoreDocument(altered, guard(target))).rejects.toThrow('exact document'); expect(target.getState().run).toBe(restored.run);
    const badTime = structuredClone(artifact); badTime.run.time = 10; await expect(target.restoreDocument(badTime, guard(target))).rejects.toThrow('outside');
    const badRuntime = { ...artifact, runtimeVersion: '0.1.0' }; await expect(target.restoreDocument(badRuntime, guard(target))).rejects.toThrow('incompatible');
  });
  it('bounds candidates, comparisons and retry retention', async () => {
    const session = await create({ maxRuns: 2, maxCandidates: 1 }); await accept(session); const candidate = await session.createCandidate(document(), guard(session));
    await expect(session.createCandidate(document(), guard(session))).rejects.toThrow('candidate limit'); session.discardCandidate(candidate.id, guard(session));
    for (const speed of [3, 4, 5]) await session.setParameters({ speed }, guard(session)); expect(session.exportDocument().comparisons).toHaveLength(1);
    const stale = guard(session); session.pause(stale); for (let i = 0; i < SESSION_LIMITS.deduplicatedOperations; i++) session.pause(guard(session)); expect(() => session.pause(stale)).toThrow('actual');
  });
  it('rejects malformed edits, null parameters and unknown artifact fields', async () => {
    const session = await create(); await accept(session);
    await expect(session.setParameters({ speed: null } as unknown as Record<string, number>, guard(session))).rejects.toThrow('finite numeric');
    await expect(session.reviseCandidate([{ op: 'set', collection: 'parameters', id: '__proto__', value: {} }], guard(session))).rejects.toThrow('stable object');
    await expect(session.restoreDocument({ ...session.exportDocument(), extra: true }, guard(session))).rejects.toThrow('Unknown field');
  });
  it('disposes owned computation and ignores late evaluations', async () => {
    const testEvaluator = evaluator(); const session = await create({ evaluator: testEvaluator }); await accept(session); const events: string[] = []; session.subscribe(event => events.push(event.type)); session.dispose(); session.dispose();
    expect(testEvaluator.dispose).toHaveBeenCalledTimes(1); expect(session.getState().status).toBe('disposed'); expect(events.at(-1)).toBe('disposed'); expect(() => session.exportDocument()).toThrow('disposed');
    await expect(session.createCandidate(document(), guard(session))).rejects.toThrow('disposed');
  });
});
