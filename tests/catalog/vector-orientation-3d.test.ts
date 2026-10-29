import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { groupDigests, templateDigest, validateRecord, validateTemplateSemantics, type ActivityTemplate, type ContentGroup } from '@experiment-kit/activity';
import {
  checkParameters, convert, defaultParameters, evaluateRequest, isCompatible, modelIdentity, validateManifest, type ModelManifest,
} from '@experiment-kit/core/model';
import { VECTOR_ORIENTATION_COPY as COPY } from '../../packages/catalog/src/copy/vector-orientation-3d.js';
import {
  ANGLE_ARC, VECTOR_ORIENTATION_PARAMETERS, VECTOR_RELATIONSHIPS, vectorOrientationKernel as kernel,
} from '../../packages/catalog/src/kernels/vector-orientation-3d.js';
import { VECTOR_ORIENTATION_REFERENCE_SUITE_DIGEST, vectorOrientationManifest as manifest } from '../../packages/catalog/src/models/vector-orientation-3d.js';
import { vectorOrientationTemplate as template } from '../../packages/catalog/src/templates/vector-orientation-3d.js';

// Content-package checks for vector-orientation-3d (report §5.2, §11, §12.4, §12.6). The package is validated through
// its own modules here; catalogue registration is a separate integration step.
const root = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURE = join(root, 'tests/reference/fixtures/activities/vector-orientation-3d.json');
const SOURCES = ['kernels', 'models', 'templates', 'copy'].map(dir => join(root, 'packages/catalog/src', dir, 'vector-orientation-3d.ts'));
const evaluate = (params: Record<string, number>) => evaluateRequest({ manifest, params, position: { kind: 'static' } }, [kernel]);
const groupsOf = (kind: ContentGroup['kind'], id: string) => template.groups.filter(group => group.kind === kind && group.members.includes(id));
const solutionGroups = new Set(template.groups.filter(group => group.solutionBearing).map(group => group.id));
const stage = (id: string) => template.stages.find(entry => entry.id === id)!;
const marks = template.views.flatMap(view => view.marks);

describe('vector-orientation-3d model manifest (report §8.3, §12.4)', () => {
  it('validates and binds to the installed kernel, the template and the exact fixture bytes', () => {
    const { manifest: validated, identity } = validateManifest(manifest);
    expect(validated).toEqual(manifest);
    expect(template.model).toEqual({ modelId: manifest.modelId, version: manifest.version, digest: identity.digest });
    expect(manifest.execution).toEqual({ kind: 'kernel', kernelId: kernel.id, kernelVersion: kernel.version, mode: 'static' });
    expect(kernel.version).toBe('1.0.0');
    expect(Object.isFrozen(kernel)).toBe(true);
    const bytes = readFileSync(FIXTURE);
    expect(VECTOR_ORIENTATION_REFERENCE_SUITE_DIGEST).toBe(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
    expect(manifest.referenceSuite).toEqual({ suiteId: JSON.parse(bytes.toString('utf8')).suiteId, digest: VECTOR_ORIENTATION_REFERENCE_SUITE_DIGEST });
  });

  it('declares canonical units, a right-handed frame, meanings, frames and sign conventions', () => {
    expect(manifest.interpretation.handedness).toBe('right');
    expect(manifest.interpretation.angleConvention).toMatch(/radians/);
    expect(manifest.interpretation.assumptions.length).toBeGreaterThan(2);
    expect(manifest.interpretation.limitations.length).toBeGreaterThan(2);
    expect(manifest.sources.map(source => source.kind)).toContain('derivation');
    expect(Object.keys(manifest.parameters)).toEqual([...VECTOR_ORIENTATION_PARAMETERS]);
    for (const parameter of Object.values(manifest.parameters)) expect(parameter).toMatchObject({ unit: 'dimensionless', dimension: 'dimensionless', min: -3, max: 3, step: { admissible: 'continuous' } });
    expect(manifest.quantities.angle).toMatchObject({ unit: 'rad', dimension: 'angle', shape: { kind: 'scalar' } });
    expect(manifest.quantities.relationship!.shape).toEqual({ kind: 'category', values: [...VECTOR_RELATIONSHIPS] });
    for (const [id, quantity] of Object.entries(manifest.quantities)) {
      expect(quantity.meaning.length, id).toBeGreaterThan(20);
      if (id !== 'relationship') expect(quantity.coordinateFrame, id).toBeDefined();
      if (quantity.shape.kind === 'vector' || ['dot', 'angle', 'u.norm', 'v.norm', 'cross.norm'].includes(id)) expect(quantity.signConvention, id).toBeDefined();
    }
    for (const id of ['cross', 'cross.direction']) expect(manifest.quantities[id]!.signConvention).toMatch(/right-hand rule/i);
    // Display in degrees converts at the boundary; the canonical value stays in radians.
    expect(isCompatible('deg', manifest.quantities.angle!.unit)).toBe(true);
    expect(convert(Math.PI / 2, 'rad', 'deg')).toBeCloseTo(90, 12);
  });

  it('sizes geometry by the frame counting rules and fills it exactly in the largest case', () => {
    const sizes = Object.fromEntries(Object.entries(manifest.geometry).map(([id, geometry]) => [id, [geometry.kind, geometry.maxElements]]));
    expect(sizes).toEqual({
      vectors: ['segments3', 4], cross: ['segments3', 2], 'angle-arc': ['polyline3', ANGLE_ARC.samples],
      'projection-xy': ['segments2', 4], 'projection-xz': ['segments2', 4], 'projection-yz': ['segments2', 4],
    });
    expect(manifest.limits.maxGeometryElements).toBe(Object.values(manifest.geometry).reduce((sum, geometry) => sum + geometry.maxElements, 0));
    const full = evaluate({ ux: 1, uy: 2, uz: 3, vx: -2, vy: 1, vz: 2 }).geometry;
    const vertices = (id: string) => { const g = full[id]!; return g.kind === 'segments2' || g.kind === 'segments3' ? 2 * g.segments.length : g.kind === 'polyline3' ? g.segments.reduce((n, s) => n + s.points.length, 0) : -1; };
    for (const [id, geometry] of Object.entries(manifest.geometry)) expect(vertices(id), id).toBe(geometry.maxElements);
  });

  it('separates scientific meaning from presentation in the model identity (A10)', () => {
    const base = modelIdentity(manifest);
    const edit = (change: (copy: ModelManifest) => void) => { const copy = structuredClone(manifest) as ModelManifest; change(copy); return modelIdentity(copy); };
    expect(edit(copy => { copy.interpretation.handedness = 'left'; }).scientificRevision).not.toBe(base.scientificRevision);
    expect(edit(copy => { copy.quantities.cross!.signConvention = 'Left-hand rule.'; }).scientificRevision).not.toBe(base.scientificRevision);
    expect(edit(copy => { copy.quantities.angle!.unit = 'deg'; }).scientificRevision).not.toBe(base.scientificRevision);
    // Label spelling is presentation; label wording is meaning (report §8.3, R38): even a synonym needs a new review.
    const respelled = edit(copy => { copy.quantities.dot!.label = 'Dot\u00a0product'; });
    expect(respelled.scientificRevision).toBe(base.scientificRevision);
    expect(respelled.presentationRevision).not.toBe(base.presentationRevision);
    const reworded = edit(copy => { copy.quantities.dot!.label = 'Scalar product'; });
    expect(reworded.scientificRevision).not.toBe(base.scientificRevision);
    const swapped = edit(copy => { [copy.quantities.dot!.label, copy.quantities['cross.norm']!.label] = [copy.quantities['cross.norm']!.label, copy.quantities.dot!.label]; });
    expect(swapped.scientificRevision).not.toBe(base.scientificRevision);
  });
});

describe('vector-orientation-3d activity template (report §6, §11, §12.4)', () => {
  it('passes schema and semantic validation as a 3D template', () => {
    expect(validateRecord('study-harness.activity-template', template)).toEqual({ ok: true, diagnostics: [] });
    expect(validateTemplateSemantics(template, manifest)).toEqual([]);
    expect(template.requires).toEqual(manifest.capabilities);
    expect(template.dimension).toBe('3d');
    const digests = groupDigests(template, manifest);
    expect(digests.map(entry => entry.groupId)).toEqual(template.groups.map(group => group.id));
    expect(new Set(digests.map(entry => entry.contentDigest)).size).toBe(digests.length);
    expect(templateDigest(template)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('pairs one bounded 3D scene with three plot2d projections and value tables listing every quantity', () => {
    const scenes = template.views.filter(view => view.kind === 'scene3d');
    expect(scenes).toHaveLength(1);
    // ±4 holds every allowed u and v (G55: the default vectors read at narrow widths); u × v may extend past it.
    expect(scenes[0]).toMatchObject({ id: 'space', equalAspect: true, bounds3: [-4, 4, -4, 4, -4, 4] });
    expect(Object.keys(scenes[0]!.axes!)).toEqual(['x', 'y', 'z']);
    for (const preset of ['isometric', 'front (xz)', 'top (xy)', 'side (yz)']) expect(scenes[0]!.description).toContain(preset);
    const projections = template.views.filter(view => view.kind === 'plot2d');
    expect(projections.map(view => [view.id, view.axes!.x.label, view.axes!.y.label, view.equalAspect])).toEqual([
      ['plane-xy', 'x', 'y', true], ['plane-xz', 'x', 'z', true], ['plane-yz', 'y', 'z', true],
    ]);
    // Every quantity has a numeric place without WebGL.
    const listed = new Set(template.views.filter(view => view.kind === 'values' || view.kind === 'table').flatMap(view => view.quantities ?? []));
    expect([...listed].sort()).toEqual(Object.keys(manifest.quantities).sort());
  });

  it('binds marks only to manifest geometry or quantities, distinguishes them without colour and never leaks hidden output', () => {
    for (const view of template.views) {
      const styles = view.marks.map(mark => `${mark.style.dash}/${mark.style.marker}/${mark.style.weight}/${mark.style.role}`);
      expect(new Set(styles).size, view.id).toBe(styles.length);
      const nonColour = view.marks.map(mark => `${mark.style.dash}/${mark.style.marker}/${mark.style.weight}`);
      expect(new Set(nonColour).size, `${view.id} without colour`).toBe(nonColour.length);
    }
    for (const mark of marks) {
      expect(mark.label.length).toBeGreaterThan(5);
      const bound = Object.entries(mark.bindings);
      expect(bound.length, mark.id).toBeGreaterThan(0);
      for (const [key, id] of bound) {
        const holders = key === 'geometry' ? groupsOf('dataset', id!) : groupsOf('quantity', id!);
        expect(key === 'geometry' ? manifest.geometry[id!] : manifest.quantities[id!], `${mark.id}.${key}`).toBeDefined();
        // A mark that draws solution-bearing output must itself be solution-bearing.
        if (holders.length && holders.every(group => group.solutionBearing)) expect(solutionGroups.has(mark.group), mark.id).toBe(true);
      }
      if (!solutionGroups.has(mark.group)) for (const [key, id] of bound) {
        const holders = key === 'geometry' ? groupsOf('dataset', id!) : groupsOf('quantity', id!);
        expect(holders.some(group => !group.solutionBearing), `${mark.id} binds only non-solution output`).toBe(true);
      }
    }
  });

  it('hides angle, dot and cross product until prediction and reveals them in separate stages', () => {
    expect([...solutionGroups].sort()).toEqual(['angle-arc', 'angle-dot', 'cross', 'cross-drawing', 'cross-values', 'dot-values']);
    expect(template.initialStage).toBe('orient');
    expect(new Set(template.stages.map(entry => entry.kind))).toEqual(new Set(['prepare', 'predict', 'explore', 'explain', 'closed']));
    const visible = (id: string) => Object.keys(stage(id).visible);
    for (const id of ['orient', 'predict']) {
      expect(visible(id).filter(group => solutionGroups.has(group)), id).toEqual([]);
      expect(visible(id)).toEqual(expect.arrayContaining(['space', 'projections', 'vectors', 'components', 'alternatives']));
      expect(stage(id)).toMatchObject({ allowsPreview: false, allowsNavigation: false, allowsPlayback: false });
      expect(Object.values(stage(id).controls).every(mode => mode === 'fixed')).toBe(true);
    }
    expect(stage('predict').response).toEqual({ kind: 'prediction', prompt: COPY.stages.predict.prompt, taskFamily: 'vector-orientation-prediction' });
    expect(visible('explore-angle')).toEqual(expect.arrayContaining(['angle-dot', 'angle-arc', 'dot-values']));
    expect(visible('explore-angle').filter(group => group.startsWith('cross'))).toEqual([]);
    expect(visible('explore-cross')).toEqual(expect.arrayContaining(['angle-dot', 'cross', 'cross-drawing', 'cross-values']));
    expect(Object.values(stage('explain').controls).every(mode => mode === 'fixed')).toBe(true);
    expect(stage('explain').response?.taskFamily).toBe('vector-orientation-explanation');
    expect(stage('closed')).toMatchObject({ visible: {}, controls: {} });
    expect([...solutionGroups].every(group => stage('free-explore').visible[group])).toBe(true);
    // free-explore is entered only by an authorized host preparation, never by a transition.
    expect(template.transitions.filter(transition => transition.to === 'free-explore')).toEqual([]);
    expect(template.transitions.filter(transition => transition.from === 'free-explore').map(transition => transition.to)).toEqual(['closed']);
    for (const equation of template.equations) expect(/\{\{q:/.test(equation.tex), equation.id).toBe(solutionGroups.has(equation.group));
  });

  it('offers a complete path without WebGL and records partial equivalence honestly', () => {
    const covering = (id: string) => template.alternatives.filter(alternative => alternative.covers.includes(id));
    expect(covering('space').map(alternative => [alternative.kind, alternative.equivalence])).toEqual([
      ['alternative-activity', 'alternative-activity'], ['projection-2d', 'partial'], ['description', 'partial'],
    ]);
    expect(template.alternatives.find(alternative => alternative.kind === 'projection-2d')!.description).toMatch(/3D view/);
    expect(template.alternatives.find(alternative => alternative.id === 'without-webgl')!.description).toMatch(/Tested equivalence/);
    for (const plane of ['plane-xy', 'plane-xz', 'plane-yz']) expect(covering(plane).some(alternative => alternative.equivalence === 'equivalent' && alternative.kind === 'table')).toBe(true);
    for (const parameter of VECTOR_ORIENTATION_PARAMETERS) expect(covering(parameter).map(alternative => alternative.kind).sort()).toEqual(['keyboard', 'numeric-entry']);
    for (const alternative of template.alternatives) expect(alternative.verifiedBy).toMatch(/^tests\/browser\/study-spatial\.spec\.ts#[a-z0-9-]+$/);
    for (const control of template.controls) expect(control).toMatchObject({ displayUnits: ['dimensionless'], slider: true, exact: true });
  });

  it('ships approved scenarios that are admissible and named by their inputs only', () => {
    expect(template.scenarios.length).toBeGreaterThanOrEqual(6);
    for (const scenario of template.scenarios) {
      expect(Object.keys(scenario.parameters).sort(), scenario.id).toEqual([...VECTOR_ORIENTATION_PARAMETERS].sort());
      expect(checkParameters(manifest, scenario.parameters), scenario.id).toEqual([]);
      expect(() => evaluate(scenario.parameters), scenario.id).not.toThrow();
      expect(`${scenario.label} ${scenario.description}`, scenario.id).not.toMatch(/parallel|orthogonal|perpendicular|oblique|acute|obtuse|right angle/i);
    }
    expect(defaultParameters(manifest)).toEqual(template.scenarios.find(scenario => scenario.id === 'pair-d')!.parameters);
  });
});

describe('vector-orientation-3d content boundaries (report §12.6)', () => {
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
      ...template.views.flatMap(view => [view.title, view.description, ...view.marks.flatMap(mark => [mark.label, mark.text ?? ''])]),
      ...template.controls.flatMap(control => [control.label, control.description]),
      ...template.scenarios.flatMap(scenario => [scenario.label, scenario.description]),
      ...template.alternatives.flatMap(alternative => [alternative.label, alternative.description]),
      ...template.content.filter(entry => entry.kind === 'learner-copy').map(entry => entry.text),
    ];
    const claims = /\b(master(ed|y|s)?|understo{1,2}d|understands|learned|knows|correct(ly)?|incorrect|wrong|right answer|reviewed|approved|certified)\b/i;
    expect(learnerText.filter(text => claims.test(text))).toEqual([]);
  });

  it('keeps the kernel free of templates, copy and manifests', () => {
    const source = readFileSync(SOURCES[0]!, 'utf8');
    expect([...source.matchAll(/from\s+'([^']+)'/g)].map(match => match[1])).toEqual(['@experiment-kit/core/model']);
  });

  it('changes the template digest when learner text changes, so approval does not carry over', () => {
    const edited = structuredClone(template) as ActivityTemplate;
    edited.alternatives[1]!.description = 'Three flat views of the vectors.';
    expect(templateDigest(edited)).not.toBe(templateDigest(template));
    expect(groupDigests(edited, manifest).find(entry => entry.groupId === 'alternatives')!.contentDigest)
      .not.toBe(groupDigests(template, manifest).find(entry => entry.groupId === 'alternatives')!.contentDigest);
  });
});
