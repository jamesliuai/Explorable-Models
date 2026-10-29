/**
 * Content-package checks for `function-derivative` (report §12.1, §12.6, A28, A30): manifest and template contracts,
 * honest disclosure grouping, accessible equivalents, neutral learner copy, and the kernel behind the core runtime.
 * The package is imported from its own modules; registering it in the installed catalogue is a separate step.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  groupContentDigest, groupDigests, templateDigest, templateRef, validateRecord, validateTemplateSemantics, type ActivityTemplate,
} from '@explorable-models/activity';
import {
  checkParameters, clampForPreview, createModelSession, evaluateRequest, isUnitId, ModelError, modelIdentity, UNITS, validateManifest,
  type GeometryResult, type ModelGuard, type ModelManifest, type ModelSession,
} from '@explorable-models/core/model';
import { FUNCTION_DERIVATIVE_COPY as COPY } from '../../packages/catalog/src/copy/function-derivative';
import {
  FUNCTION_DERIVATIVE_CURVATURES, FUNCTION_DERIVATIVE_CURVE, FUNCTION_DERIVATIVE_DOMAIN, FUNCTION_DERIVATIVE_KERNEL_ID, FUNCTION_DERIVATIVE_KERNEL_VERSION,
  FUNCTION_DERIVATIVE_SLOPE_SIGNS, functionDerivativeKernel as kernel,
} from '../../packages/catalog/src/kernels/function-derivative';
import { FUNCTION_DERIVATIVE_REFERENCE_SUITE_DIGEST, functionDerivativeManifest as manifest } from '../../packages/catalog/src/models/function-derivative';
import { functionDerivativeTemplate as template } from '../../packages/catalog/src/templates/function-derivative';
import { inlineWorkers } from '../core/support/inline-worker';

const root = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURE = join(root, 'tests/reference/fixtures/activities/function-derivative.json');
const SOURCES = ['kernels', 'models', 'templates', 'copy'].map(dir => join(root, `packages/catalog/src/${dir}/function-derivative.ts`));
const evaluate = (params: Record<string, number>) => evaluateRequest({ manifest, params, position: { kind: 'static' } }, [kernel]);
const defaults = Object.fromEntries(Object.entries(manifest.parameters).map(([id, definition]) => [id, definition.default]));

/** Model outputs that carry slope information: shown only with a host exposure receipt. */
const SOLUTION_QUANTITIES = new Set(['derivative', 'slope.sign', 'second.x', 'second.value', 'secant.slope', 'secant.difference', 'curvature', 'vertex.x']);
const SOLUTION_GEOMETRY = new Set(['tangent', 'secant', 'second', 'derivative-curve', 'derivative-probe']);
const groupOf = (id: string) => template.groups.find(group => group.id === id)!;
const stage = (id: string) => template.stages.find(entry => entry.id === id)!;
const marks = template.views.flatMap(view => view.marks.map(mark => ({ view, mark })));

describe('function-derivative model manifest (report §8.2, §8.3, §12.1)', () => {
  it('validates, selects the installed static kernel and keeps a stable identity', () => {
    const { manifest: validated, identity } = validateManifest(manifest);
    expect(validated).toEqual(manifest);
    expect(identity).toEqual(modelIdentity(manifest));
    expect(manifest.execution).toEqual({ kind: 'kernel', kernelId: FUNCTION_DERIVATIVE_KERNEL_ID, kernelVersion: FUNCTION_DERIVATIVE_KERNEL_VERSION, mode: 'static' });
    expect({ id: kernel.id, version: kernel.version, mode: kernel.mode }).toEqual({ id: 'function-derivative', version: '1.0.0', mode: 'static' });
    expect(Object.isFrozen(kernel)).toBe(true);
    expect(manifest.limits.maxIndex).toBeUndefined();
  });

  it('pins the reference-suite digest to the exact fixture bytes', () => {
    const bytes = readFileSync(FIXTURE);
    expect(manifest.referenceSuite).toEqual({ suiteId: 'function-derivative:1.0.0', digest: FUNCTION_DERIVATIVE_REFERENCE_SUITE_DIGEST });
    expect(FUNCTION_DERIVATIVE_REFERENCE_SUITE_DIGEST).toBe(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
    expect(JSON.parse(bytes.toString('utf8')).suiteId).toBe(manifest.referenceSuite!.suiteId);
  });

  it('declares canonical units, meanings, frames and sign conventions for every quantity', () => {
    for (const [id, parameter] of Object.entries(manifest.parameters)) {
      expect([parameter.unit, parameter.dimension, parameter.role], id).toEqual(['dimensionless', 'dimensionless', 'model-input']);
      expect([parameter.min, parameter.max], id).toEqual(FUNCTION_DERIVATIVE_DOMAIN[id as keyof typeof FUNCTION_DERIVATIVE_DOMAIN]);
      expect(parameter.step.admissible, id).toBe('continuous');
    }
    for (const [id, quantity] of Object.entries(manifest.quantities)) {
      expect(isUnitId(quantity.unit) && UNITS[quantity.unit].dimension === quantity.dimension, id).toBe(true);
      expect(quantity.meaning.length, id).toBeGreaterThan(40);
      expect(quantity.coordinateFrame, id).toMatch(/plane$/);
      if (quantity.shape.kind === 'scalar') expect(quantity.signConvention, id).toBeTruthy();
    }
    expect(manifest.quantities['slope.sign']!.shape).toEqual({ kind: 'category', values: [...FUNCTION_DERIVATIVE_SLOPE_SIGNS] });
    expect(manifest.quantities.curvature!.shape).toEqual({ kind: 'category', values: [...FUNCTION_DERIVATIVE_CURVATURES] });
    expect(manifest.quantities.derivative!.meaning).toMatch(/Analytical derivative/);
    expect(manifest.quantities.derivative!.meaning).toMatch(/not estimated from secant slopes, samples or a numerical limit/);
    expect(manifest.quantities['secant.slope']!.meaning).toMatch(/COINCIDENT_POINTS.*never replaced by the derivative/);
    expect(manifest.quantities['vertex.x']!.meaning).toMatch(/NO_VERTEX/);
    for (const geometry of Object.values(manifest.geometry)) expect(isUnitId(geometry.unit) && geometry.description.length > 30).toBe(true);
  });

  it('sizes geometry by the frame counting rules on every frame', () => {
    const sweep = [defaults, { A: 0, B: 0, C: 2, p: 5, h: 0 }, { A: -2, B: -5, C: -5, p: 5, h: -2 }, { A: 2, B: 5, C: 5, p: -5, h: 2 }, { A: 1, B: 0, C: 0, p: 1e-200, h: 1 }];
    const count = (geometry: GeometryResult): number =>
      geometry.kind === 'polyline2' ? geometry.segments.reduce((total, segment) => total + segment.points.length, 0)
        : geometry.kind === 'segments2' ? 2 * geometry.segments.length
          : geometry.kind === 'points2' ? geometry.points.length : Number.NaN;
    const most: Record<string, number> = {};
    for (const params of sweep) for (const [id, geometry] of Object.entries(evaluate(params).geometry)) {
      expect(count(geometry), id).toBeLessThanOrEqual(manifest.geometry[id]!.maxElements);
      most[id] = Math.max(most[id] ?? 0, count(geometry));
    }
    // Every declared maximum is reached by some frame: the bounds are tight, not padding.
    expect(most).toEqual(Object.fromEntries(Object.entries(manifest.geometry).map(([id, geometry]) => [id, geometry.maxElements])));
    expect(manifest.geometry.curve!.maxElements).toBe(FUNCTION_DERIVATIVE_CURVE.samples);
    expect(manifest.limits.maxGeometryElements).toBe(Object.values(manifest.geometry).reduce((total, geometry) => total + geometry.maxElements, 0));
  });

  it('states interpretation, assumptions, limitations and a derivation', () => {
    const { interpretation, sources } = manifest;
    expect(interpretation.coordinateConvention).toMatch(/positive slope rises to the right/);
    expect(interpretation.assumptions.length).toBeGreaterThanOrEqual(3);
    expect(interpretation.limitations.join(' ')).toMatch(/undefined at h = 0/);
    expect(interpretation.limitations.join(' ')).toMatch(/double sum p \+ h/);
    expect(sources.map(source => source.kind)).toEqual(['derivation', 'specification']);
    expect(sources[0]!.citation).toMatch(/2A·x \+ B \+ A·h.*Not independently reviewed/);
  });

  it('enforces the coupled constraint identically for exact entry, previews, commits and the worker', () => {
    const outside = { ...defaults, p: 4.5, h: 1 };
    expect(manifest.constraints).toEqual([expect.objectContaining({ id: 'secant-in-domain', expression: 'p + h', min: -5, max: 5, minInclusive: true, maxInclusive: true })]);
    expect(checkParameters(manifest, outside)).toEqual([expect.objectContaining({ code: 'CONSTRAINT_VIOLATION', path: '$.constraints.secant-in-domain', recovery: expect.stringContaining('p + h') })]);
    // Pointer clamping never resolves a coupled violation silently; it is reported instead.
    expect(clampForPreview(manifest, outside)).toEqual({ params: outside, clamped: [] });
    expect(() => evaluate(outside)).toThrow(ModelError);
    expect(() => kernel.evaluate({ params: outside, index: 0 })).toThrow(RangeError);
    for (const edge of [{ p: 3, h: 2 }, { p: -3, h: -2 }, { p: 5, h: 0 }, { p: -5, h: 0 }]) expect(checkParameters(manifest, { ...defaults, ...edge }), JSON.stringify(edge)).toEqual([]);
    // The message names no model output, so it is safe before any reveal.
    expect(manifest.constraints[0]!.message).not.toMatch(/slope|derivative|tangent|secant/i);
  });
});

describe('function-derivative activity template (report §6.1, §11, §12.1)', () => {
  it('passes schema and semantic validation against its manifest with content-derived identity', () => {
    expect(validateRecord('study-harness.activity-template', template)).toEqual({ ok: true, diagnostics: [] });
    expect(validateTemplateSemantics(template, manifest)).toEqual([]);
    expect(template.model).toEqual({ modelId: manifest.modelId, version: manifest.version, digest: modelIdentity(manifest).digest });
    expect(template.requires).toEqual(manifest.capabilities);
    expect(templateRef(template)).toEqual({ templateId: 'function-derivative', version: '1.0.0', digest: templateDigest(template) });
    expect(groupDigests(template, manifest).map(entry => entry.groupId)).toEqual(template.groups.map(group => group.id));
  });

  it('binds content approval to learner text: an edit changes the template and that group digest only', () => {
    const edited = structuredClone(template) as ActivityTemplate;
    edited.equations.find(equation => equation.id === 'slope-at-probe')!.plain = 'slope = {{q:derivative}}';
    expect(templateDigest(edited)).not.toBe(templateDigest(template));
    const changed = template.groups.filter(group => groupContentDigest(edited, manifest, group.id) !== groupContentDigest(template, manifest, group.id)).map(group => group.id);
    expect(changed).toEqual(['slope-equations']);
  });

  it('has the required stages, with free exploration reachable only through host authorization', () => {
    expect(new Set(template.stages.map(entry => entry.kind))).toEqual(new Set(['prepare', 'predict', 'explore', 'explain', 'closed']));
    expect(template.stages.map(entry => entry.id)).toEqual(['prepare', 'predict', 'explore-slope', 'explore-derivative', 'explain', 'closed', 'free-explore']);
    expect(template.initialStage).toBe('prepare');
    const reachable = new Set([template.initialStage]);
    for (let grown = true; grown;) {
      grown = false;
      for (const transition of template.transitions) if (reachable.has(transition.from) && !reachable.has(transition.to)) { reachable.add(transition.to); grown = true; }
    }
    expect([...reachable].sort()).toEqual(['closed', 'explain', 'explore-derivative', 'explore-slope', 'predict', 'prepare']);
    expect(template.transitions.filter(transition => transition.from === 'free-explore' || transition.to === 'free-explore')).toEqual([expect.objectContaining({ from: 'free-explore', to: 'closed' })]);
    expect(template.transitions.filter(transition => transition.to === 'explore-derivative').map(transition => transition.from)).toEqual(['explore-slope']);
    expect(stage('predict').response).toEqual({ kind: 'prediction', prompt: COPY.stages.predict.prompt, taskFamily: 'function-derivative-slope-prediction' });
    expect(stage('explain').response?.kind).toBe('explanation');
    expect(stage('closed')).toMatchObject({ visible: {}, controls: {}, allowsPreview: false });
  });

  it('marks every group that carries slope information as solution-bearing, and only those', () => {
    for (const group of template.groups) {
      const bound = marks.filter(({ mark }) => mark.group === group.id).map(({ mark }) => mark.bindings.geometry!);
      const views = template.views.filter(view => view.group === group.id && view.kind !== 'values' && view.kind !== 'equation');
      const carries = group.members.some(member => SOLUTION_QUANTITIES.has(member) || SOLUTION_GEOMETRY.has(member) || member === 'derivative-plot')
        || bound.some(id => SOLUTION_GEOMETRY.has(id)) || views.some(view => view.rowsFrom !== undefined && SOLUTION_GEOMETRY.has(view.rowsFrom))
        || template.equations.some(equation => equation.group === group.id && /\{\{q:|f'/.test(equation.tex));
      expect(group.solutionBearing, group.id).toBe(carries);
    }
    expect(template.groups.filter(group => group.solutionBearing).map(group => group.id)).toEqual([
      'tangent', 'slope', 'slope-equations', 'secant', 'secant-values', 'secant-equations', 'derivative-plot', 'shape', 'derivative-rule',
    ]);
    // Placeholders appear only in solution-bearing groups.
    for (const equation of template.equations) if (/\{\{q:/.test(equation.tex + equation.plain)) expect(groupOf(equation.group).solutionBearing, equation.id).toBe(true);
  });

  it('hides tangent, slope, secant and derivative before the prediction, and shows the derivative graph only when authorized', () => {
    const solution = new Set(template.groups.filter(group => group.solutionBearing).map(group => group.id));
    for (const id of ['prepare', 'predict']) {
      expect(Object.keys(stage(id).visible).filter(group => solution.has(group)), id).toEqual([]);
      expect(stage(id).controls.h, id).toBeUndefined();
      expect(Object.keys(stage(id).visible), id).toEqual(expect.arrayContaining(['function-plot', 'probe']));
    }
    expect(stage('predict')).toMatchObject({ allowsPreview: false, allowsPlayback: false, allowsNavigation: false });
    expect(Object.values(stage('predict').controls).every(mode => mode === 'fixed')).toBe(true);
    expect(stage('explore-slope').visible).toMatchObject({ tangent: 'interactive', slope: 'fixed', secant: 'interactive', 'secant-values': 'fixed', 'offset-control': 'interactive' });
    expect(stage('explore-slope').controls).toEqual({ A: 'fixed', B: 'fixed', C: 'fixed', p: 'interactive', h: 'interactive' });
    expect(template.stages.filter(entry => entry.visible['derivative-plot']).map(entry => entry.id)).toEqual(['explore-derivative', 'explain', 'free-explore']);
    expect(template.stages.filter(entry => entry.visible.shape).map(entry => entry.id)).toEqual(['explore-derivative', 'explain', 'free-explore']);
  });

  it('binds marks only to manifest geometry, with labels and non-colour encodings', () => {
    for (const { view, mark } of marks) {
      expect(Object.keys(mark.bindings), mark.id).toEqual(['geometry']);
      expect(manifest.geometry[mark.bindings.geometry!], mark.id).toBeDefined();
      expect(mark.label.length, mark.id).toBeGreaterThan(5);
      expect(view.kind, mark.id).toBe('plot2d');
    }
    for (const view of template.views.filter(entry => entry.marks.length)) {
      // Lines differ by dash and points by marker shape, so no meaning depends on colour alone.
      const lines = view.marks.filter(mark => mark.style.marker === 'none').map(mark => mark.style.dash);
      const points = view.marks.filter(mark => mark.style.marker !== 'none').map(mark => mark.style.marker);
      expect(new Set(lines).size, view.id).toBe(lines.length);
      expect(new Set(points).size, view.id).toBe(points.length);
    }
    expect(marks.find(({ mark }) => mark.id === 'probe-marker')!.mark.drag).toEqual({ x: 'p' });
    expect([...template.views.find(view => view.id === 'readouts')!.quantities!].sort()).toEqual(Object.keys(manifest.quantities).sort());
  });

  it('has one exact, keyboard-operable control per parameter in canonical display units', () => {
    expect(template.controls.map(control => control.parameter)).toEqual(Object.keys(manifest.parameters));
    for (const control of template.controls) {
      expect(control.displayUnits, control.parameter).toEqual(['dimensionless']);
      expect(control.exact && control.slider, control.parameter).toBe(true);
      expect(control.step, control.parameter).toBe(manifest.parameters[control.parameter]!.step.ui);
    }
  });

  it('uses only approved, fully specified scenarios that the runtime accepts', () => {
    expect(template.scenarios.length).toBeGreaterThanOrEqual(4);
    for (const scenario of template.scenarios) {
      expect(Object.keys(scenario.parameters).sort(), scenario.id).toEqual(Object.keys(manifest.parameters).sort());
      expect(checkParameters(manifest, scenario.parameters), scenario.id).toEqual([]);
      expect(() => evaluate(scenario.parameters), scenario.id).not.toThrow();
      expect(scenario.label, scenario.id).not.toMatch(/slope|tangent|derivative|vertex|increas|decreas/i);
    }
    const offsets = template.scenarios.filter(scenario => scenario.id.startsWith('offset-'));
    expect(offsets.map(scenario => scenario.parameters.h)).toEqual([1, 0.1, 0.01]);
    expect(new Set(offsets.map(scenario => JSON.stringify({ ...scenario.parameters, h: 0 }))).size).toBe(1);
    expect(template.scenarios.map(scenario => evaluate(scenario.parameters).quantities.curvature)).toEqual(expect.arrayContaining(
      ['positive-curvature', 'negative-curvature', 'linear', 'constant'].map(value => ({ status: 'valid', value }))));
  });

  it('gives every graph an equivalent alternative wherever it is visible, each verified by a named browser test', () => {
    const spatial = template.views.filter(view => view.kind === 'plot2d');
    expect(spatial.map(view => view.id)).toEqual(['function-plot', 'derivative-plot']);
    for (const view of spatial) {
      const equivalents = template.alternatives.filter(alternative => alternative.covers.includes(view.id) && alternative.equivalence === 'equivalent');
      expect(equivalents.length, view.id).toBeGreaterThan(0);
      for (const entry of template.stages.filter(item => item.visible[view.group]))
        expect(equivalents.some(alternative => entry.visible[alternative.group]), `${view.id} in ${entry.id}`).toBe(true);
      for (const mark of view.marks) expect(template.alternatives.some(alternative => alternative.covers.includes(mark.id) && alternative.equivalence === 'equivalent'), mark.id).toBe(true);
    }
    for (const parameter of Object.keys(manifest.parameters)) for (const kind of ['numeric-entry', 'keyboard'] as const)
      expect(template.alternatives.some(alternative => alternative.kind === kind && alternative.covers.includes(parameter)), `${kind} ${parameter}`).toBe(true);
    for (const alternative of template.alternatives) expect(alternative.verifiedBy, alternative.id).toMatch(/^tests\/browser\/study-function-derivative\.spec\.ts#[a-z0-9-]+$/);
    // Every table equivalent has a table view drawing rows from the same geometry as the graph it replaces.
    expect(template.views.filter(view => view.kind === 'table').map(view => [view.group, view.rowsFrom])).toEqual([['function-plot', 'curve'], ['derivative-plot', 'derivative-curve']]);
  });
});

describe('function-derivative content boundaries (report §12.6)', () => {
  const FORBIDDEN_KEY = /^(answers?|answer[-_]?key|rubrics?|solutions?|correct([-_]?answer)?|expected[-_]?(response|answer)|held[-_]?out|scor(e|ing)|grade|mark[-_]?scheme|review(ed|er)?|approv(ed|al))$/i;
  const keys = (value: unknown, path = '$'): string[] => !value || typeof value !== 'object' ? []
    : Object.entries(value).flatMap(([key, item]) => [...(Array.isArray(value) ? [] : [`${path}.${key}`]), ...keys(item, `${path}.${key}`)]);

  it('carries no answer keys, rubrics, solutions or review claims, and only host-owned task families', () => {
    for (const data of [template, manifest] as (ActivityTemplate | ModelManifest)[]) expect(keys(data).filter(path => FORBIDDEN_KEY.test(path.slice(path.lastIndexOf('.') + 1)))).toEqual([]);
    for (const family of template.taskFamilies) {
      expect(Object.keys(family).sort()).toEqual(['description', 'hostOwned', 'id']);
      expect(family.hostOwned).toBe(true);
    }
    for (const entry of template.stages) if (entry.response) expect(Object.keys(entry.response).sort()).toEqual(['kind', 'prompt', 'taskFamily']);
    const field = /["']?\b(answers?|answerKey|rubrics?|solutions?|correctAnswer|expectedResponse|heldOut|scoring)\b["']?\s*:/i;
    expect(SOURCES.filter(file => field.test(readFileSync(file, 'utf8')))).toEqual([]);
  });

  it('uses neutral learner copy without mastery, grading or review claims', () => {
    const learnerText = [
      template.title, template.purpose,
      ...template.stages.flatMap(entry => [entry.instruction, entry.response?.prompt ?? '']),
      ...template.groups.flatMap(group => [group.label, group.description]),
      ...template.views.flatMap(view => [view.title, view.description, ...view.marks.flatMap(mark => [mark.label, mark.text ?? ''])]),
      ...template.controls.flatMap(control => [control.label, control.description]),
      ...template.scenarios.flatMap(scenario => [scenario.label, scenario.description]),
      ...template.alternatives.flatMap(alternative => [alternative.label, alternative.description]),
      ...template.equations.flatMap(equation => [equation.label, equation.plain]),
      ...template.content.filter(entry => entry.kind === 'learner-copy').map(entry => entry.text),
    ];
    const claims = /\b(master(ed|y|s)?|understo{1,2}d|understands|learned|knows|correct(ly)?|incorrect|wrong|right answer|reviewed|approved|certified|well done|great job)\b/i;
    expect(learnerText.filter(text => claims.test(text))).toEqual([]);
    // Copy shown before the prediction names no slope value or direction of the graph at P.
    const early = [COPY.stages.prepare.instruction, COPY.stages.predict.instruction, COPY.stages.predict.prompt, ...['functionPlot', 'probe', 'functionRule', 'coefficientControls', 'probeControl', 'alternatives'].flatMap(id => Object.values(COPY.groups[id as keyof typeof COPY.groups]))];
    expect(early.filter(text => /\b(is|are) (increasing|decreasing|stationary)|f′\(p\) =|= ?-?\d/.test(text))).toEqual([]);
  });

  it('keeps the kernel module free of templates, copy, manifests and DOM', () => {
    const source = readFileSync(SOURCES[0]!, 'utf8');
    expect([...source.matchAll(/from\s+'([^']+)'/g)].map(match => match[1])).toEqual(['@explorable-models/core/model']);
    expect(source).not.toMatch(/\b(document|window|React|fetch|Math\.random|Date\.now)\b/);
  });
});

describe('function-derivative through the core model runtime', () => {
  const cleanup: { dispose(): void }[] = [];
  afterEach(() => { for (const item of cleanup.splice(0)) item.dispose(); });
  let operation = 0;
  const guard = (session: ModelSession): ModelGuard => ({ sessionId: session.id, expectedVersion: session.getState().version, expectedRunId: session.getState().run?.id ?? null, operationId: `op-${++operation}` });

  it('loads the static model in a worker, rejects a coupled violation keeping the last accepted frame, and samples in isolation', async () => {
    const group = inlineWorkers([kernel]);
    const session = createModelSession({ workerFactory: group.factory });
    cleanup.push(session);
    const loaded = await session.load(manifest, null, guard(session));
    expect(loaded.frame!.position).toEqual({ kind: 'static' });
    expect(loaded.frame!.quantities.derivative).toEqual({ status: 'valid', value: -1 });
    const frameId = loaded.frame!.frameId;

    let rejected: unknown;
    try { await session.commitParameters({ ...defaults, p: 4.5, h: 1 }, guard(session)); } catch (error) { rejected = error; }
    expect(rejected).toBeInstanceOf(ModelError);
    expect((rejected as ModelError).diagnostics[0]).toMatchObject({ code: 'CONSTRAINT_VIOLATION', path: '$.constraints.secant-in-domain' });
    expect(session.getState().frame!.frameId).toBe(frameId);

    const coincident = await session.commitParameters({ ...defaults, h: 0 }, guard(session));
    expect(coincident.run!.params.h).toBe(0);
    expect(coincident.frame!.quantities['secant.slope']).toMatchObject({ status: 'undefined', code: 'COINCIDENT_POINTS' });
    expect(coincident.frame!.geometry.secant).toEqual({ kind: 'segments2', segments: [] });

    const before = session.getState();
    const sample = await session.sample({ params: { ...defaults, p: 1, h: 0.5 }, positions: [{ kind: 'static' }] });
    expect(sample.frames[0]!.quantities['slope.sign']).toEqual({ status: 'valid', value: 'stationary' });
    expect(session.getState().version).toBe(before.version);
    expect(session.getState().frame!.frameId).toBe(before.frame!.frameId);
  });
});
