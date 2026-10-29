/**
 * Content-package checks for `quadratic-surface-gradient` (report §5.2, §8, §11, §12.5, §12.6, A30, A46): manifest and
 * template contracts, honest disclosure grouping, accessible equivalents, neutral learner copy, the kernel behind the
 * core model runtime, and the template behind the activity adapter (linked views from one frame, staged disclosure,
 * camera changes that never touch the scientific state). The package is imported from its own modules; registering
 * it in the installed catalogue is a separate step. Adapter results use the memory host double (fixture-host results).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createStudyHarnessAdapter, groupDigests, templateDigest, templateRef, validateRecord, validateTemplateSemantics,
  type ActivityBinding, type ActivityCatalog, type ActivityTemplate, type CatalogEntryStatus, type CommandOutcome, type ContentGroup, type HostPolicy, type LearnerProjection,
  type StudyHarnessAdapter,
} from '@experiment-kit/activity';
import {
  checkParameters, clampForPreview, createModelSession, defaultParameters, evaluateRequest, ModelError, modelIdentity, validateManifest,
  type GeometryResult, type ModelGuard, type ModelManifest, type ModelSession,
} from '@experiment-kit/core/model';
import { SURFACE_GRADIENT_COPY as COPY } from '../../packages/catalog/src/copy/quadratic-surface-gradient.js';
import {
  ARROW_MAX_LENGTH, CONTOUR_LEVELS, CONTOUR_SAMPLES, FIELD_GRID, quadraticSurfaceGradientKernel as kernel, SECTION_SAMPLES, SURFACE_GRADIENT_DOMAIN,
  SURFACE_GRADIENT_KERNEL_ID, SURFACE_GRADIENT_KERNEL_VERSION, SURFACE_GRADIENT_PARAMETERS, SURFACE_GRID,
} from '../../packages/catalog/src/kernels/quadratic-surface-gradient.js';
import { quadraticSurfaceGradientManifest as manifest, SURFACE_GRADIENT_REFERENCE_SUITE_DIGEST } from '../../packages/catalog/src/models/quadratic-surface-gradient.js';
import { quadraticSurfaceGradientTemplate as template } from '../../packages/catalog/src/templates/quadratic-surface-gradient.js';
import { MemoryHost } from '../activity/support/memory-host.js';
import { inlineWorkers, until } from '../core/support/inline-worker.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURE = join(root, 'tests/reference/fixtures/activities/quadratic-surface-gradient.json');
const SOURCES = ['kernels', 'models', 'templates', 'copy'].map(dir => join(root, 'packages/catalog/src', dir, 'quadratic-surface-gradient.ts'));
const evaluate = (params: Record<string, number>) => evaluateRequest({ manifest, params, position: { kind: 'static' } }, [kernel]);
const defaults = defaultParameters(manifest);
const groupsOf = (kind: ContentGroup['kind'], id: string) => template.groups.filter(group => group.kind === kind && group.members.includes(id));
const solutionGroups = new Set(template.groups.filter(group => group.solutionBearing).map(group => group.id));
const stage = (id: string) => template.stages.find(entry => entry.id === id)!;
const view = (id: string) => template.views.find(entry => entry.id === id)!;
const marks = template.views.flatMap(entry => entry.marks);
/** Element count as core's frame validation counts it (points, two vertices per segment, nx·ny samples). */
const elements = (geometry: GeometryResult): number => {
  switch (geometry.kind) {
    case 'polyline2': case 'polyline3': return geometry.segments.reduce((sum, segment) => sum + segment.points.length, 0);
    case 'points2': case 'points3': return geometry.points.length;
    case 'segments2': case 'segments3': return 2 * geometry.segments.length;
    case 'polygon2': return geometry.vertices.length;
    case 'surface-grid': return geometry.sampling.nx * geometry.sampling.ny;
    case 'vector-field2': case 'vector-field3': return geometry.samples.length;
    case 'observations2': return geometry.points.length;
  }
};

describe('quadratic-surface-gradient model manifest (report §8.2, §8.3, §12.5)', () => {
  it('validates, selects the installed static kernel and pins the reference suite to the exact fixture bytes', () => {
    const { manifest: validated, identity } = validateManifest(manifest);
    expect(validated).toEqual(manifest);
    expect(identity).toEqual(modelIdentity(manifest));
    expect(manifest.execution).toEqual({ kind: 'kernel', kernelId: SURFACE_GRADIENT_KERNEL_ID, kernelVersion: SURFACE_GRADIENT_KERNEL_VERSION, mode: 'static' });
    expect({ id: kernel.id, version: kernel.version, mode: kernel.mode }).toEqual({ id: 'quadratic-surface-gradient', version: '1.1.0', mode: 'static' });
    expect(Object.isFrozen(kernel)).toBe(true);
    expect(manifest.limits.maxIndex).toBeUndefined();
    const bytes = readFileSync(FIXTURE);
    expect(SURFACE_GRADIENT_REFERENCE_SUITE_DIGEST).toBe(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
    expect(manifest.referenceSuite).toEqual({ suiteId: JSON.parse(bytes.toString('utf8')).suiteId, digest: SURFACE_GRADIENT_REFERENCE_SUITE_DIGEST });
  });

  it('declares canonical units, a right-handed frame, meanings, frames and sign conventions', () => {
    expect(Object.keys(manifest.parameters)).toEqual([...SURFACE_GRADIENT_PARAMETERS]);
    for (const [id, parameter] of Object.entries(manifest.parameters)) {
      expect(parameter, id).toMatchObject({ unit: 'dimensionless', dimension: 'dimensionless', role: 'model-input', step: { admissible: 'continuous' } });
      expect([parameter.min, parameter.max], id).toEqual([...SURFACE_GRADIENT_DOMAIN[id as keyof typeof SURFACE_GRADIENT_DOMAIN]]);
    }
    expect(SURFACE_GRADIENT_DOMAIN).toEqual({ a: [0.2, 4], b: [-2, 2], c: [0.2, 4], px: [-2, 2], py: [-2, 2] });
    expect(manifest.capabilities).toEqual([{ id: 'spatial-3d', version: '1.0' }]);
    expect(manifest.interpretation.handedness).toBe('right');
    expect(manifest.interpretation.assumptions.some(text => /camera/.test(text) && /never changes a, b, c or the point/.test(text))).toBe(true);
    expect(manifest.interpretation.limitations.length).toBeGreaterThanOrEqual(4);
    expect(manifest.sources.map(source => source.kind)).toEqual(['derivation', 'specification']);
    for (const [id, quantity] of Object.entries(manifest.quantities)) {
      expect([quantity.unit, quantity.dimension], id).toEqual(['dimensionless', 'dimensionless']);
      expect(quantity.meaning.length, id).toBeGreaterThan(30);
      expect(quantity.signConvention, id).toBeDefined();
      if (!['hessian.det', 'arrow.scale'].includes(id)) expect(quantity.coordinateFrame, id).toMatch(/right-handed/);
    }
    expect(manifest.quantities['gradient.direction']!.meaning).toMatch(/ZERO_GRADIENT/);
    expect(manifest.quantities.gradient!.signConvention).toMatch(/toward increasing f/);
    expect(manifest.quantities['minimum.location']!.meaning).toMatch(/unique minimum of the symmetric positive-definite family/);
    expect(manifest.constraints).toEqual([{
      id: 'positive-definite', expression: 'a*c - b*b', min: 0, minInclusive: false, message: expect.stringMatching(/a·c − b² > 0/), recovery: expect.stringMatching(/size of b/),
    }]);
  });

  it('sizes geometry by the frame counting rules, discloses sampling, and fills the sizes exactly', () => {
    const sizes = Object.fromEntries(Object.entries(manifest.geometry).map(([id, geometry]) => [id, [geometry.kind, geometry.maxElements]]));
    expect(sizes).toEqual({
      surface: ['surface-grid', 41 * 41], contours: ['polyline2', CONTOUR_LEVELS.length * CONTOUR_SAMPLES], field: ['vector-field2', 81],
      'cross-section-x': ['polyline2', 81], 'cross-section-y': ['polyline2', 81], 'point-2d': ['points2', 1], 'point-3d': ['points3', 1],
      'gradient-2d': ['segments2', 2], 'gradient-3d': ['segments3', 2],
    });
    expect([SURFACE_GRID.n, FIELD_GRID.n, SECTION_SAMPLES.n, CONTOUR_SAMPLES]).toEqual([41, 9, 81, 181]);
    expect(manifest.limits.maxGeometryElements).toBe(Object.values(manifest.geometry).reduce((sum, geometry) => sum + geometry.maxElements, 0));
    const full = evaluate(defaults).geometry;
    for (const [id, definition] of Object.entries(manifest.geometry)) expect(elements(full[id]!), id).toBe(definition.maxElements);
    expect(manifest.geometry.surface!.description).toMatch(/41 × 41 grid.*spacing 0\.1/);
    expect(manifest.geometry.contours!.description).toMatch(/0\.25, 0\.5, 1, 2, 4/);
    expect(full.surface).toMatchObject({ sampling: { nx: 41, ny: 41, domain: [-2, 2, -2, 2] } });
    expect(full['cross-section-x']).toMatchObject({ sampling: { samples: 81, domain: [-2, 2] } });
    expect(full.field).toMatchObject({ scale: { factor: 0.05, disclosure: 'Arrow lengths are scaled by 0.05 for legibility; directions are exact.' } });
    // Every drawn arrow fits the field spacing, so a point arrow from anywhere in [−2, 2]² stays inside the authored view.
    const field = full.field as Extract<GeometryResult, { kind: 'vector-field2' }>;
    expect(Math.max(...field.samples.map(sample => Math.hypot(...sample.vector))) * field.scale.factor).toBeLessThanOrEqual(ARROW_MAX_LENGTH);
  });

  it('separates scientific meaning from presentation in the model identity (A10)', () => {
    const base = modelIdentity(manifest);
    const edit = (change: (copy: ModelManifest) => void) => { const copy = structuredClone(manifest) as ModelManifest; change(copy); return modelIdentity(copy); };
    expect(edit(copy => { copy.quantities.gradient!.signConvention = 'Points toward decreasing f.'; }).scientificRevision).not.toBe(base.scientificRevision);
    expect(edit(copy => { copy.constraints[0]!.minInclusive = true; }).scientificRevision).not.toBe(base.scientificRevision);
    expect(edit(copy => { copy.interpretation.assumptions[1] = 'Any symmetric Hessian.'; }).scientificRevision).not.toBe(base.scientificRevision);
    // Label spelling is presentation; label wording is meaning (report §8.3, R38).
    const respelled = edit(copy => { copy.quantities.gradient!.label = 'Gradient  at the point'; copy.geometry['cross-section-x']!.label = 'Cross section along the x-axis'; });
    expect(respelled.scientificRevision).toBe(base.scientificRevision);
    expect(respelled.presentationRevision).not.toBe(base.presentationRevision);
    expect(edit(copy => { copy.quantities.gradient!.label = 'Slope vector'; }).scientificRevision).not.toBe(base.scientificRevision);
    // The readout names of the height and of the gradient's length trade places: the numbers are unchanged, the meaning is not.
    const swapped = edit(copy => { [copy.quantities.value!.label, copy.quantities['gradient.norm']!.label] = [copy.quantities['gradient.norm']!.label, copy.quantities.value!.label]; });
    expect(swapped.scientificRevision).not.toBe(base.scientificRevision);
  });

  it('enforces the positive-definite constraint at every entry point, never by clamping', () => {
    expect(checkParameters(manifest, defaults)).toEqual([]);
    const singular = { ...defaults, a: 1, b: 1, c: 1 };
    expect(checkParameters(manifest, singular)).toEqual([expect.objectContaining({ code: 'CONSTRAINT_VIOLATION', path: '$.constraints.positive-definite' })]);
    expect(checkParameters(manifest, { b: 1, c: 1, a: 1 }, { partial: true })).toHaveLength(1);
    // A pointer preview clamps single values into range but reports, never repairs, a coupled violation.
    const preview = clampForPreview(manifest, { ...singular, b: 3 });
    expect(preview).toEqual({ params: { ...singular, b: 2 }, clamped: ['b'] });
    expect(checkParameters(manifest, preview.params).map(item => item.code)).toEqual(['CONSTRAINT_VIOLATION']);
    expect(() => evaluate({ ...defaults, a: 4, b: 2, c: 1 })).toThrow(ModelError);
    expect(() => evaluate({ ...defaults, a: 4, b: 2, c: 1.0000000000000002 })).not.toThrow();
  });
});

describe('quadratic-surface-gradient activity template (report §6, §11, §12.5)', () => {
  it('passes schema and semantic validation as a 3D template bound to the exact manifest', () => {
    expect(validateRecord('study-harness.activity-template', template)).toEqual({ ok: true, diagnostics: [] });
    expect(validateTemplateSemantics(template, manifest)).toEqual([]);
    expect(template.model).toEqual({ modelId: manifest.modelId, version: manifest.version, digest: modelIdentity(manifest).digest });
    expect(template.requires).toEqual(manifest.capabilities);
    expect(template.dimension).toBe('3d');
    const digests = groupDigests(template, manifest);
    expect(digests.map(entry => entry.groupId)).toEqual(template.groups.map(group => group.id));
    expect(new Set(digests.map(entry => entry.contentDigest)).size).toBe(digests.length);
    expect(templateDigest(template)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('links a bounded 3D surface view with an equal-aspect contour view (x right, y up) through shared groups', () => {
    const scenes = template.views.filter(entry => entry.kind === 'scene3d');
    expect(scenes.map(entry => entry.id)).toEqual(['surface-view']);
    expect(view('surface-view')).toMatchObject({ bounds3: [-2.5, 2.5, -2.5, 2.5, 0, 24], axes: { x: { label: 'x' }, y: { label: 'y' }, z: { label: 'f(x, y)' } } });
    // ±3.25 contains every default contour (f = 4 reaches |y| ≈ 3.02), so the default stages open without out-of-view data (G42).
    expect(view('contour-plot')).toMatchObject({ kind: 'plot2d', equalAspect: true, bounds: [-3.25, 3.25, -3.25, 3.25], axes: { x: { label: 'x' }, y: { label: 'y' } } });
    // Largest height on the domain (a = c = 4, b = ±2 at a corner) is 24, and arrows add at most 0.45 to |p| ≤ 2.
    expect(view('surface-view').bounds3![5]).toBe(24);
    expect(2 + ARROW_MAX_LENGTH).toBeLessThanOrEqual(view('contour-plot').bounds![1]);
    const groupOfMark = (id: string) => marks.find(entry => entry.id === id)!.group;
    expect([groupOfMark('point-on-surface'), groupOfMark('point-marker')]).toEqual(['point', 'point']);
    expect([groupOfMark('gradient-arrow-3d'), groupOfMark('gradient-arrow')]).toEqual(['gradient-drawing', 'gradient-drawing']);
    expect(view('section-x').marks[0]!.bindings).toEqual({ geometry: 'cross-section-x' });
    expect(view('section-y').marks[0]!.bindings).toEqual({ geometry: 'cross-section-y' });
    // Every quantity has a numeric place without WebGL.
    const listed = new Set(template.views.filter(entry => entry.kind === 'values' || entry.kind === 'table').flatMap(entry => entry.quantities ?? []));
    expect([...listed].sort()).toEqual(Object.keys(manifest.quantities).sort());
  });

  it('binds marks only to manifest output, distinguishes them without colour and never leaks hidden output', () => {
    for (const entry of template.views) {
      const nonColour = entry.marks.map(mark => `${mark.style.dash}/${mark.style.marker}/${mark.style.weight}`);
      expect(new Set(nonColour).size, `${entry.id} without colour`).toBe(nonColour.length);
    }
    for (const mark of marks) {
      expect(mark.label.length, mark.id).toBeGreaterThan(5);
      const bound = Object.entries(mark.bindings);
      expect(bound.length, mark.id).toBeGreaterThan(0);
      for (const [key, id] of bound) {
        expect(key === 'geometry' ? manifest.geometry[id!] : manifest.quantities[id!], `${mark.id}.${key}`).toBeDefined();
        const holders = key === 'geometry' ? groupsOf('dataset', id!) : groupsOf('quantity', id!);
        expect(holders.length, `${mark.id}.${key}`).toBeGreaterThan(0);
        // A mark drawing solution-bearing output belongs to a solution-bearing group, and vice versa.
        expect(solutionGroups.has(mark.group), mark.id).toBe(holders.every(group => group.solutionBearing));
      }
    }
    // Camera is presentation: no scene mark is draggable and every control is a model parameter.
    expect(view('surface-view').marks.every(mark => mark.drag === undefined)).toBe(true);
    expect(template.controls.map(control => control.parameter)).toEqual([...SURFACE_GRADIENT_PARAMETERS]);
    expect(marks.filter(mark => mark.drag).map(mark => [mark.id, mark.drag])).toEqual([['point-marker', { x: 'px', y: 'py' }]]);
    for (const equation of template.equations) expect(/\{\{q:/.test(equation.tex), equation.id).toBe(solutionGroups.has(equation.group));
  });

  it('shows contours before the gradient and reveals the gradient, then the field, in separate authorized stages', () => {
    expect([...solutionGroups].sort()).toEqual(['field', 'gradient', 'gradient-drawing', 'gradient-values', 'minimum', 'minimum-values']);
    expect(template.initialStage).toBe('orient');
    expect(new Set(template.stages.map(entry => entry.kind))).toEqual(new Set(['prepare', 'predict', 'explore', 'explain', 'closed']));
    const visible = (id: string) => Object.keys(stage(id).visible);
    for (const id of ['orient', 'predict']) {
      expect(visible(id).filter(group => solutionGroups.has(group)), id).toEqual([]);
      expect(visible(id)).toEqual(expect.arrayContaining(['scene', 'contour-view', 'contours', 'surface', 'point', 'surface-values', 'alternatives']));
      expect(visible(id)).not.toContain('gradient-rules');
      expect(Object.values(stage(id).controls).every(mode => mode === 'fixed'), id).toBe(true);
      expect(stage(id)).toMatchObject({ allowsPreview: false, allowsPlayback: false, allowsNavigation: false });
    }
    expect(stage('predict').response).toEqual({ kind: 'prediction', prompt: COPY.stages.predict.prompt, taskFamily: 'surface-gradient-prediction' });
    expect(visible('explore-point')).toEqual(expect.arrayContaining(['gradient', 'gradient-drawing', 'gradient-values', 'gradient-rules']));
    expect(visible('explore-point').filter(group => ['field', 'minimum', 'minimum-values'].includes(group))).toEqual([]);
    expect(stage('explore-point').controls).toEqual({ a: 'fixed', b: 'fixed', c: 'fixed', px: 'interactive', py: 'interactive' });
    expect(visible('explore-field')).toEqual(expect.arrayContaining(['field', 'minimum', 'minimum-values', 'gradient']));
    expect(Object.values(stage('explore-field').controls)).toEqual(['interactive', 'interactive', 'interactive', 'interactive', 'interactive']);
    expect(Object.values(stage('explain').controls).every(mode => mode === 'fixed')).toBe(true);
    expect(stage('explain').response?.taskFamily).toBe('surface-gradient-explanation');
    expect(stage('closed')).toMatchObject({ visible: {}, controls: {} });
    expect([...solutionGroups].every(group => stage('free-explore').visible[group])).toBe(true);
    expect(template.stages.every(entry => !entry.allowsPlayback && !entry.allowsNavigation)).toBe(true);
    // free-explore is entered only by an authorized host preparation, never by a transition.
    expect(template.transitions.filter(transition => transition.to === 'free-explore')).toEqual([]);
    expect(template.transitions.filter(transition => transition.from === 'free-explore').map(transition => transition.to)).toEqual(['closed']);
  });

  it('offers a complete path without WebGL and records the contour projection honestly', () => {
    const covering = (id: string) => template.alternatives.filter(alternative => alternative.covers.includes(id)).map(alternative => [alternative.id, alternative.kind, alternative.equivalence]);
    expect(covering('surface-view')).toEqual([
      ['without-webgl', 'alternative-activity', 'alternative-activity'], ['contour-projection-shape', 'projection-2d', 'partial'], ['text-description', 'description', 'partial'],
    ]);
    expect(covering('gradient-arrow-3d')).toEqual(expect.arrayContaining([['contour-projection-gradient', 'projection-2d', 'equivalent']]));
    for (const id of ['contour-plot', 'section-x', 'section-y', 'field-arrows', 'gradient-arrow', 'point-marker']) {
      expect(covering(id).some(([, , equivalence]) => equivalence === 'equivalent'), id).toBe(true);
    }
    for (const parameter of SURFACE_GRADIENT_PARAMETERS) expect(covering(parameter).map(([, kind]) => kind).sort()).toEqual(['keyboard', 'numeric-entry']);
    for (const alternative of template.alternatives) expect(alternative.verifiedBy).toMatch(/^tests\/browser\/study-spatial\.spec\.ts#[a-z0-9-]+$/);
    for (const control of template.controls) expect(control).toMatchObject({ displayUnits: ['dimensionless'], slider: true, exact: true });
    // Alternative tables are complete: no rows-from table exceeds the projection's 200-row cap.
    for (const entry of template.views.filter(item => item.rowsFrom)) expect(manifest.geometry[entry.rowsFrom!]!.maxElements, entry.id).toBeLessThanOrEqual(200);
  });

  it('ships approved scenarios that are admissible and named by their inputs only', () => {
    expect(template.scenarios.length).toBeGreaterThanOrEqual(5);
    for (const scenario of template.scenarios) {
      expect(Object.keys(scenario.parameters).sort(), scenario.id).toEqual([...SURFACE_GRADIENT_PARAMETERS].sort());
      expect(checkParameters(manifest, scenario.parameters), scenario.id).toEqual([]);
      expect(() => evaluate(scenario.parameters), scenario.id).not.toThrow();
      expect(`${scenario.label} ${scenario.description}`, scenario.id).not.toMatch(/minimum|lowest|steep|perpendicular|direction|uphill|zero gradient/i);
    }
    expect(template.scenarios.some(scenario => scenario.parameters.b !== 0)).toBe(true);
    expect(defaults).toEqual(template.scenarios.find(scenario => scenario.id === 'default-bowl')!.parameters);
  });
});

describe('quadratic-surface-gradient content boundaries (report §12.6)', () => {
  const FORBIDDEN_KEY = /^(answers?|answer[-_]?key|rubrics?|solutions?|correct([-_]?answer)?|expected[-_]?(response|answer)|held[-_]?out|scor(e|ing)|grade|mark[-_]?scheme|review(ed|er)?|approv(ed|al))$/i;
  const keys = (value: unknown, path = '$'): string[] => !value || typeof value !== 'object' ? []
    : Object.entries(value).flatMap(([key, item]) => [...(Array.isArray(value) ? [] : [`${path}.${key}`]), ...keys(item, `${path}.${key}`)]);

  it('carries no answer keys, rubrics, solutions or review claims', () => {
    for (const data of [template, manifest] as unknown[]) expect(keys(data).filter(path => FORBIDDEN_KEY.test(path.slice(path.lastIndexOf('.') + 1)))).toEqual([]);
    for (const family of template.taskFamilies) expect(family).toEqual({ id: family.id, description: expect.stringMatching(/^Host-owned/), hostOwned: true });
    for (const entry of template.stages) if (entry.response) expect(Object.keys(entry.response).sort()).toEqual(['kind', 'prompt', 'taskFamily']);
    const field = /["']?\b(answers?|answerKey|rubrics?|solutions?|correctAnswer|expectedResponse|heldOut|scoring)\b["']?\s*:/i;
    expect(SOURCES.filter(file => field.test(readFileSync(file, 'utf8')))).toEqual([]);
  });

  it('uses neutral learner copy without mastery, grading or review claims', () => {
    const learnerText = [
      template.title, template.purpose,
      ...template.stages.flatMap(entry => [entry.instruction, entry.response?.prompt ?? '']),
      ...template.groups.flatMap(group => [group.label, group.description]),
      ...template.views.flatMap(entry => [entry.title, entry.description, ...entry.marks.flatMap(mark => [mark.label, mark.text ?? ''])]),
      ...template.controls.flatMap(control => [control.label, control.description]),
      ...template.scenarios.flatMap(scenario => [scenario.label, scenario.description]),
      ...template.alternatives.flatMap(alternative => [alternative.label, alternative.description]),
      ...template.content.filter(entry => entry.kind === 'learner-copy').map(entry => entry.text),
      ...manifest.constraints.flatMap(constraint => [constraint.message, constraint.recovery]),
    ];
    const claims = /\b(master(ed|y|s)?|understo{1,2}d|understands|learned|knows|correct(ly)?|incorrect|wrong|right answer|reviewed|approved|certified)\b/i;
    expect(learnerText.filter(text => claims.test(text))).toEqual([]);
    // Prediction-stage text does not state the relation the learner is asked to predict.
    expect(`${stage('predict').instruction} ${stage('predict').response!.prompt}`).not.toMatch(/perpendicular|right angle|normal to|steepest/i);
  });

  it('keeps the kernel free of templates, copy and manifests', () => {
    const source = readFileSync(SOURCES[0]!, 'utf8');
    expect([...source.matchAll(/from\s+'([^']+)'/g)].map(match => match[1])).toEqual(['@experiment-kit/core/model']);
  });

  it('changes the template digest when learner text changes, so approval does not carry over', () => {
    const edited = structuredClone(template) as ActivityTemplate;
    edited.alternatives[2]!.description = 'Contour lines only.';
    expect(templateDigest(edited)).not.toBe(templateDigest(template));
    expect(groupDigests(edited, manifest).find(entry => entry.groupId === 'alternatives')!.contentDigest)
      .not.toBe(groupDigests(template, manifest).find(entry => entry.groupId === 'alternatives')!.contentDigest);
  });
});

describe('quadratic-surface-gradient through the core model runtime', () => {
  const cleanup: { dispose(): void }[] = [];
  afterEach(() => { for (const item of cleanup.splice(0)) item.dispose(); });
  let operation = 0;
  const guard = (session: ModelSession): ModelGuard => ({ sessionId: session.id, expectedVersion: session.getState().version, expectedRunId: session.getState().run?.id ?? null, operationId: `op-${++operation}` });

  it('evaluates one identified frame in a worker, rejects a = c = b keeping the last frame, and samples in isolation', async () => {
    const group = inlineWorkers([kernel]);
    const session = createModelSession({ workerFactory: group.factory });
    cleanup.push(session);
    const loaded = await session.load(manifest, null, guard(session));
    expect(loaded.frame!.position).toEqual({ kind: 'static' });
    expect(loaded.frame!.quantities.gradient).toEqual({ status: 'valid', value: [2.5, 1.5] });
    expect(Object.keys(loaded.frame!.geometry).sort()).toEqual(Object.keys(manifest.geometry).sort());
    const frameId = loaded.frame!.frameId;

    let rejected: unknown;
    try { await session.commitParameters({ ...defaults, a: 1, b: 1, c: 1 }, guard(session)); } catch (error) { rejected = error; }
    expect((rejected as ModelError).diagnostics[0]).toMatchObject({ code: 'CONSTRAINT_VIOLATION', path: '$.constraints.positive-definite' });
    expect(session.getState().frame!.frameId).toBe(frameId);

    const origin = await session.commitParameters({ ...defaults, px: 0, py: 0 }, guard(session));
    expect(origin.frame!.quantities['gradient.direction']).toMatchObject({ status: 'undefined', code: 'ZERO_GRADIENT' });
    expect(origin.frame!.geometry['gradient-2d']).toEqual({ kind: 'segments2', segments: [] });

    const before = session.getState();
    const sample = await session.sample({ params: { ...defaults, b: 0, px: 1, py: 0 }, positions: [{ kind: 'static' }] });
    expect(sample.frames[0]!.quantities['gradient.direction']).toEqual({ status: 'valid', value: [1, 0] });
    expect(session.getState().version).toBe(before.version);
    expect(session.getState().frame!.frameId).toBe(before.frame!.frameId);
  });
});

describe('quadratic-surface-gradient through the activity adapter (A46)', () => {
  const TEMPLATE = templateRef(template);
  const MODEL = { modelId: manifest.modelId, version: manifest.version, digest: modelIdentity(manifest).digest };
  let adapter: StudyHarnessAdapter | null = null;
  afterEach(() => { adapter?.dispose(); adapter = null; });

  /** Minimal injected catalogue serving this package only, with in-process kernel workers (test seam). */
  const catalog = (createWorker: () => Worker): ActivityCatalog => {
    const status = (): CatalogEntryStatus => ({ lifecycle: 'validated', reviews: [], revoked: false });
    return {
      listTemplates: () => [{ template: TEMPLATE, model: MODEL, title: template.title, dimension: '3d', status: status() }],
      getTemplate: ref => ref.templateId === template.templateId && ref.version === template.version ? structuredClone(template) : null,
      getModel: ref => ref.modelId === manifest.modelId && ref.version === manifest.version ? structuredClone(manifest) : null,
      status, createWorker,
    };
  };
  const policy: HostPolicy = {
    contract: 'study-harness.host-policy', schemaVersion: '1.0', policyId: 'policy-surface', revision: 1, issuedAt: '2026-10-26T08:00:00.000Z', expiresAt: null, revoked: false,
    mode: 'approved', approved: [{ template: TEMPLATE, model: MODEL }],
    allowedTools: ['discover', 'prepare', 'inspect.learner', 'request-reveal', 'operate.parameters', 'operate.presentation', 'summarize', 'save', 'restore', 'close'],
    visibleGroups: template.groups.map(group => group.id), permittedControls: [...SURFACE_GRADIENT_PARAMETERS],
    export: { learnerSnapshot: true, capture: false, backup: true }, inspection: { developer: false, tutor: 'learner-visible', teacher: true },
    independentTask: { active: false, taskRef: null, permittedTools: [], neutralScaffold: [] }, sampling: { allowed: false, maxPositions: 0 },
    exploratory: { allowed: false, maxParametersOverride: 0 },
  };
  let operation = 0;
  const op = () => `op-surface-${++operation}`;
  const ok = (outcome: CommandOutcome): LearnerProjection => { if (!outcome.ok) throw new Error(JSON.stringify(outcome.diagnostics)); return outcome.projection; };
  const settled = async (activityId: string) => {
    await new Promise(resolve => setTimeout(resolve, 0));
    await until(() => { const state = adapter!.getState(activityId, 'host'); return !('persistence' in state) || state.persistence !== 'saving'; });
    await new Promise(resolve => setTimeout(resolve, 0));
  };
  const activityGuard = (binding: ActivityBinding) => ({ expectedActivityRevision: binding.getProjection().activityRevision, expectedPolicyRevision: binding.getProjection().policyRevision });
  const acknowledge = (binding: ActivityBinding) => {
    const projection = binding.getProjection();
    binding.acknowledgeDisplay({ projectionId: projection.projectionId, projectionDigest: projection.projectionDigest, surfaceId: 'surface-main' });
  };
  const values = (projection: LearnerProjection) => Object.fromEntries(projection.views.find(entry => entry.viewId === 'readouts')!.values.map(value => [value.quantityId, value]));
  const markIds = (projection: LearnerProjection) => projection.views.flatMap(entry => entry.marks.map(mark => mark.markId)).sort();

  it('draws both views from one frame, keeps the camera out of the science and reveals the gradient only after authorization', async () => {
    const workers = inlineWorkers([kernel]);
    const host = new MemoryHost({ policy });
    adapter = createStudyHarnessAdapter({ catalog: catalog(workers.factory), host });
    const activityId = 'act-surface-1';
    const prepared = await adapter.prepare({ activityId, objectiveIds: ['obj-gradient'], hostSessionId: 'session-1', hostSessionRevision: 0, template: { templateId: template.templateId, version: template.version }, mode: 'approved' }, { operationId: op() });
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.diagnostics));
    const learner = prepared.prepared.binding('learner', 'surface-main');
    learner.registerSurface('surface-main');
    const control = prepared.prepared.host;
    await settled(activityId);

    // Orientation: surface, contours and the point from one frame; no gradient anywhere in the learner projection.
    const oriented = learner.getProjection();
    expect(oriented.stage.id).toBe('orient');
    expect(markIds(oriented)).toEqual(['contour-lines', 'point-marker', 'point-on-surface', 'section-x-curve', 'section-y-curve', 'surface-mesh']);
    const markOf = (projection: LearnerProjection, id: string) => projection.views.flatMap(entry => entry.marks).find(mark => mark.markId === id)!;
    expect(markOf(oriented, 'point-on-surface').at).toEqual([1, 1, 2]);
    expect(markOf(oriented, 'point-marker').at).toEqual([1, 1]);
    expect(Object.keys(values(oriented)).sort()).toEqual(['hessian.det', 'point', 'value']);
    expect(JSON.stringify(oriented)).not.toMatch(/"(gradient|gradient\.norm|gradient\.direction|arrow\.scale|minimum\.location)"|∇f\(p\) =|vector-field2/);
    const { frame } = oriented;

    // Turning the 3D camera is presentation only: same frame, run, version and parameters.
    const turned = ok(learner.setCamera({
      operationId: op(), expectedPresentationRevision: oriented.presentationRevision, viewId: 'surface-view',
      camera: { kind: '3d', projection: 'perspective', position: [6, -8, 30], target: [0, 0, 4], up: [0, 0, 1], preset: null },
    }));
    expect(turned.presentationRevision).toBe(oriented.presentationRevision + 1);
    expect([turned.frame, turned.guards, turned.activityRevision]).toEqual([frame, oriented.guards, oriented.activityRevision]);
    expect(turned.controls.map(entry => [entry.parameter, entry.value])).toEqual(oriented.controls.map(entry => [entry.parameter, entry.value]));
    await settled(activityId);

    // Predict: contours visible, gradient still hidden.
    ok(await control.requestStageTransition({ operationId: op(), ...activityGuard(learner), toStage: 'predict' }));
    await settled(activityId);
    acknowledge(learner);
    await settled(activityId);
    expect(learner.getProjection().stage.id).toBe('predict');
    expect(markIds(learner.getProjection())).toContain('contour-lines');
    expect(markIds(learner.getProjection())).not.toContain('gradient-arrow');

    // Explore the point: the gradient appears in both views and the values, from the same frame; the field does not.
    ok(await control.requestStageTransition({ operationId: op(), ...activityGuard(learner), toStage: 'explore-point' }));
    await settled(activityId);
    acknowledge(learner);
    await settled(activityId);
    const revealed = learner.getProjection();
    expect(revealed.stage.id).toBe('explore-point');
    expect(revealed.frame).toEqual(frame);
    expect(values(revealed).gradient).toMatchObject({ status: 'valid', value: [2.5, 1.5] });
    expect(values(revealed)['arrow.scale']).toMatchObject({ value: 0.05 });
    expect(markOf(revealed, 'gradient-arrow').geometry).toEqual({ kind: 'segments2', segments: [{ id: 'gradient', from: [1, 1], to: [1.125, 1.075] }] });
    expect(markOf(revealed, 'gradient-arrow-3d').geometry).toEqual({ kind: 'segments3', segments: [{ id: 'gradient', from: [1, 1, 2], to: [1.125, 1.075, 2] }] });
    expect(markIds(revealed)).not.toContain('field-arrows');
    expect(markOf(revealed, 'point-marker').interactive).toBe(true);

    // Exact entry of the minimum: the direction is an undefined status with a reason, never shown as zero.
    const atOrigin = ok(await learner.commitParameters({ operationId: op(), ...revealed.guards, displayValues: { px: 0, py: 0 } }));
    expect(atOrigin.frame!.frameId).not.toBe(frame!.frameId);
    expect(values(atOrigin)['gradient.direction']).toMatchObject({ status: 'undefined', reason: expect.stringMatching(/no direction/) });
    expect(values(atOrigin)['gradient.direction']!.text).not.toMatch(/^0/);
    // The drawn gradient is a valid zero vector (no arrow); only its direction, which appears in readouts alone, is
    // undefined. That conditional value is shown inline with its reason, so the drawing state is unchanged from the
    // generic point and no 'undefined' banner is raised (activity-runtime §3 banner rule).
    expect(atOrigin.status.ui).not.toBe('undefined');
    expect(atOrigin.status.ui).toBe(revealed.status.ui);
    expect(markOf(atOrigin, 'gradient-arrow').geometry).toEqual({ kind: 'segments2', segments: [] });
    // The coefficients stay fixed in this stage.
    expect((await learner.commitParameters({ operationId: op(), ...atOrigin.guards, displayValues: { b: 0 } })).ok).toBe(false);
    await settled(activityId);

    // Field stage (separately authorized): the field with its disclosed scale, the lowest point and complete tables.
    ok(await control.requestStageTransition({ operationId: op(), ...activityGuard(learner), toStage: 'explore-field' }));
    await settled(activityId);
    acknowledge(learner);
    await settled(activityId);
    const field = learner.getProjection();
    expect(field.stage.id).toBe('explore-field');
    expect(field.frame).toEqual(atOrigin.frame);
    expect(markOf(field, 'field-arrows').geometry).toMatchObject({ kind: 'vector-field2', scale: { factor: 0.05, disclosure: expect.stringMatching(/scaled by 0\.05.*directions are exact/) } });
    expect(markOf(field, 'minimum-marker').at).toEqual([0, 0]);
    expect(field.views.find(entry => entry.viewId === 'field-table')!.table).toMatchObject({ totalRows: 81, truncated: false });
    expect(field.views.find(entry => entry.viewId === 'section-x-table')!.table).toMatchObject({ totalRows: 81, truncated: false });

    // A coefficient change that breaks a·c − b² > 0 is rejected with the last frame kept; an admissible one starts a new run.
    const saddle = await learner.commitParameters({ operationId: op(), ...field.guards, displayValues: { b: 1.5 } });
    expect(saddle.ok ? [] : saddle.diagnostics.map(item => item.code)).toEqual(['CONSTRAINT_VIOLATION']);
    expect(learner.getProjection().frame).toEqual(field.frame);
    const round = ok(await learner.commitParameters({ operationId: op(), ...learner.getProjection().guards, displayValues: { b: 0, px: 1, py: 0 } }));
    expect(round.guards.expectedRunId).not.toBe(field.guards.expectedRunId);
    expect(values(round)['gradient.direction']).toMatchObject({ status: 'valid', value: [1, 0] });
  });
});
