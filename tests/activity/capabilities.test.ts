/**
 * Versioned capability records and their limits (report §13, §5.1, A05, A47; G52). spatial-3d@1.0 carries the bounded
 * renderer's limits as contract data: a 3D template's declared worst-case geometry is validated against them at the
 * limit and one past it; a required capability or version that this runtime does not install is rejected; and
 * discovery (`getCapabilities`) reports the records, each template's required capabilities and the spatial limits.
 */
import { describe, expect, it } from 'vitest';
import {
  capabilityDiagnostics, capabilityRecord, DISCRETE_ITERATION_CAPABILITY, INSTALLED_CAPABILITIES, SPATIAL_3D_CAPABILITY, SPATIAL_3D_LIMITS, spatialViewWork,
  validateRecord, validateTemplateSemantics, type ActivityTemplate, type MarkSpec,
} from '@explorable-models/activity';
import { modelIdentity, type ModelManifest } from '@explorable-models/core/model';
import { quadraticSurfaceGradientManifest, quadraticSurfaceGradientTemplate, vectorOrientationManifest, vectorOrientationTemplate } from '@explorable-models/catalog';
import { harness, op, requestFor } from './support/adapter-harness';

/** A template/manifest pair with an edited manifest whose template references it exactly (so only the edit is judged). */
function variant(template: ActivityTemplate, manifest: ModelManifest, edit: (draft: { template: ActivityTemplate; manifest: ModelManifest }) => void) {
  const draft = { template: structuredClone(template) as ActivityTemplate, manifest: structuredClone(manifest) as ModelManifest };
  draft.manifest.limits.maxGeometryElements = 100_000;
  edit(draft);
  draft.template.model = { ...draft.template.model, digest: modelIdentity(draft.manifest).digest };
  return draft;
}
const limitCodes = ({ template, manifest }: { template: ActivityTemplate; manifest: ModelManifest }) =>
  validateTemplateSemantics(template, manifest).filter(item => item.code === 'RESOURCE_LIMIT').map(item => `${item.path} ${item.message}`);
const sceneOf = (template: ActivityTemplate) => template.views.find(view => view.kind === 'scene3d')!;

describe('installed capability records (contract study-harness.capability-record 1.0)', () => {
  it('are valid records whose limits are the enforced maxima', () => {
    for (const record of INSTALLED_CAPABILITIES) expect(validateRecord('study-harness.capability-record', record)).toEqual({ ok: true, diagnostics: [] });
    expect(SPATIAL_3D_CAPABILITY.limits).toEqual(SPATIAL_3D_LIMITS);
    expect(SPATIAL_3D_CAPABILITY.limits).toEqual({ vertices: 20_000, indices: 120_000, fieldSamples: 1_000, labels: 32, textureSize: 1024, drawCallsPerFrame: 128 });
    expect(DISCRETE_ITERATION_CAPABILITY.limits.maxIndex).toBe(10_000_000);
  });
  it('are found only by exact ID and version', () => {
    expect(capabilityRecord({ id: 'spatial-3d', version: '1.0' })).toBe(SPATIAL_3D_CAPABILITY);
    expect(capabilityRecord({ id: 'spatial-3d', version: '1.1' })).toBeNull();
    expect(capabilityRecord({ id: 'spatial-3d', version: '1' })).toBeNull();
    expect(capabilityRecord({ id: 'spatial-4d', version: '1.0' })).toBeNull();
  });
});

describe('template requirements (unknown capability or version)', () => {
  it('rejects a required capability this runtime does not install', () => {
    const { template, manifest } = variant(vectorOrientationTemplate, vectorOrientationManifest, draft => { draft.template.requires = [...draft.template.requires, { id: 'holographic-display', version: '1.0' }]; });
    expect(validateTemplateSemantics(template, manifest)).toEqual([expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY', path: '$.requires[1].id' })]);
  });
  it('rejects an installed capability at a version this runtime does not install, without substituting another version', () => {
    const { template, manifest } = variant(vectorOrientationTemplate, vectorOrientationManifest, draft => {
      draft.template.requires = [{ id: 'spatial-3d', version: '1.1' }];
      draft.manifest.capabilities = [{ id: 'spatial-3d', version: '1.1' }];
    });
    const codes = validateTemplateSemantics(template, manifest).map(item => `${item.code} ${item.path}`);
    expect(codes).toContain('UNSUPPORTED_CAPABILITY $.requires[0].version');
    expect(codes).toContain('UNSUPPORTED_CAPABILITY $.requires');
  });
  it('requires spatial-3d@1.0 for a scene3d view, and every activity capability the model declares', () => {
    const missing = variant(vectorOrientationTemplate, vectorOrientationManifest, draft => { draft.template.requires = []; });
    expect(validateTemplateSemantics(missing.template, missing.manifest).map(item => `${item.code} ${item.path}`)).toEqual(['UNSUPPORTED_CAPABILITY $.requires', 'UNSUPPORTED_CAPABILITY $.requires']);
    const duplicate = variant(vectorOrientationTemplate, vectorOrientationManifest, draft => { draft.template.requires = [{ id: 'spatial-3d', version: '1.0' }, { id: 'spatial-3d', version: '1.0' }]; });
    expect(validateTemplateSemantics(duplicate.template, duplicate.manifest).map(item => `${item.code} ${item.path}`)).toEqual(['DUPLICATE_ID $.requires[1].id']);
  });
  it('accepts every installed template as installed', () => {
    expect(capabilityDiagnostics(vectorOrientationTemplate, vectorOrientationManifest)).toEqual([]);
    expect(capabilityDiagnostics(quadraticSurfaceGradientTemplate, quadraticSurfaceGradientManifest)).toEqual([]);
  });
  it('makes the adapter refuse a template that requires an unknown capability', async () => {
    const { template, manifest } = variant(vectorOrientationTemplate, vectorOrientationManifest, draft => { draft.template.requires = [{ id: 'spatial-3d', version: '2.0' }]; draft.manifest.capabilities = []; });
    const h = harness({
      customCatalog: createWorker => ({
        listTemplates: () => [], getTemplate: ref => ref.templateId === template.templateId ? template : null, getModel: ref => ref.modelId === manifest.modelId ? manifest : null,
        status: () => ({ lifecycle: 'validated', reviews: [], revoked: false }), createWorker,
      }),
    });
    const result = await h.adapter.prepare(requestFor({ activityId: 'act-capability', template: { templateId: template.templateId, version: template.version } }), { operationId: op('prepare') });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.diagnostics.map(item => `${item.code} ${item.path}`)).toEqual(['UNSUPPORTED_CAPABILITY $.requires[0].version', 'UNSUPPORTED_CAPABILITY $.requires']);
    h.adapter.dispose();
  });
});

describe('spatial-3d@1.0 geometry limits of a scene3d view (limit and limit + 1)', () => {
  it('vertices', () => {
    const base = spatialViewWork(sceneOf(vectorOrientationTemplate), vectorOrientationManifest).vertices;
    const at = (extra: number) => variant(vectorOrientationTemplate, vectorOrientationManifest, draft => { draft.manifest.geometry['angle-arc']!.maxElements += extra; });
    expect(spatialViewWork(sceneOf(at(SPATIAL_3D_LIMITS.vertices - base).template), at(SPATIAL_3D_LIMITS.vertices - base).manifest).vertices).toBe(SPATIAL_3D_LIMITS.vertices);
    expect(limitCodes(at(SPATIAL_3D_LIMITS.vertices - base))).toEqual([]);
    expect(limitCodes(at(SPATIAL_3D_LIMITS.vertices - base + 1))).toEqual([expect.stringMatching(/^\$\.views\[0\] The view declares up to 20001 vertices/)]);
  });
  it('surface indices (fewer than ten per surface sample)', () => {
    const surface = (samples: number) => variant(quadraticSurfaceGradientTemplate, quadraticSurfaceGradientManifest, draft => { draft.manifest.geometry.surface!.maxElements = samples; });
    expect(limitCodes(surface(SPATIAL_3D_LIMITS.indices / 10))).toEqual([]);
    expect(limitCodes(surface(SPATIAL_3D_LIMITS.indices / 10 + 1))).toEqual([expect.stringMatching(/declares up to 120010 surface indices/)]);
  });
  it('vector-field samples', () => {
    const scene = sceneOf(quadraticSurfaceGradientTemplate);
    const field: MarkSpec = { id: 'field-3d-test', kind: 'vector-field', group: scene.group, label: 'Test field', bindings: { geometry: 'field' }, style: { role: 'secondary', dash: 'solid', marker: 'none', weight: 'thin' } };
    const withField = (samples: number) => variant(quadraticSurfaceGradientTemplate, quadraticSurfaceGradientManifest, draft => {
      sceneOf(draft.template).marks.push(field);
      draft.manifest.geometry.field = { ...draft.manifest.geometry.field!, kind: 'vector-field3', maxElements: samples };
    });
    expect(limitCodes(withField(SPATIAL_3D_LIMITS.fieldSamples))).toEqual([]);
    expect(limitCodes(withField(SPATIAL_3D_LIMITS.fieldSamples + 1))).toEqual([expect.stringMatching(/declares up to 1001 vector-field samples/)]);
  });
  it('labels (axis names and mark text)', () => {
    const scene = sceneOf(vectorOrientationTemplate);
    const base = spatialViewWork(scene, vectorOrientationManifest).labels;
    const labelled = (count: number) => variant(vectorOrientationTemplate, vectorOrientationManifest, draft => {
      const marks = sceneOf(draft.template).marks;
      for (let i = 0; i < count; i++) marks.push({ ...marks[0]!, id: `labelled-${i}`, text: `L${i}` });
    });
    expect(limitCodes(labelled(SPATIAL_3D_LIMITS.labels - base))).toEqual([]);
    expect(limitCodes(labelled(SPATIAL_3D_LIMITS.labels - base + 1))).toEqual([expect.stringMatching(/declares up to 33 labels/)]);
  });
});

describe('discovery reports the capability records and limits (A05)', () => {
  it('lists every installed capability with its limits, and each template’s exact requirements', () => {
    const h = harness();
    const report = h.adapter.getCapabilities();
    expect(report.capabilities).toEqual(INSTALLED_CAPABILITIES.map(record => structuredClone(record)));
    expect(report.capabilities.find(record => record.id === 'spatial-3d')!.limits).toEqual(SPATIAL_3D_LIMITS);
    const requires = Object.fromEntries(report.templates.map(entry => [entry.template.templateId, entry.requires]));
    expect(requires['vector-orientation-3d']).toEqual([{ id: 'spatial-3d', version: '1.0' }]);
    expect(requires['quadratic-surface-gradient']).toEqual([{ id: 'spatial-3d', version: '1.0' }]);
    expect(requires['quadratic-gradient-descent']).toEqual([{ id: 'discrete-iteration', version: '1.0' }]);
    for (const entry of report.templates) for (const ref of entry.requires) expect(report.capabilities.some(record => record.id === ref.id && record.version === ref.version)).toBe(true);
    h.adapter.dispose();
  });
});
