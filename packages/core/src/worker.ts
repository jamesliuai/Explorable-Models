import { asExperimentError, ExperimentError } from './errors.js';
import { clone, deepFreeze } from './identity.js';
import type { AnalyticModel, Evaluation, Manifest, ModelExecutor, ScalarParams, SerializedError, TimeDomain } from './types.js';
import { validateEvaluation, validateParameters, validateTimeDomain } from './validation.js';
interface WorkerLike {
    postMessage(message: unknown): void;
    addEventListener(type: string, listener: (event: any) => void): void;
    removeEventListener(type: string, listener: (event: any) => void): void;
    terminate(): void;
}
interface WorkerScope {
    postMessage(message: unknown): void;
    addEventListener(type: string, listener: (event: any) => void): void;
}
interface WorkerRequest {
    namespace: 'explorable-models';
    id: number;
    method: 'evaluate' | 'timeDomain';
    params: ScalarParams;
    time?: number;
}
interface WorkerResponse {
    namespace: 'explorable-models';
    id: number;
    ok: boolean;
    modelKind?: 'analytic' | 'parametric';
    result?: unknown;
    error?: SerializedError;
}
/** Executes model code in a dedicated worker and terminates it on a watchdog timeout. */
export class WorkerExecutor implements ModelExecutor {
    private nextId = 1;
    private disposed = false;
    private pending = new Map<number, {
        resolve: (result: unknown) => void;
        reject: (error: unknown) => void;
        timer: ReturnType<typeof setTimeout>;
    }>();
    private timeoutMs: number;
    private maxPending: number;
    constructor(private worker: WorkerLike, private manifest: Manifest, options: {
        timeoutMs?: number;
        maxPending?: number;
    } = {}) {
        this.timeoutMs = options.timeoutMs ?? 2000;
        this.maxPending = options.maxPending ?? 32;
        if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60000 || !Number.isInteger(this.maxPending) || this.maxPending < 1 || this.maxPending > 128)
            throw new ExperimentError('INVALID_PARAMETER', 'Invalid worker resource limits.');
        worker.addEventListener('message', this.onMessage);
        worker.addEventListener('error', this.onError);
        worker.addEventListener('messageerror', this.onError);
    }
    private onMessage = (event: {
        data: WorkerResponse;
    }) => {
        const response = event.data;
        if (response?.namespace !== 'explorable-models' || !Number.isInteger(response.id))
            return;
        const pending = this.pending.get(response.id);
        if (!pending)
            return;
        this.pending.delete(response.id);
        clearTimeout(pending.timer);
        if (response.modelKind !== this.manifest.kind)
            pending.reject(new ExperimentError('MODEL_ERROR', 'Worker model kind does not match the manifest.'));
        else if (response.ok === true)
            pending.resolve(response.result);
        else
            pending.reject(new ExperimentError(response.error?.code ?? 'MODEL_ERROR', response.error?.message ?? 'Worker execution failed.', response.error));
    };
    private onError = () => this.shutdown(new ExperimentError('MODEL_ERROR', 'The model worker failed. The last accepted frame is preserved.'));
    private shutdown(error: ExperimentError) {
        if (this.disposed)
            return;
        this.disposed = true;
        this.worker.removeEventListener('message', this.onMessage);
        this.worker.removeEventListener('error', this.onError);
        this.worker.removeEventListener('messageerror', this.onError);
        this.worker.terminate();
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
    }
    private request(method: WorkerRequest['method'], params: ScalarParams, time?: number): Promise<unknown> {
        if (this.disposed)
            return Promise.reject(new ExperimentError('MODEL_ERROR', 'Model worker has been terminated.'));
        if (this.pending.size >= this.maxPending)
            return Promise.reject(new ExperimentError('RESOURCE_LIMIT', 'Too many pending worker requests.'));
        return new Promise((resolve, reject) => {
            const id = this.nextId++;
            const timer = setTimeout(() => this.shutdown(new ExperimentError('TIMEOUT', `Model did not respond within ${this.timeoutMs} ms. The last accepted frame is preserved.`)), this.timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            try {
                this.worker.postMessage({ namespace: 'explorable-models', id, method, params, time } satisfies WorkerRequest);
            }
            catch (error) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(asExperimentError(error));
            }
        });
    }
    async evaluate(params: ScalarParams, time: number): Promise<Evaluation> {
        const checked = validateParameters(this.manifest, params);
        if (!Number.isFinite(time) || time < 0)
            throw new ExperimentError('OUT_OF_DOMAIN', 'Time must be finite and nonnegative.');
        return validateEvaluation(this.manifest, await this.request('evaluate', checked, time));
    }
    async timeDomain(params: ScalarParams): Promise<TimeDomain> { return validateTimeDomain(await this.request('timeDomain', validateParameters(this.manifest, params)), this.manifest.kind); }
    dispose() { this.shutdown(new ExperimentError('MODEL_ERROR', 'Model executor disposed.')); }
}
/** Call once from an authored model's bundled worker entry. This is not hostile-code isolation. */
export function exposeModelWorker<P extends ScalarParams>(model: AnalyticModel<P>, scope: WorkerScope = globalThis as unknown as WorkerScope): void {
    scope.addEventListener('message', async (event: {
        data: WorkerRequest;
    }) => {
        const request = event.data;
        if (request?.namespace !== 'explorable-models' || !Number.isInteger(request.id) || !['evaluate', 'timeDomain'].includes(request.method))
            return;
        try {
            const params = deepFreeze(clone(request.params)) as P;
            if (!params || typeof params !== 'object' || Array.isArray(params))
                throw new ExperimentError('INVALID_PARAMETER', 'Invalid worker parameters.');
            let result: unknown;
            if (request.method === 'timeDomain') {
                if (model.kind === 'analytic' && !model.timeDomain)
                    throw new ExperimentError('MODEL_ERROR', 'Analytic models require timeDomain.');
                result = model.kind === 'parametric' ? { start: 0, end: 0 } : model.timeDomain!(params);
            }
            else {
                if (typeof request.time !== 'number' || !Number.isFinite(request.time))
                    throw new ExperimentError('OUT_OF_DOMAIN', 'Invalid worker time.');
                result = model.evaluate(deepFreeze({ params, time: request.time }));
            }
            scope.postMessage({ namespace: 'explorable-models', id: request.id, ok: true, modelKind: model.kind, result } satisfies WorkerResponse);
        }
        catch (error) {
            scope.postMessage({ namespace: 'explorable-models', id: request.id, ok: false, modelKind: model.kind, error: asExperimentError(error).toJSON() } satisfies WorkerResponse);
        }
    });
}
/** Only for toolkit-owned reference models and unit tests. Never use for candidate source. */
export function trustedInlineExecutor<P extends ScalarParams>(model: AnalyticModel<P>, manifest: Manifest): ModelExecutor {
    return {
        async evaluate(params, time) { return validateEvaluation(manifest, model.evaluate(deepFreeze({ params: clone(params) as P, time }))); },
        async timeDomain(params) { if (model.kind === 'analytic' && !model.timeDomain)
            throw new ExperimentError('MODEL_ERROR', 'Analytic models require timeDomain.'); return validateTimeDomain(model.kind === 'parametric' ? { start: 0, end: 0 } : model.timeDomain!(deepFreeze(clone(params)) as P), manifest.kind); },
    };
}
