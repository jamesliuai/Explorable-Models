import { createRequire } from 'node:module';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// These are the packages whose code or font assets enter the static player,
// including D3's and React DOM's runtime dependencies. Build tools stay in npm.
const PLAYBACK_PACKAGES = ['@fontsource-variable/inter', 'react', 'react-dom', 'scheduler', 'three', 'katex', 'lucide-react', 'fflate', 'd3-scale', 'd3-array', 'd3-interpolate', 'd3-color', 'd3-format', 'd3-time', 'd3-time-format', 'd3-shape', 'd3-path', 'internmap'];
const require = createRequire(import.meta.url);

async function locatePackage(name: string): Promise<string> {
  let entry: string;
  try { entry = require.resolve(`${name}/package.json`); }
  catch { entry = require.resolve(name); }
  let directory = path.dirname(entry);
  while (directory !== path.dirname(directory)) {
    try {
      const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')) as { name?: string };
      if (manifest.name === name) return directory;
    } catch { /* The entry may be nested several directories below its package. */ }
    directory = path.dirname(directory);
  }
  throw new Error(`Cannot locate dependency license for ${name}.`);
}

export async function copyPlaybackLicenses(outputDirectory: string): Promise<void> {
  const directory = path.join(outputDirectory, 'licenses');
  await mkdir(directory, { recursive: true });
  const index: { name: string; version: string; license: unknown; files: string[] }[] = [];
  for (const name of PLAYBACK_PACKAGES) {
    const source = await locatePackage(name);
    const manifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8')) as { version: string; license?: unknown };
    const files = (await readdir(source, { withFileTypes: true })).filter(file => file.isFile() && /^(?:licen[cs]e|copying|notice|ofl)(?:[._-].*)?$/i.test(file.name)).map(file => file.name).sort();
    if (!files.length) throw new Error(`Missing upstream license text for ${name}.`);
    const targets: string[] = [];
    for (const file of files) {
      const target = `${name.replace(/[^a-zA-Z0-9.-]/g, '_')}-${file}`;
      await copyFile(path.join(source, file), path.join(directory, target)); targets.push(target);
    }
    index.push({ name, version: manifest.version, license: manifest.license, files: targets });
  }
  await writeFile(path.join(directory, 'index.json'), `${JSON.stringify({ schemaVersion: '1.0', packages: index }, null, 2)}\n`);
}
