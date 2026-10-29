// The only module that touches the Tauri JavaScript API. Visualization packages must never
// import Tauri; the host passes narrow typed callbacks instead.
//
// The root workspace tsconfig includes examples/**, but this private package installs its own
// dependencies (it is not a root workspace). In a root-only install @tauri-apps/api is absent,
// so the import is shielded for the root typecheck; with this package installed the real
// declarations are checked against the narrower signature below.
// @ts-ignore -- resolved from examples/study-harness-tauri/node_modules
import { invoke as tauriInvoke } from '@tauri-apps/api/core';

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export const invoke: Invoke = tauriInvoke;
