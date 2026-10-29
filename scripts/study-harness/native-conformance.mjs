#!/usr/bin/env node
// Thin wrapper: runs the packaged reference host's conformance runner from the repository root (npm run test:native).
//
//   node scripts/study-harness/native-conformance.mjs [--install | --install-existing] [conformance.mjs options…]
//
// --install           first packs core, activity, catalog, player and player-3d (scripts/study-harness/pack.mjs --only=…,
//                     which replaces release/study-harness/packages with that partial pack) and installs the tarballs
//                     (and the pinned `three` peer of player-3d) into the reference host
//                     (examples/study-harness-tauri/scripts/install-packed.mjs --pack).
// --install-existing  installs the tarballs of the EXISTING pack in release/study-harness/packages without re-packing
//                     (install-packed.mjs checks every sha256 against that manifest). The release pipeline uses this so
//                     the packaged host runs exactly the tarballs every other gate verified.
// Every other argument is passed to examples/study-harness-tauri/scripts/conformance.mjs (macOS only; see its README),
// for example:
//   --no-build, --only=release,offline,restart,crash,restore,hostport-kit,templates, --timeout=150, --keep, --no-evidence,
//   --evidence-dir=<dir>
//   --display-only  re-runs only the display-dependent scenario chains (offline, restart, crash:*, templates) against the ALREADY
//                   BUILT apps and merges their results into the existing evidence; it refuses unless both executables
//                   match the sha256 recorded in that evidence, the reference host sources are still those the apps
//                   were built from (build-record.mjs) and the macOS console session is unlocked.
// Display-dependent checks that cannot run (window hidden, console locked) are recorded as "not run (environment)",
// never as passed. Each run also appends a compact record to <evidence dir>/history/.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const app = path.join(root, 'examples/study-harness-tauri');
const args = process.argv.slice(2);
if (process.platform !== 'darwin') {
  console.error('The packaged reference host conformance run is evidenced on macOS only (A53); run it on the target platform.');
  process.exit(2);
}
if (args.includes('--install') && args.includes('--install-existing')) {
  console.error('Use either --install (re-pack the five packages the host installs) or --install-existing (use the existing pack), not both.');
  process.exit(2);
}
const step = (script, scriptArgs) => {
  const result = spawnSync(process.execPath, [path.join(app, 'scripts', script), ...scriptArgs], { cwd: app, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
};
if (args.includes('--install')) step('install-packed.mjs', ['--pack']);
if (args.includes('--install-existing')) step('install-packed.mjs', []);
step('conformance.mjs', args.filter(argument => argument !== '--install' && argument !== '--install-existing'));
