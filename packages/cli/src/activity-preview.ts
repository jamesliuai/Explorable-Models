/**
 * `explorable-models activity preview <dir> | --installed <templateId>` (report §15.2): the author preview and the learner
 * preview side by side, served on 127.0.0.1 only. Node reads and validates data, resolves the learner policy and
 * writes `preview-input.json` next to the fixed preview page; every adapter, kernel and surface runs in the browser
 * page, and authored model code runs only in the page's module worker (activity-bundle.ts). The server sends the CLI's
 * content security policy (no remote origin; workers get `connect-src 'none'`) and checks the Host header.
 *
 * Also hosts `readPolicyFile`, the Node-side reading of a `--policy` file shared with `capture --policy`.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CliError, readBounded } from './files.js';
import { readActivityPackage, stableJSON } from './activity-files.js';
import { BundleError, buildBundle, type BuiltBundle, type ExecutionSource } from './activity-bundle.js';
import { loadToolkit, toolkitVersion } from './activity-loader.js';
import { serveStatic, type StaticServer } from './server.js';
import type { ActivityTemplate, HostPolicy } from '@explorable-models/activity';
import type { ModelManifest, ModelRef } from '@explorable-models/core/model';
import type { AuthorDiagnostic } from './activity-validation.js';
import type { PolicyCheck, PolicyContext } from './activity-policy.js';
import type { BlockedPreviewInput, PreviewInput } from './activity-preview-page.js';

/** The only address the preview binds; `--host` accepts exactly this or `localhost` (resolved to it). */
export const PREVIEW_HOST = '127.0.0.1';
const POLICY_FILE_BYTES = 256 * 1024;

/** Refuses any `--host` that is not this server's loopback address. */
export function loopbackHost(host: string | undefined): typeof PREVIEW_HOST {
  if (host === undefined || host === PREVIEW_HOST || host === 'localhost') return PREVIEW_HOST;
  throw new CliError('INVALID_PARAMETER', `The activity preview serves on ${PREVIEW_HOST} only; ${JSON.stringify(host)} is not this server's loopback address.`, 'Omit --host, or pass --host 127.0.0.1.');
}

/** Reads and checks a `--policy` file for a learner-scoped view of `context.template` (activity-policy.ts). */
export async function readPolicyFile(file: string, context: PolicyContext): Promise<PolicyCheck & { file: string }> {
  const resolved = path.resolve(file);
  const shown = path.relative(process.cwd(), resolved).startsWith('..') ? resolved : path.relative(process.cwd(), resolved) || resolved;
  let text: string;
  try { text = await readBounded(resolved, POLICY_FILE_BYTES); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new CliError('NOT_FOUND', `No policy file at ${shown}.`, 'Pass --policy <path to a study-harness.host-policy JSON file>.');
    throw error;
  }
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch { return { ok: false, file: shown, diagnostics: [{ severity: 'error', code: 'SCHEMA', file: shown, path: '$', message: 'The policy file is not valid JSON.' }], policy: null, mode: null, notes: null }; }
  const tk = await loadToolkit();
  return { ...tk.previewPolicyFile(raw, shown, context), file: shown };
}

export interface PreviewOptions {
  /** Authoring package directory, or `installed` for an installed template. */
  directory?: string;
  installed?: string;
  fixtures?: string;
  policyFile?: string;
  port?: number;
  host?: string;
  stage?: string;
  theme?: 'light' | 'dark' | 'system';
  fonts?: 'bundled' | 'system';
}
export interface PreviewSession {
  url: string;
  /** The JSON report printed when the server is up; `passed: false` when the page shows blocking diagnostics only. */
  report: Record<string, unknown> & { passed: boolean };
  input: PreviewInput | BlockedPreviewInput;
  close(): Promise<void>;
}
export type PreviewStart = { ok: true; session: PreviewSession } | { ok: false; report: Record<string, unknown> };

interface Subject {
  title: string;
  source: PreviewInput['source'];
  template: ActivityTemplate;
  manifest: ModelManifest;
  model: ModelRef;
  lifecycle: string;
  installed: boolean;
  execution: ExecutionSource;
  root: string | null;
  diagnostics: AuthorDiagnostic[];
  base: Record<string, unknown>;
}

interface Blocked { title: string; source: PreviewInput['source']; diagnostics: AuthorDiagnostic[]; base: Record<string, unknown> }

async function subjectOf(options: PreviewOptions): Promise<Subject | { blocked: Blocked }> {
  const tk = await loadToolkit();
  if (options.installed !== undefined) {
    if (options.directory) throw new CliError('INVALID_PARAMETER', 'Pass either a package directory or --installed <templateId>.');
    const entry = tk.installedEntries().find(item => item.template.templateId === options.installed);
    if (!entry) throw new CliError('NOT_FOUND', `No installed template ${JSON.stringify(options.installed)}.`, `Installed templates: ${tk.installedEntries().map(item => item.template.templateId).join(', ')}.`);
    return {
      title: entry.template.title, source: { kind: 'installed', templateId: entry.template.templateId }, template: entry.template, manifest: entry.manifest, model: entry.modelRef,
      // The installed worker bundle serves installed kernels and bounded document execution alike (as review packets do).
      lifecycle: entry.lifecycle, installed: true, execution: 'installed-kernel', root: null,
      diagnostics: tk.templateDiagnostics(entry.template, entry.manifest, `catalog:${entry.template.templateId}`),
      base: { command: 'preview', installed: entry.template.templateId, template: entry.templateRef, model: entry.modelRef, lifecycle: entry.lifecycle },
    };
  }
  if (!options.directory) throw new CliError('INVALID_PARAMETER', 'preview needs a package directory or --installed <templateId>.', 'Run explorable-models activity --help.');
  const pkg = await readActivityPackage(options.directory, { fixturesPath: options.fixtures });
  const validation = tk.validatePackage(pkg.snapshot);
  const base = { command: 'preview', package: pkg.root, template: validation.template, model: validation.model, lifecycle: validation.lifecycle, relation: validation.relation, execution: validation.execution };
  const kernelFiles = new Set(Object.keys(pkg.authored.kernel?.files ?? {}));
  // What the page needs to prepare an activity; other diagnostics (fixtures, authoring record) are listed in the page.
  const blocking = validation.diagnostics.filter(item => item.severity === 'error' && (item.file === 'model.json' || item.file === 'template.json' || kernelFiles.has(item.file)));
  const parse = <T>(name: string): T | null => { try { return pkg.snapshot.files[name] ? JSON.parse(pkg.snapshot.files[name]!) as T : null; } catch { return null; } };
  const template = parse<ActivityTemplate>('template.json'), manifest = parse<ModelManifest>('model.json');
  if (blocking.length || !template || !manifest || !validation.model) {
    const title = typeof template?.title === 'string' ? template.title : path.basename(pkg.root);
    return { blocked: { title, source: { kind: 'package', directory: pkg.root }, diagnostics: validation.diagnostics, base } };
  }
  return {
    title: template.title, source: { kind: 'package', directory: pkg.root }, template, manifest, model: validation.model, lifecycle: validation.lifecycle ?? 'authored', installed: false,
    execution: validation.execution?.source ?? 'document', root: pkg.root, diagnostics: validation.diagnostics, base,
  };
}

/** Writes `preview-input.json` into the bundle and serves it on the loopback address; the bundle is disposed on failure. */
async function serveBundle(bundle: BuiltBundle, input: PreviewInput | BlockedPreviewInput, port: number | undefined, host: string): Promise<{ server: StaticServer; url: string; close(): Promise<void> }> {
  let server: StaticServer;
  try {
    await writeFile(path.join(bundle.directory, 'preview-input.json'), stableJSON(input));
    server = await serveStatic(bundle.directory, { port: port ?? 0 });
  } catch (error) {
    await bundle.dispose();
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new CliError('PORT_IN_USE', `Port ${port} on ${host} is in use.`, 'Pass another --port, or omit it for an available port.');
    throw error;
  }
  let closed = false;
  return { server, url: `${server.url}/`, close: async () => { if (closed) return; closed = true; try { await server.close(); } finally { await bundle.dispose(); } } };
}

/**
 * A package whose model, template or kernel does not validate: the page shows its diagnostics only (orphaned
 * references, missing equivalents, unit mismatches, schema errors, …). No activity is prepared, and the bundle carries
 * no authored code (document execution, no kernel).
 */
async function startBlocked(blocked: Blocked, options: PreviewOptions, host: string): Promise<PreviewStart> {
  const bundle = await buildBundle({ root: null, source: 'document', checks: false, capture: false, preview: true });
  const input: BlockedPreviewInput = { status: 'blocked', title: blocked.title, source: blocked.source, diagnostics: blocked.diagnostics, theme: options.theme ?? 'system' };
  const served = await serveBundle(bundle, input, options.port, host);
  const counts = (severity: string) => blocked.diagnostics.filter(item => item.severity === severity).length;
  const report = {
    ...blocked.base, passed: false, stage: 'validate', url: served.url, host, port: Number(new URL(served.url).port), toolkitVersion: toolkitVersion(),
    diagnostics: blocked.diagnostics, summary: { errors: counts('error'), warnings: counts('warning') },
    // No template to apply it to: a supplied --policy is read only once the package validates.
    learnerPolicy: null,
    page: 'diagnostics only: no activity is prepared and no authored code is bundled until the package validates',
    stop: 'Press Ctrl-C to stop the preview server.',
  };
  return { ok: true, session: { url: served.url, report, input, close: served.close } };
}

/**
 * Validates the subject and the learner policy, builds the preview bundle and starts the loopback server. Nothing is
 * opened and nothing is printed; the command prints `session.report` and waits for Ctrl-C.
 */
export async function startActivityPreview(options: PreviewOptions): Promise<PreviewStart> {
  const host = loopbackHost(options.host);
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)) throw new CliError('INVALID_PARAMETER', '--port must be an integer from 0 to 65535.');
  const subject = await subjectOf(options);
  if ('blocked' in subject) return startBlocked(subject.blocked, options, host);
  const { template } = subject;
  if (options.stage !== undefined && !template.stages.some(stage => stage.id === options.stage))
    throw new CliError('NOT_FOUND', `The template has no stage ${JSON.stringify(options.stage)}.`, `Stages: ${template.stages.map(stage => stage.id).join(', ')}.`);
  const tk = await loadToolkit();
  const context: PolicyContext = { template, model: subject.model, installed: subject.installed };
  const issuedAt = new Date().toISOString();
  let learner: PreviewInput['learner'];
  if (options.policyFile !== undefined) {
    const checked = await readPolicyFile(options.policyFile, context);
    if (!checked.ok) return { ok: false, report: { ...subject.base, passed: false, stage: 'policy', diagnostics: checked.diagnostics } };
    learner = { policy: checked.policy!, mode: checked.mode!, source: 'supplied', file: checked.file, notes: checked.notes! };
  } else {
    const policy: HostPolicy = tk.derivedLearnerPolicy(context, issuedAt);
    learner = { policy, mode: subject.installed ? 'approved' : 'exploratory', source: 'derived', file: null, notes: tk.policyNotes(policy, template) };
  }
  const authorTemplate = tk.authorViewTemplate(template);
  const input: PreviewInput = {
    status: 'ready', title: subject.title, source: subject.source, identity: { template: tk.templateRef(template), model: subject.model, lifecycle: subject.lifecycle },
    template, manifest: subject.manifest, installed: subject.installed, author: { template: authorTemplate, policy: tk.authorViewPolicy(authorTemplate, issuedAt) },
    learner, diagnostics: subject.diagnostics, stage: options.stage ?? null, theme: options.theme ?? 'system', fonts: options.fonts ?? 'bundled',
  };

  let bundle: BuiltBundle;
  try { bundle = await buildBundle({ root: subject.root, source: subject.execution, checks: false, capture: false, preview: true }); }
  catch (error) { if (error instanceof BundleError) return { ok: false, report: { ...subject.base, passed: false, stage: 'bundle', diagnostics: error.diagnostics } }; throw error; }
  const served = await serveBundle(bundle, input, options.port, host);
  const url = served.url;
  const counts = (severity: string) => subject.diagnostics.filter(item => item.severity === severity).length;
  const report = {
    ...subject.base, passed: true, url, host, port: Number(new URL(url).port), toolkitVersion: toolkitVersion(),
    learnerPolicy: { source: learner.source, file: learner.file, policyId: learner.policy.policyId, revision: learner.policy.revision, mode: learner.mode, notes: learner.notes },
    authorView: 'every group visible and every control listed in every stage (exploratory author aid, never a learner channel)',
    stages: template.stages.map(stage => stage.id), initialStage: options.stage ?? template.initialStage,
    diagnostics: subject.diagnostics, summary: { errors: counts('error'), warnings: counts('warning') },
    authoredCodeExecution: 'browser module worker of the preview page only', stop: 'Press Ctrl-C to stop the preview server.',
  };
  return { ok: true, session: { url, report, input, close: served.close } };
}
