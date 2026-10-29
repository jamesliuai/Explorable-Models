/**
 * Activity template for a 2×2 matrix as a transformation of the plane (report §6.1, §12.2). Flow: prepare (the
 * column-vector convention, grid, unit square, basis vectors and their images) → predict orientation, collapse and
 * unchanged directions with every transformed result hidden → explore the matrix with exact entry, revealing the
 * transformed grid, the image of the unit square, Mv, the determinant and the area scale under an exposure receipt →
 * unchanged directions revealed in a separate stage → explanation requested through the host → closed.
 * `free-explore` is a separately reachable stage for an authorized free-exploration version. Response requests
 * reference host-owned task families only; this template carries no answers, rubrics or held-out items.
 *
 * The columns of M (Me₁, Me₂) are not solution-bearing: they are a drawing of the matrix entries, which prepare and
 * predict already show as fixed controls. Everything computed from the entries jointly (the transformed grid and
 * square, Mv, determinant, area, orientation, rank, collapse line, eigen data and the equations that substitute them)
 * is solution-bearing.
 */
import type { ActivityTemplate, ContentGroup, MarkSpec, ScenarioSpec, StageSpec } from '@explorable-models/activity';
import { modelIdentity } from '@explorable-models/core/model';
import { LINEAR_COPY as COPY } from '../copy/linear-transformation.js';
import { linearTransformationManifest as manifest } from '../models/linear-transformation.js';

/**
 * Browser spec that exercises each claimed equivalence (report §11): every `#fragment` below is contained in the title of
 * the test that checks it through the rendered surface (fixture-host Chromium results, not manual AT evaluation).
 */
const VERIFIED_BY = 'tests/browser/study-linear-transformation.spec.ts';

const group = (id: string, kind: ContentGroup['kind'], copy: { label: string; description: string }, solutionBearing: boolean, members: string[]): ContentGroup =>
  ({ id, kind, label: copy.label, description: copy.description, solutionBearing, members });

const mark = (spec: Omit<MarkSpec, 'style'> & { style: Partial<MarkSpec['style']> & Pick<MarkSpec['style'], 'role' | 'marker'> }): MarkSpec =>
  ({ ...spec, style: { dash: 'solid', weight: 'regular', ...spec.style } });
const tip = (text: string, anchor: NonNullable<MarkSpec['placement']>['anchor']): Pick<MarkSpec, 'text' | 'placement'> =>
  ({ text, placement: { anchor, offset: [4, -4], leader: false, maxWidthEm: 4 } });

const closedStage = (id: string, kind: StageSpec['kind'], instruction: string): StageSpec =>
  ({ id, kind, instruction, visible: {}, controls: {}, allowsPreview: false, allowsPlayback: false, allowsNavigation: false });

const PARAMETERS = ['m11', 'm12', 'm21', 'm22', 'vx', 'vy'] as const;
const ALL_FIXED = Object.fromEntries(PARAMETERS.map(id => [id, 'fixed'])) as Record<typeof PARAMETERS[number], 'fixed'>;
const ALL_INTERACTIVE = Object.fromEntries(PARAMETERS.map(id => [id, 'interactive'])) as Record<typeof PARAMETERS[number], 'interactive'>;
const citation = (id: string): string => {
  const source = manifest.sources.find(entry => entry.id === id);
  if (!source) throw new RangeError(`The linear-transformation manifest has no source ${id}.`);
  return source.citation;
};

/** cos 30° = sin 120° = √3/2 as the nearest double (sqrt is correctly rounded and halving is exact). */
const HALF_SQRT3 = Math.sqrt(3) / 2;
const scenario = (id: string, copy: { label: string; description: string }, [m11, m12, m21, m22]: [number, number, number, number], [vx, vy]: [number, number] = [1, 1]): ScenarioSpec =>
  ({ id, ...copy, parameters: { m11, m12, m21, m22, vx, vy }, group: 'scenarios' });

/** Groups visible in prepare and predict: the convention, the untransformed plane and the columns of M. */
const BEFORE = {
  plane: 'fixed', reference: 'fixed', basis: 'fixed', columns: 'fixed', 'test-vector': 'fixed', 'matrix-control': 'fixed', 'vector-control': 'fixed',
  convention: 'fixed', readouts: 'fixed', alternatives: 'fixed',
} as const;
/** Groups revealed by exploring the matrix (solution-bearing ones need an exposure receipt). */
const TRANSFORMED = {
  transformed: 'fixed', 'image-vector': 'fixed', determinant: 'fixed', collapse: 'fixed', 'determinant-rule': 'fixed', 'determinant-values': 'fixed',
} as const;
const EIGEN = { eigen: 'fixed', 'eigen-lines': 'fixed', 'eigen-rule': 'fixed', 'eigen-values': 'fixed' } as const;
const EXPLORING = { ...BEFORE, plane: 'interactive', 'matrix-control': 'interactive', 'vector-control': 'interactive', scenarios: 'interactive' } as const;

export const linearTransformationTemplate: ActivityTemplate = {
  contract: 'study-harness.activity-template',
  schemaVersion: '1.0',
  templateId: 'linear-transformation',
  version: '1.0.0',
  model: { modelId: manifest.modelId, version: manifest.version, digest: modelIdentity(manifest).digest },
  title: COPY.title,
  purpose: COPY.purpose,
  dimension: '2d',
  locale: 'en',
  requires: [],
  groups: [
    group('plane', 'view', COPY.groups.plane, false, ['plane']),
    group('reference', 'dataset', COPY.groups.reference, false, ['grid.original', 'unit-square']),
    group('basis', 'quantity', COPY.groups.basis, false, ['basis.e1', 'basis.e2']),
    group('columns', 'quantity', COPY.groups.columns, false, ['image.e1', 'image.e2']),
    group('test-vector', 'quantity', COPY.groups.testVector, false, ['vector.v']),
    group('matrix-control', 'control', COPY.groups.matrixControl, false, ['m11', 'm12', 'm21', 'm22']),
    group('vector-control', 'control', COPY.groups.vectorControl, false, ['vx', 'vy']),
    group('convention', 'equation', COPY.groups.convention, false, ['column-convention', 'matrix-vector']),
    group('readouts', 'view', COPY.groups.readouts, false, ['values', 'vector-table']),
    group('transformed', 'dataset', COPY.groups.transformed, true, ['grid.transformed', 'unit-square.image']),
    group('image-vector', 'quantity', COPY.groups.imageVector, true, ['image.v']),
    group('determinant', 'quantity', COPY.groups.determinant, true, ['determinant', 'area.scale', 'orientation']),
    group('collapse', 'quantity', COPY.groups.collapse, true, ['rank', 'image.direction']),
    group('determinant-rule', 'equation', COPY.groups.determinantRule, false, ['determinant-rule']),
    group('determinant-values', 'equation', COPY.groups.determinantValues, true, ['determinant-substituted']),
    group('eigen', 'quantity', COPY.groups.eigen, true, ['eigen.category', 'eigen.values', 'eigen.direction1', 'eigen.direction2', 'trace', 'eigen.discriminant']),
    group('eigen-lines', 'dataset', COPY.groups.eigenLines, true, ['eigen.lines']),
    group('eigen-rule', 'equation', COPY.groups.eigenRule, false, ['eigen-rule']),
    group('eigen-values', 'equation', COPY.groups.eigenValues, true, ['characteristic-substituted']),
    group('scenarios', 'annotation', COPY.groups.scenarios, false, ['scenario-note']),
    group('alternatives', 'alternative', COPY.groups.alternatives, false, ['vector-table-alternative', 'grid-coordinates', 'text-description', 'exact-entry', 'keyboard-entry']),
  ],
  views: [
    {
      id: 'plane', kind: 'scene2d', group: 'plane', title: 'The plane under M',
      description: 'The plane from −8 to 8 on both axes with equal scales: the reference grid and unit square, e₁ and e₂, their images Me₁ and Me₂ (the columns of M), the test vector v and, once shown, the transformed grid and square, Mv and the unchanged-direction lines.',
      bounds: [-8, 8, -8, 8], equalAspect: true,
      axes: { x: { label: 'x', unit: 'dimensionless' }, y: { label: 'y', unit: 'dimensionless' } },
      marks: [
        mark({ id: 'original-grid', kind: 'segments', group: 'reference', label: 'Reference grid lines x = k and y = k', bindings: { geometry: 'grid.original' }, style: { role: 'reference', marker: 'none', dash: 'dotted', weight: 'thin' } }),
        mark({ id: 'unit-square-outline', kind: 'polygon', group: 'reference', label: 'Unit square before the transformation', bindings: { geometry: 'unit-square' }, style: { role: 'reference', marker: 'none', dash: 'dashed', weight: 'thin' } }),
        mark({ id: 'transformed-grid', kind: 'segments', group: 'transformed', label: 'Transformed grid lines', bindings: { geometry: 'grid.transformed' }, style: { role: 'primary', marker: 'none', weight: 'thin' } }),
        mark({ id: 'unit-square-image', kind: 'polygon', group: 'transformed', label: 'Image of the unit square (area |det M|)', bindings: { geometry: 'unit-square.image' }, style: { role: 'accent', marker: 'none' } }),
        mark({ id: 'eigen-direction-lines', kind: 'segments', group: 'eigen-lines', label: 'Lines through the origin that M maps onto themselves', bindings: { geometry: 'eigen.lines' }, style: { role: 'warning', marker: 'none', dash: 'dashed' }, extent: 'line' }),
        mark({ id: 'basis-e1', kind: 'arrow', group: 'basis', label: 'Basis vector e₁', bindings: { vector: 'basis.e1' }, style: { role: 'reference', marker: 'triangle', dash: 'dashed' }, ...tip('e₁', 'se') }),
        mark({ id: 'basis-e2', kind: 'arrow', group: 'basis', label: 'Basis vector e₂', bindings: { vector: 'basis.e2' }, style: { role: 'reference', marker: 'square', dash: 'dashed' }, ...tip('e₂', 'nw') }),
        mark({ id: 'image-e1', kind: 'arrow', group: 'columns', label: 'Me₁, the first column of M', bindings: { vector: 'image.e1' }, style: { role: 'secondary', marker: 'triangle', weight: 'bold' }, ...tip('Me₁', 'ne') }),
        mark({ id: 'image-e2', kind: 'arrow', group: 'columns', label: 'Me₂, the second column of M', bindings: { vector: 'image.e2' }, style: { role: 'secondary', marker: 'square', weight: 'bold' }, ...tip('Me₂', 'ne') }),
        mark({ id: 'test-vector', kind: 'arrow', group: 'test-vector', label: 'Test vector v', bindings: { vector: 'vector.v' }, style: { role: 'positive', marker: 'circle', dash: 'dashed' }, ...tip('v', 'e') }),
        mark({ id: 'image-vector', kind: 'arrow', group: 'image-vector', label: 'Image Mv of the test vector', bindings: { vector: 'image.v' }, style: { role: 'positive', marker: 'circle', weight: 'bold' }, ...tip('Mv', 'e') }),
        mark({ id: 'eigen-direction-1', kind: 'arrow', group: 'eigen', label: 'Unit unchanged direction u₁', bindings: { vector: 'eigen.direction1' }, style: { role: 'warning', marker: 'diamond' }, ...tip('u₁', 'n') }),
        mark({ id: 'eigen-direction-2', kind: 'arrow', group: 'eigen', label: 'Unit unchanged direction u₂', bindings: { vector: 'eigen.direction2' }, style: { role: 'warning', marker: 'cross' }, ...tip('u₂', 's') }),
      ],
    },
    {
      id: 'values', kind: 'values', group: 'readouts', title: 'Values', description: 'Values for the current matrix and test vector. Values that are not shown yet are not listed; an undefined value is listed with its reason.',
      equalAspect: false, marks: [],
      quantities: ['image.e1', 'image.e2', 'vector.v', 'image.v', 'determinant', 'area.scale', 'orientation', 'rank', 'image.direction', 'trace', 'eigen.discriminant', 'eigen.category', 'eigen.values', 'eigen.direction1', 'eigen.direction2'],
    },
    {
      id: 'vector-table', kind: 'table', group: 'readouts', title: 'Vector coordinates', description: 'One row per vector drawn on the plane with its x and y coordinates. Vectors that are not shown yet are not listed.',
      equalAspect: false, marks: [],
      quantities: ['basis.e1', 'basis.e2', 'image.e1', 'image.e2', 'vector.v', 'image.v', 'image.direction', 'eigen.direction1', 'eigen.direction2'],
    },
    {
      id: 'grid-table', kind: 'table', group: 'transformed', title: 'Transformed grid lines', description: 'One row per grid line x = k or y = k with the two endpoints of its image under M.',
      equalAspect: false, marks: [], rowsFrom: 'grid.transformed',
      axes: { x: { label: 'x', unit: 'dimensionless' }, y: { label: 'y', unit: 'dimensionless' } },
    },
    {
      id: 'rules', kind: 'equation', group: 'convention', title: 'Rules', description: 'The column convention, the product Mv and, once shown, the determinant and eigenvalue rules.',
      equalAspect: false, marks: [], equations: ['column-convention', 'matrix-vector', 'determinant-rule', 'determinant-substituted', 'eigen-rule', 'characteristic-substituted'],
    },
  ],
  controls: [
    ...(['m11', 'm12', 'm21', 'm22'] as const).map(id => ({
      parameter: id, group: 'matrix-control', label: `m${id[1] === '1' ? '₁' : '₂'}${id[2] === '1' ? '₁' : '₂'} (row ${id[1]}, column ${id[2]})`,
      displayUnits: ['dimensionless' as const], slider: true, exact: true, step: 0.1, section: COPY.sections.matrix,
      description: `Entry in row ${id[1]}, column ${id[2]} of M; column ${id[2]} is where e${id[2] === '1' ? '₁' : '₂'} lands. Use the slider, the arrow keys or type an exact value from −3 to 3.`,
    })),
    { parameter: 'vx', group: 'vector-control', label: 'v, x component', displayUnits: ['dimensionless'], slider: true, exact: true, step: 0.1, section: COPY.sections.vector, description: 'The x component of the test vector v, from −3 to 3. The zero vector is allowed.' },
    { parameter: 'vy', group: 'vector-control', label: 'v, y component', displayUnits: ['dimensionless'], slider: true, exact: true, step: 0.1, section: COPY.sections.vector, description: 'The y component of the test vector v, from −3 to 3. The zero vector is allowed.' },
  ],
  scenarios: [
    scenario('identity', COPY.scenarios.identity, [1, 0, 0, 1]),
    scenario('rotation-30', COPY.scenarios.rotation30, [HALF_SQRT3, -0.5, 0.5, HALF_SQRT3]),
    scenario('rotation-120', COPY.scenarios.rotation120, [-0.5, -HALF_SQRT3, HALF_SQRT3, -0.5]),
    scenario('shear', COPY.scenarios.shear, [1, 1.5, 0, 1]),
    scenario('reflection-diagonal', COPY.scenarios.reflectionDiagonal, [0, 1, 1, 0]),
    scenario('reflection-x-axis', COPY.scenarios.reflectionAxis, [1, 0, 0, -1]),
    scenario('collapse', COPY.scenarios.collapse, [0.5, 1, 1, 2]),
    scenario('zero-matrix', COPY.scenarios.zero, [0, 0, 0, 0]),
    scenario('zero-test-vector', COPY.scenarios.zeroVector, [2, -1, 1, 0.5], [0, 0]),
  ],
  equations: [
    {
      id: 'column-convention', group: 'convention', label: 'Columns of M',
      tex: 'M = \\begin{pmatrix} m_{11} & m_{12} \\\\ m_{21} & m_{22} \\end{pmatrix},\\quad M\\mathbf{e}_1 = \\begin{pmatrix} m_{11} \\\\ m_{21} \\end{pmatrix},\\quad M\\mathbf{e}_2 = \\begin{pmatrix} m_{12} \\\\ m_{22} \\end{pmatrix}',
      plain: 'M has rows (m11, m12) and (m21, m22). M·e1 = (m11, m21) is the first column and M·e2 = (m12, m22) is the second column.',
    },
    {
      id: 'matrix-vector', group: 'convention', label: 'Image of a vector',
      tex: 'M\\mathbf{v} = v_x\\,M\\mathbf{e}_1 + v_y\\,M\\mathbf{e}_2 = \\begin{pmatrix} m_{11}v_x + m_{12}v_y \\\\ m_{21}v_x + m_{22}v_y \\end{pmatrix}',
      plain: 'M·v = vx·(M·e1) + vy·(M·e2) = (m11·vx + m12·vy, m21·vx + m22·vy)',
    },
    {
      id: 'determinant-rule', group: 'determinant-rule', label: 'Determinant and area scale',
      tex: '\\det M = m_{11}m_{22} - m_{12}m_{21},\\qquad \\text{area scale} = \\lvert \\det M \\rvert \\ge 0',
      plain: 'det M = m11·m22 − m12·m21; area scale = |det M|, which is never negative',
    },
    {
      id: 'determinant-substituted', group: 'determinant-values', label: 'Determinant and area scale with current values',
      tex: '\\det M = {{q:determinant}},\\qquad \\lvert \\det M \\rvert = {{q:area.scale}}',
      plain: 'det M = {{q:determinant}}; |det M| = {{q:area.scale}}',
    },
    {
      id: 'eigen-rule', group: 'eigen-rule', label: 'Unchanged directions',
      tex: 'M\\mathbf{u} = \\lambda\\mathbf{u},\\qquad \\lambda^{2} - (\\operatorname{tr} M)\\,\\lambda + \\det M = 0,\\qquad \\Delta = (\\operatorname{tr} M)^{2} - 4\\det M',
      plain: 'M·u = λ·u; λ² − (tr M)·λ + det M = 0; Δ = (tr M)² − 4·det M',
    },
    {
      id: 'characteristic-substituted', group: 'eigen-values', label: 'Characteristic equation with current values',
      tex: '\\lambda^{2} - ({{q:trace}})\\,\\lambda + ({{q:determinant}}) = 0,\\qquad \\Delta = {{q:eigen.discriminant}}',
      plain: 'λ² − ({{q:trace}})·λ + ({{q:determinant}}) = 0; Δ = {{q:eigen.discriminant}}',
    },
  ],
  stages: [
    {
      id: 'prepare', kind: 'prepare', instruction: COPY.stages.prepare.instruction,
      visible: { ...BEFORE }, controls: { ...ALL_FIXED }, allowsPreview: false, allowsPlayback: false, allowsNavigation: false,
    },
    {
      id: 'predict', kind: 'predict', instruction: COPY.stages.predict.instruction,
      visible: { ...BEFORE }, controls: { ...ALL_FIXED }, allowsPreview: false, allowsPlayback: false, allowsNavigation: false,
      response: { kind: 'prediction', prompt: COPY.stages.predict.prompt, taskFamily: 'linear-transformation-prediction' },
    },
    {
      id: 'explore', kind: 'explore', instruction: COPY.stages.explore.instruction,
      visible: { ...EXPLORING, ...TRANSFORMED }, controls: { ...ALL_INTERACTIVE }, allowsPreview: true, allowsPlayback: false, allowsNavigation: false,
    },
    {
      id: 'explore-eigen', kind: 'explore', instruction: COPY.stages.exploreEigen.instruction,
      visible: { ...EXPLORING, ...TRANSFORMED, ...EIGEN }, controls: { ...ALL_INTERACTIVE }, allowsPreview: true, allowsPlayback: false, allowsNavigation: false,
    },
    {
      id: 'explain', kind: 'explain', instruction: COPY.stages.explain.instruction,
      visible: { ...BEFORE, ...TRANSFORMED, ...EIGEN }, controls: { ...ALL_FIXED }, allowsPreview: false, allowsPlayback: false, allowsNavigation: false,
      response: { kind: 'explanation', prompt: COPY.stages.explain.prompt, taskFamily: 'linear-transformation-explanation' },
    },
    closedStage('closed', 'closed', COPY.stages.closed.instruction),
    {
      id: 'free-explore', kind: 'explore', instruction: COPY.stages.freeExplore.instruction,
      visible: { ...EXPLORING, ...TRANSFORMED, ...EIGEN }, controls: { ...ALL_INTERACTIVE }, allowsPreview: true, allowsPlayback: false, allowsNavigation: false,
    },
  ],
  transitions: [
    { id: 'start-prediction', from: 'prepare', to: 'predict', label: 'Make a prediction' },
    { id: 'start-exploration', from: 'predict', to: 'explore', label: 'Show the transformed plane and explore the matrix' },
    { id: 'show-unchanged-directions', from: 'explore', to: 'explore-eigen', label: 'Show the unchanged directions' },
    { id: 'request-explanation', from: 'explore-eigen', to: 'explain', label: 'Ask for an explanation' },
    { id: 'request-explanation-early', from: 'explore', to: 'explain', label: 'Ask for an explanation (shows the unchanged directions too)' },
    { id: 'close-after-explanation', from: 'explain', to: 'closed', label: 'Close the activity' },
    { id: 'close-from-preparation', from: 'prepare', to: 'closed', label: 'Close the activity' },
    { id: 'close-from-prediction', from: 'predict', to: 'closed', label: 'Close the activity' },
    { id: 'close-from-exploration', from: 'explore', to: 'closed', label: 'Close the activity' },
    { id: 'close-from-eigen-exploration', from: 'explore-eigen', to: 'closed', label: 'Close the activity' },
    { id: 'close-from-free-exploration', from: 'free-explore', to: 'closed', label: 'Close the activity' },
  ],
  initialStage: 'prepare',
  alternatives: [
    {
      id: 'vector-table-alternative', kind: 'table', group: 'alternatives', ...COPY.alternatives.vectorTable,
      covers: ['plane', 'basis-e1', 'basis-e2', 'image-e1', 'image-e2', 'test-vector', 'image-vector', 'eigen-direction-1', 'eigen-direction-2'],
      equivalence: 'equivalent', verifiedBy: `${VERIFIED_BY}#vector-table-equivalent`,
    },
    {
      id: 'grid-coordinates', kind: 'table', group: 'alternatives', ...COPY.alternatives.gridTable,
      covers: ['plane', 'original-grid', 'unit-square-outline', 'transformed-grid', 'unit-square-image', 'eigen-direction-lines'],
      equivalence: 'equivalent', verifiedBy: `${VERIFIED_BY}#grid-table-equivalent`,
    },
    { id: 'text-description', kind: 'description', group: 'alternatives', ...COPY.alternatives.textDescription, covers: ['plane'], equivalence: 'partial', verifiedBy: `${VERIFIED_BY}#text-description` },
    { id: 'exact-entry', kind: 'numeric-entry', group: 'alternatives', ...COPY.alternatives.exactEntry, covers: [...PARAMETERS], equivalence: 'equivalent', verifiedBy: `${VERIFIED_BY}#exact-entry` },
    { id: 'keyboard-entry', kind: 'keyboard', group: 'alternatives', ...COPY.alternatives.keyboard, covers: [...PARAMETERS], equivalence: 'equivalent', verifiedBy: `${VERIFIED_BY}#keyboard-only` },
  ],
  taskFamilies: [
    { id: 'linear-transformation-prediction', description: 'Host-owned prediction request about the orientation, collapse and unchanged directions of a given 2×2 matrix. The host owns the response, its capture and any evaluation.', hostOwned: true },
    { id: 'linear-transformation-explanation', description: 'Host-owned explanation request about how the columns and determinant of a 2×2 matrix determine orientation, area, collapse and unchanged directions. The host owns the response, its capture and any evaluation.', hostOwned: true },
    { id: 'linear-transformation-new-matrix-task', description: 'Host-owned later task with a new matrix or a changed representation. Its prompts, held-out items and scoring stay with the host and are not part of this catalogue.', hostOwned: true },
  ],
  content: [
    { id: 'derivation-linear-map', kind: 'derivation', text: citation('derivation-linear-map') },
    { id: 'assumptions', kind: 'assumption', text: manifest.interpretation.assumptions.join(' ') },
    { id: 'source-specification', kind: 'source', text: citation('study-harness-specification') },
    { id: 'scenario-note', kind: 'learner-copy', text: COPY.scenarioNote },
  ],
};
