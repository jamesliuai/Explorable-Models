/**
 * Activity template for a function and its derivative (report §6.1, §12.1). Required flow: prepare with the graph and
 * probe → predict with every slope hidden → explore the tangent and slope at a movable probe and the secant through a
 * second point, revealed under an exposure receipt → add the derivative graph only when the host authorizes that
 * stage → explanation requested through the host → closed. `free-explore` is a separately reachable stage for an
 * authorized free-exploration version. Response requests reference host-owned task families only; this template
 * carries no answers, rubrics or held-out items.
 */
import type { ActivityTemplate, ContentGroup, MarkSpec, StageSpec } from '@experiment-kit/activity';
import { modelIdentity } from '@experiment-kit/core/model';
import { FUNCTION_DERIVATIVE_COPY as COPY } from '../copy/function-derivative.js';
import { functionDerivativeManifest as manifest } from '../models/function-derivative.js';

/**
 * Browser spec that exercises each claimed equivalence (report §11): every `#fragment` below is contained in the title of
 * the test that checks it through the rendered surface (fixture-host Chromium results, not manual AT evaluation).
 */
const VERIFIED_BY = 'tests/browser/study-function-derivative.spec.ts';

const group = (id: string, kind: ContentGroup['kind'], copy: { label: string; description: string }, solutionBearing: boolean, members: string[]): ContentGroup =>
  ({ id, kind, label: copy.label, description: copy.description, solutionBearing, members });

const mark = (spec: Omit<MarkSpec, 'style'> & { style: Partial<MarkSpec['style']> & Pick<MarkSpec['style'], 'role' | 'marker'> }): MarkSpec =>
  ({ ...spec, style: { dash: 'solid', weight: 'regular', ...spec.style } });

const citation = (id: string): string => {
  const source = manifest.sources.find(entry => entry.id === id);
  if (!source) throw new RangeError(`The function-derivative manifest has no source ${id}.`);
  return source.citation;
};

const AXIS_X = { label: 'x', unit: 'dimensionless' } as const;
const ALL_FIXED = { A: 'fixed', B: 'fixed', C: 'fixed', p: 'fixed', h: 'fixed' } as const;
const ALL_INTERACTIVE = { A: 'interactive', B: 'interactive', C: 'interactive', p: 'interactive', h: 'interactive' } as const;
/** Groups visible in every open stage: the graph, the probe, the rule and the accessible alternatives. The probe marker P is
 * draggable (pointer and keyboard) in the explore stages, where its group is interactive and p is an interactive control. */
const BASE = { 'function-plot': 'fixed', probe: 'fixed', 'function-rule': 'fixed', alternatives: 'fixed' } as const;
/** Everything revealed with the tangent and the secant. */
const SLOPE_AND_SECANT = {
  tangent: 'fixed', slope: 'fixed', 'slope-equations': 'fixed', secant: 'fixed', 'secant-values': 'fixed', 'secant-equations': 'fixed',
} as const;
const DERIVATIVE = { 'derivative-plot': 'fixed', shape: 'fixed', 'derivative-rule': 'fixed' } as const;

/** Approved settings: two curvatures, the linear and constant degeneracies, and three offsets for one probe. */
const SCENARIOS = [
  { id: 'curve-up', parameters: { A: 0.5, B: -1, C: -2, p: -2, h: 1 } },
  { id: 'curve-down', parameters: { A: -0.5, B: -1, C: 3, p: 1, h: 1 } },
  { id: 'sloped-line', parameters: { A: 0, B: 1.5, C: -1, p: 1, h: 1 } },
  { id: 'level-line', parameters: { A: 0, B: 0, C: 2, p: 1, h: 1 } },
  { id: 'offset-1', parameters: { A: 0.5, B: -1, C: -2, p: 2, h: 1 } },
  { id: 'offset-0.1', parameters: { A: 0.5, B: -1, C: -2, p: 2, h: 0.1 } },
  { id: 'offset-0.01', parameters: { A: 0.5, B: -1, C: -2, p: 2, h: 0.01 } },
] as const;

export const functionDerivativeTemplate: ActivityTemplate = {
  contract: 'study-harness.activity-template',
  schemaVersion: '1.0',
  templateId: 'function-derivative',
  version: '1.0.0',
  model: { modelId: manifest.modelId, version: manifest.version, digest: modelIdentity(manifest).digest },
  title: COPY.title,
  purpose: COPY.purpose,
  dimension: '2d',
  locale: 'en',
  requires: [],
  groups: [
    group('function-plot', 'view', COPY.groups.functionPlot, false, ['function-plot', 'curve-table']),
    group('probe', 'quantity', COPY.groups.probe, false, ['probe.x', 'probe.value']),
    group('function-rule', 'equation', COPY.groups.functionRule, false, ['function-equation']),
    group('coefficient-controls', 'control', COPY.groups.coefficientControls, false, ['A', 'B', 'C']),
    group('probe-control', 'control', COPY.groups.probeControl, false, ['p']),
    group('offset-control', 'control', COPY.groups.offsetControl, false, ['h']),
    group('tangent', 'dataset', COPY.groups.tangent, true, ['tangent']),
    group('slope', 'quantity', COPY.groups.slope, true, ['derivative', 'slope.sign']),
    group('slope-equations', 'equation', COPY.groups.slopeEquations, true, ['tangent-equation', 'slope-at-probe']),
    group('secant', 'dataset', COPY.groups.secant, true, ['secant', 'second']),
    group('secant-values', 'quantity', COPY.groups.secantValues, true, ['second.x', 'second.value', 'secant.slope', 'secant.difference']),
    group('secant-equations', 'equation', COPY.groups.secantEquations, true, ['secant-quotient', 'secant-gap']),
    group('derivative-plot', 'view', COPY.groups.derivativePlot, true, ['derivative-plot', 'derivative-table']),
    group('shape', 'quantity', COPY.groups.shape, true, ['curvature', 'vertex.x']),
    group('derivative-rule', 'equation', COPY.groups.derivativeRule, true, ['derivative-formula', 'secant-identity']),
    group('scenarios', 'annotation', COPY.groups.scenarios, false, ['scenario-note']),
    group('alternatives', 'alternative', COPY.groups.alternatives, false, ['curve-table', 'point-values', 'derivative-table', 'text-description', 'exact-entry', 'keyboard-controls']),
  ],
  views: [
    {
      id: 'function-plot', kind: 'plot2d', group: 'function-plot', title: 'Graph of f',
      description: 'The function f(x) = A·x² + B·x + C for x from −5 to 5 with the probe point P and, once shown, the tangent at P, the second point Q and the secant through P and Q.',
      bounds: [-5, 5, -8, 8], equalAspect: false,
      axes: { x: AXIS_X, y: { label: 'f(x)', unit: 'dimensionless' } },
      marks: [
        mark({ id: 'function-curve', kind: 'curve', group: 'function-plot', label: 'Graph of f', bindings: { geometry: 'curve' }, style: { role: 'primary', marker: 'none' } }),
        mark({ id: 'tangent-line', kind: 'segments', group: 'tangent', label: 'Tangent line at P', bindings: { geometry: 'tangent' }, style: { role: 'accent', marker: 'none', dash: 'dashed' }, extent: 'line' }),
        mark({ id: 'secant-line', kind: 'segments', group: 'secant', label: 'Secant line through P and Q', bindings: { geometry: 'secant' }, style: { role: 'secondary', marker: 'none', dash: 'dotted' }, extent: 'line' }),
        mark({
          id: 'probe-marker', kind: 'point', group: 'probe', label: 'Probe point P = (p, f(p))', bindings: { geometry: 'probe' }, style: { role: 'reference', marker: 'circle', weight: 'bold' },
          text: 'P', placement: { anchor: 'nw', offset: [-6, -6], leader: false, maxWidthEm: 3 }, drag: { x: 'p' },
        }),
        mark({
          id: 'second-marker', kind: 'point', group: 'secant', label: 'Second point Q = (p + h, f(p + h))', bindings: { geometry: 'second' }, style: { role: 'secondary', marker: 'square' },
          text: 'Q', placement: { anchor: 'se', offset: [6, 6], leader: false, maxWidthEm: 3 },
        }),
      ],
    },
    {
      id: 'derivative-plot', kind: 'plot2d', group: 'derivative-plot', title: 'Graph of the derivative f′',
      description: 'The analytical derivative f′(x) = 2A·x + B for x from −5 to 5, with the point (p, f′(p)) for the probe.',
      bounds: [-5, 5, -8, 8], equalAspect: false,
      axes: { x: AXIS_X, y: { label: 'f′(x)', unit: 'dimensionless' } },
      marks: [
        mark({ id: 'derivative-curve-line', kind: 'curve', group: 'derivative-plot', label: 'Graph of f′', bindings: { geometry: 'derivative-curve' }, style: { role: 'primary', marker: 'none' } }),
        mark({
          id: 'derivative-probe-marker', kind: 'point', group: 'derivative-plot', label: 'Derivative at the probe (p, f′(p))', bindings: { geometry: 'derivative-probe' },
          style: { role: 'reference', marker: 'diamond', weight: 'bold' }, text: 'f′(p)', placement: { anchor: 'ne', offset: [6, -6], leader: false, maxWidthEm: 4 },
        }),
      ],
    },
    {
      id: 'readouts', kind: 'values', group: 'probe', title: 'Values', description: 'Values at the probe and the second point. Values that are not shown yet are not listed.',
      equalAspect: false, marks: [],
      quantities: ['probe.x', 'probe.value', 'derivative', 'slope.sign', 'second.x', 'second.value', 'secant.slope', 'secant.difference', 'curvature', 'vertex.x'],
    },
    {
      id: 'rules', kind: 'equation', group: 'function-rule', title: 'Rules', description: 'The function rule and, once shown, the tangent, secant and derivative relations.',
      equalAspect: false, marks: [], equations: ['function-equation', 'tangent-equation', 'slope-at-probe', 'secant-quotient', 'secant-gap', 'derivative-formula', 'secant-identity'],
    },
    {
      id: 'curve-table', kind: 'table', group: 'function-plot', title: 'Table of f(x)', description: 'x and f(x) at each sampled position from −5 to 5.',
      equalAspect: false, marks: [], rowsFrom: 'curve', axes: { x: AXIS_X, y: { label: 'f(x)', unit: 'dimensionless' } },
    },
    {
      id: 'derivative-table', kind: 'table', group: 'derivative-plot', title: 'Table of f′(x)', description: 'x and f′(x) at each sampled position from −5 to 5.',
      equalAspect: false, marks: [], rowsFrom: 'derivative-curve', axes: { x: AXIS_X, y: { label: 'f′(x)', unit: 'dimensionless' } },
    },
  ],
  controls: [
    { parameter: 'A', group: 'coefficient-controls', label: 'Coefficient A', displayUnits: ['dimensionless'], slider: true, exact: true, step: 0.25, section: COPY.sections.coefficients, description: 'Coefficient of x². Use the slider, the arrow keys or type an exact value.' },
    { parameter: 'B', group: 'coefficient-controls', label: 'Coefficient B', displayUnits: ['dimensionless'], slider: true, exact: true, step: 0.25, section: COPY.sections.coefficients, description: 'Coefficient of x.' },
    { parameter: 'C', group: 'coefficient-controls', label: 'Coefficient C', displayUnits: ['dimensionless'], slider: true, exact: true, step: 0.25, section: COPY.sections.coefficients, description: 'Constant term; it moves the graph up or down.' },
    { parameter: 'p', group: 'probe-control', label: 'Probe position p', displayUnits: ['dimensionless'], slider: true, exact: true, step: 0.25, section: COPY.sections.points, description: 'Where the probe point P sits along the x-axis. You can also drag P along the graph, or focus P and use the left and right arrow keys; Escape cancels a move.' },
    { parameter: 'h', group: 'offset-control', label: 'Offset h', displayUnits: ['dimensionless'], slider: true, exact: true, step: 0.25, section: COPY.sections.points, description: 'Horizontal distance from P to the second point Q. Type small values such as 0.01 exactly; h = 0 puts Q on P.' },
  ],
  scenarios: SCENARIOS.map(({ id, parameters }) => ({ id, ...COPY.scenario(parameters), parameters: { ...parameters }, group: 'scenarios' })),
  equations: [
    { id: 'function-equation', group: 'function-rule', label: 'Function', tex: 'f(x) = A\\,x^{2} + B\\,x + C', plain: 'f(x) = A·x² + B·x + C' },
    { id: 'tangent-equation', group: 'slope-equations', label: 'Tangent line at P', tex: "y = f(p) + f'(p)\\,(x - p)", plain: 'y = f(p) + f′(p)·(x − p)' },
    { id: 'slope-at-probe', group: 'slope-equations', label: 'Slope of the tangent (analytical derivative)', tex: "f'(p) = {{q:derivative}}", plain: 'f′(p) = {{q:derivative}}' },
    {
      id: 'secant-quotient', group: 'secant-equations', label: 'Secant slope',
      tex: 'm_{\\text{sec}} = \\frac{f(p + h) - f(p)}{h} = {{q:secant.slope}}', plain: 'm_sec = (f(p + h) − f(p))/h = {{q:secant.slope}}',
    },
    { id: 'secant-gap', group: 'secant-equations', label: 'Secant slope minus derivative', tex: "m_{\\text{sec}} - f'(p) = {{q:secant.difference}}", plain: 'm_sec − f′(p) = {{q:secant.difference}}' },
    { id: 'derivative-formula', group: 'derivative-rule', label: 'Derivative', tex: "f'(x) = 2A\\,x + B", plain: 'f′(x) = 2A·x + B' },
    {
      id: 'secant-identity', group: 'derivative-rule', label: 'Secant slope for h ≠ 0',
      tex: "\\frac{f(p + h) - f(p)}{h} = 2A\\,p + B + A\\,h = f'(p) + A\\,h \\quad (h \\neq 0)", plain: '(f(p + h) − f(p))/h = 2A·p + B + A·h = f′(p) + A·h, for h ≠ 0',
    },
  ],
  stages: [
    {
      id: 'prepare', kind: 'prepare', instruction: COPY.stages.prepare.instruction,
      visible: { ...BASE, 'function-plot': 'interactive', 'coefficient-controls': 'interactive', 'probe-control': 'fixed', scenarios: 'interactive' },
      controls: { A: 'interactive', B: 'interactive', C: 'interactive', p: 'fixed' }, allowsPreview: true, allowsPlayback: false, allowsNavigation: false,
    },
    {
      id: 'predict', kind: 'predict', instruction: COPY.stages.predict.instruction,
      visible: { ...BASE, 'coefficient-controls': 'fixed', 'probe-control': 'fixed' },
      controls: { A: 'fixed', B: 'fixed', C: 'fixed', p: 'fixed' }, allowsPreview: false, allowsPlayback: false, allowsNavigation: false,
      response: { kind: 'prediction', prompt: COPY.stages.predict.prompt, taskFamily: 'function-derivative-slope-prediction' },
    },
    {
      id: 'explore-slope', kind: 'explore', instruction: COPY.stages.exploreSlope.instruction,
      visible: {
        ...BASE, ...SLOPE_AND_SECANT, 'function-plot': 'interactive', probe: 'interactive', 'coefficient-controls': 'fixed', 'probe-control': 'interactive', 'offset-control': 'interactive',
        tangent: 'interactive', secant: 'interactive', scenarios: 'interactive',
      },
      controls: { A: 'fixed', B: 'fixed', C: 'fixed', p: 'interactive', h: 'interactive' }, allowsPreview: true, allowsPlayback: false, allowsNavigation: false,
    },
    {
      id: 'explore-derivative', kind: 'explore', instruction: COPY.stages.exploreDerivative.instruction,
      visible: {
        ...BASE, ...SLOPE_AND_SECANT, ...DERIVATIVE, 'function-plot': 'interactive', probe: 'interactive', 'coefficient-controls': 'interactive', 'probe-control': 'interactive', 'offset-control': 'interactive',
        tangent: 'interactive', secant: 'interactive', 'derivative-plot': 'interactive', scenarios: 'interactive',
      },
      controls: { ...ALL_INTERACTIVE }, allowsPreview: true, allowsPlayback: false, allowsNavigation: false,
    },
    {
      id: 'explain', kind: 'explain', instruction: COPY.stages.explain.instruction,
      visible: { ...BASE, ...SLOPE_AND_SECANT, ...DERIVATIVE, 'coefficient-controls': 'fixed', 'probe-control': 'fixed', 'offset-control': 'fixed' },
      controls: { ...ALL_FIXED }, allowsPreview: false, allowsPlayback: false, allowsNavigation: false,
      response: { kind: 'explanation', prompt: COPY.stages.explain.prompt, taskFamily: 'function-derivative-explanation' },
    },
    { id: 'closed', kind: 'closed', instruction: COPY.stages.closed.instruction, visible: {}, controls: {}, allowsPreview: false, allowsPlayback: false, allowsNavigation: false },
    {
      id: 'free-explore', kind: 'explore', instruction: COPY.stages.freeExplore.instruction,
      visible: {
        ...BASE, ...SLOPE_AND_SECANT, ...DERIVATIVE, 'function-plot': 'interactive', probe: 'interactive', 'coefficient-controls': 'interactive', 'probe-control': 'interactive', 'offset-control': 'interactive',
        tangent: 'interactive', secant: 'interactive', 'derivative-plot': 'interactive', scenarios: 'interactive',
      },
      controls: { ...ALL_INTERACTIVE }, allowsPreview: true, allowsPlayback: false, allowsNavigation: false,
    },
  ],
  transitions: [
    { id: 'start-prediction', from: 'prepare', to: 'predict', label: 'Ask for a prediction' },
    { id: 'show-slopes', from: 'predict', to: 'explore-slope', label: 'Show the tangent, the slope and the secant' },
    { id: 'show-derivative-graph', from: 'explore-slope', to: 'explore-derivative', label: 'Show the derivative graph' },
    { id: 'request-explanation', from: 'explore-derivative', to: 'explain', label: 'Ask for an explanation' },
    { id: 'close-after-explanation', from: 'explain', to: 'closed', label: 'Close the activity' },
    { id: 'close-from-preparation', from: 'prepare', to: 'closed', label: 'Close the activity' },
    { id: 'close-from-prediction', from: 'predict', to: 'closed', label: 'Close the activity' },
    { id: 'close-from-slope-exploration', from: 'explore-slope', to: 'closed', label: 'Close the activity' },
    { id: 'close-from-derivative-exploration', from: 'explore-derivative', to: 'closed', label: 'Close the activity' },
    { id: 'close-from-free-exploration', from: 'free-explore', to: 'closed', label: 'Close the activity' },
  ],
  initialStage: 'prepare',
  alternatives: [
    { id: 'curve-table', kind: 'table', group: 'alternatives', ...COPY.alternatives.curveTable, covers: ['function-plot', 'function-curve'], equivalence: 'equivalent', verifiedBy: `${VERIFIED_BY}#curve-table-equivalent` },
    {
      id: 'point-values', kind: 'description', group: 'alternatives', ...COPY.alternatives.pointValues,
      covers: ['function-plot', 'probe-marker', 'second-marker', 'tangent-line', 'secant-line'], equivalence: 'equivalent', verifiedBy: `${VERIFIED_BY}#point-values-equivalent`,
    },
    {
      id: 'derivative-table', kind: 'table', group: 'alternatives', ...COPY.alternatives.derivativeTable,
      covers: ['derivative-plot', 'derivative-curve-line', 'derivative-probe-marker'], equivalence: 'equivalent', verifiedBy: `${VERIFIED_BY}#derivative-table-equivalent`,
    },
    { id: 'text-description', kind: 'description', group: 'alternatives', ...COPY.alternatives.textDescription, covers: ['function-plot', 'derivative-plot'], equivalence: 'partial', verifiedBy: `${VERIFIED_BY}#text-description` },
    { id: 'exact-entry', kind: 'numeric-entry', group: 'alternatives', ...COPY.alternatives.exactEntry, covers: ['A', 'B', 'C', 'p', 'h'], equivalence: 'equivalent', verifiedBy: `${VERIFIED_BY}#exact-entry` },
    { id: 'keyboard-controls', kind: 'keyboard', group: 'alternatives', ...COPY.alternatives.keyboard, covers: ['A', 'B', 'C', 'p', 'h', 'probe-marker'], equivalence: 'equivalent', verifiedBy: `${VERIFIED_BY}#keyboard-only` },
  ],
  taskFamilies: [
    { id: 'function-derivative-slope-prediction', description: 'Host-owned prediction request about the slope of the graph at the probe point and how it changes along the curve. The host owns the response, its capture and any evaluation.', hostOwned: true },
    { id: 'function-derivative-explanation', description: 'Host-owned explanation request about how the tangent slope changes along the curve and how secant slopes behave as the offset shrinks. The host owns the response, its capture and any evaluation.', hostOwned: true },
    { id: 'function-derivative-later-task', description: 'Host-owned later task with another function or representation. Its prompts, held-out items and scoring stay with the host and are not part of this catalogue.', hostOwned: true },
  ],
  content: [
    { id: 'derivation-difference-quotient', kind: 'derivation', text: citation('derivation-difference-quotient') },
    { id: 'assumptions', kind: 'assumption', text: manifest.interpretation.assumptions.join(' ') },
    { id: 'source-specification', kind: 'source', text: citation('study-harness-specification') },
    { id: 'scenario-note', kind: 'learner-copy', text: COPY.scenarioNote },
  ],
};
