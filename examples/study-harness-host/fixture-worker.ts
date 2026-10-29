/**
 * BROWSER INTEGRATION FIXTURE — kernel worker factory for the fixture page. Workers are the real catalogue module
 * workers created by the catalogue's own `createWorker` (`@experiment-kit/catalog` worker entry). The fixture only
 * counts them and, as fault-injection aids of this page only, can delay delivery of every worker reply to the main
 * thread by a fixed number of milliseconds (late-reply tests, `?workerDelay=`) or drop the next replies
 * (`workerFaults.drop`, worker-recovery tests: the evaluator's watchdog then times out and terminates the worker);
 * requests and the computation are unchanged.
 */

/** Replies to drop (decremented per dropped reply) and the count dropped so far; set by browser tests. */
export const workerFaults = { drop: 0, dropped: 0 };

/**
 * Worker-compatible wrapper that delivers `message`, `messageerror` and `error` events of a real worker after `delayMs`
 * (at once when 0), dropping a `message` while `workerFaults.drop` is positive.
 */
class FaultWorker extends EventTarget {
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private terminated = false;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;

  constructor(private readonly worker: Worker, private readonly delayMs: number) {
    super();
    worker.addEventListener('message', event => {
      if (workerFaults.drop > 0) { workerFaults.drop--; workerFaults.dropped++; return; }
      this.later(() => this.forward(new MessageEvent('message', { data: event.data })));
    });
    worker.addEventListener('messageerror', event => this.later(() => this.forward(new MessageEvent('messageerror', { data: event.data }))));
    worker.addEventListener('error', event => { event.preventDefault(); this.later(() => this.forward(new Event('error'))); });
  }
  private later(deliver: () => void): void {
    if (this.terminated) return;
    if (this.delayMs <= 0) { deliver(); return; }
    const timer = setTimeout(() => { this.timers.delete(timer); if (!this.terminated) deliver(); }, this.delayMs);
    this.timers.add(timer);
  }
  private forward(event: Event): void {
    this.dispatchEvent(event);
    const handler = event.type === 'message' ? this.onmessage : event.type === 'messageerror' ? this.onmessageerror : this.onerror;
    handler?.call(this, event as MessageEvent);
  }
  postMessage(message: unknown, transfer?: Transferable[]): void { if (!this.terminated) this.worker.postMessage(message, transfer ?? []); }
  terminate(): void {
    this.terminated = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.worker.terminate();
  }
}

/** Live worker counts, for the fixture panel and lifecycle checks. */
export const workerStats = { created: 0, terminated: 0 };

/** Wraps a worker factory: counts created/terminated workers, delays every reply by `delayMs` and applies `workerFaults`. */
export function fixtureWorkerFactory(create: () => Worker, delayMs: number): () => Worker {
  return () => {
    const worker = create();
    workerStats.created++;
    const terminate = worker.terminate.bind(worker);
    worker.terminate = () => { workerStats.terminated++; terminate(); };
    return new FaultWorker(worker, delayMs) as unknown as Worker;
  };
}
