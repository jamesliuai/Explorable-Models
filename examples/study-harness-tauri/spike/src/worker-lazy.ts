// Loaded with a dynamic import() from inside the module worker so the build emits it as a
// separate chunk. This verifies relative module resolution from the worker's own URL.

export const lazyModuleUrl: string = import.meta.url;

export function quadratic(a: number, b: number, c: number, x: number): number {
  return a * x * x + b * x + c;
}
