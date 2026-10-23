import { DocumentError, type DocumentFrame, type EvaluationRequest, type ValueResult } from './types.js';
import { compileDocument, type CompiledDocument } from './validation.js';
import { evaluateExpression, crossesKnownDiscontinuity } from './expressions.js';
const valid = (value: number): ValueResult => ({ value, status: 'valid' });
const undefinedValue = (reason: string): ValueResult => ({ value: null, status: 'undefined', reason });
/** Trusted bounded interpreter. Hosts use createDocumentEvaluator; authored documents execute in its worker. */
export function evaluateDocument(request: EvaluationRequest): DocumentFrame { return evaluateCompiledDocument(compileDocument(request.document), request.params, request.time); }
export function evaluateCompiledDocument(compiled: CompiledDocument, params: Record<string, number>, requestedTime: number): DocumentFrame {
    const { document } = compiled;
    const fail = (path: string, message: string): never => { throw new DocumentError([{ code: 'EVALUATION', path, message }]); };
    if (!params || typeof params !== 'object' || Array.isArray(params))
        fail('params', 'Expected a parameter object.');
    for (const key of Object.keys(params))
        if (!Object.hasOwn(document.parameters, key))
            fail(`params.${key}`, 'Unknown parameter.');
    for (const [key, spec] of Object.entries(document.parameters)) {
        const value = params[key];
        if (typeof value !== 'number' || !Number.isFinite(value) || value < spec.min || value > spec.max || spec.integer && !Number.isSafeInteger(value))
            fail(`params.${key}`, 'Parameter must be finite, within bounds, and a safe integer when required.');
    }
    if (!Number.isFinite(requestedTime) || requestedTime < 0)
        fail('time', 'Time must be finite and nonnegative.');
    const evaluateQuantities = (time: number): Record<string, ValueResult> => {
        const quantities: Record<string, ValueResult> = Object.create(null);
        const resolve = (name: string): ValueResult => name === 'time' ? valid(time) : Object.hasOwn(params, name) ? valid(params[name]) : quantities[name] ?? undefinedValue(`Unknown reference '${name}'.`);
        for (const id of compiled.order)
            quantities[id] = evaluateExpression(compiled.expressions[id], resolve);
        return quantities;
    };
    let endTime: number | null = null;
    if (compiled.end) {
        const initial = evaluateQuantities(0);
        const result = evaluateExpression(compiled.end, name => name === 'time' ? valid(0) : Object.hasOwn(params, name) ? valid(params[name]) : initial[name] ?? undefinedValue(`Unknown reference '${name}'.`));
        if (result.status !== 'valid' || typeof result.value !== 'number' || result.value < 0)
            fail('time.end', result.reason ?? 'Time end must evaluate to a finite nonnegative scalar.');
        endTime = result.value as number;
    }
    const time = document.time ? Math.min(requestedTime, endTime!) : 0, quantities = evaluateQuantities(time);
    const series: DocumentFrame['series'] = Object.create(null);
    for (const [id, spec] of Object.entries(document.series ?? {})) {
        if (spec.dataset) {
            const dataset = document.datasets![spec.dataset], x = dataset.columns.findIndex(c => c.id === spec.xColumn), y = dataset.columns.findIndex(c => c.id === spec.yColumn);
            series[id] = dataset.rows.map(row => row[x] === null || row[y] === null ? { x: row[x], y: row[y], reason: 'Missing dataset value.' } : { x: row[x], y: row[y] });
        }
        else {
            const [start, end] = spec.domain!, count = spec.samples!, asts = compiled.series[id];
            series[id] = Array.from({ length: count }, (_, i) => { const sample = i === count - 1 ? end : start + (end - start) * i / (count - 1); const resolve = (name: string): ValueResult => name === spec.variable ? valid(sample) : name === 'time' ? valid(time) : Object.hasOwn(params, name) ? valid(params[name]) : quantities[name] ?? undefinedValue(`Unknown reference '${name}'.`); const x = evaluateExpression(asts.x, resolve), y = evaluateExpression(asts.y, resolve); if (i > 0) {
                const previous = start + (end - start) * (i - 1) / (count - 1);
                const before = (name: string) => name === spec.variable ? valid(previous) : resolve(name);
                if (crossesKnownDiscontinuity(asts.x, before, resolve) || crossesKnownDiscontinuity(asts.y, before, resolve))
                    return { x: x.status === 'valid' ? x.value as number : null, y: null, reason: 'Sample interval crosses a known division or tangent discontinuity.' };
            } return x.status === 'valid' && y.status === 'valid' ? { x: x.value as number, y: y.value as number } : { x: x.status === 'valid' ? x.value as number : null, y: y.status === 'valid' ? y.value as number : null, reason: x.reason ?? y.reason ?? 'Undefined sample.' }; });
        }
    }
    return { time, quantities, series, datasets: structuredClone(document.datasets ?? {}), terminal: document.time ? time === endTime : false, endTime };
}
