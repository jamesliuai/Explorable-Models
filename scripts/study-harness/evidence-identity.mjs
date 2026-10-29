// Identity and history helpers shared by the Study Harness evidence writers (report §22.3; G78).
//
// Every evidence record should identify the source commit, the dependency lock digest, tool/runtime versions and the
// platform, and failed attempts must stay available. These helpers read that identity from the working tree and write
// append-only history records next to an evidence directory:
//
//   <evidence dir>/history/<kind>-<UTC timestamp>.json   (never overwritten; a collision gets a numeric suffix)
//
// The summary files (consumer.json, native-conformance.json, verification.json) stay the latest index; history keeps
// every run, including failed ones. Nothing here reads or writes credentials, learner data or study content.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HISTORY_SCHEMA = 'study-harness.evidence-history/1';
export const sha256Hex = bytes => createHash('sha256').update(bytes).digest('hex');

/** Runs a command without a shell; returns trimmed stdout, or null when it is missing or fails. */
export function commandOutput(command, args = [], options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options });
  return result.error || result.status !== 0 ? null : result.stdout.trim();
}

/** Source commit and whether the working tree differs from it (tracked or untracked files). Null when not a git checkout. */
export function sourceIdentity(root, run = commandOutput) {
  const commit = run('git', ['rev-parse', 'HEAD'], { cwd: root });
  const status = run('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root });
  return {
    commit: commit && /^[0-9a-f]{40}$/.test(commit) ? commit : null,
    dirty: status === null ? null : status.length > 0,
    ...(status ? { changedPaths: status.split('\n').filter(Boolean).length } : {}),
  };
}

/** sha256 of the root package-lock.json bytes (the dependency lock digest). */
export function lockIdentity(root) {
  try { return { file: 'package-lock.json', sha256: sha256Hex(readFileSync(path.join(root, 'package-lock.json'))) }; }
  catch { return { file: 'package-lock.json', sha256: null }; }
}

/**
 * Identity of a release artifact (G78): the source commit and dirty flag, the workspace dependency lock digest, the Node
 * version and the platform that produced it.
 */
export function releaseIdentity(root, run = commandOutput) {
  const source = sourceIdentity(root, run);
  return { source: { commit: source.commit, dirty: source.dirty }, packageLock: lockIdentity(root), node: process.version, platform: { platform: process.platform, arch: process.arch } };
}

/** Missing identity fields of a release manifest (empty when it identifies its source, lock and Node version). */
export function missingReleaseIdentity(manifest) {
  const missing = [];
  if (!manifest?.source || !('commit' in manifest.source) || !('dirty' in manifest.source)) missing.push('source commit and dirty flag');
  if (!/^[0-9a-f]{64}$/.test(manifest?.packageLock?.sha256 ?? '')) missing.push('package-lock sha256');
  if (!/^v\d+\.\d+\.\d+/.test(manifest?.node ?? '')) missing.push('node version');
  return missing;
}

/** Versions of the tools a gate depends on; a missing tool is recorded as null, never guessed. */
export function toolVersions(root, run = commandOutput) {
  const version = (name) => {
    try { return JSON.parse(readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version ?? null; } catch { return null; }
  };
  return {
    node: process.version,
    npm: run('npm', ['-v'], { cwd: root }),
    rustc: run('rustc', ['-V']),
    cargo: run('cargo', ['-V']),
    playwright: version('playwright'),
    vitest: version('vitest'),
    typescript: version('typescript'),
    vite: version('vite'),
  };
}

/** macOS console lock state from `ioreg` (CGSSessionScreenIsLocked); null when unreadable or not macOS. */
export function consoleLocked(run = commandOutput) {
  if (process.platform !== 'darwin') return null;
  const output = run('ioreg', ['-n', 'Root', '-d1']);
  if (output === null) return null;
  const match = output.match(/"CGSSessionScreenIsLocked"\s*=\s*(Yes|No)/);
  return match ? match[1] === 'Yes' : false;
}

/** Platform, architecture and operating-system version (macOS product/build version where available). */
export function platformIdentity(run = commandOutput) {
  const darwin = process.platform === 'darwin';
  return {
    platform: process.platform,
    arch: process.arch,
    os: darwin
      ? { name: 'macOS', version: run('sw_vers', ['-productVersion']), build: run('sw_vers', ['-buildVersion']), kernel: os.release() }
      : { name: os.type(), version: os.release(), build: null, kernel: os.release() },
    cpu: (darwin ? run('sysctl', ['-n', 'machdep.cpu.brand_string']) : null) ?? os.cpus()[0]?.model ?? null,
    logicalCpus: os.cpus().length,
    memoryBytes: os.totalmem(),
  };
}

/** A filesystem-safe UTC timestamp (2026-10-26T15-04-05.123Z). */
export const stamp = (date = new Date()) => date.toISOString().replace(/:/g, '-');

/**
 * Writes `record` to `<directory>/history/<kind>-<timestamp>.json` with the exclusive-create flag, so an existing
 * history file is never replaced. Returns the written path.
 */
export function writeHistoryRecord(directory, kind, record, { now = new Date(), root = null, identity = null } = {}) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(kind)) throw new TypeError(`Invalid history kind: ${kind}`);
  const folder = path.join(directory, 'history');
  mkdirSync(folder, { recursive: true });
  const envelope = {
    schema: HISTORY_SCHEMA,
    kind,
    recordedAt: now.toISOString(),
    ...(identity ?? (root ? { source: sourceIdentity(root), packageLock: lockIdentity(root), node: process.version, platform: { platform: process.platform, arch: process.arch } } : {})),
    record,
  };
  const text = `${JSON.stringify(envelope)}\n`;
  for (let attempt = 0; attempt < 1000; attempt++) {
    const file = path.join(folder, `${kind}-${stamp(now)}${attempt ? `-${attempt}` : ''}.json`);
    try { writeFileSync(file, text, { flag: 'wx' }); return file; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  throw new Error(`Could not create a unique history record for ${kind}.`);
}

/**
 * The packaged conformance evidence without its bulky raw diagnostics: every scenario keeps its run ID, crash point
 * and every check (ID, result, detail); launches, phases and database dumps stay only in the latest full evidence.
 */
export function compactNativeEvidence(evidence) {
  const scenarios = Object.fromEntries(Object.entries(evidence.scenarios ?? {}).map(([name, scenario]) => [name, {
    ...(scenario.run ? { run: scenario.run } : {}),
    ...(scenario.point ? { point: scenario.point } : {}),
    checks: scenario.checks ?? [],
  }]));
  return { ...evidence, scenarios };
}
