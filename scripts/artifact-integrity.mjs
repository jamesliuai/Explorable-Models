import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function safePath(name) {
  if (!name || name.startsWith('/') || name.includes('\\') || name.includes(':') || name.includes('\0') || name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`Unsafe artifact path: ${name}`);
  if (/(?:^|\/)(?:\.env(?:\.|$)|\.npmrc$|\.git(?:\/|$)|\.codex(?:\/|$)|node_modules(?:\/|$)|\.explorable-models-session\.json$|local-bridge\.js$)|\.(?:pem|key)$/i.test(name)) throw new Error(`Private/local path in artifact: ${name}`);
}

export async function verifyInventory(directory) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'preview-manifest.json'), 'utf8'));
  if (!manifest.version || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Missing preview inventory.');
  const seen = new Set();
  for (const item of manifest.files) {
    safePath(item.file);
    if (item.file.includes('/') || seen.has(item.file)) throw new Error(`Duplicate or nested deliverable: ${item.file}`);
    seen.add(item.file);
    const file = path.join(directory, item.file);
    if (!(await lstat(file)).isFile()) throw new Error(`Deliverable must be a regular file: ${item.file}`);
    const bytes = await readFile(file);
    if (bytes.length !== item.bytes || sha256(bytes) !== item.sha256) throw new Error(`Deliverable integrity mismatch: ${item.file}`);
  }
  return manifest;
}

export function verifySiteArchive(bytes) {
  const files = unzipSync(bytes);
  for (const name of Object.keys(files)) safePath(name);
  for (const name of ['index.html', 'agent.html', 'gallery.html', 'guide.html', 'bundle-manifest.json', 'source-manifest.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'docs/embedding.md', 'docs/public-preview-handoff.md']) {
    if (!files[name]) throw new Error(`Missing public site file: ${name}`);
  }
  const manifest = JSON.parse(new TextDecoder().decode(files['bundle-manifest.json']));
  const seen = new Set(['bundle-manifest.json']);
  if (!Array.isArray(manifest.assets)) throw new Error('Missing static asset inventory.');
  for (const asset of manifest.assets) {
    safePath(asset.path);
    if (seen.has(asset.path)) throw new Error(`Duplicate asset: ${asset.path}`);
    seen.add(asset.path);
    const data = files[asset.path];
    if (!data || data.length !== asset.bytes || `sha256:${sha256(data)}` !== asset.sha256) throw new Error(`Static asset integrity mismatch: ${asset.path}`);
  }
  for (const name of Object.keys(files)) if (!seen.has(name)) throw new Error(`Undeclared static asset: ${name}`);
  return { files, manifest };
}
