/**
 * Optional schema 2.0 document execution (architecture D3, report §8.1, §16). The model layer reaches the document
 * compiler and interpreter only through this registry, so a runtime that serves installed kernels only — the learner
 * page of the installed catalogue and its kernel worker — does not bundle them. `enableDocumentExecution()`
 * (`./documents.ts`, exported from `@experiment-kit/core/model`) installs them; until it has run in a realm, validating,
 * identifying, opening or evaluating a manifest whose execution kind is `document` fails with UNSUPPORTED_CAPABILITY
 * instead of being interpreted some other way. Kernel manifests never touch this module's state.
 */
import type { Diagnostic, DocumentFrame, VisualizationDocument } from '../declarative/types.js';
import type { CompiledDocument } from '../declarative/validation.js';
import { ModelError, diagnostic } from './errors.js';
import type { ModelManifest } from './types.js';

/** The schema 2.0 functions a `document` execution needs (normalization, bounded compilation, evaluation). */
export interface DocumentExecutionSupport {
  normalize(document: unknown): VisualizationDocument;
  compile(document: unknown): CompiledDocument;
  /**
   * Agreement of a manifest with the compiled document, including coherent coordinate/quantity units. Optional for
   * source compatibility with older registries; document manifest validation refuses support without this callback.
   */
  manifestErrors?(manifest: ModelManifest, compiled: CompiledDocument): Diagnostic[];
  /** Synchronous scientific document identity. Older partial registries are refused when this is absent. */
  modelRevision?(document: VisualizationDocument): string;
  /** `numericalLimits: true` keeps the interpreter's numerical-limit markers (the model layer always asks for them). */
  evaluate(compiled: CompiledDocument, params: Record<string, number>, time: number, options?: { numericalLimits?: boolean }): DocumentFrame;
}

let installed: DocumentExecutionSupport | null = null;

/** Installs document execution for this realm (idempotent; the first installation is kept). */
export function installDocumentExecution(support: DocumentExecutionSupport): void {
  if (installed) return;
  if (!support || typeof support.normalize !== 'function' || typeof support.compile !== 'function' || typeof support.evaluate !== 'function') throw new TypeError('Document execution support needs normalize, compile and evaluate functions.');
  if (support.manifestErrors !== undefined && typeof support.manifestErrors !== 'function') throw new TypeError('Document manifest validation support must be a function.');
  if (support.modelRevision !== undefined && typeof support.modelRevision !== 'function') throw new TypeError('Document model identity support must be a function.');
  installed = Object.freeze({ normalize: support.normalize, compile: support.compile, evaluate: support.evaluate, manifestErrors: support.manifestErrors, modelRevision: support.modelRevision });
}

/** True once `enableDocumentExecution()` has run in this realm. */
export const documentExecutionEnabled = (): boolean => installed !== null;

/** The installed document functions, or a ModelError (UNSUPPORTED_CAPABILITY at `path`) when none are installed. */
export function documentExecution(path = '$.execution'): DocumentExecutionSupport {
  if (installed) return installed;
  return missingDocumentSupport(path, 'execution');
}

/** A partial/older registry is never permission to skip an unsupported document operation. */
export function missingDocumentSupport(path: string, capability: 'execution' | 'manifest validation' | 'model identity'): never {
  throw new ModelError([diagnostic('UNSUPPORTED_CAPABILITY', path, `Schema 2.0 document ${capability} is not enabled.`,
    'Call enableDocumentExecution() in fresh page and worker realms, or use an installed kernel.')]);
}
