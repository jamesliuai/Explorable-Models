/**
 * Browser-side helpers shared by the fixed toolkit pages that mount the learner surface (activity-capture.ts and
 * activity-preview-page.ts). Trusted toolkit code: the model worker it creates is the bundle's `worker-model.js`, the
 * only place authored kernel code runs.
 */
import { templateRef, type ActivityCatalog, type ActivityTemplate, type CatalogEntryStatus } from '@explorable-models/activity';
import type { validateManifest } from '@explorable-models/core/model';

/** Catalogue status of an authored package: never approved, never reviewed. */
export const AUTHORED: CatalogEntryStatus = Object.freeze({ lifecycle: 'authored', reviews: [], revoked: false });

/** The bundle's model worker (authored kernel, installed kernels or bounded document execution). */
export const modelWorker = (): Worker => new Worker(new URL('./worker-model.js', location.href), { type: 'module' });

export const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
export const frames = (count: number): Promise<void> => new Promise(resolve => { let left = count; const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick)); requestAnimationFrame(tick); });

/** Catalogue holding exactly one authored template and its model (status `authored`; never approved). */
export function authoredCatalog(template: ActivityTemplate, manifest: ReturnType<typeof validateManifest>): ActivityCatalog {
  const model = { modelId: manifest.manifest.modelId, version: manifest.manifest.version, digest: manifest.identity.digest };
  return {
    listTemplates: () => [{ template: templateRef(template), model, title: template.title, dimension: template.dimension, status: AUTHORED }],
    getTemplate: ref => ref.templateId === template.templateId && ref.version === template.version ? template : null,
    getModel: ref => ref.modelId === model.modelId && ref.version === model.version ? manifest.manifest : null,
    status: () => AUTHORED,
    createWorker: modelWorker,
  };
}
