/**
 * Activity template for quadratic gradient descent (report §6.1, §12.3). Required flow: predict with the trace
 * hidden → explore the step size with the trace revealed under an exposure receipt → add the curvature control →
 * explanation requested through the host → closed. `free-explore` is a separately reachable stage for an
 * authorized free-exploration version. Response requests reference host-owned task families only; this template
 * carries no answers, rubrics or held-out items.
 */
import type { ActivityTemplate, ContentGroup, MarkSpec, StageSpec } from '@experiment-kit/activity';
import { modelIdentity } from '@experiment-kit/core/model';
import { QUADRATIC_COPY as COPY } from '../copy/quadratic-gradient-descent.js';
import { quadraticGradientDescentManifest as manifest } from '../models/quadratic-gradient-descent.js';

/**
 * Browser tests that must exercise each claimed equivalence (report §11). The spec file belongs to the browser test
 * phase; until it exists and passes, these equivalence claims are unverified.
 */
const VERIFIED_BY = 'tests/browser/study-quadratic.spec.ts';

const group = (id: string, kind: ContentGroup['kind'], copy: { label: string; description: string }, solutionBearing: boolean, members: string[]): ContentGroup =>
  ({ id, kind, label: copy.label, description: copy.description, solutionBearing, members });

const mark = (spec: Omit<MarkSpec, 'style'> & { style: Partial<MarkSpec['style']> & Pick<MarkSpec['style'], 'role' | 'marker'> }): MarkSpec =>
  ({ ...spec, style: { dash: 'solid', weight: 'regular', ...spec.style } });

const closedStage = (id: string, kind: StageSpec['kind'], instruction: string): StageSpec =>
  ({ id, kind, instruction, visible: {}, controls: {}, allowsPreview: false, allowsPlayback: false, allowsNavigation: false });

const ALL_FIXED = { eta: 'fixed', a: 'fixed', x0: 'fixed' } as const;
const citation = (id: string): string => {
  const source = manifest.sources.find(entry => entry.id === id);
  if (!source) throw new RangeError(`The quadratic manifest has no source ${id}.`);
  return source.citation;
};
const SCENARIO_STEPS = [0.25, 0.75, 1.25] as const;

export const quadraticGradientDescentTemplate: ActivityTemplate = {
  contract: 'study-harness.activity-template',
  schemaVersion: '1.0',
  templateId: 'quadratic-gradient-descent',
  version: '1.0.0',
  model: { modelId: manifest.modelId, version: manifest.version, digest: modelIdentity(manifest).digest },
  title: COPY.title,
  purpose: COPY.purpose,
  dimension: '2d',
  locale: 'en',
  requires: [{ id: 'discrete-iteration', version: '1.0' }],
  groups: [
    group('landscape', 'view', COPY.groups.landscape, false, ['landscape']),
    group('start', 'quantity', COPY.groups.start, false, ['start.position', 'start.loss']),
    group('update-rule', 'equation', COPY.groups.updateRule, false, ['objective', 'update-rule']),
    group('step-control', 'control', COPY.groups.stepControl, false, ['eta']),
    group('curvature-control', 'control', COPY.groups.curvatureControl, false, ['a']),
    group('start-control', 'control', COPY.groups.startControl, false, ['x0']),
    group('navigation', 'quantity', COPY.groups.navigation, false, ['index']),
    group('trace', 'dataset', COPY.groups.trace, true, ['trace', 'iterates', 'steps', 'current']),
    group('observations', 'quantity', COPY.groups.observations, true, ['position', 'loss', 'gradient', 'multiplier', 'product']),
    group('regime', 'quantity', COPY.groups.regime, true, ['regime', 'threshold']),
    group('substituted-rule', 'equation', COPY.groups.substitutedRule, true, ['substituted-update']),
    group('scenarios', 'annotation', COPY.groups.scenarios, false, ['scenario-note']),
    group('alternatives', 'alternative', COPY.groups.alternatives, false, ['trace-table', 'landscape-equation-values', 'text-description', 'exact-entry', 'keyboard-steps']),
  ],
  views: [
    {
      id: 'landscape', kind: 'plot2d', group: 'landscape', title: 'Objective landscape',
      description: 'The objective f(x) = a·x²/2 for positions from −10 to 10, with the starting point and, once shown, the iterates and the steps between them.',
      bounds: [-10, 10, -5, 105], equalAspect: false,
      axes: { x: { label: 'Position x', unit: 'dimensionless' }, y: { label: 'Loss f(x)', unit: 'dimensionless' } },
      marks: [
        mark({ id: 'objective-curve', kind: 'curve', group: 'landscape', label: 'Objective f(x)', bindings: { geometry: 'curve' }, style: { role: 'primary', marker: 'none' } }),
        mark({
          id: 'start-marker', kind: 'point', group: 'start', label: 'Starting point (x₀, f(x₀))', bindings: { geometry: 'start' }, style: { role: 'reference', marker: 'square', weight: 'bold' },
          text: 'x₀', placement: { anchor: 'ne', offset: [6, -6], leader: false, maxWidthEm: 4 },
        }),
        mark({ id: 'iterate-steps', kind: 'segments', group: 'trace', label: 'Steps between successive iterates', bindings: { geometry: 'steps' }, style: { role: 'muted', marker: 'none', dash: 'dashed', weight: 'thin' } }),
        mark({ id: 'iterate-points', kind: 'points', group: 'trace', label: 'Iterates (x_k, f(x_k))', bindings: { geometry: 'iterates' }, style: { role: 'accent', marker: 'circle' } }),
        mark({
          id: 'current-iterate', kind: 'point', group: 'trace', label: 'Current iterate (x_n, f(x_n))', bindings: { geometry: 'current' }, style: { role: 'accent', marker: 'diamond', weight: 'bold' },
          text: 'xₙ', placement: { anchor: 'nw', offset: [-6, -6], leader: false, maxWidthEm: 4 },
        }),
      ],
    },
    {
      id: 'trace-plot', kind: 'plot2d', group: 'trace', title: 'Position by iteration',
      description: 'Each point is the position x_n after n updates. Points are not joined because only whole iterations exist.',
      bounds: [0, 12, -16, 16], equalAspect: false,
      axes: { x: { label: 'Iteration n', unit: 'iteration' }, y: { label: 'Position x_n', unit: 'dimensionless' } },
      marks: [mark({ id: 'trace-points', kind: 'points', group: 'trace', label: 'Position x_n at each iteration n', bindings: { geometry: 'trace' }, style: { role: 'primary', marker: 'circle' } })],
    },
    {
      id: 'readouts', kind: 'values', group: 'start', title: 'Values', description: 'Values at the current iteration. Values that are not shown yet are not listed.',
      equalAspect: false, marks: [],
      quantities: ['start.position', 'start.loss', 'index', 'position', 'loss', 'gradient', 'multiplier', 'product', 'regime', 'threshold'],
    },
    {
      id: 'rules', kind: 'equation', group: 'update-rule', title: 'Rules', description: 'The objective and the gradient-descent update rule.',
      equalAspect: false, marks: [], equations: ['objective', 'update-rule', 'substituted-update', 'convergence-condition'],
    },
    {
      id: 'trace-table', kind: 'table', group: 'trace', title: 'Trace table', description: 'Iteration n and position x_n for every computed iteration up to the current one.',
      equalAspect: false, marks: [], rowsFrom: 'trace',
      axes: { x: { label: 'Iteration n', unit: 'iteration' }, y: { label: 'Position x_n', unit: 'dimensionless' } },
    },
  ],
  controls: [
    { parameter: 'eta', group: 'step-control', label: 'Step size η', displayUnits: ['dimensionless'], slider: true, exact: true, step: 0.05, description: 'Size of every update step. Use the slider, the arrow keys or type an exact value.' },
    { parameter: 'a', group: 'curvature-control', label: 'Curvature a', displayUnits: ['dimensionless'], slider: true, exact: true, step: 0.1, description: 'How sharply the objective curves; larger values make the curve steeper.' },
    { parameter: 'x0', group: 'start-control', label: 'Starting position x₀', displayUnits: ['dimensionless'], slider: true, exact: true, step: 0.5, description: 'Where the iterations start.' },
  ],
  scenarios: SCENARIO_STEPS.map(eta => ({ id: `step-${eta}`, ...COPY.scenario(eta), parameters: { a: 2, eta, x0: 4 }, group: 'scenarios' })),
  equations: [
    { id: 'objective', group: 'update-rule', label: 'Objective', tex: 'f(x) = \\tfrac{a}{2}\\,x^{2}', plain: 'f(x) = (a/2)·x²' },
    { id: 'update-rule', group: 'update-rule', label: 'Update rule', tex: 'x_{n+1} = (1 - \\eta a)\\,x_{n}', plain: 'x_(n+1) = (1 − η·a)·x_n' },
    { id: 'substituted-update', group: 'substituted-rule', label: 'Update rule with current values', tex: 'x_{n+1} = (1 - {{q:product}})\\,x_{n} = {{q:multiplier}}\\,x_{n}', plain: 'x_(n+1) = (1 − {{q:product}})·x_n = {{q:multiplier}}·x_n' },
    { id: 'convergence-condition', group: 'regime', label: 'Convergence condition for a nonzero start', tex: '0 < \\eta a < 2 \\iff 0 < \\eta < \\tfrac{2}{a} = {{q:threshold}}', plain: '0 < η·a < 2, that is 0 < η < 2/a = {{q:threshold}}' },
  ],
  stages: [
    {
      id: 'predict', kind: 'predict', instruction: COPY.stages.predict.instruction,
      visible: { landscape: 'fixed', start: 'fixed', 'update-rule': 'fixed', 'step-control': 'fixed', 'curvature-control': 'fixed', 'start-control': 'fixed', scenarios: 'fixed', alternatives: 'fixed' },
      controls: { ...ALL_FIXED }, allowsPreview: false, allowsPlayback: false, allowsNavigation: false,
      response: { kind: 'prediction', prompt: COPY.stages.predict.prompt, taskFamily: 'quadratic-step-size-prediction' },
    },
    {
      id: 'explore-step', kind: 'explore', instruction: COPY.stages.exploreStep.instruction,
      visible: {
        landscape: 'interactive', start: 'fixed', 'update-rule': 'fixed', 'step-control': 'interactive', 'curvature-control': 'fixed', 'start-control': 'fixed',
        navigation: 'interactive', trace: 'interactive', observations: 'fixed', scenarios: 'interactive', alternatives: 'fixed',
      },
      controls: { eta: 'interactive', a: 'fixed', x0: 'fixed' }, allowsPreview: true, allowsPlayback: true, allowsNavigation: true,
    },
    {
      id: 'explore-curvature', kind: 'explore', instruction: COPY.stages.exploreCurvature.instruction,
      visible: {
        landscape: 'interactive', start: 'fixed', 'update-rule': 'fixed', 'step-control': 'interactive', 'curvature-control': 'interactive', 'start-control': 'fixed',
        navigation: 'interactive', trace: 'interactive', observations: 'fixed', 'substituted-rule': 'fixed', scenarios: 'interactive', alternatives: 'fixed',
      },
      controls: { eta: 'interactive', a: 'interactive', x0: 'fixed' }, allowsPreview: true, allowsPlayback: true, allowsNavigation: true,
    },
    {
      id: 'explain', kind: 'explain', instruction: COPY.stages.explain.instruction,
      visible: {
        landscape: 'fixed', start: 'fixed', 'update-rule': 'fixed', 'step-control': 'fixed', 'curvature-control': 'fixed', 'start-control': 'fixed',
        trace: 'fixed', observations: 'fixed', 'substituted-rule': 'fixed', alternatives: 'fixed',
      },
      controls: { ...ALL_FIXED }, allowsPreview: false, allowsPlayback: false, allowsNavigation: false,
      response: { kind: 'explanation', prompt: COPY.stages.explain.prompt, taskFamily: 'quadratic-step-size-explanation' },
    },
    closedStage('closed', 'closed', COPY.stages.closed.instruction),
    {
      id: 'free-explore', kind: 'explore', instruction: COPY.stages.freeExplore.instruction,
      visible: {
        landscape: 'interactive', start: 'fixed', 'update-rule': 'fixed', 'step-control': 'interactive', 'curvature-control': 'interactive', 'start-control': 'interactive',
        navigation: 'interactive', trace: 'interactive', observations: 'fixed', regime: 'fixed', 'substituted-rule': 'fixed', scenarios: 'interactive', alternatives: 'fixed',
      },
      controls: { eta: 'interactive', a: 'interactive', x0: 'interactive' }, allowsPreview: true, allowsPlayback: true, allowsNavigation: true,
    },
  ],
  transitions: [
    { id: 'start-step-exploration', from: 'predict', to: 'explore-step', label: 'Show the iterations and explore the step size' },
    { id: 'add-curvature', from: 'explore-step', to: 'explore-curvature', label: 'Add the curvature control' },
    { id: 'request-explanation', from: 'explore-curvature', to: 'explain', label: 'Ask for an explanation' },
    { id: 'request-explanation-early', from: 'explore-step', to: 'explain', label: 'Ask for an explanation without the curvature control' },
    { id: 'close-after-explanation', from: 'explain', to: 'closed', label: 'Close the activity' },
    { id: 'close-from-prediction', from: 'predict', to: 'closed', label: 'Close the activity' },
    { id: 'close-from-step-exploration', from: 'explore-step', to: 'closed', label: 'Close the activity' },
    { id: 'close-from-curvature-exploration', from: 'explore-curvature', to: 'closed', label: 'Close the activity' },
    { id: 'close-from-free-exploration', from: 'free-explore', to: 'closed', label: 'Close the activity' },
  ],
  initialStage: 'predict',
  alternatives: [
    { id: 'trace-table', kind: 'table', group: 'alternatives', ...COPY.alternatives.traceTable, covers: ['trace-plot', 'trace-points'], equivalence: 'equivalent', verifiedBy: `${VERIFIED_BY}#trace-table-equivalent` },
    {
      id: 'landscape-equation-values', kind: 'description', group: 'alternatives', ...COPY.alternatives.landscapeValues,
      covers: ['landscape', 'objective-curve', 'start-marker', 'iterate-points', 'iterate-steps', 'current-iterate'], equivalence: 'equivalent', verifiedBy: `${VERIFIED_BY}#landscape-equivalent`,
    },
    { id: 'text-description', kind: 'description', group: 'alternatives', ...COPY.alternatives.textDescription, covers: ['landscape', 'trace-plot'], equivalence: 'partial', verifiedBy: `${VERIFIED_BY}#text-description` },
    { id: 'exact-entry', kind: 'numeric-entry', group: 'alternatives', ...COPY.alternatives.exactEntry, covers: ['eta', 'a', 'x0'], equivalence: 'equivalent', verifiedBy: `${VERIFIED_BY}#exact-entry` },
    { id: 'keyboard-steps', kind: 'keyboard', group: 'alternatives', ...COPY.alternatives.keyboard, covers: ['eta', 'a', 'x0', 'current-iterate'], equivalence: 'equivalent', verifiedBy: `${VERIFIED_BY}#keyboard-only` },
  ],
  taskFamilies: [
    { id: 'quadratic-step-size-prediction', description: 'Host-owned prediction request about how the step size changes fixed-step gradient descent on f(x) = a·x²/2. The host owns the response, its capture and any evaluation.', hostOwned: true },
    { id: 'quadratic-step-size-explanation', description: 'Host-owned explanation request about how step size and curvature together determine the iterates. The host owns the response, its capture and any evaluation.', hostOwned: true },
    { id: 'quadratic-new-curvature-task', description: 'Host-owned later task with a new curvature or a recurrence representation. Its prompts, held-out items and scoring stay with the host and are not part of this catalogue.', hostOwned: true },
  ],
  content: [
    { id: 'derivation-closed-form', kind: 'derivation', text: citation('derivation-closed-form') },
    { id: 'assumptions', kind: 'assumption', text: manifest.interpretation.assumptions.join(' ') },
    { id: 'source-specification', kind: 'source', text: citation('study-harness-specification') },
    { id: 'scenario-note', kind: 'learner-copy', text: COPY.scenarioNote },
  ],
};
