/**
 * Model worker protocol. Requests carry installed IDs and data only, never source. The worker re-validates the
 * manifest, parameters and position, runs the selected pure kernel (or the bounded schema 2.0 interpreter for
 * document executions) and validates its own output before replying. The main thread validates every reply again.
 */
import { NUMERICAL_LIMIT_REASONS } from '../declarative/expressions.js';
import { DocumentError, type Diagnostic, type DocumentFrame, type ValueResult } from '../declarative/types.js';
import type { CompiledDocument } from '../declarative/validation.js';
import { checkParameters } from './constraints.js';
import { documentExecution } from './document-support.js';
import { diagnostic, ModelError, toDiagnostics } from './errors.js';
import { attachObservations, checkPosition, validateKernelOutput, type ResolvedPosition } from './frame.js';
import { analyzeManifest } from './manifest.js';
import type { FramePosition, GeometryGap, GeometryResult, KernelOutput, ModelEvaluationRequest, ModelFrame, ModelKernel, ModelManifest, PolylineSegment, QuantityResult, Vec2 } from './types.js';

export const MODEL_WORKER_PROTOCOL = 'explorable-models.model-worker/1.0' as const;
export type EvaluationData = Omit<ModelFrame, 'frameId' | 'run' | 'model'>;
export interface EvaluateMessage { type: 'evaluate'; id: string; request: ModelEvaluationRequest }
export type WorkerReply = { type: 'result'; id: string; data: EvaluationData } | { type: 'error'; id: string; diagnostics: Diagnostic[] };
export interface WorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener?(type: 'message', listener: (event: MessageEvent) => void): void;
  postMessage(message: unknown): void;
}
const MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/**
 * Maps one interpreter result to the model contract (D10, A11): a numerical limit (overflow, or a nonzero value that
 * underflowed to 0 or depends on one) is `numerical-limit` and never `undefined` or 0; a reduced-precision value is
 * valid with an UNDERFLOW approximation; mathematical undefinedness keeps its reason.
 */
const quantityFrom = (result: ValueResult): QuantityResult => {
  if (result.limit) return { status: 'numerical-limit', code: result.limit, reason: (result.reason ?? NUMERICAL_LIMIT_REASONS[result.limit === 'OVERFLOW' ? 'overflow' : 'underflow']).slice(0, 2000) };
  if (result.status === 'valid' && result.value !== null) {
    const value = Array.isArray(result.value) ? [...result.value] : result.value;
    return result.approximation ? { status: 'valid', value, approximation: { code: 'UNDERFLOW', reason: NUMERICAL_LIMIT_REASONS.approximation } } : { status: 'valid', value };
  }
  return { status: 'undefined', code: 'UNDEFINED', reason: (result.reason ?? 'The value is undefined.').slice(0, 2000) };
};

/**
 * Splits a sampled series at missing points. Consecutive defined samples form one segment; a run of undefined samples
 * becomes one gap carrying the first sample's reason. Lines never connect across a gap. `after`/`before` are the
 * indices of the segments on either side (null at an end).
 */
export function seriesToPolyline(points: { x: number | null; y: number | null; reason?: string }[], sampling?: { samples: number; domain: [number, number] }): Extract<GeometryResult, { kind: 'polyline2' }> {
  const segments: PolylineSegment<Vec2>[] = [];
  const gaps: GeometryGap[] = [];
  let current: Vec2[] | null = null, pendingGap: string | null = null;
  for (const point of points) {
    if (point.x !== null && point.y !== null && point.reason === undefined) {
      if (!current) {
        if (pendingGap !== null) { gaps.push({ after: segments.length ? segments.length - 1 : null, before: segments.length, reason: pendingGap }); pendingGap = null; }
        current = [];
        segments.push({ points: current, start: 'none', end: 'none' });
      }
      current.push([point.x, point.y]);
    } else {
      current = null;
      pendingGap ??= (point.reason ?? 'Undefined sample.').slice(0, 2000);
    }
  }
  if (pendingGap !== null) gaps.push({ after: segments.length ? segments.length - 1 : null, before: null, reason: pendingGap });
  return { kind: 'polyline2', segments, gaps, ...(sampling && { sampling }) };
}

/**
 * Adapts a schema 2.0 document frame to model evaluation data. Model series (sampled expressions, and dataset series a
 * document explicitly labels `kind: 'model'`) become polyline2 geometry. Observed series (dataset series, `observed` by
 * default) keep their distinction: they are not converted into a connected polyline here; the runtime attaches them as
 * `observations2` geometry from the manifest dataset, which validation requires to equal the document dataset exactly.
 */
export function documentOutput(compiled: CompiledDocument, frame: DocumentFrame): { position: FramePosition; output: KernelOutput } {
  const document = compiled.document;
  const quantities: Record<string, QuantityResult> = {};
  for (const id of Object.keys(document.quantities)) quantities[id] = quantityFrom(frame.quantities[id]);
  const geometry: Record<string, GeometryResult> = {};
  for (const [id, spec] of Object.entries(document.series ?? {})) {
    if (spec.kind === 'observed') continue;
    geometry[id] = seriesToPolyline(frame.series[id], spec.dataset ? undefined : { samples: spec.samples!, domain: [spec.domain![0], spec.domain![1]] });
  }
  const position: FramePosition = document.time ? { kind: 'time', time: frame.time, endTime: frame.endTime } : { kind: 'static' };
  const terminal = document.time && frame.terminal ? { reached: true, event: 'end-time' as const } : { reached: false };
  return { position, output: { quantities, geometry, terminal } };
}

/**
 * Evaluates one request inside the worker (or a trusted test seam). Throws ModelError with bounded diagnostics;
 * kernel exceptions become a generic WORKER_ERROR without message or stack.
 */
export function evaluateRequest(request: unknown, kernels: readonly ModelKernel[]): EvaluationData {
  if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some(key => !['manifest', 'params', 'position'].includes(key)))
    throw new ModelError([diagnostic('INVALID_INPUT', '$.request', 'Expected { manifest, params, position }.')]);
  const { manifest: input, params: rawParams, position: rawPosition } = request as ModelEvaluationRequest;
  const { manifest, compiled } = analyzeManifest(input);
  const execution = manifest.execution;
  let kernel: ModelKernel | undefined;
  if (execution.kind === 'kernel') {
    kernel = kernels.find(item => item.id === execution.kernelId && item.version === execution.kernelVersion);
    if (!kernel) throw new ModelError([diagnostic('UNSUPPORTED_CAPABILITY', '$.manifest.execution', 'The requested kernel version is not installed.', 'Use a model from the installed catalogue.')]);
    if (kernel.mode !== execution.mode) throw new ModelError([diagnostic('UNSUPPORTED_CAPABILITY', '$.manifest.execution.mode', 'The installed kernel has a different execution mode.')]);
  }
  const problems = checkParameters(manifest, rawParams);
  if (problems.length) throw new ModelError(problems);
  const params = Object.fromEntries(Object.keys(manifest.parameters).map(id => [id, (rawParams as Record<string, number>)[id]]));
  const position = checkPosition(manifest, rawPosition);
  if (kernel) return evaluateKernel(manifest, kernel, params, position);
  let frame: DocumentFrame;
  try { frame = documentExecution('$.manifest.execution').evaluate(compiled!, params, position.kind === 'time' ? position.time : 0, { numericalLimits: true }); } catch (error) {
    if (error instanceof DocumentError) throw new ModelError(error.diagnostics.slice(0, 8).map(item => diagnostic('UNDEFINED_CALCULATION', `$.manifest.execution.document${item.path.startsWith('$') ? item.path.slice(1) : `.${item.path}`}`, item.message.slice(0, 1000))));
    throw new ModelError([diagnostic('WORKER_ERROR', '$', 'Document evaluation failed.')]);
  }
  const adapted = documentOutput(compiled!, frame);
  return { params, position: adapted.position, ...attachObservations(manifest, validateKernelOutput(manifest, adapted.position, adapted.output)) };
}

function evaluateKernel(manifest: ModelManifest, kernel: ModelKernel, params: Record<string, number>, position: ResolvedPosition): EvaluationData {
  const framePosition: FramePosition = position.kind === 'index' ? { kind: 'index', index: position.index, maxIndex: position.maxIndex } : { kind: 'static' };
  let output: unknown;
  try { output = kernel.evaluate({ params: Object.freeze({ ...params }), index: position.kind === 'index' ? position.index : 0 }); } catch {
    throw new ModelError([diagnostic('WORKER_ERROR', '$', 'The installed kernel failed for these parameters.')]);
  }
  try { return { params, position: framePosition, ...attachObservations(manifest, validateKernelOutput(manifest, framePosition, output)) }; } catch (error) {
    // The kernel, not the message channel, produced invalid output.
    throw new ModelError(toDiagnostics(error).map(item => ({ ...item, code: 'WORKER_ERROR', message: `The installed kernel returned an invalid frame: ${item.message}` })));
  }
}

/**
 * Installed kernels served by identity, with their code loaded on first use (additive): a worker that serves several
 * kernels then fetches only the code of the kernels its requests name. `kernels` lists exactly what is installed; a
 * request naming anything else is refused without loading.
 */
export interface KernelSource {
  readonly kernels: readonly { readonly id: string; readonly version: string; readonly mode: ModelKernel['mode'] }[];
  load(id: string, version: string): Promise<ModelKernel>;
}

/**
 * Serves `{ type: 'evaluate', id, request }` messages on a worker scope with the installed kernels. Replies
 * `{ type: 'result', id, data }` or `{ type: 'error', id, diagnostics }`. Returns a function that stops serving.
 *
 * With a kernel list, every request is answered synchronously. With a `KernelSource`, requests are answered in arrival
 * order; a request naming an installed kernel whose code is not loaded yet waits for it (one load per kernel; a failed
 * load is a WORKER_ERROR reply and is retried by a later request). A loaded kernel must have the listed identity and mode.
 */
export function serveModelWorker(scope: WorkerScope, kernels: readonly ModelKernel[] | KernelSource): () => void {
  const source = Array.isArray(kernels) ? null : kernels as KernelSource;
  const identities = source ? [...source.kernels] : [...kernels as readonly ModelKernel[]];
  const keys = new Set<string>();
  for (const kernel of identities) {
    const key = `${kernel.id}@${kernel.version}`;
    if (keys.has(key)) throw new ModelError([diagnostic('INVALID_INPUT', '$.kernels', `Kernel ${key} is installed twice.`)]);
    keys.add(key);
  }
  const installed = source ? [] : [...kernels as readonly ModelKernel[]];
  const evaluate = (message: Partial<EvaluateMessage> & { id: string }, available: readonly ModelKernel[]): WorkerReply => {
    if (message.type !== 'evaluate') return { type: 'error', id: message.id, diagnostics: [diagnostic('INVALID_INPUT', '$.type', 'Unsupported worker message.')] };
    try { return { type: 'result', id: message.id, data: evaluateRequest(message.request, available) }; } catch (error) {
      return { type: 'error', id: message.id, diagnostics: toDiagnostics(error) };
    }
  };
  // On-demand kernels: loaded once per identity; evaluation itself stays synchronous once the code is present.
  const loaded = new Map<string, Promise<ModelKernel>>();
  const kernelFor = async (request: unknown): Promise<ModelKernel[]> => {
    const execution = (request as { manifest?: { execution?: { kind?: unknown; kernelId?: unknown; kernelVersion?: unknown } } } | null)?.manifest?.execution;
    if (!execution || execution.kind !== 'kernel' || typeof execution.kernelId !== 'string' || typeof execution.kernelVersion !== 'string') return [];
    const key = `${execution.kernelId}@${execution.kernelVersion}`;
    const listed = identities.find(item => `${item.id}@${item.version}` === key);
    // Not installed: no load is attempted; evaluateRequest refuses the request (UNSUPPORTED_CAPABILITY).
    if (!listed) return [];
    let pending = loaded.get(key);
    if (!pending) {
      pending = source!.load(listed.id, listed.version).then(kernel => {
        if (!kernel || kernel.id !== listed.id || kernel.version !== listed.version || kernel.mode !== listed.mode || typeof kernel.evaluate !== 'function') throw new TypeError('mismatch');
        return kernel;
      });
      loaded.set(key, pending);
      pending.catch(() => { if (loaded.get(key) === pending) loaded.delete(key); });
    }
    try { return [await pending]; } catch {
      throw new ModelError([diagnostic('WORKER_ERROR', '$.manifest.execution', 'The installed kernel could not be loaded in the worker.')]);
    }
  };
  let queue: Promise<void> = Promise.resolve();
  const listener = (event: MessageEvent): void => {
    const message = event.data as Partial<EvaluateMessage> | null;
    if (!message || typeof message !== 'object' || typeof message.id !== 'string' || !MESSAGE_ID.test(message.id)) return;
    const identified = message as Partial<EvaluateMessage> & { id: string };
    if (!source) { scope.postMessage(evaluate(identified, installed)); return; }
    queue = queue.then(async () => {
      let reply: WorkerReply;
      try { reply = evaluate(identified, message.type === 'evaluate' ? await kernelFor(message.request) : []); } catch (error) {
        reply = { type: 'error', id: identified.id, diagnostics: toDiagnostics(error) };
      }
      scope.postMessage(reply);
    });
  };
  scope.addEventListener('message', listener);
  return () => scope.removeEventListener?.('message', listener);
}
