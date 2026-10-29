// Emits the authoritative activity contract schemas (packages/activity/src/schemas.ts) as JSON Schema 2020-12 files
// for TypeScript, Rust and host consumers, and the shared TS/Rust contract fixtures:
//   packages/activity/schema/<name>.schema.json  one file per contract/message plus explorable-models.model-manifest
//   packages/activity/schema/index.json          file list, per-file sha256, canonical digests and data limits
//   packages/activity/schema/frozen-1.0.json     digest lock for version 1.0 (written once, never rewritten)
//   packages/activity/fixtures/contracts/<valid|invalid>/<short-name>/<case>.json
//                                                from packages/activity/fixtures-src (typed exemplars + mutations)
//   packages/activity/fixtures/integrity/<valid|invalid>/<case>.json
//                                                artifact integrity-manifest decisions shared by the TypeScript
//                                                verifier and the Rust reference host (fixtures-src/integrity.ts)
// `--check` verifies that every emitted file is current without writing (exit code 1 on drift).
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';
register();
const { SCHEMAS, SCHEMA_NAMES, SCHEMA_VERSIONS, SHORT_NAMES, dataLimitsFor, schemaFileName, schemaDigest } = await import('../../packages/activity/src/index.ts');
const { buildFixtures, fixtureText } = await import('../../packages/activity/fixtures-src/cases.ts');
const { buildIntegrityFixtures } = await import('../../packages/activity/fixtures-src/integrity.ts');
const { DOCUMENT_SCHEMA } = await import('../../packages/core/src/declarative/schema.ts');

const packageRoot = fileURLToPath(new URL('../../packages/activity/', import.meta.url));
const check = process.argv.includes('--check');
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';

/** Generated file text keyed by path relative to packages/activity. */
const files = new Map();
const entries = SCHEMA_NAMES.map(name => {
  const file = schemaFileName(name);
  const text = json(SCHEMAS[name]);
  files.set(`schema/${file}`, text);
  return { name, short: SHORT_NAMES[name], version: SCHEMA_VERSIONS[name], file, sha256: sha256(text), digest: schemaDigest(SCHEMAS[name]), dataLimits: dataLimitsFor(name) };
});
files.set('schema/index.json', json({
  generatedBy: 'scripts/study-harness/generate-contracts.mjs',
  draft: 'https://json-schema.org/draft/2020-12/schema',
  notes: 'Schemas are authoritative for shape and bounds; semantic cross-references are checked by @explorable-models/activity validate*Semantics. dataLimits (bytes counted as in core jsonDataErrors, nesting depth, node count, and rejection of __proto__/prototype/constructor keys) are applied before schema traversal by both validators.',
  contracts: entries,
}));
for (const { path, fixture } of buildFixtures()) files.set(`fixtures/contracts/${path}`, fixtureText(fixture));
for (const { path, fixture } of buildIntegrityFixtures()) files.set(`fixtures/integrity/${path}`, fixtureText(fixture));
const lock = {
  version: '1.0',
  notes: 'Digest lock: a 1.0 schema may never change. Publish changes under a new schema version with its own lock and keep a reader for 1.0.',
  schemas: Object.fromEntries(entries.filter(entry => entry.version === '1.0').map(entry => [entry.name, entry.digest])),
  baseline: { 'explorable-models.document-2.0': schemaDigest(DOCUMENT_SCHEMA) },
};

const read = async path => { try { return await readFile(join(packageRoot, path), 'utf8'); } catch { return null; } };
const walk = async directory => {
  const found = [];
  for (const entry of await readdir(join(packageRoot, directory), { withFileTypes: true }).catch(() => [])) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) found.push(...await walk(path)); else found.push(path);
  }
  return found;
};
const drift = [];
for (const [path, text] of files) if (await read(path) !== text) drift.push(path);
const generated = [...(await walk('schema')).filter(path => path.endsWith('.schema.json') || path === 'schema/index.json'), ...await walk('fixtures/contracts'), ...await walk('fixtures/integrity')];
const stale = generated.filter(path => !files.has(path));
const frozen = await read('schema/frozen-1.0.json');

if (check) {
  const problems = [...drift.map(path => `${path} is not current`), ...stale.map(path => `${path} is no longer generated`), ...(frozen ? [] : ['schema/frozen-1.0.json is missing'])];
  if (problems.length) {
    console.error(`Contract files are stale (${problems.length}):\n- ${problems.slice(0, 40).join('\n- ')}\nRun: node scripts/study-harness/generate-contracts.mjs`);
    process.exit(1);
  }
  console.log(`Contract schemas and fixtures are current (${entries.length} schemas, ${files.size - entries.length - 1} fixtures).`);
} else {
  for (const path of stale) await rm(join(packageRoot, path));
  for (const path of drift) { await mkdir(dirname(join(packageRoot, path)), { recursive: true }); await writeFile(join(packageRoot, path), files.get(path)); }
  if (!frozen) await writeFile(join(packageRoot, 'schema/frozen-1.0.json'), json(lock));
  console.log(`Wrote ${drift.length} and removed ${stale.length} of ${files.size} generated files${frozen ? '' : ', and the 1.0 digest lock'} in ${relative(process.cwd(), packageRoot) || '.'}.`);
}
