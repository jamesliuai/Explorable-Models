/**
 * TEST-ONLY HostPort double. It is never exported from a package, is not a reference host and proves nothing about
 * the Study Harness host: it models the host contract (durable tables, idempotency by key and eventId, policy
 * revisions, receipts that echo the request's digests and revisions) with failure, delay and crash injection so
 * runtime tests can drive recovery paths deterministically. Results labelled with it are fixture-host results.
 */
import { canonicalJSON, sha256 } from '../../../packages/core/src/identity.js';
import {
  CONTRACTS, HOST_REFUSAL_CODES, type ActivityArtifact, type ActivityInstance, type ActivityRecords, type AppendResult, type AssistanceReceipt, type AssistanceRequest, type DiagnosticCode,
  type DisplayAckRequest, type ExposureGrant, type ExposureIntentRequest, type ExposureReceipt, type ExposureRecord, type HostAck, type HostPolicy,
  type HostContextLineage, type HostPort, type HostRefusalCode, type InteractionEvent, type JournalCursor, type StageReceipt, type StageTransitionRequest,
} from '../../../packages/activity/src/contracts.js';
import { artifactDigest } from '../../../packages/activity/src/identity.js';
import { MESSAGES, type SchemaName } from '../../../packages/activity/src/schemas.js';
import { validateRecord } from '../../../packages/activity/src/validator.js';

export type HostMethod = keyof HostPort;
export type FailureKind = 'reject' | 'throw' | 'timeout' | 'disconnect-after-commit';
export type CrashPoint = 'before-intent-commit' | 'after-intent-commit-before-reply' | 'before-ack-commit' | 'after-ack-commit-before-reply';
/**
 * How the caller observed the failure. `committed` says whether the host durably applied the request first. `refused`
 * is a host refusal under the HostPort convention (activity-runtime §10): a policy decision with a refusal code, never
 * retried by the adapter; `rejected` is any other refusal of the request itself.
 */
export type HostErrorKind = 'refused' | 'rejected' | 'failed' | 'timeout' | 'disconnected' | 'crashed';

/** Error thrown by the double. `code` is set only for host refusals and rejections (the request itself was refused). */
export class MemoryHostError extends Error {
  readonly kind: HostErrorKind;
  readonly code: DiagnosticCode | undefined;
  readonly committed: boolean;
  /** The specific host code behind a refusal reported under the convention code (`conformant` profile). */
  readonly reason: DiagnosticCode | undefined;
  constructor(kind: HostErrorKind, message: string, options: { code?: DiagnosticCode; committed?: boolean; reason?: DiagnosticCode } = {}) {
    super(message);
    this.name = 'MemoryHostError';
    this.kind = kind;
    this.code = options.code;
    this.committed = options.committed ?? false;
    this.reason = options.reason;
  }
}

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
  /** idempotencyKey → { method, request digest, receiptId } */
  idempotency: Record<string, { method: HostMethod; request: string; receiptId: string }>;
  displayAcks: Record<string, string>;
  checkpointDigest: string | null;
  /**
   * The context lineage the host holds (`ActivityRecords.activity.lineage`): independent from the host's activation of an
   * independent task until it records a `reopen-instructional` assistance. Derived only from host decisions (policies it
   * issued, receipts it committed), never from a registered instance or adapter-written events.
   */
  lineage?: HostContextLineage;
  /** The active independent task of the last policy the host issued for the activity (null when none is active). */
  independentTask?: string | null;
  /** The receipt that moved the activity to its current stage (`ActivityRecords.activity.stageReceiptId`). */
  stageReceiptId?: string;
}
/** Durable state; survives a crash and is what {@link MemoryHost.restoreInto} copies. JSON-compatible. */
export interface MemoryHostSnapshot {
  policy: HostPolicy;
  activities: Record<string, ActivityTable>;
  artifacts: Record<string, { artifact: ActivityArtifact; digest: string; operationId: string }>;
  artifactOperations: Record<string, string>;
  counter: number;
  clockMs: number;
  /** Per-activity policies (`setActivityPolicy`); an activity without one uses `policy`. */
  activityPolicies?: Record<string, HostPolicy>;
  /** Host session revision per activity (`conformant` profile; advanced only by `respond`). */
  sessions?: Record<string, number>;
}
export interface MemoryHostOptions {
  policy: HostPolicy;
  /** Epoch milliseconds of the host clock; each timestamp read advances it by 1 ms (deterministic). */
  clockMs?: number;
  /** Receipt lifetime; null receipts never expire. */
  receiptTtlMs?: number | null;
  scheduler?: { setTimeout(callback: () => void, ms: number): unknown };
  /**
   * `test-double` (default): the behaviour the runtime tests rely on. `conformant`: the profile the HostPort
   * conformance kit (`@explorable-models/activity/conformance`) is run against — every decision against a request is
   * reported under the refusal convention (`INVALID_INPUT` with the specific code as `reason`, as the reference host
   * does), a registration claiming a host session revision the host never produced is refused, and a grant outside the
   * activity's policy ceiling, or for anything but the neutral scaffold in an independent task, is refused
   * (`POLICY_DENIED`).
   */
  profile?: 'test-double' | 'conformant';
}
export interface CallRecord { method: HostMethod; request: unknown; outcome: 'ok' | HostErrorKind | 'hung' }

const clone = <T>(value: T): T => structuredClone(value);
const digestOf = (value: unknown): string => 'sha256:' + sha256(canonicalJSON(value));
const reject = (code: DiagnosticCode, message: string): never => { throw new MemoryHostError('rejected', message, { code }); };
/** Policy refusal (HostPort convention): the error carries one of `HOST_REFUSAL_CODES`, so the adapter reports it as such. */
const refuse = (code: HostRefusalCode, message: string): never => { throw new MemoryHostError('refused', message, { code }); };
const REQUEST_SCHEMA: Record<HostMethod, SchemaName> = {
  getPolicy: MESSAGES.activityLookupRequest, registerActivity: MESSAGES.registerActivityRequest, requestStageTransition: MESSAGES.stageTransitionRequest,
  recordExposureIntent: MESSAGES.exposureIntentRequest, recordDisplayAck: MESSAGES.displayAckRequest, recordAssistance: MESSAGES.assistanceRequest,
  appendEvents: MESSAGES.appendEventsRequest, getJournalCursor: MESSAGES.activityLookupRequest, saveArtifact: MESSAGES.saveArtifactRequest,
  getActivityRecords: MESSAGES.activityLookupRequest,
};

/** In-memory host. Construct with a policy; drive it with failNext/delay/crashAt; inspect with events()/exposures()/receipts(). */
export class MemoryHost implements HostPort {
  /**
   * Profile of hosts constructed without one. Suites that must hold against a host following the refusal convention set
   * it to `conformant` before they are loaded (`tests/activity/conformant-profile.test.ts`).
   */
  static defaultProfile: 'test-double' | 'conformant' = 'test-double';
  private state: MemoryHostSnapshot;
  private readonly failures = new Map<HostMethod, { kind: FailureKind; code?: DiagnosticCode }[]>();
  private readonly delays = new Map<HostMethod, number>();
  private readonly gates = new Map<HostMethod, { opened: Promise<void>; open: () => void; waiting: number; done: Promise<unknown>[] }>();
  private readonly hung: { method: HostMethod; reject: (error: unknown) => void }[] = [];
  private readonly log: CallRecord[] = [];
  private readonly scheduler: { setTimeout(callback: () => void, ms: number): unknown };
  private readonly receiptTtlMs: number | null;
  private readonly profile: 'test-double' | 'conformant';
  private armed: CrashPoint | null = null;
  /** True after a crash point fired: every call fails until the durable state is restored into a new host. */
  crashed = false;
  /** When true, `getActivityRecords` omits the host's activity state (a host written before that field existed). */
  withholdActivity = false;
  /** When true, `getActivityRecords` reports the host's stage, revision and closure but not its context lineage. */
  withholdLineage = false;

  constructor(options: MemoryHostOptions) {
    const checked = validateRecord(CONTRACTS.policy, options.policy);
    if (!checked.ok) throw new Error(`MemoryHost policy is invalid: ${JSON.stringify(checked.diagnostics)}`);
    this.state = { policy: clone(options.policy), activities: {}, artifacts: {}, artifactOperations: {}, counter: 0, clockMs: options.clockMs ?? Date.UTC(2026, 9, 26, 9, 0, 0) };
    this.scheduler = options.scheduler ?? { setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms) };
    this.receiptTtlMs = options.receiptTtlMs ?? null;
    this.profile = options.profile ?? MemoryHost.defaultProfile;
  }

  // -------------------------------------------------------------------------------------------
  // Injection and inspection
  // -------------------------------------------------------------------------------------------
  /** Queues one failure for the next call of `method` (`times` consecutive calls). `reject` defaults to code INVALID_INPUT. */
  failNext(method: HostMethod, kind: FailureKind, options: { code?: DiagnosticCode; times?: number } = {}): this {
    const queue = this.failures.get(method) ?? [];
    for (let index = 0; index < (options.times ?? 1); index++) queue.push({ kind, ...(options.code ? { code: options.code } : {}) });
    this.failures.set(method, queue);
    return this;
  }
  /** Every later call of `method` waits `ms` on the host scheduler before it is processed; 0 clears. */
  delay(method: HostMethod, ms: number): this { if (ms > 0) this.delays.set(method, ms); else this.delays.delete(method); return this; }
  /**
   * Holds every later call of `method` before it is processed, until {@link release}: an explicit gate for ordering
   * tests (a crash before a reply, a save while a call is outstanding) that must not depend on wall-clock delays.
   */
  hold(method: HostMethod): this {
    if (!this.gates.has(method)) {
      let open!: () => void;
      const opened = new Promise<void>(resolve => { open = resolve; });
      this.gates.set(method, { opened, open, waiting: 0, done: [] });
    }
    return this;
  }
  /** Calls of `method` currently held at its gate. */
  waiting(method: HostMethod): number { return this.gates.get(method)?.waiting ?? 0; }
  /** Opens the gate of `method`; resolves once every call that was held has been processed (replied or failed). */
  async release(method: HostMethod): Promise<void> {
    const gate = this.gates.get(method);
    if (!gate) return;
    this.gates.delete(method);
    gate.open();
    await Promise.all(gate.done);
  }
  /** Arms one crash at a protocol point (exposure intent, stage or assistance receipt; display acknowledgement). */
  crashAt(point: CrashPoint): this { this.armed = point; return this; }
  /** Rejects every call left hanging by a `timeout` failure. */
  releaseHung(): number {
    const calls = this.hung.splice(0);
    for (const call of calls) call.reject(new MemoryHostError('timeout', `${call.method} timed out without a reply.`));
    return calls.length;
  }
  /** Replaces the current policy exactly as given (activities without a policy of their own follow it). */
  setPolicy(policy: HostPolicy): void {
    const checked = validateRecord(CONTRACTS.policy, policy);
    if (!checked.ok) throw new Error(`MemoryHost policy is invalid: ${JSON.stringify(checked.diagnostics)}`);
    this.state.policy = clone(policy);
    for (const [activityId, table] of Object.entries(this.state.activities)) if (!this.state.activityPolicies?.[activityId]) this.observePolicy(table, policy);
  }
  /** Issues the next policy revision with `patch` applied. */
  amendPolicy(patch: Partial<Omit<HostPolicy, 'contract' | 'schemaVersion' | 'revision'>>): HostPolicy {
    this.setPolicy({ ...this.state.policy, ...clone(patch), revision: this.state.policy.revision + 1, issuedAt: this.timestamp() });
    return this.policy();
  }
  /** Issues the next policy revision with `revoked: true`. */
  revokePolicy(): HostPolicy { return this.amendPolicy({ revoked: true }); }
  /** Sets the policy of one activity (as a host issues per-activity policies); `getPolicy` and receipts then use it. */
  setActivityPolicy(activityId: string, policy: HostPolicy): void {
    const checked = validateRecord(CONTRACTS.policy, policy);
    if (!checked.ok) throw new Error(`MemoryHost policy is invalid: ${JSON.stringify(checked.diagnostics)}`);
    (this.state.activityPolicies ??= {})[activityId] = clone(policy);
    const table = this.state.activities[activityId];
    if (table) this.observePolicy(table, policy);
  }
  /** Issues the next revision of one activity's policy with `patch(current)` applied. */
  amendActivityPolicy(activityId: string, patch: (current: HostPolicy) => Partial<Omit<HostPolicy, 'contract' | 'schemaVersion' | 'revision'>>): HostPolicy {
    const current = this.policyOf(activityId);
    this.setActivityPolicy(activityId, { ...current, ...clone(patch(clone(current))), revision: current.revision + 1, issuedAt: this.timestamp() });
    return clone(this.policyOf(activityId));
  }
  /**
   * The host's response transaction (`conformant` profile): advances the activity's host session revision and returns
   * the revision it expected and the one it produced.
   */
  respond(activityId: string): { expected: number; produced: number } {
    const sessions = this.state.sessions ??= {};
    const expected = sessions[activityId] ?? this.table(activityId).instance.hostSessionRevision;
    sessions[activityId] = expected + 1;
    return { expected, produced: expected + 1 };
  }
  /** The host session revision the host holds for an activity. */
  hostSessionRevision(activityId: string): number { return this.state.sessions?.[activityId] ?? this.table(activityId).instance.hostSessionRevision; }
  /** Advances the host clock (for expiry checks). */
  advanceClock(ms: number): void { this.state.clockMs += ms; }

  policy(): HostPolicy { return clone(this.state.policy); }
  events(activityId?: string): InteractionEvent[] { return clone(this.tables(activityId).flatMap(table => table.events)); }
  exposures(activityId?: string): ExposureRecord[] { return clone(this.tables(activityId).flatMap(table => table.exposures)); }
  receipts(activityId?: string): Receipt[] { return clone(this.tables(activityId).flatMap(table => table.receipts)); }
  artifacts(): ActivityArtifact[] { return clone(Object.values(this.state.artifacts).map(entry => entry.artifact)); }
  calls(method?: HostMethod): CallRecord[] { return clone(this.log.filter(call => !method || call.method === method)); }
  /** Host-owned activity revision and stage. */
  activity(activityId: string): { activityRevision: number; stage: string } | null {
    const table = this.state.activities[activityId];
    return table ? { activityRevision: table.activityRevision, stage: table.stage } : null;
  }
  /** Deep copy of the durable tables (what a restart keeps). */
  snapshot(): MemoryHostSnapshot { return clone(this.state); }
  /** Loads this host's durable tables into `target` (simulated restart: injections, hung calls and crash state are not carried). */
  restoreInto(target: MemoryHost): MemoryHost { target.state = this.snapshot(); return target; }
  /**
   * The host restart rule (activity-runtime §4.6, the reference host's `mark_unacknowledged_uncertain`): every exposure
   * authorized without a committed display acknowledgement becomes `uncertain` (`INTERRUPTED_BEFORE_ACK`). Returns the
   * changed exposure IDs. A later acknowledgement still records the display (uncertain → displayed, never unseen).
   */
  interruptUnacknowledged(): string[] {
    const changed: string[] = [];
    for (const table of Object.values(this.state.activities)) {
      for (const exposure of table.exposures) {
        if (exposure.displayStatus !== 'authorized' || table.displayAcks[exposure.exposureId] !== undefined) continue;
        exposure.displayStatus = 'uncertain';
        exposure.uncertainty = { code: 'INTERRUPTED_BEFORE_ACK', reason: 'The host restarted after authorizing this content and before a display acknowledgement was committed.' };
        changed.push(exposure.exposureId);
      }
    }
    return changed;
  }
  /** Starts a host from durable tables only (for example a portable backup imported into an empty store). */
  static fromSnapshot(snapshot: MemoryHostSnapshot, options: Omit<MemoryHostOptions, 'policy'> = {}): MemoryHost {
    const host = new MemoryHost({ ...options, policy: snapshot.policy });
    host.state = clone(snapshot);
    return host;
  }

  // -------------------------------------------------------------------------------------------
  // HostPort
  // -------------------------------------------------------------------------------------------
  getPolicy(request: { activityId: string }) {
    return this.call('getPolicy', request, () => clone(this.policyOf(request.activityId)));
  }

  registerActivity(request: { instance: ActivityInstance; operationId: string }): Promise<HostAck> {
    return this.call('registerActivity', request, () => {
      const existing = this.state.activities[request.instance.activityId];
      if (existing && this.profile === 'conformant' && request.instance.hostSessionRevision > this.hostSessionRevision(request.instance.activityId)) {
        return reject('CONFLICT', 'The instance claims a host session revision the host never produced.');
      }
      if (existing) {
        if (!existing.registrations.includes(request.operationId)) existing.registrations.push(request.operationId);
        existing.instance = clone(request.instance);
        return this.ack();
      }
      const table: ActivityTable = {
        instance: clone(request.instance), activityRevision: request.instance.activityRevision, stage: request.instance.stage.id, registrations: [request.operationId],
        events: [], eventDigests: {}, exposures: [], receipts: [], idempotency: {}, displayAcks: {}, checkpointDigest: null,
        lineage: { context: { kind: 'instructional' }, fromActivityRevision: 0 }, independentTask: null,
      };
      this.observePolicy(table, this.policyOf(request.instance.activityId));
      this.state.activities[request.instance.activityId] = table;
      return this.ack();
    });
  }

  requestStageTransition(request: StageTransitionRequest): Promise<StageReceipt> {
    return this.call('requestStageTransition', request, () => this.authorize('requestStageTransition', request, table => {
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
      // The host recorded the reopening: a new instructional lineage starts with this receipt (its own grant counts).
      if (request.kind === 'reopen-instructional') table.lineage = { context: { kind: 'instructional' }, fromActivityRevision: receipt.activityRevision };
      return receipt;
    }));
  }

  recordDisplayAck(request: DisplayAckRequest): Promise<HostAck> {
    return this.call('recordDisplayAck', request, () => {
      const table = this.table(request.activityId);
      const exposure = table.exposures.find(item => item.exposureId === request.exposureId);
      if (!exposure) return reject('NOT_FOUND', 'Unknown exposure.');
      if (exposure.receiptId !== request.receiptId) return reject('RECEIPT_MISMATCH', 'The receipt does not belong to this exposure.');
      const identity = digestOf(request);
      const previous = table.displayAcks[request.exposureId];
      if (previous !== undefined) return previous === identity ? this.ack() : reject('OPERATION_CONFLICT', 'A different display acknowledgement was already recorded.');
      // The acknowledgement is checked but not yet committed (the reference host's `display-ack-before-commit`).
      this.crashPoint('before-ack-commit', false);
      table.displayAcks[request.exposureId] = identity;
      exposure.displayStatus = 'displayed';
      exposure.displayed = { projectionDigest: request.projectionDigest, frameId: request.frameId, monotonicMs: request.monotonicMs };
      delete exposure.uncertainty;
      this.crashPoint('after-ack-commit-before-reply', true);
      return this.ack();
    });
  }

  appendEvents(request: { activityId: string; events: InteractionEvent[] }): Promise<AppendResult> {
    return this.call('appendEvents', request, () => {
      const table = this.table(request.activityId);
      // Validate the whole batch before committing any of it (one transaction).
      let last = table.events.at(-1)?.sequence ?? 0;
      const fresh: InteractionEvent[] = [], duplicates: string[] = [];
      for (const event of request.events) {
        if (event.activityId !== request.activityId) return reject('INVALID_INPUT', 'An event belongs to another activity.');
        const identity = digestOf(event);
        const known = table.eventDigests[event.eventId];
        if (known !== undefined) {
          if (known !== identity) return reject('CONFLICT', 'A different event with this eventId is already journaled.');
          duplicates.push(event.eventId);
          continue;
        }
        if (fresh.some(item => item.eventId === event.eventId)) return reject('CONFLICT', 'The batch repeats an eventId.');
        if (event.sequence !== last + 1) return reject('CONFLICT', 'The event sequence is not the next journal sequence.');
        last = event.sequence;
        fresh.push(event);
      }
      const hostTimestamp = this.timestamp();
      for (const event of fresh) { table.events.push(clone(event)); table.eventDigests[event.eventId] = digestOf(event); }
      return { acknowledged: fresh.map(event => ({ eventId: event.eventId, durableSequence: event.sequence, hostTimestamp })), duplicates, cursor: this.cursor(request.activityId) };
    });
  }

  getJournalCursor(request: { activityId: string }): Promise<JournalCursor> {
    return this.call('getJournalCursor', request, () => { this.table(request.activityId); return this.cursor(request.activityId); });
  }

  /**
   * The optional HostPort read of the host's durable exposure rows and assistance receipts, and its own activity state
   * (stage, activity revision, closed — from a journaled `activity.closed` — and its context lineage), which a restore
   * adopts. An assistance reference names the journal sequence of its `assistance.recorded` event, or the journal's end
   * when that event is not journaled. `withholdActivity` models a host that predates the activity state (the read omits
   * it); `withholdLineage` one that reports its stage, revision and closure but not its context lineage.
   */
  getActivityRecords(request: { activityId: string }): Promise<ActivityRecords> {
    return this.call('getActivityRecords', request, () => {
      const table = this.table(request.activityId);
      const last = table.events.at(-1)?.sequence ?? 0;
      const assistance = table.receipts.filter((receipt): receipt is AssistanceReceipt => receipt.contract === CONTRACTS.assistanceReceipt).map(receipt => ({
        receiptId: receipt.receiptId, kind: receipt.kind,
        sequence: table.events.find(event => event.type === 'assistance.recorded' && event.payload.receiptId === receipt.receiptId)?.sequence ?? Math.max(1, last),
        grant: receipt.grant ? { exposureId: receipt.grant.exposureId, groups: receipt.grant.groups.map(group => group.groupId) } : null,
      }));
      const lineage = table.lineage ?? { context: { kind: 'instructional' as const }, fromActivityRevision: 0 };
      const activity = {
        stage: table.stage, activityRevision: table.activityRevision, closed: table.events.some(event => event.type === 'activity.closed'),
        ...(this.withholdLineage ? {} : { lineage: clone(lineage) }), ...(table.stageReceiptId ? { stageReceiptId: table.stageReceiptId } : {}),
      };
      return { activityId: request.activityId, exposures: clone(table.exposures), assistance, ...(this.withholdActivity ? {} : { activity }) };
    });
  }

  saveArtifact(request: { artifact: ActivityArtifact; operationId: string }): Promise<HostAck & { artifactDigest: string }> {
    return this.call('saveArtifact', request, () => {
      const digest = artifactDigest(request.artifact);
      const previous = this.state.artifactOperations[request.operationId];
      if (previous !== undefined && previous !== digest) return reject('OPERATION_CONFLICT', 'The operation already saved a different artifact.');
      const stored = this.state.artifacts[request.artifact.artifactId];
      if (stored && stored.digest !== digest) return reject('CONFLICT', 'A different artifact with this artifactId is stored.');
      this.state.artifacts[request.artifact.artifactId] = { artifact: clone(request.artifact), digest, operationId: request.operationId };
      this.state.artifactOperations[request.operationId] = digest;
      const table = this.state.activities[request.artifact.instance.activityId];
      if (table && request.artifact.kind === 'backup') table.checkpointDigest = digest;
      return { ...this.ack(), artifactDigest: digest };
    });
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------
  private call<T>(method: HostMethod, request: unknown, run: () => T): Promise<T> {
    const record: CallRecord = { method, request: clone(request), outcome: 'ok' };
    this.log.push(record);
    const gate = this.gates.get(method);
    if (!gate) return this.process(record, method, request, run);
    gate.waiting++;
    const processed = gate.opened.then(() => { gate.waiting--; return this.process(record, method, request, run); });
    gate.done.push(processed.catch(() => undefined));
    return processed;
  }

  private async process<T>(record: CallRecord, method: HostMethod, request: unknown, run: () => T): Promise<T> {
    const fail = (error: MemoryHostError): never => { record.outcome = error.kind; throw error; };
    if (this.crashed) fail(new MemoryHostError('crashed', 'The host process is not running.'));
    const delay = this.delays.get(method);
    if (delay) await new Promise<void>(resolve => this.scheduler.setTimeout(resolve, delay));
    if (this.crashed) fail(new MemoryHostError('crashed', 'The host process is not running.'));
    const injected = this.failures.get(method)?.shift();
    if (injected?.kind === 'throw') fail(new MemoryHostError('failed', `${method} failed before commit.`));
    if (injected?.kind === 'reject') fail(new MemoryHostError('rejected', `${method} was rejected.`, { code: injected.code ?? 'INVALID_INPUT' }));
    if (injected?.kind === 'timeout') {
      record.outcome = 'hung';
      return new Promise<T>((_, rejectCall) => this.hung.push({ method, reject: rejectCall }));
    }
    const checked = validateRecord(REQUEST_SCHEMA[method], request);
    if (!checked.ok) fail(this.convention(new MemoryHostError('rejected', `${method} request does not match its schema.`, { code: 'SCHEMA' })));
    let result: T;
    try { result = run(); } catch (error) {
      if (error instanceof MemoryHostError) fail(this.convention(error));
      throw error;
    }
    if (injected?.kind === 'disconnect-after-commit') fail(new MemoryHostError('disconnected', `${method} committed but the connection dropped before the reply.`, { committed: true }));
    return clone(result);
  }

  /** `conformant` profile: a decision against the request reported under the refusal convention (code INVALID_INPUT, reason the specific code). */
  private convention(error: MemoryHostError): MemoryHostError {
    if (this.profile !== 'conformant' || error.kind !== 'rejected' || !error.code || (HOST_REFUSAL_CODES as readonly string[]).includes(error.code)) return error;
    return new MemoryHostError('refused', error.message, { code: 'INVALID_INPUT', reason: error.code });
  }
  /** The policy that governs an activity: its own (`setActivityPolicy`) or the host policy. */
  private policyOf(activityId: string): HostPolicy { return this.state.activityPolicies?.[activityId] ?? this.state.policy; }
  /**
   * A policy the host issued for an activity: activating an independent task (one the previous policy did not have
   * active) starts an independent lineage after the current activity revision, so every earlier grant has ended.
   */
  private observePolicy(table: ActivityTable, policy: HostPolicy): void {
    const task = policy.independentTask.active ? policy.independentTask.taskRef : null;
    if (task !== null && task !== (table.independentTask ?? null)) table.lineage = { context: { kind: 'independent', taskRef: task }, fromActivityRevision: table.activityRevision + 1 };
    table.independentTask = task;
  }

  private crashPoint(point: CrashPoint, committed: boolean): void {
    if (this.armed !== point) return;
    this.armed = null;
    this.crashed = true;
    throw new MemoryHostError('crashed', `The host crashed at ${point}.`, { committed });
  }

  /** Shared receipt path: idempotency, policy and revision checks, then the commit performed by `issue`. */
  private authorize<T extends Receipt>(method: HostMethod, request: StageTransitionRequest | ExposureIntentRequest | AssistanceRequest, issue: (table: ActivityTable) => T): T {
    const table = this.table(request.activityId);
    const identity = digestOf(request);
    const previous = table.idempotency[request.idempotencyKey];
    if (previous) {
      if (previous.method !== method || previous.request !== identity) return reject('OPERATION_CONFLICT', 'The idempotency key was used for a different request.');
      return table.receipts.find(receipt => receipt.receiptId === previous.receiptId) as T;
    }
    const policy = this.policyOf(request.activityId);
    if (policy.revoked) return refuse('POLICY_DENIED', 'The host policy is revoked.');
    if (policy.expiresAt !== null && Date.parse(policy.expiresAt) <= this.state.clockMs) return refuse('POLICY_EXPIRED', 'The host policy has expired.');
    if (request.expectedPolicyRevision !== policy.revision) return refuse('STALE_POLICY_REVISION', 'The request is based on another policy revision.');
    if (request.basedOnActivityRevision !== table.activityRevision) return reject('STALE_ACTIVITY_REVISION', 'The request is based on another activity revision.');
    if (canonicalJSON(request.template) !== canonicalJSON(table.instance.template) || canonicalJSON(request.model) !== canonicalJSON(table.instance.model)) return reject('INVALID_REFERENCE', 'The request names another template or model.');
    if (table.instance.mode === 'approved' && !policy.approved.some(entry => canonicalJSON(entry.template) === canonicalJSON(request.template) && canonicalJSON(entry.model) === canonicalJSON(request.model))) {
      return refuse('POLICY_DENIED', 'The template and model are not approved by the host policy.');
    }
    if (this.profile === 'conformant') {
      const allowed = policy.independentTask.active ? policy.independentTask.neutralScaffold : policy.visibleGroups;
      if (request.groups.some(group => !allowed.includes(group.groupId))) return refuse('POLICY_DENIED', 'The host policy does not allow these groups.');
    }
    this.crashPoint('before-intent-commit', false);
    const receipt = issue(table);
    table.activityRevision = receipt.activityRevision;
    table.receipts.push(clone(receipt));
    table.idempotency[request.idempotencyKey] = { method, request: identity, receiptId: receipt.receiptId };
    this.crashPoint('after-intent-commit-before-reply', true);
    return receipt;
  }

  private receiptBase(request: StageTransitionRequest | ExposureIntentRequest | AssistanceRequest, table: ActivityTable) {
    const issuedAt = this.timestamp();
    return {
      schemaVersion: '1.0' as const, receiptId: this.id('rcpt'), activityId: request.activityId, basedOnActivityRevision: request.basedOnActivityRevision,
      activityRevision: table.activityRevision + 1, policyId: this.policyOf(request.activityId).policyId, policyRevision: this.policyOf(request.activityId).revision, idempotencyKey: request.idempotencyKey,
      template: clone(request.template), model: clone(request.model), issuedAt,
      expiresAt: this.receiptTtlMs === null ? null : new Date(Date.parse(issuedAt) + this.receiptTtlMs).toISOString(),
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
  private table(activityId: string): ActivityTable {
    return this.state.activities[activityId] ?? reject('NOT_FOUND', 'The activity is not registered with the host.');
  }
  private tables(activityId?: string): ActivityTable[] {
    return activityId ? [this.state.activities[activityId]].filter((table): table is ActivityTable => !!table) : Object.values(this.state.activities);
  }
  private cursor(activityId: string): JournalCursor {
    const table = this.table(activityId), last = table.events.at(-1);
    return { activityId, lastSequence: last?.sequence ?? 0, lastEventId: last?.eventId ?? null, checkpointDigest: table.checkpointDigest };
  }
  private ack(): HostAck { return { ok: true, hostTimestamp: this.timestamp() }; }
  private timestamp(): string { return new Date(this.state.clockMs++).toISOString(); }
  private id(prefix: string): string { return `${prefix}-${++this.state.counter}`; }
}
