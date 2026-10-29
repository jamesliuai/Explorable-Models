/**
 * Host-agnostic HostPort conformance kit (external gate G2, A54 preparation; report §6.3, §7.2, §14, §17).
 *
 * `runHostPortConformance(host, options)` drives the G2 sequence through the real adapter (`createStudyHarnessAdapter`)
 * over the supplied `HostPort` and checks, at the HostPort boundary, the semantics a Study Harness host must honour:
 * idempotency by operation ID and request fingerprint (a replay returns the committed receipt; another request under the
 * same key is refused), receipts that echo their request, the refusal convention (`HOST_REFUSAL_CODES`, never retried),
 * durable-before-return (through a caller-supplied restart hook that yields a fresh HostPort over the same durable store),
 * authorization kept apart from display acknowledgement, duplicate-eventId deduplication, journal cursor monotonicity and
 * gap refusal, the host-owned session revision, exposure/assistance read-back after a restart, artifact save
 * idempotency and conflict, and the three interruption points (before the intent commits, after it commits, and after
 * display before the acknowledgement commits).
 *
 * The kit is plain TypeScript with no Node, DOM or native imports: it runs in Node, a browser and a packaged WebView.
 * It acts as the learner surface itself (a learner binding that registers a headless surface and acknowledges the
 * projections it is given); rendering is not part of this kit. Steps the supplied host cannot exercise (a hook it does
 * not provide) are reported as `not-run` with the reason, never as passed. The caller labels the subject
 * (`actual-host`, `reference-fixture-host`, `memory-fixture-host`); the kit never chooses that label.
 */
import { ADAPTER_VERSION, createStudyHarnessAdapter } from '../adapter.js';
import type { ActivityBinding, AudienceState, CommandOutcome, LearnerProjection, PreparedActivity, StudyHarnessAdapter } from '../api.js';
import {
  isHostRefusal,
  type ActivityArtifact, type ActivityCatalog, type ActivityRecords, type ActivityRequest, type ActivityTemplate, type AppendResult, type DisplayAckRequest,
  type ExposureIntentRequest, type ExposureReceipt, type ExposureRecord, type GroupDigest, type HostPolicy, type HostPort, type InteractionEvent, type JournalCursor,
  type ModelManifest, type ResponseRef, type StageReceipt, type AssistanceReceipt,
} from '../contracts.js';
import { artifactDigest, artifactIntegrity, groupDigests } from '../identity.js';
import { validateRecord } from '../validator.js';
import {
  HOST_CONFORMANCE_RESULT_SCHEMA, HOST_CONFORMANCE_STEPS, HOST_CONFORMANCE_SUBJECTS, hostConformanceResultProblems, overallResult, stepOutcome,
  type HostConformanceAssertion, type HostConformanceIdentity, type HostConformanceOutcome, type HostConformancePackage, type HostConformanceResult,
  type HostConformanceStep, type HostConformanceStepId, type HostConformanceSubject,
} from './result.js';

/** Identity of this kit, recorded in every result (`kit`). */
export const HOST_CONFORMANCE_KIT = Object.freeze({ name: '@explorable-models/activity/conformance', version: ADAPTER_VERSION });
/** The template the G2 sequence opens unless the caller names another with the same stage pattern. */
export const HOST_CONFORMANCE_DEFAULT_TEMPLATE = Object.freeze({ templateId: 'quadratic-gradient-descent', version: '1.0.0' });

/** Protocol points at which the host can be made to fail as if its process ended (see {@link HostConformanceHooks.armCrash}). */
export type HostCrashPoint = 'intent-before-commit' | 'intent-after-commit' | 'display-ack-before-commit';

/**
 * Host-side operations the sequence needs beyond `HostPort`; only `openActivity` is required. A missing hook makes the
 * steps that need it `not-run` with that reason.
 */
export interface HostConformanceHooks {
  /** The host opens an activity for the template (it creates the activity ID, host session and first policy). */
  openActivity(input: { templateId: string; version: string }): Promise<ActivityRequest>;
  /**
   * Restarts the host over the SAME durable store and resolves with a fresh `HostPort` (for example: reopen the
   * database, or restart the host process and reconnect). Everything a HostPort call acknowledged before the restart
   * must be there afterwards; the host's restart rule applies (an authorization without a committed display
   * acknowledgement is treated as potentially seen).
   */
  restart?(): Promise<HostPort>;
  /**
   * The host's response transaction for a learner response in the activity's current stage: the host stores the
   * response, advances its session revision and returns the reference with the revision it expected and the one THIS
   * transaction produced.
   */
  respond?(input: { activityId: string; kind: ResponseRef['kind']; stageId: string; taskId: string }): Promise<{
    response: Omit<ResponseRef, 'status'>; expectedHostSessionRevision: number; hostSessionRevision: number;
  }>;
  /** The host session revision the host durably holds for the activity. */
  hostSessionRevision?(input: { activityId: string }): Promise<number>;
  /** The host decides to show held-back solution-bearing groups: resolves with the next policy revision that allows them. */
  authorizeReveal?(input: { activityId: string; groups: string[] }): Promise<HostPolicy>;
  /** The host opens a fresh independent task from the activity (its own activity and an independent-task policy). */
  startIndependentTask?(input: { activityId: string }): Promise<{ request: ActivityRequest; taskRef: string; policy: HostPolicy }>;
  /**
   * Arms one interruption for the next time the host reaches `point`: `intent-before-commit` (an exposure intent is
   * checked but not committed), `intent-after-commit` (committed, reply lost) or `display-ack-before-commit` (a display
   * acknowledgement checked but not committed). The call then fails like a crashed host (not a refusal) and the host
   * answers nothing until {@link restart}.
   */
  armCrash?(point: HostCrashPoint): Promise<void>;
}

export interface HostConformanceOptions {
  /** Label of the host under test, supplied by the caller (the kit never labels a run `actual-host` by itself). */
  subject: HostConformanceSubject;
  host: HostConformanceIdentity;
  /** Packed `@explorable-models/*` tarballs the host mounts (name, version, sha256). */
  packages: HostConformancePackage[];
  /** The installed catalogue the host serves (its worker factory runs kernels in the caller's environment). */
  catalog: ActivityCatalog;
  hooks: HostConformanceHooks;
  template?: { templateId: string; version: string };
  /** Steps that cannot run in this environment, with the reason (recorded as `not-run (environment)`). */
  environment?: Partial<Record<HostConformanceStepId, string>>;
  /** Limitations of this run to record (in addition to the kit's own). */
  limitations?: string[];
  evidence?: Partial<Record<HostConformanceStepId, string>>;
  /** Bound per wait (milliseconds, default 20,000). */
  timeoutMs?: number;
  adapter?: { maxWorkers?: number; persistenceWaitMs?: number };
  now?: () => Date;
}

/** One assertion with its step, as the kit evaluated it. */
export interface HostConformanceCheck { step: HostConformanceStepId; id: string; outcome: HostConformanceOutcome; detail?: string }
export interface HostConformanceRun {
  /** The record in the form of `docs/study-harness/templates/host-conformance-result.schema.json`. */
  result: HostConformanceResult;
  checks: HostConformanceCheck[];
  /** Schema problems of `result` (empty when it conforms; a non-empty list is a kit defect). */
  problems: string[];
}

const KIT_LIMITATIONS = [
  'Display acknowledgements were issued by the kit acting as the learner surface (a learner binding with a registered headless surface); rendering and visual inspection are outside this kit.',
  'Restarts used the host-supplied restart hook over the same durable store; a full process termination of the host application is not exercised by the kit itself.',
  'Late reveal replies arriving after an independent task begins are discarded by the adapter (tests/activity/independence.test.ts); the kit checks the host side of the independent task only.',
];

// -------------------------------------------------------------------------------------------------------------------
// Transport: the HostPort the kit's adapters use. It forwards to the current host (replaced after a restart), records
// every call and its outcome, counts calls, and can hold one call (simulated latency) while the kit acts.
// -------------------------------------------------------------------------------------------------------------------
type Method = keyof HostPort;
const METHODS: Method[] = ['getPolicy', 'registerActivity', 'requestStageTransition', 'recordExposureIntent', 'recordDisplayAck', 'recordAssistance', 'appendEvents',
  'getJournalCursor', 'saveArtifact', 'getActivityRecords'];
interface Call { method: Method; request: unknown; settled: boolean; ok: boolean; result?: unknown; error?: unknown; epoch: number }

class Transport {
  current: HostPort;
  readonly calls: Call[] = [];
  inflight = 0;
  epoch = 0;
  private held: { method: Method; gate: Promise<void>; release: () => void; reached: boolean } | null = null;
  /** While a restart swaps the host, new calls wait here (none reaches the host that is going away). */
  private paused: Promise<void> | null = null;
  readonly port: HostPort;
  readonly hasRecords: boolean;

  constructor(host: HostPort) {
    this.current = host;
    this.hasRecords = typeof host.getActivityRecords === 'function';
    const port: Partial<Record<Method, (request: unknown) => Promise<unknown>>> = {};
    for (const method of METHODS) if (method !== 'getActivityRecords' || this.hasRecords) port[method] = request => this.run(method, request);
    this.port = port as unknown as HostPort;
  }
  /** The next call of `method` waits until `release()` (the call is recorded when it reaches the transport). */
  hold(method: Method): { release(): void; reached(): boolean } {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const held = { method, gate, release, reached: false };
    this.held = held;
    return { release: () => { if (this.held === held) this.held = null; release(); }, reached: () => held.reached };
  }
  /** Holds every new call until the returned function is called (used while the host restarts). */
  pause(): () => void {
    let resume!: () => void;
    this.paused = new Promise<void>(resolve => { resume = resolve; });
    return () => { this.paused = null; resume(); };
  }
  count(method: Method, since = 0): number { return this.calls.slice(since).filter(call => call.method === method).length; }
  last(method: Method, filter: (call: Call) => boolean = () => true): Call | undefined {
    for (let index = this.calls.length - 1; index >= 0; index--) { const call = this.calls[index]!; if (call.method === method && filter(call)) return call; }
    return undefined;
  }
  /** Event IDs the host acknowledged (or reported as duplicates) for an activity, with their sequences. */
  acknowledged(activityId: string, since = 0): Map<string, number> {
    const out = new Map<string, number>();
    for (const call of this.calls.slice(since)) {
      if (call.method !== 'appendEvents' || !call.ok) continue;
      const request = call.request as { activityId: string; events: InteractionEvent[] };
      if (request.activityId !== activityId) continue;
      const result = call.result as AppendResult;
      const confirmed = new Set([...result.acknowledged.map(item => item.eventId), ...result.duplicates]);
      for (const event of request.events) if (confirmed.has(event.eventId)) out.set(event.eventId, event.sequence);
    }
    return out;
  }
  lastAcknowledged(activityId: string): { sequence: number; eventId: string | null } {
    let best = { sequence: 0, eventId: null as string | null };
    for (const [eventId, sequence] of this.acknowledged(activityId)) if (sequence > best.sequence) best = { sequence, eventId };
    return best;
  }
  events(activityId: string, since = 0): InteractionEvent[] {
    const out: InteractionEvent[] = [];
    for (const call of this.calls.slice(since)) if (call.method === 'appendEvents' && (call.request as { activityId: string }).activityId === activityId) out.push(...(call.request as { events: InteractionEvent[] }).events);
    return out;
  }
  private async run(method: Method, request: unknown): Promise<unknown> {
    const call: Call = { method, request: copy(request), settled: false, ok: false, epoch: this.epoch };
    this.calls.push(call);
    this.inflight++;
    try {
      while (this.paused) await this.paused;
      const held = this.held;
      if (held && held.method === method) { this.held = null; held.reached = true; await held.gate; }
      const target = this.current[method] as ((value: unknown) => Promise<unknown>) | undefined;
      if (typeof target !== 'function') throw new Error(`The host provides no ${method}.`);
      const result = await target.call(this.current, request);
      call.ok = true;
      call.result = copy(result);
      return result;
    } catch (error) {
      call.error = error;
      throw error;
    } finally {
      call.settled = true;
      this.inflight--;
    }
  }
}

function copy<T>(value: T): T {
  if (value === undefined) return value;
  try { return JSON.parse(JSON.stringify(value)) as T; } catch { return value; }
}
const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
const short = (text: string): string => text.length > 300 ? `${text.slice(0, 297)}...` : text;
const codeOf = (error: unknown): string => {
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') return (error as { code: string }).code;
  return 'no code';
};
const codes = (outcome: { diagnostics?: { code: string }[] }): string => (outcome.diagnostics ?? []).map(item => item.code).join(', ') || 'none';
const tick = (ms = 0): Promise<void> => new Promise(resolve => globalThis.setTimeout(resolve, ms));

/** Thrown inside a step when it cannot continue; the step's later assertions are recorded as not run. */
class StepStop extends Error {}
/** Thrown inside a step when the host or template cannot exercise it: the step is `not-run` with this reason, not failed. */
class StepNotRun extends StepStop {}

/** Assertions per step. */
class Book {
  readonly assertions = new Map<HostConformanceStepId, HostConformanceAssertion[]>(HOST_CONFORMANCE_STEPS.map(step => [step, []]));
  readonly reasons = new Map<HostConformanceStepId, string>();
  readonly environment = new Map<HostConformanceStepId, string>();
  readonly checks: HostConformanceCheck[] = [];
  step: HostConformanceStepId = 'open-quadratic';

  add(id: string, outcome: HostConformanceOutcome, detail?: string): boolean {
    const assertion: HostConformanceAssertion = { id, outcome, ...(detail ? { detail: short(detail) } : {}) };
    this.assertions.get(this.step)!.push(assertion);
    this.checks.push({ step: this.step, ...assertion });
    return outcome === 'pass';
  }
  check(id: string, ok: boolean, detail?: string): boolean { return this.add(id, ok ? 'pass' : 'fail', ok ? undefined : detail); }
  skip(id: string, detail: string): void { this.add(id, 'not-run', detail); }
  /** Fails `id` and stops the step. */
  require(id: string, ok: boolean, detail: string): void { if (!this.check(id, ok, detail)) throw new StepStop(detail); }
  stepFailed(step: HostConformanceStepId): boolean { return this.assertions.get(step)!.some(item => item.outcome === 'fail'); }
}

interface TemplateInfo {
  template: ActivityTemplate;
  manifest: ModelManifest;
  digests: Map<string, string>;
  solution: Set<string>;
}
interface Opened {
  activityId: string;
  adapter: StudyHarnessAdapter;
  prepared: PreparedActivity;
  learner: ActivityBinding;
  surfaceId: string;
}

/**
 * Runs the G2 conformance sequence against `host` and returns the result record (template form), every evaluated check
 * and the record's schema problems. It never throws for a host failure: failures are recorded as failed assertions.
 */
export async function runHostPortConformance(host: HostPort, options: HostConformanceOptions): Promise<HostConformanceRun> {
  if (!options || !HOST_CONFORMANCE_SUBJECTS.includes(options.subject)) throw new TypeError('Label the host under test: subject must be actual-host, reference-fixture-host or memory-fixture-host.');
  if (!host || typeof host.registerActivity !== 'function') throw new TypeError('Provide the HostPort under test.');
  if (!options.catalog || typeof options.catalog.getTemplate !== 'function') throw new TypeError('Provide the installed catalogue.');
  if (!options.hooks || typeof options.hooks.openActivity !== 'function') throw new TypeError('Provide hooks.openActivity.');
  const now = options.now ?? (() => new Date());
  const runAt = now().toISOString();
  const timeoutMs = options.timeoutMs ?? 20_000;
  const hooks = options.hooks;
  const ref = options.template ?? HOST_CONFORMANCE_DEFAULT_TEMPLATE;
  const transport = new Transport(host);
  const book = new Book();
  const adapters: StudyHarnessAdapter[] = [];
  const nonce = (now().getTime() % 2_176_782_336).toString(36);
  let counter = 0;
  const op = (label: string): string => `kit-${nonce}-${label}-${++counter}`;
  const newAdapter = (): StudyHarnessAdapter => {
    const adapter = createStudyHarnessAdapter({
      catalog: options.catalog, host: transport.port, maxWorkers: options.adapter?.maxWorkers ?? 2,
      ...(options.adapter?.persistenceWaitMs !== undefined ? { persistenceWaitMs: options.adapter.persistenceWaitMs } : {}),
    });
    adapters.push(adapter);
    return adapter;
  };

  // ---- waiting ------------------------------------------------------------------------------------------------------
  async function until(done: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!done()) {
      if (Date.now() > deadline) throw new StepStop(`timed out waiting for ${what}`);
      await tick(5);
    }
  }
  const hostState = (opened: Opened): AudienceState => {
    const state = opened.adapter.getState(opened.activityId, 'host');
    if (!('audience' in state)) throw new StepStop(`getState failed (${codes(state)})`);
    return state;
  };
  /** No host call in flight and the activity's journal acknowledged (or failed): the state a host would checkpoint. */
  async function quiesce(opened?: Opened): Promise<void> {
    await tick();
    await until(() => transport.inflight === 0 && (!opened || hostState(opened).persistence !== 'saving'), 'host calls to settle');
    await tick(2);
    await until(() => transport.inflight === 0, 'host calls to settle');
  }
  /** Repeats a command refused with PERSISTENCE_PENDING under the same operation ID, as a host does. */
  async function pending(run: () => Promise<CommandOutcome>): Promise<CommandOutcome> {
    let outcome = await run();
    for (let attempt = 0; attempt < 40 && !outcome.ok && outcome.diagnostics.every(item => item.code === 'PERSISTENCE_PENDING'); attempt++) {
      await tick(50);
      outcome = await run();
    }
    return outcome;
  }
  async function restart(): Promise<void> {
    if (!hooks.restart) throw new StepNotRun('The host supplied no restart hook.');
    await quiesce();
    const resume = transport.pause();
    try {
      transport.current = await hooks.restart();
      transport.epoch++;
    } finally { resume(); }
  }
  async function cursorOf(activityId: string): Promise<JournalCursor> {
    const cursor = await transport.port.getJournalCursor({ activityId });
    const checked = validateRecord('study-harness.journal-cursor', cursor);
    if (!checked.ok) throw new StepStop('the journal cursor does not match study-harness.journal-cursor');
    return cursor;
  }
  async function records(activityId: string): Promise<ActivityRecords | null> {
    if (!transport.hasRecords) return null;
    const read = await transport.port.getActivityRecords!({ activityId });
    if (!validateRecord('study-harness.activity-records', read).ok) throw new StepStop('getActivityRecords does not match study-harness.activity-records');
    return read;
  }
  /** Expects `run` to be refused under the HostPort refusal convention; returns the failure text or null. */
  async function refused(run: () => Promise<unknown>, expected?: string): Promise<string | null> {
    try {
      await run();
      return 'the host accepted it';
    } catch (error) {
      if (!isHostRefusal(error)) return `rejected without a refusal code (${codeOf(error)}), so the adapter would treat it as retryable`;
      if (expected && codeOf(error) !== expected) return `refused with ${codeOf(error)} instead of ${expected}`;
      return null;
    }
  }

  // ---- template ---------------------------------------------------------------------------------------------------
  async function templateInfo(): Promise<TemplateInfo> {
    if (options.catalog.load) {
      const loaded = await options.catalog.load(ref);
      if (!loaded.ok) throw new StepStop(`the catalogue could not load ${ref.templateId}@${ref.version}`);
    }
    const template = options.catalog.getTemplate(ref);
    const entry = options.catalog.listTemplates().find(item => item.template.templateId === ref.templateId && item.template.version === ref.version);
    const manifest = entry ? options.catalog.getModel(entry.model) : null;
    if (!template || !manifest) throw new StepStop(`the catalogue does not hold ${ref.templateId}@${ref.version}`);
    return {
      template, manifest, digests: new Map(groupDigests(template, manifest).map(item => [item.groupId, item.contentDigest])),
      solution: new Set(template.groups.filter(group => group.solutionBearing).map(group => group.id)),
    };
  }
  let info: TemplateInfo | null = null;
  const tpl = (): TemplateInfo => { if (!info) throw new StepStop('the template is not available'); return info; };
  const digestsOf = (groups: string[]): GroupDigest[] => groups.map(groupId => ({ groupId, contentDigest: tpl().digests.get(groupId)! }));
  function visibleGroups(projection: LearnerProjection): Set<string> {
    const { template } = tpl();
    const ids = new Set<string>();
    for (const view of projection.views) {
      ids.add(view.viewId);
      for (const mark of view.marks) ids.add(mark.markId);
      for (const value of view.values) ids.add(value.quantityId);
      for (const equation of view.equations) ids.add(equation.equationId);
    }
    for (const control of projection.controls) ids.add(control.parameter);
    const groups = new Set<string>();
    for (const view of template.views) { if (ids.has(view.id)) groups.add(view.group); for (const mark of view.marks) if (ids.has(mark.id)) groups.add(mark.group); }
    for (const group of template.groups) if (group.kind === 'quantity' && group.members.some(member => ids.has(member))) groups.add(group.id);
    for (const equation of template.equations) if (ids.has(equation.id)) groups.add(equation.group);
    for (const control of template.controls) if (ids.has(control.parameter)) groups.add(control.group);
    return groups;
  }
  /** Solution-bearing groups the stage shows that the projection does not show yet (held back by the host's policy). */
  function heldBack(projection: LearnerProjection): string[] {
    const stage = tpl().template.stages.find(item => item.id === projection.stage.id);
    if (!stage) return [];
    const visible = visibleGroups(projection);
    return tpl().template.groups.filter(group => group.solutionBearing && stage.visible[group.id] && !visible.has(group.id)).map(group => group.id);
  }
  function revealStage(from: string): string | null {
    const { template, solution } = tpl();
    const transition = template.transitions.find(item => {
      const target = template.stages.find(stage => stage.id === item.to);
      return item.from === from && !!target && target.kind !== 'closed' && Object.keys(target.visible).some(id => solution.has(id));
    });
    return transition?.to ?? null;
  }
  const activityGuard = (learner: ActivityBinding) => ({ expectedActivityRevision: learner.getProjection().activityRevision, expectedPolicyRevision: learner.getProjection().policyRevision });

  async function openThrough(adapter: StudyHarnessAdapter, label: string): Promise<{ opened: Opened; request: ActivityRequest }> {
    const request = await hooks.openActivity({ templateId: ref.templateId, version: ref.version });
    const prepared = await adapter.prepare(request, { operationId: op(`prepare-${label}`) });
    if (!prepared.ok) throw new StepStop(`prepare failed (${codes(prepared)})`);
    const surfaceId = op(`surface-${label}`);
    const learner = prepared.prepared.binding('learner', surfaceId);
    learner.registerSurface(surfaceId);
    return { opened: { activityId: request.activityId, adapter, prepared: prepared.prepared, learner, surfaceId }, request };
  }
  /** Acknowledges the learner binding's current projection from its registered surface (the kit acts as the surface). */
  function display(opened: Opened): LearnerProjection {
    const projection = opened.learner.getProjection();
    opened.learner.acknowledgeDisplay({ projectionId: projection.projectionId, projectionDigest: projection.projectionDigest, surfaceId: opened.surfaceId });
    return projection;
  }
  const exposureOf = (opened: Opened, exposureId: string): ExposureRecord | undefined => (hostState(opened).exposures ?? []).find(record => record.exposureId === exposureId);
  async function confirmedDisplay(opened: Opened, exposureId: string): Promise<void> {
    await until(() => { const record = exposureOf(opened, exposureId); return record?.displayStatus === 'displayed' && record.uncertainty?.code !== 'ACK_NOT_PERSISTED'; }, 'the host-confirmed display acknowledgement');
    await quiesce(opened);
  }
  /** Moves a fresh activity to the reveal stage and has the host authorize its held-back groups (crash-step setup). */
  async function toAuthorized(opened: Opened): Promise<string[]> {
    const to = revealStage(opened.learner.getProjection().stage.id);
    if (!to) throw new StepNotRun('No transition of the template shows solution-bearing content.');
    const moved = await pending(() => opened.prepared.host.requestStageTransition({ operationId: op('stage'), ...activityGuard(opened.learner), toStage: to }));
    if (!moved.ok) throw new StepStop(`the stage transition failed (${codes(moved)})`);
    const held = heldBack(opened.learner.getProjection());
    if (!held.length) throw new StepNotRun('The host showed the solution-bearing content through the stage receipt; there is no separate authorization to interrupt.');
    if (!hooks.authorizeReveal) throw new StepStop('no authorizeReveal hook');
    const policy = await hooks.authorizeReveal({ activityId: opened.activityId, groups: held });
    if (opened.learner.getProjection().policyRevision < policy.revision) {
      const updated = await opened.prepared.host.updatePolicy({ operationId: op('policy'), policy });
      if (!updated.ok) throw new StepStop(`the host policy was refused (${codes(updated)})`);
    }
    await quiesce(opened);
    return held;
  }
  const revealExposures = (read: ActivityRecords | null, groups: string[]): ExposureRecord[] =>
    (read?.exposures ?? []).filter(record => record.scope === 'reveal' && groups.every(id => record.groups.some(group => group.groupId === id)));

  // ---- shared state of the sequence -------------------------------------------------------------------------------
  let main: Opened | null = null;
  let revealed: { exposureId: string; groups: string[]; intent: ExposureIntentRequest | null; receipt: ExposureReceipt | StageReceipt; ack: DisplayAckRequest | null } | null = null;
  let checkpoint: ActivityArtifact | null = null;
  let checkpointDigest: string | null = null;
  let restored: Opened | null = null;
  /** The stage receipt that moved the main activity in authorize-reveal (no later step of the sequence moves its stage). */
  let stageMove: { receiptId: string; toStage: string } | null = null;
  const done = new Set<HostConformanceStepId>();
  const requireMain = (): Opened => { if (!main) throw new StepStop('open-quadratic did not complete'); return main; };

  async function step(id: HostConformanceStepId, needs: { hooks?: (keyof HostConformanceHooks)[]; after?: HostConformanceStepId[] }, run: () => Promise<void>): Promise<void> {
    book.step = id;
    const environment = options.environment?.[id];
    if (environment) { book.environment.set(id, short(environment)); return; }
    const missing = (needs.hooks ?? []).filter(name => typeof hooks[name] !== 'function');
    if (missing.length) { book.reasons.set(id, `The host supplied no ${missing.join(', ')} hook.`); return; }
    const blocked = (needs.after ?? []).filter(earlier => !done.has(earlier));
    if (blocked.length) { book.reasons.set(id, `Depends on ${blocked.join(', ')}, which did not complete.`); return; }
    try {
      await run();
      // Ran to its end (a failed assertion does not stop later steps that only need its state).
      done.add(id);
    } catch (error) {
      const text = error instanceof StepStop ? error.message : `the kit stopped: ${error instanceof Error ? error.message : String(error)}`;
      book.reasons.set(id, short(text));
      if (!(error instanceof StepNotRun) && !book.stepFailed(id)) book.add('step-completed', 'fail', text);
    }
  }

  // =================================================================================================================
  // The sequence
  // =================================================================================================================
  await step('open-quadratic', {}, async () => {
    info = await templateInfo();
    const adapter = newAdapter();
    const before = transport.calls.length;
    const { opened, request } = await openThrough(adapter, 'main');
    book.check('host-issued-request', validateRecord('study-harness.activity-request', request).ok, 'the host request does not match study-harness.activity-request');
    const registration = transport.last('registerActivity', call => call.ok && (call.request as { instance: { activityId: string } }).instance.activityId === opened.activityId);
    book.check('registered-through-host', !!registration && transport.count('registerActivity', before) >= 1, 'prepare did not register the activity with the host');
    main = opened;
    await quiesce(opened);
    const policy = await transport.port.getPolicy({ activityId: opened.activityId });
    book.check('policy-current', validateRecord('study-harness.host-policy', policy).ok && policy.revision === opened.learner.getProjection().policyRevision,
      `the host policy revision ${policy.revision} differs from the adapter's ${opened.learner.getProjection().policyRevision}`);
    const cursor = await cursorOf(opened.activityId);
    const local = transport.lastAcknowledged(opened.activityId);
    book.check('journal-acknowledged', cursor.lastSequence === local.sequence && cursor.lastEventId === local.eventId && local.sequence > 0,
      `the host cursor (${cursor.lastSequence}, ${cursor.lastEventId}) differs from the acknowledged journal (${local.sequence}, ${local.eventId})`);
    const unknown = await refused(() => transport.port.getJournalCursor({ activityId: op('unknown-activity') }));
    book.check('unknown-activity-refused', unknown === null, `a cursor request for an activity the host never opened: ${unknown}`);
  });

  await step('prediction-reference', { hooks: ['respond'], after: ['open-quadratic'] }, async () => {
    const opened = requireMain();
    const projection = opened.learner.getProjection();
    const response = projection.stage.response;
    if (!response) throw new StepNotRun('The initial stage of the template requests no response.');
    const state = hostState(opened);
    const answer = await hooks.respond!({ activityId: opened.activityId, kind: response.kind, stageId: projection.stage.id, taskId: op('task') });
    book.check('host-produced-revision', Number.isSafeInteger(answer.hostSessionRevision) && answer.hostSessionRevision > answer.expectedHostSessionRevision
      && answer.expectedHostSessionRevision === state.guards.hostSessionRevision,
    `the response transaction reported expected ${answer.expectedHostSessionRevision} and produced ${answer.hostSessionRevision} (adapter at ${state.guards.hostSessionRevision})`);
    const outcome = await pending(() => opened.prepared.host.submitResponseRef({
      operationId: op('response'), response: answer.response, expectedHostSessionRevision: answer.expectedHostSessionRevision, hostSessionRevision: answer.hostSessionRevision,
    }));
    book.require('response-reference-recorded', outcome.ok && hostState(opened).instance.responses.some(item => item.responseId === answer.response.responseId),
      `submitResponseRef failed (${codes(outcome as { diagnostics?: { code: string }[] })})`);
    book.check('adapter-adopts-host-revision', hostState(opened).guards.hostSessionRevision === answer.hostSessionRevision, 'the adapter did not adopt the revision the host produced');
    if (hooks.hostSessionRevision) {
      const held = await hooks.hostSessionRevision({ activityId: opened.activityId });
      book.check('host-revision-durable', held === answer.hostSessionRevision, `the host holds session revision ${held}, not the ${answer.hostSessionRevision} its response transaction reported`);
    } else book.skip('host-revision-durable', 'The host supplied no hostSessionRevision hook.');
    const ahead = await refused(() => transport.port.registerActivity({ instance: { ...hostState(opened).instance, hostSessionRevision: answer.hostSessionRevision + 1 }, operationId: op('register-ahead') }));
    book.check('registration-ahead-refused', ahead === null, `a registration claiming a session revision the host never produced: ${ahead}`);
    await quiesce(opened);
  });

  await step('authorize-reveal', { after: ['open-quadratic'] }, async () => {
    const opened = requireMain();
    const control = opened.prepared.host;
    const to = revealStage(opened.learner.getProjection().stage.id);
    if (!to) throw new StepNotRun('No transition from the current stage shows solution-bearing content.');
    const stageCalls = transport.calls.length;
    const moved = await pending(() => control.requestStageTransition({ operationId: op('stage'), ...activityGuard(opened.learner), toStage: to }));
    const stageCall = transport.last('requestStageTransition', call => call.ok);
    const stageReceipt = stageCall?.result as StageReceipt | undefined;
    const stageRequest = stageCall?.request as { activityId: string; idempotencyKey: string; basedOnActivityRevision: number; expectedPolicyRevision: number; fromStage: string; toStage: string; template: unknown; model: unknown } | undefined;
    book.require('stage-receipt-echoes-request', moved.ok && !!stageReceipt && !!stageRequest && transport.calls.length > stageCalls
      && validateRecord('study-harness.stage-receipt', stageReceipt).ok && stageReceipt.activityId === stageRequest.activityId && stageReceipt.idempotencyKey === stageRequest.idempotencyKey
      && stageReceipt.basedOnActivityRevision === stageRequest.basedOnActivityRevision && stageReceipt.policyRevision === stageRequest.expectedPolicyRevision
      && stageReceipt.fromStage === stageRequest.fromStage && stageReceipt.toStage === stageRequest.toStage && same(stageReceipt.template, stageRequest.template) && same(stageReceipt.model, stageRequest.model),
    moved.ok ? 'the stage receipt does not echo its request' : `the stage transition failed (${codes(moved as { diagnostics?: { code: string }[] })})`);
    // The host-owned stage after the move (`ActivityRecords.activity`, report §4.2, §14): the receipt's stage and activity
    // revision, and the receipt that moved it (`stageReceiptId`, which `reconcile` journals when it follows the host).
    stageMove = { receiptId: stageReceipt!.receiptId, toStage: stageReceipt!.toStage };
    const movedState = (await records(opened.activityId))?.activity;
    if (movedState) {
      book.check('host-stage-follows-receipt', movedState.stage === stageReceipt!.toStage && movedState.activityRevision === stageReceipt!.activityRevision && !movedState.closed,
        `after the stage receipt (${stageReceipt!.toStage}, activity revision ${stageReceipt!.activityRevision}) the host reports stage ${movedState.stage} at activity revision ${movedState.activityRevision}${movedState.closed ? ' (closed)' : ''}`);
      if (movedState.stageReceiptId !== undefined) {
        book.check('stage-receipt-named', movedState.stageReceiptId === stageReceipt!.receiptId,
          `the host names ${movedState.stageReceiptId} as the receipt that moved the activity, not its stage receipt ${stageReceipt!.receiptId}`);
      } else book.skip('stage-receipt-named', 'The host records omit stageReceiptId (the receipt that moved the activity to its stage).');
    } else {
      const reason = transport.hasRecords ? 'The host records omit its activity state (stage, activity revision, closed).' : 'The host provides no getActivityRecords.';
      book.skip('host-stage-follows-receipt', reason);
      book.skip('stage-receipt-named', reason);
    }
    const held = heldBack(opened.learner.getProjection());
    let exposureId: string;
    let receipt: ExposureReceipt | StageReceipt;
    let intent: ExposureIntentRequest | null = null;
    if (held.length) {
      const projection = opened.learner.getProjection();
      const instance = hostState(opened).instance;
      const direct = (key: string, revision: number): ExposureIntentRequest => ({
        activityId: opened.activityId, operationId: key, idempotencyKey: key, scope: 'reveal', groups: digestsOf(held), basedOnActivityRevision: projection.activityRevision,
        expectedPolicyRevision: revision, intendedStage: projection.stage.id, actor: 'learner', template: instance.template, model: instance.model,
      });
      const outside = await refused(() => transport.port.recordExposureIntent(direct(op('outside'), projection.policyRevision)));
      book.check('grant-outside-policy-refused', outside === null, `an exposure intent for groups the host policy holds back: ${outside}`);
      if (!hooks.authorizeReveal) throw new StepNotRun('The host supplied no authorizeReveal hook: it has no way to raise its ceiling.');
      const apply = async (next: HostPolicy): Promise<void> => {
        if (opened.learner.getProjection().policyRevision >= next.revision) return;
        const updated = await control.updatePolicy({ operationId: op('policy'), policy: next });
        book.require('policy-applied', updated.ok, `updatePolicy failed (${codes(updated as { diagnostics?: { code: string }[] })})`);
      };
      let policy: HostPolicy;
      if (held.length >= 2) {
        // The host authorizes the first group, and then (without the adapter hearing of it) the rest. The adapter's
        // request on the earlier revision must be refused as stale, reported with that code, not kept pending and
        // never resent.
        const first = await hooks.authorizeReveal({ activityId: opened.activityId, groups: [held[0]!] });
        await apply(first);
        policy = await hooks.authorizeReveal({ activityId: opened.activityId, groups: held });
        book.check('host-authorized-policy', validateRecord('study-harness.host-policy', policy).ok && policy.revision > first.revision && held.every(id => policy.visibleGroups.includes(id)),
          'the authorizing policy is not a newer revision that allows the held-back groups');
        const staleOp = op('reveal-stale');
        const before = transport.count('recordExposureIntent');
        const stale = await control.requestReveal({ operationId: staleOp, ...activityGuard(opened.learner), groups: [held[0]!] });
        const staleCall = transport.last('recordExposureIntent');
        const recognized = !!staleCall && staleCall.settled && !staleCall.ok && isHostRefusal(staleCall.error) && codeOf(staleCall.error) === 'STALE_POLICY_REVISION';
        book.check('refusal-reported-with-convention-code', transport.count('recordExposureIntent') === before + 1 && recognized && !stale.ok && codes(stale).includes('STALE_POLICY_REVISION'),
          `a request on the earlier policy revision: host ${transport.count('recordExposureIntent') === before ? 'was not asked' : staleCall?.ok ? 'accepted it' : `rejected it with ${codeOf(staleCall?.error)}${isHostRefusal(staleCall?.error) ? '' : ' (not a refusal code)'}`}; adapter reported ${stale.ok ? 'success' : codes(stale)}`);
        const counted = transport.count('recordExposureIntent');
        await opened.learner.retryPersistence({ operationId: op('retry') });
        const again = await control.requestReveal({ operationId: staleOp, ...activityGuard(opened.learner), groups: [held[0]!] });
        await quiesce(opened);
        book.check('refusal-not-retried', transport.count('recordExposureIntent') === counted && !again.ok && opened.learner.getProjection().pendingReveal === null,
          `after the refusal: ${transport.count('recordExposureIntent') - counted} more intent calls, pending reveal ${opened.learner.getProjection().pendingReveal?.state ?? 'none'}`);
      } else {
        policy = await hooks.authorizeReveal({ activityId: opened.activityId, groups: held });
        book.check('host-authorized-policy', validateRecord('study-harness.host-policy', policy).ok && policy.revision > projection.policyRevision && held.every(id => policy.visibleGroups.includes(id)),
          'the authorizing policy is not a newer revision that allows the held-back groups');
        book.skip('refusal-reported-with-convention-code', 'The stage holds back one group; the stale-revision probe needs two.');
        book.skip('refusal-not-retried', 'The stage holds back one group; the stale-revision probe needs two.');
      }
      await apply(policy);
      const revealOp = op('reveal');
      const outcome = await pending(() => control.requestReveal({ operationId: revealOp, ...activityGuard(opened.learner), groups: held }));
      const call = transport.last('recordExposureIntent', item => item.ok && (item.request as ExposureIntentRequest).idempotencyKey === revealOp);
      intent = (call?.request ?? null) as ExposureIntentRequest | null;
      const granted = call?.result as ExposureReceipt | undefined;
      book.require('reveal-receipt-echoes-request', outcome.ok && !!granted && !!intent && validateRecord('study-harness.exposure-receipt', granted).ok
        && granted.activityId === intent.activityId && granted.idempotencyKey === intent.idempotencyKey && granted.basedOnActivityRevision === intent.basedOnActivityRevision
        && granted.policyRevision === intent.expectedPolicyRevision && granted.intendedStage === intent.intendedStage && same(granted.template, intent.template) && same(granted.model, intent.model)
        && granted.grant.scope === intent.scope && same(granted.grant.groups, intent.groups),
      outcome.ok ? 'the exposure receipt does not echo its request (activity, key, revisions, refs, stage or exact group digests)' : `the reveal failed (${codes(outcome as { diagnostics?: { code: string }[] })})`);
      receipt = granted!;
      exposureId = granted!.grant.exposureId;
    } else {
      // The host showed the groups through the stage receipt's own grant (persist-before-reveal on the stage request).
      if (!stageReceipt?.grant) throw new StepStop('solution-bearing groups became visible without an exposure grant');
      for (const id of ['grant-outside-policy-refused', 'host-authorized-policy', 'refusal-reported-with-convention-code', 'refusal-not-retried']) {
        book.skip(id, 'The host revealed the content through the stage receipt; there was no separate authorization to probe.');
      }
      receipt = stageReceipt;
      exposureId = stageReceipt.grant.exposureId;
    }
    const authorizedRecords = await records(opened.activityId);
    if (authorizedRecords) {
      const record = authorizedRecords.exposures.find(item => item.exposureId === exposureId);
      book.check('authorization-is-not-display', record?.displayStatus === 'authorized' && !record.displayed, `before any display acknowledgement the host holds the exposure as ${record?.displayStatus ?? 'missing'}`);
    } else book.skip('authorization-is-not-display', 'The host provides no getActivityRecords: its exposure records cannot be read.');
    const exposure = exposureOf(opened, exposureId);
    const forged = await refused(() => transport.port.recordDisplayAck({
      activityId: opened.activityId, exposureId: op('no-such-exposure'), receiptId: receipt.receiptId, projectionDigest: `sha256:${'0'.repeat(64)}`, frameId: op('frame'), monotonicMs: 1,
    }));
    const mismatched = await refused(() => transport.port.recordDisplayAck({
      activityId: opened.activityId, exposureId, receiptId: op('no-such-receipt'), projectionDigest: `sha256:${'0'.repeat(64)}`, frameId: op('frame'), monotonicMs: 1,
    }));
    const untouched = authorizedRecords ? (await records(opened.activityId))!.exposures.find(item => item.exposureId === exposureId)?.displayStatus === 'authorized' : true;
    book.check('display-ack-requires-authorization', forged === null && mismatched === null && untouched,
      `an acknowledgement for an exposure the host never authorized: ${forged ?? 'refused'}; with another receipt: ${mismatched ?? 'refused'}${untouched ? '' : '; the record changed'}`);
    book.require('adapter-holds-authorization', !!exposure && exposure.displayStatus === 'authorized', 'the adapter does not hold the authorized exposure');
    const shown = display(opened);
    await confirmedDisplay(opened, exposureId);
    const ackCall = transport.last('recordDisplayAck', call => call.ok && (call.request as DisplayAckRequest).exposureId === exposureId);
    const ack = (ackCall?.request ?? null) as DisplayAckRequest | null;
    const displayedRecords = await records(opened.activityId);
    const hostRecord = displayedRecords?.exposures.find(item => item.exposureId === exposureId);
    book.check('display-acknowledged', !!ack && ack.projectionDigest === shown.projectionDigest && (!displayedRecords || (hostRecord?.displayStatus === 'displayed' && hostRecord.displayed?.projectionDigest === shown.projectionDigest)),
      `the host holds ${hostRecord?.displayStatus ?? 'no record'} after the acknowledgement`);
    // Durable before return: restart right after the acknowledged writes, before any other call reaches the host.
    if (hooks.restart) {
      const local = transport.lastAcknowledged(opened.activityId);
      await restart();
      const after = await records(opened.activityId);
      const kept = after?.exposures.find(item => item.exposureId === exposureId);
      let replayed = true;
      if (intent) { try { replayed = same(await transport.port.recordExposureIntent(intent), receipt); } catch { replayed = false; } }
      const cursor = await cursorOf(opened.activityId);
      book.check('durable-before-return', replayed && (!after || (kept?.displayStatus === 'displayed' && kept.displayed?.projectionDigest === shown.projectionDigest))
        && cursor.lastSequence === local.sequence && cursor.lastEventId === local.eventId,
      `after a restart: receipt replay ${replayed ? 'identical' : 'different or failed'}, exposure ${kept?.displayStatus ?? (after ? 'missing' : 'not readable')}, cursor (${cursor.lastSequence}, ${cursor.lastEventId}) vs acknowledged (${local.sequence}, ${local.eventId})`);
    } else book.skip('durable-before-return', 'The host supplied no restart hook.');
    if (intent) {
      let replay: string | null = null;
      try { if (!same(await transport.port.recordExposureIntent(intent), receipt)) replay = 'returned a different receipt'; } catch (error) { replay = `failed (${codeOf(error)})`; }
      book.check('intent-replay-identical', replay === null, `replaying the identical exposure intent ${replay}`);
      const conflict = await refused(() => transport.port.recordExposureIntent({ ...intent!, actor: intent!.actor === 'learner' ? 'tutor' : 'learner' }));
      const after = await records(opened.activityId);
      book.check('fingerprint-conflict-refused', conflict === null && (!after || after.exposures.length === (displayedRecords?.exposures.length ?? 0)),
        `another request under the same idempotency key: ${conflict ?? 'refused, but a record was added'}`);
    } else {
      book.skip('intent-replay-identical', 'The content was revealed through the stage receipt.');
      book.skip('fingerprint-conflict-refused', 'The content was revealed through the stage receipt.');
    }
    if (ack) {
      let replay: string | null = null;
      try { await transport.port.recordDisplayAck(ack); } catch (error) { replay = `failed (${codeOf(error)})`; }
      const other = await refused(() => transport.port.recordDisplayAck({ ...ack, frameId: op('other-frame') }));
      book.check('display-ack-idempotent', replay === null && other === null, `replaying the identical acknowledgement ${replay ?? 'succeeded'}; a different one for the same exposure: ${other ?? 'refused'}`);
    } else book.skip('display-ack-idempotent', 'No acknowledgement call was observed.');
    revealed = { exposureId, groups: held.length ? held : (receipt as StageReceipt).grant!.groups.map(group => group.groupId), intent, receipt, ack };
  });

  await step('commit-exploration', { after: ['open-quadratic'] }, async () => {
    const opened = requireMain();
    const projection = opened.learner.getProjection();
    const control = projection.controls.find(item => item.mode === 'interactive');
    if (!control) throw new StepNotRun('No control is interactive in the current stage.');
    const before = { runId: projection.guards.expectedRunId, cursor: await cursorOf(opened.activityId) };
    const next = control.value + control.step <= control.max ? control.value + control.step : control.value - control.step;
    const committed = await opened.learner.commitParameters({ operationId: op('commit'), ...projection.guards, displayValues: { [control.parameter]: next }, gesture: 'exact' });
    const frame = committed.ok ? committed.projection.frame : null;
    const atStart = !!frame && (frame.position.kind === 'index' ? frame.position.index === 0 : frame.position.kind === 'time' ? frame.position.time === 0 : true);
    book.require('new-run-at-index-zero', committed.ok && committed.projection.guards.expectedRunId !== before.runId && atStart,
      committed.ok ? 'the commit did not start a new run at index zero' : `commitParameters failed (${codes(committed)})`);
    await quiesce(opened);
    const cursor = await cursorOf(opened.activityId);
    const local = transport.lastAcknowledged(opened.activityId);
    book.check('journal-acknowledged', cursor.lastSequence === local.sequence && cursor.lastEventId === local.eventId && cursor.lastSequence > before.cursor.lastSequence,
      `the host cursor (${cursor.lastSequence}, ${cursor.lastEventId}) vs acknowledged (${local.sequence}, ${local.eventId}), before ${before.cursor.lastSequence}`);
    const batch = [...transport.calls].reverse().find(call => call.method === 'appendEvents' && call.ok && (call.request as { activityId: string }).activityId === opened.activityId);
    const events = (batch?.request as { events: InteractionEvent[] } | undefined)?.events ?? [];
    if (!events.length) throw new StepStop('no acknowledged event batch was observed');
    let duplicate: string | null = null;
    try {
      const result = await transport.port.appendEvents({ activityId: opened.activityId, events });
      const reported = new Set(result.duplicates);
      if (result.acknowledged.length || !events.every(event => reported.has(event.eventId)) || result.cursor.lastSequence !== cursor.lastSequence || result.cursor.lastEventId !== cursor.lastEventId) {
        duplicate = `acknowledged ${result.acknowledged.length} again, reported ${result.duplicates.length} of ${events.length} as duplicates, cursor ${result.cursor.lastSequence}`;
      }
    } catch (error) { duplicate = `refused the resend (${codeOf(error)})`; }
    book.check('duplicate-eventid-deduped', duplicate === null, `resending acknowledged events: ${duplicate}`);
    const last = events[events.length - 1]!;
    const conflicting = await refused(() => transport.port.appendEvents({ activityId: opened.activityId, events: [{ ...last, monotonicMs: last.monotonicMs + 1 }] }));
    const gap = await refused(() => transport.port.appendEvents({ activityId: opened.activityId, events: [{ ...last, eventId: op('gap-event'), sequence: cursor.lastSequence + 2 }] }));
    const unchanged = await cursorOf(opened.activityId);
    book.check('conflicting-eventid-refused', conflicting === null, `an event reusing an acknowledged eventId with other content: ${conflicting}`);
    book.check('sequence-gap-refused', gap === null && unchanged.lastSequence === cursor.lastSequence && unchanged.lastEventId === cursor.lastEventId,
      `an event leaving a sequence gap: ${gap ?? 'refused'}; cursor ${unchanged.lastSequence} (was ${cursor.lastSequence})`);
    if (hooks.restart) {
      await restart();
      const after = await cursorOf(opened.activityId);
      book.check('journal-durable', after.lastSequence === cursor.lastSequence && after.lastEventId === cursor.lastEventId, `after a restart the cursor is (${after.lastSequence}, ${after.lastEventId}), was (${cursor.lastSequence}, ${cursor.lastEventId})`);
    } else book.skip('journal-durable', 'The host supplied no restart hook.');
  });

  await step('camera-change', { after: ['open-quadratic'] }, async () => {
    const opened = requireMain();
    const projection = opened.learner.getProjection();
    const view = projection.views.find(item => (item.kind === 'plot2d' || item.kind === 'scene2d') && item.bounds);
    if (!view || !view.bounds) throw new StepNotRun('No 2D view with bounds is visible.');
    const [x0, x1, y0, y1] = view.bounds;
    const receipts = ['requestStageTransition', 'recordExposureIntent', 'recordAssistance'].map(method => transport.count(method as Method));
    const outcome = opened.learner.setCamera({ operationId: op('camera'), expectedPresentationRevision: projection.presentationRevision, viewId: view.viewId, camera: { kind: '2d', center: [(x0 + x1) / 2, (y0 + y1) / 2], zoom: 1.5 } });
    const after = opened.learner.getProjection();
    book.check('presentation-only', outcome.ok && after.presentationRevision > projection.presentationRevision && after.guards.expectedRunId === projection.guards.expectedRunId
      && after.guards.expectedScientificVersion === projection.guards.expectedScientificVersion && after.activityRevision === projection.activityRevision,
    outcome.ok ? 'the camera change moved a scientific or activity revision' : `setCamera failed (${codes(outcome)})`);
    await quiesce(opened);
    book.check('no-host-authorization', ['requestStageTransition', 'recordExposureIntent', 'recordAssistance'].every((method, index) => transport.count(method as Method) === receipts[index]),
      'a presentation change asked the host for a receipt');
  });

  await step('save', { after: ['open-quadratic'] }, async () => {
    const opened = requireMain();
    const control = opened.prepared.host;
    const firstOp = op('save');
    const first = await control.save({ operationId: firstOp, kind: 'backup' });
    if (!first.ok) throw new StepStop(`save failed (${codes(first)})`);
    const firstDigest = artifactDigest(first.artifact);
    const firstCall = transport.last('saveArtifact', call => call.ok && (call.request as { operationId: string }).operationId === firstOp);
    book.check('artifact-saved', (firstCall?.result as { artifactDigest?: string } | undefined)?.artifactDigest === firstDigest, 'the host reported another digest for the saved artifact');
    await quiesce(opened);
    book.check('checkpoint-recorded', (await cursorOf(opened.activityId)).checkpointDigest === firstDigest, 'the journal cursor does not name the saved checkpoint');
    let replay: string | null = null;
    try { if ((await transport.port.saveArtifact({ artifact: first.artifact, operationId: firstOp })).artifactDigest !== firstDigest) replay = 'returned another digest'; } catch (error) { replay = `failed (${codeOf(error)})`; }
    book.check('save-replay-idempotent', replay === null, `repeating the identical save ${replay}`);
    const secondOp = op('save');
    const second = await control.save({ operationId: secondOp, kind: 'backup' });
    if (!second.ok) throw new StepStop(`the second save failed (${codes(second)})`);
    const secondDigest = artifactDigest(second.artifact);
    await quiesce(opened);
    const conflict = await refused(() => transport.port.saveArtifact({ artifact: second.artifact, operationId: firstOp }));
    const cursor = await cursorOf(opened.activityId);
    book.check('save-conflict-refused', conflict === null && cursor.checkpointDigest === secondDigest, `another artifact under a used operation ID: ${conflict ?? 'refused'}; checkpoint ${cursor.checkpointDigest === secondDigest ? 'kept' : 'changed'}`);
    checkpoint = second.artifact;
    checkpointDigest = secondDigest;
    if (hooks.restart) {
      await restart();
      const after = await cursorOf(opened.activityId);
      let replayed = false;
      try { replayed = (await transport.port.saveArtifact({ artifact: second.artifact, operationId: secondOp })).artifactDigest === secondDigest; } catch { replayed = false; }
      book.check('checkpoint-durable', after.checkpointDigest === secondDigest && replayed, `after a restart the checkpoint is ${after.checkpointDigest}; save replay ${replayed ? 'identical' : 'different or failed'}`);
    } else book.skip('checkpoint-durable', 'The host supplied no restart hook.');
  });

  let beforeTerminate: { cursor: JournalCursor; calls: number; activity: { stage: string; activityRevision: number } } | null = null;
  await step('terminate', { hooks: ['restart'], after: ['save'] }, async () => {
    const opened = requireMain();
    await quiesce(opened);
    const cursor = await cursorOf(opened.activityId);
    const last = opened.learner.getProjection();
    const activity = { stage: last.stage.id, activityRevision: last.activityRevision };
    opened.adapter.dispose();
    await restart();
    const after = await cursorOf(opened.activityId);
    book.check('store-reopened', after.lastSequence === cursor.lastSequence && after.lastEventId === cursor.lastEventId && after.checkpointDigest === checkpointDigest,
      `after the restart the cursor is (${after.lastSequence}, ${after.lastEventId}, ${after.checkpointDigest}), was (${cursor.lastSequence}, ${cursor.lastEventId}, ${checkpointDigest})`);
    beforeTerminate = { cursor: after, calls: transport.calls.length, activity };
  });

  await step('reopen-verify', { hooks: ['restart'], after: ['terminate'] }, async () => {
    const opened = requireMain();
    const saved = checkpoint!;
    const adapter = newAdapter();
    const receipts = ['requestStageTransition', 'recordExposureIntent', 'recordAssistance'].map(method => transport.count(method as Method));
    const since = transport.calls.length;
    const revision = hooks.hostSessionRevision ? await hooks.hostSessionRevision({ activityId: opened.activityId }) : saved.instance.hostSessionRevision;
    const result = await adapter.restore(saved, { operationId: op('restore'), hostSessionRevision: revision });
    if (!result.ok) throw new StepStop(`restore failed (${codes(result)})`);
    const surfaceId = op('surface-restored');
    const learner = result.prepared.binding('learner', surfaceId);
    learner.registerSurface(surfaceId);
    restored = { activityId: opened.activityId, adapter, prepared: result.prepared, learner, surfaceId };
    await quiesce(restored);
    const state = hostState(restored);
    book.check('scientific-state-restored', !!state.scientific && same(state.scientific.params, saved.scientific.params) && same(state.scientific.position, saved.scientific.position)
      && state.scientific.restoredFrom === saved.scientific.runId, 'the restored parameters, position or run provenance differ from the checkpoint');
    const views = saved.presentation.views as Record<string, { camera?: unknown } | undefined>;
    const camera = Object.entries(views).find(([, view]) => view?.camera);
    book.check('permitted-presentation-restored', !camera || same(learner.getProjection().presentation.views[camera[0]]?.camera, camera[1]!.camera), 'the saved camera was not restored');
    const base = beforeTerminate?.cursor.lastSequence ?? 0;
    const appended = transport.events(opened.activityId, since).filter(event => event.sequence > base);
    const sequences = [...new Set(appended.map(event => event.sequence))].sort((a, b) => a - b);
    const contiguous = sequences.every((sequence, index) => sequence === base + 1 + index);
    const forbidden = appended.filter(event => ['reveal.requested', 'reveal.authorized', 'response.submitted', 'stage.changed', 'parameters.committed'].includes(event.type)).map(event => event.type);
    const cursor = await cursorOf(opened.activityId);
    book.check('event-order-continued', contiguous && forbidden.length === 0 && appended.some(event => event.type === 'artifact.restored') && cursor.lastSequence === (sequences.at(-1) ?? base),
      `restore appended sequences ${sequences.join(',') || 'none'} after ${base}; repeated ${forbidden.join(', ') || 'nothing'}`);
    book.check('no-reveal-repeated', ['requestStageTransition', 'recordExposureIntent', 'recordAssistance'].every((method, index) => transport.count(method as Method) === receipts[index]),
      'the restore asked the host for a new receipt');
    if (revealed) {
      const record = (state.exposures ?? []).find(item => item.exposureId === revealed!.exposureId);
      const host = await records(opened.activityId);
      const kept = host?.exposures.find(item => item.exposureId === revealed!.exposureId);
      book.check('conservative-exposure', record?.displayStatus === 'displayed' && (!host || kept?.displayStatus === 'displayed') && !(state.exposures ?? []).some(item => item.displayStatus === 'not-displayed'),
        `the displayed exposure is ${record?.displayStatus ?? 'missing'} after the restore (host ${kept?.displayStatus ?? 'not readable'})`);
    } else book.skip('conservative-exposure', 'authorize-reveal did not complete.');
    if (transport.hasRecords) book.check('host-records-read-on-restore', transport.count('getActivityRecords', since) >= 1, 'the restore did not read the host records');
    else book.skip('host-records-read-on-restore', 'The host provides no getActivityRecords.');
    // The host-owned activity state (`ActivityRecords.activity`, additive in 1.0) survives the restart as the activity
    // left it, and the restored activity adopts it (report §4.2, §14).
    const restoredRead = transport.hasRecords ? await records(opened.activityId) : null;
    const held = restoredRead?.activity;
    const shown = learner.getProjection();
    const noState = transport.hasRecords ? 'The host records omit its activity state (stage, activity revision, closed).' : 'The host provides no getActivityRecords.';
    if (held && beforeTerminate) {
      book.check('host-activity-state', held.stage === beforeTerminate.activity.stage && held.activityRevision === beforeTerminate.activity.activityRevision && !held.closed
        && shown.stage.id === held.stage && shown.activityRevision === held.activityRevision,
      `the host reports stage ${held.stage} at activity revision ${held.activityRevision}${held.closed ? ' (closed)' : ''}; the activity left stage ${beforeTerminate.activity.stage} at revision ${beforeTerminate.activity.activityRevision}; the restore shows ${shown.stage.id} at ${shown.activityRevision}`);
    } else book.skip('host-activity-state', noState);
    // The host's context lineage of an instructional activity (`ActivityRecords.activity.lineage`, report §6.4): it counts
    // the grant the learner was shown, so the saved grant counts again after a restore.
    if (held?.lineage) {
      const grant = revealed ? restoredRead!.exposures.find(item => item.exposureId === revealed!.exposureId) : undefined;
      book.check('host-lineage-instructional', held.lineage.context.kind === 'instructional' && (!revealed || (!!grant && grant.activityRevision >= held.lineage.fromActivityRevision)),
        `the host reports a ${held.lineage.context.kind} lineage from activity revision ${held.lineage.fromActivityRevision} for an instructional activity (the displayed grant is at revision ${grant?.activityRevision ?? 'missing'})`);
    } else book.skip('host-lineage-instructional', held ? 'The host records omit its context lineage.' : noState);
    // Assistance read-back: the learner asks for help (an assistance receipt through the host), the host restarts, and
    // its records name that receipt with the journal sequence of its `assistance.recorded` event and its grant.
    const helpOp = op('help');
    const help = await pending(() => restored!.learner.requestHelp({ operationId: helpOp, ...activityGuard(restored!.learner) }));
    const assisted = transport.last('recordAssistance', call => call.ok && (call.request as { idempotencyKey: string }).idempotencyKey === helpOp)?.result as
      { receiptId: string; kind: string; grant: { exposureId: string; groups: GroupDigest[] } | null } | undefined;
    book.require('help-recorded-through-host', help.ok && !!assisted, `requestHelp failed (${codes(help as { diagnostics?: { code: string }[] })})`);
    await quiesce(restored!);
    const journaled = transport.events(opened.activityId).find(event => event.type === 'assistance.recorded' && (event.payload as { receiptId?: string }).receiptId === assisted!.receiptId);
    if (hooks.restart && transport.hasRecords) {
      await restart();
      const read = await records(opened.activityId);
      const ref = read?.assistance.find(item => item.receiptId === assisted!.receiptId);
      const grant = assisted!.grant ? { exposureId: assisted!.grant.exposureId, groups: assisted!.grant.groups.map(group => group.groupId) } : null;
      book.check('assistance-read-back-after-restart', !!ref && !!journaled && ref.kind === assisted!.kind && ref.sequence === journaled.sequence && same(ref.grant, grant),
        `after a restart the host lists the help receipt as ${ref ? `${ref.kind} at sequence ${ref.sequence}` : 'missing'} (journaled at ${journaled?.sequence ?? 'no event'})`);
    } else book.skip('assistance-read-back-after-restart', hooks.restart ? 'The host provides no getActivityRecords.' : 'The host supplied no restart hook.');

    // Host authority over a restored checkpoint (report §4.2, §6.3, §14; R01, R04). The host has moved on since the
    // checkpoint (the help receipt above), so `checkpoint` is now an earlier checkpoint. A registration never moves the
    // host's own state; a backup whose grant names a receipt the host never issued is not confirmed by the host's records,
    // even when the host stores it as its latest checkpoint; and the honest earlier checkpoint adopts the host's stage and
    // activity revision, counts the grant the host holds identically and continues with host-authorized steps.
    const AUTHORITY = ['host-revision-is-latest-receipt', 'stage-receipt-kept', 'registration-keeps-host-state', 'forged-grant-not-confirmed', 'earlier-checkpoint-adopts-host-state',
      'saved-grant-confirmed-by-host', 'host-step-after-earlier-checkpoint'];
    const hostRead = transport.hasRecords ? await records(opened.activityId) : null;
    const hostNow = hostRead?.activity;
    if (!hostNow) { for (const id of AUTHORITY) book.skip(id, noState); return; }
    await quiesce(restored!);
    // The activity is reopened below by new adapters; until one succeeds, later steps start from a fresh adapter.
    restored!.adapter.dispose(opened.activityId);
    restored = null;
    const issued = Math.max(...transport.calls.filter(call => call.ok && ['requestStageTransition', 'recordExposureIntent', 'recordAssistance'].includes(call.method)
      && (call.request as { activityId: string }).activityId === opened.activityId).map(call => (call.result as { activityRevision: number }).activityRevision));
    book.check('host-revision-is-latest-receipt', hostNow.activityRevision === issued && hostNow.activityRevision > saved.instance.activityRevision,
      `the host reports activity revision ${hostNow.activityRevision}; its latest receipt for the activity carried ${issued}, the checkpoint ${saved.instance.activityRevision}`);
    // Receipts that do not move the stage (the reveal, the help) leave the stage receipt the one that moved it.
    if (stageMove && hostNow.stageReceiptId !== undefined) {
      book.check('stage-receipt-kept', hostNow.stage === stageMove.toStage && hostNow.stageReceiptId === stageMove.receiptId,
        `after later receipts that did not move the stage the host reports stage ${hostNow.stage} moved by ${hostNow.stageReceiptId}; the stage receipt was ${stageMove.receiptId} (${stageMove.toStage})`);
    } else book.skip('stage-receipt-kept', stageMove ? 'The host records omit stageReceiptId (the receipt that moved the activity to its stage).' : 'authorize-reveal did not move the stage.');
    const hostRevision = hooks.hostSessionRevision ? await hooks.hostSessionRevision({ activityId: opened.activityId }) : saved.instance.hostSessionRevision;
    // A registration claiming the opening stage at activity revision 0, closed and in independent work.
    const claim = { ...saved.instance, stage: { id: tpl().template.initialStage, enteredAtSequence: 0 }, activityRevision: 0, closed: true, context: { kind: 'independent' as const, taskRef: op('claimed-task') } };
    let registration: string | null = null;
    try { await transport.port.registerActivity({ instance: claim, operationId: op('register-claim') }); } catch (error) { if (!isHostRefusal(error)) registration = `failed without a refusal code (${codeOf(error)})`; }
    const afterClaim = (await records(opened.activityId))?.activity;
    book.check('registration-keeps-host-state', registration === null && !!afterClaim && afterClaim.stage === hostNow.stage && afterClaim.activityRevision === hostNow.activityRevision
      && afterClaim.closed === hostNow.closed && same(afterClaim.lineage ?? null, hostNow.lineage ?? null),
    registration ?? `after a registration claiming stage ${claim.stage.id}, revision 0, closed, independent: the host reports stage ${afterClaim?.stage}, revision ${afterClaim?.activityRevision}${afterClaim?.closed ? ' (closed)' : ''}, lineage ${afterClaim?.lineage?.context.kind ?? 'none'}`);
    if (revealed) {
      // The displayed grant re-labelled with a receipt the host never issued; integrity recomputed (a checksum, not a seal).
      const { integrity: _integrity, ...body } = copy(saved);
      const forgedReceipt = op('forged-receipt');
      const forgedBody = { ...body, artifactId: op('forged-artifact'), exposures: body.exposures.map(record => record.exposureId === revealed!.exposureId ? { ...record, receiptId: forgedReceipt } : record) };
      const forged: ActivityArtifact = { ...forgedBody, integrity: artifactIntegrity(forgedBody) };
      let stored = 'stored as its latest checkpoint';
      try { await transport.port.saveArtifact({ artifact: forged, operationId: op('save-forged') }); } catch (error) { stored = `refused (${codeOf(error)})`; }
      const forgedAdapter = newAdapter();
      const outcome = await forgedAdapter.restore(forged, { operationId: op('restore-forged'), hostSessionRevision: hostRevision });
      let shownForged: string[] = [];
      if (outcome.ok) {
        const forgedSurface = op('surface-forged');
        const forgedLearner = outcome.prepared.binding('learner', forgedSurface);
        forgedLearner.registerSurface(forgedSurface);
        await quiesce();
        shownForged = revealed.groups.filter(id => visibleGroups(forgedLearner.getProjection()).has(id));
      }
      const kept = (await records(opened.activityId))?.exposures.find(item => item.exposureId === revealed!.exposureId);
      book.check('forged-grant-not-confirmed', outcome.ok && outcome.report.restored !== 'exact' && shownForged.length === 0 && kept?.receiptId === revealed.receipt.receiptId,
        outcome.ok ? `a backup whose grant names receipt ${forgedReceipt} (host: ${stored}) restored ${outcome.report.restored} showing ${shownForged.join(', ') || 'none of its groups'}; the host holds the exposure under ${kept?.receiptId ?? 'no receipt'}`
          : `the forged backup was not restored (${codes(outcome)}), so the host's grant counting could not be observed`);
      forgedAdapter.dispose();
    } else book.skip('forged-grant-not-confirmed', 'authorize-reveal did not complete.');
    const earlier = newAdapter();
    const again = await earlier.restore(saved, { operationId: op('restore-earlier'), hostSessionRevision: hostRevision });
    if (!again.ok) {
      book.check('earlier-checkpoint-adopts-host-state', false, `restoring the earlier checkpoint failed (${codes(again)})`);
      for (const id of ['saved-grant-confirmed-by-host', 'host-step-after-earlier-checkpoint']) book.skip(id, 'The earlier checkpoint was not restored.');
      return;
    }
    const earlierSurface = op('surface-earlier');
    const earlierLearner = again.prepared.binding('learner', earlierSurface);
    earlierLearner.registerSurface(earlierSurface);
    const reopened: Opened = { activityId: opened.activityId, adapter: earlier, prepared: again.prepared, learner: earlierLearner, surfaceId: earlierSurface };
    await quiesce(reopened);
    const adopted = earlierLearner.getProjection();
    book.check('earlier-checkpoint-adopts-host-state', adopted.stage.id === hostNow.stage && adopted.activityRevision === hostNow.activityRevision && again.report.restored === 'restricted',
      `the checkpoint saved at stage ${saved.instance.stage.id}, revision ${saved.instance.activityRevision} restored ${again.report.restored} at stage ${adopted.stage.id}, revision ${adopted.activityRevision}; the host holds ${hostNow.stage}, revision ${hostNow.activityRevision}`);
    if (revealed) {
      const missing = revealed.groups.filter(id => !visibleGroups(adopted).has(id));
      book.check('saved-grant-confirmed-by-host', missing.length === 0, `the saved grant the host holds identically does not make ${missing.join(', ')} visible again`);
    } else book.skip('saved-grant-confirmed-by-host', 'authorize-reveal did not complete.');
    const nextOp = op('help-after-earlier');
    const next = await pending(() => earlierLearner.requestHelp({ operationId: nextOp, ...activityGuard(earlierLearner) }));
    const nextReceipt = transport.last('recordAssistance', call => call.ok && (call.request as { idempotencyKey: string }).idempotencyKey === nextOp)?.result as AssistanceReceipt | undefined;
    book.check('host-step-after-earlier-checkpoint', next.ok && nextReceipt?.basedOnActivityRevision === hostNow.activityRevision,
      next.ok ? `the host receipt was based on activity revision ${nextReceipt?.basedOnActivityRevision ?? 'none'}, not the host's ${hostNow.activityRevision}` : `a host-authorized step after the restore failed (${codes(next as { diagnostics?: { code: string }[] })})`);
    await quiesce(reopened);
    restored = reopened;
  });

  await step('independent-task', { hooks: ['startIndependentTask'], after: ['open-quadratic'] }, async () => {
    const origin = restored ?? requireMain();
    const task = await hooks.startIndependentTask!({ activityId: origin.activityId });
    book.check('task-policy', validateRecord('study-harness.host-policy', task.policy).ok && task.policy.independentTask.active && task.policy.independentTask.taskRef === task.taskRef,
      'the host policy for the task is not an active independent-task policy for its taskRef');
    const adapter = restored?.adapter ?? newAdapter();
    const prepared = await adapter.prepare(task.request, { operationId: op('prepare-task') });
    if (!prepared.ok) throw new StepStop(`the task could not be prepared (${codes(prepared)})`);
    const entered = await pending(() => prepared.prepared.host.enterIndependentTask({ operationId: op('enter'), taskRef: task.taskRef, policy: task.policy }));
    const surfaceId = op('surface-task');
    const learner = prepared.prepared.binding('learner', surfaceId);
    learner.registerSurface(surfaceId);
    const projection = learner.getProjection();
    book.require('independent-context', entered.ok && projection.context === 'independent', `enterIndependentTask failed (${codes(entered as { diagnostics?: { code: string }[] })})`);
    // The host's context lineage of the task (`ActivityRecords.activity.lineage`, report §6.4, A19, A26): independent for
    // this task from the revision after its activation, so no grant issued at or before the activation counts again.
    const taskState = transport.hasRecords ? (await records(task.request.activityId))?.activity : undefined;
    if (taskState?.lineage) {
      const { context, fromActivityRevision } = taskState.lineage;
      book.check('independent-lineage', context.kind === 'independent' && context.taskRef === task.taskRef && fromActivityRevision === taskState.activityRevision + 1,
        `the host reports a ${context.kind} lineage${context.kind === 'independent' ? ` for ${context.taskRef}` : ''} from activity revision ${fromActivityRevision} for the task activated at revision ${taskState.activityRevision} (${task.taskRef})`);
    } else book.skip('independent-lineage', taskState ? 'The host records omit its context lineage.' : transport.hasRecords ? 'The host records omit its activity state (stage, activity revision, closed).' : 'The host provides no getActivityRecords.');
    const visible = [...visibleGroups(projection)].filter(id => tpl().solution.has(id));
    book.check('teaching-visual-absent', visible.length === 0 && !projection.controls.some(control => control.mode === 'interactive'),
      `the task shows ${visible.join(', ') || 'no solution-bearing group'} and ${projection.controls.filter(control => control.mode === 'interactive').length} interactive controls`);
    const solution = [...tpl().solution];
    const before = transport.count('recordExposureIntent');
    const reveal = await prepared.prepared.host.requestReveal({ operationId: op('task-reveal'), ...activityGuard(learner), groups: solution });
    book.check('reveal-refused-before-host', !reveal.ok && transport.count('recordExposureIntent') === before, 'a reveal in the independent task reached the host or succeeded');
    const instance = (() => { const state = adapter.getState(task.request.activityId, 'host'); return 'audience' in state ? state.instance : null; })();
    if (!instance) throw new StepStop('the task state is not readable');
    await quiesce();
    const grant = await refused(() => transport.port.recordExposureIntent({
      activityId: task.request.activityId, operationId: op('task-intent'), idempotencyKey: op('task-intent'), scope: 'reveal', groups: digestsOf(solution),
      basedOnActivityRevision: learner.getProjection().activityRevision, expectedPolicyRevision: learner.getProjection().policyRevision, intendedStage: learner.getProjection().stage.id,
      actor: 'learner', template: instance.template, model: instance.model,
    }));
    book.check('host-refuses-instructional-grant', grant === null, `an exposure intent for teaching content in the independent task: ${grant}`);
    adapter.dispose(task.request.activityId);
  });

  // ---- interruption points ----------------------------------------------------------------------------------------
  async function crashSetup(label: string): Promise<{ opened: Opened; held: string[]; saved: ActivityArtifact }> {
    const { opened } = await openThrough(newAdapter(), label);
    const held = await toAuthorized(opened);
    const saved = await opened.prepared.host.save({ operationId: op(`checkpoint-${label}`), kind: 'backup' });
    if (!saved.ok) throw new StepStop(`the checkpoint could not be saved (${codes(saved)})`);
    await quiesce(opened);
    return { opened, held, saved: saved.artifact };
  }
  async function crashRestore(opened: Opened, saved: ActivityArtifact, label: string, afterRestart?: () => Promise<void>): Promise<Opened> {
    opened.adapter.dispose();
    await restart();
    if (afterRestart) await afterRestart();
    const adapter = newAdapter();
    const revision = hooks.hostSessionRevision ? await hooks.hostSessionRevision({ activityId: opened.activityId }) : saved.instance.hostSessionRevision;
    const result = await adapter.restore(saved, { operationId: op(`restore-${label}`), hostSessionRevision: revision });
    if (!result.ok) throw new StepStop(`restore after the interruption failed (${codes(result)})`);
    const surfaceId = op(`surface-${label}-restored`);
    const learner = result.prepared.binding('learner', surfaceId);
    learner.registerSurface(surfaceId);
    const reopened = { activityId: opened.activityId, adapter, prepared: result.prepared, learner, surfaceId };
    await quiesce(reopened);
    return reopened;
  }
  const crashed = (method: Method): string | null => {
    const call = transport.last(method);
    if (!call || call.ok) return 'the host answered at the armed interruption point';
    return isHostRefusal(call.error) ? `the interruption was reported as a refusal (${codeOf(call.error)})` : null;
  };

  await step('crash-before-intent', { hooks: ['restart', 'armCrash', 'authorizeReveal'], after: ['open-quadratic'] }, async () => {
    const { opened, held, saved } = await crashSetup('before');
    await hooks.armCrash!('intent-before-commit');
    const revealOp = op('reveal');
    const outcome = await opened.prepared.host.requestReveal({ operationId: revealOp, ...activityGuard(opened.learner), groups: held });
    const interruption = crashed('recordExposureIntent');
    book.require('interruption-observed', !outcome.ok && interruption === null, interruption ?? 'the reveal succeeded although the host was interrupted');
    const seen: { host: ActivityRecords | null } = { host: null };
    const reopened = await crashRestore(opened, saved, 'before', async () => { seen.host = await records(opened.activityId); });
    const host = seen.host;
    if (host) book.check('nothing-committed', revealExposures(host, held).length === 0, `the host holds ${revealExposures(host, held).length} reveal records after an interruption before the commit`);
    else book.skip('nothing-committed', 'The host provides no getActivityRecords.');
    book.check('restored-unseen', held.every(id => !visibleGroups(reopened.learner.getProjection()).has(id)), 'the restored activity shows the content that was never authorized');
    const resumed = await pending(() => reopened.prepared.host.requestReveal({ operationId: revealOp, ...activityGuard(reopened.learner), groups: held }));
    const exposureId = (transport.last('recordExposureIntent', call => call.ok)?.result as ExposureReceipt | undefined)?.grant.exposureId;
    book.require('reveal-resumed', resumed.ok && !!exposureId, `the resumed reveal failed (${codes(resumed as { diagnostics?: { code: string }[] })})`);
    display(reopened);
    await confirmedDisplay(reopened, exposureId!);
    const after = await records(opened.activityId);
    if (after) book.check('one-reveal-record', revealExposures(after, held).length === 1 && revealExposures(after, held)[0]!.displayStatus === 'displayed', `the host holds ${revealExposures(after, held).length} reveal records`);
    else book.skip('one-reveal-record', 'The host provides no getActivityRecords.');
    reopened.adapter.dispose();
  });

  await step('crash-after-intent', { hooks: ['restart', 'armCrash', 'authorizeReveal'], after: ['open-quadratic'] }, async () => {
    const { opened, held, saved } = await crashSetup('after');
    await hooks.armCrash!('intent-after-commit');
    const revealOp = op('reveal');
    const outcome = await opened.prepared.host.requestReveal({ operationId: revealOp, ...activityGuard(opened.learner), groups: held });
    const interruption = crashed('recordExposureIntent');
    book.require('interruption-observed', !outcome.ok && interruption === null, interruption ?? 'the reveal succeeded although the reply was lost');
    const seen: { host: ActivityRecords | null } = { host: null };
    const reopened = await crashRestore(opened, saved, 'after', async () => { seen.host = await records(opened.activityId); });
    const host = seen.host;
    const committed = revealExposures(host, held);
    if (host) {
      book.check('authorized-not-displayed', committed.length === 1 && (committed[0]!.displayStatus === 'authorized' || committed[0]!.displayStatus === 'uncertain'),
        `the host holds ${committed.length} reveal records (${committed.map(item => item.displayStatus).join(', ')})`);
    } else book.skip('authorized-not-displayed', 'The host provides no getActivityRecords.');
    const local = committed[0] ? exposureOf(reopened, committed[0].exposureId) : undefined;
    if (host) book.check('restored-conservatively', !!local && local.displayStatus === 'uncertain', `the restored adapter holds the committed authorization as ${local?.displayStatus ?? 'missing'}`);
    else book.skip('restored-conservatively', 'The host provides no getActivityRecords.');
    const resumed = await pending(() => reopened.prepared.host.requestReveal({ operationId: revealOp, ...activityGuard(reopened.learner), groups: held }));
    const replayed = transport.last('recordExposureIntent', call => call.ok)?.result as ExposureReceipt | undefined;
    book.require('receipt-replayed', resumed.ok && !!replayed && (!committed[0] || replayed.grant.exposureId === committed[0].exposureId),
      resumed.ok ? 'the resumed request received a new receipt instead of the committed one' : `the resumed reveal failed (${codes(resumed as { diagnostics?: { code: string }[] })})`);
    display(reopened);
    await confirmedDisplay(reopened, replayed!.grant.exposureId);
    const after = await records(opened.activityId);
    if (after) book.check('one-reveal-record', revealExposures(after, held).length === 1 && revealExposures(after, held)[0]!.displayStatus === 'displayed', `the host holds ${revealExposures(after, held).length} reveal records`);
    else book.skip('one-reveal-record', 'The host provides no getActivityRecords.');
    reopened.adapter.dispose();
  });

  await step('crash-after-display', { hooks: ['restart', 'armCrash', 'authorizeReveal'], after: ['open-quadratic'] }, async () => {
    const { opened, held } = await crashSetup('display');
    const outcome = await pending(() => opened.prepared.host.requestReveal({ operationId: op('reveal'), ...activityGuard(opened.learner), groups: held }));
    const exposureId = (transport.last('recordExposureIntent', call => call.ok)?.result as ExposureReceipt | undefined)?.grant.exposureId;
    if (!outcome.ok || !exposureId) throw new StepStop(`the reveal failed (${codes(outcome as { diagnostics?: { code: string }[] })})`);
    await quiesce(opened);
    await hooks.armCrash!('display-ack-before-commit');
    // The acknowledgement is in flight (held by the transport) while the host checkpoints the activity.
    const hold = transport.hold('recordDisplayAck');
    const shown = display(opened);
    await until(() => hold.reached(), 'the display acknowledgement to be sent');
    const saved = await opened.prepared.host.save({ operationId: op('checkpoint-in-flight'), kind: 'backup' });
    if (!saved.ok) { hold.release(); throw new StepStop(`the checkpoint could not be saved (${codes(saved)})`); }
    const stored = saved.artifact.exposures.find(item => item.exposureId === exposureId);
    book.check('checkpoint-marks-ack-unconfirmed', stored?.displayStatus === 'displayed' && stored.uncertainty?.code === 'ACK_NOT_PERSISTED',
      `the checkpoint holds the exposure as ${stored?.displayStatus ?? 'missing'} ${stored?.uncertainty?.code ?? ''}`.trim());
    hold.release();
    await until(() => transport.last('recordDisplayAck')?.settled === true, 'the interrupted acknowledgement');
    const interruption = crashed('recordDisplayAck');
    book.require('interruption-observed', interruption === null, interruption ?? '');
    const carried = saved.artifact.journal.pendingEvents ?? [];
    // The host's own record right after the restart, before the restored adapter resends anything.
    const seen: { host: ActivityRecords | null } = { host: null };
    const reopened = await crashRestore(opened, saved.artifact, 'display', async () => { seen.host = await records(opened.activityId); });
    const host = seen.host;
    const kept = host?.exposures.find(item => item.exposureId === exposureId);
    // The restored adapter resends the identical acknowledgement once the activity is registered.
    await until(() => { const record = exposureOf(reopened, exposureId); return record?.displayStatus === 'displayed' && record.uncertainty?.code !== 'ACK_NOT_PERSISTED'; }, 'the resent acknowledgement to be confirmed');
    await quiesce(reopened);
    const resent = transport.calls.filter(call => call.method === 'recordDisplayAck' && call.ok && (call.request as DisplayAckRequest).exposureId === exposureId);
    const after = await records(opened.activityId);
    const final = after?.exposures.find(item => item.exposureId === exposureId);
    if (host) {
      book.check('reopen-records-uncertain', !!kept && kept.displayStatus !== 'displayed' && kept.displayStatus !== 'not-displayed',
        `after the restart the host holds the exposure as ${kept?.displayStatus ?? 'missing'} (an acknowledgement it never committed)`);
    } else book.skip('reopen-records-uncertain', 'The host provides no getActivityRecords.');
    book.check('acknowledgement-resent-identically', resent.length >= 1 && (resent.at(-1)!.request as DisplayAckRequest).projectionDigest === shown.projectionDigest
      && (!after || (final?.displayStatus === 'displayed' && final.displayed?.projectionDigest === shown.projectionDigest)),
    `after the restore: ${resent.length} acknowledgements accepted; host record ${final?.displayStatus ?? 'not readable'}`);
    const confirmed = transport.acknowledged(opened.activityId, 0);
    const unrecovered = carried.filter(event => !confirmed.has(event.eventId));
    const lossRecorded = transport.events(opened.activityId).some(event => event.type === 'operation.failed' && !!(event.payload as { lost?: unknown }).lost && confirmed.has(event.eventId));
    book.check('journal-complete-or-loss-recorded', unrecovered.length === 0 || lossRecorded,
      `${unrecovered.length} of ${carried.length} events carried by the checkpoint were not confirmed by the host, and no loss record was journaled`);
    reopened.adapter.dispose();
  });

  // ---- result --------------------------------------------------------------------------------------------------------
  for (const adapter of adapters) { try { adapter.dispose(); } catch { /* already disposed */ } }
  const steps = Object.fromEntries(HOST_CONFORMANCE_STEPS.map(id => {
    const assertions = book.assertions.get(id)!;
    const environment = book.environment.get(id);
    const reason = book.reasons.get(id);
    let outcome: HostConformanceOutcome = environment ? 'not-run (environment)' : stepOutcome(assertions);
    // A step that stopped part-way without a failed assertion did not complete: it is not a pass.
    if (outcome === 'pass' && reason) outcome = 'not-run';
    const step: HostConformanceStep = {
      outcome,
      ...(assertions.length ? { assertions } : {}),
      ...(environment ? { environmentReason: environment } : {}),
      ...(reason && !environment ? { reason } : {}),
      ...(options.evidence?.[id] ? { evidence: short(options.evidence[id]!) } : {}),
    };
    return [id, step];
  })) as Record<HostConformanceStepId, HostConformanceStep>;
  const result: HostConformanceResult = {
    schema: HOST_CONFORMANCE_RESULT_SCHEMA,
    subject: options.subject,
    runAt,
    host: options.host,
    packages: options.packages,
    kit: { ...HOST_CONFORMANCE_KIT },
    steps,
    result: overallResult(steps),
    limitations: [...KIT_LIMITATIONS, ...(options.limitations ?? [])].slice(0, 32).map(short),
  };
  return { result, checks: book.checks, problems: hostConformanceResultProblems(result) };
}
