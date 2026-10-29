/**
 * BROWSER INTEGRATION FIXTURE — not a tutor, not a Study Harness host and not an authoritative learning database.
 *
 * `FixtureHost` implements the narrow `HostPort` for the integration fixture page (the scripted quadratic
 * learning-and-return flow and the generic flow for every installed template). It owns the host
 * tables the contract assigns to the host (per-activity policies and their revisions, receipts with idempotency by
 * key, exposure records, display acknowledgements, the event journal with duplicate detection by eventId, artifacts,
 * the host session revision and host-owned response text) and keeps them in `sessionStorage`, so reloading the tab
 * simulates a host restart. sessionStorage is per tab, unencrypted, cleared with the tab and bounded by the browser
 * quota; a quota failure is reported as a failed host write (nothing is half-committed).
 *
 * Fault injection (query string or the fixture control panel): one-shot failures before commit, delays before a call is
 * processed, late replies after a commit, and crash points at the exposure protocol (before the intent commit, after the intent commit and before
 * the reply, after display and before the display acknowledgement is committed). After a crash every call stays
 * unanswered, like a terminated process; the page then shows the terminated state until it is relaunched.
 *
 * On start the host applies its own conservative restart rule: an exposure it authorized without a persisted display
 * acknowledgement becomes `uncertain` (`INTERRUPTED_BEFORE_ACK`), i.e. potentially seen, until an acknowledgement for
 * it is persisted.
 */
import {
  CONTRACTS, MESSAGES, artifactDigest, validateRecord,
  type ActivityArtifact, type ActivityInstance, type ActivityRecords, type AppendResult, type AssistanceReceipt, type AssistanceRequest, type DiagnosticCode,
  type DisplayAckRequest, type ExposureGrant, type ExposureIntentRequest, type ExposureReceipt, type ExposureRecord, type HostAck, type HostPolicy,
  type HostContextLineage, type HostPort, type HostRefusalCode, type InteractionEvent, type JournalCursor, type ResponseRef, type SchemaName, type StageReceipt,
  type StageTransitionRequest,
} from '@explorable-models/activity';
import { digest } from '@explorable-models/core';

export const FIXTURE_STORAGE_KEY = 'explorable-models.study-harness-fixture.v1';
const TABLES_VERSION = 1;
const CALL_LOG_LIMIT = 200;

export type HostMethod = keyof HostPort;
/** Named injection points. `exposure-intent` is a host call that would reveal solution-bearing content. */
export type InjectionPoint = 'exposure-intent' | 'scope-intent' | 'stage' | 'display-ack' | 'append' | 'save' | 'assistance' | 'policy' | 'cursor' | 'register';
export const INJECTION_POINTS: readonly InjectionPoint[] = ['exposure-intent', 'scope-intent', 'stage', 'display-ack', 'append', 'save', 'assistance', 'policy', 'cursor', 'register'];
export type CrashPoint = 'before-intent' | 'after-intent' | 'after-display';
export const CRASH_POINTS: readonly CrashPoint[] = ['before-intent', 'after-intent', 'after-display'];

type Receipt = StageReceipt | ExposureReceipt | AssistanceReceipt;
interface ActivityTable {
  instance: ActivityInstance;
  activityRevision: number;
  stage: string;
  registrations: string[];
  events: InteractionEvent[];
  eventDigests: Record<string, string>;
  exposures: ExposureRecord[];
  receipts: Receipt[];
  idempotency: Record<string, { method: HostMethod; request: string; receiptId: string }>;
  displayAcks: Record<string, string>;
  checkpointDigest: string | null;
  /**
   * The context lineage the host holds (`ActivityRecords.activity.lineage`): independent from the host's activation of an
   * independent task until it records a `reopen-instructional` assistance. Derived only from host decisions (policies it
   * issued, receipts it committed), never from a registered instance or adapter-written events. Absent in tables stored
   * before the field existed (reported as instructional from revision 0).
   */
  lineage?: HostContextLineage;
  /** The active independent task of the last policy the host issued for the activity (null when none is active). */
  independentTask?: string | null;
  /** The receipt that moved the activity to its current stage (`ActivityRecords.activity.stageReceiptId`). */
  stageReceiptId?: string;
}
/** A host-owned response: the text stays in the host tables; the activity receives only the reference. */
export interface HostResponse { ref: Omit<ResponseRef, 'status'>; activityId: string; text: string; recordedAt: string; snapshotCursor: number | null }
export interface StoredArtifact { artifactId: string; activityId: string; kind: ActivityArtifact['kind']; digest: string; operationId: string; savedAt: string; artifact: ActivityArtifact }

/** Durable host tables (JSON-compatible); what survives a reload of the tab. */
export interface FixtureTables {
  version: typeof TABLES_VERSION;
  /** Random per fixture session; prefixes operation and activity IDs so two sessions never collide. */
  nonce: string;
  clockMs: number;
  counter: number;
  starts: number;
  hostSessionRevision: number;
  policies: Record<string, HostPolicy>;
  activities: Record<string, ActivityTable>;
  artifacts: StoredArtifact[];
  artifactOperations: Record<string, string>;
  latestBackup: Record<string, string>;
  responses: HostResponse[];
  crash: { fired: CrashPoint[]; last: { point: CrashPoint; method: HostMethod; at: string } | null };
  /** Exposure records the host's restart rule changed (authorized without a persisted acknowledgement → uncertain). */
  recoveries: { activityId: string; exposureId: string; from: 'authorized'; to: 'uncertain'; start: number; at: string }[];
  /** Opaque fixture-session state (scripted flow position, messages); owned by the page, persisted with the tables. */
  session: Record<string, unknown>;
}

export interface CallRecord { method: HostMethod; outcome: 'ok' | 'failed' | 'refused' | 'rejected' | 'crashed'; point: InjectionPoint | null; at: string }

/**
 * Error thrown to the adapter. `code` is set only when the request itself was refused: `refused` is a policy refusal
 * under the HostPort convention (activity-runtime §10; one of `HOST_REFUSAL_CODES`, never retried by the adapter),
 * `rejected` any other refusal; `failed` is a write that did not happen and may be retried.
 */
export class FixtureHostError extends Error {
  constructor(readonly kind: 'failed' | 'refused' | 'rejected', message: string, readonly code?: DiagnosticCode) { super(message); this.name = 'FixtureHostError'; }
}
class CrashSignal { constructor(readonly point: CrashPoint) {} }

const REQUEST_SCHEMA: Record<HostMethod, SchemaName> = {
  getPolicy: MESSAGES.activityLookupRequest, registerActivity: MESSAGES.registerActivityRequest, requestStageTransition: MESSAGES.stageTransitionRequest,
  recordExposureIntent: MESSAGES.exposureIntentRequest, recordDisplayAck: MESSAGES.displayAckRequest, recordAssistance: MESSAGES.assistanceRequest,
  appendEvents: MESSAGES.appendEventsRequest, getJournalCursor: MESSAGES.activityLookupRequest, saveArtifact: MESSAGES.saveArtifactRequest,
  getActivityRecords: MESSAGES.activityLookupRequest,
};
const clone = <T>(value: T): T => structuredClone(value);
const reject = (code: DiagnosticCode, message: string): never => { throw new FixtureHostError('rejected', message, code); };
/** Policy refusal: the host decided against the request (HostPort convention), so the adapter reports `code` without retrying. */
const refuse = (code: HostRefusalCode, message: string): never => { throw new FixtureHostError('refused', message, code); };
const sameRef = (a: unknown, b: unknown): boolean => digest(a) === digest(b);

/** Injection points a call matches, most specific first. */
function pointsOf(method: HostMethod, request: unknown): InjectionPoint[] {
  const groups = (request as { groups?: unknown[] } | null)?.groups;
  switch (method) {
    case 'recordExposureIntent': return (request as ExposureIntentRequest).scope === 'exploration' ? ['scope-intent'] : ['exposure-intent'];
    case 'requestStageTransition': return Array.isArray(groups) && groups.length ? ['exposure-intent', 'stage'] : ['stage'];
    case 'recordDisplayAck': return ['display-ack'];
    case 'appendEvents': return ['append'];
    case 'saveArtifact': return ['save'];
    case 'recordAssistance': return ['assistance'];
    case 'getPolicy': return ['policy'];
    case 'getJournalCursor': return ['cursor'];
    case 'getActivityRecords': return ['cursor'];
    case 'registerActivity': return ['register'];
  }
}

function randomNonce(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function emptyTables(): FixtureTables {
  return {
    version: TABLES_VERSION, nonce: randomNonce(), clockMs: Date.now(), counter: 0, starts: 0, hostSessionRevision: 0, policies: {}, activities: {},
    artifacts: [], artifactOperations: {}, latestBackup: {}, responses: [], crash: { fired: [], last: null }, recoveries: [], session: {},
  };
}

export interface FixtureHostOptions {
  /** Storage holding the tables (sessionStorage on the page); null keeps them in memory only. */
  storage: Storage | null;
  /** Called after every committed change and every injection outcome (the page re-renders its host panel). */
  onChange?(): void;
  /** Called once when a crash point fires; the page then disposes its adapter and shows the terminated state. */
  onCrash?(point: CrashPoint): void;
  /** Artifacts kept per activity and kind (oldest dropped first). */
  keepArtifacts?: number;
}

export class FixtureHost implements HostPort {
  private tables: FixtureTables;
  private readonly storage: Storage | null;
  private readonly fails = new Map<InjectionPoint, number>();
  private readonly delays = new Map<InjectionPoint, number>();
  private readonly lags = new Map<InjectionPoint, number>();
  private readonly log: CallRecord[] = [];
  private armed: CrashPoint | null = null;
  private readonly keep: number;
  /** True after `terminate()`: this instance answers nothing and writes nothing more (an in-page host restart). */
  private stopped = false;
  /** True after a crash point fired: every later call stays unanswered, like a terminated process. */
  crashed = false;
  /** True when the tables were loaded from storage (this start is a restart of an earlier host session). */
  readonly restarted: boolean;

  constructor(private readonly options: FixtureHostOptions) {
    this.storage = options.storage;
    this.keep = options.keepArtifacts ?? 4;
    const loaded = this.load();
    this.restarted = loaded !== null;
    this.tables = loaded ?? emptyTables();
    this.tables.starts++;
    if (this.restarted) this.applyRestartRule();
    this.persist();
  }

  // -------------------------------------------------------------------------------------------
  // Fixture controls and inspection (not part of HostPort)
  // -------------------------------------------------------------------------------------------
  /** Fails the next `times` calls matching `point` before anything is committed. */
  failNext(point: InjectionPoint, times = 1): void { this.fails.set(point, (this.fails.get(point) ?? 0) + Math.max(1, Math.floor(times))); this.changed(); }
  /** Delays every later call matching `point` by `ms` before it is processed (0 clears). */
  delay(point: InjectionPoint, ms: number): void { if (ms > 0) this.delays.set(point, ms); else this.delays.delete(point); this.changed(); }
  /** Delays the reply of every later call matching `point` by `ms` after it was committed (a late reply; 0 clears). */
  lag(point: InjectionPoint, ms: number): void { if (ms > 0) this.lags.set(point, ms); else this.lags.delete(point); this.changed(); }
  /** Arms one crash at a protocol point; a point fires at most once per fixture session (it survives the restart). */
  armCrash(point: CrashPoint | null): void { this.armed = point && !this.tables.crash.fired.includes(point) ? point : null; this.changed(); }
  injections(): { fail: Record<string, number>; delay: Record<string, number>; lag: Record<string, number>; crash: CrashPoint | null } {
    return { fail: Object.fromEntries(this.fails), delay: Object.fromEntries(this.delays), lag: Object.fromEntries(this.lags), crash: this.armed };
  }
  get nonce(): string { return this.tables.nonce; }
  get starts(): number { return this.tables.starts; }
  get hostSessionRevision(): number { return this.tables.hostSessionRevision; }
  get lastCrash(): FixtureTables['crash']['last'] { return clone(this.tables.crash.last); }
  snapshot(): FixtureTables { return clone(this.tables); }
  calls(): CallRecord[] { return clone(this.log); }
  policy(activityId: string): HostPolicy | null { return clone(this.tables.policies[activityId] ?? null); }
  events(activityId: string): InteractionEvent[] { return clone(this.tables.activities[activityId]?.events ?? []); }
  exposures(activityId: string): ExposureRecord[] { return clone(this.tables.activities[activityId]?.exposures ?? []); }
  receipts(activityId: string): Receipt[] { return clone(this.tables.activities[activityId]?.receipts ?? []); }
  displayAcked(activityId: string, exposureId: string): boolean { return !!this.tables.activities[activityId]?.displayAcks[exposureId]; }
  activity(activityId: string): { activityRevision: number; stage: string; lastSequence: number } | null {
    const table = this.tables.activities[activityId];
    return table ? { activityRevision: table.activityRevision, stage: table.stage, lastSequence: table.events.at(-1)?.sequence ?? 0 } : null;
  }
  artifacts(activityId?: string): StoredArtifact[] { return clone(this.tables.artifacts.filter(entry => !activityId || entry.activityId === activityId)); }
  latestBackup(activityId: string): ActivityArtifact | null {
    const id = this.tables.latestBackup[activityId];
    return clone(this.tables.artifacts.find(entry => entry.artifactId === id)?.artifact ?? null);
  }
  responses(): HostResponse[] { return clone(this.tables.responses); }
  recoveries(): FixtureTables['recoveries'] { return clone(this.tables.recoveries); }
  session<T>(): T { return clone(this.tables.session) as T; }
  setSession(session: Record<string, unknown>): void { this.tables.session = clone(session); this.persist(); this.changed(); }

  /** Issues a policy for an activity. Revisions must increase; the host is the only source of policies. */
  setPolicy(activityId: string, policy: HostPolicy): HostPolicy {
    const checked = validateRecord(CONTRACTS.policy, policy);
    if (!checked.ok) throw new Error(`Fixture policy is invalid: ${JSON.stringify(checked.diagnostics)}`);
    const current = this.tables.policies[activityId];
    if (current && policy.revision <= current.revision) throw new RangeError('A new policy needs a higher revision.');
    this.tables.policies[activityId] = clone(policy);
    const table = this.tables.activities[activityId];
    if (table) this.observePolicy(table, policy);
    this.persist();
    this.changed();
    return clone(policy);
  }
  /** Records host-owned response text and returns the reference the activity receives. */
  recordResponse(input: { activityId: string; kind: ResponseRef['kind']; stageId: string; taskId: string; text: string }): Omit<ResponseRef, 'status'> {
    const ref: Omit<ResponseRef, 'status'> = { responseId: this.id('resp'), taskId: input.taskId, taskRevision: 1, kind: input.kind, modality: 'text', stageId: input.stageId };
    this.tables.responses.push({ ref, activityId: input.activityId, text: input.text.slice(0, 4000), recordedAt: this.timestamp(), snapshotCursor: null });
    this.persist();
    this.changed();
    return clone(ref);
  }
  /** Rolls back a response the activity refused to reference (the host transaction did not complete). */
  discardResponse(responseId: string): void {
    this.tables.responses = this.tables.responses.filter(entry => entry.ref.responseId !== responseId);
    this.persist();
    this.changed();
  }
  /** Binds a frozen assistance snapshot cursor to a submitted answer (host-side record). */
  bindSnapshot(responseId: string, cursor: number): void {
    const entry = this.tables.responses.find(item => item.ref.responseId === responseId);
    if (entry) { entry.snapshotCursor = cursor; this.persist(); this.changed(); }
  }
  /** Advances the host session revision after the activity accepted a response reference (host transaction). */
  advanceHostSession(to: number): void { if (to > this.tables.hostSessionRevision) { this.tables.hostSessionRevision = to; this.persist(); this.changed(); } }
  /** Next host-unique ID with a prefix (operation and response IDs). */
  id(prefix: string): string { this.tables.counter++; return `${prefix}-${this.tables.nonce}-${this.tables.counter}`; }
  /** Erases the fixture session from storage (the page reloads afterwards). */
  clear(): void { this.storage?.removeItem(FIXTURE_STORAGE_KEY); this.tables = emptyTables(); }
  /**
   * Stops this host instance without a crash record, for an in-page host restart: later calls stay unanswered (like a
   * terminated process) and nothing more is written, so a late call of the old adapter cannot overwrite the tables a
   * new instance loaded. The new instance applies the restart rule when it loads the persisted tables.
   */
  terminate(): void { this.stopped = true; this.armed = null; }

  // -------------------------------------------------------------------------------------------
  // HostPort
  // -------------------------------------------------------------------------------------------
  getPolicy(request: { activityId: string }): Promise<HostPolicy> {
    return this.call('getPolicy', request, () => clone(this.tables.policies[request.activityId] ?? reject('NOT_FOUND', 'The host has no policy for this activity.')));
  }

  registerActivity(request: { instance: ActivityInstance; operationId: string }): Promise<HostAck> {
    return this.call('registerActivity', request, () => {
      const existing = this.tables.activities[request.instance.activityId];
      if (existing) {
        if (!sameRef(existing.instance.template, request.instance.template) || !sameRef(existing.instance.model, request.instance.model)) reject('CONFLICT', 'The activity is registered with another template or model.');
        if (!existing.registrations.includes(request.operationId)) existing.registrations.push(request.operationId);
        existing.instance = clone(request.instance);
      } else {
        const table: ActivityTable = {
          instance: clone(request.instance), activityRevision: request.instance.activityRevision, stage: request.instance.stage.id, registrations: [request.operationId],
          events: [], eventDigests: {}, exposures: [], receipts: [], idempotency: {}, displayAcks: {}, checkpointDigest: null,
          lineage: { context: { kind: 'instructional' }, fromActivityRevision: 0 }, independentTask: null,
        };
        const policy = this.tables.policies[request.instance.activityId];
        if (policy) this.observePolicy(table, policy);
        this.tables.activities[request.instance.activityId] = table;
      }
      return this.ack();
    });
  }

  requestStageTransition(request: StageTransitionRequest): Promise<StageReceipt> {
    return this.call('requestStageTransition', request, () => this.authorize('requestStageTransition', request, request.groups.length > 0, table => {
      if (request.fromStage !== table.stage) reject('STALE_ACTIVITY_REVISION', 'The activity is not in the requested source stage.');
      const grant = request.groups.length ? this.grant('stage', request.groups) : null;
      const receipt: StageReceipt = { ...this.receiptBase(request, table), contract: CONTRACTS.stageReceipt, fromStage: request.fromStage, toStage: request.toStage, grant };
      table.stage = request.toStage;
      table.stageReceiptId = receipt.receiptId;
      if (grant) this.recordGrant(table, receipt, grant, request.toStage);
      return receipt;
    }));
  }

  recordExposureIntent(request: ExposureIntentRequest): Promise<ExposureReceipt> {
    return this.call('recordExposureIntent', request, () => this.authorize('recordExposureIntent', request, request.scope !== 'exploration', table => {
      const grant = this.grant(request.scope, request.groups, request.parameterDomain);
      const receipt: ExposureReceipt = { ...this.receiptBase(request, table), contract: CONTRACTS.exposureReceipt, grant, intendedStage: request.intendedStage };
      this.recordGrant(table, receipt, grant, request.intendedStage);
      return receipt;
    }));
  }

  recordAssistance(request: AssistanceRequest): Promise<AssistanceReceipt> {
    return this.call('recordAssistance', request, () => this.authorize('recordAssistance', request, request.groups.length > 0, table => {
      const grant = request.groups.length ? this.grant('reveal', request.groups) : null;
      const receipt: AssistanceReceipt = { ...this.receiptBase(request, table), contract: CONTRACTS.assistanceReceipt, kind: request.kind, grant };
      if (grant) this.recordGrant(table, receipt, grant, table.stage);
      // The host recorded the reopening: a new instructional lineage starts with this receipt (its own grant counts).
      if (request.kind === 'reopen-instructional') table.lineage = { context: { kind: 'instructional' }, fromActivityRevision: receipt.activityRevision };
      return receipt;
    }));
  }

  recordDisplayAck(request: DisplayAckRequest): Promise<HostAck> {
    return this.call('recordDisplayAck', request, () => {
      const table = this.table(request.activityId);
      const exposure = table.exposures.find(item => item.exposureId === request.exposureId) ?? reject('NOT_FOUND', 'Unknown exposure.');
      if (exposure.receiptId !== request.receiptId) reject('RECEIPT_MISMATCH', 'The receipt does not belong to this exposure.');
      const identity = digest(request);
      const previous = table.displayAcks[request.exposureId];
      if (previous !== undefined) return previous === identity ? this.ack() : reject('OPERATION_CONFLICT', 'A different display acknowledgement was already recorded.');
      if (exposure.scope !== 'exploration') this.crashPoint('after-display');
      table.displayAcks[request.exposureId] = identity;
      exposure.displayStatus = 'displayed';
      exposure.displayed = { projectionDigest: request.projectionDigest, frameId: request.frameId, monotonicMs: request.monotonicMs };
      delete exposure.uncertainty;
      return this.ack();
    });
  }

  appendEvents(request: { activityId: string; events: InteractionEvent[] }): Promise<AppendResult> {
    return this.call('appendEvents', request, () => {
      const table = this.table(request.activityId);
      // The whole batch is validated before any of it is committed (one transaction).
      let last = table.events.at(-1)?.sequence ?? 0;
      const fresh: InteractionEvent[] = [], duplicates: string[] = [];
      for (const event of request.events) {
        if (event.activityId !== request.activityId) reject('INVALID_INPUT', 'An event belongs to another activity.');
        const identity = digest(event);
        const known = table.eventDigests[event.eventId];
        if (known !== undefined) {
          if (known !== identity) reject('CONFLICT', 'A different event with this eventId is already journaled.');
          duplicates.push(event.eventId);
          continue;
        }
        if (fresh.some(item => item.eventId === event.eventId)) reject('CONFLICT', 'The batch repeats an eventId.');
        if (event.sequence !== last + 1) reject('CONFLICT', 'The event sequence is not the next journal sequence.');
        last = event.sequence;
        fresh.push(event);
      }
      const hostTimestamp = this.timestamp();
      for (const event of fresh) { table.events.push(clone(event)); table.eventDigests[event.eventId] = digest(event); }
      return { acknowledged: fresh.map(event => ({ eventId: event.eventId, durableSequence: event.sequence, hostTimestamp })), duplicates, cursor: this.cursor(request.activityId) };
    });
  }

  getJournalCursor(request: { activityId: string }): Promise<JournalCursor> {
    return this.call('getJournalCursor', request, () => { this.table(request.activityId); return this.cursor(request.activityId); });
  }

  /**
   * The host's exposure rows, assistance receipts and its own activity state — stage, activity revision, whether the
   * activity was closed (a journaled `activity.closed`) and its context lineage — (optional HostPort read): a restore
   * adopts the host's stage and revision, counts a saved grant only when these rows hold it and the lineage counts it,
   * and merges the rest conservatively.
   */
  getActivityRecords(request: { activityId: string }): Promise<ActivityRecords> {
    return this.call('getActivityRecords', request, () => {
      const table = this.table(request.activityId);
      const last = table.events.at(-1)?.sequence ?? 0;
      const assistance = table.receipts.filter((receipt): receipt is AssistanceReceipt => receipt.contract === CONTRACTS.assistanceReceipt).map(receipt => ({
        receiptId: receipt.receiptId, kind: receipt.kind,
        // The journal sequence of its assistance.recorded event, or the journal's end as an upper bound when not journaled.
        sequence: table.events.find(event => event.type === 'assistance.recorded' && event.payload.receiptId === receipt.receiptId)?.sequence ?? Math.max(1, last),
        grant: receipt.grant ? { exposureId: receipt.grant.exposureId, groups: receipt.grant.groups.map(group => group.groupId) } : null,
      }));
      const lineage: HostContextLineage = clone(table.lineage ?? { context: { kind: 'instructional' }, fromActivityRevision: 0 });
      const activity = {
        stage: table.stage, activityRevision: table.activityRevision, closed: table.events.some(event => event.type === 'activity.closed'), lineage,
        ...(table.stageReceiptId ? { stageReceiptId: table.stageReceiptId } : {}),
      };
      return { activityId: request.activityId, exposures: clone(table.exposures), assistance, activity };
    });
  }

  saveArtifact(request: { artifact: ActivityArtifact; operationId: string }): Promise<HostAck & { artifactDigest: string }> {
    return this.call('saveArtifact', request, () => {
      const artifact = request.artifact;
      const checked = validateRecord(CONTRACTS.artifact, artifact);
      if (!checked.ok) reject('SCHEMA', 'The artifact does not match its schema.');
      const artifactDigestValue = artifactDigest(artifact);
      const previous = this.tables.artifactOperations[request.operationId];
      if (previous !== undefined && previous !== artifactDigestValue) reject('OPERATION_CONFLICT', 'The operation already saved a different artifact.');
      const stored = this.tables.artifacts.find(entry => entry.artifactId === artifact.artifactId);
      if (stored && stored.digest !== artifactDigestValue) reject('CONFLICT', 'A different artifact with this artifactId is stored.');
      const activityId = artifact.instance.activityId;
      if (!stored) {
        this.tables.artifacts.push({ artifactId: artifact.artifactId, activityId, kind: artifact.kind, digest: artifactDigestValue, operationId: request.operationId, savedAt: this.timestamp(), artifact: clone(artifact) });
        // Bounded retention: the oldest artifacts of the same activity and kind are dropped first.
        const same = this.tables.artifacts.filter(entry => entry.activityId === activityId && entry.kind === artifact.kind);
        const drop = new Set(same.slice(0, Math.max(0, same.length - this.keep)).map(entry => entry.artifactId));
        this.tables.artifacts = this.tables.artifacts.filter(entry => !drop.has(entry.artifactId));
      }
      this.tables.artifactOperations[request.operationId] = artifactDigestValue;
      if (artifact.kind === 'backup') {
        this.tables.latestBackup[activityId] = artifact.artifactId;
        const table = this.tables.activities[activityId];
        if (table) table.checkpointDigest = artifactDigestValue;
      }
      return { ...this.ack(), artifactDigest: artifactDigestValue };
    });
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------
  private async call<T>(method: HostMethod, request: unknown, run: () => T): Promise<T> {
    const points = pointsOf(method, request);
    const record = (outcome: CallRecord['outcome'], point: InjectionPoint | null = null) => {
      this.log.push({ method, outcome, point, at: new Date(this.tables.clockMs).toISOString() });
      if (this.log.length > CALL_LOG_LIMIT) this.log.shift();
    };
    if (this.crashed || this.stopped) return new Promise<T>(() => undefined);
    const delay = Math.max(0, ...points.map(point => this.delays.get(point) ?? 0));
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    if (this.crashed || this.stopped) return new Promise<T>(() => undefined);
    const failing = points.find(point => (this.fails.get(point) ?? 0) > 0);
    if (failing) {
      const left = this.fails.get(failing)! - 1;
      if (left > 0) this.fails.set(failing, left); else this.fails.delete(failing);
      record('failed', failing);
      this.changed();
      throw new FixtureHostError('failed', `${method} failed before commit (fixture injection).`);
    }
    const checked = validateRecord(REQUEST_SCHEMA[method], request);
    if (!checked.ok) { record('rejected'); throw new FixtureHostError('rejected', `${method} request does not match its schema.`, 'SCHEMA'); }
    // Each call is one transaction: on a rejection or a failed write the tables reload from the last persisted state.
    let result: T;
    try {
      result = run();
      this.persist();
    } catch (error) {
      if (error instanceof CrashSignal) { record('crashed'); return this.crash(error.point, method); }
      this.reload();
      if (error instanceof FixtureHostError) { record(error.kind === 'refused' ? 'refused' : 'rejected'); this.changed(); throw error; }
      record('failed');
      this.changed();
      throw new FixtureHostError('failed', `${method} could not be written to host storage (${error instanceof Error ? error.name : 'error'}).`);
    }
    if (this.armed === 'after-intent' && points.includes('exposure-intent')) {
      record('crashed');
      return this.crash('after-intent', method);
    }
    record('ok');
    this.changed();
    const lag = Math.max(0, ...points.map(point => this.lags.get(point) ?? 0));
    if (lag) await new Promise(resolve => setTimeout(resolve, lag));
    if (this.crashed || this.stopped) return new Promise<T>(() => undefined);
    return clone(result);
  }

  /** Shared receipt path: idempotency, policy and revision checks, then the commit performed by `issue`. */
  private authorize<T extends Receipt>(method: HostMethod, request: StageTransitionRequest | ExposureIntentRequest | AssistanceRequest, reveals: boolean, issue: (table: ActivityTable) => T): T {
    const table = this.table(request.activityId);
    const identity = digest(request);
    const previous = table.idempotency[request.idempotencyKey];
    if (previous) {
      if (previous.method !== method || previous.request !== identity) reject('OPERATION_CONFLICT', 'The idempotency key was used for a different request.');
      return clone(table.receipts.find(receipt => receipt.receiptId === previous.receiptId) as T);
    }
    const policy = this.tables.policies[request.activityId] ?? refuse('POLICY_DENIED', 'The host has no policy for this activity.');
    if (policy.revoked) refuse('POLICY_DENIED', 'The host policy is revoked.');
    if (policy.expiresAt !== null && Date.parse(policy.expiresAt) <= this.tables.clockMs) refuse('POLICY_EXPIRED', 'The host policy has expired.');
    if (request.expectedPolicyRevision !== policy.revision) refuse('STALE_POLICY_REVISION', 'The request is based on another policy revision.');
    if (request.basedOnActivityRevision !== table.activityRevision) reject('STALE_ACTIVITY_REVISION', 'The request is based on another activity revision.');
    if (!sameRef(request.template, table.instance.template) || !sameRef(request.model, table.instance.model)) reject('INVALID_REFERENCE', 'The request names another template or model.');
    if (table.instance.mode === 'approved' && !policy.approved.some(entry => sameRef(entry.template, request.template) && sameRef(entry.model, request.model))) {
      refuse('POLICY_DENIED', 'The template and model are not approved by the host policy.');
    }
    if (reveals) this.crashPoint('before-intent');
    const receipt = issue(table);
    table.activityRevision = receipt.activityRevision;
    table.receipts.push(clone(receipt));
    table.idempotency[request.idempotencyKey] = { method, request: identity, receiptId: receipt.receiptId };
    return receipt;
  }
  /** Throws the crash signal when `point` is armed; `call` then terminates the host without committing. */
  private crashPoint(point: CrashPoint): void {
    if (this.armed !== point) return;
    throw new CrashSignal(point);
  }
  /** Terminates the host: the crash is recorded durably, nothing else of the interrupted call is committed. */
  private crash<T>(point: CrashPoint, method: HostMethod): Promise<T> {
    this.reloadIfUncommitted(point);
    this.armed = null;
    this.crashed = true;
    this.tables.crash.fired.push(point);
    this.tables.crash.last = { point, method, at: this.timestamp() };
    this.persist();
    queueMicrotask(() => this.options.onCrash?.(point));
    return new Promise<T>(() => undefined);
  }
  /** A crash before a commit discards the call's in-memory changes; after-intent keeps the committed intent. */
  private reloadIfUncommitted(point: CrashPoint): void { if (point !== 'after-intent') this.reload(); }

  private receiptBase(request: StageTransitionRequest | ExposureIntentRequest | AssistanceRequest, table: ActivityTable) {
    const policy = this.tables.policies[request.activityId]!;
    return {
      schemaVersion: '1.0' as const, receiptId: this.id('rcpt'), activityId: request.activityId, basedOnActivityRevision: request.basedOnActivityRevision,
      activityRevision: table.activityRevision + 1, policyId: policy.policyId, policyRevision: policy.revision, idempotencyKey: request.idempotencyKey,
      template: clone(request.template), model: clone(request.model), issuedAt: this.timestamp(), expiresAt: null,
    };
  }
  private grant(scope: ExposureGrant['scope'], groups: ExposureGrant['groups'], parameterDomain?: ExposureGrant['parameterDomain']): ExposureGrant {
    return { exposureId: this.id('exp'), scope, groups: clone(groups), ...(parameterDomain ? { parameterDomain: clone(parameterDomain) } : {}) };
  }
  private recordGrant(table: ActivityTable, receipt: Receipt, grant: ExposureGrant, intendedStage: string): void {
    table.exposures.push({
      contract: CONTRACTS.exposure, schemaVersion: '1.0', exposureId: grant.exposureId, activityId: receipt.activityId, receiptId: receipt.receiptId, scope: grant.scope,
      groups: clone(grant.groups), template: clone(receipt.template), model: clone(receipt.model), activityRevision: receipt.activityRevision, intendedStage,
      ...(grant.parameterDomain ? { parameterDomain: clone(grant.parameterDomain) } : {}), displayStatus: 'authorized',
    });
  }
  /** Host restart rule: authorized without a persisted display acknowledgement → uncertain (potentially seen). */
  private applyRestartRule(): void {
    for (const table of Object.values(this.tables.activities)) {
      for (const exposure of table.exposures) {
        if (exposure.displayStatus !== 'authorized' || table.displayAcks[exposure.exposureId]) continue;
        exposure.displayStatus = 'uncertain';
        exposure.uncertainty = { code: 'INTERRUPTED_BEFORE_ACK', reason: 'The host restarted after authorizing this content and before a display acknowledgement was persisted; it is treated as potentially seen.' };
        this.tables.recoveries.push({ activityId: exposure.activityId, exposureId: exposure.exposureId, from: 'authorized', to: 'uncertain', start: this.tables.starts, at: this.timestamp() });
      }
    }
  }
  private table(activityId: string): ActivityTable {
    return this.tables.activities[activityId] ?? reject('NOT_FOUND', 'The activity is not registered with the host.');
  }
  /**
   * A policy the host issued for an activity: activating an independent task (one the previous policy did not have
   * active) starts an independent lineage after the current activity revision, so every earlier grant has ended.
   */
  private observePolicy(table: ActivityTable, policy: HostPolicy): void {
    const task = policy.independentTask.active ? policy.independentTask.taskRef : null;
    if (task !== null && task !== (table.independentTask ?? null)) table.lineage = { context: { kind: 'independent', taskRef: task }, fromActivityRevision: table.activityRevision + 1 };
    table.independentTask = task;
  }
  private cursor(activityId: string): JournalCursor {
    const table = this.table(activityId), last = table.events.at(-1);
    return { activityId, lastSequence: last?.sequence ?? 0, lastEventId: last?.eventId ?? null, checkpointDigest: table.checkpointDigest };
  }
  private ack(): HostAck { return { ok: true, hostTimestamp: this.timestamp() }; }
  private timestamp(): string { this.tables.clockMs = Math.max(Date.now(), this.tables.clockMs + 1); return new Date(this.tables.clockMs).toISOString(); }
  private changed(): void { try { this.options.onChange?.(); } catch { /* The page panel cannot affect host state. */ } }

  private load(): FixtureTables | null {
    try {
      const text = this.storage?.getItem(FIXTURE_STORAGE_KEY);
      if (!text) return null;
      const parsed = JSON.parse(text) as FixtureTables;
      if (!parsed || parsed.version !== TABLES_VERSION) return null;
      parsed.recoveries ??= [];
      return parsed;
    } catch { return null; }
  }
  private reload(): void { this.tables = this.load() ?? this.tables; }
  /** Writes the tables; a quota failure propagates so the caller's transaction is rolled back. */
  private persist(): void { if (!this.stopped) this.storage?.setItem(FIXTURE_STORAGE_KEY, JSON.stringify(this.tables)); }
}
