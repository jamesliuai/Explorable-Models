/**
 * Activity template for the quadratic surface and gradient (report §6.1, §11, §12.5). Flow: get oriented with the
 * surface and its contour view → predict with the gradient hidden → explore the point with the gradient at p revealed
 * under an exposure receipt → explore the coefficients with the gradient field and the lowest point revealed (a
 * separate authorization; a host whose policy ceiling omits those groups never shows them) → explanation requested
 * through the host → closed. `free-explore` is a separately reachable stage for an authorized free-exploration
 * version. The 3D surface view (`scene3d`) and the contour view (`plot2d`, equal aspect, x right and y up) draw the
 * same identified frame; the camera is presentation state and no control or mark maps it to a model parameter.
 * Response requests reference host-owned task families only; this template carries no answers, rubrics or held-out
 * items.
 */
import type { ActivityTemplate, ContentGroup, MarkSpec, StageSpec } from '@explorable-models/activity';
import { modelIdentity } from '@explorable-models/core/model';
import { SURFACE_GRADIENT_COPY as COPY } from '../copy/quadratic-surface-gradient.js';
import { SURFACE_GRADIENT_PARAMETERS } from '../kernels/quadratic-surface-gradient.js';
import { quadraticSurfaceGradientManifest as manifest } from '../models/quadratic-surface-gradient.js';

/**
 * Browser tests that exercise each claimed equivalence (report §11): the spatial spec shared by both 3D activities. Each
 * alternative's ID after `#` is part of the title of the test that verifies it (checked by tests/player-3d).
 */
const VERIFIED_BY = 'tests/browser/study-spatial.spec.ts';

const group = (id: string, kind: ContentGroup['kind'], copy: { label: string; description: string }, solutionBearing: boolean, members: string[]): ContentGroup =>
  ({ id, kind, label: copy.label, description: copy.description, solutionBearing, members });

const mark = (spec: Omit<MarkSpec, 'style'> & { style: Partial<MarkSpec['style']> & Pick<MarkSpec['style'], 'role' | 'marker'> }): MarkSpec =>
  ({ ...spec, style: { dash: 'solid', weight: 'regular', ...spec.style } });

const citation = (id: string): string => {
  const source = manifest.sources.find(entry => entry.id === id);
  if (!source) throw new RangeError(`The quadratic-surface-gradient manifest has no source ${id}.`);
  return source.citation;
};
type Mode = 'interactive' | 'fixed';
const controls = (coefficients: Mode, point: Mode): Record<string, Mode> => ({ a: coefficients, b: coefficients, c: coefficients, px: point, py: point });
const label = (anchor: 'ne' | 'nw' | 'e', maxWidthEm: number) => ({ anchor, offset: [6, -6] as [number, number], leader: false, maxWidthEm });

/** Non-solution groups shown in every open stage: both linked views, the surface data, the point and the alternatives. */
const BASE = {
  scene: 'interactive', 'contour-view': 'interactive', 'section-views': 'fixed', surface: 'fixed', contours: 'fixed', 'cross-sections': 'fixed',
  point: 'fixed', 'surface-values': 'fixed', 'surface-rules': 'fixed', alternatives: 'fixed',
} as const;
const GRADIENT = { 'gradient-rules': 'fixed', gradient: 'fixed', 'gradient-drawing': 'fixed', 'gradient-values': 'fixed' } as const;
const FIELD = { field: 'fixed', minimum: 'fixed', 'minimum-values': 'fixed' } as const;
const SPATIAL_MARKS = ['surface-mesh', 'point-on-surface', 'gradient-arrow-3d'];
const SECTIONS = ['section-x', 'section-x-curve', 'section-y', 'section-y-curve'];
const SCENARIOS = {
  'default-bowl': [2, 0.5, 1, 1, 1],
  'round-bowl': [1, 0, 1, 1, 1],
  'stretched-bowl': [2, 0, 0.5, 1, 1],
  'tilted-bowl': [2, 1, 1, 1, 0],
  'narrow-tilted-bowl': [2, -1.8, 2, 1, 1],
  'point-at-origin': [2, 0.5, 1, 0, 0],
} as const satisfies Record<string, readonly [number, number, number, number, number]>;

export const quadraticSurfaceGradientTemplate: ActivityTemplate = {
  contract: 'study-harness.activity-template',
  schemaVersion: '1.0',
  templateId: 'quadratic-surface-gradient',
  version: '1.0.0',
  model: { modelId: manifest.modelId, version: manifest.version, digest: modelIdentity(manifest).digest },
  title: COPY.title,
  purpose: COPY.purpose,
  dimension: '3d',
  locale: 'en',
  requires: [...manifest.capabilities],
  groups: [
    group('scene', 'view', COPY.groups.scene, false, ['surface-view']),
    group('contour-view', 'view', COPY.groups.contourView, false, ['contour-plot']),
    group('section-views', 'view', COPY.groups.sectionViews, false, ['section-x', 'section-y']),
    group('surface', 'dataset', COPY.groups.surface, false, ['surface']),
    group('contours', 'dataset', COPY.groups.contours, false, ['contours']),
    group('cross-sections', 'dataset', COPY.groups.crossSections, false, ['cross-section-x', 'cross-section-y']),
    group('point', 'dataset', COPY.groups.point, false, ['point-2d', 'point-3d']),
    group('surface-values', 'quantity', COPY.groups.surfaceValues, false, ['point', 'value', 'hessian.det']),
    group('surface-rules', 'equation', COPY.groups.surfaceRules, false, ['surface-definition', 'positive-definite-condition', 'section-rules']),
    group('gradient-rules', 'equation', COPY.groups.gradientRules, false, ['gradient-definition', 'direction-definition']),
    group('gradient', 'quantity', COPY.groups.gradient, true, ['gradient', 'gradient.norm', 'gradient.direction', 'arrow.scale']),
    group('gradient-drawing', 'dataset', COPY.groups.gradientDrawing, true, ['gradient-2d', 'gradient-3d']),
    group('gradient-values', 'equation', COPY.groups.gradientValues, true, ['gradient-value', 'direction-value']),
    group('field', 'dataset', COPY.groups.field, true, ['field']),
    group('minimum', 'quantity', COPY.groups.minimum, true, ['minimum.location', 'minimum.value']),
    group('minimum-values', 'equation', COPY.groups.minimumValues, true, ['minimum-value']),
    group('coefficient-controls', 'control', COPY.groups.coefficientControls, false, ['a', 'b', 'c']),
    group('point-controls', 'control', COPY.groups.pointControls, false, ['px', 'py']),
    group('scenarios', 'annotation', COPY.groups.scenarios, false, ['scenario-note']),
    group('alternatives', 'alternative', COPY.groups.alternatives, false, [
      'without-webgl', 'contour-projection-gradient', 'contour-projection-shape', 'equation-values', 'value-table', 'field-table', 'section-tables',
      'text-description', 'exact-entry', 'keyboard-controls',
    ]),
  ],
  views: [
    {
      id: 'surface-view', kind: 'scene3d', group: 'scene', ...COPY.views.surface,
      bounds3: [-2.5, 2.5, -2.5, 2.5, 0, 24], equalAspect: false,
      axes: { x: { label: 'x', unit: 'dimensionless' }, y: { label: 'y', unit: 'dimensionless' }, z: { label: 'f(x, y)', unit: 'dimensionless' } },
      marks: [
        mark({ id: 'surface-mesh', kind: 'surface', group: 'surface', label: COPY.marks.surface, bindings: { geometry: 'surface' }, style: { role: 'muted', marker: 'none', weight: 'thin' } }),
        mark({
          id: 'point-on-surface', kind: 'point', group: 'point', label: COPY.marks.pointOnSurface, bindings: { geometry: 'point-3d' }, style: { role: 'primary', marker: 'circle', weight: 'bold' },
          text: 'p', placement: label('ne', 3),
        }),
        mark({
          id: 'gradient-arrow-3d', kind: 'segment', group: 'gradient-drawing', label: COPY.marks.gradient3d, bindings: { geometry: 'gradient-3d' }, style: { role: 'accent', marker: 'triangle', weight: 'bold' },
          text: '∇f(p)', placement: label('e', 5),
        }),
      ],
    },
    {
      id: 'contour-plot', kind: 'plot2d', group: 'contour-view', ...COPY.views.contour,
      bounds: [-3.25, 3.25, -3.25, 3.25], equalAspect: true,
      axes: { x: { label: 'x', unit: 'dimensionless' }, y: { label: 'y', unit: 'dimensionless' } },
      marks: [
        mark({ id: 'contour-lines', kind: 'curve', group: 'contours', label: COPY.marks.contours, bindings: { geometry: 'contours' }, style: { role: 'muted', marker: 'none', weight: 'thin' } }),
        mark({ id: 'field-arrows', kind: 'vector-field', group: 'field', label: COPY.marks.field, bindings: { geometry: 'field' }, style: { role: 'secondary', marker: 'triangle', weight: 'thin' } }),
        mark({
          id: 'gradient-arrow', kind: 'segment', group: 'gradient-drawing', label: COPY.marks.gradient2d, bindings: { geometry: 'gradient-2d' }, style: { role: 'accent', marker: 'triangle', weight: 'bold' },
          text: '∇f(p)', placement: label('e', 5),
        }),
        mark({
          id: 'point-marker', kind: 'point', group: 'point', label: COPY.marks.point2d, bindings: { geometry: 'point-2d' }, style: { role: 'primary', marker: 'circle', weight: 'bold' },
          text: 'p', placement: label('nw', 3), drag: { x: 'px', y: 'py' },
        }),
        mark({ id: 'minimum-marker', kind: 'point', group: 'minimum', label: COPY.marks.minimum, bindings: { at: 'minimum.location' }, style: { role: 'reference', marker: 'cross' } }),
      ],
    },
    {
      id: 'section-x', kind: 'plot2d', group: 'section-views', ...COPY.views.sectionX, bounds: [-2, 2, -0.5, 8.5], equalAspect: false,
      axes: { x: { label: 'x', unit: 'dimensionless' }, y: { label: 'f(x, 0)', unit: 'dimensionless' } },
      marks: [mark({ id: 'section-x-curve', kind: 'curve', group: 'cross-sections', label: COPY.marks.sectionX, bindings: { geometry: 'cross-section-x' }, style: { role: 'primary', marker: 'none' } })],
    },
    {
      id: 'section-y', kind: 'plot2d', group: 'section-views', ...COPY.views.sectionY, bounds: [-2, 2, -0.5, 8.5], equalAspect: false,
      axes: { x: { label: 'y', unit: 'dimensionless' }, y: { label: 'f(0, y)', unit: 'dimensionless' } },
      marks: [mark({ id: 'section-y-curve', kind: 'curve', group: 'cross-sections', label: COPY.marks.sectionY, bindings: { geometry: 'cross-section-y' }, style: { role: 'primary', marker: 'none', dash: 'dashed' } })],
    },
    {
      id: 'readouts', kind: 'values', group: 'surface-values', ...COPY.views.readouts, equalAspect: false, marks: [],
      quantities: ['point', 'value', 'hessian.det', 'gradient', 'gradient.norm', 'gradient.direction', 'arrow.scale', 'minimum.location', 'minimum.value'],
    },
    {
      id: 'rules', kind: 'equation', group: 'surface-rules', ...COPY.views.rules, equalAspect: false, marks: [],
      equations: ['surface-definition', 'positive-definite-condition', 'section-rules', 'gradient-definition', 'direction-definition', 'gradient-value', 'direction-value', 'minimum-value'],
    },
    {
      id: 'value-table', kind: 'table', group: 'surface-values', ...COPY.views.valueTable, equalAspect: false, marks: [],
      quantities: ['point', 'value', 'hessian.det', 'gradient', 'gradient.norm', 'gradient.direction', 'arrow.scale', 'minimum.location', 'minimum.value'],
    },
    {
      id: 'field-table', kind: 'table', group: 'field', ...COPY.views.fieldTable, equalAspect: false, marks: [], rowsFrom: 'field',
      axes: { x: { label: 'x', unit: 'dimensionless' }, y: { label: 'y', unit: 'dimensionless' } },
    },
    {
      id: 'section-x-table', kind: 'table', group: 'cross-sections', ...COPY.views.sectionXTable, equalAspect: false, marks: [], rowsFrom: 'cross-section-x',
      axes: { x: { label: 'x', unit: 'dimensionless' }, y: { label: 'f(x, 0)', unit: 'dimensionless' } },
    },
    {
      id: 'section-y-table', kind: 'table', group: 'cross-sections', ...COPY.views.sectionYTable, equalAspect: false, marks: [], rowsFrom: 'cross-section-y',
      axes: { x: { label: 'y', unit: 'dimensionless' }, y: { label: 'f(0, y)', unit: 'dimensionless' } },
    },
  ],
  controls: SURFACE_GRADIENT_PARAMETERS.map(parameter => ({
    parameter, group: parameter.startsWith('p') ? 'point-controls' : 'coefficient-controls', ...COPY.controls[parameter],
    displayUnits: ['dimensionless'], slider: true, exact: true, step: 0.1, section: parameter.startsWith('p') ? COPY.sections.point : COPY.sections.coefficients,
  })),
  scenarios: Object.entries(SCENARIOS).map(([id, [a, b, c, px, py]]) => ({ id, ...COPY.scenario(a, b, c, px, py), parameters: { a, b, c, px, py }, group: 'scenarios' })),
  equations: [
    { id: 'surface-definition', group: 'surface-rules', label: 'Surface', tex: 'f(x, y) = \\tfrac{1}{2}\\left(a x^{2} + 2 b\\, x y + c\\, y^{2}\\right)', plain: 'f(x, y) = (a·x² + 2b·x·y + c·y²)/2' },
    { id: 'positive-definite-condition', group: 'surface-rules', label: 'Condition on the coefficients', tex: 'a > 0, \\quad c > 0, \\quad a c - b^{2} > 0', plain: 'a > 0, c > 0 and a·c − b² > 0' },
    { id: 'section-rules', group: 'surface-rules', label: 'Cross-sections along the axes', tex: 'f(x, 0) = \\tfrac{a}{2}\\, x^{2}, \\quad f(0, y) = \\tfrac{c}{2}\\, y^{2}', plain: 'f(x, 0) = (a/2)·x² and f(0, y) = (c/2)·y²' },
    { id: 'gradient-definition', group: 'gradient-rules', label: 'Gradient', tex: '\\nabla f(x, y) = \\left(\\frac{\\partial f}{\\partial x}, \\frac{\\partial f}{\\partial y}\\right) = \\left(a x + b y,\\; b x + c y\\right)', plain: '∇f(x, y) = (∂f/∂x, ∂f/∂y) = (a·x + b·y, b·x + c·y)' },
    { id: 'direction-definition', group: 'gradient-rules', label: 'Direction of the gradient', tex: '\\hat{u} = \\frac{\\nabla f}{\\lvert \\nabla f \\rvert}, \\quad \\text{undefined where } \\nabla f = 0', plain: 'û = ∇f/|∇f|, undefined where ∇f = 0' },
    { id: 'gradient-value', group: 'gradient-values', label: 'Gradient at p now', tex: '\\nabla f(p) = {{q:gradient}}, \\quad \\lvert \\nabla f(p) \\rvert = {{q:gradient.norm}}', plain: '∇f(p) = {{q:gradient}}, |∇f(p)| = {{q:gradient.norm}}' },
    { id: 'direction-value', group: 'gradient-values', label: 'Direction at p now', tex: '\\hat{u} = {{q:gradient.direction}}', plain: 'û = {{q:gradient.direction}}' },
    { id: 'minimum-value', group: 'minimum-values', label: 'Lowest point', tex: '\\text{lowest point } {{q:minimum.location}}, \\quad f = {{q:minimum.value}}', plain: 'Lowest point {{q:minimum.location}}, where f = {{q:minimum.value}}' },
  ],
  stages: [
    {
      id: 'orient', kind: 'prepare', instruction: COPY.stages.orient.instruction,
      visible: { ...BASE, 'coefficient-controls': 'fixed', 'point-controls': 'fixed' }, controls: controls('fixed', 'fixed'),
      allowsPreview: false, allowsPlayback: false, allowsNavigation: false,
    },
    {
      id: 'predict', kind: 'predict', instruction: COPY.stages.predict.instruction,
      visible: { ...BASE, 'coefficient-controls': 'fixed', 'point-controls': 'fixed' }, controls: controls('fixed', 'fixed'),
      allowsPreview: false, allowsPlayback: false, allowsNavigation: false,
      response: { kind: 'prediction', prompt: COPY.stages.predict.prompt, taskFamily: 'surface-gradient-prediction' },
    },
    {
      id: 'explore-point', kind: 'explore', instruction: COPY.stages.explorePoint.instruction,
      visible: { ...BASE, point: 'interactive', 'coefficient-controls': 'fixed', 'point-controls': 'interactive', ...GRADIENT }, controls: controls('fixed', 'interactive'),
      allowsPreview: true, allowsPlayback: false, allowsNavigation: false,
    },
    {
      id: 'explore-field', kind: 'explore', instruction: COPY.stages.exploreField.instruction,
      visible: { ...BASE, point: 'interactive', 'coefficient-controls': 'interactive', 'point-controls': 'interactive', ...GRADIENT, ...FIELD, scenarios: 'interactive' },
      controls: controls('interactive', 'interactive'), allowsPreview: true, allowsPlayback: false, allowsNavigation: false,
    },
    {
      id: 'explain', kind: 'explain', instruction: COPY.stages.explain.instruction,
      visible: { ...BASE, 'coefficient-controls': 'fixed', 'point-controls': 'fixed', ...GRADIENT, ...FIELD }, controls: controls('fixed', 'fixed'),
      allowsPreview: false, allowsPlayback: false, allowsNavigation: false,
      response: { kind: 'explanation', prompt: COPY.stages.explain.prompt, taskFamily: 'surface-gradient-explanation' },
    },
    { id: 'closed', kind: 'closed', instruction: COPY.stages.closed.instruction, visible: {}, controls: {}, allowsPreview: false, allowsPlayback: false, allowsNavigation: false } satisfies StageSpec,
    {
      id: 'free-explore', kind: 'explore', instruction: COPY.stages.freeExplore.instruction,
      visible: { ...BASE, 'section-views': 'interactive', point: 'interactive', 'coefficient-controls': 'interactive', 'point-controls': 'interactive', ...GRADIENT, ...FIELD, scenarios: 'interactive' },
      controls: controls('interactive', 'interactive'), allowsPreview: true, allowsPlayback: false, allowsNavigation: false,
    },
  ],
  transitions: [
    { id: 'start-prediction', from: 'orient', to: 'predict', label: 'Continue to the prediction' },
    { id: 'show-gradient', from: 'predict', to: 'explore-point', label: 'Show the gradient at the point and explore' },
    { id: 'show-field', from: 'explore-point', to: 'explore-field', label: 'Show the gradient field and the coefficient controls' },
    { id: 'request-explanation', from: 'explore-field', to: 'explain', label: 'Ask for an explanation' },
    { id: 'request-explanation-early', from: 'explore-point', to: 'explain', label: 'Ask for an explanation without the field stage' },
    { id: 'close-after-explanation', from: 'explain', to: 'closed', label: 'Close the activity' },
    { id: 'close-from-orientation', from: 'orient', to: 'closed', label: 'Close the activity' },
    { id: 'close-from-prediction', from: 'predict', to: 'closed', label: 'Close the activity' },
    { id: 'close-from-point-exploration', from: 'explore-point', to: 'closed', label: 'Close the activity' },
    { id: 'close-from-field-exploration', from: 'explore-field', to: 'closed', label: 'Close the activity' },
    { id: 'close-from-free-exploration', from: 'free-explore', to: 'closed', label: 'Close the activity' },
  ],
  initialStage: 'orient',
  alternatives: [
    {
      id: 'without-webgl', kind: 'alternative-activity', group: 'alternatives', ...COPY.alternatives.withoutWebgl,
      covers: ['surface-view', ...SPATIAL_MARKS], equivalence: 'alternative-activity', verifiedBy: `${VERIFIED_BY}#no-webgl-completion`,
    },
    {
      id: 'contour-projection-gradient', kind: 'projection-2d', group: 'alternatives', ...COPY.alternatives.projectionGradient,
      covers: ['point-on-surface', 'gradient-arrow-3d'], equivalence: 'equivalent', verifiedBy: `${VERIFIED_BY}#contour-projection-gradient`,
    },
    {
      id: 'contour-projection-shape', kind: 'projection-2d', group: 'alternatives', ...COPY.alternatives.projectionShape,
      covers: ['surface-view', 'surface-mesh'], equivalence: 'partial', verifiedBy: `${VERIFIED_BY}#contour-projection-shape`,
    },
    {
      id: 'equation-values', kind: 'description', group: 'alternatives', ...COPY.alternatives.equationValues,
      covers: ['contour-plot', 'contour-lines', 'field-arrows', 'gradient-arrow', 'point-marker', 'minimum-marker', ...SECTIONS], equivalence: 'equivalent', verifiedBy: `${VERIFIED_BY}#equation-values-equivalent`,
    },
    {
      id: 'value-table', kind: 'table', group: 'alternatives', ...COPY.alternatives.valueTable,
      covers: ['point-marker', 'gradient-arrow', 'minimum-marker', 'point-on-surface', 'gradient-arrow-3d'], equivalence: 'equivalent', verifiedBy: `${VERIFIED_BY}#value-table-equivalent`,
    },
    { id: 'field-table', kind: 'table', group: 'alternatives', ...COPY.alternatives.fieldTable, covers: ['field-arrows'], equivalence: 'equivalent', verifiedBy: `${VERIFIED_BY}#field-table-equivalent` },
    { id: 'section-tables', kind: 'table', group: 'alternatives', ...COPY.alternatives.sectionTables, covers: SECTIONS, equivalence: 'equivalent', verifiedBy: `${VERIFIED_BY}#section-tables-equivalent` },
    { id: 'text-description', kind: 'description', group: 'alternatives', ...COPY.alternatives.textDescription, covers: ['surface-view', 'contour-plot', 'section-x', 'section-y'], equivalence: 'partial', verifiedBy: `${VERIFIED_BY}#text-description` },
    { id: 'exact-entry', kind: 'numeric-entry', group: 'alternatives', ...COPY.alternatives.exactEntry, covers: [...SURFACE_GRADIENT_PARAMETERS], equivalence: 'equivalent', verifiedBy: `${VERIFIED_BY}#exact-entry` },
    {
      id: 'keyboard-controls', kind: 'keyboard', group: 'alternatives', ...COPY.alternatives.keyboard,
      covers: [...SURFACE_GRADIENT_PARAMETERS, 'point-marker'], equivalence: 'equivalent', verifiedBy: `${VERIFIED_BY}#keyboard-only`,
    },
  ],
  taskFamilies: [
    { id: 'surface-gradient-prediction', description: 'Host-owned prediction request about the gradient of a quadratic surface at a marked point and its relation to the contour lines. The host owns the response, its capture and any evaluation.', hostOwned: true },
    { id: 'surface-gradient-explanation', description: 'Host-owned explanation request about how the gradient relates to contour lines and to the coefficients a, b and c. The host owns the response, its capture and any evaluation.', hostOwned: true },
    { id: 'surface-gradient-later-task', description: 'Host-owned later task with new coefficients, a new point or another representation, such as a contour-only or table-only version. Its prompts, held-out items and scoring stay with the host and are not part of this catalogue.', hostOwned: true },
  ],
  content: [
    { id: 'derivation-quadratic-form', kind: 'derivation', text: citation('derivation-quadratic-form') },
    { id: 'assumptions', kind: 'assumption', text: manifest.interpretation.assumptions.join(' ') },
    { id: 'source-specification', kind: 'source', text: citation('study-harness-specification') },
    { id: 'scenario-note', kind: 'learner-copy', text: COPY.scenarioNote },
  ],
};
