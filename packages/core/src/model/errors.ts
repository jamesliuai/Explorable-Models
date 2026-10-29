/**
 * Structured model errors. Codes are the subset of the Study Harness diagnostic vocabulary
 * (`@experiment-kit/activity` `DiagnosticCode`) that the model layer can produce, plus `WORKER_PROTOCOL` for a worker
 * reply that violates the message protocol (adapters may present it as a worker failure). Messages never contain
 * parameter values, hidden quantities or stack traces.
 */
import { DocumentError, type Diagnostic } from '../declarative/types.js';

export type ModelDiagnosticCode =
  | 'UNSUPPORTED_CAPABILITY' | 'INVALID_REFERENCE' | 'INVALID_INPUT' | 'SCHEMA' | 'CONSTRAINT_VIOLATION' | 'OUT_OF_DOMAIN'
  | 'UNDEFINED_CALCULATION' | 'NUMERICAL_LIMIT' | 'WORKER_ERROR' | 'WORKER_TIMEOUT' | 'WORKER_PROTOCOL' | 'CANCELLED'
  | 'DISPOSED' | 'CONFLICT' | 'OPERATION_CONFLICT' | 'PREVIEW_ACTIVE' | 'NOT_READY' | 'RESOURCE_LIMIT' | 'NOT_FOUND' | 'UNIT_MISMATCH';

export const MODEL_RECOVERIES: Readonly<Record<ModelDiagnosticCode, string>> = Object.freeze({
  UNSUPPORTED_CAPABILITY: 'Use a model, kernel or operation advertised by the installed catalogue.',
  INVALID_REFERENCE: 'Refer only to identifiers declared by the model manifest.',
  INVALID_INPUT: 'Correct the input to match the documented contract.',
  SCHEMA: 'Correct the manifest so it matches the model manifest schema.',
  CONSTRAINT_VIOLATION: 'Choose parameter values that satisfy the model constraints.',
  OUT_OF_DOMAIN: 'Choose a value inside the declared domain.',
  UNDEFINED_CALCULATION: 'Inspect the reason and choose different parameters if appropriate.',
  NUMERICAL_LIMIT: 'Choose an earlier position or parameters that stay within the representable range.',
  WORKER_ERROR: 'Retry; the last accepted state is unchanged.',
  WORKER_TIMEOUT: 'Retry; the worker was restarted and the last accepted state is unchanged.',
  WORKER_PROTOCOL: 'Retry; the worker was restarted after an invalid reply and the last accepted state is unchanged.',
  CANCELLED: 'Start a new operation when ready.',
  DISPOSED: 'Create a new session or evaluator.',
  CONFLICT: 'Read the current state and retry with its version and run ID.',
  OPERATION_CONFLICT: 'Use a new operation ID for a different request.',
  PREVIEW_ACTIVE: 'Commit or cancel the active preview first.',
  NOT_READY: 'Load a model, or resume the session, before this operation.',
  RESOURCE_LIMIT: 'Reduce the request to the documented limit or release unused resources.',
  NOT_FOUND: 'Inspect the current state for available identifiers.',
  UNIT_MISMATCH: 'Declare the same dimension and unit wherever the same value is described; units are never converted silently.',
});

export class ModelError extends Error {
  readonly diagnostics: Diagnostic[];
  constructor(diagnostics: Diagnostic[]) {
    const list = diagnostics.length ? diagnostics.slice(0, 32) : [{ code: 'WORKER_ERROR', path: '$', message: 'Model operation failed.' }];
    super(list.map(item => `${item.path}: ${item.message}`).join('; ').slice(0, 4000));
    this.name = 'ModelError';
    this.diagnostics = list;
  }
  /** Code of the first diagnostic. */
  get code(): string { return this.diagnostics[0].code; }
}

export function diagnostic(code: ModelDiagnosticCode, path: string, message: string, recovery: string = MODEL_RECOVERIES[code]): Diagnostic {
  return { code, path, message, recovery };
}
export function modelError(code: ModelDiagnosticCode, path: string, message: string, recovery?: string): ModelError {
  return new ModelError([diagnostic(code, path, message, recovery)]);
}
export function fail(code: ModelDiagnosticCode, path: string, message: string, recovery?: string): never {
  throw modelError(code, path, message, recovery);
}

/** Converts any thrown value to bounded diagnostics without leaking messages or stacks of unknown errors. */
export function toDiagnostics(error: unknown, fallback: ModelDiagnosticCode = 'WORKER_ERROR'): Diagnostic[] {
  if (error instanceof ModelError || error instanceof DocumentError) return structuredClone(error.diagnostics.slice(0, 32));
  return [diagnostic(fallback, '$', 'Model operation failed.')];
}
export function isModelError(error: unknown, code?: ModelDiagnosticCode): error is ModelError {
  return error instanceof ModelError && (code === undefined || error.diagnostics.some(item => item.code === code));
}
