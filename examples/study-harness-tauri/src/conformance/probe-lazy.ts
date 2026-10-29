// CONFORMANCE BUILD ONLY. Loaded with import() from inside the probe worker, so the build emits it as a separate
// chunk; it verifies relative module resolution from the worker's own URL.
export const lazyUrl: string = import.meta.url;

export function square(value: number): number {
  return value * value;
}
