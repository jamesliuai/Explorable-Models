#!/usr/bin/env node
// Installs the reference host's frontend dependencies from the ACTUAL packed library tarballs.
//
//   node scripts/install-packed.mjs [--pack]
//
// --pack  first runs `node scripts/study-harness/pack.mjs --only=core,activity,catalog,player,player-3d` at the
//         repository root (builds the packages and packs them into release/study-harness/packages with a hash manifest).
//
// `@explorable-models/player-3d` (with its pinned peer `three`) is installed so spatial activities load the real lazy 3D
// chunk in the packaged app (native.md, G76); 2D activities never load it.
//
// The tarballs are referenced by `file:` paths in package.json (no monorepo aliases, no workspace links). Each
// tarball's sha256 is checked against release/study-harness/packages/manifest.json before installing, the install runs
// with an isolated, empty npm cache and without lifecycle scripts, and the installed identities are written to
// packed-artifacts.json, which the conformance runner records as evidence.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(appRoot, '../..');
const packedDir = path.join(repoRoot, 'release/study-harness/packages');
const PACKAGES = ['core', 'activity', 'catalog', 'player', 'player-3d'];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status})\n${result.error ?? ''}${result.stderr}\n${result.stdout}`.slice(0, 8000));
  }
  return result.stdout;
}
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha512 = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

if (process.argv.includes('--pack')) {
  console.log(`[install-packed] packing ${PACKAGES.join(', ')}`);
  run(process.execPath, ['scripts/study-harness/pack.mjs', `--only=${PACKAGES.join(',')}`], { cwd: repoRoot });
}

const manifestPath = path.join(packedDir, 'manifest.json');
if (!existsSync(manifestPath)) throw new Error(`No packed manifest. Run with --pack (or node scripts/study-harness/pack.mjs --only=${PACKAGES.join(',')}).`);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const appManifest = JSON.parse(readFileSync(path.join(appRoot, 'package.json'), 'utf8'));

const expected = PACKAGES.map((short) => {
  const name = `@explorable-models/${short}`;
  const entry = manifest.packages.find((item) => item.name === name);
  if (!entry) throw new Error(`${name} is missing from ${path.relative(repoRoot, manifestPath)}; re-run with --pack.`);
  const spec = appManifest.dependencies[name];
  if (spec !== `file:../../release/study-harness/packages/${entry.file}`) throw new Error(`package.json must depend on ${name} through file:../../release/study-harness/packages/${entry.file} (found ${spec}).`);
  const bytes = readFileSync(path.join(packedDir, entry.file));
  if (sha256(bytes) !== entry.sha256) throw new Error(`${entry.file}: sha256 differs from the packed manifest.`);
  if (sha512(bytes) !== entry.integrity) throw new Error(`${entry.file}: integrity differs from the packed manifest.`);
  return entry;
});

// A file: tarball keeps its integrity in package-lock.json; drop stale entries so a re-packed tarball is reinstalled.
const lockPath = path.join(appRoot, 'package-lock.json');
if (existsSync(lockPath)) {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  let changed = false;
  for (const entry of expected) {
    const key = `node_modules/${entry.name}`;
    if (lock.packages?.[key] && lock.packages[key].integrity !== entry.integrity) {
      delete lock.packages[key];
      changed = true;
    }
  }
  if (changed) writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}
for (const short of PACKAGES) rmSync(path.join(appRoot, 'node_modules/@explorable-models', short), { recursive: true, force: true });

const cache = mkdtempSync(path.join(tmpdir(), 'sh-reference-npm-cache-'));
console.log(`[install-packed] npm install with isolated cache ${cache}`);
try {
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: appRoot,
    env: { ...process.env, npm_config_cache: cache, npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' },
  });
} finally {
  rmSync(cache, { recursive: true, force: true });
}

const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
const installed = expected.map((entry) => {
  const directory = path.join(appRoot, 'node_modules', entry.name);
  if (lstatSync(directory).isSymbolicLink()) throw new Error(`${entry.name} is a symbolic link; the reference host must use the extracted tarball.`);
  const pkg = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
  if (pkg.version !== entry.version) throw new Error(`${entry.name}: installed ${pkg.version}, packed ${entry.version}.`);
  const locked = lock.packages?.[`node_modules/${entry.name}`];
  if (locked?.integrity !== entry.integrity) throw new Error(`${entry.name}: package-lock integrity ${locked?.integrity} differs from the packed tarball.`);
  return { name: entry.name, version: entry.version, file: entry.file, sha256: entry.sha256, integrity: entry.integrity, bytes: entry.bytes, resolved: locked.resolved };
});
const record = {
  schema: 'study-harness-reference.packed-artifacts/1',
  note: 'Written by scripts/install-packed.mjs: identities of the packed tarballs installed into node_modules (sha256 checked against the pack manifest; integrity checked against package-lock.json).',
  packManifest: { createdAt: manifest.createdAt, source: manifest.source, lockSha256: manifest.lockSha256, node: manifest.node },
  react: lock.packages?.['node_modules/react']?.version ?? null,
  reactDom: lock.packages?.['node_modules/react-dom']?.version ?? null,
  three: lock.packages?.['node_modules/three']?.version ?? null,
  packages: installed,
};
writeFileSync(path.join(appRoot, 'packed-artifacts.json'), `${JSON.stringify(record, null, 2)}\n`);
console.log(JSON.stringify(record, null, 2));
