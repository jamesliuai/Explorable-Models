/**
 * Fixed toolkit page for stage captures (report §15.2, §19). For one stage it prepares the activity through the real
 * adapter against the browser integration fixture host (an author-preview policy whose ceiling is every group of the
 * template, or the host policy supplied with `capture --policy`), asks the host to authorize the stage's
 * solution-bearing groups inside that policy's ceiling through the normal persist-before-reveal path (under a policy
 * with an active independent task the host enters that task instead, so only its neutral scaffold can show), mounts
 * `StudyActivitySurface` with the learner binding and returns what the learner projection shows: the
 * surface's own pure-SVG capture of the primary view and projection-only companion text. The CLI adds a PNG
 * screenshot of the mounted card. Without a spatial loader, 3D views use the surface's 2D projection fallback.
 *
 * Authored packages run in exploratory mode with lifecycle `authored`; installed templates run in approved mode with
 * the installed catalogue's own status. The fixture host is a conformance fixture, not a Study Harness host.
 */
import {
  createStudyHarnessAdapter, solutionGroupsFor,
  type ActivityCatalog, type ActivityTemplate, type HostPolicy, type LearnerProjection, type ToolOperation,
} from '@explorable-models/activity';
import { createInstalledCatalog } from '@explorable-models/catalog';
import { enableDocumentExecution, validateManifest } from '@explorable-models/core/model';
import { companionText, mountStudyActivity, type CaptureResult, type SurfaceDiagnostic } from '@explorable-models/player/activity';
import { FixtureHost } from '../../../examples/study-harness-host/fixture-host.js';
import { authoredCatalog, frames, modelWorker, wait } from './activity-page-support.js';

export interface CaptureInput {
  template: ActivityTemplate;
  manifest: unknown;
  installed: boolean;
  stageId: string;
  theme: 'light' | 'dark' | 'system';
  fonts: 'bundled' | 'system';
  /** Iteration to show where the stage allows navigation (discrete models); the first frame otherwise. */
  index?: number | null;
  /** Learner-scoped capture: the validated host policy (`capture --policy`) and the mode it authorizes; author preview otherwise. */
  policy?: { policy: HostPolicy; mode: 'approved' | 'exploratory' } | null;
}
declare global { interface Window { __activityCapture?: { ready: boolean; capture(input: string): Promise<unknown> } } }

const PREVIEW_TOOLS: ToolOperation[] = ['discover', 'prepare', 'inspect.learner', 'request-reveal', 'operate.parameters', 'operate.navigation', 'operate.playback', 'operate.presentation', 'summarize', 'close'];
function previewPolicy(activityId: string, template: ActivityTemplate, approved: HostPolicy['approved'], parameters: number): HostPolicy {
  const exploratory = approved.length === 0;
  return {
    contract: 'study-harness.host-policy', schemaVersion: '1.0', policyId: `author-preview-${activityId}`.slice(0, 128), revision: 1, issuedAt: new Date().toISOString(), expiresAt: null,
    revoked: false, mode: exploratory ? 'exploratory' : 'approved', approved, allowedTools: [...PREVIEW_TOOLS],
    visibleGroups: template.groups.map(group => group.id), permittedControls: template.controls.map(control => control.parameter),
    export: { learnerSnapshot: false, capture: true, backup: false }, inspection: { developer: false, tutor: 'learner-visible', teacher: false },
    independentTask: { active: false, taskRef: null, permittedTools: [], neutralScaffold: [] }, sampling: { allowed: false, maxPositions: 0 },
    exploratory: { allowed: exploratory, maxParametersOverride: exploratory ? Math.min(parameters, 64) : 0 },
  };
}

async function capture(text: string) {
  const input = JSON.parse(text) as CaptureInput;
  const { template } = input;
  const stage = template.stages.find(item => item.id === input.stageId);
  if (!stage) return { ok: false, diagnostics: [{ code: 'NOT_FOUND', message: `The template has no stage ${input.stageId}.` }] };
  enableDocumentExecution(); // authored packages may execute a bounded schema 2.0 document (architecture D3)
  const validated = validateManifest(input.manifest);
  const catalog: ActivityCatalog = input.installed ? createInstalledCatalog({ include: [template.templateId], workerFactory: modelWorker }) : authoredCatalog(template, validated);
  const entry = catalog.listTemplates().find(item => item.template.templateId === template.templateId && item.template.version === template.version);
  if (!entry) return { ok: false, diagnostics: [{ code: 'NOT_FOUND', message: 'The catalogue does not serve this template version.' }] };
  const supplied = input.policy ?? null;
  const activityId = `${supplied ? 'learner' : 'author'}-preview-${stage.id}`.slice(0, 128);
  const host = new FixtureHost({ storage: null });
  const policy = host.setPolicy(activityId, supplied?.policy ?? previewPolicy(activityId, template, input.installed ? [{ template: entry.template, model: entry.model }] : [], Object.keys(validated.manifest.parameters).length));
  const mode = supplied?.mode ?? (input.installed ? 'approved' : 'exploratory');
  const adapter = createStudyHarnessAdapter({ catalog, host, maxWorkers: 2 });
  const prepared = await adapter.prepare({
    activityId, objectiveIds: ['author-preview'], hostSessionId: 'author-preview', hostSessionRevision: 0,
    template: { templateId: template.templateId, version: template.version }, mode, stageId: stage.id,
  }, { operationId: `author-preview-prepare-${stage.id}`.slice(0, 128) });
  if (!prepared.ok) return { ok: false, diagnostics: prepared.diagnostics };
  const surfaceId = `author-capture-${stage.id}`.slice(0, 128);
  const binding = prepared.prepared.binding('learner', surfaceId);

  // An active independent task in the supplied policy: the host enters it, so only the neutral scaffold can show.
  const independent = policy.independentTask.active && policy.independentTask.taskRef !== null;
  if (independent) {
    const entered = await prepared.prepared.host.enterIndependentTask({ operationId: `learner-preview-independent-${stage.id}`.slice(0, 128), taskRef: policy.independentTask.taskRef!, policy });
    if (!entered.ok) return { ok: false, diagnostics: entered.diagnostics };
  }
  // The stage's solution-bearing groups inside the policy ceiling, authorized by the host as a stage transition into
  // this stage would.
  const solution = independent ? [] : solutionGroupsFor(template, stage, policy, 'instructional').map(group => group.id);
  let revealError: unknown = null;
  if (solution.length) {
    const before = binding.getProjection();
    const outcome = await prepared.prepared.host.requestReveal({ operationId: `author-preview-reveal-${stage.id}`.slice(0, 128), expectedActivityRevision: before.activityRevision, expectedPolicyRevision: before.policyRevision, groups: solution });
    if (!outcome.ok) revealError = outcome.diagnostics;
  }

  let navigatedTo: number | null = null;
  const execution = validated.manifest.execution;
  if (typeof input.index === 'number' && stage.allowsNavigation && execution.kind === 'kernel' && execution.mode === 'discrete') {
    const index = Math.min(Math.max(0, Math.trunc(input.index)), execution.maxIndex);
    const outcome = await binding.navigate({ operationId: `author-preview-navigate-${stage.id}`.slice(0, 128), ...binding.getProjection().guards, position: { kind: 'index', index } });
    if (outcome.ok) navigatedTo = index;
  }

  document.documentElement.lang = template.locale;
  document.body.style.margin = '0';
  document.body.style.padding = '16px';
  const root = document.querySelector<HTMLElement>('#capture-root')!;
  root.replaceChildren();
  const diagnostics: SurfaceDiagnostic[] = [];
  const surface = mountStudyActivity(root, {
    binding, surfaceId, theme: input.theme, fonts: input.fonts, headingLevel: 2, assetBase: new URL('./assets/', location.href),
    onDiagnostic: diagnostic => { if (diagnostics.length < 64) diagnostics.push(diagnostic); },
  });
  await surface.ready;
  // Settle: the display acknowledgement of revealed groups, KaTeX rendering (or its plain-text fallback) and fonts.
  const shadow = surface.element.shadowRoot!;
  for (let attempt = 0; attempt < 100; attempt++) {
    const projection = binding.getProjection();
    const acknowledged = !projection.pendingReveal || projection.pendingReveal.state === 'failed';
    const pendingMath = [...shadow.querySelectorAll('.ema-math')].filter(node => node.querySelector('.ema-plain')).length;
    const fallbacks = diagnostics.filter(item => item.code === 'MATH_FALLBACK' || item.code === 'MATH_ASSETS_UNAVAILABLE').length;
    if (acknowledged && pendingMath <= fallbacks && projection.status.ui !== 'preparing' && projection.status.ui !== 'awaiting-persistence') break;
    await wait(80);
  }
  await document.fonts.ready;
  await frames(3);
  const style = getComputedStyle(shadow.firstElementChild ?? surface.element);
  const background = style.getPropertyValue('--ema-background').trim();
  if (background) document.body.style.background = background;

  const projection: LearnerProjection = binding.getProjection();
  // A 3D view is captured through its 2D projection fallback (no spatial renderer is loaded here); otherwise the first 2D drawing.
  const graphical = projection.views.find(view => view.kind === 'scene3d') ?? projection.views.find(view => view.kind === 'plot2d' || view.kind === 'scene2d');
  let svg: { viewId: string; svg: string; width: number; height: number; fonts: string; metadata: unknown } | null = null;
  let svgError: { code: string; message: string } | null = null;
  if (!projection.views.length) svgError = { code: 'NOT_FOUND', message: 'This stage shows no view; the card screenshot and companion text record the stage.' };
  else try {
    const result: CaptureResult = await surface.capture({ format: 'svg', ...(graphical ? { viewId: graphical.viewId } : {}) });
    if (result.mimeType === 'image/svg+xml') svg = { viewId: result.metadata.viewId, svg: result.svg, width: result.width, height: result.height, fonts: result.fonts, metadata: result.metadata };
  } catch (error) {
    const failure = error as { code?: string; message?: string };
    svgError = { code: failure.code ?? 'CAPTURE_REJECTED', message: failure.message ?? String(error) };
  }
  const equations = shadow.querySelectorAll('.ema-math').length;
  const mathPlain = [...shadow.querySelectorAll('.ema-math')].filter(node => node.querySelector('.ema-plain')).length;
  return {
    ok: true,
    stage: { id: stage.id, kind: stage.kind, instruction: stage.instruction, response: stage.response ?? null, visible: stage.visible, controls: stage.controls },
    mode,
    policy: { source: supplied ? 'supplied' : 'author-preview', policyId: policy.policyId, revision: policy.revision, context: binding.getProjection().context },
    revealed: solution, revealError, navigatedTo,
    projection: {
      projectionId: projection.projectionId, projectionDigest: projection.projectionDigest, activityRevision: projection.activityRevision,
      presentationRevision: projection.presentationRevision, policyRevision: projection.policyRevision, frame: projection.frame, ui: projection.status.ui,
      reviewNotice: projection.reviewNotice, pendingReveal: projection.pendingReveal,
      views: projection.views.map(view => ({ viewId: view.viewId, kind: view.kind, title: view.title })),
      controls: projection.controls.map(control => ({ parameter: control.parameter, mode: control.mode })),
      alternatives: projection.alternatives.map(alternative => alternative.alternativeId),
    },
    companion: {
      values: binding.describeCurrentValues(),
      views: projection.views.map(view => ({ viewId: view.viewId, text: companionText(projection, view, template.locale) })),
    },
    svg, svgError,
    math: { equations, plainText: mathPlain },
    diagnostics: diagnostics.map(item => ({ source: item.source, code: item.code, message: item.message })),
  };
}

window.__activityCapture = {
  ready: true,
  capture: text => capture(text).catch(error => ({ ok: false, diagnostics: [{ code: 'CAPTURE_FAILED', message: error instanceof Error ? error.message : String(error) }] })),
};
