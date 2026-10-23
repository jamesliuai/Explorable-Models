import { DocumentError, type DocumentEvaluator, type DocumentFrame, type EvaluationRequest, type Diagnostic } from './types.js';
import { compileDocument } from './validation.js';
export const DOCUMENT_WORKER_TIMEOUT_MS = 5000;
export const DOCUMENT_WORKER_QUEUE_LIMIT = 32;
type Job = {
    id: string;
    request: EvaluationRequest;
    shapes: Record<string, number>;
    resolve: (frame: DocumentFrame) => void;
    reject: (error: unknown) => void;
    signal?: AbortSignal;
    abort: () => void;
};
const error = (code: string, message: string) => new DocumentError([{ code, path: '$', message }]);
const sameKeys = (a: unknown, b: object): a is Record<string, unknown> => !!a && typeof a === 'object' && !Array.isArray(a) && Object.keys(a).length === Object.keys(b).length && Object.keys(b).every(k => Object.hasOwn(a, k));
/** Compare against the bounded expected shape; never traverse unknown extra structures. */
function sameData(actual: unknown, expected: unknown): boolean {
    if (actual === expected)
        return true;
    if (Array.isArray(expected))
        return Array.isArray(actual) && actual.length === expected.length && expected.every((value, index) => sameData(actual[index], value));
    return !!expected && typeof expected === 'object' && sameKeys(actual, expected) && Object.entries(expected).every(([key, value]) => sameData(actual[key], value));
}
function validateFrame(value: unknown, request: EvaluationRequest, shapes: Record<string, number>): DocumentFrame {
    const bad = (): never => { throw error('WORKER_PROTOCOL', 'Worker returned an invalid frame.'); };
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return bad();
    const frame = value as DocumentFrame;
    if (Object.keys(frame).some(key => !['time', 'quantities', 'series', 'datasets', 'terminal', 'endTime'].includes(key)) || !Number.isFinite(frame.time) || frame.time < 0 || typeof frame.terminal !== 'boolean' || !(frame.endTime === null || typeof frame.endTime === 'number' && Number.isFinite(frame.endTime) && frame.endTime >= 0))
        return bad();
    if (request.document.time) {
        if (frame.endTime === null || frame.time !== Math.min(request.time, frame.endTime) || frame.terminal !== (frame.time === frame.endTime))
            return bad();
    }
    else if (frame.time !== 0 || frame.endTime !== null || frame.terminal)
        return bad();
    if (!sameKeys(frame.quantities, request.document.quantities) || !sameKeys(frame.series, request.document.series ?? {}))
        return bad();
    for (const [id, result] of Object.entries(frame.quantities)) {
        if (!result || typeof result !== 'object' || Object.keys(result).some(k => !['value', 'status', 'reason'].includes(k)))
            return bad();
        if (result.status === 'valid') {
            const expected = shapes[id];
            if (expected === 1 ? typeof result.value !== 'number' || !Number.isFinite(result.value) : !Array.isArray(result.value) || result.value.length !== expected || !result.value.every(n => typeof n === 'number' && Number.isFinite(n)))
                return bad();
            if (result.reason !== undefined)
                return bad();
        }
        else if (result.status !== 'undefined' || result.value !== null || typeof result.reason !== 'string' || !result.reason.length || result.reason.length > 2000)
            return bad();
    }
    for (const [id, points] of Object.entries(frame.series)) {
        const spec = request.document.series![id], length = spec.dataset ? request.document.datasets![spec.dataset].rows.length : spec.samples;
        if (!Array.isArray(points) || points.length !== length)
            return bad();
        for (const point of points) {
            if (!point || typeof point !== 'object' || Object.keys(point).some(k => !['x', 'y', 'reason'].includes(k)) || ![point.x, point.y].every(v => v === null || typeof v === 'number' && Number.isFinite(v)))
                return bad();
            if ((point.x === null || point.y === null) && (typeof point.reason !== 'string' || !point.reason.length) || point.reason !== undefined && (typeof point.reason !== 'string' || point.reason.length > 2000))
                return bad();
        }
    }
    if (!sameData(frame.datasets, request.document.datasets ?? {}))
        return bad();
    return structuredClone(frame);
}
/** One owned browser Worker per evaluator, serialized requests and request-scoped cancellation. */
export function createDocumentEvaluator(workerFactory: () => Worker = () => new Worker(new URL('./document-worker.js', import.meta.url), { type: 'module' })): DocumentEvaluator {
    let worker: Worker | undefined, active: Job | undefined, timer: ReturnType<typeof setTimeout> | undefined, disposed = false, sequence = 0;
    const queue: Job[] = [];
    function reset(): void {
        if (timer !== undefined)
            clearTimeout(timer);
        timer = undefined;
        if (worker) {
            worker.removeEventListener('message', message);
            worker.removeEventListener('error', workerError);
            worker.removeEventListener('messageerror', workerError);
            worker.terminate();
            worker = undefined;
        }
    }
    function complete(frame?: DocumentFrame, failure?: unknown): void {
        if (!active)
            return;
        const job = active;
        active = undefined;
        if (timer !== undefined)
            clearTimeout(timer);
        timer = undefined;
        job.signal?.removeEventListener('abort', job.abort);
        failure ? job.reject(failure) : job.resolve(frame!);
        pump();
    }
    function workerError(): void { reset(); complete(undefined, error('WORKER_ERROR', 'Document worker failed. The accepted document is unchanged.')); }
    function message(event: MessageEvent): void {
        if (!active)
            return;
        const reply = event.data;
        if (!reply || reply.id !== active.id)
            return;
        if (reply.type === 'error') {
            const diagnostics = reply.diagnostics as Diagnostic[];
            if (!Array.isArray(diagnostics) || !diagnostics.length || diagnostics.length > 32 || diagnostics.some(d => !d || typeof d.code !== 'string' || d.code.length > 100 || typeof d.path !== 'string' || d.path.length > 1000 || typeof d.message !== 'string' || d.message.length > 4000 || d.recovery !== undefined && (typeof d.recovery !== 'string' || d.recovery.length > 4000) || Object.keys(d).some(key => !['code', 'path', 'message', 'recovery'].includes(key)))) {
                reset();
                complete(undefined, error('WORKER_PROTOCOL', 'Malformed worker error.'));
            }
            else
                complete(undefined, new DocumentError(structuredClone(diagnostics)));
            return;
        }
        if (reply.type !== 'result') {
            reset();
            complete(undefined, error('WORKER_PROTOCOL', 'Unknown worker response.'));
            return;
        }
        try {
            complete(validateFrame(reply.frame, active.request, active.shapes));
        }
        catch (failure) {
            reset();
            complete(undefined, failure);
        }
    }
    function pump(): void {
        if (disposed || active)
            return;
        active = queue.shift();
        if (!active)
            return;
        try {
            if (!worker) {
                worker = workerFactory();
                worker.addEventListener('message', message);
                worker.addEventListener('error', workerError);
                worker.addEventListener('messageerror', workerError);
            }
            timer = setTimeout(() => { reset(); complete(undefined, error('WORKER_TIMEOUT', 'Document evaluation exceeded 5 seconds.')); }, DOCUMENT_WORKER_TIMEOUT_MS);
            worker.postMessage({ type: 'evaluate', id: active.id, request: active.request });
        }
        catch (failure) {
            reset();
            complete(undefined, error('WORKER_START', failure instanceof Error ? failure.message : 'Worker could not start.'));
        }
    }
    return {
        evaluate(request, signal) {
            if (disposed)
                return Promise.reject(error('DISPOSED', 'Evaluator has been disposed.'));
            if (signal?.aborted)
                return Promise.reject(error('CANCELLED', 'Evaluation was cancelled.'));
            if (queue.length + (active ? 1 : 0) >= DOCUMENT_WORKER_QUEUE_LIMIT)
                return Promise.reject(error('LIMIT', 'At most 32 evaluations may be pending.'));
            let normalized: EvaluationRequest, shapes: Record<string, number>;
            try {
                const compiled = compileDocument(request.document);
                if (!sameKeys(request.params, compiled.document.parameters) || !Number.isFinite(request.time) || request.time < 0)
                    throw error('EVALUATION', 'Expected exact parameter keys and finite nonnegative time.');
                const params: Record<string, number> = {};
                for (const [id, spec] of Object.entries(compiled.document.parameters)) {
                    const descriptor = Object.getOwnPropertyDescriptor(request.params, id);
                    const value = descriptor && 'value' in descriptor ? descriptor.value : undefined;
                    if (typeof value !== 'number' || !Number.isFinite(value) || value < spec.min || value > spec.max || spec.integer && !Number.isSafeInteger(value))
                        throw error('EVALUATION', `Invalid parameter '${id}'.`);
                    params[id] = value;
                }
                normalized = { document: compiled.document, params, time: request.time };
                shapes = Object.fromEntries(Object.keys(compiled.document.quantities).map(id => [id, compiled.types[id].size]));
            }
            catch (failure) {
                return Promise.reject(failure);
            }
            return new Promise((resolve, reject) => {
                const job: Job = { id: `evaluation-${++sequence}`, request: normalized, shapes, resolve, reject, signal, abort: () => {
                        if (active === job) {
                            reset();
                            complete(undefined, error('CANCELLED', 'Evaluation was cancelled.'));
                        }
                        else {
                            const index = queue.indexOf(job);
                            if (index >= 0)
                                queue.splice(index, 1);
                            signal?.removeEventListener('abort', job.abort);
                            reject(error('CANCELLED', 'Evaluation was cancelled.'));
                        }
                    } };
                signal?.addEventListener('abort', job.abort, { once: true });
                queue.push(job);
                pump();
            });
        },
        dispose() {
            if (disposed)
                return;
            disposed = true;
            reset();
            const jobs = active ? [active, ...queue] : [...queue];
            active = undefined;
            queue.length = 0;
            for (const job of jobs) {
                job.signal?.removeEventListener('abort', job.abort);
                job.reject(error('DISPOSED', 'Evaluator has been disposed.'));
            }
        }
    };
}
