/**
 * Activity template for spatial vector orientation (report §6.1, §11, §12.4). Flow: get oriented in the 3D frame →
 * predict with angle, dot and cross product hidden → explore with the angle and dot product revealed under an
 * exposure receipt → add the cross product (separately authorized) → explanation requested through the host → closed.
 * `free-explore` is a separately reachable stage for an authorized free-exploration version. The 3D scene has a
 * complete path without WebGL (projections, tables, values and exact entry), recorded as an alternative activity
 * rather than claimed as the same spatial experience. Response requests reference host-owned task families only; this
 * template carries no answers, rubrics or held-out items.
 */
import type { ActivityTemplate, ContentGroup, MarkSpec, StageSpec } from '@explorable-models/activity';
import { modelIdentity } from '@explorable-models/core/model';
import { VECTOR_ORIENTATION_COPY as COPY } from '../copy/vector-orientation-3d.js';
import { VECTOR_ORIENTATION_PARAMETERS } from '../kernels/vector-orientation-3d.js';
import { vectorOrientationManifest as manifest } from '../models/vector-orientation-3d.js';

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
  if (!source) throw new RangeError(`The vector-orientation manifest has no source ${id}.`);
  return source.citation;
};
const controlsAll = (mode: 'interactive' | 'fixed'): Record<string, 'interactive' | 'fixed'> => Object.fromEntries(VECTOR_ORIENTATION_PARAMETERS.map(id => [id, mode]));
const vectors = (u: [number, number, number], v: [number, number, number]): Record<string, number> =>
  ({ ux: u[0], uy: u[1], uz: u[2], vx: v[0], vy: v[1], vz: v[2] });

/** Non-solution groups shown in every open stage: the drawn vectors, their coordinates and the alternatives. */
const BASE = { space: 'interactive', projections: 'fixed', vectors: 'fixed', components: 'fixed', lengths: 'fixed', alternatives: 'fixed' } as const;
const ANGLE = { 'angle-dot': 'fixed', 'angle-arc': 'fixed', 'dot-rules': 'fixed', 'dot-values': 'fixed' } as const;
const CROSS = { cross: 'fixed', 'cross-drawing': 'fixed', 'cross-rules': 'fixed', 'cross-values': 'fixed' } as const;
const SPACE_MARKS = ['vector-segments', 'angle-arc-curve', 'cross-segment', 'cross-direction-arrow'];
const PLANES = [['xy', 'planeXY'], ['xz', 'planeXZ'], ['yz', 'planeYZ']] as const;
const AXIS_NAMES = { xy: ['x', 'y'], xz: ['x', 'z'], yz: ['y', 'z'] } as const;
const SCENARIOS = {
  'basis-x-y': vectors([1, 0, 0], [0, 1, 0]),
  'basis-y-x': vectors([0, 1, 0], [1, 0, 0]),
  'pair-a': vectors([1, 2, 2], [1.5, 3, 3]),
  'pair-b': vectors([1, 2, 2], [-1.5, -3, -3]),
  'pair-c': vectors([1, 2, 2], [2, 1, -2]),
  'pair-d': vectors([2, 1, 0], [1, 2, 2]),
  'pair-e': vectors([0, 0, 0], [1, 2, 2]),
} as const satisfies Record<keyof typeof COPY.scenarios, Record<string, number>>;

export const vectorOrientationTemplate: ActivityTemplate = {
  contract: 'study-harness.activity-template',
  schemaVersion: '1.0',
  templateId: 'vector-orientation-3d',
  version: '1.0.0',
  model: { modelId: manifest.modelId, version: manifest.version, digest: modelIdentity(manifest).digest },
  title: COPY.title,
  purpose: COPY.purpose,
  dimension: '3d',
  locale: 'en',
  requires: [...manifest.capabilities],
  groups: [
    group('space', 'view', COPY.groups.space, false, ['space']),
    group('projections', 'view', COPY.groups.projections, false, ['plane-xy', 'plane-xz', 'plane-yz']),
    group('vectors', 'dataset', COPY.groups.vectors, false, ['vectors', 'projection-xy', 'projection-xz', 'projection-yz']),
    group('components', 'quantity', COPY.groups.components, false, ['u', 'v', 'u.xy', 'v.xy', 'u.xz', 'v.xz', 'u.yz', 'v.yz']),
    group('lengths', 'quantity', COPY.groups.lengths, false, ['u.norm', 'v.norm']),
    group('controls-u', 'control', COPY.groups.controlsU, false, ['ux', 'uy', 'uz']),
    group('controls-v', 'control', COPY.groups.controlsV, false, ['vx', 'vy', 'vz']),
    group('angle-dot', 'quantity', COPY.groups.angleDot, true, ['dot', 'angle', 'relationship']),
    group('angle-arc', 'dataset', COPY.groups.angleArc, true, ['angle-arc']),
    group('dot-rules', 'equation', COPY.groups.dotRules, false, ['dot-definition', 'angle-definition']),
    group('dot-values', 'equation', COPY.groups.dotValues, true, ['dot-value', 'angle-value']),
    group('cross', 'quantity', COPY.groups.cross, true, ['cross', 'cross.norm', 'cross.direction']),
    group('cross-drawing', 'dataset', COPY.groups.crossDrawing, true, ['cross']),
    group('cross-rules', 'equation', COPY.groups.crossRules, false, ['cross-definition', 'cross-length', 'handedness']),
    group('cross-values', 'equation', COPY.groups.crossValues, true, ['cross-value', 'direction-value']),
    group('scenarios', 'annotation', COPY.groups.scenarios, false, ['scenario-note']),
    group('alternatives', 'alternative', COPY.groups.alternatives, false, ['without-webgl', 'projection-views', 'projection-table', 'text-description', 'exact-entry', 'keyboard-controls']),
  ],
  views: [
    {
      id: 'space', kind: 'scene3d', group: 'space', title: COPY.views.space.title, description: COPY.views.space.description,
      // The teaching box holds every allowed u and v (components in [−3, 3]) with room for their arrowheads and matches
      // the ±4 projections; u × v is drawn at true scale and can extend past it (the renderer discloses that).
      bounds3: [-4, 4, -4, 4, -4, 4], equalAspect: true,
      axes: { x: { label: 'x', unit: 'dimensionless' }, y: { label: 'y', unit: 'dimensionless' }, z: { label: 'z', unit: 'dimensionless' } },
      marks: [
        mark({ id: 'vector-segments', kind: 'segments', group: 'vectors', label: COPY.marks.vectors, bindings: { geometry: 'vectors' }, style: { role: 'primary', marker: 'triangle', weight: 'bold' } }),
        mark({
          id: 'angle-arc-curve', kind: 'curve', group: 'angle-arc', label: COPY.marks.angleArc, bindings: { geometry: 'angle-arc' }, style: { role: 'muted', marker: 'none', dash: 'dotted', weight: 'thin' },
          text: 'θ', placement: { anchor: 'ne', offset: [6, -6], leader: false, maxWidthEm: 3 },
        }),
        mark({
          id: 'cross-segment', kind: 'segment', group: 'cross-drawing', label: COPY.marks.crossSegment, bindings: { geometry: 'cross' }, style: { role: 'accent', marker: 'triangle', dash: 'dashed', weight: 'bold' },
          text: 'u × v', placement: { anchor: 'e', offset: [8, 0], leader: true, maxWidthEm: 6 },
        }),
        mark({ id: 'cross-direction-arrow', kind: 'arrow', group: 'cross', label: COPY.marks.crossDirection, bindings: { vector: 'cross.direction' }, style: { role: 'accent', marker: 'diamond', dash: 'dotted' } }),
      ],
    },
    ...PLANES.map(([plane, key]) => ({
      id: `plane-${plane}`, kind: 'plot2d' as const, group: 'projections', title: COPY.views[key].title, description: COPY.views[key].description,
      bounds: [-4, 4, -4, 4] as [number, number, number, number], equalAspect: true,
      axes: { x: { label: AXIS_NAMES[plane][0], unit: 'dimensionless' as const }, y: { label: AXIS_NAMES[plane][1], unit: 'dimensionless' as const } },
      marks: [mark({ id: `projection-${plane}-segments`, kind: 'segments', group: 'vectors', label: COPY.marks.projection(plane), bindings: { geometry: `projection-${plane}` }, style: { role: 'primary', marker: 'triangle', weight: 'bold' } })],
    })),
    {
      id: 'readouts', kind: 'values', group: 'components', title: COPY.views.readouts.title, description: COPY.views.readouts.description,
      equalAspect: false, marks: [], quantities: ['u.norm', 'v.norm', 'dot', 'angle', 'relationship', 'cross.norm'],
    },
    {
      id: 'vector-table', kind: 'table', group: 'components', title: COPY.views.vectorTable.title, description: COPY.views.vectorTable.description,
      equalAspect: false, marks: [], quantities: ['u', 'v', 'cross', 'cross.direction'],
    },
    {
      id: 'projection-table', kind: 'table', group: 'components', title: COPY.views.projectionTable.title, description: COPY.views.projectionTable.description,
      equalAspect: false, marks: [], quantities: ['u.xy', 'v.xy', 'u.xz', 'v.xz', 'u.yz', 'v.yz'],
    },
    {
      id: 'rules', kind: 'equation', group: 'dot-rules', title: COPY.views.rules.title, description: COPY.views.rules.description,
      equalAspect: false, marks: [], equations: ['dot-definition', 'angle-definition', 'dot-value', 'angle-value', 'cross-definition', 'cross-length', 'handedness', 'cross-value', 'direction-value'],
    },
  ],
  controls: VECTOR_ORIENTATION_PARAMETERS.map(parameter => ({
    parameter, group: parameter.startsWith('u') ? 'controls-u' : 'controls-v', ...COPY.controls.component(parameter[0]!, parameter[1]!),
    displayUnits: ['dimensionless'], slider: true, exact: true, step: 0.5, section: parameter.startsWith('u') ? COPY.sections.u : COPY.sections.v,
  })),
  scenarios: Object.entries(SCENARIOS).map(([id, parameters]) => ({ id, ...COPY.scenarios[id as keyof typeof SCENARIOS], parameters: { ...parameters }, group: 'scenarios' })),
  equations: [
    { id: 'dot-definition', group: 'dot-rules', label: 'Dot product', tex: 'u \\cdot v = u_x v_x + u_y v_y + u_z v_z = |u|\\,|v|\\cos\\theta', plain: 'u·v = u_x·v_x + u_y·v_y + u_z·v_z = |u|·|v|·cos θ' },
    { id: 'angle-definition', group: 'dot-rules', label: 'Angle between u and v', tex: '\\cos\\theta = \\frac{u \\cdot v}{|u|\\,|v|}, \\quad 0 \\le \\theta \\le \\pi', plain: 'cos θ = (u·v)/(|u|·|v|), with 0 ≤ θ ≤ π; θ is undefined when u or v is the zero vector' },
    { id: 'dot-value', group: 'dot-values', label: 'Dot product now', tex: 'u \\cdot v = {{q:dot}}', plain: 'u·v = {{q:dot}}' },
    { id: 'angle-value', group: 'dot-values', label: 'Angle now', tex: '\\theta = {{q:angle}}', plain: 'θ = {{q:angle}}' },
    { id: 'cross-definition', group: 'cross-rules', label: 'Cross product', tex: 'u \\times v = (u_y v_z - u_z v_y,\\; u_z v_x - u_x v_z,\\; u_x v_y - u_y v_x)', plain: 'u × v = (u_y·v_z − u_z·v_y, u_z·v_x − u_x·v_z, u_x·v_y − u_y·v_x)' },
    { id: 'cross-length', group: 'cross-rules', label: 'Length of the cross product', tex: '|u \\times v| = |u|\\,|v|\\sin\\theta', plain: '|u × v| = |u|·|v|·sin θ' },
    { id: 'handedness', group: 'cross-rules', label: 'Right-handed frame', tex: 'e_x \\times e_y = e_z, \\quad v \\times u = -(u \\times v)', plain: 'e_x × e_y = e_z (right-handed frame), and v × u = −(u × v)' },
    { id: 'cross-value', group: 'cross-values', label: 'Cross product now', tex: 'u \\times v = {{q:cross}}, \\quad |u \\times v| = {{q:cross.norm}}', plain: 'u × v = {{q:cross}}, |u × v| = {{q:cross.norm}}' },
    { id: 'direction-value', group: 'cross-values', label: 'Direction of the cross product now', tex: '\\hat{n} = \\frac{u \\times v}{|u \\times v|} = {{q:cross.direction}}', plain: 'n̂ = (u × v)/|u × v| = {{q:cross.direction}}' },
  ],
  stages: [
    {
      id: 'orient', kind: 'prepare', instruction: COPY.stages.orient.instruction,
      visible: { ...BASE, 'controls-u': 'fixed', 'controls-v': 'fixed' }, controls: controlsAll('fixed'), allowsPreview: false, allowsPlayback: false, allowsNavigation: false,
    },
    {
      id: 'predict', kind: 'predict', instruction: COPY.stages.predict.instruction,
      visible: { ...BASE, 'controls-u': 'fixed', 'controls-v': 'fixed' }, controls: controlsAll('fixed'), allowsPreview: false, allowsPlayback: false, allowsNavigation: false,
      response: { kind: 'prediction', prompt: COPY.stages.predict.prompt, taskFamily: 'vector-orientation-prediction' },
    },
    {
      id: 'explore-angle', kind: 'explore', instruction: COPY.stages.exploreAngle.instruction,
      visible: { ...BASE, 'controls-u': 'interactive', 'controls-v': 'interactive', ...ANGLE, scenarios: 'interactive' },
      controls: controlsAll('interactive'), allowsPreview: true, allowsPlayback: false, allowsNavigation: false,
    },
    {
      id: 'explore-cross', kind: 'explore', instruction: COPY.stages.exploreCross.instruction,
      visible: { ...BASE, 'controls-u': 'interactive', 'controls-v': 'interactive', ...ANGLE, ...CROSS, scenarios: 'interactive' },
      controls: controlsAll('interactive'), allowsPreview: true, allowsPlayback: false, allowsNavigation: false,
    },
    {
      id: 'explain', kind: 'explain', instruction: COPY.stages.explain.instruction,
      visible: { ...BASE, 'controls-u': 'fixed', 'controls-v': 'fixed', ...ANGLE, ...CROSS }, controls: controlsAll('fixed'), allowsPreview: false, allowsPlayback: false, allowsNavigation: false,
      response: { kind: 'explanation', prompt: COPY.stages.explain.prompt, taskFamily: 'vector-orientation-explanation' },
    },
    { id: 'closed', kind: 'closed', instruction: COPY.stages.closed.instruction, visible: {}, controls: {}, allowsPreview: false, allowsPlayback: false, allowsNavigation: false } satisfies StageSpec,
    {
      id: 'free-explore', kind: 'explore', instruction: COPY.stages.freeExplore.instruction,
      visible: { ...BASE, projections: 'interactive', 'controls-u': 'interactive', 'controls-v': 'interactive', ...ANGLE, ...CROSS, scenarios: 'interactive' },
      controls: controlsAll('interactive'), allowsPreview: true, allowsPlayback: false, allowsNavigation: false,
    },
  ],
  transitions: [
    { id: 'start-prediction', from: 'orient', to: 'predict', label: 'Continue to the prediction' },
    { id: 'show-angle', from: 'predict', to: 'explore-angle', label: 'Show the angle and dot product and explore' },
    { id: 'show-cross', from: 'explore-angle', to: 'explore-cross', label: 'Show the cross product' },
    { id: 'request-explanation', from: 'explore-cross', to: 'explain', label: 'Ask for an explanation' },
    { id: 'request-explanation-early', from: 'explore-angle', to: 'explain', label: 'Ask for an explanation without the cross product' },
    { id: 'close-after-explanation', from: 'explain', to: 'closed', label: 'Close the activity' },
    { id: 'close-from-orientation', from: 'orient', to: 'closed', label: 'Close the activity' },
    { id: 'close-from-prediction', from: 'predict', to: 'closed', label: 'Close the activity' },
    { id: 'close-from-angle-exploration', from: 'explore-angle', to: 'closed', label: 'Close the activity' },
    { id: 'close-from-cross-exploration', from: 'explore-cross', to: 'closed', label: 'Close the activity' },
    { id: 'close-from-free-exploration', from: 'free-explore', to: 'closed', label: 'Close the activity' },
  ],
  initialStage: 'orient',
  alternatives: [
    {
      id: 'without-webgl', kind: 'alternative-activity', group: 'alternatives', ...COPY.alternatives.withoutWebgl,
      covers: ['space', ...SPACE_MARKS], equivalence: 'alternative-activity', verifiedBy: `${VERIFIED_BY}#no-webgl-completion`,
    },
    { id: 'projection-views', kind: 'projection-2d', group: 'alternatives', ...COPY.alternatives.projections, covers: ['space', 'vector-segments'], equivalence: 'partial', verifiedBy: `${VERIFIED_BY}#projection-views` },
    {
      id: 'projection-table', kind: 'table', group: 'alternatives', ...COPY.alternatives.projectionTable,
      covers: PLANES.flatMap(([plane]) => [`plane-${plane}`, `projection-${plane}-segments`]), equivalence: 'equivalent', verifiedBy: `${VERIFIED_BY}#projection-table-equivalent`,
    },
    { id: 'text-description', kind: 'description', group: 'alternatives', ...COPY.alternatives.textDescription, covers: ['space', 'plane-xy', 'plane-xz', 'plane-yz'], equivalence: 'partial', verifiedBy: `${VERIFIED_BY}#text-description` },
    { id: 'exact-entry', kind: 'numeric-entry', group: 'alternatives', ...COPY.alternatives.exactEntry, covers: [...VECTOR_ORIENTATION_PARAMETERS], equivalence: 'equivalent', verifiedBy: `${VERIFIED_BY}#exact-entry` },
    { id: 'keyboard-controls', kind: 'keyboard', group: 'alternatives', ...COPY.alternatives.keyboard, covers: [...VECTOR_ORIENTATION_PARAMETERS], equivalence: 'equivalent', verifiedBy: `${VERIFIED_BY}#keyboard-only` },
  ],
  taskFamilies: [
    { id: 'vector-orientation-prediction', description: 'Host-owned prediction request about the angle between two vectors in space, the sign of their dot product and the direction of their cross product. The host owns the response, its capture and any evaluation.', hostOwned: true },
    { id: 'vector-orientation-explanation', description: 'Host-owned explanation request about how the directions of two vectors determine their angle, dot product and cross product. The host owns the response, its capture and any evaluation.', hostOwned: true },
    { id: 'vector-orientation-later-task', description: 'Host-owned later task with new vectors or another representation, such as a projection-only or table-only version. Its prompts, held-out items and scoring stay with the host and are not part of this catalogue.', hostOwned: true },
  ],
  content: [
    { id: 'derivation-vector-products', kind: 'derivation', text: citation('derivation-vector-products') },
    { id: 'assumptions', kind: 'assumption', text: manifest.interpretation.assumptions.join(' ') },
    { id: 'source-specification', kind: 'source', text: citation('study-harness-specification') },
    { id: 'scenario-note', kind: 'learner-copy', text: COPY.scenarioNote },
  ],
  // The model evaluates θ in radians; learners see degrees by default and may switch to radians (report §8.3).
  quantityDisplay: { angle: { units: ['deg', 'rad'] } },
};
