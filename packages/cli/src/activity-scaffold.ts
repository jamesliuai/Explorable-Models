/**
 * `experiment-kit activity scaffold <dir> [--from <installedTemplateId>] [--id <templateId>] [--kernel copy|installed]`.
 *
 * Without `--from`, copies the toolkit's example package (packages/cli/templates/activity). With `--from`, copies an
 * installed package's data as an editable exploratory starting point: always a NEW template ID with version 0.1.0 and
 * lifecycle `authored`, recorded in authoring.json as a `new-composition` derived from the exact installed template.
 * A reviewed-template edit is a different act (same template ID, new version, new review) and is never produced here.
 *
 * `--kernel copy` (default when the installed kernel source is in the tree) copies the installed kernel source into
 * kernel.ts under a new kernel and model identity, so edits run as authored code in the browser worker. `--kernel
 * installed` keeps the exact installed model, executed by the installed kernel. The installed reference suite is
 * converted into fixtures/reference.json with its source path and digest recorded (derivedFrom).
 */
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { CliError, ensureEmptyDestination } from './files.js';
import { sha256File, stableJSON } from './activity-files.js';
import { ACTIVITY_TEMPLATE_DIRECTORY, INSTALLED_FIXTURE_DIRECTORY, INSTALLED_KERNEL_DIRECTORY, TOOLKIT_ROOT, loadToolkit, toolkitVersion } from './activity-loader.js';
import type { ActivityTemplate, TemplateRef } from '@experiment-kit/activity';
import type { ModelManifest } from '@experiment-kit/core/model';
import type { AuthoringRecord } from './activity-validation.js';

const ID = /^[a-z][a-z0-9-]{0,62}[a-z0-9]$/;
export interface ScaffoldOptions { from?: string; id?: string; kernel?: 'copy' | 'installed' }
export interface ScaffoldResult { directory: string; templateId: string; from: TemplateRef | null; kernel: AuthoringRecord['relation']['kernel']; files: string[]; notes: string[]; next: string[] }

async function copyTree(source: string, target: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of (await readdir(path.join(source, prefix), { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) { await mkdir(path.join(target, rel), { recursive: true }); out.push(...await copyTree(source, target, rel)); }
    else if (entry.isFile()) { await copyFile(path.join(source, rel), path.join(target, rel)); out.push(rel); }
  }
  return out;
}

const write = async (directory: string, name: string, text: string, files: string[]) => {
  await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
  await writeFile(path.join(directory, name), text);
  if (!files.includes(name)) files.push(name);
};

/** Learner-visible text of a template, for reviewers (copy.md). */
export function learnerCopy(template: ActivityTemplate, note: string): string {
  const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    `# Learner copy: ${template.title}`, '', note, '', '## Title and purpose', '', `- Title: ${template.title}`, `- Purpose: ${template.purpose}`, '',
    '## Stages', '', '| Stage | Kind | Instruction | Host-owned response request |', '| --- | --- | --- | --- |',
    ...template.stages.map(stage => `| ${stage.id} | ${stage.kind} | ${cell(stage.instruction)} | ${stage.response ? cell(`${stage.response.kind}: ${stage.response.prompt}`) : '—'} |`), '',
    '## Content groups', '', '| Group | Label | Description | Solution-bearing |', '| --- | --- | --- | --- |',
    ...template.groups.map(group => `| ${group.id} | ${cell(group.label)} | ${cell(group.description)} | ${group.solutionBearing ? 'yes' : 'no'} |`), '',
    '## Views, controls and scenarios', '',
    ...template.views.map(view => `- View ${view.id} (${view.kind}): ${view.title}. ${view.description}`),
    ...template.controls.map(control => `- Control ${control.parameter}: ${control.label}. ${control.description}`),
    ...template.scenarios.map(scenario => `- Scenario ${scenario.id}: ${scenario.label}. ${scenario.description}`), '',
    '## Equations', '', ...template.equations.map(equation => `- ${equation.label}: ${equation.plain}`), '',
    '## Accessible alternatives', '', ...template.alternatives.map(alternative => `- ${alternative.label} (${alternative.kind}, ${alternative.equivalence}): ${alternative.description}`), '',
  ];
  return `${lines.join('\n')}\n`;
}

const GENERIC_CHECKS = `/**
 * Author checks for a package scaffolded from an installed template. They run only in the browser checks worker
 * (experiment-kit activity check). \`context.evaluate(params, position?)\` merges params over the defaults and evaluates
 * through the worker-side request validation. Return true to pass, or a string/false/{ passed: false, detail } to fail.
 * Add checks that state what this model must do; independent reference cases belong in fixtures/reference.json.
 */
import type { QuantityResult } from '@experiment-kit/core/model';

interface Frame { ok: boolean; quantities?: Record<string, QuantityResult>; diagnostics?: { code: string }[] }
interface CheckContext { evaluate(params?: Record<string, number>): Frame }

export const checks = [
  {
    id: 'defaults-evaluate',
    description: 'The default parameters evaluate, and no quantity is reported as a fabricated value where it is undefined.',
    run(context: CheckContext) {
      const frame = context.evaluate();
      if (!frame.ok) return \`the defaults were rejected (\${(frame.diagnostics ?? []).map(item => item.code).join(', ')})\`;
      return Object.values(frame.quantities ?? {}).every(result => result.status !== 'undefined' || (result.code.length > 0 && result.reason.length > 0)) || 'an undefined quantity has no code or reason';
    },
  },
];
`;

export async function scaffoldActivity(destination: string, options: ScaffoldOptions = {}): Promise<ScaffoldResult> {
  const directory = path.resolve(destination);
  const templateId = options.id ?? path.basename(directory);
  if (!ID.test(templateId)) throw new CliError('INVALID_PARAMETER', `Template ID ${JSON.stringify(templateId)} must be lowercase letters, digits and hyphens (2–64 characters).`, 'Pass --id <templateId> or choose a directory name of that form.');
  const tk = await loadToolkit();
  const installed = tk.installedEntries();
  if (installed.some(entry => entry.template.templateId === templateId || entry.modelRef.modelId === templateId))
    throw new CliError('CONFLICT', `${templateId} is an installed template or model ID; a scaffold is always a new exploratory composition with a new ID.`, 'Choose a new --id. Editing a reviewed template means a new version of it and a new review, not a scaffold.');
  const notes: string[] = [];
  const files: string[] = [];
  let from: TemplateRef | null = null;
  let kernelKind: AuthoringRecord['relation']['kernel'];
  let template: ActivityTemplate, manifest: ModelManifest;
  let fixtureText: string | null = null;
  let boundaries: unknown = null;

  if (!options.from) {
    if (options.kernel) throw new CliError('INVALID_PARAMETER', '--kernel applies only with --from.');
    if (!existsSync(ACTIVITY_TEMPLATE_DIRECTORY)) throw new CliError('TOOLKIT_INCOMPLETE', `The scaffold template is missing at ${path.relative(TOOLKIT_ROOT, ACTIVITY_TEMPLATE_DIRECTORY)}.`);
    await ensureEmptyDestination(directory);
    files.push(...await copyTree(ACTIVITY_TEMPLATE_DIRECTORY, directory));
    template = JSON.parse(await readFile(path.join(directory, 'template.json'), 'utf8')) as ActivityTemplate;
    manifest = JSON.parse(await readFile(path.join(directory, 'model.json'), 'utf8')) as ModelManifest;
    const fixture = JSON.parse(await readFile(path.join(directory, 'fixtures/reference.json'), 'utf8')) as { suiteId: string; model: { modelId: string; version: string } };
    fixture.suiteId = `${templateId}:0.1.0`;
    fixture.model = { modelId: templateId, version: '0.1.0' };
    fixtureText = stableJSON(fixture);
    manifest = { ...manifest, modelId: templateId, version: '0.1.0', execution: { kind: 'kernel', kernelId: templateId, kernelVersion: '0.1.0', mode: 'static' } };
    kernelKind = 'authored';
    notes.push('Example package: a linear function with an authored kernel, author checks, reference fixtures and boundary cases. Replace the mathematics, copy and fixtures with your own.');
  } else {
    const entry = installed.find(item => item.template.templateId === options.from);
    if (!entry) throw new CliError('NOT_FOUND', `No installed template ${JSON.stringify(options.from)}.`, `Installed templates: ${installed.map(item => item.template.templateId).join(', ')}.`);
    from = entry.templateRef;
    template = structuredClone(entry.template);
    manifest = structuredClone(entry.manifest);
    const execution = manifest.execution;
    const kernelFile = execution.kind === 'kernel' ? path.join(INSTALLED_KERNEL_DIRECTORY, `${execution.kernelId}.ts`) : null;
    const kernelSource = kernelFile && existsSync(kernelFile) ? await readFile(kernelFile, 'utf8') : null;
    const exportName = kernelSource ? /export const (\w+): ModelKernel = (?:\/\* @__PURE__ \*\/ )?Object\.freeze\(/.exec(kernelSource)?.[1] ?? null : null;
    const requested = options.kernel ?? (exportName ? 'copy' : 'installed');
    if (requested === 'copy' && (!kernelSource || !exportName)) throw new CliError('TOOLKIT_INCOMPLETE', `The source of the installed kernel for ${options.from} is not available in this toolkit tree.`, 'Use --kernel installed to reference the installed kernel, or use the unified toolkit tree that ships packages/catalog/src.');
    await ensureEmptyDestination(directory);
    if (requested === 'copy' && execution.kind === 'kernel') {
      manifest = { ...manifest, modelId: templateId, version: '0.1.0', execution: { ...execution, kernelId: templateId, kernelVersion: '0.1.0' } };
      const appended = `${kernelSource!.trimEnd()}\n\n/**\n * Authored copy made by experiment-kit activity scaffold from the installed kernel ${execution.kernelId}@${execution.kernelVersion}.\n * It runs as authored code in the browser worker under its own identity; edits never change the installed kernel.\n */\nexport const kernel: ModelKernel = Object.freeze({ id: ${JSON.stringify(templateId)}, version: '0.1.0', mode: ${exportName}.mode, evaluate: ${exportName}.evaluate });\n`;
      await write(directory, 'kernel.ts', appended, files);
      kernelKind = 'copied-from-installed';
      notes.push(`kernel.ts is a copy of packages/catalog/src/kernels/${execution.kernelId}.ts under the new kernel and model ID ${templateId}@0.1.0.`);
    } else {
      kernelKind = execution.kind === 'document' ? 'document' : 'installed';
      notes.push(execution.kind === 'document' ? 'The model executes its bounded schema 2.0 document.' : `The model is the installed ${manifest.modelId}@${manifest.version}, executed by the installed kernel ${execution.kind === 'kernel' ? `${execution.kernelId}@${execution.kernelVersion}` : ''}.`);
    }
    template = { ...template, templateId, version: '0.1.0' };
    const fixturePath = path.join(INSTALLED_FIXTURE_DIRECTORY, `${entry.template.templateId}.json`);
    if (existsSync(fixturePath) && tk.CONVERTIBLE_SUITES.includes(entry.template.templateId)) {
      const bytes = await readFile(fixturePath);
      const source = { path: path.relative(TOOLKIT_ROOT, fixturePath).split(path.sep).join('/'), digest: sha256File(bytes) };
      const suite = tk.convertInstalledSuite(entry.template.templateId, JSON.parse(bytes.toString('utf8')), source, { modelId: manifest.modelId, version: manifest.version, suiteId: kernelKind === 'copied-from-installed' ? `${templateId}:0.1.0` : String(manifest.referenceSuite?.suiteId ?? `${templateId}:0.1.0`) });
      fixtureText = stableJSON(suite);
      boundaries = tk.boundaryCasesFromSuite(suite);
      notes.push(`fixtures/reference.json restates ${source.path} (${source.digest}); keep the authoritative suite outside the package and pass it with --fixtures when it must stay independent of edits.`);
      if (source.digest !== entry.manifest.referenceSuite?.digest) notes.push('The installed fixture file differs from the digest the installed model binds; reference results describe the file as found.');
    } else notes.push('No installed reference suite is available in this toolkit tree; add fixtures/reference.json before claiming reference checks.');
    if (template.alternatives.length) notes.push('Accessible-alternative verification IDs name tests of the installed template; they have not exercised this copy. Re-verify and update verifiedBy.');
    await write(directory, 'checks.ts', GENERIC_CHECKS, files);
    await write(directory, 'copy.md', learnerCopy(template, `Copied from the installed template ${from.templateId}@${from.version} (${from.digest}) by experiment-kit activity scaffold. Every learner-visible string of template.json, collected for review; edit the template, then keep this file in step.`), files);
  }

  // Identities: fixture bytes → reference-suite digest → model digest → template model reference.
  if (fixtureText !== null) {
    await write(directory, 'fixtures/reference.json', fixtureText, files);
    if (kernelKind !== 'installed') manifest = { ...manifest, referenceSuite: { suiteId: `${templateId}:0.1.0`, digest: sha256File(fixtureText) } };
  }
  if (boundaries) await write(directory, 'fixtures/boundaries.json', stableJSON(boundaries), files);
  const identity = tk.modelIdentity(manifest);
  template = { ...template, templateId, version: '0.1.0', model: { modelId: manifest.modelId, version: manifest.version, digest: identity.digest } };
  await write(directory, 'model.json', stableJSON(manifest), files);
  await write(directory, 'template.json', stableJSON(template), files);
  const record: AuthoringRecord = {
    contract: tk.AUTHORING_CONTRACT, version: '1.0', lifecycle: 'authored',
    relation: { kind: 'new-composition', derivedFrom: from, model: from ? { modelId: manifest.modelId, version: manifest.version, digest: identity.digest } : null, kernel: kernelKind },
    createdBy: `experiment-kit activity scaffold (toolkit ${toolkitVersion()})`,
    notes,
  };
  await write(directory, 'authoring.json', stableJSON(record), files);
  const quoted = JSON.stringify(directory);
  return {
    directory, templateId, from, kernel: kernelKind, files: files.sort(), notes,
    next: [`experiment-kit activity validate ${quoted}`, `experiment-kit activity check ${quoted}`, `experiment-kit activity reference ${quoted}`, `experiment-kit activity capture ${quoted} --all-stages`, `experiment-kit activity review-packet ${quoted}`],
  };
}
