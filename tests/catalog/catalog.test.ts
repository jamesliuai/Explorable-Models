import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  groupDigests, templateDigest, templateRef, validateRecord, validateTemplateSemantics, type ActivityTemplate, type ReviewRecord,
} from '@experiment-kit/activity';
import { labelWording, modelIdentity, validateManifest, type ModelManifest } from '@experiment-kit/core/model';
import {
  createInstalledCatalog, createReviewRegistry, createRevocationList, functionDerivativeKernel, INSTALLED_KERNELS, INSTALLED_MODELS, INSTALLED_TEMPLATES,
  linearTransformationKernel, quadraticGradientDescentKernel, quadraticGradientDescentManifest as manifest, quadraticGradientDescentTemplate as template,
  quadraticSurfaceGradientKernel, vectorOrientationKernel,
} from '@experiment-kit/catalog';
import type { WorkerReply } from '@experiment-kit/core/model';

const root = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURE = join(root, 'tests/reference/fixtures/activities/quadratic-gradient-descent.json');
const TEMPLATE_REF = templateRef(template);
const MODEL_REF = { modelId: manifest.modelId, version: manifest.version, digest: modelIdentity(manifest).digest };
const SUITE = manifest.referenceSuite!.digest;

/**
 * TEST FIXTURE ONLY. These records exercise review resolution; they are not subject reviews, name no real reviewer
 * and must never be copied into host data.
 */
function testFixtureReview(subject: ReviewRecord['subject'], overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    contract: 'study-harness.review-record', schemaVersion: '1.0',
    reviewId: `test-fixture-${subject.kind}-${Math.random().toString(36).slice(2, 10)}`,
    subject,
    reviewer: { name: 'Automated test fixture (not a reviewer)', role: 'test fixture' },
    date: '2026-10-26',
    scope: 'TEST FIXTURE ONLY: exercises catalogue review resolution. Not a subject review.',
    limitations: ['Not a real review.'],
    referenceSuiteDigest: SUITE,
    outcome: 'approved',
    ...overrides,
  };
}
const modelSubject = (scientificRevision = modelIdentity(manifest).scientificRevision): ReviewRecord['subject'] =>
  ({ kind: 'model', modelId: manifest.modelId, version: manifest.version, scientificRevision });
const templateSubject = (contentDigest = TEMPLATE_REF.digest): ReviewRecord['subject'] =>
  ({ kind: 'template', templateId: template.templateId, version: template.version, contentDigest });
const matching = () => [testFixtureReview(modelSubject()), testFixtureReview(templateSubject())];

describe('installed catalogue (report §5.2, A05)', () => {
  it('lists the installed quadratic template with refs recomputed from content', () => {
    const catalog = createInstalledCatalog();
    expect(catalog.problems()).toEqual([]);
    const listed = catalog.listTemplates();
    expect(listed.map(entry => entry.template.templateId)).toEqual(INSTALLED_TEMPLATES.map(entry => entry.templateId));
    const entry = listed.find(item => item.template.templateId === 'quadratic-gradient-descent')!;
    const installed = catalog.getTemplate(entry.template)!;
    expect(entry.template).toEqual({ templateId: 'quadratic-gradient-descent', version: '1.0.0', digest: templateDigest(installed) });
    expect(entry.model).toEqual({ ...MODEL_REF, digest: modelIdentity(catalog.getModel(entry.model)!).digest });
    expect(installed.model).toEqual(entry.model);
    expect(entry).toMatchObject({ title: template.title, dimension: '2d' });
    expect(Object.isFrozen(installed) && Object.isFrozen(installed.groups[0])).toBe(true);
    expect(catalog.kernels()).toEqual([...INSTALLED_KERNELS]);
    expect(INSTALLED_KERNELS).toContain(quadraticGradientDescentKernel);
    expect(INSTALLED_MODELS).toContain(manifest);
  });

  it('serves all five installed activity packages, each validated against its own model and kernel', () => {
    const catalog = createInstalledCatalog();
    expect(catalog.problems()).toEqual([]);
    const expected: [string, '2d' | '3d', string][] = [
      ['quadratic-gradient-descent', '2d', 'discrete'], ['function-derivative', '2d', 'static'], ['linear-transformation', '2d', 'static'],
      ['vector-orientation-3d', '3d', 'static'], ['quadratic-surface-gradient', '3d', 'static'],
    ];
    const listed = catalog.listTemplates();
    expect(listed.map(entry => [entry.template.templateId, entry.dimension])).toEqual(expected.map(([id, dimension]) => [id, dimension]));
    expect(catalog.kernels()).toEqual([quadraticGradientDescentKernel, functionDerivativeKernel, linearTransformationKernel, vectorOrientationKernel, quadraticSurfaceGradientKernel]);
    for (const [index, entry] of listed.entries()) {
      const installed = catalog.getTemplate(entry.template)!, model = catalog.getModel(entry.model)!;
      expect(installed, entry.template.templateId).toBe(INSTALLED_TEMPLATES[index]);
      expect(model, entry.template.templateId).toBe(INSTALLED_MODELS[index]);
      expect(entry.template.digest).toBe(templateDigest(installed));
      expect(entry.model.digest).toBe(modelIdentity(model).digest);
      expect(installed.model).toEqual(entry.model);
      expect(installed.requires).toEqual(model.capabilities);
      expect(validateRecord('study-harness.activity-template', installed)).toEqual({ ok: true, diagnostics: [] });
      expect(validateTemplateSemantics(installed, model)).toEqual([]);
      const execution = model.execution;
      expect(execution.kind).toBe('kernel');
      if (execution.kind !== 'kernel') continue;
      expect(execution.mode).toBe(expected[index]![2]);
      expect(INSTALLED_KERNELS.find(kernel => kernel.id === execution.kernelId && kernel.version === execution.kernelVersion)?.mode).toBe(execution.mode);
      // Without host review records nothing is higher than reference-checked (D16).
      expect(entry.status).toEqual({ lifecycle: 'reference-checked', reviews: [], revoked: false });
      expect(catalog.status(entry.model)).toEqual({ lifecycle: 'reference-checked', reviews: [], revoked: false });
    }
    // A host that installs one template serves only that template's model and kernel.
    const only = createInstalledCatalog({ include: ['linear-transformation'] });
    expect(only.listTemplates().map(entry => entry.template.templateId)).toEqual(['linear-transformation']);
    expect(only.kernels()).toEqual([linearTransformationKernel]);
    expect(only.getModel({ modelId: manifest.modelId, version: manifest.version })).toBeNull();
  });

  it('runs every installed kernel through the catalogue worker entry', async () => {
    const listeners: ((event: MessageEvent) => void)[] = [];
    const replies: WorkerReply[] = [];
    const scope = { addEventListener: (_type: string, listener: (event: MessageEvent) => void) => listeners.push(listener), postMessage: (message: WorkerReply) => replies.push(message) };
    const global = globalThis as { self?: unknown };
    const previous = global.self;
    global.self = scope;
    try { await import('@experiment-kit/catalog/worker'); } finally { global.self = previous; }
    expect(listeners).toHaveLength(1);
    for (const model of INSTALLED_MODELS) {
      const params = Object.fromEntries(Object.entries(model.parameters).map(([id, definition]) => [id, definition.default]));
      const position = model.execution.kind === 'kernel' && model.execution.mode === 'discrete' ? { kind: 'index', index: 0 } : { kind: 'static' };
      listeners[0]!({ data: { type: 'evaluate', id: `job-${model.modelId}`, request: { manifest: structuredClone(model), params, position } } } as MessageEvent);
    }
    // The worker loads each kernel's code on first use (INSTALLED_KERNEL_SOURCE), so replies arrive asynchronously, in order.
    await vi.waitFor(() => expect(replies).toHaveLength(INSTALLED_MODELS.length));
    expect(replies.map(reply => [reply.id, reply.type])).toEqual(INSTALLED_MODELS.map(model => [`job-${model.modelId}`, 'result']));
    for (const [index, reply] of replies.entries()) if (reply.type === 'result')
      expect(Object.keys(reply.data.quantities).sort(), INSTALLED_MODELS[index]!.modelId).toEqual(Object.keys(INSTALLED_MODELS[index]!.quantities).sort());
  });

  it('serves a template that passes schema and semantic validation against its manifest', () => {
    expect(validateRecord('study-harness.activity-template', template)).toEqual({ ok: true, diagnostics: [] });
    expect(validateTemplateSemantics(template, manifest)).toEqual([]);
    const { manifest: validated, identity } = validateManifest(manifest);
    expect(validated).toEqual(manifest);
    expect(identity.digest).toBe(MODEL_REF.digest);
    expect(template.requires).toEqual(manifest.capabilities);
  });

  it('exposes the content identity of each group', () => {
    const catalog = createInstalledCatalog();
    const identity = catalog.identity({ templateId: template.templateId, version: template.version });
    expect(identity).toEqual({ kind: 'template', template: TEMPLATE_REF, model: MODEL_REF, modelIdentity: modelIdentity(manifest), groups: groupDigests(template, manifest) });
    expect(catalog.identity({ modelId: manifest.modelId, version: manifest.version })).toEqual({ kind: 'model', model: MODEL_REF, identity: modelIdentity(manifest) });
    expect(catalog.identity({ templateId: template.templateId, version: '9.9.9' })).toBeNull();
  });

  it('returns null or an unvouched status for anything not installed exactly', () => {
    const catalog = createInstalledCatalog();
    expect(catalog.getTemplate({ templateId: 'unknown', version: '1.0.0' })).toBeNull();
    expect(catalog.getTemplate({ templateId: template.templateId, version: '1.0.1' })).toBeNull();
    expect(catalog.getModel({ modelId: manifest.modelId, version: '2.0.0' })).toBeNull();
    expect(catalog.status({ ...TEMPLATE_REF, digest: `sha256:${'0'.repeat(64)}` })).toEqual({ lifecycle: 'authored', reviews: [], revoked: false });
    expect(catalog.status({ ...MODEL_REF, version: '2.0.0' })).toEqual({ lifecycle: 'authored', reviews: [], revoked: false });
    expect(() => createInstalledCatalog({ include: ['not-installed'] })).toThrow(RangeError);
    expect(createInstalledCatalog({ include: ['quadratic-gradient-descent'] }).listTemplates()).toHaveLength(1);
  });

  it('creates workers through the host factory when one is supplied', () => {
    const worker = { terminate() {} } as unknown as Worker;
    expect(createInstalledCatalog({ workerFactory: () => worker }).createWorker()).toBe(worker);
  });

  it('pins the reference-suite digest to the exact fixture bytes', () => {
    const bytes = readFileSync(FIXTURE);
    expect(SUITE).toBe(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
    expect(JSON.parse(bytes.toString('utf8')).suiteId).toBe(manifest.referenceSuite!.suiteId);
  });
});

describe('lifecycle and review authority (D16, A07, A08)', () => {
  it('is reference-checked, not reviewed, without host review records', () => {
    const catalog = createInstalledCatalog();
    expect(catalog.status(TEMPLATE_REF)).toEqual({ lifecycle: 'reference-checked', reviews: [], revoked: false });
    expect(catalog.status(MODEL_REF)).toEqual({ lifecycle: 'reference-checked', reviews: [], revoked: false });
    expect(catalog.listTemplates()[0]!.status.lifecycle).toBe('reference-checked');
  });

  it('becomes reviewed only with matching host-supplied records for the exact model and template', () => {
    const records = matching();
    const catalog = createInstalledCatalog({ reviews: records });
    expect(catalog.status(MODEL_REF)).toEqual({ lifecycle: 'reviewed', reviews: [records[0]], revoked: false });
    expect(catalog.status(TEMPLATE_REF)).toEqual({ lifecycle: 'reviewed', reviews: [records[1]], revoked: false });
    // A template review alone does not make the activity reviewed while its model is unreviewed.
    expect(createInstalledCatalog({ reviews: [records[1]!] }).status(TEMPLATE_REF).lifecycle).toBe('reference-checked');
    expect(createInstalledCatalog({ reviews: [records[0]!] }).status(TEMPLATE_REF).lifecycle).toBe('reference-checked');
  });

  it('never yields reviewed from forged, stale, rejected or malformed records', () => {
    const changedModel = structuredClone(manifest) as ModelManifest;
    changedModel.quantities.loss!.meaning = 'Objective value a·x_n² at the current position.';
    const changedTemplate = structuredClone(template) as ActivityTemplate;
    changedTemplate.stages[0]!.instruction = 'Predict the positions.';
    // R38: curvature and step size trade labels, symbols and descriptions; the numbers are unchanged.
    const swappedMeanings = structuredClone(manifest) as ModelManifest;
    const curvature = swappedMeanings.parameters.a as unknown as Record<string, unknown>, step = swappedMeanings.parameters.eta as unknown as Record<string, unknown>;
    for (const key of ['label', 'symbol', 'description']) { const held = curvature[key]; if (step[key] === undefined) delete curvature[key]; else curvature[key] = step[key]; if (held === undefined) delete step[key]; else step[key] = held; }
    const forged: Record<string, ReviewRecord[]> = {
      'wrong scientificRevision': [testFixtureReview(modelSubject(modelIdentity(changedModel).scientificRevision)), testFixtureReview(templateSubject())],
      'review of the manifest with swapped parameter meanings': [testFixtureReview(modelSubject(modelIdentity(swappedMeanings).scientificRevision)), testFixtureReview(templateSubject())],
      'wrong contentDigest': [testFixtureReview(modelSubject()), testFixtureReview(templateSubject(templateDigest(changedTemplate)))],
      'stale reference suite': matching().map(record => ({ ...record, referenceSuiteDigest: `sha256:${'1'.repeat(64)}` })),
      'rejected outcome': matching().map(record => ({ ...record, outcome: 'rejected' as const })),
      'approval contradicted by a rejection': [...matching(), testFixtureReview(modelSubject(), { outcome: 'rejected' })],
      'wrong model version': [testFixtureReview({ ...modelSubject(), version: '1.0.1' } as ReviewRecord['subject']), testFixtureReview(templateSubject())],
      'extra field': matching().map(record => ({ ...record, approvedBy: 'agent' }) as unknown as ReviewRecord),
      'missing reviewer': matching().map(({ reviewer: _reviewer, ...record }) => record as unknown as ReviewRecord),
      'malformed digest': matching().map(record => ({ ...record, referenceSuiteDigest: SUITE.toUpperCase() })),
      'unknown outcome': matching().map(record => ({ ...record, outcome: 'reviewed' }) as unknown as ReviewRecord),
      'self-asserted subject kind': matching().map(record => ({ ...record, subject: { ...record.subject, kind: 'activity' } }) as unknown as ReviewRecord),
    };
    for (const [name, records] of Object.entries(forged)) {
      const catalog = createInstalledCatalog({ reviews: records });
      expect(catalog.status(TEMPLATE_REF).lifecycle, name).not.toBe('reviewed');
      expect(catalog.status(TEMPLATE_REF).reviews, name).toEqual([]);
      expect(catalog.listTemplates()[0]!.status.lifecycle, name).not.toBe('reviewed');
    }
    // The model review itself is bound to what the parameters mean, not only to their numbers (report §8.3, §5.2).
    expect(modelIdentity(swappedMeanings).scientificRevision).not.toBe(modelIdentity(manifest).scientificRevision);
    expect(createInstalledCatalog({ reviews: forged['review of the manifest with swapped parameter meanings']! }).status(MODEL_REF).lifecycle).toBe('reference-checked');
    expect(createReviewRegistry(forged['extra field']!).ignored).toHaveLength(2);
    expect(createReviewRegistry(forged['missing reviewer']!).records).toEqual([]);
  });

  // Report §8.3 and §5.2 (R38): a model review covers what the learner reads each input and output as. Label wording is
  // part of the reviewed scientific revision; only a respelling that keeps the wording leaves the review in force.
  it('keeps a model review through a label respelling but not through a swapped or reworded label, for every installed model', () => {
    const relabel = (source: ModelManifest, edit: (copy: ModelManifest) => void): string => {
      const copy = structuredClone(source) as ModelManifest;
      edit(copy);
      return modelIdentity(copy).scientificRevision;
    };
    for (const model of INSTALLED_MODELS) {
      const original = modelIdentity(model);
      const subject = (scientificRevision: string): ReviewRecord['subject'] => ({ kind: 'model', modelId: model.modelId, version: model.version, scientificRevision });
      const suite = model.referenceSuite?.digest ?? SUITE;
      const registry = createReviewRegistry([testFixtureReview(subject(original.scientificRevision), { referenceSuiteDigest: suite })]);
      const reviewed = (scientificRevision: string) => registry.resolve(subject(scientificRevision), suite).approved;
      expect(reviewed(original.scientificRevision), model.modelId).toBe(true);
      // Respelled everywhere: no-break spaces, padded ends and curly apostrophes. The wording, and so the review, are unchanged.
      const respell = (label: string) => ` ${label.replaceAll(' ', '\u00a0').replaceAll("'", '\u2019')} `;
      const respelled = structuredClone(model) as ModelManifest;
      respelled.title = respell(respelled.title);
      for (const entry of [...Object.values(respelled.parameters), ...Object.values(respelled.quantities), ...Object.values(respelled.geometry)]) entry.label = respell(entry.label);
      expect(modelIdentity(respelled).scientificRevision, model.modelId).toBe(original.scientificRevision);
      expect(modelIdentity(respelled).presentationRevision, model.modelId).not.toBe(original.presentationRevision);
      expect(reviewed(modelIdentity(respelled).scientificRevision), model.modelId).toBe(true);
      // Two readout names or two parameter names trade places: the numbers are unchanged, the review no longer applies.
      for (const kind of ['parameters', 'quantities', 'geometry'] as const) {
        const ids = Object.keys(model[kind]);
        for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
          const [a, b] = [ids[i]!, ids[j]!];
          if (labelWording(model[kind][a]!.label) === labelWording(model[kind][b]!.label)) continue;
          const swapped = relabel(model, copy => { const x = copy[kind][a]!, y = copy[kind][b]!; [x.label, y.label] = [y.label, x.label]; });
          expect(reviewed(swapped), `${model.modelId} ${kind} ${a} ↔ ${b}`).toBe(false);
        }
      }
      expect(reviewed(relabel(model, copy => { copy.title = `${copy.title} (revised)`; })), model.modelId).toBe(false);
    }
    // The case the review found: the surface's readouts "Height at the point" and "Length of the gradient" swapped.
    const surface = INSTALLED_MODELS.find(model => model.modelId === 'quadratic-surface-gradient')!;
    const swappedReadouts = relabel(surface, copy => { const value = copy.quantities.value!, norm = copy.quantities['gradient.norm']!; [value.label, norm.label] = [norm.label, value.label]; });
    expect(swappedReadouts).not.toBe(modelIdentity(surface).scientificRevision);
    const surfaceRegistry = createReviewRegistry([testFixtureReview({ kind: 'model', modelId: surface.modelId, version: surface.version, scientificRevision: modelIdentity(surface).scientificRevision }, { referenceSuiteDigest: surface.referenceSuite!.digest })]);
    expect(surfaceRegistry.resolve({ kind: 'model', modelId: surface.modelId, version: surface.version, scientificRevision: swappedReadouts }, surface.referenceSuite!.digest).approved).toBe(false);
  });

  it('ignores review claims embedded in template data and refuses changed content under the same identity', () => {
    const claimed = structuredClone(template) as ActivityTemplate & { review?: unknown };
    claimed.review = { status: 'reviewed', reviewer: 'Agent' };
    claimed.content = [...claimed.content, { id: 'review-claim', kind: 'source', text: 'Reviewed and approved for Study Harness use.' }];
    const records = [...matching(), testFixtureReview(templateSubject(templateDigest(claimed)))];
    const catalog = createInstalledCatalog({ reviews: records });
    expect(validateRecord('study-harness.activity-template', claimed).ok).toBe(false);
    expect(catalog.status(templateRef(claimed))).toEqual({ lifecycle: 'authored', reviews: [], revoked: false });
    // The installed template keeps its identity and its own review; the edited copy never replaces it.
    expect(catalog.getTemplate(TEMPLATE_REF)).toBe(INSTALLED_TEMPLATES[0]);
    expect(templateDigest(catalog.getTemplate(TEMPLATE_REF)!)).toBe(TEMPLATE_REF.digest);
    expect(catalog.status(TEMPLATE_REF).lifecycle).toBe('reviewed');
    // An exploratory edit of learner text changes the digest, so approval does not carry over (A08).
    const edited = structuredClone(template) as ActivityTemplate;
    edited.equations[1]!.plain = 'x_(n+1) = x_n − η·a·x_n';
    expect(templateRef(edited).digest).not.toBe(TEMPLATE_REF.digest);
    expect(catalog.status(templateRef(edited)).lifecycle).toBe('authored');
  });

  it('isolates the registry from later mutation of host input', () => {
    const records = matching();
    const catalog = createInstalledCatalog({ reviews: records });
    (records[1]!.subject as { contentDigest: string }).contentDigest = `sha256:${'2'.repeat(64)}`;
    expect(catalog.status(TEMPLATE_REF).lifecycle).toBe('reviewed');
    expect(Object.isFrozen(catalog.reviewRegistry.records[0])).toBe(true);
  });

  it('ignores both records when one review ID carries different content', () => {
    const [model] = matching();
    const registry = createReviewRegistry([model!, { ...model!, scope: 'Different scope text for the same review ID.' }]);
    expect(registry.records).toEqual([]);
    expect(registry.ignored[0]!.diagnostics[0]!.code).toBe('CONFLICT');
  });

  it('revokes by exact ID and version, overriding reviews and covering modified copies and dependent templates', () => {
    const reason = 'Withdrawn for a test.';
    const revoked = createInstalledCatalog({ reviews: matching(), revocations: [{ kind: 'template', id: template.templateId, version: template.version, reason }] });
    expect(revoked.status(TEMPLATE_REF)).toEqual({ lifecycle: 'revoked', reviews: [], revoked: true, revocationReason: reason });
    expect(revoked.listTemplates()[0]!.status.revoked).toBe(true);
    const edited = structuredClone(template) as ActivityTemplate;
    edited.title = 'Renamed copy';
    expect(revoked.status(templateRef(edited)).revoked).toBe(true);
    expect(revoked.status(MODEL_REF).lifecycle).toBe('reviewed');

    const modelRevoked = createInstalledCatalog({ revocations: [{ kind: 'model', id: manifest.modelId, version: manifest.version, reason }] });
    expect(modelRevoked.status(MODEL_REF)).toMatchObject({ lifecycle: 'revoked', revoked: true });
    expect(modelRevoked.status(TEMPLATE_REF)).toMatchObject({ lifecycle: 'revoked', revoked: true, revocationReason: expect.stringContaining(reason) });
    expect(createRevocationList([{ kind: 'model', id: manifest.modelId, version: manifest.version, reason }]).lookup('model', manifest.modelId, '1.0.1')).toBeNull();
  });

  it('rejects malformed revocations instead of dropping them', () => {
    expect(() => createRevocationList([{ kind: 'template', id: template.templateId, version: 'latest', reason: 'x' }])).toThrow(RangeError);
    expect(() => createInstalledCatalog({ revocations: [{ kind: 'activity', id: 'x', version: '1.0.0', reason: 'x' } as never] })).toThrow(RangeError);
  });

  it('marks host-deprecated entries without revoking them', () => {
    const catalog = createInstalledCatalog({ deprecations: [{ kind: 'model', id: manifest.modelId, version: manifest.version, reason: 'Superseded.' }] });
    expect(catalog.status(MODEL_REF)).toEqual({ lifecycle: 'deprecated', reviews: [], revoked: false });
    expect(catalog.status(TEMPLATE_REF)).toEqual({ lifecycle: 'deprecated', reviews: [], revoked: false });
  });
});

describe('catalogue content boundaries (report §12.6)', () => {
  const FORBIDDEN_KEY = /^(answers?|answer[-_]?key|rubrics?|solutions?|correct([-_]?answer)?|expected[-_]?(response|answer)|held[-_]?out|scor(e|ing)|grade|mark[-_]?scheme|review(ed|er)?|approv(ed|al))$/i;
  const keys = (value: unknown, path = '$'): string[] => !value || typeof value !== 'object' ? []
    : Object.entries(value).flatMap(([key, item]) => [...(Array.isArray(value) ? [] : [`${path}.${key}`]), ...keys(item, `${path}.${key}`)]);

  it('carries no answer keys, rubrics, solutions or review claims in installed data', () => {
    for (const data of [...INSTALLED_TEMPLATES, ...INSTALLED_MODELS]) {
      const offending = keys(data).filter(path => FORBIDDEN_KEY.test(path.slice(path.lastIndexOf('.') + 1)));
      expect(offending).toEqual([]);
    }
    for (const entry of INSTALLED_TEMPLATES) for (const family of entry.taskFamilies) {
      expect(Object.keys(family).sort()).toEqual(['description', 'hostOwned', 'id']);
      expect(family.hostOwned).toBe(true);
    }
    for (const entry of INSTALLED_TEMPLATES) for (const stage of entry.stages)
      if (stage.response) expect(Object.keys(stage.response).sort(), `${entry.templateId}/${stage.id}`).toEqual(['kind', 'prompt', 'taskFamily']);
  });

  it('uses neutral learner copy without mastery, grading or review claims in every installed template', () => {
    const claims = /\b(master(ed|y|s)?|understo{1,2}d|understands|learned|knows|correct(ly)?|incorrect|wrong|right answer|reviewed|approved|certified)\b/i;
    for (const entry of INSTALLED_TEMPLATES) {
      const learnerText = [
        entry.title, entry.purpose,
        ...entry.stages.flatMap(stage => [stage.instruction, stage.response?.prompt ?? '']),
        ...entry.groups.flatMap(group => [group.label, group.description]),
        ...entry.views.flatMap(view => [view.title, view.description, ...view.marks.flatMap(mark => [mark.label, mark.text ?? ''])]),
        ...entry.controls.flatMap(control => [control.label, control.description]),
        ...entry.scenarios.flatMap(scenario => [scenario.label, scenario.description]),
        ...entry.alternatives.flatMap(alternative => [alternative.label, alternative.description]),
        ...entry.content.filter(item => item.kind === 'learner-copy').map(item => item.text),
      ];
      expect(learnerText.filter(text => claims.test(text)), entry.templateId).toEqual([]);
    }
  });

  it('shows no solution-bearing group in any initial stage and substitutes values only in solution-bearing groups', () => {
    for (const entry of INSTALLED_TEMPLATES) {
      const solution = new Set(entry.groups.filter(group => group.solutionBearing).map(group => group.id));
      expect(solution.size, entry.templateId).toBeGreaterThan(0);
      const initial = entry.stages.find(stage => stage.id === entry.initialStage)!;
      expect(Object.keys(initial.visible).filter(id => solution.has(id)), entry.templateId).toEqual([]);
      for (const equation of entry.equations) if (/\{\{q:/.test(equation.tex)) expect(solution.has(equation.group), `${entry.templateId}/${equation.id}`).toBe(true);
      expect(entry.stages.find(stage => stage.id === 'closed'), entry.templateId).toMatchObject({ visible: {}, controls: {} });
    }
  });

  it('has no answer, rubric or solution fields anywhere in catalogue source', () => {
    const directory = join(root, 'packages/catalog/src');
    const files = (dir: string): string[] => readdirSync(dir).flatMap(name => statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : [join(dir, name)]);
    const field = /["']?\b(answers?|answerKey|rubrics?|solutions?|correctAnswer|expectedResponse|heldOut|scoring)\b["']?\s*:/i;
    const offending = files(directory).filter(file => field.test(readFileSync(file, 'utf8')));
    expect(offending).toEqual([]);
  });

  it('keeps solution-bearing quantities and substituted equations out of groups shown before exposure', () => {
    const solutionGroups = new Set(template.groups.filter(group => group.solutionBearing).map(group => group.id));
    expect([...solutionGroups].sort()).toEqual(['observations', 'regime', 'substituted-rule', 'trace']);
    const predict = template.stages.find(stage => stage.id === 'predict')!;
    expect(Object.keys(predict.visible).filter(id => solutionGroups.has(id))).toEqual([]);
    expect(predict.allowsNavigation || predict.allowsPreview || predict.allowsPlayback).toBe(false);
    for (const equation of template.equations) if (/\{\{q:/.test(equation.tex)) expect(solutionGroups.has(equation.group), equation.id).toBe(true);
    expect(template.stages.find(stage => stage.id === 'closed')).toMatchObject({ visible: {}, controls: {} });
  });

  it('keeps the kernel worker free of templates, copy and manifests', () => {
    const read = (path: string) => readFileSync(join(root, 'packages/catalog/src', path), 'utf8');
    const imports = (source: string) => [...source.matchAll(/from\s+'([^']+)'/g)].map(match => match[1]);
    expect(imports(read('worker.ts'))).toEqual(['@experiment-kit/core/model', './kernels/loaders.js']);
    for (const file of readdirSync(join(root, 'packages/catalog/src/kernels')))
      for (const target of imports(read(`kernels/${file}`))) expect(target, file).toMatch(/^(@experiment-kit\/core\/model|\.\/[a-z0-9-]+\.js)$/);
  });
});
