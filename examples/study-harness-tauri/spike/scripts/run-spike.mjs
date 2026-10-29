#!/usr/bin/env node
// Reproducible W12 native feasibility spike runner (macOS). ARCHIVED with the spike sources in
// examples/study-harness-tauri/spike/ (see spike/README.md): it targets the spike's own src-tauri layout and no longer
// runs against the reference host. Its original invocation, from the directory that then held the spike, was:
//
//   node scripts/run-spike.mjs [--rebuild | --no-build] [--timeout 60] [--evidence <path> | --no-evidence]
//
// 1. Builds the packaged .app with `tauri build --bundles app --no-sign` when it is missing or
//    older than any source input (no signing identity, no notarization, nothing published).
// 2. Scans the bundled frontend for remote URL references.
// 3. Launches the binary inside the .app with SH_SPIKE_OUT set, waits (bounded; SIGTERM then
//    SIGKILL after the timeout) and collects the report written by the `spike_report` command.
// 4. Writes machine-readable evidence (host, toolchain, versions, binary identity, effective CSP,
//    per-probe results, permission rejection) with the home directory redacted.
import { execFile, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageRoot, '../..');
const tauriDir = path.join(packageRoot, 'src-tauri');
const bundleDir = path.join(tauriDir, 'target/release/bundle/macos');
const distDir = path.join(packageRoot, 'dist');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const timeoutSeconds = Number(option('--timeout', '60'));
const evidencePath = flag('--no-evidence') ? null : path.resolve(option('--evidence', path.join(repoRoot, 'docs/study-harness/evidence/native-spike.json')));

const REQUIRED_PASS = [
  'module-worker',
  'worker-dynamic-import',
  'web-crypto-main',
  'web-crypto-worker',
  'local-data-fetch',
  'local-font',
  'katex-dom',
  'katex-fonts',
  'svg-render',
  'png-capture-svg',
  'png-capture-katex-canvas',
  'resource-origins',
  'csp-effective',
];
const REQUIRED_BLOCK = [
  'eval-negative',
  'worker-csp',
  'inline-style-attr-negative',
  'blob-worker-negative',
  'png-data-url-negative',
  'remote-connect-negative',
  'command-forbidden-rejected',
  'plugin-command-rejected',
  'report-validation-rejects-unknown-key',
  'report-validation-rejects-oversized',
];
const ALLOWED_URL_REFERENCES = [
  { pattern: /^http:\/\/www\.w3\.org\//, reason: 'XML namespace identifier (never fetched)' },
  { pattern: /^https:\/\/remote\.invalid\//, reason: 'deliberate CSP negative probe / untrusted-TeX fixture (RFC 6761 reserved name)' },
  { pattern: /^http:\/\/ipc\.localhost$/, reason: 'Tauri IPC origin listed in the probe allowlist' },
];

const home = homedir();
const redact = (value) => {
  if (typeof value === 'string') return value.split(home).join('~');
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
  return value;
};

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options });
  return { status: result.status, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim(), error: result.error?.message ?? null };
}

const sha256File = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

function walk(directory, files = []) {
  if (!existsSync(directory)) return files;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function sourceInputs() {
  const files = ['index.html', 'vite.config.mjs', 'package.json', 'package-lock.json', 'tsconfig.json'].map((file) => path.join(packageRoot, file));
  files.push(...walk(path.join(packageRoot, 'src')), ...walk(path.join(packageRoot, 'public')));
  for (const file of ['Cargo.toml', 'Cargo.lock', 'build.rs', 'tauri.conf.json']) files.push(path.join(tauriDir, file));
  files.push(...walk(path.join(tauriDir, 'src')), ...walk(path.join(tauriDir, 'capabilities')), ...walk(path.join(tauriDir, 'icons')));
  return files.filter((file) => existsSync(file));
}

function findApp() {
  if (!existsSync(bundleDir)) return null;
  const app = readdirSync(bundleDir).find((name) => name.endsWith('.app'));
  if (!app) return null;
  const appPath = path.join(bundleDir, app);
  const macosDir = path.join(appPath, 'Contents/MacOS');
  const executable = existsSync(macosDir) ? readdirSync(macosDir).find((name) => !name.startsWith('.')) : undefined;
  return executable ? { appPath, executable: path.join(macosDir, executable) } : null;
}

function sanitizedBuildEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(APPLE_|TAURI_SIGNING_|CODESIGN_)/.test(key)) delete env[key];
  }
  return env;
}

function buildIfNeeded() {
  const existing = findApp();
  const newestInput = Math.max(...sourceInputs().map((file) => statSync(file).mtimeMs));
  const stale = !existing || statSync(existing.executable).mtimeMs < newestInput;
  if (flag('--no-build')) {
    if (!existing) throw new Error('No packaged app found and --no-build was given.');
    return { invoked: false, reason: stale ? 'skipped by --no-build (inputs newer than binary)' : 'skipped by --no-build' };
  }
  if (!flag('--rebuild') && !stale) return { invoked: false, reason: 'packaged binary is newer than every source input' };
  const command = ['tauri', 'build', '--bundles', 'app', '--no-sign'];
  console.log(`[spike] building: npx ${command.join(' ')}`);
  const started = Date.now();
  const result = spawnSync('npx', command, { cwd: packageRoot, stdio: 'inherit', env: sanitizedBuildEnv() });
  if (result.status !== 0) throw new Error(`tauri build failed with status ${result.status}`);
  return { invoked: true, reason: flag('--rebuild') ? '--rebuild' : existing ? 'inputs newer than binary' : 'no packaged app', command: `npx ${command.join(' ')}`, durationMs: Date.now() - started };
}

function scanDist() {
  const references = new Map();
  for (const file of walk(distDir)) {
    if (!/\.(?:js|mjs|css|html|json)$/.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/https?:\/\/[A-Za-z0-9._~:/?#@!$&'*+,;=%-]+/g)) {
      const url = match[0].replace(/[`'",;)]+$/, '');
      const key = url;
      const entry = references.get(key) ?? { url, files: new Set() };
      entry.files.add(path.relative(packageRoot, file));
      references.set(key, entry);
    }
  }
  const classified = [...references.values()].map(({ url, files }) => {
    const allowed = ALLOWED_URL_REFERENCES.find(({ pattern }) => pattern.test(url));
    return { url, files: [...files], classification: allowed ? allowed.reason : 'UNEXPECTED remote reference' };
  });
  return { filesScanned: walk(distDir).length, references: classified, unexpected: classified.filter((item) => item.classification.startsWith('UNEXPECTED')) };
}

function plistJson(file) {
  const result = run('plutil', ['-convert', 'json', '-o', '-', file]);
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function cargoLockVersions() {
  const lock = readFileSync(path.join(tauriDir, 'Cargo.lock'), 'utf8');
  const wanted = new Set(['tauri', 'tauri-build', 'tauri-codegen', 'tauri-macros', 'tauri-runtime', 'tauri-runtime-wry', 'tauri-utils', 'wry', 'tao', 'serde', 'serde_json', 'objc2-web-kit']);
  const versions = {};
  for (const block of lock.split('[[package]]')) {
    const name = block.match(/^name = "([^"]+)"/m)?.[1];
    const version = block.match(/^version = "([^"]+)"/m)?.[1];
    if (name && version && wanted.has(name)) versions[name] = versions[name] ? `${versions[name]}, ${version}` : version;
  }
  return versions;
}

function npmVersions() {
  const read = (name) => {
    const file = path.join(packageRoot, 'node_modules', name, 'package.json');
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).version : null;
  };
  return {
    '@tauri-apps/cli': read('@tauri-apps/cli'),
    '@tauri-apps/api': read('@tauri-apps/api'),
    vite: read('vite'),
    typescript: read('typescript'),
    katex: read('katex'),
  };
}

function hostInfo() {
  const sw = run('sw_vers', []);
  const field = (name) => sw.stdout.match(new RegExp(`${name}:\\s*(.+)`))?.[1]?.trim() ?? null;
  const sysctl = (name) => run('sysctl', ['-n', name]).stdout || null;
  const memsize = Number(sysctl('hw.memsize'));
  const safari = plistJson('/Applications/Safari.app/Contents/Info.plist');
  const webkit = plistJson('/System/Library/Frameworks/WebKit.framework/Versions/A/Resources/Info.plist');
  return {
    macOS: { productName: field('ProductName'), productVersion: field('ProductVersion'), buildVersion: field('BuildVersion'), darwin: run('uname', ['-r']).stdout },
    hardware: { model: sysctl('hw.model'), cpu: sysctl('machdep.cpu.brand_string'), logicalCpus: Number(sysctl('hw.ncpu')), memoryBytes: Number.isFinite(memsize) ? memsize : null, arch: run('uname', ['-m']).stdout },
    systemWebKit: {
      safariShortVersion: safari?.CFBundleShortVersionString ?? null,
      safariBundleVersion: safari?.CFBundleVersion ?? null,
      webKitFrameworkVersion: webkit?.CFBundleVersion ?? null,
    },
  };
}

function toolchain() {
  const xcode = run('xcodebuild', ['-version']);
  return {
    rustc: run('rustc', ['-V']).stdout,
    cargo: run('cargo', ['-V']).stdout,
    node: process.version,
    npm: run('npm', ['-v']).stdout,
    xcode: xcode.status === 0 ? xcode.stdout.replace(/\n/g, '; ') : null,
  };
}

function codesignInfo(appPath) {
  const display = run('codesign', ['-dv', '--verbose=2', appPath]);
  const text = `${display.stdout}\n${display.stderr}`;
  const pick = (name) => text.match(new RegExp(`^${name}=(.+)$`, 'm'))?.[1]?.trim() ?? null;
  const verify = run('codesign', ['--verify', '--strict', '--verbose=1', appPath]);
  return {
    signature: pick('Signature'),
    identifier: pick('Identifier'),
    format: pick('Format'),
    teamIdentifier: pick('TeamIdentifier'),
    flags: text.match(/flags=(0x[0-9a-f]+\([^)]*\))/)?.[1] ?? null,
    verifyStrictStatus: verify.status,
    verifyOutput: `${verify.stdout}\n${verify.stderr}`.trim().split('\n').slice(-3).join(' | '),
  };
}

async function launch(executable) {
  const outDir = mkdtempSync(path.join(tmpdir(), 'sh-native-spike-'));
  const outFile = path.join(outDir, 'native-spike-report.json');
  const started = Date.now();
  const child = spawn(executable, [], { env: { ...process.env, SH_SPIKE_OUT: outFile }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const collect = (chunk) => {
    output = (output + chunk.toString()).slice(-8000);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  // Sample the app process's own sockets while it runs: a bundled local HTTP server would show up
  // here as a LISTEN socket. (WebKit's networking runs in separate XPC processes, not sampled.)
  const sockets = new Set();
  let socketSamples = 0;
  const sampler = setInterval(() => {
    execFile('lsof', ['-a', '-n', '-P', '-p', String(child.pid), '-i'], { timeout: 2000 }, (_error, stdout) => {
      socketSamples += 1;
      for (const line of String(stdout ?? '').split('\n').slice(1)) if (line.trim()) sockets.add(line.trim().replace(/\s+/g, ' '));
    });
  }, 150);
  let timedOut = false;
  const term = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 3000).unref();
  }, timeoutSeconds * 1000);
  const { code, signal } = await new Promise((resolve) => child.on('exit', (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal })));
  clearTimeout(term);
  clearInterval(sampler);
  const socketLines = [...sockets];
  const report = existsSync(outFile) ? JSON.parse(readFileSync(outFile, 'utf8')) : null;
  return {
    outFile,
    report,
    run: {
      exitCode: code,
      signal,
      timedOut,
      elapsedMs: Date.now() - started,
      timeoutSeconds,
      outputTail: output.split('\n').slice(-20).join('\n'),
      processSockets: { samples: socketSamples, sockets: socketLines, listening: socketLines.filter((line) => /LISTEN/.test(line)) },
    },
  };
}

function verdict(report, run, scan, native) {
  const probes = new Map((report?.frontend?.probes ?? []).map((probe) => [probe.id, probe]));
  const problems = [];
  if (!report?.frontend) problems.push('no frontend report collected');
  for (const id of REQUIRED_PASS) if (probes.get(id)?.status !== 'pass') problems.push(`${id}: expected pass, got ${probes.get(id)?.status ?? 'missing'}`);
  for (const id of REQUIRED_BLOCK) if (probes.get(id)?.status !== 'expected-block') problems.push(`${id}: expected expected-block, got ${probes.get(id)?.status ?? 'missing'}`);
  for (const probe of probes.values()) if (probe.status === 'unexpected-allow' && !REQUIRED_BLOCK.includes(probe.id)) problems.push(`${probe.id}: unexpected-allow (diagnostic)`);
  if (native?.forbiddenCommandExecuted !== false) problems.push('spike_forbidden executed or state unknown');
  if (scan.unexpected.length) problems.push(`unexpected remote references in dist: ${scan.unexpected.map((item) => item.url).join(', ')}`);
  if (run.processSockets.listening.length) problems.push(`app process listened on sockets: ${run.processSockets.listening.join(' | ')}`);
  if (run.processSockets.samples === 0) problems.push('no socket samples were taken while the app ran');
  if (run.exitCode !== 0 || run.timedOut) problems.push(`app exit code ${run.exitCode} signal ${run.signal} timedOut=${run.timedOut}`);
  const required = [...REQUIRED_PASS, ...REQUIRED_BLOCK];
  return {
    overall: problems.length === 0 ? 'pass' : 'fail',
    requiredChecks: required.length,
    requiredSatisfied: required.filter((id) => probes.get(id)?.status === (REQUIRED_PASS.includes(id) ? 'pass' : 'expected-block')).length,
    problems,
    diagnosticProbes: [...probes.values()].filter((probe) => !required.includes(probe.id)).map((probe) => `${probe.id}: ${probe.status}`),
  };
}

const build = buildIfNeeded();
const app = findApp();
if (!app) throw new Error('Packaged app not found after build.');
const scan = scanDist();
const plist = plistJson(path.join(app.appPath, 'Contents/Info.plist'));
const { outFile, report, run: launchRun } = await launch(app.executable);
const native = report?.native ?? null;
const appDataCopy = native?.appDataReportPath && existsSync(native.appDataReportPath) ? native.appDataReportPath : null;
const config = JSON.parse(readFileSync(path.join(tauriDir, 'tauri.conf.json'), 'utf8'));
const capability = JSON.parse(readFileSync(path.join(tauriDir, 'capabilities/main-window.json'), 'utf8'));
const frontend = report?.frontend ?? null;
const captureFiles = [];
if (frontend?.captures?.length) {
  const captureDir = evidencePath ? path.join(path.dirname(evidencePath), 'native-spike-captures') : mkdtempSync(path.join(tmpdir(), 'sh-native-spike-captures-'));
  mkdirSync(captureDir, { recursive: true });
  for (const capture of frontend.captures) {
    const bytes = Buffer.from(capture.base64, 'base64');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const pngSignature = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const safeName = capture.probeId.replace(/[^a-z0-9-]/g, '');
    const file = path.join(captureDir, `${safeName}.png`);
    if (pngSignature) writeFileSync(file, bytes);
    captureFiles.push({ probeId: capture.probeId, file: pngSignature ? path.relative(repoRoot, file) : null, width: capture.width, height: capture.height, bytes: bytes.length, sha256, reportedSha256: capture.sha256, hashVerified: sha256 === capture.sha256, pngSignature });
  }
  delete frontend.captures;
}
const probeById = (id) => frontend?.probes?.find((probe) => probe.id === id) ?? null;
const ua = frontend?.userAgent ?? null;

const evidence = redact({
  schema: 'study-harness.native-spike.evidence/1',
  generatedAt: new Date().toISOString(),
  generator: 'examples/study-harness-tauri/spike/scripts/run-spike.mjs',
  scope: 'W12 early native feasibility spike on one macOS machine. Not a support claim for other OS versions, Windows or Linux.',
  verdict: verdict(report, launchRun, scan, native),
  host: hostInfo(),
  toolchain: toolchain(),
  versions: { cargoLock: cargoLockVersions(), npm: npmVersions() },
  app: {
    bundle: path.relative(repoRoot, app.appPath),
    executable: path.relative(repoRoot, app.executable),
    executableSha256: sha256File(app.executable),
    executableBytes: statSync(app.executable).size,
    infoPlistSha256: sha256File(path.join(app.appPath, 'Contents/Info.plist')),
    bundleIdentifier: plist?.CFBundleIdentifier ?? null,
    bundleVersion: plist?.CFBundleVersion ?? null,
    minimumSystemVersion: plist?.LSMinimumSystemVersion ?? null,
    codesign: codesignInfo(app.appPath),
    build,
    devUrlConfigured: Boolean(config.build?.devUrl),
    frontendDist: config.build?.frontendDist ?? null,
  },
  webview: {
    userAgent: ua,
    appleWebKitToken: ua?.match(/AppleWebKit\/([\d.]+)/)?.[1] ?? null,
    nativeWebviewVersion: native?.webviewVersion ?? null,
    origin: frontend?.origin ?? null,
    isSecureContext: frontend?.isSecureContext ?? null,
  },
  csp: {
    configured: config.app?.security?.csp ?? null,
    nativeConfiguredCsp: native?.configuredCsp ?? null,
    workerScriptCsp: native?.workerScriptCsp ?? null,
    workerScriptCspMechanism: 'on_web_resource_request hook adds this header to bundled JavaScript responses that carry no CSP; Tauri itself attaches the configured CSP only to HTML responses.',
    tauriAddedScriptHashes: 'Tauri appends one sha256 source per bundled .js/.mjs file in frontendDist to script-src; the hash list changes with every frontend build.',
    directiveOrder: 'Tauri serializes the policy from a hash map, so directive order in the header differs from the configured string and between runs.',
    effectiveHeader: frontend?.csp?.header ?? null,
    meta: frontend?.csp?.meta ?? null,
    violationPolicies: frontend?.csp?.violationPolicies ?? [],
    freezePrototype: config.app?.security?.freezePrototype ?? null,
    dangerousDisableAssetCspModification: config.app?.security?.dangerousDisableAssetCspModification ?? null,
  },
  permissions: {
    appManifestCommands: ['spike_report'],
    registeredCommands: ['spike_report', 'spike_forbidden'],
    capability,
    forbiddenCommand: probeById('command-forbidden-rejected'),
    pluginCommand: probeById('plugin-command-rejected'),
    forbiddenCommandExecutedNative: native?.forbiddenCommandExecuted ?? null,
    validationUnknownKey: probeById('report-validation-rejects-unknown-key'),
    validationOversized: probeById('report-validation-rejects-oversized'),
    rejectedReportsBeforeAcceptance: native?.rejectedReportsBeforeAcceptance ?? null,
  },
  network: {
    staticDistScan: scan,
    runtimeResourceOrigins: frontend?.resourceOrigins ?? [],
    runtimeRequestLog: frontend?.requestLog ?? [],
    note: 'The only remote-origin request issued is the deliberate remote-connect-negative probe to https://remote.invalid/ (reserved name), which CSP connect-src blocks before any network activity.',
  },
  captures: captureFiles,
  probes: frontend?.probes ?? [],
  violations: frontend?.violations ?? [],
  run: { ...launchRun, reportCollected: Boolean(report), appDataCopyPresent: Boolean(appDataCopy), appDataCopyMatchesSpikeOut: appDataCopy ? sha256File(appDataCopy) === sha256File(outFile) : false },
  native,
  watchdog: report?.watchdog ?? null,
});

if (evidencePath) {
  mkdirSync(path.dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`[spike] evidence written to ${path.relative(process.cwd(), evidencePath)}`);
}
console.log(`[spike] ${evidence.verdict.overall.toUpperCase()}: ${evidence.verdict.requiredSatisfied}/${evidence.verdict.requiredChecks} required checks`);
for (const problem of evidence.verdict.problems) console.log(`  - ${problem}`);
for (const probe of evidence.probes) console.log(`  ${probe.status.padEnd(16)} ${probe.id}: ${probe.summary}`);
process.exitCode = evidence.verdict.overall === 'pass' ? 0 : 1;
