import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  groupContentDigest, groupDigests, templateDigest, templateRef, validateRecord, validateTemplateSemantics, type ActivityTemplate, type MarkSpec,
} from '@explorable-models/activity';
import {
  checkParameters, createModelEvaluator, isCompatible, modelIdentity, validateManifest, type ModelManifest, type QuantityResult,
} from '@explorable-models/core/model';
import { LINEAR_COPY } from '../../packages/catalog/src/copy/linear-transformation';
import {
  LINEAR_GRID, LINEAR_KERNEL_ID, LINEAR_KERNEL_VERSION, linearTransformationKernel as kernel,
} from '../../packages/catalog/src/kernels/linear-transformation';
import { LINEAR_REFERENCE_SUITE_DIGEST, linearTransformationManifest as manifest } from '../../packages/catalog/src/models/linear-transformation';
import { linearTransformationTemplate as template } from '../../packages/catalog/src/templates/linear-transformation';
import { inlineWorkers } from '../core/support/inline-worker';

// Catalogue-level checks for the linear-transformation package (report §5.2, §11, §12.2, §12.6). The package is not
// yet registered in the installed catalogue index; these tests validate its modules directly with the same checks
// `createInstalledCatalog` applies to every installed entry.
const root = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURE = join(root, 'tests/reference/fixtures/activities/linear-transformation.json');
const SOURCES = ['kernels', 'models', 'templates', 'copy'].map(folder => join(root, `packages/catalog/src/${folder}/linear-transformation.ts`));
const SPATIAL = new Set(['scene2d', 'plot2d', 'scene3d']);
const marks = (): MarkSpec[] => template.views.flatMap(view => view.marks);
const groupOf = (id: string) => template.groups.find(group => group.id === id)!;
const stage = (id: string) => template.stages.find(entry => entry.id === id)!;

/** Outputs that depend on the matrix entries jointly; everything else is a reference or a copy of visible entries. */
const SOLUTION_QUANTITIES = ['image.v', 'determinant', 'area.scale', 'orientation', 'rank', 'image.direction', 'trace', 'eigen.discriminant', 'eigen.category', 'eigen.values', 'eigen.direction1', 'eigen.direction2'];
const SOLUTION_GEOMETRY = ['grid.transformed', 'unit-square.image', 'eigen.lines'];

describe('linear-transformation catalogue entry (report §5.2, §12.2)', () => {
  it('serves a manifest and template that pass the installed-catalogue validation', () => {
    const { manifest: checked, identity } = validateManifest(manifest);
    expect(checked).toEqual(manifest);
    expect(identity.digest).toBe(template.model.digest);
    expect(template.model).toEqual({ modelId: manifest.modelId, version: manifest.version, digest: modelIdentity(manifest).digest });
    expect(validateRecord('study-harness.activity-template', template)).toEqual({ ok: true, diagnostics: [] });
    expect(validateTemplateSemantics(template, manifest)).toEqual([]);
    expect(template.requires).toEqual(manifest.capabilities);
    expect(manifest.execution).toEqual({ kind: 'kernel', kernelId: LINEAR_KERNEL_ID, kernelVersion: LINEAR_KERNEL_VERSION, mode: 'static' });
    expect([kernel.id, kernel.version, kernel.mode, Object.isFrozen(kernel)]).toEqual([LINEAR_KERNEL_ID, '1.0.0', 'static', true]);
    expect(manifest.constraints).toEqual([]);
  });

  it('pins the reference-suite digest to the exact fixture bytes', () => {
    const bytes = readFileSync(FIXTURE);
    expect(manifest.referenceSuite).toEqual({ suiteId: 'linear-transformation:1.0.0', digest: LINEAR_REFERENCE_SUITE_DIGEST });
    expect(LINEAR_REFERENCE_SUITE_DIGEST).toBe(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
    expect(JSON.parse(bytes.toString('utf8')).suiteId).toBe(manifest.referenceSuite!.suiteId);
  });

  it('declares canonical units, meanings and frames for every quantity and parameter', () => {
    for (const [id, parameter] of Object.entries(manifest.parameters)) {
      expect([parameter.unit, parameter.dimension, parameter.min, parameter.max, parameter.step.admissible], id).toEqual(['dimensionless', 'dimensionless', -3, 3, 'continuous']);
    }
    for (const [id, quantity] of Object.entries(manifest.quantities)) {
      expect([quantity.unit, quantity.dimension], id).toEqual(['dimensionless', 'dimensionless']);
      expect(quantity.meaning.length, id).toBeGreaterThan(40);
      // Plane vectors carry the frame; the eigenvalue pair is two scalars, not a vector in the plane.
      if (quantity.shape.kind === 'vector' && id !== 'eigen.values') expect([quantity.coordinateFrame, quantity.signConvention], id).toEqual([expect.stringContaining('x to the right'), expect.stringContaining('(x, y)')]);
    }
    for (const id of ['determinant', 'orientation', 'eigen.values']) expect(manifest.quantities[id]!.signConvention, id).toEqual(expect.any(String));
    expect(manifest.quantities['area.scale']!.meaning).toMatch(/nonnegative/i);
    expect(manifest.interpretation.assumptions.length).toBeGreaterThanOrEqual(3);
    expect(manifest.interpretation.limitations.join(' ')).toMatch(/nearest double/);
    expect(manifest.sources.map(source => source.kind)).toEqual(['derivation', 'specification']);
  });

  it('states the column-vector convention in the interpretation, the copy and the equations', () => {
    expect(manifest.interpretation.coordinateConvention).toMatch(/M·e₁ = \(m11, m21\) is the FIRST COLUMN/);
    expect(manifest.quantities['image.e1']!.meaning).toMatch(/FIRST COLUMN/);
    expect(LINEAR_COPY.convention).toMatch(/first column of M is M·e₁/);
    expect(LINEAR_COPY.stages.prepare.instruction).toMatch(/first column of M is where e₁ = \(1, 0\) lands/);
    expect(template.equations.find(equation => equation.id === 'column-convention')!.plain).toMatch(/M·e1 = \(m11, m21\) is the first column/);
  });

  it('sizes geometry by the frame counting rules and fills the declared bounds exactly', () => {
    expect(Object.fromEntries(Object.entries(manifest.geometry).map(([id, g]) => [id, [g.kind, g.maxElements]]))).toEqual({
      'grid.original': ['segments2', 2 * LINEAR_GRID.segments], 'grid.transformed': ['segments2', 2 * LINEAR_GRID.segments],
      'unit-square': ['polygon2', 4], 'unit-square.image': ['polygon2', 4], 'eigen.lines': ['segments2', 4],
    });
    expect(manifest.limits.maxGeometryElements).toBe(Object.values(manifest.geometry).reduce((total, g) => total + g.maxElements, 0));
    const output = kernel.evaluate({ params: { m11: 0, m12: 1, m21: 1, m22: 0, vx: 1, vy: 1 }, index: 0 });
    const count = (id: string) => { const g = output.geometry[id]!; return g.kind === 'segments2' ? 2 * g.segments.length : g.kind === 'polygon2' ? g.vertices.length : -1; };
    expect(Object.keys(manifest.geometry).map(id => [id, count(id)])).toEqual(Object.entries(manifest.geometry).map(([id, g]) => [id, g.maxElements]));
  });

  it('evaluates through the model worker protocol, and rejects out-of-domain entries before any worker message', async () => {
    const group = inlineWorkers([kernel]);
    const evaluator = createModelEvaluator(group.factory);
    try {
      const defaults = Object.fromEntries(Object.entries(manifest.parameters).map(([id, p]) => [id, p.default]));
      const data = await evaluator.evaluate({ manifest, params: defaults, position: { kind: 'static' } });
      expect(data.position).toEqual({ kind: 'static' });
      expect(data.terminal).toEqual({ reached: false });
      expect([data.quantities.determinant, data.quantities['eigen.values'], data.quantities['eigen.category']]).toEqual([
        { status: 'valid', value: 1 }, { status: 'valid', value: [2, 0.5] }, { status: 'valid', value: 'two-real' },
      ]);
      const received = group.received;
      await expect(evaluator.evaluate({ manifest, params: { ...defaults, m21: 4 }, position: { kind: 'static' } }))
        .rejects.toMatchObject({ diagnostics: [expect.objectContaining({ code: 'OUT_OF_DOMAIN', path: '$.parameters.m21' })] });
      expect(group.received).toBe(received);
    } finally {
      evaluator.dispose();
    }
  });

  it('changes identity when meaning or learner text changes, and not otherwise', () => {
    const edited = structuredClone(manifest) as ModelManifest;
    edited.quantities['area.scale']!.meaning = 'Signed area det M of the image of the unit square.';
    expect(modelIdentity(edited).scientificRevision).not.toBe(modelIdentity(manifest).scientificRevision);
    // Label spelling is presentation; label wording is meaning (report §8.3, R38), so even a synonym needs a new review.
    const respelled = structuredClone(manifest) as ModelManifest;
    respelled.quantities['area.scale']!.label = 'Area\u00a0scale';
    expect(modelIdentity(respelled).scientificRevision).toBe(modelIdentity(manifest).scientificRevision);
    const relabelled = structuredClone(manifest) as ModelManifest;
    relabelled.quantities['area.scale']!.label = 'Area factor';
    expect(modelIdentity(relabelled).scientificRevision).not.toBe(modelIdentity(manifest).scientificRevision);
    // Entry (1, 2) and entry (2, 1) trade names: the transposed reading of the matrix is a different experiment.
    const transposed = structuredClone(manifest) as ModelManifest;
    [transposed.parameters.m12!.label, transposed.parameters.m21!.label] = [transposed.parameters.m21!.label, transposed.parameters.m12!.label];
    expect(modelIdentity(transposed).scientificRevision).not.toBe(modelIdentity(manifest).scientificRevision);
    const copy = structuredClone(template) as ActivityTemplate;
    copy.views[0]!.marks.find(mark => mark.id === 'image-vector')!.label = 'Mv';
    expect(templateRef(copy).digest).not.toBe(templateDigest(template));
    expect(groupContentDigest(copy, manifest, 'image-vector')).not.toBe(groupContentDigest(template, manifest, 'image-vector'));
    expect(groupContentDigest(copy, manifest, 'basis')).toBe(groupContentDigest(template, manifest, 'basis'));
    expect(groupDigests(template, manifest).map(entry => entry.groupId)).toEqual(template.groups.map(group => group.id));
  });
});

describe('linear-transformation disclosure and stages (report §6, §12.2)', () => {
  it('has stable group IDs with honest solution-bearing flags', () => {
    expect(template.groups.map(group => [group.id, group.kind, group.solutionBearing])).toEqual([
      ['plane', 'view', false], ['reference', 'dataset', false], ['basis', 'quantity', false], ['columns', 'quantity', false],
      ['test-vector', 'quantity', false], ['matrix-control', 'control', false], ['vector-control', 'control', false], ['convention', 'equation', false],
      ['readouts', 'view', false], ['transformed', 'dataset', true], ['image-vector', 'quantity', true], ['determinant', 'quantity', true],
      ['collapse', 'quantity', true], ['determinant-rule', 'equation', false], ['determinant-values', 'equation', true], ['eigen', 'quantity', true],
      ['eigen-lines', 'dataset', true], ['eigen-rule', 'equation', false], ['eigen-values', 'equation', true], ['scenarios', 'annotation', false],
      ['alternatives', 'alternative', false],
    ]);
  });

  it('keeps every jointly computed output, and every mark drawing one, in solution-bearing groups', () => {
    for (const group of template.groups) {
      const hidden = group.members.filter(id => SOLUTION_QUANTITIES.includes(id) || SOLUTION_GEOMETRY.includes(id));
      if (hidden.length) expect(group.solutionBearing, `${group.id} holds ${hidden.join(', ')}`).toBe(true);
    }
    for (const id of [...SOLUTION_QUANTITIES, ...SOLUTION_GEOMETRY]) expect(template.groups.some(group => group.members.includes(id)), id).toBe(true);
    for (const mark of marks()) {
      const bound = Object.values(mark.bindings);
      if (bound.some(id => SOLUTION_QUANTITIES.includes(id!) || SOLUTION_GEOMETRY.includes(id!))) expect(groupOf(mark.group).solutionBearing, mark.id).toBe(true);
    }
    const solution = new Set(template.groups.filter(group => group.solutionBearing).map(group => group.id));
    for (const equation of template.equations) if (/\{\{q:/.test(equation.tex + equation.plain)) expect(solution.has(equation.group), equation.id).toBe(true);
    // Views that list solution quantities may sit in non-solution groups only because hidden values are omitted from them.
    expect(template.views.filter(view => view.rowsFrom !== undefined && SOLUTION_GEOMETRY.includes(view.rowsFrom)).every(view => solution.has(view.group))).toBe(true);
  });

  it('shows the convention and untransformed plane in prepare and predict, with every transformed result hidden', () => {
    const solution = new Set(template.groups.filter(group => group.solutionBearing).map(group => group.id));
    expect(template.initialStage).toBe('prepare');
    for (const id of ['prepare', 'predict']) {
      const entry = stage(id);
      expect(Object.keys(entry.visible).filter(group => solution.has(group)), id).toEqual([]);
      expect(Object.keys(entry.visible).sort(), id).toEqual(['alternatives', 'basis', 'columns', 'convention', 'matrix-control', 'plane', 'readouts', 'reference', 'test-vector', 'vector-control']);
      expect(Object.values(entry.controls).every(mode => mode === 'fixed'), id).toBe(true);
      expect(entry.allowsPreview || entry.allowsPlayback || entry.allowsNavigation, id).toBe(false);
    }
    expect(stage('predict').response).toEqual({ kind: 'prediction', prompt: LINEAR_COPY.stages.predict.prompt, taskFamily: 'linear-transformation-prediction' });
    expect(stage('predict').response!.prompt).toMatch(/orientation|counterclockwise/);
    expect(stage('predict').response!.prompt).toMatch(/flatten/);
    expect(stage('predict').response!.prompt).toMatch(/own line/);
  });

  it('reveals the transformed plane in explore and the unchanged directions only in a later stage', () => {
    const explore = stage('explore'), eigen = stage('explore-eigen');
    for (const id of ['transformed', 'image-vector', 'determinant', 'collapse', 'determinant-values']) expect(explore.visible[id], id).toBe('fixed');
    for (const id of ['eigen', 'eigen-lines', 'eigen-values', 'eigen-rule']) {
      expect(explore.visible[id], id).toBeUndefined();
      expect(eigen.visible[id], id).toBe('fixed');
      expect(stage('free-explore').visible[id], id).toBe('fixed');
    }
    for (const entry of [explore, eigen, stage('free-explore')]) {
      expect(Object.values(entry.controls), entry.id).toEqual(Array(6).fill('interactive'));
      expect([entry.allowsPreview, entry.allowsPlayback, entry.allowsNavigation], entry.id).toEqual([true, false, false]);
      expect(entry.visible['matrix-control'], entry.id).toBe('interactive');
    }
    expect(stage('explain').response).toMatchObject({ kind: 'explanation', taskFamily: 'linear-transformation-explanation' });
    expect(stage('closed')).toMatchObject({ visible: {}, controls: {} });
    expect(template.transitions.some(transition => transition.to === 'free-explore')).toBe(false);
    expect(template.transitions.filter(transition => transition.to === 'closed').map(transition => transition.from).sort())
      .toEqual(template.stages.filter(entry => entry.id !== 'closed').map(entry => entry.id).sort());
  });
});

describe('linear-transformation representations and alternatives (report §10.2, §11)', () => {
  it('binds every mark to manifest geometry or quantities, with labels and non-color distinctions', () => {
    const view = template.views.find(entry => entry.id === 'plane')!;
    // ±8 contains the transformed grid of the default matrix (out to x = ±7.5), so the default stages open without
    // out-of-view data (G42); the reference grid is background (role `reference`).
    expect([view.kind, view.equalAspect, view.bounds]).toEqual(['scene2d', true, [-8, 8, -8, 8]]);
    expect(view.marks.find(mark => mark.id === 'original-grid')!.style.role).toBe('reference');
    for (const mark of marks()) {
      expect(mark.label.length, mark.id).toBeGreaterThan(3);
      for (const [key, id] of Object.entries(mark.bindings)) expect(key === 'geometry' ? manifest.geometry[id!] : manifest.quantities[id!], `${mark.id}.${key}`).toBeDefined();
      if (mark.kind === 'arrow') expect(mark.text, mark.id).toEqual(expect.any(String));
    }
    // No two marks of a view differ by colour role alone: kind, marker, dash and weight already tell them apart.
    const signature = (mark: MarkSpec) => [mark.kind, mark.style.marker, mark.style.dash, mark.style.weight].join('/');
    expect(new Set(view.marks.map(signature)).size).toBe(view.marks.length);
    expect(marks().filter(mark => mark.kind === 'arrow').map(mark => mark.bindings.vector).sort()).toEqual(
      ['basis.e1', 'basis.e2', 'eigen.direction1', 'eigen.direction2', 'image.e1', 'image.e2', 'image.v', 'vector.v']);
  });

  it('offers a control with exact entry and canonical display units for every parameter', () => {
    expect(template.controls.map(control => control.parameter).sort()).toEqual(Object.keys(manifest.parameters).sort());
    for (const control of template.controls) {
      expect([control.exact, control.slider, control.displayUnits], control.parameter).toEqual([true, true, ['dimensionless']]);
      expect(isCompatible(control.displayUnits[0]!, manifest.parameters[control.parameter]!.unit)).toBe(true);
    }
    expect(template.controls.filter(control => control.group === 'matrix-control').map(control => control.label)).toEqual([
      'm₁₁ (row 1, column 1)', 'm₁₂ (row 1, column 2)', 'm₂₁ (row 2, column 1)', 'm₂₂ (row 2, column 2)',
    ]);
  });

  it('makes every scene and mark equivalent through alternatives that name browser tests', () => {
    const equivalent = template.alternatives.filter(alternative => alternative.equivalence === 'equivalent');
    for (const view of template.views.filter(entry => SPATIAL.has(entry.kind))) {
      expect(equivalent.some(alternative => alternative.covers.includes(view.id)), view.id).toBe(true);
      for (const mark of view.marks) expect(equivalent.some(alternative => alternative.covers.includes(mark.id)), mark.id).toBe(true);
      for (const entry of template.stages) if (entry.visible[view.group]) expect(entry.visible.alternatives, entry.id).toBeDefined();
    }
    for (const kind of ['numeric-entry', 'keyboard'] as const) {
      const alternative = equivalent.find(entry => entry.kind === kind)!;
      expect([...alternative.covers].sort(), kind).toEqual(Object.keys(manifest.parameters).sort());
    }
    for (const alternative of template.alternatives) expect(alternative.verifiedBy).toMatch(/^tests\/browser\/study-linear-transformation\.spec\.ts#[a-z0-9-]+$/);
  });

  it('offers admissible scenarios that reach every reference family', () => {
    const outcome = (id: string, quantity: string): unknown => {
      const scenario = template.scenarios.find(entry => entry.id === id)!;
      const result = kernel.evaluate({ params: scenario.parameters, index: 0 }).quantities[quantity] as QuantityResult;
      return result.status === 'valid' ? result.value : result.code;
    };
    for (const scenario of template.scenarios) {
      expect(checkParameters(manifest, scenario.parameters), scenario.id).toEqual([]);
      expect(scenario.group).toBe('scenarios');
    }
    expect(template.scenarios.find(entry => entry.id === 'rotation-30')!.parameters.m11).toBe(Math.sqrt(3) / 2);
    expect([outcome('identity', 'eigen.category'), outcome('rotation-30', 'eigen.category'), outcome('rotation-120', 'eigen.category'), outcome('shear', 'eigen.category')])
      .toEqual(['repeated-scalar', 'complex', 'complex', 'repeated-defective']);
    expect([outcome('reflection-diagonal', 'orientation'), outcome('reflection-x-axis', 'orientation'), outcome('collapse', 'rank'), outcome('zero-matrix', 'rank')])
      .toEqual(['reversed', 'reversed', 1, 0]);
    expect(outcome('zero-test-vector', 'image.v')).toEqual([0, 0]);
  });
});

describe('linear-transformation content boundaries (report §12.6)', () => {
  const FORBIDDEN_KEY = /^(answers?|answer[-_]?key|rubrics?|solutions?|correct([-_]?answer)?|expected[-_]?(response|answer)|held[-_]?out|scor(e|ing)|grade|mark[-_]?scheme|review(ed|er)?|approv(ed|al))$/i;
  const keys = (value: unknown, path = '$'): string[] => !value || typeof value !== 'object' ? []
    : Object.entries(value).flatMap(([key, item]) => [...(Array.isArray(value) ? [] : [`${path}.${key}`]), ...keys(item, `${path}.${key}`)]);

  it('carries no answer keys, rubrics, solutions or review claims', () => {
    for (const data of [template, manifest]) expect(keys(data).filter(path => FORBIDDEN_KEY.test(path.slice(path.lastIndexOf('.') + 1)))).toEqual([]);
    for (const family of template.taskFamilies) expect([Object.keys(family).sort(), family.hostOwned]).toEqual([['description', 'hostOwned', 'id'], true]);
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
    const claims = /\b(master(ed|y|s)?|understo{1,2}d|understands|learned|knows|correct(ly)?|incorrect|wrong|right answer|reviewed|approved|certified)\b/i;
    expect(learnerText.filter(text => claims.test(text))).toEqual([]);
    expect(learnerText.filter(text => /\{\{|TODO|placeholder/i.test(text) && !/\{\{q:/.test(text))).toEqual([]);
  });

  it('keeps the kernel module free of templates, copy and manifests', () => {
    const source = readFileSync(SOURCES[0]!, 'utf8');
    expect([...source.matchAll(/from\s+'([^']+)'/g)].map(match => match[1])).toEqual(['@explorable-models/core/model']);
    expect(source).toMatch(/import type/);
  });
});
