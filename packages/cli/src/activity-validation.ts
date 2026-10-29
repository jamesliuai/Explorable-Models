/**
 * `experiment-kit activity validate`: pure-data validation of an authoring package (report §15.2). Runs in Node through
 * the bundled toolkit (activity-toolkit.ts) and never executes authored code: kernel.ts and checks.ts are only parsed
 * by the CLI's import scan. Checks, in order: JSON parsing, the model manifest (schema, semantics, default
 * admissibility), the activity template (schema, cross-references, units, disclosure, accessible equivalents; then, as
 * warnings, equation TeX the toolkit's bounded KaTeX cannot parse for some value form its placeholders can take and the
 * `templateWarnings` for content no stage shows and unused declarations), the
 * execution source, every scenario against the full parameter constraints, the package's relation to the installed
 * catalogue (a reviewed-template edit versus a new exploratory composition; A08), the recorded authoring metadata, the
 * reference fixtures and their binding to the model's reference suite, and the declared boundary cases.
 */
import { canonicalJSON, sha256 } from '@experiment-kit/core';
import {
  checkParameters, isModelError, modelIdentity, validateManifest,
  type ModelIdentity, type ModelManifest, type ModelRef,
} from '@experiment-kit/core/model';
import {
  groupDigests, manifestTexSources, templateRef, templateTexSources, templateWarnings, texParseDiagnostics, validateRecord, validateTemplateSemantics,
  type ActivityTemplate, type GroupDigest, type TemplateRef, type TexParser,
} from '@experiment-kit/activity';
import katex from 'katex';
import { INSTALLED_KERNELS, INSTALLED_MODELS, INSTALLED_TEMPLATES } from '@experiment-kit/catalog';
import { validateBoundarySet, validateReferenceSuite, type BoundarySet, type ReferenceSuite } from './activity-fixtures.js';

export const AUTHORING_CONTRACT = 'experiment-kit.authoring-package' as const;
export const PACKAGE_FILES = Object.freeze({
  model: 'model.json', template: 'template.json', authoring: 'authoring.json', kernel: 'kernel.ts', checks: 'checks.ts', copy: 'copy.md',
  reference: 'fixtures/reference.json', boundaries: 'fixtures/boundaries.json',
});

export interface AuthorDiagnostic { severity: 'error' | 'warning'; code: string; file: string; path: string; message: string; recovery?: string }
export interface PackageSnapshot {
  /** Text of the package's allowlisted files keyed by relative path (absent files are omitted). */
  files: Record<string, string>;
  /** Reference fixtures used for this run: the package's own or an external file (`--fixtures`). */
  fixture: { path: string; text: string; external: boolean } | null;
  /** Import-scan diagnostics of kernel.ts, checks.ts and their relative imports (from the CLI's TypeScript scan). */
  importDiagnostics: AuthorDiagnostic[];
}

export type Relation =
  | { kind: 'new-composition'; derivedFrom: TemplateRef | null }
  | { kind: 'installed-identical'; of: TemplateRef }
  | { kind: 'template-edit'; of: TemplateRef };
export interface AuthoringRecord {
  contract: typeof AUTHORING_CONTRACT;
  version: '1.0';
  lifecycle: 'authored';
  relation: { kind: 'new-composition' | 'template-edit'; derivedFrom: TemplateRef | null; model: ModelRef | null; kernel: 'authored' | 'copied-from-installed' | 'installed' | 'document' };
  createdBy: string;
  notes: string[];
}

export interface ValidationOutcome {
  ok: boolean;
  diagnostics: AuthorDiagnostic[];
  template: TemplateRef | null;
  model: ModelRef | null;
  modelIdentity: ModelIdentity | null;
  groups: GroupDigest[];
  execution: { source: 'authored-kernel' | 'installed-kernel' | 'document'; kernelId?: string; kernelVersion?: string; mode: 'discrete' | 'static' | 'continuous' | 'parametric' } | null;
  relation: Relation | null;
  recordedRelation: AuthoringRecord['relation'] | null;
  scenarios: { id: string; ok: boolean; codes: string[] }[];
  referenceSuite: { declared: { suiteId: string; digest: string } | null; fixture: { path: string; digest: string; cases: number; external: boolean } | null; binding: 'matches' | 'derived-from' | 'differs' | 'unbound' | 'none' };
  boundaries: { cases: number } | null;
  /** Lifecycle the tool reports for this package; never above `authored` without host-trusted review. */
  lifecycle: 'authored';
}

const fileDigest = (text: string): string => 'sha256:' + sha256(text);
const error = (code: string, file: string, path: string, message: string, recovery?: string): AuthorDiagnostic => ({ severity: 'error', code, file, path, message, ...(recovery ? { recovery } : {}) });
const warning = (code: string, file: string, path: string, message: string, recovery?: string): AuthorDiagnostic => ({ severity: 'warning', code, file, path, message, ...(recovery ? { recovery } : {}) });

/**
 * The bounded TeX parser of validation (report §10.3): the toolkit's own KaTeX with the learner renderer's limits
 * (`trust: false`, bounded expansion and size, a fresh macro object), producing MathML only. Trusted toolkit code; it
 * parses authored TeX as data and never executes authored code.
 */
export const parseTex: TexParser = (source, options) => katex.renderToString(source, { ...options, output: 'mathml' });

/**
 * Semantic errors of a schema-valid template and, as warnings (report §15.2): equation TeX that does not parse for some
 * value form its placeholders can take (`MATH_FALLBACK`: learners would only ever see the equation's plain-text form,
 * which the contract requires, so the package still validates, as with label and clipping diagnostics), then, once
 * the references resolve, content the stages never show and unused declarations (`templateWarnings`). Shared by
 * `validate` and `preview`.
 */
export function templateDiagnostics(template: ActivityTemplate, manifest: ModelManifest, file: string): AuthorDiagnostic[] {
  const semantic = validateTemplateSemantics(template, manifest);
  const tex = texParseDiagnostics(templateTexSources(template, manifest.quantities), parseTex).map(item => warning(item.code, file, item.path, item.message, item.recovery));
  if (semantic.length) return [...semantic.map(item => error(item.code, file, item.path, item.message, item.recovery)), ...tex];
  return [...tex, ...templateWarnings(template, manifest).map(item => warning(item.code, file, item.path, item.message, item.recovery))];
}

function parse(files: Record<string, string>, name: string, out: AuthorDiagnostic[], required: boolean): unknown {
  const text = files[name];
  if (text === undefined) {
    if (required) out.push(error('NOT_FOUND', name, '$', `${name} is missing.`, `Create ${name}; run experiment-kit activity scaffold for a complete starting point.`));
    return undefined;
  }
  try { return JSON.parse(text); } catch (failure) {
    out.push(error('SCHEMA', name, '$', `Invalid JSON: ${failure instanceof Error ? failure.message.slice(0, 200) : 'parse error'}.`));
    return undefined;
  }
}

const installedTemplate = (templateId: string) => INSTALLED_TEMPLATES.filter(template => template.templateId === templateId);
const installedModel = (modelId: string) => INSTALLED_MODELS.filter(manifest => manifest.modelId === modelId);

/** Relation of a template to the installed catalogue (exact identity; a different digest under the same identity is a conflict). */
export function templateRelation(template: ActivityTemplate, derivedFrom: TemplateRef | null): { relation: Relation; conflict: boolean } {
  const ref = templateRef(template);
  const installed = installedTemplate(template.templateId);
  if (!installed.length) return { relation: { kind: 'new-composition', derivedFrom }, conflict: false };
  const sameVersion = installed.find(entry => entry.version === template.version);
  if (sameVersion) {
    const of = templateRef(sameVersion);
    return of.digest === ref.digest ? { relation: { kind: 'installed-identical', of }, conflict: false } : { relation: { kind: 'template-edit', of }, conflict: true };
  }
  return { relation: { kind: 'template-edit', of: templateRef(installed[0]!) }, conflict: false };
}

/** Validates one authoring package snapshot. Pure: reads only the snapshot and the installed catalogue data. */
export function validatePackage(snapshot: PackageSnapshot): ValidationOutcome {
  const out: AuthorDiagnostic[] = [...snapshot.importDiagnostics];
  const files = snapshot.files;
  const rawModel = parse(files, PACKAGE_FILES.model, out, true);
  const rawTemplate = parse(files, PACKAGE_FILES.template, out, true);
  const rawAuthoring = parse(files, PACKAGE_FILES.authoring, out, false);
  const rawBoundaries = parse(files, PACKAGE_FILES.boundaries, out, false);
  const outcome: ValidationOutcome = {
    ok: false, diagnostics: out, template: null, model: null, modelIdentity: null, groups: [], execution: null, relation: null, recordedRelation: null,
    scenarios: [], referenceSuite: { declared: null, fixture: null, binding: 'none' }, boundaries: null, lifecycle: 'authored',
  };

  // Model manifest.
  let manifest: ModelManifest | null = null;
  if (rawModel !== undefined) {
    const record = validateRecord('experiment-kit.model-manifest', rawModel);
    if (!record.ok) for (const item of record.diagnostics) out.push(error(item.code, PACKAGE_FILES.model, item.path, item.message, item.recovery));
    else {
      try {
        const validated = validateManifest(rawModel);
        manifest = validated.manifest;
        outcome.modelIdentity = { ...validated.identity };
        outcome.model = { modelId: manifest.modelId, version: manifest.version, digest: validated.identity.digest };
        // Declared TeX-safe symbols are presentation metadata (learner text uses their plain form): a warning.
        for (const item of texParseDiagnostics(manifestTexSources(manifest), parseTex)) out.push(warning(item.code, PACKAGE_FILES.model, item.path, item.message, item.recovery));
      } catch (failure) {
        if (!isModelError(failure)) throw failure;
        for (const item of failure.diagnostics) out.push(error(item.code, PACKAGE_FILES.model, item.path, item.message, item.recovery));
      }
    }
  }

  // Execution source.
  if (manifest) {
    const execution = manifest.execution;
    const hasKernel = files[PACKAGE_FILES.kernel] !== undefined;
    if (execution.kind === 'document') {
      outcome.execution = { source: 'document', mode: execution.document.time ? 'continuous' : 'parametric' };
      if (hasKernel) out.push(warning('UNSUPPORTED_CAPABILITY', PACKAGE_FILES.kernel, '$', 'kernel.ts is ignored: the model executes a bounded schema 2.0 document.', 'Remove kernel.ts or switch execution to an authored kernel.'));
    } else {
      outcome.execution = { source: hasKernel ? 'authored-kernel' : 'installed-kernel', kernelId: execution.kernelId, kernelVersion: execution.kernelVersion, mode: execution.mode };
      const installed = INSTALLED_KERNELS.find(kernel => kernel.id === execution.kernelId);
      if (hasKernel && installed) {
        out.push(error('CONFLICT', PACKAGE_FILES.model, '$.execution.kernelId', `The authored kernel uses the ID of the installed kernel ${execution.kernelId}; authored code can never stand in for installed code.`, 'Give the authored kernel (and execution.kernelId) a new ID.'));
      } else if (!hasKernel) {
        const exact = INSTALLED_KERNELS.find(kernel => kernel.id === execution.kernelId && kernel.version === execution.kernelVersion);
        if (!exact) out.push(error('UNSUPPORTED_CAPABILITY', PACKAGE_FILES.model, '$.execution', `No kernel.ts is present and ${execution.kernelId}@${execution.kernelVersion} is not an installed kernel.`, 'Add kernel.ts exporting the authored kernel, or name an installed kernel ID and version.'));
        else if (exact.mode !== execution.mode) out.push(error('UNSUPPORTED_CAPABILITY', PACKAGE_FILES.model, '$.execution.mode', `The installed kernel ${exact.id}@${exact.version} is ${exact.mode}, not ${execution.mode}.`));
      }
    }
    const installedSame = installedModel(manifest.modelId).find(entry => entry.version === manifest!.version);
    if (installedSame && modelIdentity(installedSame).digest !== outcome.model!.digest)
      out.push(error('CONFLICT', PACKAGE_FILES.model, '$.version', `The installed model ${manifest.modelId}@${manifest.version} has different content; an edited model cannot keep the installed identity.`, 'Give the edited model a new modelId or version: its scientific revision and any review are not shared.'));
  }

  // Template.
  let template: ActivityTemplate | null = null;
  if (rawTemplate !== undefined) {
    const record = validateRecord('study-harness.activity-template', rawTemplate);
    if (!record.ok) for (const item of record.diagnostics) out.push(error(item.code, PACKAGE_FILES.template, item.path, item.message, item.recovery));
    else {
      template = rawTemplate as ActivityTemplate;
      outcome.template = templateRef(template);
      if (manifest) {
        out.push(...templateDiagnostics(template, manifest, PACKAGE_FILES.template));
        try { outcome.groups = groupDigests(template, manifest); } catch { outcome.groups = []; }
      }
    }
  }

  // Scenarios against the complete parameter set (defaults overridden by the scenario), as the runtime applies them.
  if (template && manifest) {
    const defaults = Object.fromEntries(Object.entries(manifest.parameters).map(([id, definition]) => [id, definition.default]));
    template.scenarios.forEach((scenario, s) => {
      const problems = checkParameters(manifest!, { ...defaults, ...scenario.parameters });
      outcome.scenarios.push({ id: scenario.id, ok: problems.length === 0, codes: [...new Set(problems.map(item => item.code))] });
      for (const item of problems) out.push(error(item.code, PACKAGE_FILES.template, `$.scenarios[${s}].parameters`, `Scenario ${JSON.stringify(scenario.id)} applied over the defaults: ${item.message}`, item.recovery));
    });
  }

  // Recorded authoring metadata and the computed relation to the installed catalogue.
  let record: AuthoringRecord | null = null;
  if (rawAuthoring !== undefined) {
    const value = rawAuthoring as Partial<AuthoringRecord>;
    if (!value || typeof value !== 'object' || value.contract !== AUTHORING_CONTRACT || value.version !== '1.0' || !value.relation || typeof value.relation !== 'object')
      out.push(error('SCHEMA', PACKAGE_FILES.authoring, '$', `authoring.json must be an ${AUTHORING_CONTRACT} 1.0 record with a relation.`));
    else {
      record = value as AuthoringRecord;
      outcome.recordedRelation = record.relation;
      if (record.lifecycle !== 'authored')
        out.push(error('REVIEW_UNVERIFIED', PACKAGE_FILES.authoring, '$.lifecycle', `A package cannot declare its own lifecycle (${String(record.lifecycle)}); review status comes only from host-trusted review records.`, 'Set lifecycle to "authored".'));
    }
  } else out.push(warning('NOT_FOUND', PACKAGE_FILES.authoring, '$', 'authoring.json is missing, so the package does not record whether it is a template edit or a new composition.', 'Run experiment-kit activity scaffold, or add an authoring.json record.'));
  if (template) {
    const { relation, conflict } = templateRelation(template, record?.relation.derivedFrom ?? null);
    outcome.relation = relation;
    if (conflict) out.push(error('CONFLICT', PACKAGE_FILES.template, '$.version', `This changes the installed template ${template.templateId}@${template.version} under the same identity; approvals bound to the installed digest can never transfer to it.`, 'Choose a new templateId for an exploratory composition, or a new version for a reviewed-template edit (which needs a new review).'));
    else if (relation.kind === 'template-edit') out.push(warning('REVIEW_UNVERIFIED', PACKAGE_FILES.template, '$.templateId', `This is an edit of the installed template ${relation.of.templateId} (new version ${template.version}); reviews of ${relation.of.templateId}@${relation.of.version} do not apply to it.`, 'Request a new subject review for the edited version before host approval.'));
    if (record && relation.kind !== 'installed-identical' && record.relation.kind !== relation.kind)
      out.push(warning('CONFLICT', PACKAGE_FILES.authoring, '$.relation.kind', `authoring.json records a ${record.relation.kind}, but the content is a ${relation.kind}.`, 'Update authoring.json so the recorded relation matches the package.'));
  }

  // Reference fixtures and their binding to the model's reference suite.
  outcome.referenceSuite.declared = manifest?.referenceSuite ? { ...manifest.referenceSuite } : null;
  if (snapshot.fixture) {
    const file = snapshot.fixture.external ? snapshot.fixture.path : PACKAGE_FILES.reference;
    let suite: unknown;
    try { suite = JSON.parse(snapshot.fixture.text); } catch (failure) { out.push(error('SCHEMA', file, '$', `Invalid JSON: ${failure instanceof Error ? failure.message.slice(0, 200) : 'parse error'}.`)); }
    if (suite !== undefined) {
      const problems = validateReferenceSuite(suite, manifest);
      for (const item of problems) out.push(error(item.code, file, item.path, item.message, item.recovery));
      const digest = fileDigest(snapshot.fixture.text);
      outcome.referenceSuite.fixture = { path: snapshot.fixture.path, digest, cases: problems.length ? 0 : (suite as ReferenceSuite).cases.length, external: snapshot.fixture.external };
      const declared = outcome.referenceSuite.declared;
      const derived = problems.length ? null : (suite as ReferenceSuite).derivedFrom;
      outcome.referenceSuite.binding = !declared ? 'unbound' : declared.digest === digest ? 'matches' : derived?.digest === declared.digest ? 'derived-from' : 'differs';
      if (!snapshot.fixture.external) {
        if (outcome.referenceSuite.binding === 'unbound') out.push(warning('INVALID_REFERENCE', PACKAGE_FILES.model, '$.referenceSuite', 'The model does not bind its reference suite, so a fixture change would not change its scientific revision.', `Set referenceSuite to { "suiteId": "...", "digest": "${digest}" }.`));
        if (outcome.referenceSuite.binding === 'differs') out.push(error('INVALID_REFERENCE', PACKAGE_FILES.model, '$.referenceSuite.digest', 'The model binds a different reference suite than fixtures/reference.json.', `Set referenceSuite.digest to ${digest} (this changes the model's scientific revision), or restore the bound fixture file.`));
      }
    }
  } else if (outcome.referenceSuite.declared) {
    out.push(warning('NOT_FOUND', PACKAGE_FILES.reference, '$', 'The model names a reference suite, but no fixture file is available to run it.', 'Add fixtures/reference.json or pass --fixtures <path>.'));
  } else out.push(warning('NOT_FOUND', PACKAGE_FILES.reference, '$', 'No reference fixtures: the package cannot become reference-checked.', 'Add independently derived cases in fixtures/reference.json (or keep them outside the package and pass --fixtures).'));

  if (rawBoundaries !== undefined) {
    const problems = validateBoundarySet(rawBoundaries, manifest);
    for (const item of problems) out.push(error(item.code, PACKAGE_FILES.boundaries, item.path, item.message, item.recovery));
    if (!problems.length) outcome.boundaries = { cases: (rawBoundaries as BoundarySet).cases.length };
  }
  if (files[PACKAGE_FILES.copy] === undefined) out.push(warning('NOT_FOUND', PACKAGE_FILES.copy, '$', 'copy.md is missing; reviewers have no single place to read the learner copy and its intent.'));

  outcome.ok = !out.some(item => item.severity === 'error');
  return outcome;
}

/** Digest of the canonical JSON of a value (`sha256:` prefixed). */
export const jsonDigest = (value: unknown): string => 'sha256:' + sha256(canonicalJSON(value));
