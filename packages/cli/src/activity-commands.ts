/**
 * `experiment-kit activity <command>`: the Study Harness authoring workflow (report §15.2, A56). Node reads, validates
 * and packages data; every authored kernel and check runs only in browser module workers (activity-bundle.ts). Reports
 * are JSON on stdout; a failed command sets exit code 1. Outputs that replace earlier ones (captures, packets, the
 * last-good candidate record) are written to a staging directory and swapped in only after the run completed.
 */
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CliError } from './files.js';
import { readActivityPackage, replaceDirectory, sha256File, stableJSON, writeText, type ActivityPackage } from './activity-files.js';
import { BundleError, buildBundle, type BuiltBundle, type ExecutionSource } from './activity-bundle.js';
import { ActivityBrowser } from './activity-browser.js';
import { INSTALLED_FIXTURE_DIRECTORY, TOOLKIT_ROOT, loadToolkit, toolkitVersion } from './activity-loader.js';
import { scaffoldActivity } from './activity-scaffold.js';
import { packageActivity } from './activity-archive.js';
import { packetData, packetMarkdown, type BoundaryRun, type CheckRun, type MutationRun, type PacketInput, type ReferenceRun, type StageCapture } from './activity-packet.js';
import { loopbackHost, readPolicyFile, startActivityPreview } from './activity-preview.js';
import type { ActivityTemplate, HostPolicy } from '@experiment-kit/activity';
import type { ModelManifest } from '@experiment-kit/core/model';
import type { AuthorDiagnostic, ValidationOutcome } from './activity-validation.js';
import type { BoundaryCase, ReferenceSuite } from './activity-fixtures.js';

export const ACTIVITY_HELP = `Activity authoring (Study Harness templates; authored code runs only in browser workers)

Usage: experiment-kit activity <command> <directory> [options]

  scaffold <dir>        New authoring package (example), or --from <installedTemplateId> for an
                        exploratory copy with a new template ID and lifecycle "authored"
  validate <dir>        Schemas, semantics, manifest, scenario constraints, import allowlist and
                        relation to the installed catalogue (data only; no code runs)
  check <dir>           Bundle kernel.ts/checks.ts with the import allowlist and evaluate defaults,
                        scenarios and author checks in browser workers; keeps the last good candidate
  reference <dir>       Run reference fixtures (fixtures/reference.json or --fixtures <path>) in the
                        worker with declared tolerances; per-case results with provenance
  boundaries <dir>      Declared boundary cases and generated domain probes:
                        valid / undefined / numerical-limit / out-of-domain
  capture <dir>         Mount the learner surface per stage: PNG, SVG and companion text
                        (author-preview policy, or a learner policy with --policy <file>)
  preview <dir>         Serve the author view and the learner view side by side on
                        127.0.0.1 with a stage selector and diagnostics (Ctrl-C stops);
                        also preview --installed <templateId>
  review-packet <dir>   Subject-review packet (README.md + packet.json + captures); also
                        review-packet --installed <templateId> --out <dir>
  package <dir>         Validate, then write a reproducible zip/tgz with an integrity manifest

Options:
  --from <templateId>   scaffold: installed template to copy
  --id <templateId>     scaffold: new template ID (default: directory name)
  --kernel copy|installed  scaffold --from: copy the kernel source (default) or reference it
  --fixtures <path>     reference/validate/review-packet: external reference fixtures
  --stage <id>          capture: one stage (default: --all-stages); preview: stage to open
  --all-stages          capture: every stage
  --width <px>          capture card width, 320–1600 (default 720)
  --theme <mode>        light (default), dark or system
  --fonts <mode>        bundled (default) or system
  --index <n>           capture: show iteration n where a stage allows navigation
  --policy <file>       capture/preview: study-harness.host-policy JSON for the learner view
                        (preview default: the derived learner policy, see authoring.md)
  --port <n>            preview: port on 127.0.0.1 (default: an available port)
  --host 127.0.0.1      preview: only the loopback address is accepted
  --no-open             preview: print the URL without opening a browser
  --installed <id>      review-packet/preview: an installed template instead of a directory
  --format zip|tgz      package archive format (default zip)
  --out <path>          output directory/archive, or report JSON for validate/check/reference/boundaries
  --timeout <ms>        worker timeout per evaluation (default 5000)

Lifecycle is reported as "authored": validation, reference agreement and packets are engineering
evidence, not subject review. Only a host-trusted review record can approve a template.
`;

type Values = Record<string, string | boolean | undefined>;
const text = (values: Values, name: string): string | undefined => typeof values[name] === 'string' ? values[name] as string : undefined;
function integer(values: Values, name: string, fallback: number, min: number, max: number): number {
  const raw = text(values, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new CliError('INVALID_PARAMETER', `--${name} must be an integer from ${min} to ${max}.`);
  return value;
}
function choice<T extends string>(values: Values, name: string, options: readonly T[], fallback: T): T {
  const raw = text(values, name) ?? fallback;
  if (!(options as readonly string[]).includes(raw)) throw new CliError('INVALID_PARAMETER', `--${name} must be one of ${options.join(', ')}.`);
  return raw as T;
}
async function emit(report: Record<string, unknown>, ok: boolean, out?: string): Promise<void> {
  if (out) await writeText(path.resolve(out), stableJSON(report));
  process.stdout.write(stableJSON(report));
  if (!ok) process.exitCode = 1;
}

interface Loaded { pkg: ActivityPackage; validation: ValidationOutcome; manifest: ModelManifest | null; template: ActivityTemplate | null }
async function load(directory: string, fixtures?: string): Promise<Loaded> {
  const pkg = await readActivityPackage(directory, { fixturesPath: fixtures });
  const tk = await loadToolkit();
  const validation = tk.validatePackage(pkg.snapshot);
  const parse = <T>(name: string): T | null => { try { return pkg.snapshot.files[name] ? JSON.parse(pkg.snapshot.files[name]!) as T : null; } catch { return null; } };
  return { pkg, validation, manifest: parse<ModelManifest>('model.json'), template: parse<ActivityTemplate>('template.json') };
}
const errors = (validation: ValidationOutcome, files?: (file: string) => boolean): AuthorDiagnostic[] =>
  validation.diagnostics.filter(item => item.severity === 'error' && (!files || files(item.file)));
const identityOf = (validation: ValidationOutcome) => ({
  template: validation.template, model: validation.model, scientificRevision: validation.modelIdentity?.scientificRevision ?? null,
  relation: validation.relation, lifecycle: validation.lifecycle, execution: validation.execution,
});
const sourceOf = (validation: ValidationOutcome): ExecutionSource => validation.execution?.source ?? 'document';

/** Opens a browser on a bundle, runs `fn`, and always closes both. */
async function withBrowser<T>(bundle: BuiltBundle, fn: (browser: ActivityBrowser) => Promise<T>): Promise<{ result: T; blockedRequests: string[]; pageErrors: string[]; browser: string }> {
  let browser: ActivityBrowser | undefined;
  try {
    browser = await ActivityBrowser.open(bundle);
    const result = await fn(browser);
    return { result, blockedRequests: [...browser.blockedRequests], pageErrors: [...browser.pageErrors], browser: `Chromium ${browser.version}` };
  } finally { await browser?.close(); await bundle.dispose(); }
}
async function bundleFor(pkg: ActivityPackage | null, validation: ValidationOutcome | null, options: { checks: boolean; capture: boolean }): Promise<BuiltBundle | { diagnostics: AuthorDiagnostic[] }> {
  try { return await buildBundle({ root: pkg?.root ?? null, source: validation ? sourceOf(validation) : 'installed-kernel', checks: options.checks, capture: options.capture }); }
  catch (error) { if (error instanceof BundleError) return { diagnostics: error.diagnostics }; throw error; }
}
/** A path for a command line shown to the user: relative below the working directory, absolute otherwise. */
const shown = (file: string): string => { const relative = path.relative(process.cwd(), file); return !relative ? '.' : relative.startsWith('..') ? file : relative; };
const scenariosOf = (template: ActivityTemplate | null) => (template?.scenarios ?? []).map(scenario => ({ id: scenario.id, params: scenario.parameters }));

// ---------------------------------------------------------------------------------------------
// Last working candidate
// ---------------------------------------------------------------------------------------------
const LAST_GOOD = '.experiment-kit/last-good';
interface LastGood { checkedAt: string; template: unknown; model: unknown; scientificRevision: string | null; kernelSourceDigest: string | null; checksSourceDigest: string | null; files: { path: string; sha256: string }[]; directory: string }
async function readLastGood(root: string): Promise<LastGood | null> {
  try { return { ...JSON.parse(await readFile(path.join(root, LAST_GOOD, 'record.json'), 'utf8')) as LastGood, directory: path.join(root, LAST_GOOD) }; } catch { return null; }
}
async function storeLastGood(pkg: ActivityPackage, record: Omit<LastGood, 'files' | 'directory'>): Promise<LastGood> {
  const target = path.join(pkg.root, LAST_GOOD);
  const staging = `${target}.staging-${process.pid}`;
  const files = { ...pkg.snapshot.files, ...pkg.authored.kernel?.files, ...pkg.authored.checks?.files };
  const list = Object.keys(files).sort().map(file => ({ path: file, sha256: sha256File(files[file]!) }));
  for (const [file, content] of Object.entries(files)) await writeText(path.join(staging, 'files', file), content);
  await writeText(path.join(staging, 'record.json'), stableJSON({ ...record, files: list }));
  await replaceDirectory(staging, target);
  return { ...record, files: list, directory: target };
}

// ---------------------------------------------------------------------------------------------
// Captures shared by `capture` and `review-packet`
// ---------------------------------------------------------------------------------------------
interface CaptureSettings { width: number; theme: 'light' | 'dark' | 'system'; fonts: 'bundled' | 'system'; index: number | null }
/** A learner-scoped capture's validated host policy and the mode it authorizes (`capture --policy`). */
interface CapturePolicy { policy: HostPolicy; mode: 'approved' | 'exploratory' }
async function captureStages(browser: ActivityBrowser, input: { template: ActivityTemplate; manifest: ModelManifest; installed: boolean; policy?: CapturePolicy }, stageIds: string[], settings: CaptureSettings, directory: string, prefix: string): Promise<StageCapture[]> {
  const out: StageCapture[] = [];
  await mkdir(directory, { recursive: true });
  for (const stageId of stageIds) {
    const stage = input.template.stages.find(item => item.id === stageId)!;
    const { result, png, pageErrors } = await browser.captureStage({ ...input, stageId, theme: settings.theme, fonts: settings.fonts, index: settings.index }, { width: settings.width });
    const base: StageCapture = {
      stageId, kind: stage.kind, instruction: stage.instruction, response: stage.response ?? null, ok: result.ok, png: null, svg: null, companion: null, svgView: null, svgError: null,
      revealed: [], revealError: null, projectionDigest: null, frameId: null, ui: null, reviewNotice: null, views: [], math: null, navigatedTo: null,
      diagnostics: [...((result.diagnostics as { code: string; message: string }[] | undefined) ?? []).map(item => ({ code: item.code, message: item.message })), ...pageErrors.map(message => ({ code: 'PAGE_ERROR', message }))],
    };
    if (!result.ok) { out.push(base); continue; }
    const projection = result.projection as { projectionDigest: string; frame: { frameId: string } | null; ui: string; reviewNotice: string; views: StageCapture['views'] };
    const svg = result.svg as { viewId: string; svg: string } | null;
    const companion = result.companion as { values: string; views: { viewId: string; text: string }[] };
    const files = { png: `${stageId}.png`, svg: `${stageId}.svg`, txt: `${stageId}.txt` };
    if (png) await writeFile(path.join(directory, files.png), png);
    if (svg) await writeFile(path.join(directory, files.svg), svg.svg);
    const lines = [
      `${input.template.title} — stage ${stage.id} (${stage.kind})`, `Instruction: ${stage.instruction}`,
      ...(stage.response ? [`Host-owned ${stage.response.kind} request: ${stage.response.prompt}`] : []),
      `Review notice: ${projection.reviewNotice}`, `Revealed by the host for this stage: ${(result.revealed as string[]).join(', ') || 'nothing'}`,
      ...(result.navigatedTo !== null ? [`Shown at iteration n = ${String(result.navigatedTo)}`] : []),
      '', 'Current values:', companion.values,
      ...companion.views.flatMap(view => ['', `View ${view.viewId}:`, view.text]),
    ];
    await writeFile(path.join(directory, files.txt), `${lines.join('\n')}\n`);
    out.push({
      ...base, png: png ? `${prefix}${files.png}` : null, svg: svg ? `${prefix}${files.svg}` : null, companion: `${prefix}${files.txt}`, svgView: svg?.viewId ?? null,
      svgError: (result.svgError as StageCapture['svgError']) ?? null, revealed: result.revealed as string[], revealError: result.revealError ?? null,
      projectionDigest: projection.projectionDigest, frameId: projection.frame?.frameId ?? null, ui: projection.ui, reviewNotice: projection.reviewNotice, views: projection.views,
      math: result.math as StageCapture['math'], navigatedTo: (result.navigatedTo as number | null) ?? null,
    });
  }
  return out;
}

function settingsOf(values: Values): CaptureSettings {
  return {
    width: integer(values, 'width', 720, 320, 1600), theme: choice(values, 'theme', ['light', 'dark', 'system'] as const, 'light'),
    fonts: choice(values, 'fonts', ['bundled', 'system'] as const, 'bundled'), index: text(values, 'index') === undefined ? null : integer(values, 'index', 0, 0, 1_000_000),
  };
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------
async function validateCommand(directory: string, values: Values) {
  const { pkg, validation } = await load(directory, text(values, 'fixtures'));
  await emit({ command: 'validate', package: pkg.root, ...validation, codeExecuted: false }, validation.ok, text(values, 'out'));
}

async function checkCommand(directory: string, values: Values) {
  const { pkg, validation, manifest, template } = await load(directory, text(values, 'fixtures'));
  const base = { command: 'check', package: pkg.root, ...identityOf(validation) };
  const lastGood = await readLastGood(pkg.root);
  const out = text(values, 'out');
  if (!validation.ok) { await emit({ ...base, passed: false, stage: 'validate', diagnostics: validation.diagnostics, lastGood }, false, out); return; }
  const bundle = await bundleFor(pkg, validation, { checks: !!pkg.authored.checks, capture: false });
  if ('diagnostics' in bundle) { await emit({ ...base, passed: false, stage: 'bundle', diagnostics: bundle.diagnostics, lastGood }, false, out); return; }
  const sources = { kernelSources: bundle.kernelSources, kernelSourceDigest: bundle.kernelSourceDigest, checksSources: bundle.checksSources, checksSourceDigest: bundle.checksSourceDigest };
  const run = await withBrowser(bundle, browser => browser.request<CheckRun>('check', { manifest, scenarios: scenariosOf(template), checks: !!pkg.authored.checks, source: sourceOf(validation), timeoutMs: integer(values, 'timeout', 5000, 100, 600_000) }));
  const check = run.result;
  const passed = !check.loadError && check.defaults !== null && check.diagnostics.length === 0 && check.checks.every(item => item.passed)
    && check.scenarios.every(item => item.outcome !== 'out-of-domain' && item.outcome !== 'worker-error') && run.pageErrors.length === 0;
  const stored = passed ? await storeLastGood(pkg, { checkedAt: new Date().toISOString(), template: validation.template, model: validation.model, scientificRevision: validation.modelIdentity?.scientificRevision ?? null, kernelSourceDigest: bundle.kernelSourceDigest, checksSourceDigest: bundle.checksSourceDigest }) : lastGood;
  await emit({
    ...base, passed, stage: 'worker', ...sources, check, warnings: validation.diagnostics.filter(item => item.severity === 'warning'),
    authoredCodeExecution: 'browser module worker only (Chromium, external network blocked)', browser: run.browser, blockedRequests: run.blockedRequests, pageErrors: run.pageErrors,
    lastGood: stored, lastGoodPreserved: !passed && lastGood !== null,
  }, passed, out);
}

async function referenceCommand(directory: string, values: Values) {
  const { pkg, validation, manifest } = await load(directory, text(values, 'fixtures'));
  const out = text(values, 'out');
  const base = { command: 'reference', package: pkg.root, ...identityOf(validation) };
  const fixture = pkg.snapshot.fixture;
  if (!fixture) { await emit({ ...base, passed: false, diagnostics: [{ severity: 'error', code: 'NOT_FOUND', file: 'fixtures/reference.json', path: '$', message: 'No reference fixtures: add fixtures/reference.json or pass --fixtures <path>.' }] }, false, out); return; }
  const kernelFiles = new Set(Object.keys(pkg.authored.kernel?.files ?? {}));
  const fixtureFile = fixture.external ? fixture.path : 'fixtures/reference.json';
  const blocking = errors(validation, file => file === 'model.json' || file === fixtureFile || kernelFiles.has(file));
  if (blocking.length) { await emit({ ...base, passed: false, stage: 'validate', diagnostics: blocking }, false, out); return; }
  const suite = JSON.parse(fixture.text) as ReferenceSuite;
  const bundle = await bundleFor(pkg, validation, { checks: false, capture: false });
  if ('diagnostics' in bundle) { await emit({ ...base, passed: false, stage: 'bundle', diagnostics: bundle.diagnostics }, false, out); return; }
  const run = await withBrowser(bundle, browser => browser.request<ReferenceRun>('reference', { manifest, suite, timeoutMs: integer(values, 'timeout', 5000, 100, 600_000) }));
  const failed = run.result.cases.filter(item => !item.passed);
  await emit({
    ...base, passed: failed.length === 0,
    suite: { suiteId: suite.suiteId, path: fixture.path, digest: sha256File(fixture.text), external: fixture.external, binding: validation.referenceSuite.binding, author: suite.author, review: suite.review, derivedFrom: suite.derivedFrom, notCovered: suite.notCovered },
    summary: { cases: run.result.cases.length, passed: run.result.cases.length - failed.length, failed: failed.length }, cases: run.result.cases, uncovered: run.result.uncovered,
    kernelSourceDigest: bundle.kernelSourceDigest, execution: 'browser module worker', browser: run.browser, blockedRequests: run.blockedRequests,
  }, failed.length === 0, out);
}

async function boundariesCommand(directory: string, values: Values) {
  const { pkg, validation, manifest } = await load(directory, text(values, 'fixtures'));
  const out = text(values, 'out');
  const base = { command: 'boundaries', package: pkg.root, ...identityOf(validation) };
  const kernelFiles = new Set(Object.keys(pkg.authored.kernel?.files ?? {}));
  const blocking = errors(validation, file => file === 'model.json' || file === 'fixtures/boundaries.json' || kernelFiles.has(file));
  if (blocking.length) { await emit({ ...base, passed: false, stage: 'validate', diagnostics: blocking }, false, out); return; }
  const declared = pkg.snapshot.files['fixtures/boundaries.json'] ? (JSON.parse(pkg.snapshot.files['fixtures/boundaries.json']) as { cases: BoundaryCase[] }).cases : null;
  const bundle = await bundleFor(pkg, validation, { checks: false, capture: false });
  if ('diagnostics' in bundle) { await emit({ ...base, passed: false, stage: 'bundle', diagnostics: bundle.diagnostics }, false, out); return; }
  const run = await withBrowser(bundle, browser => browser.request<BoundaryRun>('boundaries', { manifest, declared, timeoutMs: integer(values, 'timeout', 5000, 100, 600_000) }));
  const unmet = run.result.cases.filter(item => !item.matches);
  const counts = run.result.cases.reduce<Record<string, number>>((all, item) => ({ ...all, [item.outcome]: (all[item.outcome] ?? 0) + 1 }), {});
  await emit({ ...base, passed: unmet.length === 0, summary: { cases: run.result.cases.length, declared: declared?.length ?? 0, outcomes: counts, unmetExpectations: unmet.length }, cases: run.result.cases, browser: run.browser }, unmet.length === 0, out);
}

async function captureCommand(directory: string, values: Values) {
  const { pkg, validation, manifest, template } = await load(directory, text(values, 'fixtures'));
  const base = { command: 'capture', package: pkg.root, ...identityOf(validation) };
  const kernelFiles = new Set(Object.keys(pkg.authored.kernel?.files ?? {}));
  const blocking = errors(validation, file => file === 'model.json' || file === 'template.json' || kernelFiles.has(file));
  if (blocking.length || !template || !manifest) { await emit({ ...base, passed: false, stage: 'validate', diagnostics: blocking }, false); return; }
  const stage = text(values, 'stage');
  if (stage !== undefined && values['all-stages']) throw new CliError('INVALID_PARAMETER', 'Use either --stage <id> or --all-stages.');
  if (stage !== undefined && !template.stages.some(item => item.id === stage)) throw new CliError('NOT_FOUND', `The template has no stage ${JSON.stringify(stage)}.`, `Stages: ${template.stages.map(item => item.id).join(', ')}.`);
  const stages = stage !== undefined ? [stage] : template.stages.map(item => item.id);
  const settings = settingsOf(values);
  // Learner-scoped capture: the supplied host policy, validated and never widened (activity-policy.ts).
  const policyFile = text(values, 'policy');
  let policy: CapturePolicy | undefined, policyRecord: Record<string, unknown> = { source: 'author-preview' };
  if (policyFile !== undefined) {
    if (!validation.model) { await emit({ ...base, passed: false, stage: 'validate', diagnostics: validation.diagnostics }, false); return; }
    const checked = await readPolicyFile(policyFile, { template, model: validation.model, installed: false });
    if (!checked.ok) { await emit({ ...base, passed: false, stage: 'policy', diagnostics: checked.diagnostics }, false); return; }
    policy = { policy: checked.policy!, mode: checked.mode! };
    policyRecord = { source: 'supplied', file: checked.file, policyId: checked.policy!.policyId, revision: checked.policy!.revision, mode: checked.mode, notes: checked.notes };
  }
  const target = path.resolve(text(values, 'out') ?? path.join(pkg.root, policy ? 'review/learner-captures' : 'review/captures'));
  const staging = `${target}.staging-${process.pid}`;
  const bundle = await bundleFor(pkg, validation, { checks: false, capture: true });
  if ('diagnostics' in bundle) { await emit({ ...base, passed: false, stage: 'bundle', diagnostics: bundle.diagnostics }, false); return; }
  let run: Awaited<ReturnType<typeof withBrowser<StageCapture[]>>>, passed: boolean, record: Record<string, unknown>;
  try {
    run = await withBrowser(bundle, browser => captureStages(browser, { template, manifest, installed: false, ...(policy ? { policy } : {}) }, stages, settings, staging, ''));
    passed = run.result.every(item => item.ok);
    record = { template: validation.template, model: validation.model, scientificRevision: validation.modelIdentity?.scientificRevision ?? null, policy: policyRecord, settings, browser: run.browser, stages: run.result };
    if (passed) { await writeText(path.join(staging, 'captures.json'), stableJSON(record)); await replaceDirectory(staging, target); }
  } finally { await rm(staging, { recursive: true, force: true }); }
  await emit({ ...base, passed, directory: passed ? target : null, previousOutputsPreserved: !passed, ...record, blockedRequests: run.blockedRequests }, passed);
}

async function testsNaming(templateId: string): Promise<string[]> {
  const directory = path.join(TOOLKIT_ROOT, 'tests/reference/activities');
  if (!existsSync(directory)) return [];
  const out: string[] = [];
  for (const name of (await readdir(directory)).filter(file => file.endsWith('.test.ts')).sort()) {
    const content = await readFile(path.join(directory, name), 'utf8');
    if (content.includes(`fixtures/activities/${templateId}.json`)) out.push(`tests/reference/activities/${name}`);
  }
  return out;
}
const verificationTargets = (template: ActivityTemplate, roots: string[]): Record<string, boolean> => Object.fromEntries(template.alternatives.flatMap(alternative => {
  const file = /^([A-Za-z0-9_./-]+\.(?:ts|tsx|js|mjs|md|json))(?:#.*)?$/.exec(alternative.verifiedBy)?.[1];
  return file ? [[alternative.verifiedBy, roots.some(root => existsSync(path.join(root, file)))]] : [];
}));

async function reviewPacketCommand(directory: string | undefined, values: Values) {
  const tk = await loadToolkit();
  const settings = settingsOf(values);
  const installedId = text(values, 'installed');
  const timeoutMs = integer(values, 'timeout', 5000, 100, 600_000);
  let input: Omit<PacketInput, 'check' | 'mutation' | 'boundaries' | 'captures' | 'browser' | 'suite'> & { suite: Omit<PacketInput['suite'], 'results'> };
  let declared: BoundaryCase[] | null = null;
  let pkg: ActivityPackage | null = null, validation: ValidationOutcome | null = null;
  let target: string;
  const regenerateFlags = [`--width ${settings.width}`, `--theme ${settings.theme}`, ...(settings.fonts !== 'bundled' ? [`--fonts ${settings.fonts}`] : []), ...(settings.index !== null ? [`--index ${settings.index}`] : [])].join(' ');
  if (installedId !== undefined) {
    if (directory) throw new CliError('INVALID_PARAMETER', 'Pass either a package directory or --installed <templateId>.');
    const entry = tk.installedEntries().find(item => item.template.templateId === installedId);
    if (!entry) throw new CliError('NOT_FOUND', `No installed template ${JSON.stringify(installedId)}.`);
    target = path.resolve(text(values, 'out') ?? path.join('review-packets', installedId));
    const fixturePath = path.join(INSTALLED_FIXTURE_DIRECTORY, `${installedId}.json`);
    let suite: ReferenceSuite | null = null, file: { path: string; digest: string } | null = null, unavailable: string | null = null;
    if (existsSync(fixturePath) && tk.CONVERTIBLE_SUITES.includes(installedId)) {
      const bytes = await readFile(fixturePath);
      file = { path: path.relative(TOOLKIT_ROOT, fixturePath).split(path.sep).join('/'), digest: sha256File(bytes) };
      suite = tk.convertInstalledSuite(installedId, JSON.parse(bytes.toString('utf8')), file);
      declared = tk.boundaryCasesFromSuite(suite)?.cases ?? null;
    } else unavailable = `the installed reference suite is not present at ${path.relative(TOOLKIT_ROOT, fixturePath)} in this toolkit tree`;
    const binding = !entry.manifest.referenceSuite ? 'unbound' : file && file.digest === entry.manifest.referenceSuite.digest ? 'matches' : file ? 'differs' : 'none';
    input = {
      kind: 'installed', regenerate: `experiment-kit activity review-packet --installed ${installedId} --out ${shown(target)} ${regenerateFlags}`.trim(), toolkitVersion: toolkitVersion(),
      template: entry.template, manifest: entry.manifest, identity: { template: entry.templateRef, model: entry.modelRef, modelIdentity: entry.modelIdentity, groups: entry.groups },
      lifecycle: entry.lifecycle, reviewScope: entry.reviewScope, relation: null, recordedRelation: null,
      execution: { source: entry.manifest.execution.kind === 'document' ? 'document' : 'installed-kernel', ...(entry.kernel ? { kernelId: entry.kernel.id, kernelVersion: entry.kernel.version } : {}), mode: entry.kernel?.mode ?? 'parametric', kernelSourceDigest: null, kernelSources: [] },
      suite: { file, declared: entry.manifest.referenceSuite ? { ...entry.manifest.referenceSuite } : null, binding, data: suite, unavailable },
      capture: settings, activitySpecificTests: await testsNaming(installedId), verificationTargets: verificationTargets(entry.template, [TOOLKIT_ROOT]),
    };
  } else {
    if (!directory) throw new CliError('INVALID_PARAMETER', 'review-packet needs a package directory or --installed <templateId>.');
    const loaded = await load(directory, text(values, 'fixtures'));
    pkg = loaded.pkg; validation = loaded.validation;
    if (!validation.ok || !loaded.template || !loaded.manifest || !validation.template || !validation.model || !validation.modelIdentity) {
      await emit({ command: 'review-packet', package: pkg.root, passed: false, stage: 'validate', diagnostics: validation.diagnostics }, false); return;
    }
    target = path.resolve(text(values, 'out') ?? path.join(pkg.root, 'review'));
    const fixture = pkg.snapshot.fixture;
    const suite = fixture ? JSON.parse(fixture.text) as ReferenceSuite : null;
    declared = pkg.snapshot.files['fixtures/boundaries.json'] ? (JSON.parse(pkg.snapshot.files['fixtures/boundaries.json']) as { cases: BoundaryCase[] }).cases : null;
    const execution = validation.execution!;
    input = {
      kind: 'package', regenerate: `experiment-kit activity review-packet ${shown(pkg.root)}${text(values, 'out') ? ` --out ${shown(target)}` : ''}${fixture?.external ? ` --fixtures ${shown(fixture.path)}` : ''} ${regenerateFlags}`.trim(),
      toolkitVersion: toolkitVersion(), template: loaded.template, manifest: loaded.manifest,
      identity: { template: validation.template, model: validation.model, modelIdentity: validation.modelIdentity, groups: validation.groups },
      lifecycle: validation.lifecycle, reviewScope: [], relation: validation.relation, recordedRelation: validation.recordedRelation,
      execution: { ...execution, kernelSourceDigest: null, kernelSources: [] },
      suite: { file: fixture ? { path: fixture.external ? fixture.path : 'fixtures/reference.json', digest: sha256File(fixture.text) } : null, declared: validation.referenceSuite.declared, binding: validation.referenceSuite.binding, data: suite, unavailable: fixture ? null : 'the package has no reference fixtures' },
      capture: settings, activitySpecificTests: [], verificationTargets: verificationTargets(loaded.template, [pkg.root, TOOLKIT_ROOT]),
    };
  }
  const bundle = await bundleFor(pkg, validation, { checks: !!pkg?.authored.checks, capture: true });
  if ('diagnostics' in bundle) { await emit({ command: 'review-packet', passed: false, stage: 'bundle', diagnostics: bundle.diagnostics }, false); return; }
  input.execution = { ...input.execution, kernelSourceDigest: bundle.kernelSourceDigest, kernelSources: bundle.kernelSources };
  const staging = `${target}.staging-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  const manifest = input.manifest, suite = input.suite.data;
  // The staging directory is removed on every path; only a completed run replaces the previous packet.
  let run: Awaited<ReturnType<typeof runPacket>>;
  const runPacket = () => withBrowser(bundle, async browser => {
    const check = await browser.request<CheckRun>('check', { manifest, scenarios: scenariosOf(input.template), checks: !!pkg?.authored.checks, source: input.execution.source, timeoutMs });
    const reference = suite ? await browser.request<ReferenceRun>('reference', { manifest, suite, timeoutMs }) : null;
    const mutation = suite ? await browser.request<MutationRun>('mutations', { manifest, suite }) : null;
    const boundaries = await browser.request<BoundaryRun>('boundaries', { manifest, declared, timeoutMs });
    const captures = await captureStages(browser, { template: input.template, manifest, installed: input.kind === 'installed' }, input.template.stages.map(stage => stage.id), settings, path.join(staging, 'captures'), 'captures/');
    return { check, reference, mutation, boundaries, captures };
  });
  try {
    run = await runPacket();
    const packet: PacketInput = { ...input, suite: { ...input.suite, results: run.result.reference }, browser: run.browser, check: run.result.check, mutation: run.result.mutation, boundaries: run.result.boundaries, captures: run.result.captures };
    await writeText(path.join(staging, 'README.md'), packetMarkdown(packet));
    await writeText(path.join(staging, 'packet.json'), stableJSON(packetData(packet)));
    await replaceDirectory(staging, target);
  } finally { await rm(staging, { recursive: true, force: true }); }
  const referenceFailed = run.result.reference?.cases.filter(item => !item.passed).length ?? 0;
  const captureFailed = run.result.captures.filter(item => !item.ok).length;
  const ok = referenceFailed === 0 && captureFailed === 0 && !run.result.check.loadError;
  await emit({
    command: 'review-packet', passed: ok, directory: target, kind: input.kind, template: input.identity.template, model: input.identity.model, scientificRevision: input.identity.modelIdentity.scientificRevision,
    lifecycle: input.lifecycle, reference: run.result.reference ? { cases: run.result.reference.cases.length, failed: referenceFailed } : null,
    mutation: run.result.mutation ? { mutants: run.result.mutation.mutants.length, detected: run.result.mutation.mutants.filter(item => item.killed).length } : null,
    captures: run.result.captures.map(item => ({ stage: item.stageId, ok: item.ok, png: item.png, svg: item.svg, companion: item.companion })),
    signOff: 'empty: an engineering agent cannot sign a subject review', blockedRequests: run.blockedRequests,
  }, ok);
}

/** Opens `url` in the default browser; the URL is printed either way, so a failure to open is not an error. */
function openInBrowser(url: string): void {
  const [command, args]: [string, string[]] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try { const child = spawn(command, args, { stdio: 'ignore', detached: true }); child.on('error', () => undefined); child.unref(); } catch { /* printed URL only */ }
}
const untilSignal = (): Promise<void> => new Promise(resolve => {
  const done = () => { process.off('SIGINT', done); process.off('SIGTERM', done); resolve(); };
  process.once('SIGINT', done); process.once('SIGTERM', done);
});

async function previewCommand(directory: string | undefined, values: Values) {
  // Refused before anything is read, bundled or bound.
  const host = loopbackHost(text(values, 'host'));
  const started = await startActivityPreview({
    directory, installed: text(values, 'installed'), fixtures: text(values, 'fixtures'), policyFile: text(values, 'policy'), host, stage: text(values, 'stage'),
    port: text(values, 'port') === undefined ? undefined : integer(values, 'port', 0, 0, 65535),
    theme: choice(values, 'theme', ['light', 'dark', 'system'] as const, 'system'), fonts: choice(values, 'fonts', ['bundled', 'system'] as const, 'bundled'),
  });
  if (!started.ok) { await emit(started.report, false); return; }
  const { session } = started;
  try {
    process.stdout.write(stableJSON(session.report));
    process.stderr.write(`Activity preview${session.report.passed ? '' : ' (diagnostics only: the package does not validate)'}: ${session.url} (Ctrl-C stops)\n`);
    if (!values['no-open']) openInBrowser(session.url);
    await untilSignal();
  } finally { await session.close(); }
  if (!session.report.passed) process.exitCode = 1;
}

async function packageCommand(directory: string, values: Values) {
  const { pkg, validation } = await load(directory, text(values, 'fixtures'));
  const format = choice(values, 'format', ['zip', 'tgz'] as const, (text(values, 'out') ?? '').endsWith('.tgz') ? 'tgz' : 'zip');
  if (!validation.ok || !validation.template) { await emit({ command: 'package', package: pkg.root, passed: false, stage: 'validate', diagnostics: validation.diagnostics }, false); return; }
  const archive = path.resolve(text(values, 'out') ?? `${validation.template.templateId}-${validation.template.version}.activity.${format}`);
  if (archive.startsWith(pkg.root + path.sep)) throw new CliError('INVALID_PARAMETER', 'Write the archive outside the package directory.', 'Pass --out <path outside the package>.');
  const { bytes, result } = await packageActivity(pkg, validation, { out: archive, format, toolkitVersion: toolkitVersion() });
  await writeText(archive, bytes);
  await emit({ command: 'package', package: pkg.root, passed: true, archive, ...result }, true);
}

export async function runActivityCommand(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      help: { type: 'boolean' }, from: { type: 'string' }, id: { type: 'string' }, kernel: { type: 'string' }, fixtures: { type: 'string' }, stage: { type: 'string' },
      'all-stages': { type: 'boolean' }, width: { type: 'string' }, theme: { type: 'string' }, fonts: { type: 'string' }, index: { type: 'string' }, out: { type: 'string' },
      format: { type: 'string' }, installed: { type: 'string' }, timeout: { type: 'string' }, policy: { type: 'string' }, port: { type: 'string' },
      host: { type: 'string' }, 'no-open': { type: 'boolean' },
    },
  });
  const command = positionals[0];
  if (!command || values.help) { process.stdout.write(ACTIVITY_HELP); return; }
  if (positionals.length > 2) throw new CliError('INVALID_PARAMETER', `Unexpected arguments: ${positionals.slice(2).join(' ')}`);
  const directory = positionals[1];
  const needDirectory = (): string => { if (!directory) throw new CliError('INVALID_PARAMETER', `activity ${command} needs a package directory.`, 'Run experiment-kit activity --help.'); return path.resolve(directory); };
  switch (command) {
    case 'scaffold': {
      const result = await scaffoldActivity(needDirectory(), { from: values.from, id: values.id, kernel: values.kernel === undefined ? undefined : choice(values, 'kernel', ['copy', 'installed'] as const, 'copy') });
      await emit({ command: 'scaffold', passed: true, lifecycle: 'authored', ...result }, true); return;
    }
    case 'validate': await validateCommand(needDirectory(), values); return;
    case 'check': await checkCommand(needDirectory(), values); return;
    case 'reference': await referenceCommand(needDirectory(), values); return;
    case 'boundaries': await boundariesCommand(needDirectory(), values); return;
    case 'capture': await captureCommand(needDirectory(), values); return;
    case 'review-packet': await reviewPacketCommand(directory ? path.resolve(directory) : undefined, values); return;
    case 'preview': await previewCommand(directory ? path.resolve(directory) : undefined, values); return;
    case 'package': await packageCommand(needDirectory(), values); return;
    default: throw new CliError('INVALID_COMMAND', `Unknown activity command: ${command}`, 'Run experiment-kit activity --help.');
  }
}
