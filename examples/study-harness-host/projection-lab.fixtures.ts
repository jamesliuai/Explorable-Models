/**
 * FIXTURE DATA ONLY. Hand-written `LearnerProjection` objects for visually inspecting the learner surface in every UI
 * state, theme and width. No model is evaluated by the surface: the few coordinates generated below are fixture
 * inputs written here, standing in for what the activity runtime would project from an identified frame. Nothing in
 * this file is a reference result, an activity, a tutor, or evidence of learning benefit.
 */
import {
  BLOCKED_INSTRUCTION, HOST_SUSPENDED_MESSAGE, TERMINAL_TEXT, UI_STATUS, VALUE_STATUS_TEXT,
  type LearnerProjection, type PresentationSnapshot, type ProjectedComparison, type ProjectedControl, type ProjectedMark, type ProjectedValue, type ProjectedView, type UiState,
} from '@explorable-models/activity';

export type FixtureName = 'quadratic' | 'geometry' | 'spatial' | 'long' | 'extreme' | 'comparison';
export const FIXTURES: readonly FixtureName[] = ['quadratic', 'geometry', 'spatial', 'long', 'extreme', 'comparison'];
export const UI_STATES: readonly UiState[] = [
  'empty', 'preparing', 'awaiting-persistence', 'ready', 'tentative-preview', 'playing', 'paused', 'boundary', 'undefined', 'clipped',
  'unsupported', 'recoverable-failure', 'stale-policy', 'suspended', 'restored', 'disposed',
];

const style = (role: ProjectedMark['style']['role'], marker: ProjectedMark['style']['marker'] = 'none', dash: ProjectedMark['style']['dash'] = 'solid', weight: ProjectedMark['style']['weight'] = 'regular') => ({ role, marker, dash, weight });
const value = (quantityId: string, label: string, text: string, extra: Partial<ProjectedValue> = {}): ProjectedValue =>
  ({ quantityId, label, text, status: 'valid', approximate: false, unit: 'dimensionless', unitLabel: '', ...extra });
const undefinedValue = (quantityId: string, label: string, reason: string): ProjectedValue =>
  ({ quantityId, label, text: 'Undefined', status: 'undefined', approximate: false, unit: 'dimensionless', unitLabel: '', reason });

function presentation(revision = 4): PresentationSnapshot {
  return { contract: 'study-harness.presentation-snapshot', schemaVersion: '1.0', revision, views: {}, selection: null, layout: 'auto', displayUnits: {}, locale: 'en', formatVersion: '1.0' };
}

/** Fixture iterates of x[n+1] = (1 − ηa)·x[n] written out for the lab (not computed by the surface). */
function iterates(a: number, eta: number, x0: number, count: number): number[] {
  const out = [x0];
  for (let n = 1; n < count; n++) out.push((1 - eta * a) * out[n - 1]);
  return out;
}
const fmt = (n: number) => Number.isInteger(n) ? String(n).replace('-', '−') : n.toFixed(Math.abs(n) < 1 ? 4 : 3).replace(/0+$/, '').replace(/\.$/, '').replace('-', '−');

function quadraticControls(eta: number, a: number, x0: number, preview?: number): ProjectedControl[] {
  const base = { mode: 'interactive' as const, integer: false, slider: true, exact: true, displayUnit: 'dimensionless' as const, displayUnits: ['dimensionless' as const], unitLabel: '' };
  return [
    { ...base, parameter: 'eta', label: 'Step size η', description: 'Size of every update step.', value: eta, previewValue: preview, min: 0, max: 2, step: 0.05 },
    { ...base, parameter: 'a', label: 'Curvature a', description: 'How sharply the objective curves.', value: a, min: 0.1, max: 10, step: 0.1, mode: 'fixed', disabledReason: 'Curvature is fixed until the next part of the activity.' },
    { ...base, parameter: 'x0', label: 'Starting position x₀', description: 'Where the iterations start.', value: x0, min: -10, max: 10, step: 0.5 },
  ];
}

function quadraticViews(a: number, eta: number, x0: number, index: number, options: { undefinedTrace?: boolean } = {}): ProjectedView[] {
  const xs = iterates(a, eta, x0, index + 1);
  const curve: [number, number][] = Array.from({ length: 201 }, (_, i) => { const x = -10 + i * 0.1; return [Number(x.toFixed(10)), a * x * x / 2]; });
  const points = xs.map((x, n) => ({ id: `p${n}`, at: options.undefinedTrace && n === xs.length - 1 ? null : [x, a * x * x / 2] as [number, number], reason: options.undefinedTrace && n === xs.length - 1 ? 'the next value is too large to represent' : undefined }));
  const steps = xs.slice(1).map((x, n) => ({ id: `s${n}`, from: [xs[n], a * xs[n] * xs[n] / 2] as [number, number], to: [x, a * x * x / 2] as [number, number] }));
  const current = xs[xs.length - 1];
  const landscape: ProjectedView = {
    viewId: 'landscape', kind: 'plot2d', title: 'Objective landscape', visibility: 'interactive', bounds: [-10, 10, -5, 105], equalAspect: false,
    description: 'The objective f(x) = a·x²/2 with the iterates.',
    axes: { x: { label: 'Position x', unitLabel: '' }, y: { label: 'Loss f(x)', unitLabel: '' } },
    marks: [
      { markId: 'objective-curve', kind: 'curve', label: 'Objective f(x)', style: style('primary'), interactive: false, geometry: { kind: 'polyline2', segments: [{ points: curve, start: 'closed', end: 'closed' }], gaps: [] } },
      { markId: 'start-marker', kind: 'point', label: 'Starting point (x₀, f(x₀))', style: style('reference', 'square', 'solid', 'bold'), interactive: false, at: [x0, a * x0 * x0 / 2], text: 'x₀', placement: { anchor: 'ne', offset: [6, -6], leader: false, maxWidthEm: 4 } },
      { markId: 'iterate-steps', kind: 'segments', label: 'Steps between successive iterates', style: style('muted', 'none', 'dashed', 'thin'), interactive: false, geometry: { kind: 'segments2', segments: steps } },
      { markId: 'iterate-points', kind: 'points', label: 'Iterates (x_k, f(x_k))', style: style('accent', 'circle'), interactive: false, geometry: { kind: 'points2', points } },
      { markId: 'current-iterate', kind: 'point', label: 'Current iterate (x_n, f(x_n))', style: style('accent', 'diamond', 'solid', 'bold'), interactive: true, at: options.undefinedTrace ? null : [current, a * current * current / 2], undefinedReason: options.undefinedTrace ? 'the next value is too large to represent' : undefined, text: 'xₙ', placement: { anchor: 'nw', offset: [-6, -6], leader: false, maxWidthEm: 4 } },
    ],
    values: [], equations: [],
    summary: `Objective f(x) = ${fmt(a)}·x²/2 from x = −10 to 10. Starting point x₀ = ${fmt(x0)}. ${xs.length} iterates shown; the current iterate is at x = ${fmt(current)}.`,
  };
  const tracePlot: ProjectedView = {
    viewId: 'trace-plot', kind: 'plot2d', title: 'Position by iteration', visibility: 'interactive', bounds: [0, 12, -16, 16], equalAspect: false,
    description: 'Each point is the position x_n after n updates.',
    axes: { x: { label: 'Iteration n', unitLabel: 'iter' }, y: { label: 'Position x_n', unitLabel: '' } },
    marks: [{ markId: 'trace-points', kind: 'points', label: 'Position x_n at each iteration n', style: style('primary', 'circle'), interactive: false, geometry: { kind: 'points2', points: xs.map((x, n) => ({ id: `t${n}`, at: options.undefinedTrace && n === xs.length - 1 ? null : [n, x] as [number, number], reason: options.undefinedTrace && n === xs.length - 1 ? 'the value overflowed' : undefined })) } }],
    values: [], equations: [],
    summary: `Positions for n = 0 to ${index}: ${xs.map(fmt).join(', ')}. Points are not joined because only whole iterations exist.`,
  };
  const readouts: ProjectedView = {
    viewId: 'readouts', kind: 'values', title: 'Values', visibility: 'fixed', equalAspect: false, description: 'Values at the current iteration.', marks: [], equations: [],
    values: [
      value('start.position', 'Starting position x₀', fmt(x0)), value('index', 'Iteration n', String(index), { unit: 'iteration', unitLabel: '' }),
      options.undefinedTrace ? { ...undefinedValue('position', 'Position x_n', 'The value is too large to represent; the last finite value is at n = 36.'), status: 'numerical-limit', text: 'Too large to represent' } : value('position', 'Position x_n', fmt(current)),
      options.undefinedTrace ? undefinedValue('loss', 'Loss f(x_n)', 'Undefined because the position is not representable.') : value('loss', 'Loss f(x_n)', fmt(a * current * current / 2)),
      value('multiplier', 'Update multiplier 1 − η·a', fmt(1 - eta * a)), value('product', 'Product η·a', fmt(eta * a)),
    ],
    summary: 'Values at the current iteration.',
  };
  const rules: ProjectedView = {
    viewId: 'rules', kind: 'equation', title: 'Rules', visibility: 'fixed', equalAspect: false, description: 'The objective and update rule.', marks: [], values: [],
    equations: [
      { equationId: 'objective', label: 'Objective', tex: 'f(x) = \\tfrac{a}{2}\\,x^{2}', plain: 'f(x) = (a/2)·x²' },
      { equationId: 'update-rule', label: 'Update rule', tex: 'x_{n+1} = (1 - \\eta a)\\,x_{n}', plain: 'x_(n+1) = (1 − η·a)·x_n' },
      { equationId: 'substituted-update', label: 'Update rule with current values', tex: `x_{n+1} = (1 - ${fmt(eta * a).replace('−', '-')})\\,x_{n} = ${fmt(1 - eta * a).replace('−', '-')}\\,x_{n}`, plain: `x_(n+1) = (1 − ${fmt(eta * a)})·x_n = ${fmt(1 - eta * a)}·x_n` },
    ],
    summary: 'The objective and the gradient-descent update rule.',
  };
  const table: ProjectedView = {
    viewId: 'trace-table', kind: 'table', title: 'Trace table', visibility: 'fixed', equalAspect: false, description: 'Iteration and position.', marks: [], values: [], equations: [],
    table: { caption: 'Iteration n and position x_n', columns: [{ id: 'n', label: 'Iteration n', unitLabel: '' }, { id: 'x', label: 'Position x_n', unitLabel: '' }], rows: xs.map((x, n) => ({ key: `r${n}`, cells: [String(n), options.undefinedTrace && n === xs.length - 1 ? 'Too large to represent' : fmt(x)] })), truncated: false, totalRows: xs.length },
    summary: 'Trace table.',
  };
  return [landscape, tracePlot, readouts, rules, table];
}

function base(overrides: Partial<LearnerProjection> = {}): LearnerProjection {
  const eta = 0.25, a = 2, x0 = 4, index = 3;
  return {
    projectionId: 'fixture-projection-1', projectionDigest: 'sha256:fixture', activityId: 'fixture-activity', activityRevision: 7, policyRevision: 2, presentationRevision: 4,
    guards: { expectedScientificVersion: 12, expectedRunId: 'fixture-run' }, preview: null,
    title: 'Step size in gradient descent',
    stage: { id: 'explore-step', kind: 'explore', instruction: 'Change the step size η and step through the iterations one at a time. Use the scenarios to compare η = 0.25, 0.75 and 1.25, and compare what you see with your prediction.' },
    context: 'instructional',
    frame: { frameId: 'fixture-frame-3', kind: 'committed', position: { kind: 'index', index, maxIndex: 1000 }, terminal: false },
    views: quadraticViews(a, eta, x0, index),
    controls: quadraticControls(eta, a, x0),
    scenarios: [0.25, 0.75, 1.25].map(step => ({ scenarioId: `step-${step}`, label: `η = ${step}`, description: `Step size ${step} with curvature a = 2, starting at x₀ = 4.`, active: step === eta })),
    navigation: { kind: 'index', value: index, max: 1000, terminal: false, canStepBack: true, canStepForward: true, playing: false, allowsPlayback: true, interpolated: false },
    comparisons: [],
    alternatives: [
      { alternativeId: 'trace-table', kind: 'table', label: 'Trace table', description: 'Lists each computed iteration n with its position x_n.', equivalence: 'equivalent' },
      { alternativeId: 'text-description', kind: 'description', label: 'Text description', description: 'A text summary of each plot built from the values currently shown.', equivalence: 'partial' },
      { alternativeId: 'exact-entry', kind: 'numeric-entry', label: 'Exact entry', description: 'Type exact values instead of dragging.', equivalence: 'equivalent' },
      { alternativeId: 'keyboard-steps', kind: 'keyboard', label: 'Keyboard controls', description: 'Arrow keys change each control by one step.', equivalence: 'equivalent' },
    ],
    presentation: presentation(),
    status: { ui: 'ready', message: null, recovery: null, persistence: 'saved', live: null },
    reviewNotice: 'Reference-checked against independent fixtures; not independently reviewed by a subject expert.',
    pendingReveal: null,
    permissions: { capture: true },
    ...overrides,
  };
}

function geometry(): LearnerProjection {
  // Fixture: a singular 2×2 matrix collapses the unit square to a segment; the test vector maps to the zero vector.
  const grid = Array.from({ length: 9 }, (_, i) => i - 4).flatMap(k => [
    { id: `v${k}`, from: [k, -4] as [number, number], to: [k, 4] as [number, number] },
    { id: `h${k}`, from: [-4, k] as [number, number], to: [4, k] as [number, number] },
  ]);
  const view: ProjectedView = {
    viewId: 'plane', kind: 'scene2d', title: 'Transformed plane', visibility: 'interactive', bounds: [-4, 4, -3, 3], equalAspect: true,
    description: 'Basis vectors, a test vector and the image of the unit square.',
    axes: { x: { label: 'x₁', unitLabel: 'm' }, y: { label: 'x₂', unitLabel: 'm' } },
    marks: [
      { markId: 'grid', kind: 'grid', label: 'Coordinate grid', style: style('muted', 'none', 'solid', 'thin'), interactive: false, geometry: { kind: 'segments2', segments: grid } },
      { markId: 'square', kind: 'polygon', label: 'Image of the unit square', style: style('secondary', 'none', 'solid', 'regular'), interactive: false, geometry: { kind: 'polygon2', vertices: [[0, 0], [1, 2], [2, 4], [1, 2]], degenerate: true } },
      { markId: 'e1', kind: 'arrow', label: 'M·e₁ (first column)', style: style('primary', 'none', 'solid', 'bold'), interactive: false, from: [0, 0], vector: [1, 2], text: 'M·e₁', placement: { anchor: 'e', offset: [6, 0], leader: false, maxWidthEm: 6 } },
      { markId: 'e2', kind: 'arrow', label: 'M·e₂ (second column)', style: style('accent', 'none', 'dashed', 'bold'), interactive: false, from: [0, 0], vector: [1.0001, 2.0002], text: 'M·e₂', placement: { anchor: 'e', offset: [6, 0], leader: false, maxWidthEm: 6 } },
      { markId: 'test', kind: 'arrow', label: 'M·v (image of the test vector)', style: style('negative', 'none', 'dotted', 'bold'), interactive: false, from: [0, 0], vector: [0, 0] },
      { markId: 'angle', kind: 'angle', label: 'Angle between the columns', style: style('reference', 'none', 'solid', 'thin'), interactive: false, at: [0, 0], from: [1, 2], to: [3, 0.5], value: value('angle', 'Angle', '54.5°') },
      { markId: 'probe', kind: 'point', label: 'Probe point p', style: style('positive', 'triangle', 'solid', 'bold'), interactive: true, at: [-2.5, 1.5], text: 'p (draggable)', draggable: { x: { parameter: 'px', min: -4, max: 4 }, y: { parameter: 'py', min: -3, max: 3 } } },
      { markId: 'far', kind: 'point', label: 'Image of the probe', style: style('warning', 'cross', 'solid', 'bold'), interactive: false, at: [7.5, 15], text: 'M·p' },
      { markId: 'crowd-a', kind: 'label', label: 'Label A', style: style('reference'), interactive: false, at: [-3, -2.2], text: 'det M = 0 (collapse)', placement: { anchor: 'ne', offset: [4, -4], leader: false, maxWidthEm: 9 } },
      { markId: 'crowd-b', kind: 'label', label: 'Label B', style: style('reference'), interactive: false, at: [-2.9, -2.1], text: 'area = |det M| = 0', placement: { anchor: 'ne', offset: [4, -4], leader: true, maxWidthEm: 9 } },
    ],
    values: [value('det', 'Determinant det M', '0', { reason: undefined }), value('area', 'Area scale |det M|', '0 m²'), undefinedValue('orientation', 'Orientation', 'A zero determinant has no orientation: the plane collapses to a line.')],
    equations: [{ equationId: 'det', label: 'Determinant', tex: '\\det M = m_{11} m_{22} - m_{12} m_{21} = 1\\cdot 4 - 2\\cdot 2 = 0', plain: 'det M = m11·m22 − m12·m21 = 1·4 − 2·2 = 0' }],
    summary: 'The columns M·e₁ = (1, 2) and M·e₂ = (1.0001, 2.0002) are almost parallel; the unit square collapses to a segment and the test vector maps to the zero vector.',
  };
  return base({
    title: 'Linear transformations: collapse and orientation', stage: { id: 'explore', kind: 'explore', instruction: 'Drag the probe point or type its coordinates. Notice what happens to the unit square when the determinant is zero.' },
    frame: { frameId: 'fixture-frame-g', kind: 'committed', position: { kind: 'static' }, terminal: false },
    views: [view], navigation: null, scenarios: [],
    controls: [
      { parameter: 'px', label: 'Probe x₁', description: 'First coordinate of the probe.', mode: 'interactive', value: -2.5, min: -4, max: 4, step: 0.1, integer: false, slider: true, exact: true, displayUnit: 'm', displayUnits: ['m', 'cm'], unitLabel: 'm', symbol: 'p₁', section: { id: 'probe', label: 'Probe point p' } },
      { parameter: 'py', label: 'Probe x₂', description: 'Second coordinate of the probe.', mode: 'interactive', value: 1.5, min: -3, max: 3, step: 0.1, integer: false, slider: true, exact: true, displayUnit: 'm', displayUnits: ['m', 'cm'], unitLabel: 'm', symbol: 'p₂', section: { id: 'probe', label: 'Probe point p' } },
    ],
    status: { ui: 'ready', message: null, recovery: null, persistence: 'saved', live: null },
  });
}

function spatial(): LearnerProjection {
  const view: ProjectedView = {
    viewId: 'space', kind: 'scene3d', title: 'Two vectors in space', visibility: 'interactive', bounds3: [-3, 3, -3, 3, -3, 3], equalAspect: true,
    description: 'Vectors u and v from the origin, and u × v.',
    axes: { x: { label: 'x', unitLabel: '' }, y: { label: 'y', unitLabel: '' }, z: { label: 'z', unitLabel: '' } },
    marks: [
      { markId: 'u', kind: 'arrow', label: 'Vector u', style: style('primary', 'none', 'solid', 'bold'), interactive: false, from: [0, 0, 0], vector: [2, 1, 0], text: 'u' },
      { markId: 'v', kind: 'arrow', label: 'Vector v', style: style('accent', 'none', 'dashed', 'bold'), interactive: false, from: [0, 0, 0], vector: [0, 1, 2], text: 'v' },
      { markId: 'cross', kind: 'arrow', label: 'Cross product u × v', style: style('secondary', 'none', 'dotted', 'bold'), interactive: false, from: [0, 0, 0], vector: [2, -4, 2], text: 'u × v' },
    ],
    values: [value('dot', 'Dot product u·v', '1'), value('angle', 'Angle between u and v', '78.5°', { unit: 'deg', unitLabel: '°' })],
    equations: [], summary: 'u = (2, 1, 0), v = (0, 1, 2); u × v = (2, −4, 2) follows the right-hand rule.',
  };
  return base({ title: 'Vector orientation in 3D', stage: { id: 'explore', kind: 'explore', instruction: 'Compare the projections of u, v and u × v on each coordinate plane.' }, frame: { frameId: 'fixture-frame-s', kind: 'committed', position: { kind: 'static' }, terminal: false }, views: [view], navigation: null, scenarios: [], controls: [] });
}

function long(): LearnerProjection {
  const projection = geometry();
  projection.title = 'An intentionally long activity title used to check that wrapping keeps the card readable at narrow widths without any horizontal page overflow';
  projection.stage.instruction = 'A deliberately long instruction: '.repeat(3) + 'every sentence must wrap within the card, and nothing should be clipped or hidden behind controls at 320 pixels.';
  projection.controls = projection.controls.map(control => ({ ...control, label: `${control.label} measured along the first principal axis of the transformed coordinate frame`, unitLabel: 'metres per second squared', displayUnit: 'm/s^2', displayUnits: ['m/s^2'] }));
  projection.views[0] = { ...projection.views[0], axes: { x: { label: 'Displacement along the first transformed axis', unitLabel: 'metres per second squared' }, y: { label: 'Displacement along the second transformed axis', unitLabel: 'metres per second squared' } } };
  return projection;
}

function extreme(): LearnerProjection {
  const projection = base();
  const readouts = projection.views.find(view => view.viewId === 'readouts')!;
  readouts.values = [
    value('negative', 'Negative position', '−13.5'), value('tiny', 'Tiny nonzero position', '1.25×10⁻¹²', { approximate: true }),
    value('huge', 'Large loss', '6.02×10²³'), value('underflow', 'Underflowed value', '≈ 0 (underflow)', { approximate: true, reason: 'Smaller than the smallest representable number; shown as an approximation, not an exact zero.' }),
    { ...undefinedValue('limit', 'Position at n = 1000', 'The sequence exceeds the representable range after n = 36.'), status: 'numerical-limit', text: 'Too large to represent' },
  ];
  const landscape = projection.views.find(view => view.viewId === 'trace-plot')!;
  landscape.bounds = [0, 12, -2e-12, 2e-12];
  landscape.marks = [{ ...landscape.marks[0], geometry: { kind: 'points2', points: Array.from({ length: 12 }, (_, n) => ({ id: `t${n}`, at: [n, 1.25e-12 * (-0.8) ** n] as [number, number] })) } }];
  landscape.summary = 'Tiny positions near 10⁻¹², alternating in sign and shrinking.';
  return projection;
}

/** Two kept runs of the quadratic (η = 0.75 kept at n = 3; η = 1.25 kept at n = 8), as the runtime projects them. */
function comparison(): LearnerProjection {
  const projection = base();
  const kept = (ordinal: number, eta: number, keptAt: number): ProjectedComparison => {
    const keptTrace = quadraticViews(2, eta, 4, keptAt).find(view => view.viewId === 'trace-plot')!.marks[0]!;
    const xs = iterates(2, eta, 4, keptAt + 1);
    const n = 3, current = iterates(2, 0.25, 4, n + 1)[n]!;
    return {
      runId: `run-${ordinal}`, label: `η = ${eta}, a = 2, x₀ = 4`, ordinal, name: `η = ${eta}`, alignment: 'index',
      parameterDifferences: [{ parameter: 'eta', label: 'Step size η', symbol: 'η', text: String(eta), currentText: '0.25' }],
      domainNote: 'Aligned by iteration index n: plots against n show both runs at the same n. Each run keeps its own range of steps.',
      frameId: `fixture-frame-kept-${ordinal}`, position: { kind: 'index', index: keptAt, maxIndex: 1000 }, positionText: `n = ${keptAt}`,
      boundary: keptAt < n ? `The kept run was kept at n = ${keptAt} and is not computed beyond it.` : null,
      values: [{ quantityId: 'position', label: 'Position x_n', current: value('position', 'Position x_n', fmt(current)), kept: value('position', 'Position x_n', fmt(xs[keptAt]!)) }],
      sameValues: 1,
      aligned: [{ viewId: 'trace-plot', label: 'Position x_n', at: n, current: fmt(current), kept: keptAt >= n ? fmt(xs[n]!) : null, ...(keptAt >= n ? {} : { reason: `The kept run was kept at n = ${keptAt} and is not computed beyond it.` }) }],
      overlays: [{ viewId: 'trace-plot', marks: [{ ...keptTrace, interactive: false }] }],
    };
  };
  return { ...projection, comparisons: [kept(1, 0.75, 3), kept(2, 1.25, 8)] };
}

const BUILDERS: Record<FixtureName, () => LearnerProjection> = { quadratic: () => base(), geometry, spatial, long, extreme, comparison };

/**
 * Applies a UI state to a fixture with the activity runtime's own status vocabulary (`UI_STATUS`, `TERMINAL_TEXT`,
 * `VALUE_STATUS_TEXT`, `HOST_SUSPENDED_MESSAGE`), so the lab shows exactly the words a real projection carries, plus
 * the content changes that state implies (what the runtime removes, a pending reveal, a tentative frame).
 */
export function fixtureProjection(name: FixtureName, state: UiState): LearnerProjection {
  const projection = BUILDERS[name]();
  const runtime = UI_STATUS[state];
  const status = (message: string | null = runtime.message, persistence: LearnerProjection['status']['persistence'] = 'saved', extra: Partial<LearnerProjection['status']> = {}): LearnerProjection['status'] =>
    ({ ...projection.status, ui: state, message, recovery: runtime.recovery ? { ...runtime.recovery } : null, persistence, ...extra });
  const nothing = { views: [], controls: [], scenarios: [], navigation: null, comparisons: [], alternatives: [] } satisfies Partial<LearnerProjection>;
  /**
   * What a blocked policy or revoked content leaves: no group is visible and nothing to navigate, while the frame
   * remains; the stage carries the runtime's neutral instruction with no response prompt, and no pending reveal is
   * presented (as the runtime projects it).
   */
  const hidden = (blocked: 'stale-policy' | 'unsupported') => ({
    views: [], controls: [], scenarios: [], navigation: null, comparisons: [], alternatives: [], pendingReveal: null,
    stage: { id: projection.stage.id, kind: projection.stage.kind, instruction: BLOCKED_INSTRUCTION[blocked] },
  }) satisfies Partial<LearnerProjection>;
  switch (state) {
    case 'empty': return { ...projection, ...nothing, frame: null, status: status() };
    case 'preparing': return { ...projection, ...nothing, frame: null, status: status() };
    case 'awaiting-persistence': return { ...projection, status: status(runtime.message, 'saving'), pendingReveal: { labels: ['Iteration trace', 'Current values'], state: 'requesting' } };
    case 'ready': return { ...projection, status: status(null) };
    case 'tentative-preview': return {
      ...projection, preview: { previewId: 'fixture-preview', parameter: projection.controls[0]?.parameter ?? 'eta' },
      frame: projection.frame && { ...projection.frame, kind: 'tentative', frameId: 'fixture-frame-tentative' },
      controls: projection.controls.map((control, i) => i === 0 ? { ...control, previewValue: Math.min(control.max, control.value + 0.5) } : control),
      status: status(),
    };
    case 'playing': return { ...projection, navigation: projection.navigation && { ...projection.navigation, playing: true }, status: status() };
    case 'paused': return { ...projection, status: status() };
    case 'boundary': {
      const views = name === 'quadratic' ? quadraticViews(2, 1, 4, 6) : projection.views;
      return {
        ...projection, views, controls: name === 'quadratic' ? quadraticControls(1, 2, 4) : projection.controls,
        frame: projection.frame && { ...projection.frame, terminal: true, terminalDetail: TERMINAL_TEXT['numerical-limit'] },
        navigation: projection.navigation && { ...projection.navigation, terminal: true, canStepForward: false },
        status: status(TERMINAL_TEXT['numerical-limit'], 'saved', { cause: 'numerical-limit' }),
      };
    }
    case 'undefined': {
      const views = name === 'quadratic' ? quadraticViews(2, 1.25, 4, 8, { undefinedTrace: true }) : projection.views;
      return { ...projection, views, status: status(VALUE_STATUS_TEXT['numerical-limit'], 'saved', { cause: 'numerical-limit' }) };
    }
    case 'clipped': {
      const views = (name === 'quadratic' ? quadraticViews(2, 1.25, 4, 8) : projection.views).map(view => view.kind === 'plot2d' || view.kind === 'scene2d' || view.kind === 'scene3d' ? { ...view, clipped: true } : view);
      return { ...projection, views, controls: name === 'quadratic' ? quadraticControls(1.25, 2, 4) : projection.controls, status: status() };
    }
    case 'unsupported': return { ...projection, ...hidden('unsupported'), status: status() };
    case 'recoverable-failure': return { ...projection, status: status() };
    // A revoked or changed policy hides every group (the runtime projects no content until the host acts).
    case 'stale-policy': return { ...projection, ...hidden('stale-policy'), status: status() };
    case 'suspended': return { ...projection, status: status(HOST_SUSPENDED_MESSAGE) };
    case 'restored': return { ...projection, status: status() };
    case 'disposed': return { ...projection, ...nothing, frame: null, status: status() };
  }
}
