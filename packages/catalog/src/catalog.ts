/**
 * Shared catalogue logic for the eager (`createInstalledCatalog`) and the on-demand (`createLazyCatalog`) factories
 * (report §5.2, D3, D16): the public types, the validation of one installed template/model pair, and lifecycle status
 * resolution from host-supplied review records, revocations and deprecations only. Review claims embedded in any
 * imported data are ignored. This module imports no installed content and no kernel code.
 */
import {
  validateRecord, validateTemplateSemantics,
  type ActivityCatalog, type ActivityTemplate, type CatalogEntryStatus, type CatalogLoadResult, type Diagnostic, type GroupDigest, type ReviewRecord,
  type TemplateDiscovery, type TemplateRef,
} from '@explorable-models/activity';
import { validateManifest, type ModelIdentity, type ModelKernel, type ModelManifest, type ModelRef } from '@explorable-models/core/model';
import { createMarkList, createReviewRegistry, type DeprecationEntry, type MarkList, type ReviewRegistry, type RevocationEntry } from './registry.js';

export interface InstalledCatalogOptions {
  /** Host-trusted review records. Validated; malformed or conflicting records are ignored and never approve. */
  reviews?: readonly ReviewRecord[];
  /** Host revocations by exact ID and version (every digest, including modified copies). */
  revocations?: readonly RevocationEntry[];
  /** Host deprecations by exact ID and version. */
  deprecations?: readonly DeprecationEntry[];
  /** Kernel worker factory; hosts may override it for bundler compatibility. */
  workerFactory?: () => Worker;
  /** Template IDs to install; every installed template when omitted. Unknown IDs are a configuration error. */
  include?: readonly string[];
}

export type CatalogIdentity =
  | { kind: 'template'; template: TemplateRef; model: ModelRef; modelIdentity: ModelIdentity; groups: GroupDigest[] }
  | { kind: 'model'; model: ModelRef; identity: ModelIdentity };

/** An installed entry that failed mechanical validation (or its installed-digest check) and is therefore not served. */
export interface CatalogProblem { kind: 'template' | 'model'; id: string; version: string; diagnostics: Diagnostic[] }

/** Members shared by both catalogue factories. */
interface CatalogBase extends ActivityCatalog {
  identity(ref: { templateId: string; version: string } | { modelId: string; version: string }): CatalogIdentity | null;
  /** Installed entries excluded because they failed validation; empty for a healthy catalogue. */
  problems(): CatalogProblem[];
  readonly reviewRegistry: ReviewRegistry;
  /** Loads (and verifies) one listed template version's content; resolves at once when it is already in memory. */
  load(ref: { templateId: string; version: string }): Promise<CatalogLoadResult>;
  /** Discovery entry of a listed template (from loaded content, or from the verified installed index); null when not listed. */
  describe(ref: { templateId: string; version: string }): TemplateDiscovery | null;
}

/** The eager catalogue: every included template, its learner copy and model manifest, and the pure kernels in memory. */
export interface InstalledCatalog extends CatalogBase {
  /** Pure kernels for the served models (trusted repository code; production evaluation runs in the worker). */
  kernels(): ModelKernel[];
}

/**
 * The on-demand catalogue (`createLazyCatalog`): references, model identities, statuses, discovery entries and the
 * review registry are available at once from the installed index; a template's content (template, learner copy, model
 * manifest) is fetched by `load()` and verified against the installed digests before `getTemplate`/`getModel` return
 * it. Kernel code is never loaded into this realm (it runs in the catalogue worker). A template's `identity()`, which
 * includes its group digests, is available once its content is loaded; a model's identity at once.
 */
export interface LazyInstalledCatalog extends CatalogBase {
  /** True once the template version's content has been loaded and verified. */
  loaded(ref: { templateId: string; version: string }): boolean;
  /** Loads every listed template's content (discovery hosts, tooling). */
  loadAll(): Promise<CatalogLoadResult[]>;
}

/** Eagerly indexed data of one installed model (kept in the installed index for the lazy catalogue). */
export interface IndexedModel { ref: ModelRef; identity: ModelIdentity; referenceSuiteDigest: string | null }

export const key = (id: string, version: string): string => `${id}\u0000${version}`;
/** Status of content the catalogue does not hold exactly (unknown ID/version or a different digest). */
export const notInstalled = (): CatalogEntryStatus => ({ lifecycle: 'authored', reviews: [], revoked: false });
const revokedStatus = (reason: string): CatalogEntryStatus => ({ lifecycle: 'revoked', reviews: [], revoked: true, revocationReason: reason });
export const diagnosticsOf = (error: unknown): Diagnostic[] =>
  Array.isArray((error as { diagnostics?: unknown })?.diagnostics) ? (error as { diagnostics: Diagnostic[] }).diagnostics
    : [{ code: 'SCHEMA', path: '$', message: 'The installed entry could not be validated.' }];

/** Validated options shared by both factories: unknown `include` IDs are a configuration error. */
export function catalogMarks(options: InstalledCatalogOptions, installedTemplateIds: readonly string[]) {
  const reviews = createReviewRegistry(options.reviews ?? []);
  const revocations: MarkList = createMarkList(options.revocations ?? [], 'revocation');
  const deprecations: MarkList = createMarkList(options.deprecations ?? [], 'deprecation');
  const known = new Set(installedTemplateIds);
  const unknown = (options.include ?? []).filter(id => !known.has(id));
  if (unknown.length) throw new RangeError(`Unknown template IDs in include: ${unknown.map(id => JSON.stringify(id)).join(', ')}.`);
  const included = options.include ? new Set(options.include) : null;
  return { reviews, revocations, deprecations, included };
}

/** Installed kernel identity the manifest's execution must name exactly (ID, version and mode). */
export interface KernelIdentity { id: string; version: string; mode: string }

/**
 * Validates one installed model manifest: schema and semantics (`validateManifest`), then the installed kernel it names.
 * Returns the frozen manifest and its identity, or the diagnostics that keep it from being served.
 */
export function validateInstalledModel(input: ModelManifest, kernel: (id: string, version: string) => KernelIdentity | undefined):
  { ok: true; manifest: ModelManifest; identity: ModelIdentity; ref: ModelRef } | { ok: false; diagnostics: Diagnostic[] } {
  try {
    const { manifest, identity } = validateManifest(input);
    const execution = manifest.execution;
    const installed = execution.kind === 'kernel' ? kernel(execution.kernelId, execution.kernelVersion) : undefined;
    if (execution.kind === 'kernel' && (!installed || installed.mode !== execution.mode))
      return { ok: false, diagnostics: [{ code: 'UNSUPPORTED_CAPABILITY', path: '$.execution', message: 'The manifest names a kernel version that is not installed.' }] };
    return { ok: true, manifest, identity, ref: { modelId: manifest.modelId, version: manifest.version, digest: identity.digest } };
  } catch (error) {
    return { ok: false, diagnostics: diagnosticsOf(error) };
  }
}

/** Validates an installed template against its validated model: model reference digest, template schema and semantics. */
export function validateInstalledTemplate(template: ActivityTemplate, model: { manifest: ModelManifest; ref: ModelRef }): Diagnostic[] {
  if (template.model.digest !== model.ref.digest) return [{ code: 'INVALID_REFERENCE', path: '$.model.digest', message: 'The template model digest differs from the installed manifest.' }];
  const record = validateRecord('study-harness.activity-template', template);
  if (!record.ok) return record.diagnostics;
  return validateTemplateSemantics(template, model.manifest);
}

/**
 * Lifecycle status resolution (README "Lifecycle status"): revoked → deprecated → reviewed → reference-checked →
 * validated. A template is reviewed only when its exact content and its model are both approved; model revocation and
 * deprecation propagate to the model's templates.
 */
export function statusResolver(marks: ReturnType<typeof catalogMarks>) {
  const { reviews, revocations, deprecations } = marks;
  const modelReview = (model: IndexedModel) => reviews.resolve(
    { kind: 'model', modelId: model.ref.modelId, version: model.ref.version, scientificRevision: model.identity.scientificRevision }, model.referenceSuiteDigest);
  const modelStatus = (model: IndexedModel): CatalogEntryStatus => {
    const { modelId, version } = model.ref;
    const revoked = revocations.lookup('model', modelId, version);
    if (revoked) return revokedStatus(revoked.reason);
    const review = modelReview(model);
    const approving = review.approved ? review.approving : [];
    if (deprecations.lookup('model', modelId, version)) return { lifecycle: 'deprecated', reviews: approving, revoked: false };
    if (review.approved) return { lifecycle: 'reviewed', reviews: approving, revoked: false };
    return { lifecycle: model.referenceSuiteDigest ? 'reference-checked' : 'validated', reviews: [], revoked: false };
  };
  const templateStatus = (ref: TemplateRef, model: IndexedModel): CatalogEntryStatus => {
    const { templateId, version, digest } = ref;
    const revoked = revocations.lookup('template', templateId, version);
    if (revoked) return revokedStatus(revoked.reason);
    const modelRevoked = revocations.lookup('model', model.ref.modelId, model.ref.version);
    if (modelRevoked) return revokedStatus(`Model revoked: ${modelRevoked.reason}`);
    const review = reviews.resolve({ kind: 'template', templateId, version, contentDigest: digest }, model.referenceSuiteDigest);
    const approved = review.approved && modelReview(model).approved;
    const approving = approved ? review.approving : [];
    if (deprecations.lookup('template', templateId, version) || deprecations.lookup('model', model.ref.modelId, model.ref.version)) return { lifecycle: 'deprecated', reviews: approving, revoked: false };
    if (approved) return { lifecycle: 'reviewed', reviews: approving, revoked: false };
    return { lifecycle: model.referenceSuiteDigest ? 'reference-checked' : 'validated', reviews: [], revoked: false };
  };
  /** Status of any reference: revocation by ID and version first, then the exact digest the catalogue holds, else `authored`. */
  const status = (ref: TemplateRef | ModelRef, lookup: {
    template(templateId: string, version: string): { ref: TemplateRef; model: IndexedModel } | undefined;
    model(modelId: string, version: string): IndexedModel | undefined;
  }): CatalogEntryStatus => {
    if ('templateId' in ref) {
      const revoked = revocations.lookup('template', ref.templateId, ref.version);
      if (revoked) return revokedStatus(revoked.reason);
      const entry = lookup.template(ref.templateId, ref.version);
      return entry && entry.ref.digest === ref.digest ? templateStatus(entry.ref, entry.model) : notInstalled();
    }
    const revoked = revocations.lookup('model', ref.modelId, ref.version);
    if (revoked) return revokedStatus(revoked.reason);
    const model = lookup.model(ref.modelId, ref.version);
    return model && model.ref.digest === ref.digest ? modelStatus(model) : notInstalled();
  };
  return { modelStatus, templateStatus, status };
}
