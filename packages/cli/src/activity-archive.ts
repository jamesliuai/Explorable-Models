/**
 * `experiment-kit activity package <dir>`: validates the package, then writes a reproducible archive (zip or tgz) of
 * exactly the authoring files, with an integrity manifest (`package-manifest.json`) listing every file's byte length and
 * sha256 and the definition identities (template digest, model digest and scientific revision, reference-suite
 * digest, authored-source digests). Identical inputs produce identical archive bytes: sorted entries, fixed
 * timestamps and modes, no host metadata. The manifest states lifecycle `authored`; packaging is not review.
 */
import { gzipSync, zipSync } from 'fflate';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { CliError } from './files.js';
import { listPackageFiles, sha256File, stableJSON } from './activity-files.js';
import type { ActivityPackage } from './activity-files.js';
import type { ValidationOutcome } from './activity-validation.js';

export const PACKAGE_MANIFEST_CONTRACT = 'experiment-kit.activity-package' as const;
/** Files the archive may carry (relative paths); authored sources reached by kernel.ts/checks.ts are added explicitly. */
const INCLUDED = /^(model\.json|template\.json|authoring\.json|copy\.md|kernel\.ts|checks\.ts|fixtures\/[A-Za-z0-9._-]+\.json|review\/[A-Za-z0-9._/-]+\.(md|json|png|svg|txt))$/;

export interface ArchiveFile { path: string; bytes: number; sha256: string }
export interface PackageManifest {
  contract: typeof PACKAGE_MANIFEST_CONTRACT;
  version: '1.0';
  lifecycle: 'authored';
  template: ValidationOutcome['template'];
  model: ValidationOutcome['model'];
  scientificRevision: string | null;
  presentationRevision: string | null;
  relation: ValidationOutcome['relation'];
  execution: ValidationOutcome['execution'];
  referenceSuite: ValidationOutcome['referenceSuite'];
  authoredSources: { kernel: ArchiveFile[]; checks: ArchiveFile[] };
  toolkitVersion: string;
  files: ArchiveFile[];
}

/** USTAR archive with fixed owner, mode and timestamp. */
function tar(entries: { name: string; data: Uint8Array }[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  const encoder = new TextEncoder();
  const field = (header: Uint8Array, offset: number, length: number, value: string) => header.set(encoder.encode(value).subarray(0, length), offset);
  const octal = (value: number, length: number) => `${value.toString(8).padStart(length - 1, '0')}\0`;
  for (const entry of entries) {
    const header = new Uint8Array(512);
    let name = entry.name, prefix = '';
    if (encoder.encode(name).length > 100) {
      const size = (text: string) => encoder.encode(text).length;
      const slashes = [...entry.name.matchAll(/\//g)].map(match => match.index!).reverse();
      const cut = slashes.find(index => size(entry.name.slice(index + 1)) <= 100 && size(entry.name.slice(0, index)) <= 155);
      if (cut === undefined) throw new CliError('RESOURCE_LIMIT', `Path too long for the archive: ${entry.name}`);
      prefix = entry.name.slice(0, cut); name = entry.name.slice(cut + 1);
    }
    field(header, 0, 100, name);
    field(header, 100, 8, octal(0o644, 8));
    field(header, 108, 8, octal(0, 8));
    field(header, 116, 8, octal(0, 8));
    field(header, 124, 12, octal(entry.data.length, 12));
    field(header, 136, 12, octal(0, 12));
    field(header, 148, 8, '        ');
    field(header, 156, 1, '0');
    field(header, 257, 6, 'ustar\0');
    field(header, 263, 2, '00');
    field(header, 345, 155, prefix);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    field(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
    blocks.push(header, entry.data);
    const pad = (512 - (entry.data.length % 512)) % 512;
    if (pad) blocks.push(new Uint8Array(pad));
  }
  blocks.push(new Uint8Array(1024));
  const total = blocks.reduce((sum, block) => sum + block.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) { out.set(block, offset); offset += block.length; }
  return out;
}

export interface ArchiveResult { archive: string; format: 'zip' | 'tgz'; sha256: string; bytes: number; manifest: PackageManifest; manifestDigest: string; excluded: string[] }

export async function packageActivity(pkg: ActivityPackage, validation: ValidationOutcome, options: { out: string; format: 'zip' | 'tgz'; toolkitVersion: string }): Promise<{ bytes: Uint8Array; result: Omit<ArchiveResult, 'archive'> }> {
  if (!validation.ok || !validation.template || !validation.model) throw new CliError('VALIDATION_FAILED', 'The package does not validate; nothing was packaged.', 'Run experiment-kit activity validate and fix every error first.');
  const authored = new Set([...Object.keys(pkg.authored.kernel?.files ?? {}), ...Object.keys(pkg.authored.checks?.files ?? {})]);
  const listed = await listPackageFiles(pkg.root);
  const included = listed.filter(file => INCLUDED.test(file) || authored.has(file));
  const excluded = listed.filter(file => !included.includes(file));
  const contents = new Map<string, Uint8Array>();
  for (const file of included) contents.set(file, new Uint8Array(await readFile(path.join(pkg.root, file))));
  const describe = (file: string): ArchiveFile => ({ path: file, bytes: contents.get(file)!.length, sha256: sha256File(contents.get(file)!) });
  const manifest: PackageManifest = {
    contract: PACKAGE_MANIFEST_CONTRACT, version: '1.0', lifecycle: 'authored', template: validation.template, model: validation.model,
    scientificRevision: validation.modelIdentity?.scientificRevision ?? null, presentationRevision: validation.modelIdentity?.presentationRevision ?? null,
    relation: validation.relation, execution: validation.execution, referenceSuite: validation.referenceSuite,
    authoredSources: { kernel: Object.keys(pkg.authored.kernel?.files ?? {}).sort().map(describe), checks: Object.keys(pkg.authored.checks?.files ?? {}).sort().map(describe) },
    toolkitVersion: options.toolkitVersion,
    files: included.map(describe),
  };
  // External fixtures are recorded by digest only; their bytes stay where the author keeps them.
  if (manifest.referenceSuite.fixture?.external) manifest.referenceSuite = { ...manifest.referenceSuite, fixture: { ...manifest.referenceSuite.fixture, path: path.basename(manifest.referenceSuite.fixture.path) } };
  const manifestText = stableJSON(manifest);
  const root = `${validation.template.templateId}-${validation.template.version}`;
  const entries = [{ name: `${root}/package-manifest.json`, data: new TextEncoder().encode(manifestText) }, ...included.map(file => ({ name: `${root}/${file}`, data: contents.get(file)! }))]
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  let bytes: Uint8Array;
  if (options.format === 'zip') {
    // DOS timestamps are local-time fields; a local-time Date of 1980-01-01 encodes identically in every time zone.
    const mtime = new Date(1980, 0, 1, 0, 0, 0);
    bytes = zipSync(Object.fromEntries(entries.map(entry => [entry.name, [entry.data, { mtime, os: 3, attrs: 0o644 << 16, level: 9 }]])), { mtime, os: 3, level: 9 });
  } else bytes = gzipSync(tar(entries), { level: 9, mtime: 0 });
  return { bytes, result: { format: options.format, sha256: sha256File(bytes), bytes: bytes.length, manifest, manifestDigest: sha256File(manifestText), excluded } };
}
