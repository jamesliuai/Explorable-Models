/** Browser-only coordinator. Candidate code is imported by model-worker.js, never by this page. */
import { ExperimentRuntime, WorkerExecutor } from '../../core/src/index.js';
import type { CheckReport, CheckSuite, ExperimentDefinition, RuntimeCommand, ScalarParams } from '../../core/src/types.js';

export interface HarnessRequest { method: string; args?: Record<string, unknown> }
declare global { interface Window { __experimentHarness?: { request(input: HarnessRequest): Promise<unknown>; ready: boolean; error?: unknown } } }
function jsonError(error: unknown): Record<string, unknown> {
  if (error && typeof error === 'object') {
    const value = error as Record<string, unknown>;
    return { code: value.code ?? 'MODEL_ERROR', message: value.message ?? String(error), recovery: value.recovery, currentVersion: value.currentVersion, currentActiveRunId: value.currentActiveRunId };
  }
  return { code: 'MODEL_ERROR', message: String(error) };
}
export async function startHarness(definition: ExperimentDefinition): Promise<void> {
  let worker = new Worker(new URL('./model-worker.js', location.href), { type: 'module' });
  const executor = new WorkerExecutor(worker, definition.manifest, { timeoutMs: 3000 });
  const api = { ready: false, error: undefined as unknown, request: async (_: HarnessRequest): Promise<unknown> => ({ error: { code: 'BUSY', message: 'Model is starting.' } }) };
  window.__experimentHarness = api;
  try {
    const runtime = await ExperimentRuntime.create(definition, executor);
    let lastAnimationTime = performance.now();
    const animate = async (now: number) => {
      const elapsed = Math.min((now - lastAnimationTime) / 1000, 0.25); lastAnimationTime = now;
      if (runtime.getState().frame.status === 'running') {
        try { await runtime.tick(elapsed); } catch { /* Runtime preserves the last committed frame and reports its error. */ }
      }
      requestAnimationFrame(time => { void animate(time); });
    };
    requestAnimationFrame(time => { void animate(time); });
    const authorSuite = () => new Promise<CheckSuite | null>((resolve, reject) => {
      const id = crypto.randomUUID();
      const onMessage = (event: MessageEvent) => { if (event.data?.namespace !== 'explorable-models-checks' || event.data.id !== id) return; clearTimeout(timer); worker.removeEventListener('message', onMessage); event.data.error ? reject(event.data.error) : resolve(event.data.result as CheckSuite | null); };
      const timer = setTimeout(() => { worker.removeEventListener('message', onMessage); reject({ code: 'TIMEOUT', message: 'Author check suite did not respond within 3 seconds.' }); }, 3000);
      worker.addEventListener('message', onMessage); worker.postMessage({ namespace: 'explorable-models-checks', id });
    });
    api.request = async ({ method, args = {} }) => {
      try {
        switch (method) {
          case 'describe': return runtime.describe();
          case 'inspect': return runtime.inspect(args.quantityIds as string[] | undefined);
          case 'state': return runtime.getState();
          case 'command': return await runtime.command(args as unknown as RuntimeCommand);
          case 'create_run': return await runtime.command({ type: 'set_parameters', parameters: args.parameters as ScalarParams ?? {}, expectedRunVersion: args.expectedRunVersion as number, expectedActiveRunId: args.expectedActiveRunId as string });
          case 'sample': return await runtime.sample({ parameters: args.parameters as ScalarParams | undefined, times: args.times as number[] });
          case 'compare': return await runtime.compare({ runIds: args.runIds as string[], times: args.times as number[] });
          case 'checkpoint': return await runtime.checkpoint(args.annotations as string | undefined);
          case 'activate_revision': {
            const candidate = args.definition as ExperimentDefinition;
            const url = new URL(args.workerUrl as string, location.href);
            if (url.origin !== location.origin) throw new Error('Candidate worker must be served by this local experiment session.');
            const candidateWorker = new Worker(url, { type: 'module' });
            const candidateExecutor = new WorkerExecutor(candidateWorker, candidate.manifest, { timeoutMs: 3000 });
            try { const result = await runtime.activateRevision(candidate, candidateExecutor, args.report as CheckReport, { expectedDefinitionRevision: args.expectedDefinitionRevision as string, expectedRunVersion: args.expectedRunVersion as number, expectedActiveRunId: args.expectedActiveRunId as string }); worker = candidateWorker; return result; }
            catch (error) { candidateExecutor.dispose(); throw error; }
          }
          case 'verify': {
            const suite = args.suite as CheckSuite | undefined ?? await authorSuite();
            if (!suite) return { error: { code: 'NOT_FOUND', message: 'No checks.ts suite is provided.', recovery: 'Export a CheckSuite as checks or default from checks.ts.' } };
            // A candidate cannot promote its own assertions to independent reference provenance.
            return await runtime.verify({ ...suite, provenance: args.suite ? suite.provenance : 'author' });
          }
          default: return { error: { code: 'UNSUPPORTED_CAPABILITY', message: `Unknown operation: ${method}` } };
        }
      } catch (error) { return { error: jsonError(error) }; }
    };
    api.ready = true;
    document.querySelector('#status')!.textContent = `${definition.manifest.title} is ready. Model execution is in a dedicated worker.`;
  } catch (error) { api.error = jsonError(error); document.querySelector('#status')!.textContent = 'The model could not start.'; }
}
