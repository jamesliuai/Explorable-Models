import { describe, it, expect, vi, afterEach } from 'vitest';
import { normalizeDocument } from '../../packages/core/src/declarative/validation.js';
import { evaluateDocument } from '../../packages/core/src/declarative/evaluation.js';
import { parseExpression, evaluateExpression } from '../../packages/core/src/declarative/expressions.js';
import { documentIdentity } from '../../packages/core/src/declarative/identity.js';
import { createDocumentEvaluator } from '../../packages/core/src/declarative/worker.js';
import { DocumentError, type VisualizationDocument, type EvaluationRequest } from '../../packages/core/src/declarative/types.js';
import { createPreset, presetCatalog } from '../../packages/core/src/presets.js';
const base = (): VisualizationDocument => ({ schemaVersion: '2.0', id: 'test', title: 'A test', description: 'Bounded interpreter test.', parameters: { a: { label: 'a', value: 2, min: 0, max: 10 } }, quantities: { result: { expression: 'a*2' } }, views: [{ id: 'values', type: 'values', title: 'Values', quantities: ['result'] }], assumptions: [], limitations: [] });
const request = (document = base()): EvaluationRequest => ({ document, params: Object.fromEntries(Object.entries(document.parameters).map(([id, p]) => [id, p.value])), time: 0 });
const scalar = (expression: string) => evaluateExpression(parseExpression(expression), name => ({ value: null, status: 'undefined', reason: `Missing ${name}` }));
class FakeWorker {
    listeners = new Map<string, Set<EventListener>>();
    terminated = false;
    messages: Record<string, unknown>[] = [];
    addEventListener(type: string, listener: EventListener) { const set = this.listeners.get(type) ?? new Set(); set.add(listener); this.listeners.set(type, set); }
    removeEventListener(type: string, listener: EventListener) { this.listeners.get(type)?.delete(listener); }
    postMessage(message: Record<string, unknown>) { this.messages.push(message); }
    terminate() { this.terminated = true; }
    respond(data: unknown) {
        for (const listener of this.listeners.get('message') ?? [])
            listener({ data } as MessageEvent);
    }
    reply() { const message = this.messages.at(-1)!; this.respond({ type: 'result', id: message.id, frame: evaluateDocument(message.request as EvaluationRequest) }); }
}
afterEach(() => vi.useRealTimers());
describe('bounded expression parser and dimensional contract', () => {
    it('implements precedence, right-associative powers, scientific notation and vectors', () => {
        expect(scalar('-2^2+2^3^2').value).toBe(508);
        expect(scalar('1e-3 + .5').value).toBe(.501);
        expect(scalar('dot([1,2],[3,4])').value).toBe(11);
        expect(scalar('component([4,5],1)').value).toBe(5);
        expect(scalar('norm([3,4])').value).toBe(5);
        expect(scalar('sum([1,2,3])').value).toBe(6);
        expect(scalar('[1,2]*3').value).toEqual([3, 6]);
    });
    it.each(['globalThis.fetch("x")', 'a[0]', 'Math.sin(1)', '(()=>1)()', 'import("x")', 'new Date()', 'sin.constructor(1)', '1;2', '[1]', 'vector(1)', '1e999', '[1,[2,3]]'])('rejects unsafe/unsupported syntax or shape: %s', expression => {
        const document = base();
        document.quantities.result.expression = expression;
        expect(() => normalizeDocument(document)).toThrow(DocumentError);
    });
    it('rejects excessive depth, nodes and vector sizes', () => {
        expect(() => parseExpression('('.repeat(40) + '1' + ')'.repeat(40))).toThrow();
        expect(() => parseExpression(Array(40).fill('1').join('+'))).toThrow();
        expect(() => parseExpression(Array(257).fill(0))).toThrow();
    });
    it.each(['1/0', 'sqrt(-1)', 'log(0)', 'acos(2)', 'atan2(0,0)', 'tan(pi/2)', '10^1000', 'component([1,2],2)'])('returns explicit undefined reasons for %s', expression => {
        expect(scalar(expression)).toMatchObject({ value: null, status: 'undefined', reason: expect.any(String) });
    });
    it('checks compatible dimensions, shapes, cycles and missing references', () => {
        let document = base();
        document.parameters.a.dimension = 'length';
        document.quantities.result.expression = 'a+1';
        expect(() => normalizeDocument(document)).toThrow(/dimension/);
        document.quantities.result.expression = 'a*a';
        document.quantities.result.dimension = 'area';
        expect(normalizeDocument(document).quantities.result.dimension).toBe('area');
        document.quantities.result.expression = '[a,0]';
        delete document.quantities.result.dimension;
        expect(() => normalizeDocument(document)).not.toThrow();
        document.quantities.result.expression = 'sin(a)';
        expect(() => normalizeDocument(document)).toThrow(/Trigonometric/);
        document = base();
        document.quantities.result.expression = 'missing+1';
        expect(() => normalizeDocument(document)).toThrow(/Unknown reference/);
        document.quantities = { one: { expression: 'two' }, two: { expression: 'one' } };
        expect(() => normalizeDocument(document)).toThrow(/cycle/);
        document = base();
        document.quantities.result.expression = '[1,2]+[1,2,3]';
        expect(() => normalizeDocument(document)).toThrow(/shapes/);
    });
    it('allows dimensional literal quantities and explicit radians without pretending unit labels convert', () => {
        const document = base();
        document.quantities = { duration: { expression: 1, dimension: 'time', unit: 's' }, angle: { expression: Math.PI / 2, dimension: 'angle', unit: 'rad' }, result: { expression: 'sin(angle)' } };
        expect(evaluateDocument(request(document)).quantities.result.value).toBe(1);
        document.quantities.result.expression = 'duration+angle';
        expect(() => normalizeDocument(document)).toThrow(/dimension/);
    });
});
describe('strict bounded declarative documents and committed frames', () => {
    it('normalizes all public presets and returns isolated data', () => {
        for (const preset of presetCatalog) {
            const document = createPreset(preset.id);
            expect(normalizeDocument(document)).not.toBe(document);
            expect(() => evaluateDocument(request(document))).not.toThrow();
        }
    });
    it('rejects unknown keys, polluted maps, getters and cycles', () => {
        expect(() => normalizeDocument({ ...base(), secret: 1 })).toThrow(/Unknown field/);
        expect(() => normalizeDocument(JSON.parse(JSON.stringify(base()).replace('"parameters":{', '"parameters":{"__proto__":{},')))).toThrow(/Reserved/);
        let reads = 0;
        const value = base();
        Object.defineProperty(value, 'secret', { enumerable: true, get() { reads++; return 1; } });
        expect(() => normalizeDocument(value)).toThrow(/Accessors/);
        expect(reads).toBe(0);
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        expect(() => normalizeDocument(cyclic)).toThrow(/Cyclic/);
    });
    it('rejects unsupported capabilities, excessive cells and invalid bounds', () => {
        expect(() => normalizeDocument({ ...base(), capabilities: [{ id: 'ode-solver', version: '1.0' }] })).toThrow(/Unsupported capability/);
        const document = base();
        document.views[0] = { id: 'scene', type: 'scene', title: 'Scene' };
        document.views[0].bounds = [0, 0, 0, 1];
        expect(() => normalizeDocument(document)).toThrow(/Bounds/);
        document.views[0].bounds = [0, 1, -1, 1];
        document.views[0].scale = 'log';
        expect(() => normalizeDocument(document)).toThrow(/positive bounds/);
    });
    it('validates model-bound marks, shapes, identifiers, colors and equation refs', () => {
        const document = base();
        document.views[0] = { id: 'scene', type: 'scene', title: 'Scene', marks: [{ id: 'point', type: 'point', label: 'Point', bindings: { position: 'result' } }] };
        expect(() => normalizeDocument(document)).toThrow(/2-component/);
        document.quantities.result.expression = [1, 2];
        expect(() => normalizeDocument(document)).not.toThrow();
        document.views[0].marks![0].style = { fill: 'url(https://bad.example)' };
        expect(() => normalizeDocument(document)).toThrow(/literal color/);
        document.views = [{ id: 'equation', type: 'equation', title: 'Equation', equation: '{{unknown}}' }];
        expect(() => normalizeDocument(document)).toThrow(/Unknown quantity/);
    });
    it('rejects fields the declared view or mark cannot render', () => {
        const document = base();
        document.views[0].marks = [];
        expect(() => normalizeDocument(document)).toThrow(/only in scene and plot/);
        document.views = [{ id: 'empty', type: 'values', title: 'Empty' }];
        expect(() => normalizeDocument(document)).toThrow(/at least one/);
        document.views = [{ id: 'scene', type: 'scene', title: 'Scene', marks: [{ id: 'group', type: 'group', label: 'Group', style: { fill: 'red' }, children: [{ id: 'point', type: 'point', label: 'Point', bindings: { x: 'result', y: 'result' } }] }] }];
        expect(() => normalizeDocument(document)).toThrow(/hidden and opacity/);
        document.views[0].marks![0].style = { opacity: .5 };
        expect(() => normalizeDocument(document)).not.toThrow();
        const wave = createPreset('wave');
        wave.views[0].marks![0].bindings = { baseline: 'ordinate' };
        expect(() => normalizeDocument(wave)).toThrow(/Binding is not supported/);
    });
    it('evaluates quantity dependencies once per frame and propagates undefined', () => {
        const document = base();
        document.quantities = { result: { expression: 'other+1' }, other: { expression: 'a/0' } };
        expect(evaluateDocument(request(document)).quantities.result).toEqual({ value: null, status: 'undefined', reason: 'Division by zero.' });
    });
    it('requires complete in-range parameters and clamps analytical runs to exact terminal time', () => {
        expect(() => evaluateDocument({ ...request(), params: {} })).toThrow(/Parameter/);
        expect(() => evaluateDocument({ ...request(), params: { a: 11 } })).toThrow();
        expect(() => evaluateDocument({ ...request(), params: { a: 2, b: 3 } })).toThrow(/Unknown/);
        const document = createPreset('projectile'), frame = evaluateDocument({ ...request(document), time: 100 });
        expect(frame.time).toBe(.8);
        expect(frame.terminal).toBe(true);
        expect(frame.quantities.verticalVelocity.value).toBe(-4);
        document.time!.end = 'time+1';
        expect(() => normalizeDocument(document)).toThrow();
    });
    it('enforces safe integer domains independently of slider increments', () => {
        const document = createPreset('riemann-sums');
        expect(() => evaluateDocument({ ...request(document), params: { n: 1.5 } })).toThrow(/integer/);
        document.parameters.n.value = 1.5;
        expect(() => normalizeDocument(document)).toThrow(/integer default/);
        const continuous = base();
        continuous.parameters.a.step = 1;
        expect(evaluateDocument({ ...request(continuous), params: { a: 2.25 } }).quantities.result.value).toBe(4.5);
    });
    it('keeps missing observations and undefined/discontinuous samples as gaps', () => {
        const document = base();
        document.datasets = { data: { columns: [{ id: 'x', label: 'x' }, { id: 'y', label: 'y' }], rows: [[0, 1], [1, null], [2, 5]], description: 'Supplied' } };
        document.series = { observed: { label: 'Observed', dataset: 'data', xColumn: 'x', yColumn: 'y' }, singular: { label: 'Pole', y: '1/x', domain: [-1, 1], samples: 4 }, hole: { label: 'Hole', y: 'sqrt(x)', domain: [-1, 1], samples: 3 } };
        const frame = evaluateDocument(request(document));
        expect(frame.series.observed[1]).toEqual({ x: 1, y: null, reason: 'Missing dataset value.' });
        expect(frame.series.singular[2].y).toBeNull();
        expect(frame.series.singular[2].reason).toMatch(/discontinuity/);
        expect(frame.series.hole[0].y).toBeNull();
        expect(frame.series.hole[2].y).toBe(1);
    });
    it('classifies cosmetic revisions separately from scientific edits', async () => {
        const document = createPreset('wave'), initial = await documentIdentity(document);
        document.views[0].marks![0].style = { stroke: '#000000' };
        document.presentation = { columns: 2 };
        document.title = 'New title';
        const cosmetic = await documentIdentity(document);
        expect(cosmetic.modelRevision).toBe(initial.modelRevision);
        expect(cosmetic.presentationRevision).not.toBe(initial.presentationRevision);
        expect(cosmetic.documentRevision).not.toBe(initial.documentRevision);
        document.quantities.ordinate.expression = 'amplitude*cos(2*pi*frequency*probe)';
        expect((await documentIdentity(document)).modelRevision).not.toBe(initial.modelRevision);
    });
});
describe('browser worker transport boundaries', () => {
    it('serializes requests and validates replies', async () => {
        const workers: FakeWorker[] = [];
        const evaluator = createDocumentEvaluator(() => { const worker = new FakeWorker(); workers.push(worker); return worker as unknown as Worker; });
        const first = evaluator.evaluate(request()), second = evaluator.evaluate(request());
        expect(workers[0].messages).toHaveLength(1);
        workers[0].reply();
        expect((await first).quantities.result.value).toBe(4);
        expect(workers[0].messages).toHaveLength(2);
        workers[0].reply();
        await second;
        evaluator.dispose();
        expect(workers[0].terminated).toBe(true);
    });
    it('rejects corrupt results and recovers with a fresh worker', async () => {
        const workers: FakeWorker[] = [];
        const evaluator = createDocumentEvaluator(() => { const worker = new FakeWorker(); workers.push(worker); return worker as unknown as Worker; });
        const promise = evaluator.evaluate(request());
        const caught = expect(promise).rejects.toThrow(/invalid frame/);
        workers[0].respond({ type: 'result', id: workers[0].messages[0].id, frame: { time: 0 } });
        await caught;
        expect(workers[0].terminated).toBe(true);
        const next = evaluator.evaluate(request());
        workers[1].reply();
        await next;
        evaluator.dispose();
    });
    it('cancels queued requests without killing active work, and active cancellation restarts remaining work', async () => {
        const workers: FakeWorker[] = [];
        const evaluator = createDocumentEvaluator(() => { const worker = new FakeWorker(); workers.push(worker); return worker as unknown as Worker; });
        const active = new AbortController(), queued = new AbortController();
        const first = evaluator.evaluate(request(), active.signal), second = evaluator.evaluate(request(), queued.signal), third = evaluator.evaluate(request());
        const firstCheck = expect(first).rejects.toThrow(/cancelled/), secondCheck = expect(second).rejects.toThrow(/cancelled/);
        queued.abort();
        await secondCheck;
        expect(workers[0].terminated).toBe(false);
        active.abort();
        await firstCheck;
        expect(workers[0].terminated).toBe(true);
        workers[1].reply();
        await third;
        evaluator.dispose();
    });
    it('caps queued requests and validates input without invoking parameter accessors', async () => {
        const worker = new FakeWorker(), evaluator = createDocumentEvaluator(() => worker as unknown as Worker);
        let reads = 0;
        const params = {};
        Object.defineProperty(params, 'a', { enumerable: true, get() { reads++; return 2; } });
        await expect(evaluator.evaluate({ ...request(), params })).rejects.toThrow(/Invalid parameter/);
        expect(reads).toBe(0);
        const pending = Array.from({ length: 32 }, () => evaluator.evaluate(request()).catch(error => error));
        await expect(evaluator.evaluate(request())).rejects.toThrow(/32 evaluations/);
        evaluator.dispose();
        await Promise.all(pending);
    });
    it('rejects wrong quantity shapes even if every numeric component is finite', async () => {
        const worker = new FakeWorker(), evaluator = createDocumentEvaluator(() => worker as unknown as Worker), promise = evaluator.evaluate(request());
        const check = expect(promise).rejects.toThrow(/invalid frame/);
        const frame = evaluateDocument(request());
        frame.quantities.result.value = [4, 5];
        worker.respond({ type: 'result', id: worker.messages[0].id, frame });
        await check;
        evaluator.dispose();
    });
    it('times out workers and rejects pending requests on dispose', async () => {
        vi.useFakeTimers();
        const worker = new FakeWorker(), evaluator = createDocumentEvaluator(() => worker as unknown as Worker);
        const timed = evaluator.evaluate(request());
        const check = expect(timed).rejects.toThrow(/5 seconds/);
        await vi.advanceTimersByTimeAsync(5000);
        await check;
        expect(worker.terminated).toBe(true);
        const next = evaluator.evaluate(request());
        const nextCheck = expect(next).rejects.toThrow(/disposed/);
        evaluator.dispose();
        await nextCheck;
        await expect(evaluator.evaluate(request())).rejects.toThrow(/disposed/);
    });
});
