/**
 * TEST-ONLY harness for adapter tests: the installed catalogue with in-process kernel workers, the memory host
 * double and a quadratic activity request. Results produced with it are fixture-host results, not evidence about the
 * Study Harness host.
 */
import {
  createStudyHarnessAdapter, groupDigests, templateRef, validateRecord,
  type ActivityBinding, type ActivityCatalog, type ActivityRequest, type ActivityTemplate, type AdapterOptions, type CatalogEntryStatus, type CommandOutcome,
  type HostActivityControl, type HostPolicy, type HostPort, type InteractionEvent, type LearnerProjection, type MarkSpec, type PreparedActivity, type StudyHarnessAdapter,
} from '@explorable-models/activity';
import { createInstalledCatalog, INSTALLED_KERNELS, quadraticGradientDescentManifest as manifest, quadraticGradientDescentTemplate as template, type InstalledCatalogOptions } from '@explorable-models/catalog';
import { modelIdentity } from '@explorable-models/core/model';
import { expect } from 'vitest';
import { inlineWorkers, until, type WorkerGroup } from '../../core/support/inline-worker.js';
import { rectangleKernel, rectangleManifest } from '../../core/support/model-fixtures.js';
import { MemoryHost } from './memory-host.js';

export { manifest, template, until };
export const TEMPLATE = templateRef(template);
export const MODEL = { modelId: manifest.modelId, version: manifest.version, digest: modelIdentity(manifest).digest };
export const DIGESTS: Record<string, string> = Object.fromEntries(groupDigests(template, manifest).map(entry => [entry.groupId, entry.contentDigest]));
/** Solution-bearing groups of the quadratic template. */
export const SOLUTION_GROUPS = template.groups.filter(group => group.solutionBearing).map(group => group.id);

export function policyFor(patch: Partial<HostPolicy> = {}): HostPolicy {
  return {
    contract: 'study-harness.host-policy', schemaVersion: '1.0', policyId: 'policy-1', revision: 1, issuedAt: '2026-10-26T08:00:00.000Z', expiresAt: null, revoked: false,
    mode: 'approved', approved: [{ template: TEMPLATE, model: MODEL }],
    allowedTools: ['discover', 'prepare', 'inspect.learner', 'request-reveal', 'operate.parameters', 'operate.navigation', 'operate.playback', 'operate.presentation', 'summarize', 'save', 'restore', 'close', 'sample'],
    visibleGroups: template.groups.map(group => group.id), permittedControls: template.controls.map(control => control.parameter),
    export: { learnerSnapshot: true, capture: false, backup: true }, inspection: { developer: false, tutor: 'learner-visible', teacher: true },
    independentTask: { active: false, taskRef: null, permittedTools: [], neutralScaffold: [] }, sampling: { allowed: true, maxPositions: 16 },
    exploratory: { allowed: false, maxParametersOverride: 0 },
    ...patch,
  };
}
export function requestFor(patch: Partial<ActivityRequest> = {}): ActivityRequest {
  return {
    activityId: 'act-quadratic-1', objectiveIds: ['obj-step-size'], hostSessionId: 'session-1', hostSessionRevision: 0,
    template: { templateId: template.templateId, version: template.version }, mode: 'approved', ...patch,
  };
}

let counter = 0;
/** Fresh operation ID. */
export const op = (prefix = 'op'): string => `${prefix}-${++counter}`;

export interface Harness {
  host: MemoryHost;
  workers: WorkerGroup;
  catalog: ActivityCatalog;
  adapter: StudyHarnessAdapter;
  options: AdapterOptions;
}
export interface HarnessOptions {
  policy?: HostPolicy;
  catalog?: Omit<InstalledCatalogOptions, 'workerFactory'>;
  /** Replaces the installed catalogue (for example {@link rectangleCatalog}). */
  customCatalog?: (createWorker: () => Worker) => ActivityCatalog;
  host?: MemoryHost;
  /** Wraps the memory host in the port the adapter receives (for receipt tampering). */
  port?: (host: MemoryHost) => HostPort;
  adapter?: Partial<AdapterOptions>;
}
export function harness(options: HarnessOptions = {}): Harness {
  const workers = inlineWorkers([...INSTALLED_KERNELS, rectangleKernel]);
  const catalog = options.customCatalog ? options.customCatalog(workers.factory) : createInstalledCatalog({ ...options.catalog, workerFactory: workers.factory });
  const host = options.host ?? new MemoryHost({ policy: options.policy ?? policyFor() });
  const adapterOptions: AdapterOptions = { catalog, host: options.port ? options.port(host) : host, ...options.adapter };
  return { host, workers, catalog, adapter: createStudyHarnessAdapter(adapterOptions), options: adapterOptions };
}

// ---------------------------------------------------------------------------------------------
// Unit-bearing test template over the core rectangle fixture (lengths in metres, cm/mm display units, coupled
// constraints w·h ≤ 50 and w/h ≥ 0.1). Test content only; not a catalogue activity.
// ---------------------------------------------------------------------------------------------
export const rectangleModel = rectangleManifest();
export const RECTANGLE_MODEL = { modelId: rectangleModel.modelId, version: rectangleModel.version, digest: modelIdentity(rectangleModel).digest };
const style = (role: MarkSpec['style']['role']): MarkSpec['style'] => ({ role, dash: 'solid', marker: 'circle', weight: 'regular' });
export const rectangleTemplate: ActivityTemplate = {
  contract: 'study-harness.activity-template', schemaVersion: '1.0', templateId: 'test-rectangle', version: '1.0.0', model: RECTANGLE_MODEL,
  title: 'Rectangle sizes', purpose: 'Test template for units, gating and constraints.', dimension: '2d', locale: 'en', requires: [],
  groups: [
    { id: 'outline-view', kind: 'view', label: 'Outline', description: 'The rectangle outline.', solutionBearing: false, members: ['outline'] },
    { id: 'size-controls', kind: 'control', label: 'Size controls', description: 'Width and height.', solutionBearing: false, members: ['w', 'h'] },
    { id: 'measures', kind: 'quantity', label: 'Measures', description: 'Perimeter and slope.', solutionBearing: false, members: ['perimeter', 'slope'] },
    { id: 'classification', kind: 'quantity', label: 'Classification', description: 'Shape class.', solutionBearing: true, members: ['shape'] },
    { id: 'diagonal-group', kind: 'quantity', label: 'Diagonal', description: 'Diagonal vector.', solutionBearing: true, members: ['diagonal'] },
    { id: 'perimeter-rule', kind: 'equation', label: 'Perimeter rule', description: 'Perimeter with the current value.', solutionBearing: true, members: ['perimeter-equation'] },
    { id: 'notes', kind: 'annotation', label: 'Notes', description: 'A learner note.', solutionBearing: false, members: ['note'] },
    { id: 'alternatives', kind: 'alternative', label: 'Alternatives', description: 'Text equivalents.', solutionBearing: false, members: ['outline-text'] },
  ],
  views: [
    {
      id: 'outline', kind: 'scene2d', group: 'outline-view', title: 'Outline', description: 'The rectangle drawn from the origin.', bounds: [-1, 8, -1, 8], equalAspect: true,
      axes: { x: { label: 'x', unit: 'm' }, y: { label: 'y', unit: 'm' } },
      marks: [
        { id: 'outline-shape', kind: 'polygon', group: 'outline-view', label: 'Rectangle outline', bindings: { geometry: 'outline' }, style: style('primary') },
        { id: 'corner-points', kind: 'points', group: 'outline-view', label: 'Corners', bindings: { geometry: 'corners' }, style: style('secondary') },
        { id: 'diagonal-arrow', kind: 'arrow', group: 'outline-view', label: 'Diagonal arrow', bindings: { vector: 'diagonal' }, style: style('accent') },
      ],
    },
    { id: 'readout', kind: 'values', group: 'measures', title: 'Measures', description: 'Current measures.', equalAspect: false, marks: [], quantities: ['perimeter', 'slope', 'shape', 'diagonal'] },
    { id: 'rule', kind: 'equation', group: 'perimeter-rule', title: 'Rule', description: 'Perimeter rule.', equalAspect: false, marks: [], equations: ['perimeter-equation'] },
    { id: 'measures-table', kind: 'table', group: 'measures', title: 'Measures table', description: 'Measures as a table.', equalAspect: false, marks: [], quantities: ['perimeter', 'slope', 'shape'] },
  ],
  controls: [
    { parameter: 'w', group: 'size-controls', label: 'Width', displayUnits: ['cm', 'm', 'mm'], slider: true, exact: true, step: 50, description: 'Width of the rectangle.' },
    { parameter: 'h', group: 'size-controls', label: 'Height', displayUnits: ['m', 'cm'], slider: true, exact: true, step: 0.5, description: 'Height of the rectangle.' },
  ],
  scenarios: [{ id: 'square', label: 'Square', description: 'A 3 m square.', parameters: { w: 3, h: 3 }, group: 'size-controls' }],
  equations: [{ id: 'perimeter-equation', group: 'perimeter-rule', label: 'Perimeter', tex: 'P = {{q:perimeter}}', plain: 'P = {{q:perimeter}}' }],
  stages: [
    {
      id: 'look', kind: 'explore', instruction: 'Change the width and height.',
      visible: { 'outline-view': 'interactive', 'size-controls': 'interactive', measures: 'fixed', classification: 'fixed', 'diagonal-group': 'fixed', 'perimeter-rule': 'fixed', notes: 'fixed', alternatives: 'fixed' },
      controls: { w: 'interactive', h: 'interactive' }, allowsPreview: true, allowsPlayback: false, allowsNavigation: false,
    },
    { id: 'done', kind: 'closed', instruction: 'Done.', visible: {}, controls: {}, allowsPreview: false, allowsPlayback: false, allowsNavigation: false },
  ],
  transitions: [{ id: 'finish', from: 'look', to: 'done', label: 'Finish' }],
  initialStage: 'look',
  alternatives: [{ id: 'outline-text', kind: 'description', group: 'alternatives', label: 'Outline as text', covers: ['outline'], equivalence: 'equivalent', description: 'Width and height as text.', verifiedBy: 'tests/activity/projection.test.ts' }],
  taskFamilies: [],
  content: [{ id: 'note', kind: 'learner-copy', text: 'A square has equal sides.' }, { id: 'derivation', kind: 'derivation', text: 'HIDDEN-DERIVATION: perimeter equals 2(w + h).' }],
};
export const RECTANGLE_TEMPLATE = templateRef(rectangleTemplate);
/** Minimal ActivityCatalog serving the rectangle template (status `validated`, or revoked). */
export function rectangleCatalog(options: { revoked?: boolean; template?: ActivityTemplate } = {}): (createWorker: () => Worker) => ActivityCatalog {
  return createWorker => {
    const served = options.template ?? rectangleTemplate;
    const servedRef = templateRef(served);
    const status = (ref: { digest: string }): CatalogEntryStatus => ref.digest === servedRef.digest || ref.digest === RECTANGLE_MODEL.digest
      ? options.revoked ? { lifecycle: 'revoked', reviews: [], revoked: true, revocationReason: 'Test revocation.' } : { lifecycle: 'validated', reviews: [], revoked: false }
      : { lifecycle: 'authored', reviews: [], revoked: false };
    return {
      listTemplates: () => [{ template: servedRef, model: RECTANGLE_MODEL, title: served.title, dimension: '2d', status: status(servedRef) }],
      getTemplate: ref => ref.templateId === served.templateId && ref.version === served.version ? structuredClone(served) : null,
      getModel: ref => ref.modelId === rectangleModel.modelId && ref.version === rectangleModel.version ? structuredClone(rectangleModel) : null,
      status, createWorker,
    };
  };
}
export function rectanglePolicy(patch: Partial<HostPolicy> = {}): HostPolicy {
  return policyFor({
    approved: [{ template: RECTANGLE_TEMPLATE, model: RECTANGLE_MODEL }], visibleGroups: rectangleTemplate.groups.map(group => group.id), permittedControls: ['w', 'h'], ...patch,
  });
}
export const rectangleRequest = (patch: Partial<ActivityRequest> = {}): ActivityRequest =>
  requestFor({ activityId: 'act-rectangle-1', template: { templateId: rectangleTemplate.templateId, version: rectangleTemplate.version }, ...patch });

export interface Opened { prepared: PreparedActivity; learner: ActivityBinding; tutor: ActivityBinding; control: HostActivityControl; surface: string }
/** Prepares the activity, binds a learner surface (registered and visible) and a tutor tool binding. */
export async function open(h: Harness, request: ActivityRequest = requestFor()): Promise<Opened> {
  const result = await h.adapter.prepare(request, { operationId: op('prepare') });
  if (!result.ok) throw new Error(`prepare failed: ${JSON.stringify(result.diagnostics)}`);
  const learner = result.prepared.binding('learner', 'surface-main');
  learner.registerSurface('surface-main');
  return { prepared: result.prepared, learner, tutor: result.prepared.binding('tutor', 'tool-executor'), control: result.prepared.host, surface: 'surface-main' };
}

/** Unwraps a successful outcome or fails the test with the diagnostics. */
export function okOf(outcome: CommandOutcome): LearnerProjection {
  if (!outcome.ok) throw new Error(`command failed: ${JSON.stringify(outcome.diagnostics)}`);
  return outcome.projection;
}
/** Codes of a failed outcome (fails the test when the outcome succeeded). */
export function codesOf(outcome: CommandOutcome | { ok: boolean; diagnostics?: { code: string }[] }): string[] {
  if (outcome.ok) throw new Error('expected a failure');
  return (outcome as { diagnostics: { code: string }[] }).diagnostics.map(item => item.code);
}
export const guards = (binding: ActivityBinding) => binding.getProjection().guards;
export const activityGuard = (binding: ActivityBinding) => ({ expectedActivityRevision: binding.getProjection().activityRevision, expectedPolicyRevision: binding.getProjection().policyRevision });
export const presentationGuard = (binding: ActivityBinding) => ({ expectedPresentationRevision: binding.getProjection().presentationRevision });

/** Waits for in-flight journal batches and microtask publications to settle. */
export async function settled(h: Harness, activityId?: string): Promise<void> {
  const last = h.host.calls('registerActivity').at(-1)?.request as { instance?: { activityId?: string } } | undefined;
  const id = activityId ?? last?.instance?.activityId ?? 'act-quadratic-1';
  await new Promise(resolve => setTimeout(resolve, 0));
  await until(() => {
    const state = h.adapter.getState(id, 'host');
    return !('persistence' in state) || state.persistence !== 'saving';
  });
  await new Promise(resolve => setTimeout(resolve, 0));
}

/** Acknowledges the binding's current projection from its registered surface. */
export function ackCurrent(binding: ActivityBinding, surfaceId = 'surface-main'): LearnerProjection {
  const projection = binding.getProjection();
  binding.acknowledgeDisplay({ projectionId: projection.projectionId, projectionDigest: projection.projectionDigest, surfaceId });
  return projection;
}

/** Enters `explore-step` through a host stage receipt and acknowledges the revealing projection. */
export async function enterExplore(h: Harness, opened: Opened): Promise<LearnerProjection> {
  await settled(h);
  const projection = okOf(await opened.control.requestStageTransition({ operationId: op('stage'), ...activityGuard(opened.learner), toStage: 'explore-step' }));
  await settled(h);
  ackCurrent(opened.learner);
  await settled(h);
  return projection;
}
/** Authorizes exploration of the step size for the visible solution-bearing groups. */
export async function authorizeExploration(h: Harness, opened: Opened, domain: Record<string, [number, number]> = { eta: [0, 2] }): Promise<LearnerProjection> {
  await settled(h);
  const stage = template.stages.find(item => item.id === opened.learner.getProjection().stage.id)!;
  const controlGroups = Object.keys(domain).map(parameter => template.controls.find(control => control.parameter === parameter)!.group);
  const groups = [...new Set(controlGroups), ...SOLUTION_GROUPS.filter(id => stage.visible[id])];
  const projection = okOf(await opened.control.requestExplorationScope({ operationId: op('scope'), ...activityGuard(opened.learner), groups, parameterDomain: domain }));
  await settled(h);
  return projection;
}

/** Every journaled event (host copy) passes the interaction-event schema. */
export function expectValidEvents(events: InteractionEvent[]): void {
  for (const event of events) {
    const result = validateRecord('study-harness.interaction-event', event);
    expect(result.diagnostics, `${event.type} #${event.sequence}`).toEqual([]);
  }
  events.forEach((event, index) => expect(event.sequence).toBe(index + 1));
}
