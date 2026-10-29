/**
 * Node-side toolkit facade for the activity authoring commands. The CLI never imports this module directly: it is
 * bundled at run time from the toolkit sources with explicit aliases (activity-loader.ts), so Node resolves
 * `@explorable-models/*` to the exact source tree that the browser harness bundles, whatever the working directory and
 * whether or not workspace links exist. Everything here is trusted repository code; it never loads authored code.
 */
import { canonicalJSON, sha256 } from '@explorable-models/core';
import { enableDocumentExecution, modelIdentity, validateManifest, type ModelManifest } from '@explorable-models/core/model';
import { groupDigests, templateRef, type ActivityTemplate } from '@explorable-models/activity';
import { createInstalledCatalog, INSTALLED_KERNELS } from '@explorable-models/catalog';

export * from './activity-fixtures.js';
export * from './activity-validation.js';
export * from './activity-policy.js';
export { canonicalJSON, groupDigests, modelIdentity, sha256, templateRef, validateManifest };

// Authored packages may execute a bounded schema 2.0 document (architecture D3): the toolkit validates them.
enableDocumentExecution();

export interface InstalledEntry {
  template: ActivityTemplate;
  manifest: ModelManifest;
  templateRef: ReturnType<typeof templateRef>;
  modelRef: { modelId: string; version: string; digest: string };
  modelIdentity: ReturnType<typeof modelIdentity>;
  groups: ReturnType<typeof groupDigests>;
  lifecycle: string;
  reviewScope: string[];
  kernel: { id: string; version: string; mode: string } | null;
}

/** Installed templates as served by the catalogue (problems excluded), with exact identities and catalogue status. */
export function installedEntries(): InstalledEntry[] {
  const catalog = createInstalledCatalog({ workerFactory: () => { throw new Error('No worker is created in Node.'); } });
  return catalog.listTemplates().map(entry => {
    const template = catalog.getTemplate(entry.template)!;
    const manifest = catalog.getModel(entry.model)!;
    const execution = manifest.execution;
    const kernel = execution.kind === 'kernel' ? INSTALLED_KERNELS.find(item => item.id === execution.kernelId && item.version === execution.kernelVersion) ?? null : null;
    return {
      template, manifest, templateRef: entry.template, modelRef: entry.model, modelIdentity: modelIdentity(manifest), groups: groupDigests(template, manifest),
      lifecycle: entry.status.lifecycle, reviewScope: entry.status.reviews.map(review => review.scope),
      kernel: kernel ? { id: kernel.id, version: kernel.version, mode: kernel.mode } : null,
    };
  });
}

/** Problems the installed catalogue reports (entries it does not serve). */
export function installedProblems(): { kind: string; id: string; version: string; codes: string[] }[] {
  return createInstalledCatalog({ workerFactory: () => { throw new Error('No worker is created in Node.'); } }).problems()
    .map(problem => ({ kind: problem.kind, id: problem.id, version: problem.version, codes: problem.diagnostics.map(item => item.code) }));
}

/** sha256 of exact text, `sha256:` prefixed (the reference-suite digest convention). */
export const textDigest = (text: string): string => 'sha256:' + sha256(text);
export const valueDigest = (value: unknown): string => 'sha256:' + sha256(canonicalJSON(value));
