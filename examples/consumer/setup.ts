import { createVisualizationSession, createPreset } from '@explorable-models/core/declarative';
import type { VisualizationSession } from '@explorable-models/core/declarative';
import { createVisualizationTools } from '@explorable-models/agent';
export { createPreset, createVisualizationSession };
export const guard = (session: VisualizationSession) => { const state = session.getState(); return { sessionId: session.id, expectedVersion: state.version, ...(state.run ? { expectedRunId: state.run.id } : {}), operationId: crypto.randomUUID(), origin: 'agent' as const }; };
export async function setup(override = false) {
  const session = await createVisualizationSession(override ? { workerFactory: () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }) } : {});
  const tools = createVisualizationTools({ session });
  const created = await tools.execute('visualization_create', { document: createPreset('wave'), guard: guard(session) });
  if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
  const committed = await tools.execute('visualization_commit', { candidateId: (created.data as {candidateId: string}).candidateId, guard: guard(session) });
  if (!committed.ok) throw new Error(JSON.stringify(committed.diagnostics));
  return { session, tools };
}
