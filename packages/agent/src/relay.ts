import type { VisualizationToolResult, VisualizationTools } from './tools.js';
import { VISUALIZATION_TOOL_DESCRIPTORS, TOOL_LIMITS } from './tools.js';

export class RelayError extends Error { constructor(public code: string, message: string) { super(message); this.name = 'RelayError'; } }
export interface RelayCall { type: 'call'; requestId: string; sessionId: string; name: string; input: unknown }
export interface RelayCancel { type: 'cancel'; requestId: string; sessionId: string }
export interface RelayResponse { type: 'response'; requestId: string; sessionId: string; result: VisualizationToolResult }
export interface RelayOptions {
  /** Receives a principal established by the host's authentication, never a model-supplied identity. */
  authorize: (principal: string, sessionId: string, tool: string) => boolean | Promise<boolean>;
  now?: () => number;
  timeoutMs?: number;
  maxInFlight?: number;
}
export interface RelayConnection {
  receive(message: RelayResponse): void;
  disconnect(): void;
}
export interface SessionRelay {
  connect(options: { principal: string; sessionId: string; expiresAt: number; send: (message: RelayCall | RelayCancel) => void | Promise<void> }): Promise<RelayConnection>;
  dispatch(options: { principal: string; sessionId: string; requestId: string; name: string; input: unknown; signal?: AbortSignal }): Promise<VisualizationToolResult>;
  dispose(): void;
}
function identifier(value: string, name: string) { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/.test(value)) throw new RelayError('INVALID_REQUEST', `Invalid ${name}.`); }
function bounded(value: unknown, max = TOOL_LIMITS.inputBytes) {
  const ancestors = new Set<object>();
  const check = (item: unknown, depth: number) => {
    if (depth > 64) throw new RelayError('RESOURCE_LIMIT', 'Relay payload nesting exceeds its limit.');
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint' || (typeof item === 'number' && !Number.isFinite(item))) throw new RelayError('INVALID_REQUEST', 'Relay payload must contain finite JSON values.');
    if (item && typeof item === 'object') {
      if (ancestors.has(item) || (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)) throw new RelayError('INVALID_REQUEST', 'Relay payload must contain acyclic plain JSON objects.');
      ancestors.add(item); for (const child of Object.values(item)) check(child, depth + 1); ancestors.delete(item);
    }
  };
  check(value, 0);
  let bytes: string; try { bytes = JSON.stringify(value); } catch { throw new RelayError('INVALID_REQUEST', 'Relay payload must be JSON-compatible.'); }
  if (typeof bytes !== 'string' || new TextEncoder().encode(bytes).length > max) throw new RelayError('RESOURCE_LIMIT', 'Relay payload exceeds its byte limit.');
  return JSON.parse(bytes) as unknown;
}
type Pending = { promise: Promise<VisualizationToolResult>; fingerprint: string; resolve: (value: VisualizationToolResult) => void; reject: (error: unknown) => void; cleanup: () => void };
type Route = { principal: string; sessionId: string; expiresAt: number; send: (message: RelayCall | RelayCancel) => void | Promise<void>; pending: Map<string, Pending>; retired: Set<string>; connected: boolean };
/** Transport-neutral authenticated relay. Bind these callbacks to authenticated HTTP/WebSocket routes. */
export function createSessionRelay(options: RelayOptions): SessionRelay {
  const now = options.now ?? Date.now; const timeoutMs = options.timeoutMs ?? 15_000; const maxInFlight = options.maxInFlight ?? 16;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 || !Number.isSafeInteger(maxInFlight) || maxInFlight < 1 || maxInFlight > 64) throw new RelayError('INVALID_OPTIONS', 'Relay timeout or concurrency limit is invalid.');
  const routes = new Map<string, Route>(); let disposed = false;
  const authorizations = new Set<() => void>();
  const authorize = (principal: string, sessionId: string, operation: string, signal?: AbortSignal): Promise<boolean> => {
    if (disposed) return Promise.reject(new RelayError('DISPOSED', 'Relay disposed.'));
    if (signal?.aborted) return Promise.reject(new RelayError('CANCELLED', 'Request cancelled during authorization.'));
    if (authorizations.size >= maxInFlight) return Promise.reject(new RelayError('RESOURCE_LIMIT', 'Too many pending authorization checks.'));
    return new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const finish = (value: boolean | RelayError) => {
        if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); authorizations.delete(onDispose);
        if (value instanceof RelayError) reject(value); else resolve(value);
      };
      const onAbort = () => finish(new RelayError('CANCELLED', 'Request cancelled during authorization.'));
      const onDispose = () => finish(new RelayError('DISPOSED', 'Relay disposed during authorization.'));
      const timer = setTimeout(() => finish(new RelayError('TIMEOUT', 'Host authorization deadline exceeded.')), timeoutMs);
      authorizations.add(onDispose); signal?.addEventListener('abort', onAbort, { once: true });
      try { Promise.resolve(options.authorize(principal, sessionId, operation)).then(value => finish(value === true), () => finish(new RelayError('AUTHORIZATION_FAILED', 'Host authorization failed.'))); }
      catch { finish(new RelayError('AUTHORIZATION_FAILED', 'Host authorization failed.')); }
    });
  };
  const key = (principal: string, sessionId: string) => JSON.stringify([principal, sessionId]);
  const notify = (route: Route, message: RelayCall | RelayCancel) => { try { Promise.resolve(route.send(message)).catch(() => close(route, 'DISCONNECTED', 'Browser transport disconnected.')); } catch { close(route, 'DISCONNECTED', 'Browser transport disconnected.'); } };
  const close = (route: Route, code: string, message: string) => {
    if (!route.connected) return; route.connected = false;
    for (const [requestId, pending] of route.pending) { pending.cleanup(); pending.reject(new RelayError(code, message)); try { void Promise.resolve(route.send({ type: 'cancel', requestId, sessionId: route.sessionId })).catch(() => {}); } catch { /* A closed transport cannot receive cancellation. */ } }
    route.pending.clear(); if (routes.get(key(route.principal, route.sessionId)) === route) routes.delete(key(route.principal, route.sessionId));
  };
  return {
    async connect({ principal, sessionId, expiresAt, send }) {
      if (disposed) throw new RelayError('DISPOSED', 'Relay disposed.'); identifier(principal, 'principal'); identifier(sessionId, 'sessionId');
      if (!Number.isFinite(expiresAt) || expiresAt <= now()) throw new RelayError('EXPIRED', 'Browser session is already expired.');
      if (!(await authorize(principal, sessionId, 'connect'))) throw new RelayError('FORBIDDEN', 'Principal is not authorized for this browser session.');
      if (disposed || expiresAt <= now()) throw new RelayError('EXPIRED', 'Session expired while authorizing.');
      const previous = routes.get(key(principal, sessionId)); if (previous) close(previous, 'RECONNECTED', 'Browser connection was replaced. Retry with fresh guards.');
      const route: Route = { principal, sessionId, expiresAt, send, pending: new Map(), retired: new Set(), connected: true }; routes.set(key(principal, sessionId), route);
      return {
        receive(rawMessage) {
          if (!route.connected || disposed) return;
          if (route.expiresAt <= now()) { close(route, 'EXPIRED', 'Browser session expired.'); return; }
          const message = bounded(rawMessage) as RelayResponse;
          if (!message || message.type !== 'response' || message.sessionId !== sessionId || typeof message.requestId !== 'string') throw new RelayError('INVALID_RESPONSE', 'Response does not correlate to this browser session.');
          if (!message.result || typeof message.result.ok !== 'boolean' || (!message.result.ok && !Array.isArray(message.result.diagnostics))) throw new RelayError('INVALID_RESPONSE', 'Malformed tool response.');
          const pending = route.pending.get(message.requestId); if (!pending) return; // Late replies cannot mutate a newer request.
          route.pending.delete(message.requestId); route.retired.add(message.requestId); pending.cleanup(); pending.resolve(message.result);
        },
        disconnect() { close(route, 'DISCONNECTED', 'Browser disconnected; pending requests were cancelled.'); },
      };
    },
    async dispatch({ principal, sessionId, requestId, name, input, signal }) {
      if (disposed) throw new RelayError('DISPOSED', 'Relay disposed.'); identifier(principal, 'principal'); identifier(sessionId, 'sessionId'); identifier(requestId, 'requestId');
      if (!VISUALIZATION_TOOL_DESCRIPTORS.some(tool => tool.name === name)) throw new RelayError('FORBIDDEN', 'Tool is not in the relay allowlist.');
      const payload = bounded(input);
      if (!(await authorize(principal, sessionId, name, signal))) throw new RelayError('FORBIDDEN', 'Principal is not authorized for this session and operation.');
      const route = routes.get(key(principal, sessionId)); if (!route?.connected || disposed) throw new RelayError('DISCONNECTED', 'No authorized browser is connected.');
      if (route.expiresAt <= now()) { close(route, 'EXPIRED', 'Browser session expired.'); throw new RelayError('EXPIRED', 'Browser session expired.'); }
      if (signal?.aborted) throw new RelayError('CANCELLED', 'Request was cancelled.');
      if (payload && typeof payload === 'object' && 'guard' in payload && (payload as { guard?: { sessionId?: string } }).guard?.sessionId !== sessionId) throw new RelayError('FORBIDDEN', 'Tool guard cannot redirect to another session.');
      const fingerprint = JSON.stringify({ name, input: payload }); const previous = route.pending.get(requestId);
      if (previous) { if (previous.fingerprint !== fingerprint) throw new RelayError('REQUEST_CONFLICT', 'Correlation ID is already in use for another request.'); return previous.promise; }
      if (route.retired.has(requestId)) throw new RelayError('REQUEST_CONFLICT', 'Completed correlation IDs cannot be reused; retry with a new correlation ID and the same operation ID.');
      if (route.retired.size >= 1024) throw new RelayError('RESOURCE_LIMIT', 'Reconnect this browser transport to reset its bounded correlation history.');
      if (route.pending.size >= maxInFlight) throw new RelayError('RESOURCE_LIMIT', 'Too many in-flight relay requests.');
      let resolve!: Pending['resolve']; let reject!: Pending['reject'];
      const promise = new Promise<VisualizationToolResult>((yes, no) => { resolve = yes; reject = no; });
      const cancel = (code: string, message: string) => { const pending = route.pending.get(requestId); if (!pending) return; route.pending.delete(requestId); route.retired.add(requestId); pending.cleanup(); notify(route, { type: 'cancel', sessionId, requestId }); reject(new RelayError(code, message)); };
      const onAbort = () => cancel('CANCELLED', 'Relay request cancelled.');
      const remaining = route.expiresAt - now(); const timeout = setTimeout(() => cancel(remaining <= timeoutMs ? 'EXPIRED' : 'TIMEOUT', remaining <= timeoutMs ? 'Browser session expired.' : 'Browser response deadline exceeded.'), Math.min(timeoutMs, remaining));
      const pending = { promise, fingerprint, resolve, reject, cleanup: () => { clearTimeout(timeout); signal?.removeEventListener('abort', onAbort); } };
      route.pending.set(requestId, pending); signal?.addEventListener('abort', onAbort, { once: true });
      notify(route, { type: 'call', sessionId, requestId, name, input: payload }); return promise;
    },
    dispose() { disposed = true; for (const cancelAuthorization of [...authorizations]) cancelAuthorization(); for (const route of [...routes.values()]) close(route, 'DISPOSED', 'Relay disposed.'); routes.clear(); },
  };
}

/** Browser side of the explicit transport. One endpoint belongs to exactly one session. */
export function createBrowserToolEndpoint({ sessionId, tools, send }: { sessionId: string; tools: VisualizationTools; send: (message: RelayResponse) => void | Promise<void> }) {
  const pending = new Map<string, { controller: AbortController; promise: Promise<void>; fingerprint: string }>(); let disposed = false;
  return {
    async receive(rawMessage: RelayCall | RelayCancel): Promise<void> {
      if (disposed) throw new RelayError('DISPOSED', 'Browser endpoint disposed.');
      const message = bounded(rawMessage) as RelayCall | RelayCancel; identifier(message.requestId, 'requestId');
      if (message.sessionId !== sessionId) throw new RelayError('FORBIDDEN', 'Message targets another browser session.');
      if (message.type === 'cancel') { pending.get(message.requestId)?.controller.abort(); return; }
      if (message.type !== 'call') throw new RelayError('INVALID_REQUEST', 'Unsupported relay envelope.');
      const fingerprint = JSON.stringify(message); const existing = pending.get(message.requestId);
      if (existing) { if (existing.fingerprint !== fingerprint) throw new RelayError('REQUEST_CONFLICT', 'Correlation ID reused with another payload.'); return existing.promise; }
      if (pending.size >= 64) throw new RelayError('RESOURCE_LIMIT', 'Browser endpoint is busy.');
      const controller = new AbortController();
      const promise = Promise.resolve().then(async () => { const result = await tools.execute(message.name, message.input, { signal: controller.signal }); if (!disposed) await send({ type: 'response', sessionId, requestId: message.requestId, result }); }).finally(() => { pending.delete(message.requestId); });
      pending.set(message.requestId, { controller, promise, fingerprint }); return promise;
    },
    dispose() { disposed = true; for (const { controller } of pending.values()) controller.abort(); pending.clear(); },
  };
}
