/**
 * Opt-in schema 2.0 document execution for the model layer (architecture D3). Importing this module costs nothing until
 * `enableDocumentExecution()` is called: only then does a bundle that references it carry the document compiler and
 * interpreter. Call it once in every realm that validates, identifies or evaluates `document` executions — the page
 * that constructs an adapter or session for them and the worker that evaluates them (`serveModelWorker`). Realms that
 * serve installed kernels only never call it.
 */
import { evaluateCompiledDocument } from '../declarative/evaluation.js';
import { documentModelProjection } from '../declarative/model-projection.js';
import { compileDocument, normalizeDocument } from '../declarative/validation.js';
import { digest } from '../identity.js';
import { documentManifestErrors } from './document-manifest.js';
import { documentExecutionEnabled, installDocumentExecution } from './document-support.js';

/** Enables `document` executions in this realm (idempotent). Returns true. */
export function enableDocumentExecution(): true {
  if (!documentExecutionEnabled()) installDocumentExecution({
    normalize: normalizeDocument, compile: compileDocument, evaluate: evaluateCompiledDocument, manifestErrors: documentManifestErrors,
    modelRevision: document => digest(documentModelProjection(normalizeDocument(document))),
  });
  return true;
}
