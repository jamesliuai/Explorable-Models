/**
 * Authenticated relay for the policy-scoped activity tools (report §6.2 tool channel, §15.1; extends the session relay
 * pattern of relay.ts). The activity adapter and its tools live with the learner surface (the WebView); the agent runs
 * in the host. The host authenticates the principal and binds it to exactly one host session and activity; tool
 * arguments can never name a principal, session or activity.
 *
 * - `dispatch` rejects principals that are not bound to the requested activity (forged principals, other sessions and
 *   cross-activity requests are all unbound triples), expired bindings and arguments that try to claim authority.
 * - Operation identity is kept per binding across disconnect and reconnect: an identical retry of an operation whose
 *   result the relay already received returns that result without a second call; changed arguments for a known
 *   operationId fail with OPERATION_CONFLICT. A reply that arrives after its request was cancelled or timed out is
 *   still recorded for its operation, so a cancellation after commit returns the committed result idempotently.
 * - Read-only results (inspection, summaries, samples) carry no operationId and are never retained by the relay.
 */
import { canonicalJSON, sha256 } from '@experiment-kit/core';
import { jsonDataErrors } from '@experiment-kit/core/model';
import { ACTIVITY_TOOL_DESCRIPTORS, ACTIVITY_TOOL_LIMITS, ACTIVITY_TOOL_MESSAGES, AUTHORITY_FIELDS, type ActivityToolResult, type ActivityTools } from './activity-tools.js';
import { RelayError } from './relay.js';

export interface ActivityRelayTarget { hostSessionId: string; activityId: string }
export interface ActivityRelayCall { type: 'activity-call'; requestId: string; hostSessionId: string; activityId: string; name: string; input: unknown }
export interface ActivityRelayCancel { type: 'activity-cancel'; requestId: string; hostSessionId: string; activityId: string }
export interface ActivityRelayResponse { type: 'activity-response'; requestId: string; hostSessionId: string; activityId: string; result: ActivityToolResult }
export interface ActivityRelayOptions {
  /** Host ACL over a principal established by the host's own authentication, never a model-supplied identity. */
  authorize: (principal: string, target: ActivityRelayTarget, operation: string) => boolean | Promise<boolean>;
  now?: () => number;
  timeoutMs?: number;
  maxInFlight?: number;
}
export interface ActivityRelayConnection {
  receive(message: ActivityRelayResponse): void;
  disconnect(): void;
}
export interface ActivityRelay {
  /** Binds an authenticated principal to one host session and activity until `expiresAt`, replacing an earlier connection. */
  connect(options: ActivityRelayTarget & { principal: string; expiresAt: number; send: (message: ActivityRelayCall | ActivityRelayCancel) => void | Promise<void> }): Promise<ActivityRelayConnection>;
  dispatch(options: ActivityRelayTarget & { principal: string; requestId: string; name: string; input: unknown; signal?: AbortSignal }): Promise<ActivityToolResult>;
  /** Ends a binding (for example when the host re-authorizes a new tool set); pending calls are cancelled. */
  unbind(options: ActivityRelayTarget & { principal: string }): void;
  dispose(): void;
}

export const ACTIVITY_RELAY_LIMITS = Object.freeze({ operations: 256, retiredRequests: 1024, maxInFlight: 64, timeoutMs: 60_000, responseBytes: 8_388_608 });
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/;
const TOOL_NAMES: ReadonlySet<string> = new Set(ACTIVITY_TOOL_DESCRIPTORS.map(descriptor => descriptor.name));
const MUTATING: ReadonlySet<string> = new Set(ACTIVITY_TOOL_DESCRIPTORS.filter(descriptor => descriptor.scope.mutates).map(descriptor => descriptor.name));
const AUTHORITY: ReadonlySet<string> = new Set(AUTHORITY_FIELDS);
/** Results that a retry may legitimately change; they are not retained as the operation's result. */
const TRANSIENT: ReadonlySet<string> = new Set(['PERSISTENCE_FAILED', 'PERSISTENCE_PENDING', 'PERSISTENCE_BACKPRESSURE', 'WORKER_ERROR', 'WORKER_TIMEOUT', 'RESOURCE_LIMIT', 'CANCELLED', 'NOT_READY', 'DISPOSED', 'STALE_POLICY_REVISION']);

function identifier(value: unknown, name: string): asserts value is string { if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new RelayError('INVALID_REQUEST', `Invalid ${name}.`); }
/** Bounded, getter-free JSON check before any traversal by JSON.stringify; returns a detached copy. */
function bounded(value: unknown, maxBytes: number = ACTIVITY_TOOL_LIMITS.inputBytes, maxNodes: number = ACTIVITY_TOOL_LIMITS.maxNodes): unknown {
  const errors = jsonDataErrors(value, { maxBytes, maxDepth: ACTIVITY_TOOL_LIMITS.maxDepth + 4, maxNodes });
  if (errors.length) throw new RelayError(errors[0]!.code === 'RESOURCE_LIMIT' ? 'RESOURCE_LIMIT' : 'INVALID_REQUEST', 'Relay payload must be bounded, acyclic plain JSON data.');
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value)) as unknown;
}
const transient = (result: ActivityToolResult): boolean => result.ok ? result.data.status === 'pending' : result.diagnostics.some(item => TRANSIENT.has(item.code));
const conflict = (): ActivityToolResult => ({ ok: false, diagnostics: [{ code: 'OPERATION_CONFLICT', path: '$.operationId', ...ACTIVITY_TOOL_MESSAGES.OPERATION_CONFLICT }] });
function wellFormed(result: unknown): result is ActivityToolResult {
  if (!result || typeof result !== 'object') return false;
  const value = result as { ok?: unknown; data?: unknown; scope?: unknown; diagnostics?: unknown };
  return value.ok === true ? !!value.data && typeof value.data === 'object' && !!value.scope && typeof value.scope === 'object'
    : value.ok === false && Array.isArray(value.diagnostics) && value.diagnostics.length > 0;
}

type Pending = { promise: Promise<ActivityToolResult>; fingerprint: string; operation: string | null; resolve: (value: ActivityToolResult) => void; reject: (error: unknown) => void; cleanup: () => void };
type Route = { binding: Binding; send: (message: ActivityRelayCall | ActivityRelayCancel) => void | Promise<void>; pending: Map<string, Pending>; retired: Map<string, string | null>; connected: boolean };
type Operation = { fingerprint: string; result: ActivityToolResult | null };
type Binding = ActivityRelayTarget & { principal: string; expiresAt: number; route: Route | null; operations: Map<string, Operation> };

/** Transport-neutral relay; bind its callbacks to the host's authenticated channel to the learner WebView. */
export function createActivityRelay(options: ActivityRelayOptions): ActivityRelay {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 15_000, maxInFlight = options.maxInFlight ?? 16;
  if (typeof options.authorize !== 'function') throw new RelayError('INVALID_OPTIONS', 'An authorization callback is required.');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > ACTIVITY_RELAY_LIMITS.timeoutMs || !Number.isSafeInteger(maxInFlight) || maxInFlight < 1 || maxInFlight > ACTIVITY_RELAY_LIMITS.maxInFlight)
    throw new RelayError('INVALID_OPTIONS', 'Relay timeout or concurrency limit is invalid.');
  const bindings = new Map<string, Binding>();
  const waiting = new Set<() => void>();
  let disposed = false;
  const key = (principal: string, hostSessionId: string, activityId: string) => JSON.stringify([principal, hostSessionId, activityId]);

  function authorize(principal: string, target: ActivityRelayTarget, operation: string, signal?: AbortSignal): Promise<boolean> {
    if (disposed) return Promise.reject(new RelayError('DISPOSED', 'Relay disposed.'));
    if (signal?.aborted) return Promise.reject(new RelayError('CANCELLED', 'Request cancelled during authorization.'));
    if (waiting.size >= maxInFlight) return Promise.reject(new RelayError('RESOURCE_LIMIT', 'Too many pending authorization checks.'));
    return new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const finish = (value: boolean | RelayError) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); waiting.delete(onDispose);
        if (value instanceof RelayError) reject(value); else resolve(value);
      };
      const onAbort = () => finish(new RelayError('CANCELLED', 'Request cancelled during authorization.'));
      const onDispose = () => finish(new RelayError('DISPOSED', 'Relay disposed during authorization.'));
      const timer = setTimeout(() => finish(new RelayError('TIMEOUT', 'Host authorization deadline exceeded.')), timeoutMs);
      waiting.add(onDispose); signal?.addEventListener('abort', onAbort, { once: true });
      try { Promise.resolve(options.authorize(principal, { ...target }, operation)).then(value => finish(value === true), () => finish(new RelayError('AUTHORIZATION_FAILED', 'Host authorization failed.'))); }
      catch { finish(new RelayError('AUTHORIZATION_FAILED', 'Host authorization failed.')); }
    });
  }
  const notify = (route: Route, message: ActivityRelayCall | ActivityRelayCancel) => {
    try { Promise.resolve(route.send(message)).catch(() => close(route, 'DISCONNECTED', 'Learner transport disconnected.')); } catch { close(route, 'DISCONNECTED', 'Learner transport disconnected.'); }
  };
  function close(route: Route, code: string, message: string): void {
    if (!route.connected) return;
    route.connected = false;
    for (const [requestId, pending] of route.pending) {
      pending.cleanup(); pending.reject(new RelayError(code, message));
      try { void Promise.resolve(route.send({ type: 'activity-cancel', requestId, hostSessionId: route.binding.hostSessionId, activityId: route.binding.activityId })).catch(() => {}); } catch { /* A closed transport cannot receive cancellation. */ }
    }
    route.pending.clear();
    if (route.binding.route === route) route.binding.route = null;
  }
  /** Records a tool result for its operation (also for replies that arrive after cancellation). */
  function record(binding: Binding, operation: string | null, fingerprint: string, result: ActivityToolResult): void {
    if (!operation) return;
    const entry = binding.operations.get(operation);
    if (!entry || entry.fingerprint !== fingerprint) return;
    if (transient(result)) { binding.operations.delete(operation); return; }
    entry.result = result;
  }
  function remember(binding: Binding, operation: string, fingerprint: string): void {
    if (binding.operations.has(operation)) return;
    if (binding.operations.size >= ACTIVITY_RELAY_LIMITS.operations) binding.operations.delete(binding.operations.keys().next().value!);
    binding.operations.set(operation, { fingerprint, result: null });
  }

  return {
    async connect({ principal, hostSessionId, activityId, expiresAt, send }) {
      if (disposed) throw new RelayError('DISPOSED', 'Relay disposed.');
      identifier(principal, 'principal'); identifier(hostSessionId, 'hostSessionId'); identifier(activityId, 'activityId');
      if (typeof send !== 'function') throw new RelayError('INVALID_REQUEST', 'A transport send function is required.');
      if (!Number.isFinite(expiresAt) || expiresAt <= now()) throw new RelayError('EXPIRED', 'The binding is already expired.');
      if (!(await authorize(principal, { hostSessionId, activityId }, 'connect'))) throw new RelayError('FORBIDDEN', 'Principal is not authorized for this activity.');
      if (disposed || expiresAt <= now()) throw new RelayError('EXPIRED', 'The binding expired while authorizing.');
      const id = key(principal, hostSessionId, activityId);
      // Operation identity survives reconnects of the same binding; a new principal/session/activity starts empty.
      const binding: Binding = bindings.get(id) ?? { principal, hostSessionId, activityId, expiresAt, route: null, operations: new Map() };
      binding.expiresAt = expiresAt;
      bindings.set(id, binding);
      if (binding.route) close(binding.route, 'RECONNECTED', 'The learner connection was replaced; retry with the same operationId.');
      const route: Route = { binding, send, pending: new Map(), retired: new Map(), connected: true };
      binding.route = route;
      return {
        receive(raw) {
          if (disposed) return;
          // A reply that correlates to a pending call but cannot be accepted fails that call instead of leaving it to time out.
          const correlated = raw && typeof raw === 'object' ? Object.getOwnPropertyDescriptor(raw, 'requestId')?.value : undefined;
          const refuse = (code: string, text: string): never => {
            const waiting = typeof correlated === 'string' ? route.pending.get(correlated) : undefined;
            const error = new RelayError(code, text);
            if (waiting && route.connected) { route.pending.delete(correlated as string); route.retired.set(correlated as string, waiting.operation); waiting.cleanup(); waiting.reject(error); }
            throw error;
          };
          let message: ActivityRelayResponse;
          try { message = bounded(raw, ACTIVITY_RELAY_LIMITS.responseBytes, ACTIVITY_RELAY_LIMITS.responseBytes / 16) as ActivityRelayResponse; } catch (error) { return refuse(error instanceof RelayError && error.code === 'RESOURCE_LIMIT' ? 'RESOURCE_LIMIT' : 'INVALID_RESPONSE', 'The tool response is not bounded JSON data.'); }
          if (!message || message.type !== 'activity-response' || message.hostSessionId !== hostSessionId || message.activityId !== activityId || typeof message.requestId !== 'string')
            throw new RelayError('INVALID_RESPONSE', 'Response does not correlate to this activity binding.');
          if (!wellFormed(message.result)) return refuse('INVALID_RESPONSE', 'Malformed tool response.');
          const pending = route.pending.get(message.requestId);
          if (pending) {
            route.pending.delete(message.requestId); route.retired.set(message.requestId, pending.operation); pending.cleanup();
            record(binding, pending.operation, pending.fingerprint, message.result);
            pending.resolve(message.result);
            return;
          }
          // A late reply on this live connection cannot resolve anything, but its committed result is kept for the operation.
          if (route.connected && route.retired.has(message.requestId)) {
            const operation = route.retired.get(message.requestId) ?? null;
            const entry = operation ? binding.operations.get(operation) : undefined;
            if (entry) record(binding, operation, entry.fingerprint, message.result);
          }
        },
        disconnect() { close(route, 'DISCONNECTED', 'Learner transport disconnected; retry with the same operationId after reconnecting.'); },
      };
    },

    async dispatch({ principal, hostSessionId, activityId, requestId, name, input, signal }) {
      if (disposed) throw new RelayError('DISPOSED', 'Relay disposed.');
      identifier(principal, 'principal'); identifier(hostSessionId, 'hostSessionId'); identifier(activityId, 'activityId'); identifier(requestId, 'requestId');
      if (typeof name !== 'string' || !TOOL_NAMES.has(name)) throw new RelayError('FORBIDDEN', 'Tool is not in the activity relay allowlist.');
      const payload = bounded(input);
      if (payload && typeof payload === 'object' && !Array.isArray(payload) && Object.keys(payload).some(field => AUTHORITY.has(field)))
        throw new RelayError('FORBIDDEN', 'Tool arguments cannot choose a principal, session, activity or authority.');
      const target = { hostSessionId, activityId };
      if (!(await authorize(principal, target, name, signal))) throw new RelayError('FORBIDDEN', 'Principal is not authorized for this activity and operation.');
      if (disposed) throw new RelayError('DISPOSED', 'Relay disposed.');
      const binding = bindings.get(key(principal, hostSessionId, activityId));
      if (!binding) throw new RelayError('FORBIDDEN', 'Principal is not bound to this host session and activity.');
      if (binding.expiresAt <= now()) {
        if (binding.route) close(binding.route, 'EXPIRED', 'The binding expired.');
        bindings.delete(key(principal, hostSessionId, activityId));
        throw new RelayError('EXPIRED', 'The binding expired.');
      }
      if (signal?.aborted) throw new RelayError('CANCELLED', 'Request was cancelled.');
      const fingerprint = sha256(canonicalJSON({ name, input: payload ?? null }));
      const operationId = MUTATING.has(name) && payload && typeof payload === 'object' ? (payload as { operationId?: unknown }).operationId : undefined;
      const operation = typeof operationId === 'string' ? operationId : null;
      if (operation) {
        const known = binding.operations.get(operation);
        if (known && known.fingerprint !== fingerprint) return conflict();
        if (known?.result) return structuredClone(known.result);
      }
      const route = binding.route;
      if (!route?.connected) throw new RelayError('DISCONNECTED', 'No learner connection is bound to this activity.');
      const previous = route.pending.get(requestId);
      if (previous) { if (previous.fingerprint !== fingerprint) throw new RelayError('REQUEST_CONFLICT', 'Correlation ID is already in use for another request.'); return previous.promise; }
      if (route.retired.has(requestId)) throw new RelayError('REQUEST_CONFLICT', 'Completed correlation IDs cannot be reused; retry with a new correlation ID and the same operationId.');
      if (route.retired.size >= ACTIVITY_RELAY_LIMITS.retiredRequests) throw new RelayError('RESOURCE_LIMIT', 'Reconnect this transport to reset its bounded correlation history.');
      if (route.pending.size >= maxInFlight) throw new RelayError('RESOURCE_LIMIT', 'Too many in-flight relay requests.');
      if (operation) remember(binding, operation, fingerprint);
      let resolve!: Pending['resolve'], reject!: Pending['reject'];
      const promise = new Promise<ActivityToolResult>((yes, no) => { resolve = yes; reject = no; });
      const cancel = (code: string, message: string) => {
        const pending = route.pending.get(requestId);
        if (!pending) return;
        route.pending.delete(requestId); route.retired.set(requestId, operation); pending.cleanup();
        notify(route, { type: 'activity-cancel', requestId, hostSessionId, activityId });
        reject(new RelayError(code, message));
      };
      const onAbort = () => cancel('CANCELLED', 'Relay request cancelled; retry with the same operationId to obtain the result if it committed.');
      const remaining = binding.expiresAt - now();
      const timer = setTimeout(() => cancel(remaining <= timeoutMs ? 'EXPIRED' : 'TIMEOUT', remaining <= timeoutMs ? 'The binding expired.' : 'Learner response deadline exceeded.'), Math.min(timeoutMs, remaining));
      route.pending.set(requestId, { promise, fingerprint, operation, resolve, reject, cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); } });
      signal?.addEventListener('abort', onAbort, { once: true });
      notify(route, { type: 'activity-call', requestId, hostSessionId, activityId, name, input: payload });
      return promise;
    },

    unbind({ principal, hostSessionId, activityId }) {
      const id = key(principal, hostSessionId, activityId);
      const binding = bindings.get(id);
      if (!binding) return;
      if (binding.route) close(binding.route, 'FORBIDDEN', 'The host ended this binding.');
      bindings.delete(id);
    },

    dispose() {
      disposed = true;
      for (const cancelWait of [...waiting]) cancelWait();
      for (const binding of bindings.values()) if (binding.route) close(binding.route, 'DISPOSED', 'Relay disposed.');
      bindings.clear();
    },
  };
}

/** Learner-side endpoint: one endpoint serves exactly one host session and activity. */
export function createActivityToolEndpoint({ hostSessionId, activityId, tools, send }: ActivityRelayTarget & { tools: ActivityTools; send: (message: ActivityRelayResponse) => void | Promise<void> }) {
  identifier(hostSessionId, 'hostSessionId'); identifier(activityId, 'activityId');
  const pending = new Map<string, { controller: AbortController; promise: Promise<void>; fingerprint: string }>();
  let disposed = false;
  return {
    async receive(raw: ActivityRelayCall | ActivityRelayCancel): Promise<void> {
      if (disposed) throw new RelayError('DISPOSED', 'Endpoint disposed.');
      const message = bounded(raw) as ActivityRelayCall | ActivityRelayCancel;
      if (!message || typeof message !== 'object') throw new RelayError('INVALID_REQUEST', 'Unsupported relay envelope.');
      identifier(message.requestId, 'requestId');
      if (message.hostSessionId !== hostSessionId || message.activityId !== activityId) throw new RelayError('FORBIDDEN', 'Message targets another host session or activity.');
      if (message.type === 'activity-cancel') { pending.get(message.requestId)?.controller.abort(); return; }
      if (message.type !== 'activity-call') throw new RelayError('INVALID_REQUEST', 'Unsupported relay envelope.');
      const fingerprint = canonicalJSON(message);
      const existing = pending.get(message.requestId);
      if (existing) { if (existing.fingerprint !== fingerprint) throw new RelayError('REQUEST_CONFLICT', 'Correlation ID reused with another payload.'); return existing.promise; }
      if (pending.size >= ACTIVITY_RELAY_LIMITS.maxInFlight) throw new RelayError('RESOURCE_LIMIT', 'Endpoint is busy.');
      const controller = new AbortController();
      const promise = Promise.resolve().then(async () => {
        const result = await tools.execute(message.name, message.input, { signal: controller.signal });
        if (!disposed) await send({ type: 'activity-response', requestId: message.requestId, hostSessionId, activityId, result });
      }).finally(() => { pending.delete(message.requestId); });
      pending.set(message.requestId, { controller, promise, fingerprint });
      return promise;
    },
    dispose() { disposed = true; for (const { controller } of pending.values()) controller.abort(); pending.clear(); },
  };
}
