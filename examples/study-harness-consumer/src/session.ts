/**
 * Host-side sequencing shared by the packed consumer entries and the benchmark page: open (prepare + mount), host
 * stage transitions and reveals (persist-before-reveal through the fixture host), exploration scopes, learner commands,
 * suspension, save/restore, capture and settling. It only calls public APIs of the packed packages; every privileged
 * step goes through the `PreparedActivity.host` control the adapter handed to this host, and every learner command
 * through a learner binding of the mounted surface.
 */
import type {
  ActivityArtifact, ActivityBinding, ActivityRequest, CommandBase, CommandFailure, CommandOutcome, LearnerProjection, PreparedActivity, RestoreResult,
} from '@explorable-models/activity';
import type { InstalledCatalog, LazyInstalledCatalog } from '@explorable-models/catalog';
import type { CaptureOptions, CaptureResult, SurfaceDiagnostic } from '@explorable-models/player/activity';
import type { ConsumerHost } from './host';

/** A mounted learner card, whichever way the entry mounts it (plain DOM or React). */
export interface CardHandle {
  readonly surfaceId: string;
  /** Element appended to the card container (its shadow root holds the surface when mounted with mountStudyActivity). */
  readonly element: HTMLElement;
  readonly ready: Promise<void>;
  capture(options: CaptureOptions): Promise<CaptureResult>;
  dispose(): void;
}
export type CardMounter = (container: HTMLElement, prepared: PreparedActivity, surfaceId: string) => CardHandle;

export interface SessionOptions {
  /** The on-demand catalogue in the packed pages (`createLazyCatalog`); the eager one works the same way. */
  catalog: LazyInstalledCatalog | InstalledCatalog;
  host: ConsumerHost;
  prepare(request: ActivityRequest, input: CommandBase): Promise<{ ok: true; prepared: PreparedActivity } | CommandFailure>;
  restore(artifact: unknown, input: CommandBase & { hostSessionRevision: number }): Promise<RestoreResult | CommandFailure>;
  /** Releases the activity in the adapter or visualizer (after its card was disposed). */
  release(activityId: string): void;
  mount: CardMounter;
  container: HTMLElement;
}

export interface OpenCard {
  activityId: string;
  templateId: string;
  prepared: PreparedActivity;
  /** Learner binding with the surface's ID: the same command path the card's own controls use. */
  learner: ActivityBinding;
  card: CardHandle;
  wrapper: HTMLElement;
}

export interface Outcome { ok: boolean; codes: string[]; message: string | null }
export interface CardSummary {
  activityId: string; templateId: string; surfaceId: string; stage: string; ui: string; projectionId: string; frameId: string | null; frameKind: string | null;
  activityRevision: number; scientificVersion: number; runId: string | null; persistence: string; controls: Record<string, number>; views: string[];
}
export interface SerializedCapture {
  mimeType: string; width: number; height: number; fonts: string; companionText: string; metadata: CaptureResult['metadata'];
  pngBase64: string | null; svgLength: number | null;
}

const outcomeOf = (result: CommandOutcome | { ok: boolean; diagnostics?: { code: string; message: string }[] }): Outcome => result.ok
  ? { ok: true, codes: [], message: null }
  : { ok: false, codes: (result.diagnostics ?? []).map(item => item.code), message: (result.diagnostics ?? [])[0]?.message ?? null };
const toBase64 = (bytes: Uint8Array): string => {
  let text = '';
  for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(text);
};
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class ConsumerSession {
  readonly cards = new Map<string, OpenCard>();
  readonly diagnostics: SurfaceDiagnostic[] = [];
  private counter = 0;

  constructor(readonly options: SessionOptions) {}

  op(prefix: string): string { return `${prefix}-${++this.counter}`.replace(/[^A-Za-z0-9_.:-]/g, '-').slice(0, 128); }
  card(activityId: string): OpenCard {
    const card = this.cards.get(activityId);
    if (!card) throw new Error(`No open card for ${activityId}.`);
    return card;
  }
  projection(activityId: string): LearnerProjection { return this.card(activityId).learner.getProjection(); }
  /** Root element of the rendered surface (inside the shadow root for plain-DOM mounts). */
  surfaceRoot(activityId: string): HTMLElement | null {
    const card = this.card(activityId);
    const scope: ParentNode = card.card.element.shadowRoot ?? card.card.element;
    return scope.querySelector<HTMLElement>(`[data-ema-surface="${card.card.surfaceId}"]`);
  }
  summary(activityId: string): CardSummary {
    const card = this.card(activityId), projection = card.learner.getProjection();
    return {
      activityId, templateId: card.templateId, surfaceId: card.card.surfaceId, stage: projection.stage.id, ui: projection.status.ui, projectionId: projection.projectionId,
      frameId: projection.frame?.frameId ?? null, frameKind: projection.frame?.kind ?? null, activityRevision: projection.activityRevision,
      scientificVersion: projection.guards.expectedScientificVersion, runId: projection.guards.expectedRunId, persistence: projection.status.persistence,
      controls: Object.fromEntries(projection.controls.map(control => [control.parameter, control.value])), views: projection.views.map(view => view.viewId),
    };
  }

  /** Issues a host policy, prepares the activity and mounts its learner card. */
  async open(templateId: string, input: { activityId?: string; stageId?: string; container?: HTMLElement; parameters?: Record<string, number> } = {}): Promise<CardSummary> {
    const { catalog, host } = this.options;
    const entry = catalog.listTemplates().find(item => item.template.templateId === templateId);
    if (!entry) throw new Error(`The installed catalogue does not serve ${templateId}.`);
    const activityId = input.activityId ?? this.op(`act-${templateId}`);
    // The fixture host's policy lists the template's groups and controls: load (and verify) its content first.
    const loaded = await catalog.load({ templateId, version: entry.template.version });
    if (!loaded.ok) throw new Error(`load ${templateId} failed: ${loaded.diagnostics.map(item => item.code).join(', ')}`);
    host.authorize(activityId, templateId);
    const result = await this.options.prepare({
      activityId, objectiveIds: ['consumer-check'], hostSessionId: 'consumer-session', hostSessionRevision: 0,
      template: { templateId, version: entry.template.version }, mode: 'approved', ...(input.stageId ? { stageId: input.stageId } : {}),
      ...(input.parameters ? { parameters: input.parameters } : {}),
    }, { operationId: this.op('prepare') });
    if (!result.ok) throw new Error(`prepare ${templateId} failed: ${outcomeOf(result).codes.join(', ')} ${outcomeOf(result).message ?? ''}`);
    return this.attach(result.prepared, templateId, input.container);
  }
  /** Restores a backup artifact (paused, conservative exposures) and mounts a new card for it. */
  async restore(artifact: ActivityArtifact, container?: HTMLElement): Promise<CardSummary> {
    const result = await this.options.restore(artifact, { operationId: this.op('restore'), hostSessionRevision: 0 });
    if (!result.ok) throw new Error(`restore failed: ${outcomeOf(result).codes.join(', ')}`);
    return this.attach(result.prepared, artifact.template.templateId, container);
  }
  private async attach(prepared: PreparedActivity, templateId: string, container?: HTMLElement): Promise<CardSummary> {
    const wrapper = document.createElement('section');
    wrapper.className = 'consumer-card';
    wrapper.dataset.activityId = prepared.activityId;
    (container ?? this.options.container).append(wrapper);
    const surfaceId = this.op(`surface-${prepared.activityId}`.slice(0, 100));
    const card = this.options.mount(wrapper, prepared, surfaceId);
    const open: OpenCard = { activityId: prepared.activityId, templateId, prepared, learner: prepared.binding('learner', surfaceId), card, wrapper };
    this.cards.set(prepared.activityId, open);
    await card.ready;
    return this.summary(prepared.activityId);
  }

  private activityGuard(activityId: string) {
    const projection = this.projection(activityId);
    return { expectedActivityRevision: projection.activityRevision, expectedPolicyRevision: projection.policyRevision };
  }
  /** Sends a receipt-bearing host step, retrying while earlier journal events are still being acknowledged. */
  private async hostStep(activityId: string, step: (operationId: string) => Promise<CommandOutcome>): Promise<Outcome> {
    const operationId = this.op('host');
    let outcome = await step(operationId);
    for (let attempt = 0; !outcome.ok && attempt < 20 && outcome.diagnostics.every(item => item.code === 'PERSISTENCE_PENDING'); attempt++) {
      await wait(25);
      outcome = await step(operationId);
    }
    if (outcome.ok) await this.settle(activityId);
    return outcomeOf(outcome);
  }
  /** Template transition from the current stage (stage receipt; grants for the target stage's solution-bearing groups). */
  transition(activityId: string, toStage: string): Promise<Outcome> {
    const card = this.card(activityId);
    return this.hostStep(activityId, operationId => card.prepared.host.requestStageTransition({ operationId, ...this.activityGuard(activityId), toStage }));
  }
  /** Reveal request (persist-before-reveal) for the named groups. */
  reveal(activityId: string, groups: string[]): Promise<Outcome> {
    const card = this.card(activityId);
    return this.hostStep(activityId, operationId => card.prepared.host.requestReveal({ operationId, ...this.activityGuard(activityId), groups }));
  }
  /** Reveals the solution-bearing groups of the current stage that are not yet shown. */
  async revealStage(activityId: string): Promise<Outcome> {
    const card = this.card(activityId);
    const template = this.options.catalog.getTemplate({ templateId: card.templateId, version: card.prepared.instance.template.version })!;
    const stage = template.stages.find(item => item.id === this.projection(activityId).stage.id)!;
    const shown = new Set(this.options.host.exposures(activityId).filter(record => record.displayStatus !== 'not-displayed').flatMap(record => record.groups.map(group => group.groupId)));
    const groups = template.groups.filter(group => group.solutionBearing && Object.hasOwn(stage.visible, group.id) && !shown.has(group.id)).map(group => group.id);
    if (!groups.length) return { ok: true, codes: [], message: null };
    return this.reveal(activityId, groups);
  }
  /** Exploration scope for the current stage: its interactive controls and visible groups over the full parameter domains. */
  authorizeExploration(activityId: string): Promise<Outcome> {
    const card = this.card(activityId);
    const template = this.options.catalog.getTemplate({ templateId: card.templateId, version: card.prepared.instance.template.version })!;
    const manifest = this.options.catalog.getModel({ modelId: template.model.modelId, version: template.model.version })!;
    const stage = template.stages.find(item => item.id === this.projection(activityId).stage.id)!;
    const controls = template.controls.filter(control => stage.controls[control.parameter] === 'interactive');
    const groups = Object.keys(stage.visible);
    const parameterDomain = Object.fromEntries(controls.map(control => [control.parameter, [manifest.parameters[control.parameter]!.min, manifest.parameters[control.parameter]!.max] as [number, number]]));
    return this.hostStep(activityId, operationId => card.prepared.host.requestExplorationScope({ operationId, ...this.activityGuard(activityId), groups, parameterDomain }));
  }
  /** Guarded parameter commit through the learner binding (the exact-entry path of the card). */
  async commit(activityId: string, displayValues: Record<string, number>): Promise<Outcome> {
    const learner = this.card(activityId).learner;
    return outcomeOf(await learner.commitParameters({ operationId: this.op('commit'), ...learner.getProjection().guards, displayValues }));
  }
  async navigate(activityId: string, index: number): Promise<Outcome> {
    const learner = this.card(activityId).learner;
    return outcomeOf(await learner.navigate({ operationId: this.op('nav'), ...learner.getProjection().guards, position: { kind: 'index', index } }));
  }
  suspend(activityId: string): Outcome { return outcomeOf(this.card(activityId).prepared.host.suspend({ operationId: this.op('suspend'), reason: 'host' })); }
  resume(activityId: string): Outcome { return outcomeOf(this.card(activityId).prepared.host.resume({ operationId: this.op('resume') })); }
  async save(activityId: string, kind: 'backup' | 'learner-snapshot' = 'backup'): Promise<ActivityArtifact> {
    const saved = await this.card(activityId).prepared.host.save({ operationId: this.op('save'), kind });
    if (!saved.ok) throw new Error(`save failed: ${outcomeOf(saved).codes.join(', ')}`);
    return saved.artifact;
  }
  /** Disposes the card, then releases the activity. */
  close(activityId: string): void {
    const card = this.cards.get(activityId);
    if (!card) return;
    card.card.dispose();
    card.wrapper.remove();
    this.options.release(activityId);
    this.cards.delete(activityId);
  }
  closeAll(): void { for (const activityId of [...this.cards.keys()]) this.close(activityId); }

  /**
   * Resolves once the activity has settled: no reveal pending, journal saved, no host call of the activity in flight, and
   * the surface showing the current projection.
   */
  async settle(activityId: string, timeoutMs = 15_000): Promise<CardSummary> {
    const start = performance.now();
    for (;;) {
      const projection = this.projection(activityId);
      const inFlight = this.options.host.calls().some(call => call.activityId === activityId && call.settledAt === null);
      const rendered = this.surfaceRoot(activityId)?.dataset.emaProjection === projection.projectionId;
      if (!projection.pendingReveal && projection.status.persistence === 'saved' && !inFlight && rendered) return this.summary(activityId);
      if (performance.now() - start > timeoutMs) {
        throw new Error(`${activityId} did not settle: reveal=${projection.pendingReveal?.state ?? 'none'} persistence=${projection.status.persistence} inFlight=${inFlight} rendered=${rendered}`);
      }
      await wait(10);
    }
  }
  /** Frozen capture of one view of the card, serialized for the driver. */
  async capture(activityId: string, format: 'svg' | 'png', viewId?: string): Promise<SerializedCapture> {
    const result = await this.card(activityId).card.capture({ format, ...(viewId ? { viewId } : {}), scale: 1 });
    return {
      mimeType: result.mimeType, width: result.width, height: result.height, fonts: result.fonts, companionText: result.companionText, metadata: result.metadata,
      pngBase64: result.mimeType === 'image/png' ? toBase64(result.bytes) : null, svgLength: result.mimeType === 'image/svg+xml' ? result.svg.length : null,
    };
  }
}
