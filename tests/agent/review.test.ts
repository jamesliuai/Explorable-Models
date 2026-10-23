/** Automated separate-agent boundary review; not independent human security review. */
import { describe, expect, it, vi } from 'vitest';
import { createSessionRelay } from '../../packages/agent/src/relay.js';
import type { RelayCall, RelayCancel } from '../../packages/agent/src/relay.js';
import { createVisualizationTools } from '../../packages/agent/src/tools.js';
import { createVisualizationSession } from '../../packages/core/src/declarative-session.js';
import { evaluateDocument } from '../../packages/core/src/declarative/evaluation.js';
import { createPreset } from '../../packages/core/src/presets.js';
import { DOCUMENT_SCHEMA, DOCUMENT_LIMITS } from '../../packages/core/src/declarative/schema.js';
const call = { principal: 'host-user', sessionId: 'browser-one', requestId: 'request-one', name: 'visualization_inspect', input: { includeDocument: false } };
describe('automated relay and tool contract review', () => {
    it('snapshots the request input before waiting for host authorization', async () => {
        let release!: (value: boolean) => void;
        let hold = false;
        const sent: (RelayCall | RelayCancel)[] = [];
        const relay = createSessionRelay({ authorize: () => hold ? new Promise<boolean>(resolve => { release = resolve; }) : true });
        const connection = await relay.connect({ principal: call.principal, sessionId: call.sessionId, expiresAt: Date.now() + 10000, send: message => { sent.push(message); } });
        hold = true;
        const input = { includeDocument: false };
        const promise = relay.dispatch({ ...call, input });
        input.includeDocument = true;
        release(true);
        await vi.waitFor(() => expect(sent).toHaveLength(1));
        connection.receive({ type: 'response', sessionId: call.sessionId, requestId: call.requestId, result: { ok: true, data: {} } });
        await promise;
        relay.dispose();
        expect((sent[0] as RelayCall).input).toEqual({ includeDocument: false });
    });
    it('honors cancellation while host authorization is still pending',async()=>{
        let hold=false,release!:(allowed:boolean)=>void;
        const relay=createSessionRelay({authorize:()=>hold?new Promise<boolean>(resolve=>{release=resolve;}):true});
        await relay.connect({principal:call.principal,sessionId:call.sessionId,expiresAt:Date.now()+10000,send(){}});hold=true;
        const controller=new AbortController();const pending=relay.dispatch({...call,signal:controller.signal}).then(()=> 'resolved',error=>error.code);
        controller.abort();const outcome=await Promise.race([pending,new Promise<string>(resolve=>setTimeout(()=>resolve('still waiting'),10))]);
        release(true);await pending;relay.dispose();expect(outcome).toBe('CANCELLED');
    });
    it('rejects non-JSON numbers before relay serialization can silently change their meaning', async () => {
        const sent: (RelayCall | RelayCancel)[] = [];
        const relay = createSessionRelay({ authorize: () => true, timeoutMs: 5 });
        await relay.connect({ principal: call.principal, sessionId: call.sessionId, expiresAt: Date.now() + 10000, send: message => { sent.push(message); } });
        const pending = relay.dispatch({ ...call, name: 'visualization_operate', input: { action: 'select', selection: NaN } });
        // A rejection should occur before dispatch, not after a timeout or disconnection.
        await expect(pending).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
        expect(sent).toHaveLength(0);
        relay.dispose();
    });
    it('does not expose cached candidates or operation results after session disposal', async () => {
        const session = await createVisualizationSession({ evaluator: { evaluate: async (request) => evaluateDocument(request), dispose() { } } }), tools = createVisualizationTools({ session });
        const input = { document: createPreset('wave'), guard: { sessionId: session.id, expectedVersion: 0, operationId: 'disposal-review' } };
        const created = await tools.execute('visualization_create', input);
        expect(created.ok).toBe(true);
        if (!created.ok)
            return;
        const candidateId = (created.data as {
            candidateId: string;
        }).candidateId;
        session.dispose();
        expect((await tools.execute('visualization_inspect', { candidateId, includeDocument: true })).ok).toBe(false);
        expect((await tools.execute('visualization_create', input)).ok).toBe(false);
    });
    it('exposes the actual document schema and interpreter limits to tool-only authors', async () => {
        const session = await createVisualizationSession({ evaluator: { evaluate: async (request) => evaluateDocument(request), dispose() { } } });
        const tools = createVisualizationTools({ session }), result = await tools.execute('visualization_discover', {});
        session.dispose();
        expect(result.ok).toBe(true);
        if (result.ok) {
            const discovered = result.data as Record<string, unknown>;
            expect(JSON.stringify(discovered.documentSchema) === JSON.stringify(DOCUMENT_SCHEMA)).toBe(true);
            expect(discovered.documentLimits).toEqual(DOCUMENT_LIMITS);
        }
    });
});
