/**
 * Subject-review packet (report §12.6, §15.2, A30): a docs-style README.md for a human reviewer plus a machine-readable
 * packet.json, generated from the exact template and model, the worker-backed check, reference, boundary and
 * mutation runs, and stage-by-stage captures. The packet is engineering evidence prepared by a tool. It is not a
 * review: the sign-off section is empty, and an engineering agent cannot sign it.
 */
import type { ActivityTemplate, GroupDigest, TemplateRef } from '@explorable-models/activity';
import type { ModelIdentity, ModelManifest, ModelRef } from '@explorable-models/core/model';
import type { Mutation, ReferenceSuite, Tolerance } from './activity-fixtures.js';
import type { Relation, AuthoringRecord } from './activity-validation.js';
import type { SourceDigest } from './activity-bundle.js';

export const PACKET_CONTRACT = 'explorable-models.review-packet' as const;

/**
 * One geometry of the default frame as `check` reports it: kind, element count, the declared sampling of sampled curves
 * and grids (a drawing through samples does not certify the values between them) and the row and missing-cell counts of
 * observed data.
 */
export interface GeometrySummary {
  kind: string;
  elements: number;
  sampling?: { samples: number; domain: [number, number] } | { nx: number; ny: number; domain: [number, number, number, number] };
  observed?: { dataset: string; rows: number; missing: number };
}
export interface CheckRun {
  worker: { kernels: { id: string; version: string; mode: string }[]; checks: { id: string; description: string }[] | null; checksError: string | null } | null;
  loadError: { code: string; message: string } | null;
  defaults: { params: Record<string, number>; position: unknown; terminal: unknown; quantities: Record<string, string>; geometry: Record<string, GeometrySummary> } | null;
  scenarios: { id: string; outcome: string; statuses: Record<string, string> | null; diagnostics: { code: string; path: string; message: string }[] }[];
  checks: { id: string; description: string; passed: boolean; detail?: string }[];
  diagnostics: { code: string; path: string; message: string }[];
}
export interface ReferenceRun {
  cases: { id: string; label: string; provenance: string; tolerance: Tolerance; tolerances: Record<string, Tolerance> | null; kind: 'rejection' | 'evaluation'; points: number; passed: boolean; problems: string[]; omittedProblems: number }[];
  uncovered: string[];
}
export interface BoundaryRun {
  cases: { id: string; source: 'declared' | 'generated'; label: string; rationale: string; params: Record<string, number>; position: unknown; outcome: string; statuses: Record<string, string>; rejection: { code: string; path: string; message: string }[] | null; expected: unknown; matches: boolean; mismatches: string[] }[];
}
export interface MutationRun { baselineProblems: string[]; mutants: (Mutation & { killed: boolean; firstProblem: string | null })[]; uncovered: string[] }
export interface StageCapture {
  stageId: string;
  kind: string;
  instruction: string;
  response: { kind: string; prompt: string; taskFamily: string } | null;
  ok: boolean;
  png: string | null;
  svg: string | null;
  companion: string | null;
  svgView: string | null;
  svgError: { code: string; message: string } | null;
  revealed: string[];
  revealError: unknown;
  projectionDigest: string | null;
  frameId: string | null;
  ui: string | null;
  reviewNotice: string | null;
  views: { viewId: string; kind: string; title: string }[];
  math: { equations: number; plainText: number } | null;
  navigatedTo: number | null;
  diagnostics: { code: string; message: string }[];
}
export interface PacketInput {
  kind: 'installed' | 'package';
  regenerate: string;
  toolkitVersion: string;
  browser: string;
  template: ActivityTemplate;
  manifest: ModelManifest;
  identity: { template: TemplateRef; model: ModelRef; modelIdentity: ModelIdentity; groups: GroupDigest[] };
  lifecycle: string;
  reviewScope: string[];
  relation: Relation | null;
  recordedRelation: AuthoringRecord['relation'] | null;
  execution: { source: string; kernelId?: string; kernelVersion?: string; mode: string; kernelSourceDigest: string | null; kernelSources: SourceDigest[] };
  suite: { file: { path: string; digest: string } | null; declared: { suiteId: string; digest: string } | null; binding: string; data: ReferenceSuite | null; results: ReferenceRun | null; unavailable: string | null };
  mutation: MutationRun | null;
  boundaries: BoundaryRun | null;
  check: CheckRun | null;
  captures: StageCapture[];
  capture: { width: number; theme: string; fonts: string; index: number | null };
  activitySpecificTests: string[];
  verificationTargets: Record<string, boolean>;
}

const cell = (value: unknown): string => String(value ?? '—').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim() || '—';
const code = (value: unknown): string => `\`${String(value).replace(/`/g, "'")}\``;
const table = (head: string[], rows: unknown[][]): string[] => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map(row => `| ${row.map(cell).join(' | ')} |`)];
const tolerance = (tol: Tolerance): string => tol.absolute === 0 && tol.relative === 0 ? 'exact' : `abs ${tol.absolute}, rel ${tol.relative}`;
const params = (values: Record<string, number>): string => Object.entries(values).map(([key, value]) => `${key} = ${Object.is(value, -0) ? '-0' : value}`).join(', ');
const position = (value: unknown): string => {
  const item = value as { kind?: string; index?: number; time?: number } | null;
  return !item || item.kind === 'static' ? 'static' : item.kind === 'index' ? `n = ${item.index}` : item.kind === 'time' ? `t = ${item.time}` : '—';
};

/** README.md text. */
export function packetMarkdown(input: PacketInput): string {
  const { template, manifest, identity } = input;
  const lines: string[] = [];
  const push = (...items: string[]) => lines.push(...items);
  const spatial = template.dimension === '3d';
  const solution = new Set(template.groups.filter(group => group.solutionBearing).map(group => group.id));
  push(`# Subject-review packet: ${template.title}`, '');
  push(
    `> Prepared automatically by ${code('explorable-models activity review-packet')} (toolkit ${input.toolkitVersion}) for a human subject reviewer.`,
    '> It is engineering evidence, **not** a subject review, an accessibility certification or evidence of learning benefit.',
    `> Catalogue status of this exact version: **${input.lifecycle}**${input.reviewScope.length ? ` (host-trusted review scope: ${input.reviewScope.join('; ')})` : ' — no independent human review is recorded'}.`,
    '> The reviewer sign-off at the end is empty; an engineering agent cannot sign it.', '');

  push('## Exact identity', '', ...table(['Item', 'Value'], [
    ['Template', `${identity.template.templateId}@${identity.template.version}`],
    ['Template digest', code(identity.template.digest)],
    ['Model', `${identity.model.modelId}@${identity.model.version}`],
    ['Model digest', code(identity.model.digest)],
    ['Scientific revision', code(identity.modelIdentity.scientificRevision)],
    ['Presentation revision', code(identity.modelIdentity.presentationRevision)],
    ['Reference suite bound by the model', input.suite.declared ? `${input.suite.declared.suiteId} ${code(input.suite.declared.digest)}` : 'none'],
    ['Reference fixture file', input.suite.file ? `${code(input.suite.file.path)} ${code(input.suite.file.digest)}` : (input.suite.unavailable ?? 'none')],
    ['Fixture binding', input.suite.binding],
    ['Execution', input.execution.source === 'document' ? `bounded schema 2.0 document (${input.execution.mode})` : `${input.execution.source === 'authored-kernel' ? 'authored' : 'installed'} kernel ${input.execution.kernelId}@${input.execution.kernelVersion} (${input.execution.mode})`],
    ...(input.execution.kernelSourceDigest ? [['Authored kernel sources', `${input.execution.kernelSources.map(item => `${code(item.path)} ${code(item.digest)}`).join('; ')}`]] : []),
    ['Lifecycle', input.lifecycle],
    ...(input.relation ? [['Relation to the installed catalogue', input.relation.kind === 'new-composition' ? `new exploratory composition${input.relation.derivedFrom ? ` derived from ${input.relation.derivedFrom.templateId}@${input.relation.derivedFrom.version} ${code(input.relation.derivedFrom.digest)}` : ''}` : `${input.relation.kind} of ${input.relation.of.templateId}@${input.relation.of.version}`]] : []),
    ['Generated with', `toolkit ${input.toolkitVersion}, ${input.browser}`],
  ]), '');

  push('## Purpose and task intent', '', template.purpose, '');
  push(...table(['Stage', 'Kind', 'Instruction', 'Host-owned response request', 'Visible groups (* = solution-bearing)', 'Controls'], template.stages.map(stage => [
    stage.id, stage.kind, stage.instruction, stage.response ? `${stage.response.kind}: ${stage.response.prompt} (task family ${stage.response.taskFamily})` : '—',
    Object.entries(stage.visible).map(([group, mode]) => `${group}${solution.has(group) ? '*' : ''} (${mode})`).join(', ') || 'none',
    Object.entries(stage.controls).map(([parameter, mode]) => `${parameter} (${mode})`).join(', ') || 'none',
  ])), '');
  push('Transitions: ' + template.transitions.map(transition => `${transition.from} → ${transition.to} (“${transition.label}”)`).join('; ') + `. Initial stage: ${template.initialStage}.`, '');
  push('Host-owned task families (the visualizer never collects, stores or grades responses):', '', ...table(['Task family', 'Description'], template.taskFamilies.map(family => [family.id, family.description])), '');

  push('## Derivation', '');
  for (const source of [...manifest.sources].sort((a, b) => (a.kind === 'derivation' ? 0 : 1) - (b.kind === 'derivation' ? 0 : 1))) push(`- **${source.id}** (${source.kind}): ${source.citation}`);
  for (const entry of template.content.filter(item => item.kind === 'derivation')) push(`- Template derivation note **${entry.id}**: ${entry.text}`);
  push('');
  push('## Assumptions', '', ...manifest.interpretation.assumptions.map(item => `- ${item}`), '');
  push('## Limitations', '', ...manifest.interpretation.limitations.map(item => `- ${item}`), '');

  push('## Units and conventions', '', `- Coordinates: ${manifest.interpretation.coordinateConvention}`);
  if (manifest.interpretation.angleConvention) push(`- Angles: ${manifest.interpretation.angleConvention}`);
  if (manifest.interpretation.handedness) push(`- Handedness: ${manifest.interpretation.handedness}-handed`);
  push('', 'Parameters (canonical units; the authoring step is a UI increment unless admissibility says otherwise):', '',
    ...table(['Parameter', 'Label', 'Unit', 'Domain', 'Default', 'Admissible values'], Object.entries(manifest.parameters).map(([id, p]) => [id, p.label, p.unit, `[${p.min}, ${p.max}]`, p.default, typeof p.step.admissible === 'string' ? p.step.admissible : `multiples of ${p.step.admissible.multipleOf}`])), '');
  push('Quantities:', '', ...table(['Quantity', 'Label', 'Shape', 'Unit', 'Meaning', 'Sign convention', 'Frame'], Object.entries(manifest.quantities).map(([id, q]) => [
    id, q.label, q.shape.kind === 'vector' ? `vector(${q.shape.length})` : q.shape.kind === 'matrix' ? `matrix(${q.shape.rows}×${q.shape.columns})` : q.shape.kind === 'category' ? `category: ${q.shape.values.join(', ')}` : 'scalar',
    q.unit, q.meaning, q.signConvention ?? '—', q.coordinateFrame ?? '—',
  ])), '');
  if (manifest.constraints.length) push('Coupled constraints (enforced at every entry point):', '', ...table(['Constraint', 'Expression', 'Bounds', 'Message'], manifest.constraints.map(c => [
    c.id, code(c.expression), `${c.min !== undefined ? `${c.min} ${c.minInclusive === false ? '<' : '≤'} ` : ''}value${c.max !== undefined ? ` ${c.maxInclusive === false ? '<' : '≤'} ${c.max}` : ''}`, c.message,
  ])), '');

  push('## Reference cases', '');
  const suite = input.suite.data, results = input.suite.results;
  if (!suite || !results) push(`No reference run: ${input.suite.unavailable ?? 'no reference fixtures are available'}.`, '');
  else {
    const failed = results.cases.filter(item => !item.passed);
    push(`Suite ${code(suite.suiteId)} for ${suite.model.modelId}@${suite.model.version}: **${results.cases.length - failed.length} of ${results.cases.length} cases agree** with frames evaluated in a browser module worker (${results.cases.reduce((sum, item) => sum + item.points, 0)} evaluation points; rejection cases must be refused before evaluation).`, '');
    push(`- Author of the cases: ${suite.author}`, `- Review statement of the fixture: ${suite.review}`, `- Semantics: ${suite.semantics}`);
    if (suite.derivedFrom) push(`- Converted from ${code(suite.derivedFrom.path)} ${code(suite.derivedFrom.digest)} (suite ${suite.derivedFrom.suiteId}): ${suite.derivedFrom.conversion}`);
    for (const note of suite.notCovered) push(`- Not compared by this runner: ${note}`);
    if (results.uncovered.length) push(`- Quantities without any expectation in this suite: ${results.uncovered.map(code).join(', ')}.`);
    push('', ...table(['Case', 'Label', 'Provenance', 'Tolerance', 'Result'], results.cases.map(item => [
      item.id, item.label, item.provenance, `${tolerance(item.tolerance)}${item.tolerances ? `; ${Object.entries(item.tolerances).map(([q, t]) => `${q}: ${tolerance(t)}`).join('; ')}` : ''}`,
      item.passed ? (item.kind === 'rejection' ? 'pass (rejected as expected)' : `pass (${item.points} point${item.points === 1 ? '' : 's'})`) : `FAIL: ${item.problems.join('; ')}`,
    ])), '');
  }

  push('## Mutation sensitivity', '');
  if (!input.mutation) push('Not run (no reference suite).', '');
  else if (input.mutation.baselineProblems.length) push(`Not meaningful: the unmutated model already disagrees with the suite (${input.mutation.baselineProblems.join('; ')}).`, '');
  else {
    const byOperator = new Map<string, { total: number; killed: number; survivors: string[] }>();
    for (const mutant of input.mutation.mutants) {
      const entry = byOperator.get(mutant.operator) ?? { total: 0, killed: 0, survivors: [] };
      entry.total++; if (mutant.killed) entry.killed++; else entry.survivors.push(mutant.target + (mutant.other ? `/${mutant.other}` : ''));
      byOperator.set(mutant.operator, entry);
    }
    const killed = input.mutation.mutants.filter(mutant => mutant.killed).length;
    push(`Generic faults injected into the evaluated model inside the checks worker (outputs or inputs altered after the kernel, one fault at a time); a mutant is detected when at least one reference case disagrees. **${killed} of ${input.mutation.mutants.length} detected.**`, '');
    push(...table(['Fault', 'Mutants', 'Detected', 'Undetected targets'], [...byOperator.entries()].map(([operator, entry]) => [operator, entry.total, entry.killed, entry.survivors.join(', ') || '—'])), '');
    if (input.activitySpecificTests.length) push(`Activity-specific mutants (for example wrong conventions, transposed inputs and incorrect boundaries) are exercised in the mutation-sensitivity tests of ${input.activitySpecificTests.map(code).join(', ')}; hidden-output leakage across output channels is tested in ${code('tests/activity/disclosure.test.ts')}. Those results are not restated here.`, '');
  }

  push('## Boundary cases', '');
  if (!input.boundaries) push('Not run.', '');
  else push('Declared cases come from the package (or the installed suite\'s non-valid expectations); generated probes test the declared domain edges. Outcomes: valid / undefined / numerical-limit / out-of-domain (rejected before evaluation) / worker-error.', '',
    ...table(['Case', 'Source', 'Parameters', 'Position', 'Outcome', 'Non-valid statuses', 'Expectation'], input.boundaries.cases.map(item => [
      `${item.id}: ${item.label}`, item.source, params(item.params), position(item.position), item.outcome,
      Object.entries(item.statuses).map(([q, s]) => `${q}: ${s}`).join(', ') || (item.rejection ? item.rejection.map(r => `${r.code} at ${r.path}`).join(', ') : '—'),
      item.expected ? (item.matches ? 'met' : `NOT MET: ${item.mismatches.join('; ')}`) : '—',
    ])), '');

  push('## Default evaluation and author checks', '');
  if (!input.check) push('Not run.', '');
  else {
    if (input.check.loadError) push(`The worker failed to load: ${input.check.loadError.code} ${input.check.loadError.message}`, '');
    if (input.check.defaults) push(`Defaults ${params(input.check.defaults.params)} (position: ${position(input.check.defaults.position)}): ${Object.entries(input.check.defaults.quantities).map(([q, s]) => `${q} ${s}`).join(', ')}.`, '');
    const sampled = Object.entries(input.check.defaults?.geometry ?? {}).flatMap(([id, item]) => [
      ...(item.sampling ? ['samples' in item.sampling ? `${id}: ${item.sampling.samples} samples over [${item.sampling.domain.join(', ')}]` : `${id}: ${item.sampling.nx} × ${item.sampling.ny} grid over [${item.sampling.domain.join(', ')}]`] : []),
      ...(item.observed ? [`${id}: observed dataset ${item.observed.dataset}, ${item.observed.rows} rows, ${item.observed.missing} with a missing value (drawn unconnected, never interpolated)`] : []),
    ]);
    if (sampled.length) push(`Sampling of the default frame (drawings between samples do not certify values between them): ${sampled.join('; ')}.`, '');
    if (input.check.scenarios.length) push(...table(['Scenario', 'Outcome', 'Non-valid statuses'], input.check.scenarios.map(item => [item.id, item.outcome, Object.entries(item.statuses ?? {}).filter(([, s]) => s !== 'valid').map(([q, s]) => `${q}: ${s}`).join(', ') || '—'])), '');
    if (input.check.checks.length) push('Author checks (the author\'s own assertions, run in the checks worker; not independent evidence):', '', ...table(['Check', 'Description', 'Result'], input.check.checks.map(item => [item.id, item.description, item.passed ? 'pass' : `FAIL: ${item.detail ?? ''}`])), '');
    else push('No author checks are part of this packet.', '');
    for (const item of input.check.diagnostics) push(`- ${item.code} (${item.path}): ${item.message}`);
    if (input.check.diagnostics.length) push('');
  }

  push('## Stage-by-stage captures', '');
  push(`Each stage was prepared through the activity adapter with the browser integration fixture host under an author-preview policy whose ceiling is every group, the stage's solution-bearing groups were authorized by the host through the persist-before-reveal path, and the learner surface was mounted with the learner binding (width ${input.capture.width} CSS px, theme ${input.capture.theme}, fonts ${input.capture.fonts}${input.capture.index !== null ? `, navigated to n = ${input.capture.index} where the stage allows navigation` : ''}). A real host policy may show less. PNG: screenshot of the mounted card; SVG: the surface's own pure-SVG capture of the primary view; text: projection-only companion.`, '');
  if (spatial) push('> 3D views are shown through the surface\'s 2D projection fallback and coordinate table: the capture page does not load a spatial renderer (the 3D renderer is developed separately). The 2D projection, the coordinate table and the authored 2D views carry the same values; once the capture page can load the 3D renderer, the same command regenerates this packet with 3D views.', '');
  for (const stage of input.captures) {
    push(`### ${stage.stageId} (${stage.kind})`, '', `Instruction: ${stage.instruction}`, '');
    if (stage.response) push(`Host-owned ${stage.response.kind} request: ${stage.response.prompt} (task family ${stage.response.taskFamily})`, '');
    if (!stage.ok) { push(`Capture failed: ${stage.diagnostics.map(item => `${item.code} ${item.message}`).join('; ')}`, ''); continue; }
    push(`Revealed by the host for this stage: ${stage.revealed.length ? stage.revealed.join(', ') : 'nothing (no solution-bearing groups)'}${stage.revealError ? ' — the reveal was refused; the capture shows the unrevealed state' : ''}. Review notice shown: “${stage.reviewNotice ?? ''}”. Projection ${code(stage.projectionDigest)}, frame ${code(stage.frameId ?? 'none')}${stage.navigatedTo !== null ? `, n = ${stage.navigatedTo}` : ''}.`, '');
    if (stage.png) push(`![${template.title}, stage ${stage.stageId}](${stage.png})`, '');
    push(`Files: ${[stage.png && `[PNG](${stage.png})`, stage.svg && `[SVG of ${stage.svgView}](${stage.svg})`, stage.companion && `[companion text](${stage.companion})`].filter(Boolean).join(' · ')}${stage.svgError ? ` · no SVG (${stage.svgError.code}: ${stage.svgError.message})` : ''}`, '');
    if (stage.math && stage.math.equations) push(`Equations: ${stage.math.equations - stage.math.plainText} of ${stage.math.equations} rendered with KaTeX${stage.math.plainText ? `, ${stage.math.plainText} shown as plain text` : ''}.`, '');
    const notable = stage.diagnostics.filter(item => item.code !== 'MATH_FALLBACK');
    if (notable.length) push(`Surface diagnostics: ${notable.map(item => `${item.code} ${item.message}`).join('; ')}`, '');
  }

  push('## Content groups', '', 'Content digests bind exposure records to this exact content; any change to a group\'s text or definitions changes its digest.', '',
    ...table(['Group', 'Kind', 'Solution-bearing', 'Members', 'Content digest'], template.groups.map(group => [
      group.id, group.kind, group.solutionBearing ? 'yes' : 'no', group.members.join(', '), code(identity.groups.find(item => item.groupId === group.id)?.contentDigest ?? '—'),
    ])), '');

  push('## Accessible alternatives', '', 'The verification ID names the test or manual check that exercised each claimed equivalence. This packet does not re-run those checks; it records whether the named file exists in this toolkit tree.', '',
    ...table(['Alternative', 'Kind', 'Covers', 'Equivalence', 'Verification ID', 'Named file present'], template.alternatives.map(alternative => [
      `${alternative.id}: ${alternative.label}`, alternative.kind, alternative.covers.join(', '), alternative.equivalence, alternative.verifiedBy,
      input.verificationTargets[alternative.verifiedBy] === undefined ? 'not a file reference' : input.verificationTargets[alternative.verifiedBy] ? 'yes' : 'no',
    ])), '');
  if (input.recordedRelation?.derivedFrom) push('These verification IDs were inherited from the installed template and have not exercised this copy.', '');

  push('## Reviewer sign-off', '',
    'This section is intentionally empty. An engineering agent cannot sign it. A completed review is entered by the host as a',
    `${code('study-harness.review-record')} in its trusted review registry, bound to the exact scientific revision, template digest and`,
    'reference-suite digest listed under “Exact identity”; a review of any other digest does not apply to this version.', '',
    '- Reviewer name and role:', '- Affiliation:', '- Date:', '- Scope reviewed:', '- Limitations:', '- Outcome (approved / approved-with-limitations / rejected):', '');

  push('## Regenerate', '', '```sh', input.regenerate, '```', '');
  return `${lines.join('\n')}\n`;
}

/** packet.json: the same facts as data (no images). */
export function packetData(input: PacketInput): Record<string, unknown> {
  return {
    contract: PACKET_CONTRACT, version: '1.0', kind: input.kind, generator: { tool: 'explorable-models activity review-packet', toolkitVersion: input.toolkitVersion, browser: input.browser, regenerate: input.regenerate },
    status: { lifecycle: input.lifecycle, reviewScope: input.reviewScope, subjectReview: 'none-recorded', signOff: null, statement: 'Engineering evidence prepared by a tool; not a subject review. An engineering agent cannot sign this packet.' },
    identity: { template: input.identity.template, model: input.identity.model, modelIdentity: input.identity.modelIdentity, groups: input.identity.groups },
    relation: input.relation, recordedRelation: input.recordedRelation, execution: input.execution,
    taskIntent: { purpose: input.template.purpose, stages: input.template.stages.map(stage => ({ id: stage.id, kind: stage.kind, instruction: stage.instruction, response: stage.response ?? null })), taskFamilies: input.template.taskFamilies },
    derivation: input.manifest.sources, assumptions: input.manifest.interpretation.assumptions, limitations: input.manifest.interpretation.limitations,
    conventions: { coordinate: input.manifest.interpretation.coordinateConvention, angle: input.manifest.interpretation.angleConvention ?? null, handedness: input.manifest.interpretation.handedness ?? null, parameters: input.manifest.parameters, quantities: input.manifest.quantities, constraints: input.manifest.constraints },
    referenceSuite: {
      declared: input.suite.declared, file: input.suite.file, binding: input.suite.binding, unavailable: input.suite.unavailable,
      suite: input.suite.data ? { suiteId: input.suite.data.suiteId, author: input.suite.data.author, review: input.suite.data.review, derivedFrom: input.suite.data.derivedFrom, notCovered: input.suite.data.notCovered } : null,
      results: input.suite.results,
    },
    mutation: input.mutation, activitySpecificTests: input.activitySpecificTests, boundaries: input.boundaries, check: input.check,
    captures: { settings: input.capture, spatial: input.template.dimension === '3d' ? '2d-projection-fallback' : 'not-applicable', stages: input.captures },
    alternatives: input.template.alternatives.map(alternative => ({ id: alternative.id, kind: alternative.kind, covers: alternative.covers, equivalence: alternative.equivalence, verifiedBy: alternative.verifiedBy, namedFilePresent: input.verificationTargets[alternative.verifiedBy] ?? null })),
  };
}
