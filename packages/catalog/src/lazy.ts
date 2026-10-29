/**
 * The on-demand installed catalogue for learner pages (report §5.2, §18 "optional assets … content"; budgets D14).
 *
 * Eager and small: the generated installed index (template and model references, model identities, reference-suite
 * digests, kernel identities and discovery entries) and the host review authority. Statuses, discovery and revocation
 * checks therefore work before any content is fetched. On demand: each template's content — the activity template, its
 * learner copy and its model manifest — is one bundled chunk fetched by `load()` (the adapter calls it in `validate`,
 * `prepare` and `restore`). Loaded content is served only after it reproduces the installed digests exactly and passes
 * the same validation as the eager catalogue (manifest, installed kernel, template schema and semantics); otherwise the
 * entry is withdrawn and reported by `problems()` — nothing else is substituted. Kernel code never enters this realm:
 * it is bundled in the catalogue worker only.
 */
import { groupDigests, templateDiscovery, templateRef, type ActivityTemplate, type CatalogLoadResult, type Diagnostic, type TemplateRef } from '@experiment-kit/activity';
import { canonicalJSON } from '@experiment-kit/core';
import type { ModelManifest, ModelRef } from '@experiment-kit/core/model';
import {
  catalogMarks, key, statusResolver, validateInstalledModel, validateInstalledTemplate,
  type CatalogIdentity, type CatalogProblem, type InstalledCatalogOptions, type LazyInstalledCatalog,
} from './catalog.js';
import { CONTENT_LOADERS } from './content/loaders.js';
import type { InstalledContentModule } from './content/types.js';
import type { IndexedModelEntry, IndexedTemplateEntry } from './index-types.js';
import { INSTALLED_INDEX } from './installed-index.js';

interface Entry {
  readonly indexed: IndexedTemplateEntry;
  readonly model: IndexedModelEntry;
  readonly loader: () => Promise<InstalledContentModule>;
  content: { template: ActivityTemplate; manifest: ModelManifest } | null;
  pending: Promise<CatalogLoadResult> | null;
  withdrawn: boolean;
}

const NOT_LISTED: Diagnostic = { code: 'NOT_FOUND', path: '$.template', message: 'The catalogue does not list this template version.', recovery: 'Choose an installed template version from getCapabilities().' };
const UNREACHABLE: Diagnostic = {
  code: 'NOT_READY', path: '$.template', message: 'The installed content of this template could not be loaded.',
  recovery: 'Check that the catalogue content files are served with the page (same origin, allowed by the content security policy), then retry.',
};
const integrity = (path: string, message: string): Diagnostic => ({ code: 'INTEGRITY_FAILURE', path, message, recovery: 'Reinstall a consistent catalogue build; no other content is substituted.' });

/** Builds the on-demand catalogue. Options are those of `createInstalledCatalog`. */
export function createLazyCatalog(options: InstalledCatalogOptions = {}): LazyInstalledCatalog {
  const index = INSTALLED_INDEX;
  const marks = catalogMarks(options, index.templates.map(entry => entry.ref.templateId));
  const problems: CatalogProblem[] = [];
  const kernels = new Map(index.kernels.map(kernel => [key(kernel.id, kernel.version), kernel]));
  const models = new Map(index.models.map(model => [key(model.ref.modelId, model.ref.version), model]));

  const templates = new Map<string, Entry>();
  for (const indexed of index.templates) {
    const { templateId, version } = indexed.ref;
    if (marks.included && !marks.included.has(templateId)) continue;
    const id = key(templateId, version);
    if (templates.has(id)) throw new RangeError(`Template ${templateId}@${version} is installed twice.`);
    const model = models.get(key(indexed.model.modelId, indexed.model.version));
    const loader = CONTENT_LOADERS[`${templateId}@${version}`];
    if (!model || !loader) {
      problems.push({ kind: 'template', id: templateId, version, diagnostics: [integrity(model ? '$.content' : '$.model', model ? 'The installed index lists content that is not bundled.' : 'The installed index lists a model that is not installed.')] });
      continue;
    }
    templates.set(id, { indexed, model, loader, content: null, pending: null, withdrawn: false });
  }
  const servedModels = new Map([...templates.values()].map(entry => [key(entry.model.ref.modelId, entry.model.ref.version), entry.model]));
  if (!marks.included) for (const [id, model] of models) servedModels.set(id, model);
  const loadedModels = new Map<string, ModelManifest>();

  const live = (ref: { templateId: string; version: string }): Entry | undefined => {
    const entry = templates.get(key(ref.templateId, ref.version));
    return entry && !entry.withdrawn ? entry : undefined;
  };
  const { templateStatus, status } = statusResolver(marks);
  const lookup = {
    template: (templateId: string, version: string) => { const entry = live({ templateId, version }); return entry ? { ref: entry.indexed.ref, model: entry.model } : undefined; },
    model: (modelId: string, version: string) => servedModels.get(key(modelId, version)),
  };

  /** The loaded content must reproduce the installed digests exactly and pass the eager catalogue's validation. */
  function verify(entry: Entry, module: InstalledContentModule | undefined): { template: ActivityTemplate; manifest: ModelManifest } | Diagnostic[] {
    const content = module?.content;
    if (!content || typeof content !== 'object' || !content.template || !content.manifest) return [integrity('$', 'The content module carries no installed template and manifest.')];
    const model = validateInstalledModel(content.manifest, (id, version) => kernels.get(key(id, version)));
    if (!model.ok) return model.diagnostics;
    if (canonicalJSON(model.ref) !== canonicalJSON(entry.model.ref) || canonicalJSON(model.identity) !== canonicalJSON(entry.model.identity))
      return [integrity('$.model', 'The loaded model manifest differs from the installed model digest.')];
    let ref: TemplateRef;
    try { ref = templateRef(content.template); } catch { return [integrity('$.template', 'The loaded template could not be identified.')]; }
    if (canonicalJSON(ref) !== canonicalJSON(entry.indexed.ref)) return [integrity('$.template.digest', 'The loaded template content differs from the installed template digest.')];
    const invalid = validateInstalledTemplate(content.template, model);
    return invalid.length ? invalid : { template: content.template, manifest: model.manifest };
  }
  async function fetchAndVerify(entry: Entry): Promise<CatalogLoadResult> {
    let module: InstalledContentModule;
    // A content chunk that cannot be fetched is not withdrawn: a later load may succeed.
    try { module = await entry.loader(); } catch { return { ok: false, diagnostics: [UNREACHABLE] }; }
    if (entry.content) return { ok: true };
    if (entry.withdrawn) return { ok: false, diagnostics: problems.find(problem => problem.id === entry.indexed.ref.templateId && problem.version === entry.indexed.ref.version)?.diagnostics ?? [NOT_LISTED] };
    const verified = verify(entry, module);
    if (Array.isArray(verified)) {
      entry.withdrawn = true;
      problems.push({ kind: 'template', id: entry.indexed.ref.templateId, version: entry.indexed.ref.version, diagnostics: verified });
      return { ok: false, diagnostics: [...verified] };
    }
    entry.content = verified;
    loadedModels.set(key(entry.model.ref.modelId, entry.model.ref.version), verified.manifest);
    return { ok: true };
  }
  function load(ref: { templateId: string; version: string }): Promise<CatalogLoadResult> {
    const entry = ref && typeof ref.templateId === 'string' && typeof ref.version === 'string' ? live(ref) : undefined;
    if (!entry) return Promise.resolve({ ok: false, diagnostics: [NOT_LISTED] });
    if (entry.content) return Promise.resolve({ ok: true });
    if (!entry.pending) entry.pending = fetchAndVerify(entry).finally(() => { entry.pending = null; });
    return entry.pending;
  }

  return Object.freeze({
    reviewRegistry: marks.reviews,
    listTemplates: () => [...templates.values()].filter(entry => !entry.withdrawn).map(entry => ({
      template: { ...entry.indexed.ref }, model: { ...entry.model.ref }, title: entry.indexed.title, dimension: entry.indexed.dimension, status: templateStatus(entry.indexed.ref, entry.model),
    })),
    getTemplate: (ref: { templateId: string; version: string }) => live(ref)?.content?.template ?? null,
    getModel: (ref: { modelId: string; version: string }) => loadedModels.get(key(ref.modelId, ref.version)) ?? null,
    status: (ref: TemplateRef | ModelRef) => status(ref, lookup),
    createWorker: (): Worker => options.workerFactory ? options.workerFactory() : new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }),
    identity(ref: { templateId: string; version: string } | { modelId: string; version: string }): CatalogIdentity | null {
      if ('templateId' in ref) {
        const entry = live(ref);
        return entry?.content ? { kind: 'template', template: { ...entry.indexed.ref }, model: { ...entry.model.ref }, modelIdentity: { ...entry.model.identity }, groups: groupDigests(entry.content.template, entry.content.manifest) } : null;
      }
      const model = servedModels.get(key(ref.modelId, ref.version));
      return model ? { kind: 'model', model: { ...model.ref }, identity: { ...model.identity } } : null;
    },
    problems: () => problems.map(problem => ({ ...problem, diagnostics: [...problem.diagnostics] })),
    load,
    loaded: (ref: { templateId: string; version: string }) => !!live(ref)?.content,
    loadAll: () => Promise.all([...templates.values()].filter(entry => !entry.withdrawn).map(entry => load(entry.indexed.ref))),
    describe: (ref: { templateId: string; version: string }) => {
      const entry = live(ref);
      if (!entry) return null;
      return entry.content ? templateDiscovery(entry.content.template, entry.content.manifest) : structuredClone(entry.indexed.discovery) as ReturnType<typeof templateDiscovery>;
    },
  });
}
