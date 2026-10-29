/**
 * Activity tool relay (report §6.2 tool channel, §15.1, A55 relay authorization): host-authenticated principals bound
 * to one host session and activity, forged principals, other sessions, cross-activity requests, expired bindings,
 * authority claims in arguments, cancellation after commit and disconnect/reconnect with preserved operation
 * identity. The transport is in-process; the tools run against the fixture host. Fixture-host results only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createActivityRelay, createActivityToolEndpoint,
  type ActivityRelayCall, type ActivityRelayCancel, type ActivityRelayConnection, type ActivityToolResult, type ActivityTools,
} from '@explorable-models/agent';
import { settled, until } from '../activity/support/adapter-harness.js';
import { ACTIVITY_ID, SESSION_ID, atExplore, codesOf, dataOf, expectedGuards, opId, rig, type Rig } from './support/activity-tools.js';

const rigs: Rig[] = [];
afterEach(() => { for (const r of rigs.splice(0)) r.h.adapter.dispose(); });
const target = { hostSessionId: SESSION_ID, activityId: ACTIVITY_ID };
/** Host ACL: the authenticated principal "tutor-agent" may use activity tools on two activities of session-1. */
const acl = vi.fn((principal: string, where: { hostSessionId: string; activityId: string }) =>
  principal === 'tutor-agent' && where.hostSessionId === SESSION_ID && ['act-quadratic-1', 'act-other'].includes(where.activityId));

/** Counting wrapper so tests can see whether a call reached the learner-side tools. */
function counted(tools: ActivityTools) {
  const calls: string[] = [];
  return { calls, tools: { descriptors: tools.descriptors, execute: (name: string, input: unknown, options?: { signal?: AbortSignal }) => { calls.push(name); return tools.execute(name, input, options); } } as ActivityTools };
}
/** Relay, endpoint and connection wired in-process, as a host would wire its authenticated channel. */
async function wire(tools: ActivityTools, options: { now?: () => number; expiresAt?: number } = {}) {
  const relay = createActivityRelay({ authorize: acl, ...(options.now ? { now: options.now } : {}) });
  let connection!: ActivityRelayConnection;
  const endpoint = createActivityToolEndpoint({ ...target, tools, send: message => connection.receive(message) });
  connection = await relay.connect({ principal: 'tutor-agent', ...target, expiresAt: options.expiresAt ?? Date.now() + 60_000, send: message => endpoint.receive(message) });
  return { relay, endpoint, connection };
}

describe('activity relay authorization', () => {
  it('binds the authenticated principal to one activity and rejects forged principals, other sessions and cross-activity calls', async () => {
    const r = rig(); rigs.push(r);
    await atExplore(r);
    const { relay, endpoint } = await wire(r.tools);
    await expect(relay.connect({ principal: 'mallory', ...target, expiresAt: Date.now() + 1000, send() {} })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const call = { principal: 'tutor-agent', ...target, requestId: 'request-1', name: 'activity_inspect', input: {} };
    const inspected = dataOf(await relay.dispatch(call));
    expect(inspected.projection.stage.id).toBe('explore-step');
    expect(acl).toHaveBeenCalledWith('tutor-agent', target, 'activity_inspect');
    await expect(relay.dispatch({ ...call, requestId: 'request-2', principal: 'mallory' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(relay.dispatch({ ...call, requestId: 'request-3', hostSessionId: 'session-2' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // The ACL allows act-other, but this principal is not bound to it: a cross-activity request is refused.
    await expect(relay.dispatch({ ...call, requestId: 'request-4', activityId: 'act-other' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    for (const field of ['activityId', 'hostSessionId', 'actor', 'origin', 'principal', 'review']) {
      await expect(relay.dispatch({ ...call, requestId: `request-${field}`, input: { [field]: 'act-other' } }), field).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    await expect(relay.dispatch({ ...call, requestId: 'request-5', name: 'visualization_create' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(relay.dispatch({ ...call, requestId: 'request-1' })).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    await expect(relay.dispatch({ ...call, requestId: 'request-6', input: cyclic })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(relay.dispatch({ ...call, requestId: 'request-7', input: { padding: 'x'.repeat(2_000_000) } })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
    endpoint.dispose(); relay.dispose();
  });

  it('rejects expired bindings and tool replies that do not correlate', async () => {
    const r = rig(); rigs.push(r);
    await atExplore(r);
    let now = 1_000;
    const { relay, connection, endpoint } = await wire(r.tools, { now: () => now, expiresAt: 2_000 });
    await expect(relay.connect({ principal: 'tutor-agent', ...target, expiresAt: 500, send() {} })).rejects.toMatchObject({ code: 'EXPIRED' });
    expect(() => connection.receive({ type: 'activity-response', requestId: 'x', hostSessionId: SESSION_ID, activityId: 'act-other', result: { ok: false, diagnostics: [] } } as never)).toThrow(/correlate/);
    expect(() => connection.receive({ type: 'activity-response', requestId: 'x', ...target, result: { ok: true } } as never)).toThrow(/Malformed/);
    now = 2_001;
    await expect(relay.dispatch({ principal: 'tutor-agent', ...target, requestId: 'late', name: 'activity_inspect', input: {} })).rejects.toMatchObject({ code: 'EXPIRED' });
    // The expired binding is gone: a fresh connect must be authorized again and starts a new binding.
    await expect(relay.dispatch({ principal: 'tutor-agent', ...target, requestId: 'later', name: 'activity_inspect', input: {} })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    endpoint.dispose(); relay.dispose();
  });

  it('a malformed or oversized reply fails its pending call at once instead of waiting for the deadline', async () => {
    const sent: (ActivityRelayCall | ActivityRelayCancel)[] = [];
    const relay = createActivityRelay({ authorize: acl, timeoutMs: 60_000 });
    const connection = await relay.connect({ principal: 'tutor-agent', ...target, expiresAt: Date.now() + 120_000, send: message => { sent.push(message); } });
    const malformed = relay.dispatch({ principal: 'tutor-agent', ...target, requestId: 'bad-1', name: 'activity_inspect', input: {} });
    await until(() => sent.length === 1);
    expect(() => connection.receive({ type: 'activity-response', requestId: 'bad-1', ...target, result: { ok: true } } as never)).toThrow(/Malformed/);
    await expect(malformed).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    const oversized = relay.dispatch({ principal: 'tutor-agent', ...target, requestId: 'bad-2', name: 'activity_inspect', input: {} });
    await until(() => sent.length === 2);
    expect(() => connection.receive({ type: 'activity-response', requestId: 'bad-2', ...target, result: { ok: true, data: { padding: 'x'.repeat(9_000_000) }, scope: {} } } as never)).toThrow();
    await expect(oversized).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
    relay.dispose();
  });

  it('the learner-side endpoint serves exactly one host session and activity', async () => {
    const r = rig(); rigs.push(r);
    const { tools, calls } = counted(r.tools);
    const endpoint = createActivityToolEndpoint({ ...target, tools, send() {} });
    await expect(endpoint.receive({ type: 'activity-call', requestId: 'one', hostSessionId: SESSION_ID, activityId: 'act-other', name: 'activity_inspect', input: {} })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(endpoint.receive({ type: 'activity-call', requestId: 'two', hostSessionId: 'session-2', activityId: ACTIVITY_ID, name: 'activity_inspect', input: {} })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(calls).toEqual([]);
    endpoint.dispose();
    await expect(endpoint.receive({ type: 'activity-call', requestId: 'three', ...target, name: 'activity_inspect', input: {} })).rejects.toMatchObject({ code: 'DISPOSED' });
  });
});

describe('operation identity across cancellation and reconnection', () => {
  it('a cancellation after the commit returns the committed result idempotently without a second commit', async () => {
    const r = rig(); rigs.push(r);
    await atExplore(r);
    const { tools, calls } = counted(r.tools);
    const { relay, endpoint } = await wire(tools);
    r.h.workers.delayMs = 20;
    const operationId = opId('commit');
    const input = { action: 'commit-parameters', operationId, values: { eta: 1 }, expected: await expectedGuards(r) };
    const controller = new AbortController();
    const first = relay.dispatch({ principal: 'tutor-agent', ...target, requestId: 'commit-1', name: 'activity_operate', input, signal: controller.signal });
    const rejected = expect(first).rejects.toMatchObject({ code: 'CANCELLED' });
    await until(() => calls.length === 1);
    await new Promise(resolve => setTimeout(resolve, 5));
    controller.abort();
    await rejected;
    // The tools finish the started commit; the late reply is recorded for its operation.
    await until(() => r.learner().getProjection().controls[0]!.value === 1);
    await settled(r.h);
    const retry = await relay.dispatch({ principal: 'tutor-agent', ...target, requestId: 'commit-2', name: 'activity_operate', input });
    expect(dataOf(retry).projection.controls[0].value).toBe(1);
    expect(calls).toHaveLength(1);
    expect(r.h.host.events(ACTIVITY_ID).filter(event => event.type === 'parameters.committed' && event.operationId === operationId)).toHaveLength(1);
    const conflict = await relay.dispatch({ principal: 'tutor-agent', ...target, requestId: 'commit-3', name: 'activity_operate', input: { ...input, values: { eta: 1.5 } } });
    expect(codesOf(conflict)).toEqual(['OPERATION_CONFLICT']);
    expect(calls).toHaveLength(1);
    endpoint.dispose(); relay.dispose();
  });

  it('a cancellation before the learner side started changes nothing and the same operation can run later', async () => {
    const r = rig(); rigs.push(r);
    await atExplore(r);
    const sent: (ActivityRelayCall | ActivityRelayCancel)[] = [];
    const relay = createActivityRelay({ authorize: acl });
    await relay.connect({ principal: 'tutor-agent', ...target, expiresAt: Date.now() + 60_000, send: message => { sent.push(message); } });
    const input = { action: 'commit-parameters', operationId: opId('commit'), values: { eta: 1.25 }, expected: await expectedGuards(r) };
    const controller = new AbortController();
    const pending = relay.dispatch({ principal: 'tutor-agent', ...target, requestId: 'held-1', name: 'activity_operate', input, signal: controller.signal });
    await until(() => sent.length === 1);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(sent.at(-1)).toMatchObject({ type: 'activity-cancel', requestId: 'held-1' });
    expect(r.learner().getProjection().controls[0]!.value).not.toBe(1.25);
    relay.dispose();
    const { relay: next, endpoint } = await wire(r.tools);
    expect(dataOf(await next.dispatch({ principal: 'tutor-agent', ...target, requestId: 'held-2', name: 'activity_operate', input })).projection.controls[0].value).toBe(1.25);
    endpoint.dispose(); next.dispose();
  });

  it('disconnect and reconnect keep operation identity: identical retries return the committed result, changed ones conflict', async () => {
    const r = rig(); rigs.push(r);
    await atExplore(r);
    const { tools, calls } = counted(r.tools);
    const relay = createActivityRelay({ authorize: acl });
    let first!: ActivityRelayConnection;
    const firstEndpoint = createActivityToolEndpoint({ ...target, tools, send: message => first.receive(message) });
    first = await relay.connect({ principal: 'tutor-agent', ...target, expiresAt: Date.now() + 60_000, send: message => firstEndpoint.receive(message) });
    r.h.workers.delayMs = 20;
    const input = { action: 'commit-parameters', operationId: opId('commit'), values: { eta: 0.5 }, expected: await expectedGuards(r) };
    const pending = relay.dispatch({ principal: 'tutor-agent', ...target, requestId: 'before-drop', name: 'activity_operate', input });
    const dropped = expect(pending).rejects.toMatchObject({ code: 'DISCONNECTED' });
    await until(() => calls.length === 1);
    await new Promise(resolve => setTimeout(resolve, 5));
    first.disconnect();
    firstEndpoint.dispose();
    await dropped;
    await until(() => r.learner().getProjection().controls[0]!.value === 0.5);
    await settled(r.h);
    await expect(relay.dispatch({ principal: 'tutor-agent', ...target, requestId: 'while-down', name: 'activity_inspect', input: {} })).rejects.toMatchObject({ code: 'DISCONNECTED' });
    // Reconnect (new transport and endpoint over the same learner-side tools).
    let second!: ActivityRelayConnection;
    const secondEndpoint = createActivityToolEndpoint({ ...target, tools, send: message => second.receive(message) });
    second = await relay.connect({ principal: 'tutor-agent', ...target, expiresAt: Date.now() + 60_000, send: message => secondEndpoint.receive(message) });
    const conflict = await relay.dispatch({ principal: 'tutor-agent', ...target, requestId: 'after-drop-1', name: 'activity_operate', input: { ...input, values: { eta: 0.6 } } });
    expect(codesOf(conflict)).toEqual(['OPERATION_CONFLICT']);
    const retry = await relay.dispatch({ principal: 'tutor-agent', ...target, requestId: 'after-drop-2', name: 'activity_operate', input });
    expect(dataOf(retry).projection.controls[0].value).toBe(0.5);
    expect(r.h.host.events(ACTIVITY_ID).filter(event => event.type === 'parameters.committed' && event.operationId === input.operationId)).toHaveLength(1);
    // The relay now holds the result: a further identical retry does not reach the learner side.
    const before = calls.length;
    expect(await relay.dispatch({ principal: 'tutor-agent', ...target, requestId: 'after-drop-3', name: 'activity_operate', input })).toEqual(retry);
    expect(calls).toHaveLength(before);
    secondEndpoint.dispose(); relay.dispose();
  });

  it('read-only results are never retained by the relay and another binding cannot replay recorded operations', async () => {
    const r = rig({ audience: 'teacher' }); rigs.push(r);
    await atExplore(r);
    const { tools, calls } = counted(r.tools);
    const { relay, endpoint } = await wire(tools);
    const sample = { parameters: { a: 2, eta: 0.5, x0: 4 }, positions: [{ kind: 'index', index: 2 }] };
    const first = dataOf(await relay.dispatch({ principal: 'tutor-agent', ...target, requestId: 'sample-1', name: 'activity_sample', input: sample }));
    dataOf(await relay.dispatch({ principal: 'tutor-agent', ...target, requestId: 'sample-2', name: 'activity_sample', input: sample }));
    expect(calls.filter(name => name === 'activity_sample')).toHaveLength(2);
    expect(first.frames).toHaveLength(1);
    const input = { action: 'select', operationId: opId('select'), target: 'landscape', expected: await expectedGuards(r) };
    const result: ActivityToolResult = await relay.dispatch({ principal: 'tutor-agent', ...target, requestId: 'select-1', name: 'activity_operate', input });
    expect(result.ok).toBe(true);
    relay.unbind({ principal: 'tutor-agent', ...target });
    await expect(relay.dispatch({ principal: 'tutor-agent', ...target, requestId: 'select-2', name: 'activity_operate', input })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    endpoint.dispose(); relay.dispose();
  });
});
