/**
 * PROJECTION LAB — a development-only FIXTURE page. It mounts the learner surface with a static fake
 * `ActivityBinding` that serves hand-written `LearnerProjection` fixtures, so every UI state can be inspected in
 * light/dark at container widths 320/390/640/960. It evaluates no model, records nothing, and is not an activity, a
 * tutor or a host. Commands only echo presentation changes (camera, selection, unit, layout) and the preview value
 * so the controls can be exercised; scientific commands leave the fixture unchanged.
 *
 * Query string: ?fixture=quadratic|geometry|spatial|long|extreme|comparison&state=<UiState>&width=320|390|640|960
 *               &theme=light|dark|system&fonts=system|bundled&layout=auto|card|side|expanded&mode=shadow|react
 */
import { createRoot } from 'react-dom/client';
import { StrictMode } from 'react';
import type { ActivityBinding, CommandOutcome, LearnerProjection, UiState } from '@experiment-kit/activity';
import { adoptActivityStyles, mountStudyActivity, StudyActivitySurface, type StudyActivitySurfaceProps, type SurfaceDiagnostic } from '@experiment-kit/player/activity';
import { FIXTURES, fixtureProjection, UI_STATES, type FixtureName } from './projection-lab.fixtures';

const params = new URLSearchParams(location.search);
const fixture = (FIXTURES as readonly string[]).includes(params.get('fixture') ?? '') ? params.get('fixture') as FixtureName : 'quadratic';
const state = (UI_STATES as readonly string[]).includes(params.get('state') ?? '') ? params.get('state') as UiState : 'ready';
const width = [320, 390, 640, 960].includes(Number(params.get('width'))) ? Number(params.get('width')) : 640;
const theme = (['light', 'dark', 'system'] as const).find(value => value === params.get('theme')) ?? 'light';
const fonts = params.get('fonts') === 'bundled' ? 'bundled' : 'system';
const layout = (['auto', 'card', 'side', 'expanded'] as const).find(value => value === params.get('layout')) ?? 'auto';
const mode = params.get('mode') === 'react' ? 'react' : 'shadow';

const log: string[] = [];
const logElement = document.querySelector<HTMLElement>('#lab-log')!;
const record = (line: string) => { log.unshift(line); log.length = Math.min(log.length, 12); logElement.textContent = log.join('\n'); };

/** Fixture binding: serves one projection and echoes presentation-only commands. Not an adapter. */
class FixtureBinding implements ActivityBinding {
  readonly activityId = 'fixture-activity';
  readonly actor = 'learner' as const;
  private projection: LearnerProjection;
  private listeners = new Set<(projection: LearnerProjection) => void>();
  private counter = 1;
  constructor(initial: LearnerProjection) { this.projection = initial; }
  private publish(change: (projection: LearnerProjection) => LearnerProjection): CommandOutcome {
    this.projection = { ...change(this.projection), projectionId: `fixture-projection-${++this.counter}` };
    for (const listener of this.listeners) listener(this.projection);
    return { ok: true, projection: this.projection };
  }
  private presentation(change: (p: LearnerProjection['presentation']) => LearnerProjection['presentation']): CommandOutcome {
    return this.publish(p => { const presentation = { ...change(p.presentation), revision: p.presentation.revision + 1 }; return { ...p, presentation, presentationRevision: presentation.revision }; });
  }
  private unchanged(name: string): CommandOutcome { record(`${name}: fixture (no model is evaluated)`); return { ok: true, projection: this.projection }; }
  getProjection() { return this.projection; }
  subscribe(listener: (projection: LearnerProjection) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  beginPreview(input: Parameters<ActivityBinding['beginPreview']>[0]) { record(`beginPreview ${input.parameter} (${input.gesture})`); return this.publish(p => ({ ...p, preview: { previewId: `fixture-preview-${this.counter}`, parameter: input.parameter }, status: { ...p.status, ui: 'tentative-preview' } })); }
  updatePreview(input: Parameters<ActivityBinding['updatePreview']>[0]) {
    return this.publish(p => ({ ...p, frame: p.frame && { ...p.frame, kind: 'tentative' }, controls: p.controls.map(c => c.parameter in input.displayValues ? { ...c, previewValue: input.displayValues[c.parameter] } : c) }));
  }
  async commitPreview() { record('commitPreview'); return this.publish(p => ({ ...p, preview: null, frame: p.frame && { ...p.frame, kind: 'committed' }, status: { ...p.status, ui: 'ready' }, controls: p.controls.map(c => c.previewValue === undefined ? c : { ...c, value: c.previewValue, previewValue: undefined }) })); }
  cancelPreview(input: Parameters<ActivityBinding['cancelPreview']>[0]) { record(`cancelPreview (${input.reason})`); return this.publish(p => ({ ...p, preview: null, frame: p.frame && { ...p.frame, kind: 'committed' }, status: { ...p.status, ui: 'ready' }, controls: p.controls.map(c => ({ ...c, previewValue: undefined })) })); }
  async commitParameters(input: Parameters<ActivityBinding['commitParameters']>[0]) { record(`commitParameters ${JSON.stringify(input.displayValues)}`); return this.publish(p => ({ ...p, controls: p.controls.map(c => c.parameter in input.displayValues ? { ...c, value: input.displayValues[c.parameter] } : c) })); }
  async applyScenario(input: Parameters<ActivityBinding['applyScenario']>[0]) { record(`applyScenario ${input.scenarioId}`); return this.publish(p => ({ ...p, scenarios: p.scenarios.map(s => ({ ...s, active: s.scenarioId === input.scenarioId })) })); }
  async resetExperiment() { return this.unchanged('resetExperiment'); }
  async navigate(input: Parameters<ActivityBinding['navigate']>[0]) { record(`navigate ${JSON.stringify(input.position)}`); return this.publish(p => ({ ...p, navigation: p.navigation && input.position.kind === 'index' ? { ...p.navigation, value: input.position.index } : p.navigation })); }
  async step(input: Parameters<ActivityBinding['step']>[0]) { record(`step ${input.delta}`); return this.publish(p => ({ ...p, navigation: p.navigation && { ...p.navigation, value: Math.max(0, Math.min(p.navigation.max ?? Infinity, p.navigation.value + input.delta)) } })); }
  async restartPlayback() { return this.unchanged('restartPlayback'); }
  play() { record('play'); return this.publish(p => ({ ...p, navigation: p.navigation && { ...p.navigation, playing: true }, status: { ...p.status, ui: 'playing' } })); }
  pause() { record('pause'); return this.publish(p => ({ ...p, navigation: p.navigation && { ...p.navigation, playing: false }, status: { ...p.status, ui: 'paused' } })); }
  retainComparison(input: Parameters<ActivityBinding['retainComparison']>[0]) { record(`retainComparison ${input.label}`); return this.publish(p => ({ ...p, comparisons: [...p.comparisons, {
    runId: `run-${this.counter}`, label: input.label, ordinal: p.comparisons.length + 1, name: 'same settings as the current run', parameterDifferences: [], alignment: 'index',
    domainNote: 'Fixture comparison (no model is evaluated).', frameId: p.frame?.frameId ?? null, position: p.frame?.position ?? { kind: 'static' }, positionText: null,
    boundary: null, values: [], sameValues: 0, aligned: [], overlays: [],
  }] })); }
  removeComparison(input: Parameters<ActivityBinding['removeComparison']>[0]) { return this.publish(p => ({ ...p, comparisons: p.comparisons.filter(c => c.runId !== input.runId) })); }
  setCamera(input: Parameters<ActivityBinding['setCamera']>[0]) { record(`setCamera ${input.viewId} rev ${input.expectedPresentationRevision}`); return this.presentation(p => ({ ...p, views: { ...p.views, [input.viewId]: { camera: input.camera, layers: p.views[input.viewId]?.layers ?? [] } } })); }
  resetView(input: Parameters<ActivityBinding['resetView']>[0]) { record(`resetView ${input.viewId}`); return this.presentation(p => ({ ...p, views: { ...p.views, [input.viewId]: { camera: null, layers: p.views[input.viewId]?.layers ?? [] } } })); }
  setDisplayUnit(input: Parameters<ActivityBinding['setDisplayUnit']>[0]) { record(`setDisplayUnit ${input.parameter} ${input.unit}`); return this.presentation(p => ({ ...p, displayUnits: { ...p.displayUnits, [input.parameter]: input.unit } })); }
  select(input: Parameters<ActivityBinding['select']>[0]) { record(`select ${input.target}`); return this.presentation(p => ({ ...p, selection: input.target })); }
  setLayout(input: Parameters<ActivityBinding['setLayout']>[0]) { return this.presentation(p => ({ ...p, layout: input.layout })); }
  async requestHelp() { return this.unchanged('requestHelp'); }
  acknowledgeDisplay(input: Parameters<ActivityBinding['acknowledgeDisplay']>[0]) { record(`acknowledgeDisplay ${input.projectionId} from ${input.surfaceId.slice(0, 16)}…`); }
  registerSurface(surfaceId: string) { record(`registerSurface ${surfaceId.slice(0, 16)}…`); return () => record('unregisterSurface'); }
  reportVisibility(input: { surfaceId: string; visible: boolean }) { record(`reportVisibility ${input.visible}`); }
  async retryPersistence() { return this.unchanged('retryPersistence'); }
  describeCurrentValues() { return `Fixture values: ${this.projection.views.flatMap(view => view.values).map(v => `${v.label} ${v.text}`).join('; ') || 'none'}.`; }
}

const initial = fixtureProjection(fixture, state);
initial.presentation = { ...initial.presentation, layout };
const binding = new FixtureBinding(initial);
const container = document.querySelector<HTMLElement>('#lab-surface')!;
container.style.width = `${width}px`;
document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
const diagnostics: SurfaceDiagnostic[] = [];
const props: StudyActivitySurfaceProps = {
  binding, theme, fonts, headingLevel: 2,
  onDiagnostic: diagnostic => { diagnostics.push(diagnostic); record(`diagnostic ${diagnostic.code}: ${diagnostic.message}`); },
  nextAction: initial.stage.kind === 'explore' || initial.stage.kind === 'predict' ? { label: 'Continue (fixture)', onSelect: () => record('nextAction selected (host-owned)'), status: 'Host-owned action' } : undefined,
};
(window as unknown as { __lab: unknown }).__lab = { binding, diagnostics, fixture, state, width };

if (mode === 'react') {
  adoptActivityStyles(document);
  createRoot(container).render(<StrictMode><StudyActivitySurface {...props} /></StrictMode>);
} else {
  const mounted = mountStudyActivity(container, props);
  (window as unknown as { __lab: Record<string, unknown> }).__lab.mounted = mounted;
  void mounted.ready.then(() => { document.body.dataset.ready = 'true'; });
}

// Lab chrome: state/fixture/width/theme pickers (plain links; this page has no build-time CSP).
const picker = document.querySelector<HTMLElement>('#lab-picker')!;
const link = (key: string, value: string | number, current: string | number) => {
  const next = new URLSearchParams(location.search);
  next.set(key, String(value));
  const anchor = document.createElement('a');
  anchor.href = `?${next}`;
  anchor.textContent = String(value);
  if (String(value) === String(current)) anchor.setAttribute('aria-current', 'page');
  return anchor;
};
for (const [key, values, current] of [['fixture', FIXTURES, fixture], ['state', UI_STATES, state], ['width', [320, 390, 640, 960], width], ['theme', ['light', 'dark'], theme], ['fonts', ['system', 'bundled'], fonts], ['layout', ['auto', 'card', 'side', 'expanded'], layout]] as const) {
  const row = document.createElement('p');
  row.append(`${key}: `);
  for (const value of values) { row.append(link(key, value, current), ' '); }
  picker.append(row);
}
