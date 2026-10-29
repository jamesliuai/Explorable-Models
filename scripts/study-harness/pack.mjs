// Builds and packs the Study Harness library tarballs into release/study-harness/packages with a hash manifest.
// Usage: node scripts/study-harness/pack.mjs [--skip-build] [--only core,activity,...]
import { mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const out = path.join(root, 'release/study-harness/packages');
const ALL = ['core', 'activity', 'catalog', 'player', 'player-3d', 'agent'];
const only = process.argv.find(argument => argument.startsWith('--only='))?.slice(7).split(',');
const PACKAGES = only ?? ALL;
if (PACKAGES.some(name => !ALL.includes(name))) throw new Error(`Unknown package in --only: ${PACKAGES.join(',')}`);
const run = (command, args, cwd = root) => {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 50_000_000 });
  if (result.error || result.status) throw new Error(`${command} ${args.join(' ')} failed\n${result.error ?? ''}${result.stderr}\n${result.stdout}`);
  return result.stdout;
};
const exists = file => access(file).then(() => true, () => false);

if (!process.argv.includes('--skip-build')) run('npm', ['run', 'build:packages']);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const packed = [];
for (const name of PACKAGES) {
  const directory = path.join(root, 'packages', name);
  if (!await exists(path.join(directory, 'dist'))) throw new Error(`packages/${name} has no dist; build it before packing.`);
  const [result] = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', out], directory));
  const files = result.files.map(file => file.path);
  for (const required of ['LICENSE', 'README.md', 'package.json']) if (!files.includes(required)) throw new Error(`${name}: missing ${required}`);
  if (files.some(file => /(^|\/)(\.env|\.git|node_modules|target)(\/|$)/.test(file))) throw new Error(`${name}: forbidden path in tarball`);
  if (name === 'activity') for (const required of ['rust/Cargo.toml', 'rust/src/lib.rs', 'schema/index.json']) if (!files.includes(required)) throw new Error(`${name}: missing native contract file ${required}`);
  const bytes = await readFile(path.join(out, result.filename));
  packed.push({ name: result.name, version: result.version, file: result.filename, sha256: createHash('sha256').update(bytes).digest('hex'), integrity: result.integrity, bytes: bytes.length, files: files.length });
}
const lock = await readFile(path.join(root, 'package-lock.json'));
const source = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim() || null;
const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout.trim().length > 0;
const manifest = { complete: PACKAGES.length === ALL.length, createdAt: new Date().toISOString(), source: { commit: source, dirty }, lockSha256: createHash('sha256').update(lock).digest('hex'), node: process.version, packages: packed };
await writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
