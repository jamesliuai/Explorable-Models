import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** Decision of the Rust validator for one fixture file (`{ contract, expect, value }`). */
export interface RustDecision { file: string; contract: string; expect: 'valid' | 'invalid'; valid: boolean }

/**
 * Runs the Rust `validate-fixtures` binary over a fixture directory (default: the shared contract fixtures). A missing
 * toolchain is an environment failure, not a pass: the caller's test fails with instructions instead of skipping.
 */
export function rustDecisions(root?: string): RustDecision[] {
  const run = spawnSync('cargo', ['run', '--quiet', '--manifest-path', 'packages/activity/rust/Cargo.toml', '--bin', 'validate-fixtures', ...(root ? ['--', root] : [])], {
    cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 900_000,
  });
  if (run.error && (run.error as NodeJS.ErrnoException).code === 'ENOENT')
    throw new Error('ENVIRONMENT FAILURE: `cargo` was not found on PATH. The TypeScript/Rust contract agreement check (A02) requires the Rust toolchain (https://rustup.rs). A missing toolchain is not a passing result.');
  if (run.error) throw new Error(`ENVIRONMENT FAILURE: cargo could not run: ${run.error.message}`);
  if (run.status !== 0) throw new Error(`cargo run validate-fixtures exited with ${run.status}:\n${run.stderr}`);
  return JSON.parse(run.stdout) as RustDecision[];
}
