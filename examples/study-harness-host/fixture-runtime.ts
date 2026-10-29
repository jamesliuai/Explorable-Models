/**
 * BROWSER INTEGRATION FIXTURE — the shared host runtime of `study-harness.html`. Not a tutor, not the Study Harness
 * host and not an authoritative learning database.
 *
 * One runtime plays the host for exactly one installed template: the fixture host (`FixtureHost`, tables in the tab's
 * sessionStorage), an installed catalogue restricted to that template whose kernel workers are the catalogue's own
 * module workers (wrapped only for counting and late-reply injection), the activity adapter, the one mounted learner
 * card, host checkpoints (backups saved whenever a verified receipt moves the activity revision, and after learner
 * changes) and the fault-injection plumbing. The scripted quadratic flow (`fixture-session.ts`) and the generic flow
 * for any installed template (`generic-session.ts`) build on it.
 *
 * A stored fixture session belongs to one flow selection (`scripted:<templateId>` or `generic:<templateId>`); opening
 * the page with another selection in the same tab starts a new fixture session instead of restarting the stored one.
 */
import {
  archivalView, createStudyHarnessAdapter,
  type ActivityArtifact, type ArchivalView, type ActivityBinding, type ActivityTemplate, type AudienceState, type Diagnostic, type ExposureRecord, type HostPolicy,
  type InteractionEvent, type LearnerProjection, type PreparedActivity, type StudyHarnessAdapter, type ToolOperation,
} from '@experiment-kit/activity';
import { createInstalledCatalog, type InstalledCatalog } from '@experiment-kit/catalog';
import {
  archivalLabels, mountArchivalRecord, mountStudyActivity, mountStudyActivityPlaceholder, type CaptureResult, type MountedArchivalRecord, type MountedStudyActivity, type MountedStudyActivityPlaceholder, type SpatialRendererModule,
  type SurfaceDiagnostic,
} from '@experiment-kit/player/activity';
import { FixtureHost, type CrashPoint, type HostResponse, type InjectionPoint } from './fixture-host';
import { fixtureWorkerFactory, workerStats } from './fixture-worker';

export interface FixtureOptions {
  mode: 'guided' | 'free';
  /** One-shot failures armed when the fixture session starts (not again after a restart). */
  fail: Partial<Record<InjectionPoint, number>>;
  /** Delays (ms) before a call is processed, applied at every start. */
  delay: Partial<Record<InjectionPoint, number>>;
  /** Reply delays (ms) after a call was committed, applied at every start. */
  lag: Partial<Record<InjectionPoint, number>>;
  crash: CrashPoint | null;
  revoke: boolean;
  workerDelayMs: number;
  theme: 'light' | 'dark' | 'system';
  fonts: 'bundled' | 'system';
  /** Lazy spatial renderer for `scene3d` views (`?spatial=1`); null leaves the card's 2D projection fallback. */
  spatialLoader: (() => Promise<SpatialRendererModule>) | null;
}

export type FixturePhase = 'starting' | 'running' | 'crashed' | 'failed';
export interface FixtureMessage { id: string; kind: 'scripted' | 'host'; text: string }
export interface ProjectionLogEntry { projectionId: string; frameId: string | null; frameKind: 'committed' | 'tentative' | null; ui: string; stage: string; previewId: string | null; activityId: string; at: number }
/** Host exposure record plus whether the host persisted its display acknowledgement. */
export type HostExposure = ExposureRecord & { acked: boolean };

/** Tools the fixture policies allow (learner-facing operations; no inspection beyond learner-visible state). */
export const LEARNER_TOOLS: ToolOperation[] = ['discover', 'prepare', 'inspect.learner', 'request-reveal', 'operate.parameters', 'operate.navigation', 'operate.playback', 'operate.presentation', 'summarize', 'save', 'restore', 'close'];
export const codes = (outcome: { diagnostics: Diagnostic[] }): string => outcome.diagnostics.map(item => item.code).join(', ');
/** Selection of a stored session written before selections existed (the scripted quadratic flow was the only one). */
const LEGACY_SELECTION = 'scripted:quadratic-gradient-descent';

export class FixtureStepError extends Error {}

/** Shared host runtime; subclasses own the flow (snapshot for the page chrome, card mounting, start-up). */
export abstract class FixtureRuntime<Snapshot> {
  private hostInstance: FixtureHost;
  private catalogInstance!: InstalledCatalog;
  private adapterInstance!: StudyHarnessAdapter;
  prepared: PreparedActivity | null = null;
  binding: ActivityBinding | null = null;
  surface: MountedStudyActivity | null = null;
  readonly projectionLog: ProjectionLogEntry[] = [];
  readonly diagnostics: SurfaceDiagnostic[] = [];
  readonly workers = workerStats;
  protected container: HTMLElement | null = null;
  protected hostBinding: ActivityBinding | null = null;
  protected phase: FixturePhase = 'starting';
  protected error: string | null = null;
  protected hostLog: string[] = [];
  protected restoredNotes: string[] = [];
  /**
   * Fixture host decision persisted with the host tables: the selected template is revoked in the installed catalogue
   * (a later restore then reports CONTENT_REVOKED and the archival read-only record is shown instead of the card).
   */
  protected catalogRevoked = false;
  /** Archival read-only record (learner audience) of a saved activity that could not be reopened. */
  archival: ArchivalView | null = null;
  private archivalMount: MountedArchivalRecord | null = null;
  protected version = 0;
  /** Activity whose host tables `events()`/`exposures()` read (the open one, or the last one opened). */
  protected lastActivityId: string | null = null;
  private unsubscribe: (() => void) | null = null;
  private listeners = new Set<() => void>();
  private pendingSave: Promise<void> | null = null;
  /** `activityId@activityRevision` of the last observed projection. */
  private lastRevision: string | null = null;
  private lastSavedKey: string | null = null;
  private surfaceCounter = 0;
  private extra: { element: HTMLElement; surface: MountedStudyActivity } | null = null;
  /** The card frame shown before a binding exists (`preparing` while the host prepares or restores the activity). */
  private placeholder: MountedStudyActivityPlaceholder | null = null;
  private cached: Snapshot | null = null;

  constructor(readonly options: FixtureOptions, readonly template: ActivityTemplate, readonly selection: string) {
    this.hostInstance = this.createHost();
    if (this.hostInstance.restarted && (this.hostInstance.session<{ selection?: string }>().selection ?? LEGACY_SELECTION) !== selection) {
      // Another flow or template was stored in this tab: start a new fixture session for this selection.
      this.hostInstance.terminate();
      this.hostInstance.clear();
      this.hostInstance = this.createHost();
    }
    this.createAdapter();
  }

  get host(): FixtureHost { return this.hostInstance; }
  get catalog(): InstalledCatalog { return this.catalogInstance; }
  get adapter(): StudyHarnessAdapter { return this.adapterInstance; }

  private createHost(): FixtureHost {
    return new FixtureHost({ storage: sessionStorage, onChange: () => this.changed(), onCrash: point => this.onCrash(point) });
  }
  private createAdapter(): void {
    // Workers come from the catalogue's own module-worker URL (as a host would use it), wrapped only for counting and
    // the optional reply delay.
    const include = [this.template.templateId];
    const installed = createInstalledCatalog({ include });
    this.catalogRevoked = this.hostInstance.session<{ catalogRevoked?: unknown }>().catalogRevoked === true;
    const revocations = this.catalogRevoked ? [{ kind: 'template' as const, id: this.template.templateId, version: this.template.version, reason: 'Revoked by the fixture host.' }] : [];
    const catalog = createInstalledCatalog({ include, revocations, workerFactory: fixtureWorkerFactory(() => installed.createWorker(), this.options.workerDelayMs) });
    // A revocation the host makes while the activity is open (`revokeCatalogue`) reaches the same catalogue object, as a
    // host's catalogue answers after an update: the open activity notices at its next standing check.
    const selected = this.template;
    this.catalogInstance = Object.freeze({
      ...catalog,
      status: (ref: Parameters<InstalledCatalog['status']>[0]) => this.catalogRevoked && 'templateId' in ref && ref.templateId === selected.templateId && ref.version === selected.version
        ? { lifecycle: 'revoked' as const, reviews: [], revoked: true, revocationReason: 'Revoked by the fixture host.' } : catalog.status(ref),
    });
    this.adapterInstance = createStudyHarnessAdapter({ catalog: this.catalogInstance, host: this.hostInstance, maxWorkers: 4 });
  }
  /**
   * In-page host restart: the card and the adapter go away, the old host instance is terminated (it answers and writes
   * nothing more) and a new host instance loads the persisted tables (applying its restart rule) with a new adapter.
   * The subclass then reopens its activity from the host's latest checkpoint.
   */
  protected replaceHost(): void {
    this.detachCard();
    this.clearArchival();
    this.adapterInstance.dispose();
    this.hostInstance.terminate();
    this.prepared = null;
    this.pendingSave = null;
    this.lastRevision = null;
    this.lastSavedKey = null;
    this.restoredNotes = [];
    this.hostInstance = this.createHost();
    this.createAdapter();
  }

  // ---- external store for the host chrome -------------------------------------------------------------------
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = (): Snapshot => this.cached ?? (this.cached = this.snapshot());
  protected abstract snapshot(): Snapshot;
  protected changed(): void {
    this.version++;
    this.cached = null;
    for (const listener of [...this.listeners]) listener();
  }
  protected note(text: string): void {
    this.hostLog = [`${new Date().toISOString().slice(11, 19)} ${text}`, ...this.hostLog].slice(0, 40);
    this.changed();
  }
  /** Persists the page-owned flow state with the host tables, tagged with this runtime's selection. */
  protected persistSession(state: Record<string, unknown>): void { this.host.setSession({ selection: this.selection, ...(this.catalogRevoked ? { catalogRevoked: true } : {}), ...state }); }
  /**
   * Restore refused because the saved template/model is not installed or is revoked (UNSUPPORTED_ARTIFACT,
   * CONTENT_REVOKED): shows the artifact's archival read-only record (learner audience) in place of the card, as the
   * recovery text directs. Nothing is evaluated and no other template is substituted. Returns false for other failures.
   */
  protected showArchival(artifact: unknown, outcome: { diagnostics: { code: string }[] }): boolean {
    if (!outcome.diagnostics.some(item => item.code === 'UNSUPPORTED_ARTIFACT' || item.code === 'CONTENT_REVOKED')) return false;
    const archived = archivalView(artifact, { audience: 'learner' });
    if (!archived.ok) return false;
    this.detachCard();
    this.archival = archived.view;
    this.archivalMount?.dispose();
    const theme = this.options.theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : this.options.theme;
    // Learner-facing names from the selected template (ignored by the record for another template version) and the
    // host's return action (fixture: no navigation, the request is logged).
    this.archivalMount = this.container ? mountArchivalRecord(this.container, archived.view, {
      theme, headingLevel: 2, labels: archivalLabels(this.template),
      returnAction: { label: 'Return to the session', onSelect: () => this.note('The archival record asked to return to the session (fixture: no navigation).') },
    }) : null;
    this.note(`The saved activity could not be reopened (${outcome.diagnostics.map(item => item.code).join(', ')}); its archival read-only record is shown.`);
    return true;
  }
  private clearArchival(): void { this.archivalMount?.dispose(); this.archivalMount = null; this.archival = null; }
  /** True while a host step or command of the flow runs (learner-driven checkpoints wait for it). */
  protected abstract busy(): boolean;
  /** Mounts the learner card for `binding` in `container`. */
  protected abstract mountCard(container: HTMLElement, binding: ActivityBinding, surfaceId: string): MountedStudyActivity;

  // ---- policies ---------------------------------------------------------------------------------------------
  /** The catalogue's exact template and model references of the selected template (computed from installed content). */
  approvedEntry(): HostPolicy['approved'][number] {
    const entry = this.catalog.listTemplates().find(item => item.template.templateId === this.template.templateId);
    if (!entry) throw new FixtureStepError(`The catalogue does not serve ${this.template.templateId}.`);
    return { template: entry.template, model: entry.model };
  }
  /**
   * Fixture host policy approving exactly the selected installed template; `visible` is the ceiling of groups the
   * learner may ever see under this revision (a fixture host decision, not a Study Harness policy).
   */
  protected policy(activityId: string, revision: number, visible: string[]): HostPolicy {
    return {
      contract: 'study-harness.host-policy', schemaVersion: '1.0', policyId: `fx-policy-${activityId}`.slice(0, 128), revision,
      issuedAt: new Date().toISOString(), expiresAt: null, revoked: false, mode: 'approved', approved: [this.approvedEntry()], allowedTools: [...LEARNER_TOOLS],
      visibleGroups: visible, permittedControls: this.template.controls.map(control => control.parameter),
      export: { learnerSnapshot: true, capture: true, backup: true }, inspection: { developer: false, tutor: 'learner-visible', teacher: false },
      independentTask: { active: false, taskRef: null, permittedTools: [], neutralScaffold: [] }, sampling: { allowed: false, maxPositions: 0 },
      exploratory: { allowed: false, maxParametersOverride: 0 },
    };
  }
  protected allGroups(): string[] { return this.template.groups.map(group => group.id); }

  protected applyInjections(first: boolean): void {
    for (const [point, ms] of Object.entries(this.options.delay)) if (ms) this.host.delay(point as InjectionPoint, ms);
    for (const [point, ms] of Object.entries(this.options.lag)) if (ms) this.host.lag(point as InjectionPoint, ms);
    if (this.options.crash) this.host.armCrash(this.options.crash);
    if (!first) return;
    for (const [point, times] of Object.entries(this.options.fail)) if (times) this.host.failNext(point as InjectionPoint, times);
  }

  // ---- card ---------------------------------------------------------------------------------------------------
  /** Binds the prepared activity, mounts its learner card and starts autosaving. */
  protected attach(prepared: PreparedActivity): void {
    this.detachCard();
    this.placeholder?.dispose();
    this.placeholder = null;
    this.prepared = prepared;
    this.lastActivityId = prepared.activityId;
    const surfaceId = `fx-card-${++this.surfaceCounter}`;
    this.binding = prepared.binding('learner', surfaceId);
    this.hostBinding = prepared.binding('host', 'fx-host-panel');
    const binding = this.binding;
    this.unsubscribe = binding.subscribe(projection => this.observe(projection));
    this.observe(binding.getProjection());
    if (!this.container) return;
    this.surface = this.mountCard(this.container, binding, surfaceId);
    this.changed();
  }
  /** Shows the learner card frame in `preparing` (or `empty`) until `attach` mounts the activity's surface. */
  protected showPlaceholder(state: 'preparing' | 'empty'): void {
    if (!this.container || this.surface) return;
    const props = { state, title: this.template.title, theme: this.options.theme, fonts: this.options.fonts, headingLevel: 2 as const };
    if (this.placeholder) this.placeholder.update(props); else this.placeholder = mountStudyActivityPlaceholder(this.container, props);
  }
  /** Options every fixture card receives (theme, fonts, spatial loader, diagnostics and recovery handling). */
  protected cardOptions(binding: ActivityBinding, surfaceId: string) {
    return {
      binding, surfaceId, theme: this.options.theme, fonts: this.options.fonts, headingLevel: 2 as const,
      ...(this.options.spatialLoader ? { spatialLoader: this.options.spatialLoader } : {}),
      onDiagnostic: (diagnostic: SurfaceDiagnostic) => { this.diagnostics.push(diagnostic); if (this.diagnostics.length > 200) this.diagnostics.shift(); },
      onRecoveryAction: (action: 'return' | 'reload') => { if (action === 'reload') location.reload(); else this.note('The card asked to return to the session (fixture: no navigation).'); },
    };
  }
  protected detachCard(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.surface?.dispose();
    this.surface = null;
    this.binding = null;
    this.hostBinding = null;
    this.changed();
  }

  private observe(projection: LearnerProjection): void {
    this.projectionLog.push({
      projectionId: projection.projectionId, frameId: projection.frame?.frameId ?? null, frameKind: projection.frame?.kind ?? null, ui: projection.status.ui,
      stage: projection.stage.id, previewId: projection.preview?.previewId ?? null, activityId: projection.activityId, at: performance.now(),
    });
    if (this.projectionLog.length > 2000) this.projectionLog.splice(0, this.projectionLog.length - 2000);
    // A verified host receipt moved the activity revision: checkpoint now, before any surface renders the projection,
    // so a crash from here on restores the revision the host already holds (the adapter builds the artifact
    // synchronously when the save starts).
    const revision = `${projection.activityId}@${projection.activityRevision}`;
    if (this.lastRevision !== null && revision !== this.lastRevision && projection.activityId === this.lastRevision.split('@')[0]) void this.saveBackup();
    this.lastRevision = revision;
    this.scheduleCheckpoint();
    this.projected(projection);
  }
  /** Hook for subclasses after every observed projection. */
  protected projected(_projection: LearnerProjection): void { /* The scripted flow needs nothing here. */ }

  // ---- checkpoints (host-owned backups) ----------------------------------------------------------------------
  protected state(): AudienceState | null {
    if (!this.prepared) return null;
    const state = this.adapter.getState(this.prepared.activityId, 'host');
    return 'audience' in state ? state : null;
  }
  /** Changes worth a checkpoint: revisions, scientific position, stage/context, responses and exposure statuses. */
  private checkpointKey(): string | null {
    const state = this.state();
    if (!state) return null;
    const projection = state.projection;
    if (projection.preview || projection.navigation?.playing || projection.pendingReveal?.state === 'requesting' || projection.status.ui === 'disposed') return null;
    return JSON.stringify([state.guards, projection.frame?.position ?? null, state.instance.stage.id, state.instance.context, state.instance.closed, state.instance.responses.length,
      (state.exposures ?? []).map((record: ExposureRecord) => [record.exposureId, record.displayStatus, record.uncertainty?.code ?? null])]);
  }
  /**
   * Saves a backup when the checkpoint key changed (or always with `force`). Saves are serialized. Host steps
   * checkpoint after each sub-operation themselves; learner-driven changes are checkpointed when no step is running.
   */
  protected async checkpoint(force = false): Promise<void> {
    while (this.pendingSave) await this.pendingSave;
    const key = this.checkpointKey();
    if (key === null || (!force && key === this.lastSavedKey)) return;
    await this.saveBackup();
  }
  /** Starts a backup save immediately; the artifact reflects the activity at this call. */
  private saveBackup(): Promise<void> {
    const prepared = this.prepared;
    const key = this.checkpointKey();
    if (this.host.crashed || !prepared || key === null) return Promise.resolve();
    const tracked: Promise<void> = prepared.host.save({ operationId: this.host.id('fx-checkpoint'), kind: 'backup' }).then(saved => {
      if (saved.ok) this.lastSavedKey = key;
      else if (!this.host.crashed) this.note(`Checkpoint not saved (${codes(saved)}).`);
    }).finally(() => { if (this.pendingSave === tracked) this.pendingSave = null; });
    this.pendingSave = tracked;
    return tracked;
  }
  protected scheduleCheckpoint(): void {
    if (this.busy() || this.host.crashed) return;
    queueMicrotask(() => void this.checkpoint());
  }
  /** Resolves when no checkpoint save is in flight. */
  protected async savesSettled(): Promise<void> {
    while (this.pendingSave) await this.pendingSave;
  }
  /** Saves a backup or learner snapshot now (host button and tests). */
  async saveNow(kind: ActivityArtifact['kind'] = 'backup'): Promise<{ ok: boolean; artifactId?: string; codes?: string }> {
    while (this.pendingSave) await this.pendingSave;
    if (!this.prepared) return { ok: false, codes: 'NOT_READY' };
    const key = this.checkpointKey();
    const saved = await this.prepared.host.save({ operationId: this.host.id('fx-save'), kind });
    if (!saved.ok) { this.note(`Save failed (${codes(saved)}).`); return { ok: false, codes: codes(saved) }; }
    if (kind === 'backup' && key !== null) this.lastSavedKey = key;
    this.note(`Saved ${kind} ${saved.artifact.artifactId}.`);
    return { ok: true, artifactId: saved.artifact.artifactId };
  }

  // ---- shared host helpers -----------------------------------------------------------------------------------
  protected requirePrepared(): { prepared: PreparedActivity; binding: ActivityBinding } {
    if (!this.prepared || !this.binding) throw new FixtureStepError('No activity is open.');
    return { prepared: this.prepared, binding: this.binding };
  }
  protected guard(): { expectedActivityRevision: number; expectedPolicyRevision: number } {
    const projection = this.requirePrepared().binding.getProjection();
    return { expectedActivityRevision: projection.activityRevision, expectedPolicyRevision: projection.policyRevision };
  }
  /** Template groups whose content the projection shows (views, marks, values, equations, controls, scenarios, alternatives). */
  shownGroups(projection: LearnerProjection): Set<string> {
    const template = this.template;
    const ids = new Set<string>();
    for (const view of projection.views) { ids.add(view.viewId); for (const mark of view.marks) ids.add(mark.markId); for (const value of view.values) ids.add(value.quantityId); for (const equation of view.equations) ids.add(equation.equationId); }
    for (const control of projection.controls) ids.add(control.parameter);
    const groups = new Set<string>();
    for (const view of template.views) { if (ids.has(view.id)) groups.add(view.group); for (const mark of view.marks) if (ids.has(mark.id)) groups.add(mark.group); }
    for (const group of template.groups) if (group.kind === 'quantity' && group.members.some(member => ids.has(member))) groups.add(group.id);
    for (const equation of template.equations) if (ids.has(equation.id)) groups.add(equation.group);
    for (const control of template.controls) if (ids.has(control.parameter)) groups.add(control.group);
    for (const scenario of projection.scenarios) { const spec = template.scenarios.find(item => item.id === scenario.scenarioId); if (spec) groups.add(spec.group); }
    for (const alternative of projection.alternatives) { const spec = template.alternatives.find(item => item.id === alternative.alternativeId); if (spec) groups.add(spec.group); }
    return groups;
  }

  // ---- fixture controls -------------------------------------------------------------------------------------
  /**
   * Fixture host action: revokes the open template in the installed catalogue while the activity is open. The revocation
   * is kept with the host tables (a later restart refuses the restore with CONTENT_REVOKED and shows the archival
   * record); the open card becomes `unsupported` at the activity's next standing check — the next learner or host
   * command — and offers to return to the session.
   */
  revokeCatalogue(): void {
    this.catalogRevoked = true;
    this.host.setSession({ ...this.host.session<Record<string, unknown>>(), catalogRevoked: true });
    this.note('The template is revoked in the installed catalogue.');
  }
  /** Issues a revoked policy revision for the open activity (host table and adapter). */
  async revokePolicy(): Promise<void> {
    const prepared = this.prepared;
    if (!prepared) return;
    const current = this.host.policy(prepared.activityId)!;
    const revoked = this.host.setPolicy(prepared.activityId, { ...current, revision: current.revision + 1, issuedAt: new Date().toISOString(), revoked: true });
    const outcome = await prepared.host.updatePolicy({ operationId: this.host.id('fx-revoke'), policy: revoked });
    this.policyRevoked();
    this.note(outcome.ok ? 'Policy revoked.' : `Revocation not applied (${codes(outcome)}).`);
  }
  /** Hook: the host revoked the policy of the open activity (flow messages). */
  protected abstract policyRevoked(): void;
  /** Retries persistence of the open activity from the host side (same request, same idempotency key). */
  async retry(): Promise<boolean> {
    const binding = this.hostBinding;
    if (!binding) return false;
    const outcome = await binding.retryPersistence({ operationId: this.host.id('fx-retry') });
    if (!outcome.ok) this.note(`Retry failed (${codes(outcome)}).`);
    return outcome.ok;
  }
  /**
   * Captures one view of the mounted card (the exact surface handle of this page). The card itself enforces the host
   * policy's `export.capture` (it rejects with `CAPTURE_REJECTED`), so the fixture does not pre-filter.
   */
  async capture(format: 'svg' | 'png', viewId?: string): Promise<CaptureResult> {
    if (!this.surface) throw new Error('No card is mounted.');
    return this.surface.capture({ format, ...(viewId ? { viewId } : {}), scale: 1 });
  }
  responses(): HostResponse[] { return this.host.responses(); }
  /** Host journal of an activity (default: the open or last opened activity). */
  events(activityId = this.lastActivityId): InteractionEvent[] { return activityId ? this.host.events(activityId) : []; }
  /** Host exposure records of an activity with their persisted display acknowledgement (default: the open or last opened activity). */
  exposures(activityId = this.lastActivityId): HostExposure[] {
    return activityId ? this.host.exposures(activityId).map(record => ({ ...record, acked: this.host.displayAcked(activityId, record.exposureId) })) : [];
  }
  /** The learner projection of the open card as plain JSON (null when no card is open). */
  projection(): LearnerProjection | null { return this.binding ? JSON.parse(JSON.stringify(this.binding.getProjection())) as LearnerProjection : null; }
  /**
   * Why the open activity is not settled yet, or null when it is: no checkpoint save in flight, no reveal requesting or
   * awaiting display, no journal flush in flight, the card showing the binding's current projection, and every
   * exposure the adapter holds as displayed (without an uncertainty) acknowledged in the host tables.
   */
  unsettled(): string | null {
    if (this.phase === 'crashed') return null;
    if (this.pendingSave) return 'a checkpoint save is in flight';
    const prepared = this.prepared, binding = this.binding;
    if (!prepared || !binding) return null;
    const projection = binding.getProjection();
    if (projection.pendingReveal && projection.pendingReveal.state !== 'failed') return `a reveal is ${projection.pendingReveal.state}`;
    if (projection.status.persistence === 'saving') return 'journal events are being saved';
    const shown = this.surface?.element.shadowRoot?.querySelector<HTMLElement>('[data-eka-projection]')?.dataset.ekaProjection;
    if (shown !== undefined && shown !== projection.projectionId && projection.status.ui !== 'suspended') return 'the card has not rendered the current projection';
    for (const record of this.state()?.exposures ?? []) {
      if (record.displayStatus === 'displayed' && !record.uncertainty && !this.host.displayAcked(prepared.activityId, record.exposureId)) return `the display acknowledgement of ${record.exposureId} is not persisted yet`;
    }
    return null;
  }
  /** Resolves when `unsettled()` is null (or the host terminated); rejects with the reason after `timeoutMs`. */
  async settle(timeoutMs = 15_000): Promise<void> {
    const started = performance.now();
    for (;;) {
      const reason = this.unsettled();
      if (reason === null) return;
      if (performance.now() - started > timeoutMs) throw new Error(`The fixture did not settle within ${timeoutMs} ms: ${reason}.`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  /**
   * Mounts a second learner card for the open activity in its own container (capture-selection tests: a capture of
   * the first card must never pick this one). Returns its surface ID; `disposeExtra` removes it.
   */
  mountExtra(width: number): string | null {
    if (!this.prepared) return null;
    this.disposeExtra();
    const element = document.createElement('div');
    element.dataset.fxExtraCard = '';
    element.style.width = `${Math.max(240, Math.min(1200, width))}px`;
    document.body.append(element);
    const surfaceId = `fx-extra-${++this.surfaceCounter}`;
    const surface = mountStudyActivity(element, { binding: this.prepared.binding('learner', surfaceId), surfaceId, theme: this.options.theme, fonts: this.options.fonts, headingLevel: 2 });
    this.extra = { element, surface };
    return surfaceId;
  }
  disposeExtra(): void { if (!this.extra) return; this.extra.surface.dispose(); this.extra.element.remove(); this.extra = null; }

  protected onCrash(point: CrashPoint): void {
    this.phase = 'crashed';
    this.error = `The host process terminated at the injected crash point “${point}”.`;
    // A terminated process shows nothing: the card and the adapter go away without any further host call.
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.surface?.dispose();
    this.surface = null;
    this.adapter.dispose();
    this.changed();
  }
}
