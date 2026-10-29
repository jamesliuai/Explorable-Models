/**
 * Fixed toolkit page of the worker-backed authoring commands. It contains no authored code: every model evaluation
 * goes through `createModelEvaluator` (the runtime's own worker client) to `worker-model.js`, and author checks and
 * mutation batches run in `worker-checks.js`. Comparisons with reference fixtures use the toolkit's fixture module.
 * Driven by the CLI through `window.__activityAuthor.request(method, json)`.
 */
import { createModelEvaluator, toDiagnostics, validateManifest, type GeometryResult, type ModelEvaluator, type ModelManifest, type PositionRequest } from '@experiment-kit/core/model';
import {
  classifyOutcome, domainProbes, mutationsFor, pointPosition, pointProblems, rejectionProblems, statusMismatches, statusText, uncoveredQuantities,
  type BoundaryCase, type BoundaryOutcome, type Mutation, type PointOutcome, type ReferenceSuite,
} from './activity-fixtures.js';
import { AUTHOR_NAMESPACE, type AuthorReply, type CheckResult, type MutationResult } from './activity-worker.js';
import type { GeometrySummary } from './activity-packet.js';

interface Harness { ready: boolean; error?: string; request(method: string, input: string): Promise<unknown> }
declare global { interface Window { __activityAuthor?: Harness } }

const DEFAULT_TIMEOUT_MS = 5000;
const workerUrl = (file: string) => new URL(`./${file}`, location.href);
let counter = 0;

/** One request to a fresh worker; resolves with its reply, or rejects with the load error, a timeout or a protocol error. */
function workerCall<T>(file: string, message: Record<string, unknown>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const worker = new Worker(workerUrl(file), { type: 'module' });
    const requestId = `author-${++counter}`;
    const finish = (action: () => void) => { clearTimeout(timer); worker.terminate(); action(); };
    const timer = setTimeout(() => finish(() => reject({ code: 'WORKER_TIMEOUT', message: `The candidate worker did not answer within ${timeoutMs} ms; it was terminated.` })), timeoutMs);
    worker.addEventListener('error', (event: ErrorEvent) => {
      event.preventDefault();
      finish(() => reject({ code: 'WORKER_ERROR', message: `The candidate worker failed: ${event.message || 'the module could not be loaded'}.` }));
    });
    worker.addEventListener('messageerror', () => finish(() => reject({ code: 'WORKER_PROTOCOL', message: 'The candidate worker sent a message that could not be read.' })));
    worker.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as AuthorReply | null;
      if (!data || data.namespace !== AUTHOR_NAMESPACE || data.requestId !== requestId) return;
      finish(() => data.ok ? resolve(data.result as T) : reject(data.error));
    });
    worker.postMessage({ namespace: AUTHOR_NAMESPACE, requestId, ...message });
  });
}

const asFailure = (error: unknown): { code: string; message: string } =>
  error && typeof error === 'object' && 'code' in error && 'message' in error ? { code: String((error as { code: unknown }).code), message: String((error as { message: unknown }).message) }
    : { code: 'WORKER_ERROR', message: error instanceof Error ? error.message : String(error) };

async function evaluatePoint(evaluator: ModelEvaluator, manifest: ModelManifest, params: Record<string, number>, position: PositionRequest): Promise<PointOutcome & { data?: Awaited<ReturnType<ModelEvaluator['evaluate']>> }> {
  try {
    const data = await evaluator.evaluate({ manifest, params, position });
    return { ok: true, quantities: data.quantities, data };
  } catch (error) { return { ok: false, diagnostics: toDiagnostics(error).map(item => ({ code: item.code, path: item.path, message: item.message })) }; }
}

function withEvaluator<T>(timeoutMs: number, run: (evaluator: ModelEvaluator) => Promise<T>): Promise<T> {
  const evaluator = createModelEvaluator(() => new Worker(workerUrl('worker-model.js'), { type: 'module' }), { timeoutMs });
  return run(evaluator).finally(() => evaluator.dispose());
}

const defaultsOf = (manifest: ModelManifest): Record<string, number> => Object.fromEntries(Object.entries(manifest.parameters).map(([id, definition]) => [id, definition.default]));
const geometrySize = (geometry: unknown): number => {
  const value = geometry as Record<string, unknown>;
  for (const key of ['segments', 'points', 'samples', 'vertices', 'z']) if (Array.isArray(value[key])) return (value[key] as unknown[]).length;
  return 0;
};

/**
 * Developer summary of one default-frame geometry (report §8.5): element count, the sampling a kernel or document declares
 * (a line through samples does not certify the values between them) and, for observed data, the row and missing counts.
 */
function geometrySummary(geometry: GeometryResult): GeometrySummary {
  const summary: GeometrySummary = { kind: geometry.kind, elements: geometrySize(geometry) };
  if ((geometry.kind === 'polyline2' && geometry.sampling) || geometry.kind === 'surface-grid') summary.sampling = structuredClone(geometry.sampling!);
  if (geometry.kind === 'observations2') summary.observed = { dataset: geometry.dataset, rows: geometry.points.length, missing: geometry.points.filter(point => point.values.includes(null)).length };
  return summary;
}

interface CheckInput { manifest: unknown; scenarios: { id: string; params: Record<string, number> }[]; checks: boolean; source: string; timeoutMs?: number }
async function check(input: CheckInput) {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const diagnostics: { code: string; path: string; message: string }[] = [];
  type Description = { kernels: { id: string; version: string; mode: string }[]; checks: { id: string; description: string }[] | null; checksError: string | null };
  let worker: Description;
  try { worker = await workerCall<Description>('worker-checks.js', { kind: 'describe' }, timeoutMs); }
  catch (error) { const failure = asFailure(error); return { worker: null, loadError: failure, defaults: null, scenarios: [], checks: [], diagnostics: [{ ...failure, path: 'kernel.ts' }] }; }
  let manifest: ModelManifest;
  try { manifest = validateManifest(input.manifest).manifest; }
  catch (error) { return { worker, loadError: null, defaults: null, scenarios: [], checks: [], diagnostics: toDiagnostics(error).map(item => ({ code: item.code, path: item.path, message: item.message })) }; }
  const execution = manifest.execution;
  if (input.source === 'authored-kernel' && execution.kind === 'kernel') {
    const kernel = worker.kernels[0];
    if (!kernel || kernel.id !== execution.kernelId || kernel.version !== execution.kernelVersion || kernel.mode !== execution.mode)
      diagnostics.push({ code: 'INVALID_REFERENCE', path: 'kernel.ts', message: `kernel.ts exports ${kernel ? `${kernel.id}@${kernel.version} (${kernel.mode})` : 'no kernel'}, but model.json executes ${execution.kernelId}@${execution.kernelVersion} (${execution.mode}).` });
  }
  if (worker.checksError) diagnostics.push({ code: 'INVALID_SOURCE', path: 'checks.ts', message: worker.checksError });
  return withEvaluator(timeoutMs, async evaluator => {
    const initial = pointPosition(manifest, undefined);
    const first = await evaluatePoint(evaluator, manifest, defaultsOf(manifest), initial);
    const data = first.ok ? first.data : undefined;
    const defaults = data ? {
      params: data.params, position: data.position, terminal: data.terminal,
      quantities: Object.fromEntries(Object.entries(data.quantities).map(([id, result]) => [id, statusText(result)])),
      geometry: Object.fromEntries(Object.entries(data.geometry).map(([id, geometry]) => [id, geometrySummary(geometry)])),
    } : null;
    if (!first.ok) diagnostics.push(...first.diagnostics.map(item => ({ ...item, message: `Default parameters: ${item.message}` })));
    const scenarios = [];
    for (const scenario of input.scenarios) {
      const outcome = await evaluatePoint(evaluator, manifest, { ...defaultsOf(manifest), ...scenario.params }, initial);
      scenarios.push({ id: scenario.id, outcome: classifyOutcome(outcome), statuses: outcome.ok ? Object.fromEntries(Object.entries(outcome.quantities).map(([id, result]) => [id, statusText(result)])) : null, diagnostics: outcome.ok ? [] : outcome.diagnostics });
    }
    let checks: CheckResult[] = [];
    if (input.checks && !worker.checksError) {
      try { checks = await workerCall<CheckResult[]>('worker-checks.js', { kind: 'run-checks', manifest }, Math.max(timeoutMs, 10_000)); }
      catch (error) { const failure = asFailure(error); diagnostics.push({ ...failure, path: 'checks.ts' }); }
    }
    return { worker, loadError: null, defaults, scenarios, checks, diagnostics };
  });
}

async function reference(input: { manifest: unknown; suite: ReferenceSuite; timeoutMs?: number }) {
  const { manifest } = validateManifest(input.manifest);
  return withEvaluator(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, async evaluator => {
    const cases = [];
    for (const entry of input.suite.cases) {
      const problems: string[] = [];
      let points = 0;
      if (entry.reject) problems.push(...rejectionProblems(entry, await evaluatePoint(evaluator, manifest, entry.params, pointPosition(manifest, undefined))));
      else for (const point of entry.points ?? []) {
        points++;
        problems.push(...pointProblems(entry, point, await evaluatePoint(evaluator, manifest, entry.params, pointPosition(manifest, point.position))));
      }
      cases.push({ id: entry.id, label: entry.label, provenance: entry.provenance, tolerance: entry.tolerance, tolerances: entry.tolerances ?? null, kind: entry.reject ? 'rejection' : 'evaluation', points, passed: problems.length === 0, problems: problems.slice(0, 8), omittedProblems: Math.max(0, problems.length - 8) });
    }
    return { cases, uncovered: uncoveredQuantities(manifest, input.suite) };
  });
}

async function boundaries(input: { manifest: unknown; declared: BoundaryCase[] | null; timeoutMs?: number }) {
  const { manifest } = validateManifest(input.manifest);
  const cases = [...(input.declared ?? []).map(entry => ({ entry, source: 'declared' as const })), ...domainProbes(manifest).map(entry => ({ entry, source: 'generated' as const }))];
  return withEvaluator(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, async evaluator => {
    const results = [];
    for (const { entry, source } of cases) {
      const params = { ...defaultsOf(manifest), ...entry.params };
      const position = entry.position ?? pointPosition(manifest, undefined);
      const outcome = await evaluatePoint(evaluator, manifest, params, position);
      const observed: BoundaryOutcome = classifyOutcome(outcome);
      const mismatches = [
        ...(entry.expect?.outcome && entry.expect.outcome !== observed ? [`outcome ${observed}, expected ${entry.expect.outcome}`] : []),
        ...statusMismatches(entry.expect?.statuses ?? {}, outcome),
      ];
      const nonValid = outcome.ok ? Object.fromEntries(Object.entries(outcome.quantities).filter(([, result]) => result.status !== 'valid' || result.approximation).map(([id, result]) => [id, statusText(result)])) : {};
      results.push({
        id: entry.id, source, label: entry.label, rationale: entry.rationale, params, position, outcome: observed,
        statuses: nonValid, rejection: outcome.ok ? null : outcome.diagnostics.slice(0, 3), expected: entry.expect ?? null, matches: mismatches.length === 0, mismatches,
      });
    }
    return { cases: results };
  });
}

async function mutations(input: { manifest: unknown; suite: ReferenceSuite; timeoutMs?: number }) {
  const { manifest } = validateManifest(input.manifest);
  const list: Mutation[] = mutationsFor(manifest, input.suite);
  const batch = await workerCall<{ baselineProblems: string[]; results: MutationResult[] }>('worker-checks.js', { kind: 'mutation-batch', manifest, suite: input.suite, mutations: list }, input.timeoutMs ?? 180_000);
  const byId = new Map(batch.results.map(result => [result.id, result]));
  return {
    baselineProblems: batch.baselineProblems,
    mutants: list.map(mutation => ({ ...mutation, killed: byId.get(mutation.id)?.killed ?? false, firstProblem: byId.get(mutation.id)?.firstProblem ?? null })),
    uncovered: uncoveredQuantities(manifest, input.suite),
  };
}

const METHODS: Record<string, (input: never) => Promise<unknown>> = {
  describe: (input: { timeoutMs?: number }) => workerCall('worker-checks.js', { kind: 'describe' }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  check, reference, boundaries, mutations,
};

window.__activityAuthor = {
  ready: true,
  async request(method: string, input: string) {
    const run = Object.hasOwn(METHODS, method) ? METHODS[method] : undefined;
    if (!run) return { error: { code: 'UNSUPPORTED_CAPABILITY', message: `Unknown harness method ${method}.` } };
    try { return { result: await run(JSON.parse(input) as never) }; }
    catch (error) { return { error: asFailure(error) }; }
  },
};
document.querySelector('#status')!.textContent = 'Author harness ready. Candidate code runs only in module workers.';
