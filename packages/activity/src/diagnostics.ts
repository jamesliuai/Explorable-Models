/**
 * Bridge from model-layer diagnostics (`@experiment-kit/core/model`) to the activity vocabulary. Core codes are the
 * subset of {@link DiagnosticCode} that the model layer produces, plus `WORKER_PROTOCOL` for a worker reply that broke
 * the message protocol. The activity vocabulary reports worker failures only as `WORKER_ERROR` or `WORKER_TIMEOUT`
 * (D10), so `WORKER_PROTOCOL` is presented as `WORKER_ERROR`; an event or summary carrying the core code would fail
 * the `operation.failed` payload schema. The compile-time check below fails when core gains a code this vocabulary
 * does not define.
 */
import type { ModelDiagnosticCode } from '@experiment-kit/core/model';
import type { Diagnostic, DiagnosticCode, HostRefusalCode } from './contracts.js';
import { HOST_REFUSAL_CODES } from './contracts.js';
import { DIAGNOSTIC_CODES } from './schemas.js';

/** Core codes that have no activity equivalent of the same name, with the activity code that presents them. */
export const MODEL_CODE_MAP = Object.freeze({ WORKER_PROTOCOL: 'WORKER_ERROR' } as const satisfies Partial<Record<ModelDiagnosticCode, DiagnosticCode>>);
// Every other model code must already be an activity code.
const _covered: Exclude<ModelDiagnosticCode, keyof typeof MODEL_CODE_MAP> extends DiagnosticCode ? true : never = true;
void _covered;

const KNOWN: ReadonlySet<string> = new Set(DIAGNOSTIC_CODES);
const MAPPED: Readonly<Record<string, DiagnosticCode>> = MODEL_CODE_MAP;

/**
 * Maps model-layer diagnostics to activity diagnostics. Activity codes pass through, codes in {@link MODEL_CODE_MAP}
 * are renamed, and any other code (for example one passed through from a schema 2.0 document error) becomes
 * `fallback`. Path, message and recovery are kept; model-layer messages never contain hidden values.
 */
export function fromModelDiagnostics(items: readonly { code: string; path: string; message: string; recovery?: string }[], fallback: DiagnosticCode = 'INVALID_INPUT'): Diagnostic[] {
  return items.map(item => ({
    code: Object.hasOwn(MAPPED, item.code) ? MAPPED[item.code]! : KNOWN.has(item.code) ? item.code as DiagnosticCode : fallback,
    path: item.path, message: item.message, ...(item.recovery !== undefined ? { recovery: item.recovery } : {}),
  }));
}

/** Path of every host-refusal diagnostic, so callers can tell a host decision from a problem with their own input. */
export const HOST_REFUSAL_PATH = '$.host';
const REFUSAL_TEXT: Readonly<Record<HostRefusalCode, string>> = Object.freeze({
  POLICY_DENIED: 'The host refused this request under its current policy.',
  POLICY_EXPIRED: 'The host refused this request because its policy for this activity has expired.',
  CONTENT_REVOKED: 'The host refused this request because the content is revoked.',
  STALE_POLICY_REVISION: 'The host refused this request because it holds a different policy revision.',
  INVALID_INPUT: 'The host refused this request as invalid.',
});

/**
 * Diagnostic for a host refusal (activity-runtime §10): the host's code at {@link HOST_REFUSAL_PATH} with a fixed
 * sentence (the host's own message is never echoed). A refusal is final for that request: it is not retried, not cached
 * as pending and not recorded as uncertain.
 */
export function hostRefusalDiagnostic(code: HostRefusalCode, outcome = 'Nothing was recorded and nothing new was shown.'): Diagnostic {
  return { code, path: HOST_REFUSAL_PATH, message: `${REFUSAL_TEXT[code]} ${outcome}`, recovery: 'Do not repeat this request; the host decided it. Continue with what is shown, or ask the host.' };
}

/** True for a diagnostic made by {@link hostRefusalDiagnostic}. */
export function isHostRefusalDiagnostic(item: Pick<Diagnostic, 'code' | 'path'>): boolean {
  return item.path === HOST_REFUSAL_PATH && (HOST_REFUSAL_CODES as readonly string[]).includes(item.code);
}
