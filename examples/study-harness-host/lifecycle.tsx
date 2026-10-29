/**
 * BROWSER LIFECYCLE FIXTURE (report §9, §13, §18; A41–A43, A47) — not a tutor, not a Study Harness host and not a
 * learning database. One `createStudyHarnessAdapter` with a shared worker budget serves two simultaneously active 2D
 * activities (quadratic gradient descent and function/derivative) and a column of suspended history cards, all rendered
 * by the real learner surface with the real catalogue module workers. The two spatial activities (vector orientation and
 * the quadratic surface) are available for lifecycle cycles: their cards get the host's lazy `@explorable-models/player-3d`
 * loader, so the real `SpatialView` mounts the WebGL renderer. `tests/browser/study-lifecycle.spec.ts` drives the page
 * through `window.lifecycleFixture` to check isolation, coalescing, suspension (offscreen, collapsed, hidden, host),
 * repeated mount/interact/suspend/restore/dispose cycles of 2D and 3D cards and disposal during prepare, evaluate, save,
 * reveal and capture.
 *
 * `LifecycleHost` is an in-memory HostPort for this page only (receipts with idempotency, exposure records, display
 * acknowledgements, an eventId-deduplicated journal and artifacts) with `hold`/`release` gates so a test can keep a
 * host call open while it disposes. Workers are the catalogue's own module workers, optionally with replies held
 * (`holdReplies`) for late-reply tests. Query: `?mode=interactive` (default: two active cards and 20 history cards) or
 * `?mode=empty` (no cards; the test opens its own). Results are fixture-host results in a browser engine; they say
 * nothing about the Study Harness host, a packaged WebView or learning outcomes.
 */
import {
  CONTRACTS, MESSAGES, artifactDigest, createStudyHarnessAdapter, validateRecord,
  type ActivityArtifact, type ActivityBinding, type ActivityInstance, type ActivityRecords, type ActivityTemplate, type AppendResult, type AssistanceReceipt, type AssistanceRequest,
  type CommandOutcome, type DiagnosticCode, type DisplayAckRequest, type ExposureGrant, type ExposureIntentRequest, type ExposureReceipt, type ExposureRecord,
  type HostAck, type HostPolicy, type HostPort, type InteractionEvent, type JournalCursor, type LearnerProjection, type PreparedActivity, type SchemaName,
  type StageReceipt, type StageTransitionRequest, type StudyHarnessAdapter,
} from '@explorable-models/activity';
import { createInstalledCatalog, functionDerivativeTemplate, quadraticGradientDescentTemplate, quadraticSurfaceGradientTemplate, vectorOrientationTemplate } from '@explorable-models/catalog';
import { digest } from '@explorable-models/core';
import { mountStudyActivity, type MountedStudyActivity, type SpatialRendererModule } from '@explorable-models/player/activity';

// ---------------------------------------------------------------------------------------------
// In-memory host for this page
// ---------------------------------------------------------------------------------------------
type HostMethod = keyof HostPort;
type Receipt = StageReceipt | ExposureReceipt | AssistanceReceipt;
interface Table {
  instance: ActivityInstance; activityRevision: number; stage: string; events: InteractionEvent[]; eventDigests: Map<string, string>;
  exposures: ExposureRecord[]; receipts: Receipt[]; idempotency: Map<string, { method: HostMethod; request: string; receiptId: string }>; displayAcks: Map<string, string>;
  checkpointDigest: string | null;
}
class HostRejection extends Error { constructor(readonly code: DiagnosticCode, message: string) { super(message); this.name = 'HostRejection'; } }
const REQUEST_SCHEMA: Record<HostMethod, SchemaName> = {
  getPolicy: MESSAGES.activityLookupRequest, registerActivity: MESSAGES.registerActivityRequest, requestStageTransition: MESSAGES.stageTransitionRequest,
  recordExposureIntent: MESSAGES.exposureIntentRequest, recordDisplayAck: MESSAGES.displayAckRequest, recordAssistance: MESSAGES.assistanceRequest,
  appendEvents: MESSAGES.appendEventsRequest, getJournalCursor: MESSAGES.activityLookupRequest, saveArtifact: MESSAGES.saveArtifactRequest,
  getActivityRecords: MESSAGES.activityLookupRequest,
};
const reject = (code: DiagnosticCode, message: string): never => { throw new HostRejection(code, message); };
const clone = <T,>(value: T): T => structuredClone(value);

export class LifecycleHost implements HostPort {
  private readonly tables = new Map<string, Table>();
  private readonly artifactsById = new Map<string, { artifact: ActivityArtifact; digest: string; operationId: string }>();
  private readonly gates = new Map<HostMethod, { promise: Promise<void>; open: () => void }>();
  private readonly log: { method: HostMethod; activityId: string | null; at: number }[] = [];
  private counter = 0;
  constructor(private policy: HostPolicy) {}

  /** Calls of `method` wait (after being logged) until `release(method)`. */
  hold(method: HostMethod): void { if (this.gates.has(method)) return; let open!: () => void; const promise = new Promise<void>(resolve => { open = resolve; }); this.gates.set(method, { promise, open }); }
  release(method: HostMethod): void { const gate = this.gates.get(method); this.gates.delete(method); gate?.open(); }
  calls(method?: HostMethod, activityId?: string) { return this.log.filter(call => (!method || call.method === method) && (!activityId || call.activityId === activityId)).map(call => ({ ...call })); }
  events(activityId: string): InteractionEvent[] { return clone(this.tables.get(activityId)?.events ?? []); }
  exposures(activityId: string): ExposureRecord[] { return clone(this.tables.get(activityId)?.exposures ?? []); }
  artifacts(activityId?: string): ActivityArtifact[] { return [...this.artifactsById.values()].filter(entry => !activityId || entry.artifact.instance.activityId === activityId).map(entry => clone(entry.artifact)); }
  activities(): string[] { return [...this.tables.keys()]; }

  getPolicy(request: { activityId: string }) { return this.call('getPolicy', request, () => clone(this.policy)); }
  registerActivity(request: { instance: ActivityInstance; operationId: string }): Promise<HostAck> {
    return this.call('registerActivity', request, () => {
      const existing = this.tables.get(request.instance.activityId);
      if (existing) { existing.instance = clone(request.instance); return this.ack(); }
      this.tables.set(request.instance.activityId, {
        instance: clone(request.instance), activityRevision: request.instance.activityRevision, stage: request.instance.stage.id, events: [], eventDigests: new Map(),
        exposures: [], receipts: [], idempotency: new Map(), displayAcks: new Map(), checkpointDigest: null,
      });
      return this.ack();
    });
  }
  requestStageTransition(request: StageTransitionRequest): Promise<StageReceipt> {
    return this.call('requestStageTransition', request, () => this.authorize('requestStageTransition', request, table => {
      if (request.fromStage !== table.stage) reject('STALE_ACTIVITY_REVISION', 'The activity is not in the requested source stage.');
      const grant = request.groups.length ? this.grant('stage', request.groups) : null;
      const receipt: StageReceipt = { ...this.receiptBase(request, table), contract: CONTRACTS.stageReceipt, fromStage: request.fromStage, toStage: request.toStage, grant };
      table.stage = request.toStage;
      if (grant) this.recordGrant(table, receipt, grant, request.toStage);
      return receipt;
    }));
  }
  recordExposureIntent(request: ExposureIntentRequest): Promise<ExposureReceipt> {
    return this.call('recordExposureIntent', request, () => this.authorize('recordExposureIntent', request, table => {
      const grant = this.grant(request.scope, request.groups, request.parameterDomain);
      const receipt: ExposureReceipt = { ...this.receiptBase(request, table), contract: CONTRACTS.exposureReceipt, grant, intendedStage: request.intendedStage };
      this.recordGrant(table, receipt, grant, request.intendedStage);
      return receipt;
    }));
  }
  recordAssistance(request: AssistanceRequest): Promise<AssistanceReceipt> {
    return this.call('recordAssistance', request, () => this.authorize('recordAssistance', request, table => {
      const grant = request.groups.length ? this.grant('reveal', request.groups) : null;
      const receipt: AssistanceReceipt = { ...this.receiptBase(request, table), contract: CONTRACTS.assistanceReceipt, kind: request.kind, grant };
      if (grant) this.recordGrant(table, receipt, grant, table.stage);
      return receipt;
    }));
  }
  recordDisplayAck(request: DisplayAckRequest): Promise<HostAck> {
    return this.call('recordDisplayAck', request, () => {
      const table = this.table(request.activityId);
      const exposure = table.exposures.find(item => item.exposureId === request.exposureId) ?? reject('NOT_FOUND', 'Unknown exposure.');
      if (exposure.receiptId !== request.receiptId) reject('RECEIPT_MISMATCH', 'The receipt does not belong to this exposure.');
      const identity = digest(request);
      const previous = table.displayAcks.get(request.exposureId);
      if (previous !== undefined) return previous === identity ? this.ack() : reject('OPERATION_CONFLICT', 'A different display acknowledgement was recorded.');
      table.displayAcks.set(request.exposureId, identity);
      exposure.displayStatus = 'displayed';
      exposure.displayed = { projectionDigest: request.projectionDigest, frameId: request.frameId, monotonicMs: request.monotonicMs };
      return this.ack();
    });
  }
  appendEvents(request: { activityId: string; events: InteractionEvent[] }): Promise<AppendResult> {
    return this.call('appendEvents', request, () => {
      const table = this.table(request.activityId);
      let last = table.events.at(-1)?.sequence ?? 0;
      const fresh: InteractionEvent[] = [], duplicates: string[] = [];
      for (const event of request.events) {
        const identity = digest(event), known = table.eventDigests.get(event.eventId);
        if (known !== undefined) { if (known !== identity) reject('CONFLICT', 'A different event has this eventId.'); duplicates.push(event.eventId); continue; }
        if (event.activityId !== request.activityId || event.sequence !== last + 1) reject('CONFLICT', 'The event is not the next journal sequence of this activity.');
        last = event.sequence;
        fresh.push(event);
      }
      const hostTimestamp = this.timestamp();
      for (const event of fresh) { table.events.push(clone(event)); table.eventDigests.set(event.eventId, digest(event)); }
      return { acknowledged: fresh.map(event => ({ eventId: event.eventId, durableSequence: event.sequence, hostTimestamp })), duplicates, cursor: this.cursor(request.activityId) };
    });
  }
  getJournalCursor(request: { activityId: string }): Promise<JournalCursor> { return this.call('getJournalCursor', request, () => this.cursor(request.activityId)); }
  /** The host's exposure rows, assistance receipts and activity state (stage, revision, closed); a restore adopts the state. */
  getActivityRecords(request: { activityId: string }): Promise<ActivityRecords> {
    return this.call('getActivityRecords', request, () => {
      const table = this.table(request.activityId);
      const last = table.events.at(-1)?.sequence ?? 0;
      const assistance = table.receipts.filter((receipt): receipt is AssistanceReceipt => receipt.contract === CONTRACTS.assistanceReceipt).map(receipt => ({
        receiptId: receipt.receiptId, kind: receipt.kind,
        sequence: table.events.find(event => event.type === 'assistance.recorded' && event.payload.receiptId === receipt.receiptId)?.sequence ?? Math.max(1, last),
        grant: receipt.grant ? { exposureId: receipt.grant.exposureId, groups: receipt.grant.groups.map(group => group.groupId) } : null,
      }));
      return {
        activityId: request.activityId, exposures: clone(table.exposures), assistance,
        activity: { stage: table.stage, activityRevision: table.activityRevision, closed: table.events.some(event => event.type === 'activity.closed') },
      };
    });
  }
  saveArtifact(request: { artifact: ActivityArtifact; operationId: string }): Promise<HostAck & { artifactDigest: string }> {
    return this.call('saveArtifact', request, () => {
      const artifactId = request.artifact.artifactId, identity = artifactDigest(request.artifact);
      const stored = this.artifactsById.get(artifactId);
      if (stored && stored.digest !== identity) reject('CONFLICT', 'A different artifact has this artifactId.');
      this.artifactsById.set(artifactId, { artifact: clone(request.artifact), digest: identity, operationId: request.operationId });
      const table = this.tables.get(request.artifact.instance.activityId);
      if (table && request.artifact.kind === 'backup') table.checkpointDigest = identity;
      return { ...this.ack(), artifactDigest: identity };
    });
  }

  private async call<T>(method: HostMethod, request: unknown, run: () => T): Promise<T> {
    const activityId = typeof (request as { activityId?: unknown })?.activityId === 'string' ? (request as { activityId: string }).activityId
      : (request as { instance?: { activityId?: string }; artifact?: { instance?: { activityId?: string } } })?.instance?.activityId ?? (request as { artifact?: { instance?: { activityId?: string } } })?.artifact?.instance?.activityId ?? null;
    this.log.push({ method, activityId, at: performance.now() });
    // Host replies arrive asynchronously, like a native bridge.
    await Promise.resolve();
    const gate = this.gates.get(method);
    if (gate) await gate.promise;
    if (!validateRecord(REQUEST_SCHEMA[method], request).ok) reject('SCHEMA', `${method} request does not match its schema.`);
    return clone(run());
  }
  private authorize<T extends Receipt>(method: HostMethod, request: StageTransitionRequest | ExposureIntentRequest | AssistanceRequest, issue: (table: Table) => T): T {
    const table = this.table(request.activityId);
    const identity = digest(request);
    const previous = table.idempotency.get(request.idempotencyKey);
    if (previous) {
      if (previous.method !== method || previous.request !== identity) reject('OPERATION_CONFLICT', 'The idempotency key was used for a different request.');
      return table.receipts.find(receipt => receipt.receiptId === previous.receiptId) as T;
    }
    if (request.expectedPolicyRevision !== this.policy.revision) reject('STALE_POLICY_REVISION', 'Another policy revision.');
    if (request.basedOnActivityRevision !== table.activityRevision) reject('STALE_ACTIVITY_REVISION', 'Another activity revision.');
    const receipt = issue(table);
    table.activityRevision = receipt.activityRevision;
    table.receipts.push(clone(receipt));
    table.idempotency.set(request.idempotencyKey, { method, request: identity, receiptId: receipt.receiptId });
    return receipt;
  }
  private receiptBase(request: StageTransitionRequest | ExposureIntentRequest | AssistanceRequest, table: Table) {
    return {
      schemaVersion: '1.0' as const, receiptId: this.id('rcpt'), activityId: request.activityId, basedOnActivityRevision: request.basedOnActivityRevision,
      activityRevision: table.activityRevision + 1, policyId: this.policy.policyId, policyRevision: this.policy.revision, idempotencyKey: request.idempotencyKey,
      template: clone(request.template), model: clone(request.model), issuedAt: this.timestamp(), expiresAt: null,
    };
  }
  private grant(scope: ExposureGrant['scope'], groups: ExposureGrant['groups'], parameterDomain?: ExposureGrant['parameterDomain']): ExposureGrant {
    return { exposureId: this.id('exp'), scope, groups: clone(groups), ...(parameterDomain ? { parameterDomain: clone(parameterDomain) } : {}) };
  }
  private recordGrant(table: Table, receipt: Receipt, grant: ExposureGrant, intendedStage: string): void {
    table.exposures.push({
      contract: CONTRACTS.exposure, schemaVersion: '1.0', exposureId: grant.exposureId, activityId: receipt.activityId, receiptId: receipt.receiptId, scope: grant.scope,
      groups: clone(grant.groups), template: clone(receipt.template), model: clone(receipt.model), activityRevision: receipt.activityRevision, intendedStage,
      ...(grant.parameterDomain ? { parameterDomain: clone(grant.parameterDomain) } : {}), displayStatus: 'authorized',
    });
  }
  private table(activityId: string): Table { return this.tables.get(activityId) ?? reject('NOT_FOUND', 'The activity is not registered.'); }
  private cursor(activityId: string): JournalCursor {
    const table = this.table(activityId), last = table.events.at(-1);
    return { activityId, lastSequence: last?.sequence ?? 0, lastEventId: last?.eventId ?? null, checkpointDigest: table.checkpointDigest };
  }
  private ack(): HostAck { return { ok: true, hostTimestamp: this.timestamp() }; }
  private timestamp(): string { return new Date().toISOString(); }
  private id(prefix: string): string { return `${prefix}-${++this.counter}`; }
}

// ---------------------------------------------------------------------------------------------
// Catalogue workers with an optional reply hold
// ---------------------------------------------------------------------------------------------
/** Worker-compatible wrapper: while `held()` is true, replies of the real worker wait until `flush()`. */
class HoldableWorker extends EventTarget {
  private readonly queue: (() => void)[] = [];
  private terminated = false;
  constructor(private readonly worker: Worker, private readonly held: () => boolean, register: (flush: () => void) => () => void) {
    super();
    const unregister = register(() => this.flush());
    const forward = (event: Event) => {
      const copy = event.type === 'error' ? new Event('error') : new MessageEvent(event.type, { data: (event as MessageEvent).data });
      if (event.type === 'error') event.preventDefault();
      const deliver = () => { if (!this.terminated) this.dispatchEvent(copy); };
      if (this.held()) this.queue.push(deliver); else deliver();
    };
    for (const type of ['message', 'messageerror', 'error']) worker.addEventListener(type, forward);
    this.dispose = () => { unregister(); for (const type of ['message', 'messageerror', 'error']) worker.removeEventListener(type, forward); };
  }
  private readonly dispose: () => void;
  flush(): void { for (const deliver of this.queue.splice(0)) deliver(); }
  postMessage(message: unknown): void { if (!this.terminated) this.worker.postMessage(message); }
  terminate(): void { this.terminated = true; this.queue.length = 0; this.dispose(); this.worker.terminate(); }
}

// ---------------------------------------------------------------------------------------------
// Fixture page
// ---------------------------------------------------------------------------------------------
export type TemplateKey = 'quadratic' | 'derivative' | 'vector' | 'surface';
const TEMPLATES: Record<TemplateKey, ActivityTemplate> = {
  quadratic: quadraticGradientDescentTemplate, derivative: functionDerivativeTemplate, vector: vectorOrientationTemplate, surface: quadraticSurfaceGradientTemplate,
};
/** Templates with a `scene3d` view: their cards get the lazy spatial renderer loader. */
const SPATIAL = new Set<TemplateKey>(['vector', 'surface']);
/** The renderer module is imported only when a spatial card shows its 3D view; a 2D card never requests it. */
const loadSpatial = (): Promise<SpatialRendererModule> => import('./spatial-loader').then(module => module.loadSpatialRenderer());
export const MAX_WORKERS = 6;
export const HISTORY_CARDS = 20;

export interface Card {
  activityId: string;
  template: TemplateKey;
  surfaceId: string;
  prepared: PreparedActivity;
  learner: ActivityBinding;
  mounted: MountedStudyActivity | null;
  wrapper: HTMLElement;
  /** Projections delivered to this page's own listener (counts listener callbacks, including after disposal). */
  notifications: number;
}

const mode = new URLSearchParams(location.search).get('mode') === 'empty' ? 'empty' : 'interactive';
const installed = createInstalledCatalog();
const flushers = new Set<() => void>();
let holdReplies = false;
const workerStats = { created: 0, terminated: 0 };
const catalog = createInstalledCatalog({
  include: Object.values(TEMPLATES).map(template => template.templateId),
  workerFactory: () => {
    const worker = installed.createWorker();
    workerStats.created++;
    const wrapped = new HoldableWorker(worker, () => holdReplies, flush => { flushers.add(flush); return () => flushers.delete(flush); });
    const terminate = wrapped.terminate.bind(wrapped);
    wrapped.terminate = () => { workerStats.terminated++; terminate(); };
    return wrapped as unknown as Worker;
  },
});
const entries = catalog.listTemplates();
const refOf = (key: TemplateKey) => entries.find(entry => entry.template.templateId === TEMPLATES[key].templateId)!;
const allGroups = [...new Set(Object.values(TEMPLATES).flatMap(template => template.groups.map(group => group.id)))];
const allControls = [...new Set(Object.values(TEMPLATES).flatMap(template => template.controls.map(control => control.parameter)))];
const policy: HostPolicy = {
  contract: 'study-harness.host-policy', schemaVersion: '1.0', policyId: 'lifecycle-fixture', revision: 1, issuedAt: new Date().toISOString(), expiresAt: null, revoked: false,
  mode: 'approved', approved: (Object.keys(TEMPLATES) as TemplateKey[]).map(key => ({ template: refOf(key).template, model: refOf(key).model })),
  allowedTools: ['discover', 'prepare', 'inspect.learner', 'request-reveal', 'operate.parameters', 'operate.navigation', 'operate.playback', 'operate.presentation', 'summarize', 'save', 'restore', 'close'],
  visibleGroups: allGroups, permittedControls: allControls,
  export: { learnerSnapshot: true, capture: true, backup: true }, inspection: { developer: false, tutor: 'learner-visible', teacher: true },
  independentTask: { active: false, taskRef: null, permittedTools: [], neutralScaffold: [] }, sampling: { allowed: false, maxPositions: 1 },
  exploratory: { allowed: false, maxParametersOverride: 0 },
};
const host = new LifecycleHost(policy);
const adapter: StudyHarnessAdapter = createStudyHarnessAdapter({ catalog, host, maxWorkers: MAX_WORKERS });
const cards = new Map<string, Card>();
let operations = 0;
const op = (prefix: string) => `${prefix}-${++operations}`;
const must = (outcome: CommandOutcome | { ok: boolean; diagnostics?: { code: string }[] }, what: string) => {
  if (!outcome.ok) throw new Error(`${what} failed: ${JSON.stringify((outcome as { diagnostics?: unknown }).diagnostics)}`);
  return outcome;
};
const until = async (condition: () => boolean, timeoutMs = 5000) => {
  const start = performance.now();
  while (!condition()) { if (performance.now() - start > timeoutMs) throw new Error('Fixture condition not reached in time.'); await new Promise(resolve => setTimeout(resolve, 10)); }
};

function region(id: string): HTMLElement { return document.getElementById(id)!; }
function wrapperFor(container: 'active' | 'history' | 'stress', activityId: string, title: string): HTMLElement {
  const details = document.createElement('details');
  details.open = true;
  details.className = `lf-card lf-card-${container}`;
  details.dataset.activityId = activityId;
  const summary = document.createElement('summary');
  summary.textContent = title;
  const mount = document.createElement('div');
  mount.className = 'lf-mount';
  details.append(summary, mount);
  region(container === 'active' ? 'lf-active' : container === 'history' ? 'lf-history' : 'lf-stress').append(details);
  return details;
}
function attach(card: Card): Card {
  card.learner.subscribe(() => { card.notifications++; });
  card.mounted = mountStudyActivity(card.wrapper.querySelector<HTMLElement>('.lf-mount')!, {
    binding: card.learner, surfaceId: card.surfaceId, theme: 'light', fonts: 'system', headingLevel: 3, ...(SPATIAL.has(card.template) ? { spatialLoader: loadSpatial } : {}),
  });
  return card;
}

/** Prepares an activity under the shared adapter and mounts its learner surface. */
async function open(input: { activityId: string; template: TemplateKey; container?: 'active' | 'history' | 'stress'; mount?: boolean }): Promise<Card> {
  const template = TEMPLATES[input.template];
  const result = await adapter.prepare({
    activityId: input.activityId, objectiveIds: ['lifecycle'], hostSessionId: 'lifecycle-session', hostSessionRevision: 0,
    template: { templateId: template.templateId, version: template.version }, mode: 'approved', stageId: 'free-explore',
  }, { operationId: op(`prepare-${input.activityId}`) });
  must(result, `prepare ${input.activityId}`);
  const prepared = (result as { prepared: PreparedActivity }).prepared;
  const surfaceId = `surface-${input.activityId}`;
  const card: Card = {
    activityId: input.activityId, template: input.template, surfaceId, prepared, learner: prepared.binding('learner', surfaceId), mounted: null,
    wrapper: wrapperFor(input.container ?? 'active', input.activityId, template.title), notifications: 0,
  };
  cards.set(card.activityId, card);
  if (input.mount !== false) { attach(card); await card.mounted!.ready; }
  return card;
}
/** Restores a backup artifact as a new card. */
async function restore(artifact: ActivityArtifact, container: 'active' | 'history' | 'stress' = 'stress'): Promise<Card> {
  const result = await adapter.restore(artifact, { operationId: op(`restore-${artifact.instance.activityId}`), hostSessionRevision: 0 });
  must(result, `restore ${artifact.instance.activityId}`);
  const prepared = (result as { prepared: PreparedActivity }).prepared;
  const key = (Object.keys(TEMPLATES) as TemplateKey[]).find(name => TEMPLATES[name].templateId === artifact.template.templateId)!;
  const surfaceId = `surface-${prepared.activityId}-r${++operations}`;
  const card: Card = { activityId: prepared.activityId, template: key, surfaceId, prepared, learner: prepared.binding('learner', surfaceId), mounted: null, wrapper: wrapperFor(container, prepared.activityId, `${TEMPLATES[key].title} (restored)`), notifications: 0 };
  cards.set(card.activityId, card);
  attach(card);
  await card.mounted!.ready;
  return card;
}
/** Reveals the solution-bearing groups of the stage and authorizes exploration of every control (persist-before-reveal). */
async function authorize(activityId: string): Promise<void> {
  const card = cards.get(activityId)!;
  const template = TEMPLATES[card.template];
  const stage = template.stages.find(item => item.id === card.learner.getProjection().stage.id)!;
  const solution = template.groups.filter(group => group.solutionBearing && stage.visible[group.id]).map(group => group.id);
  const guard = () => ({ expectedActivityRevision: card.learner.getProjection().activityRevision, expectedPolicyRevision: card.learner.getProjection().policyRevision });
  if (solution.length) {
    must(await card.prepared.host.requestReveal({ operationId: op('reveal'), ...guard(), groups: solution }), 'reveal');
    await until(() => !card.learner.getProjection().pendingReveal);
  }
  const model = catalog.getModel({ modelId: template.model.modelId, version: template.model.version })!;
  const controls = template.controls.filter(control => stage.controls[control.parameter] === 'interactive');
  const parameterDomain = Object.fromEntries(controls.map(control => [control.parameter, [model.parameters[control.parameter]!.min, model.parameters[control.parameter]!.max] as [number, number]]));
  must(await card.prepared.host.requestExplorationScope({ operationId: op('scope'), ...guard(), groups: [...new Set([...controls.map(control => control.group), ...solution])], parameterDomain }), 'exploration scope');
}
/** Unmounts the surface and disposes the activity. */
function close(activityId: string): void {
  const card = cards.get(activityId);
  card?.mounted?.dispose();
  card?.wrapper.remove();
  adapter.dispose(activityId);
  cards.delete(activityId);
}
const snapshot = (activityId: string) => {
  const card = cards.get(activityId)!;
  const projection: LearnerProjection = card.learner.getProjection();
  return {
    projectionId: projection.projectionId, projectionDigest: projection.projectionDigest, ui: projection.status.ui, frame: projection.frame, guards: projection.guards,
    presentationRevision: projection.presentationRevision, activityRevision: projection.activityRevision, preview: projection.preview, stage: projection.stage.id,
    persistence: projection.status.persistence, controls: Object.fromEntries(projection.controls.map(control => [control.parameter, { value: control.value, previewValue: control.previewValue ?? null }])),
    navigation: projection.navigation, events: host.events(activityId).length, notifications: card.notifications,
  };
};
const guards = (activityId: string) => cards.get(activityId)!.learner.getProjection().guards;

/** One mount → interact → suspend → save → dispose → restore → mount → resume → dispose cycle (§18 lifecycle stress). */
async function cycle(index: number): Promise<void> {
  const activityId = `stress-${index}`;
  const card = await open({ activityId, template: index % 2 ? 'derivative' : 'quadratic', container: 'stress' });
  const parameter = card.template === 'quadratic' ? 'eta' : 'p';
  const value = card.template === 'quadratic' ? 0.5 + (index % 5) * 0.1 : -1 + (index % 5) * 0.5;
  must(await card.learner.commitParameters({ operationId: op('commit'), ...guards(activityId), displayValues: { [parameter]: value } }), 'commit');
  if (card.template === 'quadratic') must(await card.learner.navigate({ operationId: op('nav'), ...guards(activityId), position: { kind: 'index', index: 3 } }), 'navigate');
  must(card.prepared.host.suspend({ operationId: op('suspend'), reason: 'host' }), 'suspend');
  const saved = await card.prepared.host.save({ operationId: op('save'), kind: 'backup' });
  must(saved, 'save');
  await until(() => card.learner.getProjection().status.persistence === 'saved');
  close(activityId);
  const restored = await restore((saved as { artifact: ActivityArtifact }).artifact);
  must(restored.prepared.host.suspend({ operationId: op('suspend'), reason: 'host' }), 'suspend restored');
  must(restored.prepared.host.resume({ operationId: op('resume') }), 'resume restored');
  await until(() => restored.learner.getProjection().status.persistence === 'saved');
  close(activityId);
}

// ---------------------------------------------------------------------------------------------
// Spatial (3D) cycles: §13 resource counts over repeated mount/dispose and §18 lifecycle stress per spatial activity
// ---------------------------------------------------------------------------------------------
const shadowOf = (activityId: string) => cards.get(activityId)?.mounted?.element.shadowRoot ?? null;
/** The renderer's own status (`data-em3-status`) and the surface's view state (`data-ema-spatial-state`) of a card. */
const spatialState = (activityId: string) => {
  const shadow = shadowOf(activityId);
  return {
    renderer: shadow?.querySelector('[data-em3-root]')?.getAttribute('data-em3-status') ?? null,
    surface: shadow?.querySelector('[data-ema-spatial]')?.getAttribute('data-ema-spatial-state') ?? null,
  };
};
const sceneViewId = (key: TemplateKey) => TEMPLATES[key].views.find(view => view.kind === 'scene3d')!.id;
/** Scrolls the card into view and waits until its renderer is mounted and ready and the surface shows it. */
async function spatialReady(activityId: string): Promise<void> {
  cards.get(activityId)!.wrapper.scrollIntoView({ block: 'start' });
  await until(() => { const state = spatialState(activityId); return state.renderer === 'ready' && state.surface === 'ready'; }, 20_000);
}
/** One keyboard step on the focused 3D viewport; waits until the renderer has committed the camera to the binding. */
async function turnCamera(activityId: string): Promise<void> {
  const card = cards.get(activityId)!;
  const before = card.learner.getProjection().presentationRevision;
  const viewport = shadowOf(activityId)!.querySelector<HTMLElement>('.em3-viewport')!;
  viewport.focus();
  viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
  await until(() => card.learner.getProjection().presentationRevision > before);
}
const SPATIAL_INPUT: Record<'vector' | 'surface', { parameter: string; value: (index: number) => number }> = {
  vector: { parameter: 'uz', value: index => -2 + (index % 5) },
  surface: { parameter: 'px', value: index => -1.5 + (index % 7) * 0.5 },
};
/**
 * Spatial cycle, first part: mount a 3D card (vector orientation for even indices, the quadratic surface for odd ones),
 * wait for its renderer, commit a parameter and turn the camera. The test may change the motion preference before the
 * second part (the SpatialView then remounts its renderer).
 */
async function spatialOpen(index: number): Promise<string> {
  const activityId = `spatial-${index}`;
  const template: 'vector' | 'surface' = index % 2 ? 'surface' : 'vector';
  const card = await open({ activityId, template, container: 'stress' });
  await spatialReady(activityId);
  const input = SPATIAL_INPUT[template];
  must(await card.learner.commitParameters({ operationId: op('commit'), ...guards(activityId), displayValues: { [input.parameter]: input.value(index) } }), 'commit');
  await turnCamera(activityId);
  return activityId;
}
/**
 * Spatial cycle, second part: host suspend and resume, save a backup, dispose, restore it as a new card, wait for the
 * restored renderer and dispose again. Reports whether the restored presentation carries the saved camera.
 */
async function spatialClose(activityId: string): Promise<{ cameraRestored: boolean; suspendedUi: string }> {
  const card = cards.get(activityId)!;
  const viewId = sceneViewId(card.template);
  must(card.prepared.host.suspend({ operationId: op('suspend'), reason: 'host' }), 'suspend');
  await until(() => card.learner.getProjection().status.ui === 'suspended');
  const suspendedUi = card.learner.getProjection().status.ui;
  must(card.prepared.host.resume({ operationId: op('resume') }), 'resume');
  await until(() => card.learner.getProjection().status.ui !== 'suspended');
  const saved = await card.prepared.host.save({ operationId: op('save'), kind: 'backup' });
  must(saved, 'save');
  await until(() => card.learner.getProjection().status.persistence === 'saved');
  const camera = JSON.stringify(card.learner.getProjection().presentation.views[viewId]?.camera ?? null);
  close(activityId);
  const restored = await restore((saved as { artifact: ActivityArtifact }).artifact);
  await spatialReady(restored.activityId);
  const cameraRestored = camera !== 'null' && JSON.stringify(restored.learner.getProjection().presentation.views[viewId]?.camera ?? null) === camera;
  close(restored.activityId);
  return { cameraRestored, suspendedUi };
}

async function setup(): Promise<void> {
  if (mode === 'empty') return;
  await open({ activityId: 'card-quadratic', template: 'quadratic' });
  await open({ activityId: 'card-derivative', template: 'derivative' });
  await authorize('card-quadratic');
  await authorize('card-derivative');
  for (let index = 0; index < HISTORY_CARDS; index++) {
    // Earlier cards of the conversation: prepared, shown once, then frozen by the host.
    const card = await open({ activityId: `history-${index}`, template: index % 2 ? 'derivative' : 'quadratic', container: 'history' });
    must(card.prepared.host.suspend({ operationId: op('suspend'), reason: 'host' }), 'suspend history');
  }
  await until(() => [...cards.values()].every(card => card.learner.getProjection().status.persistence === 'saved'));
}

export interface LifecycleFixture {
  mode: typeof mode;
  ready: Promise<void>;
  adapter: StudyHarnessAdapter;
  host: LifecycleHost;
  cards: Map<string, Card>;
  workers: typeof workerStats & { holdReplies(hold: boolean): void; flush(): void };
  open: typeof open;
  restore: typeof restore;
  authorize: typeof authorize;
  close: typeof close;
  cycle: typeof cycle;
  spatialOpen: typeof spatialOpen;
  spatialClose: typeof spatialClose;
  spatialReady: typeof spatialReady;
  spatialState: typeof spatialState;
  /** Releases the 3D renderer's idle pooled renderers (`releaseIdleRenderers`); returns how many were released. */
  releaseIdleSpatialRenderers(): Promise<number>;
  snapshot: typeof snapshot;
  guards: typeof guards;
  until: typeof until;
  op: typeof op;
}
const fixture: LifecycleFixture = {
  mode, ready: setup(), adapter, host, cards, open, restore, authorize, close, cycle, spatialOpen, spatialClose, spatialReady, spatialState, snapshot, guards, until, op,
  releaseIdleSpatialRenderers: () => import('./spatial-loader').then(module => module.releaseIdleSpatialRenderers()),
  workers: Object.assign(workerStats, { holdReplies(hold: boolean) { holdReplies = hold; }, flush() { for (const flush of [...flushers]) flush(); } }),
};
fixture.ready.then(() => { document.body.dataset.ready = 'true'; }, error => {
  document.body.dataset.ready = 'failed';
  region('lf-status').textContent = `Fixture setup failed: ${error instanceof Error ? error.message : String(error)}`;
});
(window as unknown as { lifecycleFixture: LifecycleFixture }).lifecycleFixture = fixture;
