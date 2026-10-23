import { afterEach, describe, expect, it } from 'vitest';
import { createVisualizationSession, evaluateDocument } from '../../packages/core/src/declarative/index';
import type { MutationGuard, VisualizationSession } from '../../packages/core/src/declarative/types';
import { createVisualizationTools } from '../../packages/agent/src/index';
import type { VisualizationTools, VisualizationToolResult } from '../../packages/agent/src/index';

let nextId = 0; const sessions: VisualizationSession[] = [];
const guard = (session: VisualizationSession): MutationGuard => ({ sessionId: session.id, expectedVersion: session.getState().version, ...(session.getState().run && { expectedRunId: session.getState().run!.id }), operationId: `tool-${++nextId}`, origin: 'agent' });
const data = (result: VisualizationToolResult): any => { expect(result.ok, JSON.stringify(result)).toBe(true); return result.ok ? result.data : undefined; };
async function setup() { const session = await createVisualizationSession({ evaluator: { evaluate: async request => evaluateDocument(request), dispose() {} } }); sessions.push(session); const tools = createVisualizationTools({ session }); return { session, tools }; }
async function create(tools: VisualizationTools, session: VisualizationSession) { const discovery = data(await tools.execute('visualization_discover', { includeExample: true })); const candidate = data(await tools.execute('visualization_create', { document: discovery.example, guard: guard(session) })); data(await tools.execute('visualization_commit', { candidateId: candidate.candidateId, guard: guard(session) })); return discovery.example; }
afterEach(() => { sessions.splice(0).forEach(session => session.dispose()); });

describe('provider-neutral tool-only workflow (scripted, not an LLM trial)', () => {
  it('discovers, creates sine, adds a second curve and annotation, revises, operates, saves and reopens', async () => {
    const { session, tools } = await setup(); const original = await create(tools, session);
    expect(tools.descriptors).toHaveLength(9); expect(tools.descriptors.every(tool => tool.inputSchema && tool.outputSchema)).toBe(true);
    const candidate = data(await tools.execute('visualization_revise', { guard: guard(session), edits: [
      { op: 'set', collection: 'series', id: 'double', value: { ...original.series.wave, label: 'Double frequency', y: 'amplitude*sin(2*frequency*x)' } },
      { op: 'setMark', viewId: 'plot', mark: { id: 'double-curve', type: 'line', label: 'Double frequency curve', series: 'double', style: { dash: 'dashed' } } },
      { op: 'setMark', viewId: 'plot', mark: { id: 'note', type: 'label', label: 'Origin annotation', text: 'Both curves cross zero here', bindings: { position: 'origin' }, offset: [10, -10] } },
    ] }));
    const inspection = data(await tools.execute('visualization_inspect', { candidateId: candidate.candidateId, includeDocument: true })); expect(inspection.document.views[0].marks).toHaveLength(3);
    data(await tools.execute('visualization_commit', { candidateId: candidate.candidateId, guard: guard(session) }));
    const before = session.getState().run!.id;
    data(await tools.execute('visualization_operate', { action: 'parameters', parameters: { amplitude: 2 }, guard: guard(session) })); expect(session.getState().run!.id).not.toBe(before);
    const artifact = data(await tools.execute('visualization_save', {})); const reopened = await setup(); data(await reopened.tools.execute('visualization_restore', { artifact, guard: guard(reopened.session) }));
    expect(reopened.session.getState().identity).toEqual(session.getState().identity); expect(reopened.session.getState().frame).toEqual(session.getState().frame); expect(reopened.session.getState().run!.params.amplitude).toBe(2);
  });
  it('reports bounded repair diagnostics and keeps accepted state on bad input', async () => {
    const { session, tools } = await setup(); await create(tools, session); const identity = session.getState().identity;
    const result = await tools.execute('visualization_revise', { guard: guard(session), edits: [{ op: 'set', collection: 'quantities', id: 'broken', value: { expression: 'fetch(secret)' } }] });
    expect(result.ok).toBe(false); if (!result.ok) expect(result.diagnostics[0].path).toContain('expression'); expect(session.getState().identity).toEqual(identity);
    for (const input of [{ extra: true }, { includeDocument: 'yes' }, { quantityIds: ['unknown'] }, { quantityIds: [3] }]) expect((await tools.execute('visualization_inspect', input)).ok).toBe(false);
    expect((await tools.execute('visualization_operate', { action: 'pause', time: 1, guard: guard(session) })).ok).toBe(false);
    expect((await tools.execute('not_a_tool', {})).ok).toBe(false);
    expect((await tools.execute('visualization_discover', { includeExample: undefined })).ok).toBe(false);
    expect((await tools.execute('visualization_operate', { action: 'seek', time: NaN, guard: guard(session) })).ok).toBe(false);
  });
  it('deduplicates concurrent relative step retries and rejects changed operation payload', async () => {
    const { session, tools } = await setup(); const discovery = data(await tools.execute('visualization_discover', { includeExample: true })); discovery.example.time = { end: 1, step: 0.1 };
    const candidate = data(await tools.execute('visualization_create', { document: discovery.example, guard: guard(session) })); data(await tools.execute('visualization_commit', { candidateId: candidate.candidateId, guard: guard(session) }));
    const input = { action: 'step', guard: guard(session) }; const [first, retry] = await Promise.all([tools.execute('visualization_operate', input), tools.execute('visualization_operate', input)]);
    expect(data(first).frame.time).toBe(0.1); expect(data(retry)).toEqual(data(first)); expect(data(await tools.execute('visualization_operate', input)).frame.time).toBe(0.1);
    const conflict = await tools.execute('visualization_operate', { ...input, action: 'pause' }); expect(conflict.ok).toBe(false); expect(session.getState().frame!.time).toBe(0.1);
  });
  it('rejects a candidate when an event listener disposes its session before delivery', async () => {
    const { session, tools } = await setup();
    const discovery = data(await tools.execute('visualization_discover', { includeExample: true }));
    session.subscribe(event => { if (event.type === 'candidate') session.dispose(); });
    const result = await tools.execute('visualization_create', { document: discovery.example, guard: guard(session) });
    expect(result.ok).toBe(false); if (!result.ok) expect(result.diagnostics[0].code).toBe('DISPOSED');
    expect(session.getState().status).toBe('disposed');
  });
  it('supports cancellation before execution and preserves committed state', async () => {
    const { session, tools } = await setup(); await create(tools, session); const before = session.getState().run; const controller = new AbortController(); controller.abort();
    const result = await tools.execute('visualization_operate', { action: 'parameters', parameters: { amplitude: 2 }, guard: guard(session) }, { signal: controller.signal }); expect(result.ok).toBe(false); expect(session.getState().run).toBe(before);
  });
});
