/** Shape of the generated installed index (`./installed-index.ts`), the eager part of `createLazyCatalog`. */
import type { TemplateDiscovery, TemplateRef } from '@explorable-models/activity';
import type { ModelIdentity, ModelRef } from '@explorable-models/core/model';
import type { KernelIdentity } from './catalog.js';

export interface IndexedModelEntry {
  readonly ref: ModelRef;
  readonly identity: ModelIdentity;
  readonly referenceSuiteDigest: string | null;
  /** The installed kernel the manifest names (null for a document execution). */
  readonly kernel: KernelIdentity | null;
}
export interface IndexedTemplateEntry {
  readonly ref: TemplateRef;
  readonly model: { readonly modelId: string; readonly version: string };
  readonly title: string;
  readonly dimension: '2d' | '3d';
  /** Discovery entry computed from the content by `templateDiscovery` (activity), for `describe()` before loading. */
  readonly discovery: TemplateDiscovery;
}
export interface InstalledIndex {
  readonly generatedBy: string;
  /** Kernels bundled in the catalogue worker (identity only; their code is never part of the index). */
  readonly kernels: readonly KernelIdentity[];
  readonly models: readonly IndexedModelEntry[];
  readonly templates: readonly IndexedTemplateEntry[];
}
