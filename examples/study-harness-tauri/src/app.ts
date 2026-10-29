// Reference host application logic (conformance fixture). It plays a Study Harness host around the learner card: it
// opens approved activities, owns the stage controls (generated from the template's transitions), the response composer,
// reveal and exploration authorization, saving, closing, the independent task and the assistance-recorded reopening.
// The Rust host owns every record and every authority decision; this module only sequences host steps.
//
// Host steps use deterministic operation IDs (activity, activity revision, policy revision, step) so a step interrupted
// by a process termination is resumed after the relaunch with the same idempotency key, and the native host returns the
// receipt it already committed instead of issuing a second one.
//
// The library is used through `createStudyHarnessVisualizer` (@experiment-kit/player/activity): one supported API for
// prepare/restore, mounting the learner surface, audience state and disposal around the adapter and the HostPort.
// While an activity is prepared or restored the card area shows `mountStudyActivityPlaceholder` (`preparing`, or `empty`
// with nothing open); a restore refused because the saved content is not installed or no longer approved
// (UNSUPPORTED_ARTIFACT, CONTENT_REVOKED) shows the artifact's archival read-only record instead (`archivalView` +
// `mountArchivalRecord`: nothing evaluated, no controls, no other template substituted). Spatial activities load the
// packed `@experiment-kit/player-3d` chunk through `spatialLoader` (src/spatial.ts).
import {
  archivalView,
  type ActivityBinding, type ActivityTemplate, type AudienceState, type CommandOutcome, type Diagnostic, type ExposureRecord, type HostPolicy, type LearnerProjection,
  type ModelManifest, type PreparedActivity, type RestoreResult,
} from '@experiment-kit/activity';
import { createInstalledCatalog, type InstalledCatalog } from '@experiment-kit/catalog';
import {
  archivalLabels, createStudyHarnessVisualizer, mountArchivalRecord, mountStudyActivityPlaceholder,
  type MountedArchivalRecord, type MountedStudyActivityPlaceholder, type StudyHarnessSurface, type StudyHarnessVisualizer, type SurfaceDiagnostic, type SurfaceErrorEvent,
} from '@experiment-kit/player/activity';
import { composerElement } from './composer';
import { NativeHostError } from './native-bridge';
import { hostCommands, NativeHostPort, type ExportedBackup, type HostActivitySummary, type HostStatus, type ImportableBackup, type ImportSummary } from './native-host';
import { loadSpatialRenderer } from './spatial';

export interface CurrentActivity {
  activityId: string;
  kind: HostActivitySummary['kind'];
  taskRef: string | null;
  template: ActivityTemplate;
  manifest: ModelManifest;
}
export interface HostSnapshot {
  phase: 'starting' | 'ready' | 'failed';
  error: string | null;
  busy: string | null;
  status: HostStatus | null;
  activities: HostActivitySummary[];
  backups: ImportableBackup[];
  current: CurrentActivity | null;
  projection: LearnerProjection | null;
  lastExport: ExportedBackup | null;
  lastImport: ImportSummary | null;
  restoredNotes: string[];
  /** The preview that was pending when the restored backup was saved (never committed by the restore), for the host to re-offer. */
  pendingDraft: NonNullable<RestoreResult['report']['pendingDraft']> | null;
  /** A restore the library refused for unsupported or revoked content: the archival record shown instead of the card. */
  archival: { activityId: string; artifactId: string; codes: string[] } | null;
  /** How Close resolves an active preview (host policy, report §14): cancel it, commit it, or end it and retain the draft. */
  closePending: ClosePending;
  composerStatus: string;
  log: string[];
  version: number;
}
export type ClosePending = 'cancel' | 'commit' | 'retain';
export type HostCardState = 'empty' | 'preparing' | 'surface' | 'archival';
export interface StageControl { transitionId: string; label: string; toStage: string }

const codes = (outcome: { diagnostics: Diagnostic[] }): string => outcome.diagnostics.map(item => item.code).join(', ');
const surfaceEvent = (event: SurfaceErrorEvent): string => event.kind === 'state' ? `state ${event.state}` : `diagnostic ${event.diagnostic.code}`;
const errorText = (error: unknown): string => error instanceof NativeHostError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error);
const sanitize = (text: string): string => text.replace(/[^A-Za-z0-9_.:-]/g, '-').replace(/^[^A-Za-z0-9]+/, 'x').slice(0, 128);

export class HostStepError extends Error {}

export class ReferenceHostApp {
  readonly catalog: InstalledCatalog = createInstalledCatalog();
  readonly port = new NativeHostPort();
  readonly diagnostics: SurfaceDiagnostic[] = [];
  readonly visualizer: StudyHarnessVisualizer = createStudyHarnessVisualizer({
    catalog: this.catalog, host: this.port, maxWorkers: 2,
    surfaceDefaults: {
      theme: 'system', fonts: 'bundled', headingLevel: 2, spatialLoader: loadSpatialRenderer,
      onDiagnostic: diagnostic => { this.diagnostics.push(diagnostic); if (this.diagnostics.length > 200) this.diagnostics.shift(); },
      onRecoveryAction: action => { if (action === 'reload') location.reload(); else this.note('The card asked to return to the session.'); },
    },
  });
  prepared: PreparedActivity | null = null;
  binding: ActivityBinding | null = null;
  surface: StudyHarnessSurface | null = null;
  placeholder: MountedStudyActivityPlaceholder | null = null;
  archival: MountedArchivalRecord | null = null;
  /** What the card area showed, in order since the app was created (host-side diagnostics; at most 100 entries). */
  readonly cardStates: { state: 'empty' | 'preparing' | 'surface' | 'archival'; atMs: number }[] = [];
  private state: HostSnapshot = {
    phase: 'starting', error: null, busy: null, status: null, activities: [], backups: [], current: null, projection: null, lastExport: null, lastImport: null,
    restoredNotes: [], pendingDraft: null, archival: null, closePending: 'cancel', composerStatus: '', log: [], version: 0,
  };
  private readonly listeners = new Set<() => void>();
  private unsubscribe: (() => void) | null = null;
  private surfaceCounter = 0;
  private lastRevision: string | null = null;
  private lastSavedKey: string | null = null;
  private pendingSave: Promise<void> | null = null;
  private checkpointTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly cardContainer: HTMLElement) {}

  // ---- observable state for the host chrome and the composer -------------------------------------------------
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = (): HostSnapshot => this.state;
  private update(patch: Partial<HostSnapshot>): void {
    this.state = { ...this.state, ...patch, version: this.state.version + 1 };
    for (const listener of [...this.listeners]) listener();
  }
  note(text: string): void {
    this.update({ log: [`${new Date().toISOString().slice(11, 19)} ${text}`, ...this.state.log].slice(0, 60) });
  }

  // ---- lifecycle ---------------------------------------------------------------------------------------------
  /** Loads host status and records, then reopens the most recently updated open activity that has a checkpoint. */
  async start(): Promise<void> {
    try {
      this.showPlaceholder('preparing');
      await this.refresh();
      const reopen = this.state.activities.find(activity => !activity.closed && activity.hasBackup);
      if (reopen) await this.reopen(reopen.activityId);
      else this.showPlaceholder('empty');
      this.update({ phase: 'ready' });
    } catch (error) {
      this.update({ phase: 'failed', error: errorText(error) });
    }
  }

  async refresh(): Promise<void> {
    const [status, list, backups] = await Promise.all([hostCommands.status(), hostCommands.list(), hostCommands.listImportableBackups()]);
    this.update({ status, activities: list.activities, backups: backups.backups });
  }

  get busy(): boolean { return this.state.busy !== null; }

  /** Runs one host step; refuses while another runs. Resolves with null on success or the failure text. */
  async runStep(label: string, step: () => Promise<void>): Promise<string | null> {
    if (this.state.busy) return `Another host step is running (${this.state.busy}).`;
    this.update({ busy: label });
    try {
      while (this.pendingSave) await this.pendingSave;
      await step();
      this.note(`${label}: done.`);
      return null;
    } catch (error) {
      const message = errorText(error);
      this.note(`${label} failed: ${message}`);
      return message;
    } finally {
      this.update({ busy: null });
      void this.refresh().catch(() => undefined);
    }
  }

  private requirePrepared(): { prepared: PreparedActivity; binding: ActivityBinding; current: CurrentActivity } {
    if (!this.prepared || !this.binding || !this.state.current) throw new HostStepError('No activity is open.');
    return { prepared: this.prepared, binding: this.binding, current: this.state.current };
  }
  private guard(): { expectedActivityRevision: number; expectedPolicyRevision: number } {
    const projection = this.requirePrepared().binding.getProjection();
    return { expectedActivityRevision: projection.activityRevision, expectedPolicyRevision: projection.policyRevision };
  }
  /** Deterministic host-step operation ID: activity, activity revision, policy revision and step. */
  opId(kind: string, suffix: string): string {
    const { prepared, binding } = this.requirePrepared();
    const projection = binding.getProjection();
    return sanitize(`${kind}-${prepared.activityId.slice(4, 16)}-r${projection.activityRevision}-p${projection.policyRevision}-${suffix}`);
  }
  private describe(templateId: string, version: string): Pick<CurrentActivity, 'template' | 'manifest'> {
    const template = this.catalog.getTemplate({ templateId, version });
    const entry = this.catalog.listTemplates().find(item => item.template.templateId === templateId && item.template.version === version);
    const manifest = entry ? this.catalog.getModel(entry.model) : null;
    if (!template || !manifest) throw new HostStepError('The installed catalogue does not hold this template.');
    return { template, manifest };
  }

  /** Opens a new activity for an approved template (the host creates the ID, the session and policy revision 1). */
  openActivity(templateId: string, version: string): Promise<string | null> {
    return this.runStep('Open activity', async () => {
      this.detach();
      this.showPlaceholder('preparing', this.titleOf(templateId, version));
      const opened = await hostCommands.open(templateId, version);
      const prepared = await this.visualizer.prepare({
        activityId: opened.activityId, objectiveIds: opened.objectiveIds, hostSessionId: opened.hostSessionId, hostSessionRevision: opened.hostSessionRevision,
        template: opened.template, mode: 'approved',
      }, { operationId: sanitize(`prepare-${opened.activityId}`) });
      if (!prepared.ok) { this.showPlaceholder('empty'); throw new HostStepError(`The activity could not be prepared (${codes(prepared)}).`); }
      this.attach(prepared.prepared, { activityId: opened.activityId, kind: 'instructional', taskRef: null, ...this.describe(templateId, version) });
      await this.saveBackup();
    });
  }

  /**
   * Reopens an activity from its latest host checkpoint (restored paused; exposures restored conservatively; the host's
   * own exposure and assistance records merged through `getActivityRecords`). A preview pending at the save comes back
   * as `pendingDraft` (never committed) for the host to re-offer. When the library refuses the restore because the saved
   * template/model is not installed or its approval was withdrawn (UNSUPPORTED_ARTIFACT, CONTENT_REVOKED), the card area
   * shows the artifact's archival read-only record (learner audience) and the step completes: that is the recovery the
   * library names, and the host keeps every record.
   */
  reopen(activityId: string): Promise<string | null> {
    return this.runStep('Reopen activity', async () => {
      this.detach();
      const summary = (await hostCommands.list()).activities.find(item => item.activityId === activityId);
      if (!summary) throw new HostStepError('The host holds no such activity.');
      this.showPlaceholder('preparing', this.titleOf(summary.templateId, summary.templateVersion));
      const stored = await hostCommands.loadLatestArtifact(activityId);
      const restored = await this.visualizer.restore(stored.artifact, { operationId: sanitize(`restore-${activityId.slice(4, 16)}-${crypto.randomUUID().slice(0, 8)}`), hostSessionRevision: summary.hostSessionRevision });
      if (!restored.ok) {
        if (this.showArchival(activityId, stored.artifact, restored.diagnostics)) return;
        this.showPlaceholder('empty');
        throw new HostStepError(`The saved activity could not be restored (${codes(restored)}).`);
      }
      this.update({ restoredNotes: restored.report.notes, pendingDraft: restored.report.pendingDraft ?? null });
      this.attach(restored.prepared, { activityId, kind: summary.kind, taskRef: summary.taskRef, ...this.describe(summary.templateId, summary.templateVersion) });
      this.note(`Restored ${activityId} (${restored.report.restored}).`);
      if (restored.report.pendingDraft) this.note(`A draft that was not committed when the activity was saved is retained (${Object.entries(restored.report.pendingDraft.params).map(([key, value]) => `${key} = ${value}`).join(', ')}).`);
    });
  }

  /** Card title for the placeholder (installed catalogue title; a neutral title when unknown). */
  private titleOf(templateId: string, version: string): string | undefined {
    return this.catalog.listTemplates().find(item => item.template.templateId === templateId && item.template.version === version)?.title;
  }
  /** The learner card frame in `preparing` or `empty` (no binding yet); replaced when a surface or archival record mounts. */
  showPlaceholder(state: 'preparing' | 'empty', title?: string): void {
    if (this.surface || this.archival) return;
    const props = { state, ...(title ? { title } : {}), theme: 'system' as const, fonts: 'bundled' as const, headingLevel: 2 as const };
    if (this.placeholder) this.placeholder.update(props);
    else this.placeholder = mountStudyActivityPlaceholder(this.cardContainer, props);
    this.setCardState(state);
  }
  private setCardState(state: HostCardState): void {
    if (this.cardContainer.dataset.hostCard === state) return;
    this.cardContainer.dataset.hostCard = state;
    this.cardStates.push({ state, atMs: Math.round(performance.now()) });
    if (this.cardStates.length > 100) this.cardStates.shift();
  }
  private clearPlaceholder(): void {
    this.placeholder?.dispose();
    this.placeholder = null;
  }
  /** Shows the archival read-only record for a restore refused as unsupported or revoked; false for any other failure. */
  private showArchival(activityId: string, artifact: unknown, diagnostics: Diagnostic[]): boolean {
    const refused = diagnostics.map(item => item.code);
    if (!refused.some(code => code === 'UNSUPPORTED_ARTIFACT' || code === 'CONTENT_REVOKED')) return false;
    const archived = archivalView(artifact, { audience: 'learner' });
    if (!archived.ok) return false;
    this.clearPlaceholder();
    this.archival?.dispose();
    const theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    // Learner-facing names from the exact saved template when it is still installed, and the host's return action.
    const template = this.catalog.getTemplate(archived.view.template);
    this.archival = mountArchivalRecord(this.cardContainer, archived.view, {
      theme, headingLevel: 2, ...(template ? { labels: archivalLabels(template) } : {}),
      returnAction: { label: 'Return to the session', onSelect: () => this.note('The archival record asked to return to the session.') },
    });
    this.setCardState('archival');
    this.update({ archival: { activityId, artifactId: archived.view.artifact.artifactId, codes: refused } });
    this.note(`The saved activity could not be reopened (${refused.join(', ')}); its archival read-only record is shown.`);
    return true;
  }

  private attach(prepared: PreparedActivity, current: CurrentActivity): void {
    this.clearPlaceholder();
    this.setCardState('surface');
    this.prepared = prepared;
    const surfaceId = `reference-card-${++this.surfaceCounter}`;
    this.binding = prepared.binding('learner', surfaceId);
    const binding = this.binding;
    this.lastRevision = null;
    this.update({ current, projection: binding.getProjection(), composerStatus: '' });
    this.unsubscribe = binding.subscribe(projection => this.observe(projection));
    this.observe(binding.getProjection());
    this.surface = this.visualizer.mount(this.cardContainer, prepared, {
      surfaceId, responseSlot: composerElement(this), onError: event => this.note(`The card reported ${surfaceEvent(event)}.`),
    });
  }

  /** Unmounts the card and releases the adapter's activity; the host keeps every record. */
  detach(): void {
    if (this.checkpointTimer) clearTimeout(this.checkpointTimer);
    this.checkpointTimer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.surface?.dispose();
    this.surface = null;
    this.archival?.dispose();
    this.archival = null;
    if (this.prepared) this.visualizer.dispose(this.prepared.activityId);
    this.prepared = null;
    this.binding = null;
    this.lastRevision = null;
    this.lastSavedKey = null;
    this.update({ current: null, projection: null, restoredNotes: [], pendingDraft: null, archival: null });
    if (this.state.phase !== 'starting') this.showPlaceholder('empty');
  }

  private observe(projection: LearnerProjection): void {
    // A verified host receipt moved the activity revision: checkpoint now, before the surface renders the projection,
    // so a termination from here on restores the revision the host already holds.
    const revision = `${projection.activityId}@${projection.activityRevision}`;
    const changed = this.lastRevision !== null && revision !== this.lastRevision;
    this.lastRevision = revision;
    this.update({ projection });
    if (changed) void this.saveBackup();
    else this.scheduleCheckpoint();
  }

  // ---- checkpoints -------------------------------------------------------------------------------------------
  hostState(): AudienceState | null {
    if (!this.prepared) return null;
    const state = this.visualizer.getState(this.prepared.activityId, 'host');
    return 'audience' in state ? state : null;
  }
  private checkpointKey(): string | null {
    const state = this.hostState();
    if (!state) return null;
    const projection = state.projection;
    if (projection.preview || projection.navigation?.playing || projection.pendingReveal?.state === 'requesting' || projection.status.ui === 'disposed') return null;
    return JSON.stringify([state.guards, projection.frame?.position ?? null, projection.presentation.revision, state.instance.stage.id, state.instance.context, state.instance.closed,
      state.instance.responses.length, (state.exposures ?? []).map((record: ExposureRecord) => [record.exposureId, record.displayStatus, record.uncertainty?.code ?? null])]);
  }
  private scheduleCheckpoint(): void {
    if (this.state.busy) return;
    if (this.checkpointTimer) clearTimeout(this.checkpointTimer);
    this.checkpointTimer = setTimeout(() => { this.checkpointTimer = null; void this.checkpoint(); }, 250);
  }
  private async checkpoint(): Promise<void> {
    while (this.pendingSave) await this.pendingSave;
    const key = this.checkpointKey();
    if (key === null || key === this.lastSavedKey) return;
    await this.saveBackup();
  }
  /** Starts a backup save now (serialized); the adapter builds the artifact synchronously when the save starts. */
  saveBackup(): Promise<void> {
    const prepared = this.prepared;
    const key = this.checkpointKey();
    if (!prepared || key === null) return this.pendingSave ?? Promise.resolve();
    const previous = this.pendingSave ?? Promise.resolve();
    const tracked: Promise<void> = previous.then(() => prepared.host.save({ operationId: sanitize(`checkpoint-${crypto.randomUUID()}`), kind: 'backup' })).then(saved => {
      if (saved.ok) this.lastSavedKey = key;
      else this.note(`Checkpoint not saved (${codes(saved)}).`);
    }, () => undefined).finally(() => { if (this.pendingSave === tracked) this.pendingSave = null; });
    this.pendingSave = tracked;
    return tracked;
  }
  /** Explicit host save (button and runner): a backup of the current activity. */
  save(): Promise<string | null> {
    return this.runStep('Save', async () => {
      const { prepared } = this.requirePrepared();
      const key = this.checkpointKey();
      const saved = await prepared.host.save({ operationId: sanitize(`save-${crypto.randomUUID()}`), kind: 'backup' });
      if (!saved.ok) throw new HostStepError(`Save failed (${codes(saved)}).`);
      if (key !== null) this.lastSavedKey = key;
      this.note(`Saved backup ${saved.artifact.artifactId}.`);
    });
  }
  /** Resolves when no checkpoint save is in flight. */
  async idle(): Promise<void> { while (this.pendingSave) await this.pendingSave; }

  // ---- host commands with persistence retry ------------------------------------------------------------------
  waitFor(done: (projection: LearnerProjection) => boolean, what: string, timeoutMs = 20_000): Promise<void> {
    const { binding } = this.requirePrepared();
    if (done(binding.getProjection())) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { stop(); reject(new HostStepError(`Timed out waiting: ${what}.`)); }, timeoutMs);
      const stop = binding.subscribe(projection => {
        if (done(projection)) { clearTimeout(timer); stop(); resolve(); }
        else if (projection.status.ui === 'disposed') { clearTimeout(timer); stop(); reject(new HostStepError(`Stopped waiting: ${what}.`)); }
      });
    });
  }
  private async command(run: () => Promise<CommandOutcome>, what: string): Promise<void> {
    let outcome = await run();
    for (let attempt = 0; !outcome.ok && attempt < 6 && outcome.diagnostics.every(item => item.code === 'PERSISTENCE_PENDING'); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 80 * (attempt + 1)));
      outcome = await run();
    }
    if (!outcome.ok) throw new HostStepError(`${what} was refused (${codes(outcome)}).`);
    await this.idle();
    await this.checkpoint();
  }

  /** Group IDs whose members appear in the projection (views, marks, values, equations, controls). */
  visibleGroups(projection: LearnerProjection): Set<string> {
    const template = this.state.current?.template;
    const ids = new Set<string>();
    if (!template) return ids;
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

  /** Host stage controls: the template transitions out of the current stage. */
  stageControls(): StageControl[] {
    const current = this.state.current, projection = this.state.projection;
    if (!current || !projection || projection.context === 'independent') return [];
    return current.template.transitions.filter(transition => transition.from === projection.stage.id).map(transition => ({ transitionId: transition.id, label: transition.label, toStage: transition.to }));
  }
  /** Solution-bearing groups the current stage shows but the learner does not see yet (held back by the host). */
  heldBackGroups(): { groupId: string; label: string }[] {
    const current = this.state.current, projection = this.state.projection;
    if (!current || !projection || projection.context === 'independent') return [];
    const stage = current.template.stages.find(item => item.id === projection.stage.id);
    if (!stage) return [];
    const visible = this.visibleGroups(projection);
    return current.template.groups.filter(group => group.solutionBearing && stage.visible[group.id] && !visible.has(group.id)).map(group => ({ groupId: group.id, label: group.label }));
  }

  transition(toStage: string): Promise<string | null> {
    return this.runStep(`Stage ${toStage}`, async () => {
      const { prepared, binding } = this.requirePrepared();
      if (binding.getProjection().stage.id === toStage) return;
      await this.command(() => prepared.host.requestStageTransition({ operationId: this.opId('stage', toStage), ...this.guard(), toStage }), `Stage ${toStage}`);
      await this.waitFor(projection => projection.stage.id === toStage && projection.pendingReveal?.state !== 'requesting', `stage ${toStage}`);
    });
  }

  /** Persist-before-reveal: the host raises its ceiling, records the exposure intent, then the card displays it. */
  reveal(): Promise<string | null> {
    return this.runStep('Authorize and reveal', async () => {
      const { prepared, binding, current } = this.requirePrepared();
      const groups = this.heldBackGroups().map(group => group.groupId);
      if (!groups.length) return;
      const policy = await hostCommands.authorizeReveal(current.activityId, groups);
      await this.applyPolicy(policy, 'reveal');
      // Authorized means the host recorded the exposure intent and returned a verified receipt. The card acknowledges
      // the display itself once the content is rendered in a visible surface (never while the window is hidden).
      const authorized = (projection: LearnerProjection) => projection.pendingReveal?.state !== 'requesting' && groups.every(id => this.visibleGroups(projection).has(id));
      if (!authorized(binding.getProjection())) {
        const operationId = await this.revealOperation(current.activityId, groups);
        await this.command(() => prepared.host.requestReveal({ operationId, ...this.guard(), groups }), 'Reveal');
        await this.waitFor(authorized, 'the authorized content');
      }
    });
  }

  /**
   * The operation ID of a reveal of exactly `groups`: normally the deterministic `opId` of the current revisions. When the
   * host's latest receipt for the activity is a reveal of exactly these groups, in this stage, at the card's activity and
   * policy revisions, that no display acknowledgement followed (the process ended after the host committed it and before
   * the reply reached the card; the restored card followed the host's revision and holds that grant as history), the
   * host re-issues that request under its own idempotency key: the host replays the receipt it committed instead of
   * authorizing the content a second time (report §17, A20: one reveal record and receipt).
   */
  private async revealOperation(activityId: string, groups: string[]): Promise<string> {
    const projection = this.requirePrepared().binding.getProjection();
    const held = (await hostCommands.list()).activities.find(item => item.activityId === activityId)?.unacknowledgedReveal ?? null;
    const resumes = !!held && held.activityRevision === projection.activityRevision && held.policyRevision === projection.policyRevision
      && held.intendedStage === projection.stage.id && held.groups.length === groups.length && groups.every(id => held.groups.includes(id));
    return resumes ? held.idempotencyKey : this.opId('reveal', groups.join('.'));
  }

  private async applyPolicy(policy: HostPolicy, step: string): Promise<void> {
    const { prepared, binding } = this.requirePrepared();
    if (binding.getProjection().policyRevision >= policy.revision) return;
    const outcome = await prepared.host.updatePolicy({ operationId: this.opId('policy', `${step}-${policy.revision}`), policy });
    if (!outcome.ok) throw new HostStepError(`The policy update was refused (${codes(outcome)}).`);
  }

  /** Exploration scope for live previews: the interactive controls' groups and domains plus visible solution groups. */
  explorationRequest(): { groups: string[]; parameterDomain: Record<string, [number, number]> } | null {
    const current = this.state.current, projection = this.state.projection;
    if (!current || !projection || projection.context === 'independent') return null;
    const interactive = projection.controls.filter(control => control.mode === 'interactive').map(control => control.parameter);
    if (!interactive.length) return null;
    const visible = this.visibleGroups(projection);
    const groups = new Set<string>();
    const parameterDomain: Record<string, [number, number]> = {};
    for (const parameter of interactive) {
      const control = current.template.controls.find(item => item.parameter === parameter);
      const definition = current.manifest.parameters[parameter];
      if (!control || !definition) continue;
      groups.add(control.group);
      parameterDomain[parameter] = [definition.min, definition.max];
    }
    for (const group of current.template.groups) if (group.solutionBearing && visible.has(group.id)) groups.add(group.id);
    return { groups: [...groups], parameterDomain };
  }
  explorationCovered(): boolean {
    const request = this.explorationRequest(), state = this.hostState();
    if (!request || !state) return false;
    return (state.exposures ?? []).some(record => record.scope === 'exploration' && record.intendedStage === state.instance.stage.id && record.displayStatus !== 'not-displayed'
      && request.groups.every(id => record.groups.some(group => group.groupId === id)) && Object.keys(request.parameterDomain).every(id => !!record.parameterDomain && id in record.parameterDomain));
  }
  authorizeExploration(): Promise<string | null> {
    return this.runStep('Authorize exploration', async () => {
      const { prepared, binding } = this.requirePrepared();
      const request = this.explorationRequest();
      if (!request) throw new HostStepError('No control is interactive in this stage.');
      if (this.explorationCovered()) return;
      await this.command(() => prepared.host.requestExplorationScope({ operationId: this.opId('scope', binding.getProjection().stage.id), ...this.guard(), ...request }), 'Exploration scope');
    });
  }

  // ---- responses (host-owned composer) -----------------------------------------------------------------------
  /** The response the host currently asks for, or null. */
  composerRequest(): { kind: 'prediction' | 'explanation' | 'answer'; label: string; prompt: string; taskId: string } | null {
    const current = this.state.current, projection = this.state.projection;
    const state = this.hostState();
    if (!current || !projection || !state || state.instance.closed) return null;
    if (projection.context === 'independent') {
      if (state.instance.responses.some(response => response.kind === 'answer')) return null;
      return { kind: 'answer', label: 'Your answer', prompt: 'Independent task (host-owned): answer from the stated rule; the teaching visual is not available for this task.', taskId: sanitize(current.taskRef ?? 'independent-task') };
    }
    const response = projection.stage.response;
    if (!response || state.instance.responses.some(item => item.stageId === projection.stage.id && item.kind === response.kind)) return null;
    return { kind: response.kind, label: response.kind === 'prediction' ? 'Your prediction' : 'Your explanation', prompt: response.prompt, taskId: sanitize(`${current.template.templateId}-${projection.stage.id}`) };
  }
  submitResponse(text: string): Promise<string | null> {
    return this.runStep('Record response', async () => {
      const { prepared, current } = this.requirePrepared();
      const request = this.composerRequest(), state = this.hostState();
      if (!request || !state) throw new HostStepError('No response is requested now.');
      if (!text.trim()) { this.update({ composerStatus: 'Write a response before submitting.' }); throw new HostStepError('Empty response.'); }
      const recorded = await hostCommands.recordResponse({ activityId: current.activityId, kind: request.kind, stageId: state.instance.stage.id, taskId: request.taskId, text });
      // Report §6.4 / A26: an independent-task answer is bound to the exposure and assistance conditions it was given
      // under. They are frozen before the submission is journaled and stored by the host with the answer (immutable,
      // with `complete`/`limitations` when the adapter's local record may be partial); a later reopening, help or
      // feedback is recorded separately and never changes them.
      const frozen = request.kind === 'answer' && current.kind === 'independent-task' ? prepared.host.freezeAssistanceSnapshot({ responseId: recorded.ref.responseId }) : undefined;
      // Report §4.2: the host session revision is host-owned. The host's response transaction (confirm_response) commits
      // the submission and returns the revision IT produced; the adapter adopts exactly that value.
      const confirmed = await hostCommands.confirmResponse(current.activityId, recorded.ref.responseId, frozen);
      const submit = () => prepared.host.submitResponseRef({
        operationId: sanitize(`resp-${recorded.ref.responseId}`), response: recorded.ref, expectedHostSessionRevision: recorded.expectedHostSessionRevision, hostSessionRevision: confirmed.hostSessionRevision,
      });
      let outcome = await submit();
      for (let attempt = 0; !outcome.ok && attempt < 6 && outcome.diagnostics.every(item => item.code === 'PERSISTENCE_PENDING'); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 80 * (attempt + 1)));
        outcome = await submit();
      }
      if (!outcome.ok) {
        // The host committed the response; the activity follows the revision the host produced even though it could not
        // record the reference (nothing is journaled for an observed revision).
        const observed = prepared.host.observeHostSessionRevision({ operationId: sanitize(`observe-${recorded.ref.responseId}`), expectedHostSessionRevision: recorded.expectedHostSessionRevision, hostSessionRevision: confirmed.hostSessionRevision });
        if (!observed.ok) this.note(`The activity could not follow the host session revision (${codes(observed)}).`);
        this.update({ composerStatus: `The host recorded the response, but the activity could not reference it (${codes(outcome)}).` });
        throw new HostStepError(`Response reference refused (${codes(outcome)}).`);
      }
      this.update({ composerStatus: `${request.label} recorded by the host.` });
      await this.idle();
      await this.saveBackup();
    });
  }

  // ---- close, independent task, reopening --------------------------------------------------------------------
  private async closeCurrent(): Promise<void> {
    const { prepared, binding, current } = this.requirePrepared();
    const state = this.hostState();
    if (state && !state.instance.closed) {
      const projection = binding.getProjection();
      const closing = projection.context === 'instructional' ? current.template.transitions.find(item => item.from === projection.stage.id && current.template.stages.find(stage => stage.id === item.to)?.kind === 'closed') : undefined;
      if (closing) {
        await this.command(() => prepared.host.requestStageTransition({ operationId: this.opId('stage', closing.to), ...this.guard(), toStage: closing.to }), 'Close stage');
        await this.waitFor(item => item.stage.id === closing.to, 'the closed stage');
      }
      // The host's policy for an active preview (report §14): cancel (default), commit, or retain the draft.
      const outcome = await prepared.host.close({ operationId: this.opId('close', 'host'), reason: 'The host closed the activity.', pending: this.state.closePending });
      if (!outcome.ok) throw new HostStepError(`Closing was refused (${codes(outcome)}).`);
    }
    await this.idle();
    const saved = await prepared.host.save({ operationId: sanitize(`close-save-${crypto.randomUUID()}`), kind: 'backup' });
    if (!saved.ok) this.note(`Final checkpoint not saved (${codes(saved)}).`);
  }
  /** Host policy for an active preview when Close runs. */
  setClosePending(pending: ClosePending): void { if (pending !== this.state.closePending) this.update({ closePending: pending }); }
  close(): Promise<string | null> {
    return this.runStep('Close', async () => {
      await this.closeCurrent();
      this.detach();
    });
  }

  /** Closes the open activity and opens a fresh independent task with the neutral scaffold only. */
  startIndependentTask(): Promise<string | null> {
    return this.runStep('Start independent task', async () => {
      const origin = this.state.current?.activityId ?? this.state.activities.find(activity => activity.kind === 'instructional')?.activityId;
      if (!origin) throw new HostStepError('Open an activity first.');
      if (this.prepared) { await this.closeCurrent(); this.detach(); }
      this.showPlaceholder('preparing', this.state.current?.template.title);
      const task = await hostCommands.startIndependentTask(origin);
      const prepared = await this.visualizer.prepare({
        activityId: task.activityId, objectiveIds: task.objectiveIds, hostSessionId: task.hostSessionId, hostSessionRevision: task.hostSessionRevision, template: task.template, mode: 'approved',
      }, { operationId: sanitize(`prepare-${task.activityId}`) });
      if (!prepared.ok) { this.showPlaceholder('empty'); throw new HostStepError(`The task could not be prepared (${codes(prepared)}).`); }
      // Enter the independent context before any surface exists, so no instructional content is ever displayed.
      const entered = await prepared.prepared.host.enterIndependentTask({ operationId: sanitize(`enter-${task.taskRef}`), taskRef: task.taskRef, policy: task.policy });
      if (!entered.ok) throw new HostStepError(`The independent context was refused (${codes(entered)}).`);
      this.attach(prepared.prepared, { activityId: task.activityId, kind: 'independent-task', taskRef: task.taskRef, ...this.describe(task.template.templateId, task.template.version) });
      await this.saveBackup();
    });
  }

  /** Reopens the teaching visual of an independent task; recorded by the host as assistance before anything shows. */
  reopenInstructional(): Promise<string | null> {
    return this.runStep('Reopen teaching visual (assistance)', async () => {
      const { prepared, binding, current } = this.requirePrepared();
      if (binding.getProjection().context !== 'independent') throw new HostStepError('The activity is not in an independent context.');
      const policy = await hostCommands.reopenInstructional(current.activityId);
      await this.applyPolicy(policy, 'reopen');
      await this.command(() => prepared.host.reopenInstructional({ operationId: this.opId('reopen', 'assistance'), ...this.guard() }), 'Reopening');
      await this.waitFor(projection => projection.context === 'instructional', 'the instructional context');
    });
  }

  // ---- records -----------------------------------------------------------------------------------------------
  exportBackup(): Promise<string | null> {
    return this.runStep('Export portable backup', async () => {
      await this.idle();
      const exported = await hostCommands.exportBackup();
      this.update({ lastExport: exported });
    });
  }
  importBackup(backupSha256: string): Promise<string | null> {
    return this.runStep('Import backup', async () => {
      const summary = await hostCommands.importBackup(backupSha256);
      this.update({ lastImport: summary });
    });
  }
  /** Host deletion policy: the host deletes every linked record; the adapter releases its cached copies. */
  deleteActivity(activityId: string): Promise<string | null> {
    return this.runStep('Delete activity record', async () => {
      if (this.prepared?.activityId === activityId) {
        const outcome = await this.prepared.host.forget({ operationId: sanitize(`forget-${crypto.randomUUID()}`), scope: 'activity' });
        if (!outcome.ok) this.note(`The adapter could not release its copies (${codes(outcome)}).`);
        this.detach();
      }
      await hostCommands.deleteActivity(activityId);
    });
  }
}
