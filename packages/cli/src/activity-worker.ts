/**
 * Fixed toolkit entry of the candidate browser workers (report §16, A09). The bundler links it with the candidate
 * kernel (`kit:kernel`) and, for the checks worker, the author checks (`kit:checks`). Authored code therefore runs only
 * here, inside a browser module worker served with `script-src 'self'; connect-src 'none'`, never in the CLI process.
 *
 * The worker serves the standard model protocol (`serveModelWorker`, the same path the activity runtime uses) and a
 * separate author protocol on `experiment-kit.activity-author` messages (no top-level `id`, so the model protocol
 * ignores them): `describe`, `run-checks` and `mutation-batch`.
 */
import {
  enableDocumentExecution, evaluateRequest, serveModelWorker, toDiagnostics,
  type GeometryResult, type ModelKernel, type ModelManifest, type PositionRequest, type QuantityResult, type WorkerScope,
} from '@experiment-kit/core/model';
import { mutateOutput, mutateParams, pointPosition, pointProblems, rejectionProblems, type Mutation, type PointOutcome, type ReferenceSuite } from './activity-fixtures.js';

export const AUTHOR_NAMESPACE = 'experiment-kit.activity-author';
export const CHECK_LIMITS = Object.freeze({ checks: 200, detail: 500, idLength: 128 });

export interface StartOptions {
  source: 'authored-kernel' | 'installed-kernel' | 'document';
  kernelModule: Record<string, unknown>;
  checksModule: Record<string, unknown>;
  checks: boolean;
}
export interface CheckResult { id: string; description: string; passed: boolean; detail?: string }
export interface MutationResult { id: string; killed: boolean; firstProblem: string | null }
export type AuthorReply =
  | { namespace: typeof AUTHOR_NAMESPACE; requestId: string; ok: true; result: unknown }
  | { namespace: typeof AUTHOR_NAMESPACE; requestId: string; ok: false; error: { code: string; message: string } };

/** Context passed to every author check: deterministic evaluation through the same worker-side request validation. */
export interface CheckContext {
  manifest: ModelManifest;
  defaults(): Record<string, number>;
  evaluate(params?: Record<string, number>, position?: PositionRequest):
    | { ok: true; params: Record<string, number>; quantities: Record<string, QuantityResult>; geometry: Record<string, GeometryResult> }
    | { ok: false; diagnostics: { code: string; path: string; message: string }[] };
}
interface AuthorCheck { id: string; description: string; run(context: CheckContext): unknown }

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const clip = (text: string): string => text.length > CHECK_LIMITS.detail ? `${text.slice(0, CHECK_LIMITS.detail - 1)}…` : text;

function isKernel(value: unknown): value is ModelKernel {
  return isRecord(value) && typeof value.id === 'string' && typeof value.version === 'string' && (value.mode === 'discrete' || value.mode === 'static') && typeof value.evaluate === 'function';
}

function kernelsOf(options: StartOptions): ModelKernel[] {
  if (options.source === 'document') return [];
  if (options.source === 'installed-kernel') {
    const installed = options.kernelModule.INSTALLED_KERNELS;
    if (!Array.isArray(installed) || !installed.every(isKernel)) throw new TypeError('The installed kernel list is unavailable.');
    return [...installed];
  }
  const candidate = options.kernelModule.kernel ?? options.kernelModule.default;
  if (!isKernel(candidate)) throw new TypeError('kernel.ts must export `kernel` (or a default export) implementing ModelKernel { id, version, mode, evaluate }.');
  return [candidate];
}

function checksOf(module: Record<string, unknown>): { checks: AuthorCheck[] } | { error: string } {
  const list = module.checks ?? module.default;
  if (!Array.isArray(list)) return { error: 'checks.ts must export `checks` (or a default export): an array of { id, description, run(context) }.' };
  if (list.length > CHECK_LIMITS.checks) return { error: `checks.ts exports more than ${CHECK_LIMITS.checks} checks.` };
  const seen = new Set<string>();
  for (const [index, check] of list.entries()) {
    if (!isRecord(check) || typeof check.id !== 'string' || !ID.test(check.id) || typeof check.description !== 'string' || typeof check.run !== 'function') return { error: `Check ${index} needs an id (identifier), a description and a run(context) function.` };
    if (seen.has(check.id)) return { error: `Duplicate check id ${JSON.stringify(check.id)}.` };
    seen.add(check.id);
  }
  return { checks: list as AuthorCheck[] };
}

function evaluate(kernels: readonly ModelKernel[], manifest: ModelManifest, params: Record<string, number>, position: PositionRequest): PointOutcome & { geometry?: Record<string, GeometryResult> } {
  try {
    const data = evaluateRequest({ manifest, params, position }, kernels);
    return { ok: true, quantities: data.quantities, geometry: data.geometry };
  } catch (error) { return { ok: false, diagnostics: toDiagnostics(error).map(item => ({ code: item.code, path: item.path, message: item.message })) }; }
}

async function runChecks(kernels: readonly ModelKernel[], module: Record<string, unknown>, manifest: ModelManifest): Promise<{ checks: CheckResult[] } | { error: string }> {
  const loaded = checksOf(module);
  if ('error' in loaded) return loaded;
  const defaults = Object.fromEntries(Object.entries(manifest.parameters).map(([id, definition]) => [id, definition.default]));
  const initial = pointPosition(manifest, undefined);
  const context: CheckContext = Object.freeze({
    manifest: structuredClone(manifest),
    defaults: () => ({ ...defaults }),
    evaluate(params = {}, position = initial) {
      const merged = { ...defaults, ...params };
      const outcome = evaluate(kernels, manifest, merged, position);
      return outcome.ok ? { ok: true as const, params: merged, quantities: outcome.quantities, geometry: outcome.geometry ?? {} } : outcome;
    },
  });
  const results: CheckResult[] = [];
  for (const check of loaded.checks) {
    try {
      const value: unknown = await check.run(context);
      if (value === true || (isRecord(value) && value.passed === true)) results.push({ id: check.id, description: clip(check.description), passed: true, ...(isRecord(value) && typeof value.detail === 'string' ? { detail: clip(value.detail) } : {}) });
      else results.push({ id: check.id, description: clip(check.description), passed: false, detail: clip(typeof value === 'string' ? value : isRecord(value) && typeof value.detail === 'string' ? value.detail : value === false ? 'The check returned false.' : 'The check did not return true or { passed: true }.') });
    } catch (error) {
      results.push({ id: check.id, description: clip(check.description), passed: false, detail: clip(`The check threw: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`) });
    }
  }
  return { checks: results };
}

/** Suite problems under a mutation (or none); stops at the first problem when `firstOnly`. */
function suiteProblems(kernels: readonly ModelKernel[], manifest: ModelManifest, suite: ReferenceSuite, mutation: Mutation | null, firstOnly: boolean): string[] {
  const problems: string[] = [];
  for (const entry of suite.cases) {
    const params = mutation ? mutateParams(manifest, mutation, entry.params) : entry.params;
    if (entry.reject) {
      const found = rejectionProblems(entry, evaluate(kernels, manifest, params, pointPosition(manifest, undefined)));
      problems.push(...found.map(item => `${entry.id}: ${item}`));
    } else {
      for (const point of entry.points ?? []) {
        let outcome: PointOutcome = evaluate(kernels, manifest, params, pointPosition(manifest, point.position));
        if (mutation && outcome.ok) outcome = { ok: true, quantities: mutateOutput(mutation, { quantities: outcome.quantities, geometry: {} }, manifest).quantities };
        problems.push(...pointProblems(entry, point, outcome).map(item => `${entry.id}: ${item}`));
        if (firstOnly && problems.length) return problems;
      }
    }
    if (firstOnly && problems.length) return problems;
  }
  return problems;
}

export function startAuthorWorker(options: StartOptions): void {
  // Authored packages may execute a bounded schema 2.0 document (architecture D3); the document runtime is opt-in.
  enableDocumentExecution();
  const scope = self as unknown as WorkerScope & { postMessage(message: unknown): void };
  // A kernel module that fails to load, or exports no kernel, fails here: the worker reports an error event.
  const kernels = kernelsOf(options);
  serveModelWorker(scope, kernels);
  const reply = (message: AuthorReply) => scope.postMessage(message);
  scope.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as Record<string, unknown> | null;
    if (!isRecord(data) || data.namespace !== AUTHOR_NAMESPACE || typeof data.requestId !== 'string') return;
    const requestId = data.requestId;
    const fail = (code: string, message: string) => reply({ namespace: AUTHOR_NAMESPACE, requestId, ok: false, error: { code, message: clip(message) } });
    void (async () => {
      try {
        if (data.kind === 'describe') {
          const checks = options.checks ? checksOf(options.checksModule) : null;
          reply({ namespace: AUTHOR_NAMESPACE, requestId, ok: true, result: {
            kernels: kernels.map(kernel => ({ id: kernel.id, version: kernel.version, mode: kernel.mode })),
            checks: checks && 'checks' in checks ? checks.checks.map(check => ({ id: check.id, description: clip(check.description) })) : null,
            checksError: checks && 'error' in checks ? checks.error : null,
          } });
        } else if (data.kind === 'run-checks') {
          if (!options.checks) { fail('NOT_FOUND', 'The package has no checks.ts.'); return; }
          const outcome = await runChecks(kernels, options.checksModule, data.manifest as ModelManifest);
          if ('error' in outcome) fail('INVALID_SOURCE', outcome.error); else reply({ namespace: AUTHOR_NAMESPACE, requestId, ok: true, result: outcome.checks });
        } else if (data.kind === 'mutation-batch') {
          const manifest = data.manifest as ModelManifest, suite = data.suite as ReferenceSuite, mutations = data.mutations as Mutation[];
          const baseline = suiteProblems(kernels, manifest, suite, null, false);
          const results: MutationResult[] = baseline.length ? [] : mutations.map(mutation => {
            const found = suiteProblems(kernels, manifest, suite, mutation, true);
            return { id: mutation.id, killed: found.length > 0, firstProblem: found[0] ? clip(found[0]) : null };
          });
          reply({ namespace: AUTHOR_NAMESPACE, requestId, ok: true, result: { baselineProblems: baseline.slice(0, 8).map(clip), results } });
        } else fail('UNSUPPORTED_CAPABILITY', 'Unknown author request.');
      } catch (error) { fail('WORKER_ERROR', error instanceof Error ? `${error.name}: ${error.message}` : String(error)); }
    })();
  });
}
