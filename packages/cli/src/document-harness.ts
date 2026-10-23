/** Fixed, trusted CLI adapter. Authored JSON expressions remain inside the browser worker. */
import { createVisualizationSession } from '../../core/src/declarative/index.js';
import { createVisualizationTools } from '../../agent/src/tools.js';
import type { VisualizationToolResult, ToolDescriptor } from '../../agent/src/tools.js';
interface DocumentHarness { descriptors: readonly ToolDescriptor[]; ready: boolean; error?: string; execute(name: string, input: unknown, requestId: string): Promise<VisualizationToolResult>; cancel(requestId: string): void; dispose(): void }
declare global { interface Window { __documentHarness?: DocumentHarness } }
const controllers = new Map<string, AbortController>();
try {
  const session = await createVisualizationSession();
  const tools = createVisualizationTools({ session });
  window.__documentHarness = {
    ready: true, descriptors: tools.descriptors,
    async execute(name, input, requestId) {
      const controller = new AbortController(); controllers.set(requestId, controller);
      try { return await tools.execute(name, input, { signal: controller.signal }); }
      finally { controllers.delete(requestId); }
    },
    cancel(requestId) { controllers.get(requestId)?.abort(); },
    dispose() { for (const controller of controllers.values()) controller.abort(); controllers.clear(); session.dispose(); },
  };
} catch (error) {
  window.__documentHarness = { ready: false, descriptors: [], error: error instanceof Error ? error.message : String(error), execute: async () => ({ ok: false, diagnostics: [{ code: 'NOT_READY', path: '$', message: 'Browser initialization failed.' }] }), cancel() {}, dispose() {} };
}
