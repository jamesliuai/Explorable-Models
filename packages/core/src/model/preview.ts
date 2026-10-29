/**
 * Preview coordinator (report §9, D11): at most one active evaluation plus one newest queued value. Submitting while
 * an evaluation runs replaces the queued value (the replaced submission resolves `null`). `cancel()` starts a new
 * epoch, so a reply from an older epoch is discarded and resolves `null`; `dispose()` rejects every pending
 * submission. Results are delivered through `settle`, which runs only for the current epoch and decides the value a
 * submission resolves with. DOM-free and model-agnostic, so hosts and examples can reuse it.
 */
export interface PreviewOutcome<V, R> {
  value: V;
  epoch: number;
  /** True when a newer value is already queued behind this one. */
  superseded: boolean;
  result?: R;
  /** Present when the evaluation failed. */
  error?: unknown;
}
export interface PreviewCoordinator<V, T> {
  submit(value: V): Promise<T | null>;
  cancel(): void;
  dispose(error: unknown): void;
  readonly epoch: number;
  readonly running: boolean;
  readonly queued: boolean;
}
export interface PreviewCoordinatorOptions<V, R, T> {
  evaluate(value: V): Promise<R>;
  settle(outcome: PreviewOutcome<V, R>): T | null;
}

type Job<V, T> = { value: V; epoch: number; resolve: (value: T | null) => void; reject: (error: unknown) => void };

export function createPreviewCoordinator<V, R, T>(options: PreviewCoordinatorOptions<V, R, T>): PreviewCoordinator<V, T> {
  let epoch = 0, running: Job<V, T> | null = null, queued: Job<V, T> | null = null, failure: { error: unknown } | null = null;
  function run(job: Job<V, T>): void {
    running = job;
    Promise.resolve().then(() => options.evaluate(job.value)).then(result => ({ result }), (error: unknown) => ({ error })).then(outcome => {
      running = null;
      if (failure) job.reject(failure.error);
      else if (job.epoch !== epoch) job.resolve(null);
      else { try { job.resolve(options.settle({ value: job.value, epoch: job.epoch, superseded: queued !== null, ...outcome })); } catch (error) { job.reject(error); } }
      const next = queued;
      queued = null;
      if (!next) return;
      if (failure) next.reject(failure.error);
      else if (next.epoch === epoch) run(next);
      else next.resolve(null);
    });
  }
  return {
    submit(value) {
      if (failure) return Promise.reject(failure.error);
      return new Promise<T | null>((resolve, reject) => {
        const job: Job<V, T> = { value, epoch, resolve, reject };
        if (running) { queued?.resolve(null); queued = job; } else run(job);
      });
    },
    cancel() {
      epoch++;
      const pending = queued;
      queued = null;
      pending?.resolve(null);
    },
    dispose(error) {
      if (failure) return;
      failure = { error };
      epoch++;
      const pending = queued;
      queued = null;
      pending?.reject(error);
    },
    get epoch() { return epoch; },
    get running() { return running !== null; },
    get queued() { return queued !== null; },
  };
}
