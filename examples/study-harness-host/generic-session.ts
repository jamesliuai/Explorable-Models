/**
 * BROWSER INTEGRATION FIXTURE — the generic host flow for any installed template (`?template=<templateId>`; report
 * §10.1, §12.6, §13). It is an integration fixture, not a tutor and not evidence of learning benefit: there are no
 * tutor messages, no task content and no evaluation. It lets a browser test (or a person) drive every installed
 * activity through the host side of the contract with one generic set of host controls:
 *
 * - stage controls generated from the template's transitions out of the current stage;
 * - one reveal request per solution-bearing group (persist-before-reveal through the host);
 * - an exploration scope for the current stage's interactive controls and visible groups;
 * - entering an independent task (neutral scaffold only) and reopening instructional content as assistance;
 * - backup and learner-snapshot saves, closing, and an in-page host restart from the latest checkpoint;
 * - the host's response composer, rendered inside the card through its response slot whenever the current stage
 *   requests a response (and for the answer of an independent task); the activity receives only response references.
 *
 * Fixture host policy (a fixture host decision, labelled as such on the page): it approves exactly the selected
 * installed template and its model, by the catalogue's computed references. `?policy=held` (default) holds every
 * solution-bearing group outside the policy ceiling until the host reveals it (the reveal raises the ceiling for that
 * group, then requests the reveal); `?policy=full` puts every group under the ceiling, so stage transitions carry
 * stage-scope grants for the solution-bearing groups of the target stage. `?mode=free` opens the free-explore stage and
 * authorizes it (reveal of its solution-bearing groups, then an exploration scope).
 *
 * Every driver call is serialized and resolves after the host round trip and the display acknowledgement have settled
 * (`settle()`); host refusals resolve with `ok: false` and the adapter's diagnostic codes.
 */
import type { ActivityBinding, ActivityTemplate, CommandOutcome, HostPolicy, LearnerProjection, StageSpec } from '@explorable-models/activity';
import { INSTALLED_TEMPLATES } from '@explorable-models/catalog';
import type { MountedStudyActivity } from '@explorable-models/player/activity';
import type { CrashPoint } from './fixture-host';
import { codes, FixtureRuntime, FixtureStepError, type FixtureMessage, type FixtureOptions } from './fixture-runtime';
import { mountHostCard, type ResponseRequest, type ResponseSlotSource } from './host-card';

export interface GenericOptions extends FixtureOptions {
  templateId: string;
  /** Policy ceiling for solution-bearing groups: held back until revealed (default) or within the ceiling from the start. */
  policy: 'held' | 'full';
}
export type GenericActionId = 'authorize-exploration' | 'enter-independent' | 'reopen' | 'save-backup' | 'save-snapshot' | 'close';
export interface GenericControl { id: string; label: string; state: 'next' | 'blocked' | 'running' | 'done'; reason: string | null }
export interface GenericSnapshot {
  kind: 'generic';
  phase: 'starting' | 'running' | 'crashed' | 'failed';
  error: string | null;
  mode: FixtureOptions['mode'];
  policyMode: GenericOptions['policy'];
  templateId: string;
  title: string;
  activityId: string | null;
  stage: string | null;
  context: 'instructional' | 'independent' | null;
  closed: boolean;
  /** Transitions out of the current stage (`toStage` is what `transition()` takes). */
  steps: (GenericControl & { toStage: string })[];
  /** One entry per solution-bearing group; `done` means its content is shown. */
  reveals: (GenericControl & { groupId: string })[];
  actions: (GenericControl & { id: GenericActionId })[];
  /** ID of the host request that is running (`stage:<id>`, `reveal:<group>`, an action ID or `response`). */
  busy: string | null;
  /** The response the host requests now (shown in the card's response slot), with its recorded reference. */
  response: ResponseRequest | null;
  /** Same shape as the scripted flow's composer: set while a response is requested and not yet recorded. */
  composer: { kind: ResponseRequest['kind'] } | null;
  messages: FixtureMessage[];
  hostLog: string[];
  cardMounted: boolean;
  restoredNotes: string[];
  lastResult: string;
  version: number;
}
/** Outcome of a driver call, read after the fixture settled. */
export interface DriverResult {
  ok: boolean;
  /** Adapter or host diagnostic codes when refused (`HOST_TERMINATED` when the host terminated first). */
  codes: string[];
  message: string;
  stage: string | null;
  context: 'instructional' | 'independent' | null;
  activityRevision: number | null;
  policyRevision: number | null;
  artifactId?: string;
}
type Outcome = Pick<DriverResult, 'ok' | 'codes' | 'message' | 'artifactId'>;

/** Page-owned flow state persisted with the host tables (restored on a host restart). */
interface GenericState {
  templateId: string;
  mode: FixtureOptions['mode'];
  activityId: string;
  attempt: number;
  independentEntries: number;
  /** Instructional policy ceiling to restore when the host reopens instructional content. */
  ceiling: string[] | null;
  closed: boolean;
  revokeApplied: boolean;
  /**
   * Receipt-bearing host request in flight. A request interrupted by a host termination is replayed after the restart
   * with the same operation ID (idempotency key), so the host returns the receipt it may already have committed.
   */
  pending?: { command: HostCommand; operationId: string } | null;
  messages: FixtureMessage[];
}
/** Receipt-bearing host requests of the generic flow (replayable after a restart). */
type HostCommand =
  | { kind: 'stage'; toStage: string }
  | { kind: 'reveal'; groups: string[] }
  | { kind: 'scope'; groups: string[]; parameterDomain?: Record<string, [number, number]> }
  | { kind: 'reopen' };

const TEXT = {
  start: 'Generic host flow (integration fixture, not a tutor): the host panel offers this template’s stage transitions, reveal requests for its solution-bearing groups and the other host actions. Responses go through the host composer in the card; nothing is evaluated.',
  free: 'Free exploration is authorized by the fixture host policy: every control and content group of the free-exploration stage is available. Nothing is evaluated.',
  independent: 'Independent task (host-owned; this fixture has no task content): the teaching visual is withdrawn and only the neutral scaffold remains. Answer in the card’s response box; nothing is evaluated.',
  reopened: 'The host reopened the instructional content; this is recorded as assistance and does not change an answer already submitted.',
  revoked: 'The host revoked the policy for this activity. Nothing new is shown until the host issues a new policy.',
  closed: 'The activity is closed.',
} as const;
const LABEL: Record<ResponseRequest['kind'], string> = { prediction: 'Your prediction', explanation: 'Your explanation', answer: 'Your answer to the independent task' };
const ACTION_LABELS: Record<GenericActionId, string> = {
  'authorize-exploration': 'Authorize exploration', 'enter-independent': 'Enter independent task', reopen: 'Reopen instructional (assistance)',
  'save-backup': 'Save backup', 'save-snapshot': 'Save learner snapshot', close: 'Close',
};
const TERMINATED: Outcome = { ok: false, codes: ['HOST_TERMINATED'], message: 'The host terminated before answering.' };

function templateFor(templateId: string): ActivityTemplate {
  const template = INSTALLED_TEMPLATES.find(item => item.templateId === templateId);
  if (!template) throw new RangeError(`No installed template has the ID ${JSON.stringify(templateId)}.`);
  return template;
}
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const sameJSON = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export class GenericSession extends FixtureRuntime<GenericSnapshot> {
  readonly policyMode: GenericOptions['policy'];
  private flow: GenericState | null = null;
  private running: { id: string; token: symbol } | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  /** Resolves when the host terminates (crash point or in-page restart); pending driver calls then resolve as terminated. */
  private abort = deferred();
  private lastResult = '';
  private watchKey = '';
  private lastResponse: ResponseRequest | null = null;
  /** The card's response slot reads the host's current response request through this source. */
  private readonly slotSource: ResponseSlotSource = {
    subscribe: listener => this.subscribe(listener),
    responseRequest: () => this.getSnapshot().response,
    submitResponse: text => this.submitResponse(text),
  };

  constructor(options: GenericOptions) {
    super(options, templateFor(options.templateId), `generic:${options.templateId}`);
    this.policyMode = options.policy;
  }

  protected busy(): boolean { return this.running !== null; }
  protected mountCard(container: HTMLElement, binding: ActivityBinding, surfaceId: string): MountedStudyActivity {
    return mountHostCard(container, { ...this.cardOptions(binding, surfaceId), source: this.slotSource });
  }
  protected projected(projection: LearnerProjection): void {
    // The host chrome depends on stage, context, revisions and the reveal/persistence status, not on every frame.
    const key = [projection.activityId, projection.stage.id, projection.context, projection.activityRevision, projection.policyRevision,
      projection.pendingReveal?.state ?? '', projection.status.ui, projection.status.persistence, projection.views.length].join('|');
    if (key === this.watchKey) return;
    this.watchKey = key;
    this.changed();
  }
  private persistFlow(): void { if (this.flow) this.persistSession({ generic: this.flow }); }
  private say(text: string): void {
    if (!this.flow) return;
    const messages = [...this.flow.messages, { id: `m${this.flow.messages.length + 1}`, kind: 'host' as const, text }];
    this.flow.messages = messages.slice(-30);
  }
  private stageSpec(id: string | null | undefined): StageSpec | null { return this.template.stages.find(stage => stage.id === id) ?? null; }
  /** Groups under the first instructional policy: everything (free mode or `policy=full`) or every group that is not solution-bearing. */
  private initialCeiling(): string[] {
    return this.options.mode === 'free' || this.policyMode === 'full' ? this.allGroups() : this.template.groups.filter(group => !group.solutionBearing).map(group => group.id);
  }
  /** Neutral scaffold of an independent task (fixture decision): the template's equation groups that carry no solution. */
  private scaffold(): string[] { return this.template.groups.filter(group => group.kind === 'equation' && !group.solutionBearing).map(group => group.id); }
  /** Host-owned later-task family of the template (the task family no stage response uses). */
  private taskRef(entry: number): string {
    const family = this.template.taskFamilies.find(item => !this.template.stages.some(stage => stage.response?.taskFamily === item.id))?.id ?? `${this.template.templateId}-independent-task`;
    return `${family}-${entry}`.slice(0, 128);
  }

  // ---- snapshot for the host chrome ---------------------------------------------------------------------------
  protected snapshot(): GenericSnapshot {
    const flow = this.flow;
    const projection = this.binding?.getProjection() ?? null;
    const stage = this.stageSpec(projection?.stage.id);
    const independent = projection?.context === 'independent';
    const base = this.blocked();
    const policy = this.prepared ? this.host.policy(this.prepared.activityId) : null;
    const running = this.running?.id ?? null;
    const control = <T extends string>(id: T, label: string, reason: string | null, done = false): GenericControl & { id: T } =>
      ({ id, label, state: running === id ? 'running' : reason ? 'blocked' : done ? 'done' : 'next', reason: running === id ? null : reason });
    const steps = stage ? this.template.transitions.filter(item => item.from === stage.id).map(item => ({
      ...control(`stage:${item.to}`, item.label, base ?? (independent ? 'Stage transitions wait until instructional work is reopened.' : null)), toStage: item.to,
    })) : [];
    const shown = projection ? this.shownGroups(projection) : new Set<string>();
    const reveals = this.template.groups.filter(group => group.solutionBearing).map(group => {
      if (shown.has(group.id) && running !== `reveal:${group.id}`) return { id: `reveal:${group.id}`, label: `Reveal: ${group.label}`, state: 'done' as const, reason: null, groupId: group.id };
      const reason = base ?? (independent ? 'Only the neutral scaffold is shown during independent work.'
        : !stage || !Object.hasOwn(stage.visible, group.id) ? `Not part of the stage “${stage?.id ?? 'none'}”.`
          : this.policyMode === 'full' && policy && !policy.visibleGroups.includes(group.id) ? 'Outside the host policy ceiling.' : null);
      return { ...control(`reveal:${group.id}`, `Reveal: ${group.label}`, reason), groupId: group.id };
    });
    const preview = !stage?.allowsPreview ? 'This stage does not allow live preview.' : !projection?.controls.some(item => item.mode === 'interactive') ? 'No control is interactive in this stage.' : null;
    const open = this.phase === 'crashed' ? 'The host terminated.' : this.phase !== 'running' ? 'The fixture is not running.' : !this.prepared ? 'No activity is open.' : running ? 'Another host request is running.' : null;
    const actions: (GenericControl & { id: GenericActionId })[] = [
      control('authorize-exploration', ACTION_LABELS['authorize-exploration'], base ?? (independent ? 'Exploration waits until instructional work is reopened.' : preview), !!projection && this.explorationCovered(projection)),
      control('enter-independent', ACTION_LABELS['enter-independent'], base ?? (independent ? 'The activity is already in an independent task.' : null)),
      control('reopen', ACTION_LABELS.reopen, base ?? (!independent ? 'The activity is in an instructional context.' : null)),
      control('save-backup', ACTION_LABELS['save-backup'], open),
      control('save-snapshot', ACTION_LABELS['save-snapshot'], open),
      control('close', ACTION_LABELS.close, open),
    ];
    const response = this.stableResponse(this.responseRequest());
    return {
      kind: 'generic', phase: this.phase, error: this.error, mode: flow?.mode ?? this.options.mode, policyMode: this.policyMode, templateId: this.template.templateId, title: this.template.title,
      activityId: this.prepared?.activityId ?? null, stage: projection?.stage.id ?? null, context: projection?.context ?? null, closed: flow?.closed ?? false,
      steps, reveals, actions, busy: running, response, composer: response && !response.recorded ? { kind: response.kind } : null,
      messages: flow?.messages ?? [], hostLog: this.hostLog, cardMounted: this.surface !== null, restoredNotes: this.restoredNotes, lastResult: this.lastResult, version: this.version,
    };
  }
  /** General reason a host request cannot be made now, or null. */
  private blocked(): string | null {
    if (this.phase === 'crashed') return 'The host terminated.';
    if (this.phase !== 'running') return 'The fixture is not running.';
    if (this.flow?.closed) return 'The activity is closed.';
    if (!this.prepared || !this.binding) return 'No activity is open.';
    if (this.running) return 'Another host request is running.';
    if (this.host.policy(this.prepared.activityId)?.revoked) return 'The host policy is revoked.';
    return null;
  }
  private stableResponse(next: ResponseRequest | null): ResponseRequest | null {
    if (!sameJSON(next, this.lastResponse)) this.lastResponse = next;
    return this.lastResponse;
  }
  /** The response the host requests now: the stage's prediction/explanation, or the answer of an independent task. */
  private responseRequest(): ResponseRequest | null {
    if (this.phase !== 'running' || !this.flow) return null;
    const state = this.state();
    if (!state || state.instance.closed) return null;
    if (state.projection.context === 'independent') {
      const taskId = this.taskRef(this.flow.independentEntries);
      const recorded = state.instance.responses.find(item => item.kind === 'answer' && item.taskId === taskId)?.responseId ?? null;
      return { key: `answer:${taskId}`, kind: 'answer', label: LABEL.answer, recorded };
    }
    const stage = this.stageSpec(state.instance.stage.id);
    if (!stage?.response) return null;
    const kind = stage.response.kind;
    const recorded = state.instance.responses.find(item => item.kind === kind && item.stageId === stage.id)?.responseId ?? null;
    return { key: `${kind}:${stage.id}`, kind, label: LABEL[kind], recorded };
  }

  // ---- lifecycle --------------------------------------------------------------------------------------------
  /** Starts a new fixture session, or restarts the one kept in sessionStorage. */
  async start(container: HTMLElement): Promise<void> {
    this.container = container;
    this.showPlaceholder('preparing');
    await this.boot();
  }
  private async boot(): Promise<void> {
    const kept = this.host.session<{ generic?: GenericState }>().generic;
    try {
      if (kept && this.host.restarted) await this.resume(kept);
      else await this.fresh();
      this.phase = this.host.crashed ? 'crashed' : 'running';
      if (this.options.revoke && this.prepared && this.flow && !this.flow.revokeApplied) {
        this.flow.revokeApplied = true;
        this.persistFlow();
        await this.revokePolicy();
      }
    } catch (error) {
      if (this.phase !== 'crashed') { this.phase = 'failed'; this.error = error instanceof Error ? error.message : String(error); }
    }
    this.changed();
  }
  private async fresh(): Promise<void> {
    this.flow = {
      templateId: this.template.templateId, mode: this.options.mode, activityId: '', attempt: 0, independentEntries: 0, ceiling: null, closed: false, revokeApplied: false, pending: null, messages: [],
    };
    this.say(this.options.mode === 'free' ? TEXT.free : TEXT.start);
    this.applyInjections(true);
    await this.open(0);
  }
  /** Prepares a new activity (attempt `n` gets its own ID), mounts its card and, in free mode, authorizes free exploration. */
  private async open(attempt: number): Promise<void> {
    const flow = this.flow!;
    const idFor = (n: number) => `fx-${this.host.nonce}-${this.template.templateId}${n ? `-${n}` : ''}`.slice(0, 128);
    let n = attempt;
    while (this.host.policy(idFor(n))) n++;
    const activityId = idFor(n);
    Object.assign(flow, { activityId, attempt: n, independentEntries: 0, ceiling: null, closed: false });
    this.persistFlow();
    const free = flow.mode === 'free' ? this.stageSpec('free-explore') : null;
    if (flow.mode === 'free' && !free) throw new FixtureStepError(`${this.template.templateId} has no free-explore stage.`);
    this.host.setPolicy(activityId, this.policy(activityId, 1, this.initialCeiling()));
    const prepared = await this.adapter.prepare({
      activityId, objectiveIds: [this.template.templateId], hostSessionId: `fx-${this.host.nonce}`, hostSessionRevision: this.host.hostSessionRevision,
      template: { templateId: this.template.templateId, version: this.template.version }, mode: 'approved', ...(free ? { stageId: free.id } : {}),
    }, { operationId: `fx-${this.host.nonce}-prepare-${n}` });
    if (!prepared.ok) throw new FixtureStepError(`The activity could not be prepared (${codes(prepared)}).`);
    this.attach(prepared.prepared);
    this.note(`Prepared ${activityId} (${flow.mode}, policy ${this.policyMode}).`);
    if (free) {
      const outcome = await this.authorizeFree();
      this.note(outcome.ok ? 'Free exploration authorized.' : `Free exploration was not authorized: ${outcome.message}`);
    }
    await this.checkpoint();
  }
  private async resume(kept: GenericState): Promise<void> {
    this.flow = kept;
    this.applyInjections(false);
    const crash = this.host.lastCrash;
    this.note(`Host restarted (start ${this.host.starts})${crash ? `; the previous run terminated at ${crash.point}` : ''}.`);
    this.lastActivityId = kept.activityId;
    if (kept.closed) { kept.pending = null; this.persistFlow(); return; }
    const artifact = this.host.latestBackup(kept.activityId);
    if (!artifact) {
      this.note(`No checkpoint exists for ${kept.activityId}; a new activity is prepared.`);
      kept.pending = null;
      await this.open(kept.attempt + 1);
      return;
    }
    const restored = await this.adapter.restore(artifact, { operationId: this.host.id('fx-restore'), hostSessionRevision: this.host.hostSessionRevision });
    if (!restored.ok && this.showArchival(artifact, restored)) { kept.pending = null; this.persistFlow(); return; }
    if (!restored.ok) throw new FixtureStepError(`The saved activity could not be restored (${codes(restored)}).`);
    this.restoredNotes = restored.report.notes;
    this.note(`Restored ${kept.activityId} (${restored.report.restored}).`);
    this.attach(restored.prepared);
    this.persistFlow();
    const pending = kept.pending;
    if (pending) {
      this.note(`Resuming the interrupted ${pending.command.kind} request with its idempotency key.`);
      const outcome = await this.send(pending.command, pending.operationId);
      this.note(outcome.ok ? 'The interrupted request completed.' : `The interrupted request did not complete (${codes(outcome)}).`);
    }
  }
  protected onCrash(point: CrashPoint): void {
    super.onCrash(point);
    this.abortPending();
  }
  private abortPending(): void {
    this.abort.resolve();
    this.abort = deferred();
    this.running = null;
    this.queue = Promise.resolve();
  }
  protected policyRevoked(): void {
    this.say(TEXT.revoked);
    this.persistFlow();
  }

  // ---- serialized host requests -------------------------------------------------------------------------------
  /** Runs host requests one at a time; a host termination releases the waiting caller with `terminated`. */
  private exclusive<T>(id: string, task: () => Promise<T>, terminated: T): Promise<T> {
    const run = async (): Promise<T> => {
      if (this.phase === 'crashed') return terminated;
      const token = Symbol(id);
      const abort = this.abort.promise;
      this.running = { id, token };
      this.changed();
      try {
        return await Promise.race([task(), abort.then(() => terminated)]);
      } finally {
        if (this.running?.token === token) { this.running = null; this.changed(); }
      }
    };
    const result = this.queue.then(run, run);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
  /** One driver call: serialized, failures as outcomes, then settled (rejects only if the fixture cannot settle). */
  private async drive(id: string, label: string, task: () => Promise<Outcome>): Promise<DriverResult> {
    this.lastResult = `${label}…`;
    const outcome = await this.exclusive(id, async () => {
      try { return await task(); } catch (error) {
        return { ok: false, codes: [error instanceof FixtureStepError ? 'NOT_READY' : 'FIXTURE_ERROR'], message: error instanceof Error ? error.message : String(error) };
      }
    }, TERMINATED);
    this.lastResult = `${label}: ${outcome.ok ? 'done.' : outcome.message}`;
    if (!outcome.ok) this.note(this.lastResult);
    this.changed();
    await this.settle();
    // A host that terminated while the request settled (for example before persisting the display acknowledgement)
    // did not complete the round trip, even when the command itself was accepted.
    if (this.phase === 'crashed' && outcome.ok) return this.facts({ ...outcome, ok: false, codes: ['HOST_TERMINATED'], message: `${label}: the host terminated before the round trip settled.` });
    return this.facts(outcome);
  }
  private facts(outcome: Outcome): DriverResult {
    const projection = this.binding?.getProjection() ?? null;
    return { ...outcome, stage: projection?.stage.id ?? null, context: projection?.context ?? null, activityRevision: projection?.activityRevision ?? null, policyRevision: projection?.policyRevision ?? null };
  }
  private outcome(outcome: CommandOutcome, what: string): Outcome {
    if (outcome.ok) return { ok: true, codes: [], message: `${what}: done.` };
    const first = outcome.diagnostics[0];
    return { ok: false, codes: outcome.diagnostics.map(item => item.code), message: `${what} was refused (${codes(outcome)})${first ? `: ${first.message}` : ''}` };
  }
  private dispatch(command: HostCommand, operationId: string): Promise<CommandOutcome> {
    const { prepared } = this.requirePrepared();
    switch (command.kind) {
      case 'stage': return prepared.host.requestStageTransition({ operationId, ...this.guard(), toStage: command.toStage });
      case 'reveal': return prepared.host.requestReveal({ operationId, ...this.guard(), groups: command.groups });
      case 'scope': return prepared.host.requestExplorationScope({ operationId, ...this.guard(), groups: command.groups, ...(command.parameterDomain ? { parameterDomain: command.parameterDomain } : {}) });
      case 'reopen': return prepared.host.reopenInstructional({ operationId, ...this.guard() });
    }
  }
  /**
   * Sends a receipt-bearing host request with one operation ID, retrying while earlier journal events are still being
   * acknowledged. The request is recorded as pending in the flow state first, so a restart can replay it.
   */
  private async send(command: HostCommand, operationId = this.host.id('fx-op')): Promise<CommandOutcome> {
    const flow = this.flow!;
    flow.pending = { command, operationId };
    this.persistFlow();
    let outcome = await this.dispatch(command, operationId);
    for (let attempt = 0; !outcome.ok && attempt < 5 && outcome.diagnostics.every(item => item.code === 'PERSISTENCE_PENDING') && !this.host.crashed; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 60 * (attempt + 1)));
      outcome = await this.dispatch(command, operationId);
    }
    if (flow !== this.flow) return outcome;
    flow.pending = null;
    this.persistFlow();
    if (outcome.ok) await this.checkpoint();
    return outcome;
  }
  /** Raises the policy ceiling to include `groups` (new revision) and applies it; returns the refusal, if any. */
  private async ensureCeiling(groups: string[]): Promise<CommandOutcome | null> {
    const { prepared, binding } = this.requirePrepared();
    let current = this.host.policy(prepared.activityId)!;
    const missing = groups.filter(group => !current.visibleGroups.includes(group));
    if (missing.length) current = this.host.setPolicy(prepared.activityId, { ...current, revision: current.revision + 1, issuedAt: new Date().toISOString(), visibleGroups: [...current.visibleGroups, ...missing] });
    if (binding.getProjection().policyRevision >= current.revision) return null;
    const outcome = await prepared.host.updatePolicy({ operationId: this.host.id('fx-policy'), policy: current });
    return outcome.ok ? null : outcome;
  }
  /** After a refused policy change, re-issues the previous policy content under a new revision so host and adapter agree again. */
  private async restorePolicy(previous: HostPolicy): Promise<void> {
    const prepared = this.prepared;
    if (!prepared) return;
    const latest = this.host.policy(prepared.activityId)!;
    const policy = this.host.setPolicy(prepared.activityId, { ...previous, revision: latest.revision + 1, issuedAt: new Date().toISOString() });
    await prepared.host.updatePolicy({ operationId: this.host.id('fx-policy'), policy });
  }
  /** Exploration request for the current stage: groups of its interactive controls and every shown group; canonical parameter domains. */
  private explorationRequest(projection: LearnerProjection): { groups: string[]; parameterDomain: Record<string, [number, number]> } {
    const stage = this.stageSpec(projection.stage.id);
    const policy = this.prepared ? this.host.policy(this.prepared.activityId) : null;
    if (!stage || !policy) return { groups: [], parameterDomain: {} };
    const interactive = projection.controls.filter(item => item.mode === 'interactive');
    const groups = new Set<string>(this.shownGroups(projection));
    for (const item of interactive) { const spec = this.template.controls.find(entry => entry.parameter === item.parameter); if (spec) groups.add(spec.group); }
    const manifest = this.catalog.getModel({ modelId: this.template.model.modelId, version: this.template.model.version });
    const parameterDomain: Record<string, [number, number]> = {};
    for (const item of interactive) { const definition = manifest?.parameters[item.parameter]; if (definition) parameterDomain[item.parameter] = [definition.min, definition.max]; }
    return { groups: [...groups].filter(id => Object.hasOwn(stage.visible, id) && policy.visibleGroups.includes(id)), parameterDomain };
  }
  private explorationCovered(projection: LearnerProjection): boolean {
    const { groups } = this.explorationRequest(projection);
    return groups.length > 0 && (this.state()?.exposures ?? []).some(record => record.scope === 'exploration' && record.intendedStage === projection.stage.id
      && record.displayStatus !== 'not-displayed' && groups.every(id => record.groups.some(group => group.groupId === id)));
  }
  private async explore(): Promise<Outcome> {
    const { binding } = this.requirePrepared();
    const { groups, parameterDomain } = this.explorationRequest(binding.getProjection());
    if (!groups.length) return { ok: false, codes: ['INVALID_INPUT'], message: 'Nothing in this stage can be explored.' };
    const domain = Object.keys(parameterDomain).length ? { parameterDomain } : {};
    return this.outcome(await this.send({ kind: 'scope', groups, ...domain }), 'Exploration scope');
  }
  private async authorizeFree(): Promise<Outcome> {
    const { binding } = this.requirePrepared();
    const stage = this.stageSpec(binding.getProjection().stage.id);
    const groups = this.template.groups.filter(group => group.solutionBearing && !!stage && Object.hasOwn(stage.visible, group.id)).map(group => group.id);
    if (groups.length) {
      const refused = await this.ensureCeiling(groups);
      if (refused) return this.outcome(refused, 'Policy update');
      const revealed = await this.send({ kind: 'reveal', groups });
      if (!revealed.ok) return this.outcome(revealed, 'Reveal');
    }
    return this.explore();
  }

  // ---- driver API (host buttons and browser tests) -------------------------------------------------------------
  /** Requests the template transition from the current stage to `toStage` (stage receipt; grants under `policy=full`). */
  transition(toStage: string): Promise<DriverResult> {
    return this.drive(`stage:${toStage}`, `Stage ${toStage}`, async () => {
      this.requirePrepared();
      return this.outcome(await this.send({ kind: 'stage', toStage }), `Stage ${toStage}`);
    });
  }
  /**
   * Requests a reveal of one group. Under `policy=held` the host first raises its policy ceiling for the group when the
   * current instructional stage shows it; otherwise the request goes to the adapter as it is (and may be refused).
   */
  reveal(groupId: string): Promise<DriverResult> {
    const group = this.template.groups.find(item => item.id === groupId);
    return this.drive(`reveal:${groupId}`, `Reveal ${group?.label ?? groupId}`, async () => {
      if (!group) return { ok: false, codes: ['INVALID_REFERENCE'], message: `The template has no group ${JSON.stringify(groupId)}.` };
      const { binding } = this.requirePrepared();
      const projection = binding.getProjection();
      const stage = this.stageSpec(projection.stage.id);
      if (this.policyMode === 'held' && projection.context === 'instructional' && stage && Object.hasOwn(stage.visible, groupId)) {
        const refused = await this.ensureCeiling([groupId]);
        if (refused) return this.outcome(refused, 'Policy update');
      }
      return this.outcome(await this.send({ kind: 'reveal', groups: [groupId] }), `Reveal ${group.label}`);
    });
  }
  /** Requests an exploration scope for the current stage's interactive controls and shown groups (their full parameter domains). */
  authorizeExploration(): Promise<DriverResult> {
    return this.drive('authorize-exploration', ACTION_LABELS['authorize-exploration'], () => this.explore());
  }
  /** Moves the activity into an independent task: neutral scaffold only, no controls; the card then asks for an answer. */
  enterIndependent(): Promise<DriverResult> {
    return this.drive('enter-independent', ACTION_LABELS['enter-independent'], async () => {
      const { prepared, binding } = this.requirePrepared();
      const flow = this.flow!;
      if (binding.getProjection().context === 'independent') return { ok: false, codes: ['CONFLICT'], message: 'The activity is already in an independent task.' };
      const current = this.host.policy(prepared.activityId)!;
      const entry = flow.independentEntries + 1;
      const taskRef = this.taskRef(entry);
      const scaffold = this.scaffold();
      const policy = this.host.setPolicy(prepared.activityId, {
        ...current, revision: current.revision + 1, issuedAt: new Date().toISOString(), visibleGroups: [...scaffold], permittedControls: [],
        independentTask: { active: true, taskRef, permittedTools: ['inspect.learner'], neutralScaffold: [...scaffold] },
      });
      const outcome = await prepared.host.enterIndependentTask({ operationId: this.host.id('fx-independent'), taskRef, policy });
      if (!outcome.ok) { await this.restorePolicy(current); return this.outcome(outcome, 'Independent task'); }
      Object.assign(flow, { independentEntries: entry, ceiling: current.visibleGroups });
      this.say(TEXT.independent);
      this.persistFlow();
      await this.checkpoint();
      return this.outcome(outcome, 'Independent task');
    });
  }
  /** Reopens instructional content from an independent task: a new instructional policy revision, then `reopenInstructional` (assistance). */
  reopen(): Promise<DriverResult> {
    return this.drive('reopen', ACTION_LABELS.reopen, async () => {
      const { prepared, binding } = this.requirePrepared();
      const flow = this.flow!;
      if (binding.getProjection().context !== 'independent') return { ok: false, codes: ['CONFLICT'], message: 'The activity is in an instructional context.' };
      const current = this.host.policy(prepared.activityId)!;
      const policy = this.host.setPolicy(prepared.activityId, {
        ...current, revision: current.revision + 1, issuedAt: new Date().toISOString(), visibleGroups: flow.ceiling ?? this.initialCeiling(),
        permittedControls: this.template.controls.map(item => item.parameter), independentTask: { active: false, taskRef: null, permittedTools: [], neutralScaffold: [] },
      });
      const updated = await prepared.host.updatePolicy({ operationId: this.host.id('fx-reopen-policy'), policy });
      if (!updated.ok) return this.outcome(updated, 'Instructional policy');
      const outcome = await this.send({ kind: 'reopen' });
      if (outcome.ok) { this.say(TEXT.reopened); this.persistFlow(); }
      return this.outcome(outcome, 'Reopen instructional');
    });
  }
  /** Saves a backup or a learner snapshot through the host. */
  save(kind: 'backup' | 'learner-snapshot' = 'backup'): Promise<DriverResult> {
    return this.drive(kind === 'backup' ? 'save-backup' : 'save-snapshot', kind === 'backup' ? ACTION_LABELS['save-backup'] : ACTION_LABELS['save-snapshot'], async () => {
      const saved = await this.saveNow(kind);
      return saved.ok ? { ok: true, codes: [], message: `Saved ${kind} ${saved.artifactId}.`, artifactId: saved.artifactId } : { ok: false, codes: (saved.codes ?? 'NOT_READY').split(', '), message: `Not saved (${saved.codes}).` };
    });
  }
  /** Moves to the template's closed stage when a transition leads there, closes the activity, checkpoints and removes the card. */
  close(): Promise<DriverResult> {
    return this.drive('close', ACTION_LABELS.close, async () => {
      const { prepared, binding } = this.requirePrepared();
      const flow = this.flow!;
      const projection = binding.getProjection();
      const stage = this.stageSpec(projection.stage.id);
      if (projection.context === 'instructional' && stage && stage.kind !== 'closed') {
        const to = this.template.transitions.find(item => item.from === stage.id && this.stageSpec(item.to)?.kind === 'closed');
        if (to) {
          const moved = await this.send({ kind: 'stage', toStage: to.to });
          if (!moved.ok) return this.outcome(moved, `Stage ${to.to}`);
        }
      }
      const closed = await prepared.host.close({ operationId: this.host.id('fx-close'), reason: 'The host closed the activity (integration fixture).' });
      if (!closed.ok) return this.outcome(closed, 'Close');
      await this.checkpoint(true);
      this.detachCard();
      this.adapter.dispose(prepared.activityId);
      this.prepared = null;
      flow.closed = true;
      this.say(TEXT.closed);
      this.persistFlow();
      return this.outcome(closed, 'Close');
    });
  }
  /** Submits host-owned response text for the current request; the activity receives only the reference. */
  respond(text: string): Promise<DriverResult> {
    return this.drive('response', 'Response', () => this.recordResponse(text));
  }
  /** Composer submission (the card's response slot). */
  async submitResponse(text: string): Promise<{ ok: boolean; message: string }> {
    const result = await this.respond(text).catch((error: unknown) => ({ ok: false, message: error instanceof Error ? error.message : String(error) }));
    return { ok: result.ok, message: result.message };
  }
  private async recordResponse(text: string): Promise<Outcome> {
    const request = this.responseRequest();
    const prepared = this.prepared, state = this.state();
    if (!request || request.recorded || !prepared || !state) return { ok: false, codes: ['NOT_READY'], message: 'No response is requested now.' };
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, codes: ['INVALID_INPUT'], message: 'Write a response before submitting.' };
    const taskId = request.kind === 'answer' ? this.taskRef(this.flow!.independentEntries) : this.stageSpec(state.instance.stage.id)!.response!.taskFamily;
    const ref = this.host.recordResponse({ activityId: prepared.activityId, kind: request.kind, stageId: state.instance.stage.id, taskId, text: trimmed });
    if (request.kind === 'answer') this.host.bindSnapshot(ref.responseId, prepared.host.freezeAssistanceSnapshot({ responseId: ref.responseId }).cursor);
    const expected = state.instance.hostSessionRevision;
    // The host's response transaction produces the next host session revision; the activity adopts it (report §4.2).
    const next = Math.max(this.host.hostSessionRevision, expected) + 1;
    const outcome = await prepared.host.submitResponseRef({ operationId: this.host.id('fx-response'), response: ref, expectedHostSessionRevision: expected, hostSessionRevision: next });
    if (!outcome.ok) { this.host.discardResponse(ref.responseId); return { ok: false, codes: outcome.diagnostics.map(item => item.code), message: `The host could not record the response (${codes(outcome)}).` }; }
    this.host.advanceHostSession(next);
    this.note(`${request.label} recorded by the host (${ref.responseId}).`);
    await this.checkpoint();
    return { ok: true, codes: [], message: `${request.label} recorded (${ref.responseId}).` };
  }
  /**
   * In-page host restart: pending requests are released as terminated, the card and adapter go away, a new host instance
   * loads the persisted tables (restart rule: authorized without a persisted acknowledgement → uncertain) and the
   * activity reopens from the host's latest checkpoint.
   */
  /**
   * Fixture host action: revokes the selected template in the installed catalogue, then restarts the host. The restore
   * is refused with CONTENT_REVOKED and the saved activity is shown as its archival read-only record.
   */
  async revokeCatalogueAndRestart(): Promise<DriverResult> {
    this.catalogRevoked = true;
    this.persistFlow();
    return this.restartHost();
  }
  async restartHost(): Promise<DriverResult> {
    this.abortPending();
    this.replaceHost();
    this.phase = 'starting';
    this.error = null;
    this.watchKey = '';
    this.changed();
    await this.boot();
    await this.settle();
    // Read through the snapshot type: `boot()` changed the phase (control-flow narrowing does not see that).
    const phase = this.phase as GenericSnapshot['phase'];
    return this.facts(phase === 'running' ? { ok: true, codes: [], message: 'The host restarted.' } : { ok: false, codes: ['NOT_READY'], message: this.error ?? 'The host did not restart.' });
  }
}
