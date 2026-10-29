/**
 * Fixed toolkit page for `experiment-kit activity preview` (report §15.2). No authored code is in this page: the model
 * (authored kernel, installed kernels or bounded document execution) runs only in the bundle's module worker. The page
 * reads `preview-input.json` (written by the CLI) and runs two clearly separated lanes, each a real adapter activity
 * against its own in-page browser integration fixture host (a conformance fixture, not a Study Harness host):
 *
 * - Author view: the author-view template (every group visible and every control listed in every stage), prepared in
 *   exploratory mode under an author policy whose ceiling is every group. It is an author aid, never a learner channel.
 *   Its group table states, for the selected stage, what the learner view shows of each group and why not.
 * - Learner view: the template itself under the supplied `--policy` or the derived default learner policy. It mounts
 *   `StudyActivitySurface` with the learner binding, and its JSON panel is the learner projection, nothing else.
 *
 * The stage selector moves both lanes through the adapter's host-authorized flow: `requestStageTransition` along the
 * template's transitions (receipts, persist-before-reveal and display acknowledgement as in a host). A stage the
 * current stage cannot reach restarts the activity at the initial stage and walks the transitions from there; a stage
 * no transition reaches is prepared directly, its solution-bearing groups requested through `requestReveal` like a
 * stage entry. Under a policy with an active independent task every stage is prepared directly and the host enters the
 * task, so only the policy's neutral scaffold can show. The diagnostics panel lists the package's validation and
 * semantic diagnostics and the surface diagnostics each mounted surface reports for the selected stage. A package whose
 * model, template or kernel does not validate gets the diagnostics panel only (`status: 'blocked'`): no activity can be
 * prepared, and the CLI bundles no authored code for it.
 */
import {
  computeVisibility, createStudyHarnessAdapter, groupDigests, solutionGroupsFor,
  type ActivityBinding, type ActivityCatalog, type ActivityTemplate, type Diagnostic, type HostPolicy, type LearnerProjection,
  type PreparedActivity, type StudyHarnessAdapter, type TemplateRef, type TransitionSpec, type Visibility,
} from '@experiment-kit/activity';
import { createInstalledCatalog } from '@experiment-kit/catalog';
import { enableDocumentExecution, validateManifest, type ModelRef } from '@experiment-kit/core/model';
import { mountStudyActivity, type MountedStudyActivity, type SurfaceDiagnostic } from '@experiment-kit/player/activity';
import { FixtureHost } from '../../../examples/study-harness-host/fixture-host.js';
import { authoredCatalog, modelWorker, wait } from './activity-page-support.js';
import type { AuthorDiagnostic } from './activity-validation.js';
import type { PolicyNotes } from './activity-policy.js';

/** What the CLI writes to `preview-input.json` for a package that validates. */
export interface PreviewInput {
  status: 'ready';
  title: string;
  source: { kind: 'package'; directory: string } | { kind: 'installed'; templateId: string };
  identity: { template: TemplateRef; model: ModelRef; lifecycle: string };
  template: ActivityTemplate;
  manifest: unknown;
  installed: boolean;
  /** The author-view template and policy (activity-policy.ts `authorViewTemplate`/`authorViewPolicy`). */
  author: { template: ActivityTemplate; policy: HostPolicy };
  learner: { policy: HostPolicy; mode: 'approved' | 'exploratory'; source: 'supplied' | 'derived'; file: string | null; notes: PolicyNotes };
  diagnostics: AuthorDiagnostic[];
  stage: string | null;
  theme: 'light' | 'dark' | 'system';
  fonts: 'bundled' | 'system';
}

/** What the CLI writes for a package with blocking errors: the page shows its diagnostics only. */
export interface BlockedPreviewInput {
  status: 'blocked';
  title: string;
  source: PreviewInput['source'];
  diagnostics: AuthorDiagnostic[];
  theme: PreviewInput['theme'];
}

export interface RouteStep {
  kind: 'prepared' | 'transition' | 'reveal' | 'independent' | 'restart';
  stage: string;
  from?: string;
  transitionId?: string;
  groups?: string[];
  receiptId?: string | null;
  ok: boolean;
  codes?: string[];
  note?: string;
}
export interface LaneDiagnostic { code: string; source: string; message: string; path: string | null }
export interface LaneState {
  role: 'author' | 'learner';
  activityId: string | null;
  stageId: string | null;
  route: RouteStep[];
  projection: LearnerProjection | null;
  surfaceDiagnostics: LaneDiagnostic[];
  failures: LaneDiagnostic[];
}
export interface GroupStatus {
  groupId: string; kind: string; label: string; solutionBearing: boolean;
  /** The template stage's own visibility of the group. */
  staged: Visibility;
  inCeiling: boolean;
  /** What the learner view shows of the group (computeVisibility with the host's grants for the learner activity). */
  learner: Visibility;
  reason: string | null;
}
export interface PreviewState {
  ready: boolean;
  /** True when the package does not validate and only its diagnostics are shown. */
  blocked: boolean;
  busy: boolean;
  error: string | null;
  stageId: string | null;
  stages: string[];
  author: LaneState;
  learner: LaneState;
  groups: GroupStatus[];
  diagnostics: { package: AuthorDiagnostic[]; author: LaneDiagnostic[]; learner: LaneDiagnostic[] };
}
declare global {
  interface Window { __activityPreview?: { ready: boolean; state(): PreviewState; selectStage(stageId: string): Promise<PreviewState> } }
}

const SURFACE_LIMIT = 64;
const failuresOf = (diagnostics: readonly Diagnostic[]): LaneDiagnostic[] => diagnostics.map(item => ({ code: item.code, source: 'binding', message: item.message, path: item.path }));

/** Shortest transition path from `from` to `to` (breadth-first over the template's transitions, in declaration order). */
export function transitionPath(template: ActivityTemplate, from: string, to: string): TransitionSpec[] | null {
  if (from === to) return [];
  const previous = new Map<string, TransitionSpec>();
  const queue = [from];
  const seen = new Set([from]);
  while (queue.length) {
    const stage = queue.shift()!;
    for (const transition of template.transitions.filter(item => item.from === stage)) {
      if (seen.has(transition.to)) continue;
      seen.add(transition.to);
      previous.set(transition.to, transition);
      if (transition.to === to) {
        const path: TransitionSpec[] = [];
        for (let at = to; at !== from; at = previous.get(at)!.from) path.unshift(previous.get(at)!);
        return path;
      }
      queue.push(transition.to);
    }
  }
  return null;
}

/** One preview lane: a real adapter activity, its fixture host and its mounted surface. */
class Lane {
  private readonly host = new FixtureHost({ storage: null });
  private readonly adapter: StudyHarnessAdapter;
  private prepared: PreparedActivity | null = null;
  binding: ActivityBinding | null = null;
  private surface: MountedStudyActivity | null = null;
  private generation = 0;
  private mounts = 0;
  private operations = 0;
  private unsubscribe: (() => void) | null = null;
  route: RouteStep[] = [];
  surfaceDiagnostics: LaneDiagnostic[] = [];
  failures: LaneDiagnostic[] = [];
  readonly digests: Record<string, string>;
  readonly refs: { template: TemplateRef; model: ModelRef };

  constructor(
    readonly role: 'author' | 'learner', readonly template: ActivityTemplate, private readonly catalog: ActivityCatalog, readonly policy: HostPolicy,
    private readonly mode: 'approved' | 'exploratory', manifest: ReturnType<typeof validateManifest>, private readonly container: HTMLElement,
    private readonly view: { theme: PreviewInput['theme']; fonts: PreviewInput['fonts']; changed(): void },
  ) {
    this.adapter = createStudyHarnessAdapter({ catalog, host: this.host, maxWorkers: 2 });
    this.digests = Object.fromEntries(groupDigests(template, manifest.manifest).map(item => [item.groupId, item.contentDigest]));
    const entry = catalog.listTemplates().find(item => item.template.templateId === template.templateId && item.template.version === template.version);
    if (!entry) throw new Error(`The ${role} catalogue does not serve ${template.templateId}@${template.version}.`);
    this.refs = { template: entry.template, model: entry.model };
  }

  get activityId(): string | null { return this.prepared?.activityId ?? null; }
  get stageId(): string | null { return this.binding?.getProjection().stage.id ?? null; }
  get independent(): boolean { return this.policy.independentTask.active && this.policy.independentTask.taskRef !== null; }
  private operation(kind: string): string { return `${this.role}-${kind}-${++this.operations}`.slice(0, 128); }
  private lastReceipt(): string | null {
    return this.activityId ? this.host.receipts(this.activityId).at(-1)?.receiptId ?? null : null;
  }
  /** Exposure records of the learner activity's current lineage, as the host holds them. */
  exposures() { return this.activityId && this.binding?.getProjection().context !== 'independent' ? this.host.exposures(this.activityId) : []; }

  /** Prepares a new activity of this lane at `stageId` (the previous one is disposed), then authorizes the stage entry. */
  async prepareAt(stageId: string): Promise<boolean> {
    this.unmount();
    this.unsubscribe?.(); this.unsubscribe = null;
    if (this.prepared) this.adapter.dispose(this.prepared.activityId);
    this.prepared = null; this.binding = null;
    const activityId = `${this.role}-preview-${++this.generation}`;
    const policy = this.host.setPolicy(activityId, structuredClone(this.policy));
    const outcome = await this.adapter.prepare({
      activityId, objectiveIds: ['activity-preview'], hostSessionId: 'activity-preview', hostSessionRevision: 0,
      template: { templateId: this.template.templateId, version: this.template.version }, mode: this.mode, stageId,
    }, { operationId: this.operation('prepare') });
    if (!outcome.ok) {
      this.failures.push(...failuresOf(outcome.diagnostics));
      this.route.push({ kind: 'prepared', stage: stageId, ok: false, codes: outcome.diagnostics.map(item => item.code) });
      return false;
    }
    this.prepared = outcome.prepared;
    this.binding = outcome.prepared.binding('learner', `${this.role}-binding-${this.generation}`);
    this.unsubscribe = this.binding.subscribe(() => this.view.changed());
    this.route.push({ kind: 'prepared', stage: stageId, ok: true });
    this.mount();
    if (this.independent) {
      // The host enters the policy's independent task: only its neutral scaffold can show, and grants end.
      const entered = await outcome.prepared.host.enterIndependentTask({ operationId: this.operation('independent'), taskRef: policy.independentTask.taskRef!, policy });
      this.route.push({ kind: 'independent', stage: stageId, ok: entered.ok, ...(entered.ok ? {} : { codes: entered.diagnostics.map(item => item.code) }) });
      if (!entered.ok) this.failures.push(...failuresOf(entered.diagnostics));
      await this.settle();
      return entered.ok;
    }
    // The stage's solution-bearing groups inside the ceiling, requested from the host as a stage entry would be.
    const stage = this.template.stages.find(item => item.id === stageId)!;
    const solution = solutionGroupsFor(this.template, stage, policy, 'instructional').map(group => group.id);
    if (solution.length) {
      const before = this.binding.getProjection();
      const revealed = await outcome.prepared.host.requestReveal({ operationId: this.operation('reveal'), expectedActivityRevision: before.activityRevision, expectedPolicyRevision: before.policyRevision, groups: solution });
      this.route.push({ kind: 'reveal', stage: stageId, groups: solution, ok: revealed.ok, receiptId: revealed.ok ? this.lastReceipt() : null, ...(revealed.ok ? {} : { codes: revealed.diagnostics.map(item => item.code) }) });
      if (!revealed.ok) this.failures.push(...failuresOf(revealed.diagnostics));
    }
    await this.settle();
    return true;
  }

  /** Moves this lane to `target` through host-authorized transitions (see the module comment). */
  async goTo(target: string): Promise<void> {
    this.route = []; this.failures = [];
    if (this.independent || !this.binding) { await this.prepareAt(target); return; }
    let path = transitionPath(this.template, this.stageId!, target);
    if (!path) {
      const initial = this.template.initialStage;
      this.route.push({ kind: 'restart', stage: initial, ok: true, note: `No transition leads from ${this.stageId} to ${target}: the activity restarts at the initial stage.` });
      if (!(await this.prepareAt(initial))) return;
      path = transitionPath(this.template, initial, target);
      if (!path) {
        this.route.push({ kind: 'restart', stage: target, ok: true, note: `No transition reaches ${target} from the initial stage: the activity is prepared at it directly.` });
        await this.prepareAt(target);
        return;
      }
    }
    for (const transition of path) {
      const projection = this.binding!.getProjection();
      const outcome = await this.prepared!.host.requestStageTransition({
        operationId: this.operation('transition'), expectedActivityRevision: projection.activityRevision, expectedPolicyRevision: projection.policyRevision, toStage: transition.to,
      });
      this.route.push({ kind: 'transition', stage: transition.to, from: transition.from, transitionId: transition.id, ok: outcome.ok, receiptId: outcome.ok ? this.lastReceipt() : null, ...(outcome.ok ? {} : { codes: outcome.diagnostics.map(item => item.code) }) });
      if (!outcome.ok) { this.failures.push(...failuresOf(outcome.diagnostics)); return; }
      await this.settle();
    }
  }

  /**
   * Waits until the host has answered the pending authorization and the activity is not preparing or persisting. It
   * does not wait for the display acknowledgement: a surface acknowledges a grant only while it is visible, so a lane
   * scrolled out of view (the stacked layout on narrow screens) shows the grant as awaiting display until it is seen.
   */
  async settle(): Promise<void> {
    for (let attempt = 0; attempt < 200 && this.binding; attempt++) {
      const projection = this.binding.getProjection();
      if (projection.pendingReveal?.state !== 'requesting' && projection.status.ui !== 'preparing' && projection.status.ui !== 'awaiting-persistence') return;
      await wait(50);
    }
  }

  /** Mounts a fresh surface, so every surface diagnostic of the selected stage is reported to this mount. */
  mount(): void {
    this.unmount();
    if (!this.binding) return;
    this.surfaceDiagnostics = [];
    const surfaceId = `${this.role}-surface-${this.generation}-${++this.mounts}`;
    this.surface = mountStudyActivity(this.container, {
      binding: this.binding, surfaceId, theme: this.view.theme, fonts: this.view.fonts, headingLevel: 3, assetBase: new URL('./assets/', location.href),
      onDiagnostic: (diagnostic: SurfaceDiagnostic) => {
        if (this.surfaceDiagnostics.length >= SURFACE_LIMIT) return;
        this.surfaceDiagnostics.push({ code: diagnostic.code, source: diagnostic.source, message: diagnostic.message, path: diagnostic.path ?? null });
        this.view.changed();
      },
    });
  }
  async mounted(): Promise<void> { try { await this.surface?.ready; } catch { /* disposed before the first render */ } }
  unmount(): void { this.surface?.dispose(); this.surface = null; }

  state(): LaneState {
    return {
      role: this.role, activityId: this.activityId, stageId: this.stageId, route: structuredClone(this.route), projection: this.binding ? structuredClone(this.binding.getProjection()) : null,
      surfaceDiagnostics: [...this.surfaceDiagnostics], failures: [...this.failures],
    };
  }
}

/** Status of every template group in the learner lane's current stage, with the reason a group is not shown. */
function groupStatus(input: PreviewInput, learner: Lane): GroupStatus[] {
  const projection = learner.binding?.getProjection();
  const stage = input.template.stages.find(item => item.id === projection?.stage.id);
  if (!projection || !stage) return [];
  const policy = learner.policy;
  const context = { kind: projection.context, digests: learner.digests, template: learner.refs.template, model: learner.refs.model };
  const visibility = computeVisibility(input.template, stage, policy, learner.exposures(), context);
  const ceiling = new Set(policy.visibleGroups), scaffold = new Set(policy.independentTask.neutralScaffold);
  return input.template.groups.map(group => {
    const staged: Visibility = Object.hasOwn(stage.visible, group.id) ? stage.visible[group.id]! : 'absent';
    const shown = visibility[group.id] ?? 'absent';
    const reason = shown !== 'absent' ? null
      : staged === 'absent' ? 'not in this stage'
        : !ceiling.has(group.id) ? 'outside the policy ceiling'
          : projection.context === 'independent' && !scaffold.has(group.id) ? 'not in the independent task scaffold'
            : group.solutionBearing ? 'no host grant for this stage' : 'not shown';
    return { groupId: group.id, kind: group.kind, label: group.label, solutionBearing: group.solutionBearing, staged, inCeiling: ceiling.has(group.id), learner: shown, reason };
  });
}

// ---------------------------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------------------------
function element<K extends keyof HTMLElementTagNameMap>(tag: K, attributes: Record<string, string> = {}, ...children: (Node | string | null)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  for (const child of children) if (child !== null) node.append(child);
  return node;
}
const visibilityText = (value: Visibility): string => value === 'absent' ? 'hidden' : value;

function diagnosticItem(severity: string, code: string, where: string, message: string, recovery?: string): HTMLLIElement {
  return element('li', { class: `pv-diag pv-diag--${severity}`, 'data-code': code, 'data-severity': severity },
    element('span', { class: 'pv-diag-severity' }, severity), element('code', { class: 'pv-diag-code' }, code),
    where ? element('span', { class: 'pv-diag-where' }, where) : null, element('span', { class: 'pv-diag-message' }, message),
    recovery ? element('span', { class: 'pv-diag-recovery' }, recovery) : null);
}
function diagnosticGroup(title: string, items: HTMLLIElement[], empty: string, key: string): HTMLElement {
  return element('section', { class: 'pv-diag-group', 'data-preview': `diagnostics-${key}` }, element('h3', {}, `${title} (${items.length})`),
    items.length ? element('ul', {}, ...items) : element('p', { class: 'pv-empty' }, empty));
}
const packageItems = (diagnostics: readonly AuthorDiagnostic[]) => diagnostics.map(item => diagnosticItem(item.severity, item.code, `${item.file} ${item.path}`, item.message, item.recovery));

/** Diagnostics-only page for a package that does not validate. */
function startBlocked(root: HTMLElement, input: BlockedPreviewInput): void {
  document.title = `Preview: ${input.title}`;
  const errors = input.diagnostics.filter(item => item.severity === 'error').length;
  root.replaceChildren(
    element('header', { class: 'pv-header' },
      element('p', { class: 'pv-eyebrow' }, 'Experiment Kit · activity preview · author aid'),
      element('h1', {}, input.title),
      element('p', { class: 'pv-identity' }, input.source.kind === 'package' ? input.source.directory : input.source.templateId)),
    element('p', { class: 'pv-blocked', role: 'status', 'data-preview': 'blocked' },
      `This package does not validate (${errors} ${errors === 1 ? 'error' : 'errors'}), so no activity can be prepared and no authored code was loaded. Fix the errors below, then run the preview again.`),
    element('section', { class: 'pv-diagnostics', 'aria-labelledby': 'pv-diagnostics-title' },
      element('h2', { id: 'pv-diagnostics-title' }, 'Diagnostics'),
      element('div', { class: 'pv-diagnostics-body', 'data-preview': 'diagnostics' },
        diagnosticGroup('Package validation and semantics', packageItems(input.diagnostics), 'No validation or semantic diagnostics.', 'package'))),
  );
  const empty: LaneState = { role: 'learner', activityId: null, stageId: null, route: [], projection: null, surfaceDiagnostics: [], failures: [] };
  const state = (): PreviewState => ({
    ready: true, blocked: true, busy: false, error: null, stageId: null, stages: [], author: { ...empty, role: 'author' }, learner: empty, groups: [],
    diagnostics: { package: input.diagnostics, author: [], learner: [] },
  });
  window.__activityPreview = { ready: true, state, selectStage: () => Promise.reject(new Error('The package does not validate.')) };
}

async function start(): Promise<void> {
  const root = document.querySelector<HTMLElement>('#preview-root')!;
  const response = await fetch('./preview-input.json', { cache: 'no-store' });
  const payload = await response.json() as PreviewInput | BlockedPreviewInput;
  if (payload.theme !== 'system') document.documentElement.dataset.theme = payload.theme;
  if (payload.status === 'blocked') { startBlocked(root, payload); return; }
  const input = payload;
  document.documentElement.lang = input.template.locale;
  document.title = `Preview: ${input.title}`;
  enableDocumentExecution(); // authored packages may execute a bounded schema 2.0 document (architecture D3)
  const manifest = validateManifest(input.manifest);
  const learnerCatalog: ActivityCatalog = input.installed ? createInstalledCatalog({ include: [input.template.templateId], workerFactory: modelWorker }) : authoredCatalog(input.template, manifest);
  const authorCatalog = authoredCatalog(input.author.template, manifest);

  // ---- static structure ---------------------------------------------------------------------------------------
  const stageSelect = element('select', { id: 'pv-stage', 'data-preview': 'stage' });
  for (const stage of input.template.stages) stageSelect.append(element('option', { value: stage.id }, `${stage.id} (${stage.kind})`));
  const routeText = element('p', { class: 'pv-route', 'aria-live': 'polite', 'data-preview': 'route' });
  const busyText = element('span', { class: 'pv-busy', 'data-preview': 'busy' });
  const instruction = element('p', { class: 'pv-instruction', 'data-preview': 'instruction' });
  const groupsBody = element('tbody');
  const groupsSummary = element('summary');
  const authorSurface = element('div', { class: 'pv-surface', 'data-preview': 'author-surface' });
  const learnerSurface = element('div', { class: 'pv-surface', 'data-preview': 'learner-surface' });
  const learnerJson = element('pre', { class: 'pv-json', 'data-preview': 'learner-json', tabindex: '0' });
  const diagnosticsList = element('div', { class: 'pv-diagnostics-body', 'data-preview': 'diagnostics' });
  const diagnosticsJump = element('a', { href: '#pv-diagnostics-title', 'data-preview': 'jump-diagnostics' }, 'Diagnostics');
  const codeChips = element('p', { class: 'pv-chips', 'data-preview': 'codes' });
  const policy = input.learner;
  const policyText = policy.source === 'supplied'
    ? `supplied policy ${policy.policy.policyId} (revision ${policy.policy.revision}, ${policy.mode}) from ${policy.file}`
    : `the derived default learner policy (${policy.mode}; every group inside the ceiling, learner tools only)`;

  root.replaceChildren(
    element('header', { class: 'pv-header' },
      element('p', { class: 'pv-eyebrow' }, 'Experiment Kit · activity preview · author aid'),
      element('h1', {}, input.title),
      element('p', { class: 'pv-identity' },
        `${input.identity.template.templateId}@${input.identity.template.version} · model ${input.identity.model.modelId}@${input.identity.model.version} · lifecycle ${input.identity.lifecycle}`),
      element('p', { class: 'pv-note' }, 'Runs the real adapter against in-page browser integration fixture hosts (conformance fixtures, not a Study Harness host). Authored model code runs only in this page\'s module worker. Nothing here is a subject review.'),
    ),
    element('div', { class: 'pv-stagebar', role: 'group', 'aria-label': 'Stage' },
      element('label', { for: 'pv-stage' }, 'Stage'), stageSelect, busyText, routeText,
      element('nav', { class: 'pv-jumps', 'aria-label': 'Preview sections' },
        element('a', { href: '#pv-author-title' }, 'Author view'), element('a', { href: '#pv-learner-title' }, 'Learner view'), diagnosticsJump)),
    instruction,
    element('div', { class: 'pv-columns' },
      element('section', { class: 'pv-lane pv-lane--author', 'aria-labelledby': 'pv-author-title', 'data-preview': 'author' },
        element('div', { class: 'pv-lane-head' },
          element('span', { class: 'pv-badge pv-badge--author' }, 'Author'),
          element('h2', { id: 'pv-author-title' }, 'Author view'),
        ),
        element('p', { class: 'pv-lane-note' }, 'Every group of the template, visible in every stage and revealed by the fixture host. Not a learner channel.'),
        element('details', { class: 'pv-groups', open: '' }, groupsSummary,
          element('div', { class: 'pv-table-wrap' },
            element('table', {},
              element('thead', {}, element('tr', {}, ...['Group', 'Stage', 'Learner view'].map(name => element('th', { scope: 'col' }, name)))),
              groupsBody))),
        authorSurface,
      ),
      element('section', { class: 'pv-lane pv-lane--learner', 'aria-labelledby': 'pv-learner-title', 'data-preview': 'learner' },
        element('div', { class: 'pv-lane-head' },
          element('span', { class: 'pv-badge pv-badge--learner' }, 'Learner'),
          element('h2', { id: 'pv-learner-title' }, 'Learner view'),
        ),
        element('p', { class: 'pv-lane-note' }, `Exactly what the learner projection shows in this stage under ${policyText}.`),
        learnerSurface,
        element('details', { class: 'pv-projection' }, element('summary', {}, 'Learner projection (JSON)'), learnerJson),
      ),
    ),
    element('section', { class: 'pv-diagnostics', 'aria-labelledby': 'pv-diagnostics-title' },
      element('h2', { id: 'pv-diagnostics-title' }, 'Diagnostics'), codeChips, diagnosticsList),
  );

  const changed = (() => { let queued = false; return () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; render(); }); }; })();
  const view = { theme: input.theme, fonts: input.fonts, changed };
  const author = new Lane('author', input.author.template, authorCatalog, input.author.policy, 'exploratory', manifest, authorSurface, view);
  const learner = new Lane('learner', input.template, learnerCatalog, input.learner.policy, input.learner.mode, manifest, learnerSurface, view);
  let busy = false, error: string | null = null, ready = false;

  const state = (): PreviewState => ({
    ready, blocked: false, busy, error, stageId: learner.stageId, stages: input.template.stages.map(stage => stage.id), author: author.state(), learner: learner.state(), groups: groupStatus(input, learner),
    diagnostics: { package: input.diagnostics, author: [...author.failures, ...author.surfaceDiagnostics], learner: [...learner.failures, ...learner.surfaceDiagnostics] },
  });

  function render(): void {
    const current = state();
    stageSelect.disabled = busy || !ready;
    if (learner.stageId && stageSelect.value !== learner.stageId && !busy) stageSelect.value = learner.stageId;
    busyText.textContent = busy ? 'Moving through the host…' : '';
    const stage = input.template.stages.find(item => item.id === current.stageId);
    instruction.textContent = stage ? `${stage.kind} · ${stage.instruction}${stage.response ? ` · host-owned ${stage.response.kind} request: ${stage.response.prompt}` : ''}` : '';
    routeText.textContent = error ?? describeRoute(learner.route);
    const groups = current.groups;
    groupsSummary.textContent = `Groups in this stage: the learner view shows ${groups.filter(group => group.learner !== 'absent').length} of ${groups.length}`;
    groupsBody.replaceChildren(...groups.map(group => element('tr', { 'data-group': group.groupId, 'data-learner': group.learner },
      element('th', { scope: 'row' }, element('code', {}, group.groupId), group.solutionBearing ? element('span', { class: 'pv-tag' }, 'solution') : null,
        element('span', { class: 'pv-kind' }, group.kind)),
      element('td', {}, visibilityText(group.staged)),
      element('td', { class: group.learner === 'absent' ? 'pv-hidden' : 'pv-shown' }, group.learner === 'absent' ? `hidden: ${group.reason}` : visibilityText(group.learner)))));
    learnerJson.textContent = current.learner.projection ? JSON.stringify(current.learner.projection, null, 2) : '';

    const notes = input.learner.notes;
    const policyItems = [
      ...notes.groupsOutsideCeiling.map(id => diagnosticItem('info', 'OUTSIDE_CEILING', `group ${id}`, 'The learner policy ceiling omits this group, so the learner view never shows it.')),
      ...notes.controlsNotPermitted.map(id => diagnosticItem('info', 'CONTROL_NOT_PERMITTED', `control ${id}`, 'The learner policy does not permit this control.')),
      ...notes.unknownGroups.map(id => diagnosticItem('warning', 'INVALID_REFERENCE', `visibleGroups ${id}`, 'The learner policy names a group this template does not have.')),
      ...notes.unknownControls.map(id => diagnosticItem('warning', 'INVALID_REFERENCE', `permittedControls ${id}`, 'The learner policy names a control this template does not have.')),
      ...(notes.independentTask ? [diagnosticItem('info', 'INDEPENDENT_CONTEXT', 'independentTask', 'The learner policy has an active independent task: only its neutral scaffold can show.')] : []),
    ];
    const laneItems = (diagnostics: LaneDiagnostic[]) => diagnostics.map(item => diagnosticItem(item.source === 'binding' ? 'error' : 'warning', item.code, item.path ?? '', item.message));
    diagnosticsList.replaceChildren(
      diagnosticGroup('Package validation and semantics', packageItems(input.diagnostics), 'No validation or semantic diagnostics.', 'package'),
      diagnosticGroup('Learner policy', policyItems, `Learner policy: ${policyText}. It withholds nothing the template declares.`, 'policy'),
      diagnosticGroup(`Author view surface · ${current.stageId ?? ''}`, laneItems(current.diagnostics.author), 'The author view surface reported nothing for this stage.', 'author'),
      diagnosticGroup(`Learner view surface · ${current.stageId ?? ''}`, laneItems(current.diagnostics.learner), 'The learner view surface reported nothing for this stage.', 'learner'),
    );
    const counts = new Map<string, number>();
    for (const code of [...input.diagnostics.map(item => item.code), ...current.diagnostics.author.map(item => item.code), ...current.diagnostics.learner.map(item => item.code)]) counts.set(code, (counts.get(code) ?? 0) + 1);
    const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
    diagnosticsJump.textContent = `Diagnostics (${total})`;
    codeChips.replaceChildren(...(counts.size ? [...counts.entries()].map(([code, count]) => element('span', { class: 'pv-chip', 'data-code': code }, `${code} ×${count}`)) : [element('span', { class: 'pv-chip pv-chip--clear' }, 'No diagnostics')]));
  }

  function describeRoute(route: RouteStep[]): string {
    if (!route.length) return '';
    return route.map(step => {
      const receipt = step.receiptId ? ` (host receipt ${step.receiptId})` : '';
      const failed = step.ok ? '' : ` failed: ${(step.codes ?? []).join(', ')}`;
      switch (step.kind) {
        case 'prepared': return `Prepared at ${step.stage}${failed}.`;
        case 'transition': return `${step.from} → ${step.stage} by transition ${step.transitionId}${receipt}${failed}.`;
        case 'reveal': return `Host authorized ${step.groups?.join(', ')} at stage entry${receipt}${failed}.`;
        case 'independent': return `Host entered the independent task${failed}.`;
        default: return step.note ?? '';
      }
    }).join(' ');
  }

  async function selectStage(stageId: string): Promise<PreviewState> {
    if (!input.template.stages.some(stage => stage.id === stageId)) throw new Error(`The template has no stage ${stageId}.`);
    while (busy) await wait(30);
    busy = true; error = null; render();
    try {
      await Promise.all([author.goTo(stageId), learner.goTo(stageId)]);
      // Fresh surfaces for the selected stage: every surface diagnostic of this stage is reported to them.
      author.mount(); learner.mount();
      await Promise.all([author.mounted(), learner.mounted()]);
      await Promise.all([author.settle(), learner.settle()]);
      await wait(120);
    } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
    finally { busy = false; render(); }
    return state();
  }

  stageSelect.addEventListener('change', () => { void selectStage(stageSelect.value); });
  window.__activityPreview = { ready: false, state, selectStage };

  const initial = input.template.initialStage;
  busy = true; render();
  await Promise.all([author.prepareAt(initial), learner.prepareAt(initial)]);
  busy = false; ready = true;
  if (input.stage && input.stage !== initial) await selectStage(input.stage);
  else {
    await Promise.all([author.mounted(), learner.mounted()]);
    await wait(120);
  }
  window.__activityPreview.ready = true;
  render();
}

start().catch(failure => {
  const root = document.querySelector<HTMLElement>('#preview-root');
  const message = failure instanceof Error ? failure.message : String(failure);
  if (root) root.replaceChildren(element('p', { class: 'pv-fatal', role: 'alert' }, `The preview could not start: ${message}`));
  window.__activityPreview = { ready: true, state: () => ({ ready: true, blocked: false, busy: false, error: message } as PreviewState), selectStage: () => Promise.reject(new Error(message)) };
});
