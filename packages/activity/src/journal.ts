/**
 * Bounded journal outbox (D8, activity-runtime §5, report §7.2). Events are validated, kept in sequence order and
 * flushed to the host in batches through `HostPort.appendEvents`; the host owns durability, sequencing and duplicate
 * detection by `eventId`, so resending after an uncertain outcome is always safe. Evidence is never dropped silently:
 * commands stop at {@link commandCapacity} (`PERSISTENCE_BACKPRESSURE`, the command does not happen), which keeps a
 * reserve ({@link systemReserve}) for events the adapter itself must record without a command (suspension, display
 * acknowledgements, playback end, revocation). An append the outbox still refuses is counted by the caller as a journal
 * loss and recorded in the next journaled event (activity-runtime §5). Only presentation changes (`view.changed`) may be
 * coalesced, and every coalesced change is counted and reported. Every acknowledgement's host timestamp is passed to
 * `onHostTime`, so host-clock checks (policy expiry) follow the host's time. The outbox is not durable storage; the host
 * is (report §14: no second learning database in the browser).
 */
import { canonicalJSON, sha256 } from '@experiment-kit/core';
import { CONTRACTS, HOST_REFUSAL_CODES, type Diagnostic, type DiagnosticCode, type EventType, type HostPort, type InteractionEvent, type JournalCursor, type PersistenceStatus } from './contracts.js';
import { DIAGNOSTIC_CODES, LIMITS, MESSAGES } from './schemas.js';
import { validateRecord } from './validator.js';

/** Event types that carry no learning evidence; they may be coalesced when the outbox is under pressure. */
export const NON_EVIDENCE_EVENTS: ReadonlySet<EventType> = new Set<EventType>(['view.changed']);
/** True for every event type except presentation changes. */
export function isEvidenceBearing(type: EventType): boolean { return !NON_EVIDENCE_EVENTS.has(type); }

export interface OutboxState {
  persistence: PersistenceStatus;
  /** Events not yet acknowledged by the host. */
  pending: number;
  /** Highest sequence through which every event is acknowledged. */
  acknowledgedThrough: number;
  lastError: Diagnostic | null;
  /** Presentation changes folded into later presentation state instead of being journaled. */
  coalesced: number;
}
export interface RetryPolicy { baseMs: number; maxMs: number; maxAttempts: number }
export interface Scheduler { setTimeout(callback: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }
export interface OutboxOptions {
  host: HostPort;
  activityId: string;
  /** Bound on unacknowledged events (1–256, the artifact `pendingEventIds` bound). */
  limit: number;
  onChange(state: OutboxState): void;
  /** Events per `appendEvents` call (1–32, default 32). */
  batchSize?: number;
  /** Automatic retry after a recoverable failure: delay min(maxMs, baseMs·2^(attempt−1)), at most maxAttempts. */
  retry?: RetryPolicy;
  scheduler?: Scheduler;
  /** Last sequence already durable at the host (restore); the next appended event must be `lastSequence + 1`. */
  lastSequence?: number;
  /** Host call timeout; an unanswered call is treated as an uncertain outcome and resent. 0 disables. */
  timeoutMs?: number;
  /** Bound on the acknowledged mirror kept for summaries (default {@link ACKNOWLEDGED_MIRROR_LIMIT}). */
  mirrorLimit?: number;
  /** Called with the host timestamp of every acknowledged or duplicate-confirmed batch (`AppendAck.hostTimestamp`). */
  onHostTime?(hostTimestamp: string): void;
}
/**
 * `coalesced`: a presentation change was folded into later presentation state and not journaled; its sequence
 * number was not consumed, so {@link Outbox.nextSequence} is unchanged and the next event reuses it.
 */
export type AppendOutcome = { ok: true; coalesced?: true } | { ok: false; diagnostic: Diagnostic };

export interface Outbox {
  /** Validates and queues one event; never contacts the host. */
  append(event: InteractionEvent): AppendOutcome;
  /** Sends queued events in order; resolves when the queue is empty or a failure was recorded (never rejects). */
  flush(): Promise<void>;
  /** Reads the host cursor, adopts or rejects it, then resends everything unconfirmed (the host deduplicates). */
  reconcile(): Promise<{ cursor: JournalCursor; resent: number }>;
  state(): OutboxState;
  /** Unacknowledged events in sequence order (copies). */
  pendingEvents(): InteractionEvent[];
  /** Bounded mirror of acknowledged events in sequence order (copies). */
  acknowledgedEvents(): InteractionEvent[];
  /** Acknowledged events removed from the mirror by its bound (oldest first); summaries report them as omitted. */
  trimmedBefore(): number;
  /** Sequence the next appended event must carry. */
  nextSequence(): number;
  /** Journal checkpoint for an artifact: last acknowledged position and the IDs still pending. */
  checkpoint(): { cursor: JournalCursor; pendingEventIds: string[] };
  /** Releases acknowledged mirror copies matching `predicate` (host deletion policy); pending events are never released. */
  forgetAcknowledged(predicate: (event: InteractionEvent) => boolean): number;
  /**
   * Rejects with {@link PersistenceError} (`PERSISTENCE_PENDING`, or `PERSISTENCE_FAILED` after a host rejection) unless
   * everything is acknowledged after one flush attempt. With `waitMs`, a flush still in flight after that long rejects
   * with `PERSISTENCE_PENDING` at once (the flush continues in the background) instead of waiting for the host call
   * timeout.
   */
  requireFlushed(waitMs?: number): Promise<void>;
  dispose(): void;
}

/** Rejection value of outbox operations that cannot complete; `diagnostic` is learner-safe. */
export class PersistenceError extends Error {
  readonly diagnostic: Diagnostic;
  constructor(diagnostic: Diagnostic) { super(diagnostic.message); this.name = 'PersistenceError'; this.diagnostic = diagnostic; }
}
export const isPersistenceError = (value: unknown): value is PersistenceError => value instanceof PersistenceError;

export const DEFAULT_RETRY: Readonly<RetryPolicy> = Object.freeze({ baseMs: 500, maxMs: 30_000, maxAttempts: 8 });
/** Host call timeout of the outbox: an unanswered append or cursor request is treated as an uncertain outcome. */
export const DEFAULT_HOST_TIMEOUT_MS = 15_000;
/**
 * Acknowledged events kept in memory for summaries (activity-runtime §5–§6). Older acknowledged events are trimmed from
 * the mirror; the host journal keeps them, and summaries report them as omitted (`complete: false`).
 */
export const ACKNOWLEDGED_MIRROR_LIMIT = 5000;
/**
 * Default wait for in-flight journal batches before a step that must flush first (stage transition, reveal, assistance,
 * close) is refused with `PERSISTENCE_PENDING` and the card shows the awaiting-persistence state (adapter option
 * `persistenceWaitMs`).
 */
export const DEFAULT_PERSISTENCE_WAIT_MS = 1000;

/**
 * Outbox places kept for events the adapter records without a command (activity-runtime §5): at least two (a suspension
 * and its resumption), an eighth of the bound for larger outboxes, and none for an outbox of fewer than four events.
 */
export function systemReserve(limit: number): number {
  return limit < 4 ? 0 : Math.max(2, Math.floor(limit / 8));
}
/** Unacknowledged events up to which commands may append; the rest of the bound is the {@link systemReserve}. */
export function commandCapacity(limit: number): number { return limit - systemReserve(limit); }

/**
 * Host error codes meaning the request itself was refused; resending the same events cannot succeed. Includes every
 * host refusal code of the HostPort convention (`HOST_REFUSAL_CODES`, activity-runtime §10).
 */
export const HOST_REJECTION_CODES: ReadonlySet<string> = new Set(['SCHEMA', 'INVALID_REFERENCE', 'CONFLICT', 'OPERATION_CONFLICT', 'RESOURCE_LIMIT', 'NOT_FOUND', ...HOST_REFUSAL_CODES]);
const KNOWN_CODES: ReadonlySet<string> = new Set(DIAGNOSTIC_CODES);

export interface HostFailure { permanent: boolean; diagnostic: Diagnostic }
/**
 * Classifies a rejected host call. A host refuses a request by rejecting with an object whose `code` is one of
 * {@link HOST_REJECTION_CODES} (permanent: requires host action); anything else — transport errors, timeouts,
 * disconnects — has an uncertain outcome and is recoverable by resending. The host's message is never echoed.
 */
export function classifyHostFailure(error: unknown, operation = 'journal batch'): HostFailure {
  const code = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : null;
  if (code && HOST_REJECTION_CODES.has(code)) {
    return { permanent: true, diagnostic: { code: 'PERSISTENCE_FAILED', path: '$', message: `The host rejected the ${operation}${KNOWN_CODES.has(code) ? ` (${code})` : ''}.`, recovery: 'The host must resolve the rejection; the events are kept and nothing was dropped. Retry after the host is corrected.' } };
  }
  return { permanent: false, diagnostic: { code: 'PERSISTENCE_FAILED', path: '$', message: `The host did not confirm the ${operation}; the outcome is uncertain.`, recovery: 'The events are kept and resent; the host deduplicates them by eventId.' } };
}

const digest = (value: unknown): string => sha256(canonicalJSON(value));
const diagnostic = (code: DiagnosticCode, path: string, message: string, recovery?: string): Diagnostic => ({ code, path, message, ...(recovery ? { recovery } : {}) });
const integerIn = (value: number | undefined, fallback: number, min: number, max: number, name: string): number => {
  const chosen = value ?? fallback;
  if (!Number.isInteger(chosen) || chosen < min || chosen > max) throw new RangeError(`${name} must be an integer from ${min} to ${max}.`);
  return chosen;
};
class Timeout { }

interface Entry { event: InteractionEvent; evidence: boolean; acked: boolean }

/**
 * Creates the outbox for one activity. `limit` bounds all unacknowledged events; presentation changes may occupy at
 * most an eighth of it (rounded up) and are coalesced beyond that, so evidence always keeps at least seven eighths.
 */
export function createOutbox(options: OutboxOptions): Outbox {
  const { host, activityId } = options;
  const limit = integerIn(options.limit, 0, 1, LIMITS.pendingEvents, 'limit');
  const viewLimit = Math.ceil(limit / 8);
  const batchSize = integerIn(options.batchSize, LIMITS.eventsPerAppend, 1, LIMITS.eventsPerAppend, 'batchSize');
  const mirrorLimit = integerIn(options.mirrorLimit, ACKNOWLEDGED_MIRROR_LIMIT, 0, 1_000_000, 'mirrorLimit');
  const timeoutMs = integerIn(options.timeoutMs, DEFAULT_HOST_TIMEOUT_MS, 0, 3_600_000, 'timeoutMs');
  const retry = options.retry ?? DEFAULT_RETRY;
  if (![retry.baseMs, retry.maxMs].every(value => Number.isFinite(value) && value >= 0) || !Number.isInteger(retry.maxAttempts) || retry.maxAttempts < 0) throw new RangeError('retry must have nonnegative baseMs, maxMs and an integer maxAttempts.');
  const scheduler: Scheduler = options.scheduler ?? { setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms), clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>) };

  const entries: Entry[] = [];
  const mirror: InteractionEvent[] = [];
  /** eventId → canonical digest for every event still held (pending or mirrored), so an identical re-append is a no-op. */
  const held = new Map<string, string>();
  let lastAppended = integerIn(options.lastSequence, 0, 0, Number.MAX_SAFE_INTEGER, 'lastSequence');
  let acknowledgedThrough = lastAppended;
  let lastAcknowledgedId: string | null = null;
  let hostCursor: JournalCursor | null = null;
  let pendingEvidence = 0, pendingViews = 0, coalesced = 0, trimmed = 0, sent = 0, attempts = 0;
  let failure: HostFailure | null = null;
  let flushing: Promise<void> | null = null;
  let retryTimer: unknown = null;
  let disposed = false;
  let notified = '';

  const pendingCount = () => pendingEvidence + pendingViews;
  /** `saving` covers queued and in-flight events; a failure keeps its state until a later batch is confirmed. */
  const persistence = (): PersistenceStatus =>
    failure?.permanent ? 'failed' : failure ? 'pending-recovery' : pendingCount() > 0 ? 'saving' : 'saved';
  const snapshot = (): OutboxState => ({ persistence: persistence(), pending: pendingCount(), acknowledgedThrough, lastError: failure ? { ...failure.diagnostic } : null, coalesced });
  const notify = () => {
    if (disposed) return;
    const state = snapshot(), key = JSON.stringify(state);
    if (key === notified) return;
    notified = key;
    options.onChange(state);
  };

  const cancelRetry = () => { if (retryTimer !== null) { scheduler.clearTimeout(retryTimer); retryTimer = null; } };
  const recordFailure = (next: HostFailure) => {
    attempts++;
    const exhausted = !next.permanent && attempts >= retry.maxAttempts;
    failure = exhausted ? { permanent: false, diagnostic: { ...next.diagnostic, recovery: 'Automatic retries stopped; the events are kept. Retry persistence or reconcile with the host.' } } : next;
    cancelRetry();
    if (!next.permanent && !exhausted && !disposed) {
      retryTimer = scheduler.setTimeout(() => { retryTimer = null; void flush(); }, Math.min(retry.maxMs, retry.baseMs * 2 ** (attempts - 1)));
    }
    notify();
  };

  /** Resolves with the host reply, or rejects with {@link Timeout} after `timeoutMs`. */
  const withTimeout = <T>(call: () => Promise<T>): Promise<T> => {
    let promise: Promise<T>;
    try { promise = Promise.resolve(call()); } catch (error) { return Promise.reject(error); }
    if (!timeoutMs) return promise;
    return new Promise<T>((resolve, reject) => {
      const timer = scheduler.setTimeout(() => reject(new Timeout()), timeoutMs);
      promise.then(value => { scheduler.clearTimeout(timer); resolve(value); }, error => { scheduler.clearTimeout(timer); reject(error); });
    });
  };
  const failureOf = (error: unknown, operation: string): HostFailure => error instanceof Timeout
    ? { permanent: false, diagnostic: diagnostic('PERSISTENCE_FAILED', '$', `The host did not answer the ${operation} in time; the outcome is uncertain.`, 'The events are kept and resent; the host deduplicates them by eventId.') }
    : classifyHostFailure(error, operation);

  /** Moves acknowledged events at the head of the queue into the mirror, advancing the acknowledged watermark. */
  const settleHead = () => {
    while (entries.length && entries[0]!.acked) {
      const { event } = entries.shift()!;
      acknowledgedThrough = event.sequence;
      lastAcknowledgedId = event.eventId;
      mirror.push(event);
    }
    if (mirror.length > mirrorLimit) {
      const removed = mirror.splice(0, mirror.length - mirrorLimit);
      trimmed += removed.length;
      for (const event of removed) held.delete(event.eventId);
    }
  };

  /** Sends one batch; true when every event in it was confirmed. */
  const send = async (batch: Entry[]): Promise<boolean> => {
    sent += batch.length;
    let result: unknown;
    try { result = await withTimeout(() => host.appendEvents({ activityId, events: batch.map(entry => structuredClone(entry.event)) })); } catch (error) {
      if (!disposed) recordFailure(failureOf(error, 'journal batch'));
      return false;
    }
    if (disposed) return false;
    const checked = validateRecord(MESSAGES.appendResult, result);
    const reply = result as { acknowledged: { eventId: string; hostTimestamp: string }[]; duplicates: string[]; cursor: JournalCursor };
    if (!checked.ok || reply.cursor.activityId !== activityId) {
      recordFailure({ permanent: false, diagnostic: diagnostic('PERSISTENCE_FAILED', '$', 'The host returned an invalid append result; the outcome is uncertain.', 'The events are kept and resent; the host deduplicates them by eventId.') });
      return false;
    }
    const confirmed = new Set([...reply.acknowledged.map(ack => ack.eventId), ...reply.duplicates]);
    // The host's acknowledgement time advances the host clock (policy expiry is judged by host time, not local time).
    for (const ack of reply.acknowledged) { try { options.onHostTime?.(ack.hostTimestamp); } catch { /* An observer cannot affect the outbox. */ } }
    let complete = true;
    for (const entry of batch) {
      if (!confirmed.has(entry.event.eventId)) { complete = false; continue; }
      if (entry.acked) continue;
      entry.acked = true;
      if (entry.evidence) pendingEvidence--; else pendingViews--;
    }
    hostCursor = reply.cursor;
    settleHead();
    if (!complete) {
      recordFailure({ permanent: false, diagnostic: diagnostic('PERSISTENCE_FAILED', '$', 'The host did not confirm every event in the batch.', 'Unconfirmed events are kept and resent; the host deduplicates them by eventId.') });
      return false;
    }
    failure = null;
    attempts = 0;
    notify();
    return true;
  };

  const run = async () => {
    cancelRetry();
    while (!disposed) {
      const batch = entries.filter(entry => !entry.acked).slice(0, batchSize);
      if (!batch.length) break;
      notify();
      if (!await send(batch)) break;
    }
  };
  const flush = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (!flushing && pendingCount() > 0) flushing = run().finally(() => { flushing = null; notify(); });
    return flushing ?? Promise.resolve();
  };

  const backpressure = (): Diagnostic => diagnostic('PERSISTENCE_BACKPRESSURE', '$', `The journal outbox holds ${limit} unacknowledged events; this evidence-bearing operation was not performed.`,
    'Restore the host connection and retry persistence; viewing already covered by acknowledged exposure can continue.');

  const outbox: Outbox = {
    append(event) {
      if (disposed) return { ok: false, diagnostic: diagnostic('DISPOSED', '$', 'The journal outbox was disposed.', 'Create the activity again.') };
      const checked = validateRecord(CONTRACTS.event, event);
      if (!checked.ok) return { ok: false, diagnostic: checked.diagnostics[0]! };
      if (event.activityId !== activityId) return { ok: false, diagnostic: diagnostic('INVALID_INPUT', '$.activityId', 'The event belongs to another activity.') };
      const identity = digest(event);
      const known = held.get(event.eventId);
      if (known !== undefined) {
        return known === identity ? { ok: true } : { ok: false, diagnostic: diagnostic('OPERATION_CONFLICT', '$.eventId', 'A different event with this eventId was already appended.', 'Use a new eventId for a different event.') };
      }
      if (event.sequence !== lastAppended + 1) {
        return { ok: false, diagnostic: diagnostic('INVALID_INPUT', '$.sequence', `The event sequence must be ${lastAppended + 1}: sequences are gap-free and in order.`, 'Assign sequences from nextSequence().') };
      }
      const evidence = isEvidenceBearing(event.type);
      if (evidence && pendingCount() >= limit) return { ok: false, diagnostic: backpressure() };
      if (!evidence && (pendingCount() >= limit || pendingViews >= viewLimit)) {
        coalesced++;
        notify();
        return { ok: true, coalesced: true };
      }
      entries.push({ event: structuredClone(event), evidence, acked: false });
      held.set(event.eventId, identity);
      lastAppended = event.sequence;
      if (evidence) pendingEvidence++; else pendingViews++;
      notify();
      return { ok: true };
    },
    flush,
    async reconcile() {
      if (disposed) throw new PersistenceError(diagnostic('DISPOSED', '$', 'The journal outbox was disposed.'));
      if (flushing) await flushing;
      cancelRetry();
      let cursor: JournalCursor;
      try { cursor = await withTimeout(() => host.getJournalCursor({ activityId })); } catch (error) {
        const next = failureOf(error, 'journal cursor request');
        if (!disposed) recordFailure(next);
        throw new PersistenceError(next.diagnostic);
      }
      if (disposed) throw new PersistenceError(diagnostic('DISPOSED', '$', 'The journal outbox was disposed.'));
      if (!validateRecord(MESSAGES.journalCursor, cursor).ok || cursor.activityId !== activityId) {
        const next: HostFailure = { permanent: false, diagnostic: diagnostic('PERSISTENCE_FAILED', '$', 'The host returned an invalid journal cursor.', 'Retry reconciliation; local events are kept.') };
        recordFailure(next);
        throw new PersistenceError(next.diagnostic);
      }
      hostCursor = cursor;
      const conflict = (message: string) => {
        failure = { permanent: true, diagnostic: diagnostic('CONFLICT', '$.lastSequence', message, 'The host must reconcile its journal for this activity; local events are kept and nothing was dropped.') };
        notify();
        return { cursor, resent: 0 };
      };
      if (cursor.lastSequence < acknowledgedThrough) return conflict('The host journal ends before events it already acknowledged.');
      if (cursor.lastSequence > lastAppended) {
        if (pendingCount() > 0) return conflict('The host journal holds events beyond this outbox while local events are unconfirmed.');
        lastAppended = acknowledgedThrough = cursor.lastSequence;
        lastAcknowledgedId = cursor.lastEventId;
      }
      failure = null;
      attempts = 0;
      notify();
      const before = sent;
      await flush();
      return { cursor: hostCursor ?? cursor, resent: sent - before };
    },
    state: snapshot,
    pendingEvents: () => entries.filter(entry => !entry.acked).map(entry => structuredClone(entry.event)),
    acknowledgedEvents: () => [...mirror, ...entries.filter(entry => entry.acked).map(entry => entry.event)]
      .sort((a, b) => a.sequence - b.sequence).map(event => structuredClone(event)),
    trimmedBefore: () => trimmed,
    nextSequence: () => lastAppended + 1,
    checkpoint() {
      const cursor: JournalCursor = { activityId, lastSequence: acknowledgedThrough, lastEventId: lastAcknowledgedId ?? (hostCursor?.lastSequence === acknowledgedThrough ? hostCursor.lastEventId : null), checkpointDigest: hostCursor?.lastSequence === acknowledgedThrough ? hostCursor.checkpointDigest : null };
      return { cursor, pendingEventIds: entries.filter(entry => !entry.acked).map(entry => entry.event.eventId) };
    },
    forgetAcknowledged(predicate) {
      let removed = 0;
      for (let index = mirror.length - 1; index >= 0; index--) {
        const event = mirror[index]!;
        if (!predicate(structuredClone(event))) continue;
        mirror.splice(index, 1);
        held.delete(event.eventId);
        removed++;
      }
      return removed;
    },
    async requireFlushed(waitMs) {
      if (disposed) throw new PersistenceError(diagnostic('DISPOSED', '$', 'The journal outbox was disposed.'));
      if (!pendingCount()) return;
      const flushed = flush();
      if (waitMs === undefined) await flushed;
      else {
        let timer: unknown = null;
        const settled = await Promise.race([flushed.then(() => true), new Promise<boolean>(resolve => { timer = scheduler.setTimeout(() => resolve(false), Math.max(0, waitMs)); })]);
        if (timer !== null) scheduler.clearTimeout(timer);
        if (!settled && pendingCount() && !failure) {
          throw new PersistenceError(diagnostic('PERSISTENCE_PENDING', '$', `${pendingCount()} journal events are still being saved; the host has not answered yet.`,
            'The events stay queued and are sent as soon as the host answers. Repeat the operation with the same operation ID once persistence is saved.'));
        }
      }
      if (!pendingCount()) return;
      throw new PersistenceError(failure?.permanent
        ? diagnostic('PERSISTENCE_FAILED', '$', 'The host rejected journal events; this operation needs a durable record first.', 'The host must resolve the rejection; then retry persistence.')
        : diagnostic('PERSISTENCE_PENDING', '$', `${pendingCount()} journal events are not yet acknowledged by the host.`, 'Retry persistence or reconcile with the host, then repeat the operation.'));
    },
    dispose() {
      disposed = true;
      cancelRetry();
    },
  };
  return outbox;
}
