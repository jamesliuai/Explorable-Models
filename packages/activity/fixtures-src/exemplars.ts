/**
 * Typed, internally consistent valid exemplars for every activity schema. Declared with `satisfies <Interface>` so
 * the TypeScript contract types, the JSON Schemas and the shared fixtures cannot drift silently: the compiler checks
 * these objects against the interfaces, the tests check them against the schemas, and the shared fixture files are
 * generated from them (scripts/study-harness/generate-contracts.mjs). Digests are computed, not invented.
 *
 * Content is fixture data for contract tests; it is not a reviewed teaching activity.
 */
import { sha256 } from '@explorable-models/core';
import { modelIdentity, type ModelManifest, type ModelRef } from '@explorable-models/core/model';
import {
  CONTRACTS, type ActivityArtifact, type ActivityInstance, type ActivityRecords, type ActivityRequest, type ActivityTemplate, type AppendResult, type AssistanceReceipt,
  type AssistanceRequest, type DisplayAckRequest, type EventType, type ExposureGrant, type ExposureIntentRequest, type ExposureReceipt, type ExposureRecord,
  type HostAck, type HostPolicy, type InteractionEvent, type InteractionSummary, type JournalCursor, type PresentationSnapshot, type ResponseRef,
  type ReviewRecord, type ScientificSnapshot, type StageReceipt, type StageTransitionRequest, type TemplateRef,
} from '../src/contracts.js';
import { DISCRETE_ITERATION_CAPABILITY, SPATIAL_3D_CAPABILITY } from '../src/capabilities.js';
import { artifactIntegrity, groupContentDigest, templateRef } from '../src/identity.js';
import { MESSAGES, MODEL_MANIFEST_CONTRACT, type SchemaName } from '../src/schemas.js';
import type { SchemaTypes } from '../src/validator.js';

const fake = (label: string): string => 'sha256:' + sha256(label);
const PI = Math.PI;

// ---------------------------------------------------------------------------------------------
// Model manifests
// ---------------------------------------------------------------------------------------------
export const quadraticManifest: ModelManifest = {
  contract: 'explorable-models.model-manifest', schemaVersion: '1.0', modelId: 'quadratic-descent', version: '1.0.0',
  title: 'Gradient descent on a quadratic loss',
  summary: 'Fixed-step gradient descent on f(x) = a·x²/2. Each step multiplies the position by r = 1 − η·a.',
  execution: { kind: 'kernel', kernelId: 'quadratic-gradient-descent', kernelVersion: '1.0.0', mode: 'discrete', maxIndex: 1000 },
  capabilities: [{ id: 'discrete-iteration', version: '1.0' }],
  parameters: {
    a: { label: 'Curvature', symbol: 'a', description: 'Curvature of the quadratic loss.', dimension: 'dimensionless', unit: 'dimensionless', min: 0.1, max: 10, default: 1, step: { ui: 0.1, admissible: 'continuous' }, role: 'model-input' },
    eta: { label: 'Learning rate', symbol: '\\eta', description: 'Step size multiplying the gradient.', dimension: 'dimensionless', unit: 'dimensionless', min: 0, max: 2, default: 0.5, step: { ui: 0.05, admissible: 'continuous' }, role: 'model-input' },
    x0: { label: 'Starting point', symbol: 'x_0', description: 'Position before the first step.', dimension: 'dimensionless', unit: 'dimensionless', min: -10, max: 10, default: 8, step: { ui: 0.5, admissible: 'continuous' }, role: 'model-input' },
  },
  quantities: {
    x: { label: 'Current position', symbol: 'x_n', shape: { kind: 'scalar' }, dimension: 'dimensionless', unit: 'dimensionless', meaning: 'Iterate x at the current index n.' },
    loss: { label: 'Current loss', symbol: 'f(x_n)', shape: { kind: 'scalar' }, dimension: 'dimensionless', unit: 'dimensionless', meaning: 'Loss a·x²/2 at the current iterate.' },
    multiplier: { label: 'Step multiplier', symbol: 'r', shape: { kind: 'scalar' }, dimension: 'dimensionless', unit: 'dimensionless', meaning: 'r = 1 − η·a; every step multiplies x by r.' },
    point: { label: 'Current point', shape: { kind: 'vector', length: 2 }, dimension: 'dimensionless', unit: 'dimensionless', meaning: 'The point (x_n, f(x_n)) on the loss curve.', coordinateFrame: 'plot' },
    start: { label: 'Starting point on the curve', shape: { kind: 'vector', length: 2 }, dimension: 'dimensionless', unit: 'dimensionless', meaning: 'The point (x_0, f(x_0)).', coordinateFrame: 'plot' },
    regime: { label: 'Regime', shape: { kind: 'category', values: ['zero-start', 'stationary', 'monotone-convergence', 'one-step', 'alternating-convergence', 'oscillation', 'divergence'] }, dimension: 'dimensionless', unit: 'dimensionless', meaning: 'Convergence regime classified from x0 and η·a.' },
  },
  geometry: {
    landscape: { kind: 'polyline2', label: 'Loss curve', description: 'f(x) = a·x²/2 sampled on [−10, 10].', dimension: 'dimensionless', unit: 'dimensionless', coordinateFrame: 'plot', maxElements: 201 },
    iterates: { kind: 'points2', label: 'Iterates', description: 'Points (x_k, f(x_k)) for k = 0…n.', dimension: 'dimensionless', unit: 'dimensionless', coordinateFrame: 'plot', maxElements: 1001 },
    steps: { kind: 'segments2', label: 'Steps', description: 'Segments joining consecutive iterates.', dimension: 'dimensionless', unit: 'dimensionless', coordinateFrame: 'plot', maxElements: 1000 },
  },
  constraints: [{ id: 'step-product', expression: 'eta*a', max: 4, maxInclusive: true, message: 'The step product η·a must be at most 4.', recovery: 'Lower the learning rate or the curvature.' }],
  interpretation: {
    coordinateConvention: 'x increases to the right; loss is plotted upward.',
    assumptions: ['Exact gradient, fixed step size, no noise.'],
    limitations: ['One-dimensional quadratic only; not a model of stochastic training.'],
  },
  limits: { maxIndex: 1000, maxGeometryElements: 3000, maxOperations: 1_000_000 },
  sources: [{ id: 'derivation', kind: 'derivation', citation: 'x[n+1] = x[n] − η·a·x[n] = (1 − η·a)·x[n].' }],
  referenceSuite: { suiteId: 'quadratic-descent-reference', digest: fake('quadratic-descent-reference-suite') },
};

export const orientationManifest: ModelManifest = {
  contract: 'explorable-models.model-manifest', schemaVersion: '1.0', modelId: 'vector-orientation', version: '1.0.0',
  title: 'Orientation of a unit vector',
  summary: 'A unit vector set by polar angle θ and azimuth φ, with its Cartesian components.',
  execution: { kind: 'kernel', kernelId: 'vector-orientation', kernelVersion: '1.0.0', mode: 'static' },
  capabilities: [{ id: 'spatial-3d', version: '1.0' }],
  parameters: {
    theta: { label: 'Polar angle', symbol: '\\theta', description: 'Angle measured from the +z axis.', dimension: 'angle', unit: 'rad', min: 0, max: PI, default: PI / 4, step: { ui: 0.01, admissible: 'continuous' }, role: 'model-input' },
    phi: { label: 'Azimuth', symbol: '\\varphi', description: 'Angle from +x toward +y in the x–y plane.', dimension: 'angle', unit: 'rad', min: -PI, max: PI, default: PI / 6, step: { ui: 0.01, admissible: 'continuous' }, role: 'model-input' },
  },
  quantities: {
    direction: { label: 'Unit direction', symbol: '\\hat{v}', shape: { kind: 'vector', length: 3 }, dimension: 'dimensionless', unit: 'dimensionless', meaning: 'Unit vector (sin θ cos φ, sin θ sin φ, cos θ).', coordinateFrame: 'world, right-handed, z up' },
    origin: { label: 'Origin', shape: { kind: 'vector', length: 3 }, dimension: 'dimensionless', unit: 'dimensionless', meaning: 'Tail of the vector at the origin.', coordinateFrame: 'world, right-handed, z up' },
    vx: { label: 'x component', symbol: 'v_x', shape: { kind: 'scalar' }, dimension: 'dimensionless', unit: 'dimensionless', meaning: 'sin θ cos φ' },
    vy: { label: 'y component', symbol: 'v_y', shape: { kind: 'scalar' }, dimension: 'dimensionless', unit: 'dimensionless', meaning: 'sin θ sin φ' },
    vz: { label: 'z component', symbol: 'v_z', shape: { kind: 'scalar' }, dimension: 'dimensionless', unit: 'dimensionless', meaning: 'cos θ' },
  },
  geometry: {
    axes: { kind: 'segments3', label: 'Coordinate axes', description: 'Unit segments along +x, +y and +z.', dimension: 'dimensionless', unit: 'dimensionless', coordinateFrame: 'world, right-handed, z up', maxElements: 3 },
    sphere: { kind: 'surface-grid', label: 'Unit sphere grid', description: 'Latitude/longitude grid of the unit sphere.', dimension: 'dimensionless', unit: 'dimensionless', coordinateFrame: 'world, right-handed, z up', maxElements: 1089 },
  },
  constraints: [],
  interpretation: {
    coordinateConvention: 'Right-handed world frame with +z up.', angleConvention: 'Physics convention: θ from +z, φ from +x toward +y.', handedness: 'right',
    assumptions: ['The vector has unit length.'], limitations: ['Direction only; magnitude is fixed at one.'],
  },
  limits: { maxGeometryElements: 2000, maxOperations: 10_000 },
  sources: [{ id: 'spherical', kind: 'derivation', citation: 'Spherical to Cartesian coordinates for a unit radius.' }],
  referenceSuite: null,
};

/** Static kernel with an observed dataset (report §8.5): units, a missing cell with its reason and provenance. */
export const observedManifest: ModelManifest = {
  contract: 'explorable-models.model-manifest', schemaVersion: '1.0', modelId: 'observed-fall', version: '1.0.0',
  title: 'Recorded heights beside a constant-gravity prediction',
  summary: 'Predicted height h(t) = h0 − g·t²/2 beside recorded heights that are never joined or fitted.',
  execution: { kind: 'kernel', kernelId: 'observed-fall', kernelVersion: '1.0.0', mode: 'static' },
  capabilities: [],
  parameters: {
    g: { label: 'Gravitational acceleration', symbol: 'g', description: 'Constant downward acceleration.', dimension: 'acceleration', unit: 'm/s^2', min: 1, max: 20, default: 9.8, step: { ui: 0.1, admissible: 'continuous' }, role: 'model-input' },
  },
  quantities: { landing: { label: 'Landing time', shape: { kind: 'scalar' }, dimension: 'time', unit: 's', meaning: 'Predicted time to reach the floor from 20 m.' } },
  geometry: {
    prediction: { kind: 'polyline2', label: 'Predicted height', description: 'Model curve h(t), sampled.', dimension: 'length', unit: 'm', coordinateFrame: 'time horizontal, height vertical', maxElements: 101 },
    measured: { kind: 'observations2', label: 'Recorded heights', description: 'Recorded (time, height) pairs.', dimension: 'length', unit: 'm', coordinateFrame: 'time horizontal, height vertical', maxElements: 4, observations: { dataset: 'drops', x: 't', y: 'h' } },
  },
  constraints: [],
  interpretation: { coordinateConvention: 'Height upward from the floor.', assumptions: ['Release from rest at 20 m.'], limitations: ['The recorded heights are not fitted.'] },
  limits: { maxGeometryElements: 105, maxOperations: 10_000 },
  sources: [{ id: 'drop-log', kind: 'dataset', citation: 'Illustrative drop log (contract fixture; not a measurement).' }],
  referenceSuite: null,
  observations: {
    drops: {
      label: 'Recorded heights', description: 'One reading every 0.5 s.',
      columns: [{ id: 't', label: 'Time', dimension: 'time', unit: 's', meaning: 'Time since release.' }, { id: 'h', label: 'Height', dimension: 'length', unit: 'm', meaning: 'Height above the floor.' }],
      rows: [[0, 20], [0.5, 18.8], [1, null], [1.5, 9]],
      missing: [{ row: 2, column: 'h', reason: 'The ball was hidden in this frame.' }],
      provenance: { sourceId: 'drop-log', description: 'Written for the shared contract fixtures.', license: 'MIT' },
    },
  },
};

const modelRef = (manifest: ModelManifest): ModelRef => ({ modelId: manifest.modelId, version: manifest.version, digest: modelIdentity(manifest).digest });
export const QUADRATIC_MODEL = modelRef(quadraticManifest);
export const ORIENTATION_MODEL = modelRef(orientationManifest);
const style = (role: 'primary' | 'accent' | 'muted' | 'reference', marker: 'circle' | 'none' = 'none', dash: 'solid' | 'dashed' = 'solid', weight: 'thin' | 'regular' | 'bold' = 'regular') => ({ role, dash, marker, weight });

// ---------------------------------------------------------------------------------------------
// Activity templates
// ---------------------------------------------------------------------------------------------
export const quadraticTemplate: ActivityTemplate = {
  contract: CONTRACTS.template, schemaVersion: '1.0', templateId: 'quadratic-descent-regimes', version: '1.0.0', model: QUADRATIC_MODEL,
  title: 'How the learning rate shapes gradient descent',
  purpose: 'Predict, then observe, how the step product η·a determines whether fixed-step descent converges, oscillates or diverges.',
  dimension: '2d', locale: 'en-GB', requires: [{ id: 'discrete-iteration', version: '1.0' }],
  groups: [
    { id: 'g-plot', kind: 'view', label: 'Loss plot', description: 'The loss curve and the descent path.', solutionBearing: false, members: ['plot'] },
    { id: 'g-landscape', kind: 'mark', label: 'Loss curve', description: 'The quadratic loss and the draggable start.', solutionBearing: false, members: ['m-curve', 'm-start'] },
    { id: 'g-trajectory', kind: 'mark', label: 'Descent path', description: 'Iterates, steps and the current point.', solutionBearing: true, members: ['m-iterates', 'm-steps', 'm-point', 'm-label'] },
    { id: 'g-position', kind: 'quantity', label: 'Position and loss', description: 'Current iterate and its loss.', solutionBearing: true, members: ['x', 'loss', 'point'] },
    { id: 'g-multiplier', kind: 'quantity', label: 'Step multiplier', description: 'r = 1 − η·a.', solutionBearing: false, members: ['multiplier', 'start'] },
    { id: 'g-values', kind: 'view', label: 'Values', description: 'Numeric readout.', solutionBearing: false, members: ['values'] },
    { id: 'g-equation-view', kind: 'view', label: 'Update rule view', description: 'The update rule with current numbers.', solutionBearing: false, members: ['equation'] },
    { id: 'g-rule', kind: 'equation', label: 'Update rule', description: 'x_{n+1} = r·x_n with values.', solutionBearing: true, members: ['eq-update'] },
    { id: 'g-table', kind: 'view', label: 'Iterate table', description: 'Iterates as rows.', solutionBearing: true, members: ['table'] },
    { id: 'g-controls', kind: 'control', label: 'Parameters', description: 'Learning rate, start and curvature.', solutionBearing: false, members: ['eta', 'x0', 'a'] },
    { id: 'g-alternatives', kind: 'alternative', label: 'Accessible equivalents', description: 'Text, table and keyboard equivalents.', solutionBearing: false, members: ['alt-description', 'alt-table', 'alt-keyboard'] },
    { id: 'g-notes', kind: 'annotation', label: 'Notes', description: 'Derivation and assumptions.', solutionBearing: false, members: ['note-derivation', 'note-assumption'] },
  ],
  views: [
    {
      id: 'plot', kind: 'plot2d', group: 'g-plot', title: 'Loss and iterates',
      description: 'Plot of the loss a·x²/2 against x, with the descent iterates drawn on the curve.',
      bounds: [-10, 10, -5, 55], equalAspect: false,
      axes: { x: { label: 'Position x', unit: 'dimensionless', quantity: 'x' }, y: { label: 'Loss f(x)', unit: 'dimensionless', quantity: 'loss' } },
      marks: [
        { id: 'm-curve', kind: 'curve', group: 'g-landscape', label: 'Loss curve', bindings: { geometry: 'landscape' }, style: style('primary') },
        { id: 'm-start', kind: 'point', group: 'g-landscape', label: 'Starting point', bindings: { at: 'start' }, style: style('reference', 'circle'), drag: { x: 'x0' } },
        { id: 'm-iterates', kind: 'points', group: 'g-trajectory', label: 'Iterates', bindings: { geometry: 'iterates' }, style: style('accent', 'circle') },
        { id: 'm-steps', kind: 'segments', group: 'g-trajectory', label: 'Steps', bindings: { geometry: 'steps' }, style: style('muted', 'none', 'dashed', 'thin') },
        { id: 'm-point', kind: 'point', group: 'g-trajectory', label: 'Current iterate', bindings: { at: 'point' }, style: style('accent', 'circle', 'solid', 'bold') },
        { id: 'm-label', kind: 'label', group: 'g-trajectory', label: 'Current iterate label', bindings: { at: 'point' }, style: style('accent'), text: 'x_n', placement: { anchor: 'ne', offset: [6, -6], leader: false, maxWidthEm: 8 } },
      ],
    },
    { id: 'values', kind: 'values', group: 'g-values', title: 'Current values', description: 'Position, loss and step multiplier at the current index.', equalAspect: false, marks: [], quantities: ['x', 'loss', 'multiplier'] },
    { id: 'equation', kind: 'equation', group: 'g-equation-view', title: 'Update rule', description: 'The update rule with the current numbers substituted.', equalAspect: false, marks: [], equations: ['eq-update'] },
    { id: 'table', kind: 'table', group: 'g-table', title: 'Iterates', description: 'One row per iterate: index, position and loss.', equalAspect: false, marks: [], rowsFrom: 'iterates' },
  ],
  controls: [
    { parameter: 'eta', group: 'g-controls', label: 'Learning rate η', displayUnits: ['dimensionless'], slider: true, exact: true, step: 0.05, description: 'Step size multiplying the gradient.' },
    { parameter: 'x0', group: 'g-controls', label: 'Starting point x₀', displayUnits: ['dimensionless'], slider: true, exact: true, step: 0.5, description: 'Position before the first step.' },
    { parameter: 'a', group: 'g-controls', label: 'Curvature a', displayUnits: ['dimensionless'], slider: true, exact: true, step: 0.1, description: 'Curvature of the loss.' },
  ],
  scenarios: [
    { id: 's-monotone', label: 'Small steps', description: 'η·a = 0.5: steady approach to the minimum.', parameters: { eta: 0.5, a: 1, x0: 8 }, group: 'g-controls' },
    { id: 's-diverge', label: 'Large steps', description: 'η·a = 3: every step overshoots further.', parameters: { eta: 2, a: 1.5, x0: 8 }, group: 'g-controls' },
  ],
  equations: [
    { id: 'eq-update', group: 'g-rule', label: 'Update rule', tex: 'x_{n+1} = (1 - \\eta a)\\,x_n = {{q:multiplier}} \\times {{q:x}}', plain: 'x next = (1 − η·a)·x = {{q:multiplier}} × {{q:x}}' },
  ],
  stages: [
    {
      id: 'predict', kind: 'predict', instruction: 'Choose a learning rate and predict whether the iterates will settle at the minimum.',
      visible: { 'g-plot': 'fixed', 'g-landscape': 'fixed', 'g-controls': 'interactive', 'g-alternatives': 'fixed', 'g-notes': 'fixed' },
      controls: { eta: 'interactive', x0: 'fixed', a: 'fixed' }, allowsPreview: false, allowsPlayback: false, allowsNavigation: false,
      response: { kind: 'prediction', prompt: 'Will the iterates converge, oscillate or diverge for your learning rate?', taskFamily: 'tf-regime' },
    },
    {
      id: 'explore', kind: 'explore', instruction: 'Step through the iterates and try other learning rates.',
      visible: {
        'g-plot': 'interactive', 'g-landscape': 'interactive', 'g-trajectory': 'interactive', 'g-position': 'fixed', 'g-multiplier': 'fixed', 'g-values': 'fixed',
        'g-equation-view': 'fixed', 'g-rule': 'fixed', 'g-table': 'fixed', 'g-controls': 'interactive', 'g-alternatives': 'fixed', 'g-notes': 'fixed',
      },
      controls: { eta: 'interactive', x0: 'interactive', a: 'interactive' }, allowsPreview: true, allowsPlayback: true, allowsNavigation: true,
    },
    {
      id: 'explain', kind: 'explain', instruction: 'Explain how η·a decides the behaviour you observed.',
      visible: {
        'g-plot': 'fixed', 'g-landscape': 'fixed', 'g-trajectory': 'fixed', 'g-position': 'fixed', 'g-multiplier': 'fixed', 'g-values': 'fixed',
        'g-equation-view': 'fixed', 'g-rule': 'fixed', 'g-table': 'fixed', 'g-alternatives': 'fixed', 'g-notes': 'fixed',
      },
      controls: {}, allowsPreview: false, allowsPlayback: true, allowsNavigation: true,
      response: { kind: 'explanation', prompt: 'In your own words, why does the product η·a matter?', taskFamily: 'tf-explain' },
    },
  ],
  transitions: [
    { id: 't-reveal', from: 'predict', to: 'explore', label: 'Show the iterates' },
    { id: 't-explain', from: 'explore', to: 'explain', label: 'Explain what you saw' },
  ],
  initialStage: 'predict',
  alternatives: [
    { id: 'alt-description', kind: 'description', group: 'g-alternatives', label: 'Plot description', covers: ['plot'], equivalence: 'equivalent', description: 'A generated text description of the curve, the iterates and the current point, from visible values only.', verifiedBy: 'tests/activity/projection.test.ts#plot-description' },
    { id: 'alt-table', kind: 'table', group: 'g-alternatives', label: 'Iterate table', covers: ['plot', 'm-iterates'], equivalence: 'equivalent', description: 'The iterates as a table of index, position and loss.', verifiedBy: 'tests/activity/projection.test.ts#iterate-table' },
    { id: 'alt-keyboard', kind: 'keyboard', group: 'g-alternatives', label: 'Exact start entry', covers: ['m-start'], equivalence: 'equivalent', description: 'Type the starting point instead of dragging it.', verifiedBy: 'manual-check:keyboard-start-entry' },
  ],
  taskFamilies: [
    { id: 'tf-regime', description: 'Classify the regime of fixed-step descent from η and a.', hostOwned: true },
    { id: 'tf-explain', description: 'Explain the role of the step product in fixed-step descent.', hostOwned: true },
  ],
  content: [
    { id: 'note-derivation', kind: 'derivation', text: 'Each step subtracts η times the gradient a·x, so x is multiplied by 1 − η·a.' },
    { id: 'note-assumption', kind: 'assumption', text: 'The gradient is exact and the step size is fixed.' },
  ],
};

export const orientationTemplate: ActivityTemplate = {
  contract: CONTRACTS.template, schemaVersion: '1.0', templateId: 'vector-orientation-explore', version: '1.2.0', model: ORIENTATION_MODEL,
  title: 'Orienting a unit vector', purpose: 'Relate the polar angle and azimuth of a unit vector to its Cartesian components.',
  dimension: '3d', locale: 'en-US', requires: [{ id: 'spatial-3d', version: '1.0' }],
  groups: [
    { id: 'g-scene', kind: 'view', label: 'Scene', description: 'Three-dimensional view.', solutionBearing: false, members: ['scene'] },
    { id: 'g-vector', kind: 'mark', label: 'Vector', description: 'The unit vector and its tip.', solutionBearing: false, members: ['m-arrow', 'm-tip'] },
    { id: 'g-frame', kind: 'mark', label: 'Reference frame', description: 'Axes and sphere grid.', solutionBearing: false, members: ['m-axes', 'm-sphere'] },
    { id: 'g-components', kind: 'quantity', label: 'Components', description: 'Cartesian components.', solutionBearing: false, members: ['direction', 'origin', 'vx', 'vy', 'vz'] },
    { id: 'g-values-view', kind: 'view', label: 'Component readout', description: 'Numeric components.', solutionBearing: false, members: ['values'] },
    { id: 'g-equations', kind: 'equation', label: 'Component formula', description: 'Components with current values.', solutionBearing: false, members: ['eq-components'] },
    { id: 'g-equation-view', kind: 'view', label: 'Formula view', description: 'The component formula.', solutionBearing: false, members: ['equation'] },
    { id: 'g-controls', kind: 'control', label: 'Angles', description: 'Polar angle and azimuth.', solutionBearing: false, members: ['theta', 'phi'] },
    { id: 'g-alternatives', kind: 'alternative', label: 'Equivalents', description: 'Text and projection equivalents.', solutionBearing: false, members: ['alt-values', 'alt-projection'] },
  ],
  views: [
    {
      id: 'scene', kind: 'scene3d', group: 'g-scene', title: 'Unit vector', description: 'The unit vector drawn from the origin inside a unit sphere grid with labelled axes.',
      bounds3: [-1.5, 1.5, -1.5, 1.5, -1.5, 1.5], equalAspect: true,
      axes: { x: { label: 'x', unit: 'dimensionless' }, y: { label: 'y', unit: 'dimensionless' }, z: { label: 'z', unit: 'dimensionless' } },
      marks: [
        { id: 'm-axes', kind: 'segments', group: 'g-frame', label: 'Axes', bindings: { geometry: 'axes' }, style: style('muted', 'none', 'solid', 'thin') },
        { id: 'm-sphere', kind: 'surface', group: 'g-frame', label: 'Sphere grid', bindings: { geometry: 'sphere' }, style: style('muted', 'none', 'dashed', 'thin') },
        { id: 'm-arrow', kind: 'arrow', group: 'g-vector', label: 'Unit vector', bindings: { vector: 'direction', origin: 'origin' }, style: style('primary', 'none', 'solid', 'bold') },
        { id: 'm-tip', kind: 'point', group: 'g-vector', label: 'Tip', bindings: { at: 'direction' }, style: style('accent', 'circle') },
      ],
    },
    { id: 'values', kind: 'values', group: 'g-values-view', title: 'Components', description: 'The x, y and z components of the unit vector.', equalAspect: false, marks: [], quantities: ['vx', 'vy', 'vz'] },
    { id: 'equation', kind: 'equation', group: 'g-equation-view', title: 'Components', description: 'Component formula with current values.', equalAspect: false, marks: [], equations: ['eq-components'] },
  ],
  controls: [
    { parameter: 'theta', group: 'g-controls', label: 'Polar angle θ', displayUnits: ['deg', 'rad'], slider: true, exact: true, step: 1, description: 'Angle from the +z axis.' },
    { parameter: 'phi', group: 'g-controls', label: 'Azimuth φ', displayUnits: ['deg', 'rad'], slider: true, exact: true, step: 1, description: 'Angle from +x toward +y.' },
  ],
  scenarios: [{ id: 's-equator', label: 'On the equator', description: 'θ = 90°: the vector lies in the x–y plane.', parameters: { theta: PI / 2, phi: 0 }, group: 'g-controls' }],
  equations: [{ id: 'eq-components', group: 'g-equations', label: 'Components', tex: '\\hat{v} = (\\sin\\theta\\cos\\varphi, \\sin\\theta\\sin\\varphi, \\cos\\theta) = ({{q:vx}}, {{q:vy}}, {{q:vz}})', plain: 'v = (sin θ cos φ, sin θ sin φ, cos θ) = ({{q:vx}}, {{q:vy}}, {{q:vz}})' }],
  stages: [
    {
      id: 'explore', kind: 'explore', instruction: 'Change θ and φ and watch the components.',
      visible: { 'g-scene': 'interactive', 'g-vector': 'interactive', 'g-frame': 'fixed', 'g-components': 'fixed', 'g-values-view': 'fixed', 'g-equations': 'fixed', 'g-equation-view': 'fixed', 'g-controls': 'interactive', 'g-alternatives': 'fixed' },
      controls: { theta: 'interactive', phi: 'interactive' }, allowsPreview: true, allowsPlayback: false, allowsNavigation: false,
      response: { kind: 'explanation', prompt: 'Which angle changes the z component, and why?', taskFamily: 'tf-orientation' },
    },
    { id: 'closed', kind: 'closed', instruction: 'The activity is closed.', visible: { 'g-values-view': 'fixed', 'g-components': 'fixed' }, controls: {}, allowsPreview: false, allowsPlayback: false, allowsNavigation: false },
  ],
  transitions: [{ id: 't-close', from: 'explore', to: 'closed', label: 'Finish' }],
  initialStage: 'explore',
  alternatives: [
    { id: 'alt-values', kind: 'description', group: 'g-alternatives', label: 'Text description', covers: ['scene'], equivalence: 'equivalent', description: 'Direction described in words with exact components and angles.', verifiedBy: 'tests/activity/projection.test.ts#scene-description' },
    { id: 'alt-projection', kind: 'projection-2d', group: 'g-alternatives', label: 'Plane projections', covers: ['scene', 'm-arrow'], equivalence: 'partial', description: 'Projections onto the x–y and x–z planes.', verifiedBy: 'manual-check:projection-views' },
  ],
  taskFamilies: [{ id: 'tf-orientation', description: 'Relate spherical angles to Cartesian components.', hostOwned: true }],
  content: [{ id: 'note-convention', kind: 'assumption', text: 'Angles follow the physics convention: θ from +z, φ from +x toward +y.' }],
};

export const QUADRATIC_TEMPLATE: TemplateRef = templateRef(quadraticTemplate );
export const ORIENTATION_TEMPLATE: TemplateRef = templateRef(orientationTemplate );
const groupDigest = (groupId: string) => ({ groupId, contentDigest: groupContentDigest(quadraticTemplate , quadraticManifest , groupId) });
const TRAJECTORY = groupDigest('g-trajectory');
const POSITION = groupDigest('g-position');
const RULE = groupDigest('g-rule');
const TABLE = groupDigest('g-table');

// ---------------------------------------------------------------------------------------------
// Policy, review, instance
// ---------------------------------------------------------------------------------------------
const ACTIVITY = 'act-quadratic-0001';
export const approvedPolicy: HostPolicy = {
  contract: CONTRACTS.policy, schemaVersion: '1.0', policyId: 'policy-unit-4', revision: 3, issuedAt: '2026-10-26T09:00:00Z', expiresAt: '2026-10-26T17:00:00Z',
  revoked: false, mode: 'approved', approved: [{ template: QUADRATIC_TEMPLATE, model: QUADRATIC_MODEL }],
  allowedTools: ['discover', 'prepare', 'inspect.learner', 'request-reveal', 'operate.parameters', 'operate.navigation', 'operate.playback', 'operate.presentation', 'summarize', 'save', 'restore', 'close'],
  visibleGroups: ['g-plot', 'g-landscape', 'g-trajectory', 'g-position', 'g-multiplier', 'g-values', 'g-equation-view', 'g-rule', 'g-table', 'g-controls', 'g-alternatives', 'g-notes'],
  permittedControls: ['eta', 'x0', 'a'],
  export: { learnerSnapshot: true, capture: true, backup: true },
  inspection: { developer: false, tutor: 'learner-visible', teacher: true },
  independentTask: { active: false, taskRef: null, permittedTools: ['inspect.learner'], neutralScaffold: ['g-plot', 'g-landscape'] },
  sampling: { allowed: false, maxPositions: 0 },
  exploratory: { allowed: false, maxParametersOverride: 0 },
};

export const independentPolicy: HostPolicy = {
  contract: CONTRACTS.policy, schemaVersion: '1.0', policyId: 'policy-unit-4', revision: 5, issuedAt: '2026-10-26T10:15:30.250+01:00', expiresAt: null,
  revoked: false, mode: 'exploratory', approved: [{ template: QUADRATIC_TEMPLATE, model: QUADRATIC_MODEL }, { template: ORIENTATION_TEMPLATE, model: ORIENTATION_MODEL }],
  allowedTools: ['discover', 'inspect.learner', 'operate.presentation', 'summarize', 'save', 'sample', 'compose.exploratory'],
  visibleGroups: ['g-plot', 'g-landscape', 'g-controls', 'g-alternatives'], permittedControls: ['x0'],
  export: { learnerSnapshot: true, capture: false, backup: true },
  inspection: { developer: false, tutor: 'learner-visible', teacher: false },
  independentTask: { active: true, taskRef: 'task-regime-quiz-2', permittedTools: ['inspect.learner', 'operate.presentation'], neutralScaffold: ['g-plot', 'g-landscape'] },
  sampling: { allowed: true, maxPositions: 50 },
  exploratory: { allowed: true, maxParametersOverride: 2 },
};

export const modelReview: ReviewRecord = {
  contract: CONTRACTS.review, schemaVersion: '1.0', reviewId: 'review-model-quadratic-1',
  subject: { kind: 'model', modelId: 'quadratic-descent', version: '1.0.0', scientificRevision: modelIdentity(quadraticManifest).scientificRevision },
  reviewer: { name: 'A. Reviewer', role: 'Mathematics content reviewer', affiliation: 'Example University' }, date: '2026-10-20',
  scope: 'Closed-form iterates, regime classification and numerical-limit statuses for the declared parameter domain.',
  limitations: ['Does not cover learning effects of the activity.'], referenceSuiteDigest: quadraticManifest.referenceSuite!.digest, outcome: 'approved-with-limitations',
};
export const templateReview: ReviewRecord = {
  contract: CONTRACTS.review, schemaVersion: '1.0', reviewId: 'review-template-quadratic-1',
  subject: { kind: 'template', templateId: QUADRATIC_TEMPLATE.templateId, version: QUADRATIC_TEMPLATE.version, contentDigest: QUADRATIC_TEMPLATE.digest },
  reviewer: { name: 'B. Teacher', role: 'Instructional content reviewer' }, date: '2026-10-21',
  scope: 'Learner-facing text, stage visibility and accessible equivalents.', limitations: [], referenceSuiteDigest: fake('quadratic-template-checks'), outcome: 'approved',
};

const response = (responseId: string, status: ResponseRef['status'], extra: Partial<ResponseRef> = {}): ResponseRef =>
  ({ responseId, taskId: 'task-regime-1', taskRevision: 1, kind: 'prediction', modality: 'text', stageId: 'predict', status, ...extra });
export const predictInstance: ActivityInstance = {
  contract: CONTRACTS.instance, schemaVersion: '1.0', activityId: ACTIVITY, objectiveIds: ['obj-descent-regimes'], hostSessionId: 'session-7f3a', hostSessionRevision: 4,
  template: QUADRATIC_TEMPLATE, model: QUADRATIC_MODEL, initialParameters: { a: 1, eta: 0.5, x0: 8 }, mode: 'approved',
  stage: { id: 'predict', enteredAtSequence: 3 }, activityRevision: 2, policy: { policyId: 'policy-unit-4', revision: 3 }, context: { kind: 'instructional' },
  responses: [], allowedActions: ['operate.parameters', 'operate.presentation', 'request-reveal', 'save'], persistence: 'saved', closed: false,
};
export const independentInstance: ActivityInstance = {
  ...predictInstance, stage: { id: 'explain', enteredAtSequence: 57 }, activityRevision: 9, policy: { policyId: 'policy-unit-4', revision: 5 },
  context: { kind: 'independent', taskRef: 'task-regime-quiz-2' }, hostSessionRevision: 11, mode: 'exploratory',
  responses: [response('resp-1', 'superseded', { supersededBy: 'resp-2' }), response('resp-2', 'submitted', { modality: 'speech-derived' }),
    response('resp-3', 'submitted', { kind: 'explanation', modality: 'text', stageId: 'explain', taskId: 'task-explain-1' })],
  allowedActions: ['operate.presentation', 'save'], persistence: 'pending-recovery',
};

// ---------------------------------------------------------------------------------------------
// Snapshots, exposure, receipts
// ---------------------------------------------------------------------------------------------
const RUNTIME = { id: 'explorable-models-activity', version: '0.3.0-preview.1' };
export const quadraticScientific: ScientificSnapshot = {
  contract: CONTRACTS.scientific, schemaVersion: '1.0', model: QUADRATIC_MODEL, scientificRevision: modelIdentity(quadraticManifest).scientificRevision,
  runtime: RUNTIME, runId: 'run-0002', params: { a: 1, eta: 1.5, x0: 8 }, position: { kind: 'index', index: 3, maxIndex: 1000 }, terminal: false,
  comparisons: [{ runId: 'run-0001', label: 'η = 0.5', params: { a: 1, eta: 0.5, x0: 8 }, position: { kind: 'index', index: 12, maxIndex: 1000 } }],
};
export const orientationScientific: ScientificSnapshot = {
  contract: CONTRACTS.scientific, schemaVersion: '1.0', model: ORIENTATION_MODEL, scientificRevision: modelIdentity(orientationManifest).scientificRevision,
  runtime: RUNTIME, runId: 'run-orient-7', restoredFrom: 'artifact-orient-1', params: { theta: PI / 3, phi: -PI / 4 }, position: { kind: 'static' }, terminal: true, comparisons: [],
};
export const quadraticPresentation: PresentationSnapshot = {
  contract: CONTRACTS.presentation, schemaVersion: '1.0', revision: 2,
  views: { plot: { camera: { kind: '2d', center: [0, 25], zoom: 1 }, layers: ['g-landscape', 'g-trajectory'] }, values: { camera: null, layers: [] } },
  selection: 'm-point', layout: 'card', displayUnits: { eta: 'dimensionless', x0: 'dimensionless' }, locale: 'en-GB', formatVersion: '1.0',
};
export const orientationPresentation: PresentationSnapshot = {
  contract: CONTRACTS.presentation, schemaVersion: '1.0', revision: 14,
  views: { scene: { camera: { kind: '3d', projection: 'perspective', position: [3, -3, 2.5], target: [0, 0, 0], up: [0, 0, 1], preset: 'iso-front' }, layers: ['g-vector', 'g-frame'] } },
  selection: null, layout: 'expanded', displayUnits: { theta: 'deg', phi: 'deg' }, locale: 'en-US', formatVersion: '1.0',
};

export const revealGrant: ExposureGrant = { exposureId: 'exp-0001', scope: 'reveal', groups: [TRAJECTORY, POSITION] };
export const explorationGrant: ExposureGrant = { exposureId: 'exp-0002', scope: 'exploration', groups: [TRAJECTORY, POSITION, RULE], parameterDomain: { eta: [0, 2], x0: [-10, 10] } };
const receiptBase = {
  schemaVersion: '1.0', activityId: ACTIVITY, basedOnActivityRevision: 2, activityRevision: 3, policyId: 'policy-unit-4', policyRevision: 3,
  template: QUADRATIC_TEMPLATE, model: QUADRATIC_MODEL, issuedAt: '2026-10-26T09:12:04.120Z', expiresAt: null,
} as const;
export const revealReceipt: ExposureReceipt = { ...receiptBase, contract: CONTRACTS.exposureReceipt, receiptId: 'rcpt-reveal-1', idempotencyKey: 'op-reveal-1', grant: revealGrant, intendedStage: 'explore' };
export const explorationReceipt: ExposureReceipt = { ...receiptBase, contract: CONTRACTS.exposureReceipt, receiptId: 'rcpt-explore-1', idempotencyKey: 'op-explore-1', basedOnActivityRevision: 3, activityRevision: 4, expiresAt: '2026-10-26T12:00:00Z', grant: explorationGrant, intendedStage: 'explore' };
export const stageReceipt: StageReceipt = { ...receiptBase, contract: CONTRACTS.stageReceipt, receiptId: 'rcpt-stage-1', idempotencyKey: 'op-stage-1', fromStage: 'explore', toStage: 'explain', grant: null };
export const revealingStageReceipt: StageReceipt = { ...receiptBase, contract: CONTRACTS.stageReceipt, receiptId: 'rcpt-stage-0', idempotencyKey: 'op-stage-0', fromStage: 'predict', toStage: 'explore', grant: { ...revealGrant, scope: 'stage', exposureId: 'exp-stage-0', groups: [TRAJECTORY, POSITION, RULE, TABLE] } };
export const helpReceipt: AssistanceReceipt = { ...receiptBase, contract: CONTRACTS.assistanceReceipt, receiptId: 'rcpt-help-1', idempotencyKey: 'op-help-1', kind: 'help', grant: null };
export const reopenReceipt: AssistanceReceipt = { ...receiptBase, contract: CONTRACTS.assistanceReceipt, receiptId: 'rcpt-reopen-1', idempotencyKey: 'op-reopen-1', kind: 'reopen-instructional', grant: { ...revealGrant, exposureId: 'exp-reopen-1' } };

export const displayedExposure: ExposureRecord = {
  contract: CONTRACTS.exposure, schemaVersion: '1.0', exposureId: 'exp-0001', activityId: ACTIVITY, receiptId: 'rcpt-reveal-1', scope: 'reveal', groups: [TRAJECTORY, POSITION],
  template: QUADRATIC_TEMPLATE, model: QUADRATIC_MODEL, activityRevision: 3, intendedStage: 'explore', displayStatus: 'displayed',
  displayed: { projectionDigest: fake('projection-17'), frameId: 'frame-run-0002-i3', monotonicMs: 48213.5 },
};
export const uncertainExposure: ExposureRecord = {
  contract: CONTRACTS.exposure, schemaVersion: '1.0', exposureId: 'exp-0002', activityId: ACTIVITY, receiptId: 'rcpt-explore-1', scope: 'exploration', groups: [TRAJECTORY, POSITION, RULE],
  template: QUADRATIC_TEMPLATE, model: QUADRATIC_MODEL, activityRevision: 4, intendedStage: 'explore', parameterDomain: { eta: [0, 2], x0: [-10, 10] },
  displayStatus: 'uncertain', uncertainty: { code: 'INTERRUPTED_BEFORE_ACK', reason: 'The surface closed before the display acknowledgement was recorded; treated as potentially exposed.' },
};

// ---------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------
const revisions = { scientific: { modelDigest: QUADRATIC_MODEL.digest, runId: 'run-0002', version: 5 }, presentation: 2, activity: 3, hostSession: 4, policy: 3 };
const committedFrame = { frameId: 'frame-run-0002-i3', runId: 'run-0002', kind: 'committed', position: { kind: 'index', index: 3, maxIndex: 1000 } } as const;
export const event = (type: EventType, sequence: number, payload: Record<string, unknown>, extra: Partial<InteractionEvent> = {}): InteractionEvent => ({
  contract: CONTRACTS.event, schemaVersion: '1.0', eventId: `evt-${String(sequence).padStart(4, '0')}`, activityId: ACTIVITY, sequence, operationId: `op-${sequence}`,
  actor: { kind: 'learner', binding: 'surface-main' }, type, revisions, payload, monotonicMs: 1000 + sequence * 250.5, causes: [], ...extra,
});
const visible = { x: { status: 'valid', value: -4 }, loss: { status: 'valid', value: 8 } };
export const EVENTS: Record<string, InteractionEvent> = {
  'parameters-committed': event('parameters.committed', 21, { runId: 'run-0002', previousRunId: 'run-0001', params: { a: 1, eta: 1.5, x0: 8 }, cause: 'commit', previewId: 'pv-3', gesture: 'pointer', visibleQuantities: visible }, { frame: { ...committedFrame, position: { kind: 'index', index: 0, maxIndex: 1000 } }, causes: ['evt-0020'] }),
  'preview-started': event('preview.started', 18, { previewId: 'pv-3', baseRunId: 'run-0001', parameter: 'eta', gesture: 'pointer' }),
  'preview-observed': event('preview.observed', 20, { previewId: 'pv-3', outcome: 'committed', samplingPolicy: 'first-last-evenly-spaced', rendered: [{ params: { a: 1, eta: 0.6, x0: 8 }, frameId: 'frame-pv-3-1' }, { params: { a: 1, eta: 1.5, x0: 8 }, frameId: 'frame-pv-3-9', visibleQuantities: { x: { status: 'valid', value: 8 } } }], omitted: 7 }, { frame: { frameId: 'frame-pv-3-9', runId: 'run-0001', kind: 'tentative', position: { kind: 'index', index: 0, maxIndex: 1000 } } }),
  'preview-cancelled': event('preview.cancelled', 19, { previewId: 'pv-2', reason: 'escape' }),
  'reveal-requested': event('reveal.requested', 10, { idempotencyKey: 'op-reveal-1', scope: 'reveal', groups: [TRAJECTORY, POSITION], intendedStage: 'explore' }, { actor: { kind: 'tutor', binding: 'tool-executor-1' } }),
  'reveal-authorized': event('reveal.authorized', 11, { exposureId: 'exp-0001', receiptId: 'rcpt-reveal-1', scope: 'reveal', groups: [TRAJECTORY, POSITION], activityRevision: 3 }, { actor: { kind: 'host', binding: 'host-api' }, causes: ['evt-0010'] }),
  'reveal-displayed': event('reveal.displayed', 12, { exposureId: 'exp-0001', receiptId: 'rcpt-reveal-1', projectionDigest: fake('projection-17'), frameId: 'frame-run-0002-i3', surfaceId: 'surface-main' }, { frame: committedFrame }),
  'reveal-uncertain': event('reveal.uncertain', 13, { exposureId: 'exp-0002', receiptId: 'rcpt-explore-1', code: 'INTERRUPTED_BEFORE_ACK', reason: 'Restored without a persisted display acknowledgement.' }, { actor: { kind: 'host', binding: 'host-api' } }),
  'exposure-scope-authorized': event('exposure.scope-authorized', 14, { exposureId: 'exp-0002', receiptId: 'rcpt-explore-1', scope: 'exploration', groups: [TRAJECTORY], activityRevision: 4, parameterDomain: { eta: [0, 2] } }, { actor: { kind: 'host', binding: 'host-api' } }),
  'stage-changed': event('stage.changed', 15, { fromStage: 'predict', toStage: 'explore', receiptId: 'rcpt-stage-0', activityRevision: 3, transitionId: 't-reveal' }, { actor: { kind: 'host', binding: 'host-stage-button' } }),
  'response-submitted': event('response.submitted', 9, { response: response('resp-1', 'submitted') }, { actor: { kind: 'host', binding: 'host-api' } }),
  'response-superseded': event('response.superseded', 30, { responseId: 'resp-1', status: 'superseded', supersededBy: 'resp-2' }, { actor: { kind: 'host', binding: 'host-api' } }),
  'position-changed': event('position.changed', 22, { runId: 'run-0002', from: { kind: 'index', index: 2, maxIndex: 1000 }, to: { kind: 'index', index: 3, maxIndex: 1000 }, cause: 'step', visibleQuantities: { ...visible, regime: { status: 'valid', value: 'alternating-convergence' } } }, { frame: committedFrame }),
  'playback-paused': event('playback.paused', 23, { runId: 'run-0002', position: { kind: 'index', index: 3, maxIndex: 1000 } }),
  'comparison-retained': event('comparison.retained', 24, { runId: 'run-0001', label: 'η = 0.5' }),
  'view-changed': event('view.changed', 25, { change: 'display-unit', presentationRevision: 2, parameter: 'eta', unit: 'dimensionless' }),
  'assistance-recorded': event('assistance.recorded', 31, { receiptId: 'rcpt-help-1', kind: 'help' }, { actor: { kind: 'host', binding: 'host-api' } }),
  'context-independent-entered': event('context.independent-entered', 40, { taskRef: 'task-regime-quiz-2', policyRevision: 5 }, { actor: { kind: 'host', binding: 'host-api' } }),
  'artifact-saved': event('artifact.saved', 41, { artifactId: 'artifact-0001', kind: 'backup', artifactDigest: fake('artifact-0001'), cursor: 40 }, { actor: { kind: 'host', binding: 'host-api' } }),
  'artifact-restored': event('artifact.restored', 42, { artifactId: 'artifact-0001', kind: 'backup', artifactDigest: fake('artifact-0001'), restored: 'restricted', migratedFrom: { contract: 'study-harness.activity-artifact', version: '1.0' } }, { actor: { kind: 'host', binding: 'host-api' } }),
  'operation-failed': event('operation.failed', 26, { operation: 'commitParameters', code: 'CONSTRAINT_VIOLATION', recoverable: true, path: '$.eta' }),
  'activity-opened': event('activity.opened', 2, { stageId: 'predict' }, { actor: { kind: 'host', binding: 'host-api' } }),
  'help-requested': event('help.requested', 29, {}),
  'activity-prepared': event('activity.prepared', 1, { templateId: 'quadratic-gradient-descent', templateVersion: '1.0.0', mode: 'approved', stageId: 'predict' }, { actor: { kind: 'host', binding: 'host-api' } }),
  'activity-closed': event('activity.closed', 60, { reason: 'The host closed the instructional view.', pending: 'retain' }, { actor: { kind: 'host', binding: 'host-api' } }),
  'activity-suspended': event('activity.suspended', 32, { reason: 'hidden' }),
  'activity-resumed': event('activity.resumed', 33, {}),
  'content-revoked': event('content.revoked', 61, { source: 'catalogue', code: 'CONTENT_REVOKED' }, { actor: { kind: 'host', binding: 'host-api' } }),
  'operation-failed-lost': event('operation.failed', 34, { operation: 'appendEvents', code: 'PERSISTENCE_BACKPRESSURE', recoverable: false, lost: { count: 2, types: ['activity.suspended', 'activity.resumed'], afterSequence: 31 } }, { actor: { kind: 'host', binding: 'host-api' } }),
};

// ---------------------------------------------------------------------------------------------
// Summary and artifacts
// ---------------------------------------------------------------------------------------------
export const tutorSummary: InteractionSummary = {
  contract: CONTRACTS.summary, schemaVersion: '1.0', summarizerVersion: '1.0.0', activityId: ACTIVITY, audience: 'tutor', template: QUADRATIC_TEMPLATE, model: QUADRATIC_MODEL,
  cursor: { fromSequence: 1, toSequence: 42, acknowledgedThrough: 40 }, complete: false,
  committedConfigurations: [
    { runId: 'run-0001', params: { a: 1, eta: 0.5, x0: 8 }, furthestPosition: { kind: 'index', index: 12, maxIndex: 1000 }, cause: 'initial', sequence: 2, observations: { x: { status: 'valid', value: 0.001953125 }, loss: { status: 'valid', value: 0.0000019073486328125 } } },
    { runId: 'run-0002', params: { a: 1, eta: 1.5, x0: 8 }, furthestPosition: { kind: 'index', index: 3, maxIndex: 1000 }, cause: 'commit', sequence: 21, observations: { x: { status: 'valid', value: -1 }, regime: { status: 'valid', value: 'alternating-convergence' } } },
  ],
  previewObservations: [{ previewId: 'pv-3', outcome: 'committed', samplingPolicy: 'first-last-evenly-spaced', rendered: [{ params: { a: 1, eta: 0.6, x0: 8 }, frameId: 'frame-pv-3-1' }, { params: { a: 1, eta: 1.5, x0: 8 }, frameId: 'frame-pv-3-9' }], omitted: 7 }],
  revealed: [{ exposureId: 'exp-0001', groups: ['g-trajectory', 'g-position'], displayStatus: 'displayed', sequence: 12 }, { exposureId: 'exp-0002', groups: ['g-trajectory'], displayStatus: 'uncertain', sequence: 14 }],
  comparisons: [{ runId: 'run-0001', label: 'η = 0.5', action: 'retained', sequence: 24 }],
  responses: [response('resp-1', 'superseded', { supersededBy: 'resp-2' }), response('resp-2', 'submitted')],
  omitted: { committedConfigurations: 0, previewObservations: 0, events: 0 },
  limitations: ['Events 41–42 are not yet acknowledged by the host.', 'Exposure exp-0002 is uncertain and counted as potentially seen.'],
  text: 'Explored 2 committed configurations of gradient descent on a quadratic loss. 1 preview was committed. Revealed content: descent path, position and loss.',
};
export const learnerSummary: InteractionSummary = {
  ...tutorSummary, audience: 'learner', cursor: { fromSequence: 1, toSequence: 12, acknowledgedThrough: 12 }, complete: true,
  committedConfigurations: [{ runId: 'run-0001', params: { a: 1, eta: 0.5, x0: 8 }, furthestPosition: null, cause: 'initial', sequence: 2, observations: { loss: { status: 'undefined', code: 'NOT_VISIBLE_YET', reason: 'Not shown in this stage.' }, x: { status: 'numerical-limit', code: 'UNDERFLOW', reason: 'Too small to represent.', lastFiniteIndex: 1000 } } }],
  previewObservations: [], revealed: [{ exposureId: 'exp-0001', groups: ['g-trajectory', 'g-position'], displayStatus: 'displayed', sequence: 12 }], comparisons: [], responses: [],
  limitations: [], text: 'Explored 1 committed configuration of gradient descent on a quadratic loss.',
};

export const emptyCursor: JournalCursor = { activityId: ACTIVITY, lastSequence: 0, lastEventId: null, checkpointDigest: null };
export const cursor: JournalCursor = { activityId: ACTIVITY, lastSequence: 40, lastEventId: 'evt-0040', checkpointDigest: fake('checkpoint-40') };

const artifactBody: Omit<ActivityArtifact, 'integrity'> = {
  contract: CONTRACTS.artifact, schemaVersion: '1.0', artifactId: 'artifact-0001', kind: 'backup',
  schemas: [CONTRACTS.artifact, CONTRACTS.instance, CONTRACTS.scientific, CONTRACTS.presentation, CONTRACTS.exposure].map(contract => ({ contract, version: '1.0' })),
  runtime: RUNTIME, template: QUADRATIC_TEMPLATE, model: QUADRATIC_MODEL, policyRef: { policyId: 'policy-unit-4', revision: 3 },
  instance: { ...predictInstance, stage: { id: 'explore', enteredAtSequence: 15 }, activityRevision: 4 }, scientific: quadraticScientific, presentation: quadraticPresentation,
  exposures: [displayedExposure, uncertainExposure], journal: { cursor, pendingEventIds: ['evt-0041', 'evt-0042'] }, pending: { kind: 'none' },
  contentRefs: ['note-derivation', 'note-assumption'], reviewRefs: ['review-model-quadratic-1'],
};
export const backupArtifact: ActivityArtifact = { ...artifactBody, integrity: artifactIntegrity(artifactBody) };
/** Backup that lists its assistance receipts: a help request and a reopen whose grant created exposure exp-reopen-1. */
export const reopenedExposure: ExposureRecord = { ...displayedExposure, exposureId: 'exp-reopen-1', receiptId: 'rcpt-reopen-1', activityRevision: 4 };
const assistedBody: Omit<ActivityArtifact, 'integrity'> = {
  ...artifactBody, artifactId: 'artifact-0003', exposures: [displayedExposure, uncertainExposure, reopenedExposure],
  assistance: [
    { receiptId: 'rcpt-help-1', kind: 'help', sequence: 31, grant: null },
    { receiptId: 'rcpt-reopen-1', kind: 'reopen-instructional', sequence: 35, grant: { exposureId: 'exp-reopen-1', groups: ['g-trajectory', 'g-position'] } },
  ],
};
export const assistedBackupArtifact: ActivityArtifact = { ...assistedBody, integrity: artifactIntegrity(assistedBody) };
/** Backup saved in an independent context: unacknowledged events carried for a restore, one loss record, an ended grant. */
const lineageBody: Omit<ActivityArtifact, 'integrity'> = {
  ...artifactBody, artifactId: 'artifact-0004',
  schemas: [CONTRACTS.artifact, CONTRACTS.instance, CONTRACTS.scientific, CONTRACTS.presentation, CONTRACTS.exposure, CONTRACTS.event].map(contract => ({ contract, version: '1.0' })),
  instance: { ...independentInstance, mode: 'approved', persistence: 'pending-recovery' }, policyRef: independentInstance.policy,
  journal: {
    cursor, pendingEventIds: ['evt-0041', 'evt-0042'],
    pendingEvents: [event('activity.suspended', 41, { reason: 'hidden' }), event('activity.resumed', 42, {})],
    lost: { count: 1, types: ['reveal.displayed'], afterSequence: 38 },
  },
  lineage: { endedExposureIds: ['exp-0001'], reopenRequired: true },
};
export const lineageBackupArtifact: ActivityArtifact = { ...lineageBody, integrity: artifactIntegrity(lineageBody) };
const snapshotBody: Omit<ActivityArtifact, 'integrity'> = {
  ...artifactBody, artifactId: 'artifact-0002', kind: 'learner-snapshot', schemas: [CONTRACTS.artifact, CONTRACTS.instance, CONTRACTS.scientific, CONTRACTS.presentation].map(contract => ({ contract, version: '1.0' })),
  exposures: [], journal: { cursor: emptyCursor, pendingEventIds: [] }, pending: { kind: 'preview', previewId: 'pv-4', params: { a: 1, eta: 1.9, x0: 8 }, baseRunId: 'run-0002' },
  contentRefs: [], reviewRefs: [],
  migratedFrom: { contract: 'study-harness.activity-artifact', version: '1.0', digest: fake('artifact-0002-original'), report: ['No semantic change: identity copy used to exercise the migration record.'] },
};
export const snapshotArtifact: ActivityArtifact = { ...snapshotBody, integrity: artifactIntegrity(snapshotBody) };

// ---------------------------------------------------------------------------------------------
// Host-port messages
// ---------------------------------------------------------------------------------------------
const guard = { activityId: ACTIVITY, basedOnActivityRevision: 2, expectedPolicyRevision: 3, template: QUADRATIC_TEMPLATE, model: QUADRATIC_MODEL } as const;
export const MESSAGE_EXEMPLARS = {
  activityRequest: [
    { activityId: ACTIVITY, objectiveIds: ['obj-descent-regimes'], hostSessionId: 'session-7f3a', hostSessionRevision: 4, template: { templateId: QUADRATIC_TEMPLATE.templateId, version: '1.0.0' }, parameters: { eta: 0.5, x0: 8, a: 1 }, mode: 'approved' },
    { activityId: 'act-orient-0003', objectiveIds: [], hostSessionId: 'session-7f3a', hostSessionRevision: 0, template: { templateId: ORIENTATION_TEMPLATE.templateId, version: '1.2.0' }, scenarioId: 's-equator', mode: 'exploratory', stageId: 'explore' },
  ] satisfies ActivityRequest[],
  stageTransitionRequest: [
    { ...guard, operationId: 'op-stage-1', idempotencyKey: 'op-stage-1', fromStage: 'explore', toStage: 'explain', actor: 'host', groups: [] },
    { ...guard, operationId: 'op-stage-0', idempotencyKey: 'op-stage-0', fromStage: 'predict', toStage: 'explore', actor: 'tutor', groups: [TRAJECTORY, POSITION, RULE, TABLE] },
  ] satisfies StageTransitionRequest[],
  exposureIntentRequest: [
    { ...guard, operationId: 'op-reveal-1', idempotencyKey: 'op-reveal-1', scope: 'reveal', groups: [TRAJECTORY, POSITION], intendedStage: 'explore', actor: 'tutor' },
    { ...guard, operationId: 'op-explore-1', idempotencyKey: 'op-explore-1', basedOnActivityRevision: 3, scope: 'exploration', groups: [TRAJECTORY, POSITION, RULE], parameterDomain: { eta: [0, 2], x0: [-10, 10] }, intendedStage: 'explore', actor: 'learner' },
  ] satisfies ExposureIntentRequest[],
  displayAckRequest: [
    { activityId: ACTIVITY, exposureId: 'exp-0001', receiptId: 'rcpt-reveal-1', projectionDigest: fake('projection-17'), frameId: 'frame-run-0002-i3', monotonicMs: 48213.5 },
    { activityId: ACTIVITY, exposureId: 'exp-0002', receiptId: 'rcpt-explore-1', projectionDigest: fake('projection-23'), frameId: 'frame-pv-5-2', monotonicMs: 0 },
  ] satisfies DisplayAckRequest[],
  assistanceRequest: [
    { ...guard, operationId: 'op-help-1', idempotencyKey: 'op-help-1', kind: 'help', actor: 'learner', groups: [] },
    { ...guard, operationId: 'op-reopen-1', idempotencyKey: 'op-reopen-1', kind: 'reopen-instructional', actor: 'host', groups: [TRAJECTORY, POSITION] },
  ] satisfies AssistanceRequest[],
  appendEventsRequest: [
    { activityId: ACTIVITY, events: [EVENTS['activity-opened']!] },
    { activityId: ACTIVITY, events: [EVENTS['preview-started']!, EVENTS['preview-cancelled']!, EVENTS['preview-observed']!, EVENTS['parameters-committed']!, EVENTS['position-changed']!] },
  ] satisfies SchemaTypes['study-harness.append-events-request'][],
  appendResult: [
    { acknowledged: [{ eventId: 'evt-0002', durableSequence: 2, hostTimestamp: '2026-10-26T09:01:00Z' }], duplicates: [], cursor: { ...cursor, lastSequence: 2, lastEventId: 'evt-0002' } },
    { acknowledged: [{ eventId: 'evt-0020', durableSequence: 20, hostTimestamp: '2026-10-26T09:20:01.5Z' }, { eventId: 'evt-0021', durableSequence: 21, hostTimestamp: '2026-10-26T09:20:01.5Z' }], duplicates: ['evt-0019'], cursor: { ...cursor, lastSequence: 21, lastEventId: 'evt-0021' } },
  ] satisfies AppendResult[],
  journalCursor: [emptyCursor, cursor] satisfies JournalCursor[],
  registerActivityRequest: [{ instance: predictInstance, operationId: 'op-prepare-1' }, { instance: independentInstance, operationId: 'op-prepare-9' }] satisfies SchemaTypes['study-harness.register-activity-request'][],
  saveArtifactRequest: [{ artifact: backupArtifact, operationId: 'op-save-1' }, { artifact: snapshotArtifact, operationId: 'op-save-2' }] satisfies SchemaTypes['study-harness.save-artifact-request'][],
  activityLookupRequest: [{ activityId: ACTIVITY }, { activityId: 'act-orient-0003' }] satisfies SchemaTypes['study-harness.activity-lookup-request'][],
  hostAck: [{ ok: true, hostTimestamp: '2026-10-26T09:01:00Z' }, { ok: true, hostTimestamp: '2026-10-26T09:41:10.000123-05:00', artifactDigest: fake('artifact-0001') }] satisfies (HostAck & { artifactDigest?: string })[],
  activityRecords: [
    { activityId: ACTIVITY, exposures: [], assistance: [] },
    { activityId: ACTIVITY, exposures: [displayedExposure, uncertainExposure, reopenedExposure], assistance: [{ receiptId: 'rcpt-help-1', kind: 'help', sequence: 31, grant: null }, { receiptId: 'rcpt-reopen-1', kind: 'reopen-instructional', sequence: 35, grant: { exposureId: 'exp-reopen-1', groups: ['g-trajectory', 'g-position'] } }] },
    { activityId: ACTIVITY, exposures: [displayedExposure], assistance: [], activity: { stage: 'explore', activityRevision: 3, closed: false } },
    {
      activityId: ACTIVITY, exposures: [displayedExposure], assistance: [],
      activity: { stage: 'explore', activityRevision: 3, closed: false, lineage: { context: { kind: 'independent', taskRef: 'task-quiz' }, fromActivityRevision: 4 }, stageReceiptId: 'rcpt-stage-2' },
    },
  ] satisfies ActivityRecords[],
};

const ASTRAL_LABEL = '\u{1F600}'.repeat(200);
const ASTRAL_TEXT = '\u{1F9EE}'.repeat(4000);

export interface Exemplar<N extends SchemaName> { case: string; why: string; value: SchemaTypes[N] }
const cases = <N extends SchemaName>(...items: [string, string, SchemaTypes[N]][]): Exemplar<N>[] => items.map(([name, why, value]) => ({ case: name, why, value }));

/** Valid exemplars per schema: realistic, internally consistent, and including Unicode-limit cases. */
export const EXEMPLARS: { [N in SchemaName]: Exemplar<N>[] } = {
  [CONTRACTS.template]: cases(
    ['quadratic-2d', 'Three-stage 2D activity with reveal groups, drag with exact entry, scenarios and equivalents.', quadraticTemplate],
    ['orientation-3d', '3D activity with degree display units for radian parameters and a partial projection plus an equivalent description.', orientationTemplate],
    ['quantity-display-units', 'Optional per-quantity display units: a radian quantity shown in degrees by default, radians selectable.', ({ ...quadraticTemplate, quantityDisplay: { angle: { units: ['deg', 'rad'] } } })],
    ['astral-title-at-limit', 'Title of exactly 200 astral code points (400 UTF-16 units) is within the 200 code point limit.', ({ ...quadraticTemplate, title: ASTRAL_LABEL })],
    ['control-sections', 'Optional control presentation sections: related controls share a labelled section (presentation only).', ({
      ...quadraticTemplate, controls: quadraticTemplate.controls.map((control, index) => ({ ...control, section: index === 0 ? { id: 'step', label: 'Step size' } : { id: 'start', label: 'Starting point' } })),
    })],
  ),
  [CONTRACTS.instance]: cases(['instructional-predict', 'Fresh instructional instance in the predict stage.', predictInstance], ['independent-with-responses', 'Independent context with superseded and current responses.', independentInstance]),
  [CONTRACTS.policy]: cases(['approved', 'Approved-mode policy with an expiry and full export.', approvedPolicy], ['independent-exploratory', 'Exploratory policy with an active independent task and sampling.', independentPolicy]),
  [CONTRACTS.scientific]: cases(
    ['discrete-with-comparison', 'Discrete run at index 3 with one retained comparison.', quadraticScientific],
    ['static-restored', 'Static run restored from an artifact.', orientationScientific],
    ['astral-comparison-label', 'Comparison label of exactly 200 astral code points.', ({ ...quadraticScientific, comparisons: [{ ...quadraticScientific.comparisons[0], label: ASTRAL_LABEL }] })],
  ),
  [CONTRACTS.presentation]: cases(['camera-2d', '2D camera and a camera-less values view.', quadraticPresentation], ['camera-3d', 'Perspective 3D camera with degree display units.', orientationPresentation]),
  [CONTRACTS.event]: cases(
    ...Object.entries(EVENTS).map(([name, value]): [string, string, InteractionEvent] => [name, `Valid ${value.type} event.`, value]),
    ['astral-comparison-label', 'Comparison label of exactly 200 astral code points.', event('comparison.retained', 27, { runId: 'run-0002', label: ASTRAL_LABEL })],
    ['payload-near-byte-limit', 'Payload of 8190 counted bytes (a 2714-code-point reason of 3-byte characters), just under the 8 KiB event payload bound.', event('content.revoked', 50, { source: 'host', code: 'POLICY_DENIED', reason: '\u20AC'.repeat(2714) })],
    ['position-changed-extreme-values', 'Visible values beyond the ±1e15 contract-number range, the largest finite double and a subnormal: any finite double is a valid quantity value (D10).', event('position.changed', 28, {
      runId: 'run-0002', from: { kind: 'index', index: 39, maxIndex: 1000 }, to: { kind: 'index', index: 40, maxIndex: 1000 }, cause: 'step',
      visibleQuantities: {
        x: { status: 'valid', value: 121576654590569280000 }, loss: { status: 'valid', value: Number.MAX_VALUE }, gradient: { status: 'valid', value: -Number.MAX_VALUE },
        tiny: { status: 'valid', value: Number.MIN_VALUE, approximation: { code: 'UNDERFLOW', reason: 'Subnormal value with reduced precision.' } },
      },
    }, { frame: { ...committedFrame, position: { kind: 'index', index: 40, maxIndex: 1000 } } })],
    ['playback-ended-numerical-limit', 'Playback that stopped by itself one step before a numerical limit, with its reason (additive in 1.0).', event('playback.ended', 35, { runId: 'run-0002', position: { kind: 'index', index: 643, maxIndex: 1000 }, reason: 'numerical-limit' })],
    ['parameters-committed-visible-parameters', 'A commit recording the parameters shown as controls when it happened (additive in 1.0).', event('parameters.committed', 36, { runId: 'run-0003', previousRunId: 'run-0002', params: { a: 1, eta: 0.75, x0: 8 }, cause: 'commit', gesture: 'exact', visibleParameters: ['a', 'eta', 'x0'] })],
    ['preview-observed-visible-parameters', 'A preview record listing the parameters shown as controls during the preview (additive in 1.0).', event('preview.observed', 37, { previewId: 'pv-4', outcome: 'cancelled', samplingPolicy: 'first-last-evenly-spaced', rendered: [{ params: { a: 1, eta: 0.6, x0: 8 }, frameId: 'frame-pv-4-1' }], omitted: 0, visibleParameters: ['eta'] })],
  ),
  [CONTRACTS.exposure]: cases(
    ['displayed', 'Displayed reveal with the acknowledged projection digest.', displayedExposure],
    ['uncertain', 'Exploration exposure restored as uncertain.', uncertainExposure],
    ['astral-reason-at-limit', 'Uncertainty reason of exactly 4000 astral code points.', ({ ...uncertainExposure, uncertainty: { code: 'SURFACE_LOST', reason: ASTRAL_TEXT } })],
    ['displayed-interval-ended', 'Displayed reveal whose observed display interval ended with a stage change.', ({ ...displayedExposure, displayed: { ...displayedExposure.displayed!, endedMonotonicMs: 91200.25, endedBy: 'stage' } })],
  ),
  [CONTRACTS.summary]: cases(
    ['tutor-incomplete', 'Tutor summary with unacknowledged events and an uncertain exposure.', tutorSummary],
    ['learner-complete', 'Learner summary with undefined and numerical-limit observations.', learnerSummary],
    ['exploratory-mode', 'Exploratory-mode summary stating its mode and the host-resolved review notice (additive in 1.0).', ({
      ...learnerSummary, mode: 'exploratory', reviewNotice: 'Exploratory composition — not reviewed',
      text: 'Summary of events 1–12. This was an exploratory composition: it is not reviewed, and its results are not reviewed assessment content. Recorded 1 committed configuration.',
    })],
    ['matrix-observation-at-limit', 'A 64×64 matrix observation (4096 numbers, the largest manifest quantity) with values beyond ±1e15.', ({
      ...tutorSummary, committedConfigurations: [{ ...tutorSummary.committedConfigurations[1]!, observations: { m: { status: 'valid', value: Array.from({ length: 4096 }, (_, index) => (index % 2 ? -1 : 1) * 2 ** (index % 64) * 1e15) } } }],
    })],
  ),
  [CONTRACTS.artifact]: cases(
    ['backup', 'Backup with exposures, pending journal events and integrity manifest.', backupArtifact],
    ['learner-snapshot-pending-preview', 'Learner snapshot saved during a preview, with a migration record.', snapshotArtifact],
    ['backup-with-assistance', 'Backup listing its assistance receipts (help, and a reopen with a grant summary).', assistedBackupArtifact],
    ['backup-with-pending-events-and-lineage', 'Backup carrying its unacknowledged journal events, a journal-loss record and the context lineage (an ended grant, reopening required).', lineageBackupArtifact],
  ),
  [CONTRACTS.review]: cases(
    ['model-review', 'Model review bound to the scientific revision.', modelReview],
    ['template-review', 'Template review bound to the content digest.', templateReview],
    ['astral-reviewer-name', 'Reviewer name of exactly 200 astral code points.', ({ ...templateReview, reviewer: { name: ASTRAL_LABEL, role: 'Reviewer' } })],
  ),
  [CONTRACTS.exposureReceipt]: cases(['reveal', 'Reveal receipt for two solution-bearing groups.', revealReceipt], ['exploration', 'Exploration receipt with a parameter domain and expiry.', explorationReceipt]),
  [CONTRACTS.stageReceipt]: cases(['no-grant', 'Stage transition that reveals nothing.', stageReceipt], ['revealing', 'Stage transition carrying a stage-scoped grant.', revealingStageReceipt]),
  [CONTRACTS.assistanceReceipt]: cases(['help', 'Help request receipt without a grant.', helpReceipt], ['reopen', 'Reopen receipt with a reveal grant.', reopenReceipt]),
  [CONTRACTS.capability]: cases(
    ['spatial-3d', 'The installed spatial-3d@1.0 record: every limit exactly at its enforced maximum (additive in 1.0).', structuredClone(SPATIAL_3D_CAPABILITY)],
    ['discrete-iteration', 'The installed discrete-iteration@1.0 record (additive in 1.0).', structuredClone(DISCRETE_ITERATION_CAPABILITY)],
    ['spatial-3d-lower-limits', 'A spatial-3d@1.0 record with lower limits than the runtime maximum (a host may narrow them).', ({ ...structuredClone(SPATIAL_3D_CAPABILITY), limits: { vertices: 5000, indices: 30000, fieldSamples: 250, labels: 16, textureSize: 0, drawCallsPerFrame: 64 } })],
  ),
  [MESSAGES.activityRequest]: cases(['with-parameters', 'Approved request with explicit parameters.', MESSAGE_EXEMPLARS.activityRequest[0]!], ['with-scenario', 'Exploratory request selecting a scenario and stage.', MESSAGE_EXEMPLARS.activityRequest[1]!]),
  [MESSAGES.stageTransitionRequest]: cases(['no-groups', 'Transition revealing nothing.', MESSAGE_EXEMPLARS.stageTransitionRequest[0]!], ['revealing', 'Transition requesting four groups.', MESSAGE_EXEMPLARS.stageTransitionRequest[1]!]),
  [MESSAGES.exposureIntentRequest]: cases(['reveal', 'Reveal intent.', MESSAGE_EXEMPLARS.exposureIntentRequest[0]!], ['exploration', 'Exploration intent with a domain.', MESSAGE_EXEMPLARS.exposureIntentRequest[1]!]),
  [MESSAGES.displayAckRequest]: cases(['reveal', 'Display acknowledgement.', MESSAGE_EXEMPLARS.displayAckRequest[0]!], ['zero-time', 'Acknowledgement at the monotonic origin.', MESSAGE_EXEMPLARS.displayAckRequest[1]!]),
  [MESSAGES.assistanceRequest]: cases(['help', 'Help request.', MESSAGE_EXEMPLARS.assistanceRequest[0]!], ['reopen', 'Reopen instructional request.', MESSAGE_EXEMPLARS.assistanceRequest[1]!]),
  [MESSAGES.appendEventsRequest]: cases(['single', 'One generic-payload event.', MESSAGE_EXEMPLARS.appendEventsRequest[0]!], ['batch', 'Batch of preview and commit events.', MESSAGE_EXEMPLARS.appendEventsRequest[1]!]),
  [MESSAGES.appendResult]: cases(['single', 'One acknowledgement.', MESSAGE_EXEMPLARS.appendResult[0]!], ['with-duplicate', 'Acknowledgements and one duplicate.', MESSAGE_EXEMPLARS.appendResult[1]!]),
  [MESSAGES.journalCursor]: cases(['empty', 'Cursor before any event.', MESSAGE_EXEMPLARS.journalCursor[0]!], ['checkpoint', 'Cursor with a checkpoint.', MESSAGE_EXEMPLARS.journalCursor[1]!]),
  [MESSAGES.registerActivityRequest]: cases(['predict', 'Register a fresh instance.', MESSAGE_EXEMPLARS.registerActivityRequest[0]!], ['independent', 'Register an independent instance.', MESSAGE_EXEMPLARS.registerActivityRequest[1]!]),
  [MESSAGES.saveArtifactRequest]: cases(['backup', 'Save a backup.', MESSAGE_EXEMPLARS.saveArtifactRequest[0]!], ['snapshot', 'Save a learner snapshot.', MESSAGE_EXEMPLARS.saveArtifactRequest[1]!]),
  [MESSAGES.activityLookupRequest]: cases(['quadratic', 'Look up an activity.', MESSAGE_EXEMPLARS.activityLookupRequest[0]!], ['orientation', 'Look up another activity.', MESSAGE_EXEMPLARS.activityLookupRequest[1]!]),
  [MESSAGES.activityRecords]: cases(['empty', 'A host that holds no exposure or assistance records yet.', MESSAGE_EXEMPLARS.activityRecords[0]!], ['with-records', 'Host-held exposures (displayed, uncertain, reopened) and assistance references.', MESSAGE_EXEMPLARS.activityRecords[1]!], ['with-host-activity', 'The host-owned stage, activity revision and closed state a restore adopts (additive in 1.0).', MESSAGE_EXEMPLARS.activityRecords[2]!], ['with-host-lineage', 'The host-held context lineage (independent since revision 4: every earlier grant has ended) and the receipt of the current stage (additive in 1.0).', MESSAGE_EXEMPLARS.activityRecords[3]!]),
  [MESSAGES.hostAck]: cases(['plain', 'Plain acknowledgement.', MESSAGE_EXEMPLARS.hostAck[0]!], ['artifact', 'Acknowledgement with an artifact digest and offset timestamp.', MESSAGE_EXEMPLARS.hostAck[1]!]),
  [MODEL_MANIFEST_CONTRACT]: cases(['quadratic-discrete', 'Discrete kernel manifest with a coupled constraint.', quadraticManifest], ['orientation-static', 'Static 3D kernel manifest in radians.', orientationManifest], ['evaluation-declared', 'Kernel manifest declaring its determinism class and checkpoint requirement (additive in 1.0).', ({ ...quadraticManifest, evaluation: { determinism: 'bitwise', checkpoint: 'none' } })], ['evaluation-within-engine', 'Static 3D kernel manifest whose outputs use engine-approximated functions (additive in 1.0).', ({ ...orientationManifest, evaluation: { determinism: 'within-engine', checkpoint: 'none' } })], ['observed-static', 'Static kernel manifest with an observed dataset (units, a missing cell with its reason, provenance) beside model geometry.', observedManifest], ['geometry-coordinates', 'Discrete kernel manifest whose index-position trace declares the unit of each coordinate (additive in 1.0).', ({ ...quadraticManifest, geometry: { ...quadraticManifest.geometry, trace: { kind: 'points2', label: 'Position trace', description: 'Points (n, x_n) for n = 0…N.', dimension: 'dimensionless', unit: 'dimensionless', coordinates: { x: 'iteration', y: 'dimensionless' }, coordinateFrame: 'index-position plane', maxElements: 1001 } } })]),
};
