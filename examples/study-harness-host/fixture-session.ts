/**
 * BROWSER INTEGRATION FIXTURE — the scripted quadratic learning-and-return session (report §6.1, §12.6, §17).
 *
 * This is a conformance fixture for the Study Harness boundary, not a tutor and not evidence of learning benefit. The
 * "tutor" messages are fixed, scripted text; nothing evaluates, grades or interprets a response. The page plays the
 * host: it issues policies, owns the stage buttons and the response composer, stores response text in its own tables
 * and passes only response references to the activity.
 *
 * Required quadratic flow (guided mode): collect a prediction with the trace hidden → enable step-size exploration
 * (stage receipt + exploration scope) → reveal the trace under an updated host policy (persist-before-reveal) → add the
 * curvature control → request an explanation through the host composer → close the instructional view → start a new,
 * independent changed-representation task with the teaching visual unavailable (neutral scaffold only).
 * `?mode=free` instead opens an authorized free-exploration activity.
 *
 * Every host step is idempotent and resumable: each sub-operation checks the activity state first and reuses a
 * deterministic operation ID, so a step interrupted by a host crash is resumed after the restart with the same
 * idempotency keys and the host returns the receipts it already committed instead of issuing new ones.
 *
 * Host, catalogue, adapter, card lifecycle and checkpoints are the shared runtime (`fixture-runtime.ts`). This flow
 * keeps its host composer in the host column (outside the card); the generic flow demonstrates the card's response
 * slot (report §10.1).
 */
import { type ActivityBinding, type CommandOutcome, type LearnerProjection } from '@explorable-models/activity';
import { quadraticGradientDescentTemplate as template } from '@explorable-models/catalog';
import { mountStudyActivity, type MountedStudyActivity } from '@explorable-models/player/activity';
import { codes, FixtureRuntime, FixtureStepError, LEARNER_TOOLS, type FixtureMessage, type FixtureOptions } from './fixture-runtime';

export { type FixtureMessage, type FixtureOptions, type ProjectionLogEntry } from './fixture-runtime';

// ---------------------------------------------------------------------------------------------
// Flow vocabulary
// ---------------------------------------------------------------------------------------------
export type StepId = 'enable-exploration' | 'reveal-trace' | 'add-curvature' | 'request-explanation' | 'close' | 'independent-task' | 'authorize-free';
export type ResponseKind = 'prediction' | 'explanation' | 'answer';
export const STEP_LABELS: Record<StepId, string> = {
  'enable-exploration': 'Enable step-size exploration',
  'reveal-trace': 'Reveal the iteration trace',
  'add-curvature': 'Add the curvature control',
  'request-explanation': 'Request an explanation',
  close: 'Close the instructional view',
  'independent-task': 'Start the independent task',
  'authorize-free': 'Authorize free exploration',
};
const STEPS: Record<FixtureOptions['mode'], StepId[]> = {
  guided: ['enable-exploration', 'reveal-trace', 'add-curvature', 'request-explanation', 'close', 'independent-task'],
  free: ['authorize-free', 'close'],
};
/** Response the learner gives through the host composer before a step can run. */
const NEEDS: Partial<Record<StepId, ResponseKind>> = { 'enable-exploration': 'prediction', close: 'explanation' };

interface FlowState {
  mode: FixtureOptions['mode'];
  activityId: string;
  taskActivityId: string | null;
  current: 'instructional' | 'task' | 'none';
  done: StepId[];
  attempts: Partial<Record<StepId, number>>;
  running: StepId | null;
  awaiting: ResponseKind | null;
  responses: Partial<Record<ResponseKind, string>>;
  messages: FixtureMessage[];
  interrupted: boolean;
  complete: boolean;
}

/** Scripted, deterministic messages (fixture text; neutral, no answers, no evaluation). */
const SCRIPT = {
  guidedStart: 'Before any iterations are shown: with curvature a = 2 and start x₀ = 4, what do you expect the positions xₙ to do over the first few updates for the step sizes η = 0.25, 0.75 and 1.25? Write your prediction in the response box.',
  predictionRecorded: 'Your prediction is recorded by the host. Next, the host enables the step-size control.',
  explorationEnabled: 'You can now change the step size η. The iterations stay hidden until the host has recorded that they are shown.',
  traceRevealed: 'The iterations are now shown. Step through them and compare the positions with your prediction; the scenarios set η = 0.25, 0.75 and 1.25.',
  curvatureAdded: 'Now change the curvature a as well. Notice how the step sizes that give each kind of behaviour change with a.',
  explanationRequested: 'In your own words: how do η and a together determine whether the positions shrink, change sign, keep the same size or grow? Use the response box.',
  explanationRecorded: 'Your explanation is recorded by the host. Next, the host closes the instructional view.',
  closed: 'The instructional view is closed. The next task is independent: the teaching visual is not available for it.',
  task: 'Independent task (host-owned): the recurrence is xₙ₊₁ = (1 − η·a)·xₙ with a = 5, η = 0.3 and x₀ = 4. Predict x₃ and write it in the response box. Work from the recurrence; the teaching visual is not available.',
  answerRecorded: 'Your answer is recorded by the host together with a frozen assistance snapshot. This fixture does not evaluate it.',
  freeStart: 'Free exploration is authorized by the host: every control, the iteration trace, the regime and the substituted rule are available. Nothing here is graded.',
  freeClosed: 'The free-exploration activity is closed.',
  interrupted: 'The host moved this activity into an independent-task context; instructional content and pending reveals were withdrawn.',
  revoked: 'The host revoked the policy for this activity. Nothing new is shown until the host issues a new policy.',
  reopened: 'The host reopened the teaching visual; this is recorded as assistance and does not change an answer already submitted.',
} as const;
const COMPOSER: Record<ResponseKind, { label: string; prompt: string; taskId: string }> = {
  prediction: { label: 'Your prediction', prompt: 'What do you expect the positions to do for η = 0.25, 0.75 and 1.25 (a = 2, x₀ = 4), and why?', taskId: 'quadratic-step-size-prediction' },
  explanation: { label: 'Your explanation', prompt: 'How do η and a together determine what the positions do?', taskId: 'quadratic-step-size-explanation' },
  answer: { label: 'Your answer', prompt: 'Predict x₃ for xₙ₊₁ = (1 − η·a)·xₙ with a = 5, η = 0.3, x₀ = 4.', taskId: 'quadratic-recurrence-task-1' },
};
const TASK = { taskRef: 'quadratic-recurrence-task-1', parameters: { a: 5, eta: 0.3, x0: 4 }, scaffold: ['update-rule'] } as const;
/** Solution-bearing groups the prediction policy holds back until the host reveals them. */
const HELD_BACK = ['trace', 'observations', 'regime', 'substituted-rule'];
const INSTRUCTIONAL_REVEAL = ['trace', 'observations', 'substituted-rule'];

export interface SessionSnapshot {
  kind: 'scripted';
  phase: 'starting' | 'running' | 'crashed' | 'failed';
  error: string | null;
  mode: FixtureOptions['mode'];
  steps: { id: StepId; label: string; state: 'done' | 'next' | 'blocked' | 'later' | 'running'; reason: string | null }[];
  messages: FixtureMessage[];
  composer: { kind: ResponseKind; label: string; prompt: string } | null;
  composerStatus: string;
  hostLog: string[];
  activityId: string | null;
  cardMounted: boolean;
  restoredNotes: string[];
  interruptedStep: StepId | null;
  complete: boolean;
  version: number;
}

/** The scripted quadratic fixture session: host, adapter, scripted flow and the one mounted learner card. */
export class FixtureSession extends FixtureRuntime<SessionSnapshot> {
  private flow!: FlowState;
  /** Composer feedback for one response kind (shown only while that response is requested). */
  private composerStatus: { kind: ResponseKind; text: string } | null = null;
  private interruptedStep: StepId | null = null;
  /** Step running in this page instance (a persisted `flow.running` without it marks a step interrupted by a restart). */
  private activeStep: StepId | null = null;

  constructor(options: FixtureOptions) {
    super(options, template, `scripted:${template.templateId}`);
  }

  protected busy(): boolean { return this.activeStep !== null; }
  protected mountCard(container: HTMLElement, binding: ActivityBinding, surfaceId: string): MountedStudyActivity {
    return mountStudyActivity(container, this.cardOptions(binding, surfaceId));
  }
  private persistFlow(): void { this.persistSession({ flow: this.flow }); }
  private say(kind: FixtureMessage['kind'], text: string): void {
    if (this.flow.messages.some(message => message.text === text)) return;
    this.flow.messages = [...this.flow.messages, { id: `m${this.flow.messages.length + 1}`, kind, text }];
  }
  private opId(step: string, sub: string): string {
    const attempt = this.flow.attempts[step as StepId] ?? 0;
    return `fx-${this.host.nonce}-${step}-${sub}-${attempt}`.slice(0, 128);
  }

  protected snapshot(): SessionSnapshot {
    const flow = this.flow;
    const steps = flow ? STEPS[flow.mode].map(id => {
      const done = flow.done.includes(id);
      const next = !done && STEPS[flow.mode].find(step => !flow.done.includes(step)) === id;
      const need = flow.mode === 'guided' ? NEEDS[id] : undefined;
      const blockedReason = flow.interrupted ? 'The activity was moved into an independent context.'
        : need && !flow.responses[need] ? `Waiting for the learner's ${need} in the response box.`
          : flow.running && flow.running !== id ? 'Another host step is running.' : null;
      const state: SessionSnapshot['steps'][number]['state'] = done ? 'done' : this.activeStep === id ? 'running' : next ? (blockedReason ? 'blocked' : 'next') : 'later';
      return { id, label: STEP_LABELS[id], state, reason: state === 'blocked' ? blockedReason : null };
    }) : [];
    const awaiting = flow?.awaiting ?? null;
    return {
      kind: 'scripted', phase: this.phase, error: this.error, mode: flow?.mode ?? this.options.mode, steps, messages: flow?.messages ?? [],
      composer: awaiting && this.phase === 'running' ? { kind: awaiting, ...COMPOSER[awaiting] } : null, composerStatus: awaiting && this.composerStatus?.kind === awaiting ? this.composerStatus.text : '',
      hostLog: this.hostLog, activityId: this.currentActivityId(), cardMounted: this.surface !== null, restoredNotes: this.restoredNotes,
      interruptedStep: this.interruptedStep, complete: flow?.complete ?? false, version: this.version,
    };
  }
  private currentActivityId(): string | null {
    if (!this.flow || this.flow.current === 'none') return null;
    return this.flow.current === 'task' ? this.flow.taskActivityId : this.flow.activityId;
  }

  // ---- lifecycle --------------------------------------------------------------------------------------------
  /** Starts a new fixture session, or restarts the one kept in sessionStorage. */
  async start(container: HTMLElement): Promise<void> {
    this.container = container;
    this.showPlaceholder('preparing');
    const kept = this.host.session<{ flow?: FlowState }>().flow;
    try {
      if (kept && this.host.restarted) await this.restart(kept);
      else await this.fresh();
      this.phase = this.host.crashed ? 'crashed' : 'running';
      const policy = this.prepared ? this.host.policy(this.prepared.activityId) : null;
      if (this.options.revoke && policy && !policy.revoked && !this.flow.done.length) await this.revokePolicy();
    } catch (error) {
      if (this.phase !== 'crashed') { this.phase = 'failed'; this.error = error instanceof Error ? error.message : String(error); }
    }
    this.changed();
  }

  private async fresh(): Promise<void> {
    const mode = this.options.mode;
    const activityId = `fx-${this.host.nonce}-quadratic`;
    this.flow = {
      mode, activityId, taskActivityId: null, current: 'instructional', done: [], attempts: {}, running: null, awaiting: mode === 'guided' ? 'prediction' : null,
      responses: {}, messages: [], interrupted: false, complete: false,
    };
    this.say('scripted', mode === 'guided' ? SCRIPT.guidedStart : SCRIPT.freeStart);
    this.persistFlow();
    this.applyInjections(true);
    // The prediction policy holds back every solution-bearing group; free exploration authorizes all of them.
    const visible = mode === 'guided' ? this.allGroups().filter(id => !HELD_BACK.includes(id)) : this.allGroups();
    this.host.setPolicy(activityId, this.policy(activityId, 1, visible));
    const prepared = await this.adapter.prepare({
      activityId, objectiveIds: ['quadratic-step-size'], hostSessionId: `fx-${this.host.nonce}`, hostSessionRevision: this.host.hostSessionRevision,
      template: { templateId: template.templateId, version: template.version }, mode: 'approved', ...(mode === 'free' ? { stageId: 'free-explore' } : {}),
    }, { operationId: `fx-${this.host.nonce}-prepare` });
    if (!prepared.ok) throw new FixtureStepError(`The activity could not be prepared (${codes(prepared)}).`);
    this.attach(prepared.prepared);
    this.note(`Prepared ${activityId} (${mode}).`);
    if (mode === 'free') await this.runStep('authorize-free');
  }

  private async restart(kept: FlowState): Promise<void> {
    this.flow = kept;
    this.applyInjections(false);
    const crash = this.host.lastCrash;
    this.note(`Host restarted (start ${this.host.starts})${crash ? `; the previous run terminated at ${crash.point}` : ''}.`);
    if (kept.running) this.interruptedStep = kept.running;
    const activityId = this.currentActivityId();
    if (!activityId) { this.persistFlow(); return; }
    const artifact = this.host.latestBackup(activityId);
    if (!artifact) {
      // Terminated before the first checkpoint of this activity: it cannot be reopened; the step runs again with a new activity.
      if (kept.current === 'task') { this.flow.taskActivityId = null; this.flow.current = 'none'; this.flow.done = this.flow.done.filter(step => step !== 'independent-task'); this.flow.awaiting = null; }
      this.note(`No checkpoint exists for ${activityId}; it is not reopened.`);
      this.persistFlow();
      return;
    }
    const restored = await this.adapter.restore(artifact, { operationId: this.host.id('fx-restore'), hostSessionRevision: this.host.hostSessionRevision });
    if (!restored.ok && this.showArchival(artifact, restored)) { this.persistFlow(); return; }
    if (!restored.ok) throw new FixtureStepError(`The saved activity could not be restored (${codes(restored)}).`);
    this.restoredNotes = restored.report.notes;
    this.note(`Restored ${activityId} (${restored.report.restored}).`);
    this.attach(restored.prepared);
    this.persistFlow();
  }

  // ---- learner responses through the host composer ----------------------------------------------------------
  async submitResponse(text: string): Promise<boolean> {
    const kind = this.flow.awaiting;
    const prepared = this.prepared, state = this.state();
    if (!kind || !prepared || !state) return false;
    const trimmed = text.trim();
    if (!trimmed) { this.composerStatus = { kind, text: 'Write a response before submitting.' }; this.changed(); return false; }
    const ref = this.host.recordResponse({ activityId: prepared.activityId, kind, stageId: state.instance.stage.id, taskId: COMPOSER[kind].taskId, text: trimmed });
    if (kind === 'answer') this.host.bindSnapshot(ref.responseId, prepared.host.freezeAssistanceSnapshot({ responseId: ref.responseId }).cursor);
    const expected = state.instance.hostSessionRevision;
    // The host's response transaction produces the next host session revision; the activity adopts it (report §4.2).
    const next = Math.max(this.host.hostSessionRevision, expected) + 1;
    const outcome = await prepared.host.submitResponseRef({ operationId: this.host.id('fx-response'), response: ref, expectedHostSessionRevision: expected, hostSessionRevision: next });
    if (!outcome.ok) {
      this.host.discardResponse(ref.responseId);
      this.composerStatus = { kind, text: `The host could not record the response (${codes(outcome)}).` };
      this.changed();
      return false;
    }
    this.host.advanceHostSession(next);
    this.flow.responses = { ...this.flow.responses, [kind]: ref.responseId };
    this.flow.awaiting = null;
    if (kind === 'prediction') this.say('scripted', SCRIPT.predictionRecorded);
    if (kind === 'explanation') this.say('scripted', SCRIPT.explanationRecorded);
    if (kind === 'answer') { this.say('scripted', SCRIPT.answerRecorded); this.flow.complete = this.flow.current === 'task'; }
    this.composerStatus = null;
    this.note(`${COMPOSER[kind].label} recorded by the host (${ref.responseId}).`);
    this.persistFlow();
    this.changed();
    return true;
  }

  // ---- host steps -------------------------------------------------------------------------------------------
  /** Runs (or resumes) one host step; resolves with null on success or the learner-safe failure text. */
  async runStep(step: StepId): Promise<string | null> {
    if (this.phase === 'crashed') return 'The host terminated.';
    if (this.activeStep || this.flow.running && this.flow.running !== step) return 'Another host step is running.';
    if (this.flow.done.includes(step)) return null;
    const need = this.flow.mode === 'guided' ? NEEDS[step] : undefined;
    if (need && !this.flow.responses[need]) return `Waiting for the learner's ${need}.`;
    this.flow.running = step;
    this.activeStep = step;
    this.persistFlow();
    this.changed();
    await this.savesSettled();
    try {
      switch (step) {
        case 'enable-exploration': await this.enableExploration(); break;
        case 'reveal-trace': await this.revealTrace(); break;
        case 'add-curvature': await this.addCurvature(); break;
        case 'request-explanation': await this.requestExplanation(); break;
        case 'close': await this.closeInstructional(); break;
        case 'independent-task': await this.startIndependentTask(); break;
        case 'authorize-free': await this.authorizeFree(); break;
      }
    } catch (error) {
      if (this.host.crashed) return 'The host terminated.';
      this.activeStep = null;
      this.flow.running = null;
      this.flow.attempts = { ...this.flow.attempts, [step]: (this.flow.attempts[step] ?? 0) + 1 };
      this.persistFlow();
      const message = error instanceof Error ? error.message : String(error);
      this.note(`${STEP_LABELS[step]} failed: ${message}`);
      return message;
    }
    if (this.host.crashed) return 'The host terminated.';
    this.activeStep = null;
    this.flow.running = null;
    this.flow.done = [...this.flow.done, step];
    if (this.interruptedStep === step) this.interruptedStep = null;
    this.persistFlow();
    this.note(`${STEP_LABELS[step]}: done.`);
    this.scheduleCheckpoint();
    return null;
  }

  /** Waits until `done()` holds for the current projection (for example after the learner retried a failed reveal). */
  private waitFor(done: (projection: LearnerProjection) => boolean, what: string): Promise<void> {
    const { binding } = this.requirePrepared();
    if (done(binding.getProjection())) return Promise.resolve();
    this.note(`Waiting: ${what}.`);
    return new Promise((resolve, reject) => {
      const stop = binding.subscribe(projection => {
        if (done(projection)) { stop(); resolve(); }
        else if (projection.status.ui === 'disposed' || projection.status.ui === 'stale-policy' || projection.context === 'independent' && this.flow.current === 'instructional') { stop(); reject(new FixtureStepError(`Stopped waiting: ${what}.`)); }
      });
    });
  }
  /**
   * Runs a host command, then checkpoints. Unacknowledged journal events (`PERSISTENCE_PENDING`) are flushed and the
   * same command retried a few times; a failed reveal intent stays pending in the activity until it is retried (from
   * the card or the host panel) and the step waits for that.
   */
  private async command(run: () => Promise<CommandOutcome>, settled: (projection: LearnerProjection) => boolean, what: string): Promise<void> {
    let outcome = await run();
    for (let attempt = 0; !outcome.ok && attempt < 5 && outcome.diagnostics.every(item => item.code === 'PERSISTENCE_PENDING') && !this.host.crashed; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 60 * (attempt + 1)));
      outcome = await run();
    }
    if (outcome.ok) { await this.checkpoint(); return; }
    if (this.host.crashed) throw new FixtureStepError('The host terminated.');
    const pending = this.requirePrepared().binding.getProjection().pendingReveal?.state === 'failed';
    if (pending && outcome.diagnostics.some(item => item.code === 'PERSISTENCE_FAILED')) {
      this.note(`${what}: the host did not record the request (${codes(outcome)}); it stays pending until it is retried.`);
      this.changed();
      await this.waitFor(settled, `${what} after a retry`);
      await this.checkpoint();
      return;
    }
    throw new FixtureStepError(`${what} was refused (${codes(outcome)}).`);
  }

  private async transition(step: StepId, toStage: string): Promise<void> {
    const { prepared, binding } = this.requirePrepared();
    const at = (projection: LearnerProjection) => projection.stage.id === toStage && !projection.pendingReveal;
    if (binding.getProjection().stage.id === toStage) return;
    await this.command(() => prepared.host.requestStageTransition({ operationId: this.opId(step, `stage-${toStage}`), ...this.guard(), toStage }), at, `Stage ${toStage}`);
  }
  private async ensurePolicy(step: StepId, visible: string[]): Promise<void> {
    const { prepared, binding } = this.requirePrepared();
    const activityId = prepared.activityId;
    let current = this.host.policy(activityId)!;
    if (!visible.every(id => current.visibleGroups.includes(id))) current = this.host.setPolicy(activityId, { ...current, revision: current.revision + 1, issuedAt: new Date().toISOString(), visibleGroups: [...new Set([...current.visibleGroups, ...visible])] });
    if (binding.getProjection().policyRevision >= current.revision) return;
    const outcome = await prepared.host.updatePolicy({ operationId: this.opId(step, `policy-${current.revision}`), policy: current });
    if (!outcome.ok) throw new FixtureStepError(`The policy update was refused (${codes(outcome)}).`);
  }
  private async reveal(step: StepId, groups: string[]): Promise<void> {
    const { prepared, binding } = this.requirePrepared();
    const visible = (projection: LearnerProjection) => groups.every(id => this.shownGroups(projection).has(id));
    const shown = (projection: LearnerProjection) => !projection.pendingReveal && visible(projection);
    if (visible(binding.getProjection())) return;
    await this.command(() => prepared.host.requestReveal({ operationId: this.opId(step, 'reveal'), ...this.guard(), groups }), shown, 'Reveal');
  }
  private async scope(step: StepId, groups: string[], parameterDomain: Record<string, [number, number]>): Promise<void> {
    const { prepared } = this.requirePrepared();
    const covered = () => {
      const state = this.state();
      const stage = state?.instance.stage.id;
      return (state?.exposures ?? []).some(record => record.scope === 'exploration' && record.intendedStage === stage && record.displayStatus !== 'not-displayed'
        && groups.every(id => record.groups.some(group => group.groupId === id)) && Object.keys(parameterDomain).every(id => !!record.parameterDomain && id in record.parameterDomain));
    };
    if (covered()) return;
    await this.command(() => prepared.host.requestExplorationScope({ operationId: this.opId(step, `scope-${this.requirePrepared().binding.getProjection().stage.id}`), ...this.guard(), groups, parameterDomain }), () => covered(), 'Exploration scope');
  }

  private async enableExploration(): Promise<void> {
    await this.transition('enable-exploration', 'explore-step');
    await this.scope('enable-exploration', ['step-control'], { eta: [0, 2] });
    this.say('scripted', SCRIPT.explorationEnabled);
  }
  private async revealTrace(): Promise<void> {
    await this.ensurePolicy('reveal-trace', INSTRUCTIONAL_REVEAL);
    await this.reveal('reveal-trace', ['trace', 'observations']);
    await this.scope('reveal-trace', ['step-control', 'trace', 'observations'], { eta: [0, 2] });
    this.say('scripted', SCRIPT.traceRevealed);
  }
  private async addCurvature(): Promise<void> {
    await this.ensurePolicy('add-curvature', INSTRUCTIONAL_REVEAL);
    await this.transition('add-curvature', 'explore-curvature');
    await this.scope('add-curvature', ['step-control', 'curvature-control', 'trace', 'observations', 'substituted-rule'], { eta: [0, 2], a: [0.1, 10] });
    this.say('scripted', SCRIPT.curvatureAdded);
  }
  private async requestExplanation(): Promise<void> {
    await this.transition('request-explanation', 'explain');
    if (!this.flow.responses.explanation) this.flow.awaiting = 'explanation';
    this.say('scripted', SCRIPT.explanationRequested);
  }
  private async authorizeFree(): Promise<void> {
    await this.reveal('authorize-free', HELD_BACK);
    const groups = ['step-control', 'curvature-control', 'start-control', ...HELD_BACK];
    await this.scope('authorize-free', groups, { eta: [0, 2], a: [0.1, 10], x0: [-10, 10] });
  }
  private async closeInstructional(): Promise<void> {
    const { prepared, binding } = this.requirePrepared();
    if (binding.getProjection().stage.id !== 'closed' && !this.state()?.instance.closed) await this.transition('close', 'closed');
    const state = this.state();
    if (state && !state.instance.closed) {
      const outcome = await prepared.host.close({ operationId: this.opId('close', 'close'), reason: 'The host closed the instructional view.' });
      if (!outcome.ok) throw new FixtureStepError(`Closing was refused (${codes(outcome)}).`);
    }
    await this.checkpoint(true);
    this.detachCard();
    this.adapter.dispose(prepared.activityId);
    this.prepared = null;
    this.flow.current = 'none';
    this.say('host', this.flow.mode === 'guided' ? SCRIPT.closed : SCRIPT.freeClosed);
    if (this.flow.mode === 'free') this.flow.complete = true;
  }
  private async startIndependentTask(): Promise<void> {
    const taskId = this.flow.taskActivityId ?? `fx-${this.host.nonce}-task-${this.host.starts}`;
    this.flow.taskActivityId = taskId;
    this.persistFlow();
    if (!this.prepared || this.prepared.activityId !== taskId) {
      if (!this.host.policy(taskId)) this.host.setPolicy(taskId, this.policy(taskId, 1, this.allGroups().filter(id => !HELD_BACK.includes(id))));
      const prepared = await this.adapter.prepare({
        activityId: taskId, objectiveIds: ['quadratic-step-size'], hostSessionId: `fx-${this.host.nonce}`, hostSessionRevision: this.host.hostSessionRevision,
        template: { templateId: template.templateId, version: template.version }, parameters: { ...TASK.parameters }, mode: 'approved',
      }, { operationId: this.opId('independent-task', 'prepare') });
      if (!prepared.ok) throw new FixtureStepError(`The task activity could not be prepared (${codes(prepared)}).`);
      this.prepared = prepared.prepared;
    }
    const prepared = this.prepared;
    // Enter the independent context before any surface exists, so no instructional content is ever displayed.
    const instance = prepared.instance;
    if (instance.context.kind !== 'independent') {
      const current = this.host.policy(taskId)!;
      const policy = current.independentTask.active ? current : this.host.setPolicy(taskId, {
        ...current, revision: current.revision + 1, issuedAt: new Date().toISOString(), visibleGroups: [...TASK.scaffold], permittedControls: [],
        allowedTools: [...LEARNER_TOOLS], independentTask: { active: true, taskRef: TASK.taskRef, permittedTools: ['inspect.learner'], neutralScaffold: [...TASK.scaffold] },
        export: { learnerSnapshot: true, capture: false, backup: true },
      });
      const outcome = await prepared.host.enterIndependentTask({ operationId: this.opId('independent-task', 'enter'), taskRef: TASK.taskRef, policy });
      if (!outcome.ok) throw new FixtureStepError(`The independent context was refused (${codes(outcome)}).`);
    }
    this.flow.current = 'task';
    this.attach(prepared);
    await this.checkpoint();
    this.say('scripted', SCRIPT.task);
    if (!this.flow.responses.answer) this.flow.awaiting = 'answer';
  }

  // ---- fixture controls -------------------------------------------------------------------------------------
  protected policyRevoked(): void {
    this.say('host', SCRIPT.revoked);
    this.persistFlow();
  }
  /** Moves the open instructional activity into an independent context (interrupt control). */
  async interruptWithIndependentTask(): Promise<string | null> {
    const prepared = this.prepared;
    if (!prepared) return 'No activity is open.';
    const current = this.host.policy(prepared.activityId)!;
    const policy = this.host.setPolicy(prepared.activityId, {
      ...current, revision: current.revision + 1, issuedAt: new Date().toISOString(), visibleGroups: [...TASK.scaffold], permittedControls: [],
      independentTask: { active: true, taskRef: TASK.taskRef, permittedTools: ['inspect.learner'], neutralScaffold: [...TASK.scaffold] },
    });
    const outcome = await prepared.host.enterIndependentTask({ operationId: this.host.id('fx-interrupt'), taskRef: TASK.taskRef, policy });
    if (!outcome.ok) return `Refused (${codes(outcome)}).`;
    this.flow.interrupted = true;
    // The host's independent task asks for an answer through its own composer.
    this.flow.awaiting = this.flow.responses.answer ? null : 'answer';
    this.say('host', SCRIPT.interrupted);
    this.say('scripted', SCRIPT.task);
    this.persistFlow();
    this.changed();
    return null;
  }
  /**
   * Reopens the teaching visual of an activity in an independent context. The host first issues an instructional
   * policy revision, then the reopening goes through `recordAssistance` before anything is shown again (report §6.4).
   */
  async reopenInstructional(): Promise<string | null> {
    const prepared = this.prepared, binding = this.binding;
    if (!prepared || !binding) return 'No activity is open.';
    if (binding.getProjection().context !== 'independent') return 'The activity is not in an independent context.';
    const current = this.host.policy(prepared.activityId)!;
    const policy = this.host.setPolicy(prepared.activityId, {
      ...current, revision: current.revision + 1, issuedAt: new Date().toISOString(),
      visibleGroups: this.allGroups().filter(id => !HELD_BACK.includes(id) || INSTRUCTIONAL_REVEAL.includes(id)), permittedControls: template.controls.map(control => control.parameter),
      independentTask: { active: false, taskRef: null, permittedTools: [], neutralScaffold: [] },
    });
    const updated = await prepared.host.updatePolicy({ operationId: this.host.id('fx-reopen-policy'), policy });
    if (!updated.ok) return `Policy refused (${codes(updated)}).`;
    const outcome = await prepared.host.reopenInstructional({ operationId: this.host.id('fx-reopen'), ...this.guard() });
    if (!outcome.ok) { this.note(`Reopening refused (${codes(outcome)}).`); return `Refused (${codes(outcome)}).`; }
    this.flow.awaiting = null;
    this.say('host', SCRIPT.reopened);
    this.persistFlow();
    this.changed();
    return null;
  }
}
