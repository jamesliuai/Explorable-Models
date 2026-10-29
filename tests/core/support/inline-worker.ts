/**
 * TEST-ONLY Worker-compatible object that runs serveModelWorker in-process. Messages are structured-cloned and
 * delivered asynchronously (setTimeout) in both directions, so ordering, cancellation and late replies behave like a
 * real worker. Hostile modes simulate a nonresponding, crashing or protocol-violating worker. Production code always
 * uses real browser workers; nothing here is exported from a package.
 */
import { serveModelWorker } from '../../../packages/core/src/model/index';
import type { ModelKernel } from '../../../packages/core/src/model/index';

export type Hostility =
  | 'none'
  | 'silent' // never replies (excess work / hung worker)
  | 'crash' // emits an error event instead of replying
  | 'malformed' // valid envelope, tampered frame (wrong quantity shape)
  | 'oversized' // valid envelope, geometry larger than maxElements
  | 'wrong-id' // reply for another job
  | 'garbage' // non-object reply
  | 'unknown-type'; // reply with an unknown message type

type Listener = (event: { data?: unknown }) => void;

export interface WorkerGroup {
  factory: () => Worker;
  workers: InlineWorker[];
  /** Mutable: applies to replies produced from now on. */
  hostility: Hostility;
  /** Extra delay before a reply is delivered (ms). */
  delayMs: number;
  /** When true, replies are held until `flush()`. */
  hold: boolean;
  held: (() => void)[];
  flush(): void;
  /** Evaluate messages received by all workers in this group. */
  readonly received: number;
  readonly live: number;
  readonly terminated: number;
  /** Highest number of unanswered messages any single worker had at once. */
  readonly maxInFlight: number;
}

export class InlineWorker {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly scopeListeners = new Set<Listener>();
  terminated = false;
  received = 0;
  inFlight = 0;
  maxInFlight = 0;
  constructor(private readonly group: WorkerGroup, kernels: readonly ModelKernel[]) {
    serveModelWorker({
      addEventListener: (_type, listener) => { this.scopeListeners.add(listener as Listener); },
      removeEventListener: (_type, listener) => { this.scopeListeners.delete(listener as Listener); },
      postMessage: message => this.reply(message),
    }, kernels);
  }
  addEventListener(type: string, listener: Listener): void { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type)!.add(listener); }
  removeEventListener(type: string, listener: Listener): void { this.listeners.get(type)?.delete(listener); }
  listenerCount(): number { return [...this.listeners.values()].reduce((total, set) => total + set.size, 0); }
  postMessage(message: unknown): void {
    if (this.terminated) return;
    const data = structuredClone(message);
    this.received++;
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    setTimeout(() => {
      if (this.terminated) return;
      if (this.group.hostility === 'silent') return;
      if (this.group.hostility === 'crash') { this.inFlight--; this.dispatch('error', { data: undefined }); return; }
      for (const listener of [...this.scopeListeners]) listener({ data });
    }, 0);
  }
  terminate(): void { this.terminated = true; this.inFlight = 0; }
  private dispatch(type: string, event: { data?: unknown }): void { for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event); }
  private reply(message: unknown): void {
    let out = structuredClone(message) as Record<string, any>;
    const mode = this.group.hostility;
    if (mode === 'malformed' && out.type === 'result') { const first = Object.keys(out.data.quantities)[0]; out.data.quantities[first] = { status: 'valid', value: [1, 2, 3, 4, 5, 6, 7] }; }
    if (mode === 'oversized' && out.type === 'result') { const first = Object.keys(out.data.geometry)[0]; out.data.geometry[first] = { kind: 'polyline2', segments: [{ points: Array.from({ length: 5000 }, (_, i) => [i, i]), start: 'none', end: 'none' }], gaps: [] }; }
    if (mode === 'wrong-id') out = { ...out, id: `${out.id}-stale` };
    if (mode === 'garbage') out = 42 as never;
    if (mode === 'unknown-type') out = { ...out, type: 'progress' };
    const deliver = () => { if (this.terminated) return; this.inFlight--; this.dispatch('message', { data: structuredClone(out) }); };
    if (this.group.hold) this.group.held.push(deliver);
    else setTimeout(deliver, this.group.delayMs);
  }
}

export function inlineWorkers(kernels: readonly ModelKernel[], options: { hostility?: Hostility; delayMs?: number } = {}): WorkerGroup {
  const group: WorkerGroup = {
    workers: [], hostility: options.hostility ?? 'none', delayMs: options.delayMs ?? 0, hold: false, held: [],
    factory: () => { const worker = new InlineWorker(group, kernels); group.workers.push(worker); return worker as unknown as Worker; },
    flush() { const pending = group.held.splice(0); for (const deliver of pending) deliver(); },
    get received() { return group.workers.reduce((total, worker) => total + worker.received, 0); },
    get live() { return group.workers.filter(worker => !worker.terminated).length; },
    get terminated() { return group.workers.filter(worker => worker.terminated).length; },
    get maxInFlight() { return group.workers.reduce((max, worker) => Math.max(max, worker.maxInFlight), 0); },
  };
  return group;
}

/** Polls with real macrotask turns until the condition holds. */
export async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('Condition not reached in time.');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}
export const settle = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));

/** Deterministic scheduler for playback ticks. */
export class ManualScheduler {
  private readonly tasks = new Map<number, { fn: () => void; at: number }>();
  private next = 1;
  now = 0;
  setTimeout = (fn: () => void, ms: number): unknown => { const id = this.next++; this.tasks.set(id, { fn, at: this.now + ms }); return id; };
  clearTimeout = (handle: unknown): void => { this.tasks.delete(handle as number); };
  get pending(): number { return this.tasks.size; }
  /** Runs the earliest task; returns false when none is pending. */
  runNext(): boolean {
    let chosen: [number, { fn: () => void; at: number }] | undefined;
    for (const entry of this.tasks) if (!chosen || entry[1].at < chosen[1].at) chosen = entry;
    if (!chosen) return false;
    this.tasks.delete(chosen[0]);
    this.now = chosen[1].at;
    chosen[1].fn();
    return true;
  }
  /** Advances the clock without running anything (models elapsed wall-clock time). */
  advance(ms: number): void { this.now += ms; }
}
