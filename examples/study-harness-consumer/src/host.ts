/**
 * PACKED-CONSUMER FIXTURE HOST — an in-memory `HostPort` for the packed consumer app and its benchmark page. It is not
 * a Study Harness host, not a durable store and not a learning database: tables live in page memory and vanish with the
 * page. It does what the adapter needs from a host (policies per activity, receipts with idempotency, exposure records,
 * display acknowledgements, an eventId-deduplicated journal, artifacts) and adds two controls the benchmark needs:
 *
 * - `setLatency(method, ms)`: every call of `method` (or `'*'`) is answered after `ms` milliseconds, like a slow store;
 * - `hold(method)` / `release(method)`: calls of `method` wait until released (stalled persistence).
 *
 * Every call is timed (`calls()`), so storage acknowledgement can be reported separately from evaluation and rendering.
 * Requests are validated against the published message schemas before they are applied, as a real host must.
 */
import {
  CONTRACTS, MESSAGES, artifactDigest, validateRecord,
  type ActivityArtifact, type ActivityCatalog, type ActivityInstance, type ActivityRecords, type AppendResult, type AssistanceReceipt, type AssistanceRequest, type DiagnosticCode,
  type DisplayAckRequest, type ExposureGrant, type ExposureIntentRequest, type ExposureReceipt, type ExposureRecord, type HostAck, type HostPolicy, type HostPort,
  type InteractionEvent, type JournalCursor, type SchemaName, type StageReceipt, type StageTransitionRequest, type ToolOperation,
} from '@explorable-models/activity';

export type HostMethod = keyof HostPort;
type Receipt = StageReceipt | ExposureReceipt | AssistanceReceipt;
interface Table {
  instance: ActivityInstance;
  activityRevision: number;
  stage: string;
  events: InteractionEvent[];
  eventIdentity: Map<string, string>;
  exposures: ExposureRecord[];
  receipts: Receipt[];
  idempotency: Map<string, { method: HostMethod; request: string; receiptId: string }>;
  displayAcks: Map<string, string>;
  checkpointDigest: string | null;
}
export interface HostCall { method: HostMethod; activityId: string | null; startedAt: number; settledAt: number | null; ok: boolean | null; events: number }

const REQUEST_SCHEMA: Record<HostMethod, SchemaName> = {
  getPolicy: MESSAGES.activityLookupRequest, registerActivity: MESSAGES.registerActivityRequest, requestStageTransition: MESSAGES.stageTransitionRequest,
  recordExposureIntent: MESSAGES.exposureIntentRequest, recordDisplayAck: MESSAGES.displayAckRequest, recordAssistance: MESSAGES.assistanceRequest,
  appendEvents: MESSAGES.appendEventsRequest, getJournalCursor: MESSAGES.activityLookupRequest, saveArtifact: MESSAGES.saveArtifactRequest,
  getActivityRecords: MESSAGES.activityLookupRequest,
};
/** Learner-facing operations this fixture host allows (no sampling, no exploratory composition). */
const ALLOWED_TOOLS: ToolOperation[] = ['discover', 'prepare', 'inspect.learner', 'request-reveal', 'operate.parameters', 'operate.navigation', 'operate.playback', 'operate.presentation', 'summarize', 'save', 'restore', 'close'];
const CALL_LOG_LIMIT = 20_000;

export class HostRejection extends Error {
  constructor(readonly code: DiagnosticCode, message: string) { super(message); this.name = 'HostRejection'; }
}
const reject = (code: DiagnosticCode, message: string): never => { throw new HostRejection(code, message); };
const clone = <T,>(value: T): T => structuredClone(value);
/** Canonical JSON (sorted keys) for request identity under an idempotency key. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
const activityOf = (request: unknown): string | null => {
  const value = request as { activityId?: unknown; instance?: { activityId?: unknown }; artifact?: { instance?: { activityId?: unknown } } } | null;
  const id = value?.activityId ?? value?.instance?.activityId ?? value?.artifact?.instance?.activityId;
  return typeof id === 'string' ? id : null;
};

export class ConsumerHost implements HostPort {
  private readonly tables = new Map<string, Table>();
  private readonly policies = new Map<string, HostPolicy>();
  private readonly artifactsById = new Map<string, { artifact: ActivityArtifact; digest: string }>();
  private readonly latency = new Map<HostMethod | '*', number>();
  private readonly gates = new Map<HostMethod, { promise: Promise<void>; open: () => void }>();
  private readonly log: HostCall[] = [];
  private counter = 0;

  constructor(private readonly catalog: ActivityCatalog) {}

  // ---- host decisions (fixture) -----------------------------------------------------------------------------------
  /**
   * Issues the policy for `activityId`: it approves exactly the installed template and its model (references computed by
   * the catalogue from installed content), shows every group of the template and permits every control. A fixture
   * decision, not a Study Harness policy.
   */
  authorize(activityId: string, templateId: string): HostPolicy {
    const entry = this.catalog.listTemplates().find(item => item.template.templateId === templateId);
    if (!entry) throw new RangeError(`The installed catalogue does not serve ${templateId}.`);
    const template = this.catalog.getTemplate(entry.template)!;
    const policy: HostPolicy = {
      contract: CONTRACTS.policy, schemaVersion: '1.0', policyId: `consumer-${activityId}`.slice(0, 128), revision: 1, issuedAt: new Date().toISOString(), expiresAt: null,
      revoked: false, mode: 'approved', approved: [{ template: entry.template, model: entry.model }], allowedTools: [...ALLOWED_TOOLS],
      visibleGroups: template.groups.map(group => group.id), permittedControls: template.controls.map(control => control.parameter),
      export: { learnerSnapshot: true, capture: true, backup: true }, inspection: { developer: false, tutor: 'learner-visible', teacher: false },
      independentTask: { active: false, taskRef: null, permittedTools: [], neutralScaffold: [] }, sampling: { allowed: false, maxPositions: 0 },
      exploratory: { allowed: false, maxParametersOverride: 0 },
    };
    this.policies.set(activityId, policy);
    return clone(policy);
  }
  /** Answers every call of `method` (or of every method with `'*'`) after `ms` milliseconds; 0 removes the latency. */
  setLatency(method: HostMethod | '*', ms: number): void { if (ms > 0) this.latency.set(method, ms); else this.latency.delete(method); }
  /** Calls of `method` wait (after being logged) until `release(method)`. */
  hold(method: HostMethod): void {
    if (this.gates.has(method)) return;
    let open!: () => void;
    const promise = new Promise<void>(resolve => { open = resolve; });
    this.gates.set(method, { promise, open });
  }
  release(method: HostMethod): void { const gate = this.gates.get(method); this.gates.delete(method); gate?.open(); }
  calls(method?: HostMethod, since = 0): HostCall[] { return this.log.filter(call => (!method || call.method === method) && call.startedAt >= since).map(call => ({ ...call })); }
  events(activityId: string): InteractionEvent[] { return clone(this.tables.get(activityId)?.events ?? []); }
  exposures(activityId: string): ExposureRecord[] { return clone(this.tables.get(activityId)?.exposures ?? []); }
  displayAcks(activityId: string): string[] { return [...(this.tables.get(activityId)?.displayAcks.keys() ?? [])]; }
  artifacts(activityId?: string): ActivityArtifact[] { return [...this.artifactsById.values()].filter(entry => !activityId || entry.artifact.instance.activityId === activityId).map(entry => clone(entry.artifact)); }
  activities(): string[] { return [...this.tables.keys()]; }

  // ---- HostPort ---------------------------------------------------------------------------------------------------
  getPolicy(request: { activityId: string }): Promise<HostPolicy> {
    return this.call('getPolicy', request, () => clone(this.policies.get(request.activityId) ?? reject('NOT_FOUND', 'The host has issued no policy for this activity.')));
  }
  registerActivity(request: { instance: ActivityInstance; operationId: string }): Promise<HostAck> {
    return this.call('registerActivity', request, () => {
      const existing = this.tables.get(request.instance.activityId);
      if (existing) { existing.instance = clone(request.instance); return this.ack(); }
      this.tables.set(request.instance.activityId, {
        instance: clone(request.instance), activityRevision: request.instance.activityRevision, stage: request.instance.stage.id, events: [], eventIdentity: new Map(),
        exposures: [], receipts: [], idempotency: new Map(), displayAcks: new Map(), checkpointDigest: null,
      });
      return this.ack();
    });
  }
  requestStageTransition(request: StageTransitionRequest): Promise<StageReceipt> {
    return this.call('requestStageTransition', request, () => this.issue('requestStageTransition', request, table => {
      if (request.fromStage !== table.stage) reject('STALE_ACTIVITY_REVISION', 'The activity is not in the requested source stage.');
      const grant = request.groups.length ? this.grant('stage', request.groups) : null;
      const receipt: StageReceipt = { ...this.receiptBase(request, table), contract: CONTRACTS.stageReceipt, fromStage: request.fromStage, toStage: request.toStage, grant };
      table.stage = request.toStage;
      if (grant) this.recordGrant(table, receipt, grant, request.toStage);
      return receipt;
    }));
  }
  recordExposureIntent(request: ExposureIntentRequest): Promise<ExposureReceipt> {
    return this.call('recordExposureIntent', request, () => this.issue('recordExposureIntent', request, table => {
      const grant = this.grant(request.scope, request.groups, request.parameterDomain);
      const receipt: ExposureReceipt = { ...this.receiptBase(request, table), contract: CONTRACTS.exposureReceipt, grant, intendedStage: request.intendedStage };
      this.recordGrant(table, receipt, grant, request.intendedStage);
      return receipt;
    }));
  }
  recordAssistance(request: AssistanceRequest): Promise<AssistanceReceipt> {
    return this.call('recordAssistance', request, () => this.issue('recordAssistance', request, table => {
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
      const identity = canonical(request), previous = table.displayAcks.get(request.exposureId);
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
        const identity = canonical(event), known = table.eventIdentity.get(event.eventId);
        if (known !== undefined) { if (known !== identity) reject('CONFLICT', 'A different event has this eventId.'); duplicates.push(event.eventId); continue; }
        if (event.activityId !== request.activityId || event.sequence !== last + 1) reject('CONFLICT', 'The event is not the next journal sequence of this activity.');
        last = event.sequence;
        fresh.push(event);
      }
      const hostTimestamp = this.timestamp();
      for (const event of fresh) { table.events.push(clone(event)); table.eventIdentity.set(event.eventId, canonical(event)); }
      return { acknowledged: fresh.map(event => ({ eventId: event.eventId, durableSequence: event.sequence, hostTimestamp })), duplicates, cursor: this.cursor(request.activityId) };
    }, request.events.length);
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
      this.artifactsById.set(artifactId, { artifact: clone(request.artifact), digest: identity });
      const table = this.tables.get(request.artifact.instance.activityId);
      if (table && request.artifact.kind === 'backup') table.checkpointDigest = identity;
      return { ...this.ack(), artifactDigest: identity };
    });
  }

  // ---- internals --------------------------------------------------------------------------------------------------
  private async call<T>(method: HostMethod, request: unknown, run: () => T, events = 0): Promise<T> {
    const record: HostCall = { method, activityId: activityOf(request), startedAt: performance.now(), settledAt: null, ok: null, events };
    this.log.push(record);
    if (this.log.length > CALL_LOG_LIMIT) this.log.splice(0, this.log.length - CALL_LOG_LIMIT);
    try {
      // Host replies arrive asynchronously, like a native bridge.
      await Promise.resolve();
      const delay = this.latency.get(method) ?? this.latency.get('*') ?? 0;
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
      const gate = this.gates.get(method);
      if (gate) await gate.promise;
      if (!validateRecord(REQUEST_SCHEMA[method], request).ok) reject('SCHEMA', `${method} request does not match its schema.`);
      const result = clone(run());
      record.ok = true;
      return result;
    } catch (error) {
      record.ok = false;
      throw error;
    } finally {
      record.settledAt = performance.now();
    }
  }
  private issue<T extends Receipt>(method: HostMethod, request: StageTransitionRequest | ExposureIntentRequest | AssistanceRequest, make: (table: Table) => T): T {
    const table = this.table(request.activityId);
    const identity = canonical(request), previous = table.idempotency.get(request.idempotencyKey);
    if (previous) {
      if (previous.method !== method || previous.request !== identity) reject('OPERATION_CONFLICT', 'The idempotency key was used for a different request.');
      return table.receipts.find(receipt => receipt.receiptId === previous.receiptId) as T;
    }
    const policy = this.policies.get(request.activityId) ?? reject('NOT_FOUND', 'The host has issued no policy for this activity.');
    if (request.expectedPolicyRevision !== policy.revision) reject('STALE_POLICY_REVISION', 'Another policy revision is current.');
    if (request.basedOnActivityRevision !== table.activityRevision) reject('STALE_ACTIVITY_REVISION', 'Another activity revision is current.');
    const receipt = make(table);
    table.activityRevision = receipt.activityRevision;
    table.receipts.push(clone(receipt));
    table.idempotency.set(request.idempotencyKey, { method, request: identity, receiptId: receipt.receiptId });
    return receipt;
  }
  private receiptBase(request: StageTransitionRequest | ExposureIntentRequest | AssistanceRequest, table: Table) {
    const policy = this.policies.get(request.activityId)!;
    return {
      schemaVersion: '1.0' as const, receiptId: this.id('rcpt'), activityId: request.activityId, basedOnActivityRevision: request.basedOnActivityRevision,
      activityRevision: table.activityRevision + 1, policyId: policy.policyId, policyRevision: policy.revision, idempotencyKey: request.idempotencyKey,
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
