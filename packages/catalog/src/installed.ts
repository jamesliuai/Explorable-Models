/**
 * The eager installed catalogue (report §5.2, D3, D16): every installed template, its learner copy, its model manifest
 * and the pure kernels are held in memory, validated once at construction. Suited to tooling, tests and hosts that need
 * every template at once; learner pages that open a few templates should use `createLazyCatalog` (./lazy.ts), which
 * loads content per template on demand and keeps kernel code out of the page. Both share status resolution and
 * validation (./catalog.ts) and serve identical references, statuses and discovery entries.
 */
import { groupDigests, templateDiscovery, templateRef, type ActivityTemplate, type CatalogLoadResult, type Diagnostic, type TemplateRef } from '@experiment-kit/activity';
import type { ModelIdentity, ModelKernel, ModelManifest, ModelRef } from '@experiment-kit/core/model';
import {
  catalogMarks, key, statusResolver, validateInstalledModel, validateInstalledTemplate,
  type CatalogIdentity, type CatalogProblem, type IndexedModel, type InstalledCatalog, type InstalledCatalogOptions,
} from './catalog.js';
import { INSTALLED_KERNELS } from './kernels/index.js';
import { INSTALLED_MODELS } from './models/index.js';
import { INSTALLED_TEMPLATES } from './templates/index.js';

interface ServedModel extends IndexedModel { manifest: ModelManifest }
interface ServedTemplate { template: ActivityTemplate; ref: TemplateRef; model: ServedModel }

/**
 * Builds the eager catalogue. Installed entries are validated once here (manifest, template schema and semantics, model
 * reference digest, installed kernel); an entry that fails is not served and is reported by `problems()`. Status
 * resolution order: revoked → deprecated → reviewed → reference-checked → validated, with `authored` for any reference
 * whose exact digest the catalogue does not hold.
 */
export function createInstalledCatalog(options: InstalledCatalogOptions = {}): InstalledCatalog {
  const marks = catalogMarks(options, INSTALLED_TEMPLATES.map(template => template.templateId));
  const problems: CatalogProblem[] = [];

  const kernels = new Map<string, ModelKernel>();
  for (const kernel of INSTALLED_KERNELS) {
    if (kernels.has(key(kernel.id, kernel.version))) throw new RangeError(`Kernel ${kernel.id}@${kernel.version} is installed twice.`);
    kernels.set(key(kernel.id, kernel.version), kernel);
  }
  const models = new Map<string, ServedModel>();
  for (const input of INSTALLED_MODELS) {
    const id = key(input.modelId, input.version);
    if (models.has(id)) throw new RangeError(`Model ${input.modelId}@${input.version} is installed twice.`);
    const validated = validateInstalledModel(input, (kernelId, version) => kernels.get(key(kernelId, version)));
    if (!validated.ok) { problems.push({ kind: 'model', id: input.modelId, version: input.version, diagnostics: validated.diagnostics }); continue; }
    // The installed (deep-frozen) manifest object itself is served, as before the on-demand catalogue existed.
    models.set(id, { manifest: input, identity: validated.identity, ref: validated.ref, referenceSuiteDigest: validated.manifest.referenceSuite?.digest ?? null });
  }

  const included = marks.included;
  const templates = new Map<string, ServedTemplate>();
  for (const template of INSTALLED_TEMPLATES) {
    if (included && !included.has(template.templateId)) continue;
    const id = key(template.templateId, template.version);
    if (templates.has(id)) throw new RangeError(`Template ${template.templateId}@${template.version} is installed twice.`);
    const fail = (diagnostics: Diagnostic[]) => problems.push({ kind: 'template', id: template.templateId, version: template.version, diagnostics });
    const model = models.get(key(template.model.modelId, template.model.version));
    if (!model) { fail([{ code: 'INVALID_REFERENCE', path: '$.model', message: 'The template references a model that is not served.' }]); continue; }
    const invalid = validateInstalledTemplate(template, model);
    if (invalid.length) { fail(invalid); continue; }
    templates.set(id, { template, ref: templateRef(template), model });
  }
  const servedModels = new Map([...templates.values()].map(entry => [key(entry.model.ref.modelId, entry.model.ref.version), entry.model]));
  if (!included) for (const [id, model] of models) servedModels.set(id, model);

  const { templateStatus, status } = statusResolver(marks);
  const lookup = {
    template: (templateId: string, version: string) => templates.get(key(templateId, version)),
    model: (modelId: string, version: string) => servedModels.get(key(modelId, version)),
  };
  const served = (ref: { templateId: string; version: string }) => templates.get(key(ref.templateId, ref.version));

  return Object.freeze({
    reviewRegistry: marks.reviews,
    listTemplates: () => [...templates.values()].map(entry => ({
      template: { ...entry.ref }, model: { ...entry.model.ref }, title: entry.template.title, dimension: entry.template.dimension, status: templateStatus(entry.ref, entry.model),
    })),
    getTemplate: (ref: { templateId: string; version: string }) => served(ref)?.template ?? null,
    getModel: (ref: { modelId: string; version: string }) => servedModels.get(key(ref.modelId, ref.version))?.manifest ?? null,
    status: (ref: TemplateRef | ModelRef) => status(ref, lookup),
    createWorker: (): Worker => options.workerFactory ? options.workerFactory() : new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }),
    kernels: () => [...new Set([...servedModels.values()].flatMap(model => {
      const execution = model.manifest.execution;
      return execution.kind === 'kernel' ? [kernels.get(key(execution.kernelId, execution.kernelVersion))!] : [];
    }))],
    identity(ref: { templateId: string; version: string } | { modelId: string; version: string }): CatalogIdentity | null {
      if ('templateId' in ref) {
        const entry = served(ref);
        return entry ? { kind: 'template', template: { ...entry.ref }, model: { ...entry.model.ref }, modelIdentity: { ...entry.model.identity } as ModelIdentity, groups: groupDigests(entry.template, entry.model.manifest) } : null;
      }
      const model = servedModels.get(key(ref.modelId, ref.version));
      return model ? { kind: 'model', model: { ...model.ref }, identity: { ...model.identity } } : null;
    },
    problems: () => problems.map(problem => ({ ...problem, diagnostics: [...problem.diagnostics] })),
    // Content is already in memory: loading confirms that the version is served.
    load: async (ref: { templateId: string; version: string }): Promise<CatalogLoadResult> => served(ref) ? { ok: true }
      : { ok: false, diagnostics: [{ code: 'NOT_FOUND', path: '$.template', message: 'The catalogue does not serve this template version.' }] },
    describe: (ref: { templateId: string; version: string }) => { const entry = served(ref); return entry ? templateDiscovery(entry.template, entry.model.manifest) : null; },
  });
}
