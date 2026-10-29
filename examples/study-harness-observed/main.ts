/**
 * EXAMPLE PAGE — observed data beside a model prediction (report §8.5) through the real activity adapter, a real module
 * worker (core's worker protocol) and the learner surface. Example content and an in-memory example host: not a tutor,
 * not the Study Harness host and not evidence about falling bodies or learning.
 *
 * Query: `?stage=compare` asks the host to show the model after opening (default: the `observe` stage);
 * `?explore=1` (with compare) also authorizes slider previews; `?width=<px>`, `?theme=light|dark`, `?text=200`.
 * `window.observedExample` exposes read-only hooks and the two host actions for browser tests.
 */
import { createStudyHarnessAdapter, templateRef, type ActivityCatalog, type CatalogEntryStatus, type CommandOutcome, type HostPolicy, type LearnerProjection } from '@explorable-models/activity';
import { modelIdentity } from '@explorable-models/core/model';
import { mountStudyActivity, type CaptureResult, type SurfaceDiagnostic } from '@explorable-models/player/activity';
import { fallingBallManifest as manifest, fallingBallTemplate as template } from './content';
import { ExampleHost } from './host';

const query = new URLSearchParams(location.search);
const model = { modelId: manifest.modelId, version: manifest.version, digest: modelIdentity(manifest).digest };
const policy: HostPolicy = {
  contract: 'study-harness.host-policy', schemaVersion: '1.0', policyId: 'observed-example', revision: 1, issuedAt: new Date().toISOString(), expiresAt: null, revoked: false,
  mode: 'approved', approved: [{ template: templateRef(template), model }],
  allowedTools: ['discover', 'prepare', 'inspect.learner', 'operate.parameters', 'operate.presentation', 'summarize', 'save', 'close'],
  visibleGroups: template.groups.map(group => group.id), permittedControls: ['h0', 'g'],
  export: { learnerSnapshot: true, capture: true, backup: true }, inspection: { developer: false, tutor: 'learner-visible', teacher: false },
  independentTask: { active: false, taskRef: null, permittedTools: [], neutralScaffold: [] }, sampling: { allowed: false, maxPositions: 0 },
  exploratory: { allowed: false, maxParametersOverride: 0 },
};
const status = (): CatalogEntryStatus => ({ lifecycle: 'validated', reviews: [], revoked: false });
const catalog: ActivityCatalog = {
  listTemplates: () => [{ template: templateRef(template), model, title: template.title, dimension: '2d', status: status() }],
  getTemplate: ref => ref.templateId === template.templateId && ref.version === template.version ? structuredClone(template) : null,
  getModel: ref => ref.modelId === manifest.modelId && ref.version === manifest.version ? structuredClone(manifest) : null,
  status,
  createWorker: () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
};

const host = new ExampleHost(policy);
const adapter = createStudyHarnessAdapter({ catalog, host });
const diagnostics: SurfaceDiagnostic[] = [];
const activityId = 'observed-example-1';
let counter = 0;
const op = (prefix: string) => `${prefix}-${++counter}`;

declare global {
  interface Window {
    observedExample: {
      ready: boolean;
      projection(): LearnerProjection | null;
      showModel(): Promise<CommandOutcome>;
      authorizeExploration(): Promise<CommandOutcome>;
      capture(format: 'svg' | 'png', viewId?: string): Promise<Omit<CaptureResult, 'bytes'>>;
      events(): string[];
      diagnostics: SurfaceDiagnostic[];
    };
  }
}

async function start(): Promise<void> {
  const width = Number(query.get('width'));
  if (query.get('text') === '200') document.documentElement.style.fontSize = '200%';
  const theme = query.get('theme') === 'dark' ? 'dark' : 'light';
  document.body.dataset.theme = theme;
  const card = document.getElementById('ob-card')!;
  if (width > 0) card.style.width = `${width}px`;
  const prepared = await adapter.prepare({
    activityId, objectiveIds: ['observed-vs-model'], hostSessionId: 'observed-example-session', hostSessionRevision: 0,
    template: { templateId: template.templateId, version: template.version }, mode: 'approved',
  }, { operationId: op('prepare') });
  if (!prepared.ok) throw new Error(prepared.diagnostics.map(item => `${item.code}: ${item.message}`).join('; '));
  const binding = prepared.prepared.binding('learner', 'observed-card');
  const surface = mountStudyActivity(card, { binding, surfaceId: 'observed-card', theme, headingLevel: 2, onDiagnostic: item => { diagnostics.push(item); } });
  const control = prepared.prepared.host;
  const guard = () => ({ expectedActivityRevision: binding.getProjection().activityRevision, expectedPolicyRevision: binding.getProjection().policyRevision });
  window.observedExample = {
    ready: false,
    projection: () => binding.getProjection(),
    showModel: () => control.requestStageTransition({ operationId: op('stage'), ...guard(), toStage: 'compare' }),
    authorizeExploration: () => control.requestExplorationScope({ operationId: op('scope'), ...guard(), groups: ['model-controls'], parameterDomain: { h0: [5, 30], g: [1, 20] } }),
    capture: async (format, viewId) => { const result = await surface.capture({ format, viewId }); const { bytes: _bytes, ...rest } = result as CaptureResult & { bytes?: Uint8Array }; return rest; },
    events: () => host.eventTypes(activityId),
    diagnostics,
  };
  if (query.get('stage') === 'compare') {
    const shown = await window.observedExample.showModel();
    if (!shown.ok) throw new Error(shown.diagnostics.map(item => item.code).join(', '));
    if (query.get('explore') === '1') {
      const scope = await window.observedExample.authorizeExploration();
      if (!scope.ok) throw new Error(scope.diagnostics.map(item => item.code).join(', '));
    }
  }
  window.observedExample.ready = true;
  document.body.dataset.exampleReady = 'true';
}

start().catch(error => {
  document.getElementById('ob-status')!.textContent = error instanceof Error ? error.message : String(error);
  document.body.dataset.exampleReady = 'failed';
});
