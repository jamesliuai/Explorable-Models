import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { sha256, verifyInventory, verifySiteArchive } from '../../scripts/artifact-integrity.mjs';

test('a modified deliverable cannot reuse a passing candidate inventory', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'preview-integrity-test-'));
  try {
    const original = Buffer.from('accepted candidate');
    await writeFile(path.join(directory, 'candidate.tgz'), original);
    await writeFile(path.join(directory, 'preview-manifest.json'), JSON.stringify({ version: 'preview', files: [{ file: 'candidate.tgz', bytes: original.length, sha256: sha256(original) }] }));
    await verifyInventory(directory);
    await writeFile(path.join(directory, 'candidate.tgz'), 'changed candidate');
    await assert.rejects(verifyInventory(directory), /integrity mismatch/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function site(extra = {}) {
  const files = Object.fromEntries(['index.html', 'agent.html', 'gallery.html', 'guide.html', 'source-manifest.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'docs/embedding.md', 'docs/public-preview-handoff.md'].map(name => [name, strToU8('fixture')]));
  const assets = Object.entries(files).map(([name, data]) => ({ path: name, bytes: data.length, sha256: `sha256:${sha256(data)}` }));
  files['bundle-manifest.json'] = strToU8(JSON.stringify({ assets }));
  return zipSync({ ...files, ...extra });
}

test('a complete declared site passes integrity verification', () => {
  assert.equal(Object.keys(verifySiteArchive(site()).files).length, 10);
});
test('an extra local credential file is rejected even if it is not in the asset manifest', () => {
  assert.throws(() => verifySiteArchive(site({ 'source/.env': strToU8('not an actual secret') })), /Private\/local path/);
});
test('a traversal path cannot be extracted from a preview archive', () => {
  assert.throws(() => verifySiteArchive(site({ '../outside': strToU8('bad') })), /Unsafe artifact path/);
});
test('an unmanifested public file is rejected', () => {
  assert.throws(() => verifySiteArchive(site({ 'extra.txt': strToU8('unreviewed addition') })), /Undeclared static asset/);
});
