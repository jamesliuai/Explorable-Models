import { createVisualizationSession } from '@experiment-kit/core/declarative';
import type { MutationGuard, SessionState, VisualizationSession, VisualizationDocument } from '@experiment-kit/core/declarative';

export interface CardState {
  rendered: SessionState;
  parameters: Record<string, number>;
  previewing: boolean;
  saving: boolean;
  previewTime: number | null;
  error: string | null;
}
const guard = (session: VisualizationSession): MutationGuard => ({
  sessionId: session.id, expectedVersion: session.getState().version,
  expectedRunId: session.getState().run?.id, operationId: crypto.randomUUID(), origin: 'human',
});

/** Host-side interaction adapter. No physics, DOM access, or changes to the public runtime contract.
 * The scratch session commits worker frames for live display; the primary session keeps the
 * gesture tentative. Only release/Enter commits one new primary run. No scratch run is exported.
 */
export async function createCardController(document: VisualizationDocument) {
  const defaultParameters = Object.fromEntries(Object.entries(document.parameters).map(([id, spec]) => [id, spec.value]));
  const primary = await createVisualizationSession();
  const scratch = await createVisualizationSession({ maxRuns: 1 });
  try {
    await Promise.all([primary, scratch].map(async session => {
      const candidate = await session.createCandidate(document, guard(session));
      await session.commitCandidate(candidate.id, guard(session));
    }));
  } catch (error) { primary.dispose(); scratch.dispose(); throw error; }
  let state: CardState = { rendered: primary.getState(), parameters: { ...defaultParameters }, previewing: false, previewTime: null, saving: false, error: null };
  const listeners = new Set<() => void>();
  let disposed = false, epoch = 0, busy = false;
  let pending: { params: Record<string, number>; epoch: number; time?: number } | null = null;
  const publish = (patch: Partial<CardState>) => {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const unsubscribe = primary.subscribe(event => {
    if (!state.previewing && !state.saving && event.state.run) publish({ rendered: event.state, parameters: { ...event.state.run.params }, error: event.state.error?.[0]?.message ?? null });
  });
  const fail = (error: unknown) => {
    if (disposed) return;
    pending = null; epoch++;
    primary.cancelPreview(guard(primary));
    publish({ rendered: primary.getState(), parameters: { ...primary.getState().run!.params }, previewing: false, previewTime: null, saving: false, error: error instanceof Error ? error.message : 'Unable to update the model.' });
  };
  const pump = async () => {
    if (busy || disposed) return;
    busy = true;
    try {
      // At most one request is in flight and one newest value is queued.
      while (pending && !disposed) {
        const next = pending; pending = null;
        try {
          let rendered = await scratch.setParameters(next.params, guard(scratch));
          if (next.time !== undefined) rendered = await scratch.seek(next.time, guard(scratch));
          if (next.epoch === epoch && state.previewing) publish({ rendered });
        } catch (error) { if (next.epoch === epoch) fail(error); }
      }
    } finally { busy = false; }
  };
  const cancel = () => {
    if (disposed || state.saving) return;
    pending = null; epoch++;
    primary.cancelPreview(guard(primary));
    publish({ rendered: primary.getState(), parameters: { ...primary.getState().run!.params }, previewing: false, previewTime: null, error: null });
  };
  const seek = async (time: number) => {
    if (disposed || state.saving || !document.time) return;
    pending = null; epoch++; publish({ saving: true, error: null });
    try {
      if (primary.getState().preview) primary.cancelPreview(guard(primary));
      const rendered = await primary.seek(time, guard(primary));
      publish({ rendered, parameters: { ...rendered.run!.params }, previewing: false, previewTime: null, saving: false });
    } catch (error) { fail(error); }
  };
  const commit = async (updates?: Record<string, number>) => {
    if (disposed || state.saving || (!updates && !state.previewing)) return;
    if (!updates && state.previewTime !== null) return seek(state.previewTime);
    const params = { ...state.parameters, ...updates };
    pending = null; epoch++;
    publish({ saving: true, error: null });
    try {
      const rendered = await primary.setParameters(params, guard(primary));
      publish({ rendered, parameters: { ...rendered.run!.params }, previewing: false, previewTime: null, saving: false });
    } catch (error) { fail(error); }
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    preview(updates: Record<string, number>) {
      if (disposed || state.saving) return;
      const params = { ...state.parameters, ...updates };
      try {
        primary.previewParameters(params, guard(primary));
        publish({ parameters: params, previewing: true, previewTime: null, error: null });
        pending = { params, epoch }; void pump();
      } catch (error) { fail(error); }
    },
    previewTime(time: number) {
      if (disposed || state.saving || !document.time || !Number.isFinite(time) || time < 0 || time > primary.getState().frame!.endTime!) return;
      const params = { ...primary.getState().run!.params };
      primary.previewParameters(params, guard(primary));
      publish({ parameters: params, previewing: true, previewTime: time, error: null });
      pending = { params, epoch, time }; void pump();
    },
    async togglePlay() {
      if (disposed || state.saving || state.previewing || !document.time) return;
      if (primary.getState().playing) primary.pause(guard(primary));
      else {
        if (primary.getState().frame!.terminal) await seek(0);
        if (!disposed && !state.error) primary.play(guard(primary));
      }
    },
    step: () => seek(Math.min(primary.getState().frame!.endTime ?? Infinity, primary.getState().frame!.time + (document.time?.step ?? .05))),
    seek, commit, cancel,
    reset: () => commit(defaultParameters),
    inspect: () => ({ primary: primary.getState(), displayed: state.rendered }),
    exportDocument: () => primary.exportDocument(),
    dispose() { disposed = true; epoch++; pending = null; listeners.clear(); unsubscribe(); primary.dispose(); scratch.dispose(); },
  };
}
export type CardController = Awaited<ReturnType<typeof createCardController>>;
