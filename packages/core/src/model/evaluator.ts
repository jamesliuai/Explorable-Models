/**
 * Worker-backed model evaluator. Mirrors `createDocumentEvaluator`: one owned worker created lazily, serialized jobs,
 * request-scoped AbortSignal cancellation, a watchdog that terminates and later recreates a nonresponding worker,
 * termination on malformed or unknown replies, main-thread validation of every reply, a bounded queue and disposal
 * that rejects all pending work. Replies for a job that was cancelled, timed out or superseded are ignored.
 */
import type { Diagnostic } from '../declarative/types.js';
import { checkParameters } from './constraints.js';
import { diagnostic, fail, ModelError, modelError } from './errors.js';
import { checkPosition, validateKernelOutput, type ResolvedPosition } from './frame.js';
import { analyzeManifest, isValidatedManifest } from './manifest.js';
import type { EvaluationData } from './protocol.js';
import type { FramePosition, ModelEvaluationRequest, ModelEvaluator, ModelManifest } from './types.js';

export const MODEL_WORKER_TIMEOUT_MS = 5000;
export const MODEL_WORKER_QUEUE_LIMIT = 32;
export interface ModelEvaluatorOptions { timeoutMs?: number; queueLimit?: number }

type Job = {
  id: string;
  manifest: ModelManifest;
  params: Record<string, number>;
  position: ResolvedPosition;
  posted: ModelEvaluationRequest;
  resolve: (data: EvaluationData) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  abort: () => void;
};
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const protocol = (message: string): ModelError => modelError('WORKER_PROTOCOL', '$.reply', message);
const hasExactly = (value: Record<string, unknown>, keys: string[]): boolean => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

function validDiagnostics(value: unknown): value is Diagnostic[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 32 && value.every(item => isObject(item)
    && Object.keys(item).every(key => ['code', 'path', 'message', 'recovery'].includes(key))
    && typeof item.code === 'string' && CODE.test(item.code) && typeof item.path === 'string' && item.path.length <= 1000
    && typeof item.message === 'string' && item.message.length <= 4000 && (item.recovery === undefined || typeof item.recovery === 'string' && item.recovery.length <= 4000));
}

/** Main-thread validation of a worker result against the request that produced it. */
function validateReply(job: Job, value: unknown): EvaluationData {
  if (!isObject(value) || !hasExactly(value, ['params', 'position', 'terminal', 'quantities', 'geometry'])) throw protocol('Worker result has an invalid envelope.');
  const params = value.params;
  if (!isObject(params) || !hasExactly(params, Object.keys(job.params)) || Object.entries(job.params).some(([id, expected]) => !Object.is(params[id], expected))) throw protocol('Worker result was computed for different parameters.');
  const raw = value.position;
  let position: FramePosition;
  if (!isObject(raw) || raw.kind !== job.position.kind) throw protocol('Worker result has a different position kind.');
  if (job.position.kind === 'index') {
    if (!hasExactly(raw, ['kind', 'index', 'maxIndex']) || raw.index !== job.position.index || raw.maxIndex !== job.position.maxIndex) throw protocol('Worker result was computed for a different index.');
    position = { kind: 'index', index: job.position.index, maxIndex: job.position.maxIndex };
  } else if (job.position.kind === 'time') {
    const end = raw.endTime;
    if (!hasExactly(raw, ['kind', 'time', 'endTime']) || typeof end !== 'number' || !Number.isFinite(end) || end < 0 || raw.time !== Math.min(job.position.time, end)) throw protocol('Worker result was computed for a different time.');
    position = { kind: 'time', time: raw.time as number, endTime: end };
  } else {
    if (!hasExactly(raw, ['kind'])) throw protocol('Worker result has an invalid static position.');
    position = { kind: 'static' };
  }
  // A reply carries the observed geometry the worker attached; it must equal the manifest dataset exactly.
  const output = validateKernelOutput(job.manifest, position, { quantities: value.quantities, geometry: value.geometry, terminal: value.terminal }, { observations: 'included' });
  return { params: { ...job.params }, position, terminal: output.terminal, quantities: output.quantities, geometry: output.geometry };
}

/** Validates and normalizes a request on the main thread before anything is posted. */
function prepare(request: ModelEvaluationRequest): Pick<Job, 'manifest' | 'params' | 'position' | 'posted'> {
  if (!isObject(request) || !hasExactly(request as unknown as Record<string, unknown>, ['manifest', 'params', 'position'])) fail('INVALID_INPUT', '$.request', 'Expected { manifest, params, position }.');
  const manifest = isValidatedManifest(request.manifest) ? request.manifest : analyzeManifest(request.manifest).manifest;
  const problems = checkParameters(manifest, request.params);
  if (problems.length) throw new ModelError(problems);
  const params = Object.fromEntries(Object.keys(manifest.parameters).map(id => [id, request.params[id]]));
  const position = checkPosition(manifest, request.position);
  const posted = { manifest, params, position: position.kind === 'index' ? { kind: 'index' as const, index: position.index } : position };
  return { manifest, params, position, posted };
}

const boundedOption = (value: number | undefined, fallback: number, max: number, name: string): number => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) fail('INVALID_INPUT', `$.options.${name}`, `Expected an integer from 1 to ${max}.`);
  return value;
};

export function createModelEvaluator(workerFactory: () => Worker, options: ModelEvaluatorOptions = {}): ModelEvaluator {
  if (typeof workerFactory !== 'function') fail('INVALID_INPUT', '$.workerFactory', 'A worker factory for the installed kernel worker is required.');
  const timeoutMs = boundedOption(options.timeoutMs, MODEL_WORKER_TIMEOUT_MS, 600_000, 'timeoutMs');
  const queueLimit = boundedOption(options.queueLimit, MODEL_WORKER_QUEUE_LIMIT, 1024, 'queueLimit');
  let worker: Worker | undefined, active: Job | undefined, timer: ReturnType<typeof setTimeout> | undefined, disposed = false, sequence = 0;
  const queue: Job[] = [];
  const nonce = Math.random().toString(36).slice(2, 10);

  function reset(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (!worker) return;
    const current = worker;
    worker = undefined;
    current.removeEventListener('message', message);
    current.removeEventListener('error', workerError);
    current.removeEventListener('messageerror', workerError);
    current.terminate();
  }
  function complete(data?: EvaluationData, failure?: unknown): void {
    if (!active) return;
    const job = active;
    active = undefined;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    job.signal?.removeEventListener('abort', job.abort);
    if (failure) job.reject(failure); else job.resolve(data!);
    pump();
  }
  function workerError(): void { reset(); complete(undefined, modelError('WORKER_ERROR', '$', 'The model worker failed. The last accepted state is unchanged.')); }
  function message(event: MessageEvent): void {
    if (!active) return;
    const reply = event.data;
    if (!isObject(reply) || typeof reply.id !== 'string') { reset(); complete(undefined, protocol('Malformed worker reply.')); return; }
    // A reply for another job is late (cancelled, timed out or from before a restart) and is ignored.
    if (reply.id !== active.id) return;
    if (reply.type === 'error') {
      if (!hasExactly(reply, ['type', 'id', 'diagnostics']) || !validDiagnostics(reply.diagnostics)) { reset(); complete(undefined, protocol('Malformed worker error.')); return; }
      complete(undefined, new ModelError(structuredClone(reply.diagnostics)));
      return;
    }
    if (reply.type !== 'result' || !hasExactly(reply, ['type', 'id', 'data'])) { reset(); complete(undefined, protocol('Unknown worker reply.')); return; }
    let data: EvaluationData;
    try { data = validateReply(active, reply.data); } catch (failure) { reset(); complete(undefined, failure instanceof ModelError ? failure : protocol('Invalid worker result.')); return; }
    complete(data);
  }
  function pump(): void {
    if (disposed || active) return;
    active = queue.shift();
    if (!active) return;
    const job = active;
    try {
      if (!worker) {
        worker = workerFactory();
        worker.addEventListener('message', message);
        worker.addEventListener('error', workerError);
        worker.addEventListener('messageerror', workerError);
      }
      timer = setTimeout(() => { if (active !== job) return; reset(); complete(undefined, modelError('WORKER_TIMEOUT', '$', `Model evaluation exceeded ${timeoutMs} ms; the worker was terminated.`)); }, timeoutMs);
      worker.postMessage({ type: 'evaluate', id: job.id, request: job.posted });
    } catch {
      reset();
      complete(undefined, modelError('WORKER_ERROR', '$', 'The model worker could not start.'));
    }
  }
  const evaluator: ModelEvaluator = {
    evaluate(request, signal) {
      if (disposed) return Promise.reject(modelError('DISPOSED', '$', 'The evaluator has been disposed.'));
      if (signal?.aborted) return Promise.reject(modelError('CANCELLED', '$', 'Evaluation was cancelled.'));
      if (queue.length + (active ? 1 : 0) >= queueLimit) return Promise.reject(modelError('RESOURCE_LIMIT', '$', `At most ${queueLimit} evaluations may be pending.`));
      let prepared: ReturnType<typeof prepare>;
      try { prepared = prepare(request); } catch (failure) { return Promise.reject(failure); }
      return new Promise<EvaluationData>((resolve, reject) => {
        const job: Job = {
          ...prepared, id: `model-${nonce}-${++sequence}`, resolve, reject, signal,
          abort: () => {
            if (active === job) { reset(); complete(undefined, modelError('CANCELLED', '$', 'Evaluation was cancelled.')); return; }
            const index = queue.indexOf(job);
            if (index >= 0) queue.splice(index, 1);
            signal?.removeEventListener('abort', job.abort);
            reject(modelError('CANCELLED', '$', 'Evaluation was cancelled.'));
          },
        };
        signal?.addEventListener('abort', job.abort, { once: true });
        queue.push(job);
        pump();
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      reset();
      const jobs = active ? [active, ...queue] : [...queue];
      active = undefined;
      queue.length = 0;
      for (const job of jobs) { job.signal?.removeEventListener('abort', job.abort); job.reject(new ModelError([diagnostic('DISPOSED', '$', 'The evaluator has been disposed.')])); }
    },
    get disposed() { return disposed; },
  };
  return evaluator;
}
