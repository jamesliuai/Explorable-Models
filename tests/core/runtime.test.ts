import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { ExperimentRuntime, ExperimentError, WorkerExecutor, canonicalJSON, digest, sha256, definitionRevision, exposeModelWorker, validateManifest, validateEvaluation, validateParameters, validateSnapshot, validateViews, trustedInlineExecutor, close, RUNTIME_VERSION, type Manifest, type AnalyticModel, type ExperimentDefinition, type ScalarParams, type CheckSuite, } from '../../packages/core/src/index.js';
const manifest: Manifest = {
    schemaVersion: '1.0', id: 'motion', title: 'Motion', description: 'A constant acceleration model.', question: 'How far does an accelerating point travel?', kind: 'analytic',
    parameters: { a: { type: 'number', default: 2, label: 'Acceleration', min: 0, max: 10, unit: 'm/s²' }, length: { type: 'number', default: 5, label: 'Length', min: 1, max: 10, unit: 'm' } },
    quantities: { position: { type: 'scalar', label: 'Position', unit: 'm', dimension: 'length', description: 'Distance from origin.' }, speed: { type: 'scalar', label: 'Speed', unit: 'm/s', dimension: 'velocity', description: 'Speed along line.' }, vector: { type: 'vector', label: 'Velocity vector', unit: 'm/s', dimension: 'velocity', description: 'Velocity in the plane.', vectorLength: 2 } },
    entities: [{ id: 'point', label: 'Moving point', quantityIds: ['position', 'speed', 'vector'] }], assumptions: ['Constant acceleration.'], limitations: ['Stops at a fixed distance.'], sources: [{ title: 'Reference', url: 'https://example.org/reference' }], capabilities: ['play', 'sample', 'compare'], review: { status: 'unreviewed' },
};
const model: AnalyticModel = { kind: 'analytic', timeDomain(p) { return { start: 0, end: p.a === 0 ? null : Math.sqrt(2 * Number(p.length) / Number(p.a)), endEventId: 'arrival' }; }, evaluate({ params: p, time: t }) { return { quantities: { position: { value: 0.5 * Number(p.a) * t * t, status: 'valid' }, speed: { value: Number(p.a) * t, status: 'valid' }, vector: { value: [Number(p.a) * t, 0], status: 'valid' } } }; } };
function definition(overrides: Partial<ExperimentDefinition> = {}): ExperimentDefinition { return { manifest, model, definitionRevision: definitionRevision({ manifest, source: 'fixture-v1', dependencyLock: 'lock' }), ...overrides }; }
async function runtime() { return ExperimentRuntime.create(definition()); }
const suite: CheckSuite = { id: 'reference', version: '1', author: 'Toolkit unit fixtures', provenance: 'reference', cases: [{ id: 't1', label: 'Position and speed at one second', time: 1, expected: { position: 1, speed: 2, vector: [2, 0] } }] };
describe('portable content identity', () => {
    it('matches independent SHA-256 known bytes including Unicode and multiblock input', () => { for (const value of ['', 'abc', 'π and 🌎', 'a'.repeat(1025)])
        expect(sha256(value)).toBe(createHash('sha256').update(value).digest('hex')); });
    it('canonicalizes object order without reordering arrays', () => { expect(digest({ b: 2, a: 1 })).toBe(digest({ a: 1, b: 2 })); expect(digest([1, 2])).not.toBe(digest([2, 1])); expect(() => canonicalJSON({ bad: Infinity })).toThrow(); });
    it('changes revisions when source, lock, or runtime identity changes', () => { const base = { manifest, source: 'a', dependencyLock: 'lock' }; const first = definitionRevision(base); expect(definitionRevision({ ...base, source: 'b' })).not.toBe(first); expect(definitionRevision({ ...base, dependencyLock: 'other' })).not.toBe(first); expect(definitionRevision({ ...base, runtimeIdentity: 'other' })).not.toBe(first); });
});
describe('manifest and data boundaries', () => {
    it('accepts a valid manifest without allowing callers to mutate it', () => { const checked = validateManifest(manifest); checked.title = 'changed'; expect(manifest.title).toBe('Motion'); });
    it('rejects unsafe sources, duplicate entities and unknown bindings', () => { expect(() => validateManifest({ ...manifest, sources: [{ title: 'bad', url: 'javascript:alert(1)' }] })).toThrow(); expect(() => validateManifest({ ...manifest, entities: [manifest.entities![0], manifest.entities![0]] })).toThrow(); expect(() => validateViews([{ id: 'scene', type: 'scene2d', label: 'Scene', bindings: [{ id: 'x', property: 'x', quantityId: 'missing' }] }], manifest)).toThrow(); });
    it('accepts fixed coordinate bounds and rejects malformed or degenerate extents', () => {
        const scene = { id: 'scene', type: 'scene2d' as const, label: 'Scene', bindings: [], bounds: { x: [-3.3, 3.3] as const, y: [-1, 1] as const } };
        const checked = validateViews([scene], manifest);
        expect(checked[0]!.bounds).toEqual(scene.bounds);
        expect(checked[0]!.bounds).not.toBe(scene.bounds);
        for (const bounds of [null, [], {}, { x: [0, 1] }, { x: [0, 1], y: [0, 1], z: [0, 1] }, { x: [0, 0], y: [0, 1] }, { x: [1, 0], y: [0, 1] }, { x: [0, Infinity], y: [0, 1] }, { x: [0, NaN], y: [0, 1] }, { x: ['0', 1], y: [0, 1] }, { x: [0, 1, 2], y: [0, 1] }, { x: [0, 1], y: [2, 1] }]) {
            expect(() => validateViews([{ ...scene, bounds: bounds as never }], manifest)).toThrowError(expect.objectContaining({ code: 'INVALID_MANIFEST' }));
        }
    });
    it('rejects nonfinite parameters and enforces domain without quantizing exact entry', () => { expect(() => validateParameters(manifest, { a: NaN })).toThrow(); expect(() => validateParameters(manifest, { a: -1 })).toThrow(); expect(() => validateParameters(manifest, { oops: 1 })).toThrow(); expect(validateParameters(manifest, { a: 1.23456789 }).a).toBe(1.23456789); });
    it('rejects missing/extra/nonfinite model outputs and malformed vectors', () => { const valid = model.evaluate({ params: { a: 2, length: 5 }, time: 1 }); expect(() => validateEvaluation(manifest, { quantities: {} })).toThrow(); expect(() => validateEvaluation(manifest, { quantities: { ...valid.quantities, extra: { value: 0, status: 'valid' } } })).toThrow(); expect(() => validateEvaluation(manifest, { quantities: { ...valid.quantities, speed: { value: Infinity, status: 'valid' } } })).toThrow(); expect(() => validateEvaluation(manifest, { quantities: { ...valid.quantities, vector: { value: [1, 2, 3], status: 'valid' } } })).toThrow(); });
    it('requires an explicit reason and null for undefined quantities', () => { const valid = model.evaluate({ params: { a: 2, length: 5 }, time: 1 }); expect(() => validateEvaluation(manifest, { quantities: { ...valid.quantities, speed: { value: null, status: 'undefined' } } })).toThrow(); expect(validateEvaluation(manifest, { quantities: { ...valid.quantities, speed: { value: null, status: 'undefined', reason: 'No flagged objects.' } } }).quantities.speed!.value).toBeNull(); });
    it('rejects unsupported or oversized geometry before rendering', () => { const m = { ...manifest, geometry: { path: { shape: 'polyline2' as const, unit: 'm', coordinateFrame: 'world', maxElements: 4 } } }; const valid = model.evaluate({ params: { a: 2, length: 5 }, time: 1 }); expect(() => validateEvaluation(m, { ...valid, geometry: { path: [0, 1, 2] } })).toThrow(); expect(() => validateEvaluation(m, { ...valid, geometry: { path: [0, 1, 2, 3, 4, 5] } })).toThrow(); expect(() => validateEvaluation(m, { ...valid, geometry: { wrong: [0, 1] } })).toThrow(); });
});
describe('run lifecycle and command arbitration', () => {
    it('uses one frame for units, inspection, and data and protects state from mutation', async () => { const r = await runtime(); await r.command({ type: 'seek', time: 1, ...r.guard() }); const i = r.inspect(['speed']); expect(i.quantities.speed!.value).toBe(2); expect(i.quantities.speed!.unit).toBe('m/s'); expect(i.frameId).toBe(r.getState().frame.frameId); const state = r.getState(); state.run.parameters.a = 9; expect(r.getState().run.parameters.a).toBe(2); });
    it('restarts parameter changes and preserves old runs for explicit comparison', async () => { const r = await runtime(); await r.command({ type: 'seek', time: 1, ...r.guard() }); const old = r.getState().activeRunId; const result = await r.command({ type: 'set_parameters', parameters: { a: 4 }, ...r.guard() }); expect(result.previousRunId).toBe(old); expect(result.state.frame.timePoint.time).toBe(0); expect(result.state.run.version).toBe(0); expect(r.listRuns().find(run => run.id === old)!.frame.quantities.position!.value).toBe(1); });
    it('rejects stale version and stale active run races, including version-zero replacement', async () => { const r = await runtime(); const guard = r.guard(); const first = r.command({ type: 'set_parameters', parameters: { a: 3 }, ...guard }); const second = r.command({ type: 'set_parameters', parameters: { a: 4 }, ...guard }); await first; await expect(second).rejects.toMatchObject({ code: 'CONFLICT' }); expect(r.getState().run.parameters.a).toBe(3); const version = r.guard(); await r.command({ type: 'play', ...version }); await expect(r.command({ type: 'pause', ...version })).rejects.toMatchObject({ code: 'CONFLICT' }); });
    it('increments run versions for accepted commands, not playback ticks', async () => { const r = await runtime(); await r.command({ type: 'play', ...r.guard() }); const version = r.getState().run.version; await r.tick(0.1); expect(r.getState().frame.timePoint.time).toBe(0.1); expect(r.getState().run.version).toBe(version); await r.command({ type: 'pause', ...r.guard() }); expect(r.getState().run.version).toBe(version + 1); });
    it('accumulates sub-grid playback intervals instead of losing time', async () => { const r = await runtime(); await r.command({ type: 'play', ...r.guard() }); for (let i = 0; i < 100; i++)
        await r.tick(0.001); expect(r.getState().frame.timePoint.time).toBe(0.1); });
    it('ends at the exact computed event with physical speed retained', async () => { const r = await runtime(); await r.command({ type: 'play', ...r.guard() }); await r.tick(10); const frame = r.getState().frame; expect(frame.timePoint).toEqual({ kind: 'event', time: Math.sqrt(5), eventId: 'arrival' }); expect(frame.status).toBe('boundary'); expect(frame.quantities.position!.value).toBeCloseTo(5, 12); expect(frame.quantities.speed!.value).toBeCloseTo(2 * Math.sqrt(5), 12); await r.tick(10); expect(r.getState().frame.frameId).toBe(frame.frameId); });
    it('handles an unbounded zero-acceleration domain without Infinity', async () => { const r = await runtime(); await r.command({ type: 'set_parameters', parameters: { a: 0 }, ...r.guard() }); await r.command({ type: 'play', ...r.guard() }); await r.tick(60); expect(r.getState().frame.quantities.position!.value).toBe(0); expect(r.getState().frame.status).toBe('running'); });
    it('does not evaluate out-of-domain times', async () => { const evalSpy = vi.fn(model.evaluate); const r = await ExperimentRuntime.create(definition({ model: { ...model, evaluate: evalSpy } })); evalSpy.mockClear(); await expect(r.sample({ times: [100] })).rejects.toMatchObject({ code: 'OUT_OF_DOMAIN' }); expect(evalSpy).not.toHaveBeenCalled(); });
    it('preserves the last accepted frame when evaluation fails', async () => { let fails = false; const r = await ExperimentRuntime.create(definition({ model: { ...model, evaluate(input) { if (fails)
                throw new Error('bad candidate'); return model.evaluate(input); } } })); const before = r.getState(); fails = true; await expect(r.command({ type: 'seek', time: 1, ...r.guard() })).rejects.toMatchObject({ code: 'MODEL_ERROR' }); expect(r.getState().run).toEqual(before.run); expect(r.getState().lastError!.message).toBe('bad candidate'); });
    it('keeps selection and presentation version separate from physics', async () => { const r = await runtime(); const before = r.getState(); await r.command({ type: 'set_view', expectedViewVersion: 0, view: { selectedIds: ['speed'], playbackSpeed: 0.5 } }); expect(r.getState().run).toEqual(before.run); expect(r.getState().viewVersion).toBe(1); await expect(r.command({ type: 'set_view', expectedViewVersion: 0, view: { selectedIds: [] } })).rejects.toMatchObject({ code: 'CONFLICT' }); });
    it('notifies listeners without allowing exceptions to break the command queue', async () => { const r = await runtime(); let count = 0; r.subscribe(() => { throw new Error('bad consumer'); }); r.subscribe(() => count++); await r.command({ type: 'play', ...r.guard() }); await r.command({ type: 'pause', ...r.guard() }); expect(count).toBe(2); });
});
describe('transient previews', () => {
    it('reports tentative values and refuses agent mutations/checkpoints until committed', async () => { const r = await runtime(); const before = r.getState(); await r.command({ type: 'begin_preview', parameters: { a: 3 }, ...r.guard() }); expect(r.inspect().preview?.tentative).toBe(true); expect(r.inspect().parameters.a).toBe(3); expect(r.getState().run).toEqual(before.run); expect(() => r.checkpoint()).toThrowError(expect.objectContaining({ code: 'BUSY' })); await expect(r.command({ type: 'play', ...r.guard() })).rejects.toMatchObject({ code: 'BUSY' }); const id = r.getState().preview!.id; await r.command({ type: 'commit_preview', previewId: id, ...r.guard() }); expect(r.getState().run.parameters.a).toBe(3); expect(r.getState().activeRunId).not.toBe(before.activeRunId); expect(r.inspect().preview).toBeUndefined(); });
    it('distinguishes preview frames and cancellation restores the committed state', async () => { const r = await runtime(); const before = r.getState(); await r.command({ type: 'begin_preview', parameters: { a: 3 }, ...r.guard() }); const preview = r.getState().preview!; await r.command({ type: 'update_preview', previewId: preview.id, parameters: { a: 4 }, ...r.guard() }); expect(r.getState().frame.frameId).not.toBe(preview.frame.frameId); await r.command({ type: 'cancel_preview', previewId: preview.id, ...r.guard() }); expect(r.getState().run).toEqual(before.run); });
});
describe('portable snapshots and isolated samples', () => {
    it('restores exact event time and view into a new run with provenance', async () => { const r = await runtime(); await r.command({ type: 'play', ...r.guard() }); await r.tick(10); await r.command({ type: 'set_view', expectedViewVersion: 0, view: { selectedIds: ['speed'] } }); const snapshot = r.checkpoint('At arrival'); await r.command({ type: 'set_parameters', parameters: { a: 4 }, ...r.guard() }); await r.command({ type: 'restore', snapshot, ...r.guard() }); const state = r.getState(); expect(state.run.id).not.toBe(snapshot.runId); expect(state.run.restoredFrom).toBe(snapshot.runId); expect(state.frame.timePoint).toEqual(snapshot.timePoint); expect(state.view.selectedIds).toEqual(['speed']); expect(state.frame.quantities.speed!.value).toBeCloseTo(2 * Math.sqrt(5), 12); });
    it('rejects wrong definition, missing parameters, corrupt ticks, and forged terminal events', async () => { const r = await runtime(); const snapshot = r.checkpoint(); expect(() => validateSnapshot({ ...snapshot, definitionRevision: digest('other') }, manifest, definition().definitionRevision, RUNTIME_VERSION)).toThrowError(expect.objectContaining({ code: 'INCOMPATIBLE_SNAPSHOT' })); expect(() => validateSnapshot({ ...snapshot, parameters: { a: 2 } }, manifest, definition().definitionRevision, RUNTIME_VERSION)).toThrow(); await expect(r.command({ type: 'restore', snapshot: { ...snapshot, timePoint: { kind: 'grid', time: 1, tick: 1, rateHz: 120 } }, ...r.guard() })).rejects.toMatchObject({ code: 'INCOMPATIBLE_SNAPSHOT' }); await expect(r.command({ type: 'restore', snapshot: { ...snapshot, timePoint: { kind: 'event', time: 1, eventId: 'arrival' } }, ...r.guard() })).rejects.toMatchObject({ code: 'INCOMPATIBLE_SNAPSHOT' }); });
    it('samples alternate parameters without changing the learner’s run, view, or time', async () => { const r = await runtime(); await r.command({ type: 'seek', time: 0.5, ...r.guard() }); const before = r.getState(); const sample = await r.sample({ parameters: { a: 4 }, times: [0, 1] }); expect(sample.frames[1]!.quantities.position!.value).toBe(2); expect(sample.frames[1]!.timePoint.kind).toBe('sample'); expect(r.getState()).toEqual(before); });
    it('compares time-aligned runs, explicitly clipping at each terminal event', async () => { const r = await runtime(); const first = r.getState().activeRunId; await r.command({ type: 'set_parameters', parameters: { a: 4 }, ...r.guard() }); const second = r.getState().activeRunId; const comparison = await r.compare({ runIds: [first, second], times: [0, 1, 2, 3] }); expect(comparison.parameterDifferences.a!.map(d => d.value)).toEqual([2, 4]); expect(comparison.runs[0]!.frames.at(-1)!.timePoint.time).toBe(Math.sqrt(5)); expect(comparison.runs[1]!.frames.at(-1)!.timePoint.time).toBe(Math.sqrt(2.5)); });
});
describe('check reports and revision activation', () => {
    it('records check scope, tolerance, provenance, revision and honest review boundaries', async () => { const r = await runtime(); const report = await r.verify(suite); expect(report.passed).toBe(true); expect(report.results[0]!.assertions[0]!.atol).toBe(1e-9); expect(report.provenance).toBe('reference'); expect(report.modelReview?.status).toBe('unreviewed'); expect(report.learnerEvidence).toBe('not_evaluated'); });
    it('detects a wrong phase rather than relying on a conserved value', async () => { const r = await runtime(); const report = await r.verify({ ...suite, cases: [{ id: 'wrong', label: 'Wrong value', time: 1, expected: { position: 0 } }] }); expect(report.passed).toBe(false); expect(close(1, 1 + 1e-10)).toBe(true); expect(close([1, 2], [1, 3])).toBe(false); });
    it('keeps a working definition when a candidate fails checks', async () => { const r = await runtime(); const before = r.getState(); const candidate = definition({ definitionRevision: digest('candidate') }); const report = await r.verify(suite); await expect(r.activateRevision(candidate, trustedInlineExecutor(model, manifest), { ...report, definitionRevision: candidate.definitionRevision, passed: false }, { ...r.guard(), expectedDefinitionRevision: definition().definitionRevision })).rejects.toMatchObject({ code: 'MODEL_ERROR' }); expect(r.getState().run).toEqual(before.run); });
    it('activates a checked candidate atomically and retains the prior run', async () => { const r = await runtime(); const before = r.getState(); const candidate = definition({ definitionRevision: digest('candidate') }); const checker = await ExperimentRuntime.create(candidate); const report = await checker.verify(suite); await r.activateRevision(candidate, trustedInlineExecutor(model, manifest), report, { ...r.guard(), expectedDefinitionRevision: definition().definitionRevision }); expect(r.getState().run.definitionRevision).toBe(candidate.definitionRevision); expect(r.listRuns().some(run => run.id === before.run.id)).toBe(true); });
});
describe('worker isolation and watchdog', () => {
    function fakeWorker(hang = false) { const listeners = new Map<string, Set<(e: any) => void>>(); let receive: ((e: any) => void) | undefined; const worker = { terminated: false, postMessage(message: unknown) { if (!hang)
            queueMicrotask(() => receive?.({ data: message })); }, addEventListener(type: string, fn: (e: any) => void) { if (!listeners.has(type))
            listeners.set(type, new Set()); listeners.get(type)!.add(fn); }, removeEventListener(type: string, fn: (e: any) => void) { listeners.get(type)?.delete(fn); }, terminate() { this.terminated = true; } }; exposeModelWorker(model, { postMessage(message) { queueMicrotask(() => listeners.get('message')?.forEach(fn => fn({ data: message }))); }, addEventListener(_type, fn) { receive = fn; } }); return worker; }
    it('uses worker messages for evaluation and validates returned data', async () => { const worker = fakeWorker(); const executor = new WorkerExecutor(worker, manifest); const r = await ExperimentRuntime.create(definition({ model: undefined }), executor); await r.command({ type: 'seek', time: 1, ...r.guard() }); expect(r.inspect(['speed']).quantities.speed!.value).toBe(2); r.dispose(); expect(worker.terminated).toBe(true); });
    it('terminates a nonresponsive worker and reports a stable error', async () => { const worker = fakeWorker(true); const executor = new WorkerExecutor(worker, manifest, { timeoutMs: 10 }); await expect(executor.evaluate({ a: 2, length: 5 }, 0)).rejects.toMatchObject({ code: 'TIMEOUT' }); expect(worker.terminated).toBe(true); await expect(executor.evaluate({ a: 2, length: 5 }, 0)).rejects.toMatchObject({ code: 'MODEL_ERROR' }); });
});
describe('malformed worker and state messages', () => {
    function responder(result: unknown, kind: 'analytic' | 'parametric' = 'analytic') {
        let listener: ((event: any) => void) | undefined;
        return { postMessage(request: any) { queueMicrotask(() => listener?.({ data: { namespace: 'unrelated-tool', id: request.id, ok: true, result: 'ignore' } })); queueMicrotask(() => listener?.({ data: { namespace: 'explorable-models', id: request.id, ok: true, modelKind: kind, result } })); }, addEventListener(type: string, fn: (e: any) => void) { if (type === 'message')
                listener = fn; }, removeEventListener() { }, terminate() { } };
    }
    it('ignores unrelated messages and rejects nonfinite data from its worker', async () => { const executor = new WorkerExecutor(responder({ quantities: { position: { status: 'valid', value: NaN }, speed: { status: 'valid', value: 2 }, vector: { status: 'valid', value: [2, 0] } } }), manifest); await expect(executor.evaluate({ a: 2, length: 5 }, 1)).rejects.toMatchObject({ code: 'MODEL_ERROR' }); executor.dispose(); });
    it('rejects a model kind that disagrees with its public contract', async () => { const executor = new WorkerExecutor(responder({ start: 0, end: 0 }, 'parametric'), manifest); await expect(executor.timeDomain({ a: 2, length: 5 })).rejects.toMatchObject({ code: 'MODEL_ERROR' }); executor.dispose(); });
    it('rejects unknown view and snapshot fields instead of persisting unrelated data', async () => { const r = await runtime(); await expect(r.command({ type: 'set_view', expectedViewVersion: 0, view: { credential: 'not-allowed' } as any })).rejects.toMatchObject({ code: 'INVALID_COMMAND' }); const snapshot = r.checkpoint(); await expect(r.command({ type: 'restore', snapshot: { ...snapshot, unrelated: 'not-allowed' } as any, ...r.guard() })).rejects.toMatchObject({ code: 'INCOMPATIBLE_SNAPSHOT' }); });
    it('rejects unknown metadata fields rather than expanding the model trust surface', () => { expect(() => validateManifest({ ...manifest, sourceScript: 'not-allowed' })).toThrowError(expect.objectContaining({ code: 'INVALID_MANIFEST' })); });
});

describe('queued command input integrity', () => {
    it('copies a command at admission so its caller cannot rewrite a queued operation', async () => {
        const r = await runtime();
        const command = { type: 'set_parameters' as const, parameters: { a: 3 }, ...r.guard() };
        const accepted = r.command(command);
        command.parameters.a = 9;
        await accepted;
        expect(r.getState().run.parameters.a).toBe(3);
    });
    it('rejects unsupported command fields and nonfinite suite expectations', async () => {
        const r = await runtime();
        await expect(r.command({ type: 'play', ...r.guard(), arbitrary: true } as any)).rejects.toMatchObject({ code: 'INVALID_COMMAND' });
        await expect(r.verify({ ...suite, cases: [{ id: 'bad', label: 'Bad expected value', expected: { speed: Infinity } }] })).rejects.toMatchObject({ code: 'INVALID_PARAMETER' });
    });
});

describe('semantic lookup boundaries', () => {
    it('does not expose inherited object properties as registered quantities', async () => {
        const r = await runtime();
        expect(() => r.inspect(['toString'])).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
        expect(() => r.inspect('speed' as any)).toThrowError(expect.objectContaining({ code: 'INVALID_PARAMETER' }));
    });
    it('pins sample parameters at admission without changing the active run', async () => {
        const r = await runtime();
        const input = { parameters: { a: 3 }, times: [1] };
        const pending = r.sample(input);
        input.parameters.a = 9;
        input.times[0] = 0;
        const result = await pending;
        expect(result.frames[0]!.quantities.speed!.value).toBe(3);
        expect(r.getState().run.parameters.a).toBe(2);
    });
});

describe('active revision domain inspection', () => {
    it('uses the newly activated executor and leaves current parameters untouched', async () => {
        const r = await runtime();
        expect((await r.getTimeDomain()).end).toBe(Math.sqrt(5));
        const faster: AnalyticModel = {
            kind: 'analytic',
            timeDomain(params) { return { start: 0, end: params.a === 0 ? null : Math.sqrt(Number(params.length) / Number(params.a)), endEventId: 'arrival' }; },
            evaluate({ params, time }) { return model.evaluate({ params: { ...params, a: Number(params.a) * 2 }, time }); },
        };
        const candidate = definition({ model: faster, definitionRevision: digest('faster-model') });
        const checker = await ExperimentRuntime.create(candidate);
        const report = await checker.verify({ ...suite, cases: [{ id: 'fast', label: 'New acceleration', time: 1, expected: { position: 2, speed: 4 } }] });
        await r.activateRevision(candidate, trustedInlineExecutor(faster, manifest), report, { ...r.guard(), expectedDefinitionRevision: definition().definitionRevision });
        expect((await r.getTimeDomain()).end).toBe(Math.sqrt(2.5));
        expect((await r.getTimeDomain({ a: 0 })).end).toBeNull();
        expect(r.getState().run.parameters.a).toBe(2);
        checker.dispose();
    });
});
