import { describe, expect, it, vi } from 'vitest';
import { createSessionRelay, createBrowserToolEndpoint } from '../../packages/agent/src/index';
import type { RelayCall, RelayCancel, RelayConnection, VisualizationTools } from '../../packages/agent/src/index';

const result = { ok: true as const, data: { visible: true } };
function fakeTools(): VisualizationTools { return { descriptors: [], execute: vi.fn(async () => result) }; }
const request = { principal: 'alice', sessionId: 'tab-one', requestId: 'request-one', name: 'visualization_inspect', input: {} };

describe('scoped relay transport', () => {
  it('requires authenticated principal authorization per operation and cannot redirect through arguments', async () => {
    const authorize = vi.fn(async (principal, sessionId) => principal === 'alice' && sessionId === 'tab-one'); const relay = createSessionRelay({ authorize });
    await expect(relay.connect({ principal: 'mallory', sessionId: 'tab-one', expiresAt: Date.now() + 10000, send() {} })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const connection = await relay.connect({ principal: 'alice', sessionId: 'tab-one', expiresAt: Date.now() + 10000, send() {} });
    await expect(relay.dispatch({ ...request, principal: 'mallory' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(relay.dispatch({ ...request, input: { guard: { sessionId: 'tab-two' } } })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(relay.dispatch({ ...request, name: 'filesystem_read' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(authorize).toHaveBeenCalledWith('alice', 'tab-one', 'visualization_inspect'); connection.disconnect(); relay.dispose();
  });
  it('correlates browser replies and keeps independent tabs isolated', async () => {
    const relay = createSessionRelay({ authorize: () => true }); const a = fakeTools(), b = fakeTools(); let connectionA!: RelayConnection, connectionB!: RelayConnection;
    const endpointA = createBrowserToolEndpoint({ sessionId: 'tab-one', tools: a, send: message => connectionA.receive(message) }); const endpointB = createBrowserToolEndpoint({ sessionId: 'tab-two', tools: b, send: message => connectionB.receive(message) });
    connectionA = await relay.connect({ principal: 'alice', sessionId: 'tab-one', expiresAt: Date.now() + 10000, send: message => endpointA.receive(message) });
    connectionB = await relay.connect({ principal: 'alice', sessionId: 'tab-two', expiresAt: Date.now() + 10000, send: message => endpointB.receive(message) });
    expect(await relay.dispatch(request)).toEqual(result); expect(a.execute).toHaveBeenCalledOnce(); expect(b.execute).not.toHaveBeenCalled();
    await expect(relay.dispatch({ ...request, requestId: 'request-two', sessionId: 'tab-two' })).resolves.toEqual(result); expect(b.execute).toHaveBeenCalledOnce();
    await expect(relay.dispatch(request)).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    endpointA.dispose(); endpointB.dispose(); relay.dispose();
  });
  it('deduplicates in-flight correlation IDs and rejects mismatched responses or payloads', async () => {
    const sent: (RelayCall | RelayCancel)[] = []; const relay = createSessionRelay({ authorize: () => true }); const connection = await relay.connect({ principal: 'alice', sessionId: 'tab-one', expiresAt: Date.now() + 10000, send: message => { sent.push(message); } });
    const a = relay.dispatch(request); const retry = relay.dispatch(request); await vi.waitFor(() => expect(sent).toHaveLength(1));
    await expect(relay.dispatch({ ...request, input: { includeDocument: true } })).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    expect(() => connection.receive({ type: 'response', sessionId: 'tab-two', requestId: 'request-one', result })).toThrow('correlate');
    connection.receive({ type: 'response', sessionId: 'tab-one', requestId: 'request-one', result }); expect(await a).toEqual(result); expect(await retry).toEqual(result); relay.dispose();
  });
  it('cancels in-flight browser computation and ignores its late response', async () => {
    let aborted = false; let connection!: RelayConnection;
    const endpoint = createBrowserToolEndpoint({ sessionId: 'tab-one', tools: { descriptors: [], execute: async (_name, _input, options) => new Promise(resolve => options!.signal!.addEventListener('abort', () => { aborted = true; resolve({ ok: false, diagnostics: [{ code: 'CANCELLED', path: '$', message: 'Cancelled.' }] }); })) }, send: message => connection.receive(message) });
    const relay = createSessionRelay({ authorize: () => true }); connection = await relay.connect({ principal: 'alice', sessionId: 'tab-one', expiresAt: Date.now() + 10000, send: message => endpoint.receive(message) });
    const controller = new AbortController(); const promise = relay.dispatch({ ...request, signal: controller.signal }); await vi.waitFor(() => expect((controller.signal as AbortSignal).aborted).toBe(false)); await new Promise(resolve => setTimeout(resolve, 0));
    controller.abort(); await expect(promise).rejects.toMatchObject({ code: 'CANCELLED' }); await vi.waitFor(() => expect(aborted).toBe(true)); endpoint.dispose(); relay.dispose();
  });
  it('disconnects pending calls and reconnects without allowing old connection replies', async () => {
    const relay = createSessionRelay({ authorize: () => true }); const first = await relay.connect({ principal: 'alice', sessionId: 'tab-one', expiresAt: Date.now() + 10000, send() {} });
    const pending = relay.dispatch(request); const rejection = expect(pending).rejects.toMatchObject({ code: 'RECONNECTED' }); await new Promise(resolve => setTimeout(resolve, 0));
    const second = await relay.connect({ principal: 'alice', sessionId: 'tab-one', expiresAt: Date.now() + 10000, send() {} }); await rejection; first.receive({ type: 'response', sessionId: 'tab-one', requestId: request.requestId, result }); first.disconnect();
    const next = relay.dispatch({ ...request, requestId: 'request-two' }); await new Promise(resolve => setTimeout(resolve, 0)); second.receive({ type: 'response', sessionId: 'tab-one', requestId: 'request-two', result }); await expect(next).resolves.toEqual(result); relay.dispose();
  });
  it('expires sessions, bounds concurrency and times out missing browser replies', async () => {
    let now = 0; const relay = createSessionRelay({ authorize: () => true, now: () => now, timeoutMs: 20, maxInFlight: 1 }); const connection = await relay.connect({ principal: 'alice', sessionId: 'tab-one', expiresAt: 10000, send() {} });
    const pending = relay.dispatch(request); const timeout = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' }); await new Promise(resolve => setTimeout(resolve, 0));
    await expect(relay.dispatch({ ...request, requestId: 'two' })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' }); await timeout; now = 10001;
    await expect(relay.dispatch({ ...request, requestId: 'expired' })).rejects.toMatchObject({ code: 'EXPIRED' }); connection.disconnect(); relay.dispose();
  });
  it('rejects endpoint cross-session calls and disposal aborts outstanding work', async () => {
    const tools = fakeTools(); const endpoint = createBrowserToolEndpoint({ sessionId: 'tab-one', tools, send() {} });
    await expect(endpoint.receive({ type: 'call', sessionId: 'tab-two', requestId: 'one', name: 'visualization_inspect', input: {} })).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(tools.execute).not.toHaveBeenCalled(); endpoint.dispose();
    await expect(endpoint.receive({ type: 'call', sessionId: 'tab-one', requestId: 'one', name: 'visualization_inspect', input: {} })).rejects.toMatchObject({ code: 'DISPOSED' });
  });
});

describe('host authorization lifecycle', () => {
  it('disposal releases pending authorization without waiting for host completion', async () => {
    const relay = createSessionRelay({ authorize: () => new Promise<boolean>(() => {}) });
    const pending = relay.connect({ principal: 'alice', sessionId: 'tab-one', expiresAt: Date.now() + 10000, send() {} });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'DISPOSED' }); relay.dispose(); await rejected;
  });
  it('bounds pending authorization concurrency and deadlines', async () => {
    const relay = createSessionRelay({ authorize: () => new Promise<boolean>(() => {}), maxInFlight: 1, timeoutMs: 5 });
    const pending = relay.dispatch(request); const rejected = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
    await expect(relay.dispatch({ ...request, requestId: 'other' })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' }); await rejected; relay.dispose();
  });
});
