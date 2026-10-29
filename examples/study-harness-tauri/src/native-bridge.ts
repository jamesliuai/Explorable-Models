// The only module that touches the Tauri JavaScript API. The visualization packages never import Tauri; the host
// passes the adapter a narrow HostPort built on this bridge instead.
//
// Every request travels as a RAW body (a Uint8Array of UTF-8 JSON) so the Rust side receives `InvokeBody::Raw`, checks
// its byte length before parsing and validates it against the shared JSON Schemas (native.md N7). Failures arrive as
// `{ code, message }` with a fixed sentence per code; a HostPort refusal also carries the specific host code as `reason`
// (HostPort refusal convention, see native-host.ts).
//
// The root workspace tsconfig includes examples/**, but this private package installs its own dependencies (it is not
// a root workspace); in a root-only install @tauri-apps/api is absent, so the import is shielded for the root typecheck.
// With this package installed, `npm run typecheck` checks the real declarations against the narrower signature below.
// @ts-ignore -- resolved from examples/study-harness-tauri/node_modules
import { invoke as tauriInvoke } from '@tauri-apps/api/core';

type RawInvoke = (command: string, args?: Uint8Array | Record<string, unknown>, options?: { headers: Record<string, string> }) => Promise<unknown>;
const invokeRaw: RawInvoke = tauriInvoke;
const encoder = new TextEncoder();

/** A refusal or failure reported by the native host (or by the IPC layer, e.g. an ACL rejection). */
export class NativeHostError extends Error {
  constructor(readonly code: string, message: string, readonly reason: string | null = null) {
    super(message);
    this.name = 'NativeHostError';
  }
}

const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

export function toNativeError(error: unknown): NativeHostError {
  if (error instanceof NativeHostError) return error;
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') {
    const { code, message, reason } = error as { code: string; message?: unknown; reason?: unknown };
    return new NativeHostError(code, typeof message === 'string' ? message : code, typeof reason === 'string' && CODE.test(reason) ? reason : null);
  }
  const text = typeof error === 'string' ? error : error instanceof Error ? error.message : 'The native host did not answer.';
  return new NativeHostError(/not allowed/i.test(text) ? 'IPC_DENIED' : 'IPC_FAILED', text.slice(0, 300));
}

export interface CallRecord { command: string; ok: boolean; code: string | null; reason: string | null; ms: number }
type CallListener = (record: CallRecord) => void;
const listeners = new Set<CallListener>();
/** Observes every bridge call (host panel diagnostics). */
export function onCall(listener: CallListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function notify(record: CallRecord): void {
  for (const listener of [...listeners]) {
    try { listener(record); } catch { /* A diagnostics listener never affects a host call. */ }
  }
}

/** Calls a native command with `body` encoded as a raw JSON byte body. */
export async function call<T>(command: string, body: unknown): Promise<T> {
  return callBytes<T>(command, encoder.encode(JSON.stringify(body)));
}

/** Calls a native command with raw bytes (and optional headers). */
export async function callBytes<T>(command: string, bytes: Uint8Array, headers?: Record<string, string>): Promise<T> {
  const started = performance.now();
  try {
    const result = await invokeRaw(command, bytes, headers ? { headers } : undefined);
    notify({ command, ok: true, code: null, reason: null, ms: performance.now() - started });
    return result as T;
  } catch (error) {
    const failure = toNativeError(error);
    notify({ command, ok: false, code: failure.code, reason: failure.reason, ms: performance.now() - started });
    throw failure;
  }
}

/** Calls a native command with a JSON-object body (used only to show that such calls are refused). */
export async function callJsonObject<T>(command: string, args: Record<string, unknown>): Promise<T> {
  try {
    return (await invokeRaw(command, args)) as T;
  } catch (error) {
    throw toNativeError(error);
  }
}
