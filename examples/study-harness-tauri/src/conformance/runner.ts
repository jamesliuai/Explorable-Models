// CONFORMANCE BUILD ONLY (`vite --mode conformance`, bundled into the `--features conformance` binary). The in-app
// scenario runner of the packaged conformance run (architecture D13, native.md N10). The Node driver
// (scripts/conformance.mjs) launches the packaged binary with SH_SCENARIO / SH_PHASE / SH_CRASH_AT / SH_REPORT_OUT, a
// fresh app-data directory per scenario chain, bounded waits and process termination; this module drives the host's
// own controls (host buttons by DOM click, the composer inside the card, the card's camera button) and the learner
// binding (preview gesture, navigation), observes the card, and writes a report through the test-only command.
// It never reads host records directly: the driver reads the SQLite store after each process ends.
import type { ExposureRecord, LearnerProjection } from '@explorable-models/activity';
import { HOST_CONFORMANCE_STEPS, runHostPortConformance, type HostConformanceHooks, type HostConformanceRun } from '@explorable-models/activity/conformance';
import packed from '../../packed-artifacts.json';
import type { ReferenceHostApp } from '../app';
import { call, onCall, type CallRecord } from '../native-bridge';
import { hostCommands, NativeHostPort } from '../native-host';
import { spatialRecords } from '../spatial';
import { performanceScenario } from './performance';
import {
  audit, captureProbes, delay, environmentProbes, ipcProbes, mathProbe, negativeProbes, originsProbe, probe, webglProbe, type Json, type ProbeResult,
} from './probes';

interface Scenario {
  scenario: string;
  phase: string;
  crashAt: string | null;
  crashPoints: string[];
  generation: number;
  ungrantedExecuted: boolean;
  reportConfigured: boolean;
  appDataDir: string | null;
  pid: number;
  tauriVersion: string;
  webviewVersion: string | null;
  identifier: string;
  configuredCsp: string | null;
  workerScriptCsp: string;
  debugAssertions: boolean;
  armedPoints: string[];
  faultPoints: string[];
  /** Run identity for the HostPort conformance kit's result (executable sha256 computed by the binary itself). */
  identity: { executableSha256: string | null; arch: string; os: string; osVersion: string | null; sourceCommit: string | null; sourceDirty: boolean | null };
}
interface Step { id: string; ok: boolean; ms: number; detail: Json; error?: string }

const QUADRATIC = { templateId: 'quadratic-gradient-descent', version: '1.0.0' };
const toJson = (value: unknown): Json => JSON.parse(JSON.stringify(value ?? null)) as Json;
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 500);

class Report {
  readonly steps: Step[] = [];
  readonly probes: ProbeResult[] = [];
  readonly data: Record<string, Json> = {};
  status = 'running';
  /**
   * Every refused or failed native call (fixed codes only, bounded). A HostPort refusal carries the Rust host's specific
   * code as `reason` (errors.rs), which the adapter's learner-facing diagnostic does not repeat; this host-side report
   * keeps it so a failed step can be traced to the host's decision. Never shown in the card.
   */
  readonly callFailures: { command: string; code: string | null; reason: string | null }[] = [];
  private readonly started = performance.now();
  constructor(readonly scenario: Scenario) {}

  noteCall(record: CallRecord): void {
    if (!record.ok && this.callFailures.length < 64) this.callFailures.push({ command: record.command, code: record.code, reason: record.reason });
  }
  async step(id: string, run: () => Promise<unknown>): Promise<boolean> {
    const started = performance.now();
    const failuresBefore = this.callFailures.length;
    let ok: boolean;
    try {
      const detail = await run();
      this.steps.push({ id, ok: true, ms: Math.round(performance.now() - started), detail: toJson(detail ?? null) });
      ok = true;
    } catch (error) {
      // The native calls that failed during this step, with the host's reason (host-side evidence only).
      const hostFailures = this.callFailures.slice(failuresBefore);
      this.steps.push({ id, ok: false, ms: Math.round(performance.now() - started), detail: toJson({ hostFailures }), error: errorText(error) });
      ok = false;
    }
    // Progress is written after every step so the driver can tell where a run stopped.
    await this.write('running').catch(() => undefined);
    return ok;
  }
  check(id: string, ok: boolean, detail: unknown): void {
    this.steps.push({ id, ok, ms: 0, detail: toJson(detail) });
  }
  async write(status: string): Promise<void> {
    this.status = status;
    const document = {
      schema: 'study-harness-reference.conformance-report/1',
      scenario: this.scenario,
      status,
      durationMs: Math.round(performance.now() - this.started),
      userAgent: navigator.userAgent,
      origin: location.origin,
      steps: this.steps,
      probes: this.probes,
      data: this.data,
      csp: { violations: audit().violations, requests: audit().requests },
      diagnostics: [] as Json[],
    };
    await call('conformance_report', document);
  }
}

// ---- waiting and DOM helpers ------------------------------------------------------------------------------------
async function until(condition: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(50);
  }
}
/** A short task delay (animation frames do not run while the window is hidden). */
const nextFrame = () => delay(30);
/** Whether WebKit considers the window visible; display acknowledgements and previews need a visible surface. */
const windowVisible = (): boolean => document.visibilityState === 'visible';
/** Rendering-dependent probes wait for layout and fonts; a hidden window gets a short bound and is reported as such. */
const renderTimeout = (): number => windowVisible() ? 30_000 : 6_000;

async function hostButton(action: string, key?: string): Promise<HTMLButtonElement> {
  const selector = `#host-panel [data-host-action="${action}"]${key ? `[data-host-key="${CSS.escape(key)}"]` : ''}`;
  let found: HTMLButtonElement | null = null;
  await until(() => { found = document.querySelector<HTMLButtonElement>(selector); return !!found && !found.disabled; }, `enabled host control ${action}${key ? `:${key}` : ''}`);
  return found!;
}
/** Clicks a host control and waits for the host step it starts to finish; throws with the step's failure text. */
async function clickHost(app: ReferenceHostApp, action: string, key?: string): Promise<void> {
  await nextFrame();
  const control = await hostButton(action, key);
  const logLength = app.getSnapshot().log.length;
  control.click();
  await until(() => app.getSnapshot().busy === null, `host step ${action} to finish`, 45_000);
  const log = app.getSnapshot().log.slice(0, Math.max(1, app.getSnapshot().log.length - logLength));
  const failed = log.find(line => / failed: /.test(line));
  if (failed) throw new Error(failed);
}
function cardRoot(app: ReferenceHostApp): ShadowRoot {
  const root = app.surface?.element.shadowRoot;
  if (!root) throw new Error('no learner card is mounted');
  return root;
}
/** Types into the host composer inside the card and submits it (React reads the native input event). */
async function respond(app: ReferenceHostApp, text: string): Promise<void> {
  const root = cardRoot(app);
  let area: HTMLTextAreaElement | null = null;
  await until(() => { area = root.querySelector<HTMLTextAreaElement>('[data-host-composer-text]'); return !!area; }, 'the host composer');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(area!, text);
  area!.dispatchEvent(new Event('input', { bubbles: true }));
  await nextFrame();
  const submit = root.querySelector<HTMLButtonElement>('[data-host-action="submit-response"]');
  if (!submit) throw new Error('no composer submit button');
  submit.click();
  await until(() => app.getSnapshot().busy === null, 'the response to be recorded', 20_000);
  await until(() => !root.querySelector('[data-host-composer-text]'), 'the composer to close after the response');
}
function binding(app: ReferenceHostApp) {
  if (!app.binding) throw new Error('no binding');
  return app.binding;
}
const projection = (app: ReferenceHostApp): LearnerProjection => binding(app).getProjection();
/** The frozen snapshot the host stored with the current activity's answer (A26), read back through the host command. */
async function answerSnapshot(app: ReferenceHostApp): Promise<Json> {
  const answer = app.hostState()?.instance.responses.find(response => response.kind === 'answer');
  const activityId = app.getSnapshot().current?.activityId;
  if (!answer || !activityId) throw new Error('no submitted answer in the current activity');
  return toJson(await hostCommands.responseSnapshot(activityId, answer.responseId));
}
const visible = (app: ReferenceHostApp): string[] => [...app.visibleGroups(projection(app))].sort();
const exposures = (app: ReferenceHostApp): ExposureRecord[] => app.hostState()?.exposures ?? [];

/** Everything the restart comparison needs, from the host-audience state and the projection. */
function captureState(app: ReferenceHostApp): Json {
  const state = app.hostState();
  const shown = app.binding?.getProjection() ?? null;
  return toJson({
    activityId: state?.activityId ?? null,
    kind: app.getSnapshot().current?.kind ?? null,
    scientific: state?.scientific ? { params: state.scientific.params, position: state.scientific.position, runId: state.scientific.runId, restoredFrom: state.scientific.restoredFrom ?? null, terminal: state.scientific.terminal } : null,
    guards: state?.guards ?? null,
    stage: state?.instance.stage.id ?? null,
    context: state?.instance.context ?? null,
    responses: state?.instance.responses.map(response => ({ responseId: response.responseId, kind: response.kind, status: response.status })) ?? [],
    exposures: (state?.exposures ?? []).map(record => ({ exposureId: record.exposureId, scope: record.scope, displayStatus: record.displayStatus, uncertainty: record.uncertainty?.code ?? null, groups: record.groups.map(group => group.groupId) })),
    projection: shown ? {
      ui: shown.status.ui, persistence: shown.status.persistence, frame: shown.frame, navigation: shown.navigation, camera: shown.presentation.views.landscape?.camera ?? null,
      presentationRevision: shown.presentation.revision, views: shown.views.map(view => view.viewId), visibleGroups: app.visibleGroups(shown) ? [...app.visibleGroups(shown)].sort() : [],
      context: shown.context, pendingReveal: shown.pendingReveal,
    } : null,
    restoredNotes: app.getSnapshot().restoredNotes,
  });
}

// ---- shared host flows ------------------------------------------------------------------------------------------
async function waitReady(app: ReferenceHostApp): Promise<void> {
  await until(() => app.getSnapshot().phase !== 'starting', 'the host to start', 30_000);
  if (app.getSnapshot().phase === 'failed') throw new Error(`host start failed: ${app.getSnapshot().error}`);
  if (app.surface) await app.surface.ready;
}
async function openQuadratic(app: ReferenceHostApp): Promise<Json> {
  const select = document.querySelector<HTMLSelectElement>('#host-template');
  if (select) { select.value = `${QUADRATIC.templateId}@${QUADRATIC.version}`; select.dispatchEvent(new Event('change')); }
  await clickHost(app, 'open');
  await until(() => !!app.surface, 'the learner card');
  await app.surface!.ready;
  await until(() => !!projection(app).frame && projection(app).status.ui !== 'preparing', 'the first committed frame');
  return { activityId: app.getSnapshot().current?.activityId ?? null, stage: projection(app).stage.id, visibleGroups: visible(app), frameId: projection(app).frame?.frameId ?? null };
}
async function toRevealed(app: ReferenceHostApp, report: Report): Promise<boolean> {
  return await report.step('host-response-prediction', async () => {
    await respond(app, 'Small steps should shrink the positions; larger steps may overshoot and grow.');
    return { responses: app.hostState()?.instance.responses.length ?? 0 };
  }) && await report.step('stage-explore-step', async () => {
    await clickHost(app, 'stage', 'explore-step');
    await until(() => projection(app).stage.id === 'explore-step', 'stage explore-step');
    return { stage: projection(app).stage.id, visibleGroups: visible(app), traceHidden: !visible(app).includes('trace') };
  });
}
/**
 * Host reveal: the host raises its ceiling and records the exposure intent; the card then shows the content and, when
 * its window is visible, acknowledges the display (the host persists it). A hidden window never acknowledges.
 */
async function revealTrace(app: ReferenceHostApp): Promise<Json> {
  await clickHost(app, 'reveal');
  await until(() => visible(app).includes('trace') && projection(app).pendingReveal?.state !== 'requesting', 'the authorized trace');
  const reveal = () => exposures(app).find(record => record.scope === 'reveal');
  if (windowVisible()) await until(() => reveal()?.displayStatus === 'displayed', 'the reveal display acknowledgement');
  else await delay(1500);
  return { windowVisible: windowVisible(), visibleGroups: visible(app), pendingReveal: toJson(projection(app).pendingReveal), exposures: exposures(app).map(record => [record.scope, record.displayStatus]) };
}

// ---- scenarios ----------------------------------------------------------------------------------------------------
/** Report §17 restart sequence: phases 1–3 share one app-data directory; the driver terminates between phases. */
async function restartScenario(app: ReferenceHostApp, report: Report): Promise<void> {
  const phase = report.scenario.phase;
  if (phase === '1') {
    if (!await report.step('fresh-store', async () => {
      await waitReady(app);
      if (app.getSnapshot().activities.length || app.getSnapshot().current) throw new Error('the app-data store is not empty');
      return { starts: app.getSnapshot().status?.starts ?? null };
    })) return report.write('failed');
    if (!await report.step('open-quadratic', () => openQuadratic(app))) return report.write('failed');
    if (!await toRevealed(app, report)) return report.write('failed');
    if (!await report.step('authorize-and-reveal-trace', () => revealTrace(app))) return report.write('failed');
    if (!windowVisible()) {
      // While WebKit reports the window hidden the activity is suspended (A42): scientific commands return NOT_READY and
      // no preview runs. The host scope is still recorded; the commit, navigation and camera steps are reported as not run.
      if (!await report.step('exploration-scope-hidden', async () => {
        await clickHost(app, 'exploration');
        await until(() => app.explorationCovered(), 'the exploration scope');
        return { exposures: exposures(app).map(record => [record.scope, record.displayStatus]) };
      })) return report.write('failed');
      report.data.skippedWhileHidden = ['exploration-commit', 'navigate-index-3'];
    } else {
      if (!await report.step('exploration-commit', async () => {
        await clickHost(app, 'exploration');
        await until(() => app.explorationCovered(), 'the exploration scope');
        const learner = binding(app);
        const guards = () => projection(app).guards;
        const begun = learner.beginPreview({ operationId: 'runner-preview-begin', ...guards(), gesture: 'pointer', parameter: 'eta' });
        if (!begun.ok) throw new Error(`beginPreview refused: ${begun.diagnostics.map(item => item.code).join(',')}`);
        const previewId = projection(app).preview!.previewId;
        const updated = learner.updatePreview({ operationId: 'runner-preview-update', previewId, displayValues: { eta: 0.75 } });
        if (!updated.ok) throw new Error('updatePreview refused');
        await until(() => projection(app).frame?.kind === 'tentative', 'a tentative frame');
        await until(() => exposures(app).some(record => record.scope === 'exploration' && record.displayStatus === 'displayed'), 'the exploration display acknowledgement');
        const committed = await learner.commitPreview({ operationId: 'runner-preview-commit', ...guards(), previewId });
        if (!committed.ok) throw new Error(`commitPreview refused: ${committed.diagnostics.map(item => item.code).join(',')}`);
        await until(() => projection(app).frame?.kind === 'committed' && !projection(app).preview, 'the committed run');
        return { gesture: 'pointer-preview', params: app.hostState()?.scientific?.params ?? null, exposures: exposures(app).map(record => [record.scope, record.displayStatus]) };
      })) return report.write('failed');
      if (!await report.step('navigate-index-3', async () => {
        const outcome = await binding(app).navigate({ operationId: 'runner-navigate', ...projection(app).guards, position: { kind: 'index', index: 3 } });
        if (!outcome.ok) throw new Error(`navigate refused: ${outcome.diagnostics.map(item => item.code).join(',')}`);
        await until(() => projection(app).navigation?.value === 3, 'index 3');
        return { position: projection(app).frame?.position ?? null };
      })) return report.write('failed');
    }
    // Camera (presentation state): attempted in both cases; while hidden a refusal is recorded instead of failing the run.
    const camera = await report.step('camera-zoom-in', async () => {
      const figure = cardRoot(app).querySelector('[data-ema-figure="landscape"]');
      const zoom = figure && [...figure.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === 'Zoom in');
      if (!zoom) throw new Error('no Zoom in control on the landscape figure');
      zoom.click();
      await until(() => !!projection(app).presentation.views.landscape?.camera, 'the camera change', windowVisible() ? 20_000 : 4000);
      return { camera: projection(app).presentation.views.landscape?.camera ?? null, presentationRevision: projection(app).presentation.revision };
    });
    if (!camera && windowVisible()) return report.write('failed');
    if (!camera) report.data.cameraWhileHidden = report.steps.pop()?.error ?? null;
    if (!await report.step('save', async () => { await clickHost(app, 'save'); await app.idle(); return null; })) return report.write('failed');
    report.data.before = captureState(app);
    report.data.cursorBefore = toJson(await app.port.getJournalCursor({ activityId: app.getSnapshot().current!.activityId }));
    if (windowVisible()) report.probes.push(...await captureProbes(app.surface!, 'restart-before', renderTimeout()));
    await report.write('awaiting-termination');
    return;
  }
  if (phase === '2') {
    if (!await report.step('relaunch-restored', async () => {
      await waitReady(app);
      if (!app.getSnapshot().current) throw new Error('no activity was reopened');
      await until(() => !!projection(app).frame, 'the restored frame');
      return null;
    })) return report.write('failed');
    report.data.after = captureState(app);
    report.data.afterUi = toJson({ ui: projection(app).status.ui, banner: cardRoot(app).querySelector('.ema-banner[data-ui-state]')?.getAttribute('data-ui-state') ?? null });
    if (windowVisible()) report.probes.push(...await captureProbes(app.surface!, 'restart-after', renderTimeout()));
    if (!await report.step('independent-task', async () => {
      await clickHost(app, 'independent-task');
      await until(() => app.getSnapshot().current?.kind === 'independent-task' && projection(app).context === 'independent', 'the independent task');
      await app.surface!.ready;
      const root = cardRoot(app);
      return {
        views: projection(app).views.map(view => view.viewId), visibleGroups: visible(app), controls: projection(app).controls.map(control => control.parameter),
        traceFigureInDom: !!root.querySelector('[data-ema-figure="trace-plot"]'), landscapeInDom: !!root.querySelector('[data-ema-figure="landscape"]'),
        cardText: (root.textContent ?? '').slice(0, 600),
      };
    })) return report.write('failed');
    if (!await report.step('task-answer', async () => { await respond(app, 'x₃ = -0.5 · 0.5 · 4 … worked from the stated rule.'); return { responses: app.hostState()?.instance.responses.map(item => item.kind) ?? [] }; })) return report.write('failed');
    if (!await report.step('task-answer-frozen-snapshot', async () => { report.data.answerSnapshot = await answerSnapshot(app); return null; })) return report.write('failed');
    if (!await report.step('save-task', async () => { await clickHost(app, 'save'); await app.idle(); return null; })) return report.write('failed');
    report.data.task = captureState(app);
    await report.write('awaiting-termination');
    return;
  }
  if (phase === '3') {
    if (!await report.step('task-relaunch', async () => {
      await waitReady(app);
      await until(() => !!app.binding && !!projection(app).frame, 'the restored task');
      return { kind: app.getSnapshot().current?.kind ?? null, context: projection(app).context, views: projection(app).views.map(view => view.viewId), visibleGroups: visible(app) };
    })) return report.write('failed');
    report.data.taskRestored = captureState(app);
    if (!await report.step('reopen-teaching-visual-assistance', async () => {
      await clickHost(app, 'reopen-assistance');
      return { context: projection(app).context, views: projection(app).views.map(view => view.viewId), visibleGroups: visible(app) };
    })) return report.write('failed');
    // The assistance recorded after the answer must not change the snapshot frozen with it.
    if (!await report.step('answer-snapshot-after-assistance', async () => {
      await until(() => projection(app).status.persistence === 'saved', 'the assistance events to be acknowledged by the host');
      report.data.answerSnapshotAfterAssistance = await answerSnapshot(app);
      return null;
    })) return report.write('failed');
    // Saving the reopened task (an artifact whose `assistance` list now holds the reopening) is part of the sequence: a
    // failed save fails the phase like every other step (G60).
    if (!await report.step('save-reopened', async () => { await clickHost(app, 'save'); await app.idle(); return null; })) return report.write('failed');
    if (!await report.step('export-portable-backup', async () => {
      await clickHost(app, 'export');
      return toJson(app.getSnapshot().lastExport);
    })) return report.write('failed');
    report.data.reopened = captureState(app);
    report.data.activities = toJson((await hostCommands.list()).activities);
    await report.write('complete');
    await call('conformance_exit', { code: 0 });
  }
}

/** Termination at a named crash point during the trace reveal, then relaunch and resume. */
async function crashScenario(app: ReferenceHostApp, report: Report): Promise<void> {
  if (report.scenario.crashAt === 'save-before-commit') return saveCrashScenario(app, report);
  if (report.scenario.phase === '1') {
    if (!await report.step('fresh-store', async () => { await waitReady(app); if (app.getSnapshot().activities.length) throw new Error('store not empty'); return null; })) return report.write('failed');
    if (!await report.step('open-quadratic', () => openQuadratic(app))) return report.write('failed');
    if (!await toRevealed(app, report)) return report.write('failed');
    await app.idle();
    report.data.preReveal = captureState(app);
    await report.write('crash-armed');
    const control = await hostButton('reveal');
    control.click();
    // The host aborts the process at the armed point; reaching the timeout means it did not.
    await delay(15_000);
    report.check('crash-fired', false, { note: 'the process survived the armed crash point' });
    await report.write('crash-not-fired');
    await call('conformance_exit', { code: 3 });
    return;
  }
  if (!await report.step('relaunch-restored', async () => {
    await waitReady(app);
    if (!app.getSnapshot().current) throw new Error('no activity was reopened');
    await until(() => !!projection(app).frame, 'the restored frame');
    await delay(400);
    return null;
  })) return report.write('failed');
  report.data.restored = captureState(app);
  report.data.restoredTraceVisible = visible(app).includes('trace');
  report.data.hostSummary = toJson((await hostCommands.list()).activities);
  if (!await report.step('resume-reveal', async () => {
    if (app.heldBackGroups().length) await revealTrace(app);
    // Displayed before the crash: the restored record stays displayed and the adapter resends the acknowledgement the
    // host never committed; wait until the host confirmed it (no ACK_NOT_PERSISTED left), not just the local status.
    else if (windowVisible()) await until(() => exposures(app).some(record => record.scope === 'reveal' && record.displayStatus === 'displayed' && record.uncertainty?.code !== 'ACK_NOT_PERSISTED'), 'the host-confirmed display acknowledgement');
    return { visibleGroups: visible(app), exposures: exposures(app).map(record => [record.exposureId, record.scope, record.displayStatus, record.uncertainty?.code ?? null]) };
  })) return report.write('failed');
  if (!await report.step('save', async () => { await clickHost(app, 'save'); await app.idle(); return null; })) return report.write('failed');
  report.data.final = captureState(app);
  report.data.hostSummaryFinal = toJson((await hostCommands.list()).activities);
  await report.write('complete');
  await call('conformance_exit', { code: 0 });
}

/**
 * Interrupted save (report §14, G77): the process is terminated inside `save_artifact` after its writes and before its
 * commit (armed only for the explicit Save, not the earlier checkpoints). The relaunched host must hold the previous
 * checkpoint and every earlier record, restore from it, and accept the repeated save.
 */
async function saveCrashScenario(app: ReferenceHostApp, report: Report): Promise<void> {
  if (report.scenario.phase === '1') {
    if (!await report.step('fresh-store', async () => { await waitReady(app); if (app.getSnapshot().activities.length) throw new Error('store not empty'); return null; })) return report.write('failed');
    if (!await report.step('open-quadratic', () => openQuadratic(app))) return report.write('failed');
    if (!await toRevealed(app, report)) return report.write('failed');
    if (!await report.step('authorize-and-reveal-trace', () => revealTrace(app))) return report.write('failed');
    if (!await report.step('save', async () => { await clickHost(app, 'save'); await app.idle(); return null; })) return report.write('failed');
    await app.idle();
    report.data.preCrash = captureState(app);
    report.data.cursorBeforeCrash = toJson(await app.port.getJournalCursor({ activityId: app.getSnapshot().current!.activityId }));
    const armed = await call<{ armed: boolean; point: string | null }>('conformance_arm', {});
    report.data.armed = toJson(armed);
    if (!armed.armed) { report.check('save-crash-armed', false, armed); return report.write('failed'); }
    await report.write('crash-armed');
    const control = await hostButton('save');
    control.click();
    await delay(15_000);
    report.check('crash-fired', false, { note: 'the process survived the armed save crash point' });
    await report.write('crash-not-fired');
    await call('conformance_exit', { code: 3 });
    return;
  }
  if (!await report.step('relaunch-restored', async () => {
    await waitReady(app);
    if (!app.getSnapshot().current) throw new Error('no activity was reopened');
    await until(() => !!projection(app).frame, 'the restored frame');
    await app.idle();
    return null;
  })) return report.write('failed');
  report.data.restored = captureState(app);
  report.data.cursorAfterRestart = toJson(await app.port.getJournalCursor({ activityId: app.getSnapshot().current!.activityId }));
  if (!await report.step('save-after-restart', async () => { await clickHost(app, 'save'); await app.idle(); return null; })) return report.write('failed');
  report.data.final = captureState(app);
  report.data.cursorFinal = toJson(await app.port.getJournalCursor({ activityId: app.getSnapshot().current!.activityId }));
  await report.write('complete');
  await call('conformance_exit', { code: 0 });
}

/**
 * The host-agnostic HostPort conformance kit (`@explorable-models/activity/conformance`, external gate G2) run inside the
 * packaged app against the Rust reference host through `NativeHostPort`, labelled `reference-fixture-host`. Its restart
 * hook drops the host and opens the same SQLite store again (`conformance_reopen_store`: the restart rule runs, as on a
 * relaunch); its interruption hook arms an in-process simulated fault at the named crash point (`conformance_fault`:
 * nothing after the point commits, no reply, the host answers nothing until the store is reopened). Full process
 * terminations stay covered by the `restart` and `crash:*` scenarios.
 */
async function hostPortKitScenario(app: ReferenceHostApp, report: Report): Promise<void> {
  if (!await report.step('fresh-store', async () => { await waitReady(app); if (app.getSnapshot().activities.length) throw new Error('store not empty'); return null; })) return report.write('failed');
  const identity = report.scenario.identity;
  const hooks: HostConformanceHooks = {
    async openActivity({ templateId, version }) {
      const opened = await hostCommands.open(templateId, version);
      return { activityId: opened.activityId, objectiveIds: opened.objectiveIds, hostSessionId: opened.hostSessionId, hostSessionRevision: opened.hostSessionRevision, template: opened.template, mode: 'approved' };
    },
    async restart() {
      await call('conformance_reopen_store', {});
      return new NativeHostPort();
    },
    async respond({ activityId, kind, stageId, taskId }) {
      const recorded = await hostCommands.recordResponse({ activityId, kind, stageId, taskId, text: 'Conformance kit response (fixture text).' });
      const confirmed = await hostCommands.confirmResponse(activityId, recorded.ref.responseId);
      return { response: recorded.ref, expectedHostSessionRevision: recorded.expectedHostSessionRevision, hostSessionRevision: confirmed.hostSessionRevision };
    },
    async hostSessionRevision({ activityId }) {
      const activity = (await hostCommands.list()).activities.find(item => item.activityId === activityId);
      if (!activity) throw new Error('the host lists no such activity');
      return activity.hostSessionRevision;
    },
    authorizeReveal: ({ activityId, groups }) => hostCommands.authorizeReveal(activityId, groups),
    async startIndependentTask({ activityId }) {
      const task = await hostCommands.startIndependentTask(activityId);
      return {
        request: { activityId: task.activityId, objectiveIds: task.objectiveIds, hostSessionId: task.hostSessionId, hostSessionRevision: task.hostSessionRevision, template: task.template, mode: 'approved' },
        taskRef: task.taskRef, policy: task.policy,
      };
    },
    async armCrash(point) { await call('conformance_fault', { point }); },
  };
  let run: HostConformanceRun | null = null;
  if (!await report.step('hostport-kit', async () => {
    const evidence = 'docs/study-harness/evidence/native-conformance.json (scenarios.hostport-kit)';
    run = await runHostPortConformance(new NativeHostPort(), {
      subject: 'reference-fixture-host', catalog: app.catalog, hooks,
      host: {
        name: 'study-harness-reference', commit: identity.sourceCommit ?? 'unknown', dirty: identity.sourceDirty ?? true, binarySha256: identity.executableSha256 ?? 'unknown', signed: false,
        platform: { os: 'macOS', osVersion: identity.osVersion ?? 'unknown', arch: identity.arch === 'aarch64' ? 'arm64' : 'x64', webview: `WKWebView ${report.scenario.webviewVersion ?? ''}`.trim() },
      },
      packages: packed.packages.map(entry => ({ name: entry.name, version: entry.version, sha256: entry.sha256 })),
      limitations: [
        'Packaged reference host (conformance fixture) on one macOS machine; not the Study Harness application (A54) and not other platforms (A53). Unsigned build.',
        'Restarts reopened the same SQLite store inside the running app (conformance_reopen_store); interruptions were in-process simulated faults at the named crash points (conformance_fault). Process terminations are covered by the restart and crash:* scenarios of the same run.',
      ],
      evidence: Object.fromEntries(HOST_CONFORMANCE_STEPS.map(step => [step, evidence])),
      adapter: { maxWorkers: 2 },
      timeoutMs: 30_000,
    });
    const finished = run as HostConformanceRun;
    return { result: finished.result.result, problems: finished.problems, failed: finished.checks.filter(check => check.outcome === 'fail').map(check => `${check.step}/${check.id}`) };
  })) return report.write('failed');
  report.data.kit = toJson(run);
  await report.write('complete');
  await call('conformance_exit', { code: 0 });
}

const TEMPLATES = [
  { templateId: 'quadratic-gradient-descent', version: '1.0.0', dimension: '2d' },
  { templateId: 'function-derivative', version: '1.0.0', dimension: '2d' },
  { templateId: 'linear-transformation', version: '1.0.0', dimension: '2d' },
  { templateId: 'vector-orientation-3d', version: '1.0.0', dimension: '3d' },
  { templateId: 'quadratic-surface-gradient', version: '1.0.0', dimension: '3d' },
] as const;
async function openTemplate(app: ReferenceHostApp, templateId: string, version: string): Promise<void> {
  const select = document.querySelector<HTMLSelectElement>('#host-template');
  if (!select) throw new Error('no template selector');
  select.value = `${templateId}@${version}`;
  select.dispatchEvent(new Event('change'));
  await clickHost(app, 'open');
  await until(() => !!app.surface && app.getSnapshot().current?.template.templateId === templateId, `the ${templateId} card`);
  await app.surface!.ready;
  await until(() => !!projection(app).frame && projection(app).status.ui !== 'preparing', `the first committed frame of ${templateId}`);
}
/** Renderer counters of a spatial record (a JSON-safe copy). */
const statsOf = (record: ReturnType<typeof spatialRecords>[number] | undefined) => (record ? toJson(record.stats()) : null) as Record<string, Json> | null;
const released = (stats: Record<string, Json> | null): boolean => !!stats && stats.status === 'disposed'
  && ['geometries', 'materials', 'textures', 'listeners', 'observers', 'pending'].every(key => stats[key] === 0);

/**
 * Every installed template opened through the host: each prepares by evaluating its kernel in the catalogue worker,
 * which loads that kernel's own module on first use (a same-origin dynamic `import()` from the module worker under the
 * production and worker CSPs). The two spatial templates then render through the packed `@explorable-models/player-3d`
 * chunk in WKWebView: frames counted, then renderer resources released when the card goes away. Rendering needs a
 * visible window; while WebKit reports it hidden the spatial probes are recorded as not run.
 */
async function templatesScenario(app: ReferenceHostApp, report: Report): Promise<void> {
  if (!await report.step('fresh-store', async () => { await waitReady(app); if (app.getSnapshot().activities.length) throw new Error('store not empty'); return null; })) return report.write('failed');
  const violationsBefore = audit().violations.length;
  const kernels: Json[] = [];
  let previous: { templateId: string; viewId: string } | null = null;
  const disposal = async (label: string) => {
    if (!previous) return;
    const viewId = previous.viewId;
    await until(() => spatialRecords().some(item => item.viewId === viewId && item.disposedAtMs !== null), `the ${previous.templateId} renderer to be disposed`, 5000).catch(() => undefined);
    const record = spatialRecords().filter(item => item.viewId === viewId).at(-1);
    const stats = statsOf(record);
    const ok = !!record?.disposedAtMs && released(stats);
    report.probes.push({ id: `spatial-dispose:${previous.templateId}`, ms: 0, status: ok ? 'pass' : 'fail', summary: ok ? `renderer released when ${label}` : `renderer not released when ${label}`, details: { stats, disposed: !!record?.disposedAtMs } });
    previous = null;
  };
  for (const template of TEMPLATES) {
    if (!await report.step(`open-${template.templateId}`, async () => {
      await openTemplate(app, template.templateId, template.version);
      const shown = projection(app);
      const values = shown.views.flatMap(view => view.values).filter(value => value.status === 'valid').length;
      kernels.push({ templateId: template.templateId, frameId: shown.frame?.frameId ?? null, validValues: values, views: shown.views.map(view => view.kind) });
      return { frameId: shown.frame?.frameId ?? null, validValues: values };
    })) return report.write('failed');
    await disposal(`${template.templateId} replaced the card`);
    if (template.dimension !== '3d') continue;
    report.probes.push(await probe(`spatial-render:${template.templateId}`, async () => {
      const root = cardRoot(app);
      const host = root.querySelector<HTMLElement>('[data-ema-spatial]');
      if (!host) return { status: 'fail', summary: 'the card shows no spatial view', details: {} };
      const viewId = host.dataset.emaSpatial!;
      if (!windowVisible()) return { status: 'info', summary: 'not run: the window was not visible to WebKit (console session locked or display asleep)', details: { visibilityState: document.visibilityState } };
      host.scrollIntoView({ block: 'center' });
      const record = () => spatialRecords().find(item => item.viewId === viewId && item.disposedAtMs === null);
      try {
        await until(() => host.dataset.emaSpatialState === 'ready' && (record()?.stats()?.frames ?? 0) > 0, 'rendered spatial frames', 20_000);
      } catch {
        return { status: 'fail', summary: `no rendered frame (state ${host.dataset.emaSpatialState ?? 'none'})`, details: { state: host.dataset.emaSpatialState ?? null, stats: statsOf(record()) } };
      }
      const first = statsOf(record());
      await delay(800);
      const later = statsOf(record());
      previous = { templateId: template.templateId, viewId };
      const canvas = host.querySelector('canvas') ?? host.shadowRoot?.querySelector('canvas') ?? null;
      return {
        status: 'pass',
        summary: `${first?.frames} frames rendered (then ${later?.frames} after 0.8 s idle, on-demand rendering), ${first?.drawCalls} draw calls, ${first?.geometries} geometries, ${first?.vertices} vertices`,
        details: { viewId, state: host.dataset.emaSpatialState ?? null, first, later, canvas: canvas ? { width: (canvas as HTMLCanvasElement).width, height: (canvas as HTMLCanvasElement).height } : null },
      };
    }, 30_000));
  }
  if (!await report.step('close-last', async () => { await clickHost(app, 'close'); return null; })) return report.write('failed');
  await disposal('the activity was closed');
  report.data.kernels = kernels;
  report.data.spatialRecords = toJson(spatialRecords().map(item => ({ viewId: item.viewId, disposed: item.disposedAtMs !== null, stats: item.stats() })));
  report.data.cspViolationsDuringScenario = toJson(audit().violations.slice(violationsBefore));
  await report.write('complete');
  await call('conformance_exit', { code: 0 });
}

/**
 * Report §18 measured in this packaged app (R22): lifecycle stress, the quadratic activity's commits, drags and
 * suspension, and each spatial activity's orbit input, against the Rust host on a fresh store (performance.ts). A window
 * WebKit reports hidden measures nothing; the driver records the targets as not run (environment).
 */
async function performanceRun(app: ReferenceHostApp, report: Report): Promise<void> {
  if (!await report.step('fresh-store', async () => { await waitReady(app); if (app.getSnapshot().activities.length) throw new Error('store not empty'); return null; })) return report.write('failed');
  const measured = await performanceScenario(app, report, windowVisible);
  await report.write(measured ? 'complete' : 'failed');
  if (measured) await call('conformance_exit', { code: 0 });
}

/** Hide/show: the card suspends (no background work) and resumes paused at the same position, without catch-up. */
async function lifecycle(app: ReferenceHostApp): Promise<ProbeResult> {
  return probe('window-hide-show-suspends', async () => {
    if (!windowVisible()) return { status: 'info', summary: 'not run: the window was not visible to WebKit (console session locked or display asleep)', details: { visibilityState: document.visibilityState } };
    const learner = binding(app);
    const played = learner.play({ operationId: 'runner-play', ...projection(app).guards });
    if (!played.ok) return { status: 'fail', summary: `play refused: ${played.diagnostics.map(item => item.code).join(',')}`, details: {} };
    await delay(700);
    const playingBefore = projection(app).navigation?.playing ?? false;
    await call('conformance_window', { action: 'hide' });
    await until(() => document.visibilityState === 'hidden', 'document.visibilityState hidden', 5000);
    await delay(300);
    const hidden = { ui: projection(app).status.ui, playing: projection(app).navigation?.playing ?? null, index: projection(app).navigation?.value ?? null };
    await delay(1500);
    const later = projection(app).navigation?.value ?? null;
    await call('conformance_window', { action: 'show' });
    await until(() => document.visibilityState === 'visible', 'document.visibilityState visible', 5000);
    await delay(600);
    const shown = { ui: projection(app).status.ui, playing: projection(app).navigation?.playing ?? null, index: projection(app).navigation?.value ?? null };
    const ok = playingBefore && hidden.ui === 'suspended' && hidden.playing === false && later === hidden.index && shown.ui !== 'suspended' && shown.playing === false && shown.index === hidden.index;
    return { status: ok ? 'pass' : 'fail', summary: `before hide playing=${playingBefore}; hidden ${hidden.ui} playing=${hidden.playing} n=${hidden.index}; after 1.5 s n=${later}; shown ${shown.ui} playing=${shown.playing} n=${shown.index}`, details: { playingBefore, hidden, laterIndex: later, shown } };
  }, 20_000);
}

/** Offline, CSP, workers, crypto, math, capture, WebGL, IPC boundary and window lifecycle in the packaged binary. */
async function offlineScenario(app: ReferenceHostApp, report: Report): Promise<void> {
  if (report.scenario.generation > 1) {
    if (!await report.step('window-reopened', async () => {
      await waitReady(app);
      await until(() => !!app.binding && !!projection(app).frame, 'the reopened card');
      return { activityId: app.getSnapshot().current?.activityId ?? null, ui: projection(app).status.ui, stage: projection(app).stage.id, visibleGroups: visible(app) };
    })) return report.write('failed');
    report.probes.push(originsProbe());
    report.probes.push(windowVisible() ? await mathProbe(app.surface!, renderTimeout())
      : { id: 'katex-in-card', status: 'info', summary: 'not run: the window was not visible to WebKit', ms: 0, details: { visibilityState: document.visibilityState } });
    await report.write('complete');
    await call('conformance_exit', { code: 0 });
    return;
  }
  await waitReady(app);
  const environment = await environmentProbes();
  report.probes.push(...environment);
  await report.write('running');
  const workerEval = (environment.find(item => item.id === 'module-worker')?.details.workerEval as { blocked?: boolean } | undefined)?.blocked === true;
  const negative = await negativeProbes(workerEval);
  report.probes.push(...negative.results);
  report.data.negativeProbeViolations = toJson(negative.violations);
  report.probes.push(...await ipcProbes());
  await report.write('running');
  if (!await report.step('open-quadratic', () => openQuadratic(app))) return report.write('failed');
  report.data.catalogKernelWorker = toJson({ frameId: projection(app).frame?.frameId ?? null, values: projection(app).views.flatMap(view => view.values.map(value => [value.quantityId, value.text])).slice(0, 12) });
  if (!await toRevealed(app, report)) return report.write('failed');
  if (!await report.step('authorize-and-reveal-trace', () => revealTrace(app))) return report.write('failed');
  await report.step('save', async () => { await clickHost(app, 'save'); await app.idle(); return null; });
  report.probes.push(originsProbe());
  report.probes.push(await webglProbe());
  await report.write('running');
  // Rendering-dependent probes last; skipped while WebKit reports the window hidden (no layout-driven font loads,
  // lazy math or animation frames, and WebKit throttles hidden pages), and reported as not run.
  if (windowVisible()) {
    report.probes.push(await mathProbe(app.surface!, renderTimeout()));
    report.probes.push(...await captureProbes(app.surface!, 'explore', renderTimeout()));
  } else {
    for (const id of ['katex-in-card', 'explore-capture-svg', 'explore-capture-png']) report.probes.push({ id, status: 'info', summary: 'not run: the window was not visible to WebKit', ms: 0, details: { visibilityState: document.visibilityState } });
  }
  await report.write('running');
  report.probes.push(await lifecycle(app));
  report.data.ungrantedExecuted = (await call<Scenario>('conformance_scenario', {})).ungrantedExecuted;
  report.data.activityId = app.getSnapshot().current?.activityId ?? null;
  await report.write('reopening');
  await call('conformance_window', { action: 'reopen' });
}

/** Portable backup restored into an EMPTY store (original files removed by the driver), then reopened. */
async function restoreScenario(app: ReferenceHostApp, report: Report): Promise<void> {
  if (!await report.step('empty-store-with-import', async () => {
    await waitReady(app);
    if (app.getSnapshot().activities.length) throw new Error('the store is not empty');
    const backups = app.getSnapshot().backups;
    if (backups.length !== 1 || !backups[0]!.valid) throw new Error(`expected one valid importable backup, found ${JSON.stringify(backups)}`);
    return toJson(backups[0]);
  })) return report.write('failed');
  const sha = app.getSnapshot().backups[0]!.backupSha256;
  if (!await report.step('import', async () => { await clickHost(app, 'import', sha); return toJson(app.getSnapshot().lastImport); })) return report.write('failed');
  const activities = (await hostCommands.list()).activities;
  report.data.activities = toJson(activities);
  const instructional = activities.find(item => item.kind === 'instructional');
  const task = activities.find(item => item.kind === 'independent-task');
  if (!instructional || !task) { report.check('imported-activities', false, activities); return report.write('failed'); }
  if (!await report.step('reopen-instructional-activity', async () => {
    await clickHost(app, 'reopen', instructional.activityId);
    await until(() => !!app.binding && !!projection(app).frame, 'the restored instructional activity');
    await app.surface!.ready;
    return null;
  })) return report.write('failed');
  report.data.instructional = captureState(app);
  // The restored presentation snapshot (camera included), read back from a backup saved now: a closed activity's stage
  // shows no view, and the learner projection carries presentation for visible views only.
  const readback = await app.prepared!.host.save({ operationId: 'runner-presentation-readback', kind: 'backup' });
  report.data.instructionalPresentation = readback.ok ? toJson(readback.artifact.presentation) : toJson({ failed: readback.diagnostics.map(item => item.code) });
  await app.idle();
  if (windowVisible()) report.probes.push(...await captureProbes(app.surface!, 'restored-backup', renderTimeout()));
  if (!await report.step('reopen-task-activity', async () => {
    await clickHost(app, 'reopen', task.activityId);
    await until(() => !!app.binding && app.getSnapshot().current?.activityId === task.activityId && !!projection(app).frame, 'the restored task activity');
    return null;
  })) return report.write('failed');
  report.data.task = captureState(app);
  await report.step('reimport-adds-nothing', async () => {
    const again = await hostCommands.importBackup(sha);
    if (!again.alreadyImported) throw new Error('a second import was not recognized');
    return toJson(again);
  });
  report.data.activitiesAfter = toJson((await hostCommands.list()).activities);
  // A host build that no longer approves the template: reopening its activity is refused as CONTENT_REVOKED and the
  // card area shows the artifact's archival read-only record (nothing evaluated, no controls); the records stay.
  await report.step('archival-record-on-withdrawn-approval', async () => {
    await call('conformance_withdraw_approval', { templateId: 'quadratic-gradient-descent' });
    await clickHost(app, 'reopen', instructional.activityId);
    await until(() => app.getSnapshot().archival !== null, 'the archival record');
    const element = document.querySelector<HTMLElement>('#card [data-explorable-models-archival]');
    const shadow = element?.shadowRoot ?? null;
    return {
      archival: toJson(app.getSnapshot().archival), cardState: document.getElementById('card')?.dataset.hostCard ?? null, surfaceMounted: !!app.surface,
      archivalElement: !!element, controls: shadow ? shadow.querySelectorAll('button, input, select, textarea, [role="slider"]').length : null,
      // Which controls (the record's only permitted control is the host's return action).
      controlLabels: shadow ? [...shadow.querySelectorAll<HTMLElement>('button, input, select, textarea, [role="slider"]')].map(item => `${item.tagName.toLowerCase()}:${(item.textContent ?? '').trim() || item.getAttribute('aria-label') || ''}`) : null,
      text: (shadow?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 400),
      recordsKept: (await hostCommands.list()).activities.some(item => item.activityId === instructional.activityId),
    };
  });
  await report.write('complete');
  await call('conformance_exit', { code: 0 });
}

export async function runConformance(app: ReferenceHostApp): Promise<void> {
  const scenario = await call<Scenario>('conformance_scenario', {});
  if (scenario.scenario === 'manual' || !scenario.reportConfigured) return;
  const report = new Report(scenario);
  report.data.visibilityAtStart = document.visibilityState;
  // Every refused or failed native call (fixed codes and the host's reason), so a failed step can be traced to the host's decision.
  report.data.bridgeFailures = report.callFailures;
  onCall(record => report.noteCall(record));
  // What the card area showed since the app was created (placeholder `empty`/`preparing`, `surface`, `archival`): the
  // host's own record, which starts before the startup restore (the runner itself starts after it).
  report.data.cardStates = app.cardStates as unknown as Json;
  document.addEventListener('visibilitychange', () => {
    const changes = (report.data.visibilityChanges as Json[] | undefined) ?? [];
    changes.push({ state: document.visibilityState, atMs: Math.round(performance.now()) });
    report.data.visibilityChanges = changes;
  });
  await report.write('started');
  try {
    switch (scenario.scenario) {
      case 'restart': await restartScenario(app, report); break;
      case 'crash': await crashScenario(app, report); break;
      case 'offline': await offlineScenario(app, report); break;
      case 'restore': await restoreScenario(app, report); break;
      case 'hostport-kit': await hostPortKitScenario(app, report); break;
      case 'templates': await templatesScenario(app, report); break;
      case 'performance': await performanceRun(app, report); break;
      default: report.check('scenario', false, { unknown: scenario.scenario }); await report.write('failed');
    }
  } catch (error) {
    report.check('runner', false, { error: errorText(error) });
    await report.write('failed');
  }
  report.data.diagnostics = toJson(app.diagnostics.slice(-40));
  if (report.status === 'failed') {
    await report.write('failed');
    await call('conformance_exit', { code: 2 });
  }
}
